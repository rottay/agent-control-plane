import { CONTRACT_VERSION, ReconciliationReport } from "@acp/contracts";
import type {
  CommitPolicy,
  ControlPlaneEvent,
  DriverCapabilities,
  DriverMode,
  DriverOutcome,
  DriverStatus,
  ReconciliationVerdict,
  TaskState,
} from "@acp/contracts";
import { TerminalError, handlers, object, workflow } from "@restatedev/restate-sdk";
import type {
  ObjectContext,
  ObjectSharedContext,
  WorkflowContext,
  WorkflowSharedContext,
} from "@restatedev/restate-sdk";

import {
  FAILURE_REASONS,
  classifyFailure,
  settleFailure,
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
  cancellationPrecheck,
  closeIntent,
  deterministicUuid,
  planFor,
  settleCancellation,
} from "@acp/runtime";
import type { BeatContext, DurableInvocation, FailureReason, OrchestrationDriver } from "@acp/runtime";

import { attachAdvance, cancelAdvance, resolveGate, sendAdvanceDelayed } from "../../submit/index.js";
import {
  RESTATE_GATE_PROMISE,
  RESTATE_HANDLER_GATE_RESOLVE,
  RESTATE_HANDLER_GATE_RUN,
  RESTATE_WORKFLOW_GATE,
} from "../../contracts/index.js";
import type {
  GatePayload,
  GateResolveContext,
  GateRunContext,
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

/**
 * The metadata key the classification travels under (V2-B7R).
 *
 * Metadata rather than the message, and this is the whole of L-B7R-3: the
 * message is the underlying error's own text and may name a path, a provider's
 * output or a credential — this lane already propagates it to the ingress
 * caller, which is a pre-existing boundary this packet does not widen. What the
 * LEDGER is told must be a classified code derived from the error's TYPE, and
 * the only way that code reaches the catch is here.
 *
 * Measured on a real server at the pinned 1.7.7 before being relied on: a
 * `TerminalError`'s metadata is journaled with the failure and is byte-identical
 * in the catch after a real `SIGKILL` and redelivery. So the classification is
 * as deterministic as the journal entry it rides.
 */
const FAILURE_REASON_METADATA_KEY = "acpFailureReason";

/** The one journal entry a settlement is ever written under. */
const SETTLE_RUN_NAME = "settle/failed";

function fatal(error: unknown): never {
  // Fail-closed classifications must stop Restate retrying. Grinding against an
  // unobservable effect forever is worse than stopping with a reason.
  const message = error instanceof Error ? error.message : "the handler failed";
  // V2-B7R. The class is about to be erased by the conversion to a
  // `TerminalError`, so the decision is taken HERE, while the original error is
  // still in hand, and carried forward as a classified word. `classifyFailure`
  // is the shared decision the SQLite lane asks too, so neither driver can
  // answer "does this settle?" differently from the other.
  const decision = classifyFailure(error);
  throw new TerminalError(
    message,
    decision.settle ? { metadata: { [FAILURE_REASON_METADATA_KEY]: decision.reason } } : {},
  );
}

/**
 * The reason a caught error entitles the log to settle under, or null.
 *
 * Fail-closed twice over: metadata that is absent, malformed, or names anything
 * outside the contract's own closed list yields null and settles nothing. A
 * settlement can therefore only happen for a decision `classifyFailure` actually
 * took, never for one a message happened to look like.
 */
function settleableReason(error: unknown): FailureReason | null {
  if (!(error instanceof TerminalError)) return null;
  const carried = error.metadata?.[FAILURE_REASON_METADATA_KEY];
  if (carried === undefined) return null;
  return (FAILURE_REASONS as readonly string[]).includes(carried)
    ? (carried as FailureReason)
    : null;
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

  // V2-B7R. The try opens HERE and not one line earlier, and the boundary is
  // the determinism argument rather than a preference.
  //
  // `reconcile()` and `assertInvocationContinuity` above run OUTSIDE any
  // `ctx.run`, so their outcomes are not journaled and a branch taken from them
  // would be recomputed live on every replay — the journal order would stop
  // being a function of the journal. The loop is different: its inner failure IS
  // journaled, so on replay the failed entry re-throws at the same position, the
  // catch fires at the same position, and the settle entry lands at the same
  // index. Measured on a real server before being relied on.
  //
  // They must also not settle on principle. A reconciliation refusal's whole law
  // is "fails closed with zero delta", and a continuity failure puts the task's
  // identity in question — a terminal claim there would be a claim about the
  // wrong task.
  try {
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
  } catch (error: unknown) {
    // C1 — the settlement is its own named journal entry, never a bare call in
    // the catch and never inside the run that failed. An append outside the
    // journal is invisible to replay; one inside the failed run rides an entry
    // the journal has recorded as a failure.
    //
    // C3 — exactly-once is the LEDGER's, not the journal's. The SDK names a
    // small window in which an action may re-run before its result is durable,
    // so this run must tolerate at-least-once execution; it does, because
    // `settleFailure` builds one event under one fixed transition id and the
    // second append is an exact replay that inserts nothing.
    const reason = settleableReason(error);
    if (reason !== null) {
      // The two windows a crash can land in, announced on the existing seam
      // rather than through a second mechanism. `__onBeat` is not journaled and
      // is not a `ctx.run`, so announcing here changes no journal position; the
      // drills use it to put a real SIGKILL inside each window.
      await dependencies.__onBeat?.("BEFORE_SETTLE", invocation.taskId);
      await ctx.run(SETTLE_RUN_NAME, async () => {
        const settlement = await settleFailure(context, reason);
        // Inside the run and after the append: the SDK's own named window, where
        // the ledger row exists and the journal entry is not yet durable. A
        // crash here re-executes this action on redelivery, and the ledger key
        // is what makes the second append an exact replay rather than a row.
        await dependencies.__onBeat?.("AFTER_SETTLE_APPEND", invocation.taskId);
        return { verdict: settlement.verdict, settled: settlement.failed !== null };
      });
    }
    // C4 — the original terminal error, always. The invocation must still fail
    // terminally so Restate does not retry the walk, and a catch that returned
    // would turn a failed packet into a successful one.
    throw error;
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
// The durable gate (V2-B2-5)
// ---------------------------------------------------------------------------

/**
 * What the gate needs, which is deliberately not a ledger.
 *
 * The gate holds no fact. It appends nothing, reads nothing and projects
 * nothing, so it is handed no ledger and could not write one if it wanted to —
 * which is the structural form of "waiting changes no authority". Its only
 * dependency is an optional announcement seam, and that exists for the drills
 * for the same reason `__onBeat` does: a drill must proceed on a handshake
 * rather than on elapsed time.
 */
export interface GateDependencies {
  /** Announce a gate transition. Test seam only; never a fact. */
  readonly __onGate?:
    | ((point: "PARKED" | "RELEASED", invocationId: string) => Promise<void>)
    | undefined;
}

/**
 * The gate's blocking half: park until the named durable promise resolves.
 *
 * Extracted so it has exactly one implementation and can be exercised without
 * a server, the same reason `advanceHandler` is extracted.
 *
 * It runs no reconciliation and asserts no continuity, and that is correct
 * rather than an omission: those guards exist to protect APPENDS, and this
 * handler performs none. A gate that refused on a non-resumable verdict would
 * be making a claim about a task it never touches.
 */
export async function gateRunHandler(
  dependencies: GateDependencies,
  ctx: GateRunContext,
  invocation: DurableInvocation,
): Promise<{ readonly released: true }> {
  await dependencies.__onGate?.("PARKED", invocation.invocationId);
  // The named durable promise IS the wait. It is engine state keyed by the
  // workflow key, so a release that arrived BEFORE this line ran has already
  // completed it and this returns immediately — the property that makes the
  // signal-before-park race impossible rather than merely unlikely.
  await ctx.promise<GatePayload>(RESTATE_GATE_PROMISE);
  await dependencies.__onGate?.("RELEASED", invocation.invocationId);
  return { released: true };
}

/**
 * The gate's release half, which must never hold the key.
 *
 * A second resolve is the engine's business, not this handler's: measured
 * against the pinned server it answers `409 "promise was already completed"`,
 * and that status travels back to the driver rather than being swallowed here.
 */
export async function gateResolveHandler(
  ctx: GateResolveContext,
  payload: GatePayload,
): Promise<{ readonly resolved: true }> {
  await ctx.promise<GatePayload>(RESTATE_GATE_PROMISE).resolve(payload);
  return { resolved: true };
}

/**
 * Build the gate workflow (V2-B2-5).
 *
 * A WORKFLOW rather than a handler on `AcpTask`, and the two reasons are the
 * whole design.
 *
 * **Only a workflow has a named durable promise.** `ctx.promise(name)` exists
 * on `WorkflowContext`/`WorkflowSharedContext` and nowhere else. It is engine
 * state keyed by the workflow key — the derived invocation id — rather than a
 * journal position, so it needs no engine-minted identifier, none is discovered
 * and none can leak. The rejected alternative, an awakeable inside a Virtual
 * Object, has an identifier that does not exist until the handler reaches it,
 * which makes a signal arriving first permanently lost.
 *
 * **`AcpTask` must not block.** Waiting inside an exclusive object handler
 * would hold the task key for the whole wait, so `advance` for that task would
 * queue behind an unresolved gate. The per-task serialization B2-3 certified
 * would then be indistinguishable from a deadlock. Keeping the gate in its own
 * service is what leaves that property exactly as it was — which is why X3 is a
 * preservation assertion here and not a risk.
 *
 * `run` is the workflow's exclusive entry; `resolve` is SHARED so releasing
 * never queues behind the wait it releases.
 */
export function createAcpGateWorkflow(dependencies: GateDependencies = {}) {
  return workflow({
    name: RESTATE_WORKFLOW_GATE,
    handlers: {
      [RESTATE_HANDLER_GATE_RUN]: async (
        ctx: WorkflowContext,
        invocation: DurableInvocation,
      ): Promise<{ readonly released: true }> =>
        gateRunHandler(dependencies, ctx as unknown as GateRunContext, invocation),

      [RESTATE_HANDLER_GATE_RESOLVE]: handlers.workflow.shared(
        async (
          ctx: WorkflowSharedContext,
          payload: GatePayload,
        ): Promise<{ readonly resolved: true }> =>
          gateResolveHandler(ctx as unknown as GateResolveContext, payload),
      ),
    },
  });
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * The one place an attach body becomes a number, or a refusal to guess.
 *
 * Same discipline as `parseCacheReply`: a reply that is not a well-formed
 * answer THROWS rather than being coerced. A half-parsed body turned into a
 * zero would report that a reattached invocation had reached the start of the
 * ledger, which is a claim about the work made from an unanswered question.
 */
function parseFinalSequence(body: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SupervisorError("the attach returned a body that is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SupervisorError("the attach returned something that is not a handler result");
  }
  const sequence = (parsed as Record<string, unknown>)["finalSequence"];
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0) {
    throw new SupervisorError("the attach reply carries no usable finalSequence");
  }
  return sequence;
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
   * As of V2-B2-5 no verb is `UNSUPPORTED`, so this driver is capability
   * complete. Every entry below moved in the packet that drilled it and in no
   * other, which is the discipline the declaration exists to keep: a capability
   * states what a caller may rely on, so it may never run ahead of the code
   * that honours it.
   *
   * `TIMER` is `SUPPORTED` as of V2-B2-5, and only because that packet drilled
   * it. It is a delayed send, so the ENGINE holds the schedule: the drills fire
   * one exactly once and land it in the ledger, kill the endpoint child and
   * kill the server on the same data root and still get exactly one firing, ask
   * twice and get one scheduled walk, and — the discriminator — prove the beat
   * was genuinely held rather than merely slow by driving a second, undelayed
   * task to completion in the same window and finding the delayed task's trail
   * still empty. The malformed-duration negative refuses with zero engine calls
   * observed, which matters more than it looks: the server accepts a malformed
   * delay and ignores it, so without that refusal a broken timer would look
   * like a fired one.
   *
   * `SIGNAL` is `SUPPORTED` as of V2-B2-5, and only because that packet drilled
   * it. It resolves a named durable promise on a dedicated `AcpGate` workflow
   * keyed by the DERIVED invocation id, so no engine-minted identifier is
   * looked up, returned or kept. The drills release a held gate exactly once,
   * release the INTENDED one while a second gate stays held, cover both replay
   * orders across an endpoint SIGKILL, and — the case the rejected
   * awakeable design structurally could not pass — release a gate whose `run`
   * had not been submitted yet and observe the later `run` return immediately.
   * `AcpTask` is untouched by all of it, which is why the serialization and
   * cancellation drills are re-run unmodified as preservation assertions.
   *
   * `CANCEL` is `SUPPORTED` as of V2-B2-4b, and only because that packet
   * drilled it. Cancellation is three ordered acts: refuse a terminal task
   * before anything happens, stop the engine out of band, then settle the
   * ledger truth probe-first. The drills measure the order rather than the
   * membership — a `NOT_DONE` effect yields exactly one `TASK_CANCELLED`, a
   * `DONE` effect closes the OUTCOME *before* it, an `UNKNOWN` effect appends
   * nothing at all and leaves the intent open, and a `CHECKPOINTED` task is
   * refused without an engine call. Mid-beat preemption is deliberately NOT
   * part of it; see `cancel` below.
   *
   * `REATTACH` is `SUPPORTED` as of V2-B2-4a, and only because that packet
   * drilled it. `reattach` below rejoins a live invocation at the address this
   * side derived before ingress, so the drills could measure the thing that
   * actually distinguishes reattachment from resubmission: a send that returns
   * while the invocation is still held, an attach on the derived key that
   * answers with the same result a blocking submission answers with, a fresh
   * process attaching after the first attaching process was killed, and two
   * concurrent attaches observing ONE invocation, one effect and one append
   * set. The wrong-segmentation and never-issued-key negatives refuse without
   * touching the ledger, which is what makes the positives mean the derived
   * key is what resolved them.
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
        CANCEL: "SUPPORTED",
        REATTACH: "SUPPORTED",
        SIGNAL: "SUPPORTED",
        TIMER: "SUPPORTED",
      },
      properties: { SERIALIZED_PER_TASK: "SUPPORTED" },
    };
  }

  /**
   * Abandon a durable invocation, and settle what the log says (V2-B2-4b).
   *
   * Three acts, in an order that is the whole content of the design.
   *
   * **1. Refuse a terminal task, before the engine and before the ledger.**
   * `cancellationPrecheck` reads the state from the ledger. A task that has
   * already ended is refused with nothing done to it — not one engine call,
   * not one append. The ledger would not have caught this: its only lifecycle
   * rule is continuity, so a `TASK_CANCELLED` declaring
   * `fromState: "CHECKPOINTED"` matches the row and would be accepted.
   * Continuity is checked in the same act, and for the reason `advance`
   * checks it: cancelling a task another attempt began would settle one
   * request's work under another request's identity.
   *
   * **2. Stop the engine, out of band.** `cancelAdvance` resolves the engine's
   * own invocation id transiently and cancels it. Nothing has been claimed in
   * the log yet, so a failure here leaves the ledger exactly as it was.
   * `404` and `409` are not failures for this purpose and are treated as
   * success: both mean the engine is not running this invocation, which is the
   * postcondition this act exists to reach. Anything else — unreachable, a
   * 5xx, a malformed lookup — THROWS before the ledger is touched, because a
   * settlement written while the invocation might still be retrying is exactly
   * the interleaving act 2 is ordered first to prevent.
   *
   * **3. Settle the ledger, probe-first.** `settleCancellation` holds the
   * policy, in the domain, so a second driver that learns to cancel inherits
   * it. `UNKNOWN` appends nothing and refuses.
   *
   * The residual window between acts 2 and 3 is safe and self-healing: the
   * engine is stopped and the ledger still carries an open intent, which is
   * precisely the state `reconcile` classifies without guessing and the
   * operator path this plane already has. The drill kills the cancelling
   * process in exactly that window and asserts it.
   *
   * **This is not mid-beat preemption, and that is deferred deliberately.**
   * `advance` is an exclusive object handler, so while a walk holds the key
   * nothing else runs on it — the property B2-3 certified. A cancel handler on
   * the object would therefore QUEUE BEHIND the very walk it was meant to
   * interrupt, which is why cancellation is an out-of-band engine call plus an
   * in-process settlement and not a third handler. The two routes to real
   * preemption are refused here with reasons: a cancellation flag in
   * `RestateCacheState` is forbidden without an ADR by that type's own law and
   * would be a fact the ledger does not hold, i.e. a second authority; and a
   * SHARED cancel handler appending while the exclusive walk also appends
   * would put two concurrent ledger writers on one task, destroying the
   * per-task serialization B2-3 just certified. A cancellation therefore takes
   * effect between beats, not inside one.
   */
  async cancel(invocation: DurableInvocation): Promise<DriverOutcome> {
    const context: BeatContext = {
      ...this.#beat(invocation),
      plan: planFor(this.#commitPolicy),
      initiativeId: this.#initiativeId,
    };

    // Act 1.
    assertInvocationContinuity(context);
    if (!cancellationPrecheck(context).proceed) {
      return { ok: false, refusal: "TASK_TERMINAL", at: "cancel" };
    }

    // Act 2.
    const stopped = await cancelAdvance(
      this.#options.ingressUrl,
      this.#options.adminUrl,
      invocation,
    );
    if (!stopped.ok && stopped.status !== 404 && stopped.status !== 409) {
      throw new SupervisorError(
        "the engine did not accept the cancellation and answered " +
          String(stopped.status) +
          "; the ledger is untouched because a settlement over an invocation" +
          " that may still be retrying could be followed by its next beat",
      );
    }

    // Act 3.
    const settlement = await settleCancellation(context);
    switch (settlement.verdict) {
      case "CANCELLED":
        return { ok: true, finalSequence: this.#options.ledger.status().headSequence };
      case "POSTCONDITION_UNKNOWN":
        return { ok: false, refusal: "POSTCONDITION_UNKNOWN", at: "cancel" };
      case "TASK_TERMINAL":
        // The race act 1 cannot see into: the walk finished between the two
        // acts. Same refusal, and still nothing appended.
        return { ok: false, refusal: "TASK_TERMINAL", at: "cancel" };
    }
  }

  /**
   * Release the durable gate this invocation names (V2-B2-5).
   *
   * One request, to a workflow keyed by `invocation.invocationId` — the id this
   * side derived from `(taskId, attempt)` before ingress. There is no lookup,
   * no admin call and no journal read, so unlike `cancel` this verb never even
   * learns an engine-minted identity, let alone keeps one.
   *
   * **It appends nothing, and that is the intended shape.** Waiting is not a
   * lifecycle transition: the ledger records what the task DID, and a task that
   * paused did nothing. Inventing a `TASK_WAITING` event would have added a
   * lifecycle state, a transition and a module for a fact no caller needs, so
   * the verb answers with the bare `{ ok: true }` the contract already sanctions
   * for a verb that observes no ledger position.
   *
   * **A non-2xx throws rather than refusing**, on exactly `reattach`'s
   * reasoning below: the only refusal this contract has is
   * `CAPABILITY_UNSUPPORTED`, and the capability is present. A gate that could
   * not be reached is a failure of the channel, not an answer about the work,
   * and reporting it as a refusal would tell a caller this engine cannot signal
   * when what happened is that this attempt could not deliver.
   *
   * That includes the `409 "promise was already completed"` a second release
   * earns. It is deliberately NOT translated into success here: only a caller
   * holding the ledger may decide what a second signal means, and quietly
   * reporting `ok` would erase the difference between "released it" and "found
   * it already released".
   */
  async signal(invocation: DurableInvocation): Promise<DriverOutcome> {
    const released = await resolveGate(this.#options.ingressUrl, invocation);
    if (!released.ok) {
      // The status, never the body: a router or handler error text is engine
      // output and may name an engine invocation id.
      throw new SupervisorError(
        "the durable gate for this invocation answered " +
          String(released.status) +
          "; the ledger remains the authority on what the task did",
      );
    }
    return { ok: true };
  }

  /**
   * Ask the engine to begin the walk later, and to hold the schedule itself
   * (V2-B2-5).
   *
   * A delayed send: the same target and the same derived idempotency key
   * `sendAdvance` uses, plus `?delay=<ISO8601>`. The engine owns the timer, so
   * it survives this process dying and it survives the server being killed and
   * restarted on the same data root — which is precisely what separates a
   * durable timer from a `setTimeout` that dies with whoever set it. Nothing
   * here sleeps in-process.
   *
   * **A malformed duration is refused before the wire, and that is not
   * defensive.** Measured against the pinned server, `?delay=3s` is accepted
   * with `202` and simply ignored — so an unvalidated bad duration silently
   * becomes no delay at all, and a timer nobody set is indistinguishable from
   * one that already fired. `sendAdvanceDelayed` therefore validates first, and
   * the refusal costs zero engine calls.
   *
   * Like `signal`, it appends nothing at call time and answers `{ ok: true }`:
   * what the scheduled walk eventually does is recorded by the walk, in the
   * events it always wrote.
   */
  async timer(invocation: DurableInvocation, delayMs: number): Promise<DriverOutcome> {
    const scheduled = await sendAdvanceDelayed(this.#options.ingressUrl, invocation, delayMs);
    if (!scheduled.ok) {
      throw new SupervisorError(
        "the engine did not accept the durable timer and answered " +
          String(scheduled.status) +
          "; nothing was scheduled and the ledger is untouched",
      );
    }
    return { ok: true };
  }

  /**
   * Rejoin an invocation already in flight, rather than starting a second one
   * (V2-B2-4a).
   *
   * The address is recomputed, never remembered: `invocation.invocationId` is
   * `deriveInvocation`'s output for `(taskId, attempt)`, so this method needs
   * no state of its own and a caller that restarted can call it with an
   * invocation it rebuilt from coordinates. Nothing Restate mints is read,
   * returned or stored.
   *
   * Three answers, and the shape of each is deliberate.
   *
   * It never returns a `DriverRefused`, because the only refusal this contract
   * has is `CAPABILITY_UNSUPPORTED` and the capability is present: a server
   * that could not be reached, an address that does not resolve or an
   * invocation the engine has never heard of are failures of the OBSERVATION
   * channel, not answers about the work. Reporting one as a refusal would tell
   * a caller the engine cannot reattach when what actually happened is that
   * this attempt could not see. So those throw, and the caller falls back to
   * the authority that always knows — the ledger.
   *
   * What it returns on success is a ledger coordinate and only that. The
   * handler's own output is `{ finalSequence }`, the head the walk reached, so
   * the accepted arm carries a number the ledger can restate for itself rather
   * than anything belonging to the engine.
   */
  async reattach(invocation: DurableInvocation): Promise<DriverOutcome> {
    const result = await attachAdvance(this.#options.ingressUrl, invocation);
    if (!result.ok) {
      // The status, never the body: a router or handler error text is engine
      // output and may name an engine invocation id.
      throw new SupervisorError(
        "the attach for this invocation answered " +
          String(result.status) +
          "; the ledger remains the authority on what the task did",
      );
    }
    return { ok: true, finalSequence: parseFinalSequence(result.body) };
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
