import { CONTRACT_VERSION } from "@acp/contracts";
import type {
  CommitPolicy,
  ControlPlaneEvent,
  DriverCapabilities,
  DriverMode,
  DriverOutcome,
  DriverRefused,
  DriverStatus,
  ReconciliationReport,
  ResolvedRoute,
  TaskState,
} from "@acp/contracts";
import type { Ledger } from "@acp/ledger";

import { DATA_ROOT_DRILLS } from "../../constants/index.js";
import type { DurableInvocation, OrchestrationDriver } from "../../contracts/index.js";
import { deriveEventCoordinate } from "../../core/coordinates/index.js";
import { PLAN_TERMINAL_STATE, SHARED_PLAN_PREFIX, planFor } from "../../core/lifecycle/index.js";
import type { PlanStep } from "../../core/lifecycle/index.js";
import {
  appendPlanStep,
  applyIntentEffect,
  assertClaimedState,
  assertInvocationContinuity,
  closeIntent,
  currentState as executorCurrentState,
  nextStep as executorNextStep,
} from "../../core/step-executor/index.js";
import type { BeatContext, BeatResult, EffectPort } from "../../core/step-executor/index.js";
import type { CheckpointPort } from "../../checkpoint/index.js";
import type { SwitchPort } from "../../switch-executor/index.js";
import { SupervisorError } from "../../errors/index.js";
import { classifyFailure, settleFailure } from "../../failure/index.js";

/**
 * The SQLite supervisor: a single process walking the shared plan.
 *
 * This is not a degraded path. It is a first-class driver, and it is the
 * predetermined answer if the Restate drills fail. It holds no durable state of
 * its own: every decision about what to do next is read back out of the ledger,
 * which is what makes "the ledger is the authority" true rather than aspirational.
 *
 * There is deliberately no cursor field on this class. A cursor would be a
 * second account of how far the work has got, and a second account is exactly
 * the thing that can disagree with the ledger after a crash.
 */

/** Where a run may be interrupted. Test-only, and never set in normal use. */
export type FaultPoint = "AFTER_INTENT" | "AFTER_EFFECT" | "AFTER_OUTCOME";

export interface SqliteSupervisorOptions {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  /**
   * The side effect this run performs, injected and never defaulted (V2-B1b).
   *
   * Until stage 2 this class bound the toy filesystem marker itself, which
   * made the toy the only effect a production walk could ever have. Now the
   * caller says which port the beats drive: the daemon hands in the
   * execution-backed port over the owned boundary, the drill children hand in
   * the toy explicitly, and a caller that says nothing gets no supervisor. A
   * default here would re-hide the binding this packet exists to make visible.
   */
  readonly effects: EffectPort;
  readonly emittedBy: string;
  /**
   * The packet's commit policy, which selects the plan this run walks.
   *
   * Required, with no default. Defaulting to the commit-capable plan would let
   * a caller that never mentioned a policy walk a read-only packet into
   * `READY_TO_COMMIT`, and a silent default is exactly the class of defect this
   * program refuses.
   */
  readonly commitPolicy: CommitPolicy;
  /**
   * The initiative this packet belongs to.
   *
   * Required, never defaulted, exactly like `commitPolicy`. It arrives with the
   * packet and reaches the ledger in the discovery event's payload.
   */
  readonly initiativeId: string;
  /**
   * The route this run was admitted on (V2-B1c).
   *
   * Required, never defaulted, exactly like `commitPolicy` and `initiativeId`.
   * It arrives with the packet already admitted through the contract, reaches
   * the ledger in the INTENT event's payload, and is never resolved here: this
   * driver holds no routing authority, and a default would put a route in the
   * log that nothing chose.
   */
  readonly route: ResolvedRoute;
  /**
   * Where this run's checkpoint is persisted (V2-B1f/F3).
   *
   * Optional and never defaulted, unlike the four fields above, and the
   * difference is deliberate: a missing policy, initiative or route would be a
   * value silently invented, whereas a missing checkpoint port is a
   * construction that truthfully cannot write one — and the terminal beat
   * refuses on it rather than appending a `CHECKPOINT_WRITTEN` with nothing
   * behind it. `forLifecycle` binds none, because a lifecycle construction
   * walks the shared prefix and never reaches a terminal.
   */
  readonly checkpoints?: CheckpointPort | undefined;
  /**
   * The seam that plays a switch this walk did not decide (V2-B1f/F4d).
   *
   * Optional, and **the optionality is the refusal**, exactly as `checkpoints`
   * above documents it: a construction with no port truthfully cannot switch,
   * which is true of both drill children and of every lifecycle verb. Nothing
   * is defaulted, because a default would be a switch nobody authorized.
   *
   * It is asked once, in the catch below, before the failure settles — the one
   * moment in a walk where the task is still `RUNNING`, its INTENT is durable,
   * its pressure is recorded and nothing has settled yet.
   */
  readonly switchPort?: SwitchPort | undefined;
  /**
   * Deliberate interruption seam, for the kill/restart drills only.
   *
   * Rollback and recovery are claims that cannot be verified by reading code.
   * The only honest proof is to stop the process at a chosen instant and show
   * what the ledger contains afterwards, so this hook exists to make that
   * possible. Nothing sets it by default.
   */
  readonly __faultPoint?: FaultPoint | undefined;
  /** Invoked at the fault point. The drill passes a real process kill. */
  readonly __onFault?: (() => void) | undefined;
}

export interface RunResult {
  readonly finalState: TaskState;
  readonly appended: number;
  readonly replayed: number;
}

/**
 * The one refusal this driver returns, built in one place.
 *
 * `at` names the verb and nothing else — never engine output, never a path, and
 * never anything about the work being advanced.
 */
function unsupported(at: string): DriverRefused {
  return { ok: false, refusal: "CAPABILITY_UNSUPPORTED", at };
}

/**
 * What a lifecycle-shaped construction supplies (V2 L2).
 *
 * Every field `SqliteSupervisorOptions` requires except `commitPolicy`, and the
 * omission is the point rather than a convenience. `cancel` and `reattach` are
 * the only verbs this construction serves, both are declared `UNSUPPORTED` by
 * this driver, and neither reads a plan — so there is no policy for the caller
 * to supply and nothing it could truthfully mean. Requiring one anyway would
 * make a door invent a value at the one seam in this package where commit
 * capability is decided, which is the defect `planFor`'s throw exists to catch.
 */
export interface SqliteSupervisorLifecycleOptions {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly effects: EffectPort;
  readonly emittedBy: string;
  readonly initiativeId: string;
  readonly route: ResolvedRoute;
}

/**
 * The marker a lifecycle construction passes instead of a commit policy.
 *
 * A module-private symbol, so it is unspellable from outside this file: the
 * public constructor still takes `SqliteSupervisorOptions` and a caller still
 * cannot omit `commitPolicy` or pass anything the contract's enum does not
 * admit. The only way to reach the plan-free construction is `forLifecycle`,
 * which is what keeps "no default plan" true while giving the verbs that read
 * no plan a way to exist.
 */
const LIFECYCLE_CONSTRUCTION: unique symbol = Symbol("acp.sqlite-supervisor.lifecycle");

/** A commit policy, or the marker that says there is none to have. */
type PlanSelector = CommitPolicy | typeof LIFECYCLE_CONSTRUCTION;

/** The options as this file reads them, marker included. Never public. */
interface SupervisorConstruction extends Omit<SqliteSupervisorOptions, "commitPolicy"> {
  readonly commitPolicy: PlanSelector;
}

export class SqliteSupervisor implements OrchestrationDriver {
  readonly mode: DriverMode = "SQLITE_SUPERVISOR";

  readonly #ledger: Ledger;
  readonly #invocation: DurableInvocation;
  readonly #effects: EffectPort;
  readonly #emittedBy: string;
  readonly #plan: readonly PlanStep[];
  readonly #initiativeId: string;
  readonly #route: ResolvedRoute;
  readonly #checkpoints: CheckpointPort | undefined;
  readonly #switchPort: SwitchPort | undefined;
  readonly #faultPoint: FaultPoint | undefined;
  readonly #onFault: (() => void) | undefined;
  /** True when this object was built for the lifecycle verbs and may not walk. */
  readonly #lifecycleOnly: boolean;

  constructor(options: SqliteSupervisorOptions) {
    this.#ledger = options.ledger;
    this.#invocation = options.invocation;
    this.#effects = options.effects;
    this.#emittedBy = options.emittedBy;
    // The cast reads the marker `forLifecycle` may have put here. It widens
    // what this file sees, never what a caller may pass: the parameter type
    // above is unchanged, so `commitPolicy` is still required and still a
    // `CommitPolicy` to everyone outside this module.
    const selector = options.commitPolicy as PlanSelector;
    this.#lifecycleOnly = selector === LIFECYCLE_CONSTRUCTION;
    this.#plan = this.#lifecycleOnly ? SHARED_PLAN_PREFIX : planFor(selector as CommitPolicy);
    this.#initiativeId = options.initiativeId;
    this.#route = options.route;
    this.#checkpoints = options.checkpoints;
    this.#switchPort = options.switchPort;
    this.#faultPoint = options.__faultPoint;
    this.#onFault = options.__onFault;
  }

  /**
   * Build a supervisor for the lifecycle verbs, with no commit policy (V2 L2).
   *
   * The object is the real one — same class, same capability declaration, same
   * refusals — because a narrower stand-in would be simulated parity, and the
   * correspondence law that compares a driver's declaration against its
   * behaviour would then be checking something no door ever constructs.
   *
   * What it cannot do is walk. `#plan` is the prefix both plans share, which
   * has no closing step, so `advance` refuses rather than running out of plan
   * somewhere less legible.
   */
  static forLifecycle(options: SqliteSupervisorLifecycleOptions): SqliteSupervisor {
    const construction: SupervisorConstruction = {
      ...options,
      commitPolicy: LIFECYCLE_CONSTRUCTION,
    };
    return new SqliteSupervisor(construction as SqliteSupervisorOptions);
  }

  // -------------------------------------------------------------------------
  // OrchestrationDriver
  // -------------------------------------------------------------------------
  /**
   * What this engine can be asked for (V2-B2-1).
   *
   * All four verbs are `UNSUPPORTED`, and that is the honest answer rather than
   * a placeholder: this driver is a single process walking a plan, and it has
   * no durable timer, no external signal, no invocation to rejoin and no
   * cancellation channel of its own. Emulating any of them in-process — a
   * `setTimeout` calling itself a durable timer, say — would be simulated
   * parity, which is the one thing a two-driver plane must never publish.
   *
   * `SERIALIZED_PER_TASK` is `UNSUPPORTED` for a different reason, and it is
   * worth stating: the supervisor deliberately holds no cursor, because a
   * cursor would be a second account of how far the work has got. Any guard
   * that made per-task serialization true here would have to keep exactly such
   * an account, so the honest declaration is the negative one until a packet
   * proves otherwise.
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
      properties: { SERIALIZED_PER_TASK: "UNSUPPORTED" },
    };
  }

  /**
   * The four verbs, each refusing exactly what it declared it cannot do.
   *
   * A typed refusal, never a throw and never a silent no-op. A throw would make
   * "unsupported" indistinguishable from "broke"; a no-op would let a caller
   * believe the work happened. Neither delegates to the other driver: a
   * supervisor that quietly handed cancellation to Restate would make the mode
   * flag a lie, which is the failure this plane is built to refuse.
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


  status(): Promise<DriverStatus> {
    const status = this.#ledger.status();
    return Promise.resolve({
      contractVersion: CONTRACT_VERSION,
      mode: this.mode,
      health: "OK",
      observedAt: this.#invocation.submittedAt,
      ledgerHeadSequence: status.headSequence,
      ledgerHeadSha256: status.headEventSha256,
      dataRoot: DATA_ROOT_DRILLS,
      activeSince: this.#invocation.submittedAt,
      detail: null,
    });
  }

  /**
   * Compare this driver against the ledger.
   *
   * The supervisor keeps no durable state, so there is nothing that could be
   * ahead of or divergent from the ledger: the only honest verdicts are
   * `CONSISTENT` or a failure to read at all. It does not fabricate a cursor in
   * order to have something to compare, which would manufacture exactly the
   * second account this design exists to avoid.
   */
  reconcile(): Promise<ReconciliationReport> {
    const status = this.#ledger.status();
    const integrity = this.#ledger.verifyIntegrity();

    const report: ReconciliationReport = integrity.ok
      ? {
          contractVersion: CONTRACT_VERSION,
          reportId: deriveEventCoordinate(this.#invocation, "reconcile", 0).eventId,
          mode: this.mode,
          verdict: "CONSISTENT",
          observedAt: this.#invocation.submittedAt,
          ledgerHeadSequence: status.headSequence,
          ledgerHeadSha256: status.headEventSha256,
          resolvedByLedger: true,
          safeToResume: true,
          discrepancies: [],
          detail: null,
        }
      : {
          contractVersion: CONTRACT_VERSION,
          reportId: deriveEventCoordinate(this.#invocation, "reconcile", 0).eventId,
          mode: this.mode,
          verdict: "INDETERMINATE",
          observedAt: this.#invocation.submittedAt,
          ledgerHeadSequence: status.headSequence,
          ledgerHeadSha256: status.headEventSha256,
          resolvedByLedger: true,
          safeToResume: false,
          discrepancies: [],
          detail: "the ledger failed its own integrity check; no comparison is trustworthy",
        };

    return Promise.resolve(report);
  }

  /**
   * Advance one step from an observed state.
   *
   * This is the public one-step path, and it runs exactly the same recovery
   * logic as `runToCheckpoint`. That matters more than it looks: an earlier
   * version resolved `RUNNING` straight to the outcome step and appended it,
   * which wrote a permanent record claiming an effect had completed while no
   * effect existed on disk. An outcome is never appended here without probe
   * evidence that the effect is `DONE`.
   *
   * The caller's `from` is treated as a CLAIM, not as input. It is checked
   * against the ledger and then discarded: the state that drives the step
   * selection is the one the authority reports. Trusting the argument was a
   * real defect. A caller claiming `RUNNING` while the ledger said `RESERVED`
   * reached the outcome beat, probed `NOT_DONE`, performed the effect, and only
   * then failed on the lifecycle precondition -- leaving a side effect that had
   * happened with no intent recorded anywhere. The ledger never lied; the
   * effect simply occurred outside the three-beat law.
   *
   * Returns null when the step was an exact replay that appended nothing.
   */
  async advance(
    invocation: DurableInvocation,
    from: TaskState,
  ): Promise<ControlPlaneEvent | null> {
    // `async` so a refused claim is a rejection rather than a synchronous throw
    // from a promise-returning method.
    //
    // A lifecycle construction has no commit policy, so it has no plan to walk
    // and refuses before it reads anything. The refusal is not a capability
    // statement — this driver's `advance` is perfectly able — it is a statement
    // about this object: it was built to cancel or rejoin, and walking one
    // would be walking a plan nobody chose.
    if (this.#lifecycleOnly) {
      throw new SupervisorError(
        "this supervisor was constructed for the lifecycle verbs and walks no" +
          " plan; construct one with an explicit commit policy to advance",
      );
    }
    const context = this.#beat(invocation);
    assertInvocationContinuity(context);

    // The claim is checked against the authority and then discarded: the state
    // that selects the step is the one the ledger reports, never the argument.
    const actual = assertClaimedState(context, from);
    const step = executorNextStep(context, actual);
    const outcome = await this.#executeStep(context, step);
    return outcome.event;
  }

  // -------------------------------------------------------------------------
  // Bounded run
  // -------------------------------------------------------------------------

  /**
   * Walk the plan until the task is checkpointed.
   *
   * Bounded by the plan's own length plus one, so a defect that failed to make
   * progress terminates with a classified error instead of spinning.
   */
  async runToCheckpoint(): Promise<RunResult> {
    // Same refusal as `advance`, and for the same reason: a lifecycle
    // construction holds the shared prefix, which has no closing step. Refusing
    // at the door is legible; running out of plan at index 7 is not.
    if (this.#lifecycleOnly) {
      throw new SupervisorError(
        "this supervisor was constructed for the lifecycle verbs and walks no" +
          " plan; construct one with an explicit commit policy to run",
      );
    }
    let appended = 0;
    let replayed = 0;

    const context = this.#beat(this.#invocation);
    assertInvocationContinuity(context);

    // V2-B7R. The catch opens HERE, after `assertInvocationContinuity`, and not
    // before it. The prologue is different in kind: a continuity failure puts
    // the task's identity in question and a reconciliation refusal's whole law
    // is "fails closed with zero delta", so neither may settle. Wrapping them
    // would settle a failure about a task this walk may not be walking.
    try {
      // The bound comes from the plan this run walks, never from the writer plan:
      // a shorter plan must not be given a longer plan's budget to spin in.
      for (let guard = 0; guard <= this.#plan.length + 1; guard += 1) {
        const current = executorCurrentState(context);
        if (current === PLAN_TERMINAL_STATE) {
          return { finalState: current, appended, replayed };
        }

        const step = executorNextStep(context, current);
        const outcome = await this.#executeStep(context, step);
        if (outcome.inserted) appended += 1;
        else replayed += 1;
      }
    } catch (error: unknown) {
      // A classified step failure settles, and everything else propagates
      // untouched. `classifyFailure` is the shared decision — the Restate driver
      // asks the same function the same question — so the two lanes cannot
      // answer it differently.
      const decision = classifyFailure(error);

      // V2-B1f/F4d. The fork, and it is deliberately narrow.
      //
      // `classifyFailure` is **not** edited: it is the shared decision both
      // drivers ask, so editing it would change Restate's verdicts too. What
      // happens here instead is that a failure which *would* settle is offered
      // to the switch port first. A port that played a switch means the walk
      // must NOT settle — the attempt is now blocked awaiting a landing, and a
      // terminal event would foreclose it. `SWITCHED` means *do not settle*;
      // it never means *do not fail*, which is why the original error is still
      // thrown below on every path.
      //
      // The gate on `decision.settle` is what keeps this out of the way of
      // everything else: a plan failure, a postcondition unknown, a bound
      // exhaustion — none of them reaches the port at all.
      if (decision.settle && this.#switchPort !== undefined) {
        const played = await this.#switchPort.consider(context);
        if (played.kind === "SWITCHED") throw error;
      }

      if (decision.settle) {
        await settleFailure(context, decision.reason);
      }
      // The original error, always. A catch that returned would turn a failed
      // packet into a successful one, and a catch that re-wrapped would lose the
      // classification the caller above still needs.
      throw error;
    }

    // V2-B7T. The bound is exhausted, so this walk will not converge. Settle
    // first, then throw the same error: a task that stops here used to leave an
    // open task with no terminal event, which told a reader nothing at all and
    // told it indistinguishably from a task that was merely slow.
    //
    // The settlement reads, probes and appends; it performs no effect and
    // repairs nothing. It can conclude `POSTCONDITION_UNKNOWN` and append
    // nothing at all, which is the correct outcome when an effect may have
    // happened unrecorded — and the throw below is unchanged in either case, so
    // the daemon's unwind and its classified exit are exactly what they were.
    await settleFailure(context, "BOUND_EXHAUSTED");
    throw new SupervisorError("the plan did not reach a terminal state within its bound");
  }

  /**
   * Bind this driver's ledger and scenario into a beat context.
   *
   * The guards and the three beats live in `core/step-executor/index.ts` so the
   * Restate driver can journal each one separately. This supervisor keeps only
   * what is genuinely its own: the loop, the fault seam, and the ports.
   */
  #beat(invocation: DurableInvocation): BeatContext {
    return {
      ledger: this.#ledger,
      effects: this.#effects,
      invocation,
      emittedBy: this.#emittedBy,
      plan: this.#plan,
      initiativeId: this.#initiativeId,
      route: this.#route,
      checkpoints: this.#checkpoints,
    };
  }

  /**
   * Perform one plan step, whatever its beat, with the beat's own guarantees.
   *
   * One implementation, used by both the loop and the public one-step call.
   * Writing this twice is how the two paths came to disagree about whether an
   * outcome needs evidence.
   *
   * The fault seam fires at the same three instants it always did: after the
   * intent append, after the awaited effect has settled, and after the
   * awaited outcome has settled. The beats being asynchronous moves nothing
   * relative to them.
   */
  async #executeStep(context: BeatContext, step: PlanStep): Promise<BeatResult> {
    if (step.beat === "INTENT") {
      const result = appendPlanStep(context, step);
      this.#fault("AFTER_INTENT");
      await applyIntentEffect(context, step);
      this.#fault("AFTER_EFFECT");
      return result;
    }

    if (step.beat === "OUTCOME") {
      const closed = await closeIntent(context);
      this.#fault("AFTER_OUTCOME");
      return closed;
    }

    return appendPlanStep(context, step);
  }

  #fault(point: FaultPoint): void {
    if (this.#faultPoint === point && this.#onFault !== undefined) {
      this.#onFault();
    }
  }
}
