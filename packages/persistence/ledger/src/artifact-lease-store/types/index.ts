/**
 * The value types of the artifact blob lease store (P-36/local escalón A, ADR 0083).
 *
 * The three vocabularies' derived unions, the incarnation, the row, the token, the
 * grant, the quiescence, the outcome of the compare-and-set, the test faults, the
 * open options and the store handle, plus the three shapes the store keeps to itself
 * while it migrates and reads raw rows: the declarations this concept owns, in the
 * concept's own leaf rather than interleaved with the store that opens the database
 * (owner law `docs/audit/architecture/index.md` §7; the ADR 0088 errata of
 * 2026-09-14 withdraws that record's "Types live inline in the module" for every new
 * declaration, and decision 90 registers this seam).
 *
 * A pure type leaf, on `../../types/index.ts`' and `../../outbox-store/types/index.ts`'
 * pattern — the store this one is modelled on already keeps its types this way. It
 * declares data and nothing else, and imports only types. The closed sets the unions
 * are derived from stay in `../index.ts` beside the store, and are read here
 * type-only, which is §7.1's one-way derivation and is erased at emit.
 *
 * Nothing was renamed and no field changed: these are the same declarations, moved.
 * `../index.ts` re-exports every exported one, so no importer sees a difference; the
 * three private ones are exported from this leaf only so the store can import them,
 * and are deliberately absent from that re-export, so they stay unexported from the
 * package exactly as before (§7.2).
 */

import type {
  ARTIFACT_BLOB_LEASE_OPERATIONS,
  ARTIFACT_BLOB_LEASE_QUIESCENCE_BASES,
  ARTIFACT_BLOB_LEASE_REFUSALS,
} from "../index.js";

export type ArtifactBlobLeaseOperation = (typeof ARTIFACT_BLOB_LEASE_OPERATIONS)[number];

export type ArtifactBlobLeaseRefusal = (typeof ARTIFACT_BLOB_LEASE_REFUSALS)[number];

export type ArtifactBlobLeaseQuiescenceBasis = (typeof ARTIFACT_BLOB_LEASE_QUIESCENCE_BASES)[number];

/** This file's own incarnation, as `coordination_store_meta` holds it. */
export interface ArtifactBlobLeaseIncarnation {
  readonly storeKind: "ARTIFACT_BLOB_LEASE";
  readonly incarnationId: string;
  readonly createdAt: string;
}

/** One row of artifacts §7, as the caller sees it. */
export interface ArtifactBlobLeaseRow {
  readonly contentSha256: string;
  /** The operation fence, distinct from the blob's own `blob_generation`. */
  readonly generation: number;
  /** The incarnation of this file that wrote the row's current holding, or freed it. */
  readonly storeIncarnationId: string;
  /** Null exactly when no operation is in course; the five below follow it. */
  readonly operation: ArtifactBlobLeaseOperation | null;
  /** Correlates the holding with its intention in the ledger. */
  readonly operationId: string | null;
  readonly holder: string | null;
  /** Recorded for the caller's liveness check; this store never probes it. */
  readonly holderPid: number | null;
  readonly acquiredAt: string | null;
  /** Expiry enables reconciliation. It concedes nothing. */
  readonly expiresAt: string | null;
}

/**
 * The token of coordination §8.1 `:390-391`, as a caller hands it back.
 *
 * The incarnation is first because it is the term that does not repeat: a
 * generation restarts at 1 in a file rebuilt from nothing, and a number that
 * merely coincides with a recreated one proves nothing. The holder and the
 * operation id are the identity every mediated operation includes.
 */
export interface ArtifactBlobLeaseToken {
  readonly incarnationId: string;
  readonly contentSha256: string;
  readonly generation: number;
  readonly holder: string;
  readonly operationId: string;
}

/** A holding, exactly as it is to be written. */
export interface ArtifactBlobLeaseGrant {
  readonly contentSha256: string;
  readonly operation: ArtifactBlobLeaseOperation;
  readonly operationId: string;
  readonly holder: string;
  readonly holderPid: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

/**
 * The caller's statement that the holder being displaced is quiescent.
 *
 * The store cannot verify the basis — it reads no process — and it does not
 * pretend to. It requires the statement to exist, to name one of the two
 * grounds, and to be about the process the row records. The proof itself is
 * the caller's, and so is the obligation to stop when it is uncertain.
 */
export interface ArtifactBlobLeaseQuiescence {
  readonly basis: ArtifactBlobLeaseQuiescenceBasis;
  readonly holderPid: number;
}

/**
 * What a verb did, with the row as it stands afterwards.
 *
 * `UNCHANGED` is a replay of a grant that already stands, answered without a
 * write. `REFUSE` carries the row as it actually is, or `null` when there is
 * none, so the caller decides again from the answer it already holds.
 */
export type ArtifactBlobLeaseOutcome =
  | { readonly verb: "APPLIED"; readonly row: ArtifactBlobLeaseRow }
  | { readonly verb: "UNCHANGED"; readonly row: ArtifactBlobLeaseRow }
  | {
      readonly verb: "REFUSE";
      readonly refusal: ArtifactBlobLeaseRefusal;
      readonly row: ArtifactBlobLeaseRow | null;
    };

/**
 * Test-only fault points (the ledger's `LedgerTestFaults` precedent).
 *
 * Rollback is a claim reading the code cannot verify; the only honest proof is
 * to fail on purpose inside the transaction and show that nothing survived.
 * Production callers never set this.
 */
export interface ArtifactBlobLeaseTestFaults {
  /** Runs inside every mutating transaction, after the write, before commit. */
  readonly beforeLeaseCommit?: (() => void) | undefined;
}

export interface OpenArtifactBlobLeaseStoreOptions {
  /**
   * The incarnation to register **if this file has none yet**.
   *
   * Required and never generated: §8.1 gives it no implicit default, and a UUID
   * minted here would read an environment this module may not read. On a file
   * that already carries a metadata row, that row stands. Rotating an
   * incarnation is coordination §8.2's blocked restore, not an argument.
   */
  readonly incarnationId: string;
  /** The instant that incarnation began, on the same terms. */
  readonly createdAt: string;
  /** How long a contending process waits for the write lock. Generous by default. */
  readonly busyTimeoutMs?: number;
  /** Test-only. See {@link ArtifactBlobLeaseTestFaults}. */
  readonly __testFaults?: ArtifactBlobLeaseTestFaults;
}

export interface ArtifactBlobLeaseStore {
  /**
   * This file's incarnation, read now rather than remembered.
   *
   * Throws `LedgerIntegrityError` when the metadata row is gone or declares
   * another kind: a file that cannot name its incarnation admits nothing.
   */
  readonly incarnation: () => ArtifactBlobLeaseIncarnation;
  readonly read: (contentSha256: string) => ArtifactBlobLeaseRow | null;
  /** The token of the holding that stands on this digest, or null when none does. */
  readonly readToken: (contentSha256: string) => ArtifactBlobLeaseToken | null;
  /**
   * Take the exclusive generation over a blob nobody holds.
   *
   * A first grant inserts at generation 1; a grant over a freed row advances it
   * by one. A held row answers `HELD` whatever its expiry says. Replaying the
   * grant that already stands answers `UNCHANGED`.
   */
  readonly acquire: (grant: ArtifactBlobLeaseGrant) => ArtifactBlobLeaseOutcome;
  /**
   * The holder ends its own holding. The whole token and the identity are
   * compared; the generation is conserved.
   */
  readonly release: (token: ArtifactBlobLeaseToken) => ArtifactBlobLeaseOutcome;
  /**
   * End a holding whose holder is quiescent, without granting it to anyone.
   * The generation advances by one, so the displaced holder's token is dead.
   */
  readonly revoke: (token: ArtifactBlobLeaseToken, quiescence: ArtifactBlobLeaseQuiescence) => ArtifactBlobLeaseOutcome;
  /**
   * Take a blob from a holder that is quiescent: a new grant at generation
   * `OLD + 1`, compared against the incarnation and generation observed.
   */
  readonly takeOver: (
    token: ArtifactBlobLeaseToken,
    quiescence: ArtifactBlobLeaseQuiescence,
    grant: ArtifactBlobLeaseGrant,
  ) => ArtifactBlobLeaseOutcome;
  /**
   * The holdings whose expiry is at or before the instant supplied.
   *
   * Read-only, and that is the whole point: expiry enables a caller to
   * reconcile and authorises this store to do nothing.
   */
  readonly listOverdue: (now: string) => readonly ArtifactBlobLeaseRow[];
  readonly close: () => void;
}

export interface LeaseMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

export interface RawRow {
  readonly content_sha256: string;
  readonly generation: number;
  readonly store_incarnation_id: string;
  readonly operation: string | null;
  readonly operation_id: string | null;
  readonly holder: string | null;
  readonly holder_pid: number | null;
  readonly acquired_at: string | null;
  readonly expires_at: string | null;
}

export interface RawMeta {
  readonly store_kind: string;
  readonly store_incarnation_id: string;
  readonly created_at: string;
}
