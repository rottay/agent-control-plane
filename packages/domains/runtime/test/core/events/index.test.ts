import { ControlPlaneEvent, findCredentialViolations, findTranscriptViolations } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../../src/contracts/index.js";
import { buildEvent, operationForStep } from "../../../src/core/events/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN, OUTCOME_STEP } from "../../../src/core/lifecycle/index.js";
import { deterministicUuid } from "../../../src/core/coordinates/index.js";

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
  return buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN });
}

describe("event construction", () => {
  it("produces a valid ControlPlaneEvent for every plan step", () => {
    for (const step of LIFECYCLE_PLAN) {
      const event = buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN });
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
      const event = buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN });
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
      const event = buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN });
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
    const a = buildEvent({ invocation: INVOCATION, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN });
    const b = buildEvent({
      invocation: { ...INVOCATION, submissionDigest: "9".repeat(64) },
      step,
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
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
    });
    const afterRestart = buildEvent({
      invocation: { ...INVOCATION },
      step,
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
    });
    expect(afterRestart).toEqual(first);
    expect(afterRestart.causationId).toBe(LIFECYCLE_PLAN[2] === undefined ? null : first.causationId);
  });
});
