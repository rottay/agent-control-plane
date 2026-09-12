import Database from "better-sqlite3";

import { sha256Hex } from "../canonical-json/index.js";
import {
  LedgerClosedError,
  LedgerIntegrityError,
  LedgerMigrationError,
  LedgerOpenError,
  LedgerQueryError,
} from "../errors/index.js";

/**
 * The worktree arbitration store — V2 concurrency packet C1.
 *
 * ## Two questions, and only one of them is history
 *
 * *What happened?* is history, and the append-only ledger is its only
 * authority (ADR 0001). *May I write here, now?* is mutual exclusion, and no
 * amount of history answers it: reading the last lease event and then acting on
 * it is a check-then-write, and two processes can both pass the check. This
 * module answers the second question and nothing else.
 *
 * It is the same object as `acquireSingleton`'s `open(…, "wx")`, scaled from
 * one daemon per checkout to one writer per worktree: the arbitration is done
 * by something outside this process, because a decision made inside it cannot
 * exclude another process making the same decision at the same time.
 *
 * The lease **events** still go to the ledger. This store holds no history and
 * is rebuildable — losing it costs liveness, never evidence.
 *
 * ## Both halves of the mechanism are load-bearing
 *
 * `worktree_path` is the PRIMARY KEY, so **at most one record can exist** per
 * worktree. That is necessary and it is not sufficient: it prevents two
 * records, not two decisions. `BEGIN IMMEDIATE` takes the database write lock
 * at `BEGIN` rather than at first write, so two processes serialize there — the
 * read, the decision and the write are one unit, and the second process sees
 * the first one's result rather than the state it raced against.
 *
 * A reader who believes the key alone is the mechanism will eventually move a
 * decision outside the transaction, and the key will not catch it. Hence the
 * law `L-C-1b`, which asserts every mutation in this file sits inside a
 * `.transaction(…).immediate()`.
 *
 * ## The record is created on the first grant and is never deleted
 *
 * Release clears the holder columns and stamps `released_at`; `fence` survives.
 * This is the only shape in which `fence` is monotonic across a
 * release/re-acquire cycle, and an aborting holder's whole test is "has the
 * fence moved since I was granted?". A `DELETE` would reset the counter on the
 * next grant, and a stale holder would then read its own old value and conclude
 * it still holds the lease. There is no `DELETE` in this module and the fence
 * law asserts its absence rather than trusting this paragraph.
 *
 * ## What this module does not do
 *
 * It reads **no clock, no environment and no process**. Every timestamp,
 * including `released_at` and the sweep boundary, is supplied by the caller,
 * for the same reason every clock in this repository is injected: a substrate
 * that reads the wall clock cannot be tested at a boundary without sleeping.
 * Liveness probing — is the recorded holder still alive? — belongs to the
 * caller too.
 *
 * It owns **no refusal vocabulary**. `REFUSE` carries a caller-supplied
 * reason, because the policy words belong to the layer that has the policy; a
 * closed enum here would be this module legislating for a caller it cannot see.
 * The one exception is the stale-token refusal below, and it is not a policy
 * word: it names a fact about this file — the incarnation it carries, the fence
 * the record stands at — which no caller is in a position to state.
 *
 * It grants **no driver a capability**. Arbitration is not a durability-engine
 * property: `SERIALIZED_PER_TASK` is per *task key*, and two different tasks
 * writing one worktree are two keys. So the lease is mandatory in both modes,
 * and the file that provides arbitration may not so much as mention a driver —
 * asserted by `L-C-1c`.
 *
 * ## The path is supplied, never defaulted
 *
 * {@link openLeaseStore} takes a path and invents none. Resolving the daemon
 * root lives one stratum out, in `@acp/daemon`, which this package may not
 * import; the caller that knows the checkout supplies
 * `<repo>/.acp-local/daemon/leases.sqlite`. A default here would be a path a
 * caller could silently point somewhere else, which is two stores, which is two
 * answers to *may I write*.
 *
 * This is a **separate database** from the control-plane ledger, with its own
 * migration list in this module. `LEDGER_MIGRATIONS` is immutable by law and
 * describes a different database; appending to it would be a schema change to
 * the authority, for a file that is not the authority.
 *
 * ## The file says what it is, and which time it is
 *
 * Coordination §8.1 gives every coordination file its own
 * `coordination_store_meta`: one row, a `store_kind` out of a closed dictionary
 * of five, an incarnation and the instant it began. Two things follow, and P-18
 * escalón E1 added both to a store that already had adopters.
 *
 * **The kind is the identity, not the filename.** The specification calls this
 * file `worktree-leases.sqlite` and the tree calls it `leases.sqlite`. Renaming
 * a live arbiter's file for tidiness costs liveness and buys nothing, so the
 * authority on what a coordination file *is* is the `store_kind` it carries —
 * and a file whose metadata says `TOOL_CLAIM` is refused here at `open`, before
 * anything is written. That refusal is reachable because the `CHECK` carries all
 * five kinds rather than only this one.
 *
 * **The fence number alone was never a token.** `fence` restarts at 1 on a file
 * restored from a backup, so a holder granted before the restore matches a
 * rebuilt record exactly. Coordination §8.1 makes the lease token the *pair*
 * `(store_incarnation_id, fence)`, and {@link LeaseStore.transact} takes that
 * pair as an optional `expectedToken`, compares it **inside** the write lock
 * against the metadata as it stands and the record as it stands, and answers
 * `REFUSE` as a value. Read at `open` instead, the incarnation would be the
 * answer from before the restore, carried into the first decision taken after
 * it — which is the only decision that needed it.
 *
 * ## The adoption window, declared rather than hidden
 *
 * `incarnationId` and `createdAt` are **optional** arguments to
 * {@link openLeaseStore}, and they are never generated here: §8.1 says "sin
 * default implícito" twice, and a UUID minted in this module would read an
 * environment this module may not read. A file that already carries metadata
 * keeps it — rotating an incarnation is coordination §8.2's blocked restore, not
 * a side effect of reopening.
 *
 * A caller that supplies neither gets no metadata row and **no refusal**. Today
 * every caller in the field is such a caller, so §8.1's "persistida antes de
 * emitir tokens" is not yet in force here: the daemon opens this file without an
 * incarnation, grants stamp `NULL`, and nobody passes a token. ADR 0075 records
 * that window and names the packet that closes it. Refusing at runtime for
 * absent metadata would close it by breaking the daemon instead.
 *
 * ## Three additive columns, and who fills them
 *
 * `store_incarnation_id` is stamped by every grant with the incarnation read
 * inside the lock, and conserved by release and sweep. `operation_id` and
 * `revocation_acknowledged_at` are coordination §3's, declared here as nullable
 * columns and written by **no verb of this module** — escalón F owns the
 * intention that correlates a grant and the acknowledgement that answers a
 * revocation. Rows written before the column existed read back `NULL`, and a
 * re-grant over such a row stamps the live incarnation.
 */

/** One row of the arbitration table, as the caller sees it. */
export interface LeaseRow {
  readonly worktreePath: string;
  /** Monotonic per worktree, bumped on every grant, never reset. */
  readonly fence: number;
  /** Non-null exactly while the lease is held. */
  readonly leaseId: string | null;
  readonly holder: string | null;
  readonly acquiredAt: string | null;
  readonly expiresAt: string | null;
  readonly holderPid: number | null;
  readonly holderToken: string | null;
  /** Null while held; stamped by the release or the sweep that freed it. */
  readonly releasedAt: string | null;
  /**
   * The incarnation of this file that granted the record, or `null`.
   *
   * `null` on a record written before the column existed, and on a grant taken
   * while this file carried no metadata — the adoption window in the module
   * docblock. Stamped by every grant, conserved by release and sweep.
   */
  readonly storeIncarnationId: string | null;
  /**
   * The intention in the ledger this grant answers, or `null`. Coordination §3.
   *
   * No verb of this module writes it: the correlation is escalón F's, and a
   * store that invented one would be claiming an intention it cannot read.
   */
  readonly operationId: string | null;
  /** When a revocation was acknowledged, or `null`. F's too; coordination §6. */
  readonly revocationAcknowledgedAt: string | null;
}

/**
 * This file's own incarnation, as `coordination_store_meta` holds it.
 *
 * `null` where a {@link LeaseStore.incarnation} is expected means the file
 * carries no metadata row at all — not that one is malformed. See the adoption
 * window in the module docblock.
 */
export interface LeaseStoreIncarnation {
  readonly storeKind: "WORKTREE_LEASE";
  readonly incarnationId: string;
  readonly createdAt: string;
}

/**
 * The lease token of coordination §8.1 `:389`, as a caller hands it back.
 *
 * The pair, never half of it. A fence number identifies a grant only within one
 * incarnation of one file, and the whole point of §8.1 `:393-394` is that a
 * number which merely *coincides* with a recreated one proves nothing.
 */
export interface LeaseExpectedToken {
  readonly incarnationId: string;
  readonly fence: number;
}

/**
 * What a caller must supply to take the lease.
 *
 * A superset of the contract's `Lease` in operational columns only. `fence`,
 * `holderPid`, `holderToken` and `releasedAt` are store-local and must not be
 * pushed into the contract: the contract describes what a lease *is*, and these
 * describe how this store arbitrates one.
 */
export interface LeaseGrant {
  readonly leaseId: string;
  readonly holder: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly holderPid: number | null;
  readonly holderToken: string | null;
}

/**
 * The caller's decision, taken with the write lock already held.
 *
 * `RELEASE` carries the instant it happened because this module reads no clock.
 * The alternative — a `Date.now()` inside the store — would make the expiry
 * drills depend on sleeping, and would put a clock in a substrate.
 */
export type LeaseDecision =
  | { readonly verb: "GRANT"; readonly row: LeaseGrant }
  | { readonly verb: "RELEASE"; readonly at: string }
  | { readonly verb: "REFUSE"; readonly reason: string };

/**
 * What the store did, with the record as it stands afterwards.
 *
 * Named apart from `@acp/runtime`'s `LeaseOutcome`, which is the *policy*
 * outcome of the pure `acquireLease` / `renewLease` / `revokeLease` decisions.
 * The two travel together in the caller that joins them, and one name for both
 * would make "the lease was granted" ambiguous between "the rules allowed it"
 * and "the store wrote it". The duplication gate is what surfaced this.
 */
export type LeaseStoreOutcome =
  | { readonly verb: "GRANT"; readonly row: LeaseRow }
  | { readonly verb: "RELEASE"; readonly row: LeaseRow }
  | { readonly verb: "REFUSE"; readonly reason: string; readonly row: LeaseRow | null };

export interface LeaseStore {
  /**
   * Read, decide and write as one unit under the database write lock.
   *
   * `decide` receives the record as it is **inside** the lock — never a value
   * read before it — and must be pure and synchronous. `better-sqlite3` is
   * synchronous, so no `await` can interleave between the read, the decision
   * and the write; that is why the seam is a callback rather than a
   * read-then-write pair the caller assembles.
   *
   * If `decide` throws, the transaction rolls back and the throw propagates:
   * no partial write is possible.
   *
   * `expectedToken` is the optional gate of N-P18-11. Supplied, it is compared
   * inside the lock against the live metadata and the current record *before*
   * `decide` is consulted, and a mismatch answers `REFUSE` without running the
   * caller's decision at all: a stale token is a precondition that failed, not a
   * policy that declined. Omitted — which is what every caller in the field does
   * today — nothing about the call changes.
   */
  readonly transact: (
    worktreePath: string,
    decide: (current: LeaseRow | null) => LeaseDecision,
    expectedToken?: LeaseExpectedToken,
  ) => LeaseStoreOutcome;
  readonly read: (worktreePath: string) => LeaseRow | null;
  readonly list: () => readonly LeaseRow[];
  /**
   * This file's incarnation, read from the database rather than remembered.
   *
   * `null` while the file carries no metadata row. Never cached: a handle that
   * answered from memory would answer about the file as it was.
   */
  readonly incarnation: () => LeaseStoreIncarnation | null;
  /**
   * Free every record whose `expires_at` is at or before `now`.
   *
   * Returns what it cleared. It does **not** bump the fence: a sweep frees a
   * lease, it does not grant one, and a fence that moved without a grant would
   * abort a holder nobody replaced.
   */
  readonly sweep: (now: string) => readonly LeaseRow[];
  readonly close: () => void;
}

interface LeaseStoreMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

interface MigrationSource {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * The migration bookkeeping table for this database.
 *
 * Deliberately named apart from the ledger's `schema_migrations`: the two are
 * different databases with different lists, and a name collision is how a file
 * opened by the wrong module looks migrated when it is not.
 *
 * It records no `applied_at`, because this module reads no clock — and because
 * *when* a shape arrived is history, which this store does not keep.
 */
const LEASE_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS lease_schema_migrations (
  version INTEGER NOT NULL PRIMARY KEY,
  name    TEXT    NOT NULL,
  sha256  TEXT    NOT NULL
) STRICT;
`;

/**
 * The ordered, checksummed migration set for the arbitration store.
 *
 * Same law as the ledger's: a shipped migration is never edited, because the
 * recorded checksum is compared against the checksum of this source on every
 * open. A schema change is a new version appended to the end.
 *
 * **The metadata is migration 2 here and migration 1 in the outbox**, and the
 * difference is history rather than design. §8.1 wants it "persistida antes de
 * emitir tokens", which a file built from nothing can honour; this file was
 * shipped before §8.1 existed and migration 1's checksum is immutable. So the
 * metadata arrives behind the table it governs, and every record written in
 * between reads back with `store_incarnation_id IS NULL` — the nullable window
 * §8.1 `:384` allows, not a schema that lost a constraint.
 *
 * The three `ADD COLUMN`s are additive and nullable for the same reason: SQLite
 * will add a column to a `STRICT` table with no default only if existing rows
 * can hold nothing there, and existing rows are exactly what this migration must
 * not disturb. The checksum of version 1 is unchanged by all of it, which is the
 * property the suite pins by digest rather than by inspection.
 */
const MIGRATION_SOURCES: readonly MigrationSource[] = [
  {
    version: 1,
    name: "worktree_lease",
    sql: `
CREATE TABLE worktree_lease (
  worktree_path TEXT    NOT NULL PRIMARY KEY,
  fence         INTEGER NOT NULL,
  lease_id      TEXT,
  holder        TEXT,
  acquired_at   TEXT,
  expires_at    TEXT,
  holder_pid    INTEGER,
  holder_token  TEXT,
  released_at   TEXT
) STRICT;

CREATE UNIQUE INDEX worktree_lease_lease_id
  ON worktree_lease (lease_id)
  WHERE lease_id IS NOT NULL;
`,
  },
  {
    version: 2,
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

ALTER TABLE worktree_lease ADD COLUMN store_incarnation_id TEXT;
ALTER TABLE worktree_lease ADD COLUMN operation_id TEXT;
ALTER TABLE worktree_lease ADD COLUMN revocation_acknowledged_at TEXT;
`,
  },
];

const LEASE_STORE_MIGRATIONS: readonly LeaseStoreMigration[] = MIGRATION_SOURCES.map((source) => ({
  version: source.version,
  name: source.name,
  sql: source.sql,
  sha256: sha256Hex(source.sql),
}));

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 600_000;

export interface OpenLeaseStoreOptions {
  /**
   * How long a contending process waits for the write lock before giving up.
   *
   * The default is generous on purpose: the point of the lock is that writers
   * serialize, not that one of them fails fast.
   */
  readonly busyTimeoutMs?: number;
  /**
   * The incarnation to register **if this file has none yet**.
   *
   * Supplied, never generated, and optional: see the adoption window in the
   * module docblock. On a file that already carries a metadata row that row
   * stands and this value is unused.
   */
  readonly incarnationId?: string;
  /** The instant that incarnation began, on the same terms. */
  readonly createdAt?: string;
}

interface RawRow {
  readonly worktree_path: string;
  readonly fence: number;
  readonly lease_id: string | null;
  readonly holder: string | null;
  readonly acquired_at: string | null;
  readonly expires_at: string | null;
  readonly holder_pid: number | null;
  readonly holder_token: string | null;
  readonly released_at: string | null;
  readonly store_incarnation_id: string | null;
  readonly operation_id: string | null;
  readonly revocation_acknowledged_at: string | null;
}

interface RawMeta {
  readonly store_kind: string;
  readonly store_incarnation_id: string;
  readonly created_at: string;
}

function toRow(raw: RawRow): LeaseRow {
  return {
    worktreePath: raw.worktree_path,
    fence: raw.fence,
    leaseId: raw.lease_id,
    holder: raw.holder,
    acquiredAt: raw.acquired_at,
    expiresAt: raw.expires_at,
    holderPid: raw.holder_pid,
    holderToken: raw.holder_token,
    releasedAt: raw.released_at,
    storeIncarnationId: raw.store_incarnation_id,
    operationId: raw.operation_id,
    revocationAcknowledgedAt: raw.revocation_acknowledged_at,
  };
}

const SELECT_COLUMNS =
  "worktree_path, fence, lease_id, holder, acquired_at, expires_at, holder_pid, holder_token," +
  " released_at, store_incarnation_id, operation_id, revocation_acknowledged_at";

/** A non-empty string argument, refused by name rather than stored malformed. */
function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerQueryError(field + " must be a non-empty string");
  }
  return value;
}

function requireGrant(grant: LeaseGrant): LeaseGrant {
  requireText(grant.leaseId, "leaseId");
  requireText(grant.holder, "holder");
  requireText(grant.acquiredAt, "acquiredAt");
  requireText(grant.expiresAt, "expiresAt");
  if (grant.holderPid !== null && !Number.isInteger(grant.holderPid)) {
    throw new LedgerQueryError("holderPid must be an integer or null");
  }
  return grant;
}

/**
 * The incarnation to register, or nothing at all.
 *
 * Both halves or neither: an incarnation with no instant is a registration this
 * store cannot complete, and §8.1 gives `created_at` no default either. What is
 * refused here is a **malformed argument**, never an absent metadata row — the
 * adoption window in the module docblock turns on exactly that distinction.
 */
function requireOptionalRegistration(
  options: OpenLeaseStoreOptions,
): { readonly incarnationId: string; readonly createdAt: string } | null {
  const { incarnationId, createdAt } = options;
  if (incarnationId === undefined && createdAt === undefined) return null;
  if (incarnationId === undefined || createdAt === undefined) {
    throw new LedgerQueryError("incarnationId and createdAt are supplied together or not at all");
  }
  return {
    incarnationId: requireText(incarnationId, "incarnationId"),
    createdAt: requireText(createdAt, "createdAt"),
  };
}

/**
 * The token a caller hands back, checked for shape before it is compared.
 *
 * The incarnation is validated first, and it is the first field of the type, for
 * the reason the comparison below takes it first: it is the term that makes the
 * other one mean anything.
 */
function requireOptionalToken(token: LeaseExpectedToken | undefined): LeaseExpectedToken | null {
  if (token === undefined) return null;
  const incarnationId = requireText(token.incarnationId, "expectedToken.incarnationId");
  if (!Number.isInteger(token.fence) || token.fence < 1) {
    throw new LedgerQueryError("expectedToken.fence must be a positive integer");
  }
  return { incarnationId, fence: token.fence };
}

/**
 * N-P18-11, as a precondition rather than as policy.
 *
 * The incarnation is compared **first** because it is the half that cannot
 * repeat. A file restored from a backup hands out `fence = 1` again, so a holder
 * granted before the restore matches a rebuilt record in the only number either
 * of them has; §8.1 `:393-394` is explicit that coinciding is not matching.
 *
 * A file with no metadata refuses every token. Nobody in the adoption window
 * passes one, and a store that accepted a token it cannot place would be
 * answering a question it has no instrument for.
 *
 * The reason string is the one refusal this module authors. It names a fact
 * about the file rather than a policy word, so "no refusal vocabulary" still
 * holds for everything a caller decides.
 */
function refuseStaleToken(
  live: LeaseStoreIncarnation | null,
  current: LeaseRow | null,
  token: LeaseExpectedToken,
): string | null {
  if (live === null || live.incarnationId !== token.incarnationId) {
    return "the token was issued under another incarnation of this store";
  }
  if (current === null || current.fence !== token.fence) {
    return "the token names a fence this record does not stand at";
  }
  return null;
}

function readAppliedMigrations(db: Database.Database): readonly LeaseStoreMigration[] {
  const rows = db
    .prepare("SELECT version, name, sha256 FROM lease_schema_migrations ORDER BY version ASC")
    .all() as { version: number; name: string; sha256: string }[];
  return rows.map((row) => ({ version: row.version, name: row.name, sql: "", sha256: row.sha256 }));
}

/**
 * Compare what is applied against what this build carries.
 *
 * Missing tail migrations are applied; anything else is fatal. A store whose
 * schema history is reordered, extra or checksum-mismatched is not a store this
 * build understands, and guessing would be how a broken arbiter quietly starts
 * granting.
 */
function checkMigrationConformance(applied: readonly LeaseStoreMigration[]): {
  readonly problems: readonly string[];
  readonly missing: readonly LeaseStoreMigration[];
} {
  const problems: string[] = [];
  for (const [index, row] of applied.entries()) {
    const expected = LEASE_STORE_MIGRATIONS[index];
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
  return { problems, missing: LEASE_STORE_MIGRATIONS.slice(applied.length) };
}

/**
 * Open the arbitration store at `path`, migrating it if it is behind.
 *
 * Fails closed: an unopenable file, a directory, a file that is not SQLite, a
 * schema this build does not understand, and a control-plane ledger handed here
 * by mistake all throw. A store that returned a handle in any of those cases
 * would grant leases nobody could trust.
 */
export function openLeaseStore(path: string, options: OpenLeaseStoreOptions = {}): LeaseStore {
  requireText(path, "path");
  const registration = requireOptionalRegistration(options);
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new LedgerOpenError(
      path,
      "busyTimeoutMs must be an integer between 0 and " + String(MAX_BUSY_TIMEOUT_MS),
    );
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

    // The wrong file, refused rather than colonized. Creating an arbitration
    // table inside the control-plane ledger would put two unrelated schemas in
    // the authority's own database.
    const ledgerTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_plane_events'")
      .get();
    if (ledgerTable !== undefined) {
      throw new LedgerOpenError(path, "this file is a control-plane ledger, not an arbitration store");
    }

    // And the sibling arbiters, refused by the rule X1a wrote rather than by a
    // list. Every database in this package records its own migrations under a
    // name ending `schema_migrations`, so a file already carrying somebody
    // else's already belongs to somebody else — and the rule catches a store
    // that does not exist yet as readily as the three that do.
    //
    // It has to run **before** the DDL below, not after. A lease store opened on
    // `tool-claims.sqlite` used to create `lease_schema_migrations` there with a
    // bare `db.exec`, fail later in migration 2 on a `coordination_store_meta`
    // that was already present, and leave the sibling's file carrying a foreign
    // table — which the sibling's own guard then refuses forever. Refusing
    // before writing anything is what keeps a mistake recoverable.
    const foreign = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'" +
          " AND name LIKE '%schema_migrations' AND name <> 'lease_schema_migrations'",
      )
      .get() as { readonly name: string } | undefined;
    if (foreign !== undefined) {
      throw new LedgerOpenError(path, "this file already belongs to another store in this package");
    }

    db.exec(LEASE_MIGRATIONS_DDL);

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
            "INSERT INTO lease_schema_migrations (version, name, sha256) VALUES (?, ?, ?)",
          ).run(migration.version, migration.name, migration.sha256);
        }
      }).immediate();
    }

    // The incarnation, registered only if this file has none *and* the caller
    // brought one. A file that already carries a metadata row keeps it, whatever
    // was passed: rotating an incarnation is coordination §8.2's restore, which
    // has a quiescence proof in front of it and is not an argument to a
    // constructor. A file with neither gets neither, and that is the adoption
    // window — not a failure.
    //
    // The kind is checked here and refused here, which is the only place it can
    // be: a handle already returned is a handle that can grant.
    const kindMismatch = db.transaction((): string | null => {
      const existing = db
        .prepare(
          "SELECT store_kind, store_incarnation_id, created_at FROM coordination_store_meta WHERE singleton_id = 1",
        )
        .get() as RawMeta | undefined;
      if (existing === undefined) {
        if (registration !== null) {
          db.prepare(
            "INSERT INTO coordination_store_meta (singleton_id, store_kind, store_incarnation_id, created_at)" +
              " VALUES (1, 'WORKTREE_LEASE', ?, ?)",
          ).run(registration.incarnationId, registration.createdAt);
        }
        return null;
      }
      return existing.store_kind === "WORKTREE_LEASE" ? null : existing.store_kind;
    }).immediate();
    if (kindMismatch !== null) {
      throw new LedgerOpenError(
        path,
        "this file is a " + kindMismatch + " coordination store, and a worktree arbiter is not one",
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

  const readRow = (worktreePath: string): LeaseRow | null => {
    const raw = db
      .prepare("SELECT " + SELECT_COLUMNS + " FROM worktree_lease WHERE worktree_path = ?")
      .get(worktreePath) as RawRow | undefined;
    return raw === undefined ? null : toRow(raw);
  };

  /**
   * The metadata row, read now and never remembered.
   *
   * `null` is an absent row, which is lawful here. A row that has turned into
   * another store's is not: it means this file was colonized after the handle
   * opened, and continuing would arbitrate a worktree with somebody else's
   * identity.
   */
  const readMeta = (): LeaseStoreIncarnation | null => {
    const raw = db
      .prepare(
        "SELECT store_kind, store_incarnation_id, created_at FROM coordination_store_meta WHERE singleton_id = 1",
      )
      .get() as RawMeta | undefined;
    if (raw === undefined) return null;
    if (raw.store_kind !== "WORKTREE_LEASE") {
      throw new LedgerIntegrityError(["the arbitration metadata now declares store kind " + raw.store_kind]);
    }
    return { storeKind: "WORKTREE_LEASE", incarnationId: raw.store_incarnation_id, createdAt: raw.created_at };
  };

  /**
   * The one arbitrated seam.
   *
   * `.immediate()` rather than the deferred default: the write lock is taken at
   * `BEGIN`, so two processes serialize at the start of the decision instead of
   * discovering the conflict when the first one writes.
   *
   * The metadata is read **here**, inside the lock, on every call. A handle that
   * read it at `open` would carry the answer from before a restore into the
   * first decision taken after one.
   */
  const transactRunner = db.transaction(
    (
      worktreePath: string,
      decide: (current: LeaseRow | null) => LeaseDecision,
      expectedToken: LeaseExpectedToken | null,
    ): LeaseStoreOutcome => {
      const live = readMeta();
      const current = readRow(worktreePath);

      if (expectedToken !== null) {
        const stale = refuseStaleToken(live, current, expectedToken);
        if (stale !== null) return { verb: "REFUSE", reason: stale, row: current };
      }

      const decision = decide(current);

      if (decision.verb === "REFUSE") {
        return { verb: "REFUSE", reason: decision.reason, row: current };
      }

      if (decision.verb === "GRANT") {
        const grant = requireGrant(decision.row);
        // The grant is stamped with the incarnation as it stands *now*, which is
        // what makes the pair `(store_incarnation_id, fence)` a token at all. A
        // re-grant over a record written before this column existed stamps it
        // too: the record is being granted again, so it belongs to this
        // incarnation whatever it belonged to before.
        const stamp = live === null ? null : live.incarnationId;
        if (current === null) {
          db.prepare(
            "INSERT INTO worktree_lease (worktree_path, fence, lease_id, holder, acquired_at," +
              " expires_at, holder_pid, holder_token, released_at, store_incarnation_id)" +
              " VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL, ?)",
          ).run(
            worktreePath,
            grant.leaseId,
            grant.holder,
            grant.acquiredAt,
            grant.expiresAt,
            grant.holderPid,
            grant.holderToken,
            stamp,
          );
        } else {
          db.prepare(
            "UPDATE worktree_lease SET fence = fence + 1, lease_id = ?, holder = ?," +
              " acquired_at = ?, expires_at = ?, holder_pid = ?, holder_token = ?, released_at = NULL," +
              " store_incarnation_id = ? WHERE worktree_path = ?",
          ).run(
            grant.leaseId,
            grant.holder,
            grant.acquiredAt,
            grant.expiresAt,
            grant.holderPid,
            grant.holderToken,
            stamp,
            worktreePath,
          );
        }
        const granted = readRow(worktreePath);
        if (granted === null) throw new LedgerQueryError("the granted record could not be read back");
        return { verb: "GRANT", row: granted };
      }

      // RELEASE. The holder columns are cleared and the record stays; `fence`
      // is untouched, which is what keeps it monotonic across the cycle — and so
      // is `store_incarnation_id`, which names the incarnation that granted the
      // lease being released and would say something false about any other.
      const at = requireText(decision.at, "at");
      if (current === null) {
        throw new LedgerQueryError("cannot release a worktree that was never granted");
      }
      db.prepare(
        "UPDATE worktree_lease SET lease_id = NULL, holder = NULL, acquired_at = NULL," +
          " expires_at = NULL, holder_pid = NULL, holder_token = NULL, released_at = ?" +
          " WHERE worktree_path = ?",
      ).run(at, worktreePath);
      const released = readRow(worktreePath);
      if (released === null) throw new LedgerQueryError("the released record could not be read back");
      return { verb: "RELEASE", row: released };
    },
  );

  const sweepRunner = db.transaction((now: string): readonly LeaseRow[] => {
    const expired = db
      .prepare(
        "SELECT worktree_path FROM worktree_lease" +
          " WHERE lease_id IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .all(now) as { worktree_path: string }[];
    if (expired.length === 0) return [];
    db.prepare(
      "UPDATE worktree_lease SET lease_id = NULL, holder = NULL, acquired_at = NULL," +
        " expires_at = NULL, holder_pid = NULL, holder_token = NULL, released_at = ?" +
        " WHERE lease_id IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?",
    ).run(now, now);
    const cleared: LeaseRow[] = [];
    for (const row of expired) {
      const after = readRow(row.worktree_path);
      if (after !== null) cleared.push(after);
    }
    return cleared;
  });

  return {
    transact(worktreePath, decide, expectedToken) {
      assertOpen("transact");
      requireText(worktreePath, "worktreePath");
      return transactRunner.immediate(worktreePath, decide, requireOptionalToken(expectedToken));
    },
    read(worktreePath) {
      assertOpen("read");
      requireText(worktreePath, "worktreePath");
      return readRow(worktreePath);
    },
    list() {
      assertOpen("list");
      const rows = db
        .prepare("SELECT " + SELECT_COLUMNS + " FROM worktree_lease ORDER BY worktree_path ASC")
        .all() as RawRow[];
      return rows.map(toRow);
    },
    incarnation() {
      assertOpen("incarnation");
      return readMeta();
    },
    sweep(now) {
      assertOpen("sweep");
      requireText(now, "now");
      return sweepRunner.immediate(now);
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
