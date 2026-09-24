import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_SUBSCRIPTION_PROVIDERS, ExecutionEvent, PROVIDER_PRESSURES } from "@acp/contracts";
import type { ExecutionOutputSink, ExecutionRequest, ModelExecutionPort, ResolvedRoute } from "@acp/contracts";
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
import {
  createExecutionPort,
  executionSessionId,
  toExecutionEvent,
} from "../../src/execution-port/index.js";
import { normalizedEvent } from "../../src/events/index.js";
import type { ApiKeyBinding, ApiStreamChunk, ApiStreamRequest } from "../../src/api-key/index.js";
import { CLAUDE_STREAM_PROTOCOL, claudeAdapter } from "../../src/claude/index.js";
import { CODEX_APP_SERVER_PROTOCOL, codexAdapter } from "../../src/codex/index.js";
import { KIMI_ACP_PROTOCOL, kimiAdapter } from "../../src/kimi/index.js";
import type { LocalBinding, LocalChatChunk, LocalChatRequest } from "../../src/local/index.js";
import type { AgentHarness } from "../../src/harness/index.js";
import { createAgentHarness } from "../../src/harness/index.js";
import { createAnthropicMessagesClient } from "../../src/api-key/http/index.js";
import { createLocalChatClient } from "../../src/local/http/index.js";
import {
  bytesResponse,
  fakeAdapter,
  fakeApiClient,
  fakeLocalClient,
  fetchSubstitute,
  scriptedAdapter,
  splitBytes,
  synLocalStream,
  synMessagesStream,
  syntheticCanary,
} from "../testing/index.js";
import { CAPTURED_2_1_281_SUCCESS, CAPTURED_AUTH_FAILURE, CAPTURED_SUCCESS } from "../testing/claude-capture/index.js";
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

/**
 * One usage report in the port's own fields (P-15/D2, ADR 0105): the total the test
 * names, the class split unknown, as an API or local leg reports it.
 */
function usageReport(stepIndex: number, total: number): Extract<ExecutionEvent, { kind: "usage" }> {
  return {
    kind: "usage",
    stepIndex,
    inputTokens: null,
    outputTokens: null,
    cacheWriteTokens: null,
    cacheReadTokens: null,
    totalTokens: total,
    reportKind: "CUMULATIVE",
    isFinal: true,
    sourceObservationId: "obs-" + String(stepIndex),
  };
}
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
  return {
    taskId: TASK,
    attempt: 1,
    identity: IDENTITY,
    instructions: "summarise the packet",
    modalities: ["text"],
    reattach: null,
    ...overrides,
  };
}

function portFor(
  bindings: Readonly<Record<string, CliBinding>>,
  apiBindings?: Readonly<Record<string, ApiKeyBinding>>,
  localBindings?: Readonly<Record<string, LocalBinding>>,
): ModelExecutionPort {
  return createExecutionPort({
    bindings: new Map(Object.entries(bindings)),
    // Absent, not empty: a port constructed without this does not have the API
    // (or local) transport at all, which is what the law-6 drill turns on.
    ...(apiBindings === undefined ? {} : { apiBindings: new Map(Object.entries(apiBindings)) }),
    ...(localBindings === undefined ? {} : { localBindings: new Map(Object.entries(localBindings)) }),
  });
}

async function drain(
  port: ModelExecutionPort,
  routeValue: ResolvedRoute,
  requestValue: ExecutionRequest = request(),
  sink?: ExecutionOutputSink,
): Promise<readonly ExecutionEvent[]> {
  const started = await port.start(routeValue, requestValue, sink);
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
  JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-20260115", claude_code_version: "2.1.280" }),
  JSON.stringify({ type: "assistant", message: { id: "msg-1", usage: { output_tokens: TOKENS } } }),
  // The session's one usage report is the result's (P-15/D2): the assistant record's
  // usage above is not read.
  JSON.stringify({
    type: "result",
    subtype: "turn_completed",
    session_id: "session-p15d2",
    usage: { input_tokens: 0, output_tokens: TOKENS, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }),
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

/**
 * The one trail assertion, shared by every transport leg. (N1, binding.)
 *
 * Written once and called from each leg rather than restated per transport,
 * because the acceptance criterion is that the legs produce *the same*
 * normalized contract — and two copies of an assertion are two assertions that
 * can drift, with the weaker one quietly becoming the standard the newest
 * transport is held to.
 *
 * What it fixes is the transport intersection: the kinds and their order, the
 * validity of every event, the measurement, the terminal token, and the route
 * echoed back unchanged. What it deliberately leaves alone is provider
 * identity — `resolvedModel` and `protocolVersion` — which the contract expects
 * to differ, and `stepIndex`, which the CLI adapters do not agree on (pinned
 * separately below).
 */
const SHARED_KINDS = ["started", "usage", "state", "completed"];

/** The two per-transport facts of P-07 escalón C, which the shared projection sets aside. */
const PER_LEG_KINDS: readonly string[] = ["processExited", "operationResult"];

/** A trail without the per-transport facts: the transport intersection. */
function shared(trail: readonly ExecutionEvent[]): readonly ExecutionEvent[] {
  return trail.filter((event) => !PER_LEG_KINDS.includes(event.kind));
}

function assertSharedTrail(leg: string, trail: readonly ExecutionEvent[], expected: ResolvedRoute): void {
  expect({ leg, kinds: shared(trail).map((event) => event.kind) }).toEqual({ leg, kinds: SHARED_KINDS });
  // The process fact, per leg (P-07 escalón C, ADR 0099): a CLI child that exited
  // cleanly reports exit 0 directly before `completed`; an API or local leg owns
  // no process and reports none. None of these synthetic scripts says what the
  // operation decided, so no leg reports `operationResult`.
  const processFacts = trail.filter((event) => event.kind === "processExited");
  if (leg.startsWith("cli")) {
    expect({ leg, processFacts }).toEqual({ leg, processFacts: [{ kind: "processExited", exitCode: 0, signal: null }] });
    expect({ leg, beforeTerminal: trail.at(-2)?.kind }).toEqual({ leg, beforeTerminal: "processExited" });
  } else {
    expect({ leg, processFacts }).toEqual({ leg, processFacts: [] });
  }
  expect({ leg, operation: trail.some((event) => event.kind === "operationResult") }).toEqual({ leg, operation: false });

  // Every event the boundary emitted is a valid `ExecutionEvent`. The port
  // parses before it yields, so this re-check is cheap; it is here because a
  // conformance fixture that never validated the contract would pass just as
  // happily against a port that emitted nonsense of a consistent shape.
  for (const event of trail) {
    expect({ leg, kind: event.kind, ok: ExecutionEvent.safeParse(event).success }).toEqual({
      leg,
      kind: event.kind,
      ok: true,
    });
  }

  const usage = trail.find((event) => event.kind === "usage");
  const state = trail.find((event) => event.kind === "state");
  const started = trail.find((event) => event.kind === "started");

  // The measurement and the terminal token are the same fact whichever
  // transport reported them, and the route is echoed back unchanged: the port
  // carries the caller's route, it does not restate its own idea of it.
  expect({
    leg,
    totalTokens: usage?.kind === "usage" ? usage.totalTokens : null,
    toState: state?.kind === "state" ? state.toState : null,
    route: started?.kind === "started" ? started.route : null,
  }).toEqual({ leg, totalTokens: TOKENS, toState: TERMINAL_STATE, route: expected });
}

describe("one scenario normalizes identically across the CLI adapters that take an instruction", () => {
  /**
   * V2-B1c changed what this describe can honestly claim.
   *
   * Every execution now carries an instruction, and only Claude's transport can
   * take one: Codex pins an unknown framing and never sends `initialize`, and
   * Kimi's prompt frame needs a `sessionId` the server has not yet returned. So
   * driving all three through the port no longer produces three trails — it
   * produces one trail and two **classified pre-spawn refusals**, which is what
   * these tests now assert.
   *
   * The three-way parser normalization claim did not disappear; it moved to
   * where it can still be made truthfully. Each adapter's unit suite drives its
   * own parser against a fake subject, so the wire-protocol normalization is
   * still proved per transport — just not through a port that must first decide
   * whether the transport may be spoken to at all.
   */
  it("produces one normalized trail from the transport that can be instructed", async () => {
    assertSharedTrail("cli/claude", await trailFor("claude"), route({ provider: "claude" }));
  });

  it("P5 surfaces the other two as classified transport refusals, not as silent successes", async () => {
    // Not a spawn, and not a success with nothing delivered. The port maps the
    // pre-spawn throw to `TRANSPORT_UNAVAILABLE` and names where it came from,
    // so a caller can tell "this transport will not take an instruction" from
    // "the model failed".
    // The CLI transport set did not shrink; what shrank is how many of them can
    // be handed an instruction. Stated here so the narrowing above reads as a
    // fact about delivery rather than as a provider quietly disappearing.
    expect([...CLI_SUBSCRIPTION_PROVIDERS].sort()).toEqual(["claude", "codex", "kimi"]);

    for (const provider of ["codex", "kimi"] as const) {
      const port = portFor({ "acct-primary": binding(ADAPTER[provider], SCENARIO[provider]) });
      const outcome = await port.start(route({ provider }), request());
      expect({ provider, outcome }).toEqual({
        provider,
        outcome: {
          ok: false,
          refusal: "TRANSPORT_UNAVAILABLE",
          at: "startSession/PROTOCOL_UNSUPPORTED",
        },
      });
    }
  });

  it("differs only where the contract says a provider may differ", async () => {
    const trail = await trailFor("claude");
    const started = trail.find((event) => event.kind === "started");
    const identity =
      started?.kind === "started"
        ? { resolvedModel: started.resolvedModel, protocolVersion: started.protocolVersion }
        : null;

    // `protocolVersion` is the provider's own handshake generation, and
    // `resolvedModel` is what the provider says it bound. Neither is rewritten
    // to match the route. Codex's structural `unreported` and Kimi's own model
    // string are asserted in their adapter suites, which is the only place they
    // can be reached now that the port refuses those transports.
    expect(identity).toEqual({
      resolvedModel: "claude-opus-5-20260115",
      protocolVersion: PROTOCOL.claude,
    });
  });

  it("pins the one transport-neutral field the adapters do NOT agree on", async () => {
    const indices: Record<string, unknown> = {};
    for (const provider of ["claude"] as const) {
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
    // Codex and Kimi are no longer reachable through the port (V2-B1c), so
    // their hardcoded zeros are asserted in their own adapter suites now. What
    // remains here is Claude's ordinal, which is the only one the port can
    // still observe -- and the finding above is unchanged: only Claude reports
    // an ordinal at all.
    expect(indices).toEqual({ claude: { usage: 1, completed: 1 } });
  });
});

// ---------------------------------------------------------------------------
// The API_KEY leg: the other half of the dual-transport acceptance bullet
// ---------------------------------------------------------------------------

const API_ACCOUNT = "acct-api";
const API_PROVIDER = "openai";
const API_MODEL = "gpt-5-2026-04";
const API_PROTOCOL = "api/streaming-1";

/** The transport intersection, as this transport speaks it. */
const API_SCENARIO: readonly ApiStreamChunk[] = [
  { kind: "started", resolvedModel: API_MODEL, protocolVersion: API_PROTOCOL },
  usageReport(0, TOKENS),
  { kind: "state", toState: TERMINAL_STATE },
];

function apiBinding(chunks: readonly ApiStreamChunk[], secret = "unused"): ApiKeyBinding {
  return {
    client: fakeApiClient(
      { provider: API_PROVIDER, models: [API_MODEL, "alias-model"], chunks },
      secret,
    ),
  };
}

function apiRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return route({
    provider: API_PROVIDER,
    model: API_MODEL,
    accountId: API_ACCOUNT,
    transportKind: "API_KEY",
    ...overrides,
  });
}

/** A port serving both transports, which is the ordinary deployment. */
function dualPort(chunks: readonly ApiStreamChunk[] = API_SCENARIO, secret = "unused"): ModelExecutionPort {
  return portFor(
    { "acct-primary": binding(claudeAdapter, CLAUDE_LINES) },
    { [API_ACCOUNT]: apiBinding(chunks, secret) },
  );
}

describe("the same fixture runs through an API_KEY adapter", () => {
  it("produces the same normalized trail as the CLI legs, through the shared assertion", async () => {
    assertSharedTrail("api/" + API_PROVIDER, await drain(dualPort(), apiRoute()), apiRoute());
  });

  it("carries the provider's own resolution verbatim, beside the echoed route", async () => {
    const trail = await drain(dualPort(), apiRoute({ model: "alias-model" }));
    const started = trail.find((event) => event.kind === "started");
    if (started?.kind !== "started") throw new Error("expected a started event");

    // The route asked for `alias-model`; the client bound `gpt-5-2026-04`.
    // Both travel unmodified, exactly as on the CLI side — the adapter never
    // rewrites one to match the other.
    expect({ asked: started.route.model, got: started.resolvedModel, protocol: started.protocolVersion }).toEqual({
      asked: "alias-model",
      got: API_MODEL,
      protocol: API_PROTOCOL,
    });
  });

  it("expresses the kinds the CLI transport cannot, and hands text to the sink rather than the trail", async () => {
    // `text` and `toolUse` are API-transport kinds: the landed CLI parsers
    // emit neither, which is why the shared scenario above is the intersection
    // rather than the union. They are drilled here instead of being smuggled
    // into the shared fixture, where they would have made the CLI legs fail
    // for a reason that has nothing to do with conformance.
    const sunk: string[] = [];
    const trail = await drain(
      dualPort([
        { kind: "started", resolvedModel: API_MODEL, protocolVersion: API_PROTOCOL },
        { kind: "text", delta: "one delta, not a transcript" },
        { kind: "toolUse", tool: "search", detail: "bounded, and never the tool's whole output" },
        { kind: "write", target: "packages/adapters/src/api-key/index.ts" },
        { kind: "checkpoint", digest: "a".repeat(64) },
        { kind: "authRequired", reason: "TOKEN_EXPIRED" },
        usageReport(3, 99),
      ]),
      apiRoute(),
      request(),
      (delta) => sunk.push(delta),
    );

    // P-07 escalón C (ADR 0099): the text delta went to the sink, not the trail.
    expect(sunk).toEqual(["one delta, not a transcript"]);
    expect(JSON.stringify(trail)).not.toContain("one delta");
    expect(trail.map((event) => event.kind)).toEqual([
      "started",
      "toolUse",
      "write",
      "checkpoint",
      "authRequired",
      "usage",
      "completed",
    ]);
    // `write` reaching the boundary is the difference from the CLI leg, where
    // the landed normalization drops it before the port ever sees one. The
    // enforcement plane can see writes on this transport.
    expect(trail.find((event) => event.kind === "write")).toEqual({
      kind: "write",
      target: "packages/adapters/src/api-key/index.ts",
    });
    // The synthesized completion carries the last step the transport reported.
    expect(trail.at(-1)).toEqual({ kind: "completed", stepIndex: 3 });
  });

  it("refuses a malformed chunk instead of emitting it", async () => {
    // A digest that is not a digest. The boundary emits contract-valid events
    // or it emits an error; it never puts a malformed event into evidence.
    const trail = await drain(
      dualPort([
        { kind: "started", resolvedModel: API_MODEL, protocolVersion: API_PROTOCOL },
        { kind: "checkpoint", digest: "not-a-sha256" },
      ]),
      apiRoute(),
    );
    expect(trail.map((event) => event.kind)).toEqual(["started", "error"]);
    expect(trail.some((event) => event.kind === "completed")).toBe(false);
  });

  it("refuses a model the client did not declare, and never substitutes one", async () => {
    const outcome = await dualPort().start(apiRoute({ model: "some-other-model" }), request());
    expect(outcome).toEqual({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "route.model" });
  });

  it("refuses an API account it holds no binding for, and a provider mismatch", async () => {
    const noAccount = await dualPort().start(apiRoute({ accountId: "acct-unknown" }), request());
    expect(noAccount).toEqual({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" });

    const wrongProvider = await dualPort().start(apiRoute({ provider: "anthropic" }), request());
    expect(wrongProvider).toEqual({ ok: false, refusal: "ROUTE_INVALID", at: "route.provider" });
  });

  it("refuses a reattach on the API transport too", async () => {
    const outcome = await dualPort().start(apiRoute(), request({ reattach: "yesterday" }));
    expect(outcome).toEqual({ ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" });
  });

  it("names an API execution with the same durable scheme as a CLI one", async () => {
    const started = await dualPort().start(apiRoute(), request());
    if (!started.ok) throw new Error("expected a session");
    for await (const _event of started.events()) void _event;

    // One naming scheme across transports: moving a route from CLI to API must
    // preserve the task's identity, and two schemes could not.
    expect(started.sessionId).toBe(executionSessionId(TASK, 1, API_ACCOUNT));
  });
});

// ---------------------------------------------------------------------------
// The LOCAL_OR_SELF_HOSTED leg: the third kind, same shape as the API one
// ---------------------------------------------------------------------------

const LOCAL_ACCOUNT = "acct-local";
const LOCAL_PROVIDER = "llama-cpp";
const LOCAL_MODEL = "qwen3-32b-instruct";
const LOCAL_PROTOCOL = "openai-compatible/chat-1";

/** The transport intersection, as this transport speaks it. */
const LOCAL_SCENARIO: readonly LocalChatChunk[] = [
  { kind: "started", resolvedModel: LOCAL_MODEL, protocolVersion: LOCAL_PROTOCOL },
  usageReport(0, TOKENS),
  { kind: "state", toState: TERMINAL_STATE },
];

function localBinding(chunks: readonly LocalChatChunk[], secret = "unused"): LocalBinding {
  return {
    client: fakeLocalClient(
      { provider: LOCAL_PROVIDER, models: [LOCAL_MODEL, "alias-model"], chunks },
      secret,
    ),
  };
}

function localRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return route({
    provider: LOCAL_PROVIDER,
    model: LOCAL_MODEL,
    accountId: LOCAL_ACCOUNT,
    transportKind: "LOCAL_OR_SELF_HOSTED",
    ...overrides,
  });
}

/** A port serving the CLI and local transports, but not the API one. */
function localPort(chunks: readonly LocalChatChunk[] = LOCAL_SCENARIO, secret = "unused"): ModelExecutionPort {
  return portFor(
    { "acct-primary": binding(claudeAdapter, CLAUDE_LINES) },
    undefined,
    { [LOCAL_ACCOUNT]: localBinding(chunks, secret) },
  );
}

describe("the same fixture runs through a LOCAL_OR_SELF_HOSTED adapter", () => {
  it("produces the same normalized trail as the CLI/API legs, through the shared assertion", async () => {
    assertSharedTrail("local/" + LOCAL_PROVIDER, await drain(localPort(), localRoute()), localRoute());
  });

  it("refuses a model the client did not declare, and never substitutes one", async () => {
    const outcome = await localPort().start(localRoute({ model: "some-other-model" }), request());
    expect(outcome).toEqual({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "route.model" });
  });

  it("refuses a local account it holds no binding for, and a provider mismatch", async () => {
    const noAccount = await localPort().start(localRoute({ accountId: "acct-unknown" }), request());
    expect(noAccount).toEqual({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" });

    const wrongProvider = await localPort().start(localRoute({ provider: "vllm" }), request());
    expect(wrongProvider).toEqual({ ok: false, refusal: "ROUTE_INVALID", at: "route.provider" });
  });
});

describe("the dual-transport acceptance bullet", () => {
  it("collapses every transport leg to one normalized trail", async () => {
    // The acceptance criterion, stated directly: the same conformance fixture
    // through CLI_SUBSCRIPTION and API_KEY adapters — and now the local one
    // too — producing the same normalized event/lifecycle contract.
    //
    // The legs are compared to each other, not each to a constant, so a change
    // that moved all of them together would still have to move this. It lives
    // here rather than inside one transport's describe because it belongs to
    // none of them: adding a fourth leg means adding it to this map, and the
    // count below is what makes forgetting impossible.
    //
    // V2-B1c narrowed the CLI side to one leg: an execution carries an
    // instruction, and Claude is the only CLI transport that can take one, so
    // the other two refuse before a session exists. The acceptance criterion is
    // unchanged in kind — every leg that CAN run produces the same normalized
    // trail — and the count below moves with it rather than being quietly
    // reinterpreted.
    const legs: Record<string, readonly string[]> = {};
    legs["cli/claude"] = (await trailFor("claude")).map((event) => event.kind);
    legs["api/" + API_PROVIDER] = (await drain(dualPort(), apiRoute())).map((event) => event.kind);
    legs["local/" + LOCAL_PROVIDER] = (await drain(localPort(), localRoute())).map((event) => event.kind);

    // Compared over the shared projection: since P-07 escalón C the raw trails
    // legitimately differ by the process fact, which only the CLI leg observes.
    const projected = (kinds: readonly string[]): string => kinds.filter((kind) => !PER_LEG_KINDS.includes(kind)).join(",");
    const distinct = new Set(Object.values(legs).map(projected));
    expect({ legs: Object.keys(legs).length, distinctTrails: distinct.size }).toEqual({
      legs: 3,
      distinctTrails: 1,
    });
    expect([...distinct][0]).toBe(SHARED_KINDS.join(","));
    expect(legs["cli/claude"]).toEqual(["started", "usage", "state", "processExited", "completed"]);
    expect(legs["api/" + API_PROVIDER]).toEqual(SHARED_KINDS);
    expect(legs["local/" + LOCAL_PROVIDER]).toEqual(SHARED_KINDS);
  });
});

describe("law 6: subscription operation does not depend on the API or local transport", () => {
  it("serves CLI routes and refuses non-CLI routes when built without their bindings", async () => {
    // Constructed with the CLI binding alone — the deployment law 6 describes.
    const cliOnly = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });

    // The CLI leg is untouched: the full trail, not a degraded one.
    assertSharedTrail("cli-only/claude", await drain(cliOnly, route()), route());

    // Neither the API nor the local transport exists here. Not an empty
    // account list, not a lazy failure at stream time: a classified refusal
    // at the transport, before anything is attempted, for both kinds.
    for (const [leg, missingRoute] of [
      ["api", apiRoute()],
      ["local", localRoute()],
    ] as const) {
      const outcome = await cliOnly.start(missingRoute, request());
      expect({ leg, outcome }).toEqual({
        leg,
        outcome: { ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.transportKind" },
      });
      expect({ leg, probe: await cliOnly.healthProbe(missingRoute) }).toEqual({
        leg,
        probe: { status: "FAILED", checkedAt: AT, latencyMs: null, classifiedError: "TRANSPORT_UNAVAILABLE" },
      });
    }
  });

  it("distinguishes an absent API transport from one with no accounts", async () => {
    // An empty map is a different statement from an absent one: this port has
    // the transport and serves no account on it yet. The refusals differ, and
    // a caller can tell "not built for this" from "not configured for you".
    const empty = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) }, {});
    const outcome = await empty.start(apiRoute(), request());
    expect(outcome).toEqual({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" });
  });

  it("distinguishes an absent local transport from one with no accounts", async () => {
    // The same distinction, generalized to the local leg: an empty map still
    // means "this port serves local routes, for no account yet".
    const empty = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) }, undefined, {});
    const outcome = await empty.start(localRoute(), request());
    expect(outcome).toEqual({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" });
  });
});

describe("credentials are unrepresentable at this boundary", () => {
  it("never surfaces a secret the client implementation holds", async () => {
    const secret = "sk-p83-do-not-emit-0123456789";
    // The fake spends the secret into the one place a leak would show: the
    // stream's own content. If any of it reached the trail, the scan below
    // would find it.
    const sunk: string[] = [];
    const trail = await drain(
      dualPort(
        [
          { kind: "started", resolvedModel: API_MODEL, protocolVersion: API_PROTOCOL },
          { kind: "text", delta: "a delta that does not name the key" },
          usageReport(0, TOKENS),
        ],
        secret,
      ),
      apiRoute(),
      request(),
      (delta) => sunk.push(delta),
    );

    // Redaction by unrepresentability rather than by filtering: no member of
    // `ApiStreamRequest` or `ApiStreamingClient` can carry a key, so the port
    // is never handed one and has nothing to strip. The scan is the evidence,
    // not the mechanism.
    expect(JSON.stringify(trail)).not.toContain(secret);
    expect(JSON.stringify(trail)).not.toContain("sk-");
    expect(JSON.stringify(sunk)).not.toContain(secret);
    // The delta reached the sink (P-07 escalón C), and the trail carries no text.
    expect(sunk).toEqual(["a delta that does not name the key"]);
    expect(trail.map((event) => event.kind)).toEqual(["started", "usage", "completed"]);
  });

  it("never surfaces a secret the local client implementation holds", async () => {
    // The same drill on the local leg, run rather than scaffolded. A local or
    // self-hosted server behind an optional bearer token is the likeliest
    // place for a credential to be reached for, so it is the leg where the
    // proof matters most — and the `secret` parameter that threads through
    // `localPort` is only evidence when a test actually spends it.
    const secret = "lk-p84-do-not-emit-9876543210";
    const sunk: string[] = [];
    const trail = await drain(
      localPort(
        [
          { kind: "started", resolvedModel: LOCAL_MODEL, protocolVersion: LOCAL_PROTOCOL },
          { kind: "text", delta: "a delta that does not name the token" },
          usageReport(0, TOKENS),
        ],
        secret,
      ),
      localRoute(),
      request(),
      (delta) => sunk.push(delta),
    );

    // Same mechanism, same evidence: no member of `LocalChatRequest` or
    // `LocalChatClient` can carry a token, so the port is never handed one and
    // has nothing to strip.
    expect(JSON.stringify(trail)).not.toContain(secret);
    expect(JSON.stringify(trail)).not.toContain("lk-");
    expect(JSON.stringify(sunk)).not.toContain(secret);
    expect(sunk).toEqual(["a delta that does not name the token"]);
    expect(trail.map((event) => event.kind)).toEqual(["started", "usage", "completed"]);
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
        JSON.stringify({ type: "system", subtype: "init", model: other, claude_code_version: "2.1.280" }),
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
// The mapping function, exercised directly
// ---------------------------------------------------------------------------
//
// The quota half cannot be reached through a live session in a test or in
// production: codex and kimi declare UNSUPPORTED/HANDSHAKE_REQUIRED and
// `startSession` refuses before any spawn, and the scripted adapter keeps the
// base delivery rather than lifting it. "Port level" therefore means the
// mapping function, called with a normalized event built by hand, and the
// stream-level evidence for pressure is the auth half in the daemon drill.

describe("a classified pressure crosses the boundary carrying its own provider", () => {
  it("expresses every member of the closed observation vocabulary", () => {
    // Over the closed set, so a sixth member cannot be added without a test.
    // Only the two quota members are ever *constructed* by an adapter — the
    // codex suite pins that — but the boundary can express each of them, and
    // an event it could not express would be a silent drop.
    for (const pressure of PROVIDER_PRESSURES) {
      const mapping = toExecutionEvent(
        normalizedEvent("quota.pressure", "codex", TASK, { provider: "codex", pressure }),
        route({ provider: "codex" }),
      );
      expect({ pressure, kind: mapping.kind }).toEqual({ pressure, kind: "EVENT" });
      if (mapping.kind !== "EVENT") continue;
      expect(ExecutionEvent.safeParse(mapping.event).success).toBe(true);
      expect(mapping.event).toEqual({ kind: "pressure", provider: "codex", pressure });
    }
  });

  it("takes the provider from the adapter that classified the frame", () => {
    // The two cannot differ for a session that opened: `startExecution`
    // refuses ROUTE_INVALID at `route.provider` when the binding's adapter
    // disagrees with the admitted provider, before `startSession`. This pins
    // which of the two is the *source*, so the attribution stays with the
    // classification rather than being re-derived a layer later.
    const mapping = toExecutionEvent(
      normalizedEvent("quota.pressure", "codex", TASK, {
        provider: "codex",
        pressure: "QUOTA_EXHAUSTED",
      }),
      route({ provider: "claude" }),
    );
    expect(mapping.kind).toBe("EVENT");
    if (mapping.kind !== "EVENT") return;
    expect(mapping.event).toEqual({
      kind: "pressure",
      provider: "codex",
      pressure: "QUOTA_EXHAUSTED",
    });
  });

  it("refuses a half-built pressure rather than yielding one", () => {
    // The landed behaviour of every other case in this switch: a member the
    // privacy shaping dropped, or a token outside the vocabulary, ends the
    // stream with a classified error rather than a pressure nobody classified.
    for (const payload of [
      { provider: "codex" },
      { provider: "codex", pressure: "" },
      { provider: "codex", pressure: "DRAINING" },
      { provider: "codex", pressure: 3 },
    ]) {
      const mapping = toExecutionEvent(
        normalizedEvent("quota.pressure", "codex", TASK, payload),
        route({ provider: "codex" }),
      );
      expect({ payload, kind: mapping.kind }).toEqual({ payload, kind: "UNEXPRESSIBLE" });
    }
  });

  it("still carries an auth requirement without a provider of its own", () => {
    // `authRequired` is a landed contract member and is not widened by this
    // packet: the two structural chunk pass-throughs would be bound to its
    // exact shape forever. The effects module supplies the route's provider
    // for this kind instead, which the port's guard makes the same value.
    const mapping = toExecutionEvent(
      normalizedEvent("auth.required", "claude", TASK, {
        provider: "claude",
        reason: "LOGIN_REQUIRED",
      }),
      route(),
    );
    expect(mapping.kind).toBe("EVENT");
    if (mapping.kind !== "EVENT") return;
    expect(mapping.event).toEqual({ kind: "authRequired", reason: "LOGIN_REQUIRED" });
  });
});

// ---------------------------------------------------------------------------
// The CLI-only facts, drilled apart from the shared scenario
// ---------------------------------------------------------------------------

describe("what this transport can and cannot say", () => {
  it("synthesizes exactly one completed on a clean close, carrying the last step", async () => {
    const port = portFor({
      "acct-primary": binding(claudeAdapter, [
        JSON.stringify({ type: "system", subtype: "init", model: "m", claude_code_version: "2.1.280" }),
        JSON.stringify({ type: "assistant", message: { id: "msg-1", usage: { output_tokens: 10 } } }),
        JSON.stringify({ type: "assistant", message: { id: "msg-2", usage: { output_tokens: 20 } } }),
        JSON.stringify({
          type: "result",
          subtype: "turn_completed",
          session_id: "session-steps",
          usage: { input_tokens: 1, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
      ]),
    });
    const trail = await drain(port, route());
    const completions = trail.filter((event) => event.kind === "completed");

    expect(completions.length).toBe(1);
    // The last step the transport reported (C-D5): the session's one report counts
    // its steps as the two distinct assistant messages, and `completed` carries the
    // same number, so usage reconciles against the steps that actually happened.
    expect(trail.flatMap((event) => (event.kind === "usage" ? [event.stepIndex] : []))).toEqual([2]);
    expect(completions[0]).toEqual({ kind: "completed", stepIndex: 2 });
    expect(trail.some((event) => event.kind === "error")).toBe(false);
  });

  it("emits no write event, because the CLI adapters never hand it one", async () => {
    const port = portFor({
      "acct-primary": binding(claudeAdapter, [
        JSON.stringify({ type: "system", subtype: "init", model: "m", claude_code_version: "2.1.280" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Edit" }], usage: { output_tokens: 7 } },
        }),
        JSON.stringify({
          type: "result",
          subtype: "turn_completed",
          session_id: "session-write",
          usage: { input_tokens: 0, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
      ]),
    });

    const trail = await drain(port, route());
    // A gap, named rather than hidden. The landed normalization maps a
    // write-class signal to nothing — `toNormalized` returns null for it — so
    // no `write` ever reaches this boundary for a writer identity. The
    // contract's `write` kind is reachable by other transports; on this one it
    // is unreported, and the enforcement plane must not rely on seeing it here.
    expect(trail.some((event) => event.kind === "write")).toBe(false);
    // The rest of the trail is unaffected: the session's measurement, from its
    // result (P-15/D2), and the child's clean exit before the terminal (P-07 C).
    expect(trail.map((event) => event.kind)).toEqual(["started", "usage", "state", "processExited", "completed"]);
  });

  it("ends in a classified error, not a completed, when the session fails", async () => {
    // The same write, under a reviewer identity: the session kills the child
    // and fails. This is where the write guarantee actually lives on this
    // transport, and the port reports it as an error rather than a clean close.
    const port = portFor({
      "acct-primary": binding(claudeAdapter, [
        JSON.stringify({ type: "system", subtype: "init", model: "m", claude_code_version: "2.1.280" }),
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
    expect(first.sessionId).toBe(executionSessionId(TASK, 1, "acct-primary"));
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

// ---------------------------------------------------------------------------
// V2-B4a: the owned session lifecycle
// ---------------------------------------------------------------------------

/**
 * A binding for the lifetime drills, scripted exactly like the fixture's.
 *
 * **No timer, anywhere.** These drills need a *session* that is still live
 * after its stream is abandoned, and that does not require a running child:
 * abandoning an iteration never calls `finish()`, so nothing closes the
 * session, and the entry stays live whether the child has exited or not. The
 * pump keeps filling the queue regardless of consumers, so a reattached stream
 * drains the remainder that the abandoned one never took. Every assertion
 * below is on an event that was actually delivered or a state the harness
 * actually holds — never on elapsed time (stop condition 5).
 *
 * `lingerMs` appears in exactly one drill, A4, where the subject *is* a
 * running child: an interrupt that walks the signal ladder needs something to
 * signal, and that drill never drains a stream to completion.
 */
function lifetimeBinding(extra: Partial<FakeScript> = {}): CliBinding {
  const root = drillRoot();
  const script: FakeScript = { lines: CLAUDE_LINES, exitCode: 0, ...extra };
  return {
    adapter: scriptedAdapter(claudeAdapter, script),
    binary: NODE,
    configRoot: root as AdmittedConfigRoot,
    workdir: root as AdmittedWorkdir,
    limits: limits(),
  };
}

/** A port over one CLI binding, with a harness the test can read. */
function ownedPort(extra: Partial<FakeScript> = {}): {
  readonly port: ModelExecutionPort;
  readonly harness: AgentHarness;
} {
  const harness = createAgentHarness();
  const port = createExecutionPort({
    bindings: new Map([["acct-primary", lifetimeBinding(extra)]]),
    harness,
  });
  return { port, harness };
}

/**
 * Take `count` events, then abandon the stream the way a caller does.
 *
 * `.return()` on the iterator is what a `break` out of a `for await` compiles
 * to, so this reproduces abandonment exactly rather than approximating it.
 */
async function takeThenAbandon(
  session: { events(): AsyncIterable<ExecutionEvent> },
  count: number,
): Promise<readonly ExecutionEvent[]> {
  const iterator = session.events()[Symbol.asyncIterator]();
  const taken: ExecutionEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const step = await iterator.next();
    if (step.done === true) break;
    taken.push(step.value);
  }
  await iterator.return?.();
  return taken;
}

async function collect(session: { events(): AsyncIterable<ExecutionEvent> }): Promise<readonly ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of session.events()) events.push(event);
  return events;
}

describe("the owned session lifecycle", () => {
  // A1, A2.
  it("rejoins a live execution without spawning a second child, losing nothing and repeating nothing", async () => {
    const { port, harness } = ownedPort();
    const first = await port.start(route(), request());
    if (!first.ok) throw new Error("expected a session, got " + first.refusal);

    const taken = await takeThenAbandon(first, 1);
    expect(taken.map((event) => event.kind)).toEqual(["started"]);
    const pidWhileAbandoned = harness.live()[0]?.pid;
    expect(harness.live()).toHaveLength(1);

    const rejoined = await port.start(route(), request({ reattach: first.sessionId }));
    if (!rejoined.ok) throw new Error("expected a rejoin, got " + rejoined.refusal + " at " + rejoined.at);
    expect(rejoined.sessionId).toBe(first.sessionId);
    expect(rejoined.route).toEqual(route());

    const rest = await collect(rejoined);
    // The falsifiable form of "no second spawn": a fresh child always emits
    // `started` first, so a second one anywhere in the union would show here.
    expect(rest.filter((event) => event.kind === "started")).toEqual([]);
    const union = [...taken, ...rest];
    expect(union.filter((event) => event.kind === "started")).toHaveLength(1);
    // A2: the union is the scenario, in order, once each — with the child's exit
    // before the terminal since P-07 escalón C.
    expect(union.map((event) => event.kind)).toEqual(["started", "usage", "state", "processExited", "completed"]);
    // Same process throughout, and it is gone once the rejoined stream ended.
    expect(pidWhileAbandoned).toBe(harness.live()[0]?.pid ?? pidWhileAbandoned);
    expect(harness.live()).toEqual([]);
  });

  // A3.
  it("carries the execution's last step into a reattached stream's completion", async () => {
    const { port } = ownedPort();
    const first = await port.start(route(), request());
    if (!first.ok) throw new Error("expected a session");

    // Take the `usage` event on the first stream, so the second never sees one.
    const taken = await takeThenAbandon(first, 2);
    expect(taken.map((event) => event.kind)).toEqual(["started", "usage"]);
    const reported = taken.find((event) => event.kind === "usage");
    if (reported?.kind !== "usage") throw new Error("expected a usage event");

    const rejoined = await port.start(route(), request({ reattach: first.sessionId }));
    if (!rejoined.ok) throw new Error("expected a rejoin");
    const rest = await collect(rejoined);

    expect(rest.filter((event) => event.kind === "usage")).toEqual([]);
    const terminal = rest[rest.length - 1];
    // Seeded from the entry, not from this generator: a per-stream counter
    // would report 0 and make the contract's reconciliation sentence false.
    expect(terminal).toEqual({ kind: "completed", stepIndex: reported.stepIndex });
  });

  // A4.
  it("interrupts a child whose stream was abandoned, walking the ladder and releasing it", async () => {
    // The one drill with a running child, and the one use of `lingerMs`: an
    // interrupt that has to walk the ladder needs something alive to signal.
    const { port, harness } = ownedPort({ ignoreSigint: true, lingerMs: 30_000 });
    const started = await port.start(route(), request());
    if (!started.ok) throw new Error("expected a session");
    await takeThenAbandon(started, 1);

    expect(harness.live()).toHaveLength(1);
    // Before B4a this call was a silent no-op: the abandoned session had
    // already been deleted from the port's registry, so the child ran on with
    // nothing able to name it.
    await port.interrupt(started.sessionId);
    expect(harness.live()).toEqual([]);
  });

  // A5.
  it("ends the entry with the session, not with the stream", async () => {
    const { port, harness } = ownedPort();

    const completed = await port.start(route(), request());
    if (!completed.ok) throw new Error("expected a session");
    await collect(completed);
    // Drained to its terminal: the session closed, so the entry is gone.
    expect(harness.live()).toEqual([]);

    const abandoned = await port.start(route({ accountId: "acct-primary" }), request({ attempt: 2 }));
    if (!abandoned.ok) throw new Error("expected a session");
    await takeThenAbandon(abandoned, 1);
    // Abandoned: the stream is over and the session is not, so the entry
    // stays — live, named, reattachable and reapable.
    expect(harness.live()).toHaveLength(1);
    expect(harness.live()[0]?.sessionId).toBe(abandoned.sessionId);

    await harness.closeAll();
  });

  // N2.
  it("refuses a rejoin whose route differs in any single field", async () => {
    const cases: readonly Partial<ResolvedRoute>[] = [
      { provider: "codex" },
      { model: "sonnet" },
      { accountId: "acct-other" },
      { transportKind: "API_KEY" },
      { capabilityPolicyVersion: "p8-9" },
      { resolvedAt: "2026-08-31T00:00:00.000Z" },
    ];
    for (const override of cases) {
      const { port, harness } = ownedPort();
      const started = await port.start(route(), request());
      if (!started.ok) throw new Error("expected a session");
      await takeThenAbandon(started, 1);

      const outcome = await port.start(route(override), request({ reattach: started.sessionId }));
      expect({ override, outcome }).toEqual({
        override,
        outcome: { ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" },
      });
      await harness.closeAll();
    }
  });

  // N3.
  it("refuses a rejoin under a different identity, in both directions", async () => {
    for (const [held, asking] of [
      [IDENTITY, REVIEWER],
      [REVIEWER, IDENTITY],
    ] as const) {
      const { port, harness } = ownedPort();
      const started = await port.start(route(), request({ identity: held }));
      if (!started.ok) throw new Error("expected a session, got " + started.refusal);
      await takeThenAbandon(started, 1);

      const outcome = await port.start(route(), request({ identity: asking, reattach: started.sessionId }));
      expect(outcome).toEqual({ ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" });
      await harness.closeAll();
    }
  });

  // N4.
  it("refuses a rejoin onto a stream somebody is already draining", async () => {
    const { port, harness } = ownedPort();
    const started = await port.start(route(), request());
    if (!started.ok) throw new Error("expected a session");

    const iterator = started.events()[Symbol.asyncIterator]();
    await iterator.next();
    // Still attached: one queue, one reader. The port will not fan a single
    // queue out to two consumers, and does not pretend it can.
    const outcome = await port.start(route(), request({ reattach: started.sessionId }));
    expect(outcome).toEqual({ ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" });

    await iterator.return?.();
    await harness.closeAll();
  });

  // N5.
  it("refuses a rejoin naming an execution that is not the caller's own", async () => {
    const { port, harness } = ownedPort();
    const started = await port.start(route(), request());
    if (!started.ok) throw new Error("expected a session");
    await takeThenAbandon(started, 1);

    // A live name, but not the one this request derives. The port holds no
    // authority to hand out another task's child.
    const outcome = await port.start(route(), request({ attempt: 7, reattach: started.sessionId }));
    expect(outcome).toEqual({ ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" });
    expect(harness.live()).toHaveLength(1);
    await harness.closeAll();
  });

  // N6.
  it("refuses a plain start that names an execution already in flight, and spawns nothing", async () => {
    const { port, harness } = ownedPort();
    const started = await port.start(route(), request());
    if (!started.ok) throw new Error("expected a session");
    await takeThenAbandon(started, 1);
    const pid = harness.live()[0]?.pid;

    const outcome = await port.start(route(), request());
    expect(outcome).toEqual({ ok: false, refusal: "EXECUTION_IN_FLIGHT", at: "request.reattach" });
    // The proof the refusal neither spawned nor overwrote: one entry, same pid.
    expect(harness.live()).toHaveLength(1);
    expect(harness.live()[0]?.pid).toBe(pid);

    await harness.closeAll();
  });

  // N7, the local leg and the built-without-transport precedence.
  it("refuses a reattach on the local leg, and before noticing the transport is absent", async () => {
    const withLocal = await localPort().start(localRoute(), request({ reattach: "yesterday" }));
    expect(withLocal).toEqual({ ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" });

    // Built with the CLI leg only: the reattach refusal still precedes the
    // TRANSPORT_UNAVAILABLE it would otherwise answer with, which is the
    // precedence the removed global check used to guarantee.
    const cliOnly = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) });
    for (const kind of ["API_KEY", "LOCAL_OR_SELF_HOSTED"] as const) {
      const outcome = await cliOnly.start(
        route({ transportKind: kind, provider: "openai" }),
        request({ reattach: "yesterday" }),
      );
      expect({ kind, outcome }).toEqual({
        kind,
        outcome: { ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" },
      });
    }
  });

  // N9, the vacuity guard.
  it("still refuses a rejoin when the port was built without an injected harness", async () => {
    // The port builds a private harness, so the lifetime law holds; what the
    // caller gives up is the ability to observe or reap it. If this passed for
    // the same reason the acceptance tests do, those tests would be measuring
    // the fake provider rather than the harness.
    const port = createExecutionPort({
      bindings: new Map([["acct-primary", lifetimeBinding()]]),
    });
    const started = await port.start(route(), request());
    if (!started.ok) throw new Error("expected a session");
    await takeThenAbandon(started, 1);

    const stale = await port.start(route(), request({ reattach: "execution-from-yesterday" }));
    expect(stale).toEqual({ ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" });
    // And the private harness is holding the child, which is why a plain start
    // is refused rather than doubling it.
    const doubled = await port.start(route(), request());
    expect(doubled).toEqual({ ok: false, refusal: "EXECUTION_IN_FLIGHT", at: "request.reattach" });

    await port.interrupt(started.sessionId);
  });
});

// ---------------------------------------------------------------------------
// P-06/CORR: the API and local legs carry the composed instruction, and refuse
// what they cannot carry before the client is called (ADR 0096)
// ---------------------------------------------------------------------------

/** One request the client received, as the recording client saw it. */
type ReceivedRequest = ApiStreamRequest | LocalChatRequest;

/**
 * A port bound to one synthetic client per non-CLI leg that records every
 * request it is handed and streams the shared scenario. Synthetic only: no
 * provider, no network and no spend.
 */
function recordingPort(leg: "api" | "local"): { readonly port: ModelExecutionPort; readonly seen: ReceivedRequest[] } {
  const seen: ReceivedRequest[] = [];
  if (leg === "api") {
    const bound: ApiKeyBinding = {
      client: {
        provider: API_PROVIDER,
        models: [API_MODEL],
        // eslint-disable-next-line @typescript-eslint/require-await
        async *stream(received: ApiStreamRequest): AsyncIterable<ApiStreamChunk> {
          seen.push(received);
          for (const chunk of API_SCENARIO) yield chunk;
        },
      },
    };
    return { port: portFor({}, { [API_ACCOUNT]: bound }), seen };
  }
  const bound: LocalBinding = {
    client: {
      provider: LOCAL_PROVIDER,
      models: [LOCAL_MODEL],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream(received: LocalChatRequest): AsyncIterable<LocalChatChunk> {
        seen.push(received);
        for (const chunk of LOCAL_SCENARIO) yield chunk;
      },
    },
  };
  return { port: portFor({}, undefined, { [LOCAL_ACCOUNT]: bound }), seen };
}

const NON_CLI_LEGS = [
  { leg: "api", route: (): ResolvedRoute => apiRoute() },
  { leg: "local", route: (): ResolvedRoute => localRoute() },
] as const;

const CLIENT_REQUEST_KEYS = ["attempt", "identity", "instructions", "model", "taskId"];

describe("P-06/CORR: the API and local legs carry the composed instruction", () => {
  for (const { leg, route: legRoute } of NON_CLI_LEGS) {
    it(leg + ": two distinct instructions arrive distinct, byte-equal to what was asked, in exactly five keys", async () => {
      // The anti-constant control: a hard-coded, cached or first-seen value
      // passes one of these and fails the other.
      const first = "summarise the packet\n\nthen list its open questions";
      const second = "draft the migration note — with a non-ASCII byte";
      const { port, seen } = recordingPort(leg);
      await drain(port, legRoute(), request({ instructions: first }));
      await drain(port, legRoute(), request({ instructions: second }));
      expect(seen).toHaveLength(2);
      expect(seen.map((received) => received.instructions)).toEqual([first, second]);
      for (const received of seen) {
        expect(Object.keys(received).sort()).toEqual(CLIENT_REQUEST_KEYS);
      }
    });

    it(leg + ": a positive text case still streams to its terminal event", async () => {
      const { port, seen } = recordingPort(leg);
      const trail = await drain(port, legRoute(), request({ modalities: ["text"] }));
      expect(seen).toHaveLength(1);
      expect(trail.map((event) => event.kind)).toContain("completed");
    });

    it(leg + ": text beside any other class is refused before the client, with zero calls", async () => {
      const { port, seen } = recordingPort(leg);
      const outcome = await port.start(legRoute(), request({ modalities: ["text", "image"] }));
      expect(outcome).toEqual({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "request.modalities" });
      expect(seen).toHaveLength(0);
    });

    it(leg + ": a request with no text class at all is refused before the client, with zero calls", async () => {
      const { port, seen } = recordingPort(leg);
      for (const kind of ["image", "audio", "document"] as const) {
        const outcome = await port.start(legRoute(), request({ modalities: [kind] }));
        expect(outcome).toEqual({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "request.modalities" });
      }
      expect(seen).toHaveLength(0);
    });

    it(leg + ": a credential-shaped instruction is refused before the client, with zero calls", async () => {
      // Built by concatenation so no tracked literal matches a credential
      // pattern; the port's scan is the same one `startSession` runs.
      const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
      const { port, seen } = recordingPort(leg);
      const outcome = await port.start(legRoute(), request({ instructions: "deploy with " + secret }));
      expect(outcome).toEqual({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "request.instructions" });
      expect(JSON.stringify(outcome)).not.toContain(secret);
      expect(seen).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// P-07 escalón C — three facts, never fused, and the output on the private side
// (ADR 0099)
// ---------------------------------------------------------------------------

/** A port over one Claude-parsed CLI child running `script`. */
function captured(script: FakeScript): ModelExecutionPort {
  const root = drillRoot();
  return portFor({
    "acct-primary": {
      adapter: scriptedAdapter(claudeAdapter, script),
      binary: NODE,
      configRoot: root as AdmittedConfigRoot,
      workdir: root as AdmittedWorkdir,
      limits: limits(),
    },
  });
}

/** Replace the `is_error` of the captured result record, or delete it. */
function resultWith(isError: boolean | undefined): string {
  const result = JSON.parse(CAPTURED_SUCCESS[5] ?? "{}") as Record<string, unknown>;
  if (isError === undefined) delete result["is_error"];
  else result["is_error"] = isError;
  return JSON.stringify(result);
}

/** The fixed order: the process fact, then the operation fact, then exactly one terminal, last. */
function assertFactOrder(trail: readonly ExecutionEvent[]): void {
  const kinds = trail.map((event) => event.kind);
  const terminals = kinds.filter((kind) => kind === "completed" || kind === "error");
  expect(terminals).toHaveLength(1);
  const terminal = kinds.length - 1;
  expect(kinds[terminal] === "completed" || kinds[terminal] === "error").toBe(true);
  const exited = kinds.indexOf("processExited");
  const operation = kinds.indexOf("operationResult");
  if (exited !== -1 && operation !== -1) expect(exited).toBeLessThan(operation);
  if (exited !== -1) expect(exited).toBeLessThan(terminal);
  if (operation !== -1) expect(operation).toBeLessThan(terminal);
  expect(kinds.filter((kind) => kind === "processExited").length).toBeLessThanOrEqual(1);
  expect(kinds.filter((kind) => kind === "operationResult").length).toBeLessThanOrEqual(1);
  for (const event of trail) expect(ExecutionEvent.safeParse(event).success).toBe(true);
}

describe("P-07 C: a transport, a process and an operation are three facts", () => {
  it("OBS sample 1: transport success, a non-zero exit and a failed operation, none fused", async () => {
    const trail = await drain(captured({ lines: CAPTURED_AUTH_FAILURE, exitCode: 1 }), route());
    expect(trail.map((event) => event.kind)).toEqual([
      "started",
      "usage",
      "state",
      "processExited",
      "operationResult",
      "completed",
    ]);
    expect(trail.find((event) => event.kind === "processExited")).toEqual({ kind: "processExited", exitCode: 1, signal: null });
    expect(trail.find((event) => event.kind === "operationResult")).toEqual({ kind: "operationResult", status: "FAILED" });
    // The subtype stays a token, never a verdict.
    expect(trail.find((event) => event.kind === "state")).toEqual({ kind: "state", toState: "SUCCESS" });
    assertFactOrder(trail);
  });

  it("OBS sample 2: the sink receives exactly \"ok\", exit 0, operation SUCCEEDED, and the signature is nowhere", async () => {
    const sunk: string[] = [];
    const trail = await drain(captured({ lines: CAPTURED_SUCCESS, exitCode: 0 }), route(), request(), (delta) => sunk.push(delta));
    // ONE usage report (P-15/D2, ADR 0105): the two assistant records repeat one
    // message's usage and report nothing; the result's usage is the session's own
    // count, read once. Before D2 the two records were two reports — the double count.
    expect(trail.map((event) => event.kind)).toEqual([
      "started",
      "usage",
      "state",
      "processExited",
      "operationResult",
      "completed",
    ]);
    expect(trail.find((event) => event.kind === "usage")).toEqual({
      kind: "usage",
      stepIndex: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 1,
      cacheReadTokens: 1,
      totalTokens: 4,
      reportKind: "CUMULATIVE",
      isFinal: true,
      sourceObservationId: "00000000-0000-4000-8000-000000000001/result",
    });
    expect(trail.find((event) => event.kind === "completed")).toEqual({ kind: "completed", stepIndex: 1 });
    expect(trail.find((event) => event.kind === "started")).toMatchObject({ resolvedModel: "claude-haiku-4-5-20251001" });
    expect(trail.find((event) => event.kind === "processExited")).toEqual({ kind: "processExited", exitCode: 0, signal: null });
    expect(trail.find((event) => event.kind === "operationResult")).toEqual({ kind: "operationResult", status: "SUCCEEDED" });
    expect(sunk).toEqual(["ok"]);
    expect(JSON.stringify(trail)).not.toContain('"ok"');
    for (const surface of [JSON.stringify(trail), JSON.stringify(sunk)]) expect(surface).not.toContain("fixture-signature");
    assertFactOrder(trail);
  });

  it("SYN (unobserved): is_error true with exit 0 is three facts too — exit 0, FAILED, completed", async () => {
    const lines = [CAPTURED_SUCCESS[1] ?? "", resultWith(true)];
    const trail = await drain(captured({ lines, exitCode: 0 }), route());
    expect(trail.slice(-3)).toEqual([
      { kind: "processExited", exitCode: 0, signal: null },
      { kind: "operationResult", status: "FAILED" },
      { kind: "completed", stepIndex: 0 },
    ]);
    assertFactOrder(trail);
  });

  it("SYN: a result with no is_error and exit 1 reports the exit, no verdict, and still completes — C does not decide", async () => {
    const lines = [CAPTURED_SUCCESS[1] ?? "", resultWith(undefined)];
    const trail = await drain(captured({ lines, exitCode: 1 }), route());
    // The result still carries its usage, so its one report arrives (P-15/D2).
    expect(trail.map((event) => event.kind)).toEqual(["started", "usage", "state", "processExited", "completed"]);
    expect(trail.find((event) => event.kind === "processExited")).toEqual({ kind: "processExited", exitCode: 1, signal: null });
    assertFactOrder(trail);
  });

  it("SYN: a failed session reports our ladder's SIGKILL before its error", async () => {
    const lines = [CAPTURED_SUCCESS[1] ?? "", "{not json"];
    const trail = await drain(captured({ lines, exitCode: 0, lingerMs: 5_000 }), route());
    expect(trail.slice(-2)).toEqual([
      { kind: "processExited", exitCode: null, signal: "SIGKILL" },
      expect.objectContaining({ kind: "error", refusal: "TRANSPORT_UNAVAILABLE" }),
    ]);
    expect(trail.some((event) => event.kind === "operationResult")).toBe(false);
    assertFactOrder(trail);
  });

  it("the throw path reports an error and no process fact: not observable, never 0", async () => {
    // A checkpoint whose digest is not a digest fails the contract inside the
    // stream, which is the port's own throw path.
    const bad = JSON.stringify({ type: "checkpoint", digest: "not-a-digest" });
    const started = JSON.stringify({ type: "started", resolvedModel: "m-1", protocolVersion: "1" });
    const trail = await drain(portFor({ "acct-primary": binding(fakeAdapter, [started, bad]) }), route());
    expect(trail.at(-1)?.kind).toBe("error");
    expect(trail.some((event) => event.kind === "processExited")).toBe(false);
    assertFactOrder(trail);
  });

  it("Q-C4: a rejoin that asks for a sink is refused, because the sink was bound at spawn", async () => {
    const { port } = ownedPort({ lingerMs: 5_000 });
    const first = await port.start(route(), request(), () => undefined);
    if (!first.ok) throw new Error("expected a session, got " + first.refusal);
    const taken = await takeThenAbandon(first, 1);
    expect(taken.map((event) => event.kind)).toEqual(["started"]);
    expect(await port.start(route(), request({ reattach: first.sessionId }), () => undefined)).toEqual({
      ok: false,
      refusal: "REATTACH_UNAVAILABLE",
      at: "request.reattach",
    });
    // Positive control: the same rejoin without a sink is granted.
    const rejoined = await port.start(route(), request({ reattach: first.sessionId }));
    expect(rejoined.ok).toBe(true);
    await port.interrupt(first.sessionId);
  });
});

describe("P-07 C: the API and local legs report the operation fact in order, and never a process fact", () => {
  for (const leg of ["api", "local"] as const) {
    const portWith = (chunks: readonly (ApiStreamChunk | LocalChatChunk)[]): ModelExecutionPort =>
      leg === "api" ? dualPort(chunks as readonly ApiStreamChunk[]) : localPort(chunks as readonly LocalChatChunk[]);
    const legRoute = (): ResolvedRoute => (leg === "api" ? apiRoute() : localRoute());
    const opening = leg === "api" ? API_SCENARIO[0] : LOCAL_SCENARIO[0];

    it(leg + ": an operationResult chunk is held and emitted after every other event, before the terminal", async () => {
      const trail = await drain(
        portWith([
          opening!,
          { kind: "operationResult", status: "SUCCEEDED" },
          usageReport(0, TOKENS),
        ]),
        legRoute(),
      );
      expect(trail.map((event) => event.kind)).toEqual(["started", "usage", "operationResult", "completed"]);
      expect(trail.some((event) => event.kind === "processExited")).toBe(false);
      assertFactOrder(trail);
    });

    it(leg + ": a second operationResult chunk fails the stream rather than overwriting the first", async () => {
      const trail = await drain(
        portWith([
          opening!,
          { kind: "operationResult", status: "SUCCEEDED" },
          { kind: "operationResult", status: "FAILED" },
        ]),
        legRoute(),
      );
      expect(trail.map((event) => event.kind)).toEqual(["started", "error"]);
      assertFactOrder(trail);
    });

    it(leg + ": an operationResult chunk with an absent, null or foreign status is refused, never read as no verdict", async () => {
      for (const status of [undefined, null, "SUCCESS", "CANCELLED"]) {
        const chunk = (status === undefined ? { kind: "operationResult" } : { kind: "operationResult", status }) as unknown as ApiStreamChunk;
        const trail = await drain(portWith([opening!, chunk]), legRoute());
        expect(trail.map((event) => event.kind), String(status)).toEqual(["started", "error"]);
      }
    });

    it(leg + ": a client that emits processExited, completed or error mid-stream fails the stream, and none of it is admitted", async () => {
      const foreign = [
        { kind: "processExited", exitCode: 0, signal: null },
        { kind: "completed", stepIndex: 0 },
        { kind: "error", refusal: "TRANSPORT_UNAVAILABLE", detail: "said by the client" },
      ];
      for (const chunk of foreign) {
        const trail = await drain(
          portWith([opening!, chunk as unknown as ApiStreamChunk, usageReport(0, TOKENS)]),
          legRoute(),
        );
        expect(trail.map((event) => event.kind), chunk.kind).toEqual(["started", "error"]);
        expect(trail.at(-1), chunk.kind).toEqual(expect.objectContaining({ kind: "error", detail: "MALFORMED_EVENT" }));
        expect(JSON.stringify(trail), chunk.kind).not.toContain("said by the client");
      }
    });

    it(leg + ": text goes to the sink and never to the trail, and the trail has no process fact", async () => {
      const sunk: string[] = [];
      const trail = await drain(
        portWith([opening!, { kind: "text", delta: "a" }, { kind: "text", delta: "b" }]),
        legRoute(),
        request(),
        (delta) => sunk.push(delta),
      );
      expect(sunk).toEqual(["a", "b"]);
      expect(trail.map((event) => event.kind)).toEqual(["started", "completed"]);
    });
  }
});

describe("P-15/D2: the port maps a usage report field for field, and refuses what the member refuses", () => {
  const TASK_ID = "d2d2d2d2-0000-4000-8000-000000000001";
  const report = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    stepIndex: 1,
    inputTokens: null,
    outputTokens: 5,
    cacheWriteTokens: null,
    cacheReadTokens: 0,
    totalTokens: null,
    reportKind: "CUMULATIVE",
    isFinal: true,
    sourceObservationId: "obs-1",
    ...overrides,
  });

  it("carries a null class as null and a zero as zero — UNKNOWN is never read as 0", () => {
    const mapped = toExecutionEvent(normalizedEvent("step.completed", "claude", TASK_ID, report()), route());
    expect(mapped).toEqual({ kind: "EVENT", event: { kind: "usage", ...report() } });
  });

  it("N-D17 through the mapping: a key absent is not expressible; a present value the member refuses is not either", () => {
    for (const key of Object.keys(report())) {
      const payload = report();
      Reflect.deleteProperty(payload, key);
      expect(toExecutionEvent(normalizedEvent("step.completed", "claude", TASK_ID, payload), route())).toEqual({
        kind: "UNEXPRESSIBLE",
        detail: "step.completed lost " + key,
      });
    }
    // v2: the total against the classes, through the mapping. `report()` knows two of
    // four classes (5 and 0), so a stated total below 5 is refused; with all four
    // known a null total is refused.
    for (const overrides of [
      { totalTokens: 4 },
      { inputTokens: 1, cacheWriteTokens: 2, totalTokens: null },
      { inputTokens: 1, cacheWriteTokens: 2, totalTokens: 9 },
    ]) {
      const mapped = toExecutionEvent(normalizedEvent("step.completed", "claude", TASK_ID, report(overrides)), route());
      expect({ overrides, kind: mapped.kind }).toEqual({ overrides, kind: "UNEXPRESSIBLE" });
    }
    expect(
      toExecutionEvent(normalizedEvent("step.completed", "claude", TASK_ID, report({ inputTokens: 1, cacheWriteTokens: 2, totalTokens: 8 })), route())
        .kind,
    ).toBe("EVENT");
    for (const [key, value] of [
      ["inputTokens", -1],
      ["outputTokens", 1.5],
      ["cacheReadTokens", "1"],
      ["reportKind", "SNAPSHOT"],
      ["isFinal", 1],
      ["sourceObservationId", ""],
    ] as const) {
      const mapped = toExecutionEvent(normalizedEvent("step.completed", "claude", TASK_ID, report({ [key]: value })), route());
      expect({ key, kind: mapped.kind }).toEqual({ key, kind: "UNEXPRESSIBLE" });
    }
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón E (ADR 0108): the real clients, through the port
// ---------------------------------------------------------------------------

describe("the real HTTP clients through the port (P-15/E)", () => {
  const canary = syntheticCanary("PORT01");
  const messagesRoute = (): ResolvedRoute =>
    route({ provider: "claude", model: "claude-syn-1", accountId: API_ACCOUNT, transportKind: "API_KEY" });
  const chatRoute = (): ResolvedRoute =>
    route({ provider: LOCAL_PROVIDER, model: "local-syn-1", accountId: LOCAL_ACCOUNT, transportKind: "LOCAL_OR_SELF_HOSTED" });

  function realPort(): ModelExecutionPort {
    return portFor(
      { "acct-primary": binding(claudeAdapter, CLAUDE_LINES) },
      {
        [API_ACCOUNT]: {
          client: createAnthropicMessagesClient({ models: ["claude-syn-1"], credential: () => canary, maxTokens: 64, timeoutMs: 5_000 }),
        },
      },
      {
        [LOCAL_ACCOUNT]: {
          client: createLocalChatClient({
            baseUrl: "http://127.0.0.1:18081/v1",
            provider: LOCAL_PROVIDER,
            models: ["local-syn-1"],
            credential: () => canary,
            timeoutMs: 5_000,
          }),
        },
      },
    );
  }

  async function withSubstitute<T>(
    answer: () => Response,
    run: (substitute: ReturnType<typeof fetchSubstitute>) => Promise<T>,
  ): Promise<T> {
    const substitute = fetchSubstitute(answer);
    const restore = substitute.install();
    try {
      return await run(substitute);
    } finally {
      restore();
    }
  }

  it("runs each leaf to the port's terminal, text to the sink, the operation fact in its fixed place", async () => {
    for (const [routeValue, text] of [
      [messagesRoute(), synMessagesStream()],
      [chatRoute(), synLocalStream()],
    ] as const) {
      const sunk: string[] = [];
      const trail = await withSubstitute(
        () => bytesResponse(splitBytes(text, [9, 101])),
        () => drain(realPort(), routeValue, request(), (delta) => sunk.push(delta)),
      );
      expect(trail.map((event) => event.kind), routeValue.transportKind).toEqual(["started", "usage", "operationResult", "completed"]);
      expect(trail.find((event) => event.kind === "operationResult")).toMatchObject({ status: "SUCCEEDED" });
      expect(sunk.join("")).toBe("Hello \u20ac");
      expect(JSON.stringify(trail)).not.toContain(canary);
    }
  });

  it("refuses a non-string delta at the leg before the sink, for a hand-built client on each leg (N-E-18)", async () => {
    const hostile = { kind: "text", delta: 7 } as unknown as ApiStreamChunk;
    const sunk: unknown[] = [];
    const apiTrail = await drain(
      dualPort([{ kind: "started", resolvedModel: API_MODEL, protocolVersion: API_PROTOCOL }, hostile]),
      apiRoute(),
      request(),
      (delta) => sunk.push(delta),
    );
    const localTrail = await drain(
      localPort([{ kind: "started", resolvedModel: LOCAL_MODEL, protocolVersion: LOCAL_PROTOCOL }, hostile as LocalChatChunk]),
      localRoute(),
      request(),
      (delta) => sunk.push(delta),
    );
    for (const trail of [apiTrail, localTrail]) {
      expect(trail.at(-1)).toMatchObject({ kind: "error", detail: "MALFORMED_EVENT" });
    }
    expect(sunk).toEqual([]);
  });

  it("refuses an account whose credential the composition could not resolve, before any request (N-E-19)", async () => {
    // A refused credential leaves no binding: the composition builds none. The port
    // then has nothing to call and says so; the substitute sees no call.
    await withSubstitute(
      () => bytesResponse(splitBytes(synMessagesStream(), [])),
      async (substitute) => {
        const port = portFor({ "acct-primary": binding(claudeAdapter, CLAUDE_LINES) }, {});
        expect(await port.start(messagesRoute(), request())).toEqual({
          ok: false,
          refusal: "TRANSPORT_UNAVAILABLE",
          at: "route.accountId",
        });
        expect(substitute.calls).toHaveLength(0);
      },
    );
  });

  it("turns a hostile transport failure into the closed word, with nothing of it in the trail (N-E-21)", async () => {
    for (const routeValue of [messagesRoute(), chatRoute()]) {
      for (const thrown of [
        new TypeError("fetch failed: " + canary),
        new TypeError("fetch failed", { cause: { code: "ECONNRESET", detail: canary } }),
        new AggregateError([new Error(canary)]),
      ]) {
        const trail = await withSubstitute(
          () => {
            throw thrown;
          },
          () => drain(realPort(), routeValue),
        );
        expect(trail.map((event) => event.kind)).toEqual(["error"]);
        expect(trail[0]).toMatchObject({ kind: "error", detail: "PROVIDER_UNREACHABLE" });
        expect(JSON.stringify(trail)).not.toContain(canary);
      }
    }
  });

  it("carries a 401 as authRequired from the status alone, and a 429 as its closed word", async () => {
    for (const routeValue of [messagesRoute(), chatRoute()]) {
      const denied = await withSubstitute(
        () => new Response(JSON.stringify({ error: { type: "authentication_error", message: canary } }), { status: 401 }),
        () => drain(realPort(), routeValue),
      );
      expect(denied.find((event) => event.kind === "authRequired")).toEqual({ kind: "authRequired", reason: "AUTHENTICATION_ERROR" });
      expect(JSON.stringify(denied)).not.toContain(canary);
      const limited = await withSubstitute(
        () => new Response(null, { status: 429 }),
        async (substitute) => {
          const trail = await drain(realPort(), routeValue);
          expect(substitute.calls).toHaveLength(1);
          return trail;
        },
      );
      expect(limited.at(-1)).toMatchObject({ kind: "error", detail: "PROVIDER_RATE_LIMITED" });
    }
  });
});

// ---------------------------------------------------------------------------
// P-15/A2 — the version gate fires after spawn, at the port (T-G1, ADR 0112)
// ---------------------------------------------------------------------------

describe("P-15/A2: an unobserved CLI version fails the execution after spawn, and nothing after its init is read (T-G1)", () => {
  /**
   * The 2.1.281 sample as a full success stream with a non-empty answer, its init
   * naming `version`: the sanitized capture's text is empty, and an absent output
   * would prove nothing, so the answer is `ok` in both scripts.
   */
  function successStream(version: string): readonly string[] {
    const init = JSON.parse(CAPTURED_2_1_281_SUCCESS[0] ?? "{}") as Record<string, unknown>;
    init["claude_code_version"] = version;
    const text = JSON.parse(CAPTURED_2_1_281_SUCCESS[5] ?? "{}") as Record<string, unknown>;
    (text["message"] as Record<string, unknown>)["content"] = [{ type: "text", text: "ok" }];
    return [
      JSON.stringify(init),
      ...CAPTURED_2_1_281_SUCCESS.slice(1, 5),
      JSON.stringify(text),
      ...CAPTURED_2_1_281_SUCCESS.slice(6),
    ];
  }

  /** A port whose one child writes its pid to a file before it writes a byte of stream. */
  function pidReportingPort(lines: readonly string[], pidFile: string, lingerMs: number): ModelExecutionPort {
    const root = drillRoot();
    const base = scriptedAdapter(claudeAdapter, { lines, exitCode: 0, lingerMs });
    const adapter: ProviderAdapter = {
      ...base,
      describe(req) {
        const descriptor = base.describe(req);
        const [flag, program] = descriptor.argv;
        const announce = "require('node:fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid));";
        return { ...descriptor, argv: [flag ?? "-e", announce + "\n" + (program ?? "")] };
      },
    };
    return portFor({
      "acct-primary": {
        adapter,
        binary: NODE,
        configRoot: root as AdmittedConfigRoot,
        workdir: root as AdmittedWorkdir,
        limits: limits(),
      },
    });
  }

  async function reaped(pid: number): Promise<boolean> {
    for (let waited = 0; waited < 2_000; waited += 10) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 10);
      });
    }
    return false;
  }

  it("positive control: the same stream stamped 2.1.281 spawns, yields one usage, the output, SUCCEEDED and completed", async () => {
    const pidFile = join(drillRoot(), "child.pid");
    const sunk: string[] = [];
    const trail = await drain(pidReportingPort(successStream("2.1.281"), pidFile, 0), route(), request(), (delta) => sunk.push(delta));
    expect(existsSync(pidFile)).toBe(true);
    expect(trail.map((event) => event.kind)).toEqual(["started", "usage", "state", "processExited", "operationResult", "completed"]);
    expect(trail.find((event) => event.kind === "operationResult")).toEqual({ kind: "operationResult", status: "SUCCEEDED" });
    expect(sunk).toEqual(["ok"]);
    expect(await reaped(Number.parseInt(readFileSync(pidFile, "utf8"), 10))).toBe(true);
  });

  it("B1 (v1.1): a stream with no init — each of the verifier's three — ends in error{TRANSPORT_UNAVAILABLE}, with no usage, output or verdict, and the child reaped", async () => {
    const full = successStream("2.1.281");
    const commands = CAPTURED_SUCCESS[0] ?? "";
    const thinking = CAPTURED_2_1_281_SUCCESS[1] ?? "";
    for (const [name, lines] of [
      ["the 2.1.281 body without its init", full.slice(1)],
      ["the 2.1.280 success without its init", [commands, ...CAPTURED_SUCCESS.slice(2)]],
      ["commands_changed and thinking_tokens with no init", [commands, thinking, ...full.slice(4)]],
    ] as const) {
      const pidFile = join(drillRoot(), "child.pid");
      const sunk: string[] = [];
      const trail = await drain(pidReportingPort(lines, pidFile, 5_000), route(), request(), (delta) => sunk.push(delta));
      expect(existsSync(pidFile), name).toBe(true);
      expect(trail.at(-1), name).toMatchObject({ kind: "error", refusal: "TRANSPORT_UNAVAILABLE", detail: "session failed: MALFORMED_EVENT" });
      for (const kind of ["started", "usage", "operationResult", "completed"]) {
        expect({ name, kind, present: trail.some((event) => event.kind === kind) }).toEqual({ name, kind, present: false });
      }
      expect({ name, sunk }).toEqual({ name, sunk: [] });
      expect(await reaped(Number.parseInt(readFileSync(pidFile, "utf8"), 10)), name).toBe(true);
    }
  });

  it("after spawn: init{2.1.999} then a full success stream ends in error{TRANSPORT_UNAVAILABLE}, with no usage, output or operationResult, and the child reaped", async () => {
    const pidFile = join(drillRoot(), "child.pid");
    const sunk: string[] = [];
    const trail = await drain(pidReportingPort(successStream("2.1.999"), pidFile, 5_000), route(), request(), (delta) => sunk.push(delta));
    // The child WAS spawned: the gate is in the parser, on the stream, and prevents no spend.
    expect(existsSync(pidFile)).toBe(true);
    const last = trail.at(-1);
    expect(last).toMatchObject({ kind: "error", refusal: "TRANSPORT_UNAVAILABLE", detail: "session failed: PROTOCOL_UNSUPPORTED" });
    // Nothing after the refused init was read: no usage, no output, no verdict.
    for (const kind of ["started", "usage", "operationResult", "completed"]) {
      expect({ kind, present: trail.some((event) => event.kind === kind) }).toEqual({ kind, present: false });
    }
    expect(sunk).toEqual([]);
    expect(await reaped(Number.parseInt(readFileSync(pidFile, "utf8"), 10))).toBe(true);
  });
});
