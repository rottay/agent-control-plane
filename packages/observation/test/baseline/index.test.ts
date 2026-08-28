import { randomUUID } from "node:crypto";

import { buildIdempotencyKey } from "@acp/contracts";
import type { ControlPlaneEvent } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import {
  AUDIT_VERDICTS,
  BaselineStopError,
  TERMINAL_OUTCOME_TYPES,
  TOKENS_USED_MAX,
  computeBaseline,
  serializeBaseline,
} from "../../src/baseline/index.js";

/**
 * Fixture events are plain records cast to the contract type: this suite tests
 * the baseline's own laws, and a contract-invalid event is the collectors'
 * problem, proven in their suites. Every timestamp is a fixed string — nothing
 * here reads a clock, which is the property the rebuild proof depends on.
 */
function event(overrides: Record<string, unknown>): ControlPlaneEvent {
  const taskId = (overrides["taskId"] as string | undefined) ?? randomUUID();
  const attempt = 1;
  const transitionId = (overrides["transitionId"] as string | undefined) ?? "step";
  return {
    contractVersion: "1.0.0",
    eventId: randomUUID(),
    taskId,
    attempt,
    transitionId,
    idempotencyKey: buildIdempotencyKey({ taskId, attempt, transitionId }),
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "kimi/k3/coordinator/01",
    occurredAt: "2026-08-27T12:00:00.000Z",
    recordedAt: "2026-08-27T12:00:00.000Z",
    correlationId: null,
    causationId: null,
    payload: {},
    ...overrides,
  } as unknown as ControlPlaneEvent;
}

const TASK_A = "00000000-0000-4000-8000-00000000000a";
const TASK_B = "00000000-0000-4000-8000-00000000000b";

/** A representative two-task chain exercising all five measures. */
function representativeChain(): ControlPlaneEvent[] {
  return [
    event({ taskId: TASK_A, transitionId: "discover", type: "TASK_DISCOVERED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:00:00.000Z" }),
    event({ taskId: TASK_A, transitionId: "classify", type: "TASK_CLASSIFIED", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:10.000Z", payload: { reason: "routine" } }),
    event({ taskId: TASK_A, transitionId: "step-1", type: "ATOMIC_STEP_COMPLETED", fromState: "DT_CLASSIFIED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:20.000Z", payload: { tokensUsed: 1200 } }),
    event({ taskId: TASK_A, transitionId: "reenter", type: "TASK_STATE_CHANGED", fromState: "DT_CLASSIFIED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:00:30.000Z" }),
    event({ taskId: TASK_A, transitionId: "audit", type: "AUDIT_COMPLETED", fromState: "DISCOVERED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:00:40.000Z", payload: { verdict: "ACCEPT" } }),
    event({ taskId: TASK_A, transitionId: "commit", type: "COMMIT_RECORDED", fromState: "DISCOVERED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:01:00.000Z" }),

    event({ taskId: TASK_B, transitionId: "discover", type: "TASK_DISCOVERED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:02:00.000Z" }),
    event({ taskId: TASK_B, transitionId: "classify", type: "TASK_CLASSIFIED", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:02:05.000Z", payload: { reason: "escalated" } }),
    event({ taskId: TASK_B, transitionId: "step-1", type: "ATOMIC_STEP_COMPLETED", fromState: "DT_CLASSIFIED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:02:10.000Z", payload: { tokensUsed: 800 } }),
    event({ taskId: TASK_B, transitionId: "audit", type: "AUDIT_COMPLETED", fromState: "DT_CLASSIFIED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:02:20.000Z", payload: { verdict: "REJECT" } }),
    event({ taskId: TASK_B, transitionId: "fail", type: "TASK_FAILED", fromState: "DT_CLASSIFIED", toState: "FAILED", occurredAt: "2026-08-27T12:02:30.000Z" }),
  ];
}

describe("the baseline measures what the chain actually says", () => {
  it("computes all five measures over a representative chain", () => {
    const baseline = computeBaseline(representativeChain());

    expect(baseline.events).toBe(11);
    expect(baseline.tasks).toBe(2);

    // routing: two classifications, counted by their payload reason.
    expect(baseline.routing.total).toBe(2);
    expect(baseline.routing.byReason).toEqual([
      { reason: "escalated", count: 1 },
      { reason: "routine", count: 1 },
    ]);

    // tokens: artifact-supplied, summed, never estimated.
    expect(baseline.tokens).toEqual({ events: 2, total: 2000 });

    // time: first-to-last event-carried timestamps, per task, sorted by id.
    expect(baseline.time.byTask).toEqual([
      { taskId: TASK_A, durationMs: 60_000, events: 6 },
      { taskId: TASK_B, durationMs: 30_000, events: 5 },
    ]);
    expect(baseline.time.totalMs).toBe(90_000);

    // rework: task A re-entered DISCOVERED, task B never re-entered anything.
    expect(baseline.rework.total).toBe(1);
    expect(baseline.rework.byTask).toEqual([{ taskId: TASK_A, count: 1 }]);

    // acceptance: verdicts and terminal outcomes counted separately.
    expect(baseline.acceptance.audits).toBe(2);
    expect(baseline.acceptance.byVerdict).toEqual([
      { verdict: "ACCEPT", count: 1 },
      { verdict: "REJECT", count: 1 },
    ]);
    expect(baseline.acceptance.terminalOutcomes).toEqual([
      { type: "COMMIT_RECORDED", count: 1 },
      { type: "TASK_CANCELLED", count: 0 },
      { type: "TASK_FAILED", count: 1 },
    ]);
  });

  it("is a pure function: the same chain gives a byte-identical serialization", () => {
    const first = serializeBaseline(computeBaseline(representativeChain()));
    const second = serializeBaseline(computeBaseline(representativeChain()));
    expect(second).toBe(first);
  });

  it("treats an empty chain as valid zeroes, not as an error", () => {
    const baseline = computeBaseline([]);
    expect(baseline).toMatchObject({
      events: 0,
      tasks: 0,
      routing: { total: 0, byReason: [] },
      tokens: { events: 0, total: 0 },
      rework: { total: 0, byTask: [] },
      time: { byTask: [], totalMs: 0 },
    });
    // Terminal outcomes are always all three, zeroes included, so a reader
    // never has to guess whether an absent key means zero or means unmeasured.
    expect(baseline.acceptance.terminalOutcomes.map((entry) => entry.type)).toEqual([
      ...TERMINAL_OUTCOME_TYPES,
    ]);
    expect(baseline.acceptance.audits).toBe(0);
  });

  it("reports zeroes for metric classes whose event type is simply absent", () => {
    const baseline = computeBaseline([
      event({ taskId: TASK_A, type: "TASK_DISCOVERED", toState: "DISCOVERED" }),
    ]);
    expect(baseline.routing.total).toBe(0);
    expect(baseline.tokens.events).toBe(0);
    expect(baseline.acceptance.audits).toBe(0);
    expect(baseline.rework.total).toBe(0);
    expect(baseline.time.byTask).toHaveLength(1);
  });

  it("sorts every breakdown, so the answer never depends on arrival order", () => {
    const forward = computeBaseline([
      event({ taskId: TASK_A, type: "TASK_CLASSIFIED", toState: "DT_CLASSIFIED", payload: { reason: "zulu" } }),
      event({ taskId: TASK_A, transitionId: "b", type: "TASK_CLASSIFIED", toState: "DT_CLASSIFIED", payload: { reason: "alpha" } }),
    ]);
    expect(forward.routing.byReason.map((entry) => entry.reason)).toEqual(["alpha", "zulu"]);
  });
});

describe("rework counts re-entry, not first entry", () => {
  it("does not count the first time a state is reached", () => {
    const baseline = computeBaseline([
      event({ taskId: TASK_A, transitionId: "a", type: "TASK_DISCOVERED", toState: "DISCOVERED" }),
      event({ taskId: TASK_A, transitionId: "b", type: "TASK_STATE_CHANGED", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:10.000Z" }),
    ]);
    expect(baseline.rework.total).toBe(0);
  });

  it("counts a genuine re-entry into a state the task already left", () => {
    const baseline = computeBaseline([
      event({ taskId: TASK_A, transitionId: "a", type: "TASK_DISCOVERED", toState: "DISCOVERED" }),
      event({ taskId: TASK_A, transitionId: "b", type: "TASK_STATE_CHANGED", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:10.000Z" }),
      event({ taskId: TASK_A, transitionId: "c", type: "TASK_STATE_CHANGED", fromState: "DT_CLASSIFIED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:00:20.000Z" }),
    ]);
    expect(baseline.rework.total).toBe(1);
    expect(baseline.rework.byTask).toEqual([{ taskId: TASK_A, count: 1 }]);
  });

  it("keeps each task's history separate", () => {
    const baseline = computeBaseline([
      event({ taskId: TASK_A, transitionId: "a", type: "TASK_DISCOVERED", toState: "DISCOVERED" }),
      event({ taskId: TASK_B, transitionId: "b", type: "TASK_STATE_CHANGED", fromState: null, toState: "DISCOVERED", occurredAt: "2026-08-27T12:00:10.000Z" }),
    ]);
    // Task B reaching DISCOVERED is its first entry, not rework, even though
    // task A had already been there.
    expect(baseline.rework.total).toBe(0);
  });
});

describe("the baseline stops rather than guessing", () => {
  it("refuses a classification with no reason", () => {
    expect(() =>
      computeBaseline([event({ taskId: TASK_A, type: "TASK_CLASSIFIED", toState: "DT_CLASSIFIED" })]),
    ).toThrow(BaselineStopError);
  });

  it("refuses a reason that is empty or past its bound", () => {
    for (const reason of ["", "x".repeat(81)]) {
      const thrown = (): unknown =>
        computeBaseline([
          event({ taskId: TASK_A, type: "TASK_CLASSIFIED", toState: "DT_CLASSIFIED", payload: { reason } }),
        ]);
      expect(thrown).toThrow(BaselineStopError);
      try {
        thrown();
      } catch (error) {
        expect((error as BaselineStopError).reason).toBe("MISSING_REASON");
      }
    }
  });

  it("refuses a completed step with no token count, rather than estimating one", () => {
    let captured: BaselineStopError | null = null;
    try {
      computeBaseline([
        event({ taskId: TASK_A, type: "ATOMIC_STEP_COMPLETED", toState: "DISCOVERED" }),
      ]);
    } catch (error) {
      captured = error as BaselineStopError;
    }
    expect(captured?.reason).toBe("MISSING_TOKENS_USED");
  });

  it("refuses a non-integer or out-of-range token count", () => {
    const cases: { readonly used: unknown; readonly reason: string }[] = [
      { used: 1.5, reason: "MISSING_TOKENS_USED" },
      { used: "900", reason: "MISSING_TOKENS_USED" },
      { used: -1, reason: "TOKENS_OUT_OF_RANGE" },
      { used: TOKENS_USED_MAX + 1, reason: "TOKENS_OUT_OF_RANGE" },
    ];
    for (const { used, reason } of cases) {
      let captured: BaselineStopError | null = null;
      try {
        computeBaseline([
          event({ taskId: TASK_A, type: "ATOMIC_STEP_COMPLETED", toState: "DISCOVERED", payload: { tokensUsed: used } }),
        ]);
      } catch (error) {
        captured = error as BaselineStopError;
      }
      expect({ used, reason: captured?.reason }).toEqual({ used, reason });
    }
  });

  it("accepts the exact token bounds", () => {
    const baseline = computeBaseline([
      event({ taskId: TASK_A, transitionId: "a", type: "ATOMIC_STEP_COMPLETED", toState: "DISCOVERED", payload: { tokensUsed: 0 } }),
      event({ taskId: TASK_A, transitionId: "b", type: "ATOMIC_STEP_COMPLETED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:00:10.000Z", payload: { tokensUsed: TOKENS_USED_MAX } }),
    ]);
    expect(baseline.tokens).toEqual({ events: 2, total: TOKENS_USED_MAX });
  });

  it("refuses a timestamp regression rather than reporting a negative duration", () => {
    let captured: BaselineStopError | null = null;
    try {
      computeBaseline([
        event({ taskId: TASK_A, transitionId: "a", type: "TASK_DISCOVERED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:00:30.000Z" }),
        event({ taskId: TASK_A, transitionId: "b", type: "TASK_STATE_CHANGED", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:00.000Z" }),
      ]);
    } catch (error) {
      captured = error as BaselineStopError;
    }
    expect(captured?.reason).toBe("TIMESTAMP_REGRESSION");
  });

  it("refuses an event with no usable timestamp", () => {
    let captured: BaselineStopError | null = null;
    try {
      computeBaseline([event({ taskId: TASK_A, occurredAt: "not a timestamp" })]);
    } catch (error) {
      captured = error as BaselineStopError;
    }
    expect(captured?.reason).toBe("MISSING_TIMESTAMP");
  });

  it("refuses an audit with a missing or unrecognized verdict", () => {
    const cases: { readonly payload: Record<string, unknown>; readonly reason: string }[] = [
      { payload: {}, reason: "MISSING_VERDICT" },
      { payload: { verdict: "" }, reason: "MISSING_VERDICT" },
      { payload: { verdict: "LOOKS_FINE" }, reason: "VERDICT_NOT_RECOGNIZED" },
    ];
    for (const { payload, reason } of cases) {
      let captured: BaselineStopError | null = null;
      try {
        computeBaseline([
          event({ taskId: TASK_A, type: "AUDIT_COMPLETED", toState: "DISCOVERED", payload }),
        ]);
      } catch (error) {
        captured = error as BaselineStopError;
      }
      expect({ payload, reason: captured?.reason }).toEqual({ payload, reason });
    }
  });

  it("accepts every verdict in the closed set, and only those", () => {
    for (const verdict of AUDIT_VERDICTS) {
      const baseline = computeBaseline([
        event({ taskId: TASK_A, type: "AUDIT_COMPLETED", toState: "DISCOVERED", payload: { verdict } }),
      ]);
      expect(baseline.acceptance.byVerdict).toEqual([{ verdict, count: 1 }]);
    }
    expect([...AUDIT_VERDICTS]).toEqual(["ACCEPT", "ACCEPT_WITH_CORRECTIONS", "REJECT"]);
  });

  it("counts each terminal outcome type separately", () => {
    for (const type of TERMINAL_OUTCOME_TYPES) {
      const baseline = computeBaseline([
        event({ taskId: TASK_A, type, toState: "DISCOVERED" }),
      ]);
      const counted = baseline.acceptance.terminalOutcomes.filter((entry) => entry.count === 1);
      expect(counted).toEqual([{ type, count: 1 }]);
    }
  });

  it("carries no content in the error it throws", () => {
    let captured: BaselineStopError | null = null;
    try {
      computeBaseline([
        event({ taskId: TASK_A, type: "TASK_CLASSIFIED", toState: "DT_CLASSIFIED", payload: { reason: "" } }),
      ]);
    } catch (error) {
      captured = error as BaselineStopError;
    }
    // The reason code and the event type, and nothing quoted from the payload.
    expect(captured?.message).toBe("baseline stopped: MISSING_REASON at TASK_CLASSIFIED");
    expect(captured?.eventType).toBe("TASK_CLASSIFIED");
  });
});

describe("the serialization is canonical", () => {
  it("does not depend on how the measurement was reached", () => {
    // The same chain given in one order, and the same events with the second
    // task's block first: per-task sorting means the serialized answer is the
    // same string, which is what the rebuild proof compares.
    const chain = representativeChain();
    const taskAEvents = chain.filter((entry) => entry.taskId === TASK_A);
    const taskBEvents = chain.filter((entry) => entry.taskId === TASK_B);
    const reordered = [...taskBEvents, ...taskAEvents];

    expect(serializeBaseline(computeBaseline(reordered))).toBe(
      serializeBaseline(computeBaseline(chain)),
    );
  });

  it("changes when a measure changes", () => {
    const chain = representativeChain();
    const more = [
      ...chain,
      event({ taskId: TASK_A, transitionId: "extra", type: "ATOMIC_STEP_COMPLETED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:03:00.000Z", payload: { tokensUsed: 5 } }),
    ];
    expect(serializeBaseline(computeBaseline(more))).not.toBe(
      serializeBaseline(computeBaseline(chain)),
    );
  });
});
