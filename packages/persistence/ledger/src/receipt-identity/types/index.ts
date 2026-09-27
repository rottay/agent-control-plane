/**
 * The value types of a receipt's identity (P-16/A2, ADR 0121).
 *
 * The preimage object `receiptSha256` hashes, and the two entries whose lists it
 * hashes by their own digest: the declarations this concept owns, in the
 * concept's own leaf. A pure type leaf: it declares data and imports nothing, and
 * `../index.ts` re-exports every one.
 */

/** One recorded check, as it enters `checksSha256`: in execution order. */
export interface ReceiptCheckEntry {
  readonly command: string;
  readonly exitCode: number;
  readonly ranAt: string;
}

/**
 * The thirteen members execution §10.2 names, and nothing else (ND-7).
 *
 * `checksSha256` and `writeSetSha256` are derived from the receipt's own lists
 * inside the preimage, never carried by the receipt, so a carried digest that
 * disagrees with its list cannot exist.
 */
export interface ReceiptIdentityPreimageV1 {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly baseSha: string;
  readonly treeSha: string;
  readonly objectFormat: "sha1";
  readonly policySha256: string;
  readonly writeSetSha256: string;
  readonly writer: { readonly identity: string; readonly workerId: string };
  readonly verifier: { readonly identity: string; readonly workerId: string; readonly runId: number };
  readonly runStatus: "PASS" | "FAIL";
  readonly checksSha256: string;
  readonly commitMessageBody: string;
}

/**
 * The columns execution §10.2 takes from one receipt (P-16/B, ADR 0122): its name,
 * its coordinate, the members the table copies and the two digests derived inside
 * the preimage, plus `allChecksZero`, which no preimage member carries.
 */
export interface ReceiptVerificationColumns {
  readonly receiptSha256: string;
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly baseSha: string;
  readonly treeSha: string;
  readonly policySha256: string;
  readonly writeSetSha256: string;
  readonly checksSha256: string;
  readonly runStatus: "PASS" | "FAIL";
  readonly allChecksZero: boolean;
  readonly writer: { readonly identity: string; readonly workerId: string };
  readonly verifier: { readonly identity: string; readonly workerId: string; readonly runId: number };
}

/** The two supervised roles (P-16/C, ADR 0123): the `WORKER_ROLES` literals a verifier and an auditor run as. */
export type SupervisedRole = "verifier" | "reviewer";

/**
 * The object `policy_sha256` digests (P-16/C, ADR 0123; ND-12): three members of the
 * recorded envelope, and nothing of the runner's bounds.
 */
export interface VerificationPolicy {
  readonly commands: readonly string[];
  readonly independentVerifierRequired: boolean;
  readonly commitPolicy: "NO_COMMIT" | "LOCAL_COMMIT_WITH_RECEIPT";
}
