import { afterEach, describe, expect, it, vi } from "vitest";

import { createToolClient } from "../../src/client/index.js";
import type { ToolClient } from "../../src/client/index.js";
import {
  TOOL_CALL_TIMEOUT_MS,
  TOOL_CONTENT_STRING_MAX,
  TOOL_CURSOR_BYTES_MAX,
  TOOL_LIST_DEADLINE_MS,
  TOOL_LIST_PAGES_MAX,
  TOOL_LIST_TOOLS_MAX,
  TOOL_MCP_CLIENT_NAME,
  TOOL_MCP_PROTOCOL_VERSION,
  TOOL_RESULT_BYTES_MAX,
  TOOL_SCHEMA_DEPTH_MAX,
} from "../../src/contract/index.js";
import { toolFrameBytes } from "../../src/jsonrpc/index.js";
import {
  INITIALIZE_NO_VERSION,
  createScriptedToolConnection,
  initializeResult,
  requestIdOf,
  requestMethodOf,
  resultFrame,
} from "../testing/index.js";
import type { ScriptedToolConnection } from "../testing/index.js";

/**
 * Settle the microtask chain.
 *
 * Every step in this client is a promise resolution, never a timer, so the
 * suite advances it by yielding rather than by waiting. No wall clock is
 * consumed and nothing depends on how fast the machine is.
 */
const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 16; tick += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

/** A fresh scripted peer and the client driving it. */
function connected(): {
  readonly connection: ScriptedToolConnection;
  readonly client: ToolClient;
} {
  const connection = createScriptedToolConnection();
  const client = createToolClient(connection);
  return { connection, client };
}

async function answerHandshake(connection: ScriptedToolConnection): Promise<void> {
  const frames = connection.written();
  connection.emit(resultFrame(requestIdOf(frames[0] ?? "{}"), initializeResult()));
  await flush();
}

/** The smallest schema a conformant server may advertise. */
const OBJECT = { type: "object" } as const;

/** The last frame the client wrote. */
const lastFrame = (connection: ScriptedToolConnection): string => {
  const frames = connection.written();
  return frames[frames.length - 1] ?? "{}";
};

describe("the handshake happens once, and states what this client is", () => {
  it("sends initialize with the pinned revision, then the initialized notification", async () => {
    const { connection, client } = connected();
    const pending = client.initialize();

    const first = JSON.parse(connection.written()[0] ?? "{}") as {
      method: string;
      params: { protocolVersion: string; clientInfo: { name: string } };
    };
    expect(first.method).toBe("initialize");
    expect(first.params.protocolVersion).toBe(TOOL_MCP_PROTOCOL_VERSION);
    expect(first.params.clientInfo.name).toBe(TOOL_MCP_CLIENT_NAME);

    await answerHandshake(connection);
    await expect(pending).resolves.toEqual({ ok: true, value: "fake-mcp" });
    expect(requestMethodOf(connection.written()[1] ?? "{}")).toBe("notifications/initialized");
  });

  it("does not handshake a second time for a second call", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), { tools: [{ name: "a", inputSchema: OBJECT }] }));
    await listing;

    const before = connection.written().length;
    const second = client.listTools();
    await flush();
    expect(requestMethodOf(lastFrame(connection))).toBe("tools/list");
    expect(connection.written().length).toBe(before + 1);
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), { tools: [{ name: "a", inputSchema: OBJECT }] }));
    await expect(second).resolves.toEqual({ ok: true, value: [{ name: "a", inputSchema: OBJECT }] });
  });
});

describe("tools/list and tools/call carry what the server said", () => {
  it("returns the advertised names with their schemas (P-24)", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    const schema = { type: "object", properties: { q: { type: "string" } } };
    connection.emit(
      resultFrame(requestIdOf(lastFrame(connection)), {
        tools: [
          { name: "docs.search", inputSchema: schema },
          { name: "shell.exec", inputSchema: OBJECT },
        ],
      }),
    );
    await expect(listing).resolves.toEqual({
      ok: true,
      value: [
        { name: "docs.search", inputSchema: schema },
        { name: "shell.exec", inputSchema: OBJECT },
      ],
    });
  });

  it("returns the text blocks and the size of the answer", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", { q: "acp" });
    await answerHandshake(connection);
    const result = { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] };
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), result));

    const outcome = await call;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.content).toEqual(["one", "two"]);
    expect(outcome.value.resultBytes).toBe(JSON.stringify(result).length);
  });

  it("sends the arguments under the protocol's own key", async () => {
    const { connection, client } = connected();
    void client.callTool("docs.search", { q: "acp" });
    await answerHandshake(connection);
    const sent = JSON.parse(lastFrame(connection)) as {
      method: string;
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(sent.method).toBe("tools/call");
    expect(sent.params.name).toBe("docs.search");
    expect(sent.params.arguments).toEqual({ q: "acp" });
  });
});

describe("an answer this client will not carry is refused, never trimmed", () => {
  it("refuses a result over the result ceiling", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    const result = {
      content: [{ type: "text", text: "x".repeat(TOOL_RESULT_BYTES_MAX + 10) }],
    };
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), result));
    // P-11 (W3): the counts of the result that arrived travel with the
    // refusal — a zero here would be a false number in a durable row.
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "RESULT_UNBOUNDED",
      at: "server.result",
      result: {
        resultBytes: toolFrameBytes(JSON.stringify(result)),
        contentBlocks: 1,
      },
    });
  });

  it("refuses a single content block over the block ceiling", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    const result = {
      content: [{ type: "text", text: "y".repeat(TOOL_CONTENT_STRING_MAX + 1) }],
    };
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), result));
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "RESULT_UNBOUNDED",
      at: "server.result",
      result: {
        resultBytes: toolFrameBytes(JSON.stringify(result)),
        contentBlocks: 1,
      },
    });
  });

  it("refuses a non-text block rather than dropping it", async () => {
    // Omitting what cannot be represented would hand the caller a shortened
    // answer it has no way to recognize as shortened.
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    const result = {
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    };
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), result));
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.result",
      result: {
        resultBytes: toolFrameBytes(JSON.stringify(result)),
        contentBlocks: 1,
      },
    });
  });
});

describe("a result the server marks as an error is refused, never a success (P-11)", () => {
  it("refuses a well-formed result with isError: true, keeping the real counts", async () => {
    // N-1/N-2: the frame is a success and the child exits zero — and the
    // outcome is still not ok. A tool error is never a success, whatever the
    // transport said.
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    const result = {
      content: [{ type: "text", text: "the tool exploded" }],
      isError: true,
    };
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), result));

    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "RESULT_IS_ERROR",
      at: "server.result",
      result: {
        resultBytes: toolFrameBytes(JSON.stringify(result)),
        contentBlocks: 1,
      },
    });
  });

  it.each([
    ["a string", "true"],
    ["a number", 1],
    ["null", null],
  ])("refuses isError as %s rather than coercing it to false (N-6)", async (_label, flag) => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    const result = { content: [{ type: "text", text: "x" }], isError: flag };
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), result));
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.result",
      result: {
        resultBytes: toolFrameBytes(JSON.stringify(result)),
        contentBlocks: 1,
      },
    });
  });

  it("completes when isError is explicitly false (P-1)", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    connection.emit(
      resultFrame(requestIdOf(lastFrame(connection)), {
        content: [{ type: "text", text: "fine" }],
        isError: false,
      }),
    );
    const outcome = await call;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.content).toEqual(["fine"]);
  });
});

describe("a stream this client cannot reason about is abandoned, not retried", () => {
  it("refuses a JSON-RPC error response", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    connection.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestIdOf(lastFrame(connection)),
        error: { code: -32_000, message: "no" },
      }) + "\n",
    );
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
  });

  it("breaks on a malformed frame and stays broken", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    connection.emit("{ this is not json\n");
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });

    const before = connection.written().length;
    await expect(client.callTool("docs.search", {})).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
    // Nothing was written: a connection that has misbehaved is not coaxed into
    // answering one more time.
    expect(connection.written().length).toBe(before);
  });

  it("breaks on an answer to a request it never sent", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    connection.emit(resultFrame(99_999, { content: [] }));
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
  });

  it("fails the pending call when the peer hangs up, rather than hanging", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    connection.hangUp();
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
  });

  it("refuses a peer that accepts the call and never answers, on the timeout", async () => {
    // Fake timers, never a real wait: the ceiling is thirty seconds and no
    // suite may spend them. They are installed before the client exists,
    // because a timer armed under the real clock is not one this test can
    // advance — which is the shape of a timeout test that silently waits.
    vi.useFakeTimers();
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);

    await vi.advanceTimersByTimeAsync(TOOL_CALL_TIMEOUT_MS + 1);
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });

    // And the connection stays broken afterwards: a peer that went silent
    // once leaves the stream at an offset nothing can reason about.
    const before = connection.written().length;
    await expect(client.callTool("docs.search", {})).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
    expect(connection.written().length).toBe(before);
  });

  it("refuses a malformed initialize answer", async () => {
    const { connection, client } = connected();
    const pending = client.initialize();
    connection.emit(resultFrame(requestIdOf(connection.written()[0] ?? "{}"), { serverInfo: {} }));
    await expect(pending).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
  });
});

describe("closing releases the transport once", () => {
  it("closes the connection and fails anything still pending", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    await client.close();
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
    expect(connection.closes()).toBe(1);
  });
});

describe("the agreed revision is compared, not assumed (V2-B4b S4-1)", () => {
  /**
   * Applied to both transports, and that is the point.
   *
   * Over stdio this was a fidelity gap: the client asserted a revision in
   * `initialize` and never read the one that came back. Over HTTP it is a
   * contradiction, because the same revision is asserted in a header on every
   * single request. A check that fired on one transport only would be a parity
   * break, so it lives in the shared client.
   */
  const CASES: readonly (readonly [string, unknown])[] = [
    ["a different revision", "2024-11-05"],
    ["a non-string revision", 20250618],
    ["no revision at all", INITIALIZE_NO_VERSION],
  ];

  for (const [label, version] of CASES) {
    it("refuses " + label, async () => {
      const { connection, client } = connected();
      const pending = client.listTools();
      const frame = connection.written()[0];
      if (frame === undefined) throw new Error("no initialize frame");
      connection.emit(resultFrame(requestIdOf(frame), initializeResult("fake-mcp", version)));
      await flush();
      const outcome = await pending;

      expect({ label, ok: outcome.ok }).toEqual({ label, ok: false });
      if (outcome.ok) return;
      expect({ label, refusal: outcome.refusal, at: outcome.at }).toEqual({
        label,
        refusal: "PROTOCOL_VIOLATION",
        at: "server.response",
      });
    });
  }
});

// ---------------------------------------------------------------------------
// P-24 (ADR 0109): the whole listing, every page followed and every bound held
// ---------------------------------------------------------------------------

/** One advertised tool, with the smallest conformant schema unless told otherwise. */
const tool = (name: string, inputSchema: unknown = OBJECT): Record<string, unknown> => ({ name, inputSchema });

/** Answer the listing's pages in order, one per request, and return what the client wrote. */
async function answerPages(connection: ScriptedToolConnection, pages: readonly unknown[]): Promise<void> {
  for (const page of pages) {
    await flush();
    const frame = lastFrame(connection);
    if (requestMethodOf(frame) !== "tools/list") return;
    connection.emit(resultFrame(requestIdOf(frame), page));
  }
  await flush();
}

const listRequests = (connection: ScriptedToolConnection): readonly Record<string, unknown>[] =>
  connection
    .written()
    .map((frame) => JSON.parse(frame) as { method?: string; params?: Record<string, unknown> })
    .filter((frame) => frame.method === "tools/list")
    .map((frame) => frame.params ?? {});

describe("the listing follows every page, and bounds every one (P-24)", () => {
  it("follows nextCursor to the end, asking with exactly {cursor} after the first page", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    await answerPages(connection, [
      { tools: [tool("a")], nextCursor: "c1" },
      { tools: [tool("b")], nextCursor: "c2" },
      { tools: [tool("c")] },
    ]);
    await expect(listing).resolves.toEqual({ ok: true, value: [tool("a"), tool("b"), tool("c")] });
    expect(listRequests(connection)).toEqual([{}, { cursor: "c1" }, { cursor: "c2" }]);
  });

  const refusals: readonly (readonly [string, unknown, string, string])[] = [
    ["a null cursor", { tools: [tool("a")], nextCursor: null }, "PROTOCOL_VIOLATION", "server.tools.nextCursor"],
    ["an empty cursor", { tools: [tool("a")], nextCursor: "" }, "PROTOCOL_VIOLATION", "server.tools.nextCursor"],
    ["a numeric cursor", { tools: [tool("a")], nextCursor: 2 }, "PROTOCOL_VIOLATION", "server.tools.nextCursor"],
    ["a cursor over its bytes", { tools: [tool("a")], nextCursor: "c".repeat(TOOL_CURSOR_BYTES_MAX + 1) }, "RESULT_UNBOUNDED", "server.tools.nextCursor"],
    ["a tool with no schema", { tools: [{ name: "a" }] }, "PROTOCOL_VIOLATION", "server.tools"],
    ["a tool whose schema is an array", { tools: [tool("a", [])] }, "PROTOCOL_VIOLATION", "server.tools"],
    ["a tool whose schema is null", { tools: [tool("a", null)] }, "PROTOCOL_VIOLATION", "server.tools"],
    ["a name advertised twice on one page", { tools: [tool("a"), tool("a")] }, "PROTOCOL_VIOLATION", "server.tools"],
  ];
  for (const [label, page, refusal, at] of refusals) {
    it("refuses " + label, async () => {
      const { connection, client } = connected();
      const listing = client.listTools();
      await answerHandshake(connection);
      await answerPages(connection, [page]);
      await expect(listing).resolves.toEqual({ ok: false, refusal, at });
    });
  }

  it("admits a cursor at its bound", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    await answerPages(connection, [{ tools: [tool("a")], nextCursor: "c".repeat(TOOL_CURSOR_BYTES_MAX) }, { tools: [] }]);
    await expect(listing).resolves.toEqual({ ok: true, value: [tool("a")] });
  });

  it("refuses a repeated cursor (a cycle) and a name repeated across pages", async () => {
    const cycle = connected();
    const cycled = cycle.client.listTools();
    await answerHandshake(cycle.connection);
    await answerPages(cycle.connection, [
      { tools: [tool("a")], nextCursor: "c1" },
      { tools: [tool("b")], nextCursor: "c1" },
    ]);
    await expect(cycled).resolves.toEqual({ ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.tools.nextCursor" });

    const twice = connected();
    const doubled = twice.client.listTools();
    await answerHandshake(twice.connection);
    await answerPages(twice.connection, [{ tools: [tool("a")], nextCursor: "c1" }, { tools: [tool("a")] }]);
    await expect(doubled).resolves.toEqual({ ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.tools" });
  });

  it("admits TOOL_LIST_PAGES_MAX pages and refuses one more, unanswered", async () => {
    const pages = (count: number): unknown[] =>
      Array.from({ length: count }, (_, index) =>
        index === count - 1 ? { tools: [tool("t" + String(index))] } : { tools: [tool("t" + String(index))], nextCursor: "c" + String(index) },
      );
    const atBound = connected();
    const bounded = atBound.client.listTools();
    await answerHandshake(atBound.connection);
    await answerPages(atBound.connection, pages(TOOL_LIST_PAGES_MAX));
    const admitted = await bounded;
    expect(admitted.ok && admitted.value.length).toBe(TOOL_LIST_PAGES_MAX);

    const past = connected();
    const unbounded = past.client.listTools();
    await answerHandshake(past.connection);
    await answerPages(past.connection, pages(TOOL_LIST_PAGES_MAX + 1));
    await expect(unbounded).resolves.toEqual({ ok: false, refusal: "RESULT_UNBOUNDED", at: "server.tools" });
    // Refused before the page past the bound is asked for.
    expect(listRequests(past.connection)).toHaveLength(TOOL_LIST_PAGES_MAX);
  });

  it("admits TOOL_LIST_TOOLS_MAX tools and refuses one more", async () => {
    const names = (count: number): Record<string, unknown>[] => Array.from({ length: count }, (_, index) => tool("t" + String(index)));
    const atBound = connected();
    const bounded = atBound.client.listTools();
    await answerHandshake(atBound.connection);
    await answerPages(atBound.connection, [{ tools: names(TOOL_LIST_TOOLS_MAX) }]);
    const admitted = await bounded;
    expect(admitted.ok && admitted.value.length).toBe(TOOL_LIST_TOOLS_MAX);

    const past = connected();
    const unbounded = past.client.listTools();
    await answerHandshake(past.connection);
    await answerPages(past.connection, [{ tools: names(TOOL_LIST_TOOLS_MAX + 1) }]);
    await expect(unbounded).resolves.toEqual({ ok: false, refusal: "RESULT_UNBOUNDED", at: "server.tools" });
  });
});

describe("the listing's deadline is read between pages, never mid-request (P-24, C4)", () => {
  it("lets a page in flight complete, then refuses before the next request, and keeps the connection", async () => {
    vi.useFakeTimers();
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    await flush();
    // Each page answers inside its own timeout, and the listing as a whole runs
    // past its deadline while page 3 is in flight.
    const answerAfter = async (ms: number, page: unknown): Promise<void> => {
      vi.advanceTimersByTime(ms);
      connection.emit(resultFrame(requestIdOf(lastFrame(connection)), page));
      await flush();
    };
    expect(TOOL_LIST_DEADLINE_MS).toBeGreaterThan(TOOL_CALL_TIMEOUT_MS);
    await answerAfter(TOOL_CALL_TIMEOUT_MS - 1_000, { tools: [tool("a")], nextCursor: "c1" });
    await answerAfter(TOOL_CALL_TIMEOUT_MS - 1_000, { tools: [tool("b")], nextCursor: "c2" });
    const elapsed = 2 * (TOOL_CALL_TIMEOUT_MS - 1_000);
    await answerAfter(TOOL_LIST_DEADLINE_MS - elapsed, { tools: [tool("c")], nextCursor: "c3" });
    await expect(listing).resolves.toEqual({ ok: false, refusal: "RESULT_UNBOUNDED", at: "server.tools" });
    // Page 3 completed; page 4 was never asked for.
    expect(listRequests(connection)).toHaveLength(3);
    expect(connection.closes()).toBe(0);

    // The connection is still usable: a later listing lists anew.
    const again = client.listTools();
    await answerPages(connection, [{ tools: [tool("a")] }]);
    await expect(again).resolves.toEqual({ ok: true, value: [tool("a")] });
  });

  it("clears its timer when the listing finishes first", async () => {
    vi.useFakeTimers();
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    await answerPages(connection, [{ tools: [tool("a")] }]);
    await listing;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a list_changed notification invalidates a listing (P-24, C5)", () => {
  const changed = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n";

  it("restarts a listing it arrived during, once", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    await flush();
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), { tools: [tool("a")], nextCursor: "c1" }));
    connection.emit(changed);
    await answerPages(connection, [{ tools: [tool("b")] }, { tools: [tool("z")] }]);
    await expect(listing).resolves.toEqual({ ok: true, value: [tool("z")] });
    expect(listRequests(connection)).toEqual([{}, { cursor: "c1" }, {}]);
  });

  it("refuses a listing changed twice while it was assembled", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    await flush();
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), { tools: [tool("a")] }));
    connection.emit(changed);
    await flush();
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), { tools: [tool("a")] }));
    connection.emit(changed);
    await flush();
    await expect(listing).resolves.toEqual({ ok: false, refusal: "RESULT_UNBOUNDED", at: "server.tools" });
  });

  it("reports a change announced after the listing once, then clears it", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    await answerPages(connection, [{ tools: [tool("a")] }]);
    await listing;
    expect(client.takeListChanged()).toBe(false);
    connection.emit(changed);
    await flush();
    expect(client.takeListChanged()).toBe(true);
    expect(client.takeListChanged()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P-24/B(b) (ADR 0117): the output schema is read, and structured content is
// carried only as the text block that holds it
// ---------------------------------------------------------------------------

describe("the listing reads a tool's outputSchema, optional and never null (P-24/B(b))", () => {
  const OUTPUT = { type: "object", properties: { hits: { type: "number" } } };

  it("leaves the key absent when none is advertised, and carries an object as parsed", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    await answerPages(connection, [{ tools: [tool("a"), { ...tool("b"), outputSchema: OUTPUT }] }]);
    const outcome = await listing;
    expect(outcome).toEqual({ ok: true, value: [tool("a"), { ...tool("b"), outputSchema: OUTPUT }] });
    if (!outcome.ok) return;
    expect(Object.hasOwn(outcome.value[0] ?? {}, "outputSchema")).toBe(false);
  });

  const malformed: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["an array", []],
    ["a string", "x"],
    ["a number", 1],
  ];
  for (const [label, outputSchema] of malformed) {
    it("refuses an advertised outputSchema that is " + label + " as a violation at server.tools", async () => {
      const { connection, client } = connected();
      const listing = client.listTools();
      await answerHandshake(connection);
      await answerPages(connection, [{ tools: [{ ...tool("a"), outputSchema }] }]);
      await expect(listing).resolves.toEqual({ ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.tools" });
    });
  }

  it("reads an outputSchema advertised on page 3 of 3", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    await answerPages(connection, [
      { tools: [tool("a")], nextCursor: "c1" },
      { tools: [tool("b")], nextCursor: "c2" },
      { tools: [{ ...tool("c"), outputSchema: OUTPUT }] },
    ]);
    await expect(listing).resolves.toEqual({ ok: true, value: [tool("a"), tool("b"), { ...tool("c"), outputSchema: OUTPUT }] });
  });
});

describe("structured content is carried only as the text block that holds it (P-24/B(b))", () => {
  const STRUCTURED = { hits: 2, items: [{ id: "a" }, { id: "b" }] };
  const text = (value: string): Record<string, unknown> => ({ type: "text", text: value });

  /** Drive one call to a result and return the client's outcome. */
  async function callWith(result: unknown): Promise<{
    readonly outcome: Awaited<ReturnType<ToolClient["callTool"]>>;
    readonly connection: ScriptedToolConnection;
    readonly client: ToolClient;
  }> {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), result));
    return { outcome: await call, connection, client };
  }

  const receivedOf = (result: { content?: unknown }): { resultBytes: number; contentBlocks: number } => ({
    resultBytes: toolFrameBytes(JSON.stringify(result)),
    contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
  });

  /** A value `levels` containers deep: nested objects around a scalar. */
  const nestedValue = (levels: number): Record<string, unknown> => {
    let value: unknown = "leaf";
    for (let level = 1; level < levels; level += 1) value = { child: value };
    return { child: value };
  };

  it("completes a result with no structured content as before, and says so", async () => {
    const { outcome } = await callWith({ content: [text("plain")] });
    expect(outcome).toMatchObject({ ok: true, value: { content: ["plain"], structured: false } });
  });

  it("carries structured content its one text block serializes", async () => {
    const mirror = JSON.stringify(STRUCTURED);
    const { outcome } = await callWith({ content: [text(mirror)], structuredContent: STRUCTURED });
    expect(outcome).toMatchObject({ ok: true, value: { content: [mirror], structured: true } });
  });

  it("compares the mirror by value: reordered keys and 1.0 for 1 still carry it", async () => {
    const mirror = '{"items":[{"id":"a"},{"id":"b"}],"hits":2.0}';
    const { outcome } = await callWith({ content: [text(mirror)], structuredContent: STRUCTURED });
    expect(outcome).toMatchObject({ ok: true, value: { content: [mirror], structured: true } });
  });

  it("accepts the mirror in any text block, and a block that is not JSON beside it is no refusal", async () => {
    const mirror = JSON.stringify(STRUCTURED);
    const second = await callWith({ content: [text("Found two hits:"), text(mirror)], structuredContent: STRUCTURED });
    expect(second.outcome).toMatchObject({ ok: true, value: { content: ["Found two hits:", mirror], structured: true } });
    const notJson = await callWith({ content: [text("{ not json"), text(mirror)], structuredContent: STRUCTURED });
    expect(notJson.outcome).toMatchObject({ ok: true, value: { structured: true } });
  });

  it("declines structured content no text block carries, with the counts that arrived, and keeps the connection", async () => {
    const result = { content: [text("Found two hits."), text('{"hits":3}')], structuredContent: STRUCTURED };
    const { outcome, connection, client } = await callWith(result);
    expect(outcome).toEqual({
      ok: false,
      refusal: "RESULT_NOT_CARRIED",
      at: "server.result.structuredContent",
      result: receivedOf(result),
    });
    expect(receivedOf(result).contentBlocks).toBe(2);
    // A conformant peer that omitted a SHOULD has violated nothing: the next
    // request is written, not refused on a broken stream.
    const before = connection.written().length;
    void client.callTool("docs.search", {});
    await flush();
    expect(connection.written().length).toBe(before + 1);
    expect(requestMethodOf(lastFrame(connection))).toBe("tools/call");
  });

  it("declines structured content that arrives with no content blocks at all", async () => {
    const result = { content: [], structuredContent: STRUCTURED };
    const { outcome } = await callWith(result);
    expect(outcome).toEqual({ ok: false, refusal: "RESULT_NOT_CARRIED", at: "server.result.structuredContent", result: receivedOf(result) });
    expect(receivedOf(result)).toMatchObject({ contentBlocks: 0 });
    expect(receivedOf(result).resultBytes).toBeGreaterThan(0);
  });

  const notObjects: readonly (readonly [string, unknown])[] = [
    ["an array", []],
    ["null", null],
    ["a string", "x"],
    ["a number", 2],
  ];
  for (const [label, structuredContent] of notObjects) {
    it("refuses structured content that is " + label + " as a violation, with its counts", async () => {
      const result = { content: [text(JSON.stringify(structuredContent))], structuredContent };
      const { outcome } = await callWith(result);
      expect(outcome).toEqual({ ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.result.structuredContent", result: receivedOf(result) });
    });
  }

  it("carries a value at the depth bound and declines one past it", async () => {
    const atBound = nestedValue(TOOL_SCHEMA_DEPTH_MAX);
    const carried = await callWith({ content: [text(JSON.stringify(atBound))], structuredContent: atBound });
    expect(carried.outcome).toMatchObject({ ok: true, value: { structured: true } });
    const past = nestedValue(TOOL_SCHEMA_DEPTH_MAX + 1);
    const result = { content: [text(JSON.stringify(past))], structuredContent: past };
    const declined = await callWith(result);
    expect(declined.outcome).toEqual({ ok: false, refusal: "RESULT_NOT_CARRIED", at: "server.result.structuredContent", result: receivedOf(result) });
  });

  it("carries a mirror of exactly the block bound, and refuses one byte more at the block bound first", async () => {
    const padded = (bytes: number): Record<string, unknown> => ({ pad: "x".repeat(bytes - JSON.stringify({ pad: "" }).length) });
    const atBound = padded(TOOL_CONTENT_STRING_MAX);
    expect(JSON.stringify(atBound).length).toBe(TOOL_CONTENT_STRING_MAX);
    const carried = await callWith({ content: [text(JSON.stringify(atBound))], structuredContent: atBound });
    expect(carried.outcome).toMatchObject({ ok: true, value: { structured: true } });
    const over = padded(TOOL_CONTENT_STRING_MAX + 1);
    const result = { content: [text(JSON.stringify(over))], structuredContent: over };
    const refused = await callWith(result);
    expect(refused.outcome).toEqual({ ok: false, refusal: "RESULT_UNBOUNDED", at: "server.result", result: receivedOf(result) });
  });

  it("judges isError, the blocks and the result ceiling before the structured value", async () => {
    const mirror = JSON.stringify(STRUCTURED);
    const errorResult = { content: [text(mirror)], structuredContent: STRUCTURED, isError: true };
    expect((await callWith(errorResult)).outcome).toEqual({
      ok: false,
      refusal: "RESULT_IS_ERROR",
      at: "server.result",
      result: receivedOf(errorResult),
    });
    const imageResult = { content: [text(mirror), { type: "image", data: "AAAA", mimeType: "image/png" }], structuredContent: STRUCTURED };
    expect((await callWith(imageResult)).outcome).toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.result",
      result: receivedOf(imageResult),
    });
    const hugeResult = { content: [text(mirror)], structuredContent: { ...STRUCTURED, pad: "x".repeat(TOOL_RESULT_BYTES_MAX) } };
    expect((await callWith(hugeResult)).outcome).toEqual({
      ok: false,
      refusal: "RESULT_UNBOUNDED",
      at: "server.result",
      result: receivedOf(hugeResult),
    });
  });
});
