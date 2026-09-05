import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_VERSION, buildIdempotencyKey } from "@acp/contracts";
import type { Checkpoint, ResolvedRoute } from "@acp/contracts";
import { artifactRootFor, createCheckpointStore, hasArtifact, readArtifact, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation, OperationCoordinate, PostconditionVerdict } from "../../../src/contracts/index.js";
import { PostconditionUnknownError, SupervisorError } from "../../../src/errors/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
  applyEffect,
  probeEffect,
} from "../../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../../src/toy/repository/index.js";
import { operationForStep } from "../../../src/core/events/index.js";
import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  READ_ONLY_PLAN,
  planStep,
} from "../../../src/core/lifecycle/index.js";
import {
  appendPlanStep,
  applyIntentEffect,
  assertClaimedState,
  assertInvocationContinuity,
  closeIntent,
  currentState,
  nextStep,
} from "../../../src/core/step-executor/index.js";
import type { BeatContext, EffectPort } from "../../../src/core/step-executor/index.js";
import { deriveEventCoordinate, deterministicUuid } from "../../../src/core/coordinates/index.js";
import type {
  CheckpointPort,
  CheckpointRefused,
  CheckpointSource,
} from "../../../src/checkpoint/index.js";


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
 * Evidence for the shared beat executor.
 *
 * The load-bearing property is that the effect-bearing transition is THREE
 * separately callable operations, not one. A driver that must journal each
 * durable step individually cannot use a fused implementation, and the
 * crash-between-effect-and-outcome case -- the only case the three-beat law
 * exists for -- is unreachable if the append and the effect happen together.
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

/** A recording effect port, so the call sequence itself can be asserted. */
function recordingEffects(root: ScenarioRoot, log: string[]): EffectPort {
  return {
    apply: (operation: OperationCoordinate) => {
      log.push("EFFECT");
      applyEffect(root, operation);
      return Promise.resolve();
    },
    probe: (operation: OperationCoordinate): Promise<PostconditionVerdict> => {
      const verdict = probeEffect(root, operation);
      log.push("PROBE:" + verdict);
      return Promise.resolve(verdict);
    },
  };
}

// ---------------------------------------------------------------------------
// V2-B1f/F3: the checkpoint a terminal now has to write
// ---------------------------------------------------------------------------

/**
 * Make this scenario a real repository, and report what it actually holds.
 *
 * The four git facts a `Checkpoint` carries are observed, never invented: a
 * fabricated head would put a fiction in a drill ledger, which is the one thing
 * a drill may never do. The repository is created once per scenario and the
 * observation is taken at assembly time, so `isDirty` is what the worktree
 * looked like when the terminal ran rather than when the fixture was built.
 */
function checkpointFactsFor(worktree: string): {
  readonly worktreePath: string;
  readonly head: string;
  readonly branch: string;
  readonly isDirty: boolean;
} {
  const git = (...args: string[]): string =>
    spawnSync("/usr/bin/git", args, { cwd: worktree, encoding: "utf8" }).stdout;
  if (!existsSync(join(worktree, ".git"))) {
    git("init", "--quiet");
    git("config", "user.email", "drill@example.invalid");
    git("config", "user.name", "drill");
    git("commit", "--allow-empty", "-q", "-m", "checkpoint fixture");
  }
  return {
    worktreePath: worktree,
    head: git("rev-parse", "HEAD").trim(),
    branch: git("rev-parse", "--abbrev-ref", "HEAD").trim(),
    isDirty: git("status", "--porcelain", "--untracked-files=all").trim() !== "",
  };
}

/**
 * A checkpoint source for a suite that builds its construction directly.
 *
 * The twin of the production source in the daemon and of the two drill
 * children's, and declared here rather than imported for the reason
 * `initToyRepository` is declared in each suite that needs one: a test-tree
 * helper shared across packages would have to leave a pinned barrel, and the
 * barrel's names are pinned by equality.
 *
 * Every field still comes from something real: the coordinates this walk
 * derived, the `run.outcome` row it already appended, and a repository the
 * scenario really has. The digest arrays are `[]` because these fixtures carry
 * no envelope, which is the honest answer rather than a placeholder.
 */
function createDrillCheckpointSource(input: {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /** A repository this scenario really has. */
  readonly worktree: string;
}): CheckpointSource {
  const { ledger, invocation, worktree } = input;
  return {
    assemble(step): Checkpoint | CheckpointRefused {
      const recorded = ledger.getEventByIdempotencyKey(
        buildIdempotencyKey({
          taskId: invocation.taskId,
          attempt: invocation.attempt,
          transitionId: OUTCOME_STEP.transitionId,
        }),
      );
      if (recorded === null) {
        return { ok: false, reason: "CHECKPOINT_INVALID", at: "lastAtomicStep" };
      }
      const parsed: unknown = JSON.parse(recorded.canonicalJson);
      const completedAt =
        typeof parsed === "object" && parsed !== null && "occurredAt" in parsed
          ? (parsed as { readonly occurredAt: unknown }).occurredAt
          : undefined;
      if (typeof completedAt !== "string") {
        return { ok: false, reason: "CHECKPOINT_INVALID", at: "lastAtomicStep.completedAt" };
      }
      const facts = checkpointFactsFor(worktree);
      const coordinate = deriveEventCoordinate(invocation, step.transitionId, step.index);
      return {
        contractVersion: CONTRACT_VERSION,
        checkpointId: deterministicUuid(
          "checkpoint/" +
            invocation.invocationId +
            "/" +
            invocation.taskId +
            "/" +
            String(invocation.attempt) +
            "/" +
            step.transitionId,
        ),
        taskId: invocation.taskId,
        attempt: invocation.attempt,
        worker: input.emittedBy,
        createdAt: coordinate.occurredAt,
        lastAtomicStep: {
          index: OUTCOME_STEP.index,
          label: OUTCOME_STEP.transitionId,
          completedAt,
        },
        git: {
          head: facts.head,
          branch: facts.branch,
          worktreePath: facts.worktreePath,
          isDirty: facts.isDirty,
        },
        authorityDigest: [],
        readSetDigest: [],
        writeSetDigest: [],
        receipts: [],
        artifacts: [],
        pendingWork: [],
        // The §2.4 literal, quoted verbatim rather than imported: a drift in any
        // one of the sources that produce it fails here rather than propagating.
        nextSafeAction: "Await the next owner-authorized action.",
        notes: null,
      };
    },
  };
}

/** One source, one store, one root rule: the port a walking construction binds. */
function drillCheckpoints(input: {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /** Where the artifacts resolve: this scenario's own ledger path. */
  readonly ledgerPath: string;
  /** A repository this scenario really has. */
  readonly worktree: string;
}): CheckpointPort {
  return createCheckpointStore({
    ledgerPath: input.ledgerPath,
    source: createDrillCheckpointSource(input),
  });
}

function contextFor(name: string, taskId: string, log: string[]): {
  context: BeatContext;
  ledger: Ledger;
  root: ScenarioRoot;
  invocation: DurableInvocation;
} {
  const root = scenario(name);
  const invocation = invocationFor(taskId);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  return {
    context: {
      ledger,
      effects: recordingEffects(root, log),
      invocation,
      emittedBy: EMITTED_BY,
      plan: LIFECYCLE_PLAN,
      route: TEST_ROUTE,
      initiativeId: TEST_INITIATIVE_ID,
      checkpoints: drillCheckpoints({
        ledger,
        invocation,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
    },
    ledger,
    root,
    invocation,
  };
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

describe("the shared beat executor", () => {
  it("splits the effect-bearing transition into three separately callable beats", async () => {
    const log: string[] = [];
    const { context, ledger } = contextFor(
      "executor-three-beats",
      "10101010-1010-4101-8101-101010101011",
      log,
    );

    // Walk to the intent using only plain appends.
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index)) {
      appendPlanStep(context, step);
    }

    // BEAT 1: the intent append. On its own, journalable on its own.
    const intent = appendPlanStep(context, INTENT_STEP);
    expect(intent.inserted).toBe(true);
    expect(ledger.getTask(context.invocation.taskId)?.currentState).toBe("RUNNING");
    // Nothing has happened on disk yet, which is what makes beat 2 separable.
    expect(log).toEqual([]);

    // BEAT 2: the effect. A crash here is the case the whole law exists for.
    await applyIntentEffect(context, INTENT_STEP);
    expect(log).toEqual(["EFFECT"]);
    expect(ledger.getEventByIdempotencyKey(context.invocation.taskId + "/1/run.outcome")).toBeNull();

    // BEAT 3: the outcome, and only now.
    const outcome = await closeIntent(context);
    expect(outcome.inserted).toBe(true);
    expect(log).toEqual(["EFFECT", "PROBE:DONE"]);
    expect(
      ledger.getEventByIdempotencyKey(context.invocation.taskId + "/1/run.outcome"),
    ).not.toBeNull();
  });

  it("makes the crash between effect and outcome recoverable from beat three alone", async () => {
    const log: string[] = [];
    const { context, ledger, invocation } = contextFor(
      "executor-crash-window",
      "10101010-1010-4101-8101-101010101012",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    await applyIntentEffect(context, INTENT_STEP);

    // Simulate the restart: a fresh call to beat three, nothing else.
    log.length = 0;
    const closed = await closeIntent(context);
    expect(log).toEqual(["PROBE:DONE"]);
    expect(closed.inserted).toBe(true);
    expect(ledger.getEventByIdempotencyKey(invocation.taskId + "/1/run.outcome")).not.toBeNull();
  });

  it("performs the effect from beat three when the crash landed before it", async () => {
    const log: string[] = [];
    const { context } = contextFor(
      "executor-crash-before-effect",
      "10101010-1010-4101-8101-101010101013",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }

    const closed = await closeIntent(context);
    expect(log).toEqual(["PROBE:NOT_DONE", "EFFECT", "PROBE:DONE"]);
    expect(closed.inserted).toBe(true);
  });

  it("refuses to append an outcome the probe cannot vouch for", async () => {
    const log: string[] = [];
    const { context, ledger, invocation } = contextFor(
      "executor-unknown",
      "10101010-1010-4101-8101-101010101014",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }

    const unknown: BeatContext = {
      ...context,
      effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("UNKNOWN") },
    };
    await expect(closeIntent(unknown)).rejects.toThrow(PostconditionUnknownError);
    expect(ledger.getEventByIdempotencyKey(invocation.taskId + "/1/run.outcome")).toBeNull();
  });

  it("is idempotent: every beat replays without appending", async () => {
    const log: string[] = [];
    const { context, ledger } = contextFor(
      "executor-idempotent",
      "10101010-1010-4101-8101-101010101015",
      log,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    await applyIntentEffect(context, INTENT_STEP);
    await closeIntent(context);
    const head = ledger.status().headEventSha256;

    // The SDK documents a window where a durable step may be re-run. Every beat
    // must survive that, reporting a replay rather than raising a conflict.
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      expect(appendPlanStep(context, step).inserted).toBe(false);
    }
    await applyIntentEffect(context, INTENT_STEP);
    expect((await closeIntent(context)).inserted).toBe(false);
    expect(ledger.status().headEventSha256).toBe(head);
  });

  it("navigates the plan from ledger evidence, disambiguating RUNNING", async () => {
    const log: string[] = [];
    const { context } = contextFor(
      "executor-navigate",
      "10101010-1010-4101-8101-101010101016",
      log,
    );
    expect(currentState(context)).toBeNull();
    expect(nextStep(context, null)).toBe(planStep(0));

    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    // RUNNING with no outcome yet resolves to the outcome beat.
    expect(nextStep(context, "RUNNING")).toBe(OUTCOME_STEP);

    await applyIntentEffect(context, INTENT_STEP);
    await closeIntent(context);
    // RUNNING with the outcome present moves past it.
    expect(nextStep(context, "RUNNING").index).toBe(OUTCOME_STEP.index + 1);
  });

  it("carries the continuity and claim guards for every driver that uses it", () => {
    const log: string[] = [];
    const { context, invocation } = contextFor(
      "executor-guards",
      "10101010-1010-4101-8101-101010101017",
      log,
    );
    // No task yet: continuity has nothing to bind, the claim cannot be true.
    assertInvocationContinuity(context);
    expect(() => assertClaimedState(context, "DISCOVERED")).toThrow(SupervisorError);

    appendPlanStep(context, planStep(0));
    expect(assertClaimedState(context, "DISCOVERED")).toBe("DISCOVERED");
    expect(() => assertClaimedState(context, "RUNNING")).toThrow(SupervisorError);

    const foreign: BeatContext = {
      ...context,
      invocation: { ...invocation, submissionDigest: "b".repeat(64) },
    };
    expect(() => {
      assertInvocationContinuity(foreign);
    }).toThrow(SupervisorError);
  });

  it("addresses the same operation from the intent and the outcome beat", async () => {
    const log: string[] = [];
    const { context, invocation } = contextFor(
      "executor-same-operation",
      "10101010-1010-4101-8101-101010101018",
      log,
    );
    expect(operationForStep(invocation, INTENT_STEP).operationId).toBe(
      operationForStep(invocation, INTENT_STEP).operationId,
    );
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      appendPlanStep(context, step);
    }
    await applyIntentEffect(context, INTENT_STEP);
    await closeIntent(context);
    // One effect, addressed once, whichever beat asked for it.
    expect(log.filter((entry) => entry === "EFFECT")).toHaveLength(1);
  });
});

describe("the producer guard: a broken causal chain refuses before any append (C5)", () => {
  it("refuses a step whose predecessor was never appended, and appends nothing", () => {
    const { context, ledger, invocation } = contextFor("causal-missing", "20202020-2020-4202-8202-202020202021", []);

    // Step 0 lands, then step 2 is attempted — skipping step 1. The event that
    // step 2's causation names has therefore never been written, so the link
    // would point at nothing.
    appendPlanStep(context, planStep(0));
    const before = ledger.status().eventCount;

    expect(() => appendPlanStep(context, planStep(2))).toThrow(SupervisorError);

    // Before, not after: the refusal happens ahead of the append, so the ledger
    // never holds the event whose claim could not be corroborated.
    expect(ledger.status().eventCount).toBe(before);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe(planStep(0).toState);
  });

  it("refuses when the predecessor's coordinates hold a different event", () => {
    const { context, ledger } = contextFor("causal-forged", "20202020-2020-4202-8202-202020202022", []);
    appendPlanStep(context, planStep(0));

    // A forged chain: the predecessor's row exists, but it is some other
    // event. The guard compares identity, not mere presence, because a row
    // under the right key carrying the wrong event is the failure a presence
    // check would wave through.
    const forged: BeatContext = {
      ...context,
      ledger: {
        append: context.ledger.append.bind(context.ledger),
        getTask: context.ledger.getTask.bind(context.ledger),
        getEventBySequence: context.ledger.getEventBySequence.bind(context.ledger),
        getEventByIdempotencyKey: () => ({
          canonicalJson: JSON.stringify({ eventId: "00000000-0000-4000-8000-0000000000ff" }),
        }),
      },
    };
    const before = ledger.status().eventCount;

    expect(() => appendPlanStep(forged, planStep(1))).toThrow(SupervisorError);
    expect(ledger.status().eventCount).toBe(before);
  });

  it("lets a well-formed chain through, step after step", () => {
    const { context, ledger } = contextFor("causal-intact", "20202020-2020-4202-8202-202020202023", []);
    for (let index = 0; index < 3; index += 1) {
      const result = appendPlanStep(context, planStep(index));
      expect({ index, inserted: result.inserted }).toEqual({ index, inserted: true });
    }
    expect(ledger.status().eventCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// V2-B1f/F3 — the terminal appends only what it has already written
// ---------------------------------------------------------------------------

/** Walk every step up to, but not including, the terminal. */
function walkToTerminal(context: BeatContext): void {
  for (const step of context.plan.slice(0, -1)) {
    if (step.beat === "OUTCOME") continue;
    appendPlanStep(context, step);
    if (step.beat === "INTENT") appendPlanStep(context, OUTCOME_STEP);
  }
}

/** The plan's own terminal step, whichever plan is being walked. */
function terminalOf(plan: readonly { readonly eventType: string }[]): (typeof LIFECYCLE_PLAN)[number] {
  const step = plan[plan.length - 1] as (typeof LIFECYCLE_PLAN)[number] | undefined;
  if (step === undefined) throw new Error("the plan has no terminal step");
  return step;
}

describe("P3: the terminal appends only after a successful persist, digest in the payload", () => {
  it("writes the checkpoint first, then names the store's own digest", () => {
    const { context, ledger, root, invocation } = contextFor(
      "f3-p3-order",
      "30303030-3030-4030-8030-303030303001",
      [],
    );
    walkToTerminal(context);

    const before = ledger.status().eventCount;
    const result = appendPlanStep(context, terminalOf(context.plan));
    expect(result.inserted).toBe(true);
    expect(ledger.status().eventCount).toBe(before + 1);

    const digest = result.event?.payload["checkpointDigest"];
    expect(typeof digest).toBe("string");
    if (typeof digest !== "string") return;

    // The store holds the digest the event names. That is the whole packet:
    // before F3 the event was appended and nothing was ever written.
    expect(hasArtifact(artifactRootFor(scenarioLedgerPath(root)), digest)).toBe(true);

    // And what it holds re-parses as this walk's own checkpoint.
    const read = readArtifact(artifactRootFor(scenarioLedgerPath(root)), digest);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const stored = JSON.parse(read.content) as Checkpoint;
    expect({ taskId: stored.taskId, attempt: stored.attempt, worker: stored.worker }).toEqual({
      taskId: invocation.taskId,
      attempt: invocation.attempt,
      worker: EMITTED_BY,
    });
  });
});

describe("P4: both plans terminate through the same guard", () => {
  for (const [label, slug, plan] of [
    ["LIFECYCLE_PLAN", "writer", LIFECYCLE_PLAN],
    ["READ_ONLY_PLAN", "read-only", READ_ONLY_PLAN],
  ] as const) {
    it("persists a checkpoint at " + label + "'s closing step", () => {
      const { context, ledger, root } = contextFor(
        "f3-p4-" + slug,
        label === "LIFECYCLE_PLAN"
          ? "30303030-3030-4030-8030-303030303002"
          : "30303030-3030-4030-8030-303030303003",
        [],
      );
      // The plan is the context's, so the read-only walk really walks the
      // read-only plan rather than a prefix of the writer's.
      const walking: BeatContext = { ...context, plan };
      walkToTerminal(walking);

      const result = appendPlanStep(walking, terminalOf(plan));
      const digest = result.event?.payload["checkpointDigest"];
      expect({ plan: label, terminal: result.event?.type, hasDigest: typeof digest === "string" }).toEqual({
        plan: label,
        terminal: "CHECKPOINT_WRITTEN",
        hasDigest: true,
      });
      expect(ledger.getTask(walking.invocation.taskId)?.currentState).toBe("CHECKPOINTED");
      if (typeof digest !== "string") return;
      expect(hasArtifact(artifactRootFor(scenarioLedgerPath(root)), digest)).toBe(true);
    });
  }
});

describe("N5: a replayed terminal appends once and publishes once", () => {
  it("returns inserted:false the second time, with the head unmoved", () => {
    const { context, ledger, root } = contextFor(
      "f3-n5-replay",
      "30303030-3030-4030-8030-303030303004",
      [],
    );
    walkToTerminal(context);

    const first = appendPlanStep(context, terminalOf(context.plan));
    expect(first.inserted).toBe(true);
    const head = ledger.status().headEventSha256;
    const count = ledger.status().eventCount;

    // The same walk again. Determinism is what makes this safe: identical
    // bytes publish to the same digest with `written:false`, so the rebuilt
    // event is byte-identical and the ledger reads it as an exact replay.
    const second = appendPlanStep(context, terminalOf(context.plan));
    expect(second.inserted).toBe(false);
    expect(ledger.status().eventCount).toBe(count);
    expect(ledger.status().headEventSha256).toBe(head);

    const digest = first.event?.payload["checkpointDigest"];
    if (typeof digest !== "string") return;
    expect(hasArtifact(artifactRootFor(scenarioLedgerPath(root)), digest)).toBe(true);
  });
});

describe("N6/N9: no CHECKPOINT_WRITTEN is reachable without a persisted artifact", () => {
  it("an absent member refuses, the head does not move, and the task is not CHECKPOINTED", () => {
    const { context, ledger } = contextFor(
      "f3-n6-absent",
      "30303030-3030-4030-8030-303030303005",
      [],
    );
    walkToTerminal(context);
    const portless: BeatContext = { ...context, checkpoints: undefined };

    const before = ledger.status();
    expect(() => appendPlanStep(portless, terminalOf(context.plan))).toThrow(SupervisorError);
    // Nothing at all: not an event, not a state change.
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
    expect(ledger.getTask(context.invocation.taskId)?.currentState).not.toBe("CHECKPOINTED");
  });

  it("a refusing persist refuses too, with the same zero delta", () => {
    const { context, ledger, root } = contextFor(
      "f3-n6-refusing",
      "30303030-3030-4030-8030-303030303006",
      [],
    );
    walkToTerminal(context);

    const refusal: CheckpointRefused = { ok: false, reason: "GIT_UNOBSERVABLE", at: "worktree" };
    const refusing: BeatContext = {
      ...context,
      checkpoints: {
        persist: () => refusal,
        read: () => refusal,
      },
    };

    const before = ledger.status();
    let message = "";
    try {
      appendPlanStep(refusing, terminalOf(context.plan));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : "";
    }
    // The refusal is reported by its own reason, so an operator reading the
    // failure learns which fact was missing rather than only that one was.
    expect(message).toContain("GIT_UNOBSERVABLE");
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
    expect(ledger.getTask(context.invocation.taskId)?.currentState).not.toBe("CHECKPOINTED");
    // Publishing never happened either: nothing was written under this ledger.
    expect(existsSync(artifactRootFor(scenarioLedgerPath(root)))).toBe(false);
  });
});

describe("N10: no checkpoint content reaches an event payload", () => {
  it("the terminal payload carries a digest and the plan's own fields, nothing more", () => {
    const { context } = contextFor("f3-n10", "30303030-3030-4030-8030-303030303007", []);
    walkToTerminal(context);
    const result = appendPlanStep(context, terminalOf(context.plan));

    const payload = result.event?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual([
      "beat",
      "checkpointDigest",
      "planIndex",
      "submissionDigest",
    ]);
    // Every value is a coordinate or a digest: no path, no branch name, no
    // worktree, nothing a checkpoint carries as content.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("worktreePath");
    expect(serialized).not.toContain("nextSafeAction");
    expect(serialized).not.toContain("Await the next owner-authorized action.");
  });
});
