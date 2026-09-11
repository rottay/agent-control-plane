import { CONTRACT_VERSION, INITIATIVE_EVENT_TYPES, buildIdempotencyKey } from "@acp/contracts";
import type { ControlPlaneEvent, InitiativeEvent } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import {
  nextExecutionRouteProjection,
  nextRoutingAssignmentFromInitiative,
  nextRoutingAssignmentProjection,
  nextTaskProjection,
  nextTaskRevisionProjection,
  routingAssignmentId,
} from "../../src/projection/index.js";
import { LedgerValidationError } from "../../src/errors/index.js";
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
  const ENVELOPE = "e".repeat(64);

  function revisionEvent(payload: Record<string, unknown>): ControlPlaneEvent {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "2e2e2e2e-2e2e-4e2e-8e2e-2e2e2e2e2e01",
      taskId: REVISION_TASK,
      attempt: 3,
      transitionId: "revise",
      idempotencyKey: buildIdempotencyKey({
        taskId: REVISION_TASK,
        attempt: 3,
        transitionId: "revise",
      }),
      type: "TASK_CLASSIFIED",
      fromState: "DISCOVERED",
      toState: "DT_CLASSIFIED",
      emittedBy: EMITTED_BY,
      occurredAt: "2026-09-11T09:00:00.000Z",
      recordedAt: "2026-09-11T09:00:00.000Z",
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

  it("carries the revision into the task row, all three fields together", () => {
    // The denormalization on `task_read_model`. The three move as one or not at
    // all: a task advertising revision 3's number beside revision 2's envelope
    // is the one failure a convenience column must never produce.
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
});
