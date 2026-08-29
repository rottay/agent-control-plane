import { CONTRACT_VERSION } from "@acp/contracts";
import type {
  ControlPlaneEvent,
  DriverMode,
  DriverStatus,
  ReconciliationReport,
  TaskState,
} from "@acp/contracts";
import type { Ledger } from "@acp/ledger";

import { DATA_ROOT_DRILLS } from "../../constants/index.js";
import type { DurableInvocation, OrchestrationDriver } from "../../contracts/index.js";
import { deriveEventCoordinate } from "../../core/coordinates/index.js";
import { LIFECYCLE_PLAN, PLAN_TERMINAL_STATE } from "../../core/lifecycle/index.js";
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
import { SupervisorError } from "../../errors/index.js";
import { applyEffect, probeEffect } from "../../toy/repository/index.js";
import type { ScenarioRoot } from "../../toy/repository/index.js";

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
   * The scenario's own directory, as an opaque value only `resolveScenarioRoot`
   * can produce. A plain string is deliberately not accepted: a caller that
   * could name a directory could name a real repository.
   */
  readonly scenarioRoot: ScenarioRoot;
  readonly emittedBy: string;
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

export class SqliteSupervisor implements OrchestrationDriver {
  readonly mode: DriverMode = "SQLITE_SUPERVISOR";

  readonly #ledger: Ledger;
  readonly #invocation: DurableInvocation;
  readonly #scenarioRoot: ScenarioRoot;
  readonly #emittedBy: string;
  readonly #faultPoint: FaultPoint | undefined;
  readonly #onFault: (() => void) | undefined;

  constructor(options: SqliteSupervisorOptions) {
    this.#ledger = options.ledger;
    this.#invocation = options.invocation;
    this.#scenarioRoot = options.scenarioRoot;
    this.#emittedBy = options.emittedBy;
    this.#faultPoint = options.__faultPoint;
    this.#onFault = options.__onFault;
  }

  // -------------------------------------------------------------------------
  // OrchestrationDriver
  // -------------------------------------------------------------------------

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
  // eslint-disable-next-line @typescript-eslint/require-await
  async advance(
    invocation: DurableInvocation,
    from: TaskState,
  ): Promise<ControlPlaneEvent | null> {
    // `async` so a refused claim is a rejection rather than a synchronous throw
    // from a promise-returning method.
    const context = this.#beat(invocation);
    assertInvocationContinuity(context);

    // The claim is checked against the authority and then discarded: the state
    // that selects the step is the one the ledger reports, never the argument.
    const actual = assertClaimedState(context, from);
    const step = executorNextStep(context, actual);
    return this.#executeStep(context, step).event;
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
  runToCheckpoint(): RunResult {
    let appended = 0;
    let replayed = 0;

    const context = this.#beat(this.#invocation);
    assertInvocationContinuity(context);

    for (let guard = 0; guard <= LIFECYCLE_PLAN.length + 1; guard += 1) {
      const current = executorCurrentState(context);
      if (current === PLAN_TERMINAL_STATE) {
        return { finalState: current, appended, replayed };
      }

      const step = executorNextStep(context, current);
      const outcome = this.#executeStep(context, step);
      if (outcome.inserted) appended += 1;
      else replayed += 1;
    }

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
    const scenarioRoot = this.#scenarioRoot;
    const effects: EffectPort = {
      apply: (operation) => {
        applyEffect(scenarioRoot, operation);
      },
      probe: (operation) => probeEffect(scenarioRoot, operation),
    };
    return { ledger: this.#ledger, effects, invocation, emittedBy: this.#emittedBy };
  }

  /**
   * Perform one plan step, whatever its beat, with the beat's own guarantees.
   *
   * One implementation, used by both the loop and the public one-step call.
   * Writing this twice is how the two paths came to disagree about whether an
   * outcome needs evidence.
   */
  #executeStep(context: BeatContext, step: PlanStep): BeatResult {
    if (step.beat === "INTENT") {
      const result = appendPlanStep(context, step);
      this.#fault("AFTER_INTENT");
      applyIntentEffect(context, step);
      this.#fault("AFTER_EFFECT");
      return result;
    }

    if (step.beat === "OUTCOME") {
      const closed = closeIntent(context);
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
