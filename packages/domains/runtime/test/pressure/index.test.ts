import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDER_PRESSURES } from "@acp/contracts";
import type { ControlPlaneEvent as ControlPlaneEventValue, ResolvedRoute } from "@acp/contracts";
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
import {
  pressureTransitionId,
  readAccountPressure,
  recordProviderPressure,
} from "../../src/pressure/index.js";
import type { PressureEventSource } from "../../src/pressure/index.js";
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

// ---------------------------------------------------------------------------
// V2-B1f/F4b — the reader
// ---------------------------------------------------------------------------

const SINCE = "2026-09-05T12:00:00.000Z";
const AFTER = "2026-09-05T12:30:00.000Z";
const BEFORE = "2026-09-05T11:30:00.000Z";

interface SourceEvent {
  readonly sequence: number;
  readonly event: ControlPlaneEventValue;
}

/** One F4a pressure row, as the ledger hands it back. */
function pressureRow(
  sequence: number,
  overrides: {
    readonly accountId?: string;
    readonly provider?: string;
    readonly pressure?: string;
    readonly type?: string;
    readonly occurredAt?: string;
    readonly payload?: Record<string, unknown>;
  } = {},
): SourceEvent {
  const payload = overrides.payload ?? {
    accountId: overrides.accountId ?? "acct-primary",
    provider: overrides.provider ?? "codex",
    pressure: overrides.pressure ?? "QUOTA_EXHAUSTED",
  };
  return {
    sequence,
    event: {
      type: overrides.type ?? "QUOTA_WARNING",
      eventId: "ev-" + String(sequence),
      occurredAt: overrides.occurredAt ?? AFTER,
      payload,
    } as unknown as ControlPlaneEventValue,
  };
}

/** A source that hands out fixed pages per type, and records what it was asked. */
function pagedSource(byType: Readonly<Record<string, readonly (readonly SourceEvent[])[]>>): {
  readonly source: PressureEventSource;
  readonly queries: unknown[];
} {
  const queries: unknown[] = [];
  const cursors: Record<string, number> = {};
  const source: PressureEventSource = {
    listEvents: (query) => {
      queries.push(query);
      const type = String(query.type);
      const pages = byType[type] ?? [];
      const index = cursors[type] ?? 0;
      const events = pages[index] ?? [];
      const hasMore = index < pages.length - 1;
      cursors[type] = index + 1;
      return { events, nextCursor: hasMore ? index + 1 : null, hasMore };
    },
  };
  return { source, queries };
}

describe("F4b P3: the reader pages, merges, filters and bounds", () => {
  it("asks for both event types, exhaustively, following each cursor", () => {
    // Both types, because the fold must see an auth-only account to refuse it
    // honestly rather than as an anonymous silence.
    const { source, queries } = pagedSource({
      QUOTA_WARNING: [[pressureRow(2)], [pressureRow(4)]],
      AUTH_REQUIRED_RAISED: [
        [pressureRow(3, { type: "AUTH_REQUIRED_RAISED", pressure: "AUTH_REQUIRED" })],
      ],
    });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((row) => row.sequence)).toEqual([2, 3, 4]);
    expect(queries.map((query) => (query as { type: string }).type)).toEqual([
      "QUOTA_WARNING",
      "QUOTA_WARNING",
      "AUTH_REQUIRED_RAISED",
    ]);
    expect(queries[1]).toMatchObject({ afterSequence: 1 });
  });

  it("merges the two type scans ascending by ledger sequence, not by instant", () => {
    // The instants tie deliberately: F4a rows carry the walk's submission
    // instant, so two rows of one walk are indistinguishable by `occurredAt`
    // and only the ledger's own position orders them.
    const { source } = pagedSource({
      QUOTA_WARNING: [[pressureRow(9), pressureRow(3)]],
      AUTH_REQUIRED_RAISED: [
        [
          pressureRow(6, { type: "AUTH_REQUIRED_RAISED", pressure: "AUTH_REQUIRED" }),
          pressureRow(1, { type: "AUTH_REQUIRED_RAISED", pressure: "AUTH_REQUIRED" }),
        ],
      ],
    });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((row) => row.sequence)).toEqual([1, 3, 6, 9]);
    expect(new Set(outcome.observations.map((row) => row.occurredAt))).toEqual(new Set([AFTER]));
  });

  it("keeps only this account's rows from a mixed ledger", () => {
    const { source } = pagedSource({
      QUOTA_WARNING: [[pressureRow(1), pressureRow(2, { accountId: "acct-other" }), pressureRow(3)]],
    });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((row) => row.sequence)).toEqual([1, 3]);
    expect(new Set(outcome.observations.map((row) => row.accountId))).toEqual(
      new Set(["acct-primary"]),
    );
  });

  it("excludes a row at or before the baseline, and keeps one strictly after it", () => {
    // The usage fold's rule verbatim: a row at the exact instant the baseline
    // was published is already inside it.
    const { source } = pagedSource({
      QUOTA_WARNING: [
        [
          pressureRow(1, { occurredAt: BEFORE }),
          pressureRow(2, { occurredAt: SINCE }),
          pressureRow(3, { occurredAt: AFTER }),
        ],
      ],
    });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((row) => row.sequence)).toEqual([3]);
  });

  it("carries the row's own provider, pressure, instant, sequence and event id", () => {
    const { source } = pagedSource({
      QUOTA_WARNING: [[pressureRow(5, { provider: "anthropic-api", pressure: "QUOTA_WARNING" })]],
    });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations[0]).toEqual({
      accountId: "acct-primary",
      provider: "anthropic-api",
      pressure: "QUOTA_WARNING",
      occurredAt: AFTER,
      sequence: 5,
      eventId: "ev-5",
    });
  });

  it("returns an empty success when the account recorded nothing in the window", () => {
    const { source } = pagedSource({});
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome).toEqual({ ok: true, observations: [] });
  });
});

describe("F4b N5: a decision can never feed its own next decision", () => {
  it("skips a plan-produced row that carries no pressure member, and does not refuse", () => {
    // The exact shape the switch decision's own DRAIN plan produces: a
    // QUOTA_WARNING event whose payload is `{accountId}` with no `pressure`
    // key. The day a later packet plays such a plan, those rows must not read
    // back as observations. Skipped, not refused: the ledger is not malformed.
    const { source } = pagedSource({
      QUOTA_WARNING: [
        [
          pressureRow(1, { payload: { accountId: "acct-primary" } }),
          pressureRow(2),
          pressureRow(3, { payload: { accountId: "acct-primary", provider: "codex" } }),
        ],
      ],
    });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((row) => row.sequence)).toEqual([2]);
  });

  it("skips a row whose pressure is outside the closed vocabulary", () => {
    const { source } = pagedSource({
      QUOTA_WARNING: [[pressureRow(1, { pressure: "DRAINING" }), pressureRow(2)]],
    });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((row) => row.sequence)).toEqual([2]);
  });

  it("skips a row with an empty provider or a non-string payload", () => {
    const { source } = pagedSource({
      QUOTA_WARNING: [
        [
          pressureRow(1, { provider: "" }),
          pressureRow(2, { payload: { accountId: "acct-primary", provider: "codex", pressure: 7 } }),
          pressureRow(3),
        ],
      ],
    });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((row) => row.sequence)).toEqual([3]);
  });
});

describe("F4b N6: a refusal, never a truncation", () => {
  it("refuses above the ceiling rather than folding a prefix", () => {
    // Folding a prefix would let an exhaustion at row n+1 read as a warning,
    // and this is a set where the most severe row decides rather than the
    // newest — so a truncated success is a wrong answer, not a partial one.
    const pages: (readonly SourceEvent[])[] = [];
    for (let page = 0; page < 101; page += 1) {
      pages.push(
        Array.from({ length: 1_000 }, (_unused, index) => pressureRow(page * 1_000 + index + 1)),
      );
    }
    const { source } = pagedSource({ QUOTA_WARNING: pages });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ reason: outcome.reason, at: outcome.at }).toEqual({
      reason: "PRESSURE_HISTORY_EXCEEDED",
      at: "observations",
    });
  });

  it("counts the ceiling per account, never plane-wide", () => {
    const noisy = Array.from({ length: 5_000 }, (_unused, index) =>
      pressureRow(index + 1, { accountId: "acct-other" }),
    );
    const { source } = pagedSource({ QUOTA_WARNING: [[...noisy, pressureRow(9_001)]] });
    const outcome = readAccountPressure(source, "acct-primary", { since: SINCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.observations.map((row) => row.sequence)).toEqual([9_001]);
  });

  it("refuses an unparseable baseline rather than reading from the beginning of time", () => {
    // The reader is total, exactly as the usage fold is. The one production
    // caller passes a contract Timestamp and cannot reach this, which is why
    // it is asserted here rather than left to be discovered.
    const { source } = pagedSource({ QUOTA_WARNING: [[pressureRow(1)]] });
    const outcome = readAccountPressure(source, "acct-primary", { since: "not-an-instant" });
    expect(outcome).toEqual({ ok: false, reason: "SINCE_INVALID", at: "since" });
  });

  it("propagates a page read that throws, and returns no partial history", () => {
    let calls = 0;
    const source: PressureEventSource = {
      listEvents: () => {
        calls += 1;
        if (calls === 1) return { events: [pressureRow(1)], nextCursor: 1, hasMore: true };
        throw new Error("the ledger went away mid-scan");
      },
    };
    expect(() => readAccountPressure(source, "acct-primary", { since: SINCE })).toThrow();
  });
});

describe("F4b N7: the reader reads no clock and no random source", () => {
  it("takes every instant from the rows themselves", () => {
    const here = resolve(fileURLToPath(import.meta.url), "..");
    const source = readFileSync(join(here, "..", "..", "src", "pressure", "index.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const token of ["Date.now", "new Date(", "performance.now", "Math.random", "process.env"]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
    // `Date.parse` is the one date call, and it only reads what it was handed.
    expect(code).toContain("Date.parse");
  });

  it("is deterministic over the same pages", () => {
    const build = () =>
      pagedSource({
        QUOTA_WARNING: [[pressureRow(2), pressureRow(1)]],
        AUTH_REQUIRED_RAISED: [
          [pressureRow(3, { type: "AUTH_REQUIRED_RAISED", pressure: "AUTH_REQUIRED" })],
        ],
      }).source;
    const first = JSON.stringify(readAccountPressure(build(), "acct-primary", { since: SINCE }));
    for (let index = 0; index < 20; index += 1) {
      expect(JSON.stringify(readAccountPressure(build(), "acct-primary", { since: SINCE }))).toBe(
        first,
      );
    }
  });
});
