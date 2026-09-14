/**
 * The value types of the local artifact plane (P-36/local escalón A, ADR 0083).
 *
 * The refusal vocabulary's derived union, the reference intent, the event identity,
 * the holding, the three requests, the two outcomes, the test faults, the open
 * options and the plane handle itself, plus the six shapes the plane keeps to
 * itself while it stages, hashes and places bytes: the declarations this concept
 * owns, in the concept's own leaf rather than interleaved with the implementation
 * (owner law `docs/audit/architecture/index.md` §7; the ADR 0088 errata of
 * 2026-09-14 withdraws that record's "Types live inline in the module" for every
 * new declaration, and decision 90 registers this seam).
 *
 * A pure type leaf, on `../../types/index.ts`' and `../../outbox-store/types/index.ts`'
 * pattern: it declares data and nothing else, and imports only types. The closed set
 * the union is derived from stays in `../index.ts` beside the plane, and is read here
 * type-only, which is §7.1's one-way derivation and is erased at emit.
 *
 * Nothing was renamed and no field changed: these are the same declarations, moved.
 * `../index.ts` re-exports every exported one, so no importer sees a difference; the
 * six private ones are exported from this leaf only so the plane can import them, and
 * are deliberately absent from that re-export, so they stay unexported from the
 * package exactly as before (§7.2).
 */

import type { ArtifactRegistryEvent, ReferenceScopeKind } from "@acp/contracts";
import type {
  ArtifactBlobLeaseOutcome,
  ArtifactBlobLeaseQuiescence,
  ArtifactBlobLeaseRefusal,
  ArtifactBlobLeaseRow,
  ArtifactBlobLeaseStore,
  ArtifactBlobLeaseToken,
} from "../../artifact-lease-store/index.js";
import type { Ledger } from "../../ledger/index.js";
import type { ArtifactEventRecord, ArtifactReferenceReadModel } from "../../types/index.js";
import type { ARTIFACT_PLANE_REFUSALS } from "../index.js";

export type ArtifactPlaneRefusal = (typeof ARTIFACT_PLANE_REFUSALS)[number];

/** The reference a publication records, exactly as the contract shapes it. */
export type ArtifactReferenceIntent = Extract<
  ArtifactRegistryEvent,
  { readonly artifactEventKind: "PUBLICATION_SUCCEEDED" }
>["payload"]["reference"];

/** The identity and instants of one event, all of them the caller's. */
export interface ArtifactEventIdentity {
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/** The holding a call asks for; the operation id is always the command's. */
export interface ArtifactPlaneHolding {
  readonly holder: string;
  readonly holderPid: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface ArtifactPublicationRequest {
  /** The bytes. Their digest and size are computed here, never taken on trust. */
  readonly content: Uint8Array;
  /** A digest the caller expects; refused before the lease if the bytes disagree. */
  readonly declaredContentSha256?: string;
  /** A size the caller expects; refused before the lease if the bytes disagree. */
  readonly declaredSizeBytes?: number;
  readonly mediaType: string;
  /** `PLAINTEXT` only in this escalón; `ENCRYPTED_AT_REST` is refused by name. */
  readonly encryptionStatus: "PLAINTEXT" | "ENCRYPTED_AT_REST";
  readonly encryptionProfile: string;
  readonly commandId: string;
  readonly artifactPinId: string;
  /** Recorded in the intention, and recorded again, unchanged, by the success. */
  readonly reference: ArtifactReferenceIntent;
  readonly recordedBy: string;
  readonly intention: ArtifactEventIdentity;
  /** The identity of the success, or of the abandonment if the bytes cannot be placed or the success is refused. */
  readonly terminal: ArtifactEventIdentity;
  readonly holding: ArtifactPlaneHolding;
  /**
   * Required only to resume a command whose holding a dead process left: the
   * caller's attestation that the recorded holder is quiescent.
   */
  readonly quiescence?: ArtifactBlobLeaseQuiescence;
}

export interface ArtifactReconciliationRequest {
  /** Checked for form before any path is derived from it. */
  readonly contentSha256: string;
  /** The reconciler's own holding, under the displaced command's operation id. */
  readonly holding: ArtifactPlaneHolding;
  /** Required whenever a holding stands; without it nothing moves. */
  readonly quiescence?: ArtifactBlobLeaseQuiescence;
  /** The identity of the success or abandonment the reconciler records. */
  readonly terminal: ArtifactEventIdentity;
  readonly recordedBy: string;
}

/**
 * Who is reading. `SCOPE_EQUALITY_V1`, the one policy: the reader's scope is the
 * reference's, kind and id. A `SYSTEM` reader carries no id and reads only what
 * a `SYSTEM` scope owns.
 */
export interface ArtifactReadRequest {
  readonly artifactReferenceId: string;
  readonly scopeKind: ReferenceScopeKind;
  readonly scopeId: string | null;
}

/** What `publish` and `reconcile` did. */
export type ArtifactPlaneOutcome =
  | {
      readonly verb: "PUBLISHED";
      readonly contentSha256: string;
      readonly blobGeneration: number;
      readonly reference: ArtifactReferenceReadModel;
      /** false when the digest's path already held these exact bytes. */
      readonly bytesWritten: boolean;
      /** true when the success was already recorded and nothing was appended. */
      readonly replayed: boolean;
      /** The lease's own answer. A refusal here leaves the publication standing. */
      readonly release: ArtifactBlobLeaseOutcome;
    }
  | {
      readonly verb: "ABANDONED";
      readonly refusal: ArtifactPlaneRefusal;
      readonly contentSha256: string;
      readonly blobGeneration: number;
      readonly release: ArtifactBlobLeaseOutcome;
    }
  | {
      readonly verb: "HOLDING_REVOKED";
      readonly lease: ArtifactBlobLeaseRow | null;
    }
  | {
      readonly verb: "NOTHING_TO_RECONCILE";
      readonly lease: ArtifactBlobLeaseRow | null;
    }
  | {
      readonly verb: "REFUSE";
      readonly refusal: ArtifactPlaneRefusal;
      /** The lease store's own word, when it was the store that declined. */
      readonly leaseRefusal: ArtifactBlobLeaseRefusal | null;
      readonly lease: ArtifactBlobLeaseRow | null;
    };

export type ArtifactReadOutcome =
  | {
      readonly verb: "READ";
      readonly content: Buffer;
      readonly reference: ArtifactReferenceReadModel;
    }
  | { readonly verb: "REFUSE"; readonly refusal: ArtifactPlaneRefusal };

/**
 * Test-only fault points, one between each two steps of §8 (ADR 0083).
 *
 * The honest drill for a crash between two steps is to stop there: a hook that
 * throws ends the call exactly where it stands, with no cleanup, and the suite
 * then reconciles from a new plane over the same files. A hook that does not
 * throw lets the suite act on the world mid-operation — take the lease over,
 * corrupt a staged file — and watch this module refuse. Production callers never
 * set this.
 */
export interface ArtifactPlaneTestFaults {
  /** Step 1 done: the holding stands, no intention yet. */
  readonly afterLeaseAcquired?: (() => void) | undefined;
  /** Step 2 done: intention and pin recorded, no byte written. */
  readonly afterIntentionRecorded?: (() => void) | undefined;
  /** Bytes written to staging, not yet verified. */
  readonly afterStagingWritten?: (() => void) | undefined;
  /** Staging verified, not yet synchronized. */
  readonly afterStagingVerified?: (() => void) | undefined;
  /** Staging synchronized and closed; the destination is still absent. */
  readonly afterStagingSynced?: (() => void) | undefined;
  /** Renamed onto the digest's path; the directory not yet synchronized. */
  readonly afterRename?: (() => void) | undefined;
  /** Step 3 done: the bytes are durable and nothing names them. */
  readonly afterDirectorySynced?: (() => void) | undefined;
  /** Step 4 done: the outcome is recorded and the lease still held. */
  readonly afterOutcomeRecorded?: (() => void) | undefined;
}

export interface OpenArtifactPlaneOptions {
  /** A writable ledger; the plane appends through its artifact door. */
  readonly ledger: Ledger;
  /** The blob lease store of the same ledger. */
  readonly leaseStore: ArtifactBlobLeaseStore;
  /** The ledger's own path, from which the subroot is derived. */
  readonly ledgerPath: string;
  /** Test-only. See {@link ArtifactPlaneTestFaults}. */
  readonly __testFaults?: ArtifactPlaneTestFaults;
}

export interface ArtifactPlane {
  /** Publish some bytes under a reference, in §8's order. */
  readonly publish: (request: ArtifactPublicationRequest) => ArtifactPlaneOutcome;
  /** Read the bytes a reference authorizes this scope to read, verified on the way out. */
  readonly read: (request: ArtifactReadRequest) => ArtifactReadOutcome;
  /** Drive the publication one digest's crash left behind to an end, or end its holding. */
  readonly reconcile: (request: ArtifactReconciliationRequest) => ArtifactPlaneOutcome;
}

export type IntendedEvent = Extract<ArtifactRegistryEvent, { readonly artifactEventKind: "PUBLICATION_INTENDED" }>;

export interface CheckedPublication {
  readonly request: ArtifactPublicationRequest;
  readonly content: Uint8Array;
  readonly contentSha256: string;
  readonly sizeBytes: number;
  readonly holding: ArtifactPlaneHolding;
  readonly quiescence: ArtifactBlobLeaseQuiescence | null;
}

export type Entry = "ABSENT" | "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER";

export type Inspection =
  | { readonly state: "VERIFIED"; readonly bytes: Buffer }
  | { readonly state: "ABSENT" | "SYMLINK" | "DOES_NOT_VERIFY" };

export type Placement = "WRITTEN" | "PRESENT" | "ABSENT" | "DOES_NOT_VERIFY" | "SYMLINK" | "SUPERSEDED";

export interface Work {
  readonly token: ArtifactBlobLeaseToken;
  readonly intention: ArtifactEventRecord & { readonly event: IntendedEvent };
  /** The bytes, for a publisher; null for a reconciler, which has none to write. */
  readonly content: Uint8Array | null;
  readonly terminal: ArtifactEventIdentity;
  readonly recordedBy: string;
}
