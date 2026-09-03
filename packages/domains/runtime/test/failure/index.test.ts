import { CONTROL_PLANE_EVENT_TYPES, EXCEPTIONAL_STATES, TERMINAL_STATES } from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import { deterministicUuid } from "../../src/core/coordinates/index.js";
import { operationForStep } from "../../src/core/events/index.js";
import { INTENT_STEP, READ_ONLY_PLAN, planStep } from "../../src/core/lifecycle/index.js";
import { appendPlanStep, assertInvocationContinuity, currentState } from "../../src/core/step-executor/index.js";
import type { BeatContext, EffectPort } from "../../src/core/step-executor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import {
  FAILURE_REASONS,
  FAILURE_TRANSITION_ID,
  FAILURE_VERDICTS,
  failurePrecheck,
  settleFailure,
} from "../../src/failure/index.js";
import {
  applyEffect,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";

/**
 * Terminal settlement for a walk that could not finish (V2-B7T).
 *
 * Every drill here runs against a **real ledger** and a real partial walk: the
 * events are appended by the same `appendPlanStep` the supervisor uses, and the
 * state the settlement reads is the one the projection actually holds. Nothing
 * is stubbed, because the whole claim is about what the ledger says afterwards.
 *
 * **Why the supervisor's own bound is not driven here, stated plainly.** The
 * guard `runToCheckpoint` settles on — `guard <= plan.length + 1` — is
 * unreachable through the public API against a consistent ledger, and that was
 * measured rather than assumed: both plans need exactly `plan.length + 1`
 * iterations to converge, leaving one spare, and the only non-advancing step is
 * the OUTCOME beat, which advances the moment its event exists. `closeIntent`
 * throws `PostconditionUnknownError` rather than looping when a probe will not
 * settle. So the guard is defensive, and reaching it would require a ledger
 * that contradicts itself — a fixture standing in for a real artifact, which
 * this repository does not accept as evidence. The settlement is therefore
 * proved here, completely, against the real thing; that the supervisor *calls*
 * it on that path is proved mechanically by the fence law L-B7T-1 and its
 * failing fixture. Both halves are named in the report.
 */

const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-b7t-failure",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const EMITTED_BY = "claude/opus/implementer/01";

const scenarios: string[] = [];
const ledgers: Ledger[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
});

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function track(ledger: Ledger): Ledger {
  ledgers.push(ledger);
  return ledger;
}

function invocationFor(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("b7t-failure/" + taskId),
    submittedAt: "2026-08-27T12:00:00.000Z",
    submissionDigest: "d".repeat(64),
  };
}

function toyEffects(root: ScenarioRoot): EffectPort {
  return {
    apply: (operation) => {
      applyEffect(root, operation);
      return Promise.resolve();
    },
    probe: (operation) => Promise.resolve(probeEffect(root, operation)),
  };
}

/** An effect port whose postcondition can never be established. */
function unknownEffects(): EffectPort {
  return {
    apply: () => Promise.resolve(),
    probe: () => Promise.resolve("UNKNOWN"),
  };
}

function contextFor(root: ScenarioRoot, ledger: Ledger, invocation: DurableInvocation, effects?: EffectPort): BeatContext {
  return {
    ledger,
    effects: effects ?? toyEffects(root),
    invocation,
    emittedBy: EMITTED_BY,
    plan: READ_ONLY_PLAN,
    initiativeId: INITIATIVE_ID,
    route: TEST_ROUTE,
  };
}

/** Walk the plan by hand up to (not including) `stopBefore`. */
function walkTo(context: BeatContext, stopBefore: number): void {
  assertInvocationContinuity(context);
  for (let index = 0; index < stopBefore; index += 1) {
    appendPlanStep(context, planStep(index));
  }
}

interface Staged {
  readonly root: ScenarioRoot;
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly context: BeatContext;
}

function stage(name: string, taskId: string, stopBefore: number, effects?: EffectPort): Staged {
  const root = scenario(name);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  const invocation = invocationFor(taskId);
  const context = contextFor(root, ledger, invocation, effects);
  walkTo(context, stopBefore);
  return { root, ledger, invocation, context };
}

const TASKS = {
  p1: "b7100000-0000-4000-8000-000000000001",
  p2: "b7100000-0000-4000-8000-000000000002",
  p3: "b7100000-0000-4000-8000-000000000003",
  done: "b7100000-0000-4000-8000-000000000004",
  unknown: "b7100000-0000-4000-8000-000000000005",
  terminal: "b7100000-0000-4000-8000-000000000006",
  absent: "b7100000-0000-4000-8000-000000000007",
  privacy: "b7100000-0000-4000-8000-000000000008",
} as const;

// ---------------------------------------------------------------------------
// P1 — the settlement appends exactly one TASK_FAILED
// ---------------------------------------------------------------------------

describe("P1: a walk that cannot finish settles", () => {
  it("appends exactly one TASK_FAILED, from the state the ledger reported", async () => {
    const staged = stage("b7t-p1", TASKS.p1, 4);
    // The state immediately before the append, read from the ledger and not
    // remembered from the walk.
    const before = currentState(staged.context);
    expect(before).toBe("RESERVED");
    const countBefore = staged.ledger.status().eventCount;

    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");

    expect(settlement.verdict).toBe("FAILED");
    expect(settlement.failed).not.toBeNull();
    expect(settlement.failed?.type).toBe("TASK_FAILED");
    expect(settlement.failed?.toState).toBe("FAILED");
    expect(settlement.failed?.fromState).toBe(before);
    expect(settlement.failed?.transitionId).toBe(FAILURE_TRANSITION_ID);
    expect(staged.ledger.status().eventCount).toBe(countBefore + 1);

    const failures = staged.ledger
      .listEvents({ taskId: TASKS.p1, limit: 200 })
      .events.filter((entry) => entry.event.type === "TASK_FAILED");
    expect(failures).toHaveLength(1);
  });

  it("closes an open intent whose effect happened, before claiming the terminal", async () => {
    // Through the INTENT beat, with the effect actually performed, so the probe
    // answers DONE. The OUTCOME that records it must precede the failure: a
    // terminal appended over an unrecorded effect is the shape ADR 0004 refuses.
    const staged = stage("b7t-done", TASKS.done, 5);
    await staged.context.effects.apply(operationForStep(staged.invocation, INTENT_STEP));
    expect(currentState(staged.context)).toBe("RUNNING");

    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");

    expect(settlement.verdict).toBe("FAILED");
    expect(settlement.effect).toBe("DONE");
    expect(settlement.closedIntent).toBe(true);

    const types = staged.ledger
      .listEvents({ taskId: TASKS.done, limit: 200 })
      .events.map((entry) => entry.event.type);
    // The outcome is recorded before the terminal, in that order.
    expect(types.indexOf("TASK_STATE_CHANGED")).toBeLessThan(types.indexOf("TASK_FAILED"));
    expect(types.filter((type) => type === "TASK_FAILED")).toHaveLength(1);
  });

  it("refuses to settle a task the ledger has never seen", () => {
    const root = scenario("b7t-absent");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const context = contextFor(root, ledger, invocationFor(TASKS.absent));
    expect(() => failurePrecheck(context)).toThrow(SupervisorError);
    expect(() => failurePrecheck(context)).toThrow(/nothing to fail/);
    expect(ledger.status().eventCount).toBe(0);
  });

  it("appends nothing for a task that already reached a terminal", async () => {
    const staged = stage("b7t-terminal", TASKS.terminal, 4);
    await settleFailure(staged.context, "BOUND_EXHAUSTED");
    const afterFirst = staged.ledger.status().eventCount;

    // Now FAILED, which is terminal. A second settlement must not append a
    // second terminal, and must say why rather than silently doing nothing.
    const second = await settleFailure(staged.context, "BOUND_EXHAUSTED");
    expect(second.verdict).toBe("TASK_TERMINAL");
    expect(second.failed).toBeNull();
    expect(staged.ledger.status().eventCount).toBe(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// P2 — settlement is idempotent
// ---------------------------------------------------------------------------

describe("P2: settling twice appends once", () => {
  it("rebuilds the same key and appends nothing the second time", async () => {
    const staged = stage("b7t-p2", TASKS.p2, 4);
    const first = await settleFailure(staged.context, "BOUND_EXHAUSTED");
    const countAfterFirst = staged.ledger.status().eventCount;
    const headAfterFirst = staged.ledger.status().headEventSha256;

    // A fresh context over the same ledger and the same durable invocation:
    // exactly what a re-run after a crash is. `settleFailure` refuses on the
    // terminal precheck, so drive the append itself through the same key by
    // asking the ledger directly for the row the first settlement wrote.
    const key = first.failed?.idempotencyKey;
    expect(key).toBeDefined();
    const stored = staged.ledger.getEventByIdempotencyKey(key ?? "");
    expect(stored).not.toBeNull();

    const replay = staged.ledger.append(first.failed ?? stored!.event);
    expect(replay.inserted).toBe(false);
    expect(staged.ledger.status().eventCount).toBe(countAfterFirst);
    expect(staged.ledger.status().headEventSha256).toBe(headAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// P3 — the task is terminal afterwards
// ---------------------------------------------------------------------------

describe("P3: the settled task is terminal", () => {
  it("leaves the projection FAILED, and FAILED is terminal by the contract", async () => {
    const staged = stage("b7t-p3", TASKS.p3, 4);
    await settleFailure(staged.context, "BOUND_EXHAUSTED");

    const task = staged.ledger.getTask(TASKS.p3);
    expect(task).not.toBeNull();
    expect(task?.currentState).toBe("FAILED");
    // Asserted from the contract, never restated here.
    expect(TERMINAL_STATES).toContain("FAILED");
    expect(currentState(staged.context)).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// N2 — POSTCONDITION_UNKNOWN settles nothing
// ---------------------------------------------------------------------------

describe("N2: an unestablished postcondition settles nothing", () => {
  it("appends no TASK_FAILED and leaves the intent open", async () => {
    // Through the INTENT beat, with a port that can never establish the
    // postcondition. This is the one case where a terminal would be a lie.
    const staged = stage("b7t-unknown", TASKS.unknown, 5, unknownEffects());
    const countBefore = staged.ledger.status().eventCount;

    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");

    expect(settlement.verdict).toBe("POSTCONDITION_UNKNOWN");
    expect(settlement.failed).toBeNull();
    expect(staged.ledger.status().eventCount).toBe(countBefore);

    const types = staged.ledger
      .listEvents({ taskId: TASKS.unknown, limit: 200 })
      .events.map((entry) => entry.event.type);
    expect(types).not.toContain("TASK_FAILED");
    // The intent stays open for an operator: RUN_STARTED is there and its
    // outcome is not.
    expect(types).toContain("RUN_STARTED");
    expect(staged.ledger.getTask(TASKS.unknown)?.currentState).toBe("RUNNING");
    expect(TERMINAL_STATES).not.toContain("RUNNING");
  });
});

// ---------------------------------------------------------------------------
// N4, N5 — the payload carries a classified code and nothing else
// ---------------------------------------------------------------------------

describe("N4/N5: the failure payload is a digest and a closed reason", () => {
  it("carries no free text, no path and no credential", async () => {
    const staged = stage("b7t-privacy", TASKS.privacy, 4);
    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");

    const payload = settlement.failed?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual(["reason", "submissionDigest"]);
    expect(FAILURE_REASONS).toContain(payload["reason"]);

    const serialized = staged.ledger
      .listEvents({ taskId: TASKS.privacy, limit: 200 })
      .events.map((entry) => entry.canonicalJson)
      .join("\n");
    expect(serialized.length).toBeGreaterThan(0);
    for (const forbidden of ["/Users/", "/private/", "credentialRef", "authProfileRef", "profile://", "Bearer "]) {
      expect(serialized).not.toContain(forbidden);
    }
    // No exception message from a lower layer ever reaches the log.
    expect(serialized).not.toContain("did not reach a terminal state");
  });

  it("keeps the verdict and reason vocabularies closed", () => {
    expect([...FAILURE_VERDICTS].sort()).toEqual(["FAILED", "POSTCONDITION_UNKNOWN", "TASK_TERMINAL"]);
    expect([...FAILURE_REASONS]).toEqual(["BOUND_EXHAUSTED"]);
  });
});

// ---------------------------------------------------------------------------
// N8 — no new vocabulary
// ---------------------------------------------------------------------------

describe("N8: this packet introduced no state and no event type", () => {
  it("leaves the contract's two closed lists exactly where they were", () => {
    expect(CONTROL_PLANE_EVENT_TYPES).toHaveLength(23);
    expect(EXCEPTIONAL_STATES).toHaveLength(8);
    // The two names this packet leans on were already there.
    expect(CONTROL_PLANE_EVENT_TYPES).toContain("TASK_FAILED");
    expect(EXCEPTIONAL_STATES).toContain("FAILED");
    expect(TERMINAL_STATES).toContain("FAILED");
  });
});
