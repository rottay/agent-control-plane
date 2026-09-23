import {
  ARTIFACT_EVENT_KINDS,
  RESULT_STATUSES,
  ResolvedRoute,
  RoadmapVersion,
  TERMINAL_STATES,
  TRANSPORT_KINDS,
  WORKER_ROLES,
  parseWorkerIdentity,
  type ArtifactRegistryEvent,
  type ControlPlaneEvent,
  type InitiativeEvent,
  type WorkerRole,
} from "@acp/contracts";

import {
  EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1,
  EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1,
  OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1,
  OUTBOX_FAILURE_CODES,
} from "@acp/contracts";

import { canonicalJsonStringify, sha256Hex } from "../canonical-json/index.js";
import {
  LedgerArtifactEncryptionConflictError,
  LedgerIdempotencyConflictError,
  LedgerValidationError,
  type LedgerValidationIssue,
} from "../errors/index.js";
import {
  OUTBOX_COMMAND_KINDS,
  OUTBOX_STATES,
  OUTBOX_STREAMS,
  OUTBOX_TERMINAL_STATES,
  OUTBOX_TRANSITIONS,
} from "../outbox-store/index.js";
import type { OutboxCommandKind, OutboxState, OutboxStream } from "../outbox-store/index.js";
import {
  ARTIFACT_ACCESS_POLICY_IDS,
  DELIVERED_ARTIFACT_EVENT_KINDS,
  DISPATCH_STATES,
  DISPATCH_STATE_TRANSITIONS,
  EFFECT_OUTCOME_STATUSES,
  INITIATIVE_REGISTRATION_PAYLOAD_KEYS,
  MODEL_RESOLUTION_STATUSES,
  MODEL_VERSION_PAYLOAD_KEYS,
  MODEL_VERSION_STATUSES,
  PRICE_INTERVAL_KEYS,
  PRICE_TABLE_PAYLOAD_KEYS,
  PRICE_TOKEN_CLASSES,
  REDACTION_VERDICTS,
  TASK_CLIENT_KEY_PATTERN,
  TASK_INTAKE_PAYLOAD_KEYS,
  TASK_INTAKE_RESOLUTION_KEYS,
  TASK_INTAKE_TRANSITION_ID,
  TASK_INTAKE_WATERMARK_KEYS,
} from "../types/index.js";
import type {
  ArtifactBlobReadModel,
  ArtifactFoldView,
  ArtifactPinReadModel,
  ArtifactProjectionSnapshot,
  ArtifactProjectionWrites,
  ArtifactReferenceReadModel,
  CausationRef,
  DispatchAttemptReadModel,
  DispatchState,
  EffectOutcomeStatus,
  EffectReadModel,
  ExecutionRouteSegmentReadModel,
  ExecutionRouteReadModel,
  InitiativeReadModel,
  ModelVersionEligibleRoleRow,
  ModelVersionProjection,
  ModelVersionProjectionSnapshot,
  ModelVersionReadModel,
  ModelVersionStatus,
  ModelVersionTransportRow,
  OutboxCommandReadModel,
  OutboxFailureCode,
  PriceIntervalProjection,
  PriceIntervalProjectionSnapshot,
  PriceIntervalReadModel,
  PriceTableModelVersion,
  PriceTokenClass,
  PromptOccurrenceReadModel,
  RegistryDocument,
  RegistryProjectionSnapshot,
  ResponseOccurrenceReadModel,
  RoadmapVersionReadModel,
  RoutingAssignmentFallbackRow,
  RoutingAssignmentProjection,
  RoutingAssignmentReadModel,
  TaskAttemptReadModel,
  TaskIntakePayload,
  TaskIntakeResolution,
  TaskIntakeWatermark,
  TaskReadModel,
  TaskRevisionReadModel,
  TaskSubmissionReadModel,
  WorkerReadModel,
} from "../types/index.js";

import type {
  UsageCaptureView,
  UsageCaptureWrites,
  UsageMeasurementStreamReadModel,
  UsageObservationReadModel,
  UsageSettlementReadModel,
  UsageSettlementRecord,
} from "../types/index.js";
import {
  USAGE_FOLD_VERSION_V1,
  USAGE_REPORT_KINDS,
  USAGE_SOURCE_CLASSES,
  USAGE_SOURCE_POLICY_V1,
  foldUsageSettlement,
  measurementStreamIdV1,
  type UsageMeasurementStreamInput,
  type UsageObservationInput,
} from "../usage-settlement/index.js";

import type {
  DispatchOutcomeReading,
  DispatchOutcomeRecord,
  EffectOutcomeArrival,
  OccurrenceOwner,
  OccurrenceReading,
  OccurrenceRefusal,
  OutboxAttemptRecord,
  OutboxCommandIntention,
  OutboxEventEntry,
  OutboxFold,
  OutboxPredecessor,
  OutboxReading,
} from "./types/index.js";

/**
 * The value types of the P-18/protocolo folds live in their own leaf,
 * `./types/index.ts`, and are re-exported here unchanged so every importer keeps
 * reading them from this module (CORR-2, ADR 0079).
 */
export type {
  DispatchOutcomeReading,
  DispatchOutcomeRecord,
  EffectOutcomeArrival,
  OccurrenceOwner,
  OccurrenceReading,
  OccurrenceRefusal,
  OutboxAttemptRecord,
  OutboxCommandIntention,
  OutboxDeliveryAttempt,
  OutboxDeliveryObservation,
  OutboxEventEntry,
  OutboxFold,
  OutboxPredecessor,
  OutboxReading,
} from "./types/index.js";

/**
 * The one payload key the recorded route travels under (V2-B1c).
 *
 * Declared here and, identically, at the producer in
 * `@acp/runtime`'s event builder. Two homes for one key is a drift risk, so
 * the fence pins both declarations by equality and compares their literals:
 * the key cannot be changed on one side alone. It is deliberately NOT a new
 * export of `@acp/contracts` — the shape is already contracts-owned
 * (`ResolvedRoute`), and a payload key is the same class of fact as
 * `initiativeId`, which this module has always read as a literal.
 */
const RECORDED_ROUTE_KEY = "route";

/**
 * The payload keys that constitute a revision record (P-05/B, V8/C-5).
 *
 * Declared **once**, here, and deliberately not mirrored anywhere yet. The
 * producer is P-18; when it arrives it inherits these names and the fence pins
 * the equality of the two declarations, exactly as it does for
 * `RECORDED_ROUTE_KEY` above. Adding that law now would pin one declaration
 * against nothing.
 *
 * **Presence, not type.** A revision record is born from the first event of
 * **any** type that carries the complete set. That is the only reading
 * consistent with the adjudication that no new event type is created: if the
 * fold keyed off a type, the coordinate would need a type of its own, and it
 * does not have one. An event carrying a partial set produces no row at all —
 * it is not a malformed revision, it is not a revision.
 *
 * `restoredFromRevisionId` is optional and is the one key that may legitimately
 * be absent: most revisions restore nothing.
 *
 * The first of the five is **exported** and the other four are not, which is a
 * fact about one refusal rather than about the set. P-18/protocolo B's attempt
 * opening carries the revision record as well as its own coordinate, and the
 * append door refuses an opening that neither finds a revision nor announces
 * one — a refusal whose `path` has to be this key. One declaration reached by an
 * import, rather than a second literal in `../ledger`: the drift
 * `RECORDED_ROUTE_KEY` needs a fence law to prevent, an export prevents
 * outright.
 */
export const REVISION_ID_KEY = "revisionId";
const REVISION_NUMBER_KEY = "revisionNumber";
const ATTEMPT_NUMBER_KEY = "attemptNumber";
const ENVELOPE_SHA256_KEY = "envelopeSha256";
const RESTORED_FROM_REVISION_ID_KEY = "restoredFromRevisionId";

/**
 * The key a revision record names its envelope's bytes by (P-36/local D).
 *
 * Decision 41: `task_revision_read_model.envelope_artifact_reference_id` is
 * keyed on a cohort of `contract_version`. Exported so the append door's
 * existence check names the same key the fold reads, by import rather than by a
 * second literal.
 *
 * **Before the cohort, the key is refused rather than ignored.** A reader that
 * met it on a `2.2.0`, `2.3.0` or `2.4.0` record would have to either drop a
 * fact the writer thought it recorded or interpret a reference no build of that
 * contract could mint. **From the cohort on, it is required**, and a present
 * value that is not a non-empty string is refused by name rather than read as
 * absent (CORR-2, decision 56). The fold checks form only: whether the
 * reference exists, and names a `TASK_ENVELOPE`, is the append door's question,
 * because the answer lives on another stream and a rebuild folds the streams
 * one at a time (ADR 0084).
 *
 * Nothing here, or anywhere, derives a reference from `envelopeSha256`.
 */
export const ENVELOPE_ARTIFACT_REFERENCE_KEY = "envelopeArtifactReferenceId";

/**
 * The contract versions whose revision records carry no envelope reference.
 *
 * A closed list, frozen at the members that existed before migration 16 and
 * spelled identically in that migration's trigger — never a comparison of
 * version strings. A version is either one of these three, and its record
 * holds `null`, or it is not, and its record holds a reference; a later bump
 * falls into the second cohort without touching an applied migration.
 */
export const PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS: readonly string[] = [
  "2.2.0",
  "2.3.0",
  "2.4.0",
];

/**
 * The contract versions whose outcomes carry no result (P-07 escalón B, ADR 0098).
 *
 * `PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS`' rule, for migration 22: a closed list
 * of every version a build before that migration could stamp, spelled identically
 * in its two triggers, never a comparison of version strings. An outcome of one of
 * these six names no result; a `SUCCEEDED` of any later version names one.
 */
export const PRE_RESULT_REFERENCE_CONTRACT_VERSIONS: readonly string[] = [
  "2.2.0",
  "2.3.0",
  "2.4.0",
  "2.5.0",
  "2.6.0",
  "2.7.0",
];

/** The two keys inside `payload.outcome` that name an effect's result (ADR 0098). */
export const RESULT_ARTIFACT_REFERENCE_KEY = "resultArtifactReferenceId";
export const RESULT_SHA256_KEY = "resultSha256";

/**
 * The two payload keys only an attempt's opening may state (P-18/protocolo B).
 *
 * The other five keys of that payload are the revision record's, declared
 * above and read by the same fold, because the opening announces its revision
 * as well as its attempt — which is what satisfies the attempt table's foreign
 * key by construction rather than by assuming the revision row is already
 * there.
 *
 * These two are different in kind from every key above them. A revision record
 * is born from the **presence** of a key set on an event of any type, because
 * no type announces a revision. An attempt has a type of its own, and it has to:
 * `invocationId` and `legacyAttemptNumber` are facts that only the arrival which
 * opens the attempt is entitled to state, and a fold keyed off presence would
 * let any later event of the coordinate restate — and so contradict — them.
 */
export const INVOCATION_ID_KEY = "invocationId";
export const LEGACY_ATTEMPT_NUMBER_KEY = "legacyAttemptNumber";

/**
 * The one event type that opens an attempt.
 *
 * Declared here as the fold's own reading of the contract vocabulary, the way
 * `nextExecutionRouteProjection` names `RUN_STARTED` inline. It is a member of
 * `ControlPlaneEventType`, so a typo would not compile.
 */
export const TASK_ATTEMPT_OPENED: ControlPlaneEvent["type"] = "TASK_ATTEMPT_OPENED";

/**
 * The three event types of P-18/protocolo C, and the three payload keys their
 * records travel under.
 *
 * The nested-object shape is `RECORDED_ROUTE_KEY`'s rather than the revision's
 * flat key set, and the choice is deliberate: a segment carries nineteen
 * fields, and nineteen top-level payload keys on an event that also has to
 * carry the V2 coordinate would be a namespace nobody could keep apart. The two
 * coordinate keys stay top level because they have to — `v2CoordinateInPayload`
 * in the contract and migration 11's trigger both read them there.
 *
 * A segment record rides **both** intention types, which is migration 12's
 * pattern one rung down: `TASK_ATTEMPT_OPENED` carries the revision record so
 * the attempt's foreign key is satisfied by construction rather than by
 * assuming the parent is already there. Here an effect's intention announces
 * the initial segment and a dispatch's intention announces the effective one —
 * which, after a handoff, is a segment that has never been seen before.
 */
export const EFFECT_INTENDED: ControlPlaneEvent["type"] = "EFFECT_INTENDED";
export const DISPATCH_INTENDED: ControlPlaneEvent["type"] = "DISPATCH_INTENDED";
export const DISPATCH_OUTCOME_RECORDED: ControlPlaneEvent["type"] = "DISPATCH_OUTCOME_RECORDED";

export const SEGMENT_KEY = "segment";
export const EFFECT_KEY = "effect";
export const DISPATCH_KEY = "dispatch";
export const OUTCOME_KEY = "outcome";

/**
 * The grammar of a `LocalKey` — execution §6.1 `:275`, exactly.
 *
 * ASCII, an alphanumeric first character, then up to 127 more of a set that
 * admits `.`, `_` and `-` and nothing else. Comparison is **ordinal**: `"A"` and
 * `"a"` are two different steps. It is not a path and it is not a glob, and no
 * reader of it ever splits on a separator.
 */
export const LOCAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The semantic scope P-18 admits, and the only one.
 *
 * Execution §6.1 `:277`: "P-18 usa semantic_scope_key=`run`". Composition may
 * declare subscopes later, but it may never rename the same work nor make the
 * identity depend on a profile, an account or a segment — which is why this is a
 * closed set of one rather than a free `LocalKey` at this escalón.
 */
export const SEMANTIC_SCOPE_KEYS = ["run"] as const;

/**
 * The two event types of P-18/protocolo D, and the payload keys their records
 * travel under (execution §8; ADR 0077).
 *
 * The nested record is escalón C's shape, and the payload beside it holds the
 * V2 coordinate and **nothing else**. Unlike C's intentions, these two payloads
 * are closed: §8 `:433` keeps every byte of a prompt and of its answer out of
 * the rows, and a payload that admitted keys its grammar does not declare
 * would be the one place a transcript could still ride in under a name the
 * contract's transcript guard has never heard of.
 */
export const PROMPT_OCCURRENCE_RECORDED: ControlPlaneEvent["type"] = "PROMPT_OCCURRENCE_RECORDED";
export const RESPONSE_OCCURRENCE_RECORDED: ControlPlaneEvent["type"] =
  "RESPONSE_OCCURRENCE_RECORDED";

export const PROMPT_OCCURRENCE_KEY = "promptOccurrence";
export const RESPONSE_OCCURRENCE_KEY = "responseOccurrence";

/**
 * Every key a prompt occurrence record may carry, and no other.
 *
 * `modelVersionId` and `contextSha256` may be absent or `null`; every other
 * key is required. There is no `identity`: that column is the recording
 * event's `emittedBy`, so a payload cannot name another worker as the sender.
 */
export const PROMPT_OCCURRENCE_RECORD_KEYS = [
  "occurrenceId",
  "dispatchAttemptId",
  "effectId",
  "routeSegmentId",
  "ordinal",
  "requestedModelId",
  "provider",
  "modelResolutionStatus",
  "modelVersionId",
  "accountId",
  "promptSha256",
  "promptBytes",
  "contextSha256",
] as const;

/**
 * Every key a response occurrence record may carry, and no other — all five
 * required.
 *
 * **No `dispatchAttemptId`, no `routeSegmentId`, no `accountId`.** An answer is
 * attributed through the prompt it answers and through nothing else, so an
 * answer that arrives after a handoff lands on the origin's account and
 * segment. A payload able to name either would be able to name the
 * destination's (§8 `:418-419`).
 */
export const RESPONSE_OCCURRENCE_RECORD_KEYS = [
  "occurrenceId",
  "promptOccurrenceId",
  "responseSha256",
  "responseBytes",
  "redactionVerdict",
] as const;

/** A payload value that is a non-empty string, or null. */
function payloadText(payload: ControlPlaneEvent["payload"], key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A payload value that is a positive safe integer, or null. */
function payloadCount(payload: ControlPlaneEvent["payload"], key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Pure projection rules.
 *
 * There is exactly one implementation of what an event does to a read model,
 * and both callers use it: the incremental path inside append, and the full
 * replay inside rebuildReadModel and verifyIntegrity.
 *
 * That is deliberate. If incremental projection and replay were written twice,
 * they would drift, and the drift would only ever be discovered by a rebuild
 * silently producing a different answer than the live projection. With one
 * function, byte-equivalence after a rebuild is a property of the design rather
 * than a coincidence that has to be tested for on every field.
 *
 * Nothing here reads a clock. Every timestamp in a read model comes from the
 * event that produced it, so the projection is a pure function of the event
 * stream and two rebuilds of the same ledger cannot differ.
 */

function isTerminalState(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The initiative a discovering event attributes its task to, if any.
 *
 * Read from the `TASK_DISCOVERED` payload and from nowhere else: that is the
 * event that opens a task, so it is the one place the attribution can be
 * stated. Every event older than the field simply has no `initiativeId` in its
 * payload and folds to null, which is what keeps a ledger written before P7I
 * replaying byte-for-byte.
 */
function initiativeIdFromEvent(event: ControlPlaneEvent): string | null {
  if (event.type !== "TASK_DISCOVERED") return null;
  const value = event.payload["initiativeId"];
  return typeof value === "string" ? value : null;
}

/** Apply one event to a task projection row, or create it from nothing. */
export function nextTaskProjection(
  current: TaskReadModel | null,
  event: ControlPlaneEvent,
  sequence: number,
): TaskReadModel {
  const base = {
    taskId: event.taskId,
    currentState: event.toState,
    lastSequence: sequence,
    lastEventId: event.eventId,
    lastEventType: event.type,
    lastTransitionId: event.transitionId,
    lastEmittedBy: event.emittedBy,
    updatedAt: event.occurredAt,
    isTerminal: isTerminalState(event.toState),
  } as const;

  // What the latest revision says, carried here as a convenience (P-05/B,
  // V8/C-6). The authority is the revision row; these three are a shortcut so a
  // task list does not have to join to answer "which envelope is this on".
  //
  // Read from the SAME fold the revision row comes from, not from a second
  // reading of the payload, so the denormalization cannot come to disagree with
  // the record it denormalizes.
  const revision = nextTaskRevisionProjection(event, sequence);
  const attemptNumber = revisionAttemptNumber(event);
  // What the intake door recorded (P-14 C). Only an intake states it, and only
  // an intake can open a task, so on every later event this is null and the
  // row's own value is carried.
  const intake = taskIntakePayloadOf(event);

  if (current === null) {
    return {
      ...base,
      initiativeId: initiativeIdFromEvent(event),
      latestAttempt: event.attempt,
      eventCount: 1,
      firstSequence: sequence,
      createdAt: event.occurredAt,
      envelopeSha256: revision?.envelopeSha256 ?? null,
      latestRevisionNumber: revision?.revisionNumber ?? null,
      latestAttemptNumber: revision === null ? null : attemptNumber,
      stepId: intake?.stepId ?? null,
      role: intake?.role ?? null,
      commitPolicy: intake?.commitPolicy ?? null,
    };
  }

  // Three cases, not two, and the middle one is what a single `>=` predicate
  // gets wrong:
  //
  // - a HIGHER revision replaces the envelope and the number together;
  // - the SAME revision keeps the highest attempt and moves nothing else;
  // - an OLDER revision moves nothing at all.
  //
  // The envelope and the number move only on `newer` because they must move
  // together: a task advertising revision 3's number beside revision 2's
  // envelope is the one thing a denormalization must never do, and both are
  // facts of the revision rather than of the attempt.
  //
  // The attempt is a different question. Within one revision the attempts are a
  // sequence, and a late event announcing attempt 1 after attempt 3 has already
  // been seen must not lower it — the projection would claim the task went
  // backwards, which is exactly what `latestAttempt` above refuses for the
  // legacy counter.
  const newer =
    revision !== null &&
    (current.latestRevisionNumber === null ||
      revision.revisionNumber > current.latestRevisionNumber);
  const same = revision !== null && revision.revisionNumber === current.latestRevisionNumber;

  let latestAttemptNumber = current.latestAttemptNumber;
  if (newer) {
    latestAttemptNumber = attemptNumber;
  } else if (same) {
    // Both `??` are defensive only: a row holding a revision number holds the
    // attempt that arrived with it, because `nextTaskRevisionProjection` yields
    // null unless the whole key set is present.
    latestAttemptNumber = Math.max(current.latestAttemptNumber ?? 0, attemptNumber ?? 0);
  }

  return {
    ...base,
    // Attribution is written once and then carried. The `??` covers only the
    // case where the row was created by something other than the discovering
    // event; a later event can supply the id but can never change one.
    initiativeId: current.initiativeId ?? initiativeIdFromEvent(event),
    // A retry raises the attempt; a late event from an older attempt must not
    // lower it, or the projection would claim the task went backwards.
    latestAttempt: Math.max(current.latestAttempt, event.attempt),
    eventCount: current.eventCount + 1,
    firstSequence: current.firstSequence,
    createdAt: current.createdAt,
    envelopeSha256: newer ? revision.envelopeSha256 : current.envelopeSha256,
    latestRevisionNumber: newer ? revision.revisionNumber : current.latestRevisionNumber,
    latestAttemptNumber,
    // Written once, like the attribution above. `fromState: null` keeps an
    // intake from ever reaching this branch through the door; the carry is what
    // a later event does to them.
    stepId: current.stepId,
    role: current.role,
    commitPolicy: current.commitPolicy,
  };
}

/**
 * Apply one event to a worker projection row, or create it from nothing.
 *
 * taskIsNewForWorker comes from the caller because the two callers hold that
 * fact in different places: the incremental path looks it up in
 * worker_task_read_model, the replay path holds it in memory. The arithmetic
 * itself stays here, in one place.
 */
export function nextWorkerProjection(
  current: WorkerReadModel | null,
  event: ControlPlaneEvent,
  sequence: number,
  taskIsNewForWorker: boolean,
): WorkerReadModel {
  const identity = parseWorkerIdentity(event.emittedBy);

  const base = {
    identity: event.emittedBy,
    provider: identity.provider,
    model: identity.model,
    role: identity.role,
    instance: identity.instance,
    lastSequence: sequence,
    lastSeenAt: event.occurredAt,
    lastTaskId: event.taskId,
    lastEventType: event.type,
  } as const;

  if (current === null) {
    return {
      ...base,
      eventCount: 1,
      taskCount: 1,
      firstSequence: sequence,
      firstSeenAt: event.occurredAt,
    };
  }

  return {
    ...base,
    eventCount: current.eventCount + 1,
    taskCount: current.taskCount + (taskIsNewForWorker ? 1 : 0),
    firstSequence: current.firstSequence,
    firstSeenAt: current.firstSeenAt,
  };
}

/** One worker/task association row, derived from observed emitters. */
export interface WorkerTaskProjection {
  readonly identity: string;
  readonly taskId: string;
  readonly eventCount: number;
  readonly lastSequence: number;
}

export function nextWorkerTaskProjection(
  current: WorkerTaskProjection | null,
  event: ControlPlaneEvent,
  sequence: number,
): WorkerTaskProjection {
  return {
    identity: event.emittedBy,
    taskId: event.taskId,
    eventCount: (current?.eventCount ?? 0) + 1,
    lastSequence: sequence,
  };
}

/**
 * The route one `RUN_STARTED` event recorded, if its payload carries one.
 *
 * Modelled on `nextRoadmapVersionProjection` deliberately, because the two
 * make the same allocation of duties, and the asymmetry is the part a later
 * reader gets wrong:
 *
 * - **At the producer**, a route that is not contract-admitted must never be
 *   appended. Refusal there is refusal to write.
 * - **Here, at the projection**, a payload that does not parse projects **no
 *   row while the event still stands**. Refusing the event at replay would let
 *   a projection disown history the log accepted; the event tables have no
 *   delete path at all, and replay has to remain total.
 *
 * Collapsing the two — refusing at replay, or writing a partial row — either
 * breaks rebuild totality or launders a malformed record into the read model.
 *
 * The row's identity comes from the EVENT (`taskId`, `attempt`) and never from
 * the payload, so a payload cannot claim another task's route. That is the
 * structural half of the binding. The other half — that the route recorded is
 * the one this attempt was actually admitted on, rather than one substituted
 * between a crash and a resume — belongs to the producer, and is not yet
 * pinned: step 0 carries no route, so a resume that precedes the INTENT append
 * is not refused today. Stated here rather than implied, because a reader
 * would otherwise reasonably assume the ledger checked it.
 */
export function nextExecutionRouteProjection(
  event: ControlPlaneEvent,
  sequence: number,
): ExecutionRouteReadModel | null {
  if (event.type !== "RUN_STARTED") return null;

  const parsed = ResolvedRoute.safeParse(event.payload[RECORDED_ROUTE_KEY]);
  if (!parsed.success) return null;

  return {
    taskId: event.taskId,
    attempt: event.attempt,
    provider: parsed.data.provider,
    model: parsed.data.model,
    accountId: parsed.data.accountId,
    transportKind: parsed.data.transportKind,
    capabilityPolicyVersion: parsed.data.capabilityPolicyVersion,
    resolvedAt: parsed.data.resolvedAt,
    recordedAt: event.recordedAt,
    sequence,
  };
}

/**
 * The revision one event records, if its payload constitutes one (P-05/B).
 *
 * Modelled on `nextExecutionRouteProjection` above and making the same
 * allocation of duties: **at the producer**, a malformed revision must never be
 * appended; **here**, a payload that does not constitute a revision projects no
 * row while the event still stands. Refusing the event at replay would let a
 * projection disown history the log accepted, and the event tables have no
 * delete path at all — replay has to stay total.
 *
 * There is one exception to that totality, and it is deliberate: the envelope
 * reference is **refused** rather than folded when it is out of its cohort —
 * present on a record of the cohort before it, absent or malformed on a record
 * of the cohort that carries it. See `ENVELOPE_ARTIFACT_REFERENCE_KEY`. The
 * distinction is between a payload this contract has no opinion about — which
 * is ignored — and a payload that claims, or omits, a fact its own version
 * decides, which is a reader being asked to pretend it understood something.
 *
 * The row's identity comes from the EVENT's `taskId` and the payload's
 * `revisionNumber`; a payload cannot claim another task's revision. `createdBy`
 * is `emittedBy`, `createdAt` is `occurredAt` and `contractVersion` is the
 * event's own, so every field of the record is traceable to the row that
 * produced it.
 */
export function nextTaskRevisionProjection(
  event: ControlPlaneEvent,
  sequence: number,
): TaskRevisionReadModel | null {
  const payload = event.payload;

  const revisionId = payloadText(payload, REVISION_ID_KEY);
  const revisionNumber = payloadCount(payload, REVISION_NUMBER_KEY);
  const attemptNumber = payloadCount(payload, ATTEMPT_NUMBER_KEY);
  const envelopeSha256 = payloadText(payload, ENVELOPE_SHA256_KEY);

  if (
    revisionId === null ||
    revisionNumber === null ||
    attemptNumber === null ||
    envelopeSha256 === null
  ) {
    return null;
  }

  return {
    taskId: event.taskId,
    revisionNumber,
    revisionId,
    envelopeSha256,
    envelopeArtifactReferenceId: envelopeArtifactReferenceOf(event),
    restoredFromRevisionId: payloadText(payload, RESTORED_FROM_REVISION_ID_KEY),
    createdAt: event.occurredAt,
    createdBy: event.emittedBy,
    contractVersion: event.contractVersion,
    sequence,
  };
}

/**
 * The envelope reference one revision record carries, decided by its cohort.
 *
 * Three refusals, each by name and none of them a `null` in disguise: a key on
 * a record of the cohort before the reference; no key on a record of the cohort
 * that carries it; and a key whose value is not a non-empty string — `null`,
 * `""`, a number or an object is a writer that said something, and reading it
 * as absent would launder a malformed record into a row the trigger then
 * aborts on without a name.
 */
function envelopeArtifactReferenceOf(event: ControlPlaneEvent): string | null {
  const path = "payload." + ENVELOPE_ARTIFACT_REFERENCE_KEY;
  const value = event.payload[ENVELOPE_ARTIFACT_REFERENCE_KEY];
  if (PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS.includes(event.contractVersion)) {
    if (value === undefined) return null;
    throw new LedgerValidationError([
      {
        path,
        message:
          "a revision record of contract version " +
          event.contractVersion +
          " carries no envelope reference; the key belongs to the cohort after " +
          PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS.join(", ") +
          " and this reader will not guess at it",
      },
    ]);
  }
  if (value === undefined) {
    throw new LedgerValidationError([
      {
        path,
        message:
          "a revision record of contract version " +
          event.contractVersion +
          " names its envelope by artifact reference, and this payload names none;" +
          " a reference is never derived from the envelope's digest",
      },
    ]);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerValidationError([
      {
        path,
        message:
          "an envelope reference is a non-empty string, and this payload holds " +
          (value === null ? "null" : typeof value === "string" ? "an empty string" : "a " + typeof value) +
          "; a present value that is not a reference is not an absent one",
      },
    ]);
  }
  return value;
}

/**
 * The key of one revision row, for the in-memory snapshot.
 *
 * A task id is a uuid and a revision number is a positive integer, so neither
 * can contain the separator — the same argument `executionRouteKey` makes.
 */
export function taskRevisionKey(taskId: string, revisionNumber: number): string {
  return taskId + " " + String(revisionNumber);
}

// ---------------------------------------------------------------------------
// P-14 escalón C — the task's intake and its client key (ADR 0087)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const INTAKE_TEXT_MAX = 512;
const INTAKE_WATERMARKS_MAX = 16;
const COMMIT_POLICIES: readonly string[] = ["NO_COMMIT", "LOCAL_COMMIT_WITH_RECEIPT"];

function intakeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= INTAKE_TEXT_MAX;
}

function intakeCount(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function intakeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intakeWatermarkOf(value: unknown): TaskIntakeWatermark | null {
  if (!intakeRecord(value) || undeclaredKey(value, TASK_INTAKE_WATERMARK_KEYS) !== null) return null;
  const { projectionName, sourceStream, appliedThroughSequence, eventCount, sourceHeadSha256 } = value;
  if (!intakeText(projectionName) || !intakeText(sourceStream)) return null;
  if (!intakeCount(appliedThroughSequence, 0) || !intakeCount(eventCount, 0)) return null;
  if (typeof sourceHeadSha256 !== "string" || !SHA256_HEX_PATTERN.test(sourceHeadSha256)) return null;
  return { projectionName, sourceStream, appliedThroughSequence, eventCount, sourceHeadSha256 };
}

function intakeResolutionOf(value: unknown): TaskIntakeResolution | null {
  if (!intakeRecord(value) || undeclaredKey(value, TASK_INTAKE_RESOLUTION_KEYS) !== null) return null;
  const { assignmentId, assignmentVersion, slot, modelVersionId, provider, model, release, transportKind } = value;
  if (!intakeText(assignmentId) || !intakeCount(assignmentVersion, 1) || !intakeCount(slot, 0)) return null;
  if (!intakeText(modelVersionId) || !intakeText(provider) || !intakeText(model) || !intakeText(release)) {
    return null;
  }
  if (typeof transportKind !== "string" || !(TRANSPORT_KINDS as readonly string[]).includes(transportKind)) {
    return null;
  }
  const listed = value["watermarks"];
  if (!Array.isArray(listed) || listed.length === 0 || listed.length > INTAKE_WATERMARKS_MAX) return null;
  const watermarks: TaskIntakeWatermark[] = [];
  for (const entry of listed) {
    const watermark = intakeWatermarkOf(entry);
    if (watermark === null) return null;
    watermarks.push(watermark);
  }
  return { assignmentId, assignmentVersion, slot, modelVersionId, provider, model, release, transportKind, watermarks };
}

/**
 * The closed intake payload of one `TASK_DISCOVERED`, or null (P-14 C).
 *
 * Total, for `initiativeRegistrationPayloadOf`'s reason: the stream has no
 * delete path, and a fold that refused a stored event would be disowning
 * history. The event must be a `TASK_DISCOVERED` from no state, under
 * `TASK_INTAKE_TRANSITION_ID`, whose payload carries every key of
 * `TASK_INTAKE_PAYLOAD_KEYS` in its shape and no other — or it is not an intake,
 * and it folds exactly as it did before this escalón. The intake door is the one
 * producer of this shape (L-P14C-1).
 *
 * The shape, key by key: a first revision's record with no restore; the
 * initiative as a uuid; the client key in `TASK_CLIENT_KEY_PATTERN`; the roadmap
 * link as a pair that is both present or both `null` (N-P14-8); a role of the
 * contract's vocabulary; a commit policy of the contract's two; and the
 * resolution with a non-empty vector. Whether the initiative, the version or the
 * assignment exists is the door's question, asked before the append, and never
 * the fold's.
 */
export function taskIntakePayloadOf(event: ControlPlaneEvent): TaskIntakePayload | null {
  if (event.type !== "TASK_DISCOVERED" || event.fromState !== null) return null;
  if (event.transitionId !== TASK_INTAKE_TRANSITION_ID) return null;
  const payload = event.payload;
  if (undeclaredKey(payload, TASK_INTAKE_PAYLOAD_KEYS) !== null) return null;
  for (const key of TASK_INTAKE_PAYLOAD_KEYS) {
    if (!(key in payload)) return null;
  }

  const { revisionId, revisionNumber, attemptNumber, envelopeSha256, envelopeArtifactReferenceId } = payload;
  if (!intakeText(revisionId) || !intakeCount(revisionNumber, 1) || !intakeCount(attemptNumber, 1)) return null;
  if (typeof envelopeSha256 !== "string" || !SHA256_HEX_PATTERN.test(envelopeSha256)) return null;
  if (payload["restoredFromRevisionId"] !== null) return null;
  if (!intakeText(envelopeArtifactReferenceId)) return null;

  const { initiativeId, clientScope, clientRequestKey, roadmapVersionId, stepId, role, commitPolicy } = payload;
  if (typeof initiativeId !== "string" || !UUID_PATTERN.test(initiativeId)) return null;
  if (typeof clientScope !== "string" || !TASK_CLIENT_KEY_PATTERN.test(clientScope)) return null;
  if (typeof clientRequestKey !== "string" || !TASK_CLIENT_KEY_PATTERN.test(clientRequestKey)) return null;
  if (roadmapVersionId !== null && (typeof roadmapVersionId !== "string" || !UUID_PATTERN.test(roadmapVersionId))) {
    return null;
  }
  if (stepId !== null && (typeof stepId !== "string" || !LOCAL_KEY_PATTERN.test(stepId))) return null;
  if ((roadmapVersionId === null) !== (stepId === null)) return null;
  if (typeof role !== "string" || !(WORKER_ROLES as readonly string[]).includes(role)) return null;
  if (typeof commitPolicy !== "string" || !COMMIT_POLICIES.includes(commitPolicy)) return null;

  const resolution = intakeResolutionOf(payload["resolution"]);
  if (resolution === null) return null;

  return {
    revisionId,
    revisionNumber,
    attemptNumber,
    envelopeSha256,
    envelopeArtifactReferenceId,
    initiativeId,
    clientScope,
    clientRequestKey,
    roadmapVersionId,
    stepId,
    role,
    commitPolicy,
    resolution,
  };
}

/**
 * The client key row one event folds, if it is an intake (P-14 C).
 *
 * The task, the revision number and the envelope digest are read from the SAME
 * revision record `nextTaskRevisionProjection` folds, not from a second reading
 * of the payload, so the key row and the revision row cannot come to name two
 * envelopes. The row's task is the EVENT's: a payload cannot claim another
 * task's key.
 */
export function nextTaskSubmissionProjection(
  event: ControlPlaneEvent,
  sequence: number,
): TaskSubmissionReadModel | null {
  const intake = taskIntakePayloadOf(event);
  if (intake === null) return null;
  const revision = nextTaskRevisionProjection(event, sequence);
  if (revision === null) return null;
  return {
    clientScope: intake.clientScope,
    clientRequestKey: intake.clientRequestKey,
    taskId: event.taskId,
    revisionNumber: revision.revisionNumber,
    envelopeSha256: revision.envelopeSha256,
    sequence,
    createdAt: event.occurredAt,
  };
}

/** The key of one submission row, for the in-memory snapshot. Neither half contains a space. */
export function taskSubmissionKey(clientScope: string, clientRequestKey: string): string {
  return clientScope + " " + clientRequestKey;
}

/**
 * The comparable form of a submission row: what the key produced.
 *
 * `sequence` and `createdAt` are the birth attributes and stay out, for
 * `canonicalRevision`'s reason: a replay of the same request arrives at another
 * position and names the same task, the same revision and the same envelope.
 */
function canonicalTaskSubmission(submission: TaskSubmissionReadModel): string {
  return canonicalJsonStringify({
    clientScope: submission.clientScope,
    clientRequestKey: submission.clientRequestKey,
    taskId: submission.taskId,
    revisionNumber: submission.revisionNumber,
    envelopeSha256: submission.envelopeSha256,
  });
}

/**
 * Refuse a second row under one client key that names anything else (P-14 C).
 *
 * One function for the append door and for `applyEventToSnapshot`, so the
 * incremental path and a rebuild refuse the same histories. The refusal is
 * `LedgerIdempotencyConflictError`, by name and never a constraint failure: the
 * client key IS the request link's idempotency key (contracts §15), and a door
 * that lost a race to it reads the class and decides again. The message carries
 * the key and two digests of the comparable rows, never the rows.
 */
export function assertSameTaskSubmission(stored: TaskSubmissionReadModel, arriving: TaskSubmissionReadModel): void {
  const storedForm = canonicalTaskSubmission(stored);
  const arrivingForm = canonicalTaskSubmission(arriving);
  if (storedForm === arrivingForm) return;
  throw new LedgerIdempotencyConflictError(
    "client request " + taskSubmissionKey(stored.clientScope, stored.clientRequestKey),
    sha256Hex(storedForm),
    sha256Hex(arrivingForm),
  );
}

/**
 * The attempt number a revision record announces, for `task_read_model`.
 *
 * Read from the same payload as the revision itself rather than stored on the
 * revision row: `task_revision_read_model` is about revisions, and the attempt
 * belongs to `task_attempt_read_model`, which is P-18's. This is the one place
 * B needs the value, and it reads it where it lands.
 */
export function revisionAttemptNumber(event: ControlPlaneEvent): number | null {
  return payloadCount(event.payload, ATTEMPT_NUMBER_KEY);
}

/**
 * The attempt one event opens, if it is an opening that carries one (P-18/B).
 *
 * Modelled on `nextTaskRevisionProjection`, with one deliberate difference: it
 * keys off the **type** rather than off the presence of a key set. The revision
 * fold cannot key off a type because no type announces a revision (ADR 0067,
 * and the adjudication that migration 11 adds none). This one has a type of its
 * own, and using it is the honest reading — `invocationId` and
 * `legacyAttemptNumber` are facts only the opening arrival may state, so a fold
 * that accepted them from any event carrying the keys would let a later event
 * of the same coordinate restate, and therefore contradict, the identity the
 * compare-and-set assigned.
 *
 * The same allocation of duties as every fold in this file. **At the producer
 * and at the append door**, an opening whose payload is incomplete must never be
 * appended — the door refuses it by name, with the coordinate and the key at
 * fault. **Here**, an incomplete payload projects no row while the event still
 * stands, because the event tables have no delete path and replay has to remain
 * total. Refusing at replay would let a projection disown an event the log
 * accepted.
 *
 * Every field comes from the EVENT or from the payload's own facts, and never
 * from a clock: the coordinate's task is the event's `taskId`, so a payload
 * cannot open another task's attempt, and `startedAt` is the event's
 * `occurredAt`. `endedAt` and `outcome` are `null` because this escalón writes
 * no closer at all (ADR 0073).
 */
export function nextTaskAttemptProjection(
  event: ControlPlaneEvent,
  sequence: number,
): TaskAttemptReadModel | null {
  if (event.type !== TASK_ATTEMPT_OPENED) return null;

  const payload = event.payload;
  const revisionNumber = payloadCount(payload, REVISION_NUMBER_KEY);
  const attemptNumber = payloadCount(payload, ATTEMPT_NUMBER_KEY);
  const legacyAttemptNumber = payloadCount(payload, LEGACY_ATTEMPT_NUMBER_KEY);
  const invocationId = payloadText(payload, INVOCATION_ID_KEY);

  if (
    revisionNumber === null ||
    attemptNumber === null ||
    legacyAttemptNumber === null ||
    invocationId === null
  ) {
    return null;
  }

  return {
    taskId: event.taskId,
    revisionNumber,
    attemptNumber,
    legacyAttemptNumber,
    invocationId,
    startedAt: event.occurredAt,
    endedAt: null,
    outcome: null,
    sequence,
  };
}

/**
 * The key of one attempt row, for the in-memory snapshot.
 *
 * A task id is a uuid and the two numbers are positive integers, so none of the
 * three can contain the separator — the same argument `taskRevisionKey` makes.
 */
export function taskAttemptKey(
  taskId: string,
  revisionNumber: number,
  attemptNumber: number,
): string {
  return taskId + " " + String(revisionNumber) + " " + String(attemptNumber);
}

/**
 * The comparable form of an attempt row: what the attempt *is*.
 *
 * Two fields, by the argument `canonicalRevision` makes about three. The
 * coordinate is the key both callers look the row up by, so it cannot differ
 * across a comparison. `sequence` and `startedAt` are birth attributes — they
 * record the arrival that announced the attempt, and an exact replay landing at
 * a later position with its own instant is the SAME attempt. What is left is the
 * identity the compare-and-set assigned: `legacyAttemptNumber` and
 * `invocationId`. Those two are the refusal that matters — a second arrival at
 * one coordinate naming a different invocation is two answers to "which run was
 * this", which is execution §3's `:122` in one sentence.
 *
 * `endedAt` and `outcome` are deliberately **outside** the comparison, and that
 * is a statement about this escalón rather than about the model: no fold here
 * produces either, so including them would pin a shape no arrival can vary. The
 * escalón that adds the closer decides whether a second ending is a replay or a
 * conflict, and it is the one that should decide it.
 *
 * Exported for `canonicalRevision`'s reason: the incremental door and the
 * snapshot must decide "same attempt" identically, or a rebuild would refuse a
 * history the door accepted and `verifyIntegrity` would compare the stored
 * projection against a different rule.
 */
export function canonicalAttempt(attempt: TaskAttemptReadModel): string {
  return [String(attempt.legacyAttemptNumber), attempt.invocationId].join("\u0000");
}

/**
 * The two uniqueness claims an attempt row makes, beside its coordinate.
 *
 * One per unique index on the table — `ux_task_attempt_read_model__invocation_id`
 * and `ux_task_attempt_read_model__task_id_legacy_attempt_number`. The snapshot
 * holds them so a **rebuild** refuses the histories the base would refuse: a
 * replay that inserted two coordinates sharing an invocation, or sharing a flat
 * assignment within one task, would otherwise reach SQLite and come back as a
 * constraint failure naming one row and no coordinate — several layers from the
 * event that caused it.
 *
 * Namespaced rather than kept in two maps, so the snapshot carries one index
 * and the refusal can say which claim collided. The separator is a space rather
 * than the NUL `watermarkKey` uses, because these strings reach a message an
 * operator reads: an invocation id, a task id and an integer contain no space,
 * so the argument `taskAttemptKey` makes about collisions holds either way, and
 * only one of the two prints.
 */
function attemptClaims(attempt: TaskAttemptReadModel): readonly string[] {
  return [
    "invocation " + attempt.invocationId,
    "legacy " + attempt.taskId + " " + String(attempt.legacyAttemptNumber),
  ];
}

// ---------------------------------------------------------------------------
// P-18/protocolo C — the segment, the effect and its deliveries.
// ---------------------------------------------------------------------------

/** The nested record an event carries under one of the four keys, or null. */
function payloadRecord(
  payload: ControlPlaneEvent["payload"],
  key: string,
): Record<string, unknown> | null {
  const value = payload[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A non-empty string field of a nested record, or null. */
function recordText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A safe integer field of a nested record at or above a floor, or null. */
function recordCount(record: Record<string, unknown>, key: string, floor: number): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= floor ? value : null;
}

/** A member of a closed vocabulary, or null. Ordinal comparison, never a cast. */
function recordWord<T extends string>(
  record: Record<string, unknown>,
  key: string,
  vocabulary: readonly T[],
): T | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  return (vocabulary as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * The preimage of `effect_id`, version 1 — execution §6 `:238`, ADR 0076.
 *
 * The quintuple in its dictionary order, under a version prefix that carries
 * its own trailing LF. `envelopeIdentityPreimageV1` is the shape being
 * followed, and the split between the two packages is the same one: the rule is
 * `@acp/contracts`' because a key's grammar is the contract's, and the
 * computation is here because this package already owns exactly one
 * canonicalizer and exactly one sha-256.
 *
 * Nothing resolved at dispatch time enters it, and neither does a clock. A
 * replay and a handoff reproduce these bytes exactly, which is the property the
 * whole lookup depends on.
 */
export function effectIdPreimageV1(coordinate: {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly segmentNumber: number;
  readonly operationOrdinal: number;
}): string {
  return (
    EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1 +
    canonicalJsonStringify([
      coordinate.taskId,
      coordinate.revisionNumber,
      coordinate.attemptNumber,
      coordinate.segmentNumber,
      coordinate.operationOrdinal,
    ])
  );
}

/** The digest of the preimage above. Two steps, so a vector can pin each. */
export function effectIdV1(coordinate: Parameters<typeof effectIdPreimageV1>[0]): string {
  return sha256Hex(effectIdPreimageV1(coordinate));
}

/**
 * The preimage of the effect's idempotency key, version 1 — §6 `:250`.
 *
 * The kind of operation, the same quintuple, and the envelope digest of the
 * revision the work was asked for under. The envelope digest is **not** taken
 * from the event: it is read off `task_revision_read_model`, so the key is
 * bound to the revision this ledger recorded rather than to a claim the
 * producer made about it.
 */
export function effectIdempotencyPreimageV1(input: {
  readonly effectKind: string;
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly segmentNumber: number;
  readonly operationOrdinal: number;
  readonly envelopeSha256: string;
}): string {
  return (
    EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1 +
    canonicalJsonStringify([
      input.effectKind,
      input.taskId,
      input.revisionNumber,
      input.attemptNumber,
      input.segmentNumber,
      input.operationOrdinal,
      input.envelopeSha256,
    ])
  );
}

/** The digest of the preimage above. */
export function effectIdempotencyKeyV1(
  input: Parameters<typeof effectIdempotencyPreimageV1>[0],
): string {
  return sha256Hex(effectIdempotencyPreimageV1(input));
}

/**
 * The logical operation digest — execution §6.1 `:284-286`, verbatim.
 *
 * Unlike the two above, this preimage is **given by the specification** in its
 * exact form: a canonical JSON array whose first two members are a literal tag
 * and a literal `1`. It carries no prefix constant because the tag inside the
 * array is already the versioned discriminator the dictionary chose, and
 * inventing a second one would be a second encoding of a formula that is
 * already written down.
 *
 * `invocationId` is read off `task_attempt_read_model`, never off the event:
 * that is what makes this a digest "of the run" rather than of what a producer
 * said the run was.
 */
export function logicalOperationSha256(input: {
  readonly invocationId: string;
  readonly semanticScopeKey: string;
  readonly localOperationKey: string;
}): string {
  return sha256Hex(
    canonicalJsonStringify([
      "execution-logical-operation",
      1,
      input.invocationId,
      input.semanticScopeKey,
      input.localOperationKey,
    ]),
  );
}

/**
 * The request consistency digest — execution §6.1 `:287-290`, verbatim.
 *
 * `neutralRequest` is the business payload of the operation, and it does not
 * enter a ledger event: §6.1 `:296` forbids prompt bytes in the event outright.
 * So this digest is **recorded** by the producer and conserved by the fold,
 * unlike the three above, which are recomputed and refused on disagreement. The
 * asymmetry is declared rather than hidden (ADR 0076): a digest whose preimage
 * the ledger cannot see is a digest the ledger cannot verify, and saying so is
 * better than a check that only appears to be one.
 *
 * Exported so a producer — and the suite — computes it the one way, and so the
 * neutrality rule of §6.1 `:293-296` is testable: the same request under two
 * segments or two accounts produces the same digest, because nothing resolved
 * at dispatch time is a member.
 */
export function requestSha256(input: {
  readonly effectKind: string;
  readonly requestContractVersion: string;
  readonly envelopeSha256: string;
  readonly neutralRequest: unknown;
}): string {
  return sha256Hex(
    canonicalJsonStringify([
      "execution-logical-request",
      1,
      input.effectKind,
      input.requestContractVersion,
      input.envelopeSha256,
      input.neutralRequest,
    ]),
  );
}

/**
 * The route segment one event announces, if its payload carries one (§4).
 *
 * Gated on the **two intention types**, and then on a well-formed record under
 * `segment`. The type gate is `nextTaskAttemptProjection`'s rather than the
 * revision's, and for its argument: a segment states facts only the arrival
 * that opens it is entitled to state — which provider, which alias, how far the
 * model version could be resolved — so a fold keyed off presence alone would
 * let any later event carrying the key restate, and so contradict, them. It
 * also keeps a stray event from announcing a segment whose foreign key nothing
 * in this build satisfies.
 *
 * Within that gate the shape rule is the revision's: an absent, malformed or
 * incomplete record projects no row while the event still stands, because
 * replay has to remain total. The append door is what refuses it by name,
 * before it can ever be stored.
 *
 * The coordinate's task is the EVENT's `taskId` and the revision and attempt
 * are the V2 coordinate's own top-level keys, so a payload cannot announce a
 * segment of another task's attempt. `recordedAt` is the event's, never a clock.
 *
 * The two pairing rules of §4 are enforced here as well as by the base, because
 * a rebuild has no door in front of it: a predecessor without a reason, or a
 * `RESOLVED` without a version, produces no row rather than a row the base
 * would then abort on with a constraint nobody can attribute to an event.
 */
export function nextExecutionRouteSegmentProjection(
  event: ControlPlaneEvent,
  sequence: number,
): ExecutionRouteSegmentReadModel | null {
  if (event.type !== EFFECT_INTENDED && event.type !== DISPATCH_INTENDED) return null;

  const record = payloadRecord(event.payload, SEGMENT_KEY);
  if (record === null) return null;

  const routeSegmentId = recordText(record, "routeSegmentId");
  const revisionNumber = payloadCount(event.payload, REVISION_NUMBER_KEY);
  const attemptNumber = payloadCount(event.payload, ATTEMPT_NUMBER_KEY);
  const segmentNumber = recordCount(record, "segmentNumber", 1);
  const provider = recordText(record, "provider");
  const model = recordText(record, "model");
  const modelResolutionStatus = recordWord(
    record,
    "modelResolutionStatus",
    MODEL_RESOLUTION_STATUSES,
  );
  const transportKind = recordText(record, "transportKind");
  const capabilityPolicyVersion = recordText(record, "capabilityPolicyVersion");

  if (
    routeSegmentId === null ||
    revisionNumber === null ||
    attemptNumber === null ||
    segmentNumber === null ||
    provider === null ||
    model === null ||
    modelResolutionStatus === null ||
    transportKind === null ||
    capabilityPolicyVersion === null
  ) {
    return null;
  }

  const predecessorSegmentId = recordText(record, "predecessorSegmentId");
  const handoffReason = recordText(record, "handoffReason");
  if ((predecessorSegmentId === null) !== (handoffReason === null)) return null;

  const modelVersionId = recordText(record, "modelVersionId");
  if ((modelResolutionStatus === "RESOLVED") !== (modelVersionId !== null)) return null;

  const escalatedFromAttempt = recordCount(record, "escalatedFromAttempt", 1);
  const escalationReason = recordText(record, "escalationReason");
  if ((escalatedFromAttempt === null) !== (escalationReason === null)) return null;

  return {
    routeSegmentId,
    taskId: event.taskId,
    revisionNumber,
    attemptNumber,
    segmentNumber,
    predecessorSegmentId,
    handoffReason,
    provider,
    model,
    modelResolutionStatus,
    modelVersionId,
    accountId: recordText(record, "accountId"),
    transportKind,
    capabilityPolicyVersion,
    routingAssignmentId: recordText(record, "routingAssignmentId"),
    reservationId: recordText(record, "reservationId"),
    escalatedFromAttempt,
    escalationReason,
    resolvedAt: recordText(record, "resolvedAt"),
    recordedAt: event.recordedAt,
    sequence,
  };
}

/**
 * The effect one event intends, if it is an intention that carries one (§6).
 *
 * Keys off the **type**, for `nextTaskAttemptProjection`'s reason: the digests
 * and the ordinal are facts only the arrival that opens the effect may state,
 * and a fold keyed off the presence of keys would let a later event of the same
 * coordinate restate — and therefore contradict — an identity that is supposed
 * to be assigned once.
 *
 * `intendedAt` is the event's `occurredAt`: the instant the `BEGIN IMMEDIATE`
 * that recorded the intention happened, which §6 `:251` asks for and which is
 * deliberately **not** a member of any preimage on this row.
 *
 * `outcomeStatus` and `outcomeRecordedAt` are born `null` — absence of data,
 * never `OUTCOME_UNKNOWN` (N-P18-6). Only `DISPATCH_OUTCOME_RECORDED` writes
 * them, and only when an outcome actually happened.
 */
export function nextEffectProjection(
  event: ControlPlaneEvent,
  sequence: number,
): EffectReadModel | null {
  if (event.type !== EFFECT_INTENDED) return null;

  const record = payloadRecord(event.payload, EFFECT_KEY);
  if (record === null) return null;

  const revisionNumber = payloadCount(event.payload, REVISION_NUMBER_KEY);
  const attemptNumber = payloadCount(event.payload, ATTEMPT_NUMBER_KEY);
  const segment = nextExecutionRouteSegmentProjection(event, sequence);

  const effectId = recordText(record, "effectId");
  const operationOrdinal = recordCount(record, "operationOrdinal", 0);
  const effectKind = recordText(record, "effectKind");
  const semanticScopeKey = recordText(record, "semanticScopeKey");
  const localOperationKey = recordText(record, "localOperationKey");
  const logicalSha = recordText(record, "logicalOperationSha256");
  const requestContractVersion = recordText(record, "requestContractVersion");
  const requestDigest = recordText(record, "requestSha256");
  const idempotencyKey = recordText(record, "idempotencyKey");

  if (
    revisionNumber === null ||
    attemptNumber === null ||
    segment === null ||
    effectId === null ||
    operationOrdinal === null ||
    effectKind === null ||
    semanticScopeKey === null ||
    localOperationKey === null ||
    logicalSha === null ||
    requestContractVersion === null ||
    requestDigest === null ||
    idempotencyKey === null
  ) {
    return null;
  }

  return {
    effectId,
    taskId: event.taskId,
    revisionNumber,
    attemptNumber,
    // The **initial** segment, and the one the effect keeps for ever. The same
    // event announced it, which is what satisfies
    // `fk_effect_read_model__execution_route_segment_read_model` by
    // construction rather than by assuming the parent is already there.
    routeSegmentId: segment.routeSegmentId,
    operationOrdinal,
    effectKind,
    semanticScopeKey,
    localOperationKey,
    logicalOperationSha256: logicalSha,
    requestContractVersion,
    requestSha256: requestDigest,
    idempotencyKey,
    intendedAt: event.occurredAt,
    outcomeStatus: null,
    outcomeRecordedAt: null,
    outcomeContractVersion: null,
    resultArtifactReferenceId: null,
    resultSha256: null,
    sequence,
  };
}

/**
 * The delivery one event intends, if it is an intention that carries one (§7).
 *
 * Born `INTENDED`, with `terminalAt` null and the three externally sourced
 * fields null: recording that a delivery is about to happen is an append, and
 * an append is not a dispatch (datos §11 `:566`).
 *
 * `routeSegmentId` is read off the segment record this same event carries — the
 * **effective** segment of this delivery, which after a handoff is a segment
 * nothing has seen before. It is deliberately not copied from the effect: §7
 * `:356` says the fold must not demand equality with the effect's initial
 * segment, and copying it would make a handoff invisible in the row that is
 * supposed to record one.
 */
export function nextDispatchAttemptProjection(
  event: ControlPlaneEvent,
  sequence: number,
): DispatchAttemptReadModel | null {
  if (event.type !== DISPATCH_INTENDED) return null;

  const record = payloadRecord(event.payload, DISPATCH_KEY);
  if (record === null) return null;

  const segment = nextExecutionRouteSegmentProjection(event, sequence);
  const dispatchAttemptId = recordText(record, "dispatchAttemptId");
  const effectId = recordText(record, "effectId");
  const attemptOrdinal = recordCount(record, "attemptOrdinal", 1);

  if (
    segment === null ||
    dispatchAttemptId === null ||
    effectId === null ||
    attemptOrdinal === null
  ) {
    return null;
  }

  return {
    dispatchAttemptId,
    effectId,
    routeSegmentId: segment.routeSegmentId,
    attemptOrdinal,
    providerIdempotencyKey: null,
    externalHandle: null,
    dispatchState: "INTENDED",
    requestedAt: event.occurredAt,
    acceptedAt: null,
    terminalAt: null,
    recordedAt: event.recordedAt,
    sequence,
  };
}

/**
 * The three optional text fields of a resolution, in the order they are read.
 *
 * `effectOutcomeStatus` is the fourth optional field and is read apart, against
 * its vocabulary rather than as text.
 */
const OUTCOME_OPTIONAL_TEXT_KEYS = ["acceptedAt", "externalHandle", "providerIdempotencyKey"] as const;

/**
 * What a present value is, for a refusal that must not echo it.
 *
 * A string is shown through `printable`, so an operator reads a word the event
 * chose only when it is shaped like one; anything else is named by its kind and
 * never printed.
 */
function shownValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length === 0 ? "an empty string" : '"' + printable(value) + '"';
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : "a " + typeof value;
}

/**
 * The resolution one event records, if it is one that carries a record — or the
 * optional field that stops it being one.
 *
 * `null` for any other type, and for a payload that does not constitute a
 * resolution at all: no record, no delivery, no state of the five, or a terminal
 * pair that disagrees. The append door refuses those with its own message; the
 * fold projects nothing for them.
 *
 * **Present-invalid is not absent** (CORR-2, ADR 0079). Each of the four
 * optional fields is read three ways: the key absent is the event saying
 * nothing, a lawful value is the value, and anything else the event carries under
 * the key — a word outside the vocabulary, a number, an object, an empty string,
 * or an explicit JSON `null` — is a refusal naming the field. Before this, the
 * third case collapsed into the first, so `effectOutcomeStatus: "INVALID_STATUS"`
 * was stored in the event and projected as no outcome at all, and a later
 * resolution could then record one: the outcome that is recorded once became
 * one that could be recorded twice. The door and the fold both read through
 * this function, so both refuse with these words.
 */
export function dispatchOutcomeRecord(
  event: ControlPlaneEvent,
  sequence: number,
): DispatchOutcomeReading | null {
  if (event.type !== DISPATCH_OUTCOME_RECORDED) return null;

  const record = payloadRecord(event.payload, OUTCOME_KEY);
  if (record === null) return null;

  const dispatchAttemptId = recordText(record, "dispatchAttemptId");
  const dispatchState = recordWord(record, "dispatchState", DISPATCH_STATES);
  if (dispatchAttemptId === null || dispatchState === null) return null;

  // The terminal pair, held here as well as by the base: a rebuild has no door
  // in front of it, and a row the base would abort on has to be refused at the
  // event that caused it rather than as a constraint naming one row.
  const terminalAt = recordText(record, "terminalAt");
  const terminal = dispatchState === "SETTLED" || dispatchState === "ABANDONED";
  if (terminal !== (terminalAt !== null)) return null;

  for (const key of OUTCOME_OPTIONAL_TEXT_KEYS) {
    if (record[key] !== undefined && recordText(record, key) === null) {
      return {
        kind: "refused",
        path: "payload." + OUTCOME_KEY + "." + key,
        message:
          key +
          ", when present, is non-empty text; this event says " +
          shownValue(record[key]) +
          ", and a value that is not one is refused rather than read as absent",
      };
    }
  }

  const effectOutcomeStatus = recordWord(record, "effectOutcomeStatus", EFFECT_OUTCOME_STATUSES);
  if (record["effectOutcomeStatus"] !== undefined && effectOutcomeStatus === null) {
    return {
      kind: "refused",
      path: "payload." + OUTCOME_KEY + ".effectOutcomeStatus",
      message:
        "effectOutcomeStatus, when present, is one of " +
        EFFECT_OUTCOME_STATUSES.join(", ") +
        "; this event says " +
        shownValue(record["effectOutcomeStatus"]) +
        ", and a word the vocabulary does not hold is refused rather than read as no outcome",
    };
  }

  const result = resultPairReading(record, effectOutcomeStatus, event.contractVersion);
  if (result.kind === "refused") return result;

  return {
    kind: "record",
    record: {
      dispatchAttemptId,
      dispatchState,
      terminalAt,
      acceptedAt: recordText(record, "acceptedAt"),
      externalHandle: recordText(record, "externalHandle"),
      providerIdempotencyKey: recordText(record, "providerIdempotencyKey"),
      effectOutcomeStatus,
      resultArtifactReferenceId: result.referenceId,
      resultSha256: result.sha256,
      recordedAt: event.occurredAt,
      sequence,
    },
  };
}

/**
 * The result pair of one resolution, read present-invalid (P-07 escalón B,
 * ADR 0098; decision 56's rule for the two new keys).
 *
 * In order, each refusal at its own path and never echoing the value:
 *
 * 1. a key present with a value that is not non-empty text — or, for the digest,
 *    not 64 lowercase hex — is refused rather than read as absent;
 * 2. half a pair is refused at the key that is missing;
 * 3. a pair with no outcome status is refused: a result is recorded with the
 *    effect's outcome, in the same event;
 * 4. a pair on `CANCELLED` or `OUTCOME_UNKNOWN` is refused by name: a result
 *    exists only for the two statuses the result contract names (contracts §4.2);
 * 5. a pair on a version of the cohort before is refused: no build of that
 *    contract produced one;
 * 6. a `SUCCEEDED` of a later version without a pair is refused by name.
 *
 * `FAILED` is admitted with a pair or without one.
 */
function resultPairReading(
  record: Record<string, unknown>,
  effectOutcomeStatus: EffectOutcomeStatus | null,
  contractVersion: string,
):
  | { readonly kind: "pair"; readonly referenceId: string | null; readonly sha256: string | null }
  | { readonly kind: "refused"; readonly path: string; readonly message: string } {
  const at = (key: string): string => "payload." + OUTCOME_KEY + "." + key;
  const rawReference = record[RESULT_ARTIFACT_REFERENCE_KEY];
  const rawSha256 = record[RESULT_SHA256_KEY];
  const referenceId = recordText(record, RESULT_ARTIFACT_REFERENCE_KEY);
  if (rawReference !== undefined && referenceId === null) {
    return {
      kind: "refused",
      path: at(RESULT_ARTIFACT_REFERENCE_KEY),
      message:
        RESULT_ARTIFACT_REFERENCE_KEY +
        ", when present, is non-empty text; this event says " +
        shownValue(rawReference) +
        ", and a value that is not one is refused rather than read as absent",
    };
  }
  const sha256 = typeof rawSha256 === "string" && SHA256_HEX_PATTERN.test(rawSha256) ? rawSha256 : null;
  if (rawSha256 !== undefined && sha256 === null) {
    return {
      kind: "refused",
      path: at(RESULT_SHA256_KEY),
      message:
        RESULT_SHA256_KEY +
        ", when present, is 64 lowercase hex characters; this event says " +
        (typeof rawSha256 === "string" && rawSha256.length > 0 ? "text of another shape" : shownValue(rawSha256)) +
        ", and a value that is not one is refused rather than read as absent",
    };
  }
  if ((referenceId === null) !== (sha256 === null)) {
    const missing = referenceId === null ? RESULT_ARTIFACT_REFERENCE_KEY : RESULT_SHA256_KEY;
    return {
      kind: "refused",
      path: at(missing),
      message:
        "a result is named by its artifact reference and its digest together, and this event carries one without the other",
    };
  }
  const paired = referenceId !== null;
  if (paired && effectOutcomeStatus === null) {
    return {
      kind: "refused",
      path: at(RESULT_ARTIFACT_REFERENCE_KEY),
      message: "a result is recorded with the effect's outcome, and this event names a result and no outcome",
    };
  }
  if (paired && effectOutcomeStatus !== null && !(RESULT_STATUSES as readonly string[]).includes(effectOutcomeStatus)) {
    return {
      kind: "refused",
      path: at(RESULT_ARTIFACT_REFERENCE_KEY),
      message:
        "effect outcome " +
        effectOutcomeStatus +
        " carries no result; a result is recorded with " +
        RESULT_STATUSES.join(" or ") +
        " (contracts §4.2, §10)",
    };
  }
  const priorCohort = PRE_RESULT_REFERENCE_CONTRACT_VERSIONS.includes(contractVersion);
  if (paired && priorCohort) {
    return {
      kind: "refused",
      path: at(RESULT_ARTIFACT_REFERENCE_KEY),
      message:
        "an outcome of contract version " +
        contractVersion +
        " names no result, because no build of that contract recorded one (migration 22)",
    };
  }
  if (!paired && effectOutcomeStatus === "SUCCEEDED" && !priorCohort) {
    return {
      kind: "refused",
      path: at(RESULT_ARTIFACT_REFERENCE_KEY),
      message:
        "a SUCCEEDED outcome of contract version " +
        contractVersion +
        " names its result by artifact reference and digest (contracts §4.2), and this payload names none",
    };
  }
  return { kind: "pair", referenceId, sha256 };
}

/**
 * What an arriving outcome is to the effect row it names: the one comparison the
 * append door and the fold both ask (P-07 escalón B, ADR 0098; ADR 0084 Five).
 *
 * The pair is compared with the status, so the same status under another digest
 * or another reference is a conflict, not a replay. A row of the cohort before,
 * holding no pair, meeting an arrival with one is refused too: C2 of the P-07
 * adjudication decides every combination that is not identical as a conflict. An
 * outcome is recorded once, and a second answer to the same question is neither
 * written nor silently dropped.
 */
export function effectOutcomeArrival(
  stored: EffectReadModel,
  arriving: DispatchOutcomeRecord,
): EffectOutcomeArrival {
  const ended = stored.outcomeStatus;
  if (ended === null) return { kind: "write" };
  const refused = (key: string, what: string): EffectOutcomeArrival => ({
    kind: "refused",
    path: "payload." + OUTCOME_KEY + "." + key,
    message:
      "effect " +
      stored.effectId +
      " already ended " +
      ended +
      what +
      ", and an outcome is recorded once rather than amended; this event says " +
      String(arriving.effectOutcomeStatus),
  });
  if (ended !== arriving.effectOutcomeStatus) return refused("effectOutcomeStatus", "");
  if (stored.resultArtifactReferenceId !== arriving.resultArtifactReferenceId) {
    return refused(RESULT_ARTIFACT_REFERENCE_KEY, " under another result reference");
  }
  if (stored.resultSha256 !== arriving.resultSha256) return refused(RESULT_SHA256_KEY, " under another result digest");
  return { kind: "replay" };
}

/**
 * One delivery after a resolution has been applied to it.
 *
 * A reduce rather than an insert, which makes it the first fold in this file
 * that is neither an upsert of a whole row nor insert-only. The three
 * externally sourced fields are **sticky**: a handle once recorded is not
 * unrecorded by a later move that does not mention it, because forgetting an
 * external handle is losing the only thing reconciliation can be done by.
 */
export function nextDispatchAttemptState(
  current: DispatchAttemptReadModel,
  outcome: DispatchOutcomeRecord,
): DispatchAttemptReadModel {
  return {
    ...current,
    dispatchState: outcome.dispatchState,
    terminalAt: outcome.terminalAt,
    acceptedAt: outcome.acceptedAt ?? current.acceptedAt,
    externalHandle: outcome.externalHandle ?? current.externalHandle,
    providerIdempotencyKey: outcome.providerIdempotencyKey ?? current.providerIdempotencyKey,
  };
}

/**
 * Whether a delivery may move from one state to another (§7's five states).
 *
 * Forward only, and the two terminals move nowhere. A repetition of the state a
 * row already holds is **not** admitted here: it is handled a rung up as a
 * replay, so that this predicate answers exactly one question.
 */
export function dispatchTransitionAdmitted(from: DispatchState, to: DispatchState): boolean {
  return DISPATCH_STATE_TRANSITIONS[from].includes(to);
}

/**
 * The two uniqueness claims a segment row makes, beside its primary key.
 *
 * One, in fact — `ux_execution_route_segment_read_model__attempt_segment` — but
 * the shape is `attemptClaims`' because the argument is: the snapshot holds the
 * base's unique indexes in memory so a **rebuild** refuses the histories the
 * base would refuse, at the event that caused them.
 */
function segmentClaims(segment: ExecutionRouteSegmentReadModel): readonly string[] {
  return [
    "segment " +
      segment.taskId +
      " " +
      String(segment.revisionNumber) +
      " " +
      String(segment.attemptNumber) +
      " " +
      String(segment.segmentNumber),
  ];
}

/** The effect table's two unique indexes, in memory. */
function effectClaims(effect: EffectReadModel): readonly string[] {
  return [
    "logical operation " + effect.logicalOperationSha256,
    "idempotency key " + effect.idempotencyKey,
  ];
}

/** The delivery table's one unique index, in memory. */
function dispatchClaims(dispatch: DispatchAttemptReadModel): readonly string[] {
  return ["delivery " + dispatch.effectId + " " + String(dispatch.attemptOrdinal)];
}

/**
 * The comparable form of an effect row: what the effect *is*.
 *
 * Everything except the two birth attributes — `sequence` and `intendedAt` —
 * and except the outcome pair, which no arrival of `EFFECT_INTENDED` may vary
 * because every one of them writes `null`. `canonicalRevision`'s argument
 * generalizes: an exact replay landing at a later position with its own instant
 * is the SAME effect, and refusing it for the position alone would turn an
 * idempotent retry into a conflict.
 */
export function canonicalEffect(effect: EffectReadModel): string {
  return [
    effect.taskId,
    String(effect.revisionNumber),
    String(effect.attemptNumber),
    effect.routeSegmentId,
    String(effect.operationOrdinal),
    effect.effectKind,
    effect.semanticScopeKey,
    effect.localOperationKey,
    effect.logicalOperationSha256,
    effect.requestContractVersion,
    effect.requestSha256,
    effect.idempotencyKey,
  ].join(" ");
}

/**
 * The comparable form of a segment row, on `canonicalEffect`'s terms.
 *
 * Everything the segment *is*, and neither of the two birth attributes:
 * `recordedAt` and `sequence` record the arrival that announced the segment
 * rather than the segment, so an exact replay landing at a later position is
 * the SAME segment. Spelled out field by field rather than produced by deleting
 * two keys, because a field added to the row later should have to be classified
 * here rather than swept into the comparison by default.
 */
export function canonicalSegment(segment: ExecutionRouteSegmentReadModel): string {
  return canonicalJsonStringify({
    routeSegmentId: segment.routeSegmentId,
    taskId: segment.taskId,
    revisionNumber: segment.revisionNumber,
    attemptNumber: segment.attemptNumber,
    segmentNumber: segment.segmentNumber,
    predecessorSegmentId: segment.predecessorSegmentId,
    handoffReason: segment.handoffReason,
    provider: segment.provider,
    model: segment.model,
    modelResolutionStatus: segment.modelResolutionStatus,
    modelVersionId: segment.modelVersionId,
    accountId: segment.accountId,
    transportKind: segment.transportKind,
    capabilityPolicyVersion: segment.capabilityPolicyVersion,
    routingAssignmentId: segment.routingAssignmentId,
    reservationId: segment.reservationId,
    escalatedFromAttempt: segment.escalatedFromAttempt,
    escalationReason: segment.escalationReason,
    resolvedAt: segment.resolvedAt,
  });
}

/**
 * The comparable form of a delivery's **birth**, on `canonicalEffect`'s terms.
 *
 * Only the fields an intention states. The state, the instants and the three
 * externally sourced fields are outside, because a resolution event is supposed
 * to move them: comparing them here would make every second arrival at one
 * delivery a conflict, which is the opposite of what this table is for.
 */
export function canonicalDispatchBirth(dispatch: DispatchAttemptReadModel): string {
  return [
    dispatch.effectId,
    dispatch.routeSegmentId,
    String(dispatch.attemptOrdinal),
    dispatch.requestedAt,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// P-18/protocolo D — the prompt a delivery sent, and the answer it received.
// ---------------------------------------------------------------------------

/** A lowercase sha-256 hex digest, the shape every digest in this schema has. */
const OCCURRENCE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A payload key or row identifier, safe to print in a refusal.
 *
 * The ledger's `safeRowIdentifier`, restated rather than imported because the
 * dependency runs the other way: the ledger imports this module. A key a
 * payload chose is operator-facing text and nothing guarantees its shape.
 */
function printable(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "<unprintable identifier>";
}

function refused<T>(path: string, message: string): OccurrenceReading<T> {
  return { kind: "refused", path, message };
}

/**
 * The one key of a closed payload that its grammar does not declare, if any.
 *
 * Returned in `Object.keys` order, so the refusal names the same key every time
 * for the same payload.
 */
function undeclaredKey(record: Record<string, unknown>, declared: readonly string[]): string | null {
  for (const key of Object.keys(record)) {
    if (!declared.includes(key)) return key;
  }
  return null;
}

/** A nullable text field: absent and `null` are both absence; anything else must be text. */
function optionalText(
  record: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false } {
  const value = record[key];
  if (value === undefined || value === null) return { ok: true, value: null };
  return typeof value === "string" && value.length > 0 ? { ok: true, value } : { ok: false };
}

/**
 * The payload's outer shape, shared by both occurrence types: the V2 coordinate
 * and the one record key, and nothing beside them.
 */
function occurrenceEnvelope(
  event: ControlPlaneEvent,
  recordKey: string,
  fields: readonly string[],
):
  | { readonly kind: "record"; readonly record: Record<string, unknown> }
  | { readonly kind: "refused"; readonly path: string; readonly message: string } {
  const stray = undeclaredKey(event.payload, [REVISION_NUMBER_KEY, ATTEMPT_NUMBER_KEY, recordKey]);
  if (stray !== null) {
    return {
      kind: "refused",
      path: "payload." + printable(stray),
      message:
        event.type +
        " carries the V2 coordinate and one " +
        recordKey +
        " record and nothing beside them; " +
        printable(stray) +
        " is not part of that grammar, and an occurrence carries digests and counts, never content",
    };
  }
  if (
    payloadCount(event.payload, REVISION_NUMBER_KEY) === null ||
    payloadCount(event.payload, ATTEMPT_NUMBER_KEY) === null
  ) {
    return {
      kind: "refused",
      path: "payload." + REVISION_NUMBER_KEY,
      message: event.type + " happens inside one attempt and carries the full V2 coordinate",
    };
  }
  const record = payloadRecord(event.payload, recordKey);
  if (record === null) {
    return {
      kind: "refused",
      path: "payload." + recordKey,
      message: event.type + " carries its occurrence as a record under " + recordKey,
    };
  }
  const strayField = undeclaredKey(record, fields);
  if (strayField !== null) {
    return {
      kind: "refused",
      path: "payload." + recordKey + "." + printable(strayField),
      message:
        printable(strayField) +
        " is not a field of " +
        recordKey +
        "; the record admits exactly " +
        fields.join(", "),
    };
  }
  return { kind: "record", record };
}

/**
 * Read one prompt occurrence off its event — execution §8.1.
 *
 * `null` for any other type. Everything a single event can be wrong about is
 * decided here: the closed payload, every field's grammar, and the §4 pair. What
 * needs the base — whether the delivery exists, whether the prompt's effect and
 * segment are the delivery's, the ordinal — is `promptOccurrenceLinkRefusal`'s.
 *
 * `identity` is the event's `emittedBy` and `recordedAt` the event's own
 * instant, never a clock.
 */
export function readPromptOccurrence(
  event: ControlPlaneEvent,
  sequence: number,
): OccurrenceReading<PromptOccurrenceReadModel> | null {
  if (event.type !== PROMPT_OCCURRENCE_RECORDED) return null;

  const envelope = occurrenceEnvelope(event, PROMPT_OCCURRENCE_KEY, PROMPT_OCCURRENCE_RECORD_KEYS);
  if (envelope.kind === "refused") return refused(envelope.path, envelope.message);
  const record = envelope.record;
  const at = (field: string): string => "payload." + PROMPT_OCCURRENCE_KEY + "." + field;

  const missingId = (field: string): OccurrenceReading<PromptOccurrenceReadModel> =>
    refused(at(field), "a prompt occurrence names its " + field + " as non-empty text");
  const occurrenceId = recordText(record, "occurrenceId");
  if (occurrenceId === null) return missingId("occurrenceId");
  const dispatchAttemptId = recordText(record, "dispatchAttemptId");
  if (dispatchAttemptId === null) return missingId("dispatchAttemptId");
  const effectId = recordText(record, "effectId");
  if (effectId === null) return missingId("effectId");
  const routeSegmentId = recordText(record, "routeSegmentId");
  if (routeSegmentId === null) return missingId("routeSegmentId");

  const ordinal = recordCount(record, "ordinal", 0);
  if (ordinal === null) {
    return refused(at("ordinal"), "the ordinal is a non-negative safe integer");
  }

  const requestedModelId = recordText(record, "requestedModelId");
  if (requestedModelId === null) {
    return refused(
      at("requestedModelId"),
      "the requested model is preserved always, even when resolution fails (execution §4, §8)",
    );
  }
  const provider = recordText(record, "provider");
  if (provider === null) {
    return refused(
      at("provider"),
      "the provider is preserved always, even when resolution fails (execution §4, §8)",
    );
  }

  const modelResolutionStatus = recordWord(
    record,
    "modelResolutionStatus",
    MODEL_RESOLUTION_STATUSES,
  );
  if (modelResolutionStatus === null) {
    return refused(
      at("modelResolutionStatus"),
      "the model resolution status is one of " + MODEL_RESOLUTION_STATUSES.join(", "),
    );
  }
  const modelVersion = optionalText(record, "modelVersionId");
  if (!modelVersion.ok) {
    return refused(at("modelVersionId"), "a model version is non-empty text, or absent");
  }
  // Refused here, by name, before `ck_prompt_occurrence_read_model__model_resolution_pair`
  // could abort a statement nobody can attribute to an event.
  if ((modelResolutionStatus === "RESOLVED") !== (modelVersion.value !== null)) {
    return refused(
      at("modelVersionId"),
      "a model version is present if and only if the resolution status is RESOLVED, even " +
        "after executing; this occurrence says " +
        modelResolutionStatus +
        (modelVersion.value === null ? " with no version" : " with a version"),
    );
  }

  const accountId = recordText(record, "accountId");
  if (accountId === null) {
    return refused(at("accountId"), "a prompt occurrence names the account it was sent under");
  }

  const promptSha256 = recordText(record, "promptSha256");
  if (promptSha256 === null || !OCCURRENCE_DIGEST_PATTERN.test(promptSha256)) {
    return refused(
      at("promptSha256"),
      "the prompt digest is a lowercase sha-256 hex string; it is conserved rather than " +
        "recomputed, because its preimage is the prompt and a prompt does not enter this ledger",
    );
  }
  const promptBytes = recordCount(record, "promptBytes", 0);
  if (promptBytes === null) {
    return refused(at("promptBytes"), "the prompt byte count is a non-negative safe integer");
  }
  const context = optionalText(record, "contextSha256");
  if (!context.ok || (context.value !== null && !OCCURRENCE_DIGEST_PATTERN.test(context.value))) {
    return refused(
      at("contextSha256"),
      "the context digest is a lowercase sha-256 hex string, or absent where the prompt " +
        "carries no separately addressed context",
    );
  }

  return {
    kind: "row",
    row: {
      occurrenceId,
      routeSegmentId,
      effectId,
      dispatchAttemptId,
      ordinal,
      identity: event.emittedBy,
      requestedModelId,
      provider,
      modelResolutionStatus,
      modelVersionId: modelVersion.value,
      accountId,
      promptSha256,
      promptBytes,
      contextSha256: context.value,
      recordedAt: event.recordedAt,
      sequence,
    },
  };
}

/**
 * Read one response occurrence off its event — execution §8.2.
 *
 * `null` for any other type. The closed record is what makes N-P18-17 a fact
 * rather than a hope: an answer that names a delivery, a segment or an account
 * is refused here, so nothing but the prompt it answers can attribute it.
 */
export function readResponseOccurrence(
  event: ControlPlaneEvent,
  sequence: number,
): OccurrenceReading<ResponseOccurrenceReadModel> | null {
  if (event.type !== RESPONSE_OCCURRENCE_RECORDED) return null;

  const envelope = occurrenceEnvelope(
    event,
    RESPONSE_OCCURRENCE_KEY,
    RESPONSE_OCCURRENCE_RECORD_KEYS,
  );
  if (envelope.kind === "refused") return refused(envelope.path, envelope.message);
  const record = envelope.record;
  const at = (field: string): string => "payload." + RESPONSE_OCCURRENCE_KEY + "." + field;

  const occurrenceId = recordText(record, "occurrenceId");
  if (occurrenceId === null) {
    return refused(at("occurrenceId"), "a response occurrence names its own occurrenceId");
  }
  const promptOccurrenceId = recordText(record, "promptOccurrenceId");
  if (promptOccurrenceId === null) {
    return refused(
      at("promptOccurrenceId"),
      "a response occurrence names the prompt occurrence it answers",
    );
  }
  // §8.2: the answer's primary key is its own, distinct from the prompt's.
  if (occurrenceId === promptOccurrenceId) {
    return refused(
      at("occurrenceId"),
      "a response occurrence has an id of its own, distinct from the prompt occurrence it " +
        "answers, and this one reuses " +
        printable(promptOccurrenceId),
    );
  }

  const responseSha256 = recordText(record, "responseSha256");
  if (responseSha256 === null || !OCCURRENCE_DIGEST_PATTERN.test(responseSha256)) {
    return refused(
      at("responseSha256"),
      "the response digest is a lowercase sha-256 hex string; it is conserved rather than " +
        "recomputed, because its preimage is the answer and an answer does not enter this ledger",
    );
  }
  const responseBytes = recordCount(record, "responseBytes", 0);
  if (responseBytes === null) {
    return refused(at("responseBytes"), "the response byte count is a non-negative safe integer");
  }
  const redactionVerdict = recordWord(record, "redactionVerdict", REDACTION_VERDICTS);
  if (redactionVerdict === null) {
    return refused(
      at("redactionVerdict"),
      "the redaction verdict is one of " + REDACTION_VERDICTS.join(", "),
    );
  }

  return {
    kind: "row",
    row: {
      occurrenceId,
      promptOccurrenceId,
      responseSha256,
      responseBytes,
      redactionVerdict,
      recordedAt: event.recordedAt,
      sequence,
    },
  };
}

/** The prompt occurrence one event records, or `null` — for the fold. */
export function nextPromptOccurrenceProjection(
  event: ControlPlaneEvent,
  sequence: number,
): PromptOccurrenceReadModel | null {
  const reading = readPromptOccurrence(event, sequence);
  return reading?.kind === "row" ? reading.row : null;
}

/** The response occurrence one event records, or `null` — for the fold. */
export function nextResponseOccurrenceProjection(
  event: ControlPlaneEvent,
  sequence: number,
): ResponseOccurrenceReadModel | null {
  const reading = readResponseOccurrence(event, sequence);
  return reading?.kind === "row" ? reading.row : null;
}

/** "the attempt this event is recorded at", for a refusal, or its absence. */
function eventCoordinateText(event: ControlPlaneEvent): string {
  const revisionNumber = payloadCount(event.payload, REVISION_NUMBER_KEY);
  const attemptNumber = payloadCount(event.payload, ATTEMPT_NUMBER_KEY);
  return revisionNumber === null || attemptNumber === null
    ? "no coordinate at all"
    : "attempt " + taskAttemptKey(event.taskId, revisionNumber, attemptNumber);
}

/** Whether an event is recorded at exactly the attempt that owns an effect. */
function recordedAtOwner(event: ControlPlaneEvent, owner: OccurrenceOwner): boolean {
  return (
    owner.taskId === event.taskId &&
    owner.revisionNumber === payloadCount(event.payload, REVISION_NUMBER_KEY) &&
    owner.attemptNumber === payloadCount(event.payload, ATTEMPT_NUMBER_KEY)
  );
}

/**
 * Why a prompt occurrence cannot hang off the delivery it names, or `null`.
 *
 * Shared by the append door, which reads `dispatch` and `owner` off the base,
 * and by the fold, which reads them off the snapshot — so a rebuild refuses
 * exactly what the door refuses, at the event that caused it.
 *
 * Three rules, in the order an operator would want them:
 *
 *  1. **The delivery exists** (§8 `:419-420`). Its intention is committed, or
 *     earlier in the same `appendBatch`; a prompt that arrives before it is out
 *     of causal order and is refused by name, never as an abort of
 *     `fk_prompt_occurrence_read_model__dispatch_attempt_read_model`.
 *  2. **The effect and the segment are the delivery's** (§8 `:416`,
 *     N-P18-16). The segment in particular is the delivery's *effective* one,
 *     which after a handoff is not the one the effect began on.
 *  3. **The event is recorded at the attempt that owns the effect.** A delivery
 *     is found by a global id, so without this a prompt could be recorded under
 *     another task's coordinate — `#assertDispatchOutcome`'s anchor, one rung
 *     down.
 */
export function promptOccurrenceLinkRefusal(
  event: ControlPlaneEvent,
  prompt: PromptOccurrenceReadModel,
  dispatch: Pick<DispatchAttemptReadModel, "effectId" | "routeSegmentId"> | null,
  owner: OccurrenceOwner | null,
): OccurrenceRefusal | null {
  const at = (field: string): string => "payload." + PROMPT_OCCURRENCE_KEY + "." + field;
  if (dispatch === null) {
    return {
      path: at("dispatchAttemptId"),
      message:
        "a prompt occurrence is recorded after the intention of the delivery that sent it, or " +
        "later in the same batch, and delivery " +
        printable(prompt.dispatchAttemptId) +
        " has been intended in neither",
    };
  }
  if (dispatch.effectId !== prompt.effectId) {
    return {
      path: at("effectId"),
      message:
        "prompt occurrence " +
        printable(prompt.occurrenceId) +
        " names effect " +
        printable(prompt.effectId) +
        " and its delivery " +
        printable(prompt.dispatchAttemptId) +
        " serves effect " +
        printable(dispatch.effectId),
    };
  }
  if (dispatch.routeSegmentId !== prompt.routeSegmentId) {
    return {
      path: at("routeSegmentId"),
      message:
        "prompt occurrence " +
        printable(prompt.occurrenceId) +
        " names segment " +
        printable(prompt.routeSegmentId) +
        " and its delivery " +
        printable(prompt.dispatchAttemptId) +
        " runs on segment " +
        printable(dispatch.routeSegmentId) +
        "; the segment is the delivery's effective one, never inferred from the effect's origin",
    };
  }
  if (owner === null || !recordedAtOwner(event, owner)) {
    return {
      path: at("dispatchAttemptId"),
      message:
        "delivery " +
        printable(prompt.dispatchAttemptId) +
        " serves effect " +
        printable(dispatch.effectId) +
        (owner === null
          ? ", which no event accounts for,"
          : " of attempt " + taskAttemptKey(owner.taskId, owner.revisionNumber, owner.attemptNumber)) +
        " and this prompt occurrence is recorded at " +
        eventCoordinateText(event),
    };
  }
  return null;
}

/**
 * Why a response occurrence cannot answer the prompt it names, or `null`.
 *
 * Shared by the door and the fold on `promptOccurrenceLinkRefusal`'s terms.
 * `answeredBy` is the occurrence id of the answer that prompt already has, if
 * any, **other than this one** — the caller decides "this one" by id, because
 * an identical restatement of the same answer is a replay and not a second
 * answer.
 *
 *  1. **The prompt exists** (§8 `:407`) — refused by name, never as an abort of
 *     `fk_response_occurrence_read_model__prompt_occurrence_read_model`.
 *  2. **The answer is recorded at the prompt's own attempt** (§7 `:343`): the
 *     coordinate of an answer is the one the prompt was sent under, never the
 *     one a later handoff moved the run to.
 *  3. **One answer per prompt** (§8 `:431`) — refused by name, never as an abort
 *     of `ux_response_occurrence_read_model__prompt`.
 */
export function responseOccurrenceLinkRefusal(
  event: ControlPlaneEvent,
  response: ResponseOccurrenceReadModel,
  promptExists: boolean,
  owner: OccurrenceOwner | null,
  answeredBy: string | null,
): OccurrenceRefusal | null {
  const at = (field: string): string => "payload." + RESPONSE_OCCURRENCE_KEY + "." + field;
  if (!promptExists) {
    return {
      path: at("promptOccurrenceId"),
      message:
        "a response answers a prompt occurrence that has been recorded, and " +
        printable(response.promptOccurrenceId) +
        " has not been",
    };
  }
  if (owner === null || !recordedAtOwner(event, owner)) {
    return {
      path: at("promptOccurrenceId"),
      message:
        "prompt occurrence " +
        printable(response.promptOccurrenceId) +
        (owner === null
          ? " hangs off no effect any event accounts for"
          : " was sent under attempt " +
            taskAttemptKey(owner.taskId, owner.revisionNumber, owner.attemptNumber)) +
        ", and its answer is recorded under that coordinate rather than at " +
        eventCoordinateText(event),
    };
  }
  if (answeredBy !== null) {
    return {
      path: at("promptOccurrenceId"),
      message:
        "prompt occurrence " +
        printable(response.promptOccurrenceId) +
        " is already answered by " +
        printable(answeredBy) +
        ", and a prompt occurrence has one answer",
    };
  }
  return null;
}

/**
 * The comparable form of a prompt occurrence: everything it *is*.
 *
 * Neither birth attribute — `recordedAt`, `sequence` — for `canonicalSegment`'s
 * reason, and spelled out field by field for the same one. `identity` is in:
 * the same occurrence restated by another worker is not the same occurrence.
 */
export function canonicalPromptOccurrence(prompt: PromptOccurrenceReadModel): string {
  return canonicalJsonStringify({
    occurrenceId: prompt.occurrenceId,
    routeSegmentId: prompt.routeSegmentId,
    effectId: prompt.effectId,
    dispatchAttemptId: prompt.dispatchAttemptId,
    ordinal: prompt.ordinal,
    identity: prompt.identity,
    requestedModelId: prompt.requestedModelId,
    provider: prompt.provider,
    modelResolutionStatus: prompt.modelResolutionStatus,
    modelVersionId: prompt.modelVersionId,
    accountId: prompt.accountId,
    promptSha256: prompt.promptSha256,
    promptBytes: prompt.promptBytes,
    contextSha256: prompt.contextSha256,
  });
}

/** The comparable form of a response occurrence, on the same terms. */
export function canonicalResponseOccurrence(response: ResponseOccurrenceReadModel): string {
  return canonicalJsonStringify({
    occurrenceId: response.occurrenceId,
    promptOccurrenceId: response.promptOccurrenceId,
    responseSha256: response.responseSha256,
    responseBytes: response.responseBytes,
    redactionVerdict: response.redactionVerdict,
  });
}

// ---------------------------------------------------------------------------
// P-32/captura B — the measurement stream, the observation and the settlement.
// ---------------------------------------------------------------------------

/**
 * The two event types of P-32/captura B, and the payload keys their records
 * travel under (economy §1.1-§2; ADR 0089).
 *
 * P-18/protocolo D's shape: the V2 coordinate and one closed record, and nothing
 * beside them. Closed because a usage payload carries counts, identifiers and
 * digests, and a key its grammar does not declare is the one place a provider's
 * prose or a credential could still ride in under a name no guard has heard of.
 */
export const USAGE_STREAM_DECLARED: ControlPlaneEvent["type"] = "USAGE_STREAM_DECLARED";
export const USAGE_OBSERVATION_RECORDED: ControlPlaneEvent["type"] = "USAGE_OBSERVATION_RECORDED";

export const USAGE_STREAM_KEY = "usageStream";
export const USAGE_OBSERVATION_KEY = "usageObservation";

/** Every key a stream declaration carries, all required. */
export const USAGE_STREAM_RECORD_KEYS = [
  "measurementStreamId",
  "source",
  "accountId",
  "routeSegmentId",
  "sourceEpoch",
  "sourceClass",
  "normalizationPolicySha256",
] as const;

/**
 * Every key an observation carries. `rangeFromCounter`, `rangeToCounter` and
 * `correctsObservationId` may be absent or `null`, as report kind decides; every
 * other key is required. No `recordedAt` and no `sequence`: both are the
 * recording event's.
 */
export const USAGE_OBSERVATION_RECORD_KEYS = [
  "observationId",
  "measurementStreamId",
  "ordinal",
  "sourceObservationId",
  "reportKind",
  "rangeFromCounter",
  "rangeToCounter",
  "correctsObservationId",
  "effectId",
  "isFinal",
  "inputTokens",
  "outputTokens",
  "cacheWriteTokens",
  "cacheReadTokens",
  "totalTokens",
  "occurredAt",
] as const;

const USAGE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const USAGE_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A safe integer at or above zero that is not `-0`: A's `isCount`, for a payload. */
function usageCount(record: Record<string, unknown>, key: string): number | null {
  const value = recordCount(record, key, 0);
  return value === null || Object.is(value, -0) ? null : value;
}

/** A nullable count: absent and `null` are absence; anything else must be a count. */
function usageOptionalCount(
  record: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value: number | null } | { readonly ok: false } {
  const value = record[key];
  if (value === undefined || value === null) return { ok: true, value: null };
  const count = usageCount(record, key);
  return count === null ? { ok: false } : { ok: true, value: count };
}

/**
 * The same-state rule both usage types are held to, which no earlier type of
 * this vocabulary had the door impose: recording spend moves no task.
 */
function usagePassthroughRefusal(event: ControlPlaneEvent): OccurrenceRefusal | null {
  if (event.fromState !== null && event.fromState === event.toState) return null;
  return {
    path: "toState",
    message:
      event.type +
      " is a same-state passthrough: declaring where spend is measured and recording a measurement move no task, " +
      "so fromState and toState are the task's current state, both",
  };
}

/**
 * Read one stream declaration off its event — economy §1.1.
 *
 * `null` for any other type. Everything one event can be wrong about is decided
 * here, the identity included: `measurementStreamId` is recomputed from the four
 * coordinate fields through the versioned preimage and refused by name when it
 * is not that digest (N-P32-1). What needs the base — the segment, a stream
 * already declared under the id — is `usageStreamLinkRefusal`'s.
 */
export function readUsageStreamDeclaration(
  event: ControlPlaneEvent,
  sequence: number,
): OccurrenceReading<UsageMeasurementStreamReadModel> | null {
  if (event.type !== USAGE_STREAM_DECLARED) return null;
  const passthrough = usagePassthroughRefusal(event);
  if (passthrough !== null) return refused(passthrough.path, passthrough.message);

  const envelope = occurrenceEnvelope(event, USAGE_STREAM_KEY, USAGE_STREAM_RECORD_KEYS);
  if (envelope.kind === "refused") return refused(envelope.path, envelope.message);
  const record = envelope.record;
  const at = (field: string): string => "payload." + USAGE_STREAM_KEY + "." + field;

  for (const field of ["source", "accountId", "routeSegmentId"]) {
    if (recordText(record, field) === null) {
      return refused(at(field), "STREAM_COORDINATE_INVALID: a stream names its " + field + " as non-empty text");
    }
  }
  const source = recordText(record, "source") ?? "";
  const accountId = recordText(record, "accountId") ?? "";
  const routeSegmentId = recordText(record, "routeSegmentId") ?? "";
  const sourceEpoch = usageCount(record, "sourceEpoch");
  if (sourceEpoch === null) {
    return refused(
      at("sourceEpoch"),
      "STREAM_COORDINATE_INVALID: the epoch is the adapter's registered counter generation, a safe integer >= 0",
    );
  }
  const sourceClass = recordWord(record, "sourceClass", USAGE_SOURCE_CLASSES);
  if (sourceClass === null) {
    return refused(
      at("sourceClass"),
      "STREAM_SOURCE_CLASS_INVALID: the source class is registered, one of " + USAGE_SOURCE_CLASSES.join(", "),
    );
  }
  const normalizationPolicySha256 = recordText(record, "normalizationPolicySha256");
  if (normalizationPolicySha256 === null || !USAGE_DIGEST_PATTERN.test(normalizationPolicySha256)) {
    return refused(
      at("normalizationPolicySha256"),
      "the normalization policy is named by its lowercase sha-256 hex digest",
    );
  }
  const claimed = recordText(record, "measurementStreamId");
  const measurementStreamId = measurementStreamIdV1({ source, accountId, routeSegmentId, sourceEpoch });
  if (claimed !== measurementStreamId) {
    return refused(
      at("measurementStreamId"),
      "STREAM_COORDINATE_INVALID: a stream's id is the digest of the versioned preimage of its source, account, " +
        "segment and epoch, recomputed here and never believed; this one is not that digest",
    );
  }

  return {
    kind: "row",
    row: {
      measurementStreamId,
      source,
      accountId,
      routeSegmentId,
      sourceEpoch,
      sourceClass,
      normalizationPolicySha256,
      sequence,
    },
  };
}

/**
 * Read one observation off its event — economy §1.2.
 *
 * `null` for any other type. The report's shape is `ck_usage_observation__report_shape`
 * refused by name before the constraint could abort; the four classes are
 * checked against the total with `BigInt`, so input already counted in a cache
 * class cannot be counted again; and a correction of itself is a cycle, refused
 * here because no stored target could ever be found for it.
 */
export function readUsageObservation(
  event: ControlPlaneEvent,
  sequence: number,
): OccurrenceReading<UsageObservationReadModel> | null {
  if (event.type !== USAGE_OBSERVATION_RECORDED) return null;
  const passthrough = usagePassthroughRefusal(event);
  if (passthrough !== null) return refused(passthrough.path, passthrough.message);

  const envelope = occurrenceEnvelope(event, USAGE_OBSERVATION_KEY, USAGE_OBSERVATION_RECORD_KEYS);
  if (envelope.kind === "refused") return refused(envelope.path, envelope.message);
  const record = envelope.record;
  const at = (field: string): string => "payload." + USAGE_OBSERVATION_KEY + "." + field;
  const shape = (field: string, message: string): OccurrenceReading<UsageObservationReadModel> =>
    refused(at(field), "OBSERVATION_SHAPE_INVALID: " + message);

  for (const field of ["observationId", "measurementStreamId", "sourceObservationId", "effectId"]) {
    if (recordText(record, field) === null) return shape(field, "an observation names its " + field + " as non-empty text");
  }
  const observationId = recordText(record, "observationId") ?? "";
  const measurementStreamId = recordText(record, "measurementStreamId") ?? "";
  const sourceObservationId = recordText(record, "sourceObservationId") ?? "";
  const effectId = recordText(record, "effectId") ?? "";

  const ordinal = usageCount(record, "ordinal");
  if (ordinal === null) return shape("ordinal", "the ordinal is a safe integer >= 0");
  const reportKind = recordWord(record, "reportKind", USAGE_REPORT_KINDS);
  if (reportKind === null) return shape("reportKind", "the report kind is one of " + USAGE_REPORT_KINDS.join(", "));

  const from = usageOptionalCount(record, "rangeFromCounter");
  if (!from.ok) return shape("rangeFromCounter", "a range bound is a safe integer >= 0, or absent");
  const to = usageOptionalCount(record, "rangeToCounter");
  if (!to.ok) return shape("rangeToCounter", "a range bound is a safe integer >= 0, or absent");
  const corrects = optionalText(record, "correctsObservationId");
  if (!corrects.ok) return shape("correctsObservationId", "a corrected observation is named by non-empty text, or absent");

  if (reportKind === "CORRECTION") {
    if (corrects.value === null) {
      return shape("correctsObservationId", "a CORRECTION names the observation it replaces");
    }
    if (from.value !== null) return shape("rangeFromCounter", "a CORRECTION inherits its target's coverage and declares none");
    if (to.value !== null) return shape("rangeToCounter", "a CORRECTION inherits its target's coverage and declares none");
    if (corrects.value === observationId) {
      return refused(at("correctsObservationId"), "CORRECTION_CYCLE: an observation does not correct itself");
    }
  } else {
    if (corrects.value !== null) return shape("correctsObservationId", "only a CORRECTION names an observation it replaces");
    if (from.value === null) return shape("rangeFromCounter", reportKind + " covers an explicit counter range");
    if (to.value === null || to.value <= from.value) {
      return shape("rangeToCounter", reportKind + " covers a half-open range whose end is past its start");
    }
  }

  const isFinal = record["isFinal"];
  if (isFinal !== 0 && isFinal !== 1) {
    return shape("isFinal", "is_final is 0 or 1, the source's explicit close of the measurement, never inferred");
  }
  const occurredAt = recordText(record, "occurredAt");
  if (occurredAt === null || !USAGE_INSTANT_PATTERN.test(occurredAt)) {
    return shape("occurredAt", "the source instant is ISO-8601 with milliseconds and Z");
  }

  const counts: number[] = [];
  let sum = 0n;
  for (const field of ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"]) {
    const value = usageCount(record, field);
    if (value === null) return shape(field, "a token class is a safe integer >= 0");
    counts.push(value);
    sum += BigInt(value);
  }
  const totalTokens = usageCount(record, "totalTokens");
  if (totalTokens === null) return shape("totalTokens", "the total is a safe integer >= 0");
  if (BigInt(totalTokens) !== sum) {
    return refused(
      at("totalTokens"),
      "TOTAL_MISMATCH: the total is the sum of the four mutually exclusive classes and nothing else",
    );
  }

  return {
    kind: "row",
    row: {
      observationId,
      measurementStreamId,
      ordinal,
      sourceObservationId,
      reportKind,
      rangeFromCounter: from.value,
      rangeToCounter: to.value,
      correctsObservationId: corrects.value,
      effectId,
      isFinal,
      inputTokens: counts[0] ?? 0,
      outputTokens: counts[1] ?? 0,
      cacheWriteTokens: counts[2] ?? 0,
      cacheReadTokens: counts[3] ?? 0,
      totalTokens,
      occurredAt,
      recordedAt: event.recordedAt,
      sequence,
    },
  };
}

/** The comparable form of a stream: everything it is, and not the event that first declared it. */
export function canonicalUsageStream(stream: UsageMeasurementStreamReadModel): string {
  return canonicalJsonStringify({
    measurementStreamId: stream.measurementStreamId,
    source: stream.source,
    accountId: stream.accountId,
    routeSegmentId: stream.routeSegmentId,
    sourceEpoch: stream.sourceEpoch,
    sourceClass: stream.sourceClass,
    normalizationPolicySha256: stream.normalizationPolicySha256,
  });
}

/**
 * The comparable form of an observation: everything the source reported, and
 * neither birth attribute (`recordedAt`, `sequence`), for `canonicalSegment`'s
 * reason. Same identity with other bytes is a conflict, never a replay (economy
 * §1.2 `:80`).
 */
export function canonicalUsageObservation(observation: UsageObservationReadModel): string {
  return canonicalJsonStringify({
    observationId: observation.observationId,
    measurementStreamId: observation.measurementStreamId,
    ordinal: observation.ordinal,
    sourceObservationId: observation.sourceObservationId,
    reportKind: observation.reportKind,
    rangeFromCounter: observation.rangeFromCounter,
    rangeToCounter: observation.rangeToCounter,
    correctsObservationId: observation.correctsObservationId,
    effectId: observation.effectId,
    isFinal: observation.isFinal,
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    cacheWriteTokens: observation.cacheWriteTokens,
    cacheReadTokens: observation.cacheReadTokens,
    totalTokens: observation.totalTokens,
    occurredAt: observation.occurredAt,
  });
}

/**
 * Why a stream declaration cannot stand, or `null`.
 *
 *  1. **The segment exists** (H-11). §1.1 gives the column no foreign key, and a
 *     stream attributed to a segment nobody opened attributes spend to nothing.
 *  2. **The event is recorded at the attempt that owns the segment**, D's anchor
 *     one table over: a segment is found by a global id, so without this a
 *     declaration could be recorded under another task's coordinate.
 *  3. **A stream is declared once** (N-P32-2). The id is the digest of the
 *     coordinate, so an id already held names the same coordinate; what may still
 *     differ is the class or the policy, and either is refused by name. The same
 *     bytes are a restatement, which writes nothing.
 */
export function usageStreamLinkRefusal(
  event: ControlPlaneEvent,
  stream: UsageMeasurementStreamReadModel,
  segmentOwner: OccurrenceOwner | null,
  stored: UsageMeasurementStreamReadModel | null,
): OccurrenceRefusal | null {
  const at = (field: string): string => "payload." + USAGE_STREAM_KEY + "." + field;
  if (segmentOwner === null) {
    return {
      path: at("routeSegmentId"),
      message:
        "a stream attributes spend to a route segment that has been opened, and " +
        printable(stream.routeSegmentId) +
        " has not been",
    };
  }
  if (!recordedAtOwner(event, segmentOwner)) {
    return {
      path: at("routeSegmentId"),
      message:
        "segment " +
        printable(stream.routeSegmentId) +
        " belongs to attempt " +
        taskAttemptKey(segmentOwner.taskId, segmentOwner.revisionNumber, segmentOwner.attemptNumber) +
        " and this declaration is recorded at " +
        eventCoordinateText(event),
    };
  }
  if (stored !== null && canonicalUsageStream(stored) !== canonicalUsageStream(stream)) {
    const field = stored.sourceClass !== stream.sourceClass ? "sourceClass" : "normalizationPolicySha256";
    return {
      path: at(field),
      message:
        "stream " +
        stream.measurementStreamId +
        " is already declared with another " +
        field +
        ", and a reused stream keeps every field it was declared with; a new generation is a new epoch",
    };
  }
  return null;
}

/** What an observation's links are checked against, read off the base or off a snapshot. */
export interface UsageObservationLinks {
  readonly stream: UsageMeasurementStreamReadModel | null;
  readonly streamSegmentOwner: OccurrenceOwner | null;
  readonly effectOwner: OccurrenceOwner | null;
  /** Whether the effect has its exposure revision, which only its first delivery writes. */
  readonly exposed: boolean;
  readonly stored: UsageObservationReadModel | null;
  readonly ordinalHolder: string | null;
  readonly sourceReportHolder: string | null;
  readonly target: UsageObservationReadModel | null;
}

/**
 * Why an observation cannot hang off its stream and its effect, or `null`.
 *
 * In the order an operator would want them:
 *
 *  1. **The stream is declared** — before its first report (economy §1.1 `:36`).
 *  2. **The effect exists** (N-P32-15), refused by name and never as an abort of
 *     `fk_usage_observation__effect_read_model`.
 *  3. **The event is recorded at the attempt that owns the effect** (N-P32B-20).
 *  4. **The stream's segment is of that same attempt**: spend of one attempt is
 *     not attributed to a segment of another.
 *  5. **The effect is exposed** (Q3, H-5). Its first delivery writes revision 1;
 *     before it there is no spend to measure, and revision 1 is always the
 *     exposure.
 *  6. **One report is one report** (N-P32-4). The same id with the same bytes is a
 *     restatement; with other bytes it is a conflict; another id at a held
 *     ordinal or source report id is refused by name before either unique index.
 *  7. **A correction names a recorded report of its own stream and effect** (E7).
 */
export function usageObservationLinkRefusal(
  event: ControlPlaneEvent,
  observation: UsageObservationReadModel,
  links: UsageObservationLinks,
): OccurrenceRefusal | null {
  const at = (field: string): string => "payload." + USAGE_OBSERVATION_KEY + "." + field;
  if (links.stream === null) {
    return {
      path: at("measurementStreamId"),
      message:
        "STREAM_UNKNOWN: a stream is declared before its first report, and " +
        printable(observation.measurementStreamId) +
        " has not been",
    };
  }
  if (links.effectOwner === null) {
    return {
      path: at("effectId"),
      message: "a measurement belongs to an effect, and effect " + printable(observation.effectId) + " has not been intended",
    };
  }
  if (!recordedAtOwner(event, links.effectOwner)) {
    return {
      path: at("effectId"),
      message:
        "effect " +
        printable(observation.effectId) +
        " belongs to attempt " +
        taskAttemptKey(links.effectOwner.taskId, links.effectOwner.revisionNumber, links.effectOwner.attemptNumber) +
        " and this observation is recorded at " +
        eventCoordinateText(event),
    };
  }
  const segmentOwner = links.streamSegmentOwner;
  if (
    segmentOwner === null ||
    segmentOwner.taskId !== links.effectOwner.taskId ||
    segmentOwner.revisionNumber !== links.effectOwner.revisionNumber ||
    segmentOwner.attemptNumber !== links.effectOwner.attemptNumber
  ) {
    return {
      path: at("measurementStreamId"),
      message:
        "stream " +
        printable(observation.measurementStreamId) +
        " measures segment " +
        printable(links.stream.routeSegmentId) +
        ", which is not a segment of the attempt that owns effect " +
        printable(observation.effectId),
    };
  }
  if (!links.exposed) {
    return {
      path: at("effectId"),
      message:
        "effect " +
        printable(observation.effectId) +
        " has not been exposed: no delivery of it has been intended, so there is no spend to measure, and its " +
        "first delivery is what opens its settlement",
    };
  }
  if (links.stored !== null) {
    if (canonicalUsageObservation(links.stored) === canonicalUsageObservation(observation)) return null;
    return {
      path: at("observationId"),
      message:
        "observation " +
        printable(observation.observationId) +
        " is already recorded with different content; the same identity with other bytes is a conflict, never a replay",
    };
  }
  if (links.ordinalHolder !== null) {
    return {
      path: at("ordinal"),
      message:
        "ORDINAL_DUPLICATE: ordinal " +
        String(observation.ordinal) +
        " of stream " +
        printable(observation.measurementStreamId) +
        " is already " +
        printable(links.ordinalHolder),
    };
  }
  if (links.sourceReportHolder !== null) {
    return {
      path: at("sourceObservationId"),
      message:
        "SOURCE_REPORT_DUPLICATE: source report " +
        printable(observation.sourceObservationId) +
        " of stream " +
        printable(observation.measurementStreamId) +
        " is already " +
        printable(links.sourceReportHolder),
    };
  }
  if (observation.reportKind === "CORRECTION") {
    const target = links.target;
    const named = printable(observation.correctsObservationId ?? "");
    if (target === null) {
      return {
        path: at("correctsObservationId"),
        message: "CORRECTION_TARGET_UNKNOWN: a correction replaces a recorded report, and " + named + " is not one",
      };
    }
    if (target.measurementStreamId !== observation.measurementStreamId) {
      return {
        path: at("correctsObservationId"),
        message: "CORRECTION_CROSS_STREAM: " + named + " was reported on another stream",
      };
    }
    if (target.effectId !== observation.effectId) {
      return {
        path: at("correctsObservationId"),
        message: "CORRECTION_CROSS_EFFECT: " + named + " measures another effect",
      };
    }
  }
  return null;
}

/** The observation's links, read off a view. */
function usageObservationLinksOf(view: UsageCaptureView, observation: UsageObservationReadModel): UsageObservationLinks {
  const stream = view.stream(observation.measurementStreamId);
  const stored = view.observation(observation.observationId);
  const ordinalHolder = view.observationAtOrdinal(observation.measurementStreamId, observation.ordinal);
  const sourceReportHolder = view.observationForSourceReport(
    observation.measurementStreamId,
    observation.sourceObservationId,
  );
  return {
    stream,
    streamSegmentOwner: stream === null ? null : view.segmentOwner(stream.routeSegmentId),
    effectOwner: view.effectOwner(observation.effectId),
    exposed: view.latestSettlement(observation.effectId) !== null,
    stored,
    ordinalHolder: ordinalHolder === observation.observationId ? null : ordinalHolder,
    sourceReportHolder: sourceReportHolder === observation.observationId ? null : sourceReportHolder,
    target:
      observation.correctsObservationId === null ? null : view.observation(observation.correctsObservationId),
  };
}

/**
 * Refuse a usage event by name, or return; the append door calls it before the
 * row is written (`#assertExecutionOccurrence`'s place), and `nextUsageCapture`
 * calls it again, so the door, the rebuild and the migration refuse the same
 * histories in the same words.
 */
export function assertUsageCaptureAdmissible(view: UsageCaptureView, event: ControlPlaneEvent): void {
  const stream = readUsageStreamDeclaration(event, 0);
  if (stream !== null) {
    if (stream.kind === "refused") throw new LedgerValidationError([{ path: stream.path, message: stream.message }]);
    const refusal = usageStreamLinkRefusal(
      event,
      stream.row,
      view.segmentOwner(stream.row.routeSegmentId),
      view.stream(stream.row.measurementStreamId),
    );
    if (refusal !== null) throw new LedgerValidationError([refusal]);
    return;
  }
  const observation = readUsageObservation(event, 0);
  if (observation !== null) {
    if (observation.kind === "refused") {
      throw new LedgerValidationError([{ path: observation.path, message: observation.message }]);
    }
    const refusal = usageObservationLinkRefusal(event, observation.row, usageObservationLinksOf(view, observation.row));
    if (refusal !== null) throw new LedgerValidationError([refusal]);
  }
}

/** The fold's refusal as the door speaks it: a word, the field and the effect. */
function usageFoldRefusal(
  reason: string,
  foldAt: string,
  effectId: string,
  arriving: UsageObservationReadModel | null,
  observations: readonly UsageObservationInput[],
): LedgerValidationError {
  const recordPath = arriving === null ? "payload." + DISPATCH_KEY + ".effectId" : "payload." + USAGE_OBSERVATION_KEY;
  const indexed = /^observations\[(\d+)\](?:\.(\w+))?$/.exec(foldAt);
  let path = arriving === null ? recordPath : recordPath + ".observationId";
  let detail = foldAt;
  if (indexed !== null && arriving !== null) {
    const position = Number(indexed[1]);
    const field = indexed[2] ?? "observationId";
    const named = observations[position];
    if (named?.observationId === arriving.observationId) {
      path = recordPath + "." + field;
    } else if (named !== undefined) {
      detail = "observation " + printable(named.observationId) + (indexed[2] === undefined ? "" : "." + field);
    }
  } else if (arriving !== null && /^(?:segments\[\d+\]|header)\./.test(foldAt)) {
    path = recordPath + ".totalTokens";
  }
  return new LedgerValidationError([
    {
      path,
      message:
        reason +
        ": the settlement fold of effect " +
        printable(effectId) +
        " refuses the history this event would make, at " +
        detail,
    },
  ]);
}

/**
 * Fold one effect's settlement revision at the trigger, through escalón A's fold.
 *
 * The cut is the trigger's own head (F-2, H-4): its sequence and its own chain
 * digest, so a rebuild at any later head reconsiders nothing the trigger did not
 * see. `arriving` is the observation this event records, folded with those
 * already recorded and not yet written.
 */
function settleUsage(
  view: UsageCaptureView,
  effectId: string,
  arriving: UsageObservationReadModel | null,
  trigger: { readonly sequence: number; readonly sha256: string; readonly recordedAt: string },
): UsageSettlementRecord {
  const recorded = view.effectObservations(effectId);
  const observations: UsageObservationInput[] = [...recorded, ...(arriving === null ? [] : [arriving])];
  const streams: UsageMeasurementStreamInput[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    if (seen.has(observation.measurementStreamId)) continue;
    seen.add(observation.measurementStreamId);
    const stream = view.stream(observation.measurementStreamId);
    if (stream !== null) streams.push(stream);
  }
  const outcome = foldUsageSettlement({
    cut: { effectId, controlHead: { sequence: trigger.sequence, sha256: trigger.sha256 } },
    trigger: { sequence: trigger.sequence, recordedAt: trigger.recordedAt },
    streams,
    observations,
    previous: view.latestSettlement(effectId),
    lastFinalSequence: view.lastFinalSequence(effectId),
    policy: USAGE_SOURCE_POLICY_V1,
    foldVersion: USAGE_FOLD_VERSION_V1,
  });
  if (!outcome.ok) throw usageFoldRefusal(outcome.reason, outcome.at, effectId, arriving, observations);
  const { header, sourceHeads, observationIds } = outcome.settlement;
  const row: UsageSettlementReadModel = { ...header };
  return {
    header: row,
    sourceHeads: sourceHeads.map((head) => ({
      effectId,
      settlementRevision: header.settlementRevision,
      sourceStream: head.sourceStream,
      sourceSequence: head.sourceSequence,
      sourceSha256: head.sourceSha256,
    })),
    observations: observationIds.map((observationId) => ({
      effectId,
      settlementRevision: header.settlementRevision,
      observationId,
    })),
  };
}

/**
 * What one event writes to the five usage tables, or `null` when it writes none
 * — the one function the append door, the rebuild and migration 20 use.
 *
 * - A **stream declaration** writes its stream, once.
 * - An **observation** writes itself and the effect's next settlement revision,
 *   folded in this transaction (economy §1.2 `:81`, E8). A restatement writes
 *   nothing and opens no revision.
 * - A **delivery's intention** writes revision 1 of its effect when the effect
 *   has none (Q3, H-5): the exposure, `UNKNOWN`, with an empty list and no
 *   observation invented for it. Whether it has one is the only question —
 *   never the delivery's ordinal — so a second delivery after an abandoned first
 *   writes nothing.
 *
 * `sha256` is the event's own chain digest: in the door the one it is about to
 * be written with, in a replay the one it was.
 */
export function nextUsageCapture(
  view: UsageCaptureView,
  event: ControlPlaneEvent,
  sequence: number,
  sha256: string,
): UsageCaptureWrites | null {
  const trigger = { sequence, sha256, recordedAt: event.recordedAt };

  if (event.type === DISPATCH_INTENDED) {
    const dispatch = nextDispatchAttemptProjection(event, sequence);
    if (dispatch === null || view.latestSettlement(dispatch.effectId) !== null) return null;
    return { stream: null, observation: null, settlement: settleUsage(view, dispatch.effectId, null, trigger) };
  }

  if (event.type !== USAGE_STREAM_DECLARED && event.type !== USAGE_OBSERVATION_RECORDED) return null;
  assertUsageCaptureAdmissible(view, event);

  const stream = readUsageStreamDeclaration(event, sequence);
  if (stream?.kind === "row") {
    if (view.stream(stream.row.measurementStreamId) !== null) return null;
    return { stream: stream.row, observation: null, settlement: null };
  }
  const observation = readUsageObservation(event, sequence);
  if (observation?.kind !== "row") return null;
  if (view.observation(observation.row.observationId) !== null) return null;
  return {
    stream: null,
    observation: observation.row,
    settlement: settleUsage(view, observation.row.effectId, observation.row, trigger),
  };
}

/** The key of one settlement revision in a snapshot. An effect id is hex, so a space cannot collide. */
export function usageSettlementKey(effectId: string, settlementRevision: number): string {
  return effectId + " " + String(settlementRevision);
}

/**
 * The comparable text of a usage row, for `verifyIntegrity`.
 *
 * `canonicalJsonStringify` refuses a `bigint`, and a settlement's counts are one,
 * while a stored row read with `safeIntegers` holds every integer as one. So both
 * sides are brought to the same text: every integer, `number` or `bigint`, as its
 * decimal digits. A count is never compared through `number`.
 */
export function usageRowText(row: object): string {
  const textual: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    textual[key] = typeof value === "bigint" || typeof value === "number" ? String(value) : value;
  }
  return canonicalJsonStringify(textual);
}

/**
 * In-memory projection of an entire event stream.
 *
 * Used by rebuildReadModel to replay, and by verifyIntegrity to compute what
 * the stored projection should have been so the two can be compared.
 */
export interface ProjectionSnapshot {
  readonly tasks: Map<string, TaskReadModel>;
  readonly workers: Map<string, WorkerReadModel>;
  readonly workerTasks: Map<string, WorkerTaskProjection>;
  readonly executionRoutes: Map<string, ExecutionRouteReadModel>;
  readonly taskRevisions: Map<string, TaskRevisionReadModel>;
  readonly taskAttempts: Map<string, TaskAttemptReadModel>;
  /**
   * The attempt table's two unique indexes, in memory.
   *
   * A claim to the coordinate key that already holds it, so a collision names
   * the earlier attempt rather than just failing. Not a projection and never
   * written anywhere: it exists so that a rebuild refuses the same histories
   * the base's indexes refuse, at the event that caused them.
   */
  readonly taskAttemptClaims: Map<string, string>;
  /**
   * The P-18/protocolo C cohort, each keyed by its own primary key, and each
   * with its table's unique indexes held beside it for `taskAttemptClaims`'
   * reason.
   *
   * `effects` and `dispatchAttempts` are the two maps in this snapshot whose
   * values are **replaced** as the fold advances rather than only inserted: a
   * resolution event moves a delivery's state and may write an effect's
   * outcome. Everything else here is insert-only, and the difference is a fact
   * about the dictionary rather than a looseness — execution §6 and §7 each
   * describe a row that is born and then resolved once.
   */
  readonly routeSegments: Map<string, ExecutionRouteSegmentReadModel>;
  readonly routeSegmentClaims: Map<string, string>;
  readonly effects: Map<string, EffectReadModel>;
  readonly effectClaims: Map<string, string>;
  readonly dispatchAttempts: Map<string, DispatchAttemptReadModel>;
  readonly dispatchAttemptClaims: Map<string, string>;
  /**
   * The P-18/protocolo D pair, insert-only, each keyed by its occurrence id.
   *
   * `responseOccurrenceClaims` is `ux_response_occurrence_read_model__prompt`
   * in memory — a prompt occurrence id to the answer that holds it — so a
   * rebuild refuses a second answer at the event that caused it. The prompt
   * table has no unique index beside its key, and so no claims map: two
   * occurrences of the same bytes are the point, not a collision.
   */
  readonly promptOccurrences: Map<string, PromptOccurrenceReadModel>;
  readonly responseOccurrences: Map<string, ResponseOccurrenceReadModel>;
  readonly responseOccurrenceClaims: Map<string, string>;
  /**
   * P-14 C's client keys, insert-only, keyed by `taskSubmissionKey`. A second
   * arrival under one key that names anything else fails the rebuild at the
   * event that caused it, through the comparison the append door uses.
   */
  readonly taskSubmissions: Map<string, TaskSubmissionReadModel>;
  /**
   * The P-32/captura B cohort: the five tables, keyed as their primary keys are,
   * insert-only — a later revision is a row beside the earlier one, never over it.
   *
   * `usageObservationClaims` holds the two unique indexes of the observation
   * table in memory, and the two maps after it are indexes over the rows above:
   * an effect's observations and its revision in force. Neither is ever
   * compared; they answer the view's questions without a scan per event.
   */
  readonly usageStreams: Map<string, UsageMeasurementStreamReadModel>;
  readonly usageObservations: Map<string, UsageObservationReadModel>;
  readonly usageSettlements: Map<string, UsageSettlementReadModel>;
  readonly usageSettlementSourceHeads: Map<string, UsageSettlementRecord["sourceHeads"][number]>;
  readonly usageSettlementObservations: Map<string, UsageSettlementRecord["observations"][number]>;
  readonly usageObservationClaims: Map<string, string>;
  readonly usageEffectObservations: Map<string, UsageObservationReadModel[]>;
  readonly usageEffectSettlements: Map<string, UsageSettlementReadModel[]>;
}

export function createProjectionSnapshot(): ProjectionSnapshot {
  return {
    tasks: new Map<string, TaskReadModel>(),
    workers: new Map<string, WorkerReadModel>(),
    workerTasks: new Map<string, WorkerTaskProjection>(),
    executionRoutes: new Map<string, ExecutionRouteReadModel>(),
    taskRevisions: new Map<string, TaskRevisionReadModel>(),
    taskAttempts: new Map<string, TaskAttemptReadModel>(),
    taskAttemptClaims: new Map<string, string>(),
    routeSegments: new Map<string, ExecutionRouteSegmentReadModel>(),
    routeSegmentClaims: new Map<string, string>(),
    effects: new Map<string, EffectReadModel>(),
    effectClaims: new Map<string, string>(),
    dispatchAttempts: new Map<string, DispatchAttemptReadModel>(),
    dispatchAttemptClaims: new Map<string, string>(),
    promptOccurrences: new Map<string, PromptOccurrenceReadModel>(),
    responseOccurrences: new Map<string, ResponseOccurrenceReadModel>(),
    responseOccurrenceClaims: new Map<string, string>(),
    taskSubmissions: new Map<string, TaskSubmissionReadModel>(),
    usageStreams: new Map<string, UsageMeasurementStreamReadModel>(),
    usageObservations: new Map<string, UsageObservationReadModel>(),
    usageSettlements: new Map<string, UsageSettlementReadModel>(),
    usageSettlementSourceHeads: new Map<string, UsageSettlementRecord["sourceHeads"][number]>(),
    usageSettlementObservations: new Map<string, UsageSettlementRecord["observations"][number]>(),
    usageObservationClaims: new Map<string, string>(),
    usageEffectObservations: new Map<string, UsageObservationReadModel[]>(),
    usageEffectSettlements: new Map<string, UsageSettlementReadModel[]>(),
  };
}

/** A claim to one of the observation table's two unique indexes. */
function usageObservationClaim(measurementStreamId: string, kind: "ordinal" | "source", value: string | number): string {
  return canonicalJsonStringify([measurementStreamId, kind, value]);
}

/** The key of one head of one revision's cut. */
export function usageSettlementSourceHeadKey(effectId: string, settlementRevision: number, sourceStream: string): string {
  return usageSettlementKey(effectId, settlementRevision) + " " + sourceStream;
}

/** The key of one observation one revision considered. An observation id is free text, so this one is JSON. */
export function usageSettlementObservationKey(
  effectId: string,
  settlementRevision: number,
  observationId: string,
): string {
  return canonicalJsonStringify([effectId, settlementRevision, observationId]);
}

/**
 * The usage fold's view over a snapshot — the rebuild's and `verifyIntegrity`'s
 * answers to `UsageCaptureView`, read off the maps the replay is filling.
 */
export function usageSnapshotView(snapshot: ProjectionSnapshot): UsageCaptureView {
  const ownerOf = (
    row: { readonly taskId: string; readonly revisionNumber: number; readonly attemptNumber: number } | undefined,
  ): OccurrenceOwner | null =>
    row === undefined ? null : { taskId: row.taskId, revisionNumber: row.revisionNumber, attemptNumber: row.attemptNumber };
  return {
    stream: (id) => snapshot.usageStreams.get(id) ?? null,
    observation: (id) => snapshot.usageObservations.get(id) ?? null,
    observationAtOrdinal: (streamId, ordinal) =>
      snapshot.usageObservationClaims.get(usageObservationClaim(streamId, "ordinal", ordinal)) ?? null,
    observationForSourceReport: (streamId, sourceObservationId) =>
      snapshot.usageObservationClaims.get(usageObservationClaim(streamId, "source", sourceObservationId)) ?? null,
    effectObservations: (effectId) => snapshot.usageEffectObservations.get(effectId) ?? [],
    segmentOwner: (routeSegmentId) => ownerOf(snapshot.routeSegments.get(routeSegmentId)),
    effectOwner: (effectId) => ownerOf(snapshot.effects.get(effectId)),
    latestSettlement: (effectId) => {
      const latest = snapshot.usageEffectSettlements.get(effectId)?.at(-1);
      return latest === undefined
        ? null
        : { settlementRevision: latest.settlementRevision, status: latest.settlementStatus, sequence: latest.sequence };
    },
    lastFinalSequence: (effectId) =>
      snapshot.usageEffectSettlements
        .get(effectId)
        ?.filter((revision) => revision.settlementStatus === "FINAL")
        .at(-1)?.sequence ?? null,
  };
}

/** Put what `nextUsageCapture` decided into a snapshot, parents first, indexes with the rows. */
function applyUsageWritesToSnapshot(snapshot: ProjectionSnapshot, writes: UsageCaptureWrites): void {
  if (writes.stream !== null) snapshot.usageStreams.set(writes.stream.measurementStreamId, writes.stream);
  const observation = writes.observation;
  if (observation !== null) {
    snapshot.usageObservations.set(observation.observationId, observation);
    snapshot.usageObservationClaims.set(
      usageObservationClaim(observation.measurementStreamId, "ordinal", observation.ordinal),
      observation.observationId,
    );
    snapshot.usageObservationClaims.set(
      usageObservationClaim(observation.measurementStreamId, "source", observation.sourceObservationId),
      observation.observationId,
    );
    const ofEffect = snapshot.usageEffectObservations.get(observation.effectId) ?? [];
    ofEffect.push(observation);
    snapshot.usageEffectObservations.set(observation.effectId, ofEffect);
  }
  const settlement = writes.settlement;
  if (settlement !== null) {
    const { header } = settlement;
    snapshot.usageSettlements.set(usageSettlementKey(header.effectId, header.settlementRevision), header);
    const revisions = snapshot.usageEffectSettlements.get(header.effectId) ?? [];
    revisions.push(header);
    snapshot.usageEffectSettlements.set(header.effectId, revisions);
    for (const head of settlement.sourceHeads) {
      snapshot.usageSettlementSourceHeads.set(
        usageSettlementSourceHeadKey(head.effectId, head.settlementRevision, head.sourceStream),
        head,
      );
    }
    for (const considered of settlement.observations) {
      snapshot.usageSettlementObservations.set(
        usageSettlementObservationKey(considered.effectId, considered.settlementRevision, considered.observationId),
        considered,
      );
    }
  }
}

export function workerTaskKey(identity: string, taskId: string): string {
  // The identity pattern forbids a space, so this separator cannot collide.
  return identity + " " + taskId;
}

/**
 * The key of one attempt's route row.
 *
 * A task id is a uuid and an attempt is an integer, so neither can contain the
 * separator and the pair cannot collide — the same argument `workerTaskKey`
 * makes about the identity pattern.
 */
export function executionRouteKey(taskId: string, attempt: number): string {
  return taskId + " " + String(attempt);
}

/**
 * Fold one event into an in-memory snapshot.
 *
 * `sha256` is the event's own chain digest, the one its row was written with.
 * Only the usage settlement reads it (P-32/captura B, H-4): a revision's cut is
 * its trigger's head, and a replay has to stamp the digest the door stamped.
 */
export function applyEventToSnapshot(
  snapshot: ProjectionSnapshot,
  event: ControlPlaneEvent,
  sequence: number,
  sha256: string,
): void {
  snapshot.tasks.set(
    event.taskId,
    nextTaskProjection(snapshot.tasks.get(event.taskId) ?? null, event, sequence),
  );

  const pairKey = workerTaskKey(event.emittedBy, event.taskId);
  const existingPair = snapshot.workerTasks.get(pairKey) ?? null;

  snapshot.workers.set(
    event.emittedBy,
    nextWorkerProjection(
      snapshot.workers.get(event.emittedBy) ?? null,
      event,
      sequence,
      existingPair === null,
    ),
  );

  snapshot.workerTasks.set(pairKey, nextWorkerTaskProjection(existingPair, event, sequence));

  // A route row appears only for an event that carries an admitted route, and
  // is keyed by the attempt that ran it. Events without one leave the map
  // untouched, which is what keeps a ledger written before V2-B1c replaying to
  // zero route rows instead of to an error.
  const route = nextExecutionRouteProjection(event, sequence);
  if (route !== null) {
    snapshot.executionRoutes.set(executionRouteKey(route.taskId, route.attempt), route);
  }

  // The revision record, when the event's payload constitutes one. Insert-only
  // here as it is in the table: a second arrival at the same coordinate with
  // different content fails the rebuild rather than overwriting, so a replay
  // and the incremental path refuse the same histories.
  const revision = nextTaskRevisionProjection(event, sequence);
  if (revision !== null) {
    const key = taskRevisionKey(revision.taskId, revision.revisionNumber);
    const existing = snapshot.taskRevisions.get(key);
    if (existing !== undefined) {
      if (!sameRevisionRecord(existing, revision)) {
        throw new LedgerValidationError([
          {
            path: "payload." + REVISION_NUMBER_KEY,
            message:
              "revision " +
              key +
              " is already recorded with different content, and a revision record is written once",
          },
        ]);
      }
    } else {
      snapshot.taskRevisions.set(key, revision);
    }
  }

  // The client key, when the event is an intake (P-14 C). After the revision it
  // is read from, and insert-only on the door's own comparison.
  const submission = nextTaskSubmissionProjection(event, sequence);
  if (submission !== null) {
    const key = taskSubmissionKey(submission.clientScope, submission.clientRequestKey);
    const existing = snapshot.taskSubmissions.get(key);
    if (existing !== undefined) {
      assertSameTaskSubmission(existing, submission);
    } else {
      snapshot.taskSubmissions.set(key, submission);
    }
  }

  // The attempt record, when the event is an opening that carries one. Folded
  // AFTER the revision for the reason the rebuild writes it after: the row is
  // the child of `fk_task_attempt_read_model__task_revision_read_model`, and
  // the opening announces both, so its own revision has to be in the snapshot
  // before the attempt that names it.
  //
  // Insert-only here as it is in the table, and by the same three branches the
  // revision takes — replay, refusal, insert — plus one the revision does not
  // need: the two uniqueness claims. Those are what make N-P18-8's determinism
  // real rather than asserted. A rebuild that quietly reassigned an invocation
  // or a flat number would be the one failure this table exists to prevent, and
  // a rebuild that reached SQLite's indexes instead of refusing here would name
  // a row rather than the event.
  const attempt = nextTaskAttemptProjection(event, sequence);
  if (attempt !== null) {
    const key = taskAttemptKey(attempt.taskId, attempt.revisionNumber, attempt.attemptNumber);
    const existing = snapshot.taskAttempts.get(key);
    if (existing !== undefined) {
      if (canonicalAttempt(existing) !== canonicalAttempt(attempt)) {
        throw new LedgerValidationError([
          {
            path: "payload." + INVOCATION_ID_KEY,
            message:
              "attempt " +
              key +
              " is already recorded with a different identity, and an attempt is opened once",
          },
        ]);
      }
    } else {
      for (const claim of attemptClaims(attempt)) {
        const holder = snapshot.taskAttemptClaims.get(claim);
        if (holder !== undefined) {
          throw new LedgerValidationError([
            {
              path: "payload." + INVOCATION_ID_KEY,
              message:
                "attempt " +
                key +
                " claims " +
                claim +
                ", which attempt " +
                holder +
                " already holds; the attempt and its invocation are a bijection",
            },
          ]);
        }
      }
      for (const claim of attemptClaims(attempt)) snapshot.taskAttemptClaims.set(claim, key);
      snapshot.taskAttempts.set(key, attempt);
    }
  }

  // The P-18/protocolo C cohort, folded parent-first for the reason the attempt
  // follows the revision: a foreign key points each of them at the one above,
  // and a rebuild writes them in this order too.
  //
  // A segment is announced by both intention types, so it is folded outside the
  // type check that guards the other two — an effect's intention announces the
  // initial segment and a dispatch's announces the effective one, which after a
  // handoff is a segment nothing has seen before.
  const segment = nextExecutionRouteSegmentProjection(event, sequence);
  if (segment !== null) {
    const existing = snapshot.routeSegments.get(segment.routeSegmentId);
    if (existing !== undefined) {
      if (canonicalSegment(existing) !== canonicalSegment(segment)) {
        throw new LedgerValidationError([
          {
            path: "payload." + SEGMENT_KEY + ".routeSegmentId",
            message:
              "route segment " +
              segment.routeSegmentId +
              " is already recorded with different content, and a segment is opened once",
          },
        ]);
      }
    } else {
      claimOrRefuse(
        snapshot.routeSegmentClaims,
        segmentClaims(segment),
        segment.routeSegmentId,
        "payload." + SEGMENT_KEY + ".segmentNumber",
      );
      snapshot.routeSegments.set(segment.routeSegmentId, segment);
    }
  }

  const effect = nextEffectProjection(event, sequence);
  if (effect !== null) {
    const existing = snapshot.effects.get(effect.effectId);
    if (existing !== undefined) {
      if (canonicalEffect(existing) !== canonicalEffect(effect)) {
        throw new LedgerValidationError([
          {
            path: "payload." + EFFECT_KEY + ".effectId",
            message:
              "effect " +
              effect.effectId +
              " is already recorded with different content, and an effect is intended once",
          },
        ]);
      }
    } else {
      claimOrRefuse(
        snapshot.effectClaims,
        effectClaims(effect),
        effect.effectId,
        "payload." + EFFECT_KEY + ".logicalOperationSha256",
      );
      snapshot.effects.set(effect.effectId, effect);
    }
  }

  const dispatch = nextDispatchAttemptProjection(event, sequence);
  if (dispatch !== null) {
    const existing = snapshot.dispatchAttempts.get(dispatch.dispatchAttemptId);
    if (existing !== undefined) {
      if (canonicalDispatchBirth(existing) !== canonicalDispatchBirth(dispatch)) {
        throw new LedgerValidationError([
          {
            path: "payload." + DISPATCH_KEY + ".dispatchAttemptId",
            message:
              "delivery " +
              dispatch.dispatchAttemptId +
              " is already recorded with different content, and a delivery is intended once",
          },
        ]);
      }
    } else {
      claimOrRefuse(
        snapshot.dispatchAttemptClaims,
        dispatchClaims(dispatch),
        dispatch.dispatchAttemptId,
        "payload." + DISPATCH_KEY + ".attemptOrdinal",
      );
      snapshot.dispatchAttempts.set(dispatch.dispatchAttemptId, dispatch);
    }
  }

  // The P-32/captura B cohort, after the delivery — whose first one exposes its
  // effect — and through the function the append door calls in `#projectEvent`
  // at the same place, so the stream, the observation and the settlement a
  // rebuild writes are the ones the door wrote, refused in the door's words.
  const usage = nextUsageCapture(usageSnapshotView(snapshot), event, sequence, sha256);
  if (usage !== null) applyUsageWritesToSnapshot(snapshot, usage);

  // The resolution, last, because it reads rows the three folds above may have
  // written in this same event. Unlike them it is a reduce: it replaces a
  // delivery's row and may write an effect's outcome pair. A present-invalid
  // field is refused here with the door's own words (CORR-2): a stored history
  // holding one is a history the door would have refused.
  const outcomeReading = dispatchOutcomeRecord(event, sequence);
  if (outcomeReading?.kind === "refused") {
    throw new LedgerValidationError([{ path: outcomeReading.path, message: outcomeReading.message }]);
  }
  const outcome = outcomeReading === null ? null : outcomeReading.record;
  if (outcome !== null) {
    const current = snapshot.dispatchAttempts.get(outcome.dispatchAttemptId);
    if (current === undefined) {
      throw new LedgerValidationError([
        {
          path: "payload." + OUTCOME_KEY + ".dispatchAttemptId",
          message:
            "no delivery " +
            outcome.dispatchAttemptId +
            " has been intended, and a resolution reports on a delivery that exists",
        },
      ]);
    }

    // The anchor `#assertDispatchOutcome` holds at the door, held here too: a
    // delivery is found by a global id, so the coordinate the event names has
    // to be the one that owns the delivery's effect. Without it a rebuild would
    // reproduce a resolution the door refuses, and `verifyIntegrity` could
    // never tell the two apart.
    const owner = snapshot.effects.get(current.effectId);
    if (owner === undefined) {
      throw new LedgerValidationError([
        {
          path: "payload." + OUTCOME_KEY + ".dispatchAttemptId",
          message:
            "delivery " +
            outcome.dispatchAttemptId +
            " names effect " +
            current.effectId +
            ", which no event accounts for",
        },
      ]);
    }
    const revisionNumber = payloadCount(event.payload, REVISION_NUMBER_KEY);
    const attemptNumber = payloadCount(event.payload, ATTEMPT_NUMBER_KEY);
    if (
      owner.taskId !== event.taskId ||
      owner.revisionNumber !== revisionNumber ||
      owner.attemptNumber !== attemptNumber
    ) {
      throw new LedgerValidationError([
        {
          path: "payload." + OUTCOME_KEY + ".dispatchAttemptId",
          message:
            "delivery " +
            outcome.dispatchAttemptId +
            " serves effect " +
            owner.effectId +
            " of attempt " +
            taskAttemptKey(owner.taskId, owner.revisionNumber, owner.attemptNumber) +
            " and this resolution is recorded at " +
            (revisionNumber === null || attemptNumber === null
              ? "no coordinate at all"
              : "attempt " + taskAttemptKey(event.taskId, revisionNumber, attemptNumber)),
        },
      ]);
    }

    // A repetition of the state the row already holds is a replay and writes
    // nothing; anything else must be a lawful forward move. Together those two
    // branches are what make a retried append safe without admitting a
    // delivery that goes backwards out of a terminal state.
    if (current.dispatchState !== outcome.dispatchState) {
      if (!dispatchTransitionAdmitted(current.dispatchState, outcome.dispatchState)) {
        throw new LedgerValidationError([
          {
            path: "payload." + OUTCOME_KEY + ".dispatchState",
            message:
              "delivery " +
              outcome.dispatchAttemptId +
              " is " +
              current.dispatchState +
              " and may move only to " +
              (DISPATCH_STATE_TRANSITIONS[current.dispatchState].join(", ") || "nothing"),
          },
        ]);
      }
      snapshot.dispatchAttempts.set(
        outcome.dispatchAttemptId,
        nextDispatchAttemptState(current, outcome),
      );
    }

    if (outcome.effectOutcomeStatus !== null) {
      // §6 `:252`: an outcome is recorded, not amended. A terminal one is
      // reused and an uncertain one demands reconciliation — neither is
      // overwritten by a second answer to the same question. The comparison,
      // result pair included, is the door's own (ADR 0098).
      const arrival = effectOutcomeArrival(owner, outcome);
      if (arrival.kind === "refused") {
        throw new LedgerValidationError([{ path: arrival.path, message: arrival.message }]);
      }
      if (arrival.kind === "write") {
        snapshot.effects.set(current.effectId, {
          ...owner,
          outcomeStatus: outcome.effectOutcomeStatus,
          outcomeRecordedAt: outcome.recordedAt,
          outcomeContractVersion: event.contractVersion,
          resultArtifactReferenceId: outcome.resultArtifactReferenceId,
          resultSha256: outcome.resultSha256,
        });
      }
    }
  }

  // The P-18/protocolo D pair, after every fold above because each reads rows
  // they write: a prompt names a delivery, and a batch may intend the delivery
  // and record the prompt in one transaction (§8 `:419-420`). Insert-only, and
  // no ordinal compare-and-set here — that is the door's, on escalón C's
  // precedent for `operation_ordinal`, and every stored event passed it.
  const prompt = nextPromptOccurrenceProjection(event, sequence);
  if (prompt !== null) {
    const delivery = snapshot.dispatchAttempts.get(prompt.dispatchAttemptId) ?? null;
    const refusal = promptOccurrenceLinkRefusal(
      event,
      prompt,
      delivery,
      delivery === null ? null : (snapshot.effects.get(delivery.effectId) ?? null),
    );
    if (refusal !== null) throw new LedgerValidationError([refusal]);

    const existing = snapshot.promptOccurrences.get(prompt.occurrenceId);
    if (existing === undefined) {
      snapshot.promptOccurrences.set(prompt.occurrenceId, prompt);
    } else if (canonicalPromptOccurrence(existing) !== canonicalPromptOccurrence(prompt)) {
      throw new LedgerValidationError([
        {
          path: "payload." + PROMPT_OCCURRENCE_KEY + ".occurrenceId",
          message:
            "prompt occurrence " +
            printable(prompt.occurrenceId) +
            " is already recorded with different content, and an occurrence is recorded once",
        },
      ]);
    }
  }

  const response = nextResponseOccurrenceProjection(event, sequence);
  if (response !== null) {
    // The prompt's own `effectId` is its delivery's — the fold above refused
    // any prompt where the two differ — so the attempt that owns the answer is
    // read straight off the prompt's effect.
    const answered = snapshot.promptOccurrences.get(response.promptOccurrenceId) ?? null;
    const holder = snapshot.responseOccurrenceClaims.get(response.promptOccurrenceId);
    const refusal = responseOccurrenceLinkRefusal(
      event,
      response,
      answered !== null,
      answered === null ? null : (snapshot.effects.get(answered.effectId) ?? null),
      holder === undefined || holder === response.occurrenceId ? null : holder,
    );
    if (refusal !== null) throw new LedgerValidationError([refusal]);

    const existing = snapshot.responseOccurrences.get(response.occurrenceId);
    if (existing === undefined) {
      snapshot.responseOccurrences.set(response.occurrenceId, response);
      snapshot.responseOccurrenceClaims.set(response.promptOccurrenceId, response.occurrenceId);
    } else if (canonicalResponseOccurrence(existing) !== canonicalResponseOccurrence(response)) {
      throw new LedgerValidationError([
        {
          path: "payload." + RESPONSE_OCCURRENCE_KEY + ".occurrenceId",
          message:
            "response occurrence " +
            printable(response.occurrenceId) +
            " is already recorded with different content, and an occurrence is recorded once",
        },
      ]);
    }
  }
}

/**
 * Take a set of uniqueness claims for one row, or refuse naming the holder.
 *
 * Factored out of the three folds above rather than written three times: they
 * make the same argument `attemptClaims` makes, and a refusal that could not
 * say which claim collided would send an operator to a constraint name instead
 * of to an event.
 */
function claimOrRefuse(
  claims: Map<string, string>,
  proposed: readonly string[],
  owner: string,
  path: string,
): void {
  for (const claim of proposed) {
    const holder = claims.get(claim);
    if (holder !== undefined) {
      throw new LedgerValidationError([
        {
          path,
          message:
            owner + " claims " + claim + ", which " + holder + " already holds",
        },
      ]);
    }
  }
  for (const claim of proposed) claims.set(claim, owner);
}

/**
 * The comparable form of a revision row: what the revision *is*, and nothing
 * about the arrival that happened to record it (F-1, ADR 0072).
 *
 * Three fields — `revisionId`, `envelopeSha256`, `restoredFromRevisionId` —
 * because those three are the revision. Everything else on the row is either
 * its coordinate, which is the key both callers look the row up by and so
 * cannot differ across a comparison, or a birth attribute: `sequence`,
 * `createdAt`, `createdBy` and `contractVersion` each record the arrival that
 * first announced the revision, not the revision.
 *
 * `sequence` was already excluded, for the reason that generalizes to the other
 * three: an exact replay landing at a later position is the SAME revision, and
 * refusing it for the position alone would turn an idempotent retry into a
 * conflict. The others were not excluded, and that cost two things. A second
 * attempt of one revision — which by execution §3 is "un reintento de la misma
 * revisión, no una revisión nueva" — could not carry its own `occurredAt`, so
 * the only way to advance `latest_attempt_number` was to restate the first
 * arrival's timestamp, which is to say to lie about when the attempt happened.
 * And `contractVersion` made the comparison version-sensitive: once
 * `SUPPORTED_CONTRACT_VERSIONS` grows and a producer stamps a newer member, a
 * second attempt of a revision opened under the older one would have conflicted
 * against its own row while agreeing about every fact recorded in it.
 *
 * The refusal this preserves is the one that matters: a second arrival at one
 * coordinate naming a *different* envelope, revision id or restore source is
 * still refused, because those are two answers to "what was asked".
 *
 * Exported because the incremental door and the snapshot must decide this
 * identically. Two implementations of "same content" are two definitions of it,
 * and a rebuild that refused a history the door had accepted would leave
 * `verifyIntegrity` comparing a stored projection against a different rule.
 * Since P-36/local D the two callers reach it through `sameRevisionRecord`,
 * which adds the envelope reference where the stored row holds one.
 */
export function canonicalRevision(revision: TaskRevisionReadModel): string {
  return [
    revision.revisionId,
    revision.envelopeSha256,
    revision.restoredFromRevisionId ?? "",
  ].join("\u0000");
}

/**
 * Whether a second arrival at a stored revision's coordinate is the same
 * record (P-36/local D, Q-D2).
 *
 * `canonicalRevision`'s three facts, always, and the envelope reference **only
 * when the stored row holds one**. A row of the new cohort holds a reference,
 * so a second arrival naming another one — or none — is two answers to where
 * the envelope's bytes are, and is refused; the same reference is a replay. A
 * row of the cohort before holds `null` for ever: the table is insert-only and
 * the trigger keeps it so. A second attempt of such a revision, stamped after
 * the upgrade, arrives carrying the reference its own version requires, and
 * comparing it against a `null` nobody may ever fill would leave every revision
 * in flight at the upgrade without a second attempt. So that comparison is the
 * three facts as before, and the arrival's reference stays in the log, not in
 * the row.
 *
 * Exported for `canonicalRevision`'s reason: the append door and the snapshot
 * decide "same revision" with this one function, so the incremental path and a
 * rebuild refuse exactly the same histories.
 */
export function sameRevisionRecord(
  stored: TaskRevisionReadModel,
  arriving: TaskRevisionReadModel,
): boolean {
  if (canonicalRevision(stored) !== canonicalRevision(arriving)) return false;
  return (
    stored.envelopeArtifactReferenceId === null ||
    stored.envelopeArtifactReferenceId === arriving.envelopeArtifactReferenceId
  );
}

// ---------------------------------------------------------------------------
// P-18/protocolo F — the outbox command, its deliveries and what was heard.
// ---------------------------------------------------------------------------

export const OUTBOX_COMMAND_INTENDED: ControlPlaneEvent["type"] = "OUTBOX_COMMAND_INTENDED";
export const OUTBOX_DELIVERY_INTENDED: ControlPlaneEvent["type"] = "OUTBOX_DELIVERY_INTENDED";
export const OUTBOX_DELIVERY_OBSERVED: ControlPlaneEvent["type"] = "OUTBOX_DELIVERY_OBSERVED";

/** The three types, in the order a command lives through them. */
export const OUTBOX_EVENT_TYPES: readonly ControlPlaneEvent["type"][] = [
  OUTBOX_COMMAND_INTENDED,
  OUTBOX_DELIVERY_INTENDED,
  OUTBOX_DELIVERY_OBSERVED,
];

/**
 * The neutral payload version coordination §6.2 `:303-304` fixes.
 *
 * One member. A payload stamped with anything else is refused rather than read
 * as this version, because a grammar nobody wrote down is not one this door can
 * check.
 */
export const OUTBOX_CONTRACT_VERSION = 1;

/** §6.2 `:304-306`: the intention's payload, and nothing beside it. */
export const OUTBOX_COMMAND_INTENTION_KEYS = [
  "outboxContractVersion",
  "sagaId",
  "commandId",
  "phase",
  "commandKind",
  "intentStream",
  "targetKind",
  "targetId",
  "deadlineAt",
  "fence",
  "targetStoreIncarnationId",
] as const;

/** §6.2 `:306`: the attempt's payload. */
export const OUTBOX_DELIVERY_ATTEMPT_KEYS = [
  "outboxContractVersion",
  "commandId",
  "deliveryAttemptId",
] as const;

/** §6.2 `:307-308`: the observation's payload. */
export const OUTBOX_DELIVERY_OBSERVATION_KEYS = [
  "outboxContractVersion",
  "commandId",
  "deliveryAttemptId",
  "outboxState",
  "failureCode",
  "responseHandle",
] as const;

/**
 * The V1 matrix of coordination §6.2 `:287-292`, closed.
 *
 * Which streams may anchor the intention, the attempt and the acknowledgement
 * of each kind. `registry_events` anchors none: it may be a causal *source* of
 * configuration and never the anchor of an operative command (`:294-295`).
 *
 * The whole matrix is declared here, and this package realises one column of
 * it: the task stream's door admits a kind only when the intention names
 * `control_plane_events`. The `initiative_events` and `account_events` rows
 * belong to those streams' doors, which a later escalón opens (ADR 0078).
 */
export const OUTBOX_V1_COMMAND_STREAMS: Readonly<Record<OutboxCommandKind, readonly OutboxStream[]>> =
  Object.freeze({
    RELEASE_RESERVATION: ["control_plane_events"],
    REVOKE_LEASE: ["control_plane_events"],
    NOTIFY: ["control_plane_events", "initiative_events", "account_events"],
    EXPORT_TELEMETRY: ["control_plane_events", "initiative_events"],
  });

/** The states a failure word may accompany, and the two that require one. */
const OUTBOX_FAILURE_STATES: readonly OutboxState[] = ["FAILED_RETRYABLE", "FAILED_TERMINAL", "ABANDONED"];
const OUTBOX_FAILURE_REQUIRED: readonly OutboxState[] = ["FAILED_RETRYABLE", "FAILED_TERMINAL"];

/** A lowercase canonical UUID, the shape `sagaId` and `deliveryAttemptId` take. */
const OUTBOX_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A phase or a target kind: a screaming-snake word, never prose. */
const OUTBOX_WORD_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The same instant grammar every other timestamp in this ledger carries. */
const OUTBOX_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The longest reference a target id or a response handle may be. */
const OUTBOX_REFERENCE_MAX = 512;

/** Any C0 control character, or DEL. */
// eslint-disable-next-line no-control-regex
const OUTBOX_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function isOutboxReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= OUTBOX_REFERENCE_MAX &&
    !OUTBOX_CONTROL_PATTERN.test(value)
  );
}

function isOutboxInstant(value: unknown): value is string {
  if (typeof value !== "string" || !OUTBOX_INSTANT_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * The preimage of `command_id`, version 1 — coordination §6 `:221`, ADR 0078.
 *
 * The four members in §6's order, under the contract's prefix.
 * `effectIdPreimageV1` is the shape followed, for its reasons: the grammar is
 * `@acp/contracts`', the canonicalizer and the sha-256 are this package's.
 */
export function outboxCommandIdPreimageV1(input: {
  readonly sagaId: string;
  readonly phase: string;
  readonly targetKind: string;
  readonly targetId: string;
}): string {
  return (
    OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1 +
    canonicalJsonStringify([input.sagaId, input.phase, input.targetKind, input.targetId])
  );
}

/**
 * The command's identity: the digest of the preimage above.
 *
 * Exported so the producer and the door compute it the one way. A producer
 * proposes it in the intention and the door recomputes it; `@acp/runtime`'s
 * quarantine builder calls this rather than restating it, which is what "runtime
 * mints nothing" means for a value that is derived rather than chosen.
 */
export function computeOutboxCommandId(input: Parameters<typeof outboxCommandIdPreimageV1>[0]): string {
  return sha256Hex(outboxCommandIdPreimageV1(input));
}

function outboxRefused(path: string, message: string): OutboxReading {
  return { kind: "refused", path, message };
}

/** The outer shape all three share: a closed key set, the version, and no state move. */
function outboxEnvelope(event: ControlPlaneEvent, keys: readonly string[]): OutboxReading | null {
  const stray = undeclaredKey(event.payload, keys);
  if (stray !== null) {
    return outboxRefused(
      "payload." + printable(stray),
      event.type +
        " carries exactly " +
        keys.join(", ") +
        "; " +
        printable(stray) +
        " is not part of that grammar, and a command payload carries references and vocabulary " +
        "words, never credentials or a provider's prose",
    );
  }
  if (event.payload["outboxContractVersion"] !== OUTBOX_CONTRACT_VERSION) {
    return outboxRefused(
      "payload.outboxContractVersion",
      event.type + " is versioned outboxContractVersion = " + String(OUTBOX_CONTRACT_VERSION),
    );
  }
  // §6.2 `:314-315`: on a task these are same-state events, and they claim
  // neither an execution of the task nor an approval.
  if (event.fromState !== event.toState) {
    return outboxRefused(
      "toState",
      event.type +
        " is a same-state event and moves no task; this one moves " +
        String(event.fromState) +
        " to " +
        event.toState,
    );
  }
  return null;
}

function outboxCommandIdOf(event: ControlPlaneEvent): string | null {
  const value = event.payload["commandId"];
  return typeof value === "string" && OCCURRENCE_DIGEST_PATTERN.test(value) ? value : null;
}

/**
 * Read one outbox event off the stream — coordination §6.2.
 *
 * `null` for every other type. Everything one event can be wrong about is
 * decided here, **including the V1 matrix and the recomputed identity**, because
 * both are facts about the event alone: a kind outside the vocabulary or a
 * stream the matrix does not list is refused `CAPABILITY_UNSUPPORTED` before any
 * command exists (`:295-296`), and a `commandId` that is not the digest of the
 * event's own four members is refused before it can name anything.
 */
export function readOutboxEvent(event: ControlPlaneEvent): OutboxReading | null {
  if (event.type === OUTBOX_COMMAND_INTENDED) return readOutboxIntention(event);
  if (event.type === OUTBOX_DELIVERY_INTENDED) return readOutboxAttempt(event);
  if (event.type === OUTBOX_DELIVERY_OBSERVED) return readOutboxObservation(event);
  return null;
}

function readOutboxIntention(event: ControlPlaneEvent): OutboxReading {
  const envelope = outboxEnvelope(event, OUTBOX_COMMAND_INTENTION_KEYS);
  if (envelope !== null) return envelope;
  const payload = event.payload;

  // The matrix first, because §6.2 `:295-296` places its refusal before the
  // command is created, and a kind this build does not serve is not a command
  // whose other fields are worth reading.
  const kind = payload["commandKind"];
  if (typeof kind !== "string" || !(OUTBOX_COMMAND_KINDS as readonly string[]).includes(kind)) {
    return outboxRefused(
      "payload.commandKind",
      "CAPABILITY_UNSUPPORTED: the V1 command kinds are " +
        OUTBOX_COMMAND_KINDS.join(", ") +
        (typeof kind === "string" ? " and this intention names " + printable(kind) : ""),
    );
  }
  const commandKind = kind as OutboxCommandKind;
  const stream = payload["intentStream"];
  if (typeof stream !== "string" || !(OUTBOX_STREAMS as readonly string[]).includes(stream)) {
    return outboxRefused(
      "payload.intentStream",
      "CAPABILITY_UNSUPPORTED: an intention names one of the four streams " + OUTBOX_STREAMS.join(", "),
    );
  }
  const intentStream = stream as OutboxStream;
  if (!OUTBOX_V1_COMMAND_STREAMS[commandKind].includes(intentStream)) {
    return outboxRefused(
      "payload.intentStream",
      "CAPABILITY_UNSUPPORTED: " +
        commandKind +
        " is anchored on " +
        OUTBOX_V1_COMMAND_STREAMS[commandKind].join(", ") +
        " and never on " +
        intentStream +
        "; no task, initiative or registry document is invented to host it",
    );
  }
  if (intentStream !== "control_plane_events") {
    return outboxRefused(
      "payload.intentStream",
      "CAPABILITY_UNSUPPORTED: " +
        commandKind +
        " on " +
        intentStream +
        " is a row of the V1 matrix that its own stream's door realises; the intention, the " +
        "attempt and the acknowledgement use the stream of the original row, and this is the " +
        "control_plane_events door",
    );
  }

  const sagaId = payload["sagaId"];
  if (typeof sagaId !== "string" || !OUTBOX_UUID_PATTERN.test(sagaId)) {
    return outboxRefused(
      "payload.sagaId",
      "a saga is grouped under a lowercase UUID the caller supplies; nothing in this ledger mints one",
    );
  }
  const phase = payload["phase"];
  if (typeof phase !== "string" || !OUTBOX_WORD_PATTERN.test(phase)) {
    return outboxRefused("payload.phase", "the phase is a screaming-snake word of at most 64 characters");
  }
  const targetKind = payload["targetKind"];
  if (typeof targetKind !== "string" || !OUTBOX_WORD_PATTERN.test(targetKind)) {
    return outboxRefused(
      "payload.targetKind",
      "the target kind is a screaming-snake word of at most 64 characters",
    );
  }
  const targetId = payload["targetId"];
  if (!isOutboxReference(targetId)) {
    return outboxRefused(
      "payload.targetId",
      "the target id is a reference of 1 to " +
        String(OUTBOX_REFERENCE_MAX) +
        " characters with no control character",
    );
  }
  const deadlineAt = payload["deadlineAt"];
  if (!isOutboxInstant(deadlineAt)) {
    return outboxRefused("payload.deadlineAt", "the deadline is an ISO-8601 instant in UTC with milliseconds");
  }

  // The fence and the target's incarnation are one token or none (§6 `:239-240`,
  // §8.1 `:389`). Each nullity is tested on its own before either is compared,
  // which is the trap E2's CHECK met: a disjunction of lawful shapes passes the
  // half pair it exists to refuse.
  const fenceValue = payload["fence"];
  const incarnationValue = payload["targetStoreIncarnationId"];
  const fenceAbsent = fenceValue === undefined || fenceValue === null;
  const incarnationAbsent = incarnationValue === undefined || incarnationValue === null;
  if (fenceAbsent !== incarnationAbsent) {
    return outboxRefused(
      fenceAbsent ? "payload.fence" : "payload.targetStoreIncarnationId",
      "a fence and the target store incarnation travel together as one token, or neither does; " +
        "a number without the file that issued it proves nothing",
    );
  }
  if (!fenceAbsent) {
    if (typeof fenceValue !== "number" || !Number.isSafeInteger(fenceValue) || fenceValue < 1) {
      return outboxRefused("payload.fence", "a fence is a positive safe integer");
    }
    if (typeof incarnationValue !== "string" || !OUTBOX_UUID_PATTERN.test(incarnationValue)) {
      return outboxRefused("payload.targetStoreIncarnationId", "a target store incarnation is a lowercase UUID");
    }
  }

  // The identity, recomputed rather than believed (N-F-2).
  const commandId = payload["commandId"];
  const expected = computeOutboxCommandId({ sagaId, phase, targetKind, targetId });
  if (commandId !== expected) {
    return outboxRefused(
      "payload.commandId",
      "the command id is the digest of its saga, phase, target kind and target id under the " +
        "versioned prefix; this ledger computes " +
        expected +
        " and the event states " +
        (typeof commandId === "string" ? printable(commandId) : "none"),
    );
  }

  return {
    kind: "intention",
    row: {
      sagaId,
      commandId: expected,
      phase,
      commandKind,
      intentStream,
      targetKind,
      targetId,
      deadlineAt,
      fence: fenceAbsent ? null : fenceValue,
      targetStoreIncarnationId: incarnationAbsent ? null : (incarnationValue as string),
    },
  };
}

function readOutboxAttempt(event: ControlPlaneEvent): OutboxReading {
  const envelope = outboxEnvelope(event, OUTBOX_DELIVERY_ATTEMPT_KEYS);
  if (envelope !== null) return envelope;
  const commandId = outboxCommandIdOf(event);
  if (commandId === null) {
    return outboxRefused("payload.commandId", "a delivery attempt names its command by its sha-256 id");
  }
  const deliveryAttemptId = event.payload["deliveryAttemptId"];
  if (typeof deliveryAttemptId !== "string" || !OUTBOX_UUID_PATTERN.test(deliveryAttemptId)) {
    return outboxRefused(
      "payload.deliveryAttemptId",
      "a delivery attempt is named by a lowercase UUID the dispatcher supplies",
    );
  }
  return { kind: "attempt", row: { commandId, deliveryAttemptId } };
}

function readOutboxObservation(event: ControlPlaneEvent): OutboxReading {
  const envelope = outboxEnvelope(event, OUTBOX_DELIVERY_OBSERVATION_KEYS);
  if (envelope !== null) return envelope;
  const payload = event.payload;
  const commandId = outboxCommandIdOf(event);
  if (commandId === null) {
    return outboxRefused("payload.commandId", "an observation names its command by its sha-256 id");
  }
  const deliveryAttemptId = payload["deliveryAttemptId"];
  if (typeof deliveryAttemptId !== "string" || !OUTBOX_UUID_PATTERN.test(deliveryAttemptId)) {
    return outboxRefused(
      "payload.deliveryAttemptId",
      "an observation names the delivery attempt it reports on by its UUID",
    );
  }
  const state = payload["outboxState"];
  if (typeof state !== "string" || !(OUTBOX_STATES as readonly string[]).includes(state)) {
    return outboxRefused("payload.outboxState", "the observed state is one of " + OUTBOX_STATES.join(", "));
  }
  const outboxState = state as OutboxState;

  // Decision 45's column, typed when it is written (Q-E6).
  const code = payload["failureCode"];
  let failureCode: OutboxFailureCode | null = null;
  if (code !== undefined && code !== null) {
    if (typeof code !== "string" || !(OUTBOX_FAILURE_CODES as readonly string[]).includes(code)) {
      return outboxRefused(
        "payload.failureCode",
        "a failure code is one of " + OUTBOX_FAILURE_CODES.join(", ") + ", never free text",
      );
    }
    failureCode = code as OutboxFailureCode;
  }
  if (failureCode !== null && !OUTBOX_FAILURE_STATES.includes(outboxState)) {
    return outboxRefused(
      "payload.failureCode",
      "a failure code accompanies only " +
        OUTBOX_FAILURE_STATES.join(", ") +
        ", and this observation says " +
        outboxState,
    );
  }
  if (failureCode === null && OUTBOX_FAILURE_REQUIRED.includes(outboxState)) {
    return outboxRefused(
      "payload.failureCode",
      outboxState +
        " says why, in a word of the failure vocabulary; a failure recorded without its code " +
        "would rebuild a cache row that claims it never failed",
    );
  }

  const handle = payload["responseHandle"];
  if (handle !== undefined && handle !== null && !isOutboxReference(handle)) {
    return outboxRefused(
      "payload.responseHandle",
      "a response handle is an opaque reference of 1 to " +
        String(OUTBOX_REFERENCE_MAX) +
        " characters with no control character, never a secret",
    );
  }

  return {
    kind: "observation",
    row: {
      commandId,
      deliveryAttemptId,
      outboxState,
      failureCode,
      responseHandle: handle ?? null,
    },
  };
}

/**
 * Whether an event is a quarantine — contracts §13 `:559-561`, datos §11 `:546-550`.
 *
 * Two shapes, and both are the ones this tree already emits: the finding
 * (`WRITE_SET_VIOLATION_DETECTED`) and the task's move to `SUSPECT_WORKTREE`.
 * `LEASE_REVOKED` is **not** one of them: it records a revocation that happened,
 * and inside the ledger's transaction nothing has happened at the arbiter yet —
 * what commits there is the intention to revoke.
 */
export function isQuarantineEvent(event: Pick<ControlPlaneEvent, "type" | "toState">): boolean {
  return (
    event.type === "WRITE_SET_VIOLATION_DETECTED" ||
    (event.type === "TASK_STATE_CHANGED" && event.toState === "SUSPECT_WORKTREE")
  );
}

/**
 * The comparable form of a command's birth: everything its intention fixed.
 *
 * No state, no counter, no anchor and no instant: those are what the command
 * became or where it was recorded, and a second intention is compared on what
 * it asks for.
 */
export function canonicalOutboxCommand(command: OutboxCommandReadModel): string {
  return canonicalJsonStringify({
    commandId: command.commandId,
    sagaId: command.sagaId,
    phase: command.phase,
    commandKind: command.commandKind,
    intentStream: command.intentStream,
    targetKind: command.targetKind,
    targetId: command.targetId,
    deadlineAt: command.deadlineAt,
    fence: command.fence,
    targetStoreIncarnationId: command.targetStoreIncarnationId,
    taskId: command.taskId,
  });
}

/** Whether a causal reference names exactly one event of the task stream. */
function causationNames(causation: CausationRef | null, sequence: number, sha256: string): boolean {
  return (
    causation !== null &&
    causation.stream === "control_plane_events" &&
    causation.sequence === sequence &&
    causation.sha256 === sha256
  );
}

/**
 * Why one outbox event cannot attach to what it names, or `null`.
 *
 * Shared by the append door, which supplies `command` and `attempt` by folding
 * the command's own history off the base, and by the fold, which reads them off
 * its maps — so a rebuild refuses exactly the histories the door refuses, at the
 * event that caused them. `predecessor` is the event immediately before this one:
 * inside the batch at the door, in the stream at the fold.
 *
 * **An intention** is intended once. And a `REVOKE_LEASE` intention commits in
 * the same transaction as the quarantine it answers, immediately after that
 * quarantine's event and on the same task (contracts §13 `:559-561`): a
 * quarantine without its intention, or an intention without its quarantine, is
 * the three-transaction window datos §11 `:547` closes.
 *
 * **An attempt** serves a command that exists, on the command's own subject, and
 * names the intention as its cause. A new attempt needs the command `PENDING`;
 * the same attempt again is a replay and counts once (§6.2 `:321`).
 *
 * **An observation** reports on the command's current attempt, names that
 * attempt as its cause, and moves the state by §2's transitions. Nothing leaves
 * a terminal state and nothing amends one.
 */
export function outboxLinkRefusal(
  entry: Pick<OutboxEventEntry, "event" | "causation">,
  reading: Exclude<OutboxReading, { readonly kind: "refused" }>,
  command: OutboxCommandReadModel | null,
  attempt: OutboxAttemptRecord | null,
  predecessor: OutboxPredecessor | null,
): OccurrenceRefusal | null {
  const { event, causation } = entry;

  if (reading.kind === "intention") {
    const row = reading.row;
    if (command !== null) {
      const proposed = canonicalOutboxCommand(outboxCommandBirth(event, row, 0, "", command.createdAt));
      return {
        path: "payload.commandId",
        message:
          canonicalOutboxCommand(command) === proposed
            ? "command " +
              row.commandId +
              " is already intended; a command is intended once, and retrying it conserves its " +
              "saga and command ids rather than intending it again"
            : "CONFLICT: command " +
              row.commandId +
              " is already intended with a different kind, deadline, token or task; one saga, " +
              "phase and target name one command",
      };
    }
    if (
      row.commandKind === "REVOKE_LEASE" &&
      (predecessor === null || predecessor.taskId !== event.taskId || !isQuarantineEvent(predecessor))
    ) {
      return {
        path: "payload.commandKind",
        message:
          "a REVOKE_LEASE intention commits in one appendBatch with the quarantine it answers, " +
          "immediately after that quarantine's event on the same task; a quarantine and its " +
          "intention to revoke commit together or not at all",
      };
    }
    return null;
  }

  const commandId = reading.row.commandId;
  if (command === null) {
    return {
      path: "payload.commandId",
      message:
        "no command " +
        commandId +
        " has been intended, and " +
        (reading.kind === "attempt" ? "a delivery attempt" : "an observation") +
        " serves a command that exists",
    };
  }
  if (command.taskId !== event.taskId) {
    return {
      path: "payload.commandId",
      message:
        "command " +
        commandId +
        " belongs to task " +
        command.taskId +
        ", and its attempts and observations use the stream and subject of the original row",
    };
  }

  if (reading.kind === "attempt") {
    if (!causationNames(causation, command.intentSequence, command.intentSha256)) {
      return {
        path: "causation",
        message:
          "a delivery attempt names the intention it serves as its cause: control_plane_events, " +
          "sequence " +
          String(command.intentSequence) +
          ", digest " +
          command.intentSha256,
      };
    }
    if (attempt !== null) {
      if (attempt.commandId !== commandId) {
        return {
          path: "payload.deliveryAttemptId",
          message:
            "delivery attempt " +
            reading.row.deliveryAttemptId +
            " belongs to command " +
            attempt.commandId +
            ", and an attempt serves one command",
        };
      }
      return null;
    }
    if (command.state !== "PENDING") {
      return {
        path: "payload.deliveryAttemptId",
        message:
          "a new delivery attempt needs its command PENDING, and command " +
          commandId +
          " is " +
          command.state +
          "; an uncertain delivery is reconciled, never resent",
      };
    }
    return null;
  }

  const row = reading.row;
  if (attempt?.commandId !== commandId) {
    return {
      path: "payload.deliveryAttemptId",
      message:
        "delivery attempt " +
        row.deliveryAttemptId +
        " has not been intended for command " +
        commandId +
        ", and an observation affects only the command and the attempt it names",
    };
  }
  if (command.lastDeliveryAttemptId !== row.deliveryAttemptId) {
    return {
      path: "payload.deliveryAttemptId",
      message:
        "command " +
        commandId +
        " is on delivery attempt " +
        String(command.lastDeliveryAttemptId) +
        ", and an observation reports on the attempt in force; " +
        row.deliveryAttemptId +
        " was superseded",
    };
  }
  if (!causationNames(causation, attempt.sequence, attempt.sha256)) {
    return {
      path: "causation",
      message:
        "an observation names the delivery attempt it reports on as its cause: " +
        "control_plane_events, sequence " +
        String(attempt.sequence) +
        ", digest " +
        attempt.sha256,
    };
  }
  if ((OUTBOX_TERMINAL_STATES as readonly string[]).includes(command.state)) {
    return {
      path: "payload.outboxState",
      message:
        "command " +
        commandId +
        " is " +
        command.state +
        ", which is terminal; nothing leaves a terminal state and nothing amends one",
    };
  }
  const lawful = OUTBOX_TRANSITIONS.get(command.state) ?? [];
  if (row.outboxState !== command.state && !lawful.includes(row.outboxState)) {
    return {
      path: "payload.outboxState",
      message:
        "command " +
        commandId +
        " is " +
        command.state +
        " and may move only to " +
        (lawful.join(", ") || "nothing"),
    };
  }
  return null;
}

function outboxCommandBirth(
  event: ControlPlaneEvent,
  row: OutboxCommandIntention,
  sequence: number,
  sha256: string,
  createdAt: string,
): OutboxCommandReadModel {
  return {
    commandId: row.commandId,
    sagaId: row.sagaId,
    phase: row.phase,
    commandKind: row.commandKind,
    targetKind: row.targetKind,
    targetId: row.targetId,
    deadlineAt: row.deadlineAt,
    fence: row.fence,
    targetStoreIncarnationId: row.targetStoreIncarnationId,
    taskId: event.taskId,
    intentStream: row.intentStream,
    intentSequence: sequence,
    intentSha256: sha256,
    state: "PENDING",
    attemptCount: 0,
    lastDeliveryAttemptId: null,
    lastAttemptStream: null,
    lastAttemptSequence: null,
    lastAttemptSha256: null,
    lastFailureCode: null,
    responseHandle: null,
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * What one admitted outbox event does to its command — the reduce.
 *
 * Pure, and called only after `outboxLinkRefusal` returned `null`. An intention
 * is born `PENDING`. A new attempt counts once and leaves the command
 * `RECONCILING`, anchored on the attempt's own event; a replayed attempt changes
 * nothing. An observation moves the state and keeps the last failure code and
 * the last handle any observation carried.
 */
export function nextOutboxCommand(
  entry: OutboxEventEntry,
  reading: Exclude<OutboxReading, { readonly kind: "refused" }>,
  command: OutboxCommandReadModel | null,
  attempt: OutboxAttemptRecord | null,
): { readonly command: OutboxCommandReadModel; readonly attempt: OutboxAttemptRecord | null } {
  const { event, sequence, sha256 } = entry;
  if (reading.kind === "intention") {
    return {
      command: outboxCommandBirth(event, reading.row, sequence, sha256, event.recordedAt),
      attempt: null,
    };
  }
  if (command === null) {
    throw new LedgerValidationError([
      { path: "payload.commandId", message: "no command " + reading.row.commandId + " has been intended" },
    ]);
  }
  if (reading.kind === "attempt") {
    if (attempt !== null) return { command, attempt };
    return {
      command: {
        ...command,
        state: "RECONCILING",
        attemptCount: command.attemptCount + 1,
        lastDeliveryAttemptId: reading.row.deliveryAttemptId,
        lastAttemptStream: "control_plane_events",
        lastAttemptSequence: sequence,
        lastAttemptSha256: sha256,
        updatedAt: event.recordedAt,
      },
      attempt: {
        deliveryAttemptId: reading.row.deliveryAttemptId,
        commandId: reading.row.commandId,
        sequence,
        sha256,
      },
    };
  }
  return {
    command: {
      ...command,
      state: reading.row.outboxState,
      lastFailureCode: reading.row.failureCode ?? command.lastFailureCode,
      responseHandle: reading.row.responseHandle ?? command.responseHandle,
      updatedAt: event.recordedAt,
    },
    attempt,
  };
}

export function createOutboxFold(): OutboxFold {
  return {
    commands: new Map<string, OutboxCommandReadModel>(),
    attempts: new Map<string, OutboxAttemptRecord>(),
    previous: new Map<"event", OutboxPredecessor>(),
  };
}

/**
 * Fold one stream event into the outbox fold, or refuse it.
 *
 * Every event is offered, of every type, because a `REVOKE_LEASE` intention is
 * checked against whatever event came immediately before it. That is the one
 * rule the fold can only approximate: it sees the stream and not the batch, so
 * two adjacent events written by two transactions look like one batch here.
 * The door refuses that shape by construction — an intention to revoke by
 * `append`, or in a batch that did not itself insert the quarantine, never
 * commits — so a history of that shape is one the door never wrote (ADR 0078).
 */
export function applyEventToOutboxFold(fold: OutboxFold, entry: OutboxEventEntry): void {
  const reading = readOutboxEvent(entry.event);
  const predecessor = fold.previous.get("event") ?? null;
  fold.previous.set("event", {
    taskId: entry.event.taskId,
    type: entry.event.type,
    toState: entry.event.toState,
  });
  if (reading === null) return;
  if (reading.kind === "refused") {
    throw new LedgerValidationError([{ path: reading.path, message: reading.message }]);
  }

  const commandId = reading.row.commandId;
  const command = fold.commands.get(commandId) ?? null;
  const attempt =
    reading.kind === "intention" ? null : (fold.attempts.get(reading.row.deliveryAttemptId) ?? null);
  const refusal = outboxLinkRefusal(entry, reading, command, attempt, predecessor);
  if (refusal !== null) throw new LedgerValidationError([refusal]);

  const next = nextOutboxCommand(entry, reading, command, attempt);
  fold.commands.set(commandId, next.command);
  if (next.attempt !== null) fold.attempts.set(next.attempt.deliveryAttemptId, next.attempt);
}

/**
 * Every command a sequence of stream events folds to, in intention order.
 *
 * The reconstruction datos §11 `:566-570` asks for, as a pure function: what a
 * lost `outbox.sqlite` would be rebuilt to. An attempt with no outcome comes
 * back `RECONCILING` and an intention with no attempt `PENDING`, and nothing
 * else is guessed.
 */
export function foldOutboxCommands(
  entries: Iterable<OutboxEventEntry>,
): readonly OutboxCommandReadModel[] {
  const fold = createOutboxFold();
  for (const entry of entries) applyEventToOutboxFold(fold, entry);
  return [...fold.commands.values()].sort((left, right) => left.intentSequence - right.intentSequence);
}

// ---------------------------------------------------------------------------
// The initiative stream's projections
// ---------------------------------------------------------------------------

/** The registration facts the closed payload carries (P-14 B, ADR 0086). */
export interface InitiativeRegistrationPayload {
  readonly slug: string;
  readonly title: string;
  readonly objectiveSha256: string;
  readonly objectiveArtifactReferenceId: string;
}

/** The slug grammar of `Initiative`, restated as a test over one value. */
const INITIATIVE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const INITIATIVE_SLUG_MAX = 80;
const INITIATIVE_TITLE_MAX = 200;
/** The contract's `Identifier` bound for an artifact reference id. */
const ARTIFACT_REFERENCE_ID_MAX = 512;

/**
 * The closed registration payload of one `INITIATIVE_REGISTERED`, or null.
 *
 * Total, for `nextModelVersionProjection`'s reason: the stream has no delete
 * path, so a fold that refused a stored event would be disowning history. Every
 * key of `INITIATIVE_REGISTRATION_PAYLOAD_KEYS` present, in its shape, and no
 * other key — or null. The registration door is the one producer of this shape;
 * a payload written before it (`{}`, or a slug and a title with no digest) is
 * history the fold reads as no registration facts at all, rather than as half
 * of them.
 */
export function initiativeRegistrationPayloadOf(event: InitiativeEvent): InitiativeRegistrationPayload | null {
  if (event.type !== "INITIATIVE_REGISTERED") return null;
  const payload = event.payload;
  const keys = INITIATIVE_REGISTRATION_PAYLOAD_KEYS as readonly string[];
  if (undeclaredKey(payload, keys) !== null) return null;
  const { slug, title, objectiveSha256, objectiveArtifactReferenceId } = payload;
  if (typeof slug !== "string" || slug.length > INITIATIVE_SLUG_MAX || !INITIATIVE_SLUG_PATTERN.test(slug)) {
    return null;
  }
  if (typeof title !== "string" || title.length === 0 || title.length > INITIATIVE_TITLE_MAX) return null;
  if (typeof objectiveSha256 !== "string" || !/^[0-9a-f]{64}$/.test(objectiveSha256)) return null;
  if (
    typeof objectiveArtifactReferenceId !== "string" ||
    objectiveArtifactReferenceId.length === 0 ||
    objectiveArtifactReferenceId.length > ARTIFACT_REFERENCE_ID_MAX
  ) {
    return null;
  }
  return { slug, title, objectiveSha256, objectiveArtifactReferenceId };
}

/**
 * Apply one initiative event to an initiative projection row.
 *
 * `title` and `objective_sha256` are planning §1's additives (migration 18):
 * set by a registration that carries the closed payload, carried unchanged by
 * every later event, and null otherwise. `repository_sha256` has no producer.
 */
export function nextInitiativeProjection(
  current: InitiativeReadModel | null,
  event: InitiativeEvent,
  sequence: number,
): InitiativeReadModel {
  const registration = initiativeRegistrationPayloadOf(event);
  const base = {
    initiativeId: event.initiativeId,
    currentStatus: event.toStatus,
    lastSequence: sequence,
    lastEventId: event.eventId,
    lastEventType: event.type,
    lastTransitionId: event.transitionId,
    lastEmittedBy: event.emittedBy,
    updatedAt: event.occurredAt,
    title: registration?.title ?? current?.title ?? null,
    objectiveSha256: registration?.objectiveSha256 ?? current?.objectiveSha256 ?? null,
    repositorySha256: null,
  } as const;

  if (current === null) {
    return { ...base, eventCount: 1, firstSequence: sequence, createdAt: event.occurredAt };
  }

  return {
    ...base,
    eventCount: current.eventCount + 1,
    firstSequence: current.firstSequence,
    createdAt: current.createdAt,
  };
}

/**
 * The roadmap version a `ROADMAP_VERSION_RECORDED` event records, if its
 * payload carries one.
 *
 * The version travels in the event's payload as a `RoadmapVersion` value, and
 * it is parsed here through the contract rather than trusted: the payload is a
 * bounded record of unknowns, so the only way to know it is a version is to
 * ask the schema. A payload that does not parse, or that names a different
 * initiative than the event it rides on, projects **no row** — the event still
 * stands in the stream and still moves the initiative projection, because an
 * append-only log does not get to disown an event it accepted. Live projection
 * and replay share this one function, so both agree about which events produce
 * a row.
 */
export function nextRoadmapVersionProjection(
  event: InitiativeEvent,
  sequence: number,
): RoadmapVersionReadModel | null {
  if (event.type !== "ROADMAP_VERSION_RECORDED") return null;

  const parsed = RoadmapVersion.safeParse(event.payload);
  if (!parsed.success) return null;
  if (parsed.data.initiativeId !== event.initiativeId) return null;

  return {
    roadmapVersionId: parsed.data.roadmapVersionId,
    initiativeId: parsed.data.initiativeId,
    version: parsed.data.version,
    contentDigest: parsed.data.contentDigest,
    parentVersionId: parsed.data.parentVersionId,
    kind: parsed.data.kind,
    restoresVersionId: parsed.data.restoresVersionId,
    recordedBy: parsed.data.recordedBy,
    recordedAt: parsed.data.recordedAt,
    sequence,
  };
}

/**
 * In-memory projection of the whole initiative stream.
 *
 * It carries a routing partition of its own, which is why it extends the
 * partition type rather than restating those two maps: one declaration, so the
 * two sources of the routing projection cannot drift into carrying different
 * shapes for the same table. The partition is present and **empty** in this
 * build — written down rather than left out, so it reads as *folded and empty*
 * rather than *forgotten*: the fold below runs over every initiative event and
 * returns no row for every type the contract defines.
 */
export interface InitiativeProjectionSnapshot extends RegistryProjectionSnapshot {
  readonly initiatives: Map<string, InitiativeReadModel>;
  readonly roadmapVersions: Map<string, RoadmapVersionReadModel>;
}

export function createInitiativeProjectionSnapshot(): InitiativeProjectionSnapshot {
  return {
    initiatives: new Map<string, InitiativeReadModel>(),
    roadmapVersions: new Map<string, RoadmapVersionReadModel>(),
    routingAssignments: new Map<string, RoutingAssignmentReadModel>(),
    routingFallbacks: new Map<string, RoutingAssignmentFallbackRow>(),
  };
}

/** Fold one initiative event into an in-memory snapshot. */
export function applyInitiativeEventToSnapshot(
  snapshot: InitiativeProjectionSnapshot,
  event: InitiativeEvent,
  sequence: number,
): void {
  snapshot.initiatives.set(
    event.initiativeId,
    nextInitiativeProjection(snapshot.initiatives.get(event.initiativeId) ?? null, event, sequence),
  );

  const version = nextRoadmapVersionProjection(event, sequence);
  if (version !== null) snapshot.roadmapVersions.set(version.roadmapVersionId, version);

  const assignment = nextRoutingAssignmentFromInitiative(event, sequence);
  if (assignment !== null) applyRoutingAssignment(snapshot, assignment);
}

// ---------------------------------------------------------------------------
// The registry stream, and the projection fed by two of them (P-09/log-C)
// ---------------------------------------------------------------------------

/** The one document kind that carries a GLOBAL routing assignment. */
const ROUTING_ASSIGNMENT_GLOBAL = "ROUTING_ASSIGNMENT_GLOBAL";

/**
 * The row identity of one version of one routing document.
 *
 * Derived from the document rather than read out of its payload, for the
 * reason `executionRouteKey` takes its coordinates from the event: a payload
 * that could name its own row could name another document's row. Deriving it
 * also makes the identity of the version this one supersedes computable from
 * `parentDocumentVersion` alone, with no lookup.
 *
 * `(document_id, document_version)` is unique by
 * `ux_registry_events__document_id__document_version`, and a document id is a
 * colon-delimited identifier, so the separator cannot make two pairs collide.
 */
export function routingAssignmentId(documentId: string, documentVersion: number): string {
  return documentId + "#" + String(documentVersion);
}

export function routingFallbackKey(assignmentId: string, ordinal: number): string {
  return assignmentId + "#" + String(ordinal);
}

function isRole(value: unknown): value is WorkerRole {
  return typeof value === "string" && (WORKER_ROLES as readonly string[]).includes(value);
}

function isSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readFallbacks(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.every(isNonEmptyString) ? (value as readonly string[]) : null;
}

/**
 * The GLOBAL routing assignment one registry document records, if it is one.
 *
 * The same allocation of duties as `nextExecutionRouteProjection`, and the same
 * asymmetry: a payload this fold cannot read projects **no row while the
 * document still stands**. The registry is an append-only authority with no
 * delete path, so a projection that refused an accepted document would be
 * disowning history, and replay has to remain total.
 *
 * What this fold does **not** do is check eligibility, and it never will: a
 * rebuild folds history the door accepted, and history does not become
 * inadmissible because a model was retired after it was written (N-P14A-7).
 * The contract's fail-closed check on `model_version_id` is made where it
 * belongs in time, at the append door, against `model_version_read_model`
 * (ADR 0085, which amends what this comment said before that table existed):
 * `globalAssignmentIssues` below is the decision, and the door alone calls it.
 * The fold projects what the document recorded.
 */
export function nextRoutingAssignmentProjection(
  document: RegistryDocument,
  sequence: number,
): RoutingAssignmentProjection | null {
  if (document.documentKind !== ROUTING_ASSIGNMENT_GLOBAL) return null;

  const payload: unknown = document.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const fields = payload as Record<string, unknown>;

  const role = fields["role"];
  const slot = fields["slot"];
  const provider = fields["provider"];
  const modelVersionId = fields["modelVersionId"];
  if (!isRole(role) || !isSlot(slot)) return null;
  if (!isNonEmptyString(provider) || !isNonEmptyString(modelVersionId)) return null;

  const fallbacks = readFallbacks(fields["fallbacks"]);
  if (fallbacks === null) return null;

  const assignmentId = routingAssignmentId(document.documentId, document.documentVersion);

  return {
    assignment: {
      assignmentId,
      scopeKind: "GLOBAL",
      // NULL if and only if the scope is GLOBAL, which this partition always
      // is: `ck_routing_assignment_read_model__scope_id_required` in the base,
      // and `ck_..._source_scope` refuses a GLOBAL row from the other stream.
      scopeId: null,
      version: document.documentVersion,
      role,
      slot,
      provider,
      modelVersionId,
      recordedBy: document.recordedBy,
      recordedAt: document.recordedAt,
      supersededBy: null,
      sourceStream: "registry_events",
      sourceSequence: sequence,
      sequence,
    },
    fallbacks: fallbacks.map((fallbackModelVersionId, ordinal) => ({
      assignmentId,
      ordinal,
      modelVersionId: fallbackModelVersionId,
    })),
    supersedes:
      document.parentDocumentVersion === null
        ? null
        : routingAssignmentId(document.documentId, document.parentDocumentVersion),
  };
}

/**
 * The INITIATIVE/STEP partition of the same projection. Total, and empty.
 *
 * The contract fills this partition from `ROUTING_ASSIGNMENT_RECORDED`, which
 * is not one of the three names in `INITIATIVE_EVENT_TYPES`. Widening that
 * vocabulary is a change to a contract in another package and belongs to the
 * planning packet that needs it; until then this fold is total over the types
 * that do exist and returns no row for every one of them.
 *
 * It is a function rather than an absence so that the partition is folded and
 * empty rather than unfolded and forgotten, and so the test that pins it can
 * name every existing type one by one.
 */
export function nextRoutingAssignmentFromInitiative(
  event: InitiativeEvent,
  sequence: number,
): RoutingAssignmentProjection | null {
  void event;
  void sequence;
  return null;
}

/** In-memory projection of the registry stream. */
export function createRegistryProjectionSnapshot(): RegistryProjectionSnapshot {
  return {
    routingAssignments: new Map<string, RoutingAssignmentReadModel>(),
    routingFallbacks: new Map<string, RoutingAssignmentFallbackRow>(),
  };
}

/**
 * Write one routing projection into a snapshot, superseding its parent.
 *
 * Shared by both partitions, so the two sources cannot come to disagree about
 * what folding an assignment means. Supersession rewrites the parent row's
 * `supersededBy` and nothing else: the earlier version keeps every fact it
 * recorded, because "which model was implementer slot 0 assigned last March"
 * is a question the read model exists to answer.
 */
function applyRoutingAssignment(
  snapshot: RegistryProjectionSnapshot,
  projected: RoutingAssignmentProjection,
): void {
  const { assignment, fallbacks, supersedes } = projected;
  snapshot.routingAssignments.set(assignment.assignmentId, assignment);
  for (const fallback of fallbacks) {
    snapshot.routingFallbacks.set(
      routingFallbackKey(fallback.assignmentId, fallback.ordinal),
      fallback,
    );
  }
  if (supersedes === null) return;
  const parent = snapshot.routingAssignments.get(supersedes);
  if (parent === undefined) return;
  snapshot.routingAssignments.set(supersedes, {
    ...parent,
    supersededBy: assignment.assignmentId,
  });
}

/** Fold one registry document into an in-memory snapshot. */
export function applyRegistryEventToSnapshot(
  snapshot: RegistryProjectionSnapshot,
  document: RegistryDocument,
  sequence: number,
): void {
  const projected = nextRoutingAssignmentProjection(document, sequence);
  if (projected !== null) applyRoutingAssignment(snapshot, projected);
}

// ---------------------------------------------------------------------------
// The model version registry, and the gate a GLOBAL assignment passes (P-14 A)
// ---------------------------------------------------------------------------

/** The one document kind that carries a model version (accounts §6). */
const MODEL_VERSION = "MODEL_VERSION";

/** The same bound the registry door gives an identifier. */
const MODEL_VERSION_TEXT_MAX = 512;

/**
 * The reasons a GLOBAL routing assignment is refused at the door (ADR 0085).
 *
 * Words carried at the head of each issue's message, so a caller that reads the
 * refusal reads a closed word before any prose. Three for the version the
 * assignment names — absent, retired, deprecated are different facts and a
 * retired one is the only one with somewhere to go — and one for the role.
 */
export const GLOBAL_ASSIGNMENT_REFUSALS = [
  "MODEL_VERSION_UNKNOWN",
  "MODEL_VERSION_RETIRED",
  "MODEL_VERSION_DEPRECATED",
  "ROLE_NOT_ELIGIBLE",
] as const;

export type GlobalAssignmentRefusal = (typeof GLOBAL_ASSIGNMENT_REFUSALS)[number];

/** What the gate needs to know about one model version, and nothing else. */
export interface ModelVersionEligibility {
  readonly status: ModelVersionStatus;
  readonly eligibleRoles: readonly string[];
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MODEL_VERSION_TEXT_MAX;
}

function isModelVersionInstant(value: unknown): value is string {
  if (typeof value !== "string" || !OUTBOX_INSTANT_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** A payload key, safe to put in a path. Anything else is not echoed. */
function safePayloadKey(key: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? key : "<unprintable key>";
}

/**
 * A closed list of distinct words, each drawn from `vocabulary`.
 *
 * Distinct because the child tables say so (`ux_model_version_eligible_role__role`,
 * `ux_model_version_transport__transport`): a duplicate would reach the base as a
 * uniqueness failure nobody can catch by class.
 */
function listIssues(
  value: unknown,
  path: string,
  vocabulary: readonly string[],
  noun: string,
): LedgerValidationIssue[] {
  if (!Array.isArray(value)) {
    return [{ path, message: "a model version's " + noun + " are a list" }];
  }
  const issues: LedgerValidationIssue[] = [];
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    const at = path + "[" + String(index) + "]";
    if (typeof entry !== "string" || !vocabulary.includes(entry)) {
      issues.push({ path: at, message: "names one of " + vocabulary.join(", ") });
    } else if (seen.has(entry)) {
      issues.push({ path: at, message: "is declared twice in the model version's " + noun });
    } else {
      seen.add(entry);
    }
  });
  return issues;
}

/**
 * Every way a `MODEL_VERSION` payload fails its fixed shape, by name.
 *
 * The door's check (M-5): the payload is the camelCase mirror of accounts §6 and
 * nothing else. Nine keys, each required; `deprecatedAt` null if and only if the
 * status is `ACTIVE`, which is `ck_model_version_read_model__deprecated_pair`
 * said before the row exists; eligible roles from the worker vocabulary and
 * transports from the contract's, each list without repeats. No value is echoed.
 */
export function modelVersionPayloadIssues(
  payload: Record<string, unknown>,
): LedgerValidationIssue[] {
  const issues: LedgerValidationIssue[] = [];
  const known = MODEL_VERSION_PAYLOAD_KEYS as readonly string[];

  // The closed-grammar check the occurrence records already make, through the
  // same helper: the first key the grammar does not declare, named by path.
  const undeclared = undeclaredKey(payload, known);
  if (undeclared !== null) {
    issues.push({
      path: "payload." + safePayloadKey(undeclared),
      message: "is not a key of a MODEL_VERSION payload; the payload is closed",
    });
  }

  for (const key of ["provider", "model", "release", "policyVersion"]) {
    if (!isBoundedText(payload[key])) {
      issues.push({
        path: "payload." + key,
        message: "is a string of 1 to " + String(MODEL_VERSION_TEXT_MAX) + " characters",
      });
    }
  }

  const status = payload["status"];
  const statusKnown =
    typeof status === "string" && (MODEL_VERSION_STATUSES as readonly string[]).includes(status);
  if (!statusKnown) {
    issues.push({ path: "payload.status", message: "names one of " + MODEL_VERSION_STATUSES.join(", ") });
  }

  const contextTokens = payload["contextTokens"];
  if (!Number.isSafeInteger(contextTokens) || (contextTokens as number) < 0) {
    issues.push({ path: "payload.contextTokens", message: "is an integer of zero or greater" });
  }

  const deprecatedAt = payload["deprecatedAt"];
  if (!("deprecatedAt" in payload)) {
    issues.push({ path: "payload.deprecatedAt", message: "is present, as null or as an instant" });
  } else if (deprecatedAt !== null && !isModelVersionInstant(deprecatedAt)) {
    issues.push({
      path: "payload.deprecatedAt",
      message: "is null or an ISO-8601 instant in UTC with milliseconds",
    });
  } else if (statusKnown && (status === "ACTIVE") !== (deprecatedAt === null)) {
    issues.push({
      path: "payload.deprecatedAt",
      message: "is null if and only if the status is ACTIVE",
    });
  }

  issues.push(
    ...listIssues(payload["eligibleRoles"], "payload.eligibleRoles", WORKER_ROLES, "eligible roles"),
    ...listIssues(payload["transports"], "payload.transports", TRANSPORT_KINDS, "transports"),
  );

  return issues;
}

/**
 * The model version one registry document records, if it is one.
 *
 * Total, for `nextRoutingAssignmentProjection`'s reason: the stream has no delete
 * path, so a fold that refused a stored document would be disowning history.
 * A payload this fold cannot read yields a projection with no row — the
 * document's current version is unreadable, so the registry holds no version of
 * it that rules, and the row an earlier version left is removed rather than left
 * standing (see `ModelVersionProjection`). The door refuses such a payload, so
 * only history written before migration 17 can reach that branch.
 *
 * Children are replaced whole with their version, as an assignment's fallbacks
 * are: a later version with fewer roles cannot leave the extra ones behind.
 */
export function nextModelVersionProjection(
  document: RegistryDocument,
  sequence: number,
): ModelVersionProjection | null {
  if (document.documentKind !== MODEL_VERSION) return null;

  const modelVersionId = document.documentId;
  const payload: unknown = document.payload;
  const readable =
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    modelVersionPayloadIssues(payload as Record<string, unknown>).length === 0;
  if (!readable) return { modelVersionId, row: null, eligibleRoles: [], transports: [] };

  const fields = payload as Record<string, unknown>;
  const row: ModelVersionReadModel = {
    modelVersionId,
    provider: fields["provider"] as string,
    model: fields["model"] as string,
    release: fields["release"] as string,
    status: fields["status"] as ModelVersionStatus,
    contextTokens: fields["contextTokens"] as number,
    // Never read from the payload, which has no such key: economy produces the
    // snapshot this column references, and nothing in this build does.
    latestPerformanceWindow: null,
    policyVersion: fields["policyVersion"] as string,
    deprecatedAt: fields["deprecatedAt"] as string | null,
    documentVersion: document.documentVersion,
    sequence,
  };

  return {
    modelVersionId,
    row,
    eligibleRoles: (fields["eligibleRoles"] as readonly WorkerRole[]).map(
      (role, ordinal): ModelVersionEligibleRoleRow => ({ modelVersionId, ordinal, role }),
    ),
    transports: (fields["transports"] as readonly string[]).map(
      (transportKind, ordinal): ModelVersionTransportRow => ({ modelVersionId, ordinal, transportKind }),
    ),
  };
}

/** In-memory projection of the model version registry. */
export function createModelVersionProjectionSnapshot(): ModelVersionProjectionSnapshot {
  return {
    modelVersions: new Map<string, ModelVersionReadModel>(),
    eligibleRoles: new Map<string, readonly ModelVersionEligibleRoleRow[]>(),
    transports: new Map<string, readonly ModelVersionTransportRow[]>(),
  };
}

/**
 * Write one model version projection into a snapshot.
 *
 * The version the fold applied last is the row, in stream order: the dictionary's
 * `document_version` is "the last version projected for this id". A projection
 * with no row removes the id with its children.
 */
export function applyModelVersionToSnapshot(
  snapshot: ModelVersionProjectionSnapshot,
  projected: ModelVersionProjection,
): void {
  const { modelVersionId, row } = projected;
  if (row === null) {
    snapshot.modelVersions.delete(modelVersionId);
    snapshot.eligibleRoles.delete(modelVersionId);
    snapshot.transports.delete(modelVersionId);
    return;
  }
  snapshot.modelVersions.set(modelVersionId, row);
  snapshot.eligibleRoles.set(modelVersionId, projected.eligibleRoles);
  snapshot.transports.set(modelVersionId, projected.transports);
}

/** Fold one registry document into the model version snapshot, if it is one. */
export function applyRegistryModelVersionToSnapshot(
  snapshot: ModelVersionProjectionSnapshot,
  document: RegistryDocument,
  sequence: number,
): void {
  const projected = nextModelVersionProjection(document, sequence);
  if (projected !== null) applyModelVersionToSnapshot(snapshot, projected);
}

/** One version the assignment names, held to the rule, at `path`. */
function modelVersionIssue(
  eligibility: ModelVersionEligibility | null,
  path: string,
  role: WorkerRole,
): LedgerValidationIssue | null {
  if (eligibility === null) {
    return {
      path,
      message: "MODEL_VERSION_UNKNOWN: no model version with this id is registered",
    };
  }
  if (eligibility.status === "RETIRED") {
    return {
      path,
      message:
        "MODEL_VERSION_RETIRED: the model version is retired and blocks the assignment; " +
        "migrate the assignment to an ACTIVE model version",
    };
  }
  if (eligibility.status === "DEPRECATED") {
    return {
      path,
      message: "MODEL_VERSION_DEPRECATED: an assignment names an ACTIVE model version only",
    };
  }
  if (!eligibility.eligibleRoles.includes(role)) {
    return {
      path: path === "payload.modelVersionId" ? "payload.role" : path,
      message: "ROLE_NOT_ELIGIBLE: the model version does not declare the role " + role + " eligible",
    };
  }
  return null;
}

/**
 * Every reason the append door refuses one GLOBAL routing assignment (ADR 0085).
 *
 * The door's half of the check, and only the door's: typed lookups over a read
 * model of the same stream (planning §6), never a score or a choice. The lookup
 * is injected so this stays a pure decision the suite can hold.
 *
 * - A payload the fold could not read is refused field by field: an assignment
 *   the fold would project no row for is not one the door admits (fail-closed).
 * - The version it names, and each fallback at `payload.fallbacks[i]`, must be
 *   registered and `ACTIVE`; the role must be one the version declares eligible.
 *   A role a fallback does not admit is refused at the fallback's own path.
 *
 * Transport is not checked here and cannot be: the assignment names none. That
 * half of eligibility is the resolver's, which is handed the transport.
 */
export function globalAssignmentIssues(
  document: RegistryDocument,
  lookup: (modelVersionId: string) => ModelVersionEligibility | null,
): LedgerValidationIssue[] {
  if (document.documentKind !== ROUTING_ASSIGNMENT_GLOBAL) return [];

  const fields = document.payload;
  const issues: LedgerValidationIssue[] = [];
  const role = fields["role"];
  const modelVersionId = fields["modelVersionId"];

  if (!isRole(role)) {
    issues.push({ path: "payload.role", message: "names one of " + WORKER_ROLES.join(", ") });
  }
  if (!isSlot(fields["slot"])) {
    issues.push({ path: "payload.slot", message: "is an integer of zero or greater" });
  }
  if (!isNonEmptyString(fields["provider"])) {
    issues.push({ path: "payload.provider", message: "is a non-empty string" });
  }
  if (!isNonEmptyString(modelVersionId)) {
    issues.push({ path: "payload.modelVersionId", message: "is a non-empty string" });
  }
  const fallbacks = readFallbacks(fields["fallbacks"]);
  if (fallbacks === null) {
    issues.push({ path: "payload.fallbacks", message: "is absent, or a list of non-empty strings" });
  }
  if (issues.length > 0 || !isRole(role) || !isNonEmptyString(modelVersionId) || fallbacks === null) {
    return issues;
  }

  const primary = modelVersionIssue(lookup(modelVersionId), "payload.modelVersionId", role);
  if (primary !== null) issues.push(primary);
  fallbacks.forEach((fallback, index) => {
    const issue = modelVersionIssue(lookup(fallback), "payload.fallbacks[" + String(index) + "]", role);
    if (issue !== null) issues.push(issue);
  });
  return issues;
}

// ---------------------------------------------------------------------------
// The price interval catalog, and the gate a PRICE_TABLE passes (P-33/catálogo A)
// ---------------------------------------------------------------------------

/** The one document kind that carries a price catalog (economy §3). */
const PRICE_TABLE = "PRICE_TABLE";

/** `ck_price_interval_read_model__currency`, said before the row exists (the execution dictionary's `:682` form). */
const PRICE_CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** The overlap key of one interval: its primary key without the document, the version and `effective_from`. */
function priceQuintupleKey(row: Record<string, unknown>): string {
  return canonicalJsonStringify([
    row["provider"],
    row["modelVersionId"],
    row["transportKind"],
    row["tokenClass"],
    row["currency"],
  ]);
}

/** Every way one interval of a `PRICE_TABLE` payload fails its fixed shape, at `path`. */
function priceIntervalIssues(entry: unknown, path: string): LedgerValidationIssue[] {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [{ path, message: "is an object with the keys of a price interval" }];
  }
  const row = entry as Record<string, unknown>;
  const issues: LedgerValidationIssue[] = [];

  const undeclared = undeclaredKey(row, PRICE_INTERVAL_KEYS as readonly string[]);
  if (undeclared !== null) {
    issues.push({
      path: path + "." + safePayloadKey(undeclared),
      message: "is not a key of a price interval; the interval is closed",
    });
  }

  for (const key of ["provider", "modelVersionId"]) {
    if (!isBoundedText(row[key])) {
      issues.push({
        path: path + "." + key,
        message: "is a string of 1 to " + String(MODEL_VERSION_TEXT_MAX) + " characters",
      });
    }
  }

  const transportKind = row["transportKind"];
  if (typeof transportKind !== "string" || !(TRANSPORT_KINDS as readonly string[]).includes(transportKind)) {
    issues.push({ path: path + ".transportKind", message: "names one of " + TRANSPORT_KINDS.join(", ") });
  }

  const tokenClass = row["tokenClass"];
  if (typeof tokenClass !== "string" || !(PRICE_TOKEN_CLASSES as readonly string[]).includes(tokenClass)) {
    issues.push({ path: path + ".tokenClass", message: "names one of " + PRICE_TOKEN_CLASSES.join(", ") });
  }

  const currency = row["currency"];
  if (typeof currency !== "string" || !PRICE_CURRENCY_PATTERN.test(currency)) {
    issues.push({ path: path + ".currency", message: "is three upper-case letters" });
  }

  const effectiveFrom = row["effectiveFrom"];
  const fromReadable = isModelVersionInstant(effectiveFrom);
  if (!fromReadable) {
    issues.push({
      path: path + ".effectiveFrom",
      message: "is an ISO-8601 instant in UTC with milliseconds, in its canonical form",
    });
  }

  const effectiveTo = row["effectiveTo"];
  if (!("effectiveTo" in row)) {
    issues.push({ path: path + ".effectiveTo", message: "is present, as null or as an instant" });
  } else if (effectiveTo !== null && !isModelVersionInstant(effectiveTo)) {
    issues.push({
      path: path + ".effectiveTo",
      message: "is null or an ISO-8601 instant in UTC with milliseconds, in its canonical form",
    });
  } else if (effectiveTo !== null && fromReadable && effectiveTo <= effectiveFrom) {
    // Text order is time order for the canonical form: fixed width, UTC and
    // zero-padded throughout, which is what `ck_…__interval_order` compares.
    issues.push({
      path: path + ".effectiveTo",
      message: "is null or later than effectiveFrom; an interval is half-open, [effectiveFrom, effectiveTo)",
    });
  }

  const price = row["pricePerMillionNanos"];
  if (!Number.isSafeInteger(price) || (price as number) < 0) {
    issues.push({ path: path + ".pricePerMillionNanos", message: "is an integer of zero or greater" });
  }

  return issues;
}

/**
 * Every way a `PRICE_TABLE` payload fails its fixed shape, by name (ADR 0091).
 *
 * The door's check, and the fold's reading of what the door would admit. The
 * payload is `{ intervals }` and nothing else; the list is not empty; each
 * interval is closed (`PRICE_INTERVAL_KEYS`), its instants canonical, its end
 * null or later than its start, its price a safe integer of zero or greater, its
 * transport a word of the contract, its token class one of four and its currency
 * three upper-case letters. Across the list: no primary key twice
 * (`PRICE_INTERVAL_DUPLICATE`), and no two intervals of one
 * `(provider, modelVersionId, transportKind, tokenClass, currency)` that meet
 * (`PRICE_INTERVAL_OVERLAP`) — economy §3's rule, which no CHECK can state.
 * Adjacent intervals, `[a, b)` then `[b, c)`, do not meet. No value is echoed.
 *
 * Pure: whether each model version is registered is the door's lookup, in
 * `priceTableIssues`, and never the fold's.
 */
export function priceTablePayloadIssues(payload: Record<string, unknown>): LedgerValidationIssue[] {
  const issues: LedgerValidationIssue[] = [];

  const undeclared = undeclaredKey(payload, PRICE_TABLE_PAYLOAD_KEYS as readonly string[]);
  if (undeclared !== null) {
    issues.push({
      path: "payload." + safePayloadKey(undeclared),
      message: "is not a key of a PRICE_TABLE payload; the payload is closed",
    });
  }

  const intervals = payload["intervals"];
  if (!Array.isArray(intervals) || intervals.length === 0) {
    issues.push({ path: "payload.intervals", message: "is a list of one or more price intervals" });
    return issues;
  }

  const readable: { readonly index: number; readonly row: Record<string, unknown> }[] = [];
  intervals.forEach((entry: unknown, index) => {
    const own = priceIntervalIssues(entry, "payload.intervals[" + String(index) + "]");
    if (own.length === 0) readable.push({ index, row: entry as Record<string, unknown> });
    issues.push(...own);
  });

  // Grouped by the overlap key and ordered by start, so if any two intervals of
  // one group meet, some two neighbours meet: when interval j starts before an
  // earlier interval i ends, i's successor starts no later than j and so before
  // i ends too. Neighbours are enough to refuse the version; they need not name
  // every pair.
  const groups = new Map<string, { readonly index: number; readonly row: Record<string, unknown> }[]>();
  for (const entry of readable) {
    const key = priceQuintupleKey(entry.row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  const clashes: { readonly index: number; readonly issue: LedgerValidationIssue }[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => {
      const leftFrom = left.row["effectiveFrom"] as string;
      const rightFrom = right.row["effectiveFrom"] as string;
      return leftFrom < rightFrom ? -1 : leftFrom > rightFrom ? 1 : left.index - right.index;
    });
    for (let position = 1; position < ordered.length; position += 1) {
      const previous = ordered[position - 1];
      const current = ordered[position];
      if (previous === undefined || current === undefined) continue;
      const at = "payload.intervals[" + String(current.index) + "]";
      const previousTo = previous.row["effectiveTo"] as string | null;
      const currentFrom = current.row["effectiveFrom"] as string;
      if ((previous.row["effectiveFrom"] as string) === currentFrom) {
        clashes.push({
          index: current.index,
          issue: {
            path: at,
            message:
              "PRICE_INTERVAL_DUPLICATE: interval " +
              String(previous.index) +
              " already prices this provider, model version, transport, token class and currency from the same instant",
          },
        });
      } else if (previousTo === null || previousTo > currentFrom) {
        clashes.push({
          index: current.index,
          issue: {
            path: at,
            message:
              "PRICE_INTERVAL_OVERLAP: interval " +
              String(previous.index) +
              " prices this provider, model version, transport, token class and currency over part of the same time",
          },
        });
      }
    }
  }
  clashes.sort((left, right) => left.index - right.index);
  issues.push(...clashes.map((clash) => clash.issue));

  return issues;
}

/**
 * Every reason the append door refuses one `PRICE_TABLE` (ADR 0091).
 *
 * The door's half, in `globalAssignmentIssues`' form: a pure decision over an
 * injected lookup of `model_version_read_model`. A payload the fold could not
 * read is refused by its shape before any lookup. Then each interval's
 * `modelVersionId` must be registered — in any status: a retired version keeps
 * its historical price (`MODEL_VERSION_UNKNOWN`) — and registered under the
 * interval's own provider (`MODEL_VERSION_PROVIDER_MISMATCH`). Transport is not
 * held against the version's admitted transports: that is the resolver's.
 */
export function priceTableIssues(
  document: RegistryDocument,
  lookup: (modelVersionId: string) => PriceTableModelVersion | null,
): LedgerValidationIssue[] {
  if (document.documentKind !== PRICE_TABLE) return [];

  const shape = priceTablePayloadIssues(document.payload);
  if (shape.length > 0) return shape;

  const issues: LedgerValidationIssue[] = [];
  const intervals = document.payload["intervals"] as readonly Record<string, unknown>[];
  intervals.forEach((row, index) => {
    const at = "payload.intervals[" + String(index) + "]";
    const registered = lookup(row["modelVersionId"] as string);
    if (registered === null) {
      issues.push({
        path: at + ".modelVersionId",
        message: "MODEL_VERSION_UNKNOWN: no model version with this id is registered",
      });
    } else if (registered.provider !== row["provider"]) {
      issues.push({
        path: at + ".provider",
        message: "MODEL_VERSION_PROVIDER_MISMATCH: the model version is registered under another provider",
      });
    }
  });
  return issues;
}

/** The snapshot key of one interval: its primary key, as canonical JSON. */
export function priceIntervalKey(row: PriceIntervalReadModel): string {
  return canonicalJsonStringify([
    row.catalogDocumentId,
    row.catalogVersion,
    row.provider,
    row.modelVersionId,
    row.transportKind,
    row.tokenClass,
    row.currency,
    row.effectiveFrom,
  ]);
}

/**
 * The price intervals one registry document publishes, if it is a `PRICE_TABLE`.
 *
 * Total, and whole per version (ADR 0091). A payload `priceTablePayloadIssues`
 * refuses yields the version with no rows — never a part of them, and never a
 * throw: the stream has no delete path, so a fold that refused a stored document
 * would be disowning history, and one that kept its readable half would publish
 * what the door refuses. The door refuses such a payload, so only history written
 * before migration 21, or planted past the door, reaches that branch.
 *
 * No lookup: the fold does not ask whether a model version is registered. A
 * rebuild folds what the door admitted (N-P14A-7), and a version retired or
 * re-registered since does not unpublish a price.
 *
 * Insert-only: a version's rows are its own, keyed by the version, so a later
 * version — retroactive or not — adds rows beside them and changes none.
 */
export function nextPriceIntervalProjection(
  document: RegistryDocument,
  sequence: number,
): PriceIntervalProjection | null {
  if (document.documentKind !== PRICE_TABLE) return null;

  const catalogDocumentId = document.documentId;
  const catalogVersion = document.documentVersion;
  const payload: unknown = document.payload;
  const readable =
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    priceTablePayloadIssues(payload as Record<string, unknown>).length === 0;
  if (!readable) return { catalogDocumentId, catalogVersion, rows: [] };

  const intervals = (payload as Record<string, unknown>)["intervals"] as readonly Record<string, unknown>[];
  return {
    catalogDocumentId,
    catalogVersion,
    rows: intervals.map(
      (row): PriceIntervalReadModel => ({
        catalogDocumentId,
        catalogVersion,
        provider: row["provider"] as string,
        modelVersionId: row["modelVersionId"] as string,
        transportKind: row["transportKind"] as string,
        tokenClass: row["tokenClass"] as PriceTokenClass,
        currency: row["currency"] as string,
        effectiveFrom: row["effectiveFrom"] as string,
        effectiveTo: row["effectiveTo"] as string | null,
        pricePerMillionNanos: row["pricePerMillionNanos"] as number,
        recordedBy: document.recordedBy,
        sequence,
      }),
    ),
  };
}

/** In-memory projection of the price interval catalog. */
export function createPriceIntervalProjectionSnapshot(): PriceIntervalProjectionSnapshot {
  return { intervals: new Map<string, PriceIntervalReadModel>() };
}

/** Fold one registry document into the price snapshot, if it is a `PRICE_TABLE`. Insert-only. */
export function applyRegistryPriceIntervalToSnapshot(
  snapshot: PriceIntervalProjectionSnapshot,
  document: RegistryDocument,
  sequence: number,
): void {
  const projected = nextPriceIntervalProjection(document, sequence);
  if (projected === null) return;
  for (const row of projected.rows) snapshot.intervals.set(priceIntervalKey(row), row);
}

// ---------------------------------------------------------------------------
// The artifact plane of the registry stream (P-36/local escalón A)
// ---------------------------------------------------------------------------

/**
 * The key of one blob generation in a snapshot.
 *
 * A digest is sixty-four hex characters and a generation is a decimal count, so
 * the separator cannot make two pairs collide.
 */
export function artifactBlobKey(contentSha256: string, blobGeneration: number): string {
  return contentSha256 + "#" + String(blobGeneration);
}

/** The key of one holder's live pin on one generation, in a snapshot. */
export function artifactLivePinKey(
  contentSha256: string,
  blobGeneration: number,
  pinHolderKind: string,
  pinHolderId: string,
): string {
  return canonicalJsonStringify([contentSha256, blobGeneration, pinHolderKind, pinHolderId]);
}

/**
 * The refusal of an artifact event kind this build does not record, or null.
 *
 * Asked BEFORE the contract's schema, so `RECLAIM_INTENDED`,
 * `RECLAIM_COMPLETED` and `REFERENCE_TOMBSTONED` are refused by their names at
 * `artifactEventKind` rather than as a union the parser could not match. A
 * value that is not one of the contract's nine is left to the schema, whose
 * issue is the right one for it. The replay of a stored row asks the same
 * question, so a planted reclamation fails a rebuild in these words.
 */
export function artifactEventKindRefusal(kind: unknown): LedgerValidationIssue | null {
  if (typeof kind !== "string") return null;
  if (!(ARTIFACT_EVENT_KINDS as readonly string[]).includes(kind)) return null;
  if ((DELIVERED_ARTIFACT_EVENT_KINDS as readonly string[]).includes(kind)) return null;
  return {
    path: "artifactEventKind",
    message:
      "artifact event kind " +
      kind +
      " is a word of the contract this build does not record: reclamation, collection and" +
      " tombstoning are refused by name until P-36 completo delivers them",
  };
}

/**
 * The refusals an artifact event earns on its own, before any state is read.
 *
 * Three, and each is a rule of the stream rather than of a row: a
 * `SECRET_BEARING` reference never enters the stream (artifacts §2, §10); a
 * reference names the one access policy this build defines (decision 59); and a
 * `PUBLICATION` pin is born and released by its publication's own events, never
 * by `PIN_ACQUIRED` or `PIN_RELEASED` — which is what lets a publication's
 * success find exactly the pin its intention took.
 *
 * The first two run over **every** reference an event carries, and that
 * includes the `intendedReference` block of a `PUBLICATION_INTENDED` (O-1 of
 * escalón C's postaudit, P-36/local D). The fold never reads that block, but it
 * is in the stream all the same, and a stream that refused a `SECRET_BEARING`
 * reference on the success while recording it verbatim on the intention would
 * hold exactly the material §10 keeps out — one event earlier. The door and the
 * rebuild both call this function, so a planted intention is refused on replay
 * with the words the door would have used.
 */
export function artifactEventRefusal(event: ArtifactRegistryEvent): LedgerValidationIssue | null {
  if (
    event.artifactEventKind === "PUBLICATION_SUCCEEDED" ||
    event.artifactEventKind === "REFERENCE_RECORDED"
  ) {
    const refusal = artifactReferenceRefusal(event.payload.reference, "payload.reference");
    if (refusal !== null) return refusal;
  }
  if (event.artifactEventKind === "PUBLICATION_INTENDED" && event.payload.intendedReference !== undefined) {
    const refusal = artifactReferenceRefusal(event.payload.intendedReference, "payload.intendedReference");
    if (refusal !== null) return refusal;
  }
  if (event.artifactEventKind === "PIN_ACQUIRED" && event.payload.pinHolderKind === "PUBLICATION") {
    return {
      path: "payload.pinHolderKind",
      message:
        "a PUBLICATION pin is taken by its PUBLICATION_INTENDED and released by that publication's" +
        " success or abandonment, never by PIN_ACQUIRED",
    };
  }
  return null;
}

/** The two stream rules a reference record earns wherever it rides, at `path`. */
function artifactReferenceRefusal(
  reference: { readonly classification: string; readonly accessPolicyId: string },
  path: string,
): LedgerValidationIssue | null {
  if (reference.classification === "SECRET_BEARING") {
    return {
      path: path + ".classification",
      message:
        "a SECRET_BEARING artifact is never published in the stream: it designates material" +
        " that demands review and blocking, and it is not a permission to store credentials",
    };
  }
  if (!(ARTIFACT_ACCESS_POLICY_IDS as readonly string[]).includes(reference.accessPolicyId)) {
    return {
      path: path + ".accessPolicyId",
      message:
        "access policy " +
        printable(reference.accessPolicyId) +
        " is not one this build defines; the closed set is " +
        ARTIFACT_ACCESS_POLICY_IDS.join(", "),
    };
  }
  return null;
}

/**
 * Where an artifact event lands in `registry_events`, derived from its payload.
 *
 * The subject is the resource the event is about (H-3, adjudicated): the
 * content digest for the three publication events, the reference for
 * `REFERENCE_RECORDED`, the pin for the two pin events. `content_digest` is the
 * content digest in all six. A derivation by rule, not by hash — nothing here
 * is a preimage.
 */
export function artifactSubjectOf(event: ArtifactRegistryEvent): {
  readonly documentId: string;
  readonly contentDigest: string;
} {
  switch (event.artifactEventKind) {
    case "PUBLICATION_INTENDED":
    case "PUBLICATION_SUCCEEDED":
    case "PUBLICATION_ABANDONED":
      return { documentId: event.payload.contentSha256, contentDigest: event.payload.contentSha256 };
    case "REFERENCE_RECORDED":
      return {
        documentId: event.payload.reference.artifactReferenceId,
        contentDigest: event.payload.contentSha256,
      };
    case "PIN_ACQUIRED":
    case "PIN_RELEASED":
      return { documentId: event.payload.artifactPinId, contentDigest: event.payload.contentSha256 };
  }
}

function artifactRefused(path: string, message: string): never {
  throw new LedgerValidationError([{ path, message }]);
}

function generationLabel(contentSha256: string, blobGeneration: number): string {
  return "content " + contentSha256 + " generation " + String(blobGeneration);
}

/**
 * What one artifact event writes, decided against a view of the four tables.
 *
 * One function for the door and the fold: the door hands it a view over the
 * base inside its transaction, the rebuild a view over the snapshot it is
 * filling, and both throw the same refusal for the same history. Artifacts
 * §8.1 is the table this implements, and every sequence it writes is the
 * `registry_events` sequence of the event itself. Nothing here reads a clock or
 * a file: the instants are the event's own.
 */
export function nextArtifactProjection(
  view: ArtifactFoldView,
  event: ArtifactRegistryEvent,
  sequence: number,
): ArtifactProjectionWrites {
  switch (event.artifactEventKind) {
    case "PUBLICATION_INTENDED":
      return foldPublicationIntended(view, event, sequence);
    case "PUBLICATION_SUCCEEDED":
      return foldPublicationSucceeded(view, event, sequence);
    case "PUBLICATION_ABANDONED":
      return foldPublicationAbandoned(view, event, sequence);
    case "REFERENCE_RECORDED":
      return foldReferenceRecorded(view, event, sequence);
    case "PIN_ACQUIRED":
      return foldPinAcquired(view, event, sequence);
    case "PIN_RELEASED":
      return foldPinReleased(view, event, sequence);
  }
}

type ArtifactEventOf<K extends ArtifactRegistryEvent["artifactEventKind"]> = Extract<
  ArtifactRegistryEvent,
  { readonly artifactEventKind: K }
>;

/**
 * `PUBLICATION_INTENDED`: a generation is born STAGED, or an existing one is
 * reused, and the publication's pin is taken on the exact generation.
 *
 * The generation is the producer's proposal and the ledger's verification. No
 * generation that is not reclaimed → the next one, `1 + highest`. A generation
 * `PUBLISHED` → deduplicated: its row is conserved whole and is not rewritten.
 * A generation `PUBLICATION_ABANDONED` → back to STAGED, keeping the grace
 * instant of its first intention, so the collector's clock never restarts. A
 * generation already `STAGED` → refused: a publication of that content is in
 * flight, and it ends before another begins.
 *
 * A reused generation keeps the encryption it was born with. An intention that
 * disagrees is refused with `LedgerArtifactEncryptionConflictError` before
 * anything is written.
 */
function foldPublicationIntended(
  view: ArtifactFoldView,
  event: ArtifactEventOf<"PUBLICATION_INTENDED">,
  sequence: number,
): ArtifactProjectionWrites {
  const intended = event.payload;
  const current = view.unreclaimedBlob(intended.contentSha256);
  let blob: ArtifactBlobReadModel | null;

  if (current === null) {
    const expected = view.highestBlobGeneration(intended.contentSha256) + 1;
    if (intended.blobGeneration !== expected) {
      artifactRefused(
        "payload.blobGeneration",
        "content " +
          intended.contentSha256 +
          " has no generation that is not reclaimed, so a new publication opens generation " +
          String(expected) +
          ", not " +
          String(intended.blobGeneration),
      );
    }
    blob = {
      contentSha256: intended.contentSha256,
      blobGeneration: intended.blobGeneration,
      mediaType: intended.mediaType,
      sizeBytes: intended.sizeBytes,
      lifecycleState: "STAGED",
      encryptionStatus: intended.encryptionStatus,
      keyReference: intended.keyReference,
      firstPublishedSequence: null,
      firstPublishedAt: null,
      reclaimId: null,
      reclaimedAt: null,
      graceStartedAt: event.occurredAt,
      encryptionProfile: intended.encryptionProfile,
      appliedSequence: sequence,
    };
  } else {
    if (intended.blobGeneration !== current.blobGeneration) {
      artifactRefused(
        "payload.blobGeneration",
        "content " +
          intended.contentSha256 +
          " is held at generation " +
          String(current.blobGeneration) +
          ", which a new intention reuses; this one names generation " +
          String(intended.blobGeneration),
      );
    }
    if (current.lifecycleState === "STAGED") {
      artifactRefused(
        "payload.contentSha256",
        "a publication of " +
          generationLabel(current.contentSha256, current.blobGeneration) +
          " is already in flight; it succeeds or is abandoned before another intention is recorded",
      );
    }
    if (current.lifecycleState === "RECLAIM_INTENDED") {
      artifactRefused(
        "payload.contentSha256",
        generationLabel(current.contentSha256, current.blobGeneration) +
          " is under reclamation, and no publication reuses it",
      );
    }

    const conflicts: string[] = [];
    if (current.encryptionStatus !== intended.encryptionStatus) conflicts.push("encryptionStatus");
    if (current.keyReference !== intended.keyReference) conflicts.push("keyReference");
    if (current.encryptionProfile !== intended.encryptionProfile) conflicts.push("encryptionProfile");
    if (conflicts.length > 0) {
      throw new LedgerArtifactEncryptionConflictError(
        current.contentSha256,
        current.blobGeneration,
        conflicts,
      );
    }
    if (current.sizeBytes !== intended.sizeBytes) {
      artifactRefused(
        "payload.sizeBytes",
        generationLabel(current.contentSha256, current.blobGeneration) +
          " is " +
          String(current.sizeBytes) +
          " bytes, and one digest does not name two sizes",
      );
    }

    blob =
      current.lifecycleState === "PUBLICATION_ABANDONED"
        ? { ...current, lifecycleState: "STAGED", appliedSequence: sequence }
        : null;
  }

  if (view.pin(intended.artifactPinId) !== null) {
    artifactRefused(
      "payload.artifactPinId",
      "pin " +
        printable(intended.artifactPinId) +
        " already exists, and a publication pin is born with its own intention",
    );
  }
  if (
    view.livePin(intended.contentSha256, intended.blobGeneration, "PUBLICATION", intended.commandId) !==
    null
  ) {
    artifactRefused(
      "payload.commandId",
      "command " +
        printable(intended.commandId) +
        " already holds a live publication pin on " +
        generationLabel(intended.contentSha256, intended.blobGeneration),
    );
  }

  return {
    blob,
    reference: null,
    pin: {
      artifactPinId: intended.artifactPinId,
      contentSha256: intended.contentSha256,
      blobGeneration: intended.blobGeneration,
      pinHolderKind: "PUBLICATION",
      pinHolderId: intended.commandId,
      acquiredSequence: sequence,
      releasedSequence: null,
      appliedSequence: sequence,
    },
  };
}

/**
 * The live publication pin a publication's outcome releases, or a refusal.
 *
 * The outcome names the pin its intention took, and the pin must be exactly
 * that one: a `PUBLICATION` pin, held by the same command, on the same
 * generation, and still live. This is what makes a success or an abandonment
 * with no intention before it a refusal rather than a fold.
 */
function livePublicationPin(
  view: ArtifactFoldView,
  payload: {
    readonly commandId: string;
    readonly contentSha256: string;
    readonly blobGeneration: number;
    readonly artifactPinId: string;
  },
): ArtifactPinReadModel {
  const pin = view.pin(payload.artifactPinId);
  const theIntentionsPin =
    pin !== null &&
    pin.pinHolderKind === "PUBLICATION" &&
    pin.pinHolderId === payload.commandId &&
    pin.contentSha256 === payload.contentSha256 &&
    pin.blobGeneration === payload.blobGeneration;
  if (pin === null || !theIntentionsPin) {
    return artifactRefused(
      "payload.artifactPinId",
      "no intention of command " +
        printable(payload.commandId) +
        " holds publication pin " +
        printable(payload.artifactPinId) +
        " on " +
        generationLabel(payload.contentSha256, payload.blobGeneration) +
        "; a publication ends only after its own intention",
    );
  }
  if (pin.releasedSequence !== null) {
    return artifactRefused(
      "payload.artifactPinId",
      "publication pin " +
        printable(pin.artifactPinId) +
        " was released at sequence " +
        String(pin.releasedSequence) +
        ", so its publication has already ended",
    );
  }
  return pin;
}

function releasedPin(pin: ArtifactPinReadModel, sequence: number): ArtifactPinReadModel {
  return { ...pin, releasedSequence: sequence, appliedSequence: sequence };
}

function referenceRow(
  record: Extract<ArtifactRegistryEvent, { readonly artifactEventKind: "REFERENCE_RECORDED" }>["payload"]["reference"],
  contentSha256: string,
  blobGeneration: number,
  sequence: number,
): ArtifactReferenceReadModel {
  return {
    artifactReferenceId: record.artifactReferenceId,
    contentSha256,
    blobGeneration,
    artifactClass: record.artifactClass,
    classification: record.classification,
    scopeKind: record.scopeKind,
    scopeId: record.scopeId,
    producerIdentity: record.producerIdentity,
    accessPolicyId: record.accessPolicyId,
    retentionClass: record.retentionClass,
    expiresAt: record.expiresAt,
    tombstonedAt: null,
    tombstoneReason: null,
    createdSequence: sequence,
    appliedSequence: sequence,
  };
}

function assertReferenceIsNew(view: ArtifactFoldView, artifactReferenceId: string): void {
  if (view.reference(artifactReferenceId) !== null) {
    artifactRefused(
      "payload.reference.artifactReferenceId",
      "reference " + printable(artifactReferenceId) + " already exists, and a reference is recorded once",
    );
  }
}

function existingBlob(
  view: ArtifactFoldView,
  contentSha256: string,
  blobGeneration: number,
): ArtifactBlobReadModel {
  const blob = view.blob(contentSha256, blobGeneration);
  if (blob === null) {
    return artifactRefused(
      "payload.blobGeneration",
      "content " + contentSha256 + " has no generation " + String(blobGeneration),
    );
  }
  return blob;
}

/**
 * `PUBLICATION_SUCCEEDED`: the reference is recorded and the publication pin
 * released, in the same append (artifacts §8, step 4).
 *
 * A STAGED generation becomes PUBLISHED, and this event's sequence and instant
 * become its `first_published_*` pair. A PUBLISHED generation — a deduplicated
 * publication — is conserved: the first success fixed the pair and no later
 * event moves it.
 */
function foldPublicationSucceeded(
  view: ArtifactFoldView,
  event: ArtifactEventOf<"PUBLICATION_SUCCEEDED">,
  sequence: number,
): ArtifactProjectionWrites {
  const succeeded = event.payload;
  const blob = existingBlob(view, succeeded.contentSha256, succeeded.blobGeneration);
  const pin = livePublicationPin(view, succeeded);
  if (blob.lifecycleState !== "STAGED" && blob.lifecycleState !== "PUBLISHED") {
    artifactRefused(
      "payload.blobGeneration",
      generationLabel(blob.contentSha256, blob.blobGeneration) +
        " is " +
        blob.lifecycleState +
        ", and a publication succeeds over a STAGED or a PUBLISHED generation",
    );
  }
  assertReferenceIsNew(view, succeeded.reference.artifactReferenceId);

  return {
    blob:
      blob.lifecycleState === "STAGED"
        ? {
            ...blob,
            lifecycleState: "PUBLISHED",
            firstPublishedSequence: sequence,
            firstPublishedAt: event.occurredAt,
            appliedSequence: sequence,
          }
        : null,
    reference: referenceRow(
      succeeded.reference,
      succeeded.contentSha256,
      succeeded.blobGeneration,
      sequence,
    ),
    pin: releasedPin(pin, sequence),
  };
}

/**
 * `PUBLICATION_ABANDONED`: the publication pin is released, and a generation
 * that never published becomes `PUBLICATION_ABANDONED` with its grace instant
 * conserved. A PUBLISHED generation — a deduplicated publication that did not
 * complete — keeps its state.
 */
function foldPublicationAbandoned(
  view: ArtifactFoldView,
  event: ArtifactEventOf<"PUBLICATION_ABANDONED">,
  sequence: number,
): ArtifactProjectionWrites {
  const abandoned = event.payload;
  const blob = existingBlob(view, abandoned.contentSha256, abandoned.blobGeneration);
  const pin = livePublicationPin(view, abandoned);
  if (blob.lifecycleState !== "STAGED" && blob.lifecycleState !== "PUBLISHED") {
    artifactRefused(
      "payload.blobGeneration",
      generationLabel(blob.contentSha256, blob.blobGeneration) +
        " is " +
        blob.lifecycleState +
        ", and a publication is abandoned over a STAGED or a PUBLISHED generation",
    );
  }
  return {
    blob:
      blob.lifecycleState === "STAGED"
        ? { ...blob, lifecycleState: "PUBLICATION_ABANDONED", appliedSequence: sequence }
        : null,
    reference: null,
    pin: releasedPin(pin, sequence),
  };
}

/**
 * `REFERENCE_RECORDED`: one more authorized access to a PUBLISHED generation.
 *
 * Never over a STAGED one: a reference is written after its bytes are
 * published, never before (artifacts §8). Two references to one blob from one
 * producer in one scope, under different policies or retentions, are both
 * recorded — nothing here or in the base is unique over that triple.
 */
function foldReferenceRecorded(
  view: ArtifactFoldView,
  event: ArtifactEventOf<"REFERENCE_RECORDED">,
  sequence: number,
): ArtifactProjectionWrites {
  const recorded = event.payload;
  const blob = existingBlob(view, recorded.contentSha256, recorded.blobGeneration);
  if (blob.lifecycleState !== "PUBLISHED") {
    artifactRefused(
      "payload.blobGeneration",
      generationLabel(blob.contentSha256, blob.blobGeneration) +
        " is " +
        blob.lifecycleState +
        ", and a reference is recorded only over a PUBLISHED generation",
    );
  }
  assertReferenceIsNew(view, recorded.reference.artifactReferenceId);
  return {
    blob: null,
    reference: referenceRow(recorded.reference, recorded.contentSha256, recorded.blobGeneration, sequence),
    pin: null,
  };
}

/**
 * `PIN_ACQUIRED`: a protection of one generation, one live pin per holder.
 *
 * Taking the same pin again — same id, same holder, same generation, still
 * live — is idempotent: the event is recorded and the row is not rewritten
 * (artifacts §5). A second live pin for the same holder under another id is
 * refused, and so is reusing the id of a pin already released: a new
 * protection takes a new id.
 */
function foldPinAcquired(
  view: ArtifactFoldView,
  event: ArtifactEventOf<"PIN_ACQUIRED">,
  sequence: number,
): ArtifactProjectionWrites {
  const acquired = event.payload;
  const blob = existingBlob(view, acquired.contentSha256, acquired.blobGeneration);
  if (blob.lifecycleState === "RECLAIM_INTENDED" || blob.lifecycleState === "RECLAIMED") {
    artifactRefused(
      "payload.blobGeneration",
      generationLabel(blob.contentSha256, blob.blobGeneration) +
        " is " +
        blob.lifecycleState +
        ", and a pin protects only a generation that is not being reclaimed",
    );
  }

  const existing = view.pin(acquired.artifactPinId);
  if (existing !== null) {
    if (existing.releasedSequence !== null) {
      artifactRefused(
        "payload.artifactPinId",
        "pin " +
          printable(existing.artifactPinId) +
          " was released at sequence " +
          String(existing.releasedSequence) +
          ", and a new protection takes a new pin id",
      );
    }
    const same =
      existing.contentSha256 === acquired.contentSha256 &&
      existing.blobGeneration === acquired.blobGeneration &&
      existing.pinHolderKind === acquired.pinHolderKind &&
      existing.pinHolderId === acquired.pinHolderId;
    if (!same) {
      artifactRefused(
        "payload.artifactPinId",
        "pin " +
          printable(existing.artifactPinId) +
          " is live for another holder or another generation",
      );
    }
    return { blob: null, reference: null, pin: null };
  }

  const live = view.livePin(
    acquired.contentSha256,
    acquired.blobGeneration,
    acquired.pinHolderKind,
    acquired.pinHolderId,
  );
  if (live !== null) {
    artifactRefused(
      "payload.pinHolderId",
      "holder " +
        printable(acquired.pinHolderId) +
        " already holds live pin " +
        printable(live.artifactPinId) +
        " on " +
        generationLabel(acquired.contentSha256, acquired.blobGeneration) +
        "; taking it again is the same pin id",
    );
  }

  return {
    blob: null,
    reference: null,
    pin: {
      artifactPinId: acquired.artifactPinId,
      contentSha256: acquired.contentSha256,
      blobGeneration: acquired.blobGeneration,
      pinHolderKind: acquired.pinHolderKind,
      pinHolderId: acquired.pinHolderId,
      acquiredSequence: sequence,
      releasedSequence: null,
      appliedSequence: sequence,
    },
  };
}

/** `PIN_RELEASED`: a live, non-publication pin on the named generation ends. */
function foldPinReleased(
  view: ArtifactFoldView,
  event: ArtifactEventOf<"PIN_RELEASED">,
  sequence: number,
): ArtifactProjectionWrites {
  const released = event.payload;
  const pin = view.pin(released.artifactPinId);
  if (pin === null) {
    return artifactRefused(
      "payload.artifactPinId",
      "there is no pin " + printable(released.artifactPinId) + " to release",
    );
  }
  if (pin.contentSha256 !== released.contentSha256 || pin.blobGeneration !== released.blobGeneration) {
    artifactRefused(
      "payload.artifactPinId",
      "pin " +
        printable(pin.artifactPinId) +
        " protects another generation than " +
        generationLabel(released.contentSha256, released.blobGeneration),
    );
  }
  if (pin.pinHolderKind === "PUBLICATION") {
    artifactRefused(
      "payload.artifactPinId",
      "pin " +
        printable(pin.artifactPinId) +
        " is a PUBLICATION pin, released by its publication's success or abandonment, never by PIN_RELEASED",
    );
  }
  if (pin.releasedSequence !== null) {
    artifactRefused(
      "payload.artifactPinId",
      "pin " +
        printable(pin.artifactPinId) +
        " was already released at sequence " +
        String(pin.releasedSequence),
    );
  }
  return { blob: null, reference: null, pin: releasedPin(pin, sequence) };
}

/** In-memory projection of the artifact plane of the registry stream. */
export function createArtifactProjectionSnapshot(): ArtifactProjectionSnapshot {
  return {
    blobs: new Map(),
    references: new Map(),
    pins: new Map(),
    tombstones: new Map(),
    highestGenerations: new Map(),
    livePins: new Map(),
  };
}

/** The fold's view over a snapshot, answering what the door answers from the base. */
export function artifactSnapshotView(snapshot: ArtifactProjectionSnapshot): ArtifactFoldView {
  return {
    blob: (contentSha256, blobGeneration) =>
      snapshot.blobs.get(artifactBlobKey(contentSha256, blobGeneration)) ?? null,
    unreclaimedBlob: (contentSha256) => {
      const highest = snapshot.highestGenerations.get(contentSha256) ?? 0;
      for (let generation = highest; generation >= 1; generation -= 1) {
        const blob = snapshot.blobs.get(artifactBlobKey(contentSha256, generation));
        if (blob !== undefined && blob.lifecycleState !== "RECLAIMED") return blob;
      }
      return null;
    },
    highestBlobGeneration: (contentSha256) => snapshot.highestGenerations.get(contentSha256) ?? 0,
    reference: (artifactReferenceId) => snapshot.references.get(artifactReferenceId) ?? null,
    pin: (artifactPinId) => snapshot.pins.get(artifactPinId) ?? null,
    livePin: (contentSha256, blobGeneration, pinHolderKind, pinHolderId) => {
      const id = snapshot.livePins.get(
        artifactLivePinKey(contentSha256, blobGeneration, pinHolderKind, pinHolderId),
      );
      return id === undefined ? null : (snapshot.pins.get(id) ?? null);
    },
  };
}

/**
 * Fold one artifact event into a snapshot, refusing exactly what the door would.
 *
 * The stateless refusals first, then the stateful decision against the snapshot
 * itself, then the writes. A history the door could never have accepted fails a
 * rebuild here, at the event that caused it, in the door's own words.
 */
export function applyArtifactEventToSnapshot(
  snapshot: ArtifactProjectionSnapshot,
  event: ArtifactRegistryEvent,
  sequence: number,
): void {
  const refusal = artifactEventRefusal(event);
  if (refusal !== null) throw new LedgerValidationError([refusal]);

  const writes = nextArtifactProjection(artifactSnapshotView(snapshot), event, sequence);
  if (writes.blob !== null) {
    const blob = writes.blob;
    snapshot.blobs.set(artifactBlobKey(blob.contentSha256, blob.blobGeneration), blob);
    const highest = snapshot.highestGenerations.get(blob.contentSha256) ?? 0;
    if (blob.blobGeneration > highest) {
      snapshot.highestGenerations.set(blob.contentSha256, blob.blobGeneration);
    }
  }
  if (writes.reference !== null) {
    snapshot.references.set(writes.reference.artifactReferenceId, writes.reference);
  }
  if (writes.pin !== null) {
    const pin = writes.pin;
    snapshot.pins.set(pin.artifactPinId, pin);
    const key = artifactLivePinKey(pin.contentSha256, pin.blobGeneration, pin.pinHolderKind, pin.pinHolderId);
    if (pin.releasedSequence === null) snapshot.livePins.set(key, pin.artifactPinId);
    else snapshot.livePins.delete(key);
  }
}
