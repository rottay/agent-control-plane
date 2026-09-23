// `ResolvedRoute` is imported as a value: this module parses through it, and
// the zod schema and the inferred type share the name.
import { CONTRACT_VERSION, ControlPlaneEvent, ResolvedRoute } from "@acp/contracts";
import type { ControlPlaneEvent as ControlPlaneEventType } from "@acp/contracts";

import type { DurableInvocation, OperationCoordinate } from "../../contracts/index.js";
import { deriveEventCoordinate, deriveOperationCoordinate, operationDigest } from "../coordinates/index.js";
import { planStep } from "../lifecycle/index.js";
import type { PlanStep } from "../lifecycle/index.js";
import { LifecyclePlanError, SupervisorError } from "../../errors/index.js";

import type {
  BuildPromptOccurrenceInput,
  BuildResponseOccurrenceInput,
  PromptOccurrenceRecord,
  ResponseOccurrenceRecord,
} from "./types/index.js";

/**
 * The prompt occurrence's value types live in their own leaf,
 * `./types/index.ts`, and are re-exported here unchanged so every importer
 * keeps reading them from this module (owner law §7, decision 90; the intake
 * concept's precedent).
 */
export type {
  BuildPromptOccurrenceInput,
  BuildResponseOccurrenceInput,
  PromptOccurrenceRecord,
  ResponseOccurrenceRecord,
} from "./types/index.js";

/**
 * Event construction.
 *
 * One function, one shape, no branch that reads anything ambient. Given the
 * same invocation and the same plan step, this produces byte-identical bytes
 * every time it is called, in this process or a restarted one. That property is
 * what makes an exact replay append nothing instead of raising a conflict.
 *
 * Payloads carry coordinates, digests and — on the INTENT beat alone — the
 * admitted route (V2-B1c). No path, no credential, no provider output and no
 * transcript: the ledger contract would reject those, and building them here
 * only to have the contract refuse them would move the failure to a worse
 * place. The route is safe by the same test rather than by assertion: every
 * one of its field names survives the contract's credential guards, whose
 * stems are suffix-matched, and every one of its values is an identifier or an
 * instant. A route carrying credential-shaped material is refused by
 * `ControlPlaneEvent.parse` below, here, before any append.
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
  /**
   * The route this run was admitted on (V2-B1c).
   *
   * Required, with no default, for the same reason `plan` and `initiativeId`
   * are: a route that could be omitted would be a route that silently
   * defaulted, and the whole point of recording one is that the log can say
   * afterwards which policy chose which account for the work that ran.
   *
   * It is the value the caller ALREADY had admitted through the contract, not
   * one resolved here. This module calls no router: `routeWithPolicy` and
   * `resolveRoute` live in `@acp/accounts` and are never imported on this
   * path, so there is exactly one producer of `capabilityPolicyVersion` and
   * this is not it. Re-resolving at record time would be a second reader of a
   * document that may have been re-cut in between — two answers to one
   * question.
   */
  readonly route: ResolvedRoute;
}

/**
 * The one payload key the recorded route travels under (V2-B1c).
 *
 * Declared here and, identically, at the consumer in `@acp/ledger`'s
 * projection. Two homes for one key is a drift risk, so the fence pins both
 * declarations by equality and compares their literals: the key cannot be
 * changed on one side alone. It is deliberately not a new export of
 * `@acp/contracts` — the shape is already contracts-owned (`ResolvedRoute`),
 * and a payload key is the same class of fact as `initiativeId`, which this
 * module has always written as a literal.
 */
const RECORDED_ROUTE_KEY = "route";

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
  route: ResolvedRoute,
): Record<string, unknown> {
  // The V2 coordinate rides the base, so every event of a revision-bearing walk
  // carries it and none can forget it (P-18/protocolo G, N-G-2). The contract
  // reads these two keys to decide which idempotency key the event must have,
  // so the key `deriveEventCoordinate` composed and the payload built here move
  // together or `ControlPlaneEvent.parse` below refuses. Without a revision the
  // base is exactly what it was before G, which is what keeps V1 byte-identical.
  const revision = invocation.revision;
  const base =
    revision === undefined
      ? { submissionDigest: invocation.submissionDigest }
      : {
          submissionDigest: invocation.submissionDigest,
          revisionNumber: revision.revisionNumber,
          attemptNumber: revision.attemptNumber,
        };

  // The discovery step opens the task, so it is the one place the initiative
  // can be stated. Carrying it on every event would put the same fact in N
  // places and invite them to disagree.
  if (step.eventType === "TASK_DISCOVERED") {
    return { ...base, beat: "PLAIN", planIndex: step.index, initiativeId };
  }

  if (step.beat === "INTENT") {
    // The INTENT beat is the truthful carrier of the route, and the only one.
    // It is the step that declares the run about to happen, so it is the one
    // place the route it will happen on can be stated; the OUTCOME never
    // restates it, for the same reason no event after `TASK_DISCOVERED`
    // restates the initiative. The fields are projected one by one rather
    // than spread, so a wider object handed in here cannot smuggle a key the
    // contract's guards would then have to catch.
    return {
      ...base,
      beat: "INTENT",
      operationId: operation.operationId,
      operationIndex: operation.operationIndex,
      [RECORDED_ROUTE_KEY]: {
        provider: route.provider,
        model: route.model,
        accountId: route.accountId,
        transportKind: route.transportKind,
        capabilityPolicyVersion: route.capabilityPolicyVersion,
        resolvedAt: route.resolvedAt,
      },
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

  // The producer's half of the fail-closed law (V2-B1c).
  //
  // `ControlPlaneEvent` validates the payload as a bounded record of unknowns
  // and runs the credential guards over it, but it does NOT reach inside and
  // apply `ResolvedRoute`'s own refinement — so a CLI route naming a provider
  // the kernel does not list would pass the event contract and land in the log
  // unchallenged. The route is therefore admitted here, explicitly, and what
  // is written is the parsed value.
  //
  // It is parsed on EVERY step and not only on the one that records it, so a
  // walk with an inadmissible route refuses before it appends anything at all:
  // `assertInvocationContinuity` builds step 0 before the first append, which
  // makes this the earliest point a run can fail closed with zero delta.
  const route = ResolvedRoute.parse(input.route);

  if (step.eventType === ATTEMPT_OPENING_STEP.eventType) {
    return buildAttemptOpening(invocation, step, emittedBy);
  }

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
  // nothing causes a task's discovery. Under a revision step 0 follows the
  // attempt's opening, and threads to it (P-18/protocolo G).
  const previousStep = causalPredecessorOf(invocation, input.plan, step);
  const causationId =
    previousStep === null
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
    fromState: discoveryFromState(invocation, step),
    toState: step.toState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: invocation.invocationId,
    causationId,
    payload: payloadFor(invocation, step, operation, initiativeId, route),
  });
}

// ---------------------------------------------------------------------------
// The attempt's opening (P-18/protocolo G, ADR 0080)
// ---------------------------------------------------------------------------

/**
 * The step that opens a revision-bearing attempt: a beat outside the plan.
 *
 * **Outside the plan, because inside it would rewrite history.** `planIndex`
 * travels in the payload of every PLAIN beat, so inserting a step into
 * `LIFECYCLE_PLAN` would change the bytes of every V1 event after it and make
 * `assertInvocationContinuity` refuse every ledger written before G. The plan's
 * frozen objects are therefore untouched, and this step is navigated to by
 * `nextStep` only for an invocation that carries a revision.
 *
 * **First, because the ledger's arithmetic says so** (Q-G1, adjudicated option
 * (c)). The ledger assigns a new opening `1 + MAX(attempt)` over every event of
 * the task, and every later V2 event of that coordinate must repeat it. A
 * discovery appended first would already hold the flat attempt the walk runs
 * under, pushing the opening one past it — and a walk has one invocation with
 * one flat attempt. So the opening goes from no state to `DISCOVERED` on a task
 * with no events, which is execution §3's "no events: 1", and the discovery
 * follows it as a same-state V2 event. That order also narrows B's tolerant
 * door in the producer (O-2 of B's postaudit): nothing of a coordinate reaches
 * the ledger before its opening.
 *
 * `index` is `-1` because the step has no position in any plan. It enters no
 * payload and no operation identity — the opening performs no effect — and
 * `deriveEventCoordinate` voids its plan index, so the value is never read as a
 * position; it only keeps the step from being mistaken for step 0.
 */
export const ATTEMPT_OPENING_STEP: PlanStep = Object.freeze({
  index: -1,
  transitionId: "attempt.opened",
  fromState: null,
  toState: planStep(0).toState,
  eventType: "TASK_ATTEMPT_OPENED",
  beat: "PLAIN",
});

/**
 * Build the attempt's opening, field by field.
 *
 * The payload is B's grammar and nothing else: the revision record, the
 * coordinate, the invocation it names and the flat assignment it proposes.
 * Projected one by one from named members, so a wider invocation cannot widen
 * the payload — the ledger's door reads the two identity keys and does **not**
 * refuse a stray one, which makes this builder the only thing that keeps a
 * ninth key out (the contract's own comment says as much). No
 * `submissionDigest`, no route, no initiative: those bind at the discovery that
 * follows, one event later than a V1 walk binds them, and the window between
 * the two holds no work.
 *
 * `legacyAttemptNumber` is the invocation's flat attempt. The producer
 * proposes; the ledger computes `1 + MAX(attempt)` and refuses a disagreement
 * by name (ADR 0073). `appendPlanStep` checks the same arithmetic against the
 * ledger before it appends, so a walk that would be refused never reaches the
 * door. Both instants are the submission's, like every other event of the walk.
 *
 * The revision record includes the envelope reference since P-36/local D: the
 * opening is stamped with the version in force, and from `2.5.0` a revision
 * record names its envelope by a registered reference (decision 41, ADR 0084).
 * The reference is the invocation's, carried; nothing here publishes an
 * envelope or derives a reference from its digest.
 */
function buildAttemptOpening(
  invocation: DurableInvocation,
  step: PlanStep,
  emittedBy: string,
): ControlPlaneEventType {
  const revision = invocation.revision;
  if (revision === undefined) {
    throw new LifecyclePlanError(
      "an attempt opening states the revision its attempt runs under, and this" +
        " invocation carries none; a walk without a revision has no opening",
    );
  }
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
    correlationId: invocation.invocationId,
    // Nothing causes an attempt's opening, exactly as nothing causes a V1
    // task's discovery.
    causationId: null,
    payload: {
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      attemptNumber: revision.attemptNumber,
      envelopeSha256: revision.envelopeSha256,
      envelopeArtifactReferenceId: revision.envelopeArtifactReferenceId,
      invocationId: invocation.invocationId,
      legacyAttemptNumber: invocation.attempt,
    },
  });
}

/**
 * The step a plan step's causation names, or `null` where nothing caused it.
 *
 * One answer for the builder and for the producer guard in the step executor,
 * so the link an event states and the link the guard verifies cannot come
 * apart. The opening has no predecessor; step 0 has none in a V1 walk and the
 * opening in a V2 one; every other step names the plan's previous step.
 */
export function causalPredecessorOf(
  invocation: DurableInvocation,
  plan: readonly PlanStep[],
  step: PlanStep,
): PlanStep | null {
  if (step.eventType === ATTEMPT_OPENING_STEP.eventType) return null;
  if (step.index === 0) {
    return invocation.revision === undefined ? null : ATTEMPT_OPENING_STEP;
  }
  const previous = plan[step.index - 1];
  if (previous === undefined) {
    throw new LifecyclePlanError(
      "the plan has no step before index " + String(step.index) + "; the causal thread cannot be derived",
    );
  }
  return previous;
}

/**
 * The state a step leaves, as the ledger will see it.
 *
 * The plan's step 0 declares `fromState: null` because in a V1 walk it creates
 * the task. Under a revision the opening created it, so the discovery is a
 * same-state passthrough out of the opening's own `toState`. Decided here, in
 * the builder, and nowhere else: the plan's frozen objects are not copied or
 * edited, so `nextStep` still returns `planStep(0)` itself in both walks.
 */
function discoveryFromState(invocation: DurableInvocation, step: PlanStep): PlanStep["fromState"] {
  if (invocation.revision === undefined || step.index !== 0 || step.fromState !== null) {
    return step.fromState;
  }
  return ATTEMPT_OPENING_STEP.toState;
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

// ---------------------------------------------------------------------------
// The prompt occurrence (P-06/C; execution §8.1, ADR 0077, ADR 0095)
// ---------------------------------------------------------------------------

/**
 * The durable name one prompt occurrence is recorded under.
 *
 * Derived from the occurrence's own id, never from a counter this module keeps,
 * for `usageObservationTransitionId`'s reason: a resumed dispatcher restating
 * the same occurrence rebuilds exactly this name, so the second append is a
 * replay under the same idempotency key rather than a conflict or a duplicate
 * row. An occurrence is recorded once, and the door says so too.
 */
export function promptOccurrenceTransitionId(occurrenceId: string): string {
  return "prompt-occurrence." + occurrenceId;
}

/**
 * Build the `PROMPT_OCCURRENCE_RECORDED` event for one delivered instruction
 * (P-06/C; the producer ADR 0077 asked for and ADR 0080 §7 reassigned, whose
 * condition -- the real execution port and an adapter -- is met at this
 * escalón, as ADR 0095 records).
 *
 * Records that an instruction was **used**, and nothing about what it said. No
 * block, no text and no reference enters this payload: what crosses is the
 * digest and the length the dispatcher already held, which is what keeps
 * N-P06-14 true of the recording path as well as of the composing one.
 *
 * The payload is closed by construction -- the V2 coordinate and the one record
 * -- because the contract's `payload` is a record of unknowns for every type and
 * the thing that keeps a stray key out is this builder, as the contract itself
 * says of the types of P-18/protocolo C and D.
 *
 * Closed means built field by field (P-06/CORR, ADR 0096): the record is an
 * explicit literal of exactly the thirteen names, never a spread of the input.
 * A spread copies every own key of whatever object arrives, and a value typed
 * as the record can still carry more -- TypeScript checks excess keys on a
 * literal, not on a variable -- so a spread would hand the door a key its
 * grammar refuses. The literal is typed as the record, so a missing or an extra
 * name is a compile error here too.
 *
 * Pure in the house sense: the coordinates come from the durable invocation,
 * nothing reads a clock or a random source, and each of the thirteen values is
 * carried verbatim. Recording the same occurrence twice appends once.
 */
export function buildPromptOccurrenceEvent(
  input: BuildPromptOccurrenceInput,
): ControlPlaneEventType {
  const { invocation, occurrence } = input;

  // Refused by name, here, rather than left to the door.
  //
  // A prompt occurrence carries the V2 coordinate, and a V1 invocation names no
  // revision to put in it -- so there is no attempt number to attribute the
  // delivery to. `revisionOf` in the usage recorder refuses the same thing for
  // the same reason; relying on the door would put the error one layer from its
  // cause.
  const revision = invocation.revision;
  if (revision === undefined) {
    throw new SupervisorError(
      "refusing to record a prompt occurrence for an invocation without a revision; an" +
        " occurrence carries the V2 coordinate, and a V1 invocation names no segment or" +
        " attempt to attribute the delivery to",
    );
  }

  const record: PromptOccurrenceRecord = {
    occurrenceId: occurrence.occurrenceId,
    dispatchAttemptId: occurrence.dispatchAttemptId,
    effectId: occurrence.effectId,
    routeSegmentId: occurrence.routeSegmentId,
    ordinal: occurrence.ordinal,
    requestedModelId: occurrence.requestedModelId,
    provider: occurrence.provider,
    modelResolutionStatus: occurrence.modelResolutionStatus,
    modelVersionId: occurrence.modelVersionId,
    accountId: occurrence.accountId,
    promptSha256: occurrence.promptSha256,
    promptBytes: occurrence.promptBytes,
    contextSha256: occurrence.contextSha256,
  };

  const transitionId = promptOccurrenceTransitionId(record.occurrenceId);
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);

  // Parsed, not cast: the event contract runs the credential and transcript
  // guards over the payload, and a producer that trusted its own object would
  // be the one place this package's fail-closed law is not applied.
  return ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: "PROMPT_OCCURRENCE_RECORDED",
    fromState: input.state,
    toState: input.state,
    emittedBy: input.emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: invocation.invocationId,
    causationId: input.causedBy,
    payload: {
      revisionNumber: revision.revisionNumber,
      attemptNumber: revision.attemptNumber,
      promptOccurrence: record,
    },
  });
}

/**
 * The durable name one response occurrence is recorded under (P-07 escalón D).
 *
 * Derived from the occurrence's own id, for `promptOccurrenceTransitionId`'s
 * reason: restating the same answer is a replay under the same key.
 */
export function responseOccurrenceTransitionId(occurrenceId: string): string {
  return "response-occurrence." + occurrenceId;
}

/**
 * Build the `RESPONSE_OCCURRENCE_RECORDED` event for one answer (P-07 escalón D,
 * ADR 0100): the prompt builder's twin, closed by construction from its first line.
 *
 * The record is one explicit literal of exactly the five names, typed as the
 * record, never a spread of the input: a value typed as the record can carry more
 * keys, and a spread would copy them into a payload the door refuses (P-06/CORR's
 * lesson, applied before the defect rather than after it). It records that an
 * answer was received and published — its digest and length — and nothing it
 * said.
 */
export function buildResponseOccurrenceEvent(
  input: BuildResponseOccurrenceInput,
): ControlPlaneEventType {
  const { invocation, occurrence } = input;

  // Refused by name, for the prompt builder's reason: a response occurrence
  // carries the V2 coordinate, and a V1 invocation names no attempt.
  const revision = invocation.revision;
  if (revision === undefined) {
    throw new SupervisorError(
      "refusing to record a response occurrence for an invocation without a revision; an" +
        " occurrence carries the V2 coordinate, and a V1 invocation names no segment or" +
        " attempt to attribute the answer to",
    );
  }

  const record: ResponseOccurrenceRecord = {
    occurrenceId: occurrence.occurrenceId,
    promptOccurrenceId: occurrence.promptOccurrenceId,
    responseSha256: occurrence.responseSha256,
    responseBytes: occurrence.responseBytes,
    redactionVerdict: occurrence.redactionVerdict,
  };

  const transitionId = responseOccurrenceTransitionId(record.occurrenceId);
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);

  return ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: "RESPONSE_OCCURRENCE_RECORDED",
    fromState: input.state,
    toState: input.state,
    emittedBy: input.emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: invocation.invocationId,
    causationId: input.causedBy,
    payload: {
      revisionNumber: revision.revisionNumber,
      attemptNumber: revision.attemptNumber,
      responseOccurrence: record,
    },
  });
}
