import { CONTRACT_VERSION, ControlPlaneEvent, TERMINAL_STATES } from "@acp/contracts";
import { LedgerError } from "@acp/ledger";
import type { ControlPlaneEvent as ParsedControlPlaneEvent, TaskState } from "@acp/contracts";

import { deriveEventCoordinate } from "../core/coordinates/index.js";
import { operationForStep } from "../core/events/index.js";
import { INTENT_STEP, OUTCOME_STEP } from "../core/lifecycle/index.js";
import { appendPlanStep, currentState } from "../core/step-executor/index.js";
import type { BeatContext } from "../core/step-executor/index.js";
import {
  LifecyclePlanError,
  PostconditionUnknownError,
  ReconciliationError,
  SupervisorError,
  ToyBoundaryError,
} from "../errors/index.js";
import { ExecutionEffectError } from "../execution-effects/index.js";

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
export const FAILURE_REASONS = ["BOUND_EXHAUSTED", "EXECUTION_FAILED"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * Why a failure was **not** settled. Closed, and never part of a payload.
 *
 * These are decision words, not ledger words: they name what
 * `classifyFailure` concluded so a caller and a drill can say why nothing was
 * appended. Nothing here reaches an event — the payload carries a
 * `FailureReason` and a digest, and only when the decision was to settle.
 */
export const FAILURE_REFUSALS = [
  "BOUNDARY",
  "CONTINUITY",
  "LEDGER",
  "PLAN",
  "POSTCONDITION_UNKNOWN",
  "RECONCILIATION",
  "UNCLASSIFIED",
] as const;
export type FailureRefusal = (typeof FAILURE_REFUSALS)[number];

/**
 * What a caught error entitles the log to say.
 *
 * A discriminated pair rather than a boolean plus a nullable reason: a decision
 * to settle always carries the classified code it will settle under, and a
 * decision not to always carries why. Neither can be spelled without the other.
 */
export type FailureDecision =
  | { readonly settle: true; readonly reason: FailureReason }
  | { readonly settle: false; readonly refusal: FailureRefusal };

/**
 * Classify a caught error into what may be claimed about it (V2-B7R).
 *
 * **One decision module, shared by both drivers**, for the reason ADR 0005
 * gives for one core and two drivers: a second driver that learned to settle
 * would write this policy a second time, and the two copies would drift on
 * exactly the case that matters — the one where settling would be a lie.
 *
 * **The default is refusal.** An error this function does not recognise is
 * `UNCLASSIFIED` and settles nothing. That direction is deliberate: a terminal
 * event is a claim that the task ended, and a claim made from an error nobody
 * classified is a guess. New settling cases are added with the drill that earns
 * them, never by widening a default.
 *
 * The refusals, each for its own reason and none of them incidental:
 *
 * - `PostconditionUnknownError` — **never.** An effect may have happened and
 *   gone unrecorded; a terminal claim over it is the one claim ADR 0004 §3
 *   exists to prevent, and `cancellation/index.ts` already refuses it by name.
 * - `ReconciliationError` — never. It is raised in the prologue, whose whole law
 *   is "fails closed with zero delta". Settling would write the delta the law
 *   forbids.
 * - `SupervisorError` — never. It is raised when the task's identity or
 *   continuity is in question, and a terminal claim on a task whose continuity
 *   is disputed is a claim about the wrong task.
 * - `ToyBoundaryError` — never. It is raised before a ledger is opened, so there
 *   is no task to settle.
 * - `LedgerError` — never. If the ledger is refusing appends, the settlement
 *   append will not land either; settling on a ledger failure is a claim built
 *   on the thing that just failed.
 * - `LifecyclePlanError` — never, and this one is a deferral rather than a
 *   verdict. The plan has no step out of the current state, which on an already
 *   terminal task is the *correct* refusal of a re-walk; settling would be a
 *   second terminal claim. Settling it where it is genuinely a failure needs its
 *   own evidence and is owed to a later packet.
 *
 * And the one that settles: `ExecutionEffectError`. The port classified the
 * failure itself — a refused start, or a stream that ended in `error` — so the
 * work either never ran or ran and failed, and the log is entitled to say so.
 *
 * **The "probe first" row of the design table is not a third disposition.**
 * `settleFailure` already probes an open intent unconditionally and refuses on
 * `UNKNOWN`, so the case where a stream stopped without a terminal
 * (`TRANSPORT_UNAVAILABLE` at `events.terminal`) reaches the probe by that route
 * and needs no branch of its own here. A second mechanism for one row would be
 * a second place for the discipline to drift.
 */
export function classifyFailure(error: unknown): FailureDecision {
  // Order matters only where the hierarchy overlaps: every class below extends
  // `RuntimeError`, so the specific ones are tested before anything broader.
  if (error instanceof PostconditionUnknownError) {
    return { settle: false, refusal: "POSTCONDITION_UNKNOWN" };
  }
  if (error instanceof ReconciliationError) return { settle: false, refusal: "RECONCILIATION" };
  if (error instanceof SupervisorError) return { settle: false, refusal: "CONTINUITY" };
  if (error instanceof ToyBoundaryError) return { settle: false, refusal: "BOUNDARY" };
  if (error instanceof LifecyclePlanError) return { settle: false, refusal: "PLAN" };
  if (error instanceof LedgerError) return { settle: false, refusal: "LEDGER" };
  if (error instanceof ExecutionEffectError) return { settle: true, reason: "EXECUTION_FAILED" };
  return { settle: false, refusal: "UNCLASSIFIED" };
}

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
