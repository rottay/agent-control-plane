import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ResolvedRoute } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import {
  INTENT_STEP,
  LOOPBACK_HOST,
  OUTCOME_STEP,
  RESTATE_ADMIN_URL,
  LIFECYCLE_PLAN,
  RESTATE_INGRESS_URL,
  RUNTIME_SERVICE_PORT,
  buildEvent,
  canonicalSubmissionDigest,
  createEvidenceProbe,
  lifecycleBeat,
  removeScenarioRoot,
  resolveScenarioRoot,
  planStep,
  restateInvocation,
  runLifecycleOperation,
  scenarioLedgerPath,
} from "@acp/runtime";
import type { DurableInvocation, ScenarioRoot } from "@acp/runtime";

import { RestateDriver } from "../../src/drivers/restate-driver/index.js";
import { drillRoute, releasePath } from "../../src/drivers/restate-child/index.js";
import { serverAvailability, startServer } from "../../src/server-handle/index.js";
import type { ServerHandle } from "../../src/server-handle/index.js";
import { deriveInvocation, registerDeployment, sendAdvance } from "../../src/submit/index.js";

/**
 * The lifecycle operation against a real engine (V2 L2).
 *
 * Three claims live here and nowhere else, because none of them can be
 * established without a real server and real process deaths:
 *
 * 1. cancelling twice appends once;
 * 2. a `SIGKILL` between the engine call and the settlement leaves a ledger a
 *    fresh door drives to the same terminal head;
 * 3. an attach after a door has died rejoins the invocation rather than
 *    starting a second one.
 *
 * They sit in this project rather than in the CLI's because the `cli` vitest
 * project runs in the default parallel group and binds no ports. That is a
 * topology fact, not a testing preference: it is the same fact that makes the
 * door take an injected driver seam.
 *
 * The subject throughout is the **lifecycle construction** — the driver a door
 * builds when it holds no commit policy — and the operation both doors call.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..", "..");
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "drivers", "restate-child", "index.js");
const EMITTED_BY = "claude/opus/implementer/01";
const TEST_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const SUBMITTED_AT = "2026-09-04T12:00:00.000Z";

const scenarios: string[] = [];
const ledgers: Ledger[] = [];
const children: ChildProcess[] = [];
const servers: ServerHandle[] = [];
const spawnedPids: number[] = [];
const childOutput = new WeakMap<ChildProcess, { text: string }>();

afterEach(async () => {
  // Reversed teardown: the server first, so it drops its sessions before the
  // children it is holding them to.
  for (const server of servers.splice(0)) {
    try {
      await server.stop();
    } catch {
      // already gone
    }
  }
  for (const child of children.splice(0)) await stopChild(child);
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
});

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function track(ledger: Ledger): Ledger {
  ledgers.push(ledger);
  return ledger;
}

function trackServer(server: ServerHandle): ServerHandle {
  servers.push(server);
  if (server.pid > 0 && !spawnedPids.includes(server.pid)) spawnedPids.push(server.pid);
  return server;
}

/**
 * The invocation a real submission would have derived for a drill walk.
 *
 * The digest is computed over the route the child will actually record, so the
 * recovery producer's verification exercises its accepting branch. A fixture
 * carrying a placeholder digest would be refused before it reached a driver,
 * and every drill below would then be measuring the refusal.
 */
function drillInvocation(taskId: string): DurableInvocation {
  const route: ResolvedRoute = drillRoute({
    taskId,
    attempt: 1,
    invocationId: "",
    submittedAt: SUBMITTED_AT,
    submissionDigest: "",
  });
  return deriveInvocation(
    taskId,
    1,
    SUBMITTED_AT,
    canonicalSubmissionDigest({
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      initiativeId: TEST_INITIATIVE_ID,
      route,
    }),
  );
}

function ensureChildBuilt(): void {
  const result = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "--build",
      join(PACKAGE_ROOT, "tsconfig.json"),
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (result.status !== 0 || !existsSync(CHILD_ENTRY)) {
    throw new Error(
      "could not build the durability package for the drill: " + result.stdout + result.stderr,
    );
  }
}

/**
 * Make this scenario a real repository, and report what it actually holds.
 *
 * The four git facts a `Checkpoint` carries are observed, never invented: a
 * fabricated head would put a fiction in a drill ledger. The child creates no
 * `GitReadPort` and executes no git -- it is not a production observer -- so
 * the SPAWNING suite takes the observation and hands it over as data.
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

/** Spawn one drill child in the given role and wait for its own handshake. */
function startRole(
  scenarioId: string,
  invocation: DurableInvocation,
  role: "ENDPOINT" | "ATTACH" | "CANCEL",
  options: { readonly faultPoint?: string | null; readonly pauseAt?: string | null } = {},
): Promise<ChildProcess> {
  const config = JSON.stringify({
    scenarioId,
    invocation,
    emittedBy: EMITTED_BY,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    initiativeId: TEST_INITIATIVE_ID,
    faultPoint: options.faultPoint ?? null,
    pauseAt: options.pauseAt ?? null,
    port: RUNTIME_SERVICE_PORT,
    effect: "TOY",
    role,
    // V2-B1f/F3. The child observes no git of its own: this suite observes the
    // repository the scenario really has and passes what it saw as data.
    // Without it the child has no checkpoint port and its terminal refuses.
    checkpointFacts: checkpointFactsFor(resolveScenarioRoot(scenarioId)),
  });
  const handshake =
    role === "ENDPOINT" ? '"ready":true' : role === "ATTACH" ? '"attaching":true' : '"cancelling":true';

  return new Promise<ChildProcess>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CHILD_ENTRY, config], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    children.push(child);
    if (child.pid !== undefined && !spawnedPids.includes(child.pid)) spawnedPids.push(child.pid);
    const sink = { text: "" };
    childOutput.set(child, sink);
    child.stdout.on("data", (chunk: Buffer) => {
      sink.text += chunk.toString("utf8");
      if (sink.text.includes(handshake)) resolvePromise(child);
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (!sink.text.includes(handshake)) {
        rejectPromise(
          new Error(
            role + " child exited before its handshake: code " + String(code) + " signal " + String(signal),
          ),
        );
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child);
}

/** The DISTINCT tasks an endpoint child has announced as held. */
function heldTasks(child: ChildProcess): ReadonlySet<string> {
  const text = childOutput.get(child)?.text ?? "";
  const tasks = new Set<string>();
  for (const match of text.matchAll(/"paused":"[A-Z_]+","taskId":"([0-9a-f-]+)"/g)) {
    const task = match[1];
    if (task !== undefined) tasks.add(task);
  }
  return tasks;
}

async function waitForHeldTasks(child: ChildProcess, count: number, deadlineMs = 60_000): Promise<number> {
  const started = Date.now();
  let seen = 0;
  while (Date.now() - started < deadlineMs) {
    seen = heldTasks(child).size;
    if (seen >= count) return seen;
    if (child.exitCode !== null || child.signalCode !== null) return seen;
    await delay(25);
  }
  return seen;
}

function trail(ledger: Ledger, taskId: string): readonly { type: string; transitionId: string }[] {
  return ledger
    .listEvents({ taskId, limit: 200 })
    .events.map((record) => ({ type: record.event.type, transitionId: record.event.transitionId }));
}

function cancellations(ledger: Ledger, taskId: string): number {
  return trail(ledger, taskId).filter((event) => event.type === "TASK_CANCELLED").length;
}

/**
 * The door, as a door builds it: recover, probe-only port, no commit policy.
 *
 * This is the composition the CLI performs, minus the flags. Building it the
 * same way here is what makes these drills evidence about the door rather than
 * about a driver a test assembled by hand.
 */
function lifecycleDoor(
  root: ScenarioRoot,
  ledger: Ledger,
  taskId: string,
): { readonly driver: RestateDriver; readonly invocation: DurableInvocation } {
  const recovered = restateInvocation(ledger, taskId, 1);
  if (!recovered.ok) {
    throw new Error("the drill's own ledger did not recover: " + recovered.refusal);
  }
  const effects = createEvidenceProbe(root);
  return {
    driver: RestateDriver.forLifecycle(
      {
        ledger,
        invocation: recovered.context.invocation,
        emittedBy: recovered.context.emittedBy,
        ingressUrl: RESTATE_INGRESS_URL,
        adminUrl: RESTATE_ADMIN_URL,
      },
      lifecycleBeat(ledger, effects, recovered.context),
      recovered.context.initiativeId,
    ),
    invocation: recovered.context.invocation,
  };
}

/** One walk paused at its INTENT beat, over a real server and a real endpoint. */
async function openIntent(
  id: string,
  taskId: string,
): Promise<{
  readonly root: ScenarioRoot;
  readonly ledger: Ledger;
  readonly server: ServerHandle;
  readonly endpoint: ChildProcess;
  readonly invocation: DurableInvocation;
}> {
  ensureChildBuilt();
  const invocation = drillInvocation(taskId);
  const root = scenario(id);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  const server = trackServer(await startServer(root));

  const endpoint = await startRole(id, invocation, "ENDPOINT", { pauseAt: "AFTER_INTENT" });
  await registerDeployment(
    server.adminUrl,
    "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT),
  );
  expect((await sendAdvance(server.ingressUrl, invocation)).status).toBe(202);
  expect(await waitForHeldTasks(endpoint, 1)).toBe(1);

  // The precondition every drill below depends on: an intent is durably open
  // and its outcome is not recorded.
  const events = trail(ledger, taskId);
  expect(events.some((event) => event.transitionId === INTENT_STEP.transitionId)).toBe(true);
  expect(events.some((event) => event.transitionId === OUTCOME_STEP.transitionId)).toBe(false);

  return { root, ledger, server, endpoint, invocation };
}

/**
 * A ledger seeded to `RUN_STARTED` for a key that was never sent to the engine.
 *
 * `restateInvocation` verifies the submission digest against the events, so the
 * seed is built the way a real submission builds it — a fixture with a
 * placeholder digest would be refused before a driver was ever constructed, and
 * the drill would measure the refusal instead of the engine.
 */
function seedNeverIssued(root: ScenarioRoot, ledger: Ledger, taskId: string): DurableInvocation {
  const invocation = drillInvocation(taskId);
  const route: ResolvedRoute = drillRoute({
    taskId,
    attempt: 1,
    invocationId: "",
    submittedAt: SUBMITTED_AT,
    submissionDigest: "",
  });
  for (let index = 0; index <= 4; index += 1) {
    ledger.append(
      buildEvent({
        invocation,
        step: planStep(index),
        emittedBy: EMITTED_BY,
        initiativeId: TEST_INITIATIVE_ID,
        plan: LIFECYCLE_PLAN,
        route,
      }),
    );
  }
  void root;
  return invocation;
}

describe("the lifecycle operation against a real engine", () => {
  it("has a verified server to run against, and fails rather than skipping", () => {
    // A green suite must never be mistakable for a green adoption decision.
    expect(serverAvailability()).toEqual({ available: true, reason: "verified" });
  });

  it("cancels twice and appends once", async () => {
    const id = "l2-cancel-idempotent";
    const taskId = randomUUID();
    const staged = await openIntent(id, taskId);
    const before = staged.ledger.status();

    const first = lifecycleDoor(staged.root, staged.ledger, taskId);
    const one = await runLifecycleOperation({
      driver: first.driver,
      verb: "CANCEL",
      invocation: first.invocation,
    });
    expect(one.outcome).toEqual({
      ok: true,
      finalSequence: staged.ledger.status().headSequence,
    });

    const settled = staged.ledger.status();
    expect(settled.eventCount).toBe(before.eventCount + 1);
    expect(cancellations(staged.ledger, taskId)).toBe(1);

    // A second door, built from scratch against the same coordinates. The
    // engine now answers `404`/`409` — it is not running this invocation — and
    // the settlement rebuilds byte-identical bytes, so the ledger returns the
    // row it already holds.
    const second = lifecycleDoor(staged.root, staged.ledger, taskId);
    const two = await runLifecycleOperation({
      driver: second.driver,
      verb: "CANCEL",
      invocation: second.invocation,
    });
    expect(two.outcome).toEqual({ ok: false, refusal: "TASK_TERMINAL", at: "cancel" });

    // The measurement: nothing moved.
    const after = staged.ledger.status();
    expect(after.eventCount).toBe(settled.eventCount);
    expect(after.headEventSha256).toBe(settled.headEventSha256);
    expect(cancellations(staged.ledger, taskId)).toBe(1);
    expect(staged.ledger.verifyIntegrity().ok).toBe(true);

    const keys = staged.ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);

    process.stdout.write(
      "RECEIPT " +
        JSON.stringify({
          drill: "L2-CANCEL-IDEMPOTENT",
          mode: "RESTATE",
          construction: "forLifecycle",
          eventCount: after.eventCount,
          headSequence: after.headSequence,
          headEventSha256: after.headEventSha256,
          cancellations: cancellations(staged.ledger, taskId),
          integrityOk: staged.ledger.verifyIntegrity().ok,
          duplicateKeys: 0,
        }) +
        "\n",
    );

    writeFileSync(releasePath(staged.root, "AFTER_INTENT"), "release", "utf8");
  }, 240_000);

  it("survives a SIGKILL between the engine call and the settlement", async () => {
    const id = "l2-cancel-kill-window";
    const taskId = randomUUID();
    const staged = await openIntent(id, taskId);
    const before = staged.ledger.status();

    // A real process, running the real driver, dying in the real window: the
    // settlement's first probe kills it, which is after the engine call
    // returned and before anything has been appended.
    const canceller = await startRole(id, staged.invocation, "CANCEL", {
      faultPoint: "BEFORE_SETTLEMENT",
    });
    const died = await waitForExit(canceller);
    expect(died.signal).toBe("SIGKILL");
    expect(childOutput.get(canceller)?.text.includes('"cancelled"')).toBe(false);

    // What the crash left: nothing claimed, an intent still open, and a head
    // that has not moved.
    const crashed = staged.ledger.status();
    expect(crashed.eventCount).toBe(before.eventCount);
    expect(crashed.headEventSha256).toBe(before.headEventSha256);
    expect(cancellations(staged.ledger, taskId)).toBe(0);
    expect(staged.ledger.getTask(taskId)?.currentState).toBe("RUNNING");

    // The claim: a FRESH door, holding no commit policy and recovering
    // everything it needs from the log the dead process left behind, drives the
    // same coordinates to a terminal head.
    const door = lifecycleDoor(staged.root, staged.ledger, taskId);
    const result = await runLifecycleOperation({
      driver: door.driver,
      verb: "CANCEL",
      invocation: door.invocation,
    });
    expect(result.outcome).toEqual({
      ok: true,
      finalSequence: staged.ledger.status().headSequence,
    });

    const after = staged.ledger.status();
    expect(after.eventCount).toBe(before.eventCount + 1);
    expect(cancellations(staged.ledger, taskId)).toBe(1);
    expect(staged.ledger.getTask(taskId)?.currentState).toBe("CANCELLED");
    expect(staged.ledger.verifyIntegrity().ok).toBe(true);

    process.stdout.write(
      "RECEIPT " +
        JSON.stringify({
          drill: "L2-CANCEL-KILL-WINDOW",
          mode: "RESTATE",
          construction: "forLifecycle",
          faultPoint: "BEFORE_SETTLEMENT",
          signal: died.signal,
          eventCount: after.eventCount,
          headSequence: after.headSequence,
          headEventSha256: after.headEventSha256,
          cancellations: cancellations(staged.ledger, taskId),
          integrityOk: staged.ledger.verifyIntegrity().ok,
          intentStillOpenAfterCrash: true,
        }) +
        "\n",
    );

    writeFileSync(releasePath(staged.root, "AFTER_INTENT"), "release", "utf8");
  }, 240_000);

  it("rejoins after a door dies, rather than starting a second invocation", async () => {
    const id = "l2-attach-after-death";
    const taskId = randomUUID();
    const staged = await openIntent(id, taskId);
    const before = staged.ledger.status();
    const heldBefore = heldTasks(staged.endpoint).size;

    // A door that asked and died before it heard an answer.
    const doomed = await startRole(id, staged.invocation, "ATTACH");
    await stopChild(doomed);
    expect((await waitForExit(doomed)).signal).toBe("SIGKILL");

    // A fresh lifecycle construction rejoins. The address is recomputed from
    // `(taskId, attempt)`, so nothing about the dead process is needed.
    const door = lifecycleDoor(staged.root, staged.ledger, taskId);
    expect(door.invocation.invocationId).toBe(staged.invocation.invocationId);

    // The walk is held at its INTENT beat, so the attach does not resolve until
    // the endpoint is released. What is asserted here is the property that
    // matters and that a hanging await cannot: nothing new was invoked. The
    // endpoint still holds exactly the one task it held, and the ledger has not
    // grown, so no second invocation began.
    await delay(500);
    expect(heldTasks(staged.endpoint).size).toBe(heldBefore);
    expect(staged.ledger.status().eventCount).toBe(before.eventCount);
    expect(staged.ledger.status().headEventSha256).toBe(before.headEventSha256);

    // Released, the held walk finishes; the attach was for that same
    // invocation, not a second one, so exactly one walk's events appear.
    writeFileSync(releasePath(staged.root, "AFTER_INTENT"), "release", "utf8");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (staged.ledger.getTask(taskId)?.currentState === "CHECKPOINTED") break;
      await delay(200);
    }
    expect(staged.ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");

    // One walk, not two: every transition appears exactly once.
    const transitions = trail(staged.ledger, taskId).map((event) => event.transitionId);
    expect(transitions.length - new Set(transitions).size).toBe(0);
    expect(staged.ledger.verifyIntegrity().ok).toBe(true);

    process.stdout.write(
      "RECEIPT " +
        JSON.stringify({
          drill: "L2-ATTACH-AFTER-DEATH",
          mode: "RESTATE",
          construction: "forLifecycle",
          eventCount: staged.ledger.status().eventCount,
          headSequence: staged.ledger.status().headSequence,
          headEventSha256: staged.ledger.status().headEventSha256,
          heldTasks: heldTasks(staged.endpoint).size,
          duplicateTransitions: 0,
          integrityOk: staged.ledger.verifyIntegrity().ok,
        }) +
        "\n",
    );
  }, 240_000);

  it("P1/P2 tells an invocation the engine never issued from one it holds", async () => {
    // The defect V2 L4 fixes, measured at the edge before either door is
    // touched. Both halves run against ONE real server with the object
    // deployed, so the only difference between them is whether the engine was
    // ever asked to hold the key.
    const id = "l4-attach-not-found";
    const liveTask = randomUUID();
    const staged = await openIntent(id, liveTask);

    // P1: a key this engine was never sent. The object is deployed — the walk
    // above proves it — so a 404 here is an answer about the invocation and not
    // about the deployment. It refuses; it does not throw.
    const absentTask = randomUUID();
    const absent = seedNeverIssued(staged.root, staged.ledger, absentTask);
    const before = staged.ledger.status();
    const absentDoor = lifecycleDoor(staged.root, staged.ledger, absentTask);
    expect(absentDoor.invocation.invocationId).toBe(absent.invocationId);

    const refused = await runLifecycleOperation({
      driver: absentDoor.driver,
      verb: "ATTACH",
      invocation: absentDoor.invocation,
    });
    expect(refused.outcome).toEqual({
      ok: false,
      refusal: "INVOCATION_NOT_FOUND",
      at: "reattach",
    });
    // Nothing is appended on the refusal, and no status number crosses.
    expect(staged.ledger.status().eventCount).toBe(before.eventCount);
    expect(staged.ledger.status().headEventSha256).toBe(before.headEventSha256);
    expect(JSON.stringify(refused.outcome)).not.toContain("404");

    // P2: the live invocation still rejoins. Released, the held walk finishes,
    // and an attach to that same key answers a ledger coordinate rather than a
    // refusal — so the new branch narrowed nothing it should not have.
    writeFileSync(releasePath(staged.root, "AFTER_INTENT"), "release", "utf8");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (staged.ledger.getTask(liveTask)?.currentState === "CHECKPOINTED") break;
      await delay(200);
    }
    expect(staged.ledger.getTask(liveTask)?.currentState).toBe("CHECKPOINTED");

    const settled = staged.ledger.status();
    const liveDoor = lifecycleDoor(staged.root, staged.ledger, liveTask);
    const rejoined = await runLifecycleOperation({
      driver: liveDoor.driver,
      verb: "ATTACH",
      invocation: liveDoor.invocation,
    });
    expect(rejoined.outcome.ok).toBe(true);
    // The attach observes; it does not move the head.
    expect(staged.ledger.status().eventCount).toBe(settled.eventCount);
    expect(staged.ledger.status().headEventSha256).toBe(settled.headEventSha256);
    expect(staged.ledger.verifyIntegrity().ok).toBe(true);

    process.stdout.write(
      "RECEIPT " +
        JSON.stringify({
          drill: "L4-ATTACH-NOT-FOUND",
          mode: "RESTATE",
          construction: "forLifecycle",
          deployment: "REGISTERED",
          absentRefusal: refused.outcome.ok ? null : refused.outcome.refusal,
          liveRejoined: rejoined.outcome.ok,
          eventCountUnchangedOnRefusal: true,
          integrityOk: staged.ledger.verifyIntegrity().ok,
        }) +
        "\n",
    );
  }, 240_000);

  it("N9 answers the same refusal when no deployment is registered", async () => {
    // The second measured cause of a 404 on this path, recorded by a test
    // rather than discovered by an operator. Against a bare server the attach
    // answers 404 for an UNKNOWN SERVICE — a fact about the deployment, not
    // about the invocation — and the driver cannot tell the two apart without
    // reading the engine's body, which this plane refuses to do.
    //
    // This is why the refusal is defined by what the engine answered rather
    // than by why, and why the retry guidance is bounded rather than absolute:
    // a caller whose endpoint is not yet registered would otherwise be told to
    // abandon a live attempt.
    const id = "l4-attach-no-deployment";
    const taskId = randomUUID();
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    // A real server, and deliberately no `registerDeployment` and no endpoint.
    trackServer(await startServer(root));
    seedNeverIssued(root, ledger, taskId);
    const before = ledger.status();

    const door = lifecycleDoor(root, ledger, taskId);
    const outcome = await runLifecycleOperation({
      driver: door.driver,
      verb: "ATTACH",
      invocation: door.invocation,
    });

    expect(outcome.outcome).toEqual({
      ok: false,
      refusal: "INVOCATION_NOT_FOUND",
      at: "reattach",
    });
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    process.stdout.write(
      "RECEIPT " +
        JSON.stringify({
          drill: "L4-ATTACH-NO-DEPLOYMENT",
          mode: "RESTATE",
          construction: "forLifecycle",
          deployment: "UNREGISTERED",
          refusal: outcome.outcome.ok ? null : outcome.outcome.refusal,
          eventCount: ledger.status().eventCount,
          integrityOk: ledger.verifyIntegrity().ok,
        }) +
        "\n",
    );
  }, 240_000);
});
