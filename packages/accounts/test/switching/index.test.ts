import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AccountRecord, CONTRACT_VERSION, CONTROL_PLANE_EVENT_TYPES } from "@acp/contracts";

import type { QuotaEstimate, QuotaOutcome } from "../../src/quota/index.js";
import type { RoutingRequest } from "../../src/routing/index.js";
import { DEFAULT_ROUTING_CONFIG } from "../../src/routing/index.js";
import {
  SWITCH_REFUSALS,
  SWITCH_STEPS,
  SWITCH_TRIGGERS,
  decideSwitch,
} from "../../src/switching/index.js";
import type { SwitchOutcome, SwitchRefused, SwitchRequest } from "../../src/switching/index.js";

const NOW = "2026-08-28T12:00:00Z";
const RESET = "2026-08-28T13:00:00Z";
const HOUR_MS = 3_600_000;

type Overrides = Partial<Record<string, unknown>>;

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
    resetSchedule: { kind: "DECLARED", nextResetAt: RESET, timezone: "UTC", confidence: "HIGH" },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      estimatedAt: NOW,
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-p5d-" + accountId,
    contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
    ...overrides,
  });
  if (!parsed.success) throw new Error("fixture is not a valid AccountRecord");
  return parsed.data;
}

/**
 * An AUTH_REQUIRED record.
 *
 * The contract refuses to let such an account publish a quota estimate — an
 * account nobody can authenticate against has nothing measurable to report —
 * so the fixture nulls it rather than working around the schema.
 */
function authRequired(accountId: string, overrides: Overrides = {}): AccountRecord {
  return record(accountId, {
    status: "AUTH_REQUIRED",
    quotaEstimate: {
      remainingRatio: null,
      estimatedTokensRemaining: null,
      estimatedAt: NOW,
      confidence: "MEDIUM",
    },
    ...overrides,
  });
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

function wrap(
  estimates: readonly QuotaEstimate[],
): readonly { readonly accountId: string; readonly outcome: QuotaOutcome }[] {
  return estimates.map((e) => ({ accountId: e.accountId, outcome: { ok: true, estimate: e } }));
}

function absent(...accountIds: readonly string[]) {
  return accountIds.map((accountId) => ({
    accountId,
    acceptance: { known: false } as const,
    contextAffinity: { known: false } as const,
    capabilities: { known: false } as const,
  }));
}

function routing(accountIds: readonly string[], overrides: Partial<RoutingRequest> = {}) {
  return {
    records: accountIds.map((id) => record(id)),
    estimates: wrap(accountIds.map((id) => estimate(id))),
    evidence: absent(...accountIds),
    task: {
      estimatedTokens: 10_000,
      estimatedDurationSeconds: 60,
      reserveTokens: 5_000,
      model: "opus",
      requiredCapabilities: [],
    },
    config: DEFAULT_ROUTING_CONFIG,
    now: NOW,
    ...overrides,
  } satisfies RoutingRequest;
}

function request(overrides: Partial<SwitchRequest> = {}): SwitchRequest {
  return {
    trigger: "QUOTA_EXHAUSTED",
    currentAccountId: "a",
    routing: routing(["a", "b"]),
    ...overrides,
  };
}

function refusal(outcome: SwitchOutcome): SwitchRefused {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

describe("law 2: the fail-closed taxonomy", () => {
  it("recommends nothing for a trigger outside the classified set", () => {
    // Every one of these is a shape a provider or a transport can produce. None
    // of them is quota, and a module that read them as quota would move a task
    // off a perfectly healthy account because a socket hiccupped.
    const outside: readonly unknown[] = [
      "ECONNRESET",
      "rate limit exceeded",
      "quota_warning",
      "QUOTA_BLOCKED",
      "",
      undefined,
      null,
      42,
      { type: "QUOTA_WARNING" },
    ];
    for (const trigger of outside) {
      const outcome = decideSwitch(request({ trigger: trigger as string }));
      expect({ trigger: String(trigger), reason: refusal(outcome).reason }).toEqual({
        trigger: String(trigger),
        reason: "TRIGGER_UNCLASSIFIED",
      });
    }
  });

  it("acts only on the two triggers it declares", () => {
    expect([...SWITCH_TRIGGERS]).toEqual(["QUOTA_EXHAUSTED", "QUOTA_WARNING"]);
    for (const trigger of SWITCH_TRIGGERS) {
      expect(decideSwitch(request({ trigger })).ok).toBe(true);
    }
  });
});

describe("law 3: the sequence law", () => {
  it("plans the lawful steps in order, none skipped", () => {
    const outcome = decideSwitch(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect([...outcome.plan.steps]).toEqual([...SWITCH_STEPS]);
  });

  it("keeps every plan a subsequence of the declared order", () => {
    for (const trigger of SWITCH_TRIGGERS) {
      const outcome = decideSwitch(request({ trigger }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const positions = outcome.plan.steps.map((step) => SWITCH_STEPS.indexOf(step));
      expect(positions).toEqual([...positions].sort((l, r) => l - r));
      expect(positions.every((p) => p >= 0)).toBe(true);
    }
  });
});

describe("law 1 and C2: it recommends, and it invents no vocabulary", () => {
  it("draws every candidate event type from the frozen contracts vocabulary", () => {
    for (const trigger of SWITCH_TRIGGERS) {
      const outcome = decideSwitch(request({ trigger }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      for (const candidate of outcome.plan.events) {
        expect(CONTROL_PLANE_EVENT_TYPES).toContain(candidate.type);
      }
    }
  });

  it("names no state outside the two contract enums", () => {
    const accountStatuses = ["AVAILABLE", "DRAINING", "EXHAUSTED", "COOLDOWN", "AUTH_REQUIRED"];
    const taskStates = ["QUOTA_BLOCKED", "AUTH_REQUIRED"];
    for (const trigger of SWITCH_TRIGGERS) {
      const outcome = decideSwitch(request({ trigger }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(accountStatuses).toContain(outcome.plan.accountStatus);
      if (outcome.plan.taskState !== null) expect(taskStates).toContain(outcome.plan.taskState);
    }
  });

  it("puts QUOTA_BLOCKED on the task and never on the account", () => {
    const outcome = decideSwitch(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.taskState).toBe("QUOTA_BLOCKED");
    expect(outcome.plan.accountStatus).not.toBe("QUOTA_BLOCKED");
  });
});

describe("law 4: the account states are honored", () => {
  it("escalates an AUTH_REQUIRED account to the owner and touches no credential", () => {
    const outcome = decideSwitch(
      request({ routing: routing(["a", "b"], { records: [authRequired("a"), record("b")] }) }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.kind).toBe("ESCALATE");
    expect(outcome.plan.selectedAccountId).toBeNull();
    expect(outcome.plan.steps).toEqual([]);
    expect(outcome.plan.events.map((e) => e.type)).toEqual(["AUTH_REQUIRED_RAISED"]);
  });

  it("refuses when the current account is not among the records", () => {
    const outcome = decideSwitch(request({ currentAccountId: "missing" }));
    expect(refusal(outcome).reason).toBe("CURRENT_ACCOUNT_UNKNOWN");
  });
});

describe("law 5: composition, not re-implementation", () => {
  it("carries the router's refusal through instead of choosing anyway", () => {
    // Every candidate is ineligible, so the router refuses. The switching
    // policy must not reach past it and pick one regardless.
    const drained = routing(["a", "b"], {
      records: [record("a"), record("b", { status: "EXHAUSTED" })],
      estimates: wrap([estimate("a"), estimate("b")]).map((w) =>
        w.accountId === "a" ? { ...w, outcome: { ok: true as const, estimate: estimate("a", { estimatedTokensRemaining: 0 }) } } : w,
      ),
    });
    const outcome = decideSwitch(request({ routing: drained }));
    expect(refusal(outcome).reason).toBe("NO_ELIGIBLE_ACCOUNT");
  });

  it("selects exactly the account the router ranked first", () => {
    const outcome = decideSwitch(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Not `toContain(["a","b"])`: the current account is "a", so the only
    // lawful answer is "b". The weaker assertion is what let the module
    // recommend switching an account to itself.
    expect(outcome.plan.selectedAccountId).toBe("b");
  });

  it("never selects the account it is draining, even when that account ranks best", () => {
    // "a" is the account being drained and also the one with the most headroom,
    // so an unfiltered ranking puts it first. A switch to the account we are
    // switching away from is not a switch.
    const headroom = routing(["a", "b"], {
      estimates: [
        { accountId: "a", outcome: { ok: true, estimate: estimate("a", { estimatedTokensRemaining: 900_000 }) } },
        { accountId: "b", outcome: { ok: true, estimate: estimate("b", { estimatedTokensRemaining: 100_000 }) } },
      ],
    });
    const outcome = decideSwitch(request({ routing: headroom }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.selectedAccountId).toBe("b");
  });

  it("refuses when the current account is the only candidate", () => {
    const alone = routing(["a"]);
    const outcome = decideSwitch(request({ routing: alone }));
    expect(refusal(outcome).reason).toBe("NO_ELIGIBLE_ACCOUNT");
  });

  it("refuses when the current account has no quota outcome to reason from", () => {
    const noOutcome = routing(["a", "b"], { estimates: wrap([estimate("b")]) });
    const outcome = decideSwitch(request({ routing: noOutcome }));
    expect(refusal(outcome).reason).toBe("QUOTA_OUTCOME_MISSING");
  });

  it("reads EXHAUSTED or COOLDOWN from the estimator rather than guessing", () => {
    const recovering = decideSwitch(request());
    expect(recovering.ok && recovering.plan.accountStatus).toBe("COOLDOWN");

    const noReset = routing(["a", "b"], {
      estimates: [
        {
          accountId: "a",
          outcome: {
            ok: true,
            estimate: estimate("a", {
              reset: {
                kind: "DECLARED",
                nextResetAt: RESET,
                timezone: "UTC",
                millisUntilReset: 0,
                confidence: "HIGH",
              },
            }),
          },
        },
        ...wrap([estimate("b")]),
      ],
    });
    const exhausted = decideSwitch(request({ routing: noReset }));
    expect(exhausted.ok && exhausted.plan.accountStatus).toBe("EXHAUSTED");
  });
});

describe("law 6: determinism and purity", () => {
  it("returns the same value for the same request", () => {
    const first = decideSwitch(request());
    const second = decideSwitch(request());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("freezes the outcome at every level", () => {
    const outcome = decideSwitch(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.plan)).toBe(true);
    expect(Object.isFrozen(outcome.plan.steps)).toBe(true);
    expect(Object.isFrozen(outcome.plan.events)).toBe(true);
    for (const candidate of outcome.plan.events) {
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.payload)).toBe(true);
    }
  });

  it("refuses a malformed routing request by name rather than throwing", () => {
    // `request.routing` is caller-authored and this module reads its
    // collections before the router does. Each of these reached a `.filter`
    // or a `.find` on a non-array before the guards landed.
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["records not an array", { ...routing(["a", "b"]), records: "nope" }, "request.routing.records"],
      ["estimates not an array", { ...routing(["a", "b"]), estimates: null }, "request.routing.estimates"],
      ["evidence not an array", { ...routing(["a", "b"]), evidence: 7 }, "request.routing.evidence"],
      ["neither present", {}, "request.routing.records"],
    ];
    for (const [label, malformed, at] of cases) {
      const run = (): SwitchOutcome =>
        decideSwitch(request({ routing: malformed as never }));
      expect(run).not.toThrow();
      expect({ label, reason: refusal(run()).reason, at: refusal(run()).at }).toEqual({
        label,
        reason: "REQUEST_INVALID",
        at,
      });
    }
  });

  it("refuses a non-object request instead of throwing", () => {
    const run = (): SwitchOutcome => decideSwitch(null as unknown as SwitchRequest);
    expect(run).not.toThrow();
    expect(refusal(run()).reason).toBe("REQUEST_INVALID");
  });

  it("closes its refusal set", () => {
    expect([...SWITCH_REFUSALS]).toEqual([...SWITCH_REFUSALS].sort());
    expect(new Set(SWITCH_REFUSALS).size).toBe(SWITCH_REFUSALS.length);
  });
});

describe("law 7: the per-provider drills", () => {
  // Claude, Kimi and Codex differ in provider and alias and in nothing this
  // module is allowed to read. The drills assert exactly that: the decision is
  // the same for all three, so no provider is being special-cased.
  const providers = [
    ["claude", "anthropic"],
    ["kimi", "moonshot"],
    ["codex", "openai"],
  ] as const;

  for (const [alias, provider] of providers) {
    const records = [
      record("current", { provider, alias }),
      record("spare", { provider, alias: alias + "-spare" }),
    ];
    const base = routing(["current", "spare"], { records });
    const req = (overrides: Partial<SwitchRequest> = {}): SwitchRequest => ({
      trigger: "QUOTA_EXHAUSTED",
      currentAccountId: "current",
      routing: base,
      ...overrides,
    });

    it(alias + ": a classified warning recommends a drain, not a move", () => {
      const outcome = decideSwitch(req({ trigger: "QUOTA_WARNING" }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.plan.kind).toBe("DRAIN");
      expect(outcome.plan.accountStatus).toBe("DRAINING");
      expect(outcome.plan.taskState).toBeNull();
      expect(outcome.plan.selectedAccountId).toBeNull();
    });

    it(alias + ": exhaustion recommends the full switch plan", () => {
      const outcome = decideSwitch(req());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.plan.kind).toBe("SWITCH");
      expect([...outcome.plan.steps]).toEqual([...SWITCH_STEPS]);
      expect(outcome.plan.taskState).toBe("QUOTA_BLOCKED");
      // The task moves off "current"; recommending "current" would be a no-op
      // wearing a switch plan's clothes.
      expect(outcome.plan.selectedAccountId).not.toBe("current");
      expect(outcome.plan.selectedAccountId).toBe("spare");
    });

    it(alias + ": an unclassified error changes nothing", () => {
      const outcome = decideSwitch(req({ trigger: "provider returned 503" }));
      expect(refusal(outcome).reason).toBe("TRIGGER_UNCLASSIFIED");
    });

    it(alias + ": an AUTH_REQUIRED account escalates to the owner", () => {
      const blocked = routing(["current", "spare"], {
        records: [authRequired("current", { provider, alias }), record("spare", { provider })],
      });
      const outcome = decideSwitch(req({ routing: blocked }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.plan.kind).toBe("ESCALATE");
    });
  }
});

describe("the module keeps its own laws", () => {
  it("names no clock, no dice, no ledger append and no process", () => {
    const here = resolve(fileURLToPath(import.meta.url), "..");
    const source = readFileSync(join(here, "..", "..", "src", "switching", "index.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const token of [
      "Date.now",
      "new Date(",
      "Date.parse",
      "performance.now",
      "Math.random",
      "process.env",
      "node:fs",
      "node:child_process",
      ".append(",
      "Ledger",
    ]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });
});
