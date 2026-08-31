import type Database from "better-sqlite3";

import { sha256Hex } from "../canonical-json/index.js";
import type { AppliedMigration } from "../types/index.js";

/**
 * The ordered, checksummed migration set.
 *
 * Migration source is immutable. A migration that has shipped is never edited,
 * because the checksum recorded in schema_migrations is compared against the
 * checksum computed from this file on every single open. Editing a shipped
 * migration would make every existing ledger refuse to open, which is the
 * intended outcome: it is far better than silently running new code against a
 * schema it was never written for.
 *
 * A new schema change is a new version appended to the end. Nothing else.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

/**
 * Bootstrap DDL for the migration table itself.
 *
 * This is not a migration: it is the table migrations are recorded in, so it
 * cannot record its own application. It is created only on a writable open.
 */
export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER NOT NULL PRIMARY KEY,
  name       TEXT    NOT NULL,
  sha256     TEXT    NOT NULL,
  applied_at TEXT    NOT NULL
) STRICT;
`;

interface MigrationSource {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const SOURCES: readonly MigrationSource[] = [
  {
    version: 1,
    name: "control_plane_events",
    sql: `
CREATE TABLE control_plane_events (
  sequence         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT    NOT NULL UNIQUE,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  task_id          TEXT    NOT NULL,
  attempt          INTEGER NOT NULL,
  transition_id    TEXT    NOT NULL,
  type             TEXT    NOT NULL,
  from_state       TEXT,
  to_state         TEXT    NOT NULL,
  emitted_by       TEXT    NOT NULL,
  occurred_at      TEXT    NOT NULL,
  recorded_at      TEXT    NOT NULL,
  correlation_id   TEXT,
  causation_id     TEXT,
  contract_version TEXT    NOT NULL,
  event_json       TEXT    NOT NULL,
  previous_sha256  TEXT    NOT NULL,
  event_sha256     TEXT    NOT NULL UNIQUE
) STRICT;

CREATE INDEX control_plane_events_by_task
  ON control_plane_events (task_id, sequence);
CREATE INDEX control_plane_events_by_type
  ON control_plane_events (type, sequence);
CREATE INDEX control_plane_events_by_emitter
  ON control_plane_events (emitted_by, sequence);
CREATE INDEX control_plane_events_by_to_state
  ON control_plane_events (to_state, sequence);
CREATE INDEX control_plane_events_by_occurred_at
  ON control_plane_events (occurred_at, sequence);

CREATE TRIGGER control_plane_events_deny_update
BEFORE UPDATE ON control_plane_events
BEGIN
  SELECT RAISE(ABORT, 'control_plane_events is append-only: UPDATE is denied');
END;

CREATE TRIGGER control_plane_events_deny_delete
BEFORE DELETE ON control_plane_events
BEGIN
  SELECT RAISE(ABORT, 'control_plane_events is append-only: DELETE is denied');
END;
`,
  },
  {
    version: 2,
    name: "read_models",
    sql: `
CREATE TABLE task_read_model (
  task_id            TEXT    NOT NULL PRIMARY KEY,
  current_state      TEXT    NOT NULL,
  latest_attempt     INTEGER NOT NULL,
  event_count        INTEGER NOT NULL,
  first_sequence     INTEGER NOT NULL,
  last_sequence      INTEGER NOT NULL,
  last_event_id      TEXT    NOT NULL,
  last_event_type    TEXT    NOT NULL,
  last_transition_id TEXT    NOT NULL,
  last_emitted_by    TEXT    NOT NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  is_terminal        INTEGER NOT NULL CHECK (is_terminal IN (0, 1))
) STRICT;

CREATE INDEX task_read_model_by_state ON task_read_model (current_state, task_id);

CREATE TABLE worker_read_model (
  identity        TEXT    NOT NULL PRIMARY KEY,
  provider        TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  role            TEXT    NOT NULL,
  instance        TEXT    NOT NULL,
  event_count     INTEGER NOT NULL,
  task_count      INTEGER NOT NULL,
  first_sequence  INTEGER NOT NULL,
  last_sequence   INTEGER NOT NULL,
  first_seen_at   TEXT    NOT NULL,
  last_seen_at    TEXT    NOT NULL,
  last_task_id    TEXT    NOT NULL,
  last_event_type TEXT    NOT NULL
) STRICT;

CREATE INDEX worker_read_model_by_role ON worker_read_model (role, identity);
CREATE INDEX worker_read_model_by_provider ON worker_read_model (provider, identity);

CREATE TABLE worker_task_read_model (
  identity      TEXT    NOT NULL,
  task_id       TEXT    NOT NULL,
  event_count   INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  PRIMARY KEY (identity, task_id),
  FOREIGN KEY (identity) REFERENCES worker_read_model (identity) ON DELETE CASCADE
) STRICT;

CREATE INDEX worker_task_read_model_by_task ON worker_task_read_model (task_id, identity);
`,
  },
  {
    version: 3,
    name: "ledger_and_projection_meta",
    sql: `
CREATE TABLE ledger_meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO ledger_meta (key, value) VALUES
  ('head_sequence', '0'),
  ('head_event_sha256', '0000000000000000000000000000000000000000000000000000000000000000'),
  ('event_count', '0');

CREATE TABLE projection_meta (
  name                     TEXT    NOT NULL PRIMARY KEY,
  applied_through_sequence INTEGER NOT NULL,
  event_count              INTEGER NOT NULL,
  source_head_sha256       TEXT    NOT NULL,
  updated_at               TEXT    NOT NULL
) STRICT;

INSERT INTO projection_meta
  (name, applied_through_sequence, event_count, source_head_sha256, updated_at) VALUES
  ('task_read_model', 0, 0, '0000000000000000000000000000000000000000000000000000000000000000', '1970-01-01T00:00:00.000Z'),
  ('worker_read_model', 0, 0, '0000000000000000000000000000000000000000000000000000000000000000', '1970-01-01T00:00:00.000Z');
`,
  },
  {
    version: 4,
    name: "initiative_stream",
    sql: `
CREATE TABLE initiative_events (
  sequence         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT    NOT NULL UNIQUE,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  initiative_id    TEXT    NOT NULL,
  transition_id    TEXT    NOT NULL,
  type             TEXT    NOT NULL,
  from_status      TEXT,
  to_status        TEXT    NOT NULL,
  emitted_by       TEXT    NOT NULL,
  occurred_at      TEXT    NOT NULL,
  recorded_at      TEXT    NOT NULL,
  contract_version TEXT    NOT NULL,
  event_json       TEXT    NOT NULL,
  previous_sha256  TEXT    NOT NULL,
  event_sha256     TEXT    NOT NULL UNIQUE
) STRICT;

CREATE INDEX initiative_events_by_initiative
  ON initiative_events (initiative_id, sequence);
CREATE INDEX initiative_events_by_type
  ON initiative_events (type, sequence);
CREATE INDEX initiative_events_by_emitter
  ON initiative_events (emitted_by, sequence);
CREATE INDEX initiative_events_by_occurred_at
  ON initiative_events (occurred_at, sequence);

CREATE TRIGGER initiative_events_deny_update
BEFORE UPDATE ON initiative_events
BEGIN
  SELECT RAISE(ABORT, 'initiative_events is append-only: UPDATE is denied');
END;

CREATE TRIGGER initiative_events_deny_delete
BEFORE DELETE ON initiative_events
BEGIN
  SELECT RAISE(ABORT, 'initiative_events is append-only: DELETE is denied');
END;

CREATE TABLE initiative_read_model (
  initiative_id      TEXT    NOT NULL PRIMARY KEY,
  current_status     TEXT    NOT NULL,
  event_count        INTEGER NOT NULL,
  first_sequence     INTEGER NOT NULL,
  last_sequence      INTEGER NOT NULL,
  last_event_id      TEXT    NOT NULL,
  last_event_type    TEXT    NOT NULL,
  last_transition_id TEXT    NOT NULL,
  last_emitted_by    TEXT    NOT NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
) STRICT;

CREATE INDEX initiative_read_model_by_status
  ON initiative_read_model (current_status, initiative_id);

CREATE TABLE roadmap_version_read_model (
  roadmap_version_id TEXT    NOT NULL PRIMARY KEY,
  initiative_id      TEXT    NOT NULL,
  version            INTEGER NOT NULL,
  content_digest     TEXT    NOT NULL,
  parent_version_id  TEXT,
  kind               TEXT    NOT NULL,
  restores_version_id TEXT,
  recorded_by        TEXT    NOT NULL,
  recorded_at        TEXT    NOT NULL,
  sequence           INTEGER NOT NULL
) STRICT;

CREATE INDEX roadmap_version_read_model_by_initiative
  ON roadmap_version_read_model (initiative_id, version);

ALTER TABLE task_read_model ADD COLUMN initiative_id TEXT;

INSERT INTO ledger_meta (key, value) VALUES
  ('initiative_head_sequence', '0'),
  ('initiative_head_event_sha256', '0000000000000000000000000000000000000000000000000000000000000000'),
  ('initiative_event_count', '0');

INSERT INTO projection_meta
  (name, applied_through_sequence, event_count, source_head_sha256, updated_at) VALUES
  ('initiative_read_model', 0, 0, '0000000000000000000000000000000000000000000000000000000000000000', '1970-01-01T00:00:00.000Z'),
  ('roadmap_version_read_model', 0, 0, '0000000000000000000000000000000000000000000000000000000000000000', '1970-01-01T00:00:00.000Z');
`,
  },
  {
    version: 5,
    name: "account_events",
    sql: `
CREATE TABLE account_events (
  sequence         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT    NOT NULL UNIQUE,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  account_id       TEXT    NOT NULL,
  version          INTEGER NOT NULL,
  action           TEXT    NOT NULL,
  resulting_state  TEXT    NOT NULL,
  actor            TEXT    NOT NULL,
  note             TEXT,
  occurred_at      TEXT    NOT NULL,
  recorded_at      TEXT    NOT NULL,
  contract_version TEXT    NOT NULL,
  event_json       TEXT    NOT NULL
) STRICT;

CREATE INDEX account_events_by_account
  ON account_events (account_id, version);

CREATE TRIGGER account_events_deny_update
BEFORE UPDATE ON account_events
BEGIN
  SELECT RAISE(ABORT, 'account_events is append-only: UPDATE is denied');
END;

CREATE TRIGGER account_events_deny_delete
BEFORE DELETE ON account_events
BEGIN
  SELECT RAISE(ABORT, 'account_events is append-only: DELETE is denied');
END;
`,
  },
];

/** The migration set this build understands, with computed checksums. */
export const MIGRATIONS: readonly Migration[] = SOURCES.map((source) => ({
  version: source.version,
  name: source.name,
  sql: source.sql,
  sha256: sha256Hex(source.sql),
}));

/** Names of the derived tables a rebuild is allowed to clear. */
export const DERIVED_TABLES: readonly string[] = [
  "worker_task_read_model",
  "task_read_model",
  "worker_read_model",
  "initiative_read_model",
  "roadmap_version_read_model",
];

/** Projection names tracked in projection_meta, for the task stream. */
export const PROJECTION_NAMES: readonly string[] = ["task_read_model", "worker_read_model"];

/**
 * Projection names tracked in projection_meta, for the initiative stream.
 *
 * Kept separate from the task stream's names rather than merged into one list,
 * because each set follows its own chain: a projection's
 * `applied_through_sequence` and `source_head_sha256` only mean anything
 * against the head of the stream it was built from, and stamping an
 * initiative projection with the task head would make both unverifiable.
 */
export const INITIATIVE_PROJECTION_NAMES: readonly string[] = [
  "initiative_read_model",
  "roadmap_version_read_model",
];

export interface SchemaObject {
  readonly type: string;
  readonly name: string;
}

/**
 * Every schema object the applied migrations are expected to have created.
 *
 * The migration checksums prove what was applied. They cannot prove that the
 * schema was not altered afterwards: dropping the append-only triggers changes
 * nothing in schema_migrations, and neither integrity_check nor
 * foreign_key_check would notice. Without this list, the single most valuable
 * thing an attacker or a careless repair script could do to a ledger, namely
 * removing the triggers that make it append-only, would be invisible.
 *
 * Objects whose names begin with the reserved sqlite prefix are excluded,
 * because SQLite creates and removes those on its own.
 */
export const EXPECTED_SCHEMA_OBJECTS: readonly SchemaObject[] = [
  { type: "table", name: "schema_migrations" },
  { type: "table", name: "control_plane_events" },
  { type: "index", name: "control_plane_events_by_task" },
  { type: "index", name: "control_plane_events_by_type" },
  { type: "index", name: "control_plane_events_by_emitter" },
  { type: "index", name: "control_plane_events_by_to_state" },
  { type: "index", name: "control_plane_events_by_occurred_at" },
  { type: "trigger", name: "control_plane_events_deny_update" },
  { type: "trigger", name: "control_plane_events_deny_delete" },
  { type: "table", name: "task_read_model" },
  { type: "index", name: "task_read_model_by_state" },
  { type: "table", name: "worker_read_model" },
  { type: "index", name: "worker_read_model_by_role" },
  { type: "index", name: "worker_read_model_by_provider" },
  { type: "table", name: "worker_task_read_model" },
  { type: "index", name: "worker_task_read_model_by_task" },
  { type: "table", name: "ledger_meta" },
  { type: "table", name: "projection_meta" },
  { type: "table", name: "initiative_events" },
  { type: "index", name: "initiative_events_by_initiative" },
  { type: "index", name: "initiative_events_by_type" },
  { type: "index", name: "initiative_events_by_emitter" },
  { type: "index", name: "initiative_events_by_occurred_at" },
  { type: "trigger", name: "initiative_events_deny_update" },
  { type: "trigger", name: "initiative_events_deny_delete" },
  { type: "table", name: "initiative_read_model" },
  { type: "index", name: "initiative_read_model_by_status" },
  { type: "table", name: "roadmap_version_read_model" },
  { type: "index", name: "roadmap_version_read_model_by_initiative" },
  // P8-8G packet 2. The triggers are here for the same reason the other two
  // event streams have them: an operator-action log that could be updated or
  // deleted in place is not a log. The inventory is what caught their absence
  // — the first draft of this migration created the table without them, and
  // the integrity check refused the schema rather than letting a silently
  // mutable stream through.
  { type: "table", name: "account_events" },
  { type: "index", name: "account_events_by_account" },
  { type: "trigger", name: "account_events_deny_update" },
  { type: "trigger", name: "account_events_deny_delete" },
];

export interface MigrationConformance {
  /** Fatal in every mode: missing is recoverable, these are not. */
  readonly problems: readonly string[];
  /** Migrations this build defines that the database has not applied. */
  readonly missing: readonly Migration[];
}

interface MigrationRow {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
  readonly applied_at: string;
}

export function schemaMigrationsTableExists(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name = ?")
    .get("table", "schema_migrations");
  return row !== undefined;
}

export function readAppliedMigrations(db: Database.Database): AppliedMigration[] {
  const rows = db
    .prepare(
      "SELECT version, name, sha256, applied_at FROM schema_migrations ORDER BY version ASC",
    )
    .all() as MigrationRow[];
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    sha256: row.sha256,
    appliedAt: row.applied_at,
  }));
}

/**
 * Compare the applied migration set against this build, position by position.
 *
 * Missing, extra, reordered and checksum-mismatched are all distinguished,
 * because only one of them is recoverable. Everything is compared by position
 * as well as by version, so swapping two migrations is caught even though the
 * set of versions is unchanged.
 */
export function checkMigrationConformance(
  applied: readonly AppliedMigration[],
): MigrationConformance {
  const problems: string[] = [];

  const overlap = Math.min(applied.length, MIGRATIONS.length);
  for (let index = 0; index < overlap; index += 1) {
    const row = applied[index];
    const expected = MIGRATIONS[index];
    if (row === undefined || expected === undefined) continue;

    if (row.version !== expected.version) {
      problems.push(
        "position " +
          String(index) +
          " holds migration version " +
          String(row.version) +
          " but this build defines version " +
          String(expected.version) +
          " there",
      );
      continue;
    }
    if (row.name !== expected.name) {
      problems.push(
        "migration " +
          String(row.version) +
          " is applied as " +
          row.name +
          " but this build defines " +
          expected.name,
      );
      continue;
    }
    if (row.sha256 !== expected.sha256) {
      problems.push(
        "migration " +
          String(row.version) +
          " " +
          row.name +
          " was applied with checksum " +
          row.sha256 +
          " but this build computes " +
          expected.sha256,
      );
    }
  }

  for (let index = MIGRATIONS.length; index < applied.length; index += 1) {
    const row = applied[index];
    if (row === undefined) continue;
    problems.push(
      "migration " + String(row.version) + " " + row.name + " is applied but unknown to this build",
    );
  }

  // Only trust a missing tail when the applied prefix is exactly right.
  // Applying new migrations on top of a divergent history would compound the
  // divergence instead of surfacing it.
  const missing = problems.length > 0 ? [] : MIGRATIONS.slice(applied.length);
  return { problems, missing };
}

/**
 * Apply pending migrations and record them. The caller supplies the
 * transaction, so a failure halfway through leaves no partial schema.
 */
export function applyMigrations(
  db: Database.Database,
  pending: readonly Migration[],
  appliedAt: string,
): void {
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of pending) {
    db.exec(migration.sql);
    insert.run(migration.version, migration.name, migration.sha256, appliedAt);
  }
}
