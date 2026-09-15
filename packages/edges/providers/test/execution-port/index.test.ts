import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_SUBSCRIPTION_PROVIDERS, ExecutionEvent, PROVIDER_PRESSURES } from "@acp/contracts";
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
import {
  createExecutionPort,
  executionSessionId,
  toExecutionEvent,
} from "../../src/execution-port/index.js";
import { normalizedEvent } from "../../src/events/index.js";
import type { ApiKeyBinding, ApiStreamChunk } from "../../src/api-key/index.js";
import { CLAUDE_STREAM_PROTOCOL, claudeAdapter } from "../../src/claude/index.js";
import { CODEX_APP_SERVER_PROTOCOL, codexAdapter } from "../../src/codex/index.js";
import { KIMI_ACP_PROTOCOL, kimiAdapter } from "../../src/kimi/index.js";
import type { LocalBinding, LocalChatChunk } from "../../src/local/index.js";
import type { AgentHarness } from "../../src/harness/index.js";
import { createAgentHarness } from "../../src/harness/index.js";
import { fakeApiClient, fakeLocalClient, scriptedAdapter } from "../testing/index.js";
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

function assertSharedTrail(leg: string, trail: readonly ExecutionEvent[], expected: ResolvedRoute): void {
  expect({ leg, kinds: trail.map((event) => event.kind) }).toEqual({ leg, kinds: SHARED_KINDS });

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
    tokensUsed: usage?.kind === "usage" ? usage.tokensUsed : null,
    toState: state?.kind === "state" ? state.toState : null,
    route: started?.kind === "started" ? started.route : null,
  }).toEqual({ leg, tokensUsed: TOKENS, toState: TERMINAL_STATE, route: expected });
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
  { kind: "usage", stepIndex: 0, tokensUsed: TOKENS },
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

  it("expresses the two kinds the CLI transport cannot", async () => {
    // `text` and `toolUse` are API-transport kinds: the landed CLI parsers
    // emit neither, which is why the shared scenario above is the intersection
    // rather than the union. They are drilled here instead of being smuggled
    // into the shared fixture, where they would have made the CLI legs fail
    // for a reason that has nothing to do with conformance.
    const trail = await drain(
      dualPort([
        { kind: "started", resolvedModel: API_MODEL, protocolVersion: API_PROTOCOL },
        { kind: "text", delta: "one delta, not a transcript" },
        { kind: "toolUse", tool: "search", detail: "bounded, and never the tool's whole output" },
        { kind: "write", target: "packages/adapters/src/api-key/index.ts" },
        { kind: "checkpoint", digest: "a".repeat(64) },
        { kind: "authRequired", reason: "TOKEN_EXPIRED" },
        { kind: "usage", stepIndex: 3, tokensUsed: 99 },
      ]),
      apiRoute(),
    );

    expect(trail.map((event) => event.kind)).toEqual([
      "started",
      "text",
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
  { kind: "usage", stepIndex: 0, tokensUsed: TOKENS },
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

    const distinct = new Set(Object.values(legs).map((kinds) => kinds.join(",")));
    expect({ legs: Object.keys(legs).length, distinctTrails: distinct.size }).toEqual({
      legs: 3,
      distinctTrails: 1,
    });
    expect([...distinct][0]).toBe(SHARED_KINDS.join(","));
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
    const trail = await drain(
      dualPort(
        [
          { kind: "started", resolvedModel: API_MODEL, protocolVersion: API_PROTOCOL },
          { kind: "text", delta: "a delta that does not name the key" },
          { kind: "usage", stepIndex: 0, tokensUsed: TOKENS },
        ],
        secret,
      ),
      apiRoute(),
    );

    // Redaction by unrepresentability rather than by filtering: no member of
    // `ApiStreamRequest` or `ApiStreamingClient` can carry a key, so the port
    // is never handed one and has nothing to strip. The scan is the evidence,
    // not the mechanism.
    expect(JSON.stringify(trail)).not.toContain(secret);
    expect(JSON.stringify(trail)).not.toContain("sk-");
    expect(trail.map((event) => event.kind)).toEqual(["started", "text", "usage", "completed"]);
  });

  it("never surfaces a secret the local client implementation holds", async () => {
    // The same drill on the local leg, run rather than scaffolded. A local or
    // self-hosted server behind an optional bearer token is the likeliest
    // place for a credential to be reached for, so it is the leg where the
    // proof matters most — and the `secret` parameter that threads through
    // `localPort` is only evidence when a test actually spends it.
    const secret = "lk-p84-do-not-emit-9876543210";
    const trail = await drain(
      localPort(
        [
          { kind: "started", resolvedModel: LOCAL_MODEL, protocolVersion: LOCAL_PROTOCOL },
          { kind: "text", delta: "a delta that does not name the token" },
          { kind: "usage", stepIndex: 0, tokensUsed: TOKENS },
        ],
        secret,
      ),
      localRoute(),
    );

    // Same mechanism, same evidence: no member of `LocalChatRequest` or
    // `LocalChatClient` can carry a token, so the port is never handed one and
    // has nothing to strip.
    expect(JSON.stringify(trail)).not.toContain(secret);
    expect(JSON.stringify(trail)).not.toContain("lk-");
    expect(trail.map((event) => event.kind)).toEqual(["started", "text", "usage", "completed"]);
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
    // A2: the union is the scenario, in order, once each.
    expect(union.map((event) => event.kind)).toEqual(["started", "usage", "state", "completed"]);
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
