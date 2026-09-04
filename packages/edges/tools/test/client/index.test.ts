import { afterEach, describe, expect, it, vi } from "vitest";

import { createToolClient } from "../../src/client/index.js";
import type { ToolClient } from "../../src/client/index.js";
import {
  TOOL_CALL_TIMEOUT_MS,
  TOOL_CONTENT_STRING_MAX,
  TOOL_MCP_CLIENT_NAME,
  TOOL_MCP_PROTOCOL_VERSION,
  TOOL_RESULT_BYTES_MAX,
} from "../../src/contract/index.js";
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
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), { tools: [{ name: "a" }] }));
    await listing;

    const before = connection.written().length;
    const second = client.listTools();
    await flush();
    expect(requestMethodOf(lastFrame(connection))).toBe("tools/list");
    expect(connection.written().length).toBe(before + 1);
    connection.emit(resultFrame(requestIdOf(lastFrame(connection)), { tools: [{ name: "a" }] }));
    await expect(second).resolves.toEqual({ ok: true, value: ["a"] });
  });
});

describe("tools/list and tools/call carry what the server said", () => {
  it("returns the advertised names", async () => {
    const { connection, client } = connected();
    const listing = client.listTools();
    await answerHandshake(connection);
    connection.emit(
      resultFrame(requestIdOf(lastFrame(connection)), {
        tools: [{ name: "docs.search" }, { name: "shell.exec" }],
      }),
    );
    await expect(listing).resolves.toEqual({ ok: true, value: ["docs.search", "shell.exec"] });
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
    connection.emit(
      resultFrame(requestIdOf(lastFrame(connection)), {
        content: [{ type: "text", text: "x".repeat(TOOL_RESULT_BYTES_MAX + 10) }],
      }),
    );
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "RESULT_UNBOUNDED",
      at: "server.result",
    });
  });

  it("refuses a single content block over the block ceiling", async () => {
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    connection.emit(
      resultFrame(requestIdOf(lastFrame(connection)), {
        content: [{ type: "text", text: "y".repeat(TOOL_CONTENT_STRING_MAX + 1) }],
      }),
    );
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "RESULT_UNBOUNDED",
      at: "server.result",
    });
  });

  it("refuses a non-text block rather than dropping it", async () => {
    // Omitting what cannot be represented would hand the caller a shortened
    // answer it has no way to recognize as shortened.
    const { connection, client } = connected();
    const call = client.callTool("docs.search", {});
    await answerHandshake(connection);
    connection.emit(
      resultFrame(requestIdOf(lastFrame(connection)), {
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      }),
    );
    await expect(call).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.result",
    });
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
