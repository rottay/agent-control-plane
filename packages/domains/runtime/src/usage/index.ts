import { CONTRACT_VERSION, ControlPlaneEvent } from "@acp/contracts";
import type { ControlPlaneEvent as ControlPlaneEventType } from "@acp/contracts";

import type { DurableInvocation } from "../contracts/index.js";
import { deriveEventCoordinate } from "../core/coordinates/index.js";
import type { LedgerPort } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";

/**
 * Token usage and reservation emission.
 *
 * The observation plane folds `TOKEN_USAGE_RECORDED` and
 * `TOKEN_RESERVATION_RECORDED` into per-task and per-initiative rollups; this
 * module is what puts them in the ledger. It records a fact a caller observed
 * — it does not measure anything itself, and it has no opinion about whether
 * the number is right.
 *
 * The house determinism laws hold exactly as they do for a plan step: the
 * coordinates come from the durable invocation, nothing reads a clock or a
 * random source, and the payload is the observed pair verbatim. Recording the
 * same observation twice appends once, because the second append is an exact
 * replay under the same key.
 *
 * **The module never opens a task.** An observation about a task the ledger has
 * never seen is refused, not appended. A usage event that could create a task
 * would make spend an origin story: a rollup would show tokens burned against
 * a task with no discovery, no initiative and no lifecycle, and nothing later
 * could repair the attribution. The ledger's own contiguity guard would refuse
 * a `fromState` for a task it does not know, but relying on that would put the
 * error one layer from the cause; this module refuses at the door and says why.
 */

/**
 * Ceiling for a single observation's `tokens` (V2-B7T, D-B7T-2).
 *
 * Declared here rather than imported, in the same idiom
 * `observation/src/rollups` uses for its own bound and for the same stated
 * reason: this module's bounds are its own, and a change to one measure must
 * not silently move another. `@acp/observation` is not in the runtime's import
 * allowlist, so it could not be imported even if that were the preference — and
 * the fence, which is the only place that can read both files, pins the two
 * literals equal.
 *
 * **Why refuse rather than append.** The rollup fold drops any event whose
 * `payload.tokens` exceeds its own ceiling and counts it in `skippedMalformed`
 * — silently, and correctly, because a read model may not refuse. So an
 * observation above the ceiling would be durably appended and then quietly
 * absent from every rollup: the quiet-wrong-number failure this plane exists to
 * avoid. Refusing at the recorder puts the error at the cause, where a caller
 * can see it, and appends nothing.
 */
export const USAGE_TOKENS_MAX = 10_000_000;

/**
 * The durable name one execution-trail usage entry is recorded under.
 *
 * Derived from the operation's own plan index and the trail entry's own step
 * index, so it is unique within the attempt, stable across replay, and carries
 * no clock and no counter. A resumed attempt that re-executes rebuilds exactly
 * this name, which is why the second append is an exact replay rather than a
 * second row — the ledger recognises the key, and nothing anywhere has to
 * remember that it already recorded this.
 *
 * Both components are non-negative integers, so the result always satisfies the
 * contract's transition-id grammar (`/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`, at most
 * 120 characters) with room to spare.
 */
export function usageTransitionId(operationIndex: number, stepIndex: number): string {
  return "usage." + String(operationIndex) + "." + String(stepIndex);
}

/** Which of the two usage facts an observation carries. */
export type TokenObservationKind = "USAGE" | "RESERVATION";

const EVENT_TYPE: Readonly<Record<TokenObservationKind, "TOKEN_USAGE_RECORDED" | "TOKEN_RESERVATION_RECORDED">> =
  Object.freeze({
    USAGE: "TOKEN_USAGE_RECORDED",
    RESERVATION: "TOKEN_RESERVATION_RECORDED",
  });

export interface TokenObservation {
  readonly invocation: DurableInvocation;
  readonly kind: TokenObservationKind;
  /** The account the tokens were spent from, or held against. */
  readonly accountId: string;
  readonly tokens: number;
  /**
   * The event that prompted this observation, when one genuinely did.
   *
   * Optional and normally absent: spend accrues across a run rather than being
   * caused by a single event, and inventing a cause to fill the field would be
   * exactly the fabricated causality the consumer refuses to draw.
   */
  readonly causedBy?: string | null;
  /**
   * A durable name for this observation, unique within the task's attempt.
   *
   * It is the caller's, not this module's: only the caller knows whether two
   * observations are the same fact seen twice or two different facts. A derived
   * name would have to guess, and guessing here either loses a record or
   * duplicates one.
   */
  readonly transitionId: string;
  readonly emittedBy: string;
}

export interface TokenRecordResult {
  /** false means this exact observation was already recorded. */
  readonly inserted: boolean;
  readonly event: ControlPlaneEventType;
}

/**
 * Append one usage or reservation observation.
 *
 * A same-state passthrough: recording what was spent does not move the task's
 * lifecycle, so `fromState` and `toState` are both the state the ledger
 * currently holds — read from the ledger rather than claimed by the caller,
 * for the same reason every other beat reads it there.
 */
export function recordTokenObservation(
  ledger: LedgerPort,
  observation: TokenObservation,
): TokenRecordResult {
  const { invocation, kind, accountId, tokens, transitionId, emittedBy } = observation;

  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new SupervisorError(
      "refusing to record a token observation that is not a non-negative integer count",
    );
  }
  // D-B7T-2. Above the rollup's ceiling the fold would drop this row and count
  // it as malformed, so appending it would put a number in the ledger that
  // every reader silently ignores. Raised the same way as the guard above it:
  // one failure shape in this module, not two.
  if (tokens > USAGE_TOKENS_MAX) {
    throw new SupervisorError(
      "refusing to record a token observation above the rollup ceiling; the" +
        " fold would drop it as malformed and the spend would be durably" +
        " recorded and permanently invisible",
    );
  }
  if (accountId.length === 0) {
    throw new SupervisorError("refusing to record a token observation with no account");
  }

  // N1. The task must already exist. This module records against history; it
  // never begins one.
  const task = ledger.getTask(invocation.taskId);
  if (task === null) {
    throw new SupervisorError(
      "refusing to record token usage for a task the ledger has never seen;" +
        " a usage event may never open a task, because spend recorded against" +
        " a task with no discovery has no initiative and no lifecycle to" +
        " attribute it to",
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
    type: EVENT_TYPE[kind],
    fromState: task.currentState,
    toState: task.currentState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    // The correlation is the walk's own invocation id: a usage observation
    // rides an attempt rather than starting one, so it belongs to that run's
    // thread and says so. Causation is the caller's to supply when a specific
    // event genuinely prompted the observation; spend is normally continuous
    // rather than caused, so null is the honest common case and not a gap.
    correlationId: invocation.invocationId,
    causationId: observation.causedBy ?? null,
    // Verbatim, and exactly the pair the rollup fold reads. The plural key is
    // load bearing: the contract's credential guard denies a singular `token`.
    payload: { accountId, tokens },
  });

  const result = ledger.append(event);
  return { inserted: result.inserted, event: result.record.event };
}
