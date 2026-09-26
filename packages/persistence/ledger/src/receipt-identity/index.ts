import { createHash } from "node:crypto";

import { VerificationReceipt, WRITER_WORKER_ID_UUID_NAMESPACE } from "@acp/contracts";

import { canonicalJsonStringify, sha256Hex } from "../canonical-json/index.js";
import { LedgerValidationError } from "../errors/index.js";
import type { ReceiptCheckEntry, ReceiptIdentityPreimageV1, ReceiptVerificationColumns } from "./types/index.js";

export type { ReceiptCheckEntry, ReceiptIdentityPreimageV1, ReceiptVerificationColumns } from "./types/index.js";

/**
 * A receipt's identity, version 1, and the writer's instance id (P-16/A2, ADR 0121).
 *
 * ## What this identifies
 *
 * `receipt_sha256` is the effective key of execution §10.2's
 * `verification_read_model`: the identity of one verification of one tree, by one
 * verifier run, for one writer. Execution §10.2: "Sólo ledger `receipt-identity`
 * lo calcula". This module is that one site (L-P16A2-1), and the door P-16/B
 * builds recomputes through it.
 *
 * ## The preimage
 *
 *     preimage = RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1 + canonicalJsonStringify({ the thirteen })
 *
 * with no separator between them: the LF is the prefix's last byte, and there is
 * exactly one (the `ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1` shape). The thirteen
 * members are the canon's closed list, not the whole parsed receipt (ND-7): the
 * observed lists and `contractVersion` are outside it, a stated limit, and the
 * same digest over different observations is P-16/B's fold-level refusal.
 *
 * Two of the thirteen are digests this module derives:
 *
 * - `checksSha256` over the checks **in execution order** — the order is
 *   evidence, so reordering them is a different run;
 * - `writeSetSha256` over the declared write-set **sorted** with the default
 *   comparator, UTF-16 code-unit order (the `roadmap-steps` precedent) — a set
 *   has no order, so reordering it is the same set.
 *
 * Each under its own prefix. The three prefixes are the ledger's, as the account
 * integrity and usage settlement prefixes are: they encode a digest this package
 * computes, and no contract declares them.
 *
 * The commit message's trailer is not in the preimage — it carries this digest —
 * and a body that already holds one is refused by the receipt's own schema before
 * anything is hashed. The trailer's bytes are `@acp/contracts`'
 * `commitMessageWithReceiptTrailer`.
 *
 * ## Frozen
 *
 * `v1` is never changed in place. A change to the encoding is a new prefix with a
 * new name and its own function.
 */

/** The version prefix of the receipt identity preimage. One LF, its last byte. */
export const RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1 = "acp/receipt-identity/v1\n";

/** The version prefix of the checks digest inside the preimage. */
export const RECEIPT_CHECKS_PREIMAGE_PREFIX_V1 = "acp/receipt-checks/v1\n";

/** The version prefix of the write-set digest inside the preimage. */
export const RECEIPT_WRITE_SET_PREIMAGE_PREFIX_V1 = "acp/receipt-write-set/v1\n";

/**
 * The canonical preimage of a receipt's identity, as a UTF-8 string.
 *
 * **Takes `unknown` and parses, deliberately** (ADR 0066): what is hashed is
 * always the value `VerificationReceipt` accepted. A `CommitAuthorizationReceipt`
 * is a `VerificationReceipt`, so both digest here and digest equally.
 *
 * Throws `ZodError` for anything the contract refuses, and
 * `LedgerCanonicalizationError` for a value that parses and still has no
 * canonical JSON form. No error class is added. The contract refuses a `-0` exit
 * code, the one preimage number its bounds would otherwise admit and canonical
 * JSON refuses, so no admitted receipt reaches that second throw.
 */
export function receiptIdentityPreimageV1(value: unknown): string {
  return RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1 + canonicalJsonStringify(preimageOf(VerificationReceipt.parse(value)));
}

/**
 * The thirteen members of one parsed receipt, the two derived digests computed here.
 *
 * Module-private: the one builder both exported readings share, so the preimage has
 * one spelling and the column reading below parses the receipt once.
 */
function preimageOf(receipt: VerificationReceipt): ReceiptIdentityPreimageV1 {
  const checks: ReceiptCheckEntry[] = receipt.checks.map((check) => ({
    command: check.command,
    exitCode: check.exitCode,
    ranAt: check.ranAt,
  }));
  const preimage: ReceiptIdentityPreimageV1 = {
    taskId: receipt.taskId,
    revisionNumber: receipt.revisionNumber,
    attemptNumber: receipt.attemptNumber,
    baseSha: receipt.baseSha,
    treeSha: receipt.treeSha,
    objectFormat: receipt.objectFormat,
    policySha256: receipt.policySha256,
    writeSetSha256: sha256Hex(
      RECEIPT_WRITE_SET_PREIMAGE_PREFIX_V1 + canonicalJsonStringify([...receipt.declaredWriteSet].sort()),
    ),
    writer: { identity: receipt.writer.identity, workerId: receipt.writer.workerId },
    verifier: {
      identity: receipt.verifier.identity,
      workerId: receipt.verifier.workerId,
      runId: receipt.verifier.runId,
    },
    runStatus: receipt.runStatus,
    checksSha256: sha256Hex(RECEIPT_CHECKS_PREIMAGE_PREFIX_V1 + canonicalJsonStringify(checks)),
    commitMessageBody: receipt.commitMessageBody,
  };
  return preimage;
}

/**
 * `receipt_sha256`: the digest of the preimage above. One producer, one algorithm.
 *
 * A separate function from the preimage, so a vector test can say which of the two
 * steps moved when one did.
 */
export function receiptSha256(value: unknown): string {
  return sha256Hex(receiptIdentityPreimageV1(value));
}

/**
 * The columns execution §10.2 derives from one receipt, from one parse (P-16/B, ADR
 * 0122).
 *
 * `receiptSha256` is the digest `receiptSha256` returns for the same value, byte for
 * byte, and `writeSetSha256` and `checksSha256` are the two digests inside its
 * preimage: this is the reading the verification door compares a carried record
 * against, so the three prefixes stay in this module (L-P16A2-1). `allChecksZero` is
 * whether every recorded check exited zero; the contract already refuses a `PASS`
 * with a nonzero check, so it is the fact a `FAIL` row may carry either way.
 *
 * Takes `unknown` and parses, as the two readings above do, and throws what they
 * throw.
 */
export function receiptVerificationColumns(value: unknown): ReceiptVerificationColumns {
  const receipt = VerificationReceipt.parse(value);
  const preimage = preimageOf(receipt);
  return {
    receiptSha256: sha256Hex(RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1 + canonicalJsonStringify(preimage)),
    taskId: preimage.taskId,
    revisionNumber: preimage.revisionNumber,
    attemptNumber: preimage.attemptNumber,
    baseSha: preimage.baseSha,
    treeSha: preimage.treeSha,
    policySha256: preimage.policySha256,
    writeSetSha256: preimage.writeSetSha256,
    checksSha256: preimage.checksSha256,
    runStatus: preimage.runStatus,
    allChecksZero: receipt.checks.every((check) => check.exitCode === 0),
    writer: preimage.writer,
    verifier: preimage.verifier,
  };
}

/** The sixteen bytes of a canonical lowercase UUID. */
function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

/**
 * The writer's instance id for `(taskId, attempt)`: the RFC 4122 version 5 UUID over
 * `taskId + "/" + String(attempt)` under `WRITER_WORKER_ID_UUID_NAMESPACE`.
 *
 * `attempt` is the **flat per-task attempt** (execution `legacy_attempt_number`,
 * monotonic per task), never the per-revision `attemptNumber`, which restarts at 1
 * in each revision and would collide (ND-3). It is the value the Claude CLI's
 * session is named by, byte for byte: providers' `claudeSessionId` computes the
 * same function over the same namespace, and both suites pin the same vectors.
 *
 * Refused, never coerced: a `taskId` that is not a non-empty string, or an
 * `attempt` that is not a positive safe integer, throws `LedgerValidationError`
 * naming the argument.
 */
export function writerWorkerIdFor(taskId: string, attempt: number): string {
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new LedgerValidationError([{ path: "taskId", message: "a task id is a non-empty string" }]);
  }
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new LedgerValidationError([
      { path: "attempt", message: "a flat attempt is a safe integer of one or greater" },
    ]);
  }
  const digest = createHash("sha1")
    .update(uuidBytes(WRITER_WORKER_ID_UUID_NAMESPACE))
    .update(taskId + "/" + String(attempt), "utf8")
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}
