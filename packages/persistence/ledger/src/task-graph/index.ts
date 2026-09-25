import { CONTRACT_VERSION, TaskGraphDeclaration, TaskGraphNodeDeclaration, buildInitiativeIdempotencyKey } from "@acp/contracts";
import type { ControlPlaneEvent } from "@acp/contracts";

import { LedgerIntegrityError } from "../errors/index.js";
import { taskIntakePayloadOf } from "../projection/index.js";

import type {
  TaskGraphDeclarationInput,
  TaskGraphDeclarationOutcome,
  TaskGraphOutcome,
  TaskGraphRequest,
  TaskGraphTaskLink,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`,
 * and are re-exported here unchanged (owner law §7).
 */
export type {
  TaskGraphDeclarationInput,
  TaskGraphDeclarationOutcome,
  TaskGraphRevisionRequest,
  TaskGraphEdgeRequest,
  TaskGraphGranted,
  TaskGraphNodeRequest,
  TaskGraphOutcome,
  TaskGraphRefused,
  TaskGraphRequest,
  TaskGraphTaskLink,
} from "./types/index.js";

/**
 * A step's task graph — P-27 cut A, ADR 0115 (requirement A3).
 *
 * ## The decision
 *
 * `decideTaskGraph` is pure over what it is handed: the batch's payloads, untrusted,
 * and the four questions only its caller can answer about the history. The initiative
 * batch door calls it inside its `BEGIN IMMEDIATE`, over the read model that
 * transaction keeps level with the stream, and refuses what it refuses; that call is
 * the law. `declareTaskGraph` calls it first over its reader, as the fast path. One
 * function, two callers: the roadmap version decision's mould (ADR 0110).
 *
 * A graph is plain: its nodes are task revisions, its edges name both ends as nodes of
 * the same revision, and a cycle is refused **naming its nodes** (A3), by task id and
 * revision, in cycle order from the member of the lowest `nodeIndex`. Identifiers only,
 * never content. The task revisions are the task stream's, asked across streams and
 * never held by a foreign key (datos §8 item 3), and each node's task must have entered
 * on the graph's own step: a node asserts that its task belongs to this step, so the
 * step a task is in stays unambiguous (A3).
 *
 * ## One producer
 *
 * `declareTaskGraph` composes read, decide and append for the gateway's write seam, the
 * roadmap revision's shape: handles, the instant and every identity arrive with the
 * input, and ledger errors are thrown untouched so the caller keeps its mapping of a
 * lost race.
 */

/**
 * The closed refusal vocabulary, sorted. Every refusal names the field that failed, or
 * the nodes on a cycle, never a value.
 */
export const TASK_GRAPH_REFUSALS = [
  "GRAPH_DECLARATION_INVALID",
  "GRAPH_DEPENDENCY_CYCLE",
  "GRAPH_HEAD_MISMATCH",
  "GRAPH_NODE_COUNT_MISMATCH",
  "GRAPH_STEP_UNKNOWN",
  "GRAPH_TASK_OUT_OF_SCOPE",
  "GRAPH_TASK_UNKNOWN",
] as const;

export type TaskGraphRefusal = (typeof TASK_GRAPH_REFUSALS)[number];

/** How many nodes of a cycle a refusal names before it counts the rest. */
const CYCLE_NAMED_MAX = 16;

function refuse(reason: TaskGraphRefusal, at: string): TaskGraphOutcome {
  return Object.freeze({ ok: false as const, reason, at });
}

function issuePath(prefix: string, path: readonly PropertyKey[] | undefined): string {
  return [prefix, ...(path ?? []).map(String)].join(".");
}

/** A node's name in a refusal: its task id and revision number. */
function nodeName(taskId: string, taskRevisionNumber: number): string {
  return taskId + "@" + String(taskRevisionNumber);
}

/**
 * The cycle a graph closes, named, or null when it has none.
 *
 * A depth-first walk in `nodeIndex` order with three colours, following each node to
 * what it depends on; an edge met while its end is still open closes a cycle. The
 * cycle is named from its member of the lowest `nodeIndex`, in the direction of the
 * edges (each named node depends on the next), and returns to that member.
 */
function namedCycle(nodes: readonly TaskGraphNodeDeclaration[]): string | null {
  const indexOf = new Map<string, number>();
  for (const node of nodes) indexOf.set(nodeName(node.taskId, node.taskRevisionNumber), node.nodeIndex);
  const OPEN = 1;
  const DONE = 2;
  const colour = new Map<string, number>();

  const visit = (name: string, path: readonly string[]): readonly string[] | null => {
    const state = colour.get(name);
    if (state === DONE) return null;
    if (state === OPEN) return path.slice(path.indexOf(name));
    colour.set(name, OPEN);
    const node = nodes[indexOf.get(name) ?? -1];
    for (const edge of node?.dependsOn ?? []) {
      const closed = visit(nodeName(edge.taskId, edge.taskRevisionNumber), [...path, name]);
      if (closed !== null) return closed;
    }
    colour.set(name, DONE);
    return null;
  };

  for (const node of nodes) {
    const cycle = visit(nodeName(node.taskId, node.taskRevisionNumber), []);
    if (cycle === null) continue;
    const first = cycle.reduce((lowest, member, position) =>
      (indexOf.get(member) ?? 0) < (indexOf.get(cycle[lowest] ?? "") ?? 0) ? position : lowest,
    0);
    const ordered = [...cycle.slice(first), ...cycle.slice(0, first)];
    const named = ordered.slice(0, CYCLE_NAMED_MAX);
    const rest = ordered.length - named.length;
    return rest > 0
      ? named.join(" -> ") + " -> ... (" + String(ordered.length) + " nodes)"
      : [...named, ordered[0] ?? ""].join(" -> ");
  }
  return null;
}

/**
 * Decide whether one task graph revision may be declared.
 *
 * The order is the design, coarsest first: the header, whether its id is new, the step,
 * the head it claims to supersede, the count; then each node's shape, position and
 * identity; then each edge's end; then the cycle; and last the task stream, asked
 * across streams: whether each task revision is recorded, and then whether each task
 * entered on this graph's step. A task that is absent is refused for its absence,
 * never for its scope.
 *
 * `GRAPH_TASK_OUT_OF_SCOPE` covers three cases under one word: a task that entered
 * under another initiative, a task linked to another `(roadmapVersionId, stepId)`
 * (the pair is the step's identity, so the same step id in another version is
 * another step), and a task with no link at all, whether it entered with none or
 * has no recorded intake.
 */
export function decideTaskGraph(request: TaskGraphRequest): TaskGraphOutcome {
  const header = TaskGraphDeclaration.safeParse(request.header);
  if (!header.success) return refuse("GRAPH_DECLARATION_INVALID", issuePath("header", header.error.issues[0]?.path));
  const declaration = header.data;

  if (request.graphRevisionKnown(declaration.graphRevisionId)) {
    return refuse("GRAPH_DECLARATION_INVALID", "header.graphRevisionId");
  }
  if (!request.stepDeclared(declaration.roadmapVersionId, declaration.stepId)) {
    return refuse("GRAPH_STEP_UNKNOWN", "header.stepId");
  }
  if (request.currentGraphRevisionId(declaration.roadmapVersionId, declaration.stepId) !== declaration.supersedesGraphRevisionId) {
    return refuse("GRAPH_HEAD_MISMATCH", "header.supersedesGraphRevisionId");
  }
  if (request.nodes.length !== declaration.nodeCount) {
    return refuse("GRAPH_NODE_COUNT_MISMATCH", "header.nodeCount");
  }

  const nodes: TaskGraphNodeDeclaration[] = [];
  const names = new Set<string>();
  for (const [index, candidate] of request.nodes.entries()) {
    const at = "nodes[" + String(index) + "]";
    const parsed = TaskGraphNodeDeclaration.safeParse(candidate);
    if (!parsed.success) return refuse("GRAPH_DECLARATION_INVALID", issuePath(at, parsed.error.issues[0]?.path));
    const node = parsed.data;
    if (node.graphRevisionId !== declaration.graphRevisionId) {
      return refuse("GRAPH_DECLARATION_INVALID", at + ".graphRevisionId");
    }
    if (node.nodeIndex !== index) return refuse("GRAPH_DECLARATION_INVALID", at + ".nodeIndex");
    const name = nodeName(node.taskId, node.taskRevisionNumber);
    if (names.has(name)) return refuse("GRAPH_DECLARATION_INVALID", at + ".taskId");
    names.add(name);
    nodes.push(node);
  }

  for (const node of nodes) {
    for (const [position, edge] of node.dependsOn.entries()) {
      if (!names.has(nodeName(edge.taskId, edge.taskRevisionNumber))) {
        return refuse(
          "GRAPH_DECLARATION_INVALID",
          "nodes[" + String(node.nodeIndex) + "].dependsOn[" + String(position) + "]",
        );
      }
    }
  }

  const cycle = namedCycle(nodes);
  if (cycle !== null) return refuse("GRAPH_DEPENDENCY_CYCLE", cycle);

  for (const node of nodes) {
    if (!request.taskRevisionKnown(node.taskId, node.taskRevisionNumber)) {
      return refuse("GRAPH_TASK_UNKNOWN", "nodes[" + String(node.nodeIndex) + "]");
    }
  }
  for (const node of nodes) {
    const link = request.taskLink(node.taskId);
    if (
      link?.initiativeId !== request.initiativeId ||
      link.roadmapVersionId !== declaration.roadmapVersionId ||
      link.stepId !== declaration.stepId
    ) {
      return refuse("GRAPH_TASK_OUT_OF_SCOPE", "nodes[" + String(node.nodeIndex) + "]");
    }
  }

  return Object.freeze({ ok: true as const, declaration, nodes: Object.freeze(nodes) });
}

/**
 * The step a task entered on, read from the event its revision 1 was recorded by:
 * the intake's own reading of that event, or null when the event is not a recorded
 * intake. The door and the producer both call it, over the same bytes.
 */
export function taskGraphLinkOf(event: ControlPlaneEvent): TaskGraphTaskLink | null {
  const intake = taskIntakePayloadOf(event);
  if (intake === null) return null;
  return Object.freeze({ initiativeId: intake.initiativeId, roadmapVersionId: intake.roadmapVersionId, stepId: intake.stepId });
}

/** The transition id of a revision's header, and of each of its nodes. */
export function taskGraphTransitionId(graphRevisionId: string): string {
  return "graph." + graphRevisionId;
}

export function taskGraphNodeTransitionId(graphRevisionId: string, nodeIndex: number): string {
  return taskGraphTransitionId(graphRevisionId) + ".node." + String(nodeIndex);
}

function refuseDeclaration(reason: TaskGraphRefusal, at: string): TaskGraphDeclarationOutcome {
  return Object.freeze({ ok: false as const, reason, at });
}

/** An edge's identity, for comparing a request with what was recorded. */
function edgeKey(taskId: string, taskRevisionNumber: number, dependsOn: string, dependsOnRevision: number, policy: string): string {
  return [taskId, String(taskRevisionNumber), dependsOn, String(dependsOnRevision), policy].join("\u0000");
}

/**
 * Declare one revision of a step's task graph.
 *
 * The order is the design. A revision id already recorded is answered from the rows
 * it wrote: the same step, predecessor, nodes in order and edges are a replay, and
 * anything else is `GRAPH_DECLARATION_INVALID` at the id — the intake's client key
 * rule, on the producer's id. Otherwise decide over the reader, and append the header
 * and its nodes through the batch door, all or none, where the same decision runs again
 * as the law.
 *
 * It opens nothing and reads no clock and no random source: the handles, the instant
 * and every identity arrive with the input. Ledger errors are thrown untouched.
 */
export function declareTaskGraph(input: TaskGraphDeclarationInput): TaskGraphDeclarationOutcome {
  const { reader, writable, initiativeId, roadmapVersionId, stepId, request, recordedAt } = input;

  const initiative = reader.getInitiative(initiativeId);
  if (initiative === null) return refuseDeclaration("GRAPH_STEP_UNKNOWN", "initiativeId");

  const recorded = reader.getTaskGraphRevision(request.graphRevisionId);
  if (recorded !== null) {
    const revisions = reader.listTaskGraphRevisions(recorded.roadmapVersionId, recorded.stepId);
    const predecessor = revisions.find((revision) => revision.supersededBy === recorded.graphRevisionId) ?? null;
    const nodes = reader.listTaskGraphNodes(recorded.graphRevisionId);
    const edges = new Set(
      reader
        .listTaskDependencies(recorded.graphRevisionId)
        .map((edge) =>
          edgeKey(edge.taskId, edge.taskRevisionNumber, edge.dependsOnTaskId, edge.dependsOnTaskRevisionNumber, edge.failPolicy),
        ),
    );
    const asked = request.nodes.flatMap((node) =>
      node.dependsOn.map((edge) =>
        edgeKey(node.taskId, node.taskRevisionNumber, edge.taskId, edge.taskRevisionNumber, edge.failPolicy),
      ),
    );
    const same =
      recorded.roadmapVersionId === roadmapVersionId &&
      recorded.stepId === stepId &&
      (predecessor?.graphRevisionId ?? null) === request.supersedesGraphRevisionId &&
      nodes.length === request.nodes.length &&
      nodes.every((node, index) => {
        const declared = request.nodes[index];
        return declared !== undefined && node.taskId === declared.taskId && node.taskRevisionNumber === declared.taskRevisionNumber;
      }) &&
      asked.length === edges.size &&
      asked.every((key) => edges.has(key));
    if (!same) return refuseDeclaration("GRAPH_DECLARATION_INVALID", "graphRevisionId");
    return Object.freeze({
      ok: true as const,
      revision: recorded,
      nodeCount: nodes.length,
      sequence: recorded.sequence,
      replayed: true,
    });
  }

  if (input.nodeEventIds.length !== request.nodes.length) {
    throw new LedgerIntegrityError(["a task graph declaration was handed one event id per node, and was not"]);
  }

  const header = {
    graphRevisionId: request.graphRevisionId,
    roadmapVersionId,
    stepId,
    supersedesGraphRevisionId: request.supersedesGraphRevisionId,
    nodeCount: request.nodes.length,
  };
  const nodes = request.nodes.map((node, nodeIndex) => ({
    graphRevisionId: request.graphRevisionId,
    taskId: node.taskId,
    taskRevisionNumber: node.taskRevisionNumber,
    nodeIndex,
    dependsOn: node.dependsOn.map((edge) => ({
      taskId: edge.taskId,
      taskRevisionNumber: edge.taskRevisionNumber,
      failPolicy: edge.failPolicy,
    })),
  }));

  const decision = decideTaskGraph({
    initiativeId,
    header,
    nodes,
    graphRevisionKnown: (graphRevisionId) => reader.getTaskGraphRevision(graphRevisionId) !== null,
    stepDeclared: (versionId, id) =>
      reader.listRoadmapVersions(initiativeId).some((version) => version.roadmapVersionId === versionId) &&
      reader.listRoadmapSteps(versionId).some((step) => step.stepId === id),
    currentGraphRevisionId: (versionId, id) =>
      reader.listTaskGraphRevisions(versionId, id).find((revision) => revision.supersededBy === null)?.graphRevisionId ?? null,
    taskRevisionKnown: (taskId, taskRevisionNumber) => reader.getTaskRevision(taskId, taskRevisionNumber) !== null,
    taskLink: (taskId) => {
      const opening = reader.getTaskRevision(taskId, 1);
      const record = opening === null ? null : reader.getEventBySequence(opening.sequence);
      return record === null ? null : taskGraphLinkOf(record.event);
    },
  });
  if (!decision.ok) return refuseDeclaration(decision.reason, decision.at);

  const envelope = (eventId: string, transitionId: string, type: string, payload: unknown): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId,
    initiativeId,
    transitionId,
    idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId, transitionId }),
    type,
    fromStatus: initiative.currentStatus,
    toStatus: initiative.currentStatus,
    emittedBy: request.declaredBy,
    occurredAt: recordedAt,
    recordedAt,
    payload,
  });
  const batch = writable.appendInitiativeBatch([
    envelope(input.headerEventId, taskGraphTransitionId(request.graphRevisionId), "TASK_GRAPH_DECLARED", header),
    ...nodes.map((node) =>
      envelope(
        input.nodeEventIds[node.nodeIndex] ?? "",
        taskGraphNodeTransitionId(request.graphRevisionId, node.nodeIndex),
        "TASK_GRAPH_NODE_DECLARED",
        node,
      ),
    ),
  ]);
  const first = batch.records[0];
  const revision = writable.getTaskGraphRevision(request.graphRevisionId);
  if (first === undefined || revision === null) {
    throw new LedgerIntegrityError(["a task graph's batch answered with no revision"]);
  }
  return Object.freeze({
    ok: true as const,
    revision,
    nodeCount: nodes.length,
    sequence: first.sequence,
    replayed: batch.insertedCount === 0,
  });
}
