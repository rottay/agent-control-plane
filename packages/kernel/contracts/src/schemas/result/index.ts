/**
 * The result of one effect, contract version 1 — frozen (P-07 escalón A, ADR 0097).
 *
 * Contratos §4.2 `:208-219`: an effect's result is its `effect_id`, a `status`, the
 * **ordered list** of output blocks and a usage reference, and `SUCCEEDED` demands a
 * valid, recoverable result. The blocks are the content contract's own blocks
 * (`../content-block/`), not a second shape: §4.1 says "no hay tres formatos por
 * cliente", and a separate output block would be a third.
 *
 * ## What this module is, and the one thing it is not
 *
 * It is the **contract**, and nothing else. No producer assembles a result here, no
 * door records one, and nothing reaches an artifact, an event or a table. Escalón B
 * gives the effect's outcome the result's reference and digest, C delivers output
 * bytes to a private sink, and D assembles and publishes the document. `L-P07A-1`
 * holds that: no production source outside this concept and the package's barrels
 * names the contract until D consumes it.
 *
 * ## How a long answer is represented (adjudication v2, C4)
 *
 * Output text over the inline bound is split into text blocks of at most 4 000
 * characters, up to the list's ceiling of 100 blocks; beyond that it travels as one
 * `document` block by reference. It is **never truncated**: over any bound is a
 * refusal. Choosing between the two is the assembler's rule (escalón D), not this
 * schema's, so a result that carries both text and a document is lawful here.
 *
 * ## What is deliberately absent
 *
 * - No rule that a text block is required: a document-only answer is lawful.
 * - No refinement on a tool result flagged as an error. The operative rule is the
 *   provider's terminal flag, downstream; a `tool_result` output block has no
 *   producer in P-07, so a rule over it would read nothing (C3).
 * - No result bytes and no reference to the response artifact: this document *is*
 *   that artifact's bytes, and B stores its reference and digest.
 */

import { z } from "zod";
import { attachGuards } from "../credential-guards/index.js";
import {
  CONTENT_BLOCK_LIST_MAX,
  CONTENT_REQUEST_AGGREGATE_MAX_BYTES,
  ContentBlockSchema,
} from "../content-block/index.js";

/**
 * **Every** declared type of this concept lives in its own leaf,
 * `./types/index.ts`, and is re-exported here so every importer keeps reading them
 * from this module (owner law §7.1; `content-block`'s precedent). The schema is
 * named `…Schema` for that concept's reason: a value and a type under one name
 * cannot be split across two files (ADR 0093 Eight).
 */
export type { ResultStatus, ResultRefusal, ResultContract } from "./types/index.js";

/** The result contract in force, and only it (§4.2 `:208`). */
export const RESULT_CONTRACT_VERSION = 1;

/**
 * What an effect's result says happened. Closed, version 1.
 *
 * Two words, because a result is recorded only for an effect that reached an
 * answer: `CANCELLED` and `OUTCOME_UNKNOWN` are outcomes of the effect, not of a
 * result, and B refuses a result on either by name (adjudication v2, C2).
 */
export const RESULT_STATUSES = ["SUCCEEDED", "FAILED"] as const;

/**
 * The list's own ceilings, each in the unit of the content constant it aliases:
 * a count for a count, bytes for bytes (C4; the DT's Q-A5).
 *
 * Declared here rather than read off the content contract at each use, so the
 * result list names its bounds itself — and aliased rather than restated, so the
 * two lists cannot drift apart by a number (`INSTRUCTIONS_MAX_CHARS`' precedent).
 */
export const RESULT_BLOCK_LIST_MAX = CONTENT_BLOCK_LIST_MAX;
export const RESULT_AGGREGATE_MAX_BYTES = CONTENT_REQUEST_AGGREGATE_MAX_BYTES;

/**
 * Why a result is refused, by name.
 *
 * Four travel at the head of an issue's message, so a caller can branch on the
 * word rather than on prose: `RESULT_BLOCKS_REQUIRED`, `BLOCK_ID_DUPLICATE`,
 * `AGGREGATE_OVER_QUOTA` and `USAGE_REFERENCE_MISMATCH`.
 *
 * The other two are enforced by the shape itself and travel in no message:
 * `STATUS_UNKNOWN` is the closed `z.enum` on `status` (zod's `invalid_value` at
 * `status`), and `VENDOR_FIELD_PRESENT` is `strictObject` (`unrecognized_keys`).
 * They are listed because the reason is part of the contract, as
 * `CONTENT_BLOCK_REFUSALS` lists its two.
 *
 * A block's own rules — media type against kind, a reference for everything but
 * short text, declared length, per-kind ceiling, a linked tool result — are the
 * content contract's, surface under `blocks.<i>` with its words, and are not
 * restated here.
 */
export const RESULT_REFUSALS = [
  "RESULT_BLOCKS_REQUIRED",
  "BLOCK_ID_DUPLICATE",
  "AGGREGATE_OVER_QUOTA",
  "USAGE_REFERENCE_MISMATCH",
  "STATUS_UNKNOWN",
  "VENDOR_FIELD_PRESENT",
] as const;

/**
 * One effect's result (§4.2 `:210-211`).
 *
 * Every key required and no other admitted. `effectId` carries the content
 * block's own bound for the same identifier. `usageReference` names where the
 * effect's usage is settled, and economy §2.1 settles usage per effect, so it is
 * the effect's id and a refinement says so (C5).
 */
export const ResultContractSchema = z
  .strictObject({
    resultContractVersion: z.literal(RESULT_CONTRACT_VERSION),
    effectId: z.string().min(1).max(200),
    status: z.enum(RESULT_STATUSES),
    /** Ordered: the order in is the order out, and nothing sorts it. */
    blocks: z.array(ContentBlockSchema).max(RESULT_BLOCK_LIST_MAX),
    usageReference: z.string().min(1).max(200),
  })
  .superRefine((value, ctx) => {
    // The usage of an effect is settled under the effect (economy §2.1), so the
    // reference is the effect's id; any other value names another effect's spend.
    if (value.usageReference !== value.effectId) {
      ctx.addIssue({
        code: "custom",
        message: "USAGE_REFERENCE_MISMATCH: a result's usage reference is its own effect id",
        path: ["usageReference"],
      });
    }

    // SUCCEEDED demands a valid, recoverable result (§4.2 `:211`): an effect that
    // answered nothing did not succeed, and says FAILED instead (the DT's Q-A2).
    if (value.status === "SUCCEEDED" && value.blocks.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "RESULT_BLOCKS_REQUIRED: a SUCCEEDED result carries at least one output block",
        path: ["blocks"],
      });
    }

    // A block id names one block of the list, as it does in an instruction.
    const seen = new Set<string>();
    value.blocks.forEach((block, index) => {
      if (seen.has(block.blockId)) {
        ctx.addIssue({
          code: "custom",
          message: "BLOCK_ID_DUPLICATE: a block id names one block of the list",
          path: ["blocks", index, "blockId"],
        });
      }
      seen.add(block.blockId);
    });

    // The aggregate, which every block can satisfy and the list still exceed.
    // Over it is a refusal: a result is never shortened to fit (C4).
    const aggregate = value.blocks.reduce((total, block) => total + block.byteLength, 0);
    if (aggregate > RESULT_AGGREGATE_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message:
          "AGGREGATE_OVER_QUOTA: the output of one result is at most " +
          String(RESULT_AGGREGATE_MAX_BYTES) +
          " bytes in total",
        path: ["blocks"],
      });
    }

    // The package's standing guard, on the content contract's posture.
    attachGuards(value, ctx, { transcript: false });
  });
