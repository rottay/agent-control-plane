import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { admitToolServer } from "../../src/admission/index.js";
import { TOOL_SERVER_ENV_KEYS } from "../../src/contract/index.js";
import type { ToolServerDescriptor } from "../../src/contract/index.js";
import {
  makeToolFixtureDir,
  removeToolFixtureDir,
  writeFakeToolServer,
} from "../testing/index.js";

let dir = "";
let command = "";
let args: readonly string[] = [];

beforeEach(() => {
  dir = makeToolFixtureDir();
  const fake = writeFakeToolServer(dir, { answers: { "docs.search": { kind: "TEXT", blocks: ["ok"] } } });
  command = fake.command;
  args = fake.args;
});

afterEach(() => {
  removeToolFixtureDir(dir);
});

const stdio = (overrides: Partial<ToolServerDescriptor> = {}): ToolServerDescriptor => ({
  serverId: "docs",
  transport: "STDIO",
  command,
  args,
  tools: [{ name: "docs.search", writes: false }],
  ...overrides,
});

describe("a stdio descriptor is admitted, and its environment is built not inherited", () => {
  it("admits an absolute, existing, owned executable", () => {
    const outcome = admitToolServer(stdio());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.server.kind).toBe("STDIO");
    expect(outcome.server.command).toBe(command);
    expect(outcome.server.allowlist).toEqual([{ name: "docs.search", writes: false }]);
  });

  it("gives the child exactly the allowlisted variables and nothing ambient", () => {
    process.env["ACP_TOOLS_LEAK_CANARY"] = "should-not-travel";
    const outcome = admitToolServer(stdio());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const keys = Object.keys(outcome.server.env);
    for (const key of keys) expect(TOOL_SERVER_ENV_KEYS).toContain(key);
    expect(keys).not.toContain("ACP_TOOLS_LEAK_CANARY");
    expect(JSON.stringify(outcome.server.env)).not.toContain("should-not-travel");
  });
});

describe("an unknown transport is the remote refusal", () => {
  // This is the certification negative. Each of these is a descriptor an
  // operator could plausibly write against a hosted MCP server.
  it.each(["HTTP", "HTTPS", "SSE", "STREAMABLE_HTTP", "WEBSOCKET", "LOOPBACK", "stdio", ""])(
    "refuses transport %j at descriptor.transport",
    (transport) => {
      const outcome = admitToolServer(stdio({ transport }));
      expect(outcome).toEqual({
        ok: false,
        refusal: "TRANSPORT_REFUSED",
        at: "descriptor.transport",
      });
    },
  );
});

describe("a URL-shaped descriptor is parsed, then refused field by field", () => {
  // Refusing the *presence* of a url would be the easy version and the wrong
  // one: nothing would ever have parsed a URL, and the stage that admits a
  // loopback Streamable HTTP server would have to delete this rather than
  // widen it.
  it.each([
    ["https://mcp.example.com/sse", "descriptor.url.protocol"],
    ["ws://127.0.0.1:9000/mcp", "descriptor.url.protocol"],
    ["http://user:pw@127.0.0.1:9000/mcp", "descriptor.url.credentials"],
    ["http://10.0.0.5:9000/mcp", "descriptor.url.hostname"],
    ["http://0.0.0.0:9000/mcp", "descriptor.url.hostname"],
    ["http://example.com:9000/mcp", "descriptor.url.hostname"],
    // Named explicitly: it is the one a reviewer expects to pass. Resolving a
    // name means DNS, and a name that resolves on-box today is a remote server
    // tomorrow.
    ["http://localhost:9000/mcp", "descriptor.url.hostname"],
    ["http://127.0.0.1/mcp", "descriptor.url.port"],
    ["not a url at all", "descriptor.url"],
  ])("refuses %s at %s", (url, at) => {
    const outcome = admitToolServer(stdio({ url }));
    expect(outcome).toEqual({ ok: false, refusal: "TRANSPORT_REFUSED", at });
  });

  it("refuses even a well-formed loopback URL, because no transport carries one yet", () => {
    // The parse happened and every field was judged; the refusal names the
    // reason that is actually true rather than a manufactured one.
    for (const url of ["http://127.0.0.1:9000/mcp", "http://[::1]:9000/mcp"]) {
      expect(admitToolServer(stdio({ url }))).toEqual({
        ok: false,
        refusal: "TRANSPORT_REFUSED",
        at: "descriptor.url",
      });
    }
  });
});

describe("the stdio fields are admitted, never assumed", () => {
  it("refuses a relative command", () => {
    expect(admitToolServer(stdio({ command: "node" }))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.command",
    });
  });

  it("refuses a command that does not exist", () => {
    expect(admitToolServer(stdio({ command: dir + "/absent" }))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.command",
    });
  });

  it("refuses a command that is a directory", () => {
    expect(admitToolServer(stdio({ command: dir }))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.command",
    });
  });

  it("refuses a missing command outright", () => {
    const descriptor: ToolServerDescriptor = {
      serverId: "docs",
      transport: "STDIO",
      tools: [{ name: "docs.search", writes: false }],
    };
    expect(admitToolServer(descriptor)).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.command",
    });
  });

  it("refuses an empty allowlist: a server nothing can call", () => {
    expect(admitToolServer(stdio({ tools: [] }))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.tools",
    });
  });

  it("refuses a repeated tool name", () => {
    expect(
      admitToolServer(
        stdio({
          tools: [
            { name: "docs.search", writes: false },
            { name: "docs.search", writes: true },
          ],
        }),
      ),
    ).toEqual({ ok: false, refusal: "SERVER_NOT_ADMITTED", at: "descriptor.tools" });
  });

  it("refuses an empty serverId", () => {
    expect(admitToolServer(stdio({ serverId: "" }))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.serverId",
    });
  });
});

describe("a name outside the bounded grammar never reaches a spawn (V2-B4b stage 3A)", () => {
  // The door and the durable recorder now judge by the same constant, so a
  // name admitted here is a name `recordToolCall` can write down. Before this
  // stage the door asked only whether the string was non-empty, and a server
  // id with a space in it was admitted, spawned, called — and then refused by
  // the recorder, after the child had already run.
  it.each([
    ["docs local", "a space"],
    ["x".repeat(121), "one character past the bound"],
    [".docs", "a leading dot"],
    ["docs/search", "a slash"],
    ['docs"quote', "a quote"],
  ])("refuses serverId %j (%s) at descriptor.serverId", (serverId) => {
    expect(admitToolServer(stdio({ serverId }))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.serverId",
    });
  });

  it.each([
    ["docs search", "a space"],
    ["docs/search", "a slash"],
    ["x".repeat(121), "one character past the bound"],
    [".docs.search", "a leading dot"],
  ])("refuses tool name %j (%s) at descriptor.tools", (name) => {
    expect(admitToolServer(stdio({ tools: [{ name, writes: false }] }))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.tools",
    });
  });

  it("refuses a bad name even when a good one sits beside it", () => {
    // Every entry is judged, not just the first: an allowlist whose second
    // member is unrecordable is an allowlist that can produce an unrecordable
    // call.
    expect(
      admitToolServer(
        stdio({
          tools: [
            { name: "docs.search", writes: false },
            { name: "docs write", writes: true },
          ],
        }),
      ),
    ).toEqual({ ok: false, refusal: "SERVER_NOT_ADMITTED", at: "descriptor.tools" });
  });

  it("still admits the names the package already uses", () => {
    // The regression direction. `docs.search` is the fixture every other suite
    // in this package is written against, and the grammar admits it, a
    // hyphenated id, and a colon-and-underscore name — so nothing landed had
    // to move to make the door stricter.
    for (const serverId of ["docs", "acct-primary", "a:b_c"]) {
      const outcome = admitToolServer(stdio({ serverId }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.server.serverId).toBe(serverId);
      expect(outcome.server.allowlist).toEqual([{ name: "docs.search", writes: false }]);
    }
  });
});

describe("a credential cannot be described at all", () => {
  it("carries no secret-bearing field into the admitted server", () => {
    // The refusal is by the absence of a field, not by a scan. An operator
    // reaching for a credential has nowhere to put one, and whatever they
    // attach to the descriptor object does not survive admission.
    const outcome = admitToolServer({
      ...stdio(),
      ...({ apiKey: "sk-not-a-real-key-0123456789" } as Record<string, unknown>),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(JSON.stringify(outcome.server)).not.toContain("sk-not-a-real-key");
    expect(Object.keys(outcome.server).sort()).toEqual([
      "allowlist",
      "args",
      "command",
      "env",
      "kind",
      "serverId",
    ]);
  });
});
