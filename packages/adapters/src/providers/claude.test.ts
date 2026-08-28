import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { allowedEnvKeys } from "../config-root.js";
import type {
  AdmittedBinary,
  AdmittedConfigRoot,
  AdmittedWorkdir,
  ProviderAdapter,
  SessionLimits,
  SessionRequest,
} from "../contract.js";
import { EMPTY_CURSOR } from "../contract.js";
import { AdapterError } from "../errors.js";
import type { NormalizedEvent } from "../events.js";
import { descriptorEnablesWrites, startSession } from "../session.js";
import { fakeProviderArgv } from "../testing/fake-provider.js";
import type { FakeScript } from "../testing/fake-provider.js";
import { CLAUDE_STREAM_PROTOCOL, claudeAdapter } from "./claude.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
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
const RESULT = JSON.stringify({ type: "result", subtype: "success" });

describe("the descriptor is exactly what was authorized", () => {
  it("builds headless stream-json argv with the model and a session id", () => {
    const descriptor = claudeAdapter.describe(request(IMPLEMENTER));
    expect([...descriptor.argv]).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--model",
      "opus",
      "--session-id",
      TASK,
    ]);
  });

  it("uses --resume instead of --session-id when resuming", () => {
    const descriptor = claudeAdapter.describe(
      request(IMPLEMENTER, { resumeSessionId: "prior-session" }),
    );
    expect([...descriptor.argv]).toContain("--resume");
    expect([...descriptor.argv]).toContain("prior-session");
    expect([...descriptor.argv]).not.toContain("--session-id");
  });

  it("forwards exactly the allowlisted environment and nothing else", () => {
    process.env["ACP_P4B_SHOULD_NOT_TRAVEL"] = "leaked";
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
      expect(Object.hasOwn(descriptor.env, "ACP_P4B_SHOULD_NOT_TRAVEL")).toBe(false);
      expect(Object.hasOwn(descriptor.env, "KIMI_CODE_HOME")).toBe(false);
      expect(Object.hasOwn(descriptor.env, "CODEX_HOME")).toBe(false);
    } finally {
      delete process.env["ACP_P4B_SHOULD_NOT_TRAVEL"];
    }
  });

  it("adds the native read-only layer for a reviewer, and still passes the structural scan", () => {
    const descriptor = claudeAdapter.describe(request(REVIEWER));
    expect([...descriptor.argv]).toContain("--restricted");
    expect([...descriptor.argv]).toContain("--permission-mode");
    expect([...descriptor.argv]).toContain("plan");
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
    expect(events[1]?.payload["tokensUsed"]).toBe(1200);
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
    expect(events.map((event) => event.name)).toEqual(["session.started", "step.completed"]);
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
  const source = readFileSync(join(HERE, "claude.ts"), "utf8");
  // Comments explain which APIs the module deliberately does not use, and say
  // their names to do so. Only code is under assertion.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("imports neither the spawner, the session controller nor child_process", () => {
    expect(code).not.toContain("node:child_process");
    expect(code).not.toMatch(/from\s*["'][^"']*process\/spawn\.js["']/);
    expect(code).not.toContain("spawnAdmitted");
    // `isReadOnlyIdentity` is a pure predicate re-exported by session.ts; the
    // module never touches the controller itself.
    expect(code).not.toContain("startSession");
  });

  it("imports no session or process module from any provider source", () => {
    // Provider modules are pure descriptors and parsers. Reaching into
    // `session.ts` — even for a pure predicate, as an earlier revision did —
    // makes the module a participant in the process boundary it is kept
    // outside of. The role predicate comes from `@acp/contracts` instead.
    for (const entry of readdirSync(HERE, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(HERE, entry.name), "utf8")
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
export const MODULE_DIRECTORY = dirname(join(HERE, "claude.ts"));
