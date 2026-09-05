import { DriverCapabilities } from "@acp/contracts";
import type { CommitPolicy, DriverOutcome } from "@acp/contracts";
import {
  ExecutionEffectError,
  PostconditionUnknownError,
  SqliteSupervisor,
  driverCapabilityMismatches,
} from "@acp/runtime";
import { TerminalError } from "@restatedev/restate-sdk";
import { CONTRACT_VERSION, ReconciliationReport, findCredentialViolations } from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  READ_ONLY_PLAN,
  RESTATE_STATE_KEY_CACHE,
  SupervisorError,
  appendPlanStep,
  applyEffect,
  deriveEventCoordinate,
  deterministicUuid,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";
import type {
  BeatContext,
  DurableInvocation,
  LedgerPort,
  OrchestrationDriver,
  PostconditionVerdict,
  ScenarioRoot,
} from "@acp/runtime";
import type {
  Context,
  WorkflowContext,
  WorkflowSharedContext,
} from "@restatedev/restate-sdk";

import {
  RESTATE_GATE_PROMISE,
  RESTATE_HANDLER_GATE_RESOLVE,
  RESTATE_WORKFLOW_GATE,
} from "../../../src/contracts/index.js";
import type {
  DurableStepContext,
  GatePayload,
  GateResolveContext,
  GateRunContext,
  LedgerLike,
  RestateCacheState,
} from "../../../src/contracts/index.js";
import {
  RESTATE_MODE,
  RestateDriver,
  advanceHandler,
  gateResolveHandler,
  gateRunHandler,
  reconcile,
} from "../../../src/drivers/restate-driver/index.js";
import type { AdvanceContext } from "../../../src/drivers/restate-driver/index.js";
import { cancelAdvance, parseCacheReply, resolveGate, sendAdvanceDelayed } from "../../../src/submit/index.js";


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

/**
 * Unit and negative evidence for the Restate driver. No server is started.
 *
 * `DRIVER_AHEAD` and `DIVERGED` are unreachable in a correct run: the cache
 * holds two fields copied from the ledger, so it cannot get ahead of the log
 * that produced it. Both are therefore reached here by injecting state
 * directly. A drill that produces either WITHOUT injection is an
 * adoption-blocking defect, not a flaky test.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const scenarios: string[] = [];
const ledgers: Ledger[] = [];

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function invocationFor(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("inv/" + taskId),
    submittedAt: "2026-08-27T12:00:00.000Z",
    submissionDigest: "a".repeat(64),
  };
}

function open(name: string, taskId: string): {
  ledger: Ledger;
  root: ScenarioRoot;
  invocation: DurableInvocation;
  beat: (invocation: DurableInvocation) => BeatContext;
} {
  const root = scenario(name);
  const invocation = invocationFor(taskId);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const beat = (candidate: DurableInvocation): BeatContext => ({
    ledger,
    effects: {
      apply: (operation) => {
        applyEffect(root, operation);
        return Promise.resolve();
      },
      probe: (operation) => Promise.resolve(probeEffect(root, operation)),
    },
    invocation: candidate,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    route: TEST_ROUTE,
    initiativeId: TEST_INITIATIVE_ID,
  });
  return { ledger, root, invocation, beat };
}

function driverFor(
  ledger: Ledger,
  invocation: DurableInvocation,
  beat: (invocation: DurableInvocation) => Omit<BeatContext, "plan" | "initiativeId">,
  readCache?: () => Promise<RestateCacheState | null>,
): RestateDriver {
  return new RestateDriver(
    {
      ledger,
      invocation,
      emittedBy: EMITTED_BY,
      ingressUrl: "http://127.0.0.1:8080",
      adminUrl: "http://127.0.0.1:9070",
      readCache,
    },
    beat,
    "LOCAL_COMMIT_WITH_RECEIPT",
    TEST_INITIATIVE_ID,
  );
}

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

describe("restate driver reconciliation", () => {
  it("reports CONSISTENT when the cache matches the ledger head", async () => {
    const { ledger, invocation, beat } = open("rec-consistent", "20202020-2020-4202-8202-202020202021");
    appendPlanStep(beat(invocation), LIFECYCLE_PLAN[0]!);
    const status = ledger.status();

    const report = await reconcile({
      ledger,
      invocation,
      readCache: () =>
        Promise.resolve({
          lastAppliedSequence: status.headSequence,
          lastAppliedEventSha256: status.headEventSha256,
        }),
    });
    expect(report.verdict).toBe("CONSISTENT");
    expect(report.safeToResume).toBe(true);
    expect(report.discrepancies).toEqual([]);
    expect(report.resolvedByLedger).toBe(true);
    expect(report.ledgerHeadSha256).toBe(status.headEventSha256);
  });

  it("reports DRIVER_BEHIND when the driver holds no cache at all", async () => {
    const { ledger, invocation, beat } = open("rec-nocache", "20202020-2020-4202-8202-202020202022");
    appendPlanStep(beat(invocation), LIFECYCLE_PLAN[0]!);

    const report = await reconcile({ ledger, invocation, readCache: () => Promise.resolve(null) });
    // Absence is the reconstructible case, and the expected verdict after the
    // data root is deleted.
    expect(report.verdict).toBe("DRIVER_BEHIND");
    expect(report.safeToResume).toBe(true);
  });

  it("reports DRIVER_BEHIND when the ledger is a strict superset", async () => {
    const { ledger, invocation, beat } = open("rec-behind", "20202020-2020-4202-8202-202020202023");
    const context = beat(invocation);
    appendPlanStep(context, LIFECYCLE_PLAN[0]!);
    const first = ledger.getEventBySequence(1);
    appendPlanStep(context, LIFECYCLE_PLAN[1]!);

    const report = await reconcile({
      ledger,
      invocation,
      readCache: () =>
        Promise.resolve({ lastAppliedSequence: 1, lastAppliedEventSha256: first!.eventSha256 }),
    });
    expect(report.verdict).toBe("DRIVER_BEHIND");
    expect(report.safeToResume).toBe(true);
  });

  it("halts on an injected DRIVER_AHEAD cache", async () => {
    const { ledger, invocation, beat } = open("rec-ahead", "20202020-2020-4202-8202-202020202024");
    appendPlanStep(beat(invocation), LIFECYCLE_PLAN[0]!);

    const report = await reconcile({
      ledger,
      invocation,
      readCache: () =>
        Promise.resolve({ lastAppliedSequence: 99, lastAppliedEventSha256: "b".repeat(64) }),
    });
    expect(report.verdict).toBe("DRIVER_AHEAD");
    expect(report.safeToResume).toBe(false);
    expect(report.discrepancies.length).toBeGreaterThan(0);
  });

  it("halts on an injected DIVERGED cache and merges nothing", async () => {
    const { ledger, invocation, beat } = open("rec-diverged", "20202020-2020-4202-8202-202020202025");
    const context = beat(invocation);
    appendPlanStep(context, LIFECYCLE_PLAN[0]!);
    appendPlanStep(context, LIFECYCLE_PLAN[1]!);
    const before = ledger.status();

    const report = await reconcile({
      ledger,
      invocation,
      readCache: () =>
        Promise.resolve({ lastAppliedSequence: 1, lastAppliedEventSha256: "c".repeat(64) }),
    });
    expect(report.verdict).toBe("DIVERGED");
    expect(report.safeToResume).toBe(false);
    expect(report.discrepancies.length).toBeGreaterThan(0);
    // No merge: reconciliation reads, it never writes.
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
    expect(ledger.status().eventCount).toBe(before.eventCount);
  });

  it("reports INDETERMINATE when the cache read throws", async () => {
    const { ledger, invocation } = open("rec-throws", "20202020-2020-4202-8202-202020202026");
    const report = await reconcile({
      ledger,
      invocation,
      readCache: () => Promise.reject(new Error("unreachable")),
    });
    expect(report.verdict).toBe("INDETERMINATE");
    expect(report.safeToResume).toBe(false);
    expect(report.detail).not.toBeNull();
  });

  it("reports INDETERMINATE when the ledger fails its own integrity check", async () => {
    const { invocation } = open("rec-integrity", "20202020-2020-4202-8202-202020202027");
    const brokenLedger: LedgerLike = {
      status: () => ({ headSequence: 3, headEventSha256: "d".repeat(64), eventCount: 3 }),
      verifyIntegrity: () => ({ ok: false, problems: ["hash chain"] }),
      getEventBySequence: () => null,
    };
    const report = await reconcile({
      ledger: brokenLedger,
      invocation,
      readCache: () => Promise.resolve(null),
    });
    // Integrity is checked before the cache: an untrustworthy ledger makes every
    // comparison untrustworthy, and an unanswered question is not a negative one.
    expect(report.verdict).toBe("INDETERMINATE");
    expect(report.safeToResume).toBe(false);
  });

  it("never puts a path, a payload or a home directory in a discrepancy", async () => {
    const { ledger, invocation, beat } = open("rec-redacted", "20202020-2020-4202-8202-202020202028");
    appendPlanStep(beat(invocation), LIFECYCLE_PLAN[0]!);
    const report = await reconcile({
      ledger,
      invocation,
      readCache: () =>
        Promise.resolve({ lastAppliedSequence: 99, lastAppliedEventSha256: "b".repeat(64) }),
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain(".acp-local");
    expect(serialized).not.toContain("sqlite");
    expect(findCredentialViolations(report)).toHaveLength(0);
  });
});

describe("the reconciliation contract is load-bearing", () => {
  it("refuses a report whose safeToResume disagrees with its verdict", () => {
    const base = {
      contractVersion: CONTRACT_VERSION,
      reportId: "30303030-3030-4303-8303-303030303031",
      mode: RESTATE_MODE,
      observedAt: "2026-08-27T12:00:00.000Z",
      ledgerHeadSequence: 1,
      ledgerHeadSha256: "e".repeat(64),
      resolvedByLedger: true,
      discrepancies: [],
      detail: "classified",
    };
    // A halting verdict that claims it is safe to resume must not parse.
    expect(
      ReconciliationReport.safeParse({ ...base, verdict: "DRIVER_AHEAD", safeToResume: true })
        .success,
    ).toBe(false);
    expect(
      ReconciliationReport.safeParse({
        ...base,
        verdict: "CONSISTENT",
        safeToResume: false,
        detail: null,
      }).success,
    ).toBe(false);
  });
});

describe("the restate driver", () => {
  it("holds exactly one authorised cache key", () => {
    expect(RESTATE_STATE_KEY_CACHE).toBe("acpCache");
  });

  it("reports UNAVAILABLE with a reason when no server is reachable", async () => {
    const { ledger, invocation, beat } = open("drv-unavailable", "20202020-2020-4202-8202-202020202029");
    const status = await driverFor(ledger, invocation, beat).status();
    expect(status.mode).toBe("RESTATE");
    expect(status.health).toBe("UNAVAILABLE");
    // The contract forces both of these for an unavailable driver.
    expect(status.activeSince).toBeNull();
    expect(status.detail).not.toBeNull();
    expect(status.dataRoot).toBe(".acp-local/drills");
  });

  it("reports INDETERMINATE and refuses to resume with no cache reader", async () => {
    const { ledger, invocation, beat } = open("drv-noreader", "20202020-2020-4202-8202-20202020202a");
    const report = await driverFor(ledger, invocation, beat).reconcile();
    // No reader means no cache, which is DRIVER_BEHIND, not a failure: the
    // ledger is replayed from its own head.
    expect(report.verdict).toBe("DRIVER_BEHIND");
    expect(report.resolvedByLedger).toBe(true);
  });

  it("keeps the supervisor's claim-check law before any HTTP side effect", async () => {
    const { ledger, invocation, beat } = open("drv-claim", "20202020-2020-4202-8202-20202020202b");
    const driver = driverFor(ledger, invocation, beat);

    // No task: the claim cannot be true, and nothing is submitted.
    await expect(driver.advance(invocation, "DISCOVERED")).rejects.toBeInstanceOf(SupervisorError);

    appendPlanStep(beat(invocation), LIFECYCLE_PLAN[0]!);
    // Wrong claim: refused before anything leaves the process.
    await expect(driver.advance(invocation, "RUNNING")).rejects.toBeInstanceOf(SupervisorError);
    // Even a truthful claim does not advance here: the object handler owns the
    // walk, and this frozen one-step method must not become a second path.
    await expect(driver.advance(invocation, "DISCOVERED")).rejects.toBeInstanceOf(SupervisorError);
    expect(ledger.status().eventCount).toBe(1);
  });

  it("refuses to resume under a changed invocation", async () => {
    const { ledger, invocation, beat } = open("drv-continuity", "20202020-2020-4202-8202-20202020202c");
    appendPlanStep(beat(invocation), LIFECYCLE_PLAN[0]!);
    const driver = driverFor(ledger, invocation, beat);
    const foreign = { ...invocation, submissionDigest: "b".repeat(64) };
    await expect(driver.advance(foreign, "DISCOVERED")).rejects.toBeInstanceOf(SupervisorError);
  });

  it("opens no socket and spawns no process on import", async () => {
    const module = await import("../../../src/drivers/restate-driver/index.js");
    expect(typeof module.RestateDriver).toBe("function");
    expect(typeof module.createAcpTaskObject).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// C1: the HANDLER refuses, before anything happens
// ---------------------------------------------------------------------------

/** A context that records everything and journals nothing durably. */
function fakeContext(cache: RestateCacheState | null): {
  ctx: AdvanceContext;
  runs: string[];
  sets: RestateCacheState[];
} {
  const runs: string[] = [];
  const sets: RestateCacheState[] = [];
  return {
    runs,
    sets,
    ctx: {
      get: () => Promise.resolve(cache),
      set: (_name, value) => {
        sets.push(value);
      },
      run: <T,>(name: string, action: () => T) => {
        runs.push(name);
        return Promise.resolve(action());
      },
    },
  };
}

describe("the advance handler refuses before it touches anything", () => {
  const NON_RESUMABLE: readonly [string, RestateCacheState][] = [
    // Ahead of the log that produced it: the authority violation.
    ["DRIVER_AHEAD", { lastAppliedSequence: 99, lastAppliedEventSha256: "b".repeat(64) }],
    // Disagreeing at a position the ledger has: divergence.
    ["DIVERGED", { lastAppliedSequence: 1, lastAppliedEventSha256: "c".repeat(64) }],
  ];

  for (const [label, injected] of NON_RESUMABLE) {
    it("rejects an injected " + label + " cache with zero delta", async () => {
      // The scenario grammar admits no underscore, and rightly so.
      const { ledger, root, invocation, beat } = open(
        "handler-" + label.toLowerCase().replace(/_/g, "-"),
        "40404040-4040-4404-8404-40404040404" + (label === "DRIVER_AHEAD" ? "1" : "2"),
      );
      // Two events, so DIVERGED has a position to disagree about.
      appendPlanStep(beat(invocation), LIFECYCLE_PLAN[0]!);
      appendPlanStep(beat(invocation), LIFECYCLE_PLAN[1]!);

      const before = ledger.status();
      const beats: string[] = [];
      const { ctx, runs, sets } = fakeContext(injected);

      await expect(
        advanceHandler(
          { beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger, __onBeat: (point) => beats.push(point) },
          ctx,
          invocation,
        ),
      ).rejects.toThrow();

      // Nothing ran, nothing was written, nothing was cached, no beat fired.
      expect(runs).toEqual([]);
      expect(sets).toEqual([]);
      expect(beats).toEqual([]);
      expect(ledger.status().eventCount).toBe(before.eventCount);
      expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
      // Derived from the plan, not a hand-spelled string: a guessed key that
      // stopped matching would make this assertion pass for the wrong reason.
      expect(ledger.getEventByIdempotencyKey(outcomeKey(invocation))).toBeNull();
      expect(existsSync(join(root, "effects"))).toBe(false);
    });
  }

  /**
   * N3, the Restate side. The object composes the attribution the same way it
   * composes the plan, so the same guard protects it: a handler whose
   * dependencies name a different initiative rebuilds a different step 0 and
   * refuses. `RestateDriver.advance` cannot show this — it throws
   * unconditionally after the guard, so a passing test there would prove
   * nothing about which throw fired — but the handler is where the object
   * actually runs, and it can.
   */
  it("refuses a handler whose dependencies name a different initiativeId", async () => {
    const { ledger, root, invocation, beat } = open(
      "handler-other-initiative",
      "40404040-4040-4404-8404-404040404044",
    );
    appendPlanStep(beat(invocation), LIFECYCLE_PLAN[0]!);

    const before = ledger.status();
    const beats: string[] = [];
    const { ctx, runs, sets } = fakeContext(null);

    await expect(
      advanceHandler(
        {
          beat,
          commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
          initiativeId: "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b01",
          ledger,
          __onBeat: (point) => beats.push(point),
        },
        ctx,
        invocation,
      ),
    ).rejects.toThrow();

    // Refused before anything happened: no journalled run, no cache write, no
    // beat, no event, no effect directory.
    expect(runs).toEqual([]);
    expect(sets).toEqual([]);
    expect(beats).toEqual([]);
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
    expect(existsSync(join(root, "effects"))).toBe(false);
  });

  it("proceeds and caches only when the verdict is resumable", async () => {
    const { ledger, invocation, beat } = open(
      "handler-resumable",
      "40404040-4040-4404-8404-404040404043",
    );
    const beats: string[] = [];
    const { ctx, runs, sets } = fakeContext(null);

    const result = await advanceHandler(
      { beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger, __onBeat: (point) => beats.push(point) },
      ctx,
      invocation,
    );

    expect(result.finalSequence).toBe(LIFECYCLE_PLAN.length);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("CHECKPOINTED");
    // One journalled call per plan step, plus the effect and the outcome.
    expect(runs.length).toBe(LIFECYCLE_PLAN.length + 1);
    expect(runs.some((name) => name.startsWith("effect/"))).toBe(true);
    expect(runs.some((name) => name.startsWith("outcome/"))).toBe(true);
    expect(beats).toContain("AFTER_EFFECT");
    expect(beats).toContain("AFTER_OUTCOME");
    // The cache is written once, after the work, from the ledger's own numbers.
    expect(sets).toHaveLength(1);
    expect(sets[0]?.lastAppliedEventSha256).toBe(ledger.status().headEventSha256);
    // The writer trail is unchanged: every step of the writer plan, in order.
    const trail = ledger.listEvents({ limit: 200 }).events.map((record) => record.event.type);
    expect(trail).toEqual(LIFECYCLE_PLAN.map((step) => step.eventType));
  });

  // P7P: the same object, walking the read-only plan, because its packet says
  // so. Nothing else about the handler changes.
  it("walks the read-only plan for a NO_COMMIT packet", async () => {
    const { ledger, invocation, beat } = open(
      "handler-read-only",
      "40404040-4040-4404-8404-404040404044",
    );
    const beats: string[] = [];
    const { ctx, runs, sets } = fakeContext(null);

    const result = await advanceHandler(
      { beat, commitPolicy: "NO_COMMIT", initiativeId: TEST_INITIATIVE_ID, ledger, __onBeat: (point) => beats.push(point) },
      ctx,
      invocation,
    );

    expect(result.finalSequence).toBe(READ_ONLY_PLAN.length);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("CHECKPOINTED");
    expect(runs.length).toBe(READ_ONLY_PLAN.length + 1);
    expect(sets).toHaveLength(1);
    // The three-beat law is untouched: the intent still has its effect and its
    // evidence-bearing outcome.
    expect(beats).toContain("AFTER_EFFECT");
    expect(beats).toContain("AFTER_OUTCOME");

    const trail = ledger.listEvents({ limit: 200 }).events.map((record) => record.event.type);
    expect(trail.slice(-2)).toEqual(["AUDIT_COMPLETED", "CHECKPOINT_WRITTEN"]);
    expect(trail.filter((type) => type.startsWith("COMMIT_"))).toEqual([]);
    expect(trail).not.toContain("TASK_STATE_CHANGED");
    expect(trail).toHaveLength(READ_ONLY_PLAN.length);
  });
});

// ---------------------------------------------------------------------------
// C2: only an explicit null means absent
// ---------------------------------------------------------------------------

describe("cache replies", () => {
  it("treats exactly one reply as absence", () => {
    expect(parseCacheReply("null")).toBeNull();
    expect(parseCacheReply("  null  ")).toBeNull();
  });

  it("accepts a well-formed cache", () => {
    const digest = "a".repeat(64);
    expect(
      parseCacheReply(JSON.stringify({ lastAppliedSequence: 7, lastAppliedEventSha256: digest })),
    ).toEqual({ lastAppliedSequence: 7, lastAppliedEventSha256: digest });
  });

  it("throws on anything malformed, so reconcile says INDETERMINATE", () => {
    // Coercing these to null would turn "I cannot tell what the driver believes"
    // into "the driver believes nothing", which resumes instead of halting.
    const malformed = [
      "",
      "not json",
      "[]",
      "42",
      '"a string"',
      "{}",
      JSON.stringify({ lastAppliedSequence: 7 }),
      JSON.stringify({ lastAppliedEventSha256: "a".repeat(64) }),
      JSON.stringify({ lastAppliedSequence: "7", lastAppliedEventSha256: "a".repeat(64) }),
      JSON.stringify({ lastAppliedSequence: 1.5, lastAppliedEventSha256: "a".repeat(64) }),
      JSON.stringify({ lastAppliedSequence: -1, lastAppliedEventSha256: "a".repeat(64) }),
      JSON.stringify({ lastAppliedSequence: 7, lastAppliedEventSha256: "TOO-SHORT" }),
      JSON.stringify({ lastAppliedSequence: 7, lastAppliedEventSha256: "A".repeat(64) }),
    ];
    for (const body of malformed) {
      expect(() => parseCacheReply(body)).toThrow();
    }
  });

  it("makes a malformed reply INDETERMINATE, never resumable", async () => {
    const { ledger, invocation } = open(
      "cache-malformed",
      "40404040-4040-4404-8404-404040404044",
    );
    const report = await reconcile({
      ledger,
      invocation,
      readCache: () => Promise.resolve(parseCacheReply("{}")),
    });
    expect(report.verdict).toBe("INDETERMINATE");
    expect(report.safeToResume).toBe(false);
  });
});
/** The outcome's real idempotency key, derived, never spelled out by hand. */
function outcomeKey(invocation: DurableInvocation): string {
  return deriveEventCoordinate(invocation, OUTCOME_STEP.transitionId, OUTCOME_STEP.index)
    .idempotencyKey;
}


// ---------------------------------------------------------------------------
// Port conformance (P8-T G5)
// ---------------------------------------------------------------------------

/**
 * The conformance class the split exists to make possible.
 *
 * `OrchestrationDriver` is declared in `@acp/runtime` and implemented here, so
 * until G5 there was no package boundary for a conformance test to sit on: a
 * test living beside the interface it checks proves only that TypeScript
 * agrees with itself. This describe runs inside `edges/durability`, imports the
 * port across the package boundary, and asserts that the edge satisfies it.
 *
 * The predicate is written against the port as *data* rather than as a set of
 * remembered assertions, so the same function judges the real driver and a
 * deliberately broken stub. That symmetry is the point: a conformance check
 * only means something if a non-conforming value fails it, so the negative
 * control below is as load-bearing as the positive one.
 */
const PORT_METHODS = [
  "status",
  "reconcile",
  "advance",
  // V2-B2-1: declaring and the four verbs are port members like any other.
  "capabilities",
  "cancel",
  "reattach",
  "signal",
  "timer",
] as const;

/** Every way a candidate fails `OrchestrationDriver`, named. Empty is conformance. */
function portViolations(candidate: object): readonly string[] {
  const problems: string[] = [];
  const record = candidate as Record<string, unknown>;
  const mode = record["mode"];
  if (typeof mode !== "string" || mode.length === 0) {
    problems.push("mode must be a non-empty DriverMode");
  }
  for (const method of PORT_METHODS) {
    if (typeof record[method] !== "function") {
      problems.push(method + "() must be a method");
    }
  }
  const advance = record["advance"];
  if (typeof advance === "function" && advance.length !== 2) {
    problems.push("advance() must take (invocation, from)");
  }
  // V2-B2-5 widened `timer` to carry its duration. A timer without one is not
  // a timer, and a driver whose method dropped the parameter would silently
  // schedule whatever it felt like -- so the arity is part of the port.
  const timer = record["timer"];
  if (typeof timer === "function" && timer.length !== 2) {
    problems.push("timer() must take (invocation, delayMs)");
  }
  return problems;
}

/** A ledger that answers the port's reads and owns nothing. */
const STUB_LEDGER: LedgerLike = {
  status: () => ({ headSequence: 0, headEventSha256: "0".repeat(64), eventCount: 0 }),
  verifyIntegrity: () => ({ ok: true, problems: [] }),
  getEventBySequence: () => null,
};

describe("the Restate edge satisfies the orchestration port (G5)", () => {
  /** A driver built from stubs only — no ledger file, no server, no network. */
  function conformingDriver(): RestateDriver {
    const invocation = invocationFor("5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a01");
    const beat = (candidate: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
      ledger: {
        append: () => {
          throw new SupervisorError("the conformance fixture never appends");
        },
        getTask: () => null,
        getEventBySequence: () => null,
        getEventByIdempotencyKey: () => null,
      } satisfies LedgerPort,
      effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
      invocation: candidate,
      emittedBy: EMITTED_BY,
      route: TEST_ROUTE,
    });
    return new RestateDriver(
      {
        ledger: STUB_LEDGER,
        invocation,
        emittedBy: EMITTED_BY,
        ingressUrl: "http://127.0.0.1:8080",
        adminUrl: "http://127.0.0.1:9070",
      },
      beat,
      "NO_COMMIT",
      TEST_INITIATIVE_ID,
    );
  }

  it("implements every member the port declares", () => {
    const driver = conformingDriver();
    // The type-level half: this assignment is the compiler asserting the class
    // against the interface across a package boundary.
    const port: OrchestrationDriver = driver;
    // The value-level half: the members actually exist on the instance, which a
    // structural type check alone does not establish for a class with private
    // fields and prototype methods.
    expect(portViolations(port)).toEqual([]);
    expect(port.mode).toBe(RESTATE_MODE);
    expect(port.mode).toBe("RESTATE");
  });

  it("rejects a stub that does not satisfy the port (the failing fixture)", () => {
    // The negative control. Without it, `portViolations` returning `[]` would be
    // consistent with a predicate that can never fail — which is the defect this
    // whole class of test is supposed to rule out.
    const missingAdvance = {
      mode: "RESTATE",
      status: () => Promise.resolve(null),
      reconcile: () => Promise.resolve(null),
    };
    // V2-B2-1 widened the port, so a stub that predates it now violates the
    // five new members too. Listed in full rather than loosened to a
    // `toContain`: the whole value of this control is that it names exactly
    // what is missing.
    const VERB_VIOLATIONS = [
      "capabilities() must be a method",
      "cancel() must be a method",
      "reattach() must be a method",
      "signal() must be a method",
      "timer() must be a method",
    ];
    expect(portViolations(missingAdvance)).toEqual(["advance() must be a method", ...VERB_VIOLATIONS]);

    const wrongArity = {
      mode: "RESTATE",
      status: () => Promise.resolve(null),
      reconcile: () => Promise.resolve(null),
      advance: (invocation: unknown) => Promise.resolve(invocation),
    };
    expect(portViolations(wrongArity)).toEqual([...VERB_VIOLATIONS, "advance() must take (invocation, from)"]);

    const noMode = {
      status: () => Promise.resolve(null),
      reconcile: () => Promise.resolve(null),
      advance: (invocation: unknown, from: unknown) => Promise.resolve([invocation, from]),
    };
    expect(portViolations(noMode)).toEqual(["mode must be a non-empty DriverMode", ...VERB_VIOLATIONS]);
  });

  it("still narrows the SDK context to exactly three members (DurableStepContext)", () => {
    // `DurableStepContext` is the repository's only type-level coupling to the
    // SDK outside the drivers, and it moved here with them. Its whole value is
    // that it is *narrower* than `Context`, so both directions are asserted at
    // compile time — a widening would break this file, not some later drill.
    const narrow = (context: Context): DurableStepContext => context;
    expect(typeof narrow).toBe("function");

    const seen: DurableStepContext = {
      run: undefined as unknown as DurableStepContext["run"],
      rand: undefined as unknown as DurableStepContext["rand"],
      date: undefined as unknown as DurableStepContext["date"],
    };
    expect(Object.keys(seen).sort()).toEqual(["date", "rand", "run"]);

    // @ts-expect-error `get` is SDK surface the narrowing deliberately withholds.
    const withheld: unknown = seen.get;
    expect(withheld).toBeUndefined();

    // V2-B2-5 deliberately did NOT widen this. The durable gate is a separate
    // service with its own narrowing, so the ADVANCE walk gained no new SDK
    // surface at all -- and in particular no suspension point. Both members a
    // reader might expect the packet to have added are asserted absent, so a
    // later widening has to break this test rather than ride along.

    // @ts-expect-error `awakeable` is what the rejected SIGNAL design needed.
    const noAwakeable: unknown = seen.awakeable;
    expect(noAwakeable).toBeUndefined();

    // @ts-expect-error `sleep` is what a timer inside the walk would have needed.
    const noSleep: unknown = seen.sleep;
    expect(noSleep).toBeUndefined();

    // @ts-expect-error `promise` belongs to the gate's narrowing, not this one.
    const noPromise: unknown = seen.promise;
    expect(noPromise).toBeUndefined();
  });

  it("gives the durable gate its own narrowing, carrying only `promise`", () => {
    // The gate is not the walk, so it does not inherit the walk's context. Its
    // run side is `Pick<WorkflowContext,"promise">` and its release side the
    // shared twin -- one member each, which is the whole surface the gate is
    // allowed to reach.
    const narrowRun = (context: WorkflowContext): GateRunContext => context;
    const narrowResolve = (context: WorkflowSharedContext): GateResolveContext => context;
    expect(typeof narrowRun).toBe("function");
    expect(typeof narrowResolve).toBe("function");

    const seenRun: GateRunContext = {
      promise: undefined as unknown as GateRunContext["promise"],
    };
    expect(Object.keys(seenRun).sort()).toEqual(["promise"]);

    // @ts-expect-error `run` is the walk's, and the gate journals no step.
    const noRun: unknown = seenRun.run;
    expect(noRun).toBeUndefined();

    // @ts-expect-error the gate holds no state; `set` would be a second authority.
    const noSet: unknown = seenRun.set;
    expect(noSet).toBeUndefined();
  });
});

/**
 * The subject for the capability tests, and why it needs a real ledger now.
 *
 * Two of the four verbs reach nothing at all, which is the point for them.
 * `reattach` stopped being one at V2-B2-4a and `cancel` stops being one here:
 * both make real HTTP calls, and the tests below answer those with a stub
 * rather than a server.
 *
 * `cancel` additionally READS AND WRITES the ledger, so a stub ledger that
 * throws on append could not host it — and substituting one that accepted
 * everything would have hidden the properties worth measuring, since the whole
 * design is about which appends do and do not happen. So the subject is seeded
 * on a real ledger into the one state a cancellation is interesting from:
 * `RUNNING`, with the INTENT appended and no OUTCOME. What a unit suite can
 * prove is the SHAPE — the address it derives, the ORDER of its acts, and what
 * the log grew by. That the shape describes the real engine is the drills'
 * job, and they do it against the pinned server.
 */
const INVOCATION_FOR_CAPABILITIES = invocationFor("5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a02");

interface CapabilitySubject {
  readonly driver: RestateDriver;
  readonly ledger: Ledger;
}

function capabilitySubject(
  name: string,
  options: {
    readonly probe?: () => Promise<PostconditionVerdict>;
    readonly walk?: "OPEN_INTENT" | "CHECKPOINTED";
  } = {},
): CapabilitySubject {
  const root = scenario("capability-" + name);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const probe = options.probe ?? ((): Promise<PostconditionVerdict> => Promise.resolve("NOT_DONE"));

  const beat = (candidate: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
    ledger,
    effects: {
      apply: () => {
        throw new SupervisorError("the capability fixture never performs an effect");
      },
      probe,
    },
    invocation: candidate,
    emittedBy: EMITTED_BY,
    route: TEST_ROUTE,
  });

  // Seeded by appending plan steps directly rather than by walking with a
  // probe: the seed must be the same every run whatever the subject's probe
  // is scripted to answer, or a fixture would be measuring itself.
  const context: BeatContext = {
    ...beat(INVOCATION_FOR_CAPABILITIES),
    plan: LIFECYCLE_PLAN,
    initiativeId: TEST_INITIATIVE_ID,
  };
  for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
    if (step.beat === "OUTCOME") continue;
    appendPlanStep(context, step);
  }
  if (options.walk === "CHECKPOINTED") {
    appendPlanStep(context, OUTCOME_STEP);
    for (const step of LIFECYCLE_PLAN.slice(OUTCOME_STEP.index + 1)) appendPlanStep(context, step);
  }

  return {
    ledger,
    driver: new RestateDriver(
      {
        ledger,
        invocation: INVOCATION_FOR_CAPABILITIES,
        emittedBy: EMITTED_BY,
        ingressUrl: "http://127.0.0.1:8080",
        adminUrl: "http://127.0.0.1:9070",
      },
      beat,
      "LOCAL_COMMIT_WITH_RECEIPT",
      TEST_INITIATIVE_ID,
    ),
  };
}

/** One call the driver made to the engine, recorded whole. */
interface EngineCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
  /** What the ledger held at the moment the call was made (V2-B2-4b). */
  readonly eventCount: number;
}

/**
 * Answer the engine without a server, and record what was asked, when.
 *
 * The `eventCount` on each recorded call is what makes the ORDER measurable
 * without a clock: if the engine call is made while the ledger still holds
 * exactly what it held before `cancel` was invoked, then nothing was appended
 * first. An assertion on the final state could not tell that apart from a
 * settlement that ran before the engine was stopped.
 */
async function withEngineAnswering<T>(
  script: {
    readonly lookup: { readonly status: number; readonly body: string };
    readonly cancel: { readonly status: number; readonly body: string };
  },
  ledger: Ledger,
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly asked: readonly EngineCall[] }> {
  const original = globalThis.fetch;
  const asked: EngineCall[] = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.toString() : String(input);
    asked.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : null,
      eventCount: ledger.status().eventCount,
    });
    const reply = url.includes("/restate/lookup") ? script.lookup : script.cancel;
    return Promise.resolve(new Response(reply.body, { status: reply.status }));
  }) as typeof globalThis.fetch;
  try {
    return { result: await run(), asked };
  } finally {
    globalThis.fetch = original;
  }
}

/** A real Restate invocation id, so a leak of one would be recognisable. */
const ENGINE_INVOCATION_ID = "inv_1iyF5Za7tVoR5BFUOkvBqWRDZJOjlBRbJo";

/** The engine taking a cancellation: the id resolves, the cancel is accepted. */
const ENGINE_CANCELS = {
  lookup: { status: 200, body: JSON.stringify({ invocationId: ENGINE_INVOCATION_ID }) },
  cancel: { status: 202, body: "" },
};

/**
 * Answer one attach without a server, and record the address it was made to.
 *
 * `globalThis.fetch` is swapped and restored around the call, the shape the
 * daemon's own lifecycle suite already uses. The recording is half the value:
 * a stub that only returned a body would prove the driver parses a reply, not
 * that it asks at the address the derived key names.
 */
async function withAttachAnswering<T>(
  reply: { readonly status: number; readonly body: string },
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly asked: readonly string[] }> {
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = ((input: unknown): Promise<Response> => {
    asked.push(input instanceof URL ? input.toString() : String(input));
    return Promise.resolve(new Response(reply.body, { status: reply.status }));
  }) as typeof globalThis.fetch;
  try {
    return { result: await run(), asked };
  } finally {
    globalThis.fetch = original;
  }
}

/** One request the driver made, recorded whole (V2-B2-5). */
interface IngressCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
  readonly idempotencyKey: string | null;
}

/**
 * Answer ingress without a server, and record exactly what was asked.
 *
 * `timer` and `signal` are each ONE derived request, so a stubbed `fetch` can
 * prove everything a unit suite should prove about them: the address, the
 * headers, the body and — the part that matters most for the negatives — that
 * some calls are never made at all. That the shape describes the real engine is
 * the drills' job, against the pinned server.
 */
async function withIngressAnswering<T>(
  reply: { readonly status: number; readonly body: string },
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly asked: readonly IngressCall[] }> {
  const original = globalThis.fetch;
  const asked: IngressCall[] = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? {});
    asked.push({
      method: init?.method ?? "GET",
      url: input instanceof URL ? input.toString() : String(input),
      body: typeof init?.body === "string" ? init.body : null,
      idempotencyKey: headers.get("idempotency-key"),
    });
    return Promise.resolve(new Response(reply.body, { status: reply.status }));
  }) as typeof globalThis.fetch;
  try {
    return { result: await run(), asked };
  } finally {
    globalThis.fetch = original;
  }
}

/** What the engine says to an accepted delayed send, id and all. */
const ENGINE_SCHEDULES = {
  status: 202,
  body: JSON.stringify({
    invocationId: "inv_1abcdefghijklmnopqrstuvwxyz012345",
    executionTime: "2026-09-03T12:00:03.000Z",
    status: "Accepted",
  }),
};

/** What the gate says to an accepted release. */
const GATE_RESOLVES = { status: 200, body: JSON.stringify({ resolved: true }) };

/**
 * The capability declaration, and the law that stops it being decorative
 * (V2-B2-1).
 *
 * The stub cases are the ones that discriminate. A declaration checked only
 * against a driver that already agrees with it proves nothing: it would pass
 * just as happily if the law compared nothing at all. So both mismatch
 * directions are built deliberately and asserted to be caught.
 *
 * V2-B2-4a flipped `REATTACH` and V2-B2-4b flips `CANCEL`, and the law is what
 * made each flip cost something: a declaration saying `SUPPORTED` while the
 * method still returned `unsupported(...)` is caught here, in the same suite
 * the fence pins alongside. Capability truth lives in two places on purpose,
 * and both moved for both flips.
 *
 * The lying-declaration cases moved from `CANCEL` to `SIGNAL` in the same
 * change, and that is not cosmetic: a negative control built on a verb that
 * has since become real would have been asserting the old world and passing
 * for the wrong reason.
 */
describe("the driver declares what it cannot do, and the declaration is checked", () => {
  /** A reattach that answers, so the observed set is complete without a server. */
  const ATTACHED = { status: 200, body: JSON.stringify({ finalSequence: 7 }) };

  const OUTCOMES = async (subject: CapabilitySubject) => {
    const driver: OrchestrationDriver = subject.driver;
    return {
      CANCEL: (
        await withEngineAnswering(ENGINE_CANCELS, subject.ledger, () =>
          driver.cancel(INVOCATION_FOR_CAPABILITIES),
        )
      ).result,
      REATTACH: (
        await withAttachAnswering(ATTACHED, () => driver.reattach(INVOCATION_FOR_CAPABILITIES))
      ).result,
      SIGNAL: (
        await withIngressAnswering(GATE_RESOLVES, () =>
          driver.signal(INVOCATION_FOR_CAPABILITIES),
        )
      ).result,
      TIMER: (
        await withIngressAnswering(ENGINE_SCHEDULES, () =>
          driver.timer(INVOCATION_FOR_CAPABILITIES, 1_000),
        )
      ).result,
    };
  };

  it("declares all four verbs SUPPORTED, satisfying the contract", () => {
    // V2-B2-5 flips the last two, so this driver is capability complete. Each
    // entry moved in the packet that drilled it and in no other; the fence
    // pins the same four literals, so a flip cannot land in one place alone.
    const declared = capabilitySubject("declaration").driver.capabilities();
    expect(DriverCapabilities.safeParse(declared).success).toBe(true);
    expect(declared.verbs).toEqual({
      CANCEL: "SUPPORTED",
      REATTACH: "SUPPORTED",
      SIGNAL: "SUPPORTED",
      TIMER: "SUPPORTED",
    });
    // `SERIALIZED_PER_TASK` moved to SUPPORTED in V2-B2-3, and only because
    // that packet drilled it: one invocation held at a beat while a second is
    // submitted, counting DISTINCT held tasks — one for the same key, two for
    // different keys. B2-1 pinned this truth here and in the fence so a
    // capability could not move in one place alone; both moved together.
    expect(declared.properties).toEqual({ SERIALIZED_PER_TASK: "SUPPORTED" });
    expect(declared.mode).toBe(RESTATE_MODE);
  });

  it("no verb refuses any more, and each accepted answer is the shape its contract allows", async () => {
    // The mirror of what this test used to assert. Until V2-B2-5 two verbs
    // returned `CAPABILITY_UNSUPPORTED`; none does now, and the driver source
    // no longer even has an `unsupported()` helper to build one with.
    const observed = await OUTCOMES(capabilitySubject("supported-verbs"));
    for (const verb of ["CANCEL", "REATTACH", "SIGNAL", "TIMER"] as const) {
      expect({ verb, ok: observed[verb].ok }).toEqual({ verb, ok: true });
    }

    // SIGNAL and TIMER observe no ledger position, so each answers the bare
    // `{ ok: true }` the contract sanctions rather than inventing a coordinate.
    // CANCEL and REATTACH do observe one, and carry it.
    expect(observed.SIGNAL).toEqual({ ok: true });
    expect(observed.TIMER).toEqual({ ok: true });
  });

  it("satisfies the correspondence law on the real driver", async () => {
    const subject = capabilitySubject("correspondence");
    expect(
      driverCapabilityMismatches(subject.driver.capabilities(), await OUTCOMES(subject)),
    ).toEqual([]);
  });

  it("catches a declaration that claims SUPPORTED while the verb refuses", async () => {
    // With no verb refusing any more, the refusal has to be supplied by a stub
    // for this direction to be exercised at all. That is the point of the test
    // rather than a weakening of it: the law must still CATCH a driver that
    // declared a capability and then refused it, and a suite that could only
    // check directions its subject happens to exhibit would stop being a law.
    const subject = capabilitySubject("claims-supported");
    const observed = {
      ...(await OUTCOMES(subject)),
      SIGNAL: { ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "signal" } as const,
    };
    expect(driverCapabilityMismatches(subject.driver.capabilities(), observed)).toEqual([
      "SIGNAL: declared SUPPORTED but refused",
    ]);
  });

  it("catches a declaration that claims UNSUPPORTED while the verb does not refuse", async () => {
    // The mirror, and the direction that would otherwise let a driver do work
    // it told its caller it could not do. After V2-B2-5 the lie lives in the
    // DECLARATION rather than in the observation: TIMER really does answer.
    const subject = capabilitySubject("claims-unsupported");
    const declared = subject.driver.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, TIMER: "UNSUPPORTED" as const } };
    expect(driverCapabilityMismatches(lying, await OUTCOMES(subject))).toEqual([
      "TIMER: declared UNSUPPORTED but did not refuse",
    ]);
  });

  it("catches a declaration that claims SIGNAL UNSUPPORTED while it releases the gate", async () => {
    // The direction the V2-B2-5 flip created for the other new verb. Without
    // it the flip could be reverted in the declaration alone and the driver
    // would go on signalling while telling its caller it cannot.
    const subject = capabilitySubject("signal-lie");
    const declared = subject.driver.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, SIGNAL: "UNSUPPORTED" as const } };
    expect(driverCapabilityMismatches(lying, await OUTCOMES(subject))).toEqual([
      "SIGNAL: declared UNSUPPORTED but did not refuse",
    ]);
  });

  it("restores: with the law's comparison removed, the same mismatching stub passes", async () => {
    // The restore half, in the only honest form available to a pure function:
    // a comparison that does not compare returns no mismatches, which is
    // exactly the pre-law state the packet exists to leave behind.
    const subject = capabilitySubject("restore");
    const declared = subject.driver.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, TIMER: "UNSUPPORTED" as const } };
    const withoutLaw = (): readonly string[] => [];
    expect(withoutLaw()).toEqual([]);
    // And with the law back, the same input is caught -- so the assertion above
    // is describing an absence of checking, not an absence of a defect.
    expect(driverCapabilityMismatches(lying, await OUTCOMES(subject)).length).toBe(1);
  });

  it("catches a declaration that claims REATTACH UNSUPPORTED while it answers", async () => {
    // The direction the V2-B2-4a flip created, and the one that would let a
    // driver do work it told its caller it could not do.
    const subject = capabilitySubject("reattach-lie");
    const declared = subject.driver.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, REATTACH: "UNSUPPORTED" as const } };
    expect(driverCapabilityMismatches(lying, await OUTCOMES(subject))).toEqual([
      "REATTACH: declared UNSUPPORTED but did not refuse",
    ]);
  });

  it("catches a declaration that claims CANCEL UNSUPPORTED while it cancels", async () => {
    // The direction the V2-B2-4b flip created. Without this the flip could be
    // reverted in the declaration alone and the driver would go on cancelling
    // while telling its caller it cannot.
    const subject = capabilitySubject("cancel-lie");
    const declared = subject.driver.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, CANCEL: "UNSUPPORTED" as const } };
    expect(driverCapabilityMismatches(lying, await OUTCOMES(subject))).toEqual([
      "CANCEL: declared UNSUPPORTED but did not refuse",
    ]);
  });

  it("reattaches at the address derived before ingress, and answers with a ledger coordinate", async () => {
    const subject = capabilitySubject("reattach-address");
    const { result, asked } = await withAttachAnswering(ATTACHED, () =>
      subject.driver.reattach(INVOCATION_FOR_CAPABILITIES),
    );

    // The whole answer, field by field: an acceptance carrying the head the
    // walk reached, and nothing the engine minted.
    expect(result).toEqual({ ok: true, finalSequence: 7 });

    // The address, exactly. `:invocation_target` for a Virtual Object handler
    // is its three segments, and the last segment is the idempotency key —
    // which is `deriveInvocation`'s output, not anything Restate assigned.
    expect(asked).toEqual([
      "http://127.0.0.1:8080/restate/invocation/AcpTask/" +
        INVOCATION_FOR_CAPABILITIES.taskId +
        "/advance/" +
        INVOCATION_FOR_CAPABILITIES.invocationId +
        "/attach",
    ]);
  });

  it("refuses INVOCATION_NOT_FOUND on a 404 rather than throwing (V2 L4)", async () => {
    // Until L4 this threw, so an engine that had been REACHED and had answered
    // plainly arrived at both doors as an unreachable engine — a retry hint
    // that could never come true. A 404 here is an answer about the work, and
    // the refusal says exactly what the engine said and nothing about why.
    const subject = capabilitySubject("attach-not-found");
    const { result } = await withAttachAnswering(
      { status: 404, body: '{"code":404,"message":"not found"}' },
      () => subject.driver.reattach(INVOCATION_FOR_CAPABILITIES),
    );
    expect(result).toEqual({ ok: false, refusal: "INVOCATION_NOT_FOUND", at: "reattach" });
  });

  it("N3 keeps every other non-ok attach status a throw, 409 included", async () => {
    // Q3's boundary, asserted rather than assumed. 409 is excluded on evidence:
    // nothing in this repository has ever produced one on the attach path, and
    // inferring its meaning from the admin cancel's 409 would be inference, not
    // measurement. If a drill ever produces one, that is new semantics and a
    // new adjudication — not a local widening here.
    const subject = capabilitySubject("attach-other-statuses");
    for (const status of [409, 403, 400, 401, 500, 502, 503]) {
      await expect(
        withAttachAnswering({ status, body: '{"message":"nope"}' }, () =>
          subject.driver.reattach(INVOCATION_FOR_CAPABILITIES),
        ),
      ).rejects.toBeInstanceOf(SupervisorError);
    }
  });

  it("N2 treats a 5xx as unreachable rather than not-found", async () => {
    // The mirror of the bug L4 fixes: turning a channel failure into a refusal
    // would tell a caller the engine answered about the work when it did not.
    const subject = capabilitySubject("attach-server-error");
    const outcome = await withAttachAnswering({ status: 500, body: "{}" }, () =>
      subject.driver
        .reattach(INVOCATION_FOR_CAPABILITIES)
        .then((value) => value)
        .catch((e: unknown) => e),
    );
    expect(outcome.result).toBeInstanceOf(SupervisorError);
    expect(outcome.result).not.toEqual(
      expect.objectContaining({ refusal: "INVOCATION_NOT_FOUND" }),
    );
  });

  it("carries the status and never the engine's own text into the error", async () => {
    // The refusal body from a real server names an engine invocation id. The
    // driver reports the status it saw and stops there. Asserted on a status
    // that still throws, since 404 is now an answer rather than a failure.
    const subject = capabilitySubject("attach-error-text");
    const failure = await withAttachAnswering(
      { status: 500, body: '{"message":"boom","id":"inv_12G2mtFCEW7b0uysHSZtM8sQ9pD8TndCov"}' },
      () =>
        subject.driver
          .reattach(INVOCATION_FOR_CAPABILITIES)
          .then(() => null)
          .catch((e: unknown) => e),
    );
    const error = failure.result;
    expect(error).toBeInstanceOf(SupervisorError);
    expect((error as Error).message).toContain("500");
    expect((error as Error).message).not.toContain("inv_");
  });

  it("N6 puts no status number in the refusal it returns", async () => {
    // Branched on and discarded. The refusal name is the whole answer: no door
    // prints the number, no ledger row carries it, nothing names it.
    const subject = capabilitySubject("attach-no-status-leak");
    const { result } = await withAttachAnswering(
      { status: 404, body: '{"code":404,"message":"not found","id":"inv_abc"}' },
      () => subject.driver.reattach(INVOCATION_FOR_CAPABILITIES),
    );
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain("404");
    expect(rendered).not.toContain("inv_");
    expect(Object.keys(result as object).sort()).toEqual(["at", "ok", "refusal"]);
  });

  it("refuses to guess a sequence from a reply that is not a handler result", async () => {
    // The same discipline `parseCacheReply` holds: an unanswered question is
    // not a zero. Coercing here would report that a reattached invocation had
    // reached the start of the ledger.
    const subject = capabilitySubject("attach-malformed");
    for (const body of ["not json", "null", "[]", '{"finalSequence":"11"}', '{"finalSequence":-1}', "{}"]) {
      await expect(
        withAttachAnswering({ status: 200, body }, () =>
          subject.driver.reattach(INVOCATION_FOR_CAPABILITIES),
        ),
      ).rejects.toBeInstanceOf(SupervisorError);
    }
  });

  it("reports a verb whose outcome was never observed rather than passing it", async () => {
    const subject = capabilitySubject("unobserved");
    const partial = await OUTCOMES(subject);
    const withoutSignal: Record<string, DriverOutcome> = { ...partial };
    delete withoutSignal["SIGNAL"];
    // The declared state travels into the message, and as of V2-B2-5 that is
    // SUPPORTED. An unobserved verb is reported either way: a law that only
    // noticed missing evidence for the verbs it expected to refuse would go
    // quiet exactly when a driver stopped answering for a capability it claims.
    expect(driverCapabilityMismatches(subject.driver.capabilities(), withoutSignal)).toEqual([
      "SIGNAL: declared SUPPORTED but no outcome was observed",
    ]);
  });
});

/**
 * Cancellation, act by act (V2-B2-4b).
 *
 * The whole design is an ORDER, so every test here measures order or measures
 * what the log grew by. A test that only checked the final state would pass
 * just as happily on a driver that settled the ledger first and stopped the
 * engine afterwards, which is the one arrangement this design exists to
 * forbid.
 *
 * The engine is stubbed and the ledger is real, which puts the boundary in the
 * right place: what the driver ASKS the engine is a shape a unit test can pin
 * exactly, and what it WRITES is a fact only a real ledger can answer for.
 */
describe("cancellation stops the engine, then settles the ledger", () => {
  it("resolves the address from the derived key and never hands the engine's id back", async () => {
    const subject = capabilitySubject("cancel-address");
    const before = subject.ledger.status().eventCount;

    const { result, asked } = await withEngineAnswering(ENGINE_CANCELS, subject.ledger, () =>
      subject.driver.cancel(INVOCATION_FOR_CAPABILITIES),
    );

    // Two calls, in this order, and no third.
    expect(asked.map((call) => call.method + " " + call.url)).toEqual([
      "POST http://127.0.0.1:8080/restate/lookup",
      "PATCH http://127.0.0.1:9070/invocations/" + ENGINE_INVOCATION_ID + "/cancel",
    ]);

    // The lookup body, field by field. Every value is one this side already
    // held: the object name and handler are constants, the key is the task,
    // and the idempotency key is `deriveInvocation`'s output for
    // `(taskId, attempt)`. Nothing Restate minted is an INPUT here, which is
    // what makes the id it returns safe to use and throw away.
    expect(JSON.parse(asked[0]?.body ?? "null")).toEqual({
      target: "idempotentInvocation",
      service: "AcpTask",
      key: INVOCATION_FOR_CAPABILITIES.taskId,
      handler: "advance",
      idempotencyKey: INVOCATION_FOR_CAPABILITIES.invocationId,
    });

    // The answer is a ledger coordinate and nothing else. The engine's own id
    // was in the reply this call read and is in none of what came back.
    expect(result).toEqual({ ok: true, finalSequence: subject.ledger.status().headSequence });
    expect(JSON.stringify(result)).not.toContain("inv_");

    // And exactly one cancellation was appended.
    expect(subject.ledger.status().eventCount).toBe(before + 1);
    const events = subject.ledger.listEvents({ limit: 200 }).events;
    expect(events.filter((r) => r.event.type === "TASK_CANCELLED").length).toBe(1);
    // Nothing in the log names an engine identity either.
    expect(JSON.stringify(events.map((r) => r.event))).not.toContain("inv_");
  });

  it("stops the engine BEFORE it appends anything", async () => {
    const subject = capabilitySubject("cancel-order");
    const before = subject.ledger.status().eventCount;

    const { asked } = await withEngineAnswering(ENGINE_CANCELS, subject.ledger, () =>
      subject.driver.cancel(INVOCATION_FOR_CAPABILITIES),
    );

    // The discriminator. Both engine calls were made while the ledger still
    // held exactly what it held before `cancel` was invoked, so no append can
    // have preceded them. Asserting only the end state could not tell this
    // apart from a settlement that ran first — and a settlement that ran first
    // could be followed in the log by the still-retrying invocation's next
    // beat, leaving a cancellation with progress after it.
    expect(asked.map((call) => call.eventCount)).toEqual([before, before]);
    expect(subject.ledger.status().eventCount).toBe(before + 1);
  });

  it("refuses a terminal task without one engine call and without one append", async () => {
    const subject = capabilitySubject("cancel-terminal", { walk: "CHECKPOINTED" });
    const before = subject.ledger.status();
    expect(subject.ledger.getTask(INVOCATION_FOR_CAPABILITIES.taskId)?.currentState).toBe(
      "CHECKPOINTED",
    );

    const { result, asked } = await withEngineAnswering(ENGINE_CANCELS, subject.ledger, () =>
      subject.driver.cancel(INVOCATION_FOR_CAPABILITIES),
    );

    expect(result).toEqual({ ok: false, refusal: "TASK_TERMINAL", at: "cancel" });
    // Act 1 is before act 2, so a completed run is never interfered with.
    expect(asked).toEqual([]);
    expect(subject.ledger.status().eventCount).toBe(before.eventCount);
    expect(subject.ledger.status().headEventSha256).toBe(before.headEventSha256);
  });

  it("refuses an UNKNOWN effect with zero appends, having still stopped the engine", async () => {
    const subject = capabilitySubject("cancel-unknown", {
      probe: () => Promise.resolve("UNKNOWN"),
    });
    const before = subject.ledger.status();

    const { result, asked } = await withEngineAnswering(ENGINE_CANCELS, subject.ledger, () =>
      subject.driver.cancel(INVOCATION_FOR_CAPABILITIES),
    );

    expect(result).toEqual({ ok: false, refusal: "POSTCONDITION_UNKNOWN", at: "cancel" });
    // The engine WAS stopped: the refusal is about what may be written, not
    // about what was asked of the engine. Leaving the invocation running while
    // refusing would be the worst of both.
    expect(asked.length).toBe(2);
    expect(subject.ledger.status().eventCount).toBe(before.eventCount);
    expect(subject.ledger.status().headEventSha256).toBe(before.headEventSha256);
    // The intent is still open, which is the state an operator recovers from.
    expect(subject.ledger.getTask(INVOCATION_FOR_CAPABILITIES.taskId)?.currentState).toBe("RUNNING");
    expect(subject.ledger.getEventByIdempotencyKey(outcomeKey(INVOCATION_FOR_CAPABILITIES))).toBeNull();
  });

  it("throws rather than settling when the engine did not accept the cancellation", async () => {
    // The window this ordering exists to close. If the engine may still be
    // retrying, a settlement could be followed by that invocation's next beat,
    // so the honest answer is to write nothing and say so.
    const subject = capabilitySubject("cancel-engine-failed");
    const before = subject.ledger.status();

    const failure = await withEngineAnswering(
      {
        lookup: ENGINE_CANCELS.lookup,
        cancel: { status: 503, body: '{"message":"unavailable","id":"' + ENGINE_INVOCATION_ID + '"}' },
      },
      subject.ledger,
      () =>
        subject.driver
          .cancel(INVOCATION_FOR_CAPABILITIES)
          .then(() => null)
          .catch((e: unknown) => e),
    );

    const error = failure.result;
    expect(error).toBeInstanceOf(SupervisorError);
    expect((error as Error).message).toContain("503");
    // The status, never the engine's own text — which named an invocation id.
    expect((error as Error).message).not.toContain("inv_");
    expect(subject.ledger.status().eventCount).toBe(before.eventCount);
  });

  it("treats 404 and 409 as an engine that is not running this invocation", async () => {
    // Both mean the invocation is not in flight, which is exactly the
    // postcondition act 2 exists to reach: an invocation the engine has never
    // heard of, and one it has already completed. Refusing on either would
    // leave a task uncancellable because the engine had already stopped it.
    // P3 (V2 L4): `cancel` is byte-identical after the reattach change. Its
    // branch was untouched and only its comment was restated, so the trails
    // below must remain what they were — and must remain equal to each other,
    // because on THIS path the settlement decides rather than the engine.
    const trails: string[][] = [];
    for (const status of [404, 409]) {
      const subject = capabilitySubject("cancel-engine-" + String(status));
      const before = subject.ledger.status().eventCount;
      const { result } = await withEngineAnswering(
        { lookup: ENGINE_CANCELS.lookup, cancel: { status, body: "{}" } },
        subject.ledger,
        () => subject.driver.cancel(INVOCATION_FOR_CAPABILITIES),
      );
      expect({ status, result }).toEqual({
        status,
        result: { ok: true, finalSequence: subject.ledger.status().headSequence },
      });
      expect(subject.ledger.status().eventCount).toBe(before + 1);
      trails.push(
        subject.ledger.listEvents({ limit: 200 }).events.map((record) => record.event.type),
      );
    }
    expect(trails[0]).toEqual(trails[1]);
    expect(trails[0]?.at(-1)).toBe("TASK_CANCELLED");
  });

  it("refuses to aim a cancellation at an address it could not read", async () => {
    // The same discipline `parseCacheReply` and `parseFinalSequence` hold. A
    // half-parsed body coerced into a string would point a TERMINATING
    // operation at whatever that string happened to be.
    for (const body of ["not json", "null", "[]", "{}", '{"invocationId":11}', '{"invocationId":""}']) {
      const subject = capabilitySubject("cancel-malformed-" + String(body.length));
      const before = subject.ledger.status().eventCount;
      const failure = await withEngineAnswering(
        { lookup: { status: 200, body }, cancel: ENGINE_CANCELS.cancel },
        subject.ledger,
        () =>
          subject.driver
            .cancel(INVOCATION_FOR_CAPABILITIES)
            .then(() => null)
            .catch((e: unknown) => e),
      );
      expect(failure.result).toBeInstanceOf(Error);
      // Nothing was cancelled and nothing was written.
      expect(failure.asked.length).toBe(1);
      expect(subject.ledger.status().eventCount).toBe(before);
    }
  });

  it("refuses to talk to anything that is not loopback", async () => {
    // ADR 0004 §6's loopback law is about the plane, not about a port, and the
    // admin base is the one new host this packet talks to.
    const root = scenario("capability-cancel-offbox");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);
    await expect(
      cancelAdvance("http://127.0.0.1:8080", "http://10.0.0.1:9070", INVOCATION_FOR_CAPABILITIES),
    ).rejects.toThrow(/loopback only/);
    await expect(
      cancelAdvance("http://example.test:8080", "http://127.0.0.1:9070", INVOCATION_FOR_CAPABILITIES),
    ).rejects.toThrow(/loopback only/);
  });
});

// ---------------------------------------------------------------------------
// V2-B2-5: the durable timer and the durable gate, by shape
// ---------------------------------------------------------------------------

/**
 * What a unit suite can prove about these two verbs, and what it cannot.
 *
 * It can prove the SHAPE: the exact address each derives, the header each
 * sends, the body each sends, and — for the negatives, which carry the weight —
 * that some calls are never made at all. Every one of those is a decision this
 * code makes before any engine sees it.
 *
 * It cannot prove that the engine honours any of it. That a delayed send really
 * holds the beat, that a named durable promise really survives a SIGKILL, and
 * that a second resolve really answers `409` are all claims about Restate, and
 * they are drilled against the pinned server rather than asserted here.
 */
describe("the durable timer schedules through the engine (V2-B2-5)", () => {
  it("issues exactly one delayed send, at the derived address and under the derived key", async () => {
    const subject = capabilitySubject("timer-address");
    const { result, asked } = await withIngressAnswering(ENGINE_SCHEDULES, () =>
      subject.driver.timer(INVOCATION_FOR_CAPABILITIES, 3_000),
    );

    expect(result).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
    const call = asked[0];
    expect(call?.method).toBe("POST");
    // The same target `sendAdvance` uses, plus the delay. Compared as a parsed
    // URL rather than by substring, so a query parameter cannot hide in a path.
    const target = new URL(call?.url ?? "");
    expect(target.origin).toBe("http://127.0.0.1:8080");
    expect(target.pathname).toBe(
      "/AcpTask/" + INVOCATION_FOR_CAPABILITIES.taskId + "/advance/send",
    );
    expect(target.searchParams.get("delay")).toBe("PT3S");
    // The key is the one derived before ingress, so a repeat is the same call.
    expect(call?.idempotencyKey).toBe(INVOCATION_FOR_CAPABILITIES.invocationId);
  });

  it("renders whole seconds and sub-second delays without ever formatting a float", async () => {
    const subject = capabilitySubject("timer-durations");
    for (const [delayMs, expected] of [
      [0, "PT0S"],
      [1_000, "PT1S"],
      [3_000, "PT3S"],
      [250, "PT0.250S"],
      [1_500, "PT1.500S"],
      [61_001, "PT61.001S"],
    ] as const) {
      const { asked } = await withIngressAnswering(ENGINE_SCHEDULES, () =>
        subject.driver.timer(INVOCATION_FOR_CAPABILITIES, delayMs),
      );
      expect({ delayMs, delay: new URL(asked[0]?.url ?? "").searchParams.get("delay") }).toEqual({
        delayMs,
        delay: expected,
      });
    }
  });

  it("refuses a malformed duration BEFORE the wire, with zero engine calls", async () => {
    // The load-bearing negative, and the reason it is load-bearing is measured:
    // the pinned server ACCEPTS `?delay=3s` with 202 and silently ignores it.
    // So an unvalidated bad duration does not fail — it becomes no delay at
    // all, and a timer nobody set looks exactly like one that already fired.
    const subject = capabilitySubject("timer-refusals");
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { asked } = await withIngressAnswering(ENGINE_SCHEDULES, async () => {
        await expect(subject.driver.timer(INVOCATION_FOR_CAPABILITIES, bad)).rejects.toThrow(
          /durable timer/,
        );
      });
      // Observed, not argued: the refusal happened before anything was asked.
      expect({ bad: String(bad), calls: asked.length }).toEqual({ bad: String(bad), calls: 0 });
    }
  });

  it("throws rather than refusing when the engine would not take the timer", async () => {
    // The same reasoning `reattach` gives: the capability is present, so a
    // channel failure is not an answer about the work. A refusal here would
    // tell a caller this engine cannot schedule.
    const subject = capabilitySubject("timer-unreachable");
    const { asked } = await withIngressAnswering({ status: 503, body: "unavailable" }, async () => {
      await expect(subject.driver.timer(INVOCATION_FOR_CAPABILITIES, 1_000)).rejects.toThrow(
        /did not accept the durable timer and answered 503/,
      );
    });
    expect(asked).toHaveLength(1);
    // The status, never the body: engine text may name an engine invocation id.
    await withIngressAnswering({ status: 500, body: "inv_1leakySeventeenCharacters" }, async () => {
      const error = await subject.driver
        .timer(INVOCATION_FOR_CAPABILITIES, 1_000)
        .then(() => null)
        .catch((e: unknown) => e);
      expect(String(error)).not.toMatch(/inv_/);
    });
  });

  it("appends nothing when it schedules", async () => {
    const subject = capabilitySubject("timer-appends-nothing");
    const before = subject.ledger.status();
    await withIngressAnswering(ENGINE_SCHEDULES, () =>
      subject.driver.timer(INVOCATION_FOR_CAPABILITIES, 5_000),
    );
    const after = subject.ledger.status();
    // Scheduling is not a lifecycle transition; the walk it schedules is what
    // writes, and it writes exactly what it always did.
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);
  });

  it("refuses to schedule anywhere that is not loopback", async () => {
    await expect(
      sendAdvanceDelayed("http://example.test:8080", INVOCATION_FOR_CAPABILITIES, 1_000),
    ).rejects.toThrow(/loopback only/);
  });

  it("keeps TimerResult to exactly {ok, status}", async () => {
    // The engine's reply to a delayed send carries its OWN invocation id --
    // `ENGINE_SCHEDULES` is that literal shape -- so the result type having
    // nowhere to put it is what stops it travelling, and the fence pins it.
    const { result } = await withIngressAnswering(ENGINE_SCHEDULES, () =>
      sendAdvanceDelayed("http://127.0.0.1:8080", INVOCATION_FOR_CAPABILITIES, 1_000),
    );
    expect(Object.keys(result).sort()).toEqual(["ok", "status"]);
    expect(result).toEqual({ ok: true, status: 202 });
    expect(JSON.stringify(result)).not.toMatch(/inv_/);
  });
});

describe("the durable gate makes SIGNAL real without touching AcpTask (V2-B2-5)", () => {
  it("releases at an address built entirely from the derived invocation id", async () => {
    const subject = capabilitySubject("signal-address");
    const { result, asked } = await withIngressAnswering(GATE_RESOLVES, () =>
      subject.driver.signal(INVOCATION_FOR_CAPABILITIES),
    );

    expect(result).toEqual({ ok: true });
    // ONE request. No `/restate/lookup`, no admin call, no journal read: the
    // whole reason this verb never learns an engine-minted identity.
    expect(asked).toHaveLength(1);
    const call = asked[0];
    expect(call?.method).toBe("POST");
    const target = new URL(call?.url ?? "");
    expect(target.origin).toBe("http://127.0.0.1:8080");
    expect(target.pathname).toBe(
      "/" +
        RESTATE_WORKFLOW_GATE +
        "/" +
        INVOCATION_FOR_CAPABILITIES.invocationId +
        "/" +
        RESTATE_HANDLER_GATE_RESOLVE,
    );
    // The workflow KEY is the derived id, and so is the idempotency key.
    expect(target.pathname).toContain(INVOCATION_FOR_CAPABILITIES.invocationId);
    expect(call?.idempotencyKey).toBe(INVOCATION_FOR_CAPABILITIES.invocationId);
  });

  it("sends a closed literal, never caller content", async () => {
    // The redaction boundary, structurally. `signal(invocation)` takes no
    // payload parameter, so there is no expression in which a prompt, a
    // transcript or a tool argument could reach engine state through this door.
    const subject = capabilitySubject("signal-payload");
    const { asked } = await withIngressAnswering(GATE_RESOLVES, () =>
      subject.driver.signal(INVOCATION_FOR_CAPABILITIES),
    );
    const payload: GatePayload = { released: true };
    expect(asked[0]?.body).toBe(JSON.stringify(payload));
    expect(JSON.parse(asked[0]?.body ?? "null")).toEqual({ released: true });
  });

  it("does not report a release the engine did not perform", async () => {
    // A second resolve earns `409 "promise was already completed"` from the
    // pinned server. It is deliberately NOT translated into success: only a
    // caller holding the ledger may decide what a second signal means, and
    // answering `ok` would erase the difference between "released it" and
    // "found it already released".
    const subject = capabilitySubject("signal-conflict");
    await withIngressAnswering(
      { status: 409, body: JSON.stringify({ code: 409, message: "promise was already completed" }) },
      async () => {
        await expect(subject.driver.signal(INVOCATION_FOR_CAPABILITIES)).rejects.toThrow(
          /durable gate for this invocation answered 409/,
        );
      },
    );

    // And a gate that was never opened is not a release either.
    await withIngressAnswering({ status: 404, body: "not found" }, async () => {
      await expect(subject.driver.signal(INVOCATION_FOR_CAPABILITIES)).rejects.toThrow(
        /answered 404/,
      );
    });
  });

  it("appends nothing when it releases", async () => {
    const subject = capabilitySubject("signal-appends-nothing");
    const before = subject.ledger.status();
    await withIngressAnswering(GATE_RESOLVES, () =>
      subject.driver.signal(INVOCATION_FOR_CAPABILITIES),
    );
    const after = subject.ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);
  });

  it("refuses to release anywhere that is not loopback", async () => {
    await expect(
      resolveGate("http://example.test:8080", INVOCATION_FOR_CAPABILITIES),
    ).rejects.toThrow(/loopback only/);
  });

  it("keeps SignalResult to exactly {ok, status}", async () => {
    const { result } = await withIngressAnswering(GATE_RESOLVES, () =>
      resolveGate("http://127.0.0.1:8080", INVOCATION_FOR_CAPABILITIES),
    );
    expect(Object.keys(result).sort()).toEqual(["ok", "status"]);
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("parks on the one named promise, and announces before and after", async () => {
    // The handler, without a server. What is asserted is that it awaits THE
    // named promise and nothing else, and that the two announcements bracket
    // the wait -- which is what lets a drill proceed on a handshake instead of
    // on elapsed time.
    const names: string[] = [];
    const points: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((resolvePromise) => {
      release = () => {
        resolvePromise();
      };
    });
    const ctx: GateRunContext = {
      promise: ((name: string) => {
        names.push(name);
        return held;
      }) as unknown as GateRunContext["promise"],
    };

    const running = gateRunHandler(
      {
        __onGate: (point) => {
          points.push(point);
          return Promise.resolve();
        },
      },
      ctx,
      INVOCATION_FOR_CAPABILITIES,
    );

    // Parked: it announced, and it has not returned.
    await Promise.resolve();
    expect(points).toEqual(["PARKED"]);
    expect(names).toEqual([RESTATE_GATE_PROMISE]);

    release();
    expect(await running).toEqual({ released: true });
    expect(points).toEqual(["PARKED", "RELEASED"]);
    // Exactly one promise, asked for exactly once.
    expect(names).toEqual([RESTATE_GATE_PROMISE]);
  });

  it("resolves the same named promise from the shared side", async () => {
    const resolvedWith: unknown[] = [];
    const names: string[] = [];
    const ctx: GateResolveContext = {
      promise: ((name: string) => {
        names.push(name);
        return {
          resolve: (value: unknown) => {
            resolvedWith.push(value);
            return Promise.resolve();
          },
        };
      }) as unknown as GateResolveContext["promise"],
    };

    const payload: GatePayload = { released: true };
    expect(await gateResolveHandler(ctx, payload)).toEqual({ resolved: true });
    // The same name the run side awaits -- two spellings would be a gate that
    // could never be released.
    expect(names).toEqual([RESTATE_GATE_PROMISE]);
    expect(resolvedWith).toEqual([payload]);
  });

  it("holds no ledger, so waiting cannot become a second authority", () => {
    // Structural rather than behavioural: `GateDependencies` has one optional
    // announcement seam and no ledger, so there is no expression in which the
    // gate could append. A gate that COULD write would be a place where a fact
    // lived that the ledger did not hold.
    const dependencies: Parameters<typeof gateRunHandler>[0] = {};
    expect(Object.keys(dependencies)).toEqual([]);
    // @ts-expect-error the gate is handed no ledger, and may not ask for one.
    const noLedger: unknown = dependencies.ledger;
    expect(noLedger).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// V2-B7R: a classified failure settles, journaled, without a false terminal
// ---------------------------------------------------------------------------

/**
 * The handler driven directly through `AdvanceContext`, which is what that seam
 * exists for: the settlement's journal position and its exactly-one-ness are
 * properties of the handler, and asserting them here needs no server.
 *
 * The real-server behaviour these rest on was measured before the design was
 * written — a `TerminalError` thrown inside `ctx.run` is caught by the handler,
 * a subsequent `ctx.run` is accepted and journaled, and after a real `SIGKILL`
 * the failed entry replays as a failure without re-executing while the metadata
 * riding it is byte-identical. The report records that spike.
 */

/** A beat whose INTENT effect fails the way a port classifies a failure. */
function failingBeat(
  root: ScenarioRoot,
  ledger: Ledger,
  failure: Error,
): (invocation: DurableInvocation) => BeatContext {
  return (candidate: DurableInvocation): BeatContext => ({
    ledger,
    effects: {
      apply: () => Promise.reject(failure),
      probe: (operation) => Promise.resolve(probeEffect(root, operation)),
    },
    invocation: candidate,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    route: TEST_ROUTE,
    initiativeId: TEST_INITIATIVE_ID,
  });
}

describe("V2-B7R: a classified step failure settles", () => {
  it("P1/P3: appends one TASK_FAILED inside a single settle/failed journal entry", async () => {
    const { ledger, root, invocation } = open("b7r-settles", "4b7a0000-4040-4404-8404-404040400001");
    const beat = failingBeat(root, ledger, new ExecutionEffectError("ROUTE_INVALID", "route.accountId"));
    const { ctx, runs } = fakeContext(null);

    await expect(
      advanceHandler({ beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger }, ctx, invocation),
    ).rejects.toThrow(TerminalError);

    // C1 — the settlement is its own named journal entry, exactly once...
    expect(runs.filter((name) => name === "settle/failed")).toHaveLength(1);
    // ...and it lands AFTER the entry that failed, never inside it.
    const failedAt = runs.findIndex((name) => name.startsWith("effect/"));
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf("settle/failed")).toBeGreaterThan(failedAt);
    // Nothing is journaled after the settlement: the handler re-throws.
    expect(runs[runs.length - 1]).toBe("settle/failed");

    // P1 — exactly one terminal, from the state the ledger reported.
    const failures = ledger.listEvents({ limit: 200 }).events.filter((r) => r.event.type === "TASK_FAILED");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.event.toState).toBe("FAILED");
    expect(failures[0]?.event.fromState).toBe("RUNNING");
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("FAILED");
  });

  it("P2/C4: the original terminal error still propagates, so Restate does not retry the walk", async () => {
    const { ledger, root, invocation } = open("b7r-rethrows", "4b7a0000-4040-4404-8404-404040400002");
    const beat = failingBeat(root, ledger, new ExecutionEffectError("ROUTE_INVALID", "route.accountId"));
    const { ctx } = fakeContext(null);

    const thrown = await advanceHandler(
      { beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger },
      ctx,
      invocation,
    ).then(() => null, (error: unknown) => error);

    // A terminal error, so Restate stops rather than grinding the walk again.
    expect(thrown).toBeInstanceOf(TerminalError);
    // And it is the SAME failure, not a settlement-shaped replacement.
    expect((thrown as Error).message).toContain("ROUTE_INVALID");
  });

  it("N4: the appended payload carries a classified code and never the error's message", async () => {
    // The message is the sharp edge: `fatal()` puts `error.message` on the
    // TerminalError, and this lane propagates that to the ingress caller. What
    // the LEDGER is told must be a code derived from the error's type.
    const { ledger, root, invocation } = open("b7r-privacy", "4b7a0000-4040-4404-8404-404040400003");
    const planted = new ExecutionEffectError("ROUTE_INVALID", "route.accountId");
    planted.message = "boom at /Users/someone/secret path with sk-canary-do-not-emit-4242";
    const beat = failingBeat(root, ledger, planted);
    const { ctx } = fakeContext(null);

    await expect(
      advanceHandler({ beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger }, ctx, invocation),
    ).rejects.toThrow(TerminalError);

    const serialized = ledger.listEvents({ limit: 200 }).events.map((r) => r.canonicalJson).join("\n");
    expect(serialized.length).toBeGreaterThan(0);
    for (const forbidden of ["/Users/", "sk-canary-do-not-emit-4242", "boom at", "credentialRef", "authProfileRef"]) {
      expect({ forbidden, present: serialized.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
    const failure = ledger.listEvents({ limit: 200 }).events.find((r) => r.event.type === "TASK_FAILED");
    expect(Object.keys(failure?.event.payload ?? {}).sort()).toEqual(["reason", "submissionDigest"]);
    expect(failure?.event.payload["reason"]).toBe("EXECUTION_FAILED");
  });

  it("N1: POSTCONDITION_UNKNOWN settles nothing and leaves the intent open", async () => {
    // The packet's central law. An effect may have happened and gone
    // unrecorded, so a terminal claim over it is the one claim ADR 0004 §3
    // exists to prevent.
    const { ledger, root, invocation } = open("b7r-unknown", "4b7a0000-4040-4404-8404-404040400004");
    const beat = failingBeat(root, ledger, new PostconditionUnknownError("op-1", "the postcondition could not be established"));
    const { ctx, runs } = fakeContext(null);

    await expect(
      advanceHandler({ beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger }, ctx, invocation),
    ).rejects.toThrow(TerminalError);

    expect(runs).not.toContain("settle/failed");
    const types = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.type);
    expect(types).not.toContain("TASK_FAILED");
    // The intent stays open for an operator.
    expect(types).toContain("RUN_STARTED");
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("RUNNING");
  });

  it("P4: a non-resumable prologue settles nothing, with zero ledger delta", async () => {
    // C2 asserted from the outside: the catch does not wrap `reconcile`, so a
    // reconciliation refusal produces no settlement and no delta at all.
    const { ledger, invocation, beat } = open("b7r-prologue", "4b7a0000-4040-4404-8404-404040400005");
    appendPlanStep(beat(invocation), LIFECYCLE_PLAN[0]!);
    const before = ledger.status();
    const { ctx, runs } = fakeContext({ lastAppliedSequence: 99, lastAppliedEventSha256: "b".repeat(64) });

    await expect(
      advanceHandler({ beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger }, ctx, invocation),
    ).rejects.toThrow();

    expect(runs).not.toContain("settle/failed");
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
    expect(ledger.listEvents({ limit: 200 }).events.map((r) => r.event.type)).not.toContain("TASK_FAILED");
  });

  it("P6: a settled task refuses a second walk and does not settle twice", async () => {
    const { ledger, root, invocation } = open("b7r-second-walk", "4b7a0000-4040-4404-8404-404040400006");
    const beat = failingBeat(root, ledger, new ExecutionEffectError("ROUTE_INVALID", "route.accountId"));
    const first = fakeContext(null);
    await expect(
      advanceHandler({ beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger }, first.ctx, invocation),
    ).rejects.toThrow(TerminalError);
    const after = ledger.status();

    const second = fakeContext(null);
    await expect(
      advanceHandler({ beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger }, second.ctx, invocation),
    ).rejects.toThrow();

    // Exactly one terminal, ever, and the ledger did not move on the re-walk.
    expect(ledger.listEvents({ limit: 200 }).events.filter((r) => r.event.type === "TASK_FAILED")).toHaveLength(1);
    expect(ledger.status().eventCount).toBe(after.eventCount);
    expect(ledger.status().headEventSha256).toBe(after.headEventSha256);
  });
});

describe("P7: both drivers settle a classified failure identically", () => {
  it("produces the same terminal event, compared as canonical bytes", async () => {
    // The whole content of D-B7R-1 = β, asserted rather than argued. The two
    // lanes are given the same invocation, the same route, the same initiative
    // and the same classified failure; what the ledger ends up holding must be
    // the same event, byte for byte, or "the two drivers walk the same plan"
    // has stopped being true at the one moment it matters most.
    const failure = () => new ExecutionEffectError("ROUTE_INVALID", "route.accountId");
    const TASK = "4b7a0000-4040-4404-8404-404040400007";

    // Lane A — the Restate handler.
    const a = open("b7r-symmetry-restate", TASK);
    await expect(
      advanceHandler(
        { beat: failingBeat(a.root, a.ledger, failure()), commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", initiativeId: TEST_INITIATIVE_ID, ledger: a.ledger },
        fakeContext(null).ctx,
        a.invocation,
      ),
    ).rejects.toThrow(TerminalError);

    // Lane B — the SQLite supervisor, on its own ledger, same invocation.
    const b = open("b7r-symmetry-sqlite", TASK);
    await expect(
      new SqliteSupervisor({
        ledger: b.ledger,
        invocation: b.invocation,
        effects: { apply: () => Promise.reject(failure()), probe: (op) => Promise.resolve(probeEffect(b.root, op)) },
        emittedBy: EMITTED_BY,
        commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
        initiativeId: TEST_INITIATIVE_ID,
        route: TEST_ROUTE,
      }).runToCheckpoint(),
    ).rejects.toThrow(ExecutionEffectError);

    const terminalOf = (ledger: Ledger) =>
      ledger.listEvents({ limit: 200 }).events.find((r) => r.event.type === "TASK_FAILED");
    const fromA = terminalOf(a.ledger);
    const fromB = terminalOf(b.ledger);
    expect(fromA).toBeDefined();
    expect(fromB).toBeDefined();

    // Same event, byte for byte: same type, state, transition id, payload and
    // idempotency key, because both were built by the one shared module.
    expect(fromB?.canonicalJson).toBe(fromA?.canonicalJson);
    expect(fromA?.event.transitionId).toBe("failed");
    expect(fromA?.event.toState).toBe("FAILED");
    expect(fromA?.event.payload["reason"]).toBe("EXECUTION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// V2 L2: the lifecycle construction, and the inertness that justifies it
// ---------------------------------------------------------------------------

/**
 * A driver constructed for `cancel` and `reattach`, with no commit policy.
 *
 * The claim under test is narrow and mechanical: on the cancel path the plan is
 * INERT, so refusing to guess a policy costs nothing a reader of the log could
 * detect. That is worth measuring rather than arguing, because it is the whole
 * reason the door may recover its context from ledger evidence alone — the
 * policy is the one value that is nowhere in the evidence.
 */
describe("a driver built for the lifecycle verbs", () => {
  /**
   * The same fixture as `capabilitySubject`, with the construction as a
   * parameter.
   *
   * Written out rather than folded into that helper: this file's other suites
   * pin a construction that must not move, and a shared helper that grew a
   * selector would let a later edit change what they are constructing without
   * saying so.
   */
  function subjectFor(
    name: string,
    construction: "LIFECYCLE" | CommitPolicy,
    probe: () => Promise<PostconditionVerdict>,
  ): CapabilitySubject {
    const root = scenario("lifecycle-" + name);
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);

    const beat = (candidate: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
      ledger,
      effects: {
        apply: () => {
          throw new SupervisorError("the lifecycle fixture never performs an effect");
        },
        probe,
      },
      invocation: candidate,
      emittedBy: EMITTED_BY,
      route: TEST_ROUTE,
    });

    const context: BeatContext = {
      ...beat(INVOCATION_FOR_CAPABILITIES),
      plan: LIFECYCLE_PLAN,
      initiativeId: TEST_INITIATIVE_ID,
    };
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      if (step.beat === "OUTCOME") continue;
      appendPlanStep(context, step);
    }

    const options = {
      ledger,
      invocation: INVOCATION_FOR_CAPABILITIES,
      emittedBy: EMITTED_BY,
      ingressUrl: "http://127.0.0.1:8080",
      adminUrl: "http://127.0.0.1:9070",
    };

    return {
      ledger,
      driver:
        construction === "LIFECYCLE"
          ? RestateDriver.forLifecycle(options, beat, TEST_INITIATIVE_ID)
          : new RestateDriver(options, beat, construction, TEST_INITIATIVE_ID),
    };
  }

  /** One attach the engine answers, and the ledger head it names. */
  const ATTACHED_SEQUENCE = 7;
  const ATTACHED_REPLY = {
    status: 200,
    body: JSON.stringify({ finalSequence: ATTACHED_SEQUENCE }),
  };

  /** Every event of the capability task, canonicalized, in order. */
  function trail(ledger: Ledger): readonly string[] {
    return ledger
      .listEvents({ limit: 200 })
      .events.filter((record) => record.event.taskId === INVOCATION_FOR_CAPABILITIES.taskId)
      .map((record) => record.canonicalJson);
  }

  it("settles a cancellation byte-identically to either commit policy", async () => {
    const probe = (): Promise<PostconditionVerdict> => Promise.resolve("DONE");
    const trails: string[][] = [];

    // `DONE` on purpose: it is the branch that reads the most plan. The open
    // intent is closed first, so an OUTCOME is built from `plan[4]` and its
    // causal predecessor is verified against the same step, and only then is
    // the cancellation appended at `plan.length`.
    for (const construction of ["LIFECYCLE", "NO_COMMIT", "LOCAL_COMMIT_WITH_RECEIPT"] as const) {
      const subject = subjectFor(construction.toLowerCase().replace(/_/g, "-"), construction, probe);
      const { result } = await withEngineAnswering(ENGINE_CANCELS, subject.ledger, () =>
        subject.driver.cancel(INVOCATION_FOR_CAPABILITIES),
      );
      expect(result).toEqual({ ok: true, finalSequence: subject.ledger.status().headSequence });
      trails.push([...trail(subject.ledger)]);
    }

    // The measurement. Not "equivalent", not "the same shape": the same bytes,
    // which is the only claim a ledger's hash chain actually cares about.
    expect(trails[0]).toEqual(trails[1]);
    expect(trails[0]).toEqual(trails[2]);

    // And the trail is the one the walk would have written: an outcome, then a
    // cancellation. A fixture that appended neither would make the equality
    // above true and vacuous.
    const types = (trails[0] ?? []).map((json) => (JSON.parse(json) as { type: string }).type);
    expect(types.slice(-2)).toEqual(["ATOMIC_STEP_COMPLETED", "TASK_CANCELLED"]);
  });

  it("refuses an UNKNOWN probe with zero appends, exactly as a policy-bound driver does", async () => {
    const probe = (): Promise<PostconditionVerdict> => Promise.resolve("UNKNOWN");
    const subject = subjectFor("unknown", "LIFECYCLE", probe);
    const before = subject.ledger.status();

    const { result } = await withEngineAnswering(ENGINE_CANCELS, subject.ledger, () =>
      subject.driver.cancel(INVOCATION_FOR_CAPABILITIES),
    );

    expect(result).toEqual({ ok: false, refusal: "POSTCONDITION_UNKNOWN", at: "cancel" });
    expect(subject.ledger.status().eventCount).toBe(before.eventCount);
    expect(subject.ledger.status().headEventSha256).toBe(before.headEventSha256);
  });

  it("rejoins without reading any context at all", async () => {
    const subject = subjectFor(
      "attach",
      "LIFECYCLE",
      (): Promise<PostconditionVerdict> => Promise.resolve("NOT_DONE"),
    );
    const before = subject.ledger.status();

    const { result, asked } = await withAttachAnswering(ATTACHED_REPLY, () =>
      subject.driver.reattach(INVOCATION_FOR_CAPABILITIES),
    );

    expect(result).toEqual({ ok: true, finalSequence: ATTACHED_SEQUENCE });
    expect(asked).toHaveLength(1);
    expect(subject.ledger.status().eventCount).toBe(before.eventCount);
  });

  it("walks no plan, and refuses in its own words rather than the handler's", async () => {
    const subject = subjectFor(
      "no-walk",
      "LIFECYCLE",
      (): Promise<PostconditionVerdict> => Promise.resolve("NOT_DONE"),
    );

    // Both constructions refuse `advance`, and the two refusals are different
    // facts. A reader who cannot tell them apart concludes the engine is the
    // obstacle when the construction is.
    await expect(
      subject.driver.advance(INVOCATION_FOR_CAPABILITIES, "RUNNING"),
    ).rejects.toThrow(/constructed for the lifecycle verbs/);

    const bound = subjectFor(
      "no-walk-bound",
      "LOCAL_COMMIT_WITH_RECEIPT",
      (): Promise<PostconditionVerdict> => Promise.resolve("NOT_DONE"),
    );
    await expect(
      bound.driver.advance(INVOCATION_FOR_CAPABILITIES, "RUNNING"),
    ).rejects.toThrow(/advances through its object handler/);
  });

  it("declares what it always declared, so a door meets no different capability", () => {
    const lifecycle = subjectFor(
      "capabilities",
      "LIFECYCLE",
      (): Promise<PostconditionVerdict> => Promise.resolve("NOT_DONE"),
    );
    const bound = subjectFor(
      "capabilities-bound",
      "LOCAL_COMMIT_WITH_RECEIPT",
      (): Promise<PostconditionVerdict> => Promise.resolve("NOT_DONE"),
    );
    expect(lifecycle.driver.capabilities()).toEqual(bound.driver.capabilities());
    expect(lifecycle.driver.mode).toBe(RESTATE_MODE);
  });

  it("takes three arguments and not a policy among them", () => {
    expect(RestateDriver.forLifecycle.length).toBe(3);
  });
});
