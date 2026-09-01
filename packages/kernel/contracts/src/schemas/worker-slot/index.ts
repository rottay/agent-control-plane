/**
 * WorkerSlot — `@acp/contracts` (P8-T G6).
 *
 * A resolved worker: model, account, quota, reservation, lease, health probe.
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
  Timestamp,
  Uuid,
} from "../primitives/index.js";
import { WORKER_IDENTITY_PATTERN, WorkerIdentityString, WorkerRole } from "../worker-identity/index.js";

export const HealthProbe = z.strictObject({
  status: z.enum(["OK", "DEGRADED", "FAILED", "UNKNOWN"]),
  checkedAt: Timestamp,
  latencyMs: z.number().int().nonnegative().max(600_000).nullable(),
  classifiedError: z.string().max(200).nullable(),
});
export type HealthProbe = z.infer<typeof HealthProbe>;

export const Lease = z.strictObject({
  leaseId: Uuid,
  worktreePath: AbsolutePath,
  holder: WorkerIdentityString,
  acquiredAt: Timestamp,
  expiresAt: Timestamp,
});
export type Lease = z.infer<typeof Lease>;

export const WorkerSlot = z
  .strictObject({
    contractVersion: ContractVersion,
    slotId: Uuid,
    identity: WorkerIdentityString,
    provider: z.string().min(1).max(40),
    // The model segment inside `identity` is the ROUTING ALIAS the DT schedules
    // against (for example "opus"). `resolvedModel` below is the EXACT model the
    // provider actually resolved at session start (for example
    // "claude-opus-5-20260401"). They are intentionally allowed to differ:
    // pinning them together would force an identity change on every provider
    // model bump, and would contradict the roadmap law that current model
    // preferences are not permanent. Provider and role segments, by contrast,
    // MUST equal the flat fields, because those carry authority, not routing.
    resolvedModel: z.string().min(1).max(60),
    cliVersion: z.string().min(1).max(60),
    role: WorkerRole,
    capabilities: z.array(z.string().min(1).max(80)).max(50),
    accountId: z.string().min(1).max(80),

    permissions: z.strictObject({
      canWrite: z.boolean(),
      canCommit: z.boolean(),
      /** Structural law. No slot may ever push. */
      canPush: z.literal(false),
    }),

    quota: z.strictObject({
      remainingRatio: z.number().min(0).max(1).nullable(),
      estimatedTokensRemaining: z.number().int().nonnegative().nullable(),
      resetsAt: Timestamp.nullable(),
    }),

    reservation: z
      .strictObject({
        taskId: Uuid,
        reservedAt: Timestamp,
        reservedTokens: z.number().int().nonnegative(),
      })
      .nullable(),

    lease: Lease.nullable(),
    healthProbe: HealthProbe,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });

    const parsed = WORKER_IDENTITY_PATTERN.exec(value.identity);
    if (parsed !== null) {
      if (parsed[1] !== value.provider) {
        ctx.addIssue({
          code: "custom",
          message: "identity provider segment must equal the provider field",
          path: ["provider"],
        });
      }
      if (parsed[3] !== value.role) {
        ctx.addIssue({
          code: "custom",
          message: "identity role segment must equal the role field",
          path: ["role"],
        });
      }
    }

    // The auditor is structurally read-only, not read-only by convention.
    if (value.role === "reviewer" && (value.permissions.canWrite || value.permissions.canCommit)) {
      ctx.addIssue({
        code: "custom",
        message: "a reviewer slot must be structurally read-only",
        path: ["permissions"],
      });
    }

    if (value.permissions.canCommit && !value.permissions.canWrite) {
      ctx.addIssue({
        code: "custom",
        message: "a slot that cannot write may not commit",
        path: ["permissions", "canCommit"],
      });
    }

    if (value.lease !== null && value.lease.holder !== value.identity) {
      ctx.addIssue({
        code: "custom",
        message: "a lease held by another identity may not be attached to this slot",
        path: ["lease", "holder"],
      });
    }
  });
export type WorkerSlot = z.infer<typeof WorkerSlot>;
