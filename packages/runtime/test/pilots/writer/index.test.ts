import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTHORIZATION_REFUSALS,
  authorizeCommit,
  recordCommit,
} from "../../../src/commit-authorization/index.js";
import type {
  AuthorizationEvent,
  AuthorizationGranted,
  AuthorizationRefused,
  RecordedCheck,
} from "../../../src/commit-authorization/index.js";
import { checkAdmission } from "../../../src/conflict-graph/index.js";
import type { DurableInvocation } from "../../../src/contracts/index.js";
import { LIFECYCLE_PLAN, planStep } from "../../../src/core/lifecycle/index.js";
import type { PlanStep } from "../../../src/core/lifecycle/index.js";
import {
  appendPlanStep,
  assertInvocationContinuity,
  currentState as executorCurrentState,
} from "../../../src/core/step-executor/index.js";
import type { BeatContext } from "../../../src/core/step-executor/index.js";
import { GIT_READ_VERBS, acquireLease, checkWriteSetConformance, verifyPrestate } from "../../../src/enforcement/index.js";
import type { EnforcementRefused, LeaseGranted } from "../../../src/enforcement/index.js";
import { SqliteSupervisor } from "../../../src/drivers/sqlite-supervisor/index.js";
import {
  applyEffect,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../../src/toy/repository/index.js";
import {
  PILOT_AUTHORIZED_BY,
  PILOT_VERIFIER,
  PILOT_WRITER,
  TOY_NOTES_PATH,
  TOY_README_PATH,
  TOY_SCRATCH_PATH,
  createGitReadPort,
  plantIntruder,
  sha256File,
  pilotEnvelope,
  takeObservation,
  writeToyContent,
} from "../helpers/index.js";
import type { SpawnGit, SpawnResult } from "../helpers/index.js";
import {
  WRITER_AUTHORIZED_AT,
  WRITER_CHECK_RAN_AT,
  WRITER_HAPPY_LEASE_ID,
  WRITER_HAPPY_RECEIPT_ID,
  WRITER_HAPPY_SECOND_LEASE_ID,
  WRITER_HAPPY_TASK_ID,
  WRITER_ISSUED_AT,
  WRITER_LEASE_ACQUIRED_AT,
  WRITER_LEASE_EXPIRES_AT,
  WRITER_PROBES_RECEIPT_ID,
  WRITER_PROBE_TASK_IDS,
  WRITER_SHARED_PROBE_LEASE_ID,
  WRITER_VIOLATION_PROBE_LEASE_ID,
  wrapAuthorizationEvent,
  writerInvocation,
} from "./helpers/index.js";

/**
 * P7C: the mechanical writer packet.
 *
 * P7A walked the `NO_COMMIT` close; P7B killed and resumed it and switched
 * accounts. This file walks the **writer** plan (`LIFECYCLE_PLAN`, eleven
 * steps) under `commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT"` over a toy
 * repository this file genuinely writes to -- the first end-to-end evidence
 * for the commit path: authorization, a real local commit, and
 * reconciliation against the receipt. The only commit anywhere in this
 * packet is the toy repository's own; nothing here pushes, and nothing here
 * touches a product repository.
 */

const OBJECT_ID = /^[0-9a-f]{40}$/;
/** A wrong-but-valid-shaped parent: 40 lowercase hex characters, never the real one. */
const WRONG_PARENT = "d".repeat(40);
const FAKE_COMMIT_SHA = "b".repeat(40);

const scenarios: string[] = [];
const ledgers: Ledger[] = [];
const toyDirs: string[] = [];
const spawnedGitArgv: (readonly string[])[] = [];

function scenario(id: string): ScenarioRoot {
  scenarios.push(id);
  return resolveScenarioRoot(id);
}

function track(ledger: Ledger): Ledger {
  ledgers.push(ledger);
  return ledger;
}

function toyRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-p7c-"));
  toyDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const id of scenarios.splice(0)) removeScenarioRoot(id);
  for (const dir of toyDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The toy git repository -- real `git`, owned and disposed by this file only.
// Re-instantiated from the P7A idiom (spawning stays in the one file the
// fence treats as test-only), with the C1 amendment: the fixture's initial
// commit tracks all three toy files, so the worktree is clean before the
// packet's act.
// ---------------------------------------------------------------------------

function makeSpawnGit(cwd: string, mkdtempRoot: string): SpawnGit {
  return (args: readonly string[]): SpawnResult => {
    if (cwd !== mkdtempRoot && !cwd.startsWith(mkdtempRoot + sep)) {
      throw new Error("refusing to spawn git outside the mkdtemp root this drill owns");
    }
    spawnedGitArgv.push(args);
    const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

/** C1: every toy file tracked by the fixture's own initial commit. */
function initToyRepositoryAllTracked(dir: string, spawnGit: SpawnGit): void {
  writeToyContent(dir);
  const init = spawnGit(["-c", "init.defaultBranch=main", "init", "-q"]);
  expect(init.status).toBe(0);
  const add = spawnGit(["add", TOY_README_PATH, TOY_SCRATCH_PATH, TOY_NOTES_PATH]);
  expect(add.status).toBe(0);
  const commit = spawnGit([
    "-c",
    "user.name=acp-pilot-drill",
    "-c",
    "user.email=drill@acp.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "toy: initial commit, all files tracked",
  ]);
  expect(commit.status).toBe(0);
}

/** A direct, argv-recorded spawn -- for reads and checks the port never speaks. */
function spawnGitDirect(toyDir: string, args: readonly string[]): { status: number | null; stdout: string } {
  spawnedGitArgv.push(args);
  const result = spawnSync("git", args, { cwd: toyDir, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

// ---------------------------------------------------------------------------
// Manual beat wiring -- the same primitives SqliteSupervisor uses privately,
// re-instantiated from the P7A idiom (step 0 is the one step advance() refuses).
// ---------------------------------------------------------------------------

function beatContext(
  scenarioRoot: ScenarioRoot,
  ledger: Ledger,
  invocation: DurableInvocation,
  emittedBy: string,
  plan: readonly PlanStep[],
): BeatContext {
  return {
    ledger,
    effects: {
      apply: (operation) => {
        applyEffect(scenarioRoot, operation);
      },
      probe: (operation) => probeEffect(scenarioRoot, operation),
    },
    invocation,
    emittedBy,
    plan,
  };
}

function appendStepZero(context: BeatContext): void {
  assertInvocationContinuity(context);
  appendPlanStep(context, planStep(0));
}

// ---------------------------------------------------------------------------
// The happy path: eleven plan steps, a real authorization, a real commit
// ---------------------------------------------------------------------------

describe("the writer packet, walked end to end", () => {
  it("authorizes, commits, and reconciles, in lawful order", async () => {
    const taskId = WRITER_HAPPY_TASK_ID;
    const root = scenario("p7c-happy");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const inv = writerInvocation(taskId);

    const toyDir = toyRepository();
    const spawnGit = makeSpawnGit(toyDir, toyDir);
    initToyRepositoryAllTracked(toyDir, spawnGit);
    const port = createGitReadPort(spawnGit);

    // C2: no path to a product repository.
    const remotes = spawnGitDirect(toyDir, ["remote", "-v"]);
    expect(remotes.status).toBe(0);
    expect(remotes.stdout.trim()).toBe("");

    const readmeDigest = sha256File(join(toyDir, TOY_README_PATH));

    // 1. Prestate, over real bytes.
    const prestate = verifyPrestate({
      authority: [{ path: TOY_README_PATH, sha256: readmeDigest }],
      observed: [{ path: TOY_README_PATH, sha256: readmeDigest }],
    });
    expect(prestate.ok).toBe(true);

    // 2. Admission and the envelope.
    const envelope = pilotEnvelope({
      taskId,
      issuedAt: WRITER_ISSUED_AT,
      authority: [{ path: TOY_README_PATH, sha256: readmeDigest }],
      readSet: [TOY_README_PATH, TOY_SCRATCH_PATH, TOY_NOTES_PATH],
      writeSet: [TOY_NOTES_PATH],
      conflictKeys: ["p7c:pilot:writer"],
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    });
    const admission = checkAdmission({ admitted: [], candidate: envelope });
    expect(admission.ok).toBe(true);
    if (admission.ok) expect(admission.compatible).toBe(true);

    // 3. Lease: the packet's holder acquires it; a different holder is refused.
    const leaseGrant = acquireLease({
      leases: [],
      now: WRITER_LEASE_ACQUIRED_AT,
      candidate: {
        leaseId: WRITER_HAPPY_LEASE_ID,
        worktreePath: toyDir,
        holder: PILOT_WRITER,
        acquiredAt: WRITER_LEASE_ACQUIRED_AT,
        expiresAt: WRITER_LEASE_EXPIRES_AT,
      },
    });
    expect(leaseGrant.ok).toBe(true);
    const grantedLease = (leaseGrant as LeaseGranted).lease;

    const secondHolder = acquireLease({
      leases: [grantedLease],
      now: WRITER_LEASE_ACQUIRED_AT,
      candidate: {
        leaseId: WRITER_HAPPY_SECOND_LEASE_ID,
        worktreePath: toyDir,
        holder: PILOT_VERIFIER,
        acquiredAt: WRITER_LEASE_ACQUIRED_AT,
        expiresAt: WRITER_LEASE_EXPIRES_AT,
      },
    });
    expect(secondHolder.ok).toBe(false);
    expect((secondHolder as EnforcementRefused).reason).toBe("LEASE_HELD_BY_ANOTHER");

    // 4. Steps 0-7: step 0 by hand, then the real SqliteSupervisor drives
    // steps 1-7 one at a time. The task stands at AUDITING.
    const context = beatContext(root, ledger, inv, PILOT_WRITER, LIFECYCLE_PLAN);
    appendStepZero(context);
    expect(executorCurrentState(context)).toBe("DISCOVERED");

    const supervisor = new SqliteSupervisor({
      ledger,
      invocation: inv,
      scenarioRoot: root,
      emittedBy: PILOT_WRITER,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    });
    await supervisor.advance(inv, "DISCOVERED"); // 1: classified
    await supervisor.advance(inv, "DT_CLASSIFIED"); // 2: ready
    await supervisor.advance(inv, "READY"); // 3: reserved
    await supervisor.advance(inv, "RESERVED"); // 4: run.started (INTENT)
    await supervisor.advance(inv, "RUNNING"); // 5: run.outcome (OUTCOME)
    await supervisor.advance(inv, "RUNNING"); // 6: verified
    await supervisor.advance(inv, "VERIFYING"); // 7: audited -> AUDITING
    expect(ledger.getTask(taskId)?.currentState).toBe("AUDITING");

    // 5. The writer's act, by this drill as the integrator: modify the one
    // declared path. With the C1-fixed fixture this is exactly one tracked
    // change with a real content digest -- takeObservation's tracked-change
    // branch, exercised for the first time.
    writeFileSync(
      join(toyDir, TOY_NOTES_PATH),
      "untracked directory with contents\np7c: writer packet update\n",
      "utf8",
    );
    const diffCheck = spawnGitDirect(toyDir, ["diff", "--check"]);
    expect(diffCheck.status).toBe(0);

    // A real takeObservation: with the C1-fixed fixture this is exactly one
    // tracked change (a real content digest, never a placeholder) and zero
    // untracked paths -- the tracked-changes digest branch, exercised for
    // the first time (P7A left it construction-only).
    const worktreeObservation = takeObservation(port, toyDir);
    const initialSha = worktreeObservation.head ?? "";
    expect(OBJECT_ID.test(initialSha)).toBe(true);
    expect(worktreeObservation.trackedChanges).toEqual([
      { path: TOY_NOTES_PATH, sha256: sha256File(join(toyDir, TOY_NOTES_PATH)) },
    ]);
    expect(worktreeObservation.untrackedPaths).toEqual([]);

    const conformance = checkWriteSetConformance({
      declaredWriteSet: [TOY_NOTES_PATH],
      observation: worktreeObservation,
      lease: grantedLease,
    });
    expect(conformance.ok).toBe(true);
    if (conformance.ok) {
      expect(conformance.conformant).toBe(true);
      expect(conformance.violations).toEqual([]);
    }

    const commitMessage = "p7c: update notes/todo.txt";
    const checks: readonly RecordedCheck[] = [
      { command: "git diff --check", exitCode: diffCheck.status ?? 1, ranAt: WRITER_CHECK_RAN_AT },
    ];
    const authorization = authorizeCommit({
      receiptId: WRITER_HAPPY_RECEIPT_ID,
      taskId,
      attempt: 1,
      writer: PILOT_WRITER,
      verifier: PILOT_VERIFIER,
      authorizedBy: PILOT_AUTHORIZED_BY,
      authorizedAt: WRITER_AUTHORIZED_AT,
      worktreePath: toyDir,
      branch: "main",
      declaredWriteSet: [TOY_NOTES_PATH],
      observation: worktreeObservation,
      checks,
      commitMessage,
      lease: grantedLease,
    });
    expect(authorization.ok).toBe(true);
    if (!authorization.ok) throw new Error("expected authorization to be granted");
    const receipt = authorization.receipt;
    expect(receipt.pushAuthorized).toBe(false);
    expect(receipt.baseHead).toBe(initialSha);

    // N2: the full granted event list, asserted as a value -- payloads
    // verbatim. Only COMMIT_AUTHORIZED is appended here (no audit was
    // supplied, so no AUDIT_COMPLETED candidate exists); VERIFICATION_COMPLETED
    // is asserted but never appended -- plan step 6 already recorded that
    // transition, and a second copy would be noise.
    expect(authorization.events.map((candidate) => candidate.type)).toEqual([
      "VERIFICATION_COMPLETED",
      "COMMIT_AUTHORIZED",
    ]);
    const commitAuthorizedCandidate: AuthorizationEvent | undefined = authorization.events.find(
      (candidate) => candidate.type === "COMMIT_AUTHORIZED",
    );
    if (commitAuthorizedCandidate === undefined) throw new Error("expected a COMMIT_AUTHORIZED candidate");
    const commitAuthorizedAppend = ledger.append(
      wrapAuthorizationEvent(inv, "commit.authorized.pilot", "AUDITING", PILOT_WRITER, commitAuthorizedCandidate),
    );
    expect(commitAuthorizedAppend.inserted).toBe(true);
    expect(commitAuthorizedAppend.record.event.payload).toEqual(commitAuthorizedCandidate.payload);

    // 6. Plan step 8: AUDITING -> READY_TO_COMMIT.
    await supervisor.advance(inv, "AUDITING");
    expect(ledger.getTask(taskId)?.currentState).toBe("READY_TO_COMMIT");

    // 7. The real local commit, through the drill's own spawn -- never the
    // port, which speaks only GIT_READ_VERBS.
    const add = spawnGitDirect(toyDir, ["add", TOY_NOTES_PATH]);
    expect(add.status).toBe(0);
    const commit = spawnGitDirect(toyDir, [
      "-c",
      "user.name=acp-pilot-drill",
      "-c",
      "user.email=drill@acp.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      commitMessage,
    ]);
    expect(commit.status).toBe(0);

    const shaRead = spawnGitDirect(toyDir, ["rev-parse", "HEAD"]);
    expect(shaRead.status).toBe(0);
    const commitSha = shaRead.stdout.trim();
    expect(OBJECT_ID.test(commitSha)).toBe(true);
    expect(commitSha).not.toBe(initialSha);

    const parentsRead = spawnGitDirect(toyDir, ["log", "-1", "--format=%P", commitSha]);
    expect(parentsRead.status).toBe(0);
    const parents = parentsRead.stdout.trim().split(/\s+/).filter((entry) => entry.length > 0);
    expect(parents).toEqual([initialSha]);

    const messageRead = spawnGitDirect(toyDir, ["log", "-1", "--format=%s", commitSha]);
    expect(messageRead.status).toBe(0);
    const readMessage = messageRead.stdout.trim();
    expect(readMessage).toBe(commitMessage);

    // 8. Reconcile the recorded commit against the receipt.
    const reconciliation = recordCommit({
      receipt,
      commit: { sha: commitSha, parents, message: readMessage },
    });
    expect(reconciliation.ok).toBe(true);
    if (!reconciliation.ok) throw new Error("expected the commit to reconcile");
    expect(reconciliation.events.map((candidate) => candidate.type)).toEqual(["COMMIT_RECORDED"]);
    const commitRecordedCandidate = reconciliation.events[0];
    if (commitRecordedCandidate === undefined) throw new Error("expected a COMMIT_RECORDED candidate");
    const commitRecordedAppend = ledger.append(
      wrapAuthorizationEvent(inv, "commit.recorded.pilot", "READY_TO_COMMIT", PILOT_WRITER, commitRecordedCandidate),
    );
    expect(commitRecordedAppend.inserted).toBe(true);
    expect(commitRecordedAppend.record.event.payload).toEqual(commitRecordedCandidate.payload);

    // 9. Plan steps 9-10: the plan's own COMMIT_RECORDED, then CHECKPOINT_WRITTEN.
    await supervisor.advance(inv, "READY_TO_COMMIT");
    await supervisor.advance(inv, "COMMITTED");
    expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");

    // ---------------------------------------------------------------------
    // The trail, read back from the ledger.
    // ---------------------------------------------------------------------
    const events = ledger.listEvents({ limit: 200 }).events;
    expect(events).toHaveLength(LIFECYCLE_PLAN.length + 2);

    const planTransitionIds = new Set(LIFECYCLE_PLAN.map((step) => step.transitionId));
    const planEvents = events.filter((record) => planTransitionIds.has(record.event.transitionId));
    expect(planEvents).toHaveLength(LIFECYCLE_PLAN.length);
    for (const [index, step] of LIFECYCLE_PLAN.entries()) {
      expect(planEvents[index]?.event.transitionId).toBe(step.transitionId);
      expect(planEvents[index]?.event.toState).toBe(step.toState);
      expect(planEvents[index]?.event.type).toBe(step.eventType);
    }

    // N1: exactly-once assertions key on transitionId, never on a bare
    // type-count -- COMMIT_RECORDED lawfully appears twice (the reconciliation
    // passthrough and plan step 9, distinct transitionIds).
    const byTransitionId = new Map(events.map((record) => [record.event.transitionId, record]));
    expect(byTransitionId.size).toBe(events.length);
    const authorizedRecord = byTransitionId.get("commit.authorized.pilot");
    const recordedPassthrough = byTransitionId.get("commit.recorded.pilot");
    const committedStep = byTransitionId.get("committed");
    const readyToCommitStep = byTransitionId.get("ready-to-commit");
    if (
      authorizedRecord === undefined ||
      recordedPassthrough === undefined ||
      committedStep === undefined ||
      readyToCommitStep === undefined
    ) {
      throw new Error("expected every named transition to be present exactly once");
    }
    expect(authorizedRecord.event.type).toBe("COMMIT_AUTHORIZED");
    expect(recordedPassthrough.event.type).toBe("COMMIT_RECORDED");
    expect(committedStep.event.type).toBe("COMMIT_RECORDED");
    // Lawful order: authorization precedes step 8; the reconciliation
    // passthrough precedes plan step 9.
    expect(authorizedRecord.sequence).toBeLessThan(readyToCommitStep.sequence);
    expect(recordedPassthrough.sequence).toBeLessThan(committedStep.sequence);

    const integrity = ledger.verifyIntegrity();
    expect(integrity.ok).toBe(true);
    expect(integrity.problems).toEqual([]);

    const liveTask = ledger.getTask(taskId);
    const liveWorkers = ledger.listWorkers().workers;
    ledger.rebuildReadModel();
    expect(ledger.getTask(taskId)).toEqual(liveTask);
    expect(ledger.listWorkers().workers).toEqual(liveWorkers);

    const keys = events.map((record) => record.event.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);

    // 10. The never-push proof, for this scenario's own remote check.
    expect(remotes.stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The fail-closed probes, planted and never committed. Each on its own
// ledger/task so the happy path stays clean; nothing is appended on refusal.
// ---------------------------------------------------------------------------

describe("the fail-closed probes", () => {
  it("refuses VERIFIER_NOT_INDEPENDENT when writer and verifier are the same", () => {
    const taskId = WRITER_PROBE_TASK_IDS.verifierNotIndependent;
    const root = scenario("p7c-probe-independence");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    expect(ledger.status().eventCount).toBe(0);

    const toyDir = toyRepository();
    const spawnGit = makeSpawnGit(toyDir, toyDir);
    initToyRepositoryAllTracked(toyDir, spawnGit);
    const port = createGitReadPort(spawnGit);
    const observation = takeObservation(port, toyDir);

    const leaseGrant = acquireLease({
      leases: [],
      now: WRITER_LEASE_ACQUIRED_AT,
      candidate: {
        leaseId: WRITER_SHARED_PROBE_LEASE_ID,
        worktreePath: toyDir,
        holder: PILOT_WRITER,
        acquiredAt: WRITER_LEASE_ACQUIRED_AT,
        expiresAt: WRITER_LEASE_EXPIRES_AT,
      },
    });
    expect(leaseGrant.ok).toBe(true);
    const lease = (leaseGrant as LeaseGranted).lease;

    const outcome = authorizeCommit({
      receiptId: WRITER_PROBES_RECEIPT_ID,
      taskId,
      attempt: 1,
      writer: PILOT_WRITER,
      verifier: PILOT_WRITER, // same identity: not independent
      authorizedBy: PILOT_AUTHORIZED_BY,
      authorizedAt: WRITER_AUTHORIZED_AT,
      worktreePath: toyDir,
      branch: "main",
      declaredWriteSet: [TOY_NOTES_PATH],
      observation,
      checks: [{ command: "git diff --check", exitCode: 0, ranAt: WRITER_CHECK_RAN_AT }],
      commitMessage: "should never be authorized",
      lease,
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as AuthorizationRefused).reason).toBe("VERIFIER_NOT_INDEPENDENT");
    expect(ledger.status().eventCount).toBe(0);
  });

  it("refuses CHECK_FAILED when a recorded check exited nonzero", () => {
    const taskId = WRITER_PROBE_TASK_IDS.checkFailed;
    const root = scenario("p7c-probe-check-failed");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    expect(ledger.status().eventCount).toBe(0);

    const toyDir = toyRepository();
    const spawnGit = makeSpawnGit(toyDir, toyDir);
    initToyRepositoryAllTracked(toyDir, spawnGit);
    const port = createGitReadPort(spawnGit);
    const observation = takeObservation(port, toyDir);

    const leaseGrant = acquireLease({
      leases: [],
      now: WRITER_LEASE_ACQUIRED_AT,
      candidate: {
        leaseId: WRITER_SHARED_PROBE_LEASE_ID,
        worktreePath: toyDir,
        holder: PILOT_WRITER,
        acquiredAt: WRITER_LEASE_ACQUIRED_AT,
        expiresAt: WRITER_LEASE_EXPIRES_AT,
      },
    });
    expect(leaseGrant.ok).toBe(true);
    const lease = (leaseGrant as LeaseGranted).lease;

    // A real spawned process with a real nonzero exit -- never a literal.
    const failing = spawnSync(process.execPath, ["-e", "process.exit(7)"], { encoding: "utf8" });
    expect(failing.status).not.toBe(0);

    const outcome = authorizeCommit({
      receiptId: WRITER_PROBES_RECEIPT_ID,
      taskId,
      attempt: 1,
      writer: PILOT_WRITER,
      verifier: PILOT_VERIFIER,
      authorizedBy: PILOT_AUTHORIZED_BY,
      authorizedAt: WRITER_AUTHORIZED_AT,
      worktreePath: toyDir,
      branch: "main",
      declaredWriteSet: [TOY_NOTES_PATH],
      observation,
      checks: [
        { command: "node -e process.exit(7)", exitCode: failing.status ?? 1, ranAt: WRITER_CHECK_RAN_AT },
      ],
      commitMessage: "should never be authorized",
      lease,
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as AuthorizationRefused).reason).toBe("CHECK_FAILED");
    expect(ledger.status().eventCount).toBe(0);
  });

  it("refuses WRITE_SET_VIOLATION when the observation names a path outside the declared set", () => {
    const taskId = WRITER_PROBE_TASK_IDS.writeSetViolation;
    const root = scenario("p7c-probe-write-set-violation");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    expect(ledger.status().eventCount).toBe(0);

    const toyDir = toyRepository();
    const spawnGit = makeSpawnGit(toyDir, toyDir);
    initToyRepositoryAllTracked(toyDir, spawnGit);
    const port = createGitReadPort(spawnGit);

    const planted = plantIntruder(toyDir);
    const observation = takeObservation(port, toyDir);
    expect(observation.untrackedPaths).toEqual([planted]);

    const leaseGrant = acquireLease({
      leases: [],
      now: WRITER_LEASE_ACQUIRED_AT,
      candidate: {
        leaseId: WRITER_VIOLATION_PROBE_LEASE_ID,
        worktreePath: toyDir,
        holder: PILOT_WRITER,
        acquiredAt: WRITER_LEASE_ACQUIRED_AT,
        expiresAt: WRITER_LEASE_EXPIRES_AT,
      },
    });
    expect(leaseGrant.ok).toBe(true);
    const lease = (leaseGrant as LeaseGranted).lease;

    const outcome = authorizeCommit({
      receiptId: WRITER_PROBES_RECEIPT_ID,
      taskId,
      attempt: 1,
      writer: PILOT_WRITER,
      verifier: PILOT_VERIFIER,
      authorizedBy: PILOT_AUTHORIZED_BY,
      authorizedAt: WRITER_AUTHORIZED_AT,
      worktreePath: toyDir,
      branch: "main",
      declaredWriteSet: [TOY_NOTES_PATH],
      observation,
      checks: [{ command: "git diff --check", exitCode: 0, ranAt: WRITER_CHECK_RAN_AT }],
      commitMessage: "should never be authorized",
      lease,
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as AuthorizationRefused).reason).toBe("WRITE_SET_VIOLATION");
    expect(ledger.status().eventCount).toBe(0);

    // The planted file is still there -- no cleanup performed by the refusal.
    rmSync(join(toyDir, planted), { force: true });
  });

  it("refuses COMMIT_MESSAGE_MISMATCH and COMMIT_PARENT_MISMATCH on a tampered reconciliation", () => {
    const taskId = WRITER_PROBE_TASK_IDS.commitMessageMismatch;
    const messageRoot = scenario("p7c-probe-commit-message-mismatch");
    const parentRoot = scenario("p7c-probe-commit-parent-mismatch");
    const messageLedger = track(openLedger(scenarioLedgerPath(messageRoot)));
    const parentLedger = track(openLedger(scenarioLedgerPath(parentRoot)));
    expect(messageLedger.status().eventCount).toBe(0);
    expect(parentLedger.status().eventCount).toBe(0);

    const toyDir = toyRepository();
    const spawnGit = makeSpawnGit(toyDir, toyDir);
    initToyRepositoryAllTracked(toyDir, spawnGit);
    const port = createGitReadPort(spawnGit);
    const observation = takeObservation(port, toyDir);
    const head = observation.head ?? "";

    const leaseGrant = acquireLease({
      leases: [],
      now: WRITER_LEASE_ACQUIRED_AT,
      candidate: {
        leaseId: WRITER_SHARED_PROBE_LEASE_ID,
        worktreePath: toyDir,
        holder: PILOT_WRITER,
        acquiredAt: WRITER_LEASE_ACQUIRED_AT,
        expiresAt: WRITER_LEASE_EXPIRES_AT,
      },
    });
    expect(leaseGrant.ok).toBe(true);
    const lease = (leaseGrant as LeaseGranted).lease;

    const authorization = authorizeCommit({
      receiptId: WRITER_PROBES_RECEIPT_ID,
      taskId,
      attempt: 1,
      writer: PILOT_WRITER,
      verifier: PILOT_VERIFIER,
      authorizedBy: PILOT_AUTHORIZED_BY,
      authorizedAt: WRITER_AUTHORIZED_AT,
      worktreePath: toyDir,
      branch: "main",
      declaredWriteSet: [TOY_NOTES_PATH],
      observation,
      checks: [{ command: "git diff --check", exitCode: 0, ranAt: WRITER_CHECK_RAN_AT }],
      commitMessage: "p7c: probe commit",
      lease,
    }) as AuthorizationGranted;
    expect(authorization.ok).toBe(true);
    const receipt = authorization.receipt;
    expect(receipt.baseHead).toBe(head);

    // The parent is right first (the module checks sha, then parents, then
    // message) -- only the message is tampered.
    const messageMismatch = recordCommit({
      receipt,
      commit: { sha: FAKE_COMMIT_SHA, parents: [head], message: "a tampered message" },
    });
    expect(messageMismatch.ok).toBe(false);
    expect((messageMismatch as AuthorizationRefused).reason).toBe("COMMIT_MESSAGE_MISMATCH");
    expect(messageLedger.status().eventCount).toBe(0);

    // A wrong-but-valid-shaped parent, message otherwise correct.
    const parentMismatch = recordCommit({
      receipt,
      commit: { sha: FAKE_COMMIT_SHA, parents: [WRONG_PARENT], message: receipt.commitMessage },
    });
    expect(parentMismatch.ok).toBe(false);
    expect((parentMismatch as AuthorizationRefused).reason).toBe("COMMIT_PARENT_MISMATCH");
    expect(parentLedger.status().eventCount).toBe(0);
  });

  it("closes its refusal vocabulary", () => {
    expect([...AUTHORIZATION_REFUSALS]).toEqual([...AUTHORIZATION_REFUSALS].sort());
    expect(new Set(AUTHORIZATION_REFUSALS).size).toBe(AUTHORIZATION_REFUSALS.length);
  });
});

// ---------------------------------------------------------------------------
// The never-push proof, over every spawn this file made
// ---------------------------------------------------------------------------

describe("the packet never pushes", () => {
  it("names push nowhere in the closed read-verb union", () => {
    expect((GIT_READ_VERBS as readonly string[]).includes("push")).toBe(false);
  });

  it("spawned no push verb anywhere across the whole file", () => {
    expect(spawnedGitArgv.length).toBeGreaterThan(0);
    for (const argv of spawnedGitArgv) {
      expect(argv).not.toContain("push");
      for (const token of argv) {
        expect(token.includes("push")).toBe(false);
      }
    }
  });
});
