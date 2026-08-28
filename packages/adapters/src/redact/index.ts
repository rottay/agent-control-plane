import { findCredentialViolations, findTranscriptViolations } from "@acp/contracts";

/**
 * Payload bounds and the one privacy vocabulary.
 *
 * Adapters handle the rawest material in this repository: provider stdout, an
 * auth prompt, a config path. So a payload is bounded before it is shaped, and
 * shaped before it is emitted, and the question "is this a secret?" is asked
 * with the guards `@acp/contracts` already owns rather than a second denylist
 * that could disagree with the first.
 *
 * Redaction here is absence, not blanking: a credential-shaped key is dropped
 * entirely rather than emptied, because a blanked field still names the secret
 * that belongs there.
 */

/** Per-string ceiling inside a normalized payload. */
export const PAYLOAD_STRING_MAX = 200;

/** Serialized ceiling for a whole normalized payload. */
export const PAYLOAD_BYTES_MAX = 2_048;

export function boundString(value: string): string {
  return value.length <= PAYLOAD_STRING_MAX ? value : value.slice(0, PAYLOAD_STRING_MAX);
}

/** Does this value carry anything the observation surface must never expose? */
export function hasPrivacyViolation(value: unknown): boolean {
  return findCredentialViolations(value).length > 0 || findTranscriptViolations(value).length > 0;
}

/**
 * Shape a payload for emission: bound every string, drop every key the privacy
 * guards object to, and refuse the whole payload if it is still too large.
 *
 * Scalars only. A nested object in an adapter payload would be a place for a
 * transcript to hide, so nesting is dropped rather than walked.
 */
export function shapePayload(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const shaped: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    if (hasPrivacyViolation({ [key]: value })) continue;
    if (typeof value === "string") {
      shaped[key] = boundString(value);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      shaped[key] = value;
    }
    // Anything else — objects, arrays, functions — is dropped, not walked.
  }
  const serialized = JSON.stringify(shaped);
  if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_BYTES_MAX) {
    return Object.freeze({ truncated: true });
  }
  return Object.freeze(shaped);
}
