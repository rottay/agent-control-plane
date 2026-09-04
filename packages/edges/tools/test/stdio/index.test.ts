import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { admitToolServer } from "../../src/admission/index.js";
import type { AdmittedStdioToolServer } from "../../src/admission/index.js";
import { createToolClient } from "../../src/client/index.js";
import { TOOL_SERVER_ENV_KEYS } from "../../src/contract/index.js";
import type { FakeToolServerScript } from "../testing/index.js";
import { openToolStdioConnection } from "../../src/stdio/index.js";
import {
  makeToolFixtureDir,
  removeToolFixtureDir,
  writeFakeToolServer,
} from "../testing/index.js";

let dir = "";

beforeEach(() => {
  dir = makeToolFixtureDir();
});

afterEach(() => {
  removeToolFixtureDir(dir);
});

/** Is this pid still a process? `signal 0` asks without delivering anything. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function admit(script: FakeToolServerScript): AdmittedStdioToolServer {
  const fake = writeFakeToolServer(dir, script);
  const outcome = admitToolServer({
    serverId: "docs",
    transport: "STDIO",
    command: fake.command,
    args: fake.args,
    tools: [{ name: "docs.search", writes: false }],
  });
  if (!outcome.ok) throw new Error("fixture server was not admitted: " + outcome.at);
  if (outcome.server.kind !== "STDIO") throw new Error("fixture server is not a stdio server");
  return outcome.server;
}

describe("the stdio transport speaks MCP to a real child", () => {
  it("completes initialize, tools/list and tools/call", async () => {
    const server = admit({
      serverName: "docs-server",
      answers: { "docs.search": { kind: "TEXT", blocks: ["the answer"] } },
    });
    const connection = openToolStdioConnection(server);
    const client = createToolClient(connection);

    await expect(client.initialize()).resolves.toEqual({ ok: true, value: "docs-server" });
    await expect(client.listTools()).resolves.toEqual({ ok: true, value: ["docs.search"] });

    const called = await client.callTool("docs.search", { q: "acp" });
    expect(called.ok).toBe(true);
    if (called.ok) expect(called.value.content).toEqual(["the answer"]);

    await client.close();
  });

  it("gives the child the allowlisted variables and nothing ambient", async () => {
    // `__CF_USER_TEXT_ENCODING` is injected by macOS on the `posix_spawn`
    // path and arrives even when the environment handed to `spawn` is
    // completely empty. It is named here rather than tolerated by a loose
    // assertion: this suite asserts what *this package* passes, and the one
    // name the platform adds underneath it is a measured fact, not a leak
    // through the allowlist. Anything else appearing here would be.
    const PLATFORM_INJECTED = ["__CF_USER_TEXT_ENCODING"];

    process.env["ACP_TOOLS_STDIO_CANARY"] = "must-not-travel";
    const server = admit({ answers: { "docs.search": { kind: "ENV" } } });
    const connection = openToolStdioConnection(server);
    const client = createToolClient(connection);

    const called = await client.callTool("docs.search", {});
    expect(called.ok).toBe(true);
    if (!called.ok) return;
    const names = (called.value.content[0] ?? "").split(",").filter((name) => name.length > 0);

    for (const name of names) {
      expect([...TOOL_SERVER_ENV_KEYS, ...PLATFORM_INJECTED]).toContain(name);
    }
    expect(names).not.toContain("ACP_TOOLS_STDIO_CANARY");

    // The load-bearing direction: this process holds far more than three
    // variables, and none of the others reached the child.
    const inherited = names.filter(
      (name) =>
        !(TOOL_SERVER_ENV_KEYS as readonly string[]).includes(name) &&
        !PLATFORM_INJECTED.includes(name),
    );
    expect(inherited).toEqual([]);
    expect(Object.keys(process.env).length).toBeGreaterThan(names.length);

    await client.close();
  });

  it("reassembles a frame the operating system split, and answers in order", async () => {
    const server = admit({
      answers: {
        "docs.search": { kind: "TEXT", blocks: ["a".repeat(2_000), "b".repeat(2_000)] },
      },
    });
    const connection = openToolStdioConnection(server);
    const client = createToolClient(connection);
    const called = await client.callTool("docs.search", {});
    expect(called.ok).toBe(true);
    if (called.ok) {
      expect(called.value.content).toEqual(["a".repeat(2_000), "b".repeat(2_000)]);
    }
    await client.close();
  });
});

describe("closing reaps the child, and means it twice", () => {
  it("leaves no process behind, and a second close is a no-op", async () => {
    const server = admit({ answers: { "docs.search": { kind: "TEXT", blocks: ["ok"] } } });
    const connection = openToolStdioConnection(server);
    const client = createToolClient(connection);
    await client.initialize();
    expect(pidAlive(connection.pid)).toBe(true);

    await connection.close();
    // Asserted on the pid rather than on a report: a close that said it
    // reaped and did not is exactly the failure this asserts against.
    expect(pidAlive(connection.pid)).toBe(false);

    await connection.close();
    expect(pidAlive(connection.pid)).toBe(false);
  });

  it("refuses to write to a closed connection rather than dropping the frame", async () => {
    const server = admit({ answers: { "docs.search": { kind: "TEXT", blocks: ["ok"] } } });
    const connection = openToolStdioConnection(server);
    await connection.close();
    expect(() => {
      connection.write("{}\n");
    }).toThrow();
  });
});

describe("the child's hard lifetime is a bound, not a number", () => {
  it("kills a server that outlives the backstop", async () => {
    // Observed at a small value and awaited as an event, never slept on. A
    // ceiling no test can reach would be a constant nobody has ever seen fire.
    const server = admit({ answers: { "docs.search": { kind: "SILENT" } } });
    const connection = openToolStdioConnection(server, 150);
    const ended = new Promise<void>((resolve) => {
      connection.onEnd(() => {
        resolve();
      });
    });
    await ended;
    expect(pidAlive(connection.pid)).toBe(false);
    await connection.close();
  });
});

describe("a server that violates the protocol takes its connection with it", () => {
  it("breaks on a malformed frame from a real child", async () => {
    const server = admit({ answers: { "docs.search": { kind: "MALFORMED" } } });
    const connection = openToolStdioConnection(server);
    const client = createToolClient(connection);
    await expect(client.callTool("docs.search", {})).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
    await client.close();
    expect(pidAlive(connection.pid)).toBe(false);
  });

  it("breaks on a frame over the frame ceiling", async () => {
    const server = admit({
      answers: { "docs.search": { kind: "OVERSIZED_FRAME", bytes: 200_000 } },
    });
    const connection = openToolStdioConnection(server);
    const client = createToolClient(connection);
    await expect(client.callTool("docs.search", {})).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
    await client.close();
    expect(pidAlive(connection.pid)).toBe(false);
  });

  it("breaks on an answer correlated to nothing it sent", async () => {
    const server = admit({ answers: { "docs.search": { kind: "UNKNOWN_ID" } } });
    const connection = openToolStdioConnection(server);
    const client = createToolClient(connection);
    await expect(client.callTool("docs.search", {})).resolves.toEqual({
      ok: false,
      refusal: "PROTOCOL_VIOLATION",
      at: "server.response",
    });
    await client.close();
    expect(pidAlive(connection.pid)).toBe(false);
  });
});
