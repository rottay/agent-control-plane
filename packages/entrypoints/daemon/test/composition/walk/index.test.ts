import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  ExecutionEvent,
  ExecutionRequest,
  ExecutionSession,
  ModelExecutionPort,
  ResolvedRoute,
  SwitchAuthorization,
  TaskEnvelope,
} from "@acp/contracts";
import { CONTRACT_VERSION } from "@acp/contracts";
import { artifactRootFor, openLeaseStore, openLedger, readArtifact } from "@acp/ledger";
import type { Ledger, LeaseStore } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { BeatContext, DurableInvocation, ScenarioRoot } from "@acp/runtime";
import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  appendPlanStep,
  deriveInvocation,
  deterministicUuid,
  operationForStep,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";

import { createArbiter } from "../../../src/arbiter/index.js";
import type { LeaseHold } from "../../../src/arbiter/index.js";
import type { DaemonExecutionConfig } from "../../../src/daemon-child/index.js";
import { buildWalkEffects, runComposedSqliteWalk } from "../../../src/composition/walk/index.js";

/**
 * The instruction content for a fixture whose prose is `text` (P-06/B, ADR 0094).
 *
 * One text block, so the envelope's `objective` equals the first text block of its
 * content and the two spellings stay one fact. `contentSha256` is a placeholder:
 * escalón B admits and publishes, and escalón C is where a digest is checked
 * against the bytes it describes.
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


/**
 * The walk-equivalence fixture (P-13, escalón 2, adjudication d), and the
 * wrapper's own coverage (DT adjudication V11.1).
 *
 * Both inline construction sites — the singular walk and each scheduled walk —
 * collapsed into the one `buildWalkEffects` builder. This fixture is the
 * equivalence evidence: the three scenarios the two sites used to serve (the
 * singular walk, the scheduled walk after a landing, and a walk whose trail
 * carries a single recordable item) run over the SAME builder against a real
 * drill ledger, and every expectation below is written by hand — the durable
 * names spelled out from the schemes the runtime documents (`usage.` +
 * generation + operation index + step index; `pressure.` + operation index +
 * trail position), the payload shapes field by field. Nothing here is compared
 * against the previous implementation; a regression in the builder shows up as
 * a row that differs from a string this file wrote down itself.
 *
 * The second describe answers the DT's V11 correction: the builder is only
 * half of what the two call sites collapsed into, and a fixture that stopped
 * at `buildWalkEffects` would leave the WRAPPER — `runComposedSqliteWalk`, the
 * one `runSqliteMode({` literal, with the checkpoint port, the switch port and
 * the lease it closes over — proven by nothing but the drills that spawn a
 * real child. So the same three cases run through the wrapper itself, over a
 * real drill ledger, a real fenced lease and a real git worktree, with a fake
 * execution port and no provider anywhere. The oracle is written by hand in
 * exactly the same way: the plan's own event types in the plan's own order,
 * the durable names spelled from their documented schemes, and the checkpoint
 * read back out of the artifact store and compared field by field against what
 * this file put in the worktree.
 */

const AT = "2026-08-30T15:00:00.000Z";
const EMITTED_BY = "kimi/k3/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a13";
const INSTRUCTIONS = "compose the walk the fixture asked for, written by hand";

/**
 * One admitted route for every scenario (V2-B1c). A route is required, never
 * defaulted, so every construction site states one.
 */
const ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-walk-equivalence",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: AT,
};

interface FakeScript {
  readonly events: readonly ExecutionEvent[];
}

/** A port that records the request it was started with and speaks a script. */
function fakePort(script: FakeScript, seen: ExecutionRequest[]): ModelExecutionPort {
  return {
    start: (route, request) => {
      seen.push(request);
      const events = script.events;
      const session: ExecutionSession = {
        ok: true,
        sessionId: request.taskId + "/" + String(request.attempt) + "/" + route.accountId,
        route,
        // eslint-disable-next-line @typescript-eslint/require-await
        events: async function* (): AsyncIterable<ExecutionEvent> {
          for (const event of events) yield event;
        },
      };
      return Promise.resolve(session);
    },
    interrupt: () => Promise.resolve(),
    healthProbe: () =>
      Promise.resolve({ status: "UNKNOWN" as const, checkedAt: AT, latencyMs: null, classifiedError: null }),
  };
}

const scenarios: string[] = [];
const ledgers: Ledger[] = [];

function stage(name: string, taskId: string, generation: number, events: readonly ExecutionEvent[]) {
  scenarios.push(name);
  const root = resolveScenarioRoot(name);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const invocation: DurableInvocation = {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("inv/" + taskId),
    submittedAt: "2026-08-27T12:00:00.000Z",
    submissionDigest: "e".repeat(64),
  };
  const requests: ExecutionRequest[] = [];
  const gateCalls: number[] = [];
  const effects = buildWalkEffects({
    port: fakePort({ events }, requests),
    route: ROUTE,
    ledger,
    invocation,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    emittedBy: EMITTED_BY,
    instructions: INSTRUCTIONS,
    scenarioRoot: root,
    generation,
    gate: (operationIndex) => {
      gateCalls.push(operationIndex);
    },
  });
  // The walk records against history; it never opens a task (N1). Opening this
  // fixture's task with the plan's own discovered step is the fixture's hand,
  // not the builder's.
  const context: BeatContext = {
    ledger,
    effects,
    invocation,
    emittedBy: EMITTED_BY,
    initiativeId: INITIATIVE_ID,
    plan: LIFECYCLE_PLAN,
    route: ROUTE,
  };
  for (const step of LIFECYCLE_PLAN.slice(0, 1)) appendPlanStep(context, step);
  return { root, ledger, invocation, effects, requests, gateCalls };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
});

describe("the one walk construction, proven against a hand-written oracle", () => {
  it("walk único: the singular form records spend under generation zero", async () => {
    const staged = stage(
      "p13-walk-singular",
      "b1f00000-0000-4000-8000-000000000001",
      0,
      [
        { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
        { kind: "usage", stepIndex: 1, tokensUsed: 55 },
        { kind: "completed", stepIndex: 1 },
      ],
    );

    await staged.effects.apply(operationForStep(staged.invocation, INTENT_STEP));

    // Hand-written oracle. The operation is the plan's intent step (index 4),
    // the trail's usage entry reports step 1 and 55 tokens, and the walk is
    // unlanded, so the durable spend name is generation 0, operation 4, step 1
    // — and the payload is the elected account with the port's own number.
    const spend = staged.ledger
      .listEvents({ limit: 50 })
      .events.filter((record) => record.event.type === "TOKEN_USAGE_RECORDED");
    expect(spend.map((record) => ({ transitionId: record.event.transitionId, payload: record.event.payload }))).toEqual([
      { transitionId: "usage.0.4.1", payload: { accountId: "acct-walk-equivalence", tokens: 55 } },
    ]);

    // The gate the walk asks before marking the operation done is the caller's
    // own closure, asked once, at the operation's own plan index.
    expect(staged.gateCalls).toEqual([4]);
    // The instruction the port was started with is the one the caller passed,
    // verbatim — the builder decides nothing about what the model is told.
    expect(staged.requests.map((request) => request.instructions)).toEqual([INSTRUCTIONS]);
  });

  it("agendado: the scheduled form records the same walk under the landing generation", async () => {
    const staged = stage(
      "p13-walk-scheduled",
      "b1f00000-0000-4000-8000-000000000002",
      1,
      [
        { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
        { kind: "usage", stepIndex: 1, tokensUsed: 55 },
        { kind: "completed", stepIndex: 1 },
      ],
    );

    await staged.effects.apply(operationForStep(staged.invocation, INTENT_STEP));

    // The same builder, the same trail, but the landing has answered: the
    // destination re-executes the same operation at the same step indices, so
    // the generation leads the durable name and the rows cannot collide with
    // the source walk's under one idempotency key.
    const spend = staged.ledger
      .listEvents({ limit: 50 })
      .events.filter((record) => record.event.type === "TOKEN_USAGE_RECORDED");
    expect(spend.map((record) => ({ transitionId: record.event.transitionId, payload: record.event.payload }))).toEqual([
      { transitionId: "usage.1.4.1", payload: { accountId: "acct-walk-equivalence", tokens: 55 } },
    ]);
    expect(staged.gateCalls).toEqual([4]);
  });

  it("un ítem: one recordable pressure frame is one row, at its own trail position", async () => {
    const staged = stage(
      "p13-walk-one-item",
      "b1f00000-0000-4000-8000-000000000003",
      0,
      [
        { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
        { kind: "pressure", provider: "codex", pressure: "QUOTA_EXHAUSTED" },
        { kind: "pressure", provider: "codex", pressure: "TRANSIENT" },
        { kind: "completed", stepIndex: 0 },
      ],
    );

    await staged.effects.apply(operationForStep(staged.invocation, INTENT_STEP));

    // Hand-written oracle. The exhaustion rides the trail at position 1 and
    // lands under QUOTA_WARNING, named pressure, operation 4, trail position 1,
    // carrying the provider that classified the frame. The transient frame at
    // position 2 has no destination by design: it is a lawful observation that
    // says nothing about the account, and it appends nothing.
    const pressure = staged.ledger
      .listEvents({ limit: 50 })
      .events.filter((record) => record.event.type === "QUOTA_WARNING");
    expect(
      pressure.map((record) => ({ transitionId: record.event.transitionId, payload: record.event.payload })),
    ).toEqual([
      {
        transitionId: "pressure.4.1",
        payload: { accountId: "acct-walk-equivalence", provider: "codex", pressure: "QUOTA_EXHAUSTED" },
      },
    ]);
    expect(staged.gateCalls).toEqual([4]);
  });
});

// ---------------------------------------------------------------------------
// The wrapper: runComposedSqliteWalk, end to end (DT adjudication V11.1)
// ---------------------------------------------------------------------------

/** The instant every fixture value below is derived from. Nothing reads a clock. */
const WALK_AT = "2026-08-30T15:00:00.000Z";
/** The one path every fixture envelope declares, and the only one its walk touches. */
const DECLARED_PATH = "src/walk.ts";

const worktrees: string[] = [];
const leaseStores: LeaseStore[] = [];

/**
 * A real git worktree, because the checkpoint the wrapper composes observes one.
 *
 * `checkpointsFor` reads the tree through the git port — status, then
 * `rev-parse` for the branch — and digests every declared path against it, so a
 * directory that is not a repository cannot produce a checkpoint at all. A
 * temporary directory, never this repository.
 */
function worktree(): string {
  const created = resolve(mkdtempSync(join(tmpdir(), "acp-p13-walk-")));
  worktrees.push(created);
  const git = (...args: string[]): void => {
    spawnSync("/usr/bin/git", args, { cwd: created, encoding: "utf8" });
  };
  git("init", "--quiet");
  git("config", "user.email", "drill@example.invalid");
  git("config", "user.name", "drill");
  mkdirSync(join(created, "src"), { recursive: true });
  writeFileSync(join(created, "src", "walk.ts"), "export const walked = true;\n", "utf8");
  git("add", "-A");
  git("commit", "--allow-empty", "-q", "-m", "fixture base");
  return created;
}

/**
 * The packet's envelope. The write-set names the one path the worktree holds,
 * because the checkpoint digests every declared entry against the tree and an
 * undeclarable path would refuse `PATH_MISSING` — the honest answer, and not
 * what this fixture is drilling.
 */
function envelopeFor(taskId: string): TaskEnvelope {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    initiativeId: INITIATIVE_ID,
    title: "a P-13 walk-composition packet",
    objective: INSTRUCTIONS,
    content: fixtureContent(INSTRUCTIONS),
    classification: "MECHANICAL",
    issuedBy: EMITTED_BY,
    issuedAt: WALK_AT,
    authority: [],
    readSet: [],
    writeSet: [DECLARED_PATH],
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
 * The execution the wrapper is handed.
 *
 * The wrapper never admits a binary — `executionPortFor` runs at the caller's
 * site and the port arrives built — so these entries exist for exactly what the
 * wrapper reads them for: `switchPortFor`'s destination set and the routed
 * entry's provider. Two CLI accounts, so a destination has somewhere to be.
 */
function executionFor(
  workdir: string,
  authorization?: SwitchAuthorization,
): DaemonExecutionConfig {
  const limits = { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 };
  return {
    route: ROUTE,
    bindings: [
      {
        accountId: ROUTE.accountId,
        transportKind: "CLI_SUBSCRIPTION",
        provider: "claude",
        binary: join(workdir, "fake-provider"),
        configRoot: workdir,
        workdir,
        limits,
      },
      {
        accountId: "acct-walk-destination",
        transportKind: "CLI_SUBSCRIPTION",
        provider: "claude",
        binary: join(workdir, "fake-provider"),
        configRoot: workdir,
        workdir,
        limits,
      },
    ],
    ...(authorization === undefined ? {} : { switchAuthorization: authorization }),
  } as DaemonExecutionConfig;
}

/**
 * A real fenced lease over the fixture's worktree.
 *
 * The wrapper's switch port closes over `hold.lease`, so the grant has to be a
 * real one: a hand-written struct would let the revocation name a lease no
 * store ever granted, which is the exact fabrication the arbiter exists to
 * prevent. The inspector is a fake and the clock is injected — this fixture
 * asks `ps` nothing and sleeps for nothing — and the arbiter's own lease events
 * stay queued, because nothing here flushes them, so the walk's trail is the
 * plan's and not the arbiter's.
 */
async function leaseOver(
  ledger: Ledger,
  invocation: DurableInvocation,
  worktreePath: string,
): Promise<LeaseHold> {
  const directory = resolve(mkdtempSync(join(tmpdir(), "acp-p13-lease-")));
  worktrees.push(directory);
  const store = openLeaseStore(join(directory, "leases.sqlite"));
  leaseStores.push(store);
  const acquisition = await createArbiter({
    store,
    ledger,
    invocation,
    worktreePath,
    holder: EMITTED_BY,
    identity: { pid: 4242, startToken: "token-1", argvDigest: "digest-1" },
    inspector: { inspect: () => Promise.resolve({ startToken: "token-1", argvDigest: "digest-1" }) },
    ttlMs: 60_000,
    now: () => WALK_AT,
  }).acquire();
  if (!acquisition.ok) throw new Error("the fixture could not take its own lease: " + acquisition.reason);
  return acquisition.hold;
}

/** The trail a walk that reaches its checkpoint speaks, in order. */
const COMPLETING_TRAIL: readonly ExecutionEvent[] = Object.freeze([
  { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
  { kind: "usage", stepIndex: 1, tokensUsed: 55 },
  { kind: "completed", stepIndex: 1 },
]);

/**
 * A trail that reports an exhaustion and then fails.
 *
 * The pressure rides the stream at trail position 1 and the terminal is an
 * `error`, so the effect records what it observed and THEN throws — which is
 * the order that makes a settling failure carry an observation the switch port
 * can fold.
 */
const EXHAUSTED_TRAIL: readonly ExecutionEvent[] = Object.freeze([
  { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
  { kind: "pressure", provider: "claude", pressure: "QUOTA_EXHAUSTED" },
  { kind: "error", refusal: "TRANSPORT_UNAVAILABLE", detail: "the fixture's transport refused" },
]);

interface Composed {
  readonly root: ScenarioRoot;
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly worktreePath: string;
  readonly hold: LeaseHold;
  readonly gateCalls: number[];
  readonly requests: ExecutionRequest[];
  readonly execution: DaemonExecutionConfig;
}

/**
 * Everything one wrapper call needs, assembled the way the root assembles it.
 *
 * The port and the gate are deliberately NOT here: the root builds both at its
 * own call site and hands them in, and the wrapper builds neither — so the
 * fixture passes them at the call below, exactly as the two production callers
 * do.
 */
async function compose(
  name: string,
  taskId: string,
  authorization?: SwitchAuthorization,
): Promise<Composed> {
  scenarios.push(name);
  const root = resolveScenarioRoot(name);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const invocation = deriveInvocation(taskId, 1, WALK_AT, "e".repeat(64));
  const worktreePath = worktree();
  return {
    root,
    ledger,
    invocation,
    worktreePath,
    hold: await leaseOver(ledger, invocation, worktreePath),
    gateCalls: [],
    requests: [],
    execution: executionFor(worktreePath, authorization),
  };
}

/** The wrapper call itself, with the landing's two answers named by the caller. */
function walkOf(
  composed: Composed,
  events: readonly ExecutionEvent[],
  landing: { readonly generation: number; readonly landed: boolean },
): ReturnType<typeof runComposedSqliteWalk> {
  return runComposedSqliteWalk({
    ledger: composed.ledger,
    invocation: composed.invocation,
    execution: composed.execution,
    envelope: envelopeFor(composed.invocation.taskId),
    scenarioRoot: composed.root,
    worktreePath: composed.worktreePath,
    port: fakePort({ events }, composed.requests),
    route: ROUTE,
    generation: landing.generation,
    landed: landing.landed,
    hold: composed.hold,
    gate: (operationIndex) => {
      composed.gateCalls.push(operationIndex);
    },
    instructions: INSTRUCTIONS,
    taskId: composed.invocation.taskId,
    attempt: composed.invocation.attempt,
    emittedBy: EMITTED_BY,
    initiativeId: INITIATIVE_ID,
  });
}

/** Every event this walk appended, oldest first. */
function rowsOf(ledger: Ledger): readonly {
  readonly type: string;
  readonly transitionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}[] {
  return ledger.listEvents({ limit: 200 }).events.map((entry) => entry.event);
}

afterEach(() => {
  for (const store of leaseStores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const directory of worktrees.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("the one walk composition, drilled through the wrapper", () => {
  /**
   * The plan's own event types, in the plan's own order. Written from
   * `LIFECYCLE_PLAN` rather than from a run, so a plan that changes fails this
   * fixture instead of quietly re-baselining it.
   */
  const PLAN_TYPES = LIFECYCLE_PLAN.map((step) => step.eventType);
  /** Riders on the task's thread: recorded against the walk, never steps of it. */
  const RIDERS = ["TOKEN_USAGE_RECORDED"];

  it("walk único: the singular form walks to its checkpoint, and the checkpoint names this worktree", async () => {
    const composed = await compose(
      "p13-wrapper-singular",
      "c13f0000-0000-4000-8000-000000000001",
    );

    const result = await walkOf(composed, COMPLETING_TRAIL, { generation: 0, landed: false });

    // Hand-written oracle. The plan has eleven steps and this walk appends all
    // of them exactly once, replaying none, reconciling CONSISTENT against a
    // ledger it has not moved yet, and finishing in the plan's own last state.
    expect(result).toEqual({
      verdict: "CONSISTENT",
      finalState: "CHECKPOINTED",
      appended: LIFECYCLE_PLAN.length,
      replayed: 0,
    });

    const rows = rowsOf(composed.ledger);
    expect(rows.filter((row) => !RIDERS.includes(row.type)).map((row) => row.type)).toEqual(PLAN_TYPES);

    // The spend the wrapper's own effects recorded, under the unlanded
    // generation: operation 4 is the plan's INTENT step, step 1 is the trail's
    // own usage position.
    expect(
      rows
        .filter((row) => row.type === "TOKEN_USAGE_RECORDED")
        .map((row) => ({ transitionId: row.transitionId, payload: row.payload })),
    ).toEqual([
      { transitionId: "usage.0.4.1", payload: { accountId: ROUTE.accountId, tokens: 55 } },
    ]);

    // The gate is the caller's own closure, asked once, at the operation's own
    // plan index — the wrapper composes no second one.
    expect(composed.gateCalls).toEqual([4]);
    // And the instruction the port was started with is the caller's, verbatim.
    expect(composed.requests.map((request) => request.instructions)).toEqual([INSTRUCTIONS]);

    // The checkpoint port the wrapper composed, read back out of the artifact
    // store by the digest the ledger row names. This is the evidence that
    // `checkpointsFor` — and not some default — produced what the walk claimed.
    const written = rows.find((row) => row.type === "CHECKPOINT_WRITTEN");
    const digest = written?.payload["checkpointDigest"];
    expect(typeof digest).toBe("string");
    const artifact = readArtifact(
      artifactRootFor(scenarioLedgerPath(composed.root)),
      digest as string,
    );
    expect(artifact.ok).toBe(true);
    const checkpoint = JSON.parse(artifact.ok ? artifact.content : "{}") as {
      readonly taskId: string;
      readonly worker: string;
      readonly git: { readonly worktreePath: string; readonly isDirty: boolean };
      readonly writeSetDigest: readonly { readonly path: string }[];
      readonly nextSafeAction: string;
      readonly receipts: readonly unknown[];
      readonly pendingWork: readonly unknown[];
    };
    expect({
      taskId: checkpoint.taskId,
      worker: checkpoint.worker,
      worktreePath: checkpoint.git.worktreePath,
      declared: checkpoint.writeSetDigest.map((entry) => entry.path),
      nextSafeAction: checkpoint.nextSafeAction,
      receipts: checkpoint.receipts,
      pendingWork: checkpoint.pendingWork,
    }).toEqual({
      taskId: composed.invocation.taskId,
      worker: EMITTED_BY,
      worktreePath: composed.worktreePath,
      declared: [DECLARED_PATH],
      nextSafeAction: "Await the next owner-authorized action.",
      receipts: [],
      pendingWork: [],
    });
  }, 60_000);

  it("agendado: a scheduled walk after its landing runs the same wrapper under the landing generation", async () => {
    const composed = await compose(
      "p13-wrapper-scheduled",
      "c13f0000-0000-4000-8000-000000000002",
    );

    // The landing has answered: generation one, and landed, which is the
    // scheduled form's own dispatch after a switch has been finished.
    const result = await walkOf(composed, COMPLETING_TRAIL, { generation: 1, landed: true });

    expect(result).toEqual({
      verdict: "CONSISTENT",
      finalState: "CHECKPOINTED",
      appended: LIFECYCLE_PLAN.length,
      replayed: 0,
    });

    const rows = rowsOf(composed.ledger);
    expect(rows.filter((row) => !RIDERS.includes(row.type)).map((row) => row.type)).toEqual(PLAN_TYPES);
    // The generation leads the durable name, so the destination's rows cannot
    // collide with the source walk's under one idempotency key.
    expect(rows.filter((row) => row.type === "TOKEN_USAGE_RECORDED").map((row) => row.transitionId)).toEqual([
      "usage.1.4.1",
    ]);
    expect(composed.gateCalls).toEqual([4]);
  }, 60_000);

  it("de un ítem: a scheduled set of cardinality one reaches the same trail as the singular form", async () => {
    const composed = await compose(
      "p13-wrapper-one-item",
      "c13f0000-0000-4000-8000-000000000003",
    );

    // A set of one is admitted through the scheduler's gates and then runs the
    // singular seam — which is only true if the seam is the same wrapper. It
    // is, so the trail is the singular form's, name for name.
    const result = await walkOf(composed, COMPLETING_TRAIL, { generation: 0, landed: false });

    expect(result).toEqual({
      verdict: "CONSISTENT",
      finalState: "CHECKPOINTED",
      appended: LIFECYCLE_PLAN.length,
      replayed: 0,
    });
    const rows = rowsOf(composed.ledger);
    expect(rows.filter((row) => !RIDERS.includes(row.type)).map((row) => row.type)).toEqual(PLAN_TYPES);
    expect(rows.filter((row) => row.type === "TOKEN_USAGE_RECORDED").map((row) => row.transitionId)).toEqual([
      "usage.0.4.1",
    ]);
    expect(composed.gateCalls).toEqual([4]);
  }, 60_000);
});

/**
 * The authorization a fixture switch is played from.
 *
 * Decided elsewhere and admitted through the config door, exactly as the
 * production one is: nothing here decides a switch, and the trigger this
 * fixture's trail reports is what makes the decided plan applicable.
 */
function fixtureAuthorization(): SwitchAuthorization {
  return {
    trigger: "QUOTA_EXHAUSTED",
    decidedForAccountId: ROUTE.accountId,
    decidedBy: EMITTED_BY,
    decidedAt: WALK_AT,
    decidedFromEventId: deterministicUuid("p13/wrapper/decided-from"),
    observedSince: WALK_AT,
    plan: {
      kind: "SWITCH",
      accountStatus: "EXHAUSTED",
      taskState: "QUOTA_BLOCKED",
      steps: ["MARK_TASK_QUOTA_BLOCKED", "RELEASE_LEASE", "SELECT_ACCOUNT"],
      selectedAccountId: "acct-walk-destination",
      events: [
        { type: "QUOTA_WARNING", payload: { accountId: ROUTE.accountId } },
        { type: "TASK_STATE_CHANGED", payload: { toState: "QUOTA_BLOCKED" } },
        { type: "LEASE_REVOKED", payload: { accountId: ROUTE.accountId } },
        {
          type: "ACCOUNT_SWITCH_STARTED",
          payload: { fromAccountId: ROUTE.accountId, toAccountId: "acct-walk-destination" },
        },
      ],
    },
  } as unknown as SwitchAuthorization;
}

describe("the wrapper's switch port carries the lease this walk actually holds", () => {
  it("an unlanded walk composes one, and the revocation names the granted lease", async () => {
    const composed = await compose(
      "p13-wrapper-switch",
      "c13f0000-0000-4000-8000-000000000004",
      fixtureAuthorization(),
    );

    // The trail reports an exhaustion and then refuses, so the failure settles
    // by classification — and a settling failure is the only thing the
    // supervisor offers to a switch port at all.
    await expect(walkOf(composed, EXHAUSTED_TRAIL, { generation: 0, landed: false })).rejects.toThrow();

    const rows = rowsOf(composed.ledger);
    // Hand-written oracle: the four rows the admitted plan declares, in the
    // executor's own order, named by its own scheme.
    expect(rows.filter((row) => row.transitionId.startsWith("switch.")).map((row) => row.transitionId)).toEqual([
      "switch.0.quota_warning",
      "switch.1.task_state_changed",
      "switch.2.lease_revoked",
      "switch.3.account_switch_started",
    ]);

    // The lease named in the revocation is the one the arbiter granted this
    // fixture — not one the executor invented — which is the whole reason the
    // wrapper closes the switch port over `hold.lease` rather than over a
    // serialized copy of it.
    const revoked = rows.find((row) => row.transitionId === "switch.2.lease_revoked");
    expect({ leaseId: revoked?.payload["leaseId"], cause: revoked?.payload["cause"] }).toEqual({
      leaseId: composed.hold.lease.leaseId,
      cause: "ACCOUNT_SWITCH",
    });

    // And the walk did NOT settle: the attempt is blocked awaiting a landing,
    // and a terminal event here would foreclose it.
    const types = rows.map((row) => row.type);
    expect(types).not.toContain("TASK_FAILED");
    expect(types).not.toContain("CHECKPOINT_WRITTEN");
  }, 60_000);

  it("a landed walk composes none, so the same failure settles instead", async () => {
    const composed = await compose(
      "p13-wrapper-switch-landed",
      "c13f0000-0000-4000-8000-000000000005",
      fixtureAuthorization(),
    );

    // One landed attempt may not initiate a second switch. Same config, same
    // authorization, same trail — the landing is the only thing that differs,
    // and it is what suppresses the port.
    await expect(walkOf(composed, EXHAUSTED_TRAIL, { generation: 1, landed: true })).rejects.toThrow();

    const rows = rowsOf(composed.ledger);
    expect(rows.filter((row) => row.transitionId.startsWith("switch."))).toEqual([]);
    const failed = rows.find((row) => row.type === "TASK_FAILED");
    expect(failed?.payload["reason"]).toBe("EXECUTION_FAILED");
  }, 60_000);
});
