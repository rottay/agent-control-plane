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

import { LedgerValidationError } from "../errors/index.js";
import type {
  ExecutionRouteReadModel,
  InitiativeReadModel,
  RegistryDocument,
  RegistryProjectionSnapshot,
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
