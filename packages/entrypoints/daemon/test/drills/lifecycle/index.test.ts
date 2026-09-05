import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_VERSION, buildIdempotencyKey } from "@acp/contracts";
import type {
  Checkpoint,
  CommitPolicy,
  DriverCapabilityState,
  ResolvedRoute,
} from "@acp/contracts";
import {
  RestateDriver,
  createAcpTaskObject,
  deriveInvocation,
  registerDeployment,
  startEndpoint,
  startVerifiedServer,
  submitAdvance,
} from "@acp/durability";
import type { EndpointHandle, SafeServerHandle } from "@acp/durability";
import { createCheckpointStore, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import {
  OUTCOME_STEP,
  RUNTIME_SERVICE_PORT,
  RUNTIME_SERVICE_URL,
  SqliteSupervisor,
  deriveEventCoordinate,
  deterministicUuid,
  planFor,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";
import type {
  CheckpointPort,
  CheckpointRefused,
  CheckpointSource,
  DurableInvocation,
  EffectPort,
  OperationCoordinate,
  PostconditionVerdict,
  ScenarioRoot,
} from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { StartupError } from "../../../src/errors/index.js";
import { UnwindStack } from "../../../src/lifecycle/index.js";
import { beatFor, startRestateMode } from "../../../src/mode-restate/index.js";

/**
 * V2-B2-5G — the durable gate, measured through the endpoint an operator starts.
 *
 * **Why this suite exists at all.** V2-B2-5 landed the gate whole and drilled it
 * six ways against the pinned server, and every one of those drills registered
 * `AcpGate` through `packages/edges/durability/src/drivers/restate-child/index.ts`
 * — the DRILL child. `startRestateMode`, which is the only endpoint an operator
 * can start, registered the Virtual Object and nothing else. So the plane
 * shipped `SIGNAL: "SUPPORTED"` over an ingress that answered a release with
 * "no such service", and no test in the repository could see it: the durability
 * drills were measuring a service the assembled system did not host.
 *
 * That is the defect these files exist to catch, so the drills belong HERE, in
 * the daemon, and not beside the ones that missed it. Every drill below drives
 * `startRestateMode` itself — the same function the daemon calls at S5 through
 * S8 — against a real pinned server, and reaches the gate and the timer through
 * `RestateDriver`, which is the port the domain declares. Nothing is stubbed on
 * the path under test.
 *
 * **The endpoint runs in THIS process, and that is a measurement advantage
 * rather than a compromise.** `startEndpoint` binds an HTTP/2 listener in the
 * caller's process, so the object's beats execute here and the effect port is
 * an object this file holds. A drill that had to infer "the walk ran once" from
 * marker files on disk can be told directly how many distinct operations were
 * applied. The processes that must be real still are: the Restate server is the
 * pinned external binary, and G3 kills it with an actual signal.
 *
 * **What is deliberately not re-drilled.** The gate's own semantics — shared
 * resolve, run-before-park, the intended gate among two, the awakeable design's
 * failure — are V2-B2-5's drills and they are untouched by this packet. Copying
 * them here would double the wall clock to re-prove a property whose source did
 * not move. What is new is reachability, and everything below is an assertion
 * about that.
 */

/**
 * The emitter, in the grammar the contract enforces.
 *
 * `<provider>/<model>/<role>/<instance>`, lowercase, instance two to four
 * DIGITS. Measured rather than assumed: this file first carried the packet's
 * own worker name, `claude/opus/implementer/lifecycle-04`, and every walk
 * refused it with a terminal validation error at the INTENT append. That is the
 * contract working — an identity is a fact the ledger records — and it is why
 * the constant is the same one every other drill in this package uses.
 */
const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c01";
const SUBMITTED_AT = "2026-09-04T12:00:00.000Z";
const COMMIT_POLICY: CommitPolicy = "LOCAL_COMMIT_WITH_RECEIPT";

/**
 * One admitted route for every fixture here (V2-B1c).
 *
 * Required and never defaulted, and it satisfies the contract's own refinement:
 * a `CLI_SUBSCRIPTION` route names a provider the kernel lists as one.
 */
const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: SUBMITTED_AT,
};

/**
 * The shapes an engine-minted identity takes, and none of them may appear.
 *
 * `inv_…` is what `/send` answers with and what `/restate/lookup` returns;
 * `awk_1…` and `sign_1…` are the awakeable identifiers the REJECTED gate design
 * would have had to carry. The gate this repository built mints none of them,
 * so these patterns are how "it never learned one" is asserted rather than
 * asserted about.
 */
const ENGINE_INVOCATION_ID_SHAPE = /inv_[A-Za-z0-9]{10,}/;
const ENGINE_AWAKEABLE_SHAPE = /awk_1|sign_1/;

// ---------------------------------------------------------------------------
// Fixtures, each of which cleans up after itself
// ---------------------------------------------------------------------------

const scenarios: string[] = [];
const ledgers: Ledger[] = [];
const stacks: UnwindStack[] = [];
const extraServers: SafeServerHandle[] = [];
const extraEndpoints: EndpointHandle[] = [];

afterEach(async () => {
  // Reverse acquisition order, exactly as the daemon unwinds: the endpoint is
  // released before the server, because Restate holds persistent HTTP/2
  // sessions open and closing the listener under a live one is what P2C proved
  // will hang.
  // The narrowed endpoint G3 binds last is closed FIRST, because it holds the
  // pinned service port the next drill will bind.
  for (const endpoint of extraEndpoints.splice(0)) {
    try {
      await endpoint.close(10_000);
    } catch {
      // already closed
    }
  }
  for (const stack of stacks.splice(0)) await stack.unwindAll();
  // A server this file started outside the stack — G3's replacement — is
  // stopped by the handle it was given, never by a pattern match across the
  // machine.
  for (const server of extraServers.splice(0)) {
    try {
      await server.stop("SIGTERM", 15_000);
    } catch {
      // already gone
    }
  }
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

/**
 * The effect port, counting what it was actually asked to do.
 *
 * Two numbers, and the distinction is what makes the once-only claims
 * measurable rather than inferred. `distinct` is how many operation coordinates
 * were ever applied — the same thing a marker file on disk records, and the
 * number a second WALK would move. `applications` is how many times `apply` was
 * called, which additionally counts a re-execution of the same coordinate.
 *
 * The drills assert on `distinct` and merely REPORT `applications`, and that is
 * deliberate rather than lax. Restate's own contract is at-least-once around a
 * journaled action, so a legitimate engine retry may re-run an effect that has
 * not yet become durable; a drill asserting `applications === distinct` would be
 * asserting something the engine never promised and would flake on the day it
 * exercised the guarantee it does make. What must not happen is a second walk,
 * and `distinct` plus the ledger's own event count is what says so.
 *
 * `probe` answers from the same record, so the walk's postcondition check
 * measures this port rather than a constant. A stub that always answered `DONE`
 * would let a walk that applied nothing look complete.
 */
interface CountingEffects {
  readonly port: EffectPort;
  distinct(): number;
  applications(): number;
}

function countingEffects(): CountingEffects {
  const applied = new Map<string, number>();
  // `operationId` is the contract's own words: "stable identity the effect's
  // postcondition probe can be asked about". Keying on it rather than on the
  // whole coordinate means this port answers the question the port was defined
  // to answer, and a coordinate that gained a field would not silently turn one
  // operation into two.
  const key = (operation: OperationCoordinate): string => operation.operationId;

  return {
    port: {
      apply: (operation: OperationCoordinate): Promise<void> => {
        const at = key(operation);
        applied.set(at, (applied.get(at) ?? 0) + 1);
        return Promise.resolve();
      },
      probe: (operation: OperationCoordinate): Promise<PostconditionVerdict> =>
        Promise.resolve(applied.has(key(operation)) ? "DONE" : "NOT_DONE"),
    },
    distinct: () => applied.size,
    applications: () => [...applied.values()].reduce((total, count) => total + count, 0),
  };
}

function invocationFor(taskId: string, seed: string): DurableInvocation {
  return deriveInvocation(taskId, 1, SUBMITTED_AT, seed.repeat(64).slice(0, 64));
}

interface Plane {
  readonly ledger: Ledger;
  readonly server: SafeServerHandle;
  readonly endpoint: EndpointHandle;
  readonly effects: CountingEffects;
  readonly driver: RestateDriver;
  readonly phases: readonly string[];
  readonly root: ScenarioRoot;
  /** Carried so a later endpoint can rebuild the same beat, checkpoints and all. */
  readonly invocation: DurableInvocation;
}

/**
 * Start the production Restate mode, and build the port over what it started.
 *
 * `beatFor` and `startRestateMode` are both the daemon's own, imported rather
 * than reimplemented: a fixture that assembled its own beat would be measuring
 * a plane the daemon does not run, which is exactly the mistake this suite
 * exists to correct.
 */
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

async function startPlane(name: string, invocation: DurableInvocation): Promise<Plane> {
  const root = scenario(name);
  const ledger = track(openLedger(scenarioLedgerPath(root)));
  const effects = countingEffects();
  const stack = new UnwindStack();
  stacks.push(stack);
  const phases: string[] = [];

  const handles = await startRestateMode({
    ledger,
    invocation,
    scenarioRoot: root,
    emittedBy: EMITTED_BY,
    commitPolicy: COMMIT_POLICY,
    initiativeId: INITIATIVE_ID,
    effects: effects.port,
    // A factory: this endpoint serves more than one invocation, and each
    // walk's checkpoint is assembled from its own coordinates.
    checkpoints: (candidate) =>
      drillCheckpoints({
        ledger,
        invocation: candidate,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
    route: TEST_ROUTE,
    stack,
    onPhase: (phase) => {
      phases.push(phase);
    },
  });

  const driver = new RestateDriver(
    {
      ledger,
      invocation,
      emittedBy: EMITTED_BY,
      ingressUrl: handles.server.ingressUrl,
      adminUrl: handles.server.adminUrl,
    },
    beatFor(
      ledger,
      EMITTED_BY,
      effects.port,
      TEST_ROUTE,
      (candidate) =>
        drillCheckpoints({
          ledger,
          invocation: candidate,
          emittedBy: EMITTED_BY,
          ledgerPath: scenarioLedgerPath(root),
          worktree: root,
        }),
    ),
    COMMIT_POLICY,
    INITIATIVE_ID,
  );

  return {
    ledger,
    server: handles.server,
    endpoint: handles.endpoint,
    effects,
    driver,
    phases,
    root,
    invocation,
  };
}

/**
 * Hold a gate open: the BLOCKING `run`, deliberately not `run/send`.
 *
 * No `idempotency-key` header, and that is the engine's rule rather than a
 * preference — a workflow handler is idempotent by its key already, and the
 * pinned server refuses an explicit one. The derived invocation id is still the
 * authority here; it is carried as the workflow KEY rather than as a header.
 *
 * The returned promise settles only when the gate is released, which is the
 * whole point: a park asserted by a `202` would prove the request was accepted,
 * not that anything waited.
 */
function holdGate(
  ingressUrl: string,
  invocation: DurableInvocation,
): Promise<{ readonly status: number; readonly body: string }> {
  return fetch(ingressUrl + "/AcpGate/" + invocation.invocationId + "/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(invocation),
    signal: AbortSignal.timeout(180_000),
  })
    .then(async (response) => ({ status: response.status, body: await response.text() }))
    // A transport failure SETTLES this request, so it is folded into the same
    // shape rather than rejected. Two reasons, and neither is leniency: an
    // unawaited rejection during teardown is an unhandled error vitest reports
    // as a second, unrelated failure, and `status: 0` still fails every
    // assertion below — a gate that died is not a gate that released.
    .catch((error: unknown) => ({
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    }));
}

/** Wait on a LEDGER CONDITION, never on elapsed time. */
async function waitForState(
  ledger: Ledger,
  taskId: string,
  state: string,
  deadlineMs = 120_000,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (ledger.getTask(taskId)?.currentState === state) return true;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return false;
}

function duplicateKeys(ledger: Ledger): number {
  const keys = ledger.listEvents({ limit: 500 }).events.map((record) => record.event.idempotencyKey);
  return keys.length - new Set(keys).size;
}

function trailOf(ledger: Ledger, taskId: string): number {
  return ledger.listEvents({ taskId, limit: 500 }).events.length;
}

interface DrillReceipt {
  readonly drill: string;
  readonly [field: string]: unknown;
}

function emitReceipt(receipt: DrillReceipt): void {
  process.stdout.write("RECEIPT " + JSON.stringify(receipt) + "\n");
}

// ---------------------------------------------------------------------------
// The drills
// ---------------------------------------------------------------------------

describe("V2-B2-5G: the production endpoint serves the durable gate", () => {
  it("G1 releases a gate held on the endpoint the daemon started, and appends nothing", async () => {
    const invocation = invocationFor(randomUUID(), "a");
    const plane = await startPlane("daemon-gate-served", invocation);

    // The order the daemon publishes, and readiness is RECONCILED rather than
    // SERVER_UP: an endpoint hosting a service nobody registered would have
    // failed at DEPLOYMENT_REGISTERED, so reaching RECONCILED is already part
    // of the claim.
    expect(plane.phases).toEqual([
      "BINARY_VERIFIED",
      "SERVER_UP",
      "ENDPOINT_UP",
      "DEPLOYMENT_REGISTERED",
      "RECONCILED",
    ]);

    // Held, not sent. If `AcpGate` were not registered on this endpoint the
    // ingress would answer that there is no such service and this promise would
    // settle immediately with a 4xx — which is precisely what it did before
    // this packet, and is the regression this line catches.
    let settled = false;
    const held = holdGate(plane.server.ingressUrl, invocation).then((result) => {
      settled = true;
      return result;
    });

    // The discriminator. A bare wait cannot tell "parked" from "slow", so a
    // DIFFERENT task is driven all the way to CHECKPOINTED on the same
    // endpoint. The window is then demonstrably wide enough for a whole plan to
    // run, and the gate still holding is evidence rather than an absence of it.
    const beside = invocationFor(randomUUID(), "b");
    expect((await submitAdvance(plane.server.ingressUrl, beside, 120_000)).status).toBe(200);
    expect(await waitForState(plane.ledger, beside.taskId, "CHECKPOINTED")).toBe(true);
    expect(settled).toBe(false);

    // The verb, over the port the domain declares. One request, addressed by
    // the id this side derived before ingress.
    const before = plane.ledger.status();
    expect(await plane.driver.signal(invocation)).toEqual({ ok: true });

    const release = await held;
    expect(release.status).toBe(200);
    expect(release.body).toContain('"released":true');

    // Waiting is not a lifecycle transition, so the log did not move and the
    // gate's task does not exist: the gate holds no fact and cannot invent one.
    const after = plane.ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headSequence).toBe(before.headSequence);
    expect(after.headEventSha256).toBe(before.headEventSha256);
    expect(plane.ledger.getTask(invocation.taskId)).toBeNull();
    expect(trailOf(plane.ledger, invocation.taskId)).toBe(0);
    expect(plane.ledger.verifyIntegrity().problems).toEqual([]);
    expect(duplicateKeys(plane.ledger)).toBe(0);

    emitReceipt({
      drill: "PRODUCTION-GATE-SERVED",
      mode: "RESTATE",
      endpoint: "startRestateMode",
      gatesHeld: 1,
      gatesReleased: 1,
      besideCompleted: true,
      eventCount: after.eventCount,
      headSequence: after.headSequence,
      headEventSha256: after.headEventSha256,
      integrityOk: plane.ledger.verifyIntegrity().ok,
      duplicateKeys: 0,
    });
  }, 300_000);

  it("G2 releasing twice is one release: the verb replays and the head is unchanged", async () => {
    const invocation = invocationFor(randomUUID(), "c");
    const plane = await startPlane("daemon-gate-repeat", invocation);

    let settled = false;
    const held = holdGate(plane.server.ingressUrl, invocation).then((result) => {
      settled = true;
      return result;
    });

    const beside = invocationFor(randomUUID(), "d");
    expect((await submitAdvance(plane.server.ingressUrl, beside, 120_000)).status).toBe(200);
    expect(await waitForState(plane.ledger, beside.taskId, "CHECKPOINTED")).toBe(true);
    expect(settled).toBe(false);

    const before = plane.ledger.status();
    expect(await plane.driver.signal(invocation)).toEqual({ ok: true });
    expect((await held).status).toBe(200);

    // The verb a second time. It sends the DERIVED invocation id as the
    // idempotency key, so this is the same call rather than a second one: the
    // engine replays its first answer and a caller that retried after a
    // timeout gets a truthful `ok` instead of a spurious failure. Measured
    // against the pinned server, never assumed.
    expect(await plane.driver.signal(invocation)).toEqual({ ok: true });

    // And a genuinely second release — the same request WITHOUT the key, so
    // nothing can replay it — is the engine's conflict, which is the answer
    // that must not be laundered into success anywhere.
    const raw = await fetch(
      plane.server.ingressUrl + "/AcpGate/" + invocation.invocationId + "/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ released: true }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const rawBody = await raw.text();
    expect(raw.status).toBe(409);

    // Three releases attempted, one release performed, and the ledger is where
    // it was before any of them: the head is the assertion, in both fields,
    // because a sequence that matched while the digest did not would be a
    // rewritten log rather than an untouched one.
    const after = plane.ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headSequence).toBe(before.headSequence);
    expect(after.headEventSha256).toBe(before.headEventSha256);
    expect(plane.ledger.getTask(invocation.taskId)).toBeNull();
    expect(plane.ledger.verifyIntegrity().problems).toEqual([]);
    expect(duplicateKeys(plane.ledger)).toBe(0);

    // The engine's refusal text is the engine's, and nothing keeps it: the
    // driver reports the STATUS, never the body, and the body itself carries no
    // minted identity a surface could pick up.
    expect(rawBody).not.toMatch(ENGINE_INVOCATION_ID_SHAPE);
    expect(rawBody).not.toMatch(ENGINE_AWAKEABLE_SHAPE);

    emitReceipt({
      drill: "PRODUCTION-GATE-REPEAT-RELEASE",
      mode: "RESTATE",
      endpoint: "startRestateMode",
      verbReleases: 2,
      rawReleaseStatus: raw.status,
      headSequence: after.headSequence,
      headEventSha256: after.headEventSha256,
      headUnchanged: true,
      integrityOk: plane.ledger.verifyIntegrity().ok,
      duplicateKeys: 0,
    });
  }, 300_000);

  it("G3 the durable timer survives the server's SIGKILL and a restart on the same data root", async () => {
    const invocation = invocationFor(randomUUID(), "e");
    const plane = await startPlane("daemon-gate-timer-kill", invocation);

    // The deployment `startRestateMode` registered at S7, read back over the
    // admin API so the comparison after the restart is against a value the
    // engine minted rather than one this file invented.
    const deployments = (await fetch(plane.server.adminUrl + "/deployments", {
      signal: AbortSignal.timeout(30_000),
    }).then((response) => response.json())) as {
      readonly deployments: readonly { readonly id: string }[];
    };
    expect(deployments.deployments).toHaveLength(1);
    const firstDeploymentId = deployments.deployments[0]?.id ?? "";
    expect(firstDeploymentId).not.toBe("");

    // Long enough that the schedule cannot plausibly fire before the kill, and
    // the emptiness below is asserted immediately rather than hoped for.
    expect(await plane.driver.timer(invocation, 20_000)).toEqual({ ok: true });
    expect(trailOf(plane.ledger, invocation.taskId)).toBe(0);
    expect(plane.effects.distinct()).toBe(0);

    // The drill that separates an ENGINE-held timer from a client-held one: the
    // process that accepted the schedule is destroyed outright. The endpoint
    // stays up in this process, so what is being tested is the server's durable
    // state and nothing else.
    const killed = await plane.server.stop("SIGKILL", 15_000);
    expect(killed.signal).toBe("SIGKILL");

    // Same scenario root, therefore the same data root, therefore whatever the
    // engine durably kept.
    const second = await startVerifiedServer(plane.root);
    extraServers.push(second);

    // What `force: false` actually does against a root that already holds this
    // deployment, measured rather than predicted. The packet's brief expected a
    // `409`; the pinned server answers **200** and hands back the SAME
    // deployment id, because a re-registration of an IDENTICAL service set is
    // idempotent. That is the better answer — a daemon restarted on its own
    // root starts — and the prediction that failed is recorded here and in ADR
    // 0027 rather than quietly replaced.
    //
    // The body is also the strongest evidence this packet has, because it is
    // the ENGINE's own enumeration of what the production endpoint serves, read
    // back over the admin API. It names both services with the handler kinds
    // the design requires: a gate whose `resolve` had become exclusive, or an
    // object that had grown a third handler, would be visible right here.
    const reregistration = await registerDeployment(second.adminUrl, RUNTIME_SERVICE_URL);
    expect(reregistration.ok).toBe(true);
    expect(reregistration.status).toBe(200);
    const registered = JSON.parse(reregistration.body) as {
      readonly id: string;
      readonly services: readonly {
        readonly name: string;
        readonly ty: string;
        readonly handlers: readonly { readonly name: string; readonly ty: string }[];
      }[];
    };
    expect(registered.id).toBe(firstDeploymentId);
    expect(registered.services.map((service) => service.name + ":" + service.ty).sort()).toEqual([
      "AcpGate:Workflow",
      "AcpTask:VirtualObject",
    ]);
    const gate = registered.services.find((service) => service.name === "AcpGate");
    expect(gate?.handlers.map((handler) => handler.name + ":" + handler.ty).sort()).toEqual([
      "resolve:Shared",
      "run:Workflow",
    ]);

    // The timer fires against the endpoint that never died, and the walk it
    // schedules lands in the ledger.
    expect(await waitForState(plane.ledger, invocation.taskId, "CHECKPOINTED")).toBe(true);
    const head = plane.ledger.status();
    expect(head.eventCount).toBe(planFor(COMMIT_POLICY).length);
    expect(plane.ledger.verifyIntegrity().problems).toEqual([]);
    expect(duplicateKeys(plane.ledger)).toBe(0);

    // The projection is derived, so it must rebuild to the same thing.
    const live = JSON.stringify(plane.ledger.getTask(invocation.taskId));
    plane.ledger.rebuildReadModel();
    expect(JSON.stringify(plane.ledger.getTask(invocation.taskId))).toBe(live);

    // The case the brief was reaching for, produced on purpose: a CHANGED
    // service set behind the SAME URI. The production endpoint is closed and a
    // narrowed one — the task object alone, exactly what this endpoint served
    // before this packet — is bound on the same pinned port.
    //
    // The brief predicted `409`. What the pinned server actually does is
    // neither that nor a replacement: it answers **200 with the deployment it
    // already had**, having performed no discovery at all. `force: false` means
    // "do not replace", and it reports success while doing nothing — so the
    // registry below still lists BOTH services although nothing behind that URI
    // serves the gate any more.
    //
    // This is the engine behaviour that makes S7's second act necessary, and it
    // is measured here so the act is answering something real: a data root
    // registered by a build that served only `AcpTask` keeps serving only
    // `AcpTask`, and registering against it succeeds. G7 below is the other
    // half — a daemon started on exactly such a root, refusing.
    //
    // Last in the drill, after every assertion above, so a deliberately
    // narrowed endpoint cannot affect anything that was measured.
    expect((await plane.endpoint.close(10_000)).graceful).toBe(true);
    const narrowed = await startEndpoint({
      services: [
        createAcpTaskObject({
          beat: beatFor(
            plane.ledger,
            EMITTED_BY,
            plane.effects.port,
            TEST_ROUTE,
            (candidate) =>
              drillCheckpoints({
                ledger: plane.ledger,
                invocation: candidate,
                emittedBy: EMITTED_BY,
                ledgerPath: scenarioLedgerPath(plane.root),
                worktree: plane.root,
              }),
          ),
          commitPolicy: COMMIT_POLICY,
          initiativeId: INITIATIVE_ID,
          ledger: plane.ledger,
        }),
      ],
      port: RUNTIME_SERVICE_PORT,
    });
    extraEndpoints.push(narrowed);
    const narrowedRegistration = await registerDeployment(second.adminUrl, RUNTIME_SERVICE_URL);
    expect(narrowedRegistration.ok).toBe(true);
    expect(narrowedRegistration.status).toBe(200);
    expect((JSON.parse(narrowedRegistration.body) as { readonly id: string }).id).toBe(
      firstDeploymentId,
    );

    // The registry, read back rather than inferred. One deployment, the
    // original id, and both services still listed — which is the proof that no
    // discovery ran and that the engine's view can now disagree with what the
    // URI serves.
    const afterNarrow = (await fetch(second.adminUrl + "/deployments", {
      signal: AbortSignal.timeout(30_000),
    }).then((response) => response.json())) as {
      readonly deployments: readonly {
        readonly id: string;
        readonly services: readonly { readonly name: string }[];
      }[];
    };
    expect(afterNarrow.deployments).toHaveLength(1);
    expect(afterNarrow.deployments[0]?.id).toBe(firstDeploymentId);
    expect(afterNarrow.deployments[0]?.services.map((service) => service.name).sort()).toEqual([
      "AcpGate",
      "AcpTask",
    ]);

    emitReceipt({
      drill: "PRODUCTION-TIMER-SERVER-DEATH",
      mode: "RESTATE",
      endpoint: "startRestateMode",
      signal: killed.signal,
      timerDelay: "PT20S",
      reregistrationStatus: reregistration.status,
      reregistrationIdStable: true,
      servicesRegistered: registered.services.length,
      narrowedRegistrationStatus: narrowedRegistration.status,
      narrowedRegistrationRediscovered: false,
      registryServicesAfterNarrowing: 2,
      distinctOperations: plane.effects.distinct(),
      effectApplications: plane.effects.applications(),
      eventCount: head.eventCount,
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      integrityOk: plane.ledger.verifyIntegrity().ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
    });
  }, 300_000);

  it("G4 scheduling the same walk twice is one walk: identical head, integrity intact", async () => {
    const invocation = invocationFor(randomUUID(), "f");
    const plane = await startPlane("daemon-gate-timer-twice", invocation);

    // Both through the verb, so what is measured is the port a caller holds
    // rather than the helper underneath it. The derived idempotency key is what
    // makes the second call the same call.
    expect(await plane.driver.timer(invocation, 3_000)).toEqual({ ok: true });
    expect(await plane.driver.timer(invocation, 3_000)).toEqual({ ok: true });

    expect(await waitForState(plane.ledger, invocation.taskId, "CHECKPOINTED")).toBe(true);
    const head = plane.ledger.status();

    // One walk's worth of events, and one application per operation the plan
    // performs. A second scheduled walk would have moved both.
    expect(head.eventCount).toBe(planFor(COMMIT_POLICY).length);
    expect(trailOf(plane.ledger, invocation.taskId)).toBe(planFor(COMMIT_POLICY).length);
    const distinctAfterFirst = plane.effects.distinct();
    expect(distinctAfterFirst).toBeGreaterThan(0);
    expect(duplicateKeys(plane.ledger)).toBe(0);
    expect(plane.ledger.verifyIntegrity().problems).toEqual([]);

    // The window a second firing would have landed in, established by work
    // rather than by a sleep: another task is driven to completion on the same
    // endpoint after the delay has fully elapsed. The delayed task's head is
    // then compared against itself.
    const beside = invocationFor(randomUUID(), "0");
    expect((await submitAdvance(plane.server.ingressUrl, beside, 120_000)).status).toBe(200);
    expect(await waitForState(plane.ledger, beside.taskId, "CHECKPOINTED")).toBe(true);

    // Identical head for the delayed task: same trail length, same terminal
    // state, same distinct effect set, and the log's integrity unaffected by
    // any of it.
    expect(trailOf(plane.ledger, invocation.taskId)).toBe(planFor(COMMIT_POLICY).length);
    expect(plane.ledger.getTask(invocation.taskId)?.currentState).toBe("CHECKPOINTED");
    expect(plane.effects.distinct()).toBe(distinctAfterFirst * 2);
    expect(duplicateKeys(plane.ledger)).toBe(0);
    expect(plane.ledger.verifyIntegrity().ok).toBe(true);

    emitReceipt({
      drill: "PRODUCTION-TIMER-IDEMPOTENT",
      mode: "RESTATE",
      endpoint: "startRestateMode",
      schedules: 2,
      timerDelay: "PT3S",
      delayedTaskTrail: trailOf(plane.ledger, invocation.taskId),
      distinctOperations: distinctAfterFirst,
      effectApplications: plane.effects.applications(),
      eventCount: head.eventCount,
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      integrityOk: plane.ledger.verifyIntegrity().ok,
      duplicateKeys: 0,
    });
  }, 300_000);

  it("G5 SQLITE_SUPERVISOR still refuses all four verbs, with zero capability mismatch", async () => {
    // The other mode the daemon can be started in, and the reason this drill is
    // in the same file as the ones above: what the plane now guarantees is that
    // a caller can ASK a driver what it can do and act on the answer. That is
    // only true if the answer is right in both directions — a `SUPPORTED` the
    // assembled system cannot honour was the defect this packet closes, and an
    // `UNSUPPORTED` that silently worked would be the same error mirrored.
    const root = scenario("daemon-gate-sqlite-refusal");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const invocation = invocationFor(randomUUID(), "9");
    const effects = countingEffects();

    const supervisor = new SqliteSupervisor({
      ledger,
      invocation,
      effects: effects.port,
      emittedBy: EMITTED_BY,
      commitPolicy: COMMIT_POLICY,
      initiativeId: INITIATIVE_ID,
      route: TEST_ROUTE,
    });

    const declared = supervisor.capabilities();
    const observed = {
      CANCEL: await supervisor.cancel(),
      REATTACH: await supervisor.reattach(),
      SIGNAL: await supervisor.signal(),
      TIMER: await supervisor.timer(),
    } as const;

    // Field by field, never a throw and never a silent no-op: a throw would
    // make "unsupported" indistinguishable from "broke", and a no-op would let
    // a caller believe the work happened.
    expect(observed.CANCEL).toEqual({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "cancel" });
    expect(observed.REATTACH).toEqual({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "reattach" });
    expect(observed.SIGNAL).toEqual({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "signal" });
    expect(observed.TIMER).toEqual({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "timer" });

    // The mismatch table, computed rather than eyeballed. A verb is mismatched
    // when the declaration and the behaviour disagree in EITHER direction:
    // declared `UNSUPPORTED` while answering something other than the refusal,
    // or declared `SUPPORTED` while refusing with it. Naming both directions is
    // what makes the count worth asserting.
    const verbs = ["CANCEL", "REATTACH", "SIGNAL", "TIMER"] as const;
    const mismatches = verbs.filter((verb) => {
      const state: DriverCapabilityState = declared.verbs[verb];
      const outcome = observed[verb];
      const refused = !outcome.ok && outcome.refusal === "CAPABILITY_UNSUPPORTED";
      return state === "UNSUPPORTED" ? !refused : refused;
    });
    expect(mismatches).toEqual([]);
    expect(declared.mode).toBe("SQLITE_SUPERVISOR");

    // It did not quietly delegate to the other driver — which would make the
    // mode flag a lie — and asking cost nothing: no event, no effect.
    expect(ledger.status().eventCount).toBe(0);
    expect(effects.applications()).toBe(0);

    emitReceipt({
      drill: "SQLITE-CAPABILITY-MISMATCH",
      mode: "SQLITE_SUPERVISOR",
      verbsChecked: verbs.length,
      capabilityMismatches: mismatches.length,
      eventCount: ledger.status().eventCount,
      effectApplications: 0,
      integrityOk: ledger.verifyIntegrity().ok,
    });
  }, 120_000);

  it("G6 no engine-minted identity reaches a surface, a refusal, or a thrown message", async () => {
    const invocation = invocationFor(randomUUID(), "8");
    const plane = await startPlane("daemon-gate-no-identity", invocation);

    // A completed walk, so the surfaces below have real content to sweep.
    expect((await submitAdvance(plane.server.ingressUrl, invocation, 120_000)).status).toBe(200);
    expect(await waitForState(plane.ledger, invocation.taskId, "CHECKPOINTED")).toBe(true);

    // A gate released on the production endpoint, so the signal path has run.
    const signalled = await plane.driver.signal(invocation);
    expect(signalled).toEqual({ ok: true });

    // One thrown message, and it is the "refused before the wire" kind. A
    // message is unbounded text, so it is the surface most likely to leak.
    const errors: string[] = [];
    await expect(plane.driver.timer(invocation, -1)).rejects.toThrow();
    await plane.driver.timer(invocation, -1).catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
    });
    expect(errors).toHaveLength(1);

    // The engine's own answer is no longer a thrown message. Since V2 L4 a real
    // 404 on the attach path — a key this engine never issued — arrives as a
    // closed refusal rather than as a status-bearing throw, so it is swept as a
    // surface below instead of as text. The closed outcome has no field an
    // engine string could occupy, and the regexes prove that rather than
    // assume it.
    const neverIssued = invocationFor(randomUUID(), "7");
    const forgotten = await plane.driver.reattach(neverIssued);
    expect(forgotten).toEqual({
      ok: false,
      refusal: "INVOCATION_NOT_FOUND",
      at: "reattach",
    });

    const surfaces: readonly (readonly [string, unknown])[] = [
      ["signal outcome", signalled],
      ["thrown messages", errors],
      ["reattach refusal", forgotten],
      ["events", plane.ledger.listEvents({ limit: 500 }).events.map((record) => record.event)],
      ["task read model", plane.ledger.getTask(invocation.taskId)],
      ["task list", plane.ledger.listTasks().tasks],
      ["driver status", await plane.driver.status()],
      ["reconciliation report", await plane.driver.reconcile()],
      ["published phases", plane.phases],
    ];
    for (const [name, surface] of surfaces) {
      const serialized = JSON.stringify(surface);
      expect({ name, leaked: ENGINE_INVOCATION_ID_SHAPE.test(serialized) }).toEqual({
        name,
        leaked: false,
      });
      expect({ name, leaked: ENGINE_AWAKEABLE_SHAPE.test(serialized) }).toEqual({
        name,
        leaked: false,
      });
    }

    // And what IS there is the address this side derived, which the ledger owns.
    expect(
      JSON.stringify(
        plane.ledger
          .listEvents({ taskId: invocation.taskId, limit: 500 })
          .events.map((record) => record.event),
      ),
    ).toContain(invocation.invocationId);

    emitReceipt({
      drill: "PRODUCTION-GATE-NO-ENGINE-IDENTITY",
      mode: "RESTATE",
      endpoint: "startRestateMode",
      // The COUNT of surfaces swept, never the identity: a receipt naming what
      // it looked for would be the leak it exists to deny.
      surfacesSwept: surfaces.length,
      messagesSwept: errors.length,
      eventCount: plane.ledger.status().eventCount,
      headSequence: plane.ledger.status().headSequence,
      integrityOk: plane.ledger.verifyIntegrity().ok,
      duplicateKeys: duplicateKeys(plane.ledger),
    });
  }, 300_000);

  it("G7 refuses to start on a data root whose registration does not serve the gate", async () => {
    // The closed invariant, exercised against the exact situation that would
    // otherwise resurrect this packet's defect.
    //
    // A root is prepared the way an older build would have left it: a server on
    // that root, an endpoint serving ONLY the task object at the pinned URI, and
    // a registration. Both are then shut down, leaving nothing behind but the
    // data root and what it durably kept.
    const root = scenario("daemon-gate-stale-root");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const effects = countingEffects();
    const invocation = invocationFor(randomUUID(), "6");

    const older = await startVerifiedServer(root);
    extraServers.push(older);
    const narrowEndpoint = await startEndpoint({
      services: [
        createAcpTaskObject({
          beat: beatFor(
            ledger,
            EMITTED_BY,
            effects.port,
            TEST_ROUTE,
            (candidate) =>
              drillCheckpoints({
                ledger,
                invocation: candidate,
                emittedBy: EMITTED_BY,
                ledgerPath: scenarioLedgerPath(root),
                worktree: root,
              }),
          ),
          commitPolicy: COMMIT_POLICY,
          initiativeId: INITIATIVE_ID,
          ledger,
        }),
      ],
      port: RUNTIME_SERVICE_PORT,
    });
    extraEndpoints.push(narrowEndpoint);

    const stale = await registerDeployment(older.adminUrl, RUNTIME_SERVICE_URL);
    expect(stale.ok).toBe(true);
    // The root now knows one service, and the drill asserts that rather than
    // assuming it: if this said two, the refusal below would prove nothing.
    expect(
      (JSON.parse(stale.body) as { readonly services: readonly { readonly name: string }[] }).services.map(
        (service) => service.name,
      ),
    ).toEqual(["AcpTask"]);

    expect((await narrowEndpoint.close(10_000)).graceful).toBe(true);
    extraEndpoints.splice(0);
    await older.stop("SIGTERM", 15_000);
    extraServers.splice(0);

    // And now this build's daemon, on that root. It verifies the binary, starts
    // the server, starts an endpoint hosting BOTH services, registers — and the
    // engine hands back the one-service deployment it already had, because
    // `force: false` does not rediscover. S7 refuses.
    const stack = new UnwindStack();
    stacks.push(stack);
    const phases: string[] = [];
    const refusal = await startRestateMode({
      ledger,
      invocation,
      scenarioRoot: root,
      emittedBy: EMITTED_BY,
      commitPolicy: COMMIT_POLICY,
      initiativeId: INITIATIVE_ID,
      effects: effects.port,
      route: TEST_ROUTE,
      stack,
      onPhase: (phase) => {
        phases.push(phase);
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(StartupError);
    const message = refusal instanceof Error ? refusal.message : "";
    // It names the service the engine will not route, so an operator is told
    // what is wrong rather than that something is.
    expect(message).toContain("AcpGate");
    // And it names no engine identity: the status travels, the body does not.
    expect(message).not.toMatch(ENGINE_INVOCATION_ID_SHAPE);
    expect(message).not.toMatch(ENGINE_AWAKEABLE_SHAPE);

    // It refused BEFORE announcing the phase, before reconciling and before
    // readiness. The published sequence is the assertion: a `DEPLOYMENT_REGISTERED`
    // here would have told a status reader the deployment was good.
    expect(phases).toEqual(["BINARY_VERIFIED", "SERVER_UP", "ENDPOINT_UP"]);

    // Nothing was submitted and nothing was appended: the refusal is before any
    // work, which is what "fails closed" has to mean to be worth anything.
    expect(ledger.status().eventCount).toBe(0);
    expect(effects.applications()).toBe(0);

    // What it DID take, it gives back. Reverse order, and both of them.
    expect([...stack.acquired]).toEqual(["restate-server", "endpoint"]);
    const unwound = await stack.unwindAll();
    expect(unwound.failures).toEqual([]);
    expect(unwound.released).toEqual(["endpoint", "restate-server"]);

    emitReceipt({
      drill: "PRODUCTION-STALE-ROOT-REFUSED",
      mode: "RESTATE",
      endpoint: "startRestateMode",
      staleRegistrationServices: 1,
      staleRegistrationStatus: stale.status,
      refusedWith: "StartupError",
      phasesBeforeRefusal: phases.length,
      eventCount: 0,
      effectApplications: 0,
      releasedInReverse: true,
      integrityOk: ledger.verifyIntegrity().ok,
    });
  }, 300_000);
});
