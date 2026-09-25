/**
 * `ToolProtocolPort` — `@acp/tools` (V2-B4b stage 1).
 *
 * The plane's own authority to call a tool: scoped to a live execution
 * session, bounded by a per-server allowlist and a role allowlist, and
 * answering every call — refused or completed — with a bounded receipt.
 *
 * **The plane is the MCP client. It is not an MCP proxy in front of the
 * agent.** Interposing on a provider child's own tool traffic needs a
 * provider-side MCP configuration surface and a confirmed provider capability,
 * and this repository's capability model refuses to confirm one against a fake
 * subject. That is a later boundary, named and left there.
 *
 * The port lives in this edge package rather than in `@acp/contracts` for the
 * reason the kernel's barrel diet states: a kernel port earns its place when an
 * independent party must agree with it, and this port's only agreeing party
 * will be the daemon, which takes a direct dependency on this package once
 * stage 3 composes it. Nothing depends on it today. When a domain takes it by
 * injection, that is the trigger to move the type — and the move is a decision
 * somebody makes on purpose.
 */

import { parseWorkerIdentity } from "@acp/contracts";

import type { AdmittedToolServer } from "../admission/index.js";
import type { AdvertisedTool, ToolClient, ToolClientOutcome, ToolTransportConnection } from "../client/index.js";
import { AT_STRUCTURED_RESULT, createToolClient } from "../client/index.js";
import type { ToolAllowlistEntry, ToolCallRequest, ToolRefusal } from "../contract/index.js";
import {
  TOOL_ARGUMENTS_BYTES_MAX,
  TOOL_SERVER_LIFETIME_MS,
  TOOL_TRANSPORT_UNRESOLVED,
  holdsToolWriteAuthority,
} from "../contract/index.js";
import { toolFrameBytes } from "../jsonrpc/index.js";
import type { ToolCallReceipt } from "../receipt/index.js";
import { toolReceipt, toolResultIsUnsafe } from "../receipt/index.js";
import { jsonEqual } from "../schema-equality/index.js";
import type { ToolHttpLoopbackConnection } from "../http-loopback/index.js";
import { openToolHttpLoopbackConnection } from "../http-loopback/index.js";
import { openToolStdioConnection } from "../stdio/index.js";

/**
 * The liveness join, read and never pushed.
 *
 * A predicate rather than a subscription is what keeps the provider edge free
 * of any knowledge that this package exists. The harness reports which
 * execution sessions are live; this port asks. Nothing flows the other way,
 * and no callback has to be unregistered when a session ends.
 */
export interface SessionLiveness {
  readonly isLive: (sessionId: string) => boolean;
}

export interface ToolProtocolPortInput {
  readonly servers: readonly AdmittedToolServer[];
  readonly liveness: SessionLiveness;
  /** The child's hard backstop, for suites that need to observe it. */
  readonly serverLifetimeMs?: number;
}

export type ToolCallOutcome =
  | { readonly ok: true; readonly receipt: ToolCallReceipt; readonly content: readonly string[] }
  | {
      readonly ok: false;
      readonly receipt: ToolCallReceipt;
      readonly refusal: ToolRefusal;
      readonly at: string;
    };

/**
 * What a listing answers (P-24, ADR 0109; P-24/B(a), ADR 0118).
 *
 * `toolName` is present on a refusal exactly when the refusal is
 * `SCHEMA_MISMATCH`, and names the first allowlist entry, in allowlist order,
 * whose pin the advertisement did not match. It is a field of its own rather
 * than a segment of `at` because a bounded name (up to 120 characters) spliced
 * into the path would overflow the protocol's 120-character `at`; `at` still
 * says which schema differed. Every other refusal names no tool: it is about
 * the session, the admission or the wire, not about one entry.
 */
export type ToolListingOutcome =
  | { readonly ok: true; readonly tools: readonly ToolAllowlistEntry[] }
  | { readonly ok: false; readonly refusal: ToolRefusal; readonly at: string; readonly toolName?: string };

export interface ToolProtocolPort {
  readonly listTools: (sessionId: string, serverId: string) => Promise<ToolListingOutcome>;
  readonly callTool: (request: ToolCallRequest) => Promise<ToolCallOutcome>;
  readonly closeAll: () => Promise<readonly string[]>;
}

interface Connection {
  readonly sessionId: string;
  /**
   * Widened to the shared seam at V2-B4b S4-1, because a session may now hold a
   * spawned child or a loopback endpoint. **`pid` is stdio-only and is not
   * hoisted here**: a shared type carrying a pid would make every reaper claim
   * a child exists, and one of the two transports has none.
   */
  readonly transport: ToolTransportConnection;
  readonly client: ToolClient;
  /**
   * The listing this connection last saw, or null before the first (P-24). A
   * `list_changed` notification invalidates it: the port re-lists before it
   * trusts it again.
   */
  listing: readonly AdvertisedTool[] | null;
}

/**
 * The out-of-band refusal a loopback connection recorded, or null.
 *
 * Structural rather than a `kind` check: the port holds the shared seam, and
 * asking whether the object can answer is what keeps the stdio leg — which
 * cannot — from needing a branch of its own.
 */
function transportRefusalOf(
  transport: ToolTransportConnection,
): { readonly refusal: ToolRefusal; readonly at: string } | null {
  const carrier = transport as Partial<ToolHttpLoopbackConnection>;
  return typeof carrier.transportRefusal === "function" ? carrier.transportRefusal() : null;
}

/** One execution's tool server never serves another's. */
function connectionKey(sessionId: string, serverId: string): string {
  return sessionId + "/" + serverId;
}

export function createToolProtocolPort(input: ToolProtocolPortInput): ToolProtocolPort {
  const servers = new Map(input.servers.map((server) => [server.serverId, server]));
  const connections = new Map<string, Connection>();
  const lifetimeMs = input.serverLifetimeMs ?? TOOL_SERVER_LIFETIME_MS;

  const drop = async (key: string): Promise<void> => {
    const connection = connections.get(key);
    if (connection === undefined) return;
    connections.delete(key);
    await connection.client.close();
  };

  /**
   * Close every connection whose session has stopped being live.
   *
   * Lazy, and run before every operation. There is no notification from the
   * harness and no subscription to keep in step with it, which is exactly what
   * keeps the coupling one-directional. The cost is that a dead session's
   * child survives until the next call on this port — named here rather than
   * left for someone to discover, and the reason a caller with many concurrent
   * sessions will eventually want a real sweep hook.
   */
  const sweep = async (): Promise<void> => {
    for (const [key, connection] of [...connections]) {
      if (!input.liveness.isLive(connection.sessionId)) await drop(key);
    }
  };

  const connect = (sessionId: string, server: AdmittedToolServer): Connection => {
    const key = connectionKey(sessionId, server.serverId);
    const existing = connections.get(key);
    if (existing !== undefined) return existing;
    // The one place the two legs are chosen between. Narrowed on the existing
    // `kind` member, so the union does the work and no cast appears.
    const transport =
      server.kind === "STDIO"
        ? openToolStdioConnection(server, lifetimeMs)
        : openToolHttpLoopbackConnection(server);
    const connection: Connection = { sessionId, transport, client: createToolClient(transport), listing: null };
    connections.set(key, connection);
    return connection;
  };

  /**
   * The listing a call or a listing may trust (P-24, ADR 0109; C5).
   *
   * The cached one unless a `list_changed` invalidated it. A change announced
   * while the client assembles a listing is the client's to handle: it restarts
   * that listing once (a notification in the same read as the last page is
   * consumed there, before `listTools` returns). The second read of the flag
   * below, after obtaining the listing and before anything is sent, is a
   * **guard** for a transport that yields between the listing and the send: on
   * stdio nothing does (the chain to the call's write is microtasks only, so no
   * frame can arrive there), and on loopback only the SSE reader's `await`
   * continuations can interleave, nondeterministically. No deterministic row
   * reaches it. A second change there is `RESULT_UNBOUNDED`. What this guarantees
   * is a precondition, not a transaction: no `tools/call` is sent on a connection
   * whose last listing did not advertise the pinned schema. A change after that
   * — on stdio, after the call frame is written; or from a server that never
   * notifies — is not seen by the call.
   */
  const trustedListing = async (connection: Connection): Promise<ToolClientOutcome<readonly AdvertisedTool[]>> => {
    if (connection.listing === null || connection.client.takeListChanged()) {
      const listed = await connection.client.listTools();
      if (!listed.ok) return listed;
      connection.listing = listed.value;
    }
    if (connection.client.takeListChanged()) {
      const relisted = await connection.client.listTools();
      if (!relisted.ok) return relisted;
      connection.listing = relisted.value;
      if (connection.client.takeListChanged()) {
        connection.listing = null;
        return { ok: false, refusal: "RESULT_UNBOUNDED", at: "server.tools" };
      }
    }
    return { ok: true, value: connection.listing };
  };

  /**
   * Where the pinned tool's listing disagrees with its pin, or null when it agrees.
   *
   * The paths carry no tool name: the request already names the tool, and a
   * bounded name (up to 120 characters) spliced into `server.tools.<name>.inputSchema`
   * would overflow the protocol's 120-character `at`. `server.tools` says the tool
   * was not advertised; `server.tools.inputSchema` says it was, under another schema;
   * `server.tools.outputSchema` (P-24/B(b), ADR 0117) says its input matched and its
   * output interface did not. Input is judged before output, so a tool whose two
   * schemas both differ has one answer. A tool that advertises no output schema, and
   * an entry with no output pin, are each read as none: `null` equals only `null`.
   */
  const mismatchOf = (listing: readonly AdvertisedTool[], entry: ToolAllowlistEntry): string | null => {
    const advertised = listing.find((tool) => tool.name === entry.name);
    if (advertised === undefined) return "server.tools";
    if (!jsonEqual(advertised.inputSchema, entry.inputSchema)) return "server.tools.inputSchema";
    return jsonEqual(advertised.outputSchema ?? null, entry.outputSchema ?? null) ? null : "server.tools.outputSchema";
  };

  return {
    async listTools(sessionId: string, serverId: string): Promise<ToolListingOutcome> {
      await sweep();
      if (!input.liveness.isLive(sessionId)) {
        return { ok: false, refusal: "SESSION_NOT_LIVE", at: "request.sessionId" };
      }
      const server = servers.get(serverId);
      if (server === undefined) {
        return { ok: false, refusal: "SERVER_NOT_ADMITTED", at: "request.serverId" };
      }

      let connection: Connection;
      try {
        connection = connect(sessionId, server);
      } catch {
        return { ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.process" };
      }

      // The rule `callTool` applies at its step 7, applied here too (P-24/B(a),
      // ADR 0118): the loopback leg records a transport refusal out of band, so
      // a refused redirect during a listing would otherwise reach the caller as
      // the client's `PROTOCOL_VIOLATION` at `server.response`. Where one was
      // recorded it is preferred, word and `at`. The drop is the rule's too, but
      // recording a refusal ends the loopback connection, which settles the
      // client with `PROTOCOL_VIOLATION`, so on every path a row can drive the
      // first disjunct already drops; the second is carried by this reading.
      const listed = await trustedListing(connection);
      if (!listed.ok) {
        const carried = transportRefusalOf(connection.transport);
        if (listed.refusal === "PROTOCOL_VIOLATION" || carried !== null) {
          await drop(connectionKey(sessionId, serverId));
        }
        if (carried !== null) return { ok: false, refusal: carried.refusal, at: carried.at };
        return { ok: false, refusal: listed.refusal, at: listed.at };
      }

      // The intersection, and in that direction. The allowlist is the
      // authority and the advertised list is a claim: a server that advertises
      // a tool nobody allowed does not thereby acquire it, and a tool the
      // allowlist names but the server does not serve is not listed as
      // available. Reporting the allowlist alone would promise tools that are
      // not there; reporting the advertisement alone would abandon the bound.
      // P-24: an allowlisted tool advertised under another schema, input or
      // output, is not silently dropped; the first one refuses the whole listing.
      // A tool not advertised at all is simply not listed.
      const available: ToolAllowlistEntry[] = [];
      for (const entry of server.allowlist) {
        const at = mismatchOf(listed.value, entry);
        if (at === null) {
          available.push(entry);
        } else if (at !== "server.tools") {
          return { ok: false, refusal: "SCHEMA_MISMATCH", at, toolName: entry.name };
        }
      }
      return { ok: true, tools: Object.freeze(available) };
    },

    async callTool(request: ToolCallRequest): Promise<ToolCallOutcome> {
      await sweep();

      // Measured once, up front, so that the count a receipt carries does not
      // depend on which refusal happened to fire first. A receipt whose fields
      // varied by refusal path could not be compared across paths, and
      // comparing them is what the clockless receipt is for. The ceiling is
      // still applied at its own step, below.
      const serialized: unknown = JSON.stringify(request.arguments);
      const argumentBytes = typeof serialized === "string" ? toolFrameBytes(serialized) : 0;

      // Resolved once, up front, for the same reason `argumentBytes` is: a
      // receipt coordinate that varied by refusal path could not be compared
      // across paths.
      //
      // A `Map` read is not "touching a server" in the sense step 1 below
      // means -- it performs no I/O and starts no child -- so the decisions
      // keep their order and only the receipt's coordinate is resolved here. A
      // `serverId` nobody admitted has no transport, and inventing one would be
      // a receipt asserting a fact about a server that does not exist.
      const transport = servers.get(request.serverId)?.kind ?? TOOL_TRANSPORT_UNRESOLVED;

      // P-11 (W3): the counts a declined result actually had. Every refusal
      // that fires before a wire exists records zero, because zero is the
      // truth there; a refusal that fires after a result arrived records what
      // arrived, because a zero there would be a false number in a durable
      // row. The nine pre-result refusals pass no counts and keep their zeros.
      const refuse = (
        refusal: ToolRefusal,
        at: string,
        result?: { readonly resultBytes: number; readonly contentBlocks: number },
      ): ToolCallOutcome => ({
        ok: false,
        refusal,
        at,
        receipt: toolReceipt({
          sessionId: request.sessionId,
          serverId: request.serverId,
          toolName: request.toolName,
          transport,
          identity: request.identity,
          refusal,
          argumentBytes,
          resultBytes: result?.resultBytes ?? 0,
          contentBlocks: result?.contentBlocks ?? 0,
        }),
      });

      // 1. Liveness first, before any server is touched. A dead session must
      //    not be able to start a tool server.
      if (!input.liveness.isLive(request.sessionId)) {
        return refuse("SESSION_NOT_LIVE", "request.sessionId");
      }

      // 2. The server must be one the admission produced.
      const server = servers.get(request.serverId);
      if (server === undefined) return refuse("SERVER_NOT_ADMITTED", "request.serverId");

      // 3. The per-server allowlist, upstream of the wire. Fails closed: the
      //    server is never asked about a tool nobody allowed, so a refusal
      //    here costs no traffic and reveals nothing to the server.
      const entry = server.allowlist.find((candidate) => candidate.name === request.toolName);
      if (entry === undefined) return refuse("TOOL_NOT_ALLOWED", "request.toolName");

      // 4. Write authority, by membership in a closed role allowlist. An
      //    identity outside the control-plane grammar is refused here too: an
      //    identity the grammar does not admit holds no authority at all, so
      //    it certainly holds none over a tool that writes, and refusing it
      //    for every call is the fail-closed reading.
      let role;
      try {
        role = parseWorkerIdentity(request.identity).role;
      } catch {
        return refuse("IDENTITY_FORBIDS_WRITE", "request.identity");
      }
      if (entry.writes && !holdsToolWriteAuthority(role)) {
        return refuse("IDENTITY_FORBIDS_WRITE", "request.identity");
      }

      // 5. The argument ceiling, before anything is written to a wire.
      if (argumentBytes > TOOL_ARGUMENTS_BYTES_MAX) {
        return refuse("ARGUMENTS_UNBOUNDED", "request.arguments");
      }

      // 6. Connect (or reuse this session's connection) and call.
      let connection: Connection;
      try {
        connection = connect(request.sessionId, server);
      } catch {
        return refuse("PROTOCOL_VIOLATION", "server.process");
      }

      // 7. Discovery before the call (P-24, ADR 0109): the tool must be advertised
      //    on this connection's trusted listing, under a schema JSON-equal to the
      //    pin, or nothing is sent. A mismatch keeps the connection: the peer is
      //    still speaking the protocol.
      const listed = await trustedListing(connection);
      if (!listed.ok) {
        const carried = transportRefusalOf(connection.transport);
        if (listed.refusal === "PROTOCOL_VIOLATION" || carried !== null) {
          await drop(connectionKey(request.sessionId, request.serverId));
        }
        if (carried !== null) return refuse(carried.refusal, carried.at);
        return refuse(listed.refusal, listed.at);
      }
      const mismatch = mismatchOf(listed.value, entry);
      if (mismatch !== null) return refuse("SCHEMA_MISMATCH", mismatch);

      const called = await connection.client.callTool(request.toolName, request.arguments);
      if (!called.ok) {
        // A framing violation, an unmatched id or a peer that never answered
        // leaves the stream at an offset nothing can reason about, so the
        // connection goes with the refusal and the child is reaped. A result
        // this plane merely declines to carry is a different case: that peer
        // is still speaking the protocol, and its connection survives.
        // The loopback leg carries its transport-level refusal out of band,
        // because its `write` is synchronous and returns void: a redirect
        // refused at the transport would otherwise reach the client only as a
        // generic timeout, half a minute later and with the wrong reason. Where
        // one was recorded it is preferred, so `TRANSPORT_REFUSED` at the
        // redirect field path reaches the receipt with full fidelity.
        const carried = transportRefusalOf(connection.transport);
        if (called.refusal === "PROTOCOL_VIOLATION" || carried !== null) {
          await drop(connectionKey(request.sessionId, request.serverId));
        }
        if (carried !== null) return refuse(carried.refusal, carried.at);
        // P-11: a declined result keeps its real counts — RESULT_IS_ERROR and
        // the post-result refusals carry them, transport refusals carry none.
        return refuse(called.refusal, called.at, called.result);
      }

      // P-24/B(b), ADR 0117: under a pinned output schema the server MUST return
      // structured content, so its absence is a violation, and every violation
      // drops the connection. Decided here because the port holds the entry; the
      // client, which stays pin-free, has already refused an unmirrored value.
      if ((entry.outputSchema ?? null) !== null && !called.value.structured) {
        await drop(connectionKey(request.sessionId, request.serverId));
        return refuse("PROTOCOL_VIOLATION", AT_STRUCTURED_RESULT, {
          resultBytes: called.value.resultBytes,
          contentBlocks: called.value.content.length,
        });
      }

      // 8/9. The result ceiling was applied by the client; the privacy guard is
      //      applied here, where the contracts guards live, over the whole raw
      //      result, structured content included. No content is returned on a
      //      violation — not filtered content, none.
      if (toolResultIsUnsafe(called.value.value)) {
        return refuse("RESULT_UNSAFE", "server.result", {
          resultBytes: called.value.resultBytes,
          contentBlocks: called.value.content.length,
        });
      }

      return {
        ok: true,
        content: called.value.content,
        receipt: toolReceipt({
          sessionId: request.sessionId,
          serverId: request.serverId,
          toolName: request.toolName,
          transport,
          identity: request.identity,
          refusal: null,
          argumentBytes,
          resultBytes: called.value.resultBytes,
          contentBlocks: called.value.content.length,
        }),
      };
    },

    /** Reap everything, report what was reaped, and mean it twice. */
    async closeAll(): Promise<readonly string[]> {
      const keys = [...connections.keys()].sort();
      for (const key of keys) await drop(key);
      return Object.freeze(keys);
    },
  };
}
