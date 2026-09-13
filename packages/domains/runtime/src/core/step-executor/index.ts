import type { ControlPlaneEvent, ResolvedRoute, TaskState } from "@acp/contracts";
import { canonicalJsonStringify } from "@acp/ledger";

import type {
  DurableInvocation,
  OperationCoordinate,
  PostconditionVerdict,
} from "../../contracts/index.js";
import type { CheckpointPort } from "../../checkpoint/index.js";
import { deriveEventCoordinate } from "../coordinates/index.js";

import { ATTEMPT_OPENING_STEP, buildEvent, causalPredecessorOf, operationForStep } from "../events/index.js";
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
  /**
   * Where this walk's checkpoint is persisted (V2-B1f/F3).
   *
   * **Optional, and the optionality is the refusal rather than a default.** A
   * construction that does not bind one is a construction whose terminal beat
   * cannot write a checkpoint, and the terminal therefore refuses instead of
   * appending a `CHECKPOINT_WRITTEN` with nothing behind it — which is exactly
   * what every walk did before this packet. The alternative, a required member,
   * would have forced every lifecycle-verb construction that never reaches a
   * terminal to invent one, and an invented port at that seam is the defect in
   * a different place.
   *
   * It is a port and not a source: assembling the checkpoint and storing it are
   * two different authorities, and this domain holds neither. The daemon and
   * the drill children compose the two and hand the result in.
   */
  readonly checkpoints?: CheckpointPort | undefined;
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
  //
  // Under a revision the task's first event is the attempt's opening (ADR
  // 0080), so that is what is rebuilt; it carries the revision record and the
  // invocation, so a resume under another revision or another invocation
  // refuses here. The opening carries no submission digest and no initiative,
  // so the discovery is rebuilt too once it exists: that is where a V2 walk
  // binds what was asked for, and a foreign submission resuming past it
  // refuses exactly as a V1 one does at step 0.
  const first = invocation.revision === undefined ? planStep(0) : ATTEMPT_OPENING_STEP;
  const rebuilt = buildEvent({ invocation, step: first, emittedBy, initiativeId, plan, route });
  if (recorded.canonicalJson !== canonicalJsonStringify(rebuilt)) {
    throw new SupervisorError(
      "refusing to resume: these coordinates were begun by a different" +
        " invocation, and continuing would finish one request's work under" +
        " another request's identity",
    );
  }
  if (invocation.revision === undefined) return;

  const discovery = buildEvent({ invocation, step: planStep(0), emittedBy, initiativeId, plan, route });
  const recordedDiscovery = ledger.getEventByIdempotencyKey(discovery.idempotencyKey);
  if (recordedDiscovery !== null && recordedDiscovery.canonicalJson !== canonicalJsonStringify(discovery)) {
    throw new SupervisorError(
      "refusing to resume: this attempt was discovered under a different" +
        " submission, and continuing would finish one request's work under" +
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
  // A revision-bearing walk opens its attempt before anything else, and then
  // discovers out of the state the opening left (P-18/protocolo G). Both are
  // read from ledger evidence like every other branch here: no task means no
  // opening yet, and `DISCOVERED` without the discovery under its own key
  // means the opening landed and the discovery did not. A V1 walk never enters
  // this block, so its navigation is exactly what it was.
  if (context.invocation.revision !== undefined) {
    if (current === null) return ATTEMPT_OPENING_STEP;
    const discovery = stepFrom(context.plan, null);
    if (current === discovery.toState) {
      const key = deriveEventCoordinate(
        context.invocation,
        discovery.transitionId,
        discovery.index,
      ).idempotencyKey;
      if (context.ledger.getEventByIdempotencyKey(key) === null) return discovery;
    }
  }

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

  if (step.eventType === ATTEMPT_OPENING_STEP.eventType) {
    assertOpeningProposal(context, event.idempotencyKey);
  } else if (context.invocation.revision !== undefined) {
    assertAttemptOpened(context);
  }

  assertCausalPredecessor(context, step, event.causationId);

  if (step.eventType === "CHECKPOINT_WRITTEN") {
    const persisted = persistCheckpoint(context, step);
    const result = context.ledger.append({
      ...event,
      payload: { ...event.payload, [CHECKPOINT_DIGEST_KEY]: persisted.digest },
    });
    return { event: result.inserted ? result.record.event : null, inserted: result.inserted };
  }

  const result = context.ledger.append(event);
  return { event: result.inserted ? result.record.event : null, inserted: result.inserted };
}

/**
 * The payload key the persisted checkpoint's digest travels under.
 *
 * A literal in this module, exactly as `initiativeId` and the recorded route
 * are literals in the event builder: a payload key is a fact about what an
 * event carries, not a contract shape, and `ControlPlaneEvent` already admits
 * the payload as a bounded record.
 */
const CHECKPOINT_DIGEST_KEY = "checkpointDigest";

/**
 * Persist the terminal's checkpoint, or refuse before anything is appended.
 *
 * **The whole point of the packet is in the order.** `CHECKPOINT_WRITTEN` was a
 * `PLAIN` beat like any other, so both plans appended it and nothing was ever
 * written: every completed walk, under either commit policy, recorded
 * "checkpointed" with nothing behind it. The persist happens here, before the
 * append, in the shape `assertCausalPredecessor` already establishes — an
 * append is a claim, and a log that only grows cannot retract one.
 *
 * Three cases and no fourth:
 *
 * - **no member** — this construction cannot write a checkpoint, so it refuses
 *   rather than appending an event whose whole meaning is that one exists;
 * - **the port refuses** — the refusal is reported verbatim and nothing is
 *   appended;
 * - **the port succeeds** — the store's own digest goes into the payload and
 *   the append follows.
 *
 * The refusal is a `SupervisorError`, which `classifyFailure` does not settle.
 * That is deliberate and is what makes "appends nothing" true of the whole
 * walk: a settled failure would append a settlement, and the ledger head would
 * move for a task that never reached its terminal.
 */
function persistCheckpoint(
  context: BeatContext,
  step: PlanStep,
): { readonly ok: true; readonly digest: string; readonly bytes: number } {
  const port = context.checkpoints;
  if (port === undefined) {
    throw new SupervisorError(
      "refusing to append " +
        step.transitionId +
        ": this walk has no checkpoint port, so the event would claim a" +
        " checkpoint no store holds",
    );
  }

  const persisted = port.persist(step);
  if (!persisted.ok) {
    throw new SupervisorError(
      "refusing to append " +
        step.transitionId +
        ": the checkpoint was not persisted (" +
        persisted.reason +
        " at " +
        persisted.at +
        "), so the event would name a digest the store does not hold",
    );
  }
  return persisted;
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

  const previousStep = causalPredecessorOf(context.invocation, context.plan, step);
  if (previousStep === null) {
    throw new LifecyclePlanError(
      "step " + step.transitionId + " states a causation but has no predecessor; the causal thread cannot be verified",
    );
  }

  // The predecessor's key is derived by the same function that keyed it, so a
  // V2 walk looks its predecessor up under the V2 key (N-G-8). Composing the V1
  // key here directly — as this guard did before G — would find nothing under
  // a revision and refuse every step after the first.
  const key = deriveEventCoordinate(context.invocation, previousStep.transitionId, previousStep.index).idempotencyKey;
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

/**
 * Refuse, before the append, an opening the ledger would assign differently
 * (P-18/protocolo G, ADR 0080).
 *
 * The producer proposes and the ledger verifies (ADR 0073): the door computes
 * `1 + MAX(attempt)` over the task and refuses a disagreeing proposal by name.
 * That refusal is correct and stays the authority. This check exists because
 * every later beat of the walk stamps `invocation.attempt`, so an opening that
 * proposed any other number would open an attempt the rest of the walk could
 * not inhabit; refusing here names the walk's mistake with zero delta instead
 * of leaving it to surface one event later.
 *
 * The value is read from the `LedgerPort` — `latestAttempt`, which is the
 * task's `MAX(attempt)`, or nothing for a task with no events — and never from
 * a counter of this module's or a clock. An opening already recorded under its
 * own key is a replay: the ledger compares its bytes, so the arithmetic, which
 * that opening itself has since moved, is not asked again.
 */
function assertOpeningProposal(context: BeatContext, openingKey: string): void {
  if (context.ledger.getEventByIdempotencyKey(openingKey) !== null) return;

  const task = context.ledger.getTask(context.invocation.taskId);
  const assigned = (task === null ? 0 : task.latestAttempt) + 1;
  if (assigned !== context.invocation.attempt) {
    throw new SupervisorError(
      "refusing to open this attempt: the ledger would assign it the flat attempt " +
        String(assigned) +
        " and this invocation runs under " +
        String(context.invocation.attempt) +
        "; every event of the walk repeats the flat attempt, so an opening under" +
        " any other number opens an attempt the walk cannot inhabit",
    );
  }
}

/**
 * Refuse any V2 beat whose attempt has not been opened (N-G-3).
 *
 * B's door is tolerant: a V2 event whose coordinate has no attempt row is
 * admitted, and O-2 of B's postaudit showed the consequence — a coordinate that
 * received events before its opening can never be opened at a flat attempt
 * that matches them. ADR 0073 left narrowing that to G, and G narrows it here,
 * in the producer, without touching the ledger: every step of a revision-bearing
 * walk other than the opening requires the opening to be in the ledger under
 * its V2 key, and to be this invocation's opening rather than an event that
 * merely sits there.
 */
function assertAttemptOpened(context: BeatContext): void {
  const opening = deriveEventCoordinate(
    context.invocation,
    ATTEMPT_OPENING_STEP.transitionId,
    ATTEMPT_OPENING_STEP.index,
  );
  const recorded = context.ledger.getEventByIdempotencyKey(opening.idempotencyKey);
  if (recorded === null) {
    throw new SupervisorError(
      "refusing to append: this attempt has not been opened, and nothing of a" +
        " coordinate may reach the ledger before its " +
        ATTEMPT_OPENING_STEP.transitionId,
    );
  }
  const parsed: unknown = JSON.parse(recorded.canonicalJson);
  const recordedId =
    typeof parsed === "object" && parsed !== null && "eventId" in parsed
      ? (parsed as { readonly eventId: unknown }).eventId
      : undefined;
  if (recordedId !== opening.eventId) {
    throw new SupervisorError(
      "refusing to append: the row under this attempt's opening is a different" +
        " event, so the attempt was opened by work this invocation did not do",
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
