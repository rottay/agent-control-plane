import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_VERSION, ControlPlaneEvent, buildIdempotencyKey } from "@acp/contracts";
import type { Checkpoint, ResolvedRoute, TaskState } from "@acp/contracts";
import { createCheckpointStore, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import {
  CANCELLATION_EFFECTS,
  CANCELLATION_TRANSITION_ID,
  CANCELLATION_VERDICTS,
  cancellationPrecheck,
  settleCancellation,
} from "../../src/cancellation/index.js";
import type { DurableInvocation, OperationCoordinate, PostconditionVerdict } from "../../src/contracts/index.js";
import { deriveEventCoordinate, deterministicUuid } from "../../src/core/coordinates/index.js";
import { operationForStep } from "../../src/core/events/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN, OUTCOME_STEP } from "../../src/core/lifecycle/index.js";
import {
  appendPlanStep,
  applyIntentEffect,
  closeIntent,
  nextStep,
} from "../../src/core/step-executor/index.js";
import type { BeatContext, EffectPort } from "../../src/core/step-executor/index.js";
import type {
  CheckpointPort,
  CheckpointRefused,
  CheckpointSource,
} from "../../src/checkpoint/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import {
  applyEffect,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";

/**
 * Evidence for cancellation as a ledger settlement (V2-B2-4b).
 *
 * The load-bearing properties are all about what is NOT written. A cancel that
 * appends one row on a `NOT_DONE` effect is unremarkable; a cancel that
 * appends nothing over an `UNKNOWN` one, refuses a task that has already
 * ended, and never performs the effect it was asked to abandon is the whole
 * design. So every positive here is paired with a count of what the log grew
 * by, and the `UNKNOWN` case carries its own restore: with the probe removed,
 * the same input starts appending an invalid claim.
 *
 * Nothing here starts a server or an engine. Stopping an engine is the edge's
 * act and its drills are in `@acp/durability`; this file is the policy.
 */

/** One admitted route for every fixture in this file (V2-B1c). */
const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

const TEST_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const EMITTED_BY = "claude/opus/implementer/01";

const scenarios: string[] = [];
const ledgers: Ledger[] = [];

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function invocationFor(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("inv/" + taskId),
    submittedAt: "2026-08-27T12:00:00.000Z",
    submissionDigest: "a".repeat(64),
  };
}

/**
 * A recording port, because the call SEQUENCE is half the evidence.
 *
 * A cancellation may probe and must never apply. Counting both is what turns
 * "it does not perform the effect" from a claim into a measurement.
 */
interface Recorder {
  readonly calls: string[];
  readonly port: EffectPort;
}

function recordingEffects(root: ScenarioRoot, verdict?: PostconditionVerdict): Recorder {
  const calls: string[] = [];
  return {
    calls,
    port: {
      apply: (operation: OperationCoordinate) => {
        calls.push("APPLY");
        applyEffect(root, operation);
        return Promise.resolve();
      },
      probe: (operation: OperationCoordinate): Promise<PostconditionVerdict> => {
        const answer = verdict ?? probeEffect(root, operation);
        calls.push("PROBE:" + answer);
        return Promise.resolve(answer);
      },
    },
  };
}

interface Fixture {
  readonly context: BeatContext;
  readonly ledger: Ledger;
  readonly root: ScenarioRoot;
  readonly invocation: DurableInvocation;
  readonly recorder: Recorder;
}

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

function fixture(name: string, taskId: string, verdict?: PostconditionVerdict): Fixture {
  const root = scenario(name);
  const invocation = invocationFor(taskId);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const recorder = recordingEffects(root, verdict);
  return {
    context: {
      ledger,
      effects: recorder.port,
      invocation,
      emittedBy: EMITTED_BY,
      plan: LIFECYCLE_PLAN,
      initiativeId: TEST_INITIATIVE_ID,
      route: TEST_ROUTE,
      checkpoints: drillCheckpoints({
        ledger,
        invocation,
        emittedBy: EMITTED_BY,
        ledgerPath: scenarioLedgerPath(root),
        worktree: root,
      }),
    },
    ledger,
    root,
    invocation,
    recorder,
  };
}

/** Append plan steps 0..index inclusive, without performing any effect. */
function walkTo(context: BeatContext, index: number): void {
  for (const step of LIFECYCLE_PLAN.slice(0, index + 1)) {
    if (step.beat === "OUTCOME") continue;
    appendPlanStep(context, step);
  }
}

/** The idempotency key one transition of this attempt appends under. */
function keyFor(invocation: DurableInvocation, transitionId: string): string {
  return deriveEventCoordinate(invocation, transitionId, 0).idempotencyKey;
}

/** Every event of the task, in ledger order. */
function trail(ledger: Ledger): readonly { type: string; transitionId: string }[] {
  return ledger
    .listEvents({ limit: 200 })
    .events.map((record) => ({
      type: record.event.type,
      transitionId: record.event.transitionId,
    }));
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

describe("the cancellation vocabularies", () => {
  it("are closed and sorted, like every other vocabulary in this plane", () => {
    expect([...CANCELLATION_VERDICTS]).toEqual([
      "CANCELLED",
      "POSTCONDITION_UNKNOWN",
      "TASK_TERMINAL",
    ]);
    expect([...CANCELLATION_EFFECTS]).toEqual(["DONE", "NONE", "NOT_DONE"]);
  });

  it("appends under a transition id the plan cannot produce", () => {
    // The cancellation is not a plan step and must not be able to collide with
    // one: a shared id would make one attempt's cancellation and one of its
    // beats compete for a single idempotency key.
    expect(CANCELLATION_TRANSITION_ID).toBe("cancelled");
    expect(LIFECYCLE_PLAN.map((step) => step.transitionId)).not.toContain(
      CANCELLATION_TRANSITION_ID,
    );
  });
});

describe("act 1 refuses before anything happens", () => {
  it("refuses a terminal task, and the ledger would not have", async () => {
    const { context, ledger, invocation } = fixture("cancel-terminal", "11111111-1111-4111-8111-111111111101");
    walkTo(context, 4);
    await closeIntent(context);
    for (const step of LIFECYCLE_PLAN.slice(6)) appendPlanStep(context, step);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("CHECKPOINTED");

    const before = ledger.status();
    expect(cancellationPrecheck(context)).toEqual({ proceed: false, state: "CHECKPOINTED" });

    // And the settlement agrees, with zero delta.
    const settlement = await settleCancellation(context);
    expect(settlement.verdict).toBe("TASK_TERMINAL");
    expect(settlement.cancelled).toBeNull();
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);

    // The negative that makes the guard mean something: the LEDGER would have
    // taken this append. Its only lifecycle rule is continuity, and a
    // cancellation declaring `fromState: "CHECKPOINTED"` matches the row. So
    // the refusal above is the driver's own act and not the ledger's.
    const coordinate = deriveEventCoordinate(invocation, CANCELLATION_TRANSITION_ID, 11);
    const wouldHaveBeenAccepted = ledger.append(
      ControlPlaneEvent.parse({
        contractVersion: CONTRACT_VERSION,
        eventId: coordinate.eventId,
        taskId: invocation.taskId,
        attempt: invocation.attempt,
        transitionId: CANCELLATION_TRANSITION_ID,
        idempotencyKey: coordinate.idempotencyKey,
        type: "TASK_CANCELLED",
        fromState: "CHECKPOINTED",
        toState: "CANCELLED",
        emittedBy: EMITTED_BY,
        occurredAt: coordinate.occurredAt,
        recordedAt: coordinate.recordedAt,
        correlationId: invocation.invocationId,
        causationId: null,
        payload: { submissionDigest: invocation.submissionDigest, effect: "NONE" },
      }),
    );
    expect(wouldHaveBeenAccepted.inserted).toBe(true);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("CANCELLED");
  });

  it("refuses every terminal state, not only the happy-path one", async () => {
    // `TERMINAL_STATES` has five members and only one of them is reachable by
    // walking the plan. A guard that happened to test `=== "CHECKPOINTED"`
    // would pass the drill above and let a cancellation land on a FAILED or
    // already-CANCELLED task.
    const { context, ledger, invocation } = fixture("cancel-terminal-lateral", "11111111-1111-4111-8111-111111111102");
    walkTo(context, 0);
    const coordinate = deriveEventCoordinate(invocation, "failed", 1);
    ledger.append(
      ControlPlaneEvent.parse({
        contractVersion: CONTRACT_VERSION,
        eventId: coordinate.eventId,
        taskId: invocation.taskId,
        attempt: invocation.attempt,
        transitionId: "failed",
        idempotencyKey: coordinate.idempotencyKey,
        type: "TASK_FAILED",
        fromState: "DISCOVERED",
        toState: "FAILED",
        emittedBy: EMITTED_BY,
        occurredAt: coordinate.occurredAt,
        recordedAt: coordinate.recordedAt,
        correlationId: invocation.invocationId,
        causationId: null,
        payload: {},
      }),
    );

    expect(cancellationPrecheck(context)).toEqual({ proceed: false, state: "FAILED" });
    const before = ledger.status().eventCount;
    expect((await settleCancellation(context)).verdict).toBe("TASK_TERMINAL");
    expect(ledger.status().eventCount).toBe(before);
  });

  it("throws for a task the ledger has never seen rather than opening one", async () => {
    const { context, ledger } = fixture("cancel-unknown-task", "11111111-1111-4111-8111-111111111103");
    expect(() => cancellationPrecheck(context)).toThrow(SupervisorError);
    await expect(settleCancellation(context)).rejects.toBeInstanceOf(SupervisorError);
    // A refusal that appended would have created the task in CANCELLED, which
    // is inventing the very task the caller believed it was ending.
    expect(ledger.status().eventCount).toBe(0);
  });
});

describe("act 3 settles the ledger truth, probe first", () => {
  it("NOT_DONE appends exactly one cancellation and performs no effect", async () => {
    const { context, ledger, invocation, recorder, root } = fixture(
      "cancel-not-done",
      "22222222-2222-4222-8222-222222222201",
    );
    walkTo(context, 4);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("RUNNING");
    const before = ledger.status().eventCount;

    const settlement = await settleCancellation(context);

    expect(settlement.verdict).toBe("CANCELLED");
    expect(settlement.effect).toBe("NOT_DONE");
    expect(settlement.closedIntent).toBe(false);
    expect(ledger.status().eventCount).toBe(before + 1);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("CANCELLED");

    // Probed once, applied never. `closeIntent` would have applied here, which
    // is exactly why this settlement does not call it: repairing the effect is
    // the work a cancellation was asked to abandon.
    expect(recorder.calls).toEqual(["PROBE:NOT_DONE"]);
    expect(probeEffect(root, operationForStep(invocation, INTENT_STEP))).toBe("NOT_DONE");

    const live = JSON.stringify(ledger.getTask(invocation.taskId));
    ledger.rebuildReadModel();
    expect(JSON.stringify(ledger.getTask(invocation.taskId))).toBe(live);
    expect(ledger.verifyIntegrity().problems).toEqual([]);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
  });

  it("DONE closes the outcome BEFORE the cancellation, in that order", async () => {
    const { context, ledger, invocation, recorder } = fixture(
      "cancel-done",
      "22222222-2222-4222-8222-222222222202",
    );
    walkTo(context, 4);
    await applyIntentEffect(context, INTENT_STEP);
    const before = ledger.status().eventCount;
    // The fixture's own apply is the setup, not the subject: only what the
    // settlement does after this mark is evidence about the settlement.
    const mark = recorder.calls.length;

    const settlement = await settleCancellation(context);

    expect(settlement.verdict).toBe("CANCELLED");
    expect(settlement.effect).toBe("DONE");
    expect(settlement.closedIntent).toBe(true);
    expect(ledger.status().eventCount).toBe(before + 2);

    // The ORDER, not the membership. A set assertion would pass on a log that
    // recorded the cancellation first and the outcome after it, which is the
    // three-beat law read backwards: the completion fact must precede the
    // record that the task ended.
    const events = trail(ledger);
    const outcomeAt = events.findIndex((e) => e.transitionId === OUTCOME_STEP.transitionId);
    const cancelAt = events.findIndex((e) => e.transitionId === CANCELLATION_TRANSITION_ID);
    expect(outcomeAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBe(outcomeAt + 1);
    expect(events[cancelAt]?.type).toBe("TASK_CANCELLED");

    // The cancellation was appended from the state the OUTCOME left, read back
    // from the ledger rather than remembered from before it.
    expect(settlement.state).toBe("RUNNING");
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("CANCELLED");

    // Still no apply: the effect was already there and nothing repeated it.
    expect(recorder.calls.slice(mark)).toEqual(["PROBE:DONE"]);
    expect(ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("UNKNOWN appends nothing, refuses, and leaves the intent open", async () => {
    const { context, ledger, invocation, recorder } = fixture(
      "cancel-unknown",
      "22222222-2222-4222-8222-222222222203",
      "UNKNOWN",
    );
    walkTo(context, 4);
    const before = ledger.status();

    const settlement = await settleCancellation(context);

    expect(settlement.verdict).toBe("POSTCONDITION_UNKNOWN");
    expect(settlement.cancelled).toBeNull();
    expect(settlement.effect).toBeNull();

    // Zero delta, asserted on the authority and not on the return value.
    const after = ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);

    // And the intent is still open, which is what makes this recoverable
    // rather than merely un-written: an operator finds exactly the state
    // `PostconditionUnknownError` already leaves behind.
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("RUNNING");
    expect(ledger.getEventByIdempotencyKey(keyFor(invocation, INTENT_STEP.transitionId))).not.toBeNull();
    expect(ledger.getEventByIdempotencyKey(keyFor(invocation, OUTCOME_STEP.transitionId))).toBeNull();
    expect(recorder.calls).toEqual(["PROBE:UNKNOWN"]);
  });

  it("restores: with the probe removed, the same UNKNOWN effect gets a cancellation", () => {
    // The restore half, and it is what proves the PROBE holds the law rather
    // than some neighbouring guard. This is the settlement with its probe
    // taken out -- everything else identical -- and the log immediately
    // carries a claim that the task ended while its effect was unestablished.
    const { context, ledger, invocation } = fixture(
      "cancel-unknown-restored",
      "22222222-2222-4222-8222-222222222204",
      "UNKNOWN",
    );
    walkTo(context, 4);
    const before = ledger.status().eventCount;

    const coordinate = deriveEventCoordinate(invocation, CANCELLATION_TRANSITION_ID, 11);
    ledger.append(
      ControlPlaneEvent.parse({
        contractVersion: CONTRACT_VERSION,
        eventId: coordinate.eventId,
        taskId: invocation.taskId,
        attempt: invocation.attempt,
        transitionId: CANCELLATION_TRANSITION_ID,
        idempotencyKey: coordinate.idempotencyKey,
        type: "TASK_CANCELLED",
        fromState: "RUNNING",
        toState: "CANCELLED",
        emittedBy: EMITTED_BY,
        occurredAt: coordinate.occurredAt,
        recordedAt: coordinate.recordedAt,
        correlationId: invocation.invocationId,
        causationId: null,
        payload: { submissionDigest: invocation.submissionDigest, effect: "NOT_DONE" },
      }),
    );

    // The defect, stated as what a reader would now believe: the task ended,
    // its intent is closed by a terminal state, and no outcome ever recorded
    // whether the effect happened.
    expect(ledger.status().eventCount).toBe(before + 1);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("CANCELLED");
    expect(ledger.getEventByIdempotencyKey(keyFor(invocation, OUTCOME_STEP.transitionId))).toBeNull();
  });

  it("cancels a task with no open intent without probing at all", async () => {
    const { context, ledger, invocation, recorder } = fixture(
      "cancel-no-intent",
      "22222222-2222-4222-8222-222222222205",
    );
    walkTo(context, 3);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("RESERVED");
    const before = ledger.status().eventCount;

    const settlement = await settleCancellation(context);

    // `NONE` rather than a probe verdict: nothing was in flight, so nothing was
    // asked. A probe here would have answered NOT_DONE and recorded a verdict
    // about an effect this attempt never reached.
    expect(settlement.effect).toBe("NONE");
    expect(settlement.closedIntent).toBe(false);
    expect(recorder.calls).toEqual([]);
    expect(ledger.status().eventCount).toBe(before + 1);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("CANCELLED");
  });

  it("cancels from an exceptional state the plan has no step out of", async () => {
    // `WAITING_OWNER`, `QUOTA_BLOCKED`, `AUTH_REQUIRED` and `DRAINING` are
    // non-terminal, so they must be cancellable -- and they are precisely the
    // states an operator cancels from. The settlement asks whether the INTENT
    // is present and its OUTCOME absent, which is total over every state;
    // navigating the PLAN instead would throw here, as the control below shows.
    const { context, ledger, invocation } = fixture(
      "cancel-exceptional",
      "22222222-2222-4222-8222-222222222206",
    );
    walkTo(context, 0);
    const coordinate = deriveEventCoordinate(invocation, "waiting", 1);
    ledger.append(
      ControlPlaneEvent.parse({
        contractVersion: CONTRACT_VERSION,
        eventId: coordinate.eventId,
        taskId: invocation.taskId,
        attempt: invocation.attempt,
        transitionId: "waiting",
        idempotencyKey: coordinate.idempotencyKey,
        type: "TASK_STATE_CHANGED",
        fromState: "DISCOVERED",
        toState: "WAITING_OWNER",
        emittedBy: EMITTED_BY,
        occurredAt: coordinate.occurredAt,
        recordedAt: coordinate.recordedAt,
        correlationId: invocation.invocationId,
        causationId: null,
        payload: {},
      }),
    );

    // The control: plan navigation cannot answer from here.
    expect(() => nextStep(context, "WAITING_OWNER" as TaskState)).toThrow();

    const settlement = await settleCancellation(context);
    expect(settlement.verdict).toBe("CANCELLED");
    expect(settlement.state).toBe("WAITING_OWNER");
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe("CANCELLED");
  });
});

describe("the cancellation event itself", () => {
  it("is idempotent: a repeated settlement appends nothing the second time", async () => {
    const { context, ledger, invocation } = fixture(
      "cancel-idempotent",
      "33333333-3333-4333-8333-333333333301",
    );
    walkTo(context, 4);
    const first = await settleCancellation(context);
    expect(first.verdict).toBe("CANCELLED");
    const afterFirst = ledger.status();

    // The second settlement observes a terminal task and refuses; and even the
    // event itself, rebuilt, is byte-identical, so a recovery that reached the
    // append twice would insert one row.
    const second = await settleCancellation(context);
    expect(second.verdict).toBe("TASK_TERMINAL");
    expect(ledger.status().eventCount).toBe(afterFirst.eventCount);
    expect(ledger.status().headEventSha256).toBe(afterFirst.headEventSha256);

    const key = keyFor(invocation, CANCELLATION_TRANSITION_ID);
    expect(ledger.getEventByIdempotencyKey(key)).not.toBeNull();
  });

  it("carries coordinates and a closed verdict, and nothing an engine minted", async () => {
    const { context, ledger, invocation } = fixture(
      "cancel-payload",
      "33333333-3333-4333-8333-333333333302",
    );
    walkTo(context, 4);
    const settlement = await settleCancellation(context);
    const event = settlement.cancelled;
    expect(event).not.toBeNull();
    if (event === null) return;

    // The payload is a digest and a closed verdict. No free text, no path, no
    // engine output, and no Restate identity -- those are `inv_`-prefixed and
    // nothing in this shape is a string that could be one.
    expect(Object.keys(event.payload).sort()).toEqual(["effect", "submissionDigest"]);
    expect(event.payload["effect"]).toBe("NOT_DONE");
    expect(CANCELLATION_EFFECTS).toContain(event.payload["effect"]);
    expect(JSON.stringify(event)).not.toContain("inv_");

    // Coordinates are derived, so a settlement re-run after a crash rebuilds
    // the same bytes. Both instants are the invocation's own submission
    // instant, never a clock read.
    expect(event.occurredAt).toBe(invocation.submittedAt);
    expect(event.recordedAt).toBe(invocation.submittedAt);
    expect(event.correlationId).toBe(invocation.invocationId);

    // Causation is null and honestly so: nothing in this log caused the
    // cancellation. A derived link to whichever step happened to be last would
    // be a causal claim the ledger cannot corroborate.
    expect(event.causationId).toBeNull();

    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});
