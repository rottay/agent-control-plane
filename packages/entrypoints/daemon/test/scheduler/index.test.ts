import { CONTRACT_VERSION } from "@acp/contracts";
import type { TaskEnvelope } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import {
  WALK_CONCURRENCY_MAX,
  admitWalks,
  runAdmitted,
  runScheduledWalks,
} from "../../src/scheduler/index.js";
import type { ScheduledWalk, SchedulerPorts, WalkLease } from "../../src/scheduler/index.js";

/**
 * The instruction content for a fixture whose prose is `text` (P-06/B, ADR 0094).
 *
 * One text block, so the envelope's `objective` equals the first text block of its
 * content and the two spellings stay one fact. `contentSha256` is a placeholder:
 * escalón B admits and publishes, and escalón C is where a digest is checked
 * against the bytes it describes.
 */
function fixtureContent(text: string): Record<string, unknown> {
  return {
    contentContractVersion: 1,
    blocks: [
      {
        kind: "text",
        blockId: "b1",
        mediaType: "text/plain; charset=utf-8",
        byteLength: new TextEncoder().encode(text).byteLength,
        contentSha256: "0".repeat(64),
        artifactRefId: null,
        text,
        toolCallId: null,
        effectId: null,
      },
    ],
  };
}


/**
 * Evidence for many walks in one plane (V2 concurrency C3).
 *
 * **Concurrency is proven with a barrier, never with a clock.** A drill that
 * measures durations or compares timestamps measures the machine: it passes on
 * a fast one and flakes on a slow one, and a sequential scheduler that happens
 * to be quick passes it outright. The barrier here cannot be satisfied
 * sequentially — each walk blocks until *both* are in flight — so it fails by
 * timeout on a sequential implementation and passes only on a concurrent one.
 *
 * The other load-bearing assertion is a **call count**: on a graph refusal the
 * arbiter is called **zero** times. That is what makes "the graph first, then
 * acquire" a fact rather than a sentence in a docblock.
 */

const ROUTE = {
  provider: "claude",
  model: "opus",
  accountId: "acct-c3",
  transportKind: "CLI_SUBSCRIPTION" as const,
  capabilityPolicyVersion: "2026-08-30.1",
  resolvedAt: "2026-08-27T18:46:07.000Z",
};

function envelopeOf(taskId: string, writeSet: readonly string[], conflictKeys: readonly string[] = []): TaskEnvelope {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    initiativeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a03",
    title: "a walk",
    objective: "walk the plan",
    content: fixtureContent("walk the plan"),
    classification: "MECHANICAL",
    issuedBy: "claude/opus/implementer/01",
    issuedAt: "2026-09-04T05:00:00.000Z",
    authority: [],
    readSet: [],
    writeSet: [...writeSet],
    conflictKeys: [...conflictKeys],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "a patch" },
    validation: { commands: [], independentVerifierRequired: false },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1_000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 10 },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: false, maxStepsWithoutCheckpoint: 5 },
  } as unknown as TaskEnvelope;
}

let counter = 0;
function walkOf(
  taskId: string,
  worktreePath: string,
  writeSet: readonly string[] = [],
  conflictKeys: readonly string[] = [],
): ScheduledWalk {
  counter += 1;
  return {
    envelope: envelopeOf(taskId, writeSet, conflictKeys),
    worktreePath,
    spec: {
      scenarioId: "scenario-" + String(counter),
      taskId,
      attempt: 1,
      submittedAt: "2026-09-04T05:00:00.000Z",
      submissionDigest: "a".repeat(64),
      initiativeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a03",
      emittedBy: "claude/opus/implementer/01",
      execution: {
        route: ROUTE,
        bindings: [
          {
            accountId: ROUTE.accountId,
            transportKind: "CLI_SUBSCRIPTION",
            provider: ROUTE.provider,
            binary: worktreePath + "/fake",
            configRoot: worktreePath,
            workdir: worktreePath,
            limits: { timeoutMs: 1_000, outputBudgetBytes: 1_024, interruptGraceMs: 10, termGraceMs: 10 },
          },
        ],
      },
    },
  } as unknown as ScheduledWalk;
}

const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";
const TASK_C = "33333333-3333-4333-8333-333333333333";
const TASK_D = "44444444-4444-4444-8444-444444444444";
const TASK_E = "55555555-5555-4555-8555-555555555555";

const GRANTED: WalkLease = { ok: true, reason: "GRANTED", at: "walk.worktreePath" };
const HELD: WalkLease = {
  ok: false,
  reason: "LEASE_HELD_BY_ANOTHER",
  at: "request.candidate.worktreePath",
};

interface Recorder {
  readonly ports: SchedulerPorts;
  readonly acquired: string[];
  readonly ran: string[];
  readonly released: { taskId: string; cause: string }[];
}

function recorder(overrides: Partial<SchedulerPorts> = {}): Recorder {
  const acquired: string[] = [];
  const ran: string[] = [];
  const released: { taskId: string; cause: string }[] = [];
  const ports: SchedulerPorts = {
    acquire: (walk) => {
      acquired.push(walk.spec.taskId);
      return Promise.resolve(GRANTED);
    },
    run: (walk) => {
      ran.push(walk.spec.taskId);
      return Promise.resolve("CHECKPOINTED");
    },
    release: (walk, cause) => {
      released.push({ taskId: walk.spec.taskId, cause });
    },
    ...overrides,
  };
  return { ports, acquired, ran, released };
}

describe("both gates, in one order", () => {
  it("runs two disjoint walks", async () => {
    const walks = [walkOf(TASK_A, "/tmp/wt-a", ["a.ts"]), walkOf(TASK_B, "/tmp/wt-b", ["b.ts"])];
    const seen = recorder();
    const outcomes = await runScheduledWalks(walks, seen.ports);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    expect(seen.ran).toEqual([TASK_A, TASK_B]);
    expect(seen.released.map((entry) => entry.cause)).toEqual(["RELEASED", "RELEASED"]);
  });

  it("never touches the lease for a walk the graph refuses", async () => {
    // The packet's ordering claim, asserted by call count. A lease taken for a
    // walk that will never run claims a worktree nothing later frees.
    const walks = [walkOf(TASK_A, "/tmp/wt-a", ["shared.ts"]), walkOf(TASK_B, "/tmp/wt-b", ["shared.ts"])];
    const seen = recorder();
    const outcomes = await runScheduledWalks(walks, seen.ports);

    expect(outcomes[0]?.ok).toBe(true);
    const refused = outcomes[1];
    if (refused === undefined || refused.ok) throw new Error("expected the second walk to be refused");
    expect(refused.refusal).toBe("CONFLICT");
    expect(refused.reason).toContain("WRITE_WRITE");
    // Zero, not "not the second one": the arbiter was never reached at all.
    expect(seen.acquired).toEqual([TASK_A]);
    expect(seen.ran).toEqual([TASK_A]);
  });

  it("never runs a walk the lease refuses, after the graph admitted it", async () => {
    const walks = [walkOf(TASK_A, "/tmp/wt-a", ["a.ts"]), walkOf(TASK_B, "/tmp/wt-a", ["b.ts"])];
    const seen = recorder({
      acquire: (walk) => Promise.resolve(walk.spec.taskId === TASK_A ? GRANTED : HELD),
    });
    const outcomes = await runScheduledWalks(walks, seen.ports);

    const refused = outcomes[1];
    if (refused === undefined || refused.ok) throw new Error("expected a lease refusal");
    expect({ refusal: refused.refusal, reason: refused.reason, at: refused.at }).toEqual({
      refusal: "LEASE_REFUSED",
      reason: "LEASE_HELD_BY_ANOTHER",
      at: "request.candidate.worktreePath",
    });
    // The graph admitted it — disjoint write-sets — and the lease is what said no.
    expect(seen.ran).toEqual([TASK_A]);
  });

  it("refuses a duplicate task id on the verdict's own flag", async () => {
    // `compatible` is false whenever the admitted set carries a duplicate id,
    // whatever the candidate looks like. Reading the flag rather than inferring
    // from an empty `pairs` list is what makes that fail-closed case visible.
    const walks = [walkOf(TASK_A, "/tmp/wt-a", ["a.ts"]), walkOf(TASK_A, "/tmp/wt-b", ["b.ts"])];
    const seen = recorder();
    const outcomes = await runScheduledWalks(walks, seen.ports);
    const refused = outcomes[1];
    if (refused === undefined || refused.ok) throw new Error("expected a duplicate refusal");
    expect(refused.refusal).toBe("CONFLICT");
    expect(seen.acquired).toEqual([TASK_A]);
  });
});

describe("the walks actually overlap", () => {
  it("holds two walks in flight at once — proven by a barrier, not a clock", async () => {
    const walks = [walkOf(TASK_A, "/tmp/wt-a", ["a.ts"]), walkOf(TASK_B, "/tmp/wt-b", ["b.ts"])];

    // Each walk blocks until both have started. A sequential scheduler cannot
    // satisfy this: the first would wait forever for a second that has not been
    // started, and the test would time out rather than pass quietly.
    let arrived = 0;
    let openBarrier = (): void => undefined;
    const barrier = new Promise<void>((resolvePromise) => {
      openBarrier = (): void => {
        resolvePromise();
      };
    });
    let peak = 0;
    let inFlight = 0;

    const seen = recorder({
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        arrived += 1;
        if (arrived === walks.length) openBarrier();
        await barrier;
        inFlight -= 1;
        return "CHECKPOINTED";
      },
    });

    const outcomes = await runScheduledWalks(walks, seen.ports);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    expect(peak).toBe(2);
  });

  it("never exceeds the cap, and still finishes every walk", async () => {
    const walks = [
      walkOf(TASK_A, "/tmp/wt-a", ["a.ts"]),
      walkOf(TASK_B, "/tmp/wt-b", ["b.ts"]),
      walkOf(TASK_C, "/tmp/wt-c", ["c.ts"]),
      walkOf(TASK_D, "/tmp/wt-d", ["d.ts"]),
      walkOf(TASK_E, "/tmp/wt-e", ["e.ts"]),
    ];
    let inFlight = 0;
    let peak = 0;
    const seen = recorder({
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield so every worker has a chance to overlap before any completes.
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return "CHECKPOINTED";
      },
    });

    const admission = await admitWalks(walks, seen.ports);
    const outcomes = await runAdmitted(admission.admitted, seen.ports, 2);
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    // Waves, not a free-for-all.
    expect(peak).toBeLessThanOrEqual(2);
    expect(WALK_CONCURRENCY_MAX).toBeGreaterThan(1);
  });
});

describe("one walk's failure is one walk's outcome", () => {
  it("settles the failure, releases its lease, and lets the others finish", async () => {
    const walks = [
      walkOf(TASK_A, "/tmp/wt-a", ["a.ts"]),
      walkOf(TASK_B, "/tmp/wt-b", ["b.ts"]),
      walkOf(TASK_C, "/tmp/wt-c", ["c.ts"]),
    ];
    const seen = recorder({
      run: (walk) =>
        walk.spec.taskId === TASK_B
          ? Promise.reject(new Error("the provider died"))
          : Promise.resolve("CHECKPOINTED"),
    });
    const outcomes = await runScheduledWalks(walks, seen.ports);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, true]);
    const failed = outcomes[1];
    if (failed === undefined || failed.ok) throw new Error("expected a failure");
    expect(failed.refusal).toBe("FAILED");
    // The lease goes back even though the walk did not finish: a worktree held
    // by a dead walk is exactly the stall the lease exists to avoid.
    expect(seen.released.find((entry) => entry.taskId === TASK_B)?.cause).toBe("FAILED");
    expect(seen.released).toHaveLength(3);
  });

  it("returns every refusal and retries nothing", async () => {
    const walks = [walkOf(TASK_A, "/tmp/wt-a", ["shared.ts"]), walkOf(TASK_B, "/tmp/wt-b", ["shared.ts"])];
    const seen = recorder();
    const outcomes = await runScheduledWalks(walks, seen.ports);
    // One outcome per submitted walk, in submission order, and the refused walk
    // was attempted exactly once. A scheduler that quietly waits is one whose
    // refusals nobody sees.
    expect(outcomes.map((outcome) => outcome.taskId)).toEqual([TASK_A, TASK_B]);
    expect(seen.ran).toEqual([TASK_A]);
    expect(seen.acquired).toEqual([TASK_A]);
  });
});
