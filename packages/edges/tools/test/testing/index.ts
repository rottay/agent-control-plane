import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolTransportConnection } from "../../src/client/index.js";

/**
 * The fake MCP server the tool suites share, and the scripted connection the
 * protocol negatives are driven through.
 *
 * Every negative in this package runs against one of these rather than against
 * a real third-party server: no network, no vendor, no account. What they
 * prove is *this* machinery — the framing, the ceilings, the allowlist, the
 * receipt. They deliberately prove nothing about any real MCP implementation,
 * and the package README says so in those words rather than leaving a reader
 * to infer it from the absence of a claim.
 *
 * This module is **not** part of the package's closed public surface; the
 * suites import it by relative path, exactly as the provider edge's fake is
 * imported. A fake on a public surface is eventually mistaken for evidence.
 */

/** How the fake answers one `tools/call`. */
export type FakeToolAnswer =
  | { readonly kind: "TEXT"; readonly blocks: readonly string[] }
  /** Accept the call and never answer it. Drives the timeout. */
  | { readonly kind: "SILENT" }
  /** One text block padded to `bytes`, for the result and content ceilings. */
  | { readonly kind: "PADDED"; readonly bytes: number; readonly blocks?: number }
  /** A content block this client does not carry. */
  | { readonly kind: "IMAGE" }
  /** A JSON-RPC error object rather than a result. */
  | { readonly kind: "ERROR" }
  /**
   * A well-formed JSON-RPC **result** the server marks `isError: true` (P-11).
   * The transport fact, not the transport error: the frame succeeds and the
   * result itself reports the tool's failure. The twin of `ERROR`.
   */
  | { readonly kind: "ERROR_RESULT"; readonly blocks?: readonly string[] }
  /** A line that is not JSON at all. */
  | { readonly kind: "MALFORMED" }
  /** A well-formed response correlated to a request nobody sent. */
  | { readonly kind: "UNKNOWN_ID" }
  /** One frame larger than the frame ceiling, newline-terminated. */
  | { readonly kind: "OVERSIZED_FRAME"; readonly bytes: number }
  /**
   * The child's environment variable NAMES, sorted, as one text block.
   *
   * Names and never values: proving that nothing ambient was inherited must
   * not itself carry whatever the ambient environment was holding.
   */
  | { readonly kind: "ENV" };

export interface FakeToolServerScript {
  readonly serverName?: string;
  /** What `tools/list` advertises. Defaults to the answers' own names. */
  readonly advertises?: readonly string[];
  readonly answers?: Readonly<Record<string, FakeToolAnswer>>;
  /** Append every `tools/call` name here, one per line. */
  readonly callLog?: string;
  /** Append this child's pid here at startup, one per line. */
  readonly pidLog?: string;
  /**
   * P-24. The schema a tool is advertised under, by name; every other tool is
   * advertised as `{ type: "object" }`, the smallest conformant schema.
   */
  readonly schemas?: Readonly<Record<string, unknown>>;
  /** Tools per `tools/list` page; the listing is one page when absent. */
  readonly pageSize?: number;
  /** Every page after the first points back at the first cursor: a cycle. */
  readonly cursorCycle?: boolean;
  /** The first page ends with `nextCursor: ""`. */
  readonly emptyCursor?: boolean;
  /** The first page ends with `nextCursor: null`. */
  readonly nullCursor?: boolean;
  /** Emit `notifications/tools/list_changed` right after the first complete listing. */
  readonly listChangedBeforeCall?: boolean;
  /** Emit `notifications/tools/list_changed` right after the first page of the first listing. */
  readonly listChangedMidListing?: boolean;
  /** Append every `tools/list` here, one line per page, as `list <cursor>`. */
  readonly listLog?: string;
}

/**
 * A disposable directory that is already `realpath`-resolved.
 *
 * The admission refuses a command whose `realpath` differs from its own path,
 * and on this platform the temporary root is reached through a symlink. A
 * fixture that ignored that would fail admission for a reason that has nothing
 * to do with what it is testing.
 */
export function makeToolFixtureDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "acp-tools-")));
}

export function removeToolFixtureDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Every `tools/call` the fake has been asked for, in order. */
export function readToolCallLog(path: string): readonly string[] {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((line) => line.length > 0);
}

/**
 * Write the fake server, and return the argv the admission will be given.
 *
 * `command` is the running Node binary and the script is an argument, which is
 * how a real MCP stdio server is configured and what keeps the admitted
 * executable something this user already owns.
 */
export function writeFakeToolServer(
  dir: string,
  script: FakeToolServerScript,
): { readonly command: string; readonly args: readonly string[] } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "fake-mcp-server.mjs");
  const answers = script.answers ?? {};
  const advertises = script.advertises ?? Object.keys(answers);

  const program = [
    "const ANSWERS = " + JSON.stringify(answers) + ";",
    "const ADVERTISES = " + JSON.stringify([...advertises]) + ";",
    "const SERVER_NAME = " + JSON.stringify(script.serverName ?? "fake-mcp") + ";",
    "const CALL_LOG = " + JSON.stringify(script.callLog ?? null) + ";",
    "const PID_LOG = " + JSON.stringify(script.pidLog ?? null) + ";",
    "const SCHEMAS = " + JSON.stringify(script.schemas ?? {}) + ";",
    "const PAGE_SIZE = " + JSON.stringify(script.pageSize ?? null) + ";",
    "const CURSOR_CYCLE = " + JSON.stringify(script.cursorCycle === true) + ";",
    "const EMPTY_CURSOR = " + JSON.stringify(script.emptyCursor === true) + ";",
    "const NULL_CURSOR = " + JSON.stringify(script.nullCursor === true) + ";",
    "const CHANGED_BEFORE_CALL = " + JSON.stringify(script.listChangedBeforeCall === true) + ";",
    "const CHANGED_MID_LISTING = " + JSON.stringify(script.listChangedMidListing === true) + ";",
    "const LIST_LOG = " + JSON.stringify(script.listLog ?? null) + ";",
    "let changedBeforeSent = false;",
    "let changedMidSent = false;",
    "const fs = await import('node:fs');",
    "if (PID_LOG !== null) fs.appendFileSync(PID_LOG, String(process.pid) + '\\n');",
    "const send = (message) => { process.stdout.write(JSON.stringify(message) + '\\n'); };",
    "const reply = (id, result) => { send({ jsonrpc: '2.0', id, result }); };",
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  let newline = buffer.indexOf('\\n');",
    "  while (newline !== -1) {",
    "    const line = buffer.slice(0, newline);",
    "    buffer = buffer.slice(newline + 1);",
    "    newline = buffer.indexOf('\\n');",
    "    if (line.trim().length === 0) continue;",
    "    let message;",
    "    try { message = JSON.parse(line); } catch { continue; }",
    "    handle(message);",
    "  }",
    "});",
    "function handle(message) {",
    "  const { id, method, params } = message;",
    "  if (method === 'initialize') {",
    "    reply(id, {",
    "      protocolVersion: '2025-06-18',",
    "      capabilities: { tools: {} },",
    "      serverInfo: { name: SERVER_NAME, version: '0.0.0' },",
    "    });",
    "    return;",
    "  }",
    "  if (method === 'notifications/initialized') return;",
    "  if (method === 'tools/list') {",
    "    const cursor = params && typeof params.cursor === 'string' ? params.cursor : null;",
    "    if (LIST_LOG !== null) fs.appendFileSync(LIST_LOG, 'list ' + String(cursor) + '\\n');",
    "    const all = ADVERTISES.map((name) => ({ name, description: name,",
    "      inputSchema: Object.hasOwn(SCHEMAS, name) ? SCHEMAS[name] : { type: 'object' } }));",
    "    const size = PAGE_SIZE === null ? all.length : PAGE_SIZE;",
    "    const start = cursor === null ? 0 : Number(cursor.slice(1));",
    "    const page = all.slice(start, start + size);",
    "    const result = { tools: page };",
    "    if (start + size < all.length) result.nextCursor = CURSOR_CYCLE && start > 0 ? 'c' + String(size) : 'c' + String(start + size);",
    "    if (cursor === null && EMPTY_CURSOR) result.nextCursor = '';",
    "    if (cursor === null && NULL_CURSOR) result.nextCursor = null;",
    // The notification rides in the same write as the page it follows, so the
    // client reads the two together: the fixture drives the announced change
    // deterministically rather than racing the call.
    "    let changed = false;",
    "    if (CHANGED_MID_LISTING && !changedMidSent && cursor === null && result.nextCursor !== undefined) { changedMidSent = true; changed = true; }",
    "    if (CHANGED_BEFORE_CALL && !changedBeforeSent && result.nextCursor === undefined) { changedBeforeSent = true; changed = true; }",
    "    const notification = changed ? JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\\n' : '';",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n' + notification);",
    "    return;",
    "  }",
    "  if (method === 'tools/call') {",
    "    const name = params && params.name;",
    "    if (CALL_LOG !== null) fs.appendFileSync(CALL_LOG, String(name) + '\\n');",
    "    const answer = ANSWERS[name];",
    "    if (answer === undefined) { reply(id, { content: [{ type: 'text', text: 'no answer' }] }); return; }",
    "    switch (answer.kind) {",
    "      case 'SILENT': return;",
    "      case 'MALFORMED': process.stdout.write('{ this is not json\\n'); return;",
    "      case 'UNKNOWN_ID': send({ jsonrpc: '2.0', id: 99999, result: { content: [] } }); return;",
    "      case 'ERROR': send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'refused by the server' } }); return;",
    "      case 'ERROR_RESULT': {",
    "        const texts = answer.blocks === undefined ? ['the tool failed'] : answer.blocks;",
    "        reply(id, { content: texts.map((text) => ({ type: 'text', text })), isError: true });",
    "        return;",
    "      }",
    "      case 'IMAGE': reply(id, { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }); return;",
    "      case 'ENV': reply(id, { content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }] }); return;",
    "      case 'OVERSIZED_FRAME': process.stdout.write('x'.repeat(answer.bytes) + '\\n'); return;",
    "      case 'PADDED': {",
    "        const blocks = answer.blocks === undefined ? 1 : answer.blocks;",
    "        const text = 'p'.repeat(answer.bytes);",
    "        reply(id, { content: Array.from({ length: blocks }, () => ({ type: 'text', text })) });",
    "        return;",
    "      }",
    "      default:",
    "        reply(id, { content: answer.blocks.map((text) => ({ type: 'text', text })) });",
    "        return;",
    "    }",
    "  }",
    "}",
  ].join("\n");

  writeFileSync(path, program, "utf8");
  chmodSync(path, 0o700);
  return { command: realpathSync(process.execPath), args: Object.freeze([path]) };
}

/** An in-memory peer, for the framing cases a real child cannot stage. */
export interface ScriptedToolConnection extends ToolTransportConnection {
  /** Every frame the client wrote, in order. */
  readonly written: () => readonly string[];
  /** Push one chunk at the client, exactly as a transport would. */
  readonly emit: (chunk: string) => void;
  /** The peer hung up. */
  readonly hangUp: () => void;
  readonly closes: () => number;
}

export function createScriptedToolConnection(): ScriptedToolConnection {
  const written: string[] = [];
  const sinks: ((chunk: string) => void)[] = [];
  const enders: (() => void)[] = [];
  let closes = 0;

  return {
    write(frame: string): void {
      written.push(frame);
    },
    subscribe(sink: (chunk: string) => void): void {
      sinks.push(sink);
    },
    onEnd(listener: () => void): void {
      enders.push(listener);
    },
    async close(): Promise<void> {
      closes += 1;
      await Promise.resolve();
    },
    written(): readonly string[] {
      return [...written];
    },
    emit(chunk: string): void {
      for (const sink of sinks) sink(chunk);
    },
    hangUp(): void {
      for (const listener of enders) listener();
    },
    closes(): number {
      return closes;
    },
  };
}

/** The id the client minted for the nth request it wrote (1-based). */
export function requestIdOf(frame: string): number {
  const parsed = JSON.parse(frame) as { id?: unknown };
  return typeof parsed.id === "number" ? parsed.id : -1;
}

/** The method of a frame the client wrote. */
export function requestMethodOf(frame: string): string {
  const parsed = JSON.parse(frame) as { method?: unknown };
  return typeof parsed.method === "string" ? parsed.method : "";
}

/** A JSON-RPC result frame, as a server would send it. */
export function resultFrame(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
}

/** The `initialize` result every handshake needs. */
/** Passed as the version to script a server that returns none at all. */
export const INITIALIZE_NO_VERSION = Symbol("no protocolVersion");

export function initializeResult(name = "fake-mcp", protocolVersion: unknown = "2025-06-18"): unknown {
  // The version is overridable so the negative V2-B4b S4-1 adds can drive a
  // server that agrees a different revision, or none at all. Absence is a
  // sentinel rather than `undefined`, which would silently take the default.
  return {
    ...(protocolVersion === INITIALIZE_NO_VERSION ? {} : { protocolVersion }),
    capabilities: { tools: {} },
    serverInfo: { name, version: "0.0.0" },
  };
}

// ---------------------------------------------------------------------------
// The scripted loopback peer (V2-B4b S4-1)
// ---------------------------------------------------------------------------

/**
 * One scripted answer to one request.
 *
 * `headers` are lower-cased on the way in, as `Headers` does, so a script and
 * an assertion cannot disagree about case.
 */
export interface ScriptedHttpAnswer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * A whole body, or a stream that delivers one in pieces.
   *
   * The stream form exists so a suite can assert *how much of a body arrived*
   * rather than only what the transport decided about it: a ceiling applied
   * after the whole body is read refuses exactly like one applied at the
   * boundary, and only the pull count tells them apart.
   */
  readonly body?: string | ReadableStream<Uint8Array>;
}

export interface ScriptedFetch {
  /** Every request this peer was handed, in order, for assertion. */
  readonly calls: () => readonly { readonly url: string; readonly init: RequestInit }[];
  readonly restore: () => void;
}

/**
 * Substitute `globalThis.fetch` with a scripted peer.
 *
 * **No socket, no bound port**, and that is a ruling rather than a convenience.
 * Three measured reasons: `node:http`/`node:net` are banned across this
 * package's `src` *and* `test`, and would have to be weakened to do it any
 * other way; this repository has twice recorded that undici `fetch` is
 * intermittent against loopback inside a Vitest worker, so a green run would
 * prove less than it looked like; and the swap is the house precedent the
 * durability drills already use.
 *
 * The limitation is recorded rather than hidden: `MCP_PROTOCOL_RECORD` reads
 * `SOCKET_EXERCISED: "NONE"` and `LIVE_CONFORMANCE: "NONE"`, and the README
 * says so beside them.
 *
 * Not exported from the package barrel — the suites reach it by relative path,
 * because a fake on a public surface is eventually mistaken for evidence.
 */
export function scriptFetch(
  answers: readonly ScriptedHttpAnswer[] | ((request: string) => ScriptedHttpAnswer),
): ScriptedFetch {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  let index = 0;

  globalThis.fetch = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init: init ?? {} });
    const body = typeof init?.body === "string" ? init.body : "";
    const answer =
      typeof answers === "function"
        ? answers(body)
        : (answers[index++] ?? { status: 500 });
    const headers = new Headers();
    for (const [name, value] of Object.entries(answer.headers ?? {})) headers.set(name, value);
    return Promise.resolve(new Response(answer.body ?? null, { status: answer.status, headers }));
  }) as typeof globalThis.fetch;

  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** One JSON-RPC response frame, as a server would answer it. */
export function jsonRpcBody(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/** The `initialize` result a conformant peer returns. */
export function initializeBody(id: number, version = "2025-06-18"): string {
  return jsonRpcBody(id, {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: "scripted-peer", version: "0.0.0" },
  });
}
