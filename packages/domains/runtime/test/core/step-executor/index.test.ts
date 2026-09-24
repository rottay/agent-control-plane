import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_VERSION, ControlPlaneEvent, buildIdempotencyKey, buildV2IdempotencyKey } from "@acp/contracts";
import type { Checkpoint, ResolvedRoute } from "@acp/contracts";
import {
  LedgerIdempotencyConflictError,
  LedgerValidationError,
  artifactRootFor,
  canonicalJsonStringify,
  createCheckpointStore,
  effectIdV1,
  effectIdempotencyKeyV1,
  hasArtifact,
  logicalOperationSha256,
  readArtifact,
  openLedger,
  requestSha256,
  sha256Hex,
} from "@acp/ledger";
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
import {
  ATTEMPT_OPENING_STEP,
  INTAKE_ATTEMPT_OPENING_STEP,
  buildDispatchIntentionEvent,
  buildDispatchTransitionEvent,
  buildEffectIntentionEvent,
  buildEvent,
  operationForStep,
} from "../../../src/core/events/index.js";
import type { DispatchTransition, ExecutionSegmentRecord } from "../../../src/core/events/index.js";
import { SqliteSupervisor } from "../../../src/drivers/sqlite-supervisor/index.js";
import { deriveInvocation } from "../../../src/submission/index.js";
import { settleFailure } from "../../../src/failure/index.js";
import { restateInvocation } from "../../../src/lifecycle-operation/index.js";
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
      // Keyed by the walk's own derivation, so a revision-bearing walk finds
      // its outcome under the V2 key and a V1 walk under exactly the key it
      // always did (P-18/protocolo G).
      const recorded = ledger.getEventByIdempotencyKey(
        deriveEventCoordinate(invocation, OUTCOME_STEP.transitionId, OUTCOME_STEP.index).idempotencyKey,
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

// ---------------------------------------------------------------------------
// P-18/protocolo G — the producer speaks the V2 coordinate (ADR 0080)
// ---------------------------------------------------------------------------

const SUBMITTED_AT = "2026-08-27T12:00:00.000Z";

/**
 * The `TASK_ENVELOPE` reference a G fixture's revision names (P-36/local D).
 *
 * One per task: the ledger's door asks only that the reference be registered
 * with that class (decision 41, ADR 0084), and the runtime carries it without
 * minting it.
 */
function envelopeReferenceFor(taskId: string): string {
  return "ref-envelope-" + taskId;
}

/** The revision every G fixture runs under unless it says otherwise. */
function revisionFor(taskId: string, revisionNumber = 1): NonNullable<DurableInvocation["revision"]> {
  return {
    revisionId: deterministicUuid("revision/" + taskId + "/" + String(revisionNumber)),
    revisionNumber,
    attemptNumber: 1,
    envelopeSha256: "e".repeat(64),
    envelopeArtifactReferenceId: envelopeReferenceFor(taskId),
  };
}

/**
 * Register the task's envelope reference in the ledger, as a fixture.
 *
 * Not a publication by the runtime — publishing an envelope's bytes is
 * adoption's (ADR 0084). Two artifact events through the ledger's own artifact
 * door, over bytes no other fixture names, so the opening the walk builds
 * finds the reference its version requires.
 */
function plantEnvelopeReference(ledger: Ledger, taskId: string): void {
  const reference = envelopeReferenceFor(taskId);
  if (ledger.getArtifactReference(reference) !== null) return;
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
    occurredAt: SUBMITTED_AT,
    recordedAt: SUBMITTED_AT,
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
}

/** A revision-bearing invocation, derived by the submission path's own producer. */
function v2InvocationFor(taskId: string, attempt = 1, revisionNumber = 1): DurableInvocation {
  return deriveInvocation(taskId, attempt, SUBMITTED_AT, "a".repeat(64), revisionFor(taskId, revisionNumber));
}

/** A beat context over a revision-bearing invocation, on a fresh scenario ledger. */
function v2ContextFor(name: string, taskId: string): {
  context: BeatContext;
  ledger: Ledger;
  root: ScenarioRoot;
  invocation: DurableInvocation;
} {
  const base = contextFor(name, taskId, []);
  plantEnvelopeReference(base.ledger, taskId);
  const invocation = v2InvocationFor(taskId);
  return {
    ...base,
    invocation,
    context: {
      ...base.context,
      invocation,
      checkpoints: drillCheckpoints({
        ledger: base.ledger,
        invocation,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(base.root),
        worktree: base.root,
      }),
    },
  };
}

/** Walk the real navigation until the task stands in `state`. */
function walkUntil(context: BeatContext, state: string): void {
  for (let guard = 0; guard <= context.plan.length + 1; guard += 1) {
    const current = currentState(context);
    if (current === state) return;
    appendPlanStep(context, nextStep(context, current));
  }
  throw new Error("the walk did not reach " + state);
}

/** The error an action raises, or null. */
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  return null;
}

describe("P-G-1: the real walk speaks the V2 coordinate end to end", () => {
  it("runs a revision-bearing invocation to CHECKPOINTED through the supervisor, opening first", async () => {
    const taskId = "40404040-4040-4040-8040-404040404001";
    const root = scenario("p18g-walk");
    const ledgerPath = scenarioLedgerPath(root);
    const ledger = openLedger(ledgerPath);
    ledgers.push(ledger);
    plantEnvelopeReference(ledger, taskId);
    const invocation = v2InvocationFor(taskId);

    const supervisor = new SqliteSupervisor({
      ledger,
      invocation,
      effects: recordingEffects(root, []),
      checkpoints: drillCheckpoints({ ledger, invocation, emittedBy: EMITTED_BY, ledgerPath, worktree: root }),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    });
    const run = await supervisor.runToCheckpoint();

    // One more append than a V1 walk: the opening, and nothing else.
    expect(run).toEqual({ finalState: "CHECKPOINTED", appended: LIFECYCLE_PLAN.length + 1, replayed: 0 });

    const events = ledger.listEvents({ taskId }).events;
    expect(events.map((entry) => entry.event.transitionId)).toEqual([
      ATTEMPT_OPENING_STEP.transitionId,
      ...LIFECYCLE_PLAN.map((step) => step.transitionId),
    ]);
    // The task's first event is the opening, which is what continuity rebuilds.
    expect(ledger.getTask(taskId)?.firstSequence).toBe(events[0]?.sequence);

    // Every event keys V2 through the imported composer and repeats the flat
    // assignment the opening received; no V1 key exists for this task at all.
    for (const entry of events) {
      expect(entry.idempotencyKey).toBe(
        buildV2IdempotencyKey({
          stream: "control_plane_events",
          taskId,
          revisionNumber: 1,
          attemptNumber: 1,
          transitionId: entry.event.transitionId,
        }),
      );
      expect(entry.event.attempt).toBe(1);
      expect(
        ledger.getEventByIdempotencyKey(
          buildIdempotencyKey({ taskId, attempt: 1, transitionId: entry.event.transitionId }),
        ),
      ).toBeNull();
    }

    const task = ledger.getTask(taskId);
    expect({
      currentState: task?.currentState,
      latestAttempt: task?.latestAttempt,
      latestRevisionNumber: task?.latestRevisionNumber,
      latestAttemptNumber: task?.latestAttemptNumber,
      initiativeId: task?.initiativeId,
    }).toEqual({
      currentState: "CHECKPOINTED",
      latestAttempt: 1,
      latestRevisionNumber: 1,
      latestAttemptNumber: 1,
      initiativeId: TEST_INITIATIVE_ID,
    });
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // Resuming the finished walk is a no-op: continuity rebuilds the opening
    // and the discovery byte for byte.
    expect(() => { assertInvocationContinuity(supervisorlessContext(ledger, root, invocation)); }).not.toThrow();
  });

  it("fits the read-only plan's V2 walk inside the supervisor's own bound", async () => {
    // The loop allows `plan.length + 2` iterations. A V2 walk spends
    // `plan.length + 1` appends and one terminal check, so the bound is met
    // exactly; the shorter plan is the one where an off-by-one would show.
    const taskId = "40404040-4040-4040-8040-404040404011";
    const root = scenario("p18g-walk-read-only");
    const ledgerPath = scenarioLedgerPath(root);
    const ledger = openLedger(ledgerPath);
    ledgers.push(ledger);
    plantEnvelopeReference(ledger, taskId);
    const invocation = v2InvocationFor(taskId);
    const supervisor = new SqliteSupervisor({
      ledger,
      invocation,
      effects: recordingEffects(root, []),
      checkpoints: drillCheckpoints({ ledger, invocation, emittedBy: EMITTED_BY, ledgerPath, worktree: root }),
      emittedBy: EMITTED_BY,
      commitPolicy: "NO_COMMIT",
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    });
    expect(await supervisor.runToCheckpoint()).toEqual({
      finalState: "CHECKPOINTED",
      appended: READ_ONLY_PLAN.length + 1,
      replayed: 0,
    });
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("navigates opening, then discovery, then the plan, from ledger evidence alone", () => {
    const { context } = v2ContextFor("p18g-navigate", "40404040-4040-4040-8040-404040404002");
    expect(nextStep(context, null)).toBe(ATTEMPT_OPENING_STEP);
    appendPlanStep(context, ATTEMPT_OPENING_STEP);
    // DISCOVERED without the discovery: the plan's own step 0, not a copy.
    expect(nextStep(context, "DISCOVERED")).toBe(planStep(0));
    appendPlanStep(context, planStep(0));
    expect(nextStep(context, "DISCOVERED")).toBe(planStep(1));
  });

  it("P-15/D1: a task DISCOVERED with no opening under its key is intake-first — the opening comes first, out of DISCOVERED", () => {
    const { context } = v2ContextFor("p15d1-navigate", "40404040-4040-4040-8040-404040404012");
    // The ledger holds no event of this task, so `DISCOVERED` here stands for the
    // state an intake leaves: the opening is absent under its V2 key.
    expect(nextStep(context, "DISCOVERED")).toBe(INTAKE_ATTEMPT_OPENING_STEP);
    // An opening-first task is never read this way: once the opening is there, the
    // discovery follows, as before.
    appendPlanStep(context, ATTEMPT_OPENING_STEP);
    expect(nextStep(context, "DISCOVERED")).toBe(planStep(0));
    // A V1 walk never enters the revision branch at all.
    expect(nextStep({ ...context, invocation: invocationFor("40404040-4040-4040-8040-404040404012") }, "DISCOVERED")).toBe(planStep(1));
  });
});

/** A context over an existing ledger, for the guards that need no supervisor. */
function supervisorlessContext(ledger: Ledger, root: ScenarioRoot, invocation: DurableInvocation): BeatContext {
  return {
    ledger,
    effects: recordingEffects(root, []),
    invocation,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    route: TEST_ROUTE,
    initiativeId: TEST_INITIATIVE_ID,
  };
}

describe("N-G-3: nothing of a coordinate reaches the ledger before its opening", () => {
  it("refuses the discovery, a plain step and the INTENT of an unopened attempt, with zero delta", () => {
    const { context, ledger } = v2ContextFor("p18g-n3", "40404040-4040-4040-8040-404040404003");
    for (const step of [planStep(0), planStep(1), INTENT_STEP]) {
      const refusal = caught(() => appendPlanStep(context, step));
      expect({ step: step.transitionId, refused: refusal instanceof SupervisorError }).toEqual({
        step: step.transitionId,
        refused: true,
      });
      expect((refusal as Error).message).toContain("has not been opened");
    }
    expect(ledger.status().eventCount).toBe(0);
  });

  it("refuses when the row under the opening's key is not this invocation's opening", () => {
    const { context, ledger } = v2ContextFor("p18g-n3-forged", "40404040-4040-4040-8040-404040404004");
    appendPlanStep(context, ATTEMPT_OPENING_STEP);
    const forged: BeatContext = {
      ...context,
      ledger: {
        append: context.ledger.append.bind(context.ledger),
        getTask: context.ledger.getTask.bind(context.ledger),
        getEventBySequence: context.ledger.getEventBySequence.bind(context.ledger),
        getEventByIdempotencyKey: () => ({
          canonicalJson: JSON.stringify({ eventId: "00000000-0000-4000-8000-0000000000fe" }),
        }),
      },
    };
    const before = ledger.status().eventCount;
    expect(() => appendPlanStep(forged, planStep(0))).toThrow(SupervisorError);
    expect(ledger.status().eventCount).toBe(before);
  });
});

describe("N-G-4: an opening replays exactly", () => {
  it("returns inserted:false with the head, the task and the attempt unmoved", () => {
    const { context, ledger, invocation } = v2ContextFor("p18g-n4", "40404040-4040-4040-8040-404040404005");
    const first = appendPlanStep(context, ATTEMPT_OPENING_STEP);
    expect(first.inserted).toBe(true);
    const head = ledger.status().headEventSha256;
    const task = ledger.getTask(invocation.taskId);

    // The arithmetic the opening moved (latestAttempt is now 1) is not asked
    // again: a recorded opening is a replay, and the ledger compares its bytes.
    const replay = appendPlanStep(context, ATTEMPT_OPENING_STEP);
    expect(replay.inserted).toBe(false);
    expect(ledger.status().headEventSha256).toBe(head);
    expect(ledger.getTask(invocation.taskId)).toEqual(task);
    const recorded = ledger.getEventByIdempotencyKey(first.event?.idempotencyKey ?? "");
    const payload = (JSON.parse(recorded?.canonicalJson ?? "{}") as { payload: Record<string, unknown> }).payload;
    expect({ legacyAttemptNumber: payload["legacyAttemptNumber"], invocationId: payload["invocationId"] }).toEqual({
      legacyAttemptNumber: 1,
      invocationId: invocation.invocationId,
    });
  });
});

describe("N-G-5: the flat attempt is proposed, verified, and refused by name", () => {
  it("the producer refuses an opening the ledger would assign differently, before the append", () => {
    const taskId = "40404040-4040-4040-8040-404040404006";
    const { context, ledger } = v2ContextFor("p18g-n5-producer", taskId);
    const wrong: BeatContext = { ...context, invocation: v2InvocationFor(taskId, 2) };
    const refusal = caught(() => appendPlanStep(wrong, ATTEMPT_OPENING_STEP));
    expect(refusal).toBeInstanceOf(SupervisorError);
    expect((refusal as Error).message).toContain("would assign it the flat attempt 1");
    expect(ledger.status().eventCount).toBe(0);
  });

  it("the ledger refuses the same proposal by name when a producer skips its own check", () => {
    // A port that hides the task, so the producer's arithmetic agrees with a
    // wrong proposal and the append reaches the door. The door is the authority
    // and says so in its own words; the walk appends nothing more.
    const taskId = "40404040-4040-4040-8040-404040404007";
    const { context, ledger } = v2ContextFor("p18g-n5-door", taskId);
    appendPlanStep(context, ATTEMPT_OPENING_STEP);
    const second = v2InvocationFor(taskId, 3, 2);
    const blind: BeatContext = {
      ...context,
      invocation: second,
      ledger: {
        append: context.ledger.append.bind(context.ledger),
        getTask: () => ({ currentState: "DISCOVERED", latestAttempt: 2, firstSequence: 1 }),
        getEventBySequence: context.ledger.getEventBySequence.bind(context.ledger),
        getEventByIdempotencyKey: context.ledger.getEventByIdempotencyKey.bind(context.ledger),
      },
    };
    const before = ledger.status();
    const refusal = caught(() => appendPlanStep(blind, { ...ATTEMPT_OPENING_STEP, fromState: "DISCOVERED" }));
    expect(refusal).toBeInstanceOf(LedgerValidationError);
    const issue = (refusal as LedgerValidationError).issues[0];
    expect(issue?.path).toBe("attempt");
    expect(issue?.message).toContain("is assigned the flat attempt 2");
    expect(issue?.message).toContain("this event proposes 3");
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
  });

  it("a second invocation for an open coordinate is refused, with zero delta", () => {
    const taskId = "40404040-4040-4040-8040-404040404008";
    const { context, ledger, invocation } = v2ContextFor("p18g-n5-invocation", taskId);
    appendPlanStep(context, ATTEMPT_OPENING_STEP);
    const before = ledger.status();

    // The same coordinate, the same flat attempt, another invocation.
    const intruder: DurableInvocation = { ...invocation, invocationId: deterministicUuid("intruder/" + taskId) };
    const opening = buildEvent({
      invocation: intruder,
      step: ATTEMPT_OPENING_STEP,
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
      route: TEST_ROUTE,
    });
    expect(opening.idempotencyKey).toBe(
      ledger.listEvents({ taskId }).events[0]?.idempotencyKey,
    );
    // Under the same key the ledger's idempotency refuses first: same key,
    // different bytes.
    expect(caught(() => ledger.append(opening))).toBeInstanceOf(LedgerIdempotencyConflictError);

    // Under another transition of the same coordinate the key differs, and the
    // attempt's own identity refuses the second invocation by name.
    const reopening = buildEvent({
      invocation: intruder,
      step: { ...ATTEMPT_OPENING_STEP, transitionId: "attempt.reopened", fromState: "DISCOVERED" },
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
      route: TEST_ROUTE,
    });
    const issue = (caught(() => ledger.append(reopening)) as LedgerValidationError).issues[0];
    expect(issue?.path).toBe("payload.invocationId");
    expect(issue?.message).toContain("is already open under invocation");

    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
  });
});

describe("N-G-6: a second revision of the same task is a second coordinate", () => {
  it("opens revision 2 attempt 1 beside revision 1 attempt 1, with flat assignments 1 and 2", () => {
    const taskId = "40404040-4040-4040-8040-404040404009";
    const { context, ledger } = v2ContextFor("p18g-n6", taskId);
    const first = appendPlanStep(context, ATTEMPT_OPENING_STEP);

    // The walk refuses a second attempt on an existing task (continuity), so
    // the second opening is exercised at the beat, out of the state the first
    // left.
    const later: BeatContext = { ...context, invocation: v2InvocationFor(taskId, 2, 2) };
    expect(() => { assertInvocationContinuity(later); }).toThrow(SupervisorError);
    const second = appendPlanStep(later, { ...ATTEMPT_OPENING_STEP, fromState: "DISCOVERED" });
    expect(second.inserted).toBe(true);

    expect(first.event?.idempotencyKey).not.toBe(second.event?.idempotencyKey);
    expect([first.event?.payload["legacyAttemptNumber"], second.event?.payload["legacyAttemptNumber"]]).toEqual([1, 2]);
    expect(first.event?.payload["invocationId"]).not.toBe(second.event?.payload["invocationId"]);
    expect(
      ledger.getEventByIdempotencyKey(
        buildIdempotencyKey({ taskId, attempt: 1, transitionId: ATTEMPT_OPENING_STEP.transitionId }),
      ),
    ).toBeNull();
    const task = ledger.getTask(taskId);
    expect({ latestAttempt: task?.latestAttempt, revision: task?.latestRevisionNumber, attempt: task?.latestAttemptNumber }).toEqual({
      latestAttempt: 2,
      revision: 2,
      attempt: 1,
    });
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});

describe("N-G-8: the V2 chain resolves its predecessors under the V2 key", () => {
  it("refuses a skipped step before the append, exactly as a V1 walk does", () => {
    const { context, ledger } = v2ContextFor("p18g-n8", "40404040-4040-4040-8040-40404040400a");
    appendPlanStep(context, ATTEMPT_OPENING_STEP);
    appendPlanStep(context, planStep(0));
    expect(appendPlanStep(context, planStep(1)).inserted).toBe(true);
    const before = ledger.status().eventCount;
    const refusal = caught(() => appendPlanStep(context, planStep(3)));
    expect(refusal).toBeInstanceOf(SupervisorError);
    expect((refusal as Error).message).toContain("its causal predecessor ready is not in the ledger");
    expect(ledger.status().eventCount).toBe(before);
  });
});

describe("V2 continuity binds the revision at the opening and the submission at the discovery", () => {
  it("refuses a resume under another revision, another submission, or over a V1 history", () => {
    const taskId = "40404040-4040-4040-8040-40404040400b";
    const { context } = v2ContextFor("p18g-continuity", taskId);
    appendPlanStep(context, ATTEMPT_OPENING_STEP);

    // Past the opening only: another revision identity is refused already.
    const otherRevision: BeatContext = {
      ...context,
      invocation: { ...context.invocation, revision: { ...revisionFor(taskId), revisionId: deterministicUuid("elsewhere") } },
    };
    expect(() => { assertInvocationContinuity(otherRevision); }).toThrow(SupervisorError);

    // Past the discovery: another submission is refused too.
    appendPlanStep(context, planStep(0));
    const otherSubmission: BeatContext = {
      ...context,
      invocation: { ...context.invocation, submissionDigest: "b".repeat(64) },
    };
    const refusal = caught(() => { assertInvocationContinuity(otherSubmission); });
    expect(refusal).toBeInstanceOf(SupervisorError);
    expect((refusal as Error).message).toContain("discovered under a different submission");
    expect(() => { assertInvocationContinuity(context); }).not.toThrow();

    // A V1 history is never resumed by a V2 invocation: its first event is a
    // discovery, not an opening.
    const legacyTask = "40404040-4040-4040-8040-40404040400c";
    const legacy = contextFor("p18g-continuity-legacy", legacyTask, []);
    appendPlanStep(legacy.context, planStep(0));
    const upgraded: BeatContext = {
      ...legacy.context,
      invocation: { ...legacy.invocation, revision: revisionFor(legacyTask) },
    };
    expect(() => { assertInvocationContinuity(upgraded); }).toThrow(SupervisorError);
  });
});

// ---------------------------------------------------------------------------
// N-G-10 — ack, handoff, replay, on the coordinate the real walk opened
// ---------------------------------------------------------------------------

const EFFECT_AT = "2026-08-27T12:05:00.000Z";
const SCOPE = "run";
const STEP_KEY = "compose-answer";
const NEUTRAL_REQUEST = { operation: "compose", inputs: ["a", "b"] };

/** One segment record, in the nested shape the ledger's door reads. */
function segmentRecord(segmentNumber: number, accountId: string): Record<string, unknown> {
  return {
    routeSegmentId: "seg-" + String(segmentNumber),
    segmentNumber,
    ...(segmentNumber === 1 ? {} : { predecessorSegmentId: "seg-" + String(segmentNumber - 1), handoffReason: "QUOTA_EXHAUSTED" }),
    provider: "anthropic",
    model: "claude-opus-5",
    modelResolutionStatus: "RESOLVED",
    modelVersionId: "claude-opus-5-20260101",
    accountId,
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "policy-1",
  };
}

/**
 * An execution event on the walk's own coordinate.
 *
 * No producer of effects, deliveries or occurrences ships in G — ADR 0080
 * reassigns them by name — so these are appended through the ledger's real
 * door, as C's drills are. What is NOT fabricated is the coordinate: the task,
 * the revision, the attempt, the flat assignment, the invocation, the key and
 * the state all come from the invocation the walk ran and from the ledger it
 * wrote.
 */
function executionEvent(
  context: BeatContext,
  transitionId: string,
  type: "EFFECT_INTENDED" | "DISPATCH_INTENDED" | "DISPATCH_OUTCOME_RECORDED",
  record: Record<string, unknown>,
): Record<string, unknown> {
  const { invocation } = context;
  const revision = invocation.revision;
  if (revision === undefined) throw new Error("an execution event needs the walk's revision");
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  const state = currentState(context);
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type,
    fromState: state,
    toState: state,
    emittedBy: EMITTED_BY,
    occurredAt: EFFECT_AT,
    recordedAt: EFFECT_AT,
    correlationId: invocation.invocationId,
    causationId: null,
    payload: { revisionNumber: revision.revisionNumber, attemptNumber: revision.attemptNumber, ...record },
  };
}

function effectCoordinate(context: BeatContext, segmentNumber: number, operationOrdinal: number): {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  readonly segmentNumber: number;
  readonly operationOrdinal: number;
} {
  const revision = context.invocation.revision;
  if (revision === undefined) throw new Error("no revision");
  return {
    taskId: context.invocation.taskId,
    revisionNumber: revision.revisionNumber,
    attemptNumber: revision.attemptNumber,
    segmentNumber,
    operationOrdinal,
  };
}

function requestDigest(context: BeatContext): string {
  return requestSha256({
    effectKind: "model_execution",
    requestContractVersion: "1",
    envelopeSha256: context.invocation.revision?.envelopeSha256 ?? "",
    neutralRequest: NEUTRAL_REQUEST,
  });
}

function effectIntention(context: BeatContext, transitionId: string, segmentNumber: number, operationOrdinal: number, accountId: string): Record<string, unknown> {
  const coordinate = effectCoordinate(context, segmentNumber, operationOrdinal);
  return executionEvent(context, transitionId, "EFFECT_INTENDED", {
    segment: segmentRecord(segmentNumber, accountId),
    effect: {
      effectId: effectIdV1(coordinate),
      operationOrdinal,
      effectKind: "model_execution",
      semanticScopeKey: SCOPE,
      localOperationKey: STEP_KEY,
      // Over the walk's own invocation: the door recomputes it from the
      // attempt row the walk's opening wrote.
      logicalOperationSha256: logicalOperationSha256({
        invocationId: context.invocation.invocationId,
        semanticScopeKey: SCOPE,
        localOperationKey: STEP_KEY,
      }),
      requestContractVersion: "1",
      requestSha256: requestDigest(context),
      idempotencyKey: effectIdempotencyKeyV1({
        ...coordinate,
        effectKind: "model_execution",
        envelopeSha256: context.invocation.revision?.envelopeSha256 ?? "",
      }),
    },
  });
}

function dispatchIntention(context: BeatContext, transitionId: string, effectId: string, attemptOrdinal: number, segmentNumber: number, accountId: string): Record<string, unknown> {
  return executionEvent(context, transitionId, "DISPATCH_INTENDED", {
    segment: segmentRecord(segmentNumber, accountId),
    dispatch: { dispatchAttemptId: "dsp-" + String(attemptOrdinal), effectId, attemptOrdinal, ...FIXTURE_PIN },
  });
}

function dispatchOutcome(context: BeatContext, transitionId: string, dispatchAttemptId: string, outcome: Record<string, unknown>): Record<string, unknown> {
  return executionEvent(context, transitionId, "DISPATCH_OUTCOME_RECORDED", {
    outcome: { dispatchAttemptId, ...outcome },
  });
}

/**
 * The fixture price catalog a delivery is pinned to (P-15 escalón C, ADR 0103).
 *
 * From 2.9.0 a `DISPATCH_INTENDED` names the catalog version in force at its
 * instant, and one that covers its segment, or the door refuses it: pre-2.9.0
 * fixtures had to gain a pin because the version in force now requires one. So the
 * fixture publishes one through the registry's own door — the segment's model
 * version registered under its provider, then version 1 of a `PRICE_TABLE` pricing
 * that model on the segment's transport from before any fixture instant, with no
 * end. The price is fixture data, and never zero.
 */
const FIXTURE_CATALOG = "catalog-fixture";
const FIXTURE_MODEL_VERSION = "claude-opus-5-20260101";
const FIXTURE_CATALOG_FROM = "2026-01-01T00:00:00.000Z";
const FIXTURE_PIN = { catalogDocumentId: FIXTURE_CATALOG, catalogVersion: 1 } as const;

function plantFixtureCatalog(ledger: Ledger): void {
  if (ledger.getVigentCatalogPin(FIXTURE_CATALOG, FIXTURE_CATALOG_FROM) !== null) return;
  const document = (
    eventId: string,
    documentKind: string,
    documentId: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId,
    idempotencyKey: documentId + "/1",
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    // The payload's own digest, which the registry door verifies (P-15/R, ADR 0104).
    contentDigest: sha256Hex(canonicalJsonStringify(payload)),
    recordedBy: "kimi/k3/coordinator/01",
    effectiveFrom: FIXTURE_CATALOG_FROM,
    occurredAt: FIXTURE_CATALOG_FROM,
    recordedAt: FIXTURE_CATALOG_FROM,
    payload,
  });
  ledger.appendRegistryEvent(
    document("c0c0c0c0-0000-4000-8000-00000000c001", "MODEL_VERSION", FIXTURE_MODEL_VERSION, {
      provider: "anthropic",
      model: "claude-opus-5",
      release: "2026-01-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["coordinator", "implementer", "reviewer", "consultant", "verifier"],
      transports: ["CLI_SUBSCRIPTION"],
    }),
  );
  ledger.appendRegistryEvent(
    document("c0c0c0c0-0000-4000-8000-00000000c002", "PRICE_TABLE", FIXTURE_CATALOG, {
      intervals: [
        {
          provider: "anthropic",
          modelVersionId: FIXTURE_MODEL_VERSION,
          transportKind: "CLI_SUBSCRIPTION",
          tokenClass: "input",
          currency: "USD",
          effectiveFrom: FIXTURE_CATALOG_FROM,
          effectiveTo: null,
          pricePerMillionNanos: 15_000_000_000,
        },
      ],
    }),
  );
}

/** Open the attempt and walk the real plan into RUNNING, with the effect performed. */
async function walkIntoRun(name: string, taskId: string): Promise<{ context: BeatContext; ledger: Ledger }> {
  const { context, ledger } = v2ContextFor(name, taskId);
  plantFixtureCatalog(ledger);
  walkUntil(context, "RUNNING");
  await applyIntentEffect(context, INTENT_STEP);
  expect(ledger.getTask(taskId)?.latestAttemptNumber).toBe(1);
  return { context, ledger };
}

function refusalOf(action: () => unknown): { readonly path: string; readonly message: string } {
  const error = caught(action);
  expect(error).toBeInstanceOf(LedgerValidationError);
  return (error as LedgerValidationError).issues[0] as { readonly path: string; readonly message: string };
}

describe("N-G-10: losing an acknowledgement, handing off and replaying, on the walk's coordinate", () => {
  it("returns the original effect, demands reconciliation, and admits no new intention and no new send", async () => {
    const taskId = "40404040-4040-4040-8040-40404040400d";
    const { context, ledger } = await walkIntoRun("p18g-n10-unknown", taskId);
    const effectId = effectIdV1(effectCoordinate(context, 1, 0));

    // 1. The effect is intended on segment 1 and dispatched.
    const intention = effectIntention(context, "effect-1", 1, 0, "acct-1");
    const landed = ledger.append(intention);
    expect(landed.inserted).toBe(true);
    ledger.append(dispatchIntention(context, "dispatch-1", effectId, 1, 1, "acct-1"));

    // 2. The acknowledgement is lost: INFLIGHT, then abandoned as uncertain.
    ledger.append(dispatchOutcome(context, "inflight-1", "dsp-1", { dispatchState: "INFLIGHT", acceptedAt: EFFECT_AT }));
    ledger.append(
      dispatchOutcome(context, "abandon-1", "dsp-1", {
        dispatchState: "ABANDONED",
        terminalAt: EFFECT_AT,
        effectOutcomeStatus: "OUTCOME_UNKNOWN",
      }),
    );
    const settled = ledger.status();

    // 3. The replay after the handoff: the lookup by logical key returns the
    //    original effect id and says reconciliation is required.
    const lookup = ledger.lookUpEffect({
      taskId,
      revisionNumber: 1,
      attemptNumber: 1,
      semanticScopeKey: SCOPE,
      localOperationKey: STEP_KEY,
      effectKind: "model_execution",
      requestContractVersion: "1",
      requestSha256: requestDigest(context),
    });
    expect(lookup?.effect.effectId).toBe(effectId);
    expect(lookup?.reconciliationRequired).toBe(true);

    //    The exact intention again is a replay of the same event.
    const replay = ledger.append(intention);
    expect(replay.inserted).toBe(false);
    expect(replay.record.sequence).toBe(landed.record.sequence);

    // 4. An honest retry on the handed-off segment is told to reuse — not
    //    CONFLICT — and names the effect it already has.
    const repeated = refusalOf(() => ledger.append(effectIntention(context, "effect-2", 2, 1, "acct-2")));
    expect(repeated.path).toBe("payload.effect.logicalOperationSha256");
    expect(repeated.message).not.toContain("CONFLICT");
    expect(repeated.message).toContain(effectId);
    expect(repeated.message).toContain("reconciliation");

    // 5. And no new send: the uncertain outcome blocks another delivery.
    expect(() => ledger.append(dispatchIntention(context, "dispatch-2", effectId, 2, 2, "acct-2"))).toThrow(
      LedgerValidationError,
    );

    expect(ledger.status().eventCount).toBe(settled.eventCount);
    expect(ledger.status().headEventSha256).toBe(settled.headEventSha256);
    expect(ledger.listDispatchAttempts(effectId)).toHaveLength(1);
    expect(ledger.listRouteSegments(taskId, 1, 1)).toHaveLength(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("refuses to redeliver a known outcome by name, and the first delivery still replays", async () => {
    const taskId = "40404040-4040-4040-8040-40404040400e";
    const { context, ledger } = await walkIntoRun("p18g-n10-known", taskId);
    const effectId = effectIdV1(effectCoordinate(context, 1, 0));

    ledger.append(effectIntention(context, "effect-1", 1, 0, "acct-1"));
    const delivery = dispatchIntention(context, "dispatch-1", effectId, 1, 1, "acct-1");
    const delivered = ledger.append(delivery);
    // FAILED rather than SUCCEEDED: this drill is about the reuse law, which has no
    // FAILED exception, and since 2.8.0 a SUCCEEDED must name a published RESPONSE
    // artifact this harness has no fixture for (P-07 escalón B, ADR 0098).
    ledger.append(
      dispatchOutcome(context, "settle-1", "dsp-1", {
        dispatchState: "SETTLED",
        terminalAt: EFFECT_AT,
        effectOutcomeStatus: "FAILED",
      }),
    );
    const settled = ledger.status();

    // The reuse instruction (decision 55): a second delivery after a handoff is
    // refused on `payload.dispatch.effectId`, with the words that say reuse.
    const refusal = refusalOf(() => ledger.append(dispatchIntention(context, "dispatch-2", effectId, 2, 2, "acct-2")));
    expect(refusal.path).toBe("payload.dispatch.effectId");
    expect(refusal.message).toContain("already ended FAILED at " + EFFECT_AT);
    expect(refusal.message).toContain("a known outcome is reused, never redelivered");
    expect(refusal.message).not.toContain("CONFLICT");

    const replay = ledger.append(delivery);
    expect(replay.inserted).toBe(false);
    expect(replay.record.sequence).toBe(delivered.record.sequence);
    expect(ledger.status().eventCount).toBe(settled.eventCount);
    expect(ledger.listDispatchAttempts(effectId).map((row) => row.dispatchAttemptId)).toEqual(["dsp-1"]);
    expect(ledger.getEffect(effectId)?.outcomeStatus).toBe("FAILED");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});

describe("what ADR 0080 left failing closed now speaks V2 (P-15/B, ADR 0102)", () => {
  it("a settlement for a revision-bearing walk appends one V2 TASK_FAILED, where it was refused before B", async () => {
    // Inverted from ADR 0080's fail-closed drill: the settlement's payload now
    // carries the coordinate its V2 key names, so the contract admits it.
    const taskId = "40404040-4040-4040-8040-40404040400f";
    const { context, ledger } = v2ContextFor("p18g-settlement", taskId);
    walkUntil(context, "RESERVED");
    const before = ledger.status().eventCount;

    const settlement = await settleFailure(context, "BOUND_EXHAUSTED");

    expect(settlement.verdict).toBe("FAILED");
    expect(settlement.failed?.payload).toMatchObject({ revisionNumber: 1, attemptNumber: 1 });
    expect(settlement.failed?.idempotencyKey).toBe(
      buildV2IdempotencyKey({
        stream: "control_plane_events",
        taskId,
        revisionNumber: 1,
        attemptNumber: 1,
        transitionId: "failed",
      }),
    );
    expect(ledger.status().eventCount).toBe(before + 1);
    expect(ledger.getTask(taskId)?.currentState).toBe("FAILED");
  });

  it("restateInvocation reads past an opening to the V2 discovery, where it refused the opening before B", () => {
    // Inverted: before B the first event being an opening was refused as an
    // unreadable discovery. Now the discovery is found by its V2 key, and the
    // refusal at RESERVED is the ordinary one — no route is recorded before the
    // INTENT — which proves the door read the discovery rather than the opening.
    const taskId = "40404040-4040-4040-8040-404040404010";
    const { context, ledger } = v2ContextFor("p18g-restate", taskId);
    walkUntil(context, "RESERVED");
    const outcome = restateInvocation(ledger, taskId, 1);
    expect(outcome).toEqual({ ok: false, refusal: "ROUTE_NOT_RECORDED", at: "attempt.route" });
  });
});


// ---------------------------------------------------------------------------
// P-15 escalón B: the payload coordinate is load-bearing (ADR 0102)
// ---------------------------------------------------------------------------

describe("P-15/B N-B-4/N-B-5: a payload coordinate is whole and valid, or the event does not land", () => {
  it("N-B-4: a built V2 event with its attempt number dropped is refused by the contract's key rule", () => {
    const event = buildEvent({
      invocation: v2InvocationFor("40404040-4040-4040-8040-4040404040b1"),
      step: planStep(1),
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      plan: LIFECYCLE_PLAN,
      route: TEST_ROUTE,
    });
    const { attemptNumber: dropped, ...payload } = event.payload;
    expect(dropped).toBe(1);
    const parsed = ControlPlaneEvent.safeParse({ ...event, payload });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("idempotencyKey must be exactly");
  });

  it("N-B-5: over the presence matrix, only the whole valid V2 pair on a V2 walk and no pair on a V1 walk land", () => {
    const VALUES: readonly (readonly [string, unknown])[] = [
      ["absent", undefined],
      ["null", null],
      ["zero", 0],
      ["string", "1"],
      ["fraction", 1.5],
      ["valid", 1],
    ];
    const landed: string[] = [];
    let cell = 0;
    for (const kind of ["V1", "V2"] as const) {
      for (const [revisionName, revisionValue] of VALUES) {
        for (const [attemptName, attemptValue] of VALUES) {
          cell += 1;
          const name = kind + "/" + revisionName + "/" + attemptName;
          const taskId = "40404040-4040-4040-8040-4040404" + String(10000 + cell);
          // A fresh ledger at the point where step 1 is the next event: the V1
          // walk discovered, the V2 walk opened and discovered.
          const staged = kind === "V1" ? contextFor("p15b-matrix-" + String(cell), taskId, []) : v2ContextFor("p15b-matrix-" + String(cell), taskId);
          if (kind === "V2") appendPlanStep(staged.context, ATTEMPT_OPENING_STEP);
          appendPlanStep(staged.context, planStep(0));
          const event = buildEvent({
            invocation: staged.context.invocation,
            step: planStep(1),
            emittedBy: EMITTED_BY,
            initiativeId: TEST_INITIATIVE_ID,
            plan: LIFECYCLE_PLAN,
            route: TEST_ROUTE,
          });
          const { revisionNumber: _r, attemptNumber: _a, ...rest } = event.payload;
          void _r;
          void _a;
          const payload: Record<string, unknown> = { ...rest };
          if (revisionValue !== undefined) payload["revisionNumber"] = revisionValue;
          if (attemptValue !== undefined) payload["attemptNumber"] = attemptValue;
          const candidate = { ...event, payload };
          const before = staged.ledger.status();
          const parsed = ControlPlaneEvent.safeParse(candidate);
          if (!parsed.success) {
            expect(staged.ledger.status().eventCount).toBe(before.eventCount);
            continue;
          }
          try {
            staged.ledger.append(parsed.data);
            landed.push(name);
          } catch {
            expect({ name, count: staged.ledger.status().eventCount }).toEqual({ name, count: before.eventCount });
            expect(staged.ledger.status().headEventSha256).toBe(before.headEventSha256);
          }
        }
      }
    }
    expect(landed).toEqual(["V1/absent/absent", "V2/valid/valid"]);
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón C: the builders' events land on a real V2 walk (ADR 0103)
// ---------------------------------------------------------------------------

const BUILT_SEGMENT: ExecutionSegmentRecord = {
  routeSegmentId: "seg-1",
  segmentNumber: 1,
  provider: "anthropic",
  model: "claude-opus-5",
  modelResolutionStatus: "RESOLVED",
  modelVersionId: FIXTURE_MODEL_VERSION,
  accountId: "acct-1",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-1",
  routingAssignmentId: null,
  reservationId: null,
  predecessorSegmentId: null,
  handoffReason: null,
  escalatedFromAttempt: null,
  escalationReason: null,
  resolvedAt: null,
};

/** A V2 walk in RUNNING with one effect intended and one delivery intended, both by the builders. */
async function builtDelivery(name: string, taskId: string): Promise<{ context: BeatContext; ledger: Ledger; effectId: string }> {
  const { context, ledger } = await walkIntoRun(name, taskId);
  const state = ledger.getTask(taskId)?.currentState ?? "RUNNING";
  const effect = buildEffectIntentionEvent({
    invocation: context.invocation,
    state,
    emittedBy: EMITTED_BY,
    causedBy: null,
    segment: BUILT_SEGMENT,
    effect: {
      operationOrdinal: 0,
      effectKind: "model_execution",
      semanticScopeKey: SCOPE,
      localOperationKey: STEP_KEY,
      requestContractVersion: "1",
      requestSha256: requestDigest(context),
    },
  });
  expect(ledger.append(effect).inserted).toBe(true);
  const effectId = (effect.payload["effect"] as { readonly effectId: string }).effectId;
  const dispatch = buildDispatchIntentionEvent({
    invocation: context.invocation,
    state,
    emittedBy: EMITTED_BY,
    causedBy: null,
    segment: BUILT_SEGMENT,
    dispatch: { dispatchAttemptId: "dsp-1", effectId, attemptOrdinal: 1, pin: FIXTURE_PIN },
  });
  expect(ledger.append(dispatch).inserted).toBe(true);
  return { context, ledger, effectId };
}

function transitionOn(context: BeatContext, ledger: Ledger, transition: DispatchTransition) {
  return buildDispatchTransitionEvent({
    invocation: context.invocation,
    state: ledger.getTask(context.invocation.taskId)?.currentState ?? "RUNNING",
    emittedBy: EMITTED_BY,
    causedBy: null,
    transition,
  });
}

describe("P-15/C: the effect, dispatch and transition builders land through the real door on a V2 walk", () => {
  it("PC-C1/PC-C2: the effect and the delivery land as built, the pin with them, and replay", async () => {
    const taskId = "40404040-4040-4040-8040-4040404040c1";
    const { context, ledger, effectId } = await builtDelivery("p15c-built", taskId);
    expect(ledger.getEffect(effectId)).toMatchObject({ effectId, routeSegmentId: "seg-1", operationOrdinal: 0 });
    expect(ledger.listDispatchAttempts(effectId)[0]).toMatchObject({
      dispatchAttemptId: "dsp-1",
      dispatchState: "INTENDED",
      dispatchContractVersion: "2.10.0",
      catalogDocumentId: FIXTURE_PIN.catalogDocumentId,
      catalogVersion: FIXTURE_PIN.catalogVersion,
    });
    // The same effect and delivery rebuilt: exact replays.
    const state = ledger.getTask(taskId)?.currentState ?? "RUNNING";
    const again = buildDispatchIntentionEvent({
      invocation: context.invocation,
      state,
      emittedBy: EMITTED_BY,
      causedBy: null,
      segment: BUILT_SEGMENT,
      dispatch: { dispatchAttemptId: "dsp-1", effectId, attemptOrdinal: 1, pin: FIXTURE_PIN },
    });
    expect(ledger.append(again).inserted).toBe(false);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("C-D2: INTENDED → INFLIGHT → SETTLED lands arm by arm, and the illegal moves are refused in the door's words", async () => {
    const taskId = "40404040-4040-4040-8040-4040404040c2";
    const { context, ledger, effectId } = await builtDelivery("p15c-moves", taskId);
    const inflight = transitionOn(context, ledger, { kind: "INFLIGHT", dispatchAttemptId: "dsp-1", acceptedAt: SUBMITTED_AT, externalHandle: "handle-1" });
    expect(ledger.append(inflight).inserted).toBe(true);
    expect(ledger.listDispatchAttempts(effectId)[0]).toMatchObject({ dispatchState: "INFLIGHT", acceptedAt: SUBMITTED_AT, externalHandle: "handle-1" });
    // INFLIGHT again under another handle: the move is recorded once, under its
    // own name, so a second acceptance with other content is a conflict.
    const rehandled = transitionOn(context, ledger, { kind: "INFLIGHT", dispatchAttemptId: "dsp-1", acceptedAt: SUBMITTED_AT, externalHandle: "handle-2" });
    expect(() => ledger.append(rehandled)).toThrow(LedgerIdempotencyConflictError);
    const settled = transitionOn(context, ledger, { kind: "SETTLED", dispatchAttemptId: "dsp-1", terminalAt: SUBMITTED_AT, effectOutcomeStatus: "FAILED", result: null });
    expect(ledger.append(settled).inserted).toBe(true);
    expect(ledger.getEffect(effectId)?.outcomeStatus).toBe("FAILED");
    // The recorded INFLIGHT again is a replay of that event, and moves nothing back.
    const count = ledger.status().eventCount;
    expect(ledger.append(inflight).inserted).toBe(false);
    expect(ledger.listDispatchAttempts(effectId)[0]?.dispatchState).toBe("SETTLED");
    // SETTLED → ABANDONED: a settled delivery moves nowhere.
    const abandoned = transitionOn(context, ledger, { kind: "ABANDONED", dispatchAttemptId: "dsp-1", terminalAt: SUBMITTED_AT, effectOutcomeStatus: null });
    expect(() => ledger.append(abandoned)).toThrow(LedgerValidationError);
    expect(ledger.status().eventCount).toBe(count);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("C-D2: INTENDED → ABANDONED lands with no accepted instant, and nothing moves it after", async () => {
    const taskId = "40404040-4040-4040-8040-4040404040c3";
    const { context, ledger, effectId } = await builtDelivery("p15c-abandoned", taskId);
    const abandoned = transitionOn(context, ledger, { kind: "ABANDONED", dispatchAttemptId: "dsp-1", terminalAt: SUBMITTED_AT, effectOutcomeStatus: null });
    expect(ledger.append(abandoned).inserted).toBe(true);
    expect(ledger.listDispatchAttempts(effectId)[0]).toMatchObject({ dispatchState: "ABANDONED", acceptedAt: null, externalHandle: null });
    const settled = transitionOn(context, ledger, { kind: "SETTLED", dispatchAttemptId: "dsp-1", terminalAt: SUBMITTED_AT, effectOutcomeStatus: "FAILED", result: null });
    expect(() => ledger.append(settled)).toThrow(LedgerValidationError);
  });

  it("C-D2 matrix: each arm's fields, present and invalid, are carried as given and refused by the door at the field", async () => {
    // The builder is typed and carries what it is handed; the door's grammar is
    // what judges a value (CORR-2). So a present-invalid field never reaches a row,
    // and a lawful one lands — the builder and the door agree cell by cell.
    // `null` for the outcome is the builder's own "none" (the key is not written),
    // so that field's present-invalid values are the ones a caller could hand in.
    const invalidFor = (field: string): readonly unknown[] => (field === "effectOutcomeStatus" ? ["", 42, "MAYBE"] : [null, "", 42]);
    const arms: readonly { readonly base: DispatchTransition; readonly fields: readonly string[] }[] = [
      { base: { kind: "INFLIGHT", dispatchAttemptId: "dsp-1", acceptedAt: SUBMITTED_AT, externalHandle: "handle-1" }, fields: ["acceptedAt", "externalHandle"] },
      { base: { kind: "ABANDONED", dispatchAttemptId: "dsp-1", terminalAt: SUBMITTED_AT, effectOutcomeStatus: null }, fields: ["terminalAt"] },
      { base: { kind: "SETTLED", dispatchAttemptId: "dsp-1", terminalAt: SUBMITTED_AT, effectOutcomeStatus: "FAILED", result: null }, fields: ["terminalAt", "effectOutcomeStatus"] },
    ];
    let cell = 0;
    for (const { base, fields } of arms) {
      for (const field of fields) {
        for (const value of [...invalidFor(field), (base as unknown as Record<string, unknown>)[field]]) {
          cell += 1;
          const taskId = "40404040-4040-4040-8040-40404041" + String(cell).padStart(4, "0");
          const { context, ledger } = await builtDelivery("p15c-matrix-" + String(cell), taskId);
          const transition = { ...base, [field]: value } as DispatchTransition;
          const lawful = value === (base as unknown as Record<string, unknown>)[field];
          const before = ledger.status().eventCount;
          const name = base.kind + "." + field + "=" + JSON.stringify(value);
          let refusal: unknown = null;
          try {
            ledger.append(transitionOn(context, ledger, transition));
          } catch (error) {
            refusal = error;
          }
          if (lawful) {
            expect({ name, refusal }).toEqual({ name, refusal: null });
          } else {
            expect(refusal, name).not.toBeNull();
            expect(ledger.status().eventCount, name).toBe(before);
          }
        }
      }
    }
    expect(cell).toBe(20);
  });
});
