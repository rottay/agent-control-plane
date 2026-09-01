/**
 * ControlPlaneEvent — `@acp/contracts` (P8-T G6).
 *
 * The append-only ledger record and its idempotency coordinates.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import { attachGuards, serializedByteLength } from "../credential-guards/index.js";
import { TaskState } from "../lifecycle/index.js";
import { ContractVersion, Timestamp, Uuid } from "../primitives/index.js";
import { WorkerIdentityString } from "../worker-identity/index.js";

/** Serialized byte budget for a single ControlPlaneEvent payload. */
export const EVENT_PAYLOAD_MAX_BYTES = 8_192;

export const CONTROL_PLANE_EVENT_TYPES = [
  "TASK_DISCOVERED",
  "TASK_CLASSIFIED",
  "TASK_READY",
  "SLOT_RESERVED",
  "RUN_STARTED",
  "ATOMIC_STEP_COMPLETED",
  "CHECKPOINT_WRITTEN",
  "VERIFICATION_COMPLETED",
  "AUDIT_COMPLETED",
  "COMMIT_AUTHORIZED",
  "COMMIT_RECORDED",
  "LEASE_ACQUIRED",
  "LEASE_REVOKED",
  "WRITE_SET_VIOLATION_DETECTED",
  "QUOTA_WARNING",
  // Usage attribution. Both are task facts, so they belong to the task stream
  // and are same-state passthroughs: recording what a task spent, or what was
  // reserved for it, moves no lifecycle state. The payload is
  // `{accountId, tokens}` on the WorkerSlot bounds for both — the reservation
  // variant mirrors the usage shape rather than inventing a second one. In P7I
  // only tests append these; the runtime's own emission is a later packet.
  "TOKEN_USAGE_RECORDED",
  "TOKEN_RESERVATION_RECORDED",
  "ACCOUNT_SWITCH_STARTED",
  "ACCOUNT_SWITCH_COMPLETED",
  "AUTH_REQUIRED_RAISED",
  "TASK_STATE_CHANGED",
  "TASK_FAILED",
  "TASK_CANCELLED",
] as const;

export const ControlPlaneEventType = z.enum(CONTROL_PLANE_EVENT_TYPES);
export type ControlPlaneEventType = z.infer<typeof ControlPlaneEventType>;

/**
 * The idempotency coordinates of a ledger append.
 *
 * (taskId, attempt, transitionId) is the natural key. The derived
 * idempotencyKey is what the ledger enforces uniqueness on, so a replayed
 * durable step appends nothing rather than duplicating state.
 */
export const IdempotencyCoordinates = z.strictObject({
  taskId: Uuid,
  attempt: z.number().int().positive().max(10_000),
  transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});
export type IdempotencyCoordinates = z.infer<typeof IdempotencyCoordinates>;

export function buildIdempotencyKey(coordinates: IdempotencyCoordinates): string {
  return (
    coordinates.taskId + "/" + String(coordinates.attempt) + "/" + coordinates.transitionId
  );
}

export const ControlPlaneEvent = z
  .strictObject({
    contractVersion: ContractVersion,
    eventId: Uuid,

    taskId: Uuid,
    attempt: z.number().int().positive().max(10_000),
    transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    /** Must equal taskId/attempt/transitionId. The ledger uniques on this. */
    idempotencyKey: z.string().min(1).max(300),

    type: ControlPlaneEventType,
    fromState: TaskState.nullable(),
    toState: TaskState,

    emittedBy: WorkerIdentityString,
    occurredAt: Timestamp,
    recordedAt: Timestamp,

    /**
     * The causal thread. Definitional, and deliberately not enforced here.
     *
     * `correlationId` groups every event of one run: the producers set it to
     * the invocation's own id, so "this attempt" is selectable without
     * reconstructing it from coordinates.
     *
     * `causationId` names the event this one followed from. Within a walk that
     * is the plan's previous step in the same attempt; across tasks it is the
     * event that genuinely prompted the work, and null everywhere nothing
     * caused anything -- nothing causes a task's discovery.
     *
     * **The ledger does not verify either.** Integrity here means the hash
     * chain: `previousSha256`, `eventSha256`, the idempotency key. A row whose
     * causation names a missing event, or an event in another task, is a valid
     * row. Causation is therefore advisory, and its trustworthiness comes from
     * two guards outside this contract: the producer refuses to append a link
     * whose predecessor is not durably present, and the consumer refuses to
     * draw an edge it cannot resolve. Reading these fields as verified facts
     * about the world would be reading more than the contract promises.
     */
    correlationId: Uuid.nullable(),
    causationId: Uuid.nullable(),

    /** Bounded structured payload. Never a provider transcript. */
    payload: z.record(z.string().max(80), z.unknown()),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const expected = buildIdempotencyKey({
      taskId: value.taskId,
      attempt: value.attempt,
      transitionId: value.transitionId,
    });
    if (value.idempotencyKey !== expected) {
      ctx.addIssue({
        code: "custom",
        message: "idempotencyKey must be exactly taskId/attempt/transitionId",
        path: ["idempotencyKey"],
      });
    }

    if (value.fromState === value.toState && value.type === "TASK_STATE_CHANGED") {
      ctx.addIssue({
        code: "custom",
        message: "a state change event must actually change state",
        path: ["toState"],
      });
    }

    const size = serializedByteLength(value.payload);
    if (size > EVENT_PAYLOAD_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message:
          "event payload is " +
          String(size) +
          " bytes which exceeds the " +
          String(EVENT_PAYLOAD_MAX_BYTES) +
          " byte budget",
        path: ["payload"],
      });
    }
  });
export type ControlPlaneEvent = z.infer<typeof ControlPlaneEvent>;
