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
  TOOL_CURSOR_BYTES_MAX,
  TOOL_LIST_DEADLINE_MS,
  TOOL_LIST_PAGES_MAX,
  TOOL_LIST_TOOLS_MAX,
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
import { jsonEqual } from "../schema-equality/index.js";

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
  | {
      readonly ok: false;
      readonly refusal: ToolRefusal;
      readonly at: string;
      /**
       * The counts of a result that arrived and was then declined (P-11).
       * Absent where no result was in hand — a transport refusal records
       * zero, because zero is the truth there.
       */
      readonly result?: { readonly resultBytes: number; readonly contentBlocks: number };
    };

/** One bounded `tools/call` answer. */
export interface ToolCallResult {
  readonly content: readonly string[];
  readonly resultBytes: number;
  /** The raw result, for the caller's privacy guard. Never returned to a consumer. */
  readonly value: unknown;
  /**
   * Whether the result held structured content, which one of `content`'s blocks
   * carries by JSON value (P-24/B(b), ADR 0117). The client stays pin-free: the
   * port, which holds the entry, decides what its absence means.
   */
  readonly structured: boolean;
}

/**
 * One tool a server advertised, as far as this client reads it (P-24).
 *
 * `outputSchema` is present exactly when the tool advertised one (P-24/B(b), ADR
 * 0117); the port reads its absence as none. Absent rather than `null`, so a
 * listing of tools that advertise no output schema reads as it did before.
 */
export interface AdvertisedTool {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface ToolClient {
  readonly initialize: () => Promise<ToolClientOutcome<string>>;
  /**
   * The server's whole listing, every page followed (P-24, ADR 0109).
   *
   * A `notifications/tools/list_changed` that arrives while the listing is in
   * progress restarts it, once; a second is `RESULT_UNBOUNDED`.
   */
  readonly listTools: () => Promise<ToolClientOutcome<readonly AdvertisedTool[]>>;
  /**
   * Whether a `notifications/tools/list_changed` arrived since the last listing
   * finished, and clear it. The port reads it after obtaining a listing and
   * before sending a call.
   */
  readonly takeListChanged: () => boolean;
  readonly callTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<ToolClientOutcome<ToolCallResult>>;
  readonly close: () => Promise<void>;
}

const AT_RESPONSE = "server.response";
const AT_RESULT = "server.result";
const AT_TOOLS = "server.tools";
const AT_CURSOR = "server.tools.nextCursor";

/**
 * Where a structured result is refused (P-24/B(b), ADR 0117). Exported for the
 * port's presence rule, so the path is spelled once; the field itself is read
 * only in `callTool` below.
 */
export const AT_STRUCTURED_RESULT = "server.result.structuredContent";

/** The notification that invalidates a listing (MCP 2025-06-18, tools). */
const LIST_CHANGED = "notifications/tools/list_changed";

function refused<T>(
  refusal: ToolRefusal,
  at: string,
  result?: { readonly resultBytes: number; readonly contentBlocks: number },
): ToolClientOutcome<T> {
  return result === undefined ? { ok: false, refusal, at } : { ok: false, refusal, at, result };
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
  // Set by a `list_changed` notification; read by the listing and the port.
  let listChanged = false;

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
    if (outcome.kind === "NOTIFICATION") {
      // A flag, not a reader: the listing and the port read it at their own
      // points. Every other notification is recognized and dropped, as before.
      if (outcome.method === LIST_CHANGED) listChanged = true;
      return;
    }
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
    // V2-B4b S4-1. The revision the server agreed, compared rather than
    // assumed. Over stdio this was a fidelity gap; over HTTP it is a
    // contradiction, because the client asserts a revision in a header on every
    // single request while never having agreed one. Applied to **both**
    // transports: a check that fired on one only would be a parity break.
    const agreed = (result as Record<string, unknown>)["protocolVersion"];
    if (typeof agreed !== "string" || agreed !== TOOL_MCP_PROTOCOL_VERSION) {
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

  /**
   * Every page of one listing, each rule checked where it applies (P-24).
   *
   * `nextCursor` absent ends the listing. `null`, a non-string and `""` are
   * `PROTOCOL_VIOLATION`: the reference SDKs type it optional and not nullable,
   * and an empty cursor is the plane's own refusal. A repeated cursor (a cycle)
   * and a tool name advertised twice (the allowlist is keyed by name, the
   * plane's rule) are violations too; a cursor over its bytes, a page past
   * `TOOL_LIST_PAGES_MAX`, a tool past `TOOL_LIST_TOOLS_MAX` and an expired
   * deadline are `RESULT_UNBOUNDED`, refused and never truncated.
   */
  const listAllPages = async (
    isExpired: () => boolean,
  ): Promise<ToolClientOutcome<readonly AdvertisedTool[]>> => {
    const tools: AdvertisedTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 1; ; page += 1) {
      const outcome = await request("tools/list", cursor === null ? {} : { cursor });
      if (!outcome.ok) return outcome;
      const result = outcome.value;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
      }
      const shape = result as Record<string, unknown>;
      const listed = shape["tools"];
      if (!Array.isArray(listed)) return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
      for (const tool of listed as readonly unknown[]) {
        if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
          return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
        }
        const name = (tool as Record<string, unknown>)["name"];
        const inputSchema = (tool as Record<string, unknown>)["inputSchema"];
        if (typeof name !== "string") return refused("PROTOCOL_VIOLATION", AT_RESPONSE);
        // The revision requires a schema on every tool.
        if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
          return refused("PROTOCOL_VIOLATION", AT_TOOLS);
        }
        // P-24/B(b): an output schema is optional and, when present, an object.
        // Present and `null`, an array or a scalar is a violation — optional is not
        // nullable, the reading `nextCursor` already has. Its `type` is not judged
        // here: a non-object type never equals an admitted pin, so the port's
        // comparison refuses it.
        const outputSchema = (tool as Record<string, unknown>)["outputSchema"];
        const advertisesOutput = Object.hasOwn(tool, "outputSchema");
        if (
          advertisesOutput &&
          (typeof outputSchema !== "object" || outputSchema === null || Array.isArray(outputSchema))
        ) {
          return refused("PROTOCOL_VIOLATION", AT_TOOLS);
        }
        if (names.has(name)) return refused("PROTOCOL_VIOLATION", AT_TOOLS);
        names.add(name);
        if (tools.length === TOOL_LIST_TOOLS_MAX) return refused("RESULT_UNBOUNDED", AT_TOOLS);
        const input = inputSchema as Readonly<Record<string, unknown>>;
        tools.push(
          Object.freeze(
            advertisesOutput
              ? { name, inputSchema: input, outputSchema: outputSchema as Readonly<Record<string, unknown>> }
              : { name, inputSchema: input },
          ),
        );
      }
      if (!Object.hasOwn(shape, "nextCursor")) return { ok: true, value: Object.freeze(tools) };
      const next = shape["nextCursor"];
      if (typeof next !== "string" || next === "") return refused("PROTOCOL_VIOLATION", AT_CURSOR);
      if (toolFrameBytes(next) > TOOL_CURSOR_BYTES_MAX) return refused("RESULT_UNBOUNDED", AT_CURSOR);
      if (cursors.has(next)) return refused("PROTOCOL_VIOLATION", AT_CURSOR);
      cursors.add(next);
      if (page === TOOL_LIST_PAGES_MAX) return refused("RESULT_UNBOUNDED", AT_TOOLS);
      // Read between pages: after this page's response, before the next request.
      if (isExpired()) return refused("RESULT_UNBOUNDED", AT_TOOLS);
      cursor = next;
    }
  };

  return {
    initialize,

    async listTools(): Promise<ToolClientOutcome<readonly AdvertisedTool[]>> {
      const start = await ready();
      if (!start.ok) return start;
      // One listing-level deadline, read between pages and never mid-request
      // (C4): the stream stays at a known offset, so an expired listing keeps
      // its connection. No clock is read; the timer only sets a flag.
      let expired = false;
      const deadline = setTimeout(() => {
        expired = true;
      }, TOOL_LIST_DEADLINE_MS);
      (deadline as { unref?: () => void }).unref?.();
      try {
        // A change announced while the listing is being assembled would mix two
        // generations of it: restart once, and refuse a second.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          listChanged = false;
          const listing = await listAllPages(() => expired);
          if (!listing.ok) return listing;
          // Read through a cast: the flag is set by `accept`, across the await,
          // which the compiler's narrowing of the assignment above cannot see.
          if (!(listChanged as boolean)) return listing;
        }
        return refused("RESULT_UNBOUNDED", AT_TOOLS);
      } finally {
        clearTimeout(deadline);
      }
    },

    takeListChanged(): boolean {
      const was = listChanged;
      listChanged = false;
      return was;
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
      // P-11 (W3): a refusal whose receipt recorded zero after a result was
      // already in hand would be a false number in a durable row, so the
      // counts travel with every decline that had a result. The block count
      // is the array's own length, known without parsing a single block.
      const rawBlocks: unknown = (result as Record<string, unknown>)["content"];
      const received = {
        resultBytes,
        contentBlocks: Array.isArray(rawBlocks) ? rawBlocks.length : 0,
      } as const;
      if (resultBytes > TOOL_RESULT_BYTES_MAX) return refused("RESULT_UNBOUNDED", AT_RESULT, received);

      // P-11 (W1/N-5/N-6): a result the server marks `isError` is the server
      // reporting that the tool failed, and a failed tool is never carried as
      // a success — whatever the transport said. Absence and the literal
      // `false` complete; any other value is a malformed flag and fails
      // closed, because nothing here may coerce into success by default.
      //
      // W2/N-9: the content of an error result is the server's error message,
      // and it is discarded whole. The refused arm carries no content, and a
      // partially filtered result is one the caller cannot tell from a whole
      // one — the same law RESULT_UNSAFE holds downstream. Carrying it to
      // the caller is a later packet, declared in the README rather than
      // left implicit.
      const errorFlag: unknown = (result as Record<string, unknown>)["isError"];
      if (errorFlag !== undefined && errorFlag !== false) {
        if (errorFlag !== true) return refused("PROTOCOL_VIOLATION", AT_RESULT, received);
        return refused("RESULT_IS_ERROR", AT_RESULT, received);
      }

      const blocks = rawBlocks;
      if (!Array.isArray(blocks)) return refused("PROTOCOL_VIOLATION", AT_RESPONSE, received);

      const content: string[] = [];
      for (const block of blocks) {
        if (typeof block !== "object" || block === null || Array.isArray(block)) {
          return refused("PROTOCOL_VIOLATION", AT_RESPONSE, received);
        }
        const shape = block as Record<string, unknown>;
        // This client carries text and only text. An image, audio or embedded
        // resource block is refused rather than dropped, for the same reason
        // an oversized result is: omitting what cannot be represented would
        // hand the caller a shortened answer it has no way to recognize as
        // shortened. This is a limitation of this stage's client, stated as a
        // refusal instead of as a silence; a stage that carries non-text
        // content widens it here.
        if (shape["type"] !== "text") return refused("PROTOCOL_VIOLATION", AT_RESULT, received);
        const text = shape["text"];
        if (typeof text !== "string") return refused("PROTOCOL_VIOLATION", AT_RESPONSE, received);
        if (toolFrameBytes(text) > TOOL_CONTENT_STRING_MAX) {
          return refused("RESULT_UNBOUNDED", AT_RESULT, received);
        }
        content.push(text);
      }

      // P-24/B(b), ADR 0117: structured content, judged last, after every block.
      // The client carries text and only text, so a structured value is carried
      // only when a text block already holds it: some block that parses to a
      // JSON value equal to it, by the one value equality. Any block may be the
      // mirror, since the revision names no position. A block that is not JSON
      // is simply not a mirror. An unmirrored value is declined whole, never
      // dropped: the peer omitted a SHOULD and is still speaking the protocol, so
      // the word is RESULT_NOT_CARRIED and the connection is kept. A value that
      // is not a JSON object breaks a MUST and is a violation. Nothing here
      // validates the value against any schema.
      if (!Object.hasOwn(result, "structuredContent")) {
        return {
          ok: true,
          value: { content: Object.freeze(content), resultBytes, value: result, structured: false },
        };
      }
      const structuredContent: unknown = (result as Record<string, unknown>)["structuredContent"];
      if (typeof structuredContent !== "object" || structuredContent === null || Array.isArray(structuredContent)) {
        return refused("PROTOCOL_VIOLATION", AT_STRUCTURED_RESULT, received);
      }
      const mirrored = content.some((text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return false;
        }
        return jsonEqual(parsed, structuredContent);
      });
      if (!mirrored) return refused("RESULT_NOT_CARRIED", AT_STRUCTURED_RESULT, received);

      return {
        ok: true,
        value: { content: Object.freeze(content), resultBytes, value: result, structured: true },
      };
    },

    async close(): Promise<void> {
      breakAll();
      await connection.close();
    },
  };
}
