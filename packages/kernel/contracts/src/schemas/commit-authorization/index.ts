/**
 * The verification receipt and the commit authorization receipt, version 2 —
 * `@acp/contracts` (P8-T G6; P-16/A2, ADR 0121).
 *
 * Independent verification, write-set conformance, push permanently false.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. P-16/A2 rewrote the shape to the one execution §10.2 and
 * contracts §12 specify (decisions 225-227): the receipt is named by its
 * content, `receipt_sha256`, which `@acp/ledger`'s `receipt-identity` computes
 * and nothing else does.
 *
 * ## Two schemas, one set of bytes (ND-6)
 *
 * `VerificationReceipt` is what a verification run produces, `PASS` or `FAIL`
 * — the bytes of an execution §10.2 row. `CommitAuthorizationReceipt` is the
 * same object restricted to `PASS`, by one more refine and nothing else, so a
 * value it admits always parses as a `VerificationReceipt` and digests the
 * same. AGENTS law 3 is read literally: a `CommitAuthorizationReceipt` whose
 * run did not pass, or any of whose checks exited nonzero, is not a value.
 *
 * The write-set conformance refine stays on `VerificationReceipt` too: a run
 * that observed a change outside its declared set is a quarantine (P6A/P6C),
 * never a receipt, `FAIL` included. That is the limit P-16/C's runner inherits.
 *
 * ## What left, and why
 *
 * - `receiptId`: the identity is the digest.
 * - `authorizedBy`, `authorizedAt`, `worktreePath`, `branch`: facts of the
 *   authorization and of the lease, not of the verification; two receipts with
 *   one digest could otherwise differ, which P-16/B's fold calls corruption.
 * - `baseHead`: replaced by `baseSha`, which is never null. There is no
 *   initial-commit receipt (D-9): it was the one path on which "first parent =
 *   base" could not be checked.
 * - `attempt`: replaced by the V2 coordinate `(revisionNumber, attemptNumber)`.
 * - `commitMessage`: replaced by `commitMessageBody`. The trailer that names the
 *   receipt is added by `commitMessageWithReceiptTrailer`, and never enters the
 *   receipt, because it carries the receipt's own digest (C-M1).
 *
 * ## Why the writer id's rule is here and its computation is not
 *
 * The writer's instance id is an RFC 4122 version 5 UUID over
 * `taskId + "/" + attempt` under `WRITER_WORKER_ID_UUID_NAMESPACE`, the same
 * value the Claude CLI already runs under. Version 5 is SHA-1, and this package
 * may import no `node:` builtin, so the namespace and the refusal word are
 * declared here and the one computation is `@acp/ledger`'s `writerWorkerIdFor`
 * (the house split: the rule in contracts, the function in the ledger).
 */

import { z } from "zod";
import { attachGuards } from "../credential-guards/index.js";
import {
  AdmittedContractVersion,
  CanonicalInstant,
  GitCommitSha,
  RepoRelativePath,
  Sha256Hex,
  Uuid,
} from "../primitives/index.js";
import { PathDigest } from "../shared-references/index.js";
import { WorkerIdentityString } from "../worker-identity/index.js";

/**
 * The namespace every writer instance id is derived under (P-16/A2, ADR 0121).
 *
 * The bytes of the Claude CLI's session namespace since P-15/A (ADR 0101), moved
 * here so the rule has one home: providers re-exports it under its old name,
 * `CLAUDE_SESSION_UUID_NAMESPACE`, and the ledger's `writerWorkerIdFor` reads it.
 * The literal appears in this one source file (L-P16A2-2).
 */
export const WRITER_WORKER_ID_UUID_NAMESPACE = "7108affe-18e1-427e-8a44-493bb4a3af92";

/**
 * The refusal of a writer transport that has no id issuer (execution §10.2,
 * contracts §12 "Quién llena el campo"; decision 227).
 *
 * Today only the Claude CLI session names its writer; every other transport is
 * refused by this word until P-28 widens the set.
 */
export const WRITER_ID_UNISSUED = "WRITER_ID_UNISSUED";

/**
 * The key of the one trailer a commit message carries after its body.
 *
 * Module-private: the body rule below and the builder at the bottom read this one
 * constant, so the literal is spelled once in `src` (L-P16A2-1).
 */
const RECEIPT_TRAILER_KEY = "ACP-Receipt:";

/**
 * A worker instance id: a version 5 UUID, in canonical lowercase.
 *
 * `z.uuid({ version: "v5" })` alone admits uppercase hex, and an uppercase copy of
 * the writer's id would then pass both the shape and the `!==` independence check
 * while naming the same instance, and give one receipt two digests (B-3). The
 * writer and the verifier share this one schema.
 */
const WorkerInstanceId = z
  .uuid({ version: "v5" })
  .refine((value) => value === value.toLowerCase(), {
    message: "a worker instance id is a version 5 UUID in canonical lowercase",
  });

/**
 * The body of a commit message, before its trailer (execution §10.5).
 *
 * Four rules, so the separator's bytes are never ambiguous: the body is not
 * empty, does not end in `\n`, holds no `\r`, and carries no line that already
 * begins with the trailer's key. The named words for these refusals are P-17/A's;
 * here they are issues on this field, and a receipt the authorization would
 * refuse is never constructible. The rules sit on the field, not on the object,
 * so the builder below and the receipt parse one schema.
 */
const CommitMessageBody = z
  .string()
  .min(1)
  .max(2_000)
  .superRefine((body, ctx) => {
    if (body.endsWith("\n")) {
      ctx.addIssue({ code: "custom", message: "a commit message body does not end in a line feed" });
    }
    if (body.includes("\r")) {
      ctx.addIssue({ code: "custom", message: "a commit message body holds no carriage return" });
    }
    if (body.split("\n").some((line) => line.startsWith(RECEIPT_TRAILER_KEY))) {
      ctx.addIssue({
        code: "custom",
        message: "a commit message body carries no receipt trailer; the authorization adds exactly one",
      });
    }
  });

const CoordinateNumber = z.number().int().min(1).max(10_000);

/**
 * A check's exit code: an integer in `[0, 255]`, and never `-0`.
 *
 * `-0` passes `int().min(0)` and `!== 0`, but it has no canonical JSON form, so a
 * receipt carrying it would parse and still have no `receipt_sha256` (the ledger's
 * canonicalization refuses it). Every other number of the identity preimage is
 * `min(1)`, which already refuses `-0`. No process exits `-0`; the refusal keeps
 * every admitted receipt digestible.
 */
const CheckExitCode = z
  .number()
  .int()
  .min(0)
  .max(255)
  .refine((value) => !Object.is(value, -0), {
    message: "an exit code is never negative zero; it has no canonical JSON form",
  });

export const VerificationReceipt = z
  .strictObject({
    /**
     * The version in force, and only it (P-18/protocolo C, ADR 0076).
     *
     * The third of ADR 0072's three admission shapes, on the reasoning
     * `TaskEnvelope.contractVersion` states in full: a receipt is an instrument
     * of new work, so it is held to `AdmittedContractVersion`. It is outside the
     * identity preimage (a stated limit, ADR 0121).
     */
    contractVersion: AdmittedContractVersion,
    taskId: Uuid,
    revisionNumber: CoordinateNumber,
    attemptNumber: CoordinateNumber,

    /** The commit the verified change is based on. Never null (D-9). */
    baseSha: GitCommitSha,
    /** The tree that was verified. */
    treeSha: GitCommitSha,
    /** The one object format admitted; another is P-38's. */
    objectFormat: z.literal("sha1"),
    /** The digest of the verification policy applied; its producer is P-16/C. */
    policySha256: Sha256Hex,

    declaredWriteSet: z.array(RepoRelativePath).min(1).max(500),
    observedTrackedChanges: z.array(PathDigest).max(500),
    observedUntrackedPaths: z.array(RepoRelativePath).max(500),

    /** The writer that produced the diff: its label and the id the plane derived. */
    writer: z.strictObject({
      identity: WorkerIdentityString,
      workerId: WorkerInstanceId,
    }),
    /** The independent verifier that ran the checks, and which of its runs. */
    verifier: z.strictObject({
      identity: WorkerIdentityString,
      workerId: WorkerInstanceId,
      runId: z.number().int().min(1),
    }),

    runStatus: z.enum(["PASS", "FAIL"]),
    checks: z
      .array(
        z.strictObject({
          command: z.string().min(1).max(400),
          exitCode: CheckExitCode,
          ranAt: CanonicalInstant,
        }),
      )
      .min(1)
      .max(50),

    commitMessageBody: CommitMessageBody,
    /** Structural law. A receipt can never authorize a push. */
    pushAuthorized: z.literal(false),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });

    // Independence by label and by instance. The label alone is the hole the
    // canon names: renaming the role would pass it.
    if (value.verifier.identity === value.writer.identity) {
      ctx.addIssue({
        code: "custom",
        message: "the verifier must be a different worker than the writer",
        path: ["verifier", "identity"],
      });
    }
    if (value.verifier.workerId === value.writer.workerId) {
      ctx.addIssue({
        code: "custom",
        message: "the verifier must be a different worker instance than the writer",
        path: ["verifier", "workerId"],
      });
    }

    const declared = new Set<string>();
    for (const [index, path] of value.declaredWriteSet.entries()) {
      if (declared.has(path)) {
        ctx.addIssue({
          code: "custom",
          message: "declared path " + path + " is listed twice",
          path: ["declaredWriteSet", index],
        });
      }
      declared.add(path);
    }

    for (const [index, change] of value.observedTrackedChanges.entries()) {
      if (!declared.has(change.path)) {
        ctx.addIssue({
          code: "custom",
          message: "tracked change " + change.path + " is outside the declared write-set",
          path: ["observedTrackedChanges", index, "path"],
        });
      }
    }

    for (const [index, path] of value.observedUntrackedPaths.entries()) {
      if (!declared.has(path)) {
        ctx.addIssue({
          code: "custom",
          message: "untracked path " + path + " is outside the declared write-set",
          path: ["observedUntrackedPaths", index],
        });
      }
    }

    // `PASS` with a nonzero check is the one forbidden cell. `FAIL` with every
    // check zero is lawful: the run failed although every check that ran exited
    // zero (timeout, observation failure, tool error).
    if (value.runStatus === "PASS" && value.checks.some((check) => check.exitCode !== 0)) {
      ctx.addIssue({
        code: "custom",
        message: "a passing run has every recorded check exited zero",
        path: ["checks"],
      });
    }
  });
export type VerificationReceipt = z.infer<typeof VerificationReceipt>;

/**
 * The receipt a local commit is authorized under: a `VerificationReceipt` whose
 * run passed, and nothing else (AGENTS law 3; ND-6).
 */
export const CommitAuthorizationReceipt = VerificationReceipt.superRefine((value, ctx) => {
  if (value.runStatus !== "PASS") {
    ctx.addIssue({
      code: "custom",
      message: "only a passing verification authorizes a commit",
      path: ["runStatus"],
    });
  }
});
export type CommitAuthorizationReceipt = z.infer<typeof CommitAuthorizationReceipt>;

/**
 * The exact bytes of an authorized commit message (execution §10.5):
 *
 *     body + "\n\nACP-Receipt: " + receiptSha256 + "\n"
 *
 * The one site of the trailer's bytes (L-P16A2-1). The body is parsed by the
 * receipt's own field schema and the digest by `Sha256Hex`; either refusal throws
 * that parse's `ZodError`, and nothing is normalized.
 */
export function commitMessageWithReceiptTrailer(body: string, receiptSha256: string): string {
  const parsedBody = CommitMessageBody.parse(body);
  const digest = Sha256Hex.parse(receiptSha256);
  return parsedBody + "\n\n" + RECEIPT_TRAILER_KEY + " " + digest + "\n";
}
