/**
 * The value types of a commit authorization record (P-17/A, ADR 0126).
 *
 * The view the decision asks its caller for, the decision's answer, the recorded lease
 * and the in-force predicate's input and answer, and the bytes the door reads before its
 * lock: the declarations this concept owns, in the concept's own leaf. A pure type leaf:
 * it declares data and imports only types, and `../index.ts` re-exports every one.
 */

import type { CommitAuthorizationReadModel, AuditVerdictReadModel, VerificationReadModel } from "../../types/index.js";
import type { VerificationArtifactRead, VerificationReferenceRow } from "../../verification-record/types/index.js";
import type { CommitAuthorizationRefusal } from "../index.js";

/** One recorded lease event of a task, as the fold and the door both read it (ND-6). */
export interface RecordedLeaseEvent {
  readonly type: "LEASE_ACQUIRED" | "LEASE_REVOKED";
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The lease an attempt holds, folded from its recorded events: per `leaseId` the last
 * `LEASE_ACQUIRED` in ledger order, `LEASE_REVOKED` terminal, and the attempt's lease
 * the last one acquired (runtime `enforcement`'s fold rule, ND-6).
 */
export interface RecordedLease {
  readonly leaseId: string;
  readonly holder: string;
  readonly expiresAt: string;
}

/**
 * What the decision asks about the history, and nothing else. The door answers from the
 * tables and the stream its transaction keeps level; the fold answers from the snapshot
 * it is filling. Neither answer reads bytes.
 */
export interface CommitAuthorizationDecisionView {
  /** The commit policy the task's intake recorded, or null when none was recorded. */
  readonly commitPolicy: (taskId: string) => string | null;
  /** The receipt row under one digest, or null. */
  readonly verification: (receiptSha256: string) => VerificationReadModel | null;
  /** The verdict row under one audit id, or null. */
  readonly auditVerdict: (auditId: string) => AuditVerdictReadModel | null;
  /** The task's receipt row with the greatest sequence, or null (ND-5). */
  readonly lastReceipt: (taskId: string) => VerificationReadModel | null;
  /** Every authorization row of one task, in any state. */
  readonly commitAuthorizations: (taskId: string) => readonly CommitAuthorizationReadModel[];
  /** Every `LEASE_ACQUIRED` and `LEASE_REVOKED` of one task, in ledger order. */
  readonly leaseEvents: (taskId: string) => readonly RecordedLeaseEvent[];
}

/**
 * The decision's answer for a record-form `COMMIT_AUTHORIZED`. `recorded` is true when a
 * row under the same key and with the same metadata already stands `INTENDED`: the first
 * row is kept and nothing is written.
 */
export interface CommitAuthorizationDecision {
  readonly row: CommitAuthorizationReadModel;
  readonly recorded: boolean;
}

/**
 * One equality of condition 3 of the in-force predicate: a value the receipt authorized
 * and the value revalidated now, and the word a difference is refused by. A-only members
 * are the door's policy and write-set; base and tree against Git are P-17/B's and C's,
 * which extend the call, not the function (ND-7).
 */
export interface CommitAuthorizationRevalidation {
  readonly reason: CommitAuthorizationRefusal;
  readonly at: string;
  readonly authorized: string;
  readonly observed: string;
}

/** The in-force predicate's input (execution §10.5 "Vigencia"). */
export interface CommitAuthorizationInForceInput {
  /** The row's state, or null when no row stands (condition 1). */
  readonly state: CommitAuthorizationReadModel["state"] | null;
  /** The authorization's recorded instant. */
  readonly authorizedAt: string;
  /** The writer the receipt names, which the lease must be held by. */
  readonly writerIdentity: string;
  /** The attempt's recorded lease, or null when there is none (condition 2). */
  readonly lease: RecordedLease | null;
  /** The equalities of condition 3; an absent member is not judged. */
  readonly revalidated?: readonly CommitAuthorizationRevalidation[];
}

/** The in-force predicate's answer: in force, or the word and the field that failed. */
export type CommitAuthorizationInForce =
  | { readonly inForce: true }
  | { readonly inForce: false; readonly reason: CommitAuthorizationRefusal; readonly at: string };

/** The bytes one reference named, read before the lock, with the reference id read. */
export interface CommitAuthorizationArtifact {
  readonly referenceId: string;
  readonly read: VerificationArtifactRead;
}

/**
 * The receipt and the envelope a record-form `COMMIT_AUTHORIZED` stands on, read by
 * reference before the door's lock, as values. Either is null when no reference could be
 * named before the lock (no receipt row, no revision row): the door refuses that by name
 * inside its transaction.
 */
export interface CommitAuthorizationArtifacts {
  readonly receipt: CommitAuthorizationArtifact | null;
  readonly envelope: CommitAuthorizationArtifact | null;
}

/** What the door's byte judge asks its transaction, beside the reference rows. */
export interface CommitAuthorizationArtifactLookups {
  readonly verification: (receiptSha256: string) => VerificationReadModel | null;
  /** The envelope reference a revision names, or null. */
  readonly envelopeReferenceId: (taskId: string, revisionNumber: number) => string | null;
  readonly reference: (artifactReferenceId: string) => VerificationReferenceRow | null;
}
