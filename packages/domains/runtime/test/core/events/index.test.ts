import { createHash } from "node:crypto";

import {
  CONTRACT_VERSION,
  ControlPlaneEvent,
  buildIdempotencyKey,
  buildV2IdempotencyKey,
  findCredentialViolations,
  findTranscriptViolations,
} from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import {
  PROMPT_OCCURRENCE_RECORD_KEYS,
  RESPONSE_OCCURRENCE_RECORD_KEYS,
  effectIdV1,
  effectIdempotencyKeyV1,
  logicalOperationSha256,
} from "@acp/ledger";
import { describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../../src/contracts/index.js";
import {
  ATTEMPT_OPENING_STEP,
  INTAKE_ATTEMPT_OPENING_STEP,
  buildDispatchIntentionEvent,
  buildDispatchTransitionEvent,
  buildEffectIntentionEvent,
  buildEvent,
  buildPromptOccurrenceEvent,
  buildResponseOccurrenceEvent,
  causalPredecessorOf,
  dispatchIntentionTransitionId,
  dispatchTransitionId,
  effectIntentionTransitionId,
  operationForStep,
} from "../../../src/core/events/index.js";
import type {
  DispatchTransition,
  EffectIntentionFacts,
  ExecutionSegmentRecord,
  PromptOccurrenceRecord,
  ResponseOccurrenceRecord,
} from "../../../src/core/events/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN, OUTCOME_STEP, READ_ONLY_PLAN, planStep } from "../../../src/core/lifecycle/index.js";
import type { PlanStep } from "../../../src/core/lifecycle/index.js";
import { LifecyclePlanError, SupervisorError } from "../../../src/errors/index.js";
import { deterministicUuid } from "../../../src/core/coordinates/index.js";


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

/** One fixed initiative for every fixture in this file. */
const TEST_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";

const INVOCATION: DurableInvocation = {
  taskId: "22222222-2222-4222-8222-222222222222",
  attempt: 1,
  invocationId: deterministicUuid("inv/0002"),
  submittedAt: "2026-08-27T12:00:00.000Z",
  submissionDigest: "b".repeat(64),
};

const EMITTED_BY = "claude/opus/implementer/01";

function build(index: number): ReturnType<typeof buildEvent> {
  const step = LIFECYCLE_PLAN[index];
  if (step === undefined) throw new Error("no such plan step");
  return buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE });
}

describe("event construction", () => {
  it("produces a valid ControlPlaneEvent for every plan step", () => {
    for (const step of LIFECYCLE_PLAN) {
      const event = buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE });
      expect(ControlPlaneEvent.safeParse(event).success).toBe(true);
      expect(event.type).toBe(step.eventType);
      expect(event.fromState).toBe(step.fromState);
      expect(event.toState).toBe(step.toState);
    }
  });

  it("is byte-identical across repeated builds", () => {
    for (let index = 0; index < LIFECYCLE_PLAN.length; index += 1) {
      expect(JSON.stringify(build(index))).toBe(JSON.stringify(build(index)));
    }
  });

  it("is byte-identical across a simulated restart with a changed environment", () => {
    const before = JSON.stringify(build(INTENT_STEP.index));
    process.env["ACP_EVENT_PROBE"] = String(Date.now());
    const after = JSON.stringify(build(INTENT_STEP.index));
    delete process.env["ACP_EVENT_PROBE"];
    expect(after).toBe(before);
  });

  it("points the outcome at the same operation the intent performed", () => {
    const intent = build(INTENT_STEP.index);
    const outcome = build(OUTCOME_STEP.index);
    expect(intent.payload["operationId"]).toBe(outcome.payload["operationId"]);
    expect(intent.payload["beat"]).toBe("INTENT");
    expect(outcome.payload["beat"]).toBe("OUTCOME");
    expect(outcome.payload["postcondition"]).toBe("DONE");
  });

  it("uses the intent's own operation coordinate", () => {
    const operation = operationForStep(INVOCATION, INTENT_STEP);
    expect(build(INTENT_STEP.index).payload["operationId"]).toBe(operation.operationId);
  });

  it("carries no credential, transcript, path or free text in any payload", () => {
    for (const step of LIFECYCLE_PLAN) {
      const event = buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE });
      expect(findCredentialViolations(event.payload)).toHaveLength(0);
      expect(findTranscriptViolations(event.payload)).toHaveLength(0);
      const serialized = JSON.stringify(event.payload);
      expect(serialized).not.toContain("/Users/");
      expect(serialized).not.toContain(".acp-local");
      expect(serialized).not.toContain("sqlite");
    }
  });

  it("gives every step a distinct identity and idempotency key", () => {
    const ids = LIFECYCLE_PLAN.map((_step, index) => build(index).eventId);
    const keys = LIFECYCLE_PLAN.map((_step, index) => build(index).idempotencyKey);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares a null origin state only on the first event", () => {
    expect(build(0).fromState).toBeNull();
    for (let index = 1; index < LIFECYCLE_PLAN.length; index += 1) {
      expect(build(index).fromState).not.toBeNull();
    }
  });

  it("binds the submission digest into every canonical body", () => {
    for (const step of LIFECYCLE_PLAN) {
      const event = buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE });
      expect(event.payload["submissionDigest"]).toBe(INVOCATION.submissionDigest);
    }
  });

  it("changes the bytes when the submission digest changes", () => {
    // Same task, attempt, invocation and transition -- so the SAME idempotency
    // key -- but a different payload was submitted. The bytes must differ, or
    // the ledger accepts the second request as a replay of the first and the
    // caller silently inherits an outcome for work it did not ask for.
    const step = LIFECYCLE_PLAN[0];
    if (step === undefined) throw new Error("no plan");
    const a = buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE });
    const b = buildEvent({
      invocation: { ...INVOCATION, submissionDigest: "9".repeat(64) },
      step,
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
      route: TEST_ROUTE,
    });

    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    expect(b.eventId).toBe(a.eventId);
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });
});

describe("the causal thread (P8-8E2)", () => {
  it("gives every event of one attempt the invocation's own correlation", () => {
    const ids = LIFECYCLE_PLAN.map(
      (step) =>
        buildEvent({
          invocation: INVOCATION,
          step,
          emittedBy: EMITTED_BY,
          initiativeId: TEST_INITIATIVE_ID,
          plan: LIFECYCLE_PLAN,
          route: TEST_ROUTE,
        }).correlationId,
    );
    // One value, and it is the invocation's — not a value invented per event.
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(INVOCATION.invocationId);
  });

  it("threads causation to the plan's previous step, and leaves step 0 null", () => {
    const events = LIFECYCLE_PLAN.map((step) =>
      buildEvent({
        invocation: INVOCATION,
        step,
        emittedBy: EMITTED_BY,
        initiativeId: TEST_INITIATIVE_ID,
        plan: LIFECYCLE_PLAN,
        route: TEST_ROUTE,
      }),
    );

    // Nothing causes a task's discovery, and saying so with null is the honest
    // answer rather than a self-reference or a placeholder.
    expect(events[0]?.causationId).toBeNull();

    for (let index = 1; index < events.length; index += 1) {
      expect({ index, causationId: events[index]?.causationId }).toEqual({
        index,
        causationId: events[index - 1]?.eventId,
      });
    }
  });

  it("is derived, not remembered: rebuilding after a restart threads identically", () => {
    // The resume law's discriminator (C3). Nothing here carries state between
    // the two builds, which is exactly the situation after a kill: the beat's
    // in-memory "previous" is gone and the chain must still land on the event
    // the ledger durably holds.
    const step = LIFECYCLE_PLAN[3];
    if (step === undefined) throw new Error("the plan is shorter than the fixture assumes");
    const first = buildEvent({
      invocation: INVOCATION,
      step,
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
      route: TEST_ROUTE,
    });
    const afterRestart = buildEvent({
      invocation: { ...INVOCATION },
      step,
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
      route: TEST_ROUTE,
    });
    expect(afterRestart).toEqual(first);
    expect(afterRestart.causationId).toBe(LIFECYCLE_PLAN[2] === undefined ? null : first.causationId);
  });
});

/**
 * The recorded route (V2-B1c).
 *
 * The producer's half of the fail-closed law: a route that is not
 * contract-admitted must never become an event at all. `buildEvent` parses
 * through `ControlPlaneEvent`, so the refusal happens here, before anything
 * reaches an append — which is the only place it can happen without a log
 * having already accepted a claim it cannot retract.
 */
describe("the admitted route rides the INTENT beat", () => {
  it("records the route on the INTENT event, field for field", () => {
    expect(build(INTENT_STEP.index).payload["route"]).toEqual({
      provider: TEST_ROUTE.provider,
      model: TEST_ROUTE.model,
      accountId: TEST_ROUTE.accountId,
      transportKind: TEST_ROUTE.transportKind,
      capabilityPolicyVersion: TEST_ROUTE.capabilityPolicyVersion,
      resolvedAt: TEST_ROUTE.resolvedAt,
    });
  });

  it("records it on exactly one step of the plan, and never restates it", () => {
    const carrying = LIFECYCLE_PLAN.map((_step, index) => build(index)).filter(
      (event) => event.payload["route"] !== undefined,
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.type).toBe("RUN_STARTED");
    // The OUTCOME closes the same operation and says nothing about the route.
    expect(build(OUTCOME_STEP.index).payload["route"]).toBeUndefined();
  });

  it("carries the policy version through unmodified", () => {
    // The one producer of the version is the router; nothing on this path may
    // reinterpret, truncate or normalise it.
    const version = "policy-" + "9".repeat(60);
    const event = buildEvent({
      invocation: INVOCATION,
      step: INTENT_STEP,
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
      route: { ...TEST_ROUTE, capabilityPolicyVersion: version },
    });
    expect((event.payload["route"] as Record<string, unknown>)["capabilityPolicyVersion"]).toBe(version);
  });

  it("writes exactly the six contract fields and nothing else", () => {
    expect(Object.keys(build(INTENT_STEP.index).payload["route"] as Record<string, unknown>).sort()).toEqual([
      "accountId",
      "capabilityPolicyVersion",
      "model",
      "provider",
      "resolvedAt",
      "transportKind",
    ]);
  });

  it("refuses a wider object outright rather than narrowing it silently", () => {
    // `ResolvedRoute` is a strict object, so a caller handing in something
    // wider is refused at the producer instead of having the extra keys
    // quietly dropped. Refusal is the better direction: a silently narrowed
    // route would hide that the caller and the contract disagreed about what a
    // route is, and the transcript key below is exactly the kind of thing that
    // disagreement would be carrying.
    const wider = { ...TEST_ROUTE, transcript: "a provider conversation", cwd: "/Users/someone" };
    expect(() =>
      buildEvent({
        invocation: INVOCATION,
        step: INTENT_STEP,
        emittedBy: EMITTED_BY,
        initiativeId: TEST_INITIATIVE_ID,
        plan: LIFECYCLE_PLAN,
        route: wider,
      }),
    ).toThrow();
    // And nothing of it reached a payload, because no event was built.
    expect(JSON.stringify(build(INTENT_STEP.index).payload)).not.toContain("/Users/");
  });

  it("refuses a route the contract does not admit, with a path and no value", () => {
    const refused: readonly [string, Record<string, unknown>][] = [
      ["a CLI route naming a non-CLI provider", { ...TEST_ROUTE, provider: "acme" }],
      ["an unknown transport", { ...TEST_ROUTE, transportKind: "CARRIER_PIGEON" }],
      ["an instant with no offset", { ...TEST_ROUTE, resolvedAt: "2026-08-27T12:00:00" }],
      ["an empty account", { ...TEST_ROUTE, accountId: "" }],
    ];
    for (const [label, route] of refused) {
      const attempt = () =>
        buildEvent({
          invocation: INVOCATION,
          step: INTENT_STEP,
          emittedBy: EMITTED_BY,
          initiativeId: TEST_INITIATIVE_ID,
          plan: LIFECYCLE_PLAN,
          route: route as typeof TEST_ROUTE,
        });
      expect({ label, threw: (() => { try { attempt(); return false; } catch { return true; } })() })
        .toEqual({ label, threw: true });
    }
  });

  it("keeps the INTENT payload well inside the contract's byte budget", () => {
    const size = new TextEncoder().encode(JSON.stringify(build(INTENT_STEP.index).payload)).byteLength;
    expect(size).toBeLessThan(1_024);
  });

  it("changes the bytes when the route changes, under the same coordinates", () => {
    // The same task, attempt and transition -- so the same idempotency key --
    // on a different account. The bytes must differ, or a resume under a
    // substituted route would read to the ledger as an exact replay.
    const a = build(INTENT_STEP.index);
    const b = buildEvent({
      invocation: INVOCATION,
      step: INTENT_STEP,
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
      route: { ...TEST_ROUTE, accountId: "acct-somewhere-else" },
    });
    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo G — the producer speaks the V2 coordinate (ADR 0080)
// ---------------------------------------------------------------------------

const REVISION = Object.freeze({
  revisionId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01",
  revisionNumber: 1,
  attemptNumber: 1,
  envelopeSha256: "e".repeat(64),
  envelopeArtifactReferenceId: "ref-envelope-0001",
});

const V2_INVOCATION: DurableInvocation = { ...INVOCATION, revision: REVISION };

function buildWith(invocation: DurableInvocation, step: PlanStep, plan: readonly PlanStep[] = LIFECYCLE_PLAN): ReturnType<typeof buildEvent> {
  return buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan, route: TEST_ROUTE });
}

/**
 * The whole walk's bytes, in order, as one digest.
 *
 * `stampedAs` rewrites the one field a contract bump moves on every event of
 * every producer, and nothing else, so a vector lifted before a bump still
 * speaks for every other byte after it (P-36/local D).
 */
function walkDigest(invocation: DurableInvocation, plan: readonly PlanStep[], stampedAs?: string): string {
  const bytes = plan
    .map((step) => {
      const event = buildWith(invocation, step, plan);
      return JSON.stringify(stampedAs === undefined ? event : { ...event, contractVersion: stampedAs });
    })
    .join("\n");
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

describe("N-G-1: an invocation without a revision builds exactly the bytes it built before G", () => {
  it("matches both plans' byte vectors lifted from HEAD a6ed7c3", () => {
    // Literals computed by running HEAD's own `buildEvent` (git archive of
    // a6ed7c3) over this file's fixture, never by calling the function under
    // test: a re-derivation would agree with any change at all. A mismatch here
    // means V1 moved, and the repair is to stop, not to re-pin.
    //
    // P-36/local D moved `CONTRACT_VERSION` to 2.5.0 (ADR 0084), and every
    // event every producer builds carries it — so the literals are NOT re-pinned:
    // they are held over the same walk with that one field stamped as it was at
    // a6ed7c3. Every other byte of a V1 walk is still the byte HEAD built, and
    // the carriage of the envelope reference reached none of them. P-32/captura B
    // moved the version once more, to 2.6.0 (ADR 0089), and held for the same
    // reason: the vectors stay stamped as a6ed7c3 built them. P-07 escalón B moved
    // it to 2.8.0 (ADR 0098), and the vectors held again; P-15 escalón C moved it to
    // 2.9.0 (ADR 0103), and they held once more.
    expect(CONTRACT_VERSION).toBe("2.9.0");
    expect(walkDigest(INVOCATION, LIFECYCLE_PLAN, "2.4.0")).toBe(
      "5c8e92f22adcb75867c79bfa353bf4dc90c57028532c06253640b4437cc2291f",
    );
    expect(walkDigest(INVOCATION, READ_ONLY_PLAN, "2.4.0")).toBe(
      "52a198c05201c7d6da21d2bafd9b91f87f2498f6ddf76eb104e2d415d6118148",
    );
    // And the version is the only field the bump moved: stamped as built, the
    // walk differs from the vector, and every event states the version in force.
    expect(walkDigest(INVOCATION, LIFECYCLE_PLAN)).not.toBe(
      "5c8e92f22adcb75867c79bfa353bf4dc90c57028532c06253640b4437cc2291f",
    );
    for (const step of LIFECYCLE_PLAN) {
      expect(buildWith(INVOCATION, step).contractVersion).toBe(CONTRACT_VERSION);
      expect(Object.keys(buildWith(INVOCATION, step).payload)).not.toContain("envelopeArtifactReferenceId");
    }
  });

  it("threads no opening into a V1 walk and has none to build", () => {
    expect(causalPredecessorOf(INVOCATION, LIFECYCLE_PLAN, planStep(0))).toBeNull();
    expect(() => buildWith(INVOCATION, ATTEMPT_OPENING_STEP)).toThrow(LifecyclePlanError);
  });
});

describe("N-G-2: every event of a revision-bearing walk carries the coordinate and its V2 key", () => {
  it("keys the opening and every plan step by the imported composer", () => {
    for (const step of [ATTEMPT_OPENING_STEP, ...LIFECYCLE_PLAN]) {
      const event = buildWith(V2_INVOCATION, step);
      expect({ step: step.transitionId, revisionNumber: event.payload["revisionNumber"], attemptNumber: event.payload["attemptNumber"] }).toEqual({
        step: step.transitionId,
        revisionNumber: 1,
        attemptNumber: 1,
      });
      expect(event.idempotencyKey).toBe(
        buildV2IdempotencyKey({
          stream: "control_plane_events",
          taskId: V2_INVOCATION.taskId,
          revisionNumber: 1,
          attemptNumber: 1,
          transitionId: step.transitionId,
        }),
      );
      // The flat attempt is the invocation's on every event: the ledger
      // requires every event of a coordinate to repeat its assignment.
      expect(event.attempt).toBe(V2_INVOCATION.attempt);
    }
  });

  it("is refused by the contract before any append when the key is composed another way", () => {
    // N-P18-20 at the producer: the payload decides the namespace, so a V2
    // payload under the flat key is not an admissible event at all.
    const event = buildWith(V2_INVOCATION, INTENT_STEP);
    const flatKeyed = {
      ...event,
      idempotencyKey: buildIdempotencyKey({ taskId: event.taskId, attempt: event.attempt, transitionId: event.transitionId }),
    };
    expect(ControlPlaneEvent.safeParse(flatKeyed).success).toBe(false);
    expect(ControlPlaneEvent.safeParse(event).success).toBe(true);
  });
});

describe("the opening of an intake-first task (P-15/D1, ADR 0105)", () => {
  it("is the same opening out of DISCOVERED: same key, id and payload, one field of state apart", () => {
    const opening = buildWith(V2_INVOCATION, ATTEMPT_OPENING_STEP);
    const afterIntake = buildWith(V2_INVOCATION, INTAKE_ATTEMPT_OPENING_STEP);
    expect(afterIntake.fromState).toBe("DISCOVERED");
    expect(afterIntake.toState).toBe("DISCOVERED");
    expect(opening.fromState).toBeNull();
    expect({ ...afterIntake, fromState: null }).toEqual(opening);
    expect(Object.isFrozen(INTAKE_ATTEMPT_OPENING_STEP)).toBe(true);
    expect({ ...INTAKE_ATTEMPT_OPENING_STEP, fromState: null }).toEqual(ATTEMPT_OPENING_STEP);
  });

  it("has no causal predecessor, and a V1 invocation still has no opening", () => {
    expect(buildWith(V2_INVOCATION, INTAKE_ATTEMPT_OPENING_STEP).causationId).toBeNull();
    expect(() => buildWith(INVOCATION, INTAKE_ATTEMPT_OPENING_STEP)).toThrow(LifecyclePlanError);
  });
});

describe("N-G-7: the opening is B's payload, field by field, and nothing more", () => {
  it("builds exactly the seven keys an opening without a restored revision carries", () => {
    // Seven since P-36/local D: the revision record of the version in force
    // names its envelope by reference (decision 41, ADR 0084), carried from the
    // invocation exactly as the digest is.
    const opening = buildWith(V2_INVOCATION, ATTEMPT_OPENING_STEP);
    // The version in force, which P-15 escalón C moved to 2.9.0 (ADR 0103).
    expect(opening.contractVersion).toBe("2.9.0");
    expect(Object.keys(opening.payload).sort()).toEqual([
      "attemptNumber",
      "envelopeArtifactReferenceId",
      "envelopeSha256",
      "invocationId",
      "legacyAttemptNumber",
      "revisionId",
      "revisionNumber",
    ]);
    expect(opening.payload).toEqual({
      revisionId: REVISION.revisionId,
      revisionNumber: 1,
      attemptNumber: 1,
      envelopeSha256: REVISION.envelopeSha256,
      envelopeArtifactReferenceId: REVISION.envelopeArtifactReferenceId,
      invocationId: V2_INVOCATION.invocationId,
      legacyAttemptNumber: V2_INVOCATION.attempt,
    });
    // The reference is the caller's, never a function of the digest.
    const renamed = buildWith(
      { ...V2_INVOCATION, revision: { ...REVISION, envelopeArtifactReferenceId: "ref-envelope-other" } },
      ATTEMPT_OPENING_STEP,
    );
    expect(renamed.payload["envelopeArtifactReferenceId"]).toBe("ref-envelope-other");
    expect(renamed.payload["envelopeSha256"]).toBe(REVISION.envelopeSha256);
    // No route, no digest of the submission, no initiative: those bind at the
    // discovery that follows.
    expect(JSON.stringify(opening.payload)).not.toContain(TEST_ROUTE.accountId);
    expect(findCredentialViolations(opening.payload)).toHaveLength(0);
    expect(findTranscriptViolations(opening.payload)).toHaveLength(0);
  });

  it("cannot be widened by a wider revision handed in", () => {
    const wider = { ...REVISION, cwd: "/Users/someone", transcript: "a conversation" };
    const opening = buildWith({ ...INVOCATION, revision: wider }, ATTEMPT_OPENING_STEP);
    expect(JSON.stringify(opening.payload)).not.toContain("/Users/");
    // Seven since P-36/local D: the envelope reference joined the six.
    expect(Object.keys(opening.payload)).toHaveLength(7);
  });

  it("opens from no state into DISCOVERED, uncaused, at the submission instant", () => {
    const opening = buildWith(V2_INVOCATION, ATTEMPT_OPENING_STEP);
    expect({
      type: opening.type,
      transitionId: opening.transitionId,
      fromState: opening.fromState,
      toState: opening.toState,
      causationId: opening.causationId,
      correlationId: opening.correlationId,
      occurredAt: opening.occurredAt,
      recordedAt: opening.recordedAt,
    }).toEqual({
      type: "TASK_ATTEMPT_OPENED",
      transitionId: "attempt.opened",
      fromState: null,
      toState: "DISCOVERED",
      causationId: null,
      correlationId: V2_INVOCATION.invocationId,
      occurredAt: V2_INVOCATION.submittedAt,
      recordedAt: V2_INVOCATION.submittedAt,
    });
  });
});

describe("the V2 causal thread starts at the opening", () => {
  it("makes the discovery a same-state event caused by the opening, and leaves the rest of the chain as it was", () => {
    const opening = buildWith(V2_INVOCATION, ATTEMPT_OPENING_STEP);
    const events = LIFECYCLE_PLAN.map((step) => buildWith(V2_INVOCATION, step));
    expect(events[0]?.fromState).toBe("DISCOVERED");
    expect(events[0]?.toState).toBe("DISCOVERED");
    expect(events[0]?.causationId).toBe(opening.eventId);
    expect(events[0]?.payload["initiativeId"]).toBe(TEST_INITIATIVE_ID);
    expect(events[0]?.payload["submissionDigest"]).toBe(V2_INVOCATION.submissionDigest);
    for (let index = 1; index < events.length; index += 1) {
      expect({ index, causationId: events[index]?.causationId, fromState: events[index]?.fromState }).toEqual({
        index,
        causationId: events[index - 1]?.eventId,
        fromState: LIFECYCLE_PLAN[index]?.fromState,
      });
    }
  });

  it("N-G-9: is byte-identical across rebuilds and reads nothing ambient", () => {
    const before = walkDigest(V2_INVOCATION, LIFECYCLE_PLAN) + JSON.stringify(buildWith(V2_INVOCATION, ATTEMPT_OPENING_STEP));
    process.env["ACP_EVENT_PROBE"] = String(Date.now());
    const after = walkDigest({ ...V2_INVOCATION, revision: { ...REVISION } }, LIFECYCLE_PLAN) +
      JSON.stringify(buildWith(V2_INVOCATION, ATTEMPT_OPENING_STEP));
    delete process.env["ACP_EVENT_PROBE"];
    expect(after).toBe(before);
    // And the two walks really are different walks.
    expect(walkDigest(V2_INVOCATION, LIFECYCLE_PLAN)).not.toBe(walkDigest(INVOCATION, LIFECYCLE_PLAN));
  });
});

// ---------------------------------------------------------------------------
// P-06/C — the prompt occurrence has a producer (execution §8.1, ADR 0095)
// ---------------------------------------------------------------------------

/**
 * One lawful occurrence, from which every negative below departs by one field.
 *
 * `contextSha256` is null on purpose: the absent case is the fixture and the
 * present one is the variation, because a producer that could only be shown
 * right when a context exists would leave the absent case — the common one —
 * unexercised (N-P06-17).
 */
const OCCURRENCE: PromptOccurrenceRecord = {
  occurrenceId: "po-0001",
  dispatchAttemptId: "dsp-0001",
  effectId: "eff-0001",
  routeSegmentId: "seg-0001",
  ordinal: 0,
  requestedModelId: "opus",
  provider: "claude",
  modelResolutionStatus: "RESOLVED",
  modelVersionId: "mv-0001",
  accountId: "acct-fixture",
  promptSha256: "a".repeat(64),
  promptBytes: 1_234,
  contextSha256: null,
};

function occurrenceEvent(
  overrides: Partial<PromptOccurrenceRecord> = {},
  invocation: DurableInvocation = V2_INVOCATION,
): ReturnType<typeof buildPromptOccurrenceEvent> {
  return buildPromptOccurrenceEvent({
    invocation,
    state: "RUNNING",
    emittedBy: EMITTED_BY,
    causedBy: null,
    occurrence: { ...OCCURRENCE, ...overrides },
  });
}

describe("the prompt occurrence records the use of an instruction, never its bytes", () => {
  it("N-P06-17: records the digest and the length, and a null context digest rather than a digest of nothing", () => {
    const event = occurrenceEvent();
    const record = event.payload["promptOccurrence"] as Record<string, unknown>;
    expect(record["promptSha256"]).toBe("a".repeat(64));
    expect(record["promptBytes"]).toBe(1_234);
    expect(record["contextSha256"]).toBeNull();
    // The positive control: a delivery that DID carry a separately addressed
    // context says so, so the null above is a statement and not a default the
    // producer is incapable of leaving.
    const withContext = occurrenceEvent({ contextSha256: "c".repeat(64) });
    const carried = withContext.payload["promptOccurrence"] as Record<string, unknown>;
    expect(carried["contextSha256"]).toBe("c".repeat(64));
  });

  it("is the same-state passthrough the contract lists it as, on the invocation's own coordinate", () => {
    const event = occurrenceEvent();
    expect(ControlPlaneEvent.safeParse(event).success).toBe(true);
    expect({
      type: event.type,
      fromState: event.fromState,
      toState: event.toState,
      taskId: event.taskId,
      transitionId: event.transitionId,
      correlationId: event.correlationId,
      causationId: event.causationId,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      emittedBy: event.emittedBy,
    }).toEqual({
      type: "PROMPT_OCCURRENCE_RECORDED",
      fromState: "RUNNING",
      toState: "RUNNING",
      taskId: V2_INVOCATION.taskId,
      transitionId: "prompt-occurrence.po-0001",
      correlationId: V2_INVOCATION.invocationId,
      causationId: null,
      occurredAt: V2_INVOCATION.submittedAt,
      recordedAt: V2_INVOCATION.submittedAt,
      emittedBy: EMITTED_BY,
    });
    expect(event.idempotencyKey).toBe(
      buildV2IdempotencyKey({
        stream: "control_plane_events",
        taskId: V2_INVOCATION.taskId,
        revisionNumber: 1,
        attemptNumber: 1,
        transitionId: "prompt-occurrence.po-0001",
      }),
    );
  });

  it("carries the V2 coordinate and one closed record, whose fields are exactly the door's grammar", () => {
    const event = occurrenceEvent();
    expect(Object.keys(event.payload).sort()).toEqual([
      "attemptNumber",
      "promptOccurrence",
      "revisionNumber",
    ]);
    expect(event.payload["revisionNumber"]).toBe(1);
    expect(event.payload["attemptNumber"]).toBe(1);
    const record = event.payload["promptOccurrence"] as Record<string, unknown>;
    // The ledger's own `PROMPT_OCCURRENCE_RECORD_KEYS`, imported from its
    // barrel (P-06/CORR): the door's reader stays internal, so the equality of
    // the produced key set with the grammar the reader enforces is the grammar
    // test here, and the fence (L-P06C-2) pins the declared side.
    expect(PROMPT_OCCURRENCE_RECORD_KEYS).toHaveLength(13);
    expect(Object.keys(record).sort()).toEqual([...PROMPT_OCCURRENCE_RECORD_KEYS].sort());
  });

  it("F1: a record typed as the record but carrying an extra key yields exactly the thirteen, and the extra value nowhere", () => {
    // A variable, not a literal: TypeScript checks excess keys on a literal
    // only, so a structurally wider object assigned through a wider type is
    // exactly the value a spread would have copied whole.
    const extraValue = "stray-" + "audit-value";
    const wider = { ...OCCURRENCE, auditExtra: extraValue };
    const typed: PromptOccurrenceRecord = wider;
    const event = buildPromptOccurrenceEvent({
      invocation: V2_INVOCATION,
      state: "RUNNING",
      emittedBy: EMITTED_BY,
      causedBy: null,
      occurrence: typed,
    });
    const record = event.payload["promptOccurrence"] as Record<string, unknown>;
    expect(Object.keys(record)).toHaveLength(13);
    expect(Object.keys(record).sort()).toEqual([...PROMPT_OCCURRENCE_RECORD_KEYS].sort());
    expect(record).not.toHaveProperty("auditExtra");
    const text = JSON.stringify(event);
    expect(text).not.toContain("auditExtra");
    expect(text).not.toContain(extraValue);
  });

  it("F1 positive control: the lawful record round-trips all thirteen values", () => {
    const withContext: PromptOccurrenceRecord = { ...OCCURRENCE, contextSha256: "c".repeat(64) };
    for (const occurrence of [OCCURRENCE, withContext]) {
      const event = buildPromptOccurrenceEvent({
        invocation: V2_INVOCATION,
        state: "RUNNING",
        emittedBy: EMITTED_BY,
        causedBy: null,
        occurrence,
      });
      expect(event.payload["promptOccurrence"]).toEqual(occurrence);
    }
  });

  it("N-P06-14: no block, no text and no reference reaches the payload, not even as a digest", () => {
    const event = occurrenceEvent();
    const text = JSON.stringify(event);
    for (const word of ["blocks", "artifactRefId", "contentSha256", "mediaType", "byteLength", "objective", "instructions"]) {
      expect(text).not.toContain(word);
    }
    expect(findCredentialViolations(event.payload)).toEqual([]);
    expect(findTranscriptViolations(event.payload)).toEqual([]);
  });

  it("is byte-identical across rebuilds, and one occurrence has one name", () => {
    expect(JSON.stringify(occurrenceEvent())).toBe(JSON.stringify(occurrenceEvent()));
    // A second occurrence on the same segment is a different event; the same
    // occurrence restated is a replay under the same key.
    const second = occurrenceEvent({ occurrenceId: "po-0002", ordinal: 1 });
    expect(second.idempotencyKey).not.toBe(occurrenceEvent().idempotencyKey);
    expect(second.eventId).not.toBe(occurrenceEvent().eventId);
  });

  it("refuses an invocation without a revision, by name, rather than leaving it to the door", () => {
    expect(() => occurrenceEvent({}, INVOCATION)).toThrow(SupervisorError);
    expect(() => occurrenceEvent({}, INVOCATION)).toThrow(/without a revision/);
  });
});

// ---------------------------------------------------------------------------
// P-07 escalón D — the response occurrence has a producer (execution §8.2, ADR 0100)
// ---------------------------------------------------------------------------

const RESPONSE: ResponseOccurrenceRecord = {
  occurrenceId: "ro-0001",
  promptOccurrenceId: "po-0001",
  responseSha256: "d".repeat(64),
  responseBytes: 321,
  redactionVerdict: "CLEAN",
};

function responseEvent(
  occurrence: ResponseOccurrenceRecord = RESPONSE,
  invocation: DurableInvocation = V2_INVOCATION,
): ReturnType<typeof buildResponseOccurrenceEvent> {
  return buildResponseOccurrenceEvent({ invocation, state: "RUNNING", emittedBy: EMITTED_BY, causedBy: null, occurrence });
}

describe("the response occurrence records an answer's digest and length, never its bytes", () => {
  it("carries the V2 coordinate and one closed record whose keys are the ledger's own grammar, called and not mirrored", () => {
    const event = responseEvent();
    expect(ControlPlaneEvent.safeParse(event).success).toBe(true);
    expect(event.type).toBe("RESPONSE_OCCURRENCE_RECORDED");
    expect([event.fromState, event.toState]).toEqual(["RUNNING", "RUNNING"]);
    expect(event.transitionId).toBe("response-occurrence.ro-0001");
    expect(Object.keys(event.payload).sort()).toEqual(["attemptNumber", "responseOccurrence", "revisionNumber"]);
    const record = event.payload["responseOccurrence"] as Record<string, unknown>;
    expect(RESPONSE_OCCURRENCE_RECORD_KEYS).toHaveLength(5);
    expect(Object.keys(record).sort()).toEqual([...RESPONSE_OCCURRENCE_RECORD_KEYS].sort());
    expect(record).toEqual(RESPONSE);
  });

  it("names no identity of its own: no dispatch, segment or account travels on the answer", () => {
    const record = responseEvent().payload["responseOccurrence"] as Record<string, unknown>;
    for (const key of ["dispatchAttemptId", "routeSegmentId", "accountId", "identity", "effectId"]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("a record typed as the record but carrying an extra key yields exactly the five, and the extra value nowhere", () => {
    const extraValue = "stray-" + "response-value";
    const wider = { ...RESPONSE, auditExtra: extraValue, dispatchAttemptId: "dsp-0001" };
    const typed: ResponseOccurrenceRecord = wider;
    const event = responseEvent(typed);
    const record = event.payload["responseOccurrence"] as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([...RESPONSE_OCCURRENCE_RECORD_KEYS].sort());
    const text = JSON.stringify(event);
    expect(text).not.toContain(extraValue);
    expect(text).not.toContain("dsp-0001");
  });

  it("carries a present-invalid field exactly as given, never defaulted or coerced, so the door's grammar judges what the producer said", () => {
    // The contract's payload is open here: the grammar is the ledger reader's, and
    // the operation-result suite drives each of these through the door, which
    // refuses them (N-P07D-14/15/16). What the builder owes is not to launder them.
    const variations: readonly Record<string, unknown>[] = [
      { ...RESPONSE, responseSha256: "D".repeat(64) },
      { ...RESPONSE, responseSha256: null },
      { ...RESPONSE, responseBytes: -1 },
      { ...RESPONSE, responseBytes: null },
      { ...RESPONSE, responseBytes: 1.5 },
      { ...RESPONSE, redactionVerdict: "DIRTY" },
      { ...RESPONSE, redactionVerdict: null },
      { ...RESPONSE, promptOccurrenceId: "" },
      { ...RESPONSE, occurrenceId: "" },
    ];
    for (const occurrence of variations) {
      const event = responseEvent(occurrence as unknown as ResponseOccurrenceRecord);
      expect(event.payload["responseOccurrence"], JSON.stringify(occurrence)).toEqual(occurrence);
    }
  });

  it("refuses an invocation without a revision, by name", () => {
    expect(() => responseEvent(RESPONSE, INVOCATION)).toThrow(SupervisorError);
    expect(() => responseEvent(RESPONSE, INVOCATION)).toThrow(/without a revision/);
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón B — buildEvent's base comes from the one helper (ADR 0102)
// ---------------------------------------------------------------------------

describe("P-15/B: the payload-coordinate refactor of buildEvent moves no byte", () => {
  it("builds both plans' V2 walks, opening included, exactly as before B", () => {
    // Lifted by running the pre-B `buildEvent` (HEAD 313512d) over this file's
    // fixture; the V1 vectors above already hold the V1 half. Stamped 2.8.0, the
    // version they were lifted under, for the reason the V1 vectors are stamped:
    // P-15 escalón C moved the version in force to 2.9.0 (ADR 0103) and nothing
    // else of these bytes.
    const v2Walk = (plan: readonly PlanStep[]): string =>
      createHash("sha256")
        .update(
          [ATTEMPT_OPENING_STEP, ...plan]
            .map((step) => JSON.stringify({ ...buildWith(V2_INVOCATION, step, plan), contractVersion: "2.8.0" }))
            .join("\n"),
          "utf8",
        )
        .digest("hex");
    expect(v2Walk(LIFECYCLE_PLAN)).toBe(
      // Lifted by running the pre-B source (HEAD 313512d) over this fixture.
      "cc96cb2669169ee7c02d85369ebc40abacc6b6afc1825dfdb827762ffe2218f7",
    );
    expect(v2Walk(READ_ONLY_PLAN)).toBe(
      // Lifted by running the pre-B source (HEAD 313512d) over this fixture.
      "063ad4a1bd9605164d38b77828aa401c8a9716d6b97fede52c5dcdb8e355e7cb",
    );
  });

  it("puts the digest first and the coordinate after it, on every V2 event", () => {
    for (const step of LIFECYCLE_PLAN) {
      const keys = Object.keys(buildWith(V2_INVOCATION, step).payload);
      expect(keys.slice(0, 3)).toEqual(["submissionDigest", "revisionNumber", "attemptNumber"]);
    }
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón C — the effect, dispatch and transition builders (ADR 0103)
// ---------------------------------------------------------------------------

const SEGMENT: ExecutionSegmentRecord = {
  routeSegmentId: "seg-1",
  segmentNumber: 1,
  provider: "anthropic",
  model: "claude-opus-5",
  modelResolutionStatus: "RESOLVED",
  modelVersionId: "claude-opus-5-20260101",
  accountId: "acct-1",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-1",
  routingAssignmentId: null,
  reservationId: null,
  predecessorSegmentId: null,
  handoffReason: null,
  escalatedFromAttempt: null,
  escalationReason: null,
  resolvedAt: null,
};

const EFFECT: EffectIntentionFacts = {
  operationOrdinal: 0,
  effectKind: "model_execution",
  semanticScopeKey: "run",
  localOperationKey: "compose-answer",
  requestContractVersion: "1",
  requestSha256: "b".repeat(64),
};

const PIN = { catalogDocumentId: "catalog-fixture", catalogVersion: 1 } as const;

const SEGMENT_KEYS = Object.keys(SEGMENT).sort();

function effectEvent(invocation: DurableInvocation = V2_INVOCATION, segment: ExecutionSegmentRecord = SEGMENT, effect: EffectIntentionFacts = EFFECT) {
  return buildEffectIntentionEvent({ invocation, state: "RUNNING", emittedBy: EMITTED_BY, causedBy: null, segment, effect });
}

function dispatchEvent(invocation: DurableInvocation = V2_INVOCATION, dispatchAttemptId = "dsp-1") {
  return buildDispatchIntentionEvent({
    invocation,
    state: "RUNNING",
    emittedBy: EMITTED_BY,
    causedBy: null,
    segment: SEGMENT,
    dispatch: { dispatchAttemptId, effectId: "e".repeat(64), attemptOrdinal: 1, pin: PIN },
  });
}

function transitionEvent(transition: DispatchTransition, invocation: DurableInvocation = V2_INVOCATION) {
  return buildDispatchTransitionEvent({ invocation, state: "RUNNING", emittedBy: EMITTED_BY, causedBy: null, transition });
}

describe("P-15/C: the effect, dispatch and transition builders are closed by construction (ADR 0103)", () => {
  it("PC-C5: the effect intention carries the coordinate, the sixteen segment names and the effect record, and nothing else", () => {
    const event = effectEvent();
    expect(ControlPlaneEvent.safeParse(event).success).toBe(true);
    expect(event.type).toBe("EFFECT_INTENDED");
    expect(Object.keys(event.payload).sort()).toEqual(["attemptNumber", "effect", "revisionNumber", "segment"]);
    expect(Object.keys(event.payload["segment"] as object).sort()).toEqual(SEGMENT_KEYS);
    expect(SEGMENT_KEYS).toHaveLength(16);
    expect(Object.keys(event.payload["effect"] as object).sort()).toEqual([
      "effectId",
      "effectKind",
      "idempotencyKey",
      "localOperationKey",
      "logicalOperationSha256",
      "operationOrdinal",
      "requestContractVersion",
      "requestSha256",
      "semanticScopeKey",
    ]);
  });

  it("derives the three identities with the ledger's own functions, never restated", () => {
    const effect = effectEvent().payload["effect"] as Record<string, unknown>;
    const coordinate = { taskId: INVOCATION.taskId, revisionNumber: 1, attemptNumber: 1, segmentNumber: 1, operationOrdinal: 0 };
    expect(effect["effectId"]).toBe(effectIdV1(coordinate));
    expect(effect["idempotencyKey"]).toBe(
      effectIdempotencyKeyV1({ ...coordinate, effectKind: "model_execution", envelopeSha256: REVISION.envelopeSha256 }),
    );
    expect(effect["logicalOperationSha256"]).toBe(
      logicalOperationSha256({ invocationId: V2_INVOCATION.invocationId, semanticScopeKey: "run", localOperationKey: "compose-answer" }),
    );
    expect(effectEvent().transitionId).toBe(effectIntentionTransitionId(effectIdV1(coordinate)));
    expect(effectEvent().transitionId).toHaveLength(80);
  });

  it("the dispatch intention carries its pin, required, and exactly five dispatch names", () => {
    const event = dispatchEvent();
    expect(ControlPlaneEvent.safeParse(event).success).toBe(true);
    expect(event.type).toBe("DISPATCH_INTENDED");
    expect(event.payload["dispatch"]).toEqual({
      dispatchAttemptId: "dsp-1",
      effectId: "e".repeat(64),
      attemptOrdinal: 1,
      catalogDocumentId: "catalog-fixture",
      catalogVersion: 1,
    });
    expect(Object.keys(event.payload).sort()).toEqual(["attemptNumber", "dispatch", "revisionNumber", "segment"]);
  });

  it("Q-C3: a transition name fits the contract's bound whatever the delivery id, and is stable", () => {
    for (const id of ["dsp-1", "x".repeat(1_000), "an id with spaces/and slashes"]) {
      for (const transitionId of [
        dispatchIntentionTransitionId(id),
        dispatchTransitionId("INFLIGHT", id),
        dispatchTransitionId("ABANDONED", id),
        dispatchTransitionId("SETTLED", id),
      ]) {
        expect(transitionId.length).toBeLessThanOrEqual(120);
        expect(transitionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
      }
      expect(dispatchIntentionTransitionId(id)).toBe(dispatchIntentionTransitionId(id));
      expect(ControlPlaneEvent.safeParse(dispatchEvent(V2_INVOCATION, id)).success).toBe(true);
    }
    expect(dispatchIntentionTransitionId("a")).not.toBe(dispatchIntentionTransitionId("b"));
  });

  it("each transition arm writes its own keys and no other's", () => {
    const inflight = transitionEvent({ kind: "INFLIGHT", dispatchAttemptId: "dsp-1", acceptedAt: "2026-09-23T12:00:01.000Z", externalHandle: "handle-1" });
    expect(inflight.payload["outcome"]).toEqual({
      dispatchAttemptId: "dsp-1",
      dispatchState: "INFLIGHT",
      acceptedAt: "2026-09-23T12:00:01.000Z",
      externalHandle: "handle-1",
    });
    const abandoned = transitionEvent({ kind: "ABANDONED", dispatchAttemptId: "dsp-1", terminalAt: "2026-09-23T12:00:02.000Z", effectOutcomeStatus: null });
    expect(abandoned.payload["outcome"]).toEqual({ dispatchAttemptId: "dsp-1", dispatchState: "ABANDONED", terminalAt: "2026-09-23T12:00:02.000Z" });
    const settledBare = transitionEvent({
      kind: "SETTLED",
      dispatchAttemptId: "dsp-1",
      terminalAt: "2026-09-23T12:00:02.000Z",
      effectOutcomeStatus: "FAILED",
      result: null,
    });
    expect(settledBare.payload["outcome"]).toEqual({
      dispatchAttemptId: "dsp-1",
      dispatchState: "SETTLED",
      terminalAt: "2026-09-23T12:00:02.000Z",
      effectOutcomeStatus: "FAILED",
    });
    const settledPair = transitionEvent({
      kind: "SETTLED",
      dispatchAttemptId: "dsp-1",
      terminalAt: "2026-09-23T12:00:02.000Z",
      effectOutcomeStatus: "SUCCEEDED",
      result: { artifactReferenceId: "ref-result", sha256: "c".repeat(64) },
    });
    expect(Object.keys(settledPair.payload["outcome"] as object).sort()).toEqual([
      "dispatchAttemptId",
      "dispatchState",
      "effectOutcomeStatus",
      "resultArtifactReferenceId",
      "resultSha256",
      "terminalAt",
    ]);
    for (const event of [inflight, abandoned, settledBare, settledPair]) {
      expect(event.type).toBe("DISPATCH_OUTCOME_RECORDED");
      expect(Object.keys(event.payload).sort()).toEqual(["attemptNumber", "outcome", "revisionNumber"]);
      expect(ControlPlaneEvent.safeParse(event).success).toBe(true);
    }
  });

  it("F1: a value wider than its type yields exactly the declared names, and the extra value nowhere", () => {
    const stray = "stray-" + "builder-value";
    const widerSegment = { ...SEGMENT, stray } as ExecutionSegmentRecord;
    const widerEffect = { ...EFFECT, effectId: "f".repeat(64), stray } as EffectIntentionFacts;
    const effect = effectEvent(V2_INVOCATION, widerSegment, widerEffect);
    expect(Object.keys(effect.payload["segment"] as object).sort()).toEqual(SEGMENT_KEYS);
    expect((effect.payload["effect"] as Record<string, unknown>)["effectId"]).not.toBe("f".repeat(64));
    const widerTransition = {
      kind: "INFLIGHT",
      dispatchAttemptId: "dsp-1",
      acceptedAt: "2026-09-23T12:00:01.000Z",
      externalHandle: "handle-1",
      terminalAt: "2026-09-23T12:00:02.000Z",
      effectOutcomeStatus: "SUCCEEDED",
      stray,
    } as DispatchTransition;
    const inflight = transitionEvent(widerTransition);
    expect(Object.keys(inflight.payload["outcome"] as object).sort()).toEqual(["acceptedAt", "dispatchAttemptId", "dispatchState", "externalHandle"]);
    for (const event of [effect, inflight]) expect(JSON.stringify(event)).not.toContain(stray);
  });

  it("N-C-12: a V1 invocation is refused by name, before anything is built, by all three", () => {
    expect(() => effectEvent(INVOCATION)).toThrow(SupervisorError);
    expect(() => dispatchEvent(INVOCATION)).toThrow(/without a revision/);
    expect(() =>
      transitionEvent({ kind: "INFLIGHT", dispatchAttemptId: "dsp-1", acceptedAt: "2026-09-23T12:00:01.000Z", externalHandle: "h" }, INVOCATION),
    ).toThrow(SupervisorError);
  });
});
