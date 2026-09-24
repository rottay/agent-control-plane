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
  API_ERROR_CODES,
  API_ROUTES,
  API_WRITE_ROUTES,
  type ApiErrorCode,
  EventPageResponse,
  IntegrityResult,
  LEDGER_CONTRACT_VERSION,
  LedgerStatusResponse,
  OverviewResponse,
  SURFACE_MAP,
  TaskDetailResponse,
  TaskPageResponse,
  WorkerDetailResponse,
  WorkerPageResponse,
  surfaceDefects,
} from "@acp/protocol";
import { LEDGER_MIGRATIONS, canonicalJsonStringify, openLedger, sha256Hex } from "@acp/ledger";
import { ToolCallExecuteRequest } from "@acp/protocol";
import {
  DEFAULT_ROUTING_CONFIG,
  EVIDENCE_ABSENT,
  buildRegistry,
  estimateQuota,
  foldEffectiveState,
  loadAccountsFile,
  loadPolicyRegistry,
} from "@acp/accounts";
import {
  LIFECYCLE_PLAN,
  buildEvent,
  canonicalSubmissionDigest,
  composeSubmission,
  deriveInvocation,
  planStep,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";

import {
  CLI_COMMAND_NAMES,
  EXIT_CLAIM_HELD,
  EXIT_INTEGRITY,
  EXIT_INTERNAL,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  run,
} from "../../src/cli/index.js";
import type { CliIo, CliSeams } from "../../src/cli/index.js";
import { LifecycleRefused } from "../../src/lifecycle/index.js";

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

/**
 * The command names the usage banner actually prints, sorted.
 *
 * Read out of the `Commands:` block rather than searched for anywhere in the
 * output: a name that appears in a filter description or an example is not the
 * banner offering that command.
 */
function bannerCommandNames(stdout: string): readonly string[] {
  const lines = stdout.split("\n");
  const start = lines.indexOf("Commands:");
  const names: string[] = [];
  for (let index = start + 1; index < lines.length && start !== -1; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      break;
    }
    names.push(line.trim().split(/\s+/)[0] ?? "");
  }
  return names.sort();
}

describe("usage", () => {
  it("prints help on --help and exits zero", async () => {
    const result = await invoke(["--help"]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("acp - Agent Control Plane observation CLI");
    // V2-B4b stage 3D narrowed the banner rather than dropping the claim: the
    // read posture is still stated, and the exceptions are named where a reader
    // meets them. V2 L2 added the second exception and widened the sentence to
    // say so — a banner that still claimed one writing verb would be the exact
    // staleness stage 3D fixed by narrowing it.
    expect(result.stdout).toContain("every read verb opens the ledger query-only");
    expect(result.stdout).toContain("tool-call writes one receipt");
    expect(result.stdout).toContain("cancel settles one cancellation");
    // And the closing paragraph no longer claims the CLI never writes. P-14/B
    // added the fourth writing verb, P-14/C the fifth and P-15/R the sixth, and
    // the sentence counts them.
    expect(result.stdout).toContain("Six verbs write, and they");
    expect(result.stdout).toContain("`initiative` registers one initiative");
    expect(result.stdout).toContain("`intake` enters one task");
    expect(result.stdout).toContain("`registry` publishes one registry version");
    expect(result.stdout).not.toContain("This CLI opens the ledger read-only and never writes");
    // Old-V2 R1, F7. This was a `toContain` sweep over twelve of the fourteen
    // names, against the whole of stdout: `task` was satisfied by the word
    // `tasks`, `submission` and `switch-decision` were absent from the list
    // entirely, and a command that stopped being printed could still pass so
    // long as its letters appeared somewhere. Replaced by set equality between
    // the command column the banner prints and the names `COMMANDS` declares,
    // so the two can neither diverge nor be quietly reduced.
    expect(bannerCommandNames(result.stdout)).toEqual([...CLI_COMMAND_NAMES].sort());
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
      // a minor. To 0.13.0 at V2 L3 for a fourth write route and two error
      // codes, and to 0.14.0 at P-10/id-B for one more required field on the
      // same `hello` — `instance`, which ledger FILE this is — for exactly the
      // strictness reason 0.12.0 moved. To 0.15.0 at P-08/B for one more
      // required field, this time on the integrity result: `coverage`, which
      // says from when each stream's chain is evidence. Same strictness reason
      // again — `IntegrityResult` is a `z.strictObject`, so a reader pinned at
      // 0.14.0 rejects the result rather than ignoring the key. To 0.16.0 at
      // P-14/B for a fifth write route, `initiatives` POST, which this CLI
      // answers too as `acp initiative`, and to 0.17.0 at P-14/C for a sixth,
      // `tasks` POST, which it answers as `acp intake`.
      // Asserted as a literal on purpose: the CLI's job here is to
      // report the number a reader can pin against, and comparing it to the
      // constant it prints would assert only that the CLI can echo itself.
      apiContractVersion: "0.20.0",
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

// ---------------------------------------------------------------------------
// The CLI half of the surface map (old-V2 R1)
// ---------------------------------------------------------------------------
//
// The map itself lives in `@acp/protocol`, which cannot see `COMMANDS`; the
// protocol suite therefore checks it with `commands: null` and the CLI half is
// checked here, where both tables are visible at once. Every probe mutates the
// **input**, so each one proves the checker read the table it was handed rather
// than a list it remembered.

describe("the surface map names every command this CLI has", () => {
  it("finds no defect with both halves in view", () => {
    expect(
      surfaceDefects({
        entries: SURFACE_MAP,
        routes: API_ROUTES,
        writeRoutes: API_WRITE_ROUTES,
        commands: CLI_COMMAND_NAMES,
      }),
    ).toEqual([]);
  });

  it("names a command the map has left out", () => {
    // F6, and the direction nothing in this repository had: `submission` and
    // `switch-decision` were absent from the old banner sweep, and no test
    // anywhere noticed that the CLI had two verbs the documentation did not.
    const withoutDecision = SURFACE_MAP.filter(
      (entry) => entry.command !== "switch-decision",
    );
    const found = surfaceDefects({
      entries: withoutDecision,
      routes: API_ROUTES,
      writeRoutes: API_WRITE_ROUTES,
      commands: CLI_COMMAND_NAMES,
    });
    expect(found.some((sentence) => sentence.includes("switch-decision"))).toBe(true);
  });

  it("names a command the injected list declares and the map has never seen", () => {
    // F7's probe, in the form a test can run: adding a command to `COMMANDS`
    // adds it to `CLI_COMMAND_NAMES`, which is derived rather than restated, so
    // the banner assertion follows it automatically and this assertion is the
    // one that goes red until the map admits the new verb.
    const found = surfaceDefects({
      entries: SURFACE_MAP,
      routes: API_ROUTES,
      writeRoutes: API_WRITE_ROUTES,
      commands: [...CLI_COMMAND_NAMES, "reconcile"],
    });
    expect(found.some((sentence) => sentence.includes("reconcile"))).toBe(true);
  });

  it("names a mapped command this CLI does not have", () => {
    // F2, the CLI direction: `accounts` is a plausible verb — the route exists
    // and the owner file is real — and it is not a command.
    const invented = [
      ...SURFACE_MAP,
      {
        command: "accounts",
        route: "accounts",
        method: "GET",
        equivalence: "PROJECTION",
      } as (typeof SURFACE_MAP)[number],
    ];
    const found = surfaceDefects({
      entries: invented,
      routes: API_ROUTES,
      writeRoutes: API_WRITE_ROUTES,
      commands: CLI_COMMAND_NAMES,
    });
    expect(found.some((sentence) => sentence.includes("accounts"))).toBe(true);
  });

  it("derives the command names rather than restating them", () => {
    // The names are `COMMANDS.map(c => c.name)`, so the banner, the map check
    // and this assertion cannot disagree about what the CLI offers.
    expect(new Set(CLI_COMMAND_NAMES).size).toBe(CLI_COMMAND_NAMES.length);
    for (const name of CLI_COMMAND_NAMES) {
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

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

    // Which file, beside which path (P-10/id-B). Crosses the CLI's own mapper.
    expect(status.instance.instanceId).not.toBeNull();
    expect(status.instance.restoreId).not.toBeNull();
    expect(status.instance.restoreEpoch).toBe(0);

    // The vector crosses the CLI's own mapper (P-09/log-D). Every projection
    // carries at least one head, and the two-source one carries both.
    for (const projection of status.projections) {
      expect(projection.watermarks.length, projection.name).toBeGreaterThan(0);
    }
    const routing = status.projections.find(
      (projection) => projection.name === "routing_assignment_read_model",
    );
    expect(routing?.watermarks.map((watermark) => watermark.sourceStream)).toEqual([
      "initiative_events",
      "registry_events",
    ]);
  });

  it("renders one text row per projection and stream, not one per projection", async () => {
    // The text render is where a lost mapping hides. JSON parity compares the
    // parsed body and would not notice a table that silently dropped a head,
    // and until now nothing exercised `renderStatus` at all.
    //
    // End to end through the real command, so the ledger's grouping, the CLI's
    // mapper and the table all take part: a projection with two heads must
    // produce two rows, each carrying its own stream.
    const { path } = populatedLedger();
    // `human` is the terminal render; the CLI has exactly two formats and the
    // other one is `json`, which the parity tests already cover.
    const result = await invoke(["status", "--database", path, "--format", "human"]);
    expect(result.exitCode).toBe(0);

    const rows = result.stdout
      .split("\n")
      .filter((line) => line.includes("routing_assignment_read_model"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("initiative_events");
    expect(rows[1]).toContain("registry_events");
    expect(result.stdout).toContain("STREAM");

    // Every other projection has one head and so exactly one row.
    for (const name of ["task_read_model", "worker_read_model", "initiative_read_model"]) {
      expect(
        result.stdout.split("\n").filter((line) => line.includes(name)),
        name,
      ).toHaveLength(1);
    }
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

  it("prints coverage on a clean run, and prints the kind verbatim", async () => {
    // Coverage prints even when nothing is wrong, which is the whole point:
    // "no problems" answers whether the evidence holds, coverage answers how
    // far back there is any, and a reader who only ever saw the second when
    // something had already gone wrong would learn the difference too late.
    const { path } = populatedLedger();
    const result = await invoke(["integrity", "--database", path]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("Coverage");
    expect(result.stdout).not.toContain("Problems");

    // Verbatim, not prettified. The literal is asserted rather than derived:
    // this is a closed wire vocabulary a reader greps for, and the word on the
    // screen and the word in the JSON must be one string.
    expect(result.stdout).toContain("BASELINED_AT_ACTIVATION");
    expect(result.stdout).toContain("CHAIN_FROM_APPEND");
    expect(result.stdout).not.toContain("Baselined at activation");

    // The account row carries its provenance in the same line: where the
    // baseline was taken, and when the chain behind it was computed. Without
    // both, "covered from sequence 1" is a claim with nothing behind it.
    const accounts = result.stdout
      .split("\n")
      .find((line) => line.includes("account_events") && line.includes("BASELINED"));
    expect(accounts).toBeDefined();
    const report = IntegrityResult.parse(
      json(await invoke(["integrity", "--database", path, "--format", "json"])),
    );
    const entry = report.coverage.find((candidate) => candidate.sourceStream === "account_events");
    expect(entry?.integrityActivatedAt).not.toBeNull();
    expect(accounts).toContain(entry?.integrityActivatedAt ?? "unreachable");
    expect(accounts).toContain(String(entry?.baselineSequence ?? "unreachable"));

    // And the report is four streams, in stream order, every one of them named.
    expect(report.coverage.map((candidate) => candidate.sourceStream)).toEqual([
      "account_events",
      "control_plane_events",
      "initiative_events",
      "registry_events",
    ]);
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

  it("exits with the integrity code, not the internal one, when the account stream is shorter than its baseline", async () => {
    // The CLI twin of the gateway's "still answers 200 with the findings".
    //
    // A baseline of 3 against a cut that reaches 2 is what a ledger reports
    // after somebody dropped the append-only triggers and deleted the last
    // account row. `EXIT_INTEGRITY` is the CLI saying "I checked and it is
    // broken"; `EXIT_INTERNAL` would be the CLI saying "I could not check",
    // and those are different facts. A contract that refused the pair as a
    // malformed shape would turn the first into the second — the verb would
    // compute an accurate report and then die serializing it.
    const path = emptyLedger();
    const ledger = openLedger(path);
    for (const version of [1, 2, 3]) {
      ledger.appendAccountAction({
        contractVersion: LEDGER_CONTRACT_VERSION,
        eventId: randomUUID(),
        accountId: B7S_ACCOUNT,
        version,
        idempotencyKey: B7S_ACCOUNT + "/1/action." + String(version),
        action: version % 2 === 1 ? "DRAIN" : "ACCOUNT_READY",
        resultingState: version % 2 === 1 ? "DRAINING" : "AVAILABLE",
        actor: B1E_ACTOR,
        note: null,
        occurredAt: "2026-08-27T00:00:00.000Z",
        recordedAt: "2026-08-27T00:00:00.000Z",
      });
    }
    // One registry document, so the rebuild of migration 15 has a row and a
    // chain to conserve when the reopen re-applies it (N-P36A-16), and migration
    // 17 has a model version to fold when it is re-applied (N-P14A-15). Its
    // payload is the fixed shape the door holds a MODEL_VERSION to since P-14 A,
    // where it used to be `{}`.
    const rewindModelPayload = {
      provider: "claude",
      model: "claude-opus-5",
      release: "2026-06-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["implementer"],
      transports: ["CLI_SUBSCRIPTION"],
    };
    ledger.appendRegistryEvent({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: randomUUID(),
      idempotencyKey: "mv-rewind/1",
      documentKind: "MODEL_VERSION",
      documentId: "mv-rewind",
      documentVersion: 1,
      parentDocumentVersion: null,
      // The payload's own digest, which the registry door verifies (P-15/R, ADR 0104).
      contentDigest: sha256Hex(canonicalJsonStringify(rewindModelPayload)),
      recordedBy: B1E_ACTOR,
      effectiveFrom: "2026-08-27T00:00:00.000Z",
      occurredAt: "2026-08-27T00:00:00.000Z",
      recordedAt: "2026-08-27T00:00:00.000Z",
      payload: rewindModelPayload,
    });
    // And one price catalog version naming that model version, so migration 21
    // has intervals to fold back when it is re-applied (N-P33A-12). Its payload is
    // the closed shape the door holds a PRICE_TABLE to since P-33/catálogo A.
    const rewindCatalogPayload = {
      intervals: [
        {
          provider: "claude",
          modelVersionId: "mv-rewind",
          transportKind: "CLI_SUBSCRIPTION",
          tokenClass: "input",
          currency: "USD",
          effectiveFrom: "2026-08-01T00:00:00.000Z",
          effectiveTo: null,
          pricePerMillionNanos: 15000000000,
        },
        {
          provider: "claude",
          modelVersionId: "mv-rewind",
          transportKind: "CLI_SUBSCRIPTION",
          tokenClass: "output",
          currency: "USD",
          effectiveFrom: "2026-08-01T00:00:00.000Z",
          effectiveTo: null,
          pricePerMillionNanos: 75000000000,
        },
      ],
    };
    ledger.appendRegistryEvent({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: randomUUID(),
      idempotencyKey: "catalog-rewind/1",
      documentKind: "PRICE_TABLE",
      documentId: "catalog-rewind",
      documentVersion: 1,
      parentDocumentVersion: null,
      // The payload's own digest, which the registry door verifies (P-15/R, ADR 0104).
      contentDigest: sha256Hex(canonicalJsonStringify(rewindCatalogPayload)),
      recordedBy: B1E_ACTOR,
      effectiveFrom: "2026-08-27T00:00:00.000Z",
      occurredAt: "2026-08-27T00:00:00.000Z",
      recordedAt: "2026-08-27T00:00:00.000Z",
      payload: rewindCatalogPayload,
    });
    // And one registration in the closed payload the initiative door records, so
    // migration 18 has title and digest to fold back when it is re-applied
    // (N-P14B-8). The reference is not resolved at append: the stream records
    // what the door published, and this fixture publishes nothing.
    ledger.appendInitiativeEvent({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: randomUUID(),
      initiativeId: REWIND_INITIATIVE,
      transitionId: "register",
      idempotencyKey: REWIND_INITIATIVE + "/1/register",
      type: "INITIATIVE_REGISTERED",
      fromStatus: null,
      toStatus: "ACTIVE",
      emittedBy: B1E_ACTOR,
      occurredAt: "2026-08-27T00:00:00.000Z",
      recordedAt: "2026-08-27T00:00:00.000Z",
      payload: {
        slug: "acp-rewind",
        title: "The rewind initiative",
        objectiveSha256: "2".repeat(64),
        objectiveArtifactReferenceId: "objective-rewind",
      },
    });
    ledger.close();

    // Rewind past migration 10 and reopen, so the sidecar activates over a
    // stream that already holds three rows. A ledger created empty and then
    // grown has a baseline of 0, and 0 is never ahead of anything.
    //
    // Rewinding to before 10 means undoing 11, 12, 13, 14, 15, 16, 17, 18 and 19 as well, because
    // the reopen re-applies everything the row set no longer claims. `ALTER TABLE
    // ... ADD COLUMN` is not idempotent, so a re-applied 11 over a schema that
    // still carries the coordinate aborts on "duplicate column name". The order
    // is forced rather than stylistic, twice over: SQLite refuses `DROP COLUMN`
    // for a column a trigger references, so the coordinate trigger goes before
    // the columns; and `foreign_keys` is ON, so each child goes before the
    // parent it names — migration 14's answers, then its prompts, then
    // migration 13's deliveries, then its effects, then its segments, then
    // migration 12's attempt table, then the revision table.
    //
    // Migration 15 goes first, and it is a reconstruction, not a drop (P-36/local
    // A, M-8 and D-3): its four artifact tables name `registry_events` by a
    // foreign key, so they go before the stream is touched; then the stream is
    // rebuilt back into migration 9's shape by the same procedure that rebuilt
    // it forward, and trips on the same rename — the two triggers on OTHER
    // tables that name it are dropped before the rename and recreated from
    // migration 9's own text after it. The copy leaves `subject_kind` and
    // `artifact_event_kind` behind, which is lawful because this ledger holds no
    // artifact event at all.
    //
    // Migration 16 goes before 15, and in the order SQLite forces (P-36/local D,
    // M-7): its trigger names `envelope_artifact_reference_id`, and `DROP COLUMN`
    // is refused for a column a trigger references, so the trigger goes first and
    // the column after it. The revision table is dropped further down in any
    // case; undoing 16 by name keeps the rewind an exact reverse of the set, so a
    // later escalón that stops short of 11 inherits a rewind that still works.
    //
    // Migration 17 goes before 16 (P-14 A, H-3): its two children name the model
    // version table by a foreign key, so they go first, each unique index before
    // its table, and its one watermark row with them. Nothing in `registry_events`
    // moves; the re-applied 17 folds the document again.
    //
    // Migration 18 goes before 17 (P-14 B): its three columns are `ADD COLUMN`s,
    // which a re-applied 18 aborts on, so they are dropped by name. Nothing in
    // `initiative_events` moves; the re-applied 18 folds the registration again.
    //
    // Migration 19 goes before 18 (P-14 C): its table and its one watermark row,
    // or the re-applied 19 aborts on a table that already exists. This fixture
    // holds no intake — an intake names a registered TASK_ENVELOPE reference,
    // which is an artifact event, and 15's reverse rebuild above requires a
    // stream with none — so the re-applied 19 folds no row; the retroactive fold
    // over a real intake is the ledger suite's.
    //
    // Migration 20 goes before 19 (P-32/captura B, H-10): its five tables, children
    // first because `ON DELETE RESTRICT` fires at once, each index before its
    // table, and its five watermark rows, or the re-applied 20 aborts on a table
    // that already exists. This fixture delivers no effect, so the re-applied 20
    // folds no exposure; the retroactive fold over a real delivery is the ledger
    // suite's.
    //
    // Migration 21 goes before 20 (P-33/catálogo A): its one table and its one
    // watermark row, or the re-applied 21 aborts on a table that already exists.
    // Nothing in `registry_events` moves; the re-applied 21 folds the catalog
    // version above back into the same rows.
    const beforeRewind = registryEvidence(path);
    const beforeModelVersions = modelVersionEvidence(path);
    const beforePriceIntervals = priceIntervalEvidence(path);
    const beforeInitiatives = initiativeColumnEvidence(path);
    expect(beforeInitiatives).toEqual([
      { title: "The rewind initiative", objective_sha256: "2".repeat(64), repository_sha256: null },
    ]);
    const rewind = new DatabaseSync(path);
    rewindPriceIntervalCatalog(rewind);
    rewindUsageCapture(rewind);
    rewindTaskSubmission(rewind);
    rewindInitiativeRegistrationDetail(rewind);
    rewindModelVersionRegistry(rewind);
    rewindTaskRevisionEnvelopeReference(rewind);
    rewindArtifactRegistry(rewind);
    rewind.exec("DELETE FROM ledger_meta WHERE key LIKE 'account_integrity_%'");
    rewind.exec(
      "DROP TRIGGER tr_account_event_integrity__deny_delete;" +
        "DROP TRIGGER tr_account_event_integrity__deny_update;" +
        "DROP INDEX ux_account_events__account_id__version;" +
        "DROP TABLE account_event_integrity;",
    );
    // P-26 cut B: migration 25's objects go first — the cohort triggers, the step
    // columns in CHECK order, the two step tables and their watermarks — or the
    // re-applied 25 aborts on them.
    rewind.exec(
      "DROP TRIGGER tr_roadmap_version_read_model__validate_steps_on_update;" +
        "DROP TRIGGER tr_roadmap_version_read_model__validate_steps_on_insert;" +
        "ALTER TABLE roadmap_version_read_model DROP COLUMN step_manifest_sha256;" +
        "ALTER TABLE roadmap_version_read_model DROP COLUMN step_manifest_artifact_reference_id;" +
        "ALTER TABLE roadmap_version_read_model DROP COLUMN step_count;" +
        "ALTER TABLE roadmap_version_read_model DROP COLUMN recording_contract_version;" +
        "DROP TABLE roadmap_step_dependency;" +
        "DROP TABLE roadmap_step_read_model;" +
        "DELETE FROM projection_watermark WHERE projection_name IN ('roadmap_step_read_model', 'roadmap_step_dependency');",
    );
    // P-26/A: migration 24's unique index goes too, or the re-applied 24 aborts on it.
    rewind.exec("DROP INDEX ux_roadmap_version_read_model__initiative_id__version;");
    rewind.exec(
      "DROP TRIGGER tr_control_plane_events__validate_v2_coordinate;" +
        "DROP INDEX ux_response_occurrence_read_model__prompt;" +
        "DROP TABLE response_occurrence_read_model;" +
        "DROP INDEX ix_prompt_occurrence_read_model__sha256;" +
        "DROP INDEX ix_prompt_occurrence_read_model__segment;" +
        "DROP TABLE prompt_occurrence_read_model;" +
        "DROP INDEX ix_dispatch_attempt_read_model__state;" +
        "DROP INDEX ux_dispatch_attempt_read_model__effect_ordinal;" +
        "DROP TABLE dispatch_attempt_read_model;" +
        "DROP INDEX ix_effect_read_model__segment;" +
        "DROP INDEX ux_effect_read_model__logical_operation_sha256;" +
        "DROP INDEX ux_effect_read_model__idempotency_key;" +
        "DROP TABLE effect_read_model;" +
        "DROP INDEX ix_execution_route_segment_read_model__account;" +
        "DROP INDEX ux_execution_route_segment_read_model__attempt_segment;" +
        "DROP TABLE execution_route_segment_read_model;" +
        "DROP INDEX ux_task_attempt_read_model__invocation_id;" +
        "DROP INDEX ux_task_attempt_read_model__task_id_legacy_attempt_number;" +
        "DROP TABLE task_attempt_read_model;" +
        "DROP INDEX ix_task_revision_read_model__envelope_sha256;" +
        "DROP INDEX ux_task_revision_read_model__revision_id;" +
        "DROP TABLE task_revision_read_model;" +
        "ALTER TABLE control_plane_events DROP COLUMN revision_number;" +
        "ALTER TABLE control_plane_events DROP COLUMN attempt_number;" +
        "ALTER TABLE task_read_model DROP COLUMN envelope_sha256;" +
        "ALTER TABLE task_read_model DROP COLUMN latest_revision_number;" +
        "ALTER TABLE task_read_model DROP COLUMN latest_attempt_number;" +
        "ALTER TABLE task_read_model DROP COLUMN role;" +
        "ALTER TABLE task_read_model DROP COLUMN step_id;" +
        "ALTER TABLE task_read_model DROP COLUMN commit_policy;" +
        "DELETE FROM projection_watermark " +
        "WHERE projection_name IN ('task_revision_read_model', 'task_attempt_read_model', " +
        "'execution_route_segment_read_model', 'effect_read_model', " +
        "'dispatch_attempt_read_model', 'prompt_occurrence_read_model', " +
        "'response_occurrence_read_model');",
    );
    rewind.exec("DELETE FROM schema_migrations WHERE version >= 10");
    rewind.close();
    openLedger(path).close();

    // N-P36A-16: the reopen re-applied 15 without aborting, and what 15 must
    // preserve is preserved — the rows and their chain, the sequence counter,
    // and both foreign triggers byte for byte.
    expect(registryEvidence(path)).toEqual(beforeRewind);
    // N-P36D-7: and it re-applied 16 over the table 11 recreated, without
    // aborting — the column and its trigger are back.
    const reapplied = new DatabaseSync(path);
    expect(
      reapplied
        .prepare("SELECT name FROM pragma_table_info('task_revision_read_model') WHERE name = ?")
        .all("envelope_artifact_reference_id"),
    ).toHaveLength(1);
    expect(
      reapplied
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .all("tr_task_revision_read_model__validate_envelope_reference"),
    ).toHaveLength(1);
    expect(
      (reapplied.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { readonly v: number }).v,
    ).toBe(25);
    // P-26 cut B: and it re-applied 25 without aborting — the step tables are back.
    expect(
      reapplied
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name")
        .all("roadmap_step_dependency", "roadmap_step_read_model"),
    ).toHaveLength(2);
    // P-26/A: and it re-applied 24 without aborting — the unique index is back.
    expect(
      reapplied
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .all("ux_roadmap_version_read_model__initiative_id__version"),
    ).toHaveLength(1);
    // P-15 escalón C: and it re-applied 23 over the delivery table 13 recreated,
    // without aborting — the three pin columns and both triggers are back.
    expect(
      reapplied
        .prepare("SELECT name FROM pragma_table_info('dispatch_attempt_read_model') WHERE name IN (?, ?, ?) ORDER BY name")
        .all("catalog_document_id", "catalog_version", "dispatch_contract_version"),
    ).toHaveLength(3);
    expect(
      reapplied
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? ORDER BY name")
        .all("tr_dispatch_attempt_read_model__validate_pin_%"),
    ).toEqual([
      { name: "tr_dispatch_attempt_read_model__validate_pin_on_insert" },
      { name: "tr_dispatch_attempt_read_model__validate_pin_on_update" },
    ]);
    // P-07 escalón B: and it re-applied 22 over the table 13 recreated, without
    // aborting — the three result columns and both triggers are back.
    expect(
      reapplied
        .prepare("SELECT name FROM pragma_table_info('effect_read_model') WHERE name IN (?, ?, ?) ORDER BY name")
        .all("outcome_contract_version", "result_artifact_reference_id", "result_sha256"),
    ).toHaveLength(3);
    expect(
      reapplied
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? ORDER BY name")
        .all("tr_effect_read_model__validate_result_%"),
    ).toEqual([
      { name: "tr_effect_read_model__validate_result_on_insert" },
      { name: "tr_effect_read_model__validate_result_on_update" },
    ]);
    // P-14 C: and it re-applied 19 without aborting — the client key table is back.
    expect(
      reapplied.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all("task_submission_read_model"),
    ).toHaveLength(1);
    // N-P32B-23: and it re-applied 20 without aborting — the five usage tables,
    // their six indexes and their five watermark rows are back.
    expect(
      reapplied
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE name LIKE '%usage_%' AND name NOT LIKE 'sqlite_%' " +
            "ORDER BY type, name",
        )
        .all(),
    ).toEqual([
      { type: "index", name: "ix_usage_observation__corrects" },
      { type: "index", name: "ix_usage_observation__effect" },
      { type: "index", name: "ix_usage_settlement__latest" },
      { type: "index", name: "ux_usage_measurement_stream__identity" },
      { type: "index", name: "ux_usage_observation__source_report" },
      { type: "index", name: "ux_usage_observation__stream_ordinal" },
      { type: "table", name: "usage_measurement_stream_read_model" },
      { type: "table", name: "usage_observation_read_model" },
      { type: "table", name: "usage_settlement_observation_read_model" },
      { type: "table", name: "usage_settlement_read_model" },
      { type: "table", name: "usage_settlement_source_head_read_model" },
    ]);
    expect(
      reapplied.prepare("SELECT COUNT(*) AS n FROM projection_watermark WHERE projection_name LIKE 'usage_%'").get(),
    ).toEqual({ n: 5 });
    reapplied.close();
    // N-P14A-15: and it re-applied 17 over the document already in the stream,
    // folding it back into the same rows at a watermark level with the head.
    expect(modelVersionEvidence(path)).toEqual(beforeModelVersions);
    // N-P33A-12: and it re-applied 21 over the catalog version already in the
    // stream, folding its two intervals back into the same rows at a watermark
    // level with the head.
    expect((beforePriceIntervals as { readonly intervals: readonly unknown[] }).intervals).toHaveLength(2);
    expect(priceIntervalEvidence(path)).toEqual(beforePriceIntervals);
    // N-P14B-8: and it re-applied 18 over the registration already in the stream,
    // folding its title and digest back into the columns it added.
    expect(initiativeColumnEvidence(path)).toEqual(beforeInitiatives);

    const raw = new DatabaseSync(path);
    raw.exec(
      "DROP TRIGGER tr_account_event_integrity__deny_delete; " +
        "DROP TRIGGER account_events_deny_delete;",
    );
    raw.exec("DELETE FROM account_event_integrity WHERE account_sequence = 3");
    raw.exec("DELETE FROM account_events WHERE sequence = 3");
    raw.close();

    const result = await invoke(["integrity", "--database", path, "--format", "json"]);
    expect(result.exitCode).toBe(EXIT_INTEGRITY);

    const report = IntegrityResult.parse(json(result));
    expect(report.ok).toBe(false);
    expect(report.problems.map((problem) => problem.detail)).toContain(
      "the account integrity baseline names sequence 3 which the chain does not reach",
    );
    expect(report.coverage[0]).toMatchObject({
      sourceStream: "account_events",
      coverageKind: "BASELINED_AT_ACTIVATION",
      coveredSinceSequence: 1,
      checkedThroughSequence: 2,
      baselineSequence: 3,
    });
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
        // Plural since V2-B1f/F2, and each entry declares its own provider
        // since V2-B1f/F2b. The CLI validates nothing under `execution` but
        // `route` and spreads the rest through untouched, so this fixture
        // exists to prove the passthrough over the shape the daemon actually
        // accepts. Left singular, or left without a provider, it would pin a
        // document the daemon refuses.
        bindings: [
          {
            accountId: B7S_ACCOUNT,
            provider: "claude",
            binary: realpathSync(process.execPath),
            configRoot: dir,
            workdir: dir,
            limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
          },
        ],
      },
      ...extra,
    }),
  );
  chmodSync(path, 0o600);
  return path;
}

/**
 * V2-B1d: `--database` is required for `submission` too.
 *
 * The verb used to branch above the `--database` law under a comment saying it
 * opened no ledger. It now weighs the usage the ledger recorded, so it needs
 * one, and every test that drives it supplies one through this helper.
 */
function submissionArgv(
  config: string,
  accounts: string,
  policy: string,
  database: string = emptyLedger(),
): readonly string[] {
  return [
    "submission",
    "--database",
    database,
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
  readonly execution: { readonly route: EmittedRoute; readonly bindings: readonly Record<string, unknown>[] };
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
    expect(firstDocument.execution.route.capabilityPolicyVersion).toBe("2026-09-06.1");

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
    expect(emitted.execution.bindings).toEqual(before.execution.bindings);
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
    // The bindings: absolute by law, and untouched. Asserting this is what
    // makes the claim above narrow and true rather than broad and false.
    expect(JSON.stringify(emitted.execution.bindings)).toContain(dir);
  });
});

describe("the verb's refusals are closed and name no value", () => {
  it("refuses a relative path by field name", async () => {
    const dir = b7sStage();
    const invocation = await invoke([
      "submission",
      "--database",
      emptyLedger(),
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
      "--database",
      emptyLedger(),
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

/**
 * `--database` is required for `submission` too (V2-B1d).
 *
 * The verb weighs the usage the ledger recorded, so the law that was written
 * for every other verb now covers it as well -- through the one law, not a
 * second check of its own.
 */
describe("the planning verb obeys the database law", () => {
  it("N15 refuses submission without --database, through the existing usage refusal", async () => {
    const dir = b7sStage();
    const invocation = await invoke([
      "submission",
      "--config",
      writeConfigDocument(dir),
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
    expect(invocation.stderr).toContain("--database is required");
  });

  it("N8 maps an unopenable ledger through the per-subclass table, not a blanket code", async () => {
    // `LEDGER_OPEN` is exit 5. The point is that the mapping is the existing
    // `fromLedgerError` table rather than a new blanket answer invented here,
    // and that the election does not silently fall back to the published
    // position when the evidence could not be read.
    const dir = b7sStage();
    const invocation = await invoke(
      submissionArgv(
        writeConfigDocument(dir),
        writeAccountsFile(dir, ["opus"]),
        SHIPPED_POLICY,
        join(dir, "no-such-directory", "control-plane.sqlite"),
      ),
    );
    expect(invocation.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(invocation.stdout).toBe("");
  });
});


/**
 * V2-B1e: a recorded operator action reaches the election.
 *
 * The measured defect these drills close: `runSubmission` built its registry
 * from the owner file alone and never read `account_events`, so an account an
 * operator had explicitly drained was elected by the very next submission. The
 * ledger held the decision and nothing on this path looked at it.
 *
 * Everything below drives the real `run()` over a real ledger seeded through
 * the ledger's own `appendAccountAction`, so what is asserted is the verb's
 * behaviour and not a re-statement of the fold.
 */

const B1E_ACTOR = "kimi/k3/coordinator/01";

/**
 * A ledger carrying one account action, appended through the ledger's own door.
 *
 * The `idempotencyKey` is composed exactly as the account-actions seam composes
 * it, because the contract refuses any other shape -- so a seeded row is the
 * same row the gateway would have written.
 */
function ledgerWithAction(
  action: string,
  resultingState: string,
  version = 1,
  accountId: string = B7S_ACCOUNT,
  path: string = emptyLedger(),
): string {
  const ledger = openLedger(path);
  try {
    ledger.appendAccountAction({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: randomUUID(),
      accountId,
      version,
      idempotencyKey: accountId + "/1/action." + String(version),
      action,
      resultingState,
      actor: B1E_ACTOR,
      note: null,
      occurredAt: "2026-08-27T00:00:00.000Z",
      recordedAt: "2026-08-27T00:00:00.000Z",
    });
  } finally {
    ledger.close();
  }
  return path;
}

describe("P1: a recorded DRAIN makes the account ineligible for the very next submission", () => {
  it("elects the account while nothing is recorded, and refuses it once a DRAIN is", async () => {
    const dir = b7sStage();
    const config = writeConfigDocument(dir);
    const accounts = writeAccountsFile(dir, ["opus"]);

    // Before: the owner file says AVAILABLE and nothing is recorded, so the
    // account is elected. This half is what makes the second half evidence.
    const before = await invoke(submissionArgv(config, accounts, SHIPPED_POLICY));
    expect(before.exitCode).toBe(EXIT_OK);
    expect((JSON.parse(before.stdout) as EmittedConfig).execution.route.accountId).toBe(B7S_ACCOUNT);

    // After: one DRAIN, recorded. The owner file is byte-identical; the only
    // thing that changed is the ledger.
    const drained = ledgerWithAction("DRAIN", "DRAINING");
    const after = await invoke(submissionArgv(config, accounts, SHIPPED_POLICY, drained));

    expect(after.exitCode).toBe(EXIT_USAGE);
    expect(after.stdout).toBe("");
    expect(after.stderr).toContain("no route could be elected");
  });

  it("ACCOUNT_READY after a DRAIN restores eligibility -- the newest row wins", async () => {
    const dir = b7sStage();
    const config = writeConfigDocument(dir);
    const accounts = writeAccountsFile(dir, ["opus"]);

    const path = ledgerWithAction("DRAIN", "DRAINING");
    expect((await invoke(submissionArgv(config, accounts, SHIPPED_POLICY, path))).exitCode).toBe(
      EXIT_USAGE,
    );

    ledgerWithAction("ACCOUNT_READY", "AVAILABLE", 2, B7S_ACCOUNT, path);
    const restored = await invoke(submissionArgv(config, accounts, SHIPPED_POLICY, path));

    expect(restored.exitCode).toBe(EXIT_OK);
    expect((JSON.parse(restored.stdout) as EmittedConfig).execution.route.accountId).toBe(B7S_ACCOUNT);
  });

  it("REAUTH_REQUIRED also removes the account, through the same existing admission", async () => {
    // No new eligibility rule fired for this verb either: `AUTH_REQUIRED` is
    // not `AVAILABLE`, and the estimator and the router both refuse on that.
    const dir = b7sStage();
    const invocation = await invoke(
      submissionArgv(
        writeConfigDocument(dir),
        writeAccountsFile(dir, ["opus"]),
        SHIPPED_POLICY,
        ledgerWithAction("REAUTH_REQUIRED", "AUTH_REQUIRED"),
      ),
    );
    expect(invocation.exitCode).toBe(EXIT_USAGE);
    expect(invocation.stdout).toBe("");
  });

  it("an OWNER_OVERRIDE back to AVAILABLE elects the account again", async () => {
    const dir = b7sStage();
    const path = ledgerWithAction("DRAIN", "DRAINING");
    ledgerWithAction("OWNER_OVERRIDE", "AVAILABLE", 2, B7S_ACCOUNT, path);

    const invocation = await invoke(
      submissionArgv(writeConfigDocument(dir), writeAccountsFile(dir, ["opus"]), SHIPPED_POLICY, path),
    );
    expect(invocation.exitCode).toBe(EXIT_OK);
  });

  it("an action recorded against a different account leaves this election alone", async () => {
    // N5's claim at the CLI door: the ledger read is account-filtered, so a
    // drain on somebody else's account cannot remove this one.
    const dir = b7sStage();
    const invocation = await invoke(
      submissionArgv(
        writeConfigDocument(dir),
        writeAccountsFile(dir, ["opus"]),
        SHIPPED_POLICY,
        ledgerWithAction("DRAIN", "DRAINING", 1, "acct-somebody-else"),
      ),
    );
    expect(invocation.exitCode).toBe(EXIT_OK);
    expect((JSON.parse(invocation.stdout) as EmittedConfig).execution.route.accountId).toBe(B7S_ACCOUNT);
  });

  it("with no history at all the owner file still governs, unchanged", async () => {
    // The baseline this packet must not have moved: an empty history means
    // "the owner file stands", and the verb behaves exactly as it did before.
    const dir = b7sStage();
    const invocation = await invoke(
      submissionArgv(writeConfigDocument(dir), writeAccountsFile(dir, ["opus"]), SHIPPED_POLICY),
    );
    expect(invocation.exitCode).toBe(EXIT_OK);
  });
});

/**
 * A corrupt action row, written straight into the table.
 *
 * `account_events` is append-only -- `UPDATE` and `DELETE` are denied by
 * triggers -- so corruption is simulated the only way it can actually occur:
 * an `INSERT` whose `event_json` never passed the append door's validation.
 * The row's own columns stay well formed, because what is under test is the
 * `AccountActionEvent.parse` of the JSON blob on the read path.
 */
function insertCorruptAction(path: string, accountId: string = B7S_ACCOUNT, version = 99): void {
  const database = new DatabaseSync(path);
  try {
    database
      .prepare(
        "INSERT INTO account_events (event_id, idempotency_key, account_id, version, action," +
          " resulting_state, actor, note, occurred_at, recorded_at, contract_version, event_json)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        accountId + "/1/action." + String(version),
        accountId,
        version,
        "DRAIN",
        "DRAINING",
        B1E_ACTOR,
        null,
        "2026-08-27T00:00:00.000Z",
        "2026-08-27T00:00:00.000Z",
        LEDGER_CONTRACT_VERSION,
        JSON.stringify({ accountId, action: "NOT_A_VERB" }),
      );
  } finally {
    database.close();
  }
}

describe("N2/N3/N4: no failure path elects, and none falls back to the owner file", () => {
  it("N2 maps the two LedgerError subclasses the CLI black box can reach", async () => {
    // Through this door only `LEDGER_OPEN` and `LEDGER_MIGRATION` are
    // reachable, and both arise at the query-only open above `runSubmission`.
    // `LEDGER_INTEGRITY` and `LEDGER_QUERY` cannot be provoked from
    // `listAccountActions`; they stay covered by `fromLedgerError`'s own pin.
    const dir = b7sStage();

    const unopenable = await invoke(
      submissionArgv(
        writeConfigDocument(dir),
        writeAccountsFile(dir, ["opus"]),
        SHIPPED_POLICY,
        join(dir, "no-such-directory", "control-plane.sqlite"),
      ),
    );
    expect(unopenable.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(unopenable.stdout).toBe("");

    // A file that is not a migrated ledger at all: the open refuses rather
    // than the election proceeding on the file alone.
    const notALedger = join(dir, "not-a-ledger.sqlite");
    writeFileSync(notALedger, "this is not a database\n");
    chmodSync(notALedger, 0o600);
    const wrongSchema = await invoke(
      submissionArgv(writeConfigDocument(dir), writeAccountsFile(dir, ["opus"]), SHIPPED_POLICY, notALedger),
    );
    expect(wrongSchema.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(wrongSchema.stdout).toBe("");
  });

  it("N3 a corrupt action row yields EXIT_INTERNAL, and the election does not proceed", async () => {
    // A `ZodError` from `AccountActionEvent.parse`, not a `LedgerError`:
    // `fromUnknownError` routes it through `issuePaths` to EXIT_INTERNAL. That
    // is already fail-closed, and the packet deliberately does not reclassify
    // it -- inventing a `LedgerError` for a schema failure would misreport a
    // data defect as a database one.
    const dir = b7sStage();
    const path = ledgerWithAction("DRAIN", "DRAINING");
    insertCorruptAction(path);

    const invocation = await invoke(
      submissionArgv(writeConfigDocument(dir), writeAccountsFile(dir, ["opus"]), SHIPPED_POLICY, path),
    );

    expect(invocation.exitCode).toBe(EXIT_INTERNAL);
    expect(invocation.stdout).toBe("");
    // Never the ledger path, and never a value out of the row.
    expect(invocation.stderr).not.toContain(path);
    expect(invocation.stderr).not.toContain("NOT_A_VERB");
  });

  it("N4 every failure path refuses, and not one of them elects", async () => {
    // Read together: the open, the corrupt row, and -- above the ceiling --
    // the reader's own refusal, which is unit-drilled in the runtime suite
    // because ten thousand and one rows is not a fixture a CLI test should
    // append. What is asserted here is the shared property: no stdout, no
    // elected route, no fall back to the owner file's published state.
    const dir = b7sStage();
    const accounts = writeAccountsFile(dir, ["opus"]);

    const corrupt = ledgerWithAction("DRAIN", "DRAINING");
    insertCorruptAction(corrupt);

    const failures = [
      await invoke(
        submissionArgv(
          writeConfigDocument(dir),
          accounts,
          SHIPPED_POLICY,
          join(dir, "no-such-directory", "control-plane.sqlite"),
        ),
      ),
      await invoke(submissionArgv(writeConfigDocument(dir), accounts, SHIPPED_POLICY, corrupt)),
      await invoke(
        submissionArgv(writeConfigDocument(dir), accounts, SHIPPED_POLICY, ledgerWithAction("DRAIN", "DRAINING")),
      ),
    ];

    for (const invocation of failures) {
      expect(invocation.exitCode).not.toBe(EXIT_OK);
      expect(invocation.stdout).toBe("");
    }
  });
});

describe("P6: the CLI election folds the same answer the read model publishes", () => {
  it("the election agrees with the shared fold over one seeded ledger, in both directions", async () => {
    // Behavioural parity, and it is deliberately stated as half of a pair.
    //
    // This half drives the REAL CLI verb through `run()` over a seeded ledger
    // and, in the same test, folds that ledger's own rows through
    // `foldEffectiveState` -- the single implementation `@acp/accounts` now
    // owns. The other half lives in the gateway suite, where the real HTTP
    // read model is reachable and is shown to publish exactly what this same
    // fold produces. Together the two make the parity behavioural rather than
    // structural, without reaching across an entrypoint boundary that the
    // import law does not open for a test.
    const dir = b7sStage();
    const accounts = writeAccountsFile(dir, ["opus"]);
    const path = ledgerWithAction("DRAIN", "DRAINING");

    const foldedOver = (database: string): string => {
      const ledger = openLedger(database, { readOnly: true });
      try {
        return foldEffectiveState(
          "AVAILABLE",
          ledger.listAccountActions(B7S_ACCOUNT).map((row) => row.event),
        ).effectiveState;
      } finally {
        ledger.close();
      }
    };

    // The fold says DRAINING while the owner file still says AVAILABLE, and
    // the election refuses the account. Same ledger, same conclusion.
    expect(foldedOver(path)).toBe("DRAINING");
    const drained = await invoke(submissionArgv(writeConfigDocument(dir), accounts, SHIPPED_POLICY, path));
    expect(drained.exitCode).toBe(EXIT_USAGE);
    expect(drained.stdout).toBe("");

    // The other direction, so the agreement is not an artefact of one state.
    ledgerWithAction("ACCOUNT_READY", "AVAILABLE", 2, B7S_ACCOUNT, path);
    expect(foldedOver(path)).toBe("AVAILABLE");
    const ready = await invoke(submissionArgv(writeConfigDocument(dir), accounts, SHIPPED_POLICY, path));
    expect(ready.exitCode).toBe(EXIT_OK);
    expect((JSON.parse(ready.stdout) as EmittedConfig).execution.route.accountId).toBe(B7S_ACCOUNT);
  });
});

// ---------------------------------------------------------------------------
// V2-B1f/F4b — the decision verb
// ---------------------------------------------------------------------------

const F4B_SECOND_ACCOUNT = "acct-b7s-cli-second";
const F4B_SINCE = "2026-08-26T00:00:00Z";
const F4B_OBSERVED_AT = "2026-08-27T10:00:00.000Z";

/** The document the decision verb prints, as a reader consumes it. */
interface DecisionDocument {
  readonly now: string;
  readonly accounts: readonly {
    readonly accountId: string;
    readonly since: string;
    readonly decision: string;
    readonly reason?: string;
    readonly at?: string;
    readonly trigger?: string;
    readonly causedBy?: string;
    readonly observed: {
      readonly counts: Record<string, number>;
      readonly latestEventId: string | null;
      readonly latestOccurredAt: string | null;
    };
    readonly plan?: {
      readonly kind: string;
      readonly accountStatus: string | null;
      readonly taskState: string | null;
      readonly selectedAccountId: string | null;
      readonly steps: readonly string[];
      readonly events: readonly { readonly type: string }[];
    };
  }[];
}

/** An accounts file with one or two accounts, so a SWITCH has somewhere to go. */
function writeSwitchAccountsFile(dir: string, accountIds: readonly string[]): string {
  const path = join(dir, "accounts-switch.json");
  writeFileSync(
    path,
    JSON.stringify({
      contractVersion: LEDGER_CONTRACT_VERSION,
      accounts: accountIds.map((accountId) => ({
        contractVersion: LEDGER_CONTRACT_VERSION,
        accountId,
        provider: "claude",
        alias: accountId,
        authMode: "PREAUTHENTICATED_PROFILE",
        authProfileRef: B7S_PROFILE_REF,
        credentialRef: null,
        plan: "max",
        enabledModels: ["opus"],
        knownLimits: { weekly: 1_000_000 },
        resetSchedule: {
          kind: "DECLARED",
          nextResetAt: B7S_RESET,
          timezone: "UTC",
          confidence: "HIGH",
        },
        quotaEstimate: {
          remainingRatio: 0.5,
          estimatedTokensRemaining: 500_000,
          estimatedAt: F4B_SINCE,
          confidence: "MEDIUM",
        },
        lastHealthProbe: null,
        lastClassifiedError: null,
        status: "AVAILABLE",
        isolatedConfigRoot: "/tmp/acp-f4b-" + accountId,
        contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
      })),
    }),
  );
  chmodSync(path, 0o600);
  return path;
}

/** A ledger holding one discovered task and the pressure rows a walk recorded. */
function ledgerWithPressure(
  rows: readonly {
    readonly type: string;
    readonly accountId: string;
    readonly provider?: string;
    readonly pressure?: string;
    readonly occurredAt?: string;
    readonly payload?: Record<string, unknown>;
  }[],
): string {
  const path = disposableLedgerPath();
  const taskId = randomUUID();
  const events: Record<string, unknown>[] = [
    makeEvent({ taskId, transitionId: "discover", toState: "DISCOVERED" }),
  ];
  rows.forEach((row, index) => {
    events.push(
      makeEvent({
        taskId,
        transitionId: "pressure." + String(index),
        type: row.type,
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        occurredAt: row.occurredAt ?? F4B_OBSERVED_AT,
        payload: row.payload ?? {
          accountId: row.accountId,
          provider: row.provider ?? "claude",
          pressure: row.pressure ?? "QUOTA_EXHAUSTED",
        },
      }),
    );
  });
  seed(path, events);
  return path;
}

/** The ledger's own head, for asserting a verb appended nothing. */
function ledgerDigest(path: string): { readonly eventCount: number; readonly head: string | null } {
  const ledger = openLedger(path, { readOnly: true });
  try {
    const status = ledger.status();
    return { eventCount: status.eventCount, head: status.headEventSha256 };
  } finally {
    ledger.close();
  }
}

function decisionArgv(
  accounts: string,
  database: string,
  extra: readonly string[] = [],
): readonly string[] {
  return [
    "switch-decision",
    "--database",
    database,
    "--accounts",
    accounts,
    "--policy",
    SHIPPED_POLICY,
    "--estimated-tokens",
    "10000",
    "--reserve-tokens",
    "5000",
    "--duration-seconds",
    "600",
    "--model",
    "opus",
    ...extra,
  ];
}

describe("F4b P4: the verb reaches decideSwitch and prints a real plan", () => {
  it("turns a recorded QUOTA_WARNING into a DRAIN, naming what it observed", async () => {
    // The first production call of `decideSwitch` in this plane's history: a
    // row the walk recorded, folded into a trigger, handed to the policy.
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_WARNING" },
    ]);

    const invocation = await invoke(decisionArgv(accounts, database));
    expect(invocation.exitCode).toBe(EXIT_OK);

    const document = JSON.parse(invocation.stdout) as DecisionDocument;
    expect(document.now).toBe(FIXED_NOW);
    expect(document.accounts).toHaveLength(1);
    const account = document.accounts[0];
    expect(account?.accountId).toBe(B7S_ACCOUNT);
    expect(account?.since).toBe(F4B_SINCE);
    expect(account?.decision).toBe("DRAIN");
    expect(account?.trigger).toBe("QUOTA_WARNING");
    // A warning drains: the account stops taking new work, and the task in
    // flight is not moved.
    expect(account?.plan?.accountStatus).toBe("DRAINING");
    expect(account?.plan?.taskState).toBeNull();
    expect(account?.plan?.selectedAccountId).toBeNull();
    expect(account?.plan?.steps).toEqual([
      "MARK_ACCOUNT_DRAINING",
      "FINISH_CURRENT_ATOMIC_STEP",
      "WRITE_CHECKPOINT",
    ]);
    // The observation summary, and the deciding row named as the cause.
    expect(account?.observed.counts).toEqual({ QUOTA_WARNING: 1 });
    expect(account?.causedBy).toBe(account?.observed.latestEventId);
    expect(account?.observed.latestOccurredAt).toBe(F4B_OBSERVED_AT);
  });

  it("reports every account in the file when none is named", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT, F4B_SECOND_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_WARNING" },
    ]);

    const document = JSON.parse(
      (await invoke(decisionArgv(accounts, database))).stdout,
    ) as DecisionDocument;
    expect(document.accounts.map((entry) => entry.accountId)).toEqual([
      B7S_ACCOUNT,
      F4B_SECOND_ACCOUNT,
    ]);
    // The account with no rows is a success-shaped nothing, not an error.
    const second = document.accounts[1];
    expect(second?.decision).toBe("NONE");
    expect(second?.reason).toBe("NO_PRESSURE_RECORDED");
    expect(second?.observed.counts).toEqual({});
  });

  it("narrows to one account when --account names it", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT, F4B_SECOND_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_WARNING" },
    ]);

    const document = JSON.parse(
      (await invoke(decisionArgv(accounts, database, ["--account", F4B_SECOND_ACCOUNT]))).stdout,
    ) as DecisionDocument;
    expect(document.accounts.map((entry) => entry.accountId)).toEqual([F4B_SECOND_ACCOUNT]);
  });
});

describe("F4b P5: a SWITCH plan is produced and printed, and nothing is played", () => {
  it("names a second account, an exhausted status, and the four candidate events", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT, F4B_SECOND_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_EXHAUSTED" },
    ]);

    const before = ledgerDigest(database);
    const invocation = await invoke(decisionArgv(accounts, database, ["--account", B7S_ACCOUNT]));
    expect(invocation.exitCode).toBe(EXIT_OK);

    const document = JSON.parse(invocation.stdout) as DecisionDocument;
    const account = document.accounts[0];
    expect(account?.decision).toBe("SWITCH");
    expect(account?.trigger).toBe("QUOTA_EXHAUSTED");
    expect(account?.plan?.taskState).toBe("QUOTA_BLOCKED");
    expect(["EXHAUSTED", "COOLDOWN"]).toContain(account?.plan?.accountStatus);
    // The destination is a real other account, not the one that was refused.
    expect(account?.plan?.selectedAccountId).toBe(F4B_SECOND_ACCOUNT);
    // The four the decision has actually earned by the time it is made. A
    // completion is a claim about the END of a switch and is deliberately
    // absent: nothing has selected, probed, opened or rehydrated anything, and
    // the fence keeps `ACCOUNT_SWITCH_COMPLETED` without a constructor until
    // the packet that finishes a switch exists.
    expect(account?.plan?.events.map((event) => event.type)).toEqual([
      "QUOTA_WARNING",
      "TASK_STATE_CHANGED",
      "LEASE_REVOKED",
      "ACCOUNT_SWITCH_STARTED",
    ]);

    // The plan is a value. Nothing was played: the ledger is byte-identical.
    expect(ledgerDigest(database)).toEqual(before);
  });

  it("lets severity outrank recency end to end", async () => {
    // An exhaustion, then a warning recorded after it. The verb still decides
    // on the exhaustion, and names the exhaustion's row as the cause.
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT, F4B_SECOND_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_EXHAUSTED" },
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_WARNING" },
    ]);

    const document = JSON.parse(
      (await invoke(decisionArgv(accounts, database, ["--account", B7S_ACCOUNT]))).stdout,
    ) as DecisionDocument;
    const account = document.accounts[0];
    expect(account?.decision).toBe("SWITCH");
    expect(account?.observed.counts).toEqual({ QUOTA_EXHAUSTED: 1, QUOTA_WARNING: 1 });
    // The cause is the exhaustion, not the newest row.
    expect(account?.causedBy).not.toBe(account?.observed.latestEventId);
  });
});

describe("F4b P8: the only live pressure is legible", () => {
  it("prints AUTH_REQUIRED by name rather than an anonymous NONE", async () => {
    // The one pressure a real daemon can currently record. It is never a
    // trigger — and the operator's answer to it is a re-authentication, which
    // they can only reach if the verb says what it saw.
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT]);
    const database = ledgerWithPressure([
      {
        type: "AUTH_REQUIRED_RAISED",
        accountId: B7S_ACCOUNT,
        pressure: "AUTH_REQUIRED",
        provider: "claude",
      },
    ]);

    const invocation = await invoke(decisionArgv(accounts, database));
    expect(invocation.exitCode).toBe(EXIT_OK);

    const account = (JSON.parse(invocation.stdout) as DecisionDocument).accounts[0];
    expect(account?.decision).toBe("NONE");
    expect(account?.reason).toBe("NO_TRIGGER_CLASSIFIED");
    expect(account?.at).toBe("AUTH_REQUIRED");
    expect(account?.observed.counts).toEqual({ AUTH_REQUIRED: 1 });
    expect(account?.observed.latestEventId).not.toBeNull();
  });
});

describe("F4b P7: the verb is deterministic and reads one clock", () => {
  it("prints byte-identical documents over the same ledger, files and now", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT, F4B_SECOND_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_EXHAUSTED" },
    ]);

    const first = await invoke(decisionArgv(accounts, database));
    const second = await invoke(decisionArgv(accounts, database));
    expect(second.stdout).toBe(first.stdout);
    expect(second.exitCode).toBe(first.exitCode);
  });
});

describe("F4b N1/N9/N10: the verb decides and does not act", () => {
  it("N1: appends nothing, for any decision it reaches", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT, F4B_SECOND_ACCOUNT]);
    for (const pressure of ["QUOTA_EXHAUSTED", "QUOTA_WARNING", "AUTH_REQUIRED"]) {
      const database = ledgerWithPressure([
        {
          type: pressure === "AUTH_REQUIRED" ? "AUTH_REQUIRED_RAISED" : "QUOTA_WARNING",
          accountId: B7S_ACCOUNT,
          pressure,
        },
      ]);
      const before = ledgerDigest(database);
      const invocation = await invoke(decisionArgv(accounts, database));
      expect({ pressure, exitCode: invocation.exitCode }).toEqual({ pressure, exitCode: EXIT_OK });
      // The handle is query-only, so this is structural rather than a promise.
      expect({ pressure, after: ledgerDigest(database) }).toEqual({ pressure, after: before });
    }
  });

  it("N9/N10: no account state moves and no switch is executed", () => {
    const here = resolve(fileURLToPath(import.meta.url), "..");
    const source = readFileSync(join(here, "..", "..", "src", "cli", "index.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const token of [
      "executeSwitchPlan",
      "recordAccountAction",
      "appendAccountAction",
      "ACCOUNT_SWITCH_STARTED",
      "ACCOUNT_SWITCH_COMPLETED",
    ]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
    // The read-only open is the only open, and the verb adds none of its own.
    expect(code).toContain("readOnly: true");
  });
});

describe("F4b N11: refusals are carried, not re-worded", () => {
  it("prints a fold refusal as a NONE decision at EXIT_OK, with its own words", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT]);
    // A transient is a lawful observation and is not a decision problem: the
    // verb succeeds, and says why it decided nothing.
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "TRANSIENT" },
    ]);

    const invocation = await invoke(decisionArgv(accounts, database));
    expect(invocation.exitCode).toBe(EXIT_OK);
    const account = (JSON.parse(invocation.stdout) as DecisionDocument).accounts[0];
    expect({ decision: account?.decision, reason: account?.reason, at: account?.at }).toEqual({
      decision: "NONE",
      reason: "NO_TRIGGER_CLASSIFIED",
      at: "TRANSIENT",
    });
  });

  it("skips a plan-shaped row so a decision cannot feed its own next decision", async () => {
    // The exact payload a played DRAIN plan would write: `{accountId}` and no
    // pressure member. The verb must not read it back as an observation.
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, payload: { accountId: B7S_ACCOUNT } },
    ]);

    const account = (JSON.parse((await invoke(decisionArgv(accounts, database))).stdout) as DecisionDocument)
      .accounts[0];
    expect(account?.decision).toBe("NONE");
    expect(account?.reason).toBe("NO_PRESSURE_RECORDED");
    expect(account?.observed.counts).toEqual({});
  });

  it("prints no credential, no absolute path and no owner-file field", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT, F4B_SECOND_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_EXHAUSTED" },
    ]);

    const invocation = await invoke(decisionArgv(accounts, database));
    for (const secret of [B7S_PROFILE_REF, "/tmp/acp-f4b-", accounts, database, "knownLimits"]) {
      expect({ secret, leaked: invocation.stdout.includes(secret) }).toEqual({
        secret,
        leaked: false,
      });
    }
  });
});

describe("F4b N15: --account is validated by the protocol's own grammar", () => {
  it("refuses a path segment, a glob and an empty value", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT]);
    const database = ledgerWithPressure([]);
    for (const candidate of ["../etc/passwd", "acct/*", ""]) {
      const invocation = await invoke(decisionArgv(accounts, database, ["--account", candidate]));
      expect({ candidate, exitCode: invocation.exitCode }).toEqual({
        candidate,
        exitCode: EXIT_USAGE,
      });
      expect(invocation.stdout).toBe("");
    }
  });

  it("restates no account-id grammar of its own", () => {
    const here = resolve(fileURLToPath(import.meta.url), "..");
    const source = readFileSync(join(here, "..", "..", "src", "cli", "index.ts"), "utf8");
    expect(source).toContain("accountActionsPath(");
  });

  it("refuses an account the file does not declare", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT]);
    const invocation = await invoke(
      decisionArgv(accounts, ledgerWithPressure([]), ["--account", "acct-not-in-the-file"]),
    );
    expect(invocation.exitCode).toBe(EXIT_USAGE);
  });

  it("names itself, not another verb, when a required option is missing", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT]);
    const invocation = await invoke([
      "switch-decision",
      "--database",
      ledgerWithPressure([]),
      "--accounts",
      accounts,
      "--policy",
      SHIPPED_POLICY,
      "--estimated-tokens",
      "10000",
      "--reserve-tokens",
      "5000",
    ]);
    expect(invocation.exitCode).toBe(EXIT_USAGE);
    expect(invocation.stderr).toContain("switch-decision");
    expect(invocation.stderr).not.toContain("acp submission");
  });
});

// ---------------------------------------------------------------------------
// V2-B1f/F4d — the elector emits the complete document
// ---------------------------------------------------------------------------

/**
 * A fragment an operator merges by hand would be a second door: nothing would
 * stop them pairing one packet's plan with another packet's route, and the
 * daemon would admit the pair because each half parses. So the verb prints the
 * **entire** configuration document with the authorization inside it, exactly
 * as the re-election verb prints the whole re-elected document.
 */
describe("F4d: --emit-authorization prints the whole document, or refuses", () => {
  it("adds the authorization and preserves every other byte of the config", async () => {
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT, F4B_SECOND_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_EXHAUSTED" },
    ]);
    const config = writeConfigDocument(dir);
    const before = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;

    const invocation = await invoke(
      decisionArgv(accounts, database, [
        "--config",
        config,
        "--emit-authorization",
        "--account",
        B7S_ACCOUNT,
      ]),
    );
    expect(invocation.exitCode).toBe(EXIT_OK);

    const emitted = JSON.parse(invocation.stdout) as Record<string, unknown>;
    const execution = emitted["execution"] as Record<string, unknown>;
    const authorization = execution["switchAuthorization"] as Record<string, unknown>;

    expect(authorization["trigger"]).toBe("QUOTA_EXHAUSTED");
    expect(authorization["decidedForAccountId"]).toBe(B7S_ACCOUNT);
    // The identity recorded as the decider is the one the walk's events carry.
    expect(authorization["decidedBy"]).toBe(before["emittedBy"]);
    // The verb's single clock read, and the window it measured from.
    expect(authorization["decidedAt"]).toBe(FIXED_NOW);
    expect(typeof authorization["observedSince"]).toBe("string");
    expect(typeof authorization["decidedFromEventId"]).toBe("string");
    const plan = authorization["plan"] as Record<string, unknown>;
    expect(plan["kind"]).toBe("SWITCH");
    expect(plan["selectedAccountId"]).toBe(F4B_SECOND_ACCOUNT);

    // Every other byte of the document is the operator's own, untouched.
    const withoutAuthorization = {
      ...emitted,
      execution: Object.fromEntries(
        Object.entries(execution).filter(([key]) => key !== "switchAuthorization"),
      ),
    };
    expect(withoutAuthorization).toEqual(before);
  });

  it("refuses to emit an authorization the policy did not decide", async () => {
    // An authorization the elector never issued would be the forged decision
    // this whole boundary exists to prevent, so nothing is printed at all.
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT]);
    const database = ledgerWithPressure([
      {
        type: "AUTH_REQUIRED_RAISED",
        accountId: B7S_ACCOUNT,
        pressure: "AUTH_REQUIRED",
      },
    ]);
    const invocation = await invoke(
      decisionArgv(accounts, database, [
        "--config",
        writeConfigDocument(dir),
        "--emit-authorization",
      ]),
    );
    expect(invocation.exitCode).toBe(EXIT_USAGE);
    expect(invocation.stdout).toBe("");
    expect(invocation.stderr).toContain("no switch was decided");
  });

  it("still prints the ordinary report when no authorization is asked for", async () => {
    // The landed behaviour, unchanged: the flag adds a mode, it does not
    // replace one.
    const dir = b7sStage();
    const accounts = writeSwitchAccountsFile(dir, [B7S_ACCOUNT, F4B_SECOND_ACCOUNT]);
    const database = ledgerWithPressure([
      { type: "QUOTA_WARNING", accountId: B7S_ACCOUNT, pressure: "QUOTA_EXHAUSTED" },
    ]);
    const document = JSON.parse(
      (await invoke(decisionArgv(accounts, database))).stdout,
    ) as DecisionDocument;
    expect(document.accounts[0]?.decision).toBe("SWITCH");
  });
});

// ---------------------------------------------------------------------------
// Old-V2 R1b: every API error code is answered by name
// ---------------------------------------------------------------------------

/**
 * The exit code each of the `API_ERROR_CODES` earns.
 *
 * Written out here as the numbers HEAD answered before the decider became a
 * table, so this file is the evidence that the totality packet changed no
 * behaviour: six codes had explicit arms and nine fell to a `default:`, and
 * every one of the fifteen still answers the same number. It is not a copy of
 * the decider's table -- nothing exports that -- it is an independent
 * statement of the contract, compared below against what the door actually
 * returns.
 *
 * P-15/F added a sixteenth, `PRIVATE_READ_UNCONFIGURED`. It had no number
 * before, so it takes the one its write-side twin answers, `EXIT_USAGE`: no CLI
 * door raises either, because the CLI's authorization is filesystem access and
 * not a bearer.
 */
const EXIT_CODE_BY_API_ERROR_CODE: Record<ApiErrorCode, number> = {
  // The six the switch named explicitly.
  NOT_FOUND: EXIT_NOT_FOUND,
  LEDGER_UNAVAILABLE: EXIT_UNAVAILABLE,
  CONTRACT_VERSION_MISMATCH: EXIT_UNAVAILABLE,
  WRITE_REFUSED: EXIT_INTEGRITY,
  CLAIM_HELD: EXIT_CLAIM_HELD,
  INTERNAL: EXIT_INTERNAL,
  // The nine the `default:` arm absorbed. `BAD_REQUEST` is the only one of
  // them a door raises today, and `2` is the right answer for it; the other
  // eight arrived at `2` because nothing decided otherwise.
  BAD_REQUEST: EXIT_USAGE,
  METHOD_NOT_ALLOWED: EXIT_USAGE,
  AUTH_REQUIRED: EXIT_USAGE,
  WRITE_BEARER_UNCONFIGURED: EXIT_USAGE,
  TOOL_SERVERS_UNCONFIGURED: EXIT_USAGE,
  STREAM_CAPACITY: EXIT_USAGE,
  LEDGER_INTEGRITY: EXIT_USAGE,
  CAPABILITY_UNSUPPORTED: EXIT_USAGE,
  SCENARIO_UNCONFIGURED: EXIT_USAGE,
  // P-15/F: the sixteenth, answered as its write twin is.
  PRIVATE_READ_UNCONFIGURED: EXIT_USAGE,
};

/**
 * One admitted route for the fixtures below.
 *
 * Declared structurally rather than imported, on the lifecycle suite's own
 * reasoning: `@acp/contracts` owns `ResolvedRoute`, this package may not link
 * it, and `buildEvent` parses the shape on every append anyway.
 */
const R1B_ROUTE = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: FIXED_NOW,
} as const;

const R1B_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const R1B_EMITTED_BY = "claude/opus/implementer/01";

describe("old-V2 R1b: the decider answers the closed vocabulary by name", () => {
  const scenarios: string[] = [];

  afterEach(() => {
    for (const name of scenarios.splice(0)) removeScenarioRoot(name);
  });

  interface StagedAttempt {
    readonly scenarioId: string;
    readonly databasePath: string;
    readonly taskId: string;
  }

  /**
   * A scenario whose ledger holds a walk seeded through `RUN_STARTED`.
   *
   * The digest is computed the way a real submission computes it, because the
   * door verifies it: a fixture with a placeholder would be refused before a
   * driver was ever constructed, and every assertion below would then be
   * measuring recovery rather than the decider.
   */
  function stageAttempt(scenarioId: string): StagedAttempt {
    scenarios.push(scenarioId);
    const databasePath = scenarioLedgerPath(resolveScenarioRoot(scenarioId));
    const taskId = randomUUID();
    const invocation = deriveInvocation(
      taskId,
      1,
      FIXED_NOW,
      canonicalSubmissionDigest({
        taskId,
        attempt: 1,
        submittedAt: FIXED_NOW,
        initiativeId: R1B_INITIATIVE_ID,
        route: R1B_ROUTE,
      }),
    );
    const ledger = openLedger(databasePath);
    try {
      for (let index = 0; index <= 4; index += 1) {
        ledger.append(
          buildEvent({
            invocation,
            step: planStep(index),
            emittedBy: R1B_EMITTED_BY,
            initiativeId: R1B_INITIATIVE_ID,
            plan: LIFECYCLE_PLAN,
            route: R1B_ROUTE,
          }),
        );
      }
    } finally {
      ledger.close();
    }
    return { scenarioId, databasePath, taskId };
  }

  /**
   * Seams whose driver factory refuses with the code it was given.
   *
   * The factory throws rather than answering, which is how a door refusal
   * reaches `fromLifecycleError` and therefore the decider. `runLifecycleVerb`
   * re-throws a `LifecycleRefused` unchanged, so the code that arrives at the
   * exit table is the code named here and not a rewritten one.
   */
  function refusingWith(code: ApiErrorCode): CliSeams {
    return {
      makeDriver: (): never => {
        throw new LifecycleRefused(code, "the door refused before an operation", "cancel");
      },
    };
  }

  async function invokeCancel(staged: StagedAttempt, seams: CliSeams): Promise<Invocation> {
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
    const exitCode = await run(
      [
        "cancel",
        "--database",
        staged.databasePath,
        "--scenario",
        staged.scenarioId,
        "--task",
        staged.taskId,
        "--attempt",
        "1",
        "--mode",
        "RESTATE",
        "--format",
        "json",
      ],
      io,
      seams,
    );
    return { exitCode, stdout, stderr };
  }

  it("refuses a code outside the vocabulary instead of calling it a usage error", async () => {
    // `UNLISTED_CODE` is not in `API_ERROR_CODES`, and it stands for the code this
    // repository has not written yet: a door that starts raising one, or a
    // driver that deserializes one off a wire. The decider used to answer it
    // with `EXIT_USAGE` through a `default:` arm -- a `2` telling a script to
    // fix arguments that were already correct, decided by nobody. There is no
    // number that is right for a code this package has never heard of, so the
    // only honest answer is to refuse to produce one.
    const staged = stageAttempt("cli-r1b-off-vocabulary");
    const settled = await invokeCancel(staged, refusingWith("UNLISTED_CODE" as ApiErrorCode)).then(
      (invocation) => ({ kind: "answered" as const, exitCode: invocation.exitCode }),
      (error: unknown) => ({
        kind: "refused" as const,
        name: error instanceof Error ? error.name : "not an Error",
      }),
    );
    expect(settled).toEqual({ kind: "refused", name: "UnnamedRefusal" });
  });

  it("answers each of the sixteen codes with the number it answered before, and the sixteenth as its write twin", async () => {
    // Every member of the closed vocabulary, driven through the real door and
    // the real decider rather than read out of a table. A packet that quietly
    // re-assigned one of them fails here, which is what makes the
    // totality claim a non-behavioural one.
    const answered: Record<string, number> = {};
    for (const code of API_ERROR_CODES) {
      const staged = stageAttempt("cli-r1b-" + code.toLowerCase().replace(/_/g, "-"));
      const invocation = await invokeCancel(staged, refusingWith(code));
      answered[code] = invocation.exitCode;
    }
    expect(answered).toEqual(EXIT_CODE_BY_API_ERROR_CODE);
  });

  it("leaves no member of API_ERROR_CODES without a stated number", () => {
    // The type-level half. `Exclude` is `never` only while every member of the
    // union is a key above; a sixteenth member of `API_ERROR_CODES` makes this
    // assignment a compile error, and the typecheck stage of `pnpm check` is
    // where that is enforced -- the union is erased long before any assertion
    // could run.
    const unmapped: Exclude<ApiErrorCode, keyof typeof EXIT_CODE_BY_API_ERROR_CODE>[] = [];
    const none: never[] = unmapped;
    expect(none).toEqual([]);
    // And the runtime half, so a table that drifted from the vocabulary is a
    // failure here rather than a silently narrower proof above.
    expect(Object.keys(EXIT_CODE_BY_API_ERROR_CODE).sort()).toEqual([...API_ERROR_CODES].sort());
  });
});

/** The initiative the rewind fixtures register in the closed payload (P-14 B). */
const REWIND_INITIATIVE = "77777777-7777-4777-8777-777777777777";

/**
 * Migration 21 undone on a raw handle (P-33/catálogo A): the price interval table
 * and its one watermark row. No index or trigger of its own name stands beside it.
 */
function rewindPriceIntervalCatalog(raw: DatabaseSync): void {
  raw.exec(
    "DROP TABLE price_interval_read_model;" +
      "DELETE FROM projection_watermark WHERE projection_name = 'price_interval_read_model';",
  );
}

/** The price interval catalog and its watermark, as a raw handle sees them (P-33/catálogo A). */
function priceIntervalEvidence(path: string): unknown {
  const raw = new DatabaseSync(path);
  try {
    return {
      intervals: raw
        .prepare(
          "SELECT * FROM price_interval_read_model ORDER BY catalog_document_id, catalog_version, provider, " +
            "model_version_id, transport_kind, token_class, currency, effective_from",
        )
        .all(),
      watermark: raw
        .prepare(
          "SELECT applied_sequence, event_count, source_head_sha256 FROM projection_watermark " +
            "WHERE projection_name = 'price_interval_read_model'",
        )
        .all(),
    };
  } finally {
    raw.close();
  }
}

/**
 * Migration 20 undone on a raw handle (P-32/captura B): the five usage tables,
 * children first, each index before its table, and the five watermark rows. The
 * 20 goes before the 19, as every later migration goes before the one it follows.
 */
function rewindUsageCapture(raw: DatabaseSync): void {
  raw.exec(
    "DROP TABLE usage_settlement_observation_read_model;" +
      "DROP TABLE usage_settlement_source_head_read_model;" +
      "DROP INDEX ix_usage_settlement__latest;" +
      "DROP TABLE usage_settlement_read_model;" +
      "DROP INDEX ix_usage_observation__corrects;" +
      "DROP INDEX ix_usage_observation__effect;" +
      "DROP INDEX ux_usage_observation__source_report;" +
      "DROP INDEX ux_usage_observation__stream_ordinal;" +
      "DROP TABLE usage_observation_read_model;" +
      "DROP INDEX ux_usage_measurement_stream__identity;" +
      "DROP TABLE usage_measurement_stream_read_model;" +
      "DELETE FROM projection_watermark WHERE projection_name LIKE 'usage_%';",
  );
}

/**
 * Migration 19 undone on a raw handle (P-14 C): the client key table and its one
 * watermark row. No index or trigger of its own name stands beside it.
 */
function rewindTaskSubmission(raw: DatabaseSync): void {
  raw.exec(
    "DROP TABLE task_submission_read_model;" +
      "DELETE FROM projection_watermark WHERE projection_name = 'task_submission_read_model';",
  );
}

/**
 * Migration 18 undone on a raw handle (P-14 B): the initiative projection's three
 * additive columns, by name. No index, trigger or watermark names them.
 */
function rewindInitiativeRegistrationDetail(raw: DatabaseSync): void {
  raw.exec(
    "ALTER TABLE initiative_read_model DROP COLUMN repository_sha256;" +
      "ALTER TABLE initiative_read_model DROP COLUMN objective_sha256;" +
      "ALTER TABLE initiative_read_model DROP COLUMN title;",
  );
}

/** The three registration columns of the initiative projection, as a raw handle sees them (P-14 B). */
function initiativeColumnEvidence(path: string): unknown {
  const raw = new DatabaseSync(path);
  try {
    return raw
      .prepare("SELECT title, objective_sha256, repository_sha256 FROM initiative_read_model ORDER BY initiative_id")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    raw.close();
  }
}

/**
 * Migration 17 undone on a raw handle (P-14 A): the model version registry's two
 * children, each after its unique index, then the parent after its index, and the
 * one watermark row it seeded.
 */
function rewindModelVersionRegistry(raw: DatabaseSync): void {
  raw.exec(
    "DROP INDEX ux_model_version_transport__transport;" +
      "DROP TABLE model_version_transport;" +
      "DROP INDEX ux_model_version_eligible_role__role;" +
      "DROP TABLE model_version_eligible_role;" +
      "DROP INDEX ix_model_version_read_model__status;" +
      "DROP TABLE model_version_read_model;" +
      "DELETE FROM projection_watermark WHERE projection_name = 'model_version_read_model';",
  );
}

/** The model version registry and its watermark, as a raw handle sees them (P-14 A). */
function modelVersionEvidence(path: string): unknown {
  const raw = new DatabaseSync(path);
  try {
    return {
      versions: raw.prepare("SELECT * FROM model_version_read_model ORDER BY model_version_id").all(),
      roles: raw.prepare("SELECT * FROM model_version_eligible_role ORDER BY model_version_id, ordinal").all(),
      transports: raw.prepare("SELECT * FROM model_version_transport ORDER BY model_version_id, ordinal").all(),
      watermark: raw
        .prepare(
          "SELECT applied_sequence, event_count, source_head_sha256 FROM projection_watermark " +
            "WHERE projection_name = 'model_version_read_model'",
        )
        .all(),
    };
  } finally {
    raw.close();
  }
}

/**
 * Migration 16 undone on a raw handle (P-36/local D): the envelope reference's
 * trigger, then its column, in the order SQLite forces (M-7). No watermark,
 * because 16 seeded none.
 */
function rewindTaskRevisionEnvelopeReference(raw: DatabaseSync): void {
  raw.exec(
    "DROP TRIGGER tr_task_revision_read_model__validate_envelope_reference;" +
      "ALTER TABLE task_revision_read_model DROP COLUMN envelope_artifact_reference_id;",
  );
}

/**
 * Migration 15 undone on a raw handle (P-36/local A): the four artifact tables,
 * children first, their watermarks, and `registry_events` rebuilt back into
 * migration 9's shape — E3 in reverse, with migration 9's own text for the
 * table, its indexes and triggers, and the two foreign triggers.
 */
function rewindArtifactRegistry(raw: DatabaseSync): void {
  const artifacts = raw
    .prepare("SELECT COUNT(*) AS n FROM registry_events WHERE subject_kind <> 'DOCUMENT'")
    .get() as { readonly n: number };
  if (artifacts.n !== 0) throw new Error("a ledger holding artifact events cannot be rewound past 15");
  raw.exec(
    "DROP TABLE artifact_tombstone_read_model;" +
      "DROP INDEX ux_artifact_pin_read_model__content_sha256_holder__live;" +
      "DROP TABLE artifact_pin_read_model;" +
      "DROP INDEX ux_artifact_reference_read_model__id_content_generation;" +
      "DROP INDEX ix_artifact_reference_read_model__expires_at;" +
      "DROP INDEX ix_artifact_reference_read_model__scope_kind_scope_id;" +
      "DROP INDEX ix_artifact_reference_read_model__content_sha256;" +
      "DROP TABLE artifact_reference_read_model;" +
      "DROP INDEX ux_artifact_blob_read_model__content_sha256__unreclaimed;" +
      "DROP INDEX ux_artifact_blob_read_model__reclaim_id;" +
      "DROP INDEX ix_artifact_blob_read_model__first_published_sequence;" +
      "DROP INDEX ix_artifact_blob_read_model__lifecycle_state;" +
      "DROP TABLE artifact_blob_read_model;" +
      "DELETE FROM projection_watermark WHERE projection_name IN ('artifact_blob_read_model', " +
      "'artifact_reference_read_model', 'artifact_pin_read_model', 'artifact_tombstone_read_model');",
  );

  const ninth = LEDGER_MIGRATIONS.find((migration) => migration.version === 9);
  if (ninth === undefined) throw new Error("migration 9 is absent from this build");
  const slice = (from: string, to: string): string => {
    const start = ninth.sql.indexOf(from);
    const end = ninth.sql.indexOf(to, start);
    if (start === -1 || end === -1) throw new Error("migration 9 no longer holds " + from);
    return ninth.sql.slice(start, end);
  };
  const columns =
    "sequence, event_id, idempotency_key, document_kind, document_id, document_version, " +
    "content_digest, parent_document_version, recorded_by, effective_from, occurred_at, " +
    "recorded_at, causation_stream, causation_sequence, causation_sha256, contract_version, " +
    "event_json, previous_sha256, event_sha256";
  raw.exec(
    slice("CREATE TABLE registry_events (", "-- Version identity.").replace(
      "CREATE TABLE registry_events (",
      "CREATE TABLE registry_events__rewound (",
    ),
  );
  raw.exec(
    "INSERT INTO registry_events__rewound (" + columns + ") " +
      "SELECT " + columns + " FROM registry_events ORDER BY sequence;" +
      "DROP TRIGGER tr_registry_events__validate_new_rows;" +
      "DROP TRIGGER tr_registry_events__deny_delete;" +
      "DROP TRIGGER tr_registry_events__deny_update;" +
      "DROP TRIGGER tr_control_plane_events__validate_new_rows;" +
      "DROP TRIGGER tr_initiative_events__validate_new_rows;" +
      "DROP TABLE registry_events;" +
      "ALTER TABLE registry_events__rewound RENAME TO registry_events;",
  );
  raw.exec(slice("CREATE UNIQUE INDEX ux_registry_events__document_id__document_version", "-- The causal vocabulary widens to three"));
  raw.exec(slice("CREATE TRIGGER tr_control_plane_events__validate_new_rows", "-- The first read model fed by two streams."));
}

/** What migration 15 must conserve across a rebuild, read past the ledger. */
function registryEvidence(path: string): unknown {
  const raw = new DatabaseSync(path);
  try {
    return {
      rows: raw
        .prepare(
          "SELECT sequence, event_id, document_id, document_version, event_json, previous_sha256, " +
            "event_sha256 FROM registry_events ORDER BY sequence",
        )
        .all(),
      sequence: raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'registry_events'").all(),
      triggers: raw
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN " +
            "('tr_control_plane_events__validate_new_rows', 'tr_initiative_events__validate_new_rows') " +
            "ORDER BY name",
        )
        .all(),
      subjectColumn: raw
        .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('registry_events') WHERE name = 'subject_kind'")
        .get(),
    };
  } finally {
    raw.close();
  }
}
