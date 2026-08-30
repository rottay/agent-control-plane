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
    invocationId: "inv-" + taskId.slice(0, 8),
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
    },
    probe: (operation: OperationCoordinate): PostconditionVerdict => {
      const verdict = probeEffect(root, operation);
      log.push("PROBE:" + verdict);
      return verdict;
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
  it("splits the effect-bearing transition into three separately callable beats", () => {
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
    applyIntentEffect(context, INTENT_STEP);
    expect(log).toEqual(["EFFECT"]);
    expect(ledger.getEventByIdempotencyKey(context.invocation.taskId + "/1/run.outcome")).toBeNull();

    // BEAT 3: the outcome, and only now.
    const outcome = closeIntent(context);
    expect(outcome.inserted).toBe(true);
    expect(log).toEqual(["EFFECT", "PROBE:DONE"]);
    expect(
      ledger.getEventByIdempotencyKey(context.invocation.taskId + "/1/run.outcome"),
    ).not.toBeNull();
  });

  it("makes the crash between effect and outcome recoverable from beat three alone", () => {
    const log: string[] = [];
    const { context, ledger, invocation } = contextFor(
      "executor-crash-window",
      "10101010-1010-4101-8101-101010101012",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    applyIntentEffect(context, INTENT_STEP);

    // Simulate the restart: a fresh call to beat three, nothing else.
    log.length = 0;
    const closed = closeIntent(context);
    expect(log).toEqual(["PROBE:DONE"]);
    expect(closed.inserted).toBe(true);
    expect(ledger.getEventByIdempotencyKey(invocation.taskId + "/1/run.outcome")).not.toBeNull();
  });

  it("performs the effect from beat three when the crash landed before it", () => {
    const log: string[] = [];
    const { context } = contextFor(
      "executor-crash-before-effect",
      "10101010-1010-4101-8101-101010101013",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }

    const closed = closeIntent(context);
    expect(log).toEqual(["PROBE:NOT_DONE", "EFFECT", "PROBE:DONE"]);
    expect(closed.inserted).toBe(true);
  });

  it("refuses to append an outcome the probe cannot vouch for", () => {
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
      effects: { apply: () => undefined, probe: () => "UNKNOWN" },
    };
    expect(() => closeIntent(unknown)).toThrow(PostconditionUnknownError);
    expect(ledger.getEventByIdempotencyKey(invocation.taskId + "/1/run.outcome")).toBeNull();
  });

  it("is idempotent: every beat replays without appending", () => {
    const log: string[] = [];
    const { context, ledger } = contextFor(
      "executor-idempotent",
      "10101010-1010-4101-8101-101010101015",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    applyIntentEffect(context, INTENT_STEP);
    closeIntent(context);
    const head = ledger.status().headEventSha256;

    // The SDK documents a window where a durable step may be re-run. Every beat
    // must survive that, reporting a replay rather than raising a conflict.
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      expect(appendPlanStep(context, step).inserted).toBe(false);
    }
    applyIntentEffect(context, INTENT_STEP);
    expect(closeIntent(context).inserted).toBe(false);
    expect(ledger.status().headEventSha256).toBe(head);
  });

  it("navigates the plan from ledger evidence, disambiguating RUNNING", () => {
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

    applyIntentEffect(context, INTENT_STEP);
    closeIntent(context);
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

  it("addresses the same operation from the intent and the outcome beat", () => {
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
    applyIntentEffect(context, INTENT_STEP);
    closeIntent(context);
    // One effect, addressed once, whichever beat asked for it.
    expect(log.filter((entry) => entry === "EFFECT")).toHaveLength(1);
  });
});
