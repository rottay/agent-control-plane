import { CONTROL_PLANE_EVENT_TYPES, LIFECYCLE_STATES } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import { LifecyclePlanError } from "../errors.js";
import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  PLAN_TERMINAL_STATE,
  planStep,
  validatePlan,
} from "./lifecycle.js";

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
