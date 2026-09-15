/**
 * The declared types of the instruction's content contract, version 1
 * (P-06 escalón A, ADR 0093).
 *
 * **Every** type this concept declares: the three unions derived from its own closed
 * vocabularies — which kinds a block may be, which media types a kind admits, which
 * words refuse a content list — and the two inferred from its schemas,
 * `ContentBlock` and `InstructionContent`. Owner law
 * `docs/audit/architecture/index.md` §7.1 puts a resource's type aliases in the
 * resource's type leaf, and that is where all five are; `price-catalog/types/` of
 * P-33/B is the living precedent for the shape.
 *
 * **Why the schemas next door are named `…Schema`.** A value and a type may not share
 * one name across two files: `TS2323` when a module re-exports the leaf's type under
 * its const's name, `TS2300` when a barrel merges a value from one file with a
 * same-named type from another, `TS2440` inside the leaf itself. Those probes are
 * facts about a **merged name**, not about the concept — so the value is renamed,
 * the fusion never arises, and the type lands here where the law puts it. The rename
 * is this concept's alone: the package's 62 historical merged names are untouched
 * (adjudication v3; ADR 0093 Eight).
 *
 * No runtime cycle: this leaf imports only types, and `../index.ts` imports no value
 * from it. A pure type leaf — it declares data and nothing else.
 */

import type { z } from "zod";

import type {
  CONTENT_BLOCK_KINDS,
  CONTENT_BLOCK_REFUSALS,
  CONTENT_MEDIA_TYPES_BY_KIND,
  ContentBlockSchema,
  InstructionContentSchema,
} from "../index.js";

/**
 * What one block of an instruction is (contratos §4.1 `:186`).
 *
 * Closed, version 1. `text` is the one every list must carry; the other four are
 * the modalities the contract names, and naming them is not installing them — a
 * modality a route cannot transport is refused at the preflight, which is
 * escalón C's (the DT's Q4).
 */
export type ContentBlockKind = (typeof CONTENT_BLOCK_KINDS)[number];

/**
 * A media type some kind admits, as the table declares it.
 *
 * Derived from the table rather than restated, so a type added to a kind cannot
 * be admitted by the schema and missing from the union, or the reverse.
 */
export type ContentMediaType = (typeof CONTENT_MEDIA_TYPES_BY_KIND)[ContentBlockKind][number];

/**
 * Why a content list is refused, by name (ADR 0093).
 *
 * `GLOBAL_ASSIGNMENT_REFUSALS`' and `PRICE_TABLE_REFUSALS`' reason: a refusal a caller
 * can branch on has to be a word, not a sentence. Three of the ten span the whole
 * list — a block id twice, no text block at all, and the aggregate over quota — and
 * the rest are facts about one block.
 *
 * Eight of the ten travel at the head of an issue's message. The two the shape itself
 * enforces — `BLOCK_KIND_UNKNOWN` by the closed `kind` enum, `VENDOR_FIELD_PRESENT` by
 * `strictObject` — travel in no message, and surface under zod's own `invalid_value`
 * and `unrecognized_keys`. The union still names them, because the reason is part of
 * the contract whether or not a word carries it; `../index.ts`' docblock records
 * which is which.
 */
export type ContentBlockRefusal = (typeof CONTENT_BLOCK_REFUSALS)[number];

/**
 * One block of an instruction's content, as its schema shapes it (§4.1 `:185-191`).
 *
 * Inferred rather than restated, so the type and the validator cannot disagree about
 * a field: the schema is the single authority on the shape, and this is its shadow.
 */
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * The whole content of one instruction (§4.1 `:181-183`): the version in force and
 * the ordered list.
 *
 * Inferred, for `ContentBlock`'s reason.
 */
export type InstructionContent = z.infer<typeof InstructionContentSchema>;
