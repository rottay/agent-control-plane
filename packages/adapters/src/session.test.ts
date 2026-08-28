import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AdmittedBinary,
  AdmittedConfigRoot,
  AdmittedWorkdir,
  ProviderAdapter,
  SessionLimits,
  SessionRequest,
} from "./contract.js";
import { AdapterError } from "./errors.js";
import type { NormalizedEvent } from "./events.js";
import { admitBinary } from "./process/spawn.js";
import { descriptorEnablesWrites, isReadOnlyIdentity, startSession } from "./session.js";
import { fakeAdapter, fakeProviderArgv } from "./testing/fake-provider.js";
import type { FakeScript } from "./testing/fake-provider.js";

const TMP_ROOT = realpathSync(tmpdir());
const NODE = realpathSync(process.execPath) as AdmittedBinary;
const IMPLEMENTER = "anthropic/claude-opus-5/implementer/01";
const REVIEWER = "anthropic/claude-fable/reviewer/01";
const TASK = "00000000-0000-4000-8000-00000000000a";

const created: string[] = [];
/** Every PID this file spawned, swept at the end of this file. */
const ownedPids: number[] = [];

function drillRoot(): string {
  const path = join(TMP_ROOT, "acp-p4a-session-" + randomUUID());
  mkdirSync(path, { recursive: true, mode: 0o700 });
  created.push(path);
  return path;
}

function limits(overrides: Partial<SessionLimits> = {}): SessionLimits {
  return {
    timeoutMs: 5_000,
    outputBudgetBytes: 64 * 1024,
    interruptGraceMs: 120,
    termGraceMs: 120,
    ...overrides,
  };
}

function request(
  identity: string,
  script: FakeScript,
  overrides: Partial<SessionRequest> = {},
): SessionRequest {
  const root = drillRoot();
  return {
    identity,
    taskId: TASK,
    attempt: 1,
    modelAlias: "opus",
    binary: NODE,
    configRoot: root as AdmittedConfigRoot,
    workdir: root as AdmittedWorkdir,
    resumeSessionId: null,
    limits: limits(),
    ...overrides,
  } as SessionRequest;
}

/** The fake adapter, with argv rewritten to run one script. */
function scripted(script: FakeScript): ProviderAdapter {
  return {
    ...fakeAdapter,
    describe(req: SessionRequest) {
      return {
        provider: "claude" as const,
        argv: fakeProviderArgv(script),
        env: { PATH: "/usr/bin:/bin" },
        cwd: req.workdir,
      };
    },
  };
}

async function collect(script: FakeScript, identity = IMPLEMENTER): Promise<{
  readonly events: NormalizedEvent[];
  readonly failure: AdapterError | null;
}> {
  const session = startSession(scripted(script), request(identity, script));
  ownedPids.push(session.pid);
  const events: NormalizedEvent[] = [];
  let failure: AdapterError | null = null;
  try {
    for await (const event of session.events()) events.push(event);
  } catch (error) {
    failure = error as AdapterError;
  }
  if (session.state === "FAILED") {
    const probe = session.health();
    if (probe.classifiedError !== null && failure === null) {
      failure = new AdapterError(
        probe.classifiedError as AdapterError["code"],
        { provider: "claude", taskId: TASK },
      );
    }
  }
  await session.close();
  return { events, failure };
}

afterEach(() => {
  const prefix = join(TMP_ROOT, "acp-p4a-");
  while (created.length > 0) {
    const path = created.pop();
    if (path?.startsWith(prefix) === true) rmSync(path, { recursive: true, force: true });
  }
});

const STARTED = JSON.stringify({ type: "started", resolvedModel: "m-1", protocolVersion: "1" });
const STEP = JSON.stringify({ type: "step", tokensUsed: 1200, stepIndex: 0 });

describe("a session streams what the provider actually said", () => {
  it("starts, streams and closes", async () => {
    const { events, failure } = await collect({ lines: [STARTED, STEP], exitCode: 0 });
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual(["session.started", "step.completed"]);
    expect(events[0]?.frozenType).toBe("RUN_STARTED");
    expect(events[1]?.payload["tokensUsed"]).toBe(1200);
  });

  it("reassembles a record split across chunk boundaries", async () => {
    // The provider writes one record in fragments; a parser that assumed whole
    // records per chunk would pass every tidy fixture and fail every real stream.
    const halves = [STARTED.slice(0, 10), STARTED.slice(10) + "\n"];
    const { events, failure } = await collect({ lines: [], exitCode: 0, ...({} as object) });
    expect(failure).toBeNull();
    expect(events).toEqual([]);
    // And the framing itself, exercised directly on the parser:
    let cursor = { partial: "", recordIndex: 0 };
    const seen: string[] = [];
    for (const half of halves) {
      const outcome = fakeAdapter.parse(half, cursor);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      cursor = outcome.cursor;
      for (const signal of outcome.events) seen.push(signal.kind);
    }
    expect(seen).toEqual(["started"]);
  });

  it("decodes a multibyte codepoint split across two chunks", async () => {
    // "é" is two bytes; splitting between them and decoding each chunk
    // independently yields replacement characters. The decoder is stateful for
    // exactly this case.
    const record = JSON.stringify({ type: "checkpoint", digest: "café" }) + "\n";
    const bytes = Buffer.from(record, "utf8");
    const cut = bytes.indexOf(Buffer.from("é", "utf8")[0] ?? 0) + 1;
    const { StringDecoder } = await import("node:string_decoder");
    const decoder = new StringDecoder("utf8");
    const first = decoder.write(bytes.subarray(0, cut));
    const second = decoder.write(bytes.subarray(cut));
    expect(first + second).toBe(record);
    expect(first + second).not.toContain("�");
  });

  it("counts stdout and stderr against one budget", async () => {
    // A provider that wrote its overflow to stderr would slip a stdout-only
    // bound, so the budget is on what the process produced, not on which pipe.
    const noisy = JSON.stringify({ type: "checkpoint", digest: "x".repeat(400) });
    const session = startSession(
      scripted({ lines: [noisy, noisy, noisy], exitCode: 0, toStderr: true }),
      request(IMPLEMENTER, { lines: [], exitCode: 0 }, { limits: limits({ outputBudgetBytes: 64 }) }),
    );
    ownedPids.push(session.pid);
    for await (const event of session.events()) void event;
    await session.close();
    expect(session.state).toBe("FAILED");
    expect(session.health().classifiedError).toBe("OUTPUT_BUDGET_EXCEEDED");
  });
});

describe("a session fails closed on anything it cannot classify", () => {
  it("refuses an unknown event type", async () => {
    const { failure } = await collect({
      lines: [JSON.stringify({ type: "not-a-known-type" })],
      exitCode: 0,
    });
    expect(failure?.code).toBe("UNKNOWN_EVENT");
  });

  it("refuses a malformed record", async () => {
    const { failure } = await collect({ lines: ["{ not json"], exitCode: 0 });
    expect(failure?.code).toBe("MALFORMED_EVENT");
  });

  it("refuses a known event whose payload is the wrong shape", async () => {
    const { failure } = await collect({
      lines: [JSON.stringify({ type: "step", tokensUsed: "many", stepIndex: 0 })],
      exitCode: 0,
    });
    expect(failure?.code).toBe("MALFORMED_EVENT");
  });

  it("survives an abnormal exit without leaving the session running", async () => {
    const session = startSession(
      scripted({ lines: [STARTED], exitCode: 3 }),
      request(IMPLEMENTER, { lines: [], exitCode: 3 }),
    );
    ownedPids.push(session.pid);
    for await (const event of session.events()) void event;
    await session.close();
    expect(session.state).toBe("CLOSED");
  });
});

describe("the reviewer guarantee is structural, not a setting", () => {
  it("recognizes a reviewer identity", () => {
    expect(isReadOnlyIdentity(REVIEWER as never)).toBe(true);
    expect(isReadOnlyIdentity(IMPLEMENTER as never)).toBe(false);
  });

  it("refuses a write-enabling flag before anything is spawned", () => {
    expect(descriptorEnablesWrites(["--dangerously-skip-permissions"])).toBe(true);
    expect(descriptorEnablesWrites(["--sandbox=danger-full-access"])).toBe(true);
    expect(descriptorEnablesWrites(["-p", "--model", "opus"])).toBe(false);

    const writer: ProviderAdapter = {
      ...fakeAdapter,
      describe(req: SessionRequest) {
        return {
          provider: "claude" as const,
          argv: ["--yolo"],
          env: {},
          cwd: req.workdir,
        };
      },
    };
    expect(() => startSession(writer, request(REVIEWER, { lines: [], exitCode: 0 }))).toThrow(
      AdapterError,
    );
  });

  it("catches the two-token spelling of every pair-capable flag", () => {
    // The single-token scan this replaced would wave through each of these,
    // which are identical in effect to the `--flag=value` forms it did catch.
    const bypasses: readonly (readonly string[])[] = [
      ["--permission-mode", "acceptEdits"],
      ["--permission-mode", "bypassPermissions"],
      ["--sandbox", "workspace-write"],
      ["--sandbox", "danger-full-access"],
      ["-s", "danger-full-access"],
      ["--ask-for-approval", "on-request"],
      ["-a", "on-request"],
    ];
    for (const argv of bypasses) {
      expect({ argv, writes: descriptorEnablesWrites(argv) }).toEqual({ argv, writes: true });
    }
  });

  it("accepts the known-safe pair values without a false positive", () => {
    const safe: readonly (readonly string[])[] = [
      ["--permission-mode", "plan"],
      ["--permission-mode=plan"],
      ["--sandbox", "read-only"],
      ["--sandbox=read-only"],
      ["-s", "read-only"],
      ["--ask-for-approval", "never"],
      ["-a", "never"],
      ["-p", "--model", "opus", "--sandbox", "read-only"],
    ];
    for (const argv of safe) {
      expect({ argv, writes: descriptorEnablesWrites(argv) }).toEqual({ argv, writes: false });
    }
  });

  it("refuses a pair flag whose value is missing rather than assuming it is safe", () => {
    expect(descriptorEnablesWrites(["--sandbox"])).toBe(true);
    expect(descriptorEnablesWrites(["--permission-mode"])).toBe(true);
  });

  it("refuses any --dangerously- flag, including ones not yet invented", () => {
    expect(descriptorEnablesWrites(["--dangerously-something-new"])).toBe(true);
  });

  it("refuses a reviewer session whose argv uses the two-token form", () => {
    const writer: ProviderAdapter = {
      ...fakeAdapter,
      describe(req: SessionRequest) {
        return {
          provider: "claude" as const,
          argv: ["--sandbox", "workspace-write"],
          env: {},
          cwd: req.workdir,
        };
      },
    };
    expect(() => startSession(writer, request(REVIEWER, { lines: [], exitCode: 0 }))).toThrow(
      AdapterError,
    );
  });

  it("kills a reviewer session that emits a write-class event", async () => {
    // This is the load-bearing layer: whatever the provider's own settings
    // claimed, a write signal under a reviewer identity ends the session.
    const { failure } = await collect(
      { lines: [STARTED, JSON.stringify({ type: "write", target: "src/x.ts" })], exitCode: 0 },
      REVIEWER,
    );
    expect(failure?.code).toBe("READ_ONLY_VIOLATION");
  });
});

describe("the process is owned, stopped and reaped", () => {
  /** Is this PID gone? Asked only of PIDs this file created. */
  function isDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  async function waitDead(pid: number, deadlineMs = 2_000): Promise<boolean> {
    let waited = 0;
    while (waited < deadlineMs) {
      if (isDead(pid)) return true;
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 10);
      });
      waited += 10;
    }
    return isDead(pid);
  }

  /**
   * Drain a session and assert the child died without the test closing it.
   *
   * `close()` is deliberately never called here: the point of F1 is that a
   * terminal failure tears the child down itself, so a caller that never
   * reaches `close()` still cannot leave a provider running.
   */
  async function failsAndTearsDownItself(
    script: FakeScript,
    identity: string,
    expected: string,
    overrides: Partial<SessionRequest> = {},
  ): Promise<void> {
    const session = startSession(
      scripted(script),
      request(identity, { lines: [], exitCode: 0 }, overrides),
    );
    ownedPids.push(session.pid);
    try {
      for await (const event of session.events()) void event;
    } catch {
      // The iterator may surface the failure; either way the state is FAILED.
    }
    await session.settled();
    expect(session.state).toBe("FAILED");
    expect(session.health().classifiedError).toBe(expected);
    expect(await waitDead(session.pid)).toBe(true);
  }

  it("kills the child on a reviewer write violation, with no caller close", async () => {
    await failsAndTearsDownItself(
      {
        lines: [STARTED, JSON.stringify({ type: "write", target: "src/x.ts" })],
        exitCode: 0,
        lingerMs: 10_000,
      },
      REVIEWER,
      "READ_ONLY_VIOLATION",
    );
  });

  it("kills the child on a byte-budget overrun, with no caller close", async () => {
    const noisy = JSON.stringify({ type: "checkpoint", digest: "x".repeat(400) });
    await failsAndTearsDownItself(
      { lines: [noisy, noisy, noisy], exitCode: 0, lingerMs: 10_000 },
      IMPLEMENTER,
      "OUTPUT_BUDGET_EXCEEDED",
      { limits: limits({ outputBudgetBytes: 64 }) },
    );
  });

  it("kills the child on a parse failure, with no caller close", async () => {
    await failsAndTearsDownItself(
      { lines: ["{ not json"], exitCode: 0, lingerMs: 10_000 },
      IMPLEMENTER,
      "MALFORMED_EVENT",
    );
  });

  it("escalates when the child ignores SIGINT", async () => {
    const session = startSession(
      scripted({ lines: [STARTED], exitCode: 0, ignoreSigint: true, lingerMs: 10_000 }),
      request(IMPLEMENTER, { lines: [], exitCode: 0 }),
    );
    ownedPids.push(session.pid);
    // Wait for the child's first event before signalling. Interrupting sooner
    // races the interpreter's start-up: the signal arrives before the script
    // has installed its handler, the default disposition kills it, and the
    // ladder never has to climb — which would make this test pass for the
    // wrong reason rather than fail.
    const stream = session.events()[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.done).toBe(false);

    const record = await session.interrupt();
    expect(record.steps).toContain("SIGINT");
    // SIGINT was ignored, so the ladder had to climb — which is the property
    // that matters, not which rung finally worked.
    expect(record.steps).toContain("SIGTERM");
    expect(record.escalated).toBe(true);
    expect(record.viaProtocolCancel).toBe(false);
    await session.close();
  });

  it("is idempotent on close", async () => {
    const session = startSession(
      scripted({ lines: [STARTED], exitCode: 0 }),
      request(IMPLEMENTER, { lines: [], exitCode: 0 }),
    );
    ownedPids.push(session.pid);
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
    expect(session.state).toBe("CLOSED");
  });

  it("reports health in the frozen contract shape, with no clock read", async () => {
    const session = startSession(
      scripted({ lines: [STARTED], exitCode: 0 }),
      request(IMPLEMENTER, { lines: [], exitCode: 0 }),
    );
    ownedPids.push(session.pid);
    const probe = session.health();
    expect(Object.keys(probe).sort()).toEqual([
      "checkedAt",
      "classifiedError",
      "latencyMs",
      "status",
    ]);
    expect(["OK", "DEGRADED", "FAILED", "UNKNOWN"]).toContain(probe.status);
    await session.close();
  });

  it("leaves no adapter-spawned process alive", () => {
    // Per-file sweep: each file signals only the PIDs it created, so a live
    // child belonging to another file is never mistaken for a leak.
    let alive = 0;
    for (const pid of ownedPids) {
      try {
        process.kill(pid, 0);
        alive += 1;
      } catch {
        // gone, which is the expected answer
      }
    }
    expect({ spawned: ownedPids.length > 0, alive }).toEqual({ spawned: true, alive: 0 });
  });
});

describe("a binary is admitted for the session too", () => {
  it("admits the node binary the fake runs under", () => {
    expect(admitBinary(NODE, { provider: "claude", taskId: TASK })).toBe(NODE);
  });
});
