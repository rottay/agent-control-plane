import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { sha256Hex } from "../canonical-json/index.js";
import {
  LedgerClosedError,
  LedgerMigrationError,
  LedgerOpenError,
  LedgerQueryError,
} from "../errors/index.js";

/**
 * The tool-coordinate claim store — V2 X1a.
 *
 * ## The question this answers, and the one it does not
 *
 * `runToolCall` reads the receipt for a coordinate, spawns a tool, and appends.
 * Two processes can both read "no receipt", both spawn, and both append — the
 * ledger absorbs the second, so the plane records **one row for two effects**.
 * The proven semantic today is an exactly-once *receipt* over an at-least-once
 * *effect*.
 *
 * This module is the substrate that closes the gap: one row per coordinate, one
 * decision at a time. It is the same object ADR 0021 built for worktrees,
 * pointed at a different key — and it is deliberately **inert**. Nothing calls
 * it yet; adopting it is X1b's packet, exactly as C2 adopted C1's store.
 *
 * *What happened?* remains the ledger's question. *May I run this tool call,
 * now?* is this one's, and it holds no history: the receipts are the history.
 *
 * ## Both halves of the mechanism are load-bearing
 *
 * `coordinate_key` is the PRIMARY KEY, so **at most one record can exist** per
 * coordinate. That is necessary and not sufficient: it prevents two records,
 * not two decisions. `BEGIN IMMEDIATE` takes the write lock at `BEGIN` rather
 * than at first write, so the read, the decision and the write are one unit and
 * the second process sees the first one's result rather than the state it raced
 * against. `L-X1-2` asserts the second half, because the key will not catch a
 * decision moved outside the transaction.
 *
 * ## The row is a recovery record, not only a lock
 *
 * A poison receipt must be **byte-identical** whoever writes it. The
 * idempotency key is built from `(taskId, attempt, transitionId)` alone, but the
 * event body carries `occurredAt`/`recordedAt` from the submission instant, plus
 * the account, the emitter, the server, the tool and the byte count. Two
 * recoverers with different submission instants would build one key from
 * different bytes, and the second would take an idempotency conflict.
 *
 * So the claim stores every field a recovering caller needs, written at claim
 * time by the original holder. A recoverer rebuilds the receipt from the
 * **claim**, never from itself.
 *
 * ## Three stored states, and why POISON is not a fourth
 *
 * `CLAIMED → IN_FLIGHT → SETTLED`, one way, never back. A poison is not a stored
 * state: it is what a *caller* does on finding an expired `IN_FLIGHT` — append
 * the `POSTCONDITION_UNKNOWN` receipt, then `SETTLE`. The store transitions
 * straight to `SETTLED`, and holds no opinion about which receipt was written.
 *
 * ## What this module does not have
 *
 * No clock — every instant is a caller's argument, so expiry is decided by the
 * caller and this store can be drilled at a boundary without sleeping. No
 * environment read, no process probe, no `DELETE`, no sweep, and no path
 * invention beyond {@link toolClaimStorePath}. `L-X1-2` asserts the absences.
 *
 * ## The residual window, stated rather than hidden
 *
 * If this file is **destroyed** while a coordinate sits in `IN_FLIGHT` and
 * before any caller has promoted that claim into a receipt, the coordinate
 * becomes re-runnable and the plane degrades to at-least-once for it. The window
 * is exactly "from the loss until the next caller touches that coordinate".
 *
 * It is narrow because the poison is promoted **into the ledger** by the first
 * recoverer: once the receipt exists, losing this file is harmless. But it is
 * not closed, and nothing here or downstream may describe it as closed. The
 * claim this substrate supports is an exactly-once receipt and an exactly-once
 * effect per coordinate across processes **except** across a claimant crash in
 * the window between the tool answering and the receipt landing — where the
 * coordinate settles fail-closed and is never re-run. Never an unqualified
 * "exactly once".
 */

/** The claim's life. Closed and ordered; a poison is a caller's `SETTLE`. */
export const TOOL_CLAIM_STATES = ["CLAIMED", "IN_FLIGHT", "SETTLED"] as const;
export type ToolClaimState = (typeof TOOL_CLAIM_STATES)[number];

/** One claim, as the caller sees it. */
export interface ToolClaimRow {
  /** The ledger idempotency key for this tool call. The PRIMARY KEY. */
  readonly coordinateKey: string;
  readonly state: ToolClaimState;
  readonly claimId: string | null;
  readonly holder: string | null;
  readonly claimedAt: string | null;
  readonly expiresAt: string | null;
  /** Non-null exactly in and after `IN_FLIGHT`. */
  readonly inFlightAt: string | null;
  readonly settledAt: string | null;
  // The recovery record. Written at claim time, read by any recoverer.
  readonly taskId: string;
  readonly attempt: number;
  readonly transitionId: string;
  readonly submittedAt: string;
  readonly accountId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly argumentBytes: number;
}

/** Everything a caller must supply to take a coordinate. */
export interface ToolClaimGrant {
  readonly claimId: string;
  readonly holder: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly transitionId: string;
  readonly submittedAt: string;
  readonly accountId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly argumentBytes: number;
}

/**
 * The caller's decision, taken with the write lock already held.
 *
 * Every instant is carried in, because this module reads no clock. A `decide`
 * that consulted one would make expiry untestable without sleeping.
 */
export type ToolClaimDecision =
  | { readonly verb: "TAKE"; readonly row: ToolClaimGrant }
  | { readonly verb: "MARK_IN_FLIGHT"; readonly at: string }
  | { readonly verb: "SETTLE"; readonly at: string }
  | { readonly verb: "REFUSE"; readonly reason: string };

/** What the store did, with the record as it stands afterwards. */
export type ToolClaimOutcome =
  | { readonly verb: "TAKE" | "MARK_IN_FLIGHT" | "SETTLE"; readonly row: ToolClaimRow }
  | { readonly verb: "REFUSE"; readonly reason: string; readonly row: ToolClaimRow | null };

export interface ToolClaimStore {
  /**
   * Read, decide and write as one unit under the database write lock.
   *
   * `decide` receives the record as it is **inside** the lock — never a value
   * read before it — and must be pure and synchronous. `better-sqlite3` is
   * synchronous, so no `await` can interleave between the read, the decision and
   * the write; that is why the seam is a callback rather than a read-then-write
   * pair the caller assembles.
   *
   * If `decide` throws, the transaction rolls back and the throw propagates: no
   * partial write is possible.
   */
  readonly transact: (
    coordinateKey: string,
    decide: (current: ToolClaimRow | null) => ToolClaimDecision,
  ) => ToolClaimOutcome;
  readonly read: (coordinateKey: string) => ToolClaimRow | null;
  readonly close: () => void;
}

export interface OpenToolClaimStoreOptions {
  /**
   * How long a contending process waits for the write lock before giving up.
   *
   * Generous by default: the point of the lock is that claimants serialize, not
   * that one of them fails fast.
   */
  readonly busyTimeoutMs?: number;
}

/**
 * The claim store that belongs to one ledger. **One producer, no second
 * spelling.**
 *
 * Derived from the ledger's own path rather than supplied, and `L-X1-3` asserts
 * this is the only file that composes it. Two doors that each built the path
 * themselves could disagree by a directory, and two claim stores over one ledger
 * is no mutual exclusion at all — while looking exactly like mutual exclusion.
 */
export function toolClaimStorePath(ledgerPath: string): string {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new LedgerQueryError("ledgerPath must be a non-empty string");
  }
  return join(dirname(ledgerPath), "tool-claims.sqlite");
}

interface ToolClaimMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

/**
 * This database's own migration bookkeeping.
 *
 * Named apart from the ledger's `schema_migrations` **and** from the lease
 * store's `lease_schema_migrations`, and `L-X1-4` asserts all three differ: a
 * shared name is how a file opened by the wrong module looks migrated when it is
 * not. No `applied_at`: this module reads no clock, and *when* a shape arrived
 * is history, which this store does not keep.
 */
const TOOL_CLAIM_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS tool_claim_schema_migrations (
  version INTEGER NOT NULL PRIMARY KEY,
  name    TEXT    NOT NULL,
  sha256  TEXT    NOT NULL
) STRICT;
`;

/**
 * The ordered, checksummed migration set.
 *
 * Same law as the ledger's and the lease store's: a shipped migration is never
 * edited, because the recorded checksum is compared against this source on every
 * open. A schema change is a new version appended to the end.
 */
const MIGRATION_SOURCES: readonly { readonly version: number; readonly name: string; readonly sql: string }[] = [
  {
    version: 1,
    name: "tool_claim",
    sql: `
CREATE TABLE tool_claim (
  coordinate_key TEXT    NOT NULL PRIMARY KEY,
  state          TEXT    NOT NULL,
  claim_id       TEXT,
  holder         TEXT,
  claimed_at     TEXT,
  expires_at     TEXT,
  in_flight_at   TEXT,
  settled_at     TEXT,
  task_id        TEXT    NOT NULL,
  attempt        INTEGER NOT NULL,
  transition_id  TEXT    NOT NULL,
  submitted_at   TEXT    NOT NULL,
  account_id     TEXT    NOT NULL,
  server_id      TEXT    NOT NULL,
  tool_name      TEXT    NOT NULL,
  argument_bytes INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX tool_claim_claim_id
  ON tool_claim (claim_id)
  WHERE claim_id IS NOT NULL;
`,
  },
];

const TOOL_CLAIM_MIGRATIONS: readonly ToolClaimMigration[] = MIGRATION_SOURCES.map((source) => ({
  version: source.version,
  name: source.name,
  sql: source.sql,
  sha256: sha256Hex(source.sql),
}));

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 600_000;

interface RawRow {
  readonly coordinate_key: string;
  readonly state: string;
  readonly claim_id: string | null;
  readonly holder: string | null;
  readonly claimed_at: string | null;
  readonly expires_at: string | null;
  readonly in_flight_at: string | null;
  readonly settled_at: string | null;
  readonly task_id: string;
  readonly attempt: number;
  readonly transition_id: string;
  readonly submitted_at: string;
  readonly account_id: string;
  readonly server_id: string;
  readonly tool_name: string;
  readonly argument_bytes: number;
}

function isClaimState(value: string): value is ToolClaimState {
  return (TOOL_CLAIM_STATES as readonly string[]).includes(value);
}

function toRow(raw: RawRow): ToolClaimRow {
  if (!isClaimState(raw.state)) {
    throw new LedgerQueryError("the stored claim state is not one this build understands");
  }
  return {
    coordinateKey: raw.coordinate_key,
    state: raw.state,
    claimId: raw.claim_id,
    holder: raw.holder,
    claimedAt: raw.claimed_at,
    expiresAt: raw.expires_at,
    inFlightAt: raw.in_flight_at,
    settledAt: raw.settled_at,
    taskId: raw.task_id,
    attempt: raw.attempt,
    transitionId: raw.transition_id,
    submittedAt: raw.submitted_at,
    accountId: raw.account_id,
    serverId: raw.server_id,
    toolName: raw.tool_name,
    argumentBytes: raw.argument_bytes,
  };
}

/** A non-empty string argument, refused by name rather than stored malformed. */
function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerQueryError(field + " must be a non-empty string");
  }
  return value;
}

function requireGrant(grant: ToolClaimGrant): ToolClaimGrant {
  for (const [field, value] of [
    ["claimId", grant.claimId],
    ["holder", grant.holder],
    ["claimedAt", grant.claimedAt],
    ["expiresAt", grant.expiresAt],
    ["taskId", grant.taskId],
    ["transitionId", grant.transitionId],
    ["submittedAt", grant.submittedAt],
    ["accountId", grant.accountId],
    ["serverId", grant.serverId],
    ["toolName", grant.toolName],
  ] as const) {
    requireText(value, field);
  }
  if (!Number.isInteger(grant.attempt) || grant.attempt < 1) {
    throw new LedgerQueryError("attempt must be a positive integer");
  }
  if (!Number.isInteger(grant.argumentBytes) || grant.argumentBytes < 0) {
    throw new LedgerQueryError("argumentBytes must be a non-negative integer");
  }
  return grant;
}

function readAppliedMigrations(db: Database.Database): readonly ToolClaimMigration[] {
  const rows = db
    .prepare("SELECT version, name, sha256 FROM tool_claim_schema_migrations ORDER BY version ASC")
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
function checkMigrationConformance(applied: readonly ToolClaimMigration[]): {
  readonly problems: readonly string[];
  readonly missing: readonly ToolClaimMigration[];
} {
  const problems: string[] = [];
  for (const [index, row] of applied.entries()) {
    const expected = TOOL_CLAIM_MIGRATIONS[index];
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
  return { problems, missing: TOOL_CLAIM_MIGRATIONS.slice(applied.length) };
}

/**
 * Open the claim store at `path`, migrating it if it is behind.
 *
 * Fails closed: an unopenable file, a directory, a file that is not SQLite, a
 * schema this build does not understand, and a control-plane ledger or lease
 * store handed here by mistake all throw. A store that returned a handle in any
 * of those cases would arbitrate tool calls nobody could trust.
 */
export function openToolClaimStore(
  path: string,
  options: OpenToolClaimStoreOptions = {},
): ToolClaimStore {
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

    // The wrong file, refused rather than colonized: putting a claim table into
    // the authority's own database — or into a sibling arbiter's — would be two
    // unrelated schemas in one file and two answers to what that file is.
    //
    // Stated as a rule rather than as a list of foreign table names. Every
    // database in this package records its own migrations under a name ending
    // `schema_migrations`, so a file already carrying somebody else's is a file
    // that already belongs to somebody else — and this catches a sibling that
    // does not exist yet as readily as the two that do. Naming those tables
    // would also claim ground `L-C-1a` reserves: exactly one module may name the
    // worktree lease table, and this is not it.
    const foreign = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'" +
          " AND name LIKE '%schema_migrations' AND name <> 'tool_claim_schema_migrations'",
      )
      .get() as { readonly name: string } | undefined;
    if (foreign !== undefined) {
      throw new LedgerOpenError(path, "this file already belongs to another store in this package");
    }

    db.exec(TOOL_CLAIM_MIGRATIONS_DDL);

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
            "INSERT INTO tool_claim_schema_migrations (version, name, sha256) VALUES (?, ?, ?)",
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

  const SELECT_COLUMNS =
    "coordinate_key, state, claim_id, holder, claimed_at, expires_at, in_flight_at, settled_at," +
    " task_id, attempt, transition_id, submitted_at, account_id, server_id, tool_name, argument_bytes";

  const readRow = (coordinateKey: string): ToolClaimRow | null => {
    const raw = db
      .prepare("SELECT " + SELECT_COLUMNS + " FROM tool_claim WHERE coordinate_key = ?")
      .get(coordinateKey) as RawRow | undefined;
    return raw === undefined ? null : toRow(raw);
  };

  /**
   * The one arbitrated seam.
   *
   * `.immediate()` rather than the deferred default: the write lock is taken at
   * `BEGIN`, so two processes serialize at the start of the decision instead of
   * discovering the conflict when the first one writes.
   */
  const runner = db.transaction(
    (
      coordinateKey: string,
      decide: (current: ToolClaimRow | null) => ToolClaimDecision,
    ): ToolClaimOutcome => {
      const current = readRow(coordinateKey);
      const decision = decide(current);

      if (decision.verb === "REFUSE") {
        return { verb: "REFUSE", reason: decision.reason, row: current };
      }

      if (decision.verb === "TAKE") {
        const grant = requireGrant(decision.row);
        if (current === null) {
          db.prepare(
            "INSERT INTO tool_claim (coordinate_key, state, claim_id, holder, claimed_at," +
              " expires_at, in_flight_at, settled_at, task_id, attempt, transition_id," +
              " submitted_at, account_id, server_id, tool_name, argument_bytes)" +
              " VALUES (?, 'CLAIMED', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            coordinateKey,
            grant.claimId,
            grant.holder,
            grant.claimedAt,
            grant.expiresAt,
            grant.taskId,
            grant.attempt,
            grant.transitionId,
            grant.submittedAt,
            grant.accountId,
            grant.serverId,
            grant.toolName,
            grant.argumentBytes,
          );
        } else {
          // A reclaim. The record is never deleted, so taking an expired
          // coordinate rewrites the holder columns and the recovery record in
          // place — and clears `in_flight_at`, because this claimant has not
          // attempted the effect.
          db.prepare(
            "UPDATE tool_claim SET state = 'CLAIMED', claim_id = ?, holder = ?, claimed_at = ?," +
              " expires_at = ?, in_flight_at = NULL, settled_at = NULL, task_id = ?, attempt = ?," +
              " transition_id = ?, submitted_at = ?, account_id = ?, server_id = ?, tool_name = ?," +
              " argument_bytes = ? WHERE coordinate_key = ?",
          ).run(
            grant.claimId,
            grant.holder,
            grant.claimedAt,
            grant.expiresAt,
            grant.taskId,
            grant.attempt,
            grant.transitionId,
            grant.submittedAt,
            grant.accountId,
            grant.serverId,
            grant.toolName,
            grant.argumentBytes,
            coordinateKey,
          );
        }
        const taken = readRow(coordinateKey);
        if (taken === null) throw new LedgerQueryError("the claimed record could not be read back");
        return { verb: "TAKE", row: taken };
      }

      // The two forward transitions. Both are one-way and both refuse to invent
      // a record: a coordinate nobody claimed cannot be advanced.
      if (current === null) {
        throw new LedgerQueryError("cannot advance a coordinate that was never claimed");
      }

      if (decision.verb === "MARK_IN_FLIGHT") {
        const at = requireText(decision.at, "at");
        if (current.state !== "CLAIMED") {
          throw new LedgerQueryError("only a CLAIMED coordinate may be marked in flight");
        }
        db.prepare(
          "UPDATE tool_claim SET state = 'IN_FLIGHT', in_flight_at = ? WHERE coordinate_key = ?",
        ).run(at, coordinateKey);
        const marked = readRow(coordinateKey);
        if (marked === null) throw new LedgerQueryError("the in-flight record could not be read back");
        return { verb: "MARK_IN_FLIGHT", row: marked };
      }

      // SETTLE. Terminal, and reachable from either live state: an ordinary
      // completion settles from `IN_FLIGHT`, and a caller that promoted a
      // poison into a receipt settles the coordinate it just spent.
      const at = requireText(decision.at, "at");
      if (current.state === "SETTLED") {
        throw new LedgerQueryError("this coordinate is already settled");
      }
      db.prepare(
        "UPDATE tool_claim SET state = 'SETTLED', settled_at = ? WHERE coordinate_key = ?",
      ).run(at, coordinateKey);
      const settled = readRow(coordinateKey);
      if (settled === null) throw new LedgerQueryError("the settled record could not be read back");
      return { verb: "SETTLE", row: settled };
    },
  );

  return {
    transact(coordinateKey, decide) {
      assertOpen("transact");
      requireText(coordinateKey, "coordinateKey");
      return runner.immediate(coordinateKey, decide);
    },
    read(coordinateKey) {
      assertOpen("read");
      requireText(coordinateKey, "coordinateKey");
      return readRow(coordinateKey);
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
