import { describe, expect, it } from "vitest";

import {
  CONTENT_ARTIFACT_MAX_BYTES,
  CONTENT_BLOCK_LIST_MAX,
  CONTENT_INLINE_TEXT_MAX_CHARS,
  CONTENT_REQUEST_AGGREGATE_MAX_BYTES,
  RESULT_AGGREGATE_MAX_BYTES,
  RESULT_BLOCK_LIST_MAX,
  RESULT_CONTRACT_VERSION,
  RESULT_REFUSALS,
  RESULT_STATUSES,
  ResultContractSchema,
  utf8ByteLength,
} from "../../../src/index.js";

/**
 * The result contract, version 1 (P-07 escalón A, ADR 0097).
 *
 * Contratos §4.2 as assertions. Every drill is a parse: this escalón has no producer
 * and no consumer. Every negative departs by one field from a positive control
 * (P1–P4), so a refusal here means the rule bit and not that the fixture was wrong.
 */

const DIGEST = "a".repeat(64);
const EFFECT = "eff-0001";

function textBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = (overrides["text"] as string | undefined) ?? "The answer.";
  return {
    kind: "text",
    blockId: "b1",
    mediaType: "text/plain; charset=utf-8",
    byteLength: utf8ByteLength(text),
    contentSha256: DIGEST,
    artifactRefId: null,
    text,
    toolCallId: null,
    effectId: null,
    ...overrides,
  };
}

/** A markdown document by reference: the shape of an answer beyond the chunk ceiling (C4). */
function documentBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "document",
    blockId: "d1",
    mediaType: "text/markdown; charset=utf-8",
    byteLength: 2_048,
    contentSha256: "b".repeat(64),
    artifactRefId: "ref-response-1",
    text: null,
    toolCallId: null,
    effectId: null,
    ...overrides,
  };
}

function toolResultBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "tool_result",
    blockId: "t1",
    mediaType: "application/json; charset=utf-8",
    byteLength: 64,
    contentSha256: "c".repeat(64),
    artifactRefId: "ref-tool-1",
    text: null,
    toolCallId: "call-1",
    effectId: "eff-tool-1",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resultContractVersion: RESULT_CONTRACT_VERSION,
    effectId: EFFECT,
    status: "SUCCEEDED",
    blocks: [textBlock()],
    usageReference: EFFECT,
    ...overrides,
  };
}

/** The closed refusal words an outcome carries, in the order the issues came. */
function refusals(outcome: { success: boolean; error?: { issues: readonly { message: string }[] } }): string[] {
  expect(outcome.success).toBe(false);
  return (outcome.error?.issues ?? [])
    .map((issue) => /^([A-Z_]+):/.exec(issue.message)?.[1] ?? issue.message)
    .filter((word) => (RESULT_REFUSALS as readonly string[]).includes(word));
}

function paths(outcome: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[] }[] } }): string[] {
  return (outcome.error?.issues ?? []).map((issue) => issue.path.map(String).join("."));
}

function codes(outcome: { success: boolean; error?: { issues: readonly { code: string }[] } }): string[] {
  return (outcome.error?.issues ?? []).map((issue) => issue.code);
}

/** `count` text blocks of `chars` characters each, with distinct ids. */
function chunks(count: number, chars: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) =>
    textBlock({ blockId: "c" + String(index), text: String(index % 10).repeat(chars) }),
  );
}

describe("the positive controls every negative departs from", () => {
  it("P1: SUCCEEDED with one short text block, and the usage reference equal to the effect", () => {
    const parsed = ResultContractSchema.safeParse(result());
    expect(parsed.success).toBe(true);
  });

  it("P2: FAILED with no block at all is admitted", () => {
    expect(ResultContractSchema.safeParse(result({ status: "FAILED", blocks: [] })).success).toBe(true);
  });

  it("P3: SUCCEEDED with one markdown document by reference and no text block is admitted", () => {
    expect(ResultContractSchema.safeParse(result({ blocks: [documentBlock()] })).success).toBe(true);
  });

  it("P4: a hundred text blocks of 4 000 characters are admitted, in the order given", () => {
    const blocks = chunks(RESULT_BLOCK_LIST_MAX, CONTENT_INLINE_TEXT_MAX_CHARS);
    const parsed = ResultContractSchema.safeParse(result({ blocks }));
    expect(parsed.success).toBe(true);
    // The list is ORDERED: the order in is the order out.
    expect(parsed.success ? parsed.data.blocks.map((block) => block.blockId) : null).toEqual(
      blocks.map((block) => block["blockId"]),
    );
  });

  it("P5: the vocabulary is closed and ordered, the version is 1, and each bound aliases its content constant", () => {
    expect(RESULT_CONTRACT_VERSION).toBe(1);
    expect([...RESULT_STATUSES]).toEqual(["SUCCEEDED", "FAILED"]);
    expect([...RESULT_REFUSALS]).toEqual([
      "RESULT_BLOCKS_REQUIRED",
      "BLOCK_ID_DUPLICATE",
      "AGGREGATE_OVER_QUOTA",
      "USAGE_REFERENCE_MISMATCH",
      "STATUS_UNKNOWN",
      "VENDOR_FIELD_PRESENT",
    ]);
    // A count for a count, bytes for bytes: the same constants, not the same numbers.
    expect(RESULT_BLOCK_LIST_MAX).toBe(CONTENT_BLOCK_LIST_MAX);
    expect(RESULT_AGGREGATE_MAX_BYTES).toBe(CONTENT_REQUEST_AGGREGATE_MAX_BYTES);
  });
});

describe("the result's own rules", () => {
  it("N-P07A-1: a status outside the two is refused by the shape, at status", () => {
    for (const status of ["CANCELLED", "OUTCOME_UNKNOWN", ""]) {
      const refused = ResultContractSchema.safeParse(result({ status }));
      expect(refused.success, status).toBe(false);
      expect(codes(refused), status).toContain("invalid_value");
      expect(paths(refused), status).toContain("status");
    }
    for (const status of RESULT_STATUSES) {
      expect(ResultContractSchema.safeParse(result({ status })).success, status).toBe(true);
    }
  });

  it("N-P07A-2: a usage reference other than the effect id is refused by name, and equal is admitted", () => {
    const refused = ResultContractSchema.safeParse(result({ usageReference: "eff-0002" }));
    expect(refusals(refused)).toEqual(["USAGE_REFERENCE_MISMATCH"]);
    expect(paths(refused)).toEqual(["usageReference"]);
    expect(ResultContractSchema.safeParse(result({ usageReference: EFFECT })).success).toBe(true);
  });

  it("N-P07A-3: SUCCEEDED with no block is refused by name, at blocks", () => {
    const refused = ResultContractSchema.safeParse(result({ blocks: [] }));
    expect(refusals(refused)).toEqual(["RESULT_BLOCKS_REQUIRED"]);
    expect(paths(refused)).toEqual(["blocks"]);
  });

  it("N-P07A-4: a hundred and one blocks are refused at blocks, and a hundred are admitted", () => {
    const over = ResultContractSchema.safeParse(result({ blocks: chunks(RESULT_BLOCK_LIST_MAX + 1, 1) }));
    expect(codes(over)).toContain("too_big");
    expect(paths(over)).toContain("blocks");
    expect(ResultContractSchema.safeParse(result({ blocks: chunks(RESULT_BLOCK_LIST_MAX, 1) })).success).toBe(true);
  });

  it("N-P07A-5: the aggregate one byte over is refused, at the bound it is admitted, and the aggregate binds first", () => {
    const half = RESULT_AGGREGATE_MAX_BYTES / 2;
    const text = textBlock();
    const room = half - (text["byteLength"] as number);
    const atBound = [text, documentBlock({ blockId: "x", byteLength: half }), documentBlock({ blockId: "y", byteLength: room })];
    expect(ResultContractSchema.safeParse(result({ blocks: atBound })).success).toBe(true);
    const over = [text, documentBlock({ blockId: "x", byteLength: half }), documentBlock({ blockId: "y", byteLength: room + 1 })];
    const refused = ResultContractSchema.safeParse(result({ blocks: over }));
    expect(refusals(refused)).toEqual(["AGGREGATE_OVER_QUOTA"]);
    expect(paths(refused)).toEqual(["blocks"]);

    // A document exactly at its own ceiling is lawful as a block and, beside a
    // text block, unlawful as a result: the word is the aggregate's, not the
    // block's, which is the evidence that the two rules are independent.
    const atBlockCeiling = ResultContractSchema.safeParse(
      result({ blocks: [textBlock(), documentBlock({ byteLength: CONTENT_ARTIFACT_MAX_BYTES })] }),
    );
    expect(refusals(atBlockCeiling)).toEqual(["AGGREGATE_OVER_QUOTA"]);
  });

  it("N-P07A-6: a duplicate block id is refused by name, at the second block's id", () => {
    const refused = ResultContractSchema.safeParse(
      result({ blocks: [textBlock({ blockId: "same" }), documentBlock({ blockId: "same" })] }),
    );
    expect(refusals(refused)).toEqual(["BLOCK_ID_DUPLICATE"]);
    expect(paths(refused)).toEqual(["blocks.1.blockId"]);
  });
});

describe("the content contract's block rules, inherited under blocks.<i>", () => {
  it("N-P07A-7: a text block of 4 001 characters is refused, never truncated, and 4 000 is admitted", () => {
    const over = "x".repeat(CONTENT_INLINE_TEXT_MAX_CHARS + 1);
    const refused = ResultContractSchema.safeParse(result({ blocks: [textBlock({ text: over })] }));
    expect(refused.success ? "parsed" : "refused").toBe("refused");
    expect(paths(refused)).toContain("blocks.0.text");
    const atBound = "x".repeat(CONTENT_INLINE_TEXT_MAX_CHARS);
    expect(ResultContractSchema.safeParse(result({ blocks: [textBlock({ text: atBound })] })).success).toBe(true);
  });

  it("N-P07A-8: a media type of another kind, a document without a reference, and an unlinked tool result", () => {
    const mismatch = ResultContractSchema.safeParse(result({ blocks: [documentBlock({ mediaType: "image/png" })] }));
    expect(mismatch.success).toBe(false);
    expect(paths(mismatch)).toContain("blocks.0.mediaType");

    const unreferenced = ResultContractSchema.safeParse(result({ blocks: [documentBlock({ artifactRefId: null })] }));
    expect(unreferenced.success).toBe(false);
    expect(paths(unreferenced)).toContain("blocks.0.artifactRefId");

    const unlinked = ResultContractSchema.safeParse(result({ blocks: [toolResultBlock({ effectId: null })] }));
    expect(unlinked.success).toBe(false);
    expect(paths(unlinked)).toContain("blocks.0.toolCallId");

    // Positive control: every one of the five kinds is admitted in a result (Q-A3).
    expect(ResultContractSchema.safeParse(result({ blocks: [toolResultBlock()] })).success).toBe(true);
    for (const [kind, mediaType] of [
      ["image", "image/png"],
      ["audio", "audio/wav"],
      ["document", "application/pdf"],
    ] as const) {
      const block = documentBlock({ kind, mediaType, blockId: "k-" + kind });
      expect(ResultContractSchema.safeParse(result({ blocks: [block] })).success, kind).toBe(true);
    }
  });

  it("N-P07A-9: an undeclared key on the result or on a block is refused, and so is a missing key", () => {
    const onResult = ResultContractSchema.safeParse({ ...result(), vendorExtras: {} });
    expect(codes(onResult)).toContain("unrecognized_keys");
    const onBlock = ResultContractSchema.safeParse(result({ blocks: [textBlock({ anthropicBeta: "yes" })] }));
    expect(codes(onBlock)).toContain("unrecognized_keys");
    for (const key of ["resultContractVersion", "effectId", "status", "blocks", "usageReference"]) {
      const missing = Object.fromEntries(Object.entries(result()).filter(([name]) => name !== key));
      expect(ResultContractSchema.safeParse(missing).success, key).toBe(false);
    }
  });

  it("N-P07A-10: a result contract version other than the one in force is refused", () => {
    expect(ResultContractSchema.safeParse(result({ resultContractVersion: 2 })).success).toBe(false);
    expect(ResultContractSchema.safeParse(result({ resultContractVersion: "1" })).success).toBe(false);
  });

  it("N-P07A-11: an effect id that is empty or over 200 characters is refused", () => {
    for (const effectId of ["", "e".repeat(201)]) {
      expect(ResultContractSchema.safeParse(result({ effectId, usageReference: effectId })).success, String(effectId.length)).toBe(
        false,
      );
    }
    const atBound = "e".repeat(200);
    expect(ResultContractSchema.safeParse(result({ effectId: atBound, usageReference: atBound })).success).toBe(true);
  });

  it("N-P07A-12: credential material in a text block is refused, and the message does not echo it", () => {
    const planted = ResultContractSchema.safeParse(
      result({ blocks: [textBlock({ text: "sk-ant-api03-" + "A".repeat(32) })] }),
    );
    expect(planted.success).toBe(false);
    const messages = planted.success ? [] : planted.error.issues.map((issue) => issue.message);
    expect(messages.some((message) => message.startsWith("credential material is forbidden"))).toBe(true);
    expect(messages.join(" ")).not.toContain("sk-ant-api03");
  });
});
