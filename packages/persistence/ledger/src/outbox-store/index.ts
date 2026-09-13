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
 * The outbox message store — P-18/protocolo escalón E2.
 *
 * ## What this is, and the one thing it is not
 *
 * A **cache of delivery, and nothing else** (coordination §6). The durable fact
 * that a command was intended is an event in the ledger; a row here is the
 * working copy a dispatcher reads to decide *what should I send, now?* Losing
 * this entire file costs liveness, not evidence — and specifically it cannot
 * manufacture a false `PENDING`, because a missing file answers absence as
 * absence rather than as an empty queue of work nobody owes.
 *
 * The half of that promise which rebuilds rows from the events is not here: it
 * needs to read the ledger, which is escalón F's. What is here is the half that
 * makes the rebuild possible — an initial state that is a **parameter** rather
 * than the constant `'PENDING'`, so a durable attempt with no outcome can be
 * reconstructed straight into `RECONCILING` (§6.2), and a schema that refuses a
 * row born `RECONCILING` without its attempt anchor.
 *
 * ## What the mould gave, and what it did not
 *
 * The file shape is `lease-store`'s and `tool-claim-store`'s: a separate SQLite
 * database with its own checksummed migration list under its own bookkeeping
 * table, `STRICT` throughout, no clock, no environment, no `DELETE`, one
 * producer of the path, and a wrong-file guard stated as a rule rather than as
 * a list of foreign table names.
 *
 * What neither of them has is the mechanism this store exists for. They
 * arbitrate with `BEGIN IMMEDIATE` and a `decide` callback that runs inside the
 * lock: the decision sees the state it is deciding against, so no version is
 * needed. An outbox row is different — it is read by one process, carried
 * across an **external dispatch**, and written back afterwards, so the window
 * between the read and the write is exactly where another reconciler can move
 * it. That window is what `row_version` closes, and coordination §6.1 specifies
 * the closing as a compare-and-set rather than as a longer lock, because no
 * lock may be held across a network call.
 *
 * ## The predicate has three terms, and the fourth is not in the row
 *
 * A read returns `(outbox incarnation, command_id, row_version, state)` and a
 * mutation carries that tuple straight back — {@link OutboxStore.readToken}
 * produces exactly what {@link OutboxStore.cas} consumes. Three of the four
 * terms are the `UPDATE`'s `WHERE` predicate. The fourth, the incarnation, is
 * **not** a column of `outbox_message`: it lives once per file in
 * `coordination_store_meta`, and it is what makes the ABA impossible.
 *
 * The ABA is real here and not theoretical. `row_version` is born `0` on every
 * row, so restoring this file from a backup produces rows whose versions repeat
 * numbers that were already issued. A token holding `(command_id=C,
 * row_version=0, state=PENDING)` from before the restore matches a rebuilt row
 * perfectly. Only the incarnation separates them — so it is checked **inside**
 * the transaction on every mutation, never cached at `open`, because a handle
 * opened before a restore would otherwise carry a stale answer into a decision
 * taken after it.
 *
 * ## `CONFLICT` is a value
 *
 * Zero rows changed is a refusal the caller must act on — re-read, and decide
 * again against what it finds — so it is returned, never thrown. That is this
 * package's standing rule: everything a caller must act on is a refusal value,
 * which is why the ledger's thirteen error classes do not move for this module.
 * A mutation that changed more than one row is not a refusal but a broken
 * unique index, and that does throw.
 *
 * A replay is a third answer and not a dishonest first one. §6.1 says an
 * effective change increments the version by exactly one and a replay without
 * change conserves the row, so a `cas` that would write nothing reports
 * `UNCHANGED` and writes nothing — including `updated_at`, which is the stamp
 * of an effective change rather than a change in its own right. Were
 * `updated_at` counted as substance, no retry could ever be a replay, because
 * every retry carries a fresh instant.
 *
 * ## No verb moves a row by the clock
 *
 * Coordination §2 closes with "el vencimiento no agrega otra transición". An
 * expired `INFLIGHT` **obliges** a caller to reconcile; it does not authorise
 * this store to do it. So there is no `sweep` here — the one verb that takes an
 * instant, {@link OutboxStore.listOverdue}, reads and returns rows and mutates
 * nothing, and the instant is the caller's argument as everywhere else in this
 * package.
 *
 * ## Where the door validates and where the schema does
 *
 * The door refuses **shapes**: empty strings, non-integers, values outside a
 * closed vocabulary, digests that are not 64 lowercase hex characters. Those
 * get a typed refusal naming the field, because a caller can fix them.
 *
 * The schema holds the **cross-column invariants**: the fence and its target
 * incarnation are null together, the attempt anchor is all-or-nothing and the
 * counter follows it, a `RECONCILING` row points at the attempt it is
 * reconciling, an attempt's stream equals the intention's, an owner exists
 * exactly in `INFLIGHT`, identity and destination are immutable, the version
 * moves by exactly one, and the transition is one §2 admits. They are
 * not restated in TypeScript, so they are enforced in exactly one place and
 * every one of them is exercised against the database rather than against a
 * copy of itself.
 *
 * ## Inert
 *
 * Nothing calls this. No producer writes a row and no dispatcher reads one —
 * escalón F owns the saga, the command identity and the events, and this store
 * lands first and alone, exactly as C1's lease store landed before C2 adopted
 * it and X1a's claim store before X1b.
 */

/** The message's life. Seven values, closed; coordination §2. */
export const OUTBOX_STATES = [
  "PENDING",
  "INFLIGHT",
  "RECONCILING",
  "DELIVERED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "ABANDONED",
] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

/**
 * The three states nothing leaves.
 *
 * And in this store, nothing mutates either: a settled outcome is evidence, and
 * §6.1 already says where a late result goes — "registra el resultado tardío
 * identificado en el ledger". A relay that arrives after the row is terminal
 * has a place to write, and it is not this file.
 */
export const OUTBOX_TERMINAL_STATES = ["DELIVERED", "FAILED_TERMINAL", "ABANDONED"] as const;

/** What a command asks of its destination. Four values, closed; coordination §2. */
export const OUTBOX_COMMAND_KINDS = [
  "RELEASE_RESERVATION",
  "REVOKE_LEASE",
  "NOTIFY",
  "EXPORT_TELEMETRY",
] as const;
export type OutboxCommandKind = (typeof OUTBOX_COMMAND_KINDS)[number];

/**
 * The four streams an anchor may name.
 *
 * The same closed catalogue `ck_projection_watermark__source_stream` carries in
 * the ledger's own migration 8. Restated rather than imported because this is a
 * different database with its own schema, and a CHECK in this file that
 * depended on a constant in another module would be a schema whose meaning
 * lives somewhere its DDL cannot reach.
 */
export const OUTBOX_STREAMS = [
  "control_plane_events",
  "initiative_events",
  "account_events",
  "registry_events",
] as const;
export type OutboxStream = (typeof OUTBOX_STREAMS)[number];

/**
 * The transitions coordination §2 admits, **and no others**.
 *
 * A same-state mutation is not a transition and is not in this table: backoff,
 * a response handle, an owner or a deadline may all change while the state
 * stands, and §6.1 says each of those increments the version. What the table
 * governs is a move from one state to another, and the schema's trigger is the
 * one that enforces it — this constant is the readable statement of the same
 * rule, and the suite drives all forty-nine ordered pairs against the database
 * to prove the two agree rather than asserting that they do.
 */
export const OUTBOX_TRANSITIONS: ReadonlyMap<OutboxState, readonly OutboxState[]> = new Map<
  OutboxState,
  readonly OutboxState[]
>([
  ["PENDING", ["INFLIGHT", "ABANDONED"]],
  ["INFLIGHT", ["DELIVERED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "RECONCILING"]],
  ["RECONCILING", ["DELIVERED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "ABANDONED"]],
  ["FAILED_RETRYABLE", ["PENDING", "ABANDONED"]],
  ["DELIVERED", []],
  ["FAILED_TERMINAL", []],
  ["ABANDONED", []],
]);

/**
 * The largest version this build will carry a row to.
 *
 * SQLite would count to 2^63, but every caller reads the value through
 * JavaScript, where integers stop being distinguishable from their neighbours
 * above 2^53 - 1. A version that cannot be compared is not a version, so the
 * refusal is placed where the representation actually fails rather than where
 * the column would: §6.1's "overflow de versión rechaza", at the bound that is
 * true for the callers this store has.
 */
export const MAX_OUTBOX_ROW_VERSION = Number.MAX_SAFE_INTEGER;

/**
 * A verifiable reference to one event: which stream, which position, which
 * digest.
 *
 * Never a position alone. §6 is explicit that an anchor "exige digest
 * coincidente" and that a sequence from another stream or a different hash
 * invalidates the row — rebuild from the correct events or fail, never guess.
 */
export interface OutboxEventAnchor {
  readonly stream: OutboxStream;
  readonly sequence: number;
  readonly sha256: string;
}

/** This file's own incarnation, as `coordination_store_meta` holds it. */
export interface OutboxIncarnation {
  readonly storeKind: "OUTBOX";
  readonly incarnationId: string;
  readonly createdAt: string;
}

/**
 * One message, as the caller sees it.
 *
 * `targetStoreIncarnationId` is the **destination's** incarnation, carried from
 * the intention in the ledger. It is not this file's, it is never replaced by
 * this file's, and the two living side by side is the one naming trap of this
 * escalón: a reconstruction that wrote the live outbox incarnation into that
 * column would be inventing authority over a fence it does not own.
 */
export interface OutboxRow {
  readonly outboxMessageId: string;
  readonly sagaId: string;
  readonly commandId: string;
  readonly phase: string;
  readonly intent: OutboxEventAnchor;
  readonly commandKind: OutboxCommandKind;
  readonly targetKind: string;
  readonly targetId: string;
  readonly fence: number | null;
  readonly targetStoreIncarnationId: string | null;
  readonly state: OutboxState;
  readonly rowVersion: number;
  readonly attemptCount: number;
  readonly nextEligibleAt: string | null;
  readonly deadlineAt: string;
  readonly responseHandle: string | null;
  /**
   * A typed failure code from the contracts map, or null.
   *
   * Stored as `TEXT` with no CHECK: the vocabulary belongs to
   * [contracts §16], and a CHECK here would bind this file's schema to another
   * package's catalogue — a coupling that would have to be migrated every time
   * that catalogue grew. The writer imposes the vocabulary, and the writer is
   * escalón F.
   */
  readonly lastFailureCode: string | null;
  readonly lastAttempt: OutboxEventAnchor | null;
  readonly ownerProcessId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A new row, exactly as it is to be born.
 *
 * `state` is here rather than fixed at `'PENDING'` because a reconstruction has
 * to be able to produce a row that is already `RECONCILING` — §6.2's "un intento
 * durable sin desenlace se reconstruye `RECONCILING`, nunca `PENDING`". The
 * schema is what keeps that honest: such a row carries its attempt anchor, and
 * one without it is refused.
 *
 * `commandId` is **not derived here.** §6 says it is deterministic over
 * `(saga_id, phase, target_kind, target_id)`, and deriving it would give this
 * store a grammar of sagas it has no business holding. The caller computes it;
 * this store imposes uniqueness and nothing more.
 *
 * `rowVersion` is absent on purpose: a row is born at zero, always, and that is
 * precisely what makes the incarnation load-bearing.
 */
export interface OutboxMessageSeed {
  readonly outboxMessageId: string;
  readonly sagaId: string;
  readonly commandId: string;
  readonly phase: string;
  readonly intent: OutboxEventAnchor;
  readonly commandKind: OutboxCommandKind;
  readonly targetKind: string;
  readonly targetId: string;
  readonly fence?: number | null;
  readonly targetStoreIncarnationId?: string | null;
  readonly state: OutboxState;
  readonly attemptCount?: number;
  readonly nextEligibleAt?: string | null;
  readonly deadlineAt: string;
  readonly responseHandle?: string | null;
  readonly lastFailureCode?: string | null;
  readonly lastAttempt?: OutboxEventAnchor | null;
  readonly ownerProcessId?: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What a read hands back and a mutation hands in — the tuple of §6.1 `:267`.
 *
 * The incarnation is first because it is the term that is not in the row.
 */
export interface OutboxCasToken {
  readonly incarnationId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly expectedState: OutboxState;
}

/**
 * The complete value of every mutable column, not a patch.
 *
 * Two things follow, and both are deliberate. A replay is **decidable**: the
 * store can compare what is proposed against what stands and know whether
 * anything would actually change, which a partial patch could never support.
 * And the immutable columns — identity, destination, fence and the original
 * anchor — are not expressible: they have no field here, so a caller cannot
 * even ask. The `BEFORE UPDATE` trigger is the backstop for a writer that
 * bypasses this type and reaches the table directly.
 */
export interface OutboxMutation {
  readonly state: OutboxState;
  readonly attemptCount: number;
  readonly nextEligibleAt: string | null;
  readonly deadlineAt: string;
  readonly responseHandle: string | null;
  readonly lastFailureCode: string | null;
  readonly lastAttempt: OutboxEventAnchor | null;
  readonly ownerProcessId: number | null;
  readonly updatedAt: string;
}

/**
 * What the compare-and-set did.
 *
 * `CONFLICT` carries the row as it actually stands, or `null` when no row
 * carries that `command_id` at all, so the caller re-reads from the answer it
 * already has rather than issuing a second query against a moving target.
 */
export type OutboxCasOutcome =
  | { readonly verb: "APPLIED"; readonly row: OutboxRow }
  | { readonly verb: "UNCHANGED"; readonly row: OutboxRow }
  | { readonly verb: "CONFLICT"; readonly row: OutboxRow | null };

export interface OutboxStore {
  /**
   * This file's incarnation, read from the database rather than remembered.
   *
   * A cached answer would be wrong after a restore, and being wrong about the
   * incarnation is the one error this store exists to make impossible.
   */
  readonly incarnation: () => OutboxIncarnation;
  readonly read: (commandId: string) => OutboxRow | null;
  /** The four-tuple of §6.1, or null when no row carries that `command_id`. */
  readonly readToken: (commandId: string) => OutboxCasToken | null;
  readonly insert: (seed: OutboxMessageSeed) => OutboxRow;
  /**
   * Compare, and set if the comparison holds.
   *
   * Inside `BEGIN IMMEDIATE`: the current incarnation is checked, then the
   * `UPDATE` runs under a predicate of `command_id`, expected version and
   * expected state, setting `row_version = row_version + 1`. Exactly one row
   * must change. Zero is `CONFLICT` and a re-read — never a success and never
   * an implicit resend.
   */
  readonly cas: (token: OutboxCasToken, mutation: OutboxMutation) => OutboxCasOutcome;
  /**
   * The non-terminal rows whose deadline has passed at the instant supplied.
   *
   * Read-only, and that is the whole point: expiry obliges a caller to
   * reconcile and authorises this store to do nothing at all.
   */
  readonly listOverdue: (now: string) => readonly OutboxRow[];
  readonly close: () => void;
}

export interface OpenOutboxStoreOptions {
  /**
   * The incarnation to register **if this file has none yet**.
   *
   * Supplied, never generated: §8.1 says "sin default implícito" of both this
   * and its instant, and a UUID minted in here would read the environment this
   * module is forbidden to read and would make the ABA drill impossible to aim.
   *
   * On a file that already carries a meta row, the stored incarnation stands
   * and this value is not used. Rotating an incarnation is a restore, and a
   * restore is coordination §8.2's blocked procedure — not an argument to
   * `open`.
   */
  readonly incarnationId: string;
  /** The instant that incarnation began, on the same terms. */
  readonly createdAt: string;
  /**
   * How long a contending process waits for the write lock before giving up.
   *
   * Generous by default: the point of the lock is that writers serialize, not
   * that one of them fails fast.
   */
  readonly busyTimeoutMs?: number;
}

/**
 * The outbox that belongs to one ledger. **One producer, no second spelling.**
 *
 * Derived from the ledger's own path rather than supplied, on the reasoning
 * `L-X1-3` already carries for the claim store: two doors that each composed
 * the path themselves could disagree by a directory, and two outboxes over one
 * ledger is not one queue — it is two, each certain it is the only one.
 *
 * The filename is coordination §1's and datos §11's, twice stated.
 */
export function outboxStorePath(ledgerPath: string): string {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new LedgerQueryError("ledgerPath must be a non-empty string");
  }
  return join(dirname(ledgerPath), "outbox.sqlite");
}

interface OutboxMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

/**
 * This database's own migration bookkeeping.
 *
 * A fourth distinct name, apart from the ledger's `schema_migrations`, the
 * lease store's and the claim store's, and `L-X1-4` asserts all four differ: a
 * shared name is how a file opened by the wrong module looks migrated when it
 * is not. No `applied_at` — this module reads no clock.
 */
const OUTBOX_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS outbox_schema_migrations (
  version INTEGER NOT NULL PRIMARY KEY,
  name    TEXT    NOT NULL,
  sha256  TEXT    NOT NULL
) STRICT;
`;

/**
 * The ordered, checksummed migration set.
 *
 * Same law as the ledger's, the lease store's and the claim store's: a shipped
 * migration is never edited, because the recorded checksum is compared against
 * this source on every open. A schema change is a new version appended.
 *
 * **The metadata is migration 1**, before the table it governs. §8.1 says it is
 * "persistida antes de emitir tokens", and a file that held rows before it held
 * an incarnation would have issued tokens nobody could later place.
 *
 * The `store_kind` CHECK carries all five kinds of the §8.1 dictionary rather
 * than just this one. A CHECK narrowed to `'OUTBOX'` would make the open-time
 * refusal of a foreign kind unreachable — and therefore untestable, and
 * therefore not a guard at all.
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
    name: "outbox_message",
    sql: `
CREATE TABLE outbox_message (
  outbox_message_id           TEXT    NOT NULL,
  saga_id                     TEXT    NOT NULL,
  command_id                  TEXT    NOT NULL,
  phase                       TEXT    NOT NULL,
  intent_stream               TEXT    NOT NULL,
  intent_sequence             INTEGER NOT NULL,
  intent_sha256               TEXT    NOT NULL,
  command_kind                TEXT    NOT NULL,
  target_kind                 TEXT    NOT NULL,
  target_id                   TEXT    NOT NULL,
  fence                       INTEGER,
  target_store_incarnation_id TEXT,
  state                       TEXT    NOT NULL,
  row_version                 INTEGER NOT NULL DEFAULT 0,
  attempt_count               INTEGER NOT NULL DEFAULT 0,
  next_eligible_at            TEXT,
  deadline_at                 TEXT    NOT NULL,
  response_handle             TEXT,
  last_failure_code           TEXT,
  last_attempt_stream         TEXT,
  last_attempt_sequence       INTEGER,
  last_attempt_sha256         TEXT,
  owner_process_id            INTEGER,
  created_at                  TEXT    NOT NULL,
  updated_at                  TEXT    NOT NULL,

  CONSTRAINT pk_outbox_message PRIMARY KEY (outbox_message_id),

  CONSTRAINT ck_outbox_message__state_enum CHECK (
    state IN (
      'PENDING',
      'INFLIGHT',
      'RECONCILING',
      'DELIVERED',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL',
      'ABANDONED'
    )
  ),
  CONSTRAINT ck_outbox_message__command_kind_enum CHECK (
    command_kind IN ('RELEASE_RESERVATION', 'REVOKE_LEASE', 'NOTIFY', 'EXPORT_TELEMETRY')
  ),
  CONSTRAINT ck_outbox_message__intent_stream_enum CHECK (
    intent_stream IN ('control_plane_events', 'initiative_events', 'account_events', 'registry_events')
  ),
  CONSTRAINT ck_outbox_message__intent_sequence CHECK (intent_sequence > 0),
  CONSTRAINT ck_outbox_message__intent_sha256 CHECK (
    length(intent_sha256) = 64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ck_outbox_message__row_version CHECK (row_version >= 0),
  CONSTRAINT ck_outbox_message__attempt_count CHECK (attempt_count >= 0),

  -- The fence and the incarnation of the destination it was issued under are
  -- one fact in two columns: a fence without the incarnation is a number that
  -- cannot be placed, and an incarnation without a fence is a destination
  -- nothing was issued against.
  --
  -- Written as an equality of two nullity tests rather than as a disjunction of
  -- the two lawful shapes. A comparison against a NULL fence is itself NULL,
  -- and a CHECK that evaluates to NULL passes -- so the disjunctive form admits
  -- exactly the row it was written to refuse.
  CONSTRAINT ck_outbox_message__fence CHECK (
    (fence IS NULL) = (target_store_incarnation_id IS NULL)
    AND (fence IS NULL OR fence > 0)
  ),

  -- The anchor is all-or-nothing, and the counter follows it exactly: zero
  -- attempts if and only if there is no anchor. A row claiming an attempt it
  -- cannot point at is the shape a reconstruction would produce by guessing.
  --
  -- The last clause is the other direction of the same rule. RECONCILING means
  -- a durable attempt whose outcome is unknown, so a row born there without an
  -- anchor is a claim about an attempt nobody can find -- and reconstruction is
  -- precisely where that row would otherwise be invented.
  CONSTRAINT ck_outbox_message__attempt_anchor CHECK (
    (
      (
        last_attempt_stream IS NULL
        AND last_attempt_sequence IS NULL
        AND last_attempt_sha256 IS NULL
        AND attempt_count = 0
      )
      OR (
        last_attempt_stream IS NOT NULL
        AND last_attempt_sequence IS NOT NULL
        AND last_attempt_sha256 IS NOT NULL
        AND attempt_count > 0
        AND last_attempt_sequence > 0
        AND length(last_attempt_sha256) = 64
        AND last_attempt_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    )
    AND (state <> 'RECONCILING' OR last_attempt_stream IS NOT NULL)
  ),
  CONSTRAINT ck_outbox_message__attempt_stream CHECK (
    last_attempt_stream IS NULL OR last_attempt_stream = intent_stream
  ),

  -- Who holds it in flight, and nobody otherwise.
  CONSTRAINT ck_outbox_message__owner_process_id CHECK (
    (state = 'INFLIGHT') = (owner_process_id IS NOT NULL)
  ),

  -- Backoff is a promise to try again, which a terminal row is not making.
  CONSTRAINT ck_outbox_message__next_eligible_at CHECK (
    next_eligible_at IS NULL
    OR state NOT IN ('DELIVERED', 'FAILED_TERMINAL', 'ABANDONED')
  )
) STRICT;

-- Uniqueness is on the command, not on the grouper: one saga emits many
-- commands, and two of them are two rows.
CREATE UNIQUE INDEX ux_outbox_message__command_id ON outbox_message (command_id);
CREATE INDEX ix_outbox_message__saga_id ON outbox_message (saga_id);
CREATE INDEX ix_outbox_message__state_next_eligible_at
  ON outbox_message (state, next_eligible_at);
CREATE INDEX ix_outbox_message__deadline_at ON outbox_message (deadline_at);

-- Identity, destination, fence and the original anchor are immutable. The
-- mutation type cannot express a change to any of them; this is what stands
-- between the table and a writer that never passed through the type.
CREATE TRIGGER tr_outbox_message__immutable
BEFORE UPDATE ON outbox_message
BEGIN
  SELECT RAISE(ABORT, 'outbox identity, destination, fence and intent anchor are immutable')
  WHERE NEW.outbox_message_id IS NOT OLD.outbox_message_id
     OR NEW.saga_id IS NOT OLD.saga_id
     OR NEW.command_id IS NOT OLD.command_id
     OR NEW.phase IS NOT OLD.phase
     OR NEW.command_kind IS NOT OLD.command_kind
     OR NEW.target_kind IS NOT OLD.target_kind
     OR NEW.target_id IS NOT OLD.target_id
     OR NEW.fence IS NOT OLD.fence
     OR NEW.target_store_incarnation_id IS NOT OLD.target_store_incarnation_id
     OR NEW.intent_stream IS NOT OLD.intent_stream
     OR NEW.intent_sequence IS NOT OLD.intent_sequence
     OR NEW.intent_sha256 IS NOT OLD.intent_sha256
     OR NEW.created_at IS NOT OLD.created_at;
END;

-- One step, never two and never none. A write that reaches the table is an
-- effective change by construction, because a replay is refused before it.
CREATE TRIGGER tr_outbox_message__row_version
BEFORE UPDATE ON outbox_message
BEGIN
  SELECT RAISE(ABORT, 'the outbox row version is exhausted and this row admits no further mutation')
  WHERE OLD.row_version >= 9007199254740991;

  SELECT RAISE(ABORT, 'an effective outbox mutation increments the row version by exactly one')
  WHERE NEW.row_version <> OLD.row_version + 1;
END;

-- The vocabulary of coordination section 2, and nothing else. A same-state
-- write is not a transition and is not listed; a terminal row is not mutated at
-- all, because a late outcome is recorded in the ledger rather than written
-- over evidence.
CREATE TRIGGER tr_outbox_message__transition
BEFORE UPDATE ON outbox_message
BEGIN
  SELECT RAISE(ABORT, 'a terminal outbox message admits no further mutation')
  WHERE OLD.state IN ('DELIVERED', 'FAILED_TERMINAL', 'ABANDONED');

  SELECT RAISE(ABORT, 'this outbox state transition is not one the vocabulary admits')
  WHERE NEW.state <> OLD.state
    AND NOT (
      (OLD.state = 'PENDING' AND NEW.state IN ('INFLIGHT', 'ABANDONED'))
      OR (OLD.state = 'INFLIGHT'
          AND NEW.state IN ('DELIVERED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'RECONCILING'))
      OR (OLD.state = 'RECONCILING'
          AND NEW.state IN ('DELIVERED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'ABANDONED'))
      OR (OLD.state = 'FAILED_RETRYABLE' AND NEW.state IN ('PENDING', 'ABANDONED'))
    );
END;
`,
  },
];

const OUTBOX_MIGRATIONS: readonly OutboxMigration[] = MIGRATION_SOURCES.map((source) => ({
  version: source.version,
  name: source.name,
  sql: source.sql,
  sha256: sha256Hex(source.sql),
}));

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 600_000;

interface RawRow {
  readonly outbox_message_id: string;
  readonly saga_id: string;
  readonly command_id: string;
  readonly phase: string;
  readonly intent_stream: string;
  readonly intent_sequence: number;
  readonly intent_sha256: string;
  readonly command_kind: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly fence: number | null;
  readonly target_store_incarnation_id: string | null;
  readonly state: string;
  readonly row_version: number;
  readonly attempt_count: number;
  readonly next_eligible_at: string | null;
  readonly deadline_at: string;
  readonly response_handle: string | null;
  readonly last_failure_code: string | null;
  readonly last_attempt_stream: string | null;
  readonly last_attempt_sequence: number | null;
  readonly last_attempt_sha256: string | null;
  readonly owner_process_id: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RawMeta {
  readonly store_kind: string;
  readonly store_incarnation_id: string;
  readonly created_at: string;
}

function isOutboxState(value: string): value is OutboxState {
  return (OUTBOX_STATES as readonly string[]).includes(value);
}

function isCommandKind(value: string): value is OutboxCommandKind {
  return (OUTBOX_COMMAND_KINDS as readonly string[]).includes(value);
}

function isStream(value: string): value is OutboxStream {
  return (OUTBOX_STREAMS as readonly string[]).includes(value);
}

function toRow(raw: RawRow): OutboxRow {
  if (!isOutboxState(raw.state)) {
    throw new LedgerQueryError("the stored outbox state is not one this build understands");
  }
  if (!isCommandKind(raw.command_kind)) {
    throw new LedgerQueryError("the stored outbox command kind is not one this build understands");
  }
  if (!isStream(raw.intent_stream)) {
    throw new LedgerQueryError("the stored intent stream is not one this build understands");
  }
  let lastAttempt: OutboxEventAnchor | null = null;
  if (
    raw.last_attempt_stream !== null &&
    raw.last_attempt_sequence !== null &&
    raw.last_attempt_sha256 !== null
  ) {
    if (!isStream(raw.last_attempt_stream)) {
      throw new LedgerQueryError("the stored attempt stream is not one this build understands");
    }
    lastAttempt = {
      stream: raw.last_attempt_stream,
      sequence: raw.last_attempt_sequence,
      sha256: raw.last_attempt_sha256,
    };
  }
  return {
    outboxMessageId: raw.outbox_message_id,
    sagaId: raw.saga_id,
    commandId: raw.command_id,
    phase: raw.phase,
    intent: {
      stream: raw.intent_stream,
      sequence: raw.intent_sequence,
      sha256: raw.intent_sha256,
    },
    commandKind: raw.command_kind,
    targetKind: raw.target_kind,
    targetId: raw.target_id,
    fence: raw.fence,
    targetStoreIncarnationId: raw.target_store_incarnation_id,
    state: raw.state,
    rowVersion: raw.row_version,
    attemptCount: raw.attempt_count,
    nextEligibleAt: raw.next_eligible_at,
    deadlineAt: raw.deadline_at,
    responseHandle: raw.response_handle,
    lastFailureCode: raw.last_failure_code,
    lastAttempt,
    ownerProcessId: raw.owner_process_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** A non-empty string argument, refused by name rather than stored malformed. */
function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerQueryError(field + " must be a non-empty string");
  }
  return value;
}

function requireOptionalText(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireText(value, field);
}

function requireState(value: OutboxState, field: string): OutboxState {
  if (typeof value !== "string" || !isOutboxState(value)) {
    throw new LedgerQueryError(field + " must be one of " + OUTBOX_STATES.join(", "));
  }
  return value;
}

function requireCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new LedgerQueryError(field + " must be a non-negative integer");
  }
  return value;
}

/**
 * The anchor, refused whole.
 *
 * The digest is checked for form here as well as in the schema, because a
 * caller that passed an uppercase digest deserves to be told which field is
 * wrong rather than which constraint fired.
 */
function requireAnchor(anchor: OutboxEventAnchor | null | undefined, field: string): OutboxEventAnchor | null {
  if (anchor === null || anchor === undefined) return null;
  if (typeof anchor.stream !== "string" || !isStream(anchor.stream)) {
    throw new LedgerQueryError(field + ".stream must be one of " + OUTBOX_STREAMS.join(", "));
  }
  if (!Number.isInteger(anchor.sequence) || anchor.sequence < 1) {
    throw new LedgerQueryError(field + ".sequence must be a positive integer");
  }
  if (typeof anchor.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(anchor.sha256)) {
    throw new LedgerQueryError(field + ".sha256 must be 64 lowercase hexadecimal characters");
  }
  return { stream: anchor.stream, sequence: anchor.sequence, sha256: anchor.sha256 };
}

function requireFence(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new LedgerQueryError(field + " must be a positive integer when present");
  }
  return value;
}

function requireProcessId(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new LedgerQueryError(field + " must be a positive integer when present");
  }
  return value;
}

function requireVersion(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new LedgerQueryError(field + " must be a non-negative integer");
  }
  if (value >= MAX_OUTBOX_ROW_VERSION) {
    throw new LedgerQueryError(
      field + " has reached " + String(MAX_OUTBOX_ROW_VERSION) + ", the largest version this build can compare",
    );
  }
  return value;
}

function requireToken(token: OutboxCasToken): OutboxCasToken {
  return {
    incarnationId: requireText(token.incarnationId, "token.incarnationId"),
    commandId: requireText(token.commandId, "token.commandId"),
    expectedVersion: requireVersion(token.expectedVersion, "token.expectedVersion"),
    expectedState: requireState(token.expectedState, "token.expectedState"),
  };
}

/** A constraint the schema refused, handed back as this package's own class. */
function refuseConstraint(error: unknown): never {
  const message = error instanceof Error ? error.message : "unknown error";
  throw new LedgerQueryError("the outbox schema refused this row: " + message);
}

function readAppliedMigrations(db: Database.Database): readonly OutboxMigration[] {
  const rows = db
    .prepare("SELECT version, name, sha256 FROM outbox_schema_migrations ORDER BY version ASC")
    .all() as { version: number; name: string; sha256: string }[];
  return rows.map((row) => ({ version: row.version, name: row.name, sql: "", sha256: row.sha256 }));
}

/**
 * Compare what is applied against what this build carries.
 *
 * Missing tail migrations are applied; anything else is fatal. A store whose
 * schema history is reordered, extra or checksum-mismatched is not a store this
 * build understands, and an outbox nobody can trust is worse than none.
 */
function checkMigrationConformance(applied: readonly OutboxMigration[]): {
  readonly problems: readonly string[];
  readonly missing: readonly OutboxMigration[];
} {
  const problems: string[] = [];
  for (const [index, row] of applied.entries()) {
    const expected = OUTBOX_MIGRATIONS[index];
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
  return { problems, missing: OUTBOX_MIGRATIONS.slice(applied.length) };
}

/**
 * Open the outbox at `path`, migrating it if it is behind and registering its
 * incarnation if it has none.
 *
 * Fails closed: an unopenable file, a directory, a file that is not SQLite, a
 * schema this build does not understand, a sibling store of this package handed
 * here by mistake, and a coordination file whose `store_kind` is something
 * other than `OUTBOX` all throw.
 */
export function openOutboxStore(path: string, options: OpenOutboxStoreOptions): OutboxStore {
  requireText(path, "path");
  const incarnationId = requireText(options.incarnationId, "incarnationId");
  const createdAt = requireText(options.createdAt, "createdAt");
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

    // The wrong file, refused rather than colonized — the claim store's rule,
    // not the lease store's list. Every database in this package records its
    // own migrations under a name ending `schema_migrations`, so a file already
    // carrying somebody else's already belongs to somebody else. Stated as a
    // rule, it also catches the two coordination files that do not exist yet.
    const foreign = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'" +
          " AND name LIKE '%schema_migrations' AND name <> 'outbox_schema_migrations'",
      )
      .get() as { readonly name: string } | undefined;
    if (foreign !== undefined) {
      throw new LedgerOpenError(path, "this file already belongs to another store in this package");
    }

    db.exec(OUTBOX_MIGRATIONS_DDL);

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
            "INSERT INTO outbox_schema_migrations (version, name, sha256) VALUES (?, ?, ?)",
          ).run(migration.version, migration.name, migration.sha256);
        }
      }).immediate();
    }

    // The incarnation, registered before this handle can issue a single token.
    // A file that already carries one keeps it: rotating an incarnation is a
    // restore, and coordination section 8.2 makes that a procedure with a
    // quiescence proof in front of it, not an argument to a constructor.
    const kindMismatch = db.transaction((): string | null => {
      const existing = db
        .prepare("SELECT store_kind, store_incarnation_id, created_at FROM coordination_store_meta WHERE singleton_id = 1")
        .get() as RawMeta | undefined;
      if (existing === undefined) {
        db.prepare(
          "INSERT INTO coordination_store_meta (singleton_id, store_kind, store_incarnation_id, created_at)" +
            " VALUES (1, 'OUTBOX', ?, ?)",
        ).run(incarnationId, createdAt);
        return null;
      }
      return existing.store_kind === "OUTBOX" ? null : existing.store_kind;
    }).immediate();
    if (kindMismatch !== null) {
      throw new LedgerOpenError(
        path,
        "this file is a " + kindMismatch + " coordination store, and an outbox is not one",
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
    "outbox_message_id, saga_id, command_id, phase, intent_stream, intent_sequence, intent_sha256," +
    " command_kind, target_kind, target_id, fence, target_store_incarnation_id, state, row_version," +
    " attempt_count, next_eligible_at, deadline_at, response_handle, last_failure_code," +
    " last_attempt_stream, last_attempt_sequence, last_attempt_sha256, owner_process_id," +
    " created_at, updated_at";

  const readRow = (commandId: string): OutboxRow | null => {
    const raw = db
      .prepare("SELECT " + SELECT_COLUMNS + " FROM outbox_message WHERE command_id = ?")
      .get(commandId) as RawRow | undefined;
    return raw === undefined ? null : toRow(raw);
  };

  /** The meta row, read now. Never remembered; see {@link OutboxStore.incarnation}. */
  const readMeta = (): OutboxIncarnation => {
    const raw = db
      .prepare("SELECT store_kind, store_incarnation_id, created_at FROM coordination_store_meta WHERE singleton_id = 1")
      .get() as RawMeta | undefined;
    if (raw === undefined) {
      throw new LedgerIntegrityError(["the outbox carries no incarnation; its metadata row is gone"]);
    }
    if (raw.store_kind !== "OUTBOX") {
      throw new LedgerIntegrityError(["the outbox metadata now declares store kind " + raw.store_kind]);
    }
    return { storeKind: "OUTBOX", incarnationId: raw.store_incarnation_id, createdAt: raw.created_at };
  };

  /**
   * Would this mutation change anything a caller can observe?
   *
   * `updated_at` is excluded on purpose: it is the stamp of an effective
   * change, so counting it as substance would make "replay sin cambio" a case
   * that never occurs — every retry carries a fresh instant.
   */
  const isReplay = (current: OutboxRow, mutation: OutboxMutation): boolean =>
    current.state === mutation.state &&
    current.attemptCount === mutation.attemptCount &&
    current.nextEligibleAt === mutation.nextEligibleAt &&
    current.deadlineAt === mutation.deadlineAt &&
    current.responseHandle === mutation.responseHandle &&
    current.lastFailureCode === mutation.lastFailureCode &&
    current.ownerProcessId === mutation.ownerProcessId &&
    (current.lastAttempt?.stream ?? null) === (mutation.lastAttempt?.stream ?? null) &&
    (current.lastAttempt?.sequence ?? null) === (mutation.lastAttempt?.sequence ?? null) &&
    (current.lastAttempt?.sha256 ?? null) === (mutation.lastAttempt?.sha256 ?? null);

  /**
   * The insert seam.
   *
   * Immediate for the same reason every other mutation here is: the uniqueness
   * of `command_id` prevents two rows, and only the write lock taken at `BEGIN`
   * prevents two decisions about whether there should be one.
   */
  const inserter = db.transaction((seed: OutboxMessageSeed): OutboxRow => {
    const intent = requireAnchor(seed.intent, "intent");
    if (intent === null) {
      throw new LedgerQueryError("intent must name the stream, sequence and digest of the intention event");
    }
    const lastAttempt = requireAnchor(seed.lastAttempt, "lastAttempt");
    if (typeof seed.commandKind !== "string" || !isCommandKind(seed.commandKind)) {
      throw new LedgerQueryError("commandKind must be one of " + OUTBOX_COMMAND_KINDS.join(", "));
    }
    const values = {
      outboxMessageId: requireText(seed.outboxMessageId, "outboxMessageId"),
      sagaId: requireText(seed.sagaId, "sagaId"),
      commandId: requireText(seed.commandId, "commandId"),
      phase: requireText(seed.phase, "phase"),
      targetKind: requireText(seed.targetKind, "targetKind"),
      targetId: requireText(seed.targetId, "targetId"),
      fence: requireFence(seed.fence, "fence"),
      targetStoreIncarnationId: requireOptionalText(seed.targetStoreIncarnationId, "targetStoreIncarnationId"),
      state: requireState(seed.state, "state"),
      attemptCount: requireCount(seed.attemptCount ?? 0, "attemptCount"),
      nextEligibleAt: requireOptionalText(seed.nextEligibleAt, "nextEligibleAt"),
      deadlineAt: requireText(seed.deadlineAt, "deadlineAt"),
      responseHandle: requireOptionalText(seed.responseHandle, "responseHandle"),
      lastFailureCode: requireOptionalText(seed.lastFailureCode, "lastFailureCode"),
      ownerProcessId: requireProcessId(seed.ownerProcessId, "ownerProcessId"),
      createdAt: requireText(seed.createdAt, "createdAt"),
      updatedAt: requireText(seed.updatedAt, "updatedAt"),
    };

    if (readRow(values.commandId) !== null) {
      throw new LedgerQueryError(
        "a message already carries command_id " + values.commandId + "; the command identity is unique",
      );
    }

    try {
      db.prepare(
        "INSERT INTO outbox_message (outbox_message_id, saga_id, command_id, phase, intent_stream," +
          " intent_sequence, intent_sha256, command_kind, target_kind, target_id, fence," +
          " target_store_incarnation_id, state, attempt_count, next_eligible_at, deadline_at," +
          " response_handle, last_failure_code, last_attempt_stream, last_attempt_sequence," +
          " last_attempt_sha256, owner_process_id, created_at, updated_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        values.outboxMessageId,
        values.sagaId,
        values.commandId,
        values.phase,
        intent.stream,
        intent.sequence,
        intent.sha256,
        seed.commandKind,
        values.targetKind,
        values.targetId,
        values.fence,
        values.targetStoreIncarnationId,
        values.state,
        values.attemptCount,
        values.nextEligibleAt,
        values.deadlineAt,
        values.responseHandle,
        values.lastFailureCode,
        lastAttempt === null ? null : lastAttempt.stream,
        lastAttempt === null ? null : lastAttempt.sequence,
        lastAttempt === null ? null : lastAttempt.sha256,
        values.ownerProcessId,
        values.createdAt,
        values.updatedAt,
      );
    } catch (error: unknown) {
      refuseConstraint(error);
    }

    const written = readRow(values.commandId);
    if (written === null) throw new LedgerQueryError("the inserted message could not be read back");
    return written;
  });

  /**
   * The compare-and-set seam.
   *
   * `.immediate()` rather than the deferred default, and the incarnation read
   * inside it rather than at `open`: a handle opened before a restore would
   * otherwise carry the old answer into a decision taken after it, which is
   * exactly the ABA this store is built to refuse.
   */
  const setter = db.transaction((token: OutboxCasToken, mutation: OutboxMutation): OutboxCasOutcome => {
    const live = readMeta();
    const current = readRow(token.commandId);
    if (live.incarnationId !== token.incarnationId) {
      // The number may match exactly and it changes nothing: a token from a
      // previous incarnation is a token about a file that no longer exists.
      return { verb: "CONFLICT", row: current };
    }
    if (current === null) {
      return { verb: "CONFLICT", row: null };
    }
    if (current.rowVersion !== token.expectedVersion || current.state !== token.expectedState) {
      return { verb: "CONFLICT", row: current };
    }
    if (isReplay(current, mutation)) {
      return { verb: "UNCHANGED", row: current };
    }

    let changes: number;
    try {
      const result = db
        .prepare(
          "UPDATE outbox_message SET state = ?, row_version = row_version + 1, attempt_count = ?," +
            " next_eligible_at = ?, deadline_at = ?, response_handle = ?, last_failure_code = ?," +
            " last_attempt_stream = ?, last_attempt_sequence = ?, last_attempt_sha256 = ?," +
            " owner_process_id = ?, updated_at = ?" +
            " WHERE command_id = ? AND row_version = ? AND state = ?",
        )
        .run(
          mutation.state,
          mutation.attemptCount,
          mutation.nextEligibleAt,
          mutation.deadlineAt,
          mutation.responseHandle,
          mutation.lastFailureCode,
          mutation.lastAttempt === null ? null : mutation.lastAttempt.stream,
          mutation.lastAttempt === null ? null : mutation.lastAttempt.sequence,
          mutation.lastAttempt === null ? null : mutation.lastAttempt.sha256,
          mutation.ownerProcessId,
          mutation.updatedAt,
          token.commandId,
          token.expectedVersion,
          token.expectedState,
        );
      changes = result.changes;
    } catch (error: unknown) {
      refuseConstraint(error);
    }

    // Zero is the refusal section 6.1 names: re-read and decide again, never a
    // success and never an implicit resend. More than one is not a refusal at
    // all -- one command identity matched several rows, so the unique index
    // this store depends on is gone.
    if (changes === 0) {
      return { verb: "CONFLICT", row: readRow(token.commandId) };
    }
    if (changes > 1) {
      throw new LedgerIntegrityError([
        "command_id " + token.commandId + " matched " + String(changes) + " rows; its unique index is gone",
      ]);
    }

    const applied = readRow(token.commandId);
    if (applied === null) throw new LedgerQueryError("the mutated message could not be read back");
    return { verb: "APPLIED", row: applied };
  });

  return {
    incarnation() {
      assertOpen("incarnation");
      return readMeta();
    },
    read(commandId) {
      assertOpen("read");
      requireText(commandId, "commandId");
      return readRow(commandId);
    },
    readToken(commandId) {
      assertOpen("readToken");
      requireText(commandId, "commandId");
      // One read transaction, deferred (postaudit of E2, O-1; adjudicated to F).
      // The row and the incarnation are read from one snapshot, so a token can
      // never pair a version from one incarnation with the id of another. Deferred
      // rather than immediate because nothing here writes: it takes no write lock
      // and serializes against no dispatcher, and `cas` still re-reads the live
      // incarnation inside its own immediate transaction.
      return db.transaction((): OutboxCasToken | null => {
        const row = readRow(commandId);
        if (row === null) return null;
        return {
          incarnationId: readMeta().incarnationId,
          commandId: row.commandId,
          expectedVersion: row.rowVersion,
          expectedState: row.state,
        };
      })();
    },
    insert(seed) {
      assertOpen("insert");
      return inserter.immediate(seed);
    },
    cas(token, mutation) {
      assertOpen("cas");
      const checked = requireToken(token);
      const stated: OutboxMutation = {
        state: requireState(mutation.state, "mutation.state"),
        attemptCount: requireCount(mutation.attemptCount, "mutation.attemptCount"),
        nextEligibleAt: requireOptionalText(mutation.nextEligibleAt, "mutation.nextEligibleAt"),
        deadlineAt: requireText(mutation.deadlineAt, "mutation.deadlineAt"),
        responseHandle: requireOptionalText(mutation.responseHandle, "mutation.responseHandle"),
        lastFailureCode: requireOptionalText(mutation.lastFailureCode, "mutation.lastFailureCode"),
        lastAttempt: requireAnchor(mutation.lastAttempt, "mutation.lastAttempt"),
        ownerProcessId: requireProcessId(mutation.ownerProcessId, "mutation.ownerProcessId"),
        updatedAt: requireText(mutation.updatedAt, "mutation.updatedAt"),
      };
      return setter.immediate(checked, stated);
    },
    listOverdue(now) {
      assertOpen("listOverdue");
      requireText(now, "now");
      const raws = db
        .prepare(
          "SELECT " +
            SELECT_COLUMNS +
            " FROM outbox_message WHERE deadline_at <= ?" +
            " AND state NOT IN ('DELIVERED', 'FAILED_TERMINAL', 'ABANDONED')" +
            " ORDER BY deadline_at ASC, command_id ASC",
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
