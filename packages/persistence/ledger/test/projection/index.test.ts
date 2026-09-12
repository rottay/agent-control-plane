import { createHash } from "node:crypto";

import {
  CONTRACT_VERSION,
  EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1,
  EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1,
  INITIATIVE_EVENT_TYPES,
  buildIdempotencyKey,
  buildV2IdempotencyKey,
} from "@acp/contracts";
import type { ControlPlaneEvent, InitiativeEvent } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import {
  applyEventToSnapshot,
  canonicalAttempt,
  canonicalRevision,
  createProjectionSnapshot,
  dispatchOutcomeRecord,
  dispatchTransitionAdmitted,
  effectIdPreimageV1,
  effectIdV1,
  effectIdempotencyKeyV1,
  effectIdempotencyPreimageV1,
  logicalOperationSha256,
  nextDispatchAttemptProjection,
  nextEffectProjection,
  nextExecutionRouteSegmentProjection,
  requestSha256,
  nextExecutionRouteProjection,
  nextRoutingAssignmentFromInitiative,
  nextRoutingAssignmentProjection,
  nextTaskAttemptProjection,
  nextTaskProjection,
  nextTaskRevisionProjection,
  routingAssignmentId,
  taskAttemptKey,
} from "../../src/projection/index.js";
import { LedgerValidationError } from "../../src/errors/index.js";
import { DISPATCH_STATES } from "../../src/types/index.js";
import type { RegistryDocument, TaskReadModel } from "../../src/types/index.js";
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

  function revisionEvent(
    payload: Record<string, unknown>,
    overrides: { readonly occurredAt?: string } = {},
  ): ControlPlaneEvent {
    // These fold inputs are cast rather than parsed, so the contract's door
    // never sees them — which is exactly why the key is composed correctly
    // here. A fixture the contract would have refused is a fixture that asserts
    // the fold's behaviour on an event no producer could ever emit.
    const revisionNumber = payload["revisionNumber"];
    const attemptNumber = payload["attemptNumber"];
    const occurredAt = overrides.occurredAt ?? "2026-09-11T09:00:00.000Z";
    return {
      contractVersion: CONTRACT_VERSION,
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

  const COMPLETE = {
    revisionId: REVISION_ID,
    revisionNumber: 2,
    attemptNumber: 1,
    envelopeSha256: ENVELOPE,
  };

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
    for (const missing of Object.keys(COMPLETE)) {
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

  it("N6: refuses a revision that carries an artifact reference this contract has no column for", () => {
    // B-5. The key belongs to P-36/local, and this build has nowhere to put it.
    // Ignoring it would silently drop a fact the writer believed it recorded;
    // interpreting it would be a reader pretending to understand a plane that
    // does not exist here. So the event is refused and the refusal names the
    // key — which is the one case where this fold does NOT stay total, and the
    // distinction is deliberate: a payload this contract has no opinion about
    // is ignored, a payload claiming a fact it cannot represent is not.
    const carrying = revisionEvent({
      ...COMPLETE,
      envelopeArtifactReferenceId: "4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a01",
    });
    expect(() => nextTaskRevisionProjection(carrying, 7)).toThrow(LedgerValidationError);
    expect(() => nextTaskRevisionProjection(carrying, 7)).toThrow(/artifact reference/);

    // The same payload without that key folds cleanly, so the refusal is about
    // the key and not about the rest of the record.
    expect(nextTaskRevisionProjection(revisionEvent(COMPLETE), 7)).not.toBeNull();
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
    applyEventToSnapshot(first, attemptEvent(OPENING), 1);
    expect(first.taskAttempts.get(key)?.invocationId).toBe("inv-0001");
    expect(() => {
      applyEventToSnapshot(
        first,
        attemptEvent({ ...OPENING, invocationId: "inv-0002" }, { transitionId: "again" }),
        2,
      );
    }).toThrow(/already recorded with a different identity/);

    // One flat assignment across two coordinates. `UNIQUE (task_id,
    // legacy_attempt_number)` would abort on it in the base; the snapshot
    // refuses it first and names the coordinate that already holds the claim.
    const second = createProjectionSnapshot();
    applyEventToSnapshot(second, attemptEvent(OPENING), 1);
    expect(() => {
      applyEventToSnapshot(
        second,
        attemptEvent(
          { ...OPENING, attemptNumber: 2, invocationId: "inv-0002" },
          { transitionId: "a2" },
        ),
        2,
      );
    }).toThrow(new RegExp("claims legacy " + ATTEMPT_TASK + " 4, which attempt " + key));

    // One invocation across two coordinates, which is the other half of the
    // bijection and the other unique index.
    const third = createProjectionSnapshot();
    applyEventToSnapshot(third, attemptEvent(OPENING), 1);
    expect(() => {
      applyEventToSnapshot(
        third,
        attemptEvent(
          { ...OPENING, attemptNumber: 2, legacyAttemptNumber: 5 },
          { transitionId: "a2" },
        ),
        2,
      );
    }).toThrow(/claims invocation inv-0001/);
  });

  it("folds an exact replay of one opening to nothing, and a second coordinate to a row", () => {
    // The branch the refusals above are measured against: without it, every
    // assertion there would be satisfied by a fold that refused everything.
    const snapshot = createProjectionSnapshot();
    applyEventToSnapshot(snapshot, attemptEvent(OPENING), 1);
    applyEventToSnapshot(snapshot, attemptEvent(OPENING, { transitionId: "replay" }), 2);
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
    transportKind: "cli",
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
      dispatch: { dispatchAttemptId: "dsp-1", effectId: "a".repeat(64), attemptOrdinal: 1 },
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

    expect(
      dispatchOutcomeRecord(wrap({ dispatchAttemptId: "dsp-1", dispatchState: "CLAIMED" }), 1)
        ?.dispatchState,
    ).toBe("CLAIMED");

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
    applyEventToSnapshot(snapshot, executionEvent("EFFECT_INTENDED", effectPayload), 1);
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
      applyEventToSnapshot(snapshot, executionEvent("EFFECT_INTENDED", twin), 2);
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
    );
    applyEventToSnapshot(
      snapshot,
      executionEvent("DISPATCH_INTENDED", {
        revisionNumber: 1,
        attemptNumber: 1,
        segment: segment(),
        dispatch: { dispatchAttemptId: "dsp-1", effectId, attemptOrdinal: 1 },
      }),
      2,
    );

    const settle = (payload: Record<string, unknown>): Record<string, unknown> => ({
      ...payload,
      outcome: {
        dispatchAttemptId: "dsp-1",
        dispatchState: "SETTLED",
        terminalAt: "2026-09-12T09:10:00.000Z",
        effectOutcomeStatus: "SUCCEEDED",
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
        applyEventToSnapshot(snapshot, event, 3);
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
    );
    expect(snapshot.dispatchAttempts.get("dsp-1")?.dispatchState).toBe("SETTLED");
    expect(snapshot.effects.get(effectId)?.outcomeStatus).toBe("SUCCEEDED");
  });
});
