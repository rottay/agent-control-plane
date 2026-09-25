import { describe, expect, it } from "vitest";

import { TASK_GRAPH_DEPENDS_ON_MAX, TASK_GRAPH_NODES_MAX } from "@acp/contracts";

import { TASK_GRAPH_REFUSALS, decideTaskGraph } from "../../src/index.js";
import type { TaskGraphRequest } from "../../src/index.js";
import { taskGraphNodeTransitionId, taskGraphTransitionId } from "../../src/task-graph/index.js";

/**
 * The task graph decision, over values (P-27 cut A, ADR 0115; requirement A3).
 *
 * Pure: every question about the history is a function the test answers, so each
 * refusal is driven by the one input that produces it, and each is red without it.
 * The door and the producer are asserted over a real ledger in `test/ledger`.
 */

const GRAPH = "55555555-5555-4555-8555-555555555555";
const PREVIOUS = "66666666-6666-4666-8666-666666666666";
const VERSION = "11111111-1111-4111-8111-111111111111";
const OTHER_VERSION = "22222222-2222-4222-8222-222222222222";
const INITIATIVE = "33333333-3333-4333-8333-333333333333";
const OTHER_INITIATIVE = "44444444-4444-4444-8444-444444444444";
const task = (index: number): string => "00000000-0000-4000-8000-" + String(index).padStart(12, "0");

type Edge = readonly [number, ("WAIT_SUCCESS" | "ALLOW_FAILURE" | "REQUIRE_TERMINAL")?];

/** Nodes by index, each naming the indexes it depends on. */
function nodes(edges: readonly (readonly (number | Edge)[])[]): Record<string, unknown>[] {
  return edges.map((dependsOn, nodeIndex) => ({
    graphRevisionId: GRAPH,
    taskId: task(nodeIndex),
    taskRevisionNumber: 1,
    nodeIndex,
    dependsOn: dependsOn.map((entry) => {
      const [index, policy] = typeof entry === "number" ? [entry, undefined] : entry;
      return { taskId: task(index), taskRevisionNumber: 1, failPolicy: policy ?? "WAIT_SUCCESS" };
    }),
  }));
}

function request(overrides: Partial<TaskGraphRequest> = {}, list = nodes([[], [0], [0]])): TaskGraphRequest {
  return {
    initiativeId: INITIATIVE,
    header: { graphRevisionId: GRAPH, roadmapVersionId: VERSION, stepId: "B", supersedesGraphRevisionId: null, nodeCount: list.length },
    nodes: list,
    graphRevisionKnown: () => false,
    stepDeclared: (roadmapVersionId, stepId) => roadmapVersionId === VERSION && stepId === "B",
    currentGraphRevisionId: () => null,
    taskRevisionKnown: () => true,
    taskLink: () => ({ initiativeId: INITIATIVE, roadmapVersionId: VERSION, stepId: "B" }),
    ...overrides,
  };
}

function refusal(input: TaskGraphRequest): { readonly reason: string; readonly at: string } | null {
  const outcome = decideTaskGraph(input);
  return outcome.ok ? null : { reason: outcome.reason, at: outcome.at };
}

describe("the task graph decision (P-27 cut A)", () => {
  it("closes its seven words, sorted", () => {
    expect([...TASK_GRAPH_REFUSALS]).toEqual([
      "GRAPH_DECLARATION_INVALID",
      "GRAPH_DEPENDENCY_CYCLE",
      "GRAPH_HEAD_MISMATCH",
      "GRAPH_NODE_COUNT_MISMATCH",
      "GRAPH_STEP_UNKNOWN",
      "GRAPH_TASK_OUT_OF_SCOPE",
      "GRAPH_TASK_UNKNOWN",
    ]);
    expect([...TASK_GRAPH_REFUSALS]).toEqual([...TASK_GRAPH_REFUSALS].sort());
  });

  it("grants a lawful graph, and hands back the parsed header and nodes in order", () => {
    const outcome = decideTaskGraph(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.declaration.nodeCount).toBe(3);
    expect(outcome.nodes.map((node) => node.nodeIndex)).toEqual([0, 1, 2]);
    // A single node with no edge, and a revision that supersedes the current one.
    expect(refusal(request({}, nodes([[]])))).toBeNull();
    const superseding = request({ currentGraphRevisionId: () => PREVIOUS });
    expect(refusal({ ...superseding, header: { ...(superseding.header as object), supersedesGraphRevisionId: PREVIOUS } })).toBeNull();
  });

  it("GRAPH_STEP_UNKNOWN: a step the version does not declare, or a version of another initiative", () => {
    expect(refusal(request({ stepDeclared: () => false }))).toEqual({ reason: "GRAPH_STEP_UNKNOWN", at: "header.stepId" });
  });

  it("GRAPH_HEAD_MISMATCH: the supersedes claim is not the step's current revision, null only when there is none", () => {
    expect(refusal(request({ currentGraphRevisionId: () => PREVIOUS }))).toEqual({
      reason: "GRAPH_HEAD_MISMATCH",
      at: "header.supersedesGraphRevisionId",
    });
    const stale = request();
    expect(refusal({ ...stale, header: { ...(stale.header as object), supersedesGraphRevisionId: PREVIOUS } })).toEqual({
      reason: "GRAPH_HEAD_MISMATCH",
      at: "header.supersedesGraphRevisionId",
    });
  });

  it("GRAPH_NODE_COUNT_MISMATCH: the header counts other than the nodes handed in", () => {
    const counted = request();
    expect(refusal({ ...counted, header: { ...(counted.header as object), nodeCount: 2 } })).toEqual({
      reason: "GRAPH_NODE_COUNT_MISMATCH",
      at: "header.nodeCount",
    });
  });

  it("GRAPH_DECLARATION_INVALID: a header or node the contract refuses, a reused id, a node of another revision, an index out of order, a repeated node, an edge to no node", () => {
    const base = request();
    expect(refusal({ ...base, header: { ...(base.header as object), nodeCount: 0 } })?.at).toBe("header.nodeCount");
    expect(refusal(request({ graphRevisionKnown: (id) => id === GRAPH }))).toEqual({
      reason: "GRAPH_DECLARATION_INVALID",
      at: "header.graphRevisionId",
    });
    const list = nodes([[], [0]]);
    expect(refusal(request({}, [list[0] ?? {}, { ...(list[1] ?? {}), graphRevisionId: PREVIOUS }]))?.at).toBe("nodes[1].graphRevisionId");
    expect(refusal(request({}, [list[0] ?? {}, { ...(list[1] ?? {}), nodeIndex: 0 }]))?.at).toBe("nodes[1].nodeIndex");
    expect(refusal(request({}, [list[0] ?? {}, { ...(list[0] ?? {}), nodeIndex: 1 }]))?.at).toBe("nodes[1].taskId");
    expect(refusal(request({}, nodes([[], [5]])))).toEqual({ reason: "GRAPH_DECLARATION_INVALID", at: "nodes[1].dependsOn[0]" });
    expect(refusal(request({}, [{ ...(list[0] ?? {}), dependsOn: [{ taskId: task(0), taskRevisionNumber: 1, failPolicy: "WAIT_SUCCESS" }] }]))?.at).toBe(
      "nodes[0].dependsOn.0",
    );
    // A failPolicy is required: the door fills in no default.
    expect(refusal(request({}, [list[0] ?? {}, { ...(list[1] ?? {}), dependsOn: [{ taskId: task(0), taskRevisionNumber: 1 }] }]))?.at).toBe(
      "nodes[1].dependsOn.0.failPolicy",
    );
    for (const outcome of [
      refusal({ ...base, header: { ...(base.header as object), nodeCount: 0 } }),
      refusal(request({ graphRevisionKnown: () => true })),
      refusal(request({}, nodes([[], [5]]))),
    ]) {
      expect(outcome?.reason).toBe("GRAPH_DECLARATION_INVALID");
    }
  });

  it("GRAPH_DEPENDENCY_CYCLE: names the nodes on the cycle in edge order, from the lowest nodeIndex, and back", () => {
    const name = (index: number) => task(index) + "@1";
    expect(refusal(request({}, nodes([[1], [0]])))).toEqual({
      reason: "GRAPH_DEPENDENCY_CYCLE",
      at: [name(0), name(1), name(0)].join(" -> "),
    });
    // 0 <- 3 <- 2 <- 1 <- 0 declared out of order: the name starts at node 0 and follows the edges.
    expect(refusal(request({}, nodes([[3], [0], [1], [2]])))?.at).toBe([0, 3, 2, 1, 0].map(name).join(" -> "));
    // Only the cycle's members are named, not the path that reached it.
    expect(refusal(request({}, nodes([[1], [2], [3], [2]])))?.at).toBe([2, 3, 2].map(name).join(" -> "));
    // A long cycle is named up to sixteen members and counted.
    const ring = Array.from({ length: 20 }, (_, index) => [(index + 1) % 20]);
    const long = refusal(request({}, nodes(ring)));
    expect(long?.reason).toBe("GRAPH_DEPENDENCY_CYCLE");
    expect(long?.at.endsWith(" -> ... (20 nodes)")).toBe(true);
    expect(long?.at.split(" -> ")).toHaveLength(17);
    // A diamond is no cycle.
    expect(refusal(request({}, nodes([[], [0], [0], [1, 2]])))).toBeNull();
  });

  it("GRAPH_TASK_UNKNOWN: a task revision the task stream does not record, at the node, asked last", () => {
    expect(refusal(request({ taskRevisionKnown: (taskId) => taskId !== task(2) }))).toEqual({ reason: "GRAPH_TASK_UNKNOWN", at: "nodes[2]" });
    // Structure is judged first: a cycle among unknown tasks is the cycle's word.
    expect(refusal(request({ taskRevisionKnown: () => false }, nodes([[1], [0]])))?.reason).toBe("GRAPH_DEPENDENCY_CYCLE");
  });

  it("GRAPH_TASK_OUT_OF_SCOPE: a task that entered on another step, another version, another initiative, or on none, at the node", () => {
    const linked = (link: { initiativeId: string; roadmapVersionId: string | null; stepId: string | null } | null) =>
      refusal(request({ taskLink: (taskId) => (taskId === task(1) ? link : { initiativeId: INITIATIVE, roadmapVersionId: VERSION, stepId: "B" }) }));
    const outOfScope = { reason: "GRAPH_TASK_OUT_OF_SCOPE", at: "nodes[1]" };
    // Another step of the same version: the V1 shape.
    expect(linked({ initiativeId: INITIATIVE, roadmapVersionId: VERSION, stepId: "A" })).toEqual(outOfScope);
    // The same step id in another version is another step: the pair is the identity.
    expect(linked({ initiativeId: INITIATIVE, roadmapVersionId: OTHER_VERSION, stepId: "B" })).toEqual(outOfScope);
    // Another initiative's task, on a pair spelled the same: the V2 shape.
    expect(linked({ initiativeId: OTHER_INITIATIVE, roadmapVersionId: VERSION, stepId: "B" })).toEqual(outOfScope);
    // A task that entered with no roadmap link, and one with no recorded intake at all.
    expect(linked({ initiativeId: INITIATIVE, roadmapVersionId: null, stepId: null })).toEqual(outOfScope);
    expect(linked(null)).toEqual(outOfScope);
    // The graph's own pair, under its own initiative, is granted.
    expect(linked({ initiativeId: INITIATIVE, roadmapVersionId: VERSION, stepId: "B" })).toBeNull();
    // Absence is judged before scope: an unrecorded revision is its own word.
    expect(refusal(request({ taskRevisionKnown: (taskId) => taskId !== task(2), taskLink: () => null }))).toEqual({
      reason: "GRAPH_TASK_UNKNOWN",
      at: "nodes[2]",
    });
    // And structure before either: a cycle among out-of-scope tasks is the cycle's word.
    expect(refusal(request({ taskLink: () => null }, nodes([[1], [0]])))?.reason).toBe("GRAPH_DEPENDENCY_CYCLE");
  });

  it("admits the bounds and refuses one past them", () => {
    const wide = nodes(Array.from({ length: TASK_GRAPH_NODES_MAX }, () => []));
    expect(refusal(request({}, wide))).toBeNull();
    const fan = nodes([...Array.from({ length: TASK_GRAPH_DEPENDS_ON_MAX }, () => []), Array.from({ length: TASK_GRAPH_DEPENDS_ON_MAX }, (_, index) => index)]);
    expect(refusal(request({}, fan))).toBeNull();
    const over = nodes([...Array.from({ length: TASK_GRAPH_DEPENDS_ON_MAX + 1 }, () => []), Array.from({ length: TASK_GRAPH_DEPENDS_ON_MAX + 1 }, (_, index) => index)]);
    expect(refusal(request({}, over))?.reason).toBe("GRAPH_DECLARATION_INVALID");
  });

  it("GRAPH_TASK_OUT_OF_SCOPE reads the caller's current link, the same word (P-27 cut C, decision 201)", () => {
    // The door and the producer hand `currentTaskStepLink`: the last link row's target,
    // else the intake's pair. A task re-linked from V1's B to V2's B is out of scope on
    // V1's B, and in scope on V2's B; the decision itself reads nothing else.
    const moved = { initiativeId: INITIATIVE, roadmapVersionId: OTHER_VERSION, stepId: "B" };
    expect(refusal(request({ taskLink: () => moved }))).toEqual({ reason: "GRAPH_TASK_OUT_OF_SCOPE", at: "nodes[0]" });
    const onOther = request({
      header: { graphRevisionId: GRAPH, roadmapVersionId: OTHER_VERSION, stepId: "B", supersedesGraphRevisionId: null, nodeCount: 3 },
      stepDeclared: (roadmapVersionId, stepId) => roadmapVersionId === OTHER_VERSION && stepId === "B",
      taskLink: () => moved,
    });
    expect(refusal(onOther)).toBeNull();
    // An adoption is the same answer from a null intake pair: in scope once linked.
    const adopted = { initiativeId: INITIATIVE, roadmapVersionId: VERSION, stepId: "B" };
    expect(refusal(request({ taskLink: () => adopted }))).toBeNull();
  });

  it("derives its transition ids from the producer's revision id, within the grammar's bound", () => {
    expect(taskGraphTransitionId(GRAPH)).toBe("graph." + GRAPH);
    expect(taskGraphNodeTransitionId(GRAPH, TASK_GRAPH_NODES_MAX - 1)).toBe("graph." + GRAPH + ".node.199");
    expect(taskGraphNodeTransitionId(GRAPH, TASK_GRAPH_NODES_MAX - 1).length).toBeLessThanOrEqual(120);
  });
});
