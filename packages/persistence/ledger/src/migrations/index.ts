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
  {
    version: 6,
    name: "execution_route_read_model",
    sql: `
CREATE TABLE execution_route_read_model (
  task_id                   TEXT    NOT NULL,
  attempt                   INTEGER NOT NULL,
  provider                  TEXT    NOT NULL,
  model                     TEXT    NOT NULL,
  account_id                TEXT    NOT NULL,
  transport_kind            TEXT    NOT NULL,
  capability_policy_version TEXT    NOT NULL,
  resolved_at               TEXT    NOT NULL,
  recorded_at               TEXT    NOT NULL,
  sequence                  INTEGER NOT NULL,
  PRIMARY KEY (task_id, attempt)
) STRICT;

CREATE INDEX execution_route_read_model_by_policy_version
  ON execution_route_read_model (capability_policy_version, task_id, attempt);

CREATE INDEX execution_route_read_model_by_account
  ON execution_route_read_model (account_id, task_id, attempt);

-- Seeded from the ledger's CURRENT head, not from zero.
--
-- Every migration before this one created its projection alongside the stream
-- it folds, so a fresh row at sequence zero was level with a stream that was
-- also at zero. This projection is different: it arrives over a task stream
-- that may already hold thousands of events. The fold over all of them is
-- legitimately empty -- no event written before V2-B1c carries a route -- so
-- the projection IS current the moment the table exists, and its metadata must
-- say so. A row frozen at zero behind a non-zero head is precisely what
-- verifyIntegrity reports as corruption, which would make every ledger in the
-- field fail its own integrity check immediately after a routine upgrade.
--
-- On a fresh ledger the three subqueries read 0, 0 and the genesis digest, so
-- this is identical to a literal zero seed there.
INSERT INTO projection_meta
  (name, applied_through_sequence, event_count, source_head_sha256, updated_at)
SELECT
  'execution_route_read_model',
  CAST((SELECT value FROM ledger_meta WHERE key = 'head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'head_event_sha256'),
  '1970-01-01T00:00:00.000Z';
`,
  },
  {
    version: 7,
    name: "projection_watermark",
    sql: `
-- One row per (projection, source stream), replacing a table that could only
-- hold one row per projection.
--
-- projection_meta answered "how far is this projection?" with a single number,
-- which is only an answer while every projection folds exactly one stream. A
-- projection fed by two streams has two independent heads and no single number
-- describes it: stamping it with either one makes the other unverifiable. The
-- composite key is what makes the question well posed before there is a
-- projection that needs it.
--
-- projection_meta is not dropped and not rewritten. It stays exactly as this
-- migration found it, read by nothing and written by nothing: the migrations
-- that created it are applied and immutable by checksum, and a legacy table
-- left inert costs a page nobody reads.
--
-- The naming here follows §3.2 of the database contract, which governs from
-- migration 7 onward. Migrations 1 to 6 keep their own conventions forever.
CREATE TABLE projection_watermark (
  projection_name    TEXT    NOT NULL,
  source_stream      TEXT    NOT NULL,
  projector_version  INTEGER NOT NULL,
  applied_sequence   INTEGER NOT NULL,
  event_count        INTEGER NOT NULL,
  source_head_sha256 TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  CONSTRAINT pk_projection_watermark PRIMARY KEY (projection_name, source_stream),
  -- All four streams of the contract, not the two that carry a certified
  -- watermark today. A CHECK cannot be widened without rewriting the table, and
  -- rewriting an applied migration is the one thing this file forbids; which
  -- streams are actually published is a fact about the code's closed set, which
  -- can change without a migration.
  CONSTRAINT ck_projection_watermark__source_stream CHECK (
    source_stream IN (
      'control_plane_events',
      'initiative_events',
      'account_events',
      'registry_events'
    )
  ),
  CONSTRAINT ck_projection_watermark__projector_version CHECK (projector_version >= 1),
  CONSTRAINT ck_projection_watermark__applied_sequence CHECK (applied_sequence >= 0),
  CONSTRAINT ck_projection_watermark__event_count CHECK (event_count >= 0),
  CONSTRAINT ck_projection_watermark__source_head_sha256 CHECK (
    length(source_head_sha256) = 64 AND source_head_sha256 NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

-- Seeded from the heads this ledger CURRENTLY holds, per stream, exactly as
-- migration 6 seeded its own row and for the same reason: a row frozen at zero
-- behind a non-zero head is what verifyIntegrity reports as corruption, so a
-- literal zero seed would make every ledger in the field fail its own integrity
-- check immediately after a routine upgrade, with nothing wrong with it.
--
-- Each list is seeded from its OWN stream's meta keys. Seeding all five rows
-- from head_sequence would be the same defect wearing a composite key: the two
-- initiative projections would claim the task stream's position.
--
-- On a fresh ledger every subquery reads 0, 0 and the genesis digest, so this
-- is identical to a literal zero seed there.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  projection.name,
  'control_plane_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'head_event_sha256'),
  '1970-01-01T00:00:00.000Z'
FROM (
  SELECT 'task_read_model' AS name
  UNION ALL SELECT 'worker_read_model'
  UNION ALL SELECT 'execution_route_read_model'
) AS projection;

INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  projection.name,
  'initiative_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'initiative_head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'initiative_event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'initiative_head_event_sha256'),
  '1970-01-01T00:00:00.000Z'
FROM (
  SELECT 'initiative_read_model' AS name
  UNION ALL SELECT 'roadmap_version_read_model'
) AS projection;
`,
  },
  {
    version: 8,
    name: "causation_triplet",
    sql: `
-- Typed causality between streams, as three additive nullable columns.
--
-- Two sequences from two streams are not comparable, so "this happened because
-- of that" cannot be expressed by ordering. The contract expresses it as a
-- triple -- which stream, which position in it, and the digest of the event
-- found there -- and the digest is what makes the reference verifiable rather
-- than decorative: a reference whose digest does not match the row it names is
-- an INVALID reference, not a weak one.
--
-- Additive, and only additive. The legacy \`correlation_id\` and \`causation_id\`
-- columns stay exactly where they are and keep meaning exactly what they meant:
-- free text, advisory, read by the telemetry edge. Nothing is retired here.
--
-- The triple is deliberately OUTSIDE the hash chain. \`event_sha256\` is computed
-- over the canonical event body alone, and it cannot be widened to cover these
-- columns without rehashing every event ever written. What protects a triple
-- already on disk is therefore physical, not cryptographic: the append-only
-- triggers refuse any UPDATE or DELETE, and the trigger below refuses a bad one
-- at the door. That is worth stating plainly rather than leaving a reader to
-- infer a guarantee this migration does not provide.
--
-- Only the two streams that carry a chain take part. The account stream has no
-- \`event_sha256\` at all (migration 5 is immutable, and the sidecar that would
-- supply one is a later packet), and the registry stream does not exist yet, so
-- neither can be referenced verifiably. Neither is named anywhere in this
-- migration, in a comment or otherwise, and the suite asserts that literally.
-- Widening the vocabulary belongs to the packets that give those streams a
-- digest, by another migration, by name.

ALTER TABLE control_plane_events
  ADD COLUMN causation_stream TEXT;
ALTER TABLE control_plane_events
  ADD COLUMN causation_sequence INTEGER;
ALTER TABLE control_plane_events
  ADD COLUMN causation_sha256 TEXT;

ALTER TABLE initiative_events
  ADD COLUMN causation_stream TEXT;
ALTER TABLE initiative_events
  ADD COLUMN causation_sequence INTEGER;
ALTER TABLE initiative_events
  ADD COLUMN causation_sha256 TEXT;

-- A trigger, because SQLite cannot add a CHECK to a table that already exists.
--
-- The contract writes these rules as \`ck_<table>__causation_pair\` and as the
-- 64-hex shape of §0. Neither can be added by ALTER TABLE, and rewriting an
-- applied migration is the one thing this file forbids, so the rules are
-- imposed forward on every NEW row instead. Rows written before this migration
-- are neither validated nor corrected: they were written under the law of their
-- day, and a trigger that claimed otherwise would be claiming to have checked
-- something it never saw.
--
-- The last two branches of each trigger resolve the reference against the
-- stream it names. They are safe inside a multi-row transaction: rows are
-- inserted one at a time, so an event referring to one inserted moments earlier
-- in the same transaction already sees it.
--
-- Every branch is written so that a NULL \`causation_stream\` yields NULL rather
-- than true, which is why an event with no recorded cause passes all of them.
CREATE TRIGGER tr_control_plane_events__validate_new_rows
BEFORE INSERT ON control_plane_events
BEGIN
  SELECT RAISE(ABORT, 'control_plane_events.event_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.event_sha256) <> 64 OR NEW.event_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'control_plane_events.previous_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.previous_sha256) <> 64 OR NEW.previous_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'control_plane_events causal reference is all three columns or none')
  WHERE (NEW.causation_stream IS NULL) <> (NEW.causation_sequence IS NULL)
     OR (NEW.causation_stream IS NULL) <> (NEW.causation_sha256 IS NULL);

  SELECT RAISE(ABORT, 'control_plane_events.causation_sha256 is not 64 lowercase hex characters')
  WHERE NEW.causation_sha256 IS NOT NULL
    AND (length(NEW.causation_sha256) <> 64 OR NEW.causation_sha256 GLOB '*[^0-9a-f]*');

  SELECT RAISE(ABORT, 'control_plane_events causal reference names a stream with no verifiable digest')
  WHERE NEW.causation_stream IS NOT NULL
    AND NEW.causation_stream NOT IN ('control_plane_events', 'initiative_events');

  SELECT RAISE(ABORT, 'control_plane_events causal reference needs a positive position')
  WHERE NEW.causation_sequence IS NOT NULL AND NEW.causation_sequence < 1;

  SELECT RAISE(ABORT, 'control_plane_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'control_plane_events'
    AND NOT EXISTS (
      SELECT 1 FROM control_plane_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'control_plane_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'initiative_events'
    AND NOT EXISTS (
      SELECT 1 FROM initiative_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );
END;

CREATE TRIGGER tr_initiative_events__validate_new_rows
BEFORE INSERT ON initiative_events
BEGIN
  SELECT RAISE(ABORT, 'initiative_events.event_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.event_sha256) <> 64 OR NEW.event_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'initiative_events.previous_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.previous_sha256) <> 64 OR NEW.previous_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'initiative_events causal reference is all three columns or none')
  WHERE (NEW.causation_stream IS NULL) <> (NEW.causation_sequence IS NULL)
     OR (NEW.causation_stream IS NULL) <> (NEW.causation_sha256 IS NULL);

  SELECT RAISE(ABORT, 'initiative_events.causation_sha256 is not 64 lowercase hex characters')
  WHERE NEW.causation_sha256 IS NOT NULL
    AND (length(NEW.causation_sha256) <> 64 OR NEW.causation_sha256 GLOB '*[^0-9a-f]*');

  SELECT RAISE(ABORT, 'initiative_events causal reference names a stream with no verifiable digest')
  WHERE NEW.causation_stream IS NOT NULL
    AND NEW.causation_stream NOT IN ('control_plane_events', 'initiative_events');

  SELECT RAISE(ABORT, 'initiative_events causal reference needs a positive position')
  WHERE NEW.causation_sequence IS NOT NULL AND NEW.causation_sequence < 1;

  SELECT RAISE(ABORT, 'initiative_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'control_plane_events'
    AND NOT EXISTS (
      SELECT 1 FROM control_plane_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'initiative_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'initiative_events'
    AND NOT EXISTS (
      SELECT 1 FROM initiative_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );
END;
`,
  },
  {
    version: 9,
    name: "registry_stream",
    sql: `
-- The registry stream, and the first projection fed by two of them.
--
-- \`registry_events\` is a new stream, so unlike the two that came before it, it
-- implements the contract's common field profile COMPLETELY from its first
-- migration. The digest shapes and the causal triple are CHECK constraints in
-- the DDL rather than rules imposed forward by a trigger: a trigger is what a
-- table that already exists is stuck with, and this one does not exist yet.
--
-- Its subject is a versioned configuration document. This is STORAGE. It does
-- not decide eligibility, does not score models and does not set prices: the
-- semantics of each \`document_kind\` belong to planning, accounts and economy,
-- and this table persists versions with a digest, an author and a validity
-- instant. Nothing in this migration or in the code above it validates a
-- \`model_version_id\` against anything.
CREATE TABLE registry_events (
  sequence                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id                TEXT    NOT NULL UNIQUE,
  idempotency_key         TEXT    NOT NULL UNIQUE,
  document_kind           TEXT    NOT NULL,
  document_id             TEXT    NOT NULL,
  document_version        INTEGER NOT NULL,
  content_digest          TEXT    NOT NULL,
  parent_document_version INTEGER,
  recorded_by             TEXT    NOT NULL,
  effective_from          TEXT    NOT NULL,
  occurred_at             TEXT    NOT NULL,
  recorded_at             TEXT    NOT NULL,
  causation_stream        TEXT,
  causation_sequence      INTEGER,
  causation_sha256        TEXT,
  contract_version        TEXT    NOT NULL,
  event_json              TEXT    NOT NULL,
  previous_sha256         TEXT    NOT NULL,
  event_sha256            TEXT    NOT NULL UNIQUE,
  -- The closed vocabulary of the contract, fourteen names. A CHECK cannot be
  -- widened without rewriting the table, so a fifteenth kind is a migration
  -- and a decision, never a value that slips in.
  CONSTRAINT ck_registry_events__document_kind CHECK (
    document_kind IN (
      'CAPABILITY_POLICY',
      'MODEL_VERSION',
      'PRICE_TABLE',
      'MODEL_PERFORMANCE',
      'ROUTING_ASSIGNMENT_GLOBAL',
      'ESTIMATION_POLICY',
      'INTEGRATION_PROFILE',
      'INTEGRATION_INSTALLATION',
      'COMPOSITION_POLICY',
      'COMPOSITION_EVIDENCE',
      'NOTIFICATION_POLICY',
      'APPROVAL_WAIT_POLICY',
      'DUEL_POLICY',
      'ANOMALY_POLICY'
    )
  ),
  CONSTRAINT ck_registry_events__document_version CHECK (document_version >= 1),
  -- A parent shares the document_id and precedes this version. NULL is the
  -- first version of a document, and is the only way to be a first version.
  CONSTRAINT ck_registry_events__parent_document_version CHECK (
    parent_document_version IS NULL
      OR (parent_document_version >= 1 AND parent_document_version < document_version)
  ),
  CONSTRAINT ck_registry_events__content_digest CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ck_registry_events__causation_pair CHECK (
    (causation_stream IS NULL) = (causation_sequence IS NULL)
      AND (causation_stream IS NULL) = (causation_sha256 IS NULL)
  ),
  CONSTRAINT ck_registry_events__causation_sequence CHECK (
    causation_sequence IS NULL OR causation_sequence >= 1
  ),
  CONSTRAINT ck_registry_events__causation_sha256 CHECK (
    causation_sha256 IS NULL
      OR (length(causation_sha256) = 64 AND causation_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  CONSTRAINT ck_registry_events__previous_sha256 CHECK (
    length(previous_sha256) = 64 AND previous_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ck_registry_events__event_sha256 CHECK (
    length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

-- Version identity. Deliberately (document_id, document_version) and not
-- (document_kind, document_version): two different documents of the same class
-- are legitimate, and keying on the class would make the second one a conflict.
CREATE UNIQUE INDEX ux_registry_events__document_id__document_version
  ON registry_events (document_id, document_version);

CREATE INDEX ix_registry_events__document_kind__document_id__document_version
  ON registry_events (document_kind, document_id, document_version);

CREATE INDEX ix_registry_events__document_id__effective_from
  ON registry_events (document_id, effective_from);

-- The append-only pair, under the §3.2 naming convention rather than the
-- legacy \`<table>_deny_*\` the first three streams carry. Those names are
-- frozen in applied migrations and stay exactly as they are; a stream created
-- from migration 7 onward follows the convention that governs from there, so
-- the third stream does not inherit a shape it never had to.
CREATE TRIGGER tr_registry_events__deny_update
BEFORE UPDATE ON registry_events
BEGIN
  SELECT RAISE(ABORT, 'registry_events is append-only: UPDATE is denied');
END;

CREATE TRIGGER tr_registry_events__deny_delete
BEFORE DELETE ON registry_events
BEGIN
  SELECT RAISE(ABORT, 'registry_events is append-only: DELETE is denied');
END;

-- What a CHECK cannot do: resolve the reference against the row it names.
--
-- SQLite does not allow a subquery in a CHECK, so the static rules above are
-- constraints and the resolution is a trigger. That is one more trigger than
-- the contract enumerates for this stream, declared here rather than smuggled:
-- the alternative was to leave the resolution to the code above, and the
-- packet that just closed that gap for the other two streams would have opened
-- it again for the third.
CREATE TRIGGER tr_registry_events__validate_new_rows
BEFORE INSERT ON registry_events
BEGIN
  SELECT RAISE(ABORT, 'registry_events causal reference names a stream with no verifiable digest')
  WHERE NEW.causation_stream IS NOT NULL
    AND NEW.causation_stream NOT IN ('control_plane_events', 'initiative_events', 'registry_events');

  SELECT RAISE(ABORT, 'registry_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'control_plane_events'
    AND NOT EXISTS (
      SELECT 1 FROM control_plane_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'registry_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'initiative_events'
    AND NOT EXISTS (
      SELECT 1 FROM initiative_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'registry_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'registry_events'
    AND NOT EXISTS (
      SELECT 1 FROM registry_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );
END;

-- The causal vocabulary widens to three, here, and only here.
--
-- Migration 8 is applied and immutable by checksum, so its two triggers cannot
-- be edited to admit a third stream; they are dropped and recreated under the
-- same names instead, AFTER \`registry_events\` exists a few lines above. That
-- order is not a style choice: SQLite compiles a trigger body when it prepares
-- an INSERT on the guarded table, so a branch naming a table that does not
-- exist breaks every append rather than lying dormant. It is exactly why
-- migration 8 could not name this stream and why this migration can.
--
-- The recreated bodies are migration 8's, with one name added to the
-- vocabulary and one resolution branch added to the end. The account stream is
-- still absent and still refused, and is not named here in a comment or
-- otherwise: migration 5 gives it neither \`previous_sha256\` nor
-- \`event_sha256\`, so a reference to it could be believed but never checked,
-- and completing the list to four while the trigger was open would be the
-- easiest way to reintroduce the weak link the triple exists to rule out.
DROP TRIGGER tr_control_plane_events__validate_new_rows;
DROP TRIGGER tr_initiative_events__validate_new_rows;

CREATE TRIGGER tr_control_plane_events__validate_new_rows
BEFORE INSERT ON control_plane_events
BEGIN
  SELECT RAISE(ABORT, 'control_plane_events.event_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.event_sha256) <> 64 OR NEW.event_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'control_plane_events.previous_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.previous_sha256) <> 64 OR NEW.previous_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'control_plane_events causal reference is all three columns or none')
  WHERE (NEW.causation_stream IS NULL) <> (NEW.causation_sequence IS NULL)
     OR (NEW.causation_stream IS NULL) <> (NEW.causation_sha256 IS NULL);

  SELECT RAISE(ABORT, 'control_plane_events.causation_sha256 is not 64 lowercase hex characters')
  WHERE NEW.causation_sha256 IS NOT NULL
    AND (length(NEW.causation_sha256) <> 64 OR NEW.causation_sha256 GLOB '*[^0-9a-f]*');

  SELECT RAISE(ABORT, 'control_plane_events causal reference names a stream with no verifiable digest')
  WHERE NEW.causation_stream IS NOT NULL
    AND NEW.causation_stream NOT IN ('control_plane_events', 'initiative_events', 'registry_events');

  SELECT RAISE(ABORT, 'control_plane_events causal reference needs a positive position')
  WHERE NEW.causation_sequence IS NOT NULL AND NEW.causation_sequence < 1;

  SELECT RAISE(ABORT, 'control_plane_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'control_plane_events'
    AND NOT EXISTS (
      SELECT 1 FROM control_plane_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'control_plane_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'initiative_events'
    AND NOT EXISTS (
      SELECT 1 FROM initiative_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'control_plane_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'registry_events'
    AND NOT EXISTS (
      SELECT 1 FROM registry_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );
END;

CREATE TRIGGER tr_initiative_events__validate_new_rows
BEFORE INSERT ON initiative_events
BEGIN
  SELECT RAISE(ABORT, 'initiative_events.event_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.event_sha256) <> 64 OR NEW.event_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'initiative_events.previous_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.previous_sha256) <> 64 OR NEW.previous_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'initiative_events causal reference is all three columns or none')
  WHERE (NEW.causation_stream IS NULL) <> (NEW.causation_sequence IS NULL)
     OR (NEW.causation_stream IS NULL) <> (NEW.causation_sha256 IS NULL);

  SELECT RAISE(ABORT, 'initiative_events.causation_sha256 is not 64 lowercase hex characters')
  WHERE NEW.causation_sha256 IS NOT NULL
    AND (length(NEW.causation_sha256) <> 64 OR NEW.causation_sha256 GLOB '*[^0-9a-f]*');

  SELECT RAISE(ABORT, 'initiative_events causal reference names a stream with no verifiable digest')
  WHERE NEW.causation_stream IS NOT NULL
    AND NEW.causation_stream NOT IN ('control_plane_events', 'initiative_events', 'registry_events');

  SELECT RAISE(ABORT, 'initiative_events causal reference needs a positive position')
  WHERE NEW.causation_sequence IS NOT NULL AND NEW.causation_sequence < 1;

  SELECT RAISE(ABORT, 'initiative_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'control_plane_events'
    AND NOT EXISTS (
      SELECT 1 FROM control_plane_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'initiative_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'initiative_events'
    AND NOT EXISTS (
      SELECT 1 FROM initiative_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'initiative_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'registry_events'
    AND NOT EXISTS (
      SELECT 1 FROM registry_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );
END;

-- The first read model fed by two streams.
--
-- Its GLOBAL partition is folded from \`registry_events\`; its INITIATIVE and
-- STEP partitions from \`initiative_events\`. Read precedence is
-- STEP > INITIATIVE > GLOBAL, resolved against a VECTOR of watermarks, never
-- against "the latest" of a single stream, because two streams' sequences are
-- not comparable and \`sequence\` below is an application order rather than a
-- shared clock.
--
-- The INITIATIVE and STEP partitions are EMPTY in this build, and empty by
-- construction rather than by omission: the event type that fills them,
-- \`ROUTING_ASSIGNMENT_RECORDED\`, is not in the initiative contract's closed
-- vocabulary, and widening a contract that lives in another package is another
-- packet's. The fold over that stream is total and returns no row for every
-- type that does exist. What this migration establishes is the mechanism —
-- two independent heads under one projection name.
CREATE TABLE routing_assignment_read_model (
  assignment_id    TEXT    NOT NULL PRIMARY KEY,
  scope_kind       TEXT    NOT NULL,
  scope_id         TEXT,
  version          INTEGER NOT NULL,
  role             TEXT    NOT NULL,
  slot             INTEGER NOT NULL,
  provider         TEXT    NOT NULL,
  model_version_id TEXT    NOT NULL,
  recorded_by      TEXT    NOT NULL,
  recorded_at      TEXT    NOT NULL,
  superseded_by    TEXT,
  source_stream    TEXT    NOT NULL,
  source_sequence  INTEGER NOT NULL,
  sequence         INTEGER NOT NULL,
  CONSTRAINT ck_routing_assignment_read_model__scope_kind CHECK (
    scope_kind IN ('GLOBAL', 'INITIATIVE', 'STEP')
  ),
  CONSTRAINT ck_routing_assignment_read_model__scope_id_required CHECK (
    (scope_kind = 'GLOBAL') = (scope_id IS NULL)
  ),
  CONSTRAINT ck_routing_assignment_read_model__version CHECK (version >= 1),
  CONSTRAINT ck_routing_assignment_read_model__role CHECK (
    role IN ('coordinator', 'implementer', 'reviewer', 'consultant', 'verifier')
  ),
  CONSTRAINT ck_routing_assignment_read_model__slot CHECK (slot >= 0),
  -- The partition rule, in the base rather than only in the fold: a row from
  -- the registry stream is GLOBAL and a row from the initiative stream is not.
  -- Neither stream can write into the other's partition.
  CONSTRAINT ck_routing_assignment_read_model__source_scope CHECK (
    (source_stream = 'registry_events' AND scope_kind = 'GLOBAL')
      OR (source_stream = 'initiative_events' AND scope_kind IN ('INITIATIVE', 'STEP'))
  ),
  CONSTRAINT ck_routing_assignment_read_model__source_sequence CHECK (source_sequence >= 1)
) STRICT;

-- Partial, both of them. A UNIQUE index over a nullable column does not
-- enforce uniqueness by itself: two GLOBAL rows both carry scope_id NULL, and
-- SQLite treats distinct NULLs as distinct, so one index over the five columns
-- would silently admit the duplicate it was written to refuse.
CREATE UNIQUE INDEX ux_routing_assignment_read_model__global
  ON routing_assignment_read_model (role, slot, version)
  WHERE scope_kind = 'GLOBAL';

CREATE UNIQUE INDEX ux_routing_assignment_read_model__scoped
  ON routing_assignment_read_model (scope_kind, scope_id, role, slot, version)
  WHERE scope_kind <> 'GLOBAL';

CREATE INDEX ix_routing_assignment_read_model__resolution
  ON routing_assignment_read_model (scope_kind, scope_id, role, slot, superseded_by);

-- Rows, not a JSON column. §3.5 of the database contract forbids a JSON list
-- of fallbacks in a column of the assignment: an ordered list that has to be
-- parsed to be read is not a relation, and the ordinal is the order of attempt.
CREATE TABLE routing_assignment_fallback (
  assignment_id    TEXT    NOT NULL,
  ordinal          INTEGER NOT NULL,
  model_version_id TEXT    NOT NULL,
  CONSTRAINT pk_routing_assignment_fallback PRIMARY KEY (assignment_id, ordinal),
  CONSTRAINT ck_routing_assignment_fallback__ordinal CHECK (ordinal >= 0),
  CONSTRAINT fk_routing_assignment_fallback__routing_assignment_read_model
    FOREIGN KEY (assignment_id) REFERENCES routing_assignment_read_model (assignment_id)
    ON DELETE CASCADE
) STRICT;

INSERT INTO ledger_meta (key, value) VALUES
  ('registry_head_sequence', '0'),
  ('registry_head_event_sha256', '0000000000000000000000000000000000000000000000000000000000000000'),
  ('registry_event_count', '0');

-- Two watermark rows under one projection name, seeded from two different
-- arguments, and the difference is the whole point of writing them separately.
--
-- The registry row may honestly be zero: the stream is born empty in this same
-- migration, so a projection at zero IS level with it. This is not the defect
-- migration 6 and migration 7 both carry a comment about — a row frozen at
-- zero behind a NON-ZERO head — because there is no history here to be behind.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
VALUES (
  'routing_assignment_read_model',
  'registry_events',
  1,
  0,
  0,
  '0000000000000000000000000000000000000000000000000000000000000000',
  '1970-01-01T00:00:00.000Z'
);

-- The initiative row may NOT be zero, and for exactly the reason migration 6
-- states: this projection arrives over a stream that may already hold events.
-- The fold over all of them is legitimately empty — no initiative event type
-- carries a routing assignment — so the projection IS current the moment the
-- table exists, and its metadata must say so. A literal zero here would make
-- every ledger in the field fail its own integrity check immediately after a
-- routine upgrade, with nothing wrong with it.
--
-- On a fresh ledger the three subqueries read 0, 0 and the genesis digest, so
-- this is identical to a literal zero seed there.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  'routing_assignment_read_model',
  'initiative_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'initiative_head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'initiative_event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'initiative_head_event_sha256'),
  '1970-01-01T00:00:00.000Z';
`,
  },
  {
    version: 10,
    name: "account_event_integrity",
    sql: `
-- A hash chain for the account stream, beside it rather than inside it.
--
-- \`account_events\` shipped in migration 5 with no \`previous_sha256\` and no
-- \`event_sha256\`, and an applied migration is never rewritten, so the chain
-- cannot be added to the stream. It arrives as a sidecar: one row per row of
-- the stream, from sequence 1, keyed by and foreign-keyed to it.
--
-- **What this proves and what it does not.** The sidecar covers the historical
-- bytes 1..H exactly as they stood when it was activated, and detects any
-- change after that. It does NOT prove those rows were authentic before that
-- moment: nobody hashed them when they were written, so a change made earlier
-- is not excluded. Those are two different facts and no text in this system
-- may present them as one.
--
-- The FK is \`ON DELETE RESTRICT\` rather than \`CASCADE\` on purpose. The two
-- tables are one reconstruction cohort — they live and die together in the
-- same physical file — and a cascade would let a delete on the stream silently
-- take the evidence with it. The stream has no delete path at all, so the
-- restriction is belt and braces over a trigger that already refuses.
CREATE TABLE account_event_integrity (
  account_sequence INTEGER NOT NULL,
  previous_sha256  TEXT    NOT NULL,
  event_sha256     TEXT    NOT NULL,
  computed_at      TEXT    NOT NULL,
  CONSTRAINT pk_account_event_integrity PRIMARY KEY (account_sequence),
  CONSTRAINT fk_account_event_integrity__account_events
    FOREIGN KEY (account_sequence) REFERENCES account_events (sequence)
    ON DELETE RESTRICT,
  CONSTRAINT ck_account_event_integrity__account_sequence CHECK (account_sequence >= 1),
  CONSTRAINT ck_account_event_integrity__previous_sha256 CHECK (
    length(previous_sha256) = 64 AND previous_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ck_account_event_integrity__event_sha256 CHECK (
    length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

CREATE UNIQUE INDEX ux_account_event_integrity__event_sha256
  ON account_event_integrity (event_sha256);

-- The sidecar is append-only like a stream, though it is not one of the four
-- business streams. Evidence that could be updated in place is not evidence.
-- Named by the §3.2 convention, which governs from migration 7 onward; the
-- legacy \`<table>_deny_*\` names of migrations 1, 4 and 5 are frozen inside
-- applied migrations and are not inherited by a table created after them.
CREATE TRIGGER tr_account_event_integrity__deny_update
BEFORE UPDATE ON account_event_integrity
BEGIN
  SELECT RAISE(ABORT, 'account_event_integrity is append-only: UPDATE is denied');
END;

CREATE TRIGGER tr_account_event_integrity__deny_delete
BEFORE DELETE ON account_event_integrity
BEGIN
  SELECT RAISE(ABORT, 'account_event_integrity is append-only: DELETE is denied');
END;

-- The uniqueness migration 5 did not impose.
--
-- \`account_events_by_account\` is an ordinary index, so two rows could share an
-- (account_id, version) as long as their idempotency keys differed. In practice
-- the contract derives the key FROM those two fields, so the existing
-- \`UNIQUE(idempotency_key)\` has been refusing the duplicate all along — but
-- through a derivation at the door rather than through a constraint in the
-- base, and a rule nobody can see in the schema is a rule a raw writer does not
-- meet. The preflight that precedes this statement counts existing violations
-- and names them rather than letting this CREATE fail with a count.
CREATE UNIQUE INDEX ux_account_events__account_id__version
  ON account_events (account_id, version);
`,
  },
  {
    version: 11,
    name: "task_revision_identity",
    sql: `
-- The revision coordinate, on a stream whose first migration cannot be rewritten.
--
-- Migration 1 is immutable and \`attempt\` is \`NOT NULL\`, so a task with
-- revisions and attempts does not fit the flat integer it already has — and
-- every new row still has to populate it. Streams §1.1 settles it: two additive
-- columns, \`NULL\` **only** on legacy rows, agreeing with the \`event_json\`
-- wherever they are present.
--
-- **The "migrated but not populated" window is real and lawful here**, unlike
-- the account sidecar's activation. Nothing in this migration writes a
-- coordinate: rows written before it keep both columns \`NULL\` for ever, and a
-- ledger that has applied 11 and holds no V2 row at all is a correct ledger, not
-- a half-applied one. That is the opposite of migration 10, where the migration
-- itself performed the activation and absence was therefore tampering.
--
-- **No new event type.** The coordinate travels as payload keys on the stream
-- that already exists (streams §1.1: the columns "coinciden con el valor del
-- event_json", and "No son eventos nuevos de composición"), so
-- \`CONTROL_PLANE_EVENT_TYPES\` does not move and neither does the channel map.
-- The contract version does not move either: this migration records no event,
-- and the cohort is told apart by \`revision_number IS NOT NULL\` rather than by
-- a version literal. The first V2 producer moves it, together with the
-- supported-versions mechanism a reader needs — ADR 0067.
ALTER TABLE control_plane_events ADD COLUMN revision_number INTEGER;
ALTER TABLE control_plane_events ADD COLUMN attempt_number INTEGER;

-- The pairing rule, in both directions.
--
-- Forward: the two columns are both absent or both present, positive, and equal
-- to what the payload says. Backward: a payload that carries the V2 keys may not
-- arrive with the columns empty or disagreeing. Without the second direction a
-- writer could record the coordinate in the body and leave the columns \`NULL\`,
-- and the row would read as legacy for ever while its own event said otherwise.
CREATE TRIGGER tr_control_plane_events__validate_v2_coordinate
BEFORE INSERT ON control_plane_events
BEGIN
  SELECT RAISE(ABORT, 'control_plane_events V2 coordinate is both columns or neither')
  WHERE (NEW.revision_number IS NULL) <> (NEW.attempt_number IS NULL);

  SELECT RAISE(ABORT, 'control_plane_events.revision_number must be a positive count')
  WHERE NEW.revision_number IS NOT NULL AND NEW.revision_number < 1;

  SELECT RAISE(ABORT, 'control_plane_events.attempt_number must be a positive count')
  WHERE NEW.attempt_number IS NOT NULL AND NEW.attempt_number < 1;

  -- The legacy coordinate is still written on a V2 row: it carries the flat
  -- \`legacy_attempt_number\` its coordinate was assigned. A V2 row that left it
  -- empty would be unreachable by every query written before this migration.
  SELECT RAISE(ABORT, 'control_plane_events.attempt must stay populated on a V2 row')
  WHERE NEW.attempt IS NULL OR NEW.attempt < 1;

  SELECT RAISE(ABORT, 'control_plane_events.revision_number disagrees with its own event_json')
  WHERE NEW.revision_number IS NOT NULL
    AND NEW.revision_number IS NOT json_extract(NEW.event_json, '$.payload.revisionNumber');

  SELECT RAISE(ABORT, 'control_plane_events.attempt_number disagrees with its own event_json')
  WHERE NEW.attempt_number IS NOT NULL
    AND NEW.attempt_number IS NOT json_extract(NEW.event_json, '$.payload.attemptNumber');

  SELECT RAISE(ABORT, 'control_plane_events event_json carries a V2 coordinate the columns do not')
  WHERE NEW.revision_number IS NULL
    AND (json_extract(NEW.event_json, '$.payload.revisionNumber') IS NOT NULL
      OR json_extract(NEW.event_json, '$.payload.attemptNumber') IS NOT NULL);
END;

-- The revision, as its own record (execution §2).
--
-- \`(task_id, revision_number)\` is the coordinate; \`revision_id\` is the stable
-- global handle for referring to a revision without carrying the pair.
--
-- **There is deliberately no \`UNIQUE(task_id, envelope_sha256)\`** (§7.3):
-- restoring an earlier envelope is a NEW revision with the SAME digest, and
-- that uniqueness would forbid exactly the case the model exists to allow. The
-- index below answers "which revisions share this envelope" and is not unique.
--
-- \`envelope_artifact_reference_id\` is **absent on purpose**, not forgotten:
-- the artifact plane is P-36/local, the column is \`NOT NULL\` in the target
-- dictionary, and a \`NOT NULL\` column cannot be populated without the plane
-- that mints the reference. Decision 41 records it; P-36/local adds the column
-- with a cohort trigger. Nothing here ever derives a reference from a digest.
CREATE TABLE task_revision_read_model (
  task_id                   TEXT    NOT NULL,
  revision_number           INTEGER NOT NULL,
  revision_id               TEXT    NOT NULL,
  envelope_sha256           TEXT    NOT NULL,
  restored_from_revision_id TEXT,
  created_at                TEXT    NOT NULL,
  created_by                TEXT    NOT NULL,
  contract_version          TEXT    NOT NULL,
  sequence                  INTEGER NOT NULL,
  CONSTRAINT pk_task_revision_read_model PRIMARY KEY (task_id, revision_number),
  CONSTRAINT ck_task_revision_read_model__revision_number CHECK (revision_number >= 1)
) STRICT;

CREATE UNIQUE INDEX ux_task_revision_read_model__revision_id
  ON task_revision_read_model (revision_id);

-- Not unique, and that is the point: the restore case above shares a digest.
CREATE INDEX ix_task_revision_read_model__envelope_sha256
  ON task_revision_read_model (envelope_sha256, task_id, revision_number);

-- The task projection learns to carry what the revision says.
--
-- Every column is additive and \`NULL\`-able, because an applied migration
-- admits no \`DROP COLUMN\` and rows written before this one legitimately have
-- no answer. The three below have a producer in this packet: the revision fold
-- derives them from the record it just wrote.
ALTER TABLE task_read_model ADD COLUMN envelope_sha256 TEXT;
ALTER TABLE task_read_model ADD COLUMN latest_revision_number INTEGER;
ALTER TABLE task_read_model ADD COLUMN latest_attempt_number INTEGER;

-- These three have NO producer today, and the nullity is documented rather
-- than accidental (execution §1 authorizes exactly this). They are created now
-- so the shape of the table stops drifting from the dictionary one packet at a
-- time; nobody invents a payload key to fill them, and a reader must treat
-- \`NULL\` here as "not recorded yet" rather than as "absent".
ALTER TABLE task_read_model ADD COLUMN role TEXT;
ALTER TABLE task_read_model ADD COLUMN step_id TEXT;
ALTER TABLE task_read_model ADD COLUMN commit_policy TEXT;

-- The watermark, seeded from the head this stream already has.
--
-- This is migration 9's second case, not its first: the projection arrives over
-- \`control_plane_events\`, which may already hold a long history, and the fold
-- over all of it is legitimately empty because no legacy row carries a V2
-- coordinate. So the projection IS level with the stream the moment the table
-- exists, and its metadata must say so. A literal zero would make every ledger
-- in the field fail its own integrity check immediately after a routine
-- upgrade, with nothing whatsoever wrong with it.
--
-- On a fresh ledger the three subqueries read 0, 0 and the genesis digest, so
-- this is identical to a literal zero seed there.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  'task_revision_read_model',
  'control_plane_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'head_event_sha256'),
  '1970-01-01T00:00:00.000Z';
`,
  },
  {
    version: 12,
    name: "task_attempt_identity",
    sql: `
-- The attempt, as its own record (execution §3, P-18/protocolo B).
--
-- The third rung of the identity ladder. \`task_id\` is stable for life;
-- \`(task_id, revision_number)\` is a unit of work; \`(task_id,
-- revision_number, attempt_number)\` is one try at it. \`attempt_number\`
-- restarts at 1 in each new revision and cannot collide with a restore,
-- because the coordinate carries the revision.
--
-- **Two numbers, and only one of them is a counter.** \`attempt_number\` is
-- the coordinate's third component. \`legacy_attempt_number\` is the flat
-- integer migration 1's \`attempt\` column has always demanded: a value
-- monotone **per task**, assigned once, stable for this coordinate for ever,
-- and equal to \`control_plane_events.attempt\` on every event of the
-- coordinate. It is not a per-revision counter and not a second authority —
-- streams §1.1 settles that, and the compare-and-set in \`@acp/ledger\` is
-- what holds it.
--
-- **The foreign key is on the revision, and the order below is load-bearing.**
-- \`foreign_keys\` is ON, so this table is created after
-- \`task_revision_read_model\` and must be cleared BEFORE it on a rebuild:
-- \`DERIVED_TABLES\` puts it first for the reason it puts
-- \`routing_assignment_fallback\` before the assignments it references.
--
-- **\`ended_at\` and \`outcome\` have no producer in this migration**, and the
-- nullity is declared rather than accidental (ADR 0073). This escalón writes
-- the opening and nothing else; the closer belongs to the escalón that owns a
-- mapping from a terminal task state to \`effect_outcome_status\`, which nobody
-- has adjudicated. Every row this build writes is born \`NULL/NULL\`, and
-- \`ck_task_attempt_read_model__outcome_pair\` is what keeps a later writer
-- from recording half of an ending.
CREATE TABLE task_attempt_read_model (
  task_id               TEXT    NOT NULL,
  revision_number       INTEGER NOT NULL,
  attempt_number        INTEGER NOT NULL,
  legacy_attempt_number INTEGER NOT NULL,
  invocation_id         TEXT    NOT NULL,
  started_at            TEXT    NOT NULL,
  ended_at              TEXT,
  outcome               TEXT,
  sequence              INTEGER NOT NULL,
  CONSTRAINT pk_task_attempt_read_model
    PRIMARY KEY (task_id, revision_number, attempt_number),
  CONSTRAINT fk_task_attempt_read_model__task_revision_read_model
    FOREIGN KEY (task_id, revision_number)
    REFERENCES task_revision_read_model (task_id, revision_number),
  CONSTRAINT ck_task_attempt_read_model__attempt_number
    CHECK (attempt_number >= 1),
  CONSTRAINT ck_task_attempt_read_model__legacy_attempt_number
    CHECK (legacy_attempt_number >= 1),
  CONSTRAINT ck_task_attempt_read_model__outcome
    CHECK (outcome IS NULL
      OR outcome IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN')),
  -- \`NULL\` if and only if: an attempt that ended without an outcome, or an
  -- outcome with no ending, are each half a fact.
  CONSTRAINT ck_task_attempt_read_model__outcome_pair
    CHECK ((ended_at IS NULL) = (outcome IS NULL))
) STRICT;

-- The flat assignment is unique within the task, which is what makes it usable
-- as \`control_plane_events.attempt\`: two coordinates sharing it would make
-- the legacy column ambiguous for every query written before migration 11.
CREATE UNIQUE INDEX ux_task_attempt_read_model__task_id_legacy_attempt_number
  ON task_attempt_read_model (task_id, legacy_attempt_number);

-- Unique GLOBALLY, not per task: together with the primary key this is the
-- bijection execution §3 asks for — one invocation names one attempt and one
-- attempt names one invocation. A replay or a handoff carries the same value
-- rather than minting a second one.
CREATE UNIQUE INDEX ux_task_attempt_read_model__invocation_id
  ON task_attempt_read_model (invocation_id);

-- The watermark, seeded from the head this stream already has.
--
-- Migration 11's case exactly, and for its reason: the projection arrives over
-- \`control_plane_events\`, which may already hold a long history, and the
-- fold over all of it is legitimately empty because no historical row carries
-- an attempt opening. So the projection IS level with the stream the moment the
-- table exists. A literal zero would make every ledger in the field fail its
-- own integrity check immediately after a routine upgrade, with nothing
-- whatsoever wrong with it.
--
-- On a fresh ledger the three subqueries read 0, 0 and the genesis digest, so
-- this is identical to a literal zero seed there.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  'task_attempt_read_model',
  'control_plane_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'head_event_sha256'),
  '1970-01-01T00:00:00.000Z';
`,
  },
  {
    version: 13,
    name: "execution_effect_identity",
    sql: `
-- The effect, its deliveries, and the segment both hang off (P-18/protocolo C).
--
-- Three tables in one migration, and they are not three packets pretending to
-- be one. Execution §6 \`:242\` and §7 \`:343\` both carry a foreign key onto
-- \`execution_route_segment_read_model\`, and the formula for \`effect_id\`
-- takes \`segment_number\` from it. §1.8 forbids cutting an invariant to get a
-- smaller delivery, so the segment lands with the two tables that cannot be
-- expressed without it (correction C-1, adjudicated).
--
-- **The identity ladder, finished for this packet.** \`task_id\` →
-- \`(task_id, revision_number)\` (migration 11) → \`(task_id, revision_number,
-- attempt_number)\` (migration 12) → \`route_segment_id\` → \`effect_id\` →
-- \`dispatch_attempt_id\`. Each rung below is the parent of a foreign key, and
-- \`DERIVED_TABLES\` clears them children-first for the reason it already
-- clears the attempt before the revision.
--
-- **What this migration does not create.** No occurrence tables: execution §8
-- is escalón D and hangs off \`dispatch_attempt_id\`, which is why the foreign
-- key it will need exists here and nothing else does. No trigger: every pairing
-- rule below is a CHECK the base can evaluate on its own row, unlike migration
-- 11's coordinate rule, which had to compare a column against a JSON body.
CREATE TABLE execution_route_segment_read_model (
  route_segment_id          TEXT    NOT NULL,
  task_id                   TEXT    NOT NULL,
  revision_number           INTEGER NOT NULL,
  attempt_number            INTEGER NOT NULL,
  segment_number            INTEGER NOT NULL,
  predecessor_segment_id    TEXT,
  handoff_reason            TEXT,
  provider                  TEXT    NOT NULL,
  model                     TEXT    NOT NULL,
  model_resolution_status   TEXT    NOT NULL,
  model_version_id          TEXT,
  account_id                TEXT,
  transport_kind            TEXT    NOT NULL,
  capability_policy_version TEXT    NOT NULL,
  routing_assignment_id     TEXT,
  reservation_id            TEXT,
  escalated_from_attempt    INTEGER,
  escalation_reason         TEXT,
  resolved_at               TEXT,
  recorded_at               TEXT    NOT NULL,
  sequence                  INTEGER NOT NULL,
  CONSTRAINT pk_execution_route_segment_read_model PRIMARY KEY (route_segment_id),
  -- The segment belongs to one try at one revision, and cannot be adopted by
  -- another. \`DEFERRABLE INITIALLY DEFERRED\` because §7 asks for it wherever
  -- an \`appendBatch\` materializes the sources together: a batch may open an
  -- attempt and its first segment in one transaction, and an immediate check
  -- would depend on statement order inside it rather than on the batch being
  -- consistent when it commits.
  CONSTRAINT fk_execution_route_segment_read_model__task_attempt_read_model
    FOREIGN KEY (task_id, revision_number, attempt_number)
    REFERENCES task_attempt_read_model (task_id, revision_number, attempt_number)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_execution_route_segment_read_model__segment_number
    CHECK (segment_number >= 1),
  -- A handoff is a predecessor AND a reason, or it is neither. Half of one is
  -- a segment that says it came from somewhere and will not say why, or a
  -- reason attached to no origin.
  CONSTRAINT ck_execution_route_segment_read_model__handoff_pair
    CHECK ((predecessor_segment_id IS NULL) = (handoff_reason IS NULL)),
  CONSTRAINT ck_execution_route_segment_read_model__model_resolution_status
    CHECK (model_resolution_status IN ('RESOLVED', 'UNKNOWN', 'NOT_OBSERVABLE')),
  -- §4: \`model_version_id\` stays NULL in the two unresolved cases **even
  -- after executing**. The equality is what makes "we could not resolve it" a
  -- recorded fact rather than an empty column somebody may later fill in.
  CONSTRAINT ck_execution_route_segment_read_model__model_resolution_pair
    CHECK ((model_resolution_status = 'RESOLVED') = (model_version_id IS NOT NULL)),
  CONSTRAINT ck_execution_route_segment_read_model__escalation_pair
    CHECK ((escalated_from_attempt IS NULL) = (escalation_reason IS NULL))
) STRICT;

-- The segment's own coordinate, and the reason a handoff cannot overwrite one:
-- segment 2 of an attempt is a row beside segment 1, never on top of it.
CREATE UNIQUE INDEX ux_execution_route_segment_read_model__attempt_segment
  ON execution_route_segment_read_model
    (task_id, revision_number, attempt_number, segment_number);

CREATE INDEX ix_execution_route_segment_read_model__account
  ON execution_route_segment_read_model (account_id, task_id);

-- The logical effect (execution §6). One row per logical operation of a run,
-- **not** one row per delivery: retransmitting is a new \`dispatch_attempt\`
-- and never a new effect.
--
-- \`route_segment_id\` here is the **initial** segment and is immutable. A
-- later authorized dispatch after a handoff records its own segment in §7's
-- table; §6.1 \`:329\` says so in as many words, and it is what keeps
-- \`idempotency_key\` — whose preimage carries \`segment_number\` — stable
-- across a handoff.
--
-- **\`outcome_status\` is NULL by default and that is a different fact from
-- \`OUTCOME_UNKNOWN\`.** An intention never dispatched is absence of data;
-- \`OUTCOME_UNKNOWN\` is a recorded uncertain exposure, written only when one
-- actually happened, and it is not a failure and does not license a blind
-- retry (execution §6 \`:252\`, invariant 9).
CREATE TABLE effect_read_model (
  effect_id                TEXT    NOT NULL,
  task_id                  TEXT    NOT NULL,
  revision_number          INTEGER NOT NULL,
  attempt_number           INTEGER NOT NULL,
  route_segment_id         TEXT    NOT NULL,
  operation_ordinal        INTEGER NOT NULL,
  effect_kind              TEXT    NOT NULL,
  semantic_scope_key       TEXT    NOT NULL,
  local_operation_key      TEXT    NOT NULL,
  logical_operation_sha256 TEXT    NOT NULL,
  request_contract_version TEXT    NOT NULL,
  request_sha256           TEXT    NOT NULL,
  idempotency_key          TEXT    NOT NULL,
  intended_at              TEXT    NOT NULL,
  outcome_status           TEXT,
  outcome_recorded_at      TEXT,
  sequence                 INTEGER NOT NULL,
  CONSTRAINT pk_effect_read_model PRIMARY KEY (effect_id),
  CONSTRAINT fk_effect_read_model__execution_route_segment_read_model
    FOREIGN KEY (route_segment_id)
    REFERENCES execution_route_segment_read_model (route_segment_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_effect_read_model__operation_ordinal
    CHECK (operation_ordinal >= 0),
  -- The four digests carry the §3.4 shape check every other digest column in
  -- this schema carries. \`effect_kind\` deliberately carries no CHECK: the
  -- catalogue of business operations grows with the adapters that serve them,
  -- and decision 45 already settled that binding an immutable migration to a
  -- catalogue that is not immutable makes every growth of it a migration of
  -- this database. \`@acp/ledger\` holds the closed set and the door imposes it.
  CONSTRAINT ck_effect_read_model__effect_id_shape
    CHECK (length(effect_id) = 64 AND effect_id NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT ck_effect_read_model__logical_operation_sha256_shape
    CHECK (length(logical_operation_sha256) = 64
      AND logical_operation_sha256 NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT ck_effect_read_model__request_sha256_shape
    CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT ck_effect_read_model__idempotency_key_shape
    CHECK (length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT ck_effect_read_model__outcome_status
    CHECK (outcome_status IS NULL
      OR outcome_status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN')),
  CONSTRAINT ck_effect_read_model__outcome_pair
    CHECK ((outcome_status IS NULL) = (outcome_recorded_at IS NULL))
) STRICT;

-- What a destination is asked not to do twice.
CREATE UNIQUE INDEX ux_effect_read_model__idempotency_key
  ON effect_read_model (idempotency_key);

-- The logical index of §6.1, and the reason the lookup can run BEFORE an
-- ordinal is assigned: the same scope and step of the same run is the same
-- effect, whatever coordinate a retry would otherwise have minted for it. A
-- competitor that loses this unique re-reads and reuses; it never changes the
-- key to turn a conflict into a new operation.
CREATE UNIQUE INDEX ux_effect_read_model__logical_operation_sha256
  ON effect_read_model (logical_operation_sha256);

CREATE INDEX ix_effect_read_model__segment
  ON effect_read_model (route_segment_id, operation_ordinal);

-- One concrete external delivery of one logical effect (execution §7).
--
-- **The intention is recorded BEFORE sending** (datos §11 \`:566\`), which is
-- the whole point of the \`INTENDED\` state: recording that a delivery is about
-- to happen is an append, and an append is not a dispatch. Nothing in this
-- build sends anything.
--
-- \`provider_idempotency_key\`, \`external_handle\` and \`accepted_at\` are the
-- three columns whose *population* needs a composed adapter (map §3.3, B1–B3,
-- P-15). They exist here with their nullity documented, and no producer in this
-- build fills them with an external fact.
--
-- **\`accepted_at\` carries no CHECK, on purpose.** §7 fixes the pair for
-- \`terminal_at\` and says only prose about \`accepted_at\`: it is populated
-- on entering \`INFLIGHT\` *with external confirmation*, or directly at
-- \`SETTLED\` where a provider does not distinguish acceptance from result, and
-- an \`ABANDONED\` before any real dispatch leaves it NULL. A CHECK making
-- \`INFLIGHT\` imply a non-null \`accepted_at\` would make \`INFLIGHT\`
-- unreachable while B2 is blocked, and an unreachable state cannot be tested.
CREATE TABLE dispatch_attempt_read_model (
  dispatch_attempt_id      TEXT    NOT NULL,
  effect_id                TEXT    NOT NULL,
  route_segment_id         TEXT    NOT NULL,
  attempt_ordinal          INTEGER NOT NULL,
  provider_idempotency_key TEXT,
  external_handle          TEXT,
  dispatch_state           TEXT    NOT NULL,
  requested_at             TEXT    NOT NULL,
  accepted_at              TEXT,
  terminal_at              TEXT,
  recorded_at              TEXT    NOT NULL,
  sequence                 INTEGER NOT NULL,
  CONSTRAINT pk_dispatch_attempt_read_model PRIMARY KEY (dispatch_attempt_id),
  CONSTRAINT fk_dispatch_attempt_read_model__effect_read_model
    FOREIGN KEY (effect_id) REFERENCES effect_read_model (effect_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  -- The **effective** segment of this delivery, which may differ from the
  -- effect's initial one and never from its attempt. §7 \`:356\` is explicit
  -- that the fold must not demand equality with \`effect.route_segment_id\`,
  -- because that column conserves the origin.
  CONSTRAINT fk_dispatch_attempt_read_model__execution_route_segment_read_model
    FOREIGN KEY (route_segment_id)
    REFERENCES execution_route_segment_read_model (route_segment_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_dispatch_attempt_read_model__attempt_ordinal
    CHECK (attempt_ordinal >= 1),
  -- Five states, and the set is closed at five. \`RECONCILING\` is
  -- \`outbox_message\`'s word (coordination §2), not a sixth state here: §7
  -- \`:360\` says an overdue \`INFLIGHT\` enables reconciliation — a verb, not
  -- a state — so such a row stays \`INFLIGHT\` and is found by the index below.
  CONSTRAINT ck_dispatch_attempt_read_model__dispatch_state
    CHECK (dispatch_state IN ('INTENDED', 'CLAIMED', 'INFLIGHT', 'SETTLED', 'ABANDONED')),
  CONSTRAINT ck_dispatch_attempt_read_model__terminal_pair
    CHECK ((dispatch_state IN ('SETTLED', 'ABANDONED')) = (terminal_at IS NOT NULL))
) STRICT;

-- Order of delivery within one effect. Unique, because "the second attempt at
-- this effect" has to name exactly one row.
CREATE UNIQUE INDEX ux_dispatch_attempt_read_model__effect_ordinal
  ON dispatch_attempt_read_model (effect_id, attempt_ordinal);

-- The probe for overdue \`INFLIGHT\` rows. The deadline is an argument, never a
-- clock read in this package, and finding a row here produces a report — no
-- verb of this ledger creates another dispatch or another effect from it.
CREATE INDEX ix_dispatch_attempt_read_model__state
  ON dispatch_attempt_read_model (dispatch_state, terminal_at);

-- Three watermarks, seeded from the head this stream already has.
--
-- Migration 11's case and migration 12's, for their reason: these projections
-- arrive over \`control_plane_events\`, which may already hold a long history,
-- and the fold over all of it is legitimately empty because no historical row
-- carries an effect or a dispatch. A literal zero would make every ledger in
-- the field fail its own integrity check immediately after a routine upgrade.
--
-- On a fresh ledger the three subqueries read 0, 0 and the genesis digest, so
-- this is identical to a literal zero seed there.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  name,
  'control_plane_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'head_event_sha256'),
  '1970-01-01T00:00:00.000Z'
FROM (
  SELECT 'execution_route_segment_read_model' AS name
  UNION ALL SELECT 'effect_read_model'
  UNION ALL SELECT 'dispatch_attempt_read_model'
);
`,
  },
  {
    version: 14,
    name: "execution_occurrences",
    sql: `
-- The prompt a delivery sent, and the answer it received (P-18/protocolo D).
--
-- Execution §8. Two tables, hanging off migration 13's delivery by a foreign
-- key that is deliberately **not** unique: one delivery may send several
-- prompts, and each is its own occurrence.
--
-- **A use, never a blob.** §8 \`:377\` says these replace
-- \`prompt_record_read_model\`, whose primary key was \`prompt_sha256\` and so
-- mixed the identity of some bytes with the fact of sending them. That table
-- never existed in this tree: there is nothing to migrate and nothing to drop.
-- Here the same bytes sent twice are two rows and one digest, which is why the
-- digest is indexed and never unique (§8 negative 3).
--
-- **Never bytes** (§8 \`:433\`, invariant 1). Only digests and counts reach
-- these rows. The digests carry no shape CHECK because §8 lists none; the
-- ledger door checks their shape, and conserves them without recomputing,
-- because their preimages are exactly the bytes that may not come in.
--
-- No trigger, for migration 13's reason: every rule below is a CHECK the base
-- evaluates on the row in front of it. The equality between a prompt and its
-- delivery (§8 \`:416\`) spans two tables and is the fold's and the door's.
CREATE TABLE prompt_occurrence_read_model (
  occurrence_id           TEXT    NOT NULL,
  route_segment_id        TEXT    NOT NULL,
  effect_id               TEXT    NOT NULL,
  dispatch_attempt_id     TEXT    NOT NULL,
  ordinal                 INTEGER NOT NULL,
  identity                TEXT    NOT NULL,
  requested_model_id      TEXT    NOT NULL,
  provider                TEXT    NOT NULL,
  model_resolution_status TEXT    NOT NULL,
  model_version_id        TEXT,
  account_id              TEXT    NOT NULL,
  prompt_sha256           TEXT    NOT NULL,
  prompt_bytes            INTEGER NOT NULL,
  context_sha256          TEXT,
  recorded_at             TEXT    NOT NULL,
  sequence                INTEGER NOT NULL,
  CONSTRAINT pk_prompt_occurrence_read_model PRIMARY KEY (occurrence_id),
  -- The **effective** segment of the delivery that sent it, not the segment the
  -- effect began on. \`DEFERRABLE INITIALLY DEFERRED\` for migration 13's reason:
  -- §8 \`:419-420\` admits the delivery's intention and the prompt in one
  -- \`appendBatch\`, and the check belongs at commit, not at statement order.
  CONSTRAINT fk_prompt_occurrence_read_model__execution_route_segment_read_model
    FOREIGN KEY (route_segment_id)
    REFERENCES execution_route_segment_read_model (route_segment_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_prompt_occurrence_read_model__effect_read_model
    FOREIGN KEY (effect_id) REFERENCES effect_read_model (effect_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  -- Not unique: one delivery may send several prompts.
  CONSTRAINT fk_prompt_occurrence_read_model__dispatch_attempt_read_model
    FOREIGN KEY (dispatch_attempt_id)
    REFERENCES dispatch_attempt_read_model (dispatch_attempt_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_prompt_occurrence_read_model__ordinal
    CHECK (ordinal >= 0),
  CONSTRAINT ck_prompt_occurrence_read_model__model_resolution_status
    CHECK (model_resolution_status IN ('RESOLVED', 'UNKNOWN', 'NOT_OBSERVABLE')),
  -- §4's pair, verbatim, because §8 fixes the same contract of absent data:
  -- a version nobody could resolve stays NULL even after executing.
  CONSTRAINT ck_prompt_occurrence_read_model__model_resolution_pair
    CHECK ((model_resolution_status = 'RESOLVED') = (model_version_id IS NOT NULL)),
  CONSTRAINT ck_prompt_occurrence_read_model__prompt_bytes
    CHECK (prompt_bytes >= 0)
) STRICT;

-- Order of prompts within a segment. Not unique by §8, which asks for the
-- index and not for the claim; the ledger assigns the ordinal one past the
-- segment's highest, so the order is still total.
CREATE INDEX ix_prompt_occurrence_read_model__segment
  ON prompt_occurrence_read_model (route_segment_id, ordinal);

-- Not unique — on purpose. The same bytes sent twice are two occurrences.
CREATE INDEX ix_prompt_occurrence_read_model__sha256
  ON prompt_occurrence_read_model (prompt_sha256);

-- The answer. Its only link to where the work ran is the prompt it answers, so
-- a late answer after a handoff cannot be attributed to the destination: there
-- is no account or segment column to attribute it through.
CREATE TABLE response_occurrence_read_model (
  occurrence_id        TEXT    NOT NULL,
  prompt_occurrence_id TEXT    NOT NULL,
  response_sha256      TEXT    NOT NULL,
  response_bytes       INTEGER NOT NULL,
  redaction_verdict    TEXT    NOT NULL,
  recorded_at          TEXT    NOT NULL,
  sequence             INTEGER NOT NULL,
  CONSTRAINT pk_response_occurrence_read_model PRIMARY KEY (occurrence_id),
  CONSTRAINT fk_response_occurrence_read_model__prompt_occurrence_read_model
    FOREIGN KEY (prompt_occurrence_id)
    REFERENCES prompt_occurrence_read_model (occurrence_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_response_occurrence_read_model__response_bytes
    CHECK (response_bytes >= 0),
  CONSTRAINT ck_response_occurrence_read_model__redaction_verdict
    CHECK (redaction_verdict IN ('CLEAN', 'REDACTED'))
) STRICT;

-- One answer per prompt occurrence.
CREATE UNIQUE INDEX ux_response_occurrence_read_model__prompt
  ON response_occurrence_read_model (prompt_occurrence_id);

-- Two watermarks, seeded from the head this stream already has, in migration
-- 13's form and for its reason: no historical row carries an occurrence, so the
-- fold over any existing history is legitimately empty and a literal zero would
-- fail every ledger in the field's own integrity check after the upgrade.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  name,
  'control_plane_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'head_event_sha256'),
  '1970-01-01T00:00:00.000Z'
FROM (
  SELECT 'prompt_occurrence_read_model' AS name
  UNION ALL SELECT 'response_occurrence_read_model'
);
`,
  },
  {
    version: 15,
    name: "artifact_registry",
    sql: `
-- An artifact is a subject of the registry before its first byte moves
-- (P-36/local escalón A, ADR 0081).
--
-- Artifacts §1.1 puts every artifact event in \`registry_events\`, with
-- \`subject_kind = 'ARTIFACT'\` and the resource as the subject. Migration 9
-- created that stream for documents alone: \`document_kind\` is NOT NULL and
-- closed by a CHECK, and a CHECK cannot be widened in place. So the stream is
-- REBUILT here, once, and the four read models the events fold into are
-- created after it.
--
-- **The rebuild changes no row.** Every column of every existing row is copied
-- as it is, \`sequence\` included, and every row gets \`subject_kind =
-- 'DOCUMENT'\` and a NULL \`artifact_event_kind\` beside it. The chain is
-- \`chainDigest(previous_sha256, event_json)\`: both are copied columns, and no
-- new column enters the preimage, so every \`event_sha256\` still verifies and
-- the registry head in \`ledger_meta\` does not move. \`sqlite_sequence\` follows
-- the copied rows, so the next append takes the next number.
--
-- **The order below is fixed, and each step is load-bearing.** It is SQLite's
-- documented twelve-step procedure for a schema change ALTER TABLE cannot
-- make, reduced to the steps this table needs:
--
--   1. create the new table beside the old one;
--   2. copy every row, in sequence order;
--   3. drop the three triggers on the old table AND the two triggers on OTHER
--      tables whose bodies name it. \`ALTER TABLE ... RENAME\` re-parses the
--      whole schema, and at step 4 a trigger naming \`registry_events\` names a
--      table that does not exist — the rename aborts. Migration 9's
--      DROP/CREATE of those same two triggers is the precedent in this file;
--   4. drop the old table and rename the new one into its place;
--   5. recreate the indexes and the five triggers, the two foreign ones
--      byte-identical to migration 9's;
--   6. and only then the four read models, because each of them carries a
--      foreign key INTO this table.
--
-- The migration runs inside the one transaction that applies every pending
-- migration, with \`foreign_keys\` ON. Nothing references \`registry_events\` by
-- a foreign key before this migration, which is why the table can be dropped
-- and renamed at all. **After it, four tables do**: a future rebuild of
-- \`registry_events\` must drop those children first, and it cannot be done by
-- \`PRAGMA foreign_keys = OFF\`, which is a no-op inside a transaction.
CREATE TABLE registry_events__rebuilt (
  sequence                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id                TEXT    NOT NULL UNIQUE,
  idempotency_key         TEXT    NOT NULL UNIQUE,
  subject_kind            TEXT    NOT NULL,
  document_kind           TEXT,
  artifact_event_kind     TEXT,
  document_id             TEXT    NOT NULL,
  document_version        INTEGER NOT NULL,
  content_digest          TEXT    NOT NULL,
  parent_document_version INTEGER,
  recorded_by             TEXT    NOT NULL,
  effective_from          TEXT    NOT NULL,
  occurred_at             TEXT    NOT NULL,
  recorded_at             TEXT    NOT NULL,
  causation_stream        TEXT,
  causation_sequence      INTEGER,
  causation_sha256        TEXT,
  contract_version        TEXT    NOT NULL,
  event_json              TEXT    NOT NULL,
  previous_sha256         TEXT    NOT NULL,
  event_sha256            TEXT    NOT NULL UNIQUE,
  CONSTRAINT ck_registry_events__subject_kind CHECK (
    subject_kind IN ('DOCUMENT', 'ARTIFACT')
  ),
  -- Migration 9's fourteen names, under migration 9's constraint name. NULL
  -- passes an IN test, so the kind may be absent here; whether it MUST be is
  -- the mirror below.
  CONSTRAINT ck_registry_events__document_kind CHECK (
    document_kind IN (
      'CAPABILITY_POLICY',
      'MODEL_VERSION',
      'PRICE_TABLE',
      'MODEL_PERFORMANCE',
      'ROUTING_ASSIGNMENT_GLOBAL',
      'ESTIMATION_POLICY',
      'INTEGRATION_PROFILE',
      'INTEGRATION_INSTALLATION',
      'COMPOSITION_POLICY',
      'COMPOSITION_EVIDENCE',
      'NOTIFICATION_POLICY',
      'APPROVAL_WAIT_POLICY',
      'DUEL_POLICY',
      'ANOMALY_POLICY'
    )
  ),
  -- The contract's closed artifact vocabulary, all NINE names, although this
  -- build records six. The other three are refused by name at the door, and
  -- naming them here means P-36 completo does not rebuild this table again —
  -- after this migration a rebuild is no longer cheap. Migration 7's
  -- \`ck_projection_watermark__source_stream\` is the precedent: the CHECK
  -- names the contract's domain, and the code's closed set decides the subset.
  CONSTRAINT ck_registry_events__artifact_event_kind CHECK (
    artifact_event_kind IN (
      'PUBLICATION_INTENDED',
      'PUBLICATION_SUCCEEDED',
      'PUBLICATION_ABANDONED',
      'REFERENCE_RECORDED',
      'PIN_ACQUIRED',
      'PIN_RELEASED',
      'RECLAIM_INTENDED',
      'RECLAIM_COMPLETED',
      'REFERENCE_TOMBSTONED'
    )
  ),
  -- The two mirrors, each written as an equality of truth values rather than a
  -- disjunction of lawful shapes: \`subject_kind\` is NOT NULL, so neither side
  -- can be NULL, and a NULL CHECK is a CHECK that passes.
  CONSTRAINT ck_registry_events__document_kind_matches_subject CHECK (
    (subject_kind = 'DOCUMENT') = (document_kind IS NOT NULL)
  ),
  CONSTRAINT ck_registry_events__artifact_event_kind_matches_subject CHECK (
    (subject_kind = 'ARTIFACT') = (artifact_event_kind IS NOT NULL)
  ),
  CONSTRAINT ck_registry_events__document_version CHECK (document_version >= 1),
  CONSTRAINT ck_registry_events__parent_document_version CHECK (
    parent_document_version IS NULL
      OR (parent_document_version >= 1 AND parent_document_version < document_version)
  ),
  CONSTRAINT ck_registry_events__content_digest CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ck_registry_events__causation_pair CHECK (
    (causation_stream IS NULL) = (causation_sequence IS NULL)
      AND (causation_stream IS NULL) = (causation_sha256 IS NULL)
  ),
  CONSTRAINT ck_registry_events__causation_sequence CHECK (
    causation_sequence IS NULL OR causation_sequence >= 1
  ),
  CONSTRAINT ck_registry_events__causation_sha256 CHECK (
    causation_sha256 IS NULL
      OR (length(causation_sha256) = 64 AND causation_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  CONSTRAINT ck_registry_events__previous_sha256 CHECK (
    length(previous_sha256) = 64 AND previous_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ck_registry_events__event_sha256 CHECK (
    length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

-- Every row that exists is a document, and it is copied byte for byte.
INSERT INTO registry_events__rebuilt (
  sequence, event_id, idempotency_key, subject_kind, document_kind, artifact_event_kind,
  document_id, document_version, content_digest, parent_document_version, recorded_by,
  effective_from, occurred_at, recorded_at, causation_stream, causation_sequence,
  causation_sha256, contract_version, event_json, previous_sha256, event_sha256
)
SELECT
  sequence, event_id, idempotency_key, 'DOCUMENT', document_kind, NULL,
  document_id, document_version, content_digest, parent_document_version, recorded_by,
  effective_from, occurred_at, recorded_at, causation_stream, causation_sequence,
  causation_sha256, contract_version, event_json, previous_sha256, event_sha256
FROM registry_events
ORDER BY sequence;

DROP TRIGGER tr_registry_events__validate_new_rows;
DROP TRIGGER tr_registry_events__deny_delete;
DROP TRIGGER tr_registry_events__deny_update;
DROP TRIGGER tr_control_plane_events__validate_new_rows;
DROP TRIGGER tr_initiative_events__validate_new_rows;

DROP TABLE registry_events;
ALTER TABLE registry_events__rebuilt RENAME TO registry_events;

-- Migration 9's three indexes, under its names.
CREATE UNIQUE INDEX ux_registry_events__document_id__document_version
  ON registry_events (document_id, document_version);

CREATE INDEX ix_registry_events__document_kind__document_id__document_version
  ON registry_events (document_kind, document_id, document_version);

CREATE INDEX ix_registry_events__document_id__effective_from
  ON registry_events (document_id, effective_from);

-- The fold's access path per subject. The unique index above is still the
-- ordinal's compare-and-set: an artifact subject's ordinal is its
-- \`document_version\`, one past its highest.
CREATE INDEX ix_registry_events__subject_kind__document_id
  ON registry_events (subject_kind, document_id);

CREATE TRIGGER tr_registry_events__deny_update
BEFORE UPDATE ON registry_events
BEGIN
  SELECT RAISE(ABORT, 'registry_events is append-only: UPDATE is denied');
END;

CREATE TRIGGER tr_registry_events__deny_delete
BEFORE DELETE ON registry_events
BEGIN
  SELECT RAISE(ABORT, 'registry_events is append-only: DELETE is denied');
END;

CREATE TRIGGER tr_registry_events__validate_new_rows
BEFORE INSERT ON registry_events
BEGIN
  SELECT RAISE(ABORT, 'registry_events causal reference names a stream with no verifiable digest')
  WHERE NEW.causation_stream IS NOT NULL
    AND NEW.causation_stream NOT IN ('control_plane_events', 'initiative_events', 'registry_events');

  SELECT RAISE(ABORT, 'registry_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'control_plane_events'
    AND NOT EXISTS (
      SELECT 1 FROM control_plane_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'registry_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'initiative_events'
    AND NOT EXISTS (
      SELECT 1 FROM initiative_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'registry_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'registry_events'
    AND NOT EXISTS (
      SELECT 1 FROM registry_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );
END;

-- The two foreign triggers, recreated with migration 9's bodies exactly. They
-- were dropped only so the rename could run; nothing about them changes.
CREATE TRIGGER tr_control_plane_events__validate_new_rows
BEFORE INSERT ON control_plane_events
BEGIN
  SELECT RAISE(ABORT, 'control_plane_events.event_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.event_sha256) <> 64 OR NEW.event_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'control_plane_events.previous_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.previous_sha256) <> 64 OR NEW.previous_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'control_plane_events causal reference is all three columns or none')
  WHERE (NEW.causation_stream IS NULL) <> (NEW.causation_sequence IS NULL)
     OR (NEW.causation_stream IS NULL) <> (NEW.causation_sha256 IS NULL);

  SELECT RAISE(ABORT, 'control_plane_events.causation_sha256 is not 64 lowercase hex characters')
  WHERE NEW.causation_sha256 IS NOT NULL
    AND (length(NEW.causation_sha256) <> 64 OR NEW.causation_sha256 GLOB '*[^0-9a-f]*');

  SELECT RAISE(ABORT, 'control_plane_events causal reference names a stream with no verifiable digest')
  WHERE NEW.causation_stream IS NOT NULL
    AND NEW.causation_stream NOT IN ('control_plane_events', 'initiative_events', 'registry_events');

  SELECT RAISE(ABORT, 'control_plane_events causal reference needs a positive position')
  WHERE NEW.causation_sequence IS NOT NULL AND NEW.causation_sequence < 1;

  SELECT RAISE(ABORT, 'control_plane_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'control_plane_events'
    AND NOT EXISTS (
      SELECT 1 FROM control_plane_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'control_plane_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'initiative_events'
    AND NOT EXISTS (
      SELECT 1 FROM initiative_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'control_plane_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'registry_events'
    AND NOT EXISTS (
      SELECT 1 FROM registry_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );
END;

CREATE TRIGGER tr_initiative_events__validate_new_rows
BEFORE INSERT ON initiative_events
BEGIN
  SELECT RAISE(ABORT, 'initiative_events.event_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.event_sha256) <> 64 OR NEW.event_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'initiative_events.previous_sha256 is not 64 lowercase hex characters')
  WHERE length(NEW.previous_sha256) <> 64 OR NEW.previous_sha256 GLOB '*[^0-9a-f]*';

  SELECT RAISE(ABORT, 'initiative_events causal reference is all three columns or none')
  WHERE (NEW.causation_stream IS NULL) <> (NEW.causation_sequence IS NULL)
     OR (NEW.causation_stream IS NULL) <> (NEW.causation_sha256 IS NULL);

  SELECT RAISE(ABORT, 'initiative_events.causation_sha256 is not 64 lowercase hex characters')
  WHERE NEW.causation_sha256 IS NOT NULL
    AND (length(NEW.causation_sha256) <> 64 OR NEW.causation_sha256 GLOB '*[^0-9a-f]*');

  SELECT RAISE(ABORT, 'initiative_events causal reference names a stream with no verifiable digest')
  WHERE NEW.causation_stream IS NOT NULL
    AND NEW.causation_stream NOT IN ('control_plane_events', 'initiative_events', 'registry_events');

  SELECT RAISE(ABORT, 'initiative_events causal reference needs a positive position')
  WHERE NEW.causation_sequence IS NOT NULL AND NEW.causation_sequence < 1;

  SELECT RAISE(ABORT, 'initiative_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'control_plane_events'
    AND NOT EXISTS (
      SELECT 1 FROM control_plane_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'initiative_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'initiative_events'
    AND NOT EXISTS (
      SELECT 1 FROM initiative_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );

  SELECT RAISE(ABORT, 'initiative_events causal reference does not resolve to the event it names')
  WHERE NEW.causation_stream = 'registry_events'
    AND NOT EXISTS (
      SELECT 1 FROM registry_events
      WHERE sequence = NEW.causation_sequence AND event_sha256 = NEW.causation_sha256
    );
END;

-- Metadata of the bytes, and nothing about who may read them (artifacts §3).
--
-- \`(content_sha256, blob_generation)\` is the identity: the same content
-- published, reclaimed and published again is two generations, and their
-- histories never mix. A foreign key names the pair, never the digest alone.
--
-- The two \`first_published_*\` rules are §8.1's fold, held in the base as
-- well: a pair that is both NULL or both present, and a presence that follows
-- the state. The two \`reclaim\` rules are the same §8.1 sentence for the
-- states this build never reaches; they cost nothing and keep a raw writer from
-- inventing a reclamation.
CREATE TABLE artifact_blob_read_model (
  content_sha256           TEXT    NOT NULL,
  blob_generation          INTEGER NOT NULL DEFAULT 1,
  media_type               TEXT    NOT NULL,
  size_bytes               INTEGER NOT NULL,
  lifecycle_state          TEXT    NOT NULL,
  encryption_status        TEXT    NOT NULL,
  key_reference            TEXT,
  first_published_sequence INTEGER,
  first_published_at       TEXT,
  reclaim_id               TEXT,
  reclaimed_at             TEXT,
  grace_started_at         TEXT    NOT NULL,
  encryption_profile       TEXT    NOT NULL,
  applied_sequence         INTEGER NOT NULL,
  CONSTRAINT pk_artifact_blob_read_model PRIMARY KEY (content_sha256, blob_generation),
  CONSTRAINT fk_artifact_blob_read_model__registry_events
    FOREIGN KEY (first_published_sequence) REFERENCES registry_events (sequence)
    ON DELETE RESTRICT,
  CONSTRAINT ck_artifact_blob_read_model__content_sha256_hex CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ck_artifact_blob_read_model__blob_generation_positive CHECK (blob_generation > 0),
  CONSTRAINT ck_artifact_blob_read_model__size_bytes_non_negative CHECK (size_bytes >= 0),
  CONSTRAINT ck_artifact_blob_read_model__lifecycle_state_enum CHECK (
    lifecycle_state IN (
      'STAGED', 'PUBLISHED', 'PUBLICATION_ABANDONED', 'RECLAIM_INTENDED', 'RECLAIMED'
    )
  ),
  CONSTRAINT ck_artifact_blob_read_model__encryption_status_enum CHECK (
    encryption_status IN ('PLAINTEXT', 'ENCRYPTED_AT_REST')
  ),
  CONSTRAINT ck_artifact_blob_read_model__key_reference_matches_encryption CHECK (
    (key_reference IS NULL) = (encryption_status = 'PLAINTEXT')
  ),
  CONSTRAINT ck_artifact_blob_read_model__first_published_pair CHECK (
    (first_published_sequence IS NULL) = (first_published_at IS NULL)
  ),
  CONSTRAINT ck_artifact_blob_read_model__first_published_matches_state CHECK (
    lifecycle_state IN ('RECLAIM_INTENDED', 'RECLAIMED')
      OR (lifecycle_state = 'PUBLISHED') = (first_published_sequence IS NOT NULL)
  ),
  CONSTRAINT ck_artifact_blob_read_model__reclaim_id_matches_state CHECK (
    (reclaim_id IS NOT NULL) = (lifecycle_state IN ('RECLAIM_INTENDED', 'RECLAIMED'))
  ),
  CONSTRAINT ck_artifact_blob_read_model__reclaimed_at_matches_state CHECK (
    (reclaimed_at IS NOT NULL) = (lifecycle_state = 'RECLAIMED')
  ),
  CONSTRAINT ck_artifact_blob_read_model__applied_sequence_non_negative CHECK (
    applied_sequence >= 0
  )
) STRICT;

CREATE INDEX ix_artifact_blob_read_model__lifecycle_state
  ON artifact_blob_read_model (lifecycle_state);

CREATE INDEX ix_artifact_blob_read_model__first_published_sequence
  ON artifact_blob_read_model (first_published_sequence);

CREATE UNIQUE INDEX ux_artifact_blob_read_model__reclaim_id
  ON artifact_blob_read_model (reclaim_id)
  WHERE reclaim_id IS NOT NULL;

-- One physical generation not yet reclaimed, per content. No uniqueness on the
-- digest alone: the reclaimed generations are history and stay.
CREATE UNIQUE INDEX ux_artifact_blob_read_model__content_sha256__unreclaimed
  ON artifact_blob_read_model (content_sha256)
  WHERE lifecycle_state <> 'RECLAIMED';

-- The access, and the permission with it (artifacts §4).
--
-- \`access_policy_id\` carries no foreign key. Artifacts §4 names
-- \`fk_..__access_policy_read_model\`, and that table has no dictionary; the
-- policy is an identifier closed in code until its owner writes one (decision
-- 59). And there is no uniqueness over \`(scope, digest, producer)\`: two
-- references to one blob from one producer in one scope, under different
-- policies or retentions, are both legitimate.
CREATE TABLE artifact_reference_read_model (
  artifact_reference_id TEXT    NOT NULL,
  content_sha256        TEXT    NOT NULL,
  blob_generation       INTEGER NOT NULL,
  artifact_class        TEXT    NOT NULL,
  classification        TEXT    NOT NULL,
  scope_kind            TEXT    NOT NULL,
  scope_id              TEXT,
  producer_identity     TEXT    NOT NULL,
  access_policy_id      TEXT    NOT NULL,
  retention_class       TEXT    NOT NULL,
  expires_at            TEXT,
  tombstoned_at         TEXT,
  tombstone_reason      TEXT,
  created_sequence      INTEGER NOT NULL,
  applied_sequence      INTEGER NOT NULL,
  CONSTRAINT pk_artifact_reference_read_model PRIMARY KEY (artifact_reference_id),
  CONSTRAINT fk_artifact_reference_read_model__artifact_blob_read_model
    FOREIGN KEY (content_sha256, blob_generation)
    REFERENCES artifact_blob_read_model (content_sha256, blob_generation)
    ON DELETE RESTRICT,
  CONSTRAINT fk_artifact_reference_read_model__registry_events
    FOREIGN KEY (created_sequence) REFERENCES registry_events (sequence)
    ON DELETE RESTRICT,
  CONSTRAINT ck_artifact_reference_read_model__artifact_class_enum CHECK (
    artifact_class IN (
      'TASK_ENVELOPE', 'PROMPT', 'RESPONSE', 'TOOL_ARGUMENT', 'TOOL_RESULT', 'CHECKPOINT',
      'RECEIPT', 'EVIDENCE', 'PLAN_DOCUMENT', 'POLICY_DOCUMENT', 'PRICE_CATALOG', 'EXPORT'
    )
  ),
  CONSTRAINT ck_artifact_reference_read_model__classification_enum CHECK (
    classification IN ('PUBLIC_SAFE', 'INTERNAL', 'SENSITIVE', 'SECRET_BEARING')
  ),
  CONSTRAINT ck_artifact_reference_read_model__scope_kind_enum CHECK (
    scope_kind IN ('INITIATIVE', 'TASK', 'ACCOUNT', 'SYSTEM')
  ),
  -- NULL only for SYSTEM, in the one direction the dictionary writes.
  CONSTRAINT ck_artifact_reference_read_model__scope_id_matches_scope_kind CHECK (
    scope_id IS NOT NULL OR scope_kind = 'SYSTEM'
  ),
  CONSTRAINT ck_artifact_reference_read_model__retention_class_enum CHECK (
    retention_class IN ('EPHEMERAL', 'STANDARD', 'EXTENDED', 'PERMANENT')
  ),
  CONSTRAINT ck_artifact_reference_read_model__expires_at_matches_retention_class CHECK (
    (expires_at IS NULL) = (retention_class = 'PERMANENT')
  ),
  CONSTRAINT ck_artifact_reference_read_model__tombstone_reason_matches CHECK (
    (tombstone_reason IS NULL) = (tombstoned_at IS NULL)
      AND (
        tombstone_reason IS NULL
          OR tombstone_reason IN (
            'POLICY_EXPIRY', 'OWNER_REQUEST', 'LEGAL_HOLD_RELEASE', 'CORRUPTION'
          )
      )
  ),
  CONSTRAINT ck_artifact_reference_read_model__applied_sequence_non_negative CHECK (
    applied_sequence >= 0
  )
) STRICT;

CREATE INDEX ix_artifact_reference_read_model__content_sha256
  ON artifact_reference_read_model (content_sha256);

CREATE INDEX ix_artifact_reference_read_model__scope_kind_scope_id
  ON artifact_reference_read_model (scope_kind, scope_id);

CREATE INDEX ix_artifact_reference_read_model__expires_at
  ON artifact_reference_read_model (expires_at);

-- The auxiliary key the tombstone's composite foreign key names. It does not
-- stop a second reference to the same content.
CREATE UNIQUE INDEX ux_artifact_reference_read_model__id_content_generation
  ON artifact_reference_read_model (artifact_reference_id, content_sha256, blob_generation);

-- A protection from collection, for as long as an operation or an obligation
-- lasts (artifacts §5).
CREATE TABLE artifact_pin_read_model (
  artifact_pin_id   TEXT    NOT NULL,
  content_sha256    TEXT    NOT NULL,
  blob_generation   INTEGER NOT NULL,
  pin_holder_kind   TEXT    NOT NULL,
  pin_holder_id     TEXT    NOT NULL,
  acquired_sequence INTEGER NOT NULL,
  released_sequence INTEGER,
  applied_sequence  INTEGER NOT NULL,
  CONSTRAINT pk_artifact_pin_read_model PRIMARY KEY (artifact_pin_id),
  CONSTRAINT fk_artifact_pin_read_model__artifact_blob_read_model
    FOREIGN KEY (content_sha256, blob_generation)
    REFERENCES artifact_blob_read_model (content_sha256, blob_generation)
    ON DELETE RESTRICT,
  CONSTRAINT fk_artifact_pin_read_model__registry_events__acquired_sequence
    FOREIGN KEY (acquired_sequence) REFERENCES registry_events (sequence)
    ON DELETE RESTRICT,
  CONSTRAINT fk_artifact_pin_read_model__registry_events__released_sequence
    FOREIGN KEY (released_sequence) REFERENCES registry_events (sequence)
    ON DELETE RESTRICT,
  CONSTRAINT ck_artifact_pin_read_model__pin_holder_kind_enum CHECK (
    pin_holder_kind IN ('PUBLICATION', 'TASK', 'BACKUP', 'LEGAL_HOLD')
  ),
  CONSTRAINT ck_artifact_pin_read_model__released_after_acquired CHECK (
    released_sequence IS NULL OR released_sequence >= acquired_sequence
  ),
  CONSTRAINT ck_artifact_pin_read_model__applied_sequence_non_negative CHECK (
    applied_sequence >= 0
  )
) STRICT;

-- One live pin per holder per generation. Partial, because a released pin is
-- history and a holder may take the blob again later under a new pin.
CREATE UNIQUE INDEX ux_artifact_pin_read_model__content_sha256_holder__live
  ON artifact_pin_read_model (content_sha256, blob_generation, pin_holder_kind, pin_holder_id)
  WHERE released_sequence IS NULL;

-- The revocation of a reference, irreversible (artifacts §6). The table exists
-- so the shape stops drifting from the dictionary; nothing in this build writes
-- into it, because \`REFERENCE_TOMBSTONED\` is refused by name at the door.
CREATE TABLE artifact_tombstone_read_model (
  artifact_reference_id TEXT    NOT NULL,
  content_sha256        TEXT    NOT NULL,
  blob_generation       INTEGER NOT NULL,
  reason                TEXT    NOT NULL,
  decided_by            TEXT    NOT NULL,
  authority_sha256      TEXT    NOT NULL,
  recorded_sequence     INTEGER NOT NULL,
  applied_sequence      INTEGER NOT NULL,
  CONSTRAINT pk_artifact_tombstone_read_model PRIMARY KEY (artifact_reference_id),
  CONSTRAINT fk_artifact_tombstone_read_model__artifact_reference_read_model
    FOREIGN KEY (artifact_reference_id, content_sha256, blob_generation)
    REFERENCES artifact_reference_read_model (artifact_reference_id, content_sha256, blob_generation)
    ON DELETE RESTRICT,
  CONSTRAINT fk_artifact_tombstone_read_model__artifact_blob_read_model
    FOREIGN KEY (content_sha256, blob_generation)
    REFERENCES artifact_blob_read_model (content_sha256, blob_generation)
    ON DELETE RESTRICT,
  CONSTRAINT fk_artifact_tombstone_read_model__registry_events
    FOREIGN KEY (recorded_sequence) REFERENCES registry_events (sequence)
    ON DELETE RESTRICT,
  CONSTRAINT ck_artifact_tombstone_read_model__reason_enum CHECK (
    reason IN ('POLICY_EXPIRY', 'OWNER_REQUEST', 'LEGAL_HOLD_RELEASE', 'CORRUPTION')
  ),
  CONSTRAINT ck_artifact_tombstone_read_model__authority_sha256_hex CHECK (
    length(authority_sha256) = 64 AND authority_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ck_artifact_tombstone_read_model__applied_sequence_non_negative CHECK (
    applied_sequence >= 0
  )
) STRICT;

-- Four watermarks, seeded from the head of the REGISTRY stream, in migration
-- 13's form and for its reason. The stream may already hold documents, and the
-- fold of the artifact plane over every one of them is empty by construction —
-- no document is an artifact event — so the four projections are level with
-- that head the moment their tables exist. A literal zero would fail every
-- ledger in the field's own integrity check after a routine upgrade.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  name,
  'registry_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'registry_head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'registry_event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'registry_head_event_sha256'),
  '1970-01-01T00:00:00.000Z'
FROM (
  SELECT 'artifact_blob_read_model' AS name
  UNION ALL SELECT 'artifact_reference_read_model'
  UNION ALL SELECT 'artifact_pin_read_model'
  UNION ALL SELECT 'artifact_tombstone_read_model'
);
`,
  },
  {
    version: 16,
    name: "task_revision_envelope_reference",
    sql: `
-- A revision names its envelope's bytes by reference, never by digest
-- (P-36/local D, decision 41, ADR 0084).
--
-- Migration 11 created \`task_revision_read_model\` without
-- \`envelope_artifact_reference_id\` on purpose: the column is \`NOT NULL\` in the
-- dictionary and only the artifact plane mints its value, so a nullable column
-- there would have been a column with no producer pointing at an empty port.
-- The plane exists now (migration 15 and escalón C), and decision 41 says how
-- the column arrives: \`ADD COLUMN\`, a \`BEFORE INSERT\` trigger by cohort of
-- \`contract_version\`, the value carried as a key of the revision record's
-- payload, \`NULL\` on every revision recorded before, and nothing ever derives a
-- reference from a digest.
--
-- **Additive, and the table is not rebuilt.** A nullable column with no default
-- is added without rewriting a row, and every row already there reads \`NULL\` —
-- which is exactly the value the cohort before holds. So no row is rewritten, no index moves and no watermark moves: the fold
-- over the existing history yields the same rows with \`NULL\` in the new field,
-- and the projection is level with its stream the moment the column exists.
ALTER TABLE task_revision_read_model ADD COLUMN envelope_artifact_reference_id TEXT;

-- The cohort, in both directions, as one trigger.
--
-- The cohort before is a CLOSED list frozen here, never a comparison of version
-- strings: \`'2.2.0'\`, \`'2.3.0'\` and \`'2.4.0'\` are every version any build
-- before this migration could have stamped, a migration is immutable, and a
-- version bumped later falls into the cohort after without touching this text.
-- The fold's \`PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS\` spells the same three,
-- and the suite holds the two spellings equal.
--
-- Backward: a revision of the cohort before holding a reference is a row that
-- claims bytes no build of its contract could have named. Forward: a revision
-- of the cohort after without one — or with an empty one — is the column this
-- migration exists to fill, left empty.
--
-- **Existence is not checked here, and cannot be.** Whether the reference names
-- a \`TASK_ENVELOPE\` is a question about \`artifact_reference_read_model\`, a
-- projection of the registry stream; this row is a projection of the task
-- stream. A rebuild clears every derived table and folds one chain at a time, so
-- a trigger or a foreign key reaching across would abort a rebuild on history the
-- append door accepted. The door asks that question, by name, before it writes.
CREATE TRIGGER tr_task_revision_read_model__validate_envelope_reference
BEFORE INSERT ON task_revision_read_model
BEGIN
  SELECT RAISE(ABORT, 'task_revision_read_model.envelope_artifact_reference_id must be NULL on a revision of contract version 2.2.0, 2.3.0 or 2.4.0')
  WHERE NEW.contract_version IN ('2.2.0', '2.3.0', '2.4.0')
    AND NEW.envelope_artifact_reference_id IS NOT NULL;

  SELECT RAISE(ABORT, 'task_revision_read_model.envelope_artifact_reference_id is required on a revision of every later contract version')
  WHERE NEW.contract_version NOT IN ('2.2.0', '2.3.0', '2.4.0')
    AND (NEW.envelope_artifact_reference_id IS NULL OR NEW.envelope_artifact_reference_id = '');
END;
`,
  },
  {
    version: 17,
    name: "model_version_registry",
    sql: `
-- A role resolves from the registry alone, or not at all (P-14 escalón A,
-- ADR 0085).
--
-- Accounts §6 moves the one registry of model versions here: a row per
-- \`MODEL_VERSION\` document of \`registry_events\`, with its eligible roles and
-- its admitted transports as child rows rather than JSON columns (§6.1). The
-- stream has carried the document kind since migration 9; nothing folded it,
-- so the eligibility a GLOBAL routing assignment is checked against lived in a
-- policy file beside the code. From this migration the append door checks an
-- assignment against these rows, by name, before it writes.
--
-- **No foreign key into \`registry_events\`, and none into the routing tables.**
-- The dictionary names none, and the check an assignment needs is a typed
-- lookup at the door (planning §6), not a constraint a rebuild would have to
-- satisfy in fold order. The only foreign keys are the two children's, into
-- this migration's own parent, which is why \`DERIVED_TABLES\` clears them first.
CREATE TABLE model_version_read_model (
  model_version_id          TEXT    NOT NULL,
  provider                  TEXT    NOT NULL,
  model                     TEXT    NOT NULL,
  release                   TEXT    NOT NULL,
  status                    TEXT    NOT NULL,
  context_tokens            INTEGER NOT NULL,
  latest_performance_window TEXT,
  policy_version            TEXT    NOT NULL,
  deprecated_at             TEXT,
  document_version          INTEGER NOT NULL,
  sequence                  INTEGER NOT NULL,
  CONSTRAINT pk_model_version_read_model PRIMARY KEY (model_version_id),
  CONSTRAINT ck_model_version_read_model__status CHECK (
    status IN ('ACTIVE', 'DEPRECATED', 'RETIRED')
  ),
  CONSTRAINT ck_model_version_read_model__context_tokens CHECK (context_tokens >= 0),
  -- An equality of truth values, for the reason migration 15's mirrors are one:
  -- \`status\` is NOT NULL, so neither side can be NULL and the CHECK cannot pass
  -- vacuously.
  CONSTRAINT ck_model_version_read_model__deprecated_pair CHECK (
    (status = 'ACTIVE') = (deprecated_at IS NULL)
  ),
  CONSTRAINT ck_model_version_read_model__document_version CHECK (document_version >= 1),
  CONSTRAINT ck_model_version_read_model__sequence CHECK (sequence >= 1)
) STRICT;

CREATE INDEX ix_model_version_read_model__status
  ON model_version_read_model (status, provider, model);

CREATE TABLE model_version_eligible_role (
  model_version_id TEXT    NOT NULL,
  ordinal          INTEGER NOT NULL,
  role             TEXT    NOT NULL,
  CONSTRAINT pk_model_version_eligible_role PRIMARY KEY (model_version_id, ordinal),
  CONSTRAINT ck_model_version_eligible_role__ordinal CHECK (ordinal >= 0),
  CONSTRAINT fk_model_version_eligible_role__model_version_read_model
    FOREIGN KEY (model_version_id) REFERENCES model_version_read_model (model_version_id)
    ON DELETE RESTRICT
) STRICT;

-- A role is not declared twice under two ordinals.
CREATE UNIQUE INDEX ux_model_version_eligible_role__role
  ON model_version_eligible_role (model_version_id, role);

CREATE TABLE model_version_transport (
  model_version_id TEXT    NOT NULL,
  ordinal          INTEGER NOT NULL,
  transport_kind   TEXT    NOT NULL,
  CONSTRAINT pk_model_version_transport PRIMARY KEY (model_version_id, ordinal),
  CONSTRAINT ck_model_version_transport__ordinal CHECK (ordinal >= 0),
  CONSTRAINT fk_model_version_transport__model_version_read_model
    FOREIGN KEY (model_version_id) REFERENCES model_version_read_model (model_version_id)
    ON DELETE RESTRICT
) STRICT;

-- The same criterion, for transports.
CREATE UNIQUE INDEX ux_model_version_transport__transport
  ON model_version_transport (model_version_id, transport_kind);

-- One watermark, seeded from the head of the REGISTRY stream in migration 15's
-- form. Unlike migration 15's four, the fold over an existing stream is not
-- empty by construction: a ledger may already hold \`MODEL_VERSION\` documents.
-- SQL cannot run the fold, so the code runs it after this text and inside the
-- same transaction (\`afterSql\`, migration 10's precedent), and the rows it
-- writes are exactly the rows a rebuild would. The watermark is level with the
-- head the moment the migration commits, and not a moment before anything can
-- observe it.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  'model_version_read_model',
  'registry_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'registry_head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'registry_event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'registry_head_event_sha256'),
  '1970-01-01T00:00:00.000Z';
`,
  },
  {
    version: 18,
    name: "initiative_registration_detail",
    sql: `
-- An initiative enters by command and by API, and its objective never touches
-- the stream (P-14 escalón B, ADR 0086).
--
-- Planning §1 gives \`initiative_read_model\` three additive columns. \`title\` and
-- \`objective_sha256\` have a producer from this migration on: the registration
-- door records a closed payload — slug, title, the objective's digest and the
-- private reference that names its bytes — and the fold projects the title and
-- the digest from it. \`repository_sha256\` has no semantics in planning §1 and
-- no producer here; it is added because the dictionary adds it, and it stays
-- NULL.
--
-- **Additive, and the table is not rebuilt**, for migration 16's reason: a
-- nullable column with no default is added without rewriting a row. No CHECK
-- and no trigger: the dictionary states none, and the only shape a value can
-- take is the one the fold writes. No watermark moves either — the stream's head
-- does not move — but the rows do not stay as they are: a ledger may already
-- hold a registration in the closed shape, and SQL cannot run the fold, so the
-- code folds the initiative stream again after this text and inside the same
-- transaction (\`afterSql\`, migration 17's precedent), with the same function the
-- door and the rebuild use.
ALTER TABLE initiative_read_model ADD COLUMN title TEXT;
ALTER TABLE initiative_read_model ADD COLUMN objective_sha256 TEXT;
ALTER TABLE initiative_read_model ADD COLUMN repository_sha256 TEXT;
`,
  },
  {
    version: 19,
    name: "task_submission",
    sql: `
-- A task enters once by its client's key, with its revision and its envelope by
-- reference (P-14 escalón C, ADR 0087).
--
-- Contracts §15 gives the request link its idempotency key,
-- UNIQUE(client_scope, client_request_key), and no dictionary gave the pair a
-- home for tasks. Execution §1.1 closes it here: one derived row per task that
-- entered by the intake door, folded from the \`TASK_DISCOVERED\` that opens the
-- task, naming the task, its revision and the envelope digest that revision
-- carries. The digest is not part of the key: it is the precondition a second
-- submission under the same key is compared against.
--
-- **Insert-only, by the fold.** The same key with the same row is a replay and
-- writes nothing; the same key with another row is refused by name before the
-- constraint could abort. Never ON CONFLICT DO UPDATE: a key whose task could be
-- rewritten would make "this request" the name of whichever arrived last.
--
-- **Derived, so no trigger and no foreign key.** The authority is
-- \`control_plane_events\`; a rebuild clears this table and folds it again. The
-- task a row names is born by the same event in the same transaction, so a
-- foreign key would restate the fold's own order.
CREATE TABLE task_submission_read_model (
  client_scope       TEXT    NOT NULL,
  client_request_key TEXT    NOT NULL,
  task_id            TEXT    NOT NULL,
  revision_number    INTEGER NOT NULL,
  envelope_sha256    TEXT    NOT NULL,
  sequence           INTEGER NOT NULL,
  created_at         TEXT    NOT NULL,
  CONSTRAINT ux_task_submission_read_model__request UNIQUE (client_scope, client_request_key),
  CONSTRAINT ck_task_submission_read_model__client_scope CHECK (length(client_scope) > 0),
  CONSTRAINT ck_task_submission_read_model__client_request_key CHECK (length(client_request_key) > 0),
  CONSTRAINT ck_task_submission_read_model__revision_number CHECK (revision_number >= 1),
  CONSTRAINT ck_task_submission_read_model__envelope_sha256 CHECK (
    length(envelope_sha256) = 64 AND envelope_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ck_task_submission_read_model__sequence CHECK (sequence >= 1)
) STRICT;

-- One watermark, seeded from the head of the task stream in migration 11's form.
-- The rows it describes are folded from the stream the code holds, and SQL
-- cannot run the fold, so the code folds the task stream after this text and
-- inside the same transaction (\`afterSql\`, migration 17's precedent): a ledger
-- that already holds an intake event is level with its head the moment the
-- migration commits.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  'task_submission_read_model',
  'control_plane_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'head_event_sha256'),
  '1970-01-01T00:00:00.000Z';
`,
  },
  {
    version: 20,
    name: "usage_capture",
    sql: `
-- Usage is a declared stream and a measured observation, and the door settles
-- them in the same transaction (P-32/captura B, ADR 0089).
--
-- Economy §1.1, §1.2 and §2.1-§2.3, five tables, with the dictionary's CHECK,
-- UNIQUE and INDEX under the names it gives them. Stream, observation and
-- settlement land together because §1.2 \`:81\` writes all three with the append
-- and the head in one transaction: none of them can be cut from the others.
--
-- **Foreign keys.** Every one the dictionary names, and every one
-- \`DEFERRABLE INITIALLY DEFERRED\` for migration 13's reason: a batch may intend
-- a delivery and record its first observation in one transaction, and a
-- settlement names the observation its own event records. Each carries
-- \`ON DELETE RESTRICT\` (datos §8.1) **except the observation's self-reference**,
-- which carries no action. SQLite fires RESTRICT at once even when the key is
-- deferred, so clearing a table whose rows correct one another in one DELETE
-- aborts on whichever target it happens to meet before its corrector; with no
-- action the check waits for the commit, when the table is empty.
--
-- **Digest shape.** Every digest column carries datos §3.4's shape CHECK, the
-- one migration 13 gave the effect's four.
--
-- **No trigger.** Every rule a row can carry is a CHECK; the rules that span
-- rows — the identity recomputed, a correction of the same stream and effect,
-- the coverage, the precedence and the revision's successor — are the door's and
-- the fold's, and the rebuild runs the same fold.
CREATE TABLE usage_measurement_stream_read_model (
  measurement_stream_id       TEXT    NOT NULL,
  source                      TEXT    NOT NULL,
  account_id                  TEXT    NOT NULL,
  route_segment_id            TEXT    NOT NULL,
  source_epoch                INTEGER NOT NULL,
  source_class                TEXT    NOT NULL,
  normalization_policy_sha256 TEXT    NOT NULL,
  sequence                    INTEGER NOT NULL,
  CONSTRAINT pk_usage_measurement_stream PRIMARY KEY (measurement_stream_id),
  CONSTRAINT ck_usage_measurement_stream__measurement_stream_id_shape
    CHECK (length(measurement_stream_id) = 64 AND measurement_stream_id NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT ck_usage_measurement_stream__source_epoch
    CHECK (source_epoch >= 0),
  CONSTRAINT ck_usage_measurement_stream__source_class
    CHECK (source_class IN ('PROVIDER_AUTHORITATIVE','WRAPPER_MEASURED','ESTIMATE')),
  CONSTRAINT ck_usage_measurement_stream__normalization_policy_sha256_shape
    CHECK (length(normalization_policy_sha256) = 64
      AND normalization_policy_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT;

-- A stream is not recycled: one coordinate, one stream.
CREATE UNIQUE INDEX ux_usage_measurement_stream__identity
  ON usage_measurement_stream_read_model (source, account_id, route_segment_id, source_epoch);

CREATE TABLE usage_observation_read_model (
  observation_id          TEXT    NOT NULL,
  measurement_stream_id   TEXT    NOT NULL,
  ordinal                 INTEGER NOT NULL,
  source_observation_id   TEXT    NOT NULL,
  report_kind             TEXT    NOT NULL,
  range_from_counter      INTEGER,
  range_to_counter        INTEGER,
  corrects_observation_id TEXT,
  effect_id               TEXT    NOT NULL,
  is_final                INTEGER NOT NULL,
  input_tokens            INTEGER NOT NULL,
  output_tokens           INTEGER NOT NULL,
  cache_write_tokens      INTEGER NOT NULL,
  cache_read_tokens       INTEGER NOT NULL,
  total_tokens            INTEGER NOT NULL,
  occurred_at             TEXT    NOT NULL,
  recorded_at             TEXT    NOT NULL,
  sequence                INTEGER NOT NULL,
  CONSTRAINT pk_usage_observation PRIMARY KEY (observation_id),
  CONSTRAINT fk_usage_observation__usage_measurement_stream
    FOREIGN KEY (measurement_stream_id)
    REFERENCES usage_measurement_stream_read_model (measurement_stream_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_usage_observation__usage_observation
    FOREIGN KEY (corrects_observation_id)
    REFERENCES usage_observation_read_model (observation_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_usage_observation__effect_read_model
    FOREIGN KEY (effect_id) REFERENCES effect_read_model (effect_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_usage_observation__ordinal
    CHECK (ordinal >= 0),
  CONSTRAINT ck_usage_observation__report_kind
    CHECK (report_kind IN ('DELTA','CUMULATIVE','CORRECTION')),
  CONSTRAINT ck_usage_observation__range_from_counter
    CHECK (range_from_counter IS NULL OR range_from_counter >= 0),
  CONSTRAINT ck_usage_observation__report_shape
    CHECK ((report_kind IN ('DELTA','CUMULATIVE') AND corrects_observation_id IS NULL AND range_from_counter IS NOT NULL AND range_to_counter IS NOT NULL AND range_from_counter < range_to_counter) OR (report_kind = 'CORRECTION' AND corrects_observation_id IS NOT NULL AND range_from_counter IS NULL AND range_to_counter IS NULL)),
  CONSTRAINT ck_usage_observation__is_final
    CHECK (is_final IN (0,1)),
  CONSTRAINT ck_usage_observation__input_tokens
    CHECK (input_tokens >= 0),
  CONSTRAINT ck_usage_observation__output_tokens
    CHECK (output_tokens >= 0),
  CONSTRAINT ck_usage_observation__cache_write_tokens
    CHECK (cache_write_tokens >= 0),
  CONSTRAINT ck_usage_observation__cache_read_tokens
    CHECK (cache_read_tokens >= 0),
  CONSTRAINT ck_usage_observation__total_tokens
    CHECK (total_tokens >= 0)
) STRICT;

CREATE UNIQUE INDEX ux_usage_observation__stream_ordinal
  ON usage_observation_read_model (measurement_stream_id, ordinal);

CREATE UNIQUE INDEX ux_usage_observation__source_report
  ON usage_observation_read_model (measurement_stream_id, source_observation_id);

CREATE INDEX ix_usage_observation__effect
  ON usage_observation_read_model (effect_id, sequence);

CREATE INDEX ix_usage_observation__corrects
  ON usage_observation_read_model (corrects_observation_id);

-- One revision of one effect's settlement. The revision in force is the highest;
-- no earlier one is ever updated to point at its successor.
CREATE TABLE usage_settlement_read_model (
  effect_id            TEXT    NOT NULL,
  settlement_revision  INTEGER NOT NULL,
  settlement_status    TEXT    NOT NULL,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cache_write_tokens   INTEGER,
  cache_read_tokens    INTEGER,
  total_tokens         INTEGER,
  source_policy_sha256 TEXT    NOT NULL,
  fold_version         INTEGER NOT NULL,
  last_observation_id  TEXT,
  had_late_arrival     INTEGER NOT NULL,
  computed_at          TEXT    NOT NULL,
  sequence             INTEGER NOT NULL,
  CONSTRAINT pk_usage_settlement PRIMARY KEY (effect_id, settlement_revision),
  CONSTRAINT fk_usage_settlement__effect_read_model
    FOREIGN KEY (effect_id) REFERENCES effect_read_model (effect_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_usage_settlement__usage_observation
    FOREIGN KEY (last_observation_id) REFERENCES usage_observation_read_model (observation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_usage_settlement__settlement_revision
    CHECK (settlement_revision >= 1),
  CONSTRAINT ck_usage_settlement__settlement_status
    CHECK (settlement_status IN ('FINAL','PARTIAL','UNKNOWN','DISPUTED')),
  CONSTRAINT ck_usage_settlement__input_tokens
    CHECK ((settlement_status IN ('UNKNOWN','DISPUTED') AND input_tokens IS NULL) OR (settlement_status IN ('FINAL','PARTIAL') AND input_tokens IS NOT NULL AND input_tokens >= 0)),
  CONSTRAINT ck_usage_settlement__output_tokens
    CHECK ((settlement_status IN ('UNKNOWN','DISPUTED') AND output_tokens IS NULL) OR (settlement_status IN ('FINAL','PARTIAL') AND output_tokens IS NOT NULL AND output_tokens >= 0)),
  CONSTRAINT ck_usage_settlement__cache_write_tokens
    CHECK ((settlement_status IN ('UNKNOWN','DISPUTED') AND cache_write_tokens IS NULL) OR (settlement_status IN ('FINAL','PARTIAL') AND cache_write_tokens IS NOT NULL AND cache_write_tokens >= 0)),
  CONSTRAINT ck_usage_settlement__cache_read_tokens
    CHECK ((settlement_status IN ('UNKNOWN','DISPUTED') AND cache_read_tokens IS NULL) OR (settlement_status IN ('FINAL','PARTIAL') AND cache_read_tokens IS NOT NULL AND cache_read_tokens >= 0)),
  CONSTRAINT ck_usage_settlement__total_tokens
    CHECK ((settlement_status IN ('UNKNOWN','DISPUTED') AND total_tokens IS NULL) OR (settlement_status IN ('FINAL','PARTIAL') AND total_tokens IS NOT NULL AND total_tokens >= 0)),
  CONSTRAINT ck_usage_settlement__source_policy_sha256_shape
    CHECK (length(source_policy_sha256) = 64 AND source_policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT ck_usage_settlement__fold_version
    CHECK (fold_version >= 1),
  CONSTRAINT ck_usage_settlement__had_late_arrival
    CHECK (had_late_arrival IN (0,1))
) STRICT;

CREATE INDEX ix_usage_settlement__latest
  ON usage_settlement_read_model (effect_id, settlement_revision DESC);

-- The vector of heads a revision was computed at. The control row is the
-- door's; a registry row appears only when a policy is read from that stream,
-- which none is in this build (adjudication Q4).
CREATE TABLE usage_settlement_source_head_read_model (
  effect_id           TEXT    NOT NULL,
  settlement_revision INTEGER NOT NULL,
  source_stream       TEXT    NOT NULL,
  source_sequence     INTEGER NOT NULL,
  source_sha256       TEXT    NOT NULL,
  CONSTRAINT pk_usage_settlement_source_head PRIMARY KEY (effect_id, settlement_revision, source_stream),
  CONSTRAINT fk_usage_settlement_source_head__usage_settlement
    FOREIGN KEY (effect_id, settlement_revision)
    REFERENCES usage_settlement_read_model (effect_id, settlement_revision)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_usage_settlement_source_head__source_stream
    CHECK (source_stream IN ('control_plane_events','registry_events')),
  CONSTRAINT ck_usage_settlement_source_head__source_sequence
    CHECK (source_sequence >= 0),
  CONSTRAINT ck_usage_settlement_source_head__source_sha256_shape
    CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT;

-- Every observation a revision considered: winners, losers and corrected alike.
CREATE TABLE usage_settlement_observation_read_model (
  effect_id           TEXT    NOT NULL,
  settlement_revision INTEGER NOT NULL,
  observation_id      TEXT    NOT NULL,
  CONSTRAINT pk_usage_settlement_observation PRIMARY KEY (effect_id, settlement_revision, observation_id),
  CONSTRAINT fk_usage_settlement_observation__usage_settlement
    FOREIGN KEY (effect_id, settlement_revision)
    REFERENCES usage_settlement_read_model (effect_id, settlement_revision)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_usage_settlement_observation__usage_observation
    FOREIGN KEY (observation_id) REFERENCES usage_observation_read_model (observation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- Five watermarks, seeded from the head of the task stream in migration 19's
-- form. The rows are not empty by construction: every effect a ledger already
-- delivered is exposed, and its first delivery is the trigger of its revision 1
-- (adjudication Q3). SQL cannot run the fold, so the code folds the task stream
-- after this text and inside the same transaction (\`afterSql\`, migration 17's
-- precedent), with the function the door and the rebuild use.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  name,
  'control_plane_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'head_event_sha256'),
  '1970-01-01T00:00:00.000Z'
FROM (
  SELECT 'usage_measurement_stream_read_model' AS name
  UNION ALL SELECT 'usage_observation_read_model'
  UNION ALL SELECT 'usage_settlement_read_model'
  UNION ALL SELECT 'usage_settlement_source_head_read_model'
  UNION ALL SELECT 'usage_settlement_observation_read_model'
);
`,
  },
  {
    version: 21,
    name: "price_interval_catalog",
    sql: `
-- A price interval is published whole by document and version, or not at all
-- (P-33/catálogo escalón A, ADR 0091).
--
-- Economy §3, one table: a row per interval of one \`PRICE_TABLE\` document's
-- version, the document AND the version in the key, so a lookup inside a pinned
-- version never reads another. The stream has carried the document kind since
-- migration 9; nothing folded it. From this migration the append door holds a
-- \`PRICE_TABLE\` to a closed payload and to the model versions the registry
-- holds, and the fold writes its rows in the transaction of its event.
--
-- **No \`ix_price_interval_read_model__lookup\`.** The dictionary's index names
-- the primary key's eight columns in the primary key's order, and the automatic
-- index behind the key already is that index; a second copy would be written on
-- every insert and read by nothing (adjudication Q5, ADR 0091).
--
-- **No foreign key and no trigger.** Not into \`registry_events\`, not into
-- \`model_version_read_model\`: the check a catalog needs is a typed lookup at
-- the door, not a constraint a rebuild would have to satisfy in fold order. The
-- rule that spans rows — no two intervals of one quintuple meet — is the door's
-- and the fold's; no CHECK can state it.
CREATE TABLE price_interval_read_model (
  catalog_document_id     TEXT    NOT NULL,
  catalog_version         INTEGER NOT NULL,
  provider                TEXT    NOT NULL,
  model_version_id        TEXT    NOT NULL,
  transport_kind          TEXT    NOT NULL,
  token_class             TEXT    NOT NULL,
  currency                TEXT    NOT NULL,
  effective_from          TEXT    NOT NULL,
  effective_to            TEXT,
  price_per_million_nanos INTEGER NOT NULL,
  recorded_by             TEXT    NOT NULL,
  sequence                INTEGER NOT NULL,
  CONSTRAINT pk_price_interval_read_model PRIMARY KEY (catalog_document_id, catalog_version, provider, model_version_id, transport_kind, token_class, currency, effective_from),
  CONSTRAINT ck_price_interval_read_model__token_class
    CHECK (token_class IN ('input','output','cache_write','cache_read')),
  CONSTRAINT ck_price_interval_read_model__interval_order
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ck_price_interval_read_model__price_per_million_nanos
    CHECK (price_per_million_nanos >= 0),
  CONSTRAINT ck_price_interval_read_model__currency
    CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  CONSTRAINT ck_price_interval_read_model__catalog_version
    CHECK (catalog_version >= 1),
  CONSTRAINT ck_price_interval_read_model__sequence
    CHECK (sequence >= 1)
) STRICT;

-- One watermark, seeded from the head of the REGISTRY stream in migration 17's
-- form. The fold over an existing stream is not empty by construction: a ledger
-- may already hold \`PRICE_TABLE\` documents. SQL cannot run the fold, so the code
-- runs it after this text and inside the same transaction (\`afterSql\`, migration
-- 17's precedent), with the function the door and the rebuild use.
INSERT INTO projection_watermark
  (projection_name, source_stream, projector_version, applied_sequence, event_count,
   source_head_sha256, updated_at)
SELECT
  'price_interval_read_model',
  'registry_events',
  1,
  CAST((SELECT value FROM ledger_meta WHERE key = 'registry_head_sequence') AS INTEGER),
  CAST((SELECT value FROM ledger_meta WHERE key = 'registry_event_count') AS INTEGER),
  (SELECT value FROM ledger_meta WHERE key = 'registry_head_event_sha256'),
  '1970-01-01T00:00:00.000Z';
`,
  },
  {
    version: 22,
    name: "effect_result_reference",
    sql: `
-- An effect records its result by reference, with its outcome (P-07 escalón B,
-- ADR 0098).
--
-- Contratos §4.2: SUCCEEDED demands a valid, recoverable result. The result is a
-- document whose bytes a \`RESPONSE\` artifact holds, so the effect row names it by
-- that artifact's registered reference and its conserved digest, written in the
-- same event as the outcome, and records which contract version recorded the
-- outcome, because the rule is keyed on a cohort of that version.
--
-- **Additive, and the table is not rebuilt.** Three nullable columns with no
-- default: every row already there reads NULL in each, which is the correct value
-- for the result pair, so no row is rewritten and no index moves. The recording
-- version of a row that already holds an outcome is written from that outcome's
-- own event by code, in this same transaction, after this text runs.
--
-- **What is a CHECK and what is a trigger** (datos §3.7, invariant 13).
-- Version-independent row law is a CHECK: the pair is both NULL or both present,
-- the digest has the common shape, a result exists only on SUCCEEDED or FAILED
-- (spelled with IS NOT NULL, because a CHECK whose predicate is NULL passes and
-- \`NULL IN (...)\` is NULL), and a version implies an outcome. The other half of that last rule — an outcome
-- implies a version — cannot be a CHECK here: SQLite tests a CHECK added by ADD
-- COLUMN against the rows already there, and it would abort on any ledger that
-- holds an outcome before the backfill runs. So it is the triggers' first
-- statement, beside the cohort rule.
ALTER TABLE effect_read_model ADD COLUMN outcome_contract_version TEXT
  CONSTRAINT ck_effect_read_model__outcome_contract_version
    CHECK (outcome_contract_version IS NULL
      OR (outcome_status IS NOT NULL AND length(outcome_contract_version) > 0));

ALTER TABLE effect_read_model ADD COLUMN result_artifact_reference_id TEXT
  CONSTRAINT ck_effect_read_model__result_artifact_reference_id
    CHECK (result_artifact_reference_id IS NULL OR length(result_artifact_reference_id) > 0);

ALTER TABLE effect_read_model ADD COLUMN result_sha256 TEXT
  CONSTRAINT ck_effect_read_model__result_sha256_shape
    CHECK (result_sha256 IS NULL
      OR (length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'))
  CONSTRAINT ck_effect_read_model__result_pair
    CHECK ((result_sha256 IS NULL) = (result_artifact_reference_id IS NULL))
  CONSTRAINT ck_effect_read_model__result_status
    CHECK (result_sha256 IS NULL
      OR (outcome_status IS NOT NULL AND outcome_status IN ('SUCCEEDED', 'FAILED')));

-- The cohort, by trigger, on both paths a row arrives by.
--
-- The cohort before is a CLOSED list frozen here, never a comparison of version
-- strings: the six are every version a build before this migration could stamp,
-- a migration is immutable, and a version bumped later falls into the cohort
-- after without touching this text. The fold's
-- \`PRE_RESULT_REFERENCE_CONTRACT_VERSIONS\` spells the same six, and the suite
-- holds the two spellings equal. An outcome of the cohort before names no result;
-- a SUCCEEDED of the cohort after always names one. \`x NOT IN (...)\` is NULL when
-- \`x\` is NULL, so a status without a version is caught by the first statement
-- and never let through by the third.
--
-- Two triggers, because a rebuild INSERTs a row that already holds its outcome
-- and the door UPDATEs one, and the UPDATE trigger names all four columns so a
-- raw write to the result columns alone is held to the same rule.
--
-- **Existence is not checked here, and cannot be.** Whether the reference names
-- this task's RESPONSE with this digest is a question about a projection of the
-- registry stream; this row is a projection of the task stream, and a rebuild
-- folds one chain at a time. The append door asks it, by name, before it writes.
CREATE TRIGGER tr_effect_read_model__validate_result_on_insert
BEFORE INSERT ON effect_read_model
BEGIN
  SELECT RAISE(ABORT, 'effect_read_model.outcome_contract_version is required on a row that holds an outcome')
  WHERE NEW.outcome_status IS NOT NULL AND NEW.outcome_contract_version IS NULL;

  SELECT RAISE(ABORT, 'effect_read_model.result_artifact_reference_id and result_sha256 must be NULL on an outcome of contract version 2.2.0, 2.3.0, 2.4.0, 2.5.0, 2.6.0 or 2.7.0')
  WHERE NEW.outcome_contract_version IN ('2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0')
    AND NEW.result_sha256 IS NOT NULL;

  SELECT RAISE(ABORT, 'effect_read_model.result_artifact_reference_id and result_sha256 are required on a SUCCEEDED outcome of every later contract version')
  WHERE NEW.outcome_status = 'SUCCEEDED'
    AND NEW.outcome_contract_version NOT IN ('2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0')
    AND NEW.result_sha256 IS NULL;
END;

CREATE TRIGGER tr_effect_read_model__validate_result_on_update
BEFORE UPDATE OF outcome_status, outcome_contract_version, result_artifact_reference_id, result_sha256
ON effect_read_model
BEGIN
  SELECT RAISE(ABORT, 'effect_read_model.outcome_contract_version is required on a row that holds an outcome')
  WHERE NEW.outcome_status IS NOT NULL AND NEW.outcome_contract_version IS NULL;

  SELECT RAISE(ABORT, 'effect_read_model.result_artifact_reference_id and result_sha256 must be NULL on an outcome of contract version 2.2.0, 2.3.0, 2.4.0, 2.5.0, 2.6.0 or 2.7.0')
  WHERE NEW.outcome_contract_version IN ('2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0')
    AND NEW.result_sha256 IS NOT NULL;

  SELECT RAISE(ABORT, 'effect_read_model.result_artifact_reference_id and result_sha256 are required on a SUCCEEDED outcome of every later contract version')
  WHERE NEW.outcome_status = 'SUCCEEDED'
    AND NEW.outcome_contract_version NOT IN ('2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0')
    AND NEW.result_sha256 IS NULL;
END;
`,
  },
  {
    version: 23,
    name: "dispatch_catalog_pin",
    sql: `
-- A delivery pins the price catalog version it will be valued against, before any
-- spend (P-15 escalón C, ADR 0103; execution §7; economy §3 \`:208\`).
--
-- **Additive, and the table is not rebuilt.** Three nullable columns with no
-- default: every row already there reads NULL in each. The pin stays NULL on those
-- rows, which is correct: every delivery a ledger already holds was intended
-- before 2.9.0. The version that bore each row is written from its own
-- \`DISPATCH_INTENDED\` by code, in this same transaction, after this text runs.
--
-- **What is a CHECK and what is a trigger** (datos §3.7, invariant 13).
-- Version-independent row law is a CHECK, each spelled so a NULL cannot pass by
-- accident: a version, when present, is non-empty; a document, when present, is
-- non-empty; a version number, when present, is at least 1; and the pin is both
-- NULL or both present. "A row carries its version" cannot be a CHECK here, for
-- migration 22's reason: SQLite tests a CHECK added by ADD COLUMN against the rows
-- already there, and it would abort on every ledger holding a delivery before the
-- backfill runs. So it is the triggers' first statement, beside the cohort rule.
ALTER TABLE dispatch_attempt_read_model ADD COLUMN dispatch_contract_version TEXT
  CONSTRAINT ck_dispatch_attempt_read_model__dispatch_contract_version
    CHECK (dispatch_contract_version IS NULL OR length(dispatch_contract_version) > 0);

ALTER TABLE dispatch_attempt_read_model ADD COLUMN catalog_document_id TEXT
  CONSTRAINT ck_dispatch_attempt_read_model__catalog_document_id
    CHECK (catalog_document_id IS NULL OR length(catalog_document_id) > 0);

ALTER TABLE dispatch_attempt_read_model ADD COLUMN catalog_version INTEGER
  CONSTRAINT ck_dispatch_attempt_read_model__catalog_version
    CHECK (catalog_version IS NULL OR catalog_version >= 1)
  CONSTRAINT ck_dispatch_attempt_read_model__catalog_pin_pair
    CHECK ((catalog_document_id IS NULL) = (catalog_version IS NULL));

-- The cohort, by trigger, on both paths a row arrives by.
--
-- The cohort before is a CLOSED list frozen here, never a comparison of version
-- strings: the seven are every version a build before this migration could stamp,
-- a migration is immutable, and a version bumped later falls into the cohort after
-- without touching this text. The fold's \`PRE_CATALOG_PIN_CONTRACT_VERSIONS\` spells
-- the same seven, and the suite holds the two spellings equal. A delivery of the
-- cohort before names no pin; one of the cohort after always names one.
-- \`x NOT IN (...)\` is NULL when \`x\` is NULL, so a row without a version is caught
-- by the first statement and never let through by the third.
--
-- Two triggers, because a rebuild INSERTs a row and the backfill UPDATEs one; the
-- UPDATE trigger names all three columns, so a raw write to any of them alone is
-- held to the same rule.
--
-- **Whether the pin is published, in force and covering is not checked here, and
-- cannot be.** Those are questions about a projection of the registry stream; this
-- row is a projection of the task stream, and a rebuild folds one chain at a time.
-- The append door asks them, by name, before it writes.
CREATE TRIGGER tr_dispatch_attempt_read_model__validate_pin_on_insert
BEFORE INSERT ON dispatch_attempt_read_model
BEGIN
  SELECT RAISE(ABORT, 'dispatch_attempt_read_model.dispatch_contract_version is required on every delivery')
  WHERE NEW.dispatch_contract_version IS NULL;

  SELECT RAISE(ABORT, 'dispatch_attempt_read_model.catalog_document_id and catalog_version must be NULL on a delivery of contract version 2.2.0, 2.3.0, 2.4.0, 2.5.0, 2.6.0, 2.7.0 or 2.8.0')
  WHERE NEW.dispatch_contract_version IN ('2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0', '2.8.0')
    AND NEW.catalog_document_id IS NOT NULL;

  SELECT RAISE(ABORT, 'dispatch_attempt_read_model.catalog_document_id and catalog_version are required on a delivery of every later contract version')
  WHERE NEW.dispatch_contract_version NOT IN ('2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0', '2.8.0')
    AND NEW.catalog_document_id IS NULL;
END;

CREATE TRIGGER tr_dispatch_attempt_read_model__validate_pin_on_update
BEFORE UPDATE OF dispatch_contract_version, catalog_document_id, catalog_version
ON dispatch_attempt_read_model
BEGIN
  SELECT RAISE(ABORT, 'dispatch_attempt_read_model.dispatch_contract_version is required on every delivery')
  WHERE NEW.dispatch_contract_version IS NULL;

  SELECT RAISE(ABORT, 'dispatch_attempt_read_model.catalog_document_id and catalog_version must be NULL on a delivery of contract version 2.2.0, 2.3.0, 2.4.0, 2.5.0, 2.6.0, 2.7.0 or 2.8.0')
  WHERE NEW.dispatch_contract_version IN ('2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0', '2.8.0')
    AND NEW.catalog_document_id IS NOT NULL;

  SELECT RAISE(ABORT, 'dispatch_attempt_read_model.catalog_document_id and catalog_version are required on a delivery of every later contract version')
  WHERE NEW.dispatch_contract_version NOT IN ('2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0', '2.8.0')
    AND NEW.catalog_document_id IS NULL;
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

/**
 * Names of the derived tables a rebuild is allowed to clear.
 *
 * The order is load-bearing where a foreign key exists: `foreign_keys` is ON,
 * so `routing_assignment_fallback` is cleared before the assignment rows it
 * references, exactly as `worker_task_read_model` precedes `worker_read_model`.
 * `task_attempt_read_model` precedes `task_revision_read_model` for the same
 * reason: `fk_task_attempt_read_model__task_revision_read_model` points at it.
 */
export const DERIVED_TABLES: readonly string[] = [
  // P-33/catálogo A. No foreign key names it and it names none, so its place is
  // free; it sits beside the registry it is folded with.
  "price_interval_read_model",
  // The P-14 A registry, children first: each child names its model version by
  // an immediate foreign key, so a wrong order aborts the DELETE that caused it.
  "model_version_transport",
  "model_version_eligible_role",
  "model_version_read_model",
  // The P-36/local A cohort, children first: a tombstone names a reference and
  // a blob, a pin and a reference each name a blob. Immediate foreign keys, so a
  // wrong order here aborts the DELETE that caused it. Their other foreign keys
  // point into `registry_events`, which a rebuild never clears.
  "artifact_tombstone_read_model",
  "artifact_pin_read_model",
  "artifact_reference_read_model",
  "artifact_blob_read_model",
  "worker_task_read_model",
  // The P-32/captura B cohort, before D's pair and C's cohort and children first:
  // the list and the vector name a header, the list and a header name an
  // observation, an observation names a stream and an effect, and a header names
  // an effect. `ON DELETE RESTRICT` fires at once even on a deferred key, so a
  // wrong order here aborts the DELETE that caused it.
  "usage_settlement_observation_read_model",
  "usage_settlement_source_head_read_model",
  "usage_settlement_read_model",
  "usage_observation_read_model",
  "usage_measurement_stream_read_model",
  // The P-18/protocolo D pair, before C's cohort and children first for its
  // reason: an answer names a prompt, and a prompt names a delivery, an effect
  // and a segment. Deferred foreign keys again, so a wrong order would surface
  // at commit rather than at the delete that caused it.
  "response_occurrence_read_model",
  "prompt_occurrence_read_model",
  // The P-18/protocolo C cohort, children first: a dispatch names an effect and
  // a segment, an effect names a segment, and a segment names an attempt. The
  // three foreign keys are `DEFERRABLE INITIALLY DEFERRED`, so a wrong order
  // here would not abort a statement — it would surface as a violation at
  // commit, several statements from the delete that caused it.
  "dispatch_attempt_read_model",
  "effect_read_model",
  "execution_route_segment_read_model",
  "task_attempt_read_model",
  "task_revision_read_model",
  // P-14 C. No foreign key names it and it names none, so its place is free; it
  // sits beside the task rows it is folded with.
  "task_submission_read_model",
  "task_read_model",
  "worker_read_model",
  "execution_route_read_model",
  "initiative_read_model",
  "roadmap_version_read_model",
  "routing_assignment_fallback",
  "routing_assignment_read_model",
];

/** Projection names tracked in projection_watermark, for the task stream. */
export const PROJECTION_NAMES: readonly string[] = [
  "task_read_model",
  "worker_read_model",
  "execution_route_read_model",
  // Spelled out here and named `TASK_REVISION_PROJECTION` below, because this
  // list is evaluated before that declaration and the three names above it are
  // literals too. The pair is asserted equal by the suite.
  "task_revision_read_model",
  // The same, for `TASK_ATTEMPT_PROJECTION`. Its position here is free — this
  // list is a roster, not an order — unlike its position in `DERIVED_TABLES`,
  // which a foreign key decides.
  "task_attempt_read_model",
  // The same three times over, for P-18/protocolo C's cohort. Order is free
  // here for the reason above, so these read in the order the dictionary
  // introduces them rather than in the order a rebuild clears them.
  "execution_route_segment_read_model",
  "effect_read_model",
  "dispatch_attempt_read_model",
  // And P-18/protocolo D's pair, in the dictionary's order.
  "prompt_occurrence_read_model",
  "response_occurrence_read_model",
  // And P-14 C's client key, named `TASK_SUBMISSION_PROJECTION` below.
  "task_submission_read_model",
  // And P-32/captura B's five, in economy's order, named below.
  "usage_measurement_stream_read_model",
  "usage_observation_read_model",
  "usage_settlement_read_model",
  "usage_settlement_source_head_read_model",
  "usage_settlement_observation_read_model",
];

/**
 * Projection names tracked in projection_watermark, for the initiative stream.
 *
 * Kept separate from the task stream's names rather than merged into one list,
 * because each set follows its own chain: a projection's `applied_sequence`
 * and `source_head_sha256` only mean anything against the head of the stream
 * it was built from, and stamping an initiative projection with the task head
 * would make both unverifiable.
 */
export const INITIATIVE_PROJECTION_NAMES: readonly string[] = [
  "initiative_read_model",
  "roadmap_version_read_model",
];

/**
 * Projection names tracked in projection_watermark, for the registry stream
 * alone (P-36/local A).
 *
 * The third stream's own roster, kept apart from the other two for their
 * reason. The two-source routing projection is in none of the three lists: it
 * is level with two chains and belongs to neither stream. Spelled out as
 * literals, like the lists above, and asserted equal to the named constants
 * below by the suite.
 */
export const REGISTRY_PROJECTION_NAMES: readonly string[] = [
  "artifact_blob_read_model",
  "artifact_reference_read_model",
  "artifact_pin_read_model",
  "artifact_tombstone_read_model",
  // P-14 A. One name for three tables: the children are folded with their
  // parent, in the same transaction, and no watermark describes a child alone.
  "model_version_read_model",
  // P-33/catálogo A, named `PRICE_INTERVAL_PROJECTION` below.
  "price_interval_read_model",
];

/** The task stream's table name, as `projection_watermark.source_stream` spells it. */
export const TASK_STREAM = "control_plane_events";

/** The initiative stream's table name, in the same vocabulary. */
export const INITIATIVE_STREAM = "initiative_events";

/** The registry stream's table name, in the same vocabulary (P-09/log-C). */
export const REGISTRY_STREAM = "registry_events";

/** The account stream's table name, in the same vocabulary. */
export const ACCOUNT_STREAM = "account_events";

/**
 * The projection that holds one row per revision of a task (P-05/B).
 *
 * Named rather than spelled out at each of its four use sites — the derived
 * table list, the projection names, the source pairs and the fold — for the
 * reason `ROUTING_ASSIGNMENT_PROJECTION` is: a string repeated four times is
 * four chances to typo one of them into a row nothing reads.
 */
export const TASK_REVISION_PROJECTION = "task_revision_read_model";

/**
 * The migration that adds the revision coordinate and its record.
 *
 * Named for the same reason `ACCOUNT_INTEGRITY_MIGRATION` is: the ledger has to
 * hang a preflight off this exact version, and a bare `11` at the hook would be
 * a number nobody could search for.
 */
export const TASK_REVISION_MIGRATION = 11;

/**
 * The projection that holds one row per attempt of one revision (P-18/B).
 *
 * Named rather than spelled out at its use sites, for `TASK_REVISION_PROJECTION`'s
 * reason: a string repeated at the derived-table list, the projection names, the
 * source pairs and the fold is four chances to typo one of them into a row
 * nothing reads.
 */
export const TASK_ATTEMPT_PROJECTION = "task_attempt_read_model";

/**
 * The migration that adds the attempt's own record.
 *
 * Named for the reason `TASK_REVISION_MIGRATION` is: the suite has to hold the
 * number against where the SQL actually sits, and a bare `12` at that assertion
 * would be a number nobody could search for.
 */
export const TASK_ATTEMPT_MIGRATION = 12;

/** The segment of a route, one per handoff within an attempt (P-18/C). */
export const EXECUTION_ROUTE_SEGMENT_PROJECTION = "execution_route_segment_read_model";

/** The logical effect of a run, looked up by its logical key (P-18/C). */
export const EFFECT_PROJECTION = "effect_read_model";

/** One concrete external delivery of one logical effect (P-18/C). */
export const DISPATCH_ATTEMPT_PROJECTION = "dispatch_attempt_read_model";

/**
 * The migration that adds the effect, its deliveries and the segment.
 *
 * Named for the reason `TASK_ATTEMPT_MIGRATION` is: the suite holds the number
 * against where the SQL actually sits, and a bare `13` at that assertion would
 * be a number nobody could search for.
 */
export const EXECUTION_EFFECT_MIGRATION = 13;

/** One prompt sent on one delivery, never keyed by its bytes (P-18/D). */
export const PROMPT_OCCURRENCE_PROJECTION = "prompt_occurrence_read_model";

/** The one answer to one prompt occurrence (P-18/D). */
export const RESPONSE_OCCURRENCE_PROJECTION = "response_occurrence_read_model";

/**
 * The migration that adds the prompt and response occurrences.
 *
 * Named for `EXECUTION_EFFECT_MIGRATION`'s reason: a bare `14` at the suite's
 * assertion would be a number nobody could search for.
 */
export const EXECUTION_OCCURRENCE_MIGRATION = 14;

/** Metadata of one generation of some bytes (P-36/local A, artifacts §3). */
export const ARTIFACT_BLOB_PROJECTION = "artifact_blob_read_model";

/** One authorized access to one blob generation (P-36/local A, artifacts §4). */
export const ARTIFACT_REFERENCE_PROJECTION = "artifact_reference_read_model";

/** One protection of one blob generation from collection (P-36/local A, artifacts §5). */
export const ARTIFACT_PIN_PROJECTION = "artifact_pin_read_model";

/** The revocation of one reference; written by nothing in this build (artifacts §6). */
export const ARTIFACT_TOMBSTONE_PROJECTION = "artifact_tombstone_read_model";

/**
 * The migration that rebuilds `registry_events` with a subject kind and adds the
 * four artifact read models.
 *
 * Named for `EXECUTION_OCCURRENCE_MIGRATION`'s reason: the suite and the rewind
 * fixtures hold the number against where the SQL actually sits.
 */
export const ARTIFACT_REGISTRY_MIGRATION = 15;

/**
 * The migration that gives a revision its envelope reference by cohort
 * (P-36/local D, decision 41).
 *
 * Named for `ARTIFACT_REGISTRY_MIGRATION`'s reason: the suite and the rewind
 * fixtures hold the number against where the SQL actually sits.
 */
export const TASK_REVISION_ENVELOPE_REFERENCE_MIGRATION = 16;

/** The one registry of model versions, folded from `MODEL_VERSION` documents (P-14 A, accounts §6). */
export const MODEL_VERSION_PROJECTION = "model_version_read_model";

/**
 * The migration that creates the model version registry (P-14 A, ADR 0085).
 *
 * Named for `TASK_REVISION_ENVELOPE_REFERENCE_MIGRATION`'s reason, and for one
 * of its own: the ledger hangs the retroactive fold off this exact version.
 */
export const MODEL_VERSION_REGISTRY_MIGRATION = 17;

/**
 * The migration that gives the initiative projection its three additive
 * columns (P-14 B, ADR 0086).
 *
 * Named for `MODEL_VERSION_REGISTRY_MIGRATION`'s reasons: the suite and the
 * rewind fixtures hold the number against where the SQL sits, and the ledger
 * hangs the retroactive fold of the initiative stream off this exact version.
 */
export const INITIATIVE_REGISTRATION_MIGRATION = 18;

/**
 * The projection that holds one row per client key a task entered under (P-14 C,
 * contracts §15, execution §1.1).
 */
export const TASK_SUBMISSION_PROJECTION = "task_submission_read_model";

/**
 * The migration that creates the task submission projection (P-14 C, ADR 0087).
 *
 * Named for `INITIATIVE_REGISTRATION_MIGRATION`'s reasons: the suite and the
 * rewind fixtures hold the number against where the SQL sits, and the ledger
 * hangs the retroactive fold of the task stream off this exact version.
 */
export const TASK_SUBMISSION_MIGRATION = 19;

/** One declared measurement stream (P-32/captura B, economy §1.1). */
export const USAGE_MEASUREMENT_STREAM_PROJECTION = "usage_measurement_stream_read_model";

/** One usage observation (P-32/captura B, economy §1.2). */
export const USAGE_OBSERVATION_PROJECTION = "usage_observation_read_model";

/** One settlement revision's header (P-32/captura B, economy §2.1). */
export const USAGE_SETTLEMENT_PROJECTION = "usage_settlement_read_model";

/** The vector of heads a settlement revision was computed at (economy §2.2). */
export const USAGE_SETTLEMENT_SOURCE_HEAD_PROJECTION = "usage_settlement_source_head_read_model";

/** The observations a settlement revision considered (economy §2.3). */
export const USAGE_SETTLEMENT_OBSERVATION_PROJECTION = "usage_settlement_observation_read_model";

/**
 * The migration that creates the usage capture cohort (P-32/captura B, ADR 0089).
 *
 * Named for `TASK_SUBMISSION_MIGRATION`'s reasons: the suite and the rewind
 * fixtures hold the number against where the SQL sits, and the ledger hangs the
 * retroactive fold of the task stream's exposures off this exact version.
 */
export const USAGE_CAPTURE_MIGRATION = 20;

/** One interval of one price catalog version (P-33/catálogo A, economy §3). */
export const PRICE_INTERVAL_PROJECTION = "price_interval_read_model";

/**
 * The migration that creates the price interval catalog (P-33/catálogo A, ADR 0091).
 *
 * Named for `USAGE_CAPTURE_MIGRATION`'s reasons: the suite and the rewind fixtures
 * hold the number against where the SQL sits, and the ledger hangs the
 * retroactive fold of the registry's `PRICE_TABLE` documents off this exact version.
 */
export const PRICE_INTERVAL_CATALOG_MIGRATION = 21;

/**
 * The migration that gives an effect its result reference (P-07 escalón B, ADR 0098).
 *
 * Named for `PRICE_INTERVAL_CATALOG_MIGRATION`'s reasons: the suite and the rewind
 * fixtures hold the number against where the SQL sits, and the ledger hangs the
 * backfill of every recorded outcome's version off this exact version.
 */
export const EFFECT_RESULT_REFERENCE_MIGRATION = 22;

/**
 * The migration that gives a delivery its price catalog pin (P-15 escalón C, ADR 0103).
 *
 * Named for `EFFECT_RESULT_REFERENCE_MIGRATION`'s reasons: the suite and the rewind
 * fixtures hold the number against where the SQL sits, and the ledger hangs the
 * backfill of every recorded delivery's version off this exact version.
 */
export const DISPATCH_CATALOG_PIN_MIGRATION = 23;

/**
 * The migration that creates the account integrity sidecar (P-08/A2).
 *
 * Named rather than written as a literal at the two sites that need it, because
 * those two sites are a preflight and a retroactive load that must run for this
 * migration and no other, and a bare `10` at either would be a number nobody
 * could search for.
 */
export const ACCOUNT_INTEGRITY_MIGRATION = 10;

/**
 * The one projection this build folds from more than one stream.
 *
 * Named on its own rather than added to either stream's name list, because it
 * belongs to neither: it has a watermark row per stream, and the lists above
 * exist precisely to keep a projection level with the single chain it follows.
 */
export const ROUTING_ASSIGNMENT_PROJECTION = "routing_assignment_read_model";

/**
 * The fold algorithm's generation.
 *
 * A change to how any projection is folded is a change to what the derived
 * tables mean, and rows written by an older algorithm are not rows this build
 * would have written. Bumping this invalidates the derived tables without
 * touching a single event: the stream is the authority and is not versioned by
 * this number.
 */
export const PROJECTOR_VERSION = 1;

/** One projection, and the one stream it folds. */
export interface ProjectionSource {
  readonly projectionName: string;
  readonly sourceStream: string;
}

/**
 * The closed set of watermark rows this build publishes.
 *
 * Written out in full rather than derived from the two name lists above, so
 * that the lists and the pairs are two independent declarations of the same
 * fact and a test can hold them against each other. A name that gained a
 * stream, or lost one, would show up as a disagreement rather than as a
 * silently regenerated set.
 *
 * `account_events` is deliberately absent, and the reason has moved (P-09
 * adjudication D3, reconciled by P-08 U3). D3 excluded it because the stream
 * had no chain to verify a `source_head_sha256` against; P-08 gave it one, in
 * the `account_event_integrity` sidecar, so that reason is spent.
 *
 * What keeps it absent now is the other half of the pair: a watermark row is
 * `(projection, stream)`, and **no projection of accounts exists**. Inventing
 * one to fill a row would be a read model built to satisfy a table rather than
 * to answer a question. The pair is seeded by the first packet that creates an
 * account read model; until then nothing is blocked, because nothing consumes
 * an account watermark — `listAccountActions` reads the stream directly.
 *
 * The last two rows are one projection, twice (P-09/log-C). That is what the
 * composite key was built for: `routing_assignment_read_model` folds
 * `registry_events` into its `GLOBAL` partition and `initiative_events` into
 * its `INITIATIVE`/`STEP` partition, so it has two independent heads and no
 * single number describes it. Every other name here appears exactly once, and
 * a test holds that difference.
 */
export const PROJECTION_SOURCES: readonly ProjectionSource[] = [
  { projectionName: "task_read_model", sourceStream: TASK_STREAM },
  { projectionName: "worker_read_model", sourceStream: TASK_STREAM },
  { projectionName: "execution_route_read_model", sourceStream: TASK_STREAM },
  { projectionName: TASK_REVISION_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: TASK_ATTEMPT_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: EXECUTION_ROUTE_SEGMENT_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: EFFECT_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: DISPATCH_ATTEMPT_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: PROMPT_OCCURRENCE_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: RESPONSE_OCCURRENCE_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: TASK_SUBMISSION_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: USAGE_MEASUREMENT_STREAM_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: USAGE_OBSERVATION_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: USAGE_SETTLEMENT_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: USAGE_SETTLEMENT_SOURCE_HEAD_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: USAGE_SETTLEMENT_OBSERVATION_PROJECTION, sourceStream: TASK_STREAM },
  { projectionName: "initiative_read_model", sourceStream: INITIATIVE_STREAM },
  { projectionName: "roadmap_version_read_model", sourceStream: INITIATIVE_STREAM },
  { projectionName: ARTIFACT_BLOB_PROJECTION, sourceStream: REGISTRY_STREAM },
  { projectionName: ARTIFACT_REFERENCE_PROJECTION, sourceStream: REGISTRY_STREAM },
  { projectionName: ARTIFACT_PIN_PROJECTION, sourceStream: REGISTRY_STREAM },
  { projectionName: ARTIFACT_TOMBSTONE_PROJECTION, sourceStream: REGISTRY_STREAM },
  { projectionName: MODEL_VERSION_PROJECTION, sourceStream: REGISTRY_STREAM },
  { projectionName: PRICE_INTERVAL_PROJECTION, sourceStream: REGISTRY_STREAM },
  { projectionName: ROUTING_ASSIGNMENT_PROJECTION, sourceStream: REGISTRY_STREAM },
  { projectionName: ROUTING_ASSIGNMENT_PROJECTION, sourceStream: INITIATIVE_STREAM },
];

// A `SINGLE_SOURCE_PROJECTION_SOURCES` derived from the list above used to
// stand here, documented as "the pairs `status()` publishes": while the status
// DTO carried one head per projection, the two-source projection had to be
// omitted from it, and that subset was how. P-09/log-D gave the DTO a vector of
// heads, so every pair above is published and the subset has no meaning left.
// It is removed rather than kept with a corrected comment, because a second
// list of which pairs are real is a second source of truth about the first.

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
  // V2-B1c. A derived table, so it carries no append-only trigger: the
  // authority is `control_plane_events`, and this is a fold over it that
  // `rebuildReadModel` is allowed to drop and rewrite.
  { type: "table", name: "execution_route_read_model" },
  { type: "index", name: "execution_route_read_model_by_policy_version" },
  { type: "index", name: "execution_route_read_model_by_account" },
  // P-09/log-A. Derived bookkeeping, so no append-only trigger and, for now,
  // no index: the composite primary key is the only access path, and SQLite's
  // own automatic index for it carries the reserved prefix this inventory
  // excludes.
  { type: "table", name: "projection_watermark" },
  // P-09/log-B. The two triggers that impose the digest shape and the causal
  // triple on new rows. They are inventoried for exactly the reason the
  // append-only triggers are: dropping one leaves `schema_migrations` intact,
  // and the columns would still be there to be filled with a reference that
  // resolves to nothing. Migration 8 adds columns, so the inventory gains no
  // table and no index — a column is not a schema object here.
  { type: "trigger", name: "tr_control_plane_events__validate_new_rows" },
  { type: "trigger", name: "tr_initiative_events__validate_new_rows" },
  // P-09/log-C. The third stream, complete from its first migration: the
  // append-only pair for the same reason the other two streams carry it, and a
  // third trigger for the one rule a CHECK cannot express — resolving a causal
  // reference against the row it names. All three follow the §3.2 convention
  // rather than the legacy `<table>_deny_*` of the first three streams, whose
  // names are frozen inside applied migrations. Migration 9 also drops and
  // recreates the two triggers above under the same names, so the inventory
  // does not move for them; what would be invisible without this list is the
  // removal of any of the three below.
  { type: "table", name: "registry_events" },
  { type: "index", name: "ux_registry_events__document_id__document_version" },
  { type: "index", name: "ix_registry_events__document_kind__document_id__document_version" },
  { type: "index", name: "ix_registry_events__document_id__effective_from" },
  // P-36/local A. Migration 15 rebuilds the table under the same name and
  // recreates every object above and below under the same names, so the
  // inventory moves by exactly this one index.
  { type: "index", name: "ix_registry_events__subject_kind__document_id" },
  { type: "trigger", name: "tr_registry_events__deny_update" },
  { type: "trigger", name: "tr_registry_events__deny_delete" },
  { type: "trigger", name: "tr_registry_events__validate_new_rows" },
  // Derived, so no append-only trigger: the two authorities are
  // `registry_events` and `initiative_events`, and this is a fold over both
  // that `rebuildReadModel` may drop and rewrite. The partial unique indexes
  // are inventoried by name like any other; the automatic index behind each
  // primary key carries the reserved prefix this inventory excludes.
  { type: "table", name: "routing_assignment_read_model" },
  { type: "index", name: "ux_routing_assignment_read_model__global" },
  { type: "index", name: "ux_routing_assignment_read_model__scoped" },
  { type: "index", name: "ix_routing_assignment_read_model__resolution" },
  { type: "table", name: "routing_assignment_fallback" },
  // P-08/A2. The account stream's hash chain, beside the stream because
  // migration 5 is applied and cannot gain a column. Inventoried for the
  // reason the append-only triggers are: dropping one leaves
  // `schema_migrations` intact and no other check would notice. The unique
  // index is here too — it is the constraint migration 5 did not impose, and
  // its absence would be invisible while the door kept refusing duplicates
  // through a derivation the base cannot see.
  { type: "table", name: "account_event_integrity" },
  { type: "index", name: "ux_account_event_integrity__event_sha256" },
  { type: "trigger", name: "tr_account_event_integrity__deny_update" },
  { type: "trigger", name: "tr_account_event_integrity__deny_delete" },
  { type: "index", name: "ux_account_events__account_id__version" },
  { type: "trigger", name: "tr_control_plane_events__validate_v2_coordinate" },
  { type: "table", name: "task_revision_read_model" },
  { type: "index", name: "ux_task_revision_read_model__revision_id" },
  { type: "index", name: "ix_task_revision_read_model__envelope_sha256" },
  // P-18/protocolo B. Three objects and no trigger: the pairing rule between
  // `payload.legacyAttemptNumber` and the `attempt` column is held by the
  // append door as a typed refusal, not by a fourth `tr_` (ADR 0073). Both
  // indexes are inventoried by name, because they are the bijection — dropping
  // either leaves `schema_migrations` intact while the read model quietly
  // admits two invocations for one attempt.
  { type: "table", name: "task_attempt_read_model" },
  { type: "index", name: "ux_task_attempt_read_model__task_id_legacy_attempt_number" },
  { type: "index", name: "ux_task_attempt_read_model__invocation_id" },
  // P-18/protocolo C. Ten objects and no trigger: every pairing rule of
  // migration 13 is a CHECK the base evaluates on the row in front of it, which
  // migration 11's coordinate rule could not be because it had to compare a
  // column against a JSON body. Each index is inventoried by name for the
  // reason the attempt's two are: dropping one leaves `schema_migrations`
  // intact while the read model quietly admits two effects for one logical
  // operation, or two deliveries at one ordinal.
  { type: "table", name: "execution_route_segment_read_model" },
  { type: "index", name: "ux_execution_route_segment_read_model__attempt_segment" },
  { type: "index", name: "ix_execution_route_segment_read_model__account" },
  { type: "table", name: "effect_read_model" },
  { type: "index", name: "ux_effect_read_model__idempotency_key" },
  { type: "index", name: "ux_effect_read_model__logical_operation_sha256" },
  { type: "index", name: "ix_effect_read_model__segment" },
  { type: "table", name: "dispatch_attempt_read_model" },
  { type: "index", name: "ux_dispatch_attempt_read_model__effect_ordinal" },
  { type: "index", name: "ix_dispatch_attempt_read_model__state" },
  // P-18/protocolo D. Five objects and no trigger. The digest index is
  // inventoried by name although it is not unique: dropping it would not admit
  // a bad row, but it is the index §8 names on purpose, and its absence would
  // turn "which occurrences sent these bytes" into a table scan nobody sees.
  { type: "table", name: "prompt_occurrence_read_model" },
  { type: "index", name: "ix_prompt_occurrence_read_model__segment" },
  { type: "index", name: "ix_prompt_occurrence_read_model__sha256" },
  { type: "table", name: "response_occurrence_read_model" },
  { type: "index", name: "ux_response_occurrence_read_model__prompt" },
  // P-36/local A. Four tables, nine indexes and no trigger: every rule a row can
  // carry is a CHECK, and the rules spanning two tables are the fold's and the
  // door's. The partial unique indexes are the invariants — one unreclaimed
  // generation per content, one live pin per holder — and are inventoried by
  // name for the reason every other unique index is.
  { type: "table", name: "artifact_blob_read_model" },
  { type: "index", name: "ix_artifact_blob_read_model__lifecycle_state" },
  { type: "index", name: "ix_artifact_blob_read_model__first_published_sequence" },
  { type: "index", name: "ux_artifact_blob_read_model__reclaim_id" },
  { type: "index", name: "ux_artifact_blob_read_model__content_sha256__unreclaimed" },
  { type: "table", name: "artifact_reference_read_model" },
  { type: "index", name: "ix_artifact_reference_read_model__content_sha256" },
  { type: "index", name: "ix_artifact_reference_read_model__scope_kind_scope_id" },
  { type: "index", name: "ix_artifact_reference_read_model__expires_at" },
  { type: "index", name: "ux_artifact_reference_read_model__id_content_generation" },
  { type: "table", name: "artifact_pin_read_model" },
  { type: "index", name: "ux_artifact_pin_read_model__content_sha256_holder__live" },
  { type: "table", name: "artifact_tombstone_read_model" },
  // P-36/local D. One trigger and nothing else: migration 16 adds a column, and a
  // column is not a schema object here. Inventoried for the reason every `tr_`
  // is — dropping it leaves `schema_migrations` intact while the table quietly
  // admits a revision of the new cohort with no reference, or one of the old
  // cohort with a reference no build of its contract could have named.
  { type: "trigger", name: "tr_task_revision_read_model__validate_envelope_reference" },
  // P-14 A. Three tables, three indexes and no trigger: every rule a row can
  // carry is a CHECK, and the rule spanning an assignment and a version is the
  // door's. The two unique indexes are the "declared once" of accounts §6.1 and
  // are inventoried by name for the reason every other unique index is.
  { type: "table", name: "model_version_read_model" },
  { type: "index", name: "ix_model_version_read_model__status" },
  { type: "table", name: "model_version_eligible_role" },
  { type: "index", name: "ux_model_version_eligible_role__role" },
  { type: "table", name: "model_version_transport" },
  { type: "index", name: "ux_model_version_transport__transport" },
  // P-14 C. One table and nothing else: the client key's uniqueness is a table
  // constraint, whose automatic index carries the reserved prefix this inventory
  // excludes, and the rule a second submission is held to is the fold's.
  { type: "table", name: "task_submission_read_model" },
  // P-32/captura B. Five tables, six indexes and no trigger: every rule a row can
  // carry is a CHECK, and the rules spanning rows are the door's and the fold's.
  // Each unique index is inventoried by name for the reason every other is —
  // dropping `ux_usage_observation__stream_ordinal` leaves `schema_migrations`
  // intact while the table quietly admits two reports at one ordinal — and the
  // two plain ones because they are the dictionary's access paths.
  { type: "table", name: "usage_measurement_stream_read_model" },
  { type: "index", name: "ux_usage_measurement_stream__identity" },
  { type: "table", name: "usage_observation_read_model" },
  { type: "index", name: "ux_usage_observation__stream_ordinal" },
  { type: "index", name: "ux_usage_observation__source_report" },
  { type: "index", name: "ix_usage_observation__effect" },
  { type: "index", name: "ix_usage_observation__corrects" },
  { type: "table", name: "usage_settlement_read_model" },
  { type: "index", name: "ix_usage_settlement__latest" },
  { type: "table", name: "usage_settlement_source_head_read_model" },
  { type: "table", name: "usage_settlement_observation_read_model" },
  // P-33/catálogo A. One table and nothing else: the dictionary's lookup index
  // is the primary key's own, whose automatic index carries the reserved prefix
  // this inventory excludes (adjudication Q5), and the rule spanning rows is the
  // door's and the fold's.
  { type: "table", name: "price_interval_read_model" },
  // P-07 escalón B. Two triggers and nothing else: migration 22 adds three columns,
  // and a column is not a schema object here. Inventoried for the reason every `tr_`
  // is — dropping either leaves `schema_migrations` intact while the table quietly
  // admits a SUCCEEDED with no result, or a result on an outcome of the cohort before.
  { type: "trigger", name: "tr_effect_read_model__validate_result_on_insert" },
  { type: "trigger", name: "tr_effect_read_model__validate_result_on_update" },
  // P-15 escalón C. Two triggers and nothing else, for migration 22's reason:
  // dropping either leaves `schema_migrations` intact while the table quietly
  // admits a delivery of 2.9.0 with no pin, or a pin on one of the cohort before.
  { type: "trigger", name: "tr_dispatch_attempt_read_model__validate_pin_on_insert" },
  { type: "trigger", name: "tr_dispatch_attempt_read_model__validate_pin_on_update" },
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
export interface MigrationHooks {
  /**
   * Runs immediately before one migration's SQL, inside the same transaction.
   *
   * For a check that must see the schema as it was: P-08's duplicate preflight
   * counts violations of a uniqueness the migration is about to impose, and has
   * to do so before the `CREATE UNIQUE INDEX` turns the count into an opaque
   * constraint failure.
   */
  readonly beforeSql?: ((migration: Migration) => void) | undefined;
  /**
   * Runs immediately after one migration's SQL and before its row is recorded,
   * inside the same transaction.
   *
   * For work the SQL cannot do itself. P-08's retroactive hash load is the
   * case: SQLite has no SHA-256 here, so the migration creates the sidecar and
   * the code fills it — in this transaction, so a half-activated ledger is not
   * a state anything can observe.
   */
  readonly afterSql?: ((migration: Migration) => void) | undefined;
}

export function applyMigrations(
  db: Database.Database,
  pending: readonly Migration[],
  appliedAt: string,
  hooks: MigrationHooks = {},
): void {
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of pending) {
    hooks.beforeSql?.(migration);
    db.exec(migration.sql);
    hooks.afterSql?.(migration);
    insert.run(migration.version, migration.name, migration.sha256, appliedAt);
  }
}
