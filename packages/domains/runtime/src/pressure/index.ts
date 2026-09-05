import { CONTRACT_VERSION, ControlPlaneEvent } from "@acp/contracts";
import type {
  ControlPlaneEventType as ControlPlaneEventTypeName,
  PROVIDER_PRESSURES,
  ResolvedRoute,
} from "@acp/contracts";

import type { DurableInvocation } from "../contracts/index.js";
import { deriveEventCoordinate } from "../core/coordinates/index.js";
import type { LedgerPort } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";

/**
 * Provider pressure, recorded.
 *
 * A provider that refuses an account, or asks for a human at a credential
 * path, has said something about that account which nothing durable held
 * before this module: the walk carried it intact through the adapter, the
 * normalizer and the port into its own trail, read exactly one kind out of
 * that trail, and folded the rest into a digest. So the account that needed a
 * human was never recorded as needing one, and the switch decision — whose
 * entire input is a trigger — had no producer anywhere outside a test.
 *
 * This module records that fact and decides nothing with it. It is built to
 * the exact shape of `recordTokenObservation`, because that shape is already
 * proven and already ratified: it refuses a task the ledger has never seen, it
 * reads the task's own state rather than claiming one, its coordinates come
 * from the durable invocation with no clock and no random source, and its
 * payload is three named scalars carried verbatim.
 *
 * **What it must never become.** Not a quota estimator: nothing here infers
 * how much allowance is left, when it returns, or whether a retry is worth
 * making — `ACCOUNT_QUOTA_UNPUBLISHED` and `RESET_UNKNOWN` stay the only
 * answers to those. Not an operator: no `AccountActionEvent` is appended,
 * because an observed provider refusal is not a human decision and recording
 * it as a drain would forge one. Not an elector: entering `QUOTA_BLOCKED` is
 * `decideSwitch`'s call and its successor's append, never this recorder's.
 *
 * **What it deliberately does not create.** No frozen event type. The
 * vocabulary is 24 names onto 5 channels, and a 25th moves the protocol, the
 * console and the API contract version. An exhaustion is recorded under
 * `QUOTA_WARNING` with the classified kind in the payload — the reading
 * `decideSwitch`'s own SWITCH branch already takes, where an exhaustion emits
 * `QUOTA_WARNING` beside its plan.
 */

/**
 * The durable name one execution-trail pressure entry is recorded under.
 *
 * Derived from the operation's own plan index and **the position of the event
 * in the drained trail**, so it is unique within the attempt, stable across
 * replay, and carries no clock and no counter. Both components are
 * non-negative integers, so the result satisfies the contract's transition-id
 * grammar with room to spare.
 *
 * **The trail position, and never a provider-reported ordinal.** The landed
 * usage recorder names its rows from the `stepIndex` the adapter reported, and
 * one shipped adapter hardcodes that to zero: two usage frames in one
 * operation from such a provider collide on one key, and the second append is
 * a silent replay. That defect is unreachable today and is left to its own
 * packet, but this module must not copy the shape — two different pressure
 * frames in one stream are two facts, and they get two rows.
 */
export function pressureTransitionId(operationIndex: number, trailIndex: number): string {
  return "pressure." + String(operationIndex) + "." + String(trailIndex);
}

/**
 * Where each classified member is recorded, and which are recorded at all.
 *
 * `TRANSIENT` and `UNCLASSIFIED` have no destination, and their absence is the
 * design rather than an omission: a provider that failed, or said something no
 * table understood, has told us nothing about the account. The refusal is
 * fail-closed in the cheap direction — an unrecorded transient costs nothing,
 * and a transient recorded as quota costs an account.
 */
const EVENT_TYPE: Readonly<
  Record<(typeof PROVIDER_PRESSURES)[number], ControlPlaneEventTypeName | undefined>
> = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED_RAISED",
  QUOTA_EXHAUSTED: "QUOTA_WARNING",
  QUOTA_WARNING: "QUOTA_WARNING",
  TRANSIENT: undefined,
  UNCLASSIFIED: undefined,
});

export interface ProviderPressureObservation {
  readonly invocation: DurableInvocation;
  /** The account the provider was serving when it said this. */
  readonly accountId: string;
  /**
   * The provider that said it.
   *
   * Typed as the route's provider rather than as the CLI vocabulary, and the
   * width is deliberate. A `pressure` event carries the classifying adapter's
   * own provider, which is always a CLI name; an `authRequired` event does
   * not carry one at all, and the API and local transports already put that
   * kind on the trail, where the provider that served the route is an opaque
   * segment. Narrowing this to the CLI list would mean silently dropping those
   * observations — a fail-open on evidence in the one module whose whole
   * purpose is not to lose it.
   */
  readonly provider: ResolvedRoute["provider"];
  /**
   * What the provider said, classified. Never a message, a code or a count.
   *
   * The union is spelled from the contract's own list rather than restated, so
   * a sixth member forces a destination row here rather than arriving with
   * none.
   */
  readonly pressure: (typeof PROVIDER_PRESSURES)[number];
  /** A durable name for this observation, unique within the task's attempt. */
  readonly transitionId: string;
  readonly emittedBy: string;
}

/**
 * Append one provider-pressure observation.
 *
 * A same-state passthrough: observing pressure moves no lifecycle state, so
 * `fromState` and `toState` are both the state the ledger currently holds —
 * read from the ledger rather than claimed by the caller, for the reason every
 * other beat reads it there.
 *
 * Returns nothing. There is no outcome for a caller to branch on: a member
 * with no destination appends nothing and says so by appending nothing, and a
 * repeated observation is a replay the ledger recognises by its key.
 */
export function recordProviderPressure(
  ledger: LedgerPort,
  observation: ProviderPressureObservation,
): void {
  const { invocation, accountId, provider, pressure, transitionId, emittedBy } = observation;

  const type = EVENT_TYPE[pressure];
  // Not a refusal: a member with no destination is a lawful observation that
  // says nothing about the account, and the adapters construct no carrier for
  // one. Reaching here with it is not an error, and appending it would be.
  if (type === undefined) return;

  if (accountId.length === 0) {
    throw new SupervisorError("refusing to record provider pressure with no account");
  }
  if (provider.length === 0) {
    throw new SupervisorError("refusing to record provider pressure with no provider");
  }

  // The task must already exist. This module records against history; it never
  // begins one. A pressure event that could open a task would make a refusal
  // an origin story: a row naming an account refused on a task with no
  // discovery, no initiative and no lifecycle to attribute it to.
  const task = ledger.getTask(invocation.taskId);
  if (task === null) {
    throw new SupervisorError(
      "refusing to record provider pressure for a task the ledger has never" +
        " seen; a pressure event may never open a task, because an account" +
        " refusal recorded against a task with no discovery has no lifecycle" +
        " to attribute it to",
    );
  }

  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  const event = ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type,
    fromState: task.currentState,
    toState: task.currentState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    // The walk's own invocation: an observation rides an attempt rather than
    // starting one. Causation is null because no single control-plane event
    // prompted this — the provider did, and the provider is not one of ours.
    correlationId: invocation.invocationId,
    causationId: null,
    // Three safe scalars, built field by field from named members. No free
    // text, no provider message, no URL, no code, and no number: there is no
    // remaining count, reset instant or retry-after here because the
    // vocabulary that reaches this point has no field one could occupy.
    payload: { accountId, provider, pressure },
  });

  ledger.append(event);
}
