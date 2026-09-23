import type {
  AccountActionEvent,
  ArtifactClass,
  ArtifactClassification,
  ArtifactRegistryEvent,
  BlobLifecycleState,
  EncryptionStatus,
  PinHolderKind,
  ReferenceScopeKind,
  RetentionClass,
  ControlPlaneEvent,
  ControlPlaneEventType,
  InitiativeEvent,
  InitiativeEventType,
  InitiativeStatus,
  RoadmapVersionKind,
  TaskState,
  TransportKind,
  WorkerRole,
} from "@acp/contracts";
import type { OUTBOX_FAILURE_CODES } from "@acp/contracts";

import type { OutboxCommandKind, OutboxState, OutboxStream } from "../outbox-store/index.js";

/**
 * Public value types of the ledger package.
 *
 * Everything here is plain data. No handle, no statement and no raw database
 * object crosses this boundary, because a caller holding a raw connection could
 * mutate the append-only table and the ledger would have no way to notice.
 */

/**
 * Deliberate fault seam, for tests only.
 *
 * Rollback is a claim that cannot be verified by reading the code: the only
 * honest proof is to make a step fail on purpose and then show that the event
 * did not survive. These hooks exist so a test can do exactly that, and they
 * are the reason the rollback tests are evidence rather than prose.
 *
 * The field is prefixed and documented as test-only. Production callers must
 * never set it, and nothing in this package sets it by default.
 */
export interface LedgerTestFaults {
  /** Runs inside the append transaction, after INSERT, before projection. */
  readonly beforeProjection?: (() => void) | undefined;
  /** Runs inside the append transaction, after projection, before commit. */
  readonly beforeAppendCommit?: (() => void) | undefined;
  /** Runs inside the rebuild transaction, after replay, before commit. */
  readonly beforeRebuildCommit?: (() => void) | undefined;
}

export interface OpenLedgerOptions {
  /**
   * Open query-only. A read-only handle never migrates and never mutates; it
   * fails closed if the applied migration set is not exactly this build.
   */
  readonly readOnly?: boolean | undefined;
  /** Lock acquisition budget. Bounded so a stuck writer cannot hang a reader. */
  readonly busyTimeoutMs?: number | undefined;
  /** Test-only fault seam. See LedgerTestFaults. */
  readonly __testFaults?: LedgerTestFaults | undefined;
}

/**
 * A stream that can be referenced as a cause, in this build.
 *
 * The contract's vocabulary is four names; this is the subset whose events
 * carry an `event_sha256`, and therefore the subset a reference can be checked
 * against. `registry_events` joined it in P-09/log-C, which is the packet that
 * gave that stream a chain. `account_events` has none — migration 5 gives it
 * neither `previous_sha256` nor `event_sha256` — so a reference naming it could
 * only ever be believed, and a reference nobody can check is the weak link the
 * typed triple exists to rule out. Widening this to four belongs to the packet
 * that gives that stream a digest.
 */
export type CausationStream =
  | "control_plane_events"
  | "initiative_events"
  | "registry_events";

/**
 * A verifiable reference to the event that caused this one (P-09/log-B).
 *
 * Two streams' sequences are not comparable, so causality between them cannot
 * be expressed by ordering. It is expressed by naming the stream, the position
 * in it, and the digest of the event found there — and the digest is the whole
 * point: a triple whose digest does not match the row it names is refused as an
 * invalid reference rather than recorded as a weak link.
 *
 * Optional everywhere. `null` is the ordinary case: the first event of a chain,
 * or one an owner action outside the system provoked.
 */
export interface CausationRef {
  readonly stream: CausationStream;
  /** The referenced event's position in its own stream. One or greater. */
  readonly sequence: number;
  /** The referenced event's own `event_sha256`, 64 lowercase hex characters. */
  readonly sha256: string;
}

/** One durable ledger row, with the event and its chain position. */
export interface LedgerEventRecord {
  /** Monotonic integer position. The only ordering the ledger guarantees. */
  readonly sequence: number;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly event: ControlPlaneEvent;
  /** The exact bytes the chain digest was computed over. */
  readonly canonicalJson: string;
  readonly previousSha256: string;
  readonly eventSha256: string;
  /**
   * The event this one was recorded as caused by, or null.
   *
   * Not part of `canonicalJson` and not part of `eventSha256`: the chain covers
   * the body alone, and widening it would mean rehashing history.
   */
  readonly causation: CausationRef | null;
}

export interface AppendResult {
  /** false means this was an exact replay and nothing new was written. */
  readonly inserted: boolean;
  readonly record: LedgerEventRecord;
}

/**
 * The outcome of one `appendBatch` (P-09/log-A).
 *
 * Per event rather than per batch, because a batch is all-or-nothing about
 * *writing* and not about *inserting*: an exact replay inside a batch is a
 * no-op for that event alone, and a caller retrying a partially recorded batch
 * needs to see which of its events were already there. A single boolean for the
 * batch would have to lie about one case or the other.
 */
export interface AppendBatchResult {
  /** One result per candidate, in the order they were given. */
  readonly results: readonly AppendResult[];
  /** How many were written. The rest were exact replays. */
  readonly insertedCount: number;
  /** The task stream's head after the batch committed. */
  readonly headSequence: number;
  readonly headEventSha256: string;
}

export interface EventQuery {
  /** Exclusive sequence cursor. Pass the previous page nextCursor. */
  readonly afterSequence?: number | undefined;
  readonly taskId?: string | undefined;
  readonly type?: ControlPlaneEventType | undefined;
  readonly emittedBy?: string | undefined;
  readonly toState?: TaskState | undefined;
  readonly limit?: number | undefined;
}

export interface EventPage {
  readonly events: readonly LedgerEventRecord[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
}

/** Derived per-task projection. Holds no fact that is not in the ledger. */
export interface TaskReadModel {
  readonly taskId: string;
  /**
   * The initiative the task was discovered under, when the discovering event
   * carried one. Null for every task whose `TASK_DISCOVERED` predates the
   * field — old events must keep folding, so this is nullable by law rather
   * than by convenience.
   */
  readonly initiativeId: string | null;
  readonly currentState: TaskState;
  readonly latestAttempt: number;
  readonly eventCount: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly lastEventId: string;
  readonly lastEventType: ControlPlaneEventType;
  readonly lastTransitionId: string;
  readonly lastEmittedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly isTerminal: boolean;
  /**
   * What the latest revision of this task says (P-05/B).
   *
   * All three are `null` until a revision record arrives, and they are `null`
   * **for ever** on a task whose whole history predates migration 11 — which is
   * a lawful state, not a gap: the coordinate is written by a producer that
   * does not exist yet, and nothing backfills a number it cannot know.
   *
   * A convenience denormalization and never the authority: the authority is the
   * row in `task_revision_read_model`. A reader that needs certainty asks
   * there.
   */
  readonly envelopeSha256: string | null;
  readonly latestRevisionNumber: number | null;
  readonly latestAttemptNumber: number | null;
  /**
   * What the intake door recorded when the task entered (P-14 C, execution §1).
   *
   * Written once, by the `TASK_DISCOVERED` that opens a task through the intake
   * door, and carried by every later event. `null` on every task that entered
   * any other way — the legacy daemon walk records none of the three — which
   * means "not recorded", never "absent". `stepId` is also `null` on a task that
   * entered with no roadmap link, which is the one case the dictionary allows.
   */
  readonly stepId: string | null;
  readonly role: string | null;
  readonly commitPolicy: string | null;
}

/**
 * The client key one task entered under — contracts §15, execution §1.1 (P-14 C).
 *
 * `(clientScope, clientRequestKey)` is the request link's idempotency key, and
 * it is unique. The row names what the key produced: the task, its revision and
 * the envelope digest that revision carries. The digest is not part of the key;
 * it is the precondition a second submission under the same key is compared
 * against. Insert-only: a second arrival with the same row is a replay, with
 * another row it is refused.
 */
export interface TaskSubmissionReadModel {
  readonly clientScope: string;
  readonly clientRequestKey: string;
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly envelopeSha256: string;
  /** The task-stream position of the event that folded the row. */
  readonly sequence: number;
  /** The folding event's `occurredAt`. Never a clock read. */
  readonly createdAt: string;
}

/**
 * The transition an intake records (P-14 C, ADR 0087).
 *
 * Its own name, and deliberately not `discovered`: the daemon's walk writes its
 * discovery under that transition, with a submission digest the continuity of
 * P-15 expects to find there, and an intake written under the same name would be
 * a discovery that carries none. One module builds an event under it (L-P14C-1).
 */
export const TASK_INTAKE_TRANSITION_ID = "intake";

/**
 * The grammar of both halves of a task's client key (P-14 C).
 *
 * ASCII, an alphanumeric first character, then up to 199 more of a set that
 * admits `.`, `_`, `:`, `/` and `-`: a worker identity, a uuid and a dotted
 * operator name all fit, and a space — the snapshot's separator — does not.
 * Restated by `@acp/protocol`'s request schema, which may not import this
 * package; the fold holds the stream to this one.
 */
export const TASK_CLIENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/**
 * The payload of the `TASK_DISCOVERED` the intake door records, by name (P-14 C,
 * ADR 0087).
 *
 * Closed, and held by the fold rather than by the append door, on
 * `INITIATIVE_REGISTRATION_PAYLOAD_KEYS`' precedent: the contract's payload is a
 * bounded record, and history recorded under another shape stays readable. The
 * first six are the revision record the fold already reads by presence, and
 * `initiativeId` is the attribution it already reads from this event type. The
 * envelope is not among these keys: its bytes go to the private plane, and the
 * stream records the digest and the reference that names them.
 */
export const TASK_INTAKE_PAYLOAD_KEYS = [
  "revisionId",
  "revisionNumber",
  "attemptNumber",
  "envelopeSha256",
  "restoredFromRevisionId",
  "envelopeArtifactReferenceId",
  "initiativeId",
  "clientScope",
  "clientRequestKey",
  "roadmapVersionId",
  "stepId",
  "role",
  "commitPolicy",
  "resolution",
] as const;

/**
 * The keys of an intake's `resolution`: the GLOBAL assignment the role resolved
 * to, and the vector of watermarks it was read at (E4, N-P14-3).
 */
export const TASK_INTAKE_RESOLUTION_KEYS = [
  "assignmentId",
  "assignmentVersion",
  "slot",
  "modelVersionId",
  "provider",
  "model",
  "release",
  "transportKind",
  "watermarks",
] as const;

/** The keys of one watermark an intake's resolution records. */
export const TASK_INTAKE_WATERMARK_KEYS = [
  "projectionName",
  "sourceStream",
  "appliedThroughSequence",
  "eventCount",
  "sourceHeadSha256",
] as const;

/** One watermark row a resolution was read at, as the intake payload records it. */
export interface TaskIntakeWatermark {
  readonly projectionName: string;
  readonly sourceStream: string;
  readonly appliedThroughSequence: number;
  readonly eventCount: number;
  readonly sourceHeadSha256: string;
}

/** The resolution an intake recorded. */
export interface TaskIntakeResolution {
  readonly assignmentId: string;
  readonly assignmentVersion: number;
  readonly slot: number;
  readonly modelVersionId: string;
  readonly provider: string;
  readonly model: string;
  readonly release: string;
  readonly transportKind: string;
  readonly watermarks: readonly TaskIntakeWatermark[];
}

/** The closed intake payload, read back from one `TASK_DISCOVERED`. */
export interface TaskIntakePayload {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly envelopeSha256: string;
  readonly envelopeArtifactReferenceId: string;
  readonly initiativeId: string;
  readonly clientScope: string;
  readonly clientRequestKey: string;
  readonly roadmapVersionId: string | null;
  readonly stepId: string | null;
  readonly role: string;
  readonly commitPolicy: string;
  readonly resolution: TaskIntakeResolution;
}

/**
 * One revision of a task's work — execution §2, the second rung of the identity
 * ladder (P-05/B).
 *
 * The coordinate is `(taskId, revisionNumber)`; `revisionId` is the stable
 * global handle for naming a revision without carrying the pair. A change to
 * any field of the envelope is a new revision; a retry of the same revision is
 * a new attempt, and attempts are not here.
 *
 * **The row is insert-only.** A second arrival at the same coordinate with
 * different content is refused, not merged: a revision is a record of what was
 * asked, and rewriting it would destroy the thing it exists to preserve.
 *
 * `envelopeSha256` is NOT unique per task, on purpose. Restoring an earlier
 * envelope is a new revision with the same digest (§7.3), and a uniqueness
 * constraint there would forbid exactly the case the model exists to allow —
 * which is why `restoredFromRevisionId` exists to say so explicitly.
 *
 * `envelopeArtifactReferenceId` is the reference the envelope's bytes are read
 * by (P-36/local D, decision 41, ADR 0084). `null` on every revision recorded
 * under `2.2.0`, `2.3.0` or `2.4.0` — the cohort before the plane that mints it —
 * and never `null` on a later one. It is never derived from `envelopeSha256`:
 * knowing a digest grants no access to the bytes it names.
 */
export interface TaskRevisionReadModel {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly revisionId: string;
  readonly envelopeSha256: string;
  readonly envelopeArtifactReferenceId: string | null;
  readonly restoredFromRevisionId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly contractVersion: string;
  readonly sequence: number;
}

/**
 * One attempt at one revision — execution §3, the third rung of the identity
 * ladder (P-18/protocolo B).
 *
 * The coordinate is `(taskId, revisionNumber, attemptNumber)` and
 * `attemptNumber` restarts at 1 in each new revision, which is exactly why the
 * coordinate carries the revision: a restore cannot collide with the attempt it
 * restored from.
 *
 * **Two numbers, and only one of them counts anything.** `attemptNumber` is the
 * coordinate's third component. `legacyAttemptNumber` is the flat integer
 * migration 1's `attempt` column has always demanded — monotone *per task*,
 * assigned once by a compare-and-set inside the append transaction, never
 * derived from a clock, and equal to `control_plane_events.attempt` on every
 * event of this coordinate. It is not a per-revision counter and not a second
 * authority about which attempt this is.
 *
 * `invocationId` is the durable neutral identity of the V1 run, unique
 * **globally**: with the primary key it is the bijection execution §3 asks for,
 * one invocation per attempt and one attempt per invocation. It is not a worker
 * run id and not an engine's private handle, and replay and handoff carry it
 * rather than minting a second one.
 *
 * **The row is insert-only, and it is born open.** `endedAt` and `outcome` are
 * `null` on every row this build writes: escalón B records the opening and has
 * no closer, because mapping a terminal task state onto `effect_outcome_status`
 * is a decision nobody has taken. ADR 0073 records the debt and names the
 * escalón that owes it. A reader treats `null` here as "still running or not
 * recorded yet", never as "ended with no outcome" — which
 * `ck_task_attempt_read_model__outcome_pair` makes unrepresentable anyway.
 */
export interface TaskAttemptReadModel {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly legacyAttemptNumber: number;
  readonly invocationId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: string | null;
  readonly sequence: number;
}

/**
 * How resolved a model alias turned out to be — execution §4 and §8, one
 * vocabulary shared by both (P-18/protocolo C).
 *
 * `UNKNOWN` and `NOT_OBSERVABLE` are different failures and the distinction is
 * load-bearing: the first means the version could not be resolved *despite
 * trying*, the second that the transport exposes no resolvable version at all.
 * In neither case is `modelVersionId` ever invented to fill the column.
 */
export const MODEL_RESOLUTION_STATUSES = ["RESOLVED", "UNKNOWN", "NOT_OBSERVABLE"] as const;
export type ModelResolutionStatus = (typeof MODEL_RESOLUTION_STATUSES)[number];

/**
 * How a logical effect turned out — execution §6's `effect_outcome_status`.
 *
 * The same four `task_attempt_read_model.outcome` admits, and the fourth is the
 * one that carries the packet's whole point. `OUTCOME_UNKNOWN` is **not** a
 * failure: it is a recorded uncertain exposure, it does not license a blind
 * retry, and it is never the default of creation — an intention never
 * dispatched carries `null`, which is absence of data (execution §6 `:252`).
 */
export const EFFECT_OUTCOME_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "OUTCOME_UNKNOWN",
] as const;
export type EffectOutcomeStatus = (typeof EFFECT_OUTCOME_STATUSES)[number];

/**
 * The five states of one delivery — execution §7 `:347`, and there are five.
 *
 * `RECONCILING` is deliberately absent. It is `outbox_message`'s state word
 * (coordination §2, landed by escalón E2), and §7 `:360` says an overdue
 * `INFLIGHT` enables **reconciliation** — a verb. A sixth state here would
 * contradict the CHECK the dictionary fixes, and would also hide the property
 * that matters: such a row stays `INFLIGHT` and is *found* by an index, which
 * is a report, not a transition.
 */
export const DISPATCH_STATES = [
  "INTENDED",
  "CLAIMED",
  "INFLIGHT",
  "SETTLED",
  "ABANDONED",
] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

/**
 * The states a delivery may move to, from each state it can be in.
 *
 * Forward only, and the two terminals move nowhere. Declared as a map rather
 * than as a predicate so a refusal can print the admissible set, and held in
 * one place so the incremental door and a rebuild cannot come to disagree about
 * which histories are lawful.
 */
export const DISPATCH_STATE_TRANSITIONS: Readonly<Record<DispatchState, readonly DispatchState[]>> =
  Object.freeze({
    INTENDED: ["CLAIMED", "INFLIGHT", "SETTLED", "ABANDONED"],
    CLAIMED: ["INFLIGHT", "SETTLED", "ABANDONED"],
    INFLIGHT: ["SETTLED", "ABANDONED"],
    SETTLED: [],
    ABANDONED: [],
  });

/**
 * The kinds of business operation an effect may be — the minimal catalogue.
 *
 * One member, and it grows by escalón, exactly as `V2_IDEMPOTENCY_STREAMS`
 * admitted one stream in escalón A. Execution §6.1 requires `neutralRequest` to
 * be validated "por el schema exacto de effect_kind/request_contract_version",
 * and P-18/protocolo composes no adapter, so what this escalón can honestly
 * impose is the closed set and the pairing — not a payload schema for a
 * request nobody produces yet.
 *
 * **It lives here and not in `@acp/contracts`, and the choice is argued rather
 * than assumed** (ADR 0076). Decision 42 puts the *grammar of a key* in the
 * contract, and that is why the two preimage prefixes are there. A catalogue of
 * business operations is the other thing — the class decision 45 already ruled
 * on for `last_failure_code`: it grows with the adapters that serve it, so
 * binding it to an immutable migration, or to the package every other package
 * imports, would make each growth of the catalogue a migration of this
 * database. The door imposes it; the schema does not.
 */
export const EXECUTION_EFFECT_KINDS = ["model_execution"] as const;
export type ExecutionEffectKind = (typeof EXECUTION_EFFECT_KINDS)[number];

/**
 * The request contract version each effect kind admits, today.
 *
 * Execution §6 `:248`: "Versión exacta del schema de neutralRequest para
 * effect_kind; no se usa una versión implícita o desconocida". One pair, so the
 * pairing is checkable rather than merely declared — an effect naming a kind
 * with a version that kind does not define is refused at the door.
 */
export const EXECUTION_REQUEST_CONTRACT_VERSIONS: Readonly<
  Record<ExecutionEffectKind, readonly string[]>
> = Object.freeze({ model_execution: ["1"] });

/**
 * One segment of one attempt's route — execution §4 (P-18/protocolo C).
 *
 * Replaces `ExecutionRouteReadModel` going forward, which is keyed by the flat
 * `(taskId, attempt)` and is frozen for the legacy rows that carry it. Every
 * handoff opens a **new** segment with explicit lineage back to the one that
 * handed off, which is exactly what the old shape could not express: it had one
 * row per attempt, so a second account or a second model inside one attempt
 * overwrote the first.
 *
 * `predecessorSegmentId` and `handoffReason` are `null` together on the first
 * segment of an attempt and non-null together on every later one.
 * `modelVersionId` is `null` if and only if `modelResolutionStatus` is not
 * `RESOLVED`, **even after executing** — a version nobody could resolve is a
 * recorded fact, not an empty column somebody may fill in later.
 *
 * Four columns have no producer in this build and the nullity is declared
 * rather than accidental: `routingAssignmentId` and `reservationId` belong to
 * planning and accounts, and `escalatedFromAttempt`/`escalationReason` to the
 * escalation flow. None of them is invented from a digest or a neighbour.
 */
export interface ExecutionRouteSegmentReadModel {
  readonly routeSegmentId: string;
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly segmentNumber: number;
  readonly predecessorSegmentId: string | null;
  readonly handoffReason: string | null;
  readonly provider: string;
  /** The routing alias asked for, preserved even when resolution fails. */
  readonly model: string;
  readonly modelResolutionStatus: ModelResolutionStatus;
  readonly modelVersionId: string | null;
  readonly accountId: string | null;
  readonly transportKind: string;
  readonly capabilityPolicyVersion: string;
  readonly routingAssignmentId: string | null;
  readonly reservationId: string | null;
  readonly escalatedFromAttempt: number | null;
  readonly escalationReason: string | null;
  readonly resolvedAt: string | null;
  /** The recording event's own instant. Never a clock read in this package. */
  readonly recordedAt: string;
  readonly sequence: number;
}

/**
 * One logical effect of one run — execution §6 (P-18/protocolo C).
 *
 * **The row the whole escalón exists for.** A logical operation is recognised
 * by *what it is* — the run's invocation, a semantic scope and the step's own
 * key — before any physical coordinate is assigned to it. That is what
 * `logicalOperationSha256` indexes and what makes losing an acknowledgement
 * survivable: the retry after a handoff finds the effect that already exists
 * instead of minting a second one and sending twice.
 *
 * `effectId` and `idempotencyKey` are derived once, with the **initial**
 * segment, and conserved through every replay and every handoff. `routeSegmentId`
 * here is that initial segment and is immutable; a later delivery records its
 * own in `DispatchAttemptReadModel`.
 *
 * `requestSha256` is a consistency digest, not a second identity: it answers
 * "is this the same request under the same logical key", which is the CONFLICT
 * of §6.1 `:303-304`. Unlike the other three digests on this row it is
 * **recorded, not recomputed** — its preimage carries `neutralRequest`, and a
 * business payload does not enter a ledger event.
 *
 * `outcomeStatus` and `outcomeRecordedAt` are `null` together until a real
 * outcome is recorded. The pair is never half written, and `null` is not
 * `OUTCOME_UNKNOWN`.
 *
 * `outcomeContractVersion` is the contract version of the event that recorded
 * the outcome, `null` exactly when `outcomeStatus` is (P-07 escalón B, migration
 * 22). The result pair is `null`/`null` without a result — no outcome,
 * `CANCELLED`, `OUTCOME_UNKNOWN`, a `FAILED` that named none, or a `SUCCEEDED`
 * of the cohort before — and otherwise names the registered `RESPONSE` artifact
 * and its conserved digest.
 */
export interface EffectReadModel {
  readonly effectId: string;
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  /** The **initial** segment, fixed once and immutable (§6 `:242`). */
  readonly routeSegmentId: string;
  readonly operationOrdinal: number;
  readonly effectKind: string;
  readonly semanticScopeKey: string;
  readonly localOperationKey: string;
  readonly logicalOperationSha256: string;
  readonly requestContractVersion: string;
  readonly requestSha256: string;
  readonly idempotencyKey: string;
  readonly intendedAt: string;
  readonly outcomeStatus: EffectOutcomeStatus | null;
  readonly outcomeRecordedAt: string | null;
  readonly outcomeContractVersion: string | null;
  readonly resultArtifactReferenceId: string | null;
  readonly resultSha256: string | null;
  readonly sequence: number;
}

/**
 * One concrete external delivery of one logical effect — execution §7.
 *
 * Retransmitting does not create another effect; it creates another row here.
 * `attemptOrdinal` orders the deliveries of one `effectId` and is unique within
 * it.
 *
 * `routeSegmentId` is the **effective** segment of this delivery, fixed by its
 * intention before anything is sent. It may differ from the effect's initial
 * segment — that is what a handoff is — and never from the attempt the two
 * share.
 *
 * `providerIdempotencyKey`, `externalHandle` and `acceptedAt` are the three
 * fields whose population needs a composed adapter (P-15). They exist, their
 * nullity is documented, and no producer in this build fills them with an
 * external fact. `acceptedAt` in particular is not implied by `CLAIMED`:
 * claiming is local, acceptance is the provider's.
 *
 * `terminalAt` is non-null if and only if the state is `SETTLED` or
 * `ABANDONED`. An `ABANDONED` may happen before any real dispatch, in which
 * case `acceptedAt` stays `null`.
 */
export interface DispatchAttemptReadModel {
  readonly dispatchAttemptId: string;
  readonly effectId: string;
  /** The **effective** segment of this delivery (§7 `:343`). */
  readonly routeSegmentId: string;
  readonly attemptOrdinal: number;
  readonly providerIdempotencyKey: string | null;
  readonly externalHandle: string | null;
  readonly dispatchState: DispatchState;
  readonly requestedAt: string;
  readonly acceptedAt: string | null;
  readonly terminalAt: string | null;
  readonly recordedAt: string;
  readonly sequence: number;
}

/**
 * What a producer asks the logical lookup of execution §6.1, point 1.
 *
 * The coordinate names the attempt whose `invocationId` the logical digest is
 * computed over, so the caller never states that identity itself — it is read
 * off the ledger, which is what makes the lookup a question about this run
 * rather than about what a caller claimed the run was.
 *
 * The last three fields are not part of the key. They are what §6.1 `:303-304`
 * compares once a row is found, so that "the same work again" and "different
 * work under one key" come back as different answers.
 */
export interface EffectLookupQuery {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly semanticScopeKey: string;
  readonly localOperationKey: string;
  readonly effectKind: string;
  readonly requestContractVersion: string;
  readonly requestSha256: string;
}

/**
 * What the lookup answers when the logical key is already taken.
 *
 * The effect itself — with the `effectId` and `idempotencyKey` it was born
 * with, never a new pair — and whether it may be acted on as it stands.
 * `reconciliationRequired` is `true` for an `OUTCOME_UNKNOWN` and for an
 * intention with a delivery still outstanding; both are cases where something
 * may have reached a destination and nobody knows.
 */
export interface EffectLookup {
  readonly effect: EffectReadModel;
  readonly reconciliationRequired: boolean;
}

/**
 * What became of an answer's content before its digest was taken — execution
 * §8.2's `redaction_verdict` (P-18/protocolo D).
 *
 * Two words, and the vocabulary existed nowhere in this tree before this
 * escalón. It lives here beside `MODEL_RESOLUTION_STATUSES` and not in
 * `@acp/contracts`, on `EXECUTION_EFFECT_KINDS`' argument (decision 45, ADR
 * 0076): it is a word the ledger's door imposes on a column of its own read
 * model, not the grammar of a key, and exporting it from the package every
 * other package imports would move a pin for a fact only this package reads.
 * The migration carries the CHECK as well, because §8 lists it and the set is
 * closed by the dictionary rather than by a growing catalogue.
 */
export const REDACTION_VERDICTS = ["CLEAN", "REDACTED"] as const;
export type RedactionVerdict = (typeof REDACTION_VERDICTS)[number];

/**
 * One prompt sent on one delivery — execution §8.1 (P-18/protocolo D).
 *
 * **A use, never a blob.** The legacy shape §8 `:377` names,
 * `prompt_record_read_model`, was keyed by `prompt_sha256` and so mixed the
 * identity of some bytes with the fact of sending them; that table never
 * existed in this tree, and nothing is migrated from it. Here the same bytes
 * sent twice are two rows under two `occurrenceId`s with one digest between
 * them, which is why `promptSha256` is indexed and never unique.
 *
 * `dispatchAttemptId` names the delivery that produced the prompt and is **not**
 * unique: one delivery may send several. `effectId` and `routeSegmentId` repeat
 * that delivery's own, and the ledger refuses a row where they differ — the
 * segment is the delivery's **effective** one, never inferred from where the
 * effect began.
 *
 * `ordinal` orders prompts within that segment and is assigned by the ledger:
 * one past the segment's highest, `0` where there is none. `identity` is the
 * recording event's `emittedBy`, never a payload key.
 *
 * The model quartet is the prompt's own, carried by its event rather than
 * copied from the segment, on §4's contract: the alias and the provider are
 * preserved always, and `modelVersionId` is `null` if and only if the status is
 * not `RESOLVED`. A prompt may resolve a version the segment could not.
 *
 * The two digests are **conserved, never recomputed**: their preimages are the
 * bytes §8 `:433` keeps out of every row, so this ledger holds no source to
 * recompute them from. It checks their shape and nothing more, and says so.
 */
export interface PromptOccurrenceReadModel {
  readonly occurrenceId: string;
  readonly routeSegmentId: string;
  readonly effectId: string;
  readonly dispatchAttemptId: string;
  readonly ordinal: number;
  /** The worker that sent it: the recording event's `emittedBy`. */
  readonly identity: string;
  readonly requestedModelId: string;
  readonly provider: string;
  readonly modelResolutionStatus: ModelResolutionStatus;
  readonly modelVersionId: string | null;
  readonly accountId: string;
  readonly promptSha256: string;
  readonly promptBytes: number;
  readonly contextSha256: string | null;
  readonly recordedAt: string;
  readonly sequence: number;
}

/**
 * The one answer to one prompt occurrence — execution §8.2.
 *
 * **It carries no account and no segment, on purpose.** Its only link to where
 * the work ran is `promptOccurrenceId`, so an answer that arrives late — after
 * the delivery that asked was abandoned and another account took over on a new
 * segment — is attributed to the prompt that was actually sent, and through it
 * to the origin's account and segment. There is no column through which it
 * could be attributed to the destination, and the door refuses a payload that
 * tries to name one.
 *
 * `occurrenceId` is its own, distinct from the prompt's. One answer per prompt:
 * `ux_response_occurrence_read_model__prompt` is unique, and a second answer is
 * refused by name rather than by that index. `responseSha256` is conserved on
 * `PromptOccurrenceReadModel`'s terms.
 */
export interface ResponseOccurrenceReadModel {
  readonly occurrenceId: string;
  readonly promptOccurrenceId: string;
  readonly responseSha256: string;
  readonly responseBytes: number;
  readonly redactionVerdict: RedactionVerdict;
  readonly recordedAt: string;
  readonly sequence: number;
}

/**
 * One declared measurement stream — economy §1.1 (P-32/captura B, ADR 0089).
 *
 * `measurementStreamId` is the digest of the versioned preimage of the four
 * coordinate fields and is recomputed by the door, never believed. `sequence` is
 * the first event that declared the stream: a restatement of the same stream by a
 * later event writes nothing, and a restatement with another class or policy is
 * refused by name.
 *
 * The three vocabularies of these rows are spelled as literals here rather than
 * imported from the settlement module, because that module is reached only by
 * the door and the fold (L-P32B-1); the fold's own types are assigned to and read
 * from these, so a word that drifted would not compile.
 */
export interface UsageMeasurementStreamReadModel {
  readonly measurementStreamId: string;
  readonly source: string;
  readonly accountId: string;
  readonly routeSegmentId: string;
  readonly sourceEpoch: number;
  readonly sourceClass: "PROVIDER_AUTHORITATIVE" | "WRAPPER_MEASURED" | "ESTIMATE";
  readonly normalizationPolicySha256: string;
  readonly sequence: number;
}

/**
 * One usage observation — economy §1.2 (P-32/captura B).
 *
 * Every count is a safe integer here: a single report is held to the payload's
 * JSON numbers, and the four classes and their total each fit. What can exceed
 * `Number.MAX_SAFE_INTEGER` is a settlement's sum, which is why the settlement's
 * counts are `bigint`.
 */
export interface UsageObservationReadModel {
  readonly observationId: string;
  readonly measurementStreamId: string;
  readonly ordinal: number;
  readonly sourceObservationId: string;
  readonly reportKind: "DELTA" | "CUMULATIVE" | "CORRECTION";
  readonly rangeFromCounter: number | null;
  readonly rangeToCounter: number | null;
  readonly correctsObservationId: string | null;
  readonly effectId: string;
  readonly isFinal: 0 | 1;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly sequence: number;
}

/**
 * One settlement revision's header — economy §2.1 (P-32/captura B).
 *
 * The five counts are `bigint | null`, `null` iff the status is `UNKNOWN` or
 * `DISPUTED`, and are read back with `safeIntegers` so a sum past
 * `Number.MAX_SAFE_INTEGER` is exact. The revision in force is the highest; no
 * earlier revision is ever rewritten.
 */
export interface UsageSettlementReadModel {
  readonly effectId: string;
  readonly settlementRevision: number;
  readonly settlementStatus: "FINAL" | "PARTIAL" | "UNKNOWN" | "DISPUTED";
  readonly inputTokens: bigint | null;
  readonly outputTokens: bigint | null;
  readonly cacheWriteTokens: bigint | null;
  readonly cacheReadTokens: bigint | null;
  readonly totalTokens: bigint | null;
  readonly sourcePolicySha256: string;
  readonly foldVersion: number;
  readonly lastObservationId: string | null;
  readonly hadLateArrival: 0 | 1;
  readonly computedAt: string;
  readonly sequence: number;
}

/** One head of a settlement revision's cut — economy §2.2. Only the control row in this build (Q4). */
export interface UsageSettlementSourceHeadReadModel {
  readonly effectId: string;
  readonly settlementRevision: number;
  readonly sourceStream: "control_plane_events" | "registry_events";
  readonly sourceSequence: number;
  readonly sourceSha256: string;
}

/** One observation a settlement revision considered — economy §2.3. */
export interface UsageSettlementObservationReadModel {
  readonly effectId: string;
  readonly settlementRevision: number;
  readonly observationId: string;
}

/** One settlement revision whole: its header, its cut and its list, written in the trigger's transaction. */
export interface UsageSettlementRecord {
  readonly header: UsageSettlementReadModel;
  readonly sourceHeads: readonly UsageSettlementSourceHeadReadModel[];
  readonly observations: readonly UsageSettlementObservationReadModel[];
}

/**
 * What one event does to the five usage tables (P-32/captura B).
 *
 * `null` in a field means that table is not written: a restated stream or
 * observation writes nothing, a declaration writes no settlement, and a delivery
 * of an effect that already has a revision writes none either.
 */
export interface UsageCaptureWrites {
  readonly stream: UsageMeasurementStreamReadModel | null;
  readonly observation: UsageObservationReadModel | null;
  readonly settlement: UsageSettlementRecord | null;
}

/**
 * What the usage fold reads, whether it runs over the base or over a snapshot.
 *
 * `ArtifactFoldView`'s allocation: the door and the migration answer these from
 * the tables inside their transaction, the rebuild answers them from the
 * snapshot it is filling, and one decision function serves all three.
 */
export interface UsageCaptureView {
  stream(measurementStreamId: string): UsageMeasurementStreamReadModel | null;
  observation(observationId: string): UsageObservationReadModel | null;
  /** The observation that holds this ordinal of this stream, or null. */
  observationAtOrdinal(measurementStreamId: string, ordinal: number): string | null;
  /** The observation that holds this source report id of this stream, or null. */
  observationForSourceReport(measurementStreamId: string, sourceObservationId: string): string | null;
  /** Every observation recorded for one effect. */
  effectObservations(effectId: string): readonly UsageObservationReadModel[];
  /** The attempt that owns a route segment, or null when no segment has that id. */
  segmentOwner(routeSegmentId: string): {
    readonly taskId: string;
    readonly revisionNumber: number;
    readonly attemptNumber: number;
  } | null;
  /** The attempt that owns an effect, or null when no effect has that id. */
  effectOwner(effectId: string): {
    readonly taskId: string;
    readonly revisionNumber: number;
    readonly attemptNumber: number;
  } | null;
  /** The effect's revision in force, or null when it has none. */
  latestSettlement(effectId: string): {
    readonly settlementRevision: number;
    readonly status: UsageSettlementReadModel["settlementStatus"];
    readonly sequence: number;
  } | null;
  /** The trigger sequence of the effect's latest FINAL revision, or null. */
  lastFinalSequence(effectId: string): number | null;
}

/** A word of `OUTBOX_FAILURE_CODES`, the vocabulary the door imposes when it writes. */
export type OutboxFailureCode = (typeof OUTBOX_FAILURE_CODES)[number];

/**
 * One outbox command, as the ledger's own events fold it — coordination §6 and
 * §6.2 (P-18/protocolo F).
 *
 * **Not a table, and not a row of `outbox.sqlite`.** Datos §11 `:548-550` puts
 * the command's intention in the ledger's transaction and makes the separate
 * outbox a cache of it. This value is what that cache is rebuilt *from*: every
 * field `outbox_message` needs to reconstruct a row, taken off three event types
 * and nothing else — no migration, no derived table, no watermark.
 *
 * Identity comes from the intention and never moves: `commandId` is the digest of
 * `(sagaId, phase, targetKind, targetId)` under the contract's prefix, the
 * target's `fence` and `targetStoreIncarnationId` are conserved from it and never
 * substituted by a current incarnation (§6 `:240`), and the anchor is the
 * intention event's own stream, sequence and digest.
 *
 * `state` is §2's vocabulary with the fold's reading of §6.2 `:323-324`:
 *
 *  - an intention with no delivery attempt is `PENDING`;
 *  - a recorded attempt with no observation is `RECONCILING` — **never
 *    `PENDING`, and never `INFLIGHT`**: the ledger records the attempt before
 *    anything is sent, cannot know whether the send happened, and the process
 *    that owned an `INFLIGHT` row does not survive a lost cache;
 *  - an observation moves the state by §2's transitions.
 *
 * `attemptCount` grows by one per new `deliveryAttemptId` and not on a replay.
 * `lastFailureCode` keeps the last code any observation carried, so a command
 * that failed and returned to `PENDING` still says why; `responseHandle` keeps
 * the last opaque handle on the same terms.
 */
export interface OutboxCommandReadModel {
  readonly commandId: string;
  readonly sagaId: string;
  readonly phase: string;
  readonly commandKind: OutboxCommandKind;
  readonly targetKind: string;
  readonly targetId: string;
  readonly deadlineAt: string;
  readonly fence: number | null;
  readonly targetStoreIncarnationId: string | null;
  /** The real task that owns the saga — the subject every later event must repeat. */
  readonly taskId: string;
  readonly intentStream: OutboxStream;
  readonly intentSequence: number;
  readonly intentSha256: string;
  readonly state: OutboxState;
  readonly attemptCount: number;
  readonly lastDeliveryAttemptId: string | null;
  readonly lastAttemptStream: OutboxStream | null;
  readonly lastAttemptSequence: number | null;
  readonly lastAttemptSha256: string | null;
  readonly lastFailureCode: OutboxFailureCode | null;
  readonly responseHandle: string | null;
  /** The intention event's own instant. */
  readonly createdAt: string;
  /** The instant of the last event that moved this command. Never a clock. */
  readonly updatedAt: string;
}

export interface TaskQuery {
  readonly state?: TaskState | undefined;
  /** Exclusive taskId cursor. Tasks are ordered by taskId ascending. */
  readonly afterTaskId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface TaskPage {
  readonly tasks: readonly TaskReadModel[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Derived per-worker projection, built from observed emittedBy identities.
 *
 * This is an observation, not a registry. A worker exists here because it
 * emitted an event, so the projection can never claim a worker the ledger has
 * no evidence for. WorkerSlot registration is a later phase.
 */
export interface WorkerReadModel {
  readonly identity: string;
  readonly provider: string;
  readonly model: string;
  readonly role: WorkerRole;
  readonly instance: string;
  readonly eventCount: number;
  /** Distinct tasks this identity has emitted at least one event for. */
  readonly taskCount: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastTaskId: string;
  readonly lastEventType: ControlPlaneEventType;
}

export interface WorkerQuery {
  readonly role?: WorkerRole | undefined;
  readonly provider?: string | undefined;
  /** Exclusive identity cursor. Workers are ordered by identity ascending. */
  readonly afterIdentity?: string | undefined;
  readonly limit?: number | undefined;
}

export interface WorkerPage {
  readonly workers: readonly WorkerReadModel[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Derived per-attempt execution route (V2-B1c).
 *
 * The route the run was admitted on, as the `RUN_STARTED` event recorded it:
 * provider, model, account, transport and the capability-policy version that
 * chose them. Holds no fact that is not in the ledger — every field is read
 * off the event that carried it, and `recordedAt` is that event's own instant
 * rather than a clock read here.
 *
 * Keyed by `(taskId, attempt)` and never by `taskId` alone. A retry may resolve
 * a different account after a quota exhaustion, or a different model after the
 * policy is re-cut, and `task_read_model.latestAttempt` moves forward when it
 * does. A per-task row would overwrite the earlier attempt's route and destroy
 * exactly the after-the-fact explainability `capabilityPolicyVersion` exists to
 * provide: which policy chose which account for the work that actually ran.
 */
export interface ExecutionRouteReadModel {
  readonly taskId: string;
  readonly attempt: number;
  readonly provider: string;
  /** The routing alias the run was scheduled against, not a provider's resolution. */
  readonly model: string;
  readonly accountId: string;
  readonly transportKind: TransportKind;
  /** The immutable generation of the capability registry that chose the route. */
  readonly capabilityPolicyVersion: string;
  readonly resolvedAt: string;
  /** The recording event's own instant. Never a clock read in this package. */
  readonly recordedAt: string;
  /** The task-stream position the route was recorded at. */
  readonly sequence: number;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
  readonly appliedAt: string;
}

/** Effective pragmas, read back from the connection rather than assumed. */
export interface LedgerPragmaStatus {
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly synchronous: number;
  readonly busyTimeoutMs: number;
  readonly queryOnly: boolean;
}

/**
 * One fixed head of one stream, for one projection (P-09/log-D).
 *
 * `sourceStream` is database content, so it is typed as a string here rather
 * than as a union: the closed set is enforced at the wire boundary, by a schema
 * whose whole job is to be the one place a foreign value is refused. A union
 * here would make a tampered row a type error the ledger cannot express and
 * would say nothing at the boundary that matters.
 */
export interface ProjectionWatermarkStatus {
  readonly sourceStream: string;
  /** The head of this stream that this projection was built through. */
  readonly appliedThroughSequence: number;
  readonly eventCount: number;
  /**
   * Chain head the projection was built from, **at** `appliedThroughSequence`
   * and not at whatever that stream has since reached. Detects a foreign
   * history.
   */
  readonly sourceHeadSha256: string;
}

/**
 * One projection, with the vector of heads it was built from.
 *
 * Exactly the keys of `ProjectionStatusDto`, and that is a constraint rather
 * than a coincidence: the gateway forwards this array raw into a strict schema,
 * so a key added here "because the watermark row has it" — `projector_version`
 * is the tempting one — is a runtime parse failure at the boundary, not a
 * harmless extra.
 */
export interface ProjectionStatus {
  readonly name: string;
  readonly rowCount: number;
  /**
   * When this projection's projector last ran. For a projection fed by more
   * than one stream this is the latest of its rows: the question "when did
   * this projection last move" has one answer, and it is the most recent one.
   */
  readonly updatedAt: string;
  /** One entry per stream that feeds this projection, ordered by stream. */
  readonly watermarks: readonly ProjectionWatermarkStatus[];
}

/**
 * Which ledger file this is, and which restore of it (P-10/id-A).
 *
 * Deliberately **not** the same question as "which path is this". The path
 * digest a server computes identifies a LOCATION: it is stable when the file
 * behind it is replaced, and it changes when the same file is moved. These
 * three answer the other half — identity of the file itself, and of the restore
 * that produced its current contents.
 *
 * - `instanceId` is written once, on the first writable open by a build that
 *   knows about it, and is never rewritten. It is stable for the life of the
 *   file.
 * - `restoreId` is rewritten by every formal restore, with a fresh random
 *   value. It is **not** derived from `restoreEpoch`: a counter collides when
 *   the same backup is restored twice, which is the whole defect this exists to
 *   close.
 * - `restoreEpoch` is a monotone integer, informative only — a human-readable
 *   ordering of restores. It participates in no uniqueness claim whatsoever.
 *
 * All three are `null` together, and only together, on a ledger that predates
 * this build and has not yet been opened writably. A partial set is corruption,
 * not a state.
 */
export interface LedgerIdentity {
  readonly instanceId: string | null;
  readonly restoreId: string | null;
  readonly restoreEpoch: number | null;
}

export interface LedgerStatus {
  readonly path: string;
  readonly readOnly: boolean;
  /** Which file, and which restore of it. See LedgerIdentity. */
  readonly instance: LedgerIdentity;
  readonly pragmas: LedgerPragmaStatus;
  readonly migrations: readonly AppliedMigration[];
  readonly headSequence: number;
  readonly headEventSha256: string;
  readonly eventCount: number;
  /** The initiative stream's own head. Never mixed with the task stream's. */
  readonly initiativeHeadSequence: number;
  readonly initiativeHeadEventSha256: string;
  readonly initiativeEventCount: number;
  readonly projections: readonly ProjectionStatus[];
}

/**
 * The integrity vocabulary, owned by the wire contract (G7 D4).
 *
 * This union used to be written out here and kept manually in step with
 * `INTEGRITY_PROBLEM_KINDS` in `@acp/protocol` — two lists, one meaning, and
 * nothing that would notice them disagreeing. The protocol owns it because the
 * vocabulary is what the integrity route serializes; the name is re-exported so
 * this package's own surface does not move.
 */
export type { IntegrityProblemKind } from "@acp/protocol";
import type { IntegrityProblemKind } from "@acp/protocol";

/**
 * The coverage vocabulary, owned by the wire contract for the same reason
 * (P-08/B).
 *
 * `CoverageKind` says how a stream came to be covered; `WatermarkSourceStream`
 * says which stream. Both are closed enumerations that the integrity route
 * serializes verbatim, so the protocol owns them and this package imports
 * rather than restates — the precedent directly above, set at G7 D4. Typing
 * `sourceStream` against the wire union is deliberate and is the one place this
 * package does so: everywhere else `sourceStream` is a column read back from
 * the database and is honestly a `string`, but here it is a name this code
 * chooses from a fixed set, and a mismatch should be a compile error rather
 * than a parse failure at the door.
 */
export type { CoverageKind } from "@acp/protocol";
import type { CoverageKind, WatermarkSourceStream } from "@acp/protocol";

/**
 * One stream's integrity coverage — §8.2, as `verifyIntegrity()` reports it.
 *
 * This says **from when** a stream's chain is evidence, and it is a different
 * claim from `problems`, which says whether the evidence holds. Neither asserts
 * authenticity of anything recorded before coverage began: a baselined stream
 * proves that rows 1..H are unchanged *since activation*, and says nothing
 * whatsoever about what happened to them before it.
 *
 * `checkedThroughSequence` is the head of the cut that was examined, so an
 * empty stream reports `coveredSinceSequence: 1` with `checkedThroughSequence:
 * 0` — covered from the first row it will ever hold, holding none yet.
 *
 * The three baseline fields travel together and are read from `ledger_meta`,
 * never recomputed: they are the activation's own record of where retroactive
 * coverage was taken, and a verifier that recomputed them would be asserting
 * the very thing it is supposed to be checking.
 */
export interface StreamIntegrityCoverage {
  readonly sourceStream: WatermarkSourceStream;
  readonly coverageKind: CoverageKind;
  readonly coveredSinceSequence: number | null;
  readonly checkedThroughSequence: number;
  readonly integrityActivatedAt: string | null;
  readonly baselineSequence: number | null;
  readonly baselineSha256: string | null;
}

export interface IntegrityProblem {
  readonly kind: IntegrityProblemKind;
  /** Safe to log. Never contains event content, only coordinates and digests. */
  readonly detail: string;
  readonly sequence: number | null;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly checkedEvents: number;
  readonly headSequence: number;
  readonly headEventSha256: string;
  readonly problems: readonly IntegrityProblem[];
  /**
   * One entry per stream, ordered by name — exactly four, never a subset.
   *
   * Deliberately beside `problems` rather than folded into it. A finding is
   * something wrong; coverage is true of a sound ledger as much as a broken
   * one, and an operator asking "how far back does this prove anything?"
   * deserves an answer that does not depend on something having gone wrong.
   */
  readonly coverage: readonly StreamIntegrityCoverage[];
}

export interface RebuildResult {
  readonly replayedEvents: number;
  readonly throughSequence: number;
  readonly taskRows: number;
  readonly workerRows: number;
  /** Rows in the per-attempt execution-route projection after the replay. */
  readonly executionRouteRows: number;
  /** The sibling stream is rebuilt in the same transaction, and counted here. */
  readonly replayedInitiativeEvents: number;
  readonly initiativeThroughSequence: number;
  readonly initiativeRows: number;
  readonly roadmapVersionRows: number;
  /** The third stream, replayed in the same transaction as the other two. */
  readonly replayedRegistryEvents: number;
  readonly registryThroughSequence: number;
  /**
   * Rows in the two-source routing projection, across BOTH partitions.
   *
   * One count and not two, because it is one table: the vector of watermarks
   * is where the two sources stay distinguishable, and a per-source row count
   * would invite a caller to compare numbers from streams whose sequences are
   * not comparable.
   */
  readonly routingAssignmentRows: number;
  readonly routingFallbackRows: number;
  /** The four artifact read models after the replay, from the registry stream alone. */
  readonly artifactBlobRows: number;
  readonly artifactReferenceRows: number;
  readonly artifactPinRows: number;
  readonly artifactTombstoneRows: number;
  /** The model version registry and its two child tables, from the registry stream alone (P-14 A). */
  readonly modelVersionRows: number;
  readonly modelVersionEligibleRoleRows: number;
  readonly modelVersionTransportRows: number;
  /** The price interval catalog, from the registry stream alone (P-33/catálogo A). */
  readonly priceIntervalRows: number;
}

// ---------------------------------------------------------------------------
// The initiative stream
// ---------------------------------------------------------------------------

/** One durable initiative-stream row, with the event and its chain position. */
export interface InitiativeEventRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly event: InitiativeEvent;
  /** The exact bytes the chain digest was computed over. */
  readonly canonicalJson: string;
  readonly previousSha256: string;
  readonly eventSha256: string;
  /** The event this one was recorded as caused by, or null. See CausationRef. */
  readonly causation: CausationRef | null;
}

export interface InitiativeAppendResult {
  /** false means this was an exact replay and nothing new was written. */
  readonly inserted: boolean;
  readonly record: InitiativeEventRecord;
}

export interface InitiativeEventQuery {
  /** Exclusive sequence cursor. Pass the previous page nextCursor. */
  readonly afterSequence?: number | undefined;
  readonly initiativeId?: string | undefined;
  readonly type?: InitiativeEventType | undefined;
  readonly limit?: number | undefined;
}

export interface InitiativeEventPage {
  readonly events: readonly InitiativeEventRecord[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
}

/** Derived per-initiative projection. Holds no fact not in the stream. */
export interface InitiativeReadModel {
  readonly initiativeId: string;
  readonly currentStatus: InitiativeStatus;
  readonly eventCount: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly lastEventId: string;
  readonly lastEventType: InitiativeEventType;
  readonly lastTransitionId: string;
  readonly lastEmittedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * The title the registration recorded (planning §1, P-14 B). Null for an
   * initiative whose registration predates the closed payload, or carries
   * another shape: the fold reads the closed payload and nothing else.
   */
  readonly title: string | null;
  /** The digest of the objective the registration published, never the objective. */
  readonly objectiveSha256: string | null;
  /** Always null in this build: planning §1 gives it no semantics and nothing produces it. */
  readonly repositorySha256: string | null;
}

/**
 * The payload of an `INITIATIVE_REGISTERED` the registration door records, by
 * name (P-14 B, ADR 0086).
 *
 * Closed, and held by the one module that builds the event rather than by the
 * append door: the contract's payload is a bounded record, and history the
 * stream already accepted under another shape stays readable. The objective is
 * not among these keys and never will be — its bytes go to the private plane,
 * and the stream records the digest and the reference that names them.
 */
export const INITIATIVE_REGISTRATION_PAYLOAD_KEYS = [
  "slug",
  "title",
  "objectiveSha256",
  "objectiveArtifactReferenceId",
] as const;

/**
 * Derived per-roadmap-version projection.
 *
 * This is the fold the roadmap-version decision consumes as its head: the
 * caller reads it and hands it in, so the decision module never reads a
 * ledger of its own.
 */
export interface RoadmapVersionReadModel {
  readonly roadmapVersionId: string;
  readonly initiativeId: string;
  readonly version: number;
  readonly contentDigest: string;
  readonly parentVersionId: string | null;
  readonly kind: RoadmapVersionKind;
  readonly restoresVersionId: string | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** The initiative-stream position the version was recorded at. */
  readonly sequence: number;
}

// ---------------------------------------------------------------------------
// The registry stream (P-09/log-C)
//
// **Provisional, and declared so.** The contract package owns no
// `RegistryDocument` schema — the fourteen names below appear nowhere in
// `packages/**` today — and its schema barrel is a pure re-export whose
// exported set the fence pins, so a definition cannot land in it. Adding one
// properly is a new folder in that package, a line in the barrel, a fence pin
// and a contract test: four paths in a package this packet does not write.
//
// So the vocabulary lives here, beside the migration whose CHECK is the second
// independent declaration of the same fact, and the candidate is validated by
// hand because this package may not import `zod`. Nothing outside this package
// imports either name in this packet. When a contracts packet takes ownership,
// these move and this comment goes with them.
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of configuration documents the registry stream holds.
 *
 * Fourteen names, matching `ck_registry_events__document_kind` exactly. The
 * two declarations are deliberately independent — one in TypeScript, one in
 * SQL — so a test can hold them against each other and a name added to one
 * alone shows up as a disagreement rather than as a runtime abort.
 */
export const DOCUMENT_KINDS = [
  "CAPABILITY_POLICY",
  "MODEL_VERSION",
  "PRICE_TABLE",
  "MODEL_PERFORMANCE",
  "ROUTING_ASSIGNMENT_GLOBAL",
  "ESTIMATION_POLICY",
  "INTEGRATION_PROFILE",
  "INTEGRATION_INSTALLATION",
  "COMPOSITION_POLICY",
  "COMPOSITION_EVIDENCE",
  "NOTIFICATION_POLICY",
  "APPROVAL_WAIT_POLICY",
  "DUEL_POLICY",
  "ANOMALY_POLICY",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * One version of one configuration document, as the registry door records it.
 *
 * The registry is storage. It persists a version with a digest, an author and
 * an instant from which it rules; it decides no eligibility, scores no model
 * and sets no price. The semantics of each `documentKind` belong to the module
 * that owns it, and `payload` is the versioned extension namespace those
 * modules read — bounded, canonical, and never a prompt, a response, a tool
 * argument or a credential.
 */
export interface RegistryDocument {
  readonly contractVersion: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly documentKind: DocumentKind;
  /** Stable identity of the document across its versions. */
  readonly documentId: string;
  /** One or greater. Unique within `documentId`. */
  readonly documentVersion: number;
  /**
   * The version this one supersedes, sharing `documentId`. Null on a first
   * version, and null is the only way to be a first version.
   */
  readonly parentDocumentVersion: number | null;
  /** Digest of the content artifact, 64 lowercase hex characters. */
  readonly contentDigest: string;
  readonly recordedBy: string;
  /** The instant from which this version rules. ISO-8601 ms UTC. */
  readonly effectiveFrom: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly payload: Record<string, unknown>;
}

/** One durable registry-stream row, with the document and its chain position. */
export interface RegistryEventRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly document: RegistryDocument;
  /** The exact bytes the chain digest was computed over. */
  readonly canonicalJson: string;
  readonly previousSha256: string;
  readonly eventSha256: string;
  /** The event this one was recorded as caused by, or null. See CausationRef. */
  readonly causation: CausationRef | null;
}

export interface RegistryAppendResult {
  /** false means this was an exact replay and nothing new was written. */
  readonly inserted: boolean;
  readonly record: RegistryEventRecord;
}

/**
 * One resolved routing assignment, in the projection fed by two streams.
 *
 * `sourceStream` and `sourceSequence` are a pair on purpose: a sequence alone
 * is meaningless across streams, so the row carries the stream it came from
 * beside the position it came from. `sequence` is the projection's own
 * application order and is comparable with neither.
 */
export interface RoutingAssignmentReadModel {
  readonly assignmentId: string;
  readonly scopeKind: "GLOBAL" | "INITIATIVE" | "STEP";
  /** Null if and only if `scopeKind` is `GLOBAL`. */
  readonly scopeId: string | null;
  readonly version: number;
  readonly role: WorkerRole;
  readonly slot: number;
  readonly provider: string;
  /** The exact model version id the document named. Never an alias. */
  readonly modelVersionId: string;
  readonly recordedBy: string;
  /** The recording event's own instant. Never a clock read in this package. */
  readonly recordedAt: string;
  /** The assignment that superseded this one, or null while it rules. */
  readonly supersededBy: string | null;
  readonly sourceStream: "registry_events" | "initiative_events";
  readonly sourceSequence: number;
  readonly sequence: number;
}

/** One fallback of one assignment, in attempt order. */
export interface RoutingAssignmentFallbackRow {
  readonly assignmentId: string;
  readonly ordinal: number;
  readonly modelVersionId: string;
}

/**
 * One document's worth of routing projection: the row, its fallbacks, its parent.
 *
 * What a fold hands its two callers — the incremental path inside the registry
 * door, and the replay inside a rebuild — so both write the same three things
 * and cannot come to disagree about what folding an assignment means.
 */
export interface RoutingAssignmentProjection {
  readonly assignment: RoutingAssignmentReadModel;
  readonly fallbacks: readonly RoutingAssignmentFallbackRow[];
  /** The assignment id this version supersedes, or null on a first version. */
  readonly supersedes: string | null;
}

/**
 * The routing partition of an in-memory snapshot.
 *
 * Named for the registry stream because that is the only source that fills it
 * today, but the shape is the partition rather than the stream: the initiative
 * snapshot carries the same two maps for its own partition, and the function
 * that writes into either one takes this type so the two sources fold through
 * one implementation.
 */
export interface RegistryProjectionSnapshot {
  readonly routingAssignments: Map<string, RoutingAssignmentReadModel>;
  readonly routingFallbacks: Map<string, RoutingAssignmentFallbackRow>;
}

// ---------------------------------------------------------------------------
// The model version registry (P-14 escalón A, ADR 0085)
//
// Accounts §6: the one registry of model versions, folded from the registry
// stream's `MODEL_VERSION` documents. The payload those documents carry is fixed
// by name — the camelCase mirror of the dictionary's columns — and the append
// door holds it to that shape before it writes. `latest_performance_window` is
// a column with no producer here: the number it points at is economy's.
// ---------------------------------------------------------------------------

/** The three lifecycle words of a model version (`ck_model_version_read_model__status`). */
export const MODEL_VERSION_STATUSES = ["ACTIVE", "DEPRECATED", "RETIRED"] as const;

export type ModelVersionStatus = (typeof MODEL_VERSION_STATUSES)[number];

/**
 * The payload of one `MODEL_VERSION` document, by name.
 *
 * Closed: a key outside these nine is refused at the door, so a rating or a
 * price cannot be parked in the capability registry under a name nobody reads.
 */
export const MODEL_VERSION_PAYLOAD_KEYS = [
  "provider",
  "model",
  "release",
  "status",
  "contextTokens",
  "policyVersion",
  "deprecatedAt",
  "eligibleRoles",
  "transports",
] as const;

/** One row of `model_version_read_model`: the version of a document the fold applied last. */
export interface ModelVersionReadModel {
  /** The document id. Exact, never an alias. */
  readonly modelVersionId: string;
  readonly provider: string;
  /** The family alias; not an identity. */
  readonly model: string;
  readonly release: string;
  readonly status: ModelVersionStatus;
  readonly contextTokens: number;
  /** Always null in this build: the snapshot it references is economy's, and nothing produces it. */
  readonly latestPerformanceWindow: string | null;
  readonly policyVersion: string;
  /** Null if and only if `status` is `ACTIVE`. */
  readonly deprecatedAt: string | null;
  readonly documentVersion: number;
  readonly sequence: number;
}

/** One eligible role of one model version, in declared order. */
export interface ModelVersionEligibleRoleRow {
  readonly modelVersionId: string;
  readonly ordinal: number;
  readonly role: WorkerRole;
}

/** One admitted transport of one model version, in declared order. */
export interface ModelVersionTransportRow {
  readonly modelVersionId: string;
  readonly ordinal: number;
  readonly transportKind: string;
}

/**
 * One document's worth of model version projection.
 *
 * `row` is null when the version the fold is applying cannot be read. The
 * document's earlier row is then removed rather than left standing: a version
 * the registry holds and nobody can read is not a version that rules, and an
 * ACTIVE row surviving a later version would be exactly that. The door refuses
 * such a payload, so only a history written before the door checked can reach
 * this branch.
 */
export interface ModelVersionProjection {
  readonly modelVersionId: string;
  readonly row: ModelVersionReadModel | null;
  readonly eligibleRoles: readonly ModelVersionEligibleRoleRow[];
  readonly transports: readonly ModelVersionTransportRow[];
}

/** The model version partition of an in-memory snapshot of the registry stream. */
export interface ModelVersionProjectionSnapshot {
  readonly modelVersions: Map<string, ModelVersionReadModel>;
  /** Keyed by `modelVersionId`, each list in ordinal order. */
  readonly eligibleRoles: Map<string, readonly ModelVersionEligibleRoleRow[]>;
  readonly transports: Map<string, readonly ModelVersionTransportRow[]>;
}

/** A model version with its two child lists, as a read verb returns it. */
export interface ModelVersionEntry {
  readonly row: ModelVersionReadModel;
  readonly eligibleRoles: readonly WorkerRole[];
  readonly transports: readonly string[];
}

// ---------------------------------------------------------------------------
// The price interval catalog (P-33/catálogo escalón A, ADR 0091)
//
// Economy §3: one row per interval of one `PRICE_TABLE` document's version,
// keyed by the document AND the version, so a lookup never crosses versions. The
// payload is fixed by name — one closed list of intervals, each the camelCase
// mirror of the dictionary's price columns — and the append door holds it to
// that shape, and to the model versions the registry already holds, before it
// writes. The ledger stores the catalog; resolving a price is escalón B's.
// ---------------------------------------------------------------------------

/** The four token classes a price is quoted for (`ck_price_interval_read_model__token_class`). */
export const PRICE_TOKEN_CLASSES = ["input", "output", "cache_write", "cache_read"] as const;

export type PriceTokenClass = (typeof PRICE_TOKEN_CLASSES)[number];

/**
 * The payload of one `PRICE_TABLE` document, by name: one list, and nothing else.
 *
 * Closed, for `MODEL_VERSION_PAYLOAD_KEYS`' reason: a key outside it is refused
 * at the door, so nothing is parked in a catalog under a name nobody reads.
 */
export const PRICE_TABLE_PAYLOAD_KEYS = ["intervals"] as const;

/**
 * One interval of a `PRICE_TABLE` payload, by name.
 *
 * The camelCase mirror of economy §3's columns a catalog states. Every key is
 * required — `effectiveTo` too, as null or as an instant — and no other is
 * admitted. `catalogDocumentId` and `catalogVersion` are the document's own
 * coordinate, and `recordedBy` and `sequence` the event's: none of the four is
 * written in the payload.
 */
export const PRICE_INTERVAL_KEYS = [
  "provider",
  "modelVersionId",
  "transportKind",
  "tokenClass",
  "currency",
  "effectiveFrom",
  "effectiveTo",
  "pricePerMillionNanos",
] as const;

/** One row of `price_interval_read_model`. */
export interface PriceIntervalReadModel {
  /** The `PRICE_TABLE` document id. */
  readonly catalogDocumentId: string;
  /** The document version this interval was published in. */
  readonly catalogVersion: number;
  readonly provider: string;
  /** Exact, never an alias; registered when the version was admitted. */
  readonly modelVersionId: string;
  readonly transportKind: string;
  readonly tokenClass: PriceTokenClass;
  /** Three upper-case letters. Part of the identity: no conversion happens here. */
  readonly currency: string;
  /** Inclusive. ISO-8601 instant in UTC with milliseconds. */
  readonly effectiveFrom: string;
  /** Exclusive, or null for no declared end. */
  readonly effectiveTo: string | null;
  /** Nanounits of `currency` per million tokens. An integer, never a float. */
  readonly pricePerMillionNanos: number;
  readonly recordedBy: string;
  readonly sequence: number;
}

/**
 * One `PRICE_TABLE` version's worth of price projection.
 *
 * Whole or empty: `rows` is every interval of the version, or none of them when
 * the version cannot be read. Never a part — economy §3 publishes a catalog
 * version with all its rows or with none, and a fold that kept the readable half
 * of an unreadable version would publish exactly the part the door refuses.
 */
export interface PriceIntervalProjection {
  readonly catalogDocumentId: string;
  readonly catalogVersion: number;
  readonly rows: readonly PriceIntervalReadModel[];
}

/** The price partition of an in-memory snapshot of the registry stream, keyed by the primary key. */
export interface PriceIntervalProjectionSnapshot {
  readonly intervals: Map<string, PriceIntervalReadModel>;
}

/** The exact catalog version `readPriceIntervals` reads: a document and one of its versions. */
export interface PriceIntervalQuery {
  readonly catalogDocumentId: string;
  readonly catalogVersion: number;
}

/**
 * The reasons a `PRICE_TABLE` is refused at the door beyond its field shapes
 * (ADR 0091).
 *
 * Words carried at the head of each issue's message, for
 * `GLOBAL_ASSIGNMENT_REFUSALS`' reason. Two span rows of one version — the same
 * primary key twice, and two intervals of one quintuple that meet — and two read
 * the registry: a model version nobody registered, and one registered under
 * another provider.
 */
export const PRICE_TABLE_REFUSALS = [
  "PRICE_INTERVAL_DUPLICATE",
  "PRICE_INTERVAL_OVERLAP",
  "MODEL_VERSION_UNKNOWN",
  "MODEL_VERSION_PROVIDER_MISMATCH",
] as const;

export type PriceTableRefusal = (typeof PRICE_TABLE_REFUSALS)[number];

/** What the price gate needs to know about one registered model version, and nothing else. */
export interface PriceTableModelVersion {
  readonly provider: string;
}

/**
 * One row of `price_interval_read_model`, as the base spells its columns.
 *
 * The store's row type, beside the read model it is mapped to: `token_class` is
 * read back as text and narrowed on the way out, because the column's vocabulary
 * is a CHECK and not a type.
 */
export interface PriceIntervalRow {
  readonly catalog_document_id: string;
  readonly catalog_version: number;
  readonly provider: string;
  readonly model_version_id: string;
  readonly transport_kind: string;
  readonly token_class: string;
  readonly currency: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly price_per_million_nanos: number;
  readonly recorded_by: string;
  readonly sequence: number;
}

/**
 * One watermark row a read was taken against, named by its pair.
 *
 * `ProjectionWatermarkStatus` without the projection name is a vector entry
 * inside one projection; a reading spans two projections, so the name travels.
 */
export interface RegistryWatermarkReading {
  readonly projectionName: string;
  readonly sourceStream: string;
  readonly appliedThroughSequence: number;
  readonly eventCount: number;
  readonly sourceHeadSha256: string;
}

/** `getModelVersion`: the entry or null, and the one watermark it was read at. */
export interface ModelVersionReading {
  readonly modelVersion: ModelVersionEntry | null;
  readonly watermarks: readonly RegistryWatermarkReading[];
}

/**
 * `getGlobalRoutingAssignment`: the GLOBAL assignment in force for one
 * `(role, slot)`, the model version it names, and the vector it was read at.
 *
 * Everything here was read inside one read transaction, so the three watermark
 * rows describe exactly the tables the rest came from (E4, N-P14-3). `assignment`
 * is null when no assignment is in force; the vector is returned all the same,
 * because "nothing was assigned at this vector" is itself the fact a refusal
 * records.
 */
export interface GlobalRoutingAssignmentReading {
  readonly assignment: RoutingAssignmentReadModel | null;
  /** The assignment's fallbacks in attempt order; empty when there is no assignment. */
  readonly fallbacks: readonly string[];
  /** The model version the assignment names, or null when there is none or it is not registered. */
  readonly modelVersion: ModelVersionEntry | null;
  readonly watermarks: readonly RegistryWatermarkReading[];
}

// ---------------------------------------------------------------------------
// The artifact plane of the registry stream (P-36/local escalón A)
//
// The events live in `registry_events` with `subject_kind = 'ARTIFACT'`, their
// shape is `@acp/contracts`' `ArtifactRegistryEvent`, and the four read models
// below are folded from them. No filesystem is read or written by anything
// these types describe: that is escalón C.
// ---------------------------------------------------------------------------

/**
 * The artifact event kinds this build records, six of the contract's nine.
 *
 * The other three — `RECLAIM_INTENDED`, `RECLAIM_COMPLETED` and
 * `REFERENCE_TOMBSTONED` — are words of the contract and of
 * `ck_registry_events__artifact_event_kind`, and the door refuses each of them
 * by name: reclamation, garbage collection and tombstoning are P-36 completo.
 * Held here rather than in the contract for decision 45's reason: which words
 * this build admits is a fact about this build, and the vocabulary is the
 * contract's.
 */
export const DELIVERED_ARTIFACT_EVENT_KINDS = [
  "PUBLICATION_INTENDED",
  "PUBLICATION_SUCCEEDED",
  "PUBLICATION_ABANDONED",
  "REFERENCE_RECORDED",
  "PIN_ACQUIRED",
  "PIN_RELEASED",
] as const;

export type DeliveredArtifactEventKind = (typeof DELIVERED_ARTIFACT_EVENT_KINDS)[number];

/**
 * The access policies a reference may name — one, closed in code (decision 59).
 *
 * `access_policy_id` carries no foreign key and no CHECK: artifacts §4 names a
 * `fk_..__access_policy_read_model`, and that table has no dictionary. Until its
 * owner writes one, the policy is this identifier, and the door refuses any
 * other by name. A CHECK would make a second policy a reconstruction of the
 * read model; this list makes it an edit.
 */
export const ARTIFACT_ACCESS_POLICY_IDS = ["SCOPE_EQUALITY_V1"] as const;

/** Metadata of one generation of some bytes (artifacts §3). No owner, no scope. */
export interface ArtifactBlobReadModel {
  readonly contentSha256: string;
  readonly blobGeneration: number;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly lifecycleState: BlobLifecycleState;
  readonly encryptionStatus: EncryptionStatus;
  /** Null if and only if the blob is `PLAINTEXT`. An opaque reference, never a key. */
  readonly keyReference: string | null;
  /** The `registry_events` sequence that published the first reference, or null. */
  readonly firstPublishedSequence: number | null;
  /** That event's own instant, never a clock read. Null with the sequence. */
  readonly firstPublishedAt: string | null;
  /** Null in every state this build can reach. */
  readonly reclaimId: string | null;
  /** Null in every state this build can reach. */
  readonly reclaimedAt: string | null;
  /** The instant of this generation's first `PUBLICATION_INTENDED`, conserved. */
  readonly graceStartedAt: string;
  readonly encryptionProfile: string;
  /** The sequence of the event that last wrote this row. */
  readonly appliedSequence: number;
}

/** One authorized access to one blob generation (artifacts §4). Here lives the permission. */
export interface ArtifactReferenceReadModel {
  readonly artifactReferenceId: string;
  readonly contentSha256: string;
  readonly blobGeneration: number;
  readonly artifactClass: ArtifactClass;
  readonly classification: ArtifactClassification;
  readonly scopeKind: ReferenceScopeKind;
  /** Null only when `scopeKind` is `SYSTEM`. */
  readonly scopeId: string | null;
  readonly producerIdentity: string;
  readonly accessPolicyId: string;
  readonly retentionClass: RetentionClass;
  /** Null if and only if `retentionClass` is `PERMANENT`. Expiring revokes nothing. */
  readonly expiresAt: string | null;
  /** Null in every state this build can reach: tombstoning is not delivered. */
  readonly tombstonedAt: string | null;
  readonly tombstoneReason: string | null;
  readonly createdSequence: number;
  readonly appliedSequence: number;
}

/** One protection of one blob generation from collection (artifacts §5). */
export interface ArtifactPinReadModel {
  readonly artifactPinId: string;
  readonly contentSha256: string;
  readonly blobGeneration: number;
  readonly pinHolderKind: PinHolderKind;
  readonly pinHolderId: string;
  readonly acquiredSequence: number;
  /** Null while the pin is live; never less than `acquiredSequence` after. */
  readonly releasedSequence: number | null;
  readonly appliedSequence: number;
}

/**
 * The revocation of one reference (artifacts §6). The table exists; nothing in
 * this build writes a row into it, because `REFERENCE_TOMBSTONED` is refused.
 */
export interface ArtifactTombstoneReadModel {
  readonly artifactReferenceId: string;
  readonly contentSha256: string;
  readonly blobGeneration: number;
  readonly reason: string;
  readonly decidedBy: string;
  readonly authoritySha256: string;
  readonly recordedSequence: number;
  readonly appliedSequence: number;
}

/**
 * What one artifact event writes, decided once for the door and the fold alike.
 *
 * At most one row of each of three tables: a blob that is born or changes state,
 * a reference that is born, a pin that is born or released. A null is "this
 * event does not touch that table", and a deduplication that conserves a row is
 * a null too, so a conserved row keeps the `appliedSequence` it had.
 */
export interface ArtifactProjectionWrites {
  readonly blob: ArtifactBlobReadModel | null;
  readonly reference: ArtifactReferenceReadModel | null;
  readonly pin: ArtifactPinReadModel | null;
}

/**
 * What the artifact fold reads, whether it runs over the base or over a snapshot.
 *
 * The door answers these from the read models inside its transaction and the
 * rebuild answers them from the snapshot it is filling, so one decision
 * function serves both and a planted history fails the rebuild in the door's
 * own words (decision 56's precedent).
 */
export interface ArtifactFoldView {
  blob(contentSha256: string, blobGeneration: number): ArtifactBlobReadModel | null;
  /** The one generation of this content that is not `RECLAIMED`, or null. */
  unreclaimedBlob(contentSha256: string): ArtifactBlobReadModel | null;
  /** The highest generation this content ever had, or zero. */
  highestBlobGeneration(contentSha256: string): number;
  reference(artifactReferenceId: string): ArtifactReferenceReadModel | null;
  pin(artifactPinId: string): ArtifactPinReadModel | null;
  /** The live pin one holder has on one generation, or null. */
  livePin(
    contentSha256: string,
    blobGeneration: number,
    pinHolderKind: PinHolderKind,
    pinHolderId: string,
  ): ArtifactPinReadModel | null;
}

/**
 * The four artifact read models of an in-memory snapshot, keyed as their tables
 * are, and the two lookups the fold asks of them.
 *
 * The first four maps are what a rebuild writes and what `verifyIntegrity`
 * compares. The last two are indexes over them and are never compared: they
 * answer "the highest generation of this content" and "the live pin of this
 * holder" without a scan per event, which is what the base's two indexes do for
 * the door.
 */
export interface ArtifactProjectionSnapshot {
  /** Keyed by `artifactBlobKey(contentSha256, blobGeneration)`. */
  readonly blobs: Map<string, ArtifactBlobReadModel>;
  readonly references: Map<string, ArtifactReferenceReadModel>;
  readonly pins: Map<string, ArtifactPinReadModel>;
  readonly tombstones: Map<string, ArtifactTombstoneReadModel>;
  /** The highest generation per content. */
  readonly highestGenerations: Map<string, number>;
  /** Keyed by `artifactLivePinKey(...)`, holding the live pin's id. */
  readonly livePins: Map<string, string>;
}

/** One durable artifact row of `registry_events`, with its event and chain position. */
export interface ArtifactEventRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly event: ArtifactRegistryEvent;
  /** The exact bytes the chain digest was computed over. */
  readonly canonicalJson: string;
  readonly previousSha256: string;
  readonly eventSha256: string;
  /** The event this one was recorded as caused by, or null. See CausationRef. */
  readonly causation: CausationRef | null;
}

export interface ArtifactAppendResult {
  /** false means this was an exact replay and nothing new was written. */
  readonly inserted: boolean;
  readonly record: ArtifactEventRecord;
}

/**
 * One stored row of `account_events`, in the column names the table uses (P-08).
 *
 * Snake case, deliberately, and the only type in this package that is. It is
 * the input to the integrity sidecar's preimage, which hashes **the values as
 * stored**; every other type here is a read model or a DTO, where renaming a
 * field is a presentation choice. Here it would be a reinterpretation step
 * between the column and the digest, and a mistake in that step produces a
 * chain that is internally consistent and wrong over history that cannot be
 * rehashed. The names are the columns so that a reader can check the preimage
 * against the DDL without a mapping table in between.
 *
 * `note` is the one nullable column, and SQL NULL is encoded distinctly from
 * the empty string.
 *
 * **The TEXT columns are `Buffer`, and the INTEGER columns admit `bigint`.**
 * Both are the same claim: a row enters the digest as the values the column
 * holds, not as what a driver made of them. A TEXT column holds bytes SQLite
 * never validated as UTF-8, and reading it as a string replaces every invalid
 * sequence with U+FFFD — two different stored rows would then hash alike. An
 * INTEGER column is 64 bits wide, and reading it as a `number` rounds anything
 * past `2**53` — the digest would cover an integer the row does not hold, and
 * the encoder would refuse a value that is perfectly lawful on disk. The
 * readers therefore select these columns as `CAST(col AS BLOB)` and in
 * `safeIntegers` mode; this type is where that obligation is stated.
 */
export interface AccountEventRow {
  readonly sequence: number | bigint;
  readonly event_id: Buffer;
  readonly idempotency_key: Buffer;
  readonly account_id: Buffer;
  readonly version: number | bigint;
  readonly action: Buffer;
  readonly resulting_state: Buffer;
  readonly actor: Buffer;
  readonly note: Buffer | null;
  readonly occurred_at: Buffer;
  readonly recorded_at: Buffer;
  readonly contract_version: Buffer;
  readonly event_json: Buffer;
}

/**
 * The account sidecar's activation, as `ledger_meta` records it (P-08/A2).
 *
 * Two pairs that are equal at activation and diverge afterwards, which is the
 * whole reason there are two. The **baseline** is where the retroactive
 * coverage was taken and never moves again; the **head** follows the chain as
 * the stream grows. Collapsing them would lose the answer to "how much of this
 * was hashed when it was written, and how much was hashed later".
 */
export interface AccountIntegrityState {
  /** `H`: the account head fixed at activation. Zero for an empty stream. */
  readonly baselineSequence: number;
  /** The digest of row `H`, or sixty-four zeros when `H` is zero. */
  readonly baselineSha256: string;
  /** When the retroactive coverage was computed. Never a row's own instant. */
  readonly activatedAt: string;
  readonly headSequence: number;
  readonly headEventSha256: string;
}

/** One recorded operator action, as the ledger returns it (P8-8G packet 2). */
export interface AccountActionRecordRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly event: AccountActionEvent;
}

export interface AccountActionAppendResult {
  /** false means this was an exact replay and nothing new was written. */
  readonly inserted: boolean;
  readonly record: AccountActionRecordRow;
}
