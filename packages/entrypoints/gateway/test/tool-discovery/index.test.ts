/**
 * Evidence for the API's discovery door (P-24/B(a), ADR 0118):
 * `GET /api/v1/tool-servers/:serverId/tools`.
 *
 * Every row enters through `buildServer` and `inject`, the real door: the private
 * registrar, the path parameter, the query law, the tool edge's discovery scope
 * and the projection are all on the path under test.
 *
 * The fake MCP server is **this suite's own copy**, written to a temp dir, for
 * the reason the tool-call suite gives. It logs its pid and every method it is
 * asked, so each row can assert that no `tools/call` was ever sent and that the
 * child was reaped before the response was sent.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLedger } from "@acp/ledger";
import {
  API_CONTRACT_VERSION,
  ApiError,
  EventPageResponse,
  LEDGER_CONTRACT_VERSION,
  LedgerStatusResponse,
  MAX_DISCOVERED_TOOLS,
  ToolDiscoveryResponse,
  toolServerToolsPath,
} from "@acp/protocol";
import { TOOL_LIST_PAGES_MAX, TOOL_LIST_TOOLS_MAX } from "@acp/tools";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";

const roots: string[] = [];
const TOKEN = "p24-b-a-discovery-" + "t".repeat(26);
const AUTH = { authorization: "Bearer " + TOKEN };
const SUBMITTED_AT = "2026-09-25T12:00:00.000Z";

function root(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-tool-discovery-")));
  roots.push(created);
  return created;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What the fake advertises, and how it pages. */
interface FakeScript {
  readonly advertises?: readonly string[];
  readonly schemas?: Readonly<Record<string, unknown>>;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
  readonly pageSize?: number;
  readonly cursorCycle?: boolean;
}

function writeFake(dir: string, pidLog: string, methodLog: string, script: FakeScript): { command: string; args: string[] } {
  const path = join(dir, "fake-mcp-discovery.mjs");
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(" + JSON.stringify(pidLog) + ", String(process.pid) + '\\n');",
      "const LOG = " + JSON.stringify(methodLog) + ";",
      "const ADVERTISES = " + JSON.stringify(script.advertises ?? ["docs.search", "docs.write"]) + ";",
      "const SCHEMAS = " + JSON.stringify(script.schemas ?? {}) + ";",
      "const OUTPUT_SCHEMAS = " + JSON.stringify(script.outputSchemas ?? {}) + ";",
      "const PAGE = " + JSON.stringify(script.pageSize ?? null) + ";",
      "const CYCLE = " + JSON.stringify(script.cursorCycle === true) + ";",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  let index = buffer.indexOf('\\n');",
      "  while (index >= 0) {",
      "    const line = buffer.slice(0, index);",
      "    buffer = buffer.slice(index + 1);",
      "    index = buffer.indexOf('\\n');",
      "    if (line.trim() !== '') handle(JSON.parse(line));",
      "  }",
      "});",
      "function frame(value) { return JSON.stringify(value) + '\\n'; }",
      "function handle(message) {",
      "  const { id, method, params } = message;",
      "  if (method === 'initialize') {",
      "    process.stdout.write(frame({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18',",
      "      capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } }));",
      "    return;",
      "  }",
      "  if (method === 'notifications/initialized') return;",
      "  if (method === 'tools/list') {",
      "    const cursor = params && typeof params.cursor === 'string' ? params.cursor : null;",
      "    appendFileSync(LOG, 'list ' + String(cursor) + '\\n');",
      "    const all = ADVERTISES.map((name) => ({ name, inputSchema: Object.hasOwn(SCHEMAS, name) ? SCHEMAS[name] : { type: 'object' },",
      "      ...(Object.hasOwn(OUTPUT_SCHEMAS, name) ? { outputSchema: OUTPUT_SCHEMAS[name] } : {}) }));",
      "    const size = PAGE === null ? all.length : PAGE;",
      "    const start = cursor === null ? 0 : Number(cursor.slice(1));",
      "    const result = { tools: all.slice(start, start + size) };",
      "    if (start + size < all.length) result.nextCursor = CYCLE && start > 0 ? 'c' + String(size) : 'c' + String(start + size);",
      "    process.stdout.write(frame({ jsonrpc: '2.0', id, result }));",
      "    return;",
      "  }",
      "  if (method === 'tools/call') {",
      "    appendFileSync(LOG, 'call ' + String(params && params.name) + '\\n');",
      "    process.stdout.write(frame({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'never' }] } }));",
      "  }",
      "}",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o700);
  return { command: realpathSync(process.execPath), args: [path] };
}

const PIN = { type: "object", properties: { q: { type: "string" } } };
const DEFAULT_ALLOWLIST: readonly Record<string, unknown>[] = [
  { name: "docs.search", writes: false, inputSchema: PIN },
  { name: "docs.write", writes: true, inputSchema: { type: "object" } },
];

interface Harness {
  readonly app: ReturnType<typeof buildServer>;
  readonly dir: string;
  readonly pidLog: string;
  readonly methodLog: string;
  readonly ledgerPath: string;
}

function tokenFile(dir: string): string {
  const path = join(dir, "write.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

function makeEvent(): Record<string, unknown> {
  const taskId = randomUUID();
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId,
    attempt: 1,
    transitionId: "discover",
    idempotencyKey: taskId + "/1/discover",
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "fixture/seed/coordinator/01",
    occurredAt: SUBMITTED_AT,
    recordedAt: SUBMITTED_AT,
    correlationId: null,
    causationId: null,
    payload: {},
  };
}

function harness(
  script: FakeScript = {},
  options: {
    readonly allowlist?: readonly Record<string, unknown>[];
    readonly withDocument?: boolean;
    readonly withBearer?: boolean;
  } = {},
): Harness {
  const dir = root();
  mkdirSync(join(dir, "ledger"), { recursive: true });
  const ledgerPath = join(dir, "ledger", "acp.sqlite3");
  const ledger = openLedger(ledgerPath);
  ledger.append(makeEvent());
  ledger.close();
  const pidLog = join(dir, "pids.log");
  const methodLog = join(dir, "methods.log");
  writeFileSync(pidLog, "", "utf8");
  const fake = writeFake(dir, pidLog, methodLog, script);
  const documentPath = join(dir, "tool-servers.json");
  writeFileSync(
    documentPath,
    JSON.stringify([
      { serverId: "docs", transport: "STDIO", command: fake.command, args: fake.args, tools: options.allowlist ?? DEFAULT_ALLOWLIST },
    ]),
    "utf8",
  );
  chmodSync(documentPath, 0o600);
  return {
    app: buildServer({
      ledgerPath,
      ...(options.withBearer === false ? {} : { writeBearerPath: tokenFile(dir) }),
      ...(options.withDocument === false ? {} : { toolServersPath: documentPath }),
    }),
    dir,
    pidLog,
    methodLog,
    ledgerPath,
  };
}

function lines(path: string): readonly string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

function pids(h: Harness): readonly number[] {
  return lines(h.pidLog).map((line) => Number(line));
}

async function discover(h: Harness, serverId = "docs", headers: Record<string, string> = AUTH) {
  return await h.app.inject({ method: "GET", url: toolServerToolsPath(serverId), headers });
}

/** An answered row: 200, never cached, no call sent, one child and it is gone. */
function answered(h: Harness, response: Awaited<ReturnType<typeof discover>>): ToolDiscoveryResponse {
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(lines(h.methodLog).filter((line) => line.startsWith("call "))).toEqual([]);
  const started = pids(h);
  expect(started).toHaveLength(1);
  // Reaped by pid before the response was sent.
  for (const pid of started) expect(() => process.kill(pid, 0)).toThrow();
  return ToolDiscoveryResponse.parse(response.json());
}

function refused(response: Awaited<ReturnType<typeof discover>>, status: number, code: string): ApiError {
  expect(response.statusCode).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  const body = ApiError.parse(response.json());
  expect(body.error.code).toBe(code);
  return body;
}

const unbounded = Array.from({ length: TOOL_LIST_PAGES_MAX + 1 }, (_, index) => "a." + String(index));

describe("the discovery read answers the port's listing, sends no call, and reaps the child (D1-D7)", () => {
  it("D1: pins equal, one allowlisted tool advertised beside one nobody allowed", async () => {
    const h = harness({ advertises: ["docs.search", "shell.exec"], schemas: { "docs.search": PIN } });
    try {
      const response = await discover(h);
      expect(answered(h, response)).toEqual({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        serverId: "docs",
        outcome: "COMPLETED",
        refusal: null,
        at: null,
        toolName: null,
        tools: [{ name: "docs.search", writes: false }],
        count: 1,
      });
      expect(response.body).not.toContain("shell.exec");
      expect(response.body).not.toContain("inputSchema");
      expect(response.body).not.toContain("STDIO");
      expect(lines(h.methodLog)).toEqual(["list null"]);
    } finally {
      await h.app.close();
    }
  });

  it("D2: the tool on page 3 of 3: three listings, zero calls", async () => {
    const h = harness({ advertises: ["a.1", "a.2", "docs.search"], pageSize: 1, schemas: { "docs.search": PIN } });
    try {
      expect(answered(h, await discover(h))).toMatchObject({ outcome: "COMPLETED", tools: [{ name: "docs.search" }], count: 1 });
      expect(lines(h.methodLog)).toEqual(["list null", "list c1", "list c2"]);
    } finally {
      await h.app.close();
    }
  });

  it("D3: one nested input key differs: 200, SCHEMA_MISMATCH at the input schema, naming the tool", async () => {
    const h = harness({ schemas: { "docs.search": { type: "object", properties: { q: { type: "number" } } } } });
    try {
      expect(answered(h, await discover(h))).toMatchObject({
        outcome: "REFUSED",
        refusal: "SCHEMA_MISMATCH",
        at: "server.tools.inputSchema",
        toolName: "docs.search",
        tools: [],
        count: 0,
      });
    } finally {
      await h.app.close();
    }
  });

  it("D3o: an output schema advertised against a pin of none: SCHEMA_MISMATCH at the output schema, naming the tool", async () => {
    const h = harness({ schemas: { "docs.search": PIN }, outputSchemas: { "docs.search": { type: "object" } } });
    try {
      expect(answered(h, await discover(h))).toMatchObject({
        outcome: "REFUSED",
        refusal: "SCHEMA_MISMATCH",
        at: "server.tools.outputSchema",
        toolName: "docs.search",
      });
    } finally {
      await h.app.close();
    }
  });

  it("D4: allowlisted but not advertised: omitted, never refused", async () => {
    const h = harness({ advertises: ["shell.exec"] });
    try {
      expect(answered(h, await discover(h))).toMatchObject({ outcome: "COMPLETED", tools: [], count: 0, toolName: null });
    } finally {
      await h.app.close();
    }
  });

  it("D5: a cursor cycle: PROTOCOL_VIOLATION at the cursor, and the child reaped", async () => {
    const h = harness({ advertises: ["a.1", "a.2", "a.3", "docs.search"], pageSize: 1, cursorCycle: true });
    try {
      expect(answered(h, await discover(h))).toMatchObject({ outcome: "REFUSED", refusal: "PROTOCOL_VIOLATION", at: "server.tools.nextCursor" });
    } finally {
      await h.app.close();
    }
  });

  it("D6: pages past TOOL_LIST_PAGES_MAX: RESULT_UNBOUNDED at server.tools", async () => {
    const h = harness({ advertises: unbounded, pageSize: 1 });
    try {
      expect(answered(h, await discover(h))).toMatchObject({ outcome: "REFUSED", refusal: "RESULT_UNBOUNDED", at: "server.tools" });
      expect(lines(h.methodLog)).toHaveLength(TOOL_LIST_PAGES_MAX);
    } finally {
      await h.app.close();
    }
  });

  it("D7: a server the document does not admit: 200 SERVER_NOT_ADMITTED, and no child", async () => {
    const h = harness();
    try {
      const response = await discover(h, "elsewhere");
      expect(response.statusCode).toBe(200);
      expect(ToolDiscoveryResponse.parse(response.json())).toMatchObject({
        serverId: "elsewhere",
        outcome: "REFUSED",
        refusal: "SERVER_NOT_ADMITTED",
        at: "request.serverId",
        toolName: null,
      });
      expect(pids(h)).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it("D12: two tools answered, sorted by name whatever order the allowlist and the server use", async () => {
    const h = harness(
      { advertises: ["zeta.tool", "alpha.tool"] },
      {
        allowlist: [
          { name: "zeta.tool", writes: true, inputSchema: { type: "object" } },
          { name: "alpha.tool", writes: false, inputSchema: { type: "object" } },
        ],
      },
    );
    try {
      expect(answered(h, await discover(h))).toMatchObject({
        tools: [
          { name: "alpha.tool", writes: false },
          { name: "zeta.tool", writes: true },
        ],
        count: 2,
      });
    } finally {
      await h.app.close();
    }
  });
});

describe("the discovery read is private, and nothing is learnable before the bearer (A-7, A-8)", () => {
  it("answers 403 PRIVATE_READ_UNCONFIGURED with no bearer configured, and starts no child", async () => {
    const h = harness({}, { withBearer: false });
    try {
      refused(await discover(h), 403, "PRIVATE_READ_UNCONFIGURED");
      expect(pids(h)).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it("answers 401 AUTH_REQUIRED on a missing or wrong bearer, before the path parameter is read", async () => {
    const h = harness();
    try {
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }]) {
        refused(await discover(h, "docs", headers), 401, "AUTH_REQUIRED");
        // An out-of-grammar id is still 401, not 400: the bearer is checked first.
        const bad = await h.app.inject({ method: "GET", url: "/api/v1/tool-servers/.bad/tools", headers });
        refused(bad, 401, "AUTH_REQUIRED");
      }
      expect(pids(h)).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it("answers 405 on every other method, never cached, and starts no child", async () => {
    const h = harness();
    try {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await h.app.inject({ method, url: toolServerToolsPath("docs"), headers: AUTH });
        refused(response, 405, "METHOD_NOT_ALLOWED");
      }
      expect(pids(h)).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it("answers 503 TOOL_SERVERS_UNCONFIGURED without a document, naming no path, and starts no child", async () => {
    const h = harness({}, { withDocument: false });
    try {
      const body = refused(await discover(h), 503, "TOOL_SERVERS_UNCONFIGURED");
      expect(JSON.stringify(body)).not.toContain(h.dir);
      expect(JSON.stringify(body)).not.toContain("tool-servers.json");
      expect(pids(h)).toEqual([]);
      // And without the bearer, the absence is not learnable: 401 first.
      refused(await discover(h, "docs", {}), 401, "AUTH_REQUIRED");
    } finally {
      await h.app.close();
    }
  });

  it("answers 400 BAD_REQUEST at serverId for an id out of grammar, and 400 for any query, with no child", async () => {
    const h = harness();
    try {
      for (const raw of [".bad", "a%2Fb", "a%20b", "-x"]) {
        const response = await h.app.inject({ method: "GET", url: "/api/v1/tool-servers/" + raw + "/tools", headers: AUTH });
        const body = refused(response, 400, "BAD_REQUEST");
        expect({ raw, detail: body.error.detail }).toEqual({ raw, detail: "serverId" });
      }
      const query = await h.app.inject({ method: "GET", url: toolServerToolsPath("docs") + "?x=1", headers: AUTH });
      refused(query, 400, "BAD_REQUEST");
      expect(pids(h)).toEqual([]);
      // 100 characters, the router's parameter bound, is admitted, and is simply not a
      // server this document names.
      const longest = await discover(h, "a".repeat(100));
      expect(ToolDiscoveryResponse.parse(longest.json())).toMatchObject({ refusal: "SERVER_NOT_ADMITTED" });
    } finally {
      await h.app.close();
    }
  });

  /**
   * A stated limit, measured rather than assumed: the router refuses a path
   * parameter past 100 characters before any route handler runs, so a server id of
   * 101 to 120 characters — inside the bounded-identifier grammar, and askable at
   * the CLI door — is a framework 400 here, not the port's answer. Such an id is
   * asked through the CLI door only (ADR 0118). Raising the gateway's
   * `maxParamLength` to the grammar's 120 was not chosen: it would change parameter
   * handling on every route, which is outside this cut's authority.
   */
  it("answers a server id past the router's 100-character parameter bound with the framework's 400, and no child", async () => {
    const h = harness();
    try {
      for (const length of [101, 120, 121]) {
        const raw = await h.app.inject({ method: "GET", url: "/api/v1/tool-servers/" + "a".repeat(length) + "/tools", headers: AUTH });
        const body = refused(raw, 400, "BAD_REQUEST");
        expect({ length, detail: body.error.detail }).toEqual({ length, detail: "FST_ERR_MAX_PARAM_LENGTH" });
      }
      expect(pids(h)).toEqual([]);
    } finally {
      await h.app.close();
    }
  });
});

describe("the discovery read records nothing (A-4)", () => {
  function fileDigest(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  function ledgerFiles(dir: string): readonly (readonly [string, string, number])[] {
    return readdirSync(dir)
      .sort()
      .map((name) => [name, fileDigest(join(dir, name)), statSync(join(dir, name)).mtimeMs] as const);
  }

  it("leaves the ledger's head, events and files unchanged across D1-D7", async () => {
    const rows: readonly (readonly [FakeScript, string])[] = [
      [{ advertises: ["docs.search"], schemas: { "docs.search": PIN } }, "docs"],
      [{ advertises: ["a.1", "docs.search"], pageSize: 1, schemas: { "docs.search": PIN } }, "docs"],
      [{ schemas: { "docs.search": { type: "object", required: ["x"] } } }, "docs"],
      [{ advertises: ["shell.exec"] }, "docs"],
      [{ advertises: ["a.1", "a.2", "a.3"], pageSize: 1, cursorCycle: true }, "docs"],
      [{ advertises: unbounded, pageSize: 1 }, "docs"],
      [{}, "elsewhere"],
    ];
    for (const [script, serverId] of rows) {
      const h = harness(script);
      try {
        const statusBefore = LedgerStatusResponse.parse((await h.app.inject({ method: "GET", url: "/api/v1/status" })).json());
        const eventsBefore = EventPageResponse.parse((await h.app.inject({ method: "GET", url: "/api/v1/events" })).json());
        const filesBefore = ledgerFiles(join(h.dir, "ledger"));

        expect((await discover(h, serverId)).statusCode).toBe(200);

        const statusAfter = LedgerStatusResponse.parse((await h.app.inject({ method: "GET", url: "/api/v1/status" })).json());
        const eventsAfter = EventPageResponse.parse((await h.app.inject({ method: "GET", url: "/api/v1/events" })).json());
        expect({ ...statusAfter, observedAt: null }).toEqual({ ...statusBefore, observedAt: null });
        expect(eventsAfter.items).toEqual(eventsBefore.items);
        expect(eventsAfter.items).toHaveLength(1);
        expect(ledgerFiles(join(h.dir, "ledger"))).toEqual(filesBefore);
      } finally {
        await h.app.close();
      }
    }
  });
});

describe("the protocol's bound is the edge's (P-24/B(a))", () => {
  it("MAX_DISCOVERED_TOOLS equals TOOL_LIST_TOOLS_MAX: the answer is a subset of one advertisement", () => {
    expect(MAX_DISCOVERED_TOOLS).toBe(TOOL_LIST_TOOLS_MAX);
  });
});
