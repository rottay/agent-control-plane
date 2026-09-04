import { describe, expect, it } from "vitest";

import type { WorkerIdentityString } from "@acp/contracts";

import { TOOL_TRANSPORT_UNRESOLVED } from "../../src/contract/index.js";
import { toolReceipt, toolResultIsUnsafe } from "../../src/receipt/index.js";
import type { ToolReceiptInput } from "../../src/receipt/index.js";

const IDENTITY = "claude/opus/implementer/01" as WorkerIdentityString;

const base: ToolReceiptInput = {
  sessionId: "task-1/1/acct-1",
  serverId: "docs",
  toolName: "docs.search",
  transport: "STDIO",
  identity: IDENTITY,
  refusal: null,
  argumentBytes: 12,
  resultBytes: 34,
  contentBlocks: 2,
};

/** Every name a receipt may carry, and the whole set of them. */
const MEMBERS = [
  "argumentBytes",
  "contentBlocks",
  "identity",
  "outcome",
  "refusal",
  "resultBytes",
  "serverId",
  "sessionId",
  "toolName",
  "transport",
];

describe("the receipt shape is closed", () => {
  it("carries exactly ten members, and these ten", () => {
    expect(Object.keys(toolReceipt(base)).sort()).toEqual(MEMBERS);
  });

  it("names nothing a payload could travel in", () => {
    // The fence pins this by parsing the interface; asserting it here as well
    // means the runtime object and the declared type cannot drift apart
    // silently.
    for (const forbidden of [
      "arguments",
      "result",
      "content",
      "text",
      "prompt",
      "token",
      "secret",
      "key",
      "env",
    ]) {
      expect(MEMBERS).not.toContain(forbidden);
    }
  });

  it("reads no clock, so the same call yields the same receipt", () => {
    // This is what the clocklessness buys: equality, rather than field-picking
    // around a moving value.
    expect(toolReceipt(base)).toEqual(toolReceipt(base));
  });
});

describe("a refusal gets a receipt too", () => {
  it("records the refusal by name and marks the outcome refused", () => {
    const receipt = toolReceipt({ ...base, refusal: "TOOL_NOT_ALLOWED" });
    expect(receipt.outcome).toBe("REFUSED");
    expect(receipt.refusal).toBe("TOOL_NOT_ALLOWED");
  });

  it("marks a completed call completed, with no refusal", () => {
    const receipt = toolReceipt(base);
    expect(receipt.outcome).toBe("COMPLETED");
    expect(receipt.refusal).toBeNull();
  });

  it("differs from a completed receipt only where the call differed", () => {
    const refused = toolReceipt({ ...base, refusal: "SESSION_NOT_LIVE" });
    const completed = toolReceipt(base);
    const differing = MEMBERS.filter(
      (name) =>
        JSON.stringify((refused as unknown as Record<string, unknown>)[name]) !==
        JSON.stringify((completed as unknown as Record<string, unknown>)[name]),
    );
    expect(differing.sort()).toEqual(["outcome", "refusal"]);
  });
});

describe("a credential-shaped coordinate is refused, never carried", () => {
  it("returns a redacted RESULT_UNSAFE receipt and no fragment of the value", () => {
    // Assembled at runtime: no tracked file in this repository may carry a
    // credential-shaped literal, and this suite does not ask for the single
    // exemption that exists.
    const leaked = "sk-ant-api03-" + "A".repeat(32);
    const receipt = toolReceipt({ ...base, toolName: leaked });

    expect(receipt.outcome).toBe("REFUSED");
    expect(receipt.refusal).toBe("RESULT_UNSAFE");
    // The whole serialized receipt, not just the field it came in through.
    expect(JSON.stringify(receipt)).not.toContain(leaked);
    expect(JSON.stringify(receipt)).not.toContain("sk-ant-api03-");
    expect(receipt.toolName).toBe("REDACTED");
    expect(receipt.sessionId).toBe("REDACTED");
    expect(receipt.identity).toBe("REDACTED");
    // The counts go with the coordinates: a refused receipt states that it
    // could not be built safely, and does not half-report the call.
    expect(receipt.argumentBytes).toBe(0);
    expect(receipt.resultBytes).toBe(0);
    expect(receipt.contentBlocks).toBe(0);
    // Still exactly the ten members: the redaction replaces values, never the
    // shape.
    expect(Object.keys(receipt).sort()).toEqual(MEMBERS);
  });

  it("leaves an ordinary receipt untouched", () => {
    expect(toolReceipt(base).toolName).toBe("docs.search");
  });
});

describe("the result guard refuses what the plane will not carry", () => {
  it.each([
    ["a bearer token value", { content: [{ text: "Bearer aaaaaaaaaaaaaaaaaaaa" }] }],
    ["an sk- shaped key", { content: [{ text: "sk-ant-api03-" + "A".repeat(20) }] }],
    ["a private key block", { content: [{ text: "-----BEGIN " + "RSA PRIVATE" + " KEY-----" }] }],
    ["a credential-bearing key", { apiKey: "whatever" }],
    ["a transcript-bearing key", { messages: [] }],
    ["a conversation key", { conversation: "..." }],
  ])("refuses %s", (_name, value) => {
    expect(toolResultIsUnsafe(value)).toBe(true);
  });

  it("admits an ordinary tool result", () => {
    // The vacuity guard: a predicate that refused everything would pass every
    // case above and be useless.
    expect(toolResultIsUnsafe({ content: [{ type: "text", text: "the answer" }] })).toBe(false);
  });
});

describe("the widened transport member survives every path (V2-B4b S4-0)", () => {
  it("keeps exactly the same ten members when the transport is unresolved", () => {
    // The shape pin does not move. The member's *type* widened; the member set
    // did not, which is the whole reason this packet is cheap.
    const receipt = toolReceipt({ ...base, transport: TOOL_TRANSPORT_UNRESOLVED });
    expect(Object.keys(receipt).sort()).toEqual(MEMBERS);
    expect(receipt.transport).toBe(TOOL_TRANSPORT_UNRESOLVED);
  });

  it("preserves the unresolved word through the redaction fallback", () => {
    // The advantage of a word over a null, and the reason `:107` needed no
    // edit: the redaction path replaces the free-text coordinates and carries
    // the transport through untouched. A word survives that passthrough exactly
    // as a member did.
    const receipt = toolReceipt({
      ...base,
      toolName: "sk-ant-api03-" + "A".repeat(32),
      transport: TOOL_TRANSPORT_UNRESOLVED,
    });
    expect(receipt.outcome).toBe("REFUSED");
    expect(receipt.refusal).toBe("RESULT_UNSAFE");
    expect(receipt.transport).toBe(TOOL_TRANSPORT_UNRESOLVED);
    expect(Object.keys(receipt).sort()).toEqual(MEMBERS);
  });

  it("stays clockless and equal-by-value with the word", () => {
    const input = { ...base, transport: TOOL_TRANSPORT_UNRESOLVED };
    expect(toolReceipt(input)).toEqual(toolReceipt(input));
  });
});
