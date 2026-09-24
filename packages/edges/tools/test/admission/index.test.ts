import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { admitToolServer, admitToolServers } from "../../src/admission/index.js";
import { TOOL_SCHEMA_BYTES_MAX, TOOL_SCHEMA_DEPTH_MAX, TOOL_SERVER_ENV_KEYS } from "../../src/contract/index.js";
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
  tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
  ...overrides,
});

describe("a stdio descriptor is admitted, and its environment is built not inherited", () => {
  it("admits an absolute, existing, owned executable", () => {
    const outcome = admitToolServer(stdio());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.server.kind).toBe("STDIO");
    // Narrowed on the union V2-B4b S4-1 introduced: `command` belongs to the
    // stdio arm, and the loopback arm deliberately has none.
    if (outcome.server.kind !== "STDIO") return;
    expect(outcome.server.command).toBe(command);
    expect(outcome.server.allowlist).toEqual([{ name: "docs.search", writes: false, inputSchema: { type: "object" } }]);
  });

  it("gives the child exactly the allowlisted variables and nothing ambient", () => {
    process.env["ACP_TOOLS_LEAK_CANARY"] = "should-not-travel";
    const outcome = admitToolServer(stdio());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.server.kind !== "STDIO") return;
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
      tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
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
            { name: "docs.search", writes: false, inputSchema: { type: "object" } },
            { name: "docs.search", writes: true, inputSchema: { type: "object" } },
          ],
        }),
      ),
    ).toEqual({ ok: false, refusal: "SERVER_NOT_ADMITTED", at: "descriptor.tools[1].name" });
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
  ])("refuses tool name %j (%s) at descriptor.tools[0].name", (name) => {
    expect(admitToolServer(stdio({ tools: [{ name, writes: false, inputSchema: { type: "object" } }] }))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.tools[0].name",
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
            { name: "docs.search", writes: false, inputSchema: { type: "object" } },
            { name: "docs write", writes: true, inputSchema: { type: "object" } },
          ],
        }),
      ),
    ).toEqual({ ok: false, refusal: "SERVER_NOT_ADMITTED", at: "descriptor.tools[1].name" });
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
      expect(outcome.server.allowlist).toEqual([{ name: "docs.search", writes: false, inputSchema: { type: "object" } }]);
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

describe("the loopback leg is admitted, and the refusal finally has a sibling (V2-B4b S4-1)", () => {
  function loopback(overrides: Record<string, unknown> = {}): ToolServerDescriptor {
    return {
      serverId: "docs",
      transport: "HTTP_LOOPBACK",
      url: "http://127.0.0.1:9000/mcp",
      tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
      ...overrides,
    } as unknown as ToolServerDescriptor;
  }

  it("admits a loopback endpoint and keeps its URL byte for byte", () => {
    const outcome = admitToolServer(loopback());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.server.kind).toBe("HTTP_LOOPBACK");
    if (outcome.server.kind !== "HTTP_LOOPBACK") return;
    // Verbatim. A URL this package rewrote would be a URL the operator never
    // reviewed, and there is nothing to construct: one endpoint serves every
    // method.
    expect(outcome.server.url).toBe("http://127.0.0.1:9000/mcp");
    // No child, so no spawn fields and -- the one worth asserting -- no
    // environment was built at all on this branch.
    expect("command" in outcome.server).toBe(false);
    expect("args" in outcome.server).toBe(false);
    expect("env" in outcome.server).toBe(false);
  });

  it("admits the bracketed IPv6 loopback, brackets intact", () => {
    const outcome = admitToolServer(loopback({ url: "http://[::1]:9000/mcp" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.server.kind !== "HTTP_LOOPBACK") return;
    expect(outcome.server.url).toBe("http://[::1]:9000/mcp");
  });

  it("refuses every endpoint that is not plaintext loopback, field-exactly", () => {
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["tls", loopback({ url: "https://127.0.0.1:9000/mcp" }), "descriptor.url.protocol"],
      ["credentials", loopback({ url: "http://user:pw@127.0.0.1:9000/mcp" }), "descriptor.url.credentials"],
      ["routable", loopback({ url: "http://10.0.0.5:9000/mcp" }), "descriptor.url.hostname"],
      // A name, not a literal: resolving it means DNS, and a name that resolves
      // on-box today is a remote server tomorrow.
      ["name", loopback({ url: "http://localhost:9000/mcp" }), "descriptor.url.hostname"],
      ["no port", loopback({ url: "http://127.0.0.1/mcp" }), "descriptor.url.port"],
      ["port zero", loopback({ url: "http://127.0.0.1:0/mcp" }), "descriptor.url.port"],
      // Refused at `descriptor.url`, not `.port`: the WHATWG parser rejects a
      // port above 65535 outright, so the parse fails before the port check is
      // reached. Pre-existing behaviour, asserted as it is rather than as the
      // field name might suggest.
      ["port too high", loopback({ url: "http://127.0.0.1:70000/mcp" }), "descriptor.url"],
      ["no url", { serverId: "docs", transport: "HTTP_LOOPBACK", tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }] }, "descriptor.url"],
    ];
    for (const [label, descriptor, at] of cases) {
      const outcome = admitToolServer(descriptor as ToolServerDescriptor);
      expect({ label, ok: outcome.ok }).toEqual({ label, ok: false });
      if (outcome.ok) continue;
      expect({ label, refusal: outcome.refusal, at: outcome.at }).toEqual({
        label,
        refusal: "TRANSPORT_REFUSED",
        at,
      });
    }
  });

  it("refuses a descriptor that asks to spawn and to connect, never disambiguating", () => {
    const withCommand = admitToolServer(loopback({ command }));
    expect(withCommand.ok).toBe(false);
    if (!withCommand.ok) {
      expect({ refusal: withCommand.refusal, at: withCommand.at }).toEqual({
        refusal: "SERVER_NOT_ADMITTED",
        at: "descriptor.command",
      });
    }
    const withArgs = admitToolServer(loopback({ args: ["--x"] }));
    expect(withArgs.ok).toBe(false);
    if (!withArgs.ok) expect(withArgs.at).toBe("descriptor.args");
  });

  it("still refuses a stdio descriptor carrying a well-formed loopback url", () => {
    // Unchanged by the new leg, and the reason the union widens without
    // deleting a negative: a STDIO descriptor with a url is a remote server
    // that lied about its transport, loopback or not.
    const outcome = admitToolServer({
      serverId: "docs",
      transport: "STDIO",
      command,
      url: "http://127.0.0.1:9000/mcp",
      tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect({ refusal: outcome.refusal, at: outcome.at }).toEqual({
        refusal: "TRANSPORT_REFUSED",
        at: "descriptor.url",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// P-24 (ADR 0109): the schema pin, and one indexed `at` grammar (C2, C7)
// ---------------------------------------------------------------------------

describe("every allowlist entry pins the schema it was allowed under (P-24)", () => {
  const withPin = (inputSchema: unknown): ToolServerDescriptor =>
    stdio({ tools: [{ name: "docs.search", writes: false, inputSchema } as unknown as ToolServerDescriptor["tools"][number]] });

  /** A schema `levels` containers deep, the outermost an object schema. */
  const deepPin = (levels: number): Record<string, unknown> => {
    let value: unknown = "leaf";
    for (let level = 1; level < levels; level += 1) value = { child: value };
    return { type: "object", nested: value };
  };

  it("refuses a pin that is absent, null or not an object, at the entry's field", () => {
    for (const pin of [undefined, null, [], "object", 1, true]) {
      expect({ pin: (JSON.stringify(pin) as string | undefined) ?? "undefined", outcome: admitToolServer(withPin(pin)) }).toEqual({
        pin: (JSON.stringify(pin) as string | undefined) ?? "undefined",
        outcome: { ok: false, refusal: "SERVER_NOT_ADMITTED", at: "descriptor.tools[0].inputSchema" },
      });
    }
  });

  it("refuses a pin that is not an object schema: no conformant server could match it (C2)", () => {
    for (const pin of [{ type: "array" }, {}, { type: null }, { type: "string" }]) {
      expect(admitToolServer(withPin(pin))).toEqual({
        ok: false,
        refusal: "SERVER_NOT_ADMITTED",
        at: "descriptor.tools[0].inputSchema",
      });
    }
    expect(admitToolServer(withPin({ type: "object" })).ok).toBe(true);
  });

  it("admits a pin at its byte bound and refuses one past it", () => {
    const sized = (bytes: number): Record<string, unknown> => {
      const empty = JSON.stringify({ type: "object", description: "" }).length;
      return { type: "object", description: "d".repeat(bytes - empty) };
    };
    expect(JSON.stringify(sized(TOOL_SCHEMA_BYTES_MAX)).length).toBe(TOOL_SCHEMA_BYTES_MAX);
    expect(admitToolServer(withPin(sized(TOOL_SCHEMA_BYTES_MAX))).ok).toBe(true);
    expect(admitToolServer(withPin(sized(TOOL_SCHEMA_BYTES_MAX + 1)))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.tools[0].inputSchema",
    });
  });

  it("admits a pin at its depth bound and refuses one past it", () => {
    expect(admitToolServer(withPin(deepPin(TOOL_SCHEMA_DEPTH_MAX))).ok).toBe(true);
    expect(admitToolServer(withPin(deepPin(TOOL_SCHEMA_DEPTH_MAX + 1)))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.tools[0].inputSchema",
    });
  });

  it("keeps a frozen copy of the pin, so a later edit of the caller's object changes nothing", () => {
    const pin: Record<string, unknown> = { type: "object", properties: { q: { type: "string" } } };
    const outcome = admitToolServer(withPin(pin));
    if (!outcome.ok) throw new Error("expected an admission");
    pin["type"] = "array";
    const admitted = outcome.server.allowlist[0]?.inputSchema;
    expect(admitted).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen((admitted as { properties: object }).properties)).toBe(true);
  });
});

describe("the allowlist loop names the entry and the field it refused (P-24, C7)", () => {
  const entry = (overrides: Record<string, unknown>): unknown => ({
    name: "docs.search",
    writes: false,
    inputSchema: { type: "object" },
    ...overrides,
  });
  const tools = (...entries: unknown[]): ToolServerDescriptor["tools"] =>
    entries as unknown as ToolServerDescriptor["tools"];

  it("keeps descriptor.tools for the array itself", () => {
    expect(admitToolServer(stdio({ tools: [] }))).toEqual({ ok: false, refusal: "SERVER_NOT_ADMITTED", at: "descriptor.tools" });
    expect(admitToolServer(stdio({ tools: "x" as unknown as ToolServerDescriptor["tools"] }))).toEqual({
      ok: false,
      refusal: "SERVER_NOT_ADMITTED",
      at: "descriptor.tools",
    });
  });

  it("indexes an entry that is not an object, and each field defect", () => {
    const rows: readonly (readonly [ToolServerDescriptor["tools"], string])[] = [
      [tools(entry({}), null), "descriptor.tools[1]"],
      [tools(entry({}), []), "descriptor.tools[1]"],
      [tools(entry({}), "docs.search"), "descriptor.tools[1]"],
      [tools(entry({ name: 7 })), "descriptor.tools[0].name"],
      [tools(entry({ writes: "no" })), "descriptor.tools[0].writes"],
      [tools(entry({}), entry({ name: "docs.write", inputSchema: undefined })), "descriptor.tools[1].inputSchema"],
      [tools(entry({}), entry({})), "descriptor.tools[1].name"],
    ];
    for (const [list, at] of rows) {
      expect(admitToolServer(stdio({ tools: list }))).toEqual({ ok: false, refusal: "SERVER_NOT_ADMITTED", at });
    }
  });

  it("carries the index through the document as servers[k].tools[i].<field>", () => {
    expect(
      admitToolServers([
        {
          serverId: "docs",
          transport: "STDIO",
          command,
          args,
          tools: [{ name: "docs.search", writes: false }],
        },
      ]),
    ).toEqual({ ok: false, refusal: "SERVER_NOT_ADMITTED", at: "servers[0].tools[0].inputSchema" });
  });
});
