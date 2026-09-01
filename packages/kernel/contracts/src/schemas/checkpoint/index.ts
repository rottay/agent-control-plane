/**
 * Checkpoint — `@acp/contracts` (P8-T G6).
 *
 * Bounded, digest-based continuity and one next safe action.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import { attachGuards, serializedByteLength } from "../credential-guards/index.js";
import {
  AbsolutePath,
  ContractVersion,
  GitCommitSha,
  Timestamp,
  Uuid,
} from "../primitives/index.js";
import { ArtifactRef, PathDigest } from "../shared-references/index.js";
import { WorkerIdentityString } from "../worker-identity/index.js";

/** Serialized byte budget for a single Checkpoint. */
export const CHECKPOINT_MAX_BYTES = 16_384;

export const Checkpoint = z
  .strictObject({
    contractVersion: ContractVersion,
    checkpointId: Uuid,
    taskId: Uuid,
    attempt: z.number().int().positive().max(10_000),
    worker: WorkerIdentityString,
    createdAt: Timestamp,

    /** The last atomic step that actually completed. Never a partial step. */
    lastAtomicStep: z.strictObject({
      index: z.number().int().nonnegative().max(10_000),
      label: z.string().min(1).max(200),
      completedAt: Timestamp,
    }),

    git: z.strictObject({
      head: GitCommitSha,
      branch: z.string().min(1).max(200),
      worktreePath: AbsolutePath,
      isDirty: z.boolean(),
    }),

    authorityDigest: z.array(PathDigest).max(1_000),
    readSetDigest: z.array(PathDigest).max(1_000),
    writeSetDigest: z.array(PathDigest).max(500),

    receipts: z.array(ArtifactRef).max(50),
    artifacts: z.array(ArtifactRef).max(100),

    pendingWork: z.array(z.string().min(1).max(400)).max(100),
    /** Exactly one next safe action. Recovery resumes from here. */
    nextSafeAction: z.string().min(1).max(1_000),
    notes: z.string().max(2_000).nullable(),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const size = serializedByteLength(value);
    if (size > CHECKPOINT_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message:
          "checkpoint is " +
          String(size) +
          " bytes which exceeds the " +
          String(CHECKPOINT_MAX_BYTES) +
          " byte budget; carry digests and artifact references, not content",
        path: [],
      });
    }
  });
export type Checkpoint = z.infer<typeof Checkpoint>;
