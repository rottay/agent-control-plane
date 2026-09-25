import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  API_CONTRACT_VERSION,
  ApiError,
  InitiativeTimelineResponse,
  LEDGER_CONTRACT_VERSION,
  RoadmapVersionWriteResponse,
  TaskGraphDeclarationResponse,
  TaskGraphResponse,
  TaskIntakeResponse,
  initiativeStepGraphPath,
} from "@acp/protocol";
import { canonicalJsonStringify, openLedger, sha256Hex } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { readinessOf } from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";
import { recordTaskGraph } from "../../src/task-graph/index.js";

/**
 * Evidence for the plane's seventh write door: a step's task graph (P-27 cut A, ADR
 * 0115; requirements A3 and A5).
 *
 * Every case goes through the real gateway, a real ledger and the real private plane:
 * the roadmap version declares its steps through the roadmap route, the tasks enter
 * through the intake door, and the graph is declared and read through its own route.
 * The seam decides nothing — `decideTaskGraph` does, twice, and `evaluateReady`
 * judges each node — so what this file holds is the door, the batch it lands, the
 * verdicts production reads (every node UNKNOWN on R1: no task of this build is of
 * the V2 cohort), and the history this build must still open.
 */

const dirs: string[] = [];

const TOKEN = "p27a-test-token-" + "x".repeat(24);
const AUTH = { authorization: "Bearer " + TOKEN };
const COORDINATOR = "kimi/k3/coordinator/01";
const OPERATOR = "claude/opus/implementer/01";
const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const INITIATIVE_2 = "55555555-5555-4555-8555-555555555555";
const MODEL = "claude-opus-5@2026-06-01";
const AT = "2026-09-25T12:00:00.000Z";
const NOW = "2026-09-25T13:00:00.000Z";
const GRAPH_ONE = "77777777-7777-4777-8777-777777777701";
const GRAPH_TWO = "77777777-7777-4777-8777-777777777702";
const OBJECTIVE = "Enter a task a step's graph can name.";

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bearerFile(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-p27a-bearer-")));
  dirs.push(root);
  const path = join(root, "write-bearer.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

function registryDocument(documentKind: string, documentId: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    idempotencyKey: documentId + "/1",
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    contentDigest: sha256Hex(canonicalJsonStringify(payload)),
    recordedBy: COORDINATOR,
    effectiveFrom: AT,
    occurredAt: AT,
    recordedAt: AT,
    payload,
  };
}

/** An initiative, one ACTIVE model version and the implementer's GLOBAL slot 0. */
function seededLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-p27a-graph-"));
  dirs.push(dir);
  const path = join(dir, "control-plane.sqlite");
  const ledger = openLedger(path);
  ledger.appendInitiativeEvent({
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    initiativeId: INITIATIVE,
    transitionId: "initiative.registered",
    idempotencyKey: INITIATIVE + "/1/initiative.registered",
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: COORDINATOR,
    occurredAt: AT,
    recordedAt: AT,
    payload: {},
  });
  ledger.appendRegistryEvent(
    registryDocument("MODEL_VERSION", MODEL, {
      provider: "claude",
      model: "claude-opus-5",
      release: "2026-06-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["implementer"],
      transports: ["CLI_SUBSCRIPTION"],
    }),
  );
  ledger.appendRegistryEvent(
    registryDocument("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", {
      role: "implementer",
      slot: 0,
      provider: "claude",
      modelVersionId: MODEL,
      fallbacks: [],
    }),
  );
  ledger.close();
  return path;
}

function manifestStep(stepId: string, dependsOn: readonly string[] = []): Record<string, unknown> {
  return {
    stepId,
    title: "Step " + stepId,
    objective: "The private objective of " + stepId + ".",
    acceptance: "The private acceptance of " + stepId + ".",
    expectedWriteSet: ["packages/" + stepId + "/index.ts"],
    dependsOn: [...dependsOn],
  };
}

function envelope(taskId: string): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    taskId,
    initiativeId: INITIATIVE,
    title: "A task of the graph",
    objective: OBJECTIVE,
    content: {
      contentContractVersion: 1,
      blocks: [
        {
          kind: "text",
          blockId: "b1",
          mediaType: "text/plain; charset=utf-8",
          byteLength: new TextEncoder().encode(OBJECTIVE).byteLength,
          contentSha256: "0".repeat(64),
          artifactRefId: null,
          text: OBJECTIVE,
          toolCallId: null,
          effectId: null,
        },
      ],
    },
    classification: "MECHANICAL",
    issuedBy: COORDINATOR,
    issuedAt: AT,
    authority: [],
    readSet: [],
    writeSet: ["docs/" + taskId + ".md"],
    conflictKeys: [],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "" },
    validation: { commands: [], independentVerifierRequired: false },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 100 },
    visualEvidenceRequired: false,
    commitPolicy: "NO_COMMIT",
    checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 1 },
  };
}

type App = ReturnType<typeof buildServer>;

interface World {
  readonly path: string;
  readonly bearer: string;
  readonly app: App;
  readonly roadmapVersionId: string;
  readonly contentDigest: string;
  readonly tasks: readonly [string, string, string];
}

/** Enter one task through the intake door, linked to `stepId` of the version. */
async function enter(app: App, roadmapVersionId: string, stepId: string, initiativeId = INITIATIVE): Promise<string> {
  const taskId = randomUUID();
  const intake = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: AUTH,
    payload: {
      envelope: { ...envelope(taskId), initiativeId },
      clientScope: OPERATOR,
      clientRequestKey: "graph-task-" + taskId,
      roadmapVersionId,
      stepId,
      role: "implementer",
      slot: 0,
      transportKind: "CLI_SUBSCRIPTION",
      recordedBy: OPERATOR,
    },
  });
  expect(intake.statusCode).toBe(200);
  TaskIntakeResponse.parse(intake.json());
  return taskId;
}

/** Version 1 declaring A and B (B after A) through the roadmap route, and three tasks entered on step B. */
async function world(): Promise<World> {
  const path = seededLedger();
  const bearer = bearerFile();
  const app = buildServer({ ledgerPath: path, writeBearerPath: bearer, now: () => NOW });
  const roadmap = await app.inject({
    method: "POST",
    url: "/api/v1/initiatives/" + INITIATIVE + "/roadmap",
    headers: AUTH,
    payload: {
      content: "# Roadmap\n",
      expectedHeadDigest: null,
      kind: "EDIT",
      restoresVersionId: null,
      recordedBy: COORDINATOR,
      steps: { manifestContractVersion: 1, steps: [manifestStep("A"), manifestStep("B", ["A"])] },
    },
  });
  expect(roadmap.statusCode).toBe(200);
  const { roadmapVersionId, contentDigest } = RoadmapVersionWriteResponse.parse(roadmap.json()).version;
  const tasks = [
    await enter(app, roadmapVersionId, "B"),
    await enter(app, roadmapVersionId, "B"),
    await enter(app, roadmapVersionId, "B"),
  ] as const;
  return { path, bearer, app, roadmapVersionId, contentDigest, tasks };
}

function graphUrl(stepId = "B", version = 1): string {
  return initiativeStepGraphPath(INITIATIVE) + "?version=" + String(version) + "&stepId=" + stepId;
}

type Policy = "WAIT_SUCCESS" | "ALLOW_FAILURE" | "REQUIRE_TERMINAL";

function graphBody(
  graphRevisionId: string,
  nodes: readonly { readonly taskId: string; readonly dependsOn?: readonly string[]; readonly revision?: number }[],
  supersedes: string | null = null,
  policy: Policy = "WAIT_SUCCESS",
): Record<string, unknown> {
  return {
    graphRevisionId,
    supersedesGraphRevisionId: supersedes,
    declaredBy: COORDINATOR,
    nodes: nodes.map((node) => ({
      taskId: node.taskId,
      taskRevisionNumber: node.revision ?? 1,
      dependsOn: (node.dependsOn ?? []).map((taskId) => ({ taskId, taskRevisionNumber: 1, failPolicy: policy })),
    })),
  };
}

function g1(tasks: World["tasks"]): Record<string, unknown> {
  const [n1, n2, n3] = tasks;
  return graphBody(GRAPH_ONE, [{ taskId: n1 }, { taskId: n2, dependsOn: [n1] }, { taskId: n3, dependsOn: [n1] }]);
}

function initiativeEvents(path: string): readonly { readonly sequence: number; readonly type: string }[] {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return raw.prepare("SELECT sequence, type FROM initiative_events ORDER BY sequence").all() as { sequence: number; type: string }[];
  } finally {
    raw.close();
  }
}

function withReader<T>(path: string, read: (ledger: Ledger) => T): T {
  const ledger = openLedger(path, { readOnly: true });
  try {
    return read(ledger);
  } finally {
    ledger.close();
  }
}

const SAT = { verdict: "SATISFIED", reason: null };
const unknown = (reason: string) => ({ verdict: "UNKNOWN", reason });

describe("G1: a graph is declared on a declared step, all or none, and read with its verdicts", () => {
  it("lands one header and three contiguous nodes, the three tables, and every node reads not READY, R1 UNKNOWN(TASK_COHORT_LEGACY)", async () => {
    const { path, app, tasks } = await world();
    const [n1, n2, n3] = tasks;
    const before = initiativeEvents(path).length;
    const response = await app.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: g1(tasks) });
    expect(response.statusCode).toBe(200);
    const declared = TaskGraphDeclarationResponse.parse(response.json());
    expect(declared).toMatchObject({
      apiContractVersion: API_CONTRACT_VERSION,
      initiativeId: INITIATIVE,
      stepId: "B",
      graphRevisionId: GRAPH_ONE,
      supersedesGraphRevisionId: null,
      nodeCount: 3,
      replayed: false,
    });
    const events = initiativeEvents(path).slice(before);
    expect(events.map((event) => event.type)).toEqual([
      "TASK_GRAPH_DECLARED",
      "TASK_GRAPH_NODE_DECLARED",
      "TASK_GRAPH_NODE_DECLARED",
      "TASK_GRAPH_NODE_DECLARED",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3].map((offset) => declared.sequence + offset));

    const rows = withReader(path, (ledger) => ({
      revisions: ledger.listTaskGraphRevisions(declared.version.roadmapVersionId, "B"),
      nodes: ledger.listTaskGraphNodes(GRAPH_ONE).map((node) => node.taskId),
      edges: ledger.listTaskDependencies(GRAPH_ONE).map((edge) => [edge.taskId, edge.dependsOnTaskId, edge.failPolicy]),
      problems: ledger.verifyIntegrity().problems,
    }));
    expect(rows.revisions.map((revision) => [revision.graphRevisionId, revision.supersededBy, revision.declaredAt])).toEqual([
      [GRAPH_ONE, null, NOW],
    ]);
    expect(rows.nodes).toEqual([n1, n2, n3]);
    expect(rows.edges).toEqual([
      [n2, n1, "WAIT_SUCCESS"],
      [n3, n1, "WAIT_SUCCESS"],
    ]);
    expect(rows.problems).toEqual([]);

    const read = await app.inject({ method: "GET", url: graphUrl() });
    expect(read.statusCode).toBe(200);
    const graph = TaskGraphResponse.parse(read.json());
    expect(graph.evaluatedAt).toBe(NOW);
    expect(graph.graph.graphRevisionId).toBe(GRAPH_ONE);
    expect(graph.nodes.map((node) => node.ready)).toEqual([false, false, false]);
    for (const node of graph.nodes) {
      expect(node.conditions.R1).toEqual(unknown("TASK_COHORT_LEGACY"));
      // Step B is DECLARED and depends on A: its readiness has no producer yet.
      expect(node.conditions.R3).toEqual(unknown("STEP_DEPENDENCIES_UNPRODUCED"));
      // The intake's assignment still resolves; no approval producer exists (P-28).
      expect(node.conditions.R4).toEqual(unknown("APPROVAL_UNPRODUCED"));
    }
    expect(graph.nodes.map((node) => node.conditions.R2)).toEqual([
      SAT,
      unknown("DEPENDENCY_COHORT_LEGACY"),
      unknown("DEPENDENCY_COHORT_LEGACY"),
    ]);
    expect(graph.nodes[1]?.dependsOn).toEqual([{ taskId: n1, taskRevisionNumber: 1, failPolicy: "WAIT_SUCCESS" }]);
    await app.close();
  });

  it("reads R3 satisfied on a step with no dependsOn, the rank-0 rule, and still no node READY", async () => {
    const { app, roadmapVersionId } = await world();
    const onA = await enter(app, roadmapVersionId, "A");
    const declared = await app.inject({
      method: "POST",
      url: graphUrl("A"),
      headers: AUTH,
      payload: graphBody(GRAPH_ONE, [{ taskId: onA }]),
    });
    expect(declared.statusCode).toBe(200);
    const graph = TaskGraphResponse.parse((await app.inject({ method: "GET", url: graphUrl("A") })).json());
    expect(graph.nodes[0]?.conditions).toEqual({
      R1: unknown("TASK_COHORT_LEGACY"),
      R2: SAT,
      R3: SAT,
      R4: unknown("APPROVAL_UNPRODUCED"),
    });
    expect(graph.nodes[0]?.ready).toBe(false);
    await app.close();
  });

  it("the timeline reads the two graph types, widened by derivation", async () => {
    const { app, tasks } = await world();
    await app.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: g1(tasks) });
    const timeline = InitiativeTimelineResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + INITIATIVE + "/events" })).json(),
    );
    const types = timeline.items.map((item) => item.type);
    expect(types.filter((type) => type === "TASK_GRAPH_DECLARED")).toHaveLength(1);
    expect(types.filter((type) => type === "TASK_GRAPH_NODE_DECLARED")).toHaveLength(3);
    await app.close();
  });
});

describe("the door's refusals, by name, append nothing", () => {
  it("G2: a cycle is 409 WRITE_REFUSED naming GRAPH_DEPENDENCY_CYCLE, and its detail names both nodes", async () => {
    const { path, app, tasks } = await world();
    const [n1, n2] = tasks;
    const before = initiativeEvents(path).length;
    const response = await app.inject({
      method: "POST",
      url: graphUrl(),
      headers: AUTH,
      payload: graphBody(GRAPH_ONE, [{ taskId: n1, dependsOn: [n2] }, { taskId: n2, dependsOn: [n1] }]),
    });
    expect(response.statusCode).toBe(409);
    const error = ApiError.parse(response.json()).error;
    expect(error.code).toBe("WRITE_REFUSED");
    expect(error.message).toContain("GRAPH_DEPENDENCY_CYCLE");
    expect(error.detail).toBe([n1, n2, n1].map((id) => id + "@1").join(" -> "));
    expect(initiativeEvents(path)).toHaveLength(before);
    await app.close();
  });

  it("G3: a task or a revision the task stream does not record is GRAPH_TASK_UNKNOWN at the node", async () => {
    const { path, app, tasks } = await world();
    const before = initiativeEvents(path).length;
    for (const [nodes, at] of [
      [[{ taskId: tasks[0] }, { taskId: randomUUID() }], "nodes[1]"],
      [[{ taskId: tasks[0], revision: 2 }], "nodes[0]"],
    ] as const) {
      const response = await app.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: graphBody(GRAPH_ONE, nodes) });
      expect(response.statusCode).toBe(409);
      const error = ApiError.parse(response.json()).error;
      expect(error.message).toContain("GRAPH_TASK_UNKNOWN");
      expect(error.detail).toBe(at);
    }
    expect(initiativeEvents(path)).toHaveLength(before);
    await app.close();
  });

  it("V1: a task entered on step B is not a node of step A's graph, so no task revision is current in two steps' plans", async () => {
    const { path, app, tasks } = await world();
    const before = initiativeEvents(path).length;
    const onA = await app.inject({ method: "POST", url: graphUrl("A"), headers: AUTH, payload: graphBody(GRAPH_ONE, [{ taskId: tasks[0] }]) });
    expect(onA.statusCode).toBe(409);
    const error = ApiError.parse(onA.json()).error;
    expect(error.code).toBe("WRITE_REFUSED");
    expect(error.message).toContain("GRAPH_TASK_OUT_OF_SCOPE");
    expect(error.detail).toBe("nodes[0]");
    expect(initiativeEvents(path)).toHaveLength(before);
    // Its own step admits it, once.
    const onB = await app.inject({ method: "POST", url: graphUrl("B"), headers: AUTH, payload: graphBody(GRAPH_TWO, [{ taskId: tasks[0] }]) });
    expect(onB.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: graphUrl("A") })).statusCode).toBe(404);
    await app.close();
  });

  it("V2: initiative 2's graph refuses initiative 1's tasks, so its verdicts never read another initiative's tasks", async () => {
    const { path, app, tasks } = await world();
    const ledger = openLedger(path);
    ledger.appendInitiativeEvent({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: randomUUID(),
      initiativeId: INITIATIVE_2,
      transitionId: "initiative.registered",
      idempotencyKey: INITIATIVE_2 + "/1/initiative.registered",
      type: "INITIATIVE_REGISTERED",
      fromStatus: null,
      toStatus: "ACTIVE",
      emittedBy: COORDINATOR,
      occurredAt: AT,
      recordedAt: AT,
      payload: {},
    });
    ledger.close();
    const roadmap = await app.inject({
      method: "POST",
      url: "/api/v1/initiatives/" + INITIATIVE_2 + "/roadmap",
      headers: AUTH,
      payload: {
        content: "# Other\n",
        expectedHeadDigest: null,
        kind: "EDIT",
        restoresVersionId: null,
        recordedBy: COORDINATOR,
        steps: { manifestContractVersion: 1, steps: [manifestStep("X")] },
      },
    });
    expect(roadmap.statusCode).toBe(200);
    const url = initiativeStepGraphPath(INITIATIVE_2) + "?version=1&stepId=X";
    const before = initiativeEvents(path).length;
    const declared = await app.inject({
      method: "POST",
      url,
      headers: AUTH,
      payload: graphBody(GRAPH_ONE, [{ taskId: tasks[0] }, { taskId: tasks[1], dependsOn: [tasks[0]] }]),
    });
    expect(declared.statusCode).toBe(409);
    const error = ApiError.parse(declared.json()).error;
    expect(error.message).toContain("GRAPH_TASK_OUT_OF_SCOPE");
    expect(error.detail).toBe("nodes[0]");
    expect(initiativeEvents(path)).toHaveLength(before);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    // Initiative 2's own task, entered on X, is admitted there.
    const version2 = RoadmapVersionWriteResponse.parse(roadmap.json()).version.roadmapVersionId;
    const own = await enter(app, version2, "X", INITIATIVE_2);
    expect((await app.inject({ method: "POST", url, headers: AUTH, payload: graphBody(GRAPH_ONE, [{ taskId: own }]) })).statusCode).toBe(200);
    await app.close();
  });

  it("the pair is the step: a task entered on version 1's B is not a node of version 2's B", async () => {
    const { path, app, tasks, contentDigest } = await world();
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/initiatives/" + INITIATIVE + "/roadmap",
      headers: AUTH,
      payload: {
        content: "# Roadmap\n\nThe second.\n",
        expectedHeadDigest: contentDigest,
        kind: "EDIT",
        restoresVersionId: null,
        recordedBy: COORDINATOR,
        steps: { manifestContractVersion: 1, steps: [manifestStep("A"), manifestStep("B", ["A"])] },
      },
    });
    expect(second.statusCode).toBe(200);
    const before = initiativeEvents(path).length;
    const declared = await app.inject({ method: "POST", url: graphUrl("B", 2), headers: AUTH, payload: g1(tasks) });
    expect(declared.statusCode).toBe(409);
    expect(ApiError.parse(declared.json()).error.message).toContain("GRAPH_TASK_OUT_OF_SCOPE");
    expect(initiativeEvents(path)).toHaveLength(before);
    await app.close();
  });

  it("G4: a redeclaration naming the current revision supersedes it, and a stale claim is GRAPH_HEAD_MISMATCH", async () => {
    const { path, app, tasks } = await world();
    const [n1, n2] = tasks;
    expect((await app.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: g1(tasks) })).statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: graphUrl(),
      headers: AUTH,
      payload: graphBody(GRAPH_TWO, [{ taskId: n1 }, { taskId: n2, dependsOn: [n1] }], GRAPH_ONE, "ALLOW_FAILURE"),
    });
    expect(second.statusCode).toBe(200);
    expect(TaskGraphDeclarationResponse.parse(second.json()).supersedesGraphRevisionId).toBe(GRAPH_ONE);
    const graph = TaskGraphResponse.parse((await app.inject({ method: "GET", url: graphUrl() })).json());
    expect(graph.graph.graphRevisionId).toBe(GRAPH_TWO);
    expect(graph.nodes.map((node) => node.taskId)).toEqual([n1, n2]);
    expect(graph.nodes[1]?.dependsOn[0]?.failPolicy).toBe("ALLOW_FAILURE");
    expect(withReader(path, (ledger) => ledger.getTaskGraphRevision(GRAPH_ONE)?.supersededBy)).toBe(GRAPH_TWO);

    const before = initiativeEvents(path).length;
    for (const supersedes of [null, GRAPH_ONE]) {
      const stale = await app.inject({
        method: "POST",
        url: graphUrl(),
        headers: AUTH,
        payload: graphBody("77777777-7777-4777-8777-777777777703", [{ taskId: n1 }], supersedes),
      });
      expect(stale.statusCode).toBe(409);
      const error = ApiError.parse(stale.json()).error;
      expect(error.message).toContain("GRAPH_HEAD_MISMATCH");
      expect(error.detail).toBe("header.supersedesGraphRevisionId");
    }
    expect(initiativeEvents(path)).toHaveLength(before);
    await app.close();
  });

  it("G5: an exact retry is answered as a replay from the recorded rows, and the same id with another graph is refused", async () => {
    const { path, app, tasks } = await world();
    const first = TaskGraphDeclarationResponse.parse(
      (await app.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: g1(tasks) })).json(),
    );
    const count = initiativeEvents(path).length;
    const again = await app.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: g1(tasks) });
    expect(again.statusCode).toBe(200);
    expect(TaskGraphDeclarationResponse.parse(again.json())).toEqual({ ...first, replayed: true });
    expect(initiativeEvents(path)).toHaveLength(count);
    const other = await app.inject({
      method: "POST",
      url: graphUrl(),
      headers: AUTH,
      payload: graphBody(GRAPH_ONE, [{ taskId: tasks[0] }]),
    });
    expect(other.statusCode).toBe(409);
    expect(ApiError.parse(other.json()).error.message).toContain("GRAPH_DECLARATION_INVALID");
    expect(initiativeEvents(path)).toHaveLength(count);
    await app.close();
  });

  it("G6: a producer that decided over a stale fold loses at the door, and hears WRITE_CONFLICT, never a 500", async () => {
    const { path, app, tasks, roadmapVersionId } = await world();
    await app.close();
    const reader = openLedger(path, { readOnly: true });
    const version = reader.listRoadmapVersions(INITIATIVE)[0];
    if (version === undefined) throw new Error("the world has no version");
    const stale = reader.listTaskGraphRevisions(roadmapVersionId, "B");
    // Another producer declares first.
    const other = openLedger(path);
    const landed = recordTaskGraph({
      ledger: other,
      initiativeId: INITIATIVE,
      version,
      stepId: "B",
      request: g1(tasks) as never,
      recordedAt: AT,
      headerEventId: randomUUID(),
      nodeEventIds: [randomUUID(), randomUUID(), randomUUID()],
    });
    other.close();
    expect(landed.ok).toBe(true);

    const staleReader: Ledger = new Proxy(reader, {
      get(target, property) {
        if (property === "listTaskGraphRevisions") return () => stale;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const before = initiativeEvents(path).length;
    const outcome = recordTaskGraph({
      ledger: staleReader,
      initiativeId: INITIATIVE,
      version,
      stepId: "B",
      request: graphBody(GRAPH_TWO, [{ taskId: tasks[0] }]) as never,
      recordedAt: AT,
      headerEventId: randomUUID(),
      nodeEventIds: [randomUUID()],
    });
    reader.close();
    expect(outcome).toEqual({ ok: false, reason: "WRITE_CONFLICT", at: "taskGraph" });
    expect(initiativeEvents(path)).toHaveLength(before);
  });

  it("G7: an unknown version is 404 on both arms; an unknown step is 404 to read and GRAPH_STEP_UNKNOWN to declare", async () => {
    const { app, tasks } = await world();
    const unknownRead = await app.inject({ method: "GET", url: graphUrl("B", 9) });
    const unknownWrite = await app.inject({ method: "POST", url: graphUrl("B", 9), headers: AUTH, payload: g1(tasks) });
    expect([unknownRead.statusCode, unknownWrite.statusCode]).toEqual([404, 404]);
    const read = await app.inject({ method: "GET", url: graphUrl("Z") });
    expect(read.statusCode).toBe(404);
    const declared = await app.inject({ method: "POST", url: graphUrl("Z"), headers: AUTH, payload: g1(tasks) });
    expect(declared.statusCode).toBe(409);
    expect(ApiError.parse(declared.json()).error.message).toContain("GRAPH_STEP_UNKNOWN");
    // A declared step with no graph yet reads 404, never an empty graph.
    expect((await app.inject({ method: "GET", url: graphUrl() })).statusCode).toBe(404);
    await app.close();
  });
});

describe("the door's surface", () => {
  it("inherits the bearer on POST, reads free on GET, refuses the other verbs, and parses the body at the field", async () => {
    const { app, tasks } = await world();
    const unauthenticated = await app.inject({ method: "POST", url: graphUrl(), payload: g1(tasks) });
    expect(unauthenticated.statusCode).toBe(401);
    expect(ApiError.parse(unauthenticated.json()).error.code).toBe("AUTH_REQUIRED");
    expect((await app.inject({ method: "GET", url: graphUrl() })).statusCode).toBe(404);
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method, url: graphUrl() })).statusCode).toBe(405);
    }
    const body = g1(tasks) as { nodes: { dependsOn: Record<string, unknown>[] }[] };
    delete body.nodes[1]?.dependsOn[0]?.["failPolicy"];
    const malformed = await app.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: body });
    expect(malformed.statusCode).toBe(400);
    expect(ApiError.parse(malformed.json()).error.detail).toBe("nodes.1.dependsOn.0.failPolicy");
    expect((await app.inject({ method: "GET", url: initiativeStepGraphPath(INITIATIVE) + "?version=1" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("production feeds named absences (readinessOf)", () => {
  it("answers the same verdicts with no instant, because no production verdict reads one; a revision not recorded is null", async () => {
    const { path, app, tasks } = await world();
    await app.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: g1(tasks) });
    await app.close();
    withReader(path, (ledger) => {
      const at = readinessOf(ledger, GRAPH_ONE, NOW);
      const without = readinessOf(ledger, GRAPH_ONE, null);
      expect(without?.nodes.map((node) => node.evaluation)).toEqual(at?.nodes.map((node) => node.evaluation));
      expect(at?.nodes.every((node) => !node.evaluation.ready)).toBe(true);
      expect(readinessOf(ledger, GRAPH_TWO, NOW)).toBeNull();
    });
  });

  it("reads an assignment that moved as ASSIGNMENT_UNRESOLVED: the intake's resolution no longer holds", async () => {
    const { path, app, tasks } = await world();
    await app.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: g1(tasks) });
    await app.close();
    const writer = openLedger(path);
    // Version 2 of the same assignment document: another assignment, by identity.
    const payload = { role: "implementer", slot: 0, provider: "claude", modelVersionId: MODEL, fallbacks: [] };
    writer.appendRegistryEvent({
      ...registryDocument("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", payload),
      idempotencyKey: "routing:GLOBAL:implementer:0/2",
      documentVersion: 2,
      parentDocumentVersion: 1,
    });
    writer.close();
    withReader(path, (ledger) => {
      const reading = readinessOf(ledger, GRAPH_ONE, NOW);
      expect(reading?.nodes.map((node) => node.evaluation.conditions.R4)).toEqual([
        { verdict: "UNSATISFIED", reason: "ASSIGNMENT_UNRESOLVED" },
        { verdict: "UNSATISFIED", reason: "ASSIGNMENT_UNRESOLVED" },
        { verdict: "UNSATISFIED", reason: "ASSIGNMENT_UNRESOLVED" },
      ]);
    });
  });
});

describe("P-P18-2: this build opens the history the previous one wrote", () => {
  it("a 2.10.0 history rewound to 25 migrates under 2.10.0 through 26 to 27, verifies and rebuilds identically, and takes G1 on top", async () => {
    const { path, bearer, app, tasks } = await world();
    await app.close();
    const before = withReader(path, (ledger) => ({
      versions: ledger.listRoadmapVersions(INITIATIVE),
      tasks: tasks.map((taskId) => ledger.getTaskRevision(taskId, 1)),
    }));

    // Migrations 27 and 26 undone, 27 first (P-27 cut C): the ledger is at 25, as the
    // build before P-27 cut A left it.
    const raw = new DatabaseSync(path);
    raw.exec(
      "DROP TRIGGER tr_task_step_link_read_model__insert_only;" +
        "DROP INDEX ix_task_step_link_read_model__task_sequence;" +
        "DROP TABLE task_step_link_read_model;" +
        "DELETE FROM projection_watermark WHERE projection_name = 'task_step_link_read_model';" +
        "DROP TRIGGER tr_task_graph_revision_read_model__supersede_once;" +
        "DROP TABLE task_dependency_read_model;" +
        "DROP TABLE task_graph_node_read_model;" +
        "DROP TABLE task_graph_revision_read_model;" +
        "DELETE FROM projection_watermark WHERE projection_name IN " +
        "('task_graph_revision_read_model', 'task_graph_node_read_model', 'task_dependency_read_model');" +
        "DELETE FROM schema_migrations WHERE version >= 26;",
    );
    raw.close();

    // The server's handle is read-only and may not migrate; a writable open does.
    const migrated = openLedger(path);
    // 26 when P-27 cut A wrote this; P-27 cut C's 27 is the tail now.
    expect(migrated.status().migrations.at(-1)?.version).toBe(27);
    expect(migrated.status().migrations.at(-1)?.name).toBe("task_step_link");
    expect(migrated.verifyIntegrity().problems).toEqual([]);
    expect(migrated.listRoadmapVersions(INITIATIVE)).toEqual(before.versions);
    migrated.rebuildReadModel();
    expect(migrated.listRoadmapVersions(INITIATIVE)).toEqual(before.versions);
    expect(tasks.map((taskId) => migrated.getTaskRevision(taskId, 1))).toEqual(before.tasks);
    expect(migrated.verifyIntegrity().problems).toEqual([]);
    migrated.close();

    const reopened = buildServer({ ledgerPath: path, writeBearerPath: bearer, now: () => NOW });
    const onTop = await reopened.inject({ method: "POST", url: graphUrl(), headers: AUTH, payload: g1(tasks) });
    expect(onTop.statusCode).toBe(200);
    const graph = TaskGraphResponse.parse((await reopened.inject({ method: "GET", url: graphUrl() })).json());
    expect(graph.nodes).toHaveLength(3);
    await reopened.close();
    expect(withReader(path, (ledger) => ledger.verifyIntegrity().problems)).toEqual([]);
  });
});
