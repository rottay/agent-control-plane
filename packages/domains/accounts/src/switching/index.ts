/**
 * P5D: the switching policy.
 *
 * The account-switch decision core, in shadow mode. It is handed a classified
 * trigger and the routing request the caller would have used anyway, and it
 * returns a **value**: an ordered switch plan, a drain recommendation, an
 * escalation to the owner, or a classified refusal. It never acts. Nothing
 * here starts a provider session, authenticates, signals a process, spawns
 * anything, writes a file or appends to a ledger.
 *
 * **One quota authority, one selection authority.** The quota outcomes this
 * module reads are the very ones the routing request already carries, and the
 * account it names is the one `rankAccounts` chose. Neither judgement is
 * re-made here; both are composed.
 *
 * **No clock.** This module never stamps an instant. The only instant in play
 * is `routing.now`, which the router already validates against the one grammar
 * this package admits — so there is no second instant to disagree with it and
 * no third grammar to drift from it.
 *
 * **The plan is names, not calls.** Every step is a named value for a later
 * executor to carry out. `READ_ONLY_HEALTH_PROBE` is the name of a step, not a
 * probe this module performs.
 */

import type { AccountRecord, ControlPlaneEventType, PROVIDER_PRESSURES } from "@acp/contracts";

import type { RoutingOutcome, RoutingRequest } from "../routing/index.js";
import { rankAccounts } from "../routing/index.js";

// ---------------------------------------------------------------------------
// The classified trigger
// ---------------------------------------------------------------------------

/**
 * The only triggers that may be read as quota pressure.
 *
 * A closed set, declared here. Anything outside it — a provider's raw error
 * string, a transport failure, a timeout — is not quota and never produces a
 * switch. That is the fail-closed taxonomy: an unknown error changes nothing.
 */
export type SwitchTrigger = "QUOTA_WARNING" | "QUOTA_EXHAUSTED";

/**
 * The trigger vocabulary, **most severe first**.
 *
 * The order is a law of this module, not an accident of the alphabet. An
 * exhaustion outranks a warning: an account that has been refused outright
 * must not be read as merely under pressure because a warning was recorded
 * later. `foldPressureTrigger` walks this array in order and returns the first
 * member it can prove, so a third member added in the wrong position would
 * change what a fold decides — which is why a test pins the exact list in
 * order rather than by membership.
 *
 * The architecture fence compares this set against the observation vocabulary
 * in `@acp/contracts` in both directions, but it compares it **as a set**: the
 * two genuinely are sets, and the ordering above is this module's own claim
 * about severity, enforced here and by that test.
 */
export const SWITCH_TRIGGERS: readonly SwitchTrigger[] = Object.freeze([
  "QUOTA_EXHAUSTED",
  "QUOTA_WARNING",
]);

function isTrigger(value: unknown): value is SwitchTrigger {
  return typeof value === "string" && (SWITCH_TRIGGERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The fold: recorded pressure into a classified trigger
// ---------------------------------------------------------------------------

/**
 * One pressure row, as the ledger recorded it and a reader hands it over.
 *
 * Declared here rather than in the module that reads the ledger, for one
 * mechanical reason: the fold's whole job is to decide whether an observation
 * is a trigger, and `isTrigger` above is module-private. Placing the fold
 * beside it lets the predicate be used directly, so the observation and
 * decision vocabularies cannot drift. A fold anywhere else would need the
 * predicate exported — putting the fail-closed boundary on the public surface
 * where a caller could route around it.
 *
 * `provider` is a bounded string and deliberately **not** the CLI union: API
 * and local walks record pressure too, under the opaque provider segment their
 * route carries.
 */
export interface PressureObservation {
  readonly accountId: string;
  readonly provider: string;
  readonly pressure: (typeof PROVIDER_PRESSURES)[number];
  readonly occurredAt: string;
  /** The ledger's own monotone position: the only ordering it guarantees. */
  readonly sequence: number;
  /** The row's own event id, so a decision can name what caused it. */
  readonly eventId: string;
}

/** Why no trigger could be classified. Each names the input that decided it. */
export const PRESSURE_TRIGGER_REFUSALS = ["NO_PRESSURE_RECORDED", "NO_TRIGGER_CLASSIFIED"] as const;

export type PressureTriggerRefusal = (typeof PRESSURE_TRIGGER_REFUSALS)[number];

/**
 * What was observed, whatever was decided.
 *
 * Returned on **both** arms, because the only pressure the plane can currently
 * observe in production is an authentication requirement, which is never a
 * trigger — and a refusal that said only "nothing classified" would hide the
 * one thing the operator needs to see. The members counted are the contract's
 * own vocabulary and the ids are the ledger's; this shape introduces no
 * vocabulary of its own.
 */
export interface PressureSummary {
  /** One count per observed member. A member with no rows is absent. */
  readonly counts: Readonly<Record<string, number>>;
  readonly latestEventId: string | null;
  readonly latestOccurredAt: string | null;
}

export type PressureTriggerOutcome =
  | {
      readonly ok: true;
      readonly trigger: SwitchTrigger;
      /** The deciding row's own event id: what a later packet links a switch to. */
      readonly causedBy: string;
      readonly observed: PressureSummary;
    }
  | {
      readonly ok: false;
      readonly reason: PressureTriggerRefusal;
      readonly at: string;
      readonly observed: PressureSummary;
    };

function summarize(observations: readonly PressureObservation[]): PressureSummary {
  const counts: Record<string, number> = {};
  let latest: PressureObservation | null = null;
  for (const observation of observations) {
    counts[observation.pressure] = (counts[observation.pressure] ?? 0) + 1;
    // The ledger's sequence, never the instant: rows carry the walk's own
    // submission time, so ties are ordinary and an instant cannot order them.
    if (latest === null || observation.sequence > latest.sequence) latest = observation;
  }
  return Object.freeze({
    counts: Object.freeze(counts),
    latestEventId: latest === null ? null : latest.eventId,
    latestOccurredAt: latest === null ? null : latest.occurredAt,
  });
}

/**
 * Fold recorded pressure into the one trigger a decision may be made on.
 *
 * **Severity outranks recency.** The fold walks `SWITCH_TRIGGERS` in its
 * declared order — most severe first — and returns the first member some
 * observation proves under `isTrigger`. An exhaustion therefore decides even
 * when a warning was recorded after it, and the row named as the cause is the
 * latest observation *of the deciding member*, by ledger sequence.
 *
 * **An authentication requirement is never a trigger**, and that is not a gap:
 * `decideSwitch` reaches its escalation branch from the folded account state,
 * never from the trigger. A transient or an unclassified utterance is likewise
 * refused rather than read as quota — the fail-closed direction, since an
 * unread transient costs nothing and a transient read as quota costs an
 * account. Every such refusal names the member it saw.
 *
 * **An empty set is a success-shaped fact**, not a failure: it means this
 * account recorded no pressure in the window, which is exactly what a reader
 * needs to know. A read failure is never coerced into it.
 *
 * Pure, frozen, no clock, no random source, no I/O.
 */
export function foldPressureTrigger(
  observations: readonly PressureObservation[],
): PressureTriggerOutcome {
  const observed = summarize(observations);
  if (observations.length === 0) {
    return Object.freeze({
      ok: false as const,
      reason: "NO_PRESSURE_RECORDED" as const,
      at: "observations",
      observed,
    });
  }

  for (const candidate of SWITCH_TRIGGERS) {
    let deciding: PressureObservation | null = null;
    for (const observation of observations) {
      if (!isTrigger(observation.pressure) || observation.pressure !== candidate) continue;
      if (deciding === null || observation.sequence > deciding.sequence) deciding = observation;
    }
    if (deciding !== null) {
      return Object.freeze({
        ok: true as const,
        trigger: candidate,
        causedBy: deciding.eventId,
        observed,
      });
    }
  }

  // Nothing here is a trigger. Name the member of the latest row so the
  // refusal says what was seen rather than only that nothing classified.
  let latest: PressureObservation | null = null;
  for (const observation of observations) {
    if (isTrigger(observation.pressure)) continue;
    if (latest === null || observation.sequence > latest.sequence) latest = observation;
  }
  return Object.freeze({
    ok: false as const,
    reason: "NO_TRIGGER_CLASSIFIED" as const,
    at: latest === null ? "observations" : latest.pressure,
    observed,
  });
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Why no recommendation could be made. Every one names the input that decided it. */
export type SwitchRefusal =
  | "REQUEST_INVALID"
  | "TRIGGER_UNCLASSIFIED"
  | "CURRENT_ACCOUNT_UNKNOWN"
  | "QUOTA_OUTCOME_MISSING"
  | "NO_ELIGIBLE_ACCOUNT";

export const SWITCH_REFUSALS: readonly SwitchRefusal[] = Object.freeze([
  "CURRENT_ACCOUNT_UNKNOWN",
  "NO_ELIGIBLE_ACCOUNT",
  "QUOTA_OUTCOME_MISSING",
  "REQUEST_INVALID",
  "TRIGGER_UNCLASSIFIED",
]);

export interface SwitchRefused {
  readonly ok: false;
  readonly reason: SwitchRefusal;
  /** The input that decided it. A path, never a value. */
  readonly at: string;
}

function refuse(reason: SwitchRefusal, at: string): SwitchRefused {
  return Object.freeze({ ok: false as const, reason, at });
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * The lawful switch sequence, in order, each step a name for an executor.
 *
 * The roadmap states this sequence; this module states it once, as data, so a
 * plan cannot silently omit a step. A plan is always a prefix-free selection
 * from this list in this order — never a reordering, never an invention.
 */
export type SwitchStep =
  | "MARK_ACCOUNT_DRAINING"
  | "MARK_TASK_QUOTA_BLOCKED"
  | "FINISH_CURRENT_ATOMIC_STEP"
  | "WRITE_CHECKPOINT"
  | "RELEASE_LEASE"
  | "SELECT_ACCOUNT"
  | "READ_ONLY_HEALTH_PROBE"
  | "OPEN_FRESH_SESSION"
  | "REVALIDATE_AUTHORITY_AND_PRESTATE"
  | "REHYDRATE_CHECKPOINT"
  | "CONTINUE";

export const SWITCH_STEPS: readonly SwitchStep[] = Object.freeze([
  "MARK_ACCOUNT_DRAINING",
  "MARK_TASK_QUOTA_BLOCKED",
  "FINISH_CURRENT_ATOMIC_STEP",
  "WRITE_CHECKPOINT",
  "RELEASE_LEASE",
  "SELECT_ACCOUNT",
  "READ_ONLY_HEALTH_PROBE",
  "OPEN_FRESH_SESSION",
  "REVALIDATE_AUTHORITY_AND_PRESTATE",
  "REHYDRATE_CHECKPOINT",
  "CONTINUE",
]);

/**
 * A candidate event, as a value.
 *
 * The `type` is a `ControlPlaneEventType` — the frozen contracts vocabulary,
 * used as-is. A switching outcome that could not be expressed under that
 * vocabulary would be a STOP, not a new event type.
 *
 * The envelope is deliberately absent. A `ControlPlaneEvent` carries an
 * `eventId`, an `occurredAt` and a `recordedAt`; minting those needs a random
 * source and a clock, and this module is forbidden both. The executor that
 * appends supplies the envelope — this module supplies only what it is
 * competent to say: which event should be recorded, and about what.
 */
export interface SwitchEvent {
  readonly type: ControlPlaneEventType;
  /** Bounded, string-valued, and never a transcript or a credential. */
  readonly payload: Readonly<Record<string, string>>;
}

/** What the control plane should do with the account and the task. */
export type SwitchAccountStatus = "DRAINING" | "EXHAUSTED" | "COOLDOWN" | "AUTH_REQUIRED";

export interface SwitchPlan {
  /** `DRAIN` holds the task on this account; `SWITCH` moves it; `ESCALATE` stops. */
  readonly kind: "DRAIN" | "SWITCH" | "ESCALATE";
  /** The account transition to record, from `AccountStatus`. */
  readonly accountStatus: SwitchAccountStatus;
  /** The task transition to record, from the contracts' exceptional states. */
  readonly taskState: "QUOTA_BLOCKED" | "AUTH_REQUIRED" | null;
  /** The lawful steps, in order, none skipped silently. */
  readonly steps: readonly SwitchStep[];
  /** The account the router chose, or `null` when no selection was made. */
  readonly selectedAccountId: string | null;
  /** The candidate events, as values. */
  readonly events: readonly SwitchEvent[];
}

export type SwitchOutcome = { readonly ok: true; readonly plan: SwitchPlan } | SwitchRefused;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface SwitchRequest {
  /**
   * The trigger as the caller observed it — deliberately unclassified.
   *
   * Typed as a bare string because classification is this module's first job.
   * Declaring it `SwitchTrigger` would make the fail-closed law untestable
   * from TypeScript and would let a raw provider string in through a cast.
   */
  readonly trigger: string;
  /** The account the task is running on now. */
  readonly currentAccountId: string;
  /**
   * The routing request the caller would use anyway.
   *
   * It already carries the records, the quota outcomes and the instant, so
   * this module introduces no second copy of any of them and no second clock.
   */
  readonly routing: RoutingRequest;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function event(type: ControlPlaneEventType, payload: Record<string, string>): SwitchEvent {
  return Object.freeze({ type, payload: Object.freeze({ ...payload }) });
}

/**
 * Decide whether to drain, switch, escalate, or do nothing.
 *
 * Pure and deterministic: the same request yields the same value, the output is
 * frozen at every level, and nothing is read that was not passed in.
 */
export function decideSwitch(request: SwitchRequest): SwitchOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) {
    return refuse("REQUEST_INVALID", "request");
  }
  const fields = raw as Record<string, unknown>;
  const currentAccountId: unknown = fields["currentAccountId"];
  if (typeof currentAccountId !== "string" || currentAccountId === "") {
    return refuse("REQUEST_INVALID", "request.currentAccountId");
  }
  const routing: unknown = fields["routing"];
  if (typeof routing !== "object" || routing === null) {
    return refuse("REQUEST_INVALID", "request.routing");
  }
  // The routing request is caller-authored too, and this module reads its
  // collections before the router ever sees them. Narrowing `Array.isArray`
  // over the declared arrays would retype their elements as `any`, so the
  // guards run against `unknown` aliases — the same idiom the router uses.
  const routingFields = routing as Record<string, unknown>;
  const rawRecords: unknown = routingFields["records"];
  if (!Array.isArray(rawRecords)) {
    return refuse("REQUEST_INVALID", "request.routing.records");
  }
  const rawEstimates: unknown = routingFields["estimates"];
  if (!Array.isArray(rawEstimates)) {
    return refuse("REQUEST_INVALID", "request.routing.estimates");
  }
  // `evidence` is guarded here because this module now filters it: excluding
  // the drained account touches all three collections before the router sees
  // any of them, and a filter presupposes an array. Without this the exclusion
  // itself would be the crash site.
  const rawEvidence: unknown = routingFields["evidence"];
  if (!Array.isArray(rawEvidence)) {
    return refuse("REQUEST_INVALID", "request.routing.evidence");
  }

  // Fail-closed, before anything else is read: an unclassified trigger is not
  // quota pressure, and a module that guessed here would switch accounts on a
  // transport hiccup.
  if (!isTrigger(fields["trigger"])) {
    return refuse("TRIGGER_UNCLASSIFIED", "request.trigger");
  }
  const trigger: SwitchTrigger = fields["trigger"];

  const records: readonly AccountRecord[] = request.routing.records;
  const current = records.find((record) => record.accountId === currentAccountId);
  if (current === undefined) {
    return refuse("CURRENT_ACCOUNT_UNKNOWN", "request.currentAccountId");
  }

  // The credential path is the owner's, never this module's. An account that
  // needs a human at an OAuth prompt, a 2FA code or a CAPTCHA is escalated as
  // it stands; no switch is recommended around it and no credential is touched.
  if (current.status === "AUTH_REQUIRED") {
    return Object.freeze({
      ok: true as const,
      plan: Object.freeze({
        kind: "ESCALATE" as const,
        accountStatus: "AUTH_REQUIRED" as const,
        taskState: "AUTH_REQUIRED" as const,
        steps: Object.freeze([] as readonly SwitchStep[]),
        selectedAccountId: null,
        events: Object.freeze([
          event("AUTH_REQUIRED_RAISED", { accountId: currentAccountId }),
        ]),
      }),
    });
  }

  // One quota authority: the outcome the routing request already carries for
  // this account. A missing one is refused rather than assumed, because
  // "we did not measure it" and "it is fine" are different claims.
  const wrapper = request.routing.estimates.find((entry) => entry.accountId === currentAccountId);
  if (wrapper === undefined) {
    return refuse("QUOTA_OUTCOME_MISSING", "request.routing.estimates");
  }

  // A warning drains; it does not move the task. The account stops taking new
  // work while the packet in flight finishes on it.
  if (trigger === "QUOTA_WARNING") {
    return Object.freeze({
      ok: true as const,
      plan: Object.freeze({
        kind: "DRAIN" as const,
        accountStatus: "DRAINING" as const,
        taskState: null,
        steps: Object.freeze<readonly SwitchStep[]>([
          "MARK_ACCOUNT_DRAINING",
          "FINISH_CURRENT_ATOMIC_STEP",
          "WRITE_CHECKPOINT",
        ]),
        selectedAccountId: null,
        events: Object.freeze([
          event("QUOTA_WARNING", { accountId: currentAccountId }),
        ]),
      }),
    });
  }

  // Exhaustion moves the task **off** this account, so the account being
  // drained is not a candidate for receiving it. Filtering it out of the
  // request is what makes that true; ranking the caller's request unchanged
  // would happily recommend switching an exhausted account to itself, and the
  // router cannot know better because nothing in a routing request says which
  // account the task is already on.
  //
  // The same key is removed from all three collections, so the router's own
  // laws — one estimate per record, one evidence row per record, no orphans —
  // hold over the derived request exactly as they would over a request the
  // caller had built without this account in the first place.
  const candidates: RoutingRequest = {
    ...request.routing,
    records: request.routing.records.filter((r) => r.accountId !== currentAccountId),
    estimates: request.routing.estimates.filter((e) => e.accountId !== currentAccountId),
    evidence: request.routing.evidence.filter((e) => e.accountId !== currentAccountId),
  };

  // Selection is the router's judgement, not this module's: it is called once,
  // and its refusal — including the only-current case, where nothing is left to
  // rank — is carried through rather than second-guessed.
  const selection: RoutingOutcome = rankAccounts(candidates);
  if (!selection.ok) {
    return refuse("NO_ELIGIBLE_ACCOUNT", "request.routing");
  }
  const chosen = selection.recommendation.ranked[0];
  if (chosen === undefined) {
    return refuse("NO_ELIGIBLE_ACCOUNT", "request.routing");
  }

  // `EXHAUSTED` or `COOLDOWN` as the estimator says, not as this module
  // guesses: an account whose reset is still ahead of it will recover on its
  // own, which is what COOLDOWN means; one with no reset in sight is EXHAUSTED.
  const recovers = wrapper.outcome.ok && wrapper.outcome.estimate.reset.millisUntilReset > 0;
  const accountStatus: SwitchAccountStatus = recovers ? "COOLDOWN" : "EXHAUSTED";

  return Object.freeze({
    ok: true as const,
    plan: Object.freeze({
      kind: "SWITCH" as const,
      accountStatus,
      taskState: "QUOTA_BLOCKED" as const,
      // The full lawful sequence, in the order the roadmap states it.
      steps: Object.freeze<readonly SwitchStep[]>([
        "MARK_ACCOUNT_DRAINING",
        "MARK_TASK_QUOTA_BLOCKED",
        "FINISH_CURRENT_ATOMIC_STEP",
        "WRITE_CHECKPOINT",
        "RELEASE_LEASE",
        "SELECT_ACCOUNT",
        "READ_ONLY_HEALTH_PROBE",
        "OPEN_FRESH_SESSION",
        "REVALIDATE_AUTHORITY_AND_PRESTATE",
        "REHYDRATE_CHECKPOINT",
        "CONTINUE",
      ]),
      selectedAccountId: chosen.accountId,
      // The events end where the decision ends (V2-B1f/F1).
      //
      // The plan declares all eleven steps, and it always will: the steps are
      // what the control plane *must* do, and shortening them would foreclose
      // the sessions F5 opens. What this list may carry is narrower — a record
      // of what has actually happened by the time the plan is handed over.
      //
      // `ACCOUNT_SWITCH_COMPLETED` used to sit here, beside `..._STARTED`,
      // emitted in the same breath and before any of steps 6-11 had happened
      // or *could* happen: nothing had selected an account, probed it, opened a
      // session, revalidated authority or rehydrated a checkpoint. A completion
      // is a claim about the end of a switch, and this module runs at its
      // beginning. Only the session-opener that finishes the switch may append
      // it, and until F5 builds one, nothing may.
      //
      // `ACCOUNT_SWITCH_STARTED` stays, and its `toAccountId` is not a claim
      // that `SELECT_ACCOUNT` was performed: `rankAccounts` chose that account
      // above, so the field records a decision this module has genuinely made.
      events: Object.freeze([
        event("QUOTA_WARNING", { accountId: currentAccountId }),
        event("TASK_STATE_CHANGED", { toState: "QUOTA_BLOCKED" }),
        event("LEASE_REVOKED", { accountId: currentAccountId }),
        event("ACCOUNT_SWITCH_STARTED", {
          fromAccountId: currentAccountId,
          toAccountId: chosen.accountId,
        }),
      ]),
    }),
  });
}
