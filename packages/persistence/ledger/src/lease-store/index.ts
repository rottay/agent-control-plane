import Database from "better-sqlite3";

import { sha256Hex } from "../canonical-json/index.js";
import {
  LedgerClosedError,
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
   */
  readonly transact: (
    worktreePath: string,
    decide: (current: LeaseRow | null) => LeaseDecision,
  ) => LeaseStoreOutcome;
  readonly read: (worktreePath: string) => LeaseRow | null;
  readonly list: () => readonly LeaseRow[];
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
  };
}

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
      .prepare(
        "SELECT worktree_path, fence, lease_id, holder, acquired_at, expires_at," +
          " holder_pid, holder_token, released_at FROM worktree_lease WHERE worktree_path = ?",
      )
      .get(worktreePath) as RawRow | undefined;
    return raw === undefined ? null : toRow(raw);
  };

  /**
   * The one arbitrated seam.
   *
   * `.immediate()` rather than the deferred default: the write lock is taken at
   * `BEGIN`, so two processes serialize at the start of the decision instead of
   * discovering the conflict when the first one writes.
   */
  const transactRunner = db.transaction(
    (worktreePath: string, decide: (current: LeaseRow | null) => LeaseDecision): LeaseStoreOutcome => {
      const current = readRow(worktreePath);
      const decision = decide(current);

      if (decision.verb === "REFUSE") {
        return { verb: "REFUSE", reason: decision.reason, row: current };
      }

      if (decision.verb === "GRANT") {
        const grant = requireGrant(decision.row);
        if (current === null) {
          db.prepare(
            "INSERT INTO worktree_lease (worktree_path, fence, lease_id, holder, acquired_at," +
              " expires_at, holder_pid, holder_token, released_at)" +
              " VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL)",
          ).run(
            worktreePath,
            grant.leaseId,
            grant.holder,
            grant.acquiredAt,
            grant.expiresAt,
            grant.holderPid,
            grant.holderToken,
          );
        } else {
          db.prepare(
            "UPDATE worktree_lease SET fence = fence + 1, lease_id = ?, holder = ?," +
              " acquired_at = ?, expires_at = ?, holder_pid = ?, holder_token = ?, released_at = NULL" +
              " WHERE worktree_path = ?",
          ).run(
            grant.leaseId,
            grant.holder,
            grant.acquiredAt,
            grant.expiresAt,
            grant.holderPid,
            grant.holderToken,
            worktreePath,
          );
        }
        const granted = readRow(worktreePath);
        if (granted === null) throw new LedgerQueryError("the granted record could not be read back");
        return { verb: "GRANT", row: granted };
      }

      // RELEASE. The holder columns are cleared and the record stays; `fence`
      // is untouched, which is what keeps it monotonic across the cycle.
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
    transact(worktreePath, decide) {
      assertOpen("transact");
      requireText(worktreePath, "worktreePath");
      return transactRunner.immediate(worktreePath, decide);
    },
    read(worktreePath) {
      assertOpen("read");
      requireText(worktreePath, "worktreePath");
      return readRow(worktreePath);
    },
    list() {
      assertOpen("list");
      const rows = db
        .prepare(
          "SELECT worktree_path, fence, lease_id, holder, acquired_at, expires_at," +
            " holder_pid, holder_token, released_at FROM worktree_lease ORDER BY worktree_path ASC",
        )
        .all() as RawRow[];
      return rows.map(toRow);
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
