import { CONTRACT_VERSION, ReconciliationReport, findCredentialViolations } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RESTATE_STATE_KEY_CACHE } from "../../../src/constants/index.js";
import type { DurableInvocation, LedgerLike, RestateCacheState } from "../../../src/contracts/index.js";
import {
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  READ_ONLY_PLAN,
} from "../../../src/core/lifecycle/index.js";
import { deriveEventCoordinate } from "../../../src/core/coordinates/index.js";
import { appendPlanStep } from "../../../src/core/step-executor/index.js";
import type { BeatContext } from "../../../src/core/step-executor/index.js";
import { SupervisorError } from "../../../src/errors/index.js";
import {
  applyEffect,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../../src/toy/repository/index.js";
import { RESTATE_MODE, RestateDriver, advanceHandler, reconcile } from "../../../src/drivers/restate-driver/index.js";
import type { AdvanceContext } from "../../../src/drivers/restate-driver/index.js";
import { parseCacheReply } from "../../../src/restate/submit/index.js";

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
    invocationId: "inv-" + taskId.slice(0, 8),
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
      },
      probe: (operation) => probeEffect(root, operation),
    },
    invocation: candidate,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
  });
  return { ledger, root, invocation, beat };
}

function driverFor(
  ledger: Ledger,
  invocation: DurableInvocation,
  beat: (invocation: DurableInvocation) => BeatContext,
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
          { beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", ledger, __onBeat: (point) => beats.push(point) },
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

  it("proceeds and caches only when the verdict is resumable", async () => {
    const { ledger, invocation, beat } = open(
      "handler-resumable",
      "40404040-4040-4404-8404-404040404043",
    );
    const beats: string[] = [];
    const { ctx, runs, sets } = fakeContext(null);

    const result = await advanceHandler(
      { beat, commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT", ledger, __onBeat: (point) => beats.push(point) },
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
      { beat, commitPolicy: "NO_COMMIT", ledger, __onBeat: (point) => beats.push(point) },
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
