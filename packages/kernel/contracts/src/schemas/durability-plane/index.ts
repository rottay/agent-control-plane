/**
 * Durability and supervisor plane — `@acp/contracts` (P8-T G6).
 *
 * Driver modes, health, and the reconciliation report the plane produces.
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
  Sha256Hex,
  Timestamp,
  Uuid,
} from "../primitives/index.js";

/**
 * Which engine is advancing the state machine.
 *
 * Both are first-class. The SQLite supervisor is not a degraded fallback: it is
 * the predetermined default if the Restate drills fail, and it drives the same
 * shared core over the same ledger. Because authority never leaves the ledger,
 * the mode changes who advances the machine and nothing else.
 */
export const DRIVER_MODES = ["SQLITE_SUPERVISOR", "RESTATE"] as const;
export const DriverMode = z.enum(DRIVER_MODES);
export type DriverMode = z.infer<typeof DriverMode>;

/**
 * Whether the driver can currently advance work.
 *
 * Deliberately not the same enum as `HealthProbe.status`. That one describes a
 * probe of a worker; this one describes a driver's ability to make progress. A
 * driver that is simply not running is `UNAVAILABLE`, which is a fact about
 * deployment, not the `FAILED` of something that broke.
 */
export const DRIVER_HEALTH_STATES = ["OK", "DEGRADED", "UNAVAILABLE", "UNKNOWN"] as const;
export const DriverHealth = z.enum(DRIVER_HEALTH_STATES);
export type DriverHealth = z.infer<typeof DriverHealth>;

/**
 * A repository-relative, git-ignored data root.
 *
 * Reuses the repository-relative path rules and additionally rejects home
 * directory shorthand. A driver reports the segment it writes under, never the
 * absolute path it resolved: an absolute path names a home directory, a user
 * account and a machine layout, and the observation plane already keeps exactly
 * that out of anything a reader can see.
 */
const IgnoredDataRoot = RepoRelativePath.refine(
  (value) => !value.startsWith("~"),
  "data root must not name a home directory",
);

/**
 * What a driver reports about itself.
 *
 * Every field is either about the driver or about the ledger head the driver
 * last observed. Nothing here is an application fact: a reader learns which
 * engine is running and how far it has seen, never what a task is doing. That
 * separation is what keeps a derived orchestrator from becoming an authority by
 * being convenient to read.
 */
export const DriverStatus = z
  .strictObject({
    contractVersion: ContractVersion,
    mode: DriverMode,
    health: DriverHealth,
    observedAt: Timestamp,

    /** The ledger head this driver last observed. Zero on an empty ledger. */
    ledgerHeadSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ledgerHeadSha256: Sha256Hex,

    /** Repository-relative segment. Never an absolute path. */
    dataRoot: IgnoredDataRoot,

    /** When this mode became active, if the driver knows. */
    activeSince: Timestamp.nullable(),
    detail: z.string().max(500).nullable(),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    if (value.health !== "OK" && value.detail === null) {
      ctx.addIssue({
        code: "custom",
        message: "a driver that is not OK must say why",
        path: ["detail"],
      });
    }
    if (value.health === "UNAVAILABLE" && value.activeSince !== null) {
      ctx.addIssue({
        code: "custom",
        message: "an unavailable driver is not active and may not claim a start time",
        path: ["activeSince"],
      });
    }
  });
export type DriverStatus = z.infer<typeof DriverStatus>;

/**
 * The classification of a driver's view against the ledger.
 *
 * Fail-closed by construction: exactly two verdicts permit resuming, and both
 * of them are cases where the ledger fully explains the driver's state.
 *
 * - `CONSISTENT`: the driver agrees with the ledger head.
 * - `DRIVER_BEHIND`: the driver has seen less than the ledger. Replay closes
 *   it, because the ledger is a superset of what the driver knows.
 * - `DRIVER_AHEAD`: the driver claims a fact the ledger has no record of. This
 *   is the authority violation the whole design exists to prevent, and it halts.
 * - `DIVERGED`: driver and ledger disagree about the same coordinate. Halts.
 * - `INDETERMINATE`: the comparison could not be completed. Halts, because an
 *   unanswered question is not a negative answer.
 */
export const RECONCILIATION_VERDICTS = [
  "CONSISTENT",
  "DRIVER_BEHIND",
  "DRIVER_AHEAD",
  "DIVERGED",
  "INDETERMINATE",
] as const;
export const ReconciliationVerdict = z.enum(RECONCILIATION_VERDICTS);
export type ReconciliationVerdict = z.infer<typeof ReconciliationVerdict>;

/** The verdicts from which work may continue. Every other verdict halts. */
export const RESUMABLE_VERDICTS: readonly ReconciliationVerdict[] = [
  "CONSISTENT",
  "DRIVER_BEHIND",
];

const ReconciliationDiscrepancy = z.strictObject({
  /** Coordinates only. Never event content and never a payload value. */
  taskId: Uuid,
  attempt: z.number().int().positive().max(10_000),
  transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  /** Bounded, redacted description. Digests and coordinates, not content. */
  detail: z.string().min(1).max(300),
});
export type ReconciliationDiscrepancy = z.infer<typeof ReconciliationDiscrepancy>;

/**
 * The result of comparing a driver against the ledger.
 *
 * Two structural laws are encoded rather than documented. The report must name
 * the ledger head it was computed against, so a stale comparison cannot pass as
 * a fresh one; and `resolvedByLedger` is a literal `true`, so no report can
 * ever describe a reconciliation that went the other way.
 */
export const ReconciliationReport = z
  .strictObject({
    contractVersion: ContractVersion,
    reportId: Uuid,
    mode: DriverMode,
    verdict: ReconciliationVerdict,
    observedAt: Timestamp,

    /** The head the comparison was computed against. Ledger-headed by shape. */
    ledgerHeadSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ledgerHeadSha256: Sha256Hex,

    /** Structural law. The ledger wins; there is no other resolution. */
    resolvedByLedger: z.literal(true),

    /** False for every verdict the ledger cannot fully explain. */
    safeToResume: z.boolean(),

    discrepancies: z.array(ReconciliationDiscrepancy).max(200),
    detail: z.string().max(500).nullable(),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const resumable = (RESUMABLE_VERDICTS as readonly string[]).includes(value.verdict);
    if (value.safeToResume !== resumable) {
      ctx.addIssue({
        code: "custom",
        message:
          "safeToResume must be true for exactly " +
          RESUMABLE_VERDICTS.join(" and ") +
          "; every other verdict halts",
        path: ["safeToResume"],
      });
    }

    if (value.verdict === "CONSISTENT" && value.discrepancies.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "a consistent reconciliation cannot carry discrepancies",
        path: ["discrepancies"],
      });
    }

    if (value.verdict !== "CONSISTENT" && value.detail === null) {
      ctx.addIssue({
        code: "custom",
        message: "any verdict other than CONSISTENT must say why",
        path: ["detail"],
      });
    }

    if (
      (value.verdict === "DRIVER_AHEAD" || value.verdict === "DIVERGED") &&
      value.discrepancies.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a halting verdict must name at least one discrepancy",
        path: ["discrepancies"],
      });
    }
  });
export type ReconciliationReport = z.infer<typeof ReconciliationReport>;
