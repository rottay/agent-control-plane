import type { AccountRecord, ConfidenceLevel } from "@acp/contracts";

/**
 * Quota estimation and the reset calendar.
 *
 * Pure, and pure in the strong sense: **no function here reads a clock.** The
 * current instant is an injected parameter at every entry point, so a test can
 * sit exactly on a reset boundary and stay there, and so nothing in this module
 * can behave differently at four in the morning. There is no I/O, no
 * environment, and no ledger — the token observations arrive as values that a
 * caller has already read.
 *
 * Two laws shape everything below.
 *
 * **An estimate is never a bare number.** It carries the limit it was measured
 * against, the observations it summed, and an explicit confidence. A ratio on
 * its own invites a caller to treat a guess as a measurement, which is exactly
 * the mistake this phase exists to prevent.
 *
 * **Absent data is a classified refusal, never a default.** A record with no
 * usable limit, no known reset, or a status that says the account is not
 * available is refused by name. It is never estimated at zero, never estimated
 * optimistically, and never returned as "unknown, proceed".
 *
 * The refusal vocabulary here is separate from `../errors/index.js` deliberately.
 * That one classifies what is wrong with the *owner file*; this one classifies
 * what is wrong with an *estimate*. They are different judgements about
 * different objects, and collapsing them would make both less precise. (The
 * privacy vocabulary is the opposite case and stays single: there is exactly
 * one definition of what credential material looks like, and it lives in
 * `@acp/contracts`.)
 */

/** Why an estimate could not be produced. */
export type QuotaRefusal =
  // the account is not a candidate at all
  | "ACCOUNT_NOT_AVAILABLE"
  | "ACCOUNT_QUOTA_UNPUBLISHED"
  // there is no limit to measure against
  | "LIMIT_UNKNOWN"
  | "LIMIT_NOT_POSITIVE"
  // the reset calendar cannot be computed
  | "RESET_UNKNOWN"
  | "RESET_TIMEZONE_UNKNOWN"
  | "RESET_ALREADY_PASSED"
  // the evidence does not hold together
  | "OBSERVATION_INVALID"
  | "OBSERVATION_OUT_OF_RANGE"
  | "OBSERVATION_IN_FUTURE"
  | "OBSERVATION_COUNT_EXCEEDED"
  | "OBSERVATION_SUM_UNSAFE"
  | "TIMESTAMP_INVALID";

/** Every refusal, for the closed-set assertions the tests make. */
export const QUOTA_REFUSALS: readonly QuotaRefusal[] = Object.freeze([
  "ACCOUNT_NOT_AVAILABLE",
  "ACCOUNT_QUOTA_UNPUBLISHED",
  "LIMIT_NOT_POSITIVE",
  "LIMIT_UNKNOWN",
  "OBSERVATION_COUNT_EXCEEDED",
  "OBSERVATION_INVALID",
  "OBSERVATION_IN_FUTURE",
  "OBSERVATION_OUT_OF_RANGE",
  "OBSERVATION_SUM_UNSAFE",
  "RESET_ALREADY_PASSED",
  "RESET_TIMEZONE_UNKNOWN",
  "RESET_UNKNOWN",
  "TIMESTAMP_INVALID",
]);

/**
 * A refusal names the input that failed, never its value.
 *
 * The same discipline the owner-file loader holds to, for the same reason: an
 * account record is one field away from material that must not travel, and a
 * refusal that quoted the input it choked on would be the place it escaped.
 * `at` is a path this module constructs — `record.resetSchedule.nextResetAt`,
 * `observations[3].observedAt` — and nothing else.
 */
export interface QuotaRefused {
  readonly ok: false;
  readonly reason: QuotaRefusal;
  readonly at: string;
}

function refuse(reason: QuotaRefusal, at: string): QuotaRefused {
  return Object.freeze({ ok: false as const, reason, at });
}

/**
 * Confidence, weakest first.
 *
 * Exported because propagation is a law rather than a detail: an estimate is
 * only as good as its weakest input, and a caller that wants to combine this
 * estimate with another needs the same ordering rather than its own.
 */
export const CONFIDENCE_ORDER: readonly ConfidenceLevel[] = Object.freeze([
  "LOW",
  "MEDIUM",
  "HIGH",
]);

/** The weaker of two confidences. Never the average, and never the better one. */
export function weakerConfidence(left: ConfidenceLevel, right: ConfidenceLevel): ConfidenceLevel {
  return CONFIDENCE_ORDER.indexOf(left) <= CONFIDENCE_ORDER.indexOf(right) ? left : right;
}

/**
 * The frozen budget ceiling, as this repository has used it since P3.
 *
 * Declared locally rather than imported: `@acp/adapters` and
 * `@acp/observation` each declare their own for the same reason, and the
 * contract itself writes `.max(10_000_000)` inline in two places. Neither of
 * those packages is a permitted dependency here, and reaching for one to share
 * a number would buy a coupling that costs more than the constant.
 */
export const TOKENS_USED_MAX = 10_000_000;

/**
 * The most observations one estimate may be built from.
 *
 * This bound is not about performance. It is the second half of an arithmetic
 * proof: with every observation capped at `TOKENS_USED_MAX`, a run of at most
 * `OBSERVATIONS_MAX` of them sums to at most 10^12, which is three orders of
 * magnitude below `Number.MAX_SAFE_INTEGER`. That is what makes the
 * accumulation guard below provably unreachable rather than merely untriggered
 * in the cases anyone happened to try.
 */
export const OBSERVATIONS_MAX = 100_000;

/**
 * One ledger-recorded usage observation, handed over as a value.
 *
 * This module never reads the ledger. P5D's caller does, and passes what it
 * read; the estimator's job is arithmetic over evidence, not the acquisition of
 * evidence. That split is what lets every test here be a pure function call.
 */
export interface TokenObservation {
  readonly tokensUsed: number;
  /** An offset-bearing ISO instant, as the frozen contract writes them. */
  readonly observedAt: string;
}

/** When the account's quota window next rolls over, and how well that is known. */
export interface ResetCalendar {
  /** `UNKNOWN` never reaches here: it is a refusal, not a kind of answer. */
  readonly kind: "OBSERVED" | "DECLARED";
  readonly nextResetAt: string;
  readonly timezone: string;
  readonly millisUntilReset: number;
  readonly confidence: ConfidenceLevel;
}

export type ResetOutcome =
  | { readonly ok: true; readonly calendar: ResetCalendar }
  | QuotaRefused;

export interface QuotaEstimateInput {
  readonly record: AccountRecord;
  /** Already scoped by the caller. See `estimateQuota` on what that means. */
  readonly observations: readonly TokenObservation[];
  /** Which entry of `knownLimits` this estimate is measured against. */
  readonly limitKey: string;
  /** The current instant, injected. This module never reads a clock. */
  readonly now: string;
}

export interface QuotaEstimate {
  readonly accountId: string;
  readonly limitKey: string;
  readonly limitTokens: number;
  readonly observedTokensUsed: number;
  readonly observationCount: number;
  readonly remainingRatio: number;
  readonly estimatedTokensRemaining: number;
  /** Usage exceeded the limit. The ratio is clamped; this says it was clamped. */
  readonly overBudget: boolean;
  readonly confidence: ConfidenceLevel;
  readonly estimatedAt: string;
  readonly reset: ResetCalendar;
}

export type QuotaOutcome =
  | { readonly ok: true; readonly estimate: QuotaEstimate }
  | QuotaRefused;

/**
 * The only instant grammar this module accepts.
 *
 * A date and time with an explicit offset — `Z` or `±HH:MM`. Seconds are
 * optional; fractional seconds are permitted only where seconds are present.
 *
 * **The offset is what matters, and `Date.parse` alone will not enforce it.**
 * Handed `"2026-08-28"` it returns midnight **UTC**; handed
 * `"2026-08-28T12:00:00"` — the same shape without an offset — it returns
 * midday in *the machine's local zone*. The second is the dangerous one. It
 * parses, it yields a plausible number, and that number differs by hours
 * depending on where the process is running, so an estimate computed in Madrid
 * and one computed in New York would disagree about how much quota is left from
 * byte-identical inputs. Requiring the offset moves that decision into the data,
 * where it belongs.
 *
 * **Seconds are optional because the contract says so.** This grammar is
 * deliberately the subset `Timestamp` in `@acp/contracts` already admits
 * (`z.iso.datetime({ offset: true })`), which accepts minute precision. An
 * earlier draft required seconds, and the effect was that a record the contract
 * called valid could be refused here — a validator downstream of a validator,
 * disagreeing with it. Two grammars for one shape is how a boundary starts
 * rejecting conforming data, so this one tracks the contract rather than
 * improving on it. Tightening the shape is a change to `@acp/contracts`, made
 * once, where every consumer receives it.
 *
 * **The character classes are calendar-valid, and they have to be.** `\d{2}`
 * for a month admits `13`; for a day it admits `2026-02-30` and `2026-04-31`;
 * for an hour it admits `24:00:00`. The contract refuses all of those, and
 * `Date.parse` does **not** — it accepts `2026-02-30T12:00:00Z` and rolls it
 * into March, and accepts `24:00:00` as the following midnight. So a loose
 * grammar backed by `Date.parse` would have disagreed with the contract in five
 * measured ways while looking like it agreed. Month, day-per-month, hour,
 * minute, second and both halves of the offset are therefore bounded here.
 *
 * The `02-29` alternative is the leap rule in full — divisible by four, except
 * centuries, except multiples of four hundred — because the contract implements
 * it: `2024-02-29` and `2000-02-29` are accepted, `2026-02-29` and `1900-02-29`
 * are not. Approximating it with "February has 29 days" would put the
 * disagreement back one year in four.
 */
const ISO_INSTANT =
  /^(\d{4}-(0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|\d{4}-(0[469]|11)-(0[1-9]|[12]\d|30)|\d{4}-02-(0[1-9]|1\d|2[0-8])|(\d{2}(0[48]|[2468][048]|[13579][26])|([02468][048]|[13579][26])00)-02-29)T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Parse an offset-bearing ISO instant to epoch milliseconds.
 *
 * The grammar is checked first and `Date.parse` second, so anything this
 * function returns is an instant the input actually named rather than one the
 * runtime inferred. `new Date()` and `Date.now()` are absent from this module by
 * construction and a test asserts their absence, because a single accidental
 * clock read would make every estimate depend on when it was computed rather
 * than on what it was given.
 */
function instant(value: string): number | null {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Is this a timezone the runtime can resolve?
 *
 * The locale is pinned rather than defaulted: `Intl.DateTimeFormat(undefined,
 * …)` consults the ambient locale, which is environment the rest of this
 * package refuses to read. With an explicit locale the call is a pure function
 * of the string and the runtime's zone database.
 *
 * What this checks is that the zone *names something*. It is metadata
 * validation, not arithmetic — see `resetCalendar` for why the instant does not
 * come from the zone.
 */
function resolvableTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next reset from the record's declared or observed schedule.
 *
 * **The instant comes from `nextResetAt`, not from the timezone.** That is
 * deliberate and worth stating, because the obvious alternative is wrong: to
 * derive a reset instant from a timezone one needs a recurrence rule — "weekly,
 * Mondays, 00:00 local" — and an `AccountRecord` carries no such rule. Deriving
 * one anyway would be inventing the schedule this function exists to report.
 * The timezone is validated and carried, so a caller rendering "resets Tuesday
 * morning" has the zone to render it in.
 *
 * Ambiguity is refused rather than smoothed:
 *
 * - `kind: "UNKNOWN"`, or a null `nextResetAt`, is `RESET_UNKNOWN`. The record
 *   is saying it does not know, and repeating that back as a date would be a
 *   fabrication.
 * - A reset already in the past is `RESET_ALREADY_PASSED`, **not** a rollover.
 *   Rolling forward needs a period, the record has none, and guessing "probably
 *   weekly" is exactly the guess this phase forbids. A stale schedule is a
 *   stale schedule and the caller should refresh it.
 */
export function resetCalendar(record: AccountRecord, now: string): ResetOutcome {
  const nowMs = instant(now);
  if (nowMs === null) return refuse("TIMESTAMP_INVALID", "now");

  const schedule = record.resetSchedule;
  if (schedule.kind === "UNKNOWN") {
    return refuse("RESET_UNKNOWN", "record.resetSchedule.kind");
  }
  if (schedule.nextResetAt === null) {
    return refuse("RESET_UNKNOWN", "record.resetSchedule.nextResetAt");
  }
  const resetMs = instant(schedule.nextResetAt);
  if (resetMs === null) {
    return refuse("TIMESTAMP_INVALID", "record.resetSchedule.nextResetAt");
  }
  if (!resolvableTimezone(schedule.timezone)) {
    return refuse("RESET_TIMEZONE_UNKNOWN", "record.resetSchedule.timezone");
  }
  if (resetMs < nowMs) {
    return refuse("RESET_ALREADY_PASSED", "record.resetSchedule.nextResetAt");
  }

  return {
    ok: true,
    calendar: Object.freeze({
      kind: schedule.kind,
      nextResetAt: schedule.nextResetAt,
      timezone: schedule.timezone,
      millisUntilReset: resetMs - nowMs,
      confidence: schedule.confidence,
    }),
  };
}

/**
 * The confidence the evidence itself can support, and why it is capped.
 *
 * `HIGH` is unreachable from this module in P5, and that is a statement about
 * the evidence rather than a gap in the arithmetic. A ratio is only a
 * measurement if the usage summed covers the whole window it is measured
 * against — which needs a window *start*, and an `AccountRecord` carries only
 * the window's end. So the caller's observations cover some suffix of the
 * window, of unknown length, and `MEDIUM` is the honest ceiling.
 *
 * This is the same posture ADR 0010 took for provider capabilities: the
 * machinery for the stronger claim ships, and nothing in this phase is allowed
 * to make it. Confirming a window start needs a reset *period*, which is a
 * contract question and not P5B's.
 */
function evidenceConfidence(observationCount: number): ConfidenceLevel {
  return observationCount === 0 ? "LOW" : "MEDIUM";
}

/**
 * Estimate what fraction of an account's quota remains.
 *
 * **What the caller owes.** `observations` are already scoped: this function
 * sums what it is given and refuses anything incoherent, but it cannot filter
 * to "this window" because it does not know when the window began. The
 * confidence it returns accounts for that; see `evidenceConfidence`.
 *
 * **The refusal inputs, which are binding.** A record whose `status` is not
 * `AVAILABLE` is refused: draining, exhausted, cooling down and awaiting
 * reauthentication are four different reasons not to route work to an account,
 * and none of them is a reason to compute how much quota it has. A record whose
 * own `quotaEstimate.remainingRatio` is `null` is refused too — the owner is
 * saying the figure is unknown, and an estimator that answered anyway would be
 * manufacturing the confidence the record declined to express. Neither case
 * returns a number with a caveat, because a caveat is the thing a caller
 * skips.
 *
 * **The clamp is reported, not hidden.** Usage past the limit yields a ratio of
 * zero rather than a negative one, and `overBudget` says so, so a caller can
 * tell "exactly empty" from "went over".
 */
export function estimateQuota(input: QuotaEstimateInput): QuotaOutcome {
  const { record, observations, limitKey, now } = input;

  if (record.status !== "AVAILABLE") {
    return refuse("ACCOUNT_NOT_AVAILABLE", "record.status");
  }
  if (record.quotaEstimate.remainingRatio === null) {
    return refuse("ACCOUNT_QUOTA_UNPUBLISHED", "record.quotaEstimate.remainingRatio");
  }

  const reset = resetCalendar(record, now);
  if (!reset.ok) return reset;

  // `Object.hasOwn` rather than a bare lookup: `knownLimits` is a free-key map,
  // so `limitKey: "toString"` would otherwise reach an inherited member and be
  // treated as a limit. The same lesson the registry's `Map` lookup encodes.
  if (!Object.hasOwn(record.knownLimits, limitKey)) {
    return refuse("LIMIT_UNKNOWN", "record.knownLimits." + limitKey);
  }
  const limitTokens = record.knownLimits[limitKey];
  if (typeof limitTokens !== "number" || !Number.isFinite(limitTokens)) {
    return refuse("LIMIT_UNKNOWN", "record.knownLimits." + limitKey);
  }
  if (limitTokens <= 0) {
    // A limit of zero has no ratio: every usage divides by nothing. Refusing is
    // the only answer that is not either 0 or 1 chosen arbitrarily.
    return refuse("LIMIT_NOT_POSITIVE", "record.knownLimits." + limitKey);
  }

  const nowMs = instant(now);
  if (nowMs === null) return refuse("TIMESTAMP_INVALID", "now");

  if (observations.length > OBSERVATIONS_MAX) {
    return refuse("OBSERVATION_COUNT_EXCEEDED", "observations");
  }

  let used = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const at = "observations[" + String(index) + "]";
    const observation = observations[index];
    if (observation === undefined) return refuse("OBSERVATION_INVALID", at);

    const tokens = observation.tokensUsed;
    // `isSafeInteger`, not `isInteger`: beyond 2^53 the integers are no longer
    // consecutive, so `isInteger` is true of values that cannot be added
    // without silently losing the difference. A count that cannot be summed
    // exactly is not evidence.
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      return refuse("OBSERVATION_INVALID", at + ".tokensUsed");
    }
    // Bounded by the same ceiling the rest of this repository uses. A count
    // above it is not a large session; it is a ledger read that went wrong, and
    // treating it as evidence would let one bad row zero out an account's
    // remaining quota.
    if (tokens > TOKENS_USED_MAX) {
      return refuse("OBSERVATION_OUT_OF_RANGE", at + ".tokensUsed");
    }
    const observedMs = instant(observation.observedAt);
    if (observedMs === null) {
      return refuse("OBSERVATION_INVALID", at + ".observedAt");
    }
    // An observation from after the current instant is not evidence about the
    // present; it is a caller mistake, and summing it would quietly understate
    // the remaining ratio for a window that has not happened.
    if (observedMs > nowMs) {
      return refuse("OBSERVATION_IN_FUTURE", at + ".observedAt");
    }
    // There is deliberately no third gate for "after the reset". A first draft
    // had one, and it was unreachable: `resetCalendar` has already refused
    // unless `now <= reset`, and the line above has already refused unless
    // `observed <= now`, so `observed <= now <= reset` holds for every
    // observation that gets here. A refusal nothing can trigger is worse than
    // no refusal — it pads a closed vocabulary with a code that can never
    // appear and invites a reader to believe a check is doing work.
    // Checked accumulation. With the per-item ceiling and the count bound above
    // this is unreachable — 100_000 × 10^7 is three orders of magnitude below
    // the safe-integer limit — and it is here anyway, because "unreachable
    // given two other bounds" is a property that quietly stops holding when one
    // of those bounds is relaxed by someone who did not know it was load
    // bearing. The test proves the arithmetic; this proves the arithmetic is
    // still being relied on deliberately.
    if (used + tokens > Number.MAX_SAFE_INTEGER) {
      return refuse("OBSERVATION_SUM_UNSAFE", at + ".tokensUsed");
    }
    used += tokens;
  }

  const remaining = Math.max(0, limitTokens - used);
  const confidence = weakerConfidence(
    reset.calendar.confidence,
    evidenceConfidence(observations.length),
  );

  return {
    ok: true,
    estimate: Object.freeze({
      accountId: record.accountId,
      limitKey,
      limitTokens,
      observedTokensUsed: used,
      observationCount: observations.length,
      remainingRatio: remaining / limitTokens,
      estimatedTokensRemaining: remaining,
      overBudget: used > limitTokens,
      confidence,
      estimatedAt: now,
      reset: reset.calendar,
    }),
  };
}
