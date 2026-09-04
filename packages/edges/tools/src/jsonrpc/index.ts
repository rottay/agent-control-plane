/**
 * JSON-RPC 2.0 over newline-delimited frames — `@acp/tools` (V2-B4b stage 1).
 *
 * Pure framing: encode, accumulate, bound, parse, correlate. No transport, no
 * I/O, no timers, nothing spawned. Splitting the codec from the transport is
 * what lets the nasty cases — a frame split across two chunks, an oversized
 * frame, an unmatched id — be driven as data rather than staged through a real
 * child process.
 *
 * This is MCP's stdio wire format: one JSON-RPC message per line, UTF-8, and
 * no embedded newline inside a message. This repository already hand-rolls two
 * provider wire protocols against offline specifications and adds no
 * dependency for either; the same choice is made here, and the same disclaimer
 * applies — see the package README on what live conformance is and is not
 * claimed.
 */

import type { ToolRefusal } from "../contract/index.js";
import { TOOL_FRAME_BYTES_MAX } from "../contract/index.js";

/** Where every framing refusal is reported. One `at`, because it is one wire. */
const AT_SERVER_RESPONSE = "server.response";

const encoder = new TextEncoder();

/** UTF-8 size of a frame, which is what the ceiling is denominated in. */
export function toolFrameBytes(text: string): number {
  return encoder.encode(text).byteLength;
}

export interface ToolJsonRpcError {
  readonly code: number;
  readonly message: string;
}

/** A server's answer to one request, already correlated by id. */
export interface ToolJsonRpcResponse {
  readonly id: number;
  readonly result: unknown;
  readonly error: ToolJsonRpcError | null;
}

/**
 * What one decoded line turned out to be.
 *
 * Notifications are a real part of the protocol and are surfaced rather than
 * refused: a server that logs progress is not a server violating anything. The
 * client ignores them. Refusing them would make this client fail against
 * conformant peers, which is a worse error than tolerating a message we have
 * no use for.
 */
export type ToolFrameOutcome =
  | { readonly ok: true; readonly kind: "RESPONSE"; readonly response: ToolJsonRpcResponse }
  | { readonly ok: true; readonly kind: "NOTIFICATION"; readonly method: string }
  | { readonly ok: false; readonly refusal: ToolRefusal; readonly at: string };

function violation(): ToolFrameOutcome {
  return { ok: false, refusal: "PROTOCOL_VIOLATION", at: AT_SERVER_RESPONSE };
}

/**
 * Serialize one message as a frame.
 *
 * `JSON.stringify` escapes newlines inside strings, so a serialized message
 * cannot contain a literal one — but the invariant is asserted rather than
 * assumed, because it is the invariant the whole framing rests on.
 */
export function encodeToolFrame(message: Readonly<Record<string, unknown>>): string {
  const line = JSON.stringify(message);
  if (line.includes("\n")) {
    throw new Error("a JSON-RPC frame may not contain an embedded newline");
  }
  return line + "\n";
}

/** Build one JSON-RPC request object, ready to be framed. */
export function toolJsonRpcRequest(
  id: number,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, method, params };
}

/** Build one JSON-RPC notification object, ready to be framed. */
export function toolJsonRpcNotification(
  method: string,
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", method, params };
}

/** Decode one already-delimited line. */
function decodeLine(line: string): ToolFrameOutcome {
  if (toolFrameBytes(line) > TOOL_FRAME_BYTES_MAX) return violation();

  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return violation();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return violation();
  }
  const record = parsed as Record<string, unknown>;
  if (record["jsonrpc"] !== "2.0") return violation();

  const id = record["id"];
  if (id === undefined || id === null) {
    const method = record["method"];
    if (typeof method !== "string") return violation();
    return { ok: true, kind: "NOTIFICATION", method };
  }
  // Request ids are minted by this client as a monotonic counter, so a
  // non-integer id is not an id this client can have sent.
  if (typeof id !== "number" || !Number.isInteger(id)) return violation();

  const error = record["error"];
  if (error !== undefined && error !== null) {
    if (typeof error !== "object" || Array.isArray(error)) return violation();
    const shape = error as Record<string, unknown>;
    const code = shape["code"];
    const message = shape["message"];
    if (typeof code !== "number" || typeof message !== "string") return violation();
    return { ok: true, kind: "RESPONSE", response: { id, result: null, error: { code, message } } };
  }

  if (!Object.hasOwn(record, "result")) return violation();
  return { ok: true, kind: "RESPONSE", response: { id, result: record["result"], error: null } };
}

export interface ToolFrameReader {
  /** Feed one decoded chunk; returns every frame it completed, in order. */
  readonly push: (chunk: string) => readonly ToolFrameOutcome[];
  /** Bytes currently held in an unterminated frame. */
  readonly pending: () => number;
}

/**
 * Accumulate chunks into frames.
 *
 * The carry-over is the whole point. A chunk boundary lands wherever the
 * operating system put it, never where a frame ends, so a reader that assumed
 * whole frames per chunk would pass every test written against a fake that
 * cooperates and fail against every real stream.
 *
 * The ceiling is enforced on the *unterminated* buffer as well as on completed
 * frames: a peer that sends 200KB with no newline must be refused while it is
 * still sending, not after it finishes, and holding the buffer until then is
 * the unbounded allocation the ceiling exists to prevent. Once the bound is
 * breached the buffer is dropped and the reader stays in a refusing state —
 * resynchronizing at the next newline would mean parsing the tail of a frame
 * that was already rejected as if it were a new one.
 */
export function createToolFrameReader(): ToolFrameReader {
  let buffer = "";
  let refused = false;

  return {
    push(chunk: string): readonly ToolFrameOutcome[] {
      if (refused) return [violation()];
      const out: ToolFrameOutcome[] = [];
      buffer += chunk;

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) out.push(decodeLine(line));
        newline = buffer.indexOf("\n");
      }

      if (toolFrameBytes(buffer) > TOOL_FRAME_BYTES_MAX) {
        buffer = "";
        refused = true;
        out.push(violation());
      }
      return out;
    },
    pending(): number {
      return toolFrameBytes(buffer);
    },
  };
}

export interface ToolCorrelator {
  /** Mint the next request id and mark it outstanding. */
  readonly open: () => number;
  /** Settle an id; `false` if it was never outstanding. */
  readonly close: (id: number) => boolean;
  readonly outstanding: () => number;
}

/**
 * Correlate responses to requests by id.
 *
 * The counter is what lets the fence ban `crypto.randomUUID(` outright: ids
 * are per-connection and monotonic, so nothing in this package needs a source
 * of randomness, and a receipt built downstream of it stays a pure function of
 * the call.
 */
export function createToolCorrelator(): ToolCorrelator {
  let next = 0;
  const live = new Set<number>();

  return {
    open(): number {
      next += 1;
      live.add(next);
      return next;
    },
    close(id: number): boolean {
      return live.delete(id);
    },
    outstanding(): number {
      return live.size;
    },
  };
}
