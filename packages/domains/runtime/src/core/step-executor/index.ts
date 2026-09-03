import type { ControlPlaneEvent, ResolvedRoute, TaskState } from "@acp/contracts";
import { canonicalJsonStringify } from "@acp/ledger";

import type {
  DurableInvocation,
  OperationCoordinate,
  PostconditionVerdict,
} from "../../contracts/index.js";
import { deriveEventCoordinate } from "../coordinates/index.js";
import { buildIdempotencyKey } from "@acp/contracts";

import { buildEvent, operationForStep } from "../events/index.js";
import { INTENT_STEP, OUTCOME_STEP, planStep } from "../lifecycle/index.js";
import type { PlanStep } from "../lifecycle/index.js";
import { LifecyclePlanError, PostconditionUnknownError, SupervisorError } from "../../errors/index.js";

/**
 * The one beat executor. Both drivers walk the plan through this module.
 *
 * P2B put these beats inside `SqliteSupervisor` as private methods, which was
 * fine while there was one driver. It stops being fine the moment a second one
 * arrives: the Restate handler must wrap each beat in its own `ctx.run`, and a
 * private method that fuses "append the intent" with "perform the effect"
 * cannot be journaled as two entries. Implementing the beats a second time
 * inside the Restate driver is the drift ADR 0004 exists to prevent, so the
 * beats moved here instead.
 *
 * Every function is sized to be one journal entry: it does one durable thing,
 * it is idempotent, and it returns the smallest value that describes what
 * happened. Nothing here reads a clock, a random source or the environment, and
 * nothing here knows what a Restate context is.
 *
 * The effect-bearing beats are asynchronous (V2-B1b, stage 1). A synchronous
 * port can only describe an effect that is finished the instant `apply`
 * returns; a real execution is in flight for a while, and a probe taken the
 * instant after a synchronous `apply` would read it as `NOT_DONE` and refuse
 * where the contract promises evidence. Awaiting the port changes what the
 * beat waits on and nothing else: the probe -> apply -> probe order and the
 * one-probe-one-meaning verdicts are exactly as they were.
 */

/** The ledger surface the beats need. Satisfied structurally by `Ledger`. */
export interface LedgerPort {
  append(candidate: unknown): { readonly inserted: boolean; readonly record: { readonly event: ControlPlaneEvent } };
  getTask(taskId: string): { readonly currentState: TaskState; readonly latestAttempt: number; readonly firstSequence: number } | null;
  getEventBySequence(sequence: number): { readonly canonicalJson: string } | null;
  getEventByIdempotencyKey(idempotencyKey: string): { readonly canonicalJson: string } | null;
}

/**
 * The side-effect surface the beats need.
 *
 * Both members return promises: the port may be a real execution whose
 * completion has to be awaited, not only a marker whose presence is read.
 */
export interface EffectPort {
  apply(operation: OperationCoordinate): Promise<void>;
  probe(operation: OperationCoordinate): Promise<PostconditionVerdict>;
}

export interface BeatContext {
  readonly ledger: LedgerPort;
  readonly effects: EffectPort;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /**
   * The plan this run walks, chosen at the driver boundary from the packet's
   * commit policy.
   *
   * Navigation reads this and never a module-global plan. A module constant
   * would make every run walk the commit-capable plan whatever its packet said,
   * which is the defect this field exists to make unrepresentable.
   */
  readonly plan: readonly PlanStep[];
  /**
   * The initiative this run's packet belongs to.
   *
   * Required, with no default, for the same reason `plan` is: an attribution
   * that could be omitted would be an attribution that silently defaulted, and
   * a task discovered under the wrong initiative is a reporting lie no later
   * event can correct. It reaches the ledger through the discovery event's
   * payload, and through continuity: because step 0's bytes carry it, resuming
   * the same coordinates under a *different* initiative rebuilds different
   * bytes and `assertInvocationContinuity` refuses.
   */
  readonly initiativeId: string;
  /**
   * The route this run was admitted on (V2-B1c).
   *
   * Required, with no default, exactly like `plan` and `initiativeId` above,
   * and carried on the context rather than looked up per beat because the
   * route is fixed for the attempt: a value that could change between two
   * beats of one walk would let the INTENT and the effect disagree about what
   * ran. It reaches the ledger through the INTENT event's payload and nowhere
   * else.
   *
   * The walk does not resolve it and does not verify it against a router: the
   * caller admitted it through the contract before the walk began, and this
   * domain holds no routing authority.
   */
  readonly route: ResolvedRoute;
}

/** What one durable beat did. Small, canonical, and safe to journal. */
export interface BeatResult {
  readonly event: ControlPlaneEvent | null;
  readonly inserted: boolean;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Refuse to continue work that a different invocation began.
 *
 * The lookup starts from the TASK, never from the incoming invocation's
 * idempotency key. Keying on the incoming attempt is itself a hole: a changed
 * attempt builds a different key, finds nothing, and is waved through -- which
 * then performs a second effect and appends its outcome onto another attempt's
 * task.
 */
export function assertInvocationContinuity(context: BeatContext): void {
  const { ledger, invocation, emittedBy, initiativeId, plan, route } = context;
  const task = ledger.getTask(invocation.taskId);
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

  const recorded = ledger.getEventBySequence(task.firstSequence);
  if (recorded === null) {
    throw new SupervisorError(
      "refusing to resume: the task projection exists but its first event" +
        " could not be read; a projection without the history that produced it" +
        " is corruption, not a starting point",
    );
  }

  // Step 0 is the same frozen object in every plan -- `READ_ONLY_PLAN` derives
  // steps 0-7 from the writer plan and the lifecycle test asserts the identity
  // -- so the rebuild does not depend on which plan this run walks.
  // Step 0 is `TASK_DISCOVERED`, a PLAIN beat, so the route does not enter its
  // payload and the rebuilt bytes are unchanged by V2-B1c. That is what keeps
  // a ledger written before this packet resuming byte-for-byte — and it is
  // also why a route substituted before the INTENT append is not refused here
  // yet: step 0 carries nothing that would differ. Binding the route into the
  // submission is a separate, later change.
  const rebuilt = buildEvent({ invocation, step: planStep(0), emittedBy, initiativeId, plan, route });
  if (recorded.canonicalJson !== canonicalJsonStringify(rebuilt)) {
    throw new SupervisorError(
      "refusing to resume: these coordinates were begun by a different" +
        " invocation, and continuing would finish one request's work under" +
        " another request's identity",
    );
  }
}

/**
 * Check a caller's claimed state against the ledger and return the truth.
 *
 * The claim is never used to select a step. Trusting it let a caller claiming
 * `RUNNING` while the ledger said `RESERVED` reach the outcome beat, perform the
 * effect, and only then fail -- leaving a side effect with no intent recorded.
 */
export function assertClaimedState(context: BeatContext, from: TaskState): TaskState {
  const actual = currentState(context);
  if (actual === null) {
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
  return actual;
}

// ---------------------------------------------------------------------------
// Plan navigation, from ledger evidence only
// ---------------------------------------------------------------------------

export function currentState(context: BeatContext): TaskState | null {
  const task = context.ledger.getTask(context.invocation.taskId);
  return task === null ? null : task.currentState;
}

/**
 * Choose the next step from ledger evidence alone.
 *
 * `RUNNING` is the one ambiguous state, because both the intent and the outcome
 * land there. The tie is broken by asking the ledger whether the outcome event
 * exists, which is evidence rather than memory.
 */
export function nextStep(context: BeatContext, current: TaskState | null): PlanStep {
  if (current === null) return stepFrom(context.plan, null);

  if (current === "RUNNING") {
    const key = deriveEventCoordinate(
      context.invocation,
      OUTCOME_STEP.transitionId,
      OUTCOME_STEP.index,
    ).idempotencyKey;
    const outcome = context.ledger.getEventByIdempotencyKey(key);
    return outcome === null ? OUTCOME_STEP : stepAfter(context.plan, OUTCOME_STEP.index);
  }

  return stepFrom(context.plan, current);
}

function stepFrom(plan: readonly PlanStep[], current: TaskState | null): PlanStep {
  const step = plan.find((candidate) => candidate.fromState === current);
  if (step === undefined) {
    throw new LifecyclePlanError(
      "no plan step leaves the observed state; the ledger and the plan disagree",
    );
  }
  return step;
}

function stepAfter(plan: readonly PlanStep[], index: number): PlanStep {
  const step = plan[index + 1];
  if (step === undefined) {
    throw new LifecyclePlanError("the plan has no step after index " + String(index));
  }
  return step;
}

// ---------------------------------------------------------------------------
// The three beats, each one journal entry
// ---------------------------------------------------------------------------

/**
 * Beat: append one plan step. Idempotent; a replay returns `inserted:false`.
 *
 * **Causation is advisory, and the guard below is why it is trustworthy
 * anyway (P8-8E2, C5).** The ledger's integrity machinery verifies hash
 * chains: `previousSha256`, `eventSha256`, the idempotency key. It does not
 * verify `causationId` -- an event whose causation names nothing, or names an
 * event in another task, is a perfectly valid ledger row. So the safety story
 * has exactly two halves and no third: this producer refuses to append a link
 * whose predecessor is not durably present, and the consumer
 * (`deriveGraph`) refuses to draw an edge it cannot resolve from data it
 * actually holds. Neither half trusts the other, and nothing between them
 * asserts a causal claim the ledger could not corroborate.
 */
export function appendPlanStep(context: BeatContext, step: PlanStep): BeatResult {
  const event = buildEvent({
    invocation: context.invocation,
    step,
    emittedBy: context.emittedBy,
    initiativeId: context.initiativeId,
    plan: context.plan,
    route: context.route,
  });

  assertCausalPredecessor(context, step, event.causationId);

  const result = context.ledger.append(event);
  return { event: result.inserted ? result.record.event : null, inserted: result.inserted };
}

/**
 * Refuse before appending when the causal predecessor is not durably there.
 *
 * The event this step threads to is derived, so the derivation always produces
 * *an* id; whether the ledger actually holds that event is a different
 * question, and the one worth asking. Two ways it can be false: the previous
 * step was never appended (a caller walking the plan out of order), or the row
 * under the predecessor's idempotency key is some other event (coordinates
 * reused across invocations). Both produce a chain that reads as causal and is
 * not, so both refuse **before** the append rather than after -- an append is a
 * claim, and a log that only grows cannot retract one.
 */
function assertCausalPredecessor(
  context: BeatContext,
  step: PlanStep,
  causationId: string | null,
): void {
  if (causationId === null) return;

  const previousStep = context.plan[step.index - 1];
  if (previousStep === undefined) {
    throw new LifecyclePlanError(
      "the plan has no step before index " + String(step.index) + "; the causal thread cannot be verified",
    );
  }

  const key = buildIdempotencyKey({
    taskId: context.invocation.taskId,
    attempt: context.invocation.attempt,
    transitionId: previousStep.transitionId,
  });
  const recorded = context.ledger.getEventByIdempotencyKey(key);
  if (recorded === null) {
    throw new SupervisorError(
      "refusing to append " +
        step.transitionId +
        ": its causal predecessor " +
        previousStep.transitionId +
        " is not in the ledger, so the link would name an event that does not exist",
    );
  }

  const parsed: unknown = JSON.parse(recorded.canonicalJson);
  const recordedId =
    typeof parsed === "object" && parsed !== null && "eventId" in parsed
      ? (parsed as { readonly eventId: unknown }).eventId
      : undefined;
  if (recordedId !== causationId) {
    throw new SupervisorError(
      "refusing to append " +
        step.transitionId +
        ": the row under its predecessor's coordinates is a different event," +
        " so the causal link would point at work this attempt did not do",
    );
  }
}

/** Beat: perform the intent's effect. Idempotent by content. */
export async function applyIntentEffect(context: BeatContext, step: PlanStep): Promise<void> {
  await context.effects.apply(operationForStep(context.invocation, step));
}

/**
 * Beat: close an open intent. Probe first, act only if needed, then append.
 *
 * The order is the point. The outcome is appended only after the effect is
 * known to have happened, because an append is a claim and a claim written
 * early cannot be retracted by a log that only grows.
 */
export async function closeIntent(context: BeatContext): Promise<BeatResult> {
  const operation = operationForStep(context.invocation, INTENT_STEP);

  let verdict: PostconditionVerdict = await context.effects.probe(operation);
  if (verdict === "NOT_DONE") {
    await context.effects.apply(operation);
    verdict = await context.effects.probe(operation);
  }

  if (verdict !== "DONE") {
    throw new PostconditionUnknownError(
      operation.operationId,
      "the effect's postcondition could not be established; the intent stays open",
    );
  }

  return appendPlanStep(context, OUTCOME_STEP);
}
