import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../../src/contracts/index.js";
import { READ_ONLY_PLAN } from "../../../src/core/lifecycle/index.js";
import type { FaultPoint } from "../../../src/drivers/sqlite-supervisor/index.js";
import { acquireLease, checkWriteSetConformance } from "../../../src/enforcement/index.js";
import type { EnforcementRefused, LeaseGranted } from "../../../src/enforcement/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../../src/toy/repository/index.js";
import {
  PILOT_VERIFIER,
  PILOT_WRITER,
  TOY_NOTES_PATH,
  TOY_README_PATH,
  TOY_SCRATCH_PATH,
  createGitReadPort,
  takeObservation,
  writeToyContent,
} from "../helpers/index.js";
import type { SpawnGit, SpawnResult } from "../helpers/index.js";
import {
  RECOVERY_FAULT_SCENARIOS,
  RECOVERY_LEASE_ACQUIRED_AT,
  RECOVERY_LEASE_EXPIRES_AT,
  countEffectMarkers,
  readLedgerSnapshot,
  recoveryInvocation,
} from "./helpers/index.js";

/**
 * P7B leg 1: kill/restart of the read-only packet walk, over a real child
 * process, SIGKILLed mid-plan and resumed to `CHECKPOINTED`.
 *
 * P2 proved kill/restart 3/3 under `LOCAL_COMMIT_WITH_RECEIPT`; P7A proved the
 * `NO_COMMIT` walk and the envelope/lease/conformance spine in-process. This
 * file is the new evidence: the same real-process kill matrix P2 proved,
 * walking the `NO_COMMIT` plan instead, with the pilot invariants re-proven on
 * the recovered ledger and the P7A lease/conformance spine composed around it.
 *
 * The kill/restart scenarios use real child processes terminated with
 * SIGKILL. An exception caught in-process would prove nothing: the page
 * cache, the open database handle and every JavaScript object survive a
 * thrown error, which is exactly what a crash does not leave behind.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "drivers", "sqlite-supervisor-child", "index.js");

const scenarios: string[] = [];
const spawnedPids: number[] = [];
const ledgers: Ledger[] = [];
const toyDirs: string[] = [];

function scenario(id: string): ScenarioRoot {
  scenarios.push(id);
  return resolveScenarioRoot(id);
}

function track(ledger: Ledger): Ledger {
  ledgers.push(ledger);
  return ledger;
}

function toyRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-p7b-"));
  toyDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const id of scenarios.splice(0)) removeScenarioRoot(id);
  for (const dir of toyDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The toy git repository -- real `git`, owned and disposed by this file only.
// Re-instantiated from the P7A idiom: spawning a process stays in the one
// file the fence treats as test-only, so this cannot be imported.
// ---------------------------------------------------------------------------

function makeSpawnGit(cwd: string, mkdtempRoot: string): SpawnGit {
  return (args: readonly string[]): SpawnResult => {
    if (cwd !== mkdtempRoot && !cwd.startsWith(mkdtempRoot + sep)) {
      throw new Error("refusing to spawn git outside the mkdtemp root this drill owns");
    }
    const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

function initToyRepository(dir: string, spawnGit: SpawnGit): void {
  writeToyContent(dir);
  const init = spawnGit(["-c", "init.defaultBranch=main", "init", "-q"]);
  expect(init.status).toBe(0);
  const add = spawnGit(["add", TOY_README_PATH]);
  expect(add.status).toBe(0);
  const commit = spawnGit([
    "-c",
    "user.name=acp-pilot-drill",
    "-c",
    "user.email=drill@acp.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "toy: initial commit",
  ]);
  expect(commit.status).toBe(0);
}

// ---------------------------------------------------------------------------
// The child, re-instantiated from the P2 idiom
// ---------------------------------------------------------------------------

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
  const config = JSON.stringify({
    scenarioId,
    invocation,
    emittedBy: PILOT_WRITER,
    // This leg's whole point: the child walks the read-only plan.
    commitPolicy: "NO_COMMIT",
    faultPoint,
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

// ---------------------------------------------------------------------------
// The 3/3 kill and restart drill, over the read-only plan
// ---------------------------------------------------------------------------

describe("kill and restart of the NO_COMMIT walk, 3/3", () => {
  for (const fixture of RECOVERY_FAULT_SCENARIOS) {
    it(
      "recovers a read-only walk from a SIGKILL " + fixture.fault.toLowerCase().replace("_", " "),
      async () => {
        ensureChildBuilt();

        const root = scenario(fixture.id);
        const ledgerPath = scenarioLedgerPath(root);
        const invocation = recoveryInvocation(fixture.taskId);

        const toyDir = toyRepository();
        const spawnGit = makeSpawnGit(toyDir, toyDir);
        initToyRepository(toyDir, spawnGit);
        const port = createGitReadPort(spawnGit);

        // C2: no path to a product repository.
        const remotes = spawnSync("git", ["-C", toyDir, "remote", "-v"], { encoding: "utf8" });
        expect(remotes.status).toBe(0);
        expect(remotes.stdout.trim()).toBe("");

        // Pre-spawn: a real lease decision, and a second-holder refusal.
        const leaseGrant = acquireLease({
          leases: [],
          now: RECOVERY_LEASE_ACQUIRED_AT,
          candidate: {
            leaseId: fixture.leaseId,
            worktreePath: toyDir,
            holder: PILOT_WRITER,
            acquiredAt: RECOVERY_LEASE_ACQUIRED_AT,
            expiresAt: RECOVERY_LEASE_EXPIRES_AT,
          },
        });
        expect(leaseGrant.ok).toBe(true);
        const grantedLease = (leaseGrant as LeaseGranted).lease;

        const secondHolder = acquireLease({
          leases: [grantedLease],
          now: RECOVERY_LEASE_ACQUIRED_AT,
          candidate: {
            leaseId: fixture.secondLeaseId,
            worktreePath: toyDir,
            holder: PILOT_VERIFIER,
            acquiredAt: RECOVERY_LEASE_ACQUIRED_AT,
            expiresAt: RECOVERY_LEASE_EXPIRES_AT,
          },
        });
        expect(secondHolder.ok).toBe(false);
        expect((secondHolder as EnforcementRefused).reason).toBe("LEASE_HELD_BY_ANOTHER");

        // 1. Run until the fault point and die by a real signal.
        const killed = await runChildProcess(fixture.id, invocation, fixture.fault);
        expect(killed.signal).toBe("SIGKILL");
        expect(killed.code).toBeNull();

        const afterCrash = readLedgerSnapshot(ledgerPath, fixture.taskId);
        expect(afterCrash.state).not.toBe("CHECKPOINTED");

        // 2. Restart with no fault. This must finish the work.
        const restarted = await runChildProcess(fixture.id, invocation, null);
        expect(restarted.signal).toBeNull();
        expect(restarted.code).toBe(0);

        const afterRestart = readLedgerSnapshot(ledgerPath, fixture.taskId);
        expect(afterRestart.state).toBe("CHECKPOINTED");
        expect(afterRestart.eventCount).toBe(READ_ONLY_PLAN.length);
        expect(countEffectMarkers(root)).toBe(1);

        // 3. A third run must be a pure replay: nothing appended, head unmoved.
        const replayed = await runChildProcess(fixture.id, invocation, null);
        expect(replayed.code).toBe(0);
        const afterReplay = readLedgerSnapshot(ledgerPath, fixture.taskId);
        expect(afterReplay.eventCount).toBe(afterRestart.eventCount);
        expect(afterReplay.headEventSha256).toBe(afterRestart.headEventSha256);
        expect(countEffectMarkers(root)).toBe(1);

        // 4. The recovered ledger: no commit anywhere, clean integrity,
        // read-model identity, no duplicate idempotency keys.
        const ledger = track(openLedger(ledgerPath));
        const events = ledger.listEvents({ limit: 200 }).events.map((record) => record.event);
        expect(events.length).toBe(READ_ONLY_PLAN.length);
        expect(events.filter((event) => event.type === "CHECKPOINT_WRITTEN")).toHaveLength(1);
        expect(events.some((event) => event.type.startsWith("COMMIT_"))).toBe(false);
        expect(events.some((event) => event.toState === "READY_TO_COMMIT")).toBe(false);
        expect(events.some((event) => event.toState === "COMMITTED")).toBe(false);

        const integrity = ledger.verifyIntegrity();
        expect(integrity.ok).toBe(true);
        expect(integrity.problems).toEqual([]);

        const liveTask = ledger.getTask(fixture.taskId);
        const liveWorkers = ledger.listWorkers().workers;
        ledger.rebuildReadModel();
        expect(ledger.getTask(fixture.taskId)).toEqual(liveTask);
        expect(ledger.listWorkers().workers).toEqual(liveWorkers);

        const keys = events.map((event) => event.idempotencyKey);
        expect(new Set(keys).size).toBe(keys.length);

        // 5. Post-restart conformance: the recovered packet's read-only
        // execution left no drift on the toy worktree.
        const declared = [TOY_README_PATH, TOY_SCRATCH_PATH, TOY_NOTES_PATH];
        const observation = takeObservation(port, toyDir);
        const conformance = checkWriteSetConformance({
          declaredWriteSet: declared,
          observation,
          lease: grantedLease,
        });
        expect(conformance.ok).toBe(true);
        if (conformance.ok) {
          expect(conformance.conformant).toBe(true);
          expect(conformance.violations).toEqual([]);
        }
      },
    );
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
