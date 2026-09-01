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

import type { AccountRecord, ControlPlaneEventType } from "@acp/contracts";

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

export const SWITCH_TRIGGERS: readonly SwitchTrigger[] = Object.freeze([
  "QUOTA_EXHAUSTED",
  "QUOTA_WARNING",
]);

function isTrigger(value: unknown): value is SwitchTrigger {
  return typeof value === "string" && (SWITCH_TRIGGERS as readonly string[]).includes(value);
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
      events: Object.freeze([
        event("QUOTA_WARNING", { accountId: currentAccountId }),
        event("TASK_STATE_CHANGED", { toState: "QUOTA_BLOCKED" }),
        event("LEASE_REVOKED", { accountId: currentAccountId }),
        event("ACCOUNT_SWITCH_STARTED", {
          fromAccountId: currentAccountId,
          toAccountId: chosen.accountId,
        }),
        event("ACCOUNT_SWITCH_COMPLETED", {
          fromAccountId: currentAccountId,
          toAccountId: chosen.accountId,
        }),
      ]),
    }),
  });
}
