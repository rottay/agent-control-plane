import { createHash } from "node:crypto";

import { AdapterError } from "../errors/index.js";

/**
 * The Claude CLI's session name for one attempt (P-15 escalón A, ADR 0101).
 *
 * `--session-id` must be a valid UUID (stated in the recorded `--help` (2.1.280),
 * behaviour not observed). The task id alone was
 * passed until P-15, so every attempt of a task named the same conversation; the
 * execution session id (`taskId/attempt/accountId`) is not a UUID at all. So the
 * name is an RFC 4122 version 5 UUID over `taskId + "/" + attempt`, one per
 * attempt and the same on every call.
 *
 * This leaf is the one providers file admitted to `node:crypto` (L-P15A-1), for the
 * SHA-1 that version 5 is defined over, and nothing else: it reads no clock, no
 * randomness and no environment.
 */

/**
 * The namespace every Claude session name is derived under.
 *
 * Its own constant, distinct from the runtime's `ACP_UUID_NAMESPACE`, so a provider
 * session name can never collide with a ledger coordinate derived from the same
 * words.
 */
export const CLAUDE_SESSION_UUID_NAMESPACE = "7108affe-18e1-427e-8a44-493bb4a3af92";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The sixteen bytes of a canonical lowercase UUID. */
function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

/**
 * The version 5 UUID for `(taskId, attempt)`.
 *
 * Refused by name, never coerced: a task id that is not a non-empty string or an
 * attempt that is not a positive safe integer would name a conversation no attempt
 * owns, so it throws `PROTOCOL_UNSUPPORTED` before any argv exists.
 */
export function claudeSessionId(taskId: string, attempt: number): string {
  const context = { provider: "claude", taskId: typeof taskId === "string" ? taskId : "" };
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new AdapterError("PROTOCOL_UNSUPPORTED", context);
  }
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new AdapterError("PROTOCOL_UNSUPPORTED", context);
  }
  const digest = createHash("sha1")
    .update(uuidBytes(CLAUDE_SESSION_UUID_NAMESPACE))
    .update(taskId + "/" + String(attempt), "utf8")
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const id =
    hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  if (!UUID_SHAPE.test(id)) throw new AdapterError("PROTOCOL_UNSUPPORTED", context);
  return id;
}
