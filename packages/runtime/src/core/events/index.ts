import { CONTRACT_VERSION, ControlPlaneEvent } from "@acp/contracts";
import type { ControlPlaneEvent as ControlPlaneEventType } from "@acp/contracts";

import type { DurableInvocation, OperationCoordinate } from "../../contracts/index.js";
import { deriveEventCoordinate, deriveOperationCoordinate, operationDigest } from "../coordinates/index.js";
import type { PlanStep } from "../lifecycle/index.js";

/**
 * Event construction.
 *
 * One function, one shape, no branch that reads anything ambient. Given the
 * same invocation and the same plan step, this produces byte-identical bytes
 * every time it is called, in this process or a restarted one. That property is
 * what makes an exact replay append nothing instead of raising a conflict.
 *
 * Payloads carry coordinates and digests only. No path, no credential, no
 * provider output and no transcript: the ledger contract would reject those,
 * and building them here only to have the contract refuse them would move the
 * failure to a worse place.
 */

export interface BuildEventInput {
  readonly invocation: DurableInvocation;
  readonly step: PlanStep;
  readonly emittedBy: string;
}

/**
 * The payload for one step.
 *
 * `submissionDigest` is carried on every event, and that is load bearing rather
 * than decorative. The idempotency key is `taskId/attempt/transitionId`, which
 * says nothing about WHAT was asked for. Without the digest in the canonical
 * body, resubmitting a different payload under the same coordinates produced
 * byte-identical events and the ledger accepted it as an exact replay: the
 * second request silently inherited the first one's outcome. With the digest
 * bound in, the bytes differ, the ledger raises an idempotency conflict, and
 * the mismatch fails closed.
 *
 * It is bound into the body and NOT into the operation identity on purpose. A
 * changed submission must be refused, not quietly performed a second time
 * against a freshly named effect.
 */
function payloadFor(
  invocation: DurableInvocation,
  step: PlanStep,
  operation: OperationCoordinate,
): Record<string, unknown> {
  const base = { submissionDigest: invocation.submissionDigest };

  if (step.beat === "INTENT") {
    return {
      ...base,
      beat: "INTENT",
      operationId: operation.operationId,
      operationIndex: operation.operationIndex,
    };
  }
  if (step.beat === "OUTCOME") {
    return {
      ...base,
      beat: "OUTCOME",
      operationId: operation.operationId,
      operationIndex: operation.operationIndex,
      contentDigest: operationDigest(operation),
      postcondition: "DONE",
    };
  }
  return { ...base, beat: "PLAIN", planIndex: step.index };
}

/**
 * Build the event for one plan step.
 *
 * Returns a parsed `ControlPlaneEvent`, so a defect in this function is a
 * validation failure here rather than a rejected append later.
 */
export function buildEvent(input: BuildEventInput): ControlPlaneEventType {
  const { invocation, step, emittedBy } = input;

  // The INTENT and OUTCOME beats address the SAME effect, so both derive the
  // operation from the intent step's index. An outcome that addressed its own
  // index would name an operation nothing ever performed.
  const operationStepIndex = step.beat === "OUTCOME" ? step.index - 1 : step.index;
  const operationTransitionId =
    step.beat === "OUTCOME" ? intentTransitionIdFor(step) : step.transitionId;

  const operation = deriveOperationCoordinate(
    invocation,
    operationTransitionId,
    operationStepIndex,
  );
  const coordinate = deriveEventCoordinate(invocation, step.transitionId, step.index);

  return ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId: step.transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: step.eventType,
    fromState: step.fromState,
    toState: step.toState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: null,
    causationId: null,
    payload: payloadFor(invocation, step, operation),
  });
}

/**
 * The transition id of the INTENT step an OUTCOME step closes.
 *
 * Derived from the plan rather than hard-coded, so reordering the plan cannot
 * silently repoint an outcome at the wrong effect.
 */
function intentTransitionIdFor(outcome: PlanStep): string {
  return outcome.transitionId.replace(/\.outcome$/, ".started");
}

/** The operation an effect-bearing step addresses. */
export function operationForStep(
  invocation: DurableInvocation,
  step: PlanStep,
): OperationCoordinate {
  return deriveOperationCoordinate(invocation, step.transitionId, step.index);
}
