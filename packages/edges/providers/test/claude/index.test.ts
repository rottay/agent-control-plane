import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { allowedEnvKeys } from "../../src/config-root/index.js";
import { claudeSessionId } from "../../src/session-name/index.js";
import type {
  AdmittedBinary,
  AdmittedConfigRoot,
  AdmittedWorkdir,
  ProviderAdapter,
  SessionLimits,
  SessionRequest,
} from "../../src/contract/index.js";
import { EMPTY_CURSOR } from "../../src/contract/index.js";
import { AdapterError } from "../../src/errors/index.js";
import type { NormalizedEvent } from "../../src/events/index.js";
import { descriptorEnablesWrites, startSession } from "../../src/session/index.js";
import { fakeProviderArgv } from "../testing/index.js";
import type { FakeScript } from "../testing/index.js";
import { CLAUDE_STREAM_PROTOCOL, CLAUDE_USAGE_SOURCE, claudeAdapter } from "../../src/claude/index.js";
import { CAPTURED_AUTH_FAILURE, CAPTURED_SUCCESS } from "../testing/claude-capture/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const PROVIDER_SRC = join(PACKAGE_ROOT, "src", "claude");
const TMP_ROOT = realpathSync(tmpdir());
const NODE = realpathSync(process.execPath) as AdmittedBinary;
const IMPLEMENTER = "anthropic/claude-opus-5/implementer/01";
const REVIEWER = "anthropic/claude-fable/reviewer/01";
const TASK = "00000000-0000-4000-8000-00000000000a";

const created: string[] = [];
/** Every PID this file spawned; swept at the end of this file. */
const ownedPids: number[] = [];

function drillRoot(): string {
  const path = join(TMP_ROOT, "acp-p4b-" + randomUUID());
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

function request(identity: string, overrides: Partial<SessionRequest> = {}): SessionRequest {
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
    // The classes the instruction was composed from (P-06/C). Text, so the six
    // descriptor drills below exercise the real text path and `describe` declares
    // `STDIN`; a non-text class here is what `MODALITY_UNSUPPORTED` answers.
    modalities: ["text"],
    ...overrides,
  } as SessionRequest;
}

/** The Claude adapter, with argv rewritten so a scripted fake plays its part. */
function scripted(script: FakeScript): ProviderAdapter {
  return {
    ...claudeAdapter,
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

async function collect(
  script: FakeScript,
  identity = IMPLEMENTER,
): Promise<{ readonly events: NormalizedEvent[]; readonly failure: string | null }> {
  const session = startSession(scripted(script), request(identity));
  ownedPids.push(session.pid);
  const events: NormalizedEvent[] = [];
  try {
    for await (const event of session.events()) events.push(event);
  } catch {
    // The failure is read from the probe below, whichever way it surfaced.
  }
  await session.settled();
  const failure = session.health().classifiedError;
  await session.close();
  return { events, failure };
}

afterEach(() => {
  const prefix = join(TMP_ROOT, "acp-p4b-");
  while (created.length > 0) {
    const path = created.pop();
    if (path?.startsWith(prefix) === true) rmSync(path, { recursive: true, force: true });
  }
});

const INIT = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-20260401" });
const ASSISTANT = JSON.stringify({
  type: "assistant",
  message: { usage: { output_tokens: 1200 }, content: [{ type: "text", text: "hello" }] },
});
const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "session-fixture",
  usage: { input_tokens: 0, output_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});

describe("the descriptor is exactly what was authorized", () => {
  it("builds the observed headless argv, with the attempt's session name (ADR 0101)", () => {
    const descriptor = claudeAdapter.describe(request(IMPLEMENTER));
    expect([...descriptor.argv]).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "opus",
      "--session-id",
      "39de475b-2696-5df6-b64b-88336de7d72c",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]);
  });

  it("names each attempt's own session, never the task id", () => {
    const first = claudeAdapter.describe(request(IMPLEMENTER, { attempt: 1 })).argv;
    const second = claudeAdapter.describe(request(IMPLEMENTER, { attempt: 2 })).argv;
    const idOf = (argv: readonly string[]): string | undefined => argv[argv.indexOf("--session-id") + 1];
    expect(idOf(first)).toBe(claudeSessionId(TASK, 1));
    expect(idOf(second)).toBe(claudeSessionId(TASK, 2));
    expect(idOf(first)).not.toBe(idOf(second));
    expect([...first, ...second]).not.toContain(TASK);
  });

  it("carries none of the smoke profile's flags", () => {
    for (const identity of [IMPLEMENTER, REVIEWER]) {
      const argv = [...claudeAdapter.describe(request(identity)).argv];
      for (const flag of ["--safe-mode", "--max-turns", "--max-budget-usd", "--dangerously-skip-permissions"]) {
        expect({ identity, flag, present: argv.includes(flag) }).toEqual({ identity, flag, present: false });
      }
      // `--tools ""` would take every tool away from an implementer.
      expect(argv).not.toContain("");
    }
    expect([...claudeAdapter.describe(request(IMPLEMENTER)).argv]).not.toContain("--tools");
  });

  it("uses --resume with the attempt's own session name, and no --session-id", () => {
    const own = claudeSessionId(TASK, 1);
    const descriptor = claudeAdapter.describe(request(IMPLEMENTER, { resumeSessionId: own }));
    const argv = [...descriptor.argv];
    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", own]);
    expect(argv).not.toContain("--session-id");
    expect(argv).toContain("--no-session-persistence");
  });

  it("refuses a --resume naming any other session before argv exists: another attempt's, the task id, empty or not a string", () => {
    const others: readonly unknown[] = [claudeSessionId(TASK, 2), TASK, "prior-session", "", 42, {}];
    for (const other of others) {
      let refusal: unknown = null;
      try {
        claudeAdapter.describe(request(IMPLEMENTER, { resumeSessionId: other as string }));
      } catch (error) {
        refusal = error;
      }
      expect(refusal, JSON.stringify(other)).toBeInstanceOf(AdapterError);
      expect((refusal as AdapterError).code).toBe("PROTOCOL_UNSUPPORTED");
    }
  });

  it("a mismatched --resume never becomes a process: startSession refuses before the spawn", () => {
    const marker = join(drillRoot(), "spawned");
    const spawning: ProviderAdapter = {
      ...claudeAdapter,
      describe(asked: SessionRequest) {
        const real = claudeAdapter.describe(asked);
        return { ...real, argv: ["-e", "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'x')"] };
      },
    };
    expect(() =>
      startSession(spawning, request(IMPLEMENTER, { resumeSessionId: claudeSessionId(TASK, 2) })),
    ).toThrow(AdapterError);
    expect(readdirSync(dirname(marker))).toEqual([]);
  });

  it("forwards exactly the allowlisted environment, USER included, and nothing else", () => {
    process.env["ACP_P4B_SHOULD_NOT_TRAVEL"] = "leaked";
    const priorUser = process.env["USER"];
    process.env["USER"] = "acp-" + "fixture-login";
    try {
      const descriptor = claudeAdapter.describe(request(IMPLEMENTER));
      expect(Object.keys(descriptor.env).sort()).toEqual(
        [...allowedEnvKeys("claude")].filter((key) => key in descriptor.env).sort(),
      );
      for (const key of Object.keys(descriptor.env)) {
        expect({ key, allowed: allowedEnvKeys("claude").includes(key) }).toEqual({
          key,
          allowed: true,
        });
      }
      expect(descriptor.env["CLAUDE_CONFIG_DIR"]).toBe(descriptor.cwd);
      expect(descriptor.env["USER"]).toBe("acp-fixture-login");
      expect(Object.hasOwn(descriptor.env, "ACP_P4B_SHOULD_NOT_TRAVEL")).toBe(false);
      expect(Object.hasOwn(descriptor.env, "KIMI_CODE_HOME")).toBe(false);
      expect(Object.hasOwn(descriptor.env, "CODEX_HOME")).toBe(false);
    } finally {
      delete process.env["ACP_P4B_SHOULD_NOT_TRAVEL"];
      if (priorUser === undefined) delete process.env["USER"];
      else process.env["USER"] = priorUser;
    }
  });

  it("adds the native read-only layer for a reviewer, with the tool allowlist, and still passes the structural scan", () => {
    const descriptor = claudeAdapter.describe(request(REVIEWER));
    expect([...descriptor.argv]).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "opus",
      "--session-id",
      "39de475b-2696-5df6-b64b-88336de7d72c",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--permission-mode",
      "plan",
      "--restricted",
      "--tools",
      "Glob,Grep,Read,WebFetch,WebSearch",
    ]);
    // The polite layer must never itself trip the load-bearing one, including
    // in the two-token spelling it uses.
    expect(descriptorEnablesWrites(descriptor.argv)).toBe(false);
  });

  it("adds no read-only flags for a non-reviewer identity", () => {
    const descriptor = claudeAdapter.describe(request(IMPLEMENTER));
    expect([...descriptor.argv]).not.toContain("--restricted");
  });
});

describe("the parser reads the stream it declares, and refuses the rest", () => {
  it("parses a stream-json fixture end to end", async () => {
    const { events, failure } = await collect({ lines: [INIT, ASSISTANT, RESULT], exitCode: 0 });
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual([
      "session.started",
      "step.completed",
      "provider.state",
    ]);
    expect(events.map((event) => event.frozenType)).toEqual([
      "RUN_STARTED",
      "ATOMIC_STEP_COMPLETED",
      "TASK_STATE_CHANGED",
    ]);
    expect(events[0]?.payload["resolvedModel"]).toBe("claude-opus-5-20260401");
    expect(events[0]?.payload["protocolVersion"]).toBe(CLAUDE_STREAM_PROTOCOL);
    // The session's one usage report, from the result (P-15/D2): the assistant
    // record's usage is not read.
    expect(events[1]?.payload).toMatchObject({ outputTokens: 1200, totalTokens: 1200, reportKind: "CUMULATIVE", isFinal: true });
    expect(events[2]?.payload["toState"]).toBe("SUCCESS");
  });

  it("raises auth.required with a classified reason and no prompt", async () => {
    const { events } = await collect({
      lines: [JSON.stringify({ type: "system", subtype: "auth_required", url: "https://example.invalid/login" })],
      exitCode: 0,
    });
    expect(events.map((event) => event.name)).toEqual(["auth.required"]);
    expect(events[0]?.frozenType).toBe("AUTH_REQUIRED_RAISED");
    expect(events[0]?.payload["reason"]).toBe("LOGIN_REQUIRED");
    expect(JSON.stringify(events[0])).not.toContain("example.invalid");
  });

  it("refuses an unknown record type", async () => {
    const { failure } = await collect({
      lines: [INIT, JSON.stringify({ type: "telemetry_ping" })],
      exitCode: 0,
    });
    expect(failure).toBe("UNKNOWN_EVENT");
  });

  it("refuses an unknown system subtype", async () => {
    const { failure } = await collect({
      lines: [JSON.stringify({ type: "system", subtype: "something_new" })],
      exitCode: 0,
    });
    expect(failure).toBe("UNKNOWN_EVENT");
  });

  it("refuses a malformed record", async () => {
    const { failure } = await collect({ lines: ["{ not json"], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("refuses a known record whose shape is wrong", async () => {
    for (const line of [
      JSON.stringify({ type: "system", subtype: "init" }), // no model
      JSON.stringify({ type: "assistant" }), // no message
      JSON.stringify({ type: "result" }), // no subtype
      JSON.stringify({ notype: true }),
    ]) {
      const { failure } = await collect({ lines: [line], exitCode: 0 });
      expect({ line, failure }).toEqual({ line, failure: "MALFORMED_EVENT" });
    }
  });

  it("carries a truncated record across the chunk boundary rather than failing", () => {
    // A record split mid-way is not malformed; it is unfinished. The cursor
    // holds it until the rest arrives.
    const first = claudeAdapter.parse(INIT.slice(0, 12), EMPTY_CURSOR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.events).toEqual([]);
    const second = claudeAdapter.parse(INIT.slice(12) + "\n", first.cursor);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.events.map((signal) => signal.kind)).toEqual(["started"]);
  });

  it("leaves an unterminated tail unparsed at end of stream", async () => {
    // The fake writes a record with no trailing newline before dying; the
    // partial is never invented into an event.
    const { events, failure } = await collect({ lines: [INIT], exitCode: 0 });
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual(["session.started"]);
  });

  it("survives an immediate death with no output", async () => {
    const { events, failure } = await collect({ lines: [], exitCode: 0 });
    expect(failure).toBeNull();
    expect(events).toEqual([]);
  });

  it("survives a death mid-stream", async () => {
    const { events, failure } = await collect({ lines: [INIT, ASSISTANT], exitCode: 3 });
    expect(failure).toBeNull();
    // No result, so no usage report: the session's usage is UNKNOWN, never a count
    // assembled from the assistant records (P-15/D2).
    expect(events.map((event) => event.name)).toEqual(["session.started"]);
  });

  it("is deterministic across repeated identical runs", () => {
    const chunk = [INIT, ASSISTANT, RESULT].join("\n") + "\n";
    const first = JSON.stringify(claudeAdapter.parse(chunk, EMPTY_CURSOR));
    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(claudeAdapter.parse(chunk, EMPTY_CURSOR))).toBe(first);
    }
  });

  it("replays no event twice when a resumed stream repeats nothing", async () => {
    // Resume is a descriptor concern; what the normalized stream must show is
    // that the same records are not emitted twice within one session.
    const { events } = await collect({ lines: [INIT, ASSISTANT, RESULT], exitCode: 0 });
    const names = events.map((event) => event.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("bounds a token count it cannot report", async () => {
    const overLimit = JSON.stringify({
      type: "assistant",
      message: { usage: { output_tokens: 10_000_001 } },
    });
    const { events, failure } = await collect({ lines: [INIT, overLimit], exitCode: 0 });
    // Out of range is not reported as a measurement, and is not invented as
    // zero either: the record simply carries no step.
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual(["session.started"]);
  });
});

describe("the reviewer guarantee holds for this provider", () => {
  it("kills a reviewer session on a write-class tool use, without a caller close", async () => {
    const writeUse = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "x.ts" } }] },
    });
    const session = startSession(
      scripted({ lines: [INIT, writeUse], exitCode: 0, lingerMs: 10_000 }),
      request(REVIEWER),
    );
    ownedPids.push(session.pid);
    try {
      for await (const event of session.events()) void event;
    } catch {
      // surfaced either way
    }
    await session.settled();
    expect(session.state).toBe("FAILED");
    expect(session.health().classifiedError).toBe("READ_ONLY_VIOLATION");

    let alive = true;
    for (let waited = 0; waited < 2_000 && alive; waited += 10) {
      try {
        process.kill(session.pid, 0);
        await new Promise<void>((r) => {
          setTimeout(r, 10);
        });
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("lets an implementer use the same tool without failing", async () => {
    const writeUse = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Write", input: {} }] },
    });
    const { failure } = await collect({ lines: [INIT, writeUse], exitCode: 0 }, IMPLEMENTER);
    // The write signal maps to no normalized event, and only a reviewer
    // identity turns it into a refusal.
    expect(failure).toBeNull();
  });

  it("treats a tool outside the read-only allowlist as write-class, Bash included", async () => {
    // The denylist this replaced named Edit/Write and their neighbours, so
    // `Bash` — which can do anything a write tool can — passed a reviewer
    // session as harmless. An allowlist fails closed instead.
    const bashUse = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    });
    const session = startSession(
      scripted({ lines: [INIT, bashUse], exitCode: 0, lingerMs: 10_000 }),
      request(REVIEWER),
    );
    ownedPids.push(session.pid);
    try {
      for await (const event of session.events()) void event;
    } catch {
      // surfaced either way
    }
    await session.settled();
    expect(session.state).toBe("FAILED");
    expect(session.health().classifiedError).toBe("READ_ONLY_VIOLATION");

    // And the child is dead without this test ever calling close().
    let alive = true;
    for (let waited = 0; waited < 2_000 && alive; waited += 10) {
      try {
        process.kill(session.pid, 0);
        await new Promise<void>((r) => {
          setTimeout(r, 10);
        });
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("accepts every tool on the read-only allowlist under a reviewer identity", async () => {
    for (const name of ["Read", "Glob", "Grep", "WebFetch", "WebSearch"]) {
      const use = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name, input: {} }] },
      });
      const { failure } = await collect({ lines: [INIT, use], exitCode: 0 }, REVIEWER);
      expect({ name, failure }).toEqual({ name, failure: null });
    }
  });

  it("leaves an implementer unaffected by the same Bash event", async () => {
    const bashUse = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    });
    const { events, failure } = await collect({ lines: [INIT, bashUse], exitCode: 0 }, IMPLEMENTER);
    // Classified, not fatal: the signal carries no normalized event for any
    // role, and only a reviewer identity turns it into a refusal.
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual(["session.started"]);
  });
});

describe("the provider module keeps the boundary's laws", () => {
  const source = readFileSync(join(PROVIDER_SRC, "index.ts"), "utf8");
  // Comments explain which APIs the module deliberately does not use, and say
  // their names to do so. Only code is under assertion.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("imports neither the spawner, the session controller nor child_process", () => {
    expect(code).not.toContain("node:child_process");
    expect(code).not.toMatch(/from\s*["'][^"']*process\/spawn\.js["']/);
    expect(code).not.toContain("spawnAdmitted");
    // `isReadOnlyIdentity` is a pure predicate re-exported by session/index.ts; the
    // module never touches the controller itself.
    expect(code).not.toContain("startSession");
  });

  it("imports no session or process module from any provider source", () => {
    // Provider modules are pure descriptors and parsers. Reaching into
    // `session/index.ts` — even for a pure predicate, as an earlier revision
    // did — makes the module a participant in the process boundary it is kept
    // outside of. The role predicate comes from `@acp/contracts` instead.
    for (const entry of readdirSync(PROVIDER_SRC, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(PROVIDER_SRC, entry.name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      expect({ file: entry.name, session: /from\s*["'][^"']*session\.js["']/.test(text) }).toEqual({
        file: entry.name,
        session: false,
      });
      expect({ file: entry.name, proc: /from\s*["'][^"']*\/process\//.test(text) }).toEqual({
        file: entry.name,
        proc: false,
      });
      expect({ file: entry.name, cp: text.includes("node:child_process") }).toEqual({
        file: entry.name,
        cp: false,
      });
    }
  });

  it("names no ledger and reads no ambient environment", () => {
    // The token is assembled from pieces so this assertion does not itself
    // name the package the architecture fence forbids adapters from naming —
    // the same convention the observation suite uses for product strings.
    expect(code).not.toContain(["@acp", "ledger"].join("/"));
    expect(code).not.toContain("process.env");
  });

  it("claims no capability", () => {
    // CONFIRMED is unreachable in P4 by law; the module must not even spell it.
    expect(code).not.toContain("CONFIRMED");
    const outcome = claudeAdapter.negotiate({});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const record of outcome.capabilities) {
      expect({ name: record.name, state: record.state, kind: record.evidence.kind }).toEqual({
        name: record.name,
        state: "UNKNOWN",
        kind: "NONE",
      });
    }
  });

  it("leaves no adapter-spawned process alive", () => {
    let alive = 0;
    for (const pid of ownedPids) {
      try {
        process.kill(pid, 0);
        alive += 1;
      } catch {
        // gone, as expected
      }
    }
    expect({ spawned: ownedPids.length > 0, alive }).toEqual({ spawned: true, alive: 0 });
  });
});

describe("errors stay classified", () => {
  it("surfaces refusals as AdapterError codes, never as raw text", async () => {
    const { failure } = await collect({ lines: [JSON.stringify({ type: "nope" })], exitCode: 0 });
    expect(failure).toBe("UNKNOWN_EVENT");
    expect(new AdapterError("UNKNOWN_EVENT", { provider: "claude", taskId: TASK }).message).toBe(
      "UNKNOWN_EVENT [claude " + TASK + "]",
    );
  });
});

/** Keeps `dirname` used, and documents where the module under test lives. */
export const MODULE_DIRECTORY = dirname(join(PROVIDER_SRC, "index.ts"));

describe("how this transport takes an instruction (V2-B1c)", () => {
  it("P4 declares delivery purely, and performs no I/O to do it", () => {
    // `-p` with no positional prompt is exactly the shape that reads stdin, so
    // the pipe the spawn already opens is the transport. Declared here and
    // performed by `startSession`; this method still does no I/O.
    const descriptor = claudeAdapter.describe(request(IMPLEMENTER));
    expect(descriptor.delivery).toEqual({ kind: "STDIN" });
  });
});

// ---------------------------------------------------------------------------
// P-07 escalón C — what the two captured streams prove (ADR 0099)
// ---------------------------------------------------------------------------

/** Parse a whole stream, either in one chunk or split at every byte offset. */
function signalsOf(lines: readonly string[], splitAt?: number): readonly unknown[] {
  const stream = lines.map((line) => line + "\n").join("");
  const chunks = splitAt === undefined ? [stream] : [stream.slice(0, splitAt), stream.slice(splitAt)];
  let cursor = EMPTY_CURSOR;
  const out: unknown[] = [];
  for (const chunk of chunks) {
    const outcome = claudeAdapter.parse(chunk, cursor);
    if (!outcome.ok) return [{ refused: outcome.code }];
    out.push(...outcome.events);
    cursor = outcome.cursor;
  }
  return out;
}

/** A captured record, as an object a test may change one field of. */
function record(line: string | undefined): Record<string, unknown> {
  if (line === undefined) throw new Error("the fixture holds the record");
  return JSON.parse(line) as Record<string, unknown>;
}

describe("P-07 C: the captured Claude streams, parsed (OBS)", () => {
  it("OBS sample 1: started, a zero step, no output, SUCCESS as a token, and the operation FAILED — at every split", () => {
    const expected = [
      { kind: "started", resolvedModel: "claude-haiku-4-5-20251001", protocolVersion: CLAUDE_STREAM_PROTOCOL },
      // The result's usage, every class a real zero, once (P-15/D2).
      {
        kind: "step",
        stepIndex: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        reportKind: "CUMULATIVE",
        isFinal: true,
        sourceObservationId: "00000000-0000-4000-8000-000000000001/result",
      },
      { kind: "state", toState: "SUCCESS" },
      { kind: "operation", status: "FAILED" },
    ];
    expect(signalsOf(CAPTURED_AUTH_FAILURE)).toEqual(expected);
    const length = CAPTURED_AUTH_FAILURE.map((line) => line + "\n").join("").length;
    for (let at = 1; at < length; at += 1) {
      expect(signalsOf(CAPTURED_AUTH_FAILURE, at), "split at " + String(at)).toEqual(expected);
    }
    // The error text the CLI flagged `is_api_error_message` is not output.
    expect(JSON.stringify(signalsOf(CAPTURED_AUTH_FAILURE))).not.toContain("Not logged in");
  });

  it("OBS sample 2: commands_changed and rate_limit_event carry no signal, thinking is not output, and the operation SUCCEEDED", () => {
    const signals = signalsOf(CAPTURED_SUCCESS);
    expect(signals).toEqual([
      { kind: "started", resolvedModel: "claude-haiku-4-5-20251001", protocolVersion: CLAUDE_STREAM_PROTOCOL },
      { kind: "output", text: "ok" },
      // ONE report, from the result (P-15/D2, ADR 0105). The two assistant records
      // repeat one message (one id, so one step) and each carried usage; before D2
      // each was a report, and the settlement summed them. The CLI's own total is
      // the one count.
      {
        kind: "step",
        stepIndex: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 1,
        cacheReadTokens: 1,
        totalTokens: 4,
        reportKind: "CUMULATIVE",
        isFinal: true,
        sourceObservationId: "00000000-0000-4000-8000-000000000001/result",
      },
      { kind: "state", toState: "SUCCESS" },
      { kind: "operation", status: "SUCCEEDED" },
    ]);
    // The thinking block's opaque signature is not output and is carried nowhere.
    expect(JSON.stringify(signals)).not.toContain("fixture-signature");
    // No pressure: a rate_limit_event is recognized and never mapped to quota pressure.
    expect(signals.some((signal) => (signal as { kind: string }).kind === "pressure")).toBe(false);
  });

  it("positive control: the same result record without is_error says nothing about the operation", () => {
    const result = record(CAPTURED_AUTH_FAILURE[2]);
    delete result["is_error"];
    const signals = signalsOf([JSON.stringify(result)]);
    // The usage report still arrives — no assistant record was seen, so no step.
    expect(signals).toEqual([expect.objectContaining({ kind: "step", stepIndex: 0, totalTokens: 0 }), { kind: "state", toState: "SUCCESS" }]);
  });

  it("is_error present and not a boolean is refused, never read as absent (the NULL lesson, value by value)", () => {
    for (const value of [null, "true", 1, 0, {}, []]) {
      const result = record(CAPTURED_SUCCESS[5]);
      result["is_error"] = value;
      expect(signalsOf([JSON.stringify(result)]), JSON.stringify(value)).toEqual([{ refused: "MALFORMED_EVENT" }]);
    }
  });

  it("is_api_error_message: absent or false is output, true is excluded, anything else is refused", () => {
    const assistant = (flag: unknown): string => {
      const value = record(CAPTURED_SUCCESS[3]);
      if (flag === undefined) delete value["is_api_error_message"];
      else value["is_api_error_message"] = flag;
      return JSON.stringify(value);
    };
    expect(signalsOf([assistant(undefined)])).toContainEqual({ kind: "output", text: "ok" });
    expect(signalsOf([assistant(false)])).toContainEqual({ kind: "output", text: "ok" });
    expect(signalsOf([assistant(true)]).some((signal) => (signal as { kind: string }).kind === "output")).toBe(false);
    for (const value of [null, "true", 1]) {
      expect(signalsOf([assistant(value)]), JSON.stringify(value)).toEqual([{ refused: "MALFORMED_EVENT" }]);
    }
  });

  it("a text block whose text is absent, null or not a string is refused; an empty text is no output", () => {
    const withBlock = (block: Record<string, unknown>): string => {
      const value = record(CAPTURED_SUCCESS[3]);
      (value["message"] as Record<string, unknown>)["content"] = [block];
      return JSON.stringify(value);
    };
    for (const block of [{ type: "text" }, { type: "text", text: null }, { type: "text", text: 7 }]) {
      expect(signalsOf([withBlock(block)]), JSON.stringify(block)).toEqual([{ refused: "MALFORMED_EVENT" }]);
    }
    expect(signalsOf([withBlock({ type: "text", text: "" })]).some((signal) => (signal as { kind: string }).kind === "output")).toBe(false);
    // Two text blocks are two deltas, in order.
    const value = record(CAPTURED_SUCCESS[3]);
    (value["message"] as Record<string, unknown>)["content"] = [{ type: "text", text: "a" }, { type: "thinking", thinking: "" }, { type: "text", text: "b" }];
    expect(signalsOf([JSON.stringify(value)]).filter((signal) => (signal as { kind: string }).kind === "output")).toEqual([
      { kind: "output", text: "a" },
      { kind: "output", text: "b" },
    ]);
  });

  it("rate_limit_event is no-signal only with the observed status \"allowed\"; any other is refused, never pressure", () => {
    const withStatus = (status: unknown): string => {
      const value = record(CAPTURED_SUCCESS[4]);
      const info = value["rate_limit_info"] as Record<string, unknown>;
      if (status === undefined) delete info["status"];
      else info["status"] = status;
      return JSON.stringify(value);
    };
    // Positive control: the observed record.
    expect(signalsOf([CAPTURED_SUCCESS[4] ?? ""])).toEqual([]);
    for (const status of [undefined, null, 1, "rejected", "allowed_warning", ""]) {
      expect(signalsOf([withStatus(status)]), JSON.stringify(status)).toEqual([{ refused: "UNKNOWN_EVENT" }]);
    }
    const noInfo = record(CAPTURED_SUCCESS[4]);
    delete noInfo["rate_limit_info"];
    expect(signalsOf([JSON.stringify(noInfo)])).toEqual([{ refused: "UNKNOWN_EVENT" }]);
  });

  it("a content that is present and not an array, or a block that is not an object, is refused; other block types are skipped", () => {
    const withContent = (content: unknown): string => {
      const value = record(CAPTURED_SUCCESS[3]);
      const message = value["message"] as Record<string, unknown>;
      if (content === undefined) delete message["content"];
      else message["content"] = content;
      return JSON.stringify(value);
    };
    for (const content of [null, "ok", 7, { type: "text", text: "ok" }]) {
      expect(signalsOf([withContent(content)]), JSON.stringify(content)).toEqual([{ refused: "MALFORMED_EVENT" }]);
    }
    for (const block of [null, "ok", 7, ["text"]]) {
      expect(signalsOf([withContent([block])]), JSON.stringify(block)).toEqual([{ refused: "MALFORMED_EVENT" }]);
    }
    // Absent content is no output, and a block of another type is skipped.
    expect(signalsOf([withContent(undefined)]).some((signal) => (signal as { kind: string }).kind === "output")).toBe(false);
    expect(signalsOf([withContent([{ type: "image" }, { type: "text", text: "ok" }])])).toContainEqual({ kind: "output", text: "ok" });
  });

  it("any other system subtype or record type still fails closed", () => {
    expect(signalsOf([JSON.stringify({ type: "system", subtype: "unheard_of" })])).toEqual([{ refused: "UNKNOWN_EVENT" }]);
    expect(signalsOf([JSON.stringify({ type: "rate_limit_event_v2" })])).toEqual([{ refused: "UNKNOWN_EVENT" }]);
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón D2 — the usage report, read once and never invented (ADR 0105)
// ---------------------------------------------------------------------------

describe("P-15/D2: Claude reports usage once, from the result, and invents no count", () => {
  const usageOf = (usage: unknown, extra: Record<string, unknown> = {}): readonly unknown[] => {
    const result = record(CAPTURED_SUCCESS[5]);
    if (usage === undefined) delete result["usage"];
    else result["usage"] = usage;
    return signalsOf([JSON.stringify({ ...result, ...extra })]).filter((signal) => (signal as { kind: string }).kind === "step");
  };
  const full = { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 };

  it("N-D20: no usage on the result is no report, and a missing class is UNKNOWN with no total — never 0", () => {
    expect(usageOf(undefined)).toEqual([]);
    for (const key of Object.keys(full)) {
      const partial: Record<string, number> = { ...full };
      Reflect.deleteProperty(partial, key);
      const [report] = usageOf(partial) as Record<string, unknown>[];
      const name = Object.entries(CLAUDE_USAGE_SOURCE.normalizationPolicy["classes"] as Record<string, string>).find(
        ([, raw]) => raw === key,
      )?.[0];
      expect({ key, class: report?.[name ?? ""], total: report?.["totalTokens"] }).toEqual({ key, class: null, total: null });
    }
    expect(usageOf(full)).toEqual([
      expect.objectContaining({ inputTokens: 3, outputTokens: 4, cacheWriteTokens: 5, cacheReadTokens: 6, totalTokens: 18 }),
    ]);
  });

  it("a class present with anything but a count, a usage that is not an object, or a report with no session id is refused", () => {
    for (const value of [null, -1, 1.5, "3", {}, 10_000_001]) {
      const result = record(CAPTURED_SUCCESS[5]);
      result["usage"] = { ...full, input_tokens: value };
      expect(signalsOf([JSON.stringify(result)]), JSON.stringify(value)).toEqual([{ refused: "MALFORMED_EVENT" }]);
    }
    for (const usage of [null, "usage", [1], 7]) {
      const result = record(CAPTURED_SUCCESS[5]);
      result["usage"] = usage;
      expect(signalsOf([JSON.stringify(result)]), JSON.stringify(usage)).toEqual([{ refused: "MALFORMED_EVENT" }]);
    }
    for (const sessionId of [undefined, null, "", 7]) {
      const result = record(CAPTURED_SUCCESS[5]);
      if (sessionId === undefined) delete result["session_id"];
      else result["session_id"] = sessionId;
      expect(signalsOf([JSON.stringify(result)]), JSON.stringify(sessionId)).toEqual([{ refused: "MALFORMED_EVENT" }]);
    }
  });

  it("an assistant message id present and not a non-empty string is refused, never read as absent", () => {
    for (const id of [null, "", 7, {}]) {
      const assistant = record(CAPTURED_SUCCESS[3]);
      (assistant["message"] as Record<string, unknown>)["id"] = id;
      expect(signalsOf([JSON.stringify(assistant)]), JSON.stringify(id)).toEqual([{ refused: "MALFORMED_EVENT" }]);
    }
  });

  it("C-D5: the step count is the distinct assistant messages, carried across chunk splits", () => {
    const assistant = (id: string): string => {
      const value = record(CAPTURED_SUCCESS[3]);
      (value["message"] as Record<string, unknown>)["id"] = id;
      return JSON.stringify(value);
    };
    const lines = [assistant("m-1"), assistant("m-1"), assistant("m-2"), CAPTURED_SUCCESS[5] ?? ""];
    const whole = signalsOf(lines).filter((signal) => (signal as { kind: string }).kind === "step");
    expect(whole).toEqual([expect.objectContaining({ stepIndex: 2 })]);
    const length = lines.map((line) => line + "\n").join("").length;
    for (let at = 1; at < length; at += 97) {
      expect(signalsOf(lines, at).filter((signal) => (signal as { kind: string }).kind === "step"), String(at)).toEqual(whole);
    }
  });

  it("declares its source once: the provider's own count, under a policy whose digest is pinned and recomputed here", () => {
    expect(CLAUDE_USAGE_SOURCE.source).toBe("claude-cli");
    expect(CLAUDE_USAGE_SOURCE.sourceClass).toBe("PROVIDER_AUTHORITATIVE");
    // Canonical JSON: keys sorted at every depth, no whitespace. Recomputed here with
    // node:crypto, because src/ hashes nothing outside the session name (L-P15A-1).
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
            )
          : value;
    const digest = createHash("sha256")
      .update(JSON.stringify(canonical(CLAUDE_USAGE_SOURCE.normalizationPolicy)), "utf8")
      .digest("hex");
    expect(CLAUDE_USAGE_SOURCE.normalizationPolicySha256).toBe(digest);
    expect(CLAUDE_USAGE_SOURCE.normalizationPolicySha256).toBe("14cbb2a397762bfc4cfec2d00073bc26402d7c81123a2a8683fc007fa808fb0d");
    expect(Object.isFrozen(CLAUDE_USAGE_SOURCE)).toBe(true);
  });
});
