import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { IdentityProbeError, SingletonError, StaleLockError } from "../../src/errors/index.js";
import type { ProcessFacts, ProcessInspector, RecordedIdentity } from "../../src/identity-probe/index.js";
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
