import { createHash } from "node:crypto";

import { buildIdempotencyKey } from "@acp/contracts";

import type { DurableInvocation, EventCoordinate, OperationCoordinate } from "../../contracts/index.js";

/**
 * Deterministic coordinate derivation.
 *
 * Everything here is a pure function of durable invocation inputs. No clock, no
 * random source, no environment variable and no filesystem read participates in
 * any value that ends up inside a ledger event or an operation identity.
 *
 * That is not stylistic. The ledger treats "same idempotency key, different
 * canonical bytes" as a typed conflict and fails closed, and a durable step can
 * be re-executed after a crash in the window between its effect and the
 * durability of its result. A coordinate that read a clock in that window comes
 * back different, and a benign replay becomes a hard conflict at exactly the
 * moment recovery is running.
 */

/**
 * Namespace for name-based identifiers in this plane.
 *
 * A fixed constant, so the same name always yields the same identifier across
 * processes, machines and restarts.
 */
export const ACP_UUID_NAMESPACE = "6f2a1e14-3f8b-5c2d-9a47-2b6d1c8e5f30";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/**
 * RFC 4122 name-based (version 5) UUID.
 *
 * Version 5 rather than a random-looking version 4: these identifiers are
 * derived, and labelling a derived value as random would misdescribe it to
 * anyone reading the log. SHA-1 is used because that is what the version 5
 * definition specifies; it is an identifier, never a security boundary.
 */
export function deterministicUuid(name: string): string {
  const digest = createHash("sha1")
    .update(uuidToBytes(ACP_UUID_NAMESPACE))
    .update(name, "utf8")
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  // Version 5 in the high nibble of octet 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  // RFC 4122 variant in the two high bits of octet 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

/** Stable name for one event, from durable inputs only. */
export function eventName(invocation: DurableInvocation, transitionId: string): string {
  return (
    "event/" +
    invocation.invocationId +
    "/" +
    invocation.taskId +
    "/" +
    String(invocation.attempt) +
    "/" +
    transitionId
  );
}

/** Stable name for one side effect, from durable inputs only. */
export function operationName(
  invocation: DurableInvocation,
  transitionId: string,
  planIndex: number,
): string {
  return (
    "operation/" +
    invocation.invocationId +
    "/" +
    invocation.taskId +
    "/" +
    String(invocation.attempt) +
    "/" +
    transitionId +
    "/" +
    String(planIndex)
  );
}

/**
 * Derive the identity and timestamps of one event.
 *
 * Both timestamps are the invocation's submission instant, which is a
 * SUBMISSION-origin value captured before ingress. They are deliberately not a
 * wall-clock reading: a clock read here would be the single most likely source
 * of a replay divergence, and the ledger already carries `sequence` for
 * ordering, so nothing depends on these two fields being distinct. A later
 * phase that wants per-event instants must take them from a journaled clock,
 * which is a JOURNALED-origin value, not from `Date.now()`.
 */
export function deriveEventCoordinate(
  invocation: DurableInvocation,
  transitionId: string,
  planIndex: number,
): EventCoordinate {
  void planIndex;
  return {
    origin: "DERIVED",
    eventId: deterministicUuid(eventName(invocation, transitionId)),
    occurredAt: invocation.submittedAt,
    recordedAt: invocation.submittedAt,
    idempotencyKey: buildIdempotencyKey({
      taskId: invocation.taskId,
      attempt: invocation.attempt,
      transitionId,
    }),
  };
}

/** Derive the addressable identity of one side effect. */
export function deriveOperationCoordinate(
  invocation: DurableInvocation,
  transitionId: string,
  planIndex: number,
): OperationCoordinate {
  return {
    origin: "DERIVED",
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    operationIndex: planIndex,
    operationId: deterministicUuid(operationName(invocation, transitionId, planIndex)),
  };
}

/**
 * The content a toy effect writes for an operation.
 *
 * Derived, so a re-run writes byte-identical content and the probe can tell
 * "already done by me" from "written by something else".
 */
export function operationDigest(operation: OperationCoordinate): string {
  return createHash("sha256")
    .update(
      operation.taskId +
        "/" +
        String(operation.attempt) +
        "/" +
        operation.transitionId +
        "/" +
        String(operation.operationIndex),
      "utf8",
    )
    .digest("hex");
}
