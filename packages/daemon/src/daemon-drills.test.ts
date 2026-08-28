import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { openLedger } from "@acp/ledger";
import {
  RESERVED_LOOPBACK_PORTS,
  RESTATE_INGRESS_PORT,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
  startVerifiedServer,
} from "@acp/runtime";

import { ModeError, SingletonError } from "./errors.js";
import { UnwindStack, portIsFree } from "./lifecycle.js";
import { startRestateMode } from "./mode-restate.js";
import { daemonRootPath, pidfilePath, resolveDaemonRoot, statusPath } from "./paths.js";
import { recoverStaleLock } from "./singleton.js";
import { readStatusFrom } from "./status.js";
import { createPsInspector } from "./identity-probe.js";
import { startDaemon } from "./index.js";

/**
 * Real processes, real signals.
 *
 * Every shutdown claim here is proven by ending an actual process. A shutdown
 * demonstrated by calling a function in this process proves nothing: the file
 * handles, the page cache and every object survive it, which is precisely what
 * losing a process does not do.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = dirname(HERE);
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "daemon-child.js");
const DIGEST = "b".repeat(64);
const EMITTED_BY = "claude/opus/implementer/01";
const TASK_FOR_UNVERIFIED = "11111111-2222-5333-8444-555555555555";

const scenarios: string[] = [];
const spawned: number[] = [];

interface ReadyLine {
  readonly ready: boolean;
  readonly pid: number;
  readonly serverPid: number | null;
  readonly phases: string[];
}

beforeAll(() => {
  const built = spawnSync(process.execPath, [
    join(PACKAGE_ROOT, "..", "..", "node_modules", "typescript", "bin", "tsc"),
    "--build",
    join(PACKAGE_ROOT, "tsconfig.json"),
  ]);
  if (built.status !== 0 || !existsSync(CHILD_ENTRY)) {
    throw new Error("could not build the daemon package for the drills");
  }
}, 120_000);

afterEach(() => {
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
  rmSync(daemonRootPath(), { recursive: true, force: true });
});

afterAll(() => {
  // Leak verification belongs after every real-process test, not inside one:
  // a check that runs while later drills still have children would report a
  // number that is true and meaningless.
  const alive = spawned.filter(isAlive);
  const receipt = {
    drill: "D-LEAK-FINAL",
    processesChecked: spawned.length,
    stillAlive: alive.length,
  };
  process.stdout.write("RECEIPT " + JSON.stringify(receipt) + "\n");
  expect(alive).toEqual([]);
});

function isAlive(pid: number): boolean {
  const probe = spawnSync("/bin/ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() !== "";
}

/** Exactly the pinned server's processes, by binary path, as pids. */
function restateServerPids(): number[] {
  const listing = spawnSync("/bin/ps", ["-Ao", "pid=,command="], { encoding: "utf8" }).stdout;
  return listing
    .split("\n")
    .filter((line) => line.includes("restate-server-1.7.7/restate-server"))
    .map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10))
    .filter((pid) => Number.isInteger(pid));
}

function scenario(name: string): string {
  scenarios.push(name);
  resolveScenarioRoot(name);
  return name;
}

/**
 * A task identifier is a UUID, and a scenario identifier is a directory-safe
 * name. They are different alphabets and cannot be the same value.
 */
function configFor(
  scenarioId: string,
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
      submittedAt: "2026-08-27T18:46:07.000Z",
      submissionDigest: DIGEST,
      holdOpen: true,
      checkPorts: false,
      ...overrides,
    }),
  };
}

/** Spawn the child and resolve once it announces readiness. */
function startChild(config: string): { child: ChildProcess; ready: Promise<ReadyLine>; lines: string[] } {
  const child = spawn(process.execPath, [CHILD_ENTRY, config], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: PACKAGE_ROOT,
  });
  if (child.pid !== undefined) spawned.push(child.pid);

  const lines: string[] = [];
  const ready = new Promise<ReadyLine>((resolvePromise, rejectPromise) => {
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== "") lines.push(line);
        if (line.includes('"ready"')) resolvePromise(JSON.parse(line) as ReadyLine);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      rejectPromise(new Error("the child exited before readiness (" + String(code) + "): " + stderr));
    });
  });
  return { child, ready, lines };
}

/** Wait for a child to close, returning its exit code and signal. */
function closed(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("close", (code, signal) => { resolvePromise({ code, signal }); });
  });
}

function markers(scenarioId: string): number {
  const effects = join(resolveScenarioRoot(scenarioId), "effects");
  return existsSync(effects)
    ? readdirSync(effects).filter((name) => name.endsWith(".marker")).length
    : 0;
}

// ---------------------------------------------------------------------------
// D-SQLITE-1 and D-MODE-1
// ---------------------------------------------------------------------------

describe("the SQLite mode", () => {
  it("reaches a checkpoint and exits cleanly, binding and spawning nothing", async () => {
    const id = scenario("daemon-sqlite-run");
    const before = spawnSync("/bin/ps", ["-Ao", "command="], { encoding: "utf8" }).stdout;
    const serversBefore = (before.match(new RegExp("restate-server", "g")) ?? []).length;

    const plan = configFor(id, { holdOpen: false });
    const { child, ready } = startChild(plan.config);
    await ready;
    const exit = await closed(child);
    expect(exit.code).toBe(0);

    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)));
    try {
      expect(ledger.getTask(plan.taskId)?.currentState).toBe("CHECKPOINTED");
      expect(ledger.verifyIntegrity().ok).toBe(true);
      expect(markers(id)).toBe(1);
    } finally {
      ledger.close();
    }

    // The mode that must work when the external server is unavailable cannot
    // itself depend on it.
    const after = spawnSync("/bin/ps", ["-Ao", "command="], { encoding: "utf8" }).stdout;
    expect((after.match(new RegExp("restate-server", "g")) ?? []).length).toBe(serversBefore);
    for (const port of RESERVED_LOOPBACK_PORTS) {
      await expect(portIsFree(port)).resolves.toBe(true);
    }
  });

  it("removes its lock and its status on a clean exit", async () => {
    const id = scenario("daemon-sqlite-clean");
    const root = resolveDaemonRoot();
    const { child, ready } = startChild(configFor(id, { holdOpen: false }).config);
    await ready;
    expect((await closed(child)).code).toBe(0);
    expect(existsSync(pidfilePath(root))).toBe(false);
    expect(existsSync(statusPath(root))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-SIG-1, D-SIG-2, D-SIG-3
// ---------------------------------------------------------------------------

describe("signals", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it("drains and exits 0 on " + signal, async () => {
      const id = scenario("daemon-signal-" + signal.toLowerCase());
      const root = resolveDaemonRoot();
      const { child, ready } = startChild(configFor(id).config);
      const announced = await ready;
      expect(existsSync(pidfilePath(root))).toBe(true);

      child.kill(signal);
      const exit = await closed(child);
      expect(exit.code).toBe(0);
      expect(announced.pid).toBe(child.pid);

      // Cleanup removes exactly what was owned.
      expect(existsSync(pidfilePath(root))).toBe(false);
      expect(existsSync(statusPath(root))).toBe(false);
    });
  }

  it("leaves the lock behind on SIGKILL, and only explicit recovery clears it", async () => {
    const id = scenario("daemon-signal-sigkill");
    const root = resolveDaemonRoot();
    const { child, ready } = startChild(configFor(id).config);
    await ready;

    // SIGKILL cannot be caught, so nothing flushes, closes or tidies up. That
    // is the whole point: the lock must survive, because a lock that vanished
    // when its owner died would be no evidence of anything.
    child.kill("SIGKILL");
    expect((await closed(child)).signal).toBe("SIGKILL");
    expect(existsSync(pidfilePath(root))).toBe(true);

    const inspector = createPsInspector();
    const refused = await recoverStaleLock(root, inspector, { adoptStale: false });
    expect(refused.recovered).toBe(false);
    expect(existsSync(pidfilePath(root))).toBe(true);

    const recovered = await recoverStaleLock(root, inspector, { adoptStale: true });
    expect(recovered).toMatchObject({ recovered: true, verdict: "NOT_SAME" });
    expect(existsSync(pidfilePath(root))).toBe(false);

    // And the daemon starts again afterwards.
    const second = startChild(
      configFor(scenario("daemon-after-recovery"), { holdOpen: false }).config,
    );
    await second.ready;
    expect((await closed(second.child)).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D-LOCK-1
// ---------------------------------------------------------------------------

describe("the singleton against a live daemon", () => {
  it("refuses a second daemon without disturbing the first", async () => {
    const id = scenario("daemon-live-duplicate");
    const { child, ready } = startChild(configFor(id).config);
    await ready;

    await expect(
      startDaemon({
        mode: "SQLITE_SUPERVISOR",
        scenarioId: scenario("daemon-duplicate-second"),
        emittedBy: EMITTED_BY,
        taskId: randomUUID(),
        attempt: 1,
        submittedAt: "2026-08-27T18:46:07.000Z",
        submissionDigest: DIGEST,
        checkPorts: false,
      }),
    ).rejects.toThrow(SingletonError);

    // The first daemon is untouched and still answers a signal.
    expect(isAlive(child.pid ?? -1)).toBe(true);
    child.kill("SIGTERM");
    expect((await closed(child)).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D-BOUND-1 and D-MODE-3
// ---------------------------------------------------------------------------

describe("what the child will accept", () => {
  it("refuses a scenario that is a path rather than an identifier", async () => {
    const { child, ready } = startChild(configFor("../../etc").config);
    await expect(ready).rejects.toThrow();
    await closed(child);
  });

  it("refuses an unknown mode instead of choosing one", async () => {
    // No auto-detection and no failover: an unrecognised mode is a refusal.
    const { child, ready } = startChild(
      configFor(scenario("daemon-bad-mode"), { mode: "AUTO" }).config,
    );
    await expect(ready).rejects.toThrow();
    await closed(child);
  });

  it("refuses a malformed submission digest", async () => {
    const { child, ready } = startChild(
      configFor(scenario("daemon-bad-digest"), { submissionDigest: "nope" }).config,
    );
    await expect(ready).rejects.toThrow();
    await closed(child);
  });
});

// ---------------------------------------------------------------------------
// D-MODE-2
// ---------------------------------------------------------------------------

describe("Restate requested but not verified", () => {
  it("fails closed and acquires nothing", async () => {
    const id = scenario("daemon-restate-unverified");
    const root = resolveScenarioRoot(id);
    const ledger = openLedger(scenarioLedgerPath(root));
    const stack = new UnwindStack();
    try {
      await expect(
        startRestateMode({
          ledger,
          invocation: {
            taskId: TASK_FOR_UNVERIFIED,
            attempt: 1,
            invocationId: TASK_FOR_UNVERIFIED,
            submittedAt: "2026-08-27T18:46:07.000Z",
            submissionDigest: DIGEST,
          },
          scenarioRoot: root,
          emittedBy: EMITTED_BY,
          stack,
          onPhase: () => undefined,
          readAvailability: () => ({ available: false, reason: "no binary" }),
        }),
      ).rejects.toThrow(ModeError);

      // Nothing was started, so there is nothing to unwind. A fallback to the
      // other driver here would make the mode flag a lie.
      expect([...stack.acquired]).toEqual([]);
    } finally {
      ledger.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D-ORDER-1, D-ORDER-2 and D-ORDER-3
// ---------------------------------------------------------------------------

describe("the Restate mode", () => {
  it("starts in one order and is ready only after reconciling", async () => {
    const id = scenario("daemon-restate-order");
    const { child, ready } = startChild(
      configFor(id, { mode: "RESTATE", checkPorts: true }).config,
    );
    const announced = await ready;

    // The exact sequence, not a set with a few pairwise comparisons. Checking
    // membership plus three orderings is what let SERVER_UP sit in the wrong
    // place: every individual assertion was true while the published order was
    // not the order anything happened in.
    expect(announced.phases).toEqual([
      "ROOTS_VALIDATED",
      "SINGLETON_HELD",
      "LEDGER_OPEN",
      "BINARY_VERIFIED",
      "SERVER_UP",
      "ENDPOINT_UP",
      "DEPLOYMENT_REGISTERED",
      "RECONCILED",
      "READY",
      "SUPERVISING",
    ]);
    // Readiness is RECONCILED, not SERVER_UP. A server that is listening but
    // has not agreed with the ledger is not ready, and calling it ready is how
    // a derived driver quietly becomes an authority.
    const order = announced.phases;
    expect(order.indexOf("SERVER_UP")).toBeLessThan(order.indexOf("ENDPOINT_UP"));
    expect(order.indexOf("RECONCILED")).toBeLessThan(order.indexOf("READY"));
    expect(announced.serverPid).not.toBeNull();
    if (announced.serverPid !== null) spawned.push(announced.serverPid);

    child.kill("SIGTERM");
    expect((await closed(child)).code).toBe(0);
    // Reverse unwind released the server too, not only this process.
    expect(isAlive(announced.serverPid ?? -1)).toBe(false);
  }, 180_000);

  it("treats an unexpected server death as terminal and exits nonzero", async () => {
    const id = scenario("daemon-restate-terminal");
    const { child, ready, lines } = startChild(
      configFor(id, { mode: "RESTATE", checkPorts: true }).config,
    );
    const announced = await ready;
    expect(announced.serverPid).not.toBeNull();
    const serverPid = announced.serverPid ?? -1;
    spawned.push(serverPid);

    // Kill exactly the server, by the pid the daemon published. Nothing broad,
    // nothing pattern-matched across the machine.
    process.kill(serverPid, "SIGKILL");

    const exit = await closed(child);
    // Never a restart and never a silent failover to the other driver: a
    // failover here would make the requested mode a lie.
    expect(exit.code).toBe(70);
    expect(lines.join("\n")).toContain("UNEXPECTED_EXIT");

    const root = resolveDaemonRoot();
    expect(existsSync(pidfilePath(root))).toBe(false);
    expect(isAlive(serverPid)).toBe(false);

    // stdout is the daemon talking about itself. The classified TERMINAL
    // status is the durable account, published before the unwind and
    // deliberately left in place afterwards: a clean shutdown removes its
    // status because nothing remains to explain, but this document is the only
    // record of why the process is gone.
    const finalStatus = readStatusFrom(root);
    expect(finalStatus).not.toBeNull();
    expect(finalStatus?.phase).toBe("TERMINAL");
    expect(finalStatus?.errorCode).toBe("SUPERVISION");
    expect(finalStatus?.serverPid).toBe(serverPid);
  }, 180_000);

  it("refuses when a pinned port is held by something that is not a daemon", async () => {
    // The earlier version of this drill started a second daemon in the same
    // checkout, so the existing pidfile rejected it before it ever reached the
    // port precheck. It proved the singleton twice and the port backstop not at
    // all. The holder here is a bare listener with no lock of its own, and no
    // pidfile exists when the daemon starts, so the only thing that can refuse
    // it is the precheck.
    const id = scenario("daemon-restate-ports");
    const root = resolveDaemonRoot();
    rmSync(pidfilePath(root), { force: true });
    expect(existsSync(pidfilePath(root))).toBe(false);

    const holder = spawn(
      process.execPath,
      [
        "-e",
        "require('node:http').createServer().listen(" +
          String(RESTATE_INGRESS_PORT) +
          ", '127.0.0.1', () => { console.log('bound'); });",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (holder.pid !== undefined) spawned.push(holder.pid);
    await new Promise<void>((resolvePromise) => {
      holder.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("bound")) resolvePromise();
      });
    });

    try {
      await expect(
        startDaemon({
          mode: "RESTATE",
          scenarioId: id,
          emittedBy: EMITTED_BY,
          taskId: randomUUID(),
          attempt: 1,
          submittedAt: "2026-08-27T18:46:07.000Z",
          submissionDigest: DIGEST,
          checkPorts: true,
        }),
      ).rejects.toThrow(/already in use/);

      // It got as far as taking the lock, so the proof that matters is that it
      // gave it back: the unwind released the singleton and the status it had
      // just acquired.
      expect(existsSync(pidfilePath(root))).toBe(false);
      expect(existsSync(statusPath(root))).toBe(false);
      expect(isAlive(holder.pid ?? -1)).toBe(true);
    } finally {
      // Exactly this pid, by the handle we hold. Nothing broad.
      holder.kill("SIGKILL");
      await new Promise<void>((resolvePromise) => holder.once("close", () => { resolvePromise(); }));
    }
  }, 180_000);
});
// ---------------------------------------------------------------------------
// C7: the pre-handle window
// ---------------------------------------------------------------------------

describe("a server that never reaches readiness", () => {
  it("is stopped by the function that spawned it, not leaked", async () => {
    // The window this closes: `startServer` spawns the child and then awaits
    // readiness. If readiness throws, no caller has ever received the handle,
    // so no unwind stack contains it and nothing else can clean it up. The
    // spawner has to own the child until it hands it over.
    //
    // Everything here is real: a real pinned binary really starts. Only the
    // readiness check is replaced, because a server that genuinely refuses to
    // become ready cannot be produced on demand.
    const id = scenario("daemon-readiness-failure");
    const root = resolveScenarioRoot(id);
    const before = restateServerPids();

    await expect(
      startVerifiedServer(root, () => Promise.reject(new Error("admin never came up"))),
    ).rejects.toThrow(/admin never came up/);

    // Exact pids, not a count: whichever server this call started must be gone.
    const survivors = restateServerPids().filter((pid) => !before.includes(pid));
    expect(survivors).toEqual([]);

    for (const port of RESERVED_LOOPBACK_PORTS) {
      await expect(portIsFree(port)).resolves.toBe(true);
    }
  }, 180_000);
});
