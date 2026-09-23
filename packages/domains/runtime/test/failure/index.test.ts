import { createHash } from "node:crypto";

import {
  CONTRACT_VERSION,
  CONTROL_PLANE_EVENT_TYPES,
  EXCEPTIONAL_STATES,
  EXECUTION_REFUSALS,
  TERMINAL_STATES,
  buildV2IdempotencyKey,
} from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import { canonicalJsonStringify, LedgerError, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import { deterministicUuid } from "../../src/core/coordinates/index.js";
import { ATTEMPT_OPENING_STEP, operationForStep } from "../../src/core/events/index.js";
import { INTENT_STEP, READ_ONLY_PLAN, planStep } from "../../src/core/lifecycle/index.js";
import { appendPlanStep, assertInvocationContinuity, currentState } from "../../src/core/step-executor/index.js";
import type { BeatContext, EffectPort } from "../../src/core/step-executor/index.js";
import {
  LifecyclePlanError,
  PostconditionUnknownError,
  ReconciliationError,
  SupervisorError,
  ToyBoundaryError,
} from "../../src/errors/index.js";
import { ExecutionEffectError } from "../../src/execution-effects/index.js";
import {
  FAILURE_REASONS,
  FAILURE_REFUSALS,
  FAILURE_TRANSITION_ID,
  FAILURE_VERDICTS,
  classifyFailure,
  failurePrecheck,
  settleFailure,
} from "../../src/failure/index.js";
import {
  applyEffect,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";
import { deriveInvocation } from "../../src/submission/index.js";

/**
 * Terminal settlement for a walk that could not finish (V2-B7T).
 *
 * Every drill here runs against a **real ledger** and a real partial walk: the
 * events are appended by the same `appendPlanStep` the supervisor uses, and the
 * state the settlement reads is the one the projection actually holds. Nothing
 * is stubbed, because the whole claim is about what the ledger says afterwards.
 *
 * **Why the supervisor's own bound is not driven here, stated plainly.** The
 * guard `runToCheckpoint` settles on — `guard <= plan.length + 1` — is
 * unreachable through the public API against a consistent ledger, and that was
 * measured rather than assumed: both plans need exactly `plan.length + 1`
 * iterations to converge, leaving one spare, and the only non-advancing step is
 * the OUTCOME beat, which advances the moment its event exists. `closeIntent`
 * throws `PostconditionUnknownError` rather than looping when a probe will not
 * settle. So the guard is defensive, and reaching it would require a ledger
 * that contradicts itself — a fixture standing in for a real artifact, which
 * this repository does not accept as evidence. The settlement is therefore
 * proved here, completely, against the real thing; that the supervisor *calls*
 * it on that path is proved mechanically by the fence law L-B7T-1 and its
 * failing fixture. Both halves are named in the report.
 */

const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-b7t-failure",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const EMITTED_BY = "claude/opus/implementer/01";

const scenarios: string[] = [];
const ledgers: Ledger[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
});

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function track(ledger: Ledger): Ledger {
  ledgers.push(ledger);
  return ledger;
}

function invocationFor(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("b7t-failure/" + taskId),
    submittedAt: "2026-08-27T12:00:00.000Z",
    submissionDigest: "d".repeat(64),
  };
}

function toyEffects(root: ScenarioRoot): EffectPort {
  return {
    apply: (operation) => {
      applyEffect(root, operation);
      return Promise.resolve();
    },
    probe: (operation) => Promise.resolve(probeEffect(root, operation)),
  };
}

/** An effect port whose postcondition can never be established. */
function unknownEffects(): EffectPort {
  return {
    apply: () => Promise.resolve(),
    probe: () => Promise.resolve("UNKNOWN"),
  };
}

function contextFor(root: ScenarioRoot, ledger: Ledger, invocation: DurableInvocation, effects?: EffectPort): BeatContext {
  return {
    ledger,
    effects: effects ?? toyEffects(root),
    invocation,
    emittedBy: EMITTED_BY,
    plan: READ_ONLY_PLAN,
    initiativeId: INITIATIVE_ID,
    route: TEST_ROUTE,
  };
}

/** Walk the plan by hand up to (not including) `stopBefore`. */
function walkTo(context: BeatContext, stopBefore: number): void {
  assertInvocationContinuity(context);
  for (let index = 0; index < stopBefore; index += 1) {
    appendPlanStep(context, planStep(index));
  }
}

interface Staged {
  readonly root: ScenarioRoot;
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly context: BeatContext;
}

function stage(name: string, taskId: string, stopBefore: number, effects?: EffectPort): Staged {
  const root = scenario(name);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  const invocation = invocationFor(taskId);
  const context = contextFor(root, ledger, invocation, effects);
  walkTo(context, stopBefore);
  return { root, ledger, invocation, context };
}

const TASKS = {
  p1: "b7100000-0000-4000-8000-000000000001",
  p2: "b7100000-0000-4000-8000-000000000002",
  p3: "b7100000-0000-4000-8000-000000000003",
  done: "b7100000-0000-4000-8000-000000000004",
  unknown: "b7100000-0000-4000-8000-000000000005",
  terminal: "b7100000-0000-4000-8000-000000000006",
  absent: "b7100000-0000-4000-8000-000000000007",
  privacy: "b7100000-0000-4000-8000-000000000008",
} as const;

// ---------------------------------------------------------------------------
// P1 — the settlement appends exactly one TASK_FAILED
// ---------------------------------------------------------------------------

describe("P1: a walk that cannot finish settles", () => {
  it("appends exactly one TASK_FAILED, from the state the ledger reported", async () => {
    const staged = stage("b7t-p1", TASKS.p1, 4);
    // The state immediately before the append, read from the ledger and not
    // remembered from the walk.
    const before = currentState(staged.context);
    expect(before).toBe("RESERVED");
    const countBefore = staged.ledger.status().eventCount;

    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");

    expect(settlement.verdict).toBe("FAILED");
    expect(settlement.failed).not.toBeNull();
    expect(settlement.failed?.type).toBe("TASK_FAILED");
    expect(settlement.failed?.toState).toBe("FAILED");
    expect(settlement.failed?.fromState).toBe(before);
    expect(settlement.failed?.transitionId).toBe(FAILURE_TRANSITION_ID);
    expect(staged.ledger.status().eventCount).toBe(countBefore + 1);

    const failures = staged.ledger
      .listEvents({ taskId: TASKS.p1, limit: 200 })
      .events.filter((entry) => entry.event.type === "TASK_FAILED");
    expect(failures).toHaveLength(1);
  });

  it("closes an open intent whose effect happened, before claiming the terminal", async () => {
    // Through the INTENT beat, with the effect actually performed, so the probe
    // answers DONE. The OUTCOME that records it must precede the failure: a
    // terminal appended over an unrecorded effect is the shape ADR 0004 refuses.
    const staged = stage("b7t-done", TASKS.done, 5);
    await staged.context.effects.apply(operationForStep(staged.invocation, INTENT_STEP));
    expect(currentState(staged.context)).toBe("RUNNING");

    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");

    expect(settlement.verdict).toBe("FAILED");
    expect(settlement.effect).toBe("DONE");
    expect(settlement.closedIntent).toBe(true);

    const types = staged.ledger
      .listEvents({ taskId: TASKS.done, limit: 200 })
      .events.map((entry) => entry.event.type);
    // The outcome is recorded before the terminal, in that order.
    expect(types.indexOf("TASK_STATE_CHANGED")).toBeLessThan(types.indexOf("TASK_FAILED"));
    expect(types.filter((type) => type === "TASK_FAILED")).toHaveLength(1);
  });

  it("refuses to settle a task the ledger has never seen", () => {
    const root = scenario("b7t-absent");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const context = contextFor(root, ledger, invocationFor(TASKS.absent));
    expect(() => failurePrecheck(context)).toThrow(SupervisorError);
    expect(() => failurePrecheck(context)).toThrow(/nothing to fail/);
    expect(ledger.status().eventCount).toBe(0);
  });

  it("appends nothing for a task that already reached a terminal", async () => {
    const staged = stage("b7t-terminal", TASKS.terminal, 4);
    await settleFailure(staged.context, "BOUND_EXHAUSTED");
    const afterFirst = staged.ledger.status().eventCount;

    // Now FAILED, which is terminal. A second settlement must not append a
    // second terminal, and must say why rather than silently doing nothing.
    const second = await settleFailure(staged.context, "BOUND_EXHAUSTED");
    expect(second.verdict).toBe("TASK_TERMINAL");
    expect(second.failed).toBeNull();
    expect(staged.ledger.status().eventCount).toBe(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// P2 — settlement is idempotent
// ---------------------------------------------------------------------------

describe("P2: settling twice appends once", () => {
  it("rebuilds the same key and appends nothing the second time", async () => {
    const staged = stage("b7t-p2", TASKS.p2, 4);
    const first = await settleFailure(staged.context, "BOUND_EXHAUSTED");
    const countAfterFirst = staged.ledger.status().eventCount;
    const headAfterFirst = staged.ledger.status().headEventSha256;

    // A fresh context over the same ledger and the same durable invocation:
    // exactly what a re-run after a crash is. `settleFailure` refuses on the
    // terminal precheck, so drive the append itself through the same key by
    // asking the ledger directly for the row the first settlement wrote.
    const key = first.failed?.idempotencyKey;
    expect(key).toBeDefined();
    const stored = staged.ledger.getEventByIdempotencyKey(key ?? "");
    expect(stored).not.toBeNull();

    const replay = staged.ledger.append(first.failed ?? stored!.event);
    expect(replay.inserted).toBe(false);
    expect(staged.ledger.status().eventCount).toBe(countAfterFirst);
    expect(staged.ledger.status().headEventSha256).toBe(headAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// P3 — the task is terminal afterwards
// ---------------------------------------------------------------------------

describe("P3: the settled task is terminal", () => {
  it("leaves the projection FAILED, and FAILED is terminal by the contract", async () => {
    const staged = stage("b7t-p3", TASKS.p3, 4);
    await settleFailure(staged.context, "BOUND_EXHAUSTED");

    const task = staged.ledger.getTask(TASKS.p3);
    expect(task).not.toBeNull();
    expect(task?.currentState).toBe("FAILED");
    // Asserted from the contract, never restated here.
    expect(TERMINAL_STATES).toContain("FAILED");
    expect(currentState(staged.context)).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// N2 — POSTCONDITION_UNKNOWN settles nothing
// ---------------------------------------------------------------------------

describe("N2: an unestablished postcondition settles nothing", () => {
  it("appends no TASK_FAILED and leaves the intent open", async () => {
    // Through the INTENT beat, with a port that can never establish the
    // postcondition. This is the one case where a terminal would be a lie.
    const staged = stage("b7t-unknown", TASKS.unknown, 5, unknownEffects());
    const countBefore = staged.ledger.status().eventCount;

    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");

    expect(settlement.verdict).toBe("POSTCONDITION_UNKNOWN");
    expect(settlement.failed).toBeNull();
    expect(staged.ledger.status().eventCount).toBe(countBefore);

    const types = staged.ledger
      .listEvents({ taskId: TASKS.unknown, limit: 200 })
      .events.map((entry) => entry.event.type);
    expect(types).not.toContain("TASK_FAILED");
    // The intent stays open for an operator: RUN_STARTED is there and its
    // outcome is not.
    expect(types).toContain("RUN_STARTED");
    expect(staged.ledger.getTask(TASKS.unknown)?.currentState).toBe("RUNNING");
    expect(TERMINAL_STATES).not.toContain("RUNNING");
  });
});

// ---------------------------------------------------------------------------
// N4, N5 — the payload carries a classified code and nothing else
// ---------------------------------------------------------------------------

describe("N4/N5: the failure payload is a digest and a closed reason", () => {
  it("carries no free text, no path and no credential", async () => {
    const staged = stage("b7t-privacy", TASKS.privacy, 4);
    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");

    const payload = settlement.failed?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual(["reason", "submissionDigest"]);
    expect(FAILURE_REASONS).toContain(payload["reason"]);

    const serialized = staged.ledger
      .listEvents({ taskId: TASKS.privacy, limit: 200 })
      .events.map((entry) => entry.canonicalJson)
      .join("\n");
    expect(serialized.length).toBeGreaterThan(0);
    for (const forbidden of ["/Users/", "/private/", "credentialRef", "authProfileRef", "profile://", "Bearer "]) {
      expect(serialized).not.toContain(forbidden);
    }
    // No exception message from a lower layer ever reaches the log.
    expect(serialized).not.toContain("did not reach a terminal state");
  });

  it("keeps the verdict and reason vocabularies closed", () => {
    expect([...FAILURE_VERDICTS].sort()).toEqual(["FAILED", "POSTCONDITION_UNKNOWN", "TASK_TERMINAL"]);
    // One member per trigger that earned it: B7T's bounded convergence guard,
    // and B7R's classified step failure. A reason is never added in advance.
    expect([...FAILURE_REASONS]).toEqual(["BOUND_EXHAUSTED", "EXECUTION_FAILED"]);
  });
});

// ---------------------------------------------------------------------------
// N8 — no new vocabulary
// ---------------------------------------------------------------------------

describe("N8: this packet introduced no state and no event type", () => {
  it("leaves the contract's two closed lists exactly where they were", () => {
    // 35 since P-32/captura B, which added its two usage types on top of
    // F's three outbox types, D's prompt and response occurrences, C's effect and
    // dispatch intentions, C's dispatch resolution and B's `TASK_ATTEMPT_OPENED`. The number moving is
    // not this packet's doing and not a loosening of N8: what N8 claims is that
    // *this* packet introduced nothing, and the two names it leans on are still
    // the ones it always leaned on.
    expect(CONTROL_PLANE_EVENT_TYPES).toHaveLength(35);
    expect(EXCEPTIONAL_STATES).toHaveLength(8);
    // The two names this packet leans on were already there.
    expect(CONTROL_PLANE_EVENT_TYPES).toContain("TASK_FAILED");
    expect(EXCEPTIONAL_STATES).toContain("FAILED");
    expect(TERMINAL_STATES).toContain("FAILED");
  });
});

// ---------------------------------------------------------------------------
// V2-B7R: the classification table, as data and as a decision
// ---------------------------------------------------------------------------

/**
 * One decision module, shared by both drivers.
 *
 * The table below is the packet's central law made into a test: what a caught
 * error entitles the log to say. Its default is refusal, so an error nobody
 * classified settles nothing — a terminal event is a claim that the task ended,
 * and a claim made from an unclassified error is a guess.
 */
describe("classifyFailure (V2-B7R)", () => {
  const REFUSED: readonly [string, unknown, string][] = [
    // The packet's central law: an effect may have happened unrecorded.
    ["PostconditionUnknownError", new PostconditionUnknownError("op", "unknown"), "POSTCONDITION_UNKNOWN"],
    // The prologue's zero-delta law.
    ["ReconciliationError", new ReconciliationError("refused"), "RECONCILIATION"],
    // The task's identity is in question.
    ["SupervisorError", new SupervisorError("continuity"), "CONTINUITY"],
    // Raised before a ledger is open; there is no task to settle.
    ["ToyBoundaryError", new ToyBoundaryError("outside"), "BOUNDARY"],
    // On an already terminal task this is the correct refusal of a re-walk.
    ["LifecyclePlanError", new LifecyclePlanError("no step"), "PLAN"],
    // A claim built on the thing that just failed.
    ["LedgerError", new LedgerError("LEDGER_QUERY", "refusing"), "LEDGER"],
    // Fail closed: anything unrecognised.
    ["a bare Error", new Error("something"), "UNCLASSIFIED"],
    ["a thrown string", "not an error", "UNCLASSIFIED"],
    ["null", null, "UNCLASSIFIED"],
  ];

  it("refuses to settle every error that is not a classified step failure", () => {
    for (const [label, error, refusal] of REFUSED) {
      const decision = classifyFailure(error);
      expect({ label, settle: decision.settle }).toEqual({ label, settle: false });
      expect({ label, refusal: decision.settle ? null : decision.refusal }).toEqual({ label, refusal });
      expect(FAILURE_REFUSALS).toContain(refusal);
    }
  });

  it("settles a classified step failure, under a reason from the closed list", () => {
    // Total over the vocabulary, not over a hand-written copy of it (V2-B4a).
    // The list used to be four names typed out here, which was exactly right
    // until a fifth arrived — and then it would have kept passing while
    // saying nothing about `EXECUTION_IN_FLIGHT`. A negative left enumerating
    // a retired vocabulary passes for the wrong reason.
    expect(EXECUTION_REFUSALS.length).toBeGreaterThan(0);
    for (const refusal of EXECUTION_REFUSALS) {
      const decision = classifyFailure(new ExecutionEffectError(refusal, "route.accountId"));
      expect(decision.settle).toBe(true);
      if (decision.settle) {
        expect(decision.reason).toBe("EXECUTION_FAILED");
        expect(FAILURE_REASONS).toContain(decision.reason);
      }
    }
  });

  it("never returns a decision carrying a message", () => {
    // L-B7R-3 from the decision's side: whatever the error said, the decision
    // carries a classified word and nothing else.
    const noisy = new ExecutionEffectError("ROUTE_INVALID", "route.accountId");
    noisy.message = "boom at /Users/someone/secret with sk-canary-4242";
    const serialized = JSON.stringify(classifyFailure(noisy));
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("sk-canary-4242");
    expect(serialized).toBe(JSON.stringify({ settle: true, reason: "EXECUTION_FAILED" }));
  });

  it("keeps the refusal vocabulary closed and sorted", () => {
    expect([...FAILURE_REFUSALS]).toEqual([...FAILURE_REFUSALS].sort());
    expect([...FAILURE_REFUSALS]).toEqual([
      "BOUNDARY", "CONTINUITY", "LEDGER", "PLAN", "POSTCONDITION_UNKNOWN", "RECONCILIATION", "UNCLASSIFIED",
    ]);
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón B: the failure settlement speaks the V2 coordinate (ADR 0102)
// ---------------------------------------------------------------------------

const P15B_AT = "2026-08-27T12:00:00.000Z";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The canonical bytes of the task's last event. */
/**
 * The event's canonical bytes with its version restamped "2.8.0", the version the
 * vectors below were lifted under: P-15 escalón C moved the version in force to
 * 2.9.0 and that one field only (ADR 0103), so every other byte is held.
 */
function restampedAsLifted(canonicalJson: string): string {
  const event = JSON.parse(canonicalJson) as Record<string, unknown>;
  event["contractVersion"] = "2.8.0";
  return canonicalJsonStringify(event);
}

function lastEventSha(ledger: Ledger, taskId: string): string {
  return sha256(restampedAsLifted(ledger.listEvents({ taskId, limit: 500 }).events.at(-1)?.canonicalJson ?? "{}"));
}

/**
 * The task's envelope reference, planted through the ledger's artifact door, and
 * the revision that names it (the step executor suite's fixture, restated: a test
 * file cannot export helpers). The revision's number differs from the flat
 * attempt, so a payload that read the flat attempt would be caught.
 */
function p15bRevision(ledger: Ledger, taskId: string, at: string): NonNullable<DurableInvocation["revision"]> {
  const reference = "ref-envelope-" + taskId;
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
    occurredAt: at,
    recordedAt: at,
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
  return {
    revisionId: deterministicUuid("revision/" + taskId + "/4"),
    revisionNumber: 4,
    attemptNumber: 1,
    envelopeSha256: "e".repeat(64),
    envelopeArtifactReferenceId: reference,
  };
}

/** A V2 attempt, opened and walked by hand up to (not including) `stopBefore`. */
function stageV2(name: string, taskId: string, stopBefore: number, effects?: EffectPort): Staged {
  const root = scenario(name);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  const invocation = deriveInvocation(taskId, 1, P15B_AT, "d".repeat(64), p15bRevision(ledger, taskId, P15B_AT));
  const context = contextFor(root, ledger, invocation, effects);
  appendPlanStep(context, ATTEMPT_OPENING_STEP);
  walkTo(context, stopBefore);
  return { root, ledger, invocation, context };
}

describe("P-15/B: the failure settlement under V1 and under V2 (ADR 0102)", () => {
  it("PC-B1: a V1 TASK_FAILED is byte-identical to the one built before B", async () => {
    const staged = stage("p15b-failure-v1", "b7100000-0000-4000-8000-0000000000b1", 4);
    await settleFailure(staged.context, "BOUND_EXHAUSTED");
    expect(lastEventSha(staged.ledger, staged.invocation.taskId)).toBe(
      // Lifted by running the pre-B source (HEAD 313512d) over this fixture.
      "b7f3ddc29fd0c6a79ff2474b2e0307cbc270ebb90ee2ae4896d7457d35754f2e",
    );
  });

  it("PC-B2: a V2 TASK_FAILED carries the revision's coordinate, keys V2 and settles once", async () => {
    const staged = stageV2("p15b-failure-v2", "b7100000-0000-4000-8000-0000000000b2", 4);
    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");
    expect(settlement.verdict).toBe("FAILED");
    expect(settlement.failed?.payload).toEqual({
      submissionDigest: "d".repeat(64),
      reason: "BOUND_EXHAUSTED",
      revisionNumber: 4,
      attemptNumber: 1,
    });
    expect(settlement.failed?.idempotencyKey).toBe(
      buildV2IdempotencyKey({
        stream: "control_plane_events",
        taskId: staged.invocation.taskId,
        revisionNumber: 4,
        attemptNumber: 1,
        transitionId: FAILURE_TRANSITION_ID,
      }),
    );
    expect(staged.ledger.getTask(staged.invocation.taskId)?.currentState).toBe("FAILED");
    const count = staged.ledger.status().eventCount;
    expect((await settleFailure(staged.context, "BOUND_EXHAUSTED")).verdict).toBe("TASK_TERMINAL");
    expect(staged.ledger.status().eventCount).toBe(count);
  });

  it("PC-B3: a V2 settlement reads the open INTENT under its V2 key and closes it first", async () => {
    const staged = stageV2("p15b-failure-v2-intent", "b7100000-0000-4000-8000-0000000000b3", INTENT_STEP.index + 1);
    await staged.context.effects.apply(operationForStep(staged.invocation, INTENT_STEP));
    const settlement = await settleFailure(staged.context, "BOUND_EXHAUSTED");
    expect(settlement).toMatchObject({ verdict: "FAILED", effect: "DONE", closedIntent: true });
    expect(staged.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-B-1: an attempt the ledger never opened is refused by name before the probe, with zero delta", async () => {
    const staged = stageV2("p15b-failure-unopened", "b7100000-0000-4000-8000-0000000000b4", 4);
    const revision = staged.invocation.revision;
    if (revision === undefined) throw new Error("expected a revision");
    const unopened = deriveInvocation(staged.invocation.taskId, 2, P15B_AT, "d".repeat(64), { ...revision, attemptNumber: 2 });
    const status = staged.ledger.status();
    await expect(settleFailure({ ...staged.context, invocation: unopened }, "BOUND_EXHAUSTED")).rejects.toThrow(
      "has not been opened",
    );
    expect(staged.ledger.status().eventCount).toBe(status.eventCount);
    expect(staged.ledger.status().headEventSha256).toBe(status.headEventSha256);
  });

  it("N-B-10: a revision whose numbers differ from the recorded opening is refused, with zero delta", async () => {
    const staged = stageV2("p15b-failure-other-revision", "b7100000-0000-4000-8000-0000000000b5", 4);
    const revision = staged.invocation.revision;
    if (revision === undefined) throw new Error("expected a revision");
    const other = deriveInvocation(staged.invocation.taskId, 1, P15B_AT, "d".repeat(64), { ...revision, revisionNumber: 5 });
    const status = staged.ledger.status();
    // Other revision numbers move the opening's own key, so no opening stands there.
    await expect(settleFailure({ ...staged.context, invocation: other }, "BOUND_EXHAUSTED")).rejects.toThrow(SupervisorError);
    await expect(settleFailure({ ...staged.context, invocation: other }, "BOUND_EXHAUSTED")).rejects.toThrow(
      "has not been opened",
    );
    expect(staged.ledger.status().eventCount).toBe(status.eventCount);
    expect(staged.ledger.getTask(staged.invocation.taskId)?.currentState).toBe("RESERVED");
  });
});
