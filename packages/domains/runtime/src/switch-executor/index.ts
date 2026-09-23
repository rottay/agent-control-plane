import { CONTRACT_VERSION, ControlPlaneEvent, PROVIDER_PRESSURES } from "@acp/contracts";
import type {
  ControlPlaneEvent as ParsedControlPlaneEvent,
  ControlPlaneEventType,
  Lease,
  SwitchAuthorization,
  TaskState,
} from "@acp/contracts";
import { foldPressureTrigger } from "@acp/accounts";
import type { PressureObservation, SwitchPlan, SwitchStep } from "@acp/accounts";

import type { DurableInvocation } from "../contracts/index.js";
import { deriveEventCoordinate, payloadCoordinate } from "../core/coordinates/index.js";
import { assertAttemptOpened } from "../core/step-executor/index.js";
import type { BeatContext, LedgerPort } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";
import type { SwitchEventPayload } from "./types/index.js";

export type { SwitchEventPayload } from "./types/index.js";

/** The two payload keys a candidate may never carry (ADR 0102). */
const COORDINATE_KEYS: readonly string[] = Object.freeze(["revisionNumber", "attemptNumber"]);

/**
 * The switch executor.
 *
 * `decideSwitch` returns a lawful plan as a value and never acts; this module
 * is the executor that plan has been waiting for. It takes the plan, appends
 * its events to the ledger in the order the module returned them, and holds no
 * state of its own — everything it needs beyond the plan it reads back out of
 * the ledger, which is what keeps the ledger the authority rather than this
 * module's memory.
 *
 * **The `LEASE_REVOKED` enrichment.** The switching module emits that event
 * with `{accountId}`, because an account policy is all it knows; the
 * enforcement plane emits the same name with
 * `{leaseId, worktreePath, holder, cause}`. P7B recorded the divergence as a
 * forward-carry rather than patching around it, and this is where it closes:
 * at `RELEASE_LEASE` time the executor holds the real lease, so it appends the
 * unified payload — the enforcement shape **plus** the module's own
 * `accountId`. Additive, so a `leaseId`-keyed fold now sees the revocation it
 * used to skip, and nothing that read `accountId` stops working.
 *
 * The envelope is this module's to supply, exactly as the switching module's
 * documentation says: coordinates from the durable invocation, instants fixed,
 * nothing minted from a clock or a random source.
 */

export interface SwitchExecutionInput {
  readonly ledger: LedgerPort;
  readonly invocation: DurableInvocation;
  readonly plan: SwitchPlan;
  readonly emittedBy: string;
  /**
   * The lease the packet actually holds, or null when it holds none.
   *
   * Required to be stated. A `SWITCH` plan releases a lease, so executing one
   * without saying which lease is being released is a gap the executor refuses
   * rather than fills: the whole point of the enrichment is that the revocation
   * names a real lease.
   */
  readonly lease: Lease | null;
  /**
   * The state the task is in when the plan is played.
   *
   * Read by the caller from the ledger and passed in, so this module makes one
   * decision — what to append — rather than two.
   */
  readonly taskState: TaskState;
  /**
   * The event that triggered this switch, when one genuinely exists.
   *
   * A switch is decided from routing state, not from a single event, so this
   * is often null and null is the honest answer. When a caller *does* know the
   * event that prompted it -- a quota-exhaustion recorded against another
   * task, say -- naming it here is what makes the resulting link a real
   * **cross-task** cause: the consumer draws an edge only when a causation
   * resolves to a different task's event, so this field is the one place in
   * the system that can produce one.
   */
  readonly causedBy?: string | null;
}

export interface SwitchExecutionResult {
  readonly appended: number;
  readonly events: readonly ParsedControlPlaneEvent[];
}

/**
 * Which events claim a step, and which merely record a decision (V2-B1f/F1).
 *
 * **Event and step names are deliberately not in correspondence**, and a guard
 * that assumed they were would refuse plans that are perfectly lawful today. Two
 * measured facts force the shape below: a `DRAIN` plan declares three steps and
 * emits one event, `QUOTA_WARNING`, which names none of them; and an `ESCALATE`
 * plan declares **zero** steps while emitting `AUTH_REQUIRED_RAISED`. A naive
 * "every event needs a step of the same name" rule refuses both.
 *
 * So each event type is classified exactly once, and an event type in neither
 * set is refused rather than played — a later addition to the vocabulary cannot
 * slip through unclassified.
 */

/**
 * Events that record a decision, not a claim that work was done.
 *
 * `ACCOUNT_SWITCH_STARTED` belongs here although it carries `toAccountId`, and
 * that is worth stating because it looks like the exception. The field records a
 * choice `rankAccounts` had **already made** when the plan was built; it is not
 * a claim that `SELECT_ACCOUNT` (step 6) was performed. A switch that has been
 * decided on has, by then, genuinely chosen an account.
 */
const STEP_INDEPENDENT_EVENTS: readonly string[] = Object.freeze([
  "QUOTA_WARNING",
  "AUTH_REQUIRED_RAISED",
  "ACCOUNT_SWITCH_STARTED",
]);

/** Events that claim a step, each mapping to exactly one declared step. */
const STEP_CLAIMING_EVENTS: Readonly<Record<string, SwitchStep>> = Object.freeze({
  TASK_STATE_CHANGED: "MARK_TASK_QUOTA_BLOCKED",
  LEASE_REVOKED: "RELEASE_LEASE",
  ACCOUNT_SWITCH_COMPLETED: "CONTINUE",
});

/**
 * The steps this executor may **claim**, and the word is exact.
 *
 * **This executor performs no step.** It appends events and does nothing else —
 * no account is drained here, no checkpoint written, no lease released. So the
 * question a guard can honestly ask is not "was the step performed" but "may a
 * record of this step be appended yet", and the answer is a prefix of the
 * declared eleven.
 *
 * Within steps 1-5, only two have a claiming event at all:
 *
 *   1 `MARK_ACCOUNT_DRAINING`      — no event; the plan's `accountStatus` is
 *                                    never appended here and the plan vocabulary
 *                                    has no account-state event. Where that
 *                                    transition gets recorded is F4/F5's question.
 *   2 `MARK_TASK_QUOTA_BLOCKED`    — `TASK_STATE_CHANGED`. Claimed.
 *   3 `FINISH_CURRENT_ATOMIC_STEP` — no event, no artifact. Nothing is claimed.
 *   4 `WRITE_CHECKPOINT`           — no event and no artifact; nothing calls
 *                                    `Checkpoint.parse` anywhere in `src`. F3
 *                                    produces one. Nothing is claimed.
 *   5 `RELEASE_LEASE`              — `LEASE_REVOKED`. Claimed.
 *
 * Steps 6-11 need a session that nothing opens yet, so a record claiming them
 * would be a record of work no code performs. **The prefix is data**, so the
 * packet that builds the session-opener widens one list rather than rewriting a
 * condition.
 */
const CLAIMABLE_STEPS: readonly SwitchStep[] = Object.freeze([
  "MARK_ACCOUNT_DRAINING",
  "MARK_TASK_QUOTA_BLOCKED",
  "FINISH_CURRENT_ATOMIC_STEP",
  "WRITE_CHECKPOINT",
  "RELEASE_LEASE",
]);

/**
 * Play a switch plan against the ledger.
 *
 * Every event is appended in plan order under a durable transition id derived
 * from its position, so replaying the same plan for the same invocation
 * appends nothing the second time.
 *
 * **Step-awareness (V2-B1f/F1).** The executor used to iterate `plan.events` and
 * never read `plan.steps` at all, so it would faithfully append a completion for
 * a switch that had not happened. It now checks, **before any append**, that each
 * event either is step-independent or claims a declared step inside the claimable
 * prefix. Every refusal throws `SupervisorError` ahead of the loop, exactly as the
 * three existing guards do, so a refused plan leaves the ledger untouched.
 */
export function executeSwitchPlan(input: SwitchExecutionInput): SwitchExecutionResult {
  const { ledger, invocation, plan, emittedBy, lease, taskState, causedBy } = input;

  const task = ledger.getTask(invocation.taskId);
  if (task === null) {
    throw new SupervisorError(
      "refusing to execute a switch plan for a task the ledger has never seen",
    );
  }

  // Nothing of a V2 coordinate before its opening (N-G-3, ADR 0102).
  if (invocation.revision !== undefined) assertAttemptOpened(ledger, invocation);

  // A candidate may not name the coordinate (ADR 0102). The two keys decide which
  // idempotency key an event must carry, and they come from the walk's revision
  // alone; a plan able to set them could key an event into another coordinate.
  // Present at all is refused — a value of any type, on a V1 walk as on a V2 one.
  for (const candidate of plan.events) {
    for (const key of COORDINATE_KEYS) {
      if (Object.hasOwn(candidate.payload, key)) {
        throw new SupervisorError(
          "refusing to execute a switch plan whose " +
            candidate.type +
            " names " +
            key +
            "; the payload coordinate is the walk's, never a plan's",
        );
      }
    }
  }

  // A plan that revokes a lease must be given the lease it revokes. Appending
  // the revocation without one would record an enrichment that names nothing,
  // which is worse than the unenriched payload it replaces.
  const revokes = plan.events.some((candidate) => candidate.type === "LEASE_REVOKED");
  if (revokes && lease === null) {
    throw new SupervisorError(
      "refusing to execute a switch plan that revokes a lease without the lease" +
        " it revokes; the revocation would name no worktree and no holder",
    );
  }

  const changes = plan.events.filter((candidate) => candidate.type === "TASK_STATE_CHANGED");
  if (changes.length > 0 && plan.taskState === null) {
    throw new SupervisorError(
      "refusing to execute a switch plan whose events change the task state" +
        " while the plan names no state to change it to",
    );
  }

  // --- V2-B1f/F1: the executor reads the steps, not only the events. -------
  //
  // All three refusals sit here, ahead of the append loop, for the same reason
  // the three guards above do: a plan that is going to be refused must leave
  // the ledger exactly as it found it. A guard that fired mid-loop would have
  // already recorded part of a switch it then declared unlawful.

  // Refusal 1: the completion, by name.
  //
  // Redundant under refusal 3 -- `ACCOUNT_SWITCH_COMPLETED` maps to `CONTINUE`,
  // step 11, which is outside the claimable prefix -- and kept deliberately
  // anyway. The defect this packet removes was a fabricated completion, and a
  // refusal that names it makes the defect unrepeatable by name rather than
  // only by arithmetic. If the prefix ever widens far enough to admit
  // `CONTINUE`, this guard is what still stands in the way, and whoever widens
  // it has to delete this line on purpose.
  if (plan.events.some((candidate) => candidate.type === "ACCOUNT_SWITCH_COMPLETED")) {
    throw new SupervisorError(
      "refusing to execute a switch plan that appends ACCOUNT_SWITCH_COMPLETED;" +
        " only the session-opener may append it, once the switch it names has happened",
    );
  }

  for (const candidate of plan.events) {
    if (STEP_INDEPENDENT_EVENTS.includes(candidate.type)) continue;

    const claimed = STEP_CLAIMING_EVENTS[candidate.type];

    // Refusal 2a: an event the table does not classify.
    //
    // Fail-closed on the vocabulary rather than on a list of the forbidden: a
    // type added to the contracts enum and emitted by a later planner reaches
    // this line unclassified, and is refused until somebody decides which of
    // the two sets it belongs to.
    if (claimed === undefined) {
      throw new SupervisorError(
        "refusing to execute a switch plan carrying an event this executor cannot" +
          " classify as step-independent or step-claiming: " +
          candidate.type,
      );
    }

    // Refusal 2b: a claim about a step the plan never declared.
    if (!plan.steps.includes(claimed)) {
      throw new SupervisorError(
        "refusing to execute a switch plan whose " +
          candidate.type +
          " claims the step " +
          claimed +
          ", which the plan does not declare",
      );
    }

    // Refusal 3: a claim about a step nothing performs yet.
    if (!CLAIMABLE_STEPS.includes(claimed)) {
      throw new SupervisorError(
        "refusing to execute a switch plan whose " +
          candidate.type +
          " claims the step " +
          claimed +
          ", which lies beyond what this executor may record",
      );
    }
  }

  const appended: ParsedControlPlaneEvent[] = [];
  let inserted = 0;

  // The state walks with the plan. Every account-side fact is a same-state
  // passthrough, but the plan's own `TASK_STATE_CHANGED` is a real transition
  // -- the contract refuses a state-change event that changes nothing -- so
  // the events after it are passthroughs at the NEW state, exactly as the P7B
  // pilot drilled the chain by hand.
  let state: TaskState = taskState;

  for (const [index, candidate] of plan.events.entries()) {
    const transitionId = "switch." + String(index) + "." + candidate.type.toLowerCase();
    const coordinate = deriveEventCoordinate(invocation, transitionId, index);

    const fromState = state;
    const toState =
      candidate.type === "TASK_STATE_CHANGED" && plan.taskState !== null
        ? plan.taskState
        : state;

    const event = ControlPlaneEvent.parse({
      contractVersion: CONTRACT_VERSION,
      eventId: coordinate.eventId,
      taskId: invocation.taskId,
      attempt: invocation.attempt,
      transitionId,
      idempotencyKey: coordinate.idempotencyKey,
      type: candidate.type,
      fromState,
      toState,
      emittedBy,
      occurredAt: coordinate.occurredAt,
      recordedAt: coordinate.recordedAt,
      correlationId: invocation.invocationId,
      causationId: causedBy ?? null,
      payload: payloadFor(candidate.type, candidate.payload, lease, invocation),
    });

    const result = ledger.append(event);
    if (result.inserted) inserted += 1;
    appended.push(result.record.event);
    state = toState;
  }

  return { appended: inserted, events: appended };
}

/**
 * The payload to append for one candidate.
 *
 * Verbatim for every type but one. `LEASE_REVOKED` is enriched with the lease
 * the packet holds, which is the P7B forward-carry closing: the module's
 * `accountId` is kept, and the enforcement plane's four fields are added
 * beside it, so one event now satisfies both readers.
 */
function payloadFor(
  type: ControlPlaneEventType,
  payload: Readonly<Record<string, string>>,
  lease: Lease | null,
  invocation: DurableInvocation,
): SwitchEventPayload {
  // Last, after the plan's fields: the candidate was refused above if it named
  // either key, so nothing here is overwritten, and a V1 walk adds nothing.
  if (type !== "LEASE_REVOKED" || lease === null) return { ...payload, ...payloadCoordinate(invocation) };

  return {
    ...payload,
    leaseId: lease.leaseId,
    worktreePath: lease.worktreePath,
    holder: lease.holder,
    cause: "ACCOUNT_SWITCH",
    ...payloadCoordinate(invocation),
  };
}

// ---------------------------------------------------------------------------
// V2-B1f/F4d — the walk plays a switch it did not decide
// ---------------------------------------------------------------------------

/**
 * Why a walk did not play a switch.
 *
 * Closed and ordered: `considerSwitch` refuses at the **first** failure and
 * names it, so an operator reading a declined switch learns which condition
 * was not met rather than that something was not met.
 *
 * Every member is a refusal to act on an authorization, never a judgement
 * about routing. The walk holds no accounts file, no policy document and no
 * `RoutingRequest`; it compares what it was admitted against what it recorded,
 * and stops.
 */
export const SWITCH_DECLINE_REASONS = [
  "NO_AUTHORIZATION",
  "NO_PRESSURE",
  "TRIGGER_MISMATCH",
  "ACCOUNT_MISMATCH",
  "NO_DESTINATION",
  "DESTINATION_UNBOUND",
  "DESTINATION_UNLANDABLE",
] as const;

export type SwitchDeclineReason = (typeof SWITCH_DECLINE_REASONS)[number];

export type SwitchConsideration =
  | { readonly kind: "SWITCHED"; readonly startedEventId: string }
  | { readonly kind: "NOT_SWITCHED"; readonly reason: SwitchDeclineReason };

/**
 * The seam the supervisor asks before it settles a classified failure.
 *
 * A closure, not data, and the difference is the whole of the design. The
 * authorization is a value an operator wrote and the door admitted, so it
 * travels with the route and the bindings. The **lease** is a live grant this
 * process holds and renews; serializing it would let a second holder claim the
 * grant, which is exactly the shape the fence refuses. Only a closure can
 * carry both, and it is the idiom this plane already uses three times.
 */
export interface SwitchPort {
  consider(context: BeatContext): Promise<SwitchConsideration>;
}

/**
 * The ledger surface `considerSwitch` needs to read this attempt's pressure.
 *
 * Structural, and **not** `LedgerPort`: that port is `append`, `getTask`,
 * `getEventBySequence` and `getEventByIdempotencyKey` — it does not list, and
 * widening it would put a read the step executor never makes into the
 * executor's own port. The real `Ledger` satisfies this shape, and a fake can
 * drive the paging without appending a hundred thousand rows.
 */
export interface SwitchPressureSource {
  listEvents(query: {
    readonly taskId?: string | undefined;
    readonly type?: ControlPlaneEventType | undefined;
    readonly afterSequence?: number | undefined;
    readonly limit?: number | undefined;
  }): {
    readonly events: readonly { readonly sequence: number; readonly event: ParsedControlPlaneEvent }[];
    readonly nextCursor: number | null;
    readonly hasMore: boolean;
  };
}

/** One binding the walk was admitted with, as the destination check reads it. */
export interface SwitchDestination {
  readonly accountId: string;
  readonly provider: string;
}

export interface SwitchConsiderationInput {
  /** The authorization the door admitted, or nothing at all. */
  readonly authorization: SwitchAuthorization | undefined;
  /** The lease this process holds. Never constructed here, never serialized. */
  readonly lease: Lease;
  /** The account and provider the route names. */
  readonly routeAccountId: string;
  readonly routeProvider: string;
  /** The bindings the config admitted, each carrying its own provider (F2b). */
  readonly destinations: readonly SwitchDestination[];
  /** The ledger, as a listing surface. */
  readonly source: SwitchPressureSource;
}

/** The ledger's own page ceiling, restated where the pager needs it. */
const SWITCH_PRESSURE_PAGE_LIMIT = 1_000;

/**
 * The pressure rows this attempt recorded, as the fold reads them.
 *
 * **This attempt's own**, and the filter is four-fold rather than one: the
 * task, the attempt, a transition id the pressure recorder minted, and a
 * payload carrying a member of the observation vocabulary. The last is load
 * bearing — a played plan appends its own `QUOTA_WARNING` row with payload
 * `{accountId}` and no `pressure` key, and reading one of those back would let
 * a switch justify the next switch.
 *
 * `readAccountPressure` is deliberately not reused: its `since` is strictly
 * exclusive and every row of this walk carries `occurredAt = submittedAt`, so
 * it would exclude exactly the rows this decision is about.
 */
function observedPressure(
  source: SwitchPressureSource,
  invocation: DurableInvocation,
): readonly PressureObservation[] {
  const kept: PressureObservation[] = [];
  let afterSequence = 0;

  for (;;) {
    const page = source.listEvents({
      taskId: invocation.taskId,
      type: "QUOTA_WARNING",
      afterSequence,
      limit: SWITCH_PRESSURE_PAGE_LIMIT,
    });

    for (const record of page.events) {
      const event = record.event;
      if (event.attempt !== invocation.attempt) continue;
      if (!event.transitionId.startsWith("pressure.")) continue;

      const payload: unknown = event.payload;
      if (typeof payload !== "object" || payload === null) continue;
      const fields = payload as Record<string, unknown>;

      const accountId = fields["accountId"];
      const provider = fields["provider"];
      const pressure = fields["pressure"];
      if (typeof accountId !== "string" || accountId === "") continue;
      if (typeof provider !== "string" || provider === "") continue;
      if (typeof pressure !== "string") continue;
      if (!(PROVIDER_PRESSURES as readonly string[]).includes(pressure)) continue;

      kept.push({
        accountId,
        provider,
        pressure: pressure as PressureObservation["pressure"],
        occurredAt: event.occurredAt,
        sequence: record.sequence,
        eventId: event.eventId,
      });
    }

    if (!page.hasMore || page.nextCursor === null) break;
    afterSequence = page.nextCursor;
  }

  return kept;
}

/**
 * Decide whether this walk plays the switch it was admitted, and play it.
 *
 * **It decides nothing about routing.** Everything it compares was decided
 * elsewhere: the elector produced the plan, the door admitted it, the recorder
 * wrote the pressure. What this function does is refuse to play an
 * authorization that does not match what actually happened — and then hand the
 * plan, verbatim, to the executor that has been waiting for a caller since it
 * was written.
 *
 * Refusals are ordered from the cheapest to the most specific, and each is the
 * first thing that was not true:
 *
 * • `NO_AUTHORIZATION` — nothing was admitted. The ordinary case.
 * • `NO_PRESSURE` — this attempt recorded nothing a trigger can be folded from.
 * • `TRIGGER_MISMATCH` — the trigger the elector decided for is not the one
 *   this attempt actually observed. **The walk does not re-decide**; it declines.
 * • `ACCOUNT_MISMATCH` — the authorization was decided against another account
 *   than the one this route names, which means the route was re-elected after
 *   the decision was taken.
 * • `NO_DESTINATION` — a `SWITCH` plan naming no account to switch to. The walk
 *   may not fill it in from the bindings: choosing is routing.
 * • `DESTINATION_UNBOUND` — the named account has no admitted binding, so the
 *   switch could never be landed by anyone.
 * • `DESTINATION_UNLANDABLE` — the destination binding declares a different
 *   provider than the route. Such a switch is playable and **never landable**:
 *   the session that would land it is refused before any spawn, one switch per
 *   attempt is structural, and no plan step leaves the blocked state. Starting
 *   a switch known not to finish would park the attempt with cancellation as
 *   the only exit. A temporary refusal, inherited from the provider-framing
 *   decision, and lifted by the packet that lifts it.
 */
export function considerSwitch(
  context: BeatContext,
  input: SwitchConsiderationInput,
): SwitchConsideration {
  const { authorization, lease, routeAccountId, routeProvider, destinations, source } = input;

  if (authorization === undefined) return decline("NO_AUTHORIZATION");

  // This attempt's own rows, folded by the ONE fold that classifies a trigger.
  // A second fold here would be a second vocabulary, and two drift.
  const observed = observedPressure(source, context.invocation);
  const folded = foldPressureTrigger(observed);
  if (!folded.ok) return decline("NO_PRESSURE");
  if (folded.trigger !== authorization.trigger) return decline("TRIGGER_MISMATCH");

  if (authorization.decidedForAccountId !== routeAccountId) return decline("ACCOUNT_MISMATCH");

  const plan = authorization.plan;
  if (plan.kind === "SWITCH") {
    const destinationId = plan.selectedAccountId;
    if (destinationId === null) return decline("NO_DESTINATION");
    const destination = destinations.find((entry) => entry.accountId === destinationId);
    if (destination === undefined) return decline("DESTINATION_UNBOUND");
    if (destination.provider !== routeProvider) return decline("DESTINATION_UNLANDABLE");
  }

  const task = context.ledger.getTask(context.invocation.taskId);
  if (task === null) {
    throw new SupervisorError(
      "refusing to play a switch for a task the ledger has never seen",
    );
  }

  // The plan, verbatim. Nothing here builds, repairs, completes or reorders it,
  // and `causedBy` is the audit link the elector recorded — the cross-task
  // cause that field was designed for, not the row that satisfied the match.
  const played = executeSwitchPlan({
    ledger: context.ledger,
    invocation: context.invocation,
    plan: {
      kind: plan.kind,
      accountStatus: plan.accountStatus,
      taskState: plan.taskState,
      steps: [...plan.steps],
      selectedAccountId: plan.selectedAccountId,
      events: plan.events.map((candidate) => ({
        type: candidate.type,
        payload: { ...candidate.payload },
      })),
    },
    emittedBy: context.emittedBy,
    lease,
    taskState: task.currentState,
    causedBy: authorization.decidedFromEventId,
  });

  const started = played.events.find((event) => event.type === "ACCOUNT_SWITCH_STARTED");
  if (started === undefined) {
    throw new SupervisorError(
      "refusing to report a switch that appended no ACCOUNT_SWITCH_STARTED row;" +
        " the destination authority a landing reads would not exist",
    );
  }
  return { kind: "SWITCHED", startedEventId: started.eventId };
}

function decline(reason: SwitchDeclineReason): SwitchConsideration {
  return { kind: "NOT_SWITCHED", reason };
}
