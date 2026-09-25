import { randomUUID } from "node:crypto";
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

import { openToolClaimStore, openLedger, toolClaimStorePath } from "@acp/ledger";
import { deriveEventCoordinate, deriveInvocation, toolCallTransitionId } from "@acp/runtime";
import {
  ApiError,
  LEDGER_CONTRACT_VERSION,
  ToolCallExecuteResponse,
  ToolCallPageResponse,
} from "@acp/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { TOOL_LIST_PAGES_MAX } from "@acp/tools";

import { buildServer } from "../../src/build-server/index.js";
import { loadToolServers } from "../../src/tool-calls/index.js";

/**
 * Evidence for the tool-call door (V2-B4b stage 3C).
 *
 * The plane's third write route, and the first whose handler starts a child and
 * speaks a protocol to it — so the drills are about authority and aftermath as
 * much as about shape: who may reach it, what is left running when it returns,
 * and what of the call becomes durable.
 *
 * The fake MCP server is **this suite's own copy**, written to a temp dir. A
 * deep import into `@acp/tools`' test tree would leave this project's `rootDir`
 * and need a reference into another package's suites; and a fake shared across
 * packages is eventually mistaken for evidence about a real server. It is
 * evidence about this machinery and nothing else.
 */

const roots: string[] = [];
const TOKEN = "v2-b4b-tool-calls-" + "t".repeat(26);
const AUTH = { authorization: "Bearer " + TOKEN };
const IDENTITY = "claude/opus/implementer/01";
const REVIEWER = "claude/opus/reviewer/01";
const ACCOUNT = "acct-primary";
const SUBMITTED_AT = "2026-09-03T12:00:00.000Z";
const DIGEST = "a".repeat(64);
const SENTINEL = "SENTINEL-ARGUMENT-MUST-NOT-BE-DURABLE";

function root(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-toolcalls-")));
  roots.push(created);
  return created;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tokenFile(dir: string): string {
  const path = join(dir, "write.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

/**
 * A minimal stdio MCP server, written as a script this suite owns.
 *
 * It logs its own pid so the drills can assert the child was reaped, and
 * answers `initialize`, `tools/list` and `tools/call` and nothing else.
 */
function writeFakeServer(
  dir: string,
  pidLog: string,
  delayMs = 0,
  errorResult = false,
): { command: string; args: string[] } {
  const path = join(dir, "fake-mcp.mjs");
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs';",
      "const DELAY_MS = " + String(delayMs) + ";",
      "const ERROR_RESULT = " + JSON.stringify(errorResult) + ";",
      "appendFileSync(" + JSON.stringify(pidLog) + ", String(process.pid) + '\\n');",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk.toString('utf8');",
      "  let index = buffer.indexOf('\\n');",
      "  while (index >= 0) {",
      "    const line = buffer.slice(0, index);",
      "    buffer = buffer.slice(index + 1);",
      "    if (line.trim() !== '') handle(JSON.parse(line));",
      "    index = buffer.indexOf('\\n');",
      "  }",
      "});",
      "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
      "function handle(message) {",
      "  if (message.method === 'initialize') {",
      "    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18',",
      "      capabilities: {}, serverInfo: { name: 'fake-mcp', version: '1' } } });",
      "    return;",
      "  }",
      "  if (message.method === 'tools/list') {",
      "    send({ jsonrpc: '2.0', id: message.id, result: { tools: [",
      "      { name: 'docs.search', inputSchema: { type: 'object' } },",
      "      { name: 'docs.write', inputSchema: { type: 'object' } }] } });",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call') {",
      "    const answer = () => send({ jsonrpc: '2.0', id: message.id, result: {",
      "      content: [{ type: 'text', text: ERROR_RESULT ? 'the tool failed' : 'the answer' }],",
      "      isError: ERROR_RESULT } });",
      "    if (DELAY_MS > 0) { setTimeout(answer, DELAY_MS); return; }",
      "    answer();",
      "    return;",
      "  }",
      "  if (message.id !== undefined) {",
      "    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } });",
      "  }",
      "}",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o700);
  return { command: process.execPath, args: [path] };
}

function toolDocument(dir: string, pidLog: string, delayMs = 0, errorResult = false): string {
  const fake = writeFakeServer(dir, pidLog, delayMs, errorResult);
  const path = join(dir, "tool-servers.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        serverId: "docs",
        transport: "STDIO",
        command: fake.command,
        args: fake.args,
        tools: [
          { name: "docs.search", writes: false, inputSchema: { type: "object" } },
          { name: "docs.write", writes: true, inputSchema: { type: "object" } },
        ],
      },
    ]),
    "utf8",
  );
  chmodSync(path, 0o600);
  return path;
}

function makeEvent(taskId: string): Record<string, unknown> {
  const transitionId = "discover";
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId,
    attempt: 1,
    transitionId,
    // Mirrors `buildIdempotencyKey`, restated rather than imported: this
    // package's dependency surface does not include `@acp/contracts`.
    idempotencyKey: taskId + "/1/" + transitionId,
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "kimi/k3/coordinator/01",
    occurredAt: SUBMITTED_AT,
    recordedAt: SUBMITTED_AT,
    correlationId: null,
    causationId: null,
    payload: {},
  };
}

interface Harness {
  readonly app: ReturnType<typeof buildServer>;
  readonly taskId: string;
  readonly dir: string;
  readonly pidLog: string;
  readonly discoveredEventId: string;
  readonly otherTaskEventId: string;
  /** V2 X1b: so a drill can take the claim the way another process would. */
  readonly ledgerPath: string;
}

function harness(
  options: {
    readonly withDocument?: boolean;
    readonly delayMs?: number;
    readonly errorResult?: boolean;
  } = {},
): Harness {
  const dir = root();
  mkdirSync(join(dir, "ledger"), { recursive: true });
  const ledgerPath = join(dir, "ledger", "acp.sqlite3");
  const pidLog = join(dir, "pids.log");
  writeFileSync(pidLog, "", "utf8");

  const taskId = randomUUID();
  const otherTaskId = randomUUID();
  const ledger = openLedger(ledgerPath);
  const discovered = makeEvent(taskId);
  const other = makeEvent(otherTaskId);
  ledger.append(discovered);
  ledger.append(other);
  ledger.close();

  return {
    app: buildServer({
      ledgerPath,
      writeBearerPath: tokenFile(dir),
      ...(options.withDocument === false
        ? {}
        : {
            toolServersPath: toolDocument(
              dir,
              pidLog,
              options.delayMs ?? 0,
              options.errorResult ?? false,
            ),
          }),
    }),
    taskId,
    dir,
    pidLog,
    discoveredEventId: String(discovered["eventId"]),
    otherTaskEventId: String(other["eventId"]),
    ledgerPath,
  };
}

/**
 * The durable coordinate a request for `taskId` lands on.
 *
 * Derived exactly as the operation derives it, from the same three inputs, so a
 * drill cannot go vacuous by pinning a key the plane stopped using.
 */
function coordinateKeyFor(taskId: string, callIndex = 0): string {
  return deriveEventCoordinate(
    deriveInvocation(taskId, 1, SUBMITTED_AT, DIGEST),
    toolCallTransitionId(0, callIndex),
    0,
  ).idempotencyKey;
}

/**
 * Take a coordinate the way a different operating-system process would.
 *
 * This is the honest simulation available in one process: the arbitration lives
 * in a file, so a claim written straight into that file is indistinguishable
 * — to the door under test — from one written by a CLI or a second gateway. The
 * cross-process claim is drilled against real processes in `@acp/ledger`; what
 * these cases prove is what *this door* does when it loses.
 */
function claimHeldBy(ledgerPath: string, taskId: string, holder: string, expiresAt: string): void {
  const store = openToolClaimStore(toolClaimStorePath(ledgerPath));
  try {
    store.transact(coordinateKeyFor(taskId), () => ({
      verb: "TAKE",
      row: {
        claimId: randomUUID(),
        holder,
        claimedAt: "2026-09-04T05:00:00.000Z",
        expiresAt,
        taskId,
        attempt: 1,
        transitionId: toolCallTransitionId(0, 0),
        submittedAt: SUBMITTED_AT,
        accountId: ACCOUNT,
        serverId: "docs",
        toolName: "docs.search",
        argumentBytes: 64,
      },
    }));
  } finally {
    store.close();
  }
}

const url = (taskId: string): string => "/api/v1/tasks/" + taskId + "/tool-calls";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: overrides["taskId"],
    attempt: 1,
    submittedAt: SUBMITTED_AT,
    submissionDigest: DIGEST,
    operationIndex: 0,
    callIndex: 0,
    accountId: ACCOUNT,
    identity: IDENTITY,
    serverId: "docs",
    toolName: "docs.search",
    arguments: { q: SENTINEL },
    ...overrides,
  };
}

function pids(dir: string): readonly number[] {
  const text = readFileSync(join(dir, "pids.log"), "utf8");
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => Number(line));
}

describe("the door executes one explicit tool call and records it", () => {
  it("completes end to end, returns content, and leaves no child running", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST",
      url: url(h.taskId),
      headers: AUTH,
      payload: body({ taskId: h.taskId }),
    });

    expect(response.statusCode).toBe(200);
    const payload = ToolCallExecuteResponse.parse(response.json());
    expect(payload.outcome).toBe("COMPLETED");
    expect(payload.replayed).toBe(false);
    expect(payload.refusal).toBeNull();
    expect(payload.at).toBeNull();
    expect(payload.content).toEqual(["the answer"]);
    expect(payload.apiContractVersion).toBe("0.22.0");
    // The door projects `sequence`; the operation cannot answer one.
    expect(typeof payload.sequence).toBe("number");
    expect(payload.transitionId).toBe("tool.0.0");

    const observed = pids(h.dir);
    expect(observed.length).toBeGreaterThan(0);
    for (const pid of observed) {
      // Reaped by pid before the response returned.
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await h.app.close();
  });

  it("replays a spent coordinate without a second spawn or a second row", async () => {
    const h = harness();
    const first = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH, payload: body({ taskId: h.taskId }),
    });
    const spawnedOnce = pids(h.dir).length;

    const second = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH, payload: body({ taskId: h.taskId }),
    });

    expect(second.statusCode).toBe(200);
    const replay = ToolCallExecuteResponse.parse(second.json());
    expect(replay.replayed).toBe(true);
    expect(replay.content).toEqual([]);
    expect(replay.at).toBeNull();
    expect(replay.eventId).toBe(ToolCallExecuteResponse.parse(first.json()).eventId);
    // The same row, so the same sequence: the door looks it up by event id.
    expect(replay.sequence).toBe(ToolCallExecuteResponse.parse(first.json()).sequence);
    expect(pids(h.dir).length).toBe(spawnedOnce);

    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    expect(ToolCallPageResponse.parse(page.json()).count).toBe(1);
    await h.app.close();
  });

  it("answers a refusal as 200 with a recorded row, not as an error", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST",
      url: url(h.taskId),
      headers: AUTH,
      // Allowlisted and writing, driven by a role that holds no write authority.
      payload: body({ taskId: h.taskId, toolName: "docs.write", identity: REVIEWER }),
    });

    expect(response.statusCode).toBe(200);
    const payload = ToolCallExecuteResponse.parse(response.json());
    expect(payload.outcome).toBe("REFUSED");
    expect(payload.refusal).toBe("IDENTITY_FORBIDS_WRITE");
    expect(payload.content).toEqual([]);

    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    expect(ToolCallPageResponse.parse(page.json()).count).toBe(1);
    expect(ToolCallPageResponse.parse(page.json()).items[0]?.outcome).toBe("REFUSED");
    await h.app.close();
  });

  it("records a server-marked tool error as a refusal: 200, a row, and no content (P-11)", async () => {
    // N-7 (API half) + N-3: the server answered a well-formed frame inside the
    // timeout and reported the tool's failure in the result itself. That is a
    // recorded refusal, not an error status — the request became an operation,
    // so the door answers 200 with the non-success outcome.
    const h = harness({ errorResult: true });
    const response = await h.app.inject({
      method: "POST",
      url: url(h.taskId),
      headers: AUTH,
      payload: body({ taskId: h.taskId }),
    });

    expect(response.statusCode).toBe(200);
    const payload = ToolCallExecuteResponse.parse(response.json());
    expect(payload.outcome).toBe("REFUSED");
    expect(payload.refusal).toBe("RESULT_IS_ERROR");
    expect(payload.at).toBe("server.result");
    expect(payload.content).toEqual([]);

    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    const rows = ToolCallPageResponse.parse(page.json());
    expect(rows.count).toBe(1);
    expect(rows.items[0]?.outcome).toBe("REFUSED");
    expect(rows.items[0]?.refusal).toBe("RESULT_IS_ERROR");
    // W3 through the door: the durable row carries the real counts of the
    // result that arrived — and none of its text.
    expect(rows.items[0]?.resultBytes ?? 0).toBeGreaterThan(0);
    expect(rows.items[0]?.contentBlocks).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("the tool failed");
    await h.app.close();
  });

  it("refuses a tool nobody allowed, with no spawn", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH,
      payload: body({ taskId: h.taskId, toolName: "shell.exec" }),
    });
    expect(response.statusCode).toBe(200);
    expect(ToolCallExecuteResponse.parse(response.json()).refusal).toBe("TOOL_NOT_ALLOWED");
    expect(pids(h.dir)).toHaveLength(0);
    await h.app.close();
  });
});

describe("the door is guarded, and refuses before it reveals anything", () => {
  it("answers 401 with no bearer", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), payload: body({ taskId: h.taskId }),
    });
    expect(response.statusCode).toBe(401);
    expect(pids(h.dir)).toHaveLength(0);
    await h.app.close();
  });

  it("answers 503 TOOL_SERVERS_UNCONFIGURED when no document was configured", async () => {
    const h = harness({ withDocument: false });
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH, payload: body({ taskId: h.taskId }),
    });
    expect(response.statusCode).toBe(503);
    expect(ApiError.parse(response.json()).error.code).toBe("TOOL_SERVERS_UNCONFIGURED");
    await h.app.close();
  });

  it("does not reveal the tool document's absence without the bearer", async () => {
    const h = harness({ withDocument: false });
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), payload: body({ taskId: h.taskId }),
    });
    // 401, not 503: nothing about the tool configuration is learnable first.
    expect(response.statusCode).toBe(401);
    await h.app.close();
  });

  it("answers 404 for a task the ledger has never seen", async () => {
    const h = harness();
    const unknown = randomUUID();
    const response = await h.app.inject({
      method: "POST", url: url(unknown), headers: AUTH, payload: body({ taskId: unknown }),
    });
    expect(response.statusCode).toBe(404);
    await h.app.close();
  });

  it("answers 409 for an attempt the task has not reached", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH,
      payload: body({ taskId: h.taskId, attempt: 2 }),
    });
    expect(response.statusCode).toBe(409);
    await h.app.close();
  });

  it("answers 400 naming the field and never the value", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH,
      payload: body({ taskId: h.taskId, toolName: "rm -rf " + SENTINEL }),
    });
    expect(response.statusCode).toBe(400);
    const text = response.body;
    expect(text).toContain("toolName");
    expect(text).not.toContain(SENTINEL);
    expect(pids(h.dir)).toHaveLength(0);
    await h.app.close();
  });

  it("answers 400 when the path and the body name different tasks", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH,
      payload: body({ taskId: randomUUID() }),
    });
    expect(response.statusCode).toBe(400);
    await h.app.close();
  });

  it("answers 405 on a method the route does not take", async () => {
    const h = harness();
    for (const method of ["PUT", "DELETE"] as const) {
      const response = await h.app.inject({ method, url: url(h.taskId), headers: AUTH });
      expect(response.statusCode).toBe(405);
    }
    await h.app.close();
  });
});

describe("a causal link must name an event of this same task", () => {
  it("records the link when the predecessor is this task's", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH,
      payload: body({ taskId: h.taskId, causedBy: h.discoveredEventId }),
    });
    expect(response.statusCode).toBe(200);

    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    expect(ToolCallPageResponse.parse(page.json()).items[0]?.causedBy).toBe(h.discoveredEventId);
    await h.app.close();
  });

  it("refuses a predecessor the ledger does not hold, with no spawn or row", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH,
      payload: body({ taskId: h.taskId, causedBy: randomUUID() }),
    });
    expect(response.statusCode).toBe(409);
    expect(pids(h.dir)).toHaveLength(0);

    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    expect(ToolCallPageResponse.parse(page.json()).count).toBe(0);
    await h.app.close();
  });

  it("refuses a predecessor belonging to another task, with no spawn or row", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH,
      payload: body({ taskId: h.taskId, causedBy: h.otherTaskEventId }),
    });
    // The event contract permits cross-task causation; this route does not.
    expect(response.statusCode).toBe(409);
    expect(pids(h.dir)).toHaveLength(0);

    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    expect(ToolCallPageResponse.parse(page.json()).count).toBe(0);
    await h.app.close();
  });

  it("records a null cause when the field is omitted", async () => {
    const h = harness();
    await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH, payload: body({ taskId: h.taskId }),
    });
    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    expect(ToolCallPageResponse.parse(page.json()).items[0]?.causedBy).toBeNull();
    await h.app.close();
  });
});

describe("the argument never becomes durable, and the scan is non-vacuous", () => {
  it("keeps the sentinel out of every recorded row while the size is kept", async () => {
    const h = harness();
    await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH, payload: body({ taskId: h.taskId }),
    });

    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    const serialized = JSON.stringify(ToolCallPageResponse.parse(page.json()));
    expect(serialized).not.toContain(SENTINEL);
    // Non-vacuous: the row that does not carry the argument does carry its size.
    expect(serialized).toContain("argumentBytes");

    const events = await h.app.inject({
      method: "GET", url: "/api/v1/events?taskId=" + h.taskId,
    });
    expect(events.body).not.toContain(SENTINEL);
    await h.app.close();
  });

  it("serves a page of rows carrying the nine scalars and no content", async () => {
    const h = harness();
    await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH, payload: body({ taskId: h.taskId }),
    });

    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    expect(page.statusCode).toBe(200);
    const first = ToolCallPageResponse.parse(page.json()).items[0];
    if (first === undefined) throw new Error("no recorded tool call");
    expect(Object.keys(first).sort()).toEqual([
      "accountId", "argumentBytes", "causedBy", "contentBlocks", "emittedBy", "eventId",
      "occurredAt", "outcome", "refusal", "resultBytes", "sequence", "serverId",
      "toolName", "transitionId", "transport",
    ]);
    expect("content" in first).toBe(false);
    await h.app.close();
  });

  it("pages by sequence and offers a cursor only when more exist", async () => {
    const h = harness();
    for (const callIndex of [0, 1]) {
      await h.app.inject({
        method: "POST", url: url(h.taskId), headers: AUTH,
        payload: body({ taskId: h.taskId, callIndex }),
      });
    }

    const firstPage = ToolCallPageResponse.parse(
      (await h.app.inject({ method: "GET", url: url(h.taskId) + "?limit=1" })).json(),
    );
    expect(firstPage.count).toBe(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const cursor = String(firstPage.nextCursor);
    const secondPage = await h.app.inject({
      method: "GET", url: url(h.taskId) + "?cursor=" + cursor,
    });
    const secondBody = ToolCallPageResponse.parse(secondPage.json());
    expect(secondBody.count).toBe(1);
    expect(secondBody.nextCursor).toBeNull();
    await h.app.close();
  });

  it("reads without a bearer, as every read on this plane does", async () => {
    const h = harness();
    const page = await h.app.inject({ method: "GET", url: url(h.taskId) });
    expect(page.statusCode).toBe(200);
    await h.app.close();
  });
});

describe("two callers, one coordinate", () => {
  /**
   * The race the post-audit drilled, and the barrier that makes it decidable.
   *
   * The operation's replay read and its append are not one step: it reads the
   * key, finds nothing, calls the tool, and appends afterwards. Sequentially
   * the coordinate is spent before the second request looks; concurrently it is
   * not. The fake answers `tools/call` only after a delay, so both requests are
   * certainly in flight together — without it the first would usually finish
   * before the second began, and the test would pass for the wrong reason.
   */
  it("runs one tool execution, records one row, and replays the other", async () => {
    const h = harness({ delayMs: 400 });
    const send = (): Promise<ReturnType<typeof h.app.inject> extends Promise<infer R> ? R : never> =>
      h.app.inject({
        method: "POST",
        url: url(h.taskId),
        headers: AUTH,
        payload: body({ taskId: h.taskId }),
      });

    const [first, second] = await Promise.all([send(), send()]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const bodies = [
      ToolCallExecuteResponse.parse(first.json()),
      ToolCallExecuteResponse.parse(second.json()),
    ];

    // Exactly one real effect: one child ever started.
    expect(pids(h.dir)).toHaveLength(1);

    // Exactly one durable row, and both callers name it.
    const page = ToolCallPageResponse.parse(
      (await h.app.inject({ method: "GET", url: url(h.taskId) })).json(),
    );
    expect(page.count).toBe(1);
    expect(bodies[0]?.eventId).toBe(bodies[1]?.eventId);
    expect(bodies[0]?.sequence).toBe(bodies[1]?.sequence);

    // One of them made the call and one replayed it — never two of either.
    const replayed = bodies.filter((entry) => entry.replayed);
    expect(replayed).toHaveLength(1);
    // The replaying caller gets no content, because none was ever durable.
    expect(replayed[0]?.content).toEqual([]);
    const executed = bodies.filter((entry) => !entry.replayed);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.content).toEqual(["the answer"]);

    await h.app.close();
  });

  it("serializes only the same coordinate, and lets a different one through", async () => {
    // Non-vacuous: a registry that queued everything would also pass the test
    // above. Two different call indices are two coordinates and two calls.
    const h = harness({ delayMs: 200 });
    const send = (callIndex: number) =>
      h.app.inject({
        method: "POST",
        url: url(h.taskId),
        headers: AUTH,
        payload: body({ taskId: h.taskId, callIndex }),
      });

    const [a, b] = await Promise.all([send(0), send(1)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(ToolCallExecuteResponse.parse(a.json()).replayed).toBe(false);
    expect(ToolCallExecuteResponse.parse(b.json()).replayed).toBe(false);

    const page = ToolCallPageResponse.parse(
      (await h.app.inject({ method: "GET", url: url(h.taskId) })).json(),
    );
    expect(page.count).toBe(2);
    await h.app.close();
  });

  it("leaves the coordinate takeable after a failed attempt", async () => {
    // A first attempt that throws without appending must not wedge the key: the
    // registry entry is removed in a `finally`, so the next caller owns it.
    const h = harness({ withDocument: false });
    const first = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH, payload: body({ taskId: h.taskId }),
    });
    expect(first.statusCode).toBe(503);

    const second = await h.app.inject({
      method: "POST", url: url(h.taskId), headers: AUTH, payload: body({ taskId: h.taskId }),
    });
    // Still 503 for the same reason, but reached rather than hung.
    expect(second.statusCode).toBe(503);
    await h.app.close();
  });
});

/**
 * The other half of "two callers, one coordinate" — the half stage 3C could
 * not close (V2 X1b).
 *
 * The cases above are two callers *this process serves*, and the `IN_FLIGHT`
 * map handles them by making the second wait and then replay. It is a `Map` in
 * this process's memory, so it never saw a CLI process or a second gateway, and
 * both of those could previously run the same tool for the same coordinate.
 *
 * `tool_claim` is the authority that closes it, and these cases drill this
 * door's side of it: what a loser is told, what it is not told, and that it
 * loses *before* a child exists rather than after.
 */
describe("a coordinate another process holds", () => {
  it("answers 409 CLAIM_HELD, and starts no child", async () => {
    const h = harness();
    // Unexpired: a live claimant, by the only test this plane has.
    claimHeldBy(h.ledgerPath, h.taskId, "claude/sonnet/implementer/07", "2200-01-01T00:00:00.000Z");

    const response = await h.app.inject({
      method: "POST",
      url: url(h.taskId),
      headers: AUTH,
      payload: body({ taskId: h.taskId }),
    });

    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.code).toBe("CLAIM_HELD");
    // The point of arbitrating before the effect: no second tool ever ran.
    expect(pids(h.dir)).toHaveLength(0);

    // And no row, because the request never became an operation.
    const page = ToolCallPageResponse.parse(
      (await h.app.inject({ method: "GET", url: url(h.taskId) })).json(),
    );
    expect(page.count).toBe(0);
    await h.app.close();
  });

  it("tells a loser that it lost, and not who beat it", async () => {
    const h = harness();
    const holder = "claude/sonnet/implementer/07";
    claimHeldBy(h.ledgerPath, h.taskId, holder, "2200-01-01T00:00:00.000Z");

    const response = await h.app.inject({
      method: "POST",
      url: url(h.taskId),
      headers: AUTH,
      payload: body({ taskId: h.taskId }),
    });

    const serialized = response.body;
    expect(serialized).not.toContain(holder);
    expect(serialized).not.toContain(coordinateKeyFor(h.taskId));
    expect(serialized).not.toContain(h.ledgerPath);
    expect(serialized).not.toContain(SENTINEL);
    // What it does say is the one thing a loser needs to act on.
    expect(ApiError.parse(response.json()).error.message).toContain("read the recorded call");
    await h.app.close();
  });

  it("is 409 rather than WRITE_REFUSED, whose hint is the opposite", async () => {
    const h = harness();
    claimHeldBy(h.ledgerPath, h.taskId, "claude/sonnet/implementer/07", "2200-01-01T00:00:00.000Z");

    const response = await h.app.inject({
      method: "POST",
      url: url(h.taskId),
      headers: AUTH,
      payload: body({ taskId: h.taskId }),
    });

    // Both are conflicts and both are 409, so the status alone cannot carry the
    // difference — which is exactly why the code is distinct. `WRITE_REFUSED`
    // is documented as worth retrying against a fresh head; retrying this one
    // risks a second real tool effect.
    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.code).not.toBe("WRITE_REFUSED");
    await h.app.close();
  });

  it("runs the tool when the holder's claim has expired and it left no window open", async () => {
    const h = harness();
    // CLAIMED and expired: the dead holder never reached the tool, so this is
    // an ordinary reclaim and the caller walks it normally. Non-vacuous against
    // the case above, which differs only in the expiry.
    claimHeldBy(h.ledgerPath, h.taskId, "claude/sonnet/implementer/07", "2000-01-01T00:00:00.000Z");

    const response = await h.app.inject({
      method: "POST",
      url: url(h.taskId),
      headers: AUTH,
      payload: body({ taskId: h.taskId }),
    });

    expect(response.statusCode).toBe(200);
    const payload = ToolCallExecuteResponse.parse(response.json());
    expect(payload.replayed).toBe(false);
    expect(payload.content).toEqual(["the answer"]);
    expect(pids(h.dir)).toHaveLength(1);
    await h.app.close();
  });

  it("does not refuse a different coordinate, which is what makes the refusal specific", async () => {
    const h = harness();
    claimHeldBy(h.ledgerPath, h.taskId, "claude/sonnet/implementer/07", "2200-01-01T00:00:00.000Z");

    // Same task, second call index: a different coordinate, and therefore a
    // different claim. A door that refused everything would pass the first case
    // in this block and fail here.
    const response = await h.app.inject({
      method: "POST",
      url: url(h.taskId),
      headers: AUTH,
      payload: body({ taskId: h.taskId, callIndex: 1 }),
    });

    expect(response.statusCode).toBe(200);
    expect(ToolCallExecuteResponse.parse(response.json()).replayed).toBe(false);
    await h.app.close();
  });
});

// ---------------------------------------------------------------------------
// P-24 (ADR 0109): the door lists before it calls, and calls only under the pin
// ---------------------------------------------------------------------------

/** What the P-24 fake advertises, and how it pages and announces. */
interface P24Script {
  readonly advertises?: readonly string[];
  readonly schemas?: Readonly<Record<string, unknown>>;
  readonly pageSize?: number;
  readonly cursorCycle?: boolean;
  readonly listChangedBeforeCall?: boolean;
}

/**
 * This suite's own P-24 fake: pages its listing, logs every method it is asked
 * for (`list <cursor>` / `call <name>`) and its pid, and can announce a
 * `list_changed` in the same write as the listing's last page.
 */
function writeP24Server(dir: string, pidLog: string, methodLog: string, script: P24Script): { command: string; args: string[] } {
  const path = join(dir, "fake-mcp-p24.mjs");
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(" + JSON.stringify(pidLog) + ", String(process.pid) + '\\n');",
      "const LOG = " + JSON.stringify(methodLog) + ";",
      "const ADVERTISES = " + JSON.stringify(script.advertises ?? ["docs.search", "docs.write"]) + ";",
      "const SCHEMAS = " + JSON.stringify(script.schemas ?? {}) + ";",
      "const PAGE = " + JSON.stringify(script.pageSize ?? null) + ";",
      "const CYCLE = " + JSON.stringify(script.cursorCycle === true) + ";",
      "const CHANGED = " + JSON.stringify(script.listChangedBeforeCall === true) + ";",
      "let announced = false;",
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
      "      capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '0' } } }));",
      "    return;",
      "  }",
      "  if (method === 'notifications/initialized') return;",
      "  if (method === 'tools/list') {",
      "    const cursor = params && typeof params.cursor === 'string' ? params.cursor : null;",
      "    appendFileSync(LOG, 'list ' + String(cursor) + '\\n');",
      "    const all = ADVERTISES.map((name) => ({ name, inputSchema: Object.hasOwn(SCHEMAS, name) ? SCHEMAS[name] : { type: 'object' } }));",
      "    const size = PAGE === null ? all.length : PAGE;",
      "    const start = cursor === null ? 0 : Number(cursor.slice(1));",
      "    const result = { tools: all.slice(start, start + size) };",
      "    if (start + size < all.length) result.nextCursor = CYCLE && start > 0 ? 'c' + String(size) : 'c' + String(start + size);",
      "    let out = frame({ jsonrpc: '2.0', id, result });",
      "    if (CHANGED && !announced && result.nextCursor === undefined) {",
      "      announced = true;",
      "      out += frame({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });",
      "    }",
      "    process.stdout.write(out);",
      "    return;",
      "  }",
      "  if (method === 'tools/call') {",
      "    appendFileSync(LOG, 'call ' + String(params && params.name) + '\\n');",
      "    process.stdout.write(frame({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'the answer' }] } }));",
      "  }",
      "}",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o700);
  return { command: realpathSync(process.execPath), args: [path] };
}

/** The pin every P-24 row's allowlist carries for `docs.search`. */
const P24_PIN = { type: "object", properties: { q: { type: "string" } } };

/** The E rows, shared in shape with the other door's suite (parity is asserted in the gateway's parity suite). */
const P24_ROWS: readonly {
  readonly row: string;
  readonly script: P24Script;
  readonly expect: { readonly outcome: string; readonly refusal: string | null; readonly at: string | null };
  readonly log: readonly string[];
}[] = [
  {
    row: "E1: pin equal to the advertisement, tool on page 1",
    script: { schemas: { "docs.search": P24_PIN } },
    expect: { outcome: "COMPLETED", refusal: null, at: null },
    log: ["list null", "call docs.search"],
  },
  {
    row: "E2: the tool on page 3 of 3",
    script: { advertises: ["a.1", "a.2", "docs.search"], pageSize: 1, schemas: { "docs.search": P24_PIN } },
    expect: { outcome: "COMPLETED", refusal: null, at: null },
    log: ["list null", "list c1", "list c2", "call docs.search"],
  },
  {
    row: "E3: one nested key differs",
    script: { schemas: { "docs.search": { type: "object", properties: { q: { type: "number" } } } } },
    expect: { outcome: "REFUSED", refusal: "SCHEMA_MISMATCH", at: "server.tools.inputSchema" },
    log: ["list null"],
  },
  {
    row: "E4: allowlisted, not advertised",
    script: { advertises: ["docs.write"] },
    expect: { outcome: "REFUSED", refusal: "SCHEMA_MISMATCH", at: "server.tools" },
    log: ["list null"],
  },
  {
    row: "E5: a cursor cycle",
    script: { advertises: ["a.1", "a.2", "a.3", "docs.search"], pageSize: 1, cursorCycle: true, schemas: { "docs.search": P24_PIN } },
    expect: { outcome: "REFUSED", refusal: "PROTOCOL_VIOLATION", at: "server.tools.nextCursor" },
    log: ["list null", "list c1"],
  },
  {
    row: "E7: a list_changed between the listing and the call",
    script: { schemas: { "docs.search": P24_PIN }, listChangedBeforeCall: true },
    expect: { outcome: "COMPLETED", refusal: null, at: null },
    log: ["list null", "list null", "call docs.search"],
  },
  {
    row: "E8: pages past TOOL_LIST_PAGES_MAX",
    script: {
      advertises: [...Array.from({ length: TOOL_LIST_PAGES_MAX }, (_, index) => "a." + String(index)), "docs.search"],
      pageSize: 1,
      schemas: { "docs.search": P24_PIN },
    },
    expect: { outcome: "REFUSED", refusal: "RESULT_UNBOUNDED", at: "server.tools" },
    log: Array.from({ length: TOOL_LIST_PAGES_MAX }, (_, index) => "list " + (index === 0 ? "null" : "c" + String(index))),
  },
];

/** The operator document for a P-24 row: `docs.search` pinned (or not, for E6), `docs.write` pinned to the smallest schema. */
function p24Document(dir: string, fake: { command: string; args: string[] }, pinned = true): string {
  const path = join(dir, "tool-servers-p24.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        serverId: "docs",
        transport: "STDIO",
        command: fake.command,
        args: fake.args,
        tools: [
          pinned ? { name: "docs.search", writes: false, inputSchema: P24_PIN } : { name: "docs.search", writes: false },
          { name: "docs.write", writes: true, inputSchema: { type: "object" } },
        ],
      },
    ]),
    "utf8",
  );
  chmodSync(path, 0o600);
  return path;
}

function methodLines(path: string): readonly string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

describe("P-24: the API door lists before it calls, and calls only under the pin (E1-E8)", () => {
  /** A seeded ledger, a bearer and a P-24 fake for one row; the API door posted once. */
  async function runRow(script: P24Script): Promise<{
    readonly statusCode: number;
    readonly payload: unknown;
    readonly dir: string;
    readonly pidLog: string;
    readonly methodLog: string;
    readonly ledgerPath: string;
  }> {
    const dir = root();
    mkdirSync(join(dir, "ledger"), { recursive: true });
    const ledgerPath = join(dir, "ledger", "acp.sqlite3");
    const pidLog = join(dir, "pids.log");
    const methodLog = join(dir, "methods.log");
    writeFileSync(pidLog, "", "utf8");
    const taskId = randomUUID();
    const ledger = openLedger(ledgerPath);
    ledger.append(makeEvent(taskId));
    ledger.close();
    const fake = writeP24Server(dir, pidLog, methodLog, script);
    const app = buildServer({ ledgerPath, writeBearerPath: tokenFile(dir), toolServersPath: p24Document(dir, fake) });
    try {
      const response = await app.inject({ method: "POST", url: url(taskId), headers: AUTH, payload: body({ taskId }) });
      return { statusCode: response.statusCode, payload: response.json(), dir, pidLog, methodLog, ledgerPath };
    } finally {
      await app.close();
    }
  }

  for (const row of P24_ROWS) {
    it(row.row, async () => {
      const ran = await runRow(row.script);
      expect(ran.statusCode).toBe(200);
      // The existing response schema still parses the new word: it crosses by grammar.
      const payload = ToolCallExecuteResponse.parse(ran.payload);
      expect({ outcome: payload.outcome, refusal: payload.refusal, at: payload.at }).toEqual(row.expect);
      expect(methodLines(ran.methodLog)).toEqual(row.log);
      const ledger = openLedger(ran.ledgerPath, { readOnly: true });
      const recorded = ledger.listEvents({ limit: 100 }).events.map((entry) => entry.event).filter((event) => event.type === "TOOL_CALL_RECORDED");
      ledger.close();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.payload).toMatchObject({ refusal: row.expect.refusal });
      if (row.expect.refusal !== null) expect(recorded[0]?.payload).toMatchObject({ resultBytes: 0, contentBlocks: 0 });
      const started = readFileSync(ran.pidLog, "utf8").split("\n").filter((line) => line.trim() !== "").map(Number);
      expect(started.length).toBeGreaterThan(0);
      for (const pid of started) expect(() => process.kill(pid, 0)).toThrow();
    });
  }

  it("E6: refuses a document with an unpinned tool as DOCUMENT_NOT_ADMITTED, forwards no path, and starts no child", async () => {
    const dir = root();
    mkdirSync(join(dir, "ledger"), { recursive: true });
    const ledgerPath = join(dir, "ledger", "acp.sqlite3");
    const pidLog = join(dir, "pids.log");
    writeFileSync(pidLog, "", "utf8");
    const taskId = randomUUID();
    const ledger = openLedger(ledgerPath);
    ledger.append(makeEvent(taskId));
    ledger.close();
    const document = p24Document(dir, writeP24Server(dir, pidLog, join(dir, "methods.log"), {}), false);
    expect(loadToolServers(document)).toEqual({ ok: false, reason: "DOCUMENT_NOT_ADMITTED" });
    const app = buildServer({ ledgerPath, writeBearerPath: tokenFile(dir), toolServersPath: document });
    try {
      const response = await app.inject({ method: "POST", url: url(taskId), headers: AUTH, payload: body({ taskId }) });
      expect(response.statusCode).toBe(503);
      expect(ApiError.parse(response.json()).error.code).toBe("TOOL_SERVERS_UNCONFIGURED");
      expect(response.body).not.toContain("inputSchema");
    } finally {
      await app.close();
    }
    expect(readFileSync(pidLog, "utf8")).toBe("");
  });
});
