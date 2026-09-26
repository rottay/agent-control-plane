import { describe, expect, it } from "vitest";

import {
  CONTENT_ARTIFACT_MAX_BYTES,
  CONTENT_BLOCK_ID_MAX_CHARS,
  CONTENT_BLOCK_KINDS,
  CONTENT_BLOCK_LIST_MAX,
  CONTENT_BLOCK_REFUSALS,
  CONTENT_CONTRACT_VERSION,
  CONTENT_INLINE_TEXT_MAX_CHARS,
  CONTENT_MEDIA_TYPES_BY_KIND,
  CONTENT_METADATA_MAX_BYTES,
  CONTENT_REQUEST_AGGREGATE_MAX_BYTES,
  CONTENT_TOOL_RESULT_MAX_BYTES,
  ContentBlockSchema,
  InstructionContentSchema,
  utf8ByteLength,
} from "../../../src/index.js";

/**
 * The instruction's content contract, version 1 (P-06 escalón A, ADR 0093).
 *
 * Contratos §4.1 as assertions. Every drill is a parse: this escalón has no
 * producer and no consumer, so there is nothing here that could open a file.
 */

const DIGEST = "a".repeat(64);

/** A text block: the one kind that may travel inline and the one every list needs. */
function textBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = (overrides["text"] as string | undefined) ?? "Do the thing.";
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

/** A referenced block: everything that is not short text carries a reference. */
function imageBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "image",
    blockId: "b2",
    mediaType: "image/png",
    byteLength: 2_048,
    contentSha256: "b".repeat(64),
    artifactRefId: "ref-image-1",
    text: null,
    toolCallId: null,
    effectId: null,
    ...overrides,
  };
}

function toolResultBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "tool_result",
    blockId: "b3",
    mediaType: "application/json; charset=utf-8",
    byteLength: 64,
    contentSha256: "c".repeat(64),
    artifactRefId: "ref-tool-1",
    text: null,
    toolCallId: "call-1",
    effectId: "eff-1",
    ...overrides,
  };
}

function content(blocks: readonly unknown[]): Record<string, unknown> {
  return { contentContractVersion: CONTENT_CONTRACT_VERSION, blocks };
}

/** The closed refusal words an outcome carries, in the order the issues came. */
function refusals(result: { success: boolean; error?: { issues: readonly { message: string }[] } }): string[] {
  expect(result.success).toBe(false);
  return (result.error?.issues ?? [])
    .map((issue) => /^([A-Z_]+):/.exec(issue.message)?.[1] ?? issue.message)
    .filter((word) => (CONTENT_BLOCK_REFUSALS as readonly string[]).includes(word));
}

describe("the contract is one closed shape, version 1", () => {
  it("names its version, its kinds and its refusals, in order, and carries no others", () => {
    expect(CONTENT_CONTRACT_VERSION).toBe(1);
    expect([...CONTENT_BLOCK_KINDS]).toEqual(["text", "image", "audio", "document", "tool_result"]);
    expect([...CONTENT_BLOCK_REFUSALS]).toEqual([
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
    ]);
  });

  it("Q1: the inline text bound names the policy a real door already applied", () => {
    // Not a second policy: the bound `TaskEnvelope.objective` carried,
    // min(1).max(4_000), until P-16/A1 retired the field (ADR 0120).
    expect(CONTENT_INLINE_TEXT_MAX_CHARS).toBe(4_000);
    expect(CONTENT_BLOCK_ID_MAX_CHARS).toBe(200);
  });

  it("carries the profile's ceilings with their unit in the name (tests §9.5)", () => {
    expect(CONTENT_ARTIFACT_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(CONTENT_METADATA_MAX_BYTES).toBe(256 * 1024);
    expect(CONTENT_TOOL_RESULT_MAX_BYTES).toBe(1024 * 1024);
    expect(CONTENT_REQUEST_AGGREGATE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(CONTENT_BLOCK_LIST_MAX).toBe(100);
  });

  it("admits a lawful list of all three shapes: the positive control for everything below", () => {
    const parsed = InstructionContentSchema.safeParse(content([textBlock(), imageBlock(), toolResultBlock()]));
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.blocks.map((block) => block.kind) : null).toEqual([
      "text",
      "image",
      "tool_result",
    ]);
    // The list is ORDERED: the order in is the order out.
    expect(parsed.success ? parsed.data.blocks.map((block) => block.blockId) : null).toEqual(["b1", "b2", "b3"]);
  });

  it("admits every kind the vocabulary names, each with a media type its class admits", () => {
    for (const kind of CONTENT_BLOCK_KINDS) {
      if (kind === "text") continue;
      const mediaType = CONTENT_MEDIA_TYPES_BY_KIND[kind][0];
      const block =
        kind === "tool_result"
          ? toolResultBlock({ mediaType })
          : imageBlock({ kind, mediaType, blockId: "b-" + kind });
      expect(InstructionContentSchema.safeParse(content([textBlock(), block])).success, kind).toBe(true);
    }
  });
});

describe("N-P06-1: a kind outside the five is refused", () => {
  it("refuses an unknown kind, and admits each of the five", () => {
    const bad = InstructionContentSchema.safeParse(content([textBlock(), imageBlock({ kind: "video" })]));
    expect(bad.success).toBe(false);
    // The enum refuses before any refinement runs, so BLOCK_KIND_UNKNOWN travels in
    // no message: the reason is pinned by the code and the path zod produces, which
    // is what keeps it checkable without an error map (ADR 0093 Six).
    expect(bad.success ? [] : bad.error.issues.map((issue) => issue.code)).toContain("invalid_value");
    expect(bad.success ? [] : bad.error.issues.map((issue) => issue.path.join("."))).toContain("blocks.1.kind");
    for (const kind of CONTENT_BLOCK_KINDS) {
      expect(ContentBlockSchema.safeParse(kind === "text" ? textBlock() : kind === "tool_result" ? toolResultBlock() : imageBlock({ kind, mediaType: CONTENT_MEDIA_TYPES_BY_KIND[kind][0] })).success, kind).toBe(true);
    }
  });
});

describe("N-P06-2: a block id names one block of the list", () => {
  it("refuses a duplicate block id by name, and admits two distinct ids", () => {
    const clash = InstructionContentSchema.safeParse(content([textBlock({ blockId: "same" }), imageBlock({ blockId: "same" })]));
    expect(refusals(clash)).toEqual(["BLOCK_ID_DUPLICATE"]);
    expect(clash.success ? [] : clash.error.issues.map((issue) => issue.path.join("."))).toContain("blocks.1.blockId");
    expect(InstructionContentSchema.safeParse(content([textBlock({ blockId: "a" }), imageBlock({ blockId: "b" })])).success).toBe(true);
  });
});

describe("N-P06-3: only short text travels without an authorized reference", () => {
  it("refuses a non-text block with no reference, and admits short text with none", () => {
    expect(refusals(InstructionContentSchema.safeParse(content([textBlock(), imageBlock({ artifactRefId: null })])))).toEqual([
      "REFERENCE_REQUIRED",
    ]);
    // Positive control, both directions: text without a reference is lawful, and
    // text WITH one is lawful too — a short text may also be an artifact.
    expect(InstructionContentSchema.safeParse(content([textBlock({ artifactRefId: null })])).success).toBe(true);
    expect(InstructionContentSchema.safeParse(content([textBlock({ artifactRefId: "ref-text-1" })])).success).toBe(true);
  });

  it("keeps inline content on text alone: a referenced kind may not carry text", () => {
    // Two rules bite at once, and both should: the kind may not carry text, and
    // its declared length is no longer the length of the text it now carries.
    expect(refusals(InstructionContentSchema.safeParse(content([textBlock(), imageBlock({ text: "smuggled" })])))).toEqual([
      "REFERENCE_REQUIRED",
      "BYTE_LENGTH_MISMATCH",
    ]);
    // And a text block with no text is not a text block.
    expect(refusals(InstructionContentSchema.safeParse(content([textBlock({ text: null, byteLength: 0 })])))).toContain(
      "REFERENCE_REQUIRED",
    );
  });

  it("refuses inline text over the Q1 bound, and admits it exactly at the bound", () => {
    const atBound = "x".repeat(CONTENT_INLINE_TEXT_MAX_CHARS);
    expect(InstructionContentSchema.safeParse(content([textBlock({ text: atBound, byteLength: utf8ByteLength(atBound) })])).success).toBe(true);
    const over = "x".repeat(CONTENT_INLINE_TEXT_MAX_CHARS + 1);
    const refused = InstructionContentSchema.safeParse(content([textBlock({ text: over, byteLength: utf8ByteLength(over) })]));
    expect(refused.success).toBe(false);
    // Refused, never shortened: the parsed value does not exist at all.
    expect(refused.success ? "parsed" : "refused").toBe("refused");
  });
});

describe("N-P06-4: a media type is validated against the class", () => {
  it("refuses a correct media type belonging to another kind, and admits each kind's own", () => {
    // `image/png` is a real media type and the wrong one for audio.
    expect(refusals(InstructionContentSchema.safeParse(content([textBlock(), imageBlock({ kind: "audio", mediaType: "image/png" })])))).toEqual([
      "MEDIA_TYPE_MISMATCH",
    ]);
    expect(refusals(InstructionContentSchema.safeParse(content([textBlock({ mediaType: "application/pdf" })])))).toEqual([
      "MEDIA_TYPE_MISMATCH",
    ]);
    for (const mediaType of CONTENT_MEDIA_TYPES_BY_KIND.image) {
      expect(InstructionContentSchema.safeParse(content([textBlock(), imageBlock({ mediaType })])).success, mediaType).toBe(true);
    }
  });
});

describe("N-P06-5: a declared length is the real one, and over the profile is a refusal", () => {
  it("refuses a declared length that is not the length of its inline bytes", () => {
    expect(refusals(InstructionContentSchema.safeParse(content([textBlock({ text: "four", byteLength: 99 })])))).toEqual([
      "BYTE_LENGTH_MISMATCH",
    ]);
    // Positive control, and a multi-byte character: the measure is UTF-8 bytes,
    // not characters, so a naive length check would pass this wrongly.
    const multibyte = "sección";
    expect(utf8ByteLength(multibyte)).toBe(8);
    expect(InstructionContentSchema.safeParse(content([textBlock({ text: multibyte, byteLength: 8 })])).success).toBe(true);
    expect(refusals(InstructionContentSchema.safeParse(content([textBlock({ text: multibyte, byteLength: 7 })])))).toEqual([
      "BYTE_LENGTH_MISMATCH",
    ]);
  });

  it("refuses over a kind's ceiling and admits exactly at it, never truncating", () => {
    // Read on `tool_result`, whose ceiling (1 MiB) is well inside the request
    // aggregate, so the block rule is the only one that can bite.
    const ceiling = CONTENT_TOOL_RESULT_MAX_BYTES;
    expect(InstructionContentSchema.safeParse(content([textBlock(), toolResultBlock({ byteLength: ceiling })])).success).toBe(true);
    const over = InstructionContentSchema.safeParse(content([textBlock(), toolResultBlock({ byteLength: ceiling + 1 })]));
    expect(refusals(over)).toEqual(["BYTE_LENGTH_OVER_PROFILE"]);
    // Nothing came back clamped to the ceiling: the whole parse failed.
    expect(over.success).toBe(false);
  });

  it("the per-block ceiling and the request aggregate are different rules, and the aggregate binds first", () => {
    // An artifact exactly at its own 8 MiB ceiling is lawful as a block and
    // unlawful as a request, because the mandatory text block pushes the total
    // past the 8 MiB aggregate. So the word is AGGREGATE_OVER_QUOTA and not
    // BYTE_LENGTH_OVER_PROFILE: which rule refused is itself the evidence that
    // the two are independent (E8: refused even though every block fits).
    const atBlockCeiling = InstructionContentSchema.safeParse(
      content([textBlock(), imageBlock({ byteLength: CONTENT_ARTIFACT_MAX_BYTES })]),
    );
    expect(refusals(atBlockCeiling)).toEqual(["AGGREGATE_OVER_QUOTA"]);
    // The same block alone, one byte over its own ceiling, is refused by the
    // block rule instead — both words are reachable, on the same block.
    expect(
      refusals(InstructionContentSchema.safeParse(content([textBlock(), imageBlock({ byteLength: CONTENT_ARTIFACT_MAX_BYTES + 1 })]))),
    ).toEqual(["BYTE_LENGTH_OVER_PROFILE", "AGGREGATE_OVER_QUOTA"]);
  });
});

describe("N-P06-6: the aggregate is refused even when every block fits", () => {
  it("refuses a list whose total exceeds the quota, and admits one exactly at it", () => {
    // Two blocks, each well inside the per-block ceiling, together over the quota.
    const half = CONTENT_REQUEST_AGGREGATE_MAX_BYTES / 2;
    const text = textBlock();
    const room = half - (text["byteLength"] as number);
    const under = InstructionContentSchema.safeParse(
      content([text, imageBlock({ blockId: "x", byteLength: half }), imageBlock({ blockId: "y", byteLength: room })]),
    );
    // Exactly at the quota: the sum is the ceiling, and the ceiling is admitted.
    expect(under.success).toBe(true);
    const over = InstructionContentSchema.safeParse(
      content([textBlock(), imageBlock({ blockId: "x", byteLength: half }), imageBlock({ blockId: "y", byteLength: half })]),
    );
    expect(refusals(over)).toEqual(["AGGREGATE_OVER_QUOTA"]);
    // And the boundary is pinned to the byte: one more than the quota is
    // refused, which is what makes the rule a ceiling rather than a hint.
    expect(
      refusals(InstructionContentSchema.safeParse(content([text, imageBlock({ blockId: "x", byteLength: half }), imageBlock({ blockId: "y", byteLength: room + 1 })]))),
    ).toEqual(["AGGREGATE_OVER_QUOTA"]);
    // Each block on its own is lawful: the refusal is a fact about the list.
    expect(InstructionContentSchema.safeParse(content([textBlock(), imageBlock({ byteLength: half })])).success).toBe(true);
  });

  it("refuses a list longer than the ceiling, and admits one exactly at it", () => {
    const many = (count: number): unknown[] =>
      Array.from({ length: count }, (_, index) =>
        index === 0 ? textBlock({ blockId: "b0", byteLength: 1, text: "x" }) : imageBlock({ blockId: "b" + String(index), byteLength: 1 }),
      );
    expect(InstructionContentSchema.safeParse(content(many(CONTENT_BLOCK_LIST_MAX))).success).toBe(true);
    expect(InstructionContentSchema.safeParse(content(many(CONTENT_BLOCK_LIST_MAX + 1))).success).toBe(false);
  });
});

describe("N-P06-7: a vendor field is refused by the shape itself", () => {
  it("refuses an undeclared key on a block and on the content, without a scan", () => {
    const onBlock = InstructionContentSchema.safeParse(content([textBlock({ anthropicBeta: "yes" })]));
    expect(onBlock.success).toBe(false);
    // VENDOR_FIELD_PRESENT travels in no message either: strictObject refuses it, and
    // the reason is pinned by zod's code and the keys it names (ADR 0093 Six).
    expect(onBlock.success ? [] : onBlock.error.issues.map((issue) => issue.code)).toContain("unrecognized_keys");
    const onContent = InstructionContentSchema.safeParse({ ...content([textBlock()]), vendorExtras: {} });
    expect(onContent.success).toBe(false);
    // Positive control: exactly the declared keys parse.
    expect(InstructionContentSchema.safeParse(content([textBlock()])).success).toBe(true);
  });

  it("refuses a content contract version other than the one in force", () => {
    expect(InstructionContentSchema.safeParse({ contentContractVersion: 2, blocks: [textBlock()] }).success).toBe(false);
    expect(InstructionContentSchema.safeParse({ blocks: [textBlock()] }).success).toBe(false);
  });
});

describe("N-P06-8: the list is not empty, and the text is obligatory", () => {
  it("refuses an empty list, and refuses a list with no text block", () => {
    expect(InstructionContentSchema.safeParse(content([])).success).toBe(false);
    expect(refusals(InstructionContentSchema.safeParse(content([imageBlock()])))).toEqual(["TEXT_BLOCK_REQUIRED"]);
    expect(refusals(InstructionContentSchema.safeParse(content([imageBlock(), toolResultBlock()])))).toEqual([
      "TEXT_BLOCK_REQUIRED",
    ]);
    // Positive control: one text block is enough, and it may be the only one.
    expect(InstructionContentSchema.safeParse(content([textBlock()])).success).toBe(true);
  });
});

describe("N-P06-16: a tool_result names its tool call and its effect", () => {
  it("refuses a tool_result missing either link, and refuses another kind carrying them", () => {
    for (const missing of [{ toolCallId: null }, { effectId: null }]) {
      expect(refusals(InstructionContentSchema.safeParse(content([textBlock(), toolResultBlock(missing)]))), JSON.stringify(missing)).toEqual([
        "TOOL_RESULT_UNLINKED",
      ]);
    }
    expect(refusals(InstructionContentSchema.safeParse(content([textBlock(), imageBlock({ toolCallId: "call-1", effectId: "eff-1" })])))).toEqual([
      "TOOL_RESULT_UNLINKED",
    ]);
    expect(InstructionContentSchema.safeParse(content([textBlock(), toolResultBlock()])).success).toBe(true);
  });
});

describe("the package's standing credential guard reaches the content", () => {
  it("refuses credential material in a block, and says so without echoing it", () => {
    const planted = InstructionContentSchema.safeParse(content([textBlock({ text: "sk-ant-api03-" + "A".repeat(32) })]));
    expect(planted.success).toBe(false);
    const messages = planted.success ? [] : planted.error.issues.map((issue) => issue.message);
    expect(messages.some((message) => message.startsWith("credential material is forbidden"))).toBe(true);
    expect(messages.join(" ")).not.toContain("sk-ant-api03");
  });
});
