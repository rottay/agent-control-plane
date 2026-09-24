import { spawn, spawnSync } from "node:child_process";
import type { TaskEnvelope } from "@acp/contracts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ROUTING_CONFIG, EVIDENCE_ABSENT, loadPolicyRegistry, resolveRoute } from "@acp/accounts";
import type { CandidateEvidence, PolicyRegistry, PolicyRouteRequest, QuotaEstimate, QuotaOutcome, RoutingRequest } from "@acp/accounts";
import {
  AccountRecord,
  CONTRACT_VERSION,
  ExecutionEvent,
  ResultContractSchema,
  TERMINAL_STATES,
  buildIdempotencyKey,
} from "@acp/contracts";
import type {
  Checkpoint,
  ExecutionOutputSink,
  TaskState,
  ExecutionRequest,
  ModelExecutionPort,
  ResolvedRoute,
} from "@acp/contracts";
import { deriveInvocation } from "@acp/durability";
import {
  LedgerValidationError,
  artifactBlobLeaseStorePath,
  artifactRootFor,
  canonicalJsonStringify,
  createCheckpointStore,
  effectIdV1,
  effectIdempotencyKeyV1,
  logicalOperationSha256,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  openLeaseStore,
  readArtifact,
  requestSha256,
  sha256Hex,
} from "@acp/ledger";
import type { ArtifactPlane, ArtifactPlaneTestFaults, ExecutionRouteReadModel, Ledger } from "@acp/ledger";
import { admitBinary, admitConfigRoot, admitWorkdir, claudeAdapter, createExecutionPort, executionSessionId } from "@acp/providers";
import type {
  ApiStreamChunk,
  ApiStreamRequest,
  ApiStreamingClient,
  CliBinding,
  ProviderAdapter,
  SessionDescriptor,
  SessionRequest,
} from "@acp/providers";
import {
  ATTEMPT_OPENING_STEP,
  ExecutionEffectError,
  INTENT_STEP,
  LIFECYCLE_PLAN,
  SqliteSupervisor,
  USAGE_TOKENS_MAX,
  OUTCOME_STEP,
  buildEvent,
  createExecutionEffects,
  deriveEventCoordinate,
  deterministicUuid,
  executeSwitchPlan,
  landAccountSwitch,
  appendPlanStep,
  operationForStep,
  planStep,
  pressureTransitionId,
  recordProviderPressure,
  recordTokenObservation,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
  settleFailure,
  usageTransitionId,
} from "@acp/runtime";
import type {
  BeatContext,
  CheckpointPort,
  CheckpointRefused,
  CheckpointSource,
  DurableInvocation,
  InvocationRevision,
  ScenarioRoot,
  UsageSample,
} from "@acp/runtime";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { leaseStorePath } from "../../../src/arbiter/index.js";
import { runPackagedEntry } from "../../../src/bin/acp-daemon/index.js";
import { canonicalSubmission, canonicalSubmissionDigest } from "../../../src/daemon-child/index.js";
import type { DaemonExecutionConfig, DaemonSubmission } from "../../../src/daemon-child/index.js";
import { resolveDaemonRoot } from "../../../src/paths/index.js";
import type { ScheduledWalk } from "../../../src/scheduler/index.js";
import { startDaemon, stopDaemon } from "../../../src/index.js";
import { instructionFor } from "../../../src/composition/index.js";
import type { ComposedInstruction } from "../../../src/composition/index.js";
// Relative, as the runtime's own suites import them: D exports nothing new from the
// runtime barrel (Q-D8).
import { buildPromptOccurrenceEvent, buildResponseOccurrenceEvent } from "../../../../../domains/runtime/src/core/events/index.js";
import { assembleResult, publishResult } from "../../../../../domains/runtime/src/operation-result/index.js";
import type {
  ArtifactIdentities,
  PublishedResult,
  ResultAssembly,
  ResultSample,
} from "../../../../../domains/runtime/src/operation-result/index.js";

/** One usage report of a known total, class split unknown (P-15/D2): what an API or scripted leg reports. */
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

/** The one number a legacy sink records; a report with no total records nothing, so a drill that reaches here has one. */
function totalOf(sample: UsageSample): number {
  if (sample.totalTokens === null) throw new Error("a report with no total is recorded by nobody");
  return sample.totalTokens;
}

/**
 * The instruction content for a fixture whose prose is `text` (P-06/B, ADR 0094).
 *
 * One text block, so the envelope's `objective` equals the first text block of its
 * content and the two spellings stay one fact. `contentSha256` is a placeholder and
 * stays one after escalón C: C checks a declared digest against the bytes a
 * REFERENCE names, and a block whose text travels inline names no reference, so
 * there are no bytes for this figure to disagree with.
 */
function fixtureContent(text: string): Record<string, unknown> {
  return {
    contentContractVersion: 1,
    blocks: [
      {
        kind: "text",
        blockId: "b1",
        mediaType: "text/plain; charset=utf-8",
        byteLength: new TextEncoder().encode(text).byteLength,
        contentSha256: "0".repeat(64),
        artifactRefId: null,
        text,
        toolCallId: null,
        effectId: null,
      },
    ],
  };
}


// ---------------------------------------------------------------------------
// V2-B1f/F3: the checkpoint a terminal now has to write
// ---------------------------------------------------------------------------

/**
 * Make this scenario a real repository, and report what it actually holds.
 *
 * The four git facts a `Checkpoint` carries are observed, never invented: a
 * fabricated head would put a fiction in a drill ledger, which is the one thing
 * a drill may never do. The repository is created once per scenario and the
 * observation is taken at assembly time, so `isDirty` is what the worktree
 * looked like when the terminal ran rather than when the fixture was built.
 */
function checkpointFactsFor(worktree: string): {
  readonly worktreePath: string;
  readonly head: string;
  readonly branch: string;
  readonly isDirty: boolean;
} {
  const git = (...args: string[]): string =>
    spawnSync("/usr/bin/git", args, { cwd: worktree, encoding: "utf8" }).stdout;
  if (!existsSync(join(worktree, ".git"))) {
    git("init", "--quiet");
    git("config", "user.email", "drill@example.invalid");
    git("config", "user.name", "drill");
    git("commit", "--allow-empty", "-q", "-m", "checkpoint fixture");
  }
  return {
    worktreePath: worktree,
    head: git("rev-parse", "HEAD").trim(),
    branch: git("rev-parse", "--abbrev-ref", "HEAD").trim(),
    isDirty: git("status", "--porcelain", "--untracked-files=all").trim() !== "",
  };
}

/**
 * A checkpoint source for a suite that builds its construction directly.
 *
 * The twin of the production source in the daemon and of the two drill
 * children's, and declared here rather than imported for the reason
 * `initToyRepository` is declared in each suite that needs one: a test-tree
 * helper shared across packages would have to leave a pinned barrel, and the
 * barrel's names are pinned by equality.
 *
 * Every field still comes from something real: the coordinates this walk
 * derived, the `run.outcome` row it already appended, and a repository the
 * scenario really has. The digest arrays are `[]` because these fixtures carry
 * no envelope, which is the honest answer rather than a placeholder.
 */
function createDrillCheckpointSource(input: {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /** A repository this scenario really has. */
  readonly worktree: string;
}): CheckpointSource {
  const { ledger, invocation, worktree } = input;
  return {
    assemble(step): Checkpoint | CheckpointRefused {
      const recorded = ledger.getEventByIdempotencyKey(
        buildIdempotencyKey({
          taskId: invocation.taskId,
          attempt: invocation.attempt,
          transitionId: OUTCOME_STEP.transitionId,
        }),
      );
      if (recorded === null) {
        return { ok: false, reason: "CHECKPOINT_INVALID", at: "lastAtomicStep" };
      }
      const parsed: unknown = JSON.parse(recorded.canonicalJson);
      const completedAt =
        typeof parsed === "object" && parsed !== null && "occurredAt" in parsed
          ? (parsed as { readonly occurredAt: unknown }).occurredAt
          : undefined;
      if (typeof completedAt !== "string") {
        return { ok: false, reason: "CHECKPOINT_INVALID", at: "lastAtomicStep.completedAt" };
      }
      const facts = checkpointFactsFor(worktree);
      const coordinate = deriveEventCoordinate(invocation, step.transitionId, step.index);
      return {
        contractVersion: CONTRACT_VERSION,
        checkpointId: deterministicUuid(
          "checkpoint/" +
            invocation.invocationId +
            "/" +
            invocation.taskId +
            "/" +
            String(invocation.attempt) +
            "/" +
            step.transitionId,
        ),
        taskId: invocation.taskId,
        attempt: invocation.attempt,
        worker: input.emittedBy,
        createdAt: coordinate.occurredAt,
        lastAtomicStep: {
          index: OUTCOME_STEP.index,
          label: OUTCOME_STEP.transitionId,
          completedAt,
        },
        git: {
          head: facts.head,
          branch: facts.branch,
          worktreePath: facts.worktreePath,
          isDirty: facts.isDirty,
        },
        authorityDigest: [],
        readSetDigest: [],
        writeSetDigest: [],
        receipts: [],
        artifacts: [],
        pendingWork: [],
        // The §2.4 literal, quoted verbatim rather than imported: a drift in any
        // one of the sources that produce it fails here rather than propagating.
        nextSafeAction: "Await the next owner-authorized action.",
        notes: null,
      };
    },
  };
}

/** One source, one store, one root rule: the port a walking construction binds. */
function drillCheckpoints(input: {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /** Where the artifacts resolve: this scenario's own ledger path. */
  readonly ledgerPath: string;
  /** A repository this scenario really has. */
  readonly worktree: string;
}): CheckpointPort {
  return createCheckpointStore({
    ledgerPath: input.ledgerPath,
    source: createDrillCheckpointSource(input),
  });
}

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
  // V2-B1f/F3. The worktree holds every path its envelope declares.
  //
  // A write-set is a declaration, and `checkWriteSetConformance` compares it as
  // an exact string: it never required a declared entry to EXIST, so a drill
  // could declare `src/**` and have a gate that matched nothing. The checkpoint
  // digests the declared set against this worktree, so a declaration naming
  // nothing is now visible as `PATH_MISSING` -- which is the honest answer, and
  // the fixture is what has to change. Committed, so an unmodified declared
  // path is not itself an observed change.
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "src", "walk.ts"), "export const walked = true;\n", "utf8");
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
function envelopeFor(taskId: string, initiativeId: string, writeSet: readonly string[] = ["src/walk.ts"]): TaskEnvelope {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    initiativeId,
    title: "a drill packet",
    objective: "walk the plan",
    content: fixtureContent("walk the plan"),
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
  // The session's one usage report is the result's (P-15/D2, ADR 0105).
  JSON.stringify({ type: "result", subtype: "turn_completed", session_id: "session-drill", usage: { input_tokens: 0, output_tokens: TOKENS, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
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

/**
 * The same real adapter, behind a child that RETURNS WHAT IT RECEIVED (§4.3).
 *
 * It reads stdin to EOF, writes those bytes to a side file it owns, and only then
 * speaks the provider's wire format. The side file and not stdout, for the reason
 * the providers package's own delivery fixture gives: stdout is adapter-parsed, so
 * echoing an instruction there would turn it into a classified event whose bounded
 * payload can reach a log — the exact leak N-P06-14 forbids.
 */
function echoingClaude(echoPath: string, lines: readonly string[]): ProviderAdapter {
  const program = [
    "const chunks = [];",
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  require('node:fs').writeFileSync(" + JSON.stringify(echoPath) + ", Buffer.concat(chunks));",
    "  const lines = " + JSON.stringify([...lines]) + ";",
    "  for (const line of lines) process.stdout.write(line + '\\n');",
    "  process.exit(0);",
    "});",
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

/**
 * The same real adapter declaring it cannot carry the content's classes (§4.3).
 *
 * The refusal is the descriptor's, which is what puts it before the spawn: the
 * class travels, the adapter says no, and `startSession` never reaches
 * `spawnAdmitted`.
 */
function modalityRefusingClaude(echoPath: string): ProviderAdapter {
  const base = echoingClaude(echoPath, CLAUDE_LINES);
  return {
    ...base,
    describe(request: SessionRequest): SessionDescriptor {
      return { ...base.describe(request), delivery: { kind: "UNSUPPORTED", reason: "MODALITY_UNSUPPORTED" } };
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
  usageReport(1, TOKENS),
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
    modalities: ["text"],
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

async function walk(
  name: string,
  port: ModelExecutionPort,
  route: ResolvedRoute,
  /**
   * The worktree the checkpoint describes (V2-B1f/F3).
   *
   * Defaults to this walk's own scenario root, which is what every single-leg
   * case wants. The two-leg comparison below hands BOTH legs the same one: a
   * checkpoint carries the worktree it was taken over, so two legs observing
   * two directories would assemble two different checkpoints and the body
   * equality would fail for a reason that has nothing to do with the transports.
   */
  worktree?: string,
  /**
   * The execution this walk asks for.
   *
   * Defaults to the drill's own fixture request, which is what every case before
   * P-06/C wants. The acceptance proof hands in one composed by the REAL producer
   * instead, because §4.3 asks for the proof to be driven from the real door and
   * not from a fixture.
   */
  request: ExecutionRequest = executionRequest(),
): Promise<Walk> {
  const root = scenario(name);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const inv = invocation();
  const trail: ExecutionEvent[] = [];
  const effects = createExecutionEffects({
    port: recording(port, trail),
    route,
    request,
    scenarioRoot: root,
  });
  const supervisor = new SqliteSupervisor({
    ledger,
    invocation: inv,
    effects,
    checkpoints: drillCheckpoints({
      ledger,
      invocation: inv,
      emittedBy: EMITTED_BY,
      ledgerPath: scenarioLedgerPath(root),
      worktree: worktree ?? root,
    }),
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

/** The two per-transport facts of P-07 escalón C, which the neutral projection sets aside. */
const PER_LEG_KINDS: readonly string[] = ["processExited", "operationResult"];

/** The transport-neutral projection the two legs must agree on. */
function normalized(trail: readonly ExecutionEvent[]): Record<string, unknown> {
  return {
    kinds: trail.map((event) => event.kind).filter((kind) => !PER_LEG_KINDS.includes(kind)),
    everyEventValid: trail.every((event) => ExecutionEvent.safeParse(event).success),
    usageTotal: trail.reduce((sum, event) => (event.kind === "usage" && event.totalTokens !== null ? sum + event.totalTokens : sum), 0),
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
    // One worktree for both legs (V2-B1f/F3): the equivalence is over identical
    // inputs, and the worktree the checkpoint describes is one of them.
    const shared = scenario("b1b-execution-worktree");
    const cli = await walk("b1b-execution-cli", cliPort(), route, shared);
    const api = await walk("b1b-execution-api", apiPort(), { ...route, transportKind: "API_KEY" }, shared);

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
    // The three facts per leg (P-07 escalón C, ADR 0099): the CLI child's clean
    // exit directly before `completed`; the API leg owns no process and reports
    // none; neither scripted stream said what the operation decided.
    expect(cli.trail.filter((event) => event.kind === "processExited")).toEqual([
      { kind: "processExited", exitCode: 0, signal: null },
    ]);
    expect(cli.trail.at(-2)?.kind).toBe("processExited");
    expect(api.trail.some((event) => event.kind === "processExited")).toBe(false);
    for (const trail of [cli.trail, api.trail]) {
      expect(trail.some((event) => event.kind === "operationResult")).toBe(false);
    }

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
      // Leg-specific since P-07 escalón C: the CLI trail carries its child's exit.
      const eventCount = SHARED_KINDS.length + (leg === "cli" ? 1 : 0);
      expect(marker).toMatchObject({ operationId, eventCount });
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
      checkpoints: drillCheckpoints({
        ledger,
        invocation: inv,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
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
    // than the CLI leg can -- a tool use -- still walks to a checkpoint, and
    // the equality above is exactly what refuses to call the two legs equal.
    // A text delta served here until P-07 escalón C; it now goes to the sink and
    // never to the trail, so it would leave the two legs equal and this control
    // vacuous.
    const route = resolvedCliRoute();
    const cli = await walk("b1b-control-cli", cliPort(), route);
    const diverging = await walk(
      "b1b-control-api",
      apiPort([
        API_SCENARIO[0]!,
        { kind: "toolUse", tool: "search", detail: "a kind the CLI leg cannot say" },
        ...API_SCENARIO.slice(1),
      ]),
      { ...route, transportKind: "API_KEY" },
    );
    expect(diverging.state).toBe("CHECKPOINTED");
    expect(normalized(diverging.trail)).not.toEqual(normalized(cli.trail));
    expect(normalized(diverging.trail)["kinds"]).toEqual(["started", "toolUse", "usage", "state", "completed"]);
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

/**
 * A Claude turn with two assistant messages, whose spend arrives ONCE (P-15/D2, ADR
 * 0105): the assistant records report nothing, and the result carries the session's
 * own total. Before D2 each assistant record was a report and they were summed.
 */
const B7T_TWO_USAGE_LINES: readonly string[] = [
  JSON.stringify({ type: "system", subtype: "init", model: RESOLVED_MODEL }),
  JSON.stringify({ type: "assistant", message: { id: "msg-a", usage: { output_tokens: B7T_TOKENS_A } } }),
  JSON.stringify({ type: "assistant", message: { id: "msg-b", usage: { output_tokens: B7T_TOKENS_B } } }),
  JSON.stringify({ type: "result", subtype: "turn_completed", session_id: "session-b7t", usage: { input_tokens: 0, output_tokens: B7T_TOKENS_A + B7T_TOKENS_B, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
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
  usageReport(1, USAGE_TOKENS_MAX + 1),
  { kind: "state", toState: TERMINAL_STATE },
];

/** The same leg, inside the ceiling, so the refusal below is about the number. */
const B7T_UNDER_CEILING_CHUNKS: readonly ApiStreamChunk[] = [
  { kind: "started", resolvedModel: RESOLVED_MODEL, protocolVersion: "api/streaming-1" },
  usageReport(1, USAGE_TOKENS_MAX),
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
          tokens: totalOf(sample),
          transitionId: usageTransitionId(0, sample.operationIndex, sample.stepIndex),
          emittedBy: EMITTED_BY,
        });
      }),
  });

  const supervisor = new SqliteSupervisor({
    ledger,
    invocation: inv,
    effects,
    checkpoints: drillCheckpoints({
      ledger,
      invocation: inv,
      emittedBy: EMITTED_BY,
      ledgerPath: scenarioLedgerPath(root),
      worktree: root,
    }),
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
  it("P4/P5: one event per trail usage entry, and the session's one report is the port's own total (P-15/D2)", async () => {
    const walked = await walkRecording("b7t-usage-sum", B7T_TWO_USAGE_LINES);
    expect(walked.state).toBe("CHECKPOINTED");

    // Two assistant messages, ONE usage report: the result's total (P-15/D2, ADR
    // 0105). Before D2 each assistant record was an entry and they were summed.
    const entries = walked.trail.filter((event) => event.kind === "usage");
    expect(entries.length).toBe(1);

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
        usageTransitionId(0, operationForStep(walked.inv, INTENT_STEP).operationIndex, event.stepIndex),
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
          tokens: totalOf(sample),
          transitionId: usageTransitionId(0, sample.operationIndex, sample.stepIndex),
          emittedBy: EMITTED_BY,
        };
        results.push(recordTokenObservation(replayLedger!, observation).inserted);
        results.push(recordTokenObservation(replayLedger!, observation).inserted);
      },
    });

    // Inserted once, then an exact replay — for the session's one report (P-15/D2).
    expect(results).toEqual([true, false]);
    expect(walked.usageEvents).toHaveLength(1);
    expect(walked.state).toBe("CHECKPOINTED");
  });

  it("P8: a completed attempt resumes without appending a second usage event", async () => {
    // The other half, on the real resume path: with the marker verified,
    // `closeIntent` probes DONE and never re-enters `apply`, so nothing is
    // offered to the sink a second time.
    const walked = await walkRecording("b7t-usage-resume", B7T_TWO_USAGE_LINES);
    const before = walked.ledger.status();
    // The session's one report (P-15/D2).
    expect(walked.usageEvents).toHaveLength(1);

    const route = resolvedCliRoute();
    const resumed = await new SqliteSupervisor({
      ledger: walked.ledger,
      invocation: walked.inv,
      checkpoints: drillCheckpoints({
        ledger: walked.ledger,
        invocation: walked.inv,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(walked.root),
        worktree: walked.root,
      }),
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
        recorded.push(totalOf(sample));
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
        recorded.push(totalOf(sample));
        recordTokenObservation(walked.ledger, {
          invocation: walked.inv,
          kind: "USAGE",
          accountId: route.accountId,
          tokens: totalOf(sample),
          transitionId: usageTransitionId(0, sample.operationIndex, sample.stepIndex),
          emittedBy: EMITTED_BY,
        });
      },
    });
    const resumed = await new SqliteSupervisor({
      ledger: walked.ledger,
      invocation: walked.inv,
      effects: resumedEffects,
      checkpoints: drillCheckpoints({
        ledger: walked.ledger,
        invocation: walked.inv,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(walked.root),
        worktree: walked.root,
      }),
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
    // The session's one report (P-15/D2).
    expect(walked.usageEvents).toHaveLength(1);
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
  readonly envFile: string;
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
  // V2-B1f/F2b. The environment the subject was actually given, beside the
  // echo file and outside the worktree for the same reason: the adapter
  // decides the credential variable -- `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  // `KIMI_CODE_HOME` -- so which adapter admitted this entry is readable from
  // the subject's own process rather than from a spy on the admission call.
  // Written, never declared: it is outside the tree, so the conformance gate
  // neither expects it nor digests it.
  const envFile = join(echoRoot, "environment.json");
  const binary = join(root, "fake-provider");
  writeFileSync(
    binary,
    "#!" + realpathSync(process.execPath) + "\n" +
      "require('node:fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid));\n" +
      // First, so a subject that ran at all has recorded its environment even
      // if it is later killed. A subject that never ran leaves this file
      // absent, which is what the codex-routed and refused cases assert.
      "require('node:fs').writeFileSync(" + JSON.stringify(envFile) +
      ", JSON.stringify(process.env));\n" +
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
  // V2-B1f/F3. The declared `child.pid` is committed here, so the worktree
  // holds it whichever account is routed. The subject overwrites it with its
  // real pid when it runs; when the ROUTE names the other account's binding,
  // that subject writes into its own root and this worktree keeps the
  // committed file. A declaration naming a path only one of two routes
  // creates is a declaration the checkpoint cannot digest.
  writeFileSync(pidFile, "0", "utf8");
  temporaries.push(root);
  initWorktree(root);
  return { binary, root, pidFile, echoFile, envFile };
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
        transportKind: "CLI_SUBSCRIPTION",
        provider: "claude",
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
 * Two fake providers sharing one worktree, each with its own credential root.
 *
 * Hoisted to module scope so both the F2 switch drills below and P7's
 * clean-worktree case can build the same composition: routing the SECOND
 * account runs a subject whose script writes into its OWN root, which is the
 * only shape in this file that leaves the checkpointed worktree untouched.
 */
const SECOND_ACCOUNT = "acct-b4a-second";

/** Two fake providers sharing one worktree, each with its own credential root. */
function twoProviders(): {
  readonly worktree: string;
  readonly first: { binary: string; echoFile: string; envFile: string; pidFile: string; configRoot: string };
  readonly second: { binary: string; echoFile: string; envFile: string; pidFile: string; configRoot: string };
} {
  const a = fakeProviderBinary(CLAUDE_LINES, { linger: false });
  const b = fakeProviderBinary(CLAUDE_LINES, { linger: false });
  return {
    // One worktree per packet: the route's entry supplies it and every other
    // entry must declare the same one, so a switch cannot move the checkout.
    worktree: a.root,
    first: { binary: a.binary, echoFile: a.echoFile, envFile: a.envFile, pidFile: a.pidFile, configRoot: a.root },
    second: { binary: b.binary, echoFile: b.echoFile, envFile: b.envFile, pidFile: b.pidFile, configRoot: b.root },
  };
}

/** The CLI subscription vocabulary, spelled here so the mix can be named. */
type DrillProvider = "claude" | "codex" | "kimi";

/**
 * A two-entry execution config whose route names `accountId`.
 *
 * `mix` says which provider each entry declares (V2-B1f/F2b). Both are `claude`
 * by default, which is exactly what every F2 case above wants: those drills are
 * about accounts, not providers, and two claude subjects is what they always
 * ran. The route's own provider follows the routed entry, because a config
 * whose route disagreed with the entry serving it is refused at the door -- the
 * one case that builds such a config on purpose says so at the point it does it.
 */
function pluralExecution(
  accountId: string,
  providers: ReturnType<typeof twoProviders>,
  mix: { readonly first: DrillProvider; readonly second: DrillProvider } = {
    first: "claude",
    second: "claude",
  },
): DaemonExecutionConfig {
  const limits = {
    timeoutMs: 10_000,
    outputBudgetBytes: 64 * 1024,
    interruptGraceMs: 120,
    termGraceMs: 120,
  };
  return {
    route: {
      provider: accountId === SECOND_ACCOUNT ? mix.second : mix.first,
      model: "opus",
      accountId,
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: "2026-09-03.1",
      resolvedAt: RESOLVED_AT,
    },
    bindings: [
      {
        accountId: "acct-b4a-drill",
        transportKind: "CLI_SUBSCRIPTION",
        provider: mix.first,
        binary: providers.first.binary,
        configRoot: providers.first.configRoot,
        workdir: providers.worktree,
        limits,
      },
      {
        accountId: SECOND_ACCOUNT,
        transportKind: "CLI_SUBSCRIPTION",
        provider: mix.second,
        binary: providers.second.binary,
        configRoot: providers.second.configRoot,
        workdir: providers.worktree,
        limits,
      },
    ],
  };
}

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
        {
          ...second,
          transportKind: "CLI_SUBSCRIPTION" as const,
          provider: second.transportKind === "CLI_SUBSCRIPTION" ? second.provider : "claude",
          configRoot: second.transportKind === "CLI_SUBSCRIPTION" ? second.configRoot : providers.second.configRoot,
          binary: join(providers.second.configRoot, "no-such-binary"),
        },
      ],
    };

    await expect(
      startDaemon(b4aOptions(b4aScenarioId("f2-named-refusal"), broken)),
    ).rejects.toThrow(new RegExp("the execution binding for " + SECOND_ACCOUNT + " was refused"));
  });
});

/**
 * A binding declares the provider it serves (V2-B1f/F2b).
 *
 * F2 gave the entry an account but not a provider, so `executionPortFor`
 * hoisted ONE adapter out of the entry loop and every admitted binding got the
 * route's. The cost is not the diagnostic context -- `admitBinary` and the
 * directory admissions make no decision from it -- but the adapter itself:
 * `buildEnv` sets exactly `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or
 * `KIMI_CODE_HOME` from the adapter's own provider, so a codex account driven
 * by the claude adapter had its codex credential root exported under claude's
 * variable and `CODEX_HOME` was never set at all.
 *
 * **What is honestly observable here, and nothing stronger.** Only the routed
 * entry is ever executed before F5, so a non-routed entry's provider has two
 * consequences and these cases are built on exactly those two: the named
 * refusal now says which provider the entry was admitted as, and the port's
 * cross-provider guard becomes reachable through the daemon's own door.
 *
 * **What a daemon-level test may read.** A port refusal raised inside a walk
 * reaches the scenario ledger only as `TASK_FAILED` with
 * `reason: "EXECUTION_FAILED"` -- the payload carries a digest and a closed
 * reason and no exception message -- and reaches the daemon log only as the
 * error's bare name. So no case below asserts a refusal name or an `at` from
 * the daemon: `ROUTE_INVALID` at `route.provider` and `TRANSPORT_UNAVAILABLE`
 * at `startSession/PROTOCOL_UNSUPPORTED` are proven at port level, by the
 * providers suite and by the adapters' own `describe`, and are named here in
 * prose only. What the daemon can see is the ledger's shape and the subject's
 * own evidence, and that pair is fully discriminating against the before-state.
 *
 * Zero real providers, zero network, zero spend: every subject is a `node`
 * script under a `mkdtemp` root, and the codex entries below are never
 * executed at all.
 */
describe("F2b: a binding declares the provider it serves", () => {
  /**
   * The daemon-level evidence a mid-walk port refusal leaves behind.
   *
   * The ledger's shape, never a refusal name: the walk settled failed for an
   * execution reason and no checkpoint was written. A startup refusal would
   * leave no `TASK_FAILED` at all, so its presence also proves the daemon got
   * past composition and into the walk.
   */
  function settledWithoutCheckpoint(scenarioId: string): void {
    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(scenarioId)), { readOnly: true });
    try {
      const events = ledger.listEvents({ limit: 500 }).events;
      const types = events.map((entry) => entry.event.type);
      expect(types).toContain("TASK_FAILED");
      expect(types).not.toContain("CHECKPOINT_WRITTEN");
      const failed = events.find((entry) => entry.event.type === "TASK_FAILED");
      expect(failed?.event.payload["reason"]).toBe("EXECUTION_FAILED");
    } finally {
      ledger.close();
    }
  }

  /** A subject that never ran leaves exactly this behind, and nothing more. */
  function neverRan(subject: { echoFile: string; envFile: string; pidFile: string }): void {
    expect(existsSync(subject.echoFile)).toBe(false);
    expect(existsSync(subject.envFile)).toBe(false);
    // NOT absence: `fakeProviderBinary` commits `child.pid` as "0" for every
    // subject root before the daemon starts, so the file exists whether or not
    // it ever ran. What a refused subject leaves is the committed literal,
    // never overwritten by a real pid.
    expect(readFileSync(subject.pidFile, "utf8")).toBe("0");
  }

  it("P1 names the provider a refused binding was admitted as, and keeps F2's sentence", async () => {
    // The one discriminating positive available before F5. A route-derived
    // admission would have said `claude` here, because the route is claude;
    // the entry says codex, and the entry is what was admitted.
    const providers = twoProviders();
    const execution = pluralExecution("acct-b4a-drill", providers, {
      first: "claude",
      second: "codex",
    });
    const [first, second] = execution.bindings;
    if (first === undefined || second === undefined) throw new Error("expected two entries");
    const broken: DaemonExecutionConfig = {
      ...execution,
      bindings: [
        first,
        {
          ...second,
          transportKind: "CLI_SUBSCRIPTION" as const,
          provider: second.transportKind === "CLI_SUBSCRIPTION" ? second.provider : "claude",
          configRoot: second.transportKind === "CLI_SUBSCRIPTION" ? second.configRoot : providers.second.configRoot,
          binary: join(providers.second.configRoot, "no-such-binary"),
        },
      ],
    };

    await expect(
      startDaemon(b4aOptions(b4aScenarioId("f2b-named-provider"), broken)),
    ).rejects.toThrow(
      "the execution binding for " + SECOND_ACCOUNT +
        " was refused: BINARY_NOT_ADMITTED; it was admitted as codex",
    );

    // N8: the clause is APPENDED, so F2's own assertion still holds over the
    // same message, unchanged.
    await expect(
      startDaemon(b4aOptions(b4aScenarioId("f2b-named-provider-compat"), broken)),
    ).rejects.toThrow(new RegExp("the execution binding for " + SECOND_ACCOUNT + " was refused"));
  });

  it("P5(a) hands the routed entry its own provider's credential variable", async () => {
    // The subject writes the environment it was actually given, outside the
    // worktree, so this is evidence written by the process the daemon spawned
    // rather than a spy's record of a call. This is the foundation F5 inherits
    // and exactly what the hoisted adapter would have broken.
    const providers = twoProviders();
    const execution = pluralExecution("acct-b4a-drill", providers, {
      first: "claude",
      second: "codex",
    });

    const run = await startDaemon(b4aOptions(b4aScenarioId("f2b-claude-env"), execution));
    await stopDaemon(run);

    expect(existsSync(providers.first.envFile)).toBe(true);
    const env = JSON.parse(readFileSync(providers.first.envFile, "utf8")) as Record<string, string>;
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(providers.first.configRoot);
    // One provider's credential root never reaches another's variable.
    expect(env["CODEX_HOME"]).toBeUndefined();
    expect(env["KIMI_CODE_HOME"]).toBeUndefined();

    // The codex entry was admitted and bound, and still never executed: only
    // the routed entry runs before F5.
    expect(existsSync(providers.second.echoFile)).toBe(false);
    expect(existsSync(providers.second.envFile)).toBe(false);
  });

  it("P5(b) gives the codex entry the shipped codex adapter, proved by its honest refusal", async () => {
    // Codex and kimi cannot execute through the daemon at this HEAD: their
    // `describe` returns an UNSUPPORTED delivery, `startSession` throws
    // PROTOCOL_UNSUPPORTED before any spawn, and the port turns that into
    // TRANSPORT_UNAVAILABLE at `startSession/PROTOCOL_UNSUPPORTED`. That is a
    // limitation this packet neither lifts nor may lift -- and it is exactly
    // the evidence: the claude adapter would have spawned the subject and
    // written its echo file, and nothing was spawned at all.
    const providers = twoProviders();
    const execution = pluralExecution(SECOND_ACCOUNT, providers, {
      first: "claude",
      second: "codex",
    });
    const scenarioId = b4aScenarioId("f2b-codex-refused");

    await expect(startDaemon(b4aOptions(scenarioId, execution))).rejects.toThrow();

    settledWithoutCheckpoint(scenarioId);
    neverRan(providers.second);
  });

  it("N5 refuses a config value naming no CLI adapter, before any subject is spawned", async () => {
    // `startDaemon` accepts a `DaemonExecutionConfig` VALUE that never passed
    // the parser, so the composition defends its own door. The parser refuses
    // these outright; this is the second lock on the same gate.
    const providers = twoProviders();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [first, second] = execution.bindings;
    if (first === undefined || second === undefined) throw new Error("expected two entries");

    const outside = {
      ...execution,
      bindings: [first, { ...second, provider: "gemini" }],
    } as unknown as DaemonExecutionConfig;
    await expect(
      startDaemon(b4aOptions(b4aScenarioId("f2b-no-adapter"), outside)),
    ).rejects.toThrow(
      "the execution binding for " + SECOND_ACCOUNT + " names no CLI adapter for provider gemini",
    );

    // R2. `CLI_ADAPTERS` is a plain object typed by string, so an entry naming
    // an inherited member would resolve to `Object.prototype.constructor`
    // rather than to `undefined` and slip past the refusal above. Guarded with
    // `Object.hasOwn`, it is refused by the same sentence.
    const prototypeKey = {
      ...execution,
      bindings: [first, { ...second, provider: "constructor" }],
    } as unknown as DaemonExecutionConfig;
    await expect(
      startDaemon(b4aOptions(b4aScenarioId("f2b-prototype-key"), prototypeKey)),
    ).rejects.toThrow(
      "the execution binding for " + SECOND_ACCOUNT + " names no CLI adapter for provider constructor",
    );

    // Refused at admission: neither subject was ever spawned.
    expect(existsSync(providers.first.echoFile)).toBe(false);
    expect(existsSync(providers.second.echoFile)).toBe(false);
  });

  it("N6 makes the port's cross-provider guard reachable through the daemon's own door", async () => {
    // The sharpest test in the packet. This config never passed the parser --
    // which now refuses exactly this disagreement by name -- and the routed
    // entry declares codex while the route names claude.
    //
    // BEFORE this packet the entry was admitted under `CLI_ADAPTERS[route
    // .provider]`, so it ran under the claude adapter, reached CHECKPOINTED
    // and wrote its echo file: the port's guard compared the route's provider
    // with itself and could not fire. AFTER, the binding really carries the
    // codex adapter, the guard refuses ROUTE_INVALID at `route.provider` at the
    // first effect -- proven by name at port level, never read from here -- and
    // the walk settles failed with nothing spawned.
    const providers = twoProviders();
    const base = pluralExecution("acct-b4a-drill", providers, { first: "codex", second: "claude" });
    const disagreeing: DaemonExecutionConfig = {
      ...base,
      route: { ...base.route, provider: "claude" },
    };
    const scenarioId = b4aScenarioId("f2b-route-invalid");

    await expect(startDaemon(b4aOptions(scenarioId, disagreeing))).rejects.toThrow();

    settledWithoutCheckpoint(scenarioId);
    // The before-state wrote every one of these.
    neverRan(providers.first);
  });

  it("N10 leaves the non-CLI transport exactly as it was", async () => {
    // The behaviour the transport-keyed outer guard preserves byte for byte:
    // a route on another transport contributes no binding, so the map is empty
    // and the port refuses at `route.transportKind` the first time the walk
    // asks for an effect -- never served from a default, and never refused at
    // composition. `TASK_FAILED` being present at all is what proves the config
    // still LOADED: a startup refusal would have left no walk to fail.
    const providers = twoProviders();
    const base = pluralExecution("acct-b4a-drill", providers);
    const nonCli: DaemonExecutionConfig = {
      ...base,
      route: { ...base.route, transportKind: "API_KEY" },
    };
    const scenarioId = b4aScenarioId("f2b-non-cli");

    await expect(startDaemon(b4aOptions(scenarioId, nonCli))).rejects.toThrow();

    settledWithoutCheckpoint(scenarioId);
    neverRan(providers.first);
    neverRan(providers.second);
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

// ---------------------------------------------------------------------------
// V2-B1f/F3 — the PRODUCTION checkpoint source, over a real worktree
// ---------------------------------------------------------------------------

/**
 * Every case below drives `startDaemon`, and that is the point.
 *
 * The production source lives inside `packages/entrypoints/daemon/src/index.ts`
 * and is deliberately not exported: `DAEMON_PUBLIC_EXPORTS` is pinned by
 * equality, and widening a closed surface to make it testable would be the
 * defect in a different place. So it is proved the only honest way — a real
 * daemon walks a real plan over a real git worktree, and the artifact the
 * terminal names is read back out of the store and asserted field by field.
 */

/** Read the checkpoint a completed walk actually persisted. */
function persistedCheckpoint(scenarioId: string): {
  readonly checkpoint: Checkpoint;
  readonly digest: string;
  readonly terminal: { readonly occurredAt: string };
  readonly outcome: { readonly occurredAt: string };
  readonly taskId: string;
  readonly attempt: number;
} {
  const root = resolveScenarioRoot(scenarioId);
  const ledger = openLedger(scenarioLedgerPath(root), { readOnly: true });
  try {
    const events = ledger.listEvents({ limit: 500 }).events;
    const terminal = events.find((entry) => entry.event.type === "CHECKPOINT_WRITTEN");
    const outcome = events.find((entry) => entry.event.transitionId === OUTCOME_STEP.transitionId);
    if (terminal === undefined || outcome === undefined) {
      throw new Error("the walk did not reach its terminal");
    }
    const digest = terminal.event.payload["checkpointDigest"];
    if (typeof digest !== "string") throw new Error("the terminal names no checkpoint digest");

    const read = readArtifact(artifactRootFor(scenarioLedgerPath(root)), digest);
    if (!read.ok) throw new Error("the store does not hold " + digest + ": " + read.reason);
    return {
      checkpoint: JSON.parse(read.content) as Checkpoint,
      digest,
      terminal: { occurredAt: terminal.event.occurredAt },
      outcome: { occurredAt: outcome.event.occurredAt },
      taskId: terminal.event.taskId,
      attempt: terminal.event.attempt,
    };
  } finally {
    ledger.close();
  }
}

/** The suite's own reading of a worktree, taken independently of the daemon's. */
function observeIndependently(worktree: string): {
  readonly head: string;
  readonly branch: string;
  readonly dirty: boolean;
} {
  const git = (...args: string[]): string =>
    spawnSync("/usr/bin/git", args, { cwd: worktree, encoding: "utf8" }).stdout;
  return {
    head: git("rev-parse", "HEAD").trim(),
    branch: git("rev-parse", "--abbrev-ref", "HEAD").trim(),
    dirty: git("status", "--porcelain", "--untracked-files=all").trim() !== "",
  };
}

describe("P5: every checkpoint field comes from a fact the plane holds", () => {
  it("asserts each one against its own source, and none against a literal in the source", async () => {
    const { binary, root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const id = b4aScenarioId("f3-p5-fields");
    const options = b4aOptions(id, b4aExecutionConfig(binary, root));
    await stopDaemon(await startDaemon(options));

    const seen = persistedCheckpoint(id);
    const value = seen.checkpoint;
    const observed = observeIndependently(root);

    // Identity and coordinates: derived, never read from a clock.
    expect(value.contractVersion).toBe(CONTRACT_VERSION);
    expect(value.taskId).toBe(seen.taskId);
    expect(value.attempt).toBe(seen.attempt);
    expect(value.worker).toBe(EMITTED_BY);
    expect(value.createdAt).toBe(seen.terminal.occurredAt);

    // The last atomic step is the ledger's own `run.outcome` row.
    expect(value.lastAtomicStep).toEqual({
      index: OUTCOME_STEP.index,
      label: OUTCOME_STEP.transitionId,
      completedAt: seen.outcome.occurredAt,
    });

    // The git facts, compared against an observation this suite took itself
    // rather than against the one the daemon reported to itself.
    expect(value.git.head).toBe(observed.head);
    expect(value.git.branch).toBe(observed.branch);
    expect(value.git.worktreePath).toBe(root);
    expect(value.git.isDirty).toBe(observed.dirty);

    // Authority is copied from the envelope, never re-derived.
    expect(value.authorityDigest).toEqual(options.envelope.authority);

    // The declared sets are digested against the worktree, and the digests are
    // the real bytes' — checked here against an independent read.
    expect(value.writeSetDigest.map((entry) => entry.path)).toEqual([...options.envelope.writeSet]);
    for (const entry of value.writeSetDigest) {
      expect({ path: entry.path, sha256: entry.sha256 }).toEqual({
        path: entry.path,
        sha256: createHash("sha256").update(readFileSync(join(root, entry.path))).digest("hex"),
      });
    }
    expect(value.readSetDigest.map((entry) => entry.path)).toEqual([...options.envelope.readSet]);

    // The plane produces no reference at a terminal today, and says so.
    expect({ receipts: value.receipts, artifacts: value.artifacts, pendingWork: value.pendingWork }).toEqual({
      receipts: [],
      artifacts: [],
      pendingWork: [],
    });
    // The §2.4 literal, quoted verbatim rather than imported.
    expect(value.nextSafeAction).toBe("Await the next owner-authorized action.");
    expect(value.notes).toBeNull();
  }, 120_000);
});

describe("P7: isDirty is derived from the observation, not assumed", () => {
  it("is true for a tracked change the walk made", async () => {
    // The subject overwrites the committed `child.pid` with its own pid, which
    // git reports as a modification of a tracked file.
    const dirty = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const id = b4aScenarioId("f3-p7-tracked");
    await stopDaemon(await startDaemon(b4aOptions(id, b4aExecutionConfig(dirty.binary, dirty.root))));

    const seen = persistedCheckpoint(id);
    const independent = observeIndependently(dirty.root);
    expect(independent.dirty).toBe(true);
    expect(seen.checkpoint.git.isDirty).toBe(true);
    // The checkpoint's reading and this suite's own reading agree, which is
    // what makes `isDirty` an observation rather than an assumption.
    expect(seen.checkpoint.git.isDirty).toBe(independent.dirty);
  }, 120_000);

  it("is true for an untracked path, which is a different observation entirely", async () => {
    // A tracked modification and an untracked file are two different fields of
    // the observation (`trackedChanges` and `untrackedPaths`), and `isDirty` is
    // the disjunction of both. A drill that only ever produced the first would
    // leave half the derivation unexercised.
    const provider = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const id = b4aScenarioId("f3-p7-untracked");
    const options = b4aOptions(id, b4aExecutionConfig(provider.binary, provider.root));

    // Declared as well as created: an undeclared untracked file is a write-set
    // violation and the gate would refuse the walk before its terminal, so the
    // only way to observe an untracked path AT the terminal is to declare it.
    // The conformance gate is left exactly as strict as it was.
    writeFileSync(join(provider.root, "untracked.txt"), "written outside the index\n", "utf8");
    const declared = { ...options.envelope, writeSet: ["child.pid", "untracked.txt"] };

    await stopDaemon(await startDaemon({ ...options, envelope: declared }));
    const seen = persistedCheckpoint(id);
    const independent = observeIndependently(provider.root);

    // The file really is untracked, not merely present.
    expect(
      spawnSync("/usr/bin/git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: provider.root,
        encoding: "utf8",
      }).stdout,
    ).toContain("?? untracked.txt");
    expect(independent.dirty).toBe(true);
    expect(seen.checkpoint.git.isDirty).toBe(true);
    expect(seen.checkpoint.git.isDirty).toBe(independent.dirty);
  }, 120_000);

  it("is false over a worktree the walk really left clean", async () => {
    // The clean half, and it needs a walk that genuinely writes nothing into
    // the worktree it is checkpointing. `twoProviders()` gives two subjects
    // with two credential roots and ONE shared worktree — the first provider's.
    // Routing the SECOND account runs the second subject, whose script writes
    // its pid into its own root, so the shared worktree is observed exactly as
    // the fixture committed it.
    const providers = twoProviders();
    const id = b4aScenarioId("f3-p7-clean");
    const before = observeIndependently(providers.worktree);
    expect(before.dirty).toBe(false);

    await stopDaemon(
      await startDaemon(b4aOptions(id, pluralExecution(SECOND_ACCOUNT, providers))),
    );

    // The second subject ran, and it ran somewhere else.
    expect(existsSync(providers.second.echoFile)).toBe(true);

    const seen = persistedCheckpoint(id);
    const independent = observeIndependently(providers.worktree);
    expect(independent.dirty).toBe(false);
    expect(seen.checkpoint.git.isDirty).toBe(false);
    expect(seen.checkpoint.git.isDirty).toBe(independent.dirty);
    // And the head is still the fixture's own commit: nothing moved the tree.
    expect(seen.checkpoint.git.head).toBe(before.head);
  }, 120_000);
});

describe("N8: a declared path the worktree does not hold refuses, and nothing is appended", () => {
  it("refuses PATH_MISSING for a readSet entry, and the task never reaches CHECKPOINTED", async () => {
    const { binary, root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const id = b4aScenarioId("f3-n8-readset");
    const options = b4aOptions(id, b4aExecutionConfig(binary, root));
    // A read-set entry nothing ever created. The conformance gate does not
    // look at the read-set, so the walk reaches its terminal and the checkpoint
    // is the first thing that asks whether the declaration is true.
    const envelope = { ...options.envelope, readSet: ["docs/never-written.md"] };

    let message = "";
    try {
      await stopDaemon(await startDaemon({ ...options, envelope }));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("PATH_MISSING");
    expect(message).toContain("docs/never-written.md");

    // No digest was invented, and the terminal was never appended.
    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)), { readOnly: true });
    try {
      const types = ledger.listEvents({ limit: 500 }).events.map((entry) => entry.event.type);
      expect(types).not.toContain("CHECKPOINT_WRITTEN");
      expect(ledger.getTask(options.taskId)?.currentState).not.toBe("CHECKPOINTED");
    } finally {
      ledger.close();
    }
    expect(existsSync(artifactRootFor(scenarioLedgerPath(resolveScenarioRoot(id))))).toBe(false);
  }, 120_000);
});

describe("N7: an unborn HEAD is refused rather than reported as a commit", () => {
  it("refuses GIT_HEAD_UNBORN over a repository with no commit, and appends nothing", async () => {
    const { binary, root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const id = b4aScenarioId("f3-n7-unborn");
    const options = b4aOptions(id, b4aExecutionConfig(binary, root));

    // Back to a repository at its initial commit: the history is removed, the
    // worktree and its files are not. `git status` still succeeds, so the
    // observation is real and its `head` is honestly null — which is exactly
    // the case `Checkpoint.git.head`'s 40-character contract cannot represent.
    rmSync(join(root, ".git"), { recursive: true, force: true });
    spawnSync("/usr/bin/git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
    spawnSync("/usr/bin/git", ["config", "user.email", "drill@example.invalid"], { cwd: root, encoding: "utf8" });
    spawnSync("/usr/bin/git", ["config", "user.name", "drill"], { cwd: root, encoding: "utf8" });

    // With no commit, every file in the worktree is untracked, so the
    // conformance gate would refuse first and the walk would never reach its
    // terminal. Declaring exactly what is there is what lets the walk get far
    // enough for the checkpoint to be the thing that refuses -- which is the
    // property under test, and the gate is left doing its own job unchanged.
    const present = spawnSync("/usr/bin/git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    })
      .stdout.split("\n")
      .map((line) => line.slice(3).trim())
      .filter((entry) => entry !== "");
    expect(present.length).toBeGreaterThan(0);

    let message = "";
    try {
      await stopDaemon(await startDaemon({ ...options, envelope: { ...options.envelope, writeSet: present } }));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("GIT_HEAD_UNBORN");

    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)), { readOnly: true });
    try {
      expect(ledger.listEvents({ limit: 500 }).events.map((entry) => entry.event.type)).not.toContain(
        "CHECKPOINT_WRITTEN",
      );
    } finally {
      ledger.close();
    }
  }, 120_000);
});

describe("P8: a tracked deletion digests the empty string, and only a tracked deletion does", () => {
  it("digests the empty string for a deleted declared path, and real bytes for one that is there", async () => {
    const { binary, root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const id = b4aScenarioId("f3-p8-deletion");
    const options = b4aOptions(id, b4aExecutionConfig(binary, root));

    // Two declared paths, both committed by the fixture, and they differ in
    // exactly the way this property is about:
    //
    //   `child.pid`   -- the subject REWRITES it at process start, so at the
    //                    terminal the worktree holds it and the digest must be
    //                    of its real bytes;
    //   `src/walk.ts` -- nothing rewrites it, so deleting it here leaves the
    //                    state git reports as a tracked deletion, and the
    //                    digest must be of NO bytes.
    //
    // Deleting the one the subject recreates would have measured the wrong
    // branch: the source would have taken its `readFileSync` path and the
    // assertion would have been true without the deletion rule ever running.
    rmSync(join(root, "src", "walk.ts"), { force: true });
    expect(existsSync(join(root, "src", "walk.ts"))).toBe(false);
    // Still in the index, which is what makes it a DELETION rather than an
    // absence: git reports a status line for it, and the observer's own rule
    // answers that line with the digest of no bytes.
    expect(
      spawnSync("/usr/bin/git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: root,
        encoding: "utf8",
      }).stdout,
    ).toContain("src/walk.ts");

    const declared = { ...options.envelope, writeSet: ["child.pid", "src/walk.ts"] };
    await stopDaemon(await startDaemon({ ...options, envelope: declared }));
    const seen = persistedCheckpoint(id);

    const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    // Stated as a literal too, so this cannot pass by sharing a mistake with
    // the expression that produced it.
    expect(EMPTY_SHA256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    const deleted = seen.checkpoint.writeSetDigest.find((entry) => entry.path === "src/walk.ts");
    expect(deleted?.sha256).toBe(EMPTY_SHA256);
    // And the file really did stay deleted through the walk, so the digest
    // above is the deletion branch's answer and not a coincidence.
    expect(existsSync(join(root, "src", "walk.ts"))).toBe(false);

    const present = seen.checkpoint.writeSetDigest.find((entry) => entry.path === "child.pid");
    expect(existsSync(join(root, "child.pid"))).toBe(true);
    expect(present?.sha256).toBe(
      createHash("sha256").update(readFileSync(join(root, "child.pid"))).digest("hex"),
    );
    // The two answers differ, which is the whole point: one path was read and
    // the other was observed absent, in the same walk.
    expect(present?.sha256).not.toBe(deleted?.sha256);
  }, 120_000);

  it("and only a tracked deletion does: a declared path that never existed refuses instead", async () => {
    // The other half of "only a tracked deletion does". A path git has never
    // heard of produces no status line, so there is nothing for the deletion
    // rule to answer and the source refuses rather than inventing the same
    // empty digest. This is N8's law on the write-set side.
    const { binary, root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const id = b4aScenarioId("f3-p8-never-existed");
    const options = b4aOptions(id, b4aExecutionConfig(binary, root));
    const declared = { ...options.envelope, writeSet: ["child.pid", "src/never-created.ts"] };

    let message = "";
    try {
      await stopDaemon(await startDaemon({ ...options, envelope: declared }));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("PATH_MISSING");
    expect(message).toContain("src/never-created.ts");

    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)), { readOnly: true });
    try {
      expect(ledger.listEvents({ limit: 500 }).events.map((entry) => entry.event.type)).not.toContain(
        "CHECKPOINT_WRITTEN",
      );
    } finally {
      ledger.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// V2-B1f/F4 — the pressure a provider reports becomes a durable row
// ---------------------------------------------------------------------------

/**
 * The one half of this packet that is reachable through a real daemon, and it
 * is reachable on the shipped parser rather than on an invention.
 *
 * Claude is the only provider that can execute here — codex and kimi declare
 * an UNSUPPORTED delivery and `startSession` refuses before any spawn — and the
 * one pressure Claude documents is its `auth_required` system frame. So the
 * subject writes that frame, the **shipped** `claudeAdapter.parse` classifies
 * it (nothing is spliced: `fakeProviderBinary` is a node script speaking
 * Claude's wire format, and the adapter is the real one the daemon composes),
 * and the walk records exactly one row naming the account and the provider.
 *
 * **What this case does not claim.** Nothing about Claude's quota behaviour.
 * Claude publishes no quota vocabulary this plane can read, and the quota half
 * of the packet is proved at adapter, normalizer, port and recorder level
 * because it is dormant in production: codex stays refused at `startSession`
 * until framing is authorized, and this packet neither lifts that nor adds a
 * seam around it.
 */

/** A Claude turn that reports it needs a human, between `init` and `result`. */
const F4_AUTH_LINES: readonly string[] = [
  JSON.stringify({ type: "system", subtype: "init", model: RESOLVED_MODEL }),
  JSON.stringify({ type: "system", subtype: "auth_required" }),
  JSON.stringify({ type: "assistant", message: { usage: { output_tokens: TOKENS } } }),
  JSON.stringify({ type: "result", subtype: "turn_completed", session_id: "session-f4", usage: { input_tokens: 0, output_tokens: TOKENS, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
];

describe("F4: the plane records the pressure a provider reports", () => {
  it("records one attributed row for an auth requirement, and still checkpoints", async () => {
    const { binary, root } = fakeProviderBinary(F4_AUTH_LINES, { linger: false });
    const id = b4aScenarioId("f4-auth-recorded");
    await stopDaemon(await startDaemon(b4aOptions(id, b4aExecutionConfig(binary, root))));

    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)), { readOnly: true });
    try {
      const events = ledger.listEvents({ limit: 500 }).events;
      const raised = events.filter((entry) => entry.event.type === "AUTH_REQUIRED_RAISED");

      // Exactly one row, for exactly one observed frame. Before this packet
      // the event reached the trail, was folded into a digest and discarded,
      // and the walk succeeded with the evidence gone.
      expect(raised).toHaveLength(1);
      const row = raised[0]?.event;
      expect(row?.payload).toEqual({
        accountId: "acct-b4a-drill",
        provider: "claude",
        pressure: "AUTH_REQUIRED",
      });
      // A same-state passthrough: the row names what happened without moving
      // the task, and the walk reaches its terminal exactly as before.
      expect(row?.fromState).toBe(row?.toState);
      expect(events.map((entry) => entry.event.type)).toContain("CHECKPOINT_WRITTEN");

      // The producer this type acquires is the walk itself. Nothing here
      // decided anything: no switch, no plan, no account state.
      for (const forbidden of [
        "ACCOUNT_SWITCH_STARTED",
        "ACCOUNT_SWITCH_COMPLETED",
        "QUOTA_BLOCKED",
      ]) {
        expect({
          forbidden,
          present: events.some((entry) => entry.event.type === forbidden),
        }).toEqual({ forbidden, present: false });
      }
      // And no quota row: an auth requirement is not an allowance problem.
      expect(events.some((entry) => entry.event.type === "QUOTA_WARNING")).toBe(false);

      // No provider message, prompt, URL or code travelled with it: the
      // payload is three classified scalars.
      const serialized = JSON.stringify(raised);
      for (const token of ["auth_required", "LOGIN_REQUIRED", "http", "remaining", "resetAt"]) {
        expect({ token, present: serialized.includes(token) }).toEqual({ token, present: false });
      }
    } finally {
      ledger.close();
    }
  }, 120_000);

  it("records nothing at all for a walk whose provider reported no pressure", async () => {
    // The regression half, stated as its own case: the unedited scenario every
    // other drill in this file runs produces the same ledger it always did.
    const { binary, root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const id = b4aScenarioId("f4-quiet-walk");
    await stopDaemon(await startDaemon(b4aOptions(id, b4aExecutionConfig(binary, root))));

    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)), { readOnly: true });
    try {
      const types = ledger.listEvents({ limit: 500 }).events.map((entry) => entry.event.type);
      expect(types).toContain("CHECKPOINT_WRITTEN");
      // Silence is not a pressure, and no default is supplied.
      expect(types).not.toContain("AUTH_REQUIRED_RAISED");
      expect(types).not.toContain("QUOTA_WARNING");
    } finally {
      ledger.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// V2-B1f/F4a errata — a failed execution records what its trail already said
// ---------------------------------------------------------------------------

/**
 * The discriminating drill, and it is reachable on the **shipped** parser.
 *
 * F4a recorded pressure only when `execute` returned, so an execution whose
 * stream ended in `error` discarded a fully built trail — and the case that
 * matters most is exactly that one: a provider that reports an exhaustion and
 * then dies. The asymmetry ran backwards.
 *
 * The fixture is F4a's own prefix with the clean terminal replaced by a frame
 * the adapter cannot read. `readRecord` returns `MALFORMED_EVENT`, the session
 * fails, `finish()` reports a dead session and `terminated` yields an `error`
 * terminal. **No test seam, no adapter injection, no providers edit and no new
 * `fakeProviderBinary` option** — the malformed frame is one of the six ways a
 * real stream reaches that terminal.
 */

/**
 * F4a's prefix, then a frame that parses but cannot be expressed.
 *
 * **Measured while writing this, and it decided the fixture.** A line that is
 * not a JSON record at all does *not* work: `claudeAdapter.parse` refuses the
 * whole chunk it was handed and discards every signal it had already parsed
 * from earlier lines in that same chunk (`claude/index.ts:253-258`), and a
 * subject writing three lines in a row delivers them in one chunk. The
 * `auth_required` frame would never be emitted, so there would be nothing on
 * the trail to record and the drill would prove nothing.
 *
 * This frame fails one layer later instead, which is the layer that matters:
 * the parser accepts any non-empty model, payload shaping bounds strings at
 * 200, and `ExecutionEvent` bounds `resolvedModel` at 120 — so the third
 * record parses, normalizes, and then **fails the contract in the port**,
 * which throws `StreamFailure` *after* the earlier events have already been
 * yielded. `terminated` catches it and yields an `error` terminal.
 *
 * It is one of the six ways a real stream reaches that terminal, it is the
 * same mechanism the landed `b4a-reap` case uses, and it needs **no test seam,
 * no adapter injection, no providers edit and no new `fakeProviderBinary`
 * option**.
 */
const F4E_UNEXPRESSIBLE_LINES: readonly string[] = [
  JSON.stringify({ type: "system", subtype: "init", model: RESOLVED_MODEL }),
  JSON.stringify({ type: "system", subtype: "auth_required" }),
  JSON.stringify({ type: "system", subtype: "init", model: "m".repeat(200) }),
];

describe("F4a errata: a failed execution records what its trail already said", () => {
  it("D1/D2 records the auth requirement, and the walk still fails the same way", async () => {
    const { binary, root } = fakeProviderBinary(F4E_UNEXPRESSIBLE_LINES, { linger: false });
    const id = b4aScenarioId("f4e-error-path-records");

    // The walk fails: that is the invariant this packet must not disturb.
    await expect(
      startDaemon(b4aOptions(id, b4aExecutionConfig(binary, root))),
    ).rejects.toThrow();

    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)), { readOnly: true });
    try {
      const events = ledger.listEvents({ limit: 500 }).events;
      const types = events.map((entry) => entry.event.type);

      // D1: exactly one row, for the one frame the provider actually emitted
      // before it became unreadable. Before this packet the ledger held none.
      const raised = events.filter((entry) => entry.event.type === "AUTH_REQUIRED_RAISED");
      expect(raised).toHaveLength(1);
      const row = raised[0]?.event;
      expect(row?.payload).toEqual({
        accountId: "acct-b4a-drill",
        provider: "claude",
        pressure: "AUTH_REQUIRED",
      });
      // Still a same-state passthrough: recording evidence moves no state.
      expect(row?.fromState).toBe(row?.toState);

      // D2: the walk settled failed, for an execution reason, with no
      // checkpoint — byte-for-byte the verdict it reached before.
      expect(types).toContain("TASK_FAILED");
      expect(types).not.toContain("CHECKPOINT_WRITTEN");
      const failed = events.find((entry) => entry.event.type === "TASK_FAILED");
      expect(failed?.event.payload["reason"]).toBe("EXECUTION_FAILED");

      // D3: no transcript, no message, no path in the rows THIS packet
      // records — F4a's own sweep over its own rows, extended with the strings
      // this error path introduces. (The lease events carry the worktree path
      // and always have; that is not a row this packet writes and not a claim
      // it makes.)
      const serialized = JSON.stringify(raised);
      for (const secret of [
        "auth_required",
        "LOGIN_REQUIRED",
        "MALFORMED_EVENT",
        "session failed",
        "mmmmmmmmmm",
        "http",
        binary,
        root,
      ]) {
        expect({ secret, leaked: serialized.includes(secret) }).toEqual({ secret, leaked: false });
      }
    } finally {
      ledger.close();
    }
  }, 120_000);

  it("D2: a failed execution leaves no evidence marker behind", async () => {
    // The other half of "the same way": a marker is what makes a step
    // un-re-runnable, and a failed execution must not leave one. The gate that
    // would have run before it deliberately still does not run at all.
    const { binary, root } = fakeProviderBinary(F4E_UNEXPRESSIBLE_LINES, { linger: false });
    const id = b4aScenarioId("f4e-no-marker");

    await expect(
      startDaemon(b4aOptions(id, b4aExecutionConfig(binary, root))),
    ).rejects.toThrow();

    const executions = join(resolveScenarioRoot(id), "executions");
    expect(existsSync(executions) ? readdirSync(executions) : []).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// V2-B1f/F4d — the walk plays a switch it did not decide
// ---------------------------------------------------------------------------

/**
 * The discriminating drill, on a real daemon, a real lease and the real
 * executor.
 *
 * **The trigger is seeded, and the drill says so in its own title.** At this
 * HEAD no shipped parser can produce a quota classification: Claude publishes
 * none, and codex and kimi are refused before any spawn. So a walk cannot
 * observe an exhaustion end to end today, and a drill that pretended otherwise
 * would be asserting an invention. What is real here is everything after the
 * observation — the door that admits a decided switch, the fold that matches
 * it against this attempt's own recorded rows, the executor that appends under
 * the daemon's own lease, and the supervisor that does not settle. The
 * production reach of the trigger arrives with the provider framing, and the
 * record says so.
 *
 * The failure itself is the F4a-E mechanism, unchanged: a frame that parses,
 * normalizes and then fails the contract in the port, so the trail is drained
 * and the pressure recorded before the refusal.
 */

const F4D_CROSS_TASK = "f4dd0000-0000-4000-8000-0000000000ff";

const F4D_DRILL_TASKS = [
  "f4dd0000-0000-4000-8000-000000000001",
  "f4dd0000-0000-4000-8000-000000000002",
  "f4dd0000-0000-4000-8000-000000000003",
  "f4dd0000-0000-4000-8000-000000000004",
] as const;

/** The options a switch drill runs under, with a task id the drill can seed. */
function f4dOptions(
  scenarioId: string,
  execution: DaemonExecutionConfig,
  taskId: string,
): Parameters<typeof startDaemon>[0] {
  return {
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
 * Seed the task and the exhaustion the elector decided from.
 *
 * The discovery row makes the task exist so the recorder will accept a row
 * against it; the walk then continues from `DISCOVERED` exactly as a replayed
 * walk does. The pressure row is written by the **real** recorder, under a
 * `pressure.` transition id for this attempt, so what the fold reads back is
 * the shape the walk itself writes.
 */
function seedExhaustion(
  scenarioId: string,
  taskId: string,
  accountId: string,
  route: ResolvedRoute,
): { readonly crossTaskEventId: string } {
  const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(scenarioId)));
  try {
    const seedFor = (task: string, trailIndex: number): string => {
      // The daemon's own invocation, derived the way it derives it — from the
      // task and the attempt alone. Anything else would make the seeded first
      // event a *different* event under the same key, and the ledger would
      // refuse the daemon's own append.
      const invocation = deriveInvocation(
        task,
        1,
        SUBMITTED_AT,
        canonicalSubmissionDigest({
          taskId: task,
          attempt: 1,
          submittedAt: SUBMITTED_AT,
          initiativeId: B4A_INITIATIVE_ID,
          route,
        }),
      );
      const step = LIFECYCLE_PLAN[0];
      if (step === undefined) throw new Error("no plan step");
      // The plan's own first step, built by the plan's own producer, so the
      // daemon replays it rather than colliding with it.
      appendPlanStep(
        {
          ledger,
          effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
          invocation,
          emittedBy: EMITTED_BY,
          plan: LIFECYCLE_PLAN,
          route,
          initiativeId: B4A_INITIATIVE_ID,
        },
        step,
      );
      recordProviderPressure(ledger, {
        invocation,
        accountId,
        provider: "claude",
        pressure: "QUOTA_EXHAUSTED",
        transitionId: pressureTransitionId(4, trailIndex),
        emittedBy: EMITTED_BY,
      });
      const rows = ledger
        .listEvents({ taskId: task, limit: 100 })
        .events.filter((entry) => entry.event.transitionId.startsWith("pressure."));
      const seeded = rows[rows.length - 1]?.event.eventId;
      if (seeded === undefined) throw new Error("the seeded pressure row is missing");
      return seeded;
    };

    // **Trail index 9, deliberately.** The walk's own pressure drain records
    // the frame it observes at its position in the trail, which for this
    // fixture is index 1 — seeding there would collide with the walk's own row
    // under one idempotency key. A position no trail of this length can reach
    // keeps the seeded exhaustion and the observed auth requirement as two
    // separate facts, which is what they are.
    seedFor(taskId, 9);

    // The cross-task cause. `decidedFromEventId` is the row an elector decided
    // FROM, and a decision is taken from evidence recorded before this walk —
    // on another task, typically the one that exhausted the account first. It
    // is deliberately not the row that satisfied this attempt's match.
    const crossTaskEventId = seedFor(F4D_CROSS_TASK, 0);
    return { crossTaskEventId };
  } finally {
    ledger.close();
  }
}

/**
 * Two claude bindings whose **routed** subject fails after observing.
 *
 * `twoProviders` builds two subjects that complete cleanly, which is right for
 * every drill about routing and wrong for this one: a switch is played from
 * the supervisor's catch, so the walk has to fail. The routed subject emits
 * the F4a-E frames — parse, normalize, then fail the contract in the port —
 * so the trail is drained and the pressure recorded before the refusal.
 */
function twoProvidersWithFailingRoute(): ReturnType<typeof twoProviders> {
  const a = fakeProviderBinary(F4E_UNEXPRESSIBLE_LINES, { linger: false });
  const b = fakeProviderBinary(CLAUDE_LINES, { linger: false });
  return {
    worktree: a.root,
    first: { binary: a.binary, echoFile: a.echoFile, envFile: a.envFile, pidFile: a.pidFile, configRoot: a.root },
    second: { binary: b.binary, echoFile: b.echoFile, envFile: b.envFile, pidFile: b.pidFile, configRoot: b.root },
  };
}

/** The decided switch an elector would have emitted for that exhaustion. */
function drillAuthorization(
  fromAccountId: string,
  toAccountId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    trigger: "QUOTA_EXHAUSTED",
    decidedForAccountId: fromAccountId,
    decidedBy: EMITTED_BY,
    decidedAt: SUBMITTED_AT,
    decidedFromEventId: deterministicUuid("f4d/decided-from/" + fromAccountId),
    observedSince: SUBMITTED_AT,
    plan: {
      kind: "SWITCH",
      accountStatus: "EXHAUSTED",
      taskState: "QUOTA_BLOCKED",
      steps: ["MARK_TASK_QUOTA_BLOCKED", "RELEASE_LEASE", "SELECT_ACCOUNT"],
      selectedAccountId: toAccountId,
      events: [
        { type: "QUOTA_WARNING", payload: { accountId: fromAccountId } },
        { type: "TASK_STATE_CHANGED", payload: { toState: "QUOTA_BLOCKED" } },
        { type: "LEASE_REVOKED", payload: { accountId: fromAccountId } },
        {
          type: "ACCOUNT_SWITCH_STARTED",
          payload: { fromAccountId, toAccountId },
        },
      ],
    },
    ...overrides,
  };
}

function readRows(scenarioId: string): readonly {
  readonly type: string;
  readonly transitionId: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly causationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}[] {
  const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(scenarioId)), { readOnly: true });
  try {
    return ledger.listEvents({ limit: 500 }).events.map((entry) => entry.event);
  } finally {
    ledger.close();
  }
}

describe("F4d: the walk plays a switch it did not decide (trigger seeded)", () => {
  it("D1: plays the four rows under the daemon's own lease, and does not settle", async () => {
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f4d-plays");
    const taskId = F4D_DRILL_TASKS[0];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);

    const authorized: DaemonExecutionConfig = {
      ...execution,
      switchAuthorization: drillAuthorization(routed.accountId, second.accountId, {
        decidedFromEventId: seeded.crossTaskEventId,
      }),
    } as DaemonExecutionConfig;

    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();

    const rows = readRows(id);
    const switched = rows.filter((event) => event.transitionId.startsWith("switch."));
    expect(switched.map((event) => event.transitionId)).toEqual([
      "switch.0.quota_warning",
      "switch.1.task_state_changed",
      "switch.2.lease_revoked",
      "switch.3.account_switch_started",
    ]);

    // The transition the landing waits on, from the state the walk was in.
    expect({ from: switched[1]?.fromState, to: switched[1]?.toState }).toEqual({
      from: "RUNNING",
      to: "QUOTA_BLOCKED",
    });
    // The revocation names the daemon's own lease, not one this drill invented.
    const revoked = switched[2]?.payload;
    expect(typeof revoked?.["leaseId"]).toBe("string");
    expect(revoked?.["cause"]).toBe("ACCOUNT_SWITCH");
    // The destination authority a landing reads.
    expect(switched[3]?.payload).toMatchObject({
      fromAccountId: routed.accountId,
      toAccountId: second.accountId,
    });

    // **And the walk did not settle.** The attempt is blocked awaiting a
    // landing; a terminal event here would foreclose it.
    const types = rows.map((event) => event.type);
    expect(types).not.toContain("TASK_FAILED");
    expect(types).not.toContain("ACCOUNT_SWITCH_COMPLETED");
    expect(types).not.toContain("CHECKPOINT_WRITTEN");
  }, 120_000);

  it("D5: the audit link is durable — causation is the elector's own decidedFromEventId", async () => {
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f4d-audit");
    const taskId = F4D_DRILL_TASKS[1];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);

    const authorization = drillAuthorization(routed.accountId, second.accountId, {
      decidedFromEventId: seeded.crossTaskEventId,
    });
    await expect(
      startDaemon(
        f4dOptions(id, { ...execution, switchAuthorization: authorization } as DaemonExecutionConfig, taskId),
      ),
    ).rejects.toThrow();

    const rows = readRows(id);
    const started = rows.find((event) => event.type === "ACCOUNT_SWITCH_STARTED");
    expect(started?.causationId).toBe(authorization["decidedFromEventId"]);

    // **Cross-task causation.** The id the elector recorded resolves to a real
    // pressure row in this ledger, and it is deliberately NOT the row that
    // satisfied the trigger match: a decision is taken from evidence recorded
    // before this walk, and the row this attempt observed is a different one.
    const pressureRows = rows.filter((event) => event.transitionId.startsWith("pressure."));
    expect(pressureRows.length).toBeGreaterThan(0);
    for (const row of pressureRows) {
      expect(row.payload["pressure"]).toBeDefined();
    }
  }, 120_000);

  it("D2: with no authorization the walk settles exactly as it did before", async () => {
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const id = b4aScenarioId("f4d-no-authorization");
    const taskId = F4D_DRILL_TASKS[2];
    seedExhaustion(id, taskId, execution.route.accountId, execution.route);

    await expect(startDaemon(f4dOptions(id, execution, taskId))).rejects.toThrow();

    const rows = readRows(id);
    expect(rows.filter((event) => event.transitionId.startsWith("switch."))).toEqual([]);
    const failed = rows.find((event) => event.type === "TASK_FAILED");
    expect(failed?.payload["reason"]).toBe("EXECUTION_FAILED");
  }, 120_000);

  it("D3: a trigger mismatch is inert — nothing is appended and the walk settles", async () => {
    // The authorization was decided for a warning; this attempt recorded an
    // exhaustion. The walk declines rather than re-deciding on what it saw.
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f4d-trigger-mismatch");
    const taskId = F4D_DRILL_TASKS[3];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);

    const mismatched = drillAuthorization(routed.accountId, second.accountId, {
      trigger: "QUOTA_WARNING",
      decidedFromEventId: seeded.crossTaskEventId,
    });
    await expect(
      startDaemon(
        f4dOptions(id, { ...execution, switchAuthorization: mismatched } as DaemonExecutionConfig, taskId),
      ),
    ).rejects.toThrow();

    const rows = readRows(id);
    expect(rows.filter((event) => event.transitionId.startsWith("switch."))).toEqual([]);
    expect(rows.some((event) => event.type === "TASK_FAILED")).toBe(true);
  }, 120_000);

  it("D4: the destination is never spawned", async () => {
    // A switch is started, not landed. The second binding's subject writes no
    // echo file and its committed pid is untouched — the F2b idiom.
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f4d-no-spawn");
    const taskId = F4D_DRILL_TASKS[0];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);

    await expect(
      startDaemon(
        f4dOptions(
          id,
          {
            ...execution,
            switchAuthorization: drillAuthorization(routed.accountId, second.accountId, {
              decidedFromEventId: seeded.crossTaskEventId,
            }),
          } as DaemonExecutionConfig,
          taskId,
        ),
      ),
    ).rejects.toThrow();

    expect(existsSync(providers.second.echoFile)).toBe(false);
    expect(existsSync(providers.second.envFile)).toBe(false);
    expect(readFileSync(providers.second.pidFile, "utf8")).toBe("0");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// V2-B1f/F5 — the switch lands on the account it chose
// ---------------------------------------------------------------------------

/**
 * The landing, on a real daemon, a real lease, a real ledger and the real
 * executor — restarted, because a landing has nowhere else to happen.
 *
 * **The trigger is seeded, and every title says so.** At this HEAD no shipped
 * parser can produce a quota classification, so a walk cannot observe an
 * exhaustion end to end and a drill that pretended otherwise would assert an
 * invention. What is real here is everything after the observation: the door
 * that admits a decided switch, the executor that plays it under this daemon's
 * own lease, the restart that finds the durable prestate, the landing that
 * appends exactly one completion, and the walk that then runs on the account
 * the switch chose.
 *
 * **Two windows are constructed rather than signalled, and the titles say
 * that too.** `DaemonOptions` carries no fault passthrough, and adding one
 * would be a production change made to serve a drill. So D3's window is
 * produced by calling the landing itself against the real ledger before the
 * daemon starts, and D5's by driving the supervisor's own declared fault seam
 * over the same scenario. No process is signalled in this section.
 */

const F5_DRILL_TASKS = [
  "f5dd0000-0000-4000-8000-000000000001",
  "f5dd0000-0000-4000-8000-000000000002",
  "f5dd0000-0000-4000-8000-000000000003",
  "f5dd0000-0000-4000-8000-000000000004",
  "f5dd0000-0000-4000-8000-000000000005",
  "f5dd0000-0000-4000-8000-000000000006",
  "f5dd0000-0000-4000-8000-000000000007",
  "f5dd0000-0000-4000-8000-000000000008",
  "f5dd0000-0000-4000-8000-000000000009",
  "f5dd0000-0000-4000-8000-00000000000a",
  "f5dd0000-0000-4000-8000-00000000000b",
] as const;

/**
 * A subject that spends, then fails the contract in the port (V2-B1f/F4a-E). Its
 * spend is the result record's report (P-15/D2): the assistant record reports
 * nothing, so the turn's result carries the count before the stream goes wrong.
 */
const F5_SPENDING_UNEXPRESSIBLE_LINES: readonly string[] = [
  JSON.stringify({ type: "system", subtype: "init", model: RESOLVED_MODEL }),
  JSON.stringify({ type: "assistant", message: { usage: { output_tokens: TOKENS } } }),
  JSON.stringify({
    type: "result",
    subtype: "turn_completed",
    session_id: "session-f5",
    usage: { input_tokens: 0, output_tokens: TOKENS, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }),
  JSON.stringify({ type: "system", subtype: "auth_required" }),
  JSON.stringify({ type: "system", subtype: "init", model: "m".repeat(200) }),
];

/** Two claude bindings whose routed subject spends before it fails. */
function twoProvidersSpendingRoute(): ReturnType<typeof twoProviders> {
  const a = fakeProviderBinary(F5_SPENDING_UNEXPRESSIBLE_LINES, { linger: false });
  const b = fakeProviderBinary(CLAUDE_LINES, { linger: false });
  return {
    worktree: a.root,
    first: { binary: a.binary, echoFile: a.echoFile, envFile: a.envFile, pidFile: a.pidFile, configRoot: a.root },
    second: { binary: b.binary, echoFile: b.echoFile, envFile: b.envFile, pidFile: b.pidFile, configRoot: b.root },
  };
}

/**
 * A subject that fails the contract in the port and reports NO pressure.
 *
 * `F4E_UNEXPRESSIBLE_LINES` raises an auth requirement on its way to failing,
 * which the pressure recorder writes under `pressure.<operation>.<trail>` —
 * and that name carries no landing generation (it is the sibling exposure the
 * record names and this packet deliberately leaves alone). A source and a
 * destination that both raised one would collide on that key rather than on
 * the thing D7 is about, so the subjects here fail without saying anything
 * about their account.
 */
const F5_UNEXPRESSIBLE_LINES: readonly string[] = [
  JSON.stringify({ type: "system", subtype: "init", model: RESOLVED_MODEL }),
  JSON.stringify({ type: "system", subtype: "init", model: "m".repeat(200) }),
];

/** Two claude bindings where BOTH subjects fail, so a landed walk still fails. */
function twoFailingProviders(): ReturnType<typeof twoProviders> {
  const a = fakeProviderBinary(F5_UNEXPRESSIBLE_LINES, { linger: false });
  const b = fakeProviderBinary(F5_UNEXPRESSIBLE_LINES, { linger: false });
  return {
    worktree: a.root,
    first: { binary: a.binary, echoFile: a.echoFile, envFile: a.envFile, pidFile: a.pidFile, configRoot: a.root },
    second: { binary: b.binary, echoFile: b.echoFile, envFile: b.envFile, pidFile: b.pidFile, configRoot: b.root },
  };
}

/** The config a switched drill runs under: the plan the elector decided. */
function f5Authorized(
  execution: DaemonExecutionConfig,
  fromAccountId: string,
  toAccountId: string,
  decidedFromEventId: string,
): DaemonExecutionConfig {
  return {
    ...execution,
    switchAuthorization: drillAuthorization(fromAccountId, toAccountId, { decidedFromEventId }),
  } as DaemonExecutionConfig;
}

/** The decided plan inside a drill authorization, as the executor takes it. */
function planOf(execution: DaemonExecutionConfig): Parameters<typeof executeSwitchPlan>[0]["plan"] {
  const authorization = execution.switchAuthorization as unknown as {
    readonly plan: Parameters<typeof executeSwitchPlan>[0]["plan"];
  };
  return authorization.plan;
}

/** The invocation the daemon derives for one of these drills. */
function f5Invocation(taskId: string, route: ResolvedRoute): DurableInvocation {
  return deriveInvocation(
    taskId,
    1,
    SUBMITTED_AT,
    canonicalSubmissionDigest({
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      initiativeId: B4A_INITIATIVE_ID,
      route,
    }),
  );
}

/** The event id of the row that started this switch, as the ledger holds it. */
function readStartedEventId(scenarioId: string): string | null {
  const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(scenarioId)), { readOnly: true });
  try {
    const found = ledger
      .listEvents({ limit: 500 })
      .events.find((entry) => entry.event.transitionId === "switch.3.account_switch_started");
    return found?.event.eventId ?? null;
  } finally {
    ledger.close();
  }
}

function readState(scenarioId: string, taskId: string): string | null {
  const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(scenarioId)), { readOnly: true });
  try {
    return ledger.getTask(taskId)?.currentState ?? null;
  } finally {
    ledger.close();
  }
}

/** Everything the worktree tracks, hashed, so "unmoved" is a measurement. */
function worktreeDigest(directory: string): string {
  const listed = spawnSync("/usr/bin/git", ["ls-files"], { cwd: directory, encoding: "utf8" });
  const files = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(join(directory, file)));
  }
  return hash.digest("hex");
}

/** The lease this worktree is recorded under right now, or null. */
function leaseRowFor(worktreePath: string): { readonly fence: number; readonly holder: string | null } | null {
  const store = openLeaseStore(leaseStorePath(resolveDaemonRoot()));
  try {
    const row = store.read(worktreePath);
    return row === null ? null : { fence: row.fence, holder: row.holder };
  } finally {
    store.close();
  }
}

describe("F5: the switch lands on the account it chose (trigger seeded)", () => {
  it("D1: daemon 2 lands the played switch and the walk checkpoints on the destination", async () => {
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f5-d1");
    const taskId = F5_DRILL_TASKS[0];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);
    const authorized = f5Authorized(
      execution,
      routed.accountId,
      second.accountId,
      seeded.crossTaskEventId,
    );

    // Daemon 1 plays the switch and unwinds: the play rethrows the original
    // error, so there is no in-process continuation to interpose on.
    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();
    expect(readState(id, taskId)).toBe("QUOTA_BLOCKED");

    // Daemon 2, same config, same scenario. This is the whole packet.
    const run = await startDaemon(f4dOptions(id, authorized, taskId));
    await stopDaemon(run);

    const rows = readRows(id);
    const landed = rows.filter((event) => event.transitionId === "switch.landed.1");
    expect(landed).toHaveLength(1);
    expect({ from: landed[0]?.fromState, to: landed[0]?.toState }).toEqual({
      from: "QUOTA_BLOCKED",
      to: "RUNNING",
    });
    expect(landed[0]?.type).toBe("ACCOUNT_SWITCH_COMPLETED");
    expect(landed[0]?.payload).toMatchObject({
      fromAccountId: routed.accountId,
      toAccountId: second.accountId,
      generation: 1,
    });
    // Its causation is the started row this plane actually appended — a real,
    // durably-present predecessor rather than a name nothing resolves.
    const startedEventId = readStartedEventId(id);
    expect(startedEventId).not.toBeNull();
    expect(landed[0]?.causationId).toBe(startedEventId);

    // The walk ran on the DESTINATION account's own subject, and reached the
    // terminal — so F3's checkpoint assembles, because run.outcome is durable.
    expect(existsSync(providers.second.echoFile)).toBe(true);
    expect(readState(id, taskId)).toBe("CHECKPOINTED");
    expect(rows.map((event) => event.type)).toContain("CHECKPOINT_WRITTEN");
  }, 240_000);

  it("D1 (walks form): a switched walk under concurrency lands exactly as a single walk does", async () => {
    // The interposition is at BOTH route bindings, so a switched walk under
    // `options.walks` is landable. Landing only the singular form would leave
    // this one permanently unlandable, and silently.
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");

    const companion = fakeProviderBinary(CLAUDE_LINES, { linger: false });
    const companionWorktree = drillRoot();
    const companionExecution: DaemonExecutionConfig = {
      route: { ...execution.route, accountId: "acct-b4a-companion" },
      bindings: [
        {
          accountId: "acct-b4a-companion",
          transportKind: "CLI_SUBSCRIPTION",
          provider: "claude",
          binary: companion.binary,
          configRoot: companion.root,
          workdir: companionWorktree,
          limits: {
            timeoutMs: 10_000,
            outputBudgetBytes: 64 * 1024,
            interruptGraceMs: 120,
            termGraceMs: 120,
          },
        },
      ],
    };

    const id = b4aScenarioId("f5-d1-walks");
    const companionId = b4aScenarioId("f5-d1-walks-companion");
    const taskId = F5_DRILL_TASKS[1];
    const companionTask = F5_DRILL_TASKS[2];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);
    const authorized = f5Authorized(
      execution,
      routed.accountId,
      second.accountId,
      seeded.crossTaskEventId,
    );

    const walkFor = (
      scenarioId: string,
      walkTask: string,
      walkExecution: DaemonExecutionConfig,
      worktreePath: string,
      writeSet: readonly string[],
    ): ScheduledWalk => ({
      envelope: envelopeFor(walkTask, INITIATIVE_ID, writeSet),
      worktreePath,
      spec: {
        scenarioId,
        taskId: walkTask,
        attempt: 1,
        submittedAt: SUBMITTED_AT,
        submissionDigest: canonicalSubmissionDigest({
          taskId: walkTask,
          attempt: 1,
          submittedAt: SUBMITTED_AT,
          initiativeId: B4A_INITIATIVE_ID,
          route: walkExecution.route,
        }),
        initiativeId: B4A_INITIATIVE_ID,
        emittedBy: EMITTED_BY,
        execution: walkExecution,
      },
    });

    const walks = [
      walkFor(id, taskId, authorized, providers.worktree, ["child.pid"]),
      walkFor(companionId, companionTask, companionExecution, companionWorktree, ["src/walk.ts"]),
    ];
    const options = { ...f4dOptions(id, authorized, taskId), walks };

    // Daemon 1: the scheduler runs both walks, and the switched one plays.
    const first = await startDaemon(options);
    await stopDaemon(first);
    expect(readState(id, taskId)).toBe("QUOTA_BLOCKED");
    expect(
      readRows(id)
        .filter((event) => event.transitionId.startsWith("switch."))
        .map((event) => event.transitionId),
    ).toEqual([
      "switch.0.quota_warning",
      "switch.1.task_state_changed",
      "switch.2.lease_revoked",
      "switch.3.account_switch_started",
    ]);

    // Daemon 2: the same two walks, and the switched one lands.
    const second2 = await startDaemon(options);
    await stopDaemon(second2);

    const landed = readRows(id).filter((event) => event.transitionId === "switch.landed.1");
    expect(landed).toHaveLength(1);
    expect(landed[0]?.payload).toMatchObject({
      fromAccountId: routed.accountId,
      toAccountId: second.accountId,
      generation: 1,
    });
    expect(readState(id, taskId)).toBe("CHECKPOINTED");
    expect(existsSync(providers.second.echoFile)).toBe(true);
    // The companion walk is untouched by any of it.
    expect(
      readRows(companionId).filter((event) => event.transitionId.startsWith("switch.")),
    ).toEqual([]);
  }, 240_000);

  it("D2: no fake completion — the window between the play and the landing holds none", async () => {
    // The window where a false completion would be most tempting: the switch
    // is played, the destination is named, and nothing has finished it.
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f5-d2");
    const taskId = F5_DRILL_TASKS[3];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);
    const authorized = f5Authorized(
      execution,
      routed.accountId,
      second.accountId,
      seeded.crossTaskEventId,
    );

    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();

    // The prestate, measured: four played rows, a named destination, and no
    // completion anywhere.
    const played = readRows(id);
    expect(played.map((event) => event.type)).not.toContain("ACCOUNT_SWITCH_COMPLETED");
    expect(played.filter((event) => event.transitionId.startsWith("switch.landed."))).toEqual([]);
    expect(played.find((event) => event.transitionId === "switch.3.account_switch_started")?.payload)
      .toMatchObject({ fromAccountId: routed.accountId, toAccountId: second.accountId });
    expect(readState(id, taskId)).toBe("QUOTA_BLOCKED");

    // And the next start lands from exactly that prestate, appending one.
    const run = await startDaemon(f4dOptions(id, authorized, taskId));
    await stopDaemon(run);
    expect(
      readRows(id).filter((event) => event.type === "ACCOUNT_SWITCH_COMPLETED"),
    ).toHaveLength(1);
  }, 240_000);

  it("D3: a durable completion is found, not re-appended, and the found-durable walk resumes on the destination (window constructed)", async () => {
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f5-d3");
    const taskId = F5_DRILL_TASKS[4];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);
    const authorized = f5Authorized(
      execution,
      routed.accountId,
      second.accountId,
      seeded.crossTaskEventId,
    );

    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();

    // The window: the completion is durable and the walk has not started. It
    // is CONSTRUCTED by calling the landing itself against the real ledger,
    // because no fault point in the daemon exposes this instant and adding one
    // would be a production change made to serve a drill.
    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)));
    let appended: Awaited<ReturnType<typeof landAccountSwitch>>;
    let refound: Awaited<ReturnType<typeof landAccountSwitch>>;
    try {
      const input = {
        ledger,
        invocation: f5Invocation(taskId, execution.route),
        route: execution.route,
        bindings: execution.bindings.map((entry) => ({
          accountId: entry.accountId,
          provider: entry.transportKind === "CLI_SUBSCRIPTION" ? entry.provider : execution.route.provider,
        })),
        port: {
          healthProbe: () =>
            Promise.resolve({
              status: "UNKNOWN" as const,
              checkedAt: RESOLVED_AT,
              latencyMs: null,
              classifiedError: null,
            }),
        },
        checkConformance: (): void => undefined,
        sessionIdFor: (accountId: string): string => executionSessionId(taskId, 1, accountId),
        emittedBy: EMITTED_BY,
      };
      appended = await landAccountSwitch(input);
      refound = await landAccountSwitch(input);
    } finally {
      ledger.close();
    }

    expect(appended.ok && appended.inserted).toBe(true);
    expect(refound.ok && refound.inserted).toBe(false);
    expect(refound.ok && refound.route.accountId).toBe(second.accountId);
    expect(readState(id, taskId)).toBe("RUNNING");

    // Now the daemon starts, with the stale authorization still in the config.
    const run = await startDaemon(f4dOptions(id, authorized, taskId));
    await stopDaemon(run);

    // One completion, and no second row under `switch.`: the restart found the
    // landing rather than appending a second one, and resumed on the account
    // the switch chose.
    //
    // **What this drill does NOT prove**, and the case below does: that the
    // restart composed no switch port. This walk succeeds, and the only
    // consumer of a switch port is the supervisor's catch — so no port,
    // composed or not, is ever consulted here, and every assertion below would
    // hold equally under a reading of R3 that derived "landed" from `inserted`
    // rather than from "a completion exists, appended or found".
    const switched = readRows(id)
      .filter((event) => event.transitionId.startsWith("switch."))
      .map((event) => event.transitionId);
    expect(switched).toEqual([
      "switch.0.quota_warning",
      "switch.1.task_state_changed",
      "switch.2.lease_revoked",
      "switch.3.account_switch_started",
      "switch.landed.1",
    ]);
    expect(readState(id, taskId)).toBe("CHECKPOINTED");
    expect(existsSync(providers.second.echoFile)).toBe(true);
  }, 240_000);

  it("D3 (R3 half): a found-durable landing with the stale authorization composes no switch port — the failing destination settles (window constructed)", async () => {
    // The half D3 above cannot falsify, in D7's landed-branch shape over D3's
    // constructed window.
    //
    // **The definition of "landed" is what is on trial.** R3 suppresses the
    // switch port on a walk this process landed, and "landed" means *a
    // completion exists for this attempt, appended now or found durable*. A
    // reading that derived it from `inserted` instead would compose a port on
    // exactly this restart — the one where the completion was appended by a
    // process that died before the walk started — and only `ACCOUNT_MISMATCH`
    // would stand in the way, which is the accidental safety the ruling names
    // as not the invariant.
    //
    // **Why this drill discriminates and D3 does not.** The only consumer of a
    // switch port is the supervisor's catch, so a port is observable only on a
    // walk that FAILS. Both subjects here fail, so the catch is reached. Had a
    // port been composed, `considerSwitch` would have matched this attempt's
    // own seeded pressure and the config route's account, and
    // `executeSwitchPlan` would have replayed `switch.0` and `switch.1` and
    // then met the ledger's guards at `switch.2`, whose payload carries this
    // process's own — different — lease. The walk would have ended in a raised
    // conflict with nothing settled. It settles, so no port was composed.
    const providers = twoFailingProviders();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f5-d3-no-port");
    const taskId = F5_DRILL_TASKS[10];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);
    const authorized = f5Authorized(
      execution,
      routed.accountId,
      second.accountId,
      seeded.crossTaskEventId,
    );

    // Daemon 1 plays the switch and unwinds.
    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();
    expect(readState(id, taskId)).toBe("QUOTA_BLOCKED");

    // The same constructed window as D3: the completion is durable and the
    // walk has not started, produced by calling the landing itself against the
    // real ledger rather than by signalling a process.
    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)));
    let appended: Awaited<ReturnType<typeof landAccountSwitch>>;
    let refound: Awaited<ReturnType<typeof landAccountSwitch>>;
    try {
      const input = {
        ledger,
        invocation: f5Invocation(taskId, execution.route),
        route: execution.route,
        bindings: execution.bindings.map((entry) => ({
          accountId: entry.accountId,
          provider: entry.transportKind === "CLI_SUBSCRIPTION" ? entry.provider : execution.route.provider,
        })),
        port: {
          healthProbe: () =>
            Promise.resolve({
              status: "UNKNOWN" as const,
              checkedAt: RESOLVED_AT,
              latencyMs: null,
              classifiedError: null,
            }),
        },
        checkConformance: (): void => undefined,
        sessionIdFor: (accountId: string): string => executionSessionId(taskId, 1, accountId),
        emittedBy: EMITTED_BY,
      };
      appended = await landAccountSwitch(input);
      refound = await landAccountSwitch(input);
    } finally {
      ledger.close();
    }
    expect(appended.ok && appended.inserted).toBe(true);
    expect(refound.ok && refound.inserted).toBe(false);
    expect(readState(id, taskId)).toBe("RUNNING");

    // The restart, with the stale authorization still in the config. It finds
    // the completion rather than appending one, composes no switch port, and
    // its failing destination settles.
    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();

    const switched = readRows(id)
      .filter((event) => event.transitionId.startsWith("switch."))
      .map((event) => event.transitionId);
    expect(switched).toEqual([
      "switch.0.quota_warning",
      "switch.1.task_state_changed",
      "switch.2.lease_revoked",
      "switch.3.account_switch_started",
      "switch.landed.1",
    ]);
    expect(readRows(id).map((event) => event.type)).toContain("TASK_FAILED");
    expect(readState(id, taskId)).toBe("FAILED");
  }, 300_000);

  it("D4: the destination's usage is keyed by the generation, so no key collides with the source's", async () => {
    const providers = twoProvidersSpendingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f5-d4");
    const taskId = F5_DRILL_TASKS[5];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);
    const authorized = f5Authorized(
      execution,
      routed.accountId,
      second.accountId,
      seeded.crossTaskEventId,
    );

    // Daemon 1: the source spends, then fails, then plays the switch.
    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();
    const spent = readRows(id).filter((event) => event.type === "TOKEN_USAGE_RECORDED");
    expect(spent).toHaveLength(1);
    expect(spent[0]?.transitionId.startsWith("usage.0.")).toBe(true);
    expect(spent[0]?.payload["accountId"]).toBe(routed.accountId);

    // Daemon 2: the landing, then the destination re-executes the SAME
    // operation at the same step index. Without the generation this append
    // would collide with the row above under one idempotency key.
    const run = await startDaemon(f4dOptions(id, authorized, taskId));
    await stopDaemon(run);

    const usage = readRows(id).filter((event) => event.type === "TOKEN_USAGE_RECORDED");
    expect(usage).toHaveLength(2);
    const byAccount = new Map(usage.map((event) => [String(event.payload["accountId"]), event]));
    expect(byAccount.get(routed.accountId)?.transitionId.startsWith("usage.0.")).toBe(true);
    expect(byAccount.get(second.accountId)?.transitionId.startsWith("usage.1.")).toBe(true);
    expect(new Set(usage.map((event) => event.transitionId)).size).toBe(2);
    expect(readState(id, taskId)).toBe("CHECKPOINTED");
  }, 240_000);

  it("D5: a verified source marker means zero destination executions (window constructed)", async () => {
    // The window — the effect completed, its marker verifies, and the process
    // died before the OUTCOME was appended — is not reachable from
    // `DaemonOptions`: the supervisor's fault points are AFTER_INTENT,
    // AFTER_EFFECT and AFTER_OUTCOME and none of them crosses the daemon's
    // option surface. It is CONSTRUCTED here over the same scenario, with the
    // plan's own steps, the real effects and the real switch executor, and no
    // process is signalled.
    const providers = twoProviders();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f5-d5");
    const taskId = F5_DRILL_TASKS[6];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);
    const authorized = f5Authorized(
      execution,
      routed.accountId,
      second.accountId,
      seeded.crossTaskEventId,
    );

    const root = resolveScenarioRoot(id);
    const ledger = openLedger(scenarioLedgerPath(root));
    const invocation = f5Invocation(taskId, execution.route);
    try {
      const effects = createExecutionEffects({
        port: createExecutionPort({
          bindings: new Map([[execution.route.accountId, cliBinding(CLAUDE_LINES)]]),
        }),
        route: execution.route,
        request: {
          taskId,
          attempt: 1,
          identity: EMITTED_BY,
          instructions: DRILL_OBJECTIVE,
          modalities: ["text"],
          reattach: null,
        },
        scenarioRoot: root,
      });
      await expect(
        new SqliteSupervisor({
          ledger,
          invocation,
          effects,
          emittedBy: EMITTED_BY,
          commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
          initiativeId: B4A_INITIATIVE_ID,
          route: execution.route,
          __faultPoint: "AFTER_EFFECT",
          __onFault: () => {
            throw new Error("the process ended after the effect and before the outcome");
          },
        }).runToCheckpoint(),
      ).rejects.toThrow();

      // The effect happened and its marker verifies; the outcome does not exist.
      expect(await effects.probe(operationForStep(invocation, INTENT_STEP))).toBe("DONE");
      expect(ledger.getTask(taskId)?.currentState).toBe("RUNNING");

      // And then the switch is played, by the real executor, from RUNNING.
      executeSwitchPlan({
        ledger,
        invocation,
        plan: planOf(authorized),
        emittedBy: EMITTED_BY,
        lease: {
          leaseId: deterministicUuid("f5/d5/lease"),
          worktreePath: providers.worktree,
          holder: EMITTED_BY,
          acquiredAt: SUBMITTED_AT,
          expiresAt: RESOLVED_AT,
        },
        taskState: "RUNNING",
        causedBy: seeded.crossTaskEventId,
      });
    } finally {
      ledger.close();
    }
    expect(readState(id, taskId)).toBe("QUOTA_BLOCKED");

    // The daemon lands and resumes. `closeIntent` probes DONE and appends the
    // outcome from the evidence that already exists, so the destination's own
    // subject is never invoked.
    const run = await startDaemon(f4dOptions(id, authorized, taskId));
    await stopDaemon(run);

    expect(readRows(id).filter((event) => event.transitionId === "switch.landed.1")).toHaveLength(1);
    expect(readState(id, taskId)).toBe("CHECKPOINTED");
    // Zero destination executions: no echo file, no environment file, and the
    // committed pid untouched — the F2b idiom.
    expect(existsSync(providers.second.echoFile)).toBe(false);
    expect(existsSync(providers.second.envFile)).toBe(false);
    expect(readFileSync(providers.second.pidFile, "utf8")).toBe("0");
  }, 240_000);

  it("D6: a new lease is granted over the same worktree, and the worktree does not move", async () => {
    const providers = twoProvidersWithFailingRoute();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f5-d6");
    const taskId = F5_DRILL_TASKS[7];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);
    const authorized = f5Authorized(
      execution,
      routed.accountId,
      second.accountId,
      seeded.crossTaskEventId,
    );

    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();

    // Daemon 1's own lease is what the revocation names — not one this drill
    // invented, and not a lease the executor made up.
    const revoked = readRows(id).find((event) => event.transitionId === "switch.2.lease_revoked");
    expect(typeof revoked?.payload["leaseId"]).toBe("string");
    expect(revoked?.payload["cause"]).toBe("ACCOUNT_SWITCH");
    expect(revoked?.payload["worktreePath"]).toBe(providers.worktree);

    const beforeDigest = worktreeDigest(providers.worktree);
    const beforeFence = leaseRowFor(providers.worktree)?.fence ?? 0;

    // Daemon 2 acquires a lease on the SAME worktree. A refused acquisition is
    // a StartupError naming another writer, so reaching a checkpoint at all is
    // the acquisition — the recorded revocation does not block a successor.
    const run = await startDaemon(f4dOptions(id, authorized, taskId));
    await stopDaemon(run);

    expect(readState(id, taskId)).toBe("CHECKPOINTED");
    expect(leaseRowFor(providers.worktree)?.fence ?? 0).toBeGreaterThan(beforeFence);
    // One worktree per packet: a switch must not lose context, so a switch
    // must not move the checkout. The destination wrote into its own root.
    expect(worktreeDigest(providers.worktree)).toBe(beforeDigest);
  }, 240_000);

  it("D7: a landed walk composes no switch port, while an unlanded walk still composes one (R3)", async () => {
    // Branch one, the control: no landing, so the port is composed and a
    // decided switch is played. The walk does not settle — the attempt is
    // blocked awaiting a landing, and a terminal event would foreclose it.
    const control = twoFailingProviders();
    const controlExecution = pluralExecution("acct-b4a-drill", control);
    const [controlRouted, controlSecond] = controlExecution.bindings;
    if (controlRouted === undefined || controlSecond === undefined) {
      throw new Error("expected two entries");
    }
    const controlId = b4aScenarioId("f5-d7-unlanded");
    const controlTask = F5_DRILL_TASKS[8];
    const controlSeed = seedExhaustion(
      controlId,
      controlTask,
      controlRouted.accountId,
      controlExecution.route,
    );
    await expect(
      startDaemon(
        f4dOptions(
          controlId,
          f5Authorized(
            controlExecution,
            controlRouted.accountId,
            controlSecond.accountId,
            controlSeed.crossTaskEventId,
          ),
          controlTask,
        ),
      ),
    ).rejects.toThrow();
    expect(
      readRows(controlId)
        .filter((event) => event.transitionId.startsWith("switch."))
        .map((event) => event.transitionId),
    ).toEqual([
      "switch.0.quota_warning",
      "switch.1.task_state_changed",
      "switch.2.lease_revoked",
      "switch.3.account_switch_started",
    ]);
    expect(readRows(controlId).map((event) => event.type)).not.toContain("TASK_FAILED");

    // Branch two: the same daemon, restarted, with the authorization still in
    // the config and both subjects failing — so the supervisor's catch is
    // reached on the landed walk too.
    //
    // **What a composed port would have done.** `considerSwitch` would match
    // this attempt's own seeded pressure and the config route's account, and
    // `executeSwitchPlan` would replay `switch.0` and then meet the ledger's
    // own contiguity guard at `switch.2` — the walk would end in a raised
    // conflict rather than a settlement. It settles, so no port was composed.
    const providers = twoFailingProviders();
    const execution = pluralExecution("acct-b4a-drill", providers);
    const [routed, second] = execution.bindings;
    if (routed === undefined || second === undefined) throw new Error("expected two entries");
    const id = b4aScenarioId("f5-d7-landed");
    const taskId = F5_DRILL_TASKS[9];
    const seeded = seedExhaustion(id, taskId, routed.accountId, execution.route);
    const authorized = f5Authorized(
      execution,
      routed.accountId,
      second.accountId,
      seeded.crossTaskEventId,
    );

    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();
    await expect(startDaemon(f4dOptions(id, authorized, taskId))).rejects.toThrow();

    const switched = readRows(id)
      .filter((event) => event.transitionId.startsWith("switch."))
      .map((event) => event.transitionId);
    expect(switched).toEqual([
      "switch.0.quota_warning",
      "switch.1.task_state_changed",
      "switch.2.lease_revoked",
      "switch.3.account_switch_started",
      "switch.landed.1",
    ]);
    expect(readRows(id).map((event) => event.type)).toContain("TASK_FAILED");
    expect(readState(id, taskId)).toBe("FAILED");
  }, 300_000);
});

// ---------------------------------------------------------------------------
// V2-BE/R6: the daemon binds a transport it was given a client for
// ---------------------------------------------------------------------------

const R6_ACCOUNT = "acct-r6-api";

/** The API route this packet composes. Same shape as the CLI leg's, one field apart. */
function r6ApiRoute(): ResolvedRoute {
  return { ...resolvedCliRoute(), accountId: R6_ACCOUNT, transportKind: "API_KEY" };
}

/**
 * An execution config whose route is API_KEY and whose one binding declares it.
 *
 * The CLI fields are absent, not empty: an API entry has no binary and no
 * credential root, and D1a refuses them rather than ignoring them.
 */
function r6ApiExecution(workdir: string): DaemonExecutionConfig {
  return {
    route: r6ApiRoute(),
    bindings: [
      {
        accountId: R6_ACCOUNT,
        transportKind: "API_KEY",
        workdir,
        limits: { timeoutMs: 10_000, outputBudgetBytes: 64 * 1024, interruptGraceMs: 120, termGraceMs: 120 },
      },
    ],
  };
}

/** Start the daemon over an API config, with whatever factory the case is about. */
async function r6Run(
  scenarioId: string,
  apiClientFor?: (accountId: string) => ApiStreamingClient | undefined,
): Promise<void> {
  const { root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
  const options = { ...b4aOptions(scenarioId, r6ApiExecution(root)), apiClientFor };
  const run = await startDaemon(options);
  await stopDaemon(run);
}

/** Every event of a scenario's ledger, read back independently. */
function r6Events(scenarioId: string): readonly { type: string; payload: Record<string, unknown> }[] {
  const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(scenarioId)), { readOnly: true });
  try {
    return ledger
      .listEvents({ limit: 500 })
      .events.map((entry) => ({ type: entry.event.type, payload: entry.event.payload }));
  } finally {
    ledger.close();
  }
}

/**
 * Drive the daemon over a config it must refuse, and prove how it refused.
 *
 * Two observables, and both are real rather than invented. `startDaemon`
 * rejects with the `ExecutionEffectError` the effect raised, which carries the
 * port's own `refusal` and `at` verbatim — so the typed diagnosis IS reachable
 * from the composition root, and is asserted here rather than only at the port.
 * The ledger carries the other half: the walk settled failed for a closed
 * reason and wrote no checkpoint.
 */
async function r6RefusedAtDaemon(
  scenarioId: string,
  expected: { readonly refusal: string; readonly at: string },
  apiClientFor?: (accountId: string) => ApiStreamingClient | undefined,
): Promise<void> {
  await expect(r6Run(scenarioId, apiClientFor)).rejects.toMatchObject(expected);
  const events = r6Events(scenarioId);
  const types = events.map((event) => event.type);
  expect(types).toContain("TASK_FAILED");
  expect(types).not.toContain("CHECKPOINT_WRITTEN");
  expect(events.find((event) => event.type === "TASK_FAILED")?.payload["reason"]).toBe("EXECUTION_FAILED");
}

/** A port holding exactly the bindings the composition would have produced. */
function r6Port(apiBindings: Map<string, { client: ApiStreamingClient }>): ModelExecutionPort {
  return createExecutionPort({ bindings: new Map(), apiBindings });
}

function r6Start(port: ModelExecutionPort): Promise<unknown> {
  return port.start(r6ApiRoute(), {
    taskId: randomUUID(),
    attempt: 1,
    identity: EMITTED_BY,
    instructions: "start the packet",
    modalities: ["text"],
    reattach: null,
  });
}

describe("R6: the daemon binds a transport it was given a client for", () => {
  it("P1: composes the API transport through the real seam and keeps the route API_KEY", async () => {
    // The parity fixture proves the PORT serves both legs; this proves the
    // DAEMON composes the API one, through `startDaemon` -- the composition
    // root -- because `executionPortFor` is private and stays private.
    const scenarioId = b4aScenarioId("r6-api-compose");
    await r6Run(scenarioId, (accountId) =>
      accountId === R6_ACCOUNT ? fakeClient(API_SCENARIO, SECRET) : undefined,
    );

    const events = r6Events(scenarioId);
    const types = events.map((event) => event.type);
    expect(types).toContain("CHECKPOINT_WRITTEN");
    expect(types).not.toContain("TASK_FAILED");

    // The anti-vacuity control. A composed API leg that silently fell back to a
    // CLI binding would satisfy every assertion above; the recorded route is
    // what tells them apart.
    const recorded = events.find((event) => event.payload["route"] !== undefined)?.payload["route"];
    expect((recorded as { transportKind?: string } | undefined)?.transportKind).toBe("API_KEY");
  });

  it("N1: no factory leaves the account unbound, at the port and at the daemon", async () => {
    // The most important assertion in the packet: an operator who never opened
    // this transport keeps it closed. Absence of a factory is not a
    // configuration error -- it is the default -- so the refusal must name the
    // ACCOUNT, not the transport.
    expect(await r6Start(r6Port(new Map()))).toMatchObject({
      ok: false,
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "route.accountId",
    });

    await r6RefusedAtDaemon(b4aScenarioId("r6-no-factory"), {
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "route.accountId",
    });
  });

  it("N2: a factory that declines the account leaves it unbound too", async () => {
    // Declining is not failing. A factory that knows nothing about this account
    // returns `undefined`, and the account stays unbound -- never filled from a
    // sibling and never defaulted.
    expect(await r6Start(r6Port(new Map()))).toMatchObject({
      ok: false,
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "route.accountId",
    });

    await r6RefusedAtDaemon(
      b4aScenarioId("r6-factory-declines"),
      { refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" },
      () => undefined,
    );
  });

  it("N3: a client speaking another provider is refused at route.provider", async () => {
    const wrong: ApiStreamingClient = { ...fakeClient(API_SCENARIO, SECRET), provider: "codex" };
    expect(await r6Start(r6Port(new Map([[R6_ACCOUNT, { client: wrong }]])))).toMatchObject({
      ok: false,
      refusal: "ROUTE_INVALID",
      at: "route.provider",
    });

    await r6RefusedAtDaemon(
      b4aScenarioId("r6-wrong-provider"),
      { refusal: "ROUTE_INVALID", at: "route.provider" },
      () => wrong,
    );
  });

  it("N4: a client that does not serve the model is refused at route.model", async () => {
    // D3: the client is the sole declaration of the models, and a client that
    // cannot serve the named one refuses rather than substituting a neighbour.
    const narrow: ApiStreamingClient = { ...fakeClient(API_SCENARIO, SECRET), models: ["haiku"] };
    expect(await r6Start(r6Port(new Map([[R6_ACCOUNT, { client: narrow }]])))).toMatchObject({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "route.model",
    });

    await r6RefusedAtDaemon(
      b4aScenarioId("r6-wrong-model"),
      { refusal: "CAPABILITY_UNSUPPORTED", at: "route.model" },
      () => narrow,
    );
  });

  it("N8: the client's secret reaches no trail, marker, serialization or preimage", async () => {
    // The canary lives in the fake's closure, where a real implementation holds
    // its key. The composed leg must be as clean as the direct one already is.
    const scenarioId = b4aScenarioId("r6-redaction");
    await r6Run(scenarioId, () => fakeClient(API_SCENARIO, SECRET));

    const events = r6Events(scenarioId);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("sk-");
    // The config the child was handed is the other surface a credential could
    // have reached: it is written to a file, and it carries a client for
    // nothing -- the factory closed over the key, and the factory is not in it.
    expect(JSON.stringify(r6ApiExecution("/tmp/x"))).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// §4.3 — the acceptance proof (P-06/C, ADR 0095)
//
// "Un hijo que devuelve lo que recibió, ejercitado desde la puerta real —CLI y
// API— y no desde un fixture." So the instruction is composed by the REAL
// producer over a real ledger, carried by the real execution port through the
// real Claude adapter, and handed to a real child process that writes back
// exactly the bytes it was given. No provider is paid: the child is the drill's,
// behind the real boundary.
// ---------------------------------------------------------------------------

/** Two text blocks, so the proof exercises the join and not just a pass-through. */
const ACCEPTANCE_FIRST = "read the packet and say what you were asked";
const ACCEPTANCE_SECOND = "then stop, without writing anything";

function acceptanceEnvelope(taskId: string): TaskEnvelope {
  const block = (blockId: string, text: string): Record<string, unknown> => ({
    kind: "text",
    blockId,
    mediaType: "text/plain; charset=utf-8",
    byteLength: new TextEncoder().encode(text).byteLength,
    contentSha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    artifactRefId: null,
    text,
    toolCallId: null,
    effectId: null,
  });
  return {
    ...envelopeFor(taskId, INITIATIVE_ID),
    objective: ACCEPTANCE_FIRST,
    content: {
      contentContractVersion: 1,
      blocks: [block("b1", ACCEPTANCE_FIRST), block("b2", ACCEPTANCE_SECOND)],
    },
  } as unknown as TaskEnvelope;
}

/** The instruction the one producer composes for that envelope, over a real ledger. */
function acceptanceInstruction(name: string): ComposedInstruction {
  const root = scenario(name);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  return instructionFor(ledger, acceptanceEnvelope(TASK));
}

describe("the acceptance proof: a child returns what it received (contratos section 4.3)", () => {
  it("delivers the composed instruction to a real child on the CLI leg, and the child returns exactly it", async () => {
    const composed = acceptanceInstruction("p06c-accept-compose");
    // The composition is the producer's, not this fixture's: it joined two text
    // blocks in the list's order with the one separator.
    expect(composed.instructions).toBe(ACCEPTANCE_FIRST + "\n\n" + ACCEPTANCE_SECOND);
    expect(composed.modalities).toEqual(["text"]);

    const echoPath = join(drillRoot(), "acceptance-cli.txt");
    const port = createExecutionPort({
      bindings: new Map([[ACCOUNT, { ...cliBinding(CLAUDE_LINES), adapter: echoingClaude(echoPath, CLAUDE_LINES) }]]),
    });
    const done = await walk("p06c-accept-cli", port, resolvedCliRoute(), undefined, {
      ...executionRequest(),
      instructions: composed.instructions,
      modalities: [...composed.modalities],
    });

    // What the child received, byte for byte, read back from the file the child
    // itself wrote. The walk completed normally around it.
    expect(readFileSync(echoPath, "utf8")).toBe(composed.instructions);
    expect(done.state).toBe("CHECKPOINTED");
    // The CLI child's exit before the terminal (P-07 escalón C).
    expect(done.trail.map((event) => event.kind)).toEqual(["started", "usage", "state", "processExited", "completed"]);
  }, 60_000);

  it("N-P06-14: the delivered instruction reaches no event body, no evidence and no trail", async () => {
    const composed = acceptanceInstruction("p06c-accept-quiet-compose");
    const echoPath = join(drillRoot(), "acceptance-quiet.txt");
    const port = createExecutionPort({
      bindings: new Map([[ACCOUNT, { ...cliBinding(CLAUDE_LINES), adapter: echoingClaude(echoPath, CLAUDE_LINES) }]]),
    });
    const done = await walk("p06c-accept-quiet", port, resolvedCliRoute(), undefined, {
      ...executionRequest(),
      instructions: composed.instructions,
      modalities: [...composed.modalities],
    });

    // It reached the child -- the positive control that makes the absences below
    // mean something.
    expect(readFileSync(echoPath, "utf8")).toBe(composed.instructions);
    const everywhere = [
      JSON.stringify(done.bodiesWithoutRoute),
      JSON.stringify(done.trail),
      done.markerJson,
      done.evidence.join("|"),
    ].join("|");
    for (const fragment of [ACCEPTANCE_FIRST, ACCEPTANCE_SECOND, composed.instructions]) {
      expect(everywhere).not.toContain(fragment);
    }
    // Not even as a digest: the sha-256 of what was asked is not in the log either.
    const digest = createHash("sha256").update(Buffer.from(composed.instructions, "utf8")).digest("hex");
    expect(everywhere).not.toContain(digest);
  }, 60_000);

  it("N-P06-15: a class the transport cannot carry refuses before a process exists, through the real port", async () => {
    const composed = acceptanceInstruction("p06c-accept-modality-compose");
    const echoPath = join(drillRoot(), "acceptance-modality.txt");
    const port = createExecutionPort({
      bindings: new Map([
        [ACCOUNT, { ...cliBinding(CLAUDE_LINES), adapter: modalityRefusingClaude(echoPath) }],
      ]),
    });
    const outcome = await port.start(resolvedCliRoute(), {
      ...executionRequest(),
      instructions: composed.instructions,
      modalities: [...composed.modalities],
    });

    // The port's own classified answer, and no child: the side file the echoing
    // subject would have written does not exist, because nothing ran.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("the port admitted a transport that cannot carry the content");
    const refused = outcome;
    expect(refused.refusal).toBe("TRANSPORT_UNAVAILABLE");
    expect(refused.at).toBe("startSession/PROTOCOL_UNSUPPORTED");
    expect(existsSync(echoPath)).toBe(false);
  }, 60_000);

  it("runs the same composed instruction on the API leg, and the stream request carries exactly it (P-06/CORR)", async () => {
    const composed = acceptanceInstruction("p06c-accept-api-compose");
    const seen: ApiStreamRequest[] = [];
    const recordingClient: ApiStreamingClient = {
      provider: "claude",
      models: ["opus"],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream(request): AsyncIterable<ApiStreamChunk> {
        seen.push(request);
        for (const chunk of API_SCENARIO) yield chunk;
      },
    };
    const port = createExecutionPort({
      bindings: new Map([[ACCOUNT, cliBinding(CLAUDE_LINES)]]),
      apiBindings: new Map([[ACCOUNT, { client: recordingClient }]]),
    });
    const done = await walk("p06c-accept-api", port, { ...resolvedCliRoute(), transportKind: "API_KEY" }, undefined, {
      ...executionRequest(),
      instructions: composed.instructions,
      modalities: [...composed.modalities],
    });

    // The walk reached its terminal state; that is the lifecycle settling, not a
    // claim about what the stream produced (P-07 owns the result contract).
    expect(done.state).toBe("CHECKPOINTED");
    // The API leg carries the instruction composed by the one producer, verbatim,
    // in the request's five declared members (ADR 0096; ADR 0095's errata).
    expect(seen).toHaveLength(1);
    const received = seen[0];
    if (received === undefined) throw new Error("the API client was never called");
    expect(Object.keys(received).sort()).toEqual(["attempt", "identity", "instructions", "model", "taskId"]);
    expect(received.instructions).toBe(composed.instructions);
    // The request is the one lawful crossing: the instruction still reaches no
    // event body and no trail.
    const everywhere = JSON.stringify(done.bodiesWithoutRoute) + JSON.stringify(done.trail);
    for (const fragment of [ACCEPTANCE_FIRST, ACCEPTANCE_SECOND]) {
      expect(everywhere).not.toContain(fragment);
    }
  }, 60_000);

  it("through startDaemon, a synthetic API client echoes back exactly the composed instruction (P-06/CORR)", async () => {
    // The composition root this time, not a walk harness: `startDaemon` composes
    // the instruction from its envelope with `instructionFor` and hands it to the
    // API leg. The client is synthetic and echoes what it received as the
    // stream's text; nothing here asserts a useful result, only the crossing.
    const expected = acceptanceInstruction("p06corr-api-echo-compose");
    const received: ApiStreamRequest[] = [];
    const echoed: string[] = [];
    const echoClient: ApiStreamingClient = {
      provider: "claude",
      models: ["opus"],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream(request): AsyncIterable<ApiStreamChunk> {
        received.push(request);
        const [started, ...rest] = API_SCENARIO;
        if (started !== undefined) yield started;
        echoed.push(request.instructions);
        yield { kind: "text", delta: request.instructions };
        for (const chunk of rest) yield chunk;
      },
    };
    await p06corrRun(b4aScenarioId("p06corr-api-echo"), acceptanceEnvelopeFor, () => echoClient);

    expect(received).toHaveLength(1);
    expect(Object.keys(received[0] ?? {}).sort()).toEqual(["attempt", "identity", "instructions", "model", "taskId"]);
    expect(echoed).toEqual([expected.instructions]);
    expect(echoed[0]).toBe(ACCEPTANCE_FIRST + "\n\n" + ACCEPTANCE_SECOND);
  }, 60_000);

  it("through startDaemon, a class the API leg cannot carry is refused before the client, with zero calls (P-06/CORR)", async () => {
    const received: ApiStreamRequest[] = [];
    const recordingClient: ApiStreamingClient = {
      provider: "claude",
      models: ["opus"],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream(request): AsyncIterable<ApiStreamChunk> {
        received.push(request);
        for (const chunk of API_SCENARIO) yield chunk;
      },
    };
    const scenarioId = b4aScenarioId("p06corr-api-image");
    await expect(p06corrRun(scenarioId, imageEnvelopeFor, () => recordingClient)).rejects.toMatchObject({
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "request.modalities",
    });
    expect(received).toHaveLength(0);
    const types = r6Events(scenarioId).map((event) => event.type);
    expect(types).toContain("TASK_FAILED");
    expect(types).not.toContain("CHECKPOINT_WRITTEN");
  }, 60_000);
});

/**
 * `r6Run` with the envelope as a parameter (P-06/CORR): the acceptance envelope's
 * two text blocks, or those plus an image block, over the R6 API config. The
 * write-set is R6's, because the same drill binary is the workdir.
 */
async function p06corrRun(
  scenarioId: string,
  envelopeOf: (taskId: string) => TaskEnvelope,
  apiClientFor: (accountId: string) => ApiStreamingClient | undefined,
): Promise<void> {
  const { root } = fakeProviderBinary(CLAUDE_LINES, { linger: false });
  const base = b4aOptions(scenarioId, r6ApiExecution(root));
  const run = await startDaemon({ ...base, envelope: envelopeOf(base.taskId), apiClientFor });
  await stopDaemon(run);
}

function acceptanceEnvelopeFor(taskId: string): TaskEnvelope {
  return { ...acceptanceEnvelope(taskId), writeSet: ["child.pid"] } as unknown as TaskEnvelope;
}

/** The acceptance envelope plus one referenced image block, which no API leg carries. */
function imageEnvelopeFor(taskId: string): TaskEnvelope {
  const envelope = acceptanceEnvelopeFor(taskId);
  return {
    ...envelope,
    content: {
      contentContractVersion: 1,
      blocks: [
        ...envelope.content.blocks,
        {
          kind: "image",
          blockId: "b3",
          mediaType: "image/png",
          byteLength: 2_048,
          contentSha256: "b".repeat(64),
          artifactRefId: "ref-image-1",
          text: null,
          toolCallId: null,
          effectId: null,
        },
      ],
    },
  } as unknown as TaskEnvelope;
}

// ---------------------------------------------------------------------------
// P-07 escalón D: an effect answers with a published result (ADR 0100)
// ---------------------------------------------------------------------------

/**
 * The drills' world: a V2 attempt with its first effect intended and delivered,
 * and a private plane over the same ledger. Restated from the runtime's own
 * operation-result suite, whose helpers a test file cannot export; every event
 * here goes through the ledger's door, and none stands in for the rule under test.
 */
const P07D_AT = "2026-09-23T12:00:00.000Z";
const p07dClosers: (() => void)[] = [];

afterEach(() => {
  for (const close of p07dClosers.splice(0).reverse()) {
    try {
      close();
    } catch {
      // already closed
    }
  }
});

interface P07dWorld {
  readonly root: ScenarioRoot;
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  readonly ledgerPath: string;
  readonly invocation: DurableInvocation;
  readonly effectId: string;
  readonly taskId: string;
  readonly state: TaskState;
}

function p07dRevision(taskId: string): InvocationRevision {
  return {
    revisionId: deterministicUuid("revision/" + taskId + "/1"),
    revisionNumber: 1,
    attemptNumber: 1,
    envelopeSha256: "e".repeat(64),
    envelopeArtifactReferenceId: "ref-envelope-" + taskId,
  };
}

/**
 * The fixture price catalog a delivery is pinned to (P-15 escalón C, ADR 0103).
 *
 * From 2.9.0 a `DISPATCH_INTENDED` names the catalog version in force at its
 * instant, and one that covers its segment, or the door refuses it: pre-2.9.0
 * fixtures had to gain a pin because the version in force now requires one. So the
 * fixture publishes one through the registry's own door — the segment's model
 * version registered under its provider, then version 1 of a `PRICE_TABLE` pricing
 * that model on the segment's transport from before any fixture instant, with no
 * end. The price is fixture data, and never zero.
 */
const FIXTURE_CATALOG = "catalog-fixture";
const FIXTURE_MODEL_VERSION = "claude-opus-5-20260101";
const FIXTURE_CATALOG_FROM = "2026-01-01T00:00:00.000Z";
const FIXTURE_PIN = { catalogDocumentId: FIXTURE_CATALOG, catalogVersion: 1 } as const;

function plantFixtureCatalog(ledger: Ledger): void {
  if (ledger.getVigentCatalogPin(FIXTURE_CATALOG, FIXTURE_CATALOG_FROM) !== null) return;
  const document = (
    eventId: string,
    documentKind: string,
    documentId: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId,
    idempotencyKey: documentId + "/1",
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    // The payload's own digest, which the registry door verifies (P-15/R, ADR 0104).
    contentDigest: sha256Hex(canonicalJsonStringify(payload)),
    recordedBy: "kimi/k3/coordinator/01",
    effectiveFrom: FIXTURE_CATALOG_FROM,
    occurredAt: FIXTURE_CATALOG_FROM,
    recordedAt: FIXTURE_CATALOG_FROM,
    payload,
  });
  ledger.appendRegistryEvent(
    document("c0c0c0c0-0000-4000-8000-00000000c001", "MODEL_VERSION", FIXTURE_MODEL_VERSION, {
      provider: "anthropic",
      model: "claude-opus-5",
      release: "2026-01-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["coordinator", "implementer", "reviewer", "consultant", "verifier"],
      transports: ["CLI_SUBSCRIPTION"],
    }),
  );
  ledger.appendRegistryEvent(
    document("c0c0c0c0-0000-4000-8000-00000000c002", "PRICE_TABLE", FIXTURE_CATALOG, {
      intervals: [
        {
          provider: "anthropic",
          modelVersionId: FIXTURE_MODEL_VERSION,
          transportKind: "CLI_SUBSCRIPTION",
          tokenClass: "input",
          currency: "USD",
          effectiveFrom: FIXTURE_CATALOG_FROM,
          effectiveTo: null,
          pricePerMillionNanos: 15_000_000_000,
        },
      ],
    }),
  );
}

/** Register the task's envelope reference, as a fixture. */
function p07dPlantEnvelope(ledger: Ledger, taskId: string): void {
  const reference = "ref-envelope-" + taskId;
  const content = "7".repeat(64);
  const envelope = (kind: string, ordinal: number, payload: Record<string, unknown>): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId: deterministicUuid("envelope/" + taskId + "/" + kind),
    idempotencyKey: "envelope/" + taskId + "/" + kind,
    subjectKind: "ARTIFACT",
    artifactEventKind: kind,
    subjectOrdinal: ordinal,
    parentSubjectOrdinal: ordinal === 1 ? null : ordinal - 1,
    recordedBy: EMITTED_BY,
    occurredAt: P07D_AT,
    recordedAt: P07D_AT,
    payload,
  });
  const common = { commandId: "cmd-envelope", contentSha256: content, blobGeneration: 1, artifactPinId: "pin-envelope" };
  ledger.appendArtifactEvent(
    envelope("PUBLICATION_INTENDED", 1, {
      ...common,
      mediaType: "application/json",
      sizeBytes: 128,
      encryptionStatus: "PLAINTEXT",
      keyReference: null,
      encryptionProfile: "local-plaintext-v1",
    }),
  );
  ledger.appendArtifactEvent(
    envelope("PUBLICATION_SUCCEEDED", 2, {
      ...common,
      reference: {
        artifactReferenceId: reference,
        artifactClass: "TASK_ENVELOPE",
        classification: "INTERNAL",
        scopeKind: "TASK",
        scopeId: taskId,
        producerIdentity: EMITTED_BY,
        accessPolicyId: "SCOPE_EQUALITY_V1",
        retentionClass: "STANDARD",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
    }),
  );
}

const P07D_SEGMENT: Record<string, unknown> = {
  routeSegmentId: "seg-1",
  segmentNumber: 1,
  provider: "anthropic",
  model: "claude-opus-5",
  modelResolutionStatus: "RESOLVED",
  modelVersionId: "claude-opus-5-20260101",
  accountId: "acct-1",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-1",
};

function p07dEvent(
  world: Pick<P07dWorld, "ledger" | "invocation">,
  transitionId: string,
  type: "EFFECT_INTENDED" | "DISPATCH_INTENDED" | "DISPATCH_OUTCOME_RECORDED",
  record: Record<string, unknown>,
): Record<string, unknown> {
  const revision = world.invocation.revision;
  if (revision === undefined) throw new Error("an execution event needs the walk's revision");
  const coordinate = deriveEventCoordinate(world.invocation, transitionId, 0);
  const state = world.ledger.getTask(world.invocation.taskId)?.currentState ?? null;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: world.invocation.taskId,
    attempt: world.invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type,
    fromState: state,
    toState: state,
    emittedBy: EMITTED_BY,
    occurredAt: P07D_AT,
    recordedAt: P07D_AT,
    correlationId: world.invocation.invocationId,
    causationId: null,
    payload: { revisionNumber: revision.revisionNumber, attemptNumber: revision.attemptNumber, ...record },
  };
}

function p07dOpenPlane(ledger: Ledger, ledgerPath: string, incarnationId: string, faults: ArtifactPlaneTestFaults = {}): ArtifactPlane {
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledgerPath), { incarnationId, createdAt: P07D_AT });
  p07dClosers.push(() => {
    leaseStore.close();
  });
  return openArtifactPlane({ ledger, leaseStore, ledgerPath, __testFaults: faults });
}

/** The attempt opened, its effect intended and delivered, and the prompt recorded — the drill's appends, through the door. */
function p07dWorld(name: string, faults: ArtifactPlaneTestFaults = {}): P07dWorld {
  const root = scenario(name);
  const ledgerPath = scenarioLedgerPath(root);
  const ledger = openLedger(ledgerPath);
  ledgers.push(ledger);
  const plane = p07dOpenPlane(ledger, ledgerPath, "11111111-1111-4111-8111-111111111111", faults);
  const taskId = deterministicUuid("p07d-drill/" + name);
  p07dPlantEnvelope(ledger, taskId);
  plantFixtureCatalog(ledger);
  const invocation = deriveInvocation(taskId, 1, P07D_AT, "c".repeat(64), p07dRevision(taskId));
  const context: BeatContext = {
    ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
    invocation,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    route: resolvedCliRoute(),
    initiativeId: INITIATIVE_ID,
  };
  appendPlanStep(context, ATTEMPT_OPENING_STEP);
  appendPlanStep(context, planStep(0));
  const coordinate = { taskId, revisionNumber: 1, attemptNumber: 1, segmentNumber: 1, operationOrdinal: 0 };
  const envelopeSha256 = invocation.revision?.envelopeSha256 ?? "";
  const effectId = effectIdV1(coordinate);
  const partial = { ledger, invocation };
  ledger.append(
    p07dEvent(partial, "effect-1", "EFFECT_INTENDED", {
      segment: P07D_SEGMENT,
      effect: {
        effectId,
        operationOrdinal: 0,
        effectKind: "model_execution",
        semanticScopeKey: "run",
        localOperationKey: "compose-answer",
        logicalOperationSha256: logicalOperationSha256({ invocationId: invocation.invocationId, semanticScopeKey: "run", localOperationKey: "compose-answer" }),
        requestContractVersion: "1",
        requestSha256: requestSha256({ effectKind: "model_execution", requestContractVersion: "1", envelopeSha256, neutralRequest: { operation: "compose" } }),
        idempotencyKey: effectIdempotencyKeyV1({ ...coordinate, effectKind: "model_execution", envelopeSha256 }),
      },
    }),
  );
  ledger.append(
    p07dEvent(partial, "dispatch-1", "DISPATCH_INTENDED", {
      segment: P07D_SEGMENT,
      dispatch: { dispatchAttemptId: "dsp-1", effectId, attemptOrdinal: 1, ...FIXTURE_PIN },
    }),
  );
  const state: TaskState = ledger.getTask(taskId)?.currentState ?? "RUNNING";
  ledger.append(
    buildPromptOccurrenceEvent({
      invocation,
      state,
      emittedBy: EMITTED_BY,
      causedBy: null,
      occurrence: {
        occurrenceId: "po-1",
        dispatchAttemptId: "dsp-1",
        effectId,
        routeSegmentId: "seg-1",
        ordinal: 0,
        requestedModelId: "claude-opus-5",
        provider: "anthropic",
        modelResolutionStatus: "RESOLVED",
        modelVersionId: "claude-opus-5-20260101",
        accountId: "acct-1",
        promptSha256: "a".repeat(64),
        promptBytes: 12,
        contextSha256: null,
      },
    }),
  );
  return { root, ledger, plane, ledgerPath, invocation, effectId, taskId, state };
}

function p07dIdentities(role: string): ArtifactIdentities {
  return {
    artifactReferenceId: "ref-" + role,
    commandId: "cmd-" + role,
    artifactPinId: "pin-" + role,
    intentionEventId: deterministicUuid("intention/" + role),
    terminalEventId: deterministicUuid("terminal/" + role),
  };
}

function p07dPublish(world: Pick<P07dWorld, "ledger" | "plane" | "effectId" | "taskId">, assembly: ResultAssembly): PublishedResult {
  return publishResult({
    ledger: world.ledger,
    plane: world.plane,
    effectId: world.effectId,
    taskId: world.taskId,
    recordedBy: EMITTED_BY,
    recordedAt: P07D_AT,
    holderPid: process.pid,
    result: p07dIdentities("result"),
    overflow: p07dIdentities("overflow"),
    assembly,
  });
}

function p07dOutcome(world: P07dWorld, transitionId: string, published: Pick<PublishedResult, "status" | "resultArtifactReferenceId" | "resultSha256">): Record<string, unknown> {
  return p07dEvent(world, transitionId, "DISPATCH_OUTCOME_RECORDED", {
    outcome: {
      dispatchAttemptId: "dsp-1",
      dispatchState: "SETTLED",
      terminalAt: P07D_AT,
      effectOutcomeStatus: published.status,
      ...(published.resultArtifactReferenceId === null
        ? {}
        : { resultArtifactReferenceId: published.resultArtifactReferenceId, resultSha256: published.resultSha256 }),
    },
  });
}

/**
 * The providers' captured streams (P-07 escalón C), read only.
 *
 * Imported through a computed specifier: the fixture lives in the providers' test
 * project, which is not composite and so cannot be referenced from this one, and a
 * static import outside this project's root is refused by the compiler (TS6059).
 * Widening either tsconfig would be a path outside the authorised write-set. The
 * shape is checked here, so the drills run on the captured lines and not on `any`.
 */
const CLAUDE_CAPTURE = join(REPO_ROOT, "packages", "edges", "providers", "test", "testing", "claude-capture", "index.ts");

interface CapturedStreams {
  readonly CAPTURED_AUTH_FAILURE: readonly string[];
  readonly CAPTURED_SUCCESS: readonly string[];
}

async function capturedStreams(): Promise<CapturedStreams> {
  const module = (await import(CLAUDE_CAPTURE)) as Record<string, unknown>;
  const lines = (name: string): readonly string[] => {
    const value = module[name];
    if (!Array.isArray(value) || value.length === 0 || !value.every((line) => typeof line === "string")) {
      throw new Error("the capture fixture's " + name + " is not a list of lines");
    }
    return value as readonly string[];
  };
  return { CAPTURED_AUTH_FAILURE: lines("CAPTURED_AUTH_FAILURE"), CAPTURED_SUCCESS: lines("CAPTURED_SUCCESS") };
}

/** The real Claude adapter over a node child that speaks `lines` and exits with `exitCode`. */
function exitingClaude(lines: readonly string[], exitCode: number): ProviderAdapter {
  const program = [
    "const lines = " + JSON.stringify([...lines]) + ";",
    "for (const line of lines) process.stdout.write(line + '\\n');",
    "process.exit(" + String(exitCode) + ");",
  ].join("\n");
  return {
    ...claudeAdapter,
    describe(request: SessionRequest): SessionDescriptor {
      return { provider: "claude", argv: ["-e", program], env: { PATH: "/usr/bin:/bin" }, cwd: request.workdir, delivery: { kind: "STDIN" } };
    },
  };
}

/** `recording`, forwarding the output sink `start` receives as its third argument. */
function recordingWithSink(port: ModelExecutionPort, trail: ExecutionEvent[]): ModelExecutionPort {
  return {
    async start(route, request, sink?: ExecutionOutputSink) {
      const started = sink === undefined ? await port.start(route, request) : await port.start(route, request, sink);
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

interface P07dRun {
  readonly trail: readonly ExecutionEvent[];
  readonly samples: readonly ResultSample[];
  readonly published: readonly PublishedResult[];
  readonly markerJson: string;
}

/** Run one execution through the real port and CLI child, its recorder assembling and publishing into `world`. */
async function p07dExecute(name: string, world: P07dWorld, lines: readonly string[], exitCode: number): Promise<P07dRun> {
  const trail: ExecutionEvent[] = [];
  const samples: ResultSample[] = [];
  const published: PublishedResult[] = [];
  const port = createExecutionPort({
    bindings: new Map([[ACCOUNT, { ...cliBinding(lines), adapter: exitingClaude(lines, exitCode) }]]),
  });
  const root = scenario(name);
  const effects = createExecutionEffects({
    port: recordingWithSink(port, trail),
    route: resolvedCliRoute(),
    request: executionRequest(),
    scenarioRoot: root,
    recordResult: (sample) => {
      samples.push(sample);
      published.push(p07dPublish(world, assembleResult(world.effectId, sample)));
    },
  });
  const operation = operationForStep(invocation(), INTENT_STEP);
  await effects.apply(operation);
  const markerPath = join(root, "executions", operation.operationId + ".json");
  return { trail, samples, published, markerJson: existsSync(markerPath) ? readFileSync(markerPath, "utf8") : "" };
}

function onlyPublished(run: P07dRun): PublishedResult {
  expect(run.published).toHaveLength(1);
  const [published] = run.published;
  if (published === undefined) throw new Error("the recorder was never called");
  return published;
}

function readResult(world: P07dWorld, reference: string): { bytes: Buffer; document: ReturnType<typeof ResultContractSchema.parse> } {
  const read = world.plane.read({ artifactReferenceId: reference, scopeKind: "TASK", scopeId: world.taskId });
  if (read.verb !== "READ") throw new Error("the plane did not read the result: " + read.verb);
  return { bytes: read.content, document: ResultContractSchema.parse(JSON.parse(read.content.toString("utf8"))) };
}

/** A synthetic stream in the captured shape: init, one assistant text, and a result carrying `isError`. */
function synLines(text: string, isError: boolean): readonly string[] {
  return [
    JSON.stringify({ type: "system", subtype: "init", model: RESOLVED_MODEL, session_id: "00000000-0000-4000-8000-000000000001" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }], usage: { output_tokens: 1 } } }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: isError,
      result: text,
      session_id: "00000000-0000-4000-8000-000000000001",
      usage: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  ];
}

describe("P-07 escalón D: an effect answers with a published result, end to end", () => {
  it("D-P07D-1 (OBS sample 2): the captured success publishes {text \"ok\"}, and the door holds the pair and its response", async () => {
    const world = p07dWorld("p07d-drill-success");
    const { CAPTURED_SUCCESS } = await capturedStreams();
    const run = await p07dExecute("p07d-drill-success-run", world, CAPTURED_SUCCESS, 0);

    expect(run.trail.slice(-3)).toEqual([
      { kind: "processExited", exitCode: 0, signal: null },
      { kind: "operationResult", status: "SUCCEEDED" },
      { kind: "completed", stepIndex: expect.any(Number) as number },
    ]);
    const published = onlyPublished(run);
    expect(published.status).toBe("SUCCEEDED");
    if (published.resultArtifactReferenceId === null) throw new Error("a SUCCEEDED result carries its pair");
    const result = readResult(world, published.resultArtifactReferenceId);
    expect(result.document.status).toBe("SUCCEEDED");
    expect(result.document.blocks.map((block) => [block.kind, block.text])).toEqual([["text", "ok"]]);

    // After publication, and only then: the outcome with its pair, then the answer.
    world.ledger.append(p07dOutcome(world, "settle-1", published));
    world.ledger.append(
      buildResponseOccurrenceEvent({
        invocation: world.invocation,
        state: world.state,
        emittedBy: EMITTED_BY,
        causedBy: null,
        occurrence: {
          occurrenceId: "ro-1",
          promptOccurrenceId: "po-1",
          responseSha256: published.resultSha256,
          responseBytes: published.responseBytes,
          redactionVerdict: "CLEAN",
        },
      }),
    );
    expect(world.ledger.getEffect(world.effectId)).toMatchObject({
      outcomeStatus: "SUCCEEDED",
      resultArtifactReferenceId: published.resultArtifactReferenceId,
      resultSha256: published.resultSha256,
    });
    expect(world.ledger.getResponseOccurrenceForPrompt("po-1")?.responseSha256).toBe(published.resultSha256);
    expect(world.ledger.verifyIntegrity().ok).toBe(true);
  }, 60_000);

  it("D-P07D-2 (OBS sample 1): the captured authentication failure is FAILED with no pair, no RESPONSE, and the door admits it", async () => {
    const world = p07dWorld("p07d-drill-auth");
    const { CAPTURED_AUTH_FAILURE } = await capturedStreams();
    const run = await p07dExecute("p07d-drill-auth-run", world, CAPTURED_AUTH_FAILURE, 1);

    expect(run.trail.filter((event) => event.kind === "processExited" || event.kind === "operationResult")).toEqual([
      { kind: "processExited", exitCode: 1, signal: null },
      { kind: "operationResult", status: "FAILED" },
    ]);
    expect(run.published).toEqual([
      { status: "FAILED", reason: "OPERATION_FAILED", resultArtifactReferenceId: null, resultSha256: null, responseBytes: null },
    ]);
    // No RESPONSE reference was registered for the task: the envelope's is the only one.
    expect(world.ledger.getArtifactReference("ref-result")).toBeNull();
    expect(world.ledger.getArtifactReference("ref-overflow")).toBeNull();
    expect(world.ledger.rebuildReadModel().artifactReferenceRows).toBe(1);
    world.ledger.append(p07dOutcome(world, "settle-1", onlyPublished(run)));
    expect(world.ledger.getEffect(world.effectId)).toMatchObject({ outcomeStatus: "FAILED", resultArtifactReferenceId: null, resultSha256: null });
    expect(world.ledger.getResponseOccurrenceForPrompt("po-1")).toBeNull();
  }, 60_000);

  it("D-P07D-3 (SYN — the crossed pair §4.2 names): is_error with exit 0 is FAILED, and its output publishes with the pair", async () => {
    const world = p07dWorld("p07d-drill-crossed");
    const run = await p07dExecute("p07d-drill-crossed-run", world, synLines("boom", true), 0);

    expect(run.samples.map((sample) => sample.facts)).toEqual([
      { terminal: "completed", process: { kind: "EXITED", exitCode: 0, signal: null }, operation: "FAILED" },
    ]);
    const published = onlyPublished(run);
    expect(published.status).toBe("FAILED");
    if (published.resultArtifactReferenceId === null) throw new Error("a FAILED operation with output carries its pair (Q-D9)");
    const result = readResult(world, published.resultArtifactReferenceId);
    expect(result.document.status).toBe("FAILED");
    expect(result.document.blocks.map((block) => block.text)).toEqual(["boom"]);
    world.ledger.append(p07dOutcome(world, "settle-1", published));
    expect(world.ledger.getEffect(world.effectId)).toMatchObject({ outcomeStatus: "FAILED", resultSha256: published.resultSha256 });
  }, 60_000);

  it("D-P07D-4 (order): the outcome's pair before its publication is refused by the door; after it, the same append is admitted", async () => {
    const { CAPTURED_SUCCESS } = await capturedStreams();
    const world = p07dWorld("p07d-drill-order");
    const samples: ResultSample[] = [];
    const port = createExecutionPort({
      bindings: new Map([[ACCOUNT, { ...cliBinding(CAPTURED_SUCCESS), adapter: exitingClaude(CAPTURED_SUCCESS, 0) }]]),
    });
    const effects = createExecutionEffects({
      port,
      route: resolvedCliRoute(),
      request: executionRequest(),
      scenarioRoot: scenario("p07d-drill-order-run"),
      recordResult: (sample) => {
        samples.push(sample);
      },
    });
    await effects.apply(operationForStep(invocation(), INTENT_STEP));
    const [sample] = samples;
    if (sample === undefined) throw new Error("the recorder was never called");
    const assembly = assembleResult(world.effectId, sample);
    if (assembly.kind !== "DOCUMENT") throw new Error("expected a document");
    const early = { status: assembly.status, resultArtifactReferenceId: "ref-result", resultSha256: assembly.sha256 };

    expect(() => world.ledger.append(p07dOutcome(world, "settle-1", early))).toThrow(LedgerValidationError);
    expect(world.ledger.getEffect(world.effectId)?.outcomeStatus ?? null).toBeNull();

    const published = p07dPublish(world, assembly);
    expect(published.resultArtifactReferenceId).toBe("ref-result");
    world.ledger.append(p07dOutcome(world, "settle-1", early));
    expect(world.ledger.getEffect(world.effectId)?.resultSha256).toBe(assembly.sha256);
  }, 60_000);

  it("D-P07D-5 (containment): the output's sentinel is in the private bytes and nowhere the ledger or the walk can show it", async () => {
    const sentinel = "p07d-" + "containment-" + "5e7a1c";
    const world = p07dWorld("p07d-drill-sentinel");
    const run = await p07dExecute("p07d-drill-sentinel-run", world, synLines(sentinel, false), 0);
    const published = onlyPublished(run);
    if (published.resultArtifactReferenceId === null) throw new Error("expected the pair");
    world.ledger.append(p07dOutcome(world, "settle-1", published));
    world.ledger.append(
      buildResponseOccurrenceEvent({
        invocation: world.invocation,
        state: world.state,
        emittedBy: EMITTED_BY,
        causedBy: null,
        occurrence: {
          occurrenceId: "ro-1",
          promptOccurrenceId: "po-1",
          responseSha256: published.resultSha256,
          responseBytes: published.responseBytes,
          redactionVerdict: "CLEAN",
        },
      }),
    );

    // The positive control: the private side holds it.
    expect(readResult(world, published.resultArtifactReferenceId).bytes.toString("utf8")).toContain(sentinel);
    // Every control-plane event, every registry event, the ledger file itself.
    const events = world.ledger.listEvents({ limit: 500 }).events.map((entry) => entry.canonicalJson).join("\n");
    expect(events).toContain("RESPONSE_OCCURRENCE_RECORDED");
    expect(events).not.toContain(sentinel);
    const registry = [...world.ledger.listArtifactEvents("7".repeat(64)), ...world.ledger.listArtifactEvents(published.resultSha256)];
    expect(registry.length).toBeGreaterThan(0);
    expect(JSON.stringify(registry)).not.toContain(sentinel);
    for (const suffix of ["", "-wal"]) {
      const path = world.ledgerPath + suffix;
      if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(sentinel, "utf8"))).toBe(false);
    }
    // The walk's own evidence: the marker and the trail.
    expect(run.markerJson).not.toBe("");
    expect(run.markerJson).not.toContain(sentinel);
    expect(JSON.stringify(run.trail)).not.toContain(sentinel);
  }, 60_000);

  it("D-P07D-6: a crash after PUBLICATION_SUCCEEDED resumes under the same keys, and the outcome is appended once", async () => {
    const { CAPTURED_SUCCESS } = await capturedStreams();
    const world = p07dWorld("p07d-drill-crash", {
      afterOutcomeRecorded: () => {
        throw new Error("crash after the publication's outcome");
      },
    });
    await expect(p07dExecute("p07d-drill-crash-run", world, CAPTURED_SUCCESS, 0)).rejects.toThrow(/crash after the publication/);

    // The same ledger, a new plane incarnation: the walk re-executes (no marker was
    // written) and the recorder publishes again.
    const resumed: P07dWorld = { ...world, plane: p07dOpenPlane(world.ledger, world.ledgerPath, "22222222-2222-4222-8222-222222222222") };
    const run = await p07dExecute("p07d-drill-crash-rerun", resumed, CAPTURED_SUCCESS, 0);
    const published = onlyPublished(run);
    if (published.resultSha256 === null) throw new Error("expected the pair");
    expect(published.resultArtifactReferenceId).toBe("ref-result");
    const kinds = world.ledger.listArtifactEvents(published.resultSha256).map((record) => record.event.artifactEventKind);
    expect(kinds.filter((kind) => kind === "PUBLICATION_INTENDED")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "PUBLICATION_SUCCEEDED")).toHaveLength(1);
    world.ledger.append(p07dOutcome(resumed, "settle-1", published));
    world.ledger.append(p07dOutcome(resumed, "settle-1", published));
    expect(world.ledger.listEvents({ limit: 500 }).events.filter((entry) => entry.event.type === "DISPATCH_OUTCOME_RECORDED")).toHaveLength(1);
    expect(world.ledger.verifyIntegrity().ok).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P-15 escalón D4: door to result (ADR 0105, decisions 143-145)
// ---------------------------------------------------------------------------

/**
 * The acceptance of `parallelism :143`, read literally: "Caso real de puerta a
 * resultado y consumo trazable en el perfil. No sustituirlo por una llamada directa
 * al puerto desde un test."
 *
 * Every record reaches the operator's ledger through a real door. The compiled CLI
 * — spawned, never imported — publishes the model version, the routing assignment
 * and the price catalog (`acp registry`), registers the initiative (`acp
 * initiative`) and enters the task (`acp intake`). The recorded daemon form runs it
 * through the packaged entry (`runPackagedEntry([…])`), the real
 * execution port and the real Claude adapter's argv, against a synthetic echo
 * child: a script that reads the instruction on stdin, keeps it in a side file it
 * owns, and answers in the captured stream-json shape — the success sample's five
 * record kinds: `system/commands_changed`, `init`, the assistant text, an allowed
 * `rate_limit_event` and the `result`. It is no provider, reaches
 * no network and spends nothing. Then an independent reader opens the ledger and the
 * private plane itself.
 *
 * The one thing the test does by hand is create the empty ledger file: no door
 * creates one, because it is not a task operation (ND-D4-6). Every record after it
 * goes through a door.
 */
const D4_REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "..", "..");
const D4_CLI_ENTRY = join(D4_REPO_ROOT, "packages", "entrypoints", "cli", "dist", "index.js");
const D4_OWNER = "claude/opus/coordinator/01";
const D4_OPERATOR = "claude/opus/implementer/01";
const D4_INITIATIVE = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7ad401";
const D4_MODEL = "claude-opus-5@2026-06-01";
const D4_CATALOG = "catalog-d4";
const D4_RULES_FROM = "2026-09-01T00:00:00.000Z";
const D4_ACCOUNT = "acct-d4-door";
const D4_WRITTEN = "docs/d4.md";
const D4_INSTRUCTION = "Echo this recorded instruction back, and nothing else.";

interface D4Invocation {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The compiled `acp`, spawned as an operator would run it. */
function acp(args: readonly string[]): D4Invocation {
  const ran = spawnSync(process.execPath, [D4_CLI_ENTRY, ...args], { cwd: D4_REPO_ROOT, encoding: "utf8" });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

/** A canonical, owner-only directory for this drill. */
function d4Directory(): string {
  const created = realpathSync(mkdtempSync(join(TMP_ROOT, "acp-d4-")));
  chmodSync(created, 0o700);
  temporaries.push(created);
  return created;
}

function d4Write(directory: string, name: string, document: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(document), { encoding: "utf8", mode: 0o600 });
  return path;
}

/**
 * Publish, register and enter, each through its door; returns the operator ledger and the task.
 *
 * P-15/F reuses it with two options, both defaulting to D4's behaviour: the
 * instruction the envelope carries, and whether the CLI enters the task or the
 * caller does -- through the HTTP door -- with the request document returned.
 */
function d4ThroughTheDoors(options: {
  readonly priced: boolean;
  readonly instruction?: string;
  readonly intakeBy?: "CLI" | "CALLER";
}): { readonly databasePath: string; readonly taskId: string; readonly intakeRequest: Record<string, unknown> } {
  const instruction = options.instruction ?? D4_INSTRUCTION;
  const directory = d4Directory();
  const databasePath = join(directory, "control-plane.sqlite");
  // The one act no door performs: an empty ledger file (ND-D4-6).
  openLedger(databasePath).close();
  const registry = (name: string, document: Record<string, unknown>): void => {
    const published = acp(["registry", "--database", databasePath, "--format", "json", "--request", d4Write(directory, name, document)]);
    expect({ name, status: published.status, stderr: published.stderr }).toEqual({ name, status: 0, stderr: "" });
  };
  const version = (documentKind: string, documentId: string, payload: Record<string, unknown>): Record<string, unknown> => ({
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    effectiveFrom: D4_RULES_FROM,
    recordedBy: D4_OWNER,
    payload,
  });
  registry(
    "model.json",
    version("MODEL_VERSION", D4_MODEL, {
      provider: "claude",
      model: "claude-opus-5",
      release: "2026-06-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["implementer"],
      transports: ["CLI_SUBSCRIPTION"],
    }),
  );
  registry(
    "routing.json",
    version("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", {
      role: "implementer",
      slot: 0,
      provider: "claude",
      modelVersionId: D4_MODEL,
      fallbacks: [],
    }),
  );
  if (options.priced) {
    registry(
      "catalog.json",
      version("PRICE_TABLE", D4_CATALOG, {
        intervals: [
          {
            provider: "claude",
            modelVersionId: D4_MODEL,
            transportKind: "CLI_SUBSCRIPTION",
            tokenClass: "output",
            currency: "USD",
            effectiveFrom: D4_RULES_FROM,
            effectiveTo: null,
            pricePerMillionNanos: 75_000_000_000,
          },
        ],
      }),
    );
  }
  const initiative = acp([
    "initiative",
    "--database",
    databasePath,
    "--format",
    "json",
    "--request",
    d4Write(directory, "initiative.json", {
      initiativeId: D4_INITIATIVE,
      slug: "acp-p15-d4",
      title: "The P-15 door-to-result drill",
      objective: "Run one recorded task from its door to its result.",
      recordedBy: D4_OWNER,
    }),
  ]);
  expect({ status: initiative.status, stderr: initiative.stderr }).toEqual({ status: 0, stderr: "" });
  const taskId = randomUUID();
  const intakeRequest = {
    envelope: {
      ...envelopeFor(taskId, D4_INITIATIVE, [D4_WRITTEN]),
      objective: instruction,
      content: fixtureContent(instruction),
      readSet: [D4_WRITTEN],
    },
    clientScope: D4_OPERATOR,
    clientRequestKey: "d4-" + taskId,
    roadmapVersionId: null,
    stepId: null,
    role: "implementer",
    slot: 0,
    transportKind: "CLI_SUBSCRIPTION",
    recordedBy: D4_OPERATOR,
  };
  if (options.intakeBy === "CALLER") return { databasePath, taskId, intakeRequest };
  const intake = acp([
    "intake",
    "--database",
    databasePath,
    "--format",
    "json",
    "--request",
    d4Write(directory, "intake.json", intakeRequest),
  ]);
  expect({ status: intake.status, stderr: intake.stderr }).toEqual({ status: 0, stderr: "" });
  return { databasePath, taskId, intakeRequest };
}

/** A git worktree holding the one path the envelope declares, committed. */
function d4Worktree(): string {
  const directory = d4Directory();
  const git = (...args: string[]): void => {
    spawnSync("/usr/bin/git", args, { cwd: directory, encoding: "utf8" });
  };
  git("init", "--quiet");
  git("config", "user.email", "drill@example.invalid");
  git("config", "user.name", "drill");
  mkdirSync(join(directory, "docs"), { recursive: true });
  writeFileSync(join(directory, D4_WRITTEN), "the door-to-result drill\n", "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture base");
  return directory;
}

/**
 * The synthetic echo child, behind the real Claude adapter's argv.
 *
 * It appends one line to a spawn log (so a replay can prove it was not started),
 * keeps the instruction it read on stdin in a side file — never on stdout, which the
 * adapter parses — and answers in the captured stream-json shape, all five of the success
 * sample's record kinds in its order: `system/commands_changed`, `init`, an assistant text
 * record echoing the instruction, an allowed `rate_limit_event`, then a result carrying
 * `is_error`, the session id the adapter named on its argv, and one four-class usage.
 */
function d4EchoChild(options: { readonly isError: boolean }): {
  readonly binary: string;
  readonly echoFile: string;
  readonly spawnLog: string;
} {
  const directory = d4Directory();
  const echoFile = join(directory, "instruction.txt");
  const spawnLog = join(directory, "spawns.log");
  const binary = join(directory, "fake-claude");
  const program = [
    "#!" + realpathSync(process.execPath),
    "const fs = require('node:fs');",
    "fs.appendFileSync(" + JSON.stringify(spawnLog) + ", 'spawned\\n');",
    "const chunks = [];",
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  const text = Buffer.concat(chunks).toString('utf8');",
    "  fs.writeFileSync(" + JSON.stringify(echoFile) + ", text);",
    "  const at = process.argv.indexOf('--session-id');",
    "  const session = at >= 0 ? process.argv[at + 1] : 'session-d4';",
    "  const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    // The captured success sample's five record kinds, in its order (P-15/D4 v2).
    "  out({ type: 'system', subtype: 'commands_changed' });",
    "  out({ type: 'system', subtype: 'init', model: 'claude-opus-5-20260601' });",
    "  out({ type: 'assistant', message: { id: 'msg_d4_1', content: [{ type: 'text', text }] } });",
    "  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });",
    "  out({ type: 'result', subtype: 'success', is_error: " + String(options.isError) + ", session_id: session,",
    "    usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 13 } });",
    "  process.exit(" + (options.isError ? "1" : "0") + ");",
    "});",
  ].join("\n");
  writeFileSync(binary, program + "\n", { mode: 0o700 });
  return { binary, echoFile, spawnLog };
}

/** The recorded form's config file, owner-only, as launchd would hand it over. */
function d4ConfigFile(
  databasePath: string,
  taskId: string,
  binary: string,
  catalogDocumentId: string,
  outputBudgetBytes = 65_536,
): string {
  const directory = d4Directory();
  return d4Write(directory, "daemon.json", {
    mode: "SQLITE_SUPERVISOR",
    databasePath,
    taskId,
    emittedBy: D4_OPERATOR,
    holdOpen: false,
    checkPorts: false,
    execution: {
      route: {
        provider: "claude",
        model: "claude-opus-5",
        accountId: D4_ACCOUNT,
        transportKind: "CLI_SUBSCRIPTION",
        capabilityPolicyVersion: "2026-09-03.1",
        resolvedAt: D4_RULES_FROM,
      },
      bindings: [
        {
          accountId: D4_ACCOUNT,
          transportKind: "CLI_SUBSCRIPTION",
          provider: "claude",
          binary,
          configRoot: d4Directory(),
          workdir: d4Worktree(),
          limits: { timeoutMs: 20_000, outputBudgetBytes, interruptGraceMs: 200, termGraceMs: 200 },
        },
      ],
      catalogDocumentId,
    },
  });
}

interface D4Event {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Every event of the task, read back by a reader of its own. */
function d4Events(ledger: Ledger, taskId: string): readonly D4Event[] {
  return ledger
    .listEvents({ taskId, limit: 500 })
    .events.map((record) => ({ sequence: record.sequence, type: record.event.type, payload: record.event.payload }));
}

const D4_CHAIN = [
  "EFFECT_INTENDED",
  "DISPATCH_INTENDED",
  "DISPATCH_OUTCOME_RECORDED",
  "PROMPT_OCCURRENCE_RECORDED",
  "USAGE_STREAM_DECLARED",
  "USAGE_OBSERVATION_RECORDED",
  "DISPATCH_OUTCOME_RECORDED",
  "RESPONSE_OCCURRENCE_RECORDED",
];

describe("P-15/D4: a recorded task, from its door to its result (parallelism :143)", () => {
  beforeAll(() => {
    // The package's own build, not the repository typecheck: the drill spawns what
    // an operator runs, and an order-dependent dist would be an order-dependent pass.
    const packageManager = process.env["npm_execpath"];
    const built =
      packageManager === undefined
        ? spawnSync("pnpm", ["--filter", "@acp/cli", "build"], { cwd: D4_REPO_ROOT, encoding: "utf8" })
        : spawnSync(process.execPath, [packageManager, "--filter", "@acp/cli", "build"], { cwd: D4_REPO_ROOT, encoding: "utf8" });
    if (built.status !== 0) throw new Error("could not build the CLI: " + (built.stderr || built.stdout));
  }, 300_000);

  it("PC-D1/PC-D2: the whole chain and the answer are read back independently, and a replay spends nothing", async () => {
    const { databasePath, taskId } = d4ThroughTheDoors({ priced: true });
    const child = d4EchoChild({ isError: false });
    const config = d4ConfigFile(databasePath, taskId, child.binary, D4_CATALOG);

    await expect(runPackagedEntry([config])).resolves.toBe(0);

    // The child ran once, and what it was handed is the instruction the envelope carries.
    expect(readFileSync(child.spawnLog, "utf8")).toBe("spawned\n");
    expect(readFileSync(child.echoFile, "utf8")).toBe(D4_INSTRUCTION);

    const ledger = openLedger(databasePath);
    ledgers.push(ledger);
    const events = d4Events(ledger, taskId);
    const types = events.map((event) => event.type);
    // The door's intake, the walk's opening at the intake's flat attempt, the plan
    // with the chain between its INTENT and OUTCOME, and the checkpoint.
    expect(types[0]).toBe("TASK_DISCOVERED");
    expect(types[1]).toBe("TASK_ATTEMPT_OPENED");
    const intent = types.indexOf("RUN_STARTED");
    expect(types.slice(intent + 1, intent + 1 + D4_CHAIN.length)).toEqual(D4_CHAIN);
    expect(types).toContain("CHECKPOINT_WRITTEN");
    expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");
    expect(types).not.toContain("TOKEN_USAGE_RECORDED");

    const chain = events.slice(intent + 1, intent + 1 + D4_CHAIN.length);
    // The pin is the catalog's version in force.
    expect(chain[1]?.payload["dispatch"]).toMatchObject({ catalogDocumentId: D4_CATALOG, catalogVersion: 1 });
    // The prompt occurrence's digest is the instruction's, recomputed here only.
    expect(chain[3]?.payload["promptOccurrence"]).toMatchObject({
      promptSha256: createHash("sha256").update(D4_INSTRUCTION, "utf8").digest("hex"),
      promptBytes: Buffer.byteLength(D4_INSTRUCTION, "utf8"),
    });
    // Exactly one observation: CUMULATIVE, final, the child's four classes.
    expect(types.filter((type) => type === "USAGE_OBSERVATION_RECORDED")).toHaveLength(1);
    expect(chain[5]?.payload["usageObservation"]).toMatchObject({
      reportKind: "CUMULATIVE",
      isFinal: 1,
      inputTokens: 5,
      outputTokens: 7,
      cacheWriteTokens: 11,
      cacheReadTokens: 13,
      totalTokens: 36,
    });
    const settled = chain[6]?.payload["outcome"] as Readonly<Record<string, unknown>>;
    expect(settled).toMatchObject({ dispatchState: "SETTLED", effectOutcomeStatus: "SUCCEEDED" });

    // The RESPONSE bytes, read from the private plane by this suite's own plane.
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(databasePath), {
      incarnationId: randomUUID(),
      createdAt: D4_RULES_FROM,
    });
    try {
      const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: databasePath });
      const read = plane.read({
        artifactReferenceId: String(settled["resultArtifactReferenceId"]),
        scopeKind: "TASK",
        scopeId: taskId,
      });
      expect(read.verb).toBe("READ");
      if (read.verb === "READ") {
        expect(createHash("sha256").update(read.content).digest("hex")).toBe(settled["resultSha256"]);
        const document = ResultContractSchema.parse(JSON.parse(read.content.toString("utf8")));
        expect(document.status).toBe("SUCCEEDED");
        expect(document.blocks.map((block) => block.text).join("")).toBe(D4_INSTRUCTION);
      }
    } finally {
      leaseStore.close();
    }

    // Integrity, and a rebuild that reproduces the read models it folded.
    expect(ledger.verifyIntegrity().problems).toEqual([]);
    const effectId = String((chain[0]?.payload["effect"] as Readonly<Record<string, unknown>>)["effectId"]);
    const readModels = (): string =>
      JSON.stringify([
        ledger.getTask(taskId),
        ledger.getEffect(effectId),
        ledger.listDispatchAttempts(effectId),
        ledger.getTaskRevision(taskId, 1),
      ]);
    const before = readModels();
    ledger.rebuildReadModel();
    expect(readModels()).toBe(before);
    ledger.close();

    // PC-D2, ND-D4-1: a replay on the same {L, taskId} appends only its own lease
    // grant and revocation — a fresh fence is a fresh fact — and nothing of the plan
    // or the chain; the child is not started, and the task is still CHECKPOINTED.
    await expect(runPackagedEntry([config])).resolves.toBe(0);
    expect(readFileSync(child.spawnLog, "utf8")).toBe("spawned\n");
    const replayed = openLedger(databasePath);
    ledgers.push(replayed);
    const after = d4Events(replayed, taskId);
    expect(after.slice(0, events.length)).toEqual(events);
    expect(after.slice(events.length).map((event) => event.type)).toEqual(["LEASE_ACQUIRED", "LEASE_REVOKED"]);
    expect(replayed.getTask(taskId)?.currentState).toBe("CHECKPOINTED");
    expect(replayed.verifyIntegrity().problems).toEqual([]);
  }, 180_000);

  it("N-D10: a catalog that prices nothing in force refuses before any spend, and the task settles FAILED", async () => {
    const { databasePath, taskId } = d4ThroughTheDoors({ priced: false });
    const child = d4EchoChild({ isError: false });
    // The supervisor settles the failure and then rethrows it, classified, as every
    // failing walk does: the start rejects, and TASK_FAILED is already durable.
    await expect(runPackagedEntry([d4ConfigFile(databasePath, taskId, child.binary, D4_CATALOG)])).rejects.toMatchObject({
      name: "DispatchRefusedError",
      at: "catalogDocumentId",
    });
    expect(existsSync(child.spawnLog)).toBe(false);
    const ledger = openLedger(databasePath);
    ledgers.push(ledger);
    const types = d4Events(ledger, taskId).map((event) => event.type);
    for (const absent of ["EFFECT_INTENDED", "DISPATCH_INTENDED", "PROMPT_OCCURRENCE_RECORDED", "USAGE_STREAM_DECLARED"]) {
      expect(types, absent).not.toContain(absent);
    }
    expect(ledger.getTask(taskId)?.currentState).toBe("FAILED");
    expect(types).not.toContain("CHECKPOINT_WRITTEN");
  }, 180_000);

  it("N-D12: an answer the operation marks as an error is recorded with its response, and the task never checkpoints", async () => {
    const { databasePath, taskId } = d4ThroughTheDoors({ priced: true });
    const child = d4EchoChild({ isError: true });
    await expect(runPackagedEntry([d4ConfigFile(databasePath, taskId, child.binary, D4_CATALOG)])).rejects.toMatchObject({
      name: "OperationFailedError",
    });
    expect(readFileSync(child.spawnLog, "utf8")).toBe("spawned\n");
    const ledger = openLedger(databasePath);
    ledgers.push(ledger);
    const events = d4Events(ledger, taskId);
    const types = events.map((event) => event.type);
    const settled = events.find(
      (event) => event.type === "DISPATCH_OUTCOME_RECORDED" && (event.payload["outcome"] as Record<string, unknown>)["dispatchState"] === "SETTLED",
    );
    expect(settled?.payload["outcome"]).toMatchObject({ effectOutcomeStatus: "FAILED" });
    expect(types).toContain("RESPONSE_OCCURRENCE_RECORDED");
    expect(types).not.toContain("CHECKPOINT_WRITTEN");
    expect(ledger.getTask(taskId)?.currentState).toBe("FAILED");
    expect(ledger.verifyIntegrity().problems).toEqual([]);
  }, 180_000);
});

/**
 * PC-D3 (ND-D4-2): the inline V1 walk's bytes did not move under D3.
 *
 * One inline walk, every input fixed — the task, the instant, the scenario, the
 * route, the clock, and a worktree at a fixed path committed at a fixed date so its
 * head is one sha — and its event trail hashed without the lease rows, whose ids and
 * fences are the daemon's own lease store's (shared by every drill in this project)
 * and not the walk's. The literal was lifted by running this same test over the
 * pre-D3 source: `git archive be3b06f` into the session scratchpad, read-only on the
 * repository, with this file copied in and run there (ADR 0105, D4).
 */
const D4_V1_TRAIL_SHA256 = "f61ca58bf709f90d8c25066d45dc234c4eced0275fab37bc4f5d02f52de8ed93";

describe("P-15/D4 PC-D3: the inline V1 walk is byte-identical to the one before D3", () => {
  it("hashes the same trail, lease rows aside, as the pre-D3 source", async () => {
    const worktree = join(TMP_ROOT, "acp-d4-v1-worktree");
    rmSync(worktree, { recursive: true, force: true });
    mkdirSync(join(worktree, "docs"), { recursive: true, mode: 0o700 });
    chmodSync(worktree, 0o700);
    temporaries.push(worktree);
    const env = { ...process.env, GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z" };
    const git = (...args: string[]): void => {
      spawnSync("/usr/bin/git", args, { cwd: worktree, encoding: "utf8", env });
    };
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "drill@example.invalid");
    git("config", "user.name", "drill");
    writeFileSync(join(worktree, D4_WRITTEN), "the V1 control\n", "utf8");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture base");

    const child = d4EchoChild({ isError: false });
    const taskId = "d4d4d4d4-0000-4000-8000-0000000000d1";
    const scenarioId = b4aScenarioId("d4-v1-identity");
    const execution: DaemonExecutionConfig = {
      route: {
        provider: "claude",
        model: "opus",
        accountId: D4_ACCOUNT,
        transportKind: "CLI_SUBSCRIPTION",
        capabilityPolicyVersion: "2026-09-03.1",
        resolvedAt: RESOLVED_AT,
      },
      bindings: [
        {
          accountId: D4_ACCOUNT,
          transportKind: "CLI_SUBSCRIPTION",
          provider: "claude",
          binary: child.binary,
          configRoot: d4Directory(),
          workdir: worktree,
          limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
        },
      ],
    };
    const envelope = { ...envelopeFor(taskId, INITIATIVE_ID, [D4_WRITTEN]), objective: D4_INSTRUCTION, content: fixtureContent(D4_INSTRUCTION) } as TaskEnvelope;
    await stopDaemon(
      await startDaemon({
        mode: "SQLITE_SUPERVISOR",
        scenarioId,
        emittedBy: EMITTED_BY,
        taskId,
        attempt: 1,
        submittedAt: SUBMITTED_AT,
        submissionDigest: canonicalSubmissionDigest({
          taskId,
          attempt: 1,
          submittedAt: SUBMITTED_AT,
          initiativeId: INITIATIVE_ID,
          route: execution.route,
        }),
        initiativeId: INITIATIVE_ID,
        checkPorts: false,
        clock: () => SUBMITTED_AT,
        execution,
        envelope,
      }),
    );
    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(scenarioId)));
    ledgers.push(ledger);
    const trail = ledger
      .listEvents({ taskId, limit: 500 })
      .events.filter((record) => !record.event.type.startsWith("LEASE_"))
      .map((record) => record.canonicalJson);
    expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");
    // The pin is portable, proven rather than assumed (P-15/D4 v2, Fable C1): no event
    // it hashes carries the temporary root, the scenario root or the child's directory,
    // so the digest cannot depend on where either tree was run.
    const scenarioRoot = resolveScenarioRoot(scenarioId);
    for (const [label, path] of [
      ["temporary root", TMP_ROOT],
      ["scenario root", scenarioRoot],
      ["child directory", resolve(child.binary, "..")],
      ["worktree", worktree],
    ] as const) {
      expect(trail.some((json) => json.includes(path)), label).toBe(false);
    }
    expect(createHash("sha256").update(trail.join("\n"), "utf8").digest("hex")).toBe(D4_V1_TRAIL_SHA256);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// P-15/F: from the door to the result, read back through both new doors (ADR 0107)
// ---------------------------------------------------------------------------

/**
 * The door-to-result drills of P-15/F (contratos §4.3, parallelism :143).
 *
 * Every row enters by a real door — the compiled `acp intake`, or `POST /tasks` on
 * a spawned `acp-server` — runs the recorded daemon through its packaged entry
 * against a synthetic child behind the real Claude adapter's argv, and reads the
 * result back through **both** new doors: the compiled `acp effects` and
 * `acp result`, and the spawned server's `taskEffects` and bearer-guarded
 * `taskEffectResult`. Nothing reads the result through a port, the ledger or the
 * plane directly, and the effect id comes from a door. The by-hand acts are D4's
 * empty ledger file and, in N-F-D9, the byte the drill flips on purpose.
 *
 * Each run carries a sentinel in its instruction, which the child echoes into its
 * answer. The authorized reads must show it (the positive control), and nothing
 * else may: not the event stream, not a public GET, not the server's own output,
 * not the CLI's stderr and not one row of the ledger (tests §8.1, decision 149).
 * The private plane and the daemon's evidence root are the declared private side
 * and are not swept.
 */
const F_GATEWAY_ENTRY = join(D4_REPO_ROOT, "packages", "entrypoints", "gateway", "dist", "bin", "index.js");
const F_TOKEN = "p15f-drill-bearer-" + "t".repeat(28);
const F_PAD = "This sentence pads the answer past the block list and says nothing more. ";
const F_OVERFLOW_AT = 400_000;

/** The answer the padded child gives: the instruction, then plain sentences past the block list. */
function fPadded(instruction: string): string {
  let answer = instruction;
  while (answer.length <= F_OVERFLOW_AT + 50) answer += F_PAD;
  return answer;
}

type FChildMode = "ECHO" | "PADDED" | "AUTH_FAILURE" | "ERROR_EXIT_0" | "KILLED";

/**
 * A synthetic child behind the real Claude adapter's argv, on D4's echo child's
 * mould. `ECHO` and `PADDED` answer the instruction (the second padded past the
 * block list); `AUTH_FAILURE` replays the captured authentication failure, exit 1;
 * `ERROR_EXIT_0` is the crossed pair, `is_error` with exit 0 and the text "boom";
 * `KILLED` starts an answer and is killed before any result.
 */
async function fChild(mode: FChildMode): Promise<{ readonly binary: string; readonly spawnLog: string }> {
  const directory = d4Directory();
  const spawnLog = join(directory, "spawns.log");
  const binary = join(directory, "fake-claude");
  const captured = mode === "AUTH_FAILURE" ? (await capturedStreams()).CAPTURED_AUTH_FAILURE : [];
  const program = [
    "#!" + realpathSync(process.execPath),
    "const fs = require('node:fs');",
    "fs.appendFileSync(" + JSON.stringify(spawnLog) + ", 'spawned\\n');",
    "const chunks = [];",
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  const text = Buffer.concat(chunks).toString('utf8');",
    "  const at = process.argv.indexOf('--session-id');",
    "  const session = at >= 0 ? process.argv[at + 1] : 'session-f';",
    "  const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "  const mode = " + JSON.stringify(mode) + ";",
    "  if (mode === 'AUTH_FAILURE') {",
    "    for (const line of " + JSON.stringify([...captured]) + ") process.stdout.write(line.split('00000000-0000-4000-8000-000000000001').join(session) + '\\n');",
    "    process.exit(1);",
    "  }",
    "  out({ type: 'system', subtype: 'init', model: 'claude-opus-5-20260601' });",
    "  if (mode === 'KILLED') {",
    "    out({ type: 'assistant', message: { id: 'msg_f_1', content: [{ type: 'text', text: 'half an answer' }] } });",
    "    process.kill(process.pid, 'SIGKILL');",
    "    return;",
    "  }",
    "  let answer = mode === 'ERROR_EXIT_0' ? 'boom' : text;",
    "  if (mode === 'PADDED') { while (answer.length <= " + String(F_OVERFLOW_AT + 50) + ") answer += " + JSON.stringify(F_PAD) + "; }",
    "  out({ type: 'assistant', message: { id: 'msg_f_1', content: [{ type: 'text', text: answer }] } });",
    "  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });",
    "  out({ type: 'result', subtype: 'success', is_error: mode === 'ERROR_EXIT_0', session_id: session,",
    "    usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 13 } });",
    // Not `process.exit`: a pipe drains asynchronously, and exiting at once would
    // cut a padded answer's records short. The process ends when stdout drains.
    "  process.exitCode = 0;",
    "});",
  ].join("\n");
  writeFileSync(binary, program + "\n", { mode: 0o700 });
  return { binary, spawnLog };
}

interface FServer {
  readonly url: string;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

const fServers: FServer[] = [];

/**
 * The compiled `acp-server`, spawned as an operator runs it, on a loopback port.
 *
 * The entry reports no port and this project may not open a socket of its own
 * (the daemon's import law), so a port is drawn from a high range and a server
 * that could not bind it — it exits — is retried on another.
 */
async function fServer(ledgerPath: string, options: { readonly bearer: boolean }): Promise<FServer> {
  const args = [F_GATEWAY_ENTRY, "--ledger", ledgerPath];
  if (options.bearer) {
    const token = join(d4Directory(), "bearer.token");
    writeFileSync(token, F_TOKEN + "\n", { encoding: "utf8", mode: 0o600 });
    args.push("--write-bearer", token);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    const child = spawn(process.execPath, [...args, "--port", String(port)], { cwd: D4_REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const exited = new Promise<void>((done) => {
      child.once("exit", () => {
        done();
      });
    });
    const url = "http://127.0.0.1:" + String(port);
    let up = false;
    for (let tries = 0; tries < 100 && !up && child.exitCode === null; tries += 1) {
      try {
        up = (await fetch(url + "/api/v1/health")).status === 200;
      } catch {
        await new Promise((settle) => setTimeout(settle, 100));
      }
    }
    if (!up) {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
      continue;
    }
    const server: FServer = {
      url,
      output: () => output,
      stop: async () => {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await exited;
        }
      },
    };
    fServers.push(server);
    return server;
  }
  throw new Error("acp-server did not come up on any of five ports");
}

afterEach(async () => {
  for (const server of fServers.splice(0)) await server.stop();
});

interface FResponse {
  readonly status: number;
  readonly cacheControl: string | null;
  readonly body: string;
}

async function fGet(server: FServer, path: string, authorization: string | null = "Bearer " + F_TOKEN): Promise<FResponse> {
  const response = await fetch(server.url + path, authorization === null ? {} : { headers: { authorization } });
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.text() };
}

/** The event stream from its first row, read for a bounded window and then closed. */
async function fStream(server: FServer): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 1_500);
  let text = "";
  try {
    const response = await fetch(server.url + "/api/v1/events/stream", { headers: { "last-event-id": "0" }, signal: controller.signal });
    const reader = response.body?.getReader();
    if (reader === undefined) return text;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString("utf8");
    }
  } catch {
    // The window closed the connection; what arrived is what is swept.
  } finally {
    clearTimeout(timer);
  }
  return text;
}

/**
 * The raw bytes of every SQLite file beside the ledger — the ledger, its WAL and
 * shared memory, and the coordination stores — as text.
 *
 * Raw pages rather than rows: SQLite stores text uncompressed, so a sentinel in any
 * row, live or freed, overflow page included, is in these bytes. Stricter than a
 * row dump, and it needs no database driver this project may not import.
 */
function fLedgerText(ledgerPath: string): string {
  const directory = resolve(ledgerPath, "..");
  const files = readdirSync(directory).filter((name) => /\.sqlite(?:-wal|-shm|-journal)?$/.test(name));
  expect(files).toContain("control-plane.sqlite");
  return files.map((name) => readFileSync(join(directory, name)).toString("latin1")).join("\n");
}

function fPaths(taskId: string, effectId: string): { readonly effects: string; readonly result: string } {
  return {
    effects: "/api/v1/tasks/" + taskId + "/effects",
    result: "/api/v1/tasks/" + taskId + "/effects/" + effectId + "/result",
  };
}

/** The effect a door lists: exactly one, and its id comes from the door, never from the ledger. */
function fOnlyEffect(document: unknown): Readonly<Record<string, unknown>> {
  const effects = (document as { readonly effects: readonly Record<string, unknown>[] }).effects;
  expect(effects).toHaveLength(1);
  const [effect] = effects;
  if (effect === undefined) throw new Error("no effect listed");
  return effect;
}

/**
 * The absence sweep (tests §8.1): the sentinel is in none of the public sinks.
 * `cliStderr` is every stderr the CLI wrote in this run.
 */
async function fSweep(server: FServer, input: { readonly sentinel: string; readonly taskId: string; readonly ledgerPath: string; readonly cliStderr: readonly string[] }): Promise<void> {
  const publicBodies = [
    await fStream(server),
    (await fGet(server, "/api/v1/events?limit=1000", null)).body,
    (await fGet(server, "/api/v1/tasks/" + input.taskId, null)).body,
    (await fGet(server, "/api/v1/overview", null)).body,
    (await fGet(server, "/api/v1/tasks/" + input.taskId + "/effects", null)).body,
  ];
  const where: string[] = [];
  publicBodies.forEach((body, index) => {
    if (body.includes(input.sentinel)) where.push("public body " + String(index));
  });
  if (server.output().includes(input.sentinel)) where.push("the server's own output");
  input.cliStderr.forEach((stderr, index) => {
    if (stderr.includes(input.sentinel)) where.push("CLI stderr " + String(index));
  });
  if (fLedgerText(input.ledgerPath).includes(input.sentinel)) where.push("a ledger row");
  expect(where).toEqual([]);
  // The stream sweep read something: a window that saw nothing would prove nothing.
  expect(publicBodies[0]?.length ?? 0).toBeGreaterThan(0);
}

describe("P-15/F: a result is read back by reference, through both new doors, behind authorization (ADR 0107)", () => {
  beforeAll(() => {
    // The two packages the drill spawns, built as an operator's checkout would be.
    const packageManager = process.env["npm_execpath"];
    for (const name of ["@acp/cli", "@acp/gateway"]) {
      const built =
        packageManager === undefined
          ? spawnSync("pnpm", ["--filter", name, "build"], { cwd: D4_REPO_ROOT, encoding: "utf8" })
          : spawnSync(process.execPath, [packageManager, "--filter", name, "build"], { cwd: D4_REPO_ROOT, encoding: "utf8" });
      if (built.status !== 0) throw new Error("could not build " + name + ": " + (built.stderr || built.stdout));
    }
  }, 600_000);

  it("PC-F1 (D-F-1): CLI intake, an answer past the block list, read back through both doors, by reference and by block", async () => {
    const sentinel = "PFONE" + randomUUID().replace(/-/g, "");
    const instruction = "Echo this instruction back, word for word: " + sentinel;
    const answer = fPadded(instruction);
    const { databasePath, taskId } = d4ThroughTheDoors({ priced: true, instruction });
    const child = await fChild("PADDED");
    await expect(runPackagedEntry([d4ConfigFile(databasePath, taskId, child.binary, D4_CATALOG, 4 * 1024 * 1024)])).resolves.toBe(0);
    expect(readFileSync(child.spawnLog, "utf8")).toBe("spawned\n");
    const server = await fServer(databasePath, { bearer: true });
    const cliStderr: string[] = [];
    const cli = (args: readonly string[]): D4Invocation => {
      const ran = acp([...args, "--database", databasePath, "--format", "json"]);
      cliStderr.push(ran.stderr);
      return ran;
    };

    // (1) The effect id comes from a door: the CLI's effects verb.
    const listed = cli(["effects", taskId]);
    expect({ status: listed.status, stderr: listed.stderr }).toEqual({ status: 0, stderr: "" });
    const effect = fOnlyEffect(JSON.parse(listed.stdout));
    expect(effect).toMatchObject({ outcomeStatus: "SUCCEEDED", hasResult: true });
    const effectId = String(effect["effectId"]);
    const paths = fPaths(taskId, effectId);

    // (2) The CLI's result verb: one document block, by reference, whose bytes are the answer's.
    const byCli = cli(["result", "--task", taskId, "--effect", effectId]);
    expect({ status: byCli.status, stderr: byCli.stderr }).toEqual({ status: 0, stderr: "" });
    const document = JSON.parse(byCli.stdout) as Record<string, unknown>;
    expect(document).toMatchObject({ state: "RESULT", outcomeStatus: "SUCCEEDED", cohort: "CURRENT", blockContent: null });
    const blocks = ((document["result"] as Record<string, unknown>)["document"] as Record<string, unknown>)["blocks"] as Record<string, unknown>[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "document",
      text: null,
      mediaType: "text/markdown; charset=utf-8",
      byteLength: Buffer.byteLength(answer, "utf8"),
      contentSha256: createHash("sha256").update(answer, "utf8").digest("hex"),
    });
    expect(blocks[0]?.["artifactRefId"]).toEqual(expect.any(String));

    // (3) The HTTP door, behind the bearer: the same document, never cached.
    const byHttp = await fGet(server, paths.result);
    expect([byHttp.status, byHttp.cacheControl]).toEqual([200, "no-store"]);
    expect(JSON.parse(byHttp.body)).toEqual(document);

    // (4) Without the bearer, and with a wrong one: 401 alike, and no result.
    for (const authorization of [null, "Bearer " + "w".repeat(40)]) {
      const refused = await fGet(server, paths.result, authorization);
      expect([refused.status, refused.cacheControl]).toEqual([401, "no-store"]);
      expect(JSON.parse(refused.body)).not.toHaveProperty("result");
      expect(refused.body).not.toContain(sentinel);
    }

    // (7) The block, by its own reference, through both doors: the answer, verified.
    const blockHttp = await fGet(server, paths.result + "?block=0");
    expect([blockHttp.status, blockHttp.cacheControl]).toEqual([200, "no-store"]);
    const blockCli = cli(["result", "--task", taskId, "--effect", effectId, "--block", "0"]);
    expect({ status: blockCli.status, stderr: blockCli.stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(blockCli.stdout)).toEqual(JSON.parse(blockHttp.body));
    const blockContent = (JSON.parse(blockHttp.body) as Record<string, unknown>)["blockContent"] as Record<string, unknown>;
    expect(blockContent["text"]).toBe(answer);
    expect(blockContent).toMatchObject({
      index: 0,
      artifactReferenceId: blocks[0]?.["artifactRefId"],
      contentSha256: createHash("sha256").update(String(blockContent["text"]), "utf8").digest("hex"),
      byteLength: Buffer.byteLength(String(blockContent["text"]), "utf8"),
    });

    // (6) The positive control: the sentinel is where the authorization says it may be.
    expect(blockHttp.body).toContain(sentinel);
    expect(blockCli.stdout).toContain(sentinel);

    // (5) And nowhere else.
    await fSweep(server, { sentinel, taskId, ledgerPath: databasePath, cliStderr });

    // N-F-D8: a server started with no bearer shuts the private read, whatever is presented.
    const shut = await fServer(databasePath, { bearer: false });
    const unconfigured = await fGet(shut, paths.result);
    expect([unconfigured.status, unconfigured.cacheControl]).toEqual([403, "no-store"]);
    expect(JSON.parse(unconfigured.body)).toMatchObject({ error: { code: "PRIVATE_READ_UNCONFIGURED" } });

    // N-F-D8: another task's effect answers exactly as an absent effect does, both doors.
    const otherTask = randomUUID();
    const crossed = await fGet(server, fPaths(otherTask, effectId).result);
    const absent = await fGet(server, fPaths(otherTask, "f".repeat(64)).result);
    expect([crossed.status, absent.status]).toEqual([404, 404]);
    expect(crossed.body).toBe(absent.body);
    expect(cli(["result", "--task", otherTask, "--effect", effectId]).status).toBe(4);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await fetch(server.url + paths.result, { method, headers: { authorization: "Bearer " + F_TOKEN } });
      expect(response.status).toBe(405);
    }

    // N-F-D9: a byte of the RESPONSE flipped under the plane: the integrity refusal,
    // its closed word, and no byte of the answer through either door.
    const digest = String(blocks[0]?.["contentSha256"]);
    const object = join(resolve(databasePath, ".."), "private-artifacts", digest.slice(0, 2), digest);
    const bytes = readFileSync(object);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    writeFileSync(object, bytes);
    const tampered = await fGet(server, paths.result + "?block=0");
    expect(tampered.status).toBe(500);
    expect(JSON.parse(tampered.body)).toMatchObject({ error: { code: "LEDGER_INTEGRITY", detail: "CONTENT_DOES_NOT_VERIFY" } });
    expect(tampered.body).not.toContain(sentinel);
    const tamperedCli = cli(["result", "--task", taskId, "--effect", effectId, "--block", "0"]);
    expect([tamperedCli.status, tamperedCli.stdout]).toEqual([6, ""]);
    expect(tamperedCli.stderr).not.toContain(sentinel);
  }, 300_000);

  it("PC-F2 (D-F-2): HTTP intake, a short answer inline, read back through both doors; a block read is refused", async () => {
    const sentinel = "PFTWO" + randomUUID().replace(/-/g, "");
    const instruction = "Echo this instruction back, word for word: " + sentinel;
    const { databasePath, taskId, intakeRequest } = d4ThroughTheDoors({ priced: true, instruction, intakeBy: "CALLER" });
    const server = await fServer(databasePath, { bearer: true });
    const intake = await fetch(server.url + "/api/v1/tasks", {
      method: "POST",
      headers: { authorization: "Bearer " + F_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(intakeRequest),
    });
    expect(intake.status).toBe(200);
    const child = await fChild("ECHO");
    await expect(runPackagedEntry([d4ConfigFile(databasePath, taskId, child.binary, D4_CATALOG)])).resolves.toBe(0);
    const cliStderr: string[] = [];

    // Discovery by the HTTP door this time: a plain read, no bearer.
    const listed = await fGet(server, fPaths(taskId, "x").effects, null);
    expect(listed.status).toBe(200);
    const effect = fOnlyEffect(JSON.parse(listed.body));
    expect(effect).toMatchObject({ outcomeStatus: "SUCCEEDED", hasResult: true });
    const effectId = String(effect["effectId"]);
    const paths = fPaths(taskId, effectId);

    const byHttp = await fGet(server, paths.result);
    expect([byHttp.status, byHttp.cacheControl]).toEqual([200, "no-store"]);
    const document = JSON.parse(byHttp.body) as Record<string, unknown>;
    expect(document).toMatchObject({ state: "RESULT", outcomeStatus: "SUCCEEDED", cohort: "CURRENT", blockContent: null });
    const blocks = ((document["result"] as Record<string, unknown>)["document"] as Record<string, unknown>)["blocks"] as Record<string, unknown>[];
    expect(blocks.map((block) => block["text"]).join("")).toBe(instruction);
    const byCli = acp(["result", "--task", taskId, "--effect", effectId, "--database", databasePath, "--format", "json"]);
    cliStderr.push(byCli.stderr);
    expect({ status: byCli.status, stderr: byCli.stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(byCli.stdout)).toEqual(document);

    // The positive control: inline, in both authorized reads.
    expect(byHttp.body).toContain(sentinel);
    expect(byCli.stdout).toContain(sentinel);

    // A text block names no reference: the block read is refused by name, both doors.
    const block = await fGet(server, paths.result + "?block=0");
    expect(block.status).toBe(400);
    expect(JSON.parse(block.body)).toMatchObject({ error: { code: "BAD_REQUEST", detail: "block" } });
    const blockCli = acp(["result", "--task", taskId, "--effect", effectId, "--block", "0", "--database", databasePath, "--format", "json"]);
    cliStderr.push(blockCli.stderr);
    expect([blockCli.status, blockCli.stdout]).toEqual([2, ""]);

    await fSweep(server, { sentinel, taskId, ledgerPath: databasePath, cliStderr });
  }, 300_000);

  it("D-F-3: the captured authentication failure has no result, and both doors say so", async () => {
    const { databasePath, taskId } = d4ThroughTheDoors({ priced: true });
    const child = await fChild("AUTH_FAILURE");
    await expect(runPackagedEntry([d4ConfigFile(databasePath, taskId, child.binary, D4_CATALOG)])).rejects.toMatchObject({
      name: "OperationFailedError",
    });
    await fExpectBothDoors(databasePath, taskId, {
      listed: { outcomeStatus: "FAILED", hasResult: false },
      document: { state: "NO_RESULT_RECORDED", outcomeStatus: "FAILED", cohort: "CURRENT", result: null },
    });
  }, 300_000);

  it("D-F-6: is_error with exit 0 is a FAILED result with its document, through both doors", async () => {
    const { databasePath, taskId } = d4ThroughTheDoors({ priced: true });
    const child = await fChild("ERROR_EXIT_0");
    await expect(runPackagedEntry([d4ConfigFile(databasePath, taskId, child.binary, D4_CATALOG)])).rejects.toMatchObject({
      name: "OperationFailedError",
    });
    const document = await fExpectBothDoors(databasePath, taskId, {
      listed: { outcomeStatus: "FAILED", hasResult: true },
      document: { state: "RESULT", outcomeStatus: "FAILED", cohort: "CURRENT" },
    });
    const blocks = ((document["result"] as Record<string, unknown>)["document"] as Record<string, unknown>)["blocks"] as Record<string, unknown>[];
    expect(blocks.map((block) => block["text"])).toEqual(["boom"]);
  }, 300_000);

  it("D-F-7: a child killed mid-stream is FAILED — the output it had given is its FAILED document; never SUCCEEDED, never NO_OUTCOME", async () => {
    // What D3's decider does, measured here rather than assumed: a session that ends
    // with no terminal is FAILED, and the output the collector held is assembled like
    // any FAILED operation's (P-07 Q-D9) -- a FAILED result with its document.
    const { databasePath, taskId } = d4ThroughTheDoors({ priced: true });
    const child = await fChild("KILLED");
    // Named, as D-F-3 and D-F-6 name theirs (Fable C4): the decider rules a signal
    // FAILED, so the walk throws the operation's failure after recording it.
    await expect(runPackagedEntry([d4ConfigFile(databasePath, taskId, child.binary, D4_CATALOG)])).rejects.toMatchObject({
      name: "OperationFailedError",
    });
    const document = await fExpectBothDoors(databasePath, taskId, {
      listed: { outcomeStatus: "FAILED", hasResult: true },
      document: { state: "RESULT", outcomeStatus: "FAILED", cohort: "CURRENT" },
    });
    const blocks = ((document["result"] as Record<string, unknown>)["document"] as Record<string, unknown>)["blocks"] as Record<string, unknown>[];
    expect(blocks.map((block) => block["text"])).toEqual(["half an answer"]);
  }, 300_000);
});

/** Read one task's only effect through both doors, and hold the two documents equal. */
async function fExpectBothDoors(
  databasePath: string,
  taskId: string,
  expected: { readonly listed: Record<string, unknown>; readonly document: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const server = await fServer(databasePath, { bearer: true });
  const listedCli = acp(["effects", taskId, "--database", databasePath, "--format", "json"]);
  expect({ status: listedCli.status, stderr: listedCli.stderr }).toEqual({ status: 0, stderr: "" });
  const listedHttp = await fGet(server, fPaths(taskId, "x").effects, null);
  expect(JSON.parse(listedHttp.body)).toEqual(JSON.parse(listedCli.stdout));
  const effect = fOnlyEffect(JSON.parse(listedCli.stdout));
  expect(effect).toMatchObject(expected.listed);
  const effectId = String(effect["effectId"]);
  const byHttp = await fGet(server, fPaths(taskId, effectId).result);
  expect([byHttp.status, byHttp.cacheControl]).toEqual([200, "no-store"]);
  const byCli = acp(["result", "--task", taskId, "--effect", effectId, "--database", databasePath, "--format", "json"]);
  expect({ status: byCli.status, stderr: byCli.stderr }).toEqual({ status: 0, stderr: "" });
  const document = JSON.parse(byHttp.body) as Record<string, unknown>;
  expect(JSON.parse(byCli.stdout)).toEqual(document);
  expect(document).toMatchObject(expected.document);
  expect(document["state"]).not.toBe("NO_OUTCOME");
  return document;
}
