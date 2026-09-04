import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openLeaseStore, openLedger } from "@acp/ledger";
import { removeScenarioRoot, resolveScenarioRoot, scenarioLedgerPath } from "@acp/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { leaseStorePath } from "../../../src/arbiter/index.js";
import { canonicalSubmissionDigest } from "../../../src/daemon-child/index.js";
import { createPsInspector } from "../../../src/identity-probe/index.js";
import { logFilePath, resolveDaemonRoot } from "../../../src/paths/index.js";

/**
 * The fenced lease, drilled against real daemon processes (V2 concurrency C2).
 *
 * **Why contention is seeded rather than staged with two daemons.** The
 * singleton already refuses a second daemon per checkout, and it refuses it
 * *before* the lease exists — so two real daemons on one checkout would prove
 * the singleton, not the lease. The lease answers a different question, one the
 * singleton cannot: *does somebody hold this worktree?* So these drills put a
 * holder in the store and start a real daemon against it, which is exactly the
 * state a second checkout, or a crashed predecessor, leaves behind.
 *
 * Every daemon here is a real child process. No wall-clock sleep: expiry is a
 * seeded instant and death is a pid that has never existed.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "daemon-child", "index.js");
const EMITTED_BY = "claude/opus/implementer/01";
const SUBMITTED_AT = "2026-08-27T18:46:07.000Z";
const DRILL_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a02";

/** A pid that is not a process. High, and re-checked before it is trusted. */
const DEAD_PID = 4_194_303;

let executionRoot: string | null = null;
const scenarios: string[] = [];
const worktrees: string[] = [];

function fakeProviderRoot(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-c2-exec-")));
  writeFileSync(
    join(created, "fake-provider"),
    "#!/usr/bin/env node\n" +
      "const lines = [JSON.stringify({ type: 'result', subtype: 'success', is_error: false })];\n" +
      'for (const line of lines) process.stdout.write(line + "\\n");\n' +
      "process.exit(0);\n",
    { mode: 0o700 },
  );
  return created;
}

beforeAll(() => {
  executionRoot = fakeProviderRoot();
});

afterAll(() => {
  if (executionRoot !== null) rmSync(executionRoot, { recursive: true, force: true });
  for (const worktree of worktrees.splice(0)) rmSync(worktree, { recursive: true, force: true });
});

afterEach(() => {
  for (const id of scenarios.splice(0)) {
    try {
      removeScenarioRoot(id);
    } catch {
      /* the drill may not have created one */
    }
  }
  // The lease store is shared with the checkout's daemon root, so each drill
  // clears what it seeded rather than leaving a holder behind.
  const store = openLeaseStore(leaseStorePath(resolveDaemonRoot()));
  try {
    for (const row of store.list()) {
      if (row.leaseId !== null) {
        store.transact(row.worktreePath, () => ({
          verb: "RELEASE",
          at: "2026-09-04T00:00:00.000Z",
        }));
      }
    }
  } finally {
    store.close();
  }
});

function scenario(name: string): string {
  const id = name + "-" + randomUUID().slice(0, 8);
  scenarios.push(id);
  return id;
}

/** A distinct worktree, owner-only, carrying its own copy of the fake binary. */
function worktree(): string {
  // Realpath, because /tmp is a symlink on macOS and the config door refuses
  // a binding path that traverses one.
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-c2-wt-")));
  mkdirSync(created, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(created, "fake-provider"),
    "#!/usr/bin/env node\n" +
      "const lines = [JSON.stringify({ type: 'result', subtype: 'success', is_error: false })];\n" +
      'for (const line of lines) process.stdout.write(line + "\\n");\n' +
      "process.exit(0);\n",
    { mode: 0o700 },
  );
  worktrees.push(created);
  return created;
}

const DRILL_ROUTE = {
  provider: "claude",
  model: "opus",
  accountId: "acct-daemon-drill",
  transportKind: "CLI_SUBSCRIPTION" as const,
  capabilityPolicyVersion: "2026-08-30.1",
  resolvedAt: "2026-08-27T18:46:07.000Z",
};

/**
 * Through the one producer, never written as literal hex: the config door
 * refuses a digest that is not the digest of the submission it declares.
 */
function digestFor(taskId: string): string {
  return canonicalSubmissionDigest({
    taskId,
    attempt: 1,
    submittedAt: SUBMITTED_AT,
    initiativeId: DRILL_INITIATIVE_ID,
    route: DRILL_ROUTE,
  });
}

function configFor(
  scenarioId: string,
  workdir: string,
  overrides: Record<string, unknown> = {},
): { config: string; taskId: string } {
  const taskId = randomUUID();
  return {
    taskId,
    config: JSON.stringify({
      mode: "SQLITE_SUPERVISOR",
      scenarioId,
      emittedBy: EMITTED_BY,
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      submissionDigest: digestFor(taskId),
      initiativeId: DRILL_INITIATIVE_ID,
      holdOpen: false,
      checkPorts: false,
      execution: {
        route: DRILL_ROUTE,
        binding: {
          binary: join(workdir, "fake-provider"),
          configRoot: workdir,
          workdir,
          limits: {
            timeoutMs: 20_000,
            outputBudgetBytes: 65_536,
            interruptGraceMs: 200,
            termGraceMs: 200,
          },
        },
      },
      ...overrides,
    }),
  };
}

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly pid: number | undefined;
}

/** Run one real daemon child to completion. */
function runDaemon(config: string): Promise<Ran> {
  return new Promise<Ran>((resolvePromise, rejectPromise) => {
    const child: ChildProcess = spawn(process.execPath, [CHILD_ENTRY, config], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: PACKAGE_ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      resolvePromise({ code, stdout, stderr, pid: child.pid });
    });
  });
}

/** Start a daemon that stays up, resolving once it announces readiness. */
function startHeldOpen(config: string): { child: ChildProcess; ready: Promise<void> } {
  const child: ChildProcess = spawn(process.execPath, [CHILD_ENTRY, config], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: PACKAGE_ROOT,
  });
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    let buffer = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes('"ready"')) resolvePromise();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      rejectPromise(new Error("the daemon exited before readiness (" + String(code) + "): " + stderr));
    });
  });
  return { child, ready };
}

/**
 * Wait for a marker to appear in the daemon's log, under a deadline.
 *
 * Not a sleep, and not a race to be removed: the event being waited for is a
 * timer inside another process, and the only way to observe it is to look. The
 * deadline is what makes a missing marker a failure instead of a hang.
 */
function waitForLog(logPath: string, from: number, marker: string, deadlineMs: number): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const slice = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(from) : "";
      if (slice.includes(marker)) {
        clearInterval(poll);
        resolvePromise(slice);
        return;
      }
      if (Date.now() - started > deadlineMs) {
        clearInterval(poll);
        rejectPromise(new Error("the daemon never logged " + marker + " within " + String(deadlineMs) + "ms"));
      }
    }, 250);
  });
}

/** Take the worktree from whoever holds it, exactly as a successor would. */
function reclaimFrom(workdir: string): void {
  const store = openLeaseStore(leaseStorePath(resolveDaemonRoot()));
  try {
    store.transact(workdir, () => ({
      verb: "GRANT",
      row: {
        leaseId: "7f000000-0000-4000-8000-00000000000b",
        holder: "claude/opus/implementer/08",
        acquiredAt: "2026-09-04T05:00:00.000Z",
        expiresAt: FAR_FUTURE,
        holderPid: process.pid,
        holderToken: "token-successor",
      },
    }));
  } finally {
    store.close();
  }
}

/** Put a holder in the store, exactly as a predecessor would have left one. */
function seedHolder(
  workdir: string,
  holderPid: number,
  holderToken: string,
  expiresAt: string,
): void {
  const store = openLeaseStore(leaseStorePath(resolveDaemonRoot()));
  try {
    store.transact(workdir, () => ({
      verb: "GRANT",
      row: {
        leaseId: "7f000000-0000-4000-8000-00000000000a",
        holder: "claude/opus/implementer/09",
        acquiredAt: "2026-09-04T05:00:00.000Z",
        expiresAt,
        holderPid,
        holderToken,
      },
    }));
  } finally {
    store.close();
  }
}

function leaseRow(workdir: string): ReturnType<ReturnType<typeof openLeaseStore>["read"]> {
  const store = openLeaseStore(leaseStorePath(resolveDaemonRoot()));
  try {
    return store.read(workdir);
  } finally {
    store.close();
  }
}

function leaseEvents(scenarioId: string): { type: string; cause: string | null }[] {
  const path = scenarioLedgerPath(resolveScenarioRoot(scenarioId));
  if (!existsSync(path)) return [];
  const ledger = openLedger(path, { readOnly: true });
  try {
    return ledger
      .listEvents({ limit: 500 })
      .events.filter((record) => record.event.type.startsWith("LEASE_"))
      .map((record) => ({
        type: record.event.type,
        cause: (record.event.payload["cause"] ?? null) as string | null,
      }));
  } finally {
    ledger.close();
  }
}

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const LONG_PAST = "2020-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------

describe("one daemon holds one worktree", () => {
  it("refuses to start when a live holder has the worktree, appending and spawning nothing", async () => {
    const id = scenario("c2-refused");
    const workdir = worktree();

    // The seeded holder is this test process: alive, and its start token is the
    // real one, so the daemon's probe can only conclude LIVE.
    const facts = await createPsInspector().inspect(process.pid);
    if (facts === null) throw new Error("this process could not observe itself");
    seedHolder(workdir, process.pid, facts.startToken, FAR_FUTURE);

    const before = leaseRow(workdir);
    const ran = await runDaemon(configFor(id, workdir).config);

    // The walk never starts.
    expect(ran.code).not.toBe(0);
    expect(ran.stderr + ran.stdout).toContain("LEASE_HELD_BY_ANOTHER");
    // Nothing was appended: the scenario ledger was never even created.
    expect(leaseEvents(id)).toEqual([]);
    // And the holder's record is untouched.
    expect(leaseRow(workdir)).toEqual(before);
  });

  it("grants a different worktree while one is held, and runs to a checkpoint", async () => {
    const id = scenario("c2-different");
    const held = worktree();
    const mine = worktree();

    const facts = await createPsInspector().inspect(process.pid);
    if (facts === null) throw new Error("this process could not observe itself");
    seedHolder(held, process.pid, facts.startToken, FAR_FUTURE);

    const plan = configFor(id, mine);
    const ran = await runDaemon(plan.config);
    expect(ran.code).toBe(0);

    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)), { readOnly: true });
    try {
      expect(ledger.getTask(plan.taskId)?.currentState).toBe("CHECKPOINTED");
    } finally {
      ledger.close();
    }
    // Exclusion is per worktree, not per checkout: the other holder still holds.
    expect(leaseRow(held)?.leaseId).not.toBeNull();
    // And this daemon released its own on the way out.
    expect(leaseRow(mine)?.leaseId).toBeNull();
    expect(leaseRow(mine)?.fence).toBe(1);
  });
});

describe("recovery", () => {
  it("reclaims from a holder it can prove is gone, and records why", async () => {
    const id = scenario("c2-dead");
    const workdir = worktree();
    // A pid that is not a process. Confirmed here rather than assumed.
    expect(() => process.kill(DEAD_PID, 0)).toThrow();
    seedHolder(workdir, DEAD_PID, "token-of-a-dead-process", FAR_FUTURE);

    const plan = configFor(id, workdir);
    const ran = await runDaemon(plan.config);
    expect(ran.code).toBe(0);

    const events = leaseEvents(id);
    // The reclaim is recorded with its cause, not inferred from the absence of
    // a predecessor.
    expect(events.map((event) => event.type)).toContain("LEASE_REVOKED");
    expect(events.find((event) => event.type === "LEASE_REVOKED")?.cause).toBe("HOLDER_DEAD");
    expect(leaseRow(workdir)?.fence).toBe(2);
  });

  it("reclaims an expired lease and records the cause as expiry", async () => {
    const id = scenario("c2-expired");
    const workdir = worktree();
    // Alive, so death cannot be the reason; expired, so the rules allow it.
    const facts = await createPsInspector().inspect(process.pid);
    if (facts === null) throw new Error("this process could not observe itself");
    seedHolder(workdir, process.pid, facts.startToken, LONG_PAST);

    const id2 = configFor(id, workdir);
    const ran = await runDaemon(id2.config);
    expect(ran.code).toBe(0);
    expect(leaseEvents(id).find((event) => event.type === "LEASE_REVOKED")?.cause).toBe("EXPIRED");
  });
});

describe("the unwind order is observable, not only asserted", () => {
  it("reaps the provider children before it releases the lease", async () => {
    const id = scenario("c2-unwind");
    const workdir = worktree();
    const logPath = logFilePath(resolveDaemonRoot());
    const sizeBefore = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0;

    const ran = await runDaemon(configFor(id, workdir).config);
    expect(ran.code).toBe(0);

    const log = readFileSync(logPath, "utf8").slice(sizeBefore);
    const reaped = log.indexOf('"harness.reaped"');
    const released = log.indexOf('"lease.released"');
    // Both happened, and in this order. A drill that only checked that the
    // lease was released would pass with the pushes inverted — which would free
    // the worktree while this daemon's children were still writing into it.
    expect({ reaped: reaped >= 0, released: released >= 0 }).toEqual({
      reaped: true,
      released: true,
    });
    expect(reaped).toBeLessThan(released);
  });
});

describe("a lost fence aborts the walk", () => {
  it(
    "stops beating, reaps its children, and does so in that order",
    async () => {
      const id = scenario("c2-fence-lost");
      const workdir = worktree();
      const logPath = logFilePath(resolveDaemonRoot());
      const sizeBefore = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0;

      const { child, ready } = startHeldOpen(configFor(id, workdir, { holdOpen: true }).config);
      try {
        await ready;
        // A successor takes the worktree. The running daemon learns at its next
        // beat and must not simply note it: logging alone would leave this
        // process writing into a worktree somebody else now holds.
        reclaimFrom(workdir);

        const slice = await waitForLog(logPath, sizeBefore, '"lease.lost"', 90_000);
        const lost = slice.indexOf('"lease.lost"');
        const reaped = slice.indexOf('"harness.reaped"', lost);
        expect(lost).toBeGreaterThanOrEqual(0);
        // Reaped *after* the loss was noticed, by the abort and not by the
        // unwind: the daemon is still running at this point.
        expect(reaped).toBeGreaterThan(lost);
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill("SIGTERM");
        await new Promise<void>((resolvePromise) => {
          child.once("close", () => {
            resolvePromise();
          });
        });
      }
    },
    120_000,
  );
});

describe("the store fails closed", () => {
  it("refuses to start when the lease store cannot be opened", async () => {
    const id = scenario("c2-corrupt");
    const workdir = worktree();
    const storePath = leaseStorePath(resolveDaemonRoot());
    const saved = existsSync(storePath) ? readFileSync(storePath) : null;
    writeFileSync(storePath, "this is not a database");
    try {
      const ran = await runDaemon(configFor(id, workdir).config);
      // No handle that would silently grant: the walk does not start.
      expect(ran.code).not.toBe(0);
      expect(leaseEvents(id)).toEqual([]);
    } finally {
      if (saved === null) rmSync(storePath, { force: true });
      else writeFileSync(storePath, saved);
      rmSync(storePath + "-wal", { force: true });
      rmSync(storePath + "-shm", { force: true });
    }
  });
});
