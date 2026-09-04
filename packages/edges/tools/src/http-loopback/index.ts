import type { AdmittedHttpLoopbackToolServer } from "../admission/index.js";
import type { ToolTransportConnection } from "../client/index.js";
import type { ToolRefusal } from "../contract/index.js";
import {
  TOOL_HTTP_CLOSE_TIMEOUT_MS,
  TOOL_HTTP_REQUEST_TIMEOUT_MS,
  TOOL_HTTP_STREAM_BYTES_MAX,
  TOOL_HTTP_STREAM_EVENTS_MAX,
  TOOL_MCP_PROTOCOL_VERSION,
} from "../contract/index.js";

/**
 * The loopback Streamable HTTP leg (V2-B4b S4-1).
 *
 * The second transport, and the only site in this package permitted to name
 * `fetch` — the fence pins that by exact path, in the idiom it already uses for
 * the single spawn site. It uses the **platform global** rather than a socket
 * library: `node:net`, `node:http`, `node:https` and `node:tls` stay banned in
 * every file including this one, which is what makes "no socket library" a
 * property of the build rather than a promise.
 *
 * **The target can only have come from the admission.** There is no URL literal
 * anywhere below — no scheme, no `127.0.0.1`, no `localhost` — and no
 * `new URL(`. Streamable HTTP uses one endpoint for every method, so there is
 * nothing to join and nothing to construct: the admitted string is used
 * verbatim. A transport that could assemble a URL could assemble a different
 * one.
 *
 * **No credential can travel.** No `authorization`, no cookie, no
 * `credentials`, no dispatcher, and `process.env` is never read here. There is
 * no descriptor field that could supply a credential and this packet does not
 * add one; the fence asserts each of those absences by name, because "we do not
 * send one" is weaker than "there is nothing here that could".
 *
 * ## Why the refusal travels out of band
 *
 * The seam this implements is a **push** one: `write` launches the request and
 * returns `void`, and answers arrive through the sink the client subscribed.
 * So `write` cannot report a transport-level failure, and a silent one would
 * surface half a minute later as the client's generic timeout — which would
 * make the redirect refusal, the whole reason `redirect: "manual"` is chosen
 * over `"error"`, unassertable.
 *
 * {@link ToolHttpLoopbackConnection.transportRefusal} is the out-of-band
 * channel, in the shape this package already uses for exactly this
 * (`ToolStdioConnection` carries a `pid` the same way). On any transport-level
 * failure the connection records the refusal and **then** fires its `onEnd`
 * listeners, so the client breaks immediately rather than waiting out a timer,
 * and the port prefers the recorded refusal over the client's generic one.
 *
 * `redirect: "manual"` and not `"error"`: `"error"` rejects with a `TypeError`
 * indistinguishable from a connection failure, so an escape attempt would be
 * classified generically and could never be asserted. A redirect is how a
 * loopback endpoint sends this client somewhere else, and it is refused
 * visibly.
 *
 * ## What is not implemented, each as a refusal or an absence
 *
 * The server-initiated `GET` stream is never opened. JSON-RPC batching — a body
 * that is a JSON array — is a protocol violation. The retired two-endpoint
 * HTTP+SSE shape is not attempted, so a server answering with an `endpoint`
 * event rather than a JSON-RPC message is a protocol violation. No `origin`
 * header is sent. Stream resumption is not implemented: an SSE `id:` is read
 * and discarded, and a stream that drops mid-call breaks the connection.
 *
 * Every one of those corresponds to a field in `MCP_PROTOCOL_RECORD`, and the
 * fence asserts the record and the README cannot disagree.
 */

export interface ToolHttpLoopbackConnection extends ToolTransportConnection {
  /** The transport-level refusal that broke this connection, or null. */
  readonly transportRefusal: () => { readonly refusal: ToolRefusal; readonly at: string } | null;
}

const AT_RESPONSE = "server.response";
const AT_REDIRECT = "server.response.redirect";

/** One SSE field line, split at the first colon per the event-stream grammar. */
function parseField(line: string): { readonly name: string; readonly value: string } | null {
  if (line === "" || line.startsWith(":")) return null;
  const colon = line.indexOf(":");
  if (colon < 0) return { name: line, value: "" };
  const value = line.slice(colon + 1);
  return { name: line.slice(0, colon), value: value.startsWith(" ") ? value.slice(1) : value };
}

/**
 * Open one loopback connection. Nothing is contacted until a frame is written.
 *
 * Opening is deliberately inert: the connection holds no socket, no handle and
 * no session until the first `write`, so a scope that opens one and refuses
 * before calling has touched nothing.
 */
export function openToolHttpLoopbackConnection(
  server: AdmittedHttpLoopbackToolServer,
): ToolHttpLoopbackConnection {
  let sink: ((chunk: string) => void) | null = null;
  const endListeners: (() => void)[] = [];
  let sessionId: string | null = null;
  let broken: { readonly refusal: ToolRefusal; readonly at: string } | null = null;

  const end = (): void => {
    for (const listener of endListeners.splice(0)) listener();
  };

  /**
   * Break the connection with a recorded reason, then release the client.
   *
   * The order matters and is the point of the whole out-of-band channel: the
   * refusal is recorded **before** the listeners fire, so a client that reads
   * it on `onEnd` never sees a broken connection with no reason.
   */
  const breakWith = (refusal: ToolRefusal, at: string): void => {
    broken ??= { refusal, at };
    end();
  };

  /**
   * Hand one JSON-RPC message to the client, newline-terminated.
   *
   * The sink on the other side is the package's own frame reader, and it is
   * newline-delimited: over stdio the terminator arrives because the server
   * wrote it, and over HTTP one message is one body with no terminator at all.
   * Adding it here is what makes the two transports feed the same reader —
   * without it the reader buffers a complete message forever and the call dies
   * of the client's timeout rather than of anything that went wrong.
   */
  const push = (frame: string): void => {
    if (sink !== null) sink(frame.endsWith("\n") ? frame : frame + "\n");
  };

  /**
   * Read one `text/event-stream` body, bounded on both bytes and events.
   *
   * Counted as they are decoded and cancelled at the boundary, never after —
   * the same law the stdio frame reader holds, where the bound is on the
   * unterminated buffer rather than only on completed frames. Decoded with a
   * streaming decoder for the reason the stdio site holds one: a chunk boundary
   * splits a multi-byte code point as readily as it splits a frame, and those
   * are different carry-overs.
   */
  const readEventStream = async (response: Response): Promise<void> => {
    const body = response.body;
    if (body === null) {
      breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
      return;
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    let events = 0;
    let data: string[] = [];

    const dispatch = (): boolean => {
      if (data.length === 0) return true;
      events += 1;
      if (events > TOOL_HTTP_STREAM_EVENTS_MAX) return false;
      // One event carries one JSON-RPC message. `event:` is not load-bearing
      // and `id:` is discarded, because resumption is not implemented.
      push(data.join("\n"));
      data = [];
      return true;
    };

    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > TOOL_HTTP_STREAM_BYTES_MAX) {
          await reader.cancel();
          breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line === "") {
            if (!dispatch()) {
              await reader.cancel();
              breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
              return;
            }
            continue;
          }
          const field = parseField(line);
          if (field === null) continue;
          if (field.name === "data") data.push(field.value);
        }
      }
      // A stream that ends mid-event dropped: resumption is not implemented,
      // so the connection goes with it rather than pretending to recover.
      if (data.length > 0) dispatch();
    } catch {
      breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
    }
  };

  /**
   * Read one non-streamed body, bounded on bytes **as they arrive**.
   *
   * `response.text()` buffers the whole body and only then compares, which
   * applies the ceiling after the harm rather than at the boundary: a
   * misbehaving local server could make this client hold an arbitrarily large
   * body, bounded only by the request timeout. It also compares UTF-16 code
   * units against a byte ceiling, which is a different quantity.
   *
   * So this branch reads the way the event stream does — count `byteLength` as
   * chunks arrive, cancel the reader the instant the ceiling is crossed, and
   * decode with the streaming decoder because a chunk boundary splits a
   * multi-byte code point as readily as it splits a frame. The two branches now
   * hold one law rather than two, which is what
   * {@link TOOL_HTTP_STREAM_BYTES_MAX} already said of both.
   *
   * Returns null when the connection has already been broken. A bodyless
   * response still decodes to the empty string, exactly as `response.text()`
   * did: what changed here is the bound, not the branch's dispositions.
   */
  const readBoundedBody = async (response: Response): Promise<string | null> => {
    const body = response.body;
    if (body === null) return "";
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > TOOL_HTTP_STREAM_BYTES_MAX) {
          await reader.cancel();
          breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
          return null;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
      return null;
    }
    return text + decoder.decode();
  };

  const send = async (frame: string): Promise<void> => {
    if (broken !== null) return;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": TOOL_MCP_PROTOCOL_VERSION,
    };
    // Sent only once the server has issued one. A session id this client
    // invented would be a session the server never opened.
    if (sessionId !== null) headers["mcp-session-id"] = sessionId;

    let response: Response;
    try {
      response = await fetch(server.url, {
        method: "POST",
        headers,
        body: frame,
        redirect: "manual",
        signal: AbortSignal.timeout(TOOL_HTTP_REQUEST_TIMEOUT_MS),
      });
    } catch {
      breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
      return;
    }

    // A redirect is how a loopback endpoint sends this client elsewhere. It is
    // refused rather than followed, and visibly.
    if (response.status >= 300 && response.status < 400) {
      breakWith("TRANSPORT_REFUSED", AT_REDIRECT);
      return;
    }

    // The session is gone. Recovery is by reconnection, never by an in-band
    // retry: the next call opens a fresh connection and a fresh handshake.
    if (response.status === 404 && sessionId !== null) {
      sessionId = null;
      breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
      return;
    }

    if (response.status < 200 || response.status >= 300) {
      breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
      return;
    }

    const issued = response.headers.get("mcp-session-id");
    // Captured before the frame is pushed, so the pending request settles with
    // the session already stored. A stateless server never issues one and is
    // never sent one; both are conformant and neither is an error.
    if (issued !== null && issued !== "") sessionId = issued;

    if (response.status === 202) return;

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      await readEventStream(response);
      return;
    }
    if (contentType.includes("application/json")) {
      const text = await readBoundedBody(response);
      if (text === null) return;
      // Batching is refused: a body that is a JSON array is not a message this
      // client speaks, and guessing which element answers which request is how
      // a correlator silently mismatches.
      if (text.trimStart().startsWith("[")) {
        breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
        return;
      }
      push(text);
      return;
    }

    breakWith("PROTOCOL_VIOLATION", AT_RESPONSE);
  };

  return Object.freeze({
    write(frame: string): void {
      // Launched and not awaited: the seam is synchronous and returns void, so
      // a failure travels through `transportRefusal()` and `onEnd` instead.
      void send(frame);
    },
    subscribe(next: (chunk: string) => void): void {
      sink = next;
    },
    onEnd(listener: () => void): void {
      endListeners.push(listener);
    },
    transportRefusal() {
      return broken;
    },
    async close(): Promise<void> {
      const id = sessionId;
      sessionId = null;
      // Best effort, and only when a session was actually issued. Every status
      // is accepted, including a refusal of the method itself: the session is
      // being abandoned either way, and a teardown that threw would let a
      // server hold a caller open.
      if (id === null || broken !== null) return;
      try {
        await fetch(server.url, {
          method: "DELETE",
          headers: {
            "mcp-session-id": id,
            "mcp-protocol-version": TOOL_MCP_PROTOCOL_VERSION,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(TOOL_HTTP_CLOSE_TIMEOUT_MS),
        });
      } catch {
        // A teardown that fails is not an error.
      }
    },
  });
}
