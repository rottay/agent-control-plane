import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { ResolvedRoute, TaskEnvelope } from "@acp/contracts";
import { CONTRACT_VERSION, ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1, buildInitiativeIdempotencyKey } from "@acp/contracts";
import {
  ARTIFACT_ACCESS_POLICY_IDS,
  GENESIS_SHA256,
  artifactBlobLeaseStorePath,
  canonicalJsonStringify,
  chainDigest,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  supervisedWorkerIdFor,
  verificationPolicySha256,
  writerWorkerIdFor,
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  RUNNER_BOUNDS,
  RUNNER_REFUSALS,
  VERIFIER_IDENTITY,
  checkExitCode,
  runVerification,
} from "../../src/verification-runner/index.js";
import type { VerificationRunInput, VerificationRunOutcome } from "../../src/verification-runner/index.js";

/**
 * The verification runner (P-16/C, ADR 0123; decisions 234-236), through the real door.
 *
 * Every run here is end to end: a real on-disk ledger and its private plane, a task
 * recorded through the real intake (`intakeTask`, the one call `acp intake` and
 * `POST /api/v1/tasks` make), its V2 attempt opened by the walk's own plan steps and
 * its route segment recorded by runtime's execution chain, and a real disposable sha1
 * repository as the writer's worktree. The runner reads the envelope back, runs its
 * declared checks -- synthetic shell one-liners only, never a toolchain -- in a
 * disposable copy, publishes the receipt and appends it through `Ledger.append`, and
 * the tests read the §10.2 row back through `getVerification`.
 *
 * Git in these tests is plumbing only, in per-test repositories under `os.tmpdir()`,
 * with a built hermetic environment and the synthetic identity
 * `acp-fixture <fixture@invalid>` (ND-18); every directory is deleted by its test.
 * N17 proves the checkout the suite runs in is untouched: it hashes that checkout's
 * `.git` before the first test and after the last. Run it only in a clone nobody else
 * runs Git in (the DT pre-review's note).
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

// ---------------------------------------------------------------------------
// N17: the checkout this suite runs in is untouched
// ---------------------------------------------------------------------------

function checkoutGitDirectory(): string | null {
  let here = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(here, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(here);
    if (parent === here) return null;
    here = parent;
  }
}

function gitStateDigest(gitDirectory: string): Record<string, string> {
  const digests: Record<string, string> = {};
  const add = (path: string): void => {
    if (!existsSync(path)) return;
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) add(join(path, name));
      return;
    }
    digests[relative(gitDirectory, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  };
  for (const name of ["HEAD", "index", "packed-refs", "refs"]) add(join(gitDirectory, name));
  return digests;
}

const checkoutGit = checkoutGitDirectory();
let checkoutBefore: Record<string, string> = {};
beforeAll(() => {
  if (checkoutGit !== null && lstatSync(checkoutGit).isDirectory()) checkoutBefore = gitStateDigest(checkoutGit);
});
afterAll(() => {
  if (checkoutGit !== null && lstatSync(checkoutGit).isDirectory()) {
    expect(gitStateDigest(checkoutGit)).toEqual(checkoutBefore);
  }
});

// ---------------------------------------------------------------------------
// Disposable Git, plumbing only
// ---------------------------------------------------------------------------

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

/** The oracle: `git write-tree` of exactly these files, in a fresh repository. */
function oracleTree(files: Readonly<Record<string, string>>): string {
  const repo = scratch("acp-p16c-oracle-");
  git(repo, ["init", "-q", "--object-format=sha1", "."]);
  for (const [path, content] of Object.entries(files)) {
    const sha = git(repo, ["hash-object", "-w", "--stdin"], Buffer.from(content)).trim();
    git(repo, ["update-index", "--add", "--cacheinfo", "100644," + sha + "," + path]);
  }
  return git(repo, ["write-tree"]).trim();
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

/** The tree the default worktree names, as git writes it. */
function writerTree(): string {
  return oracleTree({
    "README.md": "readme\n",
    "src/a.ts": "export const a = 10;\n",
    "src/b.ts": "export const b = 2;\n",
    "src/new.ts": "export const n = 3;\n",
  });
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

function refused(outcome: VerificationRunOutcome): Extract<VerificationRunOutcome, { ok: false }> {
  if (outcome.ok) throw new Error("expected a refusal, and the run was recorded");
  return outcome;
}

function recorded(outcome: VerificationRunOutcome): Extract<VerificationRunOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error("expected a record, and the run was refused " + outcome.refusal + " at " + outcome.at + " (" + String(outcome.word) + ")");
  return outcome;
}

/**
 * A world whose one declared check writes a marker: the marker absent after a run
 * means zero spawns. The marker's directory is made first, so the command can name it.
 */
function markedWorld(extra: Omit<Declared, "commands"> = {}): { readonly world: World; readonly spawned: () => boolean } {
  const holder = scratch("acp-p16c-marker-");
  const path = join(holder, "spawned");
  const world = recordedWorld({ ...extra, commands: ["touch '" + path + "'"] });
  return { world, spawned: () => existsSync(path) };
}

/**
 * P-16/D2: history before D2. The intake now refuses an empty write-set
 * (`WRITE_SET_EMPTY`), so a task that stores one is planted over a task the real
 * intake entered: `override` is laid over the entered envelope, whose canonical bytes
 * are published through the task's own plane; every event of the task that names the
 * entered envelope is repointed at them (reference and
 * `sha256(ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1 + bytes)`), the event
 * chain, head and watermark recomputed from genesis with the two append-only triggers
 * taken out and put back verbatim, and the projections rebuilt (the bin suite's
 * `plantRecorded` mould, copied here). The runner then reads it through
 * `readRecordedTask`, as in production.
 */
function plantEnvelope(world: World, override: Record<string, unknown>): World {
  const taskId = world.task.taskId;
  const entered = world.ledger.getTaskRevision(taskId, 1);
  if (entered === null) throw new Error("the fixture's revision is missing");
  const read = world.plane.read({ artifactReferenceId: entered.envelopeArtifactReferenceId ?? "", scopeKind: "TASK", scopeId: taskId });
  if (read.verb !== "READ") throw new Error("the fixture's envelope is unreadable");
  const raw = { ...(JSON.parse(read.content.toString("utf8")) as Record<string, unknown>), ...override };
  const canonical = canonicalJsonStringify(raw);
  const referenceId = randomUUID();
  const published = world.plane.publish({
    content: Buffer.from(canonical, "utf8"),
    declaredContentSha256: digestOf(canonical),
    mediaType: "application/json; charset=utf-8",
    encryptionStatus: "PLAINTEXT",
    encryptionProfile: "local-plaintext-v1",
    commandId: randomUUID(),
    artifactPinId: randomUUID(),
    reference: {
      artifactReferenceId: referenceId,
      artifactClass: "TASK_ENVELOPE",
      classification: "INTERNAL",
      scopeKind: "TASK",
      scopeId: taskId,
      producerIdentity: EMITTED_BY,
      accessPolicyId: ARTIFACT_ACCESS_POLICY_IDS[0],
      retentionClass: "PERMANENT",
      expiresAt: null,
    },
    recordedBy: EMITTED_BY,
    intention: { eventId: randomUUID(), idempotencyKey: "planted/" + taskId + "/intended", occurredAt: AT, recordedAt: AT },
    terminal: { eventId: randomUUID(), idempotencyKey: "planted/" + taskId + "/succeeded", occurredAt: AT, recordedAt: AT },
    holding: {
      holder: EMITTED_BY,
      holderPid: process.pid,
      acquiredAt: AT,
      expiresAt: new Date(Date.parse(AT) + 5 * 60 * 1000).toISOString(),
    },
  });
  if (published.verb !== "PUBLISHED") throw new Error("the planted envelope was not published: " + published.verb);
  const envelopeDigest = digestOf(ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1 + canonical);
  const enteredDigest = entered.envelopeSha256;
  const enteredReference = entered.envelopeArtifactReferenceId ?? "";
  if (enteredDigest.length !== 64 || enteredReference === "") throw new Error("the fixture's revision names no envelope");
  world.ledger.close();

  const database = new DatabaseSync(world.ledgerPath);
  try {
    const triggers = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)")
      .all("control_plane_events_deny_update", "control_plane_events_deny_delete") as unknown as { readonly sql: string }[];
    expect(triggers).toHaveLength(2);
    database.exec("DROP TRIGGER control_plane_events_deny_update; DROP TRIGGER control_plane_events_deny_delete;");
    const rows = database
      .prepare("SELECT sequence, event_json FROM control_plane_events ORDER BY sequence")
      .all() as unknown as { readonly sequence: number; readonly event_json: string }[];
    const rewrite = database.prepare("UPDATE control_plane_events SET event_json = ?, previous_sha256 = ?, event_sha256 = ? WHERE sequence = ?");
    let previous = GENESIS_SHA256;
    for (const row of rows) {
      // Every event of the task that names the entered envelope (the intake and the
      // walk's own steps, which carry the revision) is repointed at the planted one.
      const decoded = JSON.parse(
        row.event_json.split(enteredDigest).join(envelopeDigest).split(enteredReference).join(referenceId),
      ) as Record<string, unknown>;
      const rewritten = canonicalJsonStringify(decoded);
      const next = chainDigest(previous, rewritten);
      rewrite.run(rewritten, previous, next, row.sequence);
      previous = next;
    }
    database.prepare("UPDATE ledger_meta SET value = ? WHERE key = 'head_event_sha256'").run(previous);
    database.prepare("UPDATE projection_watermark SET source_head_sha256 = ? WHERE source_stream = ?").run(previous, "control_plane_events");
    for (const trigger of triggers) database.exec(trigger.sql);
  } finally {
    database.close();
  }

  const ledger = openLedger(world.ledgerPath);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(world.ledgerPath), {
    incarnationId: randomUUID(),
    createdAt: REGISTRY_AT,
  });
  closers.push(() => {
    leaseStore.close();
    if (!ledger.closed) ledger.close();
  });
  ledger.rebuildReadModel();
  expect(ledger.getTaskRevision(taskId, 1)?.envelopeSha256).toBe(envelopeDigest);
  expect(ledger.verifyIntegrity().problems).toEqual([]);
  const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: world.ledgerPath });
  return { ...world, ledger, plane, context: { ...world.context, ledger } };
}

// ===========================================================================
// Units
// ===========================================================================

describe("the vocabulary, the bounds and the exit code (ND-3)", () => {
  it("is one sorted, repeat-free list, and the bounds are ceilings", () => {
    expect([...RUNNER_REFUSALS]).toEqual([...RUNNER_REFUSALS].sort());
    expect(new Set(RUNNER_REFUSALS).size).toBe(RUNNER_REFUSALS.length);
    for (const word of ["OBJECT_FORMAT_UNSUPPORTED", "BASE_HEAD_MISSING", "WRITER_ID_UNISSUED", "RUNNER_WRITE_SET_EMPTY"]) {
      expect(RUNNER_REFUSALS).toContain(word);
    }
    // P-16/D1 (ND-12, NB-3): nineteen, the two new words in their sorted places.
    expect(RUNNER_REFUSALS).toHaveLength(19);
    expect(RUNNER_REFUSALS.indexOf("RUNNER_INDEX_DIVERGED")).toBe(RUNNER_REFUSALS.indexOf("RUNNER_COPY_FAILED") + 1);
    expect(RUNNER_REFUSALS.indexOf("RUNNER_WORKTREE_NOT_ROOT")).toBe(RUNNER_REFUSALS.indexOf("RUNNER_WRITE_SET_EMPTY") - 1);
    expect(Object.isFrozen(RUNNER_BOUNDS)).toBe(true);
    expect(VERIFIER_IDENTITY).toBe("acp/verification-runner/verifier/01");
  });

  it("N19/B3: unspawnable 127, a bound's kill 137, a signal 128 + its number, an unmapped one 255", () => {
    const base = { spawnFailed: false, killedByBound: false, code: null, signal: null };
    expect(checkExitCode({ ...base, spawnFailed: true })).toBe(127);
    expect(checkExitCode({ ...base, killedByBound: true, signal: "SIGKILL" })).toBe(137);
    expect(checkExitCode({ ...base, killedByBound: true, code: 0 })).toBe(137);
    for (const code of [0, 1, 2, 126, 255]) expect(checkExitCode({ ...base, code })).toBe(code);
    expect(Object.is(checkExitCode({ ...base, code: -0 }), 0)).toBe(true);
    expect(checkExitCode({ ...base, signal: "SIGTERM" })).toBe(143);
    expect(checkExitCode({ ...base, signal: "SIGHUP" })).toBe(129);
    expect(checkExitCode({ ...base, signal: "SIGUSR1" })).toBe(255);
    expect(checkExitCode(base)).toBe(255);
  });
});

// ===========================================================================
// Positives, through the real door
// ===========================================================================

describe("P1-P4: the runner records a receipt through the real door", () => {
  it("P1: a passing run is one §10.2 row, every column the receipt's, rebuilt identical", async () => {
    const world = recordedWorld({ commands: ["test -f src/new.ts", "grep -q 10 src/a.ts", "exit 0"] });
    const repo = writerWorktree();
    const outcome = recorded(await runVerification(inputFor(world, repo)));
    const flat = world.task.attempt;
    expect(outcome).toMatchObject({ runStatus: "PASS", runId: 1, treeSha: writerTree() });
    expect(outcome.checks).toEqual([
      { command: "test -f src/new.ts", exitCode: 0 },
      { command: "grep -q 10 src/a.ts", exitCode: 0 },
      { command: "exit 0", exitCode: 0 },
    ]);
    const row = world.ledger.getVerification(outcome.receiptSha256);
    expect(row).toMatchObject({
      taskId: world.task.taskId,
      revisionNumber: 1,
      attemptNumber: 1,
      verifierIdentity: VERIFIER_IDENTITY,
      verifierWorkerId: supervisedWorkerIdFor(world.task.taskId, flat, "verifier", 1),
      verifierRunId: 1,
      writerIdentity: WRITER,
      writerWorkerId: writerWorkerIdFor(world.task.taskId, flat),
      baseSha: git(repo, ["rev-parse", "HEAD"]).trim(),
      treeSha: writerTree(),
      policySha256: verificationPolicySha256({
        commands: ["test -f src/new.ts", "grep -q 10 src/a.ts", "exit 0"],
        independentVerifierRequired: true,
        commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      }),
      artifactReferenceId: outcome.artifactReferenceId,
      runStatus: "PASS",
      allChecksZero: true,
    });
    expect(outcome.verifierWorkerId).toBe(row?.verifierWorkerId);
    const reference = world.ledger.getArtifactReference(outcome.artifactReferenceId);
    expect(reference).toMatchObject({ artifactClass: "RECEIPT", scopeKind: "TASK", scopeId: world.task.taskId });
    // The rebuild reproduces the row, and the integrity walk is clean.
    world.ledger.rebuildReadModel();
    expect(world.ledger.getVerification(outcome.receiptSha256)).toEqual(row);
    expect(world.ledger.verifyIntegrity().problems).toEqual([]);
    // The worktree is what it was, and no per-run directory is left.
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("export const a = 10;\n");
    expect(readdirSync(join(world.directory, "scratch"))).toEqual([]);
  });

  it("P2: a failing check is a FAIL receipt, and no later check runs (ND-4)", async () => {
    const holder = scratch("acp-p16c-marker-");
    const later = join(holder, "later");
    const world = recordedWorld({ commands: ["exit 1", "touch '" + later + "'"] });
    const outcome = recorded(await runVerification(inputFor(world, writerWorktree())));
    expect(outcome.runStatus).toBe("FAIL");
    expect(outcome.checks).toEqual([{ command: "exit 1", exitCode: 1 }]);
    expect(existsSync(later)).toBe(false);
    expect(world.ledger.getVerification(outcome.receiptSha256)).toMatchObject({ runStatus: "FAIL", allChecksZero: false });
  });

  it("P3: verifying the same attempt again is run 2, its own id, a second row", async () => {
    const world = recordedWorld({ commands: ["exit 0"] });
    const repo = writerWorktree();
    const root = scratchRoot(world);
    const first = recorded(await runVerification(inputFor(world, repo, { scratchRoot: root })));
    const second = recorded(await runVerification(inputFor(world, repo, { scratchRoot: root })));
    expect([first.runId, second.runId]).toEqual([1, 2]);
    expect(second.verifierWorkerId).toBe(supervisedWorkerIdFor(world.task.taskId, world.task.attempt, "verifier", 2));
    expect(second.receiptSha256).not.toBe(first.receiptSha256);
    expect(world.ledger.listVerifications(world.task.taskId, 1, 1).map((row) => row.verifierRunId)).toEqual([1, 2]);
    expect(world.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("P4: a writer racing the verifier is seen: the original worktree changed during the run, FAIL with every check zero (ND-16)", async () => {
    const repo = writerWorktree();
    const world = recordedWorld({ commands: ["printf 'raced\\n' >> '" + join(repo, "src/a.ts") + "'"] });
    const outcome = recorded(await runVerification(inputFor(world, repo)));
    expect(outcome.runStatus).toBe("FAIL");
    expect(outcome.checks).toEqual([{ command: expect.any(String) as string, exitCode: 0 }]);
    expect(world.ledger.getVerification(outcome.receiptSha256)).toMatchObject({ runStatus: "FAIL", allChecksZero: true });
  });

  it("the copy is the tree the receipt names: a deleted tracked file is absent, an untracked add inside the write-set present", async () => {
    const repo = repository({ "keep.txt": "keep\n", "gone.txt": "gone\n" });
    rmSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "added.txt"), "added\n");
    const world = recordedWorld({
      commands: ["test ! -e gone.txt", "test -f added.txt", "test ! -e .git"],
      writeSet: ["gone.txt", "added.txt"],
    });
    const outcome = recorded(await runVerification(inputFor(world, repo)));
    expect(outcome.runStatus).toBe("PASS");
    expect(outcome.treeSha).toBe(oracleTree({ "added.txt": "added\n", "keep.txt": "keep\n" }));
  });
});

// ===========================================================================
// Negatives: refused by name, before any spawn
// ===========================================================================

describe("N1-N7, N15: what is refused by name before any spawn", () => {
  it("N1: a sha256 repository is OBJECT_FORMAT_UNSUPPORTED, class CAPABILITY_UNSUPPORTED, no copy made", async () => {
    const { world, spawned } = markedWorld();
    const repo = repository({ "src/a.ts": "a\n" }, { format: "sha256" });
    const root = scratchRoot(world);
    const outcome = refused(await runVerification(inputFor(world, repo, { scratchRoot: root })));
    expect(outcome).toEqual({
      ok: false,
      refusal: "OBJECT_FORMAT_UNSUPPORTED",
      at: "objectFormat",
      word: null,
      refusalClass: "CAPABILITY_UNSUPPORTED",
    });
    expect(spawned()).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("N2: an unborn HEAD is BASE_HEAD_MISSING", async () => {
    const { world, spawned } = markedWorld();
    const repo = repository({ "src/a.ts": "a\n" }, { commit: false });
    expect(refused(await runVerification(inputFor(world, repo)))).toMatchObject({ refusal: "BASE_HEAD_MISSING", refusalClass: null });
    expect(spawned()).toBe(false);
  });

  it("N3: a change outside the write-set is RUNNER_WRITE_SET_VIOLATION: no receipt, the worktree untouched", async () => {
    const { world, spawned } = markedWorld();
    const repo = writerWorktree();
    writeFileSync(join(repo, "undeclared.txt"), "outside\n");
    const outcome = refused(await runVerification(inputFor(world, repo)));
    // The observed untracked paths, sorted: src/new.ts (declared), then undeclared.txt.
    expect(outcome).toMatchObject({ refusal: "RUNNER_WRITE_SET_VIOLATION", at: "observation.untrackedPaths[1]" });
    expect(spawned()).toBe(false);
    expect(existsSync(join(repo, "undeclared.txt"))).toBe(true);
    expect(world.ledger.listVerifications(world.task.taskId, 1, 1)).toEqual([]);
  });

  it("N4: an attempt with no recorded segment has no writer id issuer: WRITER_ID_UNISSUED", async () => {
    const { world, spawned } = markedWorld({ segment: false });
    expect(refused(await runVerification(inputFor(world, writerWorktree())))).toMatchObject({
      refusal: "WRITER_ID_UNISSUED",
      at: "route.segments",
    });
    expect(spawned()).toBe(false);
  });

  it("N5: no declared check is RUNNER_CHECKS_UNDECLARED; a planted empty write-set is RUNNER_WRITE_SET_EMPTY", async () => {
    const none = recordedWorld({ commands: [] });
    expect(refused(await runVerification(inputFor(none, writerWorktree())))).toMatchObject({
      refusal: "RUNNER_CHECKS_UNDECLARED",
      at: "envelope.validation.commands",
    });
    // P-16/D2: the intake now refuses an empty write-set, so it is planted over a
    // one-path NO_COMMIT task the real intake entered; the runner's backstop still holds.
    const { world: entered, spawned } = markedWorld({ writeSet: ["src/a.ts"], commitPolicy: "NO_COMMIT" });
    const world = plantEnvelope(entered, { writeSet: [] });
    expect(refused(await runVerification(inputFor(world, writerWorktree())))).toMatchObject({
      refusal: "RUNNER_WRITE_SET_EMPTY",
      at: "envelope.writeSet",
    });
    expect(spawned()).toBe(false);
  });

  it("N6: the task read back is refused with the reader's word carried", async () => {
    const { world, spawned } = markedWorld();
    const repo = writerWorktree();
    expect(refused(await runVerification(inputFor(world, repo, { route: { ...ROUTE, model: "claude-haiku-5" } })))).toMatchObject({
      refusal: "RUNNER_TASK_UNREADABLE",
      word: "ROUTE_DISAGREES_WITH_INTAKE",
    });
    expect(refused(await runVerification(inputFor(world, repo, { taskId: randomUUID() })))).toMatchObject({
      refusal: "RUNNER_TASK_UNREADABLE",
      word: "TASK_UNKNOWN",
    });
    expect(spawned()).toBe(false);
  });

  it("N7: a task in a terminal state is RUNNER_TASK_TERMINAL", async () => {
    const { world, spawned } = markedWorld();
    // The runtime's own cancellation settles the task into CANCELLED.
    await settleCancellation(world.context);
    expect(world.ledger.getTask(world.task.taskId)?.currentState).toBe("CANCELLED");
    expect(refused(await runVerification(inputFor(world, writerWorktree())))).toMatchObject({ refusal: "RUNNER_TASK_TERMINAL" });
    expect(spawned()).toBe(false);
  });

  it("a title the commit body rule refuses, a writer label that is the runner's, and a loosened bound", async () => {
    const titled = recordedWorld({ commands: ["exit 0"], title: "ACP-Receipt: forged" });
    expect(refused(await runVerification(inputFor(titled, writerWorktree())))).toMatchObject({ refusal: "RUNNER_COMMIT_BODY_INVALID" });
    const { world, spawned } = markedWorld();
    const repo = writerWorktree();
    expect(refused(await runVerification(inputFor(world, repo, { writerIdentity: VERIFIER_IDENTITY })))).toMatchObject({
      refusal: "RUNNER_INPUT_INVALID",
      at: "writerIdentity",
    });
    expect(
      refused(await runVerification(inputFor(world, repo, { bounds: { checkTimeoutMs: RUNNER_BOUNDS.checkTimeoutMs + 1 } }))),
    ).toMatchObject({ refusal: "RUNNER_INPUT_INVALID", at: "bounds" });
    expect(refused(await runVerification(inputFor(world, repo, { bounds: { copyFileCount: 0 } })))).toMatchObject({
      refusal: "RUNNER_INPUT_INVALID",
      at: "bounds",
    });
    expect(spawned()).toBe(false);
  });

  it("N15: a relative, linked, absent or inside-the-worktree scratch root is RUNNER_SCRATCH_ROOT_INVALID", async () => {
    const { world, spawned } = markedWorld();
    const repo = writerWorktree();
    const real = scratch("acp-p16c-real-");
    const link = join(scratch("acp-p16c-link-"), "root");
    symlinkSync(real, link);
    const inside = join(repo, "scratch");
    mkdirSync(inside);
    for (const root of ["relative/root", link, join(real, "absent"), inside, repo, real + "/"]) {
      expect(refused(await runVerification(inputFor(world, repo, { scratchRoot: root }))), root).toMatchObject({
        refusal: "RUNNER_SCRATCH_ROOT_INVALID",
        at: "scratchRoot",
      });
    }
    expect(spawned()).toBe(false);
  });
});

// ===========================================================================
// Bounds and isolation
// ===========================================================================

describe("N8-N11, N16, N19-N21: bounds, the built environment and what a check can reach", () => {
  it("N8: a check past its wall time is killed with its whole group, 137, FAIL", async () => {
    const holder = scratch("acp-p16c-grandchild-");
    const pidFile = join(holder, "gc.pid");
    const world = recordedWorld({ commands: ["sleep 30 & echo $! > '" + pidFile + "'; sleep 5"] });
    const started = Date.now();
    const outcome = recorded(await runVerification(inputFor(world, writerWorktree(), { bounds: { checkTimeoutMs: 300 } })));
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(outcome).toMatchObject({ runStatus: "FAIL" });
    expect(outcome.checks[0]?.exitCode).toBe(137);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    let alive = true;
    for (let tries = 0; tries < 50 && alive; tries += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("N9/B2: output past the cap is killed, FAIL; exactly the cap is not", async () => {
    const over = recordedWorld({ commands: ["head -c 1001 /dev/zero; sleep 5"] });
    const killed = recorded(await runVerification(inputFor(over, writerWorktree(), { bounds: { checkOutputBytes: 1000 } })));
    expect(killed).toMatchObject({ runStatus: "FAIL", checks: [{ exitCode: 137 }] });
    const at = recordedWorld({ commands: ["head -c 600 /dev/zero; head -c 400 /dev/zero 1>&2"] });
    const kept = recorded(await runVerification(inputFor(at, writerWorktree(), { bounds: { checkOutputBytes: 1000 } })));
    expect(kept).toMatchObject({ runStatus: "PASS", checks: [{ exitCode: 0 }] });
  });

  it("N10: the environment is built: no parent variable reaches a check, and PATH, HOME, TMPDIR and Git's are the runner's", async () => {
    process.env["ACP_TEST_CANARY_SECRET"] = "canary-" + randomUUID();
    try {
      const world = recordedWorld({
        commands: [
          'test -z "$ACP_TEST_CANARY_SECRET"',
          'test "$PATH" = /usr/bin:/bin',
          'test "$LC_ALL" = C',
          'case "$HOME" in */acp-verify-*/home) test -d "$HOME" ;; *) exit 1 ;; esac',
          'case "$TMPDIR" in */acp-verify-*/tmp) test -d "$TMPDIR" ;; *) exit 1 ;; esac',
          'test "$(pwd -P)" = "$(cd "$HOME/../tree" && pwd -P)"',
          'test "$GIT_CONFIG_GLOBAL" = /dev/null && test "$GIT_CONFIG_NOSYSTEM" = 1 && test -n "$GIT_CEILING_DIRECTORIES"',
          // Nothing but the seven, and what the shell itself sets.
          "test $(env | grep -c -v -E '^(PATH|LC_ALL|HOME|TMPDIR|GIT_CEILING_DIRECTORIES|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|PWD|OLDPWD|SHLVL|_)=') -eq 0",
        ],
      });
      const outcome = recorded(await runVerification(inputFor(world, writerWorktree())));
      expect(outcome.checks.map((check) => check.exitCode)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(outcome.runStatus).toBe("PASS");
    } finally {
      delete process.env["ACP_TEST_CANARY_SECRET"];
    }
  });

  it("N11: a check's output reaches no event, row, receipt, artifact, outcome or file of the ledger", async () => {
    const canary = "CANARY-" + randomUUID().slice(0, 8);
    const [head, tail] = [canary.slice(0, 4), canary.slice(4)];
    // The command spells the canary in two halves, so only its output holds it whole.
    const world = recordedWorld({ commands: ["printf '%s%s\\n' '" + head + "' '" + tail + "'; printf '%s%s\\n' '" + head + "' '" + tail + "' 1>&2"] });
    const outcome = recorded(await runVerification(inputFor(world, writerWorktree())));
    expect(outcome.runStatus).toBe("PASS");
    expect(JSON.stringify(outcome)).not.toContain(canary);
    world.ledger.close();
    const files: string[] = [];
    const walk = (path: string): void => {
      if (lstatSync(path).isDirectory()) {
        for (const name of readdirSync(path)) walk(join(path, name));
      } else {
        files.push(path);
      }
    };
    walk(world.directory);
    expect(files.length).toBeGreaterThan(1);
    for (const path of files) expect(readFileSync(path).includes(Buffer.from(canary)), path).toBe(false);
  });

  it("N16: a check that wrecks its cwd changes only the copy; the copy goes, a sibling in the scratch root stays", async () => {
    const repo = writerWorktree();
    const before = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const world = recordedWorld({ commands: ["rm -rf ./src ./README.md && mkdir .git && printf 'ref: refs/heads/evil\\n' > .git/HEAD && exit 0"] });
    const root = scratchRoot(world);
    writeFileSync(join(root, "sentinel"), "untouched\n");
    const outcome = recorded(await runVerification(inputFor(world, repo, { scratchRoot: root })));
    expect(outcome.runStatus).toBe("PASS");
    expect(git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe(before);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(repo, "src/b.ts"), "utf8")).toBe("export const b = 2;\n");
    expect(readdirSync(root)).toEqual(["sentinel"]);
    expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("untouched\n");
  });

  it("N19: a check that cannot run its program is FAIL, never PASS", async () => {
    const world = recordedWorld({ commands: ["exec /nonexistent/program"] });
    const outcome = recorded(await runVerification(inputFor(world, writerWorktree())));
    expect(outcome.runStatus).toBe("FAIL");
    // The shell's own word for a program it cannot run (126 or 127), never zero.
    expect([126, 127]).toContain(outcome.checks[0]?.exitCode);
  });

  it("B3: exit codes are recorded verbatim, and a signaled check is 128 + its number or 255", async () => {
    for (const [command, code] of [
      ["exit 1", 1],
      ["exit 255", 255],
      ["kill -TERM $$", 143],
      ["kill -USR1 $$", 255],
    ] as const) {
      const world = recordedWorld({ commands: [command] });
      const outcome = recorded(await runVerification(inputFor(world, writerWorktree())));
      expect({ command, status: outcome.runStatus, code: outcome.checks[0]?.exitCode }).toEqual({ command, status: "FAIL", code });
    }
  });

  it("N21: with the scratch root inside another repository, a check's git finds no repository, and that repository is untouched", async () => {
    const parent = repository({ "parent.txt": "parent\n" });
    const root = join(parent, "nested", "scratch");
    mkdirSync(root, { recursive: true });
    const digest = (): Record<string, string> => gitStateDigest(join(parent, ".git"));
    const before = digest();
    const world = recordedWorld({ commands: ["git rev-parse --git-dir"] });
    const outcome = recorded(await runVerification(inputFor(world, writerWorktree(), { scratchRoot: root })));
    expect(outcome.runStatus).toBe("FAIL");
    expect(outcome.checks[0]?.exitCode).not.toBe(0);
    expect(digest()).toEqual(before);
  });
});

// ===========================================================================
// Boundaries, and the door's refusal carried
// ===========================================================================

describe("B1, B5, N20: at the bounds, and a refusal of the door", () => {
  it("B1: fifty declared checks of 400 characters each all run, and the receipt holds fifty", async () => {
    const commands = Array.from({ length: 50 }, (_, index) => ("true # " + String(index) + " ").padEnd(400, "x"));
    const world = recordedWorld({ commands });
    const outcome = recorded(await runVerification(inputFor(world, writerWorktree())));
    expect(outcome.runStatus).toBe("PASS");
    expect(outcome.checks).toHaveLength(50);
    expect(outcome.checks.every((check, index) => check.command === commands[index] && check.exitCode === 0)).toBe(true);
  });

  it("B5: the copy at its bound in files and bytes passes, one past is RUNNER_COPY_BOUND_EXCEEDED", async () => {
    // The default worktree copies four files: README.md, src/a.ts, src/b.ts, src/new.ts.
    const bytes = ["readme\n", "export const a = 10;\n", "export const b = 2;\n", "export const n = 3;\n"].reduce(
      (total, text) => total + Buffer.byteLength(text),
      0,
    );
    const world = recordedWorld({ commands: ["exit 0"] });
    const repo = writerWorktree();
    const root = scratchRoot(world);
    expect(recorded(await runVerification(inputFor(world, repo, { scratchRoot: root, bounds: { copyFileCount: 4, copyTotalBytes: bytes } }))).runStatus).toBe("PASS");
    const { world: marked, spawned } = markedWorld();
    expect(refused(await runVerification(inputFor(marked, repo, { bounds: { copyFileCount: 3 } })))).toMatchObject({
      refusal: "RUNNER_COPY_BOUND_EXCEEDED",
    });
    expect(refused(await runVerification(inputFor(marked, repo, { bounds: { copyTotalBytes: bytes - 1 } })))).toMatchObject({
      refusal: "RUNNER_COPY_BOUND_EXCEEDED",
    });
    expect(spawned()).toBe(false);
  });

  it("N20: two concurrent runs of one attempt: the second append is refused, the ledger's word carried (a declared limit)", async () => {
    const world = recordedWorld({ commands: ["sleep 0.3"] });
    const repo = writerWorktree();
    const root = scratchRoot(world);
    const [first, second] = await Promise.all([
      runVerification(inputFor(world, repo, { scratchRoot: root })),
      runVerification(inputFor(world, repo, { scratchRoot: root })),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    // Both took run 1: the second event's key, `verification.run.1`, is already the
    // first's, and the stream refuses it before the door would say VERIFIER_NOT_REGISTERED.
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({
      refusal: "RUNNER_RECORD_REFUSED",
      word: "LEDGER_IDEMPOTENCY_CONFLICT",
    });
    expect(world.ledger.listVerifications(world.task.taskId, 1, 1)).toHaveLength(1);
    expect(readdirSync(root)).toEqual([]);
  });
});

// ===========================================================================
// P-16/D1 (ADR 0124; decision 240): the C verifier's notes, folded in
// ===========================================================================

/** Wait for a pid to be gone, and kill it if it outlives the wait (the test owns its escapee). */
async function reap(pidFile: string): Promise<void> {
  let pid = 0;
  for (let tries = 0; tries < 100 && pid === 0; tries += 1) {
    try {
      pid = Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

describe("P-16/D1: NB-1..NB-4 and NB-6, folded into the runner", () => {
  it("N11 / NB-1: an escapee that left the group and holds the pipes cannot hold the run past its bound", async () => {
    const holder = scratch("acp-p16d1-escapee-");
    const pidFile = join(holder, "escapee.pid");
    const escapee = "/usr/bin/perl -e 'use POSIX; POSIX::setsid(); open(my $f, \">\", \"" + pidFile + "\"); print $f $$; close $f; sleep 30'";
    try {
      // In the foreground: the shell waits on it, the bound kills the group, the pipes are destroyed, 137.
      const bound = recordedWorld({ commands: [escapee] });
      const started = Date.now();
      const killed = recorded(await runVerification(inputFor(bound, writerWorktree(), { bounds: { checkTimeoutMs: 500, runTimeoutMs: 1_000 } })));
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(killed).toMatchObject({ runStatus: "FAIL", checks: [{ exitCode: 137 }] });
    } finally {
      await reap(pidFile);
    }
    const second = join(holder, "escapee-2.pid");
    try {
      // In the background: the shell exits 0 and the escapee keeps the pipes; the exit's own code stands (ND-14).
      const exits = recordedWorld({ commands: ["(" + escapee.replace(pidFile, second) + " &) ; exit 0"] });
      const started = Date.now();
      const kept = recorded(await runVerification(inputFor(exits, writerWorktree(), { bounds: { checkTimeoutMs: 500, runTimeoutMs: 1_000 } })));
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(kept).toMatchObject({ runStatus: "PASS", checks: [{ exitCode: 0 }] });
    } finally {
      await reap(second);
    }
  }, 30_000);

  it("N10 / NB-2: a change hidden by assume-unchanged or skip-worktree is RUNNER_INDEX_DIVERGED, before any spawn", async () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const { world, spawned } = markedWorld();
      const repo = writerWorktree();
      // The index lists README.md, src/a.ts, src/b.ts: the hidden path is index[2].
      git(repo, ["update-index", flag, "src/b.ts"]);
      writeFileSync(join(repo, "src/b.ts"), "export const b = 20;\n");
      const outcome = refused(await runVerification(inputFor(world, repo)));
      expect({ flag, refusal: outcome.refusal, at: outcome.at }).toEqual({ flag, refusal: "RUNNER_INDEX_DIVERGED", at: "index[2]" });
      expect(spawned()).toBe(false);
      expect(world.ledger.listVerifications(world.task.taskId, 1, 1)).toEqual([]);
    }
    // The control: the same flag on an unmodified path hides nothing, and the run passes.
    const { world } = markedWorld();
    const repo = writerWorktree();
    git(repo, ["update-index", "--assume-unchanged", "src/b.ts"]);
    expect(recorded(await runVerification(inputFor(world, repo))).runStatus).toBe("PASS");
  });

  it("N9 / NB-3: a subdirectory of the repository, or a plain directory inside it, is RUNNER_WORKTREE_NOT_ROOT, zero spawns", async () => {
    const repo = writerWorktree();
    const plain = join(repo, "plain");
    mkdirSync(plain);
    for (const worktreePath of [join(repo, "src"), plain]) {
      const { world, spawned } = markedWorld();
      const outcome = refused(await runVerification(inputFor(world, worktreePath)));
      expect([outcome.refusal, outcome.at]).toEqual(["RUNNER_WORKTREE_NOT_ROOT", "worktreePath"]);
      expect(spawned()).toBe(false);
    }
  });

  it("N12 / NB-4: a check that removes its own bits from a directory in its copy cannot leave the run behind", async () => {
    const world = recordedWorld({ commands: ["mkdir -p locked/inner && touch locked/inner/f && chmod 000 locked/inner locked"] });
    const root = scratchRoot(world);
    writeFileSync(join(root, "sentinel"), "untouched\n");
    const outcome = recorded(await runVerification(inputFor(world, writerWorktree(), { scratchRoot: root })));
    expect(outcome.runStatus).toBe("PASS");
    expect(readdirSync(root)).toEqual(["sentinel"]);
    expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("untouched\n");
  });

  it("N13 / NB-6: a record refused after its publication leaves the published RECEIPT in place, and says so", async () => {
    const world = recordedWorld({ commands: ["sleep 0.3"] });
    const repo = writerWorktree();
    const root = scratchRoot(world);
    // Each run's ids in the order it mints them: the run directory, then the reference.
    const minted: string[][] = [[], []];
    const minter = (bucket: string[]) => (): string => {
      const id = randomUUID();
      bucket.push(id);
      return id;
    };
    const outcomes = await Promise.all([
      runVerification(inputFor(world, repo, { scratchRoot: root, mintId: minter(minted[0] ?? []) })),
      runVerification(inputFor(world, repo, { scratchRoot: root, mintId: minter(minted[1] ?? []) })),
    ]);
    const loser = outcomes.findIndex((outcome) => !outcome.ok);
    expect(loser).toBeGreaterThanOrEqual(0);
    expect(outcomes[loser]).toMatchObject({ refusal: "RUNNER_RECORD_REFUSED", word: "LEDGER_IDEMPOTENCY_CONFLICT" });
    const orphan = world.ledger.getArtifactReference(minted[loser]?.[1] ?? "");
    expect(orphan?.artifactClass).toBe("RECEIPT");
    expect(orphan?.scopeId).toBe(world.task.taskId);
    expect(world.ledger.listVerifications(world.task.taskId, 1, 1)).toHaveLength(1);
  });
});
