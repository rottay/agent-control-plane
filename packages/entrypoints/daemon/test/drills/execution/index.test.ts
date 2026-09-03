import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ROUTING_CONFIG, EVIDENCE_ABSENT, loadPolicyRegistry, resolveRoute } from "@acp/accounts";
import type { CandidateEvidence, PolicyRegistry, PolicyRouteRequest, QuotaEstimate, QuotaOutcome, RoutingRequest } from "@acp/accounts";
import { AccountRecord, CONTRACT_VERSION, ExecutionEvent } from "@acp/contracts";
import type { ExecutionRequest, ModelExecutionPort, ResolvedRoute } from "@acp/contracts";
import { deriveInvocation } from "@acp/durability";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { admitBinary, admitConfigRoot, admitWorkdir, claudeAdapter, createExecutionPort } from "@acp/providers";
import type { ApiStreamChunk, ApiStreamingClient, CliBinding, ProviderAdapter, SessionDescriptor, SessionRequest } from "@acp/providers";
import {
  ExecutionEffectError,
  INTENT_STEP,
  LIFECYCLE_PLAN,
  SqliteSupervisor,
  createExecutionEffects,
  operationForStep,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";
import type { DurableInvocation, ScenarioRoot } from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The conformance fixture for the execution-port substitution (V2-B1b, C4).
 *
 * One scripted scenario, run twice through the assembled path: the route is
 * resolved by `resolveRoute` over the repository's real capability policy
 * (read, never written) and synthetic account records; the CLI leg executes it
 * over the real Claude adapter whose child process is a scripted node peer
 * speaking that provider's own wire format; the API leg executes the same
 * route over a structural `ApiStreamingClient` fake. Both legs drive the same
 * `createExecutionEffects` and the same supervisor walk over fresh, identical
 * ledger and scenario fixtures, and what is asserted is the CONTRACT: equal
 * normalized trails, equivalent ledgers, verifying evidence, no secret in
 * either, and the same refusals on both legs.
 *
 * Nothing about any provider's capability is claimed. The CLI child is a fake
 * subject behind a real adapter; the API client is a fake. Every capability
 * stays UNKNOWN by law until V5.
 *
 * The providers package's own test helper is deliberately not imported: it is
 * unexported scaffolding, and this file writes its own argv builder.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..", "..");
const POLICY = join(REPO_ROOT, "packages", "domains", "accounts", "policy", "capability-policy.json");
const TMP_ROOT = realpathSync(tmpdir());
const NODE = realpathSync(process.execPath);

const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const ACCOUNT = "acct-b1b-fixture";
const TASK = "b1b00000-0000-4000-8000-000000000001";
const NOW = "2026-08-30T12:00:00Z";
const RESET = "2026-08-30T13:00:00Z";
const RESOLVED_AT = "2026-08-30T12:00:05.000Z";
const TOKENS = 1_234;
const TERMINAL_STATE = "TURN_COMPLETED";
const RESOLVED_MODEL = "claude-opus-5-20260115";
/** Closed over by the API client, and nowhere else. If it ever surfaces, the scan below finds it. */
const SECRET = "sk-b1b-canary-do-not-emit-4242";

const scenarios: string[] = [];
const ledgers: Ledger[] = [];
const temporaries: string[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function drillRoot(): string {
  const created = mkdtempSync(join(TMP_ROOT, "acp-b1b-execution-"));
  chmodSync(created, 0o700);
  temporaries.push(created);
  return created;
}

// ---------------------------------------------------------------------------
// Step 1: the route, resolved over the real policy and synthetic records
// ---------------------------------------------------------------------------

function record(provider: string, enabledModels: readonly string[]): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId: ACCOUNT,
    provider,
    alias: ACCOUNT,
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-b1b-" + ACCOUNT,
    credentialRef: null,
    plan: "max",
    enabledModels: [...enabledModels],
    knownLimits: { weekly: 1_000_000 },
    resetSchedule: { kind: "DECLARED", nextResetAt: RESET, timezone: "UTC", confidence: "HIGH" },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      estimatedAt: NOW,
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-b1b-" + ACCOUNT,
    contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
  });
  if (!parsed.success) throw new Error("fixture is not a valid AccountRecord");
  return parsed.data;
}

function estimate(): QuotaEstimate {
  return {
    accountId: ACCOUNT,
    limitKey: "weekly",
    limitTokens: 1_000_000,
    observedTokensUsed: 500_000,
    observationCount: 3,
    remainingRatio: 0.5,
    estimatedTokensRemaining: 500_000,
    overBudget: false,
    confidence: "MEDIUM",
    estimatedAt: NOW,
    reset: { kind: "DECLARED", nextResetAt: RESET, timezone: "UTC", millisUntilReset: 3_600_000, confidence: "HIGH" },
  };
}

function absent(): CandidateEvidence {
  return { accountId: ACCOUNT, acceptance: EVIDENCE_ABSENT, contextAffinity: EVIDENCE_ABSENT, capabilities: { known: false } };
}

function routing(): RoutingRequest {
  const outcome: QuotaOutcome = { ok: true, estimate: estimate() };
  return {
    records: [record("claude", ["opus"])],
    estimates: [{ accountId: ACCOUNT, outcome }],
    evidence: [absent()],
    task: {
      model: "never-chosen-by-policy",
      estimatedTokens: 10_000,
      estimatedDurationSeconds: 60,
      reserveTokens: 5_000,
      requiredCapabilities: [],
    },
    config: DEFAULT_ROUTING_CONFIG,
    now: NOW,
  };
}

function shippedRegistry(): PolicyRegistry {
  const outcome = loadPolicyRegistry(POLICY);
  if (!outcome.ok) throw new Error("the shipped registry did not load: " + outcome.reason);
  return outcome.registry;
}

function requestFor(transportKind: PolicyRouteRequest["transportKind"]): PolicyRouteRequest {
  return { role: "implementer", routing: routing(), transportKind };
}

/** The route both legs execute: B1a's entry point, consumed across a package boundary. */
function resolvedCliRoute(): ResolvedRoute {
  const outcome = resolveRoute(requestFor("CLI_SUBSCRIPTION"), shippedRegistry(), RESOLVED_AT);
  if (!outcome.ok) throw new Error("the CLI route did not resolve: " + outcome.reason + " at " + outcome.at);
  return outcome.route;
}

// ---------------------------------------------------------------------------
// Step 2: the CLI leg -- the real Claude adapter over a scripted node peer
// ---------------------------------------------------------------------------

/** Claude headless stream JSON: `started`, a usage-bearing turn, a result. */
const CLAUDE_LINES: readonly string[] = [
  JSON.stringify({ type: "system", subtype: "init", model: RESOLVED_MODEL }),
  JSON.stringify({ type: "assistant", message: { usage: { output_tokens: TOKENS } } }),
  JSON.stringify({ type: "result", subtype: "turn_completed" }),
];

/**
 * The fixture's own argv builder. Only `describe` is replaced: the adapter's
 * `parse`, `negotiate` and `provider` are the shipped ones, so what runs is the
 * real parser over a child that speaks Claude's wire format.
 */
function scriptedClaude(lines: readonly string[]): ProviderAdapter {
  const program = [
    "const lines = " + JSON.stringify([...lines]) + ";",
    "for (const line of lines) process.stdout.write(line + '\\n');",
    "process.exit(0);",
  ].join("\n");
  return {
    ...claudeAdapter,
    describe(request: SessionRequest): SessionDescriptor {
      return {
        provider: "claude",
        argv: ["-e", program],
        env: { PATH: "/usr/bin:/bin" },
        cwd: request.workdir,
      };
    },
  };
}

function cliBinding(lines: readonly string[]): CliBinding {
  const root = drillRoot();
  const context = { provider: "claude", taskId: TASK };
  return {
    adapter: scriptedClaude(lines),
    // Admitted through the providers package's own admissions, exactly as the
    // daemon admits its config's binding: canonical, owned, owner-only.
    binary: admitBinary(NODE, context),
    configRoot: admitConfigRoot(root, context),
    workdir: admitWorkdir(root, context),
    limits: { timeoutMs: 10_000, outputBudgetBytes: 64 * 1024, interruptGraceMs: 120, termGraceMs: 120 },
  };
}

function cliPort(): ModelExecutionPort {
  // The CLI leg only -- the deployment law 6 describes and the daemon builds.
  return createExecutionPort({ bindings: new Map([[ACCOUNT, cliBinding(CLAUDE_LINES)]]) });
}

// ---------------------------------------------------------------------------
// Step 3: the API leg -- a structural `ApiStreamingClient` fake
// ---------------------------------------------------------------------------

/** The transport intersection, as this transport speaks it. */
const API_SCENARIO: readonly ApiStreamChunk[] = [
  { kind: "started", resolvedModel: RESOLVED_MODEL, protocolVersion: "api/streaming-1" },
  { kind: "usage", stepIndex: 1, tokensUsed: TOKENS },
  { kind: "state", toState: TERMINAL_STATE },
];

/** The fake holds the secret where a real implementation would hold a key: in its closure. */
function fakeClient(chunks: readonly ApiStreamChunk[], secret: string): ApiStreamingClient {
  return {
    provider: "claude",
    models: ["opus"],
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(): AsyncIterable<ApiStreamChunk> {
      void secret;
      for (const chunk of chunks) yield chunk;
    },
  };
}

function apiPort(chunks: readonly ApiStreamChunk[] = API_SCENARIO): ModelExecutionPort {
  return createExecutionPort({
    bindings: new Map([[ACCOUNT, cliBinding(CLAUDE_LINES)]]),
    apiBindings: new Map([[ACCOUNT, { client: fakeClient(chunks, SECRET) }]]),
  });
}

// ---------------------------------------------------------------------------
// Step 4: both legs through createExecutionEffects and the same walk
// ---------------------------------------------------------------------------

/** Wraps a port so the events the effect drains are also visible to the fixture. */
function recording(port: ModelExecutionPort, trail: ExecutionEvent[]): ModelExecutionPort {
  return {
    async start(route, request) {
      const started = await port.start(route, request);
      if (!started.ok) return started;
      return {
        ok: true,
        sessionId: started.sessionId,
        route: started.route,
        events: async function* (): AsyncIterable<ExecutionEvent> {
          for await (const event of started.events()) {
            trail.push(event);
            yield event;
          }
        },
      };
    },
    interrupt: (sessionId) => port.interrupt(sessionId),
    healthProbe: (route) => port.healthProbe(route),
  };
}

function invocation(): DurableInvocation {
  return deriveInvocation(TASK, 1, "2026-08-30T12:00:00.000Z", "b".repeat(64));
}

function executionRequest(): ExecutionRequest {
  return { taskId: TASK, attempt: 1, identity: EMITTED_BY, reattach: null };
}

interface Walk {
  readonly trail: readonly ExecutionEvent[];
  readonly state: string | null;
  readonly eventCount: number;
  readonly headEventSha256: string;
  readonly types: readonly string[];
  readonly evidence: readonly string[];
  readonly markerJson: string;
  readonly probe: string;
}

async function walk(name: string, port: ModelExecutionPort, route: ResolvedRoute): Promise<Walk> {
  const root = scenario(name);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const inv = invocation();
  const trail: ExecutionEvent[] = [];
  const effects = createExecutionEffects({
    port: recording(port, trail),
    route,
    request: executionRequest(),
    scenarioRoot: root,
  });
  const supervisor = new SqliteSupervisor({
    ledger,
    invocation: inv,
    effects,
    emittedBy: EMITTED_BY,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    initiativeId: INITIATIVE_ID,
  });
  const run = await supervisor.runToCheckpoint();
  const status = ledger.status();
  const operation = operationForStep(inv, INTENT_STEP);
  const home = join(root, "executions");
  const evidence = existsSync(home) ? readdirSync(home).sort() : [];
  const markerPath = join(home, operation.operationId + ".json");
  return {
    trail,
    state: run.finalState,
    eventCount: status.eventCount,
    headEventSha256: status.headEventSha256,
    types: ledger.listEvents({ limit: 200 }).events.map((entry) => entry.event.type),
    evidence,
    markerJson: existsSync(markerPath) ? readFileSync(markerPath, "utf8") : "",
    probe: await effects.probe(operation),
  };
}

/** The transport-neutral projection the two legs must agree on. */
function normalized(trail: readonly ExecutionEvent[]): Record<string, unknown> {
  return {
    kinds: trail.map((event) => event.kind),
    everyEventValid: trail.every((event) => ExecutionEvent.safeParse(event).success),
    usageTotal: trail.reduce((sum, event) => (event.kind === "usage" ? sum + event.tokensUsed : sum), 0),
    completed: trail.filter((event) => event.kind === "completed").length,
    terminalState: trail.find((event) => event.kind === "state")?.kind === "state"
      ? (trail.find((event) => event.kind === "state") as { toState: string }).toState
      : null,
  };
}

const SHARED_KINDS = ["started", "usage", "state", "completed"];

// ---------------------------------------------------------------------------
// The drills
// ---------------------------------------------------------------------------

describe("the route is resolved over the repository's real policy", () => {
  it("resolves the CLI route from the shipped document and synthetic records, and the document names no API transport", () => {
    const registry = shippedRegistry();
    const route = resolvedCliRoute();
    expect(route).toEqual({
      provider: "claude",
      model: "opus",
      accountId: ACCOUNT,
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: registry.policyVersion,
      resolvedAt: RESOLVED_AT,
    });

    // The real document admits CLI_SUBSCRIPTION only, so a resolution over it
    // cannot produce an API_KEY route: the policy seam refuses by its own
    // name. The API leg below therefore executes the resolved route with the
    // transport kind substituted -- stated here rather than hidden in a fixture
    // registry that would make the document say something it does not.
    expect(registry.models.every((entry) => entry.transports.join(",") === "CLI_SUBSCRIPTION")).toBe(true);
    expect(resolveRoute(requestFor("API_KEY"), registry, RESOLVED_AT)).toEqual({
      ok: false,
      reason: "POLICY_NO_ELIGIBLE_MODEL",
      at: "models",
    });
  });
});

describe("one scenario through both legs of the assembled path", () => {
  it("produces the same normalized trail and the same checkpointed ledger from the CLI and API legs", async () => {
    const route = resolvedCliRoute();
    const cli = await walk("b1b-execution-cli", cliPort(), route);
    const api = await walk("b1b-execution-api", apiPort(), { ...route, transportKind: "API_KEY" });

    // The trail assertion, made once and applied to both legs: the kinds and
    // their order, every event's contract validity, the measurement, exactly
    // one terminal `completed`, the terminal token.
    const expected = {
      kinds: SHARED_KINDS,
      everyEventValid: true,
      usageTotal: TOKENS,
      completed: 1,
      terminalState: TERMINAL_STATE,
    };
    expect({ leg: "cli", ...normalized(cli.trail) }).toEqual({ leg: "cli", ...expected });
    expect({ leg: "api", ...normalized(api.trail) }).toEqual({ leg: "api", ...expected });
    expect(normalized(cli.trail)).toEqual(normalized(api.trail));

    // The provider's own resolution travels verbatim on both legs, beside the
    // route each leg was handed -- the route is echoed, never restated.
    const started = (trail: readonly ExecutionEvent[]) => trail.find((event) => event.kind === "started");
    const cliStarted = started(cli.trail);
    const apiStarted = started(api.trail);
    if (cliStarted?.kind !== "started" || apiStarted?.kind !== "started") throw new Error("expected started events");
    expect({ cli: cliStarted.resolvedModel, api: apiStarted.resolvedModel }).toEqual({ cli: RESOLVED_MODEL, api: RESOLVED_MODEL });
    expect(cliStarted.route).toEqual(route);
    expect(apiStarted.route).toEqual({ ...route, transportKind: "API_KEY" });

    // The same walk reached the same terminal state with equivalent ledger
    // content: the same invocation over two fresh ledgers yields the same
    // bytes at the head, because the effect's content never enters the log.
    expect({ cli: cli.state, api: api.state }).toEqual({ cli: "CHECKPOINTED", api: "CHECKPOINTED" });
    expect(cli.types).toEqual(LIFECYCLE_PLAN.map((step) => step.eventType));
    expect(api.types).toEqual(cli.types);
    expect({ count: api.eventCount, head: api.headEventSha256 }).toEqual({ count: cli.eventCount, head: cli.headEventSha256 });
  });

  it("leaves verifying evidence for both legs under executions/, and never the toy's effects/", async () => {
    const route = resolvedCliRoute();
    const cli = await walk("b1b-evidence-cli", cliPort(), route);
    const api = await walk("b1b-evidence-api", apiPort(), { ...route, transportKind: "API_KEY" });
    const operationId = operationForStep(invocation(), INTENT_STEP).operationId;

    for (const [leg, done] of [["cli", cli], ["api", api]] as const) {
      expect({ leg, evidence: done.evidence, probe: done.probe }).toEqual({
        leg,
        evidence: [operationId + ".json"],
        probe: "DONE",
      });
      const marker: unknown = JSON.parse(done.markerJson);
      expect(marker).toMatchObject({ operationId, eventCount: SHARED_KINDS.length });
      expect((marker as { trailSha256: string }).trailSha256).toMatch(/^[0-9a-f]{64}$/);
      expect((marker as { operationDigest: string }).operationDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // The same operation, so the same operation digest; the trails differ
    // only in transport identity, so their digests may differ -- and do.
    const digestOf = (json: string): string => (JSON.parse(json) as { operationDigest: string }).operationDigest;
    expect(digestOf(api.markerJson)).toBe(digestOf(cli.markerJson));
    for (const name of scenarios) {
      expect(existsSync(join(resolveScenarioRoot(name), "effects"))).toBe(false);
    }
  });

  it("never surfaces the API client's secret in a normalized event or in the evidence", async () => {
    const route = resolvedCliRoute();
    const api = await walk("b1b-redaction-api", apiPort(), { ...route, transportKind: "API_KEY" });
    // Redaction by unrepresentability: no member of the streaming interface
    // can carry the secret, so it never reaches the port and nothing has to
    // strip it. The scan is the evidence, not the mechanism.
    expect(JSON.stringify(api.trail)).not.toContain(SECRET);
    expect(JSON.stringify(api.trail)).not.toContain("sk-");
    expect(api.markerJson).not.toContain(SECRET);
    expect(api.markerJson).not.toContain("sk-");
    expect(api.markerJson.length).toBeGreaterThan(0);
  });

  it("refuses in parity on both legs: an account with no binding, and a reattach", async () => {
    const route = resolvedCliRoute();
    const legs = [
      ["cli", cliPort(), route],
      ["api", apiPort(), { ...route, transportKind: "API_KEY" }],
    ] as const;
    for (const [leg, port, legRoute] of legs) {
      const noBinding = await port.start({ ...legRoute, accountId: "acct-nobody" }, executionRequest());
      expect({ leg, noBinding }).toEqual({
        leg,
        noBinding: { ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" },
      });
      const reattach = await port.start(legRoute, { ...executionRequest(), reattach: "yesterday" });
      expect({ leg, reattach }).toEqual({
        leg,
        reattach: { ok: false, refusal: "REATTACH_UNAVAILABLE", at: "request.reattach" },
      });

      // Through the effect: the refusal becomes a classified throw, nothing
      // is recorded, and the walk would fail closed rather than say DONE.
      const root = scenario("b1b-refusal-" + leg);
      const effects = createExecutionEffects({
        port,
        route: { ...legRoute, accountId: "acct-nobody" },
        request: executionRequest(),
        scenarioRoot: root,
      });
      const operation = operationForStep(invocation(), INTENT_STEP);
      await expect(effects.apply(operation)).rejects.toBeInstanceOf(ExecutionEffectError);
      await expect(effects.apply(operation)).rejects.toMatchObject({ refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" });
      expect(existsSync(join(root, "executions"))).toBe(false);
      expect(await effects.probe(operation)).toBe("NOT_DONE");
    }
  });

  it("is not vacuous: a diverging API script is caught by the same comparison", async () => {
    // The discriminating control. An API stream that speaks one more kind
    // than the CLI leg can -- a text delta -- still walks to a checkpoint, and
    // the equality above is exactly what refuses to call the two legs equal.
    const route = resolvedCliRoute();
    const cli = await walk("b1b-control-cli", cliPort(), route);
    const diverging = await walk(
      "b1b-control-api",
      apiPort([API_SCENARIO[0]!, { kind: "text", delta: "a delta the CLI leg cannot say" }, ...API_SCENARIO.slice(1)]),
      { ...route, transportKind: "API_KEY" },
    );
    expect(diverging.state).toBe("CHECKPOINTED");
    expect(normalized(diverging.trail)).not.toEqual(normalized(cli.trail));
    expect(normalized(diverging.trail)["kinds"]).toEqual(["started", "text", "usage", "state", "completed"]);
  });

  it("refuses the API route by transport when the port is built the way the daemon builds it", async () => {
    // Law 6 by construction: the daemon's port carries the CLI leg alone, so
    // the API route is refused at the transport, before any account is asked.
    const route = resolvedCliRoute();
    const outcome = await cliPort().start({ ...route, transportKind: "API_KEY" }, executionRequest());
    expect(outcome).toEqual({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.transportKind" });
  });
});
