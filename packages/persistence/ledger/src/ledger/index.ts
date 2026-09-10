import Database from "better-sqlite3";

import { AccountActionEvent, ControlPlaneEvent, InitiativeEvent } from "@acp/contracts";

import {
  GENESIS_SHA256,
  canonicalJsonStringify,
  chainDigest,
  sha256Hex,
} from "../canonical-json/index.js";
import {
  LedgerClosedError,
  LedgerEventIdConflictError,
  LedgerIdempotencyConflictError,
  LedgerIntegrityError,
  LedgerLifecycleConflictError,
  LedgerMigrationError,
  LedgerOpenError,
  LedgerQueryError,
  LedgerReadOnlyError,
  LedgerSequenceError,
  LedgerValidationError,
  type LedgerValidationIssue,
} from "../errors/index.js";
import {
  DERIVED_TABLES,
  EXPECTED_SCHEMA_OBJECTS,
  INITIATIVE_PROJECTION_NAMES,
  INITIATIVE_STREAM,
  MIGRATIONS,
  PROJECTION_NAMES,
  PROJECTION_SOURCES,
  PROJECTOR_VERSION,
  SCHEMA_MIGRATIONS_DDL,
  TASK_STREAM,
  applyMigrations,
  checkMigrationConformance,
  readAppliedMigrations,
  schemaMigrationsTableExists,
  type ProjectionSource,
} from "../migrations/index.js";
import {
  applyEventToSnapshot,
  applyInitiativeEventToSnapshot,
  createInitiativeProjectionSnapshot,
  createProjectionSnapshot,
  executionRouteKey,
  nextExecutionRouteProjection,
  nextInitiativeProjection,
  nextRoadmapVersionProjection,
  nextTaskProjection,
  nextWorkerProjection,
  nextWorkerTaskProjection,
  workerTaskKey,
  type InitiativeProjectionSnapshot,
  type ProjectionSnapshot,
  type WorkerTaskProjection,
} from "../projection/index.js";
import type {
  AppendBatchResult,
  AppendResult,
  AppliedMigration,
  CausationRef,
  CausationStream,
  EventPage,
  EventQuery,
  ExecutionRouteReadModel,
  InitiativeAppendResult,
  InitiativeEventPage,
  InitiativeEventQuery,
  InitiativeEventRecord,
  InitiativeReadModel,
  IntegrityProblem,
  IntegrityReport,
  LedgerEventRecord,
  LedgerStatus,
  LedgerTestFaults,
  OpenLedgerOptions,
  ProjectionStatus,
  RebuildResult,
  RoadmapVersionReadModel,
  TaskPage,
  TaskQuery,
  TaskReadModel,
  WorkerPage,
  WorkerQuery,
  WorkerReadModel,
  AccountActionAppendResult,
  AccountActionRecordRow,
} from "../types/index.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 300_000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1_000;
const REPLAY_BATCH_SIZE = 500;

/**
 * Sentinel timestamp for a projection that has consumed no events yet. It is a
 * constant rather than a clock reading so that a fresh ledger is byte-identical
 * everywhere, and so that nothing in the projection path depends on the time.
 */
const EPOCH_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const EVENT_COLUMNS =
  "sequence, event_id, idempotency_key, task_id, attempt, transition_id, type, " +
  "from_state, to_state, emitted_by, occurred_at, recorded_at, correlation_id, " +
  "causation_id, causation_stream, causation_sequence, causation_sha256, " +
  "contract_version, event_json, previous_sha256, event_sha256";

const HEAD_SEQUENCE = "head_sequence";
const HEAD_EVENT_SHA256 = "head_event_sha256";
const EVENT_COUNT = "event_count";

const INITIATIVE_EVENT_COLUMNS =
  "sequence, event_id, idempotency_key, initiative_id, transition_id, type, " +
  "from_status, to_status, emitted_by, occurred_at, recorded_at, " +
  "causation_stream, causation_sequence, causation_sha256, contract_version, " +
  "event_json, previous_sha256, event_sha256";

const INITIATIVE_HEAD_SEQUENCE = "initiative_head_sequence";
const INITIATIVE_HEAD_EVENT_SHA256 = "initiative_head_event_sha256";
const INITIATIVE_EVENT_COUNT = "initiative_event_count";

interface EventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly transition_id: string;
  readonly type: string;
  readonly from_state: string | null;
  readonly to_state: string;
  readonly emitted_by: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly causation_stream: string | null;
  readonly causation_sequence: number | null;
  readonly causation_sha256: string | null;
  readonly contract_version: string;
  readonly event_json: string;
  readonly previous_sha256: string;
  readonly event_sha256: string;
}

interface InitiativeEventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly initiative_id: string;
  readonly transition_id: string;
  readonly type: string;
  readonly from_status: string | null;
  readonly to_status: string;
  readonly emitted_by: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly causation_stream: string | null;
  readonly causation_sequence: number | null;
  readonly causation_sha256: string | null;
  readonly contract_version: string;
  readonly event_json: string;
  readonly previous_sha256: string;
  readonly event_sha256: string;
}

/** The columns a causal reference occupies, in either stream's table. */
interface CausationColumns {
  readonly causation_stream: string | null;
  readonly causation_sequence: number | null;
  readonly causation_sha256: string | null;
}

/**
 * The streams a reference may name in this build (P-09/log-B).
 *
 * The contract's vocabulary is four names; these are the two whose events carry
 * an `event_sha256`. A reference to `account_events` or `registry_events` could
 * only be believed, never checked, and the contract is explicit that a digest
 * which does not match is an invalid reference rather than a weak link — so a
 * reference that *cannot* be matched at all is refused here rather than stored.
 */
const CAUSATION_STREAMS: readonly CausationStream[] = [
  "control_plane_events",
  "initiative_events",
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isCausationStream(value: unknown): value is CausationStream {
  return typeof value === "string" && CAUSATION_STREAMS.includes(value as CausationStream);
}

/**
 * The table a reference resolves against.
 *
 * A total function over the closed set, returning one of two literals written
 * in this module. Nothing a caller supplies is ever concatenated into SQL, for
 * the reason `safeIdentifier` exists a few lines below.
 */
function causationTable(stream: CausationStream): string {
  return stream === "control_plane_events" ? "control_plane_events" : "initiative_events";
}

/** Read a reference out of a stored row, refusing a triple the base should not hold. */
function causationFromRow(row: CausationColumns, sequence: number): CausationRef | null {
  const { causation_stream: stream, causation_sequence: at, causation_sha256: digest } = row;
  if (stream === null && at === null && digest === null) return null;
  if (stream === null || at === null || digest === null || !isCausationStream(stream)) {
    // Only reachable if the BEFORE INSERT trigger was dropped after the row was
    // written. Reading it as "no cause" would launder the tampering.
    throw new LedgerIntegrityError([
      "sequence " + String(sequence) + " holds a causal reference this build cannot resolve",
    ]);
  }
  return { stream, sequence: at, sha256: digest };
}

/** Shape-check a caller's reference. Pure: this reads no database. */
function normalizeCausation(
  candidate: CausationRef | null | undefined,
  path: string,
): CausationRef | null {
  if (candidate === undefined || candidate === null) return null;

  const issues: LedgerValidationIssue[] = [];
  if (typeof candidate !== "object") {
    throw new LedgerValidationError([
      { path, message: "a causal reference is an object with a stream, a sequence and a digest" },
    ]);
  }
  if (!isCausationStream(candidate.stream)) {
    issues.push({
      path: path + ".stream",
      message:
        "a causal reference names a stream whose digest this build can verify: " +
        CAUSATION_STREAMS.join(" or "),
    });
  }
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) {
    // Zero is the genesis digest's position and belongs to no row of any
    // stream, so it is not a reference anything could resolve.
    issues.push({
      path: path + ".sequence",
      message: "a causal reference names a position of one or greater",
    });
  }
  if (typeof candidate.sha256 !== "string" || !SHA256_PATTERN.test(candidate.sha256)) {
    issues.push({
      path: path + ".sha256",
      message: "a causal digest is 64 lowercase hexadecimal characters",
    });
  }
  if (issues.length > 0) throw new LedgerValidationError(issues);

  // Copied rather than kept, so a caller mutating its own object after the call
  // cannot change what the record says was written.
  return {
    stream: candidate.stream,
    sequence: candidate.sequence,
    sha256: candidate.sha256,
  };
}

function causationEquals(left: CausationRef | null, right: CausationRef | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.stream === right.stream &&
    left.sequence === right.sequence &&
    left.sha256 === right.sha256
  );
}

/**
 * What an idempotent replay compares, when it asks whether two appends of one
 * key are the same append.
 *
 * The body alone is not enough any more. The triple is deliberately outside
 * `event_json` — the event contract lives in another package and is not this
 * packet's to widen — so a retry under the same key with a *different* recorded
 * cause has an identical body, and a comparison of bodies would answer
 * `inserted: false` and lose the discrepancy in silence.
 *
 * With no reference on either side this is exactly `sha256Hex(canonicalJson)`,
 * which is what the digests carried by `LedgerIdempotencyConflictError` have
 * always meant. A reference widens the preimage, and only then.
 */
function appendContentDigest(canonicalJson: string, causation: CausationRef | null): string {
  if (causation === null) return sha256Hex(canonicalJson);
  return sha256Hex(
    canonicalJson +
      "\n" +
      causation.stream +
      "\n" +
      String(causation.sequence) +
      "\n" +
      causation.sha256,
  );
}

interface InitiativeRow {
  readonly initiative_id: string;
  readonly current_status: string;
  readonly event_count: number;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly last_event_id: string;
  readonly last_event_type: string;
  readonly last_transition_id: string;
  readonly last_emitted_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RoadmapVersionRow {
  readonly roadmap_version_id: string;
  readonly initiative_id: string;
  readonly version: number;
  readonly content_digest: string;
  readonly parent_version_id: string | null;
  readonly kind: string;
  readonly restores_version_id: string | null;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly sequence: number;
}

interface ExecutionRouteRow {
  readonly task_id: string;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly account_id: string;
  readonly transport_kind: string;
  readonly capability_policy_version: string;
  readonly resolved_at: string;
  readonly recorded_at: string;
  readonly sequence: number;
}

interface TaskRow {
  readonly task_id: string;
  readonly initiative_id: string | null;
  readonly current_state: string;
  readonly latest_attempt: number;
  readonly event_count: number;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly last_event_id: string;
  readonly last_event_type: string;
  readonly last_transition_id: string;
  readonly last_emitted_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly is_terminal: number;
}

interface WorkerRow {
  readonly identity: string;
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  readonly instance: string;
  readonly event_count: number;
  readonly task_count: number;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly last_task_id: string;
  readonly last_event_type: string;
}

interface WorkerTaskRow {
  readonly identity: string;
  readonly task_id: string;
  readonly event_count: number;
  readonly last_sequence: number;
}

interface MetaRow {
  readonly key: string;
  readonly value: string;
}

interface WatermarkRow {
  readonly projection_name: string;
  readonly source_stream: string;
  readonly projector_version: number;
  readonly applied_sequence: number;
  readonly event_count: number;
  readonly source_head_sha256: string;
  readonly updated_at: string;
}

interface HeadState {
  readonly sequence: number;
  readonly sha256: string;
  readonly count: number;
}

/** One event's outcome inside an open transaction, with the head it produced. */
interface AppendedEvent {
  readonly result: AppendResult;
  /** The stream's head after this event. Null when it was an exact replay. */
  readonly head: HeadState | null;
}

/** How far one stream has been folded, as a watermark row records it. */
interface StreamLevel {
  readonly sequence: number;
  readonly count: number;
  readonly sha256: string;
  /**
   * The recording event's own instant, never a clock read. Bookkeeping only:
   * nothing derives how far a projection has been applied from this field —
   * `applied_sequence` is the single answer to that question.
   */
  readonly updatedAt: string;
}

interface ReplayOutcome {
  readonly problems: readonly IntegrityProblem[];
  readonly checked: number;
  readonly lastSequence: number;
  readonly lastSha256: string;
}

function toValidationIssues(issues: readonly { path: PropertyKey[]; message: string }[]): LedgerValidationIssue[] {
  return issues.map((issue) => ({
    path:
      issue.path.length === 0
        ? "<root>"
        : issue.path
            .map((segment) =>
              typeof segment === "symbol" ? (segment.description ?? "<symbol>") : String(segment),
            )
            .join("."),
    message: issue.message,
  }));
}

function taskRowToModel(row: TaskRow): TaskReadModel {
  return {
    taskId: row.task_id,
    initiativeId: row.initiative_id,
    currentState: row.current_state as TaskReadModel["currentState"],
    latestAttempt: row.latest_attempt,
    eventCount: row.event_count,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    lastEventId: row.last_event_id,
    lastEventType: row.last_event_type as TaskReadModel["lastEventType"],
    lastTransitionId: row.last_transition_id,
    lastEmittedBy: row.last_emitted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isTerminal: row.is_terminal === 1,
  };
}

function workerRowToModel(row: WorkerRow): WorkerReadModel {
  return {
    identity: row.identity,
    provider: row.provider,
    model: row.model,
    role: row.role as WorkerReadModel["role"],
    instance: row.instance,
    eventCount: row.event_count,
    taskCount: row.task_count,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastTaskId: row.last_task_id,
    lastEventType: row.last_event_type as WorkerReadModel["lastEventType"],
  };
}

function initiativeRowToModel(row: InitiativeRow): InitiativeReadModel {
  return {
    initiativeId: row.initiative_id,
    currentStatus: row.current_status as InitiativeReadModel["currentStatus"],
    eventCount: row.event_count,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    lastEventId: row.last_event_id,
    lastEventType: row.last_event_type as InitiativeReadModel["lastEventType"],
    lastTransitionId: row.last_transition_id,
    lastEmittedBy: row.last_emitted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function roadmapVersionRowToModel(row: RoadmapVersionRow): RoadmapVersionReadModel {
  return {
    roadmapVersionId: row.roadmap_version_id,
    initiativeId: row.initiative_id,
    version: row.version,
    contentDigest: row.content_digest,
    parentVersionId: row.parent_version_id,
    kind: row.kind as RoadmapVersionReadModel["kind"],
    restoresVersionId: row.restores_version_id,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
  };
}

function executionRouteRowToModel(row: ExecutionRouteRow): ExecutionRouteReadModel {
  return {
    taskId: row.task_id,
    attempt: row.attempt,
    provider: row.provider,
    model: row.model,
    accountId: row.account_id,
    transportKind: row.transport_kind as ExecutionRouteReadModel["transportKind"],
    capabilityPolicyVersion: row.capability_policy_version,
    resolvedAt: row.resolved_at,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
  };
}

function boundedLimit(requested: number | undefined, label: string): number {
  if (requested === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_PAGE_LIMIT) {
    throw new LedgerQueryError(
      label + " limit must be an integer between 1 and " + String(MAX_PAGE_LIMIT),
    );
  }
  return requested;
}

/**
 * The closed set of projection names this build defines, across both streams.
 *
 * The two streams keep separate name lists because each projection is level
 * with its own chain, but membership is one question — a projection_meta row
 * naming anything outside this set describes a build that is not this one.
 */
const PROJECTION_NAME_SET: ReadonlySet<string> = new Set([
  ...PROJECTION_NAMES,
  ...INITIATIVE_PROJECTION_NAMES,
]);

// Which stream a projection follows used to be a second name set here. It is
// now a column: `projection_watermark.source_stream` says it per row, so the
// answer comes from the same place the question is asked from.

const WATERMARK_COLUMNS =
  "projection_name, source_stream, projector_version, applied_sequence, event_count, " +
  "source_head_sha256, updated_at";

/**
 * One key for the composite primary key, so membership is one lookup.
 *
 * The separator is a NUL because it cannot occur in a table or projection name,
 * so no pair of legal names can collide with another pair.
 */
function watermarkKey(projectionName: string, sourceStream: string): string {
  return projectionName + "\u0000" + sourceStream;
}

/** The `(projection, stream)` pairs this build publishes, as a membership set. */
const WATERMARK_KEYS: ReadonlySet<string> = new Set(
  PROJECTION_SOURCES.map((source) => watermarkKey(source.projectionName, source.sourceStream)),
);

const TASK_WATERMARKS: readonly ProjectionSource[] = PROJECTION_SOURCES.filter(
  (source) => source.sourceStream === TASK_STREAM,
);

const INITIATIVE_WATERMARKS: readonly ProjectionSource[] = PROJECTION_SOURCES.filter(
  (source) => source.sourceStream === INITIATIVE_STREAM,
);

/**
 * Render a database-supplied name safely for a diagnostic.
 *
 * A name that reaches a diagnostic came out of the database, and a tampered
 * database can hold anything at all in a TEXT column. Echoing it verbatim would
 * make the ledger a channel for whatever an attacker chose to store, so only a
 * plain identifier is ever printed back.
 */
function safeIdentifier(name: string): string {
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "<unprintable name>";
}

/**
 * The append-only control plane ledger.
 *
 * One SQLite file is the whole authority. Events are appended, never updated
 * and never deleted; read models are derived and can be dropped and rebuilt
 * from the events alone. Raw database access is deliberately not exposed: a
 * caller holding the connection could bypass the append-only triggers and the
 * hash chain, and the ledger would have no way to notice.
 */
export class Ledger {
  readonly #db: Database.Database;
  readonly #path: string;
  readonly #readOnly: boolean;
  readonly #faults: LedgerTestFaults;
  readonly #statements: Map<string, Database.Statement>;
  #closed: boolean;

  private constructor(
    db: Database.Database,
    path: string,
    readOnly: boolean,
    faults: LedgerTestFaults,
  ) {
    this.#db = db;
    this.#path = path;
    this.#readOnly = readOnly;
    this.#faults = faults;
    this.#statements = new Map<string, Database.Statement>();
    this.#closed = false;
  }

  static open(path: string, options: OpenLedgerOptions = {}): Ledger {
    const readOnly = options.readOnly ?? false;
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

    if (
      !Number.isInteger(busyTimeoutMs) ||
      busyTimeoutMs < 0 ||
      busyTimeoutMs > MAX_BUSY_TIMEOUT_MS
    ) {
      throw new LedgerOpenError(
        path,
        "busyTimeoutMs must be an integer between 0 and " + String(MAX_BUSY_TIMEOUT_MS),
      );
    }

    let db: Database.Database;
    try {
      db = readOnly
        ? new Database(path, { readonly: true, fileMustExist: true })
        : new Database(path);
    } catch (error: unknown) {
      throw new LedgerOpenError(path, error instanceof Error ? error.message : "unknown error");
    }

    try {
      // Foreign keys and the lock budget are set before query_only, because a
      // query-only connection will not accept a schema affecting pragma.
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = " + String(busyTimeoutMs));
      if (readOnly) {
        db.pragma("query_only = ON");
      } else {
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
        db.exec(SCHEMA_MIGRATIONS_DDL);
      }

      if (!schemaMigrationsTableExists(db)) {
        throw new LedgerMigrationError([
          "schema_migrations is absent, so this file has never been migrated by this system",
        ]);
      }

      const applied = readAppliedMigrations(db);
      const conformance = checkMigrationConformance(applied);
      if (conformance.problems.length > 0) {
        throw new LedgerMigrationError(conformance.problems);
      }

      if (conformance.missing.length > 0) {
        if (readOnly) {
          // Fail closed. A read-only handle must never migrate, and reading a
          // database through a schema it does not have would invent answers.
          throw new LedgerMigrationError(
            conformance.missing.map(
              (migration) =>
                "migration " +
                String(migration.version) +
                " " +
                migration.name +
                " is not applied and a read-only handle may not apply it",
            ),
          );
        }
        const appliedAt = new Date().toISOString();
        const pending = conformance.missing;
        db.transaction(() => {
          applyMigrations(db, pending, appliedAt);
        }).immediate();
      }
    } catch (error: unknown) {
      db.close();
      throw error;
    }

    return new Ledger(db, path, readOnly, options.__testFaults ?? {});
  }

  // -------------------------------------------------------------------------
  // Handle state
  // -------------------------------------------------------------------------

  get path(): string {
    return this.#path;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }

  #assertOpen(operation: string): void {
    if (this.#closed) throw new LedgerClosedError(operation);
  }

  #assertWritable(operation: string): void {
    if (this.#readOnly) throw new LedgerReadOnlyError(operation);
  }

  #stmt(sql: string): Database.Statement {
    const existing = this.#statements.get(sql);
    if (existing !== undefined) return existing;
    const prepared = this.#db.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  #readMetaMap(): Map<string, string> {
    const rows = this.#stmt("SELECT key, value FROM ledger_meta").all() as MetaRow[];
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  #readHead(): HeadState {
    const meta = this.#readMetaMap();
    const sequenceText = meta.get(HEAD_SEQUENCE);
    const shaText = meta.get(HEAD_EVENT_SHA256);
    const countText = meta.get(EVENT_COUNT);

    if (sequenceText === undefined || shaText === undefined || countText === undefined) {
      throw new LedgerIntegrityError(["ledger_meta is missing a head or count row"]);
    }
    const sequence = Number(sequenceText);
    const count = Number(countText);
    if (!Number.isInteger(sequence) || sequence < 0 || !Number.isInteger(count) || count < 0) {
      throw new LedgerIntegrityError(["ledger_meta holds a head or count that is not a count"]);
    }
    if (!/^[0-9a-f]{64}$/.test(shaText)) {
      throw new LedgerIntegrityError(["ledger_meta holds a head digest that is not a sha-256"]);
    }
    return { sequence, sha256: shaText, count };
  }

  #writeMeta(key: string, value: string): void {
    this.#stmt("UPDATE ledger_meta SET value = ? WHERE key = ?").run(value, key);
  }

  #writeHead(sequence: number, sha256: string, count: number): void {
    this.#writeMeta(HEAD_SEQUENCE, String(sequence));
    this.#writeMeta(HEAD_EVENT_SHA256, sha256);
    this.#writeMeta(EVENT_COUNT, String(count));
  }

  /**
   * The initiative stream's head, read with the same suspicion as the task
   * stream's: a meta row that is missing or is not a count is a corrupted
   * ledger, not a default to paper over.
   */
  #readInitiativeHead(): HeadState {
    const meta = this.#readMetaMap();
    const sequenceText = meta.get(INITIATIVE_HEAD_SEQUENCE);
    const shaText = meta.get(INITIATIVE_HEAD_EVENT_SHA256);
    const countText = meta.get(INITIATIVE_EVENT_COUNT);

    if (sequenceText === undefined || shaText === undefined || countText === undefined) {
      throw new LedgerIntegrityError(["ledger_meta is missing an initiative head or count row"]);
    }
    const sequence = Number(sequenceText);
    const count = Number(countText);
    if (!Number.isInteger(sequence) || sequence < 0 || !Number.isInteger(count) || count < 0) {
      throw new LedgerIntegrityError([
        "ledger_meta holds an initiative head or count that is not a count",
      ]);
    }
    if (!/^[0-9a-f]{64}$/.test(shaText)) {
      throw new LedgerIntegrityError([
        "ledger_meta holds an initiative head digest that is not a sha-256",
      ]);
    }
    return { sequence, sha256: shaText, count };
  }

  #writeInitiativeHead(sequence: number, sha256: string, count: number): void {
    this.#writeMeta(INITIATIVE_HEAD_SEQUENCE, String(sequence));
    this.#writeMeta(INITIATIVE_HEAD_EVENT_SHA256, sha256);
    this.#writeMeta(INITIATIVE_EVENT_COUNT, String(count));
  }

  /**
   * Advance the watermark of every projection fed by one stream.
   *
   * This `UPDATE` is the single source of truth for how far a projection has
   * been applied. Nothing derives that from a clock, from `updated_at`, or from
   * counting rows in the derived table, and nothing may: two answers to "how
   * far" is how a projector applies the same range twice.
   *
   * It targets the composite key rather than the projection name alone, so
   * advancing one stream cannot move a row that follows another.
   */
  #writeWatermarks(sources: readonly ProjectionSource[], level: StreamLevel): void {
    const update = this.#stmt(
      "UPDATE projection_watermark SET projector_version = ?, applied_sequence = ?, " +
        "event_count = ?, source_head_sha256 = ?, updated_at = ? " +
        "WHERE projection_name = ? AND source_stream = ?",
    );
    for (const source of sources) {
      update.run(
        PROJECTOR_VERSION,
        level.sequence,
        level.count,
        level.sha256,
        level.updatedAt,
        source.projectionName,
        source.sourceStream,
      );
    }
  }

  /**
   * Clear and rewrite the whole watermark table, for a rebuild.
   *
   * The contract is explicit that a rebuild deletes the row and writes it back
   * rather than updating it in place: a read model that was dropped and
   * regenerated has no partial state worth preserving, and a row left over from
   * a projection this build no longer defines would survive an UPDATE that
   * never named it.
   */
  #rewriteWatermarks(task: StreamLevel, initiative: StreamLevel): void {
    this.#stmt("DELETE FROM projection_watermark").run();
    const insert = this.#stmt(
      "INSERT INTO projection_watermark (" + WATERMARK_COLUMNS + ") VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const source of PROJECTION_SOURCES) {
      const level = source.sourceStream === INITIATIVE_STREAM ? initiative : task;
      insert.run(
        source.projectionName,
        source.sourceStream,
        PROJECTOR_VERSION,
        level.sequence,
        level.count,
        level.sha256,
        level.updatedAt,
      );
    }
  }

  #readWatermarks(): WatermarkRow[] {
    return this.#stmt(
      "SELECT " +
        WATERMARK_COLUMNS +
        " FROM projection_watermark ORDER BY projection_name ASC, source_stream ASC",
    ).all() as WatermarkRow[];
  }

  /**
   * The chain digest of a stream **at** a given sequence.
   *
   * The verification the contract asks for is against the position the
   * projection actually consumed, not against whatever the head has since
   * become. While every projection is level with its stream the two coincide,
   * which is exactly why comparing against the current head would look correct
   * and would stop being correct the moment a watermark legitimately lagged.
   *
   * The table name is never interpolated from database content: the caller has
   * already matched the row's stream against the closed set, and the two
   * statements below are this module's own literals.
   */
  #digestAtSequence(sourceStream: string, sequence: number): string | null {
    if (sequence === 0) return GENESIS_SHA256;
    const sql =
      sourceStream === INITIATIVE_STREAM
        ? "SELECT event_sha256 FROM initiative_events WHERE sequence = ?"
        : "SELECT event_sha256 FROM control_plane_events WHERE sequence = ?";
    const row = this.#stmt(sql).get(sequence) as { readonly event_sha256: string } | undefined;
    return row === undefined ? null : row.event_sha256;
  }

  // -------------------------------------------------------------------------
  // Event decoding
  // -------------------------------------------------------------------------

  /**
   * Decode a stored row into a record, refusing anything that does not match
   * the contract or its own canonical bytes.
   *
   * Read paths fail closed on tampering rather than returning a plausible
   * looking event, because a UI that renders a tampered event is worse than a
   * UI that refuses to render.
   */
  #rowToRecord(row: EventRow): LedgerEventRecord {
    const problems = this.#validateRowShape(row);
    if (problems.length > 0) {
      throw new LedgerIntegrityError(problems.map((problem) => problem.detail));
    }
    const parsed = ControlPlaneEvent.safeParse(JSON.parse(row.event_json));
    if (!parsed.success) {
      throw new LedgerIntegrityError([
        "stored event at sequence " + String(row.sequence) + " does not satisfy the contract",
      ]);
    }
    return {
      sequence: row.sequence,
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      event: parsed.data,
      canonicalJson: row.event_json,
      previousSha256: row.previous_sha256,
      eventSha256: row.event_sha256,
      causation: causationFromRow(row, row.sequence),
    };
  }

  /**
   * Structural checks that do not need the chain: parseable JSON, canonical
   * bytes, contract conformance, and columns that agree with the body.
   *
   * Column agreement matters because every query filters on the columns rather
   * than on the JSON. If the two disagreed, a filtered query could hide an
   * event that is really there, or surface one that is not.
   */
  #validateRowShape(row: EventRow): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "sequence " + String(row.sequence) + " holds event_json that is not valid JSON",
        sequence: row.sequence,
      });
      return problems;
    }

    let canonical: string;
    try {
      canonical = canonicalJsonStringify(decoded);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "sequence " + String(row.sequence) + " holds event_json that is not canonicalizable",
        sequence: row.sequence,
      });
      return problems;
    }

    if (canonical !== row.event_json) {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "sequence " +
          String(row.sequence) +
          " holds event_json that is not in canonical form, so it was rewritten after it was appended",
        sequence: row.sequence,
      });
    }

    const parsed = ControlPlaneEvent.safeParse(decoded);
    if (!parsed.success) {
      problems.push({
        kind: "EVENT_CONTRACT",
        detail:
          "sequence " +
          String(row.sequence) +
          " holds an event that no longer satisfies the ControlPlaneEvent contract",
        sequence: row.sequence,
      });
      return problems;
    }

    const event = parsed.data;
    const mismatches: string[] = [];
    if (event.eventId !== row.event_id) mismatches.push("event_id");
    if (event.idempotencyKey !== row.idempotency_key) mismatches.push("idempotency_key");
    if (event.taskId !== row.task_id) mismatches.push("task_id");
    if (event.attempt !== row.attempt) mismatches.push("attempt");
    if (event.transitionId !== row.transition_id) mismatches.push("transition_id");
    if (event.type !== row.type) mismatches.push("type");
    if (event.fromState !== row.from_state) mismatches.push("from_state");
    if (event.toState !== row.to_state) mismatches.push("to_state");
    if (event.emittedBy !== row.emitted_by) mismatches.push("emitted_by");
    if (event.occurredAt !== row.occurred_at) mismatches.push("occurred_at");
    if (event.recordedAt !== row.recorded_at) mismatches.push("recorded_at");
    if (event.correlationId !== row.correlation_id) mismatches.push("correlation_id");
    if (event.causationId !== row.causation_id) mismatches.push("causation_id");
    if (event.contractVersion !== row.contract_version) mismatches.push("contract_version");

    if (mismatches.length > 0) {
      problems.push({
        kind: "EVENT_COORDINATES",
        detail:
          "sequence " +
          String(row.sequence) +
          " has columns that disagree with the stored body: " +
          mismatches.join(", "),
        sequence: row.sequence,
      });
    }

    return problems;
  }

  // -------------------------------------------------------------------------
  // Append
  // -------------------------------------------------------------------------

  /**
   * Append one event, atomically, exactly once.
   *
   * An exact replay of an already recorded event is not an error: it returns
   * the original record with inserted false and writes nothing. That is what
   * makes a durable step safe to retry. Reusing the same coordinates for
   * different content is the opposite case and fails closed.
   *
   * The optional second argument records **why** this event happened, as a
   * reference the ledger resolves rather than a string it stores. Omitting it
   * is the ordinary case and is exactly what every caller did before.
   */
  append(candidate: unknown, causation?: CausationRef | null): AppendResult {
    this.#assertOpen("append");
    this.#assertWritable("append");

    const parsed = ControlPlaneEvent.safeParse(candidate);
    if (!parsed.success) {
      throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
    }
    const event = parsed.data;
    const canonicalJson = canonicalJsonStringify(event);
    // Shape before the lock, resolution inside it: a malformed reference does
    // not deserve the write lock, and a well-formed one cannot be resolved
    // without reading the stream it names.
    const reference = normalizeCausation(causation, "causation");

    const run = this.#db.transaction(
      (): AppendResult => this.#appendInTransaction(event, canonicalJson, reference),
    );
    // IMMEDIATE takes the write lock at BEGIN rather than at first write, so
    // two processes serialize here instead of discovering the conflict late and
    // failing with a busy snapshot they cannot upgrade.
    return run.immediate();
  }

  /**
   * Append a batch of task-stream events, atomically, all or none.
   *
   * The batch is the unit: one `BEGIN IMMEDIATE` covers the rows, the
   * projections, the head and the watermarks, so a caller that has three facts
   * to record no longer records them across three transactions with two windows
   * in between. A failure anywhere in the batch leaves the ledger exactly as it
   * was, including the watermarks.
   *
   * It is added **beside** `append`, never in place of it: no call site moves in
   * this packet, and a door that quietly changed the transaction boundary under
   * ten existing callers would be a migration wearing a feature's clothes.
   *
   * The task stream only. The initiative and account doors keep their own
   * single-event entries, because a batch that spanned two streams would be a
   * batch across two independent chains and two independent heads.
   *
   * An exact replay inside a batch is a no-op for that event alone and does not
   * spoil the rest, exactly as it is for `append`. A conflict — a reused key
   * with different content, a reused event id, a transition the lifecycle does
   * not allow — aborts the whole batch, because half a batch is not something
   * the caller asked for.
   *
   * Causal references travel in a parallel array rather than folded into the
   * candidates, because a candidate is whatever the caller has and is parsed
   * against a contract this package does not own. When the array is given it
   * must be the same length as the batch: one that lined up by luck would
   * quietly attribute one event's cause to another.
   */
  appendBatch(
    candidates: readonly unknown[],
    causations?: readonly (CausationRef | null)[],
  ): AppendBatchResult {
    this.#assertOpen("appendBatch");
    this.#assertWritable("appendBatch");

    if (candidates.length === 0) {
      throw new LedgerValidationError([
        {
          path: "<root>",
          message: "a batch is one or more events, and an empty batch appends nothing",
        },
      ]);
    }

    if (causations !== undefined && causations.length !== candidates.length) {
      throw new LedgerValidationError([
        {
          path: "causations",
          message:
            "a batch's causal references are one per event: " +
            String(candidates.length) +
            " events were given " +
            String(causations.length) +
            " references",
        },
      ]);
    }

    // Every candidate is parsed and canonicalized before the transaction opens.
    // A batch that validated lazily would take the write lock, insert the events
    // it had already accepted and only then meet the malformed one: the rollback
    // would be correct, and the contention would be gratuitous.
    const prepared = candidates.map((candidate, index) => {
      const parsed = ControlPlaneEvent.safeParse(candidate);
      if (!parsed.success) {
        throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
      }
      return {
        event: parsed.data,
        canonicalJson: canonicalJsonStringify(parsed.data),
        causation: normalizeCausation(causations?.[index], "causations[" + String(index) + "]"),
      };
    });

    const run = this.#db.transaction((): AppendBatchResult => {
      const results: AppendResult[] = [];
      let level: StreamLevel | null = null;
      let insertedCount = 0;

      for (const { event, canonicalJson, causation } of prepared) {
        const appended = this.#appendOneInTransaction(event, canonicalJson, causation);
        results.push(appended.result);
        if (appended.head === null) continue;
        insertedCount += 1;
        // Each event's own recordedAt, so the watermark carries the instant of
        // the last event actually written rather than a clock read here.
        level = {
          sequence: appended.head.sequence,
          count: appended.head.count,
          sha256: appended.head.sha256,
          updatedAt: event.recordedAt,
        };
      }

      if (level !== null) {
        // One watermark write for the batch. The rows, the projections, the head
        // and the watermarks commit together or not at all.
        this.#writeWatermarks(TASK_WATERMARKS, level);

        // The outbox intention belongs in this transaction and is deliberately
        // empty: P-18 owns `outbox_message` and fills the gap here, so that the
        // transaction boundary does not have to be reopened to add it. Nothing
        // in this packet writes an intention, and nothing here is atomic with an
        // arbiter — the ledger and a coordination store are separate files and
        // never share a transaction.

        this.#faults.beforeAppendCommit?.();
      }

      const head = level ?? this.#readHead();
      return {
        results,
        insertedCount,
        headSequence: head.sequence,
        headEventSha256: head.sha256,
      };
    });

    return run.immediate();
  }

  #appendInTransaction(
    event: ControlPlaneEvent,
    canonicalJson: string,
    causation: CausationRef | null,
  ): AppendResult {
    const appended = this.#appendOneInTransaction(event, canonicalJson, causation);
    if (appended.head === null) return appended.result;

    this.#writeWatermarks(TASK_WATERMARKS, {
      sequence: appended.head.sequence,
      count: appended.head.count,
      sha256: appended.head.sha256,
      updatedAt: event.recordedAt,
    });

    this.#faults.beforeAppendCommit?.();

    return appended.result;
  }

  /**
   * One event's worth of append, inside a transaction the caller opened.
   *
   * Everything except the watermark: the dedupe checks, the lifecycle guard, the
   * chain, the insert, the contiguity check and the incremental projection. The
   * watermark is left to the caller because a batch advances it once, after its
   * last event, rather than once per event.
   */
  #appendOneInTransaction(
    event: ControlPlaneEvent,
    canonicalJson: string,
    causation: CausationRef | null,
  ): AppendedEvent {
    const existingByKey = this.#stmt(
      "SELECT " + EVENT_COLUMNS + " FROM control_plane_events WHERE idempotency_key = ?",
    ).get(event.idempotencyKey) as EventRow | undefined;

    if (existingByKey !== undefined) {
      const stored = causationFromRow(existingByKey, existingByKey.sequence);
      if (existingByKey.event_json === canonicalJson && causationEquals(stored, causation)) {
        return {
          result: { inserted: false, record: this.#rowToRecord(existingByKey) },
          head: null,
        };
      }
      throw new LedgerIdempotencyConflictError(
        event.idempotencyKey,
        appendContentDigest(existingByKey.event_json, stored),
        appendContentDigest(canonicalJson, causation),
      );
    }

    const existingById = this.#stmt(
      "SELECT idempotency_key FROM control_plane_events WHERE event_id = ?",
    ).get(event.eventId) as { readonly idempotency_key: string } | undefined;

    if (existingById !== undefined) {
      throw new LedgerEventIdConflictError(
        event.eventId,
        existingById.idempotency_key,
        event.idempotencyKey,
      );
    }

    const task = this.#stmt(
      "SELECT current_state FROM task_read_model WHERE task_id = ?",
    ).get(event.taskId) as { readonly current_state: string } | undefined;

    if (task === undefined) {
      if (event.fromState !== null) {
        throw new LedgerLifecycleConflictError(event.taskId, event.fromState, null);
      }
    } else if (event.fromState !== task.current_state) {
      throw new LedgerLifecycleConflictError(event.taskId, event.fromState, task.current_state);
    }

    // Resolved here, with the transaction already open, so that a reference to
    // an event appended moments ago by this same batch resolves against a row
    // that is really there. The trigger holds the same line underneath; this
    // layer exists so the refusal is a typed LedgerValidationError rather than
    // a raw SQLite error nobody can catch by class.
    this.#assertCausationResolves(causation);

    const head = this.#readHead();
    const previousSha256 = head.sha256;
    const eventSha256 = chainDigest(previousSha256, canonicalJson);
    const expectedSequence = head.sequence + 1;

    const info = this.#stmt(
      "INSERT INTO control_plane_events (" +
        "event_id, idempotency_key, task_id, attempt, transition_id, type, from_state, " +
        "to_state, emitted_by, occurred_at, recorded_at, correlation_id, causation_id, " +
        "causation_stream, causation_sequence, causation_sha256, " +
        "contract_version, event_json, previous_sha256, event_sha256" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      event.eventId,
      event.idempotencyKey,
      event.taskId,
      event.attempt,
      event.transitionId,
      event.type,
      event.fromState,
      event.toState,
      event.emittedBy,
      event.occurredAt,
      event.recordedAt,
      event.correlationId,
      event.causationId,
      causation === null ? null : causation.stream,
      causation === null ? null : causation.sequence,
      causation === null ? null : causation.sha256,
      event.contractVersion,
      canonicalJson,
      previousSha256,
      eventSha256,
    );

    const sequence = Number(info.lastInsertRowid);
    if (sequence !== expectedSequence) {
      // The head and the table disagree about where the log ends. Refuse rather
      // than chain a digest onto a position that is not actually the tail.
      throw new LedgerSequenceError(expectedSequence, sequence);
    }

    this.#faults.beforeProjection?.();

    this.#projectEvent(event, sequence);
    this.#writeHead(sequence, eventSha256, head.count + 1);

    return {
      result: {
        inserted: true,
        record: {
          sequence,
          eventId: event.eventId,
          idempotencyKey: event.idempotencyKey,
          event,
          canonicalJson,
          previousSha256,
          eventSha256,
          causation,
        },
      },
      head: { sequence, sha256: eventSha256, count: head.count + 1 },
    };
  }

  /**
   * Resolve a causal reference against the stream it names, or refuse it.
   *
   * The digest must be the referenced event's own `event_sha256` at that exact
   * position. A digest that does not match is an invalid reference, not a weak
   * link, and a position no row occupies is the same failure: in both cases the
   * claim "this was caused by that" names nothing this ledger holds.
   */
  #assertCausationResolves(causation: CausationRef | null): void {
    if (causation === null) return;

    const row = this.#stmt(
      "SELECT event_sha256 FROM " + causationTable(causation.stream) + " WHERE sequence = ?",
    ).get(causation.sequence) as { readonly event_sha256: string } | undefined;

    if (row === undefined) {
      throw new LedgerValidationError([
        {
          path: "causation.sequence",
          message:
            "a causal reference names sequence " +
            String(causation.sequence) +
            " of " +
            causation.stream +
            ", which holds no event",
        },
      ]);
    }
    if (row.event_sha256 !== causation.sha256) {
      // Digests only: the referenced body never appears in a diagnostic.
      throw new LedgerValidationError([
        {
          path: "causation.sha256",
          message:
            "a causal reference to sequence " +
            String(causation.sequence) +
            " of " +
            causation.stream +
            " carries digest " +
            causation.sha256 +
            " but that event's digest is " +
            row.event_sha256,
        },
      ]);
    }
  }

  /** Incremental projection. Same rules as replay, applied to one event. */
  #projectEvent(event: ControlPlaneEvent, sequence: number): void {
    const currentTask = this.#stmt(
      "SELECT * FROM task_read_model WHERE task_id = ?",
    ).get(event.taskId) as TaskRow | undefined;

    const nextTask = nextTaskProjection(
      currentTask === undefined ? null : taskRowToModel(currentTask),
      event,
      sequence,
    );
    this.#upsertTask(nextTask);

    const currentPair = this.#stmt(
      "SELECT identity, task_id, event_count, last_sequence FROM worker_task_read_model " +
        "WHERE identity = ? AND task_id = ?",
    ).get(event.emittedBy, event.taskId) as WorkerTaskRow | undefined;

    const currentWorker = this.#stmt(
      "SELECT * FROM worker_read_model WHERE identity = ?",
    ).get(event.emittedBy) as WorkerRow | undefined;

    const nextWorker = nextWorkerProjection(
      currentWorker === undefined ? null : workerRowToModel(currentWorker),
      event,
      sequence,
      currentPair === undefined,
    );
    // The worker row is the foreign key parent, so it is written first.
    this.#upsertWorker(nextWorker);

    const nextPair = nextWorkerTaskProjection(
      currentPair === undefined
        ? null
        : {
            identity: currentPair.identity,
            taskId: currentPair.task_id,
            eventCount: currentPair.event_count,
            lastSequence: currentPair.last_sequence,
          },
      event,
      sequence,
    );
    this.#upsertWorkerTask(nextPair);

    // The route row, when the event carries an admitted one. Same function as
    // the replay path uses, so the incremental projection and a rebuild cannot
    // come to disagree about which events produce a row.
    const route = nextExecutionRouteProjection(event, sequence);
    if (route !== null) this.#upsertExecutionRoute(route);
  }

  #upsertExecutionRoute(route: ExecutionRouteReadModel): void {
    this.#stmt(
      "INSERT INTO execution_route_read_model (" +
        "task_id, attempt, provider, model, account_id, transport_kind, " +
        "capability_policy_version, resolved_at, recorded_at, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (task_id, attempt) DO UPDATE SET " +
        "provider = excluded.provider, model = excluded.model, " +
        "account_id = excluded.account_id, transport_kind = excluded.transport_kind, " +
        "capability_policy_version = excluded.capability_policy_version, " +
        "resolved_at = excluded.resolved_at, recorded_at = excluded.recorded_at, " +
        "sequence = excluded.sequence",
    ).run(
      route.taskId,
      route.attempt,
      route.provider,
      route.model,
      route.accountId,
      route.transportKind,
      route.capabilityPolicyVersion,
      route.resolvedAt,
      route.recordedAt,
      route.sequence,
    );
  }

  #upsertTask(task: TaskReadModel): void {
    this.#stmt(
      "INSERT INTO task_read_model (" +
        "task_id, initiative_id, current_state, latest_attempt, event_count, first_sequence, " +
        "last_sequence, last_event_id, last_event_type, last_transition_id, last_emitted_by, " +
        "created_at, updated_at, is_terminal" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (task_id) DO UPDATE SET " +
        "initiative_id = excluded.initiative_id, " +
        "current_state = excluded.current_state, latest_attempt = excluded.latest_attempt, " +
        "event_count = excluded.event_count, last_sequence = excluded.last_sequence, " +
        "last_event_id = excluded.last_event_id, last_event_type = excluded.last_event_type, " +
        "last_transition_id = excluded.last_transition_id, " +
        "last_emitted_by = excluded.last_emitted_by, updated_at = excluded.updated_at, " +
        "is_terminal = excluded.is_terminal",
    ).run(
      task.taskId,
      task.initiativeId,
      task.currentState,
      task.latestAttempt,
      task.eventCount,
      task.firstSequence,
      task.lastSequence,
      task.lastEventId,
      task.lastEventType,
      task.lastTransitionId,
      task.lastEmittedBy,
      task.createdAt,
      task.updatedAt,
      task.isTerminal ? 1 : 0,
    );
  }

  #upsertWorker(worker: WorkerReadModel): void {
    this.#stmt(
      "INSERT INTO worker_read_model (" +
        "identity, provider, model, role, instance, event_count, task_count, first_sequence, " +
        "last_sequence, first_seen_at, last_seen_at, last_task_id, last_event_type" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (identity) DO UPDATE SET " +
        "event_count = excluded.event_count, task_count = excluded.task_count, " +
        "last_sequence = excluded.last_sequence, last_seen_at = excluded.last_seen_at, " +
        "last_task_id = excluded.last_task_id, last_event_type = excluded.last_event_type",
    ).run(
      worker.identity,
      worker.provider,
      worker.model,
      worker.role,
      worker.instance,
      worker.eventCount,
      worker.taskCount,
      worker.firstSequence,
      worker.lastSequence,
      worker.firstSeenAt,
      worker.lastSeenAt,
      worker.lastTaskId,
      worker.lastEventType,
    );
  }

  #upsertWorkerTask(pair: WorkerTaskProjection): void {
    this.#stmt(
      "INSERT INTO worker_task_read_model (identity, task_id, event_count, last_sequence) " +
        "VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (identity, task_id) DO UPDATE SET " +
        "event_count = excluded.event_count, last_sequence = excluded.last_sequence",
    ).run(pair.identity, pair.taskId, pair.eventCount, pair.lastSequence);
  }

  // -------------------------------------------------------------------------
  // The initiative stream
  // -------------------------------------------------------------------------

  /**
   * Append one initiative event.
   *
   * The same pipeline as the task stream, on its own chain: contract-parse,
   * idempotent replay, the contiguity guard, chain, insert at this stream's
   * own head + 1, project — all inside one immediate transaction. The two
   * streams share a database and a transaction discipline but never a
   * sequence, a digest chain or a head, because an initiative registration is
   * not an event about a task and must not be able to move the task stream's
   * head.
   *
   * Takes the same optional causal reference as `append`, and resolves it under
   * the same rule: the initiative stream is one of the two a reference may name,
   * so causality crosses in both directions or in neither.
   */
  appendInitiativeEvent(
    candidate: unknown,
    causation?: CausationRef | null,
  ): InitiativeAppendResult {
    this.#assertOpen("appendInitiativeEvent");
    this.#assertWritable("appendInitiativeEvent");

    const parsed = InitiativeEvent.safeParse(candidate);
    if (!parsed.success) {
      throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
    }
    const event = parsed.data;
    const canonicalJson = canonicalJsonStringify(event);
    const reference = normalizeCausation(causation, "causation");

    const run = this.#db.transaction(
      (): InitiativeAppendResult =>
        this.#appendInitiativeInTransaction(event, canonicalJson, reference),
    );
    return run.immediate();
  }

  #appendInitiativeInTransaction(
    event: InitiativeEvent,
    canonicalJson: string,
    causation: CausationRef | null,
  ): InitiativeAppendResult {
    const existingByKey = this.#stmt(
      "SELECT " + INITIATIVE_EVENT_COLUMNS + " FROM initiative_events WHERE idempotency_key = ?",
    ).get(event.idempotencyKey) as InitiativeEventRow | undefined;

    if (existingByKey !== undefined) {
      const stored = causationFromRow(existingByKey, existingByKey.sequence);
      if (existingByKey.event_json === canonicalJson && causationEquals(stored, causation)) {
        return { inserted: false, record: this.#initiativeRowToRecord(existingByKey) };
      }
      throw new LedgerIdempotencyConflictError(
        event.idempotencyKey,
        appendContentDigest(existingByKey.event_json, stored),
        appendContentDigest(canonicalJson, causation),
      );
    }

    const existingById = this.#stmt(
      "SELECT idempotency_key FROM initiative_events WHERE event_id = ?",
    ).get(event.eventId) as { readonly idempotency_key: string } | undefined;

    if (existingById !== undefined) {
      throw new LedgerEventIdConflictError(
        event.eventId,
        existingById.idempotency_key,
        event.idempotencyKey,
      );
    }

    // The contiguity guard, mirroring the task stream's: the claimed prior
    // status must be the one the projection actually holds. The DDL allows a
    // null from_status because the first event of an initiative has none; that
    // the null is lawful only there is enforced here, where the projection is
    // visible, and by the contract, which ties it to INITIATIVE_REGISTERED.
    const initiative = this.#stmt(
      "SELECT current_status FROM initiative_read_model WHERE initiative_id = ?",
    ).get(event.initiativeId) as { readonly current_status: string } | undefined;

    if (initiative === undefined) {
      if (event.fromStatus !== null) {
        throw new LedgerLifecycleConflictError(event.initiativeId, event.fromStatus, null);
      }
    } else if (event.fromStatus !== initiative.current_status) {
      throw new LedgerLifecycleConflictError(
        event.initiativeId,
        event.fromStatus,
        initiative.current_status,
      );
    }

    this.#assertCausationResolves(causation);

    const head = this.#readInitiativeHead();
    const previousSha256 = head.sha256;
    const eventSha256 = chainDigest(previousSha256, canonicalJson);
    const expectedSequence = head.sequence + 1;

    const info = this.#stmt(
      "INSERT INTO initiative_events (" +
        "event_id, idempotency_key, initiative_id, transition_id, type, from_status, " +
        "to_status, emitted_by, occurred_at, recorded_at, " +
        "causation_stream, causation_sequence, causation_sha256, " +
        "contract_version, event_json, previous_sha256, event_sha256" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      event.eventId,
      event.idempotencyKey,
      event.initiativeId,
      event.transitionId,
      event.type,
      event.fromStatus,
      event.toStatus,
      event.emittedBy,
      event.occurredAt,
      event.recordedAt,
      causation === null ? null : causation.stream,
      causation === null ? null : causation.sequence,
      causation === null ? null : causation.sha256,
      event.contractVersion,
      canonicalJson,
      previousSha256,
      eventSha256,
    );

    // AUTOINCREMENT is per table, but both streams share one rowid space only
    // in the sense that each has its own; the check is the same one the task
    // stream makes, and for the same reason.
    const sequence = Number(info.lastInsertRowid);
    if (sequence !== expectedSequence) {
      throw new LedgerSequenceError(expectedSequence, sequence);
    }

    this.#faults.beforeProjection?.();

    this.#projectInitiativeEvent(event, sequence);
    this.#writeInitiativeHead(sequence, eventSha256, head.count + 1);
    // The same discipline as the task door, on this stream's own watermarks:
    // an append that moves a head moves the watermark of every projection fed
    // by that head, in the same transaction, and of no other.
    this.#writeWatermarks(INITIATIVE_WATERMARKS, {
      sequence,
      count: head.count + 1,
      sha256: eventSha256,
      updatedAt: event.recordedAt,
    });

    this.#faults.beforeAppendCommit?.();

    return {
      inserted: true,
      record: {
        sequence,
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        event,
        canonicalJson,
        previousSha256,
        eventSha256,
        causation,
      },
    };
  }

  /** Incremental projection of the initiative stream. Same rules as replay. */
  #projectInitiativeEvent(event: InitiativeEvent, sequence: number): void {
    const current = this.#stmt(
      "SELECT * FROM initiative_read_model WHERE initiative_id = ?",
    ).get(event.initiativeId) as InitiativeRow | undefined;

    this.#upsertInitiative(
      nextInitiativeProjection(
        current === undefined ? null : initiativeRowToModel(current),
        event,
        sequence,
      ),
    );

    const version = nextRoadmapVersionProjection(event, sequence);
    if (version !== null) this.#upsertRoadmapVersion(version);
  }

  #upsertInitiative(initiative: InitiativeReadModel): void {
    this.#stmt(
      "INSERT INTO initiative_read_model (" +
        "initiative_id, current_status, event_count, first_sequence, last_sequence, " +
        "last_event_id, last_event_type, last_transition_id, last_emitted_by, created_at, " +
        "updated_at" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (initiative_id) DO UPDATE SET " +
        "current_status = excluded.current_status, event_count = excluded.event_count, " +
        "last_sequence = excluded.last_sequence, last_event_id = excluded.last_event_id, " +
        "last_event_type = excluded.last_event_type, " +
        "last_transition_id = excluded.last_transition_id, " +
        "last_emitted_by = excluded.last_emitted_by, updated_at = excluded.updated_at",
    ).run(
      initiative.initiativeId,
      initiative.currentStatus,
      initiative.eventCount,
      initiative.firstSequence,
      initiative.lastSequence,
      initiative.lastEventId,
      initiative.lastEventType,
      initiative.lastTransitionId,
      initiative.lastEmittedBy,
      initiative.createdAt,
      initiative.updatedAt,
    );
  }

  #upsertRoadmapVersion(version: RoadmapVersionReadModel): void {
    this.#stmt(
      "INSERT INTO roadmap_version_read_model (" +
        "roadmap_version_id, initiative_id, version, content_digest, parent_version_id, " +
        "kind, restores_version_id, recorded_by, recorded_at, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (roadmap_version_id) DO UPDATE SET " +
        "initiative_id = excluded.initiative_id, version = excluded.version, " +
        "content_digest = excluded.content_digest, " +
        "parent_version_id = excluded.parent_version_id, kind = excluded.kind, " +
        "restores_version_id = excluded.restores_version_id, " +
        "recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at, " +
        "sequence = excluded.sequence",
    ).run(
      version.roadmapVersionId,
      version.initiativeId,
      version.version,
      version.contentDigest,
      version.parentVersionId,
      version.kind,
      version.restoresVersionId,
      version.recordedBy,
      version.recordedAt,
      version.sequence,
    );
  }

  #initiativeRowToRecord(row: InitiativeEventRow): InitiativeEventRecord {
    const parsed = InitiativeEvent.safeParse(JSON.parse(row.event_json));
    if (!parsed.success) {
      throw new LedgerIntegrityError([
        "initiative event at sequence " +
          String(row.sequence) +
          " no longer satisfies the contract",
      ]);
    }
    return {
      sequence: row.sequence,
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      event: parsed.data,
      canonicalJson: row.event_json,
      previousSha256: row.previous_sha256,
      eventSha256: row.event_sha256,
      causation: causationFromRow(row, row.sequence),
    };
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  /**
   * Walk the entire event stream in bounded pages, validating every row and
   * the whole hash chain, and hand each valid event to the caller.
   *
   * Reading in pages rather than with one open cursor is deliberate: the
   * rebuild path writes while it walks, and a long-lived read cursor would
   * block those writes on the same connection.
   */
  #replay(onEvent: (event: ControlPlaneEvent, row: EventRow) => void): ReplayOutcome {
    const problems: IntegrityProblem[] = [];
    let checked = 0;
    let previous = GENESIS_SHA256;
    let expectedSequence = 1;
    let cursor = 0;

    const select = this.#stmt(
      "SELECT " +
        EVENT_COLUMNS +
        " FROM control_plane_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    );

    for (;;) {
      const rows = select.all(cursor, REPLAY_BATCH_SIZE) as EventRow[];
      if (rows.length === 0) break;

      for (const row of rows) {
        cursor = row.sequence;

        if (row.sequence !== expectedSequence) {
          problems.push({
            kind: "SEQUENCE",
            detail:
              "expected sequence " +
              String(expectedSequence) +
              " but found " +
              String(row.sequence) +
              ", so the log is not contiguous",
            sequence: row.sequence,
          });
          expectedSequence = row.sequence;
        }
        expectedSequence += 1;
        checked += 1;

        const shapeProblems = this.#validateRowShape(row);
        if (shapeProblems.length > 0) problems.push(...shapeProblems);

        // The chain checks do not depend on the body being well formed, and
        // they are the strongest evidence available, so they always run. An
        // earlier version skipped them once a row already had a shape problem,
        // which meant a rewritten body reported only that its columns
        // disagreed and never that its digest no longer matched its content.
        if (row.previous_sha256 !== previous) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "sequence " +
              String(row.sequence) +
              " records previous digest " +
              row.previous_sha256 +
              " but the chain has reached " +
              previous,
            sequence: row.sequence,
          });
        }

        const recomputed = chainDigest(row.previous_sha256, row.event_json);
        if (recomputed !== row.event_sha256) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "sequence " +
              String(row.sequence) +
              " records digest " +
              row.event_sha256 +
              " but its stored content hashes to " +
              recomputed,
            sequence: row.sequence,
          });
        }

        previous = row.event_sha256;

        // Only a row that passed every shape check can be projected. An
        // unparseable or contract-violating body has nothing to replay.
        if (shapeProblems.length === 0) {
          const parsed = ControlPlaneEvent.safeParse(JSON.parse(row.event_json));
          if (parsed.success) onEvent(parsed.data, row);
        }
      }
    }

    return { problems, checked, lastSequence: cursor, lastSha256: previous };
  }

  /**
   * Walk the initiative stream the way `#replay` walks the task stream.
   *
   * Separate rather than generic: the two streams have different columns,
   * different coordinate checks and different contracts, and a shared walker
   * would have to be told which at every step. What they do share — the
   * canonical-form check, the chain arithmetic, the contiguity rule — is
   * mirrored deliberately, and a divergence between them is a defect.
   */
  #replayInitiative(onEvent: (event: InitiativeEvent, row: InitiativeEventRow) => void): ReplayOutcome {
    const problems: IntegrityProblem[] = [];
    let checked = 0;
    let previous = GENESIS_SHA256;
    let expectedSequence = 1;
    let cursor = 0;

    const select = this.#stmt(
      "SELECT " +
        INITIATIVE_EVENT_COLUMNS +
        " FROM initiative_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    );

    for (;;) {
      const rows = select.all(cursor, REPLAY_BATCH_SIZE) as InitiativeEventRow[];
      if (rows.length === 0) break;

      for (const row of rows) {
        cursor = row.sequence;

        if (row.sequence !== expectedSequence) {
          problems.push({
            kind: "SEQUENCE",
            detail:
              "initiative_events expected sequence " +
              String(expectedSequence) +
              " but found " +
              String(row.sequence) +
              ", so the stream is not contiguous",
            sequence: row.sequence,
          });
          expectedSequence = row.sequence;
        }
        expectedSequence += 1;
        checked += 1;

        const shapeProblems = this.#validateInitiativeRowShape(row);
        if (shapeProblems.length > 0) problems.push(...shapeProblems);

        if (row.previous_sha256 !== previous) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "initiative sequence " +
              String(row.sequence) +
              " records previous digest " +
              row.previous_sha256 +
              " but the chain has reached " +
              previous,
            sequence: row.sequence,
          });
        }

        const recomputed = chainDigest(row.previous_sha256, row.event_json);
        if (recomputed !== row.event_sha256) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "initiative sequence " +
              String(row.sequence) +
              " records digest " +
              row.event_sha256 +
              " but its stored content hashes to " +
              recomputed,
            sequence: row.sequence,
          });
        }

        previous = row.event_sha256;

        if (shapeProblems.length === 0) {
          const parsed = InitiativeEvent.safeParse(JSON.parse(row.event_json));
          if (parsed.success) onEvent(parsed.data, row);
        }
      }
    }

    return { problems, checked, lastSequence: cursor, lastSha256: previous };
  }

  #validateInitiativeRowShape(row: InitiativeEventRow): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " holds event_json that is not valid JSON",
        sequence: row.sequence,
      });
      return problems;
    }

    let canonical: string;
    try {
      canonical = canonicalJsonStringify(decoded);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " holds event_json that is not canonicalizable",
        sequence: row.sequence,
      });
      return problems;
    }

    if (canonical !== row.event_json) {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " holds event_json that is not in canonical form, so it was rewritten after it was appended",
        sequence: row.sequence,
      });
    }

    const parsed = InitiativeEvent.safeParse(decoded);
    if (!parsed.success) {
      problems.push({
        kind: "EVENT_CONTRACT",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " holds an event that no longer satisfies the InitiativeEvent contract",
        sequence: row.sequence,
      });
      return problems;
    }

    const event = parsed.data;
    const mismatches: string[] = [];
    if (event.eventId !== row.event_id) mismatches.push("event_id");
    if (event.idempotencyKey !== row.idempotency_key) mismatches.push("idempotency_key");
    if (event.initiativeId !== row.initiative_id) mismatches.push("initiative_id");
    if (event.transitionId !== row.transition_id) mismatches.push("transition_id");
    if (event.type !== row.type) mismatches.push("type");
    if (event.fromStatus !== row.from_status) mismatches.push("from_status");
    if (event.toStatus !== row.to_status) mismatches.push("to_status");
    if (event.emittedBy !== row.emitted_by) mismatches.push("emitted_by");
    if (event.occurredAt !== row.occurred_at) mismatches.push("occurred_at");
    if (event.recordedAt !== row.recorded_at) mismatches.push("recorded_at");
    if (event.contractVersion !== row.contract_version) mismatches.push("contract_version");

    if (mismatches.length > 0) {
      problems.push({
        kind: "EVENT_COORDINATES",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " has indexed columns that disagree with its stored event: " +
          mismatches.join(", "),
        sequence: row.sequence,
      });
    }

    return problems;
  }

  // -------------------------------------------------------------------------
  // Rebuild
  // -------------------------------------------------------------------------

  /**
   * Drop every derived projection and replay the ledger into a fresh one.
   *
   * Transactional from end to end. If validation, replay or any write fails,
   * the previous projection is still there untouched, because a control plane
   * that loses its read model during a repair is worse off than one that never
   * attempted the repair.
   *
   * A ledger whose head metadata disagrees with its actual tail is refused
   * rather than quietly rebuilt. Rebuilding a truncated log would produce a
   * clean looking read model over a history that is missing events, which is
   * exactly the failure this package exists to make impossible.
   */
  rebuildReadModel(): RebuildResult {
    this.#assertOpen("rebuildReadModel");
    this.#assertWritable("rebuildReadModel");

    const run = this.#db.transaction((): RebuildResult => {
      const snapshot = createProjectionSnapshot();
      let lastRecordedAt = EPOCH_TIMESTAMP;

      const replay = this.#replay((event, row) => {
        applyEventToSnapshot(snapshot, event, row.sequence);
        lastRecordedAt = event.recordedAt;
      });

      // Both chains are replayed before anything is cleared, and both are
      // required to be sound: a rebuild that repaired one stream while the
      // other was corrupt would hand back a clean-looking read model over a
      // ledger that is not clean.
      const initiativeSnapshot = createInitiativeProjectionSnapshot();
      let lastInitiativeRecordedAt = EPOCH_TIMESTAMP;

      const initiativeReplay = this.#replayInitiative((event, row) => {
        applyInitiativeEventToSnapshot(initiativeSnapshot, event, row.sequence);
        lastInitiativeRecordedAt = event.recordedAt;
      });

      const problems = [...replay.problems, ...initiativeReplay.problems].map(
        (problem) => problem.detail,
      );

      const initiativeHead = this.#readInitiativeHead();
      if (initiativeHead.sequence !== initiativeReplay.lastSequence) {
        problems.push(
          "initiative head is sequence " +
            String(initiativeHead.sequence) +
            " but the last stored initiative event is sequence " +
            String(initiativeReplay.lastSequence),
        );
      }
      if (initiativeHead.sha256 !== initiativeReplay.lastSha256) {
        problems.push(
          "initiative head digest " +
            initiativeHead.sha256 +
            " does not match the replayed initiative chain head",
        );
      }
      if (initiativeHead.count !== initiativeReplay.checked) {
        problems.push(
          "initiative head counts " +
            String(initiativeHead.count) +
            " events but " +
            String(initiativeReplay.checked) +
            " are stored",
        );
      }

      const head = this.#readHead();
      if (head.sequence !== replay.lastSequence) {
        problems.push(
          "ledger head is sequence " +
            String(head.sequence) +
            " but the last stored event is sequence " +
            String(replay.lastSequence),
        );
      }
      if (head.sha256 !== replay.lastSha256) {
        problems.push(
          "ledger head digest " + head.sha256 + " does not match the replayed chain head",
        );
      }
      if (head.count !== replay.checked) {
        problems.push(
          "ledger head counts " +
            String(head.count) +
            " events but " +
            String(replay.checked) +
            " are stored",
        );
      }

      if (problems.length > 0) {
        // Refuse before touching the projection. Rebuilding from an untrusted
        // log would launder corruption into a clean looking read model.
        throw new LedgerIntegrityError(problems);
      }

      // Only derived tables are cleared. The event table has no DELETE path at
      // all: the append-only trigger would abort this statement if it were
      // ever aimed at control_plane_events.
      for (const table of DERIVED_TABLES) {
        this.#stmt("DELETE FROM " + table).run();
      }

      for (const task of snapshot.tasks.values()) this.#upsertTask(task);
      for (const worker of snapshot.workers.values()) this.#upsertWorker(worker);
      for (const pair of snapshot.workerTasks.values()) this.#upsertWorkerTask(pair);
      for (const route of snapshot.executionRoutes.values()) this.#upsertExecutionRoute(route);

      for (const initiative of initiativeSnapshot.initiatives.values()) {
        this.#upsertInitiative(initiative);
      }
      for (const version of initiativeSnapshot.roadmapVersions.values()) {
        this.#upsertRoadmapVersion(version);
      }

      // The watermark rows are deleted and written back, not updated in place.
      // A rebuild regenerates the derived tables from the log, so there is no
      // partial watermark worth keeping, and a row belonging to a projection
      // this build no longer defines would survive an UPDATE that never named
      // it.
      this.#rewriteWatermarks(
        {
          sequence: replay.lastSequence,
          count: replay.checked,
          sha256: replay.lastSha256,
          updatedAt: lastRecordedAt,
        },
        {
          sequence: initiativeReplay.lastSequence,
          count: initiativeReplay.checked,
          sha256: initiativeReplay.lastSha256,
          updatedAt: lastInitiativeRecordedAt,
        },
      );

      this.#faults.beforeRebuildCommit?.();

      return {
        replayedEvents: replay.checked,
        throughSequence: replay.lastSequence,
        taskRows: snapshot.tasks.size,
        workerRows: snapshot.workers.size,
        executionRouteRows: snapshot.executionRoutes.size,
        replayedInitiativeEvents: initiativeReplay.checked,
        initiativeThroughSequence: initiativeReplay.lastSequence,
        initiativeRows: initiativeSnapshot.initiatives.size,
        roadmapVersionRows: initiativeSnapshot.roadmapVersions.size,
      };
    });

    return run.immediate();
  }

  // -------------------------------------------------------------------------
  // Integrity
  // -------------------------------------------------------------------------

  /**
   * Verify everything that can be verified, and report rather than throw.
   *
   * Reporting is the right shape here: an operator investigating a suspect
   * ledger needs the full list of what is wrong, not the first thing that was
   * wrong. The checks cover the database itself, the migration set, every
   * stored body against its canonical form and the contract, the full hash
   * chain, sequence contiguity, the head and count metadata, and finally the
   * stored projections against a fresh replay.
   */
  verifyIntegrity(): IntegrityReport {
    this.#assertOpen("verifyIntegrity");

    const problems: IntegrityProblem[] = [];

    const integrityRows = this.#db.pragma("integrity_check") as {
      readonly integrity_check: string;
    }[];
    for (const row of integrityRows) {
      if (row.integrity_check !== "ok") {
        problems.push({
          kind: "SQLITE_INTEGRITY",
          detail: "sqlite integrity_check reported: " + row.integrity_check,
          sequence: null,
        });
      }
    }

    const foreignKeyRows = this.#db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyRows.length > 0) {
      problems.push({
        kind: "FOREIGN_KEY",
        detail:
          "foreign_key_check reported " +
          String(foreignKeyRows.length) +
          " violation(s) in the derived tables",
        sequence: null,
      });
    }

    const conformance = checkMigrationConformance(readAppliedMigrations(this.#db));
    for (const problem of conformance.problems) {
      problems.push({ kind: "MIGRATION", detail: problem, sequence: null });
    }
    for (const migration of conformance.missing) {
      problems.push({
        kind: "MIGRATION",
        detail:
          "migration " + String(migration.version) + " " + migration.name + " is not applied",
        sequence: null,
      });
    }

    problems.push(...this.#checkSchemaShape());

    const snapshot = createProjectionSnapshot();
    const replay = this.#replay((event, row) => {
      applyEventToSnapshot(snapshot, event, row.sequence);
    });
    problems.push(...replay.problems);

    const initiativeSnapshot = createInitiativeProjectionSnapshot();
    const initiativeReplay = this.#replayInitiative((event, row) => {
      applyInitiativeEventToSnapshot(initiativeSnapshot, event, row.sequence);
    });
    problems.push(...initiativeReplay.problems);

    try {
      const initiativeHead = this.#readInitiativeHead();
      if (initiativeHead.sequence !== initiativeReplay.lastSequence) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "initiative head is sequence " +
            String(initiativeHead.sequence) +
            " but the last stored initiative event is sequence " +
            String(initiativeReplay.lastSequence) +
            ", so the tail is truncated or the head is stale",
          sequence: null,
        });
      }
      if (initiativeHead.sha256 !== initiativeReplay.lastSha256) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "initiative head digest " +
            initiativeHead.sha256 +
            " does not match the replayed initiative chain head " +
            initiativeReplay.lastSha256,
          sequence: null,
        });
      }
      if (initiativeHead.count !== initiativeReplay.checked) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "initiative head counts " +
            String(initiativeHead.count) +
            " events but " +
            String(initiativeReplay.checked) +
            " are stored",
          sequence: null,
        });
      }
    } catch (error: unknown) {
      problems.push({
        kind: "LEDGER_META",
        detail: error instanceof Error ? error.message : "the initiative head is unreadable",
        sequence: null,
      });
    }

    let headSequence = 0;
    let headEventSha256 = GENESIS_SHA256;
    try {
      const head = this.#readHead();
      headSequence = head.sequence;
      headEventSha256 = head.sha256;

      if (head.sequence !== replay.lastSequence) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "ledger head is sequence " +
            String(head.sequence) +
            " but the last stored event is sequence " +
            String(replay.lastSequence) +
            ", so the tail is truncated or the head is stale",
          sequence: null,
        });
      }
      if (head.sha256 !== replay.lastSha256) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "ledger head digest " +
            head.sha256 +
            " does not match the replayed chain head " +
            replay.lastSha256,
          sequence: null,
        });
      }
      if (head.count !== replay.checked) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "ledger head counts " +
            String(head.count) +
            " events but " +
            String(replay.checked) +
            " are stored",
          sequence: null,
        });
      }
    } catch (error: unknown) {
      problems.push({
        kind: "LEDGER_META",
        detail: error instanceof Error ? error.message : "ledger_meta is unreadable",
        sequence: null,
      });
    }

    // projection_watermark membership is a closed set of (projection, stream)
    // pairs, and every row must be exactly level with the head of the stream it
    // names.
    //
    // An earlier version of this check read projection_meta, which had one row
    // per projection and so could only ask the question of a projection that
    // folded exactly one stream. The pair is what makes the question decidable
    // once a projection has two independent heads.
    //
    // The kind stays PROJECTION_META. The integrity vocabulary is owned by the
    // wire contract, which is not in this packet's write-set, and a watermark
    // problem is a projection-metadata problem — the table it lives in changed,
    // not what it means to an operator reading the report.
    const watermarkRows = this.#readWatermarks();
    const observedWatermarks = new Set<string>();

    for (const row of watermarkRows) {
      const label = safeIdentifier(row.projection_name);
      const streamLabel = safeIdentifier(row.source_stream);
      const key = watermarkKey(row.projection_name, row.source_stream);

      if (!WATERMARK_KEYS.has(key)) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            "projection_watermark holds " +
            label +
            " on " +
            streamLabel +
            ", which this build does not define",
          sequence: null,
        });
        continue;
      }
      observedWatermarks.add(key);

      // A fold written by another algorithm is not a fold this build would have
      // written. The derived table is invalid whatever the sequence says.
      if (row.projector_version !== PROJECTOR_VERSION) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " on " +
            streamLabel +
            " was written by projector version " +
            String(row.projector_version) +
            " but this build is version " +
            String(PROJECTOR_VERSION),
          sequence: null,
        });
      }

      // Each projection is level with the head of the stream it was built from.
      // Comparing an initiative projection against the task head would report
      // every healthy ledger as broken the moment the two streams had different
      // lengths, which is to say almost always.
      const onInitiativeStream = row.source_stream === INITIATIVE_STREAM;
      const expectedSequence = onInitiativeStream
        ? initiativeReplay.lastSequence
        : replay.lastSequence;

      if (row.applied_sequence !== expectedSequence) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " is applied through sequence " +
            String(row.applied_sequence) +
            " but the head of " +
            streamLabel +
            " is sequence " +
            String(expectedSequence),
          sequence: null,
        });
      }

      // The digest is verified AT applied_sequence, not against the head the
      // stream has since reached. The two coincide while the watermark is level
      // — which is why comparing against the current head passes today and
      // stops being an answer the moment a watermark lawfully lags.
      const expectedSha256 = this.#digestAtSequence(row.source_stream, row.applied_sequence);
      if (expectedSha256 === null) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " is applied through sequence " +
            String(row.applied_sequence) +
            " which " +
            streamLabel +
            " does not hold",
          sequence: null,
        });
      } else if (row.source_head_sha256 !== expectedSha256) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " was built from chain head " +
            row.source_head_sha256 +
            " which is not the digest of " +
            streamLabel +
            " at sequence " +
            String(row.applied_sequence),
          sequence: null,
        });
      }
    }

    for (const source of PROJECTION_SOURCES) {
      if (!observedWatermarks.has(watermarkKey(source.projectionName, source.sourceStream))) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            "projection_watermark is missing the row for " +
            source.projectionName +
            " on " +
            source.sourceStream,
          sequence: null,
        });
      }
    }

    problems.push(...this.#compareProjections(snapshot));
    problems.push(...this.#compareInitiativeProjections(initiativeSnapshot));

    return {
      ok: problems.length === 0,
      checkedEvents: replay.checked,
      headSequence,
      headEventSha256,
      problems,
    };
  }

  /** Compare the stored projections against a fresh replay of the ledger. */
  #compareProjections(snapshot: ProjectionSnapshot): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    const storedTasks = new Map(
      (this.#stmt("SELECT * FROM task_read_model").all() as TaskRow[]).map((row) => [
        row.task_id,
        taskRowToModel(row),
      ]),
    );
    return this.#compareProjectionsWith(snapshot, problems, storedTasks);
  }

  /** Compare the stored initiative projections against a fresh replay. */
  #compareInitiativeProjections(snapshot: InitiativeProjectionSnapshot): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    const storedInitiatives = new Map(
      (this.#stmt("SELECT * FROM initiative_read_model").all() as InitiativeRow[]).map((row) => [
        row.initiative_id,
        initiativeRowToModel(row),
      ]),
    );

    for (const [initiativeId, expected] of snapshot.initiatives) {
      const stored = storedInitiatives.get(initiativeId);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "initiative_read_model is missing initiative " + initiativeId,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "initiative_read_model row for initiative " + initiativeId + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const initiativeId of storedInitiatives.keys()) {
      if (!snapshot.initiatives.has(initiativeId)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "initiative_read_model holds initiative " +
            initiativeId +
            " which no event accounts for",
          sequence: null,
        });
      }
    }

    const storedVersions = new Map(
      (
        this.#stmt("SELECT * FROM roadmap_version_read_model").all() as RoadmapVersionRow[]
      ).map((row) => [row.roadmap_version_id, roadmapVersionRowToModel(row)]),
    );

    for (const [versionId, expected] of snapshot.roadmapVersions) {
      const stored = storedVersions.get(versionId);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "roadmap_version_read_model is missing version " + versionId,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "roadmap_version_read_model row for version " + versionId + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const versionId of storedVersions.keys()) {
      if (!snapshot.roadmapVersions.has(versionId)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "roadmap_version_read_model holds version " +
            versionId +
            " which no event accounts for",
          sequence: null,
        });
      }
    }

    return problems;
  }

  /**
   * Confirm the live schema still holds every object the migrations created.
   *
   * This is what makes the append-only triggers a standing guarantee rather
   * than a one-time event at migration time.
   */
  #checkSchemaShape(): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    const rows = this.#stmt(
      "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE ?",
    ).all("sqlite_%") as { readonly type: string; readonly name: string }[];

    const present = new Set(rows.map((row) => row.type + " " + row.name));

    for (const expected of EXPECTED_SCHEMA_OBJECTS) {
      if (!present.has(expected.type + " " + expected.name)) {
        problems.push({
          kind: "SCHEMA_SHAPE",
          detail:
            "the " +
            expected.type +
            " " +
            expected.name +
            " was created by a migration but is no longer present",
          sequence: null,
        });
      }
    }

    const allowed = new Set(
      EXPECTED_SCHEMA_OBJECTS.map((object) => object.type + " " + object.name),
    );
    for (const key of present) {
      if (!allowed.has(key)) {
        problems.push({
          kind: "SCHEMA_SHAPE",
          detail: "the schema holds an object no migration created: " + key,
          sequence: null,
        });
      }
    }

    return problems;
  }

  #compareProjectionsWith(
    snapshot: ProjectionSnapshot,
    problems: IntegrityProblem[],
    storedTasks: Map<string, TaskReadModel>,
  ): IntegrityProblem[] {
    for (const [taskId, expected] of snapshot.tasks) {
      const stored = storedTasks.get(taskId);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_read_model is missing task " + taskId,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_read_model row for task " + taskId + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const taskId of storedTasks.keys()) {
      if (!snapshot.tasks.has(taskId)) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_read_model holds task " + taskId + " which no event accounts for",
          sequence: null,
        });
      }
    }

    const storedWorkers = new Map(
      (this.#stmt("SELECT * FROM worker_read_model").all() as WorkerRow[]).map((row) => [
        row.identity,
        workerRowToModel(row),
      ]),
    );
    for (const [identity, expected] of snapshot.workers) {
      const stored = storedWorkers.get(identity);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_read_model is missing worker " + identity,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_read_model row for worker " + identity + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const identity of storedWorkers.keys()) {
      if (!snapshot.workers.has(identity)) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_read_model holds worker " + identity + " which no event accounts for",
          sequence: null,
        });
      }
    }

    // The association rows are compared as exact sets, in both directions.
    //
    // Counting them was not enough, and the gap was the interesting one: a
    // substituted pair, where one association is replaced by a different one,
    // leaves the total unchanged and would have passed a count comparison while
    // the projection claimed a worker had worked on a task it never touched.
    const storedPairs = this.#stmt(
      "SELECT identity, task_id, event_count, last_sequence FROM worker_task_read_model",
    ).all() as WorkerTaskRow[];

    const storedPairsByKey = new Map<string, string>();
    for (const row of storedPairs) {
      storedPairsByKey.set(
        workerTaskKey(row.identity, row.task_id),
        canonicalJsonStringify({
          identity: row.identity,
          taskId: row.task_id,
          eventCount: row.event_count,
          lastSequence: row.last_sequence,
        }),
      );
    }

    for (const [key, expected] of snapshot.workerTasks) {
      const stored = storedPairsByKey.get(key);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_task_read_model is missing the association " + key,
          sequence: null,
        });
        continue;
      }
      if (stored !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_task_read_model row for " + key + " disagrees with a replay",
          sequence: null,
        });
      }
    }

    for (const key of storedPairsByKey.keys()) {
      if (!snapshot.workerTasks.has(key)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "worker_task_read_model holds the association " +
            key +
            " which no event accounts for",
          sequence: null,
        });
      }
    }

    // The route rows, compared as exact sets in both directions for the same
    // reason the association rows are: a substituted route leaves the count
    // unchanged while the projection claims an attempt ran on an account or a
    // policy version it never ran on, which is precisely the claim this
    // projection exists to be able to make.
    const storedRoutes = new Map(
      (
        this.#stmt("SELECT * FROM execution_route_read_model").all() as ExecutionRouteRow[]
      ).map((row) => [executionRouteKey(row.task_id, row.attempt), executionRouteRowToModel(row)]),
    );

    for (const [key, expected] of snapshot.executionRoutes) {
      const stored = storedRoutes.get(key);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "execution_route_read_model is missing the route for " + key,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "execution_route_read_model row for " + key + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const key of storedRoutes.keys()) {
      if (!snapshot.executionRoutes.has(key)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "execution_route_read_model holds the route for " + key + " which no event accounts for",
          sequence: null,
        });
      }
    }

    return problems;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getEvent(eventId: string): LedgerEventRecord | null {
    this.#assertOpen("getEvent");
    const row = this.#stmt(
      "SELECT " + EVENT_COLUMNS + " FROM control_plane_events WHERE event_id = ?",
    ).get(eventId) as EventRow | undefined;
    return row === undefined ? null : this.#rowToRecord(row);
  }

  getEventBySequence(sequence: number): LedgerEventRecord | null {
    this.#assertOpen("getEventBySequence");
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new LedgerQueryError("sequence must be a positive integer");
    }
    const row = this.#stmt(
      "SELECT " + EVENT_COLUMNS + " FROM control_plane_events WHERE sequence = ?",
    ).get(sequence) as EventRow | undefined;
    return row === undefined ? null : this.#rowToRecord(row);
  }

  getEventByIdempotencyKey(idempotencyKey: string): LedgerEventRecord | null {
    this.#assertOpen("getEventByIdempotencyKey");
    const row = this.#stmt(
      "SELECT " + EVENT_COLUMNS + " FROM control_plane_events WHERE idempotency_key = ?",
    ).get(idempotencyKey) as EventRow | undefined;
    return row === undefined ? null : this.#rowToRecord(row);
  }

  /** Events in sequence order, filtered and bounded. The cursor is exclusive. */
  listEvents(query: EventQuery = {}): EventPage {
    this.#assertOpen("listEvents");
    const limit = boundedLimit(query.limit, "event");
    const afterSequence = query.afterSequence ?? 0;
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new LedgerQueryError("afterSequence must be a non negative integer");
    }

    const clauses = ["sequence > ?"];
    const params: (string | number)[] = [afterSequence];
    if (query.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(query.taskId);
    }
    if (query.type !== undefined) {
      clauses.push("type = ?");
      params.push(query.type);
    }
    if (query.emittedBy !== undefined) {
      clauses.push("emitted_by = ?");
      params.push(query.emittedBy);
    }
    if (query.toState !== undefined) {
      clauses.push("to_state = ?");
      params.push(query.toState);
    }
    params.push(limit + 1);

    const rows = this.#stmt(
      "SELECT " +
        EVENT_COLUMNS +
        " FROM control_plane_events WHERE " +
        clauses.join(" AND ") +
        " ORDER BY sequence ASC LIMIT ?",
    ).all(...params) as EventRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const events = page.map((row) => this.#rowToRecord(row));
    const last = events.at(-1);
    return {
      events,
      nextCursor: hasMore && last !== undefined ? last.sequence : null,
      hasMore,
    };
  }

  getTask(taskId: string): TaskReadModel | null {
    this.#assertOpen("getTask");
    const row = this.#stmt("SELECT * FROM task_read_model WHERE task_id = ?").get(taskId) as
      | TaskRow
      | undefined;
    return row === undefined ? null : taskRowToModel(row);
  }

  /**
   * The route one attempt of a task was admitted on, or null (V2-B1c).
   *
   * `(taskId, attempt)` and not `taskId`: a retry may have resolved a
   * different account or model, and both answers are facts the ledger holds.
   * Null means the attempt recorded no admitted route — either it predates
   * V2-B1c, or its `RUN_STARTED` payload did not satisfy the contract and the
   * projection refused it while the event itself still stands.
   */
  getExecutionRoute(taskId: string, attempt: number): ExecutionRouteReadModel | null {
    this.#assertOpen("getExecutionRoute");
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new LedgerQueryError("attempt must be a positive integer");
    }
    const row = this.#stmt(
      "SELECT * FROM execution_route_read_model WHERE task_id = ? AND attempt = ?",
    ).get(taskId, attempt) as ExecutionRouteRow | undefined;
    return row === undefined ? null : executionRouteRowToModel(row);
  }

  /** A task's recorded routes, in attempt order, so a retry's history reads in order. */
  listExecutionRoutes(taskId: string): readonly ExecutionRouteReadModel[] {
    this.#assertOpen("listExecutionRoutes");
    return (
      this.#stmt(
        "SELECT * FROM execution_route_read_model WHERE task_id = ? ORDER BY attempt ASC",
      ).all(taskId) as ExecutionRouteRow[]
    ).map(executionRouteRowToModel);
  }

  /** Tasks ordered by taskId, so two rebuilds produce identical pages. */
  listTasks(query: TaskQuery = {}): TaskPage {
    this.#assertOpen("listTasks");
    const limit = boundedLimit(query.limit, "task");

    const clauses = ["task_id > ?"];
    const params: (string | number)[] = [query.afterTaskId ?? ""];
    if (query.state !== undefined) {
      clauses.push("current_state = ?");
      params.push(query.state);
    }
    params.push(limit + 1);

    const rows = this.#stmt(
      "SELECT * FROM task_read_model WHERE " +
        clauses.join(" AND ") +
        " ORDER BY task_id ASC LIMIT ?",
    ).all(...params) as TaskRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const tasks = page.map(taskRowToModel);
    const last = tasks.at(-1);
    return {
      tasks,
      nextCursor: hasMore && last !== undefined ? last.taskId : null,
      hasMore,
    };
  }

  getWorker(identity: string): WorkerReadModel | null {
    this.#assertOpen("getWorker");
    const row = this.#stmt("SELECT * FROM worker_read_model WHERE identity = ?").get(identity) as
      | WorkerRow
      | undefined;
    return row === undefined ? null : workerRowToModel(row);
  }

  /** Observed workers ordered by identity, for the same determinism reason. */
  listWorkers(query: WorkerQuery = {}): WorkerPage {
    this.#assertOpen("listWorkers");
    const limit = boundedLimit(query.limit, "worker");

    const clauses = ["identity > ?"];
    const params: (string | number)[] = [query.afterIdentity ?? ""];
    if (query.role !== undefined) {
      clauses.push("role = ?");
      params.push(query.role);
    }
    if (query.provider !== undefined) {
      clauses.push("provider = ?");
      params.push(query.provider);
    }
    params.push(limit + 1);

    const rows = this.#stmt(
      "SELECT * FROM worker_read_model WHERE " +
        clauses.join(" AND ") +
        " ORDER BY identity ASC LIMIT ?",
    ).all(...params) as WorkerRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const workers = page.map(workerRowToModel);
    const last = workers.at(-1);
    return {
      workers,
      nextCursor: hasMore && last !== undefined ? last.identity : null,
      hasMore,
    };
  }

  /**
   * Effective configuration and position, read back from the connection.
   *
   * The pragmas are queried rather than echoed from the options, so this proves
   * what the connection actually negotiated instead of what was requested.
   */
  getInitiative(initiativeId: string): InitiativeReadModel | null {
    this.#assertOpen("getInitiative");
    const row = this.#stmt(
      "SELECT * FROM initiative_read_model WHERE initiative_id = ?",
    ).get(initiativeId) as InitiativeRow | undefined;
    return row === undefined ? null : initiativeRowToModel(row);
  }

  /**
   * Every initiative the stream has registered, in a stable order.
   *
   * The portfolio enumerator. It is deliberately **unpaged**, like
   * `listRoadmapVersions` beside it and unlike `listEvents` or `listTasks`: a
   * page belongs to a stream that grows without bound, and an initiative is
   * not one. A portfolio is a small, deliberately-declared set — offering a
   * cursor here would promise an advance that never comes and would make every
   * caller write a loop that runs once.
   *
   * Ordered by creation and then by id, so two reads of an unchanged ledger
   * return the same rows in the same order. Ordering by `updatedAt` would have
   * made a portfolio reshuffle itself as unrelated initiatives moved.
   */
  listInitiatives(): readonly InitiativeReadModel[] {
    this.#assertOpen("listInitiatives");
    const rows = this.#stmt(
      "SELECT * FROM initiative_read_model ORDER BY created_at ASC, initiative_id ASC",
    ).all() as InitiativeRow[];
    return rows.map(initiativeRowToModel);
  }

  /**
   * Every recorded roadmap version for one initiative, in version order.
   *
   * This is what a caller folds into the head the roadmap-version decision
   * consumes. It is a query rather than a decision input assembled inside the
   * module on purpose: the module never reads a ledger, so the fold has to
   * cross the boundary as a value.
   */
  listRoadmapVersions(initiativeId: string): readonly RoadmapVersionReadModel[] {
    this.#assertOpen("listRoadmapVersions");
    const rows = this.#stmt(
      "SELECT * FROM roadmap_version_read_model WHERE initiative_id = ? ORDER BY version ASC",
    ).all(initiativeId) as RoadmapVersionRow[];
    return rows.map(roadmapVersionRowToModel);
  }

  /**
   * Record one operator action against one account (P8-8G packet 2).
   *
   * The ledger decides no account policy. It records what the seam decided,
   * and refuses only what it alone can see: a replayed key, a reused event id.
   * There is no lifecycle guard here of the kind the task and initiative
   * streams carry, and that absence is deliberate — an account's lawful
   * transitions are the seam's to know, and duplicating them here would put
   * the same policy in two places with no mechanism keeping them equal.
   */
  appendAccountAction(candidate: unknown): AccountActionAppendResult {
    this.#assertOpen("appendAccountAction");
    this.#assertWritable("appendAccountAction");

    const parsed = AccountActionEvent.safeParse(candidate);
    if (!parsed.success) {
      throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
    }
    const event = parsed.data;
    const canonicalJson = canonicalJsonStringify(event);

    const run = this.#db.transaction((): AccountActionAppendResult => {
      const existingByKey = this.#stmt(
        "SELECT sequence, event_id, event_json FROM account_events WHERE idempotency_key = ?",
      ).get(event.idempotencyKey) as
        | { readonly sequence: number; readonly event_id: string; readonly event_json: string }
        | undefined;

      if (existingByKey !== undefined) {
        if (existingByKey.event_json === canonicalJson) {
          return {
            inserted: false,
            record: {
              sequence: existingByKey.sequence,
              eventId: existingByKey.event_id,
              event: AccountActionEvent.parse(JSON.parse(existingByKey.event_json)),
            },
          };
        }
        throw new LedgerIdempotencyConflictError(
          event.idempotencyKey,
          sha256Hex(existingByKey.event_json),
          sha256Hex(canonicalJson),
        );
      }

      const existingById = this.#stmt(
        "SELECT idempotency_key FROM account_events WHERE event_id = ?",
      ).get(event.eventId) as { readonly idempotency_key: string } | undefined;
      if (existingById !== undefined) {
        throw new LedgerEventIdConflictError(
          event.eventId,
          existingById.idempotency_key,
          event.idempotencyKey,
        );
      }

      const info = this.#stmt(
        "INSERT INTO account_events (event_id, idempotency_key, account_id, version, action," +
          " resulting_state, actor, note, occurred_at, recorded_at, contract_version, event_json)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        event.eventId,
        event.idempotencyKey,
        event.accountId,
        event.version,
        event.action,
        event.resultingState,
        event.actor,
        event.note,
        event.occurredAt,
        event.recordedAt,
        event.contractVersion,
        canonicalJson,
      );

      return {
        inserted: true,
        record: { sequence: Number(info.lastInsertRowid), eventId: event.eventId, event },
      };
    });
    return run.immediate();
  }

  /**
   * One account's action history, oldest first.
   *
   * Oldest first because the fold that derives an account's effective state
   * walks it forward, and a reader wanting the current state takes the last
   * entry rather than re-sorting.
   */
  listAccountActions(accountId: string): readonly AccountActionRecordRow[] {
    this.#assertOpen("listAccountActions");
    const rows = this.#stmt(
      "SELECT sequence, event_id, event_json FROM account_events" +
        " WHERE account_id = ? ORDER BY version ASC",
    ).all(accountId) as {
      readonly sequence: number;
      readonly event_id: string;
      readonly event_json: string;
    }[];

    return Object.freeze(
      rows.map((row) => ({
        sequence: row.sequence,
        eventId: row.event_id,
        event: AccountActionEvent.parse(JSON.parse(row.event_json)),
      })),
    );
  }

  listInitiativeEvents(query: InitiativeEventQuery = {}): InitiativeEventPage {
    this.#assertOpen("listInitiativeEvents");
    const limit = boundedLimit(query.limit, "initiative event");

    const clauses: string[] = ["sequence > ?"];
    const parameters: unknown[] = [query.afterSequence ?? 0];

    if (query.initiativeId !== undefined) {
      clauses.push("initiative_id = ?");
      parameters.push(query.initiativeId);
    }
    if (query.type !== undefined) {
      clauses.push("type = ?");
      parameters.push(query.type);
    }

    const rows = this.#stmt(
      "SELECT " +
        INITIATIVE_EVENT_COLUMNS +
        " FROM initiative_events WHERE " +
        clauses.join(" AND ") +
        " ORDER BY sequence ASC LIMIT ?",
    ).all(...parameters, limit + 1) as InitiativeEventRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const events = page.map((row) => this.#initiativeRowToRecord(row));
    const last = events.at(-1);

    return {
      events,
      nextCursor: hasMore && last !== undefined ? last.sequence : null,
      hasMore,
    };
  }

  status(): LedgerStatus {
    this.#assertOpen("status");
    const head = this.#readHead();
    const initiativeHead = this.#readInitiativeHead();

    // One row per projection, in the shape callers already parse.
    //
    // The watermark table is keyed by (projection, stream), so in principle a
    // projection could contribute more than one row here. In this build no
    // projection folds more than one stream, so the count and the shape are
    // exactly what they were when this read came from projection_meta: five
    // rows, ordered by name, with `appliedThroughSequence` carrying
    // `applied_sequence`. The gateway forwards this array to a strict schema
    // without mapping it, so a field added here would be a wire break; the
    // vector's extra coordinates travel when that schema does, not before.
    const projections: ProjectionStatus[] = this.#readWatermarks().map((row) => {
      // The name is database content, not a module constant. It is checked
      // against the closed set before it can ever be interpolated into SQL, so
      // a ledger whose metadata was edited fails loudly here instead of handing
      // an attacker-chosen identifier to the query planner.
      if (!PROJECTION_NAME_SET.has(row.projection_name)) {
        throw new LedgerIntegrityError([
          "projection_watermark holds the projection name " +
            safeIdentifier(row.projection_name) +
            " which this build does not define",
        ]);
      }
      const counted = this.#stmt("SELECT COUNT(*) AS n FROM " + row.projection_name).get() as {
        readonly n: number;
      };
      return {
        name: row.projection_name,
        appliedThroughSequence: row.applied_sequence,
        eventCount: row.event_count,
        sourceHeadSha256: row.source_head_sha256,
        updatedAt: row.updated_at,
        rowCount: counted.n,
      };
    });

    const migrations: AppliedMigration[] = readAppliedMigrations(this.#db);

    return {
      path: this.#path,
      readOnly: this.#readOnly,
      pragmas: {
        journalMode: this.#db.pragma("journal_mode", { simple: true }) as string,
        foreignKeys: (this.#db.pragma("foreign_keys", { simple: true }) as number) === 1,
        synchronous: this.#db.pragma("synchronous", { simple: true }) as number,
        busyTimeoutMs: this.#db.pragma("busy_timeout", { simple: true }) as number,
        queryOnly: (this.#db.pragma("query_only", { simple: true }) as number) === 1,
      },
      migrations,
      headSequence: head.sequence,
      headEventSha256: head.sha256,
      eventCount: head.count,
      initiativeHeadSequence: initiativeHead.sequence,
      initiativeHeadEventSha256: initiativeHead.sha256,
      initiativeEventCount: initiativeHead.count,
      projections,
    };
  }
}

/** The migration set this build defines, exposed for diagnostics. */
export const LEDGER_MIGRATIONS = MIGRATIONS;

/**
 * Open a ledger.
 *
 * A writable open creates the file if needed and applies any missing
 * migrations. A read-only open requires the file to exist, never migrates, and
 * refuses to proceed if the applied migration set is not exactly this build.
 */
export function openLedger(path: string, options: OpenLedgerOptions = {}): Ledger {
  return Ledger.open(path, options);
}
