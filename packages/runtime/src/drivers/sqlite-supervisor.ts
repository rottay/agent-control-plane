import { CONTRACT_VERSION } from "@acp/contracts";
import type {
  ControlPlaneEvent,
  DriverMode,
  DriverStatus,
  ReconciliationReport,
  TaskState,
} from "@acp/contracts";
import { canonicalJsonStringify } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";

import { DATA_ROOT_DRILLS } from "../constants.js";
import type { DurableInvocation, OrchestrationDriver, PostconditionVerdict } from "../contracts.js";
import { deriveEventCoordinate } from "../core/coordinates.js";
import { buildEvent, operationForStep } from "../core/events.js";
import {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  PLAN_TERMINAL_STATE,
  planStep,
} from "../core/lifecycle.js";
import type { PlanStep } from "../core/lifecycle.js";
import { LifecyclePlanError, PostconditionUnknownError, SupervisorError } from "../errors.js";
import { applyEffect, probeEffect } from "../toy/repository.js";
import type { ScenarioRoot } from "../toy/repository.js";

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
  advance(invocation: DurableInvocation, from: TaskState): Promise<ControlPlaneEvent | null> {
    this.#assertInvocationContinuity(invocation);

    const actual = this.#currentState();
    if (actual === null) {
      // The frozen interface takes a TaskState, so there is no way to express
      // "this task does not exist yet" and no way for a caller's claim to be
      // true. The first step is reached through runToCheckpoint, which reads
      // the absence itself rather than being told about it.
      throw new SupervisorError(
        "refusing to advance: the ledger has no state for this task, so the" +
          " caller's claimed state cannot be true; the first step is not" +
          " addressable through advance",
      );
    }
    if (actual !== from) {
      throw new SupervisorError(
        "refusing to advance: the caller claims state " +
          from +
          " but the ledger reports " +
          actual +
          "; acting on the claim could perform an effect the lifecycle never" +
          " authorised",
      );
    }

    // Deliberately `actual`, never `from`. The check above proves they agree
    // right now; using the authority's answer keeps that true if the check ever
    // moves or a future state is added.
    const step = this.#nextStep(invocation, actual);
    return Promise.resolve(this.#executeStep(invocation, step).event);
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

    this.#assertInvocationContinuity(this.#invocation);

    for (let guard = 0; guard <= LIFECYCLE_PLAN.length + 1; guard += 1) {
      const current = this.#currentState();
      if (current === PLAN_TERMINAL_STATE) {
        return { finalState: current, appended, replayed };
      }

      const step = this.#nextStep(this.#invocation, current);
      const outcome = this.#executeStep(this.#invocation, step);
      if (outcome.inserted) appended += 1;
      else replayed += 1;
    }

    throw new SupervisorError("the plan did not reach a terminal state within its bound");
  }

  /**
   * Refuse to continue work that a different invocation began.
   *
   * Resuming mid-plan never rebuilds the steps already in the ledger, so a
   * changed invocation would sail past the idempotency check: only the
   * REMAINING keys get written, and none of them collide. A task begun under
   * one submission would then be finished under another, with the log carrying
   * two identities for one attempt and no error anywhere.
   *
   * The lookup deliberately starts from the TASK, not from the incoming
   * invocation's idempotency key. Keying on the incoming attempt is itself the
   * hole: a changed attempt builds a different key, finds nothing, and is
   * waved through -- which then performs a second effect and appends an
   * attempt-2 outcome onto an attempt-1 task. Reading the projection first
   * makes the check independent of what the caller claims.
   *
   * Three refusals, in order:
   *
   * 1. a task exists but the attempt differs. This lifecycle is single-attempt;
   *    genuine retry semantics must arrive as an explicit lifecycle contract,
   *    not through a gap in a guard;
   * 2. a task exists but its first event cannot be read. A projection without
   *    the history that produced it is corruption, and corruption fails closed;
   * 3. the stored first event differs from the rebuilt one. That single
   *    comparison covers the submission digest, the invocation id through
   *    `eventId`, the submitted instant through both timestamps, and the
   *    emitter.
   *
   * All of it happens before any probe, any effect and any append.
   */
  #assertInvocationContinuity(invocation: DurableInvocation): void {
    const task = this.#ledger.getTask(invocation.taskId);
    if (task === null) return;

    if (invocation.attempt !== task.latestAttempt) {
      throw new SupervisorError(
        "refusing to resume: this task is on attempt " +
          String(task.latestAttempt) +
          " and the invocation claims attempt " +
          String(invocation.attempt) +
          "; a new attempt would perform the effect a second time and record an" +
          " outcome against work another attempt began",
      );
    }

    const recorded = this.#ledger.getEventBySequence(task.firstSequence);
    if (recorded === null) {
      throw new SupervisorError(
        "refusing to resume: the task projection exists but its first event" +
          " could not be read; a projection without the history that produced it" +
          " is corruption, not a starting point",
      );
    }

    const rebuilt = buildEvent({ invocation, step: planStep(0), emittedBy: this.#emittedBy });
    if (recorded.canonicalJson !== canonicalJsonStringify(rebuilt)) {
      throw new SupervisorError(
        "refusing to resume: these coordinates were begun by a different" +
          " invocation, and continuing would finish one request's work under" +
          " another request's identity",
      );
    }
  }

  /**
   * Perform one plan step, whatever its beat, with the beat's own guarantees.
   *
   * One implementation, used by both the loop and the public one-step call.
   * Writing this twice is how the two paths came to disagree about whether an
   * outcome needs evidence.
   */
  #executeStep(
    invocation: DurableInvocation,
    step: PlanStep,
  ): { readonly event: ControlPlaneEvent | null; readonly inserted: boolean } {
    if (step.beat === "INTENT") {
      const event = this.#appendStep(invocation, step);
      this.#fault("AFTER_INTENT");
      applyEffect(this.#scenarioRoot, operationForStep(invocation, step));
      this.#fault("AFTER_EFFECT");
      return { event, inserted: event !== null };
    }

    if (step.beat === "OUTCOME") {
      const closed = this.#closeIntent(invocation);
      this.#fault("AFTER_OUTCOME");
      return closed;
    }

    const event = this.#appendStep(invocation, step);
    return { event, inserted: event !== null };
  }

  /**
   * Close an open intent: probe first, act only if needed, then append.
   *
   * This is the three-beat recovery, and the order is the point. The outcome is
   * appended only after the effect is known to have happened, because an append
   * is a claim and a claim written early cannot be retracted by a log that only
   * grows.
   */
  #closeIntent(invocation: DurableInvocation): {
    readonly event: ControlPlaneEvent | null;
    readonly inserted: boolean;
  } {
    const operation = operationForStep(invocation, INTENT_STEP);

    let verdict: PostconditionVerdict = probeEffect(this.#scenarioRoot, operation);
    if (verdict === "NOT_DONE") {
      applyEffect(this.#scenarioRoot, operation);
      verdict = probeEffect(this.#scenarioRoot, operation);
    }

    if (verdict !== "DONE") {
      throw new PostconditionUnknownError(
        operation.operationId,
        "the effect's postcondition could not be established; the intent stays open",
      );
    }

    // Reported honestly: an outcome that already existed is a replay, not a
    // second append, and the run accounting must not claim otherwise.
    const event = this.#appendStep(invocation, OUTCOME_STEP);
    return { event, inserted: event !== null };
  }

  #appendStep(invocation: DurableInvocation, step: PlanStep): ControlPlaneEvent | null {
    const event = buildEvent({ invocation, step, emittedBy: this.#emittedBy });
    const result = this.#ledger.append(event);
    return result.inserted ? result.record.event : null;
  }

  /** The task's state according to the ledger. Never a field on this object. */
  #currentState(): TaskState | null {
    const task = this.#ledger.getTask(this.#invocation.taskId);
    return task === null ? null : task.currentState;
  }

  /**
   * Choose the next step from ledger evidence alone.
   *
   * `RUNNING` is the one ambiguous state, because both the intent and the
   * outcome land there. The tie is broken by asking the ledger whether the
   * outcome event exists, which is evidence rather than memory.
   */
  #nextStep(invocation: DurableInvocation, current: TaskState | null): PlanStep {
    if (current === null) return this.#stepFor(null);

    if (current === "RUNNING") {
      const key = deriveEventCoordinate(
        invocation,
        OUTCOME_STEP.transitionId,
        OUTCOME_STEP.index,
      ).idempotencyKey;
      const outcome = this.#ledger.getEventByIdempotencyKey(key);
      return outcome === null ? OUTCOME_STEP : this.#stepAfter(OUTCOME_STEP.index);
    }

    return this.#stepFor(current);
  }

  #stepFor(current: TaskState | null): PlanStep {
    const step = LIFECYCLE_PLAN.find((candidate) => candidate.fromState === current);
    if (step === undefined) {
      throw new LifecyclePlanError(
        "no plan step leaves the observed state; the ledger and the plan disagree",
      );
    }
    return step;
  }

  #stepAfter(index: number): PlanStep {
    const step = LIFECYCLE_PLAN[index + 1];
    if (step === undefined) {
      throw new LifecyclePlanError("the plan has no step after index " + String(index));
    }
    return step;
  }

  #fault(point: FaultPoint): void {
    if (this.#faultPoint === point && this.#onFault !== undefined) {
      this.#onFault();
    }
  }
}
