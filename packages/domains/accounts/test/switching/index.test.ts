import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AccountRecord,
  CONTRACT_VERSION,
  CONTROL_PLANE_EVENT_TYPES,
  PROVIDER_PRESSURES,
} from "@acp/contracts";

import type { QuotaEstimate, QuotaOutcome } from "../../src/quota/index.js";
import type { RoutingRequest } from "../../src/routing/index.js";
import { DEFAULT_ROUTING_CONFIG } from "../../src/routing/index.js";
import {
  PRESSURE_TRIGGER_REFUSALS,
  SWITCH_REFUSALS,
  SWITCH_STEPS,
  SWITCH_TRIGGERS,
  decideSwitch,
  foldPressureTrigger,
} from "../../src/switching/index.js";
import type {
  PressureObservation,
  SwitchOutcome,
  SwitchRefused,
  SwitchRequest,
} from "../../src/switching/index.js";

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

/**
 * V2-B1f/F1: the planner records the decision, and claims no work.
 *
 * There was no pin on the `SWITCH` plan's event list before this packet, which
 * is how a fabricated `ACCOUNT_SWITCH_COMPLETED` sat beside `..._STARTED` for
 * as long as it did: every existing law checked the events against the frozen
 * vocabulary, the state enums and the step order, and all of those passed for
 * an event that was simply not true yet. A list nothing enumerates is a list
 * nothing defends.
 */
describe("F1: a SWITCH plan's events end at the decision", () => {
  it("P1 emits exactly the four types, in order, ending at ACCOUNT_SWITCH_STARTED", () => {
    const outcome = decideSwitch(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.plan.events.map((candidate) => candidate.type)).toEqual([
      "QUOTA_WARNING",
      "TASK_STATE_CHANGED",
      "LEASE_REVOKED",
      "ACCOUNT_SWITCH_STARTED",
    ]);
  });

  it("never emits ACCOUNT_SWITCH_COMPLETED, for any trigger", () => {
    // The defect by name. A completion is a claim about the end of a switch,
    // and this module runs at its beginning; only the session-opener F5 builds
    // may append one. Asserted across every trigger so a later branch cannot
    // reintroduce it somewhere this suite was not looking.
    for (const trigger of SWITCH_TRIGGERS) {
      const outcome = decideSwitch(request({ trigger }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.plan.events.map((candidate) => candidate.type)).not.toContain(
        "ACCOUNT_SWITCH_COMPLETED",
      );
    }
  });

  it("P4 still declares all eleven steps: F1 narrows what may be claimed, not what the plan states", () => {
    // The steps are what the control plane must do; the events are what has
    // happened so far. Shortening the steps to match the events would foreclose
    // the sessions F5 opens, and is exactly what this packet must not do.
    const outcome = decideSwitch(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.plan.steps).toHaveLength(11);
    expect([...outcome.plan.steps]).toEqual([...SWITCH_STEPS]);
    expect(outcome.plan.steps).toContain("CONTINUE");
    expect(outcome.plan.steps).toContain("SELECT_ACCOUNT");
  });

  it("keeps ACCOUNT_SWITCH_STARTED, whose toAccountId records the router's own choice", () => {
    // Not a claim that SELECT_ACCOUNT (step 6) was performed: `rankAccounts`
    // made that choice while the plan was being built, so the field records a
    // decision this module genuinely made.
    const outcome = decideSwitch(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const started = outcome.plan.events.find((c) => c.type === "ACCOUNT_SWITCH_STARTED");
    expect(started?.payload).toEqual({ fromAccountId: "a", toAccountId: "b" });
    expect(outcome.plan.selectedAccountId).toBe("b");
  });

  it("P3 leaves the DRAIN trail byte-identical, asserted against literals", () => {
    // Literals rather than a re-run of the planner: comparing the planner to
    // itself would pass no matter what it emitted. These are the values HEAD
    // produced before F1, written out.
    const outcome = decideSwitch(request({ trigger: "QUOTA_WARNING" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.plan.kind).toBe("DRAIN");
    expect(outcome.plan.accountStatus).toBe("DRAINING");
    expect(outcome.plan.taskState).toBeNull();
    expect(outcome.plan.selectedAccountId).toBeNull();
    expect([...outcome.plan.steps]).toEqual([
      "MARK_ACCOUNT_DRAINING",
      "FINISH_CURRENT_ATOMIC_STEP",
      "WRITE_CHECKPOINT",
    ]);
    expect(outcome.plan.events.map((c) => c.type)).toEqual(["QUOTA_WARNING"]);
    expect(outcome.plan.events[0]?.payload).toEqual({ accountId: "a" });
  });

  it("P3 leaves the ESCALATE trail byte-identical, asserted against literals", () => {
    const outcome = decideSwitch(
      request({ routing: routing(["a", "b"], { records: [authRequired("a"), record("b")] }) }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.plan.kind).toBe("ESCALATE");
    expect(outcome.plan.accountStatus).toBe("AUTH_REQUIRED");
    expect(outcome.plan.taskState).toBe("AUTH_REQUIRED");
    expect(outcome.plan.selectedAccountId).toBeNull();
    expect([...outcome.plan.steps]).toEqual([]);
    expect(outcome.plan.events.map((c) => c.type)).toEqual(["AUTH_REQUIRED_RAISED"]);
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

// ---------------------------------------------------------------------------
// V2-B1f/F4b — the fold from recorded pressure to a classified trigger
// ---------------------------------------------------------------------------

const OBSERVED_AT = "2026-09-05T10:00:00.000Z";

function observation(
  pressure: PressureObservation["pressure"],
  overrides: Partial<PressureObservation> = {},
): PressureObservation {
  return {
    accountId: "acct-primary",
    provider: "codex",
    pressure,
    occurredAt: OBSERVED_AT,
    sequence: 1,
    eventId: "00000000-0000-4000-8000-0000000000" + String(10 + (overrides.sequence ?? 1)),
    ...overrides,
  };
}

describe("F4b P1: the fold is total over the closed observation vocabulary", () => {
  it("gives every member exactly one outcome, and names what it saw when it refuses", () => {
    // Asserted over the contract's own closed set, so a sixth member cannot be
    // added without deciding here what it folds to.
    const expected: Readonly<Record<string, "TRIGGER" | "NO_TRIGGER_CLASSIFIED">> = {
      AUTH_REQUIRED: "NO_TRIGGER_CLASSIFIED",
      QUOTA_EXHAUSTED: "TRIGGER",
      QUOTA_WARNING: "TRIGGER",
      TRANSIENT: "NO_TRIGGER_CLASSIFIED",
      UNCLASSIFIED: "NO_TRIGGER_CLASSIFIED",
    };
    expect(Object.keys(expected).sort()).toEqual([...PROVIDER_PRESSURES].sort());

    for (const member of PROVIDER_PRESSURES) {
      const outcome = foldPressureTrigger([observation(member)]);
      if (expected[member] === "TRIGGER") {
        expect({ member, ok: outcome.ok }).toEqual({ member, ok: true });
        if (!outcome.ok) continue;
        expect(outcome.trigger).toBe(member);
      } else {
        expect({ member, ok: outcome.ok }).toEqual({ member, ok: false });
        if (outcome.ok) continue;
        expect(outcome.reason).toBe("NO_TRIGGER_CLASSIFIED");
        // The refusal names the member, so NO_TRIGGER_CLASSIFIED is never the
        // same words a malformed row would produce.
        expect(outcome.at).toBe(member);
      }
      // Present on every arm, whatever was decided.
      expect(outcome.observed.counts).toEqual({ [member]: 1 });
      expect(outcome.observed.latestOccurredAt).toBe(OBSERVED_AT);
      expect(outcome.observed.latestEventId).not.toBeNull();
    }
  });

  it("treats an empty set as a success-shaped fact, never as a trigger", () => {
    const outcome = foldPressureTrigger([]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("NO_PRESSURE_RECORDED");
    expect(outcome.at).toBe("observations");
    expect(outcome.observed).toEqual({
      counts: {},
      latestEventId: null,
      latestOccurredAt: null,
    });
  });

  it("closes its refusal vocabulary at two, sorted and deduplicated", () => {
    expect([...PRESSURE_TRIGGER_REFUSALS]).toEqual([
      "NO_PRESSURE_RECORDED",
      "NO_TRIGGER_CLASSIFIED",
    ]);
    expect(new Set(PRESSURE_TRIGGER_REFUSALS).size).toBe(PRESSURE_TRIGGER_REFUSALS.length);
  });
});

describe("F4b P2: severity is declared, not assumed", () => {
  it("pins the trigger vocabulary in order, most severe first", () => {
    // By ORDER and not only by membership. The architecture fence compares
    // this vocabulary against the contract's observation vocabulary as a SET
    // in both directions, so the ordering is this module's own law and this
    // assertion is the only thing that enforces it. An exhaustion first is the
    // claim; the alphabet agreeing with it today is a coincidence.
    expect([...SWITCH_TRIGGERS]).toEqual(["QUOTA_EXHAUSTED", "QUOTA_WARNING"]);
    expect(SWITCH_TRIGGERS[0]).toBe("QUOTA_EXHAUSTED");
  });

  it("lets severity outrank recency, and names the deciding row as the cause", () => {
    // The warning is the LATER row. Severity still decides, and `causedBy` is
    // the exhaustion's own event id — not the newest row's.
    const exhausted = observation("QUOTA_EXHAUSTED", { sequence: 4, eventId: "ev-exhausted" });
    const warning = observation("QUOTA_WARNING", { sequence: 9, eventId: "ev-warning" });
    const outcome = foldPressureTrigger([exhausted, warning]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.trigger).toBe("QUOTA_EXHAUSTED");
    expect(outcome.causedBy).toBe("ev-exhausted");
    // The summary still describes everything that was seen.
    expect(outcome.observed.counts).toEqual({ QUOTA_EXHAUSTED: 1, QUOTA_WARNING: 1 });
    expect(outcome.observed.latestEventId).toBe("ev-warning");
  });

  it("names the highest-sequence row of the deciding member when two agree", () => {
    // The tie rule, stated: among observations of the member that decided, the
    // cause is the ledger's latest, never the first encountered.
    const first = observation("QUOTA_EXHAUSTED", { sequence: 2, eventId: "ev-first" });
    const second = observation("QUOTA_EXHAUSTED", { sequence: 7, eventId: "ev-second" });
    const outcome = foldPressureTrigger([first, second]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.causedBy).toBe("ev-second");
    expect(outcome.observed.counts).toEqual({ QUOTA_EXHAUSTED: 2 });
  });

  it("orders by ledger sequence and not by the order it was handed", () => {
    const shuffled = [
      observation("QUOTA_EXHAUSTED", { sequence: 7, eventId: "ev-late" }),
      observation("QUOTA_EXHAUSTED", { sequence: 2, eventId: "ev-early" }),
    ];
    const outcome = foldPressureTrigger(shuffled);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.causedBy).toBe("ev-late");
  });
});

describe("F4b N2/N3/N4: what never becomes a trigger", () => {
  it("N2: an authentication requirement is refused, and the account is still described", () => {
    // The only pressure the plane can currently observe through a daemon. It
    // must never move a task, and it must never print as an anonymous NONE:
    // the operator's answer to it is a re-authentication, not a switch.
    const outcome = foldPressureTrigger([
      observation("AUTH_REQUIRED", { provider: "claude", sequence: 3, eventId: "ev-auth" }),
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ reason: outcome.reason, at: outcome.at }).toEqual({
      reason: "NO_TRIGGER_CLASSIFIED",
      at: "AUTH_REQUIRED",
    });
    expect(outcome.observed.counts).toEqual({ AUTH_REQUIRED: 1 });
    expect(outcome.observed.latestEventId).toBe("ev-auth");
  });

  it("N3: a transient or an unclassified utterance never becomes a switch", () => {
    for (const member of ["TRANSIENT", "UNCLASSIFIED"] as const) {
      const outcome = foldPressureTrigger([observation(member)]);
      expect({ member, ok: outcome.ok }).toEqual({ member, ok: false });
      if (outcome.ok) continue;
      expect({ member, at: outcome.at }).toEqual({ member, at: member });
    }
  });

  it("N4: a non-trigger crowd never promotes itself, however many rows there are", () => {
    const outcome = foldPressureTrigger([
      observation("TRANSIENT", { sequence: 1, eventId: "ev-1" }),
      observation("AUTH_REQUIRED", { sequence: 2, eventId: "ev-2" }),
      observation("UNCLASSIFIED", { sequence: 3, eventId: "ev-3" }),
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("NO_TRIGGER_CLASSIFIED");
    // The member named is the latest by sequence, so the refusal describes the
    // most recent thing the account said rather than an arbitrary one.
    expect(outcome.at).toBe("UNCLASSIFIED");
    expect(outcome.observed.counts).toEqual({
      TRANSIENT: 1,
      AUTH_REQUIRED: 1,
      UNCLASSIFIED: 1,
    });
  });

  it("finds the one trigger buried among rows that are not", () => {
    const outcome = foldPressureTrigger([
      observation("TRANSIENT", { sequence: 1, eventId: "ev-1" }),
      observation("QUOTA_WARNING", { sequence: 2, eventId: "ev-warning" }),
      observation("AUTH_REQUIRED", { sequence: 3, eventId: "ev-3" }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect({ trigger: outcome.trigger, causedBy: outcome.causedBy }).toEqual({
      trigger: "QUOTA_WARNING",
      causedBy: "ev-warning",
    });
  });
});

describe("F4b N8: the two vocabularies agree as sets, and the order is a separate claim", () => {
  it("holds in both directions over the quota members", () => {
    // The tested twin of the fence law that reads both files. It is a SET
    // comparison on purpose — the ordering claim is P2's, and conflating the
    // two is exactly what would let a re-sort pass unnoticed.
    const quotaMembers = [...PROVIDER_PRESSURES].filter((member) => member.startsWith("QUOTA_"));
    expect([...quotaMembers].sort()).toEqual([...SWITCH_TRIGGERS].sort());
    for (const trigger of SWITCH_TRIGGERS) {
      expect({ trigger, known: quotaMembers.includes(trigger) }).toEqual({ trigger, known: true });
    }
    for (const member of quotaMembers) {
      expect({
        member,
        known: (SWITCH_TRIGGERS as readonly string[]).includes(member),
      }).toEqual({ member, known: true });
    }
  });

  it("folds a trigger that decideSwitch then re-classifies independently", () => {
    // Two independent classifications, deliberately: the fold decides WHICH
    // rows are a trigger, and `decideSwitch`'s own fail-closed guard decides
    // whether the string it was handed is one. Neither trusts the other.
    const outcome = foldPressureTrigger([observation("QUOTA_WARNING")]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const decided = decideSwitch(request({ trigger: outcome.trigger }));
    expect(decided.ok).toBe(true);
  });
});

describe("F4b: the fold keeps the module's own laws", () => {
  it("is pure and frozen at every level", () => {
    const outcome = foldPressureTrigger([observation("QUOTA_EXHAUSTED")]);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.observed)).toBe(true);
    expect(Object.isFrozen(outcome.observed.counts)).toBe(true);
  });

  it("is deterministic: the same observations fold the same way every time", () => {
    const rows = [
      observation("QUOTA_EXHAUSTED", { sequence: 4, eventId: "ev-a" }),
      observation("QUOTA_WARNING", { sequence: 5, eventId: "ev-b" }),
    ];
    const first = JSON.stringify(foldPressureTrigger(rows));
    for (let index = 0; index < 50; index += 1) {
      expect(JSON.stringify(foldPressureTrigger(rows))).toBe(first);
    }
  });

  it("mutates nothing it was handed", () => {
    const rows = [observation("QUOTA_EXHAUSTED"), observation("QUOTA_WARNING", { sequence: 2 })];
    const before = JSON.stringify(rows);
    foldPressureTrigger(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
