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

export const CONTRACT_VERSION = "2.2.0" as const;

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

export const ContractVersion = z.literal(CONTRACT_VERSION);

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
