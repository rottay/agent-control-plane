import { CONTRACT_VERSION, ControlPlaneEvent } from "@acp/contracts";

import type { AuthorizationEvent } from "../../../../src/commit-authorization/index.js";
import type { DurableInvocation } from "../../../../src/contracts/index.js";
import { deriveEventCoordinate } from "../../../../src/core/coordinates/index.js";
import { deterministicUuid } from "../../../../src/core/coordinates/index.js";

/**
 * P7C pilot helpers: fixed fixtures and the authorization-event assembler for
 * the writer-packet drill.
 *
 * Nothing here spawns. The toy repository's `init`/`add`/`commit` and the
 * packet's own `add`/`commit`, plus every recorded check, stay in
 * `test/pilots/writer/index.test.ts` -- the only file in this pair whose name
 * ends `.test.ts`, exactly the P7A/P7B split.
 */

// ---------------------------------------------------------------------------
// Fixed instants -- no clock. N3: authorizedAt strictly precedes expiresAt.
// ---------------------------------------------------------------------------

export const WRITER_ISSUED_AT = "2026-08-30T09:45:00.000Z";
export const WRITER_LEASE_ACQUIRED_AT = "2026-08-30T09:50:00.000Z";
export const WRITER_LEASE_EXPIRES_AT = "2026-08-30T11:00:00.000Z";
export const WRITER_AUTHORIZED_AT = "2026-08-30T09:55:00.000Z";
export const WRITER_CHECK_RAN_AT = "2026-08-30T09:54:00.000Z";

// ---------------------------------------------------------------------------
// Fixed identifiers -- no random source
// ---------------------------------------------------------------------------

export const WRITER_HAPPY_TASK_ID = "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c01";
export const WRITER_HAPPY_LEASE_ID = "7c7c7c7c-0000-4000-8000-000000000001";
export const WRITER_HAPPY_SECOND_LEASE_ID = "7c7c7c7c-0000-4000-8000-000000000002";
export const WRITER_HAPPY_RECEIPT_ID = "7c7c7c7c-1111-4111-8111-000000000001";

export const WRITER_PROBE_TASK_IDS = Object.freeze({
  verifierNotIndependent: "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c11",
  checkFailed: "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c12",
  writeSetViolation: "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c13",
  commitMessageMismatch: "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c14",
  commitParentMismatch: "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c15",
});

export const WRITER_SHARED_PROBE_LEASE_ID = "7c7c7c7c-0000-4000-8000-0000000000a1";
export const WRITER_VIOLATION_PROBE_LEASE_ID = "7c7c7c7c-0000-4000-8000-0000000000a2";
export const WRITER_PROBES_RECEIPT_ID = "7c7c7c7c-1111-4111-8111-0000000000a1";

/** A durable invocation for one scenario, from fixed inputs only. */
export function writerInvocation(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("p7c-writer-invocation/" + taskId),
    submittedAt: WRITER_ISSUED_AT,
    submissionDigest: "c".repeat(64),
  };
}

// ---------------------------------------------------------------------------
// The authorization-event assembler -- the P7A wrapEnforcementEvent idiom,
// typed for AuthorizationEvent rather than EnforcementEvent (the two event
// unions are structurally close but nominally distinct closed vocabularies).
// ---------------------------------------------------------------------------

/**
 * Turn one `AuthorizationEvent` candidate into a real, parsed
 * `ControlPlaneEvent` ready for `ledger.append`.
 *
 * The envelope is derived exactly as `core/events` derives it for a plan
 * step: `deriveEventCoordinate` over durable invocation inputs only, so two
 * runs of this drill produce byte-identical events. `fromState`/`toState`
 * are the same state, which is legal for every event type this module wraps
 * -- neither a commit authorization nor a commit record itself moves the
 * task's lifecycle state; the plan's own steps do that.
 */
export function wrapAuthorizationEvent(
  invocation: DurableInvocation,
  transitionId: string,
  atState: string,
  emittedBy: string,
  candidate: AuthorizationEvent,
): ControlPlaneEvent {
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  return ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: candidate.type,
    fromState: atState,
    toState: atState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: null,
    causationId: null,
    payload: candidate.payload,
  });
}
