import { randomUUID } from "node:crypto";

import { CONTRACT_VERSION, buildIdempotencyKey } from "@acp/contracts";
import type { ControlPlaneEvent, ControlPlaneEventType } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import {
  ROLLUP_TOKENS_MAX,
  UNSCOPED_INITIATIVE,
  computeTokenRollups,
} from "../../src/index.js";

/**
 * Evidence for the token rollups.
 *
 * Nothing here opens a ledger: the fold takes contract values and a mapping,
 * so its whole surface is testable as data. That is the property the tests are
 * really holding — a rollup that needed a database to be checked would not be
 * the pure fold the design ruled for.
 */

const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";
const TASK_C = "33333333-3333-4333-8333-333333333333";
const INITIATIVE_ONE = "44444444-4444-4444-8444-444444444444";
const INITIATIVE_TWO = "55555555-5555-4555-8555-555555555555";
const AT = "2026-08-30T12:00:00.000Z";
const EMITTER = "claude/opus/implementer/01";

interface EventInput {
  readonly taskId: string;
  readonly type: ControlPlaneEventType;
  readonly transitionId: string;
  readonly payload: Record<string, unknown>;
}

function event(input: EventInput): ControlPlaneEvent {
  const attempt = 1;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId: input.taskId,
    attempt,
    transitionId: input.transitionId,
    idempotencyKey: buildIdempotencyKey({
      taskId: input.taskId,
      attempt,
      transitionId: input.transitionId,
    }),
    type: input.type,
    fromState: "RUNNING",
    toState: "RUNNING",
    emittedBy: EMITTER,
    occurredAt: AT,
    recordedAt: AT,
    correlationId: null,
    causationId: null,
    payload: input.payload,
  };
}

function usage(taskId: string, tokens: unknown, transitionId: string): ControlPlaneEvent {
  return event({
    taskId,
    type: "TOKEN_USAGE_RECORDED",
    transitionId,
    payload: { accountId: "acct-a", tokens },
  });
}

function reservation(taskId: string, tokens: unknown, transitionId: string): ControlPlaneEvent {
  return event({
    taskId,
    type: "TOKEN_RESERVATION_RECORDED",
    transitionId,
    payload: { accountId: "acct-a", tokens },
  });
}

describe("usage accumulates and reservations supersede", () => {
  it("sums every usage event for a task", () => {
    const rollups = computeTokenRollups({
      events: [usage(TASK_A, 100, "u1"), usage(TASK_A, 250, "u2"), usage(TASK_A, 7, "u3")],
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });

    expect(rollups.byTask).toHaveLength(1);
    expect(rollups.byTask[0]?.tokensUsed).toBe(357);
    expect(rollups.byTask[0]?.usageEvents).toBe(3);
    expect(rollups.tokensUsed).toBe(357);
  });

  it("keeps only the last reservation, in ledger order", () => {
    const rollups = computeTokenRollups({
      events: [
        reservation(TASK_A, 500, "r1"),
        reservation(TASK_A, 900, "r2"),
        reservation(TASK_A, 300, "r3"),
      ],
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });

    // A hold is current, not cumulative: 300 stands, and 1700 would be a lie
    // about how much this task is holding.
    expect(rollups.byTask[0]?.tokensReserved).toBe(300);
    expect(rollups.byTask[0]?.reservationEvents).toBe(3);
    expect(rollups.tokensReserved).toBe(300);
  });

  it("reads ledger order from the input, not from the payload's own numbers", () => {
    const ascending = computeTokenRollups({
      events: [reservation(TASK_A, 100, "r1"), reservation(TASK_A, 900, "r2")],
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });
    const descending = computeTokenRollups({
      events: [reservation(TASK_A, 900, "r2"), reservation(TASK_A, 100, "r1")],
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });

    expect(ascending.byTask[0]?.tokensReserved).toBe(900);
    expect(descending.byTask[0]?.tokensReserved).toBe(100);
  });

  it("keeps usage and reservations apart on the same task", () => {
    const rollups = computeTokenRollups({
      events: [usage(TASK_A, 100, "u1"), reservation(TASK_A, 400, "r1"), usage(TASK_A, 50, "u2")],
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });

    expect(rollups.byTask[0]?.tokensUsed).toBe(150);
    expect(rollups.byTask[0]?.tokensReserved).toBe(400);
  });
});

describe("initiatives aggregate their tasks", () => {
  it("sums both measures across the tasks of one initiative", () => {
    const rollups = computeTokenRollups({
      events: [
        usage(TASK_A, 100, "u1"),
        reservation(TASK_A, 40, "r1"),
        usage(TASK_B, 200, "u1"),
        reservation(TASK_B, 60, "r1"),
        usage(TASK_C, 900, "u1"),
      ],
      initiativeByTask: new Map([
        [TASK_A, INITIATIVE_ONE],
        [TASK_B, INITIATIVE_ONE],
        [TASK_C, INITIATIVE_TWO],
      ]),
    });

    const one = rollups.byInitiative.find((row) => row.initiativeId === INITIATIVE_ONE);
    const two = rollups.byInitiative.find((row) => row.initiativeId === INITIATIVE_TWO);

    expect(one?.tokensUsed).toBe(300);
    // Two tasks each holding their own reservation coexist: the initiative
    // holds both.
    expect(one?.tokensReserved).toBe(100);
    expect(one?.taskCount).toBe(2);
    expect(two?.tokensUsed).toBe(900);
    expect(two?.tokensReserved).toBe(0);
    expect(two?.taskCount).toBe(1);
    expect(rollups.tokensUsed).toBe(1_200);
  });

  it("orders both projections deterministically", () => {
    const rollups = computeTokenRollups({
      events: [usage(TASK_C, 1, "u1"), usage(TASK_A, 1, "u1"), usage(TASK_B, 1, "u1")],
      initiativeByTask: new Map([
        [TASK_C, INITIATIVE_TWO],
        [TASK_A, INITIATIVE_ONE],
        [TASK_B, INITIATIVE_ONE],
      ]),
    });

    expect(rollups.byTask.map((row) => row.taskId)).toEqual([TASK_A, TASK_B, TASK_C]);
    expect(rollups.byInitiative.map((row) => row.initiativeId)).toEqual([
      INITIATIVE_ONE,
      INITIATIVE_TWO,
    ]);
  });
});

describe("the unscoped bucket", () => {
  it("holds tasks with no initiative rather than dropping them", () => {
    const rollups = computeTokenRollups({
      events: [usage(TASK_A, 100, "u1"), usage(TASK_B, 250, "u1")],
      // TASK_A is mapped to null (an old TASK_DISCOVERED); TASK_B is absent
      // from the map entirely. Both are unscoped, and both must be visible.
      initiativeByTask: new Map([[TASK_A, null]]),
    });

    const unscoped = rollups.byInitiative.find(
      (row) => row.initiativeId === UNSCOPED_INITIATIVE,
    );
    expect(unscoped?.tokensUsed).toBe(350);
    expect(unscoped?.taskCount).toBe(2);
    expect(rollups.byTask.every((row) => row.initiativeId === null)).toBe(true);
    // Nothing is lost: the grand total accounts for every event.
    expect(rollups.tokensUsed).toBe(350);
  });

  it("sorts the unscoped bucket among the initiatives by name", () => {
    const rollups = computeTokenRollups({
      events: [usage(TASK_A, 1, "u1"), usage(TASK_B, 1, "u1")],
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });

    const ids = rollups.byInitiative.map((row) => row.initiativeId);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain(UNSCOPED_INITIATIVE);
  });
});

describe("malformed payloads are skipped and counted", () => {
  it("counts every shape the convention does not name", () => {
    const rollups = computeTokenRollups({
      events: [
        usage(TASK_A, 100, "u1"),
        usage(TASK_A, "many", "u2"),
        usage(TASK_A, 1.5, "u3"),
        usage(TASK_A, -1, "u4"),
        usage(TASK_A, ROLLUP_TOKENS_MAX + 1, "u5"),
        event({
          taskId: TASK_A,
          type: "TOKEN_USAGE_RECORDED",
          transitionId: "u6",
          payload: { tokens: 5 },
        }),
        reservation(TASK_A, null, "r1"),
      ],
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });

    // Only the first event is well formed. The other six are counted, not
    // silently dropped and not thrown.
    expect(rollups.byTask[0]?.tokensUsed).toBe(100);
    expect(rollups.byTask[0]?.usageEvents).toBe(1);
    expect(rollups.byTask[0]?.reservationEvents).toBe(0);
    expect(rollups.byTask[0]?.skippedMalformed).toBe(6);
    expect(rollups.skippedMalformed).toBe(6);
    expect(rollups.byInitiative[0]?.skippedMalformed).toBe(6);
  });

  it("keeps a task whose every event was malformed, with zero totals", () => {
    const rollups = computeTokenRollups({
      events: [usage(TASK_A, "nope", "u1")],
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });

    expect(rollups.byTask).toHaveLength(1);
    expect(rollups.byTask[0]?.tokensUsed).toBe(0);
    expect(rollups.byTask[0]?.skippedMalformed).toBe(1);
    // It contributed no well-formed event, so it is not counted as a
    // contributor — but the skip is still attributed to its initiative.
    expect(rollups.byInitiative[0]?.taskCount).toBe(0);
    expect(rollups.byInitiative[0]?.skippedMalformed).toBe(1);
  });

  it("never refuses, and never throws", () => {
    expect(() =>
      computeTokenRollups({
        events: [usage(TASK_A, Number.NaN, "u1"), reservation(TASK_B, {}, "r1")],
        initiativeByTask: new Map(),
      }),
    ).not.toThrow();
  });

  it("skips a sum that would leave the safe integer range", () => {
    const many = Array.from({ length: 3 }, (unused, index) =>
      usage(TASK_A, ROLLUP_TOKENS_MAX, "u" + String(index)),
    );
    const rollups = computeTokenRollups({
      events: many,
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });

    // Well within the safe range: three maxima still sum honestly.
    expect(rollups.byTask[0]?.tokensUsed).toBe(ROLLUP_TOKENS_MAX * 3);
    expect(rollups.byTask[0]?.skippedMalformed).toBe(0);
  });
});

describe("the fold is pure", () => {
  it("is byte-identical across two folds of the same input", () => {
    const input = {
      events: [
        usage(TASK_A, 10, "u1"),
        reservation(TASK_A, 20, "r1"),
        usage(TASK_B, 30, "u1"),
        usage(TASK_C, 40, "u1"),
      ],
      initiativeByTask: new Map([
        [TASK_A, INITIATIVE_ONE],
        [TASK_B, INITIATIVE_TWO],
        [TASK_C, null],
      ]),
    };

    expect(JSON.stringify(computeTokenRollups(input))).toBe(
      JSON.stringify(computeTokenRollups(input)),
    );
  });

  it("ignores every event type outside the two it reads", () => {
    const rollups = computeTokenRollups({
      events: [
        event({
          taskId: TASK_A,
          type: "ATOMIC_STEP_COMPLETED",
          transitionId: "step",
          payload: { tokensUsed: 9_999, accountId: "acct-a", tokens: 9_999 },
        }),
        usage(TASK_A, 5, "u1"),
      ],
      initiativeByTask: new Map([[TASK_A, INITIATIVE_ONE]]),
    });

    // The baseline's own measure reads `tokensUsed` on a different event type.
    // This fold reads two types and nothing else, even when a payload happens
    // to carry a shape it would otherwise recognize.
    expect(rollups.byTask[0]?.tokensUsed).toBe(5);
    expect(rollups.byTask[0]?.usageEvents).toBe(1);
  });

  it("folds an empty chain into an empty rollup", () => {
    const rollups = computeTokenRollups({ events: [], initiativeByTask: new Map() });

    expect(rollups.byTask).toEqual([]);
    expect(rollups.byInitiative).toEqual([]);
    expect(rollups.tokensUsed).toBe(0);
    expect(rollups.tokensReserved).toBe(0);
    expect(rollups.skippedMalformed).toBe(0);
  });
});
