import { afterEach, describe, expect, it } from "vitest";

import { admitToolServer } from "../../src/admission/index.js";
import type { AdmittedHttpLoopbackToolServer } from "../../src/admission/index.js";
import {
  TOOL_HTTP_STREAM_BYTES_MAX,
  TOOL_HTTP_STREAM_EVENTS_MAX,
  TOOL_MCP_PROTOCOL_VERSION,
} from "../../src/contract/index.js";
import { openToolHttpLoopbackConnection } from "../../src/http-loopback/index.js";
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
    tools: [{ name: "docs.search", writes: false }],
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
