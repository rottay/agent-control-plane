import { createHash } from "node:crypto";

import { LedgerValidationError } from "../errors/index.js";
import type { AccountEventRow } from "../types/index.js";

/**
 * The account sidecar's preimage, version 1 (P-08).
 *
 * `account_events` shipped in migration 5 without a hash chain: no
 * `previous_sha256`, no `event_sha256`, and an applied migration is never
 * rewritten. The chain therefore arrives beside the stream rather than inside
 * it, in `account_event_integrity`, and this module is the one place that says
 * what its digests are computed over.
 *
 * **It is deliberately a module of its own, and deliberately pure.** Nothing
 * here opens a database, reads a clock or holds state: it is a function from a
 * stored row to bytes. That matters because of what the caller does with the
 * result — the sidecar covers the account stream retroactively, hashing rows
 * `1..H` that were written long before anybody hashed anything, and the
 * contract forbids re-anchoring a chain once it exists. An error in this
 * encoding is therefore **silent and permanent**: it produces a chain that is
 * internally consistent and wrong, over history, with no lawful way to correct
 * it. So it is fixed by test vectors before a single row exists.
 *
 * ## What this encoding is NOT
 *
 * It is not the ledger's canonical JSON, and `canonicalJsonStringify` must
 * never be reached for from here. The two solve opposite problems. Canonical
 * JSON exists to give one logical value one byte form, which necessarily
 * rewrites what it is handed — key order, number form, escapes. This encoding
 * exists to hash **the bytes that are on disk, unchanged**: §8.1 is explicit
 * that `event_json` enters as complete TEXT, never re-parsed, never re-ordered,
 * never selectively extracted. Canonicalizing here would hash something other
 * than what the ledger stored, which is the one thing the sidecar exists to
 * make impossible.
 *
 * For the same reason nothing here normalizes Unicode, trims whitespace,
 * re-formats a timestamp or touches a line ending.
 *
 * ## The encoding
 *
 * Three encoders, and the length prefixes are what make concatenation
 * unambiguous — without them `("ab", "c")` and `("a", "bc")` would produce the
 * same bytes, and two different histories could share a digest:
 *
 * - `T(s)` — `"T" + <byte length in decimal> + ":"` in ASCII, then the UTF-8
 *   bytes of the value. The length is **bytes, not characters**.
 * - `I(n)` — `"I" + <exact decimal> + ";"` in ASCII.
 * - `N;` — SQL NULL. Distinct from `T(0):` (the empty string) and from
 *   `T4:null` (the text "null"), which is the distinction a careless encoder
 *   collapses first.
 *
 * The field order is **closed**. Adding a column to `account_events` requires a
 * new preimage version with its own name; `v1` is never changed in place and
 * its history is never rehashed.
 */

/**
 * The version prefix, as bytes.
 *
 * The `\n` is a single LF byte (`0x0a`), not the two characters a backslash and
 * an `n` would be if this were written into a document by hand. A test pins the
 * byte.
 */
export const ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1 = "acp/account-event-integrity/v1\n";

/** The previous digest of the first sidecar row. Sixty-four zeros. */
export const ACCOUNT_INTEGRITY_GENESIS_SHA256 = "0".repeat(64);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** SQL NULL. Never `T0:`, never `T4:null`. */
const NULL_MARKER = Buffer.from("N;", "ascii");

/**
 * `T(s)`: type tag, byte length, colon, then the value's UTF-8 bytes.
 *
 * `Buffer.from(value, "utf8")` is taken first and its `length` used, so the
 * declared length is always the number of bytes that actually follow. Deriving
 * it from `value.length` instead would be the count of UTF-16 code units, which
 * differs for anything outside the Basic Latin range and would make the
 * encoding ambiguous for exactly the inputs a reader is least likely to test.
 */
function encodeText(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from("T" + String(bytes.length) + ":", "ascii"), bytes]);
}

/**
 * `I(n)`: type tag, exact decimal, semicolon.
 *
 * Refuses anything that is not a safe integer rather than rendering it. Beyond
 * `Number.MAX_SAFE_INTEGER` a JavaScript number no longer identifies a single
 * 64-bit integer — `2**53` and `2**53 + 1` are the same value — so a decimal
 * rendered from one would be a guess, and two different stored integers could
 * receive the same digest. Refusing is the only answer that cannot be wrong.
 *
 * `String()` of a safe integer is exact and carries no `+`, no leading zero and
 * no exponent, which is precisely the form §8.1 asks for.
 */
function encodeInteger(value: number, path: string): Buffer {
  if (!Number.isSafeInteger(value)) {
    throw new LedgerValidationError([
      {
        path,
        message:
          "an account integrity preimage encodes an exact integer, and " +
          String(value) +
          " is not one a 64-bit value can be recovered from",
      },
    ]);
  }
  return Buffer.from("I" + String(value) + ";", "ascii");
}

/** One row of `account_events`, with the chain position it is being hashed at. */
export interface AccountIntegrityInput {
  /**
   * The sidecar's own key for this row. Must equal `row.sequence`: the sidecar
   * is one-to-one with the stream, and a digest filed under a position other
   * than the row's own would make the chain describe a history that never
   * happened.
   */
  readonly accountSequence: number;
  /** The previous row's `event_sha256`, or sixty-four zeros at sequence one. */
  readonly previousSha256: string;
  /** The stored row, exactly as `account_events` holds it. */
  readonly row: AccountEventRow;
}

/**
 * The exact bytes hashed for one sidecar row.
 *
 * Returned as a `Buffer` rather than a string on purpose: this is a byte
 * string, parts of it are not valid text on their own, and handing back
 * something a caller could concatenate as text would invite exactly the
 * re-encoding this module exists to avoid.
 */
export function accountIntegrityPreimageV1(input: AccountIntegrityInput): Buffer {
  const { accountSequence, previousSha256, row } = input;

  if (!SHA256_PATTERN.test(previousSha256)) {
    throw new LedgerValidationError([
      {
        path: "previousSha256",
        message: "a previous digest is 64 lowercase hexadecimal characters",
      },
    ]);
  }
  if (!Number.isSafeInteger(accountSequence) || accountSequence < 1) {
    throw new LedgerValidationError([
      { path: "accountSequence", message: "a sidecar position is an integer of one or greater" },
    ]);
  }
  if (row.sequence !== accountSequence) {
    // §8.1: "`r.sequence` debe ser igual al `account_sequence` del sidecar".
    // Hashing a row under a foreign position would produce a chain that links
    // correctly and describes the wrong history.
    throw new LedgerValidationError([
      {
        path: "row.sequence",
        message:
          "the sidecar position " +
          String(accountSequence) +
          " does not match the row's own sequence " +
          String(row.sequence),
      },
    ]);
  }

  // The order and the list are closed. A field added to `account_events` needs
  // a new preimage version, not an entry here.
  return Buffer.concat([
    Buffer.from(ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1, "utf8"),
    encodeText(previousSha256),
    encodeInteger(row.sequence, "row.sequence"),
    encodeText(row.event_id),
    encodeText(row.idempotency_key),
    encodeText(row.account_id),
    encodeInteger(row.version, "row.version"),
    encodeText(row.action),
    encodeText(row.resulting_state),
    encodeText(row.actor),
    row.note === null ? NULL_MARKER : encodeText(row.note),
    encodeText(row.occurred_at),
    encodeText(row.recorded_at),
    encodeText(row.contract_version),
    encodeText(row.event_json),
  ]);
}

/**
 * The sidecar's `event_sha256` for one row: lowercase hex of SHA-256 over the
 * preimage bytes.
 *
 * The digest is taken over the `Buffer` directly rather than over a string
 * decoded from it. The two would agree for well-formed input, and the point is
 * that they must agree for every input: routing bytes through a text decode and
 * re-encode is a re-interpretation, and this module's whole claim is that no
 * re-interpretation happens between the stored value and the hash.
 */
export function accountIntegrityDigestV1(input: AccountIntegrityInput): string {
  return createHash("sha256").update(accountIntegrityPreimageV1(input)).digest("hex");
}
