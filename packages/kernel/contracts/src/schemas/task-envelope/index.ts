/**
 * TaskEnvelope — `@acp/contracts` (P8-T G6).
 *
 * The unit of authorized work: objective, authority, exact write-set, budget.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import { attachGuards } from "../credential-guards/index.js";
import {
  ContractVersion,
  RepoRelativePath,
  Timestamp,
  Uuid,
} from "../primitives/index.js";
import { PathDigest } from "../shared-references/index.js";
import { WORKER_ROLES, WorkerIdentityString, WorkerRole } from "../worker-identity/index.js";

export const TaskClassification = z.enum(["MECHANICAL", "SEMANTIC", "ARCHITECTURAL"]);
export type TaskClassification = z.infer<typeof TaskClassification>;

export const CommitPolicy = z.enum(["NO_COMMIT", "LOCAL_COMMIT_WITH_RECEIPT"]);
export type CommitPolicy = z.infer<typeof CommitPolicy>;

export const TaskEnvelope = z
  .strictObject({
    contractVersion: ContractVersion,
    taskId: Uuid,
    /**
     * The initiative this packet belongs to. Required, and the only place the
     * attribution lives: leases bind worktrees, worktrees serve tasks, events
     * carry taskId, so scoping through the task is the one shape that cannot
     * hold two disagreeing copies of the same fact. Isolation here means no
     * data bleed between initiatives — admission and quota stay global, so two
     * initiatives declaring the same conflict key still conflict.
     */
    initiativeId: Uuid,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(4_000),
    classification: TaskClassification,
    issuedBy: WorkerIdentityString,
    issuedAt: Timestamp,

    /** Authority is path plus content digest. Nothing else grants authority. */
    authority: z.array(PathDigest).max(1_000),
    readSet: z.array(RepoRelativePath).max(1_000),
    /** The exact write-set. An empty write-set means a read-only packet. */
    writeSet: z.array(RepoRelativePath).max(500),
    /** Opaque keys used to build the conflict graph between parallel packets. */
    conflictKeys: z.array(z.string().min(1).max(200)).max(200),

    allowedCommands: z.array(z.string().min(1).max(400)).max(100),
    forbiddenActions: z.array(z.string().min(1).max(400)).max(100),

    output: z.strictObject({
      kind: z.enum(["DIFF", "REPORT", "FIXTURE", "NONE"]),
      description: z.string().max(1_000),
    }),
    validation: z.strictObject({
      commands: z.array(z.string().min(1).max(400)).max(50),
      independentVerifierRequired: z.boolean(),
    }),

    eligibility: z.strictObject({
      roles: z.array(WorkerRole).min(1).max(WORKER_ROLES.length),
      /** null means provider neutral: any provider may serve this packet. */
      providers: z.array(z.string().min(1).max(40)).max(20).nullable(),
      requiredCapabilities: z.array(z.string().min(1).max(80)).max(50),
    }),

    budget: z.strictObject({
      maxTokens: z.number().int().positive().max(100_000_000),
      maxWallClockSeconds: z.number().int().positive().max(86_400),
      /** Never spend the reserve. It pays for checkpoint, verify and audit. */
      reserveTokensForCheckpoint: z.number().int().nonnegative().max(10_000_000),
    }),

    visualEvidenceRequired: z.boolean(),
    commitPolicy: CommitPolicy,
    checkpointPolicy: z.strictObject({
      onEveryAtomicStep: z.boolean(),
      maxStepsWithoutCheckpoint: z.number().int().positive().max(100),
    }),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });

    if (value.budget.reserveTokensForCheckpoint >= value.budget.maxTokens) {
      ctx.addIssue({
        code: "custom",
        message: "checkpoint reserve must be strictly smaller than the token budget",
        path: ["budget", "reserveTokensForCheckpoint"],
      });
    }

    if (value.commitPolicy === "LOCAL_COMMIT_WITH_RECEIPT" && value.writeSet.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a packet with an empty write-set may not carry a commit policy",
        path: ["commitPolicy"],
      });
    }

    const duplicates = value.writeSet.filter(
      (path, index) => value.writeSet.indexOf(path) !== index,
    );
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "write-set entries must be unique",
        path: ["writeSet"],
      });
    }
  });
export type TaskEnvelope = z.infer<typeof TaskEnvelope>;
