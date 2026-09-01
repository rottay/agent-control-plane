/**
 * CommitAuthorizationReceipt — `@acp/contracts` (P8-T G6).
 *
 * Independent verification, write-set conformance, push permanently false.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import { attachGuards } from "../credential-guards/index.js";
import {
  AbsolutePath,
  ContractVersion,
  GitCommitSha,
  RepoRelativePath,
  Timestamp,
  Uuid,
} from "../primitives/index.js";
import { PathDigest } from "../shared-references/index.js";
import { WorkerIdentityString } from "../worker-identity/index.js";

export const CommitAuthorizationReceipt = z
  .strictObject({
    contractVersion: ContractVersion,
    receiptId: Uuid,
    taskId: Uuid,
    attempt: z.number().int().positive().max(10_000),

    /** The writer that produced the diff. */
    writer: WorkerIdentityString,
    /** The independent verifier that ran the checks. Never the writer. */
    verifier: WorkerIdentityString,
    /** The authority that adjudicated the packet. */
    authorizedBy: WorkerIdentityString,
    authorizedAt: Timestamp,

    worktreePath: AbsolutePath,
    branch: z.string().min(1).max(200),
    /**
     * The commit the authorized change is based on.
     *
     * null is allowed ONLY for the repository initial commit, where no Git HEAD
     * exists yet and there is therefore no base commit to name. Every later
     * receipt must carry a full 40 character object id: once HEAD exists, a
     * missing base would make write-set conformance unverifiable, so the
     * nullable case is a bootstrap exception and not a general escape hatch.
     */
    baseHead: GitCommitSha.nullable(),

    declaredWriteSet: z.array(RepoRelativePath).min(1).max(500),
    observedTrackedChanges: z.array(PathDigest).max(500),
    observedUntrackedPaths: z.array(RepoRelativePath).max(500),

    checks: z
      .array(
        z.strictObject({
          command: z.string().min(1).max(400),
          exitCode: z.number().int().min(0).max(255),
          ranAt: Timestamp,
        }),
      )
      .min(1)
      .max(50),

    commitMessage: z.string().min(1).max(2_000),
    /** Structural law. A receipt can never authorize a push. */
    pushAuthorized: z.literal(false),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });

    if (value.verifier === value.writer) {
      ctx.addIssue({
        code: "custom",
        message: "the verifier must be a different worker than the writer",
        path: ["verifier"],
      });
    }

    const declared = new Set(value.declaredWriteSet);

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

    if (value.checks.some((check) => check.exitCode !== 0)) {
      ctx.addIssue({
        code: "custom",
        message: "every recorded check must have exited zero before authorization",
        path: ["checks"],
      });
    }
  });
export type CommitAuthorizationReceipt = z.infer<typeof CommitAuthorizationReceipt>;
