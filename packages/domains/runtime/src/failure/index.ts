import { CONTRACT_VERSION, ControlPlaneEvent, TERMINAL_STATES } from "@acp/contracts";
import type { ControlPlaneEvent as ParsedControlPlaneEvent, TaskState } from "@acp/contracts";

import { deriveEventCoordinate } from "../core/coordinates/index.js";
import { operationForStep } from "../core/events/index.js";
import { INTENT_STEP, OUTCOME_STEP } from "../core/lifecycle/index.js";
import { appendPlanStep, currentState } from "../core/step-executor/index.js";
import type { BeatContext } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";

/**
 * Failure, as a ledger settlement (V2-B7T).
 *
 * The hole this closes: `SqliteSupervisor.runToCheckpoint` exhausted its bound,
 * threw, and appended **nothing** — so a walk that could not converge left an
 * open task with no terminal event, and the roadmap criterion "cada packet
 * tiene checkpoint o receipt terminal" had a real gap. A reader could not tell
 * an abandoned task from a slow one, because the log said the same thing about
 * both: nothing.
 *
 * This module is `cancellation/index.ts`'s sibling and is deliberately built to
 * the same shape rather than to a second one. Both answer the same question —
 * what may the LOG be made to say when a walk stops without reaching its
 * terminal — and two shapes would drift on exactly the case that matters.
 *
 * **Why the failure is not a `PlanStep`.** `PlanStep.toState` is a
 * `LifecycleState`, the ten happy-path states, and `FAILED` is an
 * `ExceptionalState`. So `buildEvent` cannot express it and widening `PlanStep`
 * would break the plan module's own law. The precedent followed instead is
 * `switch-executor` and `cancellation`: build a `ControlPlaneEvent` directly
 * from `deriveEventCoordinate` while walking the full `TaskState` union.
 * Nothing new is introduced — `FAILED` is already an `EXCEPTIONAL_STATE` and
 * already in `TERMINAL_STATES`, and `TASK_FAILED` is already in
 * `CONTROL_PLANE_EVENT_TYPES` and already mapped to the `lifecycle` channel.
 * This is a lateral move to an existing terminal, exactly as `TASK_CANCELLED`
 * is.
 *
 * **What this module does not do.** It performs no effect and repairs nothing.
 * It reads the ledger, probes, and appends. A settlement that completed the
 * work the failure abandoned would be deciding that the walk should have
 * succeeded, which is not a conclusion a settlement is entitled to reach.
 *
 * **`UNKNOWN` settles nothing, ever.** If the intent is open and the probe
 * cannot say whether the effect happened, this appends nothing and says so.
 * Claiming a task ended while an effect may have happened and gone unrecorded
 * is the one claim ADR 0004 §3 exists to prevent, and this plane has already
 * shipped that defect once.
 */

/**
 * The transition id every failure settlement appends under.
 *
 * One literal, so the failure of one attempt has one address: a second
 * `settleFailure` for the same `(taskId, attempt)` rebuilds the same
 * idempotency key and the same bytes, and the ledger returns the existing row
 * rather than appending a second failure. It sits outside the plan's own ids
 * because the plan has no step that could produce it, and beside
 * `CANCELLATION_TRANSITION_ID` for the same reason.
 */
export const FAILURE_TRANSITION_ID = "failed";

/**
 * Why the walk stopped, as a closed word rather than a message.
 *
 * One member today, and exactly one, because one drill earns it: the
 * supervisor's bounded convergence guard. A reason is added when a caller with
 * its own drill needs it — never in advance, and never as free text. The
 * payload therefore carries a classified code and can never carry provider
 * output, a transcript or an exception string from a lower layer.
 */
export const FAILURE_REASONS = ["BOUND_EXHAUSTED"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * What the settlement concluded. Closed and sorted, like every other verdict
 * vocabulary in this plane, and spelled to match `CANCELLATION_VERDICTS` where
 * the two mean the same thing — one name, one meaning.
 */
export const FAILURE_VERDICTS = ["FAILED", "POSTCONDITION_UNKNOWN", "TASK_TERMINAL"] as const;
export type FailureVerdict = (typeof FAILURE_VERDICTS)[number];

/** What the probe established about the open intent, when there was one. */
export type FailureEffect = "DONE" | "NOT_DONE" | "NONE";

export interface FailureSettlement {
  readonly verdict: FailureVerdict;
  /** The state the ledger held when the settlement concluded. */
  readonly state: TaskState;
  readonly effect: FailureEffect | null;
  /** Did the settlement close an open intent before appending? */
  readonly closedIntent: boolean;
  /** The appended event, or null when nothing was appended. */
  readonly failed: ParsedControlPlaneEvent | null;
}

export interface FailurePrecheck {
  readonly proceed: boolean;
  readonly state: TaskState;
}

/**
 * Is there a task here at all, and has it already ended?
 *
 * Refusing on a null state rather than appending is the same law
 * `recordTokenObservation` keeps: a settlement that could append for a task the
 * ledger has never seen would open a task by ending it.
 */
export function failurePrecheck(context: BeatContext): FailurePrecheck {
  const state = currentState(context);
  if (state === null) {
    throw new SupervisorError(
      "refusing to settle a failure: the ledger has no state for this task, so" +
        " there is nothing to fail; appending would open a task rather than end one",
    );
  }
  return { proceed: !isTerminal(state), state };
}

function isTerminal(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Settle what the log says about a walk that could not finish.
 *
 * The verdict discipline is the recovery law's, unchanged:
 *
 * - `DONE` — the effect happened. The open intent is CLOSED first, so the
 *   OUTCOME that records the effect precedes the failure, and the failure is
 *   then appended from the state that leaves. Recording an effect that already
 *   happened is not repairing one that did not.
 * - `NOT_DONE` — no effect happened. Nothing to close; one failure event.
 * - `UNKNOWN` — **append nothing** and refuse. The intent stays open for an
 *   operator, exactly as `PostconditionUnknownError` already leaves it.
 *
 * **The state is re-read immediately before the append.** The close above moves
 * it, and only the ledger knows where to; a remembered value would be the
 * caller's memory of a state the log has since left, which is the shape
 * `assertClaimedState` refuses.
 */
export async function settleFailure(
  context: BeatContext,
  reason: FailureReason,
): Promise<FailureSettlement> {
  const precheck = failurePrecheck(context);
  if (!precheck.proceed) {
    // Already terminal. A walk that reached its terminal and then exhausted a
    // bound is not a failure, and a second terminal would be a contradiction
    // the log would carry forever.
    return {
      verdict: "TASK_TERMINAL",
      state: precheck.state,
      effect: null,
      closedIntent: false,
      failed: null,
    };
  }

  let effect: FailureEffect = "NONE";
  let closedIntent = false;

  if (intentIsOpen(context)) {
    const verdict = await context.effects.probe(operationForStep(context.invocation, INTENT_STEP));
    if (verdict === "UNKNOWN") {
      return {
        verdict: "POSTCONDITION_UNKNOWN",
        state: precheck.state,
        effect: null,
        closedIntent: false,
        failed: null,
      };
    }
    effect = verdict;
    if (verdict === "DONE") {
      // The same OUTCOME the walk itself would have appended, built from the
      // plan and threaded to the INTENT that is durably present. Reached
      // without the repair `closeIntent`'s NOT_DONE branch performs.
      appendPlanStep(context, OUTCOME_STEP);
      closedIntent = true;
    }
  }

  const from = currentState(context);
  if (from === null) {
    throw new SupervisorError(
      "refusing to settle a failure: the task's state disappeared between the" +
        " probe and the append; the ledger is the authority and it no longer names one",
    );
  }

  const result = context.ledger.append(failureEvent(context, from, reason));
  return {
    verdict: "FAILED",
    state: from,
    effect,
    closedIntent,
    failed: result.record.event,
  };
}

/**
 * Whether this attempt has an intent nobody closed, from ledger evidence.
 *
 * Asked directly rather than through `nextStep`, which navigates the PLAN and
 * throws for a task sitting in an exceptional state the plan has no step out
 * of. This asks the one question that is total over every state and answerable
 * from the log: is the INTENT there, and is its OUTCOME not?
 *
 * `cancellation/index.ts` holds a private helper of the same shape. It is not
 * shared, and that is deliberate rather than careless: extracting it would edit
 * a module outside this packet's write-set, and a settlement's own reading of
 * the log is small enough to state twice while the two settlements are still
 * young. Naming it here is what makes the later extraction a decision somebody
 * takes rather than a duplication nobody noticed.
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
 * The failure event, parsed through the contract before it is offered.
 *
 * Every value is derived from the durable invocation, so a settlement repeated
 * after a crash rebuilds byte-identical bytes and appends nothing the second
 * time. No clock is read here and none may be: the ledger treats "same key,
 * different bytes" as a conflict, and recovery is exactly when a re-run
 * happens.
 *
 * `causationId` is null, and honestly so. Nothing in this log caused the
 * failure — a bound outside it was exhausted — and deriving a link to whichever
 * step happened to be last would write a causal claim the ledger cannot
 * corroborate.
 *
 * The payload carries a digest and a closed reason and nothing else: no
 * exception message, no engine output, no prompt, no transcript, no path.
 * `submissionDigest` rides on every other event in the stream and pins what was
 * asked for; `reason` is the one fact this settlement established that the
 * envelope does not already carry.
 */
function failureEvent(
  context: BeatContext,
  from: TaskState,
  reason: FailureReason,
): ParsedControlPlaneEvent {
  const { invocation, emittedBy, plan } = context;
  // The plan index is not part of the derivation — `deriveEventCoordinate`
  // voids it — so this names a position after the plan rather than claiming a
  // step inside it.
  const coordinate = deriveEventCoordinate(invocation, FAILURE_TRANSITION_ID, plan.length);

  return ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId: FAILURE_TRANSITION_ID,
    idempotencyKey: coordinate.idempotencyKey,
    type: "TASK_FAILED",
    fromState: from,
    toState: "FAILED",
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: invocation.invocationId,
    causationId: null,
    payload: { submissionDigest: invocation.submissionDigest, reason },
  });
}
