import { CONTRACT_VERSION, ReconciliationReport } from "@acp/contracts";
import type {
  CommitPolicy,
  ControlPlaneEvent,
  DriverCapabilities,
  DriverMode,
  DriverOutcome,
  DriverRefused,
  DriverStatus,
  ReconciliationVerdict,
  TaskState,
} from "@acp/contracts";
import { TerminalError, handlers, object } from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";

import {
  DATA_ROOT_DRILLS,
  RESTATE_HANDLER_ADVANCE,
  RESTATE_HANDLER_READ_CACHE,
  RESTATE_OBJECT_NAME,
  RESTATE_STATE_KEY_CACHE,
  SupervisorError,
  appendPlanStep,
  applyIntentEffect,
  assertClaimedState,
  assertInvocationContinuity,
  closeIntent,
  deterministicUuid,
  planFor,
} from "@acp/runtime";
import type { BeatContext, DurableInvocation, OrchestrationDriver } from "@acp/runtime";

import type {
  LedgerLike,
  RestateCacheState,
  RestateDriverOptions,
} from "../../contracts/index.js";

/**
 * The Restate driver: a derived orchestrator over the same ledger.
 *
 * Everything durable still lives in the ledger. Restate contributes retries,
 * replay and per-task serialisation; it contributes no facts. The object's only
 * state is a two-field cache of values the ledger already holds, and the
 * data-root-deletion drill exists to prove that deleting all of it loses
 * nothing.
 *
 * The handler never calls `OrchestrationDriver.advance`. It walks the shared
 * plan from index 0 in a fixed sequence, wrapping each beat in its own
 * `ctx.run`, because control flow that branches on an unjournaled ledger read
 * diverges on replay.
 */

export const RESTATE_MODE: DriverMode = "RESTATE";

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileInput {
  readonly ledger: LedgerLike;
  readonly invocation: DurableInvocation;
  /** Reads the object's cache. A throw becomes INDETERMINATE, never a guess. */
  readonly readCache: () => Promise<RestateCacheState | null>;
}

function reportFor(
  invocation: DurableInvocation,
  verdict: ReconciliationVerdict,
  head: { readonly headSequence: number; readonly headEventSha256: string },
  detail: string | null,
  discrepancies: readonly { taskId: string; attempt: number; transitionId: string; detail: string }[],
): ReconciliationReport {
  // Built through the contract so a mis-set flag is a parse failure here rather
  // than a wrong answer downstream. `safeToResume` is not chosen by this
  // algorithm: the contract forces it to equal membership in RESUMABLE_VERDICTS.
  return ReconciliationReport.parse({
    contractVersion: CONTRACT_VERSION,
    reportId: deterministicUuid(
      "reconcile/" + invocation.invocationId + "/" + invocation.taskId + "/" + verdict,
    ),
    mode: RESTATE_MODE,
    verdict,
    observedAt: invocation.submittedAt,
    ledgerHeadSequence: head.headSequence,
    ledgerHeadSha256: head.headEventSha256,
    resolvedByLedger: true,
    safeToResume: verdict === "CONSISTENT" || verdict === "DRIVER_BEHIND",
    discrepancies: [...discrepancies],
    detail,
  });
}

/**
 * Compare the driver's cache against the ledger. Order matters; first match wins.
 *
 * `DRIVER_AHEAD` and `DIVERGED` are unreachable in a correct run: with the cache
 * limited to two derived fields there is no way to get ahead of the log that
 * produced them. Tests reach them by injecting state directly, and a drill that
 * produces either without injection is an adoption-blocking defect.
 */
export async function reconcile(input: ReconcileInput): Promise<ReconciliationReport> {
  const { ledger, invocation } = input;

  let head: { headSequence: number; headEventSha256: string };
  try {
    const status = ledger.status();
    head = { headSequence: status.headSequence, headEventSha256: status.headEventSha256 };
  } catch {
    return reportFor(
      invocation,
      "INDETERMINATE",
      { headSequence: 0, headEventSha256: "0".repeat(64) },
      "the ledger head could not be read",
      [],
    );
  }

  // 1. Integrity first. An unanswered question is not a negative answer.
  let integrityOk: boolean;
  try {
    integrityOk = ledger.verifyIntegrity().ok;
  } catch {
    return reportFor(invocation, "INDETERMINATE", head, "the ledger integrity check threw", []);
  }
  if (!integrityOk) {
    return reportFor(
      invocation,
      "INDETERMINATE",
      head,
      "the ledger failed its own integrity check; no comparison is trustworthy",
      [],
    );
  }

  let cache: RestateCacheState | null;
  try {
    cache = await input.readCache();
  } catch {
    return reportFor(invocation, "INDETERMINATE", head, "the driver state could not be read", []);
  }

  // 2. Absence is the reconstructible case, and the expected verdict after the
  //    data root is deleted.
  if (cache === null) {
    return reportFor(
      invocation,
      "DRIVER_BEHIND",
      head,
      "the driver holds no cache; the ledger is replayed from its own head",
      [],
    );
  }

  // 3. Agreement.
  if (
    cache.lastAppliedSequence === head.headSequence &&
    cache.lastAppliedEventSha256 === head.headEventSha256
  ) {
    return reportFor(invocation, "CONSISTENT", head, null, []);
  }

  // 5. Ahead of the log that produced it: the authority violation. Halt.
  if (cache.lastAppliedSequence > head.headSequence) {
    return reportFor(
      invocation,
      "DRIVER_AHEAD",
      head,
      "the driver claims a sequence the ledger has no record of",
      [
        {
          taskId: invocation.taskId,
          attempt: invocation.attempt,
          transitionId: "reconcile",
          detail:
            "driver sequence " +
            String(cache.lastAppliedSequence) +
            " exceeds ledger head " +
            String(head.headSequence),
        },
      ],
    );
  }

  // 4 and 6. Behind, or disagreeing about the same position.
  const at = ledger.getEventBySequence(cache.lastAppliedSequence);
  if (at !== null && at.eventSha256 === cache.lastAppliedEventSha256) {
    return reportFor(
      invocation,
      "DRIVER_BEHIND",
      head,
      "the ledger is a strict superset of what the driver has applied",
      [],
    );
  }

  return reportFor(
    invocation,
    "DIVERGED",
    head,
    "the driver and the ledger disagree at the same sequence",
    [
      {
        taskId: invocation.taskId,
        attempt: invocation.attempt,
        transitionId: "reconcile",
        detail:
          "driver digest " +
          cache.lastAppliedEventSha256.slice(0, 16) +
          " does not match the ledger at sequence " +
          String(cache.lastAppliedSequence),
      },
    ],
  );
}

// ---------------------------------------------------------------------------
// The Virtual Object
// ---------------------------------------------------------------------------

export interface ObjectDependencies {
  /**
   * The ports for one invocation, without the plan.
   *
   * The plan is not the caller's to supply: this object selects it from
   * `commitPolicy` below, so the plan the handler walks and the plan the
   * executor navigates are the same value by construction rather than by two
   * callers agreeing.
   */
  readonly beat: (invocation: DurableInvocation) => Omit<BeatContext, "plan" | "initiativeId">;
  /**
   * The packet's commit policy. Required, with no default: see
   * `SqliteSupervisorOptions.commitPolicy`.
   */
  readonly commitPolicy: CommitPolicy;
  /**
   * The packet's initiative. Required, with no default, and composed here
   * rather than carried on the beat surface for the same reason the plan is:
   * a fact that arrives with the packet belongs to the object that walks it,
   * not to whichever caller assembled the ports. One source, stated once.
   */
  readonly initiativeId: string;
  readonly ledger: LedgerLike;
  /** Deliberate interruption seam for the kill drills. Never set in normal use. */
  /**
   * Deliberate interruption seam for the kill drills. Never set in normal use.
   *
   * Awaited (V2-B2-3). It was fire-and-forget, which meant a drill could only
   * hold a beat by blocking the whole process — and a process-wide block cannot
   * tell per-key serialization from global serialization, because it stops
   * everything either way. Awaiting it lets a drill hold exactly one
   * invocation, which is the thing the serialization drills need to observe.
   *
   * The return type is `unknown` rather than `void | Promise<void>` so the
   * landed callbacks that end in an expression — `(point) => beats.push(point)`
   * — keep compiling. Awaiting a non-thenable is a no-op, so a hook that
   * returns nothing behaves exactly as it did.
   *
   * It also names the task. Without that a drill can only count announcements,
   * and a count cannot tell two invocations held at once from one invocation
   * redelivered twice — which is a difference the serialization drills exist to
   * measure. Callbacks that ignore the second argument are unaffected.
   */
  readonly __onBeat?: ((point: string, taskId: string) => unknown) | undefined;
}

interface ObjectState {
  readonly [RESTATE_STATE_KEY_CACHE]: RestateCacheState;
}

function fatal(error: unknown): never {
  // Fail-closed classifications must stop Restate retrying. Grinding against an
  // unobservable effect forever is worse than stopping with a reason.
  const message = error instanceof Error ? error.message : "the handler failed";
  throw new TerminalError(message);
}

/**
 * The slice of `ObjectContext` the advance handler actually uses.
 *
 * Declared so the handler can be exercised directly, with an injected cache and
 * a recording run, without a server. A test that only called `reconcile` would
 * prove the reconciler refuses; it would not prove the HANDLER refuses before
 * touching anything, which is the property B4 is about.
 */
export interface AdvanceContext {
  get(name: typeof RESTATE_STATE_KEY_CACHE): Promise<RestateCacheState | null>;
  set(name: typeof RESTATE_STATE_KEY_CACHE, value: RestateCacheState): void;
  /**
   * The SDK's own shape: an action may be asynchronous, and what is journaled
   * is its settled value. The effect and outcome beats are awaited inside
   * their `run` (V2-B1b, stage 1); still one entry per beat, under the same
   * names.
   */
  run<T>(name: string, action: () => T | Promise<T>): Promise<T>;
}

/**
 * The advance handler, extracted so it has exactly one implementation.
 *
 * Reconciliation runs first: before the continuity guard, before any probe,
 * effect or append. A non-resumable verdict throws a `TerminalError` and
 * nothing has happened yet, which is what "fails closed with zero delta" has to
 * mean.
 */
export async function advanceHandler(
  dependencies: ObjectDependencies,
  ctx: AdvanceContext,
  invocation: DurableInvocation,
): Promise<{ readonly finalSequence: number }> {
  const plan = planFor(dependencies.commitPolicy);
  const context: BeatContext = {
    ...dependencies.beat(invocation),
    plan,
    initiativeId: dependencies.initiativeId,
  };

  const report = await reconcile({
    ledger: dependencies.ledger,
    invocation,
    readCache: async () => (await ctx.get(RESTATE_STATE_KEY_CACHE)) ?? null,
  });
  if (!report.safeToResume) {
    throw new TerminalError(
      "reconciliation refused to resume: " + report.verdict + "; " + (report.detail ?? ""),
    );
  }

  try {
    assertInvocationContinuity(context);
  } catch (error: unknown) {
    fatal(error);
  }

  // A FIXED walk from index 0. No branch reads unjournaled ledger state, so the
  // journal entry order is identical on every replay; idempotent appends make
  // the already-done steps free.
  for (const step of plan) {
    if (step.beat === "OUTCOME") continue;

    await ctx.run("step/" + step.transitionId + "/" + String(step.index), () => {
      try {
        const result = appendPlanStep(context, step);
        return { inserted: result.inserted, sequence: dependencies.ledger.status().headSequence };
      } catch (error: unknown) {
        return fatal(error);
      }
    });
    await dependencies.__onBeat?.("AFTER_INTENT_" + String(step.index), invocation.taskId);

    if (step.beat === "INTENT") {
      await ctx.run("effect/" + step.transitionId + "/" + String(step.index), async () => {
        try {
          await applyIntentEffect(context, step);
          return { applied: true };
        } catch (error: unknown) {
          return fatal(error);
        }
      });
      await dependencies.__onBeat?.("AFTER_EFFECT", invocation.taskId);

      const outcome = plan[step.index + 1];
      if (outcome?.beat === "OUTCOME") {
        await ctx.run("outcome/" + outcome.transitionId + "/" + String(outcome.index), async () => {
          try {
            const result = await closeIntent(context);
            return {
              inserted: result.inserted,
              sequence: dependencies.ledger.status().headSequence,
            };
          } catch (error: unknown) {
            return fatal(error);
          }
        });
        await dependencies.__onBeat?.("AFTER_OUTCOME", invocation.taskId);
      }
    }
  }

  // The cache is written only after the appends succeeded, and only from values
  // the ledger just reported. It is a copy, never a source.
  const status = dependencies.ledger.status();
  ctx.set(RESTATE_STATE_KEY_CACHE, {
    lastAppliedSequence: status.headSequence,
    lastAppliedEventSha256: status.headEventSha256,
  });
  return { finalSequence: status.headSequence };
}

/**
 * Build the object definition over a set of ports.
 *
 * A factory rather than a module-level constant so importing this file starts
 * nothing and binds nothing.
 */
export function createAcpTaskObject(dependencies: ObjectDependencies) {
  return object({
    name: RESTATE_OBJECT_NAME,
    handlers: {
      [RESTATE_HANDLER_ADVANCE]: async (
        ctx: ObjectContext<ObjectState>,
        invocation: DurableInvocation,
      ): Promise<{ readonly finalSequence: number }> =>
        advanceHandler(dependencies, ctx as unknown as AdvanceContext, invocation),

      // Read-only, so reconciliation can read the cache through a handler rather
      // than through admin introspection.
      [RESTATE_HANDLER_READ_CACHE]: handlers.object.shared(
        async (ctx: ObjectSharedContext<ObjectState>): Promise<RestateCacheState | null> =>
          (await ctx.get(RESTATE_STATE_KEY_CACHE)) ?? null,
      ),
    },
  });
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * The one refusal this driver returns, built in one place.
 *
 * `at` names the verb and nothing else — never engine output, never an
 * invocation id, never a path.
 */
function unsupported(at: string): DriverRefused {
  return { ok: false, refusal: "CAPABILITY_UNSUPPORTED", at };
}

export class RestateDriver implements OrchestrationDriver {
  readonly mode: DriverMode = RESTATE_MODE;

  readonly #options: RestateDriverOptions;
  readonly #beat: (invocation: DurableInvocation) => Omit<BeatContext, "plan" | "initiativeId">;
  readonly #commitPolicy: CommitPolicy;
  readonly #initiativeId: string;

  constructor(
    options: RestateDriverOptions,
    beat: (invocation: DurableInvocation) => Omit<BeatContext, "plan" | "initiativeId">,
    commitPolicy: CommitPolicy,
    initiativeId: string,
  ) {
    this.#options = options;
    this.#beat = beat;
    this.#commitPolicy = commitPolicy;
    this.#initiativeId = initiativeId;
  }

  /**
   * What this engine can be asked for (V2-B2-1).
   *
   * All four verbs are `UNSUPPORTED` today, and none of them is a statement
   * about Restate: the engine does offer durable timers, awakeables,
   * cancellation and attach. It is a statement about THIS DRIVER, which does
   * not yet call any of them. A capability declares what a caller may rely on,
   * so it may not run ahead of the code that would honour it — each later B2
   * packet flips exactly one entry and lands the drill that earns it.
   *
   * `SERIALIZED_PER_TASK` is `SUPPORTED` as of V2-B2-3, and only because that
   * packet drilled it. The object is keyed by task, so Restate serializes per
   * key by construction — but construction was the claim, not the evidence.
   * The drills hold one invocation at a beat and count how many others reach
   * it: one for the same key, two for different keys. That pair is what
   * separates per-key serialization from a global lock and from a harness that
   * merely stopped the world, and it is why this entry moved while the four
   * verbs did not.
   */
  capabilities(): DriverCapabilities {
    return {
      contractVersion: CONTRACT_VERSION,
      mode: this.mode,
      verbs: {
        CANCEL: "UNSUPPORTED",
        REATTACH: "UNSUPPORTED",
        SIGNAL: "UNSUPPORTED",
        TIMER: "UNSUPPORTED",
      },
      properties: { SERIALIZED_PER_TASK: "SUPPORTED" },
    };
  }

  /**
   * The four verbs, each refusing what this driver has not yet learned to do.
   *
   * Typed refusals, never throws and never silent no-ops, for the reason the
   * owned execution boundary already gives: starting fresh while a caller
   * believes it reattached, or reporting nothing while a caller believes it
   * cancelled, are the failures that cost the most and show the least.
   */
  cancel(): Promise<DriverOutcome> {
    return Promise.resolve(unsupported("cancel"));
  }

  reattach(): Promise<DriverOutcome> {
    return Promise.resolve(unsupported("reattach"));
  }

  signal(): Promise<DriverOutcome> {
    return Promise.resolve(unsupported("signal"));
  }

  timer(): Promise<DriverOutcome> {
    return Promise.resolve(unsupported("timer"));
  }

  /**
   * Report on the driver itself.
   *
   * `UNAVAILABLE` when the server cannot be reached. The contract requires such
   * a status to carry `activeSince: null` and a reason, which is why the
   * unreachable case cannot quietly look healthy.
   */
  async status(): Promise<DriverStatus> {
    const status = this.#options.ledger.status();
    const reachable = await this.#serverReachable();

    return {
      contractVersion: CONTRACT_VERSION,
      mode: this.mode,
      health: reachable ? "OK" : "UNAVAILABLE",
      observedAt: this.#options.invocation.submittedAt,
      ledgerHeadSequence: status.headSequence,
      ledgerHeadSha256: status.headEventSha256,
      dataRoot: DATA_ROOT_DRILLS,
      activeSince: reachable ? this.#options.invocation.submittedAt : null,
      detail: reachable ? null : "the Restate server is not reachable on loopback",
    };
  }

  reconcile(): Promise<ReconciliationReport> {
    return reconcile({
      ledger: this.#options.ledger,
      invocation: this.#options.invocation,
      readCache: this.#options.readCache ?? (() => Promise.resolve(null)),
    });
  }

  /**
   * Advance one step, preserving the supervisor's claim-check law.
   *
   * The caller's `from` is checked against the ledger BEFORE any HTTP side
   * effect. The internal object walk never calls this method: submission is the
   * deterministic submitter's job, and this is the frozen one-step interface.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async advance(
    invocation: DurableInvocation,
    from: TaskState,
  ): Promise<ControlPlaneEvent | null> {
    // `async` so every refusal is a rejection. A promise-returning method that
    // throws synchronously makes callers write two error paths, and the one
    // they forget is the one that fires on a bad claim.
    const context: BeatContext = {
      ...this.#beat(invocation),
      plan: planFor(this.#commitPolicy),
      initiativeId: this.#initiativeId,
    };
    assertInvocationContinuity(context);
    assertClaimedState(context, from);
    throw new SupervisorError(
      "the Restate driver advances through its object handler, not through a" +
        " direct one-step call; submit the invocation instead",
    );
  }

  async #serverReachable(): Promise<boolean> {
    try {
      const response = await fetch(this.#options.adminUrl + "/health", {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
