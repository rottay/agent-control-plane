import { CONTROL_PLANE_EVENT_TYPES, CommitPolicy, LIFECYCLE_STATES } from "@acp/contracts";
import type { ControlPlaneEventType, LifecycleState, TaskState } from "@acp/contracts";

import { LifecyclePlanError } from "../../errors/index.js";

/**
 * One step table, one plan per commit policy.
 *
 * Both drivers walk a plan from this module and neither encodes a transition of
 * its own, because two copies of a state machine drift and the drift is only
 * ever discovered when the two disagree about a recovery. That law is why the
 * read-only plan below is **derived** from the writer plan rather than written
 * out a second time: the shared steps are the same frozen objects, so they
 * cannot come to disagree.
 *
 * Which plan a run walks is chosen at the driver boundary, from the packet's
 * `commitPolicy`, and never from a module-global constant.
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

/**
 * The read-only plan, for a `NO_COMMIT` packet.
 *
 * Derived, never duplicated: steps 0-7 are the writer plan's own frozen objects
 * (`READ_ONLY_PLAN[i] === LIFECYCLE_PLAN[i]`, asserted by the test), and the
 * closing step takes its `transitionId`, `eventType` and `toState` from the
 * writer plan's own checkpoint step. Only the `fromState` differs, because this
 * plan closes from `AUDITING` instead of from `COMMITTED`.
 *
 * A packet that may not commit therefore never passes through `READY_TO_COMMIT`
 * or `COMMITTED`, and no `COMMIT_*` event can appear in its trail: there is no
 * step that could produce one.
 */
export const READ_ONLY_PLAN: readonly PlanStep[] = Object.freeze([
  ...LIFECYCLE_PLAN.slice(0, 8),
  {
    index: 8,
    transitionId: requireStep(10).transitionId,
    fromState: "AUDITING",
    toState: requireStep(10).toState,
    eventType: requireStep(10).eventType,
    beat: "PLAIN",
  },
]);

/**
 * The plan a packet of this commit policy walks.
 *
 * There is no default, and the absence is enforced rather than promised. The
 * argument is admitted by the contract's own `CommitPolicy` enum, so an absent
 * value, a null, an unknown string, or a near-miss like `"no_commit"` **throws**
 * instead of resolving to a plan.
 *
 * The direction of that failure is the point. A comparison of the form
 * `policy === "NO_COMMIT" ? READ_ONLY_PLAN : LIFECYCLE_PLAN` is total: every
 * value that is not exactly `"NO_COMMIT"` -- including every value that means
 * nothing at all -- selects the *commit-capable* plan. A caller that lost its
 * policy, or spelled it in the wrong case, would silently be handed commit
 * capability, at the one seam in this package where commit capability is
 * decided. Failing loudly is the only honest answer, and the caller is a driver
 * being constructed, so the throw happens at construction rather than mid-plan.
 */
export function planFor(commitPolicy: CommitPolicy): readonly PlanStep[] {
  const parsed = CommitPolicy.safeParse(commitPolicy);
  if (!parsed.success) {
    throw new LifecyclePlanError(
      "a plan cannot be selected without an explicit commit policy from the" +
        " contract's own vocabulary; no plan is chosen by default",
    );
  }
  return parsed.data === "NO_COMMIT" ? READ_ONLY_PLAN : LIFECYCLE_PLAN;
}

/** The terminal state every plan drives to. */
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
