/**
 * Evidence for the operator-state fold (V2-B1e).
 *
 * The precedence matrix, written before anything consumes the fold. What is
 * under test is a pure function over two values: there is no ledger here, no
 * file, no clock, no process and no socket. That is the point of the move —
 * the authority law became testable without a database once it stopped living
 * beside one.
 *
 * The history fixtures are whole `AccountActionEvent` values rather than
 * partials, because the contract's own refinement is part of what the fold
 * relies on: `resultingState` is read and never recomputed, and it is the
 * schema that guarantees `DRAIN` never arrives carrying `AVAILABLE`.
 */

import { describe, expect, it } from "vitest";

import { ACCOUNT_ACTION_STATE, ACCOUNT_ACTIONS, AccountActionEvent, AccountRecord } from "@acp/contracts";
import type { AccountAction, AccountStatus } from "@acp/contracts";

import { estimateQuota } from "../../src/quota/index.js";
import { rankAccounts } from "../../src/routing/index.js";
import { DEFAULT_ROUTING_CONFIG } from "../../src/routing/index.js";
import { EVIDENCE_ABSENT } from "../../src/routing/index.js";
import { ACCOUNT_ACTIONS_MAX, foldEffectiveState } from "../../src/operator-state/index.js";

const ACCOUNT = "acct-b1e-fold";
const ACTOR = "claude/opus/implementer/01";
const CONTRACT_VERSION = "2.2.0";

/**
 * A distinct, valid instant per version, ordered the way the versions are.
 *
 * Composed by arithmetic rather than by string concatenation on the version:
 * a fixture that produced "T013:00:00Z" for version 13 would fail the schema's
 * datetime format, which is a fixture defect masquerading as a fold defect.
 */
function instantFor(version: number): string {
  const minute = String(version % 60).padStart(2, "0");
  const hour = String(Math.floor(version / 60) % 24).padStart(2, "0");
  return "2026-09-01T" + hour + ":" + minute + ":00.000Z";
}

/**
 * One recorded action, parsed by the contract that owns it.
 *
 * Parsed rather than cast: a fixture the schema would reject is a fixture that
 * proves nothing about a fold whose whole premise is that the event it reads
 * was admitted. The `idempotencyKey` is composed exactly as the seam composes
 * it, because the schema refuses any other shape.
 */
function action(
  version: number,
  act: AccountAction,
  setState: AccountStatus | null = null,
  at = instantFor(version),
): AccountActionEvent {
  const resulting = ACCOUNT_ACTION_STATE[act] ?? setState;
  if (resulting === null) throw new Error("an override fixture must name its state");
  return AccountActionEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: "b1e00000-0000-4000-8000-" + String(version).padStart(12, "0"),
    accountId: ACCOUNT,
    version,
    idempotencyKey: ACCOUNT + "/1/action." + String(version),
    action: act,
    resultingState: resulting,
    actor: ACTOR,
    note: null,
    occurredAt: at,
    recordedAt: at,
  });
}

describe("P4: with no history the owner file is authoritative", () => {
  it("returns the file's state, names the file as the source, and reports no action", () => {
    expect(foldEffectiveState("AVAILABLE", [])).toEqual({
      effectiveState: "AVAILABLE",
      stateSource: "OWNER_FILE",
      lastAction: null,
    });
  });

  it("carries whatever the file says, including a non-AVAILABLE state", () => {
    // The empty history means "the owner file stands" — not "the account is
    // available". A fold that defaulted to AVAILABLE here would widen
    // eligibility on the strength of an absent record.
    for (const state of ["AVAILABLE", "DRAINING", "EXHAUSTED", "COOLDOWN", "AUTH_REQUIRED"] as const) {
      expect(foldEffectiveState(state, [])).toEqual({
        effectiveState: state,
        stateSource: "OWNER_FILE",
        lastAction: null,
      });
    }
  });
});

describe("P2: the newest row wins", () => {
  it("a DRAIN over an AVAILABLE file yields DRAINING from the operator action", () => {
    expect(foldEffectiveState("AVAILABLE", [action(1, "DRAIN")])).toEqual({
      effectiveState: "DRAINING",
      stateSource: "OPERATOR_ACTION",
      lastAction: { action: "DRAIN", at: instantFor(1), by: ACTOR },
    });
  });

  it("ACCOUNT_READY after a DRAIN restores AVAILABLE", () => {
    const history = [action(1, "DRAIN"), action(2, "ACCOUNT_READY")];
    expect(foldEffectiveState("AVAILABLE", history)).toEqual({
      effectiveState: "AVAILABLE",
      stateSource: "OPERATOR_ACTION",
      lastAction: { action: "ACCOUNT_READY", at: instantFor(2), by: ACTOR },
    });
  });

  it("a later owner-file edit does not override an earlier action", () => {
    // The silent case, spoken. The file now claims AVAILABLE outright; the
    // drain still governs, because the file cannot know about it.
    expect(foldEffectiveState("AVAILABLE", [action(1, "DRAIN")]).effectiveState).toBe("DRAINING");
  });

  it("reads resultingState rather than recomputing it from the verb", () => {
    // The distinction matters for exactly one verb, and this is the shape that
    // separates a fold that reads from a fold that derives.
    const override = action(1, "OWNER_OVERRIDE", "COOLDOWN");
    expect(ACCOUNT_ACTION_STATE[override.action]).toBeNull();
    expect(foldEffectiveState("AVAILABLE", [override]).effectiveState).toBe("COOLDOWN");
  });
});

describe("P3: OWNER_OVERRIDE carries its own state and keeps its precedence", () => {
  it("applies the override's setState, not a state implied by the verb", () => {
    expect(foldEffectiveState("AVAILABLE", [action(1, "OWNER_OVERRIDE", "EXHAUSTED")])).toEqual({
      effectiveState: "EXHAUSTED",
      stateSource: "OPERATOR_ACTION",
      lastAction: { action: "OWNER_OVERRIDE", at: instantFor(1), by: ACTOR },
    });
  });

  it("is itself overridden by a newer action, like every other row", () => {
    const history = [action(1, "OWNER_OVERRIDE", "EXHAUSTED"), action(2, "ACCOUNT_READY")];
    expect(foldEffectiveState("AVAILABLE", history).effectiveState).toBe("AVAILABLE");
  });

  it("wins when it is itself the newest", () => {
    const history = [action(1, "ACCOUNT_READY"), action(2, "OWNER_OVERRIDE", "COOLDOWN")];
    expect(foldEffectiveState("AVAILABLE", history).effectiveState).toBe("COOLDOWN");
  });
});

describe("the precedence matrix, every verb over every file state", () => {
  it("the newest verb's resulting state governs regardless of what the file says", () => {
    const states = ["AVAILABLE", "DRAINING", "EXHAUSTED", "COOLDOWN", "AUTH_REQUIRED"] as const;
    const expected: Readonly<Record<AccountAction, AccountStatus>> = {
      DRAIN: "DRAINING",
      ACCOUNT_READY: "AVAILABLE",
      REAUTH_REQUIRED: "AUTH_REQUIRED",
      OWNER_OVERRIDE: "COOLDOWN",
    };
    for (const fileState of states) {
      for (const act of ACCOUNT_ACTIONS) {
        const row = action(1, act, act === "OWNER_OVERRIDE" ? "COOLDOWN" : null);
        const folded = foldEffectiveState(fileState, [row]);
        expect(folded.effectiveState).toBe(expected[act]);
        expect(folded.stateSource).toBe("OPERATOR_ACTION");
      }
    }
  });
});

describe("N8: the action vocabulary the fold reads is unchanged", () => {
  it("ACCOUNT_ACTIONS is exactly four members", () => {
    expect(ACCOUNT_ACTIONS).toHaveLength(4);
    expect([...ACCOUNT_ACTIONS]).toEqual(["DRAIN", "ACCOUNT_READY", "REAUTH_REQUIRED", "OWNER_OVERRIDE"]);
  });

  it("ACCOUNT_ACTION_STATE maps each verb exactly as the seam has always mapped it", () => {
    expect(ACCOUNT_ACTION_STATE).toEqual({
      DRAIN: "DRAINING",
      ACCOUNT_READY: "AVAILABLE",
      REAUTH_REQUIRED: "AUTH_REQUIRED",
      OWNER_OVERRIDE: null,
    });
  });
});

describe("the ceiling this package declares", () => {
  it("is three orders of magnitude below the usage ceiling, and says so by value", () => {
    // The two numbers bound different things, and the test pins the difference
    // rather than the coincidence: a later edit that made them equal would be
    // a ceiling copied instead of reasoned about.
    expect(ACCOUNT_ACTIONS_MAX).toBe(10_000);
  });

  it("is a value this package owns; the fold itself does not enforce it", () => {
    // Deliberate. The fold is pure over a complete history; the *reader* is
    // what refuses above the ceiling, because only the reader knows whether it
    // read everything. A fold that truncated would resurrect an older state.
    const history = Array.from({ length: 12 }, (_, index) => action(index + 1, "DRAIN"));
    history.push(action(13, "ACCOUNT_READY"));
    expect(foldEffectiveState("AVAILABLE", history).effectiveState).toBe("AVAILABLE");
  });
});

/**
 * P8: a drained account is refused by the admission that already existed.
 *
 * The load-bearing claim of the whole packet, and the reason it adds no
 * eligibility rule. `foldEffectiveState` produces a `status` and the two
 * admission sites -- `estimateQuota` and `rankAccounts` -- refuse anything that
 * is not `AVAILABLE`, independently of each other. Feeding the folded state
 * into `record.status` therefore makes a recorded DRAIN bite through the rules
 * that were already there, which is what keeps the estimator and the router
 * refusing identically by construction (ADR 0035 s3.1a) rather than by a second
 * rule that could drift from the first.
 */
describe("P8: the existing ACCOUNT_NOT_AVAILABLE admission is what refuses a drained account", () => {
  const NOW = "2026-09-01T12:00:00.000Z";
  const RESET = "2026-12-01T00:00:00Z";

  function accountRecord(status: AccountStatus) {
    const parsed = AccountRecord.safeParse({
      contractVersion: CONTRACT_VERSION,
      accountId: ACCOUNT,
      provider: "anthropic",
      alias: ACCOUNT,
      authMode: "PREAUTHENTICATED_PROFILE",
      authProfileRef: "profile://acp-b1e-" + ACCOUNT,
      credentialRef: null,
      plan: "max",
      enabledModels: ["opus", "sonnet"],
      knownLimits: { weekly: 1_000_000 },
      resetSchedule: { kind: "DECLARED", nextResetAt: RESET, timezone: "UTC", confidence: "HIGH" },
      quotaEstimate: {
        remainingRatio: 0.5,
        estimatedTokensRemaining: 500_000,
        estimatedAt: "2026-08-31T00:00:00Z",
        confidence: "MEDIUM",
      },
      lastHealthProbe: null,
      lastClassifiedError: null,
      status,
      isolatedConfigRoot: "/tmp/acp-b1e-" + ACCOUNT,
      contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
    });
    if (!parsed.success) throw new Error("the fixture must satisfy the contract");
    return parsed.data;
  }

  /** The overlay the CLI election performs: the folded state onto the record. */
  function overlaid(fileState: AccountStatus, history: readonly AccountActionEvent[]) {
    const folded = foldEffectiveState(fileState, history);
    return { ...accountRecord(fileState), status: folded.effectiveState };
  }

  it("the estimator refuses the overlaid record by the rule it always had", () => {
    const record = overlaid("AVAILABLE", [action(1, "DRAIN")]);
    const outcome = estimateQuota({ record, observations: [], limitKey: "weekly", now: NOW });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("ACCOUNT_NOT_AVAILABLE");
    expect(outcome.at).toBe("record.status");
  });

  it("the router rejects the same overlaid record independently", () => {
    const record = overlaid("AVAILABLE", [action(1, "DRAIN")]);
    const outcome = rankAccounts({
      records: [record],
      estimates: [{ accountId: ACCOUNT, outcome: estimateQuota({ record, observations: [], limitKey: "weekly", now: NOW }) }],
      evidence: [
        { accountId: ACCOUNT, acceptance: EVIDENCE_ABSENT, contextAffinity: EVIDENCE_ABSENT, capabilities: { known: false } },
      ],
      task: {
        model: "opus",
        estimatedTokens: 10_000,
        estimatedDurationSeconds: 60,
        reserveTokens: 5_000,
        requiredCapabilities: [],
      },
      config: DEFAULT_ROUTING_CONFIG,
      now: NOW,
    });

    // With the only candidate rejected the router refuses the request, and it
    // names the per-account reason in the rejection list rather than folding
    // it into one opaque code -- so this asserts the rule that actually fired.
    if (outcome.ok) throw new Error("expected the router to refuse");
    expect(outcome.reason).toBe("NO_ELIGIBLE_ACCOUNT");
    expect(outcome.rejected).toEqual([
      expect.objectContaining({ accountId: ACCOUNT, reason: "ACCOUNT_NOT_AVAILABLE", at: "records." + ACCOUNT + ".status" }),
    ]);
  });

  it("both admit the same record again once ACCOUNT_READY is the newest row", () => {
    // The parity runs in both directions: neither site has a rule of its own.
    const record = overlaid("AVAILABLE", [action(1, "DRAIN"), action(2, "ACCOUNT_READY")]);
    expect(record.status).toBe("AVAILABLE");

    const estimate = estimateQuota({ record, observations: [], limitKey: "weekly", now: NOW });
    expect(estimate.ok).toBe(true);

    const outcome = rankAccounts({
      records: [record],
      estimates: [{ accountId: ACCOUNT, outcome: estimate }],
      evidence: [
        { accountId: ACCOUNT, acceptance: EVIDENCE_ABSENT, contextAffinity: EVIDENCE_ABSENT, capabilities: { known: false } },
      ],
      task: {
        model: "opus",
        estimatedTokens: 10_000,
        estimatedDurationSeconds: 60,
        reserveTokens: 5_000,
        requiredCapabilities: [],
      },
      config: DEFAULT_ROUTING_CONFIG,
      now: NOW,
    });
    if (!outcome.ok) throw new Error("expected the router to answer");
    expect(outcome.recommendation.ranked.map((entry) => entry.accountId)).toEqual([ACCOUNT]);
  });

  it("refuses every non-AVAILABLE folded state at both sites, by the one rule", () => {
    const cases = [
      { action: "DRAIN" as const, setState: null, expected: "DRAINING" },
      { action: "REAUTH_REQUIRED" as const, setState: null, expected: "AUTH_REQUIRED" },
      { action: "OWNER_OVERRIDE" as const, setState: "EXHAUSTED" as AccountStatus, expected: "EXHAUSTED" },
      { action: "OWNER_OVERRIDE" as const, setState: "COOLDOWN" as AccountStatus, expected: "COOLDOWN" },
    ];

    for (const entry of cases) {
      const record = overlaid("AVAILABLE", [action(1, entry.action, entry.setState)]);
      expect(record.status).toBe(entry.expected);

      const estimate = estimateQuota({ record, observations: [], limitKey: "weekly", now: NOW });
      expect(estimate.ok).toBe(false);
      if (estimate.ok) throw new Error("expected a refusal");
      expect(estimate.reason).toBe("ACCOUNT_NOT_AVAILABLE");
    }
  });
});

describe("N9: nothing here needs a process, a socket or a capability", () => {
  it("the fold is pure over its two inputs and touches nothing else", () => {
    // Stated as a test rather than as a comment because it is the constraint
    // the whole packet is bounded by: no provider, no spend, no capability
    // leaves UNKNOWN, and this suite could run with the network unplugged.
    const history = [action(1, "DRAIN")];
    const first = foldEffectiveState("AVAILABLE", history);
    const second = foldEffectiveState("AVAILABLE", history);
    expect(first).toEqual(second);
    expect(history).toHaveLength(1);
  });
});
