import Database from "better-sqlite3";

import { ControlPlaneEvent, InitiativeEvent } from "@acp/contracts";

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
  MIGRATIONS,
  PROJECTION_NAMES,
  SCHEMA_MIGRATIONS_DDL,
  applyMigrations,
  checkMigrationConformance,
  readAppliedMigrations,
  schemaMigrationsTableExists,
} from "../migrations/index.js";
import {
  applyEventToSnapshot,
  applyInitiativeEventToSnapshot,
  createInitiativeProjectionSnapshot,
  createProjectionSnapshot,
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
  AppendResult,
  AppliedMigration,
  EventPage,
  EventQuery,
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
  "causation_id, contract_version, event_json, previous_sha256, event_sha256";

const HEAD_SEQUENCE = "head_sequence";
const HEAD_EVENT_SHA256 = "head_event_sha256";
const EVENT_COUNT = "event_count";

const INITIATIVE_EVENT_COLUMNS =
  "sequence, event_id, idempotency_key, initiative_id, transition_id, type, " +
  "from_status, to_status, emitted_by, occurred_at, recorded_at, contract_version, " +
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
  readonly contract_version: string;
  readonly event_json: string;
  readonly previous_sha256: string;
  readonly event_sha256: string;
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

interface ProjectionMetaRow {
  readonly name: string;
  readonly applied_through_sequence: number;
  readonly event_count: number;
  readonly source_head_sha256: string;
  readonly updated_at: string;
}

interface HeadState {
  readonly sequence: number;
  readonly sha256: string;
  readonly count: number;
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

/** Which stream a projection follows. */
const INITIATIVE_PROJECTION_NAME_SET: ReadonlySet<string> = new Set(INITIATIVE_PROJECTION_NAMES);

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

  #writeInitiativeProjectionMeta(
    appliedThroughSequence: number,
    eventCount: number,
    sourceHeadSha256: string,
    updatedAt: string,
  ): void {
    const update = this.#stmt(
      "UPDATE projection_meta SET applied_through_sequence = ?, event_count = ?, " +
        "source_head_sha256 = ?, updated_at = ? WHERE name = ?",
    );
    for (const name of INITIATIVE_PROJECTION_NAMES) {
      update.run(appliedThroughSequence, eventCount, sourceHeadSha256, updatedAt, name);
    }
  }

  #writeProjectionMeta(
    appliedThroughSequence: number,
    eventCount: number,
    sourceHeadSha256: string,
    updatedAt: string,
  ): void {
    const update = this.#stmt(
      "UPDATE projection_meta SET applied_through_sequence = ?, event_count = ?, " +
        "source_head_sha256 = ?, updated_at = ? WHERE name = ?",
    );
    for (const name of PROJECTION_NAMES) {
      update.run(appliedThroughSequence, eventCount, sourceHeadSha256, updatedAt, name);
    }
  }

  #readProjectionMeta(): ProjectionMetaRow[] {
    return this.#stmt(
      "SELECT name, applied_through_sequence, event_count, source_head_sha256, updated_at " +
        "FROM projection_meta ORDER BY name ASC",
    ).all() as ProjectionMetaRow[];
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
   */
  append(candidate: unknown): AppendResult {
    this.#assertOpen("append");
    this.#assertWritable("append");

    const parsed = ControlPlaneEvent.safeParse(candidate);
    if (!parsed.success) {
      throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
    }
    const event = parsed.data;
    const canonicalJson = canonicalJsonStringify(event);

    const run = this.#db.transaction((): AppendResult => this.#appendInTransaction(event, canonicalJson));
    // IMMEDIATE takes the write lock at BEGIN rather than at first write, so
    // two processes serialize here instead of discovering the conflict late and
    // failing with a busy snapshot they cannot upgrade.
    return run.immediate();
  }

  #appendInTransaction(
    event: ControlPlaneEvent,
    canonicalJson: string,
  ): AppendResult {
    const existingByKey = this.#stmt(
      "SELECT " + EVENT_COLUMNS + " FROM control_plane_events WHERE idempotency_key = ?",
    ).get(event.idempotencyKey) as EventRow | undefined;

    if (existingByKey !== undefined) {
      if (existingByKey.event_json === canonicalJson) {
        return { inserted: false, record: this.#rowToRecord(existingByKey) };
      }
      throw new LedgerIdempotencyConflictError(
        event.idempotencyKey,
        sha256Hex(existingByKey.event_json),
        sha256Hex(canonicalJson),
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

    const head = this.#readHead();
    const previousSha256 = head.sha256;
    const eventSha256 = chainDigest(previousSha256, canonicalJson);
    const expectedSequence = head.sequence + 1;

    const info = this.#stmt(
      "INSERT INTO control_plane_events (" +
        "event_id, idempotency_key, task_id, attempt, transition_id, type, from_state, " +
        "to_state, emitted_by, occurred_at, recorded_at, correlation_id, causation_id, " +
        "contract_version, event_json, previous_sha256, event_sha256" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    this.#writeProjectionMeta(sequence, head.count + 1, eventSha256, event.recordedAt);

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
      },
    };
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
   */
  appendInitiativeEvent(candidate: unknown): InitiativeAppendResult {
    this.#assertOpen("appendInitiativeEvent");
    this.#assertWritable("appendInitiativeEvent");

    const parsed = InitiativeEvent.safeParse(candidate);
    if (!parsed.success) {
      throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
    }
    const event = parsed.data;
    const canonicalJson = canonicalJsonStringify(event);

    const run = this.#db.transaction(
      (): InitiativeAppendResult => this.#appendInitiativeInTransaction(event, canonicalJson),
    );
    return run.immediate();
  }

  #appendInitiativeInTransaction(
    event: InitiativeEvent,
    canonicalJson: string,
  ): InitiativeAppendResult {
    const existingByKey = this.#stmt(
      "SELECT " + INITIATIVE_EVENT_COLUMNS + " FROM initiative_events WHERE idempotency_key = ?",
    ).get(event.idempotencyKey) as InitiativeEventRow | undefined;

    if (existingByKey !== undefined) {
      if (existingByKey.event_json === canonicalJson) {
        return { inserted: false, record: this.#initiativeRowToRecord(existingByKey) };
      }
      throw new LedgerIdempotencyConflictError(
        event.idempotencyKey,
        sha256Hex(existingByKey.event_json),
        sha256Hex(canonicalJson),
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

    const head = this.#readInitiativeHead();
    const previousSha256 = head.sha256;
    const eventSha256 = chainDigest(previousSha256, canonicalJson);
    const expectedSequence = head.sequence + 1;

    const info = this.#stmt(
      "INSERT INTO initiative_events (" +
        "event_id, idempotency_key, initiative_id, transition_id, type, from_status, " +
        "to_status, emitted_by, occurred_at, recorded_at, contract_version, event_json, " +
        "previous_sha256, event_sha256" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    this.#writeInitiativeProjectionMeta(
      sequence,
      head.count + 1,
      eventSha256,
      event.recordedAt,
    );

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

      for (const initiative of initiativeSnapshot.initiatives.values()) {
        this.#upsertInitiative(initiative);
      }
      for (const version of initiativeSnapshot.roadmapVersions.values()) {
        this.#upsertRoadmapVersion(version);
      }

      this.#writeProjectionMeta(
        replay.lastSequence,
        replay.checked,
        replay.lastSha256,
        lastRecordedAt,
      );
      this.#writeInitiativeProjectionMeta(
        initiativeReplay.lastSequence,
        initiativeReplay.checked,
        initiativeReplay.lastSha256,
        lastInitiativeRecordedAt,
      );

      this.#faults.beforeRebuildCommit?.();

      return {
        replayedEvents: replay.checked,
        throughSequence: replay.lastSequence,
        taskRows: snapshot.tasks.size,
        workerRows: snapshot.workers.size,
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

    // projection_meta membership is a closed set, and every row must be exactly
    // level with the ledger head.
    //
    // An earlier version only asserted that a projection was not applied BEYOND
    // the head. That was too weak in both directions: a row frozen at an older
    // sequence is stale rather than merely plausible, and a missing or extra
    // row means the metadata no longer describes this build at all.
    const projectionMetaRows = this.#readProjectionMeta();
    const observedProjectionNames = new Set<string>();

    for (const row of projectionMetaRows) {
      const label = safeIdentifier(row.name);

      if (!PROJECTION_NAME_SET.has(row.name)) {
        problems.push({
          kind: "PROJECTION_META",
          detail: "projection_meta holds " + label + " which this build does not define",
          sequence: null,
        });
        continue;
      }
      observedProjectionNames.add(row.name);

      // Each projection is level with the head of the stream it was built
      // from. Comparing an initiative projection against the task head would
      // report every healthy ledger as broken the moment the two streams had
      // different lengths, which is to say almost always.
      const onInitiativeStream = INITIATIVE_PROJECTION_NAME_SET.has(row.name);
      const expectedSequence = onInitiativeStream
        ? initiativeReplay.lastSequence
        : replay.lastSequence;
      const expectedSha256 = onInitiativeStream
        ? initiativeReplay.lastSha256
        : replay.lastSha256;
      const streamLabel = onInitiativeStream ? "the initiative stream" : "the ledger";

      if (row.applied_through_sequence !== expectedSequence) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " is applied through sequence " +
            String(row.applied_through_sequence) +
            " but the head of " +
            streamLabel +
            " is sequence " +
            String(expectedSequence),
          sequence: null,
        });
      }

      if (row.source_head_sha256 !== expectedSha256) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " was built from chain head " +
            row.source_head_sha256 +
            " which is not the chain head of " +
            streamLabel,
          sequence: null,
        });
      }
    }

    for (const name of [...PROJECTION_NAMES, ...INITIATIVE_PROJECTION_NAMES]) {
      if (!observedProjectionNames.has(name)) {
        problems.push({
          kind: "PROJECTION_META",
          detail: "projection_meta is missing the row for " + name,
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

    const projections: ProjectionStatus[] = this.#readProjectionMeta().map((row) => {
      // The name is database content, not a module constant. It is checked
      // against the closed set before it can ever be interpolated into SQL, so
      // a ledger whose metadata was edited fails loudly here instead of handing
      // an attacker-chosen identifier to the query planner.
      if (!PROJECTION_NAME_SET.has(row.name)) {
        throw new LedgerIntegrityError([
          "projection_meta holds the projection name " +
            safeIdentifier(row.name) +
            " which this build does not define",
        ]);
      }
      const counted = this.#stmt("SELECT COUNT(*) AS n FROM " + row.name).get() as {
        readonly n: number;
      };
      return {
        name: row.name,
        appliedThroughSequence: row.applied_through_sequence,
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
