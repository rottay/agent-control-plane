import type { ResolvedRoute } from "@acp/contracts";
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
import { readAccountUsage, recordTokenObservation } from "../../src/usage/index.js";
import type { UsageEventSource } from "../../src/usage/index.js";
import type { DurableInvocation } from "../../src/contracts/index.js";
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

/**
 * Reading back what was recorded, for one account, exhaustively (V2-B1d).
 *
 * Driven through the structural `UsageEventSource` rather than a real ledger:
 * the ceiling case needs more rows than it is reasonable to append, and the
 * paging case needs a `hasMore` the fake can control precisely. What is under
 * test is the pager and its refusals, not SQLite.
 */
describe("reading one account's recorded usage", () => {
  const SINCE = "2026-08-28T11:00:00Z";
  const AFTER = "2026-08-28T11:30:00Z";

  function row(accountId: string, tokens: number, occurredAt = AFTER): { readonly event: never } {
    return { event: { payload: { accountId, tokens }, occurredAt } as never };
  }

  /** A source that hands out fixed pages, and records what it was asked. */
  function pagedSource(
    pages: readonly (readonly { readonly event: never }[])[],
  ): { readonly source: UsageEventSource; readonly asked: { readonly queries: unknown[] } } {
    const queries: unknown[] = [];
    let index = 0;
    const source: UsageEventSource = {
      listEvents: (query) => {
        queries.push(query);
        const events = pages[index] ?? [];
        const hasMore = index < pages.length - 1;
        index += 1;
        return { events, nextCursor: hasMore ? index : null, hasMore };
      },
    };
    return { source, asked: { queries } };
  }

  it("P4 sums across pages, following the cursor to exhaustion", () => {
    const { source, asked } = pagedSource([
      [row("acct-primary", 10), row("acct-primary", 20)],
      [row("acct-primary", 30)],
    ]);
    const outcome = readAccountUsage(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((o) => o.tokensUsed)).toEqual([10, 20, 30]);
    // Two pages, and the second was asked for by cursor rather than by offset.
    expect(asked.queries).toHaveLength(2);
    expect(asked.queries[0]).toMatchObject({ type: "TOKEN_USAGE_RECORDED", afterSequence: 0 });
    expect(asked.queries[1]).toMatchObject({ afterSequence: 1 });
  });

  it("P5 sums only the requested account from a mixed ledger", () => {
    const { source } = pagedSource([
      [row("acct-primary", 10), row("acct-other", 900), row("acct-primary", 5)],
    ]);
    const primary = readAccountUsage(source, "acct-primary", { since: SINCE });
    expect(primary.ok).toBe(true);
    if (!primary.ok) return;
    expect(primary.observations.map((o) => o.tokensUsed)).toEqual([10, 5]);

    const { source: second } = pagedSource([
      [row("acct-primary", 10), row("acct-other", 900), row("acct-primary", 5)],
    ]);
    const other = readAccountUsage(second, "acct-other", { since: SINCE });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.observations.map((o) => o.tokensUsed)).toEqual([900]);
  });

  it("N6 counts the ceiling per account, never plane-wide", () => {
    // A ledger heavy with other accounts' rows must not refuse this account's
    // election. `EventQuery` has no account filter, so a plane-wide ceiling
    // would fail every election permanently once the ledger grew -- monotone,
    // silent and plane-wide.
    const noisy = Array.from({ length: 5_000 }, () => row("acct-other", 1));
    const { source } = pagedSource([[...noisy, row("acct-primary", 7)]]);
    const outcome = readAccountUsage(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations).toEqual([{ tokensUsed: 7, observedAt: AFTER }]);
  });

  it("N6 refuses when this account alone exceeds the ceiling, with no truncated success", () => {
    const pages: (readonly { readonly event: never }[])[] = [];
    for (let page = 0; page < 101; page += 1) {
      pages.push(Array.from({ length: 1_000 }, () => row("acct-primary", 1)));
    }
    const { source } = pagedSource(pages);
    const outcome = readAccountUsage(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("OBSERVATION_COUNT_EXCEEDED");
  });

  it("N7 propagates a page read that throws, and returns no partial sum", () => {
    let calls = 0;
    const source: UsageEventSource = {
      listEvents: () => {
        calls += 1;
        if (calls === 1) {
          return { events: [row("acct-primary", 10)], nextCursor: 1, hasMore: true };
        }
        throw new Error("the ledger went away mid-scan");
      },
    };
    expect(() => readAccountUsage(source, "acct-primary", { since: SINCE })).toThrow();
  });

  it("returns the fold's refusal verbatim rather than summarising it", () => {
    const { source } = pagedSource([[row("acct-primary", -1)]]);
    const outcome = readAccountUsage(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("OBSERVATION_INVALID");
    expect(outcome.at).toBe("rows[0].payload.tokens");
  });

  it("excludes rows at or before the anchor", () => {
    const { source } = pagedSource([
      [row("acct-primary", 10, "2026-08-28T10:00:00Z"), row("acct-primary", 20, SINCE), row("acct-primary", 30)],
    ]);
    const outcome = readAccountUsage(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((o) => o.tokensUsed)).toEqual([30]);
  });
});
