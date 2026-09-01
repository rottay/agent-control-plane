import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AccountRecord, CONTRACT_VERSION } from "@acp/contracts";

import { estimateQuota } from "../../src/quota/index.js";
import type { QuotaOutcome } from "../../src/quota/index.js";
import type { QuotaEstimate } from "../../src/quota/index.js";
import {
  CANDIDATES_MAX,
  DEFAULT_ROUTING_CONFIG,
  EVIDENCE_ABSENT,
  ROUTING_REFUSALS,
  ROUTING_TERMS,
  rankAccounts,
} from "../../src/routing/index.js";
import type {
  CandidateEvidence,
  RoutingConfig,
  RoutingOutcome,
  RoutingRefused,
  TaskProfile,
} from "../../src/routing/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");

/** Every instant is a literal; nothing here reads a clock. */
const NOW = "2026-08-28T12:00:00Z";
const RESET = "2026-08-28T13:00:00Z";
const HOUR_MS = 3_600_000;

type Overrides = Readonly<Record<string, unknown>>;

function record(accountId: string, overrides: Overrides = {}): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId,
    provider: "anthropic",
    alias: accountId,
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-drill-" + accountId,
    credentialRef: null,
    plan: "max",
    enabledModels: ["opus", "sonnet"],
    knownLimits: { weekly: 1_000_000 },
    resetSchedule: {
      kind: "DECLARED",
      nextResetAt: RESET,
      timezone: "UTC",
      confidence: "HIGH",
    },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      estimatedAt: NOW,
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-p5c-" + accountId,
    contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
    ...overrides,
  });
  if (!parsed.success) throw new Error("fixture is not a valid AccountRecord");
  return parsed.data;
}

function estimate(accountId: string, overrides: Partial<QuotaEstimate> = {}): QuotaEstimate {
  return {
    accountId,
    limitKey: "weekly",
    limitTokens: 1_000_000,
    observedTokensUsed: 500_000,
    observationCount: 3,
    remainingRatio: 0.5,
    estimatedTokensRemaining: 500_000,
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
    ...overrides,
  };
}

function evidence(
  accountId: string,
  rate: number,
  affinity = rate,
  overrides: Partial<CandidateEvidence> = {},
): CandidateEvidence {
  return {
    accountId,
    acceptance: { known: true, rate, sampleSize: 50, confidence: "HIGH" },
    contextAffinity: { known: true, rate: affinity, sampleSize: 50, confidence: "HIGH" },
    capabilities: { known: true, provided: [] },
    ...overrides,
  };
}

/**
 * Evidence that declares ignorance explicitly, for every account named.
 *
 * There is no such thing as an omitted row any more: a caller that does not
 * know says so. This helper is what "no evidence" now looks like in a test.
 */
function absent(...accountIds: readonly string[]): readonly CandidateEvidence[] {
  return accountIds.map((accountId) => ({
    accountId,
    acceptance: EVIDENCE_ABSENT,
    contextAffinity: EVIDENCE_ABSENT,
    capabilities: { known: false } as const,
  }));
}

/** Wrap a successful estimate in the provenance wrapper the router now takes. */
function wrap(
  estimates: readonly QuotaEstimate[],
): readonly { readonly accountId: string; readonly outcome: QuotaOutcome }[] {
  return estimates.map((e) => ({ accountId: e.accountId, outcome: { ok: true, estimate: e } }));
}

function task(overrides: Partial<TaskProfile> = {}): TaskProfile {
  return {
    estimatedTokens: 10_000,
    estimatedDurationSeconds: 60,
    reserveTokens: 5_000,
    model: "opus",
    requiredCapabilities: [],
    ...overrides,
  };
}

function rank(
  records: readonly AccountRecord[],
  estimates: readonly QuotaEstimate[],
  candidateEvidence: readonly CandidateEvidence[] = absent(...records.map((r) => r.accountId)),
  profile: TaskProfile = task(),
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
): RoutingOutcome {
  return rankAccounts({
    records,
    estimates: wrap(estimates),
    evidence: candidateEvidence,
    task: profile,
    config,
    now: NOW,
  });
}

/** The unwrapped entry point, for the tests that drive the wrapper directly. */
function rankRaw(request: Parameters<typeof rankAccounts>[0]): RoutingOutcome {
  return rankAccounts(request);
}

function refusal(outcome: RoutingOutcome): RoutingRefused {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

describe("the router ranks what can take the task", () => {
  it("ranks a single eligible account with a full term breakdown", () => {
    const outcome = rank([record("a")], [estimate("a")], [evidence("a", 0.9)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { recommendation } = outcome;
    expect(recommendation.ranked).toHaveLength(1);
    expect(recommendation.rejected).toEqual([]);
    expect(recommendation.evaluatedAt).toBe(NOW);

    const top = recommendation.ranked[0];
    expect(top?.accountId).toBe("a");
    // Every term is named and bounded: a reader can see why, not just which.
    expect(Object.keys(top?.terms ?? {}).sort()).toEqual([...ROUTING_TERMS]);
    for (const term of ROUTING_TERMS) {
      const value = top?.terms[term] ?? -1;
      expect({ term, inRange: value >= 0 && value <= 1 }).toEqual({ term, inRange: true });
    }
    expect(top?.score).toBeGreaterThan(0);
    expect(top?.score).toBeLessThanOrEqual(1);
  });

  it("orders by score, best first", () => {
    const outcome = rank(
      [record("a"), record("b")],
      [estimate("a"), estimate("b")],
      [evidence("a", 0.2), evidence("b", 0.95)],
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.recommendation.ranked.map((entry) => entry.accountId)).toEqual(["b", "a"]);
  });

  it("ranks only the eligible account in a mixed set, and names every rejection", () => {
    const records = [
      record("available"),
      record("draining", { status: "DRAINING" }),
      record("unpublished", {
        quotaEstimate: {
          remainingRatio: null,
          estimatedTokensRemaining: null,
          estimatedAt: NOW,
          confidence: "LOW",
        },
      }),
      record("wrong-model", { enabledModels: ["haiku"] }),
      record("no-estimate"),
      record("thin", {}),
    ];
    const estimates = [
      estimate("available"),
      estimate("draining"),
      estimate("unpublished"),
      estimate("wrong-model"),
      // no estimate for "no-estimate"
      estimate("thin", { estimatedTokensRemaining: 100 }),
    ];
    const outcome = rank(records, estimates);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.recommendation.ranked.map((e) => e.accountId)).toEqual(["available"]);
    expect(
      outcome.recommendation.rejected.map((r) => [r.accountId, r.reason] as const),
    ).toEqual([
      ["draining", "ACCOUNT_NOT_AVAILABLE"],
      ["no-estimate", "ESTIMATE_MISSING"],
      ["thin", "INSUFFICIENT_TOKEN_MARGIN"],
      ["unpublished", "ACCOUNT_QUOTA_UNPUBLISHED"],
      ["wrong-model", "MODEL_NOT_ENABLED"],
    ]);
  });

  it("reports the long-packet flag from the configured threshold", () => {
    const short = rank([record("a")], [estimate("a")], absent("a"), task({ estimatedTokens: 10_000 }));
    expect(short.ok && short.recommendation.longPacket).toBe(false);

    const long = rank([record("a")], [estimate("a")], absent("a"), task({ estimatedTokens: 100_000 }));
    expect(long.ok && long.recommendation.longPacket).toBe(true);
    expect(long.ok && long.recommendation.ranked[0]?.reasons).toContain("LONG_PACKET");
  });
});

describe("a missing margin is a refusal, not a low score", () => {
  it("admits an account with exactly enough and refuses one token less", () => {
    // estimatedTokens 10_000 + reserve 5_000 + switch 1_000 = 16_000 exactly.
    const exact = rank([record("a")], [estimate("a", { estimatedTokensRemaining: 16_000 })]);
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.recommendation.ranked[0]?.reasons).toContain("MARGIN_EXACT");
      // Exactly enough leaves no daylight, so the margin term is zero.
      expect(exact.recommendation.ranked[0]?.terms.reserveMargin).toBe(0);
    }

    const short = rank([record("a")], [estimate("a", { estimatedTokensRemaining: 15_999 })]);
    expect(refusal(short).rejected).toEqual([
      { accountId: "a", reason: "INSUFFICIENT_TOKEN_MARGIN", at: "records.a" },
    ]);
  });

  it("counts the switch cost in the token margin, not just the task", () => {
    // 15_000 covers the task and reserve but not the 1_000-token switch.
    const outcome = rank([record("a")], [estimate("a", { estimatedTokensRemaining: 15_000 })]);
    expect(refusal(outcome).rejected[0]?.reason).toBe("INSUFFICIENT_TOKEN_MARGIN");

    // The same account with no switch cost fits.
    const cheap = rank(
      [record("a", { contextSwitchCost: { estimatedTokens: 0, estimatedSeconds: 0 } })],
      [estimate("a", { estimatedTokensRemaining: 15_000 })],
    );
    expect(cheap.ok).toBe(true);
  });

  it("admits a time margin at the exact reset instant and refuses one millisecond less", () => {
    // duration 60s + switch 10s = 70_000 ms.
    const exact = rank(
      [record("a")],
      [estimate("a", { reset: { ...estimate("a").reset, millisUntilReset: 70_000 } })],
    );
    expect(exact.ok).toBe(true);

    const short = rank(
      [record("a")],
      [estimate("a", { reset: { ...estimate("a").reset, millisUntilReset: 69_999 } })],
    );
    expect(refusal(short).rejected[0]?.reason).toBe("INSUFFICIENT_TIME_MARGIN");
  });

  it("never uses remainingRatio as a token budget", () => {
    // A generous ratio over a tiny limit: the ratio says "half left", the count
    // says the task does not fit. The count wins, because a proportion is not a
    // quantity.
    const outcome = rank(
      [record("a")],
      [estimate("a", { remainingRatio: 0.5, limitTokens: 100, estimatedTokensRemaining: 50 })],
    );
    expect(refusal(outcome).rejected[0]?.reason).toBe("INSUFFICIENT_TOKEN_MARGIN");
  });

  it("refuses the whole request when nothing is eligible, carrying the reasons", () => {
    const outcome = rank(
      [record("a", { status: "EXHAUSTED" }), record("b", { status: "COOLDOWN" })],
      [estimate("a"), estimate("b")],
    );
    const refused = refusal(outcome);
    expect(refused.reason).toBe("NO_ELIGIBLE_ACCOUNT");
    expect(refused.at).toBe("records");
    // An empty list would send a caller to a fallback; a refusal makes it read.
    expect(refused.rejected.map((r) => r.accountId)).toEqual(["a", "b"]);
  });
});

describe("one quota authority, and a total join", () => {
  it("scores from the fresh estimate, not the record's declared metadata", () => {
    // The record advertises plenty; the fresh estimate says otherwise. The
    // fresh one decides.
    const outcome = rank(
      [record("a", {
        quotaEstimate: {
          remainingRatio: 0.99,
          estimatedTokensRemaining: 990_000,
          estimatedAt: NOW,
          confidence: "HIGH",
        },
      })],
      [estimate("a", { estimatedTokensRemaining: 1_000 })],
    );
    expect(refusal(outcome).rejected[0]?.reason).toBe("INSUFFICIENT_TOKEN_MARGIN");
  });

  it("refuses a duplicate account id", () => {
    const outcome = rank([record("a"), record("a")], [estimate("a")]);
    expect(refusal(outcome)).toMatchObject({
      reason: "DUPLICATE_ACCOUNT_ID",
      at: "records[1].accountId",
    });
  });

  it("refuses a duplicate estimate", () => {
    const outcome = rank([record("a")], [estimate("a"), estimate("a")]);
    expect(refusal(outcome)).toMatchObject({
      reason: "DUPLICATE_ESTIMATE",
      at: "estimates[1].accountId",
    });
  });

  it("refuses an estimate for an account that was not offered", () => {
    const outcome = rank([record("a")], [estimate("a"), estimate("ghost")]);
    expect(refusal(outcome)).toMatchObject({
      reason: "ORPHAN_ESTIMATE",
      at: "estimates[1].accountId",
    });
  });

  it("lets one account's missing estimate stand while the others rank", () => {
    const outcome = rank([record("a"), record("b")], [estimate("b")]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.recommendation.ranked.map((e) => e.accountId)).toEqual(["b"]);
    expect(outcome.recommendation.rejected).toEqual([
      { accountId: "a", reason: "ESTIMATE_MISSING", at: "records.a" },
    ]);
  });

  it("bounds the candidate count", () => {
    const many = Array.from({ length: CANDIDATES_MAX + 1 }, (_unused, index) =>
      record("acct-" + String(index).padStart(5, "0")),
    );
    expect(refusal(rank(many, [])).reason).toBe("TOO_MANY_CANDIDATES");
  });
});

describe("the corrective findings", () => {
  it("refuses a non-object request instead of throwing", () => {
    // `rankAccounts(null)` used to destructure before proving anything and
    // died with a TypeError — an uncatalogued crash where the contract
    // promises a classified refusal.
    const outcome = rankAccounts(null as unknown as Parameters<typeof rankAccounts>[0]);
    expect(refusal(outcome).reason).toBe("REQUEST_INVALID");
    expect(refusal(outcome).at).toBe("request");
  });

  it("carries a refused quota outcome through as an account-level rejection", () => {
    const outcome = rankRaw({
      records: [record("a")],
      estimates: [{ accountId: "a", outcome: { ok: false, reason: "LIMIT_UNKNOWN", at: "limit" } }],
      evidence: absent("a"),
      task: task(),
      config: DEFAULT_ROUTING_CONFIG,
      now: NOW,
    });
    const rejected = refusal(outcome).rejected;
    expect(rejected.map((r) => [r.reason, r.quotaRefusal])).toEqual([
      ["ESTIMATE_REFUSED", "LIMIT_UNKNOWN"],
    ]);
  });

  it("refuses a malformed wrapper by name rather than throwing", () => {
    // The wrapper is caller-authored, so each of these is a shape a JavaScript
    // caller can hand over. Before the guard: the first threw a TypeError deep
    // in scoring, the second was ranked as if it had succeeded because a
    // non-empty string is truthy, and the third was reported as a quota refusal
    // carrying no reason at all.
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["ok without an estimate", { ok: true }, "estimates[0].outcome.estimate"],
      ["a non-boolean discriminant", { ok: "yes", estimate: estimate("a") }, "estimates[0].outcome"],
      ["an empty outcome", {}, "estimates[0].outcome"],
    ];
    for (const [label, outcome, at] of cases) {
      const run = (): RoutingOutcome =>
        rankRaw({
          records: [record("a")],
          estimates: [
            { accountId: "a", outcome: outcome as QuotaOutcome },
          ],
          evidence: absent("a"),
          task: task(),
          config: DEFAULT_ROUTING_CONFIG,
          now: NOW,
        });
      expect(run).not.toThrow();
      const outcomeOfRun = run();
      expect({ label, reason: refusal(outcomeOfRun).reason, at: refusal(outcomeOfRun).at }).toEqual({
        label,
        reason: "ORPHAN_ESTIMATE",
        at,
      });
    }
  });

  it("reaches ESTIMATE_ACCOUNT_MISMATCH when the wrapper and the estimate disagree", () => {
    const outcome = rankRaw({
      records: [record("a")],
      // The caller asked about "a"; the estimate inside is about "b".
      estimates: [{ accountId: "a", outcome: { ok: true, estimate: estimate("b") } }],
      evidence: absent("a"),
      task: task(),
      config: DEFAULT_ROUTING_CONFIG,
      now: NOW,
    });
    expect(refusal(outcome).rejected.map((r) => r.reason)).toEqual([
      "ESTIMATE_ACCOUNT_MISMATCH",
    ]);
  });

  it("refuses a malformed instant, agreeing with the quota module's grammar", () => {
    // The offset-less form is the one `Date.parse` silently resolves in the
    // runtime's local zone. Both modules must refuse it, and this asserts they
    // agree rather than trusting that the mirrored grammar has not drifted.
    const noOffset = "2026-08-29T12:00:00";
    const outcome = rankRaw({
      records: [record("a")],
      estimates: wrap([estimate("a")]),
      evidence: absent("a"),
      task: task(),
      config: DEFAULT_ROUTING_CONFIG,
      now: noOffset,
    });
    expect(refusal(outcome).reason).toBe("REQUEST_INVALID");
    expect(refusal(outcome).at).toBe("now");
    const quota = estimateQuota({
      record: record("a"),
      observations: [],
      limitKey: "weekly",
      now: noOffset,
    });
    expect(quota.ok).toBe(false);
  });

  it("keeps a zero-work profile from making an exhausted account eligible", () => {
    const zeroWork = task({ estimatedTokens: 0, reserveTokens: 0, estimatedDurationSeconds: 0 });
    for (const [label, override] of [
      ["over budget", { overBudget: true }],
      ["nothing remaining", { estimatedTokensRemaining: 0 }],
    ] as const) {
      const outcome = rank(
        [record("a", { contextSwitchCost: { estimatedTokens: 0, estimatedSeconds: 0 } })],
        [estimate("a", override)],
        absent("a"),
        zeroWork,
      );
      expect({ label, reason: refusal(outcome).rejected[0]?.reason }).toEqual({
        label,
        reason: "INSUFFICIENT_TOKEN_MARGIN",
      });
    }
  });

  it("refuses a known sample that rests on no observations", () => {
    const outcome = rank([record("a")], [estimate("a")], [
      {
        accountId: "a",
        acceptance: { known: true, rate: 0.9, sampleSize: 0, confidence: "HIGH" },
        contextAffinity: EVIDENCE_ABSENT,
        capabilities: { known: false },
      },
    ]);
    expect(refusal(outcome).reason).toBe("EVIDENCE_INVALID");
    expect(refusal(outcome).at).toBe("evidence[0].acceptance.sampleSize");
  });

  it("combines a known sample's confidence through the weakest-confidence law", () => {
    const outcome = rank([record("a")], [estimate("a", { confidence: "HIGH" })], [
      {
        accountId: "a",
        acceptance: { known: true, rate: 0.9, sampleSize: 10, confidence: "LOW" },
        contextAffinity: { known: true, rate: 0.9, sampleSize: 10, confidence: "HIGH" },
        capabilities: { known: false },
      },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // HIGH estimate, HIGH affinity, LOW acceptance -> LOW.
    expect(outcome.recommendation.ranked[0]?.confidence).toBe("LOW");
  });

  it("admits on stated capabilities only, and never infers them", () => {
    const needsTool = task({ requiredCapabilities: ["tool-use"] });
    const unknown = rank([record("a")], [estimate("a")], absent("a"), needsTool);
    expect(refusal(unknown).rejected.map((r) => r.reason)).toEqual(["CAPABILITY_UNKNOWN"]);

    const missing = rank([record("a")], [estimate("a")], [
      { ...evidence("a", 0.9), capabilities: { known: true, provided: ["vision"] } },
    ], needsTool);
    expect(refusal(missing).rejected.map((r) => r.reason)).toEqual([
      "CAPABILITY_NOT_PROVIDED",
    ]);

    const provided = rank([record("a")], [estimate("a")], [
      { ...evidence("a", 0.9), capabilities: { known: true, provided: ["tool-use"] } },
    ], needsTool);
    expect(provided.ok).toBe(true);
  });
});

describe("nothing is guessed", () => {
  it("marks an unknown signal rather than defaulting it", () => {
    const outcome = rank([record("a")], [estimate("a")], absent("a"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const top = outcome.recommendation.ranked[0];
    expect(top?.reasons).toContain("ACCEPTANCE_UNKNOWN");
    expect(top?.reasons).toContain("CONTEXT_AFFINITY_UNKNOWN");
    // And the recommendation is no more confident than its weakest input.
    expect(top?.confidence).toBe("LOW");
  });

  it("refuses an account with no evidence entry rather than defaulting it", () => {
    // The replaced form of this test asserted the opposite: that a missing row
    // was treated as an explicit absence. That made the module invent a
    // declaration the caller never made. Absence of evidence is not evidence
    // of absence, and only the caller can say which it has.
    const outcome = rankAccounts({
      records: [record("a")],
      estimates: wrap([estimate("a")]),
      evidence: [],
      task: task(),
      config: DEFAULT_ROUTING_CONFIG,
      now: NOW,
    });
    expect(refusal(outcome).reason).toBe("EVIDENCE_MISSING");
    expect(refusal(outcome).at).toBe("evidence.a");
  });

  it("does not infer acceptance from the alias, provider or model", () => {
    // Two accounts identical but for their names score identically when neither
    // carries evidence. A router that read anything from a name would not.
    const outcome = rank([record("aardvark"), record("zebra")], [
      estimate("aardvark"),
      estimate("zebra"),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [first, second] = outcome.recommendation.ranked;
    expect(first?.score).toBe(second?.score);
    // The tie then breaks lexicographically, not by insertion order.
    expect([first?.accountId, second?.accountId]).toEqual(["aardvark", "zebra"]);
  });

  it("refuses malformed evidence by field", () => {
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["rate above one", { known: true, rate: 1.5, sampleSize: 1, confidence: "HIGH" }, ".rate"],
      ["negative rate", { known: true, rate: -0.1, sampleSize: 1, confidence: "HIGH" }, ".rate"],
      ["NaN rate", { known: true, rate: Number.NaN, sampleSize: 1, confidence: "HIGH" }, ".rate"],
      [
        "fractional sample",
        { known: true, rate: 0.5, sampleSize: 1.5, confidence: "HIGH" },
        ".sampleSize",
      ],
      [
        "unknown confidence",
        { known: true, rate: 0.5, sampleSize: 1, confidence: "TOTAL" },
        ".confidence",
      ],
      ["not a marker", { known: "maybe" }, ".known"],
    ];
    for (const [label, acceptance, suffix] of cases) {
      const outcome = rank([record("a")], [estimate("a")], [
        { accountId: "a", acceptance, contextAffinity: EVIDENCE_ABSENT } as CandidateEvidence,
      ]);
      const refused = refusal(outcome);
      expect({ label, reason: refused.reason, at: refused.at }).toEqual({
        label,
        reason: "EVIDENCE_INVALID",
        at: "evidence[0].acceptance" + suffix,
      });
    }
  });

  it("refuses evidence for an account that was not offered, and duplicates", () => {
    expect(refusal(rank([record("a")], [estimate("a")], [evidence("ghost", 0.5)])).reason).toBe(
      "EVIDENCE_INVALID",
    );
    expect(
      refusal(rank([record("a")], [estimate("a")], [evidence("a", 0.5), evidence("a", 0.6)])).reason,
    ).toBe("EVIDENCE_INVALID");
  });
});

describe("each term is exercised on its own", () => {
  /** Weight everything at zero but one term, so the score *is* that term. */
  function only(term: string): RoutingConfig {
    const weights: Record<string, number> = {};
    for (const name of ROUTING_TERMS) weights[name] = name === term ? 1 : 0;
    return { weights: weights as RoutingConfig["weights"], longPacketTokens: 100_000 };
  }

  it("modelFit follows the acceptance rate", () => {
    for (const rate of [0, 0.25, 0.5, 1]) {
      const outcome = rank([record("a")], [estimate("a")], [evidence("a", rate)], task(), only("modelFit"));
      expect({ rate, score: outcome.ok ? outcome.recommendation.ranked[0]?.score : null }).toEqual({
        rate,
        score: rate,
      });
    }
  });

  it("quotaHeadroom rises with room above the requirement", () => {
    const scores = [16_000, 32_000, 160_000].map((remaining) => {
      const outcome = rank(
        [record("a")],
        [estimate("a", { estimatedTokensRemaining: remaining })],
        absent("a"),
        task(),
        only("quotaHeadroom"),
      );
      return outcome.ok ? (outcome.recommendation.ranked[0]?.score ?? -1) : -1;
    });
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBeCloseTo(0.5, 10);
    expect(scores[2]).toBeCloseTo(0.9, 10);
  });

  it("resetProximity rises with time relative to what the task needs", () => {
    const near = rank(
      [record("a")],
      [estimate("a", { reset: { ...estimate("a").reset, millisUntilReset: 70_000 } })],
      absent("a"),
      task(),
      only("resetProximity"),
    );
    const far = rank(
      [record("a")],
      [estimate("a", { reset: { ...estimate("a").reset, millisUntilReset: 700_000 } })],
      absent("a"),
      task(),
      only("resetProximity"),
    );
    expect(near.ok && near.recommendation.ranked[0]?.score).toBeCloseTo(0.1, 10);
    expect(far.ok && far.recommendation.ranked[0]?.score).toBe(1);
  });

  it("contextAffinity follows the affinity evidence", () => {
    const outcome = rank(
      [record("a")],
      [estimate("a")],
      [evidence("a", 0.1, 0.75)],
      task(),
      only("contextAffinity"),
    );
    expect(outcome.ok && outcome.recommendation.ranked[0]?.score).toBe(0.75);
  });

  it("switchPenalty falls as the switch costs more, in whichever dimension is worse", () => {
    const free = rank(
      [record("a", { contextSwitchCost: { estimatedTokens: 0, estimatedSeconds: 0 } })],
      [estimate("a")],
      absent("a"),
      task(),
      only("switchPenalty"),
    );
    expect(free.ok && free.recommendation.ranked[0]?.score).toBe(1);

    // Cheap in tokens, expensive in time: the worse dimension decides.
    const slow = rank(
      [record("a", { contextSwitchCost: { estimatedTokens: 0, estimatedSeconds: 30 } })],
      [estimate("a")],
      absent("a"),
      task(),
      only("switchPenalty"),
    );
    expect(slow.ok && slow.recommendation.ranked[0]?.score).toBeCloseTo(0.5, 10);
  });

  it("reserveMargin grades the daylight above the bar", () => {
    const exact = rank(
      [record("a")],
      [estimate("a", { estimatedTokensRemaining: 16_000 })],
      absent("a"),
      task(),
      only("reserveMargin"),
    );
    expect(exact.ok && exact.recommendation.ranked[0]?.score).toBe(0);

    const roomy = rank(
      [record("a")],
      [estimate("a", { estimatedTokensRemaining: 160_000 })],
      absent("a"),
      task(),
      only("reserveMargin"),
    );
    expect(roomy.ok && roomy.recommendation.ranked[0]?.score).toBeCloseTo(0.9, 10);
  });
});

describe("the configuration is a closed, validated set", () => {
  it("refuses a missing, unknown or unusable weight", () => {
    const base = { ...DEFAULT_ROUTING_CONFIG.weights };
    const cases: readonly (readonly [string, unknown])[] = [
      ["missing term", (() => { const w = { ...base }; delete (w as Record<string, number>)["modelFit"]; return w; })()],
      ["unknown term", { ...base, invented: 1 }],
      ["negative weight", { ...base, modelFit: -1 }],
      ["NaN weight", { ...base, modelFit: Number.NaN }],
      ["all zero", Object.fromEntries(ROUTING_TERMS.map((t) => [t, 0]))],
    ];
    for (const [label, weights] of cases) {
      const outcome = rank([record("a")], [estimate("a")], [], task(), {
        weights: weights as RoutingConfig["weights"],
        longPacketTokens: 100_000,
      });
      expect({ label, reason: refusal(outcome).reason }).toEqual({ label, reason: "CONFIG_INVALID" });
    }
  });

  it("refuses an out-of-range long-packet threshold", () => {
    for (const longPacketTokens of [-1, 1.5, Number.NaN, 10_000_001]) {
      const outcome = rank([record("a")], [estimate("a")], [], task(), {
        weights: DEFAULT_ROUTING_CONFIG.weights,
        longPacketTokens,
      });
      expect({
        longPacketTokens: String(longPacketTokens),
        refusal: refusal(outcome).reason,
      }).toEqual({ longPacketTokens: String(longPacketTokens), refusal: "CONFIG_INVALID" });
    }
  });

  it("refuses a task profile outside its bounds", () => {
    const cases: readonly (readonly [string, Partial<TaskProfile>, string])[] = [
      ["negative tokens", { estimatedTokens: -1 }, "task.estimatedTokens"],
      ["fractional tokens", { estimatedTokens: 1.5 }, "task.estimatedTokens"],
      ["tokens past the ceiling", { estimatedTokens: 10_000_001 }, "task.estimatedTokens"],
      ["negative reserve", { reserveTokens: -1 }, "task.reserveTokens"],
      ["duration past a day", { estimatedDurationSeconds: 86_401 }, "task.estimatedDurationSeconds"],
      ["empty model", { model: "" }, "task.model"],
    ];
    for (const [label, overrides, at] of cases) {
      const outcome = rank([record("a")], [estimate("a")], [], task(overrides));
      expect({ label, refusal: refusal(outcome) }).toMatchObject({
        label,
        refusal: { reason: "TASK_PROFILE_INVALID", at },
      });
    }
  });

  it("ships a default configuration that names every term", () => {
    expect(Object.keys(DEFAULT_ROUTING_CONFIG.weights).sort()).toEqual([...ROUTING_TERMS]);
    expect(Object.isFrozen(DEFAULT_ROUTING_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ROUTING_CONFIG.weights)).toBe(true);
  });
});

describe("the result is deterministic and immutable", () => {
  it("gives an identical ranking across repeated calls", () => {
    const records = [record("a"), record("b"), record("c")];
    const estimates = [estimate("a"), estimate("b"), estimate("c")];
    const ev = [evidence("a", 0.4), evidence("b", 0.4), evidence("c", 0.9)];
    const first = JSON.stringify(rank(records, estimates, ev));
    for (let run = 0; run < 100; run += 1) {
      expect(JSON.stringify(rank(records, estimates, ev))).toBe(first);
    }
  });

  it("does not depend on the order the caller supplied", () => {
    const forward = rank(
      [record("a"), record("b"), record("c")],
      [estimate("a"), estimate("b"), estimate("c")],
      [evidence("a", 0.5), evidence("b", 0.5), evidence("c", 0.5)],
    );
    const reversed = rank(
      [record("c"), record("b"), record("a")],
      [estimate("c"), estimate("b"), estimate("a")],
      [evidence("c", 0.5), evidence("b", 0.5), evidence("a", 0.5)],
    );
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it("breaks ties by accountId, lexicographically", () => {
    const outcome = rank(
      [record("m"), record("a"), record("z")],
      [estimate("m"), estimate("a"), estimate("z")],
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const scores = outcome.recommendation.ranked.map((entry) => entry.score);
    expect(new Set(scores).size).toBe(1);
    expect(outcome.recommendation.ranked.map((e) => e.accountId)).toEqual(["a", "m", "z"]);
  });

  it("produces no NaN, no Infinity and no duplicate", () => {
    const outcome = rank(
      [record("a"), record("b")],
      [estimate("a"), estimate("b", { estimatedTokensRemaining: 16_000 })],
      [evidence("a", 0), evidence("b", 1)],
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const ids = outcome.recommendation.ranked.map((e) => e.accountId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of outcome.recommendation.ranked) {
      expect(Number.isFinite(entry.score)).toBe(true);
      for (const term of ROUTING_TERMS) {
        expect({ term, finite: Number.isFinite(entry.terms[term]) }).toEqual({ term, finite: true });
      }
    }
  });

  it("freezes what it returns", () => {
    const outcome = rank([record("a")], [estimate("a")]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.isFrozen(outcome.recommendation)).toBe(true);
    expect(Object.isFrozen(outcome.recommendation.ranked)).toBe(true);
    expect(Object.isFrozen(outcome.recommendation.rejected)).toBe(true);
    expect(Object.isFrozen(outcome.recommendation.ranked[0])).toBe(true);
    expect(Object.isFrozen(outcome.recommendation.ranked[0]?.terms)).toBe(true);
    expect(Object.isFrozen(outcome.recommendation.ranked[0]?.reasons)).toBe(true);
  });

  it("does not mutate or alias what it was handed", () => {
    const records = [record("a"), record("b")];
    const estimates = [estimate("a"), estimate("b")];
    const ev = [evidence("a", 0.5), evidence("b", 0.5)];
    const before = JSON.stringify({ records, estimates, ev });
    const outcome = rank(records, estimates, ev);
    expect(JSON.stringify({ records, estimates, ev })).toBe(before);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The returned arrays are copies, not the caller's own.
    expect(outcome.recommendation.ranked).not.toBe(records);
  });

  it("freezes the refusal, and its rejections", () => {
    const outcome = rank([record("a", { status: "EXHAUSTED" })], [estimate("a")]);
    const refused = refusal(outcome);
    expect(Object.isFrozen(refused)).toBe(true);
    expect(Object.isFrozen(refused.rejected)).toBe(true);
    expect(Object.isFrozen(refused.rejected[0])).toBe(true);
  });
});

describe("the module keeps its own laws", () => {
  const source = readFileSync(join(HERE, "..", "..", "src", "routing", "index.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("reads no clock and rolls no dice", () => {
    for (const token of ["Date.now", "new Date(", "Date.parse", "performance.now", "Math.random"]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("reads no environment and touches no filesystem or ledger", () => {
    for (const token of ["process.env", "node:fs", "readFileSync", ["@acp", "ledger"].join("/"), ".append("]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("reads the record's declared quota at exactly one site, and never scores it", () => {
    // One quota authority. The declared figure admits; the fresh estimate
    // scores. Two readings would be two answers to the same question.
    const declared = code.split("record.quotaEstimate").length - 1;
    expect(declared).toBe(1);
  });

  it("declares a closed, sorted refusal set and a closed term set", () => {
    expect(Object.isFrozen(ROUTING_REFUSALS)).toBe(true);
    expect([...ROUTING_REFUSALS]).toEqual([...ROUTING_REFUSALS].sort());
    expect(new Set(ROUTING_REFUSALS).size).toBe(ROUTING_REFUSALS.length);
    expect(Object.isFrozen(ROUTING_TERMS)).toBe(true);
    expect([...ROUTING_TERMS]).toEqual([...ROUTING_TERMS].sort());
    expect(ROUTING_TERMS).toHaveLength(6);
  });
});
