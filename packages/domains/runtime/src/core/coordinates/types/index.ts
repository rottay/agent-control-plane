/**
 * The payload coordinate of one event (P-15 escalón B, ADR 0102).
 *
 * Empty for a V1 invocation, and exactly the revision's two numbers for a V2 one.
 * The contract reads these two keys to decide which idempotency key an event must
 * carry, so a payload that half-carries them, or carries them as anything but
 * integers, is refused at the key rule rather than read as a V1 event.
 */
export type PayloadCoordinate =
  | { readonly revisionNumber?: never; readonly attemptNumber?: never }
  | { readonly revisionNumber: number; readonly attemptNumber: number };
