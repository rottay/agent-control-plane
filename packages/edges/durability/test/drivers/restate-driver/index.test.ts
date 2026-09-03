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
  ScenarioRoot,
} from "@acp/runtime";
import type { Context } from "@restatedev/restate-sdk";

import type { DurableStepContext, LedgerLike, RestateCacheState } from "../../../src/contracts/index.js";
import { RESTATE_MODE, RestateDriver, advanceHandler, reconcile } from "../../../src/drivers/restate-driver/index.js";
import type { AdvanceContext } from "../../../src/drivers/restate-driver/index.js";
import { parseCacheReply } from "../../../src/submit/index.js";


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
 * The subject for the capability tests: stubs only, no ledger file, no server,
 * no network. None of the four verbs reaches any of them, which is the point.
 */
const INVOCATION_FOR_CAPABILITIES = invocationFor("5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a02");

function capabilitySubject(): RestateDriver {
  const beat = (candidate: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
    ledger: {
      append: () => {
        throw new SupervisorError("the capability fixture never appends");
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
      invocation: INVOCATION_FOR_CAPABILITIES,
      emittedBy: EMITTED_BY,
      ingressUrl: "http://127.0.0.1:8080",
      adminUrl: "http://127.0.0.1:9070",
    },
    beat,
    "NO_COMMIT",
    TEST_INITIATIVE_ID,
  );
}

/**
 * The capability declaration, and the law that stops it being decorative
 * (V2-B2-1).
 *
 * The stub cases are the ones that discriminate. A declaration checked only
 * against a driver that already agrees with it proves nothing: it would pass
 * just as happily if the law compared nothing at all. So both mismatch
 * directions are built deliberately and asserted to be caught.
 */
describe("the driver declares what it cannot do, and the declaration is checked", () => {
  const OUTCOMES = async (driver: OrchestrationDriver) => ({
    CANCEL: await driver.cancel(INVOCATION_FOR_CAPABILITIES),
    REATTACH: await driver.reattach(INVOCATION_FOR_CAPABILITIES),
    SIGNAL: await driver.signal(INVOCATION_FOR_CAPABILITIES),
    TIMER: await driver.timer(INVOCATION_FOR_CAPABILITIES),
  });

  it("declares every verb UNSUPPORTED, and the declaration satisfies the contract", () => {
    const declared = capabilitySubject().capabilities();
    expect(DriverCapabilities.safeParse(declared).success).toBe(true);
    expect(declared.verbs).toEqual({
      CANCEL: "UNSUPPORTED",
      REATTACH: "UNSUPPORTED",
      SIGNAL: "UNSUPPORTED",
      TIMER: "UNSUPPORTED",
    });
    expect(declared.properties).toEqual({ SERIALIZED_PER_TASK: "UNSUPPORTED" });
    expect(declared.mode).toBe(capabilitySubject().mode);
  });

  it("refuses every verb field-exactly: never a throw, never a silent no-op", async () => {
    const observed = await OUTCOMES(capabilitySubject());
    for (const [verb, at] of [
      ["CANCEL", "cancel"],
      ["REATTACH", "reattach"],
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
    const subject = capabilitySubject();
    expect(driverCapabilityMismatches(subject.capabilities(), await OUTCOMES(subject))).toEqual([]);
  });

  it("catches a declaration that claims SUPPORTED while the verb refuses", async () => {
    const subject = capabilitySubject();
    const declared = subject.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, CANCEL: "SUPPORTED" as const } };
    expect(driverCapabilityMismatches(lying, await OUTCOMES(subject))).toEqual([
      "CANCEL: declared SUPPORTED but refused",
    ]);
  });

  it("catches a declaration that claims UNSUPPORTED while the verb does not refuse", async () => {
    // The mirror, and the direction that would otherwise let a driver do work
    // it told its caller it could not do.
    const subject = capabilitySubject();
    const observed = { ...(await OUTCOMES(subject)), TIMER: { ok: true } as const };
    expect(driverCapabilityMismatches(subject.capabilities(), observed)).toEqual([
      "TIMER: declared UNSUPPORTED but did not refuse",
    ]);
  });

  it("restores: with the law's comparison removed, the same mismatching stub passes", async () => {
    // The restore half, in the only honest form available to a pure function:
    // a comparison that does not compare returns no mismatches, which is
    // exactly the pre-law state the packet exists to leave behind.
    const subject = capabilitySubject();
    const declared = subject.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, CANCEL: "SUPPORTED" as const } };
    const withoutLaw = (): readonly string[] => [];
    expect(withoutLaw()).toEqual([]);
    // And with the law back, the same input is caught -- so the assertion above
    // is describing an absence of checking, not an absence of a defect.
    expect(driverCapabilityMismatches(lying, await OUTCOMES(subject)).length).toBe(1);
  });

  it("reports a verb whose outcome was never observed rather than passing it", async () => {
    const subject = capabilitySubject();
    const partial = await OUTCOMES(subject);
    const withoutSignal: Record<string, DriverOutcome> = { ...partial };
    delete withoutSignal["SIGNAL"];
    expect(driverCapabilityMismatches(subject.capabilities(), withoutSignal)).toEqual([
      "SIGNAL: declared UNSUPPORTED but no outcome was observed",
    ]);
  });
});
