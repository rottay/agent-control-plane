import { afterEach, describe, expect, it } from "vitest";

import type { WorkerIdentityString } from "@acp/contracts";

import { admitToolServer } from "../../src/admission/index.js";
import type { AdmittedHttpLoopbackToolServer } from "../../src/admission/index.js";
import {
  TOOL_HTTP_STREAM_BYTES_MAX,
  TOOL_HTTP_STREAM_EVENTS_MAX,
  TOOL_MCP_PROTOCOL_VERSION,
} from "../../src/contract/index.js";
import { openToolHttpLoopbackConnection } from "../../src/http-loopback/index.js";
import { createToolProtocolPort } from "../../src/port/index.js";
import type { ToolProtocolPort } from "../../src/port/index.js";
import { initializeBody, jsonRpcBody, scriptFetch } from "../testing/index.js";
import type { ScriptedFetch, ScriptedHttpAnswer } from "../testing/index.js";

/**
 * Evidence for the loopback Streamable HTTP leg (V2-B4b S4-1).
 *
 * **No socket is opened anywhere in this file.** `globalThis.fetch` is
 * substituted with a scripted peer and restored in `afterEach`. That is the
 * ruling rather than a shortcut: `node:http` and `node:net` are banned across
 * this package's source *and* tests, this repository has twice recorded that
 * undici `fetch` is intermittent against loopback inside a Vitest worker, and
 * the swap is the house precedent. The limitation is recorded in
 * `MCP_PROTOCOL_RECORD` as `SOCKET_EXERCISED: "NONE"` rather than hidden.
 *
 * The assertions that matter most are the ones about what the request does
 * **not** carry: no credential of any shape can travel, and the target can only
 * be the admitted string.
 */

const URL_TEXT = "http://127.0.0.1:9000/mcp";
const IMPLEMENTER = "claude/opus/implementer/01" as WorkerIdentityString;
let scripted: ScriptedFetch | null = null;

afterEach(() => {
  scripted?.restore();
  scripted = null;
});

function server(): AdmittedHttpLoopbackToolServer {
  const outcome = admitToolServer({
    serverId: "docs",
    transport: "HTTP_LOOPBACK",
    url: URL_TEXT,
    tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
  });
  if (!outcome.ok) throw new Error("fixture endpoint was not admitted: " + outcome.at);
  if (outcome.server.kind !== "HTTP_LOOPBACK") throw new Error("fixture is not a loopback server");
  return outcome.server;
}

function script(answers: readonly ScriptedHttpAnswer[]): ScriptedFetch {
  scripted = scriptFetch(answers);
  return scripted;
}

/** Write one frame and wait for the connection to settle. */
async function writeAndSettle(
  connection: ReturnType<typeof openToolHttpLoopbackConnection>,
  frame: string,
): Promise<void> {
  connection.write(frame);
  // The seam is push: `write` returns void and the answer arrives on the sink.
  // Yielding the microtask queue a few times is how a synchronous seam is
  // awaited without inventing a promise the interface does not have.
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

const JSON_HEADERS = { "content-type": "application/json" };
const SSE_HEADERS = { "content-type": "text/event-stream" };

describe("the request carries the endpoint and nothing else", () => {
  it("posts to the admitted URL verbatim, with the four headers and no credential", async () => {
    const peer = script([{ status: 200, headers: JSON_HEADERS, body: initializeBody(1) }]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));

    const call = peer.calls()[0];
    if (call === undefined) throw new Error("no request was made");
    // The admitted string, unmodified. Nothing is joined and nothing is parsed.
    expect(call.url).toBe(URL_TEXT);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["accept"]).toBe("application/json, text/event-stream");
    expect(headers["mcp-protocol-version"]).toBe(TOOL_MCP_PROTOCOL_VERSION);
    // No session header until the server has issued one.
    expect("mcp-session-id" in headers).toBe(false);

    // Asserted over the captured argument rather than over prose: there is no
    // descriptor field that could supply a credential, and this asserts that
    // none appeared anyway.
    for (const forbidden of ["authorization", "cookie", "proxy-authorization", "origin"]) {
      expect({ forbidden, present: forbidden in headers }).toEqual({ forbidden, present: false });
    }
    const init = call.init as Record<string, unknown>;
    expect("credentials" in init).toBe(false);
    expect("dispatcher" in init).toBe(false);
  });
});

describe("each response class is judged, and none is guessed", () => {
  it("pushes one frame for a JSON answer", async () => {
    script([{ status: 200, headers: JSON_HEADERS, body: initializeBody(1) }]);
    const frames: string[] = [];
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe((chunk) => frames.push(chunk));
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    expect(frames).toHaveLength(1);
    expect(connection.transportRefusal()).toBeNull();
  });

  it("pushes nothing for a 202, and does not break", async () => {
    script([{ status: 202 }]);
    const frames: string[] = [];
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe((chunk) => frames.push(chunk));
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    expect(frames).toEqual([]);
    expect(connection.transportRefusal()).toBeNull();
  });

  it("pushes one frame per event for a server-sent stream", async () => {
    const body = "event: message\ndata: " + initializeBody(1) + "\n\nid: 7\ndata: " + jsonRpcBody(2, {}) + "\n\n";
    script([{ status: 200, headers: SSE_HEADERS, body }]);
    const frames: string[] = [];
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe((chunk) => frames.push(chunk));
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    expect(frames).toHaveLength(2);
    // `id:` was read and discarded: resumption is not implemented.
    expect(connection.transportRefusal()).toBeNull();
  });

  it("refuses a redirect visibly, and does not wait out the request timeout", async () => {
    // The drill the out-of-band channel exists for. `redirect: "manual"` is
    // chosen over `"error"` precisely so this is assertable: `"error"` rejects
    // with a TypeError indistinguishable from a connection failure.
    script([{ status: 302, headers: { location: "http://127.0.0.1:9001/elsewhere" } }]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    let ended = false;
    connection.onEnd(() => {
      ended = true;
    });

    const started = Date.now();
    await writeAndSettle(connection, jsonRpcBody(1, {}));

    expect(connection.transportRefusal()).toEqual({
      refusal: "TRANSPORT_REFUSED",
      at: "server.response.redirect",
    });
    expect(ended).toBe(true);
    // Promptly, not thirty seconds later. That contrast is the whole point.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("refuses an unexpected status and an unexpected content type", async () => {
    for (const answer of [
      { status: 500, headers: JSON_HEADERS, body: "{}" },
      { status: 200, headers: { "content-type": "text/plain" }, body: "hello" },
    ]) {
      script([answer]);
      const connection = openToolHttpLoopbackConnection(server());
      connection.subscribe(() => undefined);
      await writeAndSettle(connection, jsonRpcBody(1, {}));
      expect(connection.transportRefusal()?.refusal).toBe("PROTOCOL_VIOLATION");
    }
  });

  it("refuses a batched body rather than guessing which element answers", async () => {
    script([{ status: 200, headers: JSON_HEADERS, body: "[" + jsonRpcBody(1, {}) + "]" }]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    expect(connection.transportRefusal()?.refusal).toBe("PROTOCOL_VIOLATION");
  });

  it("aborts a body over the ceiling at the boundary", async () => {
    const oversized = "x".repeat(TOOL_HTTP_STREAM_BYTES_MAX + 1_000);
    script([{ status: 200, headers: SSE_HEADERS, body: "data: " + oversized + "\n\n" }]);
    const frames: string[] = [];
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe((chunk) => frames.push(chunk));
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    expect(connection.transportRefusal()?.refusal).toBe("PROTOCOL_VIOLATION");
    // Cut off at the boundary, never after: nothing over the ceiling was pushed.
    expect(frames).toEqual([]);
  });

  it("cancels an oversized JSON body at the boundary, without pulling the rest", async () => {
    // The disposition cannot tell the two implementations apart: reading the
    // whole body and comparing afterwards refuses too, just later and with the
    // body already in memory. What separates them is how much arrived first, so
    // the body counts its own pulls and the assertion is on that count.
    const CHUNKS = 100;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > CHUNKS) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    script([{ status: 200, headers: JSON_HEADERS, body }]);
    const frames: string[] = [];
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe((piece) => frames.push(piece));
    const ended = new Promise<void>((resolve) => {
      connection.onEnd(() => {
        resolve();
      });
    });
    connection.write(jsonRpcBody(1, {}));
    await ended;

    expect(connection.transportRefusal()?.refusal).toBe("PROTOCOL_VIOLATION");
    expect(frames).toEqual([]);
    // Twelve times the ceiling was offered. A reader that stops at the boundary
    // takes the chunks the ceiling admits and at most a small read-ahead; one
    // that buffers first takes all hundred.
    // Twelve times the ceiling was offered and ten chunks arrived: the eight
    // the ceiling admits, the ninth that crosses it, and one the stream had
    // already read ahead. A reader that buffers first takes every one of the
    // hundred, so both halves of this pair discriminate.
    const admits = Math.ceil(TOOL_HTTP_STREAM_BYTES_MAX / chunk.byteLength) + 1;
    expect({ bounded: pulled <= admits + 2, exhausted: pulled >= CHUNKS }).toEqual({
      bounded: true,
      exhausted: false,
    });
  });

  it("refuses a stream carrying more events than the ceiling admits", async () => {
    const events = Array.from(
      { length: TOOL_HTTP_STREAM_EVENTS_MAX + 5 },
      (_unused, index) => "data: " + jsonRpcBody(index, {}) + "\n\n",
    ).join("");
    script([{ status: 200, headers: SSE_HEADERS, body: events }]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    expect(connection.transportRefusal()?.refusal).toBe("PROTOCOL_VIOLATION");
  });
});

describe("the session is echoed, never invented", () => {
  it("carries the issued session id on the very next request", async () => {
    const peer = script([
      { status: 200, headers: { ...JSON_HEADERS, "mcp-session-id": "sess-1" }, body: initializeBody(1) },
      { status: 200, headers: JSON_HEADERS, body: jsonRpcBody(2, {}) },
    ]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    await writeAndSettle(connection, jsonRpcBody(2, {}));

    const first = peer.calls()[0];
    const second = peer.calls()[1];
    if (first === undefined || second === undefined) throw new Error("expected two requests");
    // Captured before the frame was pushed, so the second request already has
    // it. The ordering is structural; this is the drill that says so.
    expect("mcp-session-id" in (first.init.headers as Record<string, string>)).toBe(false);
    expect((second.init.headers as Record<string, string>)["mcp-session-id"]).toBe("sess-1");
  });

  it("never sends a session header to a stateless server", async () => {
    const peer = script([
      { status: 200, headers: JSON_HEADERS, body: initializeBody(1) },
      { status: 200, headers: JSON_HEADERS, body: jsonRpcBody(2, {}) },
    ]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    await writeAndSettle(connection, jsonRpcBody(2, {}));
    for (const call of peer.calls()) {
      expect("mcp-session-id" in (call.init.headers as Record<string, string>)).toBe(false);
    }
  });

  it("breaks on a 404 with a session in flight, recovering by reconnection only", async () => {
    script([
      { status: 200, headers: { ...JSON_HEADERS, "mcp-session-id": "sess-1" }, body: initializeBody(1) },
      { status: 404 },
    ]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    await writeAndSettle(connection, jsonRpcBody(2, {}));
    expect(connection.transportRefusal()?.refusal).toBe("PROTOCOL_VIOLATION");
  });
});

describe("close is best effort and never throws", () => {
  it("sends one DELETE when a session exists, tolerating a refusal of the method", async () => {
    const peer = script([
      { status: 200, headers: { ...JSON_HEADERS, "mcp-session-id": "sess-1" }, body: initializeBody(1) },
      { status: 405 },
    ]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    await expect(connection.close()).resolves.toBeUndefined();

    const teardown = peer.calls()[1];
    if (teardown === undefined) throw new Error("expected a teardown request");
    expect(teardown.init.method).toBe("DELETE");
    expect((teardown.init.headers as Record<string, string>)["mcp-session-id"]).toBe("sess-1");
  });

  it("sends no DELETE when no session was ever issued", async () => {
    const peer = script([{ status: 200, headers: JSON_HEADERS, body: initializeBody(1) }]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    await connection.close();
    expect(peer.calls()).toHaveLength(1);
  });

  it("sends no DELETE after the connection broke", async () => {
    const peer = script([
      { status: 200, headers: { ...JSON_HEADERS, "mcp-session-id": "sess-1" }, body: initializeBody(1) },
      { status: 302, headers: { location: "http://127.0.0.1:9001/x" } },
    ]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    await writeAndSettle(connection, jsonRpcBody(2, {}));
    await connection.close();
    expect(peer.calls()).toHaveLength(2);
  });
});

describe("broken once, broken for good", () => {
  it("makes no further request after a refusal", async () => {
    const peer = script([{ status: 500 }]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    await writeAndSettle(connection, jsonRpcBody(1, {}));
    expect(connection.transportRefusal()?.refusal).toBe("PROTOCOL_VIOLATION");

    await writeAndSettle(connection, jsonRpcBody(2, {}));
    // The count is the assertion: a broken connection does not retry in band.
    expect(peer.calls()).toHaveLength(1);
  });

  it("opens inert: nothing is contacted until a frame is written", async () => {
    const peer = script([{ status: 200, headers: JSON_HEADERS, body: initializeBody(1) }]);
    const connection = openToolHttpLoopbackConnection(server());
    connection.subscribe(() => undefined);
    expect(peer.calls()).toEqual([]);
    await connection.close();
    expect(peer.calls()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P-24 (ADR 0109): the paginated listing and the pinned call, on the loopback leg
// ---------------------------------------------------------------------------

describe("the loopback leg lists every page and calls only under the pin (P-24)", () => {
  const CHANGED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

  /**
   * A peer serving `pages` (each a list of `{name, inputSchema}`), answering a
   * call with text, and optionally announcing a change after its first page.
   */
  function pagedPeer(
    pages: readonly (readonly Record<string, unknown>[])[],
    options: { readonly changedAfterFirstPage?: boolean } = {},
  ): { readonly methods: () => readonly string[]; readonly cursors: () => readonly unknown[] } {
    const methods: string[] = [];
    const cursors: unknown[] = [];
    let announced = false;
    scripted = scriptFetch((body: string) => {
      const parsed = JSON.parse(body) as { method?: string; id?: number; params?: { cursor?: unknown } };
      methods.push(parsed.method ?? "");
      const id = parsed.id ?? 0;
      if (parsed.method === "initialize") return { status: 200, headers: JSON_HEADERS, body: initializeBody(id) };
      if (parsed.method === "notifications/initialized") return { status: 202 };
      if (parsed.method === "tools/list") {
        cursors.push(parsed.params?.cursor);
        const index = typeof parsed.params?.cursor === "string" ? Number(parsed.params.cursor.slice(1)) : 0;
        const result: Record<string, unknown> = { tools: pages[index] ?? [] };
        if (index + 1 < pages.length) result["nextCursor"] = "p" + String(index + 1);
        const frames = ["data: " + jsonRpcBody(id, result) + "\n\n"];
        if (options.changedAfterFirstPage === true && !announced && index === 0) {
          announced = true;
          frames.push("data: " + CHANGED + "\n\n");
        }
        return { status: 200, headers: SSE_HEADERS, body: frames.join("") };
      }
      return { status: 200, headers: JSON_HEADERS, body: jsonRpcBody(id, { content: [{ type: "text", text: "the answer" }] }) };
    });
    return { methods: () => methods, cursors: () => cursors };
  }

  const PIN = { type: "object", properties: { q: { type: "string" } } };
  const loopbackPort = (): ToolProtocolPort => {
    const admitted = admitToolServer({
      serverId: "docs",
      transport: "HTTP_LOOPBACK",
      url: URL_TEXT,
      tools: [{ name: "docs.search", writes: false, inputSchema: PIN }],
    });
    if (!admitted.ok) throw new Error("fixture endpoint was not admitted: " + admitted.at);
    return createToolProtocolPort({ servers: [admitted.server], liveness: { isLive: () => true } });
  };
  const callOn = (target: ToolProtocolPort) =>
    target.callTool({ sessionId: "s", serverId: "docs", toolName: "docs.search", identity: IMPLEMENTER, arguments: {} });

  it("E1: completes a call whose tool is on the only page", async () => {
    const peer = pagedPeer([[{ name: "docs.search", inputSchema: PIN }]]);
    const target = loopbackPort();
    try {
      expect(await callOn(target)).toMatchObject({ ok: true, content: ["the answer"] });
      expect(peer.methods().filter((method) => method === "tools/list")).toHaveLength(1);
    } finally {
      await target.closeAll();
    }
  });

  it("E2: follows three pages with their cursors, then calls once", async () => {
    const peer = pagedPeer([
      [{ name: "a.1", inputSchema: PIN }],
      [{ name: "a.2", inputSchema: PIN }],
      [{ name: "docs.search", inputSchema: PIN }],
    ]);
    const target = loopbackPort();
    try {
      expect((await callOn(target)).ok).toBe(true);
      expect(peer.cursors()).toEqual([undefined, "p1", "p2"]);
      expect(peer.methods().filter((method) => method === "tools/call")).toHaveLength(1);
    } finally {
      await target.closeAll();
    }
  });

  it("E3: refuses a nested difference as SCHEMA_MISMATCH and sends no call", async () => {
    const peer = pagedPeer([[{ name: "docs.search", inputSchema: { type: "object", properties: { q: { type: "number" } } } }]]);
    const target = loopbackPort();
    try {
      expect(await callOn(target)).toMatchObject({ ok: false, refusal: "SCHEMA_MISMATCH", at: "server.tools.inputSchema" });
      expect(peer.methods()).not.toContain("tools/call");
    } finally {
      await target.closeAll();
    }
  });

  it("restarts a listing a change interrupted, once, and then calls", async () => {
    const peer = pagedPeer(
      [[{ name: "a.1", inputSchema: PIN }], [{ name: "docs.search", inputSchema: PIN }]],
      { changedAfterFirstPage: true },
    );
    const target = loopbackPort();
    try {
      expect((await callOn(target)).ok).toBe(true);
      expect(peer.cursors()).toEqual([undefined, "p1", undefined, "p1"]);
      expect(peer.methods().filter((method) => method === "tools/call")).toHaveLength(1);
    } finally {
      await target.closeAll();
    }
  });
});

describe("the loopback leg reads the output pin and the structured result alike (P-24/B(b))", () => {
  const OUTPUT = { type: "object", properties: { hits: { type: "number" } } };
  const STRUCTURED = { hits: 2 };

  /** A one-page peer advertising `docs.search` with `outputSchema`, answering its call with `result`. */
  function structuredPeer(outputSchema: unknown, result: unknown): { readonly methods: () => readonly string[] } {
    const methods: string[] = [];
    scripted = scriptFetch((body: string) => {
      const parsed = JSON.parse(body) as { method?: string; id?: number };
      methods.push(parsed.method ?? "");
      const id = parsed.id ?? 0;
      if (parsed.method === "initialize") return { status: 200, headers: JSON_HEADERS, body: initializeBody(id) };
      if (parsed.method === "notifications/initialized") return { status: 202 };
      if (parsed.method === "tools/list") {
        const advertised = { name: "docs.search", inputSchema: { type: "object" }, ...(outputSchema === undefined ? {} : { outputSchema }) };
        return { status: 200, headers: SSE_HEADERS, body: "data: " + jsonRpcBody(id, { tools: [advertised] }) + "\n\n" };
      }
      return { status: 200, headers: JSON_HEADERS, body: jsonRpcBody(id, result) };
    });
    return { methods: () => methods };
  }

  const loopbackPort = (outputSchema: unknown): ToolProtocolPort => {
    const admitted = admitToolServer({
      serverId: "docs",
      transport: "HTTP_LOOPBACK",
      url: URL_TEXT,
      tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" }, outputSchema } as never],
    });
    if (!admitted.ok) throw new Error("fixture endpoint was not admitted: " + admitted.at);
    return createToolProtocolPort({ servers: [admitted.server], liveness: { isLive: () => true } });
  };
  const callOn = (target: ToolProtocolPort) =>
    target.callTool({ sessionId: "s", serverId: "docs", toolName: "docs.search", identity: IMPLEMENTER, arguments: {} });

  it("completes a mirrored structured result under an equal output pin", async () => {
    const mirror = JSON.stringify(STRUCTURED);
    structuredPeer(OUTPUT, { content: [{ type: "text", text: mirror }], structuredContent: STRUCTURED });
    const target = loopbackPort(OUTPUT);
    try {
      expect(await callOn(target)).toMatchObject({ ok: true, content: [mirror] });
    } finally {
      await target.closeAll();
    }
  });

  it("refuses a different output schema as SCHEMA_MISMATCH, posting no tools/call", async () => {
    const peer = structuredPeer({ type: "object" }, { content: [] });
    const target = loopbackPort(OUTPUT);
    try {
      expect(await callOn(target)).toMatchObject({ ok: false, refusal: "SCHEMA_MISMATCH", at: "server.tools.outputSchema" });
      expect(peer.methods()).not.toContain("tools/call");
    } finally {
      await target.closeAll();
    }
  });

  it("declines unmirrored structured content with the client's word, as stdio does", async () => {
    const peer = structuredPeer(undefined, { content: [{ type: "text", text: "two hits" }], structuredContent: STRUCTURED });
    const target = loopbackPort(null);
    try {
      expect(await callOn(target)).toMatchObject({ ok: false, refusal: "RESULT_NOT_CARRIED", at: "server.result.structuredContent" });
      expect(peer.methods()).toContain("tools/call");
    } finally {
      await target.closeAll();
    }
  });
});

describe("a listing prefers the transport refusal the loopback leg carried (P-24/B(a))", () => {
  const PIN = { type: "object" };

  /**
   * A peer that answers the first `redirects` listings with a 302, and every
   * later one with the tool under its pin. Each `initialize` is counted, so a
   * dropped connection is visible as a second handshake.
   */
  function redirectingPeer(redirects: number): { readonly methods: () => readonly string[] } {
    const methods: string[] = [];
    let lists = 0;
    scripted = scriptFetch((body: string) => {
      const parsed = JSON.parse(body) as { method?: string; id?: number };
      methods.push(parsed.method ?? "");
      const id = parsed.id ?? 0;
      if (parsed.method === "initialize") return { status: 200, headers: JSON_HEADERS, body: initializeBody(id) };
      if (parsed.method === "notifications/initialized") return { status: 202 };
      if (parsed.method === "tools/list") {
        lists += 1;
        if (lists <= redirects) return { status: 302, headers: { location: "http://127.0.0.1:9001/elsewhere" } };
        return { status: 200, headers: SSE_HEADERS, body: "data: " + jsonRpcBody(id, { tools: [{ name: "docs.search", inputSchema: PIN }] }) + "\n\n" };
      }
      return { status: 200, headers: JSON_HEADERS, body: jsonRpcBody(id, { content: [{ type: "text", text: "the answer" }] }) };
    });
    return { methods: () => methods };
  }

  const loopbackPort = (): ToolProtocolPort => {
    const admitted = admitToolServer({
      serverId: "docs",
      transport: "HTTP_LOOPBACK",
      url: URL_TEXT,
      tools: [{ name: "docs.search", writes: false, inputSchema: PIN }],
    });
    if (!admitted.ok) throw new Error("fixture endpoint was not admitted: " + admitted.at);
    return createToolProtocolPort({ servers: [admitted.server], liveness: { isLive: () => true } });
  };

  it("answers a redirect during the listing as TRANSPORT_REFUSED at its field path, promptly, and drops the connection", async () => {
    const peer = redirectingPeer(1);
    const target = loopbackPort();
    try {
      const started = Date.now();
      expect(await target.listTools("s", "docs")).toEqual({
        ok: false,
        refusal: "TRANSPORT_REFUSED",
        at: "server.response.redirect",
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(peer.methods()).not.toContain("tools/call");
      // Dropped: the next listing opens a new session with a new handshake. A
      // kept connection would answer the next listing with the broken client's
      // PROTOCOL_VIOLATION and the stale carried word, so this half is red when
      // the drop is removed. The loopback ends the connection when it records the
      // refusal, so the client's own word here is PROTOCOL_VIOLATION and the drop
      // comes from that disjunct; the `|| carried !== null` disjunct alone is not
      // separable by any row and is carried by code reading (ADR 0118 §Two).
      expect(await target.listTools("s", "docs")).toMatchObject({ ok: true, tools: [{ name: "docs.search" }] });
      expect(peer.methods().filter((method) => method === "initialize")).toHaveLength(2);
    } finally {
      await target.closeAll();
    }
  });

  it("lists the same peer without a redirect on one connection (the positive twin)", async () => {
    const peer = redirectingPeer(0);
    const target = loopbackPort();
    try {
      expect(await target.listTools("s", "docs")).toMatchObject({ ok: true, tools: [{ name: "docs.search" }] });
      expect(await target.listTools("s", "docs")).toMatchObject({ ok: true });
      expect(peer.methods().filter((method) => method === "initialize")).toHaveLength(1);
      expect(peer.methods().filter((method) => method === "tools/list")).toHaveLength(1);
    } finally {
      await target.closeAll();
    }
  });
});
