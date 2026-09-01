import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { allowedEnvKeys } from "../../../src/config-root/index.js";
import type {
  AdmittedBinary,
  AdmittedConfigRoot,
  AdmittedWorkdir,
  ProviderAdapter,
  SessionLimits,
  SessionRequest,
} from "../../../src/contract/index.js";
import { EMPTY_CURSOR } from "../../../src/contract/index.js";
import { AdapterError } from "../../../src/errors/index.js";
import type { NormalizedEvent } from "../../../src/events/index.js";
import { hasPrivacyViolation } from "../../../src/redact/index.js";
import { descriptorEnablesWrites, startSession } from "../../../src/session/index.js";
import { fakeProviderArgv } from "../../testing/index.js";
import type { FakeScript } from "../../testing/index.js";
import { CODEX_APP_SERVER_PROTOCOL, CODEX_PROTOCOL_RECORD, codexAdapter } from "../../../src/providers/codex/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const PROVIDER_SRC = join(PACKAGE_ROOT, "src", "providers", "codex");
const TMP_ROOT = realpathSync(tmpdir());
const NODE = realpathSync(process.execPath) as AdmittedBinary;
const IMPLEMENTER = "openai/codex/implementer/01";
const REVIEWER = "openai/codex/reviewer/01";
const TASK = "00000000-0000-4000-8000-00000000000d";

const created: string[] = [];
/** Every PID this file spawned; swept at the end of this file. */
const ownedPids: number[] = [];

function drillRoot(): string {
  const path = join(TMP_ROOT, "acp-p4d-" + randomUUID());
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
    modelAlias: "gpt-5-codex",
    binary: NODE,
    configRoot: root as AdmittedConfigRoot,
    workdir: root as AdmittedWorkdir,
    resumeSessionId: null,
    limits: limits(),
    ...overrides,
  } as SessionRequest;
}

/** The Codex adapter, with argv rewritten so a scripted fake peer answers. */
function scripted(script: FakeScript): ProviderAdapter {
  return withArgv(fakeProviderArgv(script));
}

function withArgv(argv: readonly string[]): ProviderAdapter {
  return {
    ...codexAdapter,
    describe(req: SessionRequest) {
      return {
        provider: "codex" as const,
        argv,
        env: { PATH: "/usr/bin:/bin" },
        cwd: req.workdir,
      };
    },
  };
}

async function drive(
  adapter: ProviderAdapter,
  identity: string,
): Promise<{ readonly events: NormalizedEvent[]; readonly failure: string | null }> {
  const session = startSession(adapter, request(identity));
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

async function collect(
  script: FakeScript,
  identity = IMPLEMENTER,
): Promise<{ readonly events: NormalizedEvent[]; readonly failure: string | null }> {
  return drive(scripted(script), identity);
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
  const prefix = join(TMP_ROOT, "acp-p4d-");
  while (created.length > 0) {
    const path = created.pop();
    if (path?.startsWith(prefix) === true) rmSync(path, { recursive: true, force: true });
  }
});

// --- App Server frames, shaped as the vendored schema defines them ----------
//
// The framing here is newline-delimited because that is what these fixtures
// declare, and it exercises the parser's frame-splitting seam. It is not a
// claim about a real server's wire framing, which is UNKNOWN.

const frame = (body: Record<string, unknown>): string => JSON.stringify(body);

const THREAD_STARTED = frame({
  jsonrpc: "2.0",
  method: "thread/started",
  params: {
    thread: {
      id: "0199-thread",
      cliVersion: "0.149.0",
      cwd: "/tmp/acp-drill",
      modelProvider: "openai",
      preview: "the first user message",
      status: "active",
    },
  },
});
const TURN_STARTED = frame({
  jsonrpc: "2.0",
  method: "turn/started",
  params: { threadId: "0199-thread", turn: { id: "0199-turn", items: [], status: "inProgress" } },
});
const TURN_COMPLETED = frame({
  jsonrpc: "2.0",
  method: "turn/completed",
  params: { threadId: "0199-thread", turn: { id: "0199-turn", items: [], status: "completed" } },
});
const TOKEN_USAGE = frame({
  jsonrpc: "2.0",
  method: "thread/tokenUsage/updated",
  params: {
    threadId: "0199-thread",
    turnId: "0199-turn",
    tokenUsage: {
      last: { cachedInputTokens: 4, inputTokens: 90, outputTokens: 30, reasoningOutputTokens: 6, totalTokens: 120 },
      total: { cachedInputTokens: 9, inputTokens: 900, outputTokens: 300, reasoningOutputTokens: 60, totalTokens: 1200 },
    },
  },
});

function approval(method: string, params: Record<string, unknown> = {}): string {
  return frame({ jsonrpc: "2.0", id: 7, method, params });
}

const WRITE_AUTHORIZING = [
  "applyPatchApproval",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
];

const INTERACTION_BY_REASON: Readonly<Record<string, string>> = {
  "account/chatgptAuthTokens/refresh": "AUTH_REQUIRED",
  "attestation/generate": "ATTESTATION_REQUESTED",
  "item/tool/call": "TOOL_CALL_REQUESTED",
  "item/tool/requestUserInput": "USER_INPUT_REQUESTED",
  "mcpServer/elicitation/request": "ELICITATION_REQUIRED",
};

const CLAIMED_NOTIFICATIONS = [
  "error",
  "thread/started",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/started",
];

const TURN_STATUSES = ["completed", "failed", "inProgress", "interrupted"];

const CODEX_ERROR_VARIANTS = [
  "activeTurnNotSteerable",
  "badRequest",
  "contextWindowExceeded",
  "cyberPolicy",
  "httpConnectionFailed",
  "internalServerError",
  "misalignmentPolicyViolation",
  "other",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "sandboxError",
  "serverOverloaded",
  "sessionBudgetExceeded",
  "threadRollbackFailed",
  "unauthorized",
  "usageLimitExceeded",
];

function errorNotification(
  codexErrorInfo: unknown,
  willRetry = false,
  message = "the model provider returned an error",
): string {
  return frame({
    jsonrpc: "2.0",
    method: "error",
    params: {
      threadId: "0199-thread",
      turnId: "0199-turn",
      willRetry,
      error: { message, codexErrorInfo },
    },
  });
}

describe("the descriptor is exactly what was authorized", () => {
  it("runs `codex app-server` over the documented stdio listen form", () => {
    const descriptor = codexAdapter.describe(request(IMPLEMENTER));
    expect(descriptor.provider).toBe("codex");
    expect([...descriptor.argv]).toEqual(["app-server", "--listen", "stdio://"]);
    // No shell, no interpolation, and nothing that could select a sandbox, an
    // approval policy, an account or an experimental tier.
    for (const token of ["--experimental", "--sandbox", "--ask-for-approval", "login", "--yolo"]) {
      expect({ token, present: descriptor.argv.includes(token) }).toEqual({ token, present: false });
    }
    expect(descriptorEnablesWrites(descriptor.argv)).toBe(false);
  });

  it("forwards exactly the allowlisted environment and nothing else", () => {
    process.env["ACP_P4D_LEAK_PROBE"] = "must-not-travel";
    try {
      const descriptor = codexAdapter.describe(request(IMPLEMENTER));
      // Equality in both directions against what the allowlist can actually
      // yield here: the config root is always minted, and a base variable is
      // forwarded exactly when this machine has one. A fourth variable fails
      // this, and so does a missing third.
      const expected = allowedEnvKeys("codex").filter(
        (key) => key === "CODEX_HOME" || typeof process.env[key] === "string",
      );
      expect(Object.keys(descriptor.env).sort()).toEqual([...expected].sort());
      expect(Object.keys(descriptor.env)).not.toContain("ACP_P4D_LEAK_PROBE");
      expect(JSON.stringify(descriptor.env)).not.toContain("must-not-travel");
      expect(descriptor.env["CODEX_HOME"]).toBe(descriptor.cwd);
      expect(Object.hasOwn(descriptor.env, "CLAUDE_CONFIG_DIR")).toBe(false);
      expect(Object.hasOwn(descriptor.env, "KIMI_CODE_HOME")).toBe(false);
    } finally {
      delete process.env["ACP_P4D_LEAK_PROBE"];
    }
  });

  it("claims no native read-only mode for a reviewer, and still passes the structural scan", () => {
    // Codex's read-only sandbox lives on `exec` and on per-thread start
    // parameters, neither of which this surface reaches. Asserting one here
    // would be a false native-flag claim.
    const reviewer = codexAdapter.describe(request(REVIEWER));
    const implementer = codexAdapter.describe(request(IMPLEMENTER));
    expect([...reviewer.argv]).toEqual([...implementer.argv]);
    expect(descriptorEnablesWrites(reviewer.argv)).toBe(false);
  });

  it("isolates one session's config root from another's", () => {
    const first = codexAdapter.describe(request(IMPLEMENTER));
    const second = codexAdapter.describe(request(IMPLEMENTER));
    expect(first.env["CODEX_HOME"]).not.toBe(second.env["CODEX_HOME"]);
  });
});

describe("the parser reads the claimed subset, and refuses the rest", () => {
  it("reads a thread and turn lifecycle end to end", async () => {
    const { events, failure } = await collect({
      lines: [THREAD_STARTED, TURN_STARTED, TOKEN_USAGE, TURN_COMPLETED],
      exitCode: 0,
    });
    expect(failure).toBeNull();
    expect(events.map((event) => event.name)).toEqual([
      "session.started",
      "provider.state",
      "step.completed",
      "provider.state",
    ]);
    expect(events.map((event) => event.frozenType)).toEqual([
      "RUN_STARTED",
      "TASK_STATE_CHANGED",
      "ATOMIC_STEP_COMPLETED",
      "TASK_STATE_CHANGED",
    ]);
  });

  it("reports no model rather than reporting the vendor as one", async () => {
    const { events } = await collect({ lines: [THREAD_STARTED], exitCode: 0 });
    expect(events[0]?.payload["resolvedModel"]).toBe("unreported");
    expect(events[0]?.payload["protocolVersion"]).toBe(CODEX_APP_SERVER_PROTOCOL);
    expect(JSON.stringify(events)).not.toContain("openai");
  });

  it("carries the turn status into the lifecycle token", async () => {
    for (const status of TURN_STATUSES) {
      const line = frame({
        method: "turn/completed",
        params: { threadId: "t", turn: { id: "u", items: [], status } },
      });
      const { events, failure } = await collect({ lines: [line], exitCode: 0 });
      expect({ status, failure }).toEqual({ status, failure: null });
      expect({ status, toState: events[0]?.payload["toState"] }).toEqual({
        status,
        toState: "TURN_" + status.toUpperCase(),
      });
    }
  });

  it("refuses a turn status the schema does not define", async () => {
    const line = frame({
      method: "turn/completed",
      params: { threadId: "t", turn: { id: "u", items: [], status: "vanished" } },
    });
    const { failure } = await collect({ lines: [line], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("reports a bounded token count from the last turn, not the running total", async () => {
    const { events } = await collect({ lines: [TOKEN_USAGE], exitCode: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ tokensUsed: 120, stepIndex: 0 });
  });

  it("reports no measurement for an out-of-range token count", async () => {
    const line = frame({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t",
        tokenUsage: { last: { totalTokens: 10_000_001 }, total: { totalTokens: 10_000_001 } },
      },
    });
    const { events, failure } = await collect({ lines: [line], exitCode: 0 });
    // No measurement at all rather than a clamped one: a clamped number is
    // indistinguishable from a real one.
    expect({ failure, events: events.length }).toEqual({ failure: null, events: 0 });
  });

  it("classifies every error variant the schema defines", async () => {
    for (const variant of CODEX_ERROR_VARIANTS) {
      const asEnum = errorNotification(variant);
      const asObject = errorNotification({ [variant]: { httpStatusCode: 503 } });
      for (const line of [asEnum, asObject]) {
        const { events, failure } = await collect({ lines: [line], exitCode: 0 });
        expect({ variant, failure }).toEqual({ variant, failure: null });
        expect({ variant, toState: events[0]?.payload["toState"] }).toEqual({
          variant,
          toState: "ERROR_" + variant,
        });
      }
    }
  });

  it("marks a retryable error as retrying rather than as a failure", async () => {
    const { events, failure } = await collect({
      lines: [errorNotification("serverOverloaded", true)],
      exitCode: 0,
    });
    // The schema's own `willRetry` says this is not the end of anything, so a
    // session torn down here would be reporting a failure that did not happen.
    expect(failure).toBeNull();
    expect(events[0]?.name).toBe("provider.state");
    expect(events[0]?.payload["toState"]).toBe("ERROR_RETRYING_serverOverloaded");
  });

  it("refuses to forward an error variant the schema does not define", async () => {
    for (const info of ["inventedByAPeer", { two: 1, keys: 2 }, 17, null]) {
      const { events, failure } = await collect({ lines: [errorNotification(info)], exitCode: 0 });
      expect({ info: JSON.stringify(info), failure }).toEqual({ info: JSON.stringify(info), failure: null });
      expect(events[0]?.payload["toState"]).toBe("ERROR_unclassified");
    }
  });

  it("refuses an error notification that omits its retry disposition", async () => {
    const line = frame({
      method: "error",
      params: { threadId: "t", turnId: "u", error: { message: "boom" } },
    });
    const { failure } = await collect({ lines: [line], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("handles several frames arriving in one chunk", () => {
    const outcome = codexAdapter.parse(THREAD_STARTED + "\n" + TURN_STARTED + "\n", EMPTY_CURSOR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.events).toHaveLength(2);
    expect(outcome.cursor.recordIndex).toBe(2);
    expect(outcome.cursor.partial).toBe("");
  });

  it("carries a frame split across a chunk boundary", () => {
    const half = Math.floor(THREAD_STARTED.length / 2);
    const first = codexAdapter.parse(THREAD_STARTED.slice(0, half), EMPTY_CURSOR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.events).toHaveLength(0);
    const second = codexAdapter.parse(THREAD_STARTED.slice(half) + "\n", first.cursor);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.events).toHaveLength(1);
  });

  it("decodes a multibyte codepoint split across two chunks", async () => {
    const line = frame({
      method: "turn/completed",
      params: { threadId: "\u{1F300}\u{1F301}", turn: { id: "u", items: [], status: "completed" } },
    });
    const { events, failure } = await collect({ lines: [line], exitCode: 0 });
    expect({ failure, events: events.length }).toEqual({ failure: null, events: 1 });
  });

  it("leaves a truncated trailing frame unparsed", () => {
    const outcome = codexAdapter.parse(THREAD_STARTED.slice(0, 20), EMPTY_CURSOR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.events).toHaveLength(0);
    expect(outcome.cursor.partial).toBe(THREAD_STARTED.slice(0, 20));
  });

  it("refuses a method the schema does not define", async () => {
    const { failure } = await collect({
      lines: [frame({ jsonrpc: "2.0", method: "thread/invented", params: {} })],
      exitCode: 0,
    });
    expect(failure).toBe("UNKNOWN_EVENT");
  });

  it("refuses a method that names an inherited object member", () => {
    // An allowlist consulted with a bare index lookup can be walked off the
    // end of: `toString` and `constructor` exist on every object literal.
    for (const method of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      const outcome = codexAdapter.parse(frame({ id: 1, method, params: {} }) + "\n", EMPTY_CURSOR);
      expect({ method, ok: outcome.ok, code: outcome.ok ? null : outcome.code }).toEqual({
        method,
        ok: false,
        code: "UNKNOWN_EVENT",
      });
    }
  });

  it("refuses a malformed frame", async () => {
    for (const line of ['{"method":', "not json at all", "[]", '"a string"', "null"]) {
      const { failure } = await collect({ lines: [line], exitCode: 0 });
      expect({ line, failure }).toEqual({ line, failure: "MALFORMED_EVENT" });
    }
  });

  it("refuses a response carrying both result and error", async () => {
    const line = frame({ jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "x" } });
    const { failure } = await collect({ lines: [line], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("refuses a frame carrying neither a method nor a response body", async () => {
    const { failure } = await collect({ lines: [frame({ jsonrpc: "2.0", id: 1 })], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("refuses a response with no id", async () => {
    const { failure } = await collect({ lines: [frame({ jsonrpc: "2.0", result: {} })], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("refuses a well-formed response, because this phase issues no request", async () => {
    for (const line of [
      frame({ jsonrpc: "2.0", id: 1, result: { codexHome: "/tmp/x", userAgent: "codex" } }),
      frame({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unauthorized" } }),
    ]) {
      const { failure } = await collect({ lines: [line], exitCode: 0 });
      expect({ line, failure }).toEqual({ line, failure: "UNKNOWN_EVENT" });
    }
  });

  it("refuses a frame that is a method and a response at once", async () => {
    const line = frame({ jsonrpc: "2.0", id: 1, method: "turn/started", result: {} });
    const { failure } = await collect({ lines: [line], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("accepts a frame without a jsonrpc member, which the schema does not declare", () => {
    // The vendored schema declares no `jsonrpc` property on any of the four
    // envelope shapes, so requiring one would refuse frames the protocol's own
    // definition calls conforming.
    const outcome = codexAdapter.parse(
      frame({ method: "turn/started", params: { threadId: "t", turn: { id: "u", items: [], status: "inProgress" } } }) + "\n",
      EMPTY_CURSOR,
    );
    expect(outcome.ok).toBe(true);
  });

  it("refuses a frame naming a generation this parser does not read", async () => {
    const line = frame({ jsonrpc: "1.0", method: "turn/started", params: { threadId: "t" } });
    const { failure } = await collect({ lines: [line], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("refuses a length-prefixed header line rather than mis-reading it", async () => {
    // Not a claim about the wire: framing is UNKNOWN. This asserts only that a
    // non-JSON header line fails closed instead of being silently skipped.
    const { failure } = await collect({ lines: ["Content-Length: 42", THREAD_STARTED], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
  });

  it("survives an immediate death and a death mid-stream", async () => {
    const empty = await collect({ lines: [], exitCode: 0 });
    expect(empty.failure).toBeNull();
    expect(empty.events).toEqual([]);

    // A nonzero exit is the provider's business, not a parse failure: the
    // frames read before it stand, and nothing is invented to explain it.
    const partial = await collect({ lines: [THREAD_STARTED, TURN_STARTED], exitCode: 3 });
    expect(partial.failure).toBeNull();
    expect(partial.events.map((event) => event.name)).toEqual(["session.started", "provider.state"]);
  });

  it("is deterministic across repeated identical runs", () => {
    const bytes = [THREAD_STARTED, TURN_STARTED, TOKEN_USAGE, errorNotification("other"), TURN_COMPLETED].join("\n") + "\n";
    const first = JSON.stringify(codexAdapter.parse(bytes, EMPTY_CURSOR));
    for (let run = 0; run < 100; run += 1) {
      expect(JSON.stringify(codexAdapter.parse(bytes, EMPTY_CURSOR))).toBe(first);
    }
  });
});

describe("the reviewer guarantee holds for this provider", () => {
  it("refuses each write-authorizing request with autonomous teardown", async () => {
    for (const method of WRITE_AUTHORIZING) {
      const session = startSession(
        scripted({ lines: [THREAD_STARTED, approval(method)], exitCode: 0, lingerMs: 10_000 }),
        request(REVIEWER),
      );
      ownedPids.push(session.pid);
      try {
        for await (const event of session.events()) void event;
      } catch {
        // surfaced either way
      }
      await session.settled();
      expect({ method, state: session.state }).toEqual({ method, state: "FAILED" });
      expect({ method, error: session.health().classifiedError }).toEqual({
        method,
        error: "READ_ONLY_VIOLATION",
      });
      // Dead without this test calling close().
      expect({ method, dead: await waitDead(session.pid) }).toEqual({ method, dead: true });
      await session.close();
    }
  });

  it("tolerates every interaction request under a reviewer identity", async () => {
    for (const [method, reason] of Object.entries(INTERACTION_BY_REASON)) {
      const { events, failure } = await collect(
        { lines: [THREAD_STARTED, approval(method)], exitCode: 0 },
        REVIEWER,
      );
      // Asking a question is not changing something, and refusing it would
      // confuse the two.
      expect({ method, failure }).toEqual({ method, failure: null });
      const raised = events.filter((event) => event.name === "auth.required");
      expect({ method, reasons: raised.map((event) => event.payload["reason"]) }).toEqual({
        method,
        reasons: [reason],
      });
      expect({ method, frozen: raised[0]?.frozenType }).toEqual({ method, frozen: "AUTH_REQUIRED_RAISED" });
    }
  });

  it("holds a read-only allowlist over the whole claimed notification subset", async () => {
    const { failure } = await collect(
      { lines: [THREAD_STARTED, TURN_STARTED, TOKEN_USAGE, errorNotification("other"), TURN_COMPLETED], exitCode: 0 },
      REVIEWER,
    );
    expect(failure).toBeNull();
  });

  it("leaves an implementer unaffected by the same write-authorizing requests", async () => {
    for (const method of WRITE_AUTHORIZING) {
      const { events, failure } = await collect(
        { lines: [THREAD_STARTED, approval(method)], exitCode: 0 },
        IMPLEMENTER,
      );
      // Classified, tolerated, and reported as nothing: a write-class signal
      // has no normalized event, so it cannot become an observation.
      expect({ method, failure }).toEqual({ method, failure: null });
      expect({ method, names: events.map((event) => event.name) }).toEqual({
        method,
        names: ["session.started"],
      });
    }
  });

  it("answers no server request, because it has no channel to answer on", async () => {
    // The proof is structural, not a promise. The adapter's whole surface is
    // three pure functions; a fake that echoes a frame the moment any stdin
    // byte arrives would turn a written approval into an UNKNOWN_EVENT
    // failure, and no such failure occurs.
    const program = [
      "process.stdin.on('data', () => {",
      "  process.stdout.write(JSON.stringify({ method: 'stdin/received' }) + '\\n');",
      "});",
      "const lines = " + JSON.stringify([THREAD_STARTED, ...WRITE_AUTHORIZING.map((m) => approval(m))]) + ";",
      "for (const line of lines) process.stdout.write(line + '\\n');",
      "setTimeout(() => process.exit(0), 250);",
    ].join("\n");

    const { failure } = await drive(withArgv(Object.freeze(["-e", program])), IMPLEMENTER);
    expect(failure).toBeNull();
    expect(Object.keys(codexAdapter).sort()).toEqual(["describe", "negotiate", "parse", "provider"]);
  });
});

describe("nothing a request carries is allowed to travel", () => {
  const SECRETS = [
    "rm -rf /Users/someone/product",
    "/Users/someone/product/src/secret.ts",
    "--- a/secret.ts\n+++ b/secret.ts",
    "acct_0199_private",
    "Paste your API token here",
    "sk-not-a-real-key",
  ];

  const LOADED = [
    approval("execCommandApproval", {
      callId: "c1",
      conversationId: "v1",
      command: ["bash", "-lc", SECRETS[0] ?? ""],
      cwd: SECRETS[1] ?? "",
      parsedCmd: [{ type: "unknown", cmd: SECRETS[0] ?? "" }],
      reason: SECRETS[0] ?? "",
    }),
    approval("applyPatchApproval", {
      callId: "c2",
      conversationId: "v1",
      fileChanges: { [SECRETS[1] ?? ""]: { update: { unifiedDiff: SECRETS[2] ?? "" } } },
      grantRoot: SECRETS[1] ?? "",
    }),
    approval("account/chatgptAuthTokens/refresh", {
      previousAccountId: SECRETS[3] ?? "",
      reason: "expired",
    }),
    approval("item/tool/requestUserInput", { prompt: SECRETS[4] ?? "", callId: "c3" }),
    approval("item/tool/call", {
      callId: "c4",
      threadId: "t",
      turnId: "u",
      tool: "shell",
      arguments: { key: SECRETS[5] ?? "" },
    }),
  ];

  it("lets no command, path, patch, prompt or account identifier reach an event", async () => {
    const { events, failure } = await collect(
      { lines: [THREAD_STARTED, ...LOADED], exitCode: 0 },
      IMPLEMENTER,
    );
    expect(failure).toBeNull();
    const serialized = JSON.stringify(events);
    for (const secret of SECRETS) {
      expect({ secret, leaked: serialized.includes(secret) }).toEqual({ secret, leaked: false });
    }
    // And the one privacy vocabulary agrees.
    expect(hasPrivacyViolation(events)).toBe(false);
  });

  it("lets none of it reach a refusal detail either", async () => {
    // A malformed frame must not quote what it failed on.
    const malformed = '{"method":"execCommandApproval","params":{"command":["' + (SECRETS[0] ?? "") + '"';
    const { failure } = await collect({ lines: [malformed], exitCode: 0 });
    expect(failure).toBe("MALFORMED_EVENT");
    const error = new AdapterError("MALFORMED_EVENT", { provider: "codex", taskId: TASK });
    expect(error.message).toBe("MALFORMED_EVENT [codex " + TASK + "]");
    for (const secret of SECRETS) {
      expect({ secret, leaked: error.message.includes(secret) }).toEqual({ secret, leaked: false });
    }
  });

  it("lets no thread preview, working directory or on-disk path travel", async () => {
    const { events } = await collect({ lines: [THREAD_STARTED], exitCode: 0 });
    const serialized = JSON.stringify(events);
    for (const secret of ["the first user message", "/tmp/acp-drill", "0199-thread"]) {
      expect({ secret, leaked: serialized.includes(secret) }).toEqual({ secret, leaked: false });
    }
  });

  it("lets no error message travel, only its classified variant", async () => {
    const message = "upstream said: token sk-not-a-real-key was rejected";
    const { events } = await collect({
      lines: [errorNotification("unauthorized", false, message)],
      exitCode: 0,
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("sk-not-a-real-key");
    expect(serialized).not.toContain("upstream said");
    expect(events[0]?.payload["toState"]).toBe("ERROR_unauthorized");
  });
});

describe("cancellation uses the signal floor", () => {
  it("escalates when the peer ignores SIGINT, with no protocol cancel", async () => {
    const session = startSession(
      scripted({ lines: [THREAD_STARTED], exitCode: 0, ignoreSigint: true, lingerMs: 10_000 }),
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
    // PROTOCOL_CANCEL is UNKNOWN for Codex, so the ladder is signal-only.
    expect(record.viaProtocolCancel).toBe(false);
    await session.close();
  });
});

describe("every method the vendored schema defines is accounted for", () => {
  /**
   * The vendored App Server schema, or `null` on a machine without it.
   *
   * Absent evidence must not fail `pnpm check` — a clean checkout has no
   * `.acp-local/`. What it must not do is pass *silently*, so the absence is
   * reported rather than swallowed.
   *
   * Five levels up from this directory: codex → providers → test → adapters →
   * packages → the repository root.
   */
  const SCHEMA_DIR = resolve(HERE, "..", "..", "..", "..", "..", "..", ".acp-local", "p4d-codex-schema");

  /** Every method name a discriminated envelope file defines, or `null`. */
  function envelopeMethods(file: string): readonly string[] | null {
    const path = join(SCHEMA_DIR, file);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      readonly oneOf?: readonly { readonly properties?: { readonly method?: { readonly enum?: readonly string[] } } }[];
    };
    const branches = parsed.oneOf ?? [];
    const names = branches.map((branch) => branch.properties?.method?.enum?.[0] ?? "");
    // Nothing unresolved: a branch whose method is not a single-member enum
    // would silently shrink the inventory this proof rests on.
    expect({ file, unresolved: names.filter((name) => name === "").length }).toEqual({
      file,
      unresolved: 0,
    });
    return names;
  }

  function definitionsOf(file: string): Record<string, unknown> | null {
    const path = join(SCHEMA_DIR, file);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      readonly definitions?: Record<string, unknown>;
    };
    return parsed.definitions ?? {};
  }

  /** Recorded rather than silent, so an absent tree still says why it passed. */
  function absent(): void {
    expect({ evidence: "absent", dir: SCHEMA_DIR.endsWith("p4d-codex-schema") }).toEqual({
      evidence: "absent",
      dir: true,
    });
  }

  it("pins the inventory the claim is measured against", () => {
    const serverRequest = envelopeMethods("ServerRequest.json");
    if (serverRequest === null) {
      absent();
      return;
    }
    const serverNotification = envelopeMethods("ServerNotification.json") ?? [];
    const clientRequest = envelopeMethods("ClientRequest.json") ?? [];
    const clientNotification = envelopeMethods("ClientNotification.json") ?? [];

    // A regeneration that changes the surface fails here, mechanically, rather
    // than leaving a stale claim standing.
    expect({
      serverRequest: serverRequest.length,
      serverNotification: serverNotification.length,
      clientRequest: clientRequest.length,
      clientNotification: clientNotification.length,
    }).toEqual({
      serverRequest: 10,
      serverNotification: 75,
      clientRequest: 95,
      clientNotification: 1,
    });

    const all = [...serverRequest, ...serverNotification, ...clientRequest, ...clientNotification];
    expect(new Set(all).size).toBe(181);
  });

  it("classifies every server request, with the write and interaction split exact", () => {
    const serverRequest = envelopeMethods("ServerRequest.json");
    if (serverRequest === null) {
      absent();
      return;
    }

    const claimed = [...WRITE_AUTHORIZING, ...Object.keys(INTERACTION_BY_REASON)].sort();
    // Equality in both directions: a method the schema adds fails here, and so
    // does an entry of ours the schema does not define.
    expect([...serverRequest].sort()).toEqual(claimed);
    expect(new Set(claimed).size).toBe(claimed.length);

    for (const method of serverRequest) {
      const outcome = codexAdapter.parse(approval(method) + "\n", EMPTY_CURSOR);
      // Recognized, not merely listed. Which side of the split it lands on is
      // asserted by the reviewer tests above.
      expect({ method, ok: outcome.ok }).toEqual({ method, ok: true });
    }
  });

  it("claims exactly five notifications and refuses the other seventy", () => {
    const serverNotification = envelopeMethods("ServerNotification.json");
    if (serverNotification === null) {
      absent();
      return;
    }

    // The claim is a subset of what the schema defines, with nothing invented.
    expect(CLAIMED_NOTIFICATIONS.filter((method) => serverNotification.includes(method))).toEqual(
      CLAIMED_NOTIFICATIONS,
    );

    const unclaimed = serverNotification.filter((method) => !CLAIMED_NOTIFICATIONS.includes(method));
    expect(unclaimed).toHaveLength(70);
    for (const method of unclaimed) {
      const outcome = codexAdapter.parse(frame({ method, params: {} }) + "\n", EMPTY_CURSOR);
      expect({ method, ok: outcome.ok, code: outcome.ok ? null : outcome.code }).toEqual({
        method,
        ok: false,
        code: "UNKNOWN_EVENT",
      });
    }
  });

  it("refuses every client-to-agent method arriving inbound", () => {
    const clientRequest = envelopeMethods("ClientRequest.json");
    if (clientRequest === null) {
      absent();
      return;
    }
    const clientNotification = envelopeMethods("ClientNotification.json") ?? [];

    for (const method of [...clientRequest, ...clientNotification]) {
      const outcome = codexAdapter.parse(frame({ id: 1, method, params: {} }) + "\n", EMPTY_CURSOR);
      expect({ method, ok: outcome.ok, code: outcome.ok ? null : outcome.code }).toEqual({
        method,
        ok: false,
        code: "UNKNOWN_EVENT",
      });
    }
  });

  it("pins the closed enums the parser validates against", () => {
    const definitions = definitionsOf("ServerNotification.json");
    if (definitions === null) {
      absent();
      return;
    }

    const turnStatus = definitions["TurnStatus"] as { readonly enum?: readonly string[] };
    expect([...(turnStatus.enum ?? [])].sort()).toEqual([...TURN_STATUSES].sort());

    const errorInfo = definitions["CodexErrorInfo"] as {
      readonly oneOf?: readonly {
        readonly enum?: readonly string[];
        readonly properties?: Record<string, unknown>;
      }[];
    };
    const variants: string[] = [];
    for (const branch of errorInfo.oneOf ?? []) {
      if (branch.enum !== undefined) variants.push(...branch.enum);
      else if (branch.properties !== undefined) variants.push(...Object.keys(branch.properties));
    }
    expect(variants.sort()).toEqual([...CODEX_ERROR_VARIANTS].sort());
  });
});

describe("the provider module keeps the boundary's laws", () => {
  const source = readFileSync(join(PROVIDER_SRC, "index.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("imports no session module, process module or child_process", () => {
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

  it("names no ledger, reads no ambient environment and opens no channel", () => {
    expect(code).not.toContain(["@acp", "ledger"].join("/"));
    expect(code).not.toContain("process.env");
    expect(code).not.toContain("stdin");
  });

  it("names no product path or session tool", () => {
    for (const token of [["Modern", "Rescue"].join(" "), ["ui-design", "system"].join("-"), ["tm", "ux"].join("")]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("claims no capability, and never authenticates", () => {
    expect(code).not.toContain("CONFIRMED");
    expect(code).not.toContain("login");
    const outcome = codexAdapter.negotiate({});
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

  it("records the framing as UNKNOWN and claims no live conformance", () => {
    expect(CODEX_PROTOCOL_RECORD["FRAMING"]).toBe("UNKNOWN");
    expect(CODEX_PROTOCOL_RECORD["EXPERIMENTAL_API_TIER"]).toBe("UNKNOWN");
    expect(CODEX_PROTOCOL_RECORD["INITIALIZE_SHAPE"]).toBe("v1");
    expect(CODEX_PROTOCOL_RECORD["CLI_VERSION_OBSERVED"]).toBe("codex-cli 0.149.0");
    expect(CODEX_PROTOCOL_RECORD["SCHEMA_MANIFEST_DIGEST"]).toBe(
      "3c5da19ed58df2804ad92fc23051bc5ef55bdcc9c2fa06eec73dd33fb3422f08",
    );
    expect(Object.isFrozen(CODEX_PROTOCOL_RECORD)).toBe(true);
  });

  it("is an isolated adapter-contract test of negotiate(), not a lifecycle claim", () => {
    // Stated plainly because it would otherwise be easy to over-read: nothing
    // in `session/index.ts` calls `negotiate()`, so no production lifecycle
    // path reaches it. This asserts the pure function's contract and supports
    // no claim about session-level handshake or negotiation behaviour.
    const controller = readFileSync(join(PACKAGE_ROOT, "src", "session", "index.ts"), "utf8");
    expect(controller).not.toContain("negotiate(");

    const outcome = codexAdapter.negotiate({ anything: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.protocolVersion).toBe(CODEX_APP_SERVER_PROTOCOL);
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
