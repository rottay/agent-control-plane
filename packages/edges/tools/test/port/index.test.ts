import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerIdentityString } from "@acp/contracts";

import { admitToolServer } from "../../src/admission/index.js";
import type { AdmittedToolServer } from "../../src/admission/index.js";
import {
  TOOL_ARGUMENTS_BYTES_MAX,
  TOOL_CALL_TIMEOUT_MS,
  TOOL_TRANSPORT_UNRESOLVED,
} from "../../src/contract/index.js";
import { createToolProtocolPort } from "../../src/port/index.js";
import type { ToolProtocolPort } from "../../src/port/index.js";
import {
  makeToolFixtureDir,
  readToolCallLog,
  removeToolFixtureDir,
  writeFakeToolServer,
} from "../testing/index.js";

const IMPLEMENTER = "claude/opus/implementer/01" as WorkerIdentityString;
const SESSION = "task-1/1/acct-1";

const ALLOWLIST = [
  { name: "docs.search", writes: false },
  { name: "docs.write", writes: true },
  { name: "docs.huge", writes: false },
  { name: "docs.leak", writes: false },
  { name: "docs.silent", writes: false },
  { name: "docs.malformed", writes: false },
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
      servers: [{ ...server, allowlist: [...ALLOWLIST, { name: "docs.absent", writes: false }] }],
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
        tools: [{ name: "docs.search", writes: false }],
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
