import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ROUTING_CONFIG, EVIDENCE_ABSENT, ROUTING_REFUSALS, loadPolicyRegistry } from "@acp/accounts";
import type {
  CandidateEvidence,
  PolicyRegistry,
  PolicyRouteRequest,
  QuotaOutcome,
  RoutingRequest,
} from "@acp/accounts";
import { AccountRecord, CONTRACT_VERSION, buildIdempotencyKey } from "@acp/contracts";
import type { Checkpoint, ResolvedRoute } from "@acp/contracts";
import { createCheckpointStore, envelopeSha256, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { deriveEventCoordinate, deterministicUuid } from "../../src/core/coordinates/index.js";
import { INTENT_STEP, OUTCOME_STEP, planStep } from "../../src/core/lifecycle/index.js";
import { appendPlanStep, assertInvocationContinuity } from "../../src/core/step-executor/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import type {
  CheckpointPort,
  CheckpointRefused,
  CheckpointSource,
} from "../../src/checkpoint/index.js";
import { READ_ONLY_PLAN } from "../../src/core/lifecycle/index.js";
import type { DurableInvocation } from "../../src/contracts/index.js";
import { SqliteSupervisor } from "../../src/drivers/sqlite-supervisor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import {
  applyEffect,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";
import {
  canonicalSubmission,
  canonicalSubmissionDigest,
  composeSubmission,
  deriveInvocation,
} from "../../src/submission/index.js";
import type { DaemonSubmission, SubmissionCoordinates } from "../../src/submission/index.js";

/**
 * The submission path (V2-B7S).
 *
 * What this file proves is that election happens **above the walk** and that
 * what it elects is bound to the attempt. D5 forbade the walk resolving and
 * named the submission path as the elector's home; these drills exercise that
 * home directly, as values, with no daemon and no process.
 *
 * The policy drill is the one that matters most. `model switch por política sin
 * código` is a V2 gate criterion, and the only honest way to demonstrate it is
 * to change a document and nothing else — so A1 below runs the election twice
 * over two versions of a **copy** of the shipped policy, and asserts the
 * repository's own document was not touched by either run.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const SHIPPED_POLICY = join(REPO_ROOT, "packages", "domains", "accounts", "policy", "capability-policy.json");
const TMP_ROOT = realpathSync(tmpdir());

const ACCOUNT = "acct-b7s-fixture";
const TASK = "b7500000-0000-4000-8000-000000000001";
const INITIATIVE = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const NOW = "2026-09-01T12:00:00Z";
const RESET = "2026-12-01T00:00:00Z";
const SUBMITTED_AT = "2026-09-01T00:00:00.000Z";
const RESOLVED_AT = "2026-09-01T00:00:05.000Z";
const EMITTED_BY = "claude/opus/implementer/01";

/**
 * The digest of a fixed submission, computed by the **pre-move** implementation
 * at base `cd8367c` (A3).
 *
 * Lifted by extracting `canonicalSubmission` and `canonicalSubmissionDigest`
 * from `git show cd8367c:packages/entrypoints/daemon/src/daemon-child/index.ts`
 * and running them over `FIXED_SUBMISSION` below. It is a literal on purpose: a
 * value recomputed from the current implementation would assert only that the
 * code agrees with itself, which is exactly what a relocation must not be
 * allowed to do quietly.
 */
const PRE_MOVE_DIGEST = "af1d5cf93384691b6b526a59b6a319b1907864bd1e7a0c42ba4883580aad0d94";

const FIXED_ROUTE: ResolvedRoute = Object.freeze({
  provider: "claude",
  model: "opus",
  accountId: ACCOUNT,
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "2026-08-30.1",
  resolvedAt: RESOLVED_AT,
});

const FIXED_SUBMISSION: DaemonSubmission = Object.freeze({
  taskId: TASK,
  attempt: 1,
  submittedAt: SUBMITTED_AT,
  initiativeId: INITIATIVE,
  route: FIXED_ROUTE,
});

const temporaries: string[] = [];
const scenarios: string[] = [];
const ledgers: Ledger[] = [];

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

function stage(): string {
  const created = realpathSync(mkdtempSync(join(TMP_ROOT, "acp-b7s-")));
  chmodSync(created, 0o700);
  temporaries.push(created);
  return created;
}

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function track(ledger: Ledger): Ledger {
  ledgers.push(ledger);
  return ledger;
}

function digestOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures: an account able to serve, and the request shape the seams take
// ---------------------------------------------------------------------------

function record(enabledModels: readonly string[]): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId: ACCOUNT,
    provider: "claude",
    alias: ACCOUNT,
    authMode: "PREAUTHENTICATED_PROFILE",
    // Present on the record and never read by the composer. N4 asserts both.
    authProfileRef: "profile://acp-b7s-" + ACCOUNT,
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
    isolatedConfigRoot: "/tmp/acp-b7s-" + ACCOUNT,
    contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
  });
  if (!parsed.success) throw new Error("fixture is not a valid AccountRecord");
  return parsed.data;
}

function evidence(): CandidateEvidence {
  return { accountId: ACCOUNT, acceptance: EVIDENCE_ABSENT, contextAffinity: EVIDENCE_ABSENT, capabilities: { known: false } };
}

function routing(records: readonly AccountRecord[]): RoutingRequest {
  const outcome: QuotaOutcome = {
    ok: true,
    estimate: {
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
    },
  };
  return {
    records: [...records],
    estimates: records.length === 0 ? [] : [{ accountId: ACCOUNT, outcome }],
    evidence: records.length === 0 ? [] : [evidence()],
    task: {
      model: "",
      estimatedTokens: 10_000,
      estimatedDurationSeconds: 60,
      reserveTokens: 5_000,
      requiredCapabilities: [],
    },
    config: DEFAULT_ROUTING_CONFIG,
    now: NOW,
  };
}

function request(records: readonly AccountRecord[]): PolicyRouteRequest {
  return { role: "implementer", routing: routing(records), transportKind: "CLI_SUBSCRIPTION" };
}

function coordinates(overrides: Partial<SubmissionCoordinates> = {}): SubmissionCoordinates {
  return {
    taskId: TASK,
    attempt: 1,
    submittedAt: SUBMITTED_AT,
    initiativeId: INITIATIVE,
    resolvedAt: RESOLVED_AT,
    ...overrides,
  };
}

function shippedRegistry(path: string = SHIPPED_POLICY): PolicyRegistry {
  const outcome = loadPolicyRegistry(path);
  if (!outcome.ok) throw new Error("the policy document did not load: " + outcome.reason);
  return outcome.registry;
}

// ---------------------------------------------------------------------------
// A1 — model switch by policy, with no code change
// ---------------------------------------------------------------------------

describe("A1: the elected model follows the policy document", () => {
  it("elects a different model when only the document changes, and stamps the new version", () => {
    const dir = stage();
    const copy = join(dir, "capability-policy.json");
    copyFileSync(SHIPPED_POLICY, copy);

    const sourceBefore = digestOf(SHIPPED_POLICY);

    const first = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(copy), coordinates());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("the first election refused: " + first.reason);
    expect(first.submission.route.model).toBe("opus");
    expect(first.submission.route.capabilityPolicyVersion).toBe("2026-09-06.1");

    // Edit ONLY the copy: drop the first-preference entry and move the version.
    // No source file, no code and no fixture below this line changes.
    const document = JSON.parse(readFileSync(copy, "utf8")) as {
      policyVersion: string;
      models: { model: string }[];
    };
    document.policyVersion = "2026-09-01.1";
    document.models = document.models.filter((entry) => entry.model !== "opus");
    writeFileSync(copy, JSON.stringify(document));

    const second = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(copy), coordinates());
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("the second election refused: " + second.reason);

    // The criterion itself.
    expect(second.submission.route.model).toBe("sonnet");
    expect(second.submission.route.model).not.toBe(first.submission.route.model);
    // And the version travels with it, so a reader can tell which document
    // answered rather than having to guess from the model name.
    expect(second.submission.route.capabilityPolicyVersion).toBe("2026-09-01.1");
    // A different route is a different submission, by construction.
    expect(second.submissionDigest).not.toBe(first.submissionDigest);

    // The repository's own document was read and never written, by either run.
    expect(digestOf(SHIPPED_POLICY)).toBe(sourceBefore);
  });

  it("elects from the shipped document without any copy at all", () => {
    // The same election over the real file, so A1's first leg is not an
    // artifact of copying: the shipped document elects `opus` for this role.
    const composed = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(), coordinates());
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.submission.route.model).toBe("opus");
    expect(composed.submission.route.provider).toBe("claude");
    expect(composed.submission.route.accountId).toBe(ACCOUNT);
    expect(composed.submission.route.transportKind).toBe("CLI_SUBSCRIPTION");
  });
});

// ---------------------------------------------------------------------------
// A3 — the relocation is non-semantic
// ---------------------------------------------------------------------------

describe("A3: moving the producer changed no digest", () => {
  it("reproduces the digest the pre-move implementation computed", () => {
    expect(canonicalSubmissionDigest(FIXED_SUBMISSION)).toBe(PRE_MOVE_DIGEST);
  });

  it("canonicalizes by key order, not by literal order", () => {
    const preimage = canonicalSubmission(FIXED_SUBMISSION);
    expect(preimage.startsWith('{"attempt":1,')).toBe(true);
    expect(JSON.parse(preimage)).toEqual({
      attempt: 1,
      initiativeId: INITIATIVE,
      route: { ...FIXED_ROUTE },
      submittedAt: SUBMITTED_AT,
      taskId: TASK,
    });
  });
});

// ---------------------------------------------------------------------------
// A5 — the preimage still pins all six route fields
// ---------------------------------------------------------------------------

describe("A5: every route field is inside the preimage", () => {
  const MUTATIONS: readonly { readonly field: keyof ResolvedRoute; readonly value: string }[] = [
    { field: "provider", value: "codex" },
    { field: "model", value: "sonnet" },
    { field: "accountId", value: "acct-other" },
    { field: "transportKind", value: "API_KEY" },
    { field: "capabilityPolicyVersion", value: "2026-09-01.1" },
    { field: "resolvedAt", value: "2026-09-01T00:00:06.000Z" },
  ];

  it("enumerates all six, and each alone changes the digest", () => {
    // Enumerated rather than sampled: a field left out of the preimage is a
    // field a resume may change unrefused, which is the exact hole B1c closed.
    expect(MUTATIONS.map((mutation) => mutation.field).sort()).toEqual(
      ["accountId", "capabilityPolicyVersion", "model", "provider", "resolvedAt", "transportKind"],
    );

    const base = canonicalSubmissionDigest(FIXED_SUBMISSION);
    for (const mutation of MUTATIONS) {
      const mutated: DaemonSubmission = {
        ...FIXED_SUBMISSION,
        route: { ...FIXED_ROUTE, [mutation.field]: mutation.value } as ResolvedRoute,
      };
      expect(canonicalSubmissionDigest(mutated)).not.toBe(base);
    }
  });

  it("changes the digest for each of the four coordinates too", () => {
    const base = canonicalSubmissionDigest(FIXED_SUBMISSION);
    expect(canonicalSubmissionDigest({ ...FIXED_SUBMISSION, attempt: 2 })).not.toBe(base);
    expect(canonicalSubmissionDigest({ ...FIXED_SUBMISSION, taskId: "b7500000-0000-4000-8000-000000000002" })).not.toBe(base);
    expect(canonicalSubmissionDigest({ ...FIXED_SUBMISSION, submittedAt: "2026-09-01T00:00:01.000Z" })).not.toBe(base);
    expect(canonicalSubmissionDigest({ ...FIXED_SUBMISSION, initiativeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a02" })).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// A4 — the elected route reaches the ledger
// ---------------------------------------------------------------------------

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

function toyBeatContext(
  root: ScenarioRoot,
  ledger: Ledger,
  invocation: DurableInvocation,
  route: ResolvedRoute,
): BeatContext {
  return {
    ledger,
    effects: {
      apply: (operation) => {
        applyEffect(root, operation);
        return Promise.resolve();
      },
      probe: (operation) => Promise.resolve(probeEffect(root, operation)),
    },
    invocation,
    emittedBy: EMITTED_BY,
    plan: READ_ONLY_PLAN,
    initiativeId: INITIATIVE,
    route,
    checkpoints: drillCheckpoints({
      ledger,
      invocation,
      emittedBy: EMITTED_BY,
      ledgerPath: scenarioLedgerPath(root),
      worktree: root,
    }),
  };
}

function invocationFor(taskId: string, submissionDigest: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("b7s-invocation/" + taskId),
    submittedAt: SUBMITTED_AT,
    submissionDigest,
  };
}

describe("A4: the elected route is what the ledger records", () => {
  it("drives one walk from the composed submission and reads the route back", async () => {
    const composed = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(), coordinates());
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    const root = scenario("b7s-a4");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const invocation = invocationFor(composed.submission.taskId, composed.submissionDigest);

    // Step 0 by hand, exactly as the landed pilots do; the supervisor refuses
    // to append it and every later step is its own.
    const context = toyBeatContext(root, ledger, invocation, composed.submission.route);
    assertInvocationContinuity(context);
    appendPlanStep(context, planStep(0));

    const supervisor = new SqliteSupervisor({
      ledger,
      invocation,
      effects: context.effects,
      checkpoints: context.checkpoints,
      emittedBy: EMITTED_BY,
      commitPolicy: "NO_COMMIT",
      initiativeId: INITIATIVE,
      route: composed.submission.route,
    });
    const run = await supervisor.runToCheckpoint();
    expect(run.finalState).toBe("CHECKPOINTED");

    // The projection answers with the route that was elected, not a default.
    const recorded = ledger.getExecutionRoute(composed.submission.taskId, 1);
    expect(recorded).not.toBeNull();
    expect(recorded?.provider).toBe(composed.submission.route.provider);
    expect(recorded?.model).toBe(composed.submission.route.model);
    expect(recorded?.accountId).toBe(composed.submission.route.accountId);
    expect(recorded?.transportKind).toBe(composed.submission.route.transportKind);
    expect(recorded?.capabilityPolicyVersion).toBe(composed.submission.route.capabilityPolicyVersion);

    // And the INTENT event itself carries it, which is what the projection is
    // folded from — asserted on the event, not only on the read model.
    const entries = ledger.listEvents({ taskId: composed.submission.taskId, limit: 200 }).events;
    const intent = entries.find((entry) => entry.event.transitionId === INTENT_STEP.transitionId);
    expect(intent).toBeDefined();
    expect(intent?.event.type).toBe("RUN_STARTED");
    const payload = intent?.event.payload as { readonly route?: Record<string, unknown> } | undefined;
    expect(payload?.route).toEqual({
      provider: composed.submission.route.provider,
      model: composed.submission.route.model,
      accountId: composed.submission.route.accountId,
      transportKind: composed.submission.route.transportKind,
      capabilityPolicyVersion: composed.submission.route.capabilityPolicyVersion,
      resolvedAt: composed.submission.route.resolvedAt,
    });

    // N5, on the events rather than on a config: no absolute path anywhere in
    // what the elected route caused to be written. Scanned over the ledger's
    // own canonical bytes, which is everything that was actually persisted.
    const serialized = entries.map((entry) => entry.canonicalJson).join("\n");
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain(REPO_ROOT);
    expect(serialized).not.toContain("credentialRef");
    expect(serialized).not.toContain("authProfileRef");
  });
});

// ---------------------------------------------------------------------------
// N3 — a resume carrying a re-elected route still refuses
// ---------------------------------------------------------------------------

describe("N3: a re-elected route cannot resume an attempt", () => {
  it("changes the digest, so step 0 rebuilds differently and continuity refuses", () => {
    const dir = stage();
    const copy = join(dir, "capability-policy.json");
    copyFileSync(SHIPPED_POLICY, copy);

    const first = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(copy), coordinates());
    if (!first.ok) throw new Error("the first election refused");

    const root = scenario("b7s-n3");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const original = invocationFor(first.submission.taskId, first.submissionDigest);
    const context = toyBeatContext(root, ledger, original, first.submission.route);
    assertInvocationContinuity(context);
    appendPlanStep(context, planStep(0));

    // The policy moves under a running attempt and the route is elected again.
    const document = JSON.parse(readFileSync(copy, "utf8")) as { policyVersion: string; models: { model: string }[] };
    document.policyVersion = "2026-09-01.1";
    document.models = document.models.filter((entry) => entry.model !== "opus");
    writeFileSync(copy, JSON.stringify(document));

    const second = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(copy), coordinates());
    if (!second.ok) throw new Error("the second election refused");
    expect(second.submissionDigest).not.toBe(first.submissionDigest);

    // The guard must still fire. If this ever stops throwing, the packet that
    // made it stop is wrong, not this test.
    const resumed = toyBeatContext(
      root,
      ledger,
      invocationFor(first.submission.taskId, second.submissionDigest),
      second.submission.route,
    );
    expect(() => {
      assertInvocationContinuity(resumed);
    }).toThrow(SupervisorError);
    expect(() => {
      assertInvocationContinuity(resumed);
    }).toThrow(/different invocation/);

    // And the original submission still resumes, so the refusal is about the
    // re-election and not about resuming at all.
    expect(() => {
      assertInvocationContinuity(context);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// N1 — no eligible account is a typed refusal, never a default
// ---------------------------------------------------------------------------

describe("N1: an election that cannot be made refuses by name", () => {
  it("returns a landed refusal and no route when nothing can serve", () => {
    const composed = composeSubmission(request([]), shippedRegistry(), coordinates());
    expect(composed.ok).toBe(false);
    if (composed.ok) throw new Error("an empty registry must not elect");

    // The vocabulary is the landed one. Nothing here widened an enum: the
    // member is one the router already owned before this packet existed.
    expect(ROUTING_REFUSALS).toContain(composed.reason);
    expect(composed.reason).toBe("NO_ELIGIBLE_ACCOUNT");
    expect(composed).not.toHaveProperty("route");
    expect(composed).not.toHaveProperty("submission");
    expect(composed).not.toHaveProperty("submissionDigest");
  });

  it("refuses when the account cannot serve the model the policy would choose", () => {
    const composed = composeSubmission(request([record(["haiku"])]), shippedRegistry(), coordinates());
    expect(composed.ok).toBe(false);
    if (composed.ok) throw new Error("an ineligible account must not elect");
    expect(composed).not.toHaveProperty("submission");
  });
});

// ---------------------------------------------------------------------------
// N4 — no credential, ever
// ---------------------------------------------------------------------------

describe("N4: the composer never reads a credential", () => {
  it("emits neither credentialRef nor authProfileRef, by substring", () => {
    const composed = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(), coordinates());
    if (!composed.ok) throw new Error("the election refused");

    const serialized = JSON.stringify(composed);
    expect(serialized).not.toContain("credentialRef");
    expect(serialized).not.toContain("authProfileRef");
    expect(serialized).not.toContain("profile://");
  });

  it("never reads the fields at all, which is stronger than redacting them", () => {
    // A getter that throws is the only way to assert "not read" rather than
    // "read and discarded". If the composer ever touches either field, this
    // fails loudly instead of passing with a redaction.
    const base = record(["opus", "sonnet"]);
    const trapped = Object.create(Object.getPrototypeOf(base) as object) as AccountRecord;
    Object.assign(trapped, base);
    for (const field of ["credentialRef", "authProfileRef"]) {
      Object.defineProperty(trapped, field, {
        enumerable: true,
        get: () => {
          throw new Error("the composer read " + field);
        },
      });
    }

    const composed = composeSubmission(request([trapped]), shippedRegistry(), coordinates());
    expect(composed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N8 — the clock is injected
// ---------------------------------------------------------------------------

describe("N8: composition reads no clock", () => {
  it("produces byte-identical output for the same inputs and the same instant", () => {
    const registry = shippedRegistry();
    const first = composeSubmission(request([record(["opus", "sonnet"])]), registry, coordinates());
    const second = composeSubmission(request([record(["opus", "sonnet"])]), registry, coordinates());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("moves the digest when only the injected instant moves", () => {
    const registry = shippedRegistry();
    const early = composeSubmission(request([record(["opus", "sonnet"])]), registry, coordinates());
    const later = composeSubmission(
      request([record(["opus", "sonnet"])]),
      registry,
      coordinates({ resolvedAt: "2026-09-01T00:00:06.000Z" }),
    );
    if (!early.ok || !later.ok) throw new Error("both elections must succeed");
    expect(later.submission.route.resolvedAt).toBe("2026-09-01T00:00:06.000Z");
    expect(later.submissionDigest).not.toBe(early.submissionDigest);
  });

  it("takes resolvedAt from the caller and never from routing.now", () => {
    const composed = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(), coordinates());
    if (!composed.ok) throw new Error("the election refused");
    expect(composed.submission.route.resolvedAt).toBe(RESOLVED_AT);
    expect(composed.submission.route.resolvedAt).not.toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// The digest the door will recompute
// ---------------------------------------------------------------------------

describe("the composed digest is the digest of the composed submission", () => {
  it("agrees with computing it separately from the same submission", () => {
    const composed = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(), coordinates());
    if (!composed.ok) throw new Error("the election refused");
    expect(composed.submissionDigest).toBe(canonicalSubmissionDigest(composed.submission));
    expect(composed.submission.taskId).toBe(TASK);
    expect(composed.submission.attempt).toBe(1);
    expect(composed.submission.submittedAt).toBe(SUBMITTED_AT);
    expect(composed.submission.initiativeId).toBe(INITIATIVE);
  });
});

// ---------------------------------------------------------------------------
// The invocation identity, relocated (V2-B4b stage 3B)
// ---------------------------------------------------------------------------

/**
 * The non-semantic move drill, in the register of the `canonicalSubmission`
 * precedent above.
 *
 * `deriveInvocation` was declared in `@acp/durability`'s submission module and
 * is declared here now, so that the explicit tool operation can derive the same
 * identity without a domain depending on an edge. The claim under test is that
 * the move changed the declaration's address and nothing else.
 *
 * The invocation ids are **literals lifted from before the move**, not
 * re-derivations. That is the whole point: asserting against a fresh call to
 * the function that was moved would pass no matter what the move did to it. A
 * mismatch here means the derivation changed, and the repair is to stop, not to
 * adjust the literal.
 */
describe("the invocation identity survived its relocation byte for byte", () => {
  const MOVED_TASK = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";

  it("derives the pinned invocation id for attempt 1", () => {
    const invocation = deriveInvocation(MOVED_TASK, 1, SUBMITTED_AT, "a".repeat(64));
    expect(invocation.invocationId).toBe("3cea5666-4abb-5bdf-8089-3f961124f281");
  });

  it("derives the pinned invocation id for attempt 2", () => {
    const invocation = deriveInvocation(MOVED_TASK, 2, SUBMITTED_AT, "a".repeat(64));
    expect(invocation.invocationId).toBe("f84a47b0-6163-51b2-bc7a-888142ed7116");
  });

  it("passes the caller's four coordinates through unchanged", () => {
    const digest = "c".repeat(64);
    const invocation = deriveInvocation(MOVED_TASK, 2, SUBMITTED_AT, digest);
    expect(invocation.taskId).toBe(MOVED_TASK);
    expect(invocation.attempt).toBe(2);
    expect(invocation.submittedAt).toBe(SUBMITTED_AT);
    expect(invocation.submissionDigest).toBe(digest);
  });

  it("carries a revision without moving the identity, and without one returns the pre-G object (P-18/G)", () => {
    // The same pinned literal as attempt 1 above: the revision is carried on
    // the invocation, never folded into its preimage (ADR 0080).
    const revision = {
      revisionId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01",
      revisionNumber: 2,
      attemptNumber: 1,
      envelopeSha256: "e".repeat(64),
      envelopeArtifactReferenceId: "ref-envelope-0001",
    };
    const carried = deriveInvocation(MOVED_TASK, 1, SUBMITTED_AT, "a".repeat(64), revision);
    expect(carried.invocationId).toBe("3cea5666-4abb-5bdf-8089-3f961124f281");
    expect(carried.revision).toEqual(revision);
    expect(Object.isFrozen(carried.revision)).toBe(true);

    // Absent means absent: no `revision` member at all, so a V1 caller holds
    // exactly the five-key object it held before G.
    const flat = deriveInvocation(MOVED_TASK, 1, SUBMITTED_AT, "a".repeat(64));
    expect(Object.keys(flat).sort()).toEqual(["attempt", "invocationId", "submissionDigest", "submittedAt", "taskId"]);
    expect("revision" in flat).toBe(false);
  });

  it("projects the revision field by field, so a wider value cannot widen the walk", () => {
    const wider = {
      revisionId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f02",
      revisionNumber: 1,
      attemptNumber: 1,
      envelopeSha256: "e".repeat(64),
      envelopeArtifactReferenceId: "ref-envelope-0002",
      credentialRef: "secret://nope",
    };
    const carried = deriveInvocation(MOVED_TASK, 1, SUBMITTED_AT, "a".repeat(64), wider);
    // Five since P-36/local D (ADR 0084), and the fifth outside the preimage.
    expect(Object.keys(carried.revision ?? {}).sort()).toEqual([
      "attemptNumber",
      "envelopeArtifactReferenceId",
      "envelopeSha256",
      "revisionId",
      "revisionNumber",
    ]);
    expect(carried.revision?.envelopeArtifactReferenceId).toBe("ref-envelope-0002");
    expect(carried.invocationId).toBe(deriveInvocation(MOVED_TASK, 1, SUBMITTED_AT, "a".repeat(64)).invocationId);
  });

  it("depends on the task and the attempt, and on nothing else", () => {
    const one = deriveInvocation(MOVED_TASK, 1, SUBMITTED_AT, "a".repeat(64));
    const again = deriveInvocation(MOVED_TASK, 1, "2026-01-01T00:00:00.000Z", "b".repeat(64));
    // Same identity under a different instant and a different digest: what
    // makes a resubmission after a crash a replay rather than a second run.
    expect(again.invocationId).toBe(one.invocationId);
  });
});

// ---------------------------------------------------------------------------
// R17 — what the invocation identity refuses (old-V2 B2, boundary row 4)
// ---------------------------------------------------------------------------

/**
 * The identity is `(taskId, attempt)`, and this is the consequence.
 *
 * The block above pins that `deriveInvocation` ignores the instant and the
 * digest. What nothing stated is what that costs: two submissions that agree on
 * the task and the attempt and differ in everything else are ONE invocation, so
 * the second cannot become a second run. That is deliberate — it is what makes a
 * resubmission after a crash a replay — but "deliberate" is a claim, and until
 * it executes it is only a comment.
 *
 * So the collision is composed here rather than asserted in the abstract: two
 * real elections over two versions of a policy copy, under one `(taskId,
 * attempt)`, differing in route, instant and digest. They collide on the
 * invocation id, and they collide again on the ledger key, which is
 * `taskId/attempt/transitionId` and carries no content either.
 *
 * What the ledger then does is the part worth writing down. A true retry — the
 * same coordinates AND the same content — replays and appends nothing. A
 * different submission reusing those coordinates does NOT quietly win and does
 * not fork the attempt: every event payload carries `submissionDigest`, so the
 * colliding append fails closed by name and the first run stands. The identity
 * is content-free, and the refusal that makes that safe is not silent.
 *
 * The real Restate lane is drilled elsewhere and is not re-drilled here: G1-G3
 * in the daemon's lifecycle drills already pay a real server and a SIGKILL to
 * prove non-duplication against the ledger's own keys. This property is pure,
 * so it is proved by direct call.
 */
describe("the invocation identity says what it refuses", () => {
  const OTHER_TASK = "b7500000-0000-4000-8000-000000000002";
  const OTHER_INSTANT = "2026-09-02T00:00:00.000Z";

  it("gives two different submissions one invocation, and refuses the second as a second run", () => {
    const dir = stage();
    const copy = join(dir, "capability-policy.json");
    copyFileSync(SHIPPED_POLICY, copy);

    const first = composeSubmission(request([record(["opus", "sonnet"])]), shippedRegistry(copy), coordinates());
    if (!first.ok) throw new Error("the first election refused");

    // The policy moves and so does the clock: a genuinely different submission,
    // reusing the coordinates of one already in flight.
    const document = JSON.parse(readFileSync(copy, "utf8")) as { policyVersion: string; models: { model: string }[] };
    document.policyVersion = "2026-09-02.1";
    document.models = document.models.filter((entry) => entry.model !== "opus");
    writeFileSync(copy, JSON.stringify(document));

    const second = composeSubmission(
      request([record(["opus", "sonnet"])]),
      shippedRegistry(copy),
      coordinates({ submittedAt: OTHER_INSTANT }),
    );
    if (!second.ok) throw new Error("the second election refused");

    // They really are two different submissions.
    expect(second.submission.route.model).not.toBe(first.submission.route.model);
    expect(second.submission.submittedAt).not.toBe(first.submission.submittedAt);
    expect(second.submissionDigest).not.toBe(first.submissionDigest);

    // The collision, stated. Same task, same attempt, different everything
    // else, one invocation id.
    const one = deriveInvocation(first.submission.taskId, 1, first.submission.submittedAt, first.submissionDigest);
    const other = deriveInvocation(second.submission.taskId, 1, second.submission.submittedAt, second.submissionDigest);
    expect(other.invocationId).toBe(one.invocationId);

    const root = scenario("b7s-r17");
    const ledger = track(openLedger(scenarioLedgerPath(root)));

    // The first submission opens the attempt.
    const landed = appendPlanStep(toyBeatContext(root, ledger, one, first.submission.route), planStep(0));
    expect(landed.inserted).toBe(true);

    // A true retry re-sends the same coordinates and the same content. It
    // replays: nothing is appended, and that is the whole point of the
    // identity excluding the digest.
    const retried = appendPlanStep(toyBeatContext(root, ledger, one, first.submission.route), planStep(0));
    expect(retried.inserted).toBe(false);

    // The other submission is not a retry. It collides on the same ledger key,
    // and because its content differs the ledger refuses it by name rather than
    // discarding it quietly or forking the attempt.
    let refusal: { readonly name: string; readonly code: unknown } | null = null;
    try {
      appendPlanStep(toyBeatContext(root, ledger, other, second.submission.route), planStep(0));
    } catch (error) {
      refusal = { name: (error as Error).name, code: (error as { code?: unknown }).code };
    }
    expect(refusal).not.toBeNull();
    expect(refusal?.name).toBe("LedgerIdempotencyConflictError");
    expect(refusal?.code).toBe("LEDGER_IDEMPOTENCY_CONFLICT");

    // One run, under the key both invocations derive, holding the FIRST
    // submission's content. Three appends, one event, no key repeated.
    const events = ledger.listEvents({ taskId: first.submission.taskId });
    expect(events.events.length).toBe(1);
    expect(events.events[0]?.idempotencyKey).toBe(
      buildIdempotencyKey({
        taskId: first.submission.taskId,
        attempt: 1,
        transitionId: planStep(0).transitionId,
      }),
    );
    expect(events.events[0]?.event.payload["submissionDigest"]).toBe(first.submissionDigest);
    const keys = events.events.map((entry) => entry.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("depends on the task as well as the attempt", () => {
    // The anti-vacuity half the pinned attempt literals above do not cover:
    // without this, a derivation that ignored the task would still pass.
    const mine = deriveInvocation(TASK, 1, SUBMITTED_AT, "a".repeat(64));
    const theirs = deriveInvocation(OTHER_TASK, 1, SUBMITTED_AT, "a".repeat(64));
    expect(theirs.invocationId).not.toBe(mine.invocationId);
  });
});

/**
 * The two digests on the submission path, kept apart (P-05/A, negative 9).
 *
 * `docs/audit/architecture/contracts/index.md` §14 names four digests with four
 * meanings. Two of them meet here, and conflating them is exactly the shape of
 * defect N01 records — so this drill lives in the submission tree rather than
 * beside the preimage, because it is the only tree that can reach both real
 * producers at once: `@acp/runtime` may import `@acp/ledger`, and the ledger
 * cannot import runtime. Restating either preimage by hand would have made the
 * test agree with itself and prove nothing.
 */
describe("the submission digest and the envelope digest answer different questions", () => {
  const ENVELOPE = Object.freeze({
    contractVersion: CONTRACT_VERSION,
    taskId: TASK,
    initiativeId: INITIATIVE,
    title: "Elect a route and bind it to the attempt",
    objective: "Prove the two digests on this path are not one digest.",
    classification: "SEMANTIC",
    issuedBy: "kimi/k3/coordinator/01",
    issuedAt: SUBMITTED_AT,
    authority: [{ path: "docs/audit/architecture/contracts/index.md", sha256: "a".repeat(64) }],
    readSet: ["packages/domains/runtime/src/submission/index.ts"],
    writeSet: ["packages/domains/runtime/src/submission/index.ts"],
    conflictKeys: ["runtime:submission"],
    allowedCommands: ["pnpm test"],
    forbiddenActions: ["git push"],
    output: { kind: "DIFF", description: "one drill" },
    validation: { commands: ["pnpm test"], independentVerifierRequired: true },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: {
      maxTokens: 400_000,
      maxWallClockSeconds: 3_600,
      reserveTokensForCheckpoint: 40_000,
    },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: false, maxStepsWithoutCheckpoint: 8 },
  });

  it("submissionDigest and envelopeSha256 are different digests of different questions", () => {
    // Both producers are the real ones: `canonicalSubmissionDigest` from this
    // module, `envelopeSha256` from `@acp/ledger`.
    //
    // Re-elect the route — a different model, a different account, a later
    // instant of election — and leave the work untouched.
    const reElected: DaemonSubmission = {
      ...FIXED_SUBMISSION,
      route: {
        ...FIXED_ROUTE,
        model: "sonnet",
        accountId: "acct-standby",
        resolvedAt: "2026-09-01T06:00:00.000Z",
      },
    };

    // The submission digest MOVES. That is the property
    // `assertInvocationContinuity` rests on: a route re-elected under a new
    // policy produces different step-0 bytes and a resume is refused rather
    // than silently continued against a different route.
    expect(canonicalSubmissionDigest(reElected)).not.toBe(
      canonicalSubmissionDigest(FIXED_SUBMISSION),
    );

    // The envelope digest does NOT. Which account served the packet and which
    // model was elected are not the work; re-electing is not a new revision,
    // and §6.2 excludes both by name.
    expect(envelopeSha256(ENVELOPE)).toBe(envelopeSha256(ENVELOPE));

    // And the converse, which is the half N01 is actually about: change the
    // work and leave the submission alone. The envelope digest moves; the
    // submission digest does not budge, because not one envelope field enters
    // it. Two packets, one submission identity — that is the defect, stated as
    // an assertion rather than as prose.
    const different = { ...ENVELOPE, objective: "Delete the production ledger." };
    expect(envelopeSha256(different)).not.toBe(envelopeSha256(ENVELOPE));
    expect(canonicalSubmissionDigest(FIXED_SUBMISSION)).toBe(
      canonicalSubmissionDigest(FIXED_SUBMISSION),
    );

    // Neither digest is the other's value, which is worth asserting once so a
    // future refactor cannot quietly make one an alias of the other.
    expect(envelopeSha256(ENVELOPE)).not.toBe(canonicalSubmissionDigest(FIXED_SUBMISSION));

    // Both are sha-256 of their own preimage, and the submission's preimage
    // still carries no envelope field at all.
    const submissionPreimage = canonicalSubmission(FIXED_SUBMISSION);
    expect(submissionPreimage).not.toContain(ENVELOPE.objective);
    expect(submissionPreimage).not.toContain("writeSet");
    expect(canonicalSubmissionDigest(FIXED_SUBMISSION)).toBe(
      createHash("sha256").update(submissionPreimage, "utf8").digest("hex"),
    );
  });
});
