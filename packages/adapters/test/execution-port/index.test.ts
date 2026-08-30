import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_SUBSCRIPTION_PROVIDERS, ExecutionEvent } from "@acp/contracts";
import type { ExecutionRequest, ModelExecutionPort, ResolvedRoute } from "@acp/contracts";
import { afterAll, describe, expect, it } from "vitest";

import type {
  AdmittedBinary,
  AdmittedConfigRoot,
  AdmittedWorkdir,
  ProviderAdapter,
  ProviderName,
  SessionLimits,
} from "../../src/contract/index.js";
import type { CliBinding } from "../../src/execution-port/index.js";
import { cliSessionId, createCliExecutionPort } from "../../src/execution-port/index.js";
import { CLAUDE_STREAM_PROTOCOL, claudeAdapter } from "../../src/providers/claude/index.js";
import { CODEX_APP_SERVER_PROTOCOL, codexAdapter } from "../../src/providers/codex/index.js";
import { KIMI_ACP_PROTOCOL, kimiAdapter } from "../../src/providers/kimi/index.js";
import { scriptedAdapter } from "../testing/index.js";
import type { FakeScript } from "../testing/index.js";

/**
 * The shared conformance fixture for the owned execution boundary.
 *
 * One logical scenario — a session starts, reports what a unit of work cost,
 * reaches a terminal provider state, and closes — is run through the port
 * three times, bound once by each landed CLI adapter. The adapters are the
 * shipped ones; only the child process is scripted, so what is under test is
 * three real parsers and one normalization, not three fakes agreeing with each
 * other.
 *
 * The fixture is built to be reused by P8-3's API transport: the scenario is
 * the **intersection** of what both transports can express. `text` and
 * `toolUse` are API-only kinds and are deliberately absent; the CLI-only facts
 * are drilled separately below.
 */

const TMP_ROOT = realpathSync(tmpdir());
const NODE = realpathSync(process.execPath) as AdmittedBinary;
const IDENTITY = "anthropic/claude-opus-5/implementer/01";
const REVIEWER = "anthropic/claude-fable/reviewer/01";
const TASK = "00000000-0000-4000-8000-0000000008a2";
const AT = "2026-08-30T15:00:00.000Z";
const TOKENS = 1_234;
/** The one terminal token all three providers can be scripted to report. */
const TERMINAL_STATE = "TURN_COMPLETED";

const created: string[] = [];

afterAll(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function drillRoot(): string {
  const path = join(TMP_ROOT, "acp-p82-port-" + randomUUID());
  mkdirSync(path, { recursive: true, mode: 0o700 });
  created.push(path);
  return path;
}

function limits(): SessionLimits {
  return { timeoutMs: 5_000, outputBudgetBytes: 64 * 1024, interruptGraceMs: 120, termGraceMs: 120 };
}

function binding(adapter: ProviderAdapter, lines: readonly string[]): CliBinding {
  const root = drillRoot();
  const script: FakeScript = { lines, exitCode: 0 };
  return {
    adapter: scriptedAdapter(adapter, script),
    binary: NODE,
    configRoot: root as AdmittedConfigRoot,
    workdir: root as AdmittedWorkdir,
    limits: limits(),
  };
}

function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    provider: "claude",
    model: "opus",
    accountId: "acct-primary",
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "p8-2",
    resolvedAt: AT,
    ...overrides,
  };
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return { taskId: TASK, attempt: 1, identity: IDENTITY, reattach: null, ...overrides };
}

function portFor(bindings: Readonly<Record<string, CliBinding>>): ModelExecutionPort {
  return createCliExecutionPort({ bindings: new Map(Object.entries(bindings)) });
}

async function drain(
  port: ModelExecutionPort,
  routeValue: ResolvedRoute,
  requestValue: ExecutionRequest = request(),
): Promise<readonly ExecutionEvent[]> {
  const started = await port.start(routeValue, requestValue);
  if (!started.ok) throw new Error("expected a session, got " + started.refusal + " at " + started.at);
  const events: ExecutionEvent[] = [];
  for await (const event of started.events()) events.push(event);
  return events;
}

// ---------------------------------------------------------------------------
// One scenario, three wire protocols
// ---------------------------------------------------------------------------

/** Claude headless stream JSON: `started`, a usage-bearing turn, a result. */
const CLAUDE_LINES: readonly string[] = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-20260115" }),
  JSON.stringify({ type: "assistant", message: { usage: { output_tokens: TOKENS } } }),
  JSON.stringify({ type: "result", subtype: "turn_completed" }),
];

/** Kimi ACP v1 NDJSON: the initialize result, an update carrying usage, a stop. */
const KIMI_LINES: readonly string[] = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentName: "kimi-k2-0711" } }),
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", _meta: { tokensUsed: TOKENS } } },
  }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "turn_completed" } }),
];

/** Codex App Server JSON-RPC notifications: thread start, token usage, turn end. */
const CODEX_LINES: readonly string[] = [
  JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thread-p82" } } }),
  JSON.stringify({
    jsonrpc: "2.0",
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread-p82", tokenUsage: { last: { totalTokens: TOKENS } } },
  }),
  JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: "thread-p82", turn: { status: "completed" } },
  }),
];

const SCENARIO: Readonly<Record<ProviderName, readonly string[]>> = {
  claude: CLAUDE_LINES,
  codex: CODEX_LINES,
  kimi: KIMI_LINES,
};

const ADAPTER: Readonly<Record<ProviderName, ProviderAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
};

/** What each provider's handshake actually names. Provider identity, not drift. */
const PROTOCOL: Readonly<Record<ProviderName, string>> = {
  claude: CLAUDE_STREAM_PROTOCOL,
  codex: CODEX_APP_SERVER_PROTOCOL,
  kimi: KIMI_ACP_PROTOCOL,
};

async function trailFor(provider: ProviderName): Promise<readonly ExecutionEvent[]> {
  const port = portFor({ "acct-primary": binding(ADAPTER[provider], SCENARIO[provider]) });
  return drain(port, route({ provider }));
}

describe("one scenario normalizes identically across the three CLI adapters", () => {
  it("produces the same kinds in the same order from three different wire protocols", async () => {
    const trails = new Map<ProviderName, readonly ExecutionEvent[]>();
    for (const provider of CLI_SUBSCRIPTION_PROVIDERS) {
      trails.set(provider, await trailFor(provider));
    }

    const expected = ["started", "usage", "state", "completed"];
    for (const [provider, trail] of trails) {
      expect({ provider, kinds: trail.map((event) => event.kind) }).toEqual({ provider, kinds: expected });
    }

    // Every event the boundary emitted is a valid `ExecutionEvent`. The port
    // parses before it yields, so this re-check is cheap; it is here because a
    // conformance fixture that never validated the contract would pass just as
    // happily against a port that emitted nonsense of a consistent shape.
    for (const [provider, trail] of trails) {
      for (const event of trail) {
        expect({ provider, ok: ExecutionEvent.safeParse(event).success }).toEqual({ provider, ok: true });
      }
    }
  });

  it("carries the transport-neutral facts identically", async () => {
    for (const provider of CLI_SUBSCRIPTION_PROVIDERS) {
      const trail = await trailFor(provider);
      const usage = trail.find((event) => event.kind === "usage");
      const state = trail.find((event) => event.kind === "state");
      const started = trail.find((event) => event.kind === "started");

      // The measurement and the terminal token are the same fact whichever
      // protocol reported them, and the route is echoed back unchanged: the
      // port carries the caller's route, it does not restate its own idea of it.
      expect({
        provider,
        tokensUsed: usage?.kind === "usage" ? usage.tokensUsed : null,
        toState: state?.kind === "state" ? state.toState : null,
        route: started?.kind === "started" ? started.route : null,
      }).toEqual({
        provider,
        tokensUsed: TOKENS,
        toState: TERMINAL_STATE,
        route: route({ provider }),
      });
    }
  });

  it("differs only where the contract says a provider may differ", async () => {
    const identity: Record<string, unknown> = {};
    for (const provider of CLI_SUBSCRIPTION_PROVIDERS) {
      const trail = await trailFor(provider);
      const started = trail.find((event) => event.kind === "started");
      identity[provider] =
        started?.kind === "started"
          ? { resolvedModel: started.resolvedModel, protocolVersion: started.protocolVersion }
          : null;
    }

    // `protocolVersion` is the provider's own handshake generation, and
    // `resolvedModel` is what the provider says it bound. Codex reports
    // `unreported` structurally: its thread record names a vendor, not a
    // model, and the landed adapter refuses to pass one off as the other.
    // Both fields are provider identity — the contract expects them to differ
    // — and neither is rewritten to match the route.
    expect(identity).toEqual({
      claude: { resolvedModel: "claude-opus-5-20260115", protocolVersion: PROTOCOL.claude },
      codex: { resolvedModel: "unreported", protocolVersion: PROTOCOL.codex },
      kimi: { resolvedModel: "kimi-k2-0711", protocolVersion: PROTOCOL.kimi },
    });
  });

  it("pins the one transport-neutral field the three adapters do NOT agree on", async () => {
    const indices: Record<string, unknown> = {};
    for (const provider of CLI_SUBSCRIPTION_PROVIDERS) {
      const trail = await trailFor(provider);
      const usage = trail.find((event) => event.kind === "usage");
      const completed = trail.find((event) => event.kind === "completed");
      indices[provider] = {
        usage: usage?.kind === "usage" ? usage.stepIndex : null,
        completed: completed?.kind === "completed" ? completed.stepIndex : null,
      };
    }

    // A finding, pinned rather than smoothed over. The contract says usage
    // carries step ordering "so usage can be folded in the order it happened",
    // but only Claude reports an ordinal at all: its `stepIndex` is the record's
    // position in the stream, while Kimi and Codex hardcode zero — Codex
    // deliberately, since the App Server numbers turns by id and inventing an
    // ordinal would be reporting something the protocol never said.
    //
    // So a fold over CLI usage cannot order Kimi or Codex steps today. The
    // port does not paper over it: it carries what each adapter reported, and
    // `completed.stepIndex` inherits the same value because it is defined as
    // the last step the transport reported. This assertion exists to fail
    // loudly the day that changes.
    expect(indices).toEqual({
      claude: { usage: 1, completed: 1 },
      codex: { usage: 0, completed: 0 },
      kimi: { usage: 0, completed: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// The refusal drills
// ---------------------------------------------------------------------------

describe("the port refuses rather than falls back", () => {
  it("refuses a non-CLI route, and never downgrades it", async () => {
    const port = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });
    for (const transportKind of ["API_KEY", "LOCAL_OR_SELF_HOSTED"] as const) {
      const outcome = await port.start(route({ transportKind }), request());
      expect({ transportKind, outcome }).toEqual({
        transportKind,
        outcome: { ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.transportKind" },
      });
    }
  });

  it("refuses a reattach it cannot honor instead of starting fresh", async () => {
    const port = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });
    const outcome = await port.start(route(), request({ reattach: "execution-from-yesterday" }));
    expect(outcome).toEqual({ ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" });
  });

  it("refuses an account it holds no binding for", async () => {
    const port = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });
    const outcome = await port.start(route({ accountId: "acct-someone-else" }), request());
    expect(outcome).toEqual({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" });
  });

  it("refuses a route whose provider is not the one the account is bound to", async () => {
    const port = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });
    const outcome = await port.start(route({ provider: "kimi" }), request());
    expect(outcome).toEqual({ ok: false, refusal: "ROUTE_INVALID", at: "route.provider" });
  });

  it("refuses a malformed route and a malformed request, naming the field", async () => {
    const port = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });
    // A CLI route naming a provider outside the vocabulary: the contract's own
    // refinement, surfaced as a refusal rather than a thrown parse error.
    const badProvider = await port.start(route({ provider: "acme" }), request());
    expect(badProvider).toEqual({ ok: false, refusal: "ROUTE_INVALID", at: "route.provider" });

    const badRequest = await port.start(route(), { ...request(), attempt: 0 });
    expect(badRequest).toEqual({ ok: false, refusal: "ROUTE_INVALID", at: "request.attempt" });
  });
});

// ---------------------------------------------------------------------------
// C3: verbatim surfacing
// ---------------------------------------------------------------------------

describe("the port surfaces what the provider resolved, verbatim", () => {
  it("shows a different model byte-for-byte instead of rewriting it to the route", async () => {
    const other = "claude-sonnet-5-20260115";
    const port = portFor({
      "acct-primary": binding(claudeAdapter, [
        JSON.stringify({ type: "system", subtype: "init", model: other }),
        JSON.stringify({ type: "result", subtype: "turn_completed" }),
      ]),
    });

    const trail = await drain(port, route({ model: "opus" }));
    const started = trail.find((event) => event.kind === "started");
    if (started?.kind !== "started") throw new Error("expected a started event");

    // The route asked for `opus`; the provider bound something else. Both
    // travel, unmodified and side by side. Whether that resolution *corresponds*
    // to the alias is a question only the capability registry can answer, and
    // the registry is P8-5's: adjudicating it here would be inventing a law,
    // not asserting one. The evidence is preserved so P8-5 can judge it.
    expect({ asked: started.route.model, got: started.resolvedModel }).toEqual({
      asked: "opus",
      got: other,
    });
  });
});

// ---------------------------------------------------------------------------
// The CLI-only facts, drilled apart from the shared scenario
// ---------------------------------------------------------------------------

describe("what this transport can and cannot say", () => {
  it("synthesizes exactly one completed on a clean close, carrying the last step", async () => {
    const port = portFor({
      "acct-primary": binding(claudeAdapter, [
        JSON.stringify({ type: "system", subtype: "init", model: "m" }),
        JSON.stringify({ type: "assistant", message: { usage: { output_tokens: 10 } } }),
        JSON.stringify({ type: "assistant", message: { usage: { output_tokens: 20 } } }),
      ]),
    });
    const trail = await drain(port, route());
    const completions = trail.filter((event) => event.kind === "completed");

    expect(completions.length).toBe(1);
    // The last step the transport reported: the second usage record sits at
    // stream position 2, and `completed` carries it so usage can be reconciled
    // against the count of steps that actually happened.
    expect(completions[0]).toEqual({ kind: "completed", stepIndex: 2 });
    expect(trail.some((event) => event.kind === "error")).toBe(false);
  });

  it("emits no write event, because the CLI adapters never hand it one", async () => {
    const port = portFor({
      "acct-primary": binding(claudeAdapter, [
        JSON.stringify({ type: "system", subtype: "init", model: "m" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Edit" }], usage: { output_tokens: 7 } },
        }),
        JSON.stringify({ type: "result", subtype: "turn_completed" }),
      ]),
    });

    const trail = await drain(port, route());
    // A gap, named rather than hidden. The landed normalization maps a
    // write-class signal to nothing — `toNormalized` returns null for it — so
    // no `write` ever reaches this boundary for a writer identity. The
    // contract's `write` kind is reachable by other transports; on this one it
    // is unreported, and the enforcement plane must not rely on seeing it here.
    expect(trail.some((event) => event.kind === "write")).toBe(false);
    // The rest of the trail is unaffected: the measurement on the same record
    // still arrives.
    expect(trail.map((event) => event.kind)).toEqual(["started", "usage", "state", "completed"]);
  });

  it("ends in a classified error, not a completed, when the session fails", async () => {
    // The same write, under a reviewer identity: the session kills the child
    // and fails. This is where the write guarantee actually lives on this
    // transport, and the port reports it as an error rather than a clean close.
    const port = portFor({
      "acct-primary": binding(claudeAdapter, [
        JSON.stringify({ type: "system", subtype: "init", model: "m" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }),
      ]),
    });

    const trail = await drain(port, route(), request({ identity: REVIEWER }));
    const last = trail.at(-1);
    expect(last?.kind).toBe("error");
    if (last?.kind !== "error") throw new Error("expected an error event");
    expect(last.refusal).toBe("TRANSPORT_UNAVAILABLE");
    expect(last.detail).toContain("READ_ONLY_VIOLATION");
    expect(trail.some((event) => event.kind === "completed")).toBe(false);
  });

  it("names an execution from durable coordinates, never from a clock", async () => {
    const port = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });
    const first = await port.start(route(), request());
    if (!first.ok) throw new Error("expected a session");
    for await (const _event of first.events()) void _event;

    const second = await port.start(route(), request());
    if (!second.ok) throw new Error("expected a session");
    for await (const _event of second.events()) void _event;

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.sessionId).toBe(cliSessionId(TASK, 1, "acct-primary"));
  });

  it("interrupts only sessions it holds, and is idempotent about it", async () => {
    const port = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });
    // A session it never started: a no-op, not a throw and not a signal sent
    // to whatever else might answer to that name.
    await expect(port.interrupt("00000000-0000-4000-8000-00000000ffff/1/acct-x")).resolves.toBeUndefined();
    await expect(port.interrupt("00000000-0000-4000-8000-00000000ffff/1/acct-x")).resolves.toBeUndefined();
  });

  it("probes read-only: UNKNOWN with a binding, FAILED without one", async () => {
    const port = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });

    expect(await port.healthProbe(route())).toEqual({
      status: "UNKNOWN",
      checkedAt: AT,
      latencyMs: null,
      classifiedError: null,
    });
    expect(await port.healthProbe(route({ accountId: "acct-none" }))).toEqual({
      status: "FAILED",
      checkedAt: AT,
      latencyMs: null,
      classifiedError: "TRANSPORT_UNAVAILABLE",
    });
    expect(await port.healthProbe(route({ transportKind: "API_KEY" }))).toEqual({
      status: "FAILED",
      checkedAt: AT,
      latencyMs: null,
      classifiedError: "TRANSPORT_UNAVAILABLE",
    });
  });
});
