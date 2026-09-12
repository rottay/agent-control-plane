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
export const CONTRACT_VERSION = "2.3.0" as const;

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
 *
 * **The set holds two members from P-18/protocolo C (ADR 0076).** That escalón
 * is the one that moved `CONTRACT_VERSION`, because its three event types
 * record durable meaning no earlier reader can reconstruct — digests the fold
 * verifies and a per-payload request contract version. `"2.2.0"` stays here for
 * ever: every event any earlier build recorded carries it, and a set that
 * dropped it would make a routine upgrade a data loss event. That is the whole
 * reason this constant exists, and the bump is the first time it does anything.
 */
export const SUPPORTED_CONTRACT_VERSIONS = ["2.2.0", "2.3.0"] as const;

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

/**
 * The **issuer's** admission test: equality with the version in force.
 *
 * The obligation ADR 0072 wrote down and P-18/protocolo C pays (ADR 0076). A
 * set that is right for reading history is wrong for admitting new work: once
 * `SUPPORTED_CONTRACT_VERSIONS` holds two members, `ContractVersion` alone
 * would let a producer choose which version to stamp, and a producer that could
 * choose between two versions is a producer whose output nobody can predict —
 * the sentence `CONTRACT_VERSION` opens with. So the rule is **only the version
 * in force is emitted**, and this is what states it.
 *
 * **Where it goes, and where it deliberately does not.** It goes on the three
 * shapes ADR 0072 named — `TaskEnvelope`, `WorkerSlot`,
 * `CommitAuthorizationReceipt` — and at the ledger's append door for a new
 * insertion. Those four are instruments of *new work*: an envelope is issued
 * now, a slot is registered now, a receipt authorizes a commit now, an append
 * records something that just happened. None of them is a cohort of stored
 * history anyone re-parses.
 *
 * It does **not** go on `ControlPlaneEvent`, and that is the whole distinction.
 * That schema is what the ledger re-parses over every stored row in
 * `#rowToRecord`, `#validateRowShape` and `#replay`; pinning the current
 * version there would be the exact symmetry ADR 0072 removed, one version later.
 * The read set governs reading, this governs issuing, and the ledger separates
 * the two by *when* rather than by *what*: a brand new insertion is held to this
 * literal, and an exact replay of a row already recorded is exempt, because
 * refusing a producer's honest retry after an upgrade would turn an idempotent
 * append into a failure.
 */
export const AdmittedContractVersion = z.literal(CONTRACT_VERSION);

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
