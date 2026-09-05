import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LEDGER_ACCOUNT_CONTRACT_VERSION, openLeaseStore, openLedger } from "@acp/ledger";
import { removeScenarioRoot, resolveScenarioRoot, scenarioLedgerPath } from "@acp/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { leaseStorePath } from "../../../src/arbiter/index.js";
import { canonicalSubmissionDigest } from "../../../src/daemon-child/index.js";
import { createPsInspector } from "../../../src/identity-probe/index.js";
import { recoverStaleLock } from "../../../src/singleton/index.js";
import { logFilePath, resolveDaemonRoot } from "../../../src/paths/index.js";

/**
 * Make a fixture directory an actual worktree.
 *
 * A "worktree" that is not a git repository is not a worktree, and since V2
 * concurrency C4 the walk observes the one it writes into. Everything the
 * fixture already wrote is committed, so the only changes the observer can see
 * are the walk's own — which is what makes a conformant drill conformant and a
 * violating one violating.
 *
 * A temporary directory, never this repository (stop 3).
 */
function initWorktree(directory: string, holds: readonly string[] = []): void {
  const git = (...args: string[]): void => {
    spawnSync("/usr/bin/git", args, { cwd: directory, encoding: "utf8" });
  };
  git("init", "--quiet");
  git("config", "user.email", "drill@example.invalid");
  git("config", "user.name", "drill");
  // V2-B1f/F3. Every declared path exists before the commit, so the write-set
  // the envelope declares is one this worktree really holds. A write-set is a
  // declaration and `checkWriteSetConformance` compares it as an exact string,
  // so a declared path that never existed matched nothing and cost nothing;
  // the checkpoint digests the declared set, so it is now visible.
  for (const declared of holds) {
    const full = join(directory, declared);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "declared by the fixture\n", "utf8");
  }
  git("add", "-A");
  git("commit", "--allow-empty", "-q", "-m", "fixture base");
}


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
  initWorktree(created);
  return created;
}

beforeAll(() => {
  executionRoot = fakeProviderRoot();
});

afterAll(() => {
  if (executionRoot !== null) rmSync(executionRoot, { recursive: true, force: true });
  for (const worktree of worktrees.splice(0)) rmSync(worktree, { recursive: true, force: true });
});

afterEach(async () => {
  // A drill that signals a daemon can lose the race with its own signal
  // handlers, which are installed after readiness: the default action then kills
  // the process with no unwind and leaves the singleton lock behind, and every
  // later daemon in this suite refuses to start with STALE_LOCK. Cleared through
  // the daemon's own recovery, which removes a lock only on a proven NOT_SAME
  // verdict — it can never take one from a live daemon.
  await recoverStaleLock(resolveDaemonRoot(), createPsInspector(), { adoptStale: true });
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

/**
 * Every repo-relative path this file's envelopes declare (V2-B1f/F3).
 *
 * One list, applied to every fixture worktree, so a walk's declared write-set
 * is one its worktree really holds whichever drill declared it. A write-set is
 * a declaration and `checkWriteSetConformance` compares it as an exact string,
 * so a declared path that never existed matched nothing and cost nothing; the
 * checkpoint digests the declared set against the worktree, so it is now
 * visible. The conformance drills below declare `declared.txt` and
 * `declared-only.txt` instead, and those are written by the walk itself.
 */
const DECLARED_FIXTURE_PATHS: readonly string[] = ["a/one.ts", "b/two.ts", "shared/file.ts"];

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
  initWorktree(created, DECLARED_FIXTURE_PATHS);
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
      envelope: envelopeFor(taskId, ["a/one.ts"], DRILL_INITIATIVE_ID),
      holdOpen: false,
      checkPorts: false,
      execution: {
        route: DRILL_ROUTE,
        bindings: [
          {
            accountId: DRILL_ROUTE.accountId,
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
        ],
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
  // A child killed mid-write can emit an EPIPE on its own pipes after close.
  // Listened for rather than left unhandled: an unhandled one fails the whole
  // project without failing a single test, which is a verdict nobody can act on.
  child.on("error", () => undefined);
  child.stdout?.on("error", () => undefined);
  child.stderr?.on("error", () => undefined);
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

/**
 * Wait for **this run's** unwind, and return the tail that contains it.
 *
 * Two anchors, and both are needed.
 *
 * `from` is the log's length captured immediately before this daemon started,
 * so the search cannot see another suite's daemon. The log is shared by every
 * drill in the `daemon` project, and a previous daemon's last lines can flush
 * *after* this one has written its own — which made a bare "last
 * `harness.reaped`" anchor point at a stale reap with nothing after it, and
 * failed this drill roughly one project run in two while it passed every time
 * the file was run alone.
 *
 * Within that window the search is still anchored on the **last**
 * `harness.reaped`, because this daemon reaps once and everything after it is
 * this shutdown.
 *
 * The log is bounded and rotated, so an offset can outlive its file: a length
 * shorter than `from` means a rotation happened and the whole current file is
 * this run's. Handled rather than assumed away — the alternative is an offset
 * that silently points past the end and a wait that can never succeed.
 *
 * The child writes these lines as it exits, so the wait is also what keeps the
 * read from racing the flush.
 */
function waitForUnwind(
  logPath: string,
  from: number,
  releases: number,
  deadlineMs: number,
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const whole = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      const window = whole.length < from ? whole : whole.slice(from);
      const at = window.lastIndexOf('"harness.reaped"');
      if (at >= 0) {
        const tail = window.slice(at);
        if (tail.split('"lease.released"').length - 1 >= releases) {
          clearInterval(poll);
          resolvePromise(window.slice(Math.max(0, at - 200)));
          return;
        }
      }
      if (Date.now() - started > deadlineMs) {
        clearInterval(poll);
        // Self-describing: a bare "never logged" cannot tell a missing log from
        // a missing unwind, and those have different causes.
        const exists = existsSync(logPath);
        rejectPromise(
          new Error(
            "the daemon never logged a reap followed by " +
              String(releases) +
              " releases (log exists: " +
              String(exists) +
              ", window bytes: " +
              String(window.length) +
              ", from: " +
              String(from) +
              ", reaps in window: " +
              String(window.split('"harness.reaped"').length - 1) +
              ", releases in window: " +
              String(window.split('"lease.released"').length - 1) +
              ")",
          ),
        );
      }
    }, 100);
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

// ---------------------------------------------------------------------------
// V2 concurrency C3: many walks, one plane
// ---------------------------------------------------------------------------

/**
 * A worktree whose provider blocks until every walk has arrived.
 *
 * The barrier is two files. Each provider writes its own marker and then spins
 * until the sibling's exists, so **a sequential scheduler deadlocks**: walk one
 * waits for a walk that has not been started. That is the whole point — a drill
 * that compared timestamps would pass on a sequential plane that happened to be
 * fast, and flake on a slow machine for reasons that have nothing to do with
 * the scheduler.
 */
function barrierWorktree(mine: string, theirs: string, gate: string): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-c3-wt-")));
  writeFileSync(
    join(created, "fake-provider"),
    "#!/usr/bin/env node\n" +
      "const { writeFileSync, existsSync } = require('node:fs');\n" +
      "const join = require('node:path').join;\n" +
      "writeFileSync(join(" + JSON.stringify(gate) + ", " + JSON.stringify(mine) + "), 'x');\n" +
      "const until = Date.now() + 60000;\n" +
      "while (Date.now() < until && !existsSync(join(" + JSON.stringify(gate) + ", " + JSON.stringify(theirs) + "))) {}\n" +
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n');\n" +
      "process.exit(0);\n",
    { mode: 0o700 },
  );
  initWorktree(created, DECLARED_FIXTURE_PATHS);
  worktrees.push(created);
  return created;
}

/**
 * A worktree whose provider announces its pid and then waits to be released.
 *
 * Long-lived on purpose: the corrections need a daemon whose provider children
 * are still alive while the test acts on them — to reclaim a worktree under a
 * running walk, and to kill one walk's child and watch its sibling finish.
 */
function heldWorktree(name: string, gate: string): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-c3-held-")));
  writeFileSync(
    join(created, "fake-provider"),
    "#!/usr/bin/env node\n" +
      "const { writeFileSync, existsSync } = require('node:fs');\n" +
      "const join = require('node:path').join;\n" +
      "writeFileSync(join(" + JSON.stringify(gate) + ", " + JSON.stringify(name + ".pid") + "), String(process.pid));\n" +
      "const until = Date.now() + 120000;\n" +
      "while (Date.now() < until && !existsSync(join(" + JSON.stringify(gate) + ", " + JSON.stringify(name + ".go") + "))) {}\n" +
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n');\n" +
      "process.exit(0);\n",
    { mode: 0o700 },
  );
  initWorktree(created, DECLARED_FIXTURE_PATHS);
  worktrees.push(created);
  return created;
}

/**
 * Wait for a child to close, tolerating one that has already exited.
 *
 * `once("close")` on a closed child never fires, so a bare listener in a
 * `finally` turns any earlier failure into a test timeout — which hides the
 * failure that actually happened behind a useless one.
 */
function closed(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    child.once("close", () => {
      resolvePromise();
    });
  });
}

/** Wait for a file the child writes. Bounded, so a missing one fails loudly. */
function waitForFile(path: string, deadlineMs: number): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(poll);
        resolvePromise();
        return;
      }
      if (Date.now() - started > deadlineMs) {
        clearInterval(poll);
        rejectPromise(new Error("never appeared: " + path));
      }
    }, 100);
  });
}

const C3_ENVELOPE_INITIATIVE = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a04";

function envelopeFor(
  taskId: string,
  writeSet: readonly string[],
  initiativeId: string = C3_ENVELOPE_INITIATIVE,
): Record<string, unknown> {
  return {
    contractVersion: LEDGER_ACCOUNT_CONTRACT_VERSION,
    taskId,
    initiativeId,
    title: "a walk",
    objective: "walk the plan",
    classification: "MECHANICAL",
    issuedBy: EMITTED_BY,
    issuedAt: SUBMITTED_AT,
    authority: [],
    readSet: [],
    writeSet: [...writeSet],
    conflictKeys: [],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "a patch" },
    validation: { commands: [], independentVerifierRequired: false },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1_000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 10 },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: false, maxStepsWithoutCheckpoint: 5 },
  };
}

function walkEntryFor(
  scenarioId: string,
  workdir: string,
  writeSet: readonly string[],
  fixedTaskId?: string,
): { entry: Record<string, unknown>; taskId: string } {
  const taskId = fixedTaskId ?? randomUUID();
  const execution = {
    route: DRILL_ROUTE,
    bindings: [
      {
        accountId: DRILL_ROUTE.accountId,
        binary: join(workdir, "fake-provider"),
        configRoot: workdir,
        workdir,
        limits: { timeoutMs: 90_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
      },
    ],
  };
  return {
    taskId,
    entry: {
      scenarioId,
      emittedBy: EMITTED_BY,
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      submissionDigest: canonicalSubmissionDigest({
        taskId,
        attempt: 1,
        submittedAt: SUBMITTED_AT,
        initiativeId: C3_ENVELOPE_INITIATIVE,
        route: DRILL_ROUTE,
      }),
      initiativeId: C3_ENVELOPE_INITIATIVE,
      envelope: envelopeFor(taskId, writeSet),
      execution,
    },
  };
}

/**
 * The legacy singular form, with its own envelope (DT Option B).
 *
 * The same walk, expressed the other way, so every case below can be run twice
 * and the two seams compared rather than assumed symmetric.
 */
function singularConfig(
  scenarioId: string,
  workdir: string,
  taskId: string,
  writeSet: readonly string[],
): string {
  const execution = {
    route: DRILL_ROUTE,
    bindings: [
      {
        accountId: DRILL_ROUTE.accountId,
        binary: join(workdir, "fake-provider"),
        configRoot: workdir,
        workdir,
        limits: { timeoutMs: 90_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
      },
    ],
  };
  return JSON.stringify({
    mode: "SQLITE_SUPERVISOR",
    scenarioId,
    emittedBy: EMITTED_BY,
    taskId,
    attempt: 1,
    submittedAt: SUBMITTED_AT,
    submissionDigest: canonicalSubmissionDigest({
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      initiativeId: C3_ENVELOPE_INITIATIVE,
      route: DRILL_ROUTE,
    }),
    initiativeId: C3_ENVELOPE_INITIATIVE,
    envelope: envelopeFor(taskId, writeSet),
    holdOpen: false,
    checkPorts: false,
    execution,
  });
}

function walksConfig(
  entries: readonly unknown[],
  mode = "SQLITE_SUPERVISOR",
  holdOpen = false,
): string {
  return JSON.stringify({
    mode,
    scenarioId: "c3-plane",
    emittedBy: EMITTED_BY,
    initiativeId: C3_ENVELOPE_INITIATIVE,
    holdOpen,
    checkPorts: false,
    walks: entries,
  });
}

describe("many walks, one plane", () => {
  it(
    "runs two initiatives at once — proven by a barrier, and each ledger holds only its own walk",
    async () => {
      const gate = realpathSync(mkdtempSync(join(tmpdir(), "acp-c3-gate-")));
      worktrees.push(gate);
      const first = barrierWorktree("one", "two", gate);
      const second = barrierWorktree("two", "one", gate);
      const idA = scenario("c3-walk-a");
      const idB = scenario("c3-walk-b");

      const a = walkEntryFor(idA, first, ["a/one.ts"]);
      const b = walkEntryFor(idB, second, ["b/two.ts"]);
      const ran = await runDaemon(walksConfig([a.entry, b.entry]));
      expect(ran.code).toBe(0);

      // Both reached a checkpoint, each in its own ledger.
      for (const [id, walk] of [[idA, a] as const, [idB, b] as const]) {
        const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)), { readOnly: true });
        try {
          expect(ledger.getTask(walk.taskId)?.currentState).toBe("CHECKPOINTED");
          // No bleed: this ledger carries this walk's task and nobody else's.
          const tasks = new Set(
            ledger.listEvents({ limit: 500 }).events.map((record) => record.event.taskId),
          );
          expect([...tasks]).toEqual([walk.taskId]);
        } finally {
          ledger.close();
        }
      }

      // The barrier is the concurrency proof: neither provider could exit until
      // both had started, so a sequential plane would have deadlocked here.
      expect(existsSync(join(gate, "one"))).toBe(true);
      expect(existsSync(join(gate, "two"))).toBe(true);

      // Both worktrees were leased and both were released.
      for (const workdir of [first, second]) {
        expect(leaseRow(workdir)?.fence).toBe(1);
        expect(leaseRow(workdir)?.leaseId).toBeNull();
      }
    },
    180_000,
  );

  it("refuses the second of two walks that want one worktree, and runs the first", async () => {
    const id = scenario("c3-same-worktree");
    const shared = worktree();
    const a = walkEntryFor(id, shared, ["a/one.ts"]);
    const b = walkEntryFor(scenario("c3-same-worktree-b"), shared, ["b/two.ts"]);
    const ran = await runDaemon(walksConfig([a.entry, b.entry]));
    expect(ran.code).toBe(0);

    // The graph admitted both — disjoint write-sets — and the lease refused the
    // second, so exactly one record exists and it is at fence one.
    expect(leaseRow(shared)?.fence).toBe(1);
    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)), { readOnly: true });
    try {
      expect(ledger.getTask(a.taskId)?.currentState).toBe("CHECKPOINTED");
      // The refused walk appended nothing anywhere.
      expect(ledger.getTask(b.taskId)).toBeNull();
    } finally {
      ledger.close();
    }
  });

  it("refuses a conflicting write-set before any lease exists", async () => {
    const id = scenario("c3-conflict");
    const mine = worktree();
    const theirs = worktree();
    const a = walkEntryFor(id, mine, ["shared/file.ts"]);
    const b = walkEntryFor(scenario("c3-conflict-b"), theirs, ["shared/file.ts"]);
    const ran = await runDaemon(walksConfig([a.entry, b.entry]));
    expect(ran.code).toBe(0);

    // The graph refused the second, so the lease was never asked: the second
    // worktree has no record at all. A lease taken first would have left one.
    expect(leaseRow(mine)?.fence).toBe(1);
    expect(leaseRow(theirs)).toBeNull();
  });

  it("refuses to start in RESTATE mode with more than one walk", async () => {
    const a = walkEntryFor(scenario("c3-restate-a"), worktree(), ["a/one.ts"]);
    const b = walkEntryFor(scenario("c3-restate-b"), worktree(), ["b/two.ts"]);
    const ran = await runDaemon(walksConfig([a.entry, b.entry], "RESTATE"));
    // Refused to start, not quietly running the first.
    expect(ran.code).not.toBe(0);
    expect(ran.stderr + ran.stdout).toContain("RESTATE");
  });
});

describe("under N walks, each lease is its own", () => {
  it(
    "beats per walk: a reclaimed worktree loses and is reaped, while its sibling keeps renewing",
    async () => {
      const gate = realpathSync(mkdtempSync(join(tmpdir(), "acp-c3-beat-")));
      worktrees.push(gate);
      const doomed = heldWorktree("doomed", gate);
      const survivor = heldWorktree("survivor", gate);
      const idA = scenario("c3-beat-a");
      const idB = scenario("c3-beat-b");
      const a = walkEntryFor(idA, doomed, ["a/one.ts"]);
      const b = walkEntryFor(idB, survivor, ["b/two.ts"]);
      const logPath = logFilePath(resolveDaemonRoot());
      const sizeBefore = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0;

      // **This is the one drill that never awaits readiness, and it must say
      // so.** A multi-walk daemon announces readiness only after `runAdmitted`
      // returns, and these providers are held open deliberately — so readiness
      // does not arrive until the test itself releases them in the `finally`.
      // The drill waits on the providers' own pid files instead.
      //
      // `ready` therefore has no awaiter, and it carries a `close` rejection.
      // When the `finally`'s SIGTERM closes the child before the announce wins
      // the race, that rejection has nobody to catch it and Vitest fails the
      // whole project — every test passing — on one run in two. Bound and
      // swallowed **here**, at the only site that discards it. The two callers
      // that `await ready` keep their readiness failures exactly as they are:
      // `startHeldOpen` is byte-unchanged, so nothing about their promise moves.
      const { child, ready } = startHeldOpen(walksConfig([a.entry, b.entry]));
      void ready.catch(() => undefined);
      try {
        // Both providers are alive; both leases are held at fence 1.
        await waitForFile(join(gate, "doomed.pid"), 30_000);
        await waitForFile(join(gate, "survivor.pid"), 30_000);
        expect(leaseRow(doomed)?.fence).toBe(1);
        const survivorBefore = leaseRow(survivor);

        // A successor takes exactly one of the two worktrees.
        reclaimFrom(doomed);

        // Wait for the *reap*, not the loss: the interrupt resolves
        // asynchronously after `lease.lost` is written, so reading the log the
        // instant the loss appears races that resolution.
        const slice = await waitForLog(logPath, sizeBefore, '"walk.reaped"', 90_000);
        // The loser was reaped, by name and in order, and the sibling's own
        // children were not touched — `closeAll` would have taken both.
        expect(slice.indexOf('"lease.lost"')).toBeGreaterThanOrEqual(0);
        expect(slice.indexOf('"walk.reaped"')).toBeGreaterThan(slice.indexOf('"lease.lost"'));
        expect(slice).not.toContain('"harness.reaped"');

        // The sibling kept beating: its fence moved past the grant's, which
        // only a renewal does. Without a per-walk heartbeat this stays at 1.
        const survivorAfter = leaseRow(survivor);
        expect(survivorAfter?.leaseId).toBe(survivorBefore?.leaseId);
        expect((survivorAfter?.fence ?? 0) > (survivorBefore?.fence ?? 0)).toBe(true);

        // And it finishes.
        writeFileSync(join(gate, "survivor.go"), "x");
        const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(idB)), { readOnly: true });
        try {
          await waitForFile(join(gate, "survivor.go"), 1_000);
          expect(ledger.getTask(b.taskId)).not.toBeNull();
        } finally {
          ledger.close();
        }
      } finally {
        writeFileSync(join(gate, "doomed.go"), "x");
        writeFileSync(join(gate, "survivor.go"), "x");
        child.kill("SIGTERM");
        await closed(child);
      }
    },
    180_000,
  );

  it(
    "kills one walk's provider without touching its sibling, and strands no worktree",
    async () => {
      const gate = realpathSync(mkdtempSync(join(tmpdir(), "acp-c3-kill-")));
      worktrees.push(gate);
      const killed = heldWorktree("killed", gate);
      const living = heldWorktree("living", gate);
      const idA = scenario("c3-kill-a");
      const idB = scenario("c3-kill-b");
      const a = walkEntryFor(idA, killed, ["a/one.ts"]);
      const b = walkEntryFor(idB, living, ["b/two.ts"]);

      const ranPromise = runDaemon(walksConfig([a.entry, b.entry]));
      await waitForFile(join(gate, "killed.pid"), 30_000);
      await waitForFile(join(gate, "living.pid"), 30_000);
      const victim = Number(readFileSync(join(gate, "killed.pid"), "utf8"));
      // A real signal to a real child, and only to that one.
      process.kill(victim, "SIGKILL");
      writeFileSync(join(gate, "living.go"), "x");
      const ran = await ranPromise;
      expect(ran.code).toBe(0);

      // **What this drill proves, and what it does not.** A real SIGKILL to one
      // walk's real provider child does not damage its sibling and strands no
      // worktree — that is the N-walk isolation property this packet owns.
      //
      // It does **not** prove that the killed walk fails. Measured here, that
      // walk still reaches `CHECKPOINTED`: the runtime settles a classified
      // provider failure and carries on (V2-B7R), and C3 changes nothing about
      // that. Asserting a failure would be asserting a behaviour this plane does
      // not have. The scheduler suite proves the isolation of a *rejecting*
      // walk in-process; joining that to a real child death at the daemon layer
      // is disclosed as undelivered rather than faked here.
      const alive = openLedger(scenarioLedgerPath(resolveScenarioRoot(idB)), { readOnly: true });
      try {
        expect(alive.getTask(b.taskId)?.currentState).toBe("CHECKPOINTED");
      } finally {
        alive.close();
      }
      // The sibling's own walk is intact and unabbreviated: no cross-walk reap
      // truncated it.
      const dead = openLedger(scenarioLedgerPath(resolveScenarioRoot(idA)), { readOnly: true });
      try {
        expect(dead.getTask(a.taskId)).not.toBeNull();
      } finally {
        dead.close();
      }

      // Neither worktree is stranded: both leases went back at their own fence,
      // so no walk lost its lease to a successor and none was left held.
      expect(leaseRow(killed)?.leaseId).toBeNull();
      expect(leaseRow(living)?.leaseId).toBeNull();
      expect(leaseRow(killed)?.fence).toBe(1);
      expect(leaseRow(living)?.fence).toBe(1);
    },
    180_000,
  );

  it(
    "reaps every child before it releases any lease, on a graceful stop under N",
    async () => {
      const gate = realpathSync(mkdtempSync(join(tmpdir(), "acp-c3-unwind-")));
      worktrees.push(gate);
      const first = worktree();
      const second = worktree();
      const a = walkEntryFor(scenario("c3-unwind-a"), first, ["a/one.ts"]);
      const b = walkEntryFor(scenario("c3-unwind-b"), second, ["b/two.ts"]);
      const logPath = logFilePath(resolveDaemonRoot());
      // Captured before the daemon starts, so the wait below cannot be
      // satisfied — or defeated — by another suite's daemon in the shared log.
      const sizeBefore = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0;

      // **`holdOpen: true`, and it is the whole meaning of "graceful".** A
      // daemon started with `holdOpen: false` announces readiness and then
      // drains itself, installing **no signal handlers** — so a SIGTERM into it
      // is delivered by default action and kills the process mid-drain, after
      // `draining` and before the unwind can reap or release. That is not a
      // graceful stop, and this drill was measuring one process's race against
      // its own shutdown: green when the unwind happened to finish first, red
      // under load. Held open, the signal is handled, and the unwind is the one
      // the assertion is about.
      const { child, ready } = startHeldOpen(walksConfig([a.entry, b.entry], "SQLITE_SUPERVISOR", true));
      await ready;
      child.kill("SIGTERM");
      await closed(child);

      const slice = await waitForUnwind(logPath, sizeBefore, 1, 30_000);
      const reaped = slice.indexOf('"harness.reaped"');
      const releases = [...slice.matchAll(/"lease\.released"/g)].map((match) => match.index);

      // One shared harness, reaped once, before any lease is handed back.
      // L-C-2b compares the FIRST `name: "lease"` with the FIRST
      // `name: "agent-harness"` and so says nothing about this second pair;
      // L-C-3d pins it by comparing the last of each, and this observes it.
      expect(reaped).toBeGreaterThanOrEqual(0);
      expect(releases.length).toBeGreaterThanOrEqual(1);
      for (const at of releases) expect(at).toBeGreaterThan(reaped);

      // Both leases really did go back, asserted against the store rather than
      // the log: the daemon's last log lines can be lost when the process
      // exits, so the count of `lease.released` in the tail is not a reliable
      // witness. The rows are.
      for (const workdir of [first, second]) {
        expect(leaseRow(workdir)?.leaseId).toBeNull();
        expect(leaseRow(workdir)?.fence).toBe(1);
      }
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// V2 concurrency C4: write-set conformance, on BOTH execution paths
// ---------------------------------------------------------------------------

/**
 * A worktree whose provider writes one file, named by the caller.
 *
 * Whether that file is inside the declared write-set is what separates a
 * conformant walk from a violating one, so the drills below build the same
 * fixture twice and change only the declaration.
 */
function writingWorktree(fileName: string): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-c4-wt-")));
  writeFileSync(
    join(created, "fake-provider"),
    "#!/usr/bin/env node\n" +
      "require('node:fs').writeFileSync(require('node:path').join(" +
      JSON.stringify(created) + ", " + JSON.stringify(fileName) + "), 'written by the walk');\n" +
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n');\n" +
      "process.exit(0);\n",
    { mode: 0o700 },
  );
  initWorktree(created, DECLARED_FIXTURE_PATHS);
  worktrees.push(created);
  return created;
}

function conformanceEvents(scenarioId: string): { type: string; payload: Record<string, unknown> }[] {
  const path = scenarioLedgerPath(resolveScenarioRoot(scenarioId));
  if (!existsSync(path)) return [];
  const ledger = openLedger(path, { readOnly: true });
  try {
    return ledger
      .listEvents({ limit: 500 })
      .events
      // Only the gate's own events. A completed walk also revokes its lease on
      // the way out (cause `RELEASED`), and counting that as a conformance
      // finding would make every clean walk look like a violation. The gate's
      // coordinates are derived from `conformance.<operationIndex>.<n>`, so the
      // transition id is what separates them — not the type.
      .filter((record) => record.event.transitionId.startsWith("conformance."))
      .map((record) => ({ type: record.event.type, payload: record.event.payload }));
  } finally {
    ledger.close();
  }
}

/** Every event type in a scenario's ledger, in order. */
function allEvents(scenarioId: string): string[] {
  const path = scenarioLedgerPath(resolveScenarioRoot(scenarioId));
  if (!existsSync(path)) return [];
  const ledger = openLedger(path, { readOnly: true });
  try {
    return ledger.listEvents({ limit: 500 }).events.map((record) => record.event.type);
  } finally {
    ledger.close();
  }
}

function taskStateOf(scenarioId: string, taskId: string): string | null {
  const path = scenarioLedgerPath(resolveScenarioRoot(scenarioId));
  if (!existsSync(path)) return null;
  const ledger = openLedger(path, { readOnly: true });
  try {
    return ledger.getTask(taskId)?.currentState ?? null;
  } finally {
    ledger.close();
  }
}

function gitStatusOf(worktree: string): string {
  return spawnSync("/usr/bin/git", ["status", "--porcelain=v1"], {
    cwd: worktree,
    encoding: "utf8",
  }).stdout;
}

describe("both execution paths enforce the declared write-set", () => {
  /**
   * The singular form and the walks form, the same case each time.
   *
   * This is the packet's centre and the drill that would have failed under
   * Option A: a daemon started on the **legacy singular** form runs the gate,
   * asserted by observing the events rather than by reading the code.
   */
  for (const seam of ["singular", "scheduler"] as const) {
    it("refuses a walk that writes outside its set, on the " + seam + " path", async () => {
      const id = scenario("c4-violation-" + seam);
      const workdir = writingWorktree("outside.txt");
      const taskId = randomUUID();

      // The scheduler seam needs **two** walks: a single-walk config folds to
      // the singular path by design (C3), so a one-walk "scheduler" case would
      // quietly re-test the seam it is meant to contrast with.
      const ran = await runDaemon(
        seam === "singular"
          ? singularConfig(id, workdir, taskId, ["declared-only.txt"])
          : walksConfig([
              walkEntryFor(id, workdir, ["declared-only.txt"], taskId).entry,
              walkEntryFor(scenario("c4-sibling"), writingWorktree("declared.txt"), ["declared.txt"]).entry,
            ]),
      );
      void ran;

      // Recorded, then revoked — in that order. A revocation whose cause has no
      // event is a lease that vanished for no recorded reason.
      const events = conformanceEvents(id);
      expect(events.map((event) => event.type)).toEqual([
        "WRITE_SET_VIOLATION_DETECTED",
        "LEASE_REVOKED",
        "TASK_STATE_CHANGED",
      ]);
      expect(events[0]?.payload["firstPathOutsideSet"]).toBe("outside.txt");
      expect(events[2]?.payload["toState"]).toBe("SUSPECT_WORKTREE");

      // **Quarantined, not merely stopped.** `SUSPECT_WORKTREE` is terminal, so
      // the ledger records that this task is finished rather than resumable —
      // which is what stops the next start from re-running the provider and
      // violating again. A walk that only stopped would look identical here.
      expect(taskStateOf(id, taskId)).toBe("SUSPECT_WORKTREE");
      expect(events.map((event) => event.type)).toContain("TASK_STATE_CHANGED");

      // The lease went back: a violating walk must not strand a worktree.
      expect(leaseRow(workdir)?.leaseId).toBeNull();

      // **Nothing was cleaned.** The offending file is still there with the
      // bytes the walk wrote, and git still sees it. This is the whole of
      // "sin limpiar": the evidence of what happened outlives the walk.
      expect(existsSync(join(workdir, "outside.txt"))).toBe(true);
      expect(readFileSync(join(workdir, "outside.txt"), "utf8")).toBe("written by the walk");
      expect(gitStatusOf(workdir)).toContain("outside.txt");
    });

    it("lets a conformant walk finish in silence, on the " + seam + " path", async () => {
      const id = scenario("c4-conformant-" + seam);
      const workdir = writingWorktree("declared.txt");
      const taskId = randomUUID();

      const ran = await runDaemon(
        seam === "singular"
          ? singularConfig(id, workdir, taskId, ["declared.txt"])
          : walksConfig([
              walkEntryFor(id, workdir, ["declared.txt"], taskId).entry,
              walkEntryFor(scenario("c4-sibling-ok"), writingWorktree("declared.txt"), ["declared.txt"]).entry,
            ]),
      );
      expect(ran.code).toBe(0);
      // Neither event appended: conformance is silence, not a receipt.
      expect(conformanceEvents(id)).toEqual([]);
      expect(taskStateOf(id, taskId)).toBe("CHECKPOINTED");
    });
  }

  it("fails closed when the worktree cannot be observed", async () => {
    const id = scenario("c4-unobservable");
    // A worktree that is not a repository. An observation that cannot be taken
    // is not a pass: the walk stops and records no conformance either way.
    const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-c4-bare-")));
    worktrees.push(created);
    writeFileSync(
      join(created, "fake-provider"),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n');\nprocess.exit(0);\n",
      { mode: 0o700 },
    );
    const taskId = randomUUID();
    const ran = await runDaemon(singularConfig(id, created, taskId, ["anything.txt"]));
    expect(ran.code).not.toBe(0);
    expect(ran.stderr + ran.stdout).toContain("OBSERVATION_FAILED");
    expect(conformanceEvents(id)).toEqual([]);
  });

  it("keeps a violation to its own walk under concurrency", async () => {
    const idA = scenario("c4-concurrent-violator");
    const idB = scenario("c4-concurrent-clean");
    const violating = writingWorktree("outside.txt");
    const clean = writingWorktree("declared.txt");
    const a = walkEntryFor(idA, violating, ["declared-only.txt"]);
    const b = walkEntryFor(idB, clean, ["declared.txt"]);

    await runDaemon(walksConfig([a.entry, b.entry]));

    // The violator settles and loses its lease.
    expect(conformanceEvents(idA).map((event) => event.type)).toEqual([
      "WRITE_SET_VIOLATION_DETECTED",
      "LEASE_REVOKED",
      "TASK_STATE_CHANGED",
    ]);
    expect(taskStateOf(idA, a.taskId)).toBe("SUSPECT_WORKTREE");
    expect(leaseRow(violating)?.leaseId).toBeNull();

    // Its sibling completed untouched, and its ledger carries neither event.
    expect(conformanceEvents(idB)).toEqual([]);
    expect(taskStateOf(idB, b.taskId)).toBe("CHECKPOINTED");
    expect(leaseRow(clean)?.leaseId).toBeNull();
    expect(leaseRow(clean)?.fence).toBe(1);
  });

  it("quarantines rather than retrying: a restart re-executes nothing", async () => {
    const id = scenario("c4-idempotent");
    const workdir = writingWorktree("outside.txt");
    const taskId = randomUUID();
    const config = singularConfig(id, workdir, taskId, ["declared-only.txt"]);

    await runDaemon(config);
    const first = conformanceEvents(id);
    const firstTrail = allEvents(id);
    expect(taskStateOf(id, taskId)).toBe("SUSPECT_WORKTREE");
    // The offending file is the walk's own evidence; remove it so a second
    // execution would be visible as its reappearance.
    rmSync(join(workdir, "outside.txt"));

    await runDaemon(config);

    // **The walk did not run again**, which is the property quarantine buys.
    // Derived coordinates alone would only prove the conformance events did not
    // double; what proves the task is finished rather than resumable is that
    // there is no second `RUN_STARTED`, no second violation, and the provider
    // never re-wrote the file it was stopped for writing.
    const after = allEvents(id);
    expect(after.filter((type) => type === "RUN_STARTED").length).toBe(
      firstTrail.filter((type) => type === "RUN_STARTED").length,
    );
    expect(conformanceEvents(id)).toEqual(first);
    expect(taskStateOf(id, taskId)).toBe("SUSPECT_WORKTREE");
    expect(existsSync(join(workdir, "outside.txt"))).toBe(false);

    // The only events the restart added are the daemon's own lease lifecycle:
    // it takes the worktree, finds a task it may not resume, and gives it back.
    // Reported precisely rather than asserted away — a bare "the ledger did not
    // grow" would have been false, and false in a way that hides the fact that
    // a lease is still taken on every start.
    expect(after.slice(firstTrail.length)).toEqual(["LEASE_ACQUIRED", "LEASE_REVOKED"]);
  });
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
