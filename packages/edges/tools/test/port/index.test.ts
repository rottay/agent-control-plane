import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerIdentityString } from "@acp/contracts";

import { admitToolServer } from "../../src/admission/index.js";
import type { AdmittedToolServer } from "../../src/admission/index.js";
import {
  TOOL_ARGUMENTS_BYTES_MAX,
  TOOL_CALL_TIMEOUT_MS,
  TOOL_LIST_PAGES_MAX,
  TOOL_TRANSPORT_UNRESOLVED,
} from "../../src/contract/index.js";
import { openToolOperation } from "../../src/operation/index.js";
import { createToolProtocolPort } from "../../src/port/index.js";
import type { ToolProtocolPort } from "../../src/port/index.js";
import {
  makeToolFixtureDir,
  readToolCallLog,
  removeToolFixtureDir,
  writeFakeToolServer,
  initializeBody,
  jsonRpcBody,
  scriptFetch,
} from "../testing/index.js";
import type { ScriptedFetch } from "../testing/index.js";

const IMPLEMENTER = "claude/opus/implementer/01" as WorkerIdentityString;
const REVIEWER = "claude/opus/reviewer/01" as WorkerIdentityString;
const SESSION = "task-1/1/acct-1";

const ALLOWLIST = [
  { name: "docs.search", writes: false, inputSchema: { type: "object" } },
  { name: "docs.write", writes: true, inputSchema: { type: "object" } },
  { name: "docs.huge", writes: false, inputSchema: { type: "object" } },
  { name: "docs.leak", writes: false, inputSchema: { type: "object" } },
  { name: "docs.silent", writes: false, inputSchema: { type: "object" } },
  { name: "docs.malformed", writes: false, inputSchema: { type: "object" } },
  { name: "docs.error", writes: false, inputSchema: { type: "object" } },
  { name: "docs.rpcerror", writes: false, inputSchema: { type: "object" } },
];

/**
 * Credential-shaped, and assembled at runtime on purpose.
 *
 * The repository refuses credential material in any tracked file, and it is
 * right to: a fixture that looked like a live key would be indistinguishable
 * from one. The contracts suite holds the single exemption to that rule and
 * this suite does not ask to join it — it builds the shape instead, which is
 * the same idiom and costs nothing.
 */
const LEAKED = "sk-ant-api03-" + "A".repeat(32);

let dir = "";
let callLog = "";
let pidLog = "";
let server: AdmittedToolServer;
let live: Set<string>;
let port: ToolProtocolPort;

/** Is this pid still a process? */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childPids(): readonly number[] {
  return readToolCallLog(pidLog).map((line) => Number(line));
}

beforeEach(() => {
  dir = makeToolFixtureDir();
  callLog = dir + "/calls.log";
  pidLog = dir + "/pids.log";
  const fake = writeFakeToolServer(dir, {
    callLog,
    pidLog,
    // The server advertises one tool nobody allowed. That is the whole point
    // of the intersection: an advertisement is a claim, not an authority.
    advertises: [...ALLOWLIST.map((entry) => entry.name), "shell.exec"],
    answers: {
      "docs.search": { kind: "TEXT", blocks: ["the answer", "and more"] },
      "docs.write": { kind: "TEXT", blocks: ["written"] },
      "shell.exec": { kind: "TEXT", blocks: ["should never be reached"] },
      "docs.huge": { kind: "PADDED", bytes: 4_000, blocks: 20 },
      "docs.leak": { kind: "TEXT", blocks: [LEAKED] },
      "docs.silent": { kind: "SILENT" },
      "docs.malformed": { kind: "MALFORMED" },
      "docs.error": { kind: "ERROR_RESULT", blocks: ["the tool failed"] },
      "docs.rpcerror": { kind: "ERROR" },
    },
  });
  const admitted = admitToolServer({
    serverId: "docs",
    transport: "STDIO",
    command: fake.command,
    args: fake.args,
    tools: ALLOWLIST,
  });
  if (!admitted.ok) throw new Error("fixture server was not admitted: " + admitted.at);
  server = admitted.server;
  live = new Set([SESSION]);
  port = createToolProtocolPort({
    servers: [server],
    liveness: { isLive: (sessionId) => live.has(sessionId) },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await port.closeAll();
  removeToolFixtureDir(dir);
});

const call = (overrides: Partial<Parameters<ToolProtocolPort["callTool"]>[0]> = {}) =>
  port.callTool({
    sessionId: SESSION,
    serverId: "docs",
    toolName: "docs.search",
    identity: IMPLEMENTER,
    arguments: { q: "acp" },
    ...overrides,
  });

describe("an allowlisted call for a live session completes, and is receipted", () => {
  it("returns the content and a receipt that matches the call", async () => {
    const outcome = await call();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.content).toEqual(["the answer", "and more"]);
    expect(outcome.receipt).toEqual({
      sessionId: SESSION,
      serverId: "docs",
      toolName: "docs.search",
      transport: "STDIO",
      identity: IMPLEMENTER,
      outcome: "COMPLETED",
      refusal: null,
      argumentBytes: JSON.stringify({ q: "acp" }).length,
      resultBytes: outcome.receipt.resultBytes,
      contentBlocks: 2,
    });
    expect(outcome.receipt.resultBytes).toBeGreaterThan(0);
  });

  it("carries no argument, no content and no server text into the receipt", async () => {
    const outcome = await call({ arguments: { q: "a-distinctive-argument-value" } });
    expect(outcome.ok).toBe(true);
    const serialized = JSON.stringify(outcome.receipt);
    expect(serialized).not.toContain("a-distinctive-argument-value");
    expect(serialized).not.toContain("the answer");
  });
});

describe("listTools intersects the allowlist with what the server advertises", () => {
  it("lists neither an unallowed advertisement nor an unserved allowlist entry", async () => {
    const listed = await port.listTools(SESSION, "docs");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const names = listed.tools.map((entry) => entry.name).sort();
    expect(names).toEqual([...ALLOWLIST.map((entry) => entry.name)].sort());
    // The server advertised it; nobody allowed it; it is not listed.
    expect(names).not.toContain("shell.exec");
  });

  it("drops an allowlist entry the server does not actually serve", async () => {
    const narrowed = createToolProtocolPort({
      servers: [{ ...server, allowlist: [...ALLOWLIST, { name: "docs.absent", writes: false, inputSchema: { type: "object" } }] }],
      liveness: { isLive: () => true },
    });
    const listed = await narrowed.listTools(SESSION, "docs");
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.tools.map((entry) => entry.name)).not.toContain("docs.absent");
    await narrowed.closeAll();
  });
});

describe("the refusals fire in order, and upstream of the wire where they can", () => {
  it("refuses a dead session before any server is touched", async () => {
    live.delete(SESSION);
    const outcome = await call();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "SESSION_NOT_LIVE",
      at: "request.sessionId",
    });
    expect(outcome.receipt.outcome).toBe("REFUSED");
    // The server was never touched, but it *was* admitted, so the receipt can
    // name its transport honestly. This is the ordering proof: the map was
    // read, and no child started.
    expect(outcome.receipt.transport).toBe("STDIO");
    // Nothing was started and nothing was asked.
    expect(childPids()).toEqual([]);
    expect(readToolCallLog(callLog)).toEqual([]);
    expect(await port.closeAll()).toEqual([]);
  });

  it("names no transport when the dead session's server was never admitted", async () => {
    // The load-bearing contrast, and the reason this packet exists. Same
    // refusal and same field path as the case above; the transport differs,
    // decided only by whether the admitted map held the id. A receipt that said
    // STDIO here would be asserting a fact about a server nobody admitted.
    live.delete(SESSION);
    const outcome = await call({ serverId: "absent" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "SESSION_NOT_LIVE",
      at: "request.sessionId",
    });
    expect(outcome.receipt.transport).toBe(TOOL_TRANSPORT_UNRESOLVED);
    expect(childPids()).toEqual([]);
  });

  it("refuses a server that was never admitted", async () => {
    const outcome = await call({ serverId: "absent" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "SERVER_NOT_ADMITTED",
      at: "request.serverId",
    });
    // No server was resolved, so there is no transport to name.
    expect(outcome.receipt.transport).toBe(TOOL_TRANSPORT_UNRESOLVED);
    expect(childPids()).toEqual([]);
  });

  it("refuses a tool nobody allowed, and never asks the server", async () => {
    // Fails closed means the refusal is upstream of the wire, not a filter on
    // the answer. The server advertises `shell.exec` and would answer it.
    const outcome = await call({ toolName: "shell.exec" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "TOOL_NOT_ALLOWED",
      at: "request.toolName",
    });
    // The server was admitted, so the receipt names its transport.
    expect(outcome.receipt.transport).toBe("STDIO");
    expect(readToolCallLog(callLog)).toEqual([]);
    expect(childPids()).toEqual([]);
  });

  it("refuses arguments over the ceiling with no wire traffic", async () => {
    const outcome = await call({
      arguments: { blob: "z".repeat(TOOL_ARGUMENTS_BYTES_MAX + 100) },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "ARGUMENTS_UNBOUNDED",
      at: "request.arguments",
    });
    expect(outcome.receipt.transport).toBe("STDIO");
    expect(outcome.receipt.argumentBytes).toBeGreaterThan(TOOL_ARGUMENTS_BYTES_MAX);
    expect(readToolCallLog(callLog)).toEqual([]);
    expect(childPids()).toEqual([]);
  });

  it("refuses a result over the ceiling, and returns no content at all", async () => {
    const outcome = await call({ toolName: "docs.huge" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "RESULT_UNBOUNDED",
      at: "server.result",
    });
    // Not truncated content — none.
    expect(Object.hasOwn(outcome, "content")).toBe(false);
  });

  it("refuses a credential-shaped server result and leaks no fragment of it", async () => {
    const outcome = await call({ toolName: "docs.leak" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "RESULT_UNSAFE",
      at: "server.result",
    });
    expect(Object.hasOwn(outcome, "content")).toBe(false);
    // The whole serialized outcome, receipt included.
    expect(JSON.stringify(outcome)).not.toContain(LEAKED);
    expect(JSON.stringify(outcome)).not.toContain("sk-ant-api03-");
    expect(JSON.stringify(outcome)).not.toContain("A".repeat(16));
    // P-11 (W3): a result arrived and was declined — the receipt records its
    // real counts. Zero would be a false number in a durable row.
    expect(outcome.receipt.resultBytes).toBeGreaterThan(0);
    expect(outcome.receipt.contentBlocks).toBe(1);
  });

  it("refuses a malformed frame and reaps the connection with it", async () => {
    const outcome = await call({ toolName: "docs.malformed" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
    // The connection went with the refusal: nothing is left to close.
    expect(await port.closeAll()).toEqual([]);
    const pids = childPids();
    expect(pids).toHaveLength(1);
    expect(pidAlive(pids[0] ?? 0)).toBe(false);
  });

  it("refuses a peer that never answers, on the timeout", async () => {
    // The connection is warmed under the real clock first, so the timer this
    // test advances is the one the call arms and not the handshake's.
    await port.listTools(SESSION, "docs");
    vi.useFakeTimers();
    const pending = call({ toolName: "docs.silent" });
    await vi.advanceTimersByTimeAsync(TOOL_CALL_TIMEOUT_MS + 1);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
  });
});

describe("a result the server marks as an error is a refusal, never a success (P-11)", () => {
  it("refuses with RESULT_IS_ERROR, no content, and the counts that arrived", async () => {
    // N-1/N-2: the frame is well-formed, the transport answers in time and the
    // child exits zero — and the outcome is still not ok. A tool error is
    // never a success, whatever the transport said.
    const outcome = await call({ toolName: "docs.error" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "RESULT_IS_ERROR",
      at: "server.result",
    });
    // N-9: the error content is discarded whole. The refused arm carries no
    // content member, and the error text appears nowhere in the outcome —
    // a partially filtered result is one the caller cannot tell from a whole
    // one, which is the same law RESULT_UNSAFE holds.
    expect(Object.hasOwn(outcome, "content")).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("the tool failed");
    // N-3: the receipt is a durable-row-worthy fact — outcome, a legible
    // reason, and the real counts of the result that arrived (W3). A zero
    // here would be a false number in a durable row.
    expect(outcome.receipt.outcome).toBe("REFUSED");
    expect(outcome.receipt.refusal).toBe("RESULT_IS_ERROR");
    expect(outcome.receipt.resultBytes).toBeGreaterThan(0);
    expect(outcome.receipt.contentBlocks).toBe(1);
    // P-2, asserted where the outcome is born rather than assumed: the arm,
    // the receipt's outcome and the receipt's reason are one coherent fact.
    expect(outcome.receipt.refusal).toBe(outcome.refusal);
    // The server spoke the protocol, so — unlike a transport refusal — the
    // connection survives the refusal and the child is reaped by closeAll.
    expect(await port.closeAll()).toEqual(["task-1/1/acct-1/docs"]);
  });

  it("keeps a transport error and a marked-error result as two distinguishable facts (N-4)", async () => {
    // 4.2-c made checkable: a JSON-RPC error is a fact about the transport; an
    // isError result is a fact about the operation. A packet that flattened
    // the two would close N07 and break the three-facts law in the same
    // commit.
    const marked = await call({ toolName: "docs.error" });
    const transport = await call({ toolName: "docs.rpcerror" });
    expect(marked.ok).toBe(false);
    expect(transport.ok).toBe(false);
    if (marked.ok || transport.ok) return;
    expect({ refusal: marked.refusal, at: marked.at }).toEqual({
      refusal: "RESULT_IS_ERROR",
      at: "server.result",
    });
    expect({ refusal: transport.refusal, at: transport.at }).toEqual({
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
  });
});

describe("write authority is a closed role allowlist, in both directions", () => {
  it("lets an implementer drive a writing tool", async () => {
    const outcome = await call({ toolName: "docs.write" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.content).toEqual(["written"]);
  });

  it.each(["reviewer", "consultant", "verifier", "coordinator"])(
    "refuses a %s driving a writing tool, before the server is asked",
    async (role) => {
      const outcome = await call({
        toolName: "docs.write",
        identity: "claude/opus/" + role + "/01",
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
        refusal: "IDENTITY_FORBIDS_WRITE",
        at: "request.identity",
      });
      expect(readToolCallLog(callLog)).toEqual([]);
    },
  );

  it("lets a reviewer drive a reading tool", async () => {
    // The vacuity direction: a predicate that refused every reviewer outright
    // would pass the four cases above and be wrong.
    const outcome = await call({
      identity: "claude/opus/reviewer/01" as WorkerIdentityString,
    });
    expect(outcome.ok).toBe(true);
  });

  it("refuses an identity the control plane grammar does not admit", async () => {
    const outcome = await call({ identity: "not-an-identity" as WorkerIdentityString });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
      refusal: "IDENTITY_FORBIDS_WRITE",
      at: "request.identity",
    });
    expect(readToolCallLog(callLog)).toEqual([]);
  });
});

describe("one execution's tool server never serves another's", () => {
  it("gives two sessions two connections, and closing one leaves the other serving", async () => {
    const second = "task-2/1/acct-1";
    live.add(second);

    expect((await call()).ok).toBe(true);
    expect((await call({ sessionId: second })).ok).toBe(true);

    const pids = childPids();
    expect(pids).toHaveLength(2);
    expect(new Set(pids).size).toBe(2);

    const reaped = await port.closeAll();
    expect(reaped).toEqual(["task-1/1/acct-1/docs", "task-2/1/acct-1/docs"]);
  });

  it("reaps a dead session's child lazily, on the next call by another session", async () => {
    const second = "task-2/1/acct-1";
    live.add(second);
    expect((await call()).ok).toBe(true);
    const [first] = childPids();
    expect(pidAlive(first ?? 0)).toBe(true);

    // The session ends. Nothing pushes; the port asks on its next operation.
    live.delete(SESSION);
    expect((await call({ sessionId: second })).ok).toBe(true);

    expect(pidAlive(first ?? 0)).toBe(false);
    expect(await port.closeAll()).toEqual(["task-2/1/acct-1/docs"]);
  });

  it("reaps everything on closeAll, reports the keys, and is idempotent", async () => {
    expect((await call()).ok).toBe(true);
    const pids = childPids();
    expect(await port.closeAll()).toEqual(["task-1/1/acct-1/docs"]);
    expect(pidAlive(pids[0] ?? 0)).toBe(false);
    expect(await port.closeAll()).toEqual([]);
  });
});

describe("the acceptance measures the port, not the fake's good manners", () => {
  it("fails against a server that answers nothing", async () => {
    // The vacuity guard. If the passing cases above would also pass with a
    // server that never answers, they measure nothing.
    const silentDir = makeToolFixtureDir();
    try {
      const fake = writeFakeToolServer(silentDir, {
        answers: { "docs.search": { kind: "SILENT" } },
      });
      const admitted = admitToolServer({
        serverId: "docs",
        transport: "STDIO",
        command: fake.command,
        args: fake.args,
        tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
      });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;

      const silentPort = createToolProtocolPort({
        servers: [admitted.server],
        liveness: { isLive: () => true },
      });
      await silentPort.listTools(SESSION, "docs");
      vi.useFakeTimers();
      const pending = silentPort.callTool({
        sessionId: SESSION,
        serverId: "docs",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: {},
      });
      await vi.advanceTimersByTimeAsync(TOOL_CALL_TIMEOUT_MS + 1);
      expect((await pending).ok).toBe(false);
      vi.useRealTimers();
      await silentPort.closeAll();
    } finally {
      removeToolFixtureDir(silentDir);
    }
  });
});

describe("both transports obey one set of rules (V2-B4b S4-1)", () => {
  /**
   * The packet's substance, as a table.
   *
   * Everything the port decides is transport-independent: the per-server tool
   * allowlist, the write-role subset, the ceilings, the privacy guard and the
   * receipt. This drives the same behaviours over a spawned child and a
   * loopback endpoint and asserts the outcomes are identical — the only
   * permitted differences being the receipt's `transport` and the presence of a
   * pid. Prose could claim that; this is what makes it checkable.
   */
  const LOOPBACK_URL = "http://127.0.0.1:9100/mcp";
  let scripted: ScriptedFetch | null = null;

  afterEach(() => {
    scripted?.restore();
    scripted = null;
  });

  function loopbackServer(): AdmittedToolServer {
    const outcome = admitToolServer({
      serverId: "docs",
      transport: "HTTP_LOOPBACK",
      url: LOOPBACK_URL,
      tools: ALLOWLIST,
    });
    if (!outcome.ok) throw new Error("loopback fixture was not admitted: " + outcome.at);
    return outcome.server;
  }

  /** A peer that completes `initialize` and then answers every call. */
  function answerEveryCall(): void {
    let id = 0;
    scripted = scriptFetch((body: string) => {
      id += 1;
      const parsed = JSON.parse(body) as { method?: string; id?: number };
      if (parsed.method === "initialize") {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: initializeBody(parsed.id ?? id),
        };
      }
      if (parsed.method === "notifications/initialized") return { status: 202 };
      // P-24: the port lists before it calls; the peer advertises the allowlist under its pins.
      if (parsed.method === "tools/list") {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: jsonRpcBody(parsed.id ?? id, {
            tools: ALLOWLIST.map((entry) => ({ name: entry.name, inputSchema: entry.inputSchema })),
          }),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: jsonRpcBody(parsed.id ?? id, {
          content: [{ type: "text", text: "the answer" }],
        }),
      };
    });
  }

  /** A peer whose every call answer is a well-formed result marked isError. */
  function answerEveryCallWithMarkedError(): void {
    let id = 0;
    scripted = scriptFetch((body: string) => {
      id += 1;
      const parsed = JSON.parse(body) as { method?: string; id?: number };
      if (parsed.method === "initialize") {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: initializeBody(parsed.id ?? id),
        };
      }
      if (parsed.method === "notifications/initialized") return { status: 202 };
      // P-24: the port lists before it calls; the peer advertises the allowlist under its pins.
      if (parsed.method === "tools/list") {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: jsonRpcBody(parsed.id ?? id, {
            tools: ALLOWLIST.map((entry) => ({ name: entry.name, inputSchema: entry.inputSchema })),
          }),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: jsonRpcBody(parsed.id ?? id, {
          content: [{ type: "text", text: "the tool failed" }],
          isError: true,
        }),
      };
    });
  }

  function loopbackPort(): ToolProtocolPort {
    return createToolProtocolPort({
      servers: [loopbackServer()],
      liveness: { isLive: (sessionId) => live.has(sessionId) },
    });
  }

  it("refuses a tool nobody allowed on both legs, upstream of the wire", async () => {
    answerEveryCall();
    const loopback = loopbackPort();
    try {
      const overHttp = await loopback.callTool({
        sessionId: SESSION,
        serverId: "docs",
        toolName: "shell.exec",
        identity: IMPLEMENTER,
        arguments: {},
      });
      const overStdio = await call({ toolName: "shell.exec" });

      expect(overHttp.ok).toBe(false);
      expect(overStdio.ok).toBe(false);
      if (overHttp.ok || overStdio.ok) return;
      expect({ refusal: overHttp.refusal, at: overHttp.at }).toEqual({
        refusal: overStdio.refusal,
        at: overStdio.at,
      });
      // Upstream of the wire on both: nothing was asked and nothing spawned.
      expect(scripted?.calls()).toEqual([]);
      expect(childPids()).toEqual([]);
      // The only permitted difference.
      expect(overHttp.receipt.transport).toBe("HTTP_LOOPBACK");
      expect(overStdio.receipt.transport).toBe("STDIO");
    } finally {
      await loopback.closeAll();
    }
  });

  it("applies the write-role subset identically on both legs", async () => {
    answerEveryCall();
    const loopback = loopbackPort();
    try {
      const overHttp = await loopback.callTool({
        sessionId: SESSION,
        serverId: "docs",
        toolName: "docs.write",
        identity: REVIEWER,
        arguments: {},
      });
      const overStdio = await call({ toolName: "docs.write", identity: REVIEWER });
      expect(overHttp.ok).toBe(false);
      expect(overStdio.ok).toBe(false);
      if (overHttp.ok || overStdio.ok) return;
      expect({ refusal: overHttp.refusal, at: overHttp.at }).toEqual({
        refusal: overStdio.refusal,
        at: overStdio.at,
      });
      expect(overHttp.refusal).toBe("IDENTITY_FORBIDS_WRITE");
    } finally {
      await loopback.closeAll();
    }
  });

  it("applies the argument ceiling identically on both legs", async () => {
    answerEveryCall();
    const loopback = loopbackPort();
    try {
      const oversized = { blob: "z".repeat(TOOL_ARGUMENTS_BYTES_MAX + 100) };
      const overHttp = await loopback.callTool({
        sessionId: SESSION,
        serverId: "docs",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: oversized,
      });
      const overStdio = await call({ arguments: oversized });
      expect(overHttp.ok).toBe(false);
      expect(overStdio.ok).toBe(false);
      if (overHttp.ok || overStdio.ok) return;
      expect({ refusal: overHttp.refusal, at: overHttp.at }).toEqual({
        refusal: overStdio.refusal,
        at: overStdio.at,
      });
      expect(scripted?.calls()).toEqual([]);
    } finally {
      await loopback.closeAll();
    }
  });

  it("refuses a dead session and an unadmitted server identically on both legs", async () => {
    answerEveryCall();
    const loopback = loopbackPort();
    try {
      live.delete(SESSION);
      const dead = await loopback.callTool({
        sessionId: SESSION,
        serverId: "docs",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: {},
      });
      expect(dead.ok).toBe(false);
      if (!dead.ok) expect(dead.refusal).toBe("SESSION_NOT_LIVE");
      // The admitted server's transport is nameable even here: the map was
      // read, and nothing was contacted.
      expect(dead.receipt.transport).toBe("HTTP_LOOPBACK");
      expect(scripted?.calls()).toEqual([]);

      live.add(SESSION);
      const absent = await loopback.callTool({
        sessionId: SESSION,
        serverId: "absent",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: {},
      });
      expect(absent.ok).toBe(false);
      if (!absent.ok) expect(absent.refusal).toBe("SERVER_NOT_ADMITTED");
      // S4-0's word, and it appears here and nowhere else on this leg.
      expect(absent.receipt.transport).toBe(TOOL_TRANSPORT_UNRESOLVED);
    } finally {
      await loopback.closeAll();
    }
  });

  it("completes over the loopback leg with the receipt's ten members", async () => {
    answerEveryCall();
    const loopback = loopbackPort();
    try {
      const outcome = await loopback.callTool({
        sessionId: SESSION,
        serverId: "docs",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: { q: "acp" },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.content).toEqual(["the answer"]);
      expect(outcome.receipt.transport).toBe("HTTP_LOOPBACK");
      expect(outcome.receipt.outcome).toBe("COMPLETED");
      expect(Object.keys(outcome.receipt)).toHaveLength(10);
      // No child was started for this leg: there is no process to reap.
      expect(childPids()).toEqual([]);
    } finally {
      await loopback.closeAll();
    }
  });

  it("refuses a server-marked error identically on both legs (P-11)", async () => {
    // N-8: the parse site is one, so parity is a fact to pin, not a hope. The
    // stdio fake and the scripted peer answer the same marked-error result,
    // byte for byte in the result body.
    answerEveryCallWithMarkedError();
    const loopback = loopbackPort();
    try {
      const overHttp = await loopback.callTool({
        sessionId: SESSION,
        serverId: "docs",
        toolName: "docs.error",
        identity: IMPLEMENTER,
        arguments: {},
      });
      const overStdio = await call({ toolName: "docs.error" });

      expect(overHttp.ok).toBe(false);
      expect(overStdio.ok).toBe(false);
      if (overHttp.ok || overStdio.ok) return;
      expect({ refusal: overHttp.refusal, at: overHttp.at }).toEqual({
        refusal: overStdio.refusal,
        at: overStdio.at,
      });
      expect(overHttp.refusal).toBe("RESULT_IS_ERROR");
      // The only permitted difference, as everywhere in this table: the
      // receipt's transport coordinate. Even the counts agree, because the
      // result body is the same over both legs.
      expect(overHttp.receipt.transport).toBe("HTTP_LOOPBACK");
      expect(overStdio.receipt.transport).toBe("STDIO");
      expect(overHttp.receipt.resultBytes).toBe(overStdio.receipt.resultBytes);
      expect(overHttp.receipt.contentBlocks).toBe(1);
      expect(overStdio.receipt.contentBlocks).toBe(1);
    } finally {
      await loopback.closeAll();
    }
  });

  it("keeps a stdio and a loopback server on separate connection keys in one session", async () => {
    answerEveryCall();
    const both = createToolProtocolPort({
      servers: [server, { ...loopbackServer(), serverId: "notes" } as AdmittedToolServer],
      liveness: { isLive: (sessionId) => live.has(sessionId) },
    });
    try {
      const overStdio = await both.callTool({
        sessionId: SESSION,
        serverId: "docs",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: { q: "acp" },
      });
      const overHttp = await both.callTool({
        sessionId: SESSION,
        serverId: "notes",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: { q: "acp" },
      });
      expect(overStdio.ok).toBe(true);
      expect(overHttp.ok).toBe(true);
      expect(overStdio.receipt.transport).toBe("STDIO");
      expect(overHttp.receipt.transport).toBe("HTTP_LOOPBACK");
    } finally {
      // Both are reaped, and the stdio child by pid.
      const reaped = await both.closeAll();
      expect(reaped.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// P-24 (ADR 0109): discovery before every call, under the pinned schema
// ---------------------------------------------------------------------------

describe("the port lists before it calls, and calls only under the pinned schema (P-24)", () => {
  let extraPorts: ToolProtocolPort[] = [];
  let listLog = "";

  afterEach(async () => {
    for (const extra of extraPorts) await extra.closeAll();
    extraPorts = [];
  });

  /** A port over a fresh fake with the P-24 options, sharing this file's logs. */
  function portWith(options: Parameters<typeof writeFakeToolServer>[1], allowlist = ALLOWLIST): ToolProtocolPort {
    listLog = dir + "/lists.log";
    const fake = writeFakeToolServer(dir + "/p24-" + String(extraPorts.length), {
      callLog,
      pidLog,
      listLog,
      advertises: allowlist.map((entry) => entry.name),
      answers: { "docs.search": { kind: "TEXT", blocks: ["the answer"] } },
      ...options,
    });
    const admitted = admitToolServer({ serverId: "docs", transport: "STDIO", command: fake.command, args: fake.args, tools: allowlist });
    if (!admitted.ok) throw new Error("fixture server was not admitted: " + admitted.at);
    const created = createToolProtocolPort({ servers: [admitted.server], liveness: { isLive: (sessionId) => live.has(sessionId) } });
    extraPorts.push(created);
    return created;
  }

  const callOn = (target: ToolProtocolPort, toolName = "docs.search") =>
    target.callTool({ sessionId: SESSION, serverId: "docs", toolName, identity: IMPLEMENTER, arguments: { q: "acp" } });

  it("finds a tool on page 3 of 3: three listings, then one call", async () => {
    const outcome = await callOn(portWith({ pageSize: 3, advertises: ["a.1", "a.2", "a.3", "a.4", "a.5", "a.6", "docs.search"] }));
    expect(outcome.ok).toBe(true);
    expect(readToolCallLog(listLog)).toEqual(["list null", "list c3", "list c6"]);
    expect(readToolCallLog(callLog)).toEqual(["docs.search"]);
  });

  it("refuses a nested schema difference as SCHEMA_MISMATCH, sends no call, and keeps the connection", async () => {
    const differing = { type: "object", properties: { q: { type: "number" } } };
    const pinned = [{ name: "docs.search", writes: false, inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
    const target = portWith({ schemas: { "docs.search": differing } }, pinned);
    const outcome = await callOn(target);
    expect(outcome).toMatchObject({ ok: false, refusal: "SCHEMA_MISMATCH", at: "server.tools.inputSchema" });
    expect(outcome.receipt).toMatchObject({ outcome: "REFUSED", refusal: "SCHEMA_MISMATCH", resultBytes: 0, contentBlocks: 0 });
    expect(readToolCallLog(callLog)).toEqual([]);
    expect(childPids().every(pidAlive)).toBe(true);
  });

  it("refuses an allowlisted tool the server does not advertise, at server.tools", async () => {
    const outcome = await callOn(portWith({ advertises: ["docs.write"] }));
    expect(outcome).toMatchObject({ ok: false, refusal: "SCHEMA_MISMATCH", at: "server.tools" });
    expect(readToolCallLog(callLog)).toEqual([]);
  });

  it("accepts an equal schema whatever its key order", async () => {
    const pinned = [{ name: "docs.search", writes: false, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }];
    const reordered = { required: ["q"], properties: { q: { type: "string" } }, type: "object" };
    expect((await callOn(portWith({ schemas: { "docs.search": reordered } }, pinned))).ok).toBe(true);
  });

  it("refuses a cursor cycle as PROTOCOL_VIOLATION and reaps the child", async () => {
    const outcome = await callOn(portWith({ pageSize: 1, cursorCycle: true, advertises: ["a.1", "a.2", "a.3", "docs.search"] }));
    expect(outcome).toMatchObject({ ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.tools.nextCursor" });
    expect(readToolCallLog(callLog)).toEqual([]);
    const pids = childPids();
    expect(pids.length).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(pids.some(pidAlive)).toBe(false);
    });
  });

  it("refuses a listing past TOOL_LIST_PAGES_MAX as RESULT_UNBOUNDED and keeps the connection", async () => {
    const names = Array.from({ length: TOOL_LIST_PAGES_MAX + 1 }, (_, index) => "a." + String(index));
    const outcome = await callOn(portWith({ pageSize: 1, advertises: names }));
    expect(outcome).toMatchObject({ ok: false, refusal: "RESULT_UNBOUNDED", at: "server.tools" });
    expect(outcome.receipt).toMatchObject({ resultBytes: 0, contentBlocks: 0 });
    expect(readToolCallLog(callLog)).toEqual([]);
    expect(childPids().every(pidAlive)).toBe(true);
  });

  it("reuses the connection's listing for a second call", async () => {
    const target = portWith({});
    expect((await callOn(target)).ok).toBe(true);
    expect((await callOn(target)).ok).toBe(true);
    expect(readToolCallLog(listLog)).toEqual(["list null"]);
    expect(readToolCallLog(callLog)).toEqual(["docs.search", "docs.search"]);
  });

  it("re-lists after a list_changed that followed the listing: two listings, one call (E7)", async () => {
    const outcome = await callOn(portWith({ listChangedBeforeCall: true }));
    expect(outcome.ok).toBe(true);
    expect(readToolCallLog(listLog)).toEqual(["list null", "list null"]);
    expect(readToolCallLog(callLog)).toEqual(["docs.search"]);
  });

  it("restarts a listing a list_changed interrupted, once", async () => {
    const outcome = await callOn(portWith({ pageSize: 1, listChangedMidListing: true, advertises: ["a.1", "docs.search"] }));
    expect(outcome.ok).toBe(true);
    expect(readToolCallLog(listLog)).toEqual(["list null", "list c1", "list null", "list c1"]);
    expect(readToolCallLog(callLog)).toEqual(["docs.search"]);
  });

  it("decides liveness, the allowlist and write authority before any listing", async () => {
    const target = portWith({});
    live.delete(SESSION);
    expect(await callOn(target)).toMatchObject({ refusal: "SESSION_NOT_LIVE" });
    live.add(SESSION);
    expect(await callOn(target, "shell.exec")).toMatchObject({ refusal: "TOOL_NOT_ALLOWED" });
    expect(
      await target.callTool({ sessionId: SESSION, serverId: "docs", toolName: "docs.write", identity: REVIEWER, arguments: {} }),
    ).toMatchObject({ refusal: "IDENTITY_FORBIDS_WRITE" });
    expect(readToolCallLog(listLog)).toEqual([]);
    expect(childPids()).toEqual([]);
  });

  it("lists only allowlist entries advertised under their pin, and refuses the listing on a mismatch", async () => {
    const equal = await portWith({ advertises: ["docs.search"] }).listTools(SESSION, "docs");
    expect(equal).toEqual({ ok: true, tools: [{ ...ALLOWLIST[0], outputSchema: null }] });
    const differing = await portWith({ schemas: { "docs.write": { type: "object", required: ["x"] } } }).listTools(SESSION, "docs");
    expect(differing).toEqual({ ok: false, refusal: "SCHEMA_MISMATCH", at: "server.tools.inputSchema" });
  });
});

describe("the two windows over the loopback leg (P-24, C5)", () => {
  const URL = "http://127.0.0.1:9100/mcp";
  const CHANGED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  let scripted: ScriptedFetch | null = null;
  let methods: string[] = [];

  afterEach(() => {
    scripted?.restore();
    scripted = null;
    methods = [];
  });

  /** A peer that answers every list, and optionally every call, with a trailing list_changed. */
  function peer(options: { readonly changedOnList: number; readonly changedOnCall: boolean }): void {
    let lists = 0;
    scripted = scriptFetch((body: string) => {
      const parsed = JSON.parse(body) as { method?: string; id?: number };
      methods.push(parsed.method ?? "");
      const id = parsed.id ?? 0;
      if (parsed.method === "initialize") return { status: 200, headers: { "content-type": "application/json" }, body: initializeBody(id) };
      if (parsed.method === "notifications/initialized") return { status: 202 };
      const sse = (frames: readonly string[]): { status: number; headers: Record<string, string>; body: string } => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: frames.map((frame) => "data: " + frame + "\n\n").join(""),
      });
      if (parsed.method === "tools/list") {
        lists += 1;
        const listing = jsonRpcBody(id, { tools: [{ name: "docs.search", inputSchema: { type: "object" } }] });
        return sse(lists <= options.changedOnList ? [listing, CHANGED] : [listing]);
      }
      const answer = jsonRpcBody(id, { content: [{ type: "text", text: "the answer" }] });
      return sse(options.changedOnCall ? [answer, CHANGED] : [answer]);
    });
  }

  function loopback(): ToolProtocolPort {
    const admitted = admitToolServer({
      serverId: "docs",
      transport: "HTTP_LOOPBACK",
      url: URL,
      tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
    });
    if (!admitted.ok) throw new Error("loopback fixture was not admitted: " + admitted.at);
    return createToolProtocolPort({ servers: [admitted.server], liveness: { isLive: () => true } });
  }

  const callOn = (target: ToolProtocolPort) =>
    target.callTool({ sessionId: SESSION, serverId: "docs", toolName: "docs.search", identity: IMPLEMENTER, arguments: {} });

  it("re-lists once after a change announced with the listing, then calls", async () => {
    peer({ changedOnList: 1, changedOnCall: false });
    const target = loopback();
    try {
      expect((await callOn(target)).ok).toBe(true);
      expect(methods.filter((method) => method === "tools/list")).toHaveLength(2);
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(1);
    } finally {
      await target.closeAll();
    }
  });

  it("refuses a listing changed again on its re-list, and sends no call", async () => {
    peer({ changedOnList: 2, changedOnCall: false });
    const target = loopback();
    try {
      expect(await callOn(target)).toMatchObject({ ok: false, refusal: "RESULT_UNBOUNDED", at: "server.tools" });
      expect(methods).not.toContain("tools/call");
    } finally {
      await target.closeAll();
    }
  });

  it("does not see a change that follows the call it answered, and the next call re-lists (window A, stated)", async () => {
    peer({ changedOnList: 0, changedOnCall: true });
    const target = loopback();
    try {
      expect((await callOn(target)).ok).toBe(true);
      expect(methods.filter((method) => method === "tools/list")).toHaveLength(1);
      expect((await callOn(target)).ok).toBe(true);
      expect(methods.filter((method) => method === "tools/list")).toHaveLength(2);
    } finally {
      await target.closeAll();
    }
  });
});

// ---------------------------------------------------------------------------
// P-24/B(b) (ADR 0117): the output pin, and structured content only as text
// ---------------------------------------------------------------------------

describe("the port calls only under the pinned output schema, and carries structure only as text (P-24/B(b))", () => {
  const OUTPUT = { type: "object", properties: { hits: { type: "number" } }, required: ["hits"] };
  const REORDERED = { required: ["hits"], properties: { hits: { type: "number" } }, type: "object" };
  const STRUCTURED = { hits: 2 };
  let ports: ToolProtocolPort[] = [];
  let listLog = "";

  afterEach(async () => {
    for (const extra of ports) await extra.closeAll();
    ports = [];
  });

  /** A port over a fresh fake: `docs.search` pinned as told, answered as told. */
  function outputPort(
    options: Parameters<typeof writeFakeToolServer>[1],
    outputSchema: unknown,
    answer: Parameters<typeof writeFakeToolServer>[1]["answers"] = {},
  ): ToolProtocolPort {
    listLog = dir + "/p24b-lists.log";
    const fake = writeFakeToolServer(dir + "/p24b-" + String(ports.length), {
      callLog,
      pidLog,
      listLog,
      advertises: ["docs.search"],
      answers: { "docs.search": { kind: "STRUCTURED", structured: STRUCTURED, blocks: [JSON.stringify(STRUCTURED)] }, ...answer },
      ...options,
    });
    const pinned = { name: "docs.search", writes: false, inputSchema: { type: "object" }, ...(outputSchema === undefined ? {} : { outputSchema }) };
    const admitted = admitToolServer({
      serverId: "docs",
      transport: "STDIO",
      command: fake.command,
      args: fake.args,
      tools: [pinned as unknown as (typeof ALLOWLIST)[number]],
    });
    if (!admitted.ok) throw new Error("fixture server was not admitted: " + admitted.at);
    const created = createToolProtocolPort({ servers: [admitted.server], liveness: { isLive: (sessionId) => live.has(sessionId) } });
    ports.push(created);
    return created;
  }

  const callOn = (target: ToolProtocolPort) =>
    target.callTool({ sessionId: SESSION, serverId: "docs", toolName: "docs.search", identity: IMPLEMENTER, arguments: { q: "acp" } });

  it("completes under an output pin equal to the advertisement in another key order, carrying the mirror as text", async () => {
    const outcome = await callOn(outputPort({ outputSchemas: { "docs.search": REORDERED } }, OUTPUT));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.content).toEqual([JSON.stringify(STRUCTURED)]);
    expect(outcome.receipt).toMatchObject({ outcome: "COMPLETED", refusal: null, contentBlocks: 1 });
    expect(readToolCallLog(listLog)).toEqual(["list null"]);
    expect(readToolCallLog(callLog)).toEqual(["docs.search"]);
  });

  const mismatches: readonly (readonly [string, Parameters<typeof writeFakeToolServer>[1], unknown])[] = [
    ["pinned none, advertised some", { outputSchemas: { "docs.search": OUTPUT } }, null],
    ["pinned none by absence, advertised some", { outputSchemas: { "docs.search": OUTPUT } }, undefined],
    ["pinned some, advertised none", {}, OUTPUT],
    ["one nested key differs", { outputSchemas: { "docs.search": { ...OUTPUT, properties: { hits: { type: "string" } } } } }, OUTPUT],
  ];
  for (const [label, options, pin] of mismatches) {
    it("refuses " + label + " as SCHEMA_MISMATCH at server.tools.outputSchema, sends no call, and keeps the connection", async () => {
      const target = outputPort(options, pin);
      const outcome = await callOn(target);
      expect(outcome).toMatchObject({ ok: false, refusal: "SCHEMA_MISMATCH", at: "server.tools.outputSchema" });
      expect(Object.hasOwn(outcome, "content")).toBe(false);
      expect(outcome.receipt).toMatchObject({ outcome: "REFUSED", refusal: "SCHEMA_MISMATCH", resultBytes: 0, contentBlocks: 0 });
      // The same child answers the second call: the connection was kept.
      expect(await callOn(target)).toMatchObject({ ok: false, refusal: "SCHEMA_MISMATCH", at: "server.tools.outputSchema" });
      expect(readToolCallLog(callLog)).toEqual([]);
      expect(childPids()).toHaveLength(1);
      expect(childPids().every(pidAlive)).toBe(true);
    });
  }

  it("refuses an advertised outputSchema of null as a violation at server.tools, sends no call, and reaps the child", async () => {
    const target = outputPort({ outputSchemas: { "docs.search": null } }, OUTPUT);
    const outcome = await callOn(target);
    expect(outcome).toMatchObject({ ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.tools" });
    expect(outcome.receipt).toMatchObject({ outcome: "REFUSED", resultBytes: 0, contentBlocks: 0 });
    expect(readToolCallLog(callLog)).toEqual([]);
    const pids = childPids();
    expect(pids).toHaveLength(1);
    await vi.waitFor(() => {
      expect(pids.some(pidAlive)).toBe(false);
    });
    // The next call is answered by a new child, not by the connection that broke.
    expect(await callOn(target)).toMatchObject({ refusal: "PROTOCOL_VIOLATION", at: "server.tools" });
    expect(childPids()).toHaveLength(2);
    expect(readToolCallLog(callLog)).toEqual([]);
  });

  it("reports a tool whose input and output schemas both differ at inputSchema, one answer", async () => {
    const outcome = await callOn(
      outputPort({ schemas: { "docs.search": { type: "object", required: ["q"] } }, outputSchemas: { "docs.search": { type: "object" } } }, OUTPUT),
    );
    expect(outcome).toMatchObject({ ok: false, refusal: "SCHEMA_MISMATCH", at: "server.tools.inputSchema" });
  });

  it("refuses a result with no structured content under an output pin as a violation, with its counts, and reaps the child", async () => {
    const outcome = await callOn(
      outputPort({ outputSchemas: { "docs.search": OUTPUT } }, OUTPUT, { "docs.search": { kind: "TEXT", blocks: ["two hits", "done"] } }),
    );
    const sent = { content: [{ type: "text", text: "two hits" }, { type: "text", text: "done" }] };
    expect(outcome).toMatchObject({ ok: false, refusal: "PROTOCOL_VIOLATION", at: "server.result.structuredContent" });
    expect(Object.hasOwn(outcome, "content")).toBe(false);
    expect(outcome.receipt).toMatchObject({ outcome: "REFUSED", resultBytes: JSON.stringify(sent).length, contentBlocks: 2 });
    const pids = childPids();
    expect(pids).toHaveLength(1);
    await vi.waitFor(() => {
      expect(pids.some(pidAlive)).toBe(false);
    });
  });

  it("declines unmirrored structured content as RESULT_NOT_CARRIED with its counts, and keeps the connection", async () => {
    const target = outputPort({}, null, { "docs.search": { kind: "STRUCTURED", structured: STRUCTURED, blocks: ["Found two hits."] } });
    const outcome = await callOn(target);
    const sent = { content: [{ type: "text", text: "Found two hits." }], structuredContent: STRUCTURED };
    expect(outcome).toMatchObject({ ok: false, refusal: "RESULT_NOT_CARRIED", at: "server.result.structuredContent" });
    expect(Object.hasOwn(outcome, "content")).toBe(false);
    expect(outcome.receipt).toMatchObject({ outcome: "REFUSED", refusal: "RESULT_NOT_CARRIED", resultBytes: JSON.stringify(sent).length, contentBlocks: 1 });
    expect(await callOn(target)).toMatchObject({ refusal: "RESULT_NOT_CARRIED" });
    expect(readToolCallLog(callLog)).toEqual(["docs.search", "docs.search"]);
    expect(childPids()).toHaveLength(1);
    expect(childPids().every(pidAlive)).toBe(true);
  });

  it("still sees a credential shape inside mirrored structured content: RESULT_UNSAFE, no content", async () => {
    const leaking = { hits: 1, token: LEAKED };
    const outcome = await callOn(
      outputPort({ outputSchemas: { "docs.search": OUTPUT } }, OUTPUT, {
        "docs.search": { kind: "STRUCTURED", structured: leaking, blocks: [JSON.stringify(leaking)] },
      }),
    );
    expect(outcome).toMatchObject({ ok: false, refusal: "RESULT_UNSAFE", at: "server.result" });
    expect(Object.hasOwn(outcome, "content")).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(LEAKED);
  });

  it("lists an entry under an equal output pin, and refuses the listing on a different one", async () => {
    const equal = await outputPort({ outputSchemas: { "docs.search": REORDERED } }, OUTPUT).listTools(SESSION, "docs");
    expect(equal).toMatchObject({ ok: true, tools: [{ name: "docs.search", outputSchema: OUTPUT }] });
    const differing = await outputPort({ outputSchemas: { "docs.search": OUTPUT } }, null).listTools(SESSION, "docs");
    expect(differing).toEqual({ ok: false, refusal: "SCHEMA_MISMATCH", at: "server.tools.outputSchema" });
  });

  it("hands a declined result on through the operation scope as a coherent refusal with no content", async () => {
    const fake = writeFakeToolServer(dir + "/p24b-scope", {
      advertises: ["docs.search"],
      answers: { "docs.search": { kind: "STRUCTURED", structured: STRUCTURED, blocks: ["no mirror"] } },
    });
    const admitted = admitToolServer({
      serverId: "docs",
      transport: "STDIO",
      command: fake.command,
      args: fake.args,
      tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
    });
    if (!admitted.ok) throw new Error("fixture server was not admitted: " + admitted.at);
    const scopeId = "tool/7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a02/1/0";
    const scope = openToolOperation({ scopeId, servers: [admitted.server] });
    try {
      const outcome = await scope.callTool({ sessionId: scopeId, serverId: "docs", toolName: "docs.search", identity: IMPLEMENTER, arguments: {} });
      expect(outcome).toMatchObject({ ok: false, refusal: "RESULT_NOT_CARRIED", at: "server.result.structuredContent" });
      expect(outcome.receipt).toMatchObject({ outcome: "REFUSED", refusal: "RESULT_NOT_CARRIED" });
      expect(Object.hasOwn(outcome, "content")).toBe(false);
    } finally {
      await scope.close();
    }
  });
});
