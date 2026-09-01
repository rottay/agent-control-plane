/**
 * AccountRecord — `@acp/contracts` (P8-T G6).
 *
 * Account metadata with opaque local auth references only.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import { attachGuards } from "../credential-guards/index.js";
import { AbsolutePath, ContractVersion, Timestamp } from "../primitives/index.js";
import { HealthProbe } from "../worker-slot/index.js";

export const AccountStatus = z.enum([
  "AVAILABLE",
  "DRAINING",
  "EXHAUSTED",
  "COOLDOWN",
  "AUTH_REQUIRED",
]);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const AuthMode = z.enum([
  "PREAUTHENTICATED_PROFILE",
  "LOCAL_CREDENTIAL_FALLBACK",
  "DEVICE_AUTHORIZATION",
]);
export type AuthMode = z.infer<typeof AuthMode>;

export const ConfidenceLevel = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

/**
 * An opaque local reference. It names where the adapter should look, never
 * what it will find. Inline material is rejected by construction.
 */
export const LocalAuthReference = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(keychain|profile|file):\/\/[A-Za-z0-9._~@-][A-Za-z0-9._~@/-]*$/,
    "reference must be an opaque keychain://, profile:// or file:// locator",
  );
export type LocalAuthReference = z.infer<typeof LocalAuthReference>;

/**
 * Account metadata as it may exist inside the control plane.
 *
 * This is the projection that is allowed in SQLite, the read model and the UI.
 * The owner file at ~/.rottay-agent-control-plane/accounts.local.json stays
 * outside every repository and is never mirrored here in full.
 */
export const AccountRecord = z
  .strictObject({
    contractVersion: ContractVersion,
    accountId: z.string().min(1).max(80),
    provider: z.string().min(1).max(40),
    alias: z.string().min(1).max(80),

    authMode: AuthMode,
    /** Opaque locator for a preauthenticated provider profile. */
    authProfileRef: LocalAuthReference,
    /** Opaque locator used only when an adapter needs the fallback path. */
    credentialRef: LocalAuthReference.nullable(),

    plan: z.string().max(80).nullable(),
    enabledModels: z.array(z.string().min(1).max(60)).max(50),
    knownLimits: z.record(z.string().max(60), z.number().nonnegative()),

    resetSchedule: z.strictObject({
      kind: z.enum(["OBSERVED", "DECLARED", "UNKNOWN"]),
      nextResetAt: Timestamp.nullable(),
      timezone: z.string().min(1).max(60),
      confidence: ConfidenceLevel,
    }),

    quotaEstimate: z.strictObject({
      remainingRatio: z.number().min(0).max(1).nullable(),
      estimatedTokensRemaining: z.number().int().nonnegative().nullable(),
      estimatedAt: Timestamp,
      confidence: ConfidenceLevel,
    }),

    lastHealthProbe: HealthProbe.nullable(),
    lastClassifiedError: z.string().max(200).nullable(),

    status: AccountStatus,
    /** Isolated provider configuration root, so sessions never cross accounts. */
    isolatedConfigRoot: AbsolutePath,
    contextSwitchCost: z.strictObject({
      estimatedTokens: z.number().int().nonnegative().max(10_000_000),
      estimatedSeconds: z.number().int().nonnegative().max(86_400),
    }),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    if (value.authMode === "LOCAL_CREDENTIAL_FALLBACK" && value.credentialRef === null) {
      ctx.addIssue({
        code: "custom",
        message: "the local credential fallback mode requires an opaque credentialRef",
        path: ["credentialRef"],
      });
    }

    if (value.status === "AUTH_REQUIRED" && value.quotaEstimate.remainingRatio !== null) {
      // Fail closed: an account that needs reauthentication has no trustworthy
      // quota reading, so the router must not be handed a stale number.
      ctx.addIssue({
        code: "custom",
        message: "an AUTH_REQUIRED account must not publish a quota estimate",
        path: ["quotaEstimate", "remainingRatio"],
      });
    }
  });
export type AccountRecord = z.infer<typeof AccountRecord>;
