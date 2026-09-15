/**
 * The instruction's content, contract version 1 — frozen (P-06 escalón A, ADR 0093).
 *
 * Contratos §4.1 `:181-206`: the request carries **content**, not only
 * identifiers, and the content is **one ordered list of discriminated blocks**.
 * "No hay tres formatos por cliente": this is the single shape CLI, API and local
 * all speak, and the reason it lives in this package is that every one of them
 * has to agree on it without redeclaring it.
 *
 * ## What this module is, and the one thing it is not
 *
 * It is the **contract**, and nothing else. No producer builds a list here, no
 * consumer resolves one, and nothing reaches an artifact, an event or a
 * transport. Escalón B puts the content in `TaskEnvelope` and publishes it from
 * the two real doors; escalón C resolves the references on the private side of
 * the adapter boundary and composes what crosses. `L-P06A-1` holds that: no
 * production source outside this concept and this package's barrel names the
 * contract until B consumes it, which is the same inertness `price-catalog` was
 * landed under in P-33/B and for the same reason — a caller today would compose
 * an instruction no door validates.
 *
 * ## Why the shape is closed at every level
 *
 * A block is `z.strictObject`, so a drifting producer fails closed rather than
 * smuggling a vendor field into an instruction (§4.1 `:205-206`: the fields of a
 * variant are declared strictly and **without vendor fields**). The list is
 * checked across its rows for the three things no per-row rule can see: a block
 * id used twice, a list with no text at all, and an aggregate that exceeds the
 * quota even though every block fits.
 *
 * ## What stays out, by law rather than by omission
 *
 * **Inline bytes.** §4.1 `:199-201` puts inline data on the private side of the
 * adapter boundary only, after the reference is resolved and validated, and
 * **never** in an event, the public stream or a trace. So a block that is not
 * short text carries a *reference* and a digest, not content: `artifactRefId` is
 * how the bytes are reached, and reaching them is authorized elsewhere (artifacts
 * §2; `envelope_artifact_reference_id` in execution `:112` states the same rule
 * for the envelope — knowing a digest grants nothing).
 *
 * **Truncation.** Over a bound is a refusal, never a shortened instruction. The
 * precedent is literal and one boundary away: `ExecutionRequest.instructions`
 * refuses over its bound because "an adapter that shortened an instruction would
 * be inventing a policy about what the model was asked".
 */

import { z } from "zod";
import { attachGuards } from "../credential-guards/index.js";
import { Sha256Hex, utf8ByteLength } from "../primitives/index.js";

/**
 * **Every** declared type of this concept lives in its own leaf,
 * `./types/index.ts`, and is re-exported here so every importer keeps reading them
 * from this module (owner law §7.1; `price-catalog`'s precedent). That includes the
 * two inferred types, which is why the schemas below are named `…Schema`: a value and
 * a type under one name cannot be split across two files, so the value is renamed and
 * the fusion simply does not arise. The rename is this concept's alone — the
 * package's 62 historical merged names are untouched, and this is not a general
 * reform (ADR 0093 Eight, adjudication v3).
 */
export type {
  ContentBlockKind,
  ContentMediaType,
  ContentBlockRefusal,
  ContentBlock,
  InstructionContent,
} from "./types/index.js";

/** The content contract in force, and only it (§4.1 `:181`). */
export const CONTENT_CONTRACT_VERSION = 1;

/** What a block may be. Closed, version 1 (§4.1 `:186`). */
export const CONTENT_BLOCK_KINDS = ["text", "image", "audio", "document", "tool_result"] as const;

/**
 * The media types each kind admits (§4.1 `:189`: declared, and **validated
 * against the class**).
 *
 * A table rather than a free string, because "validated against the class" is a
 * relation and not a format: `image/png` is a correct media type and a wrong one
 * for an `audio` block. Keeping it as data means the schema and the derived union
 * cannot disagree about which pairs exist.
 */
export const CONTENT_MEDIA_TYPES_BY_KIND = {
  text: ["text/plain; charset=utf-8"],
  image: ["image/png", "image/jpeg", "image/webp"],
  audio: ["audio/wav", "audio/mpeg"],
  document: ["application/pdf", "text/markdown; charset=utf-8"],
  tool_result: ["application/json; charset=utf-8", "text/plain; charset=utf-8"],
} as const;

/**
 * How much text may travel inline, in characters (the DT's Q1).
 *
 * §4.1 `:188` makes `artifact_ref_id` obligatory "para todo lo que no sea texto
 * corto" and does not give the number. This is that number, and it deliberately
 * **names a policy that already exists** rather than inventing a second one:
 * `TaskEnvelope.objective` and `ExecutionRequest.instructions` both carry
 * `min(1).max(4_000)`, so text that passed a real door passes this bound too.
 */
export const CONTENT_INLINE_TEXT_MAX_CHARS = 4_000;

/** A block id's bound, in characters. `conflictKeys`' bound, for its reason. */
export const CONTENT_BLOCK_ID_MAX_CHARS = 200;

/**
 * The profile's ceilings, in bytes ([tests §9.5](../../../../../../docs/audit/quality/testing/index.md)).
 *
 * Each with its unit in the name, as structure §4.2 requires of a limit. Tests
 * §9.6 rule 1 governs where they meet code: if a policy already in force is more
 * restrictive than one of these numbers, **the policy in force wins** — which is
 * why the inline text bound above is 4.000 characters and not the 256 KiB a
 * metadata request may carry.
 */
export const CONTENT_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const CONTENT_METADATA_MAX_BYTES = 256 * 1024;
export const CONTENT_TOOL_RESULT_MAX_BYTES = 1024 * 1024;

/**
 * The ceiling on a whole request's content, in bytes (§4.1 `:196-197`).
 *
 * "El **agregado del pedido** no puede superar la cuota del contrato admitido."
 * A separate rule from the per-block ceilings, and it has to be: a hundred blocks
 * of eight mebibytes each all fit individually.
 */
export const CONTENT_REQUEST_AGGREGATE_MAX_BYTES = 8 * 1024 * 1024;

/** How many blocks one instruction may carry, so the aggregate stays checkable. */
export const CONTENT_BLOCK_LIST_MAX = 100;

/**
 * Why a content list is refused, by name (ADR 0093).
 *
 * Closed, on `GLOBAL_ASSIGNMENT_REFUSALS`' and `PRICE_TABLE_REFUSALS`' shape. **Eight
 * of the ten travel at the head of an issue's message**, so a caller branches on a
 * word rather than on prose: `BLOCK_ID_DUPLICATE`, `REFERENCE_REQUIRED`,
 * `MEDIA_TYPE_MISMATCH`, `BYTE_LENGTH_MISMATCH`, `BYTE_LENGTH_OVER_PROFILE`,
 * `AGGREGATE_OVER_QUOTA`, `TEXT_BLOCK_REQUIRED` and `TOOL_RESULT_UNLINKED`.
 *
 * **The other two are enforced by the shape itself, and their word travels in no
 * message at all.** `BLOCK_KIND_UNKNOWN` is the closed `z.enum` on `kind`, which
 * surfaces as zod's own `invalid_value` at `blocks.<i>.kind`; `VENDOR_FIELD_PRESENT`
 * is `strictObject`, which surfaces as `unrecognized_keys` at `blocks.<i>` with the
 * offending keys named. They are listed here because the **reason** is part of the
 * contract and stays pinned by the vocabulary — a reader learns that an unknown kind
 * and a vendor field are refused, and by what — not because a message carries the
 * word. No error map translates them: zod's codes are already precise about which
 * rule refused, and there is no caller yet whose branching could want otherwise.
 */
export const CONTENT_BLOCK_REFUSALS = [
  "BLOCK_KIND_UNKNOWN",
  "BLOCK_ID_DUPLICATE",
  "REFERENCE_REQUIRED",
  "MEDIA_TYPE_MISMATCH",
  "BYTE_LENGTH_MISMATCH",
  "BYTE_LENGTH_OVER_PROFILE",
  "AGGREGATE_OVER_QUOTA",
  "VENDOR_FIELD_PRESENT",
  "TEXT_BLOCK_REQUIRED",
  "TOOL_RESULT_UNLINKED",
] as const;

/** A block id: stable within the list, and what lets a block be referenced (§4.1 `:187`). */
const ContentBlockId = z.string().min(1).max(CONTENT_BLOCK_ID_MAX_CHARS);

/** The per-kind ceiling a block's declared length is held to. */
function ceilingFor(kind: (typeof CONTENT_BLOCK_KINDS)[number]): number {
  if (kind === "tool_result") return CONTENT_TOOL_RESULT_MAX_BYTES;
  if (kind === "text") return CONTENT_METADATA_MAX_BYTES;
  return CONTENT_ARTIFACT_MAX_BYTES;
}

/**
 * One block of an instruction's content (§4.1 `:185-191`).
 *
 * `…Schema` because the inferred type `ContentBlock` is declared in this concept's
 * type leaf, where owner law §7.1 puts it, and a value and a type may not share a
 * name across two files.
 *
 * Every key required and no other admitted, so a variant's own fields are
 * declared strictly and a vendor field is refused by the shape itself rather than
 * by a scan (§4.1 `:205-206`). `text` carries its characters; `toolCallId` and
 * `effectId` link a `tool_result` to the call and the effect it answers (§4.1
 * `:204`); both are `null` on the kinds they do not belong to, present rather
 * than absent, on `effectiveTo`'s precedent — a key that is sometimes missing is
 * a key two readers disagree about.
 */
export const ContentBlockSchema = z
  .strictObject({
    kind: z.enum(CONTENT_BLOCK_KINDS),
    blockId: ContentBlockId,
    mediaType: z.string().min(1).max(200),
    byteLength: z.number().int().nonnegative(),
    contentSha256: Sha256Hex,
    /** The authorized reference the bytes are reached through. Null only for short text. */
    artifactRefId: z.string().min(1).max(200).nullable(),
    /** Present on `text` alone, and the only place content travels inline. */
    text: z.string().min(1).max(CONTENT_INLINE_TEXT_MAX_CHARS).nullable(),
    /** The tool call a `tool_result` answers. Null on every other kind. */
    toolCallId: z.string().min(1).max(200).nullable(),
    /** The effect a `tool_result` answers. Null on every other kind. */
    effectId: z.string().min(1).max(200).nullable(),
  })
  .superRefine((value, ctx) => {
    // The media type is validated against the CLASS, not against a format: a
    // correct type for another kind is wrong here (§4.1 `:189`).
    const admitted: readonly string[] = CONTENT_MEDIA_TYPES_BY_KIND[value.kind];
    if (!admitted.includes(value.mediaType)) {
      ctx.addIssue({
        code: "custom",
        message: "MEDIA_TYPE_MISMATCH: a " + value.kind + " block declares one of " + admitted.join(", "),
        path: ["mediaType"],
      });
    }

    // `text` belongs to `text` blocks and to no other, and a text block has it:
    // the field is where inline content is allowed to exist at all.
    if ((value.kind === "text") !== (value.text !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "REFERENCE_REQUIRED: text travels inline on a text block, and on no other kind",
        path: ["text"],
      });
    }

    // Everything that is not short text carries an authorized reference (§4.1
    // `:188`). A text block may omit it, because its bytes are already here.
    if (value.kind !== "text" && value.artifactRefId === null) {
      ctx.addIssue({
        code: "custom",
        message: "REFERENCE_REQUIRED: only short text travels without an authorized reference",
        path: ["artifactRefId"],
      });
    }

    // The declared length is the real one for inline text, and within the
    // profile's ceiling for every kind. Over the ceiling is a REFUSAL: an
    // instruction is never shortened to fit.
    if (value.text !== null && value.byteLength !== utf8ByteLength(value.text)) {
      ctx.addIssue({
        code: "custom",
        message: "BYTE_LENGTH_MISMATCH: a declared length is the length of the bytes it describes",
        path: ["byteLength"],
      });
    }
    const ceiling = ceilingFor(value.kind);
    if (value.byteLength > ceiling) {
      ctx.addIssue({
        code: "custom",
        message:
          "BYTE_LENGTH_OVER_PROFILE: a " + value.kind + " block is at most " + String(ceiling) + " bytes",
        path: ["byteLength"],
      });
    }

    // A tool result names the call and the effect it answers; no other kind may.
    const linked = value.toolCallId !== null && value.effectId !== null;
    const unlinked = value.toolCallId === null && value.effectId === null;
    if (value.kind === "tool_result" ? !linked : !unlinked) {
      ctx.addIssue({
        code: "custom",
        message: "TOOL_RESULT_UNLINKED: a tool_result names its tool call and its effect, and no other kind does",
        path: ["toolCallId"],
      });
    }
  });

/**
 * The whole content of one instruction (§4.1 `:181-183`).
 *
 * `…Schema` for `ContentBlockSchema`'s reason: the inferred `InstructionContent` is
 * declared in the type leaf.
 *
 * One ordered list, one version, and nothing else. The three rules below are the
 * ones no per-block check can see, which is why they live on the list.
 */
export const InstructionContentSchema = z
  .strictObject({
    contentContractVersion: z.literal(CONTENT_CONTRACT_VERSION),
    blocks: z.array(ContentBlockSchema).min(1).max(CONTENT_BLOCK_LIST_MAX),
  })
  .superRefine((value, ctx) => {
    // A block id is stable within the list and lets a block be referenced, so
    // two blocks under one id make the reference ambiguous (§4.1 `:187`).
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

    // The text is obligatory (§4.1 `:202-203`). A list of attachments with
    // nothing said is not an instruction.
    if (!value.blocks.some((block) => block.kind === "text")) {
      ctx.addIssue({
        code: "custom",
        message: "TEXT_BLOCK_REQUIRED: an instruction says something; at least one block is text",
        path: ["blocks"],
      });
    }

    // And the aggregate, which every block can satisfy individually and the
    // request still exceed (§4.1 `:196-197`).
    const aggregate = value.blocks.reduce((total, block) => total + block.byteLength, 0);
    if (aggregate > CONTENT_REQUEST_AGGREGATE_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message:
          "AGGREGATE_OVER_QUOTA: the content of one request is at most " +
          String(CONTENT_REQUEST_AGGREGATE_MAX_BYTES) +
          " bytes in total",
        path: ["blocks"],
      });
    }

    // The package's standing guard, on the shape every other contract attaches
    // it to: a credential-shaped key or value anywhere in the tree fails closed.
    attachGuards(value, ctx, { transcript: false });
  });
