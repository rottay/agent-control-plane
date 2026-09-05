import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { IdentityProbeError, SingletonError, StaleLockError } from "../../src/errors/index.js";
import type { ProcessFacts, ProcessInspector, RecordedIdentity } from "../../src/identity-probe/index.js";
import type { RecordedServer } from "../../src/singleton/index.js";
import { commandDigest } from "../../src/identity-probe/index.js";
import { daemonRootPath, pidfilePath, resolveDaemonRoot } from "../../src/paths/index.js";
import {
  acquireSingleton,
  parseLockRecord,
  recoverStaleLock,
  releaseSingleton,
} from "../../src/singleton/index.js";

const AT = "2026-08-27T18:46:07.000Z";

const OWNER: RecordedIdentity = {
  pid: 4242,
  startToken: "Wed Aug 27 18:46:07 2026",
  argvDigest: commandDigest("node daemon-child.js"),
};

function inspectorReturning(facts: ProcessFacts | null): ProcessInspector {
  return { inspect: () => Promise.resolve(facts) };
}

const LIVE = inspectorReturning({
  startToken: OWNER.startToken,
  argvDigest: OWNER.argvDigest,
});
const GONE = inspectorReturning(null);
const AMBIGUOUS = inspectorReturning({
  startToken: OWNER.startToken,
  argvDigest: commandDigest("node something-else.js"),
});

afterEach(() => {
  rmSync(daemonRootPath(), { recursive: true, force: true });
});

describe("taking the lock", () => {
  it("writes the identity it recorded", async () => {
    const root = resolveDaemonRoot();
    const handle = await acquireSingleton(root, OWNER, "SQLITE_SUPERVISOR", AT, LIVE);
    expect(handle.record.pid).toBe(OWNER.pid);
    const onDisk = parseLockRecord(readFileSync(pidfilePath(root), "utf8"));
    expect(onDisk).toEqual({ ...OWNER, mode: "SQLITE_SUPERVISOR", acquiredAt: AT });
  });

  it("refuses a second live daemon and leaves the first lock untouched", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "SQLITE_SUPERVISOR", AT, LIVE);
    const before = readFileSync(pidfilePath(root), "utf8");

    await expect(
      acquireSingleton(root, { ...OWNER, pid: 9999 }, "SQLITE_SUPERVISOR", AT, LIVE),
    ).rejects.toThrow(SingletonError);

    // The loser never had a window in which it believed it had won.
    expect(readFileSync(pidfilePath(root), "utf8")).toBe(before);
  });

  it("classifies an abandoned lock as stale rather than taking it", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    await expect(
      acquireSingleton(root, { ...OWNER, pid: 9999 }, "RESTATE", AT, GONE),
    ).rejects.toThrow(StaleLockError);
    expect(existsSync(pidfilePath(root))).toBe(true);
  });

  it("refuses on an indeterminate identity without touching anything", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    await expect(
      acquireSingleton(root, { ...OWNER, pid: 9999 }, "RESTATE", AT, AMBIGUOUS),
    ).rejects.toThrow(IdentityProbeError);
    expect(existsSync(pidfilePath(root))).toBe(true);
  });

  it("refuses an unparseable lock rather than assuming it is junk", async () => {
    const root = resolveDaemonRoot();
    writeFileSync(pidfilePath(root), "not json", "utf8");
    await expect(acquireSingleton(root, OWNER, "RESTATE", AT, GONE)).rejects.toThrow(
      IdentityProbeError,
    );
    expect(existsSync(pidfilePath(root))).toBe(true);
  });
});

describe("parsing a lock record", () => {
  it("rejects anything malformed, because a lock we cannot read is not one we may remove", () => {
    expect(parseLockRecord("not json")).toBeNull();
    expect(parseLockRecord("null")).toBeNull();
    expect(parseLockRecord(JSON.stringify({ pid: 0 }))).toBeNull();
    expect(parseLockRecord(JSON.stringify({ ...OWNER, pid: -1, mode: "x", acquiredAt: AT }))).toBeNull();
    expect(parseLockRecord(JSON.stringify({ ...OWNER, startToken: "", mode: "x", acquiredAt: AT }))).toBeNull();
  });
});

describe("recovering a stale lock", () => {
  it("does nothing without an explicit decision", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    const result = await recoverStaleLock(root, GONE, { adoptStale: false });
    expect(result.recovered).toBe(false);
    expect(existsSync(pidfilePath(root))).toBe(true);
  });

  it("removes only a lock proven to belong to nobody", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    const result = await recoverStaleLock(root, GONE, { adoptStale: true });
    expect(result).toMatchObject({ recovered: true, verdict: "NOT_SAME" });
    expect(existsSync(pidfilePath(root))).toBe(false);
  });

  it("refuses to remove a live daemon's lock even when asked", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    const result = await recoverStaleLock(root, LIVE, { adoptStale: true });
    expect(result.recovered).toBe(false);
    expect(result.verdict).toBe("SAME_LIVE_DAEMON");
    expect(existsSync(pidfilePath(root))).toBe(true);
  });

  it("refuses on an ambiguous identity even when asked", async () => {
    // The ambiguous case is exactly the one where acting would evict a process
    // that is doing its job, so it is the one case that must not act.
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    const result = await recoverStaleLock(root, AMBIGUOUS, { adoptStale: true });
    expect(result.recovered).toBe(false);
    expect(result.verdict).toBe("INDETERMINATE");
    expect(existsSync(pidfilePath(root))).toBe(true);
  });

  it("reports an absent lock as absent", async () => {
    const root = resolveDaemonRoot();
    const result = await recoverStaleLock(root, GONE, { adoptStale: true });
    expect(result).toMatchObject({ recovered: false, verdict: "ABSENT" });
  });

  it("refuses to remove an unparseable lock", async () => {
    const root = resolveDaemonRoot();
    writeFileSync(pidfilePath(root), "{", "utf8");
    const result = await recoverStaleLock(root, GONE, { adoptStale: true });
    expect(result).toMatchObject({ recovered: false, verdict: "UNREADABLE" });
    expect(existsSync(pidfilePath(root))).toBe(true);
  });
});

describe("releasing the lock", () => {
  it("removes a lock this daemon owns", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    expect(releaseSingleton(root, OWNER)).toBe(true);
    expect(existsSync(pidfilePath(root))).toBe(false);
  });

  it("will not remove a lock that belongs to somebody else", async () => {
    // Releasing blindly on shutdown is how a daemon evicts the successor that
    // legitimately replaced it.
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    expect(releaseSingleton(root, { ...OWNER, pid: 5150 })).toBe(false);
    expect(existsSync(pidfilePath(root))).toBe(true);
  });

  it("is safe when there is nothing to release", () => {
    const root = resolveDaemonRoot();
    expect(releaseSingleton(root, OWNER)).toBe(false);
  });
});

/**
 * Reaping the server a dead daemon left behind (V2-B2-6).
 *
 * Every row of the verdict matrix, driven through the closed `server` value the
 * top-level entry point forwards. The decoy is a real process, because the
 * claim that matters most here is a NEGATIVE one — that nothing was signalled —
 * and the only honest way to assert it is to have something alive that would
 * have died.
 */
describe("reaping the server a dead daemon left behind", () => {
  const decoys: ChildProcess[] = [];
  const SERVER_TOKEN = "Thu Aug 28 09:15:00 2026";
  const SERVER_ARGV = commandDigest("restate-server --config-file /scenario/config.toml");

  afterEach(() => {
    for (const decoy of decoys.splice(0)) {
      try {
        decoy.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  /**
   * A live process that ignores SIGTERM, so "was it killed?" is answerable.
   *
   * Awaited to readiness rather than merely spawned: a node process that has
   * not yet run its first line has no SIGTERM handler, so a signal sent into
   * that window kills it by default and the negative assertion would pass for
   * the wrong reason.
   */
  async function decoy(): Promise<ChildProcess> {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    decoys.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the decoy never announced itself"));
      }, 10_000);
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return child;
  }

  /** A local wait: this package may not import `node:timers/promises`. */
  function settle(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** An inspector whose answers differ per call, for the re-probe guard. */
  function scriptedInspector(answers: readonly (ProcessFacts | null)[]): ProcessInspector {
    let index = 0;
    return {
      inspect: () => {
        const answer = answers[Math.min(index, answers.length - 1)] ?? null;
        index += 1;
        return Promise.resolve(answer);
      },
    };
  }

  function serverFor(pid: number): RecordedServer {
    return {
      statusPid: OWNER.pid,
      identity: { pid, startToken: SERVER_TOKEN, argvDigest: SERVER_ARGV },
    };
  }

  const SERVER_FACTS: ProcessFacts = { startToken: SERVER_TOKEN, argvDigest: SERVER_ARGV };

  it("N1 reaps nothing without an explicit decision, even with an identity in hand", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    const child = await decoy();
    const result = await recoverStaleLock(root, GONE, {
      adoptStale: false,
      server: serverFor(child.pid ?? 1),
    });
    expect(result.recovered).toBe(false);
    expect(result.reaped ?? false).toBe(false);
    expect(isAlive(child.pid ?? 1)).toBe(true);
    expect(existsSync(pidfilePath(root))).toBe(true);
  });

  it("N3 reclaims and signals nothing when the observation carried no identity", async () => {
    // The migration row and the SQLITE row at once: a pre-packet document and a
    // half-identity both fail validation upstream and arrive here as null.
    const root = resolveDaemonRoot();
    for (const server of [null, undefined]) {
      rmSync(daemonRootPath(), { recursive: true, force: true });
      const scoped = resolveDaemonRoot();
      await acquireSingleton(scoped, OWNER, "RESTATE", AT, LIVE);
      const result = await recoverStaleLock(scoped, GONE, { adoptStale: true, server });
      expect(result).toMatchObject({ recovered: true, verdict: "NOT_SAME" });
      expect(result.reaped).toBe(false);
      expect(result.serverExit).toBe("NO_IDENTITY");
      expect(existsSync(pidfilePath(scoped))).toBe(false);
    }
    void root;
  });

  it("N11 refuses a status document left by a different run, and signals nothing", async () => {
    // B3. The lock record is what recovery proved dead; a document whose own pid
    // is somebody else's is a stale witness, so nothing in it may be trusted
    // about a server. The binding is made here, against the lock this module
    // parsed itself.
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    const child = await decoy();
    const result = await recoverStaleLock(root, GONE, {
      adoptStale: true,
      server: {
        statusPid: OWNER.pid + 1,
        identity: { pid: child.pid ?? 1, startToken: SERVER_TOKEN, argvDigest: SERVER_ARGV },
      },
    });
    expect(result.serverExit).toBe("STATUS_NOT_OWNER");
    expect(result.verdict).toBe("STATUS_NOT_OWNER");
    expect(result.reaped).toBe(false);
    expect(isAlive(child.pid ?? 1)).toBe(true);
    // The lock is still reclaimed: the daemon is provably dead either way.
    expect(existsSync(pidfilePath(root))).toBe(false);
  });

  it("N4 reaps nothing when the daemon spawned no server", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    const result = await recoverStaleLock(root, GONE, { adoptStale: true, server: null });
    expect(result.serverExit).toBe("NO_IDENTITY");
    expect(result.reaped).toBe(false);
  });

  it("N5 never signals a pid whose triple does not match, proved on a live decoy", async () => {
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    const child = await decoy();
    // The pid is live, but `ps` reports a different process: the recorded triple
    // does not match, so there is nothing of ours to reap.
    const result = await recoverStaleLock(
      root,
      scriptedInspector([{ startToken: "Thu Aug 28 11:00:00 2026", argvDigest: SERVER_ARGV }]),
      { adoptStale: true, server: serverFor(child.pid ?? 1) },
    );
    expect(result.serverExit).toBe("ABSENT");
    expect(result.reaped).toBe(false);
    expect(isAlive(child.pid ?? 1)).toBe(true);
  });

  it("N2 refuses to signal or reclaim when the server identity is indeterminate", async () => {
    // The ambiguous case is the one where acting would hit a process doing its
    // job. It reclaims nothing either: removing the lock would invite the next
    // daemon to start against a machine nobody could identify.
    const root = resolveDaemonRoot();
    await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
    const child = await decoy();
    const result = await recoverStaleLock(
      root,
      scriptedInspector([{ startToken: SERVER_TOKEN, argvDigest: commandDigest("something else") }]),
      { adoptStale: true, server: serverFor(child.pid ?? 1) },
    );
    expect(result.serverExit).toBe("INDETERMINATE");
    expect(result.recovered).toBe(false);
    expect(result.reaped).toBe(false);
    expect(isAlive(child.pid ?? 1)).toBe(true);
    expect(existsSync(pidfilePath(root))).toBe(true);
  });

  it(
    "N10 sends no SIGKILL when the pid changed hands inside the deadline",
    async () => {
      // The B2 guard, at the deadline rather than at the start. A pid freed by a
      // graceful exit can be recycled inside the window, and an unguarded
      // escalation would then kill a stranger. The decoy ignores SIGTERM and is
      // asserted alive afterwards, which is what proves no SIGKILL was sent.
      const root = resolveDaemonRoot();
      await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
      const child = await decoy();
      const result = await recoverStaleLock(
        root,
        // Three answers, because the lock's own probe consumes the first: null
        // proves the daemon gone, then the server matches, then the pid has
        // changed hands.
        scriptedInspector([
          null,
          SERVER_FACTS,
          { startToken: "Thu Aug 28 12:00:00 2026", argvDigest: commandDigest("a stranger") },
        ]),
        { adoptStale: true, server: serverFor(child.pid ?? 1) },
      );
      // The assertion that carries the claim: the decoy ignores SIGTERM, so it
      // is alive here if and only if no SIGKILL followed. The escalation was
      // withheld because the re-probe no longer recognised the pid.
      expect(isAlive(child.pid ?? 1)).toBe(true);
      // And the reap ended without escalating: our server no longer holds that
      // pid, so it is gone as far as this daemon is concerned.
      expect(["STOPPED", "PORTS_STILL_HELD"]).toContain(result.serverExit);
      await settle(10);
    },
    60_000,
  );

  it(
    "N10 sends no SIGKILL when the re-probe becomes indeterminate",
    async () => {
      // The other non-escalating branch. `INDETERMINATE` at the deadline is the
      // same refusal as at the start: proof is required twice, and an answer
      // that proves nothing is not proof the second time either.
      const root = resolveDaemonRoot();
      await acquireSingleton(root, OWNER, "RESTATE", AT, LIVE);
      const child = await decoy();
      const result = await recoverStaleLock(
        root,
        scriptedInspector([
          null,
          SERVER_FACTS,
          { startToken: SERVER_TOKEN, argvDigest: commandDigest("a different program") },
        ]),
        { adoptStale: true, server: serverFor(child.pid ?? 1) },
      );
      expect(isAlive(child.pid ?? 1)).toBe(true);
      expect(result.serverExit).toBe("INDETERMINATE");
      expect(result.recovered).toBe(false);
      await settle(10);
    },
    60_000,
  );
});
