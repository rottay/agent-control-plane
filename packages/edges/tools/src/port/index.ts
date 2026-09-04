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
import type { ToolClient } from "../client/index.js";
import { createToolClient } from "../client/index.js";
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
import type { ToolStdioConnection } from "../stdio/index.js";
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

export type ToolListingOutcome =
  | { readonly ok: true; readonly tools: readonly ToolAllowlistEntry[] }
  | { readonly ok: false; readonly refusal: ToolRefusal; readonly at: string };

export interface ToolProtocolPort {
  readonly listTools: (sessionId: string, serverId: string) => Promise<ToolListingOutcome>;
  readonly callTool: (request: ToolCallRequest) => Promise<ToolCallOutcome>;
  readonly closeAll: () => Promise<readonly string[]>;
}

interface Connection {
  readonly sessionId: string;
  readonly transport: ToolStdioConnection;
  readonly client: ToolClient;
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
    const transport = openToolStdioConnection(server, lifetimeMs);
    const connection: Connection = { sessionId, transport, client: createToolClient(transport) };
    connections.set(key, connection);
    return connection;
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

      const listed = await connection.client.listTools();
      if (!listed.ok) {
        await drop(connectionKey(sessionId, serverId));
        return { ok: false, refusal: listed.refusal, at: listed.at };
      }

      // The intersection, and in that direction. The allowlist is the
      // authority and the advertised list is a claim: a server that advertises
      // a tool nobody allowed does not thereby acquire it, and a tool the
      // allowlist names but the server does not serve is not listed as
      // available. Reporting the allowlist alone would promise tools that are
      // not there; reporting the advertisement alone would abandon the bound.
      const advertised = new Set(listed.value);
      return {
        ok: true,
        tools: Object.freeze(server.allowlist.filter((entry) => advertised.has(entry.name))),
      };
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

      const refuse = (refusal: ToolRefusal, at: string): ToolCallOutcome => ({
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
          resultBytes: 0,
          contentBlocks: 0,
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

      const called = await connection.client.callTool(request.toolName, request.arguments);
      if (!called.ok) {
        // A framing violation, an unmatched id or a peer that never answered
        // leaves the stream at an offset nothing can reason about, so the
        // connection goes with the refusal and the child is reaped. A result
        // this plane merely declines to carry is a different case: that peer
        // is still speaking the protocol, and its connection survives.
        if (called.refusal === "PROTOCOL_VIOLATION") {
          await drop(connectionKey(request.sessionId, request.serverId));
        }
        return refuse(called.refusal, called.at);
      }

      // 7/8. The result ceiling was applied by the client; the privacy guard is
      //      applied here, where the contracts guards live. No content is
      //      returned on a violation — not filtered content, none.
      if (toolResultIsUnsafe(called.value.value)) {
        return refuse("RESULT_UNSAFE", "server.result");
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
