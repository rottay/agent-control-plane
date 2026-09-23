import { CONTRACT_VERSION, ControlPlaneEvent, TERMINAL_STATES } from "@acp/contracts";
import type { ControlPlaneEvent as ParsedControlPlaneEvent, TaskState } from "@acp/contracts";

import { deriveEventCoordinate, payloadCoordinate } from "../core/coordinates/index.js";
import { operationForStep } from "../core/events/index.js";
import { INTENT_STEP, OUTCOME_STEP } from "../core/lifecycle/index.js";
import { appendPlanStep, assertAttemptOpened, currentState } from "../core/step-executor/index.js";
import type { BeatContext } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";

/**
 * Cancellation, as a ledger settlement (V2-B2-4b).
 *
 * This module is the engine-agnostic half of the cancel verb. Stopping an
 * engine is an edge concern and lives with the driver that knows one; deciding
 * what the LOG may then be made to say is a domain decision, and it is this.
 * The same reason ADR 0005 gives for one core and two drivers applies here: a
 * second driver that learned to cancel would otherwise write this policy a
 * second time, and the two would drift on exactly the case that matters.
 *
 * **Why the cancellation is not a `PlanStep`.** `PlanStep.toState` is a
 * `LifecycleState`, the ten happy-path states, and `CANCELLED` is an
 * `ExceptionalState`. So `buildEvent` cannot express a cancellation, and
 * widening `PlanStep` would break the plan module's own law that every
 * `toState` comes from the frozen `LIFECYCLE_STATES`. The precedent followed
 * instead is `switch-executor`, which builds a `ControlPlaneEvent` directly
 * from `deriveEventCoordinate` while walking the full `TaskState` union.
 *
 * **What this module does not do.** It performs no effect, ever. It reads the
 * ledger, probes, and appends; a cancellation that repaired a missing effect
 * on its way out would be doing the work it was asked to abandon.
 */

/**
 * The transition id every cancellation appends under.
 *
 * One literal, so the cancellation of one attempt has one address: a second
 * `settleCancellation` for the same `(taskId, attempt)` rebuilds the same
 * idempotency key and the same bytes, and the ledger returns the existing row
 * rather than appending a second cancellation. It sits outside the plan's own
 * ids — `discovered`, `run.started`, `checkpointed` and the rest — because the
 * plan has no step that could produce it.
 */
export const CANCELLATION_TRANSITION_ID = "cancelled";

/**
 * What the settlement concluded. Closed and sorted, like every other refusal
 * vocabulary in this plane.
 *
 * The two non-accepting members are spelled exactly as the driver contract's
 * `DriverRefusal` members they map to. That is deliberate: one name, one
 * meaning, so a reader tracing a refusal from a caller back to here does not
 * have to hold two vocabularies in mind at once. The mapping is still written
 * out case by case at the driver rather than cast, because a cast would stop
 * being checked the moment either vocabulary grew.
 */
export const CANCELLATION_VERDICTS = [
  "CANCELLED",
  "POSTCONDITION_UNKNOWN",
  "TASK_TERMINAL",
] as const;
export type CancellationVerdict = (typeof CANCELLATION_VERDICTS)[number];

/**
 * What the settlement found the intent's effect to be, recorded in the event.
 *
 * `NONE` is not a fourth postcondition verdict. It says no intent was open, so
 * no effect was in question — the task had either not reached the effect beat
 * or had already recorded its outcome. Keeping it in this vocabulary rather
 * than borrowing `PostconditionVerdict` is what stops a reader taking it for a
 * probe result nobody took.
 */
export const CANCELLATION_EFFECTS = ["DONE", "NONE", "NOT_DONE"] as const;
export type CancellationEffect = (typeof CANCELLATION_EFFECTS)[number];

/** What act 1 concluded, from the ledger and nothing else. */
export interface CancellationPrecheck {
  /** True when the ledger's state permits a cancellation to be attempted. */
  readonly proceed: boolean;
  /** The state the ledger reports. Never a state the caller claimed. */
  readonly state: TaskState;
}

/** What act 3 did. */
export interface CancellationSettlement {
  readonly verdict: CancellationVerdict;
  /** The state the cancellation was appended from, or observed and refused at. */
  readonly state: TaskState;
  /** What the probe found, or `NONE` when no intent was open. Null when refused. */
  readonly effect: CancellationEffect | null;
  /** Whether an open intent's OUTCOME was appended before the cancellation. */
  readonly closedIntent: boolean;
  /** The appended cancellation, or null when nothing was appended. */
  readonly cancelled: ParsedControlPlaneEvent | null;
}

/**
 * Act 1 — may this task be cancelled at all?
 *
 * Read from the ledger, before any engine call and before any append, and the
 * order is the whole point. A cancellation that stopped an engine and only
 * then discovered the task had already finished would have interfered with a
 * completed run to learn nothing.
 *
 * **The ledger will not catch this for us, which is why it is an explicit
 * act.** `Ledger.append` enforces one lifecycle rule, and it is continuity:
 * `event.fromState` must equal the row's current state. It says nothing about
 * TERMINALITY. A `TASK_CANCELLED` declaring `fromState: "CHECKPOINTED"`
 * matches the row and would be accepted, quietly appending a cancellation
 * after a completed task. `TERMINAL_STATES` is consulted by the projection,
 * which reports and refuses nothing. So the guard is here, and the drill that
 * measures it is measuring this function rather than the ledger's manners.
 *
 * A task the ledger has never seen throws rather than refusing, which is the
 * answer `assertClaimedState` and `executeSwitchPlan` already give to the same
 * question: there is no state to cancel from, and appending with a null
 * `fromState` would OPEN a task in `CANCELLED` — inventing the very task the
 * caller believed it was ending.
 */
export function cancellationPrecheck(context: BeatContext): CancellationPrecheck {
  const state = currentState(context);
  if (state === null) {
    throw new SupervisorError(
      "refusing to cancel: the ledger has no state for this task, so there is" +
        " nothing to cancel; appending would open a task rather than end one",
    );
  }
  return { proceed: !isTerminal(state), state };
}

function isTerminal(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Act 3 — settle what the log says, probe first.
 *
 * Called only after the engine has been stopped, and never before: a
 * settlement written while the invocation is still retrying can be followed in
 * the log by that invocation's next beat, leaving a cancellation with progress
 * after it. Cancelling the engine first makes this the last write.
 *
 * The three verdicts are the recovery law's, unchanged:
 *
 * - `DONE` — the effect happened. The open intent is CLOSED first, so the
 *   OUTCOME that records the effect precedes the cancellation, and then the
 *   cancellation is appended from the state that leaves.
 * - `NOT_DONE` — no effect happened. Nothing to close; one cancellation.
 * - `UNKNOWN` — **append nothing** and refuse. The intent stays open for an
 *   operator, exactly as `PostconditionUnknownError` already leaves it. A
 *   `TASK_CANCELLED` here would claim the task ended while an effect may have
 *   happened and gone unrecorded, which is the one claim ADR 0004 §3 exists to
 *   prevent and which this plane has already shipped once as a defect.
 *
 * **Why this does not call `closeIntent`.** The verdict discipline is
 * `closeIntent`'s and is deliberately the same, but that function's `NOT_DONE`
 * branch PERFORMS the effect and re-probes, because it belongs to a walk that
 * is trying to finish. A cancellation that performed the effect would do the
 * work it was asked to abandon. So the DONE branch appends the OUTCOME step
 * directly — the same event `closeIntent` would have appended, reached without
 * the repair.
 *
 * **Terminality is re-read here and not inherited from act 1.** The engine
 * accepts a cancellation asynchronously, so the walk may complete between the
 * two acts; without the re-read, a race would append a cancellation after a
 * checkpoint — the exact defect act 1 exists to prevent, reached through the
 * window act 1 cannot see into.
 */
export async function settleCancellation(
  context: BeatContext,
): Promise<CancellationSettlement> {
  // Nothing of a V2 coordinate before its opening (N-G-3, ADR 0102): refused
  // before the precheck, the probe or any append.
  if (context.invocation.revision !== undefined) {
    assertAttemptOpened(context.ledger, context.invocation);
  }
  const precheck = cancellationPrecheck(context);
  if (!precheck.proceed) {
    return {
      verdict: "TASK_TERMINAL",
      state: precheck.state,
      effect: null,
      closedIntent: false,
      cancelled: null,
    };
  }

  let effect: CancellationEffect = "NONE";
  let closedIntent = false;

  if (intentIsOpen(context)) {
    const verdict = await context.effects.probe(operationForStep(context.invocation, INTENT_STEP));
    if (verdict === "UNKNOWN") {
      return {
        verdict: "POSTCONDITION_UNKNOWN",
        state: precheck.state,
        effect: null,
        closedIntent: false,
        cancelled: null,
      };
    }
    effect = verdict;
    if (verdict === "DONE") {
      // The same OUTCOME the walk itself would have appended, built from the
      // plan and threaded to the INTENT that is durably present.
      appendPlanStep(context, OUTCOME_STEP);
      closedIntent = true;
    }
  }

  // Re-read: the outcome above moved the state, and only the ledger knows
  // where to. A remembered value would be the caller's memory of a state the
  // log has since left, which is the shape `assertClaimedState` refuses.
  const from = currentState(context);
  if (from === null) {
    throw new SupervisorError(
      "refusing to cancel: the task's state disappeared between the probe and" +
        " the append; the ledger is the authority and it no longer names one",
    );
  }

  const result = context.ledger.append(cancellationEvent(context, from, effect));
  return {
    verdict: "CANCELLED",
    state: from,
    effect,
    closedIntent,
    cancelled: result.record.event,
  };
}

/**
 * Whether this attempt has an intent nobody closed, from ledger evidence.
 *
 * Stated directly rather than through `nextStep`, and the difference matters.
 * `nextStep` navigates the PLAN, so it throws for a task sitting in an
 * exceptional state the plan has no step out of — `WAITING_OWNER`,
 * `QUOTA_BLOCKED`, `AUTH_REQUIRED`, `DRAINING` — which are precisely the
 * states an operator is most likely to be cancelling from. This asks the one
 * question that is total over every state and answerable from the log: is the
 * INTENT there, and is its OUTCOME not?
 */
function intentIsOpen(context: BeatContext): boolean {
  const { ledger, invocation } = context;
  const intent = deriveEventCoordinate(
    invocation,
    INTENT_STEP.transitionId,
    INTENT_STEP.index,
  ).idempotencyKey;
  const outcome = deriveEventCoordinate(
    invocation,
    OUTCOME_STEP.transitionId,
    OUTCOME_STEP.index,
  ).idempotencyKey;
  return (
    ledger.getEventByIdempotencyKey(intent) !== null &&
    ledger.getEventByIdempotencyKey(outcome) === null
  );
}

/**
 * The cancellation event, parsed through the contract before it is offered.
 *
 * Every value is derived from the durable invocation, so a settlement repeated
 * after a crash rebuilds byte-identical bytes and appends nothing the second
 * time. No clock is read here and none may be: the ledger treats "same key,
 * different bytes" as a conflict, and recovery is exactly when a re-run
 * happens.
 *
 * `causationId` is null, and honestly so. Nothing in this log caused the
 * cancellation — a decision outside it did — and deriving a link to whichever
 * step happened to be last would write a causal claim the ledger cannot
 * corroborate, which is the failure the causation guards exist to prevent.
 *
 * The payload carries a digest and a closed verdict and nothing else: no
 * engine output, no invocation id the engine minted, no prompt, no transcript,
 * no path. `submissionDigest` rides on every other event in the stream and
 * pins what was asked for; `effect` is the one fact this settlement
 * established that the envelope does not already carry.
 */
function cancellationEvent(
  context: BeatContext,
  from: TaskState,
  effect: CancellationEffect,
): ParsedControlPlaneEvent {
  const { invocation, emittedBy, plan } = context;
  // The plan index is not part of the derivation — `deriveEventCoordinate`
  // voids it — so this names a position after the plan rather than claiming a
  // step inside it.
  const coordinate = deriveEventCoordinate(invocation, CANCELLATION_TRANSITION_ID, plan.length);

  return ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId: CANCELLATION_TRANSITION_ID,
    idempotencyKey: coordinate.idempotencyKey,
    type: "TASK_CANCELLED",
    fromState: from,
    toState: "CANCELLED",
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: invocation.invocationId,
    causationId: null,
    payload: { submissionDigest: invocation.submissionDigest, effect, ...payloadCoordinate(invocation) },
  });
}
