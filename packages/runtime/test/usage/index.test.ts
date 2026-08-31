import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { LIFECYCLE_PLAN } from "../../src/core/lifecycle/index.js";
import { appendPlanStep } from "../../src/core/step-executor/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";
import { recordTokenObservation } from "../../src/usage/index.js";
import type { DurableInvocation } from "../../src/contracts/index.js";
import { deterministicUuid } from "../../src/core/coordinates/index.js";

/**
 * Evidence for usage and reservation emission.
 *
 * The rollups fold these two event types; this suite is about the other side of
 * that contract — that the events reach the ledger deterministically, and that
 * the module refuses to invent the task they belong to.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const AT = "2026-08-30T15:00:00.000Z";

const scenarios: string[] = [];
const ledgers: Ledger[] = [];

function scenario(id: string): ScenarioRoot {
  scenarios.push(id);
  return resolveScenarioRoot(id);
}

function invocationFor(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("usage/" + taskId),
    submittedAt: AT,
    submissionDigest: "c".repeat(64),
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
  for (const id of scenarios.splice(0)) removeScenarioRoot(id);
});

/** A ledger holding one discovered task, which is what the module requires. */
function openWithTask(id: string, taskId: string): { ledger: Ledger; invocation: DurableInvocation } {
  const root = scenario(id);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const invocation = invocationFor(taskId);
  const context: BeatContext = {
    ledger,
    effects: { apply: () => undefined, probe: () => "DONE" },
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

describe("token observations reach the ledger", () => {
  it("records usage as a same-state passthrough, with the payload verbatim", () => {
    const { ledger, invocation } = openWithTask(
      "usage-basic",
      "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a01",
    );
    const before = ledger.getTask(invocation.taskId)?.currentState;

    const result = recordTokenObservation(ledger, {
      invocation,
      kind: "USAGE",
      accountId: "acct-primary",
      tokens: 1_200,
      transitionId: "usage.step-1",
      emittedBy: EMITTED_BY,
    });

    expect(result.inserted).toBe(true);
    expect(result.event.type).toBe("TOKEN_USAGE_RECORDED");
    expect(result.event.payload).toEqual({ accountId: "acct-primary", tokens: 1_200 });
    // A passthrough: recording spend does not move the machine.
    expect(result.event.fromState).toBe(before);
    expect(result.event.toState).toBe(before);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe(before);
  });

  it("records a reservation under the other type", () => {
    const { ledger, invocation } = openWithTask(
      "usage-reservation",
      "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a02",
    );
    const result = recordTokenObservation(ledger, {
      invocation,
      kind: "RESERVATION",
      accountId: "acct-primary",
      tokens: 5_000,
      transitionId: "reservation.hold-1",
      emittedBy: EMITTED_BY,
    });
    expect(result.event.type).toBe("TOKEN_RESERVATION_RECORDED");
    expect(result.event.payload).toEqual({ accountId: "acct-primary", tokens: 5_000 });
  });

  it("is deterministic: the same observation appends once", () => {
    const { ledger, invocation } = openWithTask(
      "usage-replay",
      "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a03",
    );
    const observation = {
      invocation,
      kind: "USAGE" as const,
      accountId: "acct-primary",
      tokens: 42,
      transitionId: "usage.step-1",
      emittedBy: EMITTED_BY,
    };
    const first = recordTokenObservation(ledger, observation);
    const second = recordTokenObservation(ledger, observation);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(ledger.status().eventCount).toBe(2); // the discovery plus one usage
  });

  it("distinguishes two observations by their transition ids", () => {
    const { ledger, invocation } = openWithTask(
      "usage-two",
      "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a04",
    );
    recordTokenObservation(ledger, {
      invocation,
      kind: "USAGE",
      accountId: "acct-primary",
      tokens: 10,
      transitionId: "usage.step-1",
      emittedBy: EMITTED_BY,
    });
    recordTokenObservation(ledger, {
      invocation,
      kind: "USAGE",
      accountId: "acct-primary",
      tokens: 20,
      transitionId: "usage.step-2",
      emittedBy: EMITTED_BY,
    });
    expect(ledger.status().eventCount).toBe(3);
  });
});

describe("the module never opens a task", () => {
  it("refuses an observation for a task the ledger has never seen", () => {
    const root = scenario("usage-unknown-task");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);

    // N1: a usage event may not be a task's first event. Spend recorded
    // against a task with no discovery has no initiative to attribute it to.
    expect(() =>
      recordTokenObservation(ledger, {
        invocation: invocationFor("8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a05"),
        kind: "USAGE",
        accountId: "acct-primary",
        tokens: 5,
        transitionId: "usage.step-1",
        emittedBy: EMITTED_BY,
      }),
    ).toThrow(SupervisorError);

    expect(ledger.status().eventCount).toBe(0);
  });

  it("refuses a malformed count and an empty account", () => {
    const { ledger, invocation } = openWithTask(
      "usage-malformed",
      "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a06",
    );
    const base = {
      invocation,
      kind: "USAGE" as const,
      accountId: "acct-primary",
      transitionId: "usage.step-1",
      emittedBy: EMITTED_BY,
    };
    expect(() => recordTokenObservation(ledger, { ...base, tokens: -1 })).toThrow(SupervisorError);
    expect(() => recordTokenObservation(ledger, { ...base, tokens: 1.5 })).toThrow(SupervisorError);
    expect(() => recordTokenObservation(ledger, { ...base, tokens: 1, accountId: "" })).toThrow(
      SupervisorError,
    );
    expect(ledger.status().eventCount).toBe(1);
  });
});

describe("the causal thread (P8-8E2)", () => {
  it("rides the walk's correlation, and carries no cause by default", () => {
    const { ledger, invocation } = openWithTask(
      "usage-thread",
      "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a07",
    );
    const result = recordTokenObservation(ledger, {
      invocation,
      kind: "USAGE",
      accountId: "acct-primary",
      tokens: 10,
      transitionId: "usage.step-1",
      emittedBy: EMITTED_BY,
    });
    // An observation rides an attempt rather than starting one, so it belongs
    // to that run's thread.
    expect(result.event.correlationId).toBe(invocation.invocationId);
    // Spend accrues; it is not caused by one event. Null is the honest answer
    // rather than a fabricated link.
    expect(result.event.causationId).toBeNull();
  });

  it("carries a cause when the caller genuinely has one", () => {
    const { ledger, invocation } = openWithTask(
      "usage-caused",
      "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a08",
    );
    const cause = "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c99";
    const result = recordTokenObservation(ledger, {
      invocation,
      kind: "USAGE",
      accountId: "acct-primary",
      tokens: 10,
      transitionId: "usage.caused",
      emittedBy: EMITTED_BY,
      causedBy: cause,
    });
    expect(result.event.causationId).toBe(cause);
  });
});
