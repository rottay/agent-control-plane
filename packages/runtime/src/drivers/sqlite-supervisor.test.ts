import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../contracts.js";
import { buildEvent, operationForStep } from "../core/events.js";
import { applyEffect } from "../toy/repository.js";
import { INTENT_STEP, LIFECYCLE_PLAN } from "../core/lifecycle.js";
import { PostconditionUnknownError, SupervisorError } from "../errors.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../toy/repository.js";
import type { ScenarioRoot } from "../toy/repository.js";
import { SqliteSupervisor } from "./sqlite-supervisor.js";
import type { FaultPoint } from "./sqlite-supervisor.js";

/**
 * Evidence for the SQLite supervisor.
 *
 * The kill/restart scenarios use real child processes terminated with SIGKILL.
 * An exception caught in-process would prove nothing: the page cache, the open
 * database handle and every JavaScript object survive a thrown error, which is
 * exactly what a crash does not leave behind.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "drivers", "sqlite-supervisor-child.js");

const EMITTED_BY = "claude/opus/implementer/01";

const scenarios: string[] = [];
const spawnedPids: number[] = [];
const openLedgers: Ledger[] = [];

function invocationFor(seed: string): DurableInvocation {
  return {
    taskId: seed,
    attempt: 1,
    invocationId: "inv-" + seed.slice(0, 8),
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
): Promise<ChildOutcome> {
  const config = JSON.stringify({ scenarioId, invocation, emittedBy: EMITTED_BY, faultPoint });
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
    supervisor: new SqliteSupervisor({ ledger, invocation, scenarioRoot: root, emittedBy: EMITTED_BY }),
    ledger,
    root,
    invocation,
  };
}

describe("the supervisor", () => {
  it("drives the plan to CHECKPOINTED and appends one event per step", () => {
    const taskId: string = TASK_IDS[3];
    const { supervisor, ledger } = supervisorFor("supervisor-happy", taskId);
    const result = supervisor.runToCheckpoint();
    expect(result.finalState).toBe("CHECKPOINTED");
    expect(ledger.status().eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");
  });

  it("treats a second full run as an exact replay that appends nothing", () => {
    const taskId: string = TASK_IDS[4];
    const { supervisor, ledger, invocation } = supervisorFor("supervisor-replay", taskId);
    supervisor.runToCheckpoint();
    const before = ledger.status();

    supervisor.runToCheckpoint();
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);

    // Re-appending every plan event directly must be an exact replay.
    for (const step of LIFECYCLE_PLAN) {
      const event = buildEvent({ invocation, step, emittedBy: EMITTED_BY });
      expect(step.transitionId + ":" + String(ledger.append(event).inserted)).toBe(
        step.transitionId + ":false",
      );
    }
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
  });

  it("fails closed when a changed body reuses an idempotency key", () => {
    const taskId: string = TASK_IDS[5];
    const { supervisor, ledger, invocation } = supervisorFor("supervisor-conflict", taskId);
    supervisor.runToCheckpoint();

    const step = LIFECYCLE_PLAN[0];
    if (step === undefined) throw new Error("no plan");
    const tampered = {
      ...buildEvent({ invocation, step, emittedBy: EMITTED_BY }),
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

  it("refuses to append an outcome when the postcondition is UNKNOWN", () => {
    const taskId = TASK_IDS[0];
    const { supervisor, ledger, root, invocation } = supervisorFor("supervisor-unknown", taskId);

    // Put the ledger in exactly the state a crash between the effect and the
    // outcome leaves behind: the intent is recorded, the task is RUNNING, and
    // no outcome exists. Then make the marker unreadable to the probe.
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY }));
    }
    expect(ledger.getTask(taskId)?.currentState).toBe("RUNNING");

    const operation = operationForStep(invocation, INTENT_STEP);
    const marker = join(root, "effects", operation.operationId + ".marker");
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    // Written through the filesystem, not through applyEffect, which refuses.
    writeFileSync(marker, "written by something else", "utf8");

    let caught: unknown = null;
    try {
      supervisor.runToCheckpoint();
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
    supervisor.runToCheckpoint();

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

  it("surfaces a failed append instead of retrying around it", () => {
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
      scenarioRoot: root,
      emittedBy: EMITTED_BY,
    });

    const started = Date.now();
    let message = "";
    try {
      supervisor.runToCheckpoint();
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
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY }));
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
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY }));
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
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY }));
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

  it("fails closed when the same coordinates carry a different submission", () => {
    const taskId = "77777777-7777-4777-8777-777777777774";
    const { supervisor, ledger, root, invocation } = supervisorFor("submission-conflict", taskId);
    supervisor.runToCheckpoint();

    const headBefore = ledger.status().headEventSha256;
    const countBefore = ledger.status().eventCount;
    const markersBefore = effectMarkerCount(root);

    // Same task, attempt, invocation and transition -- a different payload.
    const resubmitted = { ...invocation, submissionDigest: "9".repeat(64) };
    const step = LIFECYCLE_PLAN[0];
    if (step === undefined) throw new Error("no plan");

    let name = "";
    try {
      ledger.append(buildEvent({ invocation: resubmitted, step, emittedBy: EMITTED_BY }));
    } catch (error: unknown) {
      name = error instanceof Error ? error.name : "";
    }
    expect(name).toBe("LedgerIdempotencyConflictError");
    expect(ledger.status().headEventSha256).toBe(headBefore);
    expect(ledger.status().eventCount).toBe(countBefore);
    expect(effectMarkerCount(root)).toBe(markersBefore);

    // The original submission still replays exactly.
    expect(ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY })).inserted).toBe(
      false,
    );
    expect(ledger.status().headEventSha256).toBe(headBefore);
  });

  it("has no import side effects", async () => {
    const before = effectMarkerCount(join(REPO_ROOT, ".acp-local", "drills"));
    const module = await import("../index.js");
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
    { label: "invocationId", mutate: (i) => ({ ...i, invocationId: "inv-other" }) },
    { label: "submittedAt", mutate: (i) => ({ ...i, submittedAt: "2026-08-27T13:00:00.000Z" }) },
  ];

  for (const [index, { label, mutate }] of MISMATCHES.entries()) {
    it("refuses to resume an in-flight attempt under a changed " + label, () => {
      const taskId = "99999999-9999-4999-8999-99999999999" + String(index);
      const { supervisor, ledger, root, invocation } = supervisorFor(
        "resume-mismatch-" + label.toLowerCase(),
        taskId,
      );

      // Leave the task exactly mid-flight: intent recorded, effect applied,
      // outcome outstanding.
      for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) {
        ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY }));
      }
      applyEffect(root, operationForStep(invocation, INTENT_STEP));

      const headBefore = ledger.status().headEventSha256;
      const countBefore = ledger.status().eventCount;
      const markersBefore = effectMarkerCount(root);
      expect(markersBefore).toBe(1);

      const intruder = new SqliteSupervisor({
        ledger,
        invocation: mutate(invocation),
        scenarioRoot: root,
        emittedBy: EMITTED_BY,
      });
      expect(() => intruder.runToCheckpoint()).toThrow(SupervisorError);

      // Nothing moved: no event, no outcome, no second effect.
      expect(ledger.status().headEventSha256).toBe(headBefore);
      expect(ledger.status().eventCount).toBe(countBefore);
      expect(ledger.getEventByIdempotencyKey(taskId + "/1/run.outcome")).toBeNull();
      expect(ledger.getEventByIdempotencyKey(taskId + "/2/run.outcome")).toBeNull();
      expect(ledger.getTask(taskId)?.latestAttempt).toBe(1);
      expect(effectMarkerCount(root)).toBe(markersBefore);

      // The original submission still finishes its own work.
      expect(supervisor.runToCheckpoint().finalState).toBe("CHECKPOINTED");
      expect(ledger.status().eventCount).toBe(LIFECYCLE_PLAN.length);
      expect(effectMarkerCount(root)).toBe(1);
      expect(ledger.verifyIntegrity().ok).toBe(true);
    });
  }

  it("still treats an identical resubmission as an exact replay", () => {
    const taskId = "99999999-9999-4999-8999-999999999998";
    const { supervisor, ledger, root, invocation } = supervisorFor("resume-identical", taskId);
    supervisor.runToCheckpoint();
    const head = ledger.status().headEventSha256;

    const twin = new SqliteSupervisor({
      ledger,
      invocation: { ...invocation },
      scenarioRoot: root,
      emittedBy: EMITTED_BY,
    });
    expect(twin.runToCheckpoint().finalState).toBe("CHECKPOINTED");
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
      ledger.append(buildEvent({ invocation, step, emittedBy: EMITTED_BY }));
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
    expect(supervisor.runToCheckpoint().finalState).toBe("CHECKPOINTED");
  });
});
