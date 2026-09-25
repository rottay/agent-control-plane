import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ARTIFACT_EVENT_KINDS,
  ArtifactRegistryEvent,
  CONTRACT_VERSION,
  EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1,
  EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1,
  INITIATIVE_EVENT_TYPES,
  OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1,
  TASK_GRAPH_NODES_MAX,
  buildIdempotencyKey,
  buildV2IdempotencyKey,
} from "@acp/contracts";
import type { ControlPlaneEvent, InitiativeEvent } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import { LedgerRoadmapVersionRefusedError, LedgerTaskGraphRefusedError, LedgerTaskStepLinkRefusedError } from "../../src/errors/index.js";

import {
  applyArtifactEventToSnapshot,
  artifactBlobKey,
  artifactEventKindRefusal,
  artifactEventRefusal,
  artifactSnapshotView,
  artifactSubjectOf,
  createArtifactProjectionSnapshot,
  nextArtifactProjection,
  applyEventToSnapshot,
  canonicalAttempt,
  canonicalRevision,
  ENVELOPE_ARTIFACT_REFERENCE_KEY,
  PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS,
  sameRevisionRecord,
  createProjectionSnapshot,
  dispatchOutcomeRecord,
  dispatchTransitionAdmitted,
  effectOutcomeArrival,
  PRE_RESULT_REFERENCE_CONTRACT_VERSIONS,
  effectIdPreimageV1,
  effectIdV1,
  effectIdempotencyKeyV1,
  effectIdempotencyPreimageV1,
  logicalOperationSha256,
  nextDispatchAttemptProjection,
  dispatchPinReading,
  canonicalDispatchBirth,
  PRE_CATALOG_PIN_CONTRACT_VERSIONS,
  nextEffectProjection,
  nextExecutionRouteSegmentProjection,
  segmentTransportRefusal,
  requestSha256,
  nextExecutionRouteProjection,
  initiativeRegistrationPayloadOf,
  nextInitiativeProjection,
  applyInitiativeEventToSnapshot,
  assertTaskGraphsComplete,
  createTaskGraphFold,
  foldTaskGraph,
  taskGraphKey,
  createTaskStepLinkFold,
  foldTaskStepLink,
  roadmapStepKey,
  assertRoadmapVersionUnfolded,
  createInitiativeProjectionSnapshot,
  nextRoadmapVersionProjection,
  nextRoutingAssignmentFromInitiative,
  nextRoutingAssignmentProjection,
  GLOBAL_ASSIGNMENT_REFUSALS,
  applyModelVersionToSnapshot,
  applyRegistryModelVersionToSnapshot,
  createModelVersionProjectionSnapshot,
  globalAssignmentIssues,
  modelVersionPayloadIssues,
  nextModelVersionProjection,
  type ModelVersionEligibility,
  applyRegistryPriceIntervalToSnapshot,
  createPriceIntervalProjectionSnapshot,
  nextPriceIntervalProjection,
  priceIntervalKey,
  priceTableIssues,
  priceTablePayloadIssues,
  nextTaskAttemptProjection,
  nextTaskProjection,
  nextTaskRevisionProjection,
  PROMPT_OCCURRENCE_RECORD_KEYS,
  RESPONSE_OCCURRENCE_RECORD_KEYS,
  canonicalPromptOccurrence,
  nextPromptOccurrenceProjection,
  nextResponseOccurrenceProjection,
  readPromptOccurrence,
  readResponseOccurrence,
  routingAssignmentId,
  taskAttemptKey,
  taskRevisionKey,
  assertSameTaskSubmission,
  nextTaskSubmissionProjection,
  taskIntakePayloadOf,
  OUTBOX_V1_COMMAND_STREAMS,
  applyEventToOutboxFold,
  computeOutboxCommandId,
  createOutboxFold,
  foldOutboxCommands,
  isQuarantineEvent,
  outboxCommandIdPreimageV1,
  readOutboxEvent,
  type OutboxEventEntry,
  USAGE_OBSERVATION_RECORD_KEYS,
  USAGE_STREAM_RECORD_KEYS,
  nextUsageCapture,
  readUsageObservation,
  readUsageStreamDeclaration,
  usageRowText,
  usageSnapshotView,
} from "../../src/projection/index.js";
import { measurementStreamIdV1 } from "../../src/usage-settlement/index.js";
import {
  LedgerArtifactEncryptionConflictError,
  LedgerIdempotencyConflictError,
  LedgerValidationError,
} from "../../src/errors/index.js";
import {
  ARTIFACT_ACCESS_POLICY_IDS,
  DELIVERED_ARTIFACT_EVENT_KINDS,
  DISPATCH_STATES,
  INITIATIVE_REGISTRATION_PAYLOAD_KEYS,
  PRICE_TABLE_REFUSALS,
  TASK_INTAKE_PAYLOAD_KEYS,
  TASK_INTAKE_TRANSITION_ID,
} from "../../src/types/index.js";
import type {
  PriceTableModelVersion,
  RegistryDocument,
  TaskGraphNodeReadModel,
  TaskGraphRevisionReadModel,
  TaskReadModel,
} from "../../src/types/index.js";
import { forAll, intBetween, pick } from "../canonical-json/helpers/index.js";

/**
 * The task projection fold, asserted directly (P8-T G9, the structural residual).
 *
 * `nextTaskProjection` is a pure fold: one row plus one event yields the next
 * row, and the same sequence of events must produce the same row whether it
 * arrives live or during a replay. That equivalence is what makes a rebuilt
 * read model byte-comparable with the incremental one, and it was previously
 * exercised only incidentally — through the ledger's own append and rebuild
 * paths, which would report a fold defect as a mismatch several layers away.
 *
 * The invariants below are the fold's own, and every one of them is a
 * *monotonicity or carry* rule that a single hand-written example cannot
 * pressure: attribution is written once and carried, the attempt never
 * decreases, `firstSequence` and `createdAt` are fixed at creation, and the
 * event count is exactly the number of events folded.
 */

const ITERATIONS = 150;

/**
 * The chain digest a snapshot fold is handed for an event (P-32/captura B, H-4).
 *
 * Only the usage settlement reads it, as its trigger's head; every fold asserted
 * in this file before B ignores it, so one lowercase hex value stands in for
 * each event's own.
 */
const EVENT_SHA256 = "e".repeat(64);

const TASK_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const INITIATIVE_A = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b01";
const EMITTED_BY = "kimi/k3/coordinator/01";

const STATES = ["DISCOVERED", "CLASSIFIED", "READY", "CLAIMED", "EXECUTING", "AUDITING"] as const;
const TYPES = ["TASK_DISCOVERED", "TASK_CLASSIFIED", "TASK_READY", "ATOMIC_STEP_COMPLETED"] as const;

/** One well-formed event; the generated dimensions are the fold's inputs. */
function makeEvent(
  random: () => number,
  index: number,
  options: { readonly withInitiative: boolean },
): ControlPlaneEvent {
  const type = index === 0 ? "TASK_DISCOVERED" : pick(random, TYPES);
  const attempt = intBetween(random, 1, 4);
  const transitionId = "step-" + String(index);
  const occurredAt = new Date(Date.UTC(2026, 7, 27, 12, 0, index)).toISOString();
  const payload =
    type === "TASK_DISCOVERED" && options.withInitiative ? { initiativeId: INITIATIVE_A } : {};
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: "0000" + String(index).padStart(4, "0") + "-0000-4000-8000-000000000000",
    taskId: TASK_ID,
    attempt,
    transitionId,
    idempotencyKey: buildIdempotencyKey({ taskId: TASK_ID, attempt, transitionId }),
    type,
    fromState: null,
    toState: pick(random, STATES),
    emittedBy: EMITTED_BY,
    occurredAt,
    recordedAt: occurredAt,
    correlationId: null,
    causationId: null,
    payload,
  } as ControlPlaneEvent;
}

/** Fold a whole sequence, exactly as both the live and replay paths do. */
function foldAll(events: readonly ControlPlaneEvent[]): TaskReadModel | null {
  let row: TaskReadModel | null = null;
  events.forEach((event, index) => {
    row = nextTaskProjection(row, event, index + 1);
  });
  return row;
}

describe("the task projection fold carries what it must and never goes backwards (G9)", () => {
  it("counts exactly the events it folded and fixes the creation facts", () => {
    forAll("count and creation facts", 0xf01d_0001, ITERATIONS, (random) => {
      const count = intBetween(random, 1, 12);
      return Array.from({ length: count }, (_, i) => makeEvent(random, i, { withInitiative: false }));
    }, (events) => {
      const row = foldAll(events);
      expect(row).not.toBeNull();
      if (row === null) return;
      expect(row.eventCount).toBe(events.length);
      expect(row.firstSequence).toBe(1);
      expect(row.createdAt).toBe(events[0]?.occurredAt);
      // The last event always wins the mutable facts.
      expect(row.lastSequence).toBe(events.length);
      expect(row.currentState).toBe(events[events.length - 1]?.toState);
    });
  });

  it("never lowers the attempt, whatever order the attempts arrive in", () => {
    // The invariant a late event from an older attempt would break: the row
    // would claim the task went backwards. `Math.max` is the implementation;
    // "never decreases" is the contract, and this asserts the contract.
    forAll("attempt is monotone", 0xf01d_0002, ITERATIONS, (random) => {
      const count = intBetween(random, 2, 12);
      return Array.from({ length: count }, (_, i) => makeEvent(random, i, { withInitiative: false }));
    }, (events) => {
      let row: TaskReadModel | null = null;
      let highest = 0;
      events.forEach((event, index) => {
        row = nextTaskProjection(row, event, index + 1);
        highest = Math.max(highest, event.attempt);
        expect(row.latestAttempt).toBe(highest);
      });
    });
  });

  it("writes the initiative attribution once and then carries it", () => {
    // Attribution comes only from TASK_DISCOVERED. Later events may supply it
    // if the row was created some other way, but may never change one that is
    // already set — the `??` in the fold is that rule, and this is its test.
    forAll("attribution is write-once", 0xf01d_0003, ITERATIONS, (random) => {
      const count = intBetween(random, 2, 10);
      return Array.from({ length: count }, (_, i) => makeEvent(random, i, { withInitiative: true }));
    }, (events) => {
      let row: TaskReadModel | null = null;
      events.forEach((event, index) => {
        row = nextTaskProjection(row, event, index + 1);
        // Set by the first (discovering) event and never disturbed after.
        expect(row.initiativeId).toBe(INITIATIVE_A);
      });
    });
  });

  it("folds to null attribution when no discovering event carries one", () => {
    forAll("no attribution stays null", 0xf01d_0004, ITERATIONS, (random) => {
      const count = intBetween(random, 1, 10);
      return Array.from({ length: count }, (_, i) => makeEvent(random, i, { withInitiative: false }));
    }, (events) => {
      expect(foldAll(events)?.initiativeId).toBeNull();
    });
  });

  it("is a pure fold: replaying the same events yields an identical row", () => {
    // The equivalence a rebuild depends on. Two independent folds over the same
    // sequence must be indistinguishable, or an incremental read model and a
    // replayed one could disagree while both looked healthy.
    forAll("replay equivalence", 0xf01d_0005, ITERATIONS, (random) => {
      const count = intBetween(random, 1, 12);
      return Array.from({ length: count }, (_, i) => makeEvent(random, i, { withInitiative: true }));
    }, (events) => {
      expect(foldAll(events)).toEqual(foldAll(events));
      // And folding a prefix then the remainder equals folding the whole.
      const split = Math.floor(events.length / 2);
      let row: TaskReadModel | null = null;
      events.slice(0, split).forEach((event, index) => {
        row = nextTaskProjection(row, event, index + 1);
      });
      events.slice(split).forEach((event, index) => {
        row = nextTaskProjection(row, event, split + index + 1);
      });
      expect(row).toEqual(foldAll(events));
    });
  });
});


/**
 * The recorded-route fold (V2-B1c).
 *
 * The asymmetry this exercises is the one a later reader gets wrong. A route
 * that does not satisfy the contract must project NO ROW while the event it
 * rode on still stands: an append-only log does not get to disown an event it
 * accepted, and replay has to remain total. So every negative below asserts
 * two things at once — no row, and the task fold still advancing over exactly
 * the same event.
 */
describe("the recorded route fold", () => {
  const ROUTE = {
    provider: "claude",
    model: "opus",
    accountId: "acct-fold",
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "policy-fold-1",
    resolvedAt: "2026-08-27T12:00:00.000Z",
  };

  /** One RUN_STARTED whose payload is whatever the case is about. */
  function runStarted(payload: Record<string, unknown>, attempt = 1): ControlPlaneEvent {
    const transitionId = "run.started";
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "0000ffff-0000-4000-8000-00000000000" + String(attempt),
      taskId: TASK_ID,
      attempt,
      transitionId,
      idempotencyKey: buildIdempotencyKey({ taskId: TASK_ID, attempt, transitionId }),
      type: "RUN_STARTED",
      fromState: "RESERVED",
      toState: "RUNNING",
      emittedBy: EMITTED_BY,
      occurredAt: "2026-08-27T12:00:05.000Z",
      recordedAt: "2026-08-27T12:00:06.000Z",
      correlationId: null,
      causationId: null,
      payload,
    };
  }

  it("projects the route a RUN_STARTED carries, keyed by the event's own coordinates", () => {
    const row = nextExecutionRouteProjection(runStarted({ route: ROUTE }), 7);
    expect(row).toEqual({
      taskId: TASK_ID,
      attempt: 1,
      ...ROUTE,
      recordedAt: "2026-08-27T12:00:06.000Z",
      sequence: 7,
    });
  });

  it("takes identity from the event and never from the payload", () => {
    // A payload claiming another task's coordinates cannot move the row: the
    // key is the event's. This is the structural half of the binding.
    const row = nextExecutionRouteProjection(
      runStarted({ route: { ...ROUTE }, taskId: "not-this-task", attempt: 99 }),
      3,
    );
    expect({ taskId: row?.taskId, attempt: row?.attempt }).toEqual({ taskId: TASK_ID, attempt: 1 });
  });

  it("keeps each attempt's route rather than overwriting the earlier one", () => {
    // The reason the row is keyed by (taskId, attempt). A retry that resolved
    // a different account must not erase what the first attempt ran on.
    const first = nextExecutionRouteProjection(runStarted({ route: ROUTE }, 1), 4);
    const retry = nextExecutionRouteProjection(
      runStarted({ route: { ...ROUTE, accountId: "acct-after-quota" } }, 2),
      9,
    );
    expect({ a: first?.accountId, b: retry?.accountId }).toEqual({
      a: "acct-fold",
      b: "acct-after-quota",
    });
    expect({ a: first?.attempt, b: retry?.attempt }).toEqual({ a: 1, b: 2 });
  });

  it("projects no row for an event that is not a RUN_STARTED", () => {
    const other = { ...runStarted({ route: ROUTE }), type: "TASK_READY" as const };
    expect(nextExecutionRouteProjection(other, 2)).toBeNull();
  });

  it("projects no row, without disowning the event, for every malformed route", () => {
    const malformed: readonly [string, Record<string, unknown>][] = [
      ["absent", {}],
      ["null", { route: null }],
      ["a string", { route: "claude/opus" }],
      ["missing the policy version", { route: { ...ROUTE, capabilityPolicyVersion: undefined } }],
      ["an unknown transport", { route: { ...ROUTE, transportKind: "CARRIER_PIGEON" } }],
      ["a CLI route naming a non-CLI provider", { route: { ...ROUTE, provider: "acme" } }],
      ["an instant with no offset", { route: { ...ROUTE, resolvedAt: "2026-08-27T12:00:00" } }],
      ["a key the contract does not admit", { route: { ...ROUTE, extra: "no" } }],
    ];
    for (const [label, payload] of malformed) {
      const event = runStarted(payload);
      expect({ label, row: nextExecutionRouteProjection(event, 5) }).toEqual({ label, row: null });
      // The event still stands, and the task fold still advances over it.
      const task = nextTaskProjection(null, event, 5);
      expect({ label, count: task.eventCount, state: task.currentState }).toEqual({
        label,
        count: 1,
        state: "RUNNING",
      });
    }
  });

  it("is a pure fold: the same event yields an identical row every time", () => {
    const event = runStarted({ route: ROUTE });
    expect(nextExecutionRouteProjection(event, 11)).toEqual(nextExecutionRouteProjection(event, 11));
  });
});

/**
 * The routing-assignment fold, on both of its sources (P-09/log-C).
 *
 * `routing_assignment_read_model` is the first projection fed by two streams:
 * its `GLOBAL` partition from `registry_events`, its `INITIATIVE`/`STEP`
 * partition from `initiative_events`. Both folds are asserted here, and the
 * second one is asserted *empty* rather than left unwritten — the event type
 * that would fill it does not exist in the initiative contract's closed
 * vocabulary, so the partition is empty by construction, and a test per
 * existing type is what makes that a recorded fact instead of an oversight.
 *
 * The same asymmetry the recorded-route fold has applies here: a document whose
 * payload does not carry a readable assignment projects NO ROW while the event
 * still stands. The fold validates no eligibility of its own — it is storage,
 * not the owner of the semantics.
 */
describe("the routing assignment fold", () => {
  const DOCUMENT_ID = "routing:GLOBAL:implementer:0";
  const MODEL_ONE = "claude-opus-5@2026-06-01";
  const MODEL_TWO = "claude-sonnet-5@2026-06-01";
  const AT = "2026-09-03T12:00:00.000Z";

  function document(overrides: Record<string, unknown> = {}): RegistryDocument {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "0000aaaa-0000-4000-8000-000000000001",
      idempotencyKey: DOCUMENT_ID + "/1",
      documentKind: "ROUTING_ASSIGNMENT_GLOBAL",
      documentId: DOCUMENT_ID,
      documentVersion: 1,
      parentDocumentVersion: null,
      contentDigest: "1".repeat(64),
      recordedBy: EMITTED_BY,
      effectiveFrom: AT,
      occurredAt: AT,
      recordedAt: AT,
      payload: {
        role: "implementer",
        slot: 0,
        provider: "claude",
        modelVersionId: MODEL_ONE,
        fallbacks: [MODEL_TWO],
      },
      ...overrides,
    } as RegistryDocument;
  }

  it("projects a GLOBAL assignment with its fallbacks in ordinal order", () => {
    const projected = nextRoutingAssignmentProjection(document(), 4);
    expect(projected?.assignment).toEqual({
      assignmentId: routingAssignmentId(DOCUMENT_ID, 1),
      scopeKind: "GLOBAL",
      scopeId: null,
      version: 1,
      role: "implementer",
      slot: 0,
      provider: "claude",
      modelVersionId: MODEL_ONE,
      recordedBy: EMITTED_BY,
      recordedAt: AT,
      supersededBy: null,
      sourceStream: "registry_events",
      sourceSequence: 4,
      sequence: 4,
    });
    expect(projected?.fallbacks).toEqual([
      { assignmentId: routingAssignmentId(DOCUMENT_ID, 1), ordinal: 0, modelVersionId: MODEL_TWO },
    ]);
    expect(projected?.supersedes).toBeNull();
  });

  it("names the version it supersedes from the document's own parent", () => {
    const projected = nextRoutingAssignmentProjection(
      document({ documentVersion: 2, parentDocumentVersion: 1 }),
      9,
    );
    expect(projected?.supersedes).toBe(routingAssignmentId(DOCUMENT_ID, 1));
    expect(projected?.assignment.version).toBe(2);
    expect(projected?.assignment.supersededBy).toBeNull();
  });

  it("takes identity from the document and never from the payload", () => {
    const projected = nextRoutingAssignmentProjection(
      document({
        payload: {
          role: "implementer",
          slot: 0,
          provider: "claude",
          modelVersionId: MODEL_ONE,
          assignmentId: "claimed-by-the-payload",
          version: 99,
        },
      }),
      2,
    );
    expect(projected?.assignment.assignmentId).toBe(routingAssignmentId(DOCUMENT_ID, 1));
    expect(projected?.assignment.version).toBe(1);
  });

  it("projects no row for a document of another kind", () => {
    expect(nextRoutingAssignmentProjection(document({ documentKind: "MODEL_VERSION" }), 3)).toBeNull();
    expect(nextRoutingAssignmentProjection(document({ documentKind: "PRICE_TABLE" }), 3)).toBeNull();
  });

  it("projects no row, without disowning the document, for every unreadable payload", () => {
    const malformed: readonly [string, unknown][] = [
      ["empty", {}],
      ["no role", { slot: 0, provider: "claude", modelVersionId: MODEL_ONE }],
      ["a role outside the closed set", { role: "wizard", slot: 0, provider: "claude", modelVersionId: MODEL_ONE }],
      ["a negative slot", { role: "implementer", slot: -1, provider: "claude", modelVersionId: MODEL_ONE }],
      ["a fractional slot", { role: "implementer", slot: 1.5, provider: "claude", modelVersionId: MODEL_ONE }],
      ["no model version", { role: "implementer", slot: 0, provider: "claude" }],
      ["an empty model version", { role: "implementer", slot: 0, provider: "claude", modelVersionId: "" }],
      ["fallbacks that are not strings", { role: "implementer", slot: 0, provider: "claude", modelVersionId: MODEL_ONE, fallbacks: [1] }],
      ["a payload that is not an object", "routing"],
    ];
    for (const [label, payload] of malformed) {
      expect({ label, row: nextRoutingAssignmentProjection(document({ payload }), 5) }).toEqual({
        label,
        row: null,
      });
    }
  });

  it("is a pure fold: the same document yields an identical projection every time", () => {
    const one = document();
    expect(nextRoutingAssignmentProjection(one, 11)).toEqual(
      nextRoutingAssignmentProjection(one, 11),
    );
  });

  it("folds every existing initiative event type to no row at all", () => {
    // The INITIATIVE/STEP partition is empty by construction, not by omission.
    // `ROUTING_ASSIGNMENT_RECORDED` is not in `INITIATIVE_EVENT_TYPES`, and
    // widening a contract in another package is not this packet's; the fold is
    // total over the vocabulary that exists, and returns null for all of it.
    for (const type of INITIATIVE_EVENT_TYPES) {
      const event = {
        contractVersion: CONTRACT_VERSION,
        eventId: "0000bbbb-0000-4000-8000-000000000001",
        initiativeId: "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b01",
        transitionId: "t",
        idempotencyKey: "k",
        type,
        fromStatus: null,
        toStatus: "ACTIVE",
        emittedBy: EMITTED_BY,
        occurredAt: AT,
        recordedAt: AT,
        payload: {},
      } as unknown as InitiativeEvent;
      expect({ type, row: nextRoutingAssignmentFromInitiative(event, 1) }).toEqual({
        type,
        row: null,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The model version registry and the GLOBAL assignment gate (P-14 A)
// ---------------------------------------------------------------------------

/**
 * `modelVersionPayloadIssues`, `nextModelVersionProjection` and
 * `globalAssignmentIssues`, asserted directly (ADR 0085).
 *
 * The payload is fixed by name and the door holds it; the fold is total over
 * history and never refuses; the gate is a pure decision over an injected lookup,
 * so every reason can be driven without a database.
 */
describe("the model version fold and the GLOBAL assignment gate", () => {
  const MODEL_ONE = "claude-opus-5@2026-06-01";
  const MODEL_TWO = "claude-sonnet-5@2026-06-01";
  const AT = "2026-09-13T12:00:00.000Z";

  function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      provider: "claude",
      model: "claude-opus-5",
      release: "2026-06-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["implementer", "reviewer"],
      transports: ["CLI_SUBSCRIPTION", "API_KEY"],
      ...overrides,
    };
  }

  function modelVersion(overrides: Record<string, unknown> = {}): RegistryDocument {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "0000cccc-0000-4000-8000-000000000001",
      idempotencyKey: MODEL_ONE + "/1",
      documentKind: "MODEL_VERSION",
      documentId: MODEL_ONE,
      documentVersion: 1,
      parentDocumentVersion: null,
      contentDigest: "1".repeat(64),
      recordedBy: EMITTED_BY,
      effectiveFrom: AT,
      occurredAt: AT,
      recordedAt: AT,
      payload: payload(),
      ...overrides,
    } as RegistryDocument;
  }

  function assignment(fields: Record<string, unknown> = {}): RegistryDocument {
    return {
      ...modelVersion(),
      documentKind: "ROUTING_ASSIGNMENT_GLOBAL",
      documentId: "routing:GLOBAL:implementer:0",
      payload: { role: "implementer", slot: 0, provider: "claude", modelVersionId: MODEL_ONE, fallbacks: [MODEL_TWO], ...fields },
    } as RegistryDocument;
  }

  function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
  }

  function registry(entries: Record<string, ModelVersionEligibility>): (id: string) => ModelVersionEligibility | null {
    return (id) => entries[id] ?? null;
  }

  const ACTIVE_BOTH: ModelVersionEligibility = { status: "ACTIVE", eligibleRoles: ["implementer", "reviewer"] };

  it("admits the fixed payload, and names every way out of it by path without echoing a value", () => {
    expect(modelVersionPayloadIssues(payload())).toEqual([]);
    expect(modelVersionPayloadIssues(payload({ status: "RETIRED", deprecatedAt: AT }))).toEqual([]);
    expect(modelVersionPayloadIssues(payload({ eligibleRoles: [], transports: [] }))).toEqual([]);

    const cases: readonly [string, Record<string, unknown>, string][] = [
      ["a closed payload refuses a rating parked in it", payload({ qualityScore: 0.9 }), "payload.qualityScore"],
      ["latest_performance_window is economy's, never read here", payload({ latestPerformanceWindow: "w1" }), "payload.latestPerformanceWindow"],
      ["an empty provider", payload({ provider: "" }), "payload.provider"],
      ["a missing release", without(payload(), "release"), "payload.release"],
      ["a status outside the three words", payload({ status: "SUNSET" }), "payload.status"],
      ["negative context", payload({ contextTokens: -1 }), "payload.contextTokens"],
      ["fractional context", payload({ contextTokens: 1.5 }), "payload.contextTokens"],
      ["an absent deprecatedAt", without(payload(), "deprecatedAt"), "payload.deprecatedAt"],
      ["ACTIVE with an instant (N-P14A-8)", payload({ deprecatedAt: AT }), "payload.deprecatedAt"],
      ["RETIRED without one", payload({ status: "RETIRED" }), "payload.deprecatedAt"],
      ["DEPRECATED with a non-instant", payload({ status: "DEPRECATED", deprecatedAt: "yesterday" }), "payload.deprecatedAt"],
      ["a role outside the vocabulary", payload({ eligibleRoles: ["wizard"] }), "payload.eligibleRoles[0]"],
      ["a role declared twice", payload({ eligibleRoles: ["implementer", "implementer"] }), "payload.eligibleRoles[1]"],
      ["roles that are not a list", payload({ eligibleRoles: "implementer" }), "payload.eligibleRoles"],
      ["a transport outside the contract", payload({ transports: ["CARRIER_PIGEON"] }), "payload.transports[0]"],
      ["a transport declared twice", payload({ transports: ["API_KEY", "API_KEY"] }), "payload.transports[1]"],
    ];
    for (const [label, candidate, path] of cases) {
      const issues = modelVersionPayloadIssues(candidate);
      expect({ label, paths: issues.map((issue) => issue.path) }).toEqual({ label, paths: [path] });
      expect(JSON.stringify(issues), label).not.toContain("CARRIER_PIGEON");
      expect(JSON.stringify(issues), label).not.toContain("yesterday");
    }
  });

  it("projects a version with its children in declared order, and never reads a performance window", () => {
    const projected = nextModelVersionProjection(modelVersion(), 7);
    expect(projected).toEqual({
      modelVersionId: MODEL_ONE,
      row: {
        modelVersionId: MODEL_ONE,
        provider: "claude",
        model: "claude-opus-5",
        release: "2026-06-01",
        status: "ACTIVE",
        contextTokens: 200000,
        latestPerformanceWindow: null,
        policyVersion: "2026.09.0",
        deprecatedAt: null,
        documentVersion: 1,
        sequence: 7,
      },
      eligibleRoles: [
        { modelVersionId: MODEL_ONE, ordinal: 0, role: "implementer" },
        { modelVersionId: MODEL_ONE, ordinal: 1, role: "reviewer" },
      ],
      transports: [
        { modelVersionId: MODEL_ONE, ordinal: 0, transportKind: "CLI_SUBSCRIPTION" },
        { modelVersionId: MODEL_ONE, ordinal: 1, transportKind: "API_KEY" },
      ],
    });
    expect(nextModelVersionProjection(assignment(), 7)).toBeNull();
    expect(nextModelVersionProjection(modelVersion({ documentKind: "PRICE_TABLE" }), 7)).toBeNull();
  });

  it("N-P14A-8: a later version replaces the row and its children whole", () => {
    const snapshot = createModelVersionProjectionSnapshot();
    applyRegistryModelVersionToSnapshot(snapshot, modelVersion(), 1);
    applyRegistryModelVersionToSnapshot(
      snapshot,
      modelVersion({
        documentVersion: 2,
        parentDocumentVersion: 1,
        payload: payload({ status: "RETIRED", deprecatedAt: AT, eligibleRoles: ["reviewer"], transports: [] }),
      }),
      2,
    );
    expect(snapshot.modelVersions.get(MODEL_ONE)?.status).toBe("RETIRED");
    expect(snapshot.modelVersions.get(MODEL_ONE)?.documentVersion).toBe(2);
    expect(snapshot.eligibleRoles.get(MODEL_ONE)).toEqual([{ modelVersionId: MODEL_ONE, ordinal: 0, role: "reviewer" }]);
    expect(snapshot.transports.get(MODEL_ONE)).toEqual([]);
  });

  it("N-P14A-9: an unreadable version in history projects no row, and removes the row an earlier version left", () => {
    // Total, and fail-closed at once: the fold refuses nothing, and a version it
    // cannot read leaves no ACTIVE row standing behind it.
    const unreadable = modelVersion({ documentVersion: 2, parentDocumentVersion: 1, payload: { status: "RETIRED" } });
    expect(nextModelVersionProjection(unreadable, 2)).toEqual({
      modelVersionId: MODEL_ONE,
      row: null,
      eligibleRoles: [],
      transports: [],
    });
    const snapshot = createModelVersionProjectionSnapshot();
    applyRegistryModelVersionToSnapshot(snapshot, modelVersion(), 1);
    expect(snapshot.modelVersions.has(MODEL_ONE)).toBe(true);
    applyModelVersionToSnapshot(snapshot, nextModelVersionProjection(unreadable, 2) ?? { modelVersionId: "", row: null, eligibleRoles: [], transports: [] });
    expect([snapshot.modelVersions.size, snapshot.eligibleRoles.size, snapshot.transports.size]).toEqual([0, 0, 0]);
  });

  it("admits an assignment whose version and fallbacks are ACTIVE and eligible, and gates no other kind", () => {
    const lookup = registry({ [MODEL_ONE]: ACTIVE_BOTH, [MODEL_TWO]: ACTIVE_BOTH });
    expect(globalAssignmentIssues(assignment(), lookup)).toEqual([]);
    expect(globalAssignmentIssues(assignment({ fallbacks: undefined }), lookup)).toEqual([]);
    expect(globalAssignmentIssues(modelVersion(), registry({}))).toEqual([]);
    expect(GLOBAL_ASSIGNMENT_REFUSALS).toEqual([
      "MODEL_VERSION_UNKNOWN",
      "MODEL_VERSION_RETIRED",
      "MODEL_VERSION_DEPRECATED",
      "ROLE_NOT_ELIGIBLE",
    ]);
  });

  it("N-P14A-1..4: refuses unknown, retired and deprecated versions and an ineligible role, each with its own word and path", () => {
    const cases: readonly [string, Record<string, ModelVersionEligibility>, string, string][] = [
      ["N-P14A-1", { [MODEL_TWO]: ACTIVE_BOTH }, "payload.modelVersionId", "MODEL_VERSION_UNKNOWN: "],
      ["N-P14A-2", { [MODEL_ONE]: { status: "RETIRED", eligibleRoles: ["implementer"] }, [MODEL_TWO]: ACTIVE_BOTH }, "payload.modelVersionId", "MODEL_VERSION_RETIRED: "],
      ["N-P14A-3", { [MODEL_ONE]: { status: "DEPRECATED", eligibleRoles: ["implementer"] }, [MODEL_TWO]: ACTIVE_BOTH }, "payload.modelVersionId", "MODEL_VERSION_DEPRECATED: "],
      ["N-P14A-4", { [MODEL_ONE]: { status: "ACTIVE", eligibleRoles: ["reviewer"] }, [MODEL_TWO]: ACTIVE_BOTH }, "payload.role", "ROLE_NOT_ELIGIBLE: "],
    ];
    for (const [label, entries, path, word] of cases) {
      const issues = globalAssignmentIssues(assignment(), registry(entries));
      expect({ label, paths: issues.map((issue) => issue.path) }).toEqual({ label, paths: [path] });
      expect(issues[0]?.message.startsWith(word), label).toBe(true);
      expect(issues[0]?.message, label).not.toContain(MODEL_ONE);
    }
    // The retired version is the one with somewhere to go: the refusal proposes
    // migration, and the deprecated one does not.
    const retired = globalAssignmentIssues(assignment(), registry({ [MODEL_ONE]: { status: "RETIRED", eligibleRoles: [] }, [MODEL_TWO]: ACTIVE_BOTH }));
    expect(retired[0]?.message).toContain("migrate the assignment to an ACTIVE model version");
    const deprecated = globalAssignmentIssues(assignment(), registry({ [MODEL_ONE]: { status: "DEPRECATED", eligibleRoles: [] }, [MODEL_TWO]: ACTIVE_BOTH }));
    expect(deprecated[0]?.message).not.toContain("migrate");
  });

  it("N-P14A-5: holds every fallback to the same rule, at the fallback's own path", () => {
    const issues = globalAssignmentIssues(
      assignment({ fallbacks: [MODEL_TWO, "ghost", "retired", "narrow"] }),
      registry({
        [MODEL_ONE]: ACTIVE_BOTH,
        [MODEL_TWO]: ACTIVE_BOTH,
        retired: { status: "RETIRED", eligibleRoles: ["implementer"] },
        narrow: { status: "ACTIVE", eligibleRoles: ["verifier"] },
      }),
    );
    expect(issues.map((issue) => [issue.path, issue.message.split(":")[0]])).toEqual([
      ["payload.fallbacks[1]", "MODEL_VERSION_UNKNOWN"],
      ["payload.fallbacks[2]", "MODEL_VERSION_RETIRED"],
      ["payload.fallbacks[3]", "ROLE_NOT_ELIGIBLE"],
    ]);
  });

  it("refuses an assignment the fold could not read, field by field, before any lookup", () => {
    let looked = 0;
    const counting = (): ModelVersionEligibility | null => {
      looked += 1;
      return ACTIVE_BOTH;
    };
    const issues = globalAssignmentIssues(
      assignment({ role: "wizard", slot: -1, provider: "", modelVersionId: "", fallbacks: [1] }),
      counting,
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      "payload.role",
      "payload.slot",
      "payload.provider",
      "payload.modelVersionId",
      "payload.fallbacks",
    ]);
    expect(looked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The price interval catalog and the PRICE_TABLE gate (P-33/catálogo A)
// ---------------------------------------------------------------------------

/**
 * `priceTablePayloadIssues`, `priceTableIssues` and `nextPriceIntervalProjection`,
 * asserted directly (ADR 0091).
 *
 * The payload is closed and its intervals do not meet; the gate adds a lookup of
 * the registry the suite injects; the fold is total and whole per version, and
 * never looks anything up.
 */
describe("the price interval fold and the PRICE_TABLE gate", () => {
  const MODEL_ONE = "claude-opus-5@2026-06-01";
  const MODEL_TWO = "claude-sonnet-5@2026-06-01";
  const AT = "2026-09-14T12:00:00.000Z";
  const JAN = "2026-01-01T00:00:00.000Z";
  const FEB = "2026-02-01T00:00:00.000Z";
  const MAR = "2026-03-01T00:00:00.000Z";

  function interval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      provider: "claude",
      modelVersionId: MODEL_ONE,
      transportKind: "API_KEY",
      tokenClass: "input",
      currency: "USD",
      effectiveFrom: JAN,
      effectiveTo: null,
      pricePerMillionNanos: 15_000_000_000,
      ...overrides,
    };
  }

  function priceTable(intervals: readonly unknown[], overrides: Record<string, unknown> = {}): RegistryDocument {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "0000dddd-0000-4000-8000-000000000001",
      idempotencyKey: "catalog-claude/1",
      documentKind: "PRICE_TABLE",
      documentId: "catalog-claude",
      documentVersion: 1,
      parentDocumentVersion: null,
      contentDigest: "3".repeat(64),
      recordedBy: EMITTED_BY,
      effectiveFrom: AT,
      occurredAt: AT,
      recordedAt: AT,
      payload: { intervals },
      ...overrides,
    } as RegistryDocument;
  }

  function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
  }

  /** Each issue as its path and the closed word at the head of its message, or no word. */
  function paths(payload: Record<string, unknown>): string[] {
    return priceTablePayloadIssues(payload).map(
      (issue) => issue.path + " " + (/^([A-Z_]+):/.exec(issue.message)?.[1] ?? ""),
    );
  }

  const REGISTERED: (id: string) => PriceTableModelVersion | null = (id) =>
    id === MODEL_ONE || id === MODEL_TWO ? { provider: "claude" } : null;

  it("admits the closed payload, and names its words in a closed order", () => {
    expect(priceTablePayloadIssues({ intervals: [interval()] })).toEqual([]);
    expect(priceTableIssues(priceTable([interval()]), REGISTERED)).toEqual([]);
    expect(PRICE_TABLE_REFUSALS).toEqual([
      "PRICE_INTERVAL_DUPLICATE",
      "PRICE_INTERVAL_OVERLAP",
      "MODEL_VERSION_UNKNOWN",
      "MODEL_VERSION_PROVIDER_MISMATCH",
    ]);
  });

  it("N-P33-1: two intervals of one quintuple that meet are refused by name", () => {
    expect(
      paths({ intervals: [interval({ effectiveTo: MAR }), interval({ effectiveFrom: FEB, effectiveTo: null })] }),
    ).toEqual(["payload.intervals[1] PRICE_INTERVAL_OVERLAP"]);
    // Named at the later start whatever the list order, and one interval inside another is a meeting too.
    expect(
      paths({ intervals: [interval({ effectiveFrom: FEB, effectiveTo: MAR }), interval({ effectiveTo: null })] }),
    ).toEqual(["payload.intervals[0] PRICE_INTERVAL_OVERLAP"]);
  });

  it("N-P33-2: the same window under another transport, currency, token class or model version is admitted", () => {
    const base = interval({ effectiveTo: MAR });
    for (const [label, other] of [
      ["transport", interval({ effectiveTo: MAR, transportKind: "CLI_SUBSCRIPTION" })],
      ["currency", interval({ effectiveTo: MAR, currency: "EUR" })],
      ["token class", interval({ effectiveTo: MAR, tokenClass: "output" })],
      ["model version", interval({ effectiveTo: MAR, modelVersionId: MODEL_TWO })],
    ] as const) {
      expect(priceTablePayloadIssues({ intervals: [base, other] }), label).toEqual([]);
    }
  });

  it("N-P33-3: an end equal to or before the start is refused", () => {
    expect(paths({ intervals: [interval({ effectiveTo: JAN })] })).toEqual(["payload.intervals[0].effectiveTo "]);
    expect(paths({ intervals: [interval({ effectiveFrom: FEB, effectiveTo: JAN })] })).toEqual([
      "payload.intervals[0].effectiveTo ",
    ]);
  });

  it("N-P33-4: a negative, fractional or unsafe price is refused, and zero and the largest safe integer are admitted", () => {
    for (const price of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "15", null]) {
      expect(paths({ intervals: [interval({ pricePerMillionNanos: price })] }), String(price)).toEqual([
        "payload.intervals[0].pricePerMillionNanos ",
      ]);
    }
    for (const price of [0, Number.MAX_SAFE_INTEGER]) {
      expect(priceTablePayloadIssues({ intervals: [interval({ pricePerMillionNanos: price })] }), String(price)).toEqual([]);
    }
  });

  it("N-P33-5: a token class outside the four and a transport outside the contract are refused, without echo", () => {
    expect(paths({ intervals: [interval({ tokenClass: "reasoning" })] })).toEqual(["payload.intervals[0].tokenClass "]);
    expect(paths({ intervals: [interval({ transportKind: "CARRIER_PIGEON" })] })).toEqual([
      "payload.intervals[0].transportKind ",
    ]);
    for (const tokenClass of ["input", "output", "cache_write", "cache_read"]) {
      expect(priceTablePayloadIssues({ intervals: [interval({ tokenClass })] }), tokenClass).toEqual([]);
    }
    expect(JSON.stringify(priceTablePayloadIssues({ intervals: [interval({ transportKind: "CARRIER_PIGEON", tokenClass: "reasoning" })] }))).not.toMatch(
      /CARRIER_PIGEON|reasoning/,
    );
  });

  it("N-P33-6, Q4: a currency outside three upper-case letters is refused, and two currencies of one version coexist unsummed", () => {
    for (const currency of ["usd", "US", "USDX", "U5D", ""]) {
      expect(paths({ intervals: [interval({ currency })] }), currency).toEqual(["payload.intervals[0].currency "]);
    }
    const projected = nextPriceIntervalProjection(
      priceTable([interval(), interval({ currency: "EUR", pricePerMillionNanos: 14_000_000_000 })]),
      3,
    );
    expect(projected?.rows.map((row) => [row.currency, row.pricePerMillionNanos])).toEqual([
      ["USD", 15_000_000_000],
      ["EUR", 14_000_000_000],
    ]);
  });

  it("N-P33-8: an undeclared key of the payload or of an interval, an empty list and a primary key twice are refused", () => {
    expect(paths({ intervals: [interval()], currency: "USD" })).toEqual(["payload.currency "]);
    expect(paths({ intervals: [interval({ discount: 0.1 })] })).toEqual(["payload.intervals[0].discount "]);
    expect(paths({ intervals: [] })).toEqual(["payload.intervals "]);
    expect(paths({})).toEqual(["payload.intervals "]);
    expect(paths({ intervals: interval() })).toEqual(["payload.intervals "]);
    expect(paths({ intervals: [null, [], "row"] })).toEqual([
      "payload.intervals[0] ",
      "payload.intervals[1] ",
      "payload.intervals[2] ",
    ]);
    expect(paths({ intervals: [without(interval(), "effectiveTo")] })).toEqual(["payload.intervals[0].effectiveTo "]);
    // The same primary key with another price is a duplicate, never a later word.
    expect(
      paths({ intervals: [interval(), interval({ pricePerMillionNanos: 1, effectiveTo: MAR })] }),
    ).toEqual(["payload.intervals[1] PRICE_INTERVAL_DUPLICATE"]);
  });

  it("N-P33A-4: an instant outside the canonical round-trip form is refused at either end", () => {
    for (const instant of ["2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00Z", "2026-02-30T00:00:00.000Z", "2026-01-01"]) {
      expect(paths({ intervals: [interval({ effectiveFrom: instant })] }), instant).toEqual([
        "payload.intervals[0].effectiveFrom ",
      ]);
      expect(paths({ intervals: [interval({ effectiveTo: instant })] }), instant).toEqual([
        "payload.intervals[0].effectiveTo ",
      ]);
    }
  });

  it("N-P33A-5: adjacent intervals are admitted; an open end meets every later start; two open ends meet", () => {
    expect(
      priceTablePayloadIssues({
        intervals: [interval({ effectiveTo: FEB }), interval({ effectiveFrom: FEB, effectiveTo: MAR }), interval({ effectiveFrom: MAR })],
      }),
    ).toEqual([]);
    expect(paths({ intervals: [interval({ effectiveTo: null }), interval({ effectiveFrom: MAR, effectiveTo: null })] })).toEqual([
      "payload.intervals[1] PRICE_INTERVAL_OVERLAP",
    ]);
    expect(paths({ intervals: [interval({ effectiveFrom: FEB, effectiveTo: MAR }), interval({ effectiveTo: null })] })).toEqual([
      "payload.intervals[0] PRICE_INTERVAL_OVERLAP",
    ]);
    expect(paths({ intervals: [interval({ effectiveFrom: MAR }), interval({ effectiveFrom: FEB })] })).toEqual([
      "payload.intervals[0] PRICE_INTERVAL_OVERLAP",
    ]);
  });

  it("N-P33-14, H-11: the gate refuses a model version nobody registered and one registered under another provider", () => {
    const retired: (id: string) => PriceTableModelVersion | null = (id) => (id === MODEL_ONE ? { provider: "claude" } : null);
    expect(priceTableIssues(priceTable([interval()]), retired)).toEqual([]);
    const refused = priceTableIssues(
      priceTable([interval(), interval({ modelVersionId: "ghost" }), interval({ modelVersionId: MODEL_TWO, provider: "openai" })]),
      (id) => (id === MODEL_ONE ? { provider: "claude" } : id === MODEL_TWO ? { provider: "claude" } : null),
    );
    expect(refused.map((issue) => issue.path + " " + (issue.message.split(":")[0] ?? ""))).toEqual([
      "payload.intervals[1].modelVersionId MODEL_VERSION_UNKNOWN",
      "payload.intervals[2].provider MODEL_VERSION_PROVIDER_MISMATCH",
    ]);
    expect(JSON.stringify(refused)).not.toMatch(/ghost|openai/);
  });

  it("H-3: the gate reads the shape before any lookup, and gates no other kind", () => {
    let looked = 0;
    const counting = (): PriceTableModelVersion | null => {
      looked += 1;
      return { provider: "claude" };
    };
    expect(priceTableIssues(priceTable([interval({ currency: "usd" })]), counting).map((issue) => issue.path)).toEqual([
      "payload.intervals[0].currency",
    ]);
    expect(looked).toBe(0);
    expect(priceTableIssues({ ...priceTable([]), documentKind: "MODEL_VERSION" } as RegistryDocument, counting)).toEqual([]);
    expect(looked).toBe(0);
  });

  it("projects every interval of the version with the document's coordinate and the event's author and sequence", () => {
    const projected = nextPriceIntervalProjection(priceTable([interval({ effectiveTo: FEB }), interval({ tokenClass: "output" })]), 9);
    expect(projected).toEqual({
      catalogDocumentId: "catalog-claude",
      catalogVersion: 1,
      rows: [
        {
          catalogDocumentId: "catalog-claude",
          catalogVersion: 1,
          provider: "claude",
          modelVersionId: MODEL_ONE,
          transportKind: "API_KEY",
          tokenClass: "input",
          currency: "USD",
          effectiveFrom: JAN,
          effectiveTo: FEB,
          pricePerMillionNanos: 15_000_000_000,
          recordedBy: EMITTED_BY,
          sequence: 9,
        },
        {
          catalogDocumentId: "catalog-claude",
          catalogVersion: 1,
          provider: "claude",
          modelVersionId: MODEL_ONE,
          transportKind: "API_KEY",
          tokenClass: "output",
          currency: "USD",
          effectiveFrom: JAN,
          effectiveTo: null,
          pricePerMillionNanos: 15_000_000_000,
          recordedBy: EMITTED_BY,
          sequence: 9,
        },
      ],
    });
    expect(nextPriceIntervalProjection({ ...priceTable([interval()]), documentKind: "MODEL_VERSION" } as RegistryDocument, 9)).toBeNull();
  });

  it("N-P33-7, H-2: a version with one bad interval among good ones folds to no row at all, and never throws", () => {
    for (const intervals of [
      [interval(), interval({ tokenClass: "output" }), interval({ currency: "usd" })],
      [interval({ effectiveTo: MAR }), interval({ effectiveFrom: FEB })],
      [],
    ]) {
      expect(nextPriceIntervalProjection(priceTable(intervals), 4)).toEqual({
        catalogDocumentId: "catalog-claude",
        catalogVersion: 1,
        rows: [],
      });
    }
    // A payload the registry door would not even let reach the fold.
    expect(nextPriceIntervalProjection({ ...priceTable([]), payload: null } as unknown as RegistryDocument, 4)?.rows).toEqual([]);
  });

  it("N-P33-13, E11: a retroactive later version adds its rows beside the earlier version's and changes none of them", () => {
    const snapshot = createPriceIntervalProjectionSnapshot();
    applyRegistryPriceIntervalToSnapshot(snapshot, priceTable([interval()]), 1);
    const first = [...snapshot.intervals.entries()];
    applyRegistryPriceIntervalToSnapshot(
      snapshot,
      priceTable([interval({ pricePerMillionNanos: 12_000_000_000 })], { documentVersion: 2, parentDocumentVersion: 1, idempotencyKey: "catalog-claude/2" }),
      2,
    );
    expect(snapshot.intervals.size).toBe(2);
    for (const [key, row] of first) expect(snapshot.intervals.get(key)).toEqual(row);
    const second = [...snapshot.intervals.values()].find((row) => row.catalogVersion === 2);
    expect(second?.pricePerMillionNanos).toBe(12_000_000_000);
    expect(second === undefined ? "" : priceIntervalKey(second)).not.toBe(first[0]?.[0]);
  });
});

// ---------------------------------------------------------------------------
// The revision fold (P-05/B)
// ---------------------------------------------------------------------------

/**
 * `nextTaskRevisionProjection`, asserted directly.
 *
 * The fold is the whole of B's reading side: a record of a revision is born
 * from the payload of an event of **any** type that carries the complete key
 * set, because the adjudication forbids a new event type and a fold that keyed
 * off a type would therefore have nothing to key off.
 *
 * That makes "what counts as complete" the load-bearing decision, and these
 * drills are where it is pinned. A fold that accepted a partial set would mint
 * a revision record out of an event that never claimed to be one.
 */
describe("the revision fold reads a coordinate, or reads nothing", () => {
  const REVISION_TASK = "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c01";
  const REVISION_ID = "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d01";
  const OTHER_REVISION = "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d02";
  const ENVELOPE = "e".repeat(64);
  // A registered reference is the door's question, never the fold's (M-5.3),
  // so any non-empty string stands for one here.
  const ENVELOPE_REFERENCE = "ref-envelope-2";

  function revisionEvent(
    payload: Record<string, unknown>,
    overrides: { readonly occurredAt?: string; readonly contractVersion?: string } = {},
  ): ControlPlaneEvent {
    // These fold inputs are cast rather than parsed, so the contract's door
    // never sees them — which is exactly why the key is composed correctly
    // here. A fixture the contract would have refused is a fixture that asserts
    // the fold's behaviour on an event no producer could ever emit.
    const revisionNumber = payload["revisionNumber"];
    const attemptNumber = payload["attemptNumber"];
    const occurredAt = overrides.occurredAt ?? "2026-09-11T09:00:00.000Z";
    return {
      contractVersion: overrides.contractVersion ?? CONTRACT_VERSION,
      eventId: "2e2e2e2e-2e2e-4e2e-8e2e-2e2e2e2e2e01",
      taskId: REVISION_TASK,
      attempt: 3,
      transitionId: "revise",
      idempotencyKey:
        typeof revisionNumber === "number" && typeof attemptNumber === "number"
          ? buildV2IdempotencyKey({
              stream: "control_plane_events",
              taskId: REVISION_TASK,
              revisionNumber,
              attemptNumber,
              transitionId: "revise",
            })
          : buildIdempotencyKey({
              taskId: REVISION_TASK,
              attempt: 3,
              transitionId: "revise",
            }),
      type: "TASK_CLASSIFIED",
      fromState: "DISCOVERED",
      toState: "DT_CLASSIFIED",
      emittedBy: EMITTED_BY,
      occurredAt,
      recordedAt: occurredAt,
      correlationId: null,
      causationId: null,
      payload,
    } as unknown as ControlPlaneEvent;
  }

  /** The four keys that make an event a revision record at all. */
  const RECORD = {
    revisionId: REVISION_ID,
    revisionNumber: 2,
    attemptNumber: 1,
    envelopeSha256: ENVELOPE,
  };

  /** The record as the version in force states it: with its envelope reference. */
  const COMPLETE = { ...RECORD, envelopeArtifactReferenceId: ENVELOPE_REFERENCE };

  it("N5: an event with no revision keys leaves the projection untouched", () => {
    expect(nextTaskRevisionProjection(revisionEvent({}), 7)).toBeNull();
    expect(nextTaskRevisionProjection(revisionEvent({ route: "irrelevant" }), 7)).toBeNull();
  });

  it("N11: an event in V1 form is not reinterpreted as a revision", () => {
    // The shape a ledger written before migration 11 is full of. It must fold
    // to no revision at all — not to a partial row, and not to an error. A
    // replay over a legacy ledger has to stay total.
    for (const payload of [
      {},
      { initiativeId: "3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f01" },
      { route: { provider: "claude", model: "opus" } },
      { accountId: "acct-primary", tokens: 12 },
    ]) {
      expect(nextTaskRevisionProjection(revisionEvent(payload), 7), JSON.stringify(payload)).toBeNull();
    }
  });

  it("requires the whole key set, and a partial set is no revision at all", () => {
    // Each key removed in turn. A fold that accepted three of four would mint a
    // record with a field it invented, and the record is the authority for what
    // was asked — there is nothing to invent it from.
    // The envelope reference is not one of the four: its absence is a refusal
    // decided by the cohort, drilled below, not a partial record.
    for (const missing of Object.keys(RECORD)) {
      const partial = Object.fromEntries(
        Object.entries(COMPLETE).filter(([key]) => key !== missing),
      );
      expect(nextTaskRevisionProjection(revisionEvent(partial), 7), missing).toBeNull();
    }

    // And a key of the wrong shape is the same as a key absent: a revision
    // number that is not a positive integer is not a revision number.
    for (const bad of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        nextTaskRevisionProjection(revisionEvent({ ...COMPLETE, revisionNumber: bad }), 7),
        JSON.stringify(bad),
      ).toBeNull();
    }
  });

  it("N6 / N-P36D-2: refuses a revision of the cohort before that carries an envelope reference", () => {
    // B-5, now conditioned on the cohort (decision 41). A record stamped 2.2.0,
    // 2.3.0 or 2.4.0 was written by a build with no plane to mint a reference,
    // so a reference on it is a fact its own contract cannot represent. Ignoring
    // it would drop what the writer believed it recorded; interpreting it would
    // be a reader pretending to understand. The refusal names the key.
    expect([...PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS]).toEqual(["2.2.0", "2.3.0", "2.4.0"]);
    for (const contractVersion of PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS) {
      for (const value of [ENVELOPE_REFERENCE, null, "", 7]) {
        const issue = refusedWith(() =>
          nextTaskRevisionProjection(
            revisionEvent({ ...RECORD, envelopeArtifactReferenceId: value }, { contractVersion }),
            7,
          ),
        );
        expect(issue.path, contractVersion).toBe("payload." + ENVELOPE_ARTIFACT_REFERENCE_KEY);
        expect(issue.message).toContain("carries no envelope reference");
      }

      // The same record without the key folds cleanly, to a row holding null:
      // the refusal is about the key, not about the rest of the record.
      const prior = nextTaskRevisionProjection(revisionEvent(RECORD, { contractVersion }), 7);
      expect(prior?.envelopeArtifactReferenceId, contractVersion).toBeNull();
      expect(prior?.contractVersion).toBe(contractVersion);
    }
  });

  it("N-P36D-1 / N-P36D-4: requires the reference from the cohort on, and never reads one off the digest", () => {
    // The version in force is outside the frozen list, so its record must name
    // its envelope by reference. The digest is right there in the payload, and
    // it is exactly what the fold must not fall back to.
    expect(PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS).not.toContain(CONTRACT_VERSION);
    const issue = refusedWith(() => nextTaskRevisionProjection(revisionEvent(RECORD), 7));
    expect(issue.path).toBe("payload." + ENVELOPE_ARTIFACT_REFERENCE_KEY);
    expect(issue.message).toContain("names none");
    expect(issue.message).toContain("never derived from the envelope's digest");

    // A later bump falls into the same cohort without anyone editing the list.
    const later = refusedWith(() =>
      nextTaskRevisionProjection(revisionEvent(RECORD, { contractVersion: "2.7.0" }), 7),
    );
    expect(later.path).toBe("payload." + ENVELOPE_ARTIFACT_REFERENCE_KEY);

    // And a partial record still is no record, reference or not: the cohort is
    // asked only of an event that constitutes a revision.
    const partial = Object.fromEntries(
      Object.entries(RECORD).filter(([key]) => key !== "envelopeSha256"),
    );
    expect(nextTaskRevisionProjection(revisionEvent(partial), 7)).toBeNull();
  });

  it("N-P36D-3: a present value that is not a reference is refused by name, never read as absent", () => {
    // CORR-2, decision 56. `null` is a writer that said something; reading it as
    // absent would launder a malformed record into a row, and the row into the
    // trigger's nameless abort.
    for (const [value, words] of [
      [null, "holds null"],
      ["", "holds an empty string"],
      [42, "holds a number"],
      [{ artifactReferenceId: ENVELOPE_REFERENCE }, "holds a object"],
      [true, "holds a boolean"],
    ] as const) {
      const issue = refusedWith(() =>
        nextTaskRevisionProjection(
          revisionEvent({ ...RECORD, envelopeArtifactReferenceId: value }),
          7,
        ),
      );
      expect(issue.path, JSON.stringify(value)).toBe("payload." + ENVELOPE_ARTIFACT_REFERENCE_KEY);
      expect(issue.message, JSON.stringify(value)).toContain(words);
    }
    expect(nextTaskRevisionProjection(revisionEvent(COMPLETE), 7)?.envelopeArtifactReferenceId).toBe(
      ENVELOPE_REFERENCE,
    );
  });

  it("takes every field from the event, never from the payload's say-so", () => {
    const row = nextTaskRevisionProjection(revisionEvent(COMPLETE), 42);
    expect(row).toEqual({
      // The task is the EVENT's, so a payload cannot claim another task's
      // revision — the same structural binding the route row has.
      taskId: REVISION_TASK,
      revisionNumber: 2,
      revisionId: REVISION_ID,
      envelopeSha256: ENVELOPE,
      // The payload's, verbatim: a reference is a name the producer carries,
      // never something this fold computes (decision 41).
      envelopeArtifactReferenceId: ENVELOPE_REFERENCE,
      restoredFromRevisionId: null,
      createdAt: "2026-09-11T09:00:00.000Z",
      createdBy: EMITTED_BY,
      contractVersion: CONTRACT_VERSION,
      sequence: 42,
    });

    // A payload that names another task is ignored on that point: `taskId` is
    // not a key of the revision record at all.
    const foreign = nextTaskRevisionProjection(
      revisionEvent({ ...COMPLETE, taskId: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a01" }),
      42,
    );
    expect(foreign?.taskId).toBe(REVISION_TASK);

    // `restoredFromRevisionId` is the one optional key, and it is carried when
    // present: it is what tells a reader that two revisions sharing a digest do
    // so because one restored the other.
    const restored = nextTaskRevisionProjection(
      revisionEvent({ ...COMPLETE, restoredFromRevisionId: REVISION_ID }),
      42,
    );
    expect(restored?.restoredFromRevisionId).toBe(REVISION_ID);
  });

  it("carries the envelope and the number together, and the attempt at its highest", () => {
    // The denormalization on `task_read_model`. The envelope and the number
    // move as one or not at all: a task advertising revision 3's number beside
    // revision 2's envelope is the one failure a convenience column must never
    // produce. The attempt answers a different question and has its own rule,
    // drilled in the test below.
    const first = nextTaskProjection(null, revisionEvent(COMPLETE), 1);
    expect([first.latestRevisionNumber, first.envelopeSha256, first.latestAttemptNumber]).toEqual([
      2,
      ENVELOPE,
      1,
    ]);

    // An event with no revision leaves all three exactly where they were.
    const carried = nextTaskProjection(first, revisionEvent({}), 2);
    expect([carried.latestRevisionNumber, carried.envelopeSha256, carried.latestAttemptNumber]).toEqual([
      2,
      ENVELOPE,
      1,
    ]);

    // A LATER revision replaces all three.
    const later = nextTaskProjection(
      carried,
      revisionEvent({ ...COMPLETE, revisionNumber: 3, envelopeSha256: "f".repeat(64), attemptNumber: 1 }),
      3,
    );
    expect([later.latestRevisionNumber, later.envelopeSha256]).toEqual([3, "f".repeat(64)]);

    // An EARLIER one replaces none of them: a late event from an older revision
    // must not make the task claim it went backwards, exactly as `latestAttempt`
    // never decreases.
    const late = nextTaskProjection(
      later,
      revisionEvent({ ...COMPLETE, revisionNumber: 1, envelopeSha256: "0".repeat(64) }),
      4,
    );
    expect([late.latestRevisionNumber, late.envelopeSha256]).toEqual([3, "f".repeat(64)]);

    // And a task whose whole history is V1 keeps all three null, for ever.
    const legacy = nextTaskProjection(null, revisionEvent({}), 1);
    expect([legacy.latestRevisionNumber, legacy.envelopeSha256, legacy.latestAttemptNumber]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("keeps the highest attempt within one revision, whichever order they arrive in", () => {
    // Within a single revision the attempts are a sequence, and the fold must
    // not let a late event lower the one already recorded — the task would
    // claim it went backwards, which is precisely what `latestAttempt` refuses
    // for the legacy counter.
    //
    // The two orders are BOTH asserted on purpose. Folding 3 then 1 is the
    // failing case; folding 1 then 3 succeeds under a fold that simply takes
    // the last arrival, so a test written only that way agrees with the bug.
    const highFirst = nextTaskProjection(
      nextTaskProjection(null, revisionEvent({ ...COMPLETE, attemptNumber: 3 }), 1),
      revisionEvent({ ...COMPLETE, attemptNumber: 1 }),
      2,
    );
    expect(highFirst.latestAttemptNumber).toBe(3);

    const lowFirst = nextTaskProjection(
      nextTaskProjection(null, revisionEvent({ ...COMPLETE, attemptNumber: 1 }), 1),
      revisionEvent({ ...COMPLETE, attemptNumber: 3 }),
      2,
    );
    expect(lowFirst.latestAttemptNumber).toBe(3);

    // The same revision moves nothing else. The envelope and the number belong
    // to the revision, and a second event at the same coordinate is the same
    // revision — carrying them again would be a write with no fact behind it.
    expect([highFirst.latestRevisionNumber, highFirst.envelopeSha256]).toEqual([2, ENVELOPE]);

    // A HIGHER revision restarts the attempt rather than keeping the maximum:
    // attempt 1 of revision 3 is not "lower" than attempt 3 of revision 2, it
    // is a different unit of work. This is the case a plain `Math.max` over the
    // attempt alone would get wrong in the other direction.
    const nextRevision = nextTaskProjection(
      highFirst,
      revisionEvent({
        ...COMPLETE,
        revisionNumber: 3,
        envelopeSha256: "f".repeat(64),
        attemptNumber: 1,
      }),
      3,
    );
    expect([
      nextRevision.latestRevisionNumber,
      nextRevision.envelopeSha256,
      nextRevision.latestAttemptNumber,
    ]).toEqual([3, "f".repeat(64), 1]);

    // And an OLDER revision announcing a huge attempt moves nothing at all.
    const stale = nextTaskProjection(
      nextRevision,
      revisionEvent({ ...COMPLETE, revisionNumber: 2, attemptNumber: 99 }),
      4,
    );
    expect([
      stale.latestRevisionNumber,
      stale.envelopeSha256,
      stale.latestAttemptNumber,
    ]).toEqual([3, "f".repeat(64), 1]);
  });

  it("F-1: compares what the revision IS, not the arrival that recorded it", () => {
    // ADR 0072. `canonicalRevision` is the single definition of "same content"
    // that the append door and the snapshot both consult — the door imports
    // this exact function — so what it compares decides which histories BOTH
    // paths accept. Drilled here, at the definition, rather than only through
    // the two callers.
    const at = (sequence: number, occurredAt: string): ReturnType<
      typeof nextTaskRevisionProjection
    > => nextTaskRevisionProjection(revisionEvent(COMPLETE, { occurredAt }), sequence);

    const born = at(10, "2026-09-11T09:00:00.000Z");
    const retried = at(44, "2026-09-11T17:45:00.000Z");
    expect(born).not.toBeNull();
    expect(retried).not.toBeNull();

    // The two rows differ in sequence AND in createdAt, and are the same
    // revision. Before F-1 this pair conflicted, so the only way to record a
    // second attempt of one revision was to restate the first arrival's
    // timestamp — to lie about when the attempt happened.
    expect(born?.createdAt).not.toBe(retried?.createdAt);
    expect(canonicalRevision(born!)).toBe(canonicalRevision(retried!));

    // A hand-built row differing only in the other two birth attributes agrees
    // too: `createdBy` and `contractVersion` record who announced it and under
    // which contract, not what was asked. `contractVersion` is the one that
    // would have bitten once `SUPPORTED_CONTRACT_VERSIONS` grows, because a
    // retry stamped with a newer member would have conflicted against its own
    // row while agreeing about every fact in it.
    expect(
      canonicalRevision({
        ...born!,
        createdBy: "kimi/k3/coordinator/01",
        contractVersion: "2.9.0",
      }),
    ).toBe(canonicalRevision(born!));

    // And the three that ARE the revision each still separate it. These are
    // the refusals F-1 preserves: two answers to "what was asked".
    expect(canonicalRevision({ ...born!, revisionId: OTHER_REVISION })).not.toBe(
      canonicalRevision(born!),
    );
    expect(canonicalRevision({ ...born!, envelopeSha256: "f".repeat(64) })).not.toBe(
      canonicalRevision(born!),
    );
    expect(canonicalRevision({ ...born!, restoredFromRevisionId: OTHER_REVISION })).not.toBe(
      canonicalRevision(born!),
    );
    // Including dropping the restore source, which is a different answer and
    // not a silent agreement with whatever was already there.
    expect(
      canonicalRevision({ ...born!, restoredFromRevisionId: OTHER_REVISION }),
    ).not.toBe(canonicalRevision({ ...born!, restoredFromRevisionId: null }));
  });

  it("N-P36D-9 / Q-D2: counts the envelope reference only when the stored row holds one", () => {
    // `sameRevisionRecord` is what the door and the snapshot both call. A row
    // of the new cohort holds a reference, so another reference at its
    // coordinate is a second answer to where the envelope's bytes are.
    const stored = nextTaskRevisionProjection(revisionEvent(COMPLETE), 10)!;
    const replay = nextTaskRevisionProjection(
      revisionEvent(COMPLETE, { occurredAt: "2026-09-11T17:45:00.000Z" }),
      44,
    )!;
    const other = nextTaskRevisionProjection(
      revisionEvent({ ...COMPLETE, envelopeArtifactReferenceId: "ref-envelope-other" }),
      44,
    )!;
    expect(sameRevisionRecord(stored, replay)).toBe(true);
    expect(sameRevisionRecord(stored, other)).toBe(false);
    // `canonicalRevision` alone would call them the same, which is why it is
    // not what the two callers consult any more.
    expect(canonicalRevision(stored)).toBe(canonicalRevision(other));

    // A row of the cohort before holds null for ever. A second attempt of it,
    // stamped after the upgrade, carries the reference its own version
    // requires — and agrees with the row on the three facts it has.
    const prior = nextTaskRevisionProjection(revisionEvent(RECORD, { contractVersion: "2.4.0" }), 10)!;
    expect(prior.envelopeArtifactReferenceId).toBeNull();
    expect(sameRevisionRecord(prior, stored)).toBe(true);
    expect(sameRevisionRecord(prior, other)).toBe(true);

    // And the three facts still separate both cohorts.
    expect(sameRevisionRecord(prior, { ...stored, envelopeSha256: "f".repeat(64) })).toBe(false);
    expect(sameRevisionRecord(stored, { ...replay, revisionId: OTHER_REVISION })).toBe(false);

    // In the snapshot, which is the rebuild's fold: the same answers.
    const key = taskRevisionKey(REVISION_TASK, 2);
    const snapshot = createProjectionSnapshot();
    applyEventToSnapshot(snapshot, revisionEvent(RECORD, { contractVersion: "2.4.0" }), 1, EVENT_SHA256);
    applyEventToSnapshot(snapshot, revisionEvent(COMPLETE), 2, EVENT_SHA256);
    expect(snapshot.taskRevisions.get(key)?.envelopeArtifactReferenceId).toBeNull();
    const renamed = createProjectionSnapshot();
    applyEventToSnapshot(renamed, revisionEvent(COMPLETE), 1, EVENT_SHA256);
    applyEventToSnapshot(renamed, revisionEvent(COMPLETE), 2, EVENT_SHA256);
    expect(() => {
      applyEventToSnapshot(
        renamed,
        revisionEvent({ ...COMPLETE, envelopeArtifactReferenceId: "ref-envelope-other" }),
        3,
        EVENT_SHA256,
      );
    }).toThrow(/already recorded with different content/);
  });
});

describe("the attempt fold reads an opening, or reads nothing", () => {
  const ATTEMPT_TASK = "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c01";
  const REVISION = "4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d01";
  const ENVELOPE = "e".repeat(64);

  /** The seven keys an opening carries: revision record, coordinate, identity. */
  const OPENING = {
    revisionId: REVISION,
    revisionNumber: 2,
    attemptNumber: 1,
    envelopeSha256: ENVELOPE,
    envelopeArtifactReferenceId: "ref-envelope-opening",
    invocationId: "inv-0001",
    legacyAttemptNumber: 4,
  };

  function attemptEvent(
    payload: Record<string, unknown>,
    overrides: {
      readonly type?: ControlPlaneEvent["type"];
      readonly occurredAt?: string;
      readonly attempt?: number;
      readonly transitionId?: string;
      readonly taskId?: string;
    } = {},
  ): ControlPlaneEvent {
    // Cast rather than parsed, exactly as the revision fixtures above are —
    // which is why the key is still composed correctly: a fixture the contract
    // would have refused asserts the fold's behaviour on an event no producer
    // could emit.
    const taskId = overrides.taskId ?? ATTEMPT_TASK;
    const transitionId = overrides.transitionId ?? "attempt.open";
    const attempt = overrides.attempt ?? 4;
    const revisionNumber = payload["revisionNumber"];
    const attemptNumber = payload["attemptNumber"];
    const occurredAt = overrides.occurredAt ?? "2026-09-12T09:00:00.000Z";
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e01",
      taskId,
      attempt,
      transitionId,
      idempotencyKey:
        typeof revisionNumber === "number" && typeof attemptNumber === "number"
          ? buildV2IdempotencyKey({
              stream: "control_plane_events",
              taskId,
              revisionNumber,
              attemptNumber,
              transitionId,
            })
          : buildIdempotencyKey({ taskId, attempt, transitionId }),
      type: overrides.type ?? "TASK_ATTEMPT_OPENED",
      fromState: "RUNNING",
      toState: "RUNNING",
      emittedBy: EMITTED_BY,
      occurredAt,
      recordedAt: occurredAt,
      correlationId: null,
      causationId: null,
      payload,
    } as unknown as ControlPlaneEvent;
  }

  it("keys off the type, not off the presence of the key set", () => {
    // The deliberate asymmetry with the revision fold above, and the reason it
    // exists: `invocationId` and `legacyAttemptNumber` are facts only the
    // opening arrival may state, so a fold keyed off presence would let a later
    // event of the same coordinate restate — and therefore contradict — the
    // identity the compare-and-set assigned.
    expect(nextTaskAttemptProjection(attemptEvent(OPENING), 7)).not.toBeNull();
    for (const type of ["TASK_DISCOVERED", "RUN_STARTED", "TOKEN_USAGE_RECORDED"] as const) {
      expect(nextTaskAttemptProjection(attemptEvent(OPENING, { type }), 7), type).toBeNull();
    }

    // And the revision fold still reads the SAME payload as a revision record,
    // because the opening announces both. That is what satisfies the attempt
    // table's foreign key by construction.
    expect(nextTaskRevisionProjection(attemptEvent(OPENING), 7)).not.toBeNull();
  });

  it("requires the whole identity set, and a partial set is no attempt at all", () => {
    // Each of the four keys the row cannot be built without, removed in turn. A
    // fold that accepted three of four would mint a row with a field it
    // invented, and there is nothing to invent an invocation from.
    for (const missing of [
      "revisionNumber",
      "attemptNumber",
      "invocationId",
      "legacyAttemptNumber",
    ]) {
      const partial = Object.fromEntries(
        Object.entries(OPENING).filter(([key]) => key !== missing),
      );
      expect(nextTaskAttemptProjection(attemptEvent(partial), 7), missing).toBeNull();
    }

    // A key of the wrong shape is the same as a key absent.
    for (const bad of [0, -1, 1.5, "4", null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        nextTaskAttemptProjection(
          attemptEvent({ ...OPENING, legacyAttemptNumber: bad }),
          7,
        ),
        JSON.stringify(bad),
      ).toBeNull();
    }
    for (const bad of ["", 1, null]) {
      expect(
        nextTaskAttemptProjection(attemptEvent({ ...OPENING, invocationId: bad }), 7),
        JSON.stringify(bad),
      ).toBeNull();
    }
  });

  it("takes every field from the event, and is born open", () => {
    const row = nextTaskAttemptProjection(attemptEvent(OPENING), 42);
    expect(row).toEqual({
      // The task is the EVENT's, so a payload cannot open another task's
      // attempt — the same structural binding the revision and route rows have.
      taskId: ATTEMPT_TASK,
      revisionNumber: 2,
      attemptNumber: 1,
      legacyAttemptNumber: 4,
      invocationId: "inv-0001",
      // `occurredAt`, never a clock: the fold is a pure function of the stream,
      // which is what makes two rebuilds of one ledger identical.
      startedAt: "2026-09-12T09:00:00.000Z",
      // No closer in this escalón (ADR 0073). Every row is born NULL/NULL, and
      // `ck_task_attempt_read_model__outcome_pair` is what keeps a later writer
      // from recording half of an ending.
      endedAt: null,
      outcome: null,
      sequence: 42,
    });

    // A payload naming another task is ignored on that point: `taskId` is not
    // a key of the attempt record at all.
    const foreign = nextTaskAttemptProjection(
      attemptEvent({ ...OPENING, taskId: "6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f01" }),
      42,
    );
    expect(foreign?.taskId).toBe(ATTEMPT_TASK);

    // And an `endedAt` in the payload is not a key either: this fold has no
    // closer to read one with, so a payload claiming one changes nothing.
    const claiming = nextTaskAttemptProjection(
      attemptEvent({ ...OPENING, endedAt: "2026-09-12T10:00:00.000Z", outcome: "SUCCEEDED" }),
      42,
    );
    expect([claiming?.endedAt, claiming?.outcome]).toEqual([null, null]);
  });

  it("compares what the attempt IS, not the arrival that recorded it", () => {
    // `canonicalRevision`'s argument, applied to two fields instead of three.
    // The coordinate is the key both callers look the row up by; `sequence` and
    // `startedAt` record the arrival, and an exact replay landing later with
    // its own instant is the SAME attempt.
    const born = nextTaskAttemptProjection(attemptEvent(OPENING), 10);
    const replayed = nextTaskAttemptProjection(
      attemptEvent(OPENING, { occurredAt: "2026-09-12T17:45:00.000Z" }),
      44,
    );
    expect(born?.startedAt).not.toBe(replayed?.startedAt);
    expect(canonicalAttempt(born!)).toBe(canonicalAttempt(replayed!));

    // And the two that ARE the identity each still separate it. These are the
    // refusals the comparison preserves: two answers to "which run was this".
    expect(canonicalAttempt({ ...born!, invocationId: "inv-other" })).not.toBe(
      canonicalAttempt(born!),
    );
    expect(canonicalAttempt({ ...born!, legacyAttemptNumber: 9 })).not.toBe(
      canonicalAttempt(born!),
    );
  });

  it("refuses, in the snapshot, the two histories the append door refuses", () => {
    // The snapshot fold IS the rebuild's fold — `rebuildReadModel` reaches it
    // through `#replay` — so this is where a rebuild's refusals are decided.
    // Drilled here at the definition as well as through a real rebuild in the
    // ledger's own suite, because a second definition of "same attempt" is what
    // would let a rebuild disagree with the door about which ledgers are
    // writable.
    const key = taskAttemptKey(ATTEMPT_TASK, 2, 1);

    // Two invocations at one coordinate.
    const first = createProjectionSnapshot();
    applyEventToSnapshot(first, attemptEvent(OPENING), 1, EVENT_SHA256);
    expect(first.taskAttempts.get(key)?.invocationId).toBe("inv-0001");
    expect(() => {
      applyEventToSnapshot(
        first,
        attemptEvent({ ...OPENING, invocationId: "inv-0002" }, { transitionId: "again" }),
        2,
        EVENT_SHA256,
      );
    }).toThrow(/already recorded with a different identity/);

    // One flat assignment across two coordinates. `UNIQUE (task_id,
    // legacy_attempt_number)` would abort on it in the base; the snapshot
    // refuses it first and names the coordinate that already holds the claim.
    const second = createProjectionSnapshot();
    applyEventToSnapshot(second, attemptEvent(OPENING), 1, EVENT_SHA256);
    expect(() => {
      applyEventToSnapshot(
        second,
        attemptEvent(
          { ...OPENING, attemptNumber: 2, invocationId: "inv-0002" },
          { transitionId: "a2" },
        ),
        2,
        EVENT_SHA256,
      );
    }).toThrow(new RegExp("claims legacy " + ATTEMPT_TASK + " 4, which attempt " + key));

    // One invocation across two coordinates, which is the other half of the
    // bijection and the other unique index.
    const third = createProjectionSnapshot();
    applyEventToSnapshot(third, attemptEvent(OPENING), 1, EVENT_SHA256);
    expect(() => {
      applyEventToSnapshot(
        third,
        attemptEvent(
          { ...OPENING, attemptNumber: 2, legacyAttemptNumber: 5 },
          { transitionId: "a2" },
        ),
        2,
        EVENT_SHA256,
      );
    }).toThrow(/claims invocation inv-0001/);
  });

  it("folds an exact replay of one opening to nothing, and a second coordinate to a row", () => {
    // The branch the refusals above are measured against: without it, every
    // assertion there would be satisfied by a fold that refused everything.
    const snapshot = createProjectionSnapshot();
    applyEventToSnapshot(snapshot, attemptEvent(OPENING), 1, EVENT_SHA256);
    applyEventToSnapshot(snapshot, attemptEvent(OPENING, { transitionId: "replay" }), 2, EVENT_SHA256);
    expect(snapshot.taskAttempts.size).toBe(1);
    // The FIRST arrival's row is kept, birth attributes and all.
    expect(snapshot.taskAttempts.get(taskAttemptKey(ATTEMPT_TASK, 2, 1))?.sequence).toBe(1);

    applyEventToSnapshot(
      snapshot,
      attemptEvent(
        { ...OPENING, attemptNumber: 2, invocationId: "inv-0002", legacyAttemptNumber: 5 },
        { transitionId: "a2", attempt: 5 },
      ),
      3,
      EVENT_SHA256,
    );
    expect(snapshot.taskAttempts.size).toBe(2);
    expect([...snapshot.taskAttempts.values()].map((row) => row.legacyAttemptNumber)).toEqual([
      4, 5,
    ]);
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo C — the four identity functions, and the three new folds
//
// The digests are asserted as ENCODINGS, not merely as self-consistent
// functions, for `envelope-identity`'s reason: an identity computed one way
// today and another way tomorrow identifies nothing, and a careless encoder
// round-trips perfectly while being wrong about the prefix and the field order.
// ---------------------------------------------------------------------------

const EFFECT_TASK = "8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c01";
const EFFECT_ENVELOPE = "e".repeat(64);

/** One event of a given type, with a payload, in the V2 form these folds need. */
function executionEvent(
  type: ControlPlaneEvent["type"],
  payload: Record<string, unknown>,
  overrides: Partial<ControlPlaneEvent> = {},
): ControlPlaneEvent {
  const transitionId = "step-effect";
  const revisionNumber = payload["revisionNumber"];
  const attemptNumber = payload["attemptNumber"];
  const v2 = typeof revisionNumber === "number" && typeof attemptNumber === "number";
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: "00000001-0000-4000-8000-000000000000",
    taskId: EFFECT_TASK,
    attempt: 1,
    transitionId,
    idempotencyKey: v2
      ? buildV2IdempotencyKey({
          stream: "control_plane_events",
          taskId: EFFECT_TASK,
          revisionNumber,
          attemptNumber,
          transitionId,
        })
      : buildIdempotencyKey({ taskId: EFFECT_TASK, attempt: 1, transitionId }),
    type,
    fromState: "DISCOVERED",
    toState: "DISCOVERED",
    emittedBy: EMITTED_BY,
    occurredAt: "2026-09-12T09:00:00.000Z",
    recordedAt: "2026-09-12T09:00:01.000Z",
    correlationId: null,
    causationId: null,
    payload,
    ...overrides,
  } as ControlPlaneEvent;
}

/** A complete, lawful segment record. */
function segment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    routeSegmentId: "seg-1",
    segmentNumber: 1,
    provider: "anthropic",
    model: "claude-opus-5",
    modelResolutionStatus: "RESOLVED",
    modelVersionId: "claude-opus-5-20260101",
    accountId: "acct-1",
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "policy-1",
    ...overrides,
  };
}

describe("the effect's identity is one encoding, frozen (execution §6, ADR 0076)", () => {
  const coordinate = {
    taskId: EFFECT_TASK,
    revisionNumber: 2,
    attemptNumber: 3,
    segmentNumber: 4,
    operationOrdinal: 5,
  } as const;

  it("carries its version prefix, with the LF inside it and no separator after", () => {
    // `ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1`'s rule, applied to both prefixes.
    // One LF, and it belongs to the prefix: a formula that added a second would
    // be a different byte string and every vector below would move.
    for (const prefix of [
      EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1,
      EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1,
    ]) {
      expect(prefix).toMatch(/^acp\/[a-z-]+\/v1\n$/);
      const bytes = Buffer.from(prefix, "utf8");
      expect(bytes[bytes.length - 1]).toBe(0x0a);
      expect(bytes.filter((byte) => byte === 0x0a)).toHaveLength(1);
    }
    expect(EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1).toBe("acp/execution-effect/v1\n");
    expect(EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1).toBe(
      "acp/execution-effect-idempotency/v1\n",
    );

    const preimage = effectIdPreimageV1(coordinate);
    expect(preimage.startsWith(EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1)).toBe(true);
    // The first byte after the LF is `[`, the start of the canonical array —
    // which is what "no separator between the two" means in bytes.
    expect(preimage.charAt(EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1.length)).toBe("[");
  });

  it("puts exactly the quintuple in the preimage, in the dictionary's order", () => {
    expect(effectIdPreimageV1(coordinate)).toBe(
      EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1 +
        JSON.stringify([EFFECT_TASK, 2, 3, 4, 5]),
    );
    expect(effectIdempotencyPreimageV1({ ...coordinate, effectKind: "k", envelopeSha256: EFFECT_ENVELOPE })).toBe(
      EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1 +
        JSON.stringify(["k", EFFECT_TASK, 2, 3, 4, 5, EFFECT_ENVELOPE]),
    );

    // Every member moves the digest. Written as a loop over the coordinate's
    // own keys rather than as five assertions, so a member added later is
    // covered the day it is added.
    const baseline = effectIdV1(coordinate);
    for (const key of ["revisionNumber", "attemptNumber", "segmentNumber", "operationOrdinal"] as const) {
      expect(effectIdV1({ ...coordinate, [key]: coordinate[key] + 1 }), key).not.toBe(baseline);
    }
    expect(effectIdV1({ ...coordinate, taskId: EFFECT_TASK.replace("01", "02") })).not.toBe(baseline);

    // And the clock is NOT a member, which is what makes a replay reproduce
    // the bytes (datos §6.3).
    expect(effectIdV1(coordinate)).toBe(baseline);
  });

  it("is sha-256 of the preimage and of nothing else", () => {
    expect(effectIdV1(coordinate)).toBe(
      createHash("sha256").update(effectIdPreimageV1(coordinate), "utf8").digest("hex"),
    );
    const key = { ...coordinate, effectKind: "model_execution", envelopeSha256: EFFECT_ENVELOPE };
    expect(effectIdempotencyKeyV1(key)).toBe(
      createHash("sha256").update(effectIdempotencyPreimageV1(key), "utf8").digest("hex"),
    );
  });

  it("computes §6.1's two digests exactly as the dictionary writes them", () => {
    // These two are not prefixed: their preimages are given verbatim by
    // execution §6.1 `:284-290`, with the versioned tag inside the array. A
    // second discriminator would be a second encoding of a written formula.
    expect(
      logicalOperationSha256({
        invocationId: "inv-1",
        semanticScopeKey: "run",
        localOperationKey: "compose",
      }),
    ).toBe(
      createHash("sha256")
        .update(
          JSON.stringify(["execution-logical-operation", 1, "inv-1", "run", "compose"]),
          "utf8",
        )
        .digest("hex"),
    );

    expect(
      requestSha256({
        effectKind: "model_execution",
        requestContractVersion: "1",
        envelopeSha256: EFFECT_ENVELOPE,
        neutralRequest: { b: 2, a: 1 },
      }),
    ).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            "execution-logical-request",
            1,
            "model_execution",
            "1",
            EFFECT_ENVELOPE,
            { a: 1, b: 2 },
          ]),
          "utf8",
        )
        .digest("hex"),
    );

    // The request is canonicalized, so two spellings of one request are one
    // digest — which is what makes "the same work again" decidable at all.
    expect(
      requestSha256({
        effectKind: "model_execution",
        requestContractVersion: "1",
        envelopeSha256: EFFECT_ENVELOPE,
        neutralRequest: { a: 1, b: 2 },
      }),
    ).toBe(
      requestSha256({
        effectKind: "model_execution",
        requestContractVersion: "1",
        envelopeSha256: EFFECT_ENVELOPE,
        neutralRequest: { b: 2, a: 1 },
      }),
    );
  });

  it("pinned vectors: two keys, written out", () => {
    // Literals, not derivations. The only test here that fails when the
    // encoding changes while staying internally consistent.
    expect(effectIdV1(coordinate)).toBe(
      "34dc237e768abad1ac6a6500af9b4152c1d6d924a84cbcf8cafcb89c2c560419",
    );
    expect(
      effectIdempotencyKeyV1({
        ...coordinate,
        effectKind: "model_execution",
        envelopeSha256: EFFECT_ENVELOPE,
      }),
    ).toBe("780301cc3c50533fdd54c892fde90b01632660c3a51a728b348ded6ecb436d6f");
  });
});

describe("the three P-18/protocolo C folds are gated and total (execution §4, §6, §7)", () => {
  it("projects a segment only from the two intention types", () => {
    const payload = { revisionNumber: 1, attemptNumber: 1, segment: segment() };
    expect(nextExecutionRouteSegmentProjection(executionEvent("EFFECT_INTENDED", payload), 1))
      .not.toBeNull();
    expect(nextExecutionRouteSegmentProjection(executionEvent("DISPATCH_INTENDED", payload), 1))
      .not.toBeNull();

    // A stray event carrying the key announces nothing. The type gate is the
    // attempt opening's, and it is what keeps an unrelated arrival from
    // claiming a route the run never took.
    for (const type of ["TASK_DISCOVERED", "TOOL_CALL_RECORDED", "DISPATCH_OUTCOME_RECORDED"] as const) {
      expect(
        nextExecutionRouteSegmentProjection(executionEvent(type, payload), 1),
        type,
      ).toBeNull();
    }
  });

  it("projects no segment from an incomplete or self-contradicting record", () => {
    const wrap = (record: Record<string, unknown> | undefined): ControlPlaneEvent =>
      executionEvent("EFFECT_INTENDED", {
        revisionNumber: 1,
        attemptNumber: 1,
        ...(record === undefined ? {} : { segment: record }),
      });

    // Absent, and not an object.
    expect(nextExecutionRouteSegmentProjection(wrap(undefined), 1)).toBeNull();
    expect(
      nextExecutionRouteSegmentProjection(
        executionEvent("EFFECT_INTENDED", { revisionNumber: 1, attemptNumber: 1, segment: [] }),
        1,
      ),
    ).toBeNull();

    // Missing one required field at a time.
    for (const key of [
      "routeSegmentId",
      "segmentNumber",
      "provider",
      "model",
      "modelResolutionStatus",
      "transportKind",
      "capabilityPolicyVersion",
    ]) {
      const record = Object.fromEntries(
        Object.entries(segment()).filter(([name]) => name !== key),
      );
      expect(nextExecutionRouteSegmentProjection(wrap(record), 1), key).toBeNull();
    }

    // And each pairing rule of §4, in both directions.
    expect(
      nextExecutionRouteSegmentProjection(wrap(segment({ predecessorSegmentId: "seg-0" })), 1),
    ).toBeNull();
    expect(
      nextExecutionRouteSegmentProjection(wrap(segment({ handoffReason: "QUOTA" })), 1),
    ).toBeNull();
    expect(
      nextExecutionRouteSegmentProjection(
        wrap(segment({ modelResolutionStatus: "UNKNOWN" })),
        1,
      ),
    ).toBeNull();
    expect(
      nextExecutionRouteSegmentProjection(
        wrap(segment({ modelResolutionStatus: "NOT_OBSERVABLE", modelVersionId: undefined })),
        1,
      ),
    ).not.toBeNull();
    expect(
      nextExecutionRouteSegmentProjection(wrap(segment({ escalationReason: "TIMEOUT" })), 1),
    ).toBeNull();

    // A vocabulary word outside the closed set is not a status.
    expect(
      nextExecutionRouteSegmentProjection(
        wrap(segment({ modelResolutionStatus: "PROBABLY" })),
        1,
      ),
    ).toBeNull();
  });

  it("takes the coordinate from the event and the instants from the event", () => {
    const row = nextExecutionRouteSegmentProjection(
      executionEvent("EFFECT_INTENDED", {
        revisionNumber: 2,
        attemptNumber: 3,
        segment: segment({ segmentNumber: 2, predecessorSegmentId: "seg-1", handoffReason: "Q" }),
      }),
      11,
    );
    // A payload cannot announce another task's segment: the task is the
    // EVENT's, exactly as the revision record's is.
    expect(row?.taskId).toBe(EFFECT_TASK);
    expect(row?.revisionNumber).toBe(2);
    expect(row?.attemptNumber).toBe(3);
    expect(row?.recordedAt).toBe("2026-09-12T09:00:01.000Z");
    expect(row?.sequence).toBe(11);
    // The four columns with no producer in this build are `null`, declared
    // rather than accidental.
    expect(row?.routingAssignmentId).toBeNull();
    expect(row?.reservationId).toBeNull();
    expect(row?.escalatedFromAttempt).toBeNull();
    expect(row?.escalationReason).toBeNull();
  });

  it("projects an effect only from its own type, and a delivery only from its own", () => {
    const effectPayload = {
      revisionNumber: 1,
      attemptNumber: 1,
      segment: segment(),
      effect: {
        effectId: "a".repeat(64),
        operationOrdinal: 0,
        effectKind: "model_execution",
        semanticScopeKey: "run",
        localOperationKey: "compose",
        logicalOperationSha256: "b".repeat(64),
        requestContractVersion: "1",
        requestSha256: "c".repeat(64),
        idempotencyKey: "d".repeat(64),
      },
    };
    const effect = nextEffectProjection(executionEvent("EFFECT_INTENDED", effectPayload), 4);
    expect(effect?.effectId).toBe("a".repeat(64));
    // Born on the segment this same event announced, and born without an
    // outcome: absence of data, never `OUTCOME_UNKNOWN` (N-P18-6).
    expect(effect?.routeSegmentId).toBe("seg-1");
    expect(effect?.outcomeStatus).toBeNull();
    expect(effect?.outcomeRecordedAt).toBeNull();
    // `intendedAt` is the instant of the transaction that recorded the
    // intention (§6 `:251`) — the event's `occurredAt`, never a clock read.
    expect(effect?.intendedAt).toBe("2026-09-12T09:00:00.000Z");
    expect(nextEffectProjection(executionEvent("DISPATCH_INTENDED", effectPayload), 4)).toBeNull();

    // An effect whose event carries no well-formed segment projects no row:
    // there would be nothing for its foreign key to name.
    const orphan = { ...effectPayload, segment: segment({ provider: undefined }) };
    expect(nextEffectProjection(executionEvent("EFFECT_INTENDED", orphan), 4)).toBeNull();

    const dispatchPayload = {
      revisionNumber: 1,
      attemptNumber: 1,
      segment: segment(),
      dispatch: { dispatchAttemptId: "dsp-1", effectId: "a".repeat(64), attemptOrdinal: 1, catalogDocumentId: "catalog-fixture", catalogVersion: 1 },
    };
    const dispatch = nextDispatchAttemptProjection(
      executionEvent("DISPATCH_INTENDED", dispatchPayload),
      6,
    );
    // Born INTENDED, with the three externally sourced fields null: recording
    // that a delivery is about to happen is an append, not a dispatch.
    expect(dispatch?.dispatchState).toBe("INTENDED");
    expect(dispatch?.acceptedAt).toBeNull();
    expect(dispatch?.externalHandle).toBeNull();
    expect(dispatch?.providerIdempotencyKey).toBeNull();
    expect(dispatch?.terminalAt).toBeNull();
    expect(
      nextDispatchAttemptProjection(executionEvent("EFFECT_INTENDED", dispatchPayload), 6),
    ).toBeNull();
  });

  it("reads a resolution only when the terminal pair agrees", () => {
    const wrap = (record: Record<string, unknown>): ControlPlaneEvent =>
      executionEvent("DISPATCH_OUTCOME_RECORDED", {
        revisionNumber: 1,
        attemptNumber: 1,
        outcome: record,
      });

    const claimed = dispatchOutcomeRecord(wrap({ dispatchAttemptId: "dsp-1", dispatchState: "CLAIMED" }), 1);
    expect(claimed?.kind === "record" ? claimed.record.dispatchState : null).toBe("CLAIMED");

    // A terminal state needs its instant, and a non-terminal state may not
    // carry one. Both halves, because half a fact is the failure the pair
    // exists to prevent.
    expect(
      dispatchOutcomeRecord(wrap({ dispatchAttemptId: "dsp-1", dispatchState: "SETTLED" }), 1),
    ).toBeNull();
    expect(
      dispatchOutcomeRecord(
        wrap({ dispatchAttemptId: "dsp-1", dispatchState: "CLAIMED", terminalAt: "2026-09-12T09:00:00.000Z" }),
        1,
      ),
    ).toBeNull();

    // `RECONCILING` is not one of the five, so it is not a state at all here.
    expect(
      dispatchOutcomeRecord(wrap({ dispatchAttemptId: "dsp-1", dispatchState: "RECONCILING" }), 1),
    ).toBeNull();
  });

  it("admits every forward move of §7 and no other", () => {
    // The five states, as a matrix. Written as the full cross product rather
    // than as a handful of cases, so a transition added by mistake fails here.
    const forward: Record<string, readonly string[]> = {
      INTENDED: ["CLAIMED", "INFLIGHT", "SETTLED", "ABANDONED"],
      CLAIMED: ["INFLIGHT", "SETTLED", "ABANDONED"],
      INFLIGHT: ["SETTLED", "ABANDONED"],
      SETTLED: [],
      ABANDONED: [],
    };
    for (const from of DISPATCH_STATES) {
      for (const to of DISPATCH_STATES) {
        expect(dispatchTransitionAdmitted(from, to), from + " -> " + to).toBe(
          (forward[from] ?? []).includes(to),
        );
      }
    }
    // Including the diagonal: a repetition is not a move, and is handled a rung
    // up as a replay so this predicate answers exactly one question.
    for (const state of DISPATCH_STATES) {
      expect(dispatchTransitionAdmitted(state, state), state).toBe(false);
    }
  });

  it("folds the cohort into the snapshot, refusing what the base would refuse", () => {
    const snapshot = createProjectionSnapshot();
    const effectPayload = {
      revisionNumber: 1,
      attemptNumber: 1,
      segment: segment(),
      effect: {
        effectId: "a".repeat(64),
        operationOrdinal: 0,
        effectKind: "model_execution",
        semanticScopeKey: "run",
        localOperationKey: "compose",
        logicalOperationSha256: "b".repeat(64),
        requestContractVersion: "1",
        requestSha256: "c".repeat(64),
        idempotencyKey: "d".repeat(64),
      },
    };
    applyEventToSnapshot(snapshot, executionEvent("EFFECT_INTENDED", effectPayload), 1, EVENT_SHA256);
    expect(snapshot.routeSegments.size).toBe(1);
    expect(snapshot.effects.size).toBe(1);

    // A second effect claiming the same logical key is refused at the event
    // that caused it, rather than reaching
    // `ux_effect_read_model__logical_operation_sha256` as an abort naming one
    // row and no event.
    const twin = {
      ...effectPayload,
      segment: segment({ routeSegmentId: "seg-2", segmentNumber: 2, predecessorSegmentId: "seg-1", handoffReason: "Q" }),
      effect: { ...effectPayload.effect, effectId: "e".repeat(64), operationOrdinal: 1 },
    };
    expect(() => {
      applyEventToSnapshot(snapshot, executionEvent("EFFECT_INTENDED", twin), 2, EVENT_SHA256);
    }).toThrow(LedgerValidationError);

    // A resolution for a delivery nobody intended is refused too, which is what
    // keeps a rebuild from writing a state onto a row that is not there.
    expect(() => {
      applyEventToSnapshot(
        snapshot,
        executionEvent("DISPATCH_OUTCOME_RECORDED", {
          revisionNumber: 1,
          attemptNumber: 1,
          outcome: { dispatchAttemptId: "nowhere", dispatchState: "CLAIMED" },
        }),
        3,
        EVENT_SHA256,
      );
    }).toThrow(LedgerValidationError);
  });

  it("N-C-11: the fold refuses a resolution recorded at another attempt's coordinate, by name", () => {
    // The mirror of the append door's anchor. A delivery is found by a global
    // id, so without this a rebuild would fold a resolution of task B onto task
    // A's delivery exactly as the door once admitted it, and `verifyIntegrity`
    // would find the two paths in perfect agreement about the wrong history.
    const snapshot = createProjectionSnapshot();
    const effectId = "a".repeat(64);
    applyEventToSnapshot(
      snapshot,
      executionEvent("EFFECT_INTENDED", {
        revisionNumber: 1,
        attemptNumber: 1,
        segment: segment(),
        effect: {
          effectId,
          operationOrdinal: 0,
          effectKind: "model_execution",
          semanticScopeKey: "run",
          localOperationKey: "compose",
          logicalOperationSha256: "b".repeat(64),
          requestContractVersion: "1",
          requestSha256: "c".repeat(64),
          idempotencyKey: "d".repeat(64),
        },
      }),
      1,
      EVENT_SHA256,
    );
    applyEventToSnapshot(
      snapshot,
      executionEvent("DISPATCH_INTENDED", {
        revisionNumber: 1,
        attemptNumber: 1,
        segment: segment(),
        dispatch: { dispatchAttemptId: "dsp-1", effectId, attemptOrdinal: 1, catalogDocumentId: "catalog-fixture", catalogVersion: 1 },
      }),
      2,
      EVENT_SHA256,
    );

    const settle = (payload: Record<string, unknown>): Record<string, unknown> => ({
      ...payload,
      outcome: {
        dispatchAttemptId: "dsp-1",
        dispatchState: "SETTLED",
        terminalAt: "2026-09-12T09:10:00.000Z",
        effectOutcomeStatus: "SUCCEEDED",
        // A SUCCEEDED of the version in force names its result (ADR 0098); the
        // reader is pure, so the pair needs no registered artifact here.
        ...RESULT_PAIR,
      },
    });
    const foreignTask = "8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c02";
    const cases: readonly (readonly [string, ControlPlaneEvent, string])[] = [
      [
        "another task",
        executionEvent(
          "DISPATCH_OUTCOME_RECORDED",
          settle({ revisionNumber: 1, attemptNumber: 1 }),
          { taskId: foreignTask },
        ),
        "attempt " + foreignTask + " 1 1",
      ],
      [
        "another revision",
        executionEvent("DISPATCH_OUTCOME_RECORDED", settle({ revisionNumber: 2, attemptNumber: 1 })),
        "attempt " + EFFECT_TASK + " 2 1",
      ],
      [
        "another attempt",
        executionEvent("DISPATCH_OUTCOME_RECORDED", settle({ revisionNumber: 1, attemptNumber: 2 })),
        "attempt " + EFFECT_TASK + " 1 2",
      ],
      [
        "no coordinate",
        executionEvent("DISPATCH_OUTCOME_RECORDED", settle({})),
        "no coordinate at all",
      ],
    ];

    for (const [label, event, recordedAt] of cases) {
      let issue: { readonly path: string; readonly message: string } | undefined;
      try {
        applyEventToSnapshot(snapshot, event, 3, EVENT_SHA256);
      } catch (error) {
        issue = (error as LedgerValidationError).issues[0];
      }
      expect(issue?.path, label).toBe("payload.outcome.dispatchAttemptId");
      expect(issue?.message, label).toContain("dsp-1");
      expect(issue?.message, label).toContain(effectId);
      expect(issue?.message, label).toContain(EFFECT_TASK + " 1 1");
      expect(issue?.message, label).toContain(recordedAt);
    }

    // Nothing moved: the delivery is still intended and the effect has no outcome.
    expect(snapshot.dispatchAttempts.get("dsp-1")?.dispatchState).toBe("INTENDED");
    expect(snapshot.effects.get(effectId)?.outcomeStatus).toBeNull();

    // And the owner's own coordinate still resolves it.
    applyEventToSnapshot(
      snapshot,
      executionEvent("DISPATCH_OUTCOME_RECORDED", settle({ revisionNumber: 1, attemptNumber: 1 })),
      3,
      EVENT_SHA256,
    );
    expect(snapshot.dispatchAttempts.get("dsp-1")?.dispatchState).toBe("SETTLED");
    expect(snapshot.effects.get(effectId)?.outcomeStatus).toBe("SUCCEEDED");
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo D — the occurrence readers and folds (execution §8)
// ---------------------------------------------------------------------------

const OCCURRENCE_EFFECT = "a".repeat(64);

/** A lawful prompt occurrence payload, with the V2 coordinate beside the record. */
function promptPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revisionNumber: 1,
    attemptNumber: 1,
    promptOccurrence: {
      occurrenceId: "po-1",
      dispatchAttemptId: "dsp-1",
      effectId: OCCURRENCE_EFFECT,
      routeSegmentId: "seg-1",
      ordinal: 0,
      requestedModelId: "claude-opus-5",
      provider: "anthropic",
      modelResolutionStatus: "RESOLVED",
      modelVersionId: "claude-opus-5-20260101",
      accountId: "acct-1",
      promptSha256: "c".repeat(64),
      promptBytes: 12,
      ...overrides,
    },
  };
}

/** A lawful response occurrence payload. */
function responsePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revisionNumber: 1,
    attemptNumber: 1,
    responseOccurrence: {
      occurrenceId: "ro-1",
      promptOccurrenceId: "po-1",
      responseSha256: "d".repeat(64),
      responseBytes: 34,
      redactionVerdict: "CLEAN",
      ...overrides,
    },
  };
}

/** A snapshot holding one effect on `seg-1` and its delivery `dsp-1`. */
function snapshotWithDelivery(): ReturnType<typeof createProjectionSnapshot> {
  const snapshot = createProjectionSnapshot();
  applyEventToSnapshot(
    snapshot,
    executionEvent("EFFECT_INTENDED", {
      revisionNumber: 1,
      attemptNumber: 1,
      segment: segment(),
      effect: {
        effectId: OCCURRENCE_EFFECT,
        operationOrdinal: 0,
        effectKind: "model_execution",
        semanticScopeKey: "run",
        localOperationKey: "compose",
        logicalOperationSha256: "b".repeat(64),
        requestContractVersion: "1",
        requestSha256: "c".repeat(64),
        idempotencyKey: "d".repeat(64),
      },
    }),
    1,
    EVENT_SHA256,
  );
  applyEventToSnapshot(
    snapshot,
    executionEvent("DISPATCH_INTENDED", {
      revisionNumber: 1,
      attemptNumber: 1,
      segment: segment(),
      dispatch: { dispatchAttemptId: "dsp-1", effectId: OCCURRENCE_EFFECT, attemptOrdinal: 1, catalogDocumentId: "catalog-fixture", catalogVersion: 1 },
    }),
    2,
    EVENT_SHA256,
  );
  return snapshot;
}

describe("the occurrence readers are gated, closed and total (execution §8)", () => {
  it("reads nothing for any other type, and reads a row off each of its own", () => {
    expect(readPromptOccurrence(executionEvent("TASK_ATTEMPT_OPENED", promptPayload()), 1)).toBeNull();
    expect(
      readResponseOccurrence(executionEvent("PROMPT_OCCURRENCE_RECORDED", responsePayload()), 1),
    ).toBeNull();

    const prompt = nextPromptOccurrenceProjection(
      executionEvent("PROMPT_OCCURRENCE_RECORDED", promptPayload()),
      9,
    );
    // `identity` is `emittedBy`; `recordedAt` is the event's; an absent context
    // digest is null; the sequence is the fold's.
    expect(prompt).toMatchObject({
      occurrenceId: "po-1",
      identity: EMITTED_BY,
      recordedAt: "2026-09-12T09:00:01.000Z",
      contextSha256: null,
      sequence: 9,
    });
    expect(
      nextResponseOccurrenceProjection(
        executionEvent("RESPONSE_OCCURRENCE_RECORDED", responsePayload()),
        10,
      ),
    ).toMatchObject({ occurrenceId: "ro-1", promptOccurrenceId: "po-1", sequence: 10 });
  });

  it("declares a closed record for each type, and the answer's names no delivery, segment or account", () => {
    expect([...RESPONSE_OCCURRENCE_RECORD_KEYS].sort()).toEqual([
      "occurrenceId",
      "promptOccurrenceId",
      "redactionVerdict",
      "responseBytes",
      "responseSha256",
    ]);
    for (const key of ["dispatchAttemptId", "routeSegmentId", "accountId"]) {
      expect(RESPONSE_OCCURRENCE_RECORD_KEYS as readonly string[], key).not.toContain(key);
    }
    expect(PROMPT_OCCURRENCE_RECORD_KEYS as readonly string[]).not.toContain("identity");
  });

  it("is total: every single-field corruption reads as a named refusal, never as a row or a throw", () => {
    // The readers are the one authority on what an occurrence payload is, so a
    // corruption anywhere must come back as `refused` with a path under the
    // record — the door throws it, the fold projects nothing.
    const ABSENT = Symbol("absent");
    // None of these is lawful for any field, except absence for the one optional
    // digest — a plain word is left out because it is a lawful id.
    const corruptions: readonly unknown[] = [ABSENT, null, "", -1, 1.5, {}, [], true];
    forAll(
      "prompt occurrence corruption",
      0x18d,
      ITERATIONS,
      (random) => ({
        field: pick(random, PROMPT_OCCURRENCE_RECORD_KEYS),
        value: pick(random, corruptions),
      }),
      ({ field, value }) => {
        const lawful = promptPayload()["promptOccurrence"] as Record<string, unknown>;
        const record = Object.fromEntries(
          Object.entries({ ...lawful, [field]: value }).filter(([, entry]) => entry !== ABSENT),
        );
        const payload = { revisionNumber: 1, attemptNumber: 1, promptOccurrence: record };
        const reading = readPromptOccurrence(executionEvent("PROMPT_OCCURRENCE_RECORDED", payload), 1);
        expect(reading).not.toBeNull();
        if (reading?.kind === "row") {
          // Only the context digest may lawfully be absent or null here:
          // `modelVersionId` is optional too, but this payload is `RESOLVED`.
          expect(["contextSha256"]).toContain(field);
          expect(value === ABSENT || value === null).toBe(true);
        } else {
          expect(reading?.path.startsWith("payload.promptOccurrence.")).toBe(true);
        }
      },
    );
  });

  it("refuses a stray key beside the record and inside it, naming the key", () => {
    const beside = readPromptOccurrence(
      executionEvent("PROMPT_OCCURRENCE_RECORDED", { ...promptPayload(), transcriptRef: "x" }),
      1,
    );
    expect(beside).toMatchObject({ kind: "refused", path: "payload.transcriptRef" });

    const inside = readResponseOccurrence(
      executionEvent("RESPONSE_OCCURRENCE_RECORDED", responsePayload({ accountId: "acct-2" })),
      1,
    );
    expect(inside).toMatchObject({ kind: "refused", path: "payload.responseOccurrence.accountId" });

    const noCoordinate = readResponseOccurrence(
      executionEvent("RESPONSE_OCCURRENCE_RECORDED", {
        responseOccurrence: (responsePayload()["responseOccurrence"] as Record<string, unknown>),
      }),
      1,
    );
    expect(noCoordinate).toMatchObject({ kind: "refused", path: "payload.revisionNumber" });
  });

  it("compares a prompt by what it is, not by when it arrived", () => {
    const at = (sequence: number, recordedAt: string): string =>
      canonicalPromptOccurrence(
        nextPromptOccurrenceProjection(
          executionEvent("PROMPT_OCCURRENCE_RECORDED", promptPayload(), { recordedAt }),
          sequence,
        )!,
      );
    expect(at(1, "2026-09-12T09:00:01.000Z")).toBe(at(7, "2026-09-12T11:00:00.000Z"));
    const otherSender = canonicalPromptOccurrence(
      nextPromptOccurrenceProjection(
        executionEvent("PROMPT_OCCURRENCE_RECORDED", promptPayload(), {
          emittedBy: "claude/opus/implementer/01",
        }),
        1,
      )!,
    );
    expect(otherSender).not.toBe(at(1, "2026-09-12T09:00:01.000Z"));
  });
});

describe("the occurrence folds refuse what the door refuses (execution §8)", () => {
  it("N-P18-16: folds a prompt that matches its delivery, and refuses one that does not", () => {
    const snapshot = snapshotWithDelivery();
    for (const [field, value] of [
      ["effectId", "f".repeat(64)],
      ["routeSegmentId", "seg-2"],
      ["dispatchAttemptId", "dsp-nowhere"],
    ] as const) {
      expect(() => {
        applyEventToSnapshot(
          snapshot,
          executionEvent("PROMPT_OCCURRENCE_RECORDED", promptPayload({ [field]: value })),
          3,
          EVENT_SHA256,
        );
      }, field).toThrow(LedgerValidationError);
    }
    expect(snapshot.promptOccurrences.size).toBe(0);

    applyEventToSnapshot(snapshot, executionEvent("PROMPT_OCCURRENCE_RECORDED", promptPayload()), 3, EVENT_SHA256);
    expect(snapshot.promptOccurrences.get("po-1")?.routeSegmentId).toBe("seg-1");
  });

  it("N-D-2 and N-D-3: one answer per prompt, and none to a prompt nobody recorded", () => {
    const snapshot = snapshotWithDelivery();
    expect(() => {
      applyEventToSnapshot(snapshot, executionEvent("RESPONSE_OCCURRENCE_RECORDED", responsePayload()), 3, EVENT_SHA256);
    }).toThrow(LedgerValidationError);

    applyEventToSnapshot(snapshot, executionEvent("PROMPT_OCCURRENCE_RECORDED", promptPayload()), 3, EVENT_SHA256);
    applyEventToSnapshot(snapshot, executionEvent("RESPONSE_OCCURRENCE_RECORDED", responsePayload()), 4, EVENT_SHA256);
    // The identical answer again is a replay and changes nothing.
    applyEventToSnapshot(snapshot, executionEvent("RESPONSE_OCCURRENCE_RECORDED", responsePayload()), 5, EVENT_SHA256);
    expect(snapshot.responseOccurrences.size).toBe(1);

    let issue: { readonly path: string; readonly message: string } | undefined;
    try {
      applyEventToSnapshot(
        snapshot,
        executionEvent("RESPONSE_OCCURRENCE_RECORDED", responsePayload({ occurrenceId: "ro-2" })),
        6,
        EVENT_SHA256,
      );
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.path).toBe("payload.responseOccurrence.promptOccurrenceId");
    expect(issue?.message).toContain("already answered by ro-1");
    expect(snapshot.responseOccurrences.size).toBe(1);
  });

  it("N-D-4: an answer recorded at another coordinate than its prompt's is refused", () => {
    const snapshot = snapshotWithDelivery();
    applyEventToSnapshot(snapshot, executionEvent("PROMPT_OCCURRENCE_RECORDED", promptPayload()), 3, EVENT_SHA256);
    let issue: { readonly path: string; readonly message: string } | undefined;
    try {
      applyEventToSnapshot(
        snapshot,
        executionEvent("RESPONSE_OCCURRENCE_RECORDED", { ...responsePayload(), attemptNumber: 2 }),
        4,
        EVENT_SHA256,
      );
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.path).toBe("payload.responseOccurrence.promptOccurrenceId");
    expect(issue?.message).toContain("attempt " + EFFECT_TASK + " 1 2");
    expect(snapshot.responseOccurrences.size).toBe(0);
  });

  it("P-D-2: no fold derives an occurrence from an intention or a resolution", () => {
    const snapshot = snapshotWithDelivery();
    applyEventToSnapshot(
      snapshot,
      executionEvent("DISPATCH_OUTCOME_RECORDED", {
        revisionNumber: 1,
        attemptNumber: 1,
        outcome: {
          dispatchAttemptId: "dsp-1",
          dispatchState: "SETTLED",
          terminalAt: "2026-09-12T09:10:00.000Z",
          effectOutcomeStatus: "SUCCEEDED",
          ...RESULT_PAIR,
        },
      }),
      3,
      EVENT_SHA256,
    );
    expect(snapshot.promptOccurrences.size).toBe(0);
    expect(snapshot.responseOccurrences.size).toBe(0);
    expect(snapshot.responseOccurrenceClaims.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo F — the outbox fold, as a pure function of stream events
// ---------------------------------------------------------------------------

const OUTBOX_TASK = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a0f";
const OUTBOX_SAGA = "5a6a7a8a-0000-4000-8000-000000000001";
const OUTBOX_WORKTREE = "/tmp/acp-p18f-worktree";
const OUTBOX_DEADLINE = "2026-09-12T12:00:00.000Z";
const OUTBOX_ATTEMPT_ONE = "6b6b6b6b-0000-4000-8000-000000000001";
const OUTBOX_ATTEMPT_TWO = "6b6b6b6b-0000-4000-8000-000000000002";

/** A task-stream event of any type at a given state, keyed V1. */
function outboxStreamEvent(
  type: ControlPlaneEvent["type"],
  transitionId: string,
  fromState: ControlPlaneEvent["toState"],
  toState: ControlPlaneEvent["toState"],
  payload: Record<string, unknown>,
): ControlPlaneEvent {
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: "00000000-0000-4000-8000-" + createHash("sha256").update(transitionId).digest("hex").slice(0, 12),
    taskId: OUTBOX_TASK,
    attempt: 1,
    transitionId,
    idempotencyKey: buildIdempotencyKey({ taskId: OUTBOX_TASK, attempt: 1, transitionId }),
    type,
    fromState,
    toState,
    emittedBy: EMITTED_BY,
    occurredAt: "2026-09-12T11:00:00.000Z",
    recordedAt: "2026-09-12T11:00:00.000Z",
    correlationId: null,
    causationId: null,
    payload,
  } as ControlPlaneEvent;
}

const REVOKE_COMMAND = computeOutboxCommandId({
  sagaId: OUTBOX_SAGA,
  phase: "QUARANTINE",
  targetKind: "WORKTREE_LEASE",
  targetId: OUTBOX_WORKTREE,
});

function intentionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outboxContractVersion: 1,
    sagaId: OUTBOX_SAGA,
    commandId: REVOKE_COMMAND,
    phase: "QUARANTINE",
    commandKind: "REVOKE_LEASE",
    intentStream: "control_plane_events",
    targetKind: "WORKTREE_LEASE",
    targetId: OUTBOX_WORKTREE,
    deadlineAt: OUTBOX_DEADLINE,
    fence: 1,
    targetStoreIncarnationId: "4c4c4c4c-0000-4000-8000-000000000001",
    ...overrides,
  };
}

/** Entries with digests that stand in for a chain: the fold compares, it does not hash. */
function entry(event: ControlPlaneEvent, sequence: number, causedBy: OutboxEventEntry | null = null): OutboxEventEntry {
  return {
    event,
    sequence,
    sha256: createHash("sha256").update(String(sequence)).digest("hex"),
    causation:
      causedBy === null
        ? null
        : { stream: "control_plane_events", sequence: causedBy.sequence, sha256: causedBy.sha256 },
  };
}

/** The lawful saga prefix: a quarantine, then the intention to revoke it. */
function quarantined(): { readonly entries: OutboxEventEntry[]; readonly intention: OutboxEventEntry } {
  const violation = entry(
    outboxStreamEvent("WRITE_SET_VIOLATION_DETECTED", "violation", "RUNNING", "RUNNING", {}),
    1,
  );
  const quarantine = entry(
    outboxStreamEvent("TASK_STATE_CHANGED", "quarantine", "RUNNING", "SUSPECT_WORKTREE", {}),
    2,
  );
  const intention = entry(
    outboxStreamEvent("OUTBOX_COMMAND_INTENDED", "intend", "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", intentionPayload()),
    3,
  );
  return { entries: [violation, quarantine, intention], intention };
}

function attemptEntry(sequence: number, attemptId: string, cause: OutboxEventEntry): OutboxEventEntry {
  return entry(
    outboxStreamEvent("OUTBOX_DELIVERY_INTENDED", "attempt-" + String(sequence), "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", {
      outboxContractVersion: 1,
      commandId: REVOKE_COMMAND,
      deliveryAttemptId: attemptId,
    }),
    sequence,
    cause,
  );
}

function observationEntry(
  sequence: number,
  attemptId: string,
  cause: OutboxEventEntry,
  outboxState: string,
  extra: Record<string, unknown> = {},
): OutboxEventEntry {
  return entry(
    outboxStreamEvent("OUTBOX_DELIVERY_OBSERVED", "observe-" + String(sequence), "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", {
      outboxContractVersion: 1,
      commandId: REVOKE_COMMAND,
      deliveryAttemptId: attemptId,
      outboxState,
      failureCode: null,
      responseHandle: null,
      ...extra,
    }),
    sequence,
    cause,
  );
}

function foldRefusal(entries: readonly OutboxEventEntry[]): { readonly path: string; readonly message: string } | null {
  try {
    foldOutboxCommands(entries);
    return null;
  } catch (error) {
    if (!(error instanceof LedgerValidationError)) throw error;
    return error.issues[0] ?? null;
  }
}

describe("the outbox command id is one encoding, frozen (coordination §6, ADR 0078)", () => {
  it("pins the preimage and the digest, and computes them independently", () => {
    const input = { sagaId: OUTBOX_SAGA, phase: "QUARANTINE", targetKind: "WORKTREE_LEASE", targetId: OUTBOX_WORKTREE };
    // A literal, computed twice before it was written down: by this package's
    // function, and by sha-256 over the prefix and a plain JSON array — which is
    // what canonical JSON is for an array of four strings.
    const preimage = OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1 + JSON.stringify([OUTBOX_SAGA, "QUARANTINE", "WORKTREE_LEASE", OUTBOX_WORKTREE]);
    expect(outboxCommandIdPreimageV1(input)).toBe(preimage);
    expect(computeOutboxCommandId(input)).toBe(createHash("sha256").update(preimage).digest("hex"));
    expect(computeOutboxCommandId(input)).toBe("ca70e879e173730c58efcdcd48b59619449b34d62e410b3f41e914f5445c0872");
  });

  it("N-F-2: the same quadruple is the same id, and any other member is another", () => {
    const base = { sagaId: OUTBOX_SAGA, phase: "QUARANTINE", targetKind: "WORKTREE_LEASE", targetId: OUTBOX_WORKTREE };
    expect(computeOutboxCommandId({ ...base })).toBe(computeOutboxCommandId(base));
    const others = [
      { ...base, sagaId: "5a6a7a8a-0000-4000-8000-000000000002" },
      { ...base, phase: "RELEASE" },
      { ...base, targetKind: "ACCOUNT_RESERVATION" },
      { ...base, targetId: "/tmp/another-worktree" },
    ];
    const ids = new Set([computeOutboxCommandId(base), ...others.map(computeOutboxCommandId)]);
    expect(ids.size).toBe(5);
  });
});

describe("the outbox reader is gated, closed and total (coordination §6.2)", () => {
  it("reads nothing for every other type, and a quarantine is one of two shapes", () => {
    expect(readOutboxEvent(outboxStreamEvent("TASK_READY", "ready", "DT_CLASSIFIED", "READY", {}))).toBeNull();
    expect(isQuarantineEvent({ type: "WRITE_SET_VIOLATION_DETECTED", toState: "RUNNING" })).toBe(true);
    expect(isQuarantineEvent({ type: "TASK_STATE_CHANGED", toState: "SUSPECT_WORKTREE" })).toBe(true);
    expect(isQuarantineEvent({ type: "TASK_STATE_CHANGED", toState: "FAILED" })).toBe(false);
    expect(isQuarantineEvent({ type: "LEASE_REVOKED", toState: "RUNNING" })).toBe(false);
  });

  it("N-F-7: refuses CAPABILITY_UNSUPPORTED outside the matrix, before any command exists", () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ commandKind: "RELEASE_RESERVATION", intentStream: "initiative_events" }, "payload.intentStream"],
      [{ commandKind: "REVOKE_LEASE", intentStream: "account_events" }, "payload.intentStream"],
      [{ commandKind: "NOTIFY", intentStream: "registry_events" }, "payload.intentStream"],
      [{ commandKind: "EXPORT_TELEMETRY", intentStream: "registry_events" }, "payload.intentStream"],
      // A row the matrix does list, realised by another stream's door.
      [{ commandKind: "NOTIFY", intentStream: "initiative_events" }, "payload.intentStream"],
      [{ commandKind: "RESTART_WORKER" }, "payload.commandKind"],
    ];
    for (const [overrides, path] of cases) {
      const reading = readOutboxEvent(
        outboxStreamEvent("OUTBOX_COMMAND_INTENDED", "intend", "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", intentionPayload(overrides)),
      );
      expect(reading?.kind, JSON.stringify(overrides)).toBe("refused");
      if (reading?.kind !== "refused") continue;
      expect(reading.path).toBe(path);
      expect(reading.message).toContain("CAPABILITY_UNSUPPORTED");
    }
    // And the matrix is §6.2's, with registry_events in no row.
    for (const streams of Object.values(OUTBOX_V1_COMMAND_STREAMS)) {
      expect(streams).toContain("control_plane_events");
      expect(streams).not.toContain("registry_events");
    }
  });

  it("N-F-6 and N-F-10: a half token, a stray key, a free failure word and a moved state are refused", () => {
    const intention = (overrides: Record<string, unknown>) =>
      readOutboxEvent(
        outboxStreamEvent("OUTBOX_COMMAND_INTENDED", "intend", "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", intentionPayload(overrides)),
      );
    const pathOf = (reading: ReturnType<typeof readOutboxEvent>): string | null =>
      reading?.kind === "refused" ? reading.path : null;

    expect(pathOf(intention({ targetStoreIncarnationId: null }))).toBe("payload.targetStoreIncarnationId");
    expect(pathOf(intention({ fence: null }))).toBe("payload.fence");
    expect(intention({ fence: null, targetStoreIncarnationId: null })?.kind).toBe("intention");
    expect(pathOf(intention({ note: "revoke please" }))).toBe("payload.note");
    expect(pathOf(intention({ outboxContractVersion: 2 }))).toBe("payload.outboxContractVersion");
    expect(pathOf(intention({ commandId: "f".repeat(64) }))).toBe("payload.commandId");

    const moved = readOutboxEvent(
      outboxStreamEvent("OUTBOX_COMMAND_INTENDED", "intend", "RUNNING", "SUSPECT_WORKTREE", intentionPayload()),
    );
    expect(pathOf(moved)).toBe("toState");

    const observe = (extra: Record<string, unknown>) =>
      readOutboxEvent(observationEntry(9, OUTBOX_ATTEMPT_ONE, quarantined().intention, "DELIVERED", extra).event);
    expect(pathOf(observe({ failureCode: "the target said no" }))).toBe("payload.failureCode");
    expect(pathOf(observe({ failureCode: "TARGET_REFUSED" }))).toBe("payload.failureCode");
    expect(pathOf(observe({ responseHandle: "line\nbreak" }))).toBe("payload.responseHandle");
    expect(observe({ responseHandle: "lease:4c4c4c4c:2" })?.kind).toBe("observation");
    const failed = readOutboxEvent(
      observationEntry(9, OUTBOX_ATTEMPT_ONE, quarantined().intention, "FAILED_TERMINAL").event,
    );
    expect(pathOf(failed)).toBe("payload.failureCode");
  });
});

describe("the outbox fold reconstructs, and refuses what the door refuses (datos §11)", () => {
  it("N-F-8: an intention folds PENDING, and an attempt with no outcome RECONCILING, never PENDING", () => {
    const { entries, intention } = quarantined();
    const pending = foldOutboxCommands(entries);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      commandId: REVOKE_COMMAND,
      state: "PENDING",
      attemptCount: 0,
      intentSequence: 3,
      intentSha256: intention.sha256,
      fence: 1,
      targetStoreIncarnationId: "4c4c4c4c-0000-4000-8000-000000000001",
      taskId: OUTBOX_TASK,
    });

    const attempt = attemptEntry(4, OUTBOX_ATTEMPT_ONE, intention);
    const [reconciling] = foldOutboxCommands([...entries, attempt]);
    expect(reconciling).toMatchObject({
      state: "RECONCILING",
      attemptCount: 1,
      lastDeliveryAttemptId: OUTBOX_ATTEMPT_ONE,
      lastAttemptStream: "control_plane_events",
      lastAttemptSequence: 4,
      lastAttemptSha256: attempt.sha256,
    });
  });

  it("N-F-4: the same attempt replayed counts once", () => {
    const { entries, intention } = quarantined();
    const [command] = foldOutboxCommands([
      ...entries,
      attemptEntry(4, OUTBOX_ATTEMPT_ONE, intention),
      attemptEntry(5, OUTBOX_ATTEMPT_ONE, intention),
    ]);
    expect(command?.attemptCount).toBe(1);
    expect(command?.lastAttemptSequence).toBe(4);
  });

  it("N-F-5: a failed attempt returns to PENDING, keeps its code, and a terminal state moves nowhere", () => {
    const { entries, intention } = quarantined();
    const first = attemptEntry(4, OUTBOX_ATTEMPT_ONE, intention);
    const failed = observationEntry(5, OUTBOX_ATTEMPT_ONE, first, "FAILED_RETRYABLE", { failureCode: "NOT_DISPATCHED_PROVEN" });
    const again = observationEntry(6, OUTBOX_ATTEMPT_ONE, first, "PENDING");
    const second = attemptEntry(7, OUTBOX_ATTEMPT_TWO, intention);
    const delivered = observationEntry(8, OUTBOX_ATTEMPT_TWO, second, "DELIVERED", { responseHandle: "lease:2" });
    const [command] = foldOutboxCommands([...entries, first, failed, again, second, delivered]);
    expect(command).toMatchObject({
      state: "DELIVERED",
      attemptCount: 2,
      lastDeliveryAttemptId: OUTBOX_ATTEMPT_TWO,
      lastFailureCode: "NOT_DISPATCHED_PROVEN",
      responseHandle: "lease:2",
    });

    // Out of a terminal state nothing moves, not even to itself.
    const restated = observationEntry(9, OUTBOX_ATTEMPT_TWO, second, "DELIVERED");
    expect(foldRefusal([...entries, first, failed, again, second, delivered, restated])?.path).toBe("payload.outboxState");
    // RECONCILING does not go back to INFLIGHT.
    expect(foldRefusal([...entries, first, observationEntry(5, OUTBOX_ATTEMPT_ONE, first, "INFLIGHT")])?.path).toBe(
      "payload.outboxState",
    );
    // And a new attempt beside an uncertain one is refused.
    expect(foldRefusal([...entries, first, attemptEntry(5, OUTBOX_ATTEMPT_TWO, intention)])?.message).toContain(
      "never resent",
    );
  });

  it("N-F-3: an attempt needs its intention, and an observation its attempt, as named causes", () => {
    const { entries, intention } = quarantined();
    // No intention at all.
    expect(foldRefusal([entries[0]!, entries[1]!, attemptEntry(3, OUTBOX_ATTEMPT_ONE, entries[1]!)])?.path).toBe(
      "payload.commandId",
    );
    // An attempt that names some other event as its cause.
    expect(foldRefusal([...entries, attemptEntry(4, OUTBOX_ATTEMPT_ONE, entries[0]!)])?.path).toBe("causation");
    // An observation of an attempt nobody intended.
    const first = attemptEntry(4, OUTBOX_ATTEMPT_ONE, intention);
    expect(foldRefusal([...entries, first, observationEntry(5, OUTBOX_ATTEMPT_TWO, first, "DELIVERED")])?.path).toBe(
      "payload.deliveryAttemptId",
    );
    // An observation that names the intention rather than the attempt.
    expect(foldRefusal([...entries, first, observationEntry(5, OUTBOX_ATTEMPT_ONE, intention, "DELIVERED")])?.path).toBe(
      "causation",
    );
  });

  it("N-F-1, fold half: a REVOKE_LEASE intention that does not follow a quarantine is refused", () => {
    const { entries } = quarantined();
    const unrelated = entry(outboxStreamEvent("ATOMIC_STEP_COMPLETED", "step", "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", {}), 3);
    const intention = entry(
      outboxStreamEvent("OUTBOX_COMMAND_INTENDED", "intend", "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", intentionPayload()),
      4,
    );
    expect(foldRefusal([entries[0]!, entries[1]!, unrelated, intention])?.path).toBe("payload.commandKind");
    expect(foldRefusal([intention])?.path).toBe("payload.commandKind");

    // The fold offers every event, of every type, so the predecessor is always
    // the event immediately before — never the last outbox event.
    const fold = createOutboxFold();
    for (const each of entries) applyEventToOutboxFold(fold, each);
    expect(fold.commands.get(REVOKE_COMMAND)?.state).toBe("PENDING");
    expect(fold.previous.get("event")?.type).toBe("OUTBOX_COMMAND_INTENDED");
  });

  it("refuses a second intention of one command, and says whether it is the same one", () => {
    const { entries } = quarantined();
    const repeat = (overrides: Record<string, unknown>, sequence: number) =>
      entry(outboxStreamEvent("OUTBOX_COMMAND_INTENDED", "intend-" + String(sequence), "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", intentionPayload(overrides)), sequence);
    const quarantine = entry(outboxStreamEvent("WRITE_SET_VIOLATION_DETECTED", "again", "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", {}), 4);
    const same = foldRefusal([...entries, quarantine, repeat({}, 5)]);
    expect(same?.message).toContain("already intended");
    expect(same?.message).not.toContain("CONFLICT");
    const different = foldRefusal([...entries, quarantine, repeat({ deadlineAt: "2026-09-12T13:00:00.000Z" }, 5)]);
    expect(different?.message).toContain("CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// CORR-2 — a present-invalid word is refused by name, never read as absent
// ---------------------------------------------------------------------------

/** One `DISPATCH_OUTCOME_RECORDED` for `dsp-1`, with the record the caller shapes. */
function outcomeEvent(record: Record<string, unknown>): ControlPlaneEvent {
  return executionEvent("DISPATCH_OUTCOME_RECORDED", {
    revisionNumber: 1,
    attemptNumber: 1,
    outcome: { dispatchAttemptId: "dsp-1", ...record },
  });
}

const SETTLED_AT = "2026-09-12T09:00:00.000Z";

/** A result pair: a RESPONSE reference and its digest (P-07 escalón B, ADR 0098). */
const RESULT_PAIR = { resultArtifactReferenceId: "ref-response-1", resultSha256: "d".repeat(64) } as const;

/** Every present-invalid value the four optional fields are drilled with, per field. */
const PRESENT_INVALID: readonly (readonly [string, unknown])[] = [
  ["effectOutcomeStatus", "INVALID_STATUS"],
  ["effectOutcomeStatus", "succeeded"],
  ["effectOutcomeStatus", 42],
  ["effectOutcomeStatus", null],
  ["effectOutcomeStatus", ""],
  ["acceptedAt", 42],
  ["acceptedAt", null],
  ["externalHandle", { nested: "handle" }],
  ["externalHandle", ""],
  ["providerIdempotencyKey", ["key"]],
  ["providerIdempotencyKey", null],
];

describe("a resolution reads three ways, and present-invalid is not absent (CORR-2)", () => {
  it("N-CORR2-H2-R: every optional field refuses a present value its grammar does not admit, by name", () => {
    for (const [field, value] of PRESENT_INVALID) {
      const reading = dispatchOutcomeRecord(
        outcomeEvent({ dispatchState: "SETTLED", terminalAt: SETTLED_AT, [field]: value }),
        4,
      );
      const label = field + " = " + JSON.stringify(value);
      expect(reading?.kind, label).toBe("refused");
      if (reading?.kind !== "refused") continue;
      expect(reading.path, label).toBe("payload.outcome." + field);
      expect(reading.message, label).toContain(field + ", when present,");
    }

    // The word is shown when it is shaped like one, and never otherwise: a
    // value carrying a line break is named, not echoed.
    const shaped = dispatchOutcomeRecord(
      outcomeEvent({ dispatchState: "SETTLED", terminalAt: SETTLED_AT, effectOutcomeStatus: "INVALID_STATUS" }),
      4,
    );
    expect(shaped?.kind === "refused" ? shaped.message : "").toContain('"INVALID_STATUS"');
    const hostile = dispatchOutcomeRecord(
      outcomeEvent({ dispatchState: "SETTLED", terminalAt: SETTLED_AT, effectOutcomeStatus: "BAD\nWORD" }),
      4,
    );
    const hostileMessage = hostile?.kind === "refused" ? hostile.message : "";
    expect(hostileMessage).toContain("<unprintable identifier>");
    expect(hostileMessage).not.toContain("WORD");
    const numeric = dispatchOutcomeRecord(
      outcomeEvent({ dispatchState: "SETTLED", terminalAt: SETTLED_AT, acceptedAt: 42 }),
      4,
    );
    expect(numeric?.kind === "refused" ? numeric.message : "").toContain("says a number");
  });

  it("P-CORR2-H2-R: an absent key is absence, and a lawful value is the value", () => {
    const absent = dispatchOutcomeRecord(outcomeEvent({ dispatchState: "CLAIMED" }), 3);
    expect(absent?.kind).toBe("record");
    if (absent?.kind === "record") {
      expect(absent.record).toMatchObject({
        dispatchAttemptId: "dsp-1",
        dispatchState: "CLAIMED",
        terminalAt: null,
        acceptedAt: null,
        externalHandle: null,
        providerIdempotencyKey: null,
        effectOutcomeStatus: null,
        sequence: 3,
      });
    }

    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"]) {
      const reading = dispatchOutcomeRecord(
        outcomeEvent({
          dispatchState: "SETTLED",
          terminalAt: SETTLED_AT,
          acceptedAt: SETTLED_AT,
          externalHandle: "handle-1",
          providerIdempotencyKey: "provider-key-1",
          effectOutcomeStatus: status,
          // Only a SUCCEEDED of the version in force must name its result.
          ...(status === "SUCCEEDED" ? RESULT_PAIR : {}),
        }),
        4,
      );
      expect(reading?.kind, status).toBe("record");
      if (reading?.kind !== "record") continue;
      expect(reading.record.effectOutcomeStatus).toBe(status);
      expect(reading.record.acceptedAt).toBe(SETTLED_AT);
      expect(reading.record.externalHandle).toBe("handle-1");
      expect(reading.record.providerIdempotencyKey).toBe("provider-key-1");
    }

    // What is not a resolution at all still reads as nothing, not as a refusal:
    // the door refuses it with its own message and the fold projects no row.
    expect(dispatchOutcomeRecord(outcomeEvent({ dispatchState: "SETTLED", effectOutcomeStatus: 42 }), 4)).toBeNull();
    expect(dispatchOutcomeRecord(executionEvent("DISPATCH_INTENDED", { outcome: {} }), 4)).toBeNull();
  });

  it("N-CORR2-H2-F: the fold refuses with the reader's issue, and moves neither the delivery nor the effect", () => {
    for (const [field, value] of PRESENT_INVALID) {
      const snapshot = snapshotWithDelivery();
      const event = outcomeEvent({ dispatchState: "SETTLED", terminalAt: SETTLED_AT, [field]: value });
      const reading = dispatchOutcomeRecord(event, 3);
      let issue: unknown = null;
      try {
        applyEventToSnapshot(snapshot, event, 3, EVENT_SHA256);
      } catch (error) {
        expect(error).toBeInstanceOf(LedgerValidationError);
        issue = (error as LedgerValidationError).issues[0];
      }
      const label = field + " = " + JSON.stringify(value);
      expect(reading?.kind, label).toBe("refused");
      expect(issue, label).toEqual(
        reading?.kind === "refused" ? { path: reading.path, message: reading.message } : "a refusal",
      );
      expect(snapshot.dispatchAttempts.get("dsp-1")?.dispatchState, label).toBe("INTENDED");
      expect(snapshot.effects.get(OCCURRENCE_EFFECT)?.outcomeStatus, label).toBeNull();
    }

    // And the lawful form of the same resolution still folds.
    const snapshot = snapshotWithDelivery();
    applyEventToSnapshot(
      snapshot,
      outcomeEvent({ dispatchState: "SETTLED", terminalAt: SETTLED_AT, effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR }),
      3,
      EVENT_SHA256,
    );
    expect(snapshot.dispatchAttempts.get("dsp-1")?.dispatchState).toBe("SETTLED");
    expect(snapshot.effects.get(OCCURRENCE_EFFECT)?.outcomeStatus).toBe("SUCCEEDED");
  });

  it("P-15/D1: a transition instant outside the canonical form is refused by the fold in the door's words, never normalized", () => {
    const spellings: readonly unknown[] = [
      "",
      "2026-09-12T11:00:00.000+02:00",
      "2026-09-12T09:00:00Z",
      "2026-09-12T09:00:00.000z",
      "2026-02-30T00:00:00.000Z",
    ];
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ...spellings.map((value) => ["acceptedAt", { dispatchState: "INFLIGHT", acceptedAt: value, externalHandle: "h-1" }] as const),
      ...spellings.map((value) => ["terminalAt", { dispatchState: "SETTLED", terminalAt: value }] as const),
    ];
    for (const [key, record] of cases) {
      const snapshot = snapshotWithDelivery();
      const event = outcomeEvent(record);
      const reading = dispatchOutcomeRecord(event, 3);
      const label = key + " = " + JSON.stringify(record[key]);
      expect(reading?.kind === "refused" ? reading.path : "not refused", label).toBe("payload.outcome." + key);
      expect(() => {
        applyEventToSnapshot(snapshot, event, 3, EVENT_SHA256);
      }, label).toThrow(LedgerValidationError);
      expect(snapshot.dispatchAttempts.get("dsp-1")?.dispatchState, label).toBe("INTENDED");
    }
    // A non-terminal state may carry terminalAt null, and the canonical forms read.
    expect(dispatchOutcomeRecord(outcomeEvent({ dispatchState: "INFLIGHT", terminalAt: null, acceptedAt: SETTLED_AT, externalHandle: "h-1" }), 3)?.kind).toBe(
      "record",
    );
  });

  it("P-15/D1: a segment transport outside the vocabulary is refused by the fold in the door's words, never projected as text", () => {
    // Decision 56: a rebuild of a stored history holding one refuses by name here,
    // rather than projecting no segment and dying later on the foreign key of the
    // rows that name it.
    const ABSENT = Symbol("absent");
    for (const transportKind of [ABSENT, null, "", 7, "cli", "api_key", "CARRIER_PIGEON", "API_KEY "]) {
      const record = segment();
      if (transportKind === ABSENT) Reflect.deleteProperty(record, "transportKind");
      else record["transportKind"] = transportKind;
      const event = executionEvent("EFFECT_INTENDED", { revisionNumber: 1, attemptNumber: 1, segment: record });
      const label = transportKind === ABSENT ? "<absent>" : JSON.stringify(transportKind);
      const refusal = segmentTransportRefusal(event);
      expect(refusal?.path, label).toBe("payload.segment.transportKind");
      expect(nextExecutionRouteSegmentProjection(event, 1), label).toBeNull();
      const snapshot = createProjectionSnapshot();
      let thrown: unknown = null;
      try {
        applyEventToSnapshot(snapshot, event, 1, EVENT_SHA256);
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(LedgerValidationError);
      expect((thrown as LedgerValidationError).issues[0], label).toEqual(refusal);
      expect(snapshot.routeSegments.size, label).toBe(0);
    }
    // The control: each word of the vocabulary reads, and the fold projects it.
    for (const transportKind of ["CLI_SUBSCRIPTION", "API_KEY", "LOCAL_OR_SELF_HOSTED"]) {
      const event = executionEvent("EFFECT_INTENDED", { revisionNumber: 1, attemptNumber: 1, segment: segment({ transportKind }) });
      expect(segmentTransportRefusal(event)).toBeNull();
      expect(nextExecutionRouteSegmentProjection(event, 1)?.transportKind).toBe(transportKind);
    }
    // Another type, or an intention with no segment object, is not the transport's to judge.
    expect(segmentTransportRefusal(executionEvent("EFFECT_INTENDED", { revisionNumber: 1, attemptNumber: 1 }))).toBeNull();
  });
});

describe("the P-18 value types of the projection live in a pure type leaf (CORR-2, C-H3)", () => {
  it("declares types and nothing else, and the concept's module re-exports every one", () => {
    const leaf = readSourceCode("src/projection/types/index.ts");
    const declared = [...leaf.matchAll(/^export (?:interface|type) ([A-Za-z]+)/gm)].map((match) => String(match[1]));
    expect(declared).toEqual([
      "DispatchOutcomeRecord",
      "DispatchOutcomeReading",
      // P-15 escalón C: the pin's reading, beside its sibling (ADR 0103).
      "DispatchPinReading",
      "EffectOutcomeArrival",
      "OccurrenceReading",
      "OccurrenceRefusal",
      "OccurrenceOwner",
      "OutboxCommandIntention",
      "OutboxDeliveryAttempt",
      "OutboxDeliveryObservation",
      "OutboxReading",
      "OutboxEventEntry",
      "OutboxAttemptRecord",
      "OutboxPredecessor",
      "OutboxFold",
    ]);
    // Imports only types, and holds no value, no function and no class.
    for (const line of leaf.split("\n").filter((each) => /^import\b/.test(each))) {
      expect(line).toMatch(/^import type /);
    }
    expect(leaf).not.toMatch(/^export (?:const|function|class|let|enum)\b/m);

    const module = readSourceCode("src/projection/index.ts");
    const reexport = /^export type \{([^}]*)\} from "\.\/types\/index\.js";$/m.exec(module);
    expect(reexport).not.toBeNull();
    const reexported = (reexport?.[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    expect([...reexported].sort()).toEqual([...declared].sort());
    for (const name of declared) {
      const redeclared = new RegExp("^export (?:interface|type) " + name + "\\b", "m").test(module);
      expect({ name, redeclared }).toEqual({ name, redeclared: false });
    }
  });
});

/** A source file of this package with its comments removed. */
function readSourceCode(relativePath: string): string {
  const source = readFileSync(new URL("../../" + relativePath, import.meta.url), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// P-36/local escalón A — the artifact fold, as a pure function (ADR 0081)
//
// The ledger suite drives the fold through the door and the rebuild; this one
// drives the one decision function both of them call, against a snapshot, so a
// transition of artifacts §8.1 is asserted without a database in the way.
// ---------------------------------------------------------------------------

const FOLD_AT = "2026-09-13T10:00:00.000Z";
const FOLD_CONTENT = "e".repeat(64);

function foldEvent(
  kind: string,
  payload: Record<string, unknown>,
  ordinal = 1,
  occurredAt = FOLD_AT,
): ArtifactRegistryEvent {
  return ArtifactRegistryEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: "00000000-0000-4000-8000-" + String(ordinal).padStart(12, "0"),
    idempotencyKey: kind + "/" + String(ordinal),
    subjectKind: "ARTIFACT",
    artifactEventKind: kind,
    subjectOrdinal: ordinal,
    parentSubjectOrdinal: ordinal === 1 ? null : ordinal - 1,
    recordedBy: "claude/opus/implementer/01",
    occurredAt,
    recordedAt: occurredAt,
    payload,
  });
}

function foldIntention(overrides: Record<string, unknown> = {}, ordinal = 1, occurredAt = FOLD_AT): ArtifactRegistryEvent {
  return foldEvent(
    "PUBLICATION_INTENDED",
    {
      commandId: "cmd-1",
      contentSha256: FOLD_CONTENT,
      blobGeneration: 1,
      mediaType: "text/plain",
      sizeBytes: 5,
      encryptionStatus: "PLAINTEXT",
      keyReference: null,
      encryptionProfile: "local-plaintext-v1",
      artifactPinId: "pin-p-1",
      ...overrides,
    },
    ordinal,
    occurredAt,
  );
}

function foldReference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactReferenceId: "ref-1",
    artifactClass: "PLAN_DOCUMENT",
    classification: "INTERNAL",
    scopeKind: "SYSTEM",
    scopeId: null,
    producerIdentity: "claude/opus/implementer/01",
    accessPolicyId: "SCOPE_EQUALITY_V1",
    retentionClass: "PERMANENT",
    expiresAt: null,
    ...overrides,
  };
}

function foldSuccess(overrides: Record<string, unknown> = {}, ordinal = 2, occurredAt = FOLD_AT): ArtifactRegistryEvent {
  return foldEvent(
    "PUBLICATION_SUCCEEDED",
    {
      commandId: "cmd-1",
      contentSha256: FOLD_CONTENT,
      blobGeneration: 1,
      artifactPinId: "pin-p-1",
      reference: foldReference(),
      ...overrides,
    },
    ordinal,
    occurredAt,
  );
}

function refusedWith(action: () => unknown): { readonly path: string; readonly message: string } {
  let caughtError: unknown = null;
  try {
    action();
  } catch (error: unknown) {
    caughtError = error;
  }
  expect(caughtError).toBeInstanceOf(LedgerValidationError);
  const issue = (caughtError as LedgerValidationError).issues[0];
  if (issue === undefined) throw new Error("no issue");
  return issue;
}

describe("the artifact vocabularies this build admits (P-36/local A)", () => {
  it("records six of the contract's nine words, and refuses the other three by name", () => {
    expect(DELIVERED_ARTIFACT_EVENT_KINDS).toEqual([
      "PUBLICATION_INTENDED",
      "PUBLICATION_SUCCEEDED",
      "PUBLICATION_ABANDONED",
      "REFERENCE_RECORDED",
      "PIN_ACQUIRED",
      "PIN_RELEASED",
    ]);
    for (const kind of ARTIFACT_EVENT_KINDS) {
      const refusal = artifactEventKindRefusal(kind);
      const delivered = (DELIVERED_ARTIFACT_EVENT_KINDS as readonly string[]).includes(kind);
      expect(refusal === null, kind).toBe(delivered);
      if (refusal !== null) expect(refusal.path).toBe("artifactEventKind");
    }
    // A word outside the contract is the schema's to refuse, not this one's.
    expect(artifactEventKindRefusal("GARBAGE_COLLECTED")).toBeNull();
    expect(artifactEventKindRefusal(7)).toBeNull();
  });

  it("closes the access policy at one identifier", () => {
    expect(ARTIFACT_ACCESS_POLICY_IDS).toEqual(["SCOPE_EQUALITY_V1"]);
  });
});

describe("an artifact event names its subject by rule, never by hash (H-3, H-4)", () => {
  it("takes the content for a publication, the reference for a recording, the pin for a pin event", () => {
    expect(artifactSubjectOf(foldIntention())).toEqual({ documentId: FOLD_CONTENT, contentDigest: FOLD_CONTENT });
    expect(artifactSubjectOf(foldSuccess())).toEqual({ documentId: FOLD_CONTENT, contentDigest: FOLD_CONTENT });
    expect(
      artifactSubjectOf(foldEvent("REFERENCE_RECORDED", { contentSha256: FOLD_CONTENT, blobGeneration: 1, reference: foldReference({ artifactReferenceId: "ref-9" }) })),
    ).toEqual({ documentId: "ref-9", contentDigest: FOLD_CONTENT });
    expect(
      artifactSubjectOf(foldEvent("PIN_RELEASED", { artifactPinId: "pin-9", contentSha256: FOLD_CONTENT, blobGeneration: 1 })),
    ).toEqual({ documentId: "pin-9", contentDigest: FOLD_CONTENT });
  });

  it("refuses SECRET_BEARING, an unknown policy and a hand-taken publication pin before any state is read", () => {
    expect(artifactEventRefusal(foldSuccess({ reference: foldReference({ classification: "SECRET_BEARING" }) }))?.path).toBe(
      "payload.reference.classification",
    );
    expect(artifactEventRefusal(foldSuccess({ reference: foldReference({ accessPolicyId: "OTHER_V1" }) }))?.path).toBe(
      "payload.reference.accessPolicyId",
    );
    expect(
      artifactEventRefusal(foldEvent("PIN_ACQUIRED", { artifactPinId: "p", contentSha256: FOLD_CONTENT, blobGeneration: 1, pinHolderKind: "PUBLICATION", pinHolderId: "c" }))?.path,
    ).toBe("payload.pinHolderKind");
    expect(artifactEventRefusal(foldSuccess())).toBeNull();
  });

  it("N-P36D-12 / N-P36D-13: runs the same two rules over an intention's intended reference (O-1)", () => {
    // Escalón C's postaudit, O-1. The fold never reads the block, but it rides
    // the stream, and a SECRET_BEARING reference is kept out of the stream
    // wherever it would ride.
    expect(
      artifactEventRefusal(foldIntention({ intendedReference: foldReference({ classification: "SECRET_BEARING" }) })),
    ).toEqual({
      path: "payload.intendedReference.classification",
      message: artifactEventRefusal(foldSuccess({ reference: foldReference({ classification: "SECRET_BEARING" }) }))?.message,
    });
    const policy = artifactEventRefusal(foldIntention({ intendedReference: foldReference({ accessPolicyId: "OTHER_V1" }) }));
    expect(policy?.path).toBe("payload.intendedReference.accessPolicyId");
    expect(policy?.message).toBe(
      artifactEventRefusal(foldSuccess({ reference: foldReference({ accessPolicyId: "OTHER_V1" }) }))?.message,
    );
    // A valid block, and no block at all (the schema's optionality, decision 64).
    expect(artifactEventRefusal(foldIntention({ intendedReference: foldReference() }))).toBeNull();
    expect(artifactEventRefusal(foldIntention())).toBeNull();
    // A TASK_ENVELOPE block earns no special treatment: class is not a stream rule.
    expect(artifactEventRefusal(foldIntention({ intendedReference: foldReference({ artifactClass: "TASK_ENVELOPE" }) }))).toBeNull();
  });
});

describe("the artifact fold decides artifacts §8.1 once, for the door and the rebuild", () => {
  it("births a STAGED generation with its publication pin, and publishes it with the pair fixed at the success", () => {
    const snapshot = createArtifactProjectionSnapshot();
    const intended = nextArtifactProjection(artifactSnapshotView(snapshot), foldIntention(), 1);
    expect(intended.blob).toMatchObject({ blobGeneration: 1, lifecycleState: "STAGED", graceStartedAt: FOLD_AT, firstPublishedSequence: null, appliedSequence: 1 });
    expect(intended.reference).toBeNull();
    expect(intended.pin).toMatchObject({ pinHolderKind: "PUBLICATION", pinHolderId: "cmd-1", acquiredSequence: 1, releasedSequence: null });
    applyArtifactEventToSnapshot(snapshot, foldIntention(), 1);

    const later = "2026-09-13T10:05:00.000Z";
    const succeeded = nextArtifactProjection(artifactSnapshotView(snapshot), foldSuccess({}, 2, later), 2);
    expect(succeeded.blob).toMatchObject({ lifecycleState: "PUBLISHED", firstPublishedSequence: 2, firstPublishedAt: later, graceStartedAt: FOLD_AT });
    expect(succeeded.reference).toMatchObject({ artifactReferenceId: "ref-1", createdSequence: 2, tombstonedAt: null });
    expect(succeeded.pin).toMatchObject({ acquiredSequence: 1, releasedSequence: 2, appliedSequence: 2 });
  });

  it("conserves a PUBLISHED generation whole on a deduplicated intention, and refuses another encryption with its named error", () => {
    const snapshot = createArtifactProjectionSnapshot();
    applyArtifactEventToSnapshot(snapshot, foldIntention(), 1);
    applyArtifactEventToSnapshot(snapshot, foldSuccess(), 2);
    const dedup = nextArtifactProjection(artifactSnapshotView(snapshot), foldIntention({ commandId: "cmd-2", artifactPinId: "pin-p-2" }, 3), 3);
    expect(dedup.blob).toBeNull();
    expect(dedup.pin).toMatchObject({ pinHolderId: "cmd-2", blobGeneration: 1 });

    expect(() =>
      nextArtifactProjection(artifactSnapshotView(snapshot), foldIntention({ commandId: "cmd-2", artifactPinId: "pin-p-2", encryptionProfile: "other" }, 3), 3),
    ).toThrow(LedgerArtifactEncryptionConflictError);
    expect(
      refusedWith(() => nextArtifactProjection(artifactSnapshotView(snapshot), foldIntention({ commandId: "cmd-2", artifactPinId: "pin-p-2", sizeBytes: 6 }, 3), 3)).path,
    ).toBe("payload.sizeBytes");
  });

  it("proposes the generation and verifies it: the next one for new content, the held one for reuse", () => {
    const snapshot = createArtifactProjectionSnapshot();
    expect(refusedWith(() => nextArtifactProjection(artifactSnapshotView(snapshot), foldIntention({ blobGeneration: 2 }), 1)).message).toContain(
      "opens generation 1, not 2",
    );
    applyArtifactEventToSnapshot(snapshot, foldIntention(), 1);
    expect(snapshot.highestGenerations.get(FOLD_CONTENT)).toBe(1);
    expect(artifactSnapshotView(snapshot).unreclaimedBlob(FOLD_CONTENT)?.blobGeneration).toBe(1);
  });

  it("stages an abandoned generation again with its grace instant, and refuses an intention while one is in flight", () => {
    const snapshot = createArtifactProjectionSnapshot();
    applyArtifactEventToSnapshot(snapshot, foldIntention(), 1);
    expect(refusedWith(() => nextArtifactProjection(artifactSnapshotView(snapshot), foldIntention({ commandId: "cmd-2", artifactPinId: "pin-p-2" }, 2), 2)).message).toContain(
      "already in flight",
    );
    applyArtifactEventToSnapshot(
      snapshot,
      foldEvent("PUBLICATION_ABANDONED", { commandId: "cmd-1", contentSha256: FOLD_CONTENT, blobGeneration: 1, artifactPinId: "pin-p-1" }, 2),
      2,
    );
    expect(snapshot.blobs.get(artifactBlobKey(FOLD_CONTENT, 1))?.lifecycleState).toBe("PUBLICATION_ABANDONED");
    expect(snapshot.livePins.size).toBe(0);

    const again = nextArtifactProjection(
      artifactSnapshotView(snapshot),
      foldIntention({ commandId: "cmd-2", artifactPinId: "pin-p-2" }, 3, "2026-09-14T00:00:00.000Z"),
      3,
    );
    expect(again.blob).toMatchObject({ blobGeneration: 1, lifecycleState: "STAGED", graceStartedAt: FOLD_AT, appliedSequence: 3 });
  });

  it("keeps the live-pin index in step with the pins, so one holder holds one live pin", () => {
    const snapshot = createArtifactProjectionSnapshot();
    applyArtifactEventToSnapshot(snapshot, foldIntention(), 1);
    applyArtifactEventToSnapshot(snapshot, foldSuccess(), 2);
    const acquire = foldEvent("PIN_ACQUIRED", { artifactPinId: "pin-b", contentSha256: FOLD_CONTENT, blobGeneration: 1, pinHolderKind: "BACKUP", pinHolderId: "backup-1" });
    applyArtifactEventToSnapshot(snapshot, acquire, 3);
    expect(nextArtifactProjection(artifactSnapshotView(snapshot), foldEvent("PIN_ACQUIRED", { artifactPinId: "pin-b", contentSha256: FOLD_CONTENT, blobGeneration: 1, pinHolderKind: "BACKUP", pinHolderId: "backup-1" }, 2), 4)).toEqual({
      blob: null,
      reference: null,
      pin: null,
    });
    expect(artifactSnapshotView(snapshot).livePin(FOLD_CONTENT, 1, "BACKUP", "backup-1")?.artifactPinId).toBe("pin-b");
    applyArtifactEventToSnapshot(snapshot, foldEvent("PIN_RELEASED", { artifactPinId: "pin-b", contentSha256: FOLD_CONTENT, blobGeneration: 1 }, 2), 4);
    expect(artifactSnapshotView(snapshot).livePin(FOLD_CONTENT, 1, "BACKUP", "backup-1")).toBeNull();
    expect(snapshot.pins.get("pin-b")).toMatchObject({ acquiredSequence: 3, releasedSequence: 4 });
  });

  it("is a function of the events alone: the same history folds to the same snapshot, every time", () => {
    const history: readonly [ArtifactRegistryEvent, number][] = [
      [foldIntention(), 1],
      [foldSuccess(), 2],
      [foldEvent("REFERENCE_RECORDED", { contentSha256: FOLD_CONTENT, blobGeneration: 1, reference: foldReference({ artifactReferenceId: "ref-2" }) }), 3],
      [foldEvent("PIN_ACQUIRED", { artifactPinId: "pin-t", contentSha256: FOLD_CONTENT, blobGeneration: 1, pinHolderKind: "TASK", pinHolderId: "t-1" }), 4],
    ];
    const fold = (): string => {
      const snapshot = createArtifactProjectionSnapshot();
      for (const [event, sequence] of history) applyArtifactEventToSnapshot(snapshot, event, sequence);
      return JSON.stringify({
        blobs: [...snapshot.blobs.entries()],
        references: [...snapshot.references.entries()],
        pins: [...snapshot.pins.entries()],
        tombstones: [...snapshot.tombstones.entries()],
      });
    };
    expect(fold()).toBe(fold());
    // And the tombstone map is empty by construction: nothing in this build folds one.
    const snapshot = createArtifactProjectionSnapshot();
    for (const [event, sequence] of history) applyArtifactEventToSnapshot(snapshot, event, sequence);
    expect(snapshot.tombstones.size).toBe(0);
  });

  it("refuses in the fold what the door refuses before its lock, so a planted history cannot slip past", () => {
    const snapshot = createArtifactProjectionSnapshot();
    applyArtifactEventToSnapshot(snapshot, foldIntention(), 1);
    expect(
      refusedWith(() => {
        applyArtifactEventToSnapshot(snapshot, foldSuccess({ reference: foldReference({ classification: "SECRET_BEARING" }) }), 2);
      }).path,
    ).toBe("payload.reference.classification");
    expect(snapshot.references.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The initiative projection's registration columns (P-14 B, ADR 0086)
// ---------------------------------------------------------------------------

describe("the initiative fold reads the closed registration payload and nothing else (P-14 B)", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";
  const PAYLOAD = {
    slug: "acp-p14",
    title: "The P-14 bootstrap",
    objectiveSha256: "d".repeat(64),
    objectiveArtifactReferenceId: "objective-reference",
  };

  function initiativeEvent(overrides: Record<string, unknown> = {}): InitiativeEvent {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "66666666-6666-4666-8666-666666666666",
      initiativeId: INITIATIVE,
      transitionId: "register",
      idempotencyKey: INITIATIVE + "/1/register",
      type: "INITIATIVE_REGISTERED",
      fromStatus: null,
      toStatus: "ACTIVE",
      emittedBy: "kimi/k3/coordinator/01",
      occurredAt: "2026-09-13T12:00:00.000Z",
      recordedAt: "2026-09-13T12:00:00.000Z",
      payload: { ...PAYLOAD },
      ...overrides,
    } as InitiativeEvent;
  }

  it("names the four keys in the order the door writes them", () => {
    expect([...INITIATIVE_REGISTRATION_PAYLOAD_KEYS]).toEqual(["slug", "title", "objectiveSha256", "objectiveArtifactReferenceId"]);
    expect(initiativeRegistrationPayloadOf(initiativeEvent())).toEqual(PAYLOAD);
  });

  it("is total: every other shape is no registration facts, never a throw", () => {
    const shapes: Record<string, unknown>[] = [
      {},
      { slug: "acp-p8", title: "The P8 initiative" },
      { slug: "acp-p8", title: "The P8 initiative", objective: "Land the execution boundary" },
      { ...PAYLOAD, objective: "never in the stream" },
      { ...PAYLOAD, slug: "Not-Lowercase" },
      { ...PAYLOAD, slug: "s".repeat(81) },
      { ...PAYLOAD, title: "" },
      { ...PAYLOAD, title: "t".repeat(201) },
      { ...PAYLOAD, objectiveSha256: "D".repeat(64) },
      { ...PAYLOAD, objectiveSha256: 7 },
      { ...PAYLOAD, objectiveArtifactReferenceId: "" },
      { ...PAYLOAD, objectiveArtifactReferenceId: "r".repeat(513) },
    ];
    for (const payload of shapes) {
      expect(initiativeRegistrationPayloadOf(initiativeEvent({ payload })), JSON.stringify(payload).slice(0, 80)).toBeNull();
    }
    // Only a registration carries registration facts, whatever its payload says.
    expect(
      initiativeRegistrationPayloadOf(initiativeEvent({ type: "INITIATIVE_STATE_CHANGED", fromStatus: "ACTIVE", toStatus: "PAUSED" })),
    ).toBeNull();
  });

  it("projects title and digest on the registration, carries them forward, and never produces a repository digest", () => {
    const registered = nextInitiativeProjection(null, initiativeEvent(), 1);
    expect(registered).toMatchObject({ title: PAYLOAD.title, objectiveSha256: PAYLOAD.objectiveSha256, repositorySha256: null });
    const paused = nextInitiativeProjection(
      registered,
      initiativeEvent({ type: "INITIATIVE_STATE_CHANGED", transitionId: "pause", fromStatus: "ACTIVE", toStatus: "PAUSED", payload: {} }),
      2,
    );
    expect(paused).toMatchObject({ currentStatus: "PAUSED", eventCount: 2, title: PAYLOAD.title, objectiveSha256: PAYLOAD.objectiveSha256 });
    expect(nextInitiativeProjection(null, initiativeEvent({ payload: {} }), 1)).toMatchObject({
      title: null,
      objectiveSha256: null,
      repositorySha256: null,
    });
  });
});

// ---------------------------------------------------------------------------
// P-14 escalón C — the intake's closed payload and its client key (ADR 0087)
// ---------------------------------------------------------------------------

const INTAKE_TASK = "9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d01";
const OTHER_INTAKE_TASK = "9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d02";

function intakePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revisionId: "rev-intake-1",
    revisionNumber: 1,
    attemptNumber: 1,
    envelopeSha256: "e".repeat(64),
    restoredFromRevisionId: null,
    envelopeArtifactReferenceId: "ref-intake-1",
    initiativeId: INITIATIVE_A,
    clientScope: "claude/opus/implementer/01",
    clientRequestKey: "intake-0001",
    roadmapVersionId: null,
    stepId: null,
    role: "implementer",
    commitPolicy: "NO_COMMIT",
    resolution: {
      assignmentId: "assignment-1",
      assignmentVersion: 1,
      slot: 0,
      modelVersionId: "claude-opus-5@2026-06-01",
      provider: "claude",
      model: "claude-opus-5",
      release: "2026-06-01",
      transportKind: "CLI_SUBSCRIPTION",
      watermarks: [
        {
          projectionName: "model_version_read_model",
          sourceStream: "registry_events",
          appliedThroughSequence: 2,
          eventCount: 2,
          sourceHeadSha256: "c".repeat(64),
        },
      ],
    },
    ...overrides,
  };
}

function intakeEvent(
  payload: Record<string, unknown> = intakePayload(),
  overrides: Partial<ControlPlaneEvent> = {},
): ControlPlaneEvent {
  const taskId = overrides.taskId ?? INTAKE_TASK;
  return executionEvent("TASK_DISCOVERED", payload, {
    taskId,
    transitionId: TASK_INTAKE_TRANSITION_ID,
    idempotencyKey: buildV2IdempotencyKey({
      stream: "control_plane_events",
      taskId,
      revisionNumber: 1,
      attemptNumber: 1,
      transitionId: TASK_INTAKE_TRANSITION_ID,
    }),
    fromState: null,
    toState: "DISCOVERED",
    ...overrides,
  });
}

describe("the intake payload is closed, and anything else is not an intake (P-14 C)", () => {
  it("reads every declared key back, and names no other", () => {
    const read = taskIntakePayloadOf(intakeEvent());
    expect(read).not.toBeNull();
    expect(Object.keys(read ?? {}).sort()).toEqual(
      TASK_INTAKE_PAYLOAD_KEYS.filter((key) => key !== "restoredFromRevisionId").sort(),
    );
    expect(read?.resolution.watermarks).toHaveLength(1);
  });

  it("is not an intake under another transition, type or origin state", () => {
    expect(taskIntakePayloadOf(intakeEvent(intakePayload(), { transitionId: "discovered" }))).toBeNull();
    expect(taskIntakePayloadOf(intakeEvent(intakePayload(), { type: "TASK_CLASSIFIED" }))).toBeNull();
    expect(taskIntakePayloadOf(intakeEvent(intakePayload(), { fromState: "DISCOVERED" }))).toBeNull();
  });

  it("folds a stray key, a missing key, a half roadmap link or an empty vector as no intake at all", () => {
    const partial = intakePayload();
    delete partial["commitPolicy"];
    for (const payload of [
      intakePayload({ objective: "never in the stream" }),
      partial,
      intakePayload({ roadmapVersionId: "66666666-6666-4666-8666-666666666601" }),
      intakePayload({ stepId: "step.one" }),
      intakePayload({ role: "janitor" }),
      intakePayload({ clientScope: "has space" }),
      intakePayload({ restoredFromRevisionId: "rev-0" }),
      intakePayload({ resolution: { ...(intakePayload()["resolution"] as Record<string, unknown>), watermarks: [] } }),
      intakePayload({ resolution: { ...(intakePayload()["resolution"] as Record<string, unknown>), fallbacks: [] } }),
    ]) {
      expect(taskIntakePayloadOf(intakeEvent(payload)), JSON.stringify(Object.keys(payload))).toBeNull();
    }
    const linked = intakePayload({ roadmapVersionId: "66666666-6666-4666-8666-666666666601", stepId: "step.one" });
    expect(taskIntakePayloadOf(intakeEvent(linked))?.stepId).toBe("step.one");
  });
});

describe("the client key row and the three task columns fold from one intake (P-14 C)", () => {
  it("reads the key row's digest from the revision record, and its task from the event", () => {
    const event = intakeEvent();
    const submission = nextTaskSubmissionProjection(event, 7);
    const revision = nextTaskRevisionProjection(event, 7);
    expect(submission).toEqual({
      clientScope: "claude/opus/implementer/01",
      clientRequestKey: "intake-0001",
      taskId: INTAKE_TASK,
      revisionNumber: revision?.revisionNumber,
      envelopeSha256: revision?.envelopeSha256,
      sequence: 7,
      createdAt: event.occurredAt,
    });
    expect(nextTaskSubmissionProjection(executionEvent("TASK_DISCOVERED", intakePayload(), { fromState: null }), 7)).toBeNull();
  });

  it("writes step, role and commit policy once, and carries them past every later event", () => {
    const linked = intakeEvent(intakePayload({ roadmapVersionId: "66666666-6666-4666-8666-666666666601", stepId: "step.one" }));
    const first = nextTaskProjection(null, linked, 1);
    expect([first.stepId, first.role, first.commitPolicy]).toEqual(["step.one", "implementer", "NO_COMMIT"]);
    const later = nextTaskProjection(first, executionEvent("TASK_CLASSIFIED", {}, { taskId: INTAKE_TASK }), 2);
    expect([later.stepId, later.role, later.commitPolicy]).toEqual(["step.one", "implementer", "NO_COMMIT"]);
    const legacy = nextTaskProjection(null, executionEvent("TASK_DISCOVERED", {}, { fromState: null }), 1);
    expect([legacy.stepId, legacy.role, legacy.commitPolicy]).toEqual([null, null, null]);
  });

  it("refuses a second row under one key that names another task, by name, in the snapshot as at the door", () => {
    const snapshot = createProjectionSnapshot();
    applyEventToSnapshot(snapshot, intakeEvent(), 1, EVENT_SHA256);
    expect(snapshot.taskSubmissions.size).toBe(1);
    let thrown: unknown;
    try {
      applyEventToSnapshot(snapshot, intakeEvent(intakePayload(), { taskId: OTHER_INTAKE_TASK }), 2, EVENT_SHA256);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LedgerIdempotencyConflictError);

    const one = nextTaskSubmissionProjection(intakeEvent(), 1);
    const again = nextTaskSubmissionProjection(intakeEvent(), 9);
    if (one === null || again === null) throw new Error("expected two rows");
    // The birth attributes stay out of the comparison: a replay arrives elsewhere.
    expect(() => {
      assertSameTaskSubmission(one, again);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// P-32/captura B — the usage readers and the one capture function
// ---------------------------------------------------------------------------

/** A lawful stream declaration payload for `seg-1` at attempt 1 of revision 1. */
function usageStreamPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const coordinate = { source: "claude-code/stream-json", accountId: "acct-1", routeSegmentId: "seg-1", sourceEpoch: 0 };
  return {
    revisionNumber: 1,
    attemptNumber: 1,
    usageStream: {
      measurementStreamId: measurementStreamIdV1(coordinate),
      ...coordinate,
      sourceClass: "WRAPPER_MEASURED",
      normalizationPolicySha256: "c".repeat(64),
      ...overrides,
    },
  };
}

/** A lawful DELTA over `[0, 10)` on that stream, for the delivered effect. */
function usageObservationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revisionNumber: 1,
    attemptNumber: 1,
    usageObservation: {
      observationId: "obs-0",
      measurementStreamId: measurementStreamIdV1({
        source: "claude-code/stream-json",
        accountId: "acct-1",
        routeSegmentId: "seg-1",
        sourceEpoch: 0,
      }),
      ordinal: 0,
      sourceObservationId: "src-0",
      reportKind: "DELTA",
      rangeFromCounter: 0,
      rangeToCounter: 10,
      effectId: OCCURRENCE_EFFECT,
      isFinal: 1,
      inputTokens: 6,
      outputTokens: 4,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 10,
      occurredAt: "2026-09-13T09:00:00.000Z",
      ...overrides,
    },
  };
}

describe("the usage readers are gated, closed and recompute the stream's identity (P-32/captura B)", () => {
  it("reads nothing for any other type, and closes both records at their declared keys", () => {
    expect(readUsageStreamDeclaration(executionEvent("TOKEN_USAGE_RECORDED", usageStreamPayload()), 1)).toBeNull();
    expect(readUsageObservation(executionEvent("TOKEN_USAGE_RECORDED", usageObservationPayload()), 1)).toBeNull();
    expect([...USAGE_STREAM_RECORD_KEYS].sort()).toEqual(
      Object.keys((usageStreamPayload()["usageStream"] as Record<string, unknown>)).sort(),
    );
    expect(USAGE_OBSERVATION_RECORD_KEYS).toHaveLength(16);
    expect(USAGE_OBSERVATION_RECORD_KEYS).not.toContain("recordedAt");
    expect(USAGE_OBSERVATION_RECORD_KEYS).not.toContain("sourceClass");

    const stream = readUsageStreamDeclaration(executionEvent("USAGE_STREAM_DECLARED", usageStreamPayload()), 7);
    expect(stream?.kind === "row" ? stream.row.sequence : null).toBe(7);
    const observation = readUsageObservation(executionEvent("USAGE_OBSERVATION_RECORDED", usageObservationPayload()), 8);
    expect(observation?.kind === "row" ? [observation.row.recordedAt, observation.row.sequence] : null).toEqual([
      "2026-09-12T09:00:01.000Z",
      8,
    ]);
  });

  it("N-P32B-1: refuses an id that is not the digest of the coordinate, whatever else is right", () => {
    for (const change of [{ sourceEpoch: 1 }, { accountId: "acct-2" }, { measurementStreamId: "a".repeat(64) }]) {
      const reading = readUsageStreamDeclaration(executionEvent("USAGE_STREAM_DECLARED", usageStreamPayload(change)), 1);
      expect(reading?.kind, JSON.stringify(change)).toBe("refused");
      expect(reading?.kind === "refused" ? reading.path : "", JSON.stringify(change)).toBe(
        "payload.usageStream.measurementStreamId",
      );
    }
  });

  it("N-P32B-28, N-P32B-30: refuses a stray key, a moved state and a count that is not a safe integer", () => {
    const refusedAt = (event: ControlPlaneEvent): string => {
      const reading = readUsageObservation(event, 1);
      return reading?.kind === "refused" ? reading.path : "not refused";
    };
    expect(refusedAt(executionEvent("USAGE_OBSERVATION_RECORDED", { ...usageObservationPayload(), prompt: "x" }))).toBe(
      "payload.prompt",
    );
    expect(refusedAt(executionEvent("USAGE_OBSERVATION_RECORDED", usageObservationPayload({ provider: "x" })))).toBe(
      "payload.usageObservation.provider",
    );
    expect(
      refusedAt(executionEvent("USAGE_OBSERVATION_RECORDED", usageObservationPayload(), { toState: "READY" })),
    ).toBe("toState");
    expect(refusedAt(executionEvent("USAGE_OBSERVATION_RECORDED", usageObservationPayload({ inputTokens: 1.5 })))).toBe(
      "payload.usageObservation.inputTokens",
    );
    expect(refusedAt(executionEvent("USAGE_OBSERVATION_RECORDED", usageObservationPayload({ totalTokens: 11 })))).toBe(
      "payload.usageObservation.totalTokens",
    );
  });
});

describe("one capture function folds usage for the door, the rebuild and the migration (P-32/captura B)", () => {
  it("H-5: the first delivery exposes its effect once, cut at the digest it is handed, and a later delivery writes nothing", () => {
    const snapshot = snapshotWithDelivery();
    expect([...snapshot.usageSettlements.values()]).toEqual([
      expect.objectContaining({ settlementRevision: 1, settlementStatus: "UNKNOWN", totalTokens: null, sequence: 2 }),
    ]);
    expect([...snapshot.usageSettlementSourceHeads.values()]).toEqual([
      { effectId: OCCURRENCE_EFFECT, settlementRevision: 1, sourceStream: "control_plane_events", sourceSequence: 2, sourceSha256: EVENT_SHA256 },
    ]);
    const second = executionEvent("DISPATCH_INTENDED", {
      revisionNumber: 1,
      attemptNumber: 1,
      segment: segment(),
      dispatch: { dispatchAttemptId: "dsp-2", effectId: OCCURRENCE_EFFECT, attemptOrdinal: 2, catalogDocumentId: "catalog-fixture", catalogVersion: 1 },
    });
    // Never by the ordinal: the question is whether the effect has a revision.
    expect(nextUsageCapture(usageSnapshotView(snapshot), second, 3, "f".repeat(64))).toBeNull();
  });

  it("folds a stream, then a report into revision 2 with its own cut, and a restatement of either into nothing", () => {
    const snapshot = snapshotWithDelivery();
    applyEventToSnapshot(snapshot, executionEvent("USAGE_STREAM_DECLARED", usageStreamPayload()), 3, EVENT_SHA256);
    const report = executionEvent("USAGE_OBSERVATION_RECORDED", usageObservationPayload());
    const writes = nextUsageCapture(usageSnapshotView(snapshot), report, 4, "9".repeat(64));
    expect(writes?.settlement?.header).toEqual(
      expect.objectContaining({ settlementRevision: 2, settlementStatus: "FINAL", totalTokens: 10n, lastObservationId: "obs-0", sequence: 4 }),
    );
    expect(writes?.settlement?.sourceHeads).toEqual([
      { effectId: OCCURRENCE_EFFECT, settlementRevision: 2, sourceStream: "control_plane_events", sourceSequence: 4, sourceSha256: "9".repeat(64) },
    ]);
    applyEventToSnapshot(snapshot, report, 4, "9".repeat(64));
    expect(nextUsageCapture(usageSnapshotView(snapshot), report, 5, "8".repeat(64))).toBeNull();
    expect(
      nextUsageCapture(usageSnapshotView(snapshot), executionEvent("USAGE_STREAM_DECLARED", usageStreamPayload()), 6, "7".repeat(64)),
    ).toBeNull();
    expect(snapshot.usageSettlements.size).toBe(2);
  });

  it("compares a count as text, so a bigint row and its stored integer agree and 2^53 + 1 is not 2^53", () => {
    expect(usageRowText({ total: 9007199254740993n, sequence: 4 })).toBe(usageRowText({ total: 9007199254740993n, sequence: 4n }));
    expect(usageRowText({ total: 9007199254740993n })).not.toBe(usageRowText({ total: 9007199254740992n }));
    expect(usageRowText({ total: null })).toBe('{"total":null}');
  });
});

// ---------------------------------------------------------------------------
// P-07 escalón B — the result pair is read present-invalid, and compared once
// (ADR 0098)
// ---------------------------------------------------------------------------

/** A resolution that settles `dsp-1` with `status`, stamped `contractVersion`. */
function resultOutcomeEvent(
  record: Record<string, unknown>,
  contractVersion: string = CONTRACT_VERSION,
): ControlPlaneEvent {
  return executionEvent(
    "DISPATCH_OUTCOME_RECORDED",
    { revisionNumber: 1, attemptNumber: 1, outcome: { dispatchAttemptId: "dsp-1", dispatchState: "SETTLED", terminalAt: SETTLED_AT, ...record } },
    { contractVersion } as Partial<ControlPlaneEvent>,
  );
}

function refusalOf(reading: ReturnType<typeof dispatchOutcomeRecord>): { path: string; message: string } | null {
  return reading?.kind === "refused" ? { path: reading.path, message: reading.message } : null;
}

describe("P-07 B: a resolution names its result by reference and digest, by cohort", () => {
  it("P-P07B-6: the cohort before is the six versions no earlier build could stamp with a result", () => {
    expect([...PRE_RESULT_REFERENCE_CONTRACT_VERSIONS]).toEqual(["2.2.0", "2.3.0", "2.4.0", "2.5.0", "2.6.0", "2.7.0"]);
    expect(PRE_RESULT_REFERENCE_CONTRACT_VERSIONS).not.toContain(CONTRACT_VERSION);
  });

  it("reads the pair into the record, and null/null where there is none", () => {
    const succeeded = dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR }), 4);
    expect(succeeded?.kind === "record" ? succeeded.record : null).toMatchObject({
      effectOutcomeStatus: "SUCCEEDED",
      resultArtifactReferenceId: RESULT_PAIR.resultArtifactReferenceId,
      resultSha256: RESULT_PAIR.resultSha256,
    });
    // FAILED is admitted with a pair and without one.
    const failedBare = dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: "FAILED" }), 4);
    expect(failedBare?.kind === "record" ? [failedBare.record.resultArtifactReferenceId, failedBare.record.resultSha256] : null).toEqual([null, null]);
    expect(dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: "FAILED", ...RESULT_PAIR }), 4)?.kind).toBe("record");
    // A SUCCEEDED of the cohort before still reads without one.
    expect(dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: "SUCCEEDED" }, "2.7.0"), 4)?.kind).toBe("record");
  });

  it("N-P07B-4: a SUCCEEDED of a later version without a result is refused by name", () => {
    const refused = refusalOf(dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: "SUCCEEDED" }), 4));
    expect(refused?.path).toBe("payload.outcome.resultArtifactReferenceId");
    expect(refused?.message).toContain("a SUCCEEDED outcome of contract version " + CONTRACT_VERSION);
    expect(refused?.message).toContain("names none");
  });

  it("N-P07B-5: a pair on an outcome of the cohort before is refused", () => {
    for (const version of PRE_RESULT_REFERENCE_CONTRACT_VERSIONS) {
      const refused = refusalOf(
        dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR }, version), 4),
      );
      expect(refused?.path, version).toBe("payload.outcome.resultArtifactReferenceId");
      expect(refused?.message, version).toContain("contract version " + version + " names no result");
    }
  });

  it("N-P07B-6: a result on CANCELLED, on OUTCOME_UNKNOWN, or with no outcome is refused", () => {
    for (const status of ["CANCELLED", "OUTCOME_UNKNOWN"]) {
      const refused = refusalOf(dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: status, ...RESULT_PAIR }), 4));
      expect(refused?.path, status).toBe("payload.outcome.resultArtifactReferenceId");
      expect(refused?.message, status).toContain("effect outcome " + status + " carries no result");
    }
    const bare = refusalOf(dispatchOutcomeRecord(resultOutcomeEvent({ ...RESULT_PAIR }), 4));
    expect(bare?.message).toContain("a result is recorded with the effect's outcome");
    // And each of the two may carry one.
    for (const status of ["SUCCEEDED", "FAILED"]) {
      expect(dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: status, ...RESULT_PAIR }), 4)?.kind, status).toBe("record");
    }
  });

  it("N-P07B-7: each key present-invalid is refused at its own path, never read as absent, never echoed", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["resultArtifactReferenceId", null],
      ["resultArtifactReferenceId", ""],
      ["resultArtifactReferenceId", 42],
      ["resultArtifactReferenceId", {}],
      ["resultSha256", null],
      ["resultSha256", ""],
      ["resultSha256", 42],
      ["resultSha256", {}],
      ["resultSha256", "d".repeat(63)],
      ["resultSha256", "D".repeat(64)],
    ];
    for (const [key, value] of cases) {
      const refused = refusalOf(
        dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR, [key]: value }), 4),
      );
      const label = key + " = " + JSON.stringify(value);
      expect(refused?.path, label).toBe("payload.outcome." + key);
      expect(refused?.message, label).toContain(key + ", when present,");
      if (typeof value === "string" && value.length > 0) expect(refused?.message, label).not.toContain(value);
    }
    // Half a pair is refused at the key that is missing.
    const noDigest = refusalOf(
      dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: "FAILED", resultArtifactReferenceId: "ref-response-1" }), 4),
    );
    expect(noDigest?.path).toBe("payload.outcome.resultSha256");
    const noReference = refusalOf(
      dispatchOutcomeRecord(resultOutcomeEvent({ effectOutcomeStatus: "FAILED", resultSha256: "d".repeat(64) }), 4),
    );
    expect(noReference?.path).toBe("payload.outcome.resultArtifactReferenceId");
  });

  it("the pair is compared once: write, replay, and a conflict under another digest or reference", () => {
    const snapshot = snapshotWithDelivery();
    const stored = snapshot.effects.get(OCCURRENCE_EFFECT);
    if (stored === undefined) throw new Error("the fixture holds its effect");
    const arriving = (record: Record<string, unknown>, version?: string) => {
      const reading = dispatchOutcomeRecord(resultOutcomeEvent(record, version), 4);
      if (reading?.kind !== "record") throw new Error("expected a record");
      return reading.record;
    };
    const first = arriving({ effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR });
    expect(effectOutcomeArrival(stored, first)).toEqual({ kind: "write" });
    const ended = {
      ...stored,
      outcomeStatus: "SUCCEEDED" as const,
      outcomeRecordedAt: SETTLED_AT,
      outcomeContractVersion: CONTRACT_VERSION,
      resultArtifactReferenceId: RESULT_PAIR.resultArtifactReferenceId,
      resultSha256: RESULT_PAIR.resultSha256,
    };
    expect(effectOutcomeArrival(ended, first)).toEqual({ kind: "replay" });

    const otherDigest = effectOutcomeArrival(ended, arriving({ effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR, resultSha256: "e".repeat(64) }));
    expect(otherDigest.kind === "refused" ? otherDigest.path : null).toBe("payload.outcome.resultSha256");
    const otherReference = effectOutcomeArrival(
      ended,
      arriving({ effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR, resultArtifactReferenceId: "ref-response-2" }),
    );
    expect(otherReference.kind === "refused" ? otherReference.path : null).toBe("payload.outcome.resultArtifactReferenceId");
    const otherStatus = effectOutcomeArrival(ended, arriving({ effectOutcomeStatus: "FAILED" }));
    expect(otherStatus.kind === "refused" ? otherStatus.message : "").toContain("already ended SUCCEEDED");
    for (const refused of [otherDigest, otherReference, otherStatus]) {
      expect(refused.kind === "refused" ? refused.message : "").toContain("an outcome is recorded once rather than amended");
    }

    // A row of the cohort before, holding no pair, meeting a pair is refused too
    // (adjudication v2, C2): not identical is not a replay.
    const priorCohort = { ...ended, outcomeContractVersion: "2.7.0", resultArtifactReferenceId: null, resultSha256: null };
    expect(effectOutcomeArrival(priorCohort, first).kind).toBe("refused");
    expect(effectOutcomeArrival(priorCohort, arriving({ effectOutcomeStatus: "SUCCEEDED" }, "2.7.0"))).toEqual({ kind: "replay" });
  });

  it("the fold writes the version and the pair with the outcome, and refuses a conflict in the door's words", () => {
    const snapshot = snapshotWithDelivery();
    applyEventToSnapshot(snapshot, resultOutcomeEvent({ effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR }), 3, EVENT_SHA256);
    expect(snapshot.effects.get(OCCURRENCE_EFFECT)).toMatchObject({
      outcomeStatus: "SUCCEEDED",
      outcomeContractVersion: CONTRACT_VERSION,
      resultArtifactReferenceId: RESULT_PAIR.resultArtifactReferenceId,
      resultSha256: RESULT_PAIR.resultSha256,
    });
    // The same outcome again is a replay: nothing moves.
    applyEventToSnapshot(snapshot, resultOutcomeEvent({ effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR }), 4, EVENT_SHA256);
    expect(snapshot.effects.get(OCCURRENCE_EFFECT)?.resultSha256).toBe(RESULT_PAIR.resultSha256);
    let issue: { path: string; message: string } | undefined;
    try {
      applyEventToSnapshot(
        snapshot,
        resultOutcomeEvent({ effectOutcomeStatus: "SUCCEEDED", ...RESULT_PAIR, resultSha256: "e".repeat(64) }),
        5,
        EVENT_SHA256,
      );
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.path).toBe("payload.outcome.resultSha256");
    expect(issue?.message).toContain("already ended SUCCEEDED under another result digest");
    // A resolution that leaves the effect open writes none of the three.
    const open = snapshotWithDelivery();
    applyEventToSnapshot(open, outcomeEvent({ dispatchState: "CLAIMED" }), 3, EVENT_SHA256);
    expect(open.effects.get(OCCURRENCE_EFFECT)).toMatchObject({
      outcomeStatus: null,
      outcomeContractVersion: null,
      resultArtifactReferenceId: null,
      resultSha256: null,
    });
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón C — the dispatch pin reads three ways, by cohort (ADR 0103)
// ---------------------------------------------------------------------------

describe("the dispatch pin reads three ways, by cohort, and the fold refuses what the reader refuses (P-15 escalón C)", () => {
  const ABSENT = Symbol("absent");
  const DOCUMENTS: readonly unknown[] = [ABSENT, null, "", 1, {}, "doc"];
  const NUMBERS: readonly unknown[] = [ABSENT, null, 0, -1, "1", 1.5, 2 ** 53, 1];
  const COHORT_AFTER = ["2.9.0"];

  function dispatchEvent(version: string, document: unknown, number: unknown): ControlPlaneEvent {
    const dispatch: Record<string, unknown> = { dispatchAttemptId: "dsp-1", effectId: "a".repeat(64), attemptOrdinal: 1 };
    if (document !== ABSENT) dispatch["catalogDocumentId"] = document;
    if (number !== ABSENT) dispatch["catalogVersion"] = number;
    return executionEvent(
      "DISPATCH_INTENDED",
      { revisionNumber: 1, attemptNumber: 1, segment: segment(), dispatch },
      { contractVersion: version as ControlPlaneEvent["contractVersion"] },
    );
  }

  /** The rule, restated from the ADR: what the reader must answer for one cell. */
  function oracle(version: string, document: unknown, number: unknown): "none" | "pin" | "refused" {
    const documentOk = typeof document === "string" && document.length > 0;
    const numberOk = typeof number === "number" && Number.isSafeInteger(number) && number >= 1;
    if (document !== ABSENT && !documentOk) return "refused";
    if (number !== ABSENT && !numberOk) return "refused";
    if ((document === ABSENT) !== (number === ABSENT)) return "refused";
    const before = PRE_CATALOG_PIN_CONTRACT_VERSIONS.includes(version);
    if (document === ABSENT) return before ? "none" : "refused";
    return before ? "refused" : "pin";
  }

  it("answers every cell of cohort x document x version as the rule does, and never reads present-invalid as absent", () => {
    let cells = 0;
    for (const version of [...PRE_CATALOG_PIN_CONTRACT_VERSIONS, ...COHORT_AFTER]) {
      for (const document of DOCUMENTS) {
        for (const number of NUMBERS) {
          cells += 1;
          const reading = dispatchPinReading(dispatchEvent(version, document, number));
          const got = reading === null ? "null" : reading.kind === "refused" ? "refused" : reading.pin === null ? "none" : "pin";
          const cell = JSON.stringify([version, document === ABSENT ? "absent" : document, number === ABSENT ? "absent" : number]);
          expect({ cell, got }).toEqual({ cell, got: oracle(version, document, number) });
          // A projected row exists exactly when the reading is not a refusal.
          const row = nextDispatchAttemptProjection(dispatchEvent(version, document, number), 6);
          expect({ cell, row: row !== null }).toEqual({ cell, row: got !== "refused" });
          if (row !== null) {
            expect(row.dispatchContractVersion).toBe(version);
            expect([row.catalogDocumentId, row.catalogVersion]).toEqual(got === "pin" ? [document, number] : [null, null]);
          }
        }
      }
    }
    expect(cells).toBe(8 * 6 * 8);
  });

  it("the fold refuses a refused pin with the reader's words, and folds a lawful one", () => {
    const refused = dispatchEvent("2.9.0", null, 1);
    const reading = dispatchPinReading(refused);
    if (reading?.kind !== "refused") throw new Error("expected a refusal");
    let error: unknown = null;
    try {
      applyEventToSnapshot(createProjectionSnapshot(), refused, 6, "f".repeat(64));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as LedgerValidationError).issues[0]).toEqual({ path: reading.path, message: reading.message });
  });

  it("the birth carries the pin: another pin is another intention, the same one a replay", () => {
    const one = nextDispatchAttemptProjection(dispatchEvent("2.9.0", "doc", 1), 6);
    const again = nextDispatchAttemptProjection(dispatchEvent("2.9.0", "doc", 1), 9);
    const other = nextDispatchAttemptProjection(dispatchEvent("2.9.0", "doc", 2), 6);
    if (one === null || again === null || other === null) throw new Error("expected three rows");
    expect(canonicalDispatchBirth(one)).toBe(canonicalDispatchBirth(again));
    expect(canonicalDispatchBirth(one)).not.toBe(canonicalDispatchBirth(other));
  });
});

/**
 * The roadmap-version fold refuses by name, on both keys, for the rebuild and the
 * live step alike (P-26/A, ADR 0110; Fable C2).
 *
 * Pure: the snapshot is the rebuild's, folded here event by event. `test/ledger`
 * plants the same histories in a real stream and rebuilds them.
 */
describe("the roadmap-version fold refuses a second claim and a malformed payload by name (P-26/A)", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";
  const OTHER = "55555555-5555-4555-8555-555555555555";
  const V1 = "66666666-6666-4666-8666-666666666601";
  const V2 = "66666666-6666-4666-8666-666666666602";

  function version(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      contractVersion: CONTRACT_VERSION,
      roadmapVersionId: V1,
      initiativeId: INITIATIVE,
      version: 1,
      contentDigest: "a".repeat(64),
      parentVersionId: null,
      expectedHeadDigest: null,
      kind: "EDIT",
      restoresVersionId: null,
      recordedBy: "kimi/k3/coordinator/01",
      recordedAt: "2026-09-24T12:00:00.000Z",
      stepCount: 0,
      stepManifestArtifactReferenceId: null,
      stepManifestSha256: null,
      ...overrides,
    };
  }

  function recorded(transitionId: string, payload: Record<string, unknown>, initiativeId = INITIATIVE): InitiativeEvent {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "77777777-7777-4777-8777-7777777777" + String(transitionId.length).padStart(2, "0"),
      initiativeId,
      transitionId,
      idempotencyKey: initiativeId + "/1/" + transitionId,
      type: "ROADMAP_VERSION_RECORDED",
      fromStatus: "ACTIVE",
      toStatus: "ACTIVE",
      emittedBy: "kimi/k3/coordinator/01",
      occurredAt: "2026-09-24T12:00:00.000Z",
      recordedAt: "2026-09-24T12:00:00.000Z",
      payload,
    } as InitiativeEvent;
  }

  const SUCCESSOR = { roadmapVersionId: V2, version: 2, contentDigest: "b".repeat(64), parentVersionId: V1, expectedHeadDigest: "a".repeat(64) };

  function refusal(action: () => unknown): { readonly reason: string; readonly at: string } {
    try {
      action();
    } catch (error: unknown) {
      if (error instanceof LedgerRoadmapVersionRefusedError) return { reason: error.reason, at: error.at };
      throw error;
    }
    throw new Error("expected a named refusal");
  }

  it("refuses a payload that does not parse, and one naming another initiative, where it used to project nothing", () => {
    expect(refusal(() => nextRoadmapVersionProjection(recorded("roadmap.bad", { note: "no version" }), 2)).reason).toBe("REQUEST_INVALID");
    expect(refusal(() => nextRoadmapVersionProjection(recorded("roadmap.v1", version({ kind: "REWRITE" })), 2))).toEqual({
      reason: "REQUEST_INVALID",
      at: "candidate.kind",
    });
    expect(refusal(() => nextRoadmapVersionProjection(recorded("roadmap.v1", version({ initiativeId: OTHER })), 2))).toEqual({
      reason: "REQUEST_INVALID",
      at: "candidate.initiativeId",
    });
    // Any other type is still no row, never a refusal.
    expect(nextRoadmapVersionProjection({ ...recorded("x", {}), type: "INITIATIVE_STATE_CHANGED" } as InitiativeEvent, 2)).toBeNull();
  });

  it("refuses a second claim on an identity, and a second claim on a number, in the rebuild's snapshot", () => {
    const byId = createInitiativeProjectionSnapshot();
    applyInitiativeEventToSnapshot(byId, recorded("roadmap.v1", version()), 2);
    const firstRow = byId.roadmapVersions.get(V1);
    expect(refusal(() => {
      applyInitiativeEventToSnapshot(byId, recorded("roadmap.v2", version({ ...SUCCESSOR, roadmapVersionId: V1 })), 3);
    })).toEqual({
      reason: "VERSION_ID_REUSED",
      at: "candidate.roadmapVersionId",
    });
    // The first row is never overwritten: the map a rebuild writes from still holds it.
    expect(byId.roadmapVersions.get(V1)).toEqual(firstRow);
    expect(byId.roadmapVersions.size).toBe(1);

    const byNumber = createInitiativeProjectionSnapshot();
    applyInitiativeEventToSnapshot(byNumber, recorded("roadmap.v1", version()), 2);
    expect(refusal(() => {
      applyInitiativeEventToSnapshot(byNumber, recorded("roadmap.v1b", version({ roadmapVersionId: V2 })), 3);
    })).toEqual({
      reason: "VERSION_NOT_MONOTONIC",
      at: "candidate.version",
    });
    expect(byNumber.roadmapVersions.size).toBe(1);
  });

  it("folds a clean history to the same rows twice, and one number in each of two initiatives is not a duplicate", () => {
    const fold = (): readonly unknown[] => {
      const snapshot = createInitiativeProjectionSnapshot();
      applyInitiativeEventToSnapshot(snapshot, recorded("roadmap.v1", version()), 2);
      applyInitiativeEventToSnapshot(snapshot, recorded("roadmap.v2", version(SUCCESSOR)), 3);
      applyInitiativeEventToSnapshot(
        snapshot,
        recorded("roadmap.v1", version({ roadmapVersionId: "66666666-6666-4666-8666-666666666603", initiativeId: OTHER }), OTHER),
        4,
      );
      return [...snapshot.roadmapVersions.values()];
    };
    const once = fold();
    expect(once).toHaveLength(3);
    expect(fold()).toEqual(once);
  });

  it("asks both keys of whatever holds the fold, identity first", () => {
    const row = nextRoadmapVersionProjection(recorded("roadmap.v1", version()), 2);
    if (row === null) throw new Error("expected a row");
    const asked: string[] = [];
    const holder = (id: boolean, number: boolean) => ({
      hasVersionId: (value: string) => (asked.push("id:" + value), id),
      hasVersionNumber: (initiativeId: string, value: number) => (asked.push("number:" + initiativeId + ":" + String(value)), number),
    });
    expect(refusal(() => {
      assertRoadmapVersionUnfolded(row, holder(true, true));
    }).reason).toBe("VERSION_ID_REUSED");
    expect(refusal(() => {
      assertRoadmapVersionUnfolded(row, holder(false, true));
    }).reason).toBe("VERSION_NOT_MONOTONIC");
    asked.length = 0;
    assertRoadmapVersionUnfolded(row, holder(false, false));
    expect(asked).toEqual(["id:" + V1, "number:" + INITIATIVE + ":1"]);
  });
});

// ---------------------------------------------------------------------------
// P-27 cut A: the task graph fold, from the payloads only (ADR 0115)
// ---------------------------------------------------------------------------

describe("the task graph fold (P-27 cut A)", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";
  const VERSION = "11111111-1111-4111-8111-111111111111";
  const G1 = "55555555-5555-4555-8555-555555555551";
  const G2 = "55555555-5555-4555-8555-555555555552";
  const T1 = "66666666-6666-4666-8666-666666666661";
  const T2 = "66666666-6666-4666-8666-666666666662";
  const AT = "2026-09-25T12:00:00.000Z";
  const EMITTED_BY = "claude/opus/coordinator/01";

  function event(type: string, payload: Record<string, unknown>): InitiativeEvent {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "0000bbbb-0000-4000-8000-000000000001",
      initiativeId: INITIATIVE,
      transitionId: "graph.x",
      idempotencyKey: INITIATIVE + "/1/graph.x",
      type,
      fromStatus: "ACTIVE",
      toStatus: "ACTIVE",
      emittedBy: EMITTED_BY,
      occurredAt: AT,
      recordedAt: AT,
      payload,
    } as unknown as InitiativeEvent;
  }
  const header = (graphRevisionId: string, supersedes: string | null, nodeCount: number) =>
    event("TASK_GRAPH_DECLARED", { graphRevisionId, roadmapVersionId: VERSION, stepId: "B", supersedesGraphRevisionId: supersedes, nodeCount });
  const node = (graphRevisionId: string, taskId: string, nodeIndex: number, dependsOn: readonly string[] = []) =>
    event("TASK_GRAPH_NODE_DECLARED", {
      graphRevisionId,
      taskId,
      taskRevisionNumber: 1,
      nodeIndex,
      dependsOn: dependsOn.map((id) => ({ taskId: id, taskRevisionNumber: 1, failPolicy: "REQUIRE_TERMINAL" })),
    });

  function history(fold: ReturnType<typeof createTaskGraphFold>, declared = true) {
    return {
      stepDeclared: (initiativeId: string, roadmapVersionId: string, stepId: string) =>
        declared && initiativeId === INITIATIVE && roadmapVersionId === VERSION && stepId === "B",
      currentRevision: (roadmapVersionId: string, stepId: string) =>
        [...fold.taskGraphRevisions.values()].find(
          (revision) => revision.roadmapVersionId === roadmapVersionId && revision.stepId === stepId && revision.supersededBy === null,
        ),
      revisionHeld: () => false,
    };
  }

  function refusedBy(action: () => void): { readonly reason: string; readonly at: string } {
    try {
      action();
    } catch (error: unknown) {
      if (error instanceof LedgerTaskGraphRefusedError) return { reason: error.reason, at: error.at };
      throw error;
    }
    throw new Error("expected a refusal");
  }

  it("folds a revision, its nodes and, once the last node is in, its edges, with the step denormalized", () => {
    const fold = createTaskGraphFold();
    foldTaskGraph(fold, history(fold), header(G1, null, 2), 10);
    foldTaskGraph(fold, history(fold), node(G1, T2, 0, [T1]), 11);
    expect(fold.taskDependencies.size).toBe(0);
    foldTaskGraph(fold, history(fold), node(G1, T1, 1), 12);
    expect([...fold.taskGraphRevisions.values()]).toEqual([
      { graphRevisionId: G1, roadmapVersionId: VERSION, stepId: "B", declaredAt: AT, supersededBy: null, sequence: 10 },
    ]);
    expect([...fold.taskGraphNodes.keys()]).toEqual([taskGraphKey(G1, T2, "1"), taskGraphKey(G1, T1, "1")]);
    expect([...fold.taskDependencies.values()]).toEqual([
      {
        graphRevisionId: G1,
        taskId: T2,
        taskRevisionNumber: 1,
        dependsOnTaskId: T1,
        dependsOnTaskRevisionNumber: 1,
        failPolicy: "REQUIRE_TERMINAL",
        stepId: "B",
        sequence: 11,
      },
    ]);
    expect(() => {
      assertTaskGraphsComplete(fold);
    }).not.toThrow();
  });

  it("records a supersession, once, and holds the predecessor's row to it", () => {
    const fold = createTaskGraphFold();
    foldTaskGraph(fold, history(fold), header(G1, null, 1), 10);
    foldTaskGraph(fold, history(fold), node(G1, T1, 0), 11);
    foldTaskGraph(fold, history(fold), header(G2, G1, 1), 12);
    foldTaskGraph(fold, history(fold), node(G2, T1, 0), 13);
    expect([...fold.supersessions]).toEqual([[G1, G2]]);
    expect(fold.taskGraphRevisions.get(G1)?.supersededBy).toBe(G2);
    expect(fold.taskGraphRevisions.get(G2)?.supersededBy).toBeNull();
  });

  it("refuses by the door's words what the door refuses", () => {
    const unknownStep = createTaskGraphFold();
    expect(refusedBy(() => {
      foldTaskGraph(unknownStep, history(unknownStep, false), header(G1, null, 1), 10);
    })).toEqual({
      reason: "GRAPH_STEP_UNKNOWN",
      at: "header.stepId",
    });
    const stale = createTaskGraphFold();
    foldTaskGraph(stale, history(stale), header(G1, null, 1), 10);
    foldTaskGraph(stale, history(stale), node(G1, T1, 0), 11);
    expect(refusedBy(() => {
      foldTaskGraph(stale, history(stale), header(G2, null, 1), 12);
    })).toEqual({
      reason: "GRAPH_HEAD_MISMATCH",
      at: "header.supersedesGraphRevisionId",
    });
    expect(refusedBy(() => {
      foldTaskGraph(stale, history(stale), header(G1, G1, 1), 12);
    }).reason).toBe("GRAPH_DECLARATION_INVALID");
    const orphan = createTaskGraphFold();
    expect(refusedBy(() => {
      foldTaskGraph(orphan, history(orphan), node(G1, T1, 0), 11);
    })).toEqual({
      reason: "GRAPH_DECLARATION_INVALID",
      at: "node.graphRevisionId",
    });
    const order = createTaskGraphFold();
    foldTaskGraph(order, history(order), header(G1, null, 2), 10);
    expect(refusedBy(() => {
      foldTaskGraph(order, history(order), node(G1, T1, 1), 11);
    }).at).toBe("node.nodeIndex");
    foldTaskGraph(order, history(order), node(G1, T1, 0), 11);
    expect(refusedBy(() => {
      foldTaskGraph(order, history(order), node(G1, T1, 1), 12);
    }).at).toBe("node.taskId");
    expect(refusedBy(() => {
      foldTaskGraph(order, history(order), node(G1, T2, 1, ["77777777-7777-4777-8777-777777777777"]), 12);
    }).at).toBe(
      "node.dependsOn",
    );
    const short = createTaskGraphFold();
    foldTaskGraph(short, history(short), header(G1, null, 2), 10);
    foldTaskGraph(short, history(short), node(G1, T1, 0), 11);
    expect(refusedBy(() => {
      assertTaskGraphsComplete(short);
    })).toEqual({ reason: "GRAPH_NODE_COUNT_MISMATCH", at: "header.nodeCount" });
    const over = createTaskGraphFold();
    foldTaskGraph(over, history(over), header(G1, null, 1), 10);
    foldTaskGraph(over, history(over), node(G1, T1, 0), 11);
    // After a clean close the entry is gone: a node of more is a node of no open revision.
    expect(refusedBy(() => {
      foldTaskGraph(over, history(over), node(G1, T2, 1), 12);
    })).toEqual({ reason: "GRAPH_DECLARATION_INVALID", at: "node.graphRevisionId" });
  });

  it("T-B5b: after a refusal captured at close the revision stays open, and a node of more is counted out by the guard, never stored (P-27 cut B)", () => {
    const fold = createTaskGraphFold();
    const T3 = "66666666-6666-4666-8666-666666666663";
    foldTaskGraph(fold, history(fold), header(G1, null, 2), 10);
    foldTaskGraph(fold, history(fold), node(G1, T1, 0), 11);
    expect(refusedBy(() => {
      foldTaskGraph(fold, history(fold), node(G1, T2, 1, ["77777777-7777-4777-8777-777777777777"]), 12);
    })).toEqual({ reason: "GRAPH_DECLARATION_INVALID", at: "node.dependsOn" });
    expect(fold.pendingTaskGraphs.has(G1)).toBe(true);
    expect(fold.taskGraphNodes.size).toBe(2);
    // The fold a check keeps folding into after the refusal (`verifyIntegrity()`).
    expect(refusedBy(() => {
      foldTaskGraph(fold, history(fold), node(G1, T3, 2), 13);
    })).toEqual({ reason: "GRAPH_NODE_COUNT_MISMATCH", at: "node.nodeIndex" });
    expect(fold.taskGraphNodes.size).toBe(2);
    expect(refusedBy(() => {
      assertTaskGraphsComplete(fold);
    })).toEqual({ reason: "GRAPH_NODE_COUNT_MISMATCH", at: "header.nodeCount" });
  });

  it("folds every other initiative type to no graph row", () => {
    const snapshot = createInitiativeProjectionSnapshot();
    applyInitiativeEventToSnapshot(snapshot, event("INITIATIVE_STATE_CHANGED", {}), 1);
    expect([snapshot.taskGraphRevisions.size, snapshot.taskGraphNodes.size, snapshot.taskDependencies.size]).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// P-27 cut B: the task graph fold counts its nodes and finds its head without a scan
// (decision 199; ADR 0115, residuals)
// ---------------------------------------------------------------------------

/**
 * A map that counts every enumeration made through its own methods: a spread,
 * `Array.from`, `for..of`, `values`, `keys`, `entries` and `forEach`. The iterator and
 * `entries` are overridden apart, because overriding one does not intercept the other.
 * `get`, `has`, `set`, `delete` and `size` are not enumerations. Declared limit: a scan
 * that calls `Map.prototype`'s methods on the map (`Map.prototype.values.call(map)`,
 * likewise `keys`, `entries`, `forEach` and `[Symbol.iterator]`) skips the overrides and
 * is not counted; nor is a scan of a private copy of the data or of another structure.
 */
class EnumerationCountingMap<K, V> extends Map<K, V> {
  enumerations = 0;

  override values(): MapIterator<V> {
    this.enumerations += 1;
    return super.values();
  }

  override keys(): MapIterator<K> {
    this.enumerations += 1;
    return super.keys();
  }

  override entries(): MapIterator<[K, V]> {
    this.enumerations += 1;
    return super.entries();
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    this.enumerations += 1;
    super.forEach(callback, thisArg);
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    this.enumerations += 1;
    return super[Symbol.iterator]();
  }
}

describe("the task graph fold counts its nodes and finds its head without a scan (P-27 cut B)", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";
  const V1 = "11111111-1111-4111-8111-111111111111";
  const V2 = "11111111-1111-4111-8111-111111111112";
  const G1 = "55555555-5555-4555-8555-555555555551";
  const G2 = "55555555-5555-4555-8555-555555555552";
  const G3 = "55555555-5555-4555-8555-555555555553";
  const G4 = "55555555-5555-4555-8555-555555555554";
  const G5 = "55555555-5555-4555-8555-555555555555";
  const G6 = "55555555-5555-4555-8555-555555555556";
  const G7 = "55555555-5555-4555-8555-555555555557";
  const AT = "2026-09-25T12:00:00.000Z";
  const EMITTED_BY = "claude/opus/coordinator/01";
  const DIGEST = "c".repeat(64);

  const task = (n: number): string => "66666666-6666-4666-8666-" + String(n).padStart(12, "0");

  function event(type: string, transitionId: string, payload: Record<string, unknown>): InitiativeEvent {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "0000cccc-0000-4000-8000-000000000001",
      initiativeId: INITIATIVE,
      transitionId,
      idempotencyKey: INITIATIVE + "/1/" + transitionId,
      type,
      fromStatus: "ACTIVE",
      toStatus: "ACTIVE",
      emittedBy: EMITTED_BY,
      occurredAt: AT,
      recordedAt: AT,
      payload,
    } as unknown as InitiativeEvent;
  }

  /** A 2.10.0 version declaring two steps, `B` and `C`, and those steps. */
  function versionEvents(roadmapVersionId: string, version: number, parentVersionId: string | null): readonly InitiativeEvent[] {
    return [
      event("ROADMAP_VERSION_RECORDED", "roadmap.v" + String(version), {
        contractVersion: CONTRACT_VERSION,
        roadmapVersionId,
        initiativeId: INITIATIVE,
        version,
        contentDigest: String(version).repeat(64),
        parentVersionId,
        expectedHeadDigest: parentVersionId === null ? null : String(version - 1).repeat(64),
        kind: "EDIT",
        restoresVersionId: null,
        recordedBy: EMITTED_BY,
        recordedAt: AT,
        stepCount: 2,
        stepManifestArtifactReferenceId: "ref-manifest-" + String(version),
        stepManifestSha256: DIGEST,
      }),
      ...["B", "C"].map((stepId, stepIndex) =>
        event("ROADMAP_STEP_DECLARED", "roadmap.v" + String(version) + ".step." + String(stepIndex), {
          roadmapVersionId,
          stepId,
          stepIndex,
          title: "Step " + stepId,
          objectiveSha256: DIGEST,
          acceptanceSha256: DIGEST,
          expectedWriteSetSha256: DIGEST,
          dependsOn: [],
          dependencyRank: 0,
        }),
      ),
    ];
  }

  const header = (graphRevisionId: string, roadmapVersionId: string, supersedes: string | null, nodeCount: number, stepId = "B") =>
    event("TASK_GRAPH_DECLARED", "graph." + graphRevisionId, {
      graphRevisionId,
      roadmapVersionId,
      stepId,
      supersedesGraphRevisionId: supersedes,
      nodeCount,
    });
  const node = (graphRevisionId: string, taskId: string, nodeIndex: number, dependsOn: readonly string[] = []) =>
    event("TASK_GRAPH_NODE_DECLARED", "graph." + graphRevisionId + ".node." + String(nodeIndex), {
      graphRevisionId,
      taskId,
      taskRevisionNumber: 1,
      nodeIndex,
      dependsOn: dependsOn.map((id) => ({ taskId: id, taskRevisionNumber: 1, failPolicy: "REQUIRE_TERMINAL" })),
    });

  /** A snapshot holding versions 1 and 2 of one initiative, each declaring steps `B` and `C`. */
  function seeded(snapshot: ReturnType<typeof createInitiativeProjectionSnapshot> = createInitiativeProjectionSnapshot()) {
    let sequence = 0;
    const apply = (value: InitiativeEvent): number => {
      sequence += 1;
      applyInitiativeEventToSnapshot(snapshot, value, sequence);
      return sequence;
    };
    for (const value of [...versionEvents(V1, 1, null), ...versionEvents(V2, 2, V1)]) apply(value);
    return { snapshot, apply };
  }

  function refusedBy(action: () => unknown): { readonly reason: string; readonly at: string } {
    try {
      action();
    } catch (error: unknown) {
      if (error instanceof LedgerTaskGraphRefusedError) return { reason: error.reason, at: error.at };
      throw error;
    }
    throw new Error("expected a refusal");
  }

  const heads = (snapshot: ReturnType<typeof createInitiativeProjectionSnapshot>) =>
    [...snapshot.taskGraphRevisions.values()].map((revision) => [revision.graphRevisionId, revision.roadmapVersionId, revision.supersededBy]);

  it("T-B1: folds three superseding revisions, one of 200 nodes, and a second version's, enumerating neither graph map", () => {
    const nodes = new EnumerationCountingMap<string, TaskGraphNodeReadModel>();
    const revisions = new EnumerationCountingMap<string, TaskGraphRevisionReadModel>();
    const { snapshot, apply } = seeded({ ...createInitiativeProjectionSnapshot(), taskGraphNodes: nodes, taskGraphRevisions: revisions });

    const g1 = apply(header(G1, V1, null, TASK_GRAPH_NODES_MAX));
    for (let index = 0; index < TASK_GRAPH_NODES_MAX; index += 1) {
      apply(node(G1, task(index), index, index + 1 < TASK_GRAPH_NODES_MAX ? [task(index + 1)] : []));
    }
    const g2 = apply(header(G2, V1, G1, 2));
    apply(node(G2, task(0), 0, [task(1)]));
    apply(node(G2, task(1), 1));
    const g3 = apply(header(G3, V1, G2, 1));
    apply(node(G3, task(0), 0));
    const g4 = apply(header(G4, V2, null, 1));
    apply(node(G4, task(500), 0));

    const counted = [nodes.enumerations, revisions.enumerations];
    expect(counted).toEqual([0, 0]);
    expect(snapshot.taskGraphRevisions.get(G1)).toEqual({
      graphRevisionId: G1,
      roadmapVersionId: V1,
      stepId: "B",
      declaredAt: AT,
      supersededBy: G2,
      sequence: g1,
    });
    expect(snapshot.taskGraphRevisions.get(G2)).toMatchObject({ roadmapVersionId: V1, supersededBy: G3, sequence: g2 });
    expect(snapshot.taskGraphRevisions.get(G3)).toMatchObject({ roadmapVersionId: V1, supersededBy: null, sequence: g3 });
    expect(snapshot.taskGraphRevisions.get(G4)).toMatchObject({ roadmapVersionId: V2, stepId: "B", supersededBy: null, sequence: g4 });
    expect([...snapshot.supersessions]).toEqual([
      [G1, G2],
      [G2, G3],
    ]);
    expect([snapshot.taskGraphRevisions.size, snapshot.taskGraphNodes.size, snapshot.taskDependencies.size]).toEqual([
      4,
      TASK_GRAPH_NODES_MAX + 2 + 1 + 1,
      TASK_GRAPH_NODES_MAX - 1 + 1,
    ]);
    expect(snapshot.taskDependencies.get(taskGraphKey(G1, task(198), "1", task(199), "1"))).toMatchObject({ stepId: "B", failPolicy: "REQUIRE_TERMINAL" });
    expect(snapshot.pendingTaskGraphs.size).toBe(0);
    expect(() => {
      assertTaskGraphsComplete(snapshot);
    }).not.toThrow();
  });

  it("T-B2: a revision of one node closes at once; one of 200 closes exactly at index 199, and no refusal consumes the count", () => {
    const { snapshot, apply } = seeded();
    apply(header(G1, V1, null, 1));
    apply(node(G1, task(0), 0));
    expect(snapshot.pendingTaskGraphs.has(G1)).toBe(false);

    apply(header(G2, V1, G1, TASK_GRAPH_NODES_MAX));
    // Out of order at 0; the right node then enters the same fold.
    expect(refusedBy(() => apply(node(G2, task(1), 1)))).toEqual({ reason: "GRAPH_DECLARATION_INVALID", at: "node.nodeIndex" });
    for (let index = 0; index < TASK_GRAPH_NODES_MAX - 1; index += 1) {
      apply(node(G2, task(index), index, index + 1 < TASK_GRAPH_NODES_MAX ? [task(index + 1)] : []));
    }
    // Out of order at 199, after 198.
    expect(refusedBy(() => apply(node(G2, task(900), TASK_GRAPH_NODES_MAX - 2)))).toEqual({
      reason: "GRAPH_DECLARATION_INVALID",
      at: "node.nodeIndex",
    });
    // A duplicate at the last index.
    expect(refusedBy(() => apply(node(G2, task(0), TASK_GRAPH_NODES_MAX - 1)))).toEqual({
      reason: "GRAPH_DECLARATION_INVALID",
      at: "node.taskId",
    });
    expect(snapshot.taskDependencies.size).toBe(0);
    expect(snapshot.pendingTaskGraphs.has(G2)).toBe(true);
    apply(node(G2, task(TASK_GRAPH_NODES_MAX - 1), TASK_GRAPH_NODES_MAX - 1));
    expect(snapshot.taskDependencies.size).toBe(TASK_GRAPH_NODES_MAX - 1);
    expect(snapshot.pendingTaskGraphs.has(G2)).toBe(false);
    expect(snapshot.taskGraphNodes.size).toBe(1 + TASK_GRAPH_NODES_MAX);
  });

  it("T-B2: two open revisions of two steps, their nodes interleaved, each close on their own count", () => {
    const { snapshot, apply } = seeded();
    apply(header(G5, V1, null, 2));
    apply(header(G6, V2, null, 2));
    apply(node(G5, task(0), 0, [task(1)]));
    apply(node(G6, task(10), 0, [task(11)]));
    expect(snapshot.taskDependencies.size).toBe(0);
    apply(node(G5, task(1), 1));
    expect([snapshot.pendingTaskGraphs.has(G5), snapshot.pendingTaskGraphs.has(G6), snapshot.taskDependencies.size]).toEqual([false, true, 1]);
    // The next index of G6 is 1, not 2: G5's nodes are not G6's.
    expect(refusedBy(() => apply(node(G6, task(12), 2)))).toEqual({ reason: "GRAPH_DECLARATION_INVALID", at: "node.nodeIndex" });
    apply(node(G6, task(11), 1));
    expect([snapshot.pendingTaskGraphs.size, snapshot.taskDependencies.size]).toEqual([0, 2]);
  });

  it("T-B3: the head is the last header folded for (version, step), and no refused header moves it", () => {
    const { snapshot, apply } = seeded();
    apply(header(G1, V1, null, 1));
    apply(node(G1, task(0), 0));
    apply(header(G2, V1, G1, 1));
    apply(node(G2, task(0), 0));
    apply(header(G3, V1, G2, 1));
    apply(node(G3, task(0), 0));
    expect(heads(snapshot)).toEqual([
      [G1, V1, G2],
      [G2, V1, G3],
      [G3, V1, null],
    ]);

    // Stale, and null, on (V1, B).
    for (const supersedes of [G1, null]) {
      expect(refusedBy(() => apply(header(G4, V1, supersedes, 1)))).toEqual({
        reason: "GRAPH_HEAD_MISMATCH",
        at: "header.supersedesGraphRevisionId",
      });
    }
    // The key holds the version: V2's B has no head while V1's B holds G3.
    expect(refusedBy(() => apply(header(G4, V2, G3, 1)))).toEqual({
      reason: "GRAPH_HEAD_MISMATCH",
      at: "header.supersedesGraphRevisionId",
    });
    apply(header(G4, V2, null, 1));
    apply(node(G4, task(1), 0));
    expect(refusedBy(() => apply(header(G5, V2, G3, 1)))).toEqual({
      reason: "GRAPH_HEAD_MISMATCH",
      at: "header.supersedesGraphRevisionId",
    });
    // The key holds the step: V1's C has no head while V1's B holds G3.
    expect(refusedBy(() => apply(header(G7, V1, G3, 1, "C")))).toEqual({
      reason: "GRAPH_HEAD_MISMATCH",
      at: "header.supersedesGraphRevisionId",
    });
    apply(header(G7, V1, null, 1, "C"));
    apply(node(G7, task(2), 0));
    // A reused id, and an undeclared step, even naming the true head.
    expect(refusedBy(() => apply(header(G1, V1, G3, 1)))).toEqual({ reason: "GRAPH_DECLARATION_INVALID", at: "header.graphRevisionId" });
    expect(refusedBy(() => apply(header(G5, V1, null, 1, "Z")))).toEqual({ reason: "GRAPH_STEP_UNKNOWN", at: "header.stepId" });

    // After every refusal the true heads still answer.
    apply(header(G5, V1, G3, 1));
    apply(node(G5, task(0), 0));
    apply(header(G6, V2, G4, 1));
    apply(node(G6, task(1), 0));
    expect(heads(snapshot)).toEqual([
      [G1, V1, G2],
      [G2, V1, G3],
      [G3, V1, G5],
      [G4, V2, G6],
      [G7, V1, null],
      [G5, V1, null],
      [G6, V2, null],
    ]);
    expect(snapshot.taskGraphRevisions.get(G7)).toMatchObject({ roadmapVersionId: V1, stepId: "C", supersededBy: null });
    expect(snapshot.pendingTaskGraphs.size).toBe(0);
  });
});

describe("the task step link fold (P-27 cut C, ADR 0116)", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";
  const OTHER_INITIATIVE = "33333333-3333-4333-8333-333333333333";
  const V1 = "11111111-1111-4111-8111-111111111111";
  const V2 = "22222222-2222-4222-8222-222222222222";
  const FOREIGN = "77777777-7777-4777-8777-777777777777";
  const TASK = "66666666-6666-4666-8666-666666666661";
  const AT = "2026-09-25T12:00:00.000Z";
  const NUMBERS = new Map([
    [V1, 1],
    [V2, 2],
  ]);

  function event(payload: Record<string, unknown>, type = "TASK_STEP_LINKED", initiativeId = INITIATIVE): InitiativeEvent {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "0000cccc-0000-4000-8000-000000000001",
      initiativeId,
      transitionId: "link.x",
      idempotencyKey: initiativeId + "/1/link.x",
      type,
      fromStatus: "ACTIVE",
      toStatus: "ACTIVE",
      emittedBy: "claude/opus/coordinator/01",
      occurredAt: AT,
      recordedAt: AT,
      payload,
    } as unknown as InitiativeEvent;
  }
  const link = (target: readonly [string, string], from: readonly [string, string] | null) =>
    event({ taskId: TASK, roadmapVersionId: target[0], stepId: target[1], fromRoadmapVersionId: from?.[0] ?? null, fromStepId: from?.[1] ?? null });

  /** Every version of the initiative declares A and B; the history holds nothing else. */
  const history = {
    stepDeclared: (initiativeId: string, roadmapVersionId: string, stepId: string) =>
      initiativeId === INITIATIVE && NUMBERS.has(roadmapVersionId) && (stepId === "A" || stepId === "B"),
    versionNumber: (initiativeId: string, roadmapVersionId: string) => (initiativeId === INITIATIVE ? NUMBERS.get(roadmapVersionId) : undefined),
    lastLink: () => undefined,
    linkHeld: () => false,
  };

  function refusedBy(action: () => void): { readonly reason: string; readonly at: string } {
    try {
      action();
    } catch (error: unknown) {
      if (error instanceof LedgerTaskStepLinkRefusedError) return { reason: error.reason, at: error.at };
      throw error;
    }
    throw new Error("expected a refusal");
  }

  it("folds an adoption and a re-link into rows keyed by task and version, the head the last one", () => {
    const fold = createTaskStepLinkFold();
    foldTaskStepLink(fold, history, link([V1, "A"], null), 10);
    foldTaskStepLink(fold, history, link([V2, "A"], [V1, "A"]), 12);
    expect([...fold.taskStepLinks.keys()]).toEqual([taskGraphKey(TASK, V1), taskGraphKey(TASK, V2)]);
    expect(fold.taskStepLinkHeads.get(TASK)).toEqual({
      taskId: TASK,
      roadmapVersionId: V2,
      stepId: "A",
      initiativeId: INITIATIVE,
      fromRoadmapVersionId: V1,
      fromStepId: "A",
      sequence: 12,
      linkedAt: AT,
    });
  });

  it("ignores every other initiative type", () => {
    const fold = createTaskStepLinkFold();
    foldTaskStepLink(fold, history, event({}, "INITIATIVE_STATE_CHANGED"), 3);
    expect(fold.taskStepLinks.size).toBe(0);
  });

  /** Fold one event into `fold` (a fresh one by default), as an action a refusal is read from. */
  const folding =
    (candidate: InitiativeEvent, fold = createTaskStepLinkFold(), sequence = 5) =>
    (): void => {
      foldTaskStepLink(fold, history, candidate, sequence);
    };

  it("refuses each fold word by its one input, and a refused event consumes neither the row nor the head", () => {
    const cases: readonly (readonly [string, () => void, { readonly reason: string; readonly at: string }])[] = [
      ["shape", folding(event({ taskId: TASK })), { reason: "LINK_DECLARATION_INVALID", at: "link.roadmapVersionId" }],
      ["undeclared", folding(link([V1, "Z"], null)), { reason: "LINK_STEP_UNKNOWN", at: "link.stepId" }],
      [
        "another initiative's step",
        folding(event(link([V1, "A"], null).payload, "TASK_STEP_LINKED", OTHER_INITIATIVE)),
        { reason: "LINK_STEP_UNKNOWN", at: "link.stepId" },
      ],
    ];
    for (const [name, action, expected] of cases) {
      expect({ name, refusal: refusedBy(action) }).toEqual({ name, refusal: expected });
    }

    const fold = createTaskStepLinkFold();
    foldTaskStepLink(fold, history, link([V1, "A"], null), 10);
    const rows = [...fold.taskStepLinks.values()];
    const head = fold.taskStepLinkHeads.get(TASK);
    const refusals = [
      // A (task, version) held twice.
      refusedBy(folding(link([V1, "A"], null), fold, 11)),
      // from is not the last link's target.
      refusedBy(folding(link([V2, "A"], null), fold, 11)),
      refusedBy(folding(link([V2, "A"], [V1, "B"]), fold, 11)),
      // Another step id is not a later version of the same step.
      refusedBy(folding(link([V2, "B"], [V1, "A"]), fold, 11)),
    ];
    expect(refusals).toEqual([
      { reason: "LINK_DECLARATION_INVALID", at: "link.roadmapVersionId" },
      { reason: "LINK_HEAD_MISMATCH", at: "link.fromRoadmapVersionId" },
      { reason: "LINK_HEAD_MISMATCH", at: "link.fromStepId" },
      { reason: "LINK_TARGET_NOT_LATER", at: "link.roadmapVersionId" },
    ]);
    expect([...fold.taskStepLinks.values()]).toEqual(rows);
    expect(fold.taskStepLinkHeads.get(TASK)).toEqual(head);
  });

  it("N8: a from pair naming a version the initiative's fold does not hold is LINK_TARGET_NOT_LATER", () => {
    const notLater = { reason: "LINK_TARGET_NOT_LATER", at: "link.roadmapVersionId" };
    expect(refusedBy(folding(link([V2, "A"], [FOREIGN, "A"])))).toEqual(notLater);
    // An earlier version as the target, from a later one.
    expect(refusedBy(folding(link([V1, "A"], [V2, "A"])))).toEqual(notLater);
  });

  it("asks no task-stream question: a first link's from is not checked against an intake the fold never sees", () => {
    const fold = createTaskStepLinkFold();
    // A re-link as the task's first link: the fold admits it; verifyIntegrity() reports it.
    foldTaskStepLink(fold, history, link([V2, "A"], [V1, "A"]), 7);
    expect(fold.taskStepLinks.size).toBe(1);
  });

  it("the rebuild's snapshot folds through the same function, from its own versions and steps", () => {
    const snapshot = createInitiativeProjectionSnapshot();
    for (const [roadmapVersionId, version] of NUMBERS) {
      snapshot.roadmapVersions.set(roadmapVersionId, { roadmapVersionId, initiativeId: INITIATIVE, version } as never);
      for (const stepId of ["A", "B"]) snapshot.roadmapSteps.set(roadmapStepKey(roadmapVersionId, stepId), { roadmapVersionId, stepId } as never);
    }
    applyInitiativeEventToSnapshot(snapshot, link([V1, "A"], null), 20);
    applyInitiativeEventToSnapshot(snapshot, link([V2, "A"], [V1, "A"]), 21);
    expect([...snapshot.taskStepLinks.values()].map((row) => [row.roadmapVersionId, row.sequence])).toEqual([
      [V1, 20],
      [V2, 21],
    ]);
    // The head the snapshot holds is the fold's own, never scanned for.
    expect(() => {
      applyInitiativeEventToSnapshot(snapshot, link([V2, "B"], [V1, "A"]), 22);
    }).toThrow(LedgerTaskStepLinkRefusedError);
    expect(snapshot.taskStepLinks.size).toBe(2);
    expect(snapshot.taskStepLinkHeads.get(TASK)?.sequence).toBe(21);
  });
});
