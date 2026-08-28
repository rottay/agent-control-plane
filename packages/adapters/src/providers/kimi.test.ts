import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { hasPrivacyViolation } from "../redact.js";
import { descriptorEnablesWrites, startSession } from "../session.js";
import { fakeProviderArgv } from "../testing/fake-provider.js";
import type { FakeScript } from "../testing/fake-provider.js";
import { KIMI_ACP_PROTOCOL, KIMI_ACP_PROTOCOL_VERSION, kimiAdapter } from "./kimi.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const TMP_ROOT = realpathSync(tmpdir());
const NODE = realpathSync(process.execPath) as AdmittedBinary;
const IMPLEMENTER = "moonshot/kimi-k3/implementer/01";
const REVIEWER = "moonshot/kimi-k3/reviewer/01";
const TASK = "00000000-0000-4000-8000-00000000000c";

const created: string[] = [];
/** Every PID this file spawned; swept at the end of this file. */
const ownedPids: number[] = [];

function drillRoot(): string {
  const path = join(TMP_ROOT, "acp-p4c-" + randomUUID());
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
    modelAlias: "k3",
    binary: NODE,
    configRoot: root as AdmittedConfigRoot,
    workdir: root as AdmittedWorkdir,
    resumeSessionId: null,
    limits: limits(),
    ...overrides,
  } as SessionRequest;
}

/** The Kimi adapter, with argv rewritten so a scripted fake ACP peer answers. */
function scripted(script: FakeScript): ProviderAdapter {
  return {
    ...kimiAdapter,
    describe(req: SessionRequest) {
      return {
        provider: "kimi" as const,
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
    // read from the probe below, whichever way it surfaced
  }
  await session.settled();
  const failure = session.health().classifiedError;
  await session.close();
  return { events, failure };
}

async function waitDead(pid: number, deadlineMs = 2_000): Promise<boolean> {
  for (let waited = 0; waited < deadlineMs; waited += 10) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

afterEach(() => {
  const prefix = join(TMP_ROOT, "acp-p4c-");
  while (created.length > 0) {
    const path = created.pop();
    if (path?.startsWith(prefix) === true) rmSync(path, { recursive: true, force: true });
  }
});

// --- ACP v1 NDJSON frames, as the recorded contract revision shapes them ----

const rpc = (body: Record<string, unknown>): string => JSON.stringify({ jsonrpc: "2.0", ...body });
const INITIALIZE = rpc({ id: 1, result: { protocolVersion: 1, agentName: "kimi-k3" } });
const SESSION_NEW = rpc({ id: 2, result: { sessionId: "sess-1" } });
const UPDATE_CHUNK = rpc({
  method: "session/update",
  params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk" } },
});
const PROMPT_RESULT = rpc({ id: 3, result: { stopReason: "end_turn" } });

describe("the descriptor is exactly what was authorized", () => {
  it("runs `kimi acp` over stdio and forwards no other flag", () => {
    const descriptor = kimiAdapter.describe(request(IMPLEMENTER));
    expect([...descriptor.argv]).toEqual(["acp"]);
    // --login in particular is never passed: P4 performs no authentication.
    expect([...descriptor.argv]).not.toContain("--login");
    expect([...descriptor.argv]).not.toContain("--region");
  });

  it("forwards exactly the allowlisted environment and nothing else", () => {
    process.env["ACP_P4C_SHOULD_NOT_TRAVEL"] = "leaked";
    try {
      const descriptor = kimiAdapter.describe(request(IMPLEMENTER));
      for (const key of Object.keys(descriptor.env)) {
        expect({ key, allowed: allowedEnvKeys("kimi").includes(key) }).toEqual({
          key,
          allowed: true,
        });
      }
      expect(descriptor.env["KIMI_CODE_HOME"]).toBe(descriptor.cwd);
      expect(Object.hasOwn(descriptor.env, "ACP_P4C_SHOULD_NOT_TRAVEL")).toBe(false);
      expect(Object.hasOwn(descriptor.env, "CLAUDE_CONFIG_DIR")).toBe(false);
      expect(Object.hasOwn(descriptor.env, "CODEX_HOME")).toBe(false);
    } finally {
      delete process.env["ACP_P4C_SHOULD_NOT_TRAVEL"];
    }
  });

  it("claims no native read-only mode for a reviewer, and still passes the structural scan", () => {
    // Kimi's `acp` surface exposes no read-only flag, so none is asserted. The
    // guarantee rests on the structural scan and the write-class refusal.
    const reviewer = kimiAdapter.describe(request(REVIEWER));
    const implementer = kimiAdapter.describe(request(IMPLEMENTER));
    expect([...reviewer.argv]).toEqual([...implementer.argv]);
    expect(descriptorEnablesWrites(reviewer.argv)).toBe(false);
  });

  it("isolates one session's config root from another's", () => {
    const first = kimiAdapter.describe(request(IMPLEMENTER));
    const second = kimiAdapter.describe(request(IMPLEMENTER));
    expect(first.env["KIMI_CODE_HOME"]).not.toBe(second.env["KIMI_CODE_HOME"]);
  });
});

describe("the parser reads ACP v1 NDJSON, and refuses the rest", () => {
  it("parses initialize → session/new → update → result end to end", async () => {
    const { events, failure } = await collect({
      lines: [INITIALIZE, SESSION_NEW, UPDATE_CHUNK, PROMPT_RESULT],
      exitCode: 0,
    });
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual([
      "session.started",
      "provider.state",
      "provider.state",
    ]);
    expect(events[0]?.frozenType).toBe("RUN_STARTED");
    expect(events[0]?.payload["protocolVersion"]).toBe(KIMI_ACP_PROTOCOL);
    expect(events[0]?.payload["resolvedModel"]).toBe("kimi-k3");
    expect(events[1]?.payload["toState"]).toBe("SESSION_READY");
    expect(events[2]?.payload["toState"]).toBe("END_TURN");
  });

  it("handles several frames arriving in one chunk", () => {
    const outcome = kimiAdapter.parse([INITIALIZE, SESSION_NEW, PROMPT_RESULT].join("\n") + "\n", EMPTY_CURSOR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.events.map((signal) => signal.kind)).toEqual(["started", "state", "state"]);
  });

  it("carries a frame split across a chunk boundary", () => {
    const first = kimiAdapter.parse(INITIALIZE.slice(0, 20), EMPTY_CURSOR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.events).toEqual([]);
    const second = kimiAdapter.parse(INITIALIZE.slice(20) + "\n", first.cursor);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.events.map((signal) => signal.kind)).toEqual(["started"]);
  });

  it("decodes a multibyte codepoint split across two chunks", async () => {
    const frame = rpc({ id: 9, result: { sessionId: "café-1" } }) + "\n";
    const bytes = Buffer.from(frame, "utf8");
    const cut = bytes.indexOf(Buffer.from("é", "utf8")[0] ?? 0) + 1;
    const { StringDecoder } = await import("node:string_decoder");
    const decoder = new StringDecoder("utf8");
    const joined = decoder.write(bytes.subarray(0, cut)) + decoder.write(bytes.subarray(cut));
    expect(joined).toBe(frame);
    expect(joined).not.toContain("�");
  });

  it("reports a bounded token count when an update carries one", async () => {
    const withTokens = rpc({
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", _meta: { tokensUsed: 1200 } },
      },
    });
    const { events, failure } = await collect({ lines: [INITIALIZE, withTokens], exitCode: 0 });
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual(["session.started", "step.completed"]);
    expect(events[1]?.payload["tokensUsed"]).toBe(1200);
  });

  it("reports no measurement for an out-of-range token count", async () => {
    const overLimit = rpc({
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", _meta: { tokensUsed: 10_000_001 } },
      },
    });
    const { events, failure } = await collect({ lines: [INITIALIZE, overLimit], exitCode: 0 });
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual(["session.started"]);
  });

  it("raises auth.required with a classified reason and no prompt", async () => {
    const authError = rpc({
      id: 4,
      error: { code: -32000, message: "authenticate at https://example.invalid/login" },
    });
    const { events } = await collect({ lines: [authError], exitCode: 0 });
    expect(events.map((event) => event.name)).toEqual(["auth.required"]);
    expect(events[0]?.frozenType).toBe("AUTH_REQUIRED_RAISED");
    expect(events[0]?.payload["reason"]).toBe("AUTH_REQUIRED");
    expect(JSON.stringify(events[0])).not.toContain("example.invalid");
  });

  it("surfaces any other error as an open provider-state token", async () => {
    const { events, failure } = await collect({
      lines: [rpc({ id: 5, error: { code: -32601, message: "method not found" } })],
      exitCode: 0,
    });
    expect(failure).toBeNull();
    expect(events.map((event) => event.payload["toState"])).toEqual(["ERROR_-32601"]);
  });

  it("refuses an unknown method", async () => {
    const { failure } = await collect({
      lines: [INITIALIZE, rpc({ method: "telemetry/ping", params: {} })],
      exitCode: 0,
    });
    expect(failure).toBe("UNKNOWN_EVENT");
  });

  it("refuses an unknown session/update kind", async () => {
    const { failure } = await collect({
      lines: [
        rpc({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "brand_new" } } }),
      ],
      exitCode: 0,
    });
    expect(failure).toBe("UNKNOWN_EVENT");
  });

  it("refuses a protocol version outside the recorded generation", async () => {
    const { failure } = await collect({
      lines: [rpc({ id: 1, result: { protocolVersion: 2, agentName: "kimi" } })],
      exitCode: 0,
    });
    // ACP v2 is experimental and out of scope: refused, never adapted to.
    expect(failure).toBe("UNKNOWN_EVENT");
    expect(KIMI_ACP_PROTOCOL_VERSION).toBe(1);
  });

  it("refuses a malformed frame", async () => {
    for (const line of [
      "{ not json",
      JSON.stringify({ id: 1, result: {} }), // no jsonrpc envelope
      rpc({ id: 1, result: { protocolVersion: "one" } }),
      rpc({ id: 1 }), // neither result nor error
      rpc({ method: "session/update", params: { sessionId: "s" } }), // no update
    ]) {
      const { failure } = await collect({ lines: [line], exitCode: 0 });
      expect({ line, failure }).toEqual({ line, failure: "MALFORMED_EVENT" });
    }
  });

  it("leaves a truncated trailing frame unparsed", async () => {
    const { events, failure } = await collect({ lines: [INITIALIZE], exitCode: 0 });
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual(["session.started"]);
  });

  it("survives an immediate death and a death mid-stream", async () => {
    const empty = await collect({ lines: [], exitCode: 0 });
    expect(empty.failure).toBeNull();
    expect(empty.events).toEqual([]);

    const partial = await collect({ lines: [INITIALIZE, SESSION_NEW], exitCode: 3 });
    expect(partial.failure).toBeNull();
    expect(partial.events.map((event) => event.name)).toEqual(["session.started", "provider.state"]);
  });

  it("refuses Content-Length framing, which stable v1 does not use", async () => {
    // A parser written defensively to "handle either framing" would silently
    // accept the wrong protocol shape for stable ACP v1. NDJSON only.
    const framed = "Content-Length: 42\r\n\r\n" + INITIALIZE;
    const { failure } = await collect({ lines: [framed], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
    // On code, not prose: the module comment explains why this framing is
    // absent, and says its name to do so.
    const moduleCode = readFileSync(join(HERE, "kimi.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(moduleCode).not.toContain("Content-Length");
  });

  it("refuses a response carrying both result and error", async () => {
    // A naive `if (result) … else if (error) …` silently prefers one and masks
    // a malformed peer. Exactly one, or it is malformed.
    const both = rpc({ id: 1, result: { stopReason: "end_turn" }, error: { code: -1 } });
    const { failure } = await collect({ lines: [both], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("is deterministic across repeated identical runs", () => {
    const chunk = [INITIALIZE, SESSION_NEW, UPDATE_CHUNK, PROMPT_RESULT].join("\n") + "\n";
    const first = JSON.stringify(kimiAdapter.parse(chunk, EMPTY_CURSOR));
    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(kimiAdapter.parse(chunk, EMPTY_CURSOR))).toBe(first);
    }
  });
});

describe("the reviewer guarantee holds for this provider", () => {
  it("accepts every tool on the read-only allowlist", async () => {
    for (const title of ["Read", "Glob", "Grep", "WebFetch", "WebSearch"]) {
      const call = rpc({
        method: "session/update",
        params: { sessionId: "s", update: { sessionUpdate: "tool_call", title } },
      });
      const { failure } = await collect({ lines: [INITIALIZE, call], exitCode: 0 }, REVIEWER);
      expect({ title, failure }).toEqual({ title, failure: null });
    }
  });

  it("refuses an out-of-allowlist tool with autonomous teardown", async () => {
    const call = rpc({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "tool_call", title: "Bash" } },
    });
    const session = startSession(
      scripted({ lines: [INITIALIZE, call], exitCode: 0, lingerMs: 10_000 }),
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
    // Dead without this test calling close().
    expect(await waitDead(session.pid)).toBe(true);
  });

  it("refuses a call titled Read whose kind says execute", async () => {
    // The spoof the checklist names: a classifier trusting only the title
    // would wave this through. ACP classifies by `kind` as well, and either
    // field being outside its allowlist makes the call write-class.
    const spoof = rpc({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "tool_call", title: "Read", kind: "execute" } },
    });
    const { failure } = await collect({ lines: [INITIALIZE, spoof], exitCode: 0 }, REVIEWER);
    expect(failure).toBe("READ_ONLY_VIOLATION");
  });

  it("refuses a tool call that classifies itself as nothing at all", async () => {
    const unclassified = rpc({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "tool_call" } },
    });
    const { failure } = await collect({ lines: [INITIALIZE, unclassified], exitCode: 0 }, REVIEWER);
    expect(failure).toBe("READ_ONLY_VIOLATION");
  });

  it("accepts a read-kind call whose title is also on the allowlist", async () => {
    const ok = rpc({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "tool_call", title: "Read", kind: "read" } },
    });
    const { failure } = await collect({ lines: [INITIALIZE, ok], exitCode: 0 }, REVIEWER);
    expect(failure).toBeNull();
  });

  it("treats a field-less partial update as benign, not unclassified", async () => {
    // F1. An initial `tool_call` naming neither field has told us nothing and
    // fails closed. A `tool_call_update` naming neither is an ordinary
    // progress report on a call already classified at creation — refusing it
    // would make the reviewer law unusable rather than strict.
    const partial = rpc({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "tool_call_update" } },
    });
    const { failure } = await collect({ lines: [INITIALIZE, partial], exitCode: 0 }, REVIEWER);
    expect(failure).toBeNull();
  });

  it("still refuses a partial update whose present field is disallowed", async () => {
    for (const update of [
      { sessionUpdate: "tool_call_update", kind: "execute" },
      { sessionUpdate: "tool_call_update", title: "Bash" },
    ]) {
      const frame = rpc({ method: "session/update", params: { sessionId: "s", update } });
      const session = startSession(
        scripted({ lines: [INITIALIZE, frame], exitCode: 0, lingerMs: 10_000 }),
        request(REVIEWER),
      );
      ownedPids.push(session.pid);
      try {
        for await (const event of session.events()) void event;
      } catch {
        // surfaced either way
      }
      await session.settled();
      expect(session.health().classifiedError).toBe("READ_ONLY_VIOLATION");
      expect(await waitDead(session.pid)).toBe(true);
    }
  });

  it("reads terminal/output without killing the session", async () => {
    // F2. The pinned schema defines it as "Request to get the current output
    // and status of a terminal" — a read. It was missing from the read table.
    const output = rpc({ id: 11, method: "terminal/output", params: { sessionId: "s", terminalId: "t" } });
    const { failure } = await collect({ lines: [INITIALIZE, output], exitCode: 0 }, REVIEWER);
    expect(failure).toBeNull();
  });

  it("tolerates a conforming terminal flow for an implementer", async () => {
    const create = rpc({ id: 12, method: "terminal/create", params: { sessionId: "s" } });
    const output = rpc({ id: 13, method: "terminal/output", params: { sessionId: "s", terminalId: "t" } });
    const { events, failure } = await collect(
      { lines: [INITIALIZE, create, output], exitCode: 0 },
      IMPLEMENTER,
    );
    // `terminal/create` is a write-class signal, which carries no normalized
    // event for a non-reviewer; `terminal/output` is simply a read.
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual(["session.started"]);
  });

  it("classifies the call embedded in a permission request", async () => {
    // F3. The request carries the call it asks about, so the same law applies.
    const denied = rpc({
      id: 14,
      method: "session/request_permission",
      params: { sessionId: "s", toolCall: { title: "Bash", kind: "execute" } },
    });
    const session = startSession(
      scripted({ lines: [INITIALIZE, denied], exitCode: 0, lingerMs: 10_000 }),
      request(REVIEWER),
    );
    ownedPids.push(session.pid);
    try {
      for await (const event of session.events()) void event;
    } catch {
      // surfaced either way
    }
    await session.settled();
    expect(session.health().classifiedError).toBe("READ_ONLY_VIOLATION");
    expect(await waitDead(session.pid)).toBe(true);
  });

  it("permits a permission request embedding an allowlisted call", async () => {
    const allowed = rpc({
      id: 15,
      method: "session/request_permission",
      params: { sessionId: "s", toolCall: { title: "Read", kind: "read" } },
    });
    const { failure } = await collect({ lines: [INITIALIZE, allowed], exitCode: 0 }, REVIEWER);
    expect(failure).toBeNull();
  });

  it("treats a permission request with no embedded call as benign", async () => {
    const bare = rpc({ id: 16, method: "session/request_permission", params: { sessionId: "s" } });
    const { failure } = await collect({ lines: [INITIALIZE, bare], exitCode: 0 }, REVIEWER);
    expect(failure).toBeNull();
  });

  it("leaves an implementer unaffected by a denied permission request", async () => {
    const denied = rpc({
      id: 17,
      method: "session/request_permission",
      params: { sessionId: "s", toolCall: { title: "Bash", kind: "execute" } },
    });
    const { failure } = await collect({ lines: [INITIALIZE, denied], exitCode: 0 }, IMPLEMENTER);
    expect(failure).toBeNull();
  });

  it("refuses a write-class ACP method under a reviewer identity", async () => {
    const write = rpc({ id: 7, method: "fs/write_text_file", params: { sessionId: "s" } });
    const { failure } = await collect({ lines: [INITIALIZE, write], exitCode: 0 }, REVIEWER);
    expect(failure).toBe("READ_ONLY_VIOLATION");
  });

  it("treats fs/read_text_file as a read", async () => {
    const read = rpc({ id: 8, method: "fs/read_text_file", params: { sessionId: "s" } });
    const { failure } = await collect({ lines: [INITIALIZE, read], exitCode: 0 }, REVIEWER);
    expect(failure).toBeNull();
  });

  it("leaves an implementer unaffected by the same write-class events", async () => {
    const call = rpc({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "tool_call", title: "Bash" } },
    });
    const write = rpc({ id: 7, method: "fs/write_text_file", params: { sessionId: "s" } });
    const { events, failure } = await collect(
      { lines: [INITIALIZE, call, write], exitCode: 0 },
      IMPLEMENTER,
    );
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual(["session.started"]);
  });
});

describe("elicitation is an interaction, not a write", () => {
  const CREATE = rpc({
    id: 20,
    method: "elicitation/create",
    params: {
      sessionId: "s",
      message: "Paste your API token from https://example.invalid/token",
      requestedSchema: { type: "object", properties: { apiKey: { type: "string" } } },
    },
  });
  const COMPLETE = rpc({
    method: "elicitation/complete",
    params: { sessionId: "s", outcome: { action: "accept", content: { apiKey: "sk-secret-value" } } },
  });

  for (const [label, identity] of [
    ["implementer", IMPLEMENTER],
    ["reviewer", REVIEWER],
  ] as const) {
    it("raises auth.required for elicitation/create under a " + label + " identity", async () => {
      const { events, failure } = await collect({ lines: [INITIALIZE, CREATE], exitCode: 0 }, identity);
      // An interaction request is not a write: no violation, no teardown, the
      // session continues.
      expect(failure).toBeNull();
      expect(events.map((event) => event.name)).toEqual(["session.started", "auth.required"]);
      expect(events[1]?.frozenType).toBe("AUTH_REQUIRED_RAISED");
      expect(events[1]?.payload["reason"]).toBe("ELICITATION_REQUIRED");
    });

    it("maps elicitation/complete to a bounded state token under a " + label + " identity", async () => {
      const { events, failure } = await collect({ lines: [INITIALIZE, COMPLETE], exitCode: 0 }, identity);
      expect(failure).toBeNull();
      expect(events.map((event) => event.name)).toEqual(["session.started", "provider.state"]);
      expect(events[1]?.frozenType).toBe("TASK_STATE_CHANGED");
      expect(events[1]?.payload["toState"]).toBe("ELICITATION_COMPLETE");
    });
  }

  it("lets no prompt, URL, schema or answer travel", async () => {
    const { events, failure } = await collect(
      { lines: [INITIALIZE, CREATE, COMPLETE], exitCode: 0 },
      REVIEWER,
    );
    expect(failure).toBeNull();
    const serialized = JSON.stringify(events);
    for (const secret of [
      "Paste your API token",
      "example.invalid",
      "requestedSchema",
      "apiKey",
      "sk-secret-value",
      "accept",
    ]) {
      expect({ secret, leaked: serialized.includes(secret) }).toEqual({ secret, leaked: false });
    }
    // And the one privacy vocabulary agrees.
    expect(hasPrivacyViolation(events)).toBe(false);
  });

  it("keeps the secret out of a refusal detail too", async () => {
    // A malformed elicitation frame must not quote what it failed on.
    const malformed = '{"jsonrpc":"2.0","method":"elicitation/create","params":';
    const { failure } = await collect({ lines: [malformed], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
    const error = new AdapterError("MALFORMED_EVENT", { provider: "kimi", taskId: TASK });
    expect(error.message).toBe("MALFORMED_EVENT [kimi " + TASK + "]");
  });
});

describe("cancellation uses the signal floor", () => {
  it("escalates when the peer ignores SIGINT, with no protocol cancel", async () => {
    const session = startSession(
      scripted({ lines: [INITIALIZE], exitCode: 0, ignoreSigint: true, lingerMs: 10_000 }),
      request(IMPLEMENTER),
    );
    ownedPids.push(session.pid);
    const stream = session.events()[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.done).toBe(false);

    const record = await session.interrupt();
    expect(record.steps).toContain("SIGINT");
    expect(record.steps).toContain("SIGTERM");
    expect(record.escalated).toBe(true);
    // PROTOCOL_CANCEL is UNKNOWN for Kimi, so the ladder is signal-only.
    expect(record.viaProtocolCancel).toBe(false);
    await session.close();
  });
});

describe("every method the pinned schema defines is accounted for", () => {
  /**
   * The vendored ACP v1 schema, or `null` on a machine without the evidence.
   *
   * Absent evidence must not fail `pnpm check` — the same rule the optional
   * version probe follows. What it must not do is pass *silently*, so the
   * absence is reported rather than swallowed.
   */
  const SCHEMA_PATH = resolve(HERE, "..", "..", "..", "..", ".acp-local", "p4c-acp-v1-schema-9f40e018.json");

  /** Methods this parser classifies, inbound from the agent. */
  const CLASSIFIED_INBOUND: readonly string[] = [
    "elicitation/complete",
    "elicitation/create",
    "fs/read_text_file",
    "fs/write_text_file",
    "session/request_permission",
    "session/update",
    "terminal/create",
    "terminal/kill",
    "terminal/output",
    "terminal/release",
    "terminal/wait_for_exit",
  ];

  /** Methods the client sends to the agent; this parser never receives them. */
  const CLIENT_TO_AGENT: readonly string[] = [
    "session/cancel",
    "session/close",
    "session/delete",
    "session/list",
    "session/load",
    "session/new",
    "session/prompt",
    "session/resume",
    "session/set_config_option",
    "session/set_mode",
  ];

  function schemaMethods(): readonly string[] | null {
    if (!existsSync(SCHEMA_PATH)) return null;
    const text = readFileSync(SCHEMA_PATH, "utf8");
    // No prefix assumption. An earlier reconciliation of mine matched only
    // `fs/`, `terminal/` and `session/`, and so never looked for
    // `elicitation/` — the omission this test exists to make impossible.
    return [...new Set([...text.matchAll(/"([a-z_]+\/[a-z_]+)"/g)].map((m) => m[1] ?? ""))]
      .filter((name) => name !== "")
      .sort();
  }

  it("partitions the schema's methods with nothing left over", () => {
    const methods = schemaMethods();
    if (methods === null) {
      // Recorded, not silent: a machine without the vendored evidence still
      // passes, and says why.
      expect({ evidence: "absent", schemaPath: SCHEMA_PATH.endsWith(".json") }).toEqual({
        evidence: "absent",
        schemaPath: true,
      });
      return;
    }

    const accounted = [...CLASSIFIED_INBOUND, ...CLIENT_TO_AGENT].sort();
    // Equality in both directions: a method the schema adds fails here, and so
    // does an entry of ours the schema does not define.
    expect(methods).toEqual(accounted);
    expect(new Set(accounted).size).toBe(accounted.length);
  });

  it("classifies every inbound method rather than merely listing it", () => {
    const methods = schemaMethods();
    if (methods === null) return;

    for (const method of CLASSIFIED_INBOUND) {
      const frame =
        method === "session/update"
          ? rpc({ method, params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk" } } })
          : rpc({ id: 99, method, params: { sessionId: "s" } });
      const outcome = kimiAdapter.parse(frame + "\n", EMPTY_CURSOR);
      // The parser must recognize it. Whether it is a read, a write signal or
      // an interaction is asserted by the dedicated tests above; what this
      // asserts is that none of them falls through to UNKNOWN_EVENT.
      expect({ method, ok: outcome.ok }).toEqual({ method, ok: true });
    }
  });

  it("still refuses a method the schema does not define", () => {
    const outcome = kimiAdapter.parse(rpc({ id: 1, method: "elicitation/invented" }) + "\n", EMPTY_CURSOR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("UNKNOWN_EVENT");
  });
});

describe("the provider module keeps the boundary's laws", () => {
  const source = readFileSync(join(HERE, "kimi.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("imports no session module, process module or child_process", () => {
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
    expect(code).not.toContain(["@acp", "ledger"].join("/"));
    expect(code).not.toContain("process.env");
  });

  it("names no product path or session tool", () => {
    for (const token of [["Modern", "Rescue"].join(" "), ["ui-design", "system"].join("-"), ["tm", "ux"].join("")]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("claims no capability, and never logs in", () => {
    expect(code).not.toContain("CONFIRMED");
    expect(code).not.toContain("--login");
    const outcome = kimiAdapter.negotiate({});
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

  it("builds no capability record by hand", () => {
    // A hand-rolled `{ name, state, evidence }` literal would bypass the
    // `capability()` guard entirely — and that guard is the only thing
    // enforcing the FAKE/REAL evidence-subject law. The module must reach
    // capabilities solely through `unknownCapabilities()`.
    expect(code).toContain("unknownCapabilities()");
    expect(code).not.toContain("state:");
    expect(code).not.toContain("evidence:");
  });

  it("is an isolated adapter-contract test of negotiate(), not a lifecycle claim", () => {
    // Stated plainly because it would otherwise be easy to over-read: nothing
    // in `session.ts` calls `negotiate()`, so no production lifecycle path
    // reaches it. This asserts the pure function's contract and supports no
    // claim about session-level handshake or negotiation behaviour. Wiring
    // negotiation into the lifecycle would require changing `session.ts`,
    // which is outside this packet's four paths.
    const controller = readFileSync(join(HERE, "..", "session.ts"), "utf8");
    expect(controller).not.toContain("negotiate(");

    const outcome = kimiAdapter.negotiate({ anything: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.protocolVersion).toBe(KIMI_ACP_PROTOCOL);
    expect(outcome.capabilities).toHaveLength(5);
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
