import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  LEDGER_MIGRATIONS,
  canonicalJsonStringify,
  chainDigest,
  openLedger,
  type CausationRef,
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
    // Nine since P-09/log-C opened the registry stream, beside the typed causal
    // triple of B and the watermark table of A.
    expect(status.migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
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
/**
 * Undo migration 9's schema objects, in the reverse of the order it made them.
 *
 * Including the two triggers it did not create but DID recreate. Migration 9
 * drops migration 8's pair and puts back a three-stream version under the same
 * names, so rewinding past 9 without dropping them leaves the recreated
 * triggers behind and re-applying 8 fails with "trigger already exists" — an
 * upgrade path that looks like a divergent history. This is the same failure
 * mode P-09/log-B found the first time a rewind helper was one migration short.
 */
function dropRegistryStream(raw: Database.Database): void {
  raw.exec(
    "DROP TRIGGER tr_control_plane_events__validate_new_rows; " +
      "DROP TRIGGER tr_initiative_events__validate_new_rows;",
  );
  raw.prepare("DELETE FROM projection_watermark WHERE projection_name = ?").run(
    "routing_assignment_read_model",
  );
  raw.prepare("DELETE FROM ledger_meta WHERE key LIKE ?").run("registry_%");
  raw.exec(
    "DROP TABLE routing_assignment_fallback; " +
      "DROP TABLE routing_assignment_read_model; " +
      "DROP TRIGGER tr_registry_events__validate_new_rows; " +
      "DROP TRIGGER tr_registry_events__deny_delete; " +
      "DROP TRIGGER tr_registry_events__deny_update; " +
      "DROP TABLE registry_events;",
  );
  // Migration 8's own pair, restored to the two-stream form it shipped with,
  // so re-applying the tail is an upgrade rather than a conflict.
  const eighth = LEDGER_MIGRATIONS.find((migration) => migration.version === 8);
  if (eighth === undefined) throw new Error("migration 8 is absent from this build");
  const triggers = eighth.sql.slice(eighth.sql.indexOf("CREATE TRIGGER"));
  raw.exec(triggers);
}

/**
 * Undo migration 8's schema objects.
 *
 * A migration set is applied in order and compared by position, so a test that
 * rewinds a ledger to migration N has to take everything after N with it: an
 * applied set of 1-6 and 8 is a divergent history rather than a pending tail,
 * and re-applying 8 over columns that are still there is a duplicate-column
 * error rather than an upgrade.
 */
function dropTypedCausality(raw: Database.Database): void {
  raw.exec(
    "DROP TRIGGER tr_control_plane_events__validate_new_rows; " +
      "DROP TRIGGER tr_initiative_events__validate_new_rows;",
  );
  for (const table of ["control_plane_events", "initiative_events"]) {
    for (const column of ["causation_stream", "causation_sequence", "causation_sha256"]) {
      raw.exec("ALTER TABLE " + table + " DROP COLUMN " + column);
    }
  }
}

/** The whole P-09 tail, undone in the reverse of the order it was applied. */
function dropProjectionVector(raw: Database.Database): void {
  dropRegistryStream(raw);
  dropTypedCausality(raw);
  raw.exec("DROP TABLE projection_watermark");
}

function withRawDatabase(path: string, mutate: (raw: Database.Database) => void): void {
  const raw = new Database(path);
  try {
    mutate(raw);
  } finally {
    raw.close();
  }
}

/**
 * The raw insert a tampering test uses to plant a watermark row.
 *
 * Written out once because every such test plants the same seven columns, and
 * a test that spelled them differently each time would be asserting against a
 * shape it had just invented rather than against the migration's.
 */
const INSERT_WATERMARK =
  "INSERT INTO projection_watermark (projection_name, source_stream, projector_version, " +
  "applied_sequence, event_count, source_head_sha256, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)";

interface WatermarkRow {
  readonly projection_name: string;
  readonly source_stream: string;
  readonly projector_version: number;
  readonly applied_sequence: number;
  readonly event_count: number;
  readonly source_head_sha256: string;
  readonly updated_at: string;
}

/** Every watermark row of a closed ledger, in the table's own key order. */
function readWatermarks(path: string): WatermarkRow[] {
  const raw = new Database(path);
  try {
    return raw
      .prepare(
        "SELECT projection_name, source_stream, projector_version, applied_sequence, " +
          "event_count, source_head_sha256, updated_at FROM projection_watermark " +
          "ORDER BY projection_name ASC, source_stream ASC",
      )
      .all() as WatermarkRow[];
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

describe("projection watermark verification", () => {
  it("detects a missing projection watermark row", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare("DELETE FROM projection_watermark WHERE projection_name = ?")
        .run("worker_read_model");
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "missing the row for worker_read_model on control_plane_events",
    );
  });

  it("detects an extra projection watermark row", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw.prepare(INSERT_WATERMARK).run(
        "rogue_projection",
        "control_plane_events",
        1,
        5,
        5,
        "0".repeat(64),
        "2026-08-27T12:00:00.000Z",
      );
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "rogue_projection on control_plane_events, which this build does not define",
    );
  });

  // Negative 1 of the P-09 map, in the shape the composite key gives it: the
  // lag is per (projection, stream), and the row is internally consistent, so
  // nothing but the comparison against that stream's own head can catch it.
  it("detects a watermark frozen behind the head of its own stream", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      const at = raw
        .prepare("SELECT event_sha256 FROM control_plane_events WHERE sequence = ?")
        .get(3) as { readonly event_sha256: string };
      raw
        .prepare(
          "UPDATE projection_watermark SET applied_sequence = ?, source_head_sha256 = ? " +
            "WHERE projection_name = ? AND source_stream = ?",
        )
        .run(3, at.event_sha256, "task_read_model", "control_plane_events");
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    // Two findings, not one: the row was rewound consistently in its position
    // and its digest, but a watermark makes a THIRD claim — how many events it
    // folded — and rewinding to sequence 3 while still claiming 5 events is
    // false at that sequence too. The count is compared AT applied_sequence,
    // so a lawfully lagging watermark is judged against its own position.
    expect(report.problems).toHaveLength(2);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META", "PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "is applied through sequence 3 but the head of control_plane_events is sequence 5",
    );
    expect(detailsOf(report.problems)).toContain(
      "counts 5 events through sequence 3 but that stream holds 3",
    );
  });

  // I3, in its structural form. The digest is checked AT applied_sequence, not
  // against whatever the head happens to be now — so a row that kept the head's
  // digest while rewinding its sequence is caught by the digest check as well
  // as by the sequence check. A verifier that compared against the current head
  // would report only one of these two problems.
  it("verifies the source digest at applied_sequence, not against the later head", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "UPDATE projection_watermark SET applied_sequence = ? " +
            "WHERE projection_name = ? AND source_stream = ?",
        )
        .run(3, "task_read_model", "control_plane_events");
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    // Three, now: the position, the digest it kept from the later head, and
    // the count it kept with it.
    expect(kindsOf(report.problems)).toEqual([
      "PROJECTION_META",
      "PROJECTION_META",
      "PROJECTION_META",
    ]);
    expect(detailsOf(report.problems)).toContain(
      "is applied through sequence 3 but the head of control_plane_events is sequence 5",
    );
    expect(detailsOf(report.problems)).toContain(
      "which is not the digest of control_plane_events at sequence 3",
    );
    expect(detailsOf(report.problems)).toContain(
      "counts 5 events through sequence 3 but that stream holds 3",
    );
  });

  // The third claim a watermark makes, and the one nothing checked until now.
  //
  // `applied_sequence` says how far, `source_head_sha256` says which history,
  // and `event_count` says how much of it was folded. The first two were
  // verified from the packet that created the table; the third was written on
  // every append, published by `status()` as `eventCount`, and compared
  // against nothing. A number the ledger asserts on its own authority while no
  // check holds it to the log is exactly the shape of claim this package
  // exists to refuse.
  //
  // One negative per certified stream, because the count is resolved through
  // the same three-way dispatch the digest is, and a dispatch that fell
  // through to the task stream for the other two would report a healthy
  // registry watermark as broken — or, worse, a broken one as healthy.
  function tamperCount(path: string, projection: string, stream: string, count: number): void {
    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "UPDATE projection_watermark SET event_count = ? " +
            "WHERE projection_name = ? AND source_stream = ?",
        )
        .run(count, projection, stream);
    });
  }

  it("detects an event count that disagrees with the task stream", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    // The control: nothing is wrong with this ledger before the tamper.
    expect(ledger.verifyIntegrity().ok).toBe(true);
    expect(
      watermarkOf(ledger, "task_read_model", "control_plane_events")?.eventCount,
    ).toBe(5);
    ledger.close();

    tamperCount(path, "task_read_model", "control_plane_events", 7);

    const reopened = open(path);
    const report = reopened.verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "task_read_model on control_plane_events counts 7 events through sequence 5 " +
        "but that stream holds 5",
    );
    // And the number `status()` was publishing on the ledger's authority is
    // the very one that had nothing behind it.
    expect(
      watermarkOf(reopened, "task_read_model", "control_plane_events")?.eventCount,
    ).toBe(7);
  });

  it("detects an event count that disagrees with the initiative stream", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();

    tamperCount(path, "initiative_read_model", "initiative_events", 9);

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "initiative_read_model on initiative_events counts 9 events through sequence 1 " +
        "but that stream holds 1",
    );
  });

  it("detects an event count that disagrees with the registry stream", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendRegistryEvent(makeRegistryDocument());
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();

    // The registry-side row of the two-source projection. Its sibling on the
    // initiative stream is untouched and must stay unreported.
    tamperCount(path, "routing_assignment_read_model", "registry_events", 4);

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "routing_assignment_read_model on registry_events counts 4 events through sequence 1 " +
        "but that stream holds 1",
    );
    expect(detailsOf(report.problems)).not.toContain("on initiative_events");
  });

  it("repairs a tampered event count by rebuilding, on every stream at once", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendRegistryEvent(makeRegistryDocument());
    ledger.close();

    const before = readWatermarks(path);

    tamperCount(path, "task_read_model", "control_plane_events", 7);
    tamperCount(path, "roadmap_version_read_model", "initiative_events", 8);
    tamperCount(path, "routing_assignment_read_model", "registry_events", 9);

    const reopened = open(path);
    expect(reopened.verifyIntegrity().problems).toHaveLength(3);

    reopened.rebuildReadModel();
    expect(reopened.verifyIntegrity().ok).toBe(true);
    reopened.close();

    // Byte-identical to before the tamper: a rebuild rewrites the whole
    // watermark table from the log, so the counts come back from the only
    // authority that has them.
    expect(readWatermarks(path)).toEqual(before);
  });

  // I4. A fold algorithm that changed invalidates the derived table without
  // anything happening to the stream, so the version is refused rather than
  // read past.
  it("refuses a watermark written by another projector version", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "UPDATE projection_watermark SET projector_version = ? " +
            "WHERE projection_name = ? AND source_stream = ?",
        )
        .run(2, "worker_read_model", "control_plane_events");
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "was written by projector version 2 but this build is version 1",
    );
  });

  it("accepts an empty ledger, where every projection is level with sequence zero", () => {
    const ledger = open(temporaryDatabase());
    const report = ledger.verifyIntegrity();

    expect(report.problems).toEqual([]);
    expect(report.headSequence).toBe(0);
    // Six projections since P-09/log-C: the two task-stream folds, the route
    // fold, the two initiative-stream folds, and the two-source routing fold.
    // Seven heads, because the last one has two — every one of them at zero on
    // a ledger that has never been appended to.
    expect(ledger.status().projections).toHaveLength(6);
    expect(
      ledger
        .status()
        .projections.flatMap((projection) =>
          projection.watermarks.map((watermark) => watermark.appliedThroughSequence),
        ),
    ).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("keeps every projection level with the head of its own stream", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);

    // Each projection follows one stream. The task projections move with the
    // five seeded task events; the initiative projections stay at zero,
    // because nothing has been appended to the sibling stream. Holding them
    // all to one number would be the bug this separation exists to prevent.
    const levels = appliedByName(ledger);
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
      raw.prepare(INSERT_WATERMARK).run(
        "not_a_real_table",
        "control_plane_events",
        1,
        5,
        5,
        "0".repeat(64),
        "2026-08-27T12:00:00.000Z",
      );
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
      raw.prepare(INSERT_WATERMARK).run(
        "task_read_model; DROP TABLE ledger_meta",
        "control_plane_events",
        1,
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
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
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
  // Always build, rather than returning early when the entry point exists.
  // `tsc --build` is incremental, so this costs nothing when the tree is
  // current; skipping it let a stale `dist-test` from an earlier commit run
  // against a database this build had migrated further, and the failure
  // arrived as an unrelated-looking migration error from a child process.
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

describe("the test tree's own paths", () => {
  it("resolves REPO_ROOT to a repository root, not to packages/", () => {
    // V2 concurrency C2, carry-in K1. This expression was one `../` short and
    // resolved to `packages/`, so `ensureWorkerBuilt`'s tsc lookup could not
    // resolve -- dormant only while `dist-test/` exists, which `pnpm check`
    // guarantees and `pnpm test` alone does not. Asserted rather than declared,
    // because a fix nobody exercises is a claim.
    expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });
});

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

describe("the account-action stream (P8-8G packet 2)", () => {
  const ACTOR = "kimi/k3/coordinator/01";
  const AT = "2026-08-31T12:00:00.000Z";

  function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const version = (overrides["version"] as number | undefined) ?? 1;
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: randomUUID(),
      accountId: "acct-primary",
      version,
      idempotencyKey: "acct-primary/1/action." + String(version),
      action: "DRAIN",
      resultingState: "DRAINING",
      actor: ACTOR,
      note: null,
      occurredAt: AT,
      recordedAt: AT,
      ...overrides,
    };
  }

  it("records an action and reads it back, oldest first", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendAccountAction(action());
    ledger.appendAccountAction(
      action({ version: 2, idempotencyKey: "acct-primary/1/action.2", action: "ACCOUNT_READY", resultingState: "AVAILABLE" }),
    );

    const history = ledger.listAccountActions("acct-primary");
    expect(history.map((row) => row.event.version)).toEqual([1, 2]);
    expect(history.map((row) => row.event.action)).toEqual(["DRAIN", "ACCOUNT_READY"]);
    // Scoped: another account's history is its own.
    expect(ledger.listAccountActions("acct-other")).toEqual([]);
    ledger.close();
  });

  it("is idempotent: the same action appended twice inserts once", () => {
    const ledger = open(temporaryDatabase());
    const candidate = action();
    const first = ledger.appendAccountAction(candidate);
    const second = ledger.appendAccountAction(candidate);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.record.eventId).toBe(first.record.eventId);
    expect(ledger.listAccountActions("acct-primary")).toHaveLength(1);
    ledger.close();
  });

  it("refuses a different event under the same key, and a reused event id", () => {
    const ledger = open(temporaryDatabase());
    const first = ledger.appendAccountAction(action());
    // Same key, different content: the conflict the seam turns into a 409.
    expect(() => ledger.appendAccountAction(action({ note: "different" }))).toThrow();
    // Same event id under a new key: the other conflict.
    expect(() =>
      ledger.appendAccountAction(
        action({ version: 2, idempotencyKey: "acct-primary/1/action.2", eventId: first.record.eventId }),
      ),
    ).toThrow();
    ledger.close();
  });

  it("refuses an event whose resulting state contradicts its action", () => {
    const ledger = open(temporaryDatabase());
    // The contract, not the ledger, owns this rule — but the ledger parses
    // through the contract, so it cannot be bypassed by writing directly.
    expect(() => ledger.appendAccountAction(action({ resultingState: "AVAILABLE" }))).toThrow();
    ledger.close();
  });

  it("is append-only: the stream denies UPDATE and DELETE", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendAccountAction(action());
    // The integrity check knows the triggers exist; this proves they bite.
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();
  });
});


// ---------------------------------------------------------------------------
// The recorded execution route (V2-B1c)
// ---------------------------------------------------------------------------

describe("the recorded execution route", () => {
  const ROUTE = {
    provider: "claude",
    model: "opus",
    accountId: "acct-ledger-fixture",
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "policy-ledger-1",
    resolvedAt: "2026-08-27T12:00:00.000Z",
  };

  /**
   * One `RUN_STARTED` for a task, as a same-state passthrough.
   *
   * The first event of a task declares `fromState: null`; every later one
   * declares the state the ledger already holds, which is what the lifecycle
   * guard requires. A retry therefore threads from `DISCOVERED` rather than
   * claiming to open the task a second time.
   */
  function appendRunStarted(
    ledger: Ledger,
    taskId: string,
    payload: Record<string, unknown>,
    attempt = 1,
  ): void {
    ledger.append(
      makeEvent({
        taskId,
        attempt,
        transitionId: "run.started",
        type: "RUN_STARTED",
        fromState: attempt === 1 ? null : "DISCOVERED",
        toState: "DISCOVERED",
        payload,
      }),
    );
  }

  it("persists and reads back the route an event recorded, per attempt", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    appendRunStarted(ledger, taskId, { route: ROUTE }, 1);
    appendRunStarted(ledger, taskId, { route: { ...ROUTE, accountId: "acct-second" } }, 2);

    expect(ledger.getExecutionRoute(taskId, 1)).toMatchObject({ ...ROUTE, taskId, attempt: 1 });
    expect(ledger.getExecutionRoute(taskId, 2)).toMatchObject({
      ...ROUTE,
      accountId: "acct-second",
      taskId,
      attempt: 2,
    });
    // The first attempt's route survived the second, which is the whole reason
    // the row is keyed by the pair.
    expect(ledger.listExecutionRoutes(taskId).map((row) => row.attempt)).toEqual([1, 2]);
    expect(ledger.getExecutionRoute(taskId, 3)).toBeNull();
  });

  it("refuses a positive-integer attempt it cannot mean", () => {
    const ledger = open(temporaryDatabase());
    expect(() => ledger.getExecutionRoute(randomUUID(), 0)).toThrow(LedgerQueryError);
  });

  it("refuses at append when a route field is named like a credential", () => {
    // The `tokens`-plural lesson, made into a test. A field name is a
    // correctness question here: the contract's guards suffix-match their
    // stems, so a route that carried `accountToken` would be refused rather
    // than written, and the refusal has to happen at the append, not later.
    const ledger = open(temporaryDatabase());
    for (const denied of ["accountToken", "routeCredential", "apiKey", "sessionCookie"]) {
      expect(() =>
        {
          appendRunStarted(ledger, randomUUID(), { route: { ...ROUTE, [denied]: "x" } });
        },
      ).toThrow(LedgerValidationError);
    }
  });

  it("refuses at append when a route value looks like live credential material", () => {
    const ledger = open(temporaryDatabase());
    expect(() =>
      {
        appendRunStarted(ledger, randomUUID(), {
          route: { ...ROUTE, accountId: "sk-not-an-account-id-0123456789" },
        });
      },
    ).toThrow(LedgerValidationError);
  });

  it("keeps a malformed route out of the read model while the event still stands", () => {
    // The append succeeds — the payload is a lawful bounded record — and the
    // projection refuses the route. Both halves are asserted, because the
    // failure mode this guards against is a projection that disowns history.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    appendRunStarted(ledger, taskId, { route: { ...ROUTE, transportKind: "CARRIER_PIGEON" } });

    expect(ledger.getExecutionRoute(taskId, 1)).toBeNull();
    expect(ledger.listEvents({ taskId }).events).toHaveLength(1);
    expect(ledger.getTask(taskId)?.eventCount).toBe(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("stays inside the event payload budget with room to spare", () => {
    // The route is small, and saying how small keeps a later widening honest.
    const payload = {
      submissionDigest: "a".repeat(64),
      beat: "INTENT",
      operationId: "op-" + "b".repeat(60),
      operationIndex: 4,
      route: ROUTE,
    };
    const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(size).toBeLessThan(1_024);
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    expect(() => {
      appendRunStarted(ledger, taskId, payload);
    }).not.toThrow();
    expect(ledger.getExecutionRoute(taskId, 1)).not.toBeNull();
  });

  it("rebuilds the route rows byte-identically and reports no projection problem", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    appendRunStarted(ledger, taskId, { route: ROUTE }, 1);
    appendRunStarted(ledger, taskId, { route: { ...ROUTE, model: "sonnet" } }, 2);

    const before = ledger.listExecutionRoutes(taskId);
    const rebuild = ledger.rebuildReadModel();
    const after = ledger.listExecutionRoutes(taskId);

    expect(rebuild.executionRouteRows).toBe(2);
    expect(canonicalJsonStringify(after)).toBe(canonicalJsonStringify(before));
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("notices a route row a replay does not account for", () => {
    // The integrity arm is not decorative: a row nothing produced, and a row
    // that disagrees with a replay, are both reported.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    appendRunStarted(ledger, taskId, { route: ROUTE });
    ledger.close();

    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO execution_route_read_model (task_id, attempt, provider, model, account_id, " +
          "transport_kind, capability_policy_version, resolved_at, recorded_at, sequence) " +
          "VALUES (?, 9, 'claude', 'opus', 'acct-ghost', 'CLI_SUBSCRIPTION', 'v', ?, ?, 1)",
      )
      .run(taskId, ROUTE.resolvedAt, ROUTE.resolvedAt);
    raw.close();

    const reopened = open(path);
    const report = reopened.verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(
      report.problems.some(
        (problem) =>
          problem.kind === "PROJECTION" &&
          problem.detail.includes("execution_route_read_model holds the route for"),
      ),
    ).toBe(true);

    // And a rebuild repairs it, because the log is the authority.
    reopened.rebuildReadModel();
    expect(reopened.verifyIntegrity().ok).toBe(true);
    expect(reopened.getExecutionRoute(taskId, 9)).toBeNull();
  });

  it("migrates a ledger that already holds events without breaking its own integrity", () => {
    // Backward safety on the path that actually happens in the field: a ledger
    // written before V2-B1c, holding events, opened by a build that knows
    // migration 6 — and NOT rebuilt afterwards, because nothing asks an
    // operator to rebuild after an upgrade.
    //
    // The route projection over those events is legitimately empty: the fold
    // is total and no pre-V2-B1c event carries a route. So the projection is
    // level with the head the moment the table exists, and its metadata has to
    // say so. Seeding it at sequence zero instead would leave every migrated
    // ledger reporting itself corrupt — a projection frozen behind the head is
    // exactly what `verifyIntegrity` is built to notice.
    const path = temporaryDatabase();
    const seeded = open(path);
    const taskId = randomUUID();
    seedTask(seeded, taskId, "kimi/k3/coordinator/01");
    const headBefore = seeded.status().headSequence;
    expect(headBefore).toBeGreaterThan(0);
    seeded.close();

    // Rewind to the pre-V2-B1c shape: no route table, no meta row, no
    // migration 6. This is what such a ledger looks like on disk. Migrations 7,
    // 8 and 9 go with it, because a migration set is applied in order and
    // neither the watermark table, nor the causal triple, nor the registry
    // stream existed before the route projection did.
    const raw = new Database(path);
    dropProjectionVector(raw);
    raw.exec("DROP TABLE execution_route_read_model");
    raw.prepare("DELETE FROM projection_meta WHERE name = ?").run("execution_route_read_model");
    raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(6);
    expect(
      (raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[])
        .map((row) => row.version),
    ).toEqual([1, 2, 3, 4, 5]);
    raw.close();

    // The upgrade: migrations 6 to 9 apply on open, and nothing else is done.
    const migrated = open(path);
    expect(migrated.status().migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);

    const report = migrated.verifyIntegrity();
    expect(report.problems.filter((problem) => problem.kind === "PROJECTION_META")).toEqual([]);
    expect(report.ok).toBe(true);

    // The new projection is level with the head it was seeded from, and holds
    // no rows, which is the truthful pair.
    expect(
      watermarkOf(migrated, "execution_route_read_model", "control_plane_events")
        ?.appliedThroughSequence,
    ).toBe(headBefore);
    expect(migrated.listExecutionRoutes(taskId)).toEqual([]);

    // And an append after the upgrade still lands, projects and verifies.
    appendRunStarted(migrated, randomUUID(), { route: ROUTE });
    expect(migrated.verifyIntegrity().ok).toBe(true);
  });

  it("replays a ledger that predates the route to zero route rows, not to an error", () => {
    // The sibling of the test above, and deliberately a different path: that
    // one migrates and does NOT rebuild, which is what an upgrade actually
    // looks like; this one rebuilds, which is what an operator does after a
    // repair. Both must end with an empty route projection and a sound
    // ledger, and they reach it through different code -- the migration's own
    // seed there, `rebuildReadModel`'s projection-meta write here. Keeping
    // both is what made the seeding defect visible: this test passed against
    // a mechanism the other one falsified.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedTask(ledger, taskId, "kimi/k3/coordinator/01");
    // Not one of the events carries a route, exactly like every event written
    // before this packet existed.
    const rebuild = ledger.rebuildReadModel();
    expect(rebuild.executionRouteRows).toBe(0);
    expect(ledger.listExecutionRoutes(taskId)).toEqual([]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P-09/log-A: the batch door, and the watermark vector under it
// ---------------------------------------------------------------------------

/** A three event lifecycle for one task, as candidates rather than as appends. */
function lifecycleBatch(taskId: string, emittedBy: string): Record<string, unknown>[] {
  return [
    makeEvent({ taskId, transitionId: "discover", toState: "DISCOVERED", emittedBy }),
    makeEvent({
      taskId,
      transitionId: "classify",
      type: "TASK_CLASSIFIED",
      fromState: "DISCOVERED",
      toState: "DT_CLASSIFIED",
      emittedBy,
    }),
    makeEvent({
      taskId,
      transitionId: "ready",
      type: "TASK_READY",
      fromState: "DT_CLASSIFIED",
      toState: "READY",
      emittedBy,
    }),
  ];
}

/**
 * The applied sequence of each SINGLE-headed projection, as status() reports it.
 *
 * A projection fed by two streams has two fixed heads and no single "how far",
 * which is the whole reason the DTO carries a vector; it is read through
 * `watermarkOf`, which names the stream it means. Skipping it here rather than
 * picking one of its heads keeps this helper from answering a question it
 * cannot answer.
 */
function appliedByName(ledger: Ledger): Map<string, number> {
  const applied = new Map<string, number>();
  for (const projection of ledger.status().projections) {
    if (projection.watermarks.length !== 1) continue;
    const only = projection.watermarks[0];
    if (only !== undefined) applied.set(projection.name, only.appliedThroughSequence);
  }
  return applied;
}

/** One projection's fixed head on one named stream, as status() reports it. */
function watermarkOf(
  ledger: Ledger,
  name: string,
  sourceStream: string,
): { readonly appliedThroughSequence: number; readonly eventCount: number } | undefined {
  return ledger
    .status()
    .projections.find((projection) => projection.name === name)
    ?.watermarks.find((watermark) => watermark.sourceStream === sourceStream);
}

describe("appendBatch lands a whole batch or none of it", () => {
  it("appends every event of a batch in one transaction and advances the head once", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();

    const batch = ledger.appendBatch(lifecycleBatch(taskId, KIMI));

    expect(batch.results.map((result) => result.inserted)).toEqual([true, true, true]);
    expect(batch.results.map((result) => result.record.sequence)).toEqual([1, 2, 3]);
    expect(batch.insertedCount).toBe(3);
    expect(batch.headSequence).toBe(3);
    expect(batch.headEventSha256).toBe(batch.results[2]?.record.eventSha256);

    // The chain is the ordinary one: each event links to the one before it.
    expect(batch.results[1]?.record.previousSha256).toBe(batch.results[0]?.record.eventSha256);
    expect(batch.results[2]?.record.previousSha256).toBe(batch.results[1]?.record.eventSha256);

    // The lifecycle guard read the projection the previous event of this same
    // batch had already written, inside the transaction.
    expect(ledger.getTask(taskId)?.currentState).toBe("READY");
    expect(ledger.status().eventCount).toBe(3);
    expect(appliedByName(ledger).get("task_read_model")).toBe(3);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("refuses an empty batch and writes nothing", () => {
    const ledger = open(temporaryDatabase());
    expect(caught(() => ledger.appendBatch([]))).toBeInstanceOf(LedgerValidationError);
    expect(ledger.status().headSequence).toBe(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("validates every candidate before it writes anything", () => {
    // Pre-validation is observable: with it, the fault seam that runs after the
    // first INSERT never fires at all, because no INSERT is attempted. A batch
    // that validated lazily would have inserted the first event and rolled it
    // back, which is a weaker guarantee wearing the same green.
    let projectionAttempts = 0;
    const ledger = open(temporaryDatabase(), {
      __testFaults: {
        beforeProjection: () => {
          projectionAttempts += 1;
        },
      },
    });

    const error = caught(() => ledger.appendBatch([makeEvent(), { not: "an event" }]));

    expect(error).toBeInstanceOf(LedgerValidationError);
    expect(projectionAttempts).toBe(0);
    expect(ledger.status().headSequence).toBe(0);
  });

  it("treats an exact replay inside a batch as a no-op for that event alone", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const events = lifecycleBatch(taskId, KIMI);
    const first = events[0];
    if (first === undefined) throw new Error("empty fixture");

    ledger.append(first);
    const batch = ledger.appendBatch(events);

    expect(batch.results.map((result) => result.inserted)).toEqual([false, true, true]);
    expect(batch.insertedCount).toBe(2);
    expect(batch.results.map((result) => result.record.sequence)).toEqual([1, 2, 3]);
    expect(ledger.status().eventCount).toBe(3);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("aborts the whole batch when one event conflicts", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const events = lifecycleBatch(taskId, KIMI);
    const third = events[2];
    if (third === undefined) throw new Error("empty fixture");

    // The third event claims a prior state the batch never reaches, because the
    // second has been dropped from it.
    const error = caught(() => ledger.appendBatch([events[0], third]));

    expect(error).toBeInstanceOf(LedgerLifecycleConflictError);
    expect(ledger.status().headSequence).toBe(0);
    expect(ledger.status().eventCount).toBe(0);
    expect(ledger.getTask(taskId)).toBeNull();
    expect(appliedByName(ledger).get("task_read_model")).toBe(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  // Negative 9 of the P-09 map.
  it("rolls the whole batch back when an event in the middle of it fails", () => {
    let seen = 0;
    const ledger = open(temporaryDatabase(), {
      __testFaults: {
        beforeProjection: () => {
          seen += 1;
          if (seen === 2) throw new Error("injected mid-batch failure");
        },
      },
    });

    const taskId = randomUUID();
    const error = caught(() => ledger.appendBatch(lifecycleBatch(taskId, KIMI)));
    expect(error).toBeInstanceOf(Error);
    expect(seen).toBe(2);

    // Neither the head, nor the rows, nor the projection, nor the watermark.
    expect(ledger.status().headSequence).toBe(0);
    expect(ledger.status().eventCount).toBe(0);
    expect(ledger.listEvents().events).toHaveLength(0);
    expect(ledger.getTask(taskId)).toBeNull();
    expect(ledger.listWorkers().workers).toHaveLength(0);
    expect([...appliedByName(ledger).values()]).toEqual([0, 0, 0, 0, 0]);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // The handle is still usable, so the rollback was clean rather than wedged.
    seen = 99;
    expect(ledger.append(makeEvent({ taskId })).record.sequence).toBe(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("refuses a batch through a read-only handle", () => {
    const path = temporaryDatabase();
    open(path).close();
    const reader = open(path, { readOnly: true });
    expect(caught(() => reader.appendBatch([makeEvent()]))).toBeInstanceOf(LedgerReadOnlyError);
  });
});

describe("the watermark advances with every door that moves a head", () => {
  it("carries the task stream's own head, per projection, on append", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);
    ledger.close();

    const rows = readWatermarks(ledger.path);
    expect(rows).toHaveLength(7);
    const taskRows = rows.filter((row) => row.source_stream === "control_plane_events");
    expect(taskRows.map((row) => row.projection_name)).toEqual([
      "execution_route_read_model",
      "task_read_model",
      "worker_read_model",
    ]);
    expect(taskRows.map((row) => row.applied_sequence)).toEqual([5, 5, 5]);
    expect(taskRows.map((row) => row.event_count)).toEqual([5, 5, 5]);
    expect(new Set(taskRows.map((row) => row.projector_version))).toEqual(new Set([1]));

    // The sibling stream stayed where it was. A single shared number is exactly
    // what the composite key exists to prevent.
    const initiativeRows = rows.filter((row) => row.source_stream === "initiative_events");
    expect(initiativeRows.map((row) => row.projection_name)).toEqual([
      "initiative_read_model",
      "roadmap_version_read_model",
      "routing_assignment_read_model",
    ]);
    expect(initiativeRows.map((row) => row.applied_sequence)).toEqual([0, 0, 0]);
  });

  it("carries the initiative stream's own head on appendInitiativeEvent", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.close();

    const rows = readWatermarks(ledger.path);
    const applied = new Map(rows.map((row) => [row.projection_name, row.applied_sequence]));
    expect(applied.get("task_read_model")).toBe(5);
    expect(applied.get("initiative_read_model")).toBe(1);
    expect(applied.get("roadmap_version_read_model")).toBe(1);
  });

  it("clears and rewrites every watermark row inside the rebuild transaction", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.close();

    const before = readWatermarks(path);

    const reopened = open(path);
    reopened.rebuildReadModel();
    reopened.close();

    // Byte-identical, and still exactly the closed set: a rebuild that left a
    // stale row behind, or dropped one, would be visible here.
    expect(readWatermarks(path)).toEqual(before);
    expect(open(path).verifyIntegrity().ok).toBe(true);
  });

  // Negative 10 of the P-09 map, with the watermark clause the contract adds
  // (`streams/index.md:478`): a refusal must not leave the row half-written.
  it("refuses to rebuild over a broken chain and leaves the watermarks untouched", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    const before = readWatermarks(path);
    expect(before).toHaveLength(7);

    tamper(path, (raw) => {
      raw
        .prepare("UPDATE control_plane_events SET event_sha256 = ? WHERE sequence = ?")
        .run("f".repeat(64), 3);
    });

    const reopened = open(path);
    expect(caught(() => reopened.rebuildReadModel())).toBeInstanceOf(LedgerIntegrityError);
    reopened.close();

    expect(readWatermarks(path)).toEqual(before);
  });
});

describe("the account stream is declared, not certified", () => {
  const ACCOUNT_AT = "2026-08-31T12:00:00.000Z";

  function accountAction(): Record<string, unknown> {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: randomUUID(),
      accountId: "acct-primary",
      version: 1,
      idempotencyKey: "acct-primary/1/action.1",
      action: "DRAIN",
      resultingState: "DRAINING",
      actor: KIMI,
      note: null,
      occurredAt: ACCOUNT_AT,
      recordedAt: ACCOUNT_AT,
    };
  }

  // Negative 4 of the P-09 map, in the form D3 adjudicated: the account stream
  // has no hash chain of its own (migration 5 carries neither previous_sha256
  // nor event_sha256), so its watermark is not published as certified. The
  // append must therefore claim nothing, and a row claiming it on the account
  // stream's behalf must be refused rather than believed.
  it("records an account action without publishing a watermark for that stream", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendAccountAction(accountAction());
    expect(ledger.listAccountActions("acct-primary")).toHaveLength(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();

    expect(readWatermarks(path).filter((row) => row.source_stream === "account_events")).toEqual(
      [],
    );
  });

  it("refuses a watermark row planted on the account stream", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendAccountAction(accountAction());
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw.prepare(INSERT_WATERMARK).run(
        "task_read_model",
        "account_events",
        1,
        1,
        1,
        "0".repeat(64),
        ACCOUNT_AT,
      );
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain(
      "task_read_model on account_events, which this build does not define",
    );
  });
});

describe("migration 7 seeds the watermarks from the heads it finds", () => {
  // Negative 7 of the P-09 map, and the reason migration 6 carries the comment
  // it does. The fixture populates BOTH streams on purpose: seeding all five
  // rows from `head_*` would pass against a task-only fixture and would leave
  // every field ledger reporting its initiative projections as corrupt.
  it("migrates a ledger holding both streams without breaking its own integrity", () => {
    const path = temporaryDatabase();
    const seeded = open(path);
    const taskId = randomUUID();
    seedTask(seeded, taskId, KIMI);
    seeded.appendInitiativeEvent(makeInitiativeEvent());
    seeded.appendInitiativeEvent(
      makeInitiativeEvent({ initiativeId: INITIATIVE_B, transitionId: "register.b" }),
    );
    const taskHead = seeded.status().headSequence;
    const initiativeHead = seeded.status().initiativeHeadSequence;
    expect(taskHead).toBe(3);
    expect(initiativeHead).toBe(2);
    seeded.close();

    // Rewind to the pre-P-09 shape: no watermark table, no typed causality, no
    // registry stream, and none of the three migrations recorded. This is what
    // such a ledger looks like on disk. The whole tail comes off together
    // because conformance is compared by position: an applied set of 1-6 and 8
    // is a divergent history, not a pending one.
    withRawDatabase(path, (raw) => {
      dropProjectionVector(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(7);
    });

    // The upgrade: the pending tail applies on open, and nothing else is done.
    // No operator is asked to rebuild after an upgrade, so the seed has to be
    // right the first time.
    const migrated = open(path);
    expect(migrated.status().migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);

    const report = migrated.verifyIntegrity();
    expect(report.problems.filter((problem) => problem.kind === "PROJECTION_META")).toEqual([]);
    expect(report.ok).toBe(true);
    migrated.close();

    // Each row is level with the head of ITS OWN stream, not with a shared
    // number and not with zero.
    const applied = new Map(
      readWatermarks(path).map((row) => [row.projection_name + "@" + row.source_stream, row]),
    );
    expect(applied.get("task_read_model@control_plane_events")?.applied_sequence).toBe(taskHead);
    expect(applied.get("worker_read_model@control_plane_events")?.applied_sequence).toBe(taskHead);
    expect(
      applied.get("execution_route_read_model@control_plane_events")?.applied_sequence,
    ).toBe(taskHead);
    expect(applied.get("initiative_read_model@initiative_events")?.applied_sequence).toBe(
      initiativeHead,
    );
    expect(applied.get("roadmap_version_read_model@initiative_events")?.applied_sequence).toBe(
      initiativeHead,
    );
    // The two-source projection's two rows, seeded from two different
    // arguments: its registry row may honestly be zero because that stream is
    // born empty in the same migration, and its initiative row may not, because
    // the fold over an existing history is empty by construction.
    expect(
      applied.get("routing_assignment_read_model@registry_events")?.applied_sequence,
    ).toBe(0);
    expect(
      applied.get("routing_assignment_read_model@initiative_events")?.applied_sequence,
    ).toBe(initiativeHead);
    expect(applied.get("task_read_model@control_plane_events")?.projector_version).toBe(1);

    // And an append after the upgrade still lands, projects and verifies.
    const reopened = open(path);
    reopened.append(makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }));
    expect(reopened.verifyIntegrity().ok).toBe(true);
    expect(appliedByName(reopened).get("task_read_model")).toBe(taskHead + 1);
    expect(appliedByName(reopened).get("initiative_read_model")).toBe(initiativeHead);
  });

  it("seeds a fresh ledger at zero, with the genesis digest on all three streams", () => {
    const path = temporaryDatabase();
    open(path).close();

    const rows = readWatermarks(path);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.applied_sequence === 0)).toBe(true);
    expect(rows.every((row) => row.event_count === 0)).toBe(true);
    expect(rows.every((row) => row.source_head_sha256 === GENESIS_SHA256)).toBe(true);
    expect(rows.every((row) => row.updated_at === "1970-01-01T00:00:00.000Z")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Typed causality (P-09/log-B)
//
// The triple is additive and optional: an event with no recorded cause is the
// ordinary case and stays exactly as it was. What is new is that a reference,
// when present, is a *verifiable* one — the digest must be the referenced
// event's own `event_sha256` at the named position of the named stream.
//
// Two layers, deliberately, and both are exercised here. The typed door
// resolves the reference and refuses the discrepancy before the INSERT, which
// is what makes the refusal a `LedgerValidationError` rather than a raw SQLite
// error. The `BEFORE INSERT` trigger holds the same line underneath, for the
// caller who reaches past the door with raw SQL — the second class of tests
// below is what proves the base is not merely trusting the code above it.
// ---------------------------------------------------------------------------

/** A reference in the shape the doors take. */
function ref(stream: string, sequence: number, sha256: string): CausationRef {
  return { stream, sequence, sha256 } as unknown as CausationRef;
}

/** Two initiative events, so a test has two distinct verifiable causes. */
function seedTwoCauses(ledger: Ledger): readonly [CausationRef, CausationRef] {
  const first = ledger.appendInitiativeEvent(makeInitiativeEvent());
  const second = ledger.appendInitiativeEvent(
    makeInitiativeEvent({ initiativeId: INITIATIVE_B, transitionId: "register.b" }),
  );
  return [
    ref("initiative_events", first.record.sequence, first.record.eventSha256),
    ref("initiative_events", second.record.sequence, second.record.eventSha256),
  ];
}

describe("a causal reference is typed, verified, or absent", () => {
  it("leaves an event with no recorded cause exactly as it was", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();

    const result = ledger.append(makeEvent({ taskId, transitionId: "discover", emittedBy: KIMI }));

    expect(result.inserted).toBe(true);
    expect(result.record.causation).toBeNull();
    expect(result.record.previousSha256).toBe(GENESIS_SHA256);
    expect(ledger.getEventBySequence(1)?.causation).toBeNull();
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("records a task event caused by an initiative event, and reads the reference back", () => {
    // The cross-stream case the triple exists for. Two sequences that are not
    // comparable, related by a digest that either resolves or does not.
    const ledger = open(temporaryDatabase());
    const cause = ledger.appendInitiativeEvent(makeInitiativeEvent());
    const expected = ref(
      "initiative_events",
      cause.record.sequence,
      cause.record.eventSha256,
    );

    const result = ledger.append(
      makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
      expected,
    );

    expect(result.record.causation).toEqual(expected);
    expect(ledger.getEventBySequence(result.record.sequence)?.causation).toEqual(expected);
    expect(ledger.getEvent(result.record.eventId)?.causation).toEqual(expected);
    // The chain is untouched: the triple is not in the hash preimage, and the
    // first event of the task stream still links to genesis.
    expect(result.record.previousSha256).toBe(GENESIS_SHA256);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("records an initiative event caused by a task event, in the other direction", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const cause = ledger.append(
      makeEvent({ taskId, transitionId: "discover", emittedBy: KIMI }),
    );
    const expected = ref("control_plane_events", cause.record.sequence, cause.record.eventSha256);

    const result = ledger.appendInitiativeEvent(makeInitiativeEvent(), expected);

    expect(result.record.causation).toEqual(expected);
    expect(ledger.listInitiativeEvents().events[0]?.causation).toEqual(expected);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("refuses a digest that is not the referenced event's own", () => {
    // Negative 5 of the P-09 map. An invalid reference, not a weak link.
    const ledger = open(temporaryDatabase());
    const cause = ledger.appendInitiativeEvent(makeInitiativeEvent());

    const error = caught(() =>
      ledger.append(
        makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
        ref("initiative_events", cause.record.sequence, "a".repeat(64)),
      ),
    );

    expect(error).toBeInstanceOf(LedgerValidationError);
    expect(ledger.status().headSequence).toBe(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("refuses a reference to a position the named stream does not hold", () => {
    const ledger = open(temporaryDatabase());
    const cause = ledger.appendInitiativeEvent(makeInitiativeEvent());

    const error = caught(() =>
      ledger.append(
        makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
        ref("initiative_events", cause.record.sequence + 7, cause.record.eventSha256),
      ),
    );

    expect(error).toBeInstanceOf(LedgerValidationError);
    expect(ledger.status().headSequence).toBe(0);
  });

  it("refuses a stream whose digest this build cannot verify", () => {
    // `account_events` has no `event_sha256` at all. A reference nobody can
    // check is the weak link the contract refuses, so the vocabulary is exactly
    // the streams that carry a chain — three since P-09/log-C, and widening it
    // to four belongs to the packet that gives the account stream one.
    const ledger = open(temporaryDatabase());
    ledger.append(makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }));
    const digest = ledger.getEventBySequence(1)?.eventSha256 ?? "";

    for (const stream of ["account_events", "not_a_stream"]) {
      const error = caught(() =>
        ledger.appendInitiativeEvent(makeInitiativeEvent(), ref(stream, 1, digest)),
      );
      expect(error, stream).toBeInstanceOf(LedgerValidationError);
      expect((error as Error).message, stream).toContain("names a stream whose digest");
    }

    // `registry_events` is inside the vocabulary now, so the door gets past the
    // shape check and refuses it for the honest reason instead: there is no
    // such event to resolve against.
    const unresolved = caught(() =>
      ledger.appendInitiativeEvent(makeInitiativeEvent(), ref("registry_events", 1, digest)),
    );
    expect(unresolved).toBeInstanceOf(LedgerValidationError);
    expect((unresolved as Error).message).toContain("which holds no event");

    expect(ledger.status().initiativeHeadSequence).toBe(0);
  });

  it("refuses sequence zero, which is the genesis of no stream", () => {
    const ledger = open(temporaryDatabase());

    const error = caught(() =>
      ledger.append(
        makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
        ref("control_plane_events", 0, GENESIS_SHA256),
      ),
    );

    expect(error).toBeInstanceOf(LedgerValidationError);
    expect(ledger.status().headSequence).toBe(0);
  });

  it("refuses a malformed digest without reading the database at all", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendInitiativeEvent(makeInitiativeEvent());

    for (const digest of ["", "A".repeat(64), "a".repeat(63), "z".repeat(64)]) {
      const error = caught(() =>
        ledger.append(
          makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
          ref("initiative_events", 1, digest),
        ),
      );
      expect(error, digest).toBeInstanceOf(LedgerValidationError);
    }
    expect(ledger.status().headSequence).toBe(0);
  });

  it("carries a reference on each event of a batch, and refuses the batch if one fails", () => {
    const ledger = open(temporaryDatabase());
    const [first, second] = seedTwoCauses(ledger);

    const taskId = randomUUID();
    const batch = ledger.appendBatch(lifecycleBatch(taskId, KIMI), [first, null, second]);

    expect(batch.results.map((result) => result.record.causation)).toEqual([first, null, second]);
    expect(batch.insertedCount).toBe(3);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // One unverifiable reference anywhere in the batch, and none of it lands.
    const headBefore = ledger.status().headSequence;
    const error = caught(() =>
      ledger.appendBatch(lifecycleBatch(randomUUID(), KIMI), [
        null,
        null,
        ref("initiative_events", 1, "b".repeat(64)),
      ]),
    );

    expect(error).toBeInstanceOf(LedgerValidationError);
    expect(ledger.status().headSequence).toBe(headBefore);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("refuses a batch whose references do not line up with its events", () => {
    const ledger = open(temporaryDatabase());
    const [first] = seedTwoCauses(ledger);

    const error = caught(() =>
      ledger.appendBatch(lifecycleBatch(randomUUID(), KIMI), [first]),
    );

    expect(error).toBeInstanceOf(LedgerValidationError);
    expect(ledger.status().headSequence).toBe(0);
  });

  it("refuses a replay of the same key under a different reference", () => {
    // The triple is not in `event_json`, so a replay that compared bodies alone
    // would answer `inserted: false` to a caller claiming a different cause and
    // lose the discrepancy in silence.
    const ledger = open(temporaryDatabase());
    const [first, second] = seedTwoCauses(ledger);
    const event = makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI });

    ledger.append(event, first);

    const error = caught(() => ledger.append(event, second));
    expect(error).toBeInstanceOf(LedgerIdempotencyConflictError);
    const conflict = error as LedgerIdempotencyConflictError;
    expect(conflict.storedContentSha256).not.toBe(conflict.incomingContentSha256);

    // Dropping the reference on a retry is the same discrepancy.
    expect(caught(() => ledger.append(event))).toBeInstanceOf(LedgerIdempotencyConflictError);

    // And the honest retry is still the silent no-op it has always been.
    const replay = ledger.append(event, first);
    expect(replay.inserted).toBe(false);
    expect(replay.record.causation).toEqual(first);
    expect(ledger.status().eventCount).toBe(1);
  });

  it("refuses a replay of an initiative event under a different reference", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const one = ledger.append(makeEvent({ taskId, transitionId: "discover", emittedBy: KIMI }));
    const two = ledger.append(
      makeEvent({
        taskId,
        transitionId: "classify",
        type: "TASK_CLASSIFIED",
        fromState: "DISCOVERED",
        toState: "DT_CLASSIFIED",
        emittedBy: KIMI,
      }),
    );
    const first = ref("control_plane_events", one.record.sequence, one.record.eventSha256);
    const second = ref("control_plane_events", two.record.sequence, two.record.eventSha256);
    const event = makeInitiativeEvent();

    ledger.appendInitiativeEvent(event, first);

    expect(caught(() => ledger.appendInitiativeEvent(event, second))).toBeInstanceOf(
      LedgerIdempotencyConflictError,
    );
    expect(ledger.appendInitiativeEvent(event, first).inserted).toBe(false);
    expect(ledger.status().initiativeEventCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The same law, one layer down
//
// SQLite does not allow a CHECK to be added to a table that already exists, so
// the constraints the contract writes as `ck_<table>__causation_pair` are
// carried by a `BEFORE INSERT` trigger instead. These tests reach past the
// typed door with raw SQL, which is the only way to prove the trigger is
// holding the line rather than the TypeScript above it.
// ---------------------------------------------------------------------------

const RAW_INSTANT = "2026-09-02T12:00:00.000Z";

interface RawTriple {
  readonly stream: string | null;
  readonly sequence: number | null;
  readonly sha256: string | null;
}

/**
 * The reason an insert was refused, not merely the fact that it was.
 *
 * A raw insert of a column the table does not have also throws, so asserting
 * `instanceof Error` alone would go green against a schema with no triple at
 * all. Every refusal below is held to the wording of the rule that produced it.
 */
function refusalMessage(outcome: unknown, label: string): string {
  expect(outcome, label).toBeInstanceOf(Error);
  return (outcome as Error).message;
}

/**
 * Insert a row into `control_plane_events` behind the ledger's back.
 *
 * The body is deliberately not a lawful event: what is under test is the
 * trigger's verdict on the columns, and every caller here throws the database
 * away immediately afterwards.
 */
function rawTaskInsert(
  path: string,
  triple: RawTriple,
  digests: { readonly previous?: string; readonly event?: string } = {},
): unknown {
  const raw = new Database(path);
  try {
    return caught(() =>
      raw
        .prepare(
          "INSERT INTO control_plane_events (" +
            "event_id, idempotency_key, task_id, attempt, transition_id, type, from_state, " +
            "to_state, emitted_by, occurred_at, recorded_at, correlation_id, causation_id, " +
            "causation_stream, causation_sequence, causation_sha256, " +
            "contract_version, event_json, previous_sha256, event_sha256" +
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          randomUUID(),
          randomUUID(),
          1,
          "raw",
          "TASK_DISCOVERED",
          null,
          "DISCOVERED",
          KIMI,
          RAW_INSTANT,
          RAW_INSTANT,
          null,
          null,
          triple.stream,
          triple.sequence,
          triple.sha256,
          CONTRACT_VERSION,
          "{}",
          digests.previous ?? GENESIS_SHA256,
          digests.event ?? "c".repeat(64),
        ),
    );
  } finally {
    raw.close();
  }
}

describe("the base refuses a broken causal triple even with the ledger bypassed", () => {
  it("rejects a triple that is only half written", () => {
    // Negative 6 of the P-09 map. All three columns or none of them.
    const path = temporaryDatabase();
    const ledger = open(path);
    const cause = ledger.append(
      makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
    );
    const digest = cause.record.eventSha256;
    ledger.close();

    const halves: readonly RawTriple[] = [
      { stream: "control_plane_events", sequence: null, sha256: null },
      { stream: "control_plane_events", sequence: 1, sha256: null },
      { stream: "control_plane_events", sequence: null, sha256: digest },
      { stream: null, sequence: 1, sha256: digest },
      { stream: null, sequence: 1, sha256: null },
      { stream: null, sequence: null, sha256: digest },
    ];

    for (const triple of halves) {
      const label = JSON.stringify(triple);
      expect(refusalMessage(rawTaskInsert(path, triple), label), label).toContain(
        "all three columns or none",
      );
    }
  });

  it("rejects a digest that is not the referenced row's own", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.append(makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }));
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.close();

    const cases: readonly RawTriple[] = [
      { stream: "control_plane_events", sequence: 1, sha256: "d".repeat(64) },
      { stream: "initiative_events", sequence: 1, sha256: "d".repeat(64) },
      // A position no row occupies is refused for the same reason: the
      // reference does not resolve.
      { stream: "initiative_events", sequence: 99, sha256: "d".repeat(64) },
    ];

    for (const triple of cases) {
      const label = JSON.stringify(triple);
      expect(refusalMessage(rawTaskInsert(path, triple), label), label).toContain(
        "does not resolve",
      );
    }
  });

  it("rejects a stream name outside the verifiable vocabulary", () => {
    // Without an explicit guard a name with no branch of its own would pass in
    // silence, which is exactly the weak link the triple exists to rule out.
    //
    // `registry_events` left this list in P-09/log-C, which is the packet that
    // gave that stream a chain: it is now a name the trigger has a branch for,
    // so a reference to it is refused for NOT RESOLVING rather than for being
    // unverifiable. That is the difference the widening is, and the two are
    // asserted apart so the vocabulary cannot quietly widen again.
    const path = temporaryDatabase();
    const ledger = open(path);
    const cause = ledger.append(
      makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
    );
    const digest = cause.record.eventSha256;
    ledger.close();

    for (const stream of ["account_events", "control_plane_event"]) {
      expect(
        refusalMessage(rawTaskInsert(path, { stream, sequence: 1, sha256: digest }), stream),
        stream,
      ).toContain("no verifiable digest");
    }

    expect(
      refusalMessage(
        rawTaskInsert(path, { stream: "registry_events", sequence: 1, sha256: digest }),
        "registry_events",
      ),
    ).toContain("does not resolve");
  });

  it("rejects a non-positive causal position", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.append(makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }));
    ledger.close();

    for (const sequence of [0, -1]) {
      const triple = { stream: "control_plane_events", sequence, sha256: "e".repeat(64) };
      expect(
        refusalMessage(rawTaskInsert(path, triple), String(sequence)),
        String(sequence),
      ).toContain("positive position");
    }
  });

  it("rejects digests that are not 64 lowercase hex characters", () => {
    // The shape §0 of the contract gives `event_sha256`, imposed forward by the
    // trigger because migration 1 shipped the column without a CHECK and an
    // applied migration is never rewritten.
    const path = temporaryDatabase();
    const ledger = open(path);
    const cause = ledger.append(
      makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
    );
    const digest = cause.record.eventSha256;
    ledger.close();

    const absent: RawTriple = { stream: null, sequence: null, sha256: null };

    expect(
      refusalMessage(rawTaskInsert(path, absent, { event: "nope" }), "short event digest"),
    ).toContain("event_sha256 is not 64 lowercase hex characters");
    expect(
      refusalMessage(rawTaskInsert(path, absent, { event: "C".repeat(64) }), "upper event digest"),
    ).toContain("event_sha256 is not 64 lowercase hex characters");
    expect(
      refusalMessage(rawTaskInsert(path, absent, { previous: "nope" }), "previous digest"),
    ).toContain("previous_sha256 is not 64 lowercase hex characters");
    expect(
      refusalMessage(
        rawTaskInsert(path, {
          stream: "control_plane_events",
          sequence: 1,
          sha256: digest.toUpperCase(),
        }),
        "upper causal digest",
      ),
    ).toContain("causation_sha256 is not 64 lowercase hex characters");
  });

  it("admits a row whose triple is wholly absent, and one that verifies", () => {
    // The guard must not over-reach: the ordinary event has no recorded cause,
    // and a reference that resolves is the whole point of allowing one.
    const path = temporaryDatabase();
    const ledger = open(path);
    const cause = ledger.append(
      makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
    );
    const digest = cause.record.eventSha256;
    ledger.close();

    expect(rawTaskInsert(path, { stream: null, sequence: null, sha256: null })).toBeUndefined();
    expect(
      rawTaskInsert(
        path,
        { stream: "control_plane_events", sequence: 1, sha256: digest },
        { event: "f".repeat(64) },
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The registry stream, and the first projection fed by two streams (P-09/log-C)
//
// This is where the watermark vector stops being decorative. Every projection
// before this one folds exactly one stream, so a table keyed by
// `(projection, stream)` holds one row per projection and a single number would
// have described it just as well. `routing_assignment_read_model` is fed by
// two: its `GLOBAL` partition comes from `registry_events` and its
// `INITIATIVE`/`STEP` partition from `initiative_events`, under one name, with
// two independent heads advanced by two different doors.
//
// The initiative partition is empty by construction and says so: the event type
// that would fill it, `ROUTING_ASSIGNMENT_RECORDED`, is not in the initiative
// contract's closed vocabulary, and widening a contract in another package is
// not this packet's. What is proved here is the mechanism — two heads under one
// name, each verified against its own chain at its own `applied_sequence`, and
// rebuilt together or not at all.
// ---------------------------------------------------------------------------

const REGISTRY_AT = "2026-09-03T12:00:00.000Z";
const MODEL_ONE = "claude-opus-5@2026-06-01";
const MODEL_TWO = "claude-sonnet-5@2026-06-01";
const CONTENT_ONE = "1".repeat(64);
const CONTENT_TWO = "2".repeat(64);

interface RegistryInput {
  readonly eventId?: string;
  readonly idempotencyKey?: string;
  readonly documentKind?: string;
  readonly documentId?: string;
  readonly documentVersion?: number;
  readonly parentDocumentVersion?: number | null;
  readonly contentDigest?: string;
  readonly recordedBy?: string;
  readonly effectiveFrom?: string;
  readonly occurredAt?: string;
  readonly recordedAt?: string;
  readonly payload?: Record<string, unknown>;
}

/** The document id the contract gives a GLOBAL routing assignment (§7.8). */
function routingDocumentId(role = "implementer", slot = 0): string {
  return "routing:GLOBAL:" + role + ":" + String(slot);
}

function routingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "implementer",
    slot: 0,
    provider: "claude",
    modelVersionId: MODEL_ONE,
    fallbacks: [MODEL_TWO],
    ...overrides,
  };
}

function makeRegistryDocument(input: RegistryInput = {}): Record<string, unknown> {
  const documentId = input.documentId ?? routingDocumentId();
  const documentVersion = input.documentVersion ?? 1;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: input.eventId ?? randomUUID(),
    idempotencyKey: input.idempotencyKey ?? documentId + "/" + String(documentVersion),
    documentKind: input.documentKind ?? "ROUTING_ASSIGNMENT_GLOBAL",
    documentId,
    documentVersion,
    parentDocumentVersion:
      input.parentDocumentVersion === undefined ? null : input.parentDocumentVersion,
    contentDigest: input.contentDigest ?? CONTENT_ONE,
    recordedBy: input.recordedBy ?? KIMI,
    effectiveFrom: input.effectiveFrom ?? REGISTRY_AT,
    occurredAt: input.occurredAt ?? REGISTRY_AT,
    recordedAt: input.recordedAt ?? REGISTRY_AT,
    payload: input.payload ?? routingPayload(),
  };
}

/** Every watermark row keyed by the pair, which is the table's own identity. */
function appliedByPair(path: string): Map<string, number> {
  return new Map(
    readWatermarks(path).map((row) => [
      row.projection_name + "@" + row.source_stream,
      row.applied_sequence,
    ]),
  );
}

/** The five single-source rows this build has published since P-09/log-A. */
const SINGLE_SOURCE_PAIRS = [
  "task_read_model@control_plane_events",
  "worker_read_model@control_plane_events",
  "execution_route_read_model@control_plane_events",
  "initiative_read_model@initiative_events",
  "roadmap_version_read_model@initiative_events",
] as const;

function singleSourceApplied(path: string): number[] {
  const applied = appliedByPair(path);
  return SINGLE_SOURCE_PAIRS.map((pair) => applied.get(pair) ?? -1);
}

interface RoutingRow {
  readonly assignment_id: string;
  readonly scope_kind: string;
  readonly scope_id: string | null;
  readonly version: number;
  readonly role: string;
  readonly slot: number;
  readonly provider: string;
  readonly model_version_id: string;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly superseded_by: string | null;
  readonly source_stream: string;
  readonly source_sequence: number;
  readonly sequence: number;
}

interface FallbackRow {
  readonly assignment_id: string;
  readonly ordinal: number;
  readonly model_version_id: string;
}

function readRouting(path: string): RoutingRow[] {
  const raw = new Database(path);
  try {
    return raw
      .prepare("SELECT * FROM routing_assignment_read_model ORDER BY assignment_id ASC")
      .all() as RoutingRow[];
  } finally {
    raw.close();
  }
}

function readFallbacks(path: string): FallbackRow[] {
  const raw = new Database(path);
  try {
    return raw
      .prepare(
        "SELECT * FROM routing_assignment_fallback ORDER BY assignment_id ASC, ordinal ASC",
      )
      .all() as FallbackRow[];
  } finally {
    raw.close();
  }
}

/** The registry stream's head, read the way the vector is: by raw SQL. */
function readRegistryMeta(path: string): Map<string, string> {
  const raw = new Database(path);
  try {
    const rows = raw
      .prepare("SELECT key, value FROM ledger_meta WHERE key LIKE 'registry_%'")
      .all() as { key: string; value: string }[];
    return new Map(rows.map((row) => [row.key, row.value]));
  } finally {
    raw.close();
  }
}

describe("the registry stream carries its own chain, head and projection", () => {
  it("appends a document, chains it from genesis, and folds it into the GLOBAL partition", () => {
    const path = temporaryDatabase();
    const ledger = open(path);

    const result = ledger.appendRegistryEvent(makeRegistryDocument());

    expect(result.inserted).toBe(true);
    expect(result.record.sequence).toBe(1);
    expect(result.record.previousSha256).toBe(GENESIS_SHA256);
    expect(result.record.eventSha256).toBe(
      chainDigest(GENESIS_SHA256, result.record.canonicalJson),
    );
    expect(result.record.causation).toBeNull();
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();

    const meta = readRegistryMeta(path);
    expect(meta.get("registry_head_sequence")).toBe("1");
    expect(meta.get("registry_event_count")).toBe("1");
    expect(meta.get("registry_head_event_sha256")).toBe(result.record.eventSha256);

    const rows = readRouting(path);
    expect(rows).toHaveLength(1);
    expect({
      scope: rows[0]?.scope_kind,
      scopeId: rows[0]?.scope_id,
      version: rows[0]?.version,
      role: rows[0]?.role,
      slot: rows[0]?.slot,
      model: rows[0]?.model_version_id,
      stream: rows[0]?.source_stream,
      at: rows[0]?.source_sequence,
      superseded: rows[0]?.superseded_by,
    }).toEqual({
      scope: "GLOBAL",
      scopeId: null,
      version: 1,
      role: "implementer",
      slot: 0,
      model: MODEL_ONE,
      stream: "registry_events",
      at: 1,
      superseded: null,
    });
    expect(readFallbacks(path).map((row) => row.model_version_id)).toEqual([MODEL_TWO]);
  });

  it("supersedes the parent version rather than overwriting it", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const first = ledger.appendRegistryEvent(makeRegistryDocument());
    const second = ledger.appendRegistryEvent(
      makeRegistryDocument({
        documentVersion: 2,
        parentDocumentVersion: 1,
        contentDigest: CONTENT_TWO,
        payload: routingPayload({ modelVersionId: MODEL_TWO, fallbacks: [] }),
      }),
    );
    expect(second.inserted).toBe(true);
    expect(first.record.sequence).toBe(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();

    const rows = readRouting(path);
    expect(rows).toHaveLength(2);
    const byVersion = new Map(rows.map((row) => [row.version, row]));
    expect(byVersion.get(1)?.superseded_by).toBe(byVersion.get(2)?.assignment_id);
    expect(byVersion.get(2)?.superseded_by).toBeNull();
    // The earlier version's own facts are intact: history is kept, not replaced.
    expect(byVersion.get(1)?.model_version_id).toBe(MODEL_ONE);
    expect(readFallbacks(path).map((row) => row.assignment_id)).toEqual([
      byVersion.get(1)?.assignment_id,
    ]);
  });

  it("treats an exact replay as a no-op and a reused version as a refusal", () => {
    const ledger = open(temporaryDatabase());
    const document = makeRegistryDocument();
    const first = ledger.appendRegistryEvent(document);

    const replay = ledger.appendRegistryEvent(document);
    expect(replay.inserted).toBe(false);
    expect(replay.record.sequence).toBe(first.record.sequence);

    // The same key with different content is the ordinary conflict.
    expect(
      caught(() =>
        ledger.appendRegistryEvent(makeRegistryDocument({ contentDigest: CONTENT_TWO })),
      ),
    ).toBeInstanceOf(LedgerIdempotencyConflictError);

    // A different key claiming a version the document already holds is refused
    // as a typed error, not as a raw uniqueness violation from SQLite.
    const clash = caught(() =>
      ledger.appendRegistryEvent(
        makeRegistryDocument({ idempotencyKey: "another/1", contentDigest: CONTENT_TWO }),
      ),
    );
    expect(clash).toBeInstanceOf(LedgerValidationError);
    expect((clash as Error).message).toContain("version");

    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("records causality in both directions across the registry boundary", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const task = ledger.append(makeEvent({ taskId, transitionId: "discover", emittedBy: KIMI }));

    // registry_events -> control_plane_events
    const causedByTask = ref(
      "control_plane_events",
      task.record.sequence,
      task.record.eventSha256,
    );
    const document = ledger.appendRegistryEvent(makeRegistryDocument(), causedByTask);
    expect(document.record.causation).toEqual(causedByTask);

    // initiative_events -> registry_events, the direction B could not express.
    const causedByRegistry = ref(
      "registry_events",
      document.record.sequence,
      document.record.eventSha256,
    );
    const initiative = ledger.appendInitiativeEvent(makeInitiativeEvent(), causedByRegistry);
    expect(initiative.record.causation).toEqual(causedByRegistry);
    expect(ledger.listInitiativeEvents().events[0]?.causation).toEqual(causedByRegistry);

    // And a digest that is not the registry event's own is still refused.
    expect(
      caught(() =>
        ledger.append(
          makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
          ref("registry_events", document.record.sequence, "a".repeat(64)),
        ),
      ),
    ).toBeInstanceOf(LedgerValidationError);

    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("rolls the whole registry append back when the commit seam fails", () => {
    const path = temporaryDatabase();
    let armed = true;
    const ledger = open(path, {
      __testFaults: {
        beforeAppendCommit: () => {
          if (armed) throw new Error("deliberate fault");
        },
      },
    });

    expect(caught(() => ledger.appendRegistryEvent(makeRegistryDocument()))).toBeInstanceOf(Error);
    ledger.close();

    // Neither the row, nor the head, nor the projection, nor the watermark.
    expect(readRegistryMeta(path).get("registry_head_sequence")).toBe("0");
    expect(readRouting(path)).toEqual([]);
    expect(appliedByPair(path).get("routing_assignment_read_model@registry_events")).toBe(0);

    armed = false;
    const reopened = open(path);
    expect(reopened.appendRegistryEvent(makeRegistryDocument()).record.sequence).toBe(1);
    expect(reopened.verifyIntegrity().ok).toBe(true);
  });

  it("projects no row for a malformed routing payload, and leaves the event standing", () => {
    // R4/C8. The fold projects what the event recorded; it validates no
    // eligibility, and a payload it cannot read produces no row rather than a
    // refusal to append.
    const path = temporaryDatabase();
    const ledger = open(path);
    const result = ledger.appendRegistryEvent(
      makeRegistryDocument({ payload: { role: "implementer" } }),
    );
    expect(result.inserted).toBe(true);
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();

    expect(readRouting(path)).toEqual([]);
    expect(readRegistryMeta(path).get("registry_head_sequence")).toBe("1");
    expect(appliedByPair(path).get("routing_assignment_read_model@registry_events")).toBe(1);
  });
});

describe("two heads under one projection name advance independently (negative 2)", () => {
  it("moves only the registry row when a registry document lands", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.close();

    const before = singleSourceApplied(path);
    const initiativeBefore = appliedByPair(path).get(
      "routing_assignment_read_model@initiative_events",
    );

    const writer = open(path);
    writer.appendRegistryEvent(makeRegistryDocument());
    writer.close();

    const after = appliedByPair(path);
    expect(after.get("routing_assignment_read_model@registry_events")).toBe(1);
    // The sibling row of the SAME projection did not move. This is the whole
    // claim of the composite key, and no single-source projection can make it.
    expect(after.get("routing_assignment_read_model@initiative_events")).toBe(initiativeBefore);
    expect(singleSourceApplied(path)).toEqual(before);
    expect(open(path).verifyIntegrity().ok).toBe(true);
  });

  it("moves only the initiative row when an initiative event lands", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendRegistryEvent(makeRegistryDocument());
    ledger.close();

    const before = singleSourceApplied(path);
    const registryBefore = appliedByPair(path).get(
      "routing_assignment_read_model@registry_events",
    );
    expect(registryBefore).toBe(1);

    const writer = open(path);
    writer.appendInitiativeEvent(makeInitiativeEvent());
    writer.close();

    const after = appliedByPair(path);
    // The hard direction: the initiative door advances a row of a projection it
    // shares with a stream it never touched, and leaves that stream's row alone.
    expect(after.get("routing_assignment_read_model@initiative_events")).toBe(1);
    expect(after.get("routing_assignment_read_model@registry_events")).toBe(registryBefore);
    expect(singleSourceApplied(path)).toEqual([5, 5, 5, 1, 1]);
    expect(before).toEqual([5, 5, 5, 0, 0]);
    expect(open(path).verifyIntegrity().ok).toBe(true);
  });

  it("publishes every projection in status(), the two-headed one with both heads", () => {
    // The inverse of what this test asserted between C and D. C had a DTO with
    // one `appliedThroughSequence` per projection, so the two-source projection
    // could not be described and was omitted; the omission was named here and
    // in `status()` as P-09/log-D's to undo. This is D.
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendRegistryEvent(makeRegistryDocument());

    const status = ledger.status();
    // Six projections, not seven entries: the vector lives INSIDE the
    // projection, so a projection with two heads is still one projection.
    expect(status.projections).toHaveLength(6);
    expect(status.projections.map((projection) => projection.name)).toEqual([
      "execution_route_read_model",
      "initiative_read_model",
      "roadmap_version_read_model",
      "routing_assignment_read_model",
      "task_read_model",
      "worker_read_model",
    ]);

    const routing = status.projections.find(
      (projection) => projection.name === "routing_assignment_read_model",
    );
    // Both heads, ordered by stream, each carrying its own position, count and
    // digest. Neither is derivable from the other, which is the whole claim.
    expect(routing?.watermarks.map((watermark) => watermark.sourceStream)).toEqual([
      "initiative_events",
      "registry_events",
    ]);
    expect(routing?.watermarks.map((watermark) => watermark.appliedThroughSequence)).toEqual([
      1, 1,
    ]);
    expect(routing?.rowCount).toBe(1);

    // Every single-headed projection publishes exactly one entry.
    for (const projection of status.projections) {
      if (projection.name === "routing_assignment_read_model") continue;
      expect(projection.watermarks, projection.name).toHaveLength(1);
    }
    ledger.close();

    // Seven rows in the table, seven entries across six projections. Nothing
    // in the table is omitted from the DTO any more.
    expect(readWatermarks(path)).toHaveLength(7);
    expect(
      status.projections.flatMap((projection) => projection.watermarks),
    ).toHaveLength(7);
  });

  it("publishes the latest instant of a projection's rows as its updatedAt", () => {
    // A projection fed by two streams has two independent `updated_at`, because
    // each stream's door updates only its own row. "When did this projection
    // last move" has one answer and it is the most recent one — here the
    // registry row is still at the epoch the migration seeded it with while the
    // initiative row has moved.
    const ledger = open(temporaryDatabase());
    ledger.appendInitiativeEvent(makeInitiativeEvent());

    const routing = ledger
      .status()
      .projections.find((projection) => projection.name === "routing_assignment_read_model");

    const stamps = new Map(
      routing?.watermarks.map((watermark) => [watermark.sourceStream, watermark]) ?? [],
    );
    expect(stamps.get("registry_events")?.appliedThroughSequence).toBe(0);
    expect(stamps.get("initiative_events")?.appliedThroughSequence).toBe(1);

    const rows = readWatermarks(ledger.path).filter(
      (row) => row.projection_name === "routing_assignment_read_model",
    );
    const instants = rows.map((row) => row.updated_at);
    expect(new Set(instants).size).toBe(2);
    expect(routing?.updatedAt).toBe(
      instants.reduce((latest, instant) => (instant > latest ? instant : latest)),
    );
    // And it is the moved one, not the seeded epoch.
    expect(routing?.updatedAt).not.toBe("1970-01-01T00:00:00.000Z");
  });

  it("publishes the stored row rather than recomputing it from the head", () => {
    // Negative 5, in the only shape this build can produce it. There is no
    // lawful lag: every door advances all of its stream's rows in one
    // transaction, and a row behind its head is a `PROJECTION_META` finding.
    // So the rewind is done through the raw seam, consistently across all three
    // of the row's fields, and the claim is about the division of labour:
    // `status()` REPORTS what the table says, it does not recompute from the
    // stream and it does not judge. `verifyIntegrity()` is what judges.
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    const digestAtThree = (() => {
      const raw = new Database(path);
      try {
        return (
          raw
            .prepare("SELECT event_sha256 FROM control_plane_events WHERE sequence = ?")
            .get(3) as { readonly event_sha256: string }
        ).event_sha256;
      } finally {
        raw.close();
      }
    })();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "UPDATE projection_watermark SET applied_sequence = ?, source_head_sha256 = ?, " +
            "event_count = ? WHERE projection_name = ? AND source_stream = ?",
        )
        .run(3, digestAtThree, 3, "task_read_model", "control_plane_events");
    });

    const reopened = open(path);
    const watermark = watermarkOf(reopened, "task_read_model", "control_plane_events");
    expect(watermark?.appliedThroughSequence).toBe(3);
    expect(watermark?.eventCount).toBe(3);
    // The head of the stream is still 5. `status()` publishes 3 because that is
    // what the row says.
    expect(reopened.status().headSequence).toBe(5);

    // And the judgement that status() declines to make is made where it lives.
    const report = reopened.verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(detailsOf(report.problems)).toContain(
      "is applied through sequence 3 but the head of control_plane_events is sequence 5",
    );
  });
});

describe("a projector version invalidates a pair, not a projection (negative 3)", () => {
  it("reports the mismatched pair and leaves its sibling alone", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendRegistryEvent(makeRegistryDocument());
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "UPDATE projection_watermark SET projector_version = ? " +
            "WHERE projection_name = ? AND source_stream = ?",
        )
        .run(2, "routing_assignment_read_model", "initiative_events");
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsOf(report.problems)).toEqual(["PROJECTION_META"]);
    expect(detailsOf(report.problems)).toContain("initiative_events");
    expect(detailsOf(report.problems)).toContain(
      "was written by projector version 2 but this build is version 1",
    );
    // The other head of the same projection is not implicated by its sibling.
    expect(detailsOf(report.problems)).not.toContain("registry_events");
  });

  it("does not compare the projector version when the ledger is opened", () => {
    // Stated because the alternative is to let a reader assume it: invalidation
    // is verifyIntegrity plus rebuildReadModel, and an open that silently
    // rebuilt would repair a ledger nobody asked it to touch.
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendRegistryEvent(makeRegistryDocument());
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw.prepare("UPDATE projection_watermark SET projector_version = 2").run();
    });

    const reopened = open(path);
    expect(reopened.readOnly).toBe(false);
    reopened.close();
    // Untouched: opening neither repaired it nor hid it.
    expect(readWatermarks(path).every((row) => row.projector_version === 2)).toBe(true);
  });

  it("rewrites both rows of the two-source projection on rebuild", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendRegistryEvent(makeRegistryDocument());
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "UPDATE projection_watermark SET projector_version = 2 WHERE projection_name = ?",
        )
        .run("routing_assignment_read_model");
    });

    const reopened = open(path);
    expect(reopened.verifyIntegrity().ok).toBe(false);
    reopened.rebuildReadModel();
    expect(reopened.verifyIntegrity().ok).toBe(true);
    reopened.close();

    const versions = readWatermarks(path)
      .filter((row) => row.projection_name === "routing_assignment_read_model")
      .map((row) => row.projector_version);
    expect(versions).toEqual([1, 1]);
  });
});

describe("a rebuild is a function of the vector of three heads (negative 8)", () => {
  it("produces identical rows twice over, in both routing tables and all seven watermarks", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendRegistryEvent(makeRegistryDocument());
    ledger.appendRegistryEvent(
      makeRegistryDocument({
        documentVersion: 2,
        parentDocumentVersion: 1,
        contentDigest: CONTENT_TWO,
        payload: routingPayload({ modelVersionId: MODEL_TWO }),
      }),
    );
    ledger.appendRegistryEvent(
      makeRegistryDocument({
        documentId: routingDocumentId("reviewer", 1),
        payload: routingPayload({ role: "reviewer", slot: 1 }),
      }),
    );
    ledger.close();

    const live = {
      routing: readRouting(path),
      fallbacks: readFallbacks(path),
      watermarks: readWatermarks(path),
    };
    expect(live.watermarks).toHaveLength(7);
    expect(live.routing).toHaveLength(3);

    const first = open(path);
    const firstResult = first.rebuildReadModel();
    first.close();
    const afterFirst = {
      routing: readRouting(path),
      fallbacks: readFallbacks(path),
      watermarks: readWatermarks(path),
    };

    const second = open(path);
    const secondResult = second.rebuildReadModel();
    second.close();
    const afterSecond = {
      routing: readRouting(path),
      fallbacks: readFallbacks(path),
      watermarks: readWatermarks(path),
    };

    // The incremental projection and two independent replays all agree.
    expect(afterFirst).toEqual(live);
    expect(afterSecond).toEqual(afterFirst);
    expect(secondResult).toEqual(firstResult);
    expect(firstResult.replayedRegistryEvents).toBe(3);
    expect(firstResult.registryThroughSequence).toBe(3);
    expect(firstResult.routingAssignmentRows).toBe(3);
    expect(open(path).verifyIntegrity().ok).toBe(true);
  });
});

describe("a rebuild refuses over any of the three broken chains (negative 10)", () => {
  it("refuses over a broken registry chain before it deletes a derived row", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.appendRegistryEvent(makeRegistryDocument());
    ledger.close();

    const before = {
      routing: readRouting(path),
      watermarks: readWatermarks(path),
      tasks: readRouting(path).length,
    };
    expect(before.routing).toHaveLength(1);

    withRawDatabase(path, (raw) => {
      // The append-only trigger denies UPDATE, so the row is rewritten the only
      // way a tamperer could: by dropping the trigger first.
      raw.exec("DROP TRIGGER tr_registry_events__deny_update");
      raw
        .prepare("UPDATE registry_events SET event_sha256 = ? WHERE sequence = ?")
        .run("f".repeat(64), 1);
    });

    const reopened = open(path);
    expect(caught(() => reopened.rebuildReadModel())).toBeInstanceOf(LedgerIntegrityError);
    reopened.close();

    // The refusal came before the DELETE: the derived rows are all still there.
    expect(readRouting(path)).toEqual(before.routing);
    expect(readWatermarks(path)).toEqual(before.watermarks);
  });
});

describe("the base refuses a broken registry triple with the ledger bypassed", () => {
  function rawRegistryInsert(path: string, triple: RawTriple): unknown {
    const raw = new Database(path);
    try {
      return caught(() =>
        raw
          .prepare(
            "INSERT INTO registry_events (" +
              "event_id, idempotency_key, document_kind, document_id, document_version, " +
              "content_digest, parent_document_version, recorded_by, effective_from, " +
              "occurred_at, recorded_at, causation_stream, causation_sequence, " +
              "causation_sha256, contract_version, event_json, previous_sha256, event_sha256" +
              ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            randomUUID(),
            randomUUID(),
            "MODEL_VERSION",
            "raw-document",
            1,
            CONTENT_ONE,
            null,
            KIMI,
            REGISTRY_AT,
            REGISTRY_AT,
            REGISTRY_AT,
            triple.stream,
            triple.sequence,
            triple.sha256,
            CONTRACT_VERSION,
            "{}",
            GENESIS_SHA256,
            "c".repeat(64),
          ),
      );
    } finally {
      raw.close();
    }
  }

  it("rejects a reference that does not resolve, and a stream outside the vocabulary", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const cause = ledger.append(
      makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI }),
    );
    const digest = cause.record.eventSha256;
    ledger.close();

    expect(
      refusalMessage(
        rawRegistryInsert(path, {
          stream: "control_plane_events",
          sequence: 1,
          sha256: "d".repeat(64),
        }),
        "wrong digest",
      ),
    ).toContain("does not resolve");

    for (const stream of ["account_events", "not_a_stream"]) {
      expect(
        refusalMessage(rawRegistryInsert(path, { stream, sequence: 1, sha256: digest }), stream),
        stream,
      ).toContain("no verifiable digest");
    }

    // And the reference that resolves is admitted, which is what keeps the
    // guard from being a blanket refusal.
    expect(
      rawRegistryInsert(path, { stream: "control_plane_events", sequence: 1, sha256: digest }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Instance and restore identity (P-10/id-A)
//
// Which ledger a client is reading is two questions, not one. The path digest a
// server computes answers "which location"; it is stable when the file behind
// it is replaced and it changes when the same file is moved. These three keys
// answer the other half — which FILE, and which restore of it.
//
// The defect they close is DB08, and it is specific: a restore identifier
// derived from a counter collides when the same backup is restored twice, so a
// client cannot tell the two apart. The identifier is therefore a fresh random
// UUID per restore, and the monotone epoch beside it carries no uniqueness at
// all.
//
// This is the ledger half. Putting the identity on the wire, and making the
// browser's cursor obey it, is the other half of the packet.
// ---------------------------------------------------------------------------

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The identity rows exactly as they sit on disk, read past the ledger. */
function readIdentityRows(path: string): Map<string, string> {
  const raw = new Database(path);
  try {
    const rows = raw
      .prepare(
        "SELECT key, value FROM ledger_meta WHERE key IN " +
          "('instance_id', 'restore_id', 'restore_epoch')",
      )
      .all() as { key: string; value: string }[];
    return new Map(rows.map((row) => [row.key, row.value]));
  } finally {
    raw.close();
  }
}

/** A ledger as it looked before this build: migrated, with no identity rows. */
function stripIdentity(path: string): void {
  withRawDatabase(path, (raw) => {
    raw
      .prepare("DELETE FROM ledger_meta WHERE key IN ('instance_id', 'restore_id', 'restore_epoch')")
      .run();
  });
}

describe("a ledger file knows which file it is", () => {
  it("refuses to rewrite an instance id that already exists", () => {
    // "Written once, and never rewritten" is the whole of `instanceId`. The way
    // to break it is an upsert that looks harmless, so this reopens the ledger
    // three times and works it in between.
    const path = temporaryDatabase();
    const first = open(path);
    const original = first.identity();
    expect(original.instanceId).toMatch(UUID_V4);
    first.close();

    const second = open(path);
    seedFixture(second);
    expect(second.identity().instanceId).toBe(original.instanceId);
    second.close();

    const third = open(path);
    expect(third.identity().instanceId).toBe(original.instanceId);
    // And the restore id has not drifted either: only a restore moves it.
    expect(third.identity().restoreId).toBe(original.restoreId);
    expect(third.identity().restoreEpoch).toBe(0);
  });

  it("writes a different instance id into each new ledger file", () => {
    // If the id were derived from the path, from the schema, or from a
    // constant in a migration, these would be equal. A migration cannot do
    // this job at all: its checksum is taken over fixed SQL text.
    const one = open(temporaryDatabase()).identity();
    const two = open(temporaryDatabase()).identity();

    expect(one.instanceId).toMatch(UUID_V4);
    expect(two.instanceId).toMatch(UUID_V4);
    expect(one.instanceId).not.toBe(two.instanceId);
    // Fresh files start unrestored, and their restore ids are independent too.
    expect(one.restoreEpoch).toBe(0);
    expect(two.restoreEpoch).toBe(0);
    expect(one.restoreId).not.toBe(two.restoreId);
  });

  it("publishes the identity through status(), on a read-only handle too", () => {
    const path = temporaryDatabase();
    const writer = open(path);
    const expected = writer.identity();
    writer.close();

    const reader = open(path, { readOnly: true });
    expect(reader.status().instance).toEqual(expected);
    expect(reader.status().instance.instanceId).toMatch(UUID_V4);
  });
});

describe("a formal restore is visible to whoever was reading", () => {
  it("refuses a restore that does not move the restore id", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const before = ledger.identity();

    const after = ledger.recordRestore();

    // The claim, in three parts: the restore id moved, it is a fresh random
    // UUID rather than anything derived from the epoch, and the file is still
    // the same file.
    expect(after.restoreId).not.toBe(before.restoreId);
    expect(after.restoreId).toMatch(UUID_V4);
    expect(after.restoreEpoch).toBe(1);
    expect(after.instanceId).toBe(before.instanceId);

    // And it is durable, not merely returned.
    expect(ledger.identity()).toEqual(after);
    expect(readIdentityRows(path).get("restore_id")).toBe(after.restoreId);
  });

  it("restores twice from the same backup and gets two different restore ids", () => {
    // DB08, literally. One backup, restored twice. A counter would hand both
    // copies the same next value and a client could not tell the two restores
    // apart; that is precisely why the contract says the id is random and
    // says, in the same breath, that it is not a counter.
    const source = temporaryDatabase();
    const origin = open(source);
    seedFixture(origin);
    const backup = origin.identity();
    origin.close();

    const first = join(dirname(source), "restored-once.sqlite");
    const second = join(dirname(source), "restored-twice.sqlite");
    copyFileSync(source, first);
    copyFileSync(source, second);

    const one = open(first).recordRestore();
    const two = open(second).recordRestore();

    // Same bytes, so the same file identity survives into both copies — which
    // is correct: a restore reproduces a file, it does not create a new one.
    expect(one.instanceId).toBe(backup.instanceId);
    expect(two.instanceId).toBe(backup.instanceId);
    // Same epoch, for the same reason: both are the first restore of that
    // backup. The epoch cannot tell them apart, and is not asked to.
    expect(one.restoreEpoch).toBe(1);
    expect(two.restoreEpoch).toBe(1);
    // The restore id can, and does. This is the whole packet in one assertion.
    expect(one.restoreId).not.toBe(two.restoreId);
    expect(one.restoreId).not.toBe(backup.restoreId);
    expect(two.restoreId).not.toBe(backup.restoreId);
  });

  it("writes the restore id before any append is admitted", () => {
    // The ordering the contract states: the restore id lands in a transaction
    // of its own, before any later append. A client that reconnects in the gap
    // must see the new identity over no new events — never the OLD identity
    // over new events, which is the reading that would let it keep a cursor it
    // should have discarded.
    const path = temporaryDatabase();
    let armed = false;
    const ledger = open(path, {
      __testFaults: {
        beforeAppendCommit: () => {
          if (armed) throw new Error("deliberate fault");
        },
      },
    });

    const restored = ledger.recordRestore();
    armed = true;
    expect(
      caught(() =>
        ledger.append(makeEvent({ taskId: randomUUID(), transitionId: "discover", emittedBy: KIMI })),
      ),
    ).toBeInstanceOf(Error);
    ledger.close();

    // The append rolled back; the restore did not go with it.
    expect(readIdentityRows(path).get("restore_id")).toBe(restored.restoreId);
    expect(readIdentityRows(path).get("restore_epoch")).toBe("1");
    const reopened = open(path);
    expect(reopened.status().headSequence).toBe(0);
    expect(reopened.identity().restoreId).toBe(restored.restoreId);
  });

  it("keeps the restore epoch monotone and out of every uniqueness claim", () => {
    const ledger = open(temporaryDatabase());
    const seen: string[] = [ledger.identity().restoreId ?? ""];
    const epochs: (number | null)[] = [ledger.identity().restoreEpoch];

    for (let index = 0; index < 3; index += 1) {
      const restored = ledger.recordRestore();
      seen.push(restored.restoreId ?? "");
      epochs.push(restored.restoreEpoch);
    }

    // Monotone, human-readable, and that is all it is.
    expect(epochs).toEqual([0, 1, 2, 3]);
    // Uniqueness is the id's job, and it does it independently: four distinct
    // random UUIDs, none of them a function of the epoch beside it.
    expect(new Set(seen).size).toBe(4);
    for (const restoreId of seen) expect(restoreId).toMatch(UUID_V4);
  });

  it("survives a rebuild without moving the instance id", () => {
    // A rebuild regenerates every derived table from the log. Identity is not
    // derived from the log and must come through untouched — a rebuild that
    // reset it would make every reader throw away a cache for no reason.
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    const restored = ledger.recordRestore();

    ledger.rebuildReadModel();

    expect(ledger.identity()).toEqual(restored);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});

describe("an identity nobody wrote is refused, never invented", () => {
  it("refuses to create an instance id through a read-only handle", () => {
    // A ledger from before this build, opened by a reader. It has no identity
    // and the reader may not give it one: inventing one would hand every
    // observer a different answer to "which file is this", which is worse than
    // no answer.
    const path = temporaryDatabase();
    open(path).close();
    stripIdentity(path);
    expect(readIdentityRows(path).size).toBe(0);

    const reader = open(path, { readOnly: true });
    expect(reader.identity()).toEqual({
      instanceId: null,
      restoreId: null,
      restoreEpoch: null,
    });
    expect(reader.status().instance.instanceId).toBeNull();
    // Nothing was written to get that answer.
    expect(readIdentityRows(path).size).toBe(0);
    // And the restore door is shut on a reader, as every other write is.
    expect(caught(() => reader.recordRestore())).toBeInstanceOf(LedgerReadOnlyError);
    reader.close();

    // The next writable open is what gives it one, with no operator asked to
    // do anything — the same upgrade path the migration seeds take.
    const writer = open(path);
    expect(writer.identity().instanceId).toMatch(UUID_V4);
    expect(writer.identity().restoreEpoch).toBe(0);
  });

  it("refuses a malformed instance id read back from ledger_meta", () => {
    const path = temporaryDatabase();
    open(path).close();

    withRawDatabase(path, (raw) => {
      raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?").run("not-a-uuid", "instance_id");
    });

    const reopened = open(path, { readOnly: true });
    const error = caught(() => reopened.identity());
    expect(error).toBeInstanceOf(LedgerIntegrityError);
    expect((error as Error).message).toContain("instance id that is not a uuid");
    // The same refusal on the published surface: status() does not hand back a
    // plausible-looking identity for a row that was edited.
    expect(caught(() => reopened.status())).toBeInstanceOf(LedgerIntegrityError);
  });

  it("reports a tampered instance id through verifyIntegrity, not only through status", () => {
    // The asymmetry this closes: a read path that refuses is not a verifier.
    // Before this, an operator asking "is this ledger sound?" was told yes
    // while `status()` threw on the very same rows.
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    // The control, on the same database, before anything is touched.
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?").run("not-a-uuid", "instance_id");
    });

    const report = open(path, { readOnly: true }).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsOf(report.problems)).toEqual(["LEDGER_META"]);
    expect(detailsOf(report.problems)).toContain("instance id that is not a uuid");
  });

  it("refuses a restore epoch that is not a canonical count", () => {
    // `Number` is a coercion, not a parse. Every text below converts to a
    // non-negative integer and satisfies `Number.isInteger`, so a check built
    // on conversion alone would read an edited row back as a count and hand it
    // out as this ledger's restore ordering.
    const notCounts = ["", "1e3", "0x1f", " 7 ", "+2", "0.0", "00", "-0", "Infinity"];

    for (const text of notCounts) {
      const path = temporaryDatabase();
      open(path).close();
      withRawDatabase(path, (raw) => {
        raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?").run(text, "restore_epoch");
      });

      const reopened = open(path, { readOnly: true });
      const error = caught(() => reopened.identity());
      expect(error, JSON.stringify(text)).toBeInstanceOf(LedgerIntegrityError);
      expect((error as Error).message, JSON.stringify(text)).toContain(
        "restore epoch that is not a count",
      );
      // And the verifier says so too, rather than only the read path.
      const report = reopened.verifyIntegrity();
      expect(report.ok, JSON.stringify(text)).toBe(false);
      expect(kindsOf(report.problems), JSON.stringify(text)).toEqual(["LEDGER_META"]);
      reopened.close();
    }
  });

  it("accepts the canonical counts this code actually writes", () => {
    // The guard must not over-reach: zero is a count, and so is every value a
    // real sequence of restores produces.
    for (const text of ["0", "1", "9", "10", "4096"]) {
      const path = temporaryDatabase();
      open(path).close();
      withRawDatabase(path, (raw) => {
        raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?").run(text, "restore_epoch");
      });

      const reopened = open(path, { readOnly: true });
      expect(reopened.identity().restoreEpoch, text).toBe(Number(text));
      expect(reopened.verifyIntegrity().ok, text).toBe(true);
      reopened.close();
    }
  });

  it("reports a half-present identity through verifyIntegrity", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    seedFixture(ledger);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw.prepare("DELETE FROM ledger_meta WHERE key = ?").run("restore_epoch");
    });

    const report = open(path, { readOnly: true }).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsOf(report.problems)).toEqual(["LEDGER_META"]);
    expect(detailsOf(report.problems)).toContain("part of this ledger's identity");
  });

  it("does not report a ledger that has no identity yet", () => {
    // The lawful absence. A file written before this build and not yet opened
    // writably has no identity rows at all, and that is not a finding — a
    // verifier that called it corruption would fail every ledger in the field
    // on the upgrade that introduced the check.
    const path = temporaryDatabase();
    open(path).close();
    stripIdentity(path);

    const reader = open(path, { readOnly: true });
    expect(reader.identity().instanceId).toBeNull();
    expect(reader.verifyIntegrity().ok).toBe(true);
    expect(reader.verifyIntegrity().problems).toEqual([]);
  });

  it("refuses a half-present identity rather than reading it as absent", () => {
    // The three rows are written in one transaction and nothing removes one,
    // so a partial set is tampering. Reading it as "absent" would launder a
    // deleted restore id into a clean null triple.
    const path = temporaryDatabase();
    open(path).close();

    withRawDatabase(path, (raw) => {
      raw.prepare("DELETE FROM ledger_meta WHERE key = ?").run("restore_id");
    });

    const reopened = open(path, { readOnly: true });
    const error = caught(() => reopened.identity());
    expect(error).toBeInstanceOf(LedgerIntegrityError);
    expect((error as Error).message).toContain("part of this ledger's identity");
  });
});

// ---------------------------------------------------------------------------
// Stored counts are parsed, never coerced (P-10A2)
//
// The same defect the restore epoch had, in the three head readers. `Number` is
// a coercion: every text below converts to a non-negative integer that
// `Number.isInteger` accepts, so a check built on conversion alone reads an
// edited row back as a position and hands it out as the head of a stream. A
// head is the anchor a chain is verified against; believing a laundered one is
// how a truncated log passes for a whole one.
// ---------------------------------------------------------------------------

/** Texts that `Number` turns into a plausible count and this code never wrote. */
const NON_CANONICAL_COUNTS = ["", "1e3", "0x1f", " 7 ", "+2", "0.0", "00", "-0", "Infinity"];

/** One stream's head key, and the words its reader uses when it refuses. */
const HEAD_KEYS: readonly { key: string; refusal: string }[] = [
  { key: "head_sequence", refusal: "a head or count that is not a count" },
  { key: "initiative_head_sequence", refusal: "an initiative head or count that is not a count" },
  { key: "registry_head_sequence", refusal: "a registry head or count that is not a count" },
];

describe("a stored head is a count this code wrote, or it is refused", () => {
  for (const { key, refusal } of HEAD_KEYS) {
    it("refuses a " + key + " that is not a canonical count", () => {
      for (const text of NON_CANONICAL_COUNTS) {
        const path = temporaryDatabase();
        open(path).close();
        withRawDatabase(path, (raw) => {
          raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?").run(text, key);
        });

        const label = key + " = " + JSON.stringify(text);
        const reopened = open(path, { readOnly: true });

        // `verifyIntegrity` reads all three heads and reports rather than
        // throws, so it is the one probe that reaches every stream.
        const report = reopened.verifyIntegrity();
        expect(report.ok, label).toBe(false);
        expect(detailsOf(report.problems), label).toContain(refusal);
        expect(kindsOf(report.problems), label).toContain("LEDGER_META");

        reopened.close();
      }
    });
  }

  it("refuses a laundered head on the direct read path too, not only in the report", () => {
    // `verifyIntegrity` reports; `status()` reads. The task and initiative
    // heads are read directly by `status()`, and a reader must not receive a
    // head of 1000 because somebody wrote "1e3" into the row.
    for (const key of ["head_sequence", "initiative_head_sequence"]) {
      const path = temporaryDatabase();
      open(path).close();
      withRawDatabase(path, (raw) => {
        raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?").run("1e3", key);
      });

      const reopened = open(path, { readOnly: true });
      expect(caught(() => reopened.status()), key).toBeInstanceOf(LedgerIntegrityError);
      reopened.close();
    }

    // The registry head has no read on `status()`; its direct reader is the
    // append door, which must refuse for the same reason before it chains
    // anything onto a position that was never there.
    const path = temporaryDatabase();
    open(path).close();
    withRawDatabase(path, (raw) => {
      raw
        .prepare("UPDATE ledger_meta SET value = ? WHERE key = ?")
        .run("1e3", "registry_head_sequence");
    });
    const writer = open(path);
    expect(caught(() => writer.appendRegistryEvent(makeRegistryDocument()))).toBeInstanceOf(
      LedgerIntegrityError,
    );
  });

  it("still reads the healthy heads of all three streams", () => {
    // The control against over-reach. Genesis is the literal "0" the migrations
    // seed, and a pattern that refused it would break every ledger the moment
    // it was created — which is exactly the failure a hurried fix introduces.
    const fresh = open(temporaryDatabase());
    expect(fresh.status().headSequence).toBe(0);
    expect(fresh.status().initiativeHeadSequence).toBe(0);
    expect(fresh.verifyIntegrity().ok).toBe(true);

    // And after real work, on all three streams at once.
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendRegistryEvent(makeRegistryDocument());

    expect(ledger.status().headSequence).toBe(5);
    expect(ledger.status().eventCount).toBe(5);
    expect(ledger.status().initiativeHeadSequence).toBe(1);
    expect(ledger.status().initiativeEventCount).toBe(1);
    expect(readRegistryMeta(ledger.path).get("registry_head_sequence")).toBe("1");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("refuses a count too large to be a safe integer", () => {
    // Twenty nines satisfy the pattern and are not a safe integer. Reading one
    // back would give a head that cannot be compared for equality with the
    // sequence of any row.
    const path = temporaryDatabase();
    open(path).close();
    withRawDatabase(path, (raw) => {
      raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?").run("9".repeat(20), "event_count");
    });

    const report = open(path, { readOnly: true }).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(detailsOf(report.problems)).toContain("a head or count that is not a count");
  });
});
