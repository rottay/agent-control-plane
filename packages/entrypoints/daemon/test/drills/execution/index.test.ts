import { spawnSync } from "node:child_process";
import type { TaskEnvelope } from "@acp/contracts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ROUTING_CONFIG, EVIDENCE_ABSENT, loadPolicyRegistry, resolveRoute } from "@acp/accounts";
import type { CandidateEvidence, PolicyRegistry, PolicyRouteRequest, QuotaEstimate, QuotaOutcome, RoutingRequest } from "@acp/accounts";
import { AccountRecord, CONTRACT_VERSION, ExecutionEvent, TERMINAL_STATES } from "@acp/contracts";
import type { ExecutionRequest, ModelExecutionPort, ResolvedRoute } from "@acp/contracts";
import { deriveInvocation } from "@acp/durability";
import { openLedger } from "@acp/ledger";
import type { ExecutionRouteReadModel, Ledger } from "@acp/ledger";
import { admitBinary, admitConfigRoot, admitWorkdir, claudeAdapter, createExecutionPort } from "@acp/providers";
import type { ApiStreamChunk, ApiStreamingClient, CliBinding, ProviderAdapter, SessionDescriptor, SessionRequest } from "@acp/providers";
import {
  ExecutionEffectError,
  INTENT_STEP,
  LIFECYCLE_PLAN,
  SqliteSupervisor,
  USAGE_TOKENS_MAX,
  buildEvent,
  createExecutionEffects,
  operationForStep,
  recordTokenObservation,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
  settleFailure,
  usageTransitionId,
} from "@acp/runtime";
import type { DurableInvocation, ScenarioRoot, UsageSample } from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalSubmission, canonicalSubmissionDigest } from "../../../src/daemon-child/index.js";
import type { DaemonExecutionConfig, DaemonSubmission } from "../../../src/daemon-child/index.js";
import { startDaemon, stopDaemon } from "../../../src/index.js";

/**
 * Make a fixture directory an actual worktree.
 *
 * A "worktree" that is not a git repository is not a worktree, and since V2
 * concurrency C4 the walk observes the one it writes into. Everything the
 * fixture already wrote is committed, so the only changes the observer can see
 * are the walk's own — which is what makes a conformant drill conformant and a
 * violating one violating.
 *
 * A temporary directory, never this repository (stop 3).
 */
function initWorktree(directory: string): void {
  const git = (...args: string[]): void => {
    spawnSync("/usr/bin/git", args, { cwd: directory, encoding: "utf8" });
  };
  git("init", "--quiet");
  git("config", "user.email", "drill@example.invalid");
  git("config", "user.name", "drill");
  git("add", "-A");
  git("commit", "--allow-empty", "-q", "-m", "fixture base");
}


/**
 * The packet's envelope, required on every daemon since V2 concurrency C4.
 *
 * A drill declares a write-set wide enough for what its fake provider actually
 * touches: the point of the gate is that a walk writing outside its declaration
 * is caught, so a drill that is not testing that must declare honestly.
 */
function envelopeFor(taskId: string, initiativeId: string, writeSet: readonly string[] = ["src/**"]): TaskEnvelope {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    initiativeId,
    title: "a drill packet",
    objective: "walk the plan",
    classification: "MECHANICAL",
    issuedBy: EMITTED_BY,
    issuedAt: SUBMITTED_AT,
    authority: [],
    readSet: [],
    writeSet: [...writeSet],
    conflictKeys: [],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "a patch" },
    validation: { commands: [], independentVerifierRequired: false },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1_000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 10 },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: false, maxStepsWithoutCheckpoint: 5 },
  } as unknown as TaskEnvelope;
}


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
 * normalized trails, ledgers equal modulo the recorded route, verifying
 * evidence, no secret in either, and the same refusals on both legs.
 *
 * V2-B1c adds the second half of the story: the route each leg was admitted on
 * reaches the append-only ledger through this same production path and is
 * projected per attempt. The version it carries is the shipped policy
 * document's own, which is what makes "immutable policy version" a fact here
 * rather than a field name.
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
/** What the drill asks the subject to do, echoed back by it (V2-B1c). */
const DRILL_OBJECTIVE = "echo the instruction you were given, then stop";
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
  initWorktree(created);
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
        delivery: { kind: "STDIN" },
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

const SUBMITTED_AT = "2026-08-30T12:00:00.000Z";

/** The submission this fixture's walks declare, for a given admitted route. */
function submissionFor(route: ResolvedRoute): DaemonSubmission {
  return { taskId: TASK, attempt: 1, submittedAt: SUBMITTED_AT, initiativeId: INITIATIVE_ID, route };
}

function invocationFor(route: ResolvedRoute): DurableInvocation {
  return deriveInvocation(TASK, 1, SUBMITTED_AT, canonicalSubmissionDigest(submissionFor(route)));
}

/**
 * The invocation both legs of the conformance walk share (V2-B1c, stage 2).
 *
 * It is the CLI submission's digest, and both legs use it deliberately: this
 * fixture compares two TRANSPORTS for ONE submission — the API leg executes
 * the same resolved route with the transport kind substituted at the port, as
 * the policy section above states, because the shipped document admits no API
 * transport. One submission therefore means one digest, which is what keeps
 * every event before the INTENT byte-identical across the two legs and keeps
 * the equality-modulo-route assertion measuring the route rather than the
 * submission.
 *
 * It is computed rather than written as arbitrary hex, because since stage 2
 * the digest has a meaning: a fixture stating one no submission produces would
 * be exactly the quiet untruth the door now refuses.
 */
function invocation(): DurableInvocation {
  return invocationFor(resolvedCliRoute());
}

function executionRequest(): ExecutionRequest {
  return {
    taskId: TASK,
    attempt: 1,
    identity: EMITTED_BY,
    instructions: DRILL_OBJECTIVE,
    reattach: null,
  };
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
  /** Every event's canonical body with the recorded route removed (V2-B1c, R1). */
  readonly bodiesWithoutRoute: readonly string[];
  /** The route the ledger recorded for this attempt, read back through the projection. */
  readonly recordedRoute: ExecutionRouteReadModel | null;
  /** The route as it sits in the INTENT event's own payload. */
  readonly intentPayloadRoute: unknown;
  /** How many events in the walk carry a route at all. Exactly one, by law. */
  readonly eventsCarryingRoute: number;
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
    // The SAME binding the effect port above was built from (V2-B1c). One
    // value, two readers: what the walk records cannot be a different route
    // from the one the execution ran.
    route,
  });
  const run = await supervisor.runToCheckpoint();
  const status = ledger.status();
  const operation = operationForStep(inv, INTENT_STEP);
  const home = join(root, "executions");
  const evidence = existsSync(home) ? readdirSync(home).sort() : [];
  const markerPath = join(home, operation.operationId + ".json");
  const events = ledger.listEvents({ limit: 200 }).events;
  const intent = events.find((entry) => entry.event.type === "RUN_STARTED");
  return {
    trail,
    state: run.finalState,
    eventCount: status.eventCount,
    headEventSha256: status.headEventSha256,
    types: events.map((entry) => entry.event.type),
    evidence,
    markerJson: existsSync(markerPath) ? readFileSync(markerPath, "utf8") : "",
    probe: await effects.probe(operation),
    // The canonical body with the recorded route lifted out. Two legs on two
    // transports agree on everything else, so this is what "the same walk"
    // means once the route is in the log (V2-B1c, R1).
    bodiesWithoutRoute: events.map((entry) => {
      const body: unknown = JSON.parse(entry.canonicalJson);
      const payload = (body as { payload?: Record<string, unknown> }).payload;
      if (payload !== undefined) delete payload["route"];
      return JSON.stringify(body);
    }),
    recordedRoute: ledger.getExecutionRoute(inv.taskId, inv.attempt),
    intentPayloadRoute: intent?.event.payload["route"] ?? null,
    eventsCarryingRoute: events.filter((entry) => entry.event.payload["route"] !== undefined).length,
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
    // content.
    //
    // This assertion was head-digest equality until V2-B1c, on the premise
    // that "the effect's content never enters the log". B1c falsifies that
    // premise deliberately: the admitted route now rides the INTENT event, and
    // these two legs run routes that differ in exactly `transportKind`, so
    // their canonical bytes diverge at that one event and the head digests
    // must differ. The equality is therefore restated one level down rather
    // than dropped -- equal counts, equal event-type sequence, and equal
    // canonical bodies MODULO the recorded route -- and the divergence itself
    // is asserted rather than tolerated, in both directions:
    // the heads differ, and the routes differ in exactly the one field.
    expect({ cli: cli.state, api: api.state }).toEqual({ cli: "CHECKPOINTED", api: "CHECKPOINTED" });
    expect(cli.types).toEqual(LIFECYCLE_PLAN.map((step) => step.eventType));
    expect(api.types).toEqual(cli.types);
    expect(api.eventCount).toBe(cli.eventCount);
    expect(api.bodiesWithoutRoute).toEqual(cli.bodiesWithoutRoute);

    // The route is what the two ledgers legitimately disagree about, so the
    // head digests must NOT match. Asserting the inequality keeps this from
    // silently becoming vacuous if the route ever stopped being recorded.
    expect(api.headEventSha256).not.toBe(cli.headEventSha256);

    // Recorded, per attempt, through the projection -- and differing in
    // exactly the transport, agreeing on everything the policy chose.
    expect(cli.recordedRoute).toMatchObject({ ...route, taskId: TASK, attempt: 1 });
    expect(api.recordedRoute).toMatchObject({
      ...route,
      transportKind: "API_KEY",
      taskId: TASK,
      attempt: 1,
    });
    const differing = (["provider", "model", "accountId", "transportKind", "capabilityPolicyVersion", "resolvedAt"] as const)
      .filter((field) => cli.recordedRoute?.[field] !== api.recordedRoute?.[field]);
    expect(differing).toEqual(["transportKind"]);
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

  it("records the admitted route in the ledger through the production walk, and the version is the shipped document's", async () => {
    // P1/P2. Reachability, asserted through the assembled path: the route is
    // resolved over the repository's real policy, executed by the port, and
    // read back out of the ledger's own projection. Nothing here hand-builds
    // an event -- a fixture that constructed the payload itself would prove
    // the schema and nothing about whether production reaches it.
    const registry = shippedRegistry();
    const route = resolvedCliRoute();
    const done = await walk("b1c-recorded-cli", cliPort(), route);

    expect(done.state).toBe("CHECKPOINTED");
    expect(done.recordedRoute).toEqual({
      taskId: TASK,
      attempt: 1,
      provider: "claude",
      model: "opus",
      accountId: ACCOUNT,
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: registry.policyVersion,
      resolvedAt: RESOLVED_AT,
      recordedAt: done.recordedRoute?.recordedAt ?? "",
      sequence: done.recordedRoute?.sequence ?? 0,
    });

    // The version is the document's, not a fixture's: it travels on the choice
    // from the one producer of it, and nothing downstream re-read the file.
    expect(done.recordedRoute?.capabilityPolicyVersion).toBe(registry.policyVersion);
    expect(registry.policyVersion.length).toBeGreaterThan(0);

    // The recording instant is the event's own, and the position is a real one.
    expect(done.recordedRoute?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(done.recordedRoute?.sequence).toBeGreaterThan(0);
  });

  it("carries the route on exactly one event of the walk, and never restates it", async () => {
    // P4. One fact, one place: the INTENT beat declares the run and the route
    // it will happen on; no later event repeats it, exactly as no event after
    // TASK_DISCOVERED repeats the initiative.
    const done = await walk("b1c-one-place-cli", cliPort(), resolvedCliRoute());
    expect(done.eventsCarryingRoute).toBe(1);
    expect(done.intentPayloadRoute).toEqual({
      provider: "claude",
      model: "opus",
      accountId: ACCOUNT,
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: shippedRegistry().policyVersion,
      resolvedAt: RESOLVED_AT,
    });
  });

  it("keeps the API client's secret out of the ledger the recorded route now rides in", async () => {
    // The canary, extended to the surface V2-B1c opened. Recording a route
    // puts new bytes in the log, so the scan that proved the trail and the
    // evidence clean has to cover the log as well or the packet widens the
    // exposure without widening the proof.
    const route = resolvedCliRoute();
    const root = scenario("b1c-ledger-canary");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);
    const inv = invocation();
    const effects = createExecutionEffects({
      port: apiPort(),
      route: { ...route, transportKind: "API_KEY" },
      request: executionRequest(),
      scenarioRoot: root,
    });
    await new SqliteSupervisor({
      ledger,
      invocation: inv,
      effects,
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: INITIATIVE_ID,
      route: { ...route, transportKind: "API_KEY" },
    }).runToCheckpoint();

    const serialized = ledger
      .listEvents({ limit: 200 })
      .events.map((entry) => entry.canonicalJson)
      .join("\n");
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("sk-");
    // No absolute path, no scenario directory, no transcript key either.
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain(root);
    // And the route really is in there, so the scan above is not vacuous.
    expect(serialized).toContain("capabilityPolicyVersion");
  });

  it("rebuilds the recorded route byte-identically and reports no integrity problem", async () => {
    // B1/B4. The single-implementation design gives replay equality for free;
    // this proves the new arm did not break it, and that the drills' own
    // rebuild receipt still holds now that the route is recorded.
    const done = await walk("b1c-rebuild-cli", cliPort(), resolvedCliRoute());
    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot("b1c-rebuild-cli")));
    ledgers.push(ledger);

    const before = ledger.getExecutionRoute(TASK, 1);
    const rebuild = ledger.rebuildReadModel();
    const after = ledger.getExecutionRoute(TASK, 1);

    expect(rebuild.executionRouteRows).toBe(1);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after).toEqual(done.recordedRoute);
    expect(ledger.verifyIntegrity().problems.filter((problem) => problem.kind === "PROJECTION")).toEqual([]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
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

/**
 * The route is pinned by the submission (V2-B1c, stage 2 — I3/R2/N4).
 *
 * Stage 1 recorded the route and left it unpinned. These are the two windows a
 * resume can land in, and before this stage only one of them was closed:
 *
 * - **After the INTENT append** the ledger already held a route, so rebuilding
 *   it under a different one produced different bytes under the same key and
 *   the append failed. Late, but closed.
 * - **Before the INTENT append** nothing carried the route at all.
 *   `assertInvocationContinuity` rebuilds step 0, step 0 is a PLAIN beat, and
 *   its bytes were identical whichever route the resume arrived with. The
 *   changed route was adopted in silence. That is the load-bearing case.
 *
 * Binding the route into the submission digest closes the second window with
 * the machinery that already existed: the digest rides every event's base
 * payload, so a changed route changes step 0's bytes and continuity refuses.
 */
describe("a changed route cannot be adopted by a resume", () => {
  /** Everything the plan appends strictly before the INTENT beat. */
  function seedThroughStep(
    ledger: Ledger,
    inv: DurableInvocation,
    route: ResolvedRoute,
    lastIndexExclusive: number,
  ): void {
    for (const step of LIFECYCLE_PLAN.slice(0, lastIndexExclusive)) {
      ledger.append(
        buildEvent({
          invocation: inv,
          step,
          emittedBy: EMITTED_BY,
          initiativeId: INITIATIVE_ID,
          plan: LIFECYCLE_PLAN,
          route,
        }),
      );
    }
  }

  /** A port nothing may reach: every case here refuses before a beat runs. */
  const refusingEffects = {
    apply: (): Promise<void> => Promise.reject(new Error("no effect may run in this drill")),
    probe: (): Promise<"NOT_DONE"> => Promise.resolve("NOT_DONE" as const),
  };

  function supervisorFor(ledger: Ledger, inv: DurableInvocation, route: ResolvedRoute): SqliteSupervisor {
    return new SqliteSupervisor({
      ledger,
      invocation: inv,
      effects: refusingEffects,
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: INITIATIVE_ID,
      route,
    });
  }

  it("N4(b): refuses before the intent was ever appended, and changes nothing", async () => {
    const routeA = resolvedCliRoute();
    const routeB = { ...routeA, accountId: "acct-substituted-mid-crash" };
    const root = scenario("b1c2-n4b");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);

    const invA = invocationFor(routeA);
    seedThroughStep(ledger, invA, routeA, INTENT_STEP.index);

    // The crash window, stated as a fact rather than assumed: the plan is
    // partway through and no RUN_STARTED exists, so nothing anywhere in the
    // ledger names a route yet.
    const before = ledger.status();
    expect(before.eventCount).toBe(INTENT_STEP.index);
    expect(ledger.listEvents({ limit: 50 }).events.map((e) => e.event.type)).not.toContain("RUN_STARTED");
    expect(ledger.getExecutionRoute(TASK, 1)).toBeNull();

    // The resume arrives on a different account. It is a different submission,
    // and the digest says so before anything is asked of the ledger.
    const invB = invocationFor(routeB);
    expect(invB.submissionDigest).not.toBe(invA.submissionDigest);

    await expect(supervisorFor(ledger, invB, routeB).runToCheckpoint()).rejects.toThrow(
      /begun by a different invocation/,
    );

    // Zero delta: refusing has to leave the ledger exactly as it was, or the
    // refusal has itself become a write.
    const after = ledger.status();
    expect({ count: after.eventCount, head: after.headEventSha256 }).toEqual({
      count: before.eventCount,
      head: before.headEventSha256,
    });
    expect(ledger.getExecutionRoute(TASK, 1)).toBeNull();

    // And the original submission still resumes, which is what proves the
    // refusal is about the route rather than about resuming at all.
    await expect(supervisorFor(ledger, invA, routeA).runToCheckpoint()).rejects.toThrow(
      /no effect may run in this drill/,
    );
    expect(ledger.listEvents({ limit: 50 }).events.map((e) => e.event.type)).toContain("RUN_STARTED");
    expect(ledger.getExecutionRoute(TASK, 1)).toMatchObject({ accountId: routeA.accountId });
  });

  it("N4(a): refuses after the intent was appended, and changes nothing", async () => {
    const routeA = resolvedCliRoute();
    const routeB = { ...routeA, model: "sonnet" };
    const root = scenario("b1c2-n4a");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);

    const invA = invocationFor(routeA);
    seedThroughStep(ledger, invA, routeA, INTENT_STEP.index + 1);

    const before = ledger.status();
    expect(ledger.getExecutionRoute(TASK, 1)).toMatchObject({ model: routeA.model });

    const invB = invocationFor(routeB);
    expect(invB.submissionDigest).not.toBe(invA.submissionDigest);
    await expect(supervisorFor(ledger, invB, routeB).runToCheckpoint()).rejects.toThrow();

    const after = ledger.status();
    expect({ count: after.eventCount, head: after.headEventSha256 }).toEqual({
      count: before.eventCount,
      head: before.headEventSha256,
    });
    // The recorded route is still the one that actually ran.
    expect(ledger.getExecutionRoute(TASK, 1)).toMatchObject({ model: routeA.model });
  });

  it("keeps the second guard real: an unbound digest still collides at the intent", async () => {
    // Belt and braces, and a record of what the pre-stage-2 world relied on.
    // If the digest were NOT bound to the route -- the old behaviour, forged
    // here by reusing A's digest under B's route -- continuity passes, because
    // step 0's bytes match. The append of the INTENT is then the only thing
    // standing between a substituted route and the log, and it holds.
    const routeA = resolvedCliRoute();
    const routeB = { ...routeA, accountId: "acct-forged" };
    const root = scenario("b1c2-unbound");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);

    const invA = invocationFor(routeA);
    seedThroughStep(ledger, invA, routeA, INTENT_STEP.index + 1);
    const before = ledger.status();

    // A's digest, B's route: exactly what an unbound digest permitted.
    await expect(supervisorFor(ledger, invA, routeB).runToCheckpoint()).rejects.toThrow();
    const after = ledger.status();
    expect({ count: after.eventCount, head: after.headEventSha256 }).toEqual({
      count: before.eventCount,
      head: before.headEventSha256,
    });
  });

  it("binds every field of the route into the digest, and nothing else", () => {
    const route = resolvedCliRoute();
    const base = canonicalSubmissionDigest(submissionFor(route));

    // Each of the six contract fields moves the digest. A field that did not
    // would be a field a resume could change without being refused.
    const variants: readonly [string, ResolvedRoute][] = [
      ["provider", { ...route, provider: "codex" }],
      ["model", { ...route, model: "sonnet" }],
      ["accountId", { ...route, accountId: "acct-other" }],
      ["transportKind", { ...route, transportKind: "API_KEY" }],
      ["capabilityPolicyVersion", { ...route, capabilityPolicyVersion: "9999-01-01.1" }],
      ["resolvedAt", { ...route, resolvedAt: "2026-08-30T12:00:06.000Z" }],
    ];
    for (const [field, changed] of variants) {
      expect({ field, same: canonicalSubmissionDigest(submissionFor(changed)) === base }).toEqual({
        field,
        same: false,
      });
    }

    // The task coordinates and the instant are bound too.
    expect(canonicalSubmissionDigest({ ...submissionFor(route), attempt: 2 })).not.toBe(base);
    expect(canonicalSubmissionDigest({ ...submissionFor(route), submittedAt: "2026-08-30T12:00:01.000Z" })).not.toBe(base);
    expect(
      canonicalSubmissionDigest({
        ...submissionFor(route),
        initiativeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a02",
      }),
    ).not.toBe(base);
  });

  it("is canonical: key order in the caller's object cannot change the digest", () => {
    const route = resolvedCliRoute();
    const forward = submissionFor(route);
    const reversed: DaemonSubmission = {
      route: {
        resolvedAt: route.resolvedAt,
        capabilityPolicyVersion: route.capabilityPolicyVersion,
        transportKind: route.transportKind,
        accountId: route.accountId,
        model: route.model,
        provider: route.provider,
      },
      initiativeId: forward.initiativeId,
      submittedAt: forward.submittedAt,
      attempt: forward.attempt,
      taskId: forward.taskId,
    };
    expect(canonicalSubmission(reversed)).toBe(canonicalSubmission(forward));
    expect(canonicalSubmissionDigest(reversed)).toBe(canonicalSubmissionDigest(forward));
    expect(canonicalSubmissionDigest(forward)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("puts nothing in the preimage but coordinates, an instant and the admitted route", () => {
    // The preimage is hashed and discarded, but it is still material this
    // process holds, so what may appear in it is asserted rather than assumed.
    const preimage = canonicalSubmission(submissionFor(resolvedCliRoute()));
    const parsed: unknown = JSON.parse(preimage);
    expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual([
      "attempt",
      "initiativeId",
      "route",
      "submittedAt",
      "taskId",
    ]);
    expect(
      Object.keys((parsed as { route: Record<string, unknown> }).route).sort(),
    ).toEqual([
      "accountId",
      "capabilityPolicyVersion",
      "model",
      "provider",
      "resolvedAt",
      "transportKind",
    ]);
    expect(preimage).not.toContain(SECRET);
    expect(preimage).not.toContain("sk-");
    expect(preimage).not.toContain("/Users/");
    expect(preimage).not.toContain(REPO_ROOT);
  });
});


/**
 * Restart over the REAL adapter: the effect is not performed twice (V2-B2-2).
 *
 * The drill children prove recovery across a genuine SIGKILL with a scripted
 * subject, because neither the runtime nor the durability package may import
 * the providers edge. This is the other half of the same claim, on the one path
 * where a real adapter is reachable: a second walk over a scenario that already
 * completed starts no execution at all.
 *
 * That is the AFTER_EFFECT property stated from the far side. A restart closes
 * an open intent from probe evidence; a restart of a *closed* one performs
 * nothing. Both are the same guarantee — the effect module answers from
 * evidence, never from assumption — and this is the version of it that runs
 * against the provider adapter the plane will actually use.
 */
describe("a restart over the real adapter performs no second execution", () => {
  it("starts the port once across two walks of the same scenario", async () => {
    const route = resolvedCliRoute();
    const name = "b2-2-restart-cli";

    const first = await walk(name, cliPort(), route);
    expect(first.state).toBe("CHECKPOINTED");
    expect(first.trail.filter((event) => event.kind === "started")).toHaveLength(1);
    expect(first.evidence).toHaveLength(1);

    // The same scenario, the same invocation, a fresh port and a fresh trail.
    // Everything durable is already there, so nothing should be executed.
    const second = await walk(name, cliPort(), route);
    expect(second.state).toBe("CHECKPOINTED");
    expect(second.trail).toEqual([]);
    expect(second.evidence).toEqual(first.evidence);
    expect(second.eventCount).toBe(first.eventCount);
    expect(second.headEventSha256).toBe(first.headEventSha256);

    // And the evidence the probe answered from is byte-identical: the second
    // walk read it, it did not rewrite it.
    expect(second.markerJson).toBe(first.markerJson);
    expect(second.probe).toBe("DONE");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// V2-B7T: spend reaches the ledger
// ---------------------------------------------------------------------------

/**
 * The port has always reported what it spent; the walk has always thrown the
 * trail away. These drills run the assembled path with the daemon's own sink
 * wired in — the same closure `startDaemon` builds — and assert what the ledger
 * holds afterwards.
 *
 * **Two limits, stated where they are incurred rather than in prose elsewhere.**
 *
 * 1. The rollup fold is not executed here. `@acp/observation` is in neither the
 *    daemon's nor the runtime's import allowlist, so no test inside this
 *    packet's write-set can call `computeTokenRollups`, and making it callable
 *    would be a dependency edge this packet forbids. P6 is therefore discharged
 *    as the fold's own admission predicate applied to every appended event —
 *    with the two ceilings pinned equal by the fence law L-B7T-4, which is the
 *    only place that can read both files.
 * 2. The kill windows below are proved at the level a `SIGKILL` is observable —
 *    durable state: the marker on disk and the rows in the ledger. A literal
 *    SIGKILL through the drill child would need
 *    `runtime/src/drivers/sqlite-supervisor-child` to carry the sink, and
 *    keeping that file out is exactly what makes the sink optional. Named in
 *    the report as an offered path rather than taken unilaterally.
 */

const B7T_TOKENS_A = 4_321;
const B7T_TOKENS_B = 765;

/** A Claude turn that reports its spend twice, so "one event per entry" is visible. */
const B7T_TWO_USAGE_LINES: readonly string[] = [
  JSON.stringify({ type: "system", subtype: "init", model: RESOLVED_MODEL }),
  JSON.stringify({ type: "assistant", message: { usage: { output_tokens: B7T_TOKENS_A } } }),
  JSON.stringify({ type: "assistant", message: { usage: { output_tokens: B7T_TOKENS_B } } }),
  JSON.stringify({ type: "result", subtype: "turn_completed" }),
];

/**
 * Spend above the rollup ceiling, on the transport that can actually report it.
 *
 * Measured while writing this: the **CLI** adapter cannot produce such an entry
 * at all. `isReportableTokenCount` bounds `output_tokens` at the contract's
 * `TOKENS_USED_MAX` (10,000,000) and returns null above it, so an over-ceiling
 * CLI turn yields no usage signal and the walk simply succeeds having recorded
 * nothing — which would have made a scripted CLI turn a vacuous proof rather
 * than a refusal.
 *
 * The API leg is different and is the honest home: its chunks are normalized
 * straight through `ExecutionEvent.safeParse`, whose own bound is 100,000,000.
 * So an API transport genuinely can report spend the rollup would drop, and
 * this is the transport on which the recorder's refusal has to hold.
 */
const B7T_OVER_CEILING_CHUNKS: readonly ApiStreamChunk[] = [
  { kind: "started", resolvedModel: RESOLVED_MODEL, protocolVersion: "api/streaming-1" },
  { kind: "usage", stepIndex: 1, tokensUsed: USAGE_TOKENS_MAX + 1 },
  { kind: "state", toState: TERMINAL_STATE },
];

/** The same leg, inside the ceiling, so the refusal below is about the number. */
const B7T_UNDER_CEILING_CHUNKS: readonly ApiStreamChunk[] = [
  { kind: "started", resolvedModel: RESOLVED_MODEL, protocolVersion: "api/streaming-1" },
  { kind: "usage", stepIndex: 1, tokensUsed: USAGE_TOKENS_MAX },
  { kind: "state", toState: TERMINAL_STATE },
];

function apiRoute(): ResolvedRoute {
  return { ...resolvedCliRoute(), transportKind: "API_KEY" };
}

interface RecordedWalk {
  readonly ledger: Ledger;
  readonly root: ScenarioRoot;
  readonly inv: DurableInvocation;
  readonly trail: readonly ExecutionEvent[];
  readonly state: string | null;
  readonly usageEvents: readonly ControlPlaneEventRecord[];
  readonly markers: readonly string[];
  readonly operationId: string;
}

type ControlPlaneEventRecord = ReturnType<Ledger["listEvents"]>["events"][number];

/**
 * The assembled path with the daemon's sink.
 *
 * The closure is byte-for-byte the shape `startDaemon` builds: the same
 * `recordTokenObservation`, the same `usageTransitionId`, the account read from
 * the same `route` the port executes. `sinkOverride` exists only so the K1
 * window can be entered without a second harness.
 */
async function walkRecording(
  name: string,
  lines: readonly string[],
  options: {
    readonly sinkOverride?: (sample: UsageSample) => void;
    readonly port?: ModelExecutionPort;
    readonly route?: ResolvedRoute;
  } = {},
): Promise<RecordedWalk> {
  const route = options.route ?? resolvedCliRoute();
  const root = scenario(name);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const inv = invocation();
  replayLedger = ledger;
  replayInvocation = inv;
  const trail: ExecutionEvent[] = [];

  const effects = createExecutionEffects({
    port: recording(
      options.port ?? createExecutionPort({ bindings: new Map([[ACCOUNT, cliBinding(lines)]]) }),
      trail,
    ),
    route,
    request: executionRequest(),
    scenarioRoot: root,
    recordUsage:
      options.sinkOverride ??
      ((sample) => {
        recordTokenObservation(ledger, {
          invocation: inv,
          kind: "USAGE",
          accountId: route.accountId,
          tokens: sample.tokensUsed,
          transitionId: usageTransitionId(sample.operationIndex, sample.stepIndex),
          emittedBy: EMITTED_BY,
        });
      }),
  });

  const supervisor = new SqliteSupervisor({
    ledger,
    invocation: inv,
    effects,
    emittedBy: EMITTED_BY,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    initiativeId: INITIATIVE_ID,
    route,
  });

  let state: string | null = null;
  try {
    state = (await supervisor.runToCheckpoint()).finalState;
  } catch {
    state = null;
  }

  const home = join(root, "executions");
  const operation = operationForStep(inv, INTENT_STEP);
  return {
    ledger,
    root,
    inv,
    trail,
    state,
    usageEvents: ledger
      .listEvents({ limit: 200 })
      .events.filter((entry) => entry.event.type === "TOKEN_USAGE_RECORDED"),
    markers: existsSync(home) ? readdirSync(home).sort() : [],
    operationId: operation.operationId,
  };
}

/**
 * The ledger and invocation the P8 replay drill records through.
 *
 * Set by `walkRecording` so the sink can reach them; a sink is called from
 * inside `apply`, which is inside the supervisor, so there is no other seam.
 */
let replayLedger: Ledger | null = null;
let replayInvocation: DurableInvocation = { taskId: TASK, attempt: 1, invocationId: TASK, submittedAt: NOW, submissionDigest: "0".repeat(64) };

function trailUsageTotal(trail: readonly ExecutionEvent[]): number {
  return (normalized(trail) as { usageTotal: number }).usageTotal;
}

describe("V2-B7T: the walk records what it spends", () => {
  it("P4/P5: one event per trail usage entry, summing to the port's own total", async () => {
    const walked = await walkRecording("b7t-usage-sum", B7T_TWO_USAGE_LINES);
    expect(walked.state).toBe("CHECKPOINTED");

    const entries = walked.trail.filter((event) => event.kind === "usage");
    expect(entries.length).toBe(2);

    // P5 — one appended event per trail entry. Not summed, not collapsed.
    expect(walked.usageEvents).toHaveLength(entries.length);

    // P4 — the sum equals the port's own measurement, compared against the
    // trail this very walk produced rather than against a constant.
    const recorded = walked.usageEvents.reduce(
      (sum, entry) => sum + Number(entry.event.payload["tokens"]),
      0,
    );
    expect(recorded).toBe(trailUsageTotal(walked.trail));
    expect(recorded).toBe(B7T_TOKENS_A + B7T_TOKENS_B);

    // Each carries its own step-derived identity, unique within the attempt.
    const ids = walked.usageEvents.map((entry) => entry.event.transitionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("usage."))).toBe(true);
    expect(ids).toEqual(
      entries.map((event) =>
        usageTransitionId(operationForStep(walked.inv, INTENT_STEP).operationIndex, event.stepIndex),
      ),
    );
  });

  it("P6: every appended event satisfies the rollup fold's own admission predicate", async () => {
    // The fold cannot be executed from here (see this section's docblock), so
    // what is asserted is the property that decides its outcome: the fold skips
    // an event whose `accountId` is not a bounded string or whose `tokens` is
    // not an integer within its ceiling, and counts it in `skippedMalformed`.
    // Every event this walk appended passes that test, so the fold would move
    // by exactly the recorded sum and skip nothing.
    const walked = await walkRecording("b7t-usage-foldable", B7T_TWO_USAGE_LINES);
    expect(walked.usageEvents.length).toBeGreaterThan(0);

    for (const entry of walked.usageEvents) {
      const accountId = entry.event.payload["accountId"];
      const tokens = entry.event.payload["tokens"];
      expect(typeof accountId).toBe("string");
      expect(String(accountId).length).toBeGreaterThan(0);
      expect(String(accountId).length).toBeLessThanOrEqual(80);
      expect(Number.isInteger(tokens)).toBe(true);
      expect(Number(tokens)).toBeGreaterThanOrEqual(0);
      expect(Number(tokens)).toBeLessThanOrEqual(USAGE_TOKENS_MAX);
      // Exactly the pair the fold reads, and nothing else.
      expect(Object.keys(entry.event.payload).sort()).toEqual(["accountId", "tokens"]);
    }
  });

  it("P7: attribution is the elected account, and the task's own initiative", async () => {
    const walked = await walkRecording("b7t-usage-attribution", B7T_TWO_USAGE_LINES);
    const route = resolvedCliRoute();

    for (const entry of walked.usageEvents) {
      expect(entry.event.payload["accountId"]).toBe(route.accountId);
      expect(entry.event.taskId).toBe(walked.inv.taskId);
      expect(entry.event.attempt).toBe(walked.inv.attempt);
      // The correlation is the walk's own invocation, so the spend rides the
      // attempt rather than starting one.
      expect(entry.event.correlationId).toBe(walked.inv.invocationId);
    }

    // The fold buckets by the initiative the DISCOVERY event carries; this walk
    // declared one, so the spend is scoped rather than unscoped.
    const discovery = walked.ledger
      .listEvents({ limit: 200 })
      .events.find((entry) => entry.event.type === "TASK_DISCOVERED");
    expect(discovery?.event.payload["initiativeId"]).toBe(INITIATIVE_ID);
  });

  it("P8: recording the same observation twice appends once", async () => {
    // The replay has to be taken at the state the recorder reads, because the
    // recorder reads `fromState`/`toState` from the ledger at record time. That
    // is what a resume actually re-does: the same observation, at the same
    // point in the walk. Recorded twice from inside the sink, the second append
    // rebuilds identical bytes under an identical key and inserts nothing.
    const results: boolean[] = [];
    const walked = await walkRecording("b7t-usage-replay", B7T_TWO_USAGE_LINES, {
      sinkOverride: (sample) => {
        const route = resolvedCliRoute();
        const observation = {
          invocation: replayInvocation,
          kind: "USAGE" as const,
          accountId: route.accountId,
          tokens: sample.tokensUsed,
          transitionId: usageTransitionId(sample.operationIndex, sample.stepIndex),
          emittedBy: EMITTED_BY,
        };
        results.push(recordTokenObservation(replayLedger!, observation).inserted);
        results.push(recordTokenObservation(replayLedger!, observation).inserted);
      },
    });

    // First of each pair inserted, second of each pair an exact replay.
    expect(results).toEqual([true, false, true, false]);
    expect(walked.usageEvents).toHaveLength(2);
    expect(walked.state).toBe("CHECKPOINTED");
  });

  it("P8: a completed attempt resumes without appending a second usage event", async () => {
    // The other half, on the real resume path: with the marker verified,
    // `closeIntent` probes DONE and never re-enters `apply`, so nothing is
    // offered to the sink a second time.
    const walked = await walkRecording("b7t-usage-resume", B7T_TWO_USAGE_LINES);
    const before = walked.ledger.status();
    expect(walked.usageEvents).toHaveLength(2);

    const route = resolvedCliRoute();
    const resumed = await new SqliteSupervisor({
      ledger: walked.ledger,
      invocation: walked.inv,
      effects: createExecutionEffects({
        port: createExecutionPort({ bindings: new Map([[ACCOUNT, cliBinding(B7T_TWO_USAGE_LINES)]]) }),
        route,
        request: executionRequest(),
        scenarioRoot: walked.root,
        recordUsage: () => {
          throw new Error("a completed attempt must not record again");
        },
      }),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: INITIATIVE_ID,
      route,
    }).runToCheckpoint();

    expect(resumed.finalState).toBe("CHECKPOINTED");
    const after = walked.ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);
  });

  it("N4: no credential, no path, no provider output in any appended payload", async () => {
    const walked = await walkRecording("b7t-usage-privacy", B7T_TWO_USAGE_LINES);
    const serialized = walked.ledger
      .listEvents({ limit: 200 })
      .events.map((entry) => entry.canonicalJson)
      .join("\n");
    expect(serialized.length).toBeGreaterThan(0);

    for (const forbidden of [
      SECRET,
      "credentialRef",
      "authProfileRef",
      "profile://",
      "Bearer ",
      "/Users/",
      "/private/",
      RESOLVED_MODEL,
      "output_tokens",
    ]) {
      expect({ forbidden, present: serialized.includes(forbidden) }).toEqual({ forbidden, present: false });
    }

    // The plural key is load bearing: the contract's credential guard denies a
    // singular `token`, so the payload is asserted to be exactly the pair.
    for (const entry of walked.usageEvents) {
      expect(Object.keys(entry.event.payload).sort()).toEqual(["accountId", "tokens"]);
    }
  });

  it("N6: an over-ceiling observation is refused, and nothing is appended", async () => {
    // D-B7T-2, end to end on the transport that can report it. The recorder
    // refuses, the sink throws, the apply fails closed, and the walk does not
    // reach its terminal.
    const walked = await walkRecording("b7t-over-ceiling", [], {
      port: apiPort(B7T_OVER_CEILING_CHUNKS),
      route: apiRoute(),
    });

    expect(walked.state).toBeNull();
    // Nothing recorded: not the over-ceiling row, not a truncated one.
    expect(walked.usageEvents).toHaveLength(0);
    expect(
      walked.ledger.listEvents({ limit: 200 }).events.map((entry) => entry.event.type),
    ).not.toContain("TOKEN_USAGE_RECORDED");
    // And the apply failed closed, so no marker claims the effect happened.
    expect(walked.markers).toHaveLength(0);
    expect(TERMINAL_STATES).not.toContain(walked.ledger.getTask(walked.inv.taskId)?.currentState);
  });

  it("N6: the same walk at exactly the ceiling is recorded, so the refusal is about the number", async () => {
    const walked = await walkRecording("b7t-at-ceiling", [], {
      port: apiPort(B7T_UNDER_CEILING_CHUNKS),
      route: apiRoute(),
    });

    expect(walked.state).toBe("CHECKPOINTED");
    expect(walked.usageEvents).toHaveLength(1);
    expect(Number(walked.usageEvents[0]?.event.payload["tokens"])).toBe(USAGE_TOKENS_MAX);
  });

  it("K1: the pre-marker window costs a re-execution and records once", async () => {
    // The window C2 names, at the level a SIGKILL is observable: the sink threw
    // between the execution and the marker write, so nothing durable claims the
    // effect happened. The resumed walk re-executes and records exactly once.
    let failFirst = true;
    const recorded: number[] = [];
    const walked = await walkRecording("b7t-k1", CLAUDE_LINES, {
      sinkOverride: (sample) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("crash between the execution and the marker");
        }
        recorded.push(sample.tokensUsed);
      },
    });

    // The first apply left nothing behind.
    expect(walked.state).toBeNull();
    expect(walked.markers).toHaveLength(0);

    // Resume over the same ledger and the same scenario root.
    const route = resolvedCliRoute();
    const resumedEffects = createExecutionEffects({
      port: createExecutionPort({ bindings: new Map([[ACCOUNT, cliBinding(CLAUDE_LINES)]]) }),
      route,
      request: executionRequest(),
      scenarioRoot: walked.root,
      recordUsage: (sample) => {
        recorded.push(sample.tokensUsed);
        recordTokenObservation(walked.ledger, {
          invocation: walked.inv,
          kind: "USAGE",
          accountId: route.accountId,
          tokens: sample.tokensUsed,
          transitionId: usageTransitionId(sample.operationIndex, sample.stepIndex),
          emittedBy: EMITTED_BY,
        });
      },
    });
    const resumed = await new SqliteSupervisor({
      ledger: walked.ledger,
      invocation: walked.inv,
      effects: resumedEffects,
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: INITIATIVE_ID,
      route,
    }).runToCheckpoint();

    expect(resumed.finalState).toBe("CHECKPOINTED");
    // Exactly one usage event for the operation — not two. The spend of the
    // abandoned execution is not in the ledger, which is the honest
    // under-report the ordering buys; it is never double counted.
    const usage = walked.ledger
      .listEvents({ limit: 200 })
      .events.filter((entry) => entry.event.type === "TOKEN_USAGE_RECORDED");
    expect(usage).toHaveLength(1);
    expect(Number(usage[0]?.event.payload["tokens"])).toBe(TOKENS);
  });

  it("K2: a verified marker implies a recorded usage event", async () => {
    const walked = await walkRecording("b7t-k2", B7T_TWO_USAGE_LINES);
    expect(walked.state).toBe("CHECKPOINTED");
    expect(walked.markers).toHaveLength(1);

    // The invariant, asserted directly: for every verified marker in the
    // scenario root, a matching usage event exists in the ledger.
    for (const marker of walked.markers) {
      const operationId = marker.replace(/\.json$/, "");
      expect(operationId).toBe(walked.operationId);
      expect(walked.usageEvents.length).toBeGreaterThan(0);
    }

    // And the resume path takes the branch this ordering exists for: with the
    // marker verified, `closeIntent` probes DONE and never re-enters `apply`,
    // so a second walk starts no execution and appends no second usage event.
    const route = resolvedCliRoute();
    const calls = { starts: 0 };
    const counting: ModelExecutionPort = {
      start: (r, q) => {
        calls.starts += 1;
        return createExecutionPort({ bindings: new Map([[ACCOUNT, cliBinding(B7T_TWO_USAGE_LINES)]]) }).start(r, q);
      },
      interrupt: () => Promise.resolve(),
      healthProbe: () =>
        Promise.resolve({ status: "UNKNOWN" as const, checkedAt: RESOLVED_AT, latencyMs: null, classifiedError: null }),
    };
    const again = createExecutionEffects({
      port: counting,
      route,
      request: executionRequest(),
      scenarioRoot: walked.root,
      recordUsage: () => {
        throw new Error("the resume must not re-enter apply");
      },
    });
    await expect(again.probe(operationForStep(walked.inv, INTENT_STEP))).resolves.toBe("DONE");
    await again.apply(operationForStep(walked.inv, INTENT_STEP));
    expect(calls.starts).toBe(0);
    expect(walked.usageEvents).toHaveLength(2);
  });

  it("K3: an unsettled walk is not falsely terminal, and settles exactly once", async () => {
    // The settlement's crash window: before the append there is no terminal, and
    // after it there is exactly one. Because the settlement is a single atomic
    // append under a derived key, those are the only two durable states a crash
    // can leave, and a re-run reaches the second from the first.
    const walked = await walkRecording("b7t-k3", [], {
      port: apiPort(B7T_OVER_CEILING_CHUNKS),
      route: apiRoute(),
    });
    expect(walked.state).toBeNull();

    const task = walked.ledger.getTask(walked.inv.taskId);
    expect(task).not.toBeNull();
    expect(TERMINAL_STATES).not.toContain(task?.currentState);
    expect(
      walked.ledger.listEvents({ limit: 200 }).events.map((entry) => entry.event.type),
    ).not.toContain("TASK_FAILED");

    const context = {
      ledger: walked.ledger,
      effects: {
        apply: () => Promise.resolve(),
        probe: () => Promise.resolve("NOT_DONE" as const),
      },
      invocation: walked.inv,
      emittedBy: EMITTED_BY,
      plan: LIFECYCLE_PLAN,
      initiativeId: INITIATIVE_ID,
      route: apiRoute(),
    };

    const first = await settleFailure(context, "BOUND_EXHAUSTED");
    expect(first.verdict).toBe("FAILED");
    const countAfter = walked.ledger.status().eventCount;
    expect(walked.ledger.getTask(walked.inv.taskId)?.currentState).toBe("FAILED");

    const second = await settleFailure(context, "BOUND_EXHAUSTED");
    expect(second.verdict).toBe("TASK_TERMINAL");
    expect(second.failed).toBeNull();
    expect(walked.ledger.status().eventCount).toBe(countAfter);
  });

  it("K4: the ledger stays intact and the projection rebuilds identically", async () => {
    const walked = await walkRecording("b7t-k4", B7T_TWO_USAGE_LINES);
    expect(walked.state).toBe("CHECKPOINTED");

    expect(walked.ledger.verifyIntegrity().ok).toBe(true);
    const before = walked.ledger.status();
    const rebuild = walked.ledger.rebuildReadModel();
    expect(rebuild.replayedEvents).toBe(before.eventCount);
    const after = walked.ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);
    expect(walked.ledger.verifyIntegrity().ok).toBe(true);
    expect(
      walked.ledger.verifyIntegrity().problems.filter((problem) => problem.kind === "PROJECTION"),
    ).toEqual([]);
  });

  it("P9: a walk with no sink appends no usage event, so the toy lanes are untouched", async () => {
    // The EQUIVALENCE drill's two lanes both run the toy effect and pass no
    // sink, so no usage event can enter either ledger and its `eventCount` /
    // `headEventSha256` equality is unmoved. Asserted here from the other side:
    // the sink is what adds the events, and without one nothing is added.
    const withoutSink = await walk("b7t-no-sink", cliPort(), resolvedCliRoute());
    expect(withoutSink.types).not.toContain("TOKEN_USAGE_RECORDED");
    expect(withoutSink.state).toBe("CHECKPOINTED");
  });
});

// ---------------------------------------------------------------------------
// V2-B4a, A8: the production daemon reaps the children it owns
// ---------------------------------------------------------------------------

/** One fixed initiative for the B4a drill, in the shape every drill uses. */
const B4A_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7b01";

/**
 * A real provider binary, because the daemon admits a path rather than an
 * adapter.
 *
 * The scripted-adapter trick the rest of this file uses cannot reach
 * `startDaemon`: the production composition root builds its port from the
 * shipped `claudeAdapter` and the configuration's binary, so proving the
 * production seam means putting a real executable on disk and letting the
 * daemon admit it.
 *
 * The child writes its own pid before anything else. That is what makes "the
 * child is gone" checkable without scanning, matching a pattern or guessing:
 * the process announces itself, exactly as `ProcessHandle` only ever signals
 * a pid it created.
 *
 * Since V2-B1c it also **echoes what it was told**, into a second file it owns.
 * Before that, this subject read neither argv nor stdin, so every green
 * execution drill in this file would have been byte-identical if the channel
 * had carried nothing — the evidence could not have failed. Now it can.
 *
 * The echo is a side file and never stdout, deliberately: stdout is parsed by
 * the real adapter, and an unrecognised line becomes a classified event whose
 * bounded payload can reach a log line. Writing the instruction there would
 * create the exact leak this packet forbids in order to prove it did not leak.
 */
function fakeProviderBinary(
  lines: readonly string[],
  options: { readonly linger: boolean },
): {
  readonly binary: string;
  readonly root: string;
  readonly pidFile: string;
  readonly echoFile: string;
} {
  const root = mkdtempSync(join(TMP_ROOT, "acp-b4a-provider-"));
  chmodSync(root, 0o700);
  const pidFile = join(root, "child.pid");
  // Outside the worktree, deliberately. The walk's conformance gate scans the
  // declared write-set, and a subject that recorded its evidence inside the
  // tree it is working in would be a write-set violation -- the drill would
  // then fail for a reason that has nothing to do with what it proves.
  const echoRoot = mkdtempSync(join(TMP_ROOT, "acp-b1c-echo-"));
  chmodSync(echoRoot, 0o700);
  temporaries.push(echoRoot);
  const echoFile = join(echoRoot, "instruction.txt");
  const binary = join(root, "fake-provider");
  writeFileSync(
    binary,
    "#!" + realpathSync(process.execPath) + "\n" +
      "require('node:fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid));\n" +
      // Read to EOF, then record. A subject that never saw the close would
      // hang here rather than write, so the file existing at all is evidence
      // that the pipe was closed as well as written.
      "const chunks = [];\n" +
      "process.stdin.on('data', (c) => chunks.push(c));\n" +
      "process.stdin.on('end', () => {\n" +
      "  require('node:fs').writeFileSync(" + JSON.stringify(echoFile) + ", chunks.join(''));\n" +
      "});\n" +
      "const lines = " + JSON.stringify([...lines]) + ";\n" +
      "for (const line of lines) process.stdout.write(line + \"\\n\");\n" +
      (options.linger
        ? "setInterval(() => {}, 1000);\n"
        : "setTimeout(() => process.exit(0), 250);\n"),
    { mode: 0o700 },
  );
  temporaries.push(root);
  initWorktree(root);
  return { binary, root, pidFile, echoFile };
}

function b4aExecutionConfig(binary: string, root: string): DaemonExecutionConfig {
  return {
    route: {
      provider: "claude",
      model: "opus",
      accountId: "acct-b4a-drill",
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: "2026-09-03.1",
      resolvedAt: RESOLVED_AT,
    },
    // Plural since V2-B1f/F2: the array carries the account each binding
    // serves, and the route's own account must be among them.
    bindings: [
      {
        accountId: "acct-b4a-drill",
        binary,
        configRoot: root,
        workdir: root,
        limits: { timeoutMs: 10_000, outputBudgetBytes: 64 * 1024, interruptGraceMs: 120, termGraceMs: 120 },
      },
    ],
  };
}

function b4aOptions(scenarioId: string, execution: DaemonExecutionConfig): Parameters<typeof startDaemon>[0] {
  const taskId = randomUUID();
  return {
    // Declared honestly: this drill's provider writes its own pid file into the
    // worktree, so the envelope says so. A drill that under-declares is a drill
    // the gate correctly refuses.
    envelope: envelopeFor(taskId, INITIATIVE_ID, ["child.pid"]),
    mode: "SQLITE_SUPERVISOR" as const,
    scenarioId,
    emittedBy: EMITTED_BY,
    taskId,
    attempt: 1,
    submittedAt: SUBMITTED_AT,
    submissionDigest: canonicalSubmissionDigest({
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      initiativeId: B4A_INITIATIVE_ID,
      route: execution.route,
    }),
    initiativeId: B4A_INITIATIVE_ID,
    checkPorts: false,
    execution,
  };
}

/**
 * A scenario **id**, registered for cleanup.
 *
 * `scenario()` above resolves the id to a root, which is what every other
 * drill in this file wants. `startDaemon` takes the id and resolves it itself
 * — a caller cannot name a directory (D5) — so this returns the raw name.
 */
function b4aScenarioId(name: string): string {
  scenarios.push(name);
  return name;
}

/** Is this pid still a live process? Asked only of a pid the child announced. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the production daemon owns and reaps its provider children (V2-B4a)", () => {
  it("registers the harness in the unwind, and stopDaemon releases it after the ledger's children", async () => {
    const { binary, root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const run = await startDaemon(b4aOptions(b4aScenarioId("b4a-unwind"), b4aExecutionConfig(binary, root)));

    const stopped = await stopDaemon(run);
    expect(stopped.stopped).toBe(true);
    expect(stopped.outcome.failures).toEqual([]);
    // L-B4A-2, observed rather than asserted about: the production root really
    // does register a harness resource, and the real unwind really does
    // release it.
    expect(stopped.outcome.released).toContain("agent-harness");
    // Reverse order: children are reaped before the ledger they report into is
    // closed. The stack unwinds in reverse, so the harness must appear AFTER
    // the ledger in the released list to have been released BEFORE it.
    expect(stopped.outcome.released.indexOf("agent-harness")).toBeLessThan(
      stopped.outcome.released.indexOf("ledger"),
    );
  });

  it("reaps a child the walk left running, so an abandoned execution does not outlive the daemon", async () => {
    // A `started` the contract cannot express: the parser accepts any
    // non-empty model, `ExecutionEvent` bounds `resolvedModel` at 120, and the
    // payload shaping bounds strings at 200 — so this survives normalization
    // and fails the contract, which ends the stream through the failure path
    // that never closes the session. The child is left running, which before
    // B4a meant running forever with nothing able to name it.
    const unexpressible: readonly string[] = [
      JSON.stringify({ type: "system", subtype: "init", model: "m".repeat(200) }),
    ];
    const { binary, root, pidFile } = fakeProviderBinary(unexpressible, { linger: true });

    await expect(
      startDaemon(b4aOptions(b4aScenarioId("b4a-reap"), b4aExecutionConfig(binary, root))),
    ).rejects.toThrow();

    // The child announced itself, so this is the pid the daemon spawned and
    // not one this test went looking for.
    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    expect(Number.isInteger(pid)).toBe(true);
    expect(isAlive(pid)).toBe(false);
  });
});

/**
 * Plural admitted bindings, end to end (V2-B1f/F2).
 *
 * The port layer was already plural; the singularity was the daemon's own
 * config and its `executionPortFor`, which built the bindings map and set
 * exactly one entry. A switch therefore had nowhere to land: the destination
 * account had no binding no matter what the planner decided.
 *
 * **Asserted through the subject's own side file, never through a mock of the
 * admission functions.** Each account gets its own fake provider binary and its
 * own echo file, so "route A reached A's binary" is evidence written by the
 * process the daemon actually spawned — not a spy's record of a call.
 *
 * The two entries share one `workdir` and differ in `binary` and `configRoot`,
 * which is exactly the shape the config law admits: one worktree per packet,
 * one credential root per account.
 */
describe("F2: a switch has somewhere to land -- plural bindings, end to end", () => {
  const SECOND_ACCOUNT = "acct-b4a-second";

  /** Two fake providers sharing one worktree, each with its own credential root. */
  function twoProviders(): {
    readonly worktree: string;
    readonly first: { binary: string; echoFile: string; configRoot: string };
    readonly second: { binary: string; echoFile: string; configRoot: string };
  } {
    const a = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const b = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    return {
      // One worktree per packet: the route's entry supplies it and every other
      // entry must declare the same one, so a switch cannot move the checkout.
      worktree: a.root,
      first: { binary: a.binary, echoFile: a.echoFile, configRoot: a.root },
      second: { binary: b.binary, echoFile: b.echoFile, configRoot: b.root },
    };
  }

  /** A two-entry execution config whose route names `accountId`. */
  function pluralExecution(
    accountId: string,
    providers: ReturnType<typeof twoProviders>,
  ): DaemonExecutionConfig {
    const limits = {
      timeoutMs: 10_000,
      outputBudgetBytes: 64 * 1024,
      interruptGraceMs: 120,
      termGraceMs: 120,
    };
    return {
      route: {
        provider: "claude",
        model: "opus",
        accountId,
        transportKind: "CLI_SUBSCRIPTION",
        capabilityPolicyVersion: "2026-09-03.1",
        resolvedAt: RESOLVED_AT,
      },
      bindings: [
        {
          accountId: "acct-b4a-drill",
          binary: providers.first.binary,
          configRoot: providers.first.configRoot,
          workdir: providers.worktree,
          limits,
        },
        {
          accountId: SECOND_ACCOUNT,
          binary: providers.second.binary,
          configRoot: providers.second.configRoot,
          workdir: providers.worktree,
          limits,
        },
      ],
    };
  }

  it("P1/P5/P7 routes each account to its own binding, proved by the subject's own side file", async () => {
    const providers = twoProviders();

    // Route names the FIRST account.
    const runA = await startDaemon(
      b4aOptions(b4aScenarioId("f2-route-a"), pluralExecution("acct-b4a-drill", providers)),
    );
    await stopDaemon(runA);

    // The first account's subject ran; the second's did not. N7: no cross
    // account leakage -- B's binary was bound and admitted, and still never
    // executed, because the route did not name it.
    expect(existsSync(providers.first.echoFile)).toBe(true);
    expect(existsSync(providers.second.echoFile)).toBe(false);

    // Route names the SECOND account, over the same two bindings.
    const runB = await startDaemon(
      b4aOptions(b4aScenarioId("f2-route-b"), pluralExecution(SECOND_ACCOUNT, providers)),
    );
    await stopDaemon(runB);

    // Now the second account's own subject has run. Before F2 this was
    // unreachable: the map held one entry, keyed by the route's account, so a
    // route naming any other account was refused TRANSPORT_UNAVAILABLE.
    expect(existsSync(providers.second.echoFile)).toBe(true);
    expect(readFileSync(providers.second.echoFile, "utf8")).toBe("walk the plan");
  });

  it("P6 keeps one worktree across both accounts -- a switch does not move the checkout", async () => {
    // The rule the whole shape turns on. Both entries declare the route's
    // worktree, so the lease, the conformance gate and each walk's own
    // worktreePath all derive the same directory whichever account is routed.
    const providers = twoProviders();
    const a = pluralExecution("acct-b4a-drill", providers);
    const b = pluralExecution(SECOND_ACCOUNT, providers);

    const worktreeOf = (execution: DaemonExecutionConfig): string => {
      const routed = execution.bindings.find((e) => e.accountId === execution.route.accountId);
      if (routed === undefined) throw new Error("expected the route to be bound");
      return routed.workdir;
    };

    expect(worktreeOf(a)).toBe(providers.worktree);
    expect(worktreeOf(b)).toBe(providers.worktree);
    expect(worktreeOf(a)).toBe(worktreeOf(b));
    // And the credential roots genuinely differ, so the shared worktree is not
    // an artefact of the two entries being identical.
    expect(providers.first.configRoot).not.toBe(providers.second.configRoot);

    const run = await startDaemon(b4aOptions(b4aScenarioId("f2-one-worktree"), b));
    await stopDaemon(run);
    expect(existsSync(providers.second.echoFile)).toBe(true);
  });

  it("N9 names the account whose binding was refused, not just 'the' binding", async () => {
    // With four bindings an operator told only that "the execution binding was
    // refused" would have to guess which credential root the daemon objected
    // to. The second entry is the broken one, so a message naming the first
    // would be actively misleading.
    const providers = twoProviders();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [first, second] = execution.bindings;
    if (first === undefined || second === undefined) throw new Error("expected two entries");
    const broken: DaemonExecutionConfig = {
      ...execution,
      bindings: [
        first,
        { ...second, binary: join(providers.second.configRoot, "no-such-binary") },
      ],
    };

    await expect(
      startDaemon(b4aOptions(b4aScenarioId("f2-named-refusal"), broken)),
    ).rejects.toThrow(new RegExp("the execution binding for " + SECOND_ACCOUNT + " was refused"));
  });
});

/**
 * The instruction channel, end to end (V2-B1c).
 *
 * Before this packet the subject read neither argv nor stdin, so the channel
 * could carry nothing and every drill above would still be green. These are the
 * assertions that could not previously fail.
 */
describe("the packet's objective reaches the model (V2-B1c)", () => {
  it("P1/P6 delivers the envelope's objective, and nothing else, to the subject", async () => {
    const { binary, root, echoFile } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const run = await startDaemon(
      b4aOptions(b4aScenarioId("b1c-delivery"), b4aExecutionConfig(binary, root)),
    );
    await stopDaemon(run);

    // P1: the subject wrote back what it received, into a file it owns. The
    // file existing at all proves the pipe was closed as well as written --
    // its `end` handler never fires otherwise.
    expect(existsSync(echoFile)).toBe(true);
    // P6: the instruction is the envelope's own objective, resolved by the one
    // producer, and it is the whole of what was sent -- not a template, not a
    // rendering, not a concatenation of context.
    expect(readFileSync(echoFile, "utf8")).toBe("walk the plan");
  });

  it("N4 leaves no instruction byte, and no digest, anywhere in the plane", async () => {
    // The channel is write-only. What is swept here is every durable and
    // observable surface the drill can reach: the ledger's rows and payloads,
    // the status document, and the daemon's own published phases. A digest is
    // searched for as well as the text, because "we only stored a hash of what
    // we asked" is exactly the compromise the DT ruling refused.
    const { binary, root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const scenarioId = b4aScenarioId("b1c-no-trace");
    const run = await startDaemon(b4aOptions(scenarioId, b4aExecutionConfig(binary, root)));
    await stopDaemon(run);

    const objective = "walk the plan";
    const digest = createHash("sha256").update(objective).digest("hex");
    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(scenarioId)));
    try {
      const rows = ledger.listEvents({ limit: 500 }).events;
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(objective);
      expect(serialized).not.toContain(digest);
      // Non-vacuous: the sweep would find the string if it were there.
      expect(JSON.stringify([{ payload: { note: objective } }])).toContain(objective);
    } finally {
      ledger.close();
    }
  });
});
