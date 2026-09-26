/**
 * The value types of a verification record (P-16/B, ADR 0122).
 *
 * The view the decision asks its caller for, the decision's answer, the value the
 * door reads before its lock, and the reference row it asserts inside it: the
 * declarations this concept owns, in the concept's own leaf. A pure type leaf: it
 * declares data and imports only types, and `../index.ts` re-exports every one.
 */

import type { ReferenceReadRefusal } from "../../artifact-plane/index.js";
import type { AuditVerdictReadModel, VerificationReadModel } from "../../types/index.js";

/**
 * What the decision asks about the history, and nothing else. The door answers from
 * the tables its transaction keeps level; the fold answers from the snapshot it is
 * filling. Neither answer reads bytes.
 */
export interface VerificationDecisionView {
  /** The flat attempt the coordinate was assigned when it opened, or null when no attempt row stands. */
  readonly legacyAttempt: (taskId: string, revisionNumber: number, attemptNumber: number) => number | null;
  /** The receipt row under one digest, or null. */
  readonly verification: (receiptSha256: string) => VerificationReadModel | null;
  /** The verdict row under one audit id, or null. */
  readonly auditVerdict: (auditId: string) => AuditVerdictReadModel | null;
}

/**
 * The decision's answer for an event in one of the two forms. `recorded` is true when
 * a row under the same key and with the same metadata already stands: the first row,
 * its `sequence` and its `recordedAt` are kept, and nothing is written.
 */
export type VerificationDecision =
  | { readonly kind: "VERIFICATION"; readonly row: VerificationReadModel; readonly recorded: boolean }
  | { readonly kind: "AUDIT_VERDICT"; readonly row: AuditVerdictReadModel; readonly recorded: boolean };

/**
 * The bytes a receipt-form or verdict-form event names, read by reference before the
 * door's lock, as a value: the bytes and the digest the reference pins, or the
 * reader's refusal. The door raises a refusal by name only inside its transaction,
 * after the replay check (B-5).
 */
export type VerificationArtifactRead =
  | { readonly ok: true; readonly content: Buffer; readonly contentSha256: string }
  | { readonly ok: false; readonly refusal: ReferenceReadRefusal };

/** The registry's row for one reference, as the door asserts it inside its transaction. */
export interface VerificationReferenceRow {
  readonly artifactClass: string;
  readonly contentSha256: string;
  readonly scopeKind: string;
  readonly scopeId: string | null;
}
