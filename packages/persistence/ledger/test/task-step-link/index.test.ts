import { describe, expect, it } from "vitest";

import { BOUNDED_IDENTIFIER, BoundedIdentifier, TaskStepLinkDeclaration } from "@acp/contracts";
import { TaskIntakeRequest } from "@acp/protocol";

import { TASK_STEP_LINK_REFUSALS, currentTaskStepLink, decideTaskStepLink } from "../../src/index.js";
import type { TaskStepLinkReadModel, TaskStepLinkDecisionRequest } from "../../src/index.js";
import { LOCAL_KEY_PATTERN } from "../../src/projection/index.js";
import { taskStepLinkTransitionId } from "../../src/task-step-link/index.js";

/**
 * The task step link decision and the one read of a task's current step, over values
 * (P-27 cut C, ADR 0116; requirement A3; decisions 200-201).
 *
 * Pure: every question about the history is a function the test answers, so each
 * refusal is driven by the one input that produces it, in the decision's order, and
 * each is red without it. The door, the producer and the fold are asserted over a real
 * ledger in `test/ledger` and `test/projection`.
 */

const INITIATIVE = "33333333-3333-4333-8333-333333333333";
const OTHER_INITIATIVE = "44444444-4444-4444-8444-444444444444";
const TASK = "00000000-0000-4000-8000-000000000001";
const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const V3 = "55555555-5555-4555-8555-555555555555";
const NUMBERS = new Map([
  [V1, 1],
  [V2, 2],
  [V3, 3],
]);
/** Every version declares steps A and B. */
const DECLARED = new Set([V1, V2, V3].flatMap((version) => [version + "/A", version + "/B"]));

function link(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { taskId: TASK, roadmapVersionId: V2, stepId: "A", fromRoadmapVersionId: V1, fromStepId: "A", ...overrides };
}

function row(roadmapVersionId: string, stepId: string, sequence: number, from: readonly [string, string] | null): TaskStepLinkReadModel {
  return {
    taskId: TASK,
    roadmapVersionId,
    stepId,
    initiativeId: INITIATIVE,
    fromRoadmapVersionId: from?.[0] ?? null,
    fromStepId: from?.[1] ?? null,
    sequence,
    linkedAt: "2026-09-25T00:00:00.000Z",
  };
}

/** A task that entered on V1:A and has no link yet; overrides vary one answer. */
function request(overrides: Partial<TaskStepLinkDecisionRequest> = {}, payload: Record<string, unknown> = link()): TaskStepLinkDecisionRequest {
  return {
    initiativeId: INITIATIVE,
    link: payload,
    stepDeclared: (roadmapVersionId, stepId) => DECLARED.has(roadmapVersionId + "/" + stepId),
    versionNumber: (roadmapVersionId) => NUMBERS.get(roadmapVersionId) ?? null,
    taskKnown: () => true,
    taskIntake: () => ({ initiativeId: INITIATIVE, roadmapVersionId: V1, stepId: "A" }),
    taskLinks: () => [],
    ...overrides,
  };
}

function refusal(input: TaskStepLinkDecisionRequest): { readonly reason: string; readonly at: string } | null {
  const outcome = decideTaskStepLink(input);
  return outcome.ok ? null : { reason: outcome.reason, at: outcome.at };
}

describe("the refusal vocabulary (P-27 cut C)", () => {
  it("is six words, closed and sorted", () => {
    expect([...TASK_STEP_LINK_REFUSALS]).toEqual([
      "LINK_DECLARATION_INVALID",
      "LINK_HEAD_MISMATCH",
      "LINK_STEP_UNKNOWN",
      "LINK_TARGET_NOT_LATER",
      "LINK_TASK_OUT_OF_SCOPE",
      "LINK_TASK_UNKNOWN",
    ]);
    expect([...TASK_STEP_LINK_REFUSALS]).toEqual([...TASK_STEP_LINK_REFUSALS].sort());
  });

  it("names a link by its task and target version, 78 characters", () => {
    expect(taskStepLinkTransitionId(TASK, V2)).toBe("link." + TASK + "." + V2);
    expect(taskStepLinkTransitionId(TASK, V2)).toHaveLength(78);
  });
});

describe("the decision, one word per input, in its order (P-27 cut C)", () => {
  it("grants a re-link from the intake's pair to the same step of a later version", () => {
    const outcome = decideTaskStepLink(request());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.link).toEqual(link());
  });

  it("1: LINK_DECLARATION_INVALID at the zod path, for a shape, a half pair and the target equal to from", () => {
    expect(refusal(request({}, link({ taskId: "nope" })))).toEqual({ reason: "LINK_DECLARATION_INVALID", at: "link.taskId" });
    expect(refusal(request({}, link({ fromStepId: null })))).toEqual({ reason: "LINK_DECLARATION_INVALID", at: "link.fromStepId" });
    expect(refusal(request({}, link({ fromRoadmapVersionId: null })))).toEqual({
      reason: "LINK_DECLARATION_INVALID",
      at: "link.fromRoadmapVersionId",
    });
    expect(refusal(request({}, link({ roadmapVersionId: V1 })))).toEqual({ reason: "LINK_DECLARATION_INVALID", at: "link.roadmapVersionId" });
    expect(refusal(request({}, link({ extra: 1 })))).toEqual({ reason: "LINK_DECLARATION_INVALID", at: "link" });
  });

  it("2: LINK_STEP_UNKNOWN when the target is not declared under this initiative", () => {
    expect(refusal(request({}, link({ stepId: "Z" })))).toEqual({ reason: "LINK_STEP_UNKNOWN", at: "link.stepId" });
    expect(refusal(request({ stepDeclared: () => false }))).toEqual({ reason: "LINK_STEP_UNKNOWN", at: "link.stepId" });
  });

  it("3: LINK_TASK_UNKNOWN when no revision 1 is recorded, before any scope question", () => {
    // Existence before scope: the task is also of another initiative, and absence wins.
    expect(
      refusal(
        request({ taskKnown: () => false, taskIntake: () => ({ initiativeId: OTHER_INITIATIVE, roadmapVersionId: null, stepId: null }) }),
      ),
    ).toEqual({ reason: "LINK_TASK_UNKNOWN", at: "link.taskId" });
  });

  it("4: LINK_TASK_OUT_OF_SCOPE for a task with no intake (a legacy task), or one of another initiative", () => {
    expect(refusal(request({ taskIntake: () => null }, link({ fromRoadmapVersionId: null, fromStepId: null })))).toEqual({
      reason: "LINK_TASK_OUT_OF_SCOPE",
      at: "link.taskId",
    });
    expect(refusal(request({ taskIntake: () => ({ initiativeId: OTHER_INITIATIVE, roadmapVersionId: V1, stepId: "A" }) }))).toEqual({
      reason: "LINK_TASK_OUT_OF_SCOPE",
      at: "link.taskId",
    });
  });

  it("5: LINK_HEAD_MISMATCH when from is not the task's current step, naming the half that differs", () => {
    // from null, but the task entered linked.
    expect(refusal(request({}, link({ fromRoadmapVersionId: null, fromStepId: null })))).toEqual({
      reason: "LINK_HEAD_MISMATCH",
      at: "link.fromRoadmapVersionId",
    });
    // Only the step differs.
    expect(refusal(request({}, link({ fromStepId: "B", stepId: "B" })))).toEqual({ reason: "LINK_HEAD_MISMATCH", at: "link.fromStepId" });
    // A stale from after another link moved the head.
    expect(refusal(request({ taskLinks: () => [row(V2, "A", 7, [V1, "A"])] }, link({ roadmapVersionId: V3 })))).toEqual({
      reason: "LINK_HEAD_MISMATCH",
      at: "link.fromRoadmapVersionId",
    });
    // from set on a task that entered with no step and was never adopted.
    expect(refusal(request({ taskIntake: () => ({ initiativeId: INITIATIVE, roadmapVersionId: null, stepId: null }) }))).toEqual({
      reason: "LINK_HEAD_MISMATCH",
      at: "link.fromRoadmapVersionId",
    });
  });

  it("6: LINK_TARGET_NOT_LATER for an earlier or equal version, another step, or a from version the initiative does not hold", () => {
    const fromV2 = { taskLinks: () => [row(V2, "A", 7, [V1, "A"])] };
    expect(refusal(request(fromV2, link({ roadmapVersionId: V1, fromRoadmapVersionId: V2 })))).toEqual({
      reason: "LINK_TARGET_NOT_LATER",
      at: "link.roadmapVersionId",
    });
    // V1:A -> V2:B is a move to another step id: refused by name.
    expect(refusal(request({}, link({ stepId: "B" })))).toEqual({ reason: "LINK_TARGET_NOT_LATER", at: "link.roadmapVersionId" });
    // V1:A -> V1:B, same version, another step.
    expect(refusal(request({}, link({ roadmapVersionId: V1, stepId: "B" })))).toEqual({
      reason: "LINK_TARGET_NOT_LATER",
      at: "link.roadmapVersionId",
    });
    // A from version this initiative's fold does not hold (N8): not a later version.
    expect(refusal(request({ versionNumber: (id) => (id === V1 ? null : (NUMBERS.get(id) ?? null)) }))).toEqual({
      reason: "LINK_TARGET_NOT_LATER",
      at: "link.roadmapVersionId",
    });
  });

  it("each word is red without its one input: the baseline is granted", () => {
    expect(refusal(request())).toBeNull();
  });
});

describe("what is granted (P-27 cut C, ND-5)", () => {
  const unlinked = { taskIntake: () => ({ initiativeId: INITIATIVE, roadmapVersionId: null, stepId: null }) };
  const adoption = (roadmapVersionId: string, stepId: string) =>
    link({ roadmapVersionId, stepId, fromRoadmapVersionId: null, fromStepId: null });

  it("adopts a task that entered with no step onto any declared step, head or not", () => {
    expect(refusal(request(unlinked, adoption(V1, "B")))).toBeNull();
    expect(refusal(request(unlinked, adoption(V3, "A")))).toBeNull();
  });

  it("re-links V1 -> V2, and V1 -> V3 skipping V2", () => {
    expect(refusal(request({}, link({ roadmapVersionId: V2 })))).toBeNull();
    expect(refusal(request({}, link({ roadmapVersionId: V3 })))).toBeNull();
  });

  it("re-links from the last link, not from the intake, once the task has links", () => {
    const moved = { taskLinks: () => [row(V2, "A", 7, [V1, "A"])] };
    expect(refusal(request(moved, link({ roadmapVersionId: V3, fromRoadmapVersionId: V2 })))).toBeNull();
  });

  it("asks nothing of the task's lifecycle state: no input names one", () => {
    expect(Object.keys(request()).sort()).toEqual(
      ["initiativeId", "link", "stepDeclared", "taskIntake", "taskKnown", "taskLinks", "versionNumber"].sort(),
    );
  });
});

describe("the one read of a task's current step (P-27 cut C, decision 201)", () => {
  const intake = { initiativeId: INITIATIVE, roadmapVersionId: V1, stepId: "A" };

  it("is null with no intake and no link, and the intake with no link", () => {
    expect(currentTaskStepLink(null, [])).toBeNull();
    expect(currentTaskStepLink(intake, [])).toEqual(intake);
    const unlinked = { initiativeId: INITIATIVE, roadmapVersionId: null, stepId: null };
    expect(currentTaskStepLink(unlinked, [])).toEqual(unlinked);
  });

  it("is the last link's target over the intake, picked by sequence, never by array position", () => {
    const chain = [row(V3, "A", 12, [V2, "A"]), row(V2, "A", 7, [V1, "A"])];
    expect(currentTaskStepLink(intake, chain)).toEqual({ initiativeId: INITIATIVE, roadmapVersionId: V3, stepId: "A" });
    expect(currentTaskStepLink(intake, [...chain].reverse())).toEqual({ initiativeId: INITIATIVE, roadmapVersionId: V3, stepId: "A" });
    // A link with no intake at all: the link still answers.
    expect(currentTaskStepLink(null, [row(V2, "B", 4, null)])).toEqual({ initiativeId: INITIATIVE, roadmapVersionId: V2, stepId: "B" });
  });
});

/**
 * B1: the three step grammars are not nested. `StepLocalKey` (the intake DTO's, read
 * through `TaskIntakeRequest`) and the ledger's `LOCAL_KEY_PATTERN` admit 128
 * characters and no colon; `BoundedIdentifier`, the declared step's grammar and the
 * link's, admits 120 and a colon. A recorded intake pair copies into `from` by
 * construction -- decision 197 admits an intake step only when its version declares it
 * -- never by grammar.
 */
describe("the step grammars a link meets (P-27 cut C, B1)", () => {
  const stepLocalKey = TaskIntakeRequest.shape.stepId;
  const all = (value: string) => ({
    bounded: BoundedIdentifier.safeParse(value).success,
    local: stepLocalKey.safeParse(value).success,
    ledger: LOCAL_KEY_PATTERN.test(value),
  });

  it("(i) a 120-character id without a colon parses in all three, and in the link", () => {
    const id = "a".repeat(120);
    expect(all(id)).toEqual({ bounded: true, local: true, ledger: true });
    expect(TaskStepLinkDeclaration.safeParse(link({ stepId: id, fromStepId: id })).success).toBe(true);
  });

  it("(ii) a 121-character local key fails BoundedIdentifier: the declared limit, unreachable after decision 197", () => {
    const id = "a".repeat(121);
    expect(all(id)).toEqual({ bounded: false, local: true, ledger: true });
    expect(BOUNDED_IDENTIFIER.test(id)).toBe(false);
    expect(TaskStepLinkDeclaration.safeParse(link({ fromStepId: id })).success).toBe(false);
  });

  it("(iii) a colon id fails StepLocalKey: a step so declared receives no task by intake (a P-27/A residual)", () => {
    const id = "phase:1";
    expect(all(id)).toEqual({ bounded: true, local: false, ledger: false });
    expect(TaskStepLinkDeclaration.safeParse(link({ stepId: id, fromStepId: id })).success).toBe(true);
  });
});
