import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { ShutdownError, StartupError } from "../../src/errors/index.js";
import type { Resource } from "../../src/lifecycle/index.js";
import {
  DAEMON_MODES,
  UnwindStack,
  assertReservedPortsFree,
  classify,
  isDaemonMode,
  portIsFree,
  timedOut,
  withDeadline,
} from "../../src/lifecycle/index.js";
import { daemonRootPath } from "../../src/paths/index.js";
import type { StopResult } from "../../src/index.js";
import { stopDaemon, terminateDaemon } from "../../src/index.js";

afterEach(() => {
  rmSync(daemonRootPath(), { recursive: true, force: true });
});

function recorder(name: string, into: string[], failure: string | null = null): Resource {
  return {
    name,
    release: (): Promise<string | null> => {
      into.push(name);
      return Promise.resolve(failure);
    },
  };
}

describe("modes are explicit", () => {
  it("recognises exactly the two", () => {
    expect([...DAEMON_MODES]).toEqual(["SQLITE_SUPERVISOR", "RESTATE"]);
    expect(isDaemonMode("SQLITE_SUPERVISOR")).toBe(true);
    expect(isDaemonMode("RESTATE")).toBe(true);
  });

  it("refuses anything else, including a plausible-looking alias", () => {
    // There is no auto-detection and no failover, so there is no third value
    // that could mean "work it out".
    expect(isDaemonMode("sqlite")).toBe(false);
    expect(isDaemonMode("AUTO")).toBe(false);
    expect(isDaemonMode("")).toBe(false);
    expect(isDaemonMode(undefined)).toBe(false);
    expect(isDaemonMode(null)).toBe(false);
  });
});

describe("the unwind stack", () => {
  it("releases in strict reverse of acquisition", async () => {
    // Acquisition order defines release order. The endpoint must close before
    // the server it is connected to, and the lock must outlive both.
    const released: string[] = [];
    const stack = new UnwindStack();
    stack.push(recorder("singleton", released));
    stack.push(recorder("ledger", released));
    stack.push(recorder("restate-server", released));
    stack.push(recorder("endpoint", released));

    const outcome = await stack.unwindAll();
    expect(released).toEqual(["endpoint", "restate-server", "ledger", "singleton"]);
    expect(outcome.failures).toEqual([]);
  });

  it("keeps going when one release fails, and reports which", async () => {
    // A release that stopped the unwind would strand everything acquired
    // before it, which is the opposite of what cleanup is for.
    const released: string[] = [];
    const stack = new UnwindStack();
    stack.push(recorder("singleton", released));
    stack.push(recorder("endpoint", released, "ETIMEDOUT"));

    const outcome = await stack.unwindAll();
    expect(released).toEqual(["endpoint", "singleton"]);
    expect(outcome.released).toEqual(["singleton"]);
    expect(outcome.failures).toEqual(["endpoint: ETIMEDOUT"]);
  });

  it("survives a release that throws", async () => {
    const stack = new UnwindStack();
    stack.push({
      name: "hostile",
      release: () => Promise.reject(new Error("nope")),
    });
    const outcome = await stack.unwindAll();
    expect(outcome.failures).toEqual(["hostile: Error"]);
  });

  it("is idempotent, so a second signal cannot start a second unwind", async () => {
    const released: string[] = [];
    const stack = new UnwindStack();
    stack.push(recorder("singleton", released));

    await stack.unwindAll();
    const second = await stack.unwindAll();
    expect(released).toEqual(["singleton"]);
    expect(second).toEqual({ released: [], failures: [] });
  });

  it("refuses an acquisition after the unwind began", async () => {
    const stack = new UnwindStack();
    await stack.unwindAll();
    expect(() => { stack.push(recorder("late", [])); }).toThrow(ShutdownError);
  });

  it("reports what it currently owns", () => {
    const stack = new UnwindStack();
    stack.push(recorder("singleton", []));
    stack.push(recorder("ledger", []));
    expect([...stack.acquired]).toEqual(["singleton", "ledger"]);
  });
});

describe("classifying a throw", () => {
  it("prefers a code and never the rendered message", () => {
    // The rendered exception is unbounded text of unknown provenance, and it is
    // how absolute paths and payload fragments reach a log file.
    expect(classify(Object.assign(new Error("/Users/someone/secret"), { code: "EACCES" }))).toBe(
      "EACCES",
    );
    expect(classify(new TypeError("/Users/someone/secret"))).toBe("TypeError");
    expect(classify("a bare string")).toBe("UNKNOWN");
  });
});

describe("deadlines", () => {
  it("returns the value when the work finishes first", async () => {
    const result = await withDeadline(Promise.resolve("done"), 5_000, "work");
    expect(timedOut(result)).toBe(false);
    expect(result).toBe("done");
  });

  it("returns a classified marker rather than throwing", async () => {
    // Every caller is already on a failure path and needs to keep unwinding.
    const never = new Promise<string>(() => undefined);
    const result = await withDeadline(never, 20, "work");
    expect(timedOut(result)).toBe(true);
  });
});

describe("the port precheck", () => {
  it("reports an unbound loopback port as free", async () => {
    await expect(portIsFree(9_099)).resolves.toBe(true);
  });

  it("passes when the pinned ports are unbound", async () => {
    await expect(assertReservedPortsFree()).resolves.toBeUndefined();
  });

  it("refuses loudly rather than choosing another port", async () => {
    // The pinned addresses are part of the contract. A daemon that quietly
    // moved would pass its own drills and then not be where anything expects.
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((): Promise<Response> => {
      calls += 1;
      return Promise.resolve(new Response("", { status: 200 }));
    }) as typeof globalThis.fetch;
    try {
      await expect(assertReservedPortsFree([8080])).rejects.toThrow(StartupError);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(1);
  });
});
describe("the aggregate drain bound", () => {
  it("returns a classified timeout when a shutdown never finishes", async () => {
    // Per-resource deadlines keep any single release honest; this one keeps the
    // whole shutdown honest. Both are needed: a dozen releases each finishing
    // just inside their own bound still add up to a hang.
    //
    // The deadline is a parameter precisely so this can be proven in
    // milliseconds rather than by a test that sits for the full thirty seconds.
    const stuck = {
      mode: "SQLITE_SUPERVISOR" as const,
      phases: [],
      serverPid: null,
      terminal: null,
      stop: () => new Promise<StopResult>(() => undefined),
      terminate: () => new Promise<StopResult>(() => undefined),
    };

    const result = await stopDaemon(stuck, 20);
    expect(result.stopped).toBe(false);
    expect(result.outcome.failures).toEqual(["drain-deadline"]);

    const terminated = await terminateDaemon(stuck, "SUPERVISION", "never finishes", 20);
    expect(terminated.stopped).toBe(false);
    expect(terminated.outcome.failures).toEqual(["drain-deadline"]);
  });

  it("returns the real result when the shutdown finishes in time", async () => {
    const clean = {
      mode: "RESTATE" as const,
      phases: [],
      serverPid: null,
      terminal: null,
      stop: () => Promise.resolve({ stopped: true, outcome: { released: ["a"], failures: [] } }),
      terminate: () => Promise.resolve({ stopped: true, outcome: { released: [], failures: [] } }),
    };
    await expect(stopDaemon(clean, 5_000)).resolves.toMatchObject({ stopped: true });
  });
});
