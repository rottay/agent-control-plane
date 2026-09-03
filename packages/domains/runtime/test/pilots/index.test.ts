import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { WorkerIdentityString } from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import { deterministicUuid } from "../../src/core/coordinates/index.js";
import {
  PLAN_TERMINAL_STATE,
  READ_ONLY_PLAN,
  planFor,
  planStep,
  validatePlan,
} from "../../src/core/lifecycle/index.js";
import type { PlanStep } from "../../src/core/lifecycle/index.js";
import {
  appendPlanStep,
  assertInvocationContinuity,
  currentState as executorCurrentState,
} from "../../src/core/step-executor/index.js";
import type { BeatContext, EffectPort } from "../../src/core/step-executor/index.js";
import { checkAdmission } from "../../src/conflict-graph/index.js";
import { acquireLease, checkWriteSetConformance, verifyPrestate } from "../../src/enforcement/index.js";
import type { EnforcementRefused, LeaseGranted } from "../../src/enforcement/index.js";
import { SqliteSupervisor } from "../../src/drivers/sqlite-supervisor/index.js";
import { LifecyclePlanError } from "../../src/errors/index.js";
import {
  applyEffect,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";
import {
  PILOT_IDENTITIES,
  PILOT_VERIFIER,
  PILOT_WRITER,
  TOY_NOTES_PATH,
  TOY_README_PATH,
  TOY_SCRATCH_PATH,
  createGitReadPort,
  foldLiveLeases,
  pilotEnvelope,
  plantIntruder,
  sha256File,
  takeObservation,
  wrapEnforcementEvent,
  wrapStateChange,
  writeToyContent,
} from "./helpers/index.js";
import type { SpawnGit, SpawnResult } from "./helpers/index.js";


/**
 * One admitted route for every fixture in this file (V2-B1c).
 *
 * A route is required, never defaulted, so every construction site states one.
 * It satisfies the contract's own refinement: a CLI_SUBSCRIPTION route names a
 * provider the kernel lists as one.
 */
const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

/**
 * The initiative every pilot packet is scoped to.
 *
 * The same value the helpers' `pilotEnvelope` fills, restated here because
 * the helpers keep it module-private and this packet does not touch that
 * file. The envelope and the supervisor must agree, so the literal is the
 * agreement.
 */
const PILOT_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";

/**
 * P7A: the complete read-only packet pilot.
 *
 * A `NO_COMMIT` `TaskEnvelope` walked end to end over the real machinery this
 * repository has landed through P7P: the real `SqliteSupervisor`, the real
 * enforcement, conflict-graph and lifecycle modules, and real `git` against a
 * disposable toy repository this file owns. Nothing here is a mock except the
 * two things P7 has no real provider for.
 *
 * Two independent scenarios, two toy repositories, two scenario roots:
 * `HAPPY` proves the read-only close reaches `CHECKPOINTED` with no commit
 * event and no commit state; `VIOLATION` proves the write-set fence, the
 * lease revocation and the `SUSPECT_WORKTREE` close, on a task the happy path
 * never touches.
 */

const T0 = "2026-08-29T12:00:00.000Z";
const LEASE_ACQUIRED_AT = "2026-08-29T11:55:00.000Z";
const LEASE_EXPIRES_AT = "2026-08-29T13:00:00.000Z";

const scenarios: string[] = [];
const ledgers: Ledger[] = [];
const toyDirs: string[] = [];

function scenario(id: string): ScenarioRoot {
  scenarios.push(id);
  return resolveScenarioRoot(id);
}

function track(ledger: Ledger): Ledger {
  ledgers.push(ledger);
  return ledger;
}

function toyRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-p7a-"));
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
// The toy git repository -- real `git`, owned and disposed by this file only
// ---------------------------------------------------------------------------

/** C2: the port's `cwd` is asserted inside the mkdtemp root before every spawn. */
function makeSpawnGit(cwd: string, mkdtempRoot: string): SpawnGit {
  return (args: readonly string[]): SpawnResult => {
    if (cwd !== mkdtempRoot && !cwd.startsWith(mkdtempRoot + sep)) {
      throw new Error("refusing to spawn git outside the mkdtemp root this drill owns");
    }
    const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

function initToyRepository(dir: string, spawnGit: SpawnGit): void {
  writeToyContent(dir);
  const init = spawnGit(["-c", "init.defaultBranch=main", "init", "-q"]);
  expect(init.status).toBe(0);
  const add = spawnGit(["add", TOY_README_PATH]);
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
    "toy: initial commit",
  ]);
  expect(commit.status).toBe(0);
}

// ---------------------------------------------------------------------------
// Manual beat wiring -- the same primitives `SqliteSupervisor` uses privately
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
        return Promise.resolve();
      },
      probe: (operation) => Promise.resolve(probeEffect(scenarioRoot, operation)),
    },
    invocation,
    emittedBy,
    plan,
    initiativeId: PILOT_INITIATIVE_ID,
    route: TEST_ROUTE,
    };
}

/** Append step 0 (`TASK_DISCOVERED`) by hand -- the one step `advance()` refuses. */
function appendStepZero(context: BeatContext): void {
  assertInvocationContinuity(context);
  appendPlanStep(context, planStep(0));
}

function invocation(taskId: string, submissionDigest: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("p7a-invocation/" + taskId),
    submittedAt: T0,
    submissionDigest,
  };
}

// ---------------------------------------------------------------------------
// C3: identities
// ---------------------------------------------------------------------------

/** The toy port, passed explicitly to the supervisor (V2-B1b, stage 2): the pilot's subject stays the toy. */
function toyEffects(scenarioRoot: ScenarioRoot): EffectPort {
  return {
    apply: (operation) => {
      applyEffect(scenarioRoot, operation);
      return Promise.resolve();
    },
    probe: (operation) => Promise.resolve(probeEffect(scenarioRoot, operation)),
  };
}

describe("drill identities", () => {
  it("are valid four-segment WorkerIdentityStrings, pairwise distinct", () => {
    for (const identity of PILOT_IDENTITIES) {
      expect(WorkerIdentityString.safeParse(identity).success).toBe(true);
    }
    expect(new Set(PILOT_IDENTITIES).size).toBe(PILOT_IDENTITIES.length);
  });
});

// ---------------------------------------------------------------------------
// The plan this pilot walks
// ---------------------------------------------------------------------------

describe("the landed read-only plan", () => {
  it("validates, and planFor(NO_COMMIT) selects it by identity", () => {
    expect(() => {
      validatePlan(READ_ONLY_PLAN);
    }).not.toThrow();
    expect(planFor("NO_COMMIT")).toBe(READ_ONLY_PLAN);
  });
});

// ---------------------------------------------------------------------------
// HAPPY: the complete read-only walk
// ---------------------------------------------------------------------------

describe("the read-only packet, walked end to end", () => {
  it("prestate, admission, lease, the lifecycle walk, and a real checkpoint", async () => {
    const taskId = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
    const root = scenario("p7a-happy");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const toyDir = toyRepository();
    const spawnGit = makeSpawnGit(toyDir, toyDir);
    initToyRepository(toyDir, spawnGit);
    const port = createGitReadPort(spawnGit);

    // C2: no path to a product repository. Checked directly -- "remote" is not
    // one of GIT_READ_VERBS, so the port itself can never be asked to speak it.
    const remotes = spawnSync("git", ["-C", toyDir, "remote", "-v"], { encoding: "utf8" });
    expect(remotes.status).toBe(0);
    expect(remotes.stdout.trim()).toBe("");

    const readmeDigest = sha256File(join(toyDir, TOY_README_PATH));

    // 1. Prestate, over real bytes.
    const prestate = verifyPrestate({
      authority: [{ path: TOY_README_PATH, sha256: readmeDigest }],
      observed: [{ path: TOY_README_PATH, sha256: readmeDigest }],
    });
    expect(prestate.ok).toBe(true);

    // 2. Conflict admission: disjoint is admitted, a shared conflict key is not.
    const envelope1 = pilotEnvelope({
      taskId,
      issuedAt: T0,
      authority: [{ path: TOY_README_PATH, sha256: readmeDigest }],
      readSet: [TOY_README_PATH, TOY_SCRATCH_PATH, TOY_NOTES_PATH],
      writeSet: [],
      conflictKeys: ["p7a:pilot:primary"],
      commitPolicy: "NO_COMMIT",
    });
    const envelope2 = pilotEnvelope({
      taskId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a0d",
      issuedAt: T0,
      authority: [{ path: "other.md", sha256: "b".repeat(64) }],
      readSet: ["other.md"],
      writeSet: [],
      conflictKeys: ["p7a:pilot:disjoint"],
      commitPolicy: "NO_COMMIT",
    });
    const envelope3 = pilotEnvelope({
      taskId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a0e",
      issuedAt: T0,
      authority: [{ path: "third.md", sha256: "c".repeat(64) }],
      readSet: ["third.md"],
      writeSet: [],
      conflictKeys: ["p7a:pilot:primary"],
      commitPolicy: "NO_COMMIT",
    });

    const admit1 = checkAdmission({ admitted: [], candidate: envelope1 });
    expect(admit1.ok).toBe(true);
    if (admit1.ok) expect(admit1.compatible).toBe(true);

    const admit2 = checkAdmission({ admitted: [envelope1], candidate: envelope2 });
    expect(admit2.ok).toBe(true);
    if (admit2.ok) expect(admit2.compatible).toBe(true);

    const admit3 = checkAdmission({ admitted: [envelope1, envelope2], candidate: envelope3 });
    expect(admit3.ok).toBe(true);
    if (admit3.ok) {
      expect(admit3.compatible).toBe(false);
      expect(admit3.pairs.some((pair) => pair.kinds.includes("CONFLICT_KEY"))).toBe(true);
    }

    // 3. Lease: the packet's holder acquires it; a different holder is refused.
    const leaseId = "7a7a7a7a-0000-4000-8000-000000000001";
    const leaseGrant = acquireLease({
      leases: [],
      now: T0,
      candidate: {
        leaseId,
        worktreePath: toyDir,
        holder: PILOT_WRITER,
        acquiredAt: LEASE_ACQUIRED_AT,
        expiresAt: LEASE_EXPIRES_AT,
      },
    });
    expect(leaseGrant.ok).toBe(true);
    const grantedLease = (leaseGrant as LeaseGranted).lease;

    const secondHolder = acquireLease({
      leases: [grantedLease],
      now: T0,
      candidate: {
        leaseId: "7a7a7a7a-0000-4000-8000-000000000002",
        worktreePath: toyDir,
        holder: PILOT_VERIFIER,
        acquiredAt: LEASE_ACQUIRED_AT,
        expiresAt: LEASE_EXPIRES_AT,
      },
    });
    expect(secondHolder.ok).toBe(false);
    expect((secondHolder as EnforcementRefused).reason).toBe("LEASE_HELD_BY_ANOTHER");

    // 4. The lifecycle walk: step 0 by hand, the lease event appended as the
    // executor, then the real SqliteSupervisor for the rest of the plan.
    const inv = invocation(taskId, "a".repeat(64));
    const context = beatContext(root, ledger, inv, PILOT_WRITER, READ_ONLY_PLAN);
    appendStepZero(context);

    const leaseEvent = wrapEnforcementEvent(
      inv,
      "lease.acquired.pilot",
      "DISCOVERED",
      PILOT_WRITER,
      (leaseGrant as LeaseGranted).events[0]!,
    );
    const leaseAppend = ledger.append(leaseEvent);
    expect(leaseAppend.inserted).toBe(true);

    const supervisor = new SqliteSupervisor({
      ledger,
      invocation: inv,
      effects: toyEffects(root),
      emittedBy: PILOT_WRITER,
      commitPolicy: "NO_COMMIT",
      initiativeId: PILOT_INITIATIVE_ID,
      route: TEST_ROUTE,
    });
    const run = await supervisor.runToCheckpoint();
    expect(run.finalState).toBe("CHECKPOINTED");
    expect(run.finalState).toBe(PLAN_TERMINAL_STATE);
    expect(run.appended).toBe(READ_ONLY_PLAN.length - 1); // steps 1-8; step 0 was manual

    // 5. Read-only execution + conformance, over the real toy repository.
    const declared = [TOY_README_PATH, TOY_SCRATCH_PATH, TOY_NOTES_PATH];
    const clean = takeObservation(port, toyDir);
    const cleanVerdict = checkWriteSetConformance({
      declaredWriteSet: declared,
      observation: clean,
      lease: grantedLease,
    });
    expect(cleanVerdict.ok).toBe(true);
    if (cleanVerdict.ok) {
      expect(cleanVerdict.conformant).toBe(true);
      expect(cleanVerdict.violations).toEqual([]);
      expect(cleanVerdict.events).toEqual([]);
    }

    // ---------------------------------------------------------------------
    // Spine: the ledger's trail matches the plan step for step, no commit.
    // ---------------------------------------------------------------------
    const planTransitionIds = new Set(READ_ONLY_PLAN.map((step) => step.transitionId));
    const events = ledger.listEvents({ limit: 200 }).events.map((record) => record.event);
    const planEvents = events.filter((event) => planTransitionIds.has(event.transitionId));
    expect(planEvents.length).toBe(READ_ONLY_PLAN.length);
    for (const [index, step] of READ_ONLY_PLAN.entries()) {
      expect(planEvents[index]?.transitionId).toBe(step.transitionId);
      expect(planEvents[index]?.toState).toBe(step.toState);
      expect(planEvents[index]?.type).toBe(step.eventType);
    }
    expect(events.some((event) => event.type.startsWith("COMMIT_"))).toBe(false);
    expect(events.some((event) => event.toState === "READY_TO_COMMIT")).toBe(false);
    expect(events.some((event) => event.toState === "COMMITTED")).toBe(false);
    const leaseEvents = events.filter((event) => event.type === "LEASE_ACQUIRED");
    expect(leaseEvents.length).toBe(1);

    // The read model agrees with the trail it was built from.
    const task = ledger.getTask(taskId);
    expect(task?.currentState).toBe("CHECKPOINTED");
    const liveBefore = JSON.stringify(task);
    ledger.rebuildReadModel();
    expect(JSON.stringify(ledger.getTask(taskId))).toBe(liveBefore);

    // A real checkpoint: the last event is CHECKPOINT_WRITTEN, and the head
    // digest genuinely chains from it.
    const last = events[events.length - 1];
    expect(last?.type).toBe("CHECKPOINT_WRITTEN");
    expect(last?.toState).toBe("CHECKPOINTED");
    const status = ledger.status();
    const lastRecord = ledger.listEvents({ limit: 200 }).events.at(-1);
    expect(lastRecord?.eventSha256).toBe(status.headEventSha256);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.ok).toBe(true);
    expect(integrity.problems).toEqual([]);

    // N3: the live-lease set, folded from the ledger alone, agrees with what
    // acquireLease returned.
    const folded = foldLiveLeases(
      ledger
        .listEvents({ limit: 200 })
        .events.map((record) => ({
          type: record.event.type,
          payload: record.event.payload,
          sequence: record.sequence,
        })),
    );
    expect(folded.get(leaseId)).toEqual(grantedLease);
  });
});

// ---------------------------------------------------------------------------
// VIOLATION: the write-set fence, on a task the happy path never touches
// ---------------------------------------------------------------------------

describe("a planted violation revokes the lease and suspects the worktree", () => {
  it("fires exactly once, in order, and never advances again", async () => {
    const taskId = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a02";
    const root = scenario("p7a-violation");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const toyDir = toyRepository();
    const spawnGit = makeSpawnGit(toyDir, toyDir);
    initToyRepository(toyDir, spawnGit);
    const port = createGitReadPort(spawnGit);

    const leaseId = "7a7a7a7a-0000-4000-8000-000000000003";
    const leaseGrant = acquireLease({
      leases: [],
      now: T0,
      candidate: {
        leaseId,
        worktreePath: toyDir,
        holder: PILOT_WRITER,
        acquiredAt: LEASE_ACQUIRED_AT,
        expiresAt: LEASE_EXPIRES_AT,
      },
    });
    expect(leaseGrant.ok).toBe(true);
    const grantedLease = (leaseGrant as LeaseGranted).lease;

    const inv = invocation(taskId, "d".repeat(64));
    const context = beatContext(root, ledger, inv, PILOT_WRITER, READ_ONLY_PLAN);
    appendStepZero(context);
    const leaseAppend = ledger.append(
      wrapEnforcementEvent(inv, "lease.acquired.pilot", "DISCOVERED", PILOT_WRITER, (leaseGrant as LeaseGranted).events[0]!),
    );
    expect(leaseAppend.inserted).toBe(true);
    expect(executorCurrentState(context)).toBe("DISCOVERED");

    const declared = [TOY_README_PATH, TOY_SCRATCH_PATH, TOY_NOTES_PATH];

    // Clean first: the fence passes on zero observed drift.
    const preObservation = takeObservation(port, toyDir);
    const cleanVerdict = checkWriteSetConformance({
      declaredWriteSet: declared,
      observation: preObservation,
      lease: grantedLease,
    });
    expect(cleanVerdict.ok).toBe(true);
    if (cleanVerdict.ok) expect(cleanVerdict.conformant).toBe(true);

    // Plant, and the same real function flips the verdict.
    const planted = plantIntruder(toyDir);
    const postObservation = takeObservation(port, toyDir);
    const violationVerdict = checkWriteSetConformance({
      declaredWriteSet: declared,
      observation: postObservation,
      lease: grantedLease,
    });
    expect(violationVerdict.ok).toBe(true);
    if (!violationVerdict.ok) throw new Error("expected a conformance verdict");
    expect(violationVerdict.conformant).toBe(false);
    expect(violationVerdict.violations).toEqual([planted]);
    expect(violationVerdict.revokeLeaseId).toBe(leaseId);
    expect(violationVerdict.recommendedTaskState).toBe("SUSPECT_WORKTREE");
    expect(violationVerdict.events.map((event) => event.type)).toEqual([
      "WRITE_SET_VIOLATION_DETECTED",
      "LEASE_REVOKED",
    ]);

    // Append the module's own two events, in the order it returned them, then
    // the caller's own recommendation as a real TASK_STATE_CHANGED.
    const violationEvent = ledger.append(
      wrapEnforcementEvent(
        inv,
        "write-set.violation.detected.pilot",
        "DISCOVERED",
        PILOT_WRITER,
        violationVerdict.events[0]!,
      ),
    );
    const revokeEvent = ledger.append(
      wrapEnforcementEvent(inv, "lease.revoked.pilot", "DISCOVERED", PILOT_WRITER, violationVerdict.events[1]!),
    );
    const suspectEvent = ledger.append(
      wrapStateChange(inv, "suspect.worktree.pilot", "DISCOVERED", "SUSPECT_WORKTREE", PILOT_WRITER, {
        cause: "WRITE_SET_VIOLATION_DETECTED",
      }),
    );
    expect(violationEvent.inserted).toBe(true);
    expect(revokeEvent.inserted).toBe(true);
    expect(suspectEvent.inserted).toBe(true);

    // Exactly once each, in the right order, no cleanup performed by the
    // decision itself -- the planted file is still there.
    expect(violationEvent.record.sequence).toBeLessThan(revokeEvent.record.sequence);
    expect(revokeEvent.record.sequence).toBeLessThan(suspectEvent.record.sequence);
    const kinds = ledger.listEvents({ limit: 200 }).events.map((record) => record.event.type);
    expect(kinds.filter((type) => type === "WRITE_SET_VIOLATION_DETECTED").length).toBe(1);
    expect(kinds.filter((type) => type === "LEASE_REVOKED").length).toBe(1);
    expect(kinds.filter((type) => type === "TASK_STATE_CHANGED").length).toBe(1);

    // N2c: the task is suspect, terminal, and never advances again.
    const task = ledger.getTask(taskId);
    expect(task?.currentState).toBe("SUSPECT_WORKTREE");
    expect(task?.isTerminal).toBe(true);
    const resumed = new SqliteSupervisor({
      ledger,
      invocation: inv,
      effects: toyEffects(root),
      emittedBy: PILOT_WRITER,
      commitPolicy: "NO_COMMIT",
      initiativeId: PILOT_INITIATIVE_ID,
      route: TEST_ROUTE,
    });
    await expect(resumed.runToCheckpoint()).rejects.toThrow(LifecyclePlanError);

    // N2d: restore by deleting the planted file only, then match byte for
    // byte against the pre-plant observation. No git mutation, ever.
    rmSync(join(toyDir, planted), { force: true });
    const restored = takeObservation(port, toyDir);
    expect(restored).toEqual(preObservation);

    // N3, the terminal-revocation clause: a later LEASE_ACQUIRED for this
    // revoked id does not resurrect it in the fold.
    const resurrection = ledger.append(
      wrapEnforcementEvent(inv, "lease.acquired.resurrection.pilot", "SUSPECT_WORKTREE", PILOT_WRITER, {
        type: "LEASE_ACQUIRED",
        payload: {
          leaseId,
          worktreePath: toyDir,
          holder: PILOT_WRITER,
          acquiredAt: LEASE_EXPIRES_AT,
          expiresAt: "2026-08-29T23:00:00.000Z",
        },
      }),
    );
    expect(resurrection.inserted).toBe(true);
    const folded = foldLiveLeases(
      ledger
        .listEvents({ limit: 200 })
        .events.map((record) => ({
          type: record.event.type,
          payload: record.event.payload,
          sequence: record.sequence,
        })),
    );
    expect(folded.has(leaseId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N1: the port speaks only the four read verbs, and never a denied one
// ---------------------------------------------------------------------------

describe("the test-tree port", () => {
  it("never spawns a verb outside GIT_READ_VERBS", () => {
    const toyDir = toyRepository();
    let spawnCount = 0;
    const countingSpawnGit: SpawnGit = (args) => {
      spawnCount += 1;
      return makeSpawnGit(toyDir, toyDir)(args);
    };
    initToyRepository(toyDir, countingSpawnGit);
    spawnCount = 0;
    const port = createGitReadPort(countingSpawnGit);

    const denied = port({ verb: "commit" as never, args: ["-m", "should never run"] });
    expect(denied.ok).toBe(false);
    expect(spawnCount).toBe(0);

    const allowed = port({ verb: "ls-files", args: [] });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.stdout).toContain(TOY_README_PATH);
    expect(spawnCount).toBe(1);
  });
});
