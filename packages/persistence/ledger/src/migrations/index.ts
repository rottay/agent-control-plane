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
 */
export const DERIVED_TABLES: readonly string[] = [
  "worker_task_read_model",
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

/** The task stream's table name, as `projection_watermark.source_stream` spells it. */
export const TASK_STREAM = "control_plane_events";

/** The initiative stream's table name, in the same vocabulary. */
export const INITIATIVE_STREAM = "initiative_events";

/** The registry stream's table name, in the same vocabulary (P-09/log-C). */
export const REGISTRY_STREAM = "registry_events";

/** The account stream's table name, in the same vocabulary. */
export const ACCOUNT_STREAM = "account_events";

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
  { projectionName: "initiative_read_model", sourceStream: INITIATIVE_STREAM },
  { projectionName: "roadmap_version_read_model", sourceStream: INITIATIVE_STREAM },
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
