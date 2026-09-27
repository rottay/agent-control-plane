import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedRoute, TaskEnvelope } from "@acp/contracts";
import { CONTRACT_VERSION, buildInitiativeIdempotencyKey } from "@acp/contracts";
import {
  artifactBlobLeaseStorePath,
  canonicalJsonStringify,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLeaseStore,
  openLedger,
} from "@acp/ledger";
import type { ArtifactPlane, LeaseStore, Ledger } from "@acp/ledger";
import type { BeatContext, RecordedTask, VerificationPorts } from "@acp/runtime";
import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  appendPlanStep,
  createExecutionChain,
  deriveInvocation,
  intakeTask,
  nextStep,
  readRecordedTask,
} from "@acp/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createArbiter } from "../../src/arbiter/index.js";
import type { LeaseHold } from "../../src/arbiter/index.js";
import { createLocalAuditor } from "../../src/auditor/index.js";
import { COMMITTER_IDENTITY_LABEL, authorizeRecordedCommit, writeAuthorizedCommit } from "../../src/commit-writer/index.js";
import type { CommitAuthorizationOutcome, CommitWriteOutcome } from "../../src/commit-writer/index.js";
import { gitWriterSpawnCount } from "../../src/git-writer/index.js";
import { runVerification } from "../../src/verification-runner/index.js";

/**
 * The production caller of `authorizeCommit`, end to end through the real doors (P-17/B,
 * ADR 0127; decisions 248-250).
 *
 * No stubbed Git and no hand-planted row where a producer exists: the task is entered by
 * the real intake and walked by the real step executor; the lease is a real arbiter's
 * over a real lease store, recorded in the task stream by its own flush; the receipt is
 * the real runner's and the verdict the real local auditor's; the authorization is
 * recorded through `Ledger.append`; the effect runs real `/usr/bin/git` in a disposable
 * repository under the checkout's `.acp-local/`, created and deleted by its test. The
 * world helpers are the auditor suite's, restated (a test file cannot export helpers,
 * B-7). The canonical checkout's `.git` is digested before and after (A10).
 */

const GIT = "/usr/bin/git";
const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const DISPOSABLE = join(ROOT, ".acp-local");
const AT = "2026-09-26T12:00:00.000Z";
const REGISTRY_AT = "2026-08-01T00:00:00.000Z";
const EMITTED_BY = "claude/opus/coordinator/01";
const WRITER = "claude/opus/implementer/01";
const INITIATIVE = "44444444-4444-4444-8444-4444444444c1";
const MODEL = "claude-opus-5@2026-06-01";
const CATALOG = "catalog-commit-writer";
const IDENTITY = Object.freeze({ name: "Agent Control Plane", email: "plane@agent-control-plane.invalid" });
const TTL_MS = 10 * 60 * 1000;
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
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      /* already closed */
    }
  }
  for (const directory of directories.splice(0)) {
    spawnSync("/bin/chmod", ["-R", "u+w", directory]);
    rmSync(directory, { recursive: true, force: true });
    expect(existsSync(directory)).toBe(false);
  }
});

function disposable(prefix: string): string {
  mkdirSync(DISPOSABLE, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(DISPOSABLE, prefix)));
  directories.push(directory);
  return directory;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// A10: the canonical checkout is byte-identical before and after
// ---------------------------------------------------------------------------

function listing(directory: string, prefix = ""): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    if (lstatSync(full).isDirectory()) out.push(...listing(full, prefix + name + "/"));
    else out.push(prefix + name + " " + sha256(readFileSync(full)));
  }
  return out;
}

function canonicalDigest(): string {
  const dotGit = join(ROOT, ".git");
  const parts = ["HEAD", "index", "packed-refs"].map((name) => {
    const path = join(dotGit, name);
    return name + " " + (existsSync(path) ? sha256(readFileSync(path)) : "absent");
  });
  const objects = readdirSync(join(dotGit, "objects"))
    .filter((name) => /^[0-9a-f]{2}$/.test(name))
    .sort()
    .flatMap((name) => readdirSync(join(dotGit, "objects", name)).sort().map((object) => name + object));
  const head = spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: ROOT, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8" }).stdout;
  return sha256([...parts, ...listing(join(dotGit, "refs")), sha256(objects.join("\n")), head].join("\n"));
}

let canonicalBefore = "";
beforeAll(() => {
  canonicalBefore = canonicalDigest();
});
afterAll(() => {
  expect(canonicalDigest()).toBe(canonicalBefore);
});

// ---------------------------------------------------------------------------
// The test's own Git, and a clock every producer shares
// ---------------------------------------------------------------------------

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
  const result = spawnSync(GIT, ["-c", "core.quotePath=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    env: hermetic(repo),
    input,
    encoding: "buffer",
  });
  if (result.status !== 0) throw new Error("git " + String(args[0]) + " exited " + String(result.status));
  return result.stdout.toString("utf8");
}

/** A repository whose HEAD commits `base`; `src/a.ts` changed and `src/new.ts` added on disk. */
function writerWorktree(): string {
  const repo = disposable("acp-p17b-repo-");
  git(repo, ["init", "-q", "--object-format=sha1", "."]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  for (const [path, content] of Object.entries({ "README.md": "readme\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" })) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    const sha = git(repo, ["hash-object", "-w", "--stdin"], Buffer.from(content)).trim();
    git(repo, ["update-index", "--add", "--cacheinfo", "100644," + sha + "," + path]);
  }
  const tree = git(repo, ["write-tree"]).trim();
  const commit = git(repo, ["commit-tree", tree, "-m", "base"]).trim();
  git(repo, ["update-ref", "refs/heads/main", commit]);
  writeFileSync(join(repo, "src/a.ts"), "export const a = 10;\n");
  writeFileSync(join(repo, "src/new.ts"), "export const n = 3;\n");
  return repo;
}

interface Clock {
  t: number;
  readonly now: () => string;
}

function clock(): Clock {
  const state: Clock = {
    t: Math.floor(Date.now() / 1000) * 1000,
    now: () => {
      state.t += 1000;
      return new Date(state.t).toISOString();
    },
  };
  return state;
}

// ---------------------------------------------------------------------------
// A recorded task, through the real intake, walked to AUDITING
// ---------------------------------------------------------------------------

interface Declared {
  readonly commands?: readonly string[];
  readonly writeSet?: readonly string[];
  readonly commitPolicy?: "NO_COMMIT" | "LOCAL_COMMIT_WITH_RECEIPT";
}

interface World {
  readonly directory: string;
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  readonly task: RecordedTask;
  readonly context: BeatContext;
  readonly clock: Clock;
  readonly repo: string;
  readonly store: LeaseStore;
  readonly hold: LeaseHold;
}

function envelopeFor(taskId: string, declared: Declared): TaskEnvelope {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    initiativeId: INITIATIVE,
    title: "feat(fixture): a written change",
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
    validation: { commands: [...(declared.commands ?? ["test -f src/new.ts"])], independentVerifierRequired: true },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1_000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 10 },
    visualEvidenceRequired: false,
    commitPolicy: declared.commitPolicy ?? "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: false, maxStepsWithoutCheckpoint: 5 },
  } as unknown as TaskEnvelope;
}

function entered(declared: Declared): { directory: string; ledger: Ledger; plane: ArtifactPlane; task: RecordedTask; context: BeatContext } {
  const directory = disposable("acp-p17b-world-");
  const ledgerPath = join(directory, "control-plane.sqlite");
  const ledger = openLedger(ledgerPath);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledgerPath), { incarnationId: randomUUID(), createdAt: REGISTRY_AT });
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
    contentDigest: sha256(canonicalJsonStringify(payload)),
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
    document("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", { role: "implementer", slot: 0, provider: "claude", modelVersionId: MODEL, fallbacks: [] }),
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
  const intake = intakeTask({
    ledger,
    plane,
    request: {
      envelope: envelopeFor(taskId, declared),
      clientScope: EMITTED_BY,
      clientRequestKey: "commit-writer-" + taskId,
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
  createExecutionChain({
    ledger,
    plane,
    invocation: task.invocation,
    route: ROUTE,
    modelVersionId: MODEL,
    routingAssignmentId: null,
    catalogDocumentId: CATALOG,
    usageSource: USAGE_SOURCE,
    prompt: { promptSha256: sha256(INSTRUCTIONS), promptBytes: Buffer.byteLength(INSTRUCTIONS, "utf8") },
    emittedBy: EMITTED_BY,
    holderPid: 5151,
  }).recordIntentions(INTENT_STEP.index);
  return { directory, ledger, plane, task, context };
}

/** The ports steps 6 and 7 consume, over the rows the real runner and auditor recorded. */
function portsFor(ledger: Ledger, plane: ArtifactPlane, now: () => string): VerificationPorts {
  const receipts = (coordinate: { taskId: string; revisionNumber: number; attemptNumber: number }) =>
    ledger.listVerifications(coordinate.taskId, coordinate.revisionNumber, coordinate.attemptNumber);
  return {
    verifier: {
      recordedPass: (coordinate) => [...receipts(coordinate)].filter((row) => row.runStatus === "PASS").sort((l, r) => r.verifierRunId - l.verifierRunId)[0]?.receiptSha256 ?? null,
      latest: (coordinate) => {
        const last = [...receipts(coordinate)].sort((l, r) => r.verifierRunId - l.verifierRunId)[0];
        return last === undefined ? null : { receiptSha256: last.receiptSha256, runStatus: last.runStatus };
      },
      verify: () => Promise.reject(new Error("the fixture verifies before the step")),
    },
    auditor: createLocalAuditor({ ledger, plane, route: ROUTE, now }),
  };
}

/** A task walked to AUDITING over a real lease, a real PASS receipt and a real ACCEPT. */
async function audited(declared: Declared = {}, repo: string = writerWorktree()): Promise<World> {
  const base = entered(declared);
  const time = clock();
  const store = openLeaseStore(join(base.directory, "leases.sqlite"));
  closers.push(() => {
    store.close();
  });
  const acquisition = await createArbiter({
    store,
    ledger: base.ledger,
    invocation: base.task.invocation,
    worktreePath: repo,
    holder: WRITER,
    identity: { pid: 4242, startToken: "token-1", argvDigest: "digest-1" },
    inspector: { inspect: () => Promise.resolve({ startToken: "token-1", argvDigest: "digest-1" }) },
    ttlMs: TTL_MS,
    now: time.now,
  }).acquire();
  if (!acquisition.ok) throw new Error("the fixture could not take its lease: " + acquisition.reason);
  const scratchRoot = join(base.directory, "scratch");
  mkdirSync(scratchRoot, { mode: 0o700 });
  const verified = await runVerification({
    ledger: base.ledger,
    plane: base.plane,
    taskId: base.task.taskId,
    route: ROUTE,
    worktreePath: repo,
    scratchRoot,
    writerIdentity: WRITER,
    now: time.now,
  });
  if (!verified.ok) throw new Error("the fixture's verification was refused: " + verified.refusal);
  const context: BeatContext = { ...base.context, verification: portsFor(base.ledger, base.plane, time.now) };
  const coordinate = { taskId: base.task.taskId, revisionNumber: 1, attemptNumber: 1, attempt: base.task.attempt };
  for (;;) {
    const state = base.ledger.getTask(base.task.taskId)?.currentState ?? null;
    if (state === "AUDITING") break;
    const step = nextStep(context, state);
    if (step.eventType === "AUDIT_COMPLETED") {
      const audit = await context.verification?.auditor.audit(coordinate, verified.receiptSha256);
      if (audit?.ok !== true) throw new Error("the fixture's audit was refused");
    }
    appendPlanStep(context, step);
  }
  return { ...base, context, clock: time, repo, store, hold: acquisition.hold };
}

function inputOf(world: World) {
  return { ledger: world.ledger, plane: world.plane, taskId: world.task.taskId, route: ROUTE, repository: world.repo, identity: IDENTITY };
}

function authorize(world: World): CommitAuthorizationOutcome {
  return authorizeRecordedCommit({ ...inputOf(world), now: world.clock.now });
}

function readyToCommit(world: World): void {
  const step = LIFECYCLE_PLAN[8];
  if (step === undefined) throw new Error("the plan has a step 8");
  appendPlanStep(world.context, step);
}

function effect(world: World, fence: () => { ok: boolean; reason: string | null } = () => world.hold.renew()): CommitWriteOutcome {
  return writeAuthorizedCommit({ ...inputOf(world), fence });
}

function refOf(repo: string): string {
  return git(repo, ["rev-parse", "refs/heads/main"]).trim();
}

function typed(world: World, type: string): number {
  return world.ledger.listEvents({ taskId: world.task.taskId, type: type as never, limit: 500 }).events.length;
}

// ---------------------------------------------------------------------------

describe("E1: the full production path, through the real doors", () => {
  it("authorizes in AUDITING, writes in READY_TO_COMMIT, moves the branch, and records no COMMIT_RECORDED", async () => {
    const world = await audited();
    const [receiptRow] = world.ledger.listVerifications(world.task.taskId, 1, 1);
    if (receiptRow === undefined) throw new Error("the fixture has a receipt");
    const base = refOf(world.repo);

    const authorization = authorize(world);
    if (!authorization.ok) throw new Error("expected an authorization: " + authorization.refusal + " " + String(authorization.word) + " at " + authorization.at);
    expect(authorization).toMatchObject({ receiptSha256: receiptRow.receiptSha256, replayed: false });
    const row = world.ledger.getCommitAuthorization(world.task.taskId, receiptRow.receiptSha256);
    expect(row).toMatchObject({ state: "INTENDED", authorizedAt: authorization.authorizedAt, commitSha: null });
    const recorded = world.ledger.listEvents({ taskId: world.task.taskId, type: "COMMIT_AUTHORIZED", limit: 10 }).events;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.event).toMatchObject({ recordedAt: authorization.authorizedAt, emittedBy: COMMITTER_IDENTITY_LABEL, fromState: "AUDITING", toState: "AUDITING" });

    readyToCommit(world);
    expect(world.ledger.getTask(world.task.taskId)?.currentState).toBe("READY_TO_COMMIT");
    const leasesBefore = typed(world, "LEASE_ACQUIRED");
    const outcome = effect(world);
    if (!outcome.ok) throw new Error("expected a commit: " + outcome.refusal + " " + String(outcome.word) + " at " + outcome.at);
    expect(outcome).toMatchObject({ baseSha: receiptRow.baseSha, treeSha: receiptRow.treeSha, ref: "refs/heads/main", receiptSha256: receiptRow.receiptSha256 });
    expect(refOf(world.repo)).toBe(outcome.commitSha);
    expect(outcome.commitSha).not.toBe(base);
    const body = git(world.repo, ["cat-file", "commit", outcome.commitSha]);
    const seconds = Math.floor(Date.parse(authorization.authorizedAt) / 1000);
    expect(body).toContain("tree " + receiptRow.treeSha + "\nparent " + receiptRow.baseSha + "\n");
    expect(body).toContain("author Agent Control Plane <plane@agent-control-plane.invalid> " + String(seconds) + " +0000\n");
    expect(body).toContain("\n\nfeat(fixture): a written change\n\nACP-Receipt: " + receiptRow.receiptSha256 + "\n");
    expect(sha256(body.slice(body.indexOf("\n\n") + 2))).toBe(row?.commitMessageSha256);

    // The row never moves, the task stays, nothing claims the commit is recorded (P-17/C's).
    expect(world.ledger.getCommitAuthorization(world.task.taskId, receiptRow.receiptSha256)?.state).toBe("INTENDED");
    expect(world.ledger.getTask(world.task.taskId)?.currentState).toBe("READY_TO_COMMIT");
    expect(typed(world, "COMMIT_RECORDED")).toBe(0);
    // N-7: the fence check was a renewal, recorded through the arbiter's own queue.
    expect(typed(world, "LEASE_ACQUIRED")).toBe(leasesBefore + 1);
    expect(world.ledger.verifyIntegrity().problems).toEqual([]);
  });
});

describe("B4, N16: state gating and replay", () => {
  it("each half runs in its one state; a replayed authorization keeps its first row; a second effect finds the base moved", async () => {
    const world = await audited();
    expect(effect(world)).toMatchObject({ ok: false, refusal: "GIT_WRITER_TASK_STATE", word: "AUDITING" });
    const first = authorize(world);
    const again = authorize(world);
    if (!first.ok || !again.ok) throw new Error("expected both authorizations to stand");
    expect(again).toEqual({ ok: true, receiptSha256: first.receiptSha256, authorizedAt: first.authorizedAt, replayed: true });
    expect(typed(world, "COMMIT_AUTHORIZED")).toBe(1);
    readyToCommit(world);
    expect(authorize(world)).toMatchObject({ ok: false, refusal: "GIT_WRITER_TASK_STATE", word: "READY_TO_COMMIT" });
    const done = effect(world);
    expect(done.ok).toBe(true);
    const moved = refOf(world.repo);
    const before = gitWriterSpawnCount();
    expect(effect(world)).toMatchObject({ ok: false, refusal: "GIT_WRITER_NOT_IN_FORCE", word: "REVALIDATED_BASE_MISMATCH" });
    expect(gitWriterSpawnCount()).toBe(before);
    expect(refOf(world.repo)).toBe(moved);
  });
});

describe("N9, N15: the authorization refuses by the existing word, and records nothing", () => {
  it("a NO_COMMIT task, a FAIL receipt and a divergent observation", async () => {
    const readOnly = await audited({ commitPolicy: "NO_COMMIT" });
    expect(authorize(readOnly)).toMatchObject({ ok: false, refusal: "GIT_WRITER_AUTHORIZATION_REFUSED", word: "COMMIT_POLICY_NO_COMMIT" });
    expect(typed(readOnly, "COMMIT_AUTHORIZED")).toBe(0);

    // A later FAIL receipt is the coordinate's last: its checks are refused by authorizeCommit.
    const failing = await audited({ commands: ["test ! -e ../../fail-now"] });
    const scratchRoot = join(failing.directory, "scratch");
    // The check runs in <scratch>/acp-verify-<id>/tree, so ../../fail-now is the scratch root's.
    writeFileSync(join(scratchRoot, "fail-now"), "");
    const fail = await runVerification({ ledger: failing.ledger, plane: failing.plane, taskId: failing.task.taskId, route: ROUTE, worktreePath: failing.repo, scratchRoot, writerIdentity: WRITER, now: failing.clock.now });
    expect(fail).toMatchObject({ ok: true, runStatus: "FAIL" });
    expect(authorize(failing)).toMatchObject({ ok: false, refusal: "GIT_WRITER_AUTHORIZATION_REFUSED", word: "CHECK_FAILED" });
    expect(typed(failing, "COMMIT_AUTHORIZED")).toBe(0);

    // N15: an untracked path inside the write-set that the receipt did not observe.
    const extra = await audited({ writeSet: ["src/a.ts", "src/new.ts", "src/extra.ts"] });
    writeFileSync(join(extra.repo, "src/extra.ts"), "export const x = 1;\n");
    // The receipt's name does not cover observed paths, so the caller holds them member by member.
    expect(authorize(extra)).toMatchObject({ ok: false, refusal: "GIT_WRITER_RECEIPT_MISMATCH", at: "observation" });
    expect(typed(extra, "COMMIT_AUTHORIZED")).toBe(0);
  });

  it("ND-ID: a personal identity is refused before anything is read or recorded", async () => {
    const world = await audited();
    expect(authorizeRecordedCommit({ ...inputOf(world), identity: { name: "Personal", email: "me@real.example" }, now: world.clock.now })).toMatchObject({
      refusal: "GIT_WRITER_IDENTITY_INVALID",
      at: "identity.email",
    });
    expect(typed(world, "COMMIT_AUTHORIZED")).toBe(0);
  });
});

describe("N9, N10, N11: the effect holds the authorization in force before any write", () => {
  async function authorizedAndReady(): Promise<World> {
    const world = await audited();
    const authorization = authorize(world);
    if (!authorization.ok) throw new Error("expected an authorization: " + authorization.refusal + " " + String(authorization.word) + " at " + authorization.at);
    readyToCommit(world);
    return world;
  }

  it("N10: HEAD advanced after the authorization is REVALIDATED_BASE_MISMATCH, with zero write spawns", async () => {
    const world = await authorizedAndReady();
    const advanced = git(world.repo, ["commit-tree", git(world.repo, ["write-tree"]).trim(), "-p", refOf(world.repo), "-m", "moved"]).trim();
    git(world.repo, ["update-ref", "refs/heads/main", advanced]);
    const before = gitWriterSpawnCount();
    expect(effect(world)).toMatchObject({ ok: false, refusal: "GIT_WRITER_NOT_IN_FORCE", at: "baseSha", word: "REVALIDATED_BASE_MISMATCH" });
    expect(gitWriterSpawnCount()).toBe(before);
    expect(refOf(world.repo)).toBe(advanced);
  });

  it("N11: a write-set file edited after the verification is REVALIDATED_TREE_MISMATCH, with zero write spawns", async () => {
    const world = await authorizedAndReady();
    writeFileSync(join(world.repo, "src/a.ts"), "export const a = 11;\n");
    const base = refOf(world.repo);
    const before = gitWriterSpawnCount();
    expect(effect(world)).toMatchObject({ ok: false, refusal: "GIT_WRITER_NOT_IN_FORCE", at: "treeSha", word: "REVALIDATED_TREE_MISMATCH" });
    expect(gitWriterSpawnCount()).toBe(before);
    expect(refOf(world.repo)).toBe(base);
  });

  it("N9: a later receipt supersedes the authorization; the effect finds no row in force", async () => {
    const world = await authorizedAndReady();
    const scratchRoot = join(world.directory, "scratch");
    const again = await runVerification({ ledger: world.ledger, plane: world.plane, taskId: world.task.taskId, route: ROUTE, worktreePath: world.repo, scratchRoot, writerIdentity: WRITER, now: world.clock.now });
    expect(again).toMatchObject({ ok: true, runStatus: "PASS" });
    const before = gitWriterSpawnCount();
    expect(effect(world)).toMatchObject({ ok: false, refusal: "GIT_WRITER_NOT_IN_FORCE", at: "state", word: "AUTHORIZATION_STATE_INVALID" });
    expect(gitWriterSpawnCount()).toBe(before);
  });
});

describe("N13, N14, B2: the fence token at update-ref (ND-9: a lapsed lease holds no valid token)", () => {
  async function authorizedAndReady(): Promise<World> {
    const world = await audited();
    const authorization = authorize(world);
    if (!authorization.ok) throw new Error("expected an authorization: " + authorization.refusal + " " + String(authorization.word) + " at " + authorization.at);
    readyToCommit(world);
    return world;
  }

  function fenced(world: World, word: string): void {
    const base = refOf(world.repo);
    const before = gitWriterSpawnCount();
    expect(effect(world)).toEqual({ ok: false, refusal: "GIT_WRITER_FENCE_REFUSED", at: "fence", word });
    // The objects and the commit object were written; the ref was not moved.
    expect(gitWriterSpawnCount()).toBeGreaterThan(before);
    expect(refOf(world.repo)).toBe(base);
  }

  it("N13: a revocation between the authorization and the effect bumps the fence: LEASE_FENCE_LOST", async () => {
    const world = await authorizedAndReady();
    world.store.transact(world.repo, () => ({ verb: "REVOKE", at: world.clock.now(), operationId: randomUUID() }));
    fenced(world, "LEASE_FENCE_LOST");
  });

  it("N14 (i), B2: a lapsed, unreassigned, unswept lease is LEASE_EXPIRED, equality included", async () => {
    const world = await authorizedAndReady();
    const expiresAt = world.store.read(world.repo)?.expiresAt ?? "";
    world.clock.t = Date.parse(expiresAt) - 1000;
    fenced(world, "LEASE_EXPIRED");
  });

  it("N14 (ii): the same lease after a sweep, which moves no fence, is a lost hold: LEASE_FENCE_LOST", async () => {
    const world = await authorizedAndReady();
    world.clock.t += 2 * TTL_MS;
    world.store.sweep(world.clock.now());
    fenced(world, "LEASE_FENCE_LOST");
  });

  it("N14 (iii): a successor granted after the lapse is LEASE_FENCE_LOST", async () => {
    const world = await authorizedAndReady();
    world.clock.t += 2 * TTL_MS;
    // Another task's walk takes the worktree: its lease events ride its own task, not this one.
    const successor = await createArbiter({
      store: world.store,
      ledger: world.ledger,
      invocation: deriveInvocation(randomUUID(), 1, AT, "e".repeat(64)),
      worktreePath: world.repo,
      holder: "claude/opus/implementer/02",
      identity: { pid: 5252, startToken: "token-2", argvDigest: "digest-2" },
      inspector: { inspect: () => Promise.resolve(null) },
      ttlMs: TTL_MS,
      now: world.clock.now,
    }).acquire();
    expect(successor.ok).toBe(true);
    fenced(world, "LEASE_FENCE_LOST");
  });
});
