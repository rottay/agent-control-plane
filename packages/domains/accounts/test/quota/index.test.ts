import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AccountRecord, CONTRACT_VERSION } from "@acp/contracts";

import {
  CONFIDENCE_ORDER,
  OBSERVATIONS_MAX,
  QUOTA_REFUSALS,
  TOKENS_USED_MAX,
  estimateQuota,
  resetCalendar,
  weakerConfidence,
} from "../../src/quota/index.js";
import type { QuotaOutcome, QuotaRefused, ResetOutcome, TokenObservation } from "../../src/quota/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");

/**
 * Every instant in this file is a literal.
 *
 * Not one test reads a clock, so a boundary case sits exactly on the boundary
 * and stays there. `NOW` is the injected present; the reset is one hour later,
 * which makes "just before", "exactly at" and "just after" all expressible
 * without arithmetic on a moving target.
 */
const NOW = "2026-08-28T12:00:00Z";
const RESET = "2026-08-28T13:00:00Z";
const HOUR_MS = 3_600_000;

type Overrides = Readonly<Record<string, unknown>>;

function record(overrides: Overrides = {}): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId: "acct-primary",
    provider: "anthropic",
    alias: "primary",
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-drill-primary",
    credentialRef: null,
    plan: "max",
    enabledModels: ["opus"],
    knownLimits: { weekly: 1_000 },
    resetSchedule: {
      kind: "DECLARED",
      nextResetAt: RESET,
      timezone: "UTC",
      confidence: "HIGH",
    },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500,
      estimatedAt: NOW,
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-p5b-isolated-root",
    contextSwitchCost: { estimatedTokens: 100, estimatedSeconds: 5 },
    ...overrides,
  });
  if (!parsed.success) {
    throw new Error("fixture is not a valid AccountRecord");
  }
  return parsed.data;
}

function observed(tokensUsed: number, observedAt = NOW): TokenObservation {
  return { tokensUsed, observedAt };
}

function refusal(outcome: QuotaOutcome | ResetOutcome): QuotaRefused {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

function estimate(
  overrides: Overrides = {},
  observations: readonly TokenObservation[] = [observed(250)],
  limitKey = "weekly",
  now = NOW,
): QuotaOutcome {
  return estimateQuota({ record: record(overrides), observations, limitKey, now });
}

describe("the reset calendar reports a schedule or refuses to invent one", () => {
  it("computes the interval to a declared reset", () => {
    const outcome = resetCalendar(record(), NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.calendar).toEqual({
      kind: "DECLARED",
      nextResetAt: RESET,
      timezone: "UTC",
      millisUntilReset: HOUR_MS,
      confidence: "HIGH",
    });
  });

  it("carries an observed schedule with its own kind", () => {
    const outcome = resetCalendar(
      record({
        resetSchedule: { kind: "OBSERVED", nextResetAt: RESET, timezone: "UTC", confidence: "LOW" },
      }),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect({ kind: outcome.calendar.kind, confidence: outcome.calendar.confidence }).toEqual({
      kind: "OBSERVED",
      confidence: "LOW",
    });
  });

  it("refuses an unknown schedule rather than picking a date", () => {
    const unknownKind = resetCalendar(
      record({
        resetSchedule: { kind: "UNKNOWN", nextResetAt: null, timezone: "UTC", confidence: "LOW" },
      }),
      NOW,
    );
    expect(refusal(unknownKind)).toEqual({
      ok: false,
      reason: "RESET_UNKNOWN",
      at: "record.resetSchedule.kind",
    });

    const noInstant = resetCalendar(
      record({
        resetSchedule: { kind: "DECLARED", nextResetAt: null, timezone: "UTC", confidence: "LOW" },
      }),
      NOW,
    );
    expect(refusal(noInstant)).toEqual({
      ok: false,
      reason: "RESET_UNKNOWN",
      at: "record.resetSchedule.nextResetAt",
    });
  });

  it("refuses a reset already in the past rather than rolling it forward", () => {
    // Rolling forward would need a period the record does not carry, and
    // "probably weekly" is exactly the guess this phase forbids.
    const outcome = resetCalendar(record(), "2026-08-28T13:00:00.001Z");
    expect(refusal(outcome)).toEqual({
      ok: false,
      reason: "RESET_ALREADY_PASSED",
      at: "record.resetSchedule.nextResetAt",
    });
  });

  it("admits the reset instant itself, and refuses one millisecond later", () => {
    const atReset = resetCalendar(record(), RESET);
    expect(atReset.ok).toBe(true);
    if (atReset.ok) expect(atReset.calendar.millisUntilReset).toBe(0);

    const past = resetCalendar(record(), "2026-08-28T13:00:00.001Z");
    expect(refusal(past).reason).toBe("RESET_ALREADY_PASSED");
  });

  it("refuses a timezone the runtime cannot resolve", () => {
    const outcome = resetCalendar(record({
      resetSchedule: {
        kind: "DECLARED",
        nextResetAt: RESET,
        timezone: "Mars/Olympus_Mons",
        confidence: "HIGH",
      },
    }), NOW);
    expect(refusal(outcome)).toEqual({
      ok: false,
      reason: "RESET_TIMEZONE_UNKNOWN",
      at: "record.resetSchedule.timezone",
    });
  });

  it("accepts a real zone that is not UTC, and does not use it for the instant", () => {
    // The instant comes from the offset-bearing timestamp. The zone is metadata
    // a caller renders with; changing it must not move the interval.
    const outcome = resetCalendar(
      record({
        resetSchedule: {
          kind: "DECLARED",
          nextResetAt: RESET,
          timezone: "America/New_York",
          confidence: "HIGH",
        },
      }),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.calendar.millisUntilReset).toBe(HOUR_MS);
    expect(outcome.calendar.timezone).toBe("America/New_York");
  });

  it("refuses an unparseable injected instant", () => {
    expect(refusal(resetCalendar(record(), "not a timestamp"))).toEqual({
      ok: false,
      reason: "TIMESTAMP_INVALID",
      at: "now",
    });
  });
});

describe("an instant must name its own offset", () => {
  /** Shapes this module must refuse. Every one carries no usable offset, or is not ISO. */
  const REFUSED_SHAPES: readonly (readonly [string, string])[] = [
    ["date only", "2026-08-28"],
    ["local time, no offset", "2026-08-28T12:00:00"],
    ["local time with millis, no offset", "2026-08-28T12:00:00.000"],
    ["minute precision, no offset", "2026-08-28T12:00"],
    ["fraction without seconds", "2026-08-28T12:00.123Z"],
    ["space separator", "2026-08-28 12:00:00Z"],
    ["bare offset digits", "2026-08-28T12:00:00+0000"],
    ["lowercase zulu", "2026-08-28t12:00:00z"],
    ["RFC 1123", "Fri, 28 Aug 2026 12:00:00 GMT"],
    ["epoch millis as text", "1787918400000"],
    // Calendar-invalid, and both are shapes `Date.parse` happily accepts:
    // it rolls February 30th into March and reads 24:00:00 as the next
    // midnight. The contract refuses both, so this module must too.
    ["day past the end of the month", "2026-02-30T12:00:00Z"],
    ["hour 24", "2026-08-28T24:00:00Z"],
    ["empty", ""],
  ];

  it("refuses every shape that would depend on the ambient zone or is not ISO", () => {
    // The dangerous member of this list is "local time, no offset": it parses,
    // it yields a plausible number, and the number differs by hours depending
    // on where the process runs. An estimate computed in Madrid and one
    // computed in New York would disagree from byte-identical inputs.
    for (const [label, value] of REFUSED_SHAPES) {
      expect({ label, reason: refusal(resetCalendar(record(), value)).reason }).toEqual({
        label,
        reason: "TIMESTAMP_INVALID",
      });
    }
  });

  it("refuses every one of them as an observation instant", () => {
    // `observedAt` is where this grammar earns its keep. `now` and `observedAt`
    // are plain strings on this module's own interfaces — no contract validates
    // them — so without the check a local-time string would be read against
    // whatever zone the process happened to be in.
    for (const [label, value] of REFUSED_SHAPES) {
      expect({ label, refusal: refusal(estimate({}, [observed(1, value)])) }).toEqual({
        label,
        refusal: {
          ok: false,
          reason: "OBSERVATION_INVALID",
          at: "observations[0].observedAt",
        },
      });
    }
  });

  /** Minute precision: the contract admits it, so this module must too. */
  const MINUTE_PRECISION = "2026-08-28T12:00Z";

  it("agrees with the contract on every one of them", () => {
    // The grammar is deliberately the subset `Timestamp` already admits. A
    // validator downstream of a validator that disagrees with it is how a
    // boundary starts rejecting conforming data, so this asserts the two never
    // disagree on the refused shapes.
    for (const [label, value] of REFUSED_SHAPES) {
      if (value === "") continue;
      const parsed = AccountRecord.safeParse({
        ...record(),
        resetSchedule: {
          kind: "DECLARED",
          nextResetAt: value,
          timezone: "UTC",
          confidence: "HIGH",
        },
      });
      expect({ label, contractAccepted: parsed.success }).toEqual({
        label,
        contractAccepted: false,
      });
    }
  });

  it("accepts minute precision, which the contract admits", () => {
    // An earlier draft of this grammar required seconds, and the effect was
    // that a record the contract called valid was refused here. It is accepted
    // now — as `now`, as an observation instant, and inside a record that the
    // contract itself validates first.
    expect(
      AccountRecord.safeParse({
        ...record(),
        resetSchedule: {
          kind: "DECLARED",
          nextResetAt: MINUTE_PRECISION,
          timezone: "UTC",
          confidence: "HIGH",
        },
      }).success,
    ).toBe(true);

    const asNow = resetCalendar(record(), MINUTE_PRECISION);
    expect(asNow.ok).toBe(true);
    if (asNow.ok) expect(asNow.calendar.millisUntilReset).toBe(HOUR_MS);

    const asObservation = estimate({}, [observed(10, MINUTE_PRECISION)]);
    expect(asObservation.ok).toBe(true);
    if (asObservation.ok) expect(asObservation.estimate.observedTokensUsed).toBe(10);

    const scheduled = record({
      resetSchedule: {
        kind: "DECLARED",
        nextResetAt: MINUTE_PRECISION,
        timezone: "UTC",
        confidence: "HIGH",
      },
    });
    const outcome = resetCalendar(scheduled, "2026-08-28T11:00:00Z");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.calendar.millisUntilReset).toBe(HOUR_MS);
  });

  it("reads minute precision as the same instant however its offset is spelled", () => {
    // The determinism half: three spellings of noon UTC at minute precision,
    // one interval.
    const intervals = ["2026-08-28T12:00Z", "2026-08-28T14:00+02:00", "2026-08-28T07:00-05:00"].map(
      (value) => {
        const outcome = resetCalendar(record(), value);
        expect({ value, ok: outcome.ok }).toEqual({ value, ok: true });
        return outcome.ok ? outcome.calendar.millisUntilReset : null;
      },
    );
    expect(intervals).toEqual([HOUR_MS, HOUR_MS, HOUR_MS]);
  });

  it("admits every legal offset notation, and reads them as the same instant", () => {
    // The cross-timezone proof. Four spellings of one instant, and the interval
    // to the reset is identical for all of them — because admission no longer
    // depends on the ambient zone at all.
    const sameInstant = [
      "2026-08-28T12:00:00Z",
      "2026-08-28T12:00:00.000Z",
      "2026-08-28T14:00:00+02:00",
      "2026-08-28T07:00:00-05:00",
    ];
    const intervals = sameInstant.map((value) => {
      const outcome = resetCalendar(record(), value);
      expect({ value, ok: outcome.ok }).toEqual({ value, ok: true });
      return outcome.ok ? outcome.calendar.millisUntilReset : null;
    });
    expect(intervals).toEqual([HOUR_MS, HOUR_MS, HOUR_MS, HOUR_MS]);
  });

  it("admits fractional seconds of any length", () => {
    for (const value of ["2026-08-28T12:00:00.5Z", "2026-08-28T12:00:00.123456Z"]) {
      const outcome = resetCalendar(record(), value);
      expect({ value, ok: outcome.ok }).toEqual({ value, ok: true });
    }
  });
});

describe("an estimate is produced, or classified — never defaulted", () => {
  it("measures usage against the named limit", () => {
    const outcome = estimate({}, [observed(250), observed(150)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.estimate).toEqual({
      accountId: "acct-primary",
      limitKey: "weekly",
      limitTokens: 1_000,
      observedTokensUsed: 400,
      observationCount: 2,
      remainingRatio: 0.6,
      estimatedTokensRemaining: 600,
      overBudget: false,
      confidence: "MEDIUM",
      estimatedAt: NOW,
      reset: {
        kind: "DECLARED",
        nextResetAt: RESET,
        timezone: "UTC",
        millisUntilReset: HOUR_MS,
        confidence: "HIGH",
      },
    });
  });

  it("reports a full ratio when nothing has been used", () => {
    const outcome = estimate({}, []);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.estimate.remainingRatio).toBe(1);
    expect(outcome.estimate.estimatedTokensRemaining).toBe(1_000);
    // No observations is the weakest evidence there is, and it says so.
    expect(outcome.estimate.confidence).toBe("LOW");
  });

  it("clamps an overrun to zero and says that it clamped", () => {
    const outcome = estimate({}, [observed(1_400)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Not −0.4: a negative remainder is not a quantity anyone can act on. But
    // the caller can still tell "exactly empty" from "went over".
    expect(outcome.estimate.remainingRatio).toBe(0);
    expect(outcome.estimate.estimatedTokensRemaining).toBe(0);
    expect(outcome.estimate.overBudget).toBe(true);
  });

  it("distinguishes exactly empty from over budget", () => {
    const exact = estimate({}, [observed(1_000)]);
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect({ ratio: exact.estimate.remainingRatio, over: exact.estimate.overBudget }).toEqual({
      ratio: 0,
      over: false,
    });
  });

  it("refuses every account status that is not AVAILABLE", () => {
    for (const status of ["DRAINING", "EXHAUSTED", "COOLDOWN"]) {
      const outcome = estimate({ status });
      expect({ status, refusal: refusal(outcome) }).toEqual({
        status,
        refusal: { ok: false, reason: "ACCOUNT_NOT_AVAILABLE", at: "record.status" },
      });
    }
  });

  it("refuses an account awaiting reauthentication", () => {
    // The contract forbids such a record from publishing a ratio at all, so
    // this is the status gate catching it before the unpublished gate would.
    const outcome = estimate({
      status: "AUTH_REQUIRED",
      quotaEstimate: {
        remainingRatio: null,
        estimatedTokensRemaining: null,
        estimatedAt: NOW,
        confidence: "LOW",
      },
    });
    expect(refusal(outcome).reason).toBe("ACCOUNT_NOT_AVAILABLE");
  });

  it("refuses a record that publishes no ratio of its own", () => {
    // The owner is saying the figure is unknown. Answering anyway would
    // manufacture the confidence the record declined to express.
    const outcome = estimate({
      quotaEstimate: {
        remainingRatio: null,
        estimatedTokensRemaining: null,
        estimatedAt: NOW,
        confidence: "LOW",
      },
    });
    expect(refusal(outcome)).toEqual({
      ok: false,
      reason: "ACCOUNT_QUOTA_UNPUBLISHED",
      at: "record.quotaEstimate.remainingRatio",
    });
  });

  it("refuses a limit it was not given", () => {
    expect(refusal(estimate({}, [observed(1)], "monthly"))).toEqual({
      ok: false,
      reason: "LIMIT_UNKNOWN",
      at: "record.knownLimits.monthly",
    });
  });

  it("refuses a limit key that names an inherited member", () => {
    // `knownLimits` is a free-key map, so a bare lookup would answer
    // `toString` with a function and treat it as a budget.
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect({ key, reason: refusal(estimate({}, [observed(1)], key)).reason }).toEqual({
        key,
        reason: "LIMIT_UNKNOWN",
      });
    }
  });

  it("refuses a limit of zero rather than choosing a ratio", () => {
    const outcome = estimate({ knownLimits: { weekly: 0 } }, [observed(0)]);
    expect(refusal(outcome)).toEqual({
      ok: false,
      reason: "LIMIT_NOT_POSITIVE",
      at: "record.knownLimits.weekly",
    });
  });

  it("propagates the reset refusal rather than estimating around it", () => {
    const outcome = estimate({
      resetSchedule: { kind: "UNKNOWN", nextResetAt: null, timezone: "UTC", confidence: "LOW" },
    });
    expect(refusal(outcome).reason).toBe("RESET_UNKNOWN");
  });
});

describe("the evidence has to hold together", () => {
  it("refuses a non-integer, negative or unsafe token count", () => {
    // `isSafeInteger` rather than `isInteger`: beyond 2^53 the integers stop
    // being consecutive, so `isInteger` is true of values that cannot be added
    // without losing the difference.
    const unsafe = Number.MAX_SAFE_INTEGER + 2;
    expect(Number.isInteger(unsafe)).toBe(true);
    for (const tokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, unsafe]) {
      const outcome = estimate({}, [observed(tokens)]);
      expect({ tokens: String(tokens), refusal: refusal(outcome) }).toEqual({
        tokens: String(tokens),
        refusal: {
          ok: false,
          reason: "OBSERVATION_INVALID",
          at: "observations[0].tokensUsed",
        },
      });
    }
  });

  it("admits the budget ceiling and refuses one token past it", () => {
    const atCeiling = estimate({ knownLimits: { weekly: TOKENS_USED_MAX } }, [
      observed(TOKENS_USED_MAX),
    ]);
    expect(atCeiling.ok).toBe(true);

    const past = estimate({}, [observed(TOKENS_USED_MAX + 1)]);
    expect(refusal(past)).toEqual({
      ok: false,
      reason: "OBSERVATION_OUT_OF_RANGE",
      at: "observations[0].tokensUsed",
    });
  });

  it("refuses more observations than one estimate may be built from", () => {
    const atBound = Array.from({ length: OBSERVATIONS_MAX }, () => observed(0));
    expect(estimate({}, atBound).ok).toBe(true);

    const past = [...atBound, observed(0)];
    expect(refusal(estimate({}, past))).toEqual({
      ok: false,
      reason: "OBSERVATION_COUNT_EXCEEDED",
      at: "observations",
    });
  });

  it("proves the accumulation guard is unreachable, and that it is still there", () => {
    // Two bounds make an arithmetic proof: every observation is capped at
    // TOKENS_USED_MAX and there are at most OBSERVATIONS_MAX of them, so the
    // largest sum this module can be asked to compute is three orders of
    // magnitude below the safe-integer limit.
    const largestPossibleSum = OBSERVATIONS_MAX * TOKENS_USED_MAX;
    expect(largestPossibleSum).toBe(1e12);
    expect(largestPossibleSum).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(largestPossibleSum)).toBe(true);

    // So `OBSERVATION_SUM_UNSAFE` cannot be produced through the public API,
    // and this asserts the guard exists rather than that it fires. It is
    // deliberate defence in depth: "unreachable given two other bounds" is a
    // property that stops holding the moment someone relaxes one of them
    // without knowing it was load bearing. That is a different thing from the
    // unreachable branch removed during this packet, which was guarding a case
    // the ordering already made impossible and documented nothing.
    const source = readFileSync(join(HERE, "..", "..", "src", "quota", "index.ts"), "utf8");
    expect(source).toContain("used + tokens > Number.MAX_SAFE_INTEGER");
    expect(QUOTA_REFUSALS).toContain("OBSERVATION_SUM_UNSAFE");
  });

  it("sums a long run exactly", () => {
    // 50_000 observations of 100 tokens each. If the accumulator were lossy
    // this is where it would show.
    const many = Array.from({ length: 50_000 }, () => observed(100));
    const outcome = estimate({ knownLimits: { weekly: 10_000_000 } }, many);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.estimate.observedTokensUsed).toBe(5_000_000);
    expect(outcome.estimate.remainingRatio).toBe(0.5);
  });

  it("refuses an unparseable observation instant", () => {
    const outcome = estimate({}, [observed(1, "yesterday")]);
    expect(refusal(outcome)).toEqual({
      ok: false,
      reason: "OBSERVATION_INVALID",
      at: "observations[0].observedAt",
    });
  });

  it("refuses an observation from the future", () => {
    const outcome = estimate({}, [observed(1), observed(1, "2026-08-28T12:00:00.001Z")]);
    expect(refusal(outcome)).toEqual({
      ok: false,
      reason: "OBSERVATION_IN_FUTURE",
      at: "observations[1].observedAt",
    });
  });

  it("needs no separate gate for an observation after the reset", () => {
    // A first draft of this module carried one, and it was unreachable: the
    // reset gate refuses unless `now <= reset`, and the future gate refuses
    // unless `observed <= now`, so every observation that survives satisfies
    // `observed <= now <= reset`. This test proves the implication rather than
    // asserting a branch that cannot run.
    //
    // Two ways to try to construct the case, and each is caught by one of the
    // two gates that do exist.
    const resetPassed = estimate(
      {},
      [observed(1, "2026-08-28T14:00:00Z")],
      "weekly",
      "2026-08-28T15:00:00Z",
    );
    expect(refusal(resetPassed).reason).toBe("RESET_ALREADY_PASSED");

    const observationAhead = estimateQuota({
      record: record({
        resetSchedule: {
          kind: "DECLARED",
          nextResetAt: "2026-08-28T13:00:00Z",
          timezone: "UTC",
          confidence: "HIGH",
        },
      }),
      observations: [observed(1, "2026-08-28T12:30:00Z")],
      limitKey: "weekly",
      now: NOW,
    });
    expect(refusal(observationAhead).reason).toBe("OBSERVATION_IN_FUTURE");
  });

  it("admits an observation exactly at the current instant", () => {
    const outcome = estimate({}, [observed(10, NOW)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.estimate.observedTokensUsed).toBe(10);
  });

  it("names the offending observation by index, and carries no value", () => {
    const outcome = estimate({}, [observed(1), observed(2), observed(-3)]);
    const refused = refusal(outcome);
    expect(refused.at).toBe("observations[2].tokensUsed");
    expect(JSON.stringify(refused)).not.toContain("-3");
  });
});

describe("confidence is propagated, never improved", () => {
  it("orders confidence weakest first and returns the weaker of two", () => {
    expect([...CONFIDENCE_ORDER]).toEqual(["LOW", "MEDIUM", "HIGH"]);
    expect(weakerConfidence("HIGH", "LOW")).toBe("LOW");
    expect(weakerConfidence("LOW", "HIGH")).toBe("LOW");
    expect(weakerConfidence("MEDIUM", "HIGH")).toBe("MEDIUM");
    expect(weakerConfidence("MEDIUM", "MEDIUM")).toBe("MEDIUM");
  });

  it("takes the weaker of the schedule's confidence and the evidence's", () => {
    const cases: readonly (readonly [string, number, string])[] = [
      ["HIGH", 1, "MEDIUM"],
      ["MEDIUM", 1, "MEDIUM"],
      ["LOW", 1, "LOW"],
      ["HIGH", 0, "LOW"],
      ["LOW", 0, "LOW"],
    ];
    for (const [scheduleConfidence, observationCount, expected] of cases) {
      const outcome = estimate(
        {
          resetSchedule: {
            kind: "DECLARED",
            nextResetAt: RESET,
            timezone: "UTC",
            confidence: scheduleConfidence,
          },
        },
        observationCount === 0 ? [] : [observed(1)],
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect({ scheduleConfidence, observationCount, got: outcome.estimate.confidence }).toEqual({
        scheduleConfidence,
        observationCount,
        got: expected,
      });
    }
  });

  it("never reports HIGH, because no window start is knowable here", () => {
    // Stated as a test rather than a comment: an `AccountRecord` carries the
    // window's end and not its start, so observations cover a suffix of unknown
    // length and MEDIUM is the honest ceiling. Confirming a start needs a reset
    // period, which is a contract question and not this packet's.
    for (const count of [0, 1, 5, 50]) {
      const outcome = estimate({}, Array.from({ length: count }, () => observed(1)));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect({ count, high: outcome.estimate.confidence === "HIGH" }).toEqual({
        count,
        high: false,
      });
    }
  });
});

describe("the module is pure, and stays that way", () => {
  const source = readFileSync(join(HERE, "..", "..", "src", "quota", "index.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("reads no clock", () => {
    // The one law the whole module rests on. `Date.parse` is arithmetic on a
    // string the caller supplied; `Date.now()` and `new Date()` are the present,
    // and either would make an estimate depend on when it was computed.
    for (const token of ["Date.now", "new Date(", "performance.now", "hrtime"]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("reads no environment and touches no filesystem or ledger", () => {
    for (const token of ["process.env", "node:fs", "readFileSync", ["@acp", "ledger"].join("/"), ".append("]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("declares a closed, sorted refusal set", () => {
    expect(Object.isFrozen(QUOTA_REFUSALS)).toBe(true);
    expect([...QUOTA_REFUSALS]).toEqual([...QUOTA_REFUSALS].sort());
    expect(new Set(QUOTA_REFUSALS).size).toBe(QUOTA_REFUSALS.length);
  });

  it("returns frozen results", () => {
    const outcome = estimate();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.isFrozen(outcome.estimate)).toBe(true);
    expect(Object.isFrozen(outcome.estimate.reset)).toBe(true);
  });

  it("is deterministic across repeated identical calls", () => {
    const observations = [observed(10), observed(20, "2026-08-28T11:00:00Z")];
    const first = JSON.stringify(estimate({}, observations));
    for (let run = 0; run < 100; run += 1) {
      expect(JSON.stringify(estimate({}, observations))).toBe(first);
    }
    const refused = JSON.stringify(estimate({ status: "COOLDOWN" }));
    for (let run = 0; run < 100; run += 1) {
      expect(JSON.stringify(estimate({ status: "COOLDOWN" }))).toBe(refused);
    }
  });

  it("does not mutate what it is handed", () => {
    const observations = [observed(10), observed(20)];
    const before = JSON.stringify(observations);
    const subject = record();
    const recordBefore = JSON.stringify(subject);
    estimateQuota({ record: subject, observations, limitKey: "weekly", now: NOW });
    expect(JSON.stringify(observations)).toBe(before);
    expect(JSON.stringify(subject)).toBe(recordBefore);
  });
});
