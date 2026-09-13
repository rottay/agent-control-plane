import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountRecord, CONTRACT_VERSION, ControlPlaneEvent, ResolvedRoute } from "@acp/contracts";
import { CONTROL_PLANE_EVENT_TYPES, EXCEPTIONAL_STATES, LIFECYCLE_STATES } from "@acp/contracts";
import { EXECUTION_REFUSALS, SWITCH_STEP_NAMES } from "@acp/contracts";
import type { HealthProbe, Lease, ResolvedRoute as ResolvedRouteValue } from "@acp/contracts";
import { DEFAULT_ROUTING_CONFIG, SWITCH_STEPS, decideSwitch } from "@acp/accounts";
import type { RoutingRequest, SwitchPlan } from "@acp/accounts";
import { LedgerIdempotencyConflictError, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import { deriveEventCoordinate, deterministicUuid } from "../../src/core/coordinates/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN, OUTCOME_STEP } from "../../src/core/lifecycle/index.js";
import { appendPlanStep, nextStep } from "../../src/core/step-executor/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import { SWITCH_DECLINE_REASONS, executeSwitchPlan } from "../../src/switch-executor/index.js";
import {
  SWITCH_LANDINGS_MAX,
  SWITCH_LANDING_REFUSALS,
  landAccountSwitch,
} from "../../src/switch-landing/index.js";
import type {
  SwitchLandingBinding,
  SwitchLandingInput,
  SwitchLandingOutcome,
} from "../../src/switch-landing/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";
import { recordTokenObservation, usageTransitionId } from "../../src/usage/index.js";

/**
 * Evidence for the durable switch landing (V2-B1f/F5).
 *
 * A played switch leaves a task at `QUOTA_BLOCKED` with a started row naming a
 * destination and no plan step leaving that state. This suite is about the one
 * module that finishes it: what it reads, what it refuses, and the single
 * append it is allowed to make.
 *
 * Every prestate here is built by the REAL producers — the plan's own steps
 * through `appendPlanStep`, the switch through `executeSwitchPlan` — so what
 * the landing reads back is exactly the shape the plane writes. Nothing is
 * spawned, no network is reached and no credential is named: the port is a
 * read-only double whose `start` fails the test if it is ever called.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const AT = "2026-08-30T15:00:00.000Z";
const RESET_AT = "2026-08-30T16:00:00.000Z";

const SOURCE_ACCOUNT = "acct-source";
const OTHER_ACCOUNT = "acct-other";
const DESTINATION_ACCOUNT = "acct-destination";

/**
 * One admitted route for every fixture in this file (V2-B1c).
 *
 * A route is required, never defaulted, so every construction site states one.
 * It satisfies the contract's own refinement: a CLI_SUBSCRIPTION route names a
 * provider the kernel lists as one.
 */
const TEST_ROUTE: ResolvedRouteValue = {
  provider: "claude",
  model: "opus",
  accountId: SOURCE_ACCOUNT,
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

/**
 * The admitted bindings, ordered so a positional shortcut cannot pass.
 *
 * The destination is neither the route's own account nor the first entry, so a
 * landing that reached for `bindings[0]` or for `route.accountId` would land
 * on the wrong account and P1 would say so.
 */
const BINDINGS: readonly SwitchLandingBinding[] = Object.freeze([
  { accountId: SOURCE_ACCOUNT, provider: "claude" },
  { accountId: OTHER_ACCOUNT, provider: "claude" },
  { accountId: DESTINATION_ACCOUNT, provider: "claude" },
]);

const scenarios: string[] = [];
const ledgers: Ledger[] = [];

function scenario(id: string): ScenarioRoot {
  scenarios.push(id);
  return resolveScenarioRoot(id);
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const id of scenarios.splice(0)) removeScenarioRoot(id);
});

function invocationFor(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("landing/" + taskId),
    submittedAt: AT,
    submissionDigest: "e".repeat(64),
  };
}

function contextFor(ledger: Ledger, invocation: DurableInvocation): BeatContext {
  return {
    ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
    invocation,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    route: TEST_ROUTE,
    initiativeId: INITIATIVE_ID,
  };
}

function leaseFor(): Lease {
  return {
    leaseId: "9b9b9b9b-0000-4000-8000-0000000000f5",
    worktreePath: "/tmp/acp-f5-fixture",
    holder: EMITTED_BY,
    acquiredAt: AT,
    expiresAt: RESET_AT,
  };
}

// ---------------------------------------------------------------------------
// A real decided plan, from the real elector
// ---------------------------------------------------------------------------

function record(accountId: string): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId,
    provider: "anthropic",
    alias: accountId,
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://f5-" + accountId,
    credentialRef: null,
    plan: "max",
    enabledModels: ["opus", "sonnet"],
    knownLimits: { weekly: 1_000_000 },
    resetSchedule: { kind: "DECLARED", nextResetAt: RESET_AT, timezone: "UTC", confidence: "HIGH" },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      estimatedAt: AT,
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-f5-" + accountId,
    contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
  });
  if (!parsed.success) throw new Error("fixture is not a valid AccountRecord");
  return parsed.data;
}

function routing(accountIds: readonly string[]): RoutingRequest {
  return {
    records: accountIds.map(record),
    estimates: accountIds.map((accountId) => ({
      accountId,
      outcome: {
        ok: true as const,
        estimate: {
          accountId,
          limitKey: "weekly",
          limitTokens: 1_000_000,
          observedTokensUsed: 500_000,
          observationCount: 3,
          remainingRatio: 0.5,
          estimatedTokensRemaining: 500_000,
          overBudget: false,
          confidence: "MEDIUM" as const,
          estimatedAt: AT,
          reset: {
            kind: "DECLARED" as const,
            nextResetAt: RESET_AT,
            timezone: "UTC",
            millisUntilReset: 3_600_000,
            confidence: "HIGH" as const,
          },
        },
      },
    })),
    evidence: accountIds.map((accountId) => ({
      accountId,
      acceptance: { known: false as const },
      contextAffinity: { known: false as const },
      capabilities: { known: false as const },
    })),
    task: {
      estimatedTokens: 10_000,
      estimatedDurationSeconds: 60,
      reserveTokens: 5_000,
      model: "opus",
      requiredCapabilities: [],
    },
    config: DEFAULT_ROUTING_CONFIG,
    now: AT,
  };
}

/** The real elector's SWITCH plan, from the source account to the spare. */
function decidedPlan(): SwitchPlan {
  const outcome = decideSwitch({
    trigger: "QUOTA_EXHAUSTED",
    currentAccountId: SOURCE_ACCOUNT,
    routing: routing([SOURCE_ACCOUNT, DESTINATION_ACCOUNT]),
  });
  if (!outcome.ok) throw new Error("the fixture's own decision was refused");
  return outcome.plan;
}

/** A hand-built plan, for the rows a real decision cannot produce. */
function handBuiltPlan(events: SwitchPlan["events"]): SwitchPlan {
  return {
    kind: "SWITCH",
    accountStatus: "EXHAUSTED",
    taskState: "QUOTA_BLOCKED",
    steps: [...SWITCH_STEP_NAMES],
    selectedAccountId: DESTINATION_ACCOUNT,
    events,
  };
}

const FOUR_EVENTS: SwitchPlan["events"] = [
  { type: "QUOTA_WARNING", payload: { accountId: SOURCE_ACCOUNT } },
  { type: "TASK_STATE_CHANGED", payload: { toState: "QUOTA_BLOCKED" } },
  { type: "LEASE_REVOKED", payload: { accountId: SOURCE_ACCOUNT } },
  {
    type: "ACCOUNT_SWITCH_STARTED",
    payload: { fromAccountId: SOURCE_ACCOUNT, toAccountId: DESTINATION_ACCOUNT },
  },
];

// ---------------------------------------------------------------------------
// Prestates, built by the real producers
// ---------------------------------------------------------------------------

/** Walk the plan's own steps, in order, up to and including `through`. */
function walkTo(ledger: Ledger, invocation: DurableInvocation, through: number): void {
  const context = contextFor(ledger, invocation);
  for (let index = 0; index <= through; index += 1) {
    const step = LIFECYCLE_PLAN[index];
    if (step === undefined) throw new Error("no plan step " + String(index));
    appendPlanStep(context, step);
  }
}

interface Prestate {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
}

/**
 * A task blocked by a played switch: the durable prestate a landing reads.
 *
 * The lifecycle steps are the plan's own and the switch is the executor's own,
 * so the four rows carry the transition ids the plane really writes.
 */
function blocked(
  id: string,
  taskId: string,
  options: { readonly through?: number; readonly plan?: SwitchPlan } = {},
): Prestate {
  const root = scenario(id);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const invocation = invocationFor(taskId);
  const through = options.through ?? INTENT_STEP.index;
  walkTo(ledger, invocation, through);
  const task = ledger.getTask(taskId);
  if (task === null) throw new Error("the fixture appended no task");
  executeSwitchPlan({
    ledger,
    invocation,
    plan: options.plan ?? handBuiltPlan(FOUR_EVENTS),
    emittedBy: EMITTED_BY,
    lease: leaseFor(),
    taskState: task.currentState,
    causedBy: null,
  });
  return { ledger, invocation };
}

// ---------------------------------------------------------------------------
// The doubles
// ---------------------------------------------------------------------------

interface ProbeDouble {
  readonly port: SwitchLandingInput["port"];
  readonly probed: ResolvedRouteValue[];
  readonly started: number;
}

/**
 * A read-only port double.
 *
 * `start` is deliberately present and deliberately throwing: the landing must
 * never open a session, and a double that simply lacked the member would prove
 * only that the type was narrow.
 */
function probeDouble(status: HealthProbe["status"] = "UNKNOWN"): ProbeDouble {
  const probed: ResolvedRouteValue[] = [];
  const double = {
    probed,
    started: 0,
    port: {
      healthProbe: (route: ResolvedRouteValue): Promise<HealthProbe> => {
        probed.push(route);
        return Promise.resolve({
          status,
          checkedAt: route.resolvedAt,
          latencyMs: null,
          classifiedError: status === "FAILED" ? "TRANSPORT_UNAVAILABLE" : null,
        });
      },
      start: (): never => {
        double.started += 1;
        throw new Error("the landing opened a session, and it may never open one");
      },
      interrupt: (): never => {
        throw new Error("the landing interrupted a session it never opened");
      },
    },
  };
  return double as unknown as ProbeDouble;
}

interface GateDouble {
  readonly calls: number[];
  readonly gate: (operationIndex: number) => void;
}

function gateDouble(onCall?: () => void): GateDouble {
  const calls: number[] = [];
  return {
    calls,
    gate: (operationIndex: number): void => {
      calls.push(operationIndex);
      if (onCall !== undefined) onCall();
    },
  };
}

function sessionNameFor(taskId: string, attempt: number): (accountId: string) => string {
  // The daemon's own closure, restated for the fixture: the runtime stratum may
  // not import the producer, so the test states what the daemon would pass.
  return (accountId: string): string => taskId + "/" + String(attempt) + "/" + accountId;
}

function landingInput(
  state: Prestate,
  overrides: Partial<SwitchLandingInput> = {},
): SwitchLandingInput {
  const probe = probeDouble();
  const gate = gateDouble();
  return {
    ledger: state.ledger,
    invocation: state.invocation,
    route: TEST_ROUTE,
    bindings: BINDINGS,
    port: probe.port,
    checkConformance: gate.gate,
    sessionIdFor: sessionNameFor(state.invocation.taskId, state.invocation.attempt),
    emittedBy: EMITTED_BY,
    ...overrides,
  };
}

function landed(outcome: SwitchLandingOutcome): Extract<SwitchLandingOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error("expected a landing, got " + outcome.reason + " at " + outcome.at);
  return outcome;
}

function rowsOf(ledger: Ledger, taskId: string): readonly ControlPlaneEvent[] {
  return ledger.listEvents({ taskId, limit: 500 }).events.map((entry) => entry.event);
}

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const LANDING_SOURCE = readFileSync(join(HERE, "..", "..", "src", "switch-landing", "index.ts"), "utf8");
const LIVE_LANDING_SOURCE = LANDING_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ---------------------------------------------------------------------------
// P1-P9: what a landing does
// ---------------------------------------------------------------------------

describe("F5 P1-P9: the switch lands on the account it chose", () => {
  it("P1: lands on the account the started row names, not the route's and not the first binding", async () => {
    const state = blocked("f5-p1", "f5f5f5f5-0000-4000-8000-000000000001");
    const outcome = landed(await landAccountSwitch(landingInput(state)));

    expect(outcome.toAccountId).toBe(DESTINATION_ACCOUNT);
    expect(outcome.route.accountId).toBe(DESTINATION_ACCOUNT);
    // Neither shortcut would have produced it.
    expect(outcome.route.accountId).not.toBe(TEST_ROUTE.accountId);
    expect(outcome.route.accountId).not.toBe(BINDINGS[0]?.accountId);
  });

  it("P2: position 3 is a fact of the real decided plan, not a constant this module trusts", () => {
    // The landing reads `switch.3.account_switch_started`. That name is only
    // true because the elector's SWITCH branch builds four events in one order,
    // so the fixture builds a REAL plan and indexes it rather than asserting
    // the constant against itself.
    const plan = decidedPlan();
    expect(plan.events.map((candidate) => candidate.type)).toEqual([
      "QUOTA_WARNING",
      "TASK_STATE_CHANGED",
      "LEASE_REVOKED",
      "ACCOUNT_SWITCH_STARTED",
    ]);
    expect(plan.events[3]?.type).toBe("ACCOUNT_SWITCH_STARTED");
    expect(plan.events[1]?.type).toBe("TASK_STATE_CHANGED");
    expect(plan.selectedAccountId).toBe(DESTINATION_ACCOUNT);
    // And the executor derives its ids from those positions.
    expect(LIVE_LANDING_SOURCE).toContain("switch.3.account_switch_started");
    expect(LIVE_LANDING_SOURCE).toContain("switch.1.task_state_changed");
  });

  it("P3: the destination route is the submission's route with the account replaced, and nothing else", async () => {
    const state = blocked("f5-p3", "f5f5f5f5-0000-4000-8000-000000000002", { plan: decidedPlan() });
    const outcome = landed(await landAccountSwitch(landingInput(state)));

    expect(outcome.route).toEqual({ ...TEST_ROUTE, accountId: DESTINATION_ACCOUNT });
    expect(outcome.route.provider).toBe(TEST_ROUTE.provider);
    expect(outcome.route.model).toBe(TEST_ROUTE.model);
    expect(outcome.route.transportKind).toBe(TEST_ROUTE.transportKind);
    expect(outcome.route.capabilityPolicyVersion).toBe(TEST_ROUTE.capabilityPolicyVersion);
    expect(outcome.route.resolvedAt).toBe(TEST_ROUTE.resolvedAt);
    // It satisfies the contract's own refinement, CLI provider list included.
    expect(ResolvedRoute.safeParse(outcome.route).success).toBe(true);
  });

  it("P4: the completion carries the coordinates and the payload the design fixes", async () => {
    const state = blocked("f5-p4", "f5f5f5f5-0000-4000-8000-000000000003");
    const sessionIdFor = sessionNameFor(state.invocation.taskId, state.invocation.attempt);
    const outcome = landed(await landAccountSwitch(landingInput(state, { sessionIdFor })));

    const rows = rowsOf(state.ledger, state.invocation.taskId);
    const blockedRow = rows.find((row) => row.transitionId === "switch.1.task_state_changed");
    const startedRow = rows.find((row) => row.transitionId === "switch.3.account_switch_started");

    expect(outcome.event.transitionId).toBe("switch.landed.1");
    expect(outcome.event.type).toBe("ACCOUNT_SWITCH_COMPLETED");
    expect(outcome.event.fromState).toBe("QUOTA_BLOCKED");
    // Read from the blocked row, never a literal.
    expect(outcome.event.toState).toBe(blockedRow?.fromState);
    expect(outcome.event.toState).toBe("RUNNING");
    expect(outcome.event.correlationId).toBe(state.invocation.invocationId);
    expect(outcome.event.causationId).toBe(startedRow?.eventId);
    // The payload is exactly four members, and the session name is the
    // closure's answer for the destination — never derived in this stratum.
    expect(outcome.event.payload).toEqual({
      fromAccountId: SOURCE_ACCOUNT,
      toAccountId: DESTINATION_ACCOUNT,
      sessionId: sessionIdFor(DESTINATION_ACCOUNT),
      generation: 1,
    });
    expect(state.ledger.getTask(state.invocation.taskId)?.currentState).toBe("RUNNING");
  });

  it("P5: the gate is called once, with the intent's own index, before the append", async () => {
    const first = blocked("f5-p5-open", "f5f5f5f5-0000-4000-8000-000000000004");
    const opened = gateDouble();
    await landAccountSwitch(landingInput(first, { checkConformance: opened.gate }));
    expect(opened.calls).toEqual([INTENT_STEP.index]);
    expect(
      rowsOf(first.ledger, first.invocation.taskId).filter(
        (row) => row.type === "ACCOUNT_SWITCH_COMPLETED",
      ),
    ).toHaveLength(1);

    // And a gate that throws leaves the head exactly where it was: the call
    // order is asserted, not inferred.
    const second = blocked("f5-p5-shut", "f5f5f5f5-0000-4000-8000-000000000005");
    const before = second.ledger.status().eventCount;
    const shut = gateDouble(() => {
      throw new Error("WRITE_SET_VIOLATION_DETECTED: the walk wrote outside its declared set");
    });
    await expect(
      landAccountSwitch(landingInput(second, { checkConformance: shut.gate })),
    ).rejects.toThrow("WRITE_SET_VIOLATION_DETECTED");
    expect(shut.calls).toEqual([INTENT_STEP.index]);
    expect(second.ledger.status().eventCount).toBe(before);
    expect(
      rowsOf(second.ledger, second.invocation.taskId).some(
        (row) => row.type === "ACCOUNT_SWITCH_COMPLETED",
      ),
    ).toBe(false);
  });

  it("P6: no session is opened at all — only the read-only probe is reached", async () => {
    const state = blocked("f5-p6", "f5f5f5f5-0000-4000-8000-000000000006");
    const probe = probeDouble();
    const outcome = landed(await landAccountSwitch(landingInput(state, { port: probe.port })));

    expect(probe.probed).toHaveLength(1);
    expect(probe.probed[0]?.accountId).toBe(DESTINATION_ACCOUNT);
    expect(probe.started).toBe(0);
    // The session id is a NAME the walk will execute under, not a claim that a
    // process exists.
    expect(outcome.sessionId).toContain(DESTINATION_ACCOUNT);
  });

  it("P7: a repeated landing appends once and returns the same completion", async () => {
    const state = blocked("f5-p7", "f5f5f5f5-0000-4000-8000-000000000007");
    const first = landed(await landAccountSwitch(landingInput(state)));
    const after = state.ledger.status().eventCount;
    const second = landed(await landAccountSwitch(landingInput(state)));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(second.route).toEqual(first.route);
    expect(state.ledger.status().eventCount).toBe(after);
  });

  it("P8: a durable OUTCOME does not refuse the landing (R1)", async () => {
    // The crash window after an effect completed is legitimate, and refusing a
    // durable OUTCOME would strand it. The step executor already owns whether
    // that means resume or skip, in one line.
    const state = blocked("f5-p8", "f5f5f5f5-0000-4000-8000-000000000008", {
      through: OUTCOME_STEP.index,
    });
    const outcome = landed(await landAccountSwitch(landingInput(state)));
    expect(outcome.event.type).toBe("ACCOUNT_SWITCH_COMPLETED");
    expect(outcome.event.toState).toBe("RUNNING");

    // And the resumed walk's next step is the one after the outcome.
    const context = contextFor(state.ledger, state.invocation);
    expect(nextStep(context, "RUNNING").index).toBe(OUTCOME_STEP.index + 1);
  });

  it("P9: the completion is derived — two landings a second apart are byte-identical", async () => {
    const first = blocked("f5-p9-a", "f5f5f5f5-0000-4000-8000-000000000009");
    const one = landed(await landAccountSwitch(landingInput(first)));
    const second = blocked("f5-p9-b", "f5f5f5f5-0000-4000-8000-000000000009");
    const two = landed(await landAccountSwitch(landingInput(second)));

    expect(two.event).toEqual(one.event);
    expect(two.event.occurredAt).toBe(AT);
    expect(two.event.recordedAt).toBe(AT);
    // No clock and no random source anywhere in the module.
    for (const forbidden of ["Date.now", "new Date", "randomUUID", "Math.random"]) {
      expect({ forbidden, present: LIVE_LANDING_SOURCE.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// N1-N14: what a landing refuses, and what it never becomes
// ---------------------------------------------------------------------------

describe("F5 N1-N14: the landing refuses rather than guessing", () => {
  it("N1: an unbound destination refuses by name, and nothing falls back", async () => {
    const state = blocked("f5-n1", "f5f5f5f5-0000-4000-8000-000000000011");
    const before = state.ledger.status().eventCount;
    const outcome = await landAccountSwitch(
      landingInput(state, {
        bindings: [
          { accountId: SOURCE_ACCOUNT, provider: "claude" },
          { accountId: OTHER_ACCOUNT, provider: "claude" },
        ],
      }),
    );

    expect(outcome).toEqual({ ok: false, reason: "DESTINATION_UNBOUND", at: "payload.toAccountId" });
    expect(state.ledger.status().eventCount).toBe(before);
    expect(state.ledger.getTask(state.invocation.taskId)?.currentState).toBe("QUOTA_BLOCKED");
  });

  it("N2: no started row, or one naming no destination, refuses SWITCH_NOT_STARTED", async () => {
    const missing = blocked("f5-n2-missing", "f5f5f5f5-0000-4000-8000-000000000012", {
      plan: handBuiltPlan(FOUR_EVENTS.slice(0, 3)),
    });
    const before = missing.ledger.status().eventCount;
    expect(await landAccountSwitch(landingInput(missing))).toEqual({
      ok: false,
      reason: "SWITCH_NOT_STARTED",
      at: "switch.3.account_switch_started",
    });
    expect(missing.ledger.status().eventCount).toBe(before);

    const empty = blocked("f5-n2-empty", "f5f5f5f5-0000-4000-8000-000000000013", {
      plan: handBuiltPlan([
        ...FOUR_EVENTS.slice(0, 3),
        {
          type: "ACCOUNT_SWITCH_STARTED",
          payload: { fromAccountId: SOURCE_ACCOUNT, toAccountId: "" },
        },
      ]),
    });
    expect(await landAccountSwitch(landingInput(empty))).toEqual({
      ok: false,
      reason: "SWITCH_NOT_STARTED",
      at: "payload.toAccountId",
    });
  });

  it("N3: the probe's refusal set is exactly FAILED", async () => {
    const statuses: readonly HealthProbe["status"][] = ["OK", "DEGRADED", "FAILED", "UNKNOWN"];
    const refused: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const state = blocked(
        "f5-n3-" + status.toLowerCase(),
        "f5f5f5f5-0000-4000-8000-00000000002" + String(index),
      );
      const outcome = await landAccountSwitch(
        landingInput(state, { port: probeDouble(status).port }),
      );
      if (!outcome.ok) refused.push(status);
      else expect(outcome.event.type).toBe("ACCOUNT_SWITCH_COMPLETED");
    }
    // A set, so a probe that later learns to answer OK cannot silently change
    // the rule, and UNKNOWN is never read as OK.
    expect(refused).toEqual(["FAILED"]);
  });

  it("N4: RUNNING, a terminal state and an attempt mismatch each refuse by their own name", async () => {
    // A walk that never switched: the ordinary case, and the answer every
    // ordinary start gets.
    const running = scenario("f5-n4-running");
    const runningLedger = openLedger(scenarioLedgerPath(running));
    ledgers.push(runningLedger);
    const runningInvocation = invocationFor("f5f5f5f5-0000-4000-8000-000000000031");
    walkTo(runningLedger, runningInvocation, INTENT_STEP.index);
    expect(
      await landAccountSwitch(
        landingInput({ ledger: runningLedger, invocation: runningInvocation }),
      ),
    ).toEqual({ ok: false, reason: "NOT_BLOCKED", at: "RUNNING" });

    // A task the ledger has never seen owes no landing either.
    const emptyRoot = scenario("f5-n4-empty");
    const emptyLedger = openLedger(scenarioLedgerPath(emptyRoot));
    ledgers.push(emptyLedger);
    expect(
      await landAccountSwitch(
        landingInput({
          ledger: emptyLedger,
          invocation: invocationFor("f5f5f5f5-0000-4000-8000-000000000032"),
        }),
      ),
    ).toEqual({ ok: false, reason: "NOT_BLOCKED", at: "task" });

    // And a blocked task on another attempt refuses by its own name.
    const state = blocked("f5-n4-attempt", "f5f5f5f5-0000-4000-8000-000000000033");
    const stale: DurableInvocation = { ...state.invocation, attempt: state.invocation.attempt + 1 };
    expect(
      await landAccountSwitch(landingInput({ ledger: state.ledger, invocation: stale })),
    ).toEqual({ ok: false, reason: "ATTEMPT_MISMATCH", at: "invocation.attempt" });
  });

  it("N5: the block must have left RUNNING, and the intent must be durable", async () => {
    // (e), the wrong direction: a switch played from RESERVED records a block
    // that leaves a state no landing can resume into.
    const reserved = blocked("f5-n5-reserved", "f5f5f5f5-0000-4000-8000-000000000041", {
      through: 3,
    });
    expect(await landAccountSwitch(landingInput(reserved))).toEqual({
      ok: false,
      reason: "RESUME_STATE_UNSUPPORTED",
      at: "fromState",
    });

    // (f), the same word at a different field: the block left RUNNING, but the
    // INTENT that put it there is not durable under the plan's own key.
    const root = scenario("f5-n5-intent");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);
    const invocation = invocationFor("f5f5f5f5-0000-4000-8000-000000000042");
    walkTo(ledger, invocation, 3);
    const hoisted = deriveEventCoordinate(invocation, "manual.running", 0);
    ledger.append(
      ControlPlaneEvent.parse({
        contractVersion: CONTRACT_VERSION,
        eventId: hoisted.eventId,
        taskId: invocation.taskId,
        attempt: invocation.attempt,
        transitionId: "manual.running",
        idempotencyKey: hoisted.idempotencyKey,
        type: "TASK_STATE_CHANGED",
        fromState: "RESERVED",
        toState: "RUNNING",
        emittedBy: EMITTED_BY,
        occurredAt: hoisted.occurredAt,
        recordedAt: hoisted.recordedAt,
        correlationId: invocation.invocationId,
        causationId: null,
        payload: { taskId: invocation.taskId, toState: "RUNNING" },
      }),
    );
    executeSwitchPlan({
      ledger,
      invocation,
      plan: handBuiltPlan(FOUR_EVENTS),
      emittedBy: EMITTED_BY,
      lease: leaseFor(),
      taskState: "RUNNING",
      causedBy: null,
    });
    expect(await landAccountSwitch(landingInput({ ledger, invocation }))).toEqual({
      ok: false,
      reason: "RESUME_STATE_UNSUPPORTED",
      at: INTENT_STEP.transitionId,
    });
  });

  it("N6: a destination whose binding declares another provider refuses DESTINATION_UNLANDABLE", async () => {
    const state = blocked("f5-n6", "f5f5f5f5-0000-4000-8000-000000000051");
    const before = state.ledger.status().eventCount;
    const outcome = await landAccountSwitch(
      landingInput(state, {
        bindings: [
          { accountId: SOURCE_ACCOUNT, provider: "claude" },
          { accountId: DESTINATION_ACCOUNT, provider: "codex" },
        ],
      }),
    );
    expect(outcome).toEqual({
      ok: false,
      reason: "DESTINATION_UNLANDABLE",
      at: "binding.provider",
    });
    expect(state.ledger.status().eventCount).toBe(before);
  });

  it("N7: one landing per attempt, and the generation is exactly one", async () => {
    const state = blocked("f5-n7", "f5f5f5f5-0000-4000-8000-000000000061");
    const first = landed(await landAccountSwitch(landingInput(state)));
    const after = state.ledger.status().eventCount;
    const probe = probeDouble();
    const gate = gateDouble();
    const second = landed(
      await landAccountSwitch(
        landingInput(state, { port: probe.port, checkConformance: gate.gate }),
      ),
    );

    expect(first.generation).toBe(1);
    expect(first.generation).toBe(SWITCH_LANDINGS_MAX);
    expect(second.generation).toBe(1);
    expect(second.inserted).toBe(false);
    expect(state.ledger.status().eventCount).toBe(after);
    // The found-durable branch does nothing else at all: no probe, no gate.
    expect(probe.probed).toHaveLength(0);
    expect(gate.calls).toHaveLength(0);
    expect(
      rowsOf(state.ledger, state.invocation.taskId).filter(
        (row) => row.type === "ACCOUNT_SWITCH_COMPLETED",
      ),
    ).toHaveLength(1);
  });

  it("N8: F1 and F4d still hold after F5", () => {
    // The executor still refuses a plan that carries a completion, BY NAME,
    // and its claimable prefix has not widened to admit one.
    const state = blocked("f5-n8", "f5f5f5f5-0000-4000-8000-000000000071");
    expect(() =>
      executeSwitchPlan({
        ledger: state.ledger,
        invocation: state.invocation,
        plan: handBuiltPlan([
          ...FOUR_EVENTS,
          { type: "ACCOUNT_SWITCH_COMPLETED", payload: { toAccountId: DESTINATION_ACCOUNT } },
        ]),
        emittedBy: EMITTED_BY,
        lease: leaseFor(),
        taskState: "QUOTA_BLOCKED",
        causedBy: null,
      }),
    ).toThrow(SupervisorError);
    expect(SWITCH_STEPS).toHaveLength(11);
    expect(SWITCH_STEP_NAMES).toHaveLength(11);
    const executor = readFileSync(
      join(HERE, "..", "..", "src", "switch-executor", "index.ts"),
      "utf8",
    );
    const claimable = /const CLAIMABLE_STEPS: readonly SwitchStep\[\] = Object\.freeze\(\[([^\]]*)\]\)/.exec(
      executor,
    );
    expect(claimable?.[1]?.split(",").filter((entry) => entry.trim().length > 0)).toHaveLength(5);
  });

  it("N9: no credential, no transcript, no path — and no provider symbol in the module", async () => {
    const state = blocked("f5-n9", "f5f5f5f5-0000-4000-8000-000000000081");
    const outcome = landed(await landAccountSwitch(landingInput(state)));

    // The contract's own guards ran over the built event, and the payload is
    // four bounded scalars.
    expect(ControlPlaneEvent.safeParse(outcome.event).success).toBe(true);
    const payload = outcome.event.payload;
    expect(Object.keys(payload).sort()).toEqual([
      "fromAccountId",
      "generation",
      "sessionId",
      "toAccountId",
    ]);
    expect(JSON.stringify(payload).length).toBeLessThan(512);
    for (const value of Object.values(payload)) {
      expect(["string", "number"]).toContain(typeof value);
    }
    for (const forbidden of ["/tmp/", "configRoot", "binary", "workdir", "instructions"]) {
      expect({ forbidden, present: JSON.stringify(payload).includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
    // The session name crosses as a closure: this stratum may not import the
    // producer, and restating the scheme would be a second naming scheme.
    for (const symbol of ["executionSessionId", "@acp/providers"]) {
      expect({ symbol, present: LIVE_LANDING_SOURCE.includes(symbol) }).toEqual({
        symbol,
        present: false,
      });
    }
  });

  it("N10: no second registry — every frozen vocabulary is where it was", () => {
    // 33 since P-18/protocolo F, which added the three outbox types on top of
    // D's prompt and response occurrences, C's three effect types and B's
    // `TASK_ATTEMPT_OPENED`. N10 says this packet keeps no registry of its own,
    // not that the contract's vocabulary is frozen against every later packet;
    // the member this stratum actually depends on is named below.
    expect(CONTROL_PLANE_EVENT_TYPES).toHaveLength(33);
    expect(CONTROL_PLANE_EVENT_TYPES).toContain("ACCOUNT_SWITCH_COMPLETED");
    expect(LIFECYCLE_STATES).toHaveLength(10);
    expect(EXCEPTIONAL_STATES).toHaveLength(8);
    expect(EXECUTION_REFUSALS).toHaveLength(5);
    expect(SWITCH_DECLINE_REASONS).toHaveLength(7);

    // F5's vocabulary is its OWN array of eight, and it extends neither frozen
    // set: the five words that are F5's alone appear in neither, and the three
    // it reuses -- `DESTINATION_UNBOUND` and `DESTINATION_UNLANDABLE` from the
    // player, `ROUTE_INVALID` from the port -- are reused deliberately,
    // because they refuse the same thing for the same reason one layer up.
    expect(SWITCH_LANDING_REFUSALS).toHaveLength(8);
    const frozen = [...EXECUTION_REFUSALS, ...SWITCH_DECLINE_REASONS] as readonly string[];
    for (const reason of ["ATTEMPT_MISMATCH", "NOT_BLOCKED", "SWITCH_NOT_STARTED", "RESUME_STATE_UNSUPPORTED", "TRANSPORT_UNHEALTHY"]) {
      expect(SWITCH_LANDING_REFUSALS as readonly string[]).toContain(reason);
      expect(frozen).not.toContain(reason);
    }
    for (const reused of ["DESTINATION_UNBOUND", "DESTINATION_UNLANDABLE", "ROUTE_INVALID"]) {
      expect(SWITCH_LANDING_REFUSALS as readonly string[]).toContain(reused);
      expect(frozen).toContain(reused);
    }
    expect(SWITCH_LANDINGS_MAX).toBe(1);
  });

  it("N11: the usage key does not collide, and it would without the generation", async () => {
    const state = blocked("f5-n11", "f5f5f5f5-0000-4000-8000-000000000091");
    const outcome = landed(await landAccountSwitch(landingInput(state)));

    // The source's row, under the generation an unlanded walk uses.
    recordTokenObservation(state.ledger, {
      invocation: state.invocation,
      kind: "USAGE",
      accountId: SOURCE_ACCOUNT,
      tokens: 1_000,
      transitionId: usageTransitionId(0, INTENT_STEP.index, 0),
      emittedBy: EMITTED_BY,
    });

    // The destination re-executes the SAME operation at the SAME step index.
    // Without the generation the key is identical and the bytes are not.
    expect(() =>
      recordTokenObservation(state.ledger, {
        invocation: state.invocation,
        kind: "USAGE",
        accountId: DESTINATION_ACCOUNT,
        tokens: 2_000,
        transitionId: usageTransitionId(0, INTENT_STEP.index, 0),
        emittedBy: EMITTED_BY,
      }),
    ).toThrow(LedgerIdempotencyConflictError);

    // With it, both rows exist and both are correct.
    recordTokenObservation(state.ledger, {
      invocation: state.invocation,
      kind: "USAGE",
      accountId: DESTINATION_ACCOUNT,
      tokens: 2_000,
      transitionId: usageTransitionId(outcome.generation, INTENT_STEP.index, 0),
      emittedBy: EMITTED_BY,
    });
    const usage = rowsOf(state.ledger, state.invocation.taskId).filter(
      (row) => row.type === "TOKEN_USAGE_RECORDED",
    );
    expect(usage.map((row) => row.transitionId)).toEqual(["usage.0.4.0", "usage.1.4.0"]);
    expect(usage.map((row) => row.payload["accountId"])).toEqual([
      SOURCE_ACCOUNT,
      DESTINATION_ACCOUNT,
    ]);
  });

  it("N12: zero spend and zero network — nothing is spawned and no capability moves", async () => {
    const state = blocked("f5-n12", "f5f5f5f5-0000-4000-8000-000000000101");
    const probe = probeDouble();
    const outcome = landed(await landAccountSwitch(landingInput(state, { port: probe.port })));

    expect(probe.started).toBe(0);
    expect(outcome.event.type).toBe("ACCOUNT_SWITCH_COMPLETED");
    // The module itself can neither spawn nor reach a socket: it names no
    // process module, no fetch and no network primitive.
    for (const forbidden of ["child_process", "node:net", "fetch(", "spawn", "http"]) {
      expect({ forbidden, present: LIVE_LANDING_SOURCE.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  it("N13: the destination is selected by name, and the three lawful finds stay lawful", () => {
    // The law's negative half, over the module it was written for: no
    // positional selection anywhere.
    for (const forbidden of ["bindings[0]", "bindings.at(0)", "destinations.at(0)"]) {
      expect({ forbidden, present: LIVE_LANDING_SOURCE.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
    // The law's positive half: the module names the durable read it selects
    // from. A landing that fell back to the route's own account would pass the
    // negative half vacuously, and this is what catches it.
    expect(LIVE_LANDING_SOURCE).toContain("toAccountId");

    // And the three lawful `find`s on account identity, which serve the route
    // or the decided destination and must never trip the law.
    const packages = resolve(HERE, "..", "..", "..", "..");
    const lawful = [
      join(packages, "entrypoints", "daemon", "src", "daemon-child", "index.ts"),
      // P-13: the composition root left the barrel; the `.find((entry` that
      // serves the route's account lives in the composed ports now, after the
      // escalón-2 partition moved `bindingForRoute` there.
      join(packages, "entrypoints", "daemon", "src", "composition", "ports", "index.ts"),
      join(packages, "domains", "runtime", "src", "switch-executor", "index.ts"),
    ];
    for (const path of lawful) {
      const source = readFileSync(path, "utf8");
      expect({ path, finds: /\.find\(\s*\(entry\)|\.find\(\s*\(candidate\)/.test(source) }).toEqual({
        path,
        finds: true,
      });
      for (const forbidden of ["bindings[0]", "bindings.at(0)", "destinations.at(0)"]) {
        const live = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        expect({ path, forbidden, present: live.includes(forbidden) }).toEqual({
          path,
          forbidden,
          present: false,
        });
      }
    }
  });

  it("N14: the landing records no account state, and creates no second account-action door", async () => {
    const state = blocked("f5-n14", "f5f5f5f5-0000-4000-8000-000000000111");
    await landAccountSwitch(landingInput(state));

    // Not the door: this module appends a control-plane event and never an
    // account action, so F4c's one door stays one door.
    for (const forbidden of ["appendAccountAction", "recordAccountAction", "resultingState"]) {
      expect({ forbidden, present: LIVE_LANDING_SOURCE.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
    // And no account status is invented in a payload, a message or anywhere
    // else in the module's text.
    for (const status of ["EXHAUSTED", "COOLDOWN"]) {
      expect({ status, present: LIVE_LANDING_SOURCE.includes(status) }).toEqual({
        status,
        present: false,
      });
    }
    const types = rowsOf(state.ledger, state.invocation.taskId).map((row) => row.type);
    expect(types).toContain("ACCOUNT_SWITCH_COMPLETED");
    expect(types).not.toContain("CHECKPOINT_WRITTEN");
  });
});
