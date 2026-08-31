import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  buildIdempotencyKey,
  buildInitiativeIdempotencyKey,
  type ControlPlaneEventType,
  type TaskState,
} from "@acp/contracts";

import {
  GENESIS_SHA256,
  LedgerCanonicalizationError,
  LedgerEventIdConflictError,
  LedgerIdempotencyConflictError,
  LedgerIntegrityError,
  LedgerLifecycleConflictError,
  LedgerMigrationError,
  LedgerOpenError,
  LedgerQueryError,
  LedgerReadOnlyError,
  LedgerValidationError,
  canonicalJsonStringify,
  chainDigest,
  openLedger,
  type Ledger,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Temporary databases
//
// Every test builds its own database under a fresh temporary directory and
// removes it afterwards. Nothing here writes to a repository path.
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];
const openLedgers: Ledger[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-ledger-"));
  temporaryDirectories.push(directory);
  return join(directory, "control-plane.sqlite");
}

/** Open and register for teardown, so a failing assertion cannot leak a handle. */
function open(path: string, options: Parameters<typeof openLedger>[1] = {}): Ledger {
  const ledger = openLedger(path, options);
  openLedgers.push(ledger);
  return ledger;
}

afterEach(() => {
  while (openLedgers.length > 0) {
    const ledger = openLedgers.pop();
    if (ledger !== undefined && !ledger.closed) ledger.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Event fixtures
//
// No fixture carries a secret-shaped value. Where a test needs to prove that a
// credential-bearing key is rejected, it uses an obvious placeholder, because
// the point is the key name, not the value.
// ---------------------------------------------------------------------------

interface EventInput {
  readonly taskId?: string;
  readonly attempt?: number;
  readonly transitionId?: string;
  readonly eventId?: string;
  readonly type?: ControlPlaneEventType;
  readonly fromState?: TaskState | null;
  readonly toState?: TaskState;
  readonly emittedBy?: string;
  readonly occurredAt?: string;
  readonly recordedAt?: string;
  readonly payload?: Record<string, unknown>;
}

function makeEvent(input: EventInput = {}): Record<string, unknown> {
  const taskId = input.taskId ?? randomUUID();
  const attempt = input.attempt ?? 1;
  const transitionId = input.transitionId ?? "step-1";
  const occurredAt = input.occurredAt ?? "2026-08-27T12:00:00.000Z";
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: input.eventId ?? randomUUID(),
    taskId,
    attempt,
    transitionId,
    idempotencyKey: buildIdempotencyKey({ taskId, attempt, transitionId }),
    type: input.type ?? "TASK_DISCOVERED",
    fromState: input.fromState ?? null,
    toState: input.toState ?? "DISCOVERED",
    emittedBy: input.emittedBy ?? "kimi/k3/coordinator/01",
    occurredAt,
    recordedAt: input.recordedAt ?? occurredAt,
    correlationId: null,
    causationId: null,
    payload: input.payload ?? {},
  };
}

/** A three event lifecycle for one task, used by several tests. */
function seedTask(ledger: Ledger, taskId: string, emittedBy: string): void {
  ledger.append(
    makeEvent({ taskId, transitionId: "discover", toState: "DISCOVERED", emittedBy }),
  );
  ledger.append(
    makeEvent({
      taskId,
      transitionId: "classify",
      type: "TASK_CLASSIFIED",
      fromState: "DISCOVERED",
      toState: "DT_CLASSIFIED",
      emittedBy,
    }),
  );
  ledger.append(
    makeEvent({
      taskId,
      transitionId: "ready",
      type: "TASK_READY",
      fromState: "DT_CLASSIFIED",
      toState: "READY",
      emittedBy,
    }),
  );
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

describe("canonical json", () => {
  it("orders object keys deterministically regardless of insertion order", () => {
    const first = { zebra: 1, alpha: 2, middle: { yankee: 3, bravo: 4 } };
    const second = { middle: { bravo: 4, yankee: 3 }, alpha: 2, zebra: 1 };

    expect(canonicalJsonStringify(first)).toBe(
      JSON.stringify({ alpha: 2, middle: { bravo: 4, yankee: 3 }, zebra: 1 }),
    );
    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
  });

  it("encodes the primitive JSON values", () => {
    expect(canonicalJsonStringify(null)).toBe("null");
    expect(canonicalJsonStringify(true)).toBe("true");
    expect(canonicalJsonStringify(false)).toBe("false");
    expect(canonicalJsonStringify(0)).toBe("0");
    expect(canonicalJsonStringify(1.5)).toBe("1.5");
    expect(canonicalJsonStringify("quote\" and \\ and newline\n")).toBe(
      JSON.stringify("quote\" and \\ and newline\n"),
    );
    expect(canonicalJsonStringify([])).toBe("[]");
    expect(canonicalJsonStringify({})).toBe("{}");
    expect(canonicalJsonStringify(Object.create(null) as object)).toBe("{}");
  });

  it("rejects every value that JSON would silently coerce or drop", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    const holed: unknown[] = [1, 2, 3];
    Reflect.deleteProperty(holed, 1);

    const extraProperty: unknown[] = [1];
    Object.defineProperty(extraProperty, "extra", { value: 2, enumerable: true });

    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "hidden", { value: 1, enumerable: false });

    const cases: readonly [string, unknown][] = [
      ["undefined", undefined],
      ["nested undefined", { a: undefined }],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["negative Infinity", Number.NEGATIVE_INFINITY],
      ["negative zero", -0],
      ["bigint", BigInt(1)],
      ["function", () => 1],
      ["symbol", Symbol("s")],
      ["symbol key", { [Symbol("s")]: 1 }],
      ["date", new Date(0)],
      ["map", new Map()],
      ["set", new Set()],
      ["regexp", /x/],
      ["class instance", new (class Thing { readonly kind = "thing"; })()],
      ["array hole", holed],
      ["array with extra own property", extraProperty],
      ["non enumerable own property", nonEnumerable],
      ["accessor property", { get computed() { return 1; } }],
      ["cycle", cyclic],
    ];

    for (const [label, value] of cases) {
      const error = caught(() => canonicalJsonStringify(value));
      expect(error, label).toBeInstanceOf(LedgerCanonicalizationError);
    }
  });

  it("allows the same object twice as siblings but not as a cycle", () => {
    const shared = { a: 1 };
    expect(canonicalJsonStringify({ left: shared, right: shared })).toBe(
      JSON.stringify({ left: { a: 1 }, right: { a: 1 } }),
    );
  });

  it("rejects structures deeper than the canonical depth budget", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let level = 0; level < 70; level += 1) {
      const child: Record<string, unknown> = {};
      cursor["child"] = child;
      cursor = child;
    }
    expect(caught(() => canonicalJsonStringify(root))).toBeInstanceOf(
      LedgerCanonicalizationError,
    );
  });

  it("chains digests from a genesis of sixty four zeroes", () => {
    expect(GENESIS_SHA256).toBe("0".repeat(64));
    const digest = chainDigest(GENESIS_SHA256, "{}");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(chainDigest(GENESIS_SHA256, "{}")).toBe(digest);
    expect(chainDigest(digest, "{}")).not.toBe(digest);
  });
});

// ---------------------------------------------------------------------------
// Open, pragmas and migrations
// ---------------------------------------------------------------------------

describe("open", () => {
  it("opens writable with WAL, foreign keys, normal sync and a bounded busy timeout", () => {
    const ledger = open(temporaryDatabase(), { busyTimeoutMs: 7_500 });
    const status = ledger.status();

    expect(status.pragmas.journalMode).toBe("wal");
    expect(status.pragmas.foreignKeys).toBe(true);
    expect(status.pragmas.synchronous).toBe(1);
    expect(status.pragmas.busyTimeoutMs).toBe(7_500);
    expect(status.pragmas.queryOnly).toBe(false);
    expect(status.readOnly).toBe(false);
    expect(status.headSequence).toBe(0);
    expect(status.headEventSha256).toBe(GENESIS_SHA256);
    expect(status.eventCount).toBe(0);
    expect(status.migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4]);
    expect(status.initiativeHeadSequence).toBe(0);
    expect(status.initiativeHeadEventSha256).toBe(GENESIS_SHA256);
    expect(status.initiativeEventCount).toBe(0);
  });

  it("opens read-only as query only and refuses every mutation", () => {
    const path = temporaryDatabase();
    const writable = open(path);
    seedTask(writable, randomUUID(), "claude/opus/implementer/01");
    writable.close();

    const reader = open(path, { readOnly: true });
    const status = reader.status();
    expect(status.readOnly).toBe(true);
    expect(status.pragmas.queryOnly).toBe(true);
    expect(status.eventCount).toBe(3);

    expect(caught(() => reader.append(makeEvent()))).toBeInstanceOf(LedgerReadOnlyError);
    expect(caught(() => reader.rebuildReadModel())).toBeInstanceOf(LedgerReadOnlyError);
    expect(reader.verifyIntegrity().ok).toBe(true);
  });

  it("refuses a read-only open of a file that does not exist, and creates nothing", () => {
    const path = temporaryDatabase();
    expect(caught(() => open(path, { readOnly: true }))).toBeInstanceOf(LedgerOpenError);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects an out of range busy timeout", () => {
    expect(caught(() => open(temporaryDatabase(), { busyTimeoutMs: -1 }))).toBeInstanceOf(
      LedgerOpenError,
    );
    expect(
      caught(() => open(temporaryDatabase(), { busyTimeoutMs: 999_999_999 })),
    ).toBeInstanceOf(LedgerOpenError);
  });

  it("rejects a database whose migration checksums do not match this build", () => {
    const path = temporaryDatabase();
    open(path).close();

    const raw = new Database(path);
    raw.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = ?").run(
      "0".repeat(64),
      1,
    );
    raw.close();

    const writableError = caught(() => open(path));
    expect(writableError).toBeInstanceOf(LedgerMigrationError);
    expect((writableError as LedgerMigrationError).problems.join(" ")).toContain("checksum");

    expect(caught(() => open(path, { readOnly: true }))).toBeInstanceOf(LedgerMigrationError);
  });

  it("rejects a reordered migration history", () => {
    const path = temporaryDatabase();
    open(path).close();

    const raw = new Database(path);
    const update = raw.prepare("UPDATE schema_migrations SET name = ? WHERE version = ?");
    update.run("read_models", 1);
    update.run("control_plane_events", 2);
    raw.close();

    expect(caught(() => open(path))).toBeInstanceOf(LedgerMigrationError);
  });

  it("rejects a database carrying a migration this build does not define", () => {
    const path = temporaryDatabase();
    open(path).close();

    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)",
      )
      .run(99, "from_the_future", "0".repeat(64), "2026-08-27T12:00:00.000Z");
    raw.close();

    const error = caught(() => open(path));
    expect(error).toBeInstanceOf(LedgerMigrationError);
    expect((error as LedgerMigrationError).problems.join(" ")).toContain("unknown to this build");
  });

  it("fails a read-only open closed when migrations are missing", () => {
    const path = temporaryDatabase();
    const raw = new Database(path);
    raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL PRIMARY KEY, " +
        "name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;",
    );
    raw.close();

    const error = caught(() => open(path, { readOnly: true }));
    expect(error).toBeInstanceOf(LedgerMigrationError);
    expect((error as LedgerMigrationError).problems.join(" ")).toContain(
      "read-only handle may not apply it",
    );
  });

  it("fails a read-only open closed when the database was never migrated", () => {
    const path = temporaryDatabase();
    const raw = new Database(path);
    raw.exec("CREATE TABLE unrelated (a INTEGER) STRICT;");
    raw.close();

    expect(caught(() => open(path, { readOnly: true }))).toBeInstanceOf(LedgerMigrationError);
  });

  it("applies migrations exactly once across reopens", () => {
    const path = temporaryDatabase();
    const first = open(path);
    const firstMigrations = first.status().migrations;
    first.close();

    const second = open(path);
    expect(second.status().migrations).toEqual(firstMigrations);
  });
});

// ---------------------------------------------------------------------------
// Append, idempotency and lifecycle
// ---------------------------------------------------------------------------

describe("append", () => {
  it("chains digests from genesis and advances head and count", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();

    const first = ledger.append(makeEvent({ taskId, transitionId: "discover" }));
    expect(first.inserted).toBe(true);
    expect(first.record.sequence).toBe(1);
    expect(first.record.previousSha256).toBe(GENESIS_SHA256);
    expect(first.record.eventSha256).toBe(
      chainDigest(GENESIS_SHA256, first.record.canonicalJson),
    );

    const second = ledger.append(
      makeEvent({
        taskId,
        transitionId: "classify",
        type: "TASK_CLASSIFIED",
        fromState: "DISCOVERED",
        toState: "DT_CLASSIFIED",
      }),
    );
    expect(second.record.sequence).toBe(2);
    expect(second.record.previousSha256).toBe(first.record.eventSha256);

    const status = ledger.status();
    expect(status.headSequence).toBe(2);
    expect(status.headEventSha256).toBe(second.record.eventSha256);
    expect(status.eventCount).toBe(2);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("stores the event body in canonical form", () => {
    const ledger = open(temporaryDatabase());
    const result = ledger.append(makeEvent({ payload: { zebra: 1, alpha: 2 } }));
    expect(result.record.canonicalJson).toBe(canonicalJsonStringify(result.record.event));
  });

  it("treats an exact replay as a no-op and returns the original record", () => {
    const ledger = open(temporaryDatabase());
    const event = makeEvent();

    const first = ledger.append(event);
    const replay = ledger.append(event);

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.record.sequence).toBe(first.record.sequence);
    expect(replay.record.eventSha256).toBe(first.record.eventSha256);
    expect(ledger.status().eventCount).toBe(1);
  });

  it("rejects the same idempotency key carrying different content", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();

    ledger.append(makeEvent({ taskId, transitionId: "step", payload: { marker: 1 } }));
    const error = caught(() =>
      ledger.append(makeEvent({ taskId, transitionId: "step", payload: { marker: 2 } })),
    );

    expect(error).toBeInstanceOf(LedgerIdempotencyConflictError);
    const conflict = error as LedgerIdempotencyConflictError;
    expect(conflict.storedContentSha256).not.toBe(conflict.incomingContentSha256);
    expect(ledger.status().eventCount).toBe(1);
  });

  it("rejects reuse of an event id under another idempotency key", () => {
    const ledger = open(temporaryDatabase());
    const eventId = randomUUID();
    const taskId = randomUUID();

    ledger.append(makeEvent({ eventId, taskId, transitionId: "one" }));
    const error = caught(() =>
      ledger.append(makeEvent({ eventId, taskId: randomUUID(), transitionId: "two" })),
    );

    expect(error).toBeInstanceOf(LedgerEventIdConflictError);
    expect(ledger.status().eventCount).toBe(1);
  });

  it("requires a null fromState for the first event of a task", () => {
    const ledger = open(temporaryDatabase());
    const error = caught(() =>
      ledger.append(makeEvent({ fromState: "READY", toState: "RESERVED" })),
    );

    expect(error).toBeInstanceOf(LedgerLifecycleConflictError);
    expect((error as LedgerLifecycleConflictError).actualCurrentState).toBeNull();
    expect(ledger.status().eventCount).toBe(0);
  });

  it("rejects a stale transition computed against a state the task has left", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedTask(ledger, taskId, "kimi/k3/coordinator/01");

    // The task is READY. A writer that still believes it is DT_CLASSIFIED
    // must not be able to append on top of the newer state.
    const error = caught(() =>
      ledger.append(
        makeEvent({
          taskId,
          transitionId: "stale",
          type: "SLOT_RESERVED",
          fromState: "DT_CLASSIFIED",
          toState: "RESERVED",
        }),
      ),
    );

    expect(error).toBeInstanceOf(LedgerLifecycleConflictError);
    const conflict = error as LedgerLifecycleConflictError;
    expect(conflict.declaredFromState).toBe("DT_CLASSIFIED");
    expect(conflict.actualCurrentState).toBe("READY");
    expect(ledger.status().eventCount).toBe(3);
  });

  it("rejects an event that is not a valid ControlPlaneEvent", () => {
    const ledger = open(temporaryDatabase());
    expect(caught(() => ledger.append({ nonsense: true }))).toBeInstanceOf(
      LedgerValidationError,
    );
    expect(ledger.status().eventCount).toBe(0);
  });

  it("inherits the credential and transcript guards from the contracts package", () => {
    const ledger = open(temporaryDatabase());

    expect(
      caught(() => ledger.append(makeEvent({ payload: { apiKey: "placeholder" } }))),
    ).toBeInstanceOf(LedgerValidationError);
    expect(
      caught(() => ledger.append(makeEvent({ payload: { sessionToken: "placeholder" } }))),
    ).toBeInstanceOf(LedgerValidationError);
    expect(
      caught(() => ledger.append(makeEvent({ payload: { transcript: ["turn one"] } }))),
    ).toBeInstanceOf(LedgerValidationError);
    expect(
      caught(() => ledger.append(makeEvent({ payload: { conversation: ["turn one"] } }))),
    ).toBeInstanceOf(LedgerValidationError);

    expect(ledger.status().eventCount).toBe(0);
  });

  it("keeps rejected payload content out of its own diagnostics", () => {
    const ledger = open(temporaryDatabase());
    const marker = "sentinel-content-that-must-never-be-logged";

    const validation = caught(() =>
      ledger.append(makeEvent({ payload: { apiKey: marker, transcript: [marker] } })),
    );
    expect(validation).toBeInstanceOf(LedgerValidationError);
    const validationText =
      String(validation) + JSON.stringify((validation as LedgerValidationError).issues);
    expect(validationText).not.toContain(marker);

    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "step", payload: { note: "first" } }));
    const conflict = caught(() =>
      ledger.append(makeEvent({ taskId, transitionId: "step", payload: { note: marker } })),
    );
    expect(conflict).toBeInstanceOf(LedgerIdempotencyConflictError);
    expect(String(conflict)).not.toContain(marker);
    expect(JSON.stringify(conflict, Object.getOwnPropertyNames(conflict))).not.toContain(marker);
  });

  it("rejects a payload value that has no lossless JSON form", () => {
    const ledger = open(temporaryDatabase());
    const event = makeEvent();
    (event["payload"] as Record<string, unknown>)["when"] = new Date(0);

    expect(caught(() => ledger.append(event))).toBeInstanceOf(LedgerCanonicalizationError);
    expect(ledger.status().eventCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe("atomicity", () => {
  it("rolls the event back when projection fails", () => {
    const path = temporaryDatabase();
    let injectFailure = false;
    const ledger = open(path, {
      __testFaults: {
        beforeProjection: () => {
          if (injectFailure) throw new Error("injected projection failure");
        },
      },
    });

    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover" }));

    injectFailure = true;
    const error = caught(() =>
      ledger.append(
        makeEvent({
          taskId,
          transitionId: "classify",
          type: "TASK_CLASSIFIED",
          fromState: "DISCOVERED",
          toState: "DT_CLASSIFIED",
        }),
      ),
    );
    injectFailure = false;

    expect(error).toBeInstanceOf(Error);
    // The event must not survive its own projection failure.
    expect(ledger.status().eventCount).toBe(1);
    expect(ledger.status().headSequence).toBe(1);
    expect(ledger.getTask(taskId)?.currentState).toBe("DISCOVERED");
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // The handle is still usable, so the rollback was clean rather than wedged.
    const recovered = ledger.append(
      makeEvent({
        taskId,
        transitionId: "classify",
        type: "TASK_CLASSIFIED",
        fromState: "DISCOVERED",
        toState: "DT_CLASSIFIED",
      }),
    );
    expect(recovered.record.sequence).toBe(2);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("rolls the event and the projection back when the commit step fails", () => {
    let injectFailure = false;
    const ledger = open(temporaryDatabase(), {
      __testFaults: {
        beforeAppendCommit: () => {
          if (injectFailure) throw new Error("injected commit failure");
        },
      },
    });

    injectFailure = true;
    const taskId = randomUUID();
    expect(caught(() => ledger.append(makeEvent({ taskId })))).toBeInstanceOf(Error);
    injectFailure = false;

    expect(ledger.status().eventCount).toBe(0);
    expect(ledger.getTask(taskId)).toBeNull();
    expect(ledger.listWorkers().workers).toHaveLength(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Append-only enforcement
// ---------------------------------------------------------------------------

describe("append-only enforcement", () => {
  it("denies UPDATE and DELETE on the event table at the database level", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedTask(ledger, randomUUID(), "claude/opus/implementer/01");
    ledger.close();

    const raw = new Database(path);
    try {
      const update = caught(() =>
        raw
          .prepare("UPDATE control_plane_events SET to_state = ? WHERE sequence = ?")
          .run("FAILED", 1),
      );
      expect(String(update)).toContain("append-only");

      const remove = caught(() =>
        raw.prepare("DELETE FROM control_plane_events WHERE sequence = ?").run(1),
      );
      expect(String(remove)).toContain("append-only");

      expect(raw.prepare("SELECT COUNT(*) AS n FROM control_plane_events").get()).toEqual({
        n: 3,
      });
    } finally {
      raw.close();
    }
  });

  it("does not expose any raw mutation path on the public handle", () => {
    const ledger = open(temporaryDatabase());
    const surface = new Set<string>();
    let cursor: object | null = ledger as object;
    while (cursor !== null && cursor !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(cursor)) surface.add(name);
      cursor = Object.getPrototypeOf(cursor) as object | null;
    }
    for (const forbidden of ["db", "database", "prepare", "exec", "pragma", "transaction"]) {
      expect(surface.has(forbidden), forbidden).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Read models and queries
// ---------------------------------------------------------------------------

const ALPHA = "aaaaaaaa-0000-4000-8000-000000000001";
const BRAVO = "bbbbbbbb-0000-4000-8000-000000000002";
const OPUS = "claude/opus/implementer/01";
const KIMI = "kimi/k3/coordinator/01";

/** Two tasks, two emitters, five events, deliberately interleaved. */
function seedFixture(ledger: Ledger): void {
  ledger.append(makeEvent({ taskId: ALPHA, transitionId: "discover", emittedBy: KIMI }));
  ledger.append(makeEvent({ taskId: BRAVO, transitionId: "discover", emittedBy: KIMI }));
  ledger.append(
    makeEvent({
      taskId: ALPHA,
      transitionId: "classify",
      type: "TASK_CLASSIFIED",
      fromState: "DISCOVERED",
      toState: "DT_CLASSIFIED",
      emittedBy: KIMI,
    }),
  );
  ledger.append(
    makeEvent({
      taskId: ALPHA,
      transitionId: "ready",
      type: "TASK_READY",
      fromState: "DT_CLASSIFIED",
      toState: "READY",
      emittedBy: OPUS,
    }),
  );
  ledger.append(
    makeEvent({
      taskId: BRAVO,
      transitionId: "cancel",
      type: "TASK_CANCELLED",
      fromState: "DISCOVERED",
      toState: "CANCELLED",
      emittedBy: OPUS,
    }),
  );
}

describe("read models", () => {
  it("projects task state, counts and terminality from the event stream", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);

    const alpha = ledger.getTask(ALPHA);
    expect(alpha).not.toBeNull();
    expect(alpha?.currentState).toBe("READY");
    expect(alpha?.eventCount).toBe(3);
    expect(alpha?.firstSequence).toBe(1);
    expect(alpha?.lastSequence).toBe(4);
    expect(alpha?.lastEmittedBy).toBe(OPUS);
    expect(alpha?.isTerminal).toBe(false);

    const bravo = ledger.getTask(BRAVO);
    expect(bravo?.currentState).toBe("CANCELLED");
    expect(bravo?.isTerminal).toBe(true);

    expect(ledger.getTask(randomUUID())).toBeNull();
  });

  it("projects observed workers from emittedBy, counting distinct tasks", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);

    const kimi = ledger.getWorker(KIMI);
    expect(kimi?.provider).toBe("kimi");
    expect(kimi?.model).toBe("k3");
    expect(kimi?.role).toBe("coordinator");
    expect(kimi?.instance).toBe("01");
    expect(kimi?.eventCount).toBe(3);
    expect(kimi?.taskCount).toBe(2);

    const opus = ledger.getWorker(OPUS);
    expect(opus?.role).toBe("implementer");
    expect(opus?.eventCount).toBe(2);
    expect(opus?.taskCount).toBe(2);

    // A worker only exists here because it emitted something.
    expect(ledger.getWorker("codex/gpt/consultant/01")).toBeNull();
  });

  it("survives a reopen with identical projections and events", () => {
    const path = temporaryDatabase();
    const first = open(path);
    seedFixture(first);
    const beforeTasks = JSON.stringify(first.listTasks());
    const beforeWorkers = JSON.stringify(first.listWorkers());
    const beforeHead = first.status().headEventSha256;
    first.close();

    const second = open(path);
    expect(JSON.stringify(second.listTasks())).toBe(beforeTasks);
    expect(JSON.stringify(second.listWorkers())).toBe(beforeWorkers);
    expect(second.status().headEventSha256).toBe(beforeHead);
    expect(second.verifyIntegrity().ok).toBe(true);
  });
});

describe("queries", () => {
  it("returns events in sequence order and pages with an exclusive cursor", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);

    const all = ledger.listEvents();
    expect(all.events.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(all.hasMore).toBe(false);
    expect(all.nextCursor).toBeNull();

    const firstPage = ledger.listEvents({ limit: 2 });
    expect(firstPage.events.map((record) => record.sequence)).toEqual([1, 2]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBe(2);

    const secondPage = ledger.listEvents({ limit: 2, afterSequence: firstPage.nextCursor ?? 0 });
    expect(secondPage.events.map((record) => record.sequence)).toEqual([3, 4]);

    const lastPage = ledger.listEvents({ limit: 2, afterSequence: secondPage.nextCursor ?? 0 });
    expect(lastPage.events.map((record) => record.sequence)).toEqual([5]);
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.nextCursor).toBeNull();
  });

  it("filters events by task, type, emitter and destination state", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);

    expect(ledger.listEvents({ taskId: ALPHA }).events.map((r) => r.sequence)).toEqual([1, 3, 4]);
    expect(ledger.listEvents({ type: "TASK_DISCOVERED" }).events.map((r) => r.sequence)).toEqual([
      1, 2,
    ]);
    expect(ledger.listEvents({ emittedBy: OPUS }).events.map((r) => r.sequence)).toEqual([4, 5]);
    expect(ledger.listEvents({ toState: "CANCELLED" }).events.map((r) => r.sequence)).toEqual([5]);
    expect(
      ledger.listEvents({ taskId: ALPHA, emittedBy: OPUS }).events.map((r) => r.sequence),
    ).toEqual([4]);
  });

  it("looks events up by id, sequence and idempotency key", () => {
    const ledger = open(temporaryDatabase());
    const appended = ledger.append(makeEvent({ taskId: ALPHA, transitionId: "discover" }));

    expect(ledger.getEvent(appended.record.eventId)?.sequence).toBe(1);
    expect(ledger.getEventBySequence(1)?.eventId).toBe(appended.record.eventId);
    expect(ledger.getEventByIdempotencyKey(appended.record.idempotencyKey)?.sequence).toBe(1);

    expect(ledger.getEvent(randomUUID())).toBeNull();
    expect(ledger.getEventBySequence(99)).toBeNull();
    expect(ledger.getEventByIdempotencyKey("nope/1/nope")).toBeNull();
  });

  it("orders tasks and workers by their identifiers and pages deterministically", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);

    expect(ledger.listTasks().tasks.map((task) => task.taskId)).toEqual([ALPHA, BRAVO]);
    expect(ledger.listWorkers().workers.map((worker) => worker.identity)).toEqual([OPUS, KIMI]);

    const page = ledger.listTasks({ limit: 1 });
    expect(page.tasks.map((task) => task.taskId)).toEqual([ALPHA]);
    expect(page.nextCursor).toBe(ALPHA);
    expect(
      ledger.listTasks({ limit: 1, afterTaskId: page.nextCursor ?? "" }).tasks.map((t) => t.taskId),
    ).toEqual([BRAVO]);

    expect(ledger.listTasks({ state: "CANCELLED" }).tasks.map((t) => t.taskId)).toEqual([BRAVO]);
    expect(ledger.listWorkers({ role: "coordinator" }).workers.map((w) => w.identity)).toEqual([
      KIMI,
    ]);
    expect(ledger.listWorkers({ provider: "claude" }).workers.map((w) => w.identity)).toEqual([
      OPUS,
    ]);
  });

  it("bounds every page limit", () => {
    const ledger = open(temporaryDatabase());
    expect(caught(() => ledger.listEvents({ limit: 0 }))).toBeInstanceOf(LedgerQueryError);
    expect(caught(() => ledger.listEvents({ limit: 5_000 }))).toBeInstanceOf(LedgerQueryError);
    expect(caught(() => ledger.listTasks({ limit: -1 }))).toBeInstanceOf(LedgerQueryError);
    expect(caught(() => ledger.listWorkers({ limit: 1.5 }))).toBeInstanceOf(LedgerQueryError);
    expect(caught(() => ledger.listEvents({ afterSequence: -1 }))).toBeInstanceOf(
      LedgerQueryError,
    );
  });
});

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

describe("rebuild", () => {
  it("is deterministic and byte equivalent across repeated rebuilds", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);

    const liveTasks = JSON.stringify(ledger.listTasks());
    const liveWorkers = JSON.stringify(ledger.listWorkers());

    const first = ledger.rebuildReadModel();
    expect(first.replayedEvents).toBe(5);
    expect(first.throughSequence).toBe(5);
    expect(first.taskRows).toBe(2);
    expect(first.workerRows).toBe(2);

    const afterFirstTasks = JSON.stringify(ledger.listTasks());
    const afterFirstWorkers = JSON.stringify(ledger.listWorkers());

    // The incremental projection and a full replay must agree exactly.
    expect(afterFirstTasks).toBe(liveTasks);
    expect(afterFirstWorkers).toBe(liveWorkers);

    ledger.rebuildReadModel();
    expect(JSON.stringify(ledger.listTasks())).toBe(afterFirstTasks);
    expect(JSON.stringify(ledger.listWorkers())).toBe(afterFirstWorkers);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("repairs a corrupted projection", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    const healthy = JSON.stringify(ledger.listTasks());
    ledger.close();

    const raw = new Database(path);
    raw.prepare("UPDATE task_read_model SET current_state = ? WHERE task_id = ?").run(
      "FAILED",
      ALPHA,
    );
    raw.close();

    const reopened = open(path);
    const damaged = reopened.verifyIntegrity();
    expect(damaged.ok).toBe(false);
    expect(damaged.problems.some((problem) => problem.kind === "PROJECTION")).toBe(true);

    reopened.rebuildReadModel();
    expect(JSON.stringify(reopened.listTasks())).toBe(healthy);
    expect(reopened.verifyIntegrity().ok).toBe(true);
  });

  it("leaves the previous projection intact when a rebuild fails", () => {
    let injectFailure = false;
    const ledger = open(temporaryDatabase(), {
      __testFaults: {
        beforeRebuildCommit: () => {
          if (injectFailure) throw new Error("injected rebuild failure");
        },
      },
    });
    seedFixture(ledger);

    const before = JSON.stringify(ledger.listTasks());
    const beforeWorkers = JSON.stringify(ledger.listWorkers());

    injectFailure = true;
    expect(caught(() => ledger.rebuildReadModel())).toBeInstanceOf(Error);
    injectFailure = false;

    expect(JSON.stringify(ledger.listTasks())).toBe(before);
    expect(JSON.stringify(ledger.listWorkers())).toBe(beforeWorkers);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tamper detection
// ---------------------------------------------------------------------------

/**
 * Reach past the append-only triggers to simulate an attacker or a careless
 * repair script. Only a test may do this, and only on a temporary file.
 */
function tamper(path: string, mutate: (raw: Database.Database) => void): void {
  const raw = new Database(path);
  try {
    raw.exec(
      "DROP TRIGGER control_plane_events_deny_update; " +
        "DROP TRIGGER control_plane_events_deny_delete;",
    );
    mutate(raw);
  } finally {
    raw.close();
  }
}

describe("tamper detection", () => {
  it("detects a stored body that was rewritten out of canonical form", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    tamper(path, (raw) => {
      const row = raw.prepare("SELECT event_json FROM control_plane_events WHERE sequence = ?").get(
        2,
      ) as { readonly event_json: string };
      const decoded = JSON.parse(row.event_json) as Record<string, unknown>;
      // Same content, non canonical key order.
      const reordered = Object.fromEntries(Object.entries(decoded).reverse());
      raw
        .prepare("UPDATE control_plane_events SET event_json = ? WHERE sequence = ?")
        .run(JSON.stringify(reordered), 2);
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.kind === "EVENT_JSON")).toBe(true);
  });

  it("detects a stored body whose content was changed", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    tamper(path, (raw) => {
      const row = raw.prepare("SELECT event_json FROM control_plane_events WHERE sequence = ?").get(
        1,
      ) as { readonly event_json: string };
      const decoded = JSON.parse(row.event_json) as Record<string, unknown>;
      decoded["toState"] = "COMMITTED";
      raw
        .prepare("UPDATE control_plane_events SET event_json = ? WHERE sequence = ?")
        .run(canonicalJsonStringify(decoded), 1);
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    // The columns no longer agree with the body, and the digest no longer
    // matches the content it was computed over.
    expect(report.problems.some((problem) => problem.kind === "EVENT_COORDINATES")).toBe(true);
    expect(report.problems.some((problem) => problem.kind === "HASH_CHAIN")).toBe(true);
  });

  it("detects a rewritten hash chain link", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    tamper(path, (raw) => {
      raw
        .prepare("UPDATE control_plane_events SET event_sha256 = ? WHERE sequence = ?")
        .run("f".repeat(64), 3);
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.kind === "HASH_CHAIN")).toBe(true);
  });

  it("detects a truncated tail through the head metadata", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    tamper(path, (raw) => {
      raw.prepare("DELETE FROM control_plane_events WHERE sequence = ?").run(5);
    });

    const reopened = open(path);
    const report = reopened.verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.kind === "LEDGER_META")).toBe(true);

    // A rebuild must refuse rather than launder the truncation into a clean
    // looking read model.
    expect(caught(() => reopened.rebuildReadModel())).toBeInstanceOf(LedgerIntegrityError);
  });

  it("detects a gap in the middle of the log", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    tamper(path, (raw) => {
      raw.prepare("DELETE FROM control_plane_events WHERE sequence = ?").run(3);
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.kind === "SEQUENCE")).toBe(true);
  });

  it("detects removal of the append-only triggers", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    tamper(path, () => {
      // Dropping the triggers is the whole tamper: nothing else is changed.
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    const schemaProblems = report.problems.filter(
      (problem) => problem.kind === "SCHEMA_SHAPE",
    );
    expect(schemaProblems).toHaveLength(2);
    expect(schemaProblems.map((problem) => problem.detail).join(" ")).toContain(
      "control_plane_events_deny_delete",
    );
  });

  it("refuses to serve a tampered event through the read path", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    tamper(path, (raw) => {
      raw
        .prepare("UPDATE control_plane_events SET event_json = ? WHERE sequence = ?")
        .run("{not json", 1);
    });

    const reopened = open(path);
    expect(caught(() => reopened.listEvents())).toBeInstanceOf(LedgerIntegrityError);
    expect(caught(() => reopened.getEventBySequence(1))).toBeInstanceOf(LedgerIntegrityError);
  });

  it("reports a healthy ledger as intact", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);

    const report = ledger.verifyIntegrity();
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkedEvents).toBe(5);
    expect(report.headSequence).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Derived state verification
//
// These tests damage only derived tables. They deliberately leave the schema,
// the triggers and the event stream alone, so every assertion below also
// checks that no SCHEMA_SHAPE or HASH_CHAIN problem was raised. Without that
// guard a test could pass because something unrelated broke, which would make
// it evidence of nothing.
// ---------------------------------------------------------------------------

const GHOST_TASK = "cccccccc-0000-4000-8000-000000000003";

/** A raw handle that leaves the append-only triggers and the schema intact. */
function withRawDatabase(path: string, mutate: (raw: Database.Database) => void): void {
  const raw = new Database(path);
  try {
    mutate(raw);
  } finally {
    raw.close();
  }
}

function kindsOf(problems: readonly { readonly kind: string }[]): string[] {
  return problems.map((problem) => problem.kind);
}

function detailsOf(problems: readonly { readonly detail: string }[]): string {
  return problems.map((problem) => problem.detail).join(" | ");
}

describe("worker task association verification", () => {
  it("detects a substituted association even though the row count is unchanged", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      const count = raw.prepare("SELECT COUNT(*) AS n FROM worker_task_read_model");
      const before = (count.get() as { readonly n: number }).n;

      raw
        .prepare("DELETE FROM worker_task_read_model WHERE identity = ? AND task_id = ?")
        .run(KIMI, BRAVO);
      raw
        .prepare(
          "INSERT INTO worker_task_read_model (identity, task_id, event_count, last_sequence) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run(KIMI, GHOST_TASK, 1, 2);

      // This is the case a count comparison cannot see.
      expect((count.get() as { readonly n: number }).n).toBe(before);
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(2);
    expect(new Set(kindsOf(report.problems))).toEqual(new Set(["PROJECTION"]));
    expect(detailsOf(report.problems)).toContain("is missing the association");
    expect(detailsOf(report.problems)).toContain("which no event accounts for");
  });

  it("detects an association whose counters were altered", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "UPDATE worker_task_read_model SET event_count = ? WHERE identity = ? AND task_id = ?",
        )
        .run(99, KIMI, ALPHA);
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION"]);
    expect(detailsOf(report.problems)).toContain("disagrees with a replay");
  });

  it("detects a missing association", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare("DELETE FROM worker_task_read_model WHERE identity = ? AND task_id = ?")
        .run(OPUS, ALPHA);
    });

    const report = open(path).verifyIntegrity();
    expect(report.problems).toHaveLength(1);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION"]);
    expect(detailsOf(report.problems)).toContain("is missing the association");
  });

  it("detects an extra association", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "INSERT INTO worker_task_read_model (identity, task_id, event_count, last_sequence) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run(OPUS, GHOST_TASK, 1, 1);
    });

    const report = open(path).verifyIntegrity();
    expect(report.problems).toHaveLength(1);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION"]);
    expect(detailsOf(report.problems)).toContain("which no event accounts for");
  });

  it("repairs every association damage with a rebuild", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare("DELETE FROM worker_task_read_model WHERE identity = ? AND task_id = ?")
        .run(KIMI, BRAVO);
    });

    const reopened = open(path);
    expect(reopened.verifyIntegrity().ok).toBe(false);
    reopened.rebuildReadModel();
    expect(reopened.verifyIntegrity().ok).toBe(true);
  });
});

describe("projection metadata verification", () => {
  it("detects a missing projection metadata row", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw.prepare("DELETE FROM projection_meta WHERE name = ?").run("worker_read_model");
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain("missing the row for worker_read_model");
  });

  it("detects an extra projection metadata row", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "INSERT INTO projection_meta (name, applied_through_sequence, event_count, " +
            "source_head_sha256, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("rogue_projection", 5, 5, "0".repeat(64), "2026-08-27T12:00:00.000Z");
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "rogue_projection which this build does not define",
    );
  });

  it("detects a projection frozen at a stale sequence", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare("UPDATE projection_meta SET applied_through_sequence = ? WHERE name = ?")
        .run(3, "task_read_model");
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "is applied through sequence 3 but the head of the ledger is sequence 5",
    );
  });

  it("accepts an empty ledger, where every projection is level with sequence zero", () => {
    const ledger = open(temporaryDatabase());
    const report = ledger.verifyIntegrity();

    expect(report.problems).toEqual([]);
    expect(report.headSequence).toBe(0);
    expect(ledger.status().projections.map((projection) => projection.appliedThroughSequence)).toEqual(
      [0, 0, 0, 0],
    );
  });

  it("keeps every projection level with the head of its own stream", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);

    // Each projection follows one stream. The task projections move with the
    // five seeded task events; the initiative projections stay at zero,
    // because nothing has been appended to the sibling stream. Holding them
    // all to one number would be the bug this separation exists to prevent.
    const levels = new Map(
      ledger.status().projections.map((projection) => [projection.name, projection.appliedThroughSequence]),
    );
    expect(levels.get("task_read_model")).toBe(5);
    expect(levels.get("worker_read_model")).toBe(5);
    expect(levels.get("initiative_read_model")).toBe(0);
    expect(levels.get("roadmap_version_read_model")).toBe(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});

describe("status refuses an unexpected projection name", () => {
  it("never interpolates a name this build does not define", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "INSERT INTO projection_meta (name, applied_through_sequence, event_count, " +
            "source_head_sha256, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("not_a_real_table", 5, 5, "0".repeat(64), "2026-08-27T12:00:00.000Z");
    });

    const reopened = open(path);
    const error = caught(() => reopened.status());

    expect(error).toBeInstanceOf(LedgerIntegrityError);
    expect(String(error)).toContain("not_a_real_table");
    // Had the name reached the query, SQLite would have reported the missing
    // table instead. Its absence is the proof that the guard ran first.
    expect(String(error)).not.toContain("no such table");
  });

  it("refuses an injection shaped name without echoing it or executing it", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "INSERT INTO projection_meta (name, applied_through_sequence, event_count, " +
            "source_head_sha256, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "task_read_model; DROP TABLE ledger_meta",
          5,
          5,
          "0".repeat(64),
          "2026-08-27T12:00:00.000Z",
        );
    });

    const reopened = open(path);
    const error = caught(() => reopened.status());

    expect(error).toBeInstanceOf(LedgerIntegrityError);
    // The name is database content, so it is never echoed verbatim.
    expect(String(error)).toContain("<unprintable name>");
    expect(String(error)).not.toContain("DROP");

    // Reading the head still works, so ledger_meta was never dropped.
    const report = reopened.verifyIntegrity();
    expect(report.headSequence).toBe(5);
    expect(report.checkedEvents).toBe(5);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
  });
});

// ---------------------------------------------------------------------------
// Cross-process concurrency
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const WORKER_ENTRY = join(
  PACKAGE_ROOT,
  "dist-test",
  "test",
  "concurrent-writer-worker",
  "index.js",
);

interface WorkerOutcome {
  readonly ok: boolean;
  readonly inserted: boolean | null;
  readonly sequence: number | null;
  readonly eventSha256: string | null;
  readonly errorName: string | null;
}

/**
 * A child process cannot use the vitest alias that points @acp/contracts at
 * its TypeScript source, so the compiled entry point is what it runs. The
 * worker now lives under `test/`, outside the package's shipped `src/`
 * build, so it is compiled by the test tree's own `tsconfig.json` into
 * `dist-test/`, never into the published `dist/`. The build is normally
 * already there, because `pnpm check` typechecks before it tests; this only
 * pays for a build when the tests are run on their own.
 */
function ensureWorkerBuilt(): void {
  if (existsSync(WORKER_ENTRY)) return;
  const result = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "--build",
      join(PACKAGE_ROOT, "test", "tsconfig.json"),
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (result.status !== 0 || !existsSync(WORKER_ENTRY)) {
    throw new Error(
      "could not build the ledger test tree for the cross-process test: " +
        result.stdout +
        result.stderr,
    );
  }
}

function runWorker(databasePath: string, eventJson: string): Promise<WorkerOutcome> {
  return new Promise<WorkerOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_ENTRY, databasePath, eventJson], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      const line = stdout.trim().split("\n").at(-1);
      if (line === undefined || line === "") {
        reject(new Error("worker produced no outcome line: " + stderr));
        return;
      }
      resolve(JSON.parse(line) as WorkerOutcome);
    });
  });
}

describe("cross-process concurrency", () => {
  it("inserts an exact replay once when four separate processes race", async () => {
    ensureWorkerBuilt();
    const path = temporaryDatabase();

    // Create and migrate, then release the file so the children genuinely
    // contend for the write lock rather than queueing behind this handle.
    open(path).close();

    const event = makeEvent({ transitionId: "concurrent-exact" });
    const eventJson = JSON.stringify(event);

    const outcomes = await Promise.all([
      runWorker(path, eventJson),
      runWorker(path, eventJson),
      runWorker(path, eventJson),
      runWorker(path, eventJson),
    ]);

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(outcomes.filter((outcome) => outcome.inserted === true)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.inserted === false)).toHaveLength(3);

    // Every process agrees on the position and the digest.
    expect(new Set(outcomes.map((outcome) => outcome.sequence))).toEqual(new Set([1]));
    expect(new Set(outcomes.map((outcome) => outcome.eventSha256)).size).toBe(1);

    const verifier = open(path, { readOnly: true });
    expect(verifier.status().eventCount).toBe(1);
    expect(verifier.verifyIntegrity().ok).toBe(true);
  });

  it("lets exactly one process win when four race with conflicting content", async () => {
    ensureWorkerBuilt();
    const path = temporaryDatabase();
    open(path).close();

    const taskId = randomUUID();
    const payloads = [1, 2, 3, 4].map((marker) =>
      JSON.stringify(
        makeEvent({ taskId, transitionId: "concurrent-conflict", payload: { marker } }),
      ),
    );

    const outcomes = await Promise.all(payloads.map((json) => runWorker(path, json)));

    const winners = outcomes.filter((outcome) => outcome.ok && outcome.inserted === true);
    const losers = outcomes.filter((outcome) => !outcome.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);
    expect(
      losers.every((outcome) => outcome.errorName === "LedgerIdempotencyConflictError"),
    ).toBe(true);

    const verifier = open(path, { readOnly: true });
    expect(verifier.status().eventCount).toBe(1);
    expect(verifier.verifyIntegrity().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The initiative stream
//
// The sibling stream lives in the same database under the same laws: its own
// chain, its own head, its own contiguity guard. These tests hold it to the
// task stream's standard rather than to a weaker one.
// ---------------------------------------------------------------------------

const INITIATIVE_A = "44444444-4444-4444-8444-444444444444";
const INITIATIVE_B = "55555555-5555-4555-8555-555555555555";
const VERSION_ONE_ID = "66666666-6666-4666-8666-666666666601";
const VERSION_TWO_ID = "66666666-6666-4666-8666-666666666602";
const DIGEST_ONE = "a".repeat(64);
const DIGEST_TWO = "b".repeat(64);

interface InitiativeEventInput {
  readonly initiativeId?: string;
  readonly transitionId?: string;
  readonly eventId?: string;
  readonly type?: string;
  readonly fromStatus?: string | null;
  readonly toStatus?: string;
  readonly emittedBy?: string;
  readonly occurredAt?: string;
  readonly payload?: Record<string, unknown>;
}

function makeInitiativeEvent(input: InitiativeEventInput = {}): Record<string, unknown> {
  const initiativeId = input.initiativeId ?? INITIATIVE_A;
  const transitionId = input.transitionId ?? "initiative.registered";
  const occurredAt = input.occurredAt ?? "2026-08-30T12:00:00.000Z";
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: input.eventId ?? randomUUID(),
    initiativeId,
    transitionId,
    idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId, transitionId }),
    type: input.type ?? "INITIATIVE_REGISTERED",
    fromStatus: input.fromStatus === undefined ? null : input.fromStatus,
    toStatus: input.toStatus ?? "ACTIVE",
    emittedBy: input.emittedBy ?? "kimi/k3/coordinator/01",
    occurredAt,
    recordedAt: occurredAt,
    payload: input.payload ?? {},
  };
}

function roadmapVersionValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    roadmapVersionId: VERSION_ONE_ID,
    initiativeId: INITIATIVE_A,
    version: 1,
    contentDigest: DIGEST_ONE,
    parentVersionId: null,
    expectedHeadDigest: null,
    kind: "EDIT",
    restoresVersionId: null,
    recordedBy: "kimi/k3/coordinator/01",
    recordedAt: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("the initiative stream appends under the ledger's own laws", () => {
  it("round-trips an event on its own chain, leaving the task stream untouched", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);
    const taskHead = ledger.status().headSequence;

    const result = ledger.appendInitiativeEvent(makeInitiativeEvent());

    expect(result.inserted).toBe(true);
    expect(result.record.sequence).toBe(1);
    expect(result.record.previousSha256).toBe(GENESIS_SHA256);
    expect(result.record.eventSha256).toBe(
      chainDigest(GENESIS_SHA256, result.record.canonicalJson),
    );

    const status = ledger.status();
    expect(status.initiativeHeadSequence).toBe(1);
    expect(status.initiativeEventCount).toBe(1);
    expect(status.initiativeHeadEventSha256).toBe(result.record.eventSha256);
    // The two streams share a database and nothing else.
    expect(status.headSequence).toBe(taskHead);

    const initiative = ledger.getInitiative(INITIATIVE_A);
    expect(initiative?.currentStatus).toBe("ACTIVE");
    expect(initiative?.eventCount).toBe(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("enumerates the portfolio in a stable order, and holds nothing a stream did not say", () => {
    const ledger = open(temporaryDatabase());
    expect(ledger.listInitiatives()).toEqual([]);

    // Registered out of creation order on purpose: the enumerator sorts, it
    // does not echo insertion order.
    ledger.appendInitiativeEvent(
      makeInitiativeEvent({ initiativeId: INITIATIVE_B, occurredAt: "2026-08-30T13:00:00.000Z" }),
    );
    ledger.appendInitiativeEvent(
      makeInitiativeEvent({ initiativeId: INITIATIVE_A, occurredAt: "2026-08-30T12:00:00.000Z" }),
    );

    const portfolio = ledger.listInitiatives();
    expect(portfolio.map((initiative) => initiative.initiativeId)).toEqual([
      INITIATIVE_A,
      INITIATIVE_B,
    ]);
    // Two reads of an unchanged ledger return the same rows in the same order.
    expect(ledger.listInitiatives()).toEqual(portfolio);
    // Every row is the projection's own, carrying no fact the stream did not
    // record: `getInitiative` and the enumerator agree exactly.
    for (const initiative of portfolio) {
      expect(ledger.getInitiative(initiative.initiativeId)).toEqual(initiative);
    }
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("moves an initiative's row with its status rather than adding a second", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendInitiativeEvent(
      makeInitiativeEvent({
        transitionId: "initiative.paused",
        type: "INITIATIVE_STATE_CHANGED",
        fromStatus: "ACTIVE",
        toStatus: "PAUSED",
      }),
    );

    const portfolio = ledger.listInitiatives();
    expect(portfolio.length).toBe(1);
    expect(portfolio[0]?.currentStatus).toBe("PAUSED");
    expect(portfolio[0]?.eventCount).toBe(2);
  });

  it("chains a second event onto the first", () => {
    const ledger = open(temporaryDatabase());
    const first = ledger.appendInitiativeEvent(makeInitiativeEvent());
    const second = ledger.appendInitiativeEvent(
      makeInitiativeEvent({
        transitionId: "initiative.paused",
        type: "INITIATIVE_STATE_CHANGED",
        fromStatus: "ACTIVE",
        toStatus: "PAUSED",
      }),
    );

    expect(second.record.sequence).toBe(2);
    expect(second.record.previousSha256).toBe(first.record.eventSha256);
    expect(ledger.getInitiative(INITIATIVE_A)?.currentStatus).toBe("PAUSED");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("treats an exact replay as a no-op and refuses a different body at the same key", () => {
    const ledger = open(temporaryDatabase());
    const candidate = makeInitiativeEvent();
    const first = ledger.appendInitiativeEvent(candidate);
    const replay = ledger.appendInitiativeEvent(candidate);

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.record.eventSha256).toBe(first.record.eventSha256);
    expect(ledger.status().initiativeEventCount).toBe(1);

    const conflict = caught(() =>
      ledger.appendInitiativeEvent(
        makeInitiativeEvent({ eventId: randomUUID(), payload: { note: "different" } }),
      ),
    );
    expect(conflict).toBeInstanceOf(LedgerIdempotencyConflictError);
    expect(ledger.status().initiativeEventCount).toBe(1);
  });

  it("refuses reuse of an event id under another key", () => {
    const ledger = open(temporaryDatabase());
    const first = ledger.appendInitiativeEvent(makeInitiativeEvent());

    const error = caught(() =>
      ledger.appendInitiativeEvent(
        makeInitiativeEvent({
          eventId: first.record.event.eventId,
          transitionId: "initiative.paused",
          type: "INITIATIVE_STATE_CHANGED",
          fromStatus: "ACTIVE",
          toStatus: "PAUSED",
        }),
      ),
    );
    expect(error).toBeInstanceOf(LedgerEventIdConflictError);
    expect(ledger.status().initiativeEventCount).toBe(1);
  });

  it("enforces contiguity: a fromStatus that lies about the projection is refused", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendInitiativeEvent(makeInitiativeEvent());

    // The initiative is ACTIVE; this event claims it was COMPLETED.
    const error = caught(() =>
      ledger.appendInitiativeEvent(
        makeInitiativeEvent({
          transitionId: "initiative.archived",
          type: "INITIATIVE_STATE_CHANGED",
          fromStatus: "COMPLETED",
          toStatus: "ARCHIVED",
        }),
      ),
    );
    expect(error).toBeInstanceOf(LedgerLifecycleConflictError);
    expect(ledger.status().initiativeEventCount).toBe(1);
  });

  it("requires a null fromStatus for the first event of an initiative", () => {
    const ledger = open(temporaryDatabase());
    const error = caught(() =>
      ledger.appendInitiativeEvent(
        makeInitiativeEvent({
          initiativeId: INITIATIVE_B,
          transitionId: "initiative.paused",
          type: "INITIATIVE_STATE_CHANGED",
          fromStatus: "ACTIVE",
          toStatus: "PAUSED",
        }),
      ),
    );
    expect(error).toBeInstanceOf(LedgerLifecycleConflictError);
    expect(ledger.status().initiativeEventCount).toBe(0);
  });

  it("refuses a candidate the contract rejects", () => {
    const ledger = open(temporaryDatabase());
    const candidate = { ...makeInitiativeEvent(), idempotencyKey: "not-the-key" };
    const error = caught(() => ledger.appendInitiativeEvent(candidate));
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect(ledger.status().initiativeEventCount).toBe(0);
  });

  it("pages its events and keeps two initiatives apart", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendInitiativeEvent(makeInitiativeEvent({ initiativeId: INITIATIVE_B }));

    const all = ledger.listInitiativeEvents();
    expect(all.events.map((record) => record.event.initiativeId)).toEqual([
      INITIATIVE_A,
      INITIATIVE_B,
    ]);

    const onlyB = ledger.listInitiativeEvents({ initiativeId: INITIATIVE_B });
    expect(onlyB.events).toHaveLength(1);
    expect(onlyB.events[0]?.event.initiativeId).toBe(INITIATIVE_B);
  });
});

describe("the roadmap-version projection folds from the stream", () => {
  it("records a version whose payload carries one, and orders versions", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendInitiativeEvent(
      makeInitiativeEvent({
        transitionId: "roadmap.v1",
        type: "ROADMAP_VERSION_RECORDED",
        fromStatus: "ACTIVE",
        toStatus: "ACTIVE",
        payload: roadmapVersionValue(),
      }),
    );
    ledger.appendInitiativeEvent(
      makeInitiativeEvent({
        transitionId: "roadmap.v2",
        type: "ROADMAP_VERSION_RECORDED",
        fromStatus: "ACTIVE",
        toStatus: "ACTIVE",
        payload: roadmapVersionValue({
          roadmapVersionId: VERSION_TWO_ID,
          version: 2,
          contentDigest: DIGEST_TWO,
          parentVersionId: VERSION_ONE_ID,
          expectedHeadDigest: DIGEST_ONE,
        }),
      }),
    );

    const versions = ledger.listRoadmapVersions(INITIATIVE_A);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[1]?.parentVersionId).toBe(VERSION_ONE_ID);
    expect(versions[1]?.contentDigest).toBe(DIGEST_TWO);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("records no version when the payload does not carry one, and still folds the event", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendInitiativeEvent(
      makeInitiativeEvent({
        transitionId: "roadmap.unparseable",
        type: "ROADMAP_VERSION_RECORDED",
        fromStatus: "ACTIVE",
        toStatus: "ACTIVE",
        payload: { note: "not a roadmap version" },
      }),
    );

    // The event stands in the stream and moves the initiative projection; only
    // the version table is silent, because there was no version to record.
    expect(ledger.listRoadmapVersions(INITIATIVE_A)).toEqual([]);
    expect(ledger.getInitiative(INITIATIVE_A)?.eventCount).toBe(2);
    expect(ledger.status().initiativeEventCount).toBe(2);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("records no version when the payload names another initiative", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendInitiativeEvent(
      makeInitiativeEvent({
        transitionId: "roadmap.foreign",
        type: "ROADMAP_VERSION_RECORDED",
        fromStatus: "ACTIVE",
        toStatus: "ACTIVE",
        payload: roadmapVersionValue({ initiativeId: INITIATIVE_B }),
      }),
    );

    expect(ledger.listRoadmapVersions(INITIATIVE_A)).toEqual([]);
    expect(ledger.listRoadmapVersions(INITIATIVE_B)).toEqual([]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});

describe("both chains are verified and rebuilt together", () => {
  it("rebuilds both streams to identical projections", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendInitiativeEvent(
      makeInitiativeEvent({
        transitionId: "roadmap.v1",
        type: "ROADMAP_VERSION_RECORDED",
        fromStatus: "ACTIVE",
        toStatus: "ACTIVE",
        payload: roadmapVersionValue(),
      }),
    );

    const before = {
      initiative: ledger.getInitiative(INITIATIVE_A),
      versions: ledger.listRoadmapVersions(INITIATIVE_A),
      tasks: ledger.listTasks().tasks,
    };

    const result = ledger.rebuildReadModel();
    expect(result.replayedInitiativeEvents).toBe(2);
    expect(result.initiativeThroughSequence).toBe(2);
    expect(result.initiativeRows).toBe(1);
    expect(result.roadmapVersionRows).toBe(1);

    expect(ledger.getInitiative(INITIATIVE_A)).toEqual(before.initiative);
    expect(ledger.listRoadmapVersions(INITIATIVE_A)).toEqual(before.versions);
    expect(ledger.listTasks().tasks).toEqual(before.tasks);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("detects a tampered initiative body through the sibling chain", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.close();

    withRawDatabase(path, (raw) => {
      // The append-only trigger denies UPDATE, so the body is rewritten the
      // only way a tamperer could: by dropping the trigger first.
      raw.exec("DROP TRIGGER initiative_events_deny_update");
      raw
        .prepare("UPDATE initiative_events SET event_json = ? WHERE sequence = 1")
        .run('{"tampered":true}');
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsOf(report.problems)).toContain("HASH_CHAIN");
    expect(kindsOf(report.problems)).toContain("SCHEMA_SHAPE");
  });

  it("detects an initiative head that disagrees with the stream", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare("UPDATE ledger_meta SET value = ? WHERE key = ?")
        .run("7", "initiative_head_sequence");
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsOf(report.problems)).toContain("LEDGER_META");
    expect(detailsOf(report.problems)).toContain("initiative head is sequence 7");
  });

  it("denies UPDATE and DELETE on the initiative table at the database level", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.close();

    withRawDatabase(path, (raw) => {
      const update = caught(() =>
        raw.prepare("UPDATE initiative_events SET type = ? WHERE sequence = 1").run("X"),
      );
      const remove = caught(() => raw.prepare("DELETE FROM initiative_events").run());
      expect(String(update)).toContain("append-only");
      expect(String(remove)).toContain("append-only");
    });
  });
});

describe("the task projection carries an initiative when the discovery does", () => {
  it("folds the initiativeId out of the TASK_DISCOVERED payload", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(
      makeEvent({ taskId, transitionId: "discover", payload: { initiativeId: INITIATIVE_A } }),
    );

    expect(ledger.getTask(taskId)?.initiativeId).toBe(INITIATIVE_A);
  });

  it("folds an old-shape discovery to null, and carries the attribution forward", () => {
    const ledger = open(temporaryDatabase());
    const oldShape = randomUUID();
    const carried = randomUUID();

    // Exactly the event an older ledger holds: no initiativeId anywhere.
    ledger.append(makeEvent({ taskId: oldShape, transitionId: "discover" }));
    expect(ledger.getTask(oldShape)?.initiativeId).toBeNull();

    ledger.append(
      makeEvent({ taskId: carried, transitionId: "discover", payload: { initiativeId: INITIATIVE_B } }),
    );
    ledger.append(
      makeEvent({
        taskId: carried,
        transitionId: "classify",
        type: "TASK_CLASSIFIED",
        fromState: "DISCOVERED",
        toState: "DT_CLASSIFIED",
      }),
    );
    // The later event carries no attribution; the projection keeps the one it has.
    expect(ledger.getTask(carried)?.initiativeId).toBe(INITIATIVE_B);

    ledger.rebuildReadModel();
    expect(ledger.getTask(oldShape)?.initiativeId).toBeNull();
    expect(ledger.getTask(carried)?.initiativeId).toBe(INITIATIVE_B);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});
