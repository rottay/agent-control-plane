import type { AdapterErrorCode } from "../errors/index.js";
import { AdapterError } from "../errors/index.js";

import type { SseContext, SseEvent } from "./types/index.js";

/**
 * The shared SSE transport of the two HTTP leaves (P-15 escalón E, ADR 0108).
 *
 * One byte reader and one failure classifier, for the Anthropic Messages leaf and
 * the OpenAI-compatible local leaf alike, so that what the loopback drill proves
 * over a real socket for one leaf — frame boundaries, a multibyte character split
 * across two reads, CRLF line ends — is proved for both (Fable C-E9).
 *
 * **Bytes in, events out, and nothing else.** The reader decodes UTF-8 strictly
 * across chunk boundaries (a byte that is not UTF-8 is `MALFORMED_EVENT`, never a
 * replacement character), splits lines on LF, CRLF or CR, and yields one event per
 * blank line with its `event:` and `data:` fields. A comment line (`:`) and a field
 * it does not know are ignored, as the SSE framing specifies. It is bounded: an event
 * over {@link SSE_EVENT_MAX_CHARS} is refused rather than buffered without limit.
 *
 * **The classifier never reads a message.** A failure `fetch` raises is classified by
 * its `name` alone, by membership in a closed set, and becomes one closed adapter
 * code. Node's `Headers` quotes a value it refuses in its message
 * (Fable, measured on Node 22.17), so a message may carry a secret; it is never read,
 * never passed on as a `cause`, never stringified (C-E7). Nothing here names a network
 * builtin: `fetch` is the leaves', and it is global.
 */

export type { SseContext, SseEvent } from "./types/index.js";

/** The most characters one event may carry before the reader refuses it. */
export const SSE_EVENT_MAX_CHARS = 1_048_576;

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

/**
 * Read a response body as server-sent events.
 *
 * `body` is the response's byte stream. A read that rejects (a reset mid-stream)
 * propagates to the caller, whose classifier names it; this function adds no text.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  context: SseContext,
): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = body.getReader();
  let pending = "";
  let event: string | null = null;
  let data: string[] = [];
  let size = 0;
  let finished = false;

  const refuse = (): never => {
    throw new AdapterError("MALFORMED_EVENT", context);
  };
  const decode = (bytes: Uint8Array | undefined, flush: boolean): string => {
    try {
      return flush ? decoder.decode() : decoder.decode(bytes, { stream: true });
    } catch {
      return refuse();
    }
  };

  // One line, already stripped of its terminator; returns the event it completes, if any.
  const line = (text: string): SseEvent | null => {
    if (text === "") {
      if (data.length === 0 && event === null) return null;
      const completed: SseEvent = { event, data: data.join("\n") };
      event = null;
      data = [];
      size = 0;
      return completed;
    }
    if (text.startsWith(":")) return null;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    size += value.length;
    if (size > SSE_EVENT_MAX_CHARS) refuse();
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done ? decode(undefined, true) : decode(value, false);
      for (;;) {
        let end = -1;
        let skip = 1;
        for (let index = 0; index < pending.length; index += 1) {
          const code = pending.charCodeAt(index);
          if (code === LINE_FEED) {
            end = index;
            break;
          }
          if (code === CARRIAGE_RETURN) {
            // A CR at the very end may be the first half of a CRLF split across
            // two reads; wait for the next read unless the stream has ended.
            if (index === pending.length - 1 && !done) break;
            end = index;
            skip = pending.charCodeAt(index + 1) === LINE_FEED ? 2 : 1;
            break;
          }
        }
        if (end === -1) break;
        const completed = line(pending.slice(0, end));
        pending = pending.slice(end + skip);
        if (completed !== null) yield completed;
      }
      // What is left is one unterminated line, bounded like an event.
      if (pending.length > SSE_EVENT_MAX_CHARS) refuse();
      if (done) {
        // A final event without its blank line is still an event the server sent.
        if (pending !== "") {
          const completed = line(pending);
          pending = "";
          if (completed !== null) yield completed;
        }
        const last = line("");
        finished = true;
        if (last !== null) yield last;
        return;
      }
    }
  } finally {
    // A consumer that stops early (a terminal frame, a refusal) leaves bytes
    // unread: the body is cancelled so the connection is released, silently.
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // Nothing to report: the stream is abandoned either way.
      }
    }
    reader.releaseLock();
  }
}

/** The error names `AbortSignal.timeout` produces when it fires. */
const TIMEOUT_NAMES: ReadonlySet<string> = new Set(["TimeoutError", "AbortError"]);

/**
 * Classify a failure the transport raised, by its name only (C-E7).
 *
 * An `AdapterError` a leaf already raised keeps its own code. A name in
 * {@link TIMEOUT_NAMES} is `REQUEST_TIMEOUT`. Everything else — `fetch failed` with
 * any cause (refused, reset, lookup, TLS), a `Headers` TypeError, an
 * `AggregateError`, a reset while the body is read — is `PROVIDER_UNREACHABLE`:
 * the leaf fails closed to the one word that is true of all of them. The caught
 * value's message, its `cause` and its string form are never read, because no
 * distinction this port could use lives there and a secret might.
 */
export function classifyTransportFailure(error: unknown): AdapterErrorCode {
  if (error instanceof AdapterError) return error.code;
  const name = typeof error === "object" && error !== null && "name" in error ? (error as { readonly name: unknown }).name : null;
  if (typeof name === "string" && TIMEOUT_NAMES.has(name)) return "REQUEST_TIMEOUT";
  return "PROVIDER_UNREACHABLE";
}

/** What a response's status and content type make of it, before a byte of its body is read. */
export type StatusVerdict =
  | { readonly kind: "STREAM" }
  | { readonly kind: "AUTH_REQUIRED"; readonly reason: "AUTHENTICATION_ERROR" | "PERMISSION_DENIED" }
  | { readonly kind: "REFUSED"; readonly code: AdapterErrorCode };

/**
 * The whole status table (C-E7, ADR 0108), shared by both leaves.
 *
 * A body other than a 2xx event stream is never read: the verdict comes from the
 * status and the content type alone, and the leaf cancels the body.
 */
export function classifyResponse(response: Response): StatusVerdict {
  const status = response.status;
  if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
    return { kind: "REFUSED", code: "REDIRECT_REFUSED" };
  }
  if (status === 401) return { kind: "AUTH_REQUIRED", reason: "AUTHENTICATION_ERROR" };
  if (status === 403) return { kind: "AUTH_REQUIRED", reason: "PERMISSION_DENIED" };
  if (status === 429 || status === 529) return { kind: "REFUSED", code: "PROVIDER_RATE_LIMITED" };
  if (status < 200 || status >= 300) return { kind: "REFUSED", code: "PROVIDER_HTTP_ERROR" };
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("text/event-stream")) return { kind: "REFUSED", code: "PROTOCOL_UNSUPPORTED" };
  return { kind: "STREAM" };
}

/** Release a response's connection without reading a byte of its body. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to report: the body is discarded either way, and a failure to
    // cancel carries no word this caller could use.
  }
}
