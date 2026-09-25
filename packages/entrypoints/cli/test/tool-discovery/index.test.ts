/**
 * Evidence for the CLI's discovery door (P-24/B(a), ADR 0118): `acp tool-servers`.
 *
 * Every row enters through `run([...])`, the process entry the other verbs'
 * suites use, so the argument table, the branch above the `--database` law, the
 * exit-code mapping and the printed document are all on the path under test.
 *
 * The fake MCP server is **this suite's own copy**, written to a temp dir, for
 * the reason the tool-call suites give: a fake shared across packages is
 * eventually mistaken for evidence about a real server. It logs its pid and every
 * method it is asked (`list <cursor>` / `call <name>`), so each row can assert
 * that no `tools/call` was ever sent and that the child was reaped before the
 * verb returned.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openLedger } from "@acp/ledger";
import { API_CONTRACT_VERSION, LEDGER_CONTRACT_VERSION, ToolDiscoveryResponse } from "@acp/protocol";
import { TOOL_LIST_PAGES_MAX } from "@acp/tools";

import { EXIT_OK, EXIT_USAGE, run } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/index.js";

const roots: string[] = [];

function root(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-tool-discovery-")));
  roots.push(created);
  return created;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Invocation {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(argv: readonly string[]): Promise<Invocation> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    now: () => "2026-09-25T12:00:00.000Z",
  };
  const exitCode = await run(argv, io);
  return { exitCode, stdout, stderr };
}

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

interface Fixture {
  readonly dir: string;
  readonly pidLog: string;
  readonly methodLog: string;
  readonly documentPath: string;
}

function fixture(script: FakeScript, allowlist: readonly Record<string, unknown>[] = DEFAULT_ALLOWLIST, mode = 0o600): Fixture {
  const dir = root();
  const pidLog = join(dir, "pids.log");
  const methodLog = join(dir, "methods.log");
  writeFileSync(pidLog, "", "utf8");
  const fake = writeFake(dir, pidLog, methodLog, script);
  const documentPath = join(dir, "tool-servers.json");
  writeFileSync(
    documentPath,
    JSON.stringify([{ serverId: "docs", transport: "STDIO", command: fake.command, args: fake.args, tools: allowlist }]),
    "utf8",
  );
  chmodSync(documentPath, mode);
  return { dir, pidLog, methodLog, documentPath };
}

function lines(path: string): readonly string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

function pids(fixtureValue: Fixture): readonly number[] {
  return lines(fixtureValue.pidLog).map((line) => Number(line));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function discover(fixtureValue: Fixture, serverId = "docs", extra: readonly string[] = []): Promise<Invocation> {
  return await invoke(["tool-servers", "--tool-servers", fixtureValue.documentPath, "--server", serverId, ...extra]);
}

function document(invocation: Invocation): ToolDiscoveryResponse {
  return ToolDiscoveryResponse.parse(JSON.parse(invocation.stdout));
}

function errorOf(invocation: Invocation): { readonly code: string; readonly detail: string | null } {
  return (JSON.parse(invocation.stderr) as { error: { code: string; detail: string | null } }).error;
}

/** Each answered row: the port reached a listing, no call was sent, and the child is gone. */
function expectAnsweredAndReaped(fixtureValue: Fixture): void {
  expect(lines(fixtureValue.methodLog).filter((line) => line.startsWith("call "))).toEqual([]);
  const started = pids(fixtureValue);
  expect(started).toHaveLength(1);
  for (const pid of started) expect(alive(pid)).toBe(false);
}

const unbounded = Array.from({ length: TOOL_LIST_PAGES_MAX + 1 }, (_, index) => "a." + String(index));

describe("acp tool-servers answers the port's listing, sends no call, and reaps the child (D1-D7)", () => {
  it("D1: pins equal, one allowlisted tool advertised beside one nobody allowed", async () => {
    const f = fixture({ advertises: ["docs.search", "shell.exec"], schemas: { "docs.search": PIN } });
    const result = await discover(f);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(document(result)).toEqual({
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
    expect(result.stdout).not.toContain("shell.exec");
    expect(lines(f.methodLog)).toEqual(["list null"]);
    expectAnsweredAndReaped(f);
  });

  it("D2: the tool on page 3 of 3: three listings, zero calls", async () => {
    const f = fixture({ advertises: ["a.1", "a.2", "docs.search"], pageSize: 1, schemas: { "docs.search": PIN } });
    const result = await discover(f);
    expect(document(result)).toMatchObject({ outcome: "COMPLETED", tools: [{ name: "docs.search", writes: false }], count: 1 });
    expect(lines(f.methodLog)).toEqual(["list null", "list c1", "list c2"]);
    expectAnsweredAndReaped(f);
  });

  it("D3: one nested input key differs: SCHEMA_MISMATCH at the input schema, naming the tool", async () => {
    const f = fixture({ schemas: { "docs.search": { type: "object", properties: { q: { type: "number" } } } } });
    const result = await discover(f);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(document(result)).toMatchObject({
      outcome: "REFUSED",
      refusal: "SCHEMA_MISMATCH",
      at: "server.tools.inputSchema",
      toolName: "docs.search",
      tools: [],
      count: 0,
    });
    expectAnsweredAndReaped(f);
  });

  it("D3o: an output schema advertised against a pin of none: SCHEMA_MISMATCH at the output schema, naming the tool", async () => {
    const f = fixture({ schemas: { "docs.search": PIN }, outputSchemas: { "docs.search": { type: "object" } } });
    const result = await discover(f);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(document(result)).toMatchObject({
      outcome: "REFUSED",
      refusal: "SCHEMA_MISMATCH",
      at: "server.tools.outputSchema",
      toolName: "docs.search",
    });
    expectAnsweredAndReaped(f);
  });

  it("D4: allowlisted but not advertised: omitted, never refused", async () => {
    const f = fixture({ advertises: ["shell.exec"] });
    const result = await discover(f);
    expect(document(result)).toMatchObject({ outcome: "COMPLETED", tools: [], count: 0, refusal: null, toolName: null });
    expectAnsweredAndReaped(f);
  });

  it("D5: a cursor cycle: PROTOCOL_VIOLATION at the cursor, and the child reaped", async () => {
    const f = fixture({ advertises: ["a.1", "a.2", "a.3", "docs.search"], pageSize: 1, cursorCycle: true });
    const result = await discover(f);
    expect(document(result)).toMatchObject({ outcome: "REFUSED", refusal: "PROTOCOL_VIOLATION", at: "server.tools.nextCursor", toolName: null });
    expectAnsweredAndReaped(f);
  });

  it("D6: pages past TOOL_LIST_PAGES_MAX: RESULT_UNBOUNDED at server.tools", async () => {
    const f = fixture({ advertises: unbounded, pageSize: 1 });
    const result = await discover(f);
    expect(document(result)).toMatchObject({ outcome: "REFUSED", refusal: "RESULT_UNBOUNDED", at: "server.tools", toolName: null });
    expect(lines(f.methodLog)).toHaveLength(TOOL_LIST_PAGES_MAX);
    expectAnsweredAndReaped(f);
  });

  it("D7: a server the document does not admit: SERVER_NOT_ADMITTED, and no child", async () => {
    const f = fixture({});
    const result = await discover(f, "elsewhere");
    expect(result.exitCode).toBe(EXIT_OK);
    expect(document(result)).toMatchObject({ serverId: "elsewhere", outcome: "REFUSED", refusal: "SERVER_NOT_ADMITTED", at: "request.serverId" });
    expect(pids(f)).toEqual([]);
    expect(lines(f.methodLog)).toEqual([]);
  });

  it("D12: two tools answered, sorted by name whatever order the allowlist and the server use", async () => {
    const allowlist = [
      { name: "zeta.tool", writes: true, inputSchema: { type: "object" } },
      { name: "alpha.tool", writes: false, inputSchema: { type: "object" } },
    ];
    const f = fixture({ advertises: ["zeta.tool", "alpha.tool"] }, allowlist);
    const result = await discover(f);
    expect(document(result)).toMatchObject({
      outcome: "COMPLETED",
      tools: [
        { name: "alpha.tool", writes: false },
        { name: "zeta.tool", writes: true },
      ],
      count: 2,
    });
    expectAnsweredAndReaped(f);
  });
});

describe("acp tool-servers refuses a request that never reaches a listing, with no child (D8-D11)", () => {
  it("D8: a document with an unpinned tool is not admitted: BAD_REQUEST at tool-servers", async () => {
    const f = fixture({}, [{ name: "docs.search", writes: false }]);
    const result = await discover(f, "docs", ["--format", "json"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail: "tool-servers" });
    expect(result.stdout).toBe("");
    expect(pids(f)).toEqual([]);
  });

  it("D9: a server id out of grammar is a usage failure at server; 120 characters is admitted", async () => {
    const f = fixture({});
    for (const bad of ["a/b", "a".repeat(121), "", ".hidden"]) {
      const result = await discover(f, bad, ["--format", "json"]);
      expect({ bad, exit: result.exitCode }).toEqual({ bad, exit: EXIT_USAGE });
      expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail: "server" });
      expect(result.stderr).not.toContain(bad === "" ? "\u0000" : bad);
    }
    expect(pids(f)).toEqual([]);
    const longest = await discover(f, "a".repeat(120));
    expect(longest.exitCode).toBe(EXIT_OK);
    expect(document(longest)).toMatchObject({ refusal: "SERVER_NOT_ADMITTED" });
    expect(pids(f)).toEqual([]);
  });

  it("D9b: --server is required", async () => {
    const f = fixture({});
    const result = await invoke(["tool-servers", "--tool-servers", f.documentPath, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail: "server" });
    expect(pids(f)).toEqual([]);
  });

  it("D10: --database is refused, not ignored, and no file appears at that path", async () => {
    const f = fixture({});
    const ledgerPath = join(f.dir, "never.sqlite3");
    const result = await discover(f, "docs", ["--database", ledgerPath, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail: "--database" });
    expect(existsSync(ledgerPath)).toBe(false);
    expect(pids(f)).toEqual([]);
  });

  it("D11: the document ladder refuses a readable-by-others, relative or non-canonical path, with no child", async () => {
    const open = fixture({}, DEFAULT_ALLOWLIST, 0o644);
    const loose = await discover(open, "docs", ["--format", "json"]);
    expect(loose.exitCode).toBe(EXIT_USAGE);
    expect(errorOf(loose)).toMatchObject({ code: "BAD_REQUEST", detail: "tool-servers" });
    expect(pids(open)).toEqual([]);

    const f = fixture({});
    for (const path of ["tool-servers.json", f.dir + "/./tool-servers.json", ""]) {
      const result = await invoke(["tool-servers", "--tool-servers", path, "--server", "docs", "--format", "json"]);
      expect({ path, exit: result.exitCode }).toEqual({ path, exit: EXIT_USAGE });
      expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail: "tool-servers" });
      expect(result.stderr).not.toContain(f.dir);
    }
    expect(pids(f)).toEqual([]);
  });

  it("refuses an option the verb does not take", async () => {
    const f = fixture({});
    const result = await discover(f, "docs", ["--request", "/x", "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("--request");
    expect(pids(f)).toEqual([]);
  });
});

describe("acp tool-servers records nothing and opens no ledger (A-4)", () => {
  function digest(path: string): { readonly sha: string; readonly mtimeMs: number; readonly size: number } {
    const bytes = readFileSync(path);
    const stats = statSync(path);
    return { sha: createHash("sha256").update(bytes).digest("hex"), mtimeMs: stats.mtimeMs, size: stats.size };
  }

  it("leaves a ledger beside it byte- and mtime-identical across D1-D7, and creates no database file", async () => {
    const f = fixture({ advertises: ["docs.search", "shell.exec"], schemas: { "docs.search": PIN } });
    const ledgerPath = join(f.dir, "beside.sqlite3");
    openLedger(ledgerPath).close();
    const before = readdirSync(f.dir).filter((name) => name.startsWith("beside.sqlite3")).map((name) => [name, digest(join(f.dir, name))]);
    const listing = readdirSync(f.dir).sort();

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
      const row = fixture(script);
      const result = await discover(row, serverId);
      expect(result.exitCode).toBe(EXIT_OK);
      // Nothing beside the fixture's own files: no database, no journal.
      expect(readdirSync(row.dir).filter((name) => /\.(db|sqlite3?|sqlite3?-(wal|shm|journal))$/.test(name))).toEqual([]);
    }
    await discover(f);

    const after = readdirSync(f.dir).filter((name) => name.startsWith("beside.sqlite3")).map((name) => [name, digest(join(f.dir, name))]);
    expect(after).toEqual(before);
    // Only the fake's method log may be new in the directory the ledger sits in.
    expect(readdirSync(f.dir).sort().filter((name) => !listing.includes(name))).toEqual(["methods.log"]);
  });
});
