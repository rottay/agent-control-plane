import { AccountRecord, CONTRACT_VERSION } from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import type { Lease } from "@acp/contracts";
import { DEFAULT_ROUTING_CONFIG, SWITCH_STEPS, decideSwitch } from "@acp/accounts";
import type { RoutingRequest, SwitchEvent, SwitchPlan } from "@acp/accounts";
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
 * One admitted route for every fixture in this file (V2-B1c).
 *
 * A route is required, never defaulted, so every construction site states one.
 * It satisfies the contract's own refinement: a CLI_SUBSCRIPTION route names a
 * provider the kernel lists as one.
 */
const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

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
    route: TEST_ROUTE,
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
    route: TEST_ROUTE,
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


/**
 * V2-B1f/F1: the executor reads the steps, not only the events.
 *
 * Before this packet `executeSwitchPlan` iterated `plan.events` and never
 * consulted `plan.steps`, so it would faithfully append a completion for a
 * switch that had not happened. Each refusal below is asserted **twice**: that
 * it throws, and that the ledger is untouched afterwards — a guard that fired
 * after a partial append would record part of a switch it then called unlawful.
 *
 * Nothing here spawns a process, opens a socket, reaches a provider or spends
 * (N7); the fixtures are a local SQLite ledger and plain values.
 */

/** The real plan, with one field replaced. Everything else stays the planner's. */
function planWith(base: SwitchPlan, overrides: Partial<SwitchPlan>): SwitchPlan {
  return Object.freeze({ ...base, ...overrides });
}

const completedEvent: SwitchEvent = {
  type: "ACCOUNT_SWITCH_COMPLETED",
  payload: { fromAccountId: "current", toAccountId: "spare" },
};

describe("F1: the executor refuses a claim the switch has not earned", () => {
  /** A ledger, an invocation and the post-F1 plan, for one refusal drill. */
  function drill(id: string, taskId: string): {
    ledger: Ledger;
    invocation: DurableInvocation;
    plan: SwitchPlan;
    before: number;
  } {
    const { ledger, invocation } = openWithTask(id, taskId);
    const outcome = switchPlan();
    if (!outcome.ok) throw new Error("expected a switch plan");
    return { ledger, invocation, plan: outcome.plan, before: ledger.status().eventCount };
  }

  function run(ledger: Ledger, invocation: DurableInvocation, plan: SwitchPlan): void {
    executeSwitchPlan({
      ledger,
      invocation,
      plan,
      emittedBy: EMITTED_BY,
      lease: leaseFor("/tmp/acp-p8w-worktree"),
      taskState: ledger.getTask(invocation.taskId)?.currentState ?? "DISCOVERED",
    });
  }

  it("N1 refuses ACCOUNT_SWITCH_COMPLETED by name, and appends nothing", () => {
    const { ledger, invocation, plan, before } = drill(
      "switch-f1-completed",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c21",
    );
    const fabricated = planWith(plan, { events: Object.freeze([...plan.events, completedEvent]) });

    expect(() => {
      run(ledger, invocation, fabricated);
    }).toThrow(SupervisorError);
    // The message names who may append it, so the refusal teaches the rule
    // rather than only enforcing it.
    expect(() => {
      run(ledger, invocation, fabricated);
    }).toThrow(/only the session-opener may append it/);
    expect(ledger.status().eventCount).toBe(before);
  });

  it("N1 refuses it even when it is the only event, and even first in the list", () => {
    // So the guard cannot be passing for a positional reason.
    const { ledger, invocation, plan, before } = drill(
      "switch-f1-completed-only",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c22",
    );
    const only = planWith(plan, { events: Object.freeze([completedEvent]) });
    const first = planWith(plan, { events: Object.freeze([completedEvent, ...plan.events]) });

    expect(() => {
      run(ledger, invocation, only);
    }).toThrow(SupervisorError);
    expect(() => {
      run(ledger, invocation, first);
    }).toThrow(SupervisorError);
    expect(ledger.status().eventCount).toBe(before);
  });

  it("N2 refuses an event claiming a step the plan does not declare", () => {
    // `LEASE_REVOKED` claims `RELEASE_LEASE`. Strip that step and the event is
    // a claim about work the plan itself never said would happen.
    const { ledger, invocation, plan, before } = drill(
      "switch-f1-undeclared",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c23",
    );
    const stripped = planWith(plan, {
      steps: Object.freeze(plan.steps.filter((step) => step !== "RELEASE_LEASE")),
    });

    expect(() => {
      run(ledger, invocation, stripped);
    }).toThrow(SupervisorError);
    expect(() => {
      run(ledger, invocation, stripped);
    }).toThrow(/does not declare/);
    expect(ledger.status().eventCount).toBe(before);
  });

  it("N3 refuses an event claiming a declared step outside the claimable prefix", () => {
    // The step is declared -- `CONTINUE` is step 11 of every SWITCH plan -- so
    // this is not N2 in disguise. What makes it unlawful is that nothing opens
    // a session yet, so no record may claim one. The event type is renamed onto
    // a step-claiming type that maps past the prefix, which is exactly the
    // shape a premature F5 would produce.
    const { ledger, invocation, plan, before } = drill(
      "switch-f1-beyond-prefix",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c24",
    );
    expect(plan.steps).toContain("CONTINUE");

    const beyond = planWith(plan, { events: Object.freeze([completedEvent]) });
    expect(() => {
      run(ledger, invocation, beyond);
    }).toThrow(SupervisorError);
    expect(ledger.status().eventCount).toBe(before);
  });

  it("N4 refuses an event type in neither set, rather than playing it silently", () => {
    // Fail-closed on the vocabulary. A type added to the contracts enum and
    // emitted by a later planner arrives here unclassified, and is refused
    // until somebody decides which set it belongs to.
    const { ledger, invocation, plan, before } = drill(
      "switch-f1-unclassified",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c25",
    );
    // A genuine member of the frozen contracts vocabulary that the table
    // classifies in neither set -- which is exactly the shape a later planner
    // would produce, rather than a type that could never typecheck.
    const unclassified = planWith(plan, {
      events: Object.freeze<readonly SwitchEvent[]>([
        { type: "LEASE_ACQUIRED", payload: { accountId: "current" } },
      ]),
    });

    expect(() => {
      run(ledger, invocation, unclassified);
    }).toThrow(SupervisorError);
    expect(() => {
      run(ledger, invocation, unclassified);
    }).toThrow(/cannot(.|\n)*classify/);
    expect(ledger.status().eventCount).toBe(before);
  });

  it("P4 leaves all eleven steps declared: F1 narrows what may be claimed, not what the plan states", () => {
    const outcome = switchPlan();
    if (!outcome.ok) throw new Error("expected a switch plan");
    expect([...outcome.plan.steps]).toEqual([...SWITCH_STEPS]);
    expect(outcome.plan.steps).toHaveLength(11);
  });

  it("P2 plays the post-F1 plan: four events, all admitted, nothing refused", () => {
    const { ledger, invocation, plan, before } = drill(
      "switch-f1-happy",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c26",
    );

    expect(plan.events.map((candidate) => candidate.type)).toEqual([
      "QUOTA_WARNING",
      "TASK_STATE_CHANGED",
      "LEASE_REVOKED",
      "ACCOUNT_SWITCH_STARTED",
    ]);

    run(ledger, invocation, plan);
    expect(ledger.status().eventCount).toBe(before + 4);
  });
});

describe("F1: DRAIN and ESCALATE are byte-identical to HEAD (P3)", () => {
  it("plays a DRAIN plan's single step-independent event, unchanged", () => {
    // A DRAIN plan declares three steps and emits one event that names none of
    // them. It passes the new guard because `QUOTA_WARNING` is step-independent,
    // and it needs no lease and names no state change, so the three older guards
    // are satisfied too. Literals, not a re-run of the planner.
    const { ledger, invocation } = openWithTask(
      "switch-f1-drain",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c27",
    );
    const outcome = decideSwitch({
      trigger: "QUOTA_WARNING",
      currentAccountId: "current",
      routing: routing(["current", "spare"]),
    });
    if (!outcome.ok) throw new Error("expected a drain plan");
    expect(outcome.plan.kind).toBe("DRAIN");
    expect(outcome.plan.events.map((c) => c.type)).toEqual(["QUOTA_WARNING"]);

    const before = ledger.status().eventCount;
    const result = executeSwitchPlan({
      ledger,
      invocation,
      plan: outcome.plan,
      emittedBy: EMITTED_BY,
      // A DRAIN plan revokes no lease and changes no task state, so neither is
      // supplied -- which is the point: the older guards stay unmoved.
      lease: null,
      taskState: ledger.getTask(invocation.taskId)?.currentState ?? "DISCOVERED",
    });

    expect(result.appended).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual(["QUOTA_WARNING"]);
    expect(ledger.status().eventCount).toBe(before + 1);
  });

  it("plays an ESCALATE plan, which declares zero steps and still executes", () => {
    // The case a name-correspondence guard would have broken: zero steps, one
    // event. It executes because `AUTH_REQUIRED_RAISED` is step-independent.
    const { ledger, invocation } = openWithTask(
      "switch-f1-escalate",
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c28",
    );
    // The current account needs a human at an auth prompt. Built here rather
    // than by widening the shared `record` helper, which every other fixture
    // in this file depends on staying exactly as it is.
    const base = routing(["current", "spare"]);
    const authRequired = AccountRecord.safeParse({
      ...base.records[0],
      status: "AUTH_REQUIRED",
      quotaEstimate: {
        remainingRatio: null,
        estimatedTokensRemaining: null,
        estimatedAt: AT,
        confidence: "MEDIUM",
      },
    });
    if (!authRequired.success) throw new Error("the fixture must satisfy the contract");

    // The trigger stays the classified quota one: it is the account's own
    // AUTH_REQUIRED status that escalates, not the trigger.
    const outcome = decideSwitch({
      trigger: "QUOTA_EXHAUSTED",
      currentAccountId: "current",
      routing: { ...base, records: [authRequired.data, ...base.records.slice(1)] },
    });
    if (!outcome.ok) throw new Error("expected an escalate plan");
    expect(outcome.plan.kind).toBe("ESCALATE");
    expect([...outcome.plan.steps]).toEqual([]);
    expect(outcome.plan.events.map((c) => c.type)).toEqual(["AUTH_REQUIRED_RAISED"]);

    const before = ledger.status().eventCount;
    const result = executeSwitchPlan({
      ledger,
      invocation,
      plan: outcome.plan,
      emittedBy: EMITTED_BY,
      lease: null,
      taskState: ledger.getTask(invocation.taskId)?.currentState ?? "DISCOVERED",
    });

    expect(result.appended).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual(["AUTH_REQUIRED_RAISED"]);
    expect(ledger.status().eventCount).toBe(before + 1);
  });
});
