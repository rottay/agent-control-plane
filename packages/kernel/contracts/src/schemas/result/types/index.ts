/**
 * The declared types of the result contract, version 1 (P-07 escalón A, ADR 0097).
 *
 * **Every** type this concept declares: the two unions derived from its closed
 * vocabularies — what a result says happened, and which words refuse one — and the
 * one inferred from its schema, `ResultContract`. Owner law
 * `docs/audit/architecture/index.md` §7.1 puts a resource's type aliases in the
 * resource's type leaf; `content-block/types/` is the precedent for the shape.
 *
 * No runtime cycle: this leaf imports only types, and `../index.ts` imports no value
 * from it. A pure type leaf — it declares data and nothing else.
 */

import type { z } from "zod";

import type { RESULT_REFUSALS, RESULT_STATUSES, ResultContractSchema } from "../index.js";

/** What an effect's result says happened (§4.2 `:211`). Closed, version 1. */
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/**
 * Why a result is refused, by name (ADR 0097).
 *
 * Four travel at the head of an issue's message; `STATUS_UNKNOWN` and
 * `VENDOR_FIELD_PRESENT` are enforced by the shape and travel in none.
 * `../index.ts`' docblock records which is which.
 */
export type ResultRefusal = (typeof RESULT_REFUSALS)[number];

/**
 * One effect's result, as its schema shapes it (§4.2 `:210-211`).
 *
 * Inferred rather than restated, so the type and the validator cannot disagree about
 * a field.
 */
export type ResultContract = z.infer<typeof ResultContractSchema>;
