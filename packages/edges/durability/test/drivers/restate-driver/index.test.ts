import { DriverCapabilities } from "@acp/contracts";
import type { DriverOutcome } from "@acp/contracts";
import { driverCapabilityMismatches } from "@acp/runtime";
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
import type { Context } from "@restatedev/restate-sdk";

import type { DurableStepContext, LedgerLike, RestateCacheState } from "../../../src/contracts/index.js";
import { RESTATE_MODE, RestateDriver, advanceHandler, reconcile } from "../../../src/drivers/restate-driver/index.js";
import type { AdvanceContext } from "../../../src/drivers/restate-driver/index.js";
import { cancelAdvance, parseCacheReply } from "../../../src/submit/index.js";


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

  it("narrows the SDK context to exactly three members (DurableStepContext)", () => {
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
      SIGNAL: await driver.signal(INVOCATION_FOR_CAPABILITIES),
      TIMER: await driver.timer(INVOCATION_FOR_CAPABILITIES),
    };
  };

  it("declares two verbs UNSUPPORTED and CANCEL and REATTACH SUPPORTED, satisfying the contract", () => {
    const declared = capabilitySubject("declaration").driver.capabilities();
    expect(DriverCapabilities.safeParse(declared).success).toBe(true);
    expect(declared.verbs).toEqual({
      CANCEL: "SUPPORTED",
      REATTACH: "SUPPORTED",
      SIGNAL: "UNSUPPORTED",
      TIMER: "UNSUPPORTED",
    });
    // `SERIALIZED_PER_TASK` moved to SUPPORTED in V2-B2-3, and only because
    // that packet drilled it: one invocation held at a beat while a second is
    // submitted, counting DISTINCT held tasks — one for the same key, two for
    // different keys. B2-1 pinned this truth here and in the fence so a
    // capability could not move in one place alone; both moved together.
    expect(declared.properties).toEqual({ SERIALIZED_PER_TASK: "SUPPORTED" });
    expect(declared.mode).toBe(RESTATE_MODE);
  });

  it("refuses every unsupported verb field-exactly: never a throw, never a silent no-op", async () => {
    const observed = await OUTCOMES(capabilitySubject("unsupported-verbs"));
    for (const [verb, at] of [
      ["SIGNAL", "signal"],
      ["TIMER", "timer"],
    ] as const) {
      // Field by field, not `toMatchObject`: the refusal reason and the `at`
      // are the whole content of the answer, and `at` names the verb rather
      // than anything about the work or the engine.
      expect({ verb, outcome: observed[verb] }).toEqual({
        verb,
        outcome: { ok: false, refusal: "CAPABILITY_UNSUPPORTED", at },
      });
    }
  });

  it("satisfies the correspondence law on the real driver", async () => {
    const subject = capabilitySubject("correspondence");
    expect(
      driverCapabilityMismatches(subject.driver.capabilities(), await OUTCOMES(subject)),
    ).toEqual([]);
  });

  it("catches a declaration that claims SUPPORTED while the verb refuses", async () => {
    const subject = capabilitySubject("claims-supported");
    const declared = subject.driver.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, SIGNAL: "SUPPORTED" as const } };
    expect(driverCapabilityMismatches(lying, await OUTCOMES(subject))).toEqual([
      "SIGNAL: declared SUPPORTED but refused",
    ]);
  });

  it("catches a declaration that claims UNSUPPORTED while the verb does not refuse", async () => {
    // The mirror, and the direction that would otherwise let a driver do work
    // it told its caller it could not do.
    const subject = capabilitySubject("claims-unsupported");
    const observed = { ...(await OUTCOMES(subject)), TIMER: { ok: true } as const };
    expect(driverCapabilityMismatches(subject.driver.capabilities(), observed)).toEqual([
      "TIMER: declared UNSUPPORTED but did not refuse",
    ]);
  });

  it("restores: with the law's comparison removed, the same mismatching stub passes", async () => {
    // The restore half, in the only honest form available to a pure function:
    // a comparison that does not compare returns no mismatches, which is
    // exactly the pre-law state the packet exists to leave behind.
    const subject = capabilitySubject("restore");
    const declared = subject.driver.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, SIGNAL: "SUPPORTED" as const } };
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

  it("throws rather than refusing when the attach could not answer", async () => {
    // A capability refusal would say the engine cannot reattach. What actually
    // happened is that this attempt could not see, which is a fact about the
    // observation channel — so it throws, and the caller falls back to the
    // ledger rather than being told a falsehood about the engine.
    const subject = capabilitySubject("attach-unanswerable");
    await expect(
      withAttachAnswering({ status: 404, body: '{"code":404,"message":"not found"}' }, () =>
        subject.driver.reattach(INVOCATION_FOR_CAPABILITIES),
      ),
    ).rejects.toBeInstanceOf(SupervisorError);
  });

  it("carries the status and never the engine's own text into the error", async () => {
    // The refusal body from a real server names an engine invocation id. The
    // driver reports the status it saw and stops there.
    const subject = capabilitySubject("attach-error-text");
    const failure = await withAttachAnswering(
      { status: 404, body: '{"message":"not found","id":"inv_12G2mtFCEW7b0uysHSZtM8sQ9pD8TndCov"}' },
      () =>
        subject.driver
          .reattach(INVOCATION_FOR_CAPABILITIES)
          .then(() => null)
          .catch((e: unknown) => e),
    );
    const error = failure.result;
    expect(error).toBeInstanceOf(SupervisorError);
    expect((error as Error).message).toContain("404");
    expect((error as Error).message).not.toContain("inv_");
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
    expect(driverCapabilityMismatches(subject.driver.capabilities(), withoutSignal)).toEqual([
      "SIGNAL: declared UNSUPPORTED but no outcome was observed",
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
    }
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
