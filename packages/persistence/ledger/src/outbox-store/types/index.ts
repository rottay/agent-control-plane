/**
 * The value types of the outbox message store (P-18/protocolo escalón E2).
 *
 * The anchor, the incarnation, the row, the seed, the token, the mutation, the
 * outcome of the compare-and-set, the store handle and its open options: the
 * shapes a caller holds, declared in the concept that owns them rather than in
 * the package-wide `../../types/index.ts`, and beside the store rather than
 * inside its implementation (CORR-2, ADR 0079).
 *
 * A pure type leaf, on `packages/persistence/ledger/src/types/index.ts`'s
 * pattern: it declares data and nothing else and imports only types. The three
 * vocabulary types it reads stay in `../index.ts` beside the closed sets they
 * are derived from, because a type read off a constant belongs with the
 * constant; that one type-only import is the whole of this leaf's coupling, and
 * it is erased at emit.
 *
 * Nothing was renamed and no field changed: these are the same declarations,
 * moved. `../index.ts` re-exports every one of them, so no importer of the
 * store sees a difference.
 */

import type { OutboxCommandKind, OutboxState, OutboxStream } from "../index.js";

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
