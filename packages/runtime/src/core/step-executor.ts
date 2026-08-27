import type { ControlPlaneEvent, TaskState } from "@acp/contracts";
import { canonicalJsonStringify } from "@acp/ledger";

import type {
  DurableInvocation,
  OperationCoordinate,
  PostconditionVerdict,
} from "../contracts.js";
import { deriveEventCoordinate } from "./coordinates.js";
import { buildEvent, operationForStep } from "./events.js";
import { INTENT_STEP, LIFECYCLE_PLAN, OUTCOME_STEP, planStep } from "./lifecycle.js";
import type { PlanStep } from "./lifecycle.js";
import { LifecyclePlanError, PostconditionUnknownError, SupervisorError } from "../errors.js";

/**
 * The one beat executor. Both drivers walk the plan through this module.
 *
 * P2B put these beats inside `SqliteSupervisor` as private methods, which was
 * fine while there was one driver. It stops being fine the moment a second one
 * arrives: the Restate handler must wrap each beat in its own `ctx.run`, and a
 * private method that fuses "append the intent" with "perform the effect"
 * cannot be journaled as two entries. Implementing the beats a second time
 * inside the Restate driver is the drift ADR 0004 exists to prevent, so the
 * beats moved here instead.
 *
 * Every function is sized to be one journal entry: it does one durable thing,
 * it is idempotent, and it returns the smallest value that describes what
 * happened. Nothing here reads a clock, a random source or the environment, and
 * nothing here knows what a Restate context is.
 */

/** The ledger surface the beats need. Satisfied structurally by `Ledger`. */
export interface LedgerPort {
  append(candidate: unknown): { readonly inserted: boolean; readonly record: { readonly event: ControlPlaneEvent } };
  getTask(taskId: string): { readonly currentState: TaskState; readonly latestAttempt: number; readonly firstSequence: number } | null;
  getEventBySequence(sequence: number): { readonly canonicalJson: string } | null;
  getEventByIdempotencyKey(idempotencyKey: string): { readonly canonicalJson: string } | null;
}

/** The side-effect surface the beats need. */
export interface EffectPort {
  apply(operation: OperationCoordinate): void;
  probe(operation: OperationCoordinate): PostconditionVerdict;
}

export interface BeatContext {
  readonly ledger: LedgerPort;
  readonly effects: EffectPort;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
}

/** What one durable beat did. Small, canonical, and safe to journal. */
export interface BeatResult {
  readonly event: ControlPlaneEvent | null;
  readonly inserted: boolean;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Refuse to continue work that a different invocation began.
 *
 * The lookup starts from the TASK, never from the incoming invocation's
 * idempotency key. Keying on the incoming attempt is itself a hole: a changed
 * attempt builds a different key, finds nothing, and is waved through -- which
 * then performs a second effect and appends its outcome onto another attempt's
 * task.
 */
export function assertInvocationContinuity(context: BeatContext): void {
  const { ledger, invocation, emittedBy } = context;
  const task = ledger.getTask(invocation.taskId);
  if (task === null) return;

  if (invocation.attempt !== task.latestAttempt) {
    throw new SupervisorError(
      "refusing to resume: this task is on attempt " +
        String(task.latestAttempt) +
        " and the invocation claims attempt " +
        String(invocation.attempt) +
        "; a new attempt would perform the effect a second time and record an" +
        " outcome against work another attempt began",
    );
  }

  const recorded = ledger.getEventBySequence(task.firstSequence);
  if (recorded === null) {
    throw new SupervisorError(
      "refusing to resume: the task projection exists but its first event" +
        " could not be read; a projection without the history that produced it" +
        " is corruption, not a starting point",
    );
  }

  const rebuilt = buildEvent({ invocation, step: planStep(0), emittedBy });
  if (recorded.canonicalJson !== canonicalJsonStringify(rebuilt)) {
    throw new SupervisorError(
      "refusing to resume: these coordinates were begun by a different" +
        " invocation, and continuing would finish one request's work under" +
        " another request's identity",
    );
  }
}

/**
 * Check a caller's claimed state against the ledger and return the truth.
 *
 * The claim is never used to select a step. Trusting it let a caller claiming
 * `RUNNING` while the ledger said `RESERVED` reach the outcome beat, perform the
 * effect, and only then fail -- leaving a side effect with no intent recorded.
 */
export function assertClaimedState(context: BeatContext, from: TaskState): TaskState {
  const actual = currentState(context);
  if (actual === null) {
    throw new SupervisorError(
      "refusing to advance: the ledger has no state for this task, so the" +
        " caller's claimed state cannot be true; the first step is not" +
        " addressable through advance",
    );
  }
  if (actual !== from) {
    throw new SupervisorError(
      "refusing to advance: the caller claims state " +
        from +
        " but the ledger reports " +
        actual +
        "; acting on the claim could perform an effect the lifecycle never" +
        " authorised",
    );
  }
  return actual;
}

// ---------------------------------------------------------------------------
// Plan navigation, from ledger evidence only
// ---------------------------------------------------------------------------

export function currentState(context: BeatContext): TaskState | null {
  const task = context.ledger.getTask(context.invocation.taskId);
  return task === null ? null : task.currentState;
}

/**
 * Choose the next step from ledger evidence alone.
 *
 * `RUNNING` is the one ambiguous state, because both the intent and the outcome
 * land there. The tie is broken by asking the ledger whether the outcome event
 * exists, which is evidence rather than memory.
 */
export function nextStep(context: BeatContext, current: TaskState | null): PlanStep {
  if (current === null) return stepFrom(null);

  if (current === "RUNNING") {
    const key = deriveEventCoordinate(
      context.invocation,
      OUTCOME_STEP.transitionId,
      OUTCOME_STEP.index,
    ).idempotencyKey;
    const outcome = context.ledger.getEventByIdempotencyKey(key);
    return outcome === null ? OUTCOME_STEP : stepAfter(OUTCOME_STEP.index);
  }

  return stepFrom(current);
}

function stepFrom(current: TaskState | null): PlanStep {
  const step = LIFECYCLE_PLAN.find((candidate) => candidate.fromState === current);
  if (step === undefined) {
    throw new LifecyclePlanError(
      "no plan step leaves the observed state; the ledger and the plan disagree",
    );
  }
  return step;
}

function stepAfter(index: number): PlanStep {
  const step = LIFECYCLE_PLAN[index + 1];
  if (step === undefined) {
    throw new LifecyclePlanError("the plan has no step after index " + String(index));
  }
  return step;
}

// ---------------------------------------------------------------------------
// The three beats, each one journal entry
// ---------------------------------------------------------------------------

/** Beat: append one plan step. Idempotent; a replay returns `inserted:false`. */
export function appendPlanStep(context: BeatContext, step: PlanStep): BeatResult {
  const event = buildEvent({
    invocation: context.invocation,
    step,
    emittedBy: context.emittedBy,
  });
  const result = context.ledger.append(event);
  return { event: result.inserted ? result.record.event : null, inserted: result.inserted };
}

/** Beat: perform the intent's effect. Idempotent by content. */
export function applyIntentEffect(context: BeatContext, step: PlanStep): void {
  context.effects.apply(operationForStep(context.invocation, step));
}

/**
 * Beat: close an open intent. Probe first, act only if needed, then append.
 *
 * The order is the point. The outcome is appended only after the effect is
 * known to have happened, because an append is a claim and a claim written
 * early cannot be retracted by a log that only grows.
 */
export function closeIntent(context: BeatContext): BeatResult {
  const operation = operationForStep(context.invocation, INTENT_STEP);

  let verdict: PostconditionVerdict = context.effects.probe(operation);
  if (verdict === "NOT_DONE") {
    context.effects.apply(operation);
    verdict = context.effects.probe(operation);
  }

  if (verdict !== "DONE") {
    throw new PostconditionUnknownError(
      operation.operationId,
      "the effect's postcondition could not be established; the intent stays open",
    );
  }

  return appendPlanStep(context, OUTCOME_STEP);
}
