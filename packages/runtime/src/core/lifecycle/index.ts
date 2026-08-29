import { CONTROL_PLANE_EVENT_TYPES, LIFECYCLE_STATES } from "@acp/contracts";
import type { ControlPlaneEventType, LifecycleState, TaskState } from "@acp/contracts";

import { LifecyclePlanError } from "../../errors/index.js";

/**
 * The one lifecycle plan.
 *
 * Both drivers walk this. The SQLite supervisor does today; the Restate driver
 * will in P2C. Neither encodes a transition of its own, because two copies of a
 * state machine drift, and the drift is only ever discovered when the two
 * disagree about a recovery.
 *
 * The plan adds no state and no event type: every `toState` comes from the
 * frozen `LIFECYCLE_STATES` and every `eventType` from the frozen
 * `CONTROL_PLANE_EVENT_TYPES`. Where no specific event truthfully describes a
 * transition, the generic `TASK_STATE_CHANGED` is used rather than inventing
 * one.
 */

export interface PlanStep {
  /** Stable position. Part of operation identity, so it must never be reordered. */
  readonly index: number;
  readonly transitionId: string;
  /** null only for the first step: the ledger requires a first event to declare it. */
  readonly fromState: TaskState | null;
  readonly toState: LifecycleState;
  readonly eventType: ControlPlaneEventType;
  /**
   * Whether this step performs a side effect.
   *
   * Exactly one step does. It is the INTENT beat, and it is followed by the
   * OUTCOME step that records the verified result.
   */
  readonly beat: "PLAIN" | "INTENT" | "OUTCOME";
}

/**
 * The full toy lifecycle, in order.
 *
 * `RUNNING` appears as the target of two steps: the INTENT that starts the
 * effect and the OUTCOME that records it. A same-state transition is legal for
 * every event type except `TASK_STATE_CHANGED`, which the contract requires to
 * actually change state, so the outcome is an `ATOMIC_STEP_COMPLETED`.
 */
export const LIFECYCLE_PLAN: readonly PlanStep[] = Object.freeze([
  { index: 0, transitionId: "discovered", fromState: null, toState: "DISCOVERED", eventType: "TASK_DISCOVERED", beat: "PLAIN" },
  { index: 1, transitionId: "classified", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", eventType: "TASK_CLASSIFIED", beat: "PLAIN" },
  { index: 2, transitionId: "ready", fromState: "DT_CLASSIFIED", toState: "READY", eventType: "TASK_READY", beat: "PLAIN" },
  { index: 3, transitionId: "reserved", fromState: "READY", toState: "RESERVED", eventType: "SLOT_RESERVED", beat: "PLAIN" },
  { index: 4, transitionId: "run.started", fromState: "RESERVED", toState: "RUNNING", eventType: "RUN_STARTED", beat: "INTENT" },
  { index: 5, transitionId: "run.outcome", fromState: "RUNNING", toState: "RUNNING", eventType: "ATOMIC_STEP_COMPLETED", beat: "OUTCOME" },
  { index: 6, transitionId: "verified", fromState: "RUNNING", toState: "VERIFYING", eventType: "VERIFICATION_COMPLETED", beat: "PLAIN" },
  { index: 7, transitionId: "audited", fromState: "VERIFYING", toState: "AUDITING", eventType: "AUDIT_COMPLETED", beat: "PLAIN" },
  { index: 8, transitionId: "ready-to-commit", fromState: "AUDITING", toState: "READY_TO_COMMIT", eventType: "TASK_STATE_CHANGED", beat: "PLAIN" },
  { index: 9, transitionId: "committed", fromState: "READY_TO_COMMIT", toState: "COMMITTED", eventType: "COMMIT_RECORDED", beat: "PLAIN" },
  { index: 10, transitionId: "checkpointed", fromState: "COMMITTED", toState: "CHECKPOINTED", eventType: "CHECKPOINT_WRITTEN", beat: "PLAIN" },
] as const);

/** The terminal state the plan drives to. */
export const PLAN_TERMINAL_STATE: LifecycleState = "CHECKPOINTED";

/** The single INTENT step, resolved once so callers cannot disagree about it. */
export const INTENT_STEP: PlanStep = requireStep(4);

/** The single OUTCOME step. */
export const OUTCOME_STEP: PlanStep = requireStep(5);

function requireStep(index: number): PlanStep {
  const step = LIFECYCLE_PLAN[index];
  if (step === undefined) {
    throw new LifecyclePlanError("the lifecycle plan is missing step " + String(index));
  }
  return step;
}

/** Look a step up by its stable index. */
export function planStep(index: number): PlanStep {
  return requireStep(index);
}

/**
 * Validate the plan against the frozen contract vocabulary.
 *
 * Called by the tests rather than at import time: this module must stay free of
 * import-time work, and a plan defect is a build-time bug, not a runtime one.
 */
export function validatePlan(plan: readonly PlanStep[] = LIFECYCLE_PLAN): void {
  const states: readonly string[] = LIFECYCLE_STATES;
  const types: readonly string[] = CONTROL_PLANE_EVENT_TYPES;

  // The idempotency key is taskId/attempt/transitionId, so two steps sharing a
  // transition id would collide on that key and the second would look like a
  // replay of the first. Uniqueness here is what keeps the key a key.
  const transitionIds = plan.map((step) => step.transitionId);
  const duplicated = transitionIds.filter(
    (id, index) => transitionIds.indexOf(id) !== index,
  );
  if (duplicated.length > 0) {
    throw new LifecyclePlanError(
      "plan transition ids must be unique; the idempotency key depends on it",
    );
  }

  for (const [position, step] of plan.entries()) {
    if (step.index !== position) {
      throw new LifecyclePlanError("plan step index must equal its position");
    }
    if (!states.includes(step.toState)) {
      throw new LifecyclePlanError("plan step names a state outside the contract");
    }
    if (!types.includes(step.eventType)) {
      throw new LifecyclePlanError("plan step names an event type outside the contract");
    }
    if (position === 0 && step.fromState !== null) {
      throw new LifecyclePlanError("the first plan step must declare fromState null");
    }
    if (position > 0) {
      const previous = plan[position - 1];
      if (previous === undefined || step.fromState !== previous.toState) {
        throw new LifecyclePlanError("plan steps must be contiguous");
      }
    }
    if (step.eventType === "TASK_STATE_CHANGED" && step.fromState === step.toState) {
      throw new LifecyclePlanError("a state change event must actually change state");
    }
  }
}
