import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { openToolClaimStore, openLedger, toolClaimStorePath } from "@acp/ledger";
import { deriveEventCoordinate, deriveInvocation, toolCallTransitionId } from "@acp/runtime";
import { LEDGER_CONTRACT_VERSION } from "@acp/protocol";
import { admitToolServers } from "@acp/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT_CLAIM_HELD,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  run,
} from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/index.js";

/**
 * Evidence for the CLI's tool-call write door (V2-B4b stage 3D).
 *
 * Kept out of the observation suite deliberately: this one spawns real child
 * processes, and a suite that proves the CLI reads should not also be the suite
 * that starts servers. The fake MCP server is this suite's own fixture, written
 * to a temp directory — it proves this machinery and nothing about any real MCP
 * implementation.
 *
 * The two cases worth reading first are the pair under "the ledger is probed
 * before it is written": a bare writable open both *creates* a database at a
 * typo path and *migrates* one silently, and this verb is granted authority to
 * do neither.
 */

const FIXED_NOW = "2026-09-03T12:00:00.000Z";
const IDENTITY = "claude/opus/implementer/01";
const REVIEWER = "claude/opus/reviewer/01";
const SENTINEL = "SENTINEL-ARGUMENT-MUST-NOT-BE-DURABLE";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const created = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "acp-cli-toolcall-")));
  roots.push(created);
  return created;
}

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
    now: () => FIXED_NOW,
  };
  const exitCode = await run(argv, io);
  return { exitCode, stdout, stderr };
}

/** A minimal stdio MCP server that logs its own pid. */
function writeFakeServer(dir: string, pidLog: string): { command: string; args: string[] } {
  const path = join(dir, "fake-mcp.mjs");
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(" + JSON.stringify(pidLog) + ", String(process.pid) + '\\n');",
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
      "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
      "function handle(message) {",
      "  const { id, method } = message;",
      "  if (method === 'initialize') {",
      "    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18',",
      "      capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });",
      "    return;",
      "  }",
      "  if (method === 'notifications/initialized') return;",
      "  if (method === 'tools/list') {",
      "    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'docs.search',",
      "      description: 'd', inputSchema: { type: 'object' } }] } });",
      "    return;",
      "  }",
      "  if (method === 'tools/call') {",
      "    send({ jsonrpc: '2.0', id, result: {",
      "      content: [{ type: 'text', text: 'the answer' }], isError: false } });",
      "  }",
      "}",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o700);
  return { command: realpathSync(process.execPath), args: [path] };
}

function toolServersFile(dir: string, pidLog: string, mode = 0o600): string {
  const fake = writeFakeServer(dir, pidLog);
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
          { name: "docs.search", writes: false },
          { name: "docs.write", writes: true },
        ],
      },
    ]),
    "utf8",
  );
  chmodSync(path, mode);
  return path;
}

function requestFile(dir: string, overrides: Record<string, unknown>, name = "request.json"): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      attempt: 1,
      submittedAt: FIXED_NOW,
      submissionDigest: "a".repeat(64),
      operationIndex: 0,
      callIndex: 0,
      accountId: "acct-primary",
      identity: IDENTITY,
      serverId: "docs",
      toolName: "docs.search",
      arguments: { q: SENTINEL },
      ...overrides,
    }),
    "utf8",
  );
  chmodSync(path, 0o600);
  return path;
}

function seedLedger(dir: string): { readonly path: string; readonly taskId: string } {
  const path = join(dir, "acp.sqlite3");
  const taskId = randomUUID();
  const ledger = openLedger(path);
  ledger.append({
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId,
    attempt: 1,
    transitionId: "discover",
    idempotencyKey: taskId + "/1/discover",
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "kimi/k3/coordinator/01",
    occurredAt: FIXED_NOW,
    recordedAt: FIXED_NOW,
    correlationId: null,
    causationId: null,
    payload: {},
  });
  ledger.close();
  return { path, taskId };
}

interface Fixture {
  readonly dir: string;
  readonly databasePath: string;
  readonly taskId: string;
  readonly toolServers: string;
  readonly pidLog: string;
}

function fixture(): Fixture {
  const dir = root();
  const pidLog = join(dir, "pids.log");
  writeFileSync(pidLog, "", "utf8");
  const { path, taskId } = seedLedger(dir);
  return { dir, databasePath: path, taskId, toolServers: toolServersFile(dir, pidLog), pidLog };
}

function pids(pidLog: string): readonly number[] {
  return readFileSync(pidLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Number(line));
}

function eventCount(databasePath: string): number {
  const ledger = openLedger(databasePath, { readOnly: true });
  try {
    return ledger.status().eventCount;
  } finally {
    ledger.close();
  }
}

const call = (f: Fixture, request: string, format?: "json"): Promise<Invocation> =>
  invoke([
    "tool-call",
    "--database", f.databasePath,
    "--request", request,
    "--tool-servers", f.toolServers,
    // The verb's success document is JSON either way; the format only decides
    // how a *refusal* is rendered, and the envelope is what these cases assert.
    ...(format === undefined ? [] : ["--format", format]),
  ]);

/** The error envelope a `--format json` refusal writes to stderr. */
function envelope(result: Invocation): { readonly error: { readonly code: string } } {
  return JSON.parse(result.stderr) as { readonly error: { readonly code: string } };
}

describe("the verb executes one tool call and records it", () => {
  it("completes, prints the content, and leaves no child running", async () => {
    const f = fixture();
    const result = await call(f, requestFile(f.dir, { taskId: f.taskId }));

    expect(result.exitCode).toBe(EXIT_OK);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document["outcome"]).toBe("COMPLETED");
    expect(document["replayed"]).toBe(false);
    expect(document["content"]).toEqual(["the answer"]);
    expect(typeof document["sequence"]).toBe("number");
    expect(document["apiContractVersion"]).toBe("0.12.0");

    const observed = pids(f.pidLog);
    expect(observed.length).toBeGreaterThan(0);
    for (const pid of observed) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("replays a spent coordinate without a second spawn or a second row", async () => {
    const f = fixture();
    const request = requestFile(f.dir, { taskId: f.taskId });
    const first = JSON.parse((await call(f, request)).stdout) as Record<string, unknown>;
    const spawnedOnce = pids(f.pidLog).length;
    const before = eventCount(f.databasePath);

    const second = JSON.parse((await call(f, request)).stdout) as Record<string, unknown>;

    expect(second["replayed"]).toBe(true);
    expect(second["content"]).toEqual([]);
    expect(second["at"]).toBeNull();
    expect(second["eventId"]).toBe(first["eventId"]);
    expect(second["sequence"]).toBe(first["sequence"]);
    expect(pids(f.pidLog).length).toBe(spawnedOnce);
    expect(eventCount(f.databasePath)).toBe(before);
  });

  it("treats a refused call as a success of the verb, with a row", async () => {
    const f = fixture();
    const before = eventCount(f.databasePath);
    const result = await call(
      f,
      requestFile(f.dir, { taskId: f.taskId, toolName: "docs.write", identity: REVIEWER }),
    );

    // A refusal is a recorded outcome: the CLI's exact analogue of the API's
    // HTTP 200 with `outcome: "REFUSED"`.
    expect(result.exitCode).toBe(EXIT_OK);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document["outcome"]).toBe("REFUSED");
    expect(document["refusal"]).toBe("IDENTITY_FORBIDS_WRITE");
    expect(document["content"]).toEqual([]);
    expect(eventCount(f.databasePath)).toBe(before + 1);
  });

  it("refuses a tool nobody allowed as a recorded outcome, with no spawn", async () => {
    const f = fixture();
    const before = eventCount(f.databasePath);
    const result = await call(f, requestFile(f.dir, { taskId: f.taskId, toolName: "shell.exec" }));

    // `shell.exec` is a bounded identifier, so it parses and reaches the port,
    // where the allowlist refuses it upstream of the wire. That is a recorded
    // outcome and therefore exit 0 -- not a malformed request.
    expect(result.exitCode).toBe(EXIT_OK);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document["outcome"]).toBe("REFUSED");
    expect(document["refusal"]).toBe("TOOL_NOT_ALLOWED");
    expect(eventCount(f.databasePath)).toBe(before + 1);
    // Refused before the wire, so no server was ever started.
    expect(pids(f.pidLog)).toHaveLength(0);
  });
});

describe("the ledger is probed before it is written", () => {
  it("creates no database at a path that does not exist", async () => {
    const f = fixture();
    const absent = join(f.dir, "not-there.sqlite3");
    const result = await invoke([
      "tool-call",
      "--database", absent,
      "--request", requestFile(f.dir, { taskId: f.taskId }),
      "--tool-servers", f.toolServers,
    ]);

    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    // The hazard a bare writable open carries: `openLedger(path)` has no
    // `fileMustExist`, so a typo would leave an empty database behind.
    expect(existsSync(absent)).toBe(false);
  });

  it("refuses a file that is not a database, and leaves its bytes alone", async () => {
    const f = fixture();
    // Precisely what this shows: the `LEDGER_OPEN` path, not the migration
    // one. A writable open would have created a schema inside this file; the
    // read-only probe refuses it first, with the words a read verb produces.
    const foreign = join(f.dir, "foreign.sqlite3");
    writeFileSync(foreign, "not a database", "utf8");
    const bytesBefore = readFileSync(foreign, "utf8");

    const result = await invoke([
      "tool-call",
      "--database", foreign,
      "--request", requestFile(f.dir, { taskId: f.taskId }),
      "--tool-servers", f.toolServers,
    ]);

    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(readFileSync(foreign, "utf8")).toBe(bytesBefore);
  });

  it("refuses a ledger with a pending migration, and applies nothing", async () => {
    const f = fixture();
    // The real thing, and the case the D-4 property is actually about. The
    // ledger is created and migrated by `openLedger`, then one applied
    // migration is removed so the next open sees a pending one. A writable
    // open would re-apply it inside a transaction and stamp it with a clock;
    // the read-only probe throws instead, because a read-only handle may not
    // migrate. Driving it needs raw SQL, which is why `node:sqlite` is on this
    // package's test-only import list.
    const database = new DatabaseSync(f.databasePath);
    const appliedBefore = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => Number((row as { version: unknown }).version));
    const highest = appliedBefore[appliedBefore.length - 1];
    if (highest === undefined) throw new Error("the fixture ledger has no applied migrations");
    database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(highest);
    database.close();

    const result = await invoke([
      "tool-call",
      "--database", f.databasePath,
      "--request", requestFile(f.dir, { taskId: f.taskId }),
      "--tool-servers", f.toolServers,
      "--format", "json",
    ]);

    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    // The read verbs' own word for a schema this build cannot read.
    expect(envelope(result).error.code).toBe("CONTRACT_VERSION_MISMATCH");

    // And nothing was applied: the set is still missing exactly what was
    // removed. A writable open would have put it back.
    const after = new DatabaseSync(f.databasePath);
    const appliedAfter = after
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => Number((row as { version: unknown }).version));
    after.close();
    expect(appliedAfter).toEqual(appliedBefore.filter((version) => version !== highest));
    expect(appliedAfter).not.toContain(highest);
    // Non-vacuous: the fixture really did have that migration a moment ago.
    expect(appliedBefore).toContain(highest);

    expect(pids(f.pidLog)).toHaveLength(0);
  });

  it("answers not-found for a task the ledger has never seen", async () => {
    const f = fixture();
    const result = await call(f, requestFile(f.dir, { taskId: randomUUID() }));
    expect(result.exitCode).toBe(EXIT_NOT_FOUND);
    expect(pids(f.pidLog)).toHaveLength(0);
  });
});

describe("operator authority is the owning uid, and it is checked", () => {
  it("refuses a missing, relative or non-regular document by field, never by path", async () => {
    const f = fixture();
    const request = requestFile(f.dir, { taskId: f.taskId });

    const cases: readonly (readonly [string, string])[] = [
      ["--request", ""],
      ["--request", "relative/request.json"],
      ["--request", join(f.dir, "absent.json")],
      ["--request", f.dir],
      ["--tool-servers", ""],
      ["--tool-servers", "relative/servers.json"],
      ["--tool-servers", join(f.dir, "absent.json")],
    ];
    for (const [flag, value] of cases) {
      const argv =
        flag === "--request"
          ? ["tool-call", "--database", f.databasePath, "--request", value, "--tool-servers", f.toolServers]
          : ["tool-call", "--database", f.databasePath, "--request", request, "--tool-servers", value];
      const result = await invoke(argv);
      expect({ flag, value, exitCode: result.exitCode }).toEqual({
        flag,
        value,
        exitCode: EXIT_USAGE,
      });
      // The field, never the path.
      if (value !== "") expect(result.stderr).not.toContain(value);
    }
  });

  it("refuses a tool-servers document others can read", async () => {
    const f = fixture();
    const loose = toolServersFile(f.dir, f.pidLog, 0o644);
    const result = await invoke([
      "tool-call",
      "--database", f.databasePath,
      "--request", requestFile(f.dir, { taskId: f.taskId }),
      "--tool-servers", loose,
    ]);
    // The document names commands the plane will execute, so it takes the
    // bearer file's mode check. The request document does not.
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(pids(f.pidLog)).toHaveLength(0);
  });

  it("refuses a request document that is not a valid tool call, naming the field", async () => {
    const f = fixture();
    const result = await call(
      f,
      requestFile(f.dir, { taskId: f.taskId, toolName: "rm -rf " + SENTINEL }),
    );
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("toolName");
    expect(result.stderr).not.toContain(SENTINEL);
    expect(pids(f.pidLog)).toHaveLength(0);
  });
});

describe("the admission decision is the shared one, not a second opinion", () => {
  /**
   * D-7, at the level this suite can reach it.
   *
   * Packet C put the *decision* in `@acp/tools`' `admitToolServers` and left
   * each door to read its own file, so what could diverge is which documents
   * each door will admit. This drives the shared decision over a table of
   * malformed documents and asserts the CLI refuses every one it refuses —
   * that the verb defers rather than deciding.
   *
   * What this cannot reach: the gateway's own file-reading ladder, which lives
   * in a package this one may not import. That half is named as a limitation
   * in the packet report rather than claimed here.
   */
  const MALFORMED: readonly (readonly [string, unknown])[] = [
    ["not an array", { servers: [] }],
    ["empty", []],
    ["not an object entry", ["docs"]],
    ["no server id", [{ transport: "STDIO", command: "/bin/true", tools: [] }]],
    ["spaced server id", [{ serverId: "not a name", transport: "STDIO", command: "/bin/true", tools: [] }]],
    ["remote", [{ serverId: "remote", transport: "STDIO", url: "https://example.com", tools: [] }]],
  ];

  it("refuses every document the shared admission refuses", async () => {
    const f = fixture();
    const request = requestFile(f.dir, { taskId: f.taskId });

    for (const [label, document] of MALFORMED) {
      // The shared authority's verdict.
      expect({ label, ok: admitToolServers(document).ok }).toEqual({ label, ok: false });

      const path = join(f.dir, "servers-" + label.replace(/[^a-z]/g, "-") + ".json");
      writeFileSync(path, JSON.stringify(document), "utf8");
      chmodSync(path, 0o600);
      const result = await invoke([
        "tool-call",
        "--database", f.databasePath,
        "--request", request,
        "--tool-servers", path,
      ]);
      expect({ label, exitCode: result.exitCode }).toEqual({ label, exitCode: EXIT_USAGE });
      expect(pids(f.pidLog)).toHaveLength(0);
    }
  });
});

describe("the argument never becomes durable", () => {
  it("keeps the sentinel out of the ledger and out of stderr, while the size is kept", async () => {
    const f = fixture();
    await call(f, requestFile(f.dir, { taskId: f.taskId }));

    const ledger = openLedger(f.databasePath, { readOnly: true });
    const serialized = ledger.listEvents({ taskId: f.taskId }).events
      .map((row) => row.canonicalJson)
      .join("\n");
    ledger.close();

    expect(serialized).not.toContain(SENTINEL);
    // Non-vacuous: the row that does not carry the argument does carry its size.
    expect(serialized).toContain("argumentBytes");
  });
});

describe("the door's own checks, driven rather than assumed", () => {
  /**
   * The five cases the API door has and this suite did not reach.
   *
   * The code was present and mirrors the gateway's, but present-and-untested is
   * how a check quietly stops working. Each refusal asserts **no spawn and no
   * row** as well as the envelope, because a check that ran after the port was
   * touched would also refuse — and only the pid log and the event count tell
   * the two apart.
   */
  it("records a same-task predecessor as the row's cause", async () => {
    const f = fixture();
    // The discovery event this suite seeds is this task's own, so it is a
    // predecessor a reader of this task's trail can resolve.
    const ledger = openLedger(f.databasePath, { readOnly: true });
    const discovered = ledger.listEvents({ taskId: f.taskId }).events[0];
    ledger.close();
    if (discovered === undefined) throw new Error("no discovery event");

    const result = await call(
      f,
      requestFile(f.dir, { taskId: f.taskId, causedBy: discovered.eventId }),
    );
    expect(result.exitCode).toBe(EXIT_OK);

    const after = openLedger(f.databasePath, { readOnly: true });
    const recorded = after
      .listEvents({ taskId: f.taskId, type: "TOOL_CALL_RECORDED" })
      .events[0];
    after.close();
    expect(recorded?.event.causationId).toBe(discovered.eventId);
  });

  it("records a null cause when the field is omitted", async () => {
    const f = fixture();
    await call(f, requestFile(f.dir, { taskId: f.taskId }));

    const ledger = openLedger(f.databasePath, { readOnly: true });
    const recorded = ledger
      .listEvents({ taskId: f.taskId, type: "TOOL_CALL_RECORDED" })
      .events[0];
    ledger.close();
    expect(recorded?.event.causationId).toBeNull();
  });

  it("refuses a predecessor the ledger does not hold, with no spawn and no row", async () => {
    const f = fixture();
    const before = eventCount(f.databasePath);
    const result = await call(
      f,
      requestFile(f.dir, { taskId: f.taskId, causedBy: randomUUID() }),
      "json",
    );

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(envelope(result).error.code).toBe("WRITE_REFUSED");
    expect(pids(f.pidLog)).toHaveLength(0);
    expect(eventCount(f.databasePath)).toBe(before);
  });

  it("refuses a predecessor belonging to another task, with no spawn and no row", async () => {
    const f = fixture();
    // A second task in the same ledger, so the event exists and is resolvable
    // — it simply is not this task's. The event contract permits cross-task
    // causation in general; this door narrows it, exactly as the API door does.
    const otherTask = randomUUID();
    const writable = openLedger(f.databasePath);
    const otherEventId = randomUUID();
    writable.append({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: otherEventId,
      taskId: otherTask,
      attempt: 1,
      transitionId: "discover",
      idempotencyKey: otherTask + "/1/discover",
      type: "TASK_DISCOVERED",
      fromState: null,
      toState: "DISCOVERED",
      emittedBy: "kimi/k3/coordinator/01",
      occurredAt: FIXED_NOW,
      recordedAt: FIXED_NOW,
      correlationId: null,
      causationId: null,
      payload: {},
    });
    writable.close();

    const before = eventCount(f.databasePath);
    const result = await call(
      f,
      requestFile(f.dir, { taskId: f.taskId, causedBy: otherEventId }),
      "json",
    );

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(envelope(result).error.code).toBe("WRITE_REFUSED");
    expect(pids(f.pidLog)).toHaveLength(0);
    expect(eventCount(f.databasePath)).toBe(before);
  });

  it("refuses an attempt the task has not reached, with no spawn and no row", async () => {
    const f = fixture();
    const before = eventCount(f.databasePath);
    const result = await call(f, requestFile(f.dir, { taskId: f.taskId, attempt: 2 }), "json");

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(envelope(result).error.code).toBe("WRITE_REFUSED");
    expect(pids(f.pidLog)).toHaveLength(0);
    expect(eventCount(f.databasePath)).toBe(before);
  });
});


/**
 * The claim, at the door most likely to meet it (V2 X1b).
 *
 * Every `acp tool-call` is a new process that exits when the call is done, so
 * this door never had — and could not usefully have had — a registry of its
 * own. Before this packet two overlapping invocations for one coordinate, which
 * is exactly what a script that retries on a timeout produces, spawned two
 * children for one row.
 *
 * The claim is a file, so a claim written straight into it is indistinguishable
 * — to the verb under test — from one written by a second CLI or by the
 * gateway. What is proven here is what *this door* does when it loses, and in
 * particular that it says so with a code a retry wrapper can branch on.
 */
describe("a coordinate another process holds", () => {
  const holdClaim = (f: Fixture, expiresAt: string, holder = "claude/sonnet/implementer/07"): void => {
    const store = openToolClaimStore(toolClaimStorePath(f.databasePath));
    try {
      store.transact(
        deriveEventCoordinate(
          deriveInvocation(f.taskId, 1, FIXED_NOW, "a".repeat(64)),
          toolCallTransitionId(0, 0),
          0,
        ).idempotencyKey,
        () => ({
          verb: "TAKE",
          row: {
            claimId: randomUUID(),
            holder,
            claimedAt: "2026-09-04T05:00:00.000Z",
            expiresAt,
            taskId: f.taskId,
            attempt: 1,
            transitionId: toolCallTransitionId(0, 0),
            submittedAt: FIXED_NOW,
            accountId: "acct-primary",
            serverId: "docs",
            toolName: "docs.search",
            argumentBytes: 64,
          },
        }),
      );
    } finally {
      store.close();
    }
  };

  it("exits 7, spawns nothing and records nothing", async () => {
    const f = fixture();
    holdClaim(f, "2200-01-01T00:00:00.000Z");

    const result = await call(f, requestFile(f.dir, { taskId: f.taskId }), "json");

    // Its own code, and that is the whole point of it. A `2` would tell the one
    // script most likely to meet this — a wrapper retrying on a timeout — "you
    // asked wrongly", and retrying is the single response that must not follow.
    expect(result.exitCode).toBe(EXIT_CLAIM_HELD);
    expect(result.exitCode).toBe(7);
    expect(result.exitCode).not.toBe(EXIT_USAGE);
    expect(envelope(result).error.code).toBe("CLAIM_HELD");
    expect(pids(f.pidLog)).toHaveLength(0);
    expect(eventCount(f.databasePath)).toBe(1);
  });

  it("tells a loser that it lost, and not who beat it", async () => {
    const f = fixture();
    const holder = "claude/sonnet/implementer/07";
    holdClaim(f, "2200-01-01T00:00:00.000Z", holder);

    const result = await call(f, requestFile(f.dir, { taskId: f.taskId }), "json");

    expect(result.stderr).not.toContain(holder);
    expect(result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain(f.databasePath);
    expect(result.stdout).toBe("");
  });

  it("walks normally once the holder's claim has expired", async () => {
    const f = fixture();
    // Non-vacuous against the case above: the only difference is the expiry,
    // and a door that refused on the presence of any claim would fail here.
    holdClaim(f, "2000-01-01T00:00:00.000Z");

    const result = await call(f, requestFile(f.dir, { taskId: f.taskId }));

    expect(result.exitCode).toBe(EXIT_OK);
    expect(pids(f.pidLog)).toHaveLength(1);
  });

  it("leaves the claim store beside the ledger, derived and not composed", async () => {
    const f = fixture();
    await call(f, requestFile(f.dir, { taskId: f.taskId }));

    // The two doors arbitrate over one file only if both derive its path from
    // the ledger through the one producer. This is the observable half of that:
    // the verb created exactly the file `toolClaimStorePath` names.
    expect(existsSync(toolClaimStorePath(f.databasePath))).toBe(true);
  });
});
