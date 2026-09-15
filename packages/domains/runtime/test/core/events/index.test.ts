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
import { describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../../src/contracts/index.js";
import { ATTEMPT_OPENING_STEP, buildEvent, causalPredecessorOf, operationForStep } from "../../../src/core/events/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN, OUTCOME_STEP, READ_ONLY_PLAN, planStep } from "../../../src/core/lifecycle/index.js";
import type { PlanStep } from "../../../src/core/lifecycle/index.js";
import { LifecyclePlanError } from "../../../src/errors/index.js";
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
    // reason: the vectors stay stamped as a6ed7c3 built them.
    expect(CONTRACT_VERSION).toBe("2.7.0");
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

describe("N-G-7: the opening is B's payload, field by field, and nothing more", () => {
  it("builds exactly the seven keys an opening without a restored revision carries", () => {
    // Seven since P-36/local D: the revision record of the version in force
    // names its envelope by reference (decision 41, ADR 0084), carried from the
    // invocation exactly as the digest is.
    const opening = buildWith(V2_INVOCATION, ATTEMPT_OPENING_STEP);
    // The version in force, which P-32/captura B moved to 2.6.0 (ADR 0089).
    expect(opening.contractVersion).toBe("2.7.0");
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
