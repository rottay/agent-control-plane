import type { ResolvedRoute } from "@acp/contracts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { artifactRootFor, createCheckpointStore, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { CONTRACT_VERSION, DriverCapabilities, buildIdempotencyKey } from "@acp/contracts";
import type { Checkpoint, DriverOutcome } from "@acp/contracts";
import type { DurableInvocation, OrchestrationDriver } from "../../../src/contracts/index.js";
import { driverCapabilityMismatches } from "../../../src/contracts/index.js";
import { buildEvent, operationForStep } from "../../../src/core/events/index.js";
import { applyEffect, probeEffect } from "../../../src/toy/repository/index.js";
import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  READ_ONLY_PLAN,
} from "../../../src/core/lifecycle/index.js";
import { PostconditionUnknownError, SupervisorError } from "../../../src/errors/index.js";
import { ExecutionEffectError } from "../../../src/execution-effects/index.js";
import { executeSwitchPlan } from "../../../src/switch-executor/index.js";
import type { SwitchPort } from "../../../src/switch-executor/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../../src/toy/repository/index.js";
import { SqliteSupervisor } from "../../../src/drivers/sqlite-supervisor/index.js";
import type { FaultPoint } from "../../../src/drivers/sqlite-supervisor/index.js";
import { deriveEventCoordinate, deterministicUuid } from "../../../src/core/coordinates/index.js";
import type { EffectPort } from "../../../src/core/step-executor/index.js";
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
 * Evidence for the SQLite supervisor.
 *
 * The kill/restart scenarios use real child processes terminated with SIGKILL.
 * An exception caught in-process would prove nothing: the page cache, the open
 * database handle and every JavaScript object survive a thrown error, which is
 * exactly what a crash does not leave behind.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..", "..");
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "drivers", "sqlite-supervisor-child", "index.js");

const EMITTED_BY = "claude/opus/implementer/01";

const scenarios: string[] = [];
const spawnedPids: number[] = [];
const openLedgers: Ledger[] = [];

function invocationFor(seed: string): DurableInvocation {
  return {
    taskId: seed,
    attempt: 1,
    invocationId: deterministicUuid("inv/" + seed),
    submittedAt: "2026-08-27T12:00:00.000Z",
    submissionDigest: "d".repeat(64),
  };
}

const TASK_IDS = [
  "44444444-4444-4444-8444-444444444441",
  "44444444-4444-4444-8444-444444444442",
  "44444444-4444-4444-8444-444444444443",
  "44444444-4444-4444-8444-444444444444",
  "44444444-4444-4444-8444-444444444445",
  "44444444-4444-4444-8444-444444444446",
] as const;

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function track(ledger: Ledger): Ledger {
  openLedgers.push(ledger);
  return ledger;
}

/**
 * The toy port, passed explicitly (V2-B1b, stage 2).
 *
 * The supervisor no longer binds any effect itself; a caller says which port
 * the beats drive. These drills keep the toy as their subject, so its
 * completion is trivially observable on disk.
 */
function toyEffects(root: ScenarioRoot): EffectPort {
  return {
    apply: (operation) => {
      applyEffect(root, operation);
      return Promise.resolve();
    },
    probe: (operation) => Promise.resolve(probeEffect(root, operation)),
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

/**
 * The digest the walk's terminal actually recorded, read back from the ledger.
 *
 * Not re-derived: the whole property under test is that the event names what
 * the store holds, and a test that recomputed the digest would be comparing two
 * derivations rather than reading one recorded fact.
 */
function recordedCheckpointDigest(ledger: Ledger, invocation: DurableInvocation): string {
  const terminal = LIFECYCLE_PLAN[LIFECYCLE_PLAN.length - 1];
  if (terminal === undefined) throw new Error("no terminal step");
  const recorded = ledger.getEventByIdempotencyKey(
    buildIdempotencyKey({
      taskId: invocation.taskId,
      attempt: invocation.attempt,
      transitionId: terminal.transitionId,
    }),
  );
  if (recorded === null) throw new Error("the terminal event is not in the ledger");
  const parsed = JSON.parse(recorded.canonicalJson) as {
    readonly payload: { readonly checkpointDigest?: unknown };
  };
  const digest = parsed.payload.checkpointDigest;
  if (typeof digest !== "string") throw new Error("the terminal event names no checkpoint digest");
  return digest;
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

/**
 * A child cannot use the vitest alias that points the workspace packages at
 * their TypeScript sources, so it runs the compiled entry point. The build is
 * incremental, so this is cheap and always current.
 */
function ensureChildBuilt(): void {
  const result = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "--build",
      join(PACKAGE_ROOT, "tsconfig.json"),
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (result.status !== 0 || !existsSync(CHILD_ENTRY)) {
    throw new Error(
      "could not build the runtime package for the drill: " + result.stdout + result.stderr,
    );
  }
}

interface ChildOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function runChildProcess(
  scenarioId: string,
  invocation: DurableInvocation,
  faultPoint: FaultPoint | null,
  effect: "TOY" | "EXECUTION" = "TOY",
  /**
   * Whether the spawning suite hands the child its git facts (V2-B1f/F3).
   *
   * `"OBSERVED"` is what every drill above wants and stays the default.
   * `"OMITTED"` spawns a child whose config carries no `checkpointFacts` at
   * all — the shape N12 is about, and the one the parser answers with `null`.
   */
  checkpointFacts: "OBSERVED" | "OMITTED" = "OBSERVED",
): Promise<ChildOutcome> {
  const config = JSON.stringify({
    scenarioId,
    invocation,
    emittedBy: EMITTED_BY,
    // The child refuses a config that does not say which policy it runs under.
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    initiativeId: TEST_INITIATIVE_ID,
    route: TEST_ROUTE,
    faultPoint,
    effect,
    // V2-B1f/F3. The child observes no git of its own: the SUITE observes the
    // repository this scenario really has and passes what it saw as data.
    // Omitting the key entirely is lawful, and means no checkpoint port.
    ...(checkpointFacts === "OBSERVED"
      ? { checkpointFacts: checkpointFactsFor(resolveScenarioRoot(scenarioId)) }
      : {}),
  });
  return new Promise<ChildOutcome>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CHILD_ENTRY, config], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    if (child.pid !== undefined) spawnedPids.push(child.pid);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code !== 0 && signal === null) {
        rejectPromise(new Error("child failed: " + stderr));
        return;
      }
      resolvePromise({ code, signal });
    });
  });
}

interface LedgerSnapshot {
  readonly eventCount: number;
  readonly headEventSha256: string;
  readonly state: string | null;
}

function snapshot(ledgerPath: string): LedgerSnapshot {
  const ledger = openLedger(ledgerPath, { readOnly: true });
  try {
    const status = ledger.status();
    const task = ledger.getTask(TASK_ID_IN_PLAY);
    return {
      eventCount: status.eventCount,
      headEventSha256: status.headEventSha256,
      state: task === null ? null : task.currentState,
    };
  } finally {
    ledger.close();
  }
}

let TASK_ID_IN_PLAY: string = TASK_IDS[0];

function effectMarkerCount(scenarioRoot: string): number {
  const effects = join(scenarioRoot, "effects");
  if (!existsSync(effects)) return 0;
  return readdirSync(effects).filter((name) => name.endsWith(".marker")).length;
}

// ---------------------------------------------------------------------------
// The 3/3 kill and restart drill
// ---------------------------------------------------------------------------

const FAULT_SCENARIOS: readonly { readonly id: string; readonly fault: FaultPoint }[] = [
  { id: "drill-after-intent", fault: "AFTER_INTENT" },
  { id: "drill-after-effect", fault: "AFTER_EFFECT" },
  { id: "drill-after-outcome", fault: "AFTER_OUTCOME" },
];

describe("kill and restart, 3/3", () => {
  for (const [index, { id, fault }] of FAULT_SCENARIOS.entries()) {
    it("recovers from a SIGKILL " + fault.toLowerCase().replace("_", " "), async () => {
      ensureChildBuilt();
      const taskId = TASK_IDS[index] ?? TASK_IDS[0];
      TASK_ID_IN_PLAY = taskId;
      const invocation = invocationFor(taskId);
      const root = scenario(id);
      const ledgerPath = scenarioLedgerPath(root);

      // 1. Run until the fault point and die by a real signal.
      const killed = await runChildProcess(id, invocation, fault);
      expect(killed.signal).toBe("SIGKILL");
      expect(killed.code).toBeNull();

      const afterCrash = snapshot(ledgerPath);
      expect(afterCrash.state).not.toBe("CHECKPOINTED");

      // 2. Restart with no fault. This must finish the work.
      const restarted = await runChildProcess(id, invocation, null);
      expect(restarted.signal).toBeNull();
      expect(restarted.code).toBe(0);

      const afterRestart = snapshot(ledgerPath);
      expect(afterRestart.state).toBe("CHECKPOINTED");
      expect(afterRestart.eventCount).toBe(LIFECYCLE_PLAN.length);

      // The effect happened exactly once, whichever side of it we died on.
      expect(effectMarkerCount(root)).toBe(1);

      // 3. A third run must be a pure replay: nothing appended, head unmoved.
      const replayed = await runChildProcess(id, invocation, null);
      expect(replayed.code).toBe(0);
      const afterReplay = snapshot(ledgerPath);
      expect(afterReplay.eventCount).toBe(afterRestart.eventCount);
      expect(afterReplay.headEventSha256).toBe(afterRestart.headEventSha256);
      expect(effectMarkerCount(root)).toBe(1);

      // 4. The ledger verifies, and its projections rebuild to the same answer.
      const ledger = track(openLedger(ledgerPath));
      const integrity = ledger.verifyIntegrity();
      expect(integrity.problems).toEqual([]);
      expect(integrity.ok).toBe(true);

      const liveTask = ledger.getTask(taskId);
      const liveWorkers = ledger.listWorkers().workers;
      ledger.rebuildReadModel();
      expect(ledger.getTask(taskId)).toEqual(liveTask);
      expect(ledger.listWorkers().workers).toEqual(liveWorkers);

      // No duplicate coordinates survived any of the three runs.
      const events = ledger.listEvents({ limit: 200 }).events;
      const keys = events.map((record) => record.event.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }

  it("left no child process behind", () => {
    for (const pid of spawnedPids) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(String(pid) + ":" + String(alive)).toBe(String(pid) + ":false");
    }
  });
});

// ---------------------------------------------------------------------------
// In-process behaviour
// ---------------------------------------------------------------------------

function supervisorFor(
  scenarioId: string,
  taskId: string,
): {
  supervisor: SqliteSupervisor;
  ledger: Ledger;
  root: ScenarioRoot;
  invocation: DurableInvocation;
} {
  const root = scenario(scenarioId);
  const invocation = invocationFor(taskId);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  return {
    supervisor: new SqliteSupervisor({
      ledger,
      invocation,
      effects: toyEffects(root),
      checkpoints: drillCheckpoints({
        ledger,
        invocation,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    }),
    ledger,
    root,
    invocation,
  };
}

describe("the supervisor", () => {
  it("drives the plan to CHECKPOINTED and appends one event per step", async () => {
    const taskId: string = TASK_IDS[3];
    const { supervisor, ledger } = supervisorFor("supervisor-happy", taskId);
    const result = await supervisor.runToCheckpoint();
    expect(result.finalState).toBe("CHECKPOINTED");
    expect(ledger.status().eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");
  });

  it("treats a second full run as an exact replay that appends nothing", async () => {
    const taskId: string = TASK_IDS[4];
    const { supervisor, ledger, invocation } = supervisorFor("supervisor-replay", taskId);
    await supervisor.runToCheckpoint();
    const before = ledger.status();

    await supervisor.runToCheckpoint();
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);

    // Re-appending every plan event directly must be an exact replay.
    //
    // The terminal is rebuilt with the digest the walk recorded (V2-B1f/F3).
    // `buildEvent` alone no longer produces the terminal's bytes: since the
    // checkpoint is really written, the event names the store's own digest, and
    // an event rebuilt without it would be a DIFFERENT body under the same key
    // -- which the ledger correctly refuses. Reading the digest back out of the
    // recorded row rather than re-deriving it is the point: the replay is
    // proved against what the walk actually wrote.
    for (const step of LIFECYCLE_PLAN) {
      const built = buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE });
      const event =
        step.eventType === "CHECKPOINT_WRITTEN"
          ? { ...built, payload: { ...built.payload, checkpointDigest: recordedCheckpointDigest(ledger, invocation) } }
          : built;
      expect(step.transitionId + ":" + String(ledger.append(event).inserted)).toBe(
        step.transitionId + ":false",
      );
    }
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
  });

  it("fails closed when a changed body reuses an idempotency key", async () => {
    const taskId: string = TASK_IDS[5];
    const { supervisor, ledger, invocation } = supervisorFor("supervisor-conflict", taskId);
    await supervisor.runToCheckpoint();

    const step = LIFECYCLE_PLAN[0];
    if (step === undefined) throw new Error("no plan");
    const tampered = {
      ...buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE }),
      emittedBy: "kimi/k3/coordinator/01",
    };
    let name = "";
    try {
      ledger.append(tampered);
    } catch (error: unknown) {
      name = error instanceof Error ? error.name : "";
    }
    expect(name).toBe("LedgerIdempotencyConflictError");
  });

  it("refuses to append an outcome when the postcondition is UNKNOWN", async () => {
    const taskId = TASK_IDS[0];
    const { supervisor, ledger, root, invocation } = supervisorFor("supervisor-unknown", taskId);

    // Put the ledger in exactly the state a crash between the effect and the
    // outcome leaves behind: the intent is recorded, the task is RUNNING, and
    // no outcome exists. Then make the marker unreadable to the probe.
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE }));
    }
    expect(ledger.getTask(taskId)?.currentState).toBe("RUNNING");

    const operation = operationForStep(invocation, INTENT_STEP);
    const marker = join(root, "effects", operation.operationId + ".marker");
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    // Written through the filesystem, not through applyEffect, which refuses.
    writeFileSync(marker, "written by something else", "utf8");

    let caught: unknown = null;
    try {
      await supervisor.runToCheckpoint();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PostconditionUnknownError);

    // No outcome was guessed into the log.
    const outcomeKey = taskId + "/1/run.outcome";
    expect(ledger.getEventByIdempotencyKey(outcomeKey)).toBeNull();
    expect(ledger.getTask(taskId)?.currentState).toBe("RUNNING");
  });

  it("reports a ledger-headed status and a CONSISTENT reconciliation", async () => {
    const taskId: string = TASK_IDS[1];
    const { supervisor, ledger } = supervisorFor("supervisor-status", taskId);
    await supervisor.runToCheckpoint();

    const status = await supervisor.status();
    expect(status.mode).toBe("SQLITE_SUPERVISOR");
    expect(status.health).toBe("OK");
    expect(status.ledgerHeadSequence).toBe(ledger.status().headSequence);
    expect(status.ledgerHeadSha256).toBe(ledger.status().headEventSha256);
    expect(status.dataRoot).toBe(".acp-local/drills");

    const report = await supervisor.reconcile();
    expect(report.verdict).toBe("CONSISTENT");
    expect(report.resolvedByLedger).toBe(true);
    expect(report.safeToResume).toBe(true);
    expect(report.discrepancies).toEqual([]);
  });

  it("surfaces a failed append instead of retrying around it", async () => {
    const taskId: string = TASK_IDS[2];
    const root = scenario("supervisor-append-failure");
    const ledgerPath = scenarioLedgerPath(root);

    // The ledger's own fault seam, which is how its rollback tests prove that a
    // failed append leaves nothing behind. Here it stands in for any durable
    // failure, a lock timeout included: what matters is that the supervisor
    // propagates it rather than looping until it happens to succeed.
    const ledger = track(
      openLedger(ledgerPath, {
        __testFaults: {
          beforeAppendCommit: () => {
            throw new Error("injected durable failure");
          },
        },
      }),
    );
    const supervisor = new SqliteSupervisor({
      ledger,
      invocation: invocationFor(taskId),
      effects: toyEffects(root),
      checkpoints: drillCheckpoints({
        ledger,
        invocation: invocationFor(taskId),
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    });

    const started = Date.now();
    let message = "";
    try {
      await supervisor.runToCheckpoint();
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : "";
    }

    // Surfaced unchanged, promptly, and with nothing written.
    expect(message).toBe("injected durable failure");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(ledger.status().eventCount).toBe(0);
    expect(ledger.getTask(taskId)).toBeNull();
  });

  it("keeps the lock wait bounded rather than infinite", () => {
    const root = scenario("supervisor-busy-bound");
    const ledger = track(openLedger(scenarioLedgerPath(root), { busyTimeoutMs: 50 }));
    // A stuck writer must not be able to hang this driver forever. The bound is
    // the ledger's, and the supervisor adds no loop that would defeat it.
    expect(ledger.status().pragmas.busyTimeoutMs).toBe(50);
  });

  it("never records an outcome from advance() without probe evidence", async () => {
    // The bug this replaced: advance(from=RUNNING) resolved straight to the
    // outcome step and appended it, writing a permanent claim that an effect had
    // completed while nothing existed on disk.
    const taskId = "77777777-7777-4777-8777-777777777771";
    const { supervisor, ledger, root, invocation } = supervisorFor("advance-not-done", taskId);
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE }));
    }
    expect(effectMarkerCount(root)).toBe(0);

    const event = await supervisor.advance(invocation, "RUNNING");

    // NOT_DONE: the effect is performed first, then the outcome is recorded.
    expect(effectMarkerCount(root)).toBe(1);
    expect(event?.type).toBe("ATOMIC_STEP_COMPLETED");
    expect(ledger.getEventByIdempotencyKey(taskId + "/1/run.outcome")).not.toBeNull();
  });

  it("records the outcome once when the effect is already DONE", async () => {
    const taskId = "77777777-7777-4777-8777-777777777772";
    const { supervisor, ledger, root, invocation } = supervisorFor("advance-done", taskId);
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE }));
    }
    applyEffect(root, operationForStep(invocation, INTENT_STEP));
    expect(effectMarkerCount(root)).toBe(1);

    const event = await supervisor.advance(invocation, "RUNNING");
    expect(event?.type).toBe("ATOMIC_STEP_COMPLETED");
    expect(effectMarkerCount(root)).toBe(1);

    // A second advance from RUNNING moves past the outcome, never repeats it.
    const head = ledger.status().headEventSha256;
    const next = await supervisor.advance(invocation, "RUNNING");
    expect(next?.type).toBe("VERIFICATION_COMPLETED");
    expect(ledger.listEvents({ limit: 200 }).events.filter(
      (record) => record.event.transitionId === "run.outcome",
    )).toHaveLength(1);
    expect(head).not.toBe(ledger.status().headEventSha256);
  });

  it("refuses to record an outcome when the probe says UNKNOWN", async () => {
    const taskId = "77777777-7777-4777-8777-777777777773";
    const { supervisor, ledger, root, invocation } = supervisorFor("advance-unknown", taskId);
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE }));
    }
    const operation = operationForStep(invocation, INTENT_STEP);
    const marker = join(root, "effects", operation.operationId + ".marker");
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "written by something else", "utf8");

    const headBefore = ledger.status().headEventSha256;
    let caught: unknown = null;
    try {
      await supervisor.advance(invocation, "RUNNING");
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PostconditionUnknownError);
    expect(ledger.getEventByIdempotencyKey(taskId + "/1/run.outcome")).toBeNull();
    expect(ledger.status().headEventSha256).toBe(headBefore);
  });

  it("fails closed when the same coordinates carry a different submission", async () => {
    const taskId = "77777777-7777-4777-8777-777777777774";
    const { supervisor, ledger, root, invocation } = supervisorFor("submission-conflict", taskId);
    await supervisor.runToCheckpoint();

    const headBefore = ledger.status().headEventSha256;
    const countBefore = ledger.status().eventCount;
    const markersBefore = effectMarkerCount(root);

    // Same task, attempt, invocation and transition -- a different payload.
    const resubmitted = { ...invocation, submissionDigest: "9".repeat(64) };
    const step = LIFECYCLE_PLAN[0];
    if (step === undefined) throw new Error("no plan");

    let name = "";
    try {
      ledger.append(buildEvent({ invocation: resubmitted, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE }));
    } catch (error: unknown) {
      name = error instanceof Error ? error.name : "";
    }
    expect(name).toBe("LedgerIdempotencyConflictError");
    expect(ledger.status().headEventSha256).toBe(headBefore);
    expect(ledger.status().eventCount).toBe(countBefore);
    expect(effectMarkerCount(root)).toBe(markersBefore);

    // The original submission still replays exactly.
    expect(ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE })).inserted).toBe(
      false,
    );
    expect(ledger.status().headEventSha256).toBe(headBefore);
  });

  it("has no import side effects", async () => {
    const before = effectMarkerCount(join(REPO_ROOT, ".acp-local", "drills"));
    const module = await import("../../../src/index.js");
    expect(typeof module.SqliteSupervisor).toBe("function");
    expect(effectMarkerCount(join(REPO_ROOT, ".acp-local", "drills"))).toBe(before);
  });

  /**
   * Resuming mid-plan never rebuilds the steps already in the ledger, so a
   * changed submission would sail past the idempotency check: only the
   * remaining keys get written and none of them collide. Before the continuity
   * guard, a task begun under submission A ran to CHECKPOINTED under submission
   * B with no error anywhere, leaving one attempt carrying two different
   * submission digests.
   */
  const MISMATCHES: readonly {
    readonly label: string;
    readonly mutate: (invocation: DurableInvocation) => DurableInvocation;
  }[] = [
    // Attempt first, because it is the one that did not merely continue the
    // work under a foreign identity: a changed attempt built a different
    // idempotency key, found nothing, performed the effect a SECOND time and
    // appended an attempt-2 outcome onto an attempt-1 task.
    { label: "attempt", mutate: (i) => ({ ...i, attempt: 2 }) },
    { label: "digest", mutate: (i) => ({ ...i, submissionDigest: "b".repeat(64) }) },
    { label: "invocationId", mutate: (i) => ({ ...i, invocationId: deterministicUuid("inv/other") }) },
    { label: "submittedAt", mutate: (i) => ({ ...i, submittedAt: "2026-08-27T13:00:00.000Z" }) },
  ];

  for (const [index, { label, mutate }] of MISMATCHES.entries()) {
    it("refuses to resume an in-flight attempt under a changed " + label, async () => {
      const taskId = "99999999-9999-4999-8999-99999999999" + String(index);
      const { supervisor, ledger, root, invocation } = supervisorFor(
        "resume-mismatch-" + label.toLowerCase(),
        taskId,
      );

      // Leave the task exactly mid-flight: intent recorded, effect applied,
      // outcome outstanding.
      for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
        ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE }));
      }
      applyEffect(root, operationForStep(invocation, INTENT_STEP));

      const headBefore = ledger.status().headEventSha256;
      const countBefore = ledger.status().eventCount;
      const markersBefore = effectMarkerCount(root);
      expect(markersBefore).toBe(1);

      const intruder = new SqliteSupervisor({
        ledger,
        invocation: mutate(invocation),
        effects: toyEffects(root),
        checkpoints: drillCheckpoints({
          ledger,
          invocation: mutate(invocation),
          emittedBy: EMITTED_BY,
          ledgerPath: scenarioLedgerPath(root),
          worktree: root,
        }),
        emittedBy: EMITTED_BY,
        commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
        initiativeId: TEST_INITIATIVE_ID,
        route: TEST_ROUTE,
      });
      await expect(intruder.runToCheckpoint()).rejects.toThrow(SupervisorError);

      // Nothing moved: no event, no outcome, no second effect.
      expect(ledger.status().headEventSha256).toBe(headBefore);
      expect(ledger.status().eventCount).toBe(countBefore);
      expect(ledger.getEventByIdempotencyKey(taskId + "/1/run.outcome")).toBeNull();
      expect(ledger.getEventByIdempotencyKey(taskId + "/2/run.outcome")).toBeNull();
      expect(ledger.getTask(taskId)?.latestAttempt).toBe(1);
      expect(effectMarkerCount(root)).toBe(markersBefore);

      // The original submission still finishes its own work.
      expect((await supervisor.runToCheckpoint()).finalState).toBe("CHECKPOINTED");
      expect(ledger.status().eventCount).toBe(LIFECYCLE_PLAN.length);
      expect(effectMarkerCount(root)).toBe(1);
      expect(ledger.verifyIntegrity().ok).toBe(true);
    });
  }

  /**
   * N3: the attribution is protected by the same guard as the submission.
   *
   * `initiativeId` is a supervisor option rather than an invocation field, so
   * it cannot join the MISMATCHES table above — but it reaches the ledger, in
   * the step-0 payload, and that is what makes this work: continuity rebuilds
   * step 0 from the resuming run's own inputs and compares bytes. A resume
   * under a different initiative rebuilds a different payload, the comparison
   * fails, and the run is refused. The protection is a consequence of putting
   * the attribution in the event rather than beside it.
   */
  it("refuses to resume an in-flight attempt under a different initiativeId", async () => {
    const taskId = "99999999-9999-4999-8999-999999999997";
    const { supervisor, ledger, root, invocation } = supervisorFor(
      "resume-mismatch-initiative",
      taskId,
    );

    // Mid-flight, exactly as the mismatch cases above leave it.
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      ledger.append(
        buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE }),
      );
    }
    applyEffect(root, operationForStep(invocation, INTENT_STEP));

    const headBefore = ledger.status().headEventSha256;
    const countBefore = ledger.status().eventCount;
    expect(effectMarkerCount(root)).toBe(1);

    // Identical in every respect but the attribution.
    const otherInitiative = new SqliteSupervisor({
      ledger,
      invocation,
      effects: toyEffects(root),
      checkpoints: drillCheckpoints({
        ledger,
        invocation,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b01",
      route: TEST_ROUTE,
    });
    await expect(otherInitiative.runToCheckpoint()).rejects.toThrow(SupervisorError);

    // Nothing moved: no event, no outcome, no second effect.
    expect(ledger.status().headEventSha256).toBe(headBefore);
    expect(ledger.status().eventCount).toBe(countBefore);
    expect(ledger.getEventByIdempotencyKey(taskId + "/1/run.outcome")).toBeNull();
    expect(effectMarkerCount(root)).toBe(1);

    // And the refusal was about the attribution, not a broken fixture: the
    // original initiative still finishes its own work.
    expect((await supervisor.runToCheckpoint()).finalState).toBe("CHECKPOINTED");
    expect(ledger.status().eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(effectMarkerCount(root)).toBe(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // The discovery event carries the initiative the task was begun under,
    // which is the byte the guard actually compared. The transition id comes
    // from the plan rather than a literal, so renaming a step cannot make this
    // assertion quietly stop looking at anything.
    const discoveryStep = LIFECYCLE_PLAN[0];
    if (discoveryStep === undefined) throw new Error("no discovery step");
    const discovery = ledger.getEventByIdempotencyKey(
      taskId + "/1/" + discoveryStep.transitionId,
    );
    expect(discovery?.event.type).toBe("TASK_DISCOVERED");
    expect(discovery?.event.payload["initiativeId"]).toBe(TEST_INITIATIVE_ID);
  });

  it("still treats an identical resubmission as an exact replay", async () => {
    const taskId = "99999999-9999-4999-8999-999999999998";
    const { supervisor, ledger, root, invocation } = supervisorFor("resume-identical", taskId);
    await supervisor.runToCheckpoint();
    const head = ledger.status().headEventSha256;

    const twin = new SqliteSupervisor({
      ledger,
      invocation: { ...invocation },
      effects: toyEffects(root),
      checkpoints: drillCheckpoints({
        ledger,
        invocation,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    });
    expect((await twin.runToCheckpoint()).finalState).toBe("CHECKPOINTED");
    expect(ledger.status().headEventSha256).toBe(head);
    expect(effectMarkerCount(root)).toBe(1);
  });

  it("refuses an advance whose claimed state the ledger does not agree with", async () => {
    // The caller's `from` is a claim, not input. Before this check, claiming
    // RUNNING while the ledger said RESERVED reached the outcome beat, probed
    // NOT_DONE, PERFORMED THE EFFECT, and only then failed on the lifecycle
    // precondition -- leaving an effect that had happened with no intent
    // recorded anywhere.
    const taskId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
    const { supervisor, ledger, root, invocation } = supervisorFor("advance-claim", taskId);

    // Stop at RESERVED: the intent step is deliberately NOT recorded.
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index)) {
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY, initiativeId: TEST_INITIATIVE_ID, plan: LIFECYCLE_PLAN, route: TEST_ROUTE }));
    }
    expect(ledger.getTask(taskId)?.currentState).toBe("RESERVED");
    const headBefore = ledger.status().headEventSha256;
    const countBefore = ledger.status().eventCount;
    expect(effectMarkerCount(root)).toBe(0);

    let caught: unknown = null;
    try {
      await supervisor.advance(invocation, "RUNNING");
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SupervisorError);
    // No effect, and the log is exactly where it was.
    expect(effectMarkerCount(root)).toBe(0);
    expect(ledger.status().headEventSha256).toBe(headBefore);
    expect(ledger.status().eventCount).toBe(countBefore);
    expect(ledger.getEventByIdempotencyKey(taskId + "/1/run.started")).toBeNull();
    expect(ledger.getEventByIdempotencyKey(taskId + "/1/run.outcome")).toBeNull();

    // The truthful claim still proceeds, in the lawful order: intent first.
    const event = await supervisor.advance(invocation, "RESERVED");
    expect(event?.type).toBe("RUN_STARTED");
    expect(ledger.getEventByIdempotencyKey(taskId + "/1/run.started")).not.toBeNull();
    expect(effectMarkerCount(root)).toBe(1);
  });

  it("refuses an advance on a task the ledger has never seen", async () => {
    // The frozen interface takes a TaskState, so there is no way to say "this
    // task does not exist" and no way for the caller's claim to be true.
    const taskId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
    const { supervisor, ledger, root, invocation } = supervisorFor("advance-no-task", taskId);
    expect(ledger.getTask(taskId)).toBeNull();

    let caught: unknown = null;
    try {
      await supervisor.advance(invocation, "DISCOVERED");
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SupervisorError);
    expect(ledger.status().eventCount).toBe(0);
    expect(effectMarkerCount(root)).toBe(0);

    // runToCheckpoint reads the absence itself rather than being told about it.
    expect((await supervisor.runToCheckpoint()).finalState).toBe("CHECKPOINTED");
  });
});

describe("the plan comes from the packet's commit policy", () => {
  async function runUnder(commitPolicy: "NO_COMMIT" | "LOCAL_COMMIT_WITH_RECEIPT", scenarioId: string, taskId: string) {
    const root = scenario(scenarioId);
    const invocation = invocationFor(taskId);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const result = await new SqliteSupervisor({
      ledger,
      invocation,
      effects: toyEffects(root),
      checkpoints: drillCheckpoints({
        ledger,
        invocation,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
      emittedBy: EMITTED_BY,
      commitPolicy,
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    }).runToCheckpoint();
    const trail = ledger.listEvents({ limit: 200 }).events.map((record) => record.event.type);
    return { result, trail, ledger, taskId };
  }

  it("walks a NO_COMMIT packet to a checkpoint with no commit anywhere in it", async () => {
    const { result, trail, ledger, taskId } = await runUnder(
      "NO_COMMIT",
      "policy-read-only",
      "70707070-7070-4707-8707-707070707071",
    );

    expect(result.finalState).toBe("CHECKPOINTED");
    expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");

    // The invariant, exactly as the packet states it.
    expect(trail.slice(-2)).toEqual(["AUDIT_COMPLETED", "CHECKPOINT_WRITTEN"]);
    expect(trail.filter((type) => type.startsWith("COMMIT_"))).toEqual([]);
    expect(trail).not.toContain("TASK_STATE_CHANGED");
    expect(trail).toHaveLength(READ_ONLY_PLAN.length);
  });

  it("leaves the writer path exactly as it was", async () => {
    const { result, trail, ledger, taskId } = await runUnder(
      "LOCAL_COMMIT_WITH_RECEIPT",
      "policy-writer",
      "70707070-7070-4707-8707-707070707072",
    );

    expect(result.finalState).toBe("CHECKPOINTED");
    expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");
    expect(trail).toEqual(LIFECYCLE_PLAN.map((step) => step.eventType));
    expect(trail).toContain("COMMIT_RECORDED");
    expect(trail).toHaveLength(LIFECYCLE_PLAN.length);
  });

  it("gives each plan its own bound rather than the writer plan's", () => {
    // A read-only run is two steps shorter; the loop bound must come from the
    // plan it is walking, or a shorter plan would be given a longer budget and
    // the guard would stop meaning what it says.
    expect(READ_ONLY_PLAN.length).toBeLessThan(LIFECYCLE_PLAN.length);
  });
});

/**
 * The subject for the capability tests: a supervisor whose ledger is never
 * touched, because none of the four verbs reaches one.
 */
const INVOCATION_FOR_CAPABILITIES = invocationFor("11111111-1111-4111-8111-111111111111");

function capabilitySubject(): SqliteSupervisor {
  const root = scenario("capability-declaration");
  return new SqliteSupervisor({
    ledger: track(openLedger(scenarioLedgerPath(root))),
    invocation: INVOCATION_FOR_CAPABILITIES,
    effects: toyEffects(root),
    emittedBy: EMITTED_BY,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    initiativeId: TEST_INITIATIVE_ID,
    route: TEST_ROUTE,
  });
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
  // `timer` takes a duration as of V2-B2-5, and this call passes one. The
  // supervisor's own implementation still declares no parameters, which is
  // deliberate and is exactly what TypeScript's method compatibility allows: a
  // driver that refuses does not need to look at what it was asked for. The
  // arity therefore moves on the PORT and not on this driver, and the fence's
  // pin on its verbatim zero-argument refusal keeps saying so.
  const OUTCOMES = async (driver: OrchestrationDriver) => ({
    CANCEL: await driver.cancel(INVOCATION_FOR_CAPABILITIES),
    REATTACH: await driver.reattach(INVOCATION_FOR_CAPABILITIES),
    SIGNAL: await driver.signal(INVOCATION_FOR_CAPABILITIES),
    TIMER: await driver.timer(INVOCATION_FOR_CAPABILITIES, 1_000),
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

  it("still refuses SIGNAL and TIMER field-exactly now that the other driver supports them, and appends nothing", async () => {
    // The divergence, asserted from this side (V2-B2-5). The Restate driver
    // flipped both verbs to SUPPORTED in that packet; this one did not, and the
    // point of a capability declaration is that a caller can discover the
    // difference without trying it.
    //
    // Simulating parity here would be the single worst thing this driver could
    // do. A `setTimeout` calling itself a durable timer, or an in-process
    // promise calling itself a signal, would both evaporate with the process —
    // and the caller would have been told the opposite.
    const root = scenario("capability-divergence");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const supervisor = new SqliteSupervisor({
      ledger,
      invocation: INVOCATION_FOR_CAPABILITIES,
      effects: toyEffects(root),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    });

    // Asked THROUGH the port, which is where the arity lives. The class still
    // declares zero parameters for both verbs and that is not an oversight: a
    // driver that refuses need not look at what it was asked for, and
    // TypeScript's method compatibility is what lets the honest narrower
    // implementation satisfy the wider contract.
    const port: OrchestrationDriver = supervisor;
    const before = ledger.status().eventCount;
    expect(await port.signal(INVOCATION_FOR_CAPABILITIES)).toEqual({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "signal",
    });
    expect(await port.timer(INVOCATION_FOR_CAPABILITIES, 1_000)).toEqual({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "timer",
    });

    expect(supervisor.capabilities().verbs.SIGNAL).toBe("UNSUPPORTED");
    expect(supervisor.capabilities().verbs.TIMER).toBe("UNSUPPORTED");
    // Asking cost the log nothing. A refusal that appended would be a driver
    // recording an opinion about work it declined to do.
    expect(ledger.status().eventCount).toBe(before);
    expect(ledger.status().eventCount).toBe(0);
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


/**
 * The same three fault points, re-proved over the ASSEMBLED effect (V2-B2-2).
 *
 * The 3/3 drill above earned its certificate against the toy, whose `apply`
 * settles within one tick and whose completion is a file that either exists or
 * does not. That says nothing about a restart landing between a real effect and
 * its outcome, because with the toy there is no interval to land in.
 *
 * These runs drive `createExecutionEffects`: the port is drained asynchronously
 * to a terminal event, evidence is written under the scenario's own
 * `executions/` directory keyed by the operation digest, and the probe answers
 * DONE / NOT_DONE / UNKNOWN from that evidence. `AFTER_EFFECT` is the
 * load-bearing case — the kill lands with the effect done and no outcome
 * appended, and the restart must close the intent from probe evidence rather
 * than from the assumption that having got that far it must have finished.
 */
describe("kill and restart over the assembled execution path, 3/3", () => {
  const EXECUTION_TASK_IDS = [
    "e0000000-0000-4000-8000-000000000001",
    "e0000000-0000-4000-8000-000000000002",
    "e0000000-0000-4000-8000-000000000003",
  ] as const;

  /** How many times the scripted port was STARTED, across every process. */
  function executionStarts(scenarioRoot: string): number {
    const log = join(scenarioRoot, "execution-starts.log");
    if (!existsSync(log)) return 0;
    return readFileSync(log, "utf8").split("\n").filter((line) => line.trim() !== "").length;
  }

  /** The evidence markers the execution effect leaves, by name. */
  function executionEvidence(scenarioRoot: string): readonly string[] {
    const home = join(scenarioRoot, "executions");
    if (!existsSync(home)) return [];
    return readdirSync(home).filter((name) => name.endsWith(".json")).sort();
  }

  for (const [index, { id, fault }] of FAULT_SCENARIOS.entries()) {
    it("recovers from a SIGKILL " + fault.toLowerCase().replace("_", " "), async () => {
      ensureChildBuilt();
      const taskId = EXECUTION_TASK_IDS[index] ?? EXECUTION_TASK_IDS[0];
      TASK_ID_IN_PLAY = taskId;
      const invocation = invocationFor(taskId);
      const scenarioId = "execution-" + id;
      const root = scenario(scenarioId);
      const ledgerPath = scenarioLedgerPath(root);

      const killed = await runChildProcess(scenarioId, invocation, fault, "EXECUTION");
      expect(killed.signal).toBe("SIGKILL");
      expect(killed.code).toBeNull();

      const afterCrash = snapshot(ledgerPath);
      expect(afterCrash.state).not.toBe("CHECKPOINTED");

      // The discriminator against the toy: this walk left evidence under
      // `executions/`, digest-keyed, and no `effects/` marker at all. Run the
      // same drill with the toy bound and this assertion fails, which is what
      // stops the packet from being a re-run dressed as a re-certification.
      expect(effectMarkerCount(root)).toBe(0);
      if (fault !== "AFTER_INTENT") {
        expect(executionEvidence(root)).toHaveLength(1);
      }

      const restarted = await runChildProcess(scenarioId, invocation, null, "EXECUTION");
      expect(restarted.signal).toBeNull();
      expect(restarted.code).toBe(0);

      const afterRestart = snapshot(ledgerPath);
      expect(afterRestart.state).toBe("CHECKPOINTED");
      expect(afterRestart.eventCount).toBe(LIFECYCLE_PLAN.length);
      expect(executionEvidence(root)).toHaveLength(1);

      // The effect ran exactly once across both processes, whichever side of it
      // the kill landed on. For AFTER_EFFECT this is the whole claim: the
      // restart closed an open intent WITHOUT re-executing, which it can only
      // do from probe evidence.
      expect(executionStarts(root)).toBe(1);

      const replayed = await runChildProcess(scenarioId, invocation, null, "EXECUTION");
      expect(replayed.code).toBe(0);
      const afterReplay = snapshot(ledgerPath);
      expect(afterReplay.eventCount).toBe(afterRestart.eventCount);
      expect(afterReplay.headEventSha256).toBe(afterRestart.headEventSha256);
      expect(executionStarts(root)).toBe(1);

      const ledger = track(openLedger(ledgerPath));
      const integrity = ledger.verifyIntegrity();
      expect(integrity.problems).toEqual([]);
      expect(integrity.ok).toBe(true);
      const before = ledger.listEvents({ limit: 50 }).events.map((e) => e.eventSha256);
      ledger.rebuildReadModel();
      expect(ledger.listEvents({ limit: 50 }).events.map((e) => e.eventSha256)).toEqual(before);
      expect(ledger.verifyIntegrity().ok).toBe(true);

      // The recorded route is the execution one, not the toy's: the walk says
      // what it actually did.
      expect(ledger.getExecutionRoute(taskId, 1)).toMatchObject({
        provider: "drill",
        model: "scripted-execution",
      });
    }, 120_000);
  }

  it("negative: with the evidence removed, the restart executes a second time", async () => {
    // The causal negative the positive above depends on. If the restart closed
    // the intent by assumption rather than by probe evidence, deleting the
    // evidence would change nothing. It changes everything: the probe answers
    // NOT_DONE, `closeIntent` applies again, and the port records a second
    // start — a non-idempotent replay, caught.
    ensureChildBuilt();
    const taskId = "e0000000-0000-4000-8000-00000000000f";
    TASK_ID_IN_PLAY = taskId;
    const invocation = invocationFor(taskId);
    const scenarioId = "execution-evidence-removed";
    const root = scenario(scenarioId);

    const killed = await runChildProcess(scenarioId, invocation, "AFTER_EFFECT", "EXECUTION");
    expect(killed.signal).toBe("SIGKILL");
    expect(executionStarts(root)).toBe(1);
    const evidence = executionEvidence(root);
    expect(evidence).toHaveLength(1);

    // Remove exactly the probe's evidence and nothing else.
    rmSync(join(root, "executions", evidence[0] ?? ""), { force: true });
    expect(executionEvidence(root)).toHaveLength(0);

    const restarted = await runChildProcess(scenarioId, invocation, null, "EXECUTION");
    expect(restarted.code).toBe(0);

    // Executed twice. The ledger is still sound -- the outcome is appended once,
    // because the ledger's idempotency is a separate guarantee -- which is
    // precisely why the effect's own idempotency needed its own proof.
    expect(executionStarts(root)).toBe(2);
    expect(snapshot(scenarioLedgerPath(root)).eventCount).toBe(LIFECYCLE_PLAN.length);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    expect(ledger.verifyIntegrity().ok).toBe(true);
  }, 120_000);

  it("restore: the same drill over the toy leaves no execution evidence at all", async () => {
    // The restore half, and the reason the assertions above discriminate. Point
    // the child back at the toy and the new evidence assertions cannot hold:
    // there is no `executions/` directory, no digest-keyed marker and no start
    // log, because nothing was drained. A packet whose assertions still passed
    // here would have re-run the old drill under a new name.
    ensureChildBuilt();
    const taskId = "e0000000-0000-4000-8000-0000000000f0";
    TASK_ID_IN_PLAY = taskId;
    const invocation = invocationFor(taskId);
    const scenarioId = "execution-restore-toy";
    const root = scenario(scenarioId);

    const killed = await runChildProcess(scenarioId, invocation, "AFTER_EFFECT", "TOY");
    expect(killed.signal).toBe("SIGKILL");

    expect(executionEvidence(root)).toHaveLength(0);
    expect(executionStarts(root)).toBe(0);
    expect(effectMarkerCount(root)).toBe(1);
  }, 120_000);
});


/**
 * Why the SQLite supervisor declares SERIALIZED_PER_TASK: "UNSUPPORTED"
 * (V2-B2-3).
 *
 * This is the honest negative that justifies the declaration rather than a
 * missing feature apologised for. Two walks of the same task, running at once
 * with nothing between them, both probe the effect as NOT_DONE and both perform
 * it. The ledger stays sound throughout — its idempotency key refuses the
 * duplicate append — so what is lost is not integrity but the effect's
 * single-execution guarantee, which is precisely what per-task serialization
 * would buy and precisely what this driver cannot offer.
 *
 * It cannot offer it because the only guards that would work span processes: a
 * lock table, a lease keyed on the task, a pid file. Every one of them is a
 * durable record of who is running, which is the second account of execution
 * position this driver refuses by design — `sqlite-supervisor/index.ts` says so
 * where the cursor would have gone. An in-process latch would be lawful and
 * would catch nothing that matters, because the concurrency that threatens a
 * SQLite deployment is two daemons rather than two objects in one heap.
 *
 * So the declaration is the truthful one, and this drill is the reason.
 */
describe("SQLite does not serialize per task, and says so", () => {
  it("declares SERIALIZED_PER_TASK UNSUPPORTED", () => {
    expect(capabilitySubject().capabilities().properties).toEqual({
      SERIALIZED_PER_TASK: "UNSUPPORTED",
    });
  });

  it("two concurrent walks of one task perform the effect twice, and the ledger still holds", async () => {
    const taskId = "5e21a112-0000-4000-8000-000000000001";
    const root = scenario("sqlite-no-serialization");
    const invocation = invocationFor(taskId);

    // Two supervisors, two handles on the same ledger file, one task. No guard
    // stands between them, which is the fact under test.
    const ledgerA = track(openLedger(scenarioLedgerPath(root)));
    const ledgerB = track(openLedger(scenarioLedgerPath(root)));

    // A barrier that holds the first walk inside `apply` until the second has
    // also entered it. This does not CREATE the race — it schedules it. Both
    // walks probe NOT_DONE before either writes evidence, which is exactly what
    // two processes do when neither can see the other, and nothing in this
    // driver prevents it. Forcing the order makes the drill deterministic
    // instead of dependent on how the event loop happened to interleave.
    let applies = 0;
    let bothInside: () => void = () => undefined;
    const barrier = new Promise<void>((release) => {
      bothInside = release;
    });
    const countingEffects = (): EffectPort => ({
      apply: async (operation) => {
        applies += 1;
        if (applies >= 2) bothInside();
        await barrier;
        applyEffect(root, operation);
      },
      probe: (operation) => Promise.resolve(probeEffect(root, operation)),
    });

    const walk = (ledger: Ledger): Promise<unknown> =>
      new SqliteSupervisor({
        ledger,
        invocation,
        effects: countingEffects(),
        checkpoints: drillCheckpoints({
          ledger,
          invocation,
          emittedBy: EMITTED_BY,
          ledgerPath: scenarioLedgerPath(root),
          worktree: root,
        }),
        emittedBy: EMITTED_BY,
        commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
        initiativeId: TEST_INITIATIVE_ID,
        route: TEST_ROUTE,
      })
        .runToCheckpoint()
        // One of the two will lose a race on an append and refuse; that is the
        // ledger defending itself, and it is not what this drill measures.
        .catch(() => null);

    await Promise.all([walk(ledgerA), walk(ledgerB)]);

    // The effect ran more than once. This is the whole claim, and it is why the
    // capability is declared UNSUPPORTED rather than assumed.
    expect(applies).toBeGreaterThan(1);

    // And the ledger is undamaged: one plan, no duplicate keys, integrity clean.
    // Serialization is a property of the effect, not of the log.
    const keys = ledgerA.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    expect(ledgerA.verifyIntegrity().ok).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// V2-B7T: settlement fires on the failure path and on no other
// ---------------------------------------------------------------------------

/**
 * The settlement's call site, from the supervisor's side.
 *
 * What is asserted here is the half that is reachable. The bound guard itself
 * — `guard <= plan.length + 1` — cannot be reached through the public API
 * against a consistent ledger: both plans converge in exactly `plan.length + 1`
 * iterations, leaving one spare, the only non-advancing step is the OUTCOME
 * beat (which advances as soon as its event exists), and `closeIntent` throws
 * rather than looping when a probe will not settle. Measured, not assumed. So
 * the guard is defensive, and the drills below prove what a real walk can
 * actually produce: that settlement does **not** fire when the walk converges,
 * and does **not** fire when the walk throws for a different reason.
 *
 * That the exhaustion path calls `settleFailure` at all is held by the fence
 * law L-B7T-1, with a failing fixture. A law is the right instrument precisely
 * because the path is unreachable by construction — a test could only reach it
 * through a ledger that contradicts itself.
 */
describe("terminal settlement (V2-B7T)", () => {
  it("appends no TASK_FAILED when the walk reaches its terminal", async () => {
    const root = scenario("b7t-converges");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const inv = invocationFor(TASK_IDS[0]);

    const run = await new SqliteSupervisor({
      ledger,
      invocation: inv,
      effects: toyEffects(root),
      checkpoints: drillCheckpoints({
        ledger,
        invocation: inv,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
      emittedBy: EMITTED_BY,
      commitPolicy: "NO_COMMIT",
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    }).runToCheckpoint();

    expect(run.finalState).toBe("CHECKPOINTED");
    const types = ledger.listEvents({ taskId: TASK_IDS[0], limit: 200 }).events.map((e) => e.event.type);
    expect(types).not.toContain("TASK_FAILED");
    expect(ledger.getTask(TASK_IDS[0])?.currentState).toBe("CHECKPOINTED");
  });

  it("appends no TASK_FAILED when the postcondition cannot be established (N2)", async () => {
    // `closeIntent` throws `PostconditionUnknownError` before the bound is ever
    // approached. Nothing settles, and the intent is left open for an operator
    // — the one claim ADR 0004 §3 exists to prevent is not made.
    const root = scenario("b7t-unknown-postcondition");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const inv = invocationFor(TASK_IDS[1]);

    const stubborn: EffectPort = {
      apply: () => Promise.resolve(),
      probe: () => Promise.resolve("UNKNOWN"),
    };

    await expect(
      new SqliteSupervisor({
        ledger,
        invocation: inv,
        effects: stubborn,
        checkpoints: drillCheckpoints({
          ledger,
          invocation: inv,
          emittedBy: EMITTED_BY,
          ledgerPath: scenarioLedgerPath(root),
          worktree: root,
        }),
        emittedBy: EMITTED_BY,
        commitPolicy: "NO_COMMIT",
        initiativeId: TEST_INITIATIVE_ID,
        route: TEST_ROUTE,
      }).runToCheckpoint(),
    ).rejects.toThrow(PostconditionUnknownError);

    const types = ledger.listEvents({ taskId: TASK_IDS[1], limit: 200 }).events.map((e) => e.event.type);
    expect(types).not.toContain("TASK_FAILED");
    expect(types).toContain("RUN_STARTED");
    expect(ledger.getTask(TASK_IDS[1])?.currentState).toBe("RUNNING");
  });
});

// ---------------------------------------------------------------------------
// V2-B7R: a classified step failure settles on this driver too
// ---------------------------------------------------------------------------

/**
 * The symmetry half of D-B7R-1 = β.
 *
 * A Restate-only settlement would have made Restate settle a classified step
 * failure where SQLite does not — creating exactly the driver divergence the B7
 * wave exists to close. Both lanes ask `classifyFailure` the same question, so
 * the only way they can answer differently is if one of them stops calling it,
 * and the fence laws hold both call sites.
 */
function failingEffects(root: ScenarioRoot, failure: Error): EffectPort {
  return {
    apply: () => Promise.reject(failure),
    probe: (operation) => Promise.resolve(probeEffect(root, operation)),
  };
}

describe("classified step failure settles (V2-B7R)", () => {
  it("P1: appends exactly one TASK_FAILED and re-throws the original error", async () => {
    const root = scenario("b7r-sqlite-settles");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const inv = invocationFor(TASK_IDS[2]);
    const failure = new ExecutionEffectError("ROUTE_INVALID", "route.accountId");

    const thrown = await new SqliteSupervisor({
      ledger,
      invocation: inv,
      effects: failingEffects(root, failure),
      checkpoints: drillCheckpoints({
        ledger,
        invocation: inv,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
      emittedBy: EMITTED_BY,
      commitPolicy: "NO_COMMIT",
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    }).runToCheckpoint().then(() => null, (error: unknown) => error);

    // C4 — the ORIGINAL error, not a settlement-shaped replacement.
    expect(thrown).toBe(failure);

    const failures = ledger.listEvents({ taskId: TASK_IDS[2], limit: 200 }).events.filter((e) => e.event.type === "TASK_FAILED");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.event.toState).toBe("FAILED");
    expect(failures[0]?.event.fromState).toBe("RUNNING");
    expect(failures[0]?.event.payload["reason"]).toBe("EXECUTION_FAILED");
    expect(Object.keys(failures[0]?.event.payload ?? {}).sort()).toEqual(["reason", "submissionDigest"]);
    expect(ledger.getTask(TASK_IDS[2])?.currentState).toBe("FAILED");
  });

  it("N1: POSTCONDITION_UNKNOWN settles nothing here either", async () => {
    const root = scenario("b7r-sqlite-unknown");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const inv = invocationFor(TASK_IDS[3]);

    await expect(
      new SqliteSupervisor({
        ledger,
        invocation: inv,
        effects: failingEffects(root, new PostconditionUnknownError("op", "unknown")),
        checkpoints: drillCheckpoints({
          ledger,
          invocation: inv,
          emittedBy: EMITTED_BY,
          ledgerPath: scenarioLedgerPath(root),
          worktree: root,
        }),
        emittedBy: EMITTED_BY,
        commitPolicy: "NO_COMMIT",
        initiativeId: TEST_INITIATIVE_ID,
        route: TEST_ROUTE,
      }).runToCheckpoint(),
    ).rejects.toThrow(PostconditionUnknownError);

    const types = ledger.listEvents({ taskId: TASK_IDS[3], limit: 200 }).events.map((e) => e.event.type);
    expect(types).not.toContain("TASK_FAILED");
    expect(types).toContain("RUN_STARTED");
    expect(ledger.getTask(TASK_IDS[3])?.currentState).toBe("RUNNING");
  });

  it("P4: a continuity failure in the prologue settles nothing, with zero delta", async () => {
    // C2 on this lane: `assertInvocationContinuity` runs before the try, so a
    // disputed identity produces no settlement and no delta at all.
    const root = scenario("b7r-sqlite-prologue");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const inv = invocationFor(TASK_IDS[4]);

    // A first walk establishes step 0 under one submission...
    await new SqliteSupervisor({
      ledger, invocation: inv, effects: toyEffects(root), emittedBy: EMITTED_BY,
      checkpoints: drillCheckpoints({
        ledger,
        invocation: inv,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
      commitPolicy: "NO_COMMIT", initiativeId: TEST_INITIATIVE_ID, route: TEST_ROUTE,
    }).runToCheckpoint();
    const before = ledger.status();

    // ...and a different submission under the same coordinates is refused.
    const impostor = { ...inv, submissionDigest: "f".repeat(64) };
    await expect(
      new SqliteSupervisor({
        ledger, invocation: impostor, effects: toyEffects(root), emittedBy: EMITTED_BY,
        commitPolicy: "NO_COMMIT", initiativeId: TEST_INITIATIVE_ID, route: TEST_ROUTE,
      }).runToCheckpoint(),
    ).rejects.toThrow(SupervisorError);

    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
    expect(ledger.listEvents({ limit: 200 }).events.map((e) => e.event.type)).not.toContain("TASK_FAILED");
  });
});

/**
 * The lifecycle construction (V2 L2).
 *
 * A door that cancels holds no commit policy and has no evidence for one, so
 * the driver it constructs must not demand one. What is proved here is that the
 * narrowing costs nothing an operator could observe: the object is the real
 * class, it declares what it always declared, it refuses what it always
 * refused — and it will not walk a plan, because it has none.
 */
describe("a supervisor built for the lifecycle verbs", () => {
  function lifecycleSubject(name: string): SqliteSupervisor {
    const root = scenario(name);
    return SqliteSupervisor.forLifecycle({
      ledger: track(openLedger(scenarioLedgerPath(root))),
      invocation: INVOCATION_FOR_CAPABILITIES,
      effects: toyEffects(root),
      emittedBy: EMITTED_BY,
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
    });
  }

  it("is the real driver: same class, same mode, same declaration", () => {
    const subject = lifecycleSubject("lifecycle-real-object");
    expect(subject).toBeInstanceOf(SqliteSupervisor);
    expect(subject.mode).toBe("SQLITE_SUPERVISOR");
    expect(subject.capabilities()).toEqual(capabilitySubject().capabilities());
  });

  /** The four verbs, observed on the object a door actually constructs. */
  const observedOn = async (driver: OrchestrationDriver) => ({
    CANCEL: await driver.cancel(INVOCATION_FOR_CAPABILITIES),
    REATTACH: await driver.reattach(INVOCATION_FOR_CAPABILITIES),
    SIGNAL: await driver.signal(INVOCATION_FOR_CAPABILITIES),
    TIMER: await driver.timer(INVOCATION_FOR_CAPABILITIES, 1_000),
  });

  it("satisfies the correspondence law, so the refusal a door meets is honest", async () => {
    const subject = lifecycleSubject("lifecycle-correspondence");
    expect(driverCapabilityMismatches(subject.capabilities(), await observedOn(subject))).toEqual([]);
  });

  it("is non-vacuous: a declaration claiming CANCEL is supported is caught", async () => {
    const subject = lifecycleSubject("lifecycle-correspondence-lying");
    const declared = subject.capabilities();
    const lying = { ...declared, verbs: { ...declared.verbs, CANCEL: "SUPPORTED" as const } };
    expect(driverCapabilityMismatches(lying, await observedOn(subject))).toEqual([
      "CANCEL: declared SUPPORTED but refused",
    ]);
  });

  it("refuses both lifecycle verbs by their own names, and appends nothing", async () => {
    const subject = lifecycleSubject("lifecycle-refusals");
    await expect(subject.cancel()).resolves.toEqual({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "cancel",
    });
    await expect(subject.reattach()).resolves.toEqual({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "reattach",
    });
  });

  it("walks no plan, and says so rather than running out of one", async () => {
    const subject = lifecycleSubject("lifecycle-no-walk");
    await expect(subject.advance(INVOCATION_FOR_CAPABILITIES, "DISCOVERED")).rejects.toThrow(
      SupervisorError,
    );
    await expect(subject.runToCheckpoint()).rejects.toThrow(SupervisorError);
  });

  it("takes no commit policy, which is the whole of the narrowing", () => {
    // One argument, and nothing in it names a policy. A construction that
    // accepted one would be a door inventing a value at the seam where commit
    // capability is decided.
    expect(SqliteSupervisor.forLifecycle.length).toBe(1);
    const code = readFileSync(
      resolve(PACKAGE_ROOT, "src", "drivers", "sqlite-supervisor", "index.ts"),
      "utf8",
    );
    const declaration = /export interface SqliteSupervisorLifecycleOptions \{([\s\S]*?)\n\}/.exec(code);
    expect(declaration).not.toBeNull();
    expect(declaration?.[1] ?? "").not.toContain("commitPolicy");
  });
});

// ---------------------------------------------------------------------------
// N12 — a child spawned without checkpointFacts refuses at its terminal
// ---------------------------------------------------------------------------

describe("N12: a child with no git facts has no checkpoint port, and its terminal refuses", () => {
  it("exits non-zero naming the absent port, appends no CHECKPOINT_WRITTEN, and leaves the head where the walk stopped", async () => {
    // The production law, drilled in a real child process rather than read off
    // the source. `checkpointFacts` is omitted from the config entirely — the
    // shape a caller that never observed a worktree would produce — so the
    // parser yields `null`, the composition binds no member, and the terminal
    // beat refuses exactly as the production daemon does when its observation
    // cannot be taken.
    ensureChildBuilt();
    const taskId = "55555555-5555-4555-8555-555555555501";
    TASK_ID_IN_PLAY = taskId;
    const invocation = invocationFor(taskId);
    const id = "f3-n12-no-facts";
    const root = scenario(id);
    const ledgerPath = scenarioLedgerPath(root);

    let message = "";
    try {
      await runChildProcess(id, invocation, null, "TOY", "OMITTED");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    // The child died on the refusal, and the refusal names what was missing.
    expect(message).toContain("this walk has no checkpoint port");
    expect(message).toContain("checkpointed");

    const refused = snapshot(ledgerPath);
    // Nine steps happened; the tenth did not.
    const ledger = track(openLedger(ledgerPath, { readOnly: true }));
    const types = ledger.listEvents({ limit: 200 }).events.map((entry) => entry.event.type);
    expect(types).not.toContain("CHECKPOINT_WRITTEN");
    // The head IS the pre-terminal event: the plan's penultimate step, and
    // nothing after it.
    const penultimate = LIFECYCLE_PLAN[LIFECYCLE_PLAN.length - 2];
    const head = ledger.listEvents({ limit: 200 }).events.at(-1);
    expect(head?.event.transitionId).toBe(penultimate?.transitionId);
    expect(refused.state).not.toBe("CHECKPOINTED");
    expect(refused.eventCount).toBe(LIFECYCLE_PLAN.length - 1);

    // Nothing was published either: the artifact root under this ledger does
    // not exist, so no digest was written that no event names.
    expect(existsSync(artifactRootFor(ledgerPath))).toBe(false);

    // And the refusal is stable: a second run of the same child appends
    // nothing more and leaves the head exactly where the first one did.
    let second = "";
    try {
      await runChildProcess(id, invocation, null, "TOY", "OMITTED");
    } catch (error: unknown) {
      second = error instanceof Error ? error.message : String(error);
    }
    expect(second).toContain("this walk has no checkpoint port");
    const again = snapshot(ledgerPath);
    expect(again.eventCount).toBe(refused.eventCount);
    expect(again.headEventSha256).toBe(refused.headEventSha256);

    // The control that makes all of the above mean something: the SAME child,
    // the SAME coordinates, spawned WITH the facts, finishes the walk.
    const completed = await runChildProcess(id, invocation, null, "TOY", "OBSERVED");
    expect(completed.code).toBe(0);
    const done = snapshot(ledgerPath);
    expect(done.state).toBe("CHECKPOINTED");
    expect(done.eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(done.headEventSha256).not.toBe(refused.headEventSha256);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// V2-B1f/F4d — the fork before the settle
// ---------------------------------------------------------------------------

/**
 * The one moment a switch can be played, and what the fork must not disturb.
 *
 * A classified failure is offered to the switch port **before** it settles. A
 * port that played a switch means the walk must not settle — the attempt is
 * now blocked awaiting a landing, and a terminal event would foreclose it.
 * `SWITCHED` means *do not settle*; it never means *do not fail*.
 */

const F4D_SUPERVISOR_TASKS = [
  "f4d10000-0000-4000-8000-000000000001",
  "f4d10000-0000-4000-8000-000000000002",
  "f4d10000-0000-4000-8000-000000000003",
  "f4d10000-0000-4000-8000-000000000004",
] as const;

function supervisorWithPort(
  scenarioId: string,
  taskId: string,
  failure: ExecutionEffectError,
  switchPort: SwitchPort | undefined,
): { supervisor: SqliteSupervisor; ledger: Ledger } {
  const root = scenario(scenarioId);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  const inv = invocationFor(taskId);
  return {
    supervisor: new SqliteSupervisor({
      ledger,
      invocation: inv,
      effects: failingEffects(root, failure),
      checkpoints: drillCheckpoints({
        ledger,
        invocation: inv,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
      emittedBy: EMITTED_BY,
      commitPolicy: "NO_COMMIT",
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
      ...(switchPort === undefined ? {} : { switchPort }),
    }),
    ledger,
  };
}

describe("F4d P6: the supervisor forks before it settles", () => {
  it("SWITCHED skips the settlement, and still throws the original error", async () => {
    const failure = new ExecutionEffectError("ROUTE_INVALID", "route.accountId");
    let asked = 0;
    const { supervisor, ledger } = supervisorWithPort(
      "f4d-supervisor-switched",
      F4D_SUPERVISOR_TASKS[0],
      failure,
      {
        consider: (context) => {
          asked += 1;
          // The port is handed the walk's own context: its ledger, its
          // invocation, its identity.
          expect(context.invocation.taskId).toBe(F4D_SUPERVISOR_TASKS[0]);
          return Promise.resolve({ kind: "SWITCHED", startedEventId: "ev-started" });
        },
      },
    );

    const thrown = await supervisor.runToCheckpoint().then(() => null, (error: unknown) => error);

    // Failing is unchanged; settling is what a played switch suppresses.
    expect(thrown).toBe(failure);
    expect(asked).toBe(1);
    const types = ledger
      .listEvents({ taskId: F4D_SUPERVISOR_TASKS[0], limit: 200 })
      .events.map((entry) => entry.event.type);
    expect(types).not.toContain("TASK_FAILED");
    expect(ledger.getTask(F4D_SUPERVISOR_TASKS[0])?.currentState).not.toBe("FAILED");
  });

  it("NOT_SWITCHED settles exactly as it did before this packet", async () => {
    const failure = new ExecutionEffectError("ROUTE_INVALID", "route.accountId");
    const { supervisor, ledger } = supervisorWithPort(
      "f4d-supervisor-declined",
      F4D_SUPERVISOR_TASKS[1],
      failure,
      { consider: () => Promise.resolve({ kind: "NOT_SWITCHED", reason: "NO_AUTHORIZATION" }) },
    );

    const thrown = await supervisor.runToCheckpoint().then(() => null, (error: unknown) => error);

    expect(thrown).toBe(failure);
    const failures = ledger
      .listEvents({ taskId: F4D_SUPERVISOR_TASKS[1], limit: 200 })
      .events.filter((entry) => entry.event.type === "TASK_FAILED");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.event.payload["reason"]).toBe("EXECUTION_FAILED");
    expect(ledger.getTask(F4D_SUPERVISOR_TASKS[1])?.currentState).toBe("FAILED");
  });

  it("no port at all is byte-identical to a declined one", async () => {
    // What keeps every landed construction — both drill children and every
    // lifecycle verb — behaving exactly as it did.
    const failure = new ExecutionEffectError("ROUTE_INVALID", "route.accountId");
    const { supervisor, ledger } = supervisorWithPort(
      "f4d-supervisor-no-port",
      F4D_SUPERVISOR_TASKS[2],
      failure,
      undefined,
    );

    const thrown = await supervisor.runToCheckpoint().then(() => null, (error: unknown) => error);

    expect(thrown).toBe(failure);
    const failures = ledger
      .listEvents({ taskId: F4D_SUPERVISOR_TASKS[2], limit: 200 })
      .events.filter((entry) => entry.event.type === "TASK_FAILED");
    expect(failures).toHaveLength(1);
    expect(ledger.getTask(F4D_SUPERVISOR_TASKS[2])?.currentState).toBe("FAILED");
  });

  it("a failure that would not settle never reaches the port", async () => {
    // The fork is gated on `decision.settle`, so a postcondition-unknown — the
    // one failure that must never settle — is not offered a switch either.
    const root = scenario("f4d-supervisor-unknown");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const inv = invocationFor(F4D_SUPERVISOR_TASKS[3]);
    let asked = 0;

    await expect(
      new SqliteSupervisor({
        ledger,
        invocation: inv,
        effects: {
          apply: () => Promise.reject(new PostconditionUnknownError("op", "unknown")),
          probe: (operation) => Promise.resolve(probeEffect(root, operation)),
        },
        checkpoints: drillCheckpoints({
          ledger,
          invocation: inv,
          emittedBy: EMITTED_BY,
          ledgerPath: scenarioLedgerPath(root),
          worktree: root,
        }),
        emittedBy: EMITTED_BY,
        commitPolicy: "NO_COMMIT",
        initiativeId: TEST_INITIATIVE_ID,
        route: TEST_ROUTE,
        switchPort: {
          consider: () => {
            asked += 1;
            return Promise.resolve({ kind: "SWITCHED", startedEventId: "ev" });
          },
        },
      }).runToCheckpoint(),
    ).rejects.toBeInstanceOf(PostconditionUnknownError);

    expect(asked).toBe(0);
  });
});

describe("F4d B4(a): a partial play is not resumed", () => {
  it("a second run over a blocked attempt refuses PLAN, settles nothing, forges nothing", async () => {
    // **The ruling, and its measured consequence.** A crash between the
    // switch's rows leaves the attempt at `QUOTA_BLOCKED` with its INTENT
    // open. On restart `nextStep` finds no step for that state and throws a
    // plan error, which `classifyFailure` refuses to settle — so the walk
    // stops visibly rather than settling a task a landing is still owed, and
    // it appends no `ACCOUNT_SWITCH_STARTED` it did not earn.
    //
    // The operator's exit is the cancel verb, which proceeds from any
    // non-terminal state. Resuming instead would need the executor to skip
    // rows already durable — a behaviour change this packet does not make.
    const failure = new ExecutionEffectError("ROUTE_INVALID", "route.accountId");
    const { supervisor, ledger } = supervisorWithPort(
      "f4d-partial-play",
      F4D_SUPERVISOR_TASKS[0],
      failure,
      {
        consider: (context) => {
          // Play only the first row, then stop — the crash shape.
          const task = context.ledger.getTask(context.invocation.taskId);
          executeSwitchPlan({
            ledger: context.ledger,
            invocation: context.invocation,
            plan: {
              kind: "SWITCH",
              accountStatus: "EXHAUSTED",
              taskState: "QUOTA_BLOCKED",
              steps: ["MARK_TASK_QUOTA_BLOCKED"],
              selectedAccountId: "acct-second",
              events: [{ type: "TASK_STATE_CHANGED", payload: { toState: "QUOTA_BLOCKED" } }],
            },
            emittedBy: EMITTED_BY,
            lease: null,
            taskState: task?.currentState ?? "RUNNING",
            causedBy: null,
          });
          return Promise.resolve({ kind: "SWITCHED", startedEventId: "ev-partial" });
        },
      },
    );

    await supervisor.runToCheckpoint().then(() => null, () => null);
    expect(ledger.getTask(F4D_SUPERVISOR_TASKS[0])?.currentState).toBe("QUOTA_BLOCKED");

    // The second run: the attempt is blocked, and nothing resumes it.
    const second = supervisorWithPort(
      "f4d-partial-play",
      F4D_SUPERVISOR_TASKS[0],
      failure,
      { consider: () => Promise.resolve({ kind: "NOT_SWITCHED", reason: "NO_AUTHORIZATION" }) },
    );
    const thrown = await second.supervisor
      .runToCheckpoint()
      .then(() => null, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    const events = ledger.listEvents({ taskId: F4D_SUPERVISOR_TASKS[0], limit: 200 }).events;
    const types = events.map((entry) => entry.event.type);
    // Not settled, and not forged.
    expect(types).not.toContain("TASK_FAILED");
    expect(types).not.toContain("ACCOUNT_SWITCH_STARTED");
    expect(ledger.getTask(F4D_SUPERVISOR_TASKS[0])?.currentState).toBe("QUOTA_BLOCKED");
  });
});
