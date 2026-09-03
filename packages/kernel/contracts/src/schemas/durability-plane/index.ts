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
 * The four durable verbs a driver may support (V2-B2-1).
 *
 * Closed, and closed on purpose: a fifth verb is a contract change, not a
 * configuration value. Each names a thing a caller can ASK a driver to do, and
 * each therefore has a method on the port — which is what lets the declaration
 * below be checked against behaviour rather than believed.
 *
 * This is not a second model-capability registry. Model capabilities describe
 * what a provider's model can do and stay `UNKNOWN` until a real-subject drill
 * confirms them; these describe what an orchestration driver's own engine
 * offers, which is knowable by construction from the engine's own API. Two
 * different questions about two different subjects, and the roadmap's
 * single-registry restriction governs the other one.
 */
export const DRIVER_CAPABILITIES = ["CANCEL", "REATTACH", "SIGNAL", "TIMER"] as const;
export const DriverCapability = z.enum(DRIVER_CAPABILITIES);
export type DriverCapability = z.infer<typeof DriverCapability>;

/**
 * Structural properties a driver either has or does not, with no verb attached.
 *
 * `SERIALIZED_PER_TASK` is a fact about how an engine schedules, not something
 * a caller invokes. It is kept in its own shape rather than flattened in beside
 * the verbs precisely because it cannot participate in the correspondence law:
 * there is no method to compare a declaration against. Inventing a
 * `serialize()` nobody calls, purely so one flat enum could be used, would buy
 * symmetry with a lie.
 */
export const DRIVER_CAPABILITY_PROPERTIES = ["SERIALIZED_PER_TASK"] as const;
export const DriverCapabilityProperty = z.enum(DRIVER_CAPABILITY_PROPERTIES);
export type DriverCapabilityProperty = z.infer<typeof DriverCapabilityProperty>;

/**
 * Two states, deliberately not three.
 *
 * The model-capability vocabulary carries `UNKNOWN` because a model's abilities
 * are only learnable by drilling a real subject. A driver's are not: the engine
 * either exposes the operation or it does not, and the code that would call it
 * is in this repository. So there is no honest third state here, and adding one
 * would give a driver somewhere to hide.
 */
export const DRIVER_CAPABILITY_STATES = ["SUPPORTED", "UNSUPPORTED"] as const;
export const DriverCapabilityState = z.enum(DRIVER_CAPABILITY_STATES);
export type DriverCapabilityState = z.infer<typeof DriverCapabilityState>;

/**
 * What a driver declares about its own engine.
 *
 * A self-report, exactly like `DriverStatus`, and it lives beside it for the
 * same reason: a reader may see it, and a driver must satisfy it. It carries no
 * application fact — nothing here says what a task is doing, only what the
 * engine advancing it can be asked for.
 *
 * The declaration is not decorative. For every verb, `UNSUPPORTED` means the
 * corresponding method returns a `DriverRefused` for every input, and
 * `SUPPORTED` means it does not; that correspondence is checked rather than
 * promised (`driverCapabilityMismatches` in `@acp/runtime`, and the fence's own
 * pin over both driver sources).
 */
export const DriverCapabilities = z
  .strictObject({
    contractVersion: ContractVersion,
    mode: DriverMode,
    /** One entry per verb. Every verb is answered; silence is not a state. */
    verbs: z.strictObject({
      CANCEL: DriverCapabilityState,
      REATTACH: DriverCapabilityState,
      SIGNAL: DriverCapabilityState,
      TIMER: DriverCapabilityState,
    }),
    /** Properties, which have no method and no correspondence obligation. */
    properties: z.strictObject({
      SERIALIZED_PER_TASK: DriverCapabilityState,
    }),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });
  });
export type DriverCapabilities = z.infer<typeof DriverCapabilities>;

/**
 * Why a driver refused a verb.
 *
 * Closed and sorted, like every other refusal vocabulary in this package. One
 * member today, because at the packet that introduces the verbs there is
 * exactly one honest reason to refuse: the engine does not offer the operation.
 * A later packet that needs a second reason adds it together with the drill
 * that earns it, rather than stocking the enum in advance with names nothing
 * returns.
 */
export const DRIVER_REFUSALS = ["CAPABILITY_UNSUPPORTED"] as const;
export const DriverRefusal = z.enum(DRIVER_REFUSALS);
export type DriverRefusal = z.infer<typeof DriverRefusal>;

/**
 * A refusal from a driver verb, carrying a closed reason and where it applied.
 *
 * The same shape `ExecutionRefused` already established at the owned execution
 * boundary, for the same reasons: `ok: false` makes the union discriminable
 * without a thrown error, and `at` names a verb or a field — never engine
 * output, never a path, never anything about the work being advanced.
 */
export interface DriverRefused {
  readonly ok: false;
  readonly refusal: DriverRefusal;
  /** The verb or field that was refused. Never engine output. */
  readonly at: string;
}

/**
 * A verb that was accepted.
 *
 * It was deliberately empty at B2-1, which implemented no verb: each packet
 * that makes a verb real widens this arm with what that verb actually
 * produces, and a placeholder invented in advance would have been a shape
 * every later packet had to work around.
 *
 * V2-B2-4a makes `REATTACH` real and so opens it, with one field and one
 * meaning. Every member here must be a LEDGER coordinate. A driver may report
 * how far the ledger got; it may not hand back anything the engine minted,
 * because a caller that could persist an engine identity would make the
 * orchestrator an authority over its own address — the thing the derived
 * design exists to prevent. `finalSequence` is the ledger head the invocation
 * reached, which is a fact the ledger already holds and can restate for
 * itself.
 *
 * Optional, because it belongs to `REATTACH` alone. A later verb that produces
 * nothing of this shape answers with a bare `{ ok: true }` rather than being
 * forced to invent a sequence it never observed.
 */
export interface DriverAccepted {
  readonly ok: true;
  /** The ledger head the reattached invocation reached (V2-B2-4a). */
  readonly finalSequence?: number;
}

/** What a driver verb answers: accepted, or refused with a closed reason. */
export type DriverOutcome = DriverAccepted | DriverRefused;

/** Is this outcome a refusal? One test, so callers cannot each invent their own. */
export function isDriverRefused(outcome: DriverOutcome): outcome is DriverRefused {
  return !outcome.ok;
}

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
