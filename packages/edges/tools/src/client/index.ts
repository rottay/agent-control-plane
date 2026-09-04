/**
 * The MCP client — `@acp/tools` (V2-B4b stage 1).
 *
 * `initialize`, `tools/list` and `tools/call`, over an injected transport, with
 * every answer bounded before it is returned. The transport is injected rather
 * than imported so that the protocol negatives — a malformed frame, an
 * unmatched id, a peer that never answers — can be driven as data instead of
 * being staged through a real child process, and so that the one file allowed
 * to spawn stays the one file that does.
 *
 * **No live conformance is claimed.** This client is written against the
 * published protocol and drilled against a fake server this repository owns.
 * No handshake with a third-party MCP server has been performed here, and the
 * package README says so in those words.
 */

import type { ToolRefusal } from "../contract/index.js";
import {
  TOOL_CALL_TIMEOUT_MS,
  TOOL_CONTENT_STRING_MAX,
  TOOL_MCP_CLIENT_NAME,
  TOOL_MCP_PROTOCOL_VERSION,
  TOOL_RESULT_BYTES_MAX,
} from "../contract/index.js";
import type { ToolFrameOutcome } from "../jsonrpc/index.js";
import {
  createToolCorrelator,
  createToolFrameReader,
  encodeToolFrame,
  toolFrameBytes,
  toolJsonRpcNotification,
  toolJsonRpcRequest,
} from "../jsonrpc/index.js";

/**
 * What the client needs of a transport, and nothing more.
 *
 * Deliberately not a duplex stream type: a stream would drag decoding,
 * back-pressure and error semantics across this seam, and the only thing the
 * client actually needs is "send me a line" and "here is a line".
 */
export interface ToolTransportConnection {
  readonly write: (frame: string) => void;
  /** Register the sink decoded stdout chunks are pushed into. Called once. */
  readonly subscribe: (sink: (chunk: string) => void) => void;
  /** The peer is gone. Pending requests must fail rather than hang forever. */
  readonly onEnd: (listener: () => void) => void;
  readonly close: () => Promise<void>;
}

export type ToolClientOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ToolRefusal; readonly at: string };

/** One bounded `tools/call` answer. */
export interface ToolCallResult {
  readonly content: readonly string[];
  readonly resultBytes: number;
  /** The raw result, for the caller's privacy guard. Never returned to a consumer. */
  readonly value: unknown;
}

export interface ToolClient {
  readonly initialize: () => Promise<ToolClientOutcome<string>>;
  readonly listTools: () => Promise<ToolClientOutcome<readonly string[]>>;
  readonly callTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<ToolClientOutcome<ToolCallResult>>;
  readonly close: () => Promise<void>;
}

const AT_RESPONSE = "server.response";
const AT_RESULT = "server.result";

function refused<T>(refusal: ToolRefusal, at: string): ToolClientOutcome<T> {
  return { ok: false, refusal, at };
}

interface Pending {
  readonly settle: (outcome: ToolClientOutcome<unknown>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Drive one connection.
 *
 * The client is **broken-once, broken-forever**. A framing violation, an
 * unmatched id or a peer that hangs up leaves the stream at an unknown offset,
 * and there is no honest way to resynchronize: the next bytes could be the
 * tail of a frame already refused. Every later request refuses immediately, so
 * a connection that has misbehaved cannot be coaxed into answering one more
 * time — which is the shape a caller reaches for when a tool "sometimes"
 * works.
 */
export function createToolClient(connection: ToolTransportConnection): ToolClient {
  const reader = createToolFrameReader();
  const correlator = createToolCorrelator();
  const pending = new Map<number, Pending>();
  let broken = false;
  let initialized = false;

  const breakAll = (): void => {
    broken = true;
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.settle(refused("PROTOCOL_VIOLATION", AT_RESPONSE));
    }
  };

  const accept = (outcome: ToolFrameOutcome): void => {
    if (!outcome.ok) {
      breakAll();
      return;
    }
    if (outcome.kind === "NOTIFICATION") return;
    const entry = pending.get(outcome.response.id);
    // An answer to a request this client never sent. The stream is no longer
    // one this client can reason about, so it is not merely ignored.
    if (entry === undefined || !correlator.close(outcome.response.id)) {
      breakAll();
      return;
    }
    pending.delete(outcome.response.id);
    clearTimeout(entry.timer);
    if (outcome.response.error !== null) {
      entry.settle(refused("PROTOCOL_VIOLATION", AT_RESPONSE));
      return;
    }
    entry.settle({ ok: true, value: outcome.response.result });
  };

  connection.subscribe((chunk: string): void => {
    for (const outcome of reader.push(chunk)) accept(outcome);
  });
  connection.onEnd((): void => {
    breakAll();
  });

  const request = async (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<ToolClientOutcome<unknown>> => {
    if (broken) return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
    const id = correlator.open();
    return await new Promise<ToolClientOutcome<unknown>>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        correlator.close(id);
        // A peer that accepted a call and never answered leaves the stream at
        // an unknown offset for the same reason a malformed frame does.
        broken = true;
        resolve(refused("PROTOCOL_VIOLATION", AT_RESPONSE));
      }, TOOL_CALL_TIMEOUT_MS);
      // A pending call must not hold the process open. Node's handle always
      // carries `unref`, but a caller running under substituted timers may
      // hand back one that does not, so the guard is real rather than
      // defensive and the type says which.
      (timer as { unref?: () => void }).unref?.();
      pending.set(id, { settle: resolve, timer });
      try {
        connection.write(encodeToolFrame(toolJsonRpcRequest(id, method, params)));
      } catch {
        pending.delete(id);
        correlator.close(id);
        clearTimeout(timer);
        broken = true;
        resolve(refused("PROTOCOL_VIOLATION", AT_RESPONSE));
      }
    });
  };

  const initialize = async (): Promise<ToolClientOutcome<string>> => {
    const outcome = await request("initialize", {
      protocolVersion: TOOL_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: TOOL_MCP_CLIENT_NAME, version: "0.0.0" },
    });
    if (!outcome.ok) return outcome;
    const result = outcome.value;
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
    }
    const info = (result as Record<string, unknown>)["serverInfo"];
    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
    }
    const name = (info as Record<string, unknown>)["name"];
    if (typeof name !== "string") return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
    try {
      connection.write(encodeToolFrame(toolJsonRpcNotification("notifications/initialized", {})));
    } catch {
      broken = true;
      return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
    }
    initialized = true;
    return { ok: true, value: name };
  };

  /** Handshake once per connection, and never twice. */
  const ready = async (): Promise<ToolClientOutcome<null>> => {
    if (initialized) return { ok: true, value: null };
    const outcome = await initialize();
    if (!outcome.ok) return outcome;
    return { ok: true, value: null };
  };

  return {
    initialize,

    async listTools(): Promise<ToolClientOutcome<readonly string[]>> {
      const start = await ready();
      if (!start.ok) return start;
      const outcome = await request("tools/list", {});
      if (!outcome.ok) return outcome;
      const result = outcome.value;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
      }
      const tools = (result as Record<string, unknown>)["tools"];
      if (!Array.isArray(tools)) return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
      const names: string[] = [];
      for (const tool of tools) {
        if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
          return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
        }
        const name = (tool as Record<string, unknown>)["name"];
        if (typeof name !== "string") return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
        names.push(name);
      }
      return { ok: true, value: Object.freeze(names) };
    },

    async callTool(
      name: string,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ToolClientOutcome<ToolCallResult>> {
      const start = await ready();
      if (!start.ok) return start;
      const outcome = await request("tools/call", { name, arguments: args });
      if (!outcome.ok) return outcome;

      const result = outcome.value;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
      }

      const serialized: unknown = JSON.stringify(result);
      const resultBytes = typeof serialized === "string" ? toolFrameBytes(serialized) : 0;
      // Refused, not truncated. A silently shortened tool result is a wrong
      // answer wearing a right answer's shape, and no caller can tell.
      if (resultBytes > TOOL_RESULT_BYTES_MAX) return refused("RESULT_UNBOUNDED", AT_RESULT);

      const blocks = (result as Record<string, unknown>)["content"];
      if (!Array.isArray(blocks)) return refused("PROTOCOL_VIOLATION", AT_RESPONSE);

      const content: string[] = [];
      for (const block of blocks) {
        if (typeof block !== "object" || block === null || Array.isArray(block)) {
          return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
        }
        const shape = block as Record<string, unknown>;
        // This client carries text and only text. An image, audio or embedded
        // resource block is refused rather than dropped, for the same reason
        // an oversized result is: omitting what cannot be represented would
        // hand the caller a shortened answer it has no way to recognize as
        // shortened. This is a limitation of this stage's client, stated as a
        // refusal instead of as a silence; a stage that carries non-text
        // content widens it here.
        if (shape["type"] !== "text") return refused("PROTOCOL_VIOLATION", AT_RESULT);
        const text = shape["text"];
        if (typeof text !== "string") return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
        if (toolFrameBytes(text) > TOOL_CONTENT_STRING_MAX) {
          return refused("RESULT_UNBOUNDED", AT_RESULT);
        }
        content.push(text);
      }

      return {
        ok: true,
        value: { content: Object.freeze(content), resultBytes, value: result },
      };
    },

    async close(): Promise<void> {
      breakAll();
      await connection.close();
    },
  };
}
