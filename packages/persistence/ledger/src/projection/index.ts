import {
  ResolvedRoute,
  RoadmapVersion,
  TERMINAL_STATES,
  WORKER_ROLES,
  parseWorkerIdentity,
  type ControlPlaneEvent,
  type InitiativeEvent,
  type WorkerRole,
} from "@acp/contracts";

import {
  EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1,
  EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1,
} from "@acp/contracts";

import { canonicalJsonStringify, sha256Hex } from "../canonical-json/index.js";
import { LedgerValidationError } from "../errors/index.js";
import {
  DISPATCH_STATES,
  DISPATCH_STATE_TRANSITIONS,
  EFFECT_OUTCOME_STATUSES,
  MODEL_RESOLUTION_STATUSES,
  REDACTION_VERDICTS,
} from "../types/index.js";
import type {
  DispatchAttemptReadModel,
  DispatchState,
  EffectOutcomeStatus,
  EffectReadModel,
  ExecutionRouteSegmentReadModel,
  ExecutionRouteReadModel,
  InitiativeReadModel,
  PromptOccurrenceReadModel,
  RegistryDocument,
  RegistryProjectionSnapshot,
  ResponseOccurrenceReadModel,
  RoadmapVersionReadModel,
  RoutingAssignmentFallbackRow,
  RoutingAssignmentProjection,
  RoutingAssignmentReadModel,
  TaskAttemptReadModel,
  TaskReadModel,
  TaskRevisionReadModel,
  WorkerReadModel,
} from "../types/index.js";

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
 * The key a revision record may NOT carry in this version of the contract.
 *
 * `envelope_artifact_reference_id` belongs to P-36/local. A reader of this
 * build that met the key would have to either ignore it — silently dropping a
 * fact the writer thought it recorded — or interpret a reference to a plane
 * that does not exist here. Neither is acceptable, so the fold refuses the
 * event outright and the refusal names the key.
 */
const ARTIFACT_REFERENCE_KEY = "envelopeArtifactReferenceId";

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
 * There is one exception to that totality, and it is deliberate: an event whose
 * payload carries an artifact reference key is **refused** rather than folded.
 * See `ARTIFACT_REFERENCE_KEY`. The distinction is between a payload this
 * contract has no opinion about — which is ignored — and a payload that claims
 * a fact this contract cannot represent, which is a reader being asked to
 * pretend it understood something.
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

  if (payload[ARTIFACT_REFERENCE_KEY] !== undefined) {
    throw new LedgerValidationError([
      {
        path: "payload." + ARTIFACT_REFERENCE_KEY,
        message:
          "a revision record in this contract version carries no artifact reference; " +
          "the key belongs to a later migration and this reader will not guess at it",
      },
    ]);
  }

  return {
    taskId: event.taskId,
    revisionNumber,
    revisionId,
    envelopeSha256,
    restoredFromRevisionId: payloadText(payload, RESTORED_FROM_REVISION_ID_KEY),
    createdAt: event.occurredAt,
    createdBy: event.emittedBy,
    contractVersion: event.contractVersion,
    sequence,
  };
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
 * What a resolution event says happened to one delivery, and to its effect.
 *
 * The third type is the one that is easy to leave out of a three-type cut, and
 * without it `dispatch_state` could never leave `INTENDED` and
 * `effect_read_model.outcome_status` could never be written at all. "Outcome"
 * here spans every move after the intention, because every one of them is a
 * report about how that delivery went: claimed locally, accepted externally,
 * settled, abandoned.
 *
 * `effectOutcomeStatus` is optional because not every move is also the effect's
 * ending — `INTENDED → CLAIMED` says nothing about the operation's result. When
 * it is present, the effect's pair is written from it and from this event's own
 * instant.
 */
export interface DispatchOutcomeRecord {
  readonly dispatchAttemptId: string;
  readonly dispatchState: DispatchState;
  readonly terminalAt: string | null;
  readonly acceptedAt: string | null;
  readonly externalHandle: string | null;
  readonly providerIdempotencyKey: string | null;
  readonly effectOutcomeStatus: EffectOutcomeStatus | null;
  readonly recordedAt: string;
  readonly sequence: number;
}

/** The resolution one event records, if it is one that carries a record. */
export function dispatchOutcomeRecord(
  event: ControlPlaneEvent,
  sequence: number,
): DispatchOutcomeRecord | null {
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

  return {
    dispatchAttemptId,
    dispatchState,
    terminalAt,
    acceptedAt: recordText(record, "acceptedAt"),
    externalHandle: recordText(record, "externalHandle"),
    providerIdempotencyKey: recordText(record, "providerIdempotencyKey"),
    effectOutcomeStatus: recordWord(record, "effectOutcomeStatus", EFFECT_OUTCOME_STATUSES),
    recordedAt: event.occurredAt,
    sequence,
  };
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

/**
 * How one occurrence event reads: a row, or the reason it is not one.
 *
 * One reader serves both callers, which is this file's founding rule applied
 * to a refusal as well as to a row. The append door throws the refusal by name;
 * the fold projects no row for it. Written twice, the door and a rebuild would
 * come to disagree about which payloads are occurrences, and the disagreement
 * would only surface as a rebuild quietly holding fewer rows than the live base.
 */
export type OccurrenceReading<T> =
  | { readonly kind: "row"; readonly row: T }
  | { readonly kind: "refused"; readonly path: string; readonly message: string };

/** Why one occurrence cannot be linked to what it claims to belong to. */
export interface OccurrenceRefusal {
  readonly path: string;
  readonly message: string;
}

/** The attempt coordinate a delivery's effect belongs to. */
export interface OccurrenceOwner {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
}

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
  };
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

/** Fold one event into an in-memory snapshot. */
export function applyEventToSnapshot(
  snapshot: ProjectionSnapshot,
  event: ControlPlaneEvent,
  sequence: number,
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
      if (canonicalRevision(existing) !== canonicalRevision(revision)) {
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

  // The resolution, last, because it reads rows the three folds above may have
  // written in this same event. Unlike them it is a reduce: it replaces a
  // delivery's row and may write an effect's outcome pair.
  const outcome = dispatchOutcomeRecord(event, sequence);
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
      if (
        owner.outcomeStatus !== null &&
        owner.outcomeStatus !== outcome.effectOutcomeStatus
      ) {
        // §6 `:252`: an outcome is recorded, not amended. A terminal one is
        // reused and an uncertain one demands reconciliation — neither is
        // overwritten by a second answer to the same question.
        throw new LedgerValidationError([
          {
            path: "payload." + OUTCOME_KEY + ".effectOutcomeStatus",
            message:
              "effect " +
              current.effectId +
              " already ended " +
              owner.outcomeStatus +
              ", and an outcome is recorded once; this event says " +
              outcome.effectOutcomeStatus,
          },
        ]);
      }
      if (owner.outcomeStatus === null) {
        snapshot.effects.set(current.effectId, {
          ...owner,
          outcomeStatus: outcome.effectOutcomeStatus,
          outcomeRecordedAt: outcome.recordedAt,
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
 */
export function canonicalRevision(revision: TaskRevisionReadModel): string {
  return [
    revision.revisionId,
    revision.envelopeSha256,
    revision.restoredFromRevisionId ?? "",
  ].join("\u0000");
}

// ---------------------------------------------------------------------------
// The initiative stream's projections
// ---------------------------------------------------------------------------

/** Apply one initiative event to an initiative projection row. */
export function nextInitiativeProjection(
  current: InitiativeReadModel | null,
  event: InitiativeEvent,
  sequence: number,
): InitiativeReadModel {
  const base = {
    initiativeId: event.initiativeId,
    currentStatus: event.toStatus,
    lastSequence: sequence,
    lastEventId: event.eventId,
    lastEventType: event.type,
    lastTransitionId: event.transitionId,
    lastEmittedBy: event.emittedBy,
    updatedAt: event.occurredAt,
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
 * What this fold does **not** do is check eligibility. The contract requires
 * `model_version_id` to be validated fail-closed against an ACTIVE model
 * version, and that is the write gate of the module that owns the semantics,
 * not this one: the ledger is storage, it may not import `@acp/accounts`, and
 * `model_version_read_model` does not exist. The fold projects what the
 * document recorded.
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
