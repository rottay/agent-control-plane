import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ResolvedRoute, TaskEnvelope } from "@acp/contracts";
import { AuditEvidence, CONTRACT_VERSION, buildInitiativeIdempotencyKey } from "@acp/contracts";
import {
  artifactBlobLeaseStorePath,
  canonicalJsonStringify,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  supervisedWorkerIdFor,
} from "@acp/ledger";
import type { ArtifactPlane, Ledger } from "@acp/ledger";
import type { BeatContext, RecordedTask } from "@acp/runtime";
import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  appendPlanStep,
  createExecutionChain,
  intakeTask,
  nextStep,
  readRecordedTask,
  settleCancellation,
} from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { AUDITOR_IDENTITY, AUDITOR_REFUSALS, createLocalAuditor } from "../../src/auditor/index.js";
import { runVerification } from "../../src/verification-runner/index.js";
import type { VerificationRunInput, VerificationRunOutcome } from "../../src/verification-runner/index.js";

/**
 * The deterministic local auditor (P-16/D1, ADR 0124; decision 239; ND-6..ND-8).
 *
 * Every audit here runs over a receipt the real runner recorded through the real door,
 * in a disposable sha1 repository, and records its verdict through the same door: the
 * auditor's registry ids, its evidence bytes and its rules are judged by the ledger,
 * never by this suite alone. The recorded walk that asks it between steps 6 and 7 is
 * drilled by the composition's and the daemon's suites. The world helpers are the
 * runner suite's, restated (a test file cannot export helpers).
 */

const GIT = "/usr/bin/git";
const AT = "2026-09-26T12:00:00.000Z";
const REGISTRY_AT = "2026-08-01T00:00:00.000Z";
const EMITTED_BY = "claude/opus/coordinator/01";
const WRITER = "claude/opus/implementer/01";
const INITIATIVE = "44444444-4444-4444-8444-4444444444c0";
const MODEL = "claude-opus-5@2026-06-01";
const CATALOG = "catalog-verify-c";
const ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "claude-opus-5",
  accountId: "acct-verify",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: AT,
};
const USAGE_SOURCE = {
  source: "claude-cli",
  sourceClass: "PROVIDER_AUTHORITATIVE" as const,
  normalizationPolicySha256: "14cbb2a397762bfc4cfec2d00073bc26402d7c81123a2a8683fc007fa808fb0d",
};
const INSTRUCTIONS = "verify the declared change";

const directories: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const directory of directories.splice(0)) {
    spawnSync("/bin/chmod", ["-R", "u+w", directory]);
    rmSync(directory, { recursive: true, force: true });
  }
});


function scratch(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

function hermetic(home: string): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "acp-fixture",
    GIT_AUTHOR_EMAIL: "fixture@invalid",
    GIT_COMMITTER_NAME: "acp-fixture",
    GIT_COMMITTER_EMAIL: "fixture@invalid",
    GIT_AUTHOR_DATE: "2026-09-26T12:00:00Z",
    GIT_COMMITTER_DATE: "2026-09-26T12:00:00Z",
  };
}

function git(repo: string, args: readonly string[], input?: Buffer): string {
  const result = spawnSync(GIT, ["-c", "core.quotePath=false", ...args], { cwd: repo, env: hermetic(repo), input, encoding: "buffer" });
  if (result.status !== 0) throw new Error("git " + String(args[0]) + " exited " + String(result.status));
  return result.stdout.toString("utf8");
}

/**
 * A repository whose HEAD commits `base` (path -> content), with the same files on
 * disk, so it observes clean. `format` sha256 builds P-38's format; `commit: false`
 * leaves HEAD unborn.
 */
function repository(base: Readonly<Record<string, string>>, options: { format?: "sha1" | "sha256"; commit?: boolean } = {}): string {
  const repo = scratch("acp-p16c-repo-");
  git(repo, ["init", "-q", "--object-format=" + (options.format ?? "sha1"), "."]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  for (const [path, content] of Object.entries(base)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    const sha = git(repo, ["hash-object", "-w", "--stdin"], Buffer.from(content)).trim();
    git(repo, ["update-index", "--add", "--cacheinfo", "100644," + sha + "," + path]);
  }
  if (options.commit !== false) {
    const tree = git(repo, ["write-tree"]).trim();
    const commit = git(repo, ["commit-tree", tree, "-m", "base"]).trim();
    git(repo, ["update-ref", "refs/heads/main", commit]);
  }
  return repo;
}

// ---------------------------------------------------------------------------
// A recorded task, through the real intake
// ---------------------------------------------------------------------------

interface World {
  readonly directory: string;
  readonly ledgerPath: string;
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  readonly task: RecordedTask;
  readonly envelope: TaskEnvelope;
  /** The walk's context over this task, for a test that settles it. */
  readonly context: BeatContext;
}

interface Declared {
  readonly commands: readonly string[];
  readonly writeSet?: readonly string[];
  readonly title?: string;
  readonly commitPolicy?: "NO_COMMIT" | "LOCAL_COMMIT_WITH_RECEIPT";
  /** Record the attempt's route segment (default); false leaves the attempt with none. */
  readonly segment?: boolean;
}

function envelopeFor(taskId: string, declared: Declared): TaskEnvelope {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    initiativeId: INITIATIVE,
    title: declared.title ?? "feat(fixture): a verified change",
    content: {
      contentContractVersion: 1,
      blocks: [
        {
          kind: "text",
          blockId: "b1",
          mediaType: "text/plain; charset=utf-8",
          byteLength: Buffer.byteLength(INSTRUCTIONS, "utf8"),
          contentSha256: "0".repeat(64),
          artifactRefId: null,
          text: INSTRUCTIONS,
          toolCallId: null,
          effectId: null,
        },
      ],
    },
    classification: "MECHANICAL",
    issuedBy: EMITTED_BY,
    issuedAt: AT,
    authority: [],
    readSet: [],
    writeSet: [...(declared.writeSet ?? ["src/a.ts", "src/new.ts"])],
    conflictKeys: [],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "a patch" },
    validation: { commands: [...declared.commands], independentVerifierRequired: true },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1_000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 10 },
    visualEvidenceRequired: false,
    commitPolicy: declared.commitPolicy ?? "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: false, maxStepsWithoutCheckpoint: 5 },
  } as unknown as TaskEnvelope;
}

function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function recordedWorld(declared: Declared): World {
  const directory = scratch("acp-p16c-world-");
  const ledgerPath = join(directory, "control-plane.sqlite");
  const ledger = openLedger(ledgerPath);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledgerPath), {
    incarnationId: randomUUID(),
    createdAt: REGISTRY_AT,
  });
  const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath });
  closers.push(() => {
    leaseStore.close();
    if (!ledger.closed) ledger.close();
  });
  ledger.appendInitiativeEvent({
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    initiativeId: INITIATIVE,
    transitionId: "initiative.registered",
    idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId: INITIATIVE, transitionId: "initiative.registered" }),
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: EMITTED_BY,
    occurredAt: REGISTRY_AT,
    recordedAt: REGISTRY_AT,
    payload: {},
  });
  const document = (documentKind: string, documentId: string, payload: Record<string, unknown>): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    idempotencyKey: documentId + "/1",
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    contentDigest: digestOf(canonicalJsonStringify(payload)),
    recordedBy: "claude/opus/coordinator/01",
    effectiveFrom: REGISTRY_AT,
    occurredAt: REGISTRY_AT,
    recordedAt: REGISTRY_AT,
    payload,
  });
  ledger.appendRegistryEvent(
    document("MODEL_VERSION", MODEL, {
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
  ledger.appendRegistryEvent(
    document("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", {
      role: "implementer",
      slot: 0,
      provider: "claude",
      modelVersionId: MODEL,
      fallbacks: [],
    }),
  );
  ledger.appendRegistryEvent(
    document("PRICE_TABLE", CATALOG, {
      intervals: [
        {
          provider: "claude",
          modelVersionId: MODEL,
          transportKind: "CLI_SUBSCRIPTION",
          tokenClass: "output",
          currency: "USD",
          effectiveFrom: REGISTRY_AT,
          effectiveTo: null,
          pricePerMillionNanos: 75_000_000_000,
        },
      ],
    }),
  );
  const taskId = randomUUID();
  const envelope = envelopeFor(taskId, declared);
  const intake = intakeTask({
    ledger,
    plane,
    request: {
      envelope,
      clientScope: EMITTED_BY,
      clientRequestKey: "verify-c-" + taskId,
      roadmapVersionId: null,
      stepId: null,
      role: "implementer",
      slot: 0,
      transportKind: "CLI_SUBSCRIPTION",
      recordedBy: EMITTED_BY,
    },
    recordedAt: AT,
    holderPid: 5151,
    identities: {
      eventId: randomUUID(),
      revisionId: randomUUID(),
      commandId: randomUUID(),
      artifactPinId: randomUUID(),
      artifactReferenceId: randomUUID(),
      intentionEventId: randomUUID(),
      terminalEventId: randomUUID(),
    },
  });
  if (!intake.ok) throw new Error("the fixture's intake was refused: " + intake.reason);
  const read = readRecordedTask({ ledger, plane, taskId, route: ROUTE });
  if (!read.ok) throw new Error("the fixture's task could not be read back: " + read.refusal);
  const task = read.task;

  // The walk's own navigation opens the attempt; runtime's chain records its segment.
  const context: BeatContext = {
    ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("NOT_DONE" as const) },
    invocation: task.invocation,
    emittedBy: EMITTED_BY,
    initiativeId: task.initiativeId,
    plan: LIFECYCLE_PLAN,
    route: ROUTE,
  };
  for (;;) {
    const step = nextStep(context, ledger.getTask(taskId)?.currentState ?? null);
    appendPlanStep(context, step);
    if (step.index === INTENT_STEP.index) break;
  }
  if (declared.segment !== false) {
    createExecutionChain({
      ledger,
      plane,
      invocation: task.invocation,
      route: ROUTE,
      modelVersionId: MODEL,
      routingAssignmentId: null,
      catalogDocumentId: CATALOG,
      usageSource: USAGE_SOURCE,
      prompt: { promptSha256: digestOf(INSTRUCTIONS), promptBytes: Buffer.byteLength(INSTRUCTIONS, "utf8") },
      emittedBy: EMITTED_BY,
      holderPid: 5151,
    }).recordIntentions(INTENT_STEP.index);
  }
  return { directory, ledgerPath, ledger, plane, task, envelope, context };
}

/** The writer's worktree for the default write-set: `src/a.ts` changed, `src/new.ts` added. */
function writerWorktree(): string {
  const repo = repository({ "README.md": "readme\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
  writeFileSync(join(repo, "src/a.ts"), "export const a = 10;\n");
  writeFileSync(join(repo, "src/new.ts"), "export const n = 3;\n");
  return repo;
}

function scratchRoot(world: World): string {
  const root = join(world.directory, "scratch");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function inputFor(world: World, worktreePath: string, overrides: Partial<VerificationRunInput> = {}): VerificationRunInput {
  return {
    ledger: world.ledger,
    plane: world.plane,
    taskId: world.task.taskId,
    route: ROUTE,
    worktreePath,
    scratchRoot: overrides.scratchRoot ?? scratchRoot(world),
    writerIdentity: WRITER,
    ...overrides,
  };
}

function recorded(outcome: VerificationRunOutcome): Extract<VerificationRunOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error("expected a record, and the run was refused " + outcome.refusal + " at " + outcome.at + " (" + String(outcome.word) + ")");
  return outcome;
}

/** The coordinate the phase names for this world's task. */
function coordinateOf(world: World): { taskId: string; revisionNumber: number; attemptNumber: number; attempt: number } {
  return { taskId: world.task.taskId, revisionNumber: 1, attemptNumber: 1, attempt: world.task.attempt };
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A PASS receipt the real runner recorded over `repo`. */
async function passed(world: World, repo: string = writerWorktree()): Promise<string> {
  const outcome = recorded(await runVerification(inputFor(world, repo)));
  expect(outcome.runStatus).toBe("PASS");
  return outcome.receiptSha256;
}

describe("the vocabulary and the label (ND-8)", () => {
  it("is one sorted, repeat-free list, and the label is a reviewer's worker identity no writer or verifier holds", () => {
    expect([...AUDITOR_REFUSALS]).toEqual([...AUDITOR_REFUSALS].sort());
    expect(new Set(AUDITOR_REFUSALS).size).toBe(AUDITOR_REFUSALS.length);
    expect(AUDITOR_IDENTITY).toBe("acp/deterministic-auditor/reviewer/01");
    expect(AUDITOR_IDENTITY).not.toBe(WRITER);
    expect(AUDITOR_IDENTITY).not.toBe("acp/verification-runner/verifier/01");
  });
});

describe("P5, B1: an audit is a verdict through the real door, with its evidence", () => {
  it("P5: a runner PASS receipt is ACCEPT; its row, its registry ids and its evidence bytes are the door's", async () => {
    const world = recordedWorld({ commands: ["test -f src/new.ts"] });
    const receiptSha256 = await passed(world);
    const auditor = createLocalAuditor({ ledger: world.ledger, plane: world.plane, route: ROUTE });
    const coordinate = coordinateOf(world);
    expect(auditor.recordedAccept(coordinate, receiptSha256)).toBeNull();
    expect(auditor.latest(coordinate, receiptSha256)).toBeNull();

    const outcome = await auditor.audit(coordinate, receiptSha256);
    expect(outcome).toMatchObject({ ok: true, verdict: "ACCEPT" });
    if (!outcome.ok) return;
    const receipt = world.ledger.getVerification(receiptSha256);
    const [row] = world.ledger.listAuditVerdicts(receiptSha256);
    expect(row).toMatchObject({
      auditId: outcome.auditId,
      taskId: world.task.taskId,
      treeSha: receipt?.treeSha,
      writerWorkerId: receipt?.writerWorkerId,
      auditorIdentity: AUDITOR_IDENTITY,
      auditorWorkerId: supervisedWorkerIdFor(world.task.taskId, world.task.attempt, "reviewer", 1),
      auditorRunId: 1,
      verdict: "ACCEPT",
    });
    expect(auditor.recordedAccept(coordinate, receiptSha256)).toBe(outcome.auditId);
    expect(auditor.latest(coordinate, receiptSha256)).toEqual({ auditId: outcome.auditId, verdict: "ACCEPT" });

    // The evidence: an EVIDENCE of this task, PERMANENT, canonical AuditEvidence bytes whose digest is the row's.
    const reference = world.ledger.getArtifactReference(row?.artifactReferenceId ?? "");
    expect(reference).toMatchObject({ artifactClass: "EVIDENCE", scopeKind: "TASK", scopeId: world.task.taskId, retentionClass: "PERMANENT", expiresAt: null });
    const read = world.plane.read({ artifactReferenceId: row?.artifactReferenceId ?? "", scopeKind: "TASK", scopeId: world.task.taskId });
    expect(read.verb).toBe("READ");
    if (read.verb !== "READ") return;
    expect(sha256Of(read.content)).toBe(row?.evidenceSha256);
    const evidence = AuditEvidence.parse(JSON.parse(read.content.toString("utf8")));
    expect(canonicalJsonStringify(evidence)).toBe(read.content.toString("utf8"));
    expect(evidence).toMatchObject({
      receiptSha256,
      treeSha: receipt?.treeSha,
      auditor: { identity: AUDITOR_IDENTITY, workerId: row?.auditorWorkerId, runId: 1 },
      verdict: "ACCEPT",
    });
    expect(evidence.rules).toEqual(
      ["CHANGES_WITHIN_WRITE_SET", "DIFF_PRESENT_FOR_COMMIT", "INDEPENDENT_IDS", "POLICY_MATCHES_ENVELOPE", "RECEIPT_BYTES_MATCH", "RECEIPT_PASS"].map(
        (rule) => ({ rule, outcome: "PASS" }),
      ),
    );
    // The verdict event is a fact recorded in place, under its run's transition.
    const event = world.ledger.listEvents({ taskId: world.task.taskId, limit: 200 }).events.find((entry) => entry.event.eventId === outcome.auditId)?.event;
    expect([event?.transitionId, event?.fromState === event?.toState, event?.emittedBy]).toEqual(["audit.run.1", true, AUDITOR_IDENTITY]);
    world.ledger.rebuildReadModel();
    expect(world.ledger.listAuditVerdicts(receiptSha256)).toEqual([row]);
    expect(world.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("B1: a second audit is run 2 with its own id, and a verdict on a second receipt takes the coordinate's next reviewer ordinal", async () => {
    const world = recordedWorld({ commands: ["exit 0"] });
    const repo = writerWorktree();
    const first = await passed(world, repo);
    const auditor = createLocalAuditor({ ledger: world.ledger, plane: world.plane, route: ROUTE });
    const coordinate = coordinateOf(world);
    const one = await auditor.audit(coordinate, first);
    const two = await auditor.audit(coordinate, first);
    expect([one.ok, two.ok]).toEqual([true, true]);
    const second = await passed(world, repo);
    expect(second).not.toBe(first);
    const three = await auditor.audit(coordinate, second);
    expect(three.ok).toBe(true);
    const ids = [...world.ledger.listAuditVerdicts(first), ...world.ledger.listAuditVerdicts(second)].map((row) => [
      row.auditorRunId,
      row.auditorWorkerId,
    ]);
    expect(ids).toEqual(
      [1, 2, 3].map((runId) => [runId, supervisedWorkerIdFor(world.task.taskId, world.task.attempt, "reviewer", runId)]),
    );
    // The largest-run ACCEPT on each receipt is the one the phase names.
    expect(auditor.recordedAccept(coordinate, first)).toBe(two.ok ? two.auditId : null);
  });
});

describe("N3, the rules: a writer that changed nothing is REJECT under a commit policy, vacuous without one", () => {
  it("DIFF_PRESENT_FOR_COMMIT fails on a clean tree under LOCAL_COMMIT_WITH_RECEIPT, and the verdict row is REJECT", async () => {
    const world = recordedWorld({ commands: ["exit 0"] });
    const clean = repository({ "src/a.ts": "export const a = 1;\n" });
    const receiptSha256 = await passed(world, clean);
    const auditor = createLocalAuditor({ ledger: world.ledger, plane: world.plane, route: ROUTE });
    const outcome = await auditor.audit(coordinateOf(world), receiptSha256);
    expect(outcome).toMatchObject({ ok: true, verdict: "REJECT" });
    const [row] = world.ledger.listAuditVerdicts(receiptSha256);
    expect(row?.verdict).toBe("REJECT");
    const read = world.plane.read({ artifactReferenceId: row?.artifactReferenceId ?? "", scopeKind: "TASK", scopeId: world.task.taskId });
    if (read.verb !== "READ") throw new Error("expected the evidence to read back");
    const evidence = AuditEvidence.parse(JSON.parse(read.content.toString("utf8")));
    expect(evidence.rules.filter((rule) => rule.outcome === "FAIL").map((rule) => rule.rule)).toEqual(["DIFF_PRESENT_FOR_COMMIT"]);
    expect(auditor.recordedAccept(coordinateOf(world), receiptSha256)).toBeNull();
    expect(auditor.latest(coordinateOf(world), receiptSha256)?.verdict).toBe("REJECT");
  });

  it("the same clean tree under NO_COMMIT is ACCEPT: the rule is vacuous there", async () => {
    const world = recordedWorld({ commands: ["exit 0"], commitPolicy: "NO_COMMIT" });
    const clean = repository({ "src/a.ts": "export const a = 1;\n" });
    const receiptSha256 = await passed(world, clean);
    const outcome = await createLocalAuditor({ ledger: world.ledger, plane: world.plane, route: ROUTE }).audit(coordinateOf(world), receiptSha256);
    expect(outcome).toMatchObject({ ok: true, verdict: "ACCEPT" });
  });
});

describe("N14: refused by name, and no verdict appended", () => {
  it("an unknown receipt, another coordinate's, a FAIL receipt, a terminal task and an unreadable plane", async () => {
    const world = recordedWorld({ commands: ["exit 0"] });
    const auditor = createLocalAuditor({ ledger: world.ledger, plane: world.plane, route: ROUTE });
    const coordinate = coordinateOf(world);
    const count = (): number => world.ledger.listEvents({ taskId: world.task.taskId, limit: 500 }).events.filter((entry) => entry.event.type === "AUDIT_COMPLETED").length;

    expect(await auditor.audit(coordinate, "f".repeat(64))).toMatchObject({ ok: false, refusal: "AUDITOR_RECEIPT_UNKNOWN", at: "receiptSha256" });
    const receiptSha256 = await passed(world);
    expect(await auditor.audit({ ...coordinate, attemptNumber: 2 }, receiptSha256)).toMatchObject({ ok: false, refusal: "AUDITOR_RECEIPT_UNKNOWN" });

    const failing = recordedWorld({ commands: ["exit 3"] });
    const fail = recorded(await runVerification(inputFor(failing, writerWorktree())));
    expect(fail.runStatus).toBe("FAIL");
    const failingAuditor = createLocalAuditor({ ledger: failing.ledger, plane: failing.plane, route: ROUTE });
    expect(await failingAuditor.audit(coordinateOf(failing), fail.receiptSha256)).toMatchObject({ ok: false, refusal: "AUDITOR_RECEIPT_NOT_PASS" });

    // A route the intake did not resolve: the task reader refuses, carried by name.
    const foreign = createLocalAuditor({ ledger: world.ledger, plane: world.plane, route: { ...ROUTE, model: "claude-sonnet-5" } });
    expect(await foreign.audit(coordinate, receiptSha256)).toMatchObject({ ok: false, refusal: "AUDITOR_TASK_UNREADABLE" });

    await settleCancellation(world.context);
    expect(await auditor.audit(coordinate, receiptSha256)).toMatchObject({ ok: false, refusal: "AUDITOR_TASK_TERMINAL", at: "task.currentState" });
    expect(count()).toBe(0);
  });
});
