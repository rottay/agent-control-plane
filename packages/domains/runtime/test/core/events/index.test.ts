import { ControlPlaneEvent, findCredentialViolations, findTranscriptViolations } from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../../src/contracts/index.js";
import { buildEvent, operationForStep } from "../../../src/core/events/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN, OUTCOME_STEP } from "../../../src/core/lifecycle/index.js";
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
