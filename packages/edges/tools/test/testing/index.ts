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
    "    reply(id, { tools: ADVERTISES.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) });",
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
export function initializeResult(name = "fake-mcp"): unknown {
  return {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name, version: "0.0.0" },
  };
}
