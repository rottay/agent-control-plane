import { CONTRACT_VERSION } from "@acp/contracts";
import type { ControlPlaneEvent, ResolvedRoute } from "@acp/contracts";
import {
  LedgerIdempotencyConflictError,
  LedgerValidationError,
  effectIdV1,
  effectIdempotencyKeyV1,
  logicalOperationSha256,
  measurementStreamIdV1,
  openLedger,
  requestSha256,
} from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { ATTEMPT_OPENING_STEP } from "../../src/core/events/index.js";
import { LIFECYCLE_PLAN, planStep } from "../../src/core/lifecycle/index.js";
import { appendPlanStep } from "../../src/core/step-executor/index.js";
import type { BeatContext, LedgerPort } from "../../src/core/step-executor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import { deriveInvocation } from "../../src/submission/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";
import {
  readAccountUsage,
  readUsageStreamLineage,
  recordTokenObservation,
  recordUsageObservation,
  recordUsageStreamDeclaration,
  usageObservationTransitionId,
  usageStreamTransitionId,
  usageTransitionId,
} from "../../src/usage/index.js";
import type {
  UsageEventSource,
  UsageObservationReport,
  UsageStreamDeclaration,
} from "../../src/usage/index.js";
import type { DurableInvocation, InvocationRevision } from "../../src/contracts/index.js";
import { deriveEventCoordinate, deterministicUuid } from "../../src/core/coordinates/index.js";


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

describe("the durable name a usage row is recorded under", () => {
  it("V2-B1f/F5: spells the generation, the operation and the step, in that order", () => {
    // The call form, not a literal. Every production caller passes a landing
    // generation now, and an unlanded walk passes zero uniformly — no caller
    // special-cases it, which is what keeps the two spellings from drifting.
    //
    // **One arity, and it is three.** The two-component form is gone rather
    // than overloaded: an optional generation would make "every caller states
    // one" unprovable by construction, and a default of zero would silently
    // re-key a landed walk's rows onto the source's. The compiler is what finds
    // a caller that did not move, and it found all four.
    expect(usageTransitionId.length).toBe(3);
    expect(usageTransitionId(0, 4, 0)).toBe("usage.0.4.0");
    expect(usageTransitionId(0, 4, 1)).toBe("usage.0.4.1");
    expect(usageTransitionId(1, 4, 0)).toBe("usage.1.4.0");

    // The whole point of the third component: one operation, one step, two
    // accounts — and two names rather than one collision.
    expect(usageTransitionId(0, 4, 0)).not.toBe(usageTransitionId(1, 4, 0));

    // And every form still satisfies the contract's transition-id grammar.
    for (const generation of [0, 1]) {
      for (const step of [0, 9]) {
        expect(usageTransitionId(generation, 4, step)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
      }
    }
  });

  it("V2-B1f/F5: the name a recorded row carries is the one the producer built", () => {
    const { ledger, invocation } = openWithTask(
      "usage-generation",
      "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a09",
    );
    const source = recordTokenObservation(ledger, {
      invocation,
      kind: "USAGE",
      accountId: "acct-primary",
      tokens: 10,
      transitionId: usageTransitionId(0, 4, 0),
      emittedBy: EMITTED_BY,
    });
    const destination = recordTokenObservation(ledger, {
      invocation,
      kind: "USAGE",
      accountId: "acct-destination",
      tokens: 20,
      transitionId: usageTransitionId(1, 4, 0),
      emittedBy: EMITTED_BY,
    });

    expect(source.event.transitionId).toBe("usage.0.4.0");
    expect(destination.event.transitionId).toBe("usage.1.4.0");
    expect(source.inserted).toBe(true);
    expect(destination.inserted).toBe(true);
    expect(ledger.status().eventCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// P-32/captura C — a usage recorder reports what the adapter already
// normalized, and restarts never reinvent an epoch (ADR 0090)
//
// The recorders append through the ledger's real door, so the chain the door
// needs is built here: an envelope reference, the walk's own attempt opening
// and discovery, an effect intended on segment `seg-1` and its first delivery.
// No producer of effects or deliveries ships in the runtime (ADR 0080), so the
// last two are appended through the door exactly as the step executor's suite
// does — its private helpers are restated below rather than shared (H-4). What
// is not fabricated is the coordinate: every event is on the invocation the
// walk opened.
// ---------------------------------------------------------------------------

const V2_AT = "2026-09-13T12:00:00.000Z";
const REPORT_AT = "2026-09-13T12:05:30.250Z";
const USAGE_SOURCE = "claude-code/stream-json";
const USAGE_POLICY = "d".repeat(64);
const SCOPE = "run";
const STEP_KEY = "compose-answer";
const NEUTRAL_REQUEST = { operation: "compose", inputs: ["a", "b"] };

function envelopeReferenceFor(taskId: string): string {
  return "ref-envelope-" + taskId;
}

function revisionFor(taskId: string): InvocationRevision {
  return {
    revisionId: deterministicUuid("revision/" + taskId + "/1"),
    revisionNumber: 1,
    attemptNumber: 1,
    envelopeSha256: "e".repeat(64),
    envelopeArtifactReferenceId: envelopeReferenceFor(taskId),
  };
}

/** Register the task's envelope reference, as a fixture (the step executor's suite, restated). */
/**
 * The fixture price catalog a delivery is pinned to (P-15 escalón C, ADR 0103).
 *
 * From 2.9.0 a `DISPATCH_INTENDED` names the catalog version in force at its
 * instant, and one that covers its segment, or the door refuses it: pre-2.9.0
 * fixtures had to gain a pin because the version in force now requires one. So the
 * fixture publishes one through the registry's own door — the segment's model
 * version registered under its provider, then version 1 of a `PRICE_TABLE` pricing
 * that model on the segment's transport from before any fixture instant, with no
 * end. The price is fixture data, and never zero.
 */
const FIXTURE_CATALOG = "catalog-fixture";
const FIXTURE_MODEL_VERSION = "claude-opus-5-20260101";
const FIXTURE_CATALOG_FROM = "2026-01-01T00:00:00.000Z";
const FIXTURE_PIN = { catalogDocumentId: FIXTURE_CATALOG, catalogVersion: 1 } as const;

function plantFixtureCatalog(ledger: Ledger): void {
  if (ledger.getVigentCatalogPin(FIXTURE_CATALOG, FIXTURE_CATALOG_FROM) !== null) return;
  const document = (
    eventId: string,
    documentKind: string,
    documentId: string,
    contentDigest: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId,
    idempotencyKey: documentId + "/1",
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    contentDigest,
    recordedBy: "kimi/k3/coordinator/01",
    effectiveFrom: FIXTURE_CATALOG_FROM,
    occurredAt: FIXTURE_CATALOG_FROM,
    recordedAt: FIXTURE_CATALOG_FROM,
    payload,
  });
  ledger.appendRegistryEvent(
    document("c0c0c0c0-0000-4000-8000-00000000c001", "MODEL_VERSION", FIXTURE_MODEL_VERSION, "6".repeat(64), {
      provider: "anthropic",
      model: "claude-opus-5",
      release: "2026-01-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["coordinator", "implementer", "reviewer", "consultant", "verifier"],
      transports: ["CLI_SUBSCRIPTION"],
    }),
  );
  ledger.appendRegistryEvent(
    document("c0c0c0c0-0000-4000-8000-00000000c002", "PRICE_TABLE", FIXTURE_CATALOG, "5".repeat(64), {
      intervals: [
        {
          provider: "anthropic",
          modelVersionId: FIXTURE_MODEL_VERSION,
          transportKind: "CLI_SUBSCRIPTION",
          tokenClass: "input",
          currency: "USD",
          effectiveFrom: FIXTURE_CATALOG_FROM,
          effectiveTo: null,
          pricePerMillionNanos: 15_000_000_000,
        },
      ],
    }),
  );
}

function plantEnvelopeReference(ledger: Ledger, taskId: string): void {
  const reference = envelopeReferenceFor(taskId);
  if (ledger.getArtifactReference(reference) !== null) return;
  const content = "7".repeat(64);
  const envelope = (kind: string, ordinal: number, payload: Record<string, unknown>): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId: deterministicUuid("envelope/" + taskId + "/" + kind),
    idempotencyKey: "envelope/" + taskId + "/" + kind,
    subjectKind: "ARTIFACT",
    artifactEventKind: kind,
    subjectOrdinal: ordinal,
    parentSubjectOrdinal: ordinal === 1 ? null : ordinal - 1,
    recordedBy: EMITTED_BY,
    occurredAt: V2_AT,
    recordedAt: V2_AT,
    payload,
  });
  const common = { commandId: "cmd-envelope", contentSha256: content, blobGeneration: 1, artifactPinId: "pin-envelope" };
  ledger.appendArtifactEvent(
    envelope("PUBLICATION_INTENDED", 1, {
      ...common,
      mediaType: "application/json",
      sizeBytes: 128,
      encryptionStatus: "PLAINTEXT",
      keyReference: null,
      encryptionProfile: "local-plaintext-v1",
    }),
  );
  ledger.appendArtifactEvent(
    envelope("PUBLICATION_SUCCEEDED", 2, {
      ...common,
      reference: {
        artifactReferenceId: reference,
        artifactClass: "TASK_ENVELOPE",
        classification: "INTERNAL",
        scopeKind: "TASK",
        scopeId: taskId,
        producerIdentity: EMITTED_BY,
        accessPolicyId: "SCOPE_EQUALITY_V1",
        retentionClass: "STANDARD",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
    }),
  );
}

/** One segment record, in the nested shape the ledger's door reads. */
function segmentRecord(accountId: string): Record<string, unknown> {
  return {
    routeSegmentId: "seg-1",
    segmentNumber: 1,
    provider: "anthropic",
    model: "claude-opus-5",
    modelResolutionStatus: "RESOLVED",
    modelVersionId: "claude-opus-5-20260101",
    accountId,
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "policy-1",
  };
}

/** An execution event on the walk's own coordinate. */
function executionEvent(
  ledger: Ledger,
  invocation: DurableInvocation,
  transitionId: string,
  type: "EFFECT_INTENDED" | "DISPATCH_INTENDED",
  record: Record<string, unknown>,
): Record<string, unknown> {
  const revision = invocation.revision;
  if (revision === undefined) throw new Error("an execution event needs the walk's revision");
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  const state = ledger.getTask(invocation.taskId)?.currentState ?? null;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type,
    fromState: state,
    toState: state,
    emittedBy: EMITTED_BY,
    occurredAt: V2_AT,
    recordedAt: V2_AT,
    correlationId: invocation.invocationId,
    causationId: null,
    payload: { revisionNumber: revision.revisionNumber, attemptNumber: revision.attemptNumber, ...record },
  };
}

/** Intend the attempt's first effect on `seg-1`. */
function intendEffect(ledger: Ledger, invocation: DurableInvocation): string {
  const coordinate = { taskId: invocation.taskId, revisionNumber: 1, attemptNumber: 1, segmentNumber: 1, operationOrdinal: 0 };
  const envelopeSha256 = invocation.revision?.envelopeSha256 ?? "";
  ledger.append(
    executionEvent(ledger, invocation, "effect-1", "EFFECT_INTENDED", {
      segment: segmentRecord("acct-1"),
      effect: {
        effectId: effectIdV1(coordinate),
        operationOrdinal: 0,
        effectKind: "model_execution",
        semanticScopeKey: SCOPE,
        localOperationKey: STEP_KEY,
        logicalOperationSha256: logicalOperationSha256({
          invocationId: invocation.invocationId,
          semanticScopeKey: SCOPE,
          localOperationKey: STEP_KEY,
        }),
        requestContractVersion: "1",
        requestSha256: requestSha256({
          effectKind: "model_execution",
          requestContractVersion: "1",
          envelopeSha256,
          neutralRequest: NEUTRAL_REQUEST,
        }),
        idempotencyKey: effectIdempotencyKeyV1({ ...coordinate, effectKind: "model_execution", envelopeSha256 }),
      },
    }),
  );
  return effectIdV1(coordinate);
}

/** Deliver it: its first `DISPATCH_INTENDED`, which is its exposure (Q3). */
function deliverEffect(ledger: Ledger, invocation: DurableInvocation, effectId: string): void {
  ledger.append(
    executionEvent(ledger, invocation, "dispatch-1", "DISPATCH_INTENDED", {
      segment: segmentRecord("acct-1"),
      dispatch: { dispatchAttemptId: "dsp-1", effectId, attemptOrdinal: 1, ...FIXTURE_PIN },
    }),
  );
}

/**
 * A ledger holding one V2 attempt, opened and discovered by the walk itself, with
 * its first effect intended on `seg-1` and — unless told otherwise — delivered.
 */
function openV2Attempt(
  name: string,
  taskId: string,
  options: { readonly deliver: boolean } = { deliver: true },
): { readonly ledger: Ledger; readonly invocation: DurableInvocation; readonly effectId: string } {
  const root = scenario(name);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  plantEnvelopeReference(ledger, taskId);
  plantFixtureCatalog(ledger);
  const invocation = deriveInvocation(taskId, 1, V2_AT, "c".repeat(64), revisionFor(taskId));
  const context: BeatContext = {
    ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
    invocation,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    route: TEST_ROUTE,
    initiativeId: INITIATIVE_ID,
  };
  appendPlanStep(context, ATTEMPT_OPENING_STEP);
  appendPlanStep(context, planStep(0));
  const effectId = intendEffect(ledger, invocation);
  if (options.deliver) deliverEffect(ledger, invocation, effectId);
  return { ledger, invocation, effectId };
}

function declarationFor(invocation: DurableInvocation, overrides: Partial<UsageStreamDeclaration> = {}): UsageStreamDeclaration {
  return {
    invocation,
    source: USAGE_SOURCE,
    accountId: "acct-1",
    routeSegmentId: "seg-1",
    sourceEpoch: 0,
    sourceClass: "PROVIDER_AUTHORITATIVE",
    normalizationPolicySha256: USAGE_POLICY,
    emittedBy: EMITTED_BY,
    ...overrides,
  };
}

/** A DELTA over `[0, 100)` of 60 in and 40 out, unless told otherwise. */
function reportFor(
  invocation: DurableInvocation,
  measurementStreamId: string,
  effectId: string,
  overrides: Partial<UsageObservationReport> = {},
): UsageObservationReport {
  return {
    invocation,
    measurementStreamId,
    observationId: "obs-0",
    ordinal: 0,
    sourceObservationId: "src-0",
    reportKind: "DELTA",
    rangeFromCounter: 0,
    rangeToCounter: 100,
    correctsObservationId: null,
    effectId,
    isFinal: 0,
    inputTokens: 60,
    outputTokens: 40,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 100,
    occurredAt: REPORT_AT,
    emittedBy: EMITTED_BY,
    ...overrides,
  };
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  return null;
}

describe("P-32/captura C: a stream is declared before its reports, as the adapter normalized it", () => {
  it("declares a stream on the V2 coordinate, under the id the door recomputes, as a same-state passthrough", () => {
    const { ledger, invocation } = openV2Attempt("p32c-declare", "32c32c32-0000-4000-8000-000000000001");
    const before = ledger.getTask(invocation.taskId)?.currentState;
    const expectedId = measurementStreamIdV1({ source: USAGE_SOURCE, accountId: "acct-1", routeSegmentId: "seg-1", sourceEpoch: 0 });

    const result = recordUsageStreamDeclaration(ledger, declarationFor(invocation));

    expect(result.inserted).toBe(true);
    expect(result.measurementStreamId).toBe(expectedId);
    expect(result.event.type).toBe("USAGE_STREAM_DECLARED");
    // The durable name is the stream id and nothing else: no clock, no generation.
    expect(result.event.transitionId).toBe("usage-stream." + expectedId);
    expect(usageStreamTransitionId(expectedId)).toBe(result.event.transitionId);
    expect(result.event.transitionId.length).toBeLessThanOrEqual(120);
    const coordinate = deriveEventCoordinate(invocation, result.event.transitionId, 0);
    expect(result.event.idempotencyKey).toBe(coordinate.idempotencyKey);
    expect(result.event.eventId).toBe(coordinate.eventId);
    // The event's instants are the invocation's, never a clock's.
    expect(result.event.occurredAt).toBe(V2_AT);
    expect(result.event.recordedAt).toBe(V2_AT);
    expect(result.event.fromState).toBe(before);
    expect(result.event.toState).toBe(before);
    expect(result.event.correlationId).toBe(invocation.invocationId);
    expect(result.event.causationId).toBeNull();
    expect(result.event.payload).toEqual({
      revisionNumber: 1,
      attemptNumber: 1,
      usageStream: {
        measurementStreamId: expectedId,
        source: USAGE_SOURCE,
        accountId: "acct-1",
        routeSegmentId: "seg-1",
        sourceEpoch: 0,
        sourceClass: "PROVIDER_AUTHORITATIVE",
        normalizationPolicySha256: USAGE_POLICY,
      },
    });
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe(before);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("records a report of a delivered effect verbatim, under its stream and ordinal, with the adapter's instant in the record", () => {
    const { ledger, invocation, effectId } = openV2Attempt("p32c-observe", "32c32c32-0000-4000-8000-000000000002");
    const stream = recordUsageStreamDeclaration(ledger, declarationFor(invocation));

    const result = recordUsageObservation(
      ledger,
      reportFor(invocation, stream.measurementStreamId, effectId, { isFinal: 1, cacheReadTokens: 25, totalTokens: 125 }),
    );

    expect(result.inserted).toBe(true);
    expect(result.measurementStreamId).toBe(stream.measurementStreamId);
    expect(result.event.type).toBe("USAGE_OBSERVATION_RECORDED");
    expect(result.event.transitionId).toBe("usage-observation." + stream.measurementStreamId + ".0");
    expect(usageObservationTransitionId(stream.measurementStreamId, 0)).toBe(result.event.transitionId);
    expect(result.event.occurredAt).toBe(V2_AT);
    expect(result.event.payload).toEqual({
      revisionNumber: 1,
      attemptNumber: 1,
      usageObservation: {
        observationId: "obs-0",
        measurementStreamId: stream.measurementStreamId,
        ordinal: 0,
        sourceObservationId: "src-0",
        reportKind: "DELTA",
        rangeFromCounter: 0,
        rangeToCounter: 100,
        correctsObservationId: null,
        effectId,
        isFinal: 1,
        inputTokens: 60,
        outputTokens: 40,
        cacheWriteTokens: 0,
        cacheReadTokens: 25,
        totalTokens: 125,
        occurredAt: REPORT_AT,
      },
    });
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("an observation of a stream never declared is refused by the door, by name (STREAM_UNKNOWN)", () => {
    const { ledger, invocation, effectId } = openV2Attempt("p32c-undeclared", "32c32c32-0000-4000-8000-000000000003");
    const settled = ledger.status();
    const undeclared = measurementStreamIdV1({ source: USAGE_SOURCE, accountId: "acct-1", routeSegmentId: "seg-1", sourceEpoch: 0 });

    const error = caught(() => recordUsageObservation(ledger, reportFor(invocation, undeclared, effectId)));

    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as LedgerValidationError).message).toContain("STREAM_UNKNOWN");
    expect(ledger.status().eventCount).toBe(settled.eventCount);
    expect(ledger.status().headEventSha256).toBe(settled.headEventSha256);
  });

  it("N-P32C-1: the same declaration after a restart is an exact replay under the first event's id, and appends nothing", () => {
    const { ledger, invocation } = openV2Attempt("p32c-restate", "32c32c32-0000-4000-8000-000000000004");
    const first = recordUsageStreamDeclaration(ledger, declarationFor(invocation));
    const count = ledger.status().eventCount;

    const second = recordUsageStreamDeclaration(ledger, declarationFor(invocation));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(second.measurementStreamId).toBe(first.measurementStreamId);
    expect(ledger.status().eventCount).toBe(count);
    expect(ledger.listEvents({ type: "USAGE_STREAM_DECLARED" }).events).toHaveLength(1);
  });

  it("N-P32C-2: a restarted counter declares the lineage's epoch plus one — a new id and key, the old row untouched", () => {
    const { ledger, invocation } = openV2Attempt("p32c-restart", "32c32c32-0000-4000-8000-000000000005");
    const lineage = { source: USAGE_SOURCE, accountId: "acct-1", routeSegmentId: "seg-1" };

    // Nothing declared: the reader answers "none", never zero. The caller picks 0.
    const empty = readUsageStreamLineage(ledger, lineage);
    expect(empty).toEqual({ ok: true, latest: null });

    const generation0 = recordUsageStreamDeclaration(ledger, declarationFor(invocation, { sourceEpoch: 0 }));
    const recorded0 = ledger.getEventByIdempotencyKey(generation0.event.idempotencyKey)?.canonicalJson;

    // The adapter restarts and its counter resets: read the generation back, never reinvent it.
    const read = readUsageStreamLineage(ledger, lineage);
    expect(read.ok).toBe(true);
    if (!read.ok || read.latest === null) throw new Error("the lineage read found no declaration");
    expect(read.latest).toEqual({
      measurementStreamId: generation0.measurementStreamId,
      sourceEpoch: 0,
      sourceClass: "PROVIDER_AUTHORITATIVE",
      normalizationPolicySha256: USAGE_POLICY,
    });

    const generation1 = recordUsageStreamDeclaration(
      ledger,
      declarationFor(invocation, { sourceEpoch: read.latest.sourceEpoch + 1 }),
    );
    expect(generation1.inserted).toBe(true);
    expect(generation1.measurementStreamId).not.toBe(generation0.measurementStreamId);
    expect(generation1.event.idempotencyKey).not.toBe(generation0.event.idempotencyKey);
    expect(ledger.getEventByIdempotencyKey(generation0.event.idempotencyKey)?.canonicalJson).toBe(recorded0);

    const after = readUsageStreamLineage(ledger, lineage);
    expect(after.ok && after.latest?.sourceEpoch).toBe(1);
    expect(after.ok && after.latest?.measurementStreamId).toBe(generation1.measurementStreamId);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-P32C-4: the same inputs in two ledgers build the same event, byte for byte; another account on the segment is another stream", () => {
    const taskId = "32c32c32-0000-4000-8000-000000000006";
    const left = openV2Attempt("p32c-determinism-left", taskId);
    const right = openV2Attempt("p32c-determinism-right", taskId);

    const leftStream = recordUsageStreamDeclaration(left.ledger, declarationFor(left.invocation));
    const rightStream = recordUsageStreamDeclaration(right.ledger, declarationFor(right.invocation));
    const leftReport = recordUsageObservation(left.ledger, reportFor(left.invocation, leftStream.measurementStreamId, left.effectId));
    const rightReport = recordUsageObservation(
      right.ledger,
      reportFor(right.invocation, rightStream.measurementStreamId, right.effectId),
    );

    for (const [a, b] of [
      [leftStream, rightStream],
      [leftReport, rightReport],
    ] as const) {
      expect(a.event.eventId).toBe(b.event.eventId);
      expect(a.event.idempotencyKey).toBe(b.event.idempotencyKey);
      expect(a.event.transitionId).toBe(b.event.transitionId);
      expect(left.ledger.getEventByIdempotencyKey(a.event.idempotencyKey)?.canonicalJson).toBe(
        right.ledger.getEventByIdempotencyKey(b.event.idempotencyKey)?.canonicalJson,
      );
    }

    // The trap `usageTransitionId` needed a generation for is closed by the identity:
    // another account on the same segment is another stream under another name.
    const other = recordUsageStreamDeclaration(left.ledger, declarationFor(left.invocation, { accountId: "acct-2" }));
    expect(other.inserted).toBe(true);
    expect(other.measurementStreamId).not.toBe(leftStream.measurementStreamId);
    expect(other.event.idempotencyKey).not.toBe(leftStream.event.idempotencyKey);
  });

  it("N-P32C-5: an invocation without a revision is refused by name by both recorders, and nothing is appended", () => {
    const { ledger, invocation } = openWithTask("p32c-v1", "32c32c32-0000-4000-8000-000000000007");
    const count = ledger.status().eventCount;
    const streamId = measurementStreamIdV1({ source: USAGE_SOURCE, accountId: "acct-1", routeSegmentId: "seg-1", sourceEpoch: 0 });

    const declared = caught(() => recordUsageStreamDeclaration(ledger, declarationFor(invocation)));
    const observed = caught(() => recordUsageObservation(ledger, reportFor(invocation, streamId, "effect-x")));

    for (const error of [declared, observed]) {
      expect(error).toBeInstanceOf(SupervisorError);
      expect((error as Error).message).toContain("without a revision");
    }
    expect(ledger.status().eventCount).toBe(count);
  });

  it("H-3: the payload's coordinate is the revision's, never the flat attempt's", () => {
    const appended: unknown[] = [];
    const port: LedgerPort = {
      getTask: () => ({ currentState: "DISCOVERED", latestAttempt: 7, firstSequence: 1 }),
      append: (candidate) => {
        appended.push(candidate);
        return { inserted: true, record: { event: candidate as ControlPlaneEvent } };
      },
      getEventBySequence: () => null,
      getEventByIdempotencyKey: () => null,
    };
    const taskId = "32c32c32-0000-4000-8000-000000000008";
    const invocation: DurableInvocation = {
      ...deriveInvocation(taskId, 7, V2_AT, "c".repeat(64), { ...revisionFor(taskId), revisionNumber: 2, attemptNumber: 3 }),
    };

    const stream = recordUsageStreamDeclaration(port, declarationFor(invocation));
    const report = recordUsageObservation(port, reportFor(invocation, stream.measurementStreamId, "effect-x"));

    for (const result of [stream, report]) {
      expect(result.event.attempt).toBe(7);
      expect(result.event.payload["revisionNumber"]).toBe(2);
      expect(result.event.payload["attemptNumber"]).toBe(3);
    }
    expect(appended).toHaveLength(2);
  });

  it("N-P32C-6: a report of an effect intended but never delivered is refused by the door, by name", () => {
    const { ledger, invocation, effectId } = openV2Attempt(
      "p32c-unexposed",
      "32c32c32-0000-4000-8000-000000000009",
      { deliver: false },
    );
    const stream = recordUsageStreamDeclaration(ledger, declarationFor(invocation));
    const count = ledger.status().eventCount;

    const error = caught(() => recordUsageObservation(ledger, reportFor(invocation, stream.measurementStreamId, effectId)));

    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as LedgerValidationError).message).toContain("has not been exposed");
    expect(ledger.status().eventCount).toBe(count);
  });

  it("N-P32C-7: neither recorder opens a task", () => {
    const root = scenario("p32c-unknown-task");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);
    const taskId = "32c32c32-0000-4000-8000-00000000000a";
    const invocation = deriveInvocation(taskId, 1, V2_AT, "c".repeat(64), revisionFor(taskId));
    const streamId = measurementStreamIdV1({ source: USAGE_SOURCE, accountId: "acct-1", routeSegmentId: "seg-1", sourceEpoch: 0 });

    const declared = caught(() => recordUsageStreamDeclaration(ledger, declarationFor(invocation)));
    const observed = caught(() => recordUsageObservation(ledger, reportFor(invocation, streamId, "effect-x")));

    for (const error of [declared, observed]) {
      expect(error).toBeInstanceOf(SupervisorError);
      expect((error as Error).message).toContain("never seen");
    }
    expect(ledger.status().eventCount).toBe(0);
  });

  it("N-P32C-8: the new recorders emit no TOKEN_USAGE_RECORDED, so the legacy account reader sees nothing", () => {
    const { ledger, invocation, effectId } = openV2Attempt("p32c-legacy-quiet", "32c32c32-0000-4000-8000-00000000000b");
    const stream = recordUsageStreamDeclaration(ledger, declarationFor(invocation));
    recordUsageObservation(ledger, reportFor(invocation, stream.measurementStreamId, effectId));

    expect(ledger.listEvents({ type: "TOKEN_USAGE_RECORDED" }).events).toEqual([]);
    expect(readAccountUsage(ledger, "acct-1", { since: "2026-01-01T00:00:00Z" })).toEqual({ ok: true, observations: [] });
  });

  it("N-P32C-10: a restated report replays; its key with other bytes fails closed at the ledger; its id with other bytes at the door", () => {
    const { ledger, invocation, effectId } = openV2Attempt("p32c-report-identity", "32c32c32-0000-4000-8000-00000000000c");
    const stream = recordUsageStreamDeclaration(ledger, declarationFor(invocation));
    const report = reportFor(invocation, stream.measurementStreamId, effectId);
    const first = recordUsageObservation(ledger, report);
    const count = ledger.status().eventCount;

    // The same report restated: an exact replay under the same key.
    const replay = recordUsageObservation(ledger, report);
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.event.eventId).toBe(first.event.eventId);

    // The same stream and ordinal with other bytes: the key is the ordinal's, so
    // the ledger's idempotency guard refuses before the door is asked.
    expect(() =>
      recordUsageObservation(ledger, { ...report, outputTokens: 41, totalTokens: 101 }),
    ).toThrow(LedgerIdempotencyConflictError);

    // The same observation id at another ordinal: another key, so the door sees
    // it, and the same identity with other bytes is a conflict, never a replay.
    const conflict = caught(() =>
      recordUsageObservation(ledger, { ...report, ordinal: 1, sourceObservationId: "src-1", rangeFromCounter: 100, rangeToCounter: 200 }),
    );
    expect(conflict).toBeInstanceOf(LedgerValidationError);
    expect((conflict as LedgerValidationError).message).toContain("already recorded with different content");

    expect(ledger.status().eventCount).toBe(count);
  });

  it("H-7: the recorder refuses an unregistered class or kind; what the door can see — a total that is not the sum — is the door's", () => {
    const { ledger, invocation, effectId } = openV2Attempt("p32c-refusals", "32c32c32-0000-4000-8000-00000000000d");
    const stream = recordUsageStreamDeclaration(ledger, declarationFor(invocation));
    const count = ledger.status().eventCount;

    const unregistered = caught(() =>
      recordUsageStreamDeclaration(ledger, declarationFor(invocation, { sourceClass: "GUESSED" as never, sourceEpoch: 9 })),
    );
    expect(unregistered).toBeInstanceOf(SupervisorError);
    expect((unregistered as Error).message).toContain("source class");

    const unknownKind = caught(() =>
      recordUsageObservation(ledger, reportFor(invocation, stream.measurementStreamId, effectId, { reportKind: "ESTIMATED" as never })),
    );
    expect(unknownKind).toBeInstanceOf(SupervisorError);
    expect((unknownKind as Error).message).toContain("report kind");

    // Verbatim: the recorder does not recompute the total, and the door refuses it by name.
    const mismatch = caught(() =>
      recordUsageObservation(ledger, reportFor(invocation, stream.measurementStreamId, effectId, { totalTokens: 99 })),
    );
    expect(mismatch).toBeInstanceOf(LedgerValidationError);
    expect((mismatch as LedgerValidationError).message).toContain("TOTAL_MISMATCH");

    expect(ledger.status().eventCount).toBe(count);
  });
});

/**
 * N-P32C-3: the lineage reader, exhaustive or a refusal.
 *
 * Driven through `UsageEventSource`, as `readAccountUsage`'s pager is: the
 * truncation cases need a `hasMore` and a cursor a fake controls exactly.
 */
describe("N-P32C-3: reading a lineage's generation back, exhaustively", () => {
  const LINEAGE = { source: USAGE_SOURCE, accountId: "acct-1", routeSegmentId: "seg-1" };

  function declared(epoch: number, overrides: Record<string, unknown> = {}): { readonly event: never } {
    const coordinate = { ...LINEAGE, sourceEpoch: epoch };
    return {
      event: {
        type: "USAGE_STREAM_DECLARED",
        payload: {
          revisionNumber: 1,
          attemptNumber: 1,
          usageStream: {
            measurementStreamId: measurementStreamIdV1(coordinate),
            ...coordinate,
            sourceClass: "WRAPPER_MEASURED",
            normalizationPolicySha256: USAGE_POLICY,
            ...overrides,
          },
        },
      } as never,
    };
  }

  function pages(
    list: readonly { readonly events: readonly { readonly event: never }[]; readonly nextCursor: number | null; readonly hasMore: boolean }[],
  ): { readonly source: UsageEventSource; readonly queries: unknown[] } {
    const queries: unknown[] = [];
    let index = 0;
    return {
      source: {
        listEvents: (query) => {
          queries.push(query);
          const page = list[index] ?? { events: [], nextCursor: null, hasMore: false };
          index += 1;
          return page;
        },
      },
      queries,
    };
  }

  it("finds the latest epoch past the first page, and ignores another lineage's", () => {
    const { source, queries } = pages([
      { events: [declared(0), declared(5, { accountId: "acct-2" })], nextCursor: 2, hasMore: true },
      { events: [declared(2), declared(1)], nextCursor: null, hasMore: false },
    ]);
    const outcome = readUsageStreamLineage(source, LINEAGE);
    expect(outcome).toEqual({
      ok: true,
      latest: {
        measurementStreamId: measurementStreamIdV1({ ...LINEAGE, sourceEpoch: 2 }),
        sourceEpoch: 2,
        sourceClass: "WRAPPER_MEASURED",
        normalizationPolicySha256: USAGE_POLICY,
      },
    });
    expect(queries).toEqual([
      { type: "USAGE_STREAM_DECLARED", afterSequence: 0, limit: 1_000 },
      { type: "USAGE_STREAM_DECLARED", afterSequence: 2, limit: 1_000 },
    ]);
  });

  it("refuses a page that claims more without a cursor past the last, rather than answering none", () => {
    const withoutCursor = pages([{ events: [], nextCursor: null, hasMore: true }]);
    expect(readUsageStreamLineage(withoutCursor.source, LINEAGE)).toEqual({
      ok: false,
      reason: "LINEAGE_SCAN_INCOMPLETE",
      at: "pages[0].nextCursor",
    });

    const stalled = pages([
      { events: [], nextCursor: 3, hasMore: true },
      { events: [], nextCursor: 3, hasMore: true },
    ]);
    expect(readUsageStreamLineage(stalled.source, LINEAGE)).toEqual({
      ok: false,
      reason: "LINEAGE_SCAN_INCOMPLETE",
      at: "pages[1].nextCursor",
    });
  });

  it("refuses a declaration it cannot read rather than skipping it, which could hide the latest epoch", () => {
    const { source } = pages([
      { events: [declared(0), declared(1, { sourceEpoch: "1" })], nextCursor: null, hasMore: false },
    ]);
    expect(readUsageStreamLineage(source, LINEAGE)).toEqual({
      ok: false,
      reason: "LINEAGE_DECLARATION_UNREADABLE",
      at: "pages[0].events[1].payload.usageStream",
    });
  });

  it("propagates a page read that throws, and refuses an empty lineage coordinate", () => {
    let calls = 0;
    const source: UsageEventSource = {
      listEvents: () => {
        calls += 1;
        if (calls === 1) return { events: [declared(0)], nextCursor: 1, hasMore: true };
        throw new Error("the ledger went away mid-scan");
      },
    };
    expect(() => readUsageStreamLineage(source, LINEAGE)).toThrow("the ledger went away mid-scan");
    expect(() => readUsageStreamLineage(source, { ...LINEAGE, routeSegmentId: "" })).toThrow(SupervisorError);
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón B: legacy usage is not adopted under V2 (adjudication v2 C1)
// ---------------------------------------------------------------------------

describe("P-15/B N-B-9: no TOKEN_USAGE_RECORDED under V2 (C1, ADR 0102)", () => {
  it("refuses a legacy token observation for a revision-bearing walk at the contract, with zero delta", () => {
    // B adopted six exceptional producers and deliberately not this one: under V2
    // spend is recorded only as USAGE_STREAM_DECLARED / USAGE_OBSERVATION_RECORDED,
    // which D wires. So the legacy row keeps failing closed exactly as ADR 0080
    // left it, and quota and rollups see no V2 spend until P-19.
    const { ledger, invocation } = openV2Attempt("p15b-legacy-usage", "c1c1c1c1-0000-4000-8000-0000000000b1");
    const status = ledger.status();
    expect(() =>
      recordTokenObservation(ledger, {
        invocation,
        kind: "USAGE",
        accountId: "acct-primary",
        tokens: 1_200,
        transitionId: "usage.step-1",
        emittedBy: EMITTED_BY,
      }),
    ).toThrow("idempotencyKey must be exactly taskId/attempt/transitionId");
    expect(ledger.status().eventCount).toBe(status.eventCount);
    expect(ledger.status().headEventSha256).toBe(status.headEventSha256);
    expect(
      ledger.listEvents({ taskId: invocation.taskId, limit: 500 }).events.filter((record) => record.event.type === "TOKEN_USAGE_RECORDED"),
    ).toEqual([]);
  });
});
