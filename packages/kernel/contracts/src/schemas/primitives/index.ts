/**
 * Primitive value shapes — `@acp/contracts` (P8-T G6).
 *
 * The shared zod primitives every other capability composes, plus the two
 * version constants and the one byte measurement.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";

/**
 * The contract version a **producer** writes.
 *
 * One value, always, because a producer that could choose between two versions
 * is a producer whose output nobody can predict. What may hold more than one
 * value is the *reader's* set below.
 */
export const CONTRACT_VERSION = "2.2.0" as const;

/**
 * The contract versions a **reader** accepts (P-18/protocolo A, ADR 0072).
 *
 * Reading and writing are two different questions, and before this constant
 * existed the contract answered both with one `z.literal`. That made the
 * relation symmetric: moving `CONTRACT_VERSION` to a new value would have made
 * every event already recorded under the previous one fail the very schema the
 * ledger re-parses stored rows with — `#rowToRecord`, `#validateRowShape` and
 * `#replay` all run `ControlPlaneEvent.safeParse` over the stored body, so an
 * existing ledger would have become unreadable and its rebuild would have
 * refused. A version bump is not supposed to be a data loss event.
 *
 * So the set is what the reader admits and `CONTRACT_VERSION` is what the
 * producer stamps, and streams §1.1's rule — "la versión de contrato no
 * soportada produce un rechazo o una degradación explícita" — becomes a
 * membership test rather than an equality. Today the set holds exactly one
 * member and the mechanism is inert by construction; that is the point. The
 * escalón that actually moves `CONTRACT_VERSION` inherits an obligation ADR
 * 0072 records and does not get to skip: it must pin the *current* version
 * separately at every admission door, because a set that is right for reading
 * history is wrong for admitting new work.
 *
 * Declared as a non-empty tuple so `z.enum` below types it, and asserted
 * against `CONTRACT_VERSION` by test N-A-1 — a ledger that cannot read what it
 * itself writes is the one failure this pair must never be allowed to reach.
 */
export const SUPPORTED_CONTRACT_VERSIONS = ["2.2.0"] as const;

/**
 * The UTF-8 byte length of a string, browser-safe.
 *
 * `TextEncoder` rather than `Buffer`: this package is the one every other
 * imports, including the browser client, and a `node:` reference here would
 * make the whole contract surface unloadable in a page. The encoder is a
 * platform global in both runtimes, which is what makes one measurement
 * possible at all.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * The reader's admission test: membership in the supported set.
 *
 * `z.enum` rather than `z.literal` for the reason above. With a single member
 * the two are indistinguishable from the outside — same acceptance, same
 * rejection, same `invalid_value` issue, and the same inferred literal type, so
 * no consumer of this symbol moves — and that equivalence is what makes the
 * mechanism safe to land before it is needed.
 */
export const ContractVersion = z.enum(SUPPORTED_CONTRACT_VERSIONS);

export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase sha-256 hex digest");

export const GitCommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "expected a full 40 character git object id");

export const Timestamp = z.iso.datetime({ offset: true });

export const Uuid = z.uuid();

/**
 * A repository relative path. Absolute paths and parent traversal are rejected
 * so a write-set can never escape the worktree it was scoped to.
 */
export const RepoRelativePath = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => !value.startsWith("/"), "path must not be absolute")
  .refine(
    (value) => !/(^|\/)\.\.(\/|$)/.test(value),
    "path must not contain a parent traversal segment",
  )
  .refine((value) => !value.includes("\\"), "path must use forward slashes");

/** An absolute local path, used only for worktree and config roots. */
export const AbsolutePath = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => value.startsWith("/"), "path must be absolute");
