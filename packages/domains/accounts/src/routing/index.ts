import type { AccountRecord, ConfidenceLevel } from "@acp/contracts";

import { TOKENS_USED_MAX, weakerConfidence } from "../quota/index.js";
import type { QuotaOutcome, QuotaRefusal } from "../quota/index.js";

/**
 * The quota-aware router.
 *
 * Pure and deterministic: same inputs, identical ranking. The clock is
 * injected, there is no I/O, no environment and no randomness — the module
 * names neither `Date.now` nor `Math.random`, and a test asserts both absences
 * over the source.
 *
 * It **recommends**. It reserves nothing, starts nothing and writes nothing.
 * P5 is shadow mode; a caller reads the ranking and decides.
 *
 * Three laws shape everything below.
 *
 * **One quota authority.** Scoring and margin use the fresh `QuotaEstimate`
 * produced by `../quota`, and nothing else. `AccountRecord.quotaEstimate` is
 * the owner's declared metadata: it is read once, to decide whether the account
 * is admissible at all, and never as a second score input. Two numbers claiming
 * to be the same quantity is how a ranking starts depending on which one a
 * reader happened to look at.
 *
 * **Nothing is guessed.** Historical acceptance and context affinity do not
 * exist in `AccountRecord`. They arrive as explicit, bounded evidence carrying
 * their own sample size and confidence, or as an explicit absence marker — they
 * are never inferred from an alias, a provider name or a model string. An
 * absent signal scores as absent, which is not the same as scoring as zero and
 * is certainly not the same as scoring as one.
 *
 * **A missing margin is a refusal, not a low score.** An account that cannot
 * fit the task plus its checkpoint reserve plus the cost of switching to it is
 * removed from the ranking with a named reason. Ranking it last would leave it
 * selectable by a caller with nothing better, which is exactly the case the
 * roadmap's rule exists to prevent.
 */

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Why a request, or one account within it, could not be routed.
 *
 * Request-level codes end the whole call; account-level codes remove one
 * candidate and are reported beside the ranking, so a reader can see which
 * accounts were considered and why each was dropped.
 */
export type RoutingRefusal =
  // the request itself does not hold together
  | "REQUEST_INVALID"
  | "TASK_PROFILE_INVALID"
  | "CONFIG_INVALID"
  | "EVIDENCE_INVALID"
  | "DUPLICATE_ACCOUNT_ID"
  | "DUPLICATE_ESTIMATE"
  | "ORPHAN_ESTIMATE"
  | "TOO_MANY_CANDIDATES"
  | "EVIDENCE_MISSING"
  | "NO_ELIGIBLE_ACCOUNT"
  // this account is not a candidate
  | "ACCOUNT_NOT_AVAILABLE"
  | "ACCOUNT_QUOTA_UNPUBLISHED"
  | "ESTIMATE_MISSING"
  | "ESTIMATE_REFUSED"
  | "ESTIMATE_ACCOUNT_MISMATCH"
  | "CAPABILITY_UNKNOWN"
  | "CAPABILITY_NOT_PROVIDED"
  | "MODEL_NOT_ENABLED"
  | "INSUFFICIENT_TOKEN_MARGIN"
  | "INSUFFICIENT_TIME_MARGIN";

/** Every refusal, for the closed-set assertions the tests make. */
export const ROUTING_REFUSALS: readonly RoutingRefusal[] = Object.freeze([
  "ACCOUNT_NOT_AVAILABLE",
  "ACCOUNT_QUOTA_UNPUBLISHED",
  "CAPABILITY_NOT_PROVIDED",
  "CAPABILITY_UNKNOWN",
  "CONFIG_INVALID",
  "DUPLICATE_ACCOUNT_ID",
  "DUPLICATE_ESTIMATE",
  "ESTIMATE_ACCOUNT_MISMATCH",
  "ESTIMATE_MISSING",
  "ESTIMATE_REFUSED",
  "EVIDENCE_INVALID",
  "EVIDENCE_MISSING",
  "INSUFFICIENT_TIME_MARGIN",
  "INSUFFICIENT_TOKEN_MARGIN",
  "MODEL_NOT_ENABLED",
  "NO_ELIGIBLE_ACCOUNT",
  "ORPHAN_ESTIMATE",
  "REQUEST_INVALID",
  "TASK_PROFILE_INVALID",
  "TOO_MANY_CANDIDATES",
]);

/** One account, and why it is not in the ranking. */
export interface RejectedAccount {
  readonly accountId: string;
  readonly reason: RoutingRefusal;
  /** The input that decided it. A path, never a value. */
  readonly at: string;
  /**
   * When `reason` is `ESTIMATE_REFUSED`, the quota module's own typed reason.
   *
   * Carried rather than re-encoded: the estimator already named why it could
   * not measure this account, and restating that in this module's vocabulary
   * would be a second authority on a question quota has already answered.
   */
  readonly quotaRefusal?: QuotaRefusal;
}

/**
 * A request-level refusal.
 *
 * It carries the per-account rejections it had already established, because
 * "no account was eligible" is not an answer a caller can act on — the useful
 * part is *which* accounts failed and on what. A refusal that dropped that
 * would make the most common failure the least informative one.
 */
export interface RoutingRefused {
  readonly ok: false;
  readonly reason: RoutingRefusal;
  readonly at: string;
  readonly rejected: readonly RejectedAccount[];
}

function refuse(
  reason: RoutingRefusal,
  at: string,
  rejected: readonly RejectedAccount[] = [],
): RoutingRefused {
  return Object.freeze({ ok: false as const, reason, at, rejected: Object.freeze([...rejected]) });
}

function reject(
  accountId: string,
  reason: RoutingRefusal,
  at: string,
  quotaRefusal?: QuotaRefusal,
): RejectedAccount {
  // `exactOptionalPropertyTypes` is on, so the field is added only when there
  // is one to add: an explicit `undefined` would be a different shape from an
  // absent key, and the frozen output would then carry a key that means
  // nothing.
  return Object.freeze(
    quotaRefusal === undefined ? { accountId, reason, at } : { accountId, reason, at, quotaRefusal },
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A signal that may simply not be known.
 *
 * The absence marker is a distinct branch rather than a sentinel number. A
 * default of zero would rank an account with no acceptance history below one
 * with a measured bad record; a default of one would rank it above a measured
 * good one. Both are claims the evidence does not support, so the term reports
 * itself as unknown and the neutral contribution is documented where it is
 * applied.
 */
export type EvidenceSample =
  | { readonly known: false }
  | {
      readonly known: true;
      /** A rate in [0, 1]. */
      readonly rate: number;
      readonly sampleSize: number;
      readonly confidence: ConfidenceLevel;
    };

/** The absence marker, so a caller states "not known" rather than omitting a field. */
export const EVIDENCE_ABSENT: EvidenceSample = Object.freeze({ known: false as const });

/**
 * Per-account evidence the record cannot supply.
 *
 * `acceptance` is the historical acceptance rate for work of this shape.
 * `contextAffinity` is how much of the task's context this account already
 * holds. Both are the caller's to measure; this module only weighs them.
 */
export interface CandidateEvidence {
  readonly accountId: string;
  readonly acceptance: EvidenceSample;
  readonly contextAffinity: EvidenceSample;
  /**
   * Which capabilities this account is known to provide.
   *
   * `known: false` is a statement, not an omission: it says the caller does not
   * know, and an account whose capabilities are unknown cannot be admitted for
   * a task that requires any.
   */
  readonly capabilities:
    | { readonly known: false }
    | { readonly known: true; readonly provided: readonly string[] };
}

/** What the task needs, in the dimensions the margin rule is stated in. */
export interface TaskProfile {
  /** Tokens the next atomic step is expected to cost. */
  readonly estimatedTokens: number;
  /** Wall-clock seconds the next atomic step is expected to take. */
  readonly estimatedDurationSeconds: number;
  /** Tokens held back for checkpoint, verification and audit. */
  readonly reserveTokens: number;
  /** The model the task needs. Checked against the record's `enabledModels`. */
  readonly model: string;
  /**
   * Capabilities the task requires, as the caller names them.
   *
   * Matched only against evidence the caller states explicitly. Nothing is
   * inferred from an alias, a provider or a model name: a provider's marketing
   * surface is not a capability contract, and guessing here would be the
   * module inventing evidence it was not given.
   */
  readonly requiredCapabilities: readonly string[];
}

/** The six roadmap factors, one term each. */
export type RoutingTerm =
  | "modelFit"
  | "quotaHeadroom"
  | "resetProximity"
  | "contextAffinity"
  | "switchPenalty"
  | "reserveMargin";

export const ROUTING_TERMS: readonly RoutingTerm[] = Object.freeze([
  "contextAffinity",
  "modelFit",
  "quotaHeadroom",
  "reserveMargin",
  "resetProximity",
  "switchPenalty",
]);

/**
 * Weights and thresholds. A closed, validated set.
 *
 * Every term is normalized to `[0, 1]` where **higher is better**, including
 * `switchPenalty`, whose value is the complement of the penalty: 1 means
 * switching to this account costs nothing worth counting. Mixing directions
 * inside one sum is how a weight ends up with the wrong sign and nobody
 * notices, so the sum is taken over comparable quantities and the naming says
 * so at the point of use.
 *
 * The score is the weighted mean, so it stays in `[0, 1]` whatever weights a
 * caller supplies and remains comparable across configurations.
 */
export interface RoutingConfig {
  readonly weights: Readonly<Record<RoutingTerm, number>>;
  /**
   * At or above this many estimated tokens, the task is a **long packet**.
   *
   * The roadmap states the margin rule for long packets specifically. This
   * module applies the margin rule to every task and reports the flag, which is
   * the fail-closed reading: a short packet that cannot reach its own
   * checkpoint is no more startable than a long one, and the alternative would
   * make the threshold a way to bypass the rule rather than a way to name it.
   */
  readonly longPacketTokens: number;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = Object.freeze({
  weights: Object.freeze({
    contextAffinity: 1,
    modelFit: 3,
    quotaHeadroom: 3,
    reserveMargin: 2,
    resetProximity: 1,
    switchPenalty: 1,
  }),
  longPacketTokens: 100_000,
});

/** The most accounts one request may rank. Bounded, like every input here. */
export const CANDIDATES_MAX = 1_000;

/**
 * Bounds on the caller's other collections.
 *
 * A request is refused rather than truncated: silently ignoring the tail of an
 * oversized input would rank a subset of the accounts the caller believed it
 * offered, which is a wrong answer wearing the shape of a right one.
 */
const SAMPLE_SIZE_MAX = 1_000_000;
const CAPABILITIES_MAX = 64;

export interface RoutingRequest {
  readonly records: readonly AccountRecord[];
  /**
   * Fresh quota outcomes from `../quota`, one wrapper per account.
   *
   * The wrapper carries the account the caller *asked* about, so a refused
   * outcome stays attributable and a successful one can be checked against the
   * estimate it contains. A bare `QuotaEstimate[]` could only describe accounts
   * the estimator succeeded on, which silently turns "we could not measure
   * this account" into "this account was never offered".
   */
  readonly estimates: readonly {
    readonly accountId: string;
    readonly outcome: QuotaOutcome;
  }[];
  readonly evidence: readonly CandidateEvidence[];
  readonly task: TaskProfile;
  readonly config: RoutingConfig;
  /** The current instant, injected. This module never reads a clock. */
  readonly now: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface RankedAccount {
  readonly accountId: string;
  /** The weighted mean of the terms below, in `[0, 1]`. */
  readonly score: number;
  readonly terms: Readonly<Record<RoutingTerm, number>>;
  /** Classified tokens explaining the score. Never free text, never a value. */
  readonly reasons: readonly string[];
  readonly confidence: ConfidenceLevel;
}

export interface RoutingRecommendation {
  /** Best first. Never empty: an empty set is a refusal. */
  readonly ranked: readonly RankedAccount[];
  readonly rejected: readonly RejectedAccount[];
  readonly longPacket: boolean;
  readonly evaluatedAt: string;
}

export type RoutingOutcome =
  | { readonly ok: true; readonly recommendation: RoutingRecommendation }
  | RoutingRefused;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Finite, safe, non-negative and within the repository's budget ceiling. */
function isBoundedTokens(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= TOKENS_USED_MAX
  );
}

function isBoundedSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 86_400;
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000;
}

/** `0` when the denominator is zero, so no term can produce NaN or Infinity. */
function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return clamp01(numerator / denominator);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------
// The six terms
// ---------------------------------------------------------------------------

/**
 * The neutral value for a signal that is not known.
 *
 * Half, and stated once rather than spelled inline at each site. It is not a
 * measurement — it is the explicit convention for "this term has nothing to say
 * about this account", chosen so an unknown signal neither promotes nor demotes
 * relative to a candidate whose signal is exactly average. The `reasons` list
 * records that the term was unknown, so a reader never has to infer whether a
 * 0.5 was measured or assumed.
 */
const UNKNOWN_TERM = 0.5;

/**
 * Capability/model fit, combined with historical acceptance.
 *
 * The roadmap names these as one factor and they are scored as one. Model
 * enablement is a hard gate handled before scoring — an account reaching this
 * function already lists the model — so what remains is the acceptance
 * evidence, which may be absent.
 */
function modelFitTerm(evidence: EvidenceSample): { readonly value: number; readonly known: boolean } {
  if (!evidence.known) return { value: UNKNOWN_TERM, known: false };
  return { value: clamp01(evidence.rate), known: true };
}

/**
 * How comfortably the task fits the remaining quota.
 *
 * Measured in tokens against `estimatedTokensRemaining`, never against
 * `remainingRatio`: a ratio is a fraction of a limit this module does not
 * otherwise know, so using it as a budget would compare a proportion with a
 * count. An account with exactly enough scores 0; one with ten times the need
 * scores near 1.
 */
function quotaHeadroomTerm(required: number, remaining: number): number {
  if (remaining <= 0 || required < 0) return 0;
  const surplus = remaining - required;
  if (surplus <= 0) return 0;
  return clamp01(surplus / remaining);
}

/**
 * How far the reset is, relative to the task's own duration.
 *
 * A reset an hour away is generous for a one-minute step and useless for a
 * two-hour one, so proximity is scored against what the task needs rather than
 * against a fixed horizon. Ten times the needed time or more scores 1.
 */
function resetProximityTerm(millisUntilReset: number, neededSeconds: number): number {
  const needed = Math.max(neededSeconds, 1) * 1_000;
  return ratio(millisUntilReset, needed * 10);
}

/** How much of the task's context this account already holds. */
function contextAffinityTerm(evidence: EvidenceSample): {
  readonly value: number;
  readonly known: boolean;
} {
  if (!evidence.known) return { value: UNKNOWN_TERM, known: false };
  return { value: clamp01(evidence.rate), known: true };
}

/**
 * The complement of the account-switch penalty.
 *
 * The record states what switching to this account costs in tokens and
 * seconds. Both are scored against what the task itself needs, because a
 * thousand-token switch is negligible before a large step and dominant before a
 * small one. The worse of the two dimensions decides: a switch that is cheap in
 * tokens and expensive in time is an expensive switch.
 */
function switchPenaltyTerm(record: AccountRecord, task: TaskProfile): number {
  const tokenCost = ratio(
    record.contextSwitchCost.estimatedTokens,
    Math.max(task.estimatedTokens, 1),
  );
  const timeCost = ratio(
    record.contextSwitchCost.estimatedSeconds,
    Math.max(task.estimatedDurationSeconds, 1),
  );
  return clamp01(1 - Math.max(tokenCost, timeCost));
}

/**
 * How much room is left once the checkpoint reserve is honoured.
 *
 * The margin rule below decides eligibility; this term grades what is left over
 * afterwards, so two accounts that both clear the bar are still ordered by how
 * much daylight they have above it.
 */
function reserveMarginTerm(surplus: number, remaining: number): number {
  return ratio(surplus, remaining);
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

function validateConfig(config: RoutingConfig): RoutingRefused | null {
  // The declared parameter type is the contract this module offers, not a
  // guarantee it receives: a JavaScript caller can pass anything. Reading the
  // value back as `unknown` discards a guarantee rather than inventing one,
  // which is what keeps these boundary guards real instead of redundant.
  const raw: unknown = config;
  if (typeof raw !== "object" || raw === null) {
    return refuse("CONFIG_INVALID", "config");
  }
  const fields = raw as Record<string, unknown>;
  if (!isBoundedTokens(fields["longPacketTokens"])) {
    return refuse("CONFIG_INVALID", "config.longPacketTokens");
  }
  const weights: unknown = fields["weights"];
  if (typeof weights !== "object" || weights === null) {
    return refuse("CONFIG_INVALID", "config.weights");
  }
  const weighted = weights as Record<string, unknown>;
  // Equality in both directions: an unknown weight is as wrong as a missing
  // one, and a term nobody weighted would silently drop out of the mean.
  const supplied = Object.keys(weighted).sort();
  if (supplied.length !== ROUTING_TERMS.length) {
    return refuse("CONFIG_INVALID", "config.weights");
  }
  let total = 0;
  for (const term of ROUTING_TERMS) {
    if (!Object.hasOwn(weighted, term)) return refuse("CONFIG_INVALID", "config.weights." + term);
    const weight: unknown = weighted[term];
    if (!isPositiveWeight(weight)) {
      return refuse("CONFIG_INVALID", "config.weights." + term);
    }
    total += weight;
  }
  if (total <= 0) return refuse("CONFIG_INVALID", "config.weights");
  return null;
}

function validateTask(task: TaskProfile): RoutingRefused | null {
  // The declared parameter type is the contract this module offers, not a
  // guarantee it receives: a JavaScript caller can pass anything. Reading the
  // value back as `unknown` discards a guarantee rather than inventing one,
  // which is what keeps these boundary guards real instead of redundant.
  const raw: unknown = task;
  if (typeof raw !== "object" || raw === null) {
    return refuse("TASK_PROFILE_INVALID", "task");
  }
  const fields = raw as Record<string, unknown>;
  if (!isBoundedTokens(fields["estimatedTokens"])) {
    return refuse("TASK_PROFILE_INVALID", "task.estimatedTokens");
  }
  if (!isBoundedTokens(fields["reserveTokens"])) {
    return refuse("TASK_PROFILE_INVALID", "task.reserveTokens");
  }
  if (!isBoundedSeconds(fields["estimatedDurationSeconds"])) {
    return refuse("TASK_PROFILE_INVALID", "task.estimatedDurationSeconds");
  }
  const model: unknown = fields["model"];
  if (typeof model !== "string" || model === "") {
    return refuse("TASK_PROFILE_INVALID", "task.model");
  }
  const capabilities: unknown = fields["requiredCapabilities"];
  if (!Array.isArray(capabilities) || capabilities.length > CAPABILITIES_MAX) {
    return refuse("TASK_PROFILE_INVALID", "task.requiredCapabilities");
  }
  const seen = new Set<string>();
  for (let index = 0; index < capabilities.length; index += 1) {
    const capability: unknown = capabilities[index];
    const at = "task.requiredCapabilities[" + String(index) + "]";
    if (typeof capability !== "string" || capability === "") {
      return refuse("TASK_PROFILE_INVALID", at);
    }
    // A duplicate is not harmless: it means the caller's own list disagrees
    // with itself about what the task needs.
    if (seen.has(capability)) return refuse("TASK_PROFILE_INVALID", at);
    seen.add(capability);
  }
  return null;
}

function validateEvidence(evidence: CandidateEvidence, at: string): RoutingRefused | null {
  // The declared parameter type is the contract this module offers, not a
  // guarantee it receives: a JavaScript caller can pass anything. Reading the
  // value back as `unknown` discards a guarantee rather than inventing one,
  // which is what keeps these boundary guards real instead of redundant.
  const raw: unknown = evidence;
  if (typeof raw !== "object" || raw === null) {
    return refuse("EVIDENCE_INVALID", at);
  }
  const fields = raw as Record<string, unknown>;
  for (const field of ["acceptance", "contextAffinity"] as const) {
    const sample: unknown = fields[field];
    if (typeof sample !== "object" || sample === null) {
      return refuse("EVIDENCE_INVALID", at + "." + field);
    }
    const sampled = sample as Record<string, unknown>;
    // `known` is the discriminant, so it is checked as a value rather than
    // trusted as a type: a sample that omits it, or carries something that is
    // not a boolean, is refused by name rather than read as "not known".
    const known: unknown = sampled["known"];
    if (typeof known !== "boolean") {
      return refuse("EVIDENCE_INVALID", at + "." + field + ".known");
    }
    if (!known) continue;
    if (!isRate(sampled["rate"])) return refuse("EVIDENCE_INVALID", at + "." + field + ".rate");
    const sampleSize: unknown = sampled["sampleSize"];
    // A known sample with no observations behind it is not knowledge. The floor
    // is 1, not 0, so "known" cannot be claimed over an empty measurement.
    if (
      typeof sampleSize !== "number" ||
      !Number.isSafeInteger(sampleSize) ||
      sampleSize < 1 ||
      sampleSize > SAMPLE_SIZE_MAX
    ) {
      return refuse("EVIDENCE_INVALID", at + "." + field + ".sampleSize");
    }
    const confidence: unknown = sampled["confidence"];
    if (
      typeof confidence !== "string" ||
      !(CONFIDENCE_LEVELS as readonly string[]).includes(confidence)
    ) {
      return refuse("EVIDENCE_INVALID", at + "." + field + ".confidence");
    }
  }
  const capabilities: unknown = fields["capabilities"];
  if (typeof capabilities !== "object" || capabilities === null) {
    return refuse("EVIDENCE_INVALID", at + ".capabilities");
  }
  const capability = capabilities as Record<string, unknown>;
  const capabilityKnown: unknown = capability["known"];
  if (typeof capabilityKnown !== "boolean") {
    return refuse("EVIDENCE_INVALID", at + ".capabilities.known");
  }
  if (capabilityKnown) {
    const provided: unknown = capability["provided"];
    if (!Array.isArray(provided) || provided.length > CAPABILITIES_MAX) {
      return refuse("EVIDENCE_INVALID", at + ".capabilities.provided");
    }
    for (let index = 0; index < provided.length; index += 1) {
      const entry: unknown = provided[index];
      if (typeof entry !== "string" || entry === "") {
        return refuse("EVIDENCE_INVALID", at + ".capabilities.provided[" + String(index) + "]");
      }
    }
  }
  return null;
}

const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = Object.freeze(["LOW", "MEDIUM", "HIGH"]);

/**
 * The instant grammar, mirrored byte-for-byte from `../quota`.
 *
 * A date and time with an explicit offset — `Z` or `±HH:MM` — with calendar-
 * valid days, so `2026-02-30` is refused rather than rolled forward. The
 * pattern is duplicated rather than imported because `../quota` keeps it
 * module-private and this packet's write-set is these two files; a test pins
 * the two against each other by feeding the same rejected string to
 * `estimateQuota`, so the mirror cannot drift unnoticed.
 */
const ISO_INSTANT =
  /^(\d{4}-(0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|\d{4}-(0[469]|11)-(0[1-9]|[12]\d|30)|\d{4}-02-(0[1-9]|1\d|2[0-8])|(\d{2}(0[48]|[2468][048]|[13579][26])|([02468][048]|[13579][26])00)-02-29)T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

function isAdmittedInstant(value: unknown): value is string {
  // The grammar alone, deliberately: this module's own law forbids `Date.parse`
  // along with every other clock-adjacent token, and the pattern already
  // rejects impossible calendar days, so parsing would add nothing but a
  // forbidden dependency. `../quota` parses as a second gate because it must
  // convert the instant to epoch milliseconds; this module only admits it.
  return typeof value === "string" && ISO_INSTANT.test(value);
}

/**
 * Rank the accounts that can take this task, and say why the others cannot.
 *
 * The order of operations is the order of the laws. The request is validated as
 * a whole first, because a duplicate account id or an orphan estimate makes
 * every downstream answer meaningless rather than merely one of them. Then each
 * account is admitted or rejected by name. Only what survives is scored.
 */
export function rankAccounts(request: RoutingRequest): RoutingOutcome {
  // The request is proved to be an object before anything is read out of it.
  // Destructuring first would make `rankAccounts(null)` a TypeError — an
  // uncatalogued crash where the contract promises a classified refusal.
  const rawRequest: unknown = request;
  if (typeof rawRequest !== "object" || rawRequest === null) {
    return refuse("REQUEST_INVALID", "request");
  }
  const { records, estimates, evidence, task, config, now } = request;

  // Narrowing `Array.isArray` over the declared arrays would retype their
  // elements as `any` and silently disable every check below. The guard runs
  // against `unknown` aliases instead, so the runtime defence stays and the
  // element types survive.
  const rawRecords: unknown = records;
  const rawEstimates: unknown = estimates;
  const rawEvidence: unknown = evidence;
  if (!Array.isArray(rawRecords) || !Array.isArray(rawEstimates) || !Array.isArray(rawEvidence)) {
    return refuse("REQUEST_INVALID", "request");
  }
  if (records.length > CANDIDATES_MAX) {
    return refuse("TOO_MANY_CANDIDATES", "records");
  }
  // Every collection is bounded, not just the one that names the candidates:
  // an unbounded estimates or evidence array is unbounded work regardless of
  // how few accounts were offered.
  if (estimates.length > CANDIDATES_MAX) {
    return refuse("REQUEST_INVALID", "estimates");
  }
  if (evidence.length > CANDIDATES_MAX) {
    return refuse("REQUEST_INVALID", "evidence");
  }
  const configRefusal = validateConfig(config);
  if (configRefusal !== null) return configRefusal;
  const taskRefusal = validateTask(task);
  if (taskRefusal !== null) return taskRefusal;
  // `now` is stamped into the recommendation as `evaluatedAt`, so it is a real
  // input and is held to the same grammar the quota module admits: an instant
  // that names its own offset. `Date.parse` alone would accept
  // "2026-08-29T12:00:00" and silently resolve it in the runtime's local zone.
  if (!isAdmittedInstant(now)) {
    return refuse("REQUEST_INVALID", "now");
  }

  // --- the total join, before anything is scored ---------------------------
  const byId = new Map<string, AccountRecord>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) return refuse("TASK_PROFILE_INVALID", "records[" + String(index) + "]");
    if (byId.has(record.accountId)) {
      return refuse("DUPLICATE_ACCOUNT_ID", "records[" + String(index) + "].accountId");
    }
    byId.set(record.accountId, record);
  }

  const outcomeById = new Map<string, QuotaOutcome>();
  for (let index = 0; index < estimates.length; index += 1) {
    const wrapper = estimates[index];
    const at = "estimates[" + String(index) + "]";
    if (wrapper === undefined || typeof wrapper.accountId !== "string") {
      return refuse("ORPHAN_ESTIMATE", at);
    }
    const outcome: unknown = wrapper.outcome;
    if (typeof outcome !== "object" || outcome === null) {
      return refuse("ORPHAN_ESTIMATE", at + ".outcome");
    }
    // The wrapper is caller-authored, so its discriminant is checked as a value
    // rather than trusted as a type. A truthy-but-not-boolean `ok` would be
    // read as success; an `ok: true` with no estimate behind it would reach the
    // scoring path and throw on a property of `undefined` — an uncatalogued
    // crash where the contract promises a classified refusal, which is the same
    // defect class as destructuring a null request.
    const shape = outcome as Record<string, unknown>;
    const ok: unknown = shape["ok"];
    if (typeof ok !== "boolean") {
      return refuse("ORPHAN_ESTIMATE", at + ".outcome");
    }
    if (ok) {
      const carried: unknown = shape["estimate"];
      if (typeof carried !== "object" || carried === null) {
        return refuse("ORPHAN_ESTIMATE", at + ".outcome.estimate");
      }
      const carriedId: unknown = (carried as Record<string, unknown>)["accountId"];
      if (typeof carriedId !== "string") {
        return refuse("ORPHAN_ESTIMATE", at + ".outcome.estimate");
      }
    }
    if (outcomeById.has(wrapper.accountId)) {
      return refuse("DUPLICATE_ESTIMATE", at + ".accountId");
    }
    // An outcome for an account that was not offered is not a harmless extra:
    // it means the caller's two collections describe different worlds, and
    // which of them is right is not this module's to decide.
    if (!byId.has(wrapper.accountId)) return refuse("ORPHAN_ESTIMATE", at + ".accountId");
    outcomeById.set(wrapper.accountId, wrapper.outcome);
  }

  const evidenceById = new Map<string, CandidateEvidence>();
  for (let index = 0; index < evidence.length; index += 1) {
    const entry = evidence[index];
    const at = "evidence[" + String(index) + "]";
    if (entry === undefined || typeof entry.accountId !== "string") {
      return refuse("EVIDENCE_INVALID", at);
    }
    if (evidenceById.has(entry.accountId)) return refuse("EVIDENCE_INVALID", at + ".accountId");
    if (!byId.has(entry.accountId)) return refuse("EVIDENCE_INVALID", at + ".accountId");
    const invalid = validateEvidence(entry, at);
    if (invalid !== null) return invalid;
    evidenceById.set(entry.accountId, entry);
  }

  // Exactly one row per account. A missing row used to fall through to a
  // silent `EVIDENCE_ABSENT` default, which let the ranking report "unknown"
  // for a signal the caller never actually declared. Absence of evidence and a
  // declaration of ignorance are different claims, and only the caller can
  // make the second one.
  for (const accountId of byId.keys()) {
    if (!evidenceById.has(accountId)) {
      return refuse("EVIDENCE_MISSING", "evidence." + accountId);
    }
  }

  // --- admission and scoring, one account at a time ------------------------
  const longPacket = task.estimatedTokens >= config.longPacketTokens;
  const requiredTokens = task.estimatedTokens + task.reserveTokens;
  const rejected: RejectedAccount[] = [];
  const ranked: RankedAccount[] = [];

  // Sorted, so the result cannot depend on the order the caller happened to
  // supply. Insertion-order dependence is the classic way a "deterministic"
  // ranking turns out not to be.
  for (const accountId of [...byId.keys()].sort()) {
    const record = byId.get(accountId);
    if (record === undefined) continue;
    const at = "records." + accountId;

    if (record.status !== "AVAILABLE") {
      rejected.push(reject(accountId, "ACCOUNT_NOT_AVAILABLE", at + ".status"));
      continue;
    }
    // Declared metadata, read exactly once and only to admit. Never scored.
    if (record.quotaEstimate.remainingRatio === null) {
      rejected.push(
        reject(accountId, "ACCOUNT_QUOTA_UNPUBLISHED", at + ".quotaEstimate.remainingRatio"),
      );
      continue;
    }
    if (!record.enabledModels.includes(task.model)) {
      rejected.push(reject(accountId, "MODEL_NOT_ENABLED", at + ".enabledModels"));
      continue;
    }

    const outcome = outcomeById.get(accountId);
    if (outcome === undefined) {
      rejected.push(reject(accountId, "ESTIMATE_MISSING", at));
      continue;
    }
    if (!outcome.ok) {
      // The estimator already named why it could not measure this account.
      // That reason is carried through untranslated rather than flattened into
      // a routing code that would lose which of the thirteen it was.
      rejected.push(reject(accountId, "ESTIMATE_REFUSED", at + ".outcome", outcome.reason));
      continue;
    }
    const estimate = outcome.estimate;
    // The wrapper says which account the caller asked about; the estimate says
    // which one was measured. If they disagree, one of them is about a
    // different account and this module cannot tell which.
    if (estimate.accountId !== accountId) {
      rejected.push(reject(accountId, "ESTIMATE_ACCOUNT_MISMATCH", at + ".outcome.estimate"));
      continue;
    }

    const candidateEvidence = evidenceById.get(accountId);
    if (candidateEvidence === undefined) {
      rejected.push(reject(accountId, "EVIDENCE_MISSING", at));
      continue;
    }
    // Capabilities are matched only against what the caller stated. An account
    // whose capabilities are unknown is not admitted for a task that requires
    // any of them — the fail-closed reading, since the alternative is to hope.
    if (task.requiredCapabilities.length > 0) {
      const capabilities = candidateEvidence.capabilities;
      if (!capabilities.known) {
        rejected.push(reject(accountId, "CAPABILITY_UNKNOWN", at + ".capabilities"));
        continue;
      }
      const provided = new Set(capabilities.provided);
      const missing = task.requiredCapabilities.find((needed) => !provided.has(needed));
      if (missing !== undefined) {
        rejected.push(reject(accountId, "CAPABILITY_NOT_PROVIDED", at + ".capabilities.provided"));
        continue;
      }
    }

    // An account with nothing left is never eligible, for any profile.
    if (estimate.estimatedTokensRemaining <= 0) {
      rejected.push(
        reject(accountId, "INSUFFICIENT_TOKEN_MARGIN", at + ".estimatedTokensRemaining"),
      );
      continue;
    }

    // --- the dimensioned margin rule --------------------------------------
    const switchTokens = record.contextSwitchCost.estimatedTokens;
    const switchSeconds = record.contextSwitchCost.estimatedSeconds;
    const needTokens = requiredTokens + switchTokens;
    // A zero-work profile makes the margin comparison vacuous — `0 < 0` is
    // false — so an account already past its limit would slip straight through
    // it. The margin rule is unconditional: a task that costs nothing is not a
    // licence to route to an account that is over budget. Scoped to the vacuous
    // case so that an over-budget account with real headroom is still ranked
    // and still reports ESTIMATE_OVER_BUDGET, rather than becoming unreachable.
    if (needTokens === 0 && estimate.overBudget) {
      rejected.push(reject(accountId, "INSUFFICIENT_TOKEN_MARGIN", at + ".overBudget"));
      continue;
    }
    if (estimate.estimatedTokensRemaining < needTokens) {
      rejected.push(reject(accountId, "INSUFFICIENT_TOKEN_MARGIN", at));
      continue;
    }
    const needSeconds = task.estimatedDurationSeconds + switchSeconds;
    if (estimate.reset.millisUntilReset < needSeconds * 1_000) {
      rejected.push(reject(accountId, "INSUFFICIENT_TIME_MARGIN", at));
      continue;
    }

    // --- scoring ----------------------------------------------------------
    const acceptance = candidateEvidence.acceptance;
    const affinity = candidateEvidence.contextAffinity;

    const fit = modelFitTerm(acceptance);
    const context = contextAffinityTerm(affinity);
    const surplus = estimate.estimatedTokensRemaining - needTokens;

    const terms: Record<RoutingTerm, number> = {
      contextAffinity: context.value,
      modelFit: fit.value,
      quotaHeadroom: quotaHeadroomTerm(needTokens, estimate.estimatedTokensRemaining),
      reserveMargin: reserveMarginTerm(surplus, estimate.estimatedTokensRemaining),
      resetProximity: resetProximityTerm(estimate.reset.millisUntilReset, needSeconds),
      switchPenalty: switchPenaltyTerm(record, task),
    };

    let weighted = 0;
    let totalWeight = 0;
    for (const term of ROUTING_TERMS) {
      const weight = config.weights[term];
      weighted += weight * terms[term];
      totalWeight += weight;
    }

    const reasons: string[] = [];
    if (!fit.known) reasons.push("ACCEPTANCE_UNKNOWN");
    if (!context.known) reasons.push("CONTEXT_AFFINITY_UNKNOWN");
    if (estimate.overBudget) reasons.push("ESTIMATE_OVER_BUDGET");
    if (longPacket) reasons.push("LONG_PACKET");
    if (surplus === 0) reasons.push("MARGIN_EXACT");

    // The recommendation is only as trustworthy as the estimate it rests on,
    // and an unknown signal is weaker evidence than a measured one.
    let confidence: ConfidenceLevel = estimate.confidence;
    if (!fit.known || !context.known) confidence = weakerConfidence(confidence, "LOW");
    // A known sample carries its own confidence, and the recommendation is only
    // as strong as its weakest input — the same law the quota module applies.
    if (acceptance.known) confidence = weakerConfidence(confidence, acceptance.confidence);
    if (affinity.known) confidence = weakerConfidence(confidence, affinity.confidence);

    ranked.push(
      Object.freeze({
        accountId,
        score: totalWeight > 0 ? weighted / totalWeight : 0,
        terms: Object.freeze({ ...terms }),
        reasons: Object.freeze([...reasons]),
        confidence,
      }),
    );
  }

  const frozenRejected = Object.freeze(
    [...rejected].sort((left, right) => (left.accountId < right.accountId ? -1 : 1)),
  );

  if (ranked.length === 0) {
    // Not an empty list. A caller handed an empty array will reach for a
    // fallback; a caller handed a refusal has to read the reasons.
    return refuse("NO_ELIGIBLE_ACCOUNT", "records", frozenRejected);
  }

  // Best first, ties by accountId. The comparator is total and never returns 0
  // for two distinct accounts, so the sort is stable by construction rather
  // than by the engine's promise.
  const ordered = [...ranked].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return left.accountId < right.accountId ? -1 : 1;
  });

  return {
    ok: true,
    recommendation: Object.freeze({
      ranked: Object.freeze(ordered),
      rejected: frozenRejected,
      longPacket,
      evaluatedAt: now,
    }),
  };
}
