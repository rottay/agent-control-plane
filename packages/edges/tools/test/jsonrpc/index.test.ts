import { describe, expect, it } from "vitest";

import { TOOL_FRAME_BYTES_MAX } from "../../src/contract/index.js";
import {
  createToolCorrelator,
  createToolFrameReader,
  encodeToolFrame,
  toolFrameBytes,
  toolJsonRpcNotification,
  toolJsonRpcRequest,
} from "../../src/jsonrpc/index.js";

const frame = (id: number, result: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";

describe("frames are newline-delimited and never carry an embedded newline", () => {
  it("escapes a newline inside a string rather than emitting one", () => {
    const line = encodeToolFrame(toolJsonRpcRequest(1, "tools/call", { text: "a\nb" }));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
  });

  it("builds requests with an id and notifications without one", () => {
    expect(toolJsonRpcRequest(7, "tools/list", {})).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {},
    });
    expect(toolJsonRpcNotification("notifications/initialized", {})).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  });
});

describe("the reader carries partial frames across chunk boundaries", () => {
  it("reassembles a frame split across two chunks and parses it once", () => {
    const reader = createToolFrameReader();
    const whole = frame(1, { ok: true });
    const cut = Math.floor(whole.length / 2);

    const first = reader.push(whole.slice(0, cut));
    expect(first).toEqual([]);
    expect(reader.pending()).toBeGreaterThan(0);

    const second = reader.push(whole.slice(cut));
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual({
      ok: true,
      kind: "RESPONSE",
      response: { id: 1, result: { ok: true }, error: null },
    });
    expect(reader.pending()).toBe(0);
  });

  it("splits a chunk carrying several frames, in order", () => {
    const reader = createToolFrameReader();
    const outcomes = reader.push(frame(1, "a") + frame(2, "b") + frame(3, "c"));
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((outcome) => (outcome.ok && outcome.kind === "RESPONSE" ? outcome.response.id : -1))).toEqual([
      1, 2, 3,
    ]);
  });

  it("surfaces a notification rather than refusing it", () => {
    // A server that logs progress is not a server violating anything, and a
    // client that refused one would fail against conformant peers.
    const reader = createToolFrameReader();
    const outcomes = reader.push(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} }) + "\n",
    );
    expect(outcomes).toEqual([{ ok: true, kind: "NOTIFICATION", method: "notifications/message" }]);
  });
});

describe("the reader refuses what it cannot reason about", () => {
  it.each([
    ["not json at all", "{ this is not json"],
    ["a JSON array", "[1,2,3]"],
    ["a bare scalar", '"hello"'],
    ["a wrong protocol tag", JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} })],
    ["a non-integer id", JSON.stringify({ jsonrpc: "2.0", id: 1.5, result: {} })],
    ["a string id", JSON.stringify({ jsonrpc: "2.0", id: "abc", result: {} })],
    ["neither result nor error", JSON.stringify({ jsonrpc: "2.0", id: 1 })],
    ["a malformed error object", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: "x" } })],
  ])("refuses %s", (_name, line) => {
    const reader = createToolFrameReader();
    expect(reader.push(line + "\n")).toEqual([
      { ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.response" },
    ]);
  });

  it("reads a well-formed error response as an error, not as a violation", () => {
    const reader = createToolFrameReader();
    const outcomes = reader.push(
      JSON.stringify({ jsonrpc: "2.0", id: 4, error: { code: -32000, message: "no" } }) + "\n",
    );
    expect(outcomes).toEqual([
      {
        ok: true,
        kind: "RESPONSE",
        response: { id: 4, result: null, error: { code: -32000, message: "no" } },
      },
    ]);
  });

  it("refuses a completed frame over the frame ceiling", () => {
    const reader = createToolFrameReader();
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(TOOL_FRAME_BYTES_MAX) });
    expect(toolFrameBytes(line)).toBeGreaterThan(TOOL_FRAME_BYTES_MAX);
    expect(reader.push(line + "\n")).toEqual([
      { ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.response" },
    ]);
  });

  it("refuses an unterminated frame while it is still arriving, not after", () => {
    // A peer that sends 200KB with no newline must be refused mid-flight; the
    // alternative is holding it all, which is the unbounded allocation the
    // ceiling exists to prevent.
    const reader = createToolFrameReader();
    expect(reader.push("y".repeat(TOOL_FRAME_BYTES_MAX + 1))).toEqual([
      { ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.response" },
    ]);
    expect(reader.pending()).toBe(0);
  });

  it("stays refusing once it has refused, rather than resynchronizing", () => {
    // Resynchronizing at the next newline would mean parsing the tail of a
    // frame already rejected as if it were a new one.
    const reader = createToolFrameReader();
    reader.push("z".repeat(TOOL_FRAME_BYTES_MAX + 1));
    expect(reader.push(frame(1, "fine"))).toEqual([
      { ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.response" },
    ]);
  });
});

describe("correlation is by a monotonic counter, never a random id", () => {
  it("mints increasing ids and settles each exactly once", () => {
    const correlator = createToolCorrelator();
    const first = correlator.open();
    const second = correlator.open();
    expect(second).toBeGreaterThan(first);
    expect(correlator.outstanding()).toBe(2);

    expect(correlator.close(first)).toBe(true);
    expect(correlator.close(first)).toBe(false);
    expect(correlator.outstanding()).toBe(1);
  });

  it("refuses an id it never minted", () => {
    const correlator = createToolCorrelator();
    correlator.open();
    expect(correlator.close(99_999)).toBe(false);
  });

  it("correlates interleaved answers to the requests that asked for them", () => {
    const correlator = createToolCorrelator();
    const a = correlator.open();
    const b = correlator.open();
    const c = correlator.open();
    // Answers arrive out of order, which is the case the counter exists for.
    expect(correlator.close(c)).toBe(true);
    expect(correlator.close(a)).toBe(true);
    expect(correlator.close(b)).toBe(true);
    expect(correlator.outstanding()).toBe(0);
  });
});
