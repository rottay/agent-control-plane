import { ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1, TaskEnvelope } from "@acp/contracts";

import { canonicalJsonStringify, sha256Hex } from "../canonical-json/index.js";

/**
 * The envelope revision preimage and its digest, version 1 (P-05/A).
 *
 * ## What this identifies
 *
 * `envelope_sha256` is the identity of a **revision of the work**. The audit's
 * finding N01 is that today it does not exist: two packets with different
 * objectives and different authorities reach the daemon under one digest,
 * because the only digest on that path is the submission's — task coordinates,
 * the instant and the elected route — and not one field of the envelope enters
 * it. This module is the half of that gap which can be closed as a pure
 * function. **It does not close N01**: nothing here is yet wired into the
 * submission path, and `daemon-child` still compares the submission digest.
 *
 * ## The preimage
 *
 *     preimage = ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1 + canonicalJsonStringify(parsed)
 *
 * with **no separator between them**. The LF is the last byte of the prefix and
 * there is exactly one, which is the shape `ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1`
 * set at P-08/A1. A formula that added its own `"\n"` would produce two, and
 * every pinned vector in this package would move.
 *
 * ## Why there is no list of fields
 *
 * `docs/audit/architecture/database/index.md` §6.2 requires the preimage to
 * cover **every** field of the contract, and deliberately refuses to enumerate
 * them so the page cannot go stale. This code refuses for the same reason. The
 * preimage is the whole parsed envelope, so "covers every field" is a property
 * of `TaskEnvelope` being a `z.strictObject`: a field added to the schema is in
 * the digest the day it is added, and nobody has to remember a second list.
 *
 * The exclusions §6.2 names — the default clock, `attempt_number`,
 * `account_id`, the resolved `model_version_id`, any process identifier — are
 * enforced by the same strictness from the other side. None of them is a field
 * of `TaskEnvelope`, and none of them can be smuggled in: an object carrying
 * one is refused by the parse rather than hashed.
 *
 * ## What enters that a reader might not expect
 *
 * `issuedAt` and `contractVersion` are fields, so both are in (adjudication V2
 * and V3). The consequences are real and are the intended ones: re-issuing the
 * same packet at a later instant is a **new revision**, and moving
 * `CONTRACT_VERSION` changes the digest of envelopes issued under the new
 * contract. No historical digest is migrated, because no history is rehashed.
 *
 * ## Frozen
 *
 * `v1` is never changed in place. A change to the encoding is a new prefix with
 * a new name and its own function; this one keeps producing the bytes it
 * produces today, for ever, or the digest identifies nothing.
 */

/**
 * The canonical preimage of an envelope revision, as a UTF-8 string.
 *
 * **Takes `unknown` and parses, deliberately.** A signature typed against
 * `TaskEnvelope` would be trusting its caller's cast, and a caller that
 * assembled an object by hand — one extra key, one missing one — would get a
 * digest of something that is not an envelope. Here the parse is the gate: what
 * is hashed is always the value `TaskEnvelope` accepted, never the value it was
 * handed.
 *
 * Throws `ZodError` for anything the contract refuses, and
 * `LedgerCanonicalizationError` for a value that parses and still has no
 * canonical JSON form — today that is exactly negative zero, which `zod`'s
 * `int().nonnegative()` accepts and `JSON.stringify` would silently rewrite to
 * `0`. Both refusals are the existing vocabulary; no error class is added.
 */
export function envelopeIdentityPreimageV1(value: unknown): string {
  return ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1 + canonicalJsonStringify(TaskEnvelope.parse(value));
}

/**
 * The digest of the preimage above. One producer, one algorithm.
 *
 * Deliberately a separate function from the preimage rather than an inlined
 * hash: a vector test that could only see the digest could not say which of the
 * two steps moved when one changed, and the preimage is the part the contract
 * actually specifies.
 */
export function envelopeSha256(value: unknown): string {
  return sha256Hex(envelopeIdentityPreimageV1(value));
}
