import { CONTRACT_VERSION, ControlPlaneEvent } from "@acp/contracts";
import type { ControlPlaneEvent as ControlPlaneEventType } from "@acp/contracts";

import type { DurableInvocation, OperationCoordinate } from "../../contracts/index.js";
import { deriveEventCoordinate, deriveOperationCoordinate, operationDigest } from "../coordinates/index.js";
import type { PlanStep } from "../lifecycle/index.js";
import { LifecyclePlanError } from "../../errors/index.js";

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
  /**
   * The initiative this packet belongs to.
   *
   * It rides in the discovery event's payload and nowhere else: the projection
   * reads it from `TASK_DISCOVERED` when present, and every later event in the
   * task inherits the attribution through that fold rather than restating it.
   * It is deliberately not part of the event's identity -- the coordinates are
   * unchanged -- because an attribution is a fact about a task, not a
   * different task.
   */
  readonly initiativeId: string;
  /**
   * The plan this run walks, so the causal predecessor is the plan's own
   * previous step rather than a guess.
   *
   * Passed in rather than read from a module constant, for the same reason
   * `BeatContext` carries it: a run walks the plan its packet's commit policy
   * chose, and a module-global here would thread every event against a plan the
   * run is not walking.
   */
  readonly plan: readonly PlanStep[];
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
  initiativeId: string,
): Record<string, unknown> {
  const base = { submissionDigest: invocation.submissionDigest };

  // The discovery step opens the task, so it is the one place the initiative
  // can be stated. Carrying it on every event would put the same fact in N
  // places and invite them to disagree.
  if (step.eventType === "TASK_DISCOVERED") {
    return { ...base, beat: "PLAIN", planIndex: step.index, initiativeId };
  }

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
  const { invocation, step, emittedBy, initiativeId } = input;

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

  // The causal thread (P8-8E2).
  //
  // `correlationId` is the invocation's own id: every event of one attempt
  // shares it, which is what makes "this run" a thing a reader can select on
  // without reconstructing it from coordinates.
  //
  // `causationId` is the id of the plan's previous step *in this same
  // attempt*, derived rather than remembered. Derivation is what makes the
  // resume law hold for free: after a kill the beat's in-memory "previous" is
  // gone, but `deriveEventCoordinate` is pure over the invocation and the
  // transition id, so a resumed step threads to exactly the event the ledger
  // already durably holds. Step 0 has no predecessor and is honestly null --
  // nothing causes a task's discovery.
  const previousStep = step.index === 0 ? undefined : input.plan[step.index - 1];
  if (step.index > 0 && previousStep === undefined) {
    throw new LifecyclePlanError(
      "the plan has no step before index " + String(step.index) + "; the causal thread cannot be derived",
    );
  }
  const causationId =
    previousStep === undefined
      ? null
      : deriveEventCoordinate(invocation, previousStep.transitionId, previousStep.index).eventId;

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
    correlationId: invocation.invocationId,
    causationId,
    payload: payloadFor(invocation, step, operation, initiativeId),
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
