import { CONTROL_PLANE_EVENT_TYPES, LIFECYCLE_STATES } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import { LifecyclePlanError } from "../../../src/errors/index.js";
import type { PlanStep } from "../../../src/core/lifecycle/index.js";
import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  PLAN_TERMINAL_STATE,
  READ_ONLY_PLAN,
  planFor,
  planStep,
  validatePlan,
} from "../../../src/core/lifecycle/index.js";

describe("the shared lifecycle plan", () => {
  it("validates against the frozen contract vocabulary", () => {
    expect(() => {
      validatePlan();
    }).not.toThrow();
  });

  it("walks the full lifecycle in the order the roadmap froze", () => {
    const visited = LIFECYCLE_PLAN.map((step) => step.toState);
    // RUNNING appears twice: the intent and the outcome that closes it.
    expect(visited).toEqual([
      "DISCOVERED",
      "DT_CLASSIFIED",
      "READY",
      "RESERVED",
      "RUNNING",
      "RUNNING",
      "VERIFYING",
      "AUDITING",
      "READY_TO_COMMIT",
      "COMMITTED",
      "CHECKPOINTED",
    ]);
    expect(PLAN_TERMINAL_STATE).toBe("CHECKPOINTED");
  });

  it("adds no state and no event type to the contract", () => {
    const states: readonly string[] = LIFECYCLE_STATES;
    const types: readonly string[] = CONTROL_PLANE_EVENT_TYPES;
    for (const step of LIFECYCLE_PLAN) {
      expect(states).toContain(step.toState);
      expect(types).toContain(step.eventType);
    }
  });

  it("declares a null origin for the first step and contiguity after it", () => {
    expect(LIFECYCLE_PLAN[0]?.fromState).toBeNull();
    for (let index = 1; index < LIFECYCLE_PLAN.length; index += 1) {
      expect(LIFECYCLE_PLAN[index]?.fromState).toBe(LIFECYCLE_PLAN[index - 1]?.toState);
    }
  });

  it("indexes steps by position, because identity depends on it", () => {
    for (const [position, step] of LIFECYCLE_PLAN.entries()) {
      expect(step.index).toBe(position);
      expect(planStep(position)).toBe(step);
    }
  });

  it("carries exactly one intent and one outcome, adjacent", () => {
    const intents = LIFECYCLE_PLAN.filter((step) => step.beat === "INTENT");
    const outcomes = LIFECYCLE_PLAN.filter((step) => step.beat === "OUTCOME");
    expect(intents).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    expect(OUTCOME_STEP.index).toBe(INTENT_STEP.index + 1);
    expect(INTENT_STEP.toState).toBe("RUNNING");
    expect(OUTCOME_STEP.fromState).toBe("RUNNING");
  });

  it("never uses TASK_STATE_CHANGED for a same-state transition", () => {
    for (const step of LIFECYCLE_PLAN) {
      if (step.eventType === "TASK_STATE_CHANGED") {
        expect(step.fromState).not.toBe(step.toState);
      }
    }
  });

  it("is frozen, so a driver cannot mutate the shared plan", () => {
    expect(Object.isFrozen(LIFECYCLE_PLAN)).toBe(true);
  });

  it("refuses an index outside the plan", () => {
    expect(() => planStep(99)).toThrow(LifecyclePlanError);
  });

  it("refuses a plan with duplicate transition ids", () => {
    // The idempotency key is taskId/attempt/transitionId. Two steps sharing a
    // transition id would collide on it, and the second would be accepted as a
    // replay of the first: a whole step silently skipped.
    const first = LIFECYCLE_PLAN[0];
    const second = LIFECYCLE_PLAN[1];
    if (first === undefined || second === undefined) throw new Error("no plan");
    const duplicated = [first, { ...second, transitionId: first.transitionId }];
    expect(() => {
      validatePlan(duplicated);
    }).toThrow(LifecyclePlanError);
  });

  it("has unique transition ids today", () => {
    const ids = LIFECYCLE_PLAN.map((step) => step.transitionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("one plan per commit policy", () => {
  // N1: the writer path is asserted against its literal, not inferred from the
  // derivation. If someone edits the step table, this is what says so.
  it("pins the writer plan to its frozen literal", () => {
    expect(LIFECYCLE_PLAN.map((step) => [step.index, step.transitionId, step.fromState, step.toState, step.eventType, step.beat])).toEqual([
      [0, "discovered", null, "DISCOVERED", "TASK_DISCOVERED", "PLAIN"],
      [1, "classified", "DISCOVERED", "DT_CLASSIFIED", "TASK_CLASSIFIED", "PLAIN"],
      [2, "ready", "DT_CLASSIFIED", "READY", "TASK_READY", "PLAIN"],
      [3, "reserved", "READY", "RESERVED", "SLOT_RESERVED", "PLAIN"],
      [4, "run.started", "RESERVED", "RUNNING", "RUN_STARTED", "INTENT"],
      [5, "run.outcome", "RUNNING", "RUNNING", "ATOMIC_STEP_COMPLETED", "OUTCOME"],
      [6, "verified", "RUNNING", "VERIFYING", "VERIFICATION_COMPLETED", "PLAIN"],
      [7, "audited", "VERIFYING", "AUDITING", "AUDIT_COMPLETED", "PLAIN"],
      [8, "ready-to-commit", "AUDITING", "READY_TO_COMMIT", "TASK_STATE_CHANGED", "PLAIN"],
      [9, "committed", "READY_TO_COMMIT", "COMMITTED", "COMMIT_RECORDED", "PLAIN"],
      [10, "checkpointed", "COMMITTED", "CHECKPOINTED", "CHECKPOINT_WRITTEN", "PLAIN"],
    ]);
  });

  // C4: derived, not duplicated. Identity, not deep equality: the same frozen
  // objects, so the two plans cannot drift apart step by step.
  it("shares the writer plan's own steps 0-7 by identity", () => {
    for (let index = 0; index <= 7; index += 1) {
      expect(READ_ONLY_PLAN[index]).toBe(LIFECYCLE_PLAN[index]);
    }
    expect(READ_ONLY_PLAN).toHaveLength(9);
  });

  it("closes from AUDITING with the writer plan's own checkpoint step", () => {
    const closing = READ_ONLY_PLAN[8];
    const writerCheckpoint = LIFECYCLE_PLAN[10];
    expect(closing?.fromState).toBe("AUDITING");
    expect(closing?.toState).toBe(writerCheckpoint?.toState);
    expect(closing?.eventType).toBe(writerCheckpoint?.eventType);
    expect(closing?.transitionId).toBe(writerCheckpoint?.transitionId);
    expect(closing?.beat).toBe("PLAIN");
    expect(closing?.toState).toBe(PLAN_TERMINAL_STATE);
  });

  it("validates the read-only plan against the same contract vocabulary", () => {
    expect(() => {
      validatePlan(READ_ONLY_PLAN);
    }).not.toThrow();
    expect(Object.isFrozen(READ_ONLY_PLAN)).toBe(true);
  });

  it("never passes a read-only packet through a commit state", () => {
    const states = READ_ONLY_PLAN.map((step) => step.toState);
    expect(states).not.toContain("READY_TO_COMMIT");
    expect(states).not.toContain("COMMITTED");
    // And no step could produce a commit event, so no trail can contain one.
    for (const step of READ_ONLY_PLAN) {
      expect(step.eventType.startsWith("COMMIT_")).toBe(false);
    }
  });

  it("selects the plan from the commit policy, with no default", () => {
    expect(planFor("LOCAL_COMMIT_WITH_RECEIPT")).toBe(LIFECYCLE_PLAN);
    expect(planFor("NO_COMMIT")).toBe(READ_ONLY_PLAN);
    // The signature is the guard: there is no argumentless call to select the
    // commit-capable plan by omission.
    expect(planFor.length).toBe(1);
  });

  // C1: the absence of a default is enforced, not merely promised. A ternary on
  // "NO_COMMIT" is total -- every other value, including a meaningless one,
  // would have selected the commit-capable plan.
  it("throws rather than selecting a plan for a policy it cannot read", () => {
    for (const [label, value] of [
      ["absent", undefined],
      ["null", null],
      ["unknown string", "SOMETHING_ELSE"],
      // The near-miss matters most: a lowercase spelling is the shape a real
      // config file produces, and it would have been handed commit capability.
      ["near-miss casing", "no_commit"],
      ["empty string", ""],
      ["not a string", 7],
    ] as const) {
      const run = (): readonly PlanStep[] => planFor(value as never);
      expect({ label, threw: (() => {
        try {
          run();
          return false;
        } catch {
          return true;
        }
      })() }).toEqual({ label, threw: true });
      expect(run).toThrow(LifecyclePlanError);
      // And specifically: it did not quietly answer with the writer plan.
      let answered: readonly PlanStep[] | null = null;
      try {
        answered = run();
      } catch {
        answered = null;
      }
      expect(answered).toBeNull();
    }
  });

  it("keeps the intent and outcome steps shared between the plans", () => {
    expect(READ_ONLY_PLAN[INTENT_STEP.index]).toBe(INTENT_STEP);
    expect(READ_ONLY_PLAN[OUTCOME_STEP.index]).toBe(OUTCOME_STEP);
    expect(planStep(INTENT_STEP.index)).toBe(INTENT_STEP);
  });
});
