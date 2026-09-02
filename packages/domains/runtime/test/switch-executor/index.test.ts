import { AccountRecord, CONTRACT_VERSION } from "@acp/contracts";
import type { Lease } from "@acp/contracts";
import { DEFAULT_ROUTING_CONFIG, decideSwitch } from "@acp/accounts";
import type { RoutingRequest } from "@acp/accounts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import { LIFECYCLE_PLAN } from "../../src/core/lifecycle/index.js";
import { appendPlanStep } from "../../src/core/step-executor/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import { executeSwitchPlan } from "../../src/switch-executor/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";
import { deterministicUuid } from "../../src/core/coordinates/index.js";

/**
 * Evidence for the switch executor.
 *
 * The decision module returns a plan and never acts; this suite proves the
 * executor plays exactly that plan, and closes the P7B forward-carry: the
 * `LEASE_REVOKED` payload now names a real lease as well as the account.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const AT = "2026-08-30T15:00:00.000Z";
const RESET_AT = "2026-08-30T16:00:00.000Z";

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
    invocationId: deterministicUuid("switch/" + taskId),
    submittedAt: AT,
    submissionDigest: "d".repeat(64),
  };
}

function record(accountId: string): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId,
    provider: "anthropic",
    alias: accountId,
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://p8w-" + accountId,
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
    isolatedConfigRoot: "/tmp/acp-p8w-" + accountId,
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

function switchPlan(): ReturnType<typeof decideSwitch> {
  return decideSwitch({
    trigger: "QUOTA_EXHAUSTED",
    currentAccountId: "current",
    routing: routing(["current", "spare"]),
  });
}

function leaseFor(worktreePath: string): Lease {
  return {
    leaseId: "9b9b9b9b-0000-4000-8000-000000000001",
    worktreePath,
    holder: EMITTED_BY,
    acquiredAt: AT,
    expiresAt: RESET_AT,
  };
}

/** Seed one more discovered task into a ledger that is already open. */
function addTask(ledger: Ledger, taskId: string): DurableInvocation {
  const invocation = invocationFor(taskId);
  const context: BeatContext = {
    ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
    invocation,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    initiativeId: INITIATIVE_ID,
  };
  const step = LIFECYCLE_PLAN[0];
  if (step === undefined) throw new Error("no plan step");
  appendPlanStep(context, step);
  return invocation;
}

function openWithTask(id: string, taskId: string): { ledger: Ledger; invocation: DurableInvocation } {
  const root = scenario(id);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const invocation = invocationFor(taskId);
  const context: BeatContext = {
    ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
    invocation,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    initiativeId: INITIATIVE_ID,
  };
  const step = LIFECYCLE_PLAN[0];
  if (step === undefined) throw new Error("no plan step");
  appendPlanStep(context, step);
  return { ledger, invocation };
}

describe("the executor plays exactly the plan it was given", () => {
  it("appends the plan's events in order, as same-state passthroughs", () => {
    const { ledger, invocation } = openWithTask(
      "switch-order",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c01",
    );
    const outcome = switchPlan();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a switch plan");

    const before = ledger.getTask(invocation.taskId)?.currentState;
    const result = executeSwitchPlan({
      ledger,
      invocation,
      plan: outcome.plan,
      emittedBy: EMITTED_BY,
      lease: leaseFor("/tmp/acp-p8w-worktree"),
      taskState: before ?? "DISCOVERED",
    });

    expect(result.appended).toBe(outcome.plan.events.length);
    expect(result.events.map((event) => event.type)).toEqual(
      outcome.plan.events.map((candidate) => candidate.type),
    );

    // The state walks with the plan rather than staying put. Everything before
    // the plan's own TASK_STATE_CHANGED is a passthrough at the state the task
    // was in; the change is a real transition to the state the plan names; and
    // everything after is a passthrough at the new state. A contract that
    // refuses a state-change event which changes nothing is what makes this
    // the only lawful shape.
    const changeIndex = result.events.findIndex((event) => event.type === "TASK_STATE_CHANGED");
    expect(changeIndex).toBeGreaterThanOrEqual(0);

    result.events.forEach((event, index) => {
      if (index < changeIndex) {
        expect({ index, from: event.fromState, to: event.toState }).toEqual({
          index,
          from: before,
          to: before,
        });
      } else if (index === changeIndex) {
        expect(event.fromState).toBe(before);
        expect(event.toState).toBe(outcome.plan.taskState);
      } else {
        expect({ index, from: event.fromState, to: event.toState }).toEqual({
          index,
          from: outcome.plan.taskState,
          to: outcome.plan.taskState,
        });
      }
    });

    expect(ledger.getTask(invocation.taskId)?.currentState).toBe(outcome.plan.taskState);
  });

  it("is deterministic: replaying the same plan appends nothing", () => {
    const { ledger, invocation } = openWithTask(
      "switch-replay",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c02",
    );
    const outcome = switchPlan();
    if (!outcome.ok) throw new Error("expected a switch plan");
    const input = {
      ledger,
      invocation,
      plan: outcome.plan,
      emittedBy: EMITTED_BY,
      lease: leaseFor("/tmp/acp-p8w-worktree"),
      taskState: ledger.getTask(invocation.taskId)?.currentState ?? "DISCOVERED",
    };

    const first = executeSwitchPlan(input);
    const countAfterFirst = ledger.status().eventCount;
    const second = executeSwitchPlan(input);

    expect(first.appended).toBeGreaterThan(0);
    expect(second.appended).toBe(0);
    expect(ledger.status().eventCount).toBe(countAfterFirst);
  });
});

describe("the LEASE_REVOKED enrichment closes the P7B forward-carry", () => {
  it("names the real lease beside the account the module knew", () => {
    const { ledger, invocation } = openWithTask(
      "switch-enrich",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c03",
    );
    const outcome = switchPlan();
    if (!outcome.ok) throw new Error("expected a switch plan");
    const lease = leaseFor("/tmp/acp-p8w-worktree");

    const result = executeSwitchPlan({
      ledger,
      invocation,
      plan: outcome.plan,
      emittedBy: EMITTED_BY,
      lease,
      taskState: ledger.getTask(invocation.taskId)?.currentState ?? "DISCOVERED",
    });

    const revoked = result.events.find((event) => event.type === "LEASE_REVOKED");
    expect(revoked).toBeDefined();
    // Additive: the module's own accountId survives, and the enforcement
    // plane's four fields join it, so one event now satisfies both readers.
    expect(revoked?.payload).toEqual({
      accountId: "current",
      leaseId: lease.leaseId,
      worktreePath: lease.worktreePath,
      holder: lease.holder,
      cause: "ACCOUNT_SWITCH",
    });
  });

  it("refuses to revoke without the lease being revoked", () => {
    const { ledger, invocation } = openWithTask(
      "switch-no-lease",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c04",
    );
    const outcome = switchPlan();
    if (!outcome.ok) throw new Error("expected a switch plan");

    expect(() =>
      executeSwitchPlan({
        ledger,
        invocation,
        plan: outcome.plan,
        emittedBy: EMITTED_BY,
        lease: null,
        taskState: ledger.getTask(invocation.taskId)?.currentState ?? "DISCOVERED",
      }),
    ).toThrow(SupervisorError);
    // Nothing was appended: the refusal happens before the first append.
    expect(ledger.status().eventCount).toBe(1);
  });
});

describe("the executor holds no authority it was not given", () => {
  it("refuses a task the ledger has never seen", () => {
    const root = scenario("switch-unknown-task");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);
    const outcome = switchPlan();
    if (!outcome.ok) throw new Error("expected a switch plan");

    expect(() =>
      executeSwitchPlan({
        ledger,
        invocation: invocationFor("9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c05"),
        plan: outcome.plan,
        emittedBy: EMITTED_BY,
        lease: leaseFor("/tmp/acp-p8w-worktree"),
        taskState: "DISCOVERED",
      }),
    ).toThrow(SupervisorError);
    expect(ledger.status().eventCount).toBe(0);
  });
});

describe("the causal thread, and the cross-task edge it produces (P8-8E2, C1)", () => {
  it("gives every appended event the invocation's correlation", () => {
    const { ledger, invocation } = openWithTask(
      "switch-correlation",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c11",
    );
    const outcome = switchPlan();
    if (!outcome.ok) throw new Error("expected a switch plan");

    const result = executeSwitchPlan({
      ledger,
      invocation,
      plan: outcome.plan,
      emittedBy: EMITTED_BY,
      lease: leaseFor("/tmp/acp-p8w-worktree"),
      taskState: ledger.getTask(invocation.taskId)?.currentState ?? "DISCOVERED",
    });

    const correlations = new Set(result.events.map((event) => event.correlationId));
    expect(correlations).toEqual(new Set([invocation.invocationId]));
    // No trigger was named, so no cause is claimed. A switch is decided from
    // routing state rather than from one event, and inventing a cause to fill
    // the field is exactly what the consumer refuses to draw from.
    expect(new Set(result.events.map((event) => event.causationId))).toEqual(new Set([null]));
  });

  /**
   * The packet's proof-of-headline (C1).
   *
   * `deriveGraph` draws an edge for exactly one shape: a TASK row whose
   * `causationId` resolves to an event of a **different** task on the same
   * page. Nothing in the walk can produce that — a walk threads to its own
   * previous step, which is the same task and is therefore timeline threading,
   * not a graph edge. The switch flow can, because its trigger genuinely lives
   * on another task.
   *
   * This drill builds that shape end to end in the ledger and asserts it in
   * `deriveGraph`'s own terms, without importing the view: the predicate is
   * quoted here so the two cannot drift silently apart.
   */
  it("produces at least one cross-task cause — the shape deriveGraph turns into an edge", () => {
    // ONE ledger, two tasks: `deriveGraph` resolves causation against the events
    // on the page it was handed, so a drill across two ledgers would prove the
    // value and not the edge.
    const { ledger, invocation: triggering } = openWithTask(
      "switch-edge",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c12",
    );
    const switching = addTask(ledger, "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c13");

    const triggerEvent = ledger.listEvents({ taskId: triggering.taskId }).events[0];
    if (triggerEvent === undefined) throw new Error("expected a seeded event on the triggering task");

    const outcome = switchPlan();
    if (!outcome.ok) throw new Error("expected a switch plan");

    const result = executeSwitchPlan({
      ledger,
      invocation: switching,
      plan: outcome.plan,
      emittedBy: EMITTED_BY,
      lease: leaseFor("/tmp/acp-p8w-worktree"),
      taskState: ledger.getTask(switching.taskId)?.currentState ?? "DISCOVERED",
      causedBy: triggerEvent.event.eventId,
    });

    // The page a scoped timeline would hand the view: every event in this
    // ledger, both tasks together.
    const page = ledger.listEvents({}).events;
    const eventIdToTaskId = new Map(page.map((record) => [record.eventId, record.event.taskId]));

    // deriveGraph's predicate, restated so the two cannot drift apart silently:
    // a TASK row whose causationId resolves, ON THIS PAGE, to a different
    // task's event.
    const edges = page.filter((record) => {
      const cause = record.event.causationId;
      if (cause === null) return false;
      const fromTaskId = eventIdToTaskId.get(cause);
      return fromTaskId !== undefined && fromTaskId !== record.event.taskId;
    });

    expect(edges.length).toBeGreaterThan(0);
    expect(result.appended).toBeGreaterThan(0);

    // Each half separately true, so the conjunction cannot pass by coincidence.
    const edge = edges[0];
    if (edge === undefined) throw new Error("expected an edge");
    expect(edge.event.causationId).toBe(triggerEvent.event.eventId);
    expect(edge.event.taskId).toBe(switching.taskId);
    expect(eventIdToTaskId.get(triggerEvent.event.eventId)).toBe(triggering.taskId);
    expect(edge.event.taskId).not.toBe(triggering.taskId);
  });
});
