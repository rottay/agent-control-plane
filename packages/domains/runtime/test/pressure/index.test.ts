import { PROVIDER_PRESSURES } from "@acp/contracts";
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
import { pressureTransitionId, recordProviderPressure } from "../../src/pressure/index.js";
import type { DurableInvocation } from "../../src/contracts/index.js";
import { deterministicUuid } from "../../src/core/coordinates/index.js";

/**
 * Evidence that a provider's own words about an account become one durable row
 * — and that they become nothing else.
 *
 * The claims this suite is responsible for are the ones a reader of the ledger
 * depends on: the row names the account, the provider and the classification
 * and carries no number; it lands under an event type that already exists; it
 * moves no lifecycle state; it appends once across a replay and twice for two
 * different frames; and a member that says nothing about the account appends
 * nothing at all.
 */

const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

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
    invocationId: deterministicUuid("pressure/" + taskId),
    submittedAt: AT,
    submissionDigest: "d".repeat(64),
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

function rowsOf(ledger: Ledger, taskId: string, type: string) {
  return ledger
    .listEvents({ taskId })
    .events.filter((record) => record.event.type === type)
    .map((record) => record.event);
}

describe("an observed pressure becomes one durable row", () => {
  it("records an exhaustion under the type that already exists", () => {
    const { ledger, invocation } = openWithTask(
      "pressure-exhausted",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b01",
    );
    const before = ledger.getTask(invocation.taskId)?.currentState;

    recordProviderPressure(ledger, {
      invocation,
      accountId: "acct-primary",
      provider: "codex",
      pressure: "QUOTA_EXHAUSTED",
      transitionId: pressureTransitionId(0, 3),
      emittedBy: EMITTED_BY,
    });

    // No 25th frozen type: an exhaustion is a QUOTA_WARNING row carrying the
    // classified kind, which is the reading `decideSwitch`'s own SWITCH branch
    // already takes.
    const rows = rowsOf(ledger, invocation.taskId, "QUOTA_WARNING");
    expect(rows).toHaveLength(1);
    // Deep equality, not containment: the payload is exactly three scalars.
    expect(rows[0]?.payload).toEqual({
      accountId: "acct-primary",
      provider: "codex",
      pressure: "QUOTA_EXHAUSTED",
    });
    // A passthrough: observing pressure moves no lifecycle state, and entering
    // QUOTA_BLOCKED is the elector's call in a later packet, never this one's.
    expect(rows[0]?.fromState).toBe(before);
    expect(rows[0]?.toState).toBe(before);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe(before);
  });

  it("records a warning under the same type, distinguished only by the payload", () => {
    const { ledger, invocation } = openWithTask(
      "pressure-warning",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b02",
    );
    recordProviderPressure(ledger, {
      invocation,
      accountId: "acct-primary",
      provider: "codex",
      pressure: "QUOTA_WARNING",
      transitionId: pressureTransitionId(0, 1),
      emittedBy: EMITTED_BY,
    });
    const rows = rowsOf(ledger, invocation.taskId, "QUOTA_WARNING");
    expect(rows[0]?.payload).toEqual({
      accountId: "acct-primary",
      provider: "codex",
      pressure: "QUOTA_WARNING",
    });
  });

  it("records an auth requirement under the type that names it", () => {
    const { ledger, invocation } = openWithTask(
      "pressure-auth",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b03",
    );
    recordProviderPressure(ledger, {
      invocation,
      accountId: "acct-primary",
      provider: "claude",
      pressure: "AUTH_REQUIRED",
      transitionId: pressureTransitionId(1, 0),
      emittedBy: EMITTED_BY,
    });
    const rows = rowsOf(ledger, invocation.taskId, "AUTH_REQUIRED_RAISED");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      accountId: "acct-primary",
      provider: "claude",
      pressure: "AUTH_REQUIRED",
    });
    // The producer this type acquires here is not the uncalled ESCALATE
    // branch of a switch decision: it is an account that a provider actually
    // refused, named at the moment it happened.
    expect(rows[0]?.emittedBy).toBe(EMITTED_BY);
  });

  it("records an opaque provider for a transport that carries no CLI name", () => {
    // A non-CLI route's provider is a bounded string the router admitted, and
    // both non-CLI legs already put `authRequired` on the trail. Dropping
    // those observations because the name is not in the CLI list would be a
    // fail-open on evidence in the one module built not to lose it.
    const { ledger, invocation } = openWithTask(
      "pressure-opaque",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b04",
    );
    recordProviderPressure(ledger, {
      invocation,
      accountId: "acct-api",
      provider: "anthropic-api",
      pressure: "AUTH_REQUIRED",
      transitionId: pressureTransitionId(0, 0),
      emittedBy: EMITTED_BY,
    });
    expect(rowsOf(ledger, invocation.taskId, "AUTH_REQUIRED_RAISED")[0]?.payload).toEqual({
      accountId: "acct-api",
      provider: "anthropic-api",
      pressure: "AUTH_REQUIRED",
    });
  });
});

describe("what says nothing about the account records nothing", () => {
  it("appends no row for a transient or an unclassified utterance", () => {
    const { ledger, invocation } = openWithTask(
      "pressure-silent",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b05",
    );
    const before = ledger.status().eventCount;
    for (const pressure of ["TRANSIENT", "UNCLASSIFIED"] as const) {
      recordProviderPressure(ledger, {
        invocation,
        accountId: "acct-primary",
        provider: "codex",
        pressure,
        transitionId: pressureTransitionId(0, pressure === "TRANSIENT" ? 1 : 2),
        emittedBy: EMITTED_BY,
      });
    }
    // The fail-closed direction is the cheap one: an unrecorded transient
    // costs nothing, and a transient recorded as quota costs an account.
    expect(ledger.status().eventCount).toBe(before);
  });

  it("has a destination for every member of the closed vocabulary, or none by design", () => {
    // Over the closed set, so a sixth member cannot be added without deciding
    // here where — if anywhere — it lands.
    const destination: Readonly<Record<string, string | null>> = {
      AUTH_REQUIRED: "AUTH_REQUIRED_RAISED",
      QUOTA_EXHAUSTED: "QUOTA_WARNING",
      QUOTA_WARNING: "QUOTA_WARNING",
      TRANSIENT: null,
      UNCLASSIFIED: null,
    };
    expect(Object.keys(destination).sort()).toEqual([...PROVIDER_PRESSURES].sort());

    const { ledger, invocation } = openWithTask(
      "pressure-total",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b06",
    );
    PROVIDER_PRESSURES.forEach((pressure, index) => {
      recordProviderPressure(ledger, {
        invocation,
        accountId: "acct-primary",
        provider: "codex",
        pressure,
        transitionId: pressureTransitionId(2, index),
        emittedBy: EMITTED_BY,
      });
    });
    for (const [pressure, type] of Object.entries(destination)) {
      const found = ledger
        .listEvents({ taskId: invocation.taskId })
        .events.filter((record) => record.event.payload["pressure"] === pressure);
      expect({ pressure, types: found.map((record) => record.event.type) }).toEqual({
        pressure,
        types: type === null ? [] : [type],
      });
    }
  });
});

describe("exactly once, and once per observed frame", () => {
  it("replays rather than appending a second row for the same observation", () => {
    const { ledger, invocation } = openWithTask(
      "pressure-replay",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b07",
    );
    const observation = {
      invocation,
      accountId: "acct-primary",
      provider: "codex",
      pressure: "QUOTA_EXHAUSTED" as const,
      transitionId: pressureTransitionId(0, 4),
      emittedBy: EMITTED_BY,
    };
    recordProviderPressure(ledger, observation);
    const after = ledger.status().eventCount;
    // A resumed attempt that re-executes rebuilds the identical name, so the
    // ledger recognises the key and the second append is a replay. The replay
    // is exact-bytes-only: an attempt whose provider said something different
    // at the same trail position conflicts instead, which is the same exposure
    // the landed usage recorder carries and is inherited rather than invented.
    recordProviderPressure(ledger, observation);
    expect(ledger.status().eventCount).toBe(after);
    expect(rowsOf(ledger, invocation.taskId, "QUOTA_WARNING")).toHaveLength(1);
  });

  it("gives two different frames in one stream two rows", () => {
    const { ledger, invocation } = openWithTask(
      "pressure-two-frames",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b08",
    );
    for (const trailIndex of [2, 5]) {
      recordProviderPressure(ledger, {
        invocation,
        accountId: "acct-primary",
        provider: "codex",
        pressure: "QUOTA_EXHAUSTED",
        transitionId: pressureTransitionId(0, trailIndex),
        emittedBy: EMITTED_BY,
      });
    }
    expect(rowsOf(ledger, invocation.taskId, "QUOTA_WARNING")).toHaveLength(2);
  });

  it("names rows from the trail position, so a hardcoded ordinal cannot collide", () => {
    // The landed usage recorder derives its durable name from the ordinal the
    // adapter reported, and one shipped adapter hardcodes that to zero: two
    // frames in one operation collide on one key and the second is a silent
    // replay. This module must not copy that shape.
    const first = pressureTransitionId(0, 0);
    const second = pressureTransitionId(0, 1);
    expect(first).not.toBe(second);
    expect(pressureTransitionId(0, 0)).toBe(first);
    for (const id of [first, second, pressureTransitionId(12, 340)]) {
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
      expect(id.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("the module never opens a task, and never invents a number", () => {
  it("refuses an observation for a task the ledger has never seen", () => {
    const root = scenario("pressure-unknown-task");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);

    expect(() => {
      recordProviderPressure(ledger, {
        invocation: invocationFor("9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b09"),
        accountId: "acct-primary",
        provider: "codex",
        pressure: "QUOTA_EXHAUSTED",
        transitionId: pressureTransitionId(0, 0),
        emittedBy: EMITTED_BY,
      });
    }).toThrow(SupervisorError);
    expect(ledger.status().eventCount).toBe(0);
  });

  it("refuses an observation with no account and one with no provider", () => {
    const { ledger, invocation } = openWithTask(
      "pressure-empty",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b0a",
    );
    const before = ledger.status().eventCount;
    for (const overrides of [{ accountId: "" }, { provider: "" }]) {
      expect(() => {
        recordProviderPressure(ledger, {
          invocation,
          accountId: "acct-primary",
          provider: "codex",
          pressure: "QUOTA_EXHAUSTED",
          transitionId: pressureTransitionId(0, 0),
          emittedBy: EMITTED_BY,
          ...overrides,
        });
      }).toThrow(SupervisorError);
    }
    expect(ledger.status().eventCount).toBe(before);
  });

  it("carries no count, ratio, reset instant, retry-after or limit", () => {
    const { ledger, invocation } = openWithTask(
      "pressure-no-numbers",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b0b",
    );
    recordProviderPressure(ledger, {
      invocation,
      accountId: "acct-primary",
      provider: "codex",
      pressure: "QUOTA_EXHAUSTED",
      transitionId: pressureTransitionId(0, 0),
      emittedBy: EMITTED_BY,
    });
    const row = rowsOf(ledger, invocation.taskId, "QUOTA_WARNING")[0];
    expect(Object.keys(row?.payload ?? {}).sort()).toEqual([
      "accountId",
      "pressure",
      "provider",
    ]);
    for (const value of Object.values(row?.payload ?? {})) {
      expect(typeof value).toBe("string");
    }
    const serialized = JSON.stringify(row);
    for (const token of ["remaining", "ratio", "resetAt", "nextResetAt", "retryAfter", "limit"]) {
      expect({ token, present: serialized.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("reads no clock: the coordinates come from the invocation", () => {
    const { ledger, invocation } = openWithTask(
      "pressure-no-clock",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b0c",
    );
    recordProviderPressure(ledger, {
      invocation,
      accountId: "acct-primary",
      provider: "codex",
      pressure: "QUOTA_EXHAUSTED",
      transitionId: pressureTransitionId(0, 0),
      emittedBy: EMITTED_BY,
    });
    const row = rowsOf(ledger, invocation.taskId, "QUOTA_WARNING")[0];
    // The submission instant, derived — so a reader can age the row at walk
    // granularity, and ordering within the walk is the ledger's own sequence.
    expect(row?.occurredAt).toBe(AT);
    expect(row?.recordedAt).toBe(AT);
    expect(row?.correlationId).toBe(invocation.invocationId);
    // Causation is null: the provider prompted this, and the provider is not
    // one of ours to name as a cause.
    expect(row?.causationId).toBeNull();
  });
});
