import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AdmittedBinary,
  AdmittedConfigRoot,
  AdmittedWorkdir,
  ParseCursor,
  ProviderAdapter,
  SessionLimits,
  SessionRequest,
} from "../../src/contract/index.js";
import { EMPTY_CURSOR } from "../../src/contract/index.js";
import { AdapterError } from "../../src/errors/index.js";
import type { NormalizedEvent } from "../../src/events/index.js";
import { admitBinary } from "../../src/process/spawn/index.js";
import { descriptorEnablesWrites, isReadOnlyIdentity, startSession } from "../../src/session/index.js";
import { claudeAdapter } from "../../src/claude/index.js";
import { fakeAdapter, fakeProviderArgv, scriptedAdapter } from "../testing/index.js";
import { CAPTURED_2_1_281_SUCCESS, CAPTURED_AUTH_FAILURE, CAPTURED_SUCCESS } from "../testing/claude-capture/index.js";
import type { FakeScript } from "../testing/index.js";

const TMP_ROOT = realpathSync(tmpdir());
const NODE = realpathSync(process.execPath) as AdmittedBinary;
const IMPLEMENTER = "anthropic/claude-opus-5/implementer/01";
const REVIEWER = "anthropic/claude-fable/reviewer/01";
const TASK = "00000000-0000-4000-8000-00000000000a";

const created: string[] = [];
/** Every PID this file spawned, swept at the end of this file. */
const ownedPids: number[] = [];

/** What the plane asks the model to do, in this suite. */
const INSTRUCTION = "summarise the packet and propose a plan";

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
    instructions: INSTRUCTION,
    // The classes the instruction was composed from (P-06/C). Text only unless a
    // test says otherwise, which is the route this packet carries end to end.
    modalities: ["text"],
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
        delivery: { kind: "STDIN" },
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
    // The fake's step is a usage report of that total, class split unknown (P-15/D2).
    expect(events[1]?.payload).toMatchObject({ totalTokens: 1200, inputTokens: null, outputTokens: null });
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
          delivery: { kind: "STDIN" },
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
          delivery: { kind: "STDIN" },
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

/**
 * The instruction channel (V2-B1c).
 *
 * The channel is write-only: these tests are the only place its bytes are
 * observed, and they observe them through a **side file the subject owns**
 * rather than through stdout. Stdout is adapter-parsed, and an unrecognised
 * line becomes a classified event whose bounded payload can reach a log — the
 * exact leak this packet forbids.
 */
describe("delivering the instruction", () => {
  /** A subject that reads stdin to EOF and writes what it got to a file. */
  function echoingAdapter(
    echoPath: string,
    kind: "STDIN" | "UNSUPPORTED" | "MODALITY",
  ): ProviderAdapter {
    const program = [
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => {",
      "  require('node:fs').writeFileSync(" + JSON.stringify(echoPath) + ", chunks.join(''));",
      "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');",
      "  process.exit(0);",
      "});",
    ].join("\n");
    return {
      ...fakeAdapter,
      describe(req: SessionRequest) {
        return {
          provider: "claude" as const,
          argv: ["-e", program],
          env: { PATH: "/usr/bin:/bin" },
          cwd: req.workdir,
          delivery:
            kind === "STDIN"
              ? ({ kind: "STDIN" } as const)
              : kind === "MODALITY"
                ? ({ kind: "UNSUPPORTED", reason: "MODALITY_UNSUPPORTED" } as const)
                : ({ kind: "UNSUPPORTED", reason: "HANDSHAKE_REQUIRED" } as const),
        };
      },
    };
  }

  it("P2 writes the instruction to stdin and closes it, so the child sees EOF", async () => {
    // The close is what makes this observable at all: the subject's `end`
    // handler never fires on an open pipe, so a write without a close would
    // hang until the step's timeout rather than deliver. Reading the file back
    // proves both halves at once.
    const echoPath = join(drillRoot(), "echo.txt");
    const session = startSession(echoingAdapter(echoPath, "STDIN"), request(IMPLEMENTER, {
      lines: [],
      exitCode: 0,
    }));
    ownedPids.push(session.pid);
    for await (const _event of session.events()) {
      void _event;
    }
    expect(readFileSync(echoPath, "utf8")).toBe(INSTRUCTION);
  });

  it("P3 refuses before spawn when the transport cannot take an instruction", () => {
    // No process is created: the refusal is thrown before `spawnAdmitted`, so
    // there is no pid to track and nothing to reap. A spawn-then-discard would
    // have started a model with no instruction and charged for it.
    const echoPath = join(drillRoot(), "never-written.txt");
    const before = ownedPids.length;
    let thrown: unknown;
    try {
      startSession(echoingAdapter(echoPath, "UNSUPPORTED"), request(IMPLEMENTER, {
        lines: [],
        exitCode: 0,
      }));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).code).toBe("PROTOCOL_UNSUPPORTED");
    expect(ownedPids.length).toBe(before);
    expect(existsSync(echoPath)).toBe(false);
  });

  it("N3 refuses credential-shaped material before the write, and never echoes it", () => {
    // Scanned as an object, so the guard's value scan actually runs over the
    // content. The bytes reach neither the child nor the message.
    const echoPath = join(drillRoot(), "credential.txt");
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    let thrown: unknown;
    try {
      startSession(
        echoingAdapter(echoPath, "STDIN"),
        request(IMPLEMENTER, { lines: [], exitCode: 0 }, { instructions: "deploy with " + secret }),
      );
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).code).toBe("CREDENTIAL_MATERIAL");
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect((thrown as Error).message).not.toContain(secret);
    expect(existsSync(echoPath)).toBe(false);
  });

  it("N5 keeps the read-only refusal first, before anything is delivered", () => {
    // Order is the fail-closed story. A reviewer identity with write-enabling
    // argv is refused before delivery is even considered, so no instruction is
    // written on a path that should not have started.
    const echoPath = join(drillRoot(), "read-only.txt");
    const base = echoingAdapter(echoPath, "STDIN");
    const writeEnabling: ProviderAdapter = {
      ...base,
      describe(req: SessionRequest) {
        return { ...base.describe(req), argv: ["--yolo"] };
      },
    };
    let thrown: unknown;
    try {
      startSession(writeEnabling, request(REVIEWER, { lines: [], exitCode: 0 }));
    } catch (error: unknown) {
      thrown = error;
    }
    expect((thrown as AdapterError).code).toBe("READ_ONLY_VIOLATION");
    expect(existsSync(echoPath)).toBe(false);
  });

  it("N-P06-15 refuses a class the transport cannot carry without opening a process", () => {
    // The second reason of the same refusal point (P-06/C). The composition does
    // NOT drop a non-text block and does not refuse it either: the classes travel
    // to the adapter, the adapter declares it cannot carry them, and the refusal
    // happens here -- before `spawnAdmitted`, so there is no pid, no byte written
    // and no unauthorized consumption on any account.
    const echoPath = join(drillRoot(), "modality.txt");
    const before = ownedPids.length;
    let thrown: unknown;
    try {
      startSession(
        echoingAdapter(echoPath, "MODALITY"),
        request(IMPLEMENTER, { lines: [], exitCode: 0 }, { modalities: ["text", "image"] }),
      );
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    // `PROTOCOL_UNSUPPORTED` for both reasons, by ADR 0034: the specificity lives
    // in the descriptor's `reason` and no closed code set moves for a modality.
    expect((thrown as AdapterError).code).toBe("PROTOCOL_UNSUPPORTED");
    expect(ownedPids.length).toBe(before);
    expect(existsSync(echoPath)).toBe(false);
  });

  it("N8 leaves the delivery union closed, with no silent third path", () => {
    // The union is enforced by the compiler through an exhaustive switch with a
    // `never` guard, so an unhandled kind fails the build rather than falling
    // through to a spawn that quietly delivered nothing. What is asserted here
    // is the runtime half: both declared kinds are handled, and they differ.
    const echoPath = join(drillRoot(), "closed.txt");
    const stdin = echoingAdapter(echoPath, "STDIN").describe(
      request(IMPLEMENTER, { lines: [], exitCode: 0 }),
    );
    const unsupported = echoingAdapter(echoPath, "UNSUPPORTED").describe(
      request(IMPLEMENTER, { lines: [], exitCode: 0 }),
    );
    const modality = echoingAdapter(echoPath, "MODALITY").describe(
      request(IMPLEMENTER, { lines: [], exitCode: 0 }),
    );
    expect(stdin.delivery).toEqual({ kind: "STDIN" });
    expect(unsupported.delivery).toEqual({ kind: "UNSUPPORTED", reason: "HANDSHAKE_REQUIRED" });
    // Three declarations, two reasons, one refusal point (P-06/C).
    expect(modality.delivery).toEqual({ kind: "UNSUPPORTED", reason: "MODALITY_UNSUPPORTED" });
  });
});

// ---------------------------------------------------------------------------
// P-07 escalón C — the sink, the verdict and the exit, through a real child
// (ADR 0099)
// ---------------------------------------------------------------------------

/** One Claude-parsed session over a scripted child, drained, with what it reports. */
async function claudeRun(
  script: FakeScript,
  sink?: (delta: string) => void,
): Promise<{
  readonly events: NormalizedEvent[];
  readonly exit: ReturnType<ReturnType<typeof startSession>["exit"]>;
  readonly operation: ReturnType<ReturnType<typeof startSession>["operation"]>;
  readonly state: string;
  readonly health: string;
  readonly thrown: unknown;
}> {
  const session = startSession(scriptedAdapter(claudeAdapter, script), request(IMPLEMENTER, script), sink);
  ownedPids.push(session.pid);
  const events: NormalizedEvent[] = [];
  let thrown: unknown = null;
  try {
    for await (const event of session.events()) events.push(event);
  } catch (error) {
    thrown = error;
  }
  await session.settled();
  const state = session.state;
  const health = JSON.stringify(session.health());
  await session.close();
  return { events, exit: session.exit(), operation: session.operation(), state, health, thrown };
}

const SENTINEL = "sentinel-" + randomUUID();

/** A synthetic Claude stream whose one assistant text block carries the sentinel. */
function sentinelStream(): readonly string[] {
  const assistant = JSON.parse(CAPTURED_SUCCESS[3] ?? "{}") as Record<string, unknown>;
  (assistant["message"] as Record<string, unknown>)["content"] = [{ type: "text", text: SENTINEL }];
  return [CAPTURED_SUCCESS[1] ?? "", JSON.stringify(assistant), CAPTURED_SUCCESS[5] ?? ""];
}

describe("P-07 C: a session hands output to its sink and nowhere else, and reports the exit and the verdict", () => {
  it("OBS sample 1 replay: exit 1, operation FAILED, and the CLI's error text reaches no event and no health report", async () => {
    const sunk: string[] = [];
    const run = await claudeRun({ lines: CAPTURED_AUTH_FAILURE, exitCode: 1 }, (delta) => sunk.push(delta));
    expect(run.exit).toEqual({ exitCode: 1, signal: null });
    expect(run.operation).toBe("FAILED");
    expect(sunk).toEqual([]);
    expect(JSON.stringify(run.events)).not.toContain("Not logged in");
    expect(run.health).not.toContain("Not logged in");
  });

  it("OBS sample 2 replay: exit 0, operation SUCCEEDED, the sink receives exactly \"ok\", and the thinking signature is nowhere", async () => {
    const sunk: string[] = [];
    const run = await claudeRun({ lines: CAPTURED_SUCCESS, exitCode: 0 }, (delta) => sunk.push(delta));
    expect(run.exit).toEqual({ exitCode: 0, signal: null });
    expect(run.operation).toBe("SUCCEEDED");
    expect(sunk).toEqual(["ok"]);
    for (const surface of [JSON.stringify(run.events), run.health, JSON.stringify(sunk)]) {
      expect(surface).not.toContain("fixture-signature");
    }
  });

  it("SYN sentinel: output reaches the sink exactly once and no event, health report or error", async () => {
    const sunk: string[] = [];
    const run = await claudeRun({ lines: sentinelStream(), exitCode: 0 }, (delta) => sunk.push(delta));
    // Positive control: the sentinel WAS produced, so the absences below mean something.
    expect(sunk).toEqual([SENTINEL]);
    expect(JSON.stringify(run.events)).not.toContain(SENTINEL);
    expect(run.health).not.toContain(SENTINEL);
    expect(JSON.stringify(run.thrown)).not.toContain(SENTINEL);
  });

  it("SYN legacy: without a sink the same child is unchanged — the text is dropped and every event is the same", async () => {
    const withSink = await claudeRun({ lines: sentinelStream(), exitCode: 0 }, () => undefined);
    const without = await claudeRun({ lines: sentinelStream(), exitCode: 0 });
    expect(without.events.map((event) => [event.name, event.payload])).toEqual(
      withSink.events.map((event) => [event.name, event.payload]),
    );
    expect(without.operation).toBe("SUCCEEDED");
    expect(JSON.stringify(without.events)).not.toContain(SENTINEL);
  });

  it("SYN: a child that ends by its own SIGTERM after its result reports the signal, not an exit code", async () => {
    const run = await claudeRun({ lines: CAPTURED_SUCCESS, exitCode: 0, selfSignal: "SIGTERM" });
    expect(run.exit).toEqual({ exitCode: null, signal: "SIGTERM" });
    expect(run.operation).toBe("SUCCEEDED");
  });

  it("SYN C6(e): a malformed record on a live child fails the session, and the exit is our ladder's SIGKILL", async () => {
    const run = await claudeRun({ lines: [CAPTURED_SUCCESS[1] ?? "", "{not json"], exitCode: 0, lingerMs: 5_000 });
    expect(run.state).toBe("FAILED");
    expect(run.exit).toEqual({ exitCode: null, signal: "SIGKILL" });
  });

  it("SYN Q-C3: a second verdict in one session fails it with MALFORMED_EVENT, never overwritten", async () => {
    const run = await claudeRun({
      lines: [CAPTURED_AUTH_FAILURE[0] ?? "", CAPTURED_AUTH_FAILURE[2] ?? "", CAPTURED_SUCCESS[5] ?? ""],
      exitCode: 0,
      lingerMs: 5_000,
    });
    expect(run.state).toBe("FAILED");
    expect(run.health).toContain("MALFORMED_EVENT");
    // The first verdict is held; the second one is what failed the session.
    expect(run.operation).toBe("FAILED");
  });

  it("a sink that throws fails the session, classified MALFORMED_EVENT", async () => {
    const run = await claudeRun({ lines: CAPTURED_SUCCESS, exitCode: 0, lingerMs: 5_000 }, () => {
      throw new Error("a sink that throws");
    });
    expect(run.state).toBe("FAILED");
    expect(run.health).toContain("MALFORMED_EVENT");
    expect(run.health).not.toContain("a sink that throws");
  });

  it("no exit is reported before one is observed: null, never a fabricated 0", () => {
    const script: FakeScript = { lines: CAPTURED_SUCCESS, exitCode: 0, lingerMs: 5_000 };
    const session = startSession(scriptedAdapter(claudeAdapter, script), request(IMPLEMENTER, script));
    ownedPids.push(session.pid);
    expect(session.exit()).toBeNull();
    expect(session.operation()).toBeNull();
    return session.close();
  });
});

// ---------------------------------------------------------------------------
// P-15/A2 — a session's CLI version is its own (T-S1, ADR 0112)
// ---------------------------------------------------------------------------

describe("P-15/A2: two sessions over the one adapter keep their versions apart (T-S1)", () => {
  /** 2.1.281's thinking record, which only a 2.1.281 session admits. */
  const THINKING = CAPTURED_2_1_281_SUCCESS[1] ?? "";

  it("two cursors, one per version, interleaved record by record: the thinking record passes on 2.1.281 and refuses on 2.1.280", () => {
    // One adapter object holding no state of its own: a provider name and three methods.
    expect(Object.keys(claudeAdapter).sort()).toEqual(["describe", "negotiate", "parse", "provider"]);
    let old: ParseCursor = EMPTY_CURSOR;
    let current: ParseCursor = EMPTY_CURSOR;
    const oldLines = [CAPTURED_SUCCESS[0] ?? "", CAPTURED_SUCCESS[1] ?? "", THINKING];
    const currentLines = [CAPTURED_2_1_281_SUCCESS[0] ?? "", THINKING, THINKING];
    const verdicts: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const a = claudeAdapter.parse((currentLines[index] ?? "") + "\n", current);
      verdicts.push("2.1.281:" + (a.ok ? "ok" : a.code));
      if (a.ok) current = a.cursor;
      const b = claudeAdapter.parse((oldLines[index] ?? "") + "\n", old);
      verdicts.push("2.1.280:" + (b.ok ? "ok" : b.code));
      if (b.ok) old = b.cursor;
    }
    expect(verdicts).toEqual([
      "2.1.281:ok",
      "2.1.280:ok",
      "2.1.281:ok",
      "2.1.280:ok",
      "2.1.281:ok",
      "2.1.280:UNKNOWN_EVENT",
    ]);
    expect({ current: current.cliVersion, old: old.cliVersion }).toEqual({ current: "2.1.281", old: "2.1.280" });
    // The frozen empty cursor both started from is untouched.
    expect(EMPTY_CURSOR).toEqual({ partial: "", recordIndex: 0 });
  });

  it("two live Sessions run at once over claudeAdapter: the 2.1.281 one succeeds, the 2.1.280 one refuses the thinking record", async () => {
    const [current, old] = await Promise.all([
      claudeRun({ lines: CAPTURED_2_1_281_SUCCESS, exitCode: 0 }),
      claudeRun({
        lines: [CAPTURED_SUCCESS[0] ?? "", CAPTURED_SUCCESS[1] ?? "", THINKING, ...CAPTURED_SUCCESS.slice(2)],
        exitCode: 0,
        lingerMs: 5_000,
      }),
    ]);
    expect(current.state).not.toBe("FAILED");
    expect(current.operation).toBe("SUCCEEDED");
    expect(current.events.map((event) => event.name)).toContain("session.started");
    expect(old.state).toBe("FAILED");
    expect(old.health).toContain("UNKNOWN_EVENT");
    expect(old.operation).toBeNull();
  });

  it("a 2.1.999 init fails its session PROTOCOL_UNSUPPORTED, and a 2.1.281 session beside it is unaffected", async () => {
    const init = JSON.parse(CAPTURED_2_1_281_SUCCESS[0] ?? "{}") as Record<string, unknown>;
    init["claude_code_version"] = "2.1.999";
    const [refused, admitted] = await Promise.all([
      claudeRun({ lines: [JSON.stringify(init), ...CAPTURED_2_1_281_SUCCESS.slice(1)], exitCode: 0, lingerMs: 5_000 }),
      claudeRun({ lines: CAPTURED_2_1_281_SUCCESS, exitCode: 0 }),
    ]);
    expect(refused.state).toBe("FAILED");
    expect(refused.health).toContain("PROTOCOL_UNSUPPORTED");
    expect(refused.events).toEqual([]);
    expect(refused.operation).toBeNull();
    expect(admitted.operation).toBe("SUCCEEDED");
  });
});
