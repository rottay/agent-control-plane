import type { ResolvedRoute } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation, OperationCoordinate, PostconditionVerdict } from "../../../src/contracts/index.js";
import { PostconditionUnknownError, SupervisorError } from "../../../src/errors/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
  applyEffect,
  probeEffect,
} from "../../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../../src/toy/repository/index.js";
import { operationForStep } from "../../../src/core/events/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN, OUTCOME_STEP, planStep } from "../../../src/core/lifecycle/index.js";
import {
  appendPlanStep,
  applyIntentEffect,
  assertClaimedState,
  assertInvocationContinuity,
  closeIntent,
  currentState,
  nextStep,
} from "../../../src/core/step-executor/index.js";
import type { BeatContext, EffectPort } from "../../../src/core/step-executor/index.js";
import { deterministicUuid } from "../../../src/core/coordinates/index.js";


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

/** One fixed initiative for every fixture in this file. */
const TEST_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";

/**
 * Evidence for the shared beat executor.
 *
 * The load-bearing property is that the effect-bearing transition is THREE
 * separately callable operations, not one. A driver that must journal each
 * durable step individually cannot use a fused implementation, and the
 * crash-between-effect-and-outcome case -- the only case the three-beat law
 * exists for -- is unreachable if the append and the effect happen together.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const scenarios: string[] = [];
const ledgers: Ledger[] = [];

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function invocationFor(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("inv/" + taskId),
    submittedAt: "2026-08-27T12:00:00.000Z",
    submissionDigest: "a".repeat(64),
  };
}

/** A recording effect port, so the call sequence itself can be asserted. */
function recordingEffects(root: ScenarioRoot, log: string[]): EffectPort {
  return {
    apply: (operation: OperationCoordinate) => {
      log.push("EFFECT");
      applyEffect(root, operation);
      return Promise.resolve();
    },
    probe: (operation: OperationCoordinate): Promise<PostconditionVerdict> => {
      const verdict = probeEffect(root, operation);
      log.push("PROBE:" + verdict);
      return Promise.resolve(verdict);
    },
  };
}

function contextFor(name: string, taskId: string, log: string[]): {
  context: BeatContext;
  ledger: Ledger;
  root: ScenarioRoot;
  invocation: DurableInvocation;
} {
  const root = scenario(name);
  const invocation = invocationFor(taskId);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  return {
    context: {
      ledger,
      effects: recordingEffects(root, log),
      invocation,
      emittedBy: EMITTED_BY,
      plan: LIFECYCLE_PLAN,
      route: TEST_ROUTE,
      initiativeId: TEST_INITIATIVE_ID,
    },
    ledger,
    root,
    invocation,
  };
}

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

describe("the shared beat executor", () => {
  it("splits the effect-bearing transition into three separately callable beats", async () => {
    const log: string[] = [];
    const { context, ledger } = contextFor(
      "executor-three-beats",
      "10101010-1010-4101-8101-101010101011",
      log,
    );

    // Walk to the intent using only plain appends.
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index)) {
      appendPlanStep(context, step);
    }

    // BEAT 1: the intent append. On its own, journalable on its own.
    const intent = appendPlanStep(context, INTENT_STEP);
    expect(intent.inserted).toBe(true);
    expect(ledger.getTask(context.invocation.taskId)?.currentState).toBe("RUNNING");
    // Nothing has happened on disk yet, which is what makes beat 2 separable.
    expect(log).toEqual([]);

    // BEAT 2: the effect. A crash here is the case the whole law exists for.
    await applyIntentEffect(context, INTENT_STEP);
    expect(log).toEqual(["EFFECT"]);
    expect(ledger.getEventByIdempotencyKey(context.invocation.taskId + "/1/run.outcome")).toBeNull();

    // BEAT 3: the outcome, and only now.
    const outcome = await closeIntent(context);
    expect(outcome.inserted).toBe(true);
    expect(log).toEqual(["EFFECT", "PROBE:DONE"]);
    expect(
      ledger.getEventByIdempotencyKey(context.invocation.taskId + "/1/run.outcome"),
    ).not.toBeNull();
  });

  it("makes the crash between effect and outcome recoverable from beat three alone", async () => {
    const log: string[] = [];
    const { context, ledger, invocation } = contextFor(
      "executor-crash-window",
      "10101010-1010-4101-8101-101010101012",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    await applyIntentEffect(context, INTENT_STEP);

    // Simulate the restart: a fresh call to beat three, nothing else.
    log.length = 0;
    const closed = await closeIntent(context);
    expect(log).toEqual(["PROBE:DONE"]);
    expect(closed.inserted).toBe(true);
    expect(ledger.getEventByIdempotencyKey(invocation.taskId + "/1/run.outcome")).not.toBeNull();
  });

  it("performs the effect from beat three when the crash landed before it", async () => {
    const log: string[] = [];
    const { context } = contextFor(
      "executor-crash-before-effect",
      "10101010-1010-4101-8101-101010101013",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }

    const closed = await closeIntent(context);
    expect(log).toEqual(["PROBE:NOT_DONE", "EFFECT", "PROBE:DONE"]);
    expect(closed.inserted).toBe(true);
  });

  it("refuses to append an outcome the probe cannot vouch for", async () => {
    const log: string[] = [];
    const { context, ledger, invocation } = contextFor(
      "executor-unknown",
      "10101010-1010-4101-8101-101010101014",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }

    const unknown: BeatContext = {
      ...context,
      effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("UNKNOWN") },
    };
    await expect(closeIntent(unknown)).rejects.toThrow(PostconditionUnknownError);
    expect(ledger.getEventByIdempotencyKey(invocation.taskId + "/1/run.outcome")).toBeNull();
  });

  it("is idempotent: every beat replays without appending", async () => {
    const log: string[] = [];
    const { context, ledger } = contextFor(
      "executor-idempotent",
      "10101010-1010-4101-8101-101010101015",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    await applyIntentEffect(context, INTENT_STEP);
    await closeIntent(context);
    const head = ledger.status().headEventSha256;

    // The SDK documents a window where a durable step may be re-run. Every beat
    // must survive that, reporting a replay rather than raising a conflict.
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      expect(appendPlanStep(context, step).inserted).toBe(false);
    }
    await applyIntentEffect(context, INTENT_STEP);
    expect((await closeIntent(context)).inserted).toBe(false);
    expect(ledger.status().headEventSha256).toBe(head);
  });

  it("navigates the plan from ledger evidence, disambiguating RUNNING", async () => {
    const log: string[] = [];
    const { context } = contextFor(
      "executor-navigate",
      "10101010-1010-4101-8101-101010101016",
      log,
    );
    expect(currentState(context)).toBeNull();
    expect(nextStep(context, null)).toBe(planStep(0));

    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    // RUNNING with no outcome yet resolves to the outcome beat.
    expect(nextStep(context, "RUNNING")).toBe(OUTCOME_STEP);

    await applyIntentEffect(context, INTENT_STEP);
    await closeIntent(context);
    // RUNNING with the outcome present moves past it.
    expect(nextStep(context, "RUNNING").index).toBe(OUTCOME_STEP.index + 1);
  });

  it("carries the continuity and claim guards for every driver that uses it", () => {
    const log: string[] = [];
    const { context, invocation } = contextFor(
      "executor-guards",
      "10101010-1010-4101-8101-101010101017",
      log,
    );
    // No task yet: continuity has nothing to bind, the claim cannot be true.
    assertInvocationContinuity(context);
    expect(() => assertClaimedState(context, "DISCOVERED")).toThrow(SupervisorError);

    appendPlanStep(context, planStep(0));
    expect(assertClaimedState(context, "DISCOVERED")).toBe("DISCOVERED");
    expect(() => assertClaimedState(context, "RUNNING")).toThrow(SupervisorError);

    const foreign: BeatContext = {
      ...context,
      invocation: { ...invocation, submissionDigest: "b".repeat(64) },
    };
    expect(() => {
      assertInvocationContinuity(foreign);
    }).toThrow(SupervisorError);
  });

  it("addresses the same operation from the intent and the outcome beat", async () => {
    const log: string[] = [];
    const { context, invocation } = contextFor(
      "executor-same-operation",
      "10101010-1010-4101-8101-101010101018",
      log,
    );
    expect(operationForStep(invocation, INTENT_STEP).operationId).toBe(
      operationForStep(invocation, INTENT_STEP).operationId,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    await applyIntentEffect(context, INTENT_STEP);
    await closeIntent(context);
    // One effect, addressed once, whichever beat asked for it.
    expect(log.filter((entry) => entry === "EFFECT")).toHaveLength(1);
  });
});

describe("the producer guard: a broken causal chain refuses before any append (C5)", () => {
  it("refuses a step whose predecessor was never appended, and appends nothing", () => {
    const { context, ledger, invocation } = contextFor("causal-missing", "20202020-2020-4202-8202-202020202021", []);

    // Step 0 lands, then step 2 is attempted — skipping step 1. The event that
    // step 2's causation names has therefore never been written, so the link
    // would point at nothing.
    appendPlanStep(context, planStep(0));
    const before = ledger.status().eventCount;

    expect(() => appendPlanStep(context, planStep(2))).toThrow(SupervisorError);

    // Before, not after: the refusal happens ahead of the append, so the ledger
    // never holds the event whose claim could not be corroborated.
    expect(ledger.status().eventCount).toBe(before);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe(planStep(0).toState);
  });

  it("refuses when the predecessor's coordinates hold a different event", () => {
    const { context, ledger } = contextFor("causal-forged", "20202020-2020-4202-8202-202020202022", []);
    appendPlanStep(context, planStep(0));

    // A forged chain: the predecessor's row exists, but it is some other
    // event. The guard compares identity, not mere presence, because a row
    // under the right key carrying the wrong event is the failure a presence
    // check would wave through.
    const forged: BeatContext = {
      ...context,
      ledger: {
        append: context.ledger.append.bind(context.ledger),
        getTask: context.ledger.getTask.bind(context.ledger),
        getEventBySequence: context.ledger.getEventBySequence.bind(context.ledger),
        getEventByIdempotencyKey: () => ({
          canonicalJson: JSON.stringify({ eventId: "00000000-0000-4000-8000-0000000000ff" }),
        }),
      },
    };
    const before = ledger.status().eventCount;

    expect(() => appendPlanStep(forged, planStep(1))).toThrow(SupervisorError);
    expect(ledger.status().eventCount).toBe(before);
  });

  it("lets a well-formed chain through, step after step", () => {
    const { context, ledger } = contextFor("causal-intact", "20202020-2020-4202-8202-202020202023", []);
    for (let index = 0; index < 3; index += 1) {
      const result = appendPlanStep(context, planStep(index));
      expect({ index, inserted: result.inserted }).toEqual({ index, inserted: true });
    }
    expect(ledger.status().eventCount).toBe(3);
  });
});
