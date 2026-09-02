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

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

function invoke(argv: readonly string[]): Invocation {
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
  const exitCode = run(argv, io);
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
  it("prints help on --help and exits zero", () => {
    const result = invoke(["--help"]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("acp - Agent Control Plane observation CLI (read-only)");
    for (const command of [
      "overview",
      "tasks",
      "task",
      "workers",
      "worker",
      "events",
      "status",
      "integrity",
    ]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("reports both contract versions and the schema version", () => {
    const result = invoke(["--version", "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(json(result)).toEqual({
      // Moved 0.1.0 → 0.2.0 by P8-8A's additive initiative routes, and on to
      // 0.5.0 as P8-8D and P8-8E-pre added routes. Asserted as
      // a literal on purpose: the CLI's job here is to report the number a
      // reader can pin against, and comparing it to the constant it prints
      // would assert only that the CLI can echo itself.
      apiContractVersion: "0.8.0",
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      ledgerSchemaVersion: expect.any(Number),
    });
  });

  it("requires a command", () => {
    const result = invoke([]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("a command is required");
  });

  it("rejects an unknown command without echoing arbitrary bytes", () => {
    const result = invoke(["over view", "--database", emptyLedger()]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("unknown command: over?view?");
    expect(result.stderr).not.toContain("");
  });

  it("requires --database and never guesses one", () => {
    const result = invoke(["status", "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(result).error.code).toBe("BAD_REQUEST");
    expect(result.stderr).toContain("--database is required");
  });

  it("rejects an unsupported format", () => {
    const result = invoke(["status", "--database", emptyLedger(), "--format", "yaml"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("--format must be human or json");
  });

  it("rejects an option a command does not accept", () => {
    const result = invoke(["status", "--database", emptyLedger(), "--state", "READY"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("not accepted by acp status");
    expect(result.stderr).toContain("--state");
  });

  it("rejects a positional argument a command does not take", () => {
    const result = invoke(["tasks", "extra", "--database", emptyLedger()]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("takes no positional argument");
  });

  it("rejects an unparseable argument vector", () => {
    const result = invoke(["--not-an-option"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("the arguments could not be parsed");
  });
});

// ---------------------------------------------------------------------------
// Read-only posture
// ---------------------------------------------------------------------------

describe("read-only posture", () => {
  it("opens the ledger query-only", () => {
    const { path } = populatedLedger();
    const status = LedgerStatusResponse.parse(
      json(invoke(["status", "--database", path, "--format", "json"])),
    );
    expect(status.readOnly).toBe(true);
    expect(status.pragmas.queryOnly).toBe(true);
  });

  it("leaves the ledger file untouched after every command", () => {
    const { path, finishedTask } = populatedLedger();
    const before = statSync(path);

    for (const argv of everyCommand(finishedTask)) {
      const result = invoke([...argv, "--database", path, "--format", "json"]);
      expect(result.exitCode).toBe(EXIT_OK);
    }

    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("refuses to open a ledger that does not exist", () => {
    const result = invoke(["status", "--database", absentLedgerPath(), "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(errorJson(result).error.code).toBe("LEDGER_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Leaks
// ---------------------------------------------------------------------------

describe("leaks", () => {
  it("never prints the ledger path in either format", () => {
    const { path, finishedTask } = populatedLedger();
    const directory = dirname(path);

    for (const format of ["human", "json"]) {
      for (const argv of everyCommand(finishedTask)) {
        const result = invoke([...argv, "--database", path, "--format", format]);
        const output = result.stdout + result.stderr;
        expect(output).not.toContain(path);
        expect(output).not.toContain(directory);
      }
    }
  });

  it("names a ledger by digest and bare label only", () => {
    const { path } = populatedLedger();
    const status = LedgerStatusResponse.parse(
      json(invoke(["status", "--database", path, "--format", "json"])),
    );
    expect(status.database.label).toBe("control-plane.sqlite");
    expect(status.database.pathRedacted).toBe(true);
    expect(status.database.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("publishes payload key names and sizes but never payload values", () => {
    const { path, finishedTask } = populatedLedger();
    const page = EventPageResponse.parse(
      json(invoke(["events", "--task", finishedTask, "--database", path, "--format", "json"])),
    );
    const cancelled = page.items.find((item) => item.type === "TASK_CANCELLED");
    expect(cancelled).toBeDefined();
    expect(cancelled?.payloadKeys).toEqual(["reason"]);
    expect(cancelled?.payloadByteSize).toBeGreaterThan(0);
    expect(JSON.stringify(page)).not.toContain("superseded");
  });

  it("does not forward a lower layer message into an error envelope", () => {
    const missing = absentLedgerPath();
    const result = invoke(["integrity", "--database", missing, "--format", "json"]);
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
  it("reports EMPTY for a migrated ledger with no events", () => {
    const result = invoke(["overview", "--database", emptyLedger(), "--format", "json"]);
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

  it("reports ACTIVE with counts that agree with the projections", () => {
    const { path } = populatedLedger();
    const overview = OverviewResponse.parse(
      json(invoke(["overview", "--database", path, "--format", "json"])),
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

  it("can skip the integrity check and then publishes no verdict", () => {
    const { path } = populatedLedger();
    const overview = OverviewResponse.parse(
      json(invoke(["overview", "--database", path, "--skip-integrity", "--format", "json"])),
    );
    expect(overview.integrity).toEqual({
      checked: false,
      ok: null,
      problemCount: null,
      checkedAt: null,
    });
  });

  it("distinguishes an unreadable ledger from an empty one", () => {
    const missing = absentLedgerPath();
    const result = invoke(["overview", "--database", missing, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    const overview = OverviewResponse.parse(json(result));
    expect(overview.state).toBe("UNAVAILABLE");
    expect(overview.database).toBeNull();
    expect(overview.ledger).toBeNull();
    expect(overview.notice).toContain("LEDGER_UNAVAILABLE");
    expect(result.stdout).not.toContain(missing);
  });

  it("renders a human overview rather than a JSON document", () => {
    const { path } = populatedLedger();
    const result = invoke(["overview", "--database", path]);
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
  it("lists every task", () => {
    const { path } = populatedLedger();
    const page = TaskPageResponse.parse(
      json(invoke(["tasks", "--database", path, "--format", "json"])),
    );
    expect(page.items).toHaveLength(2);
    expect(page.page.returned).toBe(2);
    expect(page.page.hasMore).toBe(false);
    expect(page.page.nextCursor).toBeNull();
  });

  it("filters by state", () => {
    const { path, openTask } = populatedLedger();
    const page = TaskPageResponse.parse(
      json(invoke(["tasks", "--state", "DISCOVERED", "--database", path, "--format", "json"])),
    );
    expect(page.items.map((task) => task.taskId)).toEqual([openTask]);
  });

  it("paginates with an opaque cursor", () => {
    const { path } = populatedLedger();
    const first = TaskPageResponse.parse(
      json(invoke(["tasks", "--limit", "1", "--database", path, "--format", "json"])),
    );
    expect(first.items).toHaveLength(1);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).not.toBeNull();

    const second = TaskPageResponse.parse(
      json(
        invoke([
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

  it("rejects a filter the API contract would reject", () => {
    const { path } = populatedLedger();

    const badState = invoke(["tasks", "--state", "NOT_A_STATE", "--database", path]);
    expect(badState.exitCode).toBe(EXIT_USAGE);
    expect(badState.stderr).toContain("filters are not valid");

    // Number() would accept this. The contract's decimal grammar does not.
    const hexLimit = invoke(["tasks", "--limit", "0x10", "--database", path]);
    expect(hexLimit.exitCode).toBe(EXIT_USAGE);

    const tooLarge = invoke(["tasks", "--limit", "5000", "--database", path]);
    expect(tooLarge.exitCode).toBe(EXIT_USAGE);

    const badCursor = invoke(["tasks", "--cursor", "not-a-uuid", "--database", path]);
    expect(badCursor.exitCode).toBe(EXIT_USAGE);
  });
});

describe("task", () => {
  it("returns one task with its most recent events, newest first", () => {
    const { path, finishedTask } = populatedLedger();
    const response = TaskDetailResponse.parse(
      json(invoke(["task", finishedTask, "--database", path, "--format", "json"])),
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

  it("exits NOT_FOUND for an unknown task", () => {
    const { path } = populatedLedger();
    const result = invoke(["task", randomUUID(), "--database", path, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_NOT_FOUND);
    expect(errorJson(result).error.code).toBe("NOT_FOUND");
  });

  it("rejects a task id that is not a uuid", () => {
    const { path } = populatedLedger();
    const result = invoke(["task", "../../etc/passwd", "--database", path]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("not a uuid");
  });

  it("requires the positional argument", () => {
    const { path } = populatedLedger();
    const result = invoke(["task", "--database", path]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("requires <task-id>");
  });
});

// ---------------------------------------------------------------------------
// workers and worker
// ---------------------------------------------------------------------------

describe("workers", () => {
  it("lists observed identities", () => {
    const { path } = populatedLedger();
    const page = WorkerPageResponse.parse(
      json(invoke(["workers", "--database", path, "--format", "json"])),
    );
    expect(page.items.map((worker) => worker.identity).sort()).toEqual(
      [COORDINATOR, IMPLEMENTER].sort(),
    );
  });

  it("filters by role and by provider", () => {
    const { path } = populatedLedger();

    const byRole = WorkerPageResponse.parse(
      json(invoke(["workers", "--role", "implementer", "--database", path, "--format", "json"])),
    );
    expect(byRole.items.map((worker) => worker.identity)).toEqual([IMPLEMENTER]);

    const byProvider = WorkerPageResponse.parse(
      json(invoke(["workers", "--provider", "kimi", "--database", path, "--format", "json"])),
    );
    expect(byProvider.items).toHaveLength(2);

    const noMatch = WorkerPageResponse.parse(
      json(invoke(["workers", "--provider", "nobody", "--database", path, "--format", "json"])),
    );
    expect(noMatch.items).toHaveLength(0);
    expect(noMatch.page.hasMore).toBe(false);
  });

  it("rejects a role the contract does not know", () => {
    const { path } = populatedLedger();
    const result = invoke(["workers", "--role", "auditor", "--database", path]);
    expect(result.exitCode).toBe(EXIT_USAGE);
  });
});

describe("worker", () => {
  it("returns one worker with only its own events", () => {
    const { path } = populatedLedger();
    const response = WorkerDetailResponse.parse(
      json(invoke(["worker", COORDINATOR, "--database", path, "--format", "json"])),
    );
    expect(response.worker.identity).toBe(COORDINATOR);
    expect(response.worker.role).toBe("coordinator");
    expect(response.worker.provider).toBe("kimi");
    expect(response.worker.recentEvents.length).toBeGreaterThan(0);
    for (const item of response.worker.recentEvents) {
      expect(item.emittedBy).toBe(COORDINATOR);
    }
  });

  it("exits NOT_FOUND for an identity that emitted nothing", () => {
    const { path } = populatedLedger();
    const result = invoke([
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

  it("rejects a malformed identity", () => {
    const { path } = populatedLedger();
    const result = invoke(["worker", "kimi/k3", "--database", path]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("<provider>/<model>/<role>/<instance>");
  });
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

describe("events", () => {
  it("lists events in sequence order", () => {
    const { path } = populatedLedger();
    const page = EventPageResponse.parse(
      json(invoke(["events", "--database", path, "--format", "json"])),
    );
    expect(page.items.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("filters by task, type, emitter and resulting state", () => {
    const { path, finishedTask } = populatedLedger();

    const byTask = EventPageResponse.parse(
      json(invoke(["events", "--task", finishedTask, "--database", path, "--format", "json"])),
    );
    expect(byTask.items).toHaveLength(3);

    const byType = EventPageResponse.parse(
      json(
        invoke(["events", "--type", "TASK_CLASSIFIED", "--database", path, "--format", "json"]),
      ),
    );
    expect(byType.items).toHaveLength(1);

    const byEmitter = EventPageResponse.parse(
      json(
        invoke(["events", "--emitted-by", IMPLEMENTER, "--database", path, "--format", "json"]),
      ),
    );
    expect(byEmitter.items).toHaveLength(1);
    expect(byEmitter.items.every((item) => item.emittedBy === IMPLEMENTER)).toBe(true);

    const byState = EventPageResponse.parse(
      json(invoke(["events", "--to-state", "CANCELLED", "--database", path, "--format", "json"])),
    );
    expect(byState.items).toHaveLength(1);
  });

  it("paginates by sequence with a cursor the caller hands back unchanged", () => {
    const { path } = populatedLedger();
    const first = EventPageResponse.parse(
      json(invoke(["events", "--limit", "2", "--database", path, "--format", "json"])),
    );
    expect(first.items.map((item) => item.sequence)).toEqual([1, 2]);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toBe("2");

    const second = EventPageResponse.parse(
      json(
        invoke([
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

  it("carries the chain position of every event", () => {
    const { path } = populatedLedger();
    const page = EventPageResponse.parse(
      json(invoke(["events", "--database", path, "--format", "json"])),
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
  it("reports the head, the pragmas, the migrations and the projections", () => {
    const { path } = populatedLedger();
    const status = LedgerStatusResponse.parse(
      json(invoke(["status", "--database", path, "--format", "json"])),
    );
    expect(status.eventCount).toBe(4);
    expect(status.headSequence).toBe(4);
    expect(status.pragmas.journalMode.toLowerCase()).toBe("wal");
    expect(status.migrations.length).toBeGreaterThan(0);
    expect(status.projections.length).toBeGreaterThan(0);
    expect(status.observedAt).toBe(FIXED_NOW);
  });

  it("reports a zero head for an empty ledger", () => {
    const status = LedgerStatusResponse.parse(
      json(invoke(["status", "--database", emptyLedger(), "--format", "json"])),
    );
    expect(status.eventCount).toBe(0);
    expect(status.headSequence).toBe(0);
  });
});

describe("integrity", () => {
  it("verifies a healthy ledger and exits zero", () => {
    const { path } = populatedLedger();
    const result = invoke(["integrity", "--database", path, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_OK);
    const report = IntegrityResult.parse(json(result));
    expect(report.ok).toBe(true);
    expect(report.checkedEvents).toBe(4);
    expect(report.problems).toHaveLength(0);
    expect(report.truncated).toBe(false);
  });

  it("renders the verdict in human form", () => {
    const { path } = populatedLedger();
    const result = invoke(["integrity", "--database", path]);
    expect(result.stdout).toContain("verdict");
    expect(result.stdout).toContain("ok");
  });

  it("exits with the integrity code when the stored chain is broken", () => {
    const { path } = populatedLedger();
    tamperWithStoredDigest(path);

    const result = invoke(["integrity", "--database", path, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    const report = IntegrityResult.parse(json(result));
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
  });

  it("reports a tampered ledger as DEGRADED rather than ACTIVE", () => {
    const { path } = populatedLedger();
    tamperWithStoredDigest(path);

    const result = invoke(["overview", "--database", path, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    const overview = OverviewResponse.parse(json(result));
    expect(overview.state).toBe("DEGRADED");
    expect(overview.integrity.checked).toBe(true);
    expect(overview.integrity.ok).toBe(false);
    expect(overview.notice).not.toBeNull();
  });
});
