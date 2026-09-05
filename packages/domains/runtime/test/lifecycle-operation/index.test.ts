import { randomUUID } from "node:crypto";

import type { DriverCapabilities, DriverOutcome, DriverStatus, ResolvedRoute } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation, OrchestrationDriver } from "../../src/contracts/index.js";
import { buildEvent } from "../../src/core/events/index.js";
import {
  LIFECYCLE_PLAN,
  SHARED_PLAN_PREFIX,
  planStep,
} from "../../src/core/lifecycle/index.js";
import type { PlanStep } from "../../src/core/lifecycle/index.js";
import { assertInvocationContinuity } from "../../src/core/step-executor/index.js";
import type { BeatContext, EffectPort } from "../../src/core/step-executor/index.js";
import { settleCancellation } from "../../src/cancellation/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import {
  LIFECYCLE_RECOVERY_REFUSALS,
  LIFECYCLE_VERBS,
  lifecycleBeat,
  restateInvocation,
  runLifecycleOperation,
} from "../../src/lifecycle-operation/index.js";
import { canonicalSubmissionDigest, deriveInvocation } from "../../src/submission/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";

/**
 * The lifecycle operation, over a real ledger and a fake driver.
 *
 * The driver is faked and the ledger is not, which is the split the packet's
 * claim needs: what is under test here is what the plane can RECOVER from a log
 * and what it does with a driver's answer, and neither question involves an
 * engine. The real-engine proofs — idempotency, a SIGKILL in the settlement
 * window, an attach after a door death — live in the durability project, where
 * a port-binding suite may run.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const TEST_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const SUBMITTED_AT = "2026-08-27T12:00:00.000Z";

const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: SUBMITTED_AT,
};

const scenarios: string[] = [];
const openLedgers: Ledger[] = [];

afterEach(() => {
  for (const ledger of openLedgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) {
    removeScenarioRoot(name);
  }
});

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function track(ledger: Ledger): Ledger {
  openLedgers.push(ledger);
  return ledger;
}

/**
 * The invocation a real submission would have derived.
 *
 * The digest is computed rather than invented, because the producer under test
 * verifies it: a fixture carrying a placeholder digest would exercise the
 * refusal branch on every test and prove nothing about the accepting one.
 */
function invocationFor(
  taskId: string,
  attempt = 1,
  route: ResolvedRoute = TEST_ROUTE,
  initiativeId: string = TEST_INITIATIVE_ID,
  submittedAt: string = SUBMITTED_AT,
): DurableInvocation {
  return deriveInvocation(
    taskId,
    attempt,
    submittedAt,
    canonicalSubmissionDigest({ taskId, attempt, submittedAt, initiativeId, route }),
  );
}

/** Append one plan step, exactly as a walk would have. */
function append(
  ledger: Ledger,
  invocation: DurableInvocation,
  step: PlanStep,
  initiativeId: string = TEST_INITIATIVE_ID,
  route: ResolvedRoute = TEST_ROUTE,
): void {
  ledger.append(
    buildEvent({
      invocation,
      step,
      emittedBy: EMITTED_BY,
      initiativeId,
      plan: LIFECYCLE_PLAN,
      route,
    }),
  );
}

/** Seed a ledger with steps 0..`through`, inclusive. */
function seed(
  name: string,
  taskId: string,
  through: number,
  options: {
    readonly initiativeId?: string;
    readonly route?: ResolvedRoute;
    readonly submittedAt?: string;
  } = {},
): { readonly root: ScenarioRoot; readonly ledger: Ledger; readonly invocation: DurableInvocation } {
  const initiativeId = options.initiativeId ?? TEST_INITIATIVE_ID;
  const route = options.route ?? TEST_ROUTE;
  const submittedAt = options.submittedAt ?? SUBMITTED_AT;
  const root = scenario(name);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  const invocation = invocationFor(taskId, 1, route, initiativeId, submittedAt);
  for (let index = 0; index <= through; index += 1) {
    append(ledger, invocation, planStep(index), initiativeId, route);
  }
  return { root, ledger, invocation };
}

/** A port that reports what it is told to, and counts what it was asked. */
function probePort(verdict: "DONE" | "NOT_DONE" | "UNKNOWN"): EffectPort & { applied: number } {
  const port = {
    applied: 0,
    apply(): Promise<void> {
      port.applied += 1;
      return Promise.resolve();
    },
    probe(): Promise<"DONE" | "NOT_DONE" | "UNKNOWN"> {
      return Promise.resolve(verdict);
    },
  };
  return port;
}

/**
 * A driver that answers, and remembers how often it was asked.
 *
 * Deliberately not a partial stub cast to the interface: the operation may only
 * be proved against something that satisfies the whole contract, or the test
 * would pass for a driver no composition root could actually build.
 */
class CountingDriver implements OrchestrationDriver {
  readonly mode = "RESTATE" as const;
  cancelCalls = 0;
  reattachCalls = 0;

  readonly cancelOutcome: DriverOutcome;
  readonly reattachOutcome: DriverOutcome;

  constructor(
    cancelOutcome: DriverOutcome,
    reattachOutcome: DriverOutcome = { ok: true, finalSequence: 12 },
  ) {
    this.cancelOutcome = cancelOutcome;
    this.reattachOutcome = reattachOutcome;
  }

  cancel(): Promise<DriverOutcome> {
    this.cancelCalls += 1;
    return Promise.resolve(this.cancelOutcome);
  }

  reattach(): Promise<DriverOutcome> {
    this.reattachCalls += 1;
    return Promise.resolve(this.reattachOutcome);
  }

  signal(): Promise<DriverOutcome> {
    return Promise.resolve({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "signal" });
  }

  timer(): Promise<DriverOutcome> {
    return Promise.resolve({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "timer" });
  }

  advance(): Promise<never> {
    return Promise.reject(new SupervisorError("the fake driver walks no plan"));
  }

  status(): Promise<DriverStatus> {
    return Promise.reject(new SupervisorError("the fake driver reports no status"));
  }

  reconcile(): Promise<never> {
    return Promise.reject(new SupervisorError("the fake driver reconciles nothing"));
  }

  capabilities(): DriverCapabilities {
    return {
      contractVersion: "2.2.0",
      mode: this.mode,
      verbs: { CANCEL: "SUPPORTED", REATTACH: "SUPPORTED", SIGNAL: "SUPPORTED", TIMER: "SUPPORTED" },
      properties: { SERIALIZED_PER_TASK: "SUPPORTED" },
    };
  }
}

describe("the recovery producer", () => {
  it("rebuilds the five values a walk recorded, and the context passes continuity", () => {
    const taskId = randomUUID();
    const { ledger, invocation } = seed("l2-recover-ok", taskId, 4);

    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    // The identity is derived, not read: it equals what the submission door
    // derived from the same coordinates.
    expect(recovered.context.invocation).toEqual(invocation);
    expect(recovered.context.invocation.submittedAt).toBe(SUBMITTED_AT);
    expect(recovered.context.invocation.submissionDigest).toBe(invocation.submissionDigest);
    expect(recovered.context.emittedBy).toBe(EMITTED_BY);
    expect(recovered.context.initiativeId).toBe(TEST_INITIATIVE_ID);
    expect(recovered.context.route).toEqual(TEST_ROUTE);

    // The measurement: the recovered context is one the domain's own guard
    // accepts against the very ledger it came from.
    const context: BeatContext = {
      ...lifecycleBeat(ledger, probePort("NOT_DONE"), recovered.context)(
        recovered.context.invocation,
      ),
      plan: SHARED_PLAN_PREFIX,
      initiativeId: recovered.context.initiativeId,
    };
    expect(() => {
      assertInvocationContinuity(context);
    }).not.toThrow();
  });

  it("is non-vacuous: a different submitted instant derives a different attempt", () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-recover-instant", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const elsewhere = invocationFor(taskId, 1, TEST_ROUTE, TEST_INITIATIVE_ID, "2026-08-27T13:00:00.000Z");
    expect(elsewhere.submittedAt).not.toBe(recovered.context.invocation.submittedAt);
    expect(elsewhere.submissionDigest).not.toBe(recovered.context.invocation.submissionDigest);
  });

  it("is non-vacuous: a different initiative makes continuity refuse", () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-recover-initiative", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const wrong: BeatContext = {
      ...lifecycleBeat(ledger, probePort("NOT_DONE"), recovered.context)(
        recovered.context.invocation,
      ),
      plan: SHARED_PLAN_PREFIX,
      initiativeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a99",
    };
    expect(() => {
      assertInvocationContinuity(wrong);
    }).toThrow(SupervisorError);
  });

  it("refuses an attempt the ledger has never seen, and synthesizes nothing", () => {
    const root = scenario("l2-recover-unknown");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const recovered = restateInvocation(ledger, randomUUID(), 1);
    expect(recovered).toEqual({ ok: false, refusal: "TASK_UNKNOWN", at: "task" });
  });

  it("refuses an attempt that is not the latest, before any engine is touched", () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-recover-stale", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 2);
    expect(recovered).toEqual({ ok: false, refusal: "ATTEMPT_NOT_LATEST", at: "attempt" });
  });

  it("refuses before RUN_STARTED, naming the field rather than guessing a route", () => {
    const taskId = randomUUID();
    // Steps 0..3: discovered through reserved. The INTENT beat, which is the
    // only event that carries a route, has not been appended.
    const { ledger } = seed("l2-recover-preintent", taskId, 3);
    expect(ledger.getExecutionRoute(taskId, 1)).toBeNull();

    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered).toEqual({ ok: false, refusal: "ROUTE_NOT_RECORDED", at: "attempt.route" });
  });

  it("refuses a recorded route that disagrees with the digest its own events carry", () => {
    const taskId = randomUUID();
    const root = scenario("l2-recover-disagreeing");
    const ledger = track(openLedger(scenarioLedgerPath(root)));

    // The digest is bound to one route; the walk records another. Nothing about
    // the chain is wrong — every event verifies and the projection holds
    // exactly what the INTENT payload said — and that is the point: the two
    // accounts of "which route" disagree, and only the digest can tell.
    const bound: ResolvedRoute = { ...TEST_ROUTE, accountId: "acct-bound" };
    const recorded: ResolvedRoute = { ...TEST_ROUTE, accountId: "acct-recorded" };
    const invocation = invocationFor(taskId, 1, bound);
    for (let index = 0; index <= 4; index += 1) {
      append(ledger, invocation, planStep(index), TEST_INITIATIVE_ID, recorded);
    }
    expect(ledger.getExecutionRoute(taskId, 1)?.accountId).toBe("acct-recorded");
    expect(ledger.verifyIntegrity().ok).toBe(true);

    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered).toEqual({
      ok: false,
      refusal: "SUBMISSION_DIGEST_MISMATCH",
      at: "attempt.submissionDigest",
    });

    void root;
  });

  it("names every refusal it can produce, closed and sorted", () => {
    expect([...LIFECYCLE_RECOVERY_REFUSALS]).toEqual([...LIFECYCLE_RECOVERY_REFUSALS].sort());
    expect(new Set(LIFECYCLE_RECOVERY_REFUSALS).size).toBe(LIFECYCLE_RECOVERY_REFUSALS.length);
  });
});

describe("the operation", () => {
  it("exposes cancel and attach, and nothing else", () => {
    expect([...LIFECYCLE_VERBS]).toEqual(["ATTACH", "CANCEL"]);
  });

  it("calls cancel exactly once and returns the driver's answer verbatim", async () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-op-cancel", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const driver = new CountingDriver({ ok: true, finalSequence: 5 });
    const result = await runLifecycleOperation({
      driver,
      verb: "CANCEL",
      invocation: recovered.context.invocation,
    });

    expect(driver.cancelCalls).toBe(1);
    expect(driver.reattachCalls).toBe(0);
    expect(result).toEqual({
      verb: "CANCEL",
      mode: "RESTATE",
      outcome: { ok: true, finalSequence: 5 },
    });
  });

  it("does not retry a refusal, and carries the driver's closed name across", async () => {
    const driver = new CountingDriver({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "cancel",
    });
    const invocation = invocationFor(randomUUID());

    const result = await runLifecycleOperation({ driver, verb: "CANCEL", invocation });

    expect(driver.cancelCalls).toBe(1);
    expect(result.outcome).toEqual({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "cancel" });
  });

  it("returns attach's ledger coordinate and nothing the engine minted", async () => {
    const driver = new CountingDriver(
      { ok: true, finalSequence: 0 },
      { ok: true, finalSequence: 41 },
    );
    const invocation = invocationFor(randomUUID());

    const result = await runLifecycleOperation({ driver, verb: "ATTACH", invocation });

    expect(driver.reattachCalls).toBe(1);
    expect(driver.cancelCalls).toBe(0);
    expect(result.outcome).toEqual({ ok: true, finalSequence: 41 });
    // A ledger coordinate is a number. Anything the engine names would be a
    // string, and there is nowhere on this shape for one to travel.
    expect(Object.keys(result.outcome)).toEqual(["ok", "finalSequence"]);
  });

  it("lets an unreachable engine throw rather than becoming a refusal", async () => {
    // A whole driver rather than a spread of one: the operation may only be
    // proved against something that satisfies the entire contract.
    const driver = new CountingDriver({ ok: true, finalSequence: 0 });
    const throwing = (): Promise<never> =>
      Promise.reject(new SupervisorError("the attach for this invocation answered 503"));
    const unreachable: OrchestrationDriver = {
      mode: "RESTATE",
      cancel: throwing,
      reattach: throwing,
      signal: () => driver.signal(),
      timer: () => driver.timer(),
      advance: () => driver.advance(),
      status: () => driver.status(),
      reconcile: () => driver.reconcile(),
      capabilities: () => driver.capabilities(),
    };

    await expect(
      runLifecycleOperation({
        driver: unreachable,
        verb: "CANCEL",
        invocation: invocationFor(randomUUID()),
      }),
    ).rejects.toThrow(SupervisorError);
  });
});

describe("the shared prefix a lifecycle construction walks", () => {
  it("closes an open intent before the cancellation when the probe says DONE", async () => {
    const taskId = randomUUID();
    // Through the INTENT beat, and no further: the effect is in flight and its
    // OUTCOME has not been recorded.
    const { ledger } = seed("l2-prefix-done", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const before = ledger.status().eventCount;
    const context: BeatContext = {
      ...lifecycleBeat(ledger, probePort("DONE"), recovered.context)(recovered.context.invocation),
      plan: SHARED_PLAN_PREFIX,
      initiativeId: recovered.context.initiativeId,
    };

    const settlement = await settleCancellation(context);

    expect(settlement.verdict).toBe("CANCELLED");
    expect(settlement.effect).toBe("DONE");
    expect(settlement.closedIntent).toBe(true);

    // Two appends, in order: the outcome the walk would have written, then the
    // cancellation. A stubbed plan would have made the tests above pass while
    // this one appended the wrong outcome or none at all.
    const trail = ledger
      .listEvents({ limit: 200 })
      .events.map((record) => record.event)
      .filter((event) => event.taskId === taskId);
    expect(ledger.status().eventCount).toBe(before + 2);
    const last = trail.slice(-2);
    expect(last[0]?.transitionId).toBe(planStep(5).transitionId);
    expect(last[0]?.type).toBe("ATOMIC_STEP_COMPLETED");
    expect(last[1]?.type).toBe("TASK_CANCELLED");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("appends nothing at all when the probe cannot say", async () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-prefix-unknown", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const before = ledger.status();
    const context: BeatContext = {
      ...lifecycleBeat(ledger, probePort("UNKNOWN"), recovered.context)(
        recovered.context.invocation,
      ),
      plan: SHARED_PLAN_PREFIX,
      initiativeId: recovered.context.initiativeId,
    };

    const settlement = await settleCancellation(context);

    expect(settlement.verdict).toBe("POSTCONDITION_UNKNOWN");
    expect(settlement.cancelled).toBeNull();
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
  });

  it("settles byte-identically under the prefix and under either full plan", async () => {
    const taskId = randomUUID();
    const bytes: string[] = [];

    for (const [index, plan] of [SHARED_PLAN_PREFIX, LIFECYCLE_PLAN].entries()) {
      const { ledger } = seed("l2-prefix-equal-" + String(index), taskId, 4);
      const recovered = restateInvocation(ledger, taskId, 1);
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;

      const context: BeatContext = {
        ...lifecycleBeat(ledger, probePort("NOT_DONE"), recovered.context)(
          recovered.context.invocation,
        ),
        plan,
        initiativeId: recovered.context.initiativeId,
      };
      const settlement = await settleCancellation(context);
      expect(settlement.verdict).toBe("CANCELLED");
      bytes.push(JSON.stringify(settlement.cancelled));
    }

    // The whole of the argument for a plan-free lifecycle construction: on the
    // cancel path the plan is inert, so refusing to guess a commit policy costs
    // nothing that could be observed in the log.
    expect(bytes[0]).toBe(bytes[1]);
  });
});
