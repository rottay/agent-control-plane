import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { isSha256Hex } from "@acp/contracts";

import { sha256Hex } from "../canonical-json/index.js";
import {
  LedgerClosedError,
  LedgerIntegrityError,
  LedgerMigrationError,
  LedgerOpenError,
  LedgerQueryError,
} from "../errors/index.js";

import type {
  ArtifactBlobLeaseGrant,
  ArtifactBlobLeaseIncarnation,
  ArtifactBlobLeaseOperation,
  ArtifactBlobLeaseOutcome,
  ArtifactBlobLeaseQuiescence,
  ArtifactBlobLeaseQuiescenceBasis,
  ArtifactBlobLeaseRefusal,
  ArtifactBlobLeaseRow,
  ArtifactBlobLeaseStore,
  ArtifactBlobLeaseToken,
  LeaseMigration,
  OpenArtifactBlobLeaseStoreOptions,
  RawMeta,
  RawRow,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf,
 * `./types/index.ts`, and are re-exported here unchanged so every importer
 * keeps reading them from this module (owner law §7, ADR 0088 errata,
 * decision 90; `outbox-store`'s and `projection`'s precedent).
 */
export type {
  ArtifactBlobLeaseOperation,
  ArtifactBlobLeaseRefusal,
  ArtifactBlobLeaseQuiescenceBasis,
  ArtifactBlobLeaseIncarnation,
  ArtifactBlobLeaseRow,
  ArtifactBlobLeaseToken,
  ArtifactBlobLeaseGrant,
  ArtifactBlobLeaseQuiescence,
  ArtifactBlobLeaseOutcome,
  ArtifactBlobLeaseTestFaults,
  OpenArtifactBlobLeaseStoreOptions,
  ArtifactBlobLeaseStore,
} from "./types/index.js";


/**
 * The artifact blob lease store — P-36/local escalón B.
 *
 * ## What this is, and the one thing it is not
 *
 * The exclusion artifacts §8 acquires **first**: one operation at a time on one
 * blob, held from before the intention is recorded until after the filesystem
 * has finished. It is artifacts §7's `artifact_blob_lease`, in a file of its
 * own, with no history and a monotonic generation. It is **not** a read model
 * and it reads none: the blob's state — staged, published, deduplicated — is
 * consulted by the publisher inside the ledger's own append, which is step 2 of
 * §8. This module does not import the ledger and cannot see its tables.
 * Coordination §1 says it plainly: the ledger and these files share no
 * transaction, and none is claimed.
 *
 * ## The mould, and what it could not give
 *
 * The file shape is the outbox's (P-18/protocolo E2, ADR 0074): a separate
 * SQLite database with its own checksummed migration list under its own
 * bookkeeping name, `coordination_store_meta` as migration 1 before the table it
 * governs, an incarnation that is a **required** argument with no adoption
 * window, `STRICT` throughout, no clock, no environment, no `DELETE`, one
 * producer of the path, and the rule-shaped wrong-file guard. It is not the
 * lease store's shape: that one was a retrofit, and coordination §8.1 says of
 * this store that it is born with its state and nullity CHECKs and its token
 * validators.
 *
 * What the outbox does not have is the decision taken inside the lock. An
 * outbox row is carried across a dispatch and needs a version to close the
 * window; a blob lease is decided in one `BEGIN IMMEDIATE`, where the read, the
 * comparison and the write are one unit — the worktree arbiter's mechanism. So
 * every verb here is one immediate transaction, and the token is the pair
 * coordination §8.1 names for this store: `(store_incarnation_id, generation)`,
 * plus the identity of the holder.
 *
 * ## The generation, by mutation
 *
 * Artifacts §7 `:217` and coordination §3 `:90-107`, and the schema's update
 * trigger is where the rule lives:
 *
 * - a first grant inserts the row at generation 1;
 * - a new holding — a grant over a free row, or a take-over of a held one —
 *   advances it by exactly one;
 * - an ordinary release conserves it; a revocation advances it by one;
 * - a write that keeps the same holding conserves it, and a free row stays at
 *   the generation it was freed at.
 *
 * The row is never deleted. A release clears the holding and keeps the number,
 * which is what makes it monotonic across a release and a re-grant: a holder
 * that wakes up after somebody else was granted finds a generation it was never
 * issued.
 *
 * ## No verb releases by the clock
 *
 * Artifacts §7 `:224` and §9 `:343-347`: expiring **does not concede the blob to
 * another** — it enables reconciliation. There is no `sweep` here. The one verb
 * that takes an instant, {@link ArtifactBlobLeaseStore.listOverdue}, reads and
 * returns and mutates nothing.
 *
 * ## What the store proves, and what it only names
 *
 * It cannot prove quiescence. It reads no process and no clock, so whether a
 * holder is dead and reaped, or whether a backend refuses its stale fence, is a
 * fact about the world this module has no instrument for. What it does instead
 * is **refuse to be asked without it**: the two verbs that end somebody else's
 * holding — {@link ArtifactBlobLeaseStore.revoke} and
 * {@link ArtifactBlobLeaseStore.takeOver} — take a quiescence attestation as a
 * required argument, and the store checks the one thing about it that is a fact
 * about this file: that it names the process the row actually records. Beyond
 * that it guarantees a compare-and-set against the incarnation and generation
 * the caller observed, so two reconcilers never both take a blob.
 *
 * The ordinary release is the holder's own, and it asks for the whole token and
 * the holder's identity (§8.1 `:391`), never the number alone.
 *
 * ## Refusals are values
 *
 * Everything a caller must act on — the blob is held, the token is superseded,
 * the identity does not match — is returned, never thrown. That is this
 * package's standing rule, and it is why the ledger's error classes do not move
 * for this module. The refusal words name facts about this file rather than
 * policy, so the policy stays with the caller that has it. A malformed argument
 * throws, because a caller can fix it; a write that changed more than one row
 * throws, because that is a broken primary key rather than a refusal.
 *
 * ## `PUBLISH` and `RECLAIM`, as data
 *
 * Both words of artifacts §2's `blob_lease_operation` are admitted, by the same
 * mechanism: one holding per digest, whichever operation it is. Refusing
 * `RECLAIM` here would be a substrate legislating a policy — collection is
 * P-36 completo — and it would make the negative §9 `:349-352` names (a
 * collector checks, a publisher pins, the collector unlinks) something this
 * store could not exclude. It excludes it by construction.
 *
 * ## Inert
 *
 * Nothing calls this. The publisher and the reconciler are escalón C's, and this
 * store lands first and alone, exactly as the outbox landed before its saga.
 */

/** What is being done under the exclusive generation. Two values, closed; artifacts §2. */
export const ARTIFACT_BLOB_LEASE_OPERATIONS = ["PUBLISH", "RECLAIM"] as const;


/**
 * Why a verb declined. Facts about this file, never policy words.
 *
 * - `HELD` — another holding stands on this digest.
 * - `OPERATION_ID_IN_USE` — the operation id already holds another digest.
 * - `NOT_HELD` — the token names a holding, and the row carries none.
 * - `INCARNATION_SUPERSEDED` — the token was issued under another incarnation of
 *   this file.
 * - `GENERATION_SUPERSEDED` — the generation has moved since the token was
 *   issued.
 * - `HOLDER_MISMATCH` — the generation matches and the identity does not.
 * - `QUIESCENCE_OF_ANOTHER_PROCESS` — the attestation names a process the row
 *   does not record.
 */
export const ARTIFACT_BLOB_LEASE_REFUSALS = [
  "HELD",
  "OPERATION_ID_IN_USE",
  "NOT_HELD",
  "INCARNATION_SUPERSEDED",
  "GENERATION_SUPERSEDED",
  "HOLDER_MISMATCH",
  "QUIESCENCE_OF_ANOTHER_PROCESS",
] as const;


/**
 * The two grounds on which a holding may be ended by somebody other than its
 * holder. Artifacts §9 `:343-347` and coordination §8.2 step 3: proven death and
 * reap of the previous holder, or a backend that effectively refuses its stale
 * fence. Anything less is uncertainty, and uncertainty stops the procedure.
 */
export const ARTIFACT_BLOB_LEASE_QUIESCENCE_BASES = [
  "DEATH_AND_REAP_PROVEN",
  "STALE_FENCE_REFUSED_BY_BACKEND",
] as const;


/**
 * The largest generation this build will carry a row to.
 *
 * Every caller reads the number through JavaScript, where integers stop being
 * distinguishable above 2^53 - 1, and a generation that cannot be compared is
 * not a fence. The schema's trigger refuses the step past it.
 */
export const MAX_ARTIFACT_BLOB_LEASE_GENERATION = Number.MAX_SAFE_INTEGER;



















/**
 * The blob lease store that belongs to one ledger. **One producer, no second
 * spelling.**
 *
 * Neither artifacts §7 nor coordination §1 names this file, so the name is
 * decided here and recorded (decision 62). Derived from the ledger's path for
 * the outbox's reason: the publisher, the reconciler and a future collector
 * are three doors, and three doors that each composed a path are three arbiters.
 */
export function artifactBlobLeaseStorePath(ledgerPath: string): string {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new LedgerQueryError("ledgerPath must be a non-empty string");
  }
  return join(dirname(ledgerPath), "artifact-blob-leases.sqlite");
}



/**
 * This database's own migration bookkeeping, apart from the ledger's and the
 * three sibling stores'. `L-X1-4` asserts the five names differ. No
 * `applied_at` — this module reads no clock.
 */
const ARTIFACT_BLOB_LEASE_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS artifact_blob_lease_schema_migrations (
  version INTEGER NOT NULL PRIMARY KEY,
  name    TEXT    NOT NULL,
  sha256  TEXT    NOT NULL
) STRICT;
`;

/**
 * The ordered, checksummed migration set.
 *
 * A shipped migration is never edited: the recorded checksum is compared against
 * this source on every open. The metadata is migration 1, before the table it
 * governs, because §8.1 wants it persisted before a single token is issued. Its
 * `store_kind` CHECK carries all five kinds of the dictionary, so the refusal of
 * a foreign kind at `open` is reachable and therefore drillable.
 *
 * Migration 2 is artifacts §7 `:214-227`, column by column. The nullity of the
 * five operation columns is written as equalities of nullity tests, never as a
 * disjunction of lawful shapes: a comparison against NULL is NULL, and a CHECK
 * that evaluates to NULL passes. The incarnation cannot be a CHECK — SQLite
 * admits no subquery there — so it is a trigger on both kinds of write.
 */
const MIGRATION_SOURCES: readonly { readonly version: number; readonly name: string; readonly sql: string }[] = [
  {
    version: 1,
    name: "coordination_store_meta",
    sql: `
CREATE TABLE coordination_store_meta (
  singleton_id         INTEGER NOT NULL,
  store_kind           TEXT    NOT NULL,
  store_incarnation_id TEXT    NOT NULL,
  created_at           TEXT    NOT NULL,
  CONSTRAINT pk_coordination_store_meta PRIMARY KEY (singleton_id),
  CONSTRAINT ux_coordination_store_meta__incarnation UNIQUE (store_incarnation_id),
  CONSTRAINT ck_coordination_store_meta__singleton CHECK (singleton_id = 1),
  CONSTRAINT ck_coordination_store_meta__store_kind CHECK (
    store_kind IN (
      'WORKTREE_LEASE',
      'TOOL_CLAIM',
      'ACCOUNT_RESERVATION',
      'OUTBOX',
      'ARTIFACT_BLOB_LEASE'
    )
  )
) STRICT;
`,
  },
  {
    version: 2,
    name: "artifact_blob_lease",
    sql: `
CREATE TABLE artifact_blob_lease (
  content_sha256       TEXT    NOT NULL,
  generation           INTEGER NOT NULL,
  store_incarnation_id TEXT    NOT NULL,
  operation            TEXT,
  operation_id         TEXT,
  holder               TEXT,
  holder_pid           INTEGER,
  acquired_at          TEXT,
  expires_at           TEXT,

  CONSTRAINT pk_artifact_blob_lease PRIMARY KEY (content_sha256),

  CONSTRAINT ck_artifact_blob_lease__generation_positive CHECK (generation > 0),
  CONSTRAINT ck_artifact_blob_lease__operation_enum CHECK (
    operation IS NULL OR operation IN ('PUBLISH', 'RECLAIM')
  ),
  CONSTRAINT ck_artifact_blob_lease__operation_id_matches_operation CHECK (
    (operation_id IS NULL) = (operation IS NULL)
  ),
  CONSTRAINT ck_artifact_blob_lease__holder_matches_operation CHECK (
    (holder IS NULL) = (operation IS NULL)
  ),
  CONSTRAINT ck_artifact_blob_lease__holder_pid_matches_operation CHECK (
    (holder_pid IS NULL) = (operation IS NULL)
  ),
  CONSTRAINT ck_artifact_blob_lease__acquired_at_matches_operation CHECK (
    (acquired_at IS NULL) = (operation IS NULL)
  ),
  CONSTRAINT ck_artifact_blob_lease__expires_at_matches_operation CHECK (
    (expires_at IS NULL) = (operation IS NULL)
  )
) STRICT;

-- One operation id holds one digest at most. Partial, because a freed row
-- carries none.
CREATE UNIQUE INDEX ux_artifact_blob_lease__operation_id
  ON artifact_blob_lease (operation_id)
  WHERE operation_id IS NOT NULL;

-- A row is written under the incarnation the file carries now, and a file whose
-- metadata row is gone admits no row at all: the subquery is NULL, and no
-- incarnation is that.
CREATE TRIGGER tr_artifact_blob_lease__validate_insert
BEFORE INSERT ON artifact_blob_lease
BEGIN
  SELECT RAISE(ABORT, 'an artifact blob lease row must carry the incarnation of the file it is written into')
  WHERE NEW.store_incarnation_id IS NOT (
    SELECT store_incarnation_id FROM coordination_store_meta WHERE singleton_id = 1
  );
END;

-- The generation rule by mutation (artifacts section 7, coordination section 3):
-- a new holding advances it by exactly one; the same holding conserves it;
-- clearing a holding conserves it for a release or advances it by one for a
-- revocation; a free row stays where it was freed. Never backwards, never by
-- more than one. The same holding is the same operation, operation id, holder
-- and incarnation -- so a holding carried into another incarnation is a new one.
CREATE TRIGGER tr_artifact_blob_lease__validate_update
BEFORE UPDATE ON artifact_blob_lease
BEGIN
  SELECT RAISE(ABORT, 'the digest of an artifact blob lease row is immutable')
  WHERE NEW.content_sha256 IS NOT OLD.content_sha256;

  SELECT RAISE(ABORT, 'an artifact blob lease row must carry the incarnation of the file it is written into')
  WHERE NEW.store_incarnation_id IS NOT (
    SELECT store_incarnation_id FROM coordination_store_meta WHERE singleton_id = 1
  );

  SELECT RAISE(ABORT, 'the artifact blob lease generation is exhausted and this row admits no further holding')
  WHERE NEW.generation > 9007199254740991;

  SELECT RAISE(ABORT, 'the artifact blob lease generation moves by zero or one, never backwards and never by more')
  WHERE NEW.generation <> OLD.generation AND NEW.generation <> OLD.generation + 1;

  SELECT RAISE(ABORT, 'a new holding of an artifact blob lease advances the generation by exactly one')
  WHERE NEW.operation IS NOT NULL
    AND NOT (
      OLD.operation IS NOT NULL
      AND NEW.operation IS OLD.operation
      AND NEW.operation_id IS OLD.operation_id
      AND NEW.holder IS OLD.holder
      AND NEW.store_incarnation_id IS OLD.store_incarnation_id
    )
    AND NEW.generation <> OLD.generation + 1;

  SELECT RAISE(ABORT, 'a write under the same artifact blob lease holding conserves the generation')
  WHERE NEW.operation IS NOT NULL
    AND OLD.operation IS NOT NULL
    AND NEW.operation IS OLD.operation
    AND NEW.operation_id IS OLD.operation_id
    AND NEW.holder IS OLD.holder
    AND NEW.store_incarnation_id IS OLD.store_incarnation_id
    AND NEW.generation <> OLD.generation;

  SELECT RAISE(ABORT, 'an artifact blob lease row with no holding conserves its generation until it is granted')
  WHERE NEW.operation IS NULL AND OLD.operation IS NULL AND NEW.generation <> OLD.generation;
END;
`,
  },
];

const ARTIFACT_BLOB_LEASE_MIGRATIONS: readonly LeaseMigration[] = MIGRATION_SOURCES.map((source) => ({
  version: source.version,
  name: source.name,
  sql: source.sql,
  sha256: sha256Hex(source.sql),
}));

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 600_000;

const SELECT_COLUMNS =
  "content_sha256, generation, store_incarnation_id, operation, operation_id, holder, holder_pid," +
  " acquired_at, expires_at";





function isOperation(value: string): value is ArtifactBlobLeaseOperation {
  return (ARTIFACT_BLOB_LEASE_OPERATIONS as readonly string[]).includes(value);
}

function isQuiescenceBasis(value: string): value is ArtifactBlobLeaseQuiescenceBasis {
  return (ARTIFACT_BLOB_LEASE_QUIESCENCE_BASES as readonly string[]).includes(value);
}

function toRow(raw: RawRow): ArtifactBlobLeaseRow {
  if (raw.operation !== null && !isOperation(raw.operation)) {
    throw new LedgerQueryError("the stored blob lease operation is not one this build understands");
  }
  return {
    contentSha256: raw.content_sha256,
    generation: raw.generation,
    storeIncarnationId: raw.store_incarnation_id,
    operation: raw.operation,
    operationId: raw.operation_id,
    holder: raw.holder,
    holderPid: raw.holder_pid,
    acquiredAt: raw.acquired_at,
    expiresAt: raw.expires_at,
  };
}

/** A non-empty string argument, refused by name rather than stored malformed. */
function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerQueryError(field + " must be a non-empty string");
  }
  return value;
}

/**
 * The digest, refused for form before the database is touched.
 *
 * The domain artifacts §3 gives every `content_sha256`: 64 lowercase hex
 * characters. A caller that passed an uppercase digest is told which field is
 * wrong, and a digest in another spelling never becomes a second row for the
 * same bytes.
 */
function requireDigest(value: string, field: string): string {
  if (typeof value !== "string" || !isSha256Hex(value)) {
    throw new LedgerQueryError(field + " must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function requireProcessId(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new LedgerQueryError(field + " must be a positive integer");
  }
  return value;
}

/**
 * The token a caller hands back, checked for shape before it is compared.
 *
 * The incarnation is validated first, for the reason every comparison below
 * takes it first: it is the term that makes the generation mean anything.
 */
function requireToken(token: ArtifactBlobLeaseToken): ArtifactBlobLeaseToken {
  const incarnationId = requireText(token.incarnationId, "token.incarnationId");
  const contentSha256 = requireDigest(token.contentSha256, "token.contentSha256");
  if (!Number.isInteger(token.generation) || token.generation < 1) {
    throw new LedgerQueryError("token.generation must be a positive integer");
  }
  if (token.generation > MAX_ARTIFACT_BLOB_LEASE_GENERATION) {
    throw new LedgerQueryError(
      "token.generation exceeds " + String(MAX_ARTIFACT_BLOB_LEASE_GENERATION) + ", the largest this build can compare",
    );
  }
  return {
    incarnationId,
    contentSha256,
    generation: token.generation,
    holder: requireText(token.holder, "token.holder"),
    operationId: requireText(token.operationId, "token.operationId"),
  };
}

function requireGrant(grant: ArtifactBlobLeaseGrant, field: string): ArtifactBlobLeaseGrant {
  if (typeof grant.operation !== "string" || !isOperation(grant.operation)) {
    throw new LedgerQueryError(field + ".operation must be one of " + ARTIFACT_BLOB_LEASE_OPERATIONS.join(", "));
  }
  return {
    contentSha256: requireDigest(grant.contentSha256, field + ".contentSha256"),
    operation: grant.operation,
    operationId: requireText(grant.operationId, field + ".operationId"),
    holder: requireText(grant.holder, field + ".holder"),
    holderPid: requireProcessId(grant.holderPid, field + ".holderPid"),
    acquiredAt: requireText(grant.acquiredAt, field + ".acquiredAt"),
    expiresAt: requireText(grant.expiresAt, field + ".expiresAt"),
  };
}

function requireQuiescence(quiescence: ArtifactBlobLeaseQuiescence): ArtifactBlobLeaseQuiescence {
  // Read through an optional chain: the attestation is a required argument, and a
  // caller that omitted it is told which field is missing rather than handed a
  // TypeError from inside the store.
  const stated = quiescence as Partial<ArtifactBlobLeaseQuiescence> | null | undefined;
  const basis: unknown = stated?.basis;
  if (typeof basis !== "string" || !isQuiescenceBasis(basis)) {
    throw new LedgerQueryError(
      "quiescence.basis must be one of " + ARTIFACT_BLOB_LEASE_QUIESCENCE_BASES.join(", "),
    );
  }
  return { basis, holderPid: requireProcessId(quiescence.holderPid, "quiescence.holderPid") };
}

/** A constraint the schema refused, handed back as this package's own class. */
function refuseConstraint(error: unknown): never {
  const message = error instanceof Error ? error.message : "unknown error";
  throw new LedgerQueryError("the artifact blob lease schema refused this row: " + message);
}

function readAppliedMigrations(db: Database.Database): readonly LeaseMigration[] {
  const rows = db
    .prepare("SELECT version, name, sha256 FROM artifact_blob_lease_schema_migrations ORDER BY version ASC")
    .all() as { version: number; name: string; sha256: string }[];
  return rows.map((row) => ({ version: row.version, name: row.name, sql: "", sha256: row.sha256 }));
}

/**
 * Compare what is applied against what this build carries.
 *
 * Missing tail migrations are applied; anything else is fatal. An arbiter whose
 * schema history this build does not recognise is an arbiter nobody can trust
 * to exclude.
 */
function checkMigrationConformance(applied: readonly LeaseMigration[]): {
  readonly problems: readonly string[];
  readonly missing: readonly LeaseMigration[];
} {
  const problems: string[] = [];
  for (const [index, row] of applied.entries()) {
    const expected = ARTIFACT_BLOB_LEASE_MIGRATIONS[index];
    if (expected === undefined) {
      problems.push("migration " + String(row.version) + " is applied but this build does not carry it");
      continue;
    }
    if (row.version !== expected.version || row.name !== expected.name) {
      problems.push(
        "migration at position " +
          String(index) +
          " is " +
          String(row.version) +
          " " +
          row.name +
          " but this build carries " +
          String(expected.version) +
          " " +
          expected.name,
      );
      continue;
    }
    if (row.sha256 !== expected.sha256) {
      problems.push("migration " + String(row.version) + " " + row.name + " has a different checksum");
    }
  }
  return { problems, missing: ARTIFACT_BLOB_LEASE_MIGRATIONS.slice(applied.length) };
}

/**
 * Open the artifact blob lease store at `path`, migrating it if it is behind and
 * registering its incarnation if it has none.
 *
 * Fails closed: an unopenable file, a directory, a file that is not SQLite, a
 * schema this build does not understand, the ledger or a sibling store handed
 * here by mistake, a coordination file of another kind, and a file that holds
 * lease rows but no incarnation all throw.
 */
export function openArtifactBlobLeaseStore(
  path: string,
  options: OpenArtifactBlobLeaseStoreOptions,
): ArtifactBlobLeaseStore {
  requireText(path, "path");
  const incarnationId = requireText(options.incarnationId, "incarnationId");
  const createdAt = requireText(options.createdAt, "createdAt");
  const faults = options.__testFaults ?? {};
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new LedgerOpenError(path, "busyTimeoutMs must be an integer between 0 and " + String(MAX_BUSY_TIMEOUT_MS));
  }

  let db: Database.Database;
  try {
    db = new Database(path);
  } catch (error: unknown) {
    throw new LedgerOpenError(path, error instanceof Error ? error.message : "unknown error");
  }

  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = " + String(busyTimeoutMs));
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");

    // The wrong file, refused before anything is written to it. Every database
    // in this package records its migrations under a name ending
    // `schema_migrations`, so a file already carrying somebody else's belongs
    // to somebody else -- the ledger included.
    const foreign = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'" +
          " AND name LIKE '%schema_migrations' AND name <> 'artifact_blob_lease_schema_migrations'",
      )
      .get() as { readonly name: string } | undefined;
    if (foreign !== undefined) {
      throw new LedgerOpenError(path, "this file already belongs to another store in this package");
    }

    db.exec(ARTIFACT_BLOB_LEASE_MIGRATIONS_DDL);

    const applied = readAppliedMigrations(db);
    const conformance = checkMigrationConformance(applied);
    if (conformance.problems.length > 0) {
      throw new LedgerMigrationError(conformance.problems);
    }
    if (conformance.missing.length > 0) {
      const pending = conformance.missing;
      db.transaction(() => {
        for (const migration of pending) {
          db.exec(migration.sql);
          db.prepare(
            "INSERT INTO artifact_blob_lease_schema_migrations (version, name, sha256) VALUES (?, ?, ?)",
          ).run(migration.version, migration.name, migration.sha256);
        }
      }).immediate();
    }

    // The incarnation, registered before this handle can issue a single token.
    // A file that already carries one keeps it. A file that carries lease rows
    // and no incarnation is refused rather than adopted: its tokens were issued
    // under an incarnation nobody can now name, and registering one here would
    // be recreating the store without the procedure coordination 8.2 requires.
    const registration = db.transaction((): string | null => {
      const existing = db
        .prepare("SELECT store_kind, store_incarnation_id, created_at FROM coordination_store_meta WHERE singleton_id = 1")
        .get() as RawMeta | undefined;
      if (existing === undefined) {
        const orphan = db.prepare("SELECT content_sha256 FROM artifact_blob_lease LIMIT 1").get();
        if (orphan !== undefined) return "ORPHANED_ROWS";
        db.prepare(
          "INSERT INTO coordination_store_meta (singleton_id, store_kind, store_incarnation_id, created_at)" +
            " VALUES (1, 'ARTIFACT_BLOB_LEASE', ?, ?)",
        ).run(incarnationId, createdAt);
        return null;
      }
      return existing.store_kind === "ARTIFACT_BLOB_LEASE" ? null : existing.store_kind;
    }).immediate();
    if (registration === "ORPHANED_ROWS") {
      throw new LedgerOpenError(
        path,
        "this file holds artifact blob lease rows but no incarnation; admission stays frozen until a restore names one",
      );
    }
    if (registration !== null) {
      throw new LedgerOpenError(
        path,
        "this file is a " + registration + " coordination store, and an artifact blob lease store is not one",
      );
    }
  } catch (error: unknown) {
    db.close();
    if (error instanceof LedgerOpenError || error instanceof LedgerMigrationError) throw error;
    throw new LedgerOpenError(path, error instanceof Error ? error.message : "unknown error");
  }

  let closed = false;
  const assertOpen = (operation: string): void => {
    if (closed) throw new LedgerClosedError(operation);
  };

  const readRow = (contentSha256: string): ArtifactBlobLeaseRow | null => {
    const raw = db
      .prepare("SELECT " + SELECT_COLUMNS + " FROM artifact_blob_lease WHERE content_sha256 = ?")
      .get(contentSha256) as RawRow | undefined;
    return raw === undefined ? null : toRow(raw);
  };

  const readRowByOperationId = (operationId: string): ArtifactBlobLeaseRow | null => {
    const raw = db
      .prepare("SELECT " + SELECT_COLUMNS + " FROM artifact_blob_lease WHERE operation_id = ?")
      .get(operationId) as RawRow | undefined;
    return raw === undefined ? null : toRow(raw);
  };

  /** The metadata row, read now and never remembered. Absent or foreign is a frozen file. */
  const readMeta = (): ArtifactBlobLeaseIncarnation => {
    const raw = db
      .prepare("SELECT store_kind, store_incarnation_id, created_at FROM coordination_store_meta WHERE singleton_id = 1")
      .get() as RawMeta | undefined;
    if (raw === undefined) {
      throw new LedgerIntegrityError(["the artifact blob lease store carries no incarnation; its metadata row is gone"]);
    }
    if (raw.store_kind !== "ARTIFACT_BLOB_LEASE") {
      throw new LedgerIntegrityError(["the artifact blob lease metadata now declares store kind " + raw.store_kind]);
    }
    return { storeKind: "ARTIFACT_BLOB_LEASE", incarnationId: raw.store_incarnation_id, createdAt: raw.created_at };
  };

  const refuse = (refusal: ArtifactBlobLeaseRefusal, row: ArtifactBlobLeaseRow | null): ArtifactBlobLeaseOutcome => ({
    verb: "REFUSE",
    refusal,
    row,
  });

  /**
   * Is `row` held by exactly this grant, under the live incarnation? A free row
   * never is: its operation is null and a grant's never is.
   */
  const isHeldBy = (row: ArtifactBlobLeaseRow, grant: ArtifactBlobLeaseGrant, live: ArtifactBlobLeaseIncarnation): boolean =>
    row.operation === grant.operation &&
    row.operationId === grant.operationId &&
    row.holder === grant.holder &&
    row.storeIncarnationId === live.incarnationId;

  /**
   * The token checks every holding verb shares, in the order that matters.
   *
   * The incarnation first, against the live metadata and then against the row:
   * a generation compared before the file is known to be the file that issued
   * it compares a number that may merely coincide. Then the generation, then
   * the holding, then the identity.
   */
  const refuseToken = (
    live: ArtifactBlobLeaseIncarnation,
    current: ArtifactBlobLeaseRow | null,
    token: ArtifactBlobLeaseToken,
  ): ArtifactBlobLeaseOutcome | null => {
    if (live.incarnationId !== token.incarnationId) return refuse("INCARNATION_SUPERSEDED", current);
    if (current === null) return refuse("NOT_HELD", null);
    if (current.storeIncarnationId !== token.incarnationId) return refuse("INCARNATION_SUPERSEDED", current);
    if (current.generation !== token.generation) return refuse("GENERATION_SUPERSEDED", current);
    if (current.operation === null) return refuse("NOT_HELD", current);
    if (current.holder !== token.holder || current.operationId !== token.operationId) {
      return refuse("HOLDER_MISMATCH", current);
    }
    return null;
  };

  /** Exactly one row, or a refusal read back as it stands, or a broken key. */
  const settle = (changes: number, contentSha256: string, onZero: ArtifactBlobLeaseRefusal): ArtifactBlobLeaseOutcome => {
    if (changes === 0) return refuse(onZero, readRow(contentSha256));
    if (changes > 1) {
      throw new LedgerIntegrityError([
        "content_sha256 " + contentSha256 + " matched " + String(changes) + " rows; its primary key is gone",
      ]);
    }
    const row = readRow(contentSha256);
    if (row === null) throw new LedgerQueryError("the artifact blob lease row could not be read back");
    faults.beforeLeaseCommit?.();
    return { verb: "APPLIED", row };
  };

  const acquirer = db.transaction((grant: ArtifactBlobLeaseGrant): ArtifactBlobLeaseOutcome => {
    const live = readMeta();
    const current = readRow(grant.contentSha256);
    if (current !== null && current.operation !== null) {
      // Held is held, whatever `expires_at` says: expiry enables reconciliation
      // and concedes nothing (artifacts section 7).
      return isHeldBy(current, grant, live) ? { verb: "UNCHANGED", row: current } : refuse("HELD", current);
    }
    const other = readRowByOperationId(grant.operationId);
    if (other !== null && other.contentSha256 !== grant.contentSha256) return refuse("OPERATION_ID_IN_USE", other);

    let changes: number;
    try {
      if (current === null) {
        changes = db
          .prepare(
            "INSERT INTO artifact_blob_lease (content_sha256, generation, store_incarnation_id, operation," +
              " operation_id, holder, holder_pid, acquired_at, expires_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            grant.contentSha256,
            live.incarnationId,
            grant.operation,
            grant.operationId,
            grant.holder,
            grant.holderPid,
            grant.acquiredAt,
            grant.expiresAt,
          ).changes;
      } else {
        changes = db
          .prepare(
            "UPDATE artifact_blob_lease SET generation = generation + 1, store_incarnation_id = ?, operation = ?," +
              " operation_id = ?, holder = ?, holder_pid = ?, acquired_at = ?, expires_at = ?" +
              " WHERE content_sha256 = ? AND generation = ? AND operation IS NULL",
          )
          .run(
            live.incarnationId,
            grant.operation,
            grant.operationId,
            grant.holder,
            grant.holderPid,
            grant.acquiredAt,
            grant.expiresAt,
            grant.contentSha256,
            current.generation,
          ).changes;
      }
    } catch (error: unknown) {
      refuseConstraint(error);
    }
    return settle(changes, grant.contentSha256, "HELD");
  });

  const releaser = db.transaction((token: ArtifactBlobLeaseToken): ArtifactBlobLeaseOutcome => {
    const live = readMeta();
    const current = readRow(token.contentSha256);
    const stale = refuseToken(live, current, token);
    if (stale !== null) return stale;

    let changes: number;
    try {
      changes = db
        .prepare(
          "UPDATE artifact_blob_lease SET operation = NULL, operation_id = NULL, holder = NULL, holder_pid = NULL," +
            " acquired_at = NULL, expires_at = NULL" +
            " WHERE content_sha256 = ? AND store_incarnation_id = ? AND generation = ? AND holder = ?" +
            " AND operation_id = ?",
        )
        .run(token.contentSha256, token.incarnationId, token.generation, token.holder, token.operationId).changes;
    } catch (error: unknown) {
      refuseConstraint(error);
    }
    return settle(changes, token.contentSha256, "GENERATION_SUPERSEDED");
  });

  const revoker = db.transaction(
    (token: ArtifactBlobLeaseToken, quiescence: ArtifactBlobLeaseQuiescence): ArtifactBlobLeaseOutcome => {
      const live = readMeta();
      const current = readRow(token.contentSha256);
      const stale = refuseToken(live, current, token);
      if (stale !== null) return stale;
      if (current?.holderPid !== quiescence.holderPid) return refuse("QUIESCENCE_OF_ANOTHER_PROCESS", current);

      let changes: number;
      try {
        changes = db
          .prepare(
            "UPDATE artifact_blob_lease SET generation = generation + 1, store_incarnation_id = ?, operation = NULL," +
              " operation_id = NULL, holder = NULL, holder_pid = NULL, acquired_at = NULL, expires_at = NULL" +
              " WHERE content_sha256 = ? AND store_incarnation_id = ? AND generation = ? AND holder = ?" +
              " AND operation_id = ?",
          )
          .run(
            live.incarnationId,
            token.contentSha256,
            token.incarnationId,
            token.generation,
            token.holder,
            token.operationId,
          ).changes;
      } catch (error: unknown) {
        refuseConstraint(error);
      }
      return settle(changes, token.contentSha256, "GENERATION_SUPERSEDED");
    },
  );

  const taker = db.transaction(
    (
      token: ArtifactBlobLeaseToken,
      quiescence: ArtifactBlobLeaseQuiescence,
      grant: ArtifactBlobLeaseGrant,
    ): ArtifactBlobLeaseOutcome => {
      const live = readMeta();
      const current = readRow(token.contentSha256);
      // A take-over that already stands, replayed: the new holder asking again
      // after a crash it cannot see past. Answered from the row, with no write.
      if (current !== null && isHeldBy(current, grant, live)) {
        return { verb: "UNCHANGED", row: current };
      }
      const stale = refuseToken(live, current, token);
      if (stale !== null) return stale;
      if (current?.holderPid !== quiescence.holderPid) return refuse("QUIESCENCE_OF_ANOTHER_PROCESS", current);
      const other = readRowByOperationId(grant.operationId);
      if (other !== null && other.contentSha256 !== grant.contentSha256) return refuse("OPERATION_ID_IN_USE", other);

      let changes: number;
      try {
        changes = db
          .prepare(
            "UPDATE artifact_blob_lease SET generation = generation + 1, store_incarnation_id = ?, operation = ?," +
              " operation_id = ?, holder = ?, holder_pid = ?, acquired_at = ?, expires_at = ?" +
              " WHERE content_sha256 = ? AND store_incarnation_id = ? AND generation = ? AND holder = ?" +
              " AND operation_id = ?",
          )
          .run(
            live.incarnationId,
            grant.operation,
            grant.operationId,
            grant.holder,
            grant.holderPid,
            grant.acquiredAt,
            grant.expiresAt,
            token.contentSha256,
            token.incarnationId,
            token.generation,
            token.holder,
            token.operationId,
          ).changes;
      } catch (error: unknown) {
        refuseConstraint(error);
      }
      return settle(changes, token.contentSha256, "GENERATION_SUPERSEDED");
    },
  );

  return {
    incarnation() {
      assertOpen("incarnation");
      return readMeta();
    },
    read(contentSha256) {
      assertOpen("read");
      return readRow(requireDigest(contentSha256, "contentSha256"));
    },
    readToken(contentSha256) {
      assertOpen("readToken");
      const row = readRow(requireDigest(contentSha256, "contentSha256"));
      if (row === null) return null;
      const { holder, operationId } = row;
      if (holder === null || operationId === null) return null;
      return {
        incarnationId: row.storeIncarnationId,
        contentSha256: row.contentSha256,
        generation: row.generation,
        holder,
        operationId,
      };
    },
    acquire(grant) {
      assertOpen("acquire");
      return acquirer.immediate(requireGrant(grant, "grant"));
    },
    release(token) {
      assertOpen("release");
      return releaser.immediate(requireToken(token));
    },
    revoke(token, quiescence) {
      assertOpen("revoke");
      return revoker.immediate(requireToken(token), requireQuiescence(quiescence));
    },
    takeOver(token, quiescence, grant) {
      assertOpen("takeOver");
      const checked = requireToken(token);
      const stated = requireGrant(grant, "grant");
      if (stated.contentSha256 !== checked.contentSha256) {
        throw new LedgerQueryError("grant.contentSha256 must name the digest the token was issued for");
      }
      return taker.immediate(checked, requireQuiescence(quiescence), stated);
    },
    listOverdue(now) {
      assertOpen("listOverdue");
      requireText(now, "now");
      const raws = db
        .prepare(
          "SELECT " +
            SELECT_COLUMNS +
            " FROM artifact_blob_lease WHERE operation IS NOT NULL AND expires_at <= ?" +
            " ORDER BY expires_at ASC, content_sha256 ASC",
        )
        .all(now) as RawRow[];
      return raws.map(toRow);
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
