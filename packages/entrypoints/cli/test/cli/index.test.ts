/**
 * Evidence for the read-only observation CLI.
 *
 * Every test here runs against a disposable ledger: a fresh SQLite file in a
 * temporary directory that the suite creates and removes itself. Nothing in
 * this file touches a repository path, a network, a provider CLI or a ledger
 * anyone else owns.
 *
 * The suite is organised around the four claims the CLI makes, because those
 * are exactly the claims that would be worthless as prose:
 *
 * 1. it reads and never writes;
 * 2. everything it prints satisfies `@acp/protocol`;
 * 3. it never prints the ledger path and never prints an event payload value;
 * 4. its failures are closed codes with deterministic messages and exit codes.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  EventPageResponse,
  IntegrityResult,
  LEDGER_CONTRACT_VERSION,
  LedgerStatusResponse,
  OverviewResponse,
  TaskDetailResponse,
  TaskPageResponse,
  WorkerDetailResponse,
  WorkerPageResponse,
} from "@acp/protocol";
import { openLedger } from "@acp/ledger";
import { ToolCallExecuteRequest } from "@acp/protocol";
import {
  DEFAULT_ROUTING_CONFIG,
  EVIDENCE_ABSENT,
  buildRegistry,
  estimateQuota,
  loadAccountsFile,
  loadPolicyRegistry,
} from "@acp/accounts";
import { composeSubmission } from "@acp/runtime";

import {
  EXIT_INTEGRITY,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  run,
} from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];

function disposableDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function disposableLedgerPath(): string {
  return join(disposableDirectory(), "control-plane.sqlite");
}

/** A path inside a real temporary directory where no ledger was ever created. */
function absentLedgerPath(): string {
  return join(disposableDirectory(), "absent.sqlite");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** A fixed clock, so a rendered document is a function of the ledger alone. */
const FIXED_NOW = "2026-08-27T12:00:00.000Z";

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

function json(invocation: Invocation): unknown {
  return JSON.parse(invocation.stdout);
}

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: string | null;
  };
}

function errorJson(invocation: Invocation): ErrorEnvelope {
  return JSON.parse(invocation.stderr) as ErrorEnvelope;
}

interface EventInput {
  readonly taskId?: string;
  readonly attempt?: number;
  readonly transitionId?: string;
  readonly type?: string;
  readonly fromState?: string | null;
  readonly toState?: string;
  readonly emittedBy?: string;
  readonly occurredAt?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Build a candidate event.
 *
 * The idempotency key is composed here rather than imported. `@acp/contracts`
 * is not a dependency of this package, and a test that reached for it would be
 * asserting through a package the CLI is not authorized to link.
 */
function makeEvent(input: EventInput = {}): Record<string, unknown> {
  const taskId = input.taskId ?? randomUUID();
  const attempt = input.attempt ?? 1;
  const transitionId = input.transitionId ?? "step-1";
  const occurredAt = input.occurredAt ?? "2026-08-27T10:00:00.000Z";
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId,
    attempt,
    transitionId,
    idempotencyKey: taskId + "/" + String(attempt) + "/" + transitionId,
    type: input.type ?? "TASK_DISCOVERED",
    fromState: input.fromState ?? null,
    toState: input.toState ?? "DISCOVERED",
    emittedBy: input.emittedBy ?? "kimi/k3/coordinator/01",
    occurredAt,
    recordedAt: occurredAt,
    correlationId: null,
    causationId: null,
    payload: input.payload ?? {},
  };
}

/** Create the ledger, append the given events, then close the writer. */
function seed(path: string, events: readonly Record<string, unknown>[]): void {
  const ledger = openLedger(path);
  try {
    for (const event of events) ledger.append(event);
  } finally {
    ledger.close();
  }
}

/** A migrated ledger with no events. */
function emptyLedger(): string {
  const path = disposableLedgerPath();
  seed(path, []);
  return path;
}

const COORDINATOR = "kimi/k3/coordinator/01";
const IMPLEMENTER = "kimi/k3/implementer/01";

/**
 * A ledger with two tasks: one driven to a terminal state, one just discovered.
 *
 * The identifiers are returned with it, so no test has to guess a uuid or
 * re-derive what it seeded.
 */
function populatedLedger(): {
  readonly path: string;
  readonly finishedTask: string;
  readonly openTask: string;
} {
  const path = disposableLedgerPath();
  const finishedTask = randomUUID();
  const openTask = randomUUID();

  seed(path, [
    makeEvent({ taskId: finishedTask, transitionId: "discover", toState: "DISCOVERED" }),
    makeEvent({
      taskId: finishedTask,
      transitionId: "classify",
      type: "TASK_CLASSIFIED",
      fromState: "DISCOVERED",
      toState: "DT_CLASSIFIED",
      emittedBy: COORDINATOR,
    }),
    makeEvent({
      taskId: finishedTask,
      transitionId: "cancel",
      type: "TASK_CANCELLED",
      fromState: "DT_CLASSIFIED",
      toState: "CANCELLED",
      emittedBy: IMPLEMENTER,
      payload: { reason: "superseded" },
    }),
    makeEvent({ taskId: openTask, transitionId: "discover", toState: "DISCOVERED" }),
  ]);

  return { path, finishedTask, openTask };
}

/** Every command, in the shape the read-only and leak sweeps need. */
function everyCommand(finishedTask: string): readonly (readonly string[])[] {
  return [
    ["overview"],
    ["tasks"],
    ["task", finishedTask],
    ["workers"],
    ["worker", COORDINATOR],
    ["events"],
    ["status"],
    ["integrity"],
  ];
}

/**
 * Corrupt one stored digest.
 *
 * This reaches SQLite directly, because `@acp/ledger` exists precisely to make
 * this impossible through its own API, and an integrity failure that the CLI
 * cannot be shown reacting to is an untested exit code. The driver used is the
 * Node builtin rather than `better-sqlite3`: the P1B dependency law says the
 * CLI package links no database driver, and a test fixture is not a reason to
 * widen a dependency surface.
 */
function tamperWithStoredDigest(path: string): void {
  const db = new DatabaseSync(path);
  try {
    // The table carries append-only triggers, which is why an UPDATE through
    // any driver is denied. Dropping them is the tampering: it is exactly the
    // shape of attack the hash chain exists to make visible after the fact.
    db.exec(
      "DROP TRIGGER control_plane_events_deny_update; " +
        "DROP TRIGGER control_plane_events_deny_delete;",
    );
    db.prepare("UPDATE control_plane_events SET event_sha256 = ? WHERE sequence = 2").run(
      "0".repeat(64),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Usage surface
// ---------------------------------------------------------------------------

describe("usage", () => {
  it("prints help on --help and exits zero", async () => {
    const result = await invoke(["--help"]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("acp - Agent Control Plane observation CLI");
    // V2-B4b stage 3D narrowed the banner rather than dropping the claim: the
    // read posture is still stated, and the one exception is named where a
    // reader meets it.
    expect(result.stdout).toContain("every read verb opens the ledger query-only");
    expect(result.stdout).toContain("tool-call writes one receipt");
    for (const command of [
      "overview",
      "tasks",
      "task",
      "workers",
      "worker",
      "events",
      "status",
      "integrity",
      "tool-calls",
      "tool-call",
    ]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("reports both contract versions and the schema version", async () => {
    const result = await invoke(["--version", "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(json(result)).toEqual({
      // Moved 0.1.0 → 0.2.0 by P8-8A's additive initiative routes, and on to
      // 0.5.0 as P8-8D and P8-8E-pre added routes. Moved to 0.9.0 at V2-B3a,
      // for the reason only 0.3.0 ever had before it: not a new field on an old
      // shape, but a change in what the API *is* — one route now answers with a
      // connection that stays open and expects to be resumed by header. Moved
      // again to 0.10.0 at V2-B4b stage 3C, on that same reason for the third
      // time: one write route now makes the server start a child process and
      // speak a protocol to it. To 0.11.0 at V2 X1b for one new error code, and
      // to 0.12.0 at V2-B3c for one new required field on the stream's `hello`
      // frame — every arm is a `z.strictObject`, so a reader pinned at 0.11.0
      // rejects the frame rather than ignoring the key, which is what makes it
      // a minor. Asserted as a literal on purpose: the CLI's job here is to
      // report the number a reader can pin against, and comparing it to the
      // constant it prints would assert only that the CLI can echo itself.
      apiContractVersion: "0.12.0",
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      ledgerSchemaVersion: expect.any(Number),
    });
  });

  it("requires a command", async () => {
    const result = await invoke([]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("a command is required");
  });

  it("rejects an unknown command without echoing arbitrary bytes", async () => {
    const result = await invoke(["over view", "--database", emptyLedger()]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("unknown command: over?view?");
    expect(result.stderr).not.toContain("");
  });

  it("requires --database and never guesses one", async () => {
    const result = await invoke(["status", "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(result).error.code).toBe("BAD_REQUEST");
    expect(result.stderr).toContain("--database is required");
  });

  it("rejects an unsupported format", async () => {
    const result = await invoke(["status", "--database", emptyLedger(), "--format", "yaml"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("--format must be human or json");
  });

  it("rejects an option a command does not accept", async () => {
    const result = await invoke(["status", "--database", emptyLedger(), "--state", "READY"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("not accepted by acp status");
    expect(result.stderr).toContain("--state");
  });

  it("rejects a positional argument a command does not take", async () => {
    const result = await invoke(["tasks", "extra", "--database", emptyLedger()]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("takes no positional argument");
  });

  it("rejects an unparseable argument vector", async () => {
    const result = await invoke(["--not-an-option"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("the arguments could not be parsed");
  });
});

// ---------------------------------------------------------------------------
// Read-only posture
// ---------------------------------------------------------------------------

describe("read-only posture", () => {
  it("opens the ledger query-only", async () => {
    const { path } = populatedLedger();
    const status = LedgerStatusResponse.parse(
      json(await invoke(["status", "--database", path, "--format", "json"])),
    );
    expect(status.readOnly).toBe(true);
    expect(status.pragmas.queryOnly).toBe(true);
  });

  it("leaves the ledger file untouched after every command", async () => {
    const { path, finishedTask } = populatedLedger();
    const before = statSync(path);

    for (const argv of everyCommand(finishedTask)) {
      const result = await invoke([...argv, "--database", path, "--format", "json"]);
      expect(result.exitCode).toBe(EXIT_OK);
    }

    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("refuses to open a ledger that does not exist", async () => {
    const result = await invoke(["status", "--database", absentLedgerPath(), "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(errorJson(result).error.code).toBe("LEDGER_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Leaks
// ---------------------------------------------------------------------------

describe("leaks", () => {
  it("never prints the ledger path in either format", async () => {
    const { path, finishedTask } = populatedLedger();
    const directory = dirname(path);

    for (const format of ["human", "json"]) {
      for (const argv of everyCommand(finishedTask)) {
        const result = await invoke([...argv, "--database", path, "--format", format]);
        const output = result.stdout + result.stderr;
        expect(output).not.toContain(path);
        expect(output).not.toContain(directory);
      }
    }
  });

  it("names a ledger by digest and bare label only", async () => {
    const { path } = populatedLedger();
    const status = LedgerStatusResponse.parse(
      json(await invoke(["status", "--database", path, "--format", "json"])),
    );
    expect(status.database.label).toBe("control-plane.sqlite");
    expect(status.database.pathRedacted).toBe(true);
    expect(status.database.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("publishes payload key names and sizes but never payload values", async () => {
    const { path, finishedTask } = populatedLedger();
    const page = EventPageResponse.parse(
      json(await invoke(["events", "--task", finishedTask, "--database", path, "--format", "json"])),
    );
    const cancelled = page.items.find((item) => item.type === "TASK_CANCELLED");
    expect(cancelled).toBeDefined();
    expect(cancelled?.payloadKeys).toEqual(["reason"]);
    expect(cancelled?.payloadByteSize).toBeGreaterThan(0);
    expect(JSON.stringify(page)).not.toContain("superseded");
  });

  it("does not forward a lower layer message into an error envelope", async () => {
    const missing = absentLedgerPath();
    const result = await invoke(["integrity", "--database", missing, "--format", "json"]);
    const envelope = errorJson(result);
    expect(envelope.error.message).toBe("the ledger could not be opened");
    expect(envelope.error.detail).toBe("LEDGER_OPEN");
    expect(result.stderr).not.toContain(missing);
  });
});

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

describe("overview", () => {
  it("reports EMPTY for a migrated ledger with no events", async () => {
    const result = await invoke(["overview", "--database", emptyLedger(), "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_OK);
    const overview = OverviewResponse.parse(json(result));
    expect(overview.state).toBe("EMPTY");
    expect(overview.ledger?.eventCount).toBe(0);
    expect(overview.tasks.total).toBe(0);
    expect(overview.workers.total).toBe(0);
    expect(overview.capabilities).toEqual({
      readOnly: true,
      writes: false,
      routing: false,
      accounts: false,
      leases: false,
    });
  });

  it("reports ACTIVE with counts that agree with the projections", async () => {
    const { path } = populatedLedger();
    const overview = OverviewResponse.parse(
      json(await invoke(["overview", "--database", path, "--format", "json"])),
    );
    expect(overview.state).toBe("ACTIVE");
    expect(overview.ledger?.eventCount).toBe(4);
    expect(overview.tasks.total).toBe(2);
    expect(overview.tasks.terminal).toBe(1);
    expect(overview.tasks.active).toBe(1);
    expect(overview.tasks.byState).toEqual([
      { state: "CANCELLED", count: 1 },
      { state: "DISCOVERED", count: 1 },
    ]);
    expect(overview.workers.total).toBe(2);
    expect(overview.integrity).toEqual({
      checked: true,
      ok: true,
      problemCount: 0,
      checkedAt: FIXED_NOW,
    });
  });

  it("can skip the integrity check and then publishes no verdict", async () => {
    const { path } = populatedLedger();
    const overview = OverviewResponse.parse(
      json(await invoke(["overview", "--database", path, "--skip-integrity", "--format", "json"])),
    );
    expect(overview.integrity).toEqual({
      checked: false,
      ok: null,
      problemCount: null,
      checkedAt: null,
    });
  });

  it("distinguishes an unreadable ledger from an empty one", async () => {
    const missing = absentLedgerPath();
    const result = await invoke(["overview", "--database", missing, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    const overview = OverviewResponse.parse(json(result));
    expect(overview.state).toBe("UNAVAILABLE");
    expect(overview.database).toBeNull();
    expect(overview.ledger).toBeNull();
    expect(overview.notice).toContain("LEDGER_UNAVAILABLE");
    expect(result.stdout).not.toContain(missing);
  });

  it("renders a human overview rather than a JSON document", async () => {
    const { path } = populatedLedger();
    const result = await invoke(["overview", "--database", path]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("state");
    expect(result.stdout).toContain("ACTIVE");
    expect(result.stdout).toContain("Tasks by state");
    expect(result.stdout.startsWith("{")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tasks and task
// ---------------------------------------------------------------------------

describe("tasks", () => {
  it("lists every task", async () => {
    const { path } = populatedLedger();
    const page = TaskPageResponse.parse(
      json(await invoke(["tasks", "--database", path, "--format", "json"])),
    );
    expect(page.items).toHaveLength(2);
    expect(page.page.returned).toBe(2);
    expect(page.page.hasMore).toBe(false);
    expect(page.page.nextCursor).toBeNull();
  });

  it("filters by state", async () => {
    const { path, openTask } = populatedLedger();
    const page = TaskPageResponse.parse(
      json(await invoke(["tasks", "--state", "DISCOVERED", "--database", path, "--format", "json"])),
    );
    expect(page.items.map((task) => task.taskId)).toEqual([openTask]);
  });

  it("paginates with an opaque cursor", async () => {
    const { path } = populatedLedger();
    const first = TaskPageResponse.parse(
      json(await invoke(["tasks", "--limit", "1", "--database", path, "--format", "json"])),
    );
    expect(first.items).toHaveLength(1);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).not.toBeNull();

    const second = TaskPageResponse.parse(
      json(
        await invoke([
          "tasks",
          "--limit",
          "1",
          "--cursor",
          first.page.nextCursor ?? "",
          "--database",
          path,
          "--format",
          "json",
        ]),
      ),
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.taskId).not.toBe(first.items[0]?.taskId);
    expect(second.page.hasMore).toBe(false);
  });

  it("rejects a filter the API contract would reject", async () => {
    const { path } = populatedLedger();

    const badState = await invoke(["tasks", "--state", "NOT_A_STATE", "--database", path]);
    expect(badState.exitCode).toBe(EXIT_USAGE);
    expect(badState.stderr).toContain("filters are not valid");

    // Number() would accept this. The contract's decimal grammar does not.
    const hexLimit = await invoke(["tasks", "--limit", "0x10", "--database", path]);
    expect(hexLimit.exitCode).toBe(EXIT_USAGE);

    const tooLarge = await invoke(["tasks", "--limit", "5000", "--database", path]);
    expect(tooLarge.exitCode).toBe(EXIT_USAGE);

    const badCursor = await invoke(["tasks", "--cursor", "not-a-uuid", "--database", path]);
    expect(badCursor.exitCode).toBe(EXIT_USAGE);
  });
});

describe("task", () => {
  it("returns one task with its most recent events, newest first", async () => {
    const { path, finishedTask } = populatedLedger();
    const response = TaskDetailResponse.parse(
      json(await invoke(["task", finishedTask, "--database", path, "--format", "json"])),
    );
    expect(response.task.taskId).toBe(finishedTask);
    expect(response.task.currentState).toBe("CANCELLED");
    expect(response.task.isTerminal).toBe(true);
    expect(response.task.eventCount).toBe(3);
    expect(response.task.recentEvents).toHaveLength(3);

    const sequences = response.task.recentEvents.map((item) => item.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => right - left));
    for (const item of response.task.recentEvents) {
      expect(item.taskId).toBe(finishedTask);
    }
  });

  it("exits NOT_FOUND for an unknown task", async () => {
    const { path } = populatedLedger();
    const result = await invoke(["task", randomUUID(), "--database", path, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_NOT_FOUND);
    expect(errorJson(result).error.code).toBe("NOT_FOUND");
  });

  it("rejects a task id that is not a uuid", async () => {
    const { path } = populatedLedger();
    const result = await invoke(["task", "../../etc/passwd", "--database", path]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("not a uuid");
  });

  it("requires the positional argument", async () => {
    const { path } = populatedLedger();
    const result = await invoke(["task", "--database", path]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("requires <task-id>");
  });
});

// ---------------------------------------------------------------------------
// workers and worker
// ---------------------------------------------------------------------------

describe("workers", () => {
  it("lists observed identities", async () => {
    const { path } = populatedLedger();
    const page = WorkerPageResponse.parse(
      json(await invoke(["workers", "--database", path, "--format", "json"])),
    );
    expect(page.items.map((worker) => worker.identity).sort()).toEqual(
      [COORDINATOR, IMPLEMENTER].sort(),
    );
  });

  it("filters by role and by provider", async () => {
    const { path } = populatedLedger();

    const byRole = WorkerPageResponse.parse(
      json(await invoke(["workers", "--role", "implementer", "--database", path, "--format", "json"])),
    );
    expect(byRole.items.map((worker) => worker.identity)).toEqual([IMPLEMENTER]);

    const byProvider = WorkerPageResponse.parse(
      json(await invoke(["workers", "--provider", "kimi", "--database", path, "--format", "json"])),
    );
    expect(byProvider.items).toHaveLength(2);

    const noMatch = WorkerPageResponse.parse(
      json(await invoke(["workers", "--provider", "nobody", "--database", path, "--format", "json"])),
    );
    expect(noMatch.items).toHaveLength(0);
    expect(noMatch.page.hasMore).toBe(false);
  });

  it("rejects a role the contract does not know", async () => {
    const { path } = populatedLedger();
    const result = await invoke(["workers", "--role", "auditor", "--database", path]);
    expect(result.exitCode).toBe(EXIT_USAGE);
  });
});

describe("worker", () => {
  it("returns one worker with only its own events", async () => {
    const { path } = populatedLedger();
    const response = WorkerDetailResponse.parse(
      json(await invoke(["worker", COORDINATOR, "--database", path, "--format", "json"])),
    );
    expect(response.worker.identity).toBe(COORDINATOR);
    expect(response.worker.role).toBe("coordinator");
    expect(response.worker.provider).toBe("kimi");
    expect(response.worker.recentEvents.length).toBeGreaterThan(0);
    for (const item of response.worker.recentEvents) {
      expect(item.emittedBy).toBe(COORDINATOR);
    }
  });

  it("exits NOT_FOUND for an identity that emitted nothing", async () => {
    const { path } = populatedLedger();
    const result = await invoke([
      "worker",
      "kimi/k3/reviewer/09",
      "--database",
      path,
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(EXIT_NOT_FOUND);
    expect(errorJson(result).error.code).toBe("NOT_FOUND");
  });

  it("rejects a malformed identity", async () => {
    const { path } = populatedLedger();
    const result = await invoke(["worker", "kimi/k3", "--database", path]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("<provider>/<model>/<role>/<instance>");
  });
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

describe("events", () => {
  it("lists events in sequence order", async () => {
    const { path } = populatedLedger();
    const page = EventPageResponse.parse(
      json(await invoke(["events", "--database", path, "--format", "json"])),
    );
    expect(page.items.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("filters by task, type, emitter and resulting state", async () => {
    const { path, finishedTask } = populatedLedger();

    const byTask = EventPageResponse.parse(
      json(await invoke(["events", "--task", finishedTask, "--database", path, "--format", "json"])),
    );
    expect(byTask.items).toHaveLength(3);

    const byType = EventPageResponse.parse(
      json(
        await invoke(["events", "--type", "TASK_CLASSIFIED", "--database", path, "--format", "json"]),
      ),
    );
    expect(byType.items).toHaveLength(1);

    const byEmitter = EventPageResponse.parse(
      json(
        await invoke(["events", "--emitted-by", IMPLEMENTER, "--database", path, "--format", "json"]),
      ),
    );
    expect(byEmitter.items).toHaveLength(1);
    expect(byEmitter.items.every((item) => item.emittedBy === IMPLEMENTER)).toBe(true);

    const byState = EventPageResponse.parse(
      json(await invoke(["events", "--to-state", "CANCELLED", "--database", path, "--format", "json"])),
    );
    expect(byState.items).toHaveLength(1);
  });

  it("paginates by sequence with a cursor the caller hands back unchanged", async () => {
    const { path } = populatedLedger();
    const first = EventPageResponse.parse(
      json(await invoke(["events", "--limit", "2", "--database", path, "--format", "json"])),
    );
    expect(first.items.map((item) => item.sequence)).toEqual([1, 2]);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toBe("2");

    const second = EventPageResponse.parse(
      json(
        await invoke([
          "events",
          "--limit",
          "2",
          "--cursor",
          first.page.nextCursor ?? "",
          "--database",
          path,
          "--format",
          "json",
        ]),
      ),
    );
    expect(second.items.map((item) => item.sequence)).toEqual([3, 4]);
    expect(second.page.hasMore).toBe(false);
  });

  it("carries the chain position of every event", async () => {
    const { path } = populatedLedger();
    const page = EventPageResponse.parse(
      json(await invoke(["events", "--database", path, "--format", "json"])),
    );
    for (const [index, item] of page.items.entries()) {
      expect(item.eventSha256).toMatch(/^[0-9a-f]{64}$/);
      if (index > 0) {
        expect(item.previousSha256).toBe(page.items[index - 1]?.eventSha256);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// status and integrity
// ---------------------------------------------------------------------------

describe("status", () => {
  it("reports the head, the pragmas, the migrations and the projections", async () => {
    const { path } = populatedLedger();
    const status = LedgerStatusResponse.parse(
      json(await invoke(["status", "--database", path, "--format", "json"])),
    );
    expect(status.eventCount).toBe(4);
    expect(status.headSequence).toBe(4);
    expect(status.pragmas.journalMode.toLowerCase()).toBe("wal");
    expect(status.migrations.length).toBeGreaterThan(0);
    expect(status.projections.length).toBeGreaterThan(0);
    expect(status.observedAt).toBe(FIXED_NOW);
  });

  it("reports a zero head for an empty ledger", async () => {
    const status = LedgerStatusResponse.parse(
      json(await invoke(["status", "--database", emptyLedger(), "--format", "json"])),
    );
    expect(status.eventCount).toBe(0);
    expect(status.headSequence).toBe(0);
  });
});

describe("integrity", () => {
  it("verifies a healthy ledger and exits zero", async () => {
    const { path } = populatedLedger();
    const result = await invoke(["integrity", "--database", path, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_OK);
    const report = IntegrityResult.parse(json(result));
    expect(report.ok).toBe(true);
    expect(report.checkedEvents).toBe(4);
    expect(report.problems).toHaveLength(0);
    expect(report.truncated).toBe(false);
  });

  it("renders the verdict in human form", async () => {
    const { path } = populatedLedger();
    const result = await invoke(["integrity", "--database", path]);
    expect(result.stdout).toContain("verdict");
    expect(result.stdout).toContain("ok");
  });

  it("exits with the integrity code when the stored chain is broken", async () => {
    const { path } = populatedLedger();
    tamperWithStoredDigest(path);

    const result = await invoke(["integrity", "--database", path, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    const report = IntegrityResult.parse(json(result));
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
  });

  it("reports a tampered ledger as DEGRADED rather than ACTIVE", async () => {
    const { path } = populatedLedger();
    tamperWithStoredDigest(path);

    const result = await invoke(["overview", "--database", path, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    const overview = OverviewResponse.parse(json(result));
    expect(overview.state).toBe("DEGRADED");
    expect(overview.integrity.checked).toBe(true);
    expect(overview.integrity.ok).toBe(false);
    expect(overview.notice).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// V2-B7S: the composition root, as a verb
// ---------------------------------------------------------------------------

/**
 * The CLI leg of the submission path.
 *
 * `acp submission` is the one verb that plans rather than observes, and the one
 * that opens no ledger at all. Everything asserted here is asserted about the
 * real `run()` over real files in a real temporary directory: the election is
 * driven by a policy document on disk, and the only thing that changes between
 * the two A1 runs is the bytes of that document.
 *
 * **Stated limit, and it belongs in the report as well as here.** A6 below is
 * CLI/in-process equivalence: the verb's stdout and an in-process
 * `composeSubmission` over the same inputs and the same injected instant agree.
 * There is no API leg in this repository, so nothing here is three-way
 * equivalence and nothing here should be read as such.
 */

const B7S_ACCOUNT = "acct-b7s-cli";
const B7S_TASK = "b7500000-0000-4000-8000-0000000000c1";
const B7S_INITIATIVE = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const B7S_SUBMITTED_AT = "2026-08-27T00:00:00.000Z";
const B7S_RESET = "2026-12-01T00:00:00Z";
const B7S_PROFILE_REF = "profile://acp-b7s-cli-canary";
const SHIPPED_POLICY = join(
  cliRepoRoot(),
  "packages",
  "domains",
  "accounts",
  "policy",
  "capability-policy.json",
);

function cliRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
}

/** A canonical, owner-only staging directory: the loaders admit nothing less. */
function b7sStage(): string {
  const created = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "acp-b7s-cli-")));
  chmodSync(created, 0o700);
  temporaryDirectories.push(created);
  return created;
}

function writeAccountsFile(dir: string, enabledModels: readonly string[]): string {
  const path = join(dir, "accounts.json");
  writeFileSync(
    path,
    JSON.stringify({
      contractVersion: LEDGER_CONTRACT_VERSION,
      accounts: [
        {
          contractVersion: LEDGER_CONTRACT_VERSION,
          accountId: B7S_ACCOUNT,
          provider: "claude",
          alias: B7S_ACCOUNT,
          authMode: "PREAUTHENTICATED_PROFILE",
          // A canary: this value is on the record the verb loads, and must
          // never appear in what the verb prints (N4).
          authProfileRef: B7S_PROFILE_REF,
          credentialRef: null,
          plan: "max",
          enabledModels: [...enabledModels],
          knownLimits: { weekly: 1_000_000 },
          resetSchedule: { kind: "DECLARED", nextResetAt: B7S_RESET, timezone: "UTC", confidence: "HIGH" },
          quotaEstimate: {
            remainingRatio: 0.5,
            estimatedTokensRemaining: 500_000,
            estimatedAt: "2026-08-26T00:00:00Z",
            confidence: "MEDIUM",
          },
          lastHealthProbe: null,
          lastClassifiedError: null,
          status: "AVAILABLE",
          isolatedConfigRoot: "/tmp/acp-b7s-" + B7S_ACCOUNT,
          contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
        },
      ],
    }),
  );
  chmodSync(path, 0o600);
  return path;
}

/** A daemon config carrying a deliberately stale route, for the verb to replace. */
function writeConfigDocument(dir: string, extra: Record<string, unknown> = {}): string {
  const path = join(dir, "daemon.json");
  writeFileSync(
    path,
    JSON.stringify({
      mode: "SQLITE_SUPERVISOR",
      scenarioId: "b7s-cli",
      emittedBy: "claude/opus/implementer/01",
      taskId: B7S_TASK,
      attempt: 1,
      submittedAt: B7S_SUBMITTED_AT,
      submissionDigest: "0".repeat(64),
      initiativeId: B7S_INITIATIVE,
      holdOpen: false,
      checkPorts: false,
      // A field the daemon's door knows nothing about, carried to prove the
      // verb passes the document through rather than rebuilding it.
      operatorNote: "carried through untouched",
      execution: {
        route: {
          provider: "claude",
          model: "sonnet",
          accountId: B7S_ACCOUNT,
          transportKind: "CLI_SUBSCRIPTION",
          capabilityPolicyVersion: "stale",
          resolvedAt: "2026-01-01T00:00:00.000Z",
        },
        binding: {
          binary: realpathSync(process.execPath),
          configRoot: dir,
          workdir: dir,
          limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
        },
      },
      ...extra,
    }),
  );
  chmodSync(path, 0o600);
  return path;
}

function submissionArgv(config: string, accounts: string, policy: string): readonly string[] {
  return [
    "submission",
    "--config",
    config,
    "--accounts",
    accounts,
    "--policy",
    policy,
    "--estimated-tokens",
    "10000",
    "--reserve-tokens",
    "5000",
    "--duration-seconds",
    "60",
  ];
}

/**
 * The emitted document, structurally.
 *
 * Typed here rather than through `ResolvedRoute` because the CLI depends on
 * `@acp/protocol`, `@acp/ledger`, `@acp/accounts` and `@acp/runtime` and on
 * nothing else — importing the kernel for a test-local shape would widen a
 * dependency surface the fence pins by equality.
 */
interface EmittedRoute {
  readonly provider: string;
  readonly model: string;
  readonly accountId: string;
  readonly transportKind: string;
  readonly capabilityPolicyVersion: string;
  readonly resolvedAt: string;
}

interface EmittedConfig {
  readonly submissionDigest: string;
  readonly operatorNote?: string;
  readonly execution: { readonly route: EmittedRoute; readonly binding: Record<string, unknown> };
  readonly [key: string]: unknown;
}

describe("A1 (CLI leg): the elected model follows the policy document", () => {
  it("elects a different model when only the policy bytes change", async () => {
    const dir = b7sStage();
    const accounts = writeAccountsFile(dir, ["opus", "sonnet"]);
    const config = writeConfigDocument(dir);
    const policy = join(dir, "capability-policy.json");
    copyFileSync(SHIPPED_POLICY, policy);

    const sourceBefore = createHash("sha256").update(readFileSync(SHIPPED_POLICY)).digest("hex");

    const first = await invoke(submissionArgv(config, accounts, policy));
    expect(first.exitCode).toBe(EXIT_OK);
    const firstDocument = JSON.parse(first.stdout) as EmittedConfig;
    expect(firstDocument.execution.route.model).toBe("opus");
    expect(firstDocument.execution.route.capabilityPolicyVersion).toBe("2026-08-30.1");

    // The only edit in this test. No source file, no flag and no fixture moves.
    const document = JSON.parse(readFileSync(policy, "utf8")) as {
      policyVersion: string;
      models: { model: string }[];
    };
    document.policyVersion = "2026-09-01.1";
    document.models = document.models.filter((entry) => entry.model !== "opus");
    writeFileSync(policy, JSON.stringify(document));

    const second = await invoke(submissionArgv(config, accounts, policy));
    expect(second.exitCode).toBe(EXIT_OK);
    const secondDocument = JSON.parse(second.stdout) as EmittedConfig;

    expect(secondDocument.execution.route.model).toBe("sonnet");
    expect(secondDocument.execution.route.model).not.toBe(firstDocument.execution.route.model);
    expect(secondDocument.execution.route.capabilityPolicyVersion).toBe("2026-09-01.1");
    expect(secondDocument.submissionDigest).not.toBe(firstDocument.submissionDigest);

    // The repository's shipped document was read by both runs and written by
    // neither. `model switch por política sin código`, literally.
    expect(createHash("sha256").update(readFileSync(SHIPPED_POLICY)).digest("hex")).toBe(sourceBefore);
  });

  it("replaces exactly two fields and carries the rest of the document through", async () => {
    const dir = b7sStage();
    const config = writeConfigDocument(dir);
    const before = JSON.parse(readFileSync(config, "utf8")) as EmittedConfig;
    const emitted = JSON.parse(
      (await invoke(submissionArgv(config, writeAccountsFile(dir, ["opus"]), SHIPPED_POLICY))).stdout,
    ) as EmittedConfig;

    // Changed: the route and the digest. Nothing else, including a field the
    // daemon's own door does not know about.
    expect(emitted.submissionDigest).not.toBe(before.submissionDigest);
    expect(emitted.execution.route).not.toEqual(before.execution.route);
    expect(emitted.operatorNote).toBe("carried through untouched");
    expect(emitted.execution.binding).toEqual(before.execution.binding);
    for (const key of ["mode", "scenarioId", "emittedBy", "taskId", "attempt", "submittedAt", "initiativeId", "holdOpen", "checkPorts"]) {
      expect(emitted[key]).toEqual(before[key]);
    }
    expect(Object.keys(emitted).sort()).toEqual(Object.keys(before).sort());
  });

  it("writes nothing: the config it read is byte-identical afterwards", async () => {
    const dir = b7sStage();
    const config = writeConfigDocument(dir);
    const accounts = writeAccountsFile(dir, ["opus"]);
    const digestBefore = createHash("sha256").update(readFileSync(config)).digest("hex");

    expect((await invoke(submissionArgv(config, accounts, SHIPPED_POLICY))).exitCode).toBe(EXIT_OK);

    expect(createHash("sha256").update(readFileSync(config)).digest("hex")).toBe(digestBefore);
  });
});

describe("A6: CLI and in-process composition agree", () => {
  it("produces the same digest for the same inputs and the same injected instant", async () => {
    const dir = b7sStage();
    const accounts = writeAccountsFile(dir, ["opus", "sonnet"]);
    const config = writeConfigDocument(dir);

    const emitted = JSON.parse((await invoke(submissionArgv(config, accounts, SHIPPED_POLICY))).stdout) as EmittedConfig;

    // The same election, composed in process against the same instant the CLI
    // was given. This is CLI/in-process equivalence and nothing wider: there is
    // no API leg in this repository to be a third party to it.
    const loaded = loadAccountsFile(accounts);
    if (!loaded.ok) throw new Error("the accounts fixture did not load: " + loaded.reason);
    const policy = loadPolicyRegistry(SHIPPED_POLICY);
    if (!policy.ok) throw new Error("the policy did not load: " + policy.reason);
    const records = buildRegistry(loaded.registry.accounts).accounts;

    const composed = composeSubmission(
      {
        role: "implementer",
        transportKind: "CLI_SUBSCRIPTION",
        routing: {
          records,
          estimates: records.map((record) => ({
            accountId: record.accountId,
            outcome: estimateQuota({
              record,
              observations: [],
              limitKey: Object.keys(record.knownLimits)[0] ?? "",
              now: FIXED_NOW,
            }),
          })),
          evidence: records.map((record) => ({
            accountId: record.accountId,
            acceptance: EVIDENCE_ABSENT,
            contextAffinity: EVIDENCE_ABSENT,
            capabilities: { known: false } as const,
          })),
          task: {
            model: "",
            estimatedTokens: 10_000,
            estimatedDurationSeconds: 60,
            reserveTokens: 5_000,
            requiredCapabilities: [],
          },
          config: DEFAULT_ROUTING_CONFIG,
          now: FIXED_NOW,
        },
      },
      policy.registry,
      {
        taskId: B7S_TASK,
        attempt: 1,
        submittedAt: B7S_SUBMITTED_AT,
        initiativeId: B7S_INITIATIVE,
        resolvedAt: FIXED_NOW,
      },
    );
    if (!composed.ok) throw new Error("the in-process election refused: " + composed.reason);

    expect(emitted.submissionDigest).toBe(composed.submissionDigest);
    expect(emitted.execution.route).toEqual(composed.submission.route);
  });

  it("is deterministic: two runs with the same clock are byte-identical (N8)", async () => {
    const dir = b7sStage();
    const accounts = writeAccountsFile(dir, ["opus", "sonnet"]);
    const config = writeConfigDocument(dir);
    const first = await invoke(submissionArgv(config, accounts, SHIPPED_POLICY));
    const second = await invoke(submissionArgv(config, accounts, SHIPPED_POLICY));
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).toContain(FIXED_NOW);
  });
});

describe("N4 and N5: the verb prints no credential and no absolute path from a route", () => {
  it("prints neither credentialRef nor authProfileRef, by substring", async () => {
    const dir = b7sStage();
    const invocation = await invoke(
      submissionArgv(writeConfigDocument(dir), writeAccountsFile(dir, ["opus"]), SHIPPED_POLICY),
    );
    expect(invocation.exitCode).toBe(EXIT_OK);
    expect(invocation.stdout).not.toContain("credentialRef");
    expect(invocation.stdout).not.toContain("authProfileRef");
    expect(invocation.stdout).not.toContain(B7S_PROFILE_REF);
    expect(invocation.stderr).not.toContain(B7S_PROFILE_REF);
  });

  it("puts no absolute path in the elected route, though the binding it carries has them", async () => {
    const dir = b7sStage();
    const emitted = JSON.parse(
      (await invoke(submissionArgv(writeConfigDocument(dir), writeAccountsFile(dir, ["opus"]), SHIPPED_POLICY))).stdout,
    ) as EmittedConfig;

    // The route: no path, anywhere in it.
    expect(JSON.stringify(emitted.execution.route)).not.toContain("/");
    // The binding: absolute by law, and untouched. Asserting this is what makes
    // the claim above narrow and true rather than broad and false.
    expect(JSON.stringify(emitted.execution.binding)).toContain(dir);
  });
});

describe("the verb's refusals are closed and name no value", () => {
  it("refuses a relative path by field name", async () => {
    const dir = b7sStage();
    const invocation = await invoke([
      "submission",
      "--config",
      "relative/daemon.json",
      "--accounts",
      writeAccountsFile(dir, ["opus"]),
      "--policy",
      SHIPPED_POLICY,
      "--estimated-tokens",
      "10000",
      "--reserve-tokens",
      "5000",
      "--duration-seconds",
      "60",
    ]);
    expect(invocation.exitCode).toBe(EXIT_USAGE);
    expect(invocation.stderr).toContain("--config must be an absolute path");
    expect(invocation.stderr).not.toContain("relative/daemon.json");
  });

  it("requires each budget rather than guessing one", async () => {
    const dir = b7sStage();
    const invocation = await invoke([
      "submission",
      "--config",
      writeConfigDocument(dir),
      "--accounts",
      writeAccountsFile(dir, ["opus"]),
      "--policy",
      SHIPPED_POLICY,
      "--reserve-tokens",
      "5000",
      "--duration-seconds",
      "60",
    ]);
    expect(invocation.exitCode).toBe(EXIT_USAGE);
    expect(invocation.stderr).toContain("--estimated-tokens is required");
  });

  it("refuses by the landed vocabulary when nothing can be elected (N1)", async () => {
    const dir = b7sStage();
    const invocation = await invoke(
      submissionArgv(writeConfigDocument(dir), writeAccountsFile(dir, ["haiku"]), SHIPPED_POLICY),
    );
    expect(invocation.exitCode).toBe(EXIT_USAGE);
    expect(invocation.stderr).toContain("no route could be elected");
    expect(invocation.stdout).toBe("");
  });
});

describe("N9: the existing verbs did not move", () => {
  it("still requires --database, with the same code and the same sentence", async () => {
    const invocation = await invoke(["overview", "--format", "json"]);
    expect(invocation.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(invocation).error.code).toBe("BAD_REQUEST");
    expect(errorJson(invocation).error.message).toBe("--database is required");
    expect(errorJson(invocation).error.detail).toBe(
      "the ledger is never guessed from the environment or the working directory",
    );
  });

  it("still requires --database for every observation verb", async () => {
    for (const verb of ["tasks", "workers", "events", "status", "integrity"]) {
      const invocation = await invoke([verb, "--format", "json"]);
      expect(invocation.exitCode).toBe(EXIT_USAGE);
      expect(errorJson(invocation).error.message).toBe("--database is required");
    }
  });

  it("still answers overview UNAVAILABLE rather than failing blank without a ledger", async () => {
    const invocation = await invoke(["overview", "--database", absentLedgerPath(), "--format", "json"]);
    expect(invocation.exitCode).toBe(EXIT_UNAVAILABLE);
    const parsed = OverviewResponse.safeParse(json(invocation));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.state).toBe("UNAVAILABLE");
  });

  it("does not accept the submission flags on an observation verb", async () => {
    const invocation = await invoke(["tasks", "--database", absentLedgerPath(), "--config", "/tmp/x.json"]);
    expect(invocation.exitCode).toBe(EXIT_USAGE);
    expect(invocation.stderr).toContain("not accepted by acp tasks");
  });

  it("does not require --database for the planning verb, which opens no ledger", async () => {
    const dir = b7sStage();
    const invocation = await invoke(
      submissionArgv(writeConfigDocument(dir), writeAccountsFile(dir, ["opus"]), SHIPPED_POLICY),
    );
    expect(invocation.exitCode).toBe(EXIT_OK);
    expect(invocation.stderr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The tool-call receipts read, and the narrowed read-only law (V2-B4b stage 3D)
// ---------------------------------------------------------------------------

describe("the tool-calls read verb", () => {
  /** A ledger holding one discovered task and two recorded tool calls. */
  function ledgerWithToolCalls(): { readonly path: string; readonly taskId: string } {
    const path = disposableLedgerPath();
    const taskId = randomUUID();
    const rows = [0, 1].map((callIndex) =>
      makeEvent({
        taskId,
        transitionId: "tool.0." + String(callIndex),
        type: "TOOL_CALL_RECORDED",
        // A same-state passthrough: recording that a tool ran does not move the
        // task's lifecycle, which is what the recorder itself writes.
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        emittedBy: IMPLEMENTER,
        payload: {
          accountId: "acct-primary",
          serverId: "docs",
          toolName: "docs.search",
          transport: "STDIO",
          outcome: "COMPLETED",
          refusal: null,
          argumentBytes: 12,
          resultBytes: 34,
          contentBlocks: 1,
        },
      }),
    );
    seed(path, [
      makeEvent({ taskId, transitionId: "discover", type: "TASK_DISCOVERED", emittedBy: COORDINATOR }),
      ...rows,
    ]);
    return { path, taskId };
  }

  it("prints the recorded rows with the nine scalars and no content", async () => {
    const { path, taskId } = ledgerWithToolCalls();
    const result = await invoke([
      "tool-calls", "--database", path, "--task", taskId, "--format", "json",
    ]);
    expect(result.exitCode).toBe(EXIT_OK);
    const page = json(result) as { count: number; items: Record<string, unknown>[] };
    expect(page.count).toBe(2);
    const first = page.items[0];
    if (first === undefined) throw new Error("no row");
    expect(Object.keys(first).sort()).toEqual([
      "accountId", "argumentBytes", "causedBy", "contentBlocks", "emittedBy", "eventId",
      "occurredAt", "outcome", "refusal", "resultBytes", "sequence", "serverId",
      "toolName", "transitionId", "transport",
    ]);
    expect("content" in first).toBe(false);
  });

  it("pages by sequence cursor and offers a cursor only when more exist", async () => {
    const { path, taskId } = ledgerWithToolCalls();
    const firstPage = json(
      await invoke(["tool-calls", "--database", path, "--task", taskId, "--limit", "1", "--format", "json"]),
    ) as { count: number; nextCursor: string | null };
    expect(firstPage.count).toBe(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = json(
      await invoke([
        "tool-calls", "--database", path, "--task", taskId,
        "--cursor", String(firstPage.nextCursor), "--format", "json",
      ]),
    ) as { count: number; nextCursor: string | null };
    expect(secondPage.count).toBe(1);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("requires a task, and names the verb rather than guessing one", async () => {
    const { path } = ledgerWithToolCalls();
    const result = await invoke(["tool-calls", "--database", path, "--format", "json"]);
    expect(result.exitCode).not.toBe(EXIT_OK);
    expect(errorJson(result).error.code).toBe("BAD_REQUEST");
  });
});

describe("the read-only law, narrowed and asserted rather than claimed", () => {
  /**
   * The test that keeps stage 3D's narrowed prose honest.
   *
   * The claim is no longer "this package never writes" — it is "every read verb
   * opens the ledger query-only, and exactly one named verb writes". A claim
   * about every read verb is checkable by driving every read verb and looking
   * at the ledger afterwards, which is what this does.
   */
  it("leaves the event count and the applied migrations unchanged after every read verb", async () => {
    const { path, finishedTask, openTask } = populatedLedger();
    void openTask;
    const before = openLedger(path, { readOnly: true });
    const eventsBefore = before.status().eventCount;
    const migrationsBefore = before.status().migrations.map((entry) => entry.version).sort();
    before.close();

    const reads: readonly (readonly string[])[] = [
      ["overview", "--database", path],
      ["tasks", "--database", path],
      ["task", finishedTask, "--database", path],
      ["workers", "--database", path],
      ["worker", COORDINATOR, "--database", path],
      ["events", "--database", path],
      ["status", "--database", path],
      ["integrity", "--database", path],
      ["tool-calls", "--database", path, "--task", finishedTask],
    ];
    for (const argv of reads) {
      const result = await invoke([...argv, "--format", "json"]);
      // Every read must answer; a verb that failed would prove nothing about
      // whether it writes.
      expect({ argv: argv[0], exitCode: result.exitCode }).toEqual({
        argv: argv[0],
        exitCode: EXIT_OK,
      });
    }

    const after = openLedger(path, { readOnly: true });
    expect(after.status().eventCount).toBe(eventsBefore);
    expect(after.status().migrations.map((entry) => entry.version).sort()).toEqual(migrationsBefore);
    after.close();
  });
});

describe("one request schema, parsed by both doors", () => {
  /**
   * The equivalence claim, at the level Packet D owes it.
   *
   * The CLI's `--request` document and the API's POST body are the same bytes
   * parsed by the same schema. Asserted over one fixture rather than argued:
   * a CLI-local request type would make the claim untestable, and this is the
   * assertion that would notice one appearing.
   */
  it("accepts one fixture document identically whether it came from a file or a body", () => {
    const document = {
      taskId: randomUUID(),
      attempt: 1,
      submittedAt: "2026-09-03T12:00:00.000Z",
      submissionDigest: "a".repeat(64),
      operationIndex: 0,
      callIndex: 0,
      accountId: "acct-primary",
      identity: IMPLEMENTER,
      serverId: "docs",
      toolName: "docs.search",
      arguments: { q: "acp" },
    };
    const fromFile = ToolCallExecuteRequest.safeParse(JSON.parse(JSON.stringify(document)));
    const fromBody = ToolCallExecuteRequest.safeParse(document);
    expect(fromFile.success).toBe(true);
    expect(fromBody.success).toBe(true);
    if (fromFile.success && fromBody.success) {
      expect(fromFile.data).toEqual(fromBody.data);
    }
  });
});
