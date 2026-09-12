import type {
  AccountActionEvent,
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
 * `envelopeArtifactReferenceId` is absent, not forgotten: the artifact plane is
 * P-36/local and a `NOT NULL` reference cannot be minted without it. Decision
 * 41 and ADR 0067 record the deferral.
 */
export interface TaskRevisionReadModel {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly revisionId: string;
  readonly envelopeSha256: string;
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
}

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
