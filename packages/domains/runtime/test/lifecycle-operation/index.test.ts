import { randomUUID } from "node:crypto";

import { CONTRACT_VERSION, buildV2IdempotencyKey } from "@acp/contracts";
import type { DriverCapabilities, DriverOutcome, DriverStatus, ResolvedRoute } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation, OrchestrationDriver } from "../../src/contracts/index.js";
import { ATTEMPT_OPENING_STEP, buildEvent } from "../../src/core/events/index.js";
import { deterministicUuid } from "../../src/core/coordinates/index.js";
import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  SHARED_PLAN_PREFIX,
  planStep,
} from "../../src/core/lifecycle/index.js";
import type { PlanStep } from "../../src/core/lifecycle/index.js";
import { assertInvocationContinuity } from "../../src/core/step-executor/index.js";
import type { BeatContext, EffectPort } from "../../src/core/step-executor/index.js";
import { settleCancellation } from "../../src/cancellation/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import {
  LIFECYCLE_RECOVERY_REFUSALS,
  LIFECYCLE_VERBS,
  lifecycleBeat,
  restateInvocation,
  runLifecycleOperation,
} from "../../src/lifecycle-operation/index.js";
import type { LifecycleRecoveryPort } from "../../src/lifecycle-operation/index.js";
import { canonicalSubmissionDigest, deriveInvocation } from "../../src/submission/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";

/**
 * The lifecycle operation, over a real ledger and a fake driver.
 *
 * The driver is faked and the ledger is not, which is the split the packet's
 * claim needs: what is under test here is what the plane can RECOVER from a log
 * and what it does with a driver's answer, and neither question involves an
 * engine. The real-engine proofs — idempotency, a SIGKILL in the settlement
 * window, an attach after a door death — live in the durability project, where
 * a port-binding suite may run.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const TEST_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const SUBMITTED_AT = "2026-08-27T12:00:00.000Z";

const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: SUBMITTED_AT,
};

const scenarios: string[] = [];
const openLedgers: Ledger[] = [];

afterEach(() => {
  for (const ledger of openLedgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) {
    removeScenarioRoot(name);
  }
});

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function track(ledger: Ledger): Ledger {
  openLedgers.push(ledger);
  return ledger;
}

/**
 * The invocation a real submission would have derived.
 *
 * The digest is computed rather than invented, because the producer under test
 * verifies it: a fixture carrying a placeholder digest would exercise the
 * refusal branch on every test and prove nothing about the accepting one.
 */
function invocationFor(
  taskId: string,
  attempt = 1,
  route: ResolvedRoute = TEST_ROUTE,
  initiativeId: string = TEST_INITIATIVE_ID,
  submittedAt: string = SUBMITTED_AT,
): DurableInvocation {
  return deriveInvocation(
    taskId,
    attempt,
    submittedAt,
    canonicalSubmissionDigest({ taskId, attempt, submittedAt, initiativeId, route }),
  );
}

/** Append one plan step, exactly as a walk would have. */
function append(
  ledger: Ledger,
  invocation: DurableInvocation,
  step: PlanStep,
  initiativeId: string = TEST_INITIATIVE_ID,
  route: ResolvedRoute = TEST_ROUTE,
): void {
  ledger.append(
    buildEvent({
      invocation,
      step,
      emittedBy: EMITTED_BY,
      initiativeId,
      plan: LIFECYCLE_PLAN,
      route,
    }),
  );
}

/** Seed a ledger with steps 0..`through`, inclusive. */
function seed(
  name: string,
  taskId: string,
  through: number,
  options: {
    readonly initiativeId?: string;
    readonly route?: ResolvedRoute;
    readonly submittedAt?: string;
  } = {},
): { readonly root: ScenarioRoot; readonly ledger: Ledger; readonly invocation: DurableInvocation } {
  const initiativeId = options.initiativeId ?? TEST_INITIATIVE_ID;
  const route = options.route ?? TEST_ROUTE;
  const submittedAt = options.submittedAt ?? SUBMITTED_AT;
  const root = scenario(name);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  const invocation = invocationFor(taskId, 1, route, initiativeId, submittedAt);
  for (let index = 0; index <= through; index += 1) {
    append(ledger, invocation, planStep(index), initiativeId, route);
  }
  return { root, ledger, invocation };
}

/** A port that reports what it is told to, and counts what it was asked. */
function probePort(verdict: "DONE" | "NOT_DONE" | "UNKNOWN"): EffectPort & { applied: number } {
  const port = {
    applied: 0,
    apply(): Promise<void> {
      port.applied += 1;
      return Promise.resolve();
    },
    probe(): Promise<"DONE" | "NOT_DONE" | "UNKNOWN"> {
      return Promise.resolve(verdict);
    },
  };
  return port;
}

/**
 * A driver that answers, and remembers how often it was asked.
 *
 * Deliberately not a partial stub cast to the interface: the operation may only
 * be proved against something that satisfies the whole contract, or the test
 * would pass for a driver no composition root could actually build.
 */
class CountingDriver implements OrchestrationDriver {
  readonly mode = "RESTATE" as const;
  cancelCalls = 0;
  reattachCalls = 0;

  readonly cancelOutcome: DriverOutcome;
  readonly reattachOutcome: DriverOutcome;

  constructor(
    cancelOutcome: DriverOutcome,
    reattachOutcome: DriverOutcome = { ok: true, finalSequence: 12 },
  ) {
    this.cancelOutcome = cancelOutcome;
    this.reattachOutcome = reattachOutcome;
  }

  cancel(): Promise<DriverOutcome> {
    this.cancelCalls += 1;
    return Promise.resolve(this.cancelOutcome);
  }

  reattach(): Promise<DriverOutcome> {
    this.reattachCalls += 1;
    return Promise.resolve(this.reattachOutcome);
  }

  signal(): Promise<DriverOutcome> {
    return Promise.resolve({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "signal" });
  }

  timer(): Promise<DriverOutcome> {
    return Promise.resolve({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "timer" });
  }

  advance(): Promise<never> {
    return Promise.reject(new SupervisorError("the fake driver walks no plan"));
  }

  status(): Promise<DriverStatus> {
    return Promise.reject(new SupervisorError("the fake driver reports no status"));
  }

  reconcile(): Promise<never> {
    return Promise.reject(new SupervisorError("the fake driver reconciles nothing"));
  }

  capabilities(): DriverCapabilities {
    return {
      contractVersion: "2.2.0",
      mode: this.mode,
      verbs: { CANCEL: "SUPPORTED", REATTACH: "SUPPORTED", SIGNAL: "SUPPORTED", TIMER: "SUPPORTED" },
      properties: { SERIALIZED_PER_TASK: "SUPPORTED" },
    };
  }
}

describe("the recovery producer", () => {
  it("rebuilds the five values a walk recorded, and the context passes continuity", () => {
    const taskId = randomUUID();
    const { ledger, invocation } = seed("l2-recover-ok", taskId, 4);

    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    // The identity is derived, not read: it equals what the submission door
    // derived from the same coordinates.
    expect(recovered.context.invocation).toEqual(invocation);
    expect(recovered.context.invocation.submittedAt).toBe(SUBMITTED_AT);
    expect(recovered.context.invocation.submissionDigest).toBe(invocation.submissionDigest);
    expect(recovered.context.emittedBy).toBe(EMITTED_BY);
    expect(recovered.context.initiativeId).toBe(TEST_INITIATIVE_ID);
    expect(recovered.context.route).toEqual(TEST_ROUTE);

    // The measurement: the recovered context is one the domain's own guard
    // accepts against the very ledger it came from.
    const context: BeatContext = {
      ...lifecycleBeat(ledger, probePort("NOT_DONE"), recovered.context)(
        recovered.context.invocation,
      ),
      plan: SHARED_PLAN_PREFIX,
      initiativeId: recovered.context.initiativeId,
    };
    expect(() => {
      assertInvocationContinuity(context);
    }).not.toThrow();
  });

  it("is non-vacuous: a different submitted instant derives a different attempt", () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-recover-instant", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const elsewhere = invocationFor(taskId, 1, TEST_ROUTE, TEST_INITIATIVE_ID, "2026-08-27T13:00:00.000Z");
    expect(elsewhere.submittedAt).not.toBe(recovered.context.invocation.submittedAt);
    expect(elsewhere.submissionDigest).not.toBe(recovered.context.invocation.submissionDigest);
  });

  it("is non-vacuous: a different initiative makes continuity refuse", () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-recover-initiative", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const wrong: BeatContext = {
      ...lifecycleBeat(ledger, probePort("NOT_DONE"), recovered.context)(
        recovered.context.invocation,
      ),
      plan: SHARED_PLAN_PREFIX,
      initiativeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a99",
    };
    expect(() => {
      assertInvocationContinuity(wrong);
    }).toThrow(SupervisorError);
  });

  it("refuses an attempt the ledger has never seen, and synthesizes nothing", () => {
    const root = scenario("l2-recover-unknown");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const recovered = restateInvocation(ledger, randomUUID(), 1);
    expect(recovered).toEqual({ ok: false, refusal: "TASK_UNKNOWN", at: "task" });
  });

  it("refuses an attempt that is not the latest, before any engine is touched", () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-recover-stale", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 2);
    expect(recovered).toEqual({ ok: false, refusal: "ATTEMPT_NOT_LATEST", at: "attempt" });
  });

  it("refuses before RUN_STARTED, naming the field rather than guessing a route", () => {
    const taskId = randomUUID();
    // Steps 0..3: discovered through reserved. The INTENT beat, which is the
    // only event that carries a route, has not been appended.
    const { ledger } = seed("l2-recover-preintent", taskId, 3);
    expect(ledger.getExecutionRoute(taskId, 1)).toBeNull();

    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered).toEqual({ ok: false, refusal: "ROUTE_NOT_RECORDED", at: "attempt.route" });
  });

  it("refuses a recorded route that disagrees with the digest its own events carry", () => {
    const taskId = randomUUID();
    const root = scenario("l2-recover-disagreeing");
    const ledger = track(openLedger(scenarioLedgerPath(root)));

    // The digest is bound to one route; the walk records another. Nothing about
    // the chain is wrong — every event verifies and the projection holds
    // exactly what the INTENT payload said — and that is the point: the two
    // accounts of "which route" disagree, and only the digest can tell.
    const bound: ResolvedRoute = { ...TEST_ROUTE, accountId: "acct-bound" };
    const recorded: ResolvedRoute = { ...TEST_ROUTE, accountId: "acct-recorded" };
    const invocation = invocationFor(taskId, 1, bound);
    for (let index = 0; index <= 4; index += 1) {
      append(ledger, invocation, planStep(index), TEST_INITIATIVE_ID, recorded);
    }
    expect(ledger.getExecutionRoute(taskId, 1)?.accountId).toBe("acct-recorded");
    expect(ledger.verifyIntegrity().ok).toBe(true);

    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered).toEqual({
      ok: false,
      refusal: "SUBMISSION_DIGEST_MISMATCH",
      at: "attempt.submissionDigest",
    });

    void root;
  });

  it("names every refusal it can produce, closed and sorted", () => {
    expect([...LIFECYCLE_RECOVERY_REFUSALS]).toEqual([...LIFECYCLE_RECOVERY_REFUSALS].sort());
    expect(new Set(LIFECYCLE_RECOVERY_REFUSALS).size).toBe(LIFECYCLE_RECOVERY_REFUSALS.length);
  });
});

describe("the operation", () => {
  it("exposes cancel and attach, and nothing else", () => {
    expect([...LIFECYCLE_VERBS]).toEqual(["ATTACH", "CANCEL"]);
  });

  it("calls cancel exactly once and returns the driver's answer verbatim", async () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-op-cancel", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const driver = new CountingDriver({ ok: true, finalSequence: 5 });
    const result = await runLifecycleOperation({
      driver,
      verb: "CANCEL",
      invocation: recovered.context.invocation,
    });

    expect(driver.cancelCalls).toBe(1);
    expect(driver.reattachCalls).toBe(0);
    expect(result).toEqual({
      verb: "CANCEL",
      mode: "RESTATE",
      outcome: { ok: true, finalSequence: 5 },
    });
  });

  it("does not retry a refusal, and carries the driver's closed name across", async () => {
    const driver = new CountingDriver({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "cancel",
    });
    const invocation = invocationFor(randomUUID());

    const result = await runLifecycleOperation({ driver, verb: "CANCEL", invocation });

    expect(driver.cancelCalls).toBe(1);
    expect(result.outcome).toEqual({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "cancel" });
  });

  it("returns attach's ledger coordinate and nothing the engine minted", async () => {
    const driver = new CountingDriver(
      { ok: true, finalSequence: 0 },
      { ok: true, finalSequence: 41 },
    );
    const invocation = invocationFor(randomUUID());

    const result = await runLifecycleOperation({ driver, verb: "ATTACH", invocation });

    expect(driver.reattachCalls).toBe(1);
    expect(driver.cancelCalls).toBe(0);
    expect(result.outcome).toEqual({ ok: true, finalSequence: 41 });
    // A ledger coordinate is a number. Anything the engine names would be a
    // string, and there is nowhere on this shape for one to travel.
    expect(Object.keys(result.outcome)).toEqual(["ok", "finalSequence"]);
  });

  it("lets an unreachable engine throw rather than becoming a refusal", async () => {
    // A whole driver rather than a spread of one: the operation may only be
    // proved against something that satisfies the entire contract.
    const driver = new CountingDriver({ ok: true, finalSequence: 0 });
    const throwing = (): Promise<never> =>
      Promise.reject(new SupervisorError("the attach for this invocation answered 503"));
    const unreachable: OrchestrationDriver = {
      mode: "RESTATE",
      cancel: throwing,
      reattach: throwing,
      signal: () => driver.signal(),
      timer: () => driver.timer(),
      advance: () => driver.advance(),
      status: () => driver.status(),
      reconcile: () => driver.reconcile(),
      capabilities: () => driver.capabilities(),
    };

    await expect(
      runLifecycleOperation({
        driver: unreachable,
        verb: "CANCEL",
        invocation: invocationFor(randomUUID()),
      }),
    ).rejects.toThrow(SupervisorError);
  });
});

describe("the shared prefix a lifecycle construction walks", () => {
  it("closes an open intent before the cancellation when the probe says DONE", async () => {
    const taskId = randomUUID();
    // Through the INTENT beat, and no further: the effect is in flight and its
    // OUTCOME has not been recorded.
    const { ledger } = seed("l2-prefix-done", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const before = ledger.status().eventCount;
    const context: BeatContext = {
      ...lifecycleBeat(ledger, probePort("DONE"), recovered.context)(recovered.context.invocation),
      plan: SHARED_PLAN_PREFIX,
      initiativeId: recovered.context.initiativeId,
    };

    const settlement = await settleCancellation(context);

    expect(settlement.verdict).toBe("CANCELLED");
    expect(settlement.effect).toBe("DONE");
    expect(settlement.closedIntent).toBe(true);

    // Two appends, in order: the outcome the walk would have written, then the
    // cancellation. A stubbed plan would have made the tests above pass while
    // this one appended the wrong outcome or none at all.
    const trail = ledger
      .listEvents({ limit: 200 })
      .events.map((record) => record.event)
      .filter((event) => event.taskId === taskId);
    expect(ledger.status().eventCount).toBe(before + 2);
    const last = trail.slice(-2);
    expect(last[0]?.transitionId).toBe(planStep(5).transitionId);
    expect(last[0]?.type).toBe("ATOMIC_STEP_COMPLETED");
    expect(last[1]?.type).toBe("TASK_CANCELLED");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("appends nothing at all when the probe cannot say", async () => {
    const taskId = randomUUID();
    const { ledger } = seed("l2-prefix-unknown", taskId, 4);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const before = ledger.status();
    const context: BeatContext = {
      ...lifecycleBeat(ledger, probePort("UNKNOWN"), recovered.context)(
        recovered.context.invocation,
      ),
      plan: SHARED_PLAN_PREFIX,
      initiativeId: recovered.context.initiativeId,
    };

    const settlement = await settleCancellation(context);

    expect(settlement.verdict).toBe("POSTCONDITION_UNKNOWN");
    expect(settlement.cancelled).toBeNull();
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
  });

  it("settles byte-identically under the prefix and under either full plan", async () => {
    const taskId = randomUUID();
    const bytes: string[] = [];

    for (const [index, plan] of [SHARED_PLAN_PREFIX, LIFECYCLE_PLAN].entries()) {
      const { ledger } = seed("l2-prefix-equal-" + String(index), taskId, 4);
      const recovered = restateInvocation(ledger, taskId, 1);
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;

      const context: BeatContext = {
        ...lifecycleBeat(ledger, probePort("NOT_DONE"), recovered.context)(
          recovered.context.invocation,
        ),
        plan,
        initiativeId: recovered.context.initiativeId,
      };
      const settlement = await settleCancellation(context);
      expect(settlement.verdict).toBe("CANCELLED");
      bytes.push(JSON.stringify(settlement.cancelled));
    }

    // The whole of the argument for a plan-free lifecycle construction: on the
    // cancel path the plan is inert, so refusing to guess a commit policy costs
    // nothing that could be observed in the log.
    expect(bytes[0]).toBe(bytes[1]);
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón B: recovery reads an opening-first V2 task (ADR 0102)
// ---------------------------------------------------------------------------

/**
 * The task's envelope reference, planted through the ledger's artifact door, and
 * the revision naming it (the step executor suite's fixture, restated).
 */
function plantRevision(ledger: Ledger, taskId: string): NonNullable<DurableInvocation["revision"]> {
  const reference = "ref-envelope-" + taskId;
  const envelope = (kind: string, ordinal: number, payload: Record<string, unknown>): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId: deterministicUuid("envelope/" + taskId + "/" + kind),
    idempotencyKey: "envelope/" + taskId + "/" + kind,
    subjectKind: "ARTIFACT",
    artifactEventKind: kind,
    subjectOrdinal: ordinal,
    parentSubjectOrdinal: ordinal === 1 ? null : ordinal - 1,
    recordedBy: EMITTED_BY,
    occurredAt: SUBMITTED_AT,
    recordedAt: SUBMITTED_AT,
    payload,
  });
  const common = { commandId: "cmd-envelope", contentSha256: "7".repeat(64), blobGeneration: 1, artifactPinId: "pin-envelope" };
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
  return {
    revisionId: deterministicUuid("revision/" + taskId + "/4"),
    revisionNumber: 4,
    attemptNumber: 1,
    envelopeSha256: "e".repeat(64),
    envelopeArtifactReferenceId: reference,
  };
}

/** An opening-first V2 walk through the INTENT, so the route is recorded. */
function seedV2(name: string, taskId: string): { readonly ledger: Ledger; readonly invocation: DurableInvocation } {
  const root = scenario(name);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  const revision = plantRevision(ledger, taskId);
  const digest = canonicalSubmissionDigest({
    taskId,
    attempt: 1,
    submittedAt: SUBMITTED_AT,
    initiativeId: TEST_INITIATIVE_ID,
    route: TEST_ROUTE,
  });
  const invocation = deriveInvocation(taskId, 1, SUBMITTED_AT, digest, revision);
  append(ledger, invocation, ATTEMPT_OPENING_STEP);
  for (let index = 0; index <= INTENT_STEP.index; index += 1) append(ledger, invocation, planStep(index));
  return { ledger, invocation };
}

/** The ledger, with the first event's JSON or the key lookup replaced. */
function doctored(
  ledger: Ledger,
  overrides: {
    readonly firstEvent?: (json: Record<string, unknown>) => Record<string, unknown>;
    readonly byKey?: (key: string) => { readonly canonicalJson: string } | null;
    readonly revision?: (row: ReturnType<LifecycleRecoveryPort["getTaskRevision"]>) => ReturnType<LifecycleRecoveryPort["getTaskRevision"]>;
  },
): LifecycleRecoveryPort {
  return {
    getTask: (taskId) => ledger.getTask(taskId),
    getExecutionRoute: (taskId, attempt) => ledger.getExecutionRoute(taskId, attempt),
    getTaskRevision: (taskId, revisionNumber) => {
      const row = ledger.getTaskRevision(taskId, revisionNumber);
      return overrides.revision === undefined ? row : overrides.revision(row);
    },
    getEventByIdempotencyKey: (key) =>
      overrides.byKey === undefined ? ledger.getEventByIdempotencyKey(key) : overrides.byKey(key),
    getEventBySequence: (sequence) => {
      const recorded = ledger.getEventBySequence(sequence);
      if (recorded === null || overrides.firstEvent === undefined) return recorded;
      const task = ledger.listEvents({ limit: 1 }).events[0];
      if (task?.sequence !== sequence) return recorded;
      return { canonicalJson: JSON.stringify(overrides.firstEvent(JSON.parse(recorded.canonicalJson) as Record<string, unknown>)) };
    },
  };
}

function withPayload(
  json: Record<string, unknown>,
  change: (payload: Record<string, unknown>) => void,
): Record<string, unknown> {
  const payload = { ...(json["payload"] as Record<string, unknown>) };
  change(payload);
  return { ...json, payload };
}

describe("P-15/B: restateInvocation reads an opening-first V2 task (ADR 0102)", () => {
  it("PC-B4: recovers the revision field for field, and the opening's own invocation id", () => {
    const taskId = "b4b4b4b4-0000-4000-8000-0000000000b1";
    const { ledger, invocation } = seedV2("p15b-restate-v2", taskId);
    const recovered = restateInvocation(ledger, taskId, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.context.invocation).toEqual(invocation);
    expect(recovered.context.invocation.revision).toEqual(invocation.revision);
    const opening = ledger.getEventByIdempotencyKey(
      buildV2IdempotencyKey({
        stream: "control_plane_events",
        taskId,
        revisionNumber: 4,
        attemptNumber: 1,
        transitionId: ATTEMPT_OPENING_STEP.transitionId,
      }),
    );
    const payload = (JSON.parse(opening?.canonicalJson ?? "{}") as { payload: Record<string, unknown> }).payload;
    expect(recovered.context.invocation.invocationId).toBe(payload["invocationId"]);
    expect(recovered.context.initiativeId).toBe(TEST_INITIATIVE_ID);
    expect(recovered.context.route).toEqual(TEST_ROUTE);
  });

  it("PC-B5: the recovered context cancels the task with a V2 TASK_CANCELLED, end to end", async () => {
    const taskId = "b4b4b4b4-0000-4000-8000-0000000000b2";
    const { ledger } = seedV2("p15b-restate-cancel", taskId);
    const recovered = restateInvocation(ledger, taskId, 1);
    if (!recovered.ok) throw new Error("expected a recovered context");
    const context: BeatContext = {
      ...lifecycleBeat(ledger, probePort("DONE"), recovered.context)(recovered.context.invocation),
      plan: SHARED_PLAN_PREFIX,
      initiativeId: recovered.context.initiativeId,
    };
    const settlement = await settleCancellation(context);
    expect(settlement.verdict).toBe("CANCELLED");
    expect(settlement.cancelled?.payload).toMatchObject({ revisionNumber: 4, attemptNumber: 1 });
    expect(ledger.getTask(taskId)?.currentState).toBe("CANCELLED");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-B-6: an opening that names an invocation other than this coordinate's is unreadable, not a digest mismatch", () => {
    const taskId = "b4b4b4b4-0000-4000-8000-0000000000b3";
    const { ledger } = seedV2("p15b-restate-mismatch", taskId);
    const port = doctored(ledger, {
      firstEvent: (json) =>
        withPayload(json, (payload) => {
          payload["invocationId"] = "00000000-0000-4000-8000-0000000000fe";
        }),
    });
    // The invocation id is derived from the task and the flat attempt alone, so it
    // certifies nothing about the submission digest: the opening is present and
    // invalid, and is refused as such.
    expect(restateInvocation(port, taskId, 1)).toEqual({
      ok: false,
      refusal: "DISCOVERY_UNREADABLE",
      at: "task.firstSequence",
    });
  });

  it("N-B-6′: an opening field absent, null or of the wrong type is unreadable, never read as no opening", () => {
    const taskId = "b4b4b4b4-0000-4000-8000-0000000000b4";
    const { ledger } = seedV2("p15b-restate-fields", taskId);
    // The two coordinate numbers are not in this list: changing them moves the
    // key rule, so the contract refuses the event and it is not an opening at all
    // (the same refusal, by another road).
    const fields = ["revisionId", "envelopeSha256", "envelopeArtifactReferenceId", "invocationId", "legacyAttemptNumber"];
    const variants: readonly (readonly [string, unknown])[] = [
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
      ["number", 7],
    ];
    for (const field of fields) {
      for (const [name, value] of variants) {
        const port = doctored(ledger, {
          firstEvent: (json) =>
            withPayload(json, (payload) => {
              if (value === undefined) Reflect.deleteProperty(payload, field);
              else payload[field] = value;
            }),
        });
        expect({ field, name, outcome: restateInvocation(port, taskId, 1) }).toEqual({
          field,
          name,
          outcome: { ok: false, refusal: "DISCOVERY_UNREADABLE", at: "task.firstSequence" },
        });
      }
    }
    // And the undoctored ledger recovers, so the refusals above are the fields'.
    expect(restateInvocation(ledger, taskId, 1).ok).toBe(true);
  });

  it("N-B-7: an opening whose discovery is missing under its V2 key is refused at the discovery", () => {
    const taskId = "b4b4b4b4-0000-4000-8000-0000000000b5";
    const { ledger } = seedV2("p15b-restate-no-discovery", taskId);
    const port = doctored(ledger, { byKey: () => null });
    expect(restateInvocation(port, taskId, 1)).toEqual({
      ok: false,
      refusal: "DISCOVERY_UNREADABLE",
      at: "attempt.discovery",
    });
  });

  it("N-B-8, inverted by P-15/D1 (ADR 0105): an intake-first task is read through the opening that follows its intake", () => {
    // B refused an intake-first task by name until D owned the intake → opening →
    // discovery continuity (adjudication v2 C2). D1 reads it: the first event is the
    // intake, the opening is found under its V2 key at the intake's coordinate, and its
    // revision record must be the intake's. The task is the opening-first one seeded
    // above, with its first event replaced by the intake that would have preceded it.
    const taskId = "b4b4b4b4-0000-4000-8000-0000000000b6";
    const { ledger, invocation } = seedV2("p15b-restate-intake", taskId);
    const revision = invocation.revision;
    if (revision === undefined) throw new Error("expected a revision");
    const intakeFor = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      contractVersion: CONTRACT_VERSION,
      eventId: deterministicUuid("intake/" + taskId),
      taskId,
      attempt: 1,
      transitionId: "intake",
      idempotencyKey: buildV2IdempotencyKey({
        stream: "control_plane_events",
        taskId,
        revisionNumber: revision.revisionNumber,
        attemptNumber: revision.attemptNumber,
        transitionId: "intake",
      }),
      type: "TASK_DISCOVERED",
      fromState: null,
      toState: "DISCOVERED",
      emittedBy: EMITTED_BY,
      occurredAt: SUBMITTED_AT,
      recordedAt: SUBMITTED_AT,
      correlationId: null,
      causationId: null,
      payload: {
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        attemptNumber: revision.attemptNumber,
        envelopeSha256: revision.envelopeSha256,
        restoredFromRevisionId: null,
        envelopeArtifactReferenceId: revision.envelopeArtifactReferenceId,
        initiativeId: TEST_INITIATIVE_ID,
        clientScope: EMITTED_BY,
        clientRequestKey: "intake-0001",
        roadmapVersionId: null,
        stepId: null,
        role: "implementer",
        commitPolicy: "NO_COMMIT",
        resolution: {
          assignmentId: "routing:GLOBAL:implementer:0@1",
          assignmentVersion: 1,
          slot: 0,
          modelVersionId: "claude-opus-5@2026-06-01",
          provider: TEST_ROUTE.provider,
          model: TEST_ROUTE.model,
          release: "2026-06-01",
          transportKind: TEST_ROUTE.transportKind,
          watermarks: [
            {
              projectionName: "routing_assignment_read_model",
              sourceStream: "registry_events",
              appliedThroughSequence: 1,
              eventCount: 1,
              sourceHeadSha256: "a".repeat(64),
            },
          ],
        },
        ...overrides,
      },
    });

    const recovered = restateInvocation(doctored(ledger, { firstEvent: () => intakeFor() }), taskId, 1);
    expect(recovered).toMatchObject({ ok: true });
    if (recovered.ok) expect(recovered.context.invocation).toEqual(invocation);

    // The opening must be there, and carry the intake's revision, field by field.
    expect(restateInvocation(doctored(ledger, { firstEvent: () => intakeFor(), byKey: () => null }), taskId, 1)).toEqual({
      ok: false,
      refusal: "DISCOVERY_UNREADABLE",
      at: "attempt.opening",
    });
    for (const [field, value] of [
      ["revisionId", "00000000-0000-4000-8000-00000000abcd"],
      ["envelopeSha256", "f".repeat(64)],
      ["envelopeArtifactReferenceId", "another-reference"],
    ] as const) {
      expect(restateInvocation(doctored(ledger, { firstEvent: () => intakeFor({ [field]: value }) }), taskId, 1)).toEqual({
        ok: false,
        refusal: "DISCOVERY_UNREADABLE",
        at: "attempt.opening." + field,
      });
    }
  });

  it("B-N1 (P-15/D1): the opening's revision is held to the revision read model, field by field, and a mismatch is unreadable, not a digest mismatch", () => {
    // The submission digest's preimage is the task, the attempt, the instant, the
    // initiative and the route: no revision field enters it, so a revision the read
    // model disagrees with is an opening this door cannot attribute (decision 119's
    // correction, applied to the revision), never SUBMISSION_DIGEST_MISMATCH.
    const taskId = "b4b4b4b4-0000-4000-8000-0000000000b7";
    const { ledger } = seedV2("p15d1-restate-revision", taskId);
    expect(restateInvocation(doctored(ledger, { revision: () => null }), taskId, 1)).toEqual({
      ok: false,
      refusal: "DISCOVERY_UNREADABLE",
      at: "attempt.revision",
    });
    const variants: readonly (readonly [string, unknown])[] = [
      ["revisionId", "00000000-0000-4000-8000-00000000abcd"],
      ["revisionId", ""],
      ["envelopeSha256", "f".repeat(64)],
      ["envelopeSha256", ""],
      ["envelopeArtifactReferenceId", null],
      ["envelopeArtifactReferenceId", "another-reference"],
    ];
    for (const [field, value] of variants) {
      const port = doctored(ledger, {
        revision: (row) => (row === null ? null : ({ ...row, [field]: value } as typeof row)),
      });
      expect({ field, value, outcome: restateInvocation(port, taskId, 1) }).toEqual({
        field,
        value,
        outcome: { ok: false, refusal: "DISCOVERY_UNREADABLE", at: "attempt.revision." + field },
      });
    }
    // And the undoctored read model agrees, so the refusals above are the fields'.
    expect(restateInvocation(ledger, taskId, 1).ok).toBe(true);
  });
});
