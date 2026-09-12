import { dirname, join } from "node:path";

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
 *
 * ## The file says what it is, and which time it is
 *
 * Coordination §8.1 gives every coordination file its own
 * `coordination_store_meta`: one row, a `store_kind` out of a closed dictionary
 * of five, an incarnation and the instant it began. P-18 escalón E1 added it
 * here as migration 2, behind the table it governs, because migration 1 shipped
 * before §8.1 existed and its checksum is immutable.
 *
 * **The kind is the identity, not the filename.** A file whose metadata says
 * `WORKTREE_LEASE` is refused at `open`, before anything is written, and the
 * refusal is reachable because the `CHECK` carries all five kinds rather than
 * only this one.
 *
 * **A claim token is `(store_incarnation_id, claim_id)`** — §8.1 `:390`, and
 * note that it carries **no fence**: a claim has no counter, so a token shaped
 * like the lease's would be a term this store cannot answer for.
 * {@link ToolClaimStore.transact} takes that pair as an optional
 * `expectedToken`, compares it **inside** the write lock against the metadata as
 * it stands and the record as it stands, and answers `REFUSE` as a value. A
 * `claim_id` is a fresh UUID per claim rather than a counter, so it does not
 * repeat the way a restored fence does — but the file it was issued against can
 * be destroyed and rebuilt with the same claim replayed into it, and then only
 * the incarnation separates the two.
 *
 * ## The adoption window, declared rather than hidden
 *
 * `incarnationId` and `createdAt` are **optional** arguments to
 * {@link openToolClaimStore}, and they are never generated here: §8.1 says "sin
 * default implícito" twice. A caller that supplies neither gets no metadata row
 * and **no refusal** — which is what both doors do today, so §8.1's "persistida
 * antes de emitir tokens" is not yet in force here. ADR 0075 records that window
 * and names the packet that closes it. A file that already carries metadata
 * keeps it: rotating an incarnation is coordination §8.2's blocked restore.
 *
 * `store_incarnation_id` is stamped by every `TAKE` — the first claim and the
 * reclaim alike — with the incarnation read inside the lock, and conserved by
 * `MARK_IN_FLIGHT` and `SETTLE`. A row written before the column existed reads
 * back `NULL`, advances normally, and is stamped by the next reclaim.
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
  /**
   * The incarnation of this file that granted the claim, or `null`.
   *
   * `null` on a record written before the column existed, and on a claim taken
   * while this file carried no metadata — the adoption window in the module
   * docblock. Stamped by every `TAKE`, conserved by the forward transitions.
   */
  readonly storeIncarnationId: string | null;
}

/**
 * This file's own incarnation, as `coordination_store_meta` holds it.
 *
 * `null` where a {@link ToolClaimStore.incarnation} is expected means the file
 * carries no metadata row at all — not that one is malformed.
 */
export interface ToolClaimStoreIncarnation {
  readonly storeKind: "TOOL_CLAIM";
  readonly incarnationId: string;
  readonly createdAt: string;
}

/**
 * The claim token of coordination §8.1 `:390`, as a caller hands it back.
 *
 * The pair, and **no fence**: a claim is identified by the id it was granted,
 * not by a counter. §8.1 `:393-394` still applies to it — a claim replayed into
 * a rebuilt file carries the same id and belongs to a different incarnation.
 */
export interface ToolClaimExpectedToken {
  readonly incarnationId: string;
  readonly claimId: string;
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
   *
   * `expectedToken` is the optional gate of N-P18-11. Supplied, it is compared
   * inside the lock against the live metadata and the current record *before*
   * `decide` is consulted, and a mismatch answers `REFUSE` without running the
   * caller's decision at all. Omitted — which is what both doors do today —
   * nothing about the call changes.
   */
  readonly transact: (
    coordinateKey: string,
    decide: (current: ToolClaimRow | null) => ToolClaimDecision,
    expectedToken?: ToolClaimExpectedToken,
  ) => ToolClaimOutcome;
  readonly read: (coordinateKey: string) => ToolClaimRow | null;
  /**
   * This file's incarnation, read from the database rather than remembered.
   *
   * `null` while the file carries no metadata row. Never cached: a handle that
   * answered from memory would answer about the file as it was.
   */
  readonly incarnation: () => ToolClaimStoreIncarnation | null;
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
 *
 * **The metadata is migration 2 here and migration 1 in the outbox**, and the
 * difference is history rather than design: §8.1 wants it "persistida antes de
 * emitir tokens", which a file built from nothing can honour, and this file was
 * shipped before §8.1 existed. So it arrives behind the table it governs, and
 * every claim written in between reads back with `store_incarnation_id IS NULL`
 * — the nullable window §8.1 `:384` allows, not a constraint that was lost.
 *
 * The `ADD COLUMN` is additive and nullable for the same reason: SQLite will add
 * a column to a `STRICT` table with no default only if existing rows can hold
 * nothing there, and existing rows are exactly what this migration must not
 * disturb. Version 1's checksum is unchanged by all of it, which the suite pins
 * by digest rather than by inspection.
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

ALTER TABLE tool_claim ADD COLUMN store_incarnation_id TEXT;
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
  readonly store_incarnation_id: string | null;
}

interface RawMeta {
  readonly store_kind: string;
  readonly store_incarnation_id: string;
  readonly created_at: string;
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
    storeIncarnationId: raw.store_incarnation_id,
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

/**
 * The incarnation to register, or nothing at all.
 *
 * Both halves or neither: an incarnation with no instant is a registration this
 * store cannot complete, and §8.1 gives `created_at` no default either. What is
 * refused here is a **malformed argument**, never an absent metadata row — the
 * adoption window in the module docblock turns on exactly that distinction.
 */
function requireOptionalRegistration(
  options: OpenToolClaimStoreOptions,
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
function requireOptionalToken(
  token: ToolClaimExpectedToken | undefined,
): ToolClaimExpectedToken | null {
  if (token === undefined) return null;
  return {
    incarnationId: requireText(token.incarnationId, "expectedToken.incarnationId"),
    claimId: requireText(token.claimId, "expectedToken.claimId"),
  };
}

/**
 * N-P18-11, as a precondition rather than as policy.
 *
 * The incarnation is compared **first** because it is the term that is not in
 * the row. A claim replayed into a rebuilt file carries the same `claim_id` it
 * always had, and §8.1 `:393-394` is explicit that coinciding is not matching.
 *
 * A file with no metadata refuses every token: nobody in the adoption window
 * passes one, and a store that accepted a token it cannot place would be
 * answering a question it has no instrument for.
 */
function refuseStaleToken(
  live: ToolClaimStoreIncarnation | null,
  current: ToolClaimRow | null,
  token: ToolClaimExpectedToken,
): string | null {
  if (live === null || live.incarnationId !== token.incarnationId) {
    return "the token was issued under another incarnation of this store";
  }
  if (current === null || current.claimId !== token.claimId) {
    return "the token names a claim this coordinate does not hold";
  }
  return null;
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

    // The wrong file, refused rather than colonized: putting a claim table into
    // the authority's own database — or into a sibling arbiter's — would be two
    // unrelated schemas in one file and two answers to what that file is.
    //
    // Stated as a rule rather than as a list of foreign table names. Every
    // database in this package records its own migrations under a name ending
    // `schema_migrations`, so a file already carrying somebody else's is a file
    // that already belongs to somebody else — and this catches a sibling that
    // does not exist yet as readily as the three that do. Naming those tables
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

    // The incarnation, registered only if this file has none *and* the caller
    // brought one. A file that already carries a metadata row keeps it, whatever
    // was passed: rotating an incarnation is coordination §8.2's restore, which
    // has a quiescence proof in front of it and is not an argument to a
    // constructor. A file with neither gets neither, and that is the adoption
    // window — not a failure.
    //
    // The kind is checked here and refused here, which is the only place it can
    // be: a handle already returned is a handle that can claim.
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
              " VALUES (1, 'TOOL_CLAIM', ?, ?)",
          ).run(registration.incarnationId, registration.createdAt);
        }
        return null;
      }
      return existing.store_kind === "TOOL_CLAIM" ? null : existing.store_kind;
    }).immediate();
    if (kindMismatch !== null) {
      throw new LedgerOpenError(
        path,
        "this file is a " + kindMismatch + " coordination store, and a claim store is not one",
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

  const SELECT_COLUMNS =
    "coordinate_key, state, claim_id, holder, claimed_at, expires_at, in_flight_at, settled_at," +
    " task_id, attempt, transition_id, submitted_at, account_id, server_id, tool_name, argument_bytes," +
    " store_incarnation_id";

  const readRow = (coordinateKey: string): ToolClaimRow | null => {
    const raw = db
      .prepare("SELECT " + SELECT_COLUMNS + " FROM tool_claim WHERE coordinate_key = ?")
      .get(coordinateKey) as RawRow | undefined;
    return raw === undefined ? null : toRow(raw);
  };

  /**
   * The metadata row, read now and never remembered.
   *
   * `null` is an absent row, which is lawful here. A row that has turned into
   * another store's is not: it means this file was colonized after the handle
   * opened, and continuing would arbitrate a coordinate with somebody else's
   * identity.
   */
  const readMeta = (): ToolClaimStoreIncarnation | null => {
    const raw = db
      .prepare(
        "SELECT store_kind, store_incarnation_id, created_at FROM coordination_store_meta WHERE singleton_id = 1",
      )
      .get() as RawMeta | undefined;
    if (raw === undefined) return null;
    if (raw.store_kind !== "TOOL_CLAIM") {
      throw new LedgerIntegrityError(["the claim metadata now declares store kind " + raw.store_kind]);
    }
    return { storeKind: "TOOL_CLAIM", incarnationId: raw.store_incarnation_id, createdAt: raw.created_at };
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
  const runner = db.transaction(
    (
      coordinateKey: string,
      decide: (current: ToolClaimRow | null) => ToolClaimDecision,
      expectedToken: ToolClaimExpectedToken | null,
    ): ToolClaimOutcome => {
      const live = readMeta();
      const current = readRow(coordinateKey);

      if (expectedToken !== null) {
        const stale = refuseStaleToken(live, current, expectedToken);
        if (stale !== null) return { verb: "REFUSE", reason: stale, row: current };
      }

      const decision = decide(current);

      if (decision.verb === "REFUSE") {
        return { verb: "REFUSE", reason: decision.reason, row: current };
      }

      if (decision.verb === "TAKE") {
        const grant = requireGrant(decision.row);
        // Terminal means terminal, for every caller. The reclaim branch below
        // rewrites the holder columns in place and clears `settled_at`, so
        // without this guard a `TAKE` on a settled row would re-open a spent
        // coordinate — against this store's own "one way, never back", and by
        // the one verb that was not checking it. Unreachable from a caller that
        // reads the receipt first, which is why it went unnoticed; but the
        // authority should not depend on its callers remembering the order.
        //
        // A state, not an expiry: no clock is consulted and none is needed.
        if (current !== null && current.state === "SETTLED") {
          throw new LedgerQueryError("a settled coordinate is spent and cannot be reclaimed");
        }
        // The claim is stamped with the incarnation as it stands *now*, which is
        // what makes the pair `(store_incarnation_id, claim_id)` a token at all.
        // A reclaim over a record written before this column existed stamps it
        // too: the coordinate is being claimed again, so it belongs to this
        // incarnation whatever it belonged to before.
        const stamp = live === null ? null : live.incarnationId;
        if (current === null) {
          db.prepare(
            "INSERT INTO tool_claim (coordinate_key, state, claim_id, holder, claimed_at," +
              " expires_at, in_flight_at, settled_at, task_id, attempt, transition_id," +
              " submitted_at, account_id, server_id, tool_name, argument_bytes, store_incarnation_id)" +
              " VALUES (?, 'CLAIMED', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            stamp,
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
              " argument_bytes = ?, store_incarnation_id = ? WHERE coordinate_key = ?",
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
            stamp,
            coordinateKey,
          );
        }
        const taken = readRow(coordinateKey);
        if (taken === null) throw new LedgerQueryError("the claimed record could not be read back");
        return { verb: "TAKE", row: taken };
      }

      // The two forward transitions. Both are one-way and both refuse to invent
      // a record: a coordinate nobody claimed cannot be advanced. Neither names
      // `store_incarnation_id`, so both conserve it — advancing a claim is not
      // granting one, and a row that changed hands on a state change would make
      // the token a moving target.
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
    transact(coordinateKey, decide, expectedToken) {
      assertOpen("transact");
      requireText(coordinateKey, "coordinateKey");
      return runner.immediate(coordinateKey, decide, requireOptionalToken(expectedToken));
    },
    read(coordinateKey) {
      assertOpen("read");
      requireText(coordinateKey, "coordinateKey");
      return readRow(coordinateKey);
    },
    incarnation() {
      assertOpen("incarnation");
      return readMeta();
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
