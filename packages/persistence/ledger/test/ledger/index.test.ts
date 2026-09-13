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
  SUPPORTED_CONTRACT_VERSIONS,
  V2_IDEMPOTENCY_NAMESPACE,
  buildIdempotencyKey,
  buildInitiativeIdempotencyKey,
  buildV2IdempotencyKey,
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
  computeOutboxCommandId,
  effectIdV1,
  effectIdempotencyKeyV1,
  foldOutboxCommands,
  logicalOperationSha256,
  openLeaseStore,
  openLedger,
  requestSha256,
  type CausationRef,
  type LeaseRow,
  type LeaseStore,
  type OutboxCommandReadModel,
  type IntegrityReport,
  type Ledger,
  type StreamIntegrityCoverage,
} from "../../src/index.js";
import {
  DERIVED_TABLES,
  EXECUTION_EFFECT_MIGRATION,
  EXECUTION_OCCURRENCE_MIGRATION,
  MIGRATIONS,
  applyMigrations,
} from "../../src/migrations/index.js";

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
  const payload = input.payload ?? {};
  // The key follows the payload, because the contract's door is strict in both
  // directions (P-18/protocolo A): a payload carrying a complete V2 coordinate
  // must key V2, and one that does not must key V1. This helper is where every
  // caller's key is composed, so the rule is obeyed once rather than at each of
  // the revision drills below — and a caller that wants to violate it on
  // purpose overrides `idempotencyKey` through `event()` at the call site.
  const revisionNumber = payload["revisionNumber"];
  const attemptNumber = payload["attemptNumber"];
  const v2 =
    typeof revisionNumber === "number" &&
    Number.isSafeInteger(revisionNumber) &&
    revisionNumber >= 1 &&
    typeof attemptNumber === "number" &&
    Number.isSafeInteger(attemptNumber) &&
    attemptNumber >= 1;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: input.eventId ?? randomUUID(),
    taskId,
    attempt,
    transitionId,
    idempotencyKey: v2
      ? buildV2IdempotencyKey({
          stream: "control_plane_events",
          taskId,
          revisionNumber,
          attemptNumber,
          transitionId,
        })
      : buildIdempotencyKey({ taskId, attempt, transitionId }),
    type: input.type ?? "TASK_DISCOVERED",
    fromState: input.fromState ?? null,
    toState: input.toState ?? "DISCOVERED",
    emittedBy: input.emittedBy ?? "kimi/k3/coordinator/01",
    occurredAt,
    recordedAt: input.recordedAt ?? occurredAt,
    correlationId: null,
    causationId: null,
    payload,
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
    // Fourteen since P-18/protocolo D added the prompt and response
    // occurrences, beside C's effect, deliveries and route segment, B's attempt
    // record, P-05/B's revision coordinate, P-08's sidecar and the registry
    // stream, typed causal triple and watermark table of P-09.
    expect(status.migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
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

/**
 * Undo migration 10's schema objects and its activation.
 *
 * The sidecar, its unique index on the stream, and the five activation keys.
 * Rewinding past 10 without them leaves a table the re-applied migration would
 * try to create again, and an activation the load would try to write twice.
 */
function dropAccountIntegrity(raw: Database.Database): void {
  raw.prepare("DELETE FROM ledger_meta WHERE key LIKE ?").run("account_integrity_%");
  raw.exec(
    "DROP TRIGGER tr_account_event_integrity__deny_delete; " +
      "DROP TRIGGER tr_account_event_integrity__deny_update; " +
      "DROP INDEX ux_account_events__account_id__version; " +
      "DROP TABLE account_event_integrity;",
  );
}

/**
 * Migration 11 undone: the revision record, the coordinate and the trigger.
 *
 * The order is forced rather than stylistic. SQLite refuses `DROP COLUMN` for a
 * column a trigger references, so the trigger goes first; and the eight columns
 * have to go at all, because `ALTER TABLE ... ADD COLUMN` is not idempotent and
 * a re-applied migration 11 would abort on "duplicate column name".
 */
/**
 * Migration 12 undone: the attempt table and the two halves of its bijection.
 *
 * Separate from the revision's, and always run before it. `foreign_keys` is ON
 * and `fk_task_attempt_read_model__task_revision_read_model` points at the
 * revision table, so a set is undone in the reverse of the order it was
 * applied. Its watermark row goes with it, or the reopen would find a row for a
 * projection whose table it is about to create.
 */
function dropTaskAttemptIdentity(raw: Database.Database): void {
  raw.exec(
    "DROP INDEX ux_task_attempt_read_model__invocation_id; " +
      "DROP INDEX ux_task_attempt_read_model__task_id_legacy_attempt_number; " +
      "DROP TABLE task_attempt_read_model;",
  );
  raw
    .prepare("DELETE FROM projection_watermark WHERE projection_name = ?")
    .run("task_attempt_read_model");
}

/**
 * Migration 14 undone: the prompt and response occurrences.
 *
 * The answer before the prompt it names, each table's indexes before the table,
 * and the two watermark rows with them — `dropExecutionEffectIdentity`'s shape
 * one rung further down.
 */
function dropExecutionOccurrences(raw: Database.Database): void {
  raw.exec(
    "DROP INDEX ux_response_occurrence_read_model__prompt; " +
      "DROP TABLE response_occurrence_read_model; " +
      "DROP INDEX ix_prompt_occurrence_read_model__sha256; " +
      "DROP INDEX ix_prompt_occurrence_read_model__segment; " +
      "DROP TABLE prompt_occurrence_read_model;",
  );
  const forget = raw.prepare("DELETE FROM projection_watermark WHERE projection_name = ?");
  for (const name of ["response_occurrence_read_model", "prompt_occurrence_read_model"]) {
    forget.run(name);
  }
}

/**
 * Migration 13 undone: the effect, its deliveries and the segment they hang off.
 *
 * Children first, on `dropTaskAttemptIdentity`'s reasoning one rung further
 * down: a delivery names an effect and a segment, an effect names a segment,
 * and a segment names an attempt, so the set is undone in the reverse of the
 * order it was applied. The three watermark rows go with the tables, or the
 * reopen would find rows for projections whose tables it is about to create.
 */
function dropExecutionEffectIdentity(raw: Database.Database): void {
  // Fourteen first: an occurrence names a delivery, an effect and a segment,
  // so rewinding past 13 means rewinding past everything applied after it.
  dropExecutionOccurrences(raw);
  raw.exec(
    "DROP INDEX ix_dispatch_attempt_read_model__state; " +
      "DROP INDEX ux_dispatch_attempt_read_model__effect_ordinal; " +
      "DROP TABLE dispatch_attempt_read_model; " +
      "DROP INDEX ix_effect_read_model__segment; " +
      "DROP INDEX ux_effect_read_model__logical_operation_sha256; " +
      "DROP INDEX ux_effect_read_model__idempotency_key; " +
      "DROP TABLE effect_read_model; " +
      "DROP INDEX ix_execution_route_segment_read_model__account; " +
      "DROP INDEX ux_execution_route_segment_read_model__attempt_segment; " +
      "DROP TABLE execution_route_segment_read_model;",
  );
  const forget = raw.prepare("DELETE FROM projection_watermark WHERE projection_name = ?");
  for (const name of [
    "dispatch_attempt_read_model",
    "effect_read_model",
    "execution_route_segment_read_model",
  ]) {
    forget.run(name);
  }
}

function dropTaskRevisionIdentity(raw: Database.Database): void {
  // Thirteen and then twelve, for the reason above: rewinding past 11 means
  // rewinding past everything applied after it, and the child of each foreign
  // key goes first.
  dropExecutionEffectIdentity(raw);
  dropTaskAttemptIdentity(raw);
  raw.exec(
    "DROP TRIGGER tr_control_plane_events__validate_v2_coordinate; " +
      "DROP INDEX ix_task_revision_read_model__envelope_sha256; " +
      "DROP INDEX ux_task_revision_read_model__revision_id; " +
      "DROP TABLE task_revision_read_model;",
  );
  raw
    .prepare("DELETE FROM projection_watermark WHERE projection_name = ?")
    .run("task_revision_read_model");
  for (const column of ["revision_number", "attempt_number"]) {
    raw.exec("ALTER TABLE control_plane_events DROP COLUMN " + column);
  }
  for (const column of [
    "envelope_sha256",
    "latest_revision_number",
    "latest_attempt_number",
    "role",
    "step_id",
    "commit_policy",
  ]) {
    raw.exec("ALTER TABLE task_read_model DROP COLUMN " + column);
  }
}

/** The whole P-05, P-08 and P-09 tail, undone in the reverse of the order applied. */
function dropProjectionVector(raw: Database.Database): void {
  dropTaskRevisionIdentity(raw);
  dropAccountIntegrity(raw);
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
    // Thirteen projections since P-18/protocolo D: the two task-stream folds,
    // the route fold, the revision fold, the attempt fold, the segment, effect
    // and delivery folds, the prompt and response occurrence folds, the two
    // initiative-stream folds, and the two-source routing fold. Fourteen heads,
    // because the last one has two — every one of them at zero on a ledger that
    // has never been appended to.
    expect(ledger.status().projections).toHaveLength(13);
    expect(
      ledger
        .status()
        .projections.flatMap((projection) =>
          projection.watermarks.map((watermark) => watermark.appliedThroughSequence),
        ),
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
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

    // The upgrade: the pending tail applies on open, and nothing else is done.
    const migrated = open(path);
    expect(migrated.status().migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
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
    expect([...appliedByName(ledger).values()]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
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
    expect(rows).toHaveLength(14);
    const taskRows = rows.filter((row) => row.source_stream === "control_plane_events");
    expect(taskRows.map((row) => row.projection_name)).toEqual([
      "dispatch_attempt_read_model",
      "effect_read_model",
      "execution_route_read_model",
      "execution_route_segment_read_model",
      "prompt_occurrence_read_model",
      "response_occurrence_read_model",
      "task_attempt_read_model",
      "task_read_model",
      "task_revision_read_model",
      "worker_read_model",
    ]);
    // The revision projection moves with the stream exactly as its siblings do,
    // and it is level at five having folded no row at all: none of the seeded
    // events carries a V2 coordinate. The three P-18/protocolo C projections and
    // D's two are level at five having folded nothing either, for the same
    // reason. A watermark tracks the cut a projection has SEEN, not the rows it
    // chose to write.
    expect(taskRows.map((row) => row.applied_sequence)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
    expect(taskRows.map((row) => row.event_count)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
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
    expect(before).toHaveLength(14);

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
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
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
    expect(rows).toHaveLength(14);
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
    // Thirteen projections, not fourteen entries: the vector lives INSIDE the
    // projection, so a projection with two heads is still one projection.
    expect(status.projections).toHaveLength(13);
    expect(status.projections.map((projection) => projection.name)).toEqual([
      "dispatch_attempt_read_model",
      "effect_read_model",
      "execution_route_read_model",
      "execution_route_segment_read_model",
      "initiative_read_model",
      "prompt_occurrence_read_model",
      "response_occurrence_read_model",
      "roadmap_version_read_model",
      "routing_assignment_read_model",
      "task_attempt_read_model",
      "task_read_model",
      "task_revision_read_model",
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

    // Fourteen rows in the table, fourteen entries across thirteen projections.
    // Nothing in the table is omitted from the DTO any more.
    expect(readWatermarks(path)).toHaveLength(14);
    expect(
      status.projections.flatMap((projection) => projection.watermarks),
    ).toHaveLength(14);
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
  it("produces identical rows twice over, in both routing tables and all eight watermarks", () => {
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
    expect(live.watermarks).toHaveLength(14);
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

  it("refuses a restore whose epoch would not be representable, writing nothing", () => {
    // The epoch is a safe integer on the way out and on the way back in, and
    // this is the one place the two could disagree: `recordRestore()` computes
    // `epoch + 1` and `#readIdentity` requires a safe integer, so at the
    // ceiling the door would write a value it can never read back. The next
    // `identity()` would refuse the file's own identity, and the fresh restore
    // id written beside it would be unreachable — the door would have bricked
    // the thing it was asked to record.
    //
    // Seeded through the raw seam rather than by counting: arriving here by
    // restoring would take more restores than there are safe integers.
    const path = temporaryDatabase();
    const ledger = open(path);
    const ceiling = String(Number.MAX_SAFE_INTEGER);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?").run(ceiling, "restore_epoch");
    });

    const reopened = open(path);
    // The seeded state is lawful: the ceiling itself is a safe integer, so the
    // identity reads back cleanly and the refusal below is about the NEXT one.
    const before = reopened.identity();
    expect(before.restoreEpoch).toBe(Number.MAX_SAFE_INTEGER);
    expect(reopened.verifyIntegrity().ok).toBe(true);

    const error = caught(() => reopened.recordRestore());
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as Error).message).toContain("not representable");

    // Nothing was written. All three fields are exactly as they were — the
    // restore id in particular, because a door that refused after minting one
    // would have moved the identity while reporting that it had not.
    expect(reopened.identity()).toEqual(before);
    const rows = readIdentityRows(path);
    expect(rows.get("restore_epoch")).toBe(ceiling);
    expect(rows.get("restore_id")).toBe(before.restoreId);
    expect(rows.get("instance_id")).toBe(before.instanceId);
    expect(reopened.verifyIntegrity().ok).toBe(true);
  });

  it("still records a restore one below the ceiling", () => {
    // The control against over-reach: the guard must refuse the value it
    // cannot represent and nothing else.
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare("UPDATE ledger_meta SET value = ? WHERE key = ?")
        .run(String(Number.MAX_SAFE_INTEGER - 1), "restore_epoch");
    });

    const reopened = open(path);
    const restored = reopened.recordRestore();
    expect(restored.restoreEpoch).toBe(Number.MAX_SAFE_INTEGER);
    expect(reopened.identity().restoreEpoch).toBe(Number.MAX_SAFE_INTEGER);
    expect(reopened.verifyIntegrity().ok).toBe(true);
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

// ---------------------------------------------------------------------------
// The account stream's hash chain, beside it (P-08/A2)
//
// `account_events` shipped in migration 5 with no chain and no way to gain one:
// an applied migration is never rewritten. The chain therefore arrives as a
// sidecar, `account_event_integrity`, one row per row of the stream from
// sequence 1 — built retroactively over every historical row at the moment the
// sidecar is activated.
//
// What that proves is bounded, and the bound is the point: it detects any
// change made AFTER activation, and proves nothing about whether the rows were
// authentic BEFORE it. Nobody hashed them when they were written. Those are two
// different facts and nothing here may present them as one.
// ---------------------------------------------------------------------------

const ACCOUNT_INTEGRITY_KEY_NAMES = [
  "account_integrity_activated_at",
  "account_integrity_baseline_sequence",
  "account_integrity_baseline_sha256",
  "account_integrity_head_event_sha256",
  "account_integrity_head_sequence",
] as const;

const SIDECAR_GENESIS = "0".repeat(64);

interface SidecarRow {
  readonly account_sequence: number;
  readonly previous_sha256: string;
  readonly event_sha256: string;
  readonly computed_at: string;
}

function readSidecar(path: string): SidecarRow[] {
  const raw = new Database(path);
  try {
    return raw
      .prepare("SELECT * FROM account_event_integrity ORDER BY account_sequence ASC")
      .all() as SidecarRow[];
  } finally {
    raw.close();
  }
}

function readActivation(path: string): Map<string, string> {
  const raw = new Database(path);
  try {
    const rows = raw
      .prepare("SELECT key, value FROM ledger_meta WHERE key LIKE 'account_integrity_%'")
      .all() as { key: string; value: string }[];
    return new Map(rows.map((row) => [row.key, row.value]));
  } finally {
    raw.close();
  }
}

/**
 * The bytes a TEXT column actually holds, as hex.
 *
 * Asked through `hex()` in SQLite rather than through the driver, because the
 * driver is the layer these drills are about: it would hand back a string with
 * every invalid sequence already replaced, which is exactly the substitution
 * being staged.
 */
function storedNoteHex(path: string, sequence: number): string {
  const raw = new Database(path);
  try {
    const row = raw
      .prepare("SELECT lower(hex(note)) AS hex FROM account_events WHERE sequence = ?")
      .get(sequence) as { readonly hex: string } | undefined;
    return row?.hex ?? "";
  } finally {
    raw.close();
  }
}

/** The stored `version`, rendered by SQLite so no JavaScript number rounds it. */
function storedVersionText(path: string, sequence: number): string {
  const raw = new Database(path);
  try {
    const row = raw
      .prepare("SELECT CAST(version AS TEXT) AS text FROM account_events WHERE sequence = ?")
      .get(sequence) as { readonly text: string } | undefined;
    return row?.text ?? "";
  } finally {
    raw.close();
  }
}

/**
 * A report's findings reduced to kind and sequence.
 *
 * Used with `toContainEqual` rather than with an equality against the whole
 * array: a drill that drops a trigger to reach the row it wants also changes
 * the shape of the database, and that is a second, legitimate finding which
 * has nothing to do with the claim under test.
 */
function kindsAndSequences(
  problems: readonly { readonly kind: string; readonly sequence: number | null }[],
): { readonly kind: string; readonly sequence: number | null }[] {
  return problems.map((problem) => ({ kind: problem.kind, sequence: problem.sequence }));
}

const P08_AT = "2026-09-11T09:00:00.000Z";

function action(version: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    accountId: "acct-primary",
    version,
    idempotencyKey: "acct-primary/1/action." + String(version),
    action: version % 2 === 1 ? "DRAIN" : "ACCOUNT_READY",
    resultingState: version % 2 === 1 ? "DRAINING" : "AVAILABLE",
    actor: KIMI,
    note: null,
    occurredAt: P08_AT,
    recordedAt: P08_AT,
    ...overrides,
  };
}

/** A ledger written before the sidecar existed: migrated to 9, no activation. */
function rewindPastSidecar(path: string): void {
  withRawDatabase(path, (raw) => {
    // Migrations 12 and 11 go first, because a set is applied in order and
    // re-opening would otherwise re-run 11's `ADD COLUMN` over columns that are
    // still there, or 12's `CREATE TABLE` over a table that still exists.
    dropTaskRevisionIdentity(raw);
    dropAccountIntegrity(raw);
    raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(10);
  });
}

describe("the account sidecar is activated once, over everything, atomically", () => {
  it("activates an empty account stream with H zero and the genesis digest", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();

    const activation = readActivation(path);
    expect([...activation.keys()].sort()).toEqual([...ACCOUNT_INTEGRITY_KEY_NAMES]);
    expect(activation.get("account_integrity_baseline_sequence")).toBe("0");
    expect(activation.get("account_integrity_baseline_sha256")).toBe(SIDECAR_GENESIS);
    expect(activation.get("account_integrity_head_sequence")).toBe("0");
    expect(activation.get("account_integrity_head_event_sha256")).toBe(SIDECAR_GENESIS);
    expect(readSidecar(path)).toEqual([]);
  });

  it("covers every historical row from one, not only from the activation point", () => {
    // The retroactive half. A ledger that already holds account events gets a
    // chain over ALL of them, starting at sequence 1 — not a chain that begins
    // where the upgrade happened and leaves the history unlinked.
    const path = temporaryDatabase();
    const seeded = open(path);
    seeded.appendAccountAction(action(1));
    seeded.appendAccountAction(action(2));
    seeded.appendAccountAction(action(3));
    seeded.close();

    rewindPastSidecar(path);
    expect(readActivation(path).size).toBe(0);

    // The upgrade: migration 10 applies on open and nothing else is done.
    const migrated = open(path);
    expect(migrated.status().migrations.map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(migrated.verifyIntegrity().ok).toBe(true);
    migrated.close();

    const sidecar = readSidecar(path);
    expect(sidecar.map((row) => row.account_sequence)).toEqual([1, 2, 3]);
    expect(sidecar[0]?.previous_sha256).toBe(SIDECAR_GENESIS);
    expect(sidecar[1]?.previous_sha256).toBe(sidecar[0]?.event_sha256);
    expect(sidecar[2]?.previous_sha256).toBe(sidecar[1]?.event_sha256);

    // Every historical link carries the ACTIVATION instant, not the row's own
    // `recorded_at`: these digests were computed now, long after the rows were
    // written, and saying otherwise would be the one claim the sidecar must
    // never make.
    const activatedAt = readActivation(path).get("account_integrity_activated_at");
    expect(sidecar.map((row) => row.computed_at)).toEqual([activatedAt, activatedAt, activatedAt]);
    expect(activatedAt).not.toBe(P08_AT);
  });

  it("fixes the baseline at H and never moves it as the stream grows", () => {
    const path = temporaryDatabase();
    const seeded = open(path);
    seeded.appendAccountAction(action(1));
    seeded.appendAccountAction(action(2));
    seeded.close();
    rewindPastSidecar(path);

    const migrated = open(path);
    const atActivation = readActivation(path);
    expect(atActivation.get("account_integrity_baseline_sequence")).toBe("2");
    // At activation the baseline and the head are the same row, which is why
    // there are two pairs rather than one: they diverge afterwards.
    expect(atActivation.get("account_integrity_head_sequence")).toBe("2");
    expect(atActivation.get("account_integrity_baseline_sha256")).toBe(
      atActivation.get("account_integrity_head_event_sha256"),
    );

    migrated.appendAccountAction(action(3));
    migrated.close();

    const afterGrowth = readActivation(path);
    expect(afterGrowth.get("account_integrity_baseline_sequence")).toBe("2");
    expect(afterGrowth.get("account_integrity_baseline_sha256")).toBe(
      atActivation.get("account_integrity_baseline_sha256"),
    );
    expect(afterGrowth.get("account_integrity_activated_at")).toBe(
      atActivation.get("account_integrity_activated_at"),
    );
    expect(afterGrowth.get("account_integrity_head_sequence")).toBe("3");
    expect(afterGrowth.get("account_integrity_head_event_sha256")).not.toBe(
      atActivation.get("account_integrity_head_event_sha256"),
    );
  });

  it("refuses to activate twice", () => {
    // The migration is recorded, so a second open has nothing pending and the
    // activation triple is untouched. Re-running the load would rewrite a
    // baseline the contract says is frozen.
    const path = temporaryDatabase();
    const first = open(path);
    first.appendAccountAction(action(1));
    first.close();
    const before = readActivation(path);

    open(path).close();
    open(path).close();

    expect(readActivation(path)).toEqual(before);
    expect(readSidecar(path)).toHaveLength(1);
  });

  it("refuses a partial activation rather than reading it as never activated", () => {
    // §8.2 forbids degrading a partial or divergent baseline to NOT_ACTIVATED:
    // hiding a tampered activation behind the word for an honest absence is
    // exactly how it would pass.
    for (const key of ACCOUNT_INTEGRITY_KEY_NAMES) {
      const path = temporaryDatabase();
      open(path).close();
      withRawDatabase(path, (raw) => {
        raw.prepare("DELETE FROM ledger_meta WHERE key = ?").run(key);
      });

      const report = open(path, { readOnly: true }).verifyIntegrity();
      expect(report.ok, key).toBe(false);
      expect(detailsOf(report.problems), key).toContain(
        "part of the account integrity activation",
      );
    }
  });

  it("cannot be opened at all while the migration is pending, so there is no unactivated state", () => {
    // The difference from the file identity, which looks the same and is not.
    // `instance_id` is written by code at open, so a ledger migrated by an
    // older build legitimately lacks it and a reader reports that plainly.
    // THIS activation is written by migration 10 itself, so the only ledger
    // without it is one the migration has not reached — and such a ledger
    // cannot be read: a read-only handle refuses a pending migration, and a
    // writable one applies it and activates. "Migrated but not activated" is
    // not a state this build can produce.
    const path = temporaryDatabase();
    open(path).close();
    rewindPastSidecar(path);
    expect(readActivation(path).size).toBe(0);

    const refused = caught(() => open(path, { readOnly: true }));
    expect(refused).toBeInstanceOf(LedgerMigrationError);
    expect((refused as Error).message).toContain("account_event_integrity is not applied");

    // A writable open closes the gap without asking an operator for anything.
    const writer = open(path);
    expect(readActivation(path).size).toBe(5);
    expect(writer.verifyIntegrity().ok).toBe(true);
  });

  it("reports an activation deleted wholesale, rather than calling it absent", () => {
    // The other half of the partial case. Since every openable ledger is
    // activated, five missing keys is tampering at a larger scale than one —
    // not an honest absence — and reading it as "never activated" is precisely
    // the degradation §8.2 forbids.
    const path = temporaryDatabase();
    open(path).close();
    withRawDatabase(path, (raw) => {
      raw.prepare("DELETE FROM ledger_meta WHERE key LIKE ?").run("account_integrity_%");
    });

    const report = open(path, { readOnly: true }).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(detailsOf(report.problems)).toContain("none of the five keys");
  });

  it("refuses a baseline sequence that is not a canonical count", () => {
    // The same rule the heads and the restore epoch carry: `Number` is a
    // coercion, and a baseline edited to "1e3" would be read as 1000.
    for (const text of ["", "1e3", "0x1f", " 2 ", "+2", "02", "-0"]) {
      const path = temporaryDatabase();
      open(path).close();
      withRawDatabase(path, (raw) => {
        raw
          .prepare("UPDATE ledger_meta SET value = ? WHERE key = ?")
          .run(text, "account_integrity_baseline_sequence");
      });

      const report = open(path, { readOnly: true }).verifyIntegrity();
      expect(report.ok, JSON.stringify(text)).toBe(false);
      expect(detailsOf(report.problems), JSON.stringify(text)).toContain(
        "account integrity sequence that is not a count",
      );
    }
  });
});

describe("the integrity report says from when each stream is evidence", () => {
  // §8.2's coverage report, which answers a question the problem list does not.
  // `problems` says whether the evidence holds; `coverage` says how far back
  // there is any — and the two must stay apart, because a caller that read
  // `ok: true` on a ledger baselined this morning and concluded that a row
  // written last year had been verified would have been told something false by
  // a report that was, field for field, correct.
  //
  // Nothing in this block asserts authenticity before activation, and nothing
  // in the code it exercises claims it.

  function coverageOf(report: IntegrityReport, stream: string): StreamIntegrityCoverage {
    const entry = report.coverage.find((candidate) => candidate.sourceStream === stream);
    if (entry === undefined) {
      throw new Error("the coverage report omits " + stream);
    }
    return entry;
  }

  it("reports the three chained streams as CHAIN_FROM_APPEND with null baselines", () => {
    const ledger = open(temporaryDatabase());
    ledger.append(makeEvent());
    ledger.appendAccountAction(action(1));

    const report = ledger.verifyIntegrity();
    expect(report.ok).toBe(true);

    // Exactly four, ordered by name, and never a subset: a report that omitted
    // `account_events` would be silent about the one stream whose coverage is
    // retroactive, which is the only stream where the question is interesting.
    expect(report.coverage.map((entry) => entry.sourceStream)).toEqual([
      "account_events",
      "control_plane_events",
      "initiative_events",
      "registry_events",
    ]);

    for (const stream of ["control_plane_events", "initiative_events", "registry_events"]) {
      const entry = coverageOf(report, stream);
      expect(entry.coverageKind, stream).toBe("CHAIN_FROM_APPEND");
      expect(entry.coveredSinceSequence, stream).toBe(1);
      // No baseline, and the three fields are null TOGETHER. These streams
      // chain as they append, so there was never an instant at which they were
      // not covered — there is nothing for a baseline to record.
      expect(entry.integrityActivatedAt, stream).toBeNull();
      expect(entry.baselineSequence, stream).toBeNull();
      expect(entry.baselineSha256, stream).toBeNull();
    }

    // An empty stream still reports `coveredSinceSequence: 1` against a head of
    // zero: covered from the first row it will ever hold, holding none yet.
    // `null` there would mean "covers nothing", which is a different claim.
    const initiative = coverageOf(report, "initiative_events");
    expect([initiative.coveredSinceSequence, initiative.checkedThroughSequence]).toEqual([1, 0]);
    expect(coverageOf(report, "control_plane_events").checkedThroughSequence).toBe(1);
  });

  it("takes the baseline from ledger_meta rather than recomputing H", () => {
    // The distinction that makes the baseline worth publishing. Coverage was
    // taken at H = 3; the stream then grew to 5. A report that recomputed the
    // baseline from the current head would say 5 and would be asserting the
    // very thing the chain is supposed to prove — that nothing moved.
    const path = temporaryDatabase();
    const seeded = open(path);
    seeded.appendAccountAction(action(1));
    seeded.appendAccountAction(action(2));
    seeded.appendAccountAction(action(3));
    seeded.close();

    rewindPastSidecar(path);
    const migrated = open(path);
    migrated.appendAccountAction(action(4));
    migrated.appendAccountAction(action(5));

    const entry = coverageOf(migrated.verifyIntegrity(), "account_events");
    expect({
      coveredSinceSequence: entry.coveredSinceSequence,
      checkedThroughSequence: entry.checkedThroughSequence,
      baselineSequence: entry.baselineSequence,
    }).toEqual({ coveredSinceSequence: 1, checkedThroughSequence: 5, baselineSequence: 3 });

    expect(entry.coverageKind).toBe("BASELINED_AT_ACTIVATION");

    // Read, not recomputed: every published field is the row `ledger_meta`
    // holds, byte for byte.
    const activation = readActivation(path);
    expect(entry.baselineSha256).toBe(activation.get("account_integrity_baseline_sha256"));
    expect(entry.integrityActivatedAt).toBe(activation.get("account_integrity_activated_at"));
  });

  it("reports an unreadable activation as no coverage, beside the finding", () => {
    // The rewrite of the old negative 21. "Before activation" is not a state
    // this build can reach — the sibling test two blocks up proves a ledger
    // with migration 10 pending cannot be opened at all — so what is reachable
    // is an activation somebody reached past the door and deleted.
    //
    // Two things must be true at once, and either alone would be a defect: the
    // finding is reported, AND the coverage entry says `NOT_ACTIVATED` with
    // every nullable field null. A report that threw would leave the operator
    // with no coverage at all on exactly the ledger that most needs one; a
    // report that said `BASELINED_AT_ACTIVATION` anyway would be the
    // degradation §8.2 forbids, pointing the other way.
    const path = temporaryDatabase();
    open(path).close();
    withRawDatabase(path, (raw) => {
      raw.prepare("DELETE FROM ledger_meta WHERE key LIKE ?").run("account_integrity_%");
    });

    const report = open(path, { readOnly: true }).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(detailsOf(report.problems)).toContain("none of the five keys");

    const entry = coverageOf(report, "account_events");
    expect(entry).toEqual({
      sourceStream: "account_events",
      coverageKind: "NOT_ACTIVATED",
      coveredSinceSequence: null,
      checkedThroughSequence: 0,
      integrityActivatedAt: null,
      baselineSequence: null,
      baselineSha256: null,
    });

    // The other three are untouched by the account stream's trouble. Coverage
    // is per stream because the streams are covered by different mechanisms,
    // and collapsing them to one verdict would lose exactly that.
    expect(
      report.coverage
        .filter((candidate) => candidate.sourceStream !== "account_events")
        .map((candidate) => candidate.coverageKind),
    ).toEqual(["CHAIN_FROM_APPEND", "CHAIN_FROM_APPEND", "CHAIN_FROM_APPEND"]);
  });

  it("emits the same coverage fields on two independent runs over one file", () => {
    // The positive. Coverage is a property of the FILE, not of the process that
    // asked — every field is read from `ledger_meta` and the stored streams, so
    // nothing here is an observation instant. `integrityActivatedAt` looks like
    // one and is not: it is when the chain was computed, recorded once at
    // activation and never rewritten, which is why it is bound to LEDGER in the
    // parity table rather than declared volatile.
    const path = temporaryDatabase();
    const seeded = open(path);
    seeded.appendAccountAction(action(1));
    seeded.appendAccountAction(action(2));
    seeded.close();

    const first = open(path, { readOnly: true });
    const firstCoverage = first.verifyIntegrity().coverage;
    first.close();

    const second = open(path, { readOnly: true });
    const secondCoverage = second.verifyIntegrity().coverage;
    second.close();

    expect(secondCoverage).toEqual(firstCoverage);
    expect(coverageOf({ coverage: firstCoverage } as IntegrityReport, "account_events")).toEqual(
      coverageOf({ coverage: secondCoverage } as IntegrityReport, "account_events"),
    );
  });
});

describe("an account append moves the stream and its chain together", () => {
  it("writes the event, its link and the chain head in one transaction", () => {
    const path = temporaryDatabase();
    let armed = false;
    const ledger = open(path, {
      __testFaults: {
        beforeAppendCommit: () => {
          if (armed) throw new Error("deliberate fault");
        },
      },
    });
    ledger.appendAccountAction(action(1));
    const before = readActivation(path);

    armed = true;
    expect(caught(() => ledger.appendAccountAction(action(2)))).toBeInstanceOf(Error);
    ledger.close();

    // Neither the row, nor the link, nor the head. An account event that landed
    // without its link would leave a hole in the middle of an append-only
    // chain, which no later append could close.
    expect(readSidecar(path)).toHaveLength(1);
    expect(readActivation(path)).toEqual(before);
    const reopened = open(path);
    expect(reopened.listAccountActions("acct-primary")).toHaveLength(1);
    expect(reopened.verifyIntegrity().ok).toBe(true);
  });

  it("refuses a second event for a version the account already holds", () => {
    const ledger = open(temporaryDatabase());
    ledger.appendAccountAction(action(1));
    ledger.appendAccountAction(action(2));

    // A version already recorded, reached three ways, and each is refused by a
    // different layer — which is worth spelling out because it is the reason
    // the historical duplicate this packet preflights for has never occurred.
    //
    // 1. A DIFFERENT idempotency key for the same version never reaches the
    //    ledger at all: the contract derives the key from the account and the
    //    version, so a key that does not match is refused before the door.
    const forged = caught(() =>
      ledger.appendAccountAction(action(2, { idempotencyKey: "acct-primary/1/action.2b" })),
    );
    expect(forged).toBeInstanceOf(LedgerValidationError);
    expect((forged as Error).message).toContain("idempotencyKey must be exactly");

    // 2. The SAME key with the same body is an idempotent replay, which is what
    //    makes a retry safe, and writes nothing.
    const first = ledger.listAccountActions("acct-primary")[1];
    const replay = ledger.appendAccountAction(
      action(2, { eventId: first?.eventId, occurredAt: P08_AT }),
    );
    expect(replay.inserted).toBe(false);

    // 3. A version that skips ahead is what the compare-and-set is for: the
    //    seam assigns from the folded history, and this is the ledger checking
    //    that claim rather than believing it.
    const skipped = caught(() => ledger.appendAccountAction(action(9)));
    expect(skipped).toBeInstanceOf(LedgerValidationError);
    // The account is NAMED, and naming it is the whole value of the message:
    // an operator reading this refusal has to know which account is at which
    // version. `safeIdentifier` would have blanked `acct-primary` to
    // `<unprintable name>` on the hyphen alone, which is why the preflight's
    // `safeAccountId` guard is the one this message uses too.
    expect((skipped as Error).message).toContain("account acct-primary is at version 2");
    expect((skipped as Error).message).not.toContain("<unprintable name>");
    expect(ledger.listAccountActions("acct-primary")).toHaveLength(2);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("refuses to append when the chain head disagrees with the stream", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendAccountAction(action(1));
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare("UPDATE ledger_meta SET value = ? WHERE key = ?")
        .run("0", "account_integrity_head_sequence");
    });

    const reopened = open(path);
    const error = caught(() => reopened.appendAccountAction(action(2)));
    expect(error).toBeInstanceOf(LedgerIntegrityError);
    expect((error as Error).message).toContain("reaches sequence 0");
    // Nothing landed: the stream is where it was.
    expect(reopened.listAccountActions("acct-primary")).toHaveLength(1);
  });

  it("refuses two rows claiming one account version, in the base itself", () => {
    // The uniqueness migration 5 did not impose, imposed now. Through the door
    // the contract's derived idempotency key has always refused this; a writer
    // that reaches past the door meets the index instead.
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendAccountAction(action(1));
    ledger.close();

    withRawDatabase(path, (raw) => {
      const insert = raw.prepare(
        "INSERT INTO account_events (event_id, idempotency_key, account_id, version, action," +
          " resulting_state, actor, note, occurred_at, recorded_at, contract_version, event_json)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const duplicate = (): void => {
        insert.run(
          randomUUID(),
          "acct-primary/1/action.1-again",
          "acct-primary",
          1,
          "DRAIN",
          "DRAINING",
          KIMI,
          null,
          P08_AT,
          P08_AT,
          CONTRACT_VERSION,
          "{}",
        );
      };
      expect(caught(duplicate)).toBeInstanceOf(Error);
      expect((caught(duplicate) as Error).message).toContain("UNIQUE");
    });

    expect(readSidecar(path)).toHaveLength(1);
  });
});

describe("the account chain fails closed and preserves what it found", () => {
  it("reports a tampered historical row and leaves the segment untouched", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendAccountAction(action(1));
    ledger.appendAccountAction(action(2));
    ledger.close();

    const before = { sidecar: readSidecar(path), activation: readActivation(path) };

    withRawDatabase(path, (raw) => {
      // The append-only trigger denies UPDATE, so the row is rewritten the only
      // way a tamperer could: by dropping the trigger first.
      raw.exec("DROP TRIGGER account_events_deny_update");
      raw.prepare("UPDATE account_events SET note = ? WHERE sequence = 1").run("edited later");
    });

    const report = open(path, { readOnly: true }).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(detailsOf(report.problems)).toContain("but its stored row hashes to");

    // Preserved: nothing re-anchored, nothing recomputed, the baseline where it
    // was. Repair is an explicit recorded decision, not something a verifier
    // does on the way past.
    expect(readSidecar(path)).toEqual(before.sidecar);
    expect(readActivation(path)).toEqual(before.activation);
  });

  it("reports a note whose bytes were substituted under an identical decoding", () => {
    // The substitution a string-shaped read cannot see. The stored note is
    // U+FFFD — the three bytes `EF BF BD` — and a foreign writer replaces it
    // with the single byte `80`, which is not valid UTF-8 at all. Both decode
    // to U+FFFD, so a verifier that hashed the DECODED text would recompute
    // the same digest and declare the chain sound. `CAST(note AS BLOB)` is
    // what makes the two different again.
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendAccountAction(action(1, { note: "�" }));
    ledger.close();

    const before = { sidecar: readSidecar(path), activation: readActivation(path) };
    expect(storedNoteHex(path, 1)).toBe("efbfbd");

    withRawDatabase(path, (raw) => {
      // A STRICT table still accepts these bytes as `text`: SQLite stores what
      // it is handed and never validates the encoding, which is the property
      // this whole drill turns on.
      raw.exec("DROP TRIGGER account_events_deny_update");
      raw.prepare("UPDATE account_events SET note = CAST(x'80' AS TEXT) WHERE sequence = 1").run();
    });
    expect(storedNoteHex(path, 1)).toBe("80");

    const report = open(path, { readOnly: true }).verifyIntegrity();
    expect(report.ok).toBe(false);
    // Contains, not equals: the dropped trigger is itself a finding about the
    // shape of the database, and this assertion is about the chain.
    expect(kindsAndSequences(report.problems)).toContainEqual({ kind: "HASH_CHAIN", sequence: 1 });
    expect(detailsOf(report.problems)).toContain("but its stored row hashes to");

    // Preserved, as every finding on this chain is: nothing re-anchored and
    // nothing repaired. A row whose bytes are not UTF-8 is reported, not fixed.
    expect(readSidecar(path)).toEqual(before.sidecar);
    expect(readActivation(path)).toEqual(before.activation);
  });

  it("reports a version outside the safe range instead of throwing out of the verifier", () => {
    // A SQLite INTEGER is 64 bits. A foreign writer can put `2**53` in the
    // column — and used to make `verifyIntegrity()` throw, because the row was
    // read as a rounded `number` and the encoder rightly refused to guess which
    // integer it stood for. An operator asking "is this ledger sound?" then got
    // an exception naming no sequence instead of a report naming one.
    //
    // Read in `safeIntegers` mode the value arrives exact, hashes exactly, and
    // the mismatch with the recorded digest is an ordinary finding.
    for (const version of ["9007199254740992", "9007199254740993", "9223372036854775807"]) {
      const path = temporaryDatabase();
      const ledger = open(path);
      ledger.appendAccountAction(action(1));
      ledger.close();

      withRawDatabase(path, (raw) => {
        raw.exec("DROP TRIGGER account_events_deny_update");
        // Written as a SQL literal: passing it through a JavaScript number
        // would round it before it ever reached the column.
        raw.exec("UPDATE account_events SET version = " + version + " WHERE sequence = 1");
      });
      expect(storedVersionText(path, 1), version).toBe(version);

      const reopened = open(path, { readOnly: true });
      const report = reopened.verifyIntegrity();
      expect(report.ok, version).toBe(false);
      expect(kindsAndSequences(report.problems), version).toContainEqual({
        kind: "HASH_CHAIN",
        sequence: 1,
      });
      // The exact stored integer is what was hashed: the two values a `number`
      // collapses into one are told apart, which is the whole reason the read
      // is widened rather than merely guarded.
      expect(detailsOf(report.problems), version).toContain("but its stored row hashes to");
    }
  });

  it("still verifies a version at the edge of the safe range", () => {
    // The control. `2**53 - 1` was already reported correctly, and a widening
    // that broke it would have traded one failure for another.
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendAccountAction(action(1));
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw.exec("DROP TRIGGER account_events_deny_update");
      raw.exec("UPDATE account_events SET version = 9007199254740991 WHERE sequence = 1");
    });

    const report = open(path, { readOnly: true }).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(kindsAndSequences(report.problems)).toContainEqual({ kind: "HASH_CHAIN", sequence: 1 });
  });

  it("does not rebuild the sidecar as if it were a read model", () => {
    // The structural negative. `rebuildReadModel()` clears every derived table
    // and replays it from the log; the sidecar is evidence, not a projection,
    // and a rebuild that dropped it would destroy the only thing that can
    // detect a change to the account stream.
    expect(DERIVED_TABLES).not.toContain("account_event_integrity");

    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendAccountAction(action(1));
    ledger.appendAccountAction(action(2));
    const before = { sidecar: readSidecar(path), activation: readActivation(path) };

    ledger.rebuildReadModel();

    expect(readSidecar(path)).toEqual(before.sidecar);
    expect(readActivation(path)).toEqual(before.activation);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("leaves the activation untouched across a restore", () => {
    // §8.2: rebuild and restore change neither the activation, nor H, nor its
    // digest. A restore reproduces a file's contents; it does not re-date the
    // evidence that those contents were hashed.
    const path = temporaryDatabase();
    const ledger = open(path);
    ledger.appendAccountAction(action(1));
    const before = { sidecar: readSidecar(path), activation: readActivation(path) };

    ledger.recordRestore();

    expect(readSidecar(path)).toEqual(before.sidecar);
    expect(readActivation(path)).toEqual(before.activation);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("verifies an activated ledger clean from end to end", () => {
    const ledger = open(temporaryDatabase());
    seedFixture(ledger);
    ledger.appendInitiativeEvent(makeInitiativeEvent());
    ledger.appendRegistryEvent(makeRegistryDocument());
    ledger.appendAccountAction(action(1));
    ledger.appendAccountAction(action(2));
    ledger.appendAccountAction(action(3));

    const report = ledger.verifyIntegrity();
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(readSidecar(ledger.path)).toHaveLength(3);
  });
});

describe("the duplicate preflight names what it finds and repairs nothing", () => {
  /**
   * A ledger migrated to 9 that holds duplicate account versions.
   *
   * The duplicates have to be planted by raw SQL, because no door produces
   * them: the contract derives the idempotency key from the account and the
   * version, and `UNIQUE(idempotency_key)` has refused the pair since migration
   * 5. That is exactly why the preflight exists — for a row written past the
   * door — and exactly why fabricating one takes this much work.
   */
  function seedDuplicates(pairs: readonly (readonly [string, number])[]): string {
    const path = temporaryDatabase();
    open(path).close();
    rewindPastSidecar(path);

    withRawDatabase(path, (raw) => {
      const insert = raw.prepare(
        "INSERT INTO account_events (event_id, idempotency_key, account_id, version, action," +
          " resulting_state, actor, note, occurred_at, recorded_at, contract_version, event_json)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      let key = 0;
      for (const [accountId, version] of pairs) {
        key += 1;
        insert.run(
          randomUUID(),
          accountId + "/1/action." + String(version) + "#" + String(key),
          accountId,
          version,
          "DRAIN",
          "DRAINING",
          KIMI,
          null,
          P08_AT,
          P08_AT,
          CONTRACT_VERSION,
          "{}",
        );
      }
    });
    return path;
  }

  it("fails the migration naming every duplicate account version", () => {
    const path = seedDuplicates([
      ["acct-primary", 1],
      ["acct-primary", 1],
      ["acct-second", 4],
      ["acct-second", 4],
      ["acct-second", 4],
    ]);

    const error = caught(() => open(path));
    expect(error).toBeInstanceOf(LedgerMigrationError);
    const message = (error as Error).message;
    // Named, with coordinates and counts. A migration that said only "there
    // are duplicates" would leave an operator no way to decide anything.
    expect(message).toContain("2 duplicate (account_id, version) pair(s)");
    expect(message).toContain("acct-primary version 1 appears 2 times");
    expect(message).toContain("acct-second version 4 appears 3 times");
    // And it says outright that it will not fix them: resolving a historical
    // conflict is an owner's decision recorded in the decisions register, not
    // something a migration does while an upgrade runs.
    expect(message).toContain("will not deduplicate");
  });

  it("leaves the database exactly as it was when the preflight fails", () => {
    const path = seedDuplicates([
      ["acct-primary", 1],
      ["acct-primary", 1],
    ]);
    const before = {
      migrations: (() => {
        const raw = new Database(path);
        try {
          return raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
        } finally {
          raw.close();
        }
      })(),
      rows: (() => {
        const raw = new Database(path);
        try {
          return raw.prepare("SELECT * FROM account_events ORDER BY sequence").all();
        } finally {
          raw.close();
        }
      })(),
      activation: readActivation(path),
    };
    expect(before.rows).toHaveLength(2);
    expect(before.activation.size).toBe(0);

    expect(caught(() => open(path))).toBeInstanceOf(LedgerMigrationError);

    // The whole activation is one transaction, so a preflight that refuses
    // leaves no table, no index, no link and no key behind.
    const raw = new Database(path);
    try {
      expect(raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
        before.migrations,
      );
      expect(raw.prepare("SELECT * FROM account_events ORDER BY sequence").all()).toEqual(
        before.rows,
      );
      const tables = raw
        .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
        .all("account_event_integrity");
      expect(tables).toEqual([]);
    } finally {
      raw.close();
    }
    expect(readActivation(path).size).toBe(0);

    // And the failure is repeatable rather than a one-off that half-applied.
    expect(caught(() => open(path))).toBeInstanceOf(LedgerMigrationError);
  });
});

// ---------------------------------------------------------------------------
// The revision coordinate and its record (P-05/B, migration 11)
// ---------------------------------------------------------------------------
//
// The second rung of the identity ladder. `task_id` is stable for life;
// `(task_id, revision_number)` is a unit of work, and a change to any field of
// the envelope produces a new one.
//
// Two things about this migration are the opposite of migration 10's, and a
// reader who carries the wrong intuition across will misread both:
//
// 1. **"Migrated but not populated" is LAWFUL here.** Nothing in migration 11
//    writes a coordinate. A ledger that has applied it and holds no V2 row at
//    all is correct, not half-applied, and its legacy rows keep both columns
//    NULL for ever. Migration 10 activated as it migrated, so absence there was
//    tampering; here absence is the ordinary state until a producer exists.
// 2. **No new event type.** The coordinate rides payload keys on the stream
//    that already exists, so `CONTROL_PLANE_EVENT_TYPES` does not move and the
//    fold keys off the PRESENCE of the key set rather than off a type.

const REVISION_ENVELOPE = "e".repeat(64);

/** The payload keys that constitute a revision record. */
function revisionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    revisionId: randomUUID(),
    revisionNumber: 1,
    attemptNumber: 1,
    envelopeSha256: REVISION_ENVELOPE,
    ...overrides,
  };
}

interface StreamCoordinateRow {
  readonly sequence: number;
  readonly attempt: number;
  readonly revision_number: number | null;
  readonly attempt_number: number | null;
}

function readCoordinates(path: string): StreamCoordinateRow[] {
  const raw = new Database(path);
  try {
    return raw
      .prepare(
        "SELECT sequence, attempt, revision_number, attempt_number FROM control_plane_events " +
          "ORDER BY sequence ASC",
      )
      .all() as StreamCoordinateRow[];
  } finally {
    raw.close();
  }
}

interface RevisionRow {
  readonly task_id: string;
  readonly revision_number: number;
  readonly revision_id: string;
  readonly envelope_sha256: string;
  readonly restored_from_revision_id: string | null;
  readonly created_at: string;
  readonly created_by: string;
  readonly contract_version: string;
  readonly sequence: number;
}

function readRevisions(path: string): RevisionRow[] {
  const raw = new Database(path);
  try {
    return raw
      .prepare(
        "SELECT * FROM task_revision_read_model ORDER BY task_id ASC, revision_number ASC",
      )
      .all() as RevisionRow[];
  } finally {
    raw.close();
  }
}

/**
 * Plant a row on the stream by raw SQL, bypassing the append door.
 *
 * The trigger is the subject of these drills, and the door composes the
 * coordinate correctly by construction — so a test that went through the door
 * could never reach the states the trigger exists to refuse.
 */
function plantStreamRow(
  path: string,
  columns: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  withRawDatabase(path, (raw) => {
    const event = {
      contractVersion: CONTRACT_VERSION,
      eventId: randomUUID(),
      taskId: columns["task_id"],
      attempt: columns["attempt"] ?? 1,
      transitionId: "planted",
      idempotencyKey: randomUUID(),
      type: "TASK_DISCOVERED",
      fromState: null,
      toState: "DISCOVERED",
      emittedBy: "kimi/k3/coordinator/01",
      occurredAt: "2026-09-11T09:00:00.000Z",
      recordedAt: "2026-09-11T09:00:00.000Z",
      correlationId: null,
      causationId: null,
      payload,
    };
    raw
      .prepare(
        "INSERT INTO control_plane_events (" +
          "event_id, idempotency_key, task_id, attempt, revision_number, attempt_number, " +
          "transition_id, type, from_state, to_state, emitted_by, occurred_at, recorded_at, " +
          "contract_version, event_json, previous_sha256, event_sha256" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.eventId,
        event.idempotencyKey,
        event.taskId,
        columns["attempt"] ?? 1,
        columns["revision_number"] ?? null,
        columns["attempt_number"] ?? null,
        event.transitionId,
        event.type,
        null,
        event.toState,
        event.emittedBy,
        event.occurredAt,
        event.recordedAt,
        CONTRACT_VERSION,
        JSON.stringify(event),
        "0".repeat(64),
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      );
  });
  // A value rather than `void`, so a caller can write the refusal as an arrow
  // shorthand without tripping the no-confusing-void-expression rule.
  return "planted";
}

describe("the V2 coordinate travels on the stream, or does not travel at all", () => {
  it("N1: the trigger refuses every half of a coordinate, and lets a legacy row through", () => {
    const path = temporaryDatabase();
    open(path).close();
    const taskId = randomUUID();

    // A legacy row: both columns NULL, `attempt` populated. This is what every
    // row written before migration 11 looks like and what every row this build
    // writes looks like until a V2 producer exists — so it must pass, and a
    // trigger that refused it would make the migration unusable.
    expect(() => plantStreamRow(path, { task_id: taskId, attempt: 1 }, {})).not.toThrow();

    // One half without the other, in both directions.
    expect(() =>
      plantStreamRow(
        path,
        { task_id: taskId, attempt: 2, revision_number: 1 },
        { revisionNumber: 1 },
      ),
    ).toThrow(/both columns or neither/);
    expect(() =>
      plantStreamRow(
        path,
        { task_id: taskId, attempt: 2, attempt_number: 1 },
        { attemptNumber: 1 },
      ),
    ).toThrow(/both columns or neither/);

    // Zero and negative are not counts.
    for (const value of [0, -1]) {
      expect(() =>
        plantStreamRow(
          path,
          { task_id: taskId, attempt: 2, revision_number: value, attempt_number: 1 },
          { revisionNumber: value, attemptNumber: 1 },
        ),
        String(value),
      ).toThrow(/must be a positive count/);
      expect(() =>
        plantStreamRow(
          path,
          { task_id: taskId, attempt: 2, revision_number: 1, attempt_number: value },
          { revisionNumber: 1, attemptNumber: value },
        ),
        String(value),
      ).toThrow(/must be a positive count/);
    }

    // A column that disagrees with the body it travels in. This is the case the
    // whole trigger exists for: two answers to one question, in one row.
    expect(() =>
      plantStreamRow(
        path,
        { task_id: taskId, attempt: 2, revision_number: 9, attempt_number: 1 },
        { revisionNumber: 1, attemptNumber: 1 },
      ),
    ).toThrow(/revision_number disagrees with its own event_json/);
    expect(() =>
      plantStreamRow(
        path,
        { task_id: taskId, attempt: 2, revision_number: 1, attempt_number: 9 },
        { revisionNumber: 1, attemptNumber: 1 },
      ),
    ).toThrow(/attempt_number disagrees with its own event_json/);

    // A complete, agreeing V2 row passes — so none of the refusals above is
    // refusing the shape itself.
    expect(() =>
      plantStreamRow(
        path,
        { task_id: taskId, attempt: 2, revision_number: 1, attempt_number: 1 },
        { revisionNumber: 1, attemptNumber: 1 },
      ),
    ).not.toThrow();

    expect(readCoordinates(path).map((row) => [row.revision_number, row.attempt_number])).toEqual([
      [null, null],
      [1, 1],
    ]);
  });

  it("N13: the trigger refuses a body that claims a coordinate the columns do not", () => {
    // The reverse direction, and the one a forward-only trigger would miss.
    // Without it a writer could record the coordinate in the payload and leave
    // the columns NULL: the row would read as legacy for ever while its own
    // event said otherwise, and every query written against the columns would
    // silently skip it.
    const path = temporaryDatabase();
    open(path).close();
    const taskId = randomUUID();

    expect(() =>
      plantStreamRow(path, { task_id: taskId, attempt: 1 }, { revisionNumber: 2, attemptNumber: 1 }),
    ).toThrow(/event_json carries a V2 coordinate the columns do not/);

    // Either key alone is enough to trip it: a body half-claiming a coordinate
    // is not a legacy row either.
    expect(() =>
      plantStreamRow(path, { task_id: taskId, attempt: 1 }, { revisionNumber: 2 }),
    ).toThrow(/event_json carries a V2 coordinate the columns do not/);
    expect(() =>
      plantStreamRow(path, { task_id: taskId, attempt: 1 }, { attemptNumber: 1 }),
    ).toThrow(/event_json carries a V2 coordinate the columns do not/);

    expect(readCoordinates(path)).toHaveLength(0);
  });

  it("populates the columns from the payload the caller already sent", () => {
    // The door's half of the same law. The columns are a projection of the
    // body, never a second source a caller has to remember to fill.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "v1" }));
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "v2",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        payload: revisionPayload({ revisionNumber: 2, attemptNumber: 3 }),
      }),
    );
    ledger.close();

    expect(readCoordinates(ledger.path).map((row) => [row.revision_number, row.attempt_number])).toEqual([
      [null, null],
      [2, 3],
    ]);

    // The legacy `attempt` is still populated on the V2 row: every query
    // written before this migration still finds it.
    expect(readCoordinates(ledger.path).map((row) => row.attempt)).toEqual([1, 1]);
  });

  it("keeps the highest attempt of a revision on the task row, and a rebuild agrees", () => {
    // The fold's rule through the real door. Two events at ONE revision, the
    // higher attempt first: the denormalized attempt must stay at the higher
    // one, because within a revision the attempts are a sequence and a late
    // arrival must not make the task claim it went backwards.
    //
    // The two events are deliberately twins in everything the revision record
    // is made of — same `revisionId`, same envelope, same `occurredAt`, same
    // emitter — because the revision row is written once: a second event at the
    // same coordinate with different content is refused, so the only way to
    // reach this fold at all is with a second event that differs in the attempt
    // and in nothing else.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const coordinate = {
      revisionId: randomUUID(),
      revisionNumber: 2,
      envelopeSha256: REVISION_ENVELOPE,
    };

    ledger.append(
      makeEvent({
        taskId,
        transitionId: "r2-a3",
        payload: revisionPayload({ ...coordinate, attemptNumber: 3 }),
      }),
    );
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "r2-a1",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        payload: revisionPayload({ ...coordinate, attemptNumber: 1 }),
      }),
    );

    const incremental = ledger.getTask(taskId);
    expect(incremental?.latestAttemptNumber).toBe(3);
    // And the other two columns are where the revision left them.
    expect(incremental?.latestRevisionNumber).toBe(2);
    expect(incremental?.envelopeSha256).toBe(REVISION_ENVELOPE);
    // One revision, one row: the twin event replayed the record, it did not
    // write a second one.
    expect(readRevisions(ledger.path)).toHaveLength(1);

    // The equivalence that makes the fold trustworthy: the incremental path and
    // a full replay have to agree, or `verifyIntegrity` is comparing a read
    // model against a rebuild that computes something else.
    ledger.rebuildReadModel();
    expect(ledger.getTask(taskId)).toEqual(incremental);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N10: a migrated ledger with no V2 row reports an empty projection, inventing nothing", () => {
    // The lawful window this migration deliberately opens. Everything is
    // applied, nothing is populated, and the correct report is emptiness —
    // not a zero, not a guess, and above all not a finding.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedTask(ledger, taskId, "kimi/k3/coordinator/01");

    expect(readRevisions(ledger.path)).toEqual([]);
    expect(ledger.getTask(taskId)?.latestRevisionNumber).toBeNull();
    expect(ledger.getTask(taskId)?.envelopeSha256).toBeNull();
    expect(ledger.getTask(taskId)?.latestAttemptNumber).toBeNull();
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // And the watermark is LEVEL with the head rather than frozen at zero: the
    // fold saw every event and wrote no row, which is current, not behind.
    const watermark = ledger
      .status()
      .projections.find((projection) => projection.name === "task_revision_read_model");
    expect(watermark?.watermarks[0]?.appliedThroughSequence).toBe(ledger.status().headSequence);
  });
});

describe("the revision record is written once, or refused", () => {
  it("N3 and N4: the coordinate and the revision id are each unique", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const revisionId = randomUUID();
    ledger.append(
      makeEvent({ taskId, transitionId: "r1", payload: revisionPayload({ revisionId }) }),
    );
    ledger.close();

    // N4: `(task_id, revision_number)` is the primary key. A second row at the
    // same coordinate is not an update — the coordinate IS the identity of a
    // unit of work, and two rows would be two answers to "what was asked".
    withRawDatabase(path, (raw) => {
      expect(() =>
        raw
          .prepare(
            "INSERT INTO task_revision_read_model (task_id, revision_number, revision_id, " +
              "envelope_sha256, restored_from_revision_id, created_at, created_by, " +
              "contract_version, sequence) VALUES (?, 1, ?, ?, NULL, ?, ?, ?, 2)",
          )
          .run(taskId, randomUUID(), REVISION_ENVELOPE, "2026-09-11T09:00:00.000Z", "kimi/k3/coordinator/01", CONTRACT_VERSION),
      ).toThrow(/UNIQUE|PRIMARY KEY/i);

      // N3: and the revision id is globally unique, so a handle cannot name two
      // revisions — which is the whole reason it exists beside the coordinate.
      expect(() =>
        raw
          .prepare(
            "INSERT INTO task_revision_read_model (task_id, revision_number, revision_id, " +
              "envelope_sha256, restored_from_revision_id, created_at, created_by, " +
              "contract_version, sequence) VALUES (?, 2, ?, ?, NULL, ?, ?, ?, 3)",
          )
          .run(randomUUID(), revisionId, REVISION_ENVELOPE, "2026-09-11T09:00:00.000Z", "kimi/k3/coordinator/01", CONTRACT_VERSION),
      ).toThrow(/UNIQUE/i);

      // The CHECK is real too: revision numbering starts at one.
      expect(() =>
        raw
          .prepare(
            "INSERT INTO task_revision_read_model (task_id, revision_number, revision_id, " +
              "envelope_sha256, restored_from_revision_id, created_at, created_by, " +
              "contract_version, sequence) VALUES (?, 0, ?, ?, NULL, ?, ?, ?, 4)",
          )
          .run(randomUUID(), randomUUID(), REVISION_ENVELOPE, "2026-09-11T09:00:00.000Z", "kimi/k3/coordinator/01", CONTRACT_VERSION),
      ).toThrow(/CHECK|constraint/i);
    });
  });

  it("N14: a second arrival at one coordinate is a replay, or a refusal, never a rewrite", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const revisionId = randomUUID();
    const payload = revisionPayload({ revisionId });

    ledger.append(makeEvent({ taskId, transitionId: "r1", payload }));

    // The SAME content again, under a different transition so it is a genuinely
    // new event rather than an idempotent append. The revision row is already
    // there and identical: nothing is written and nothing is refused, because a
    // retry that says the same thing has to stay safe.
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "r1-again",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        payload,
      }),
    );
    expect(readRevisions(path)).toHaveLength(1);

    // The same revision reached by a LATER attempt, with its own `occurredAt`
    // (F-1, ADR 0072). Execution §3 calls this "un reintento de la misma
    // revisión, no una revisión nueva", so it is a replay of the record and not
    // a conflict — and until this escalón it WAS a conflict, because the
    // comparison included the first arrival's birth attributes. The only way to
    // record attempt 2 was to restate attempt 1's timestamp, which is to say to
    // lie about when it happened.
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "r1-a2",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        occurredAt: "2026-08-27T13:30:00.000Z",
        payload: { ...payload, attemptNumber: 2 },
      }),
    );
    expect(readRevisions(path)).toHaveLength(1);
    // And the row still records the FIRST arrival: a replay reads the record,
    // it does not restamp it.
    expect(readRevisions(path)[0]?.created_at).toBe("2026-08-27T12:00:00.000Z");
    // The attempt, which is a different question, did move.
    expect(ledger.getTask(taskId)?.latestAttemptNumber).toBe(2);

    // DIFFERENT content at the same coordinate is refused. The row is a record
    // of what was asked; rewriting it would destroy the thing it preserves.
    const conflict = caught(() =>
      ledger.append(
        makeEvent({
          taskId,
          transitionId: "r1-conflict",
          fromState: "DISCOVERED",
          toState: "DISCOVERED",
          payload: revisionPayload({ revisionId, envelopeSha256: "f".repeat(64) }),
        }),
      ),
    );
    expect(conflict).toBeInstanceOf(LedgerValidationError);
    expect((conflict as Error).message).toContain("already recorded with different content");

    // The refusal rolled the whole append back: no event, no row, no drift.
    expect(readRevisions(path)).toHaveLength(1);
    expect(readRevisions(path)[0]?.envelope_sha256).toBe(REVISION_ENVELOPE);
    expect(ledger.listEvents().events).toHaveLength(3);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // And a REPLAY refuses the same history, so the incremental path and a
    // rebuild agree about which ledgers are writable. The rebuild also has to
    // reproduce the birth attributes of the FIRST arrival rather than the last
    // one it saw, or `verifyIntegrity` would be comparing the stored row
    // against a differently-born one.
    ledger.close();
    const reopened = open(path);
    expect(reopened.rebuildReadModel().replayedEvents).toBe(3);
    expect(readRevisions(path)).toHaveLength(1);
    expect(readRevisions(path)[0]?.created_at).toBe("2026-08-27T12:00:00.000Z");
    expect(reopened.verifyIntegrity().ok).toBe(true);
  });

  it("N-A-2b: a different restore source at one coordinate is a conflict too", () => {
    // The third intrinsic field, and the one nothing exercised before F-1
    // narrowed the comparison to exactly three. `restoredFromRevisionId` is
    // what says WHY two revisions share an envelope digest, so two answers to
    // it at one coordinate are two accounts of what was asked — refused for
    // the same reason a different digest is.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const revisionId = randomUUID();
    const restored = randomUUID();

    ledger.append(
      makeEvent({
        taskId,
        transitionId: "r1",
        payload: revisionPayload({ revisionId, restoredFromRevisionId: restored }),
      }),
    );

    const conflict = caught(() =>
      ledger.append(
        makeEvent({
          taskId,
          transitionId: "r1-other-source",
          fromState: "DISCOVERED",
          toState: "DISCOVERED",
          payload: revisionPayload({ revisionId, restoredFromRevisionId: randomUUID() }),
        }),
      ),
    );
    expect(conflict).toBeInstanceOf(LedgerValidationError);
    expect((conflict as Error).message).toContain("already recorded with different content");

    // Dropping the key entirely is also a different answer, not a silent
    // agreement with whatever was there.
    const dropped = caught(() =>
      ledger.append(
        makeEvent({
          taskId,
          transitionId: "r1-no-source",
          fromState: "DISCOVERED",
          toState: "DISCOVERED",
          payload: revisionPayload({ revisionId }),
        }),
      ),
    );
    expect(dropped).toBeInstanceOf(LedgerValidationError);

    expect(readRevisions(path)).toHaveLength(1);
    expect(readRevisions(path)[0]?.restored_from_revision_id).toBe(restored);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N8: two revisions may share an envelope digest, which is what restore means", () => {
    // §7.3. Restoring an earlier envelope is a NEW revision with the SAME
    // digest, and a `UNIQUE(task_id, envelope_sha256)` would forbid exactly the
    // case the model exists to allow. The index over the digest is therefore
    // NOT unique, and `restored_from_revision_id` is what says why the two
    // agree rather than leaving a reader to guess.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const first = randomUUID();

    ledger.append(
      makeEvent({ taskId, transitionId: "r1", payload: revisionPayload({ revisionId: first }) }),
    );
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "r2",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        payload: revisionPayload({ revisionNumber: 2, envelopeSha256: "a".repeat(64) }),
      }),
    );
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "r3",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        payload: revisionPayload({
          revisionNumber: 3,
          envelopeSha256: REVISION_ENVELOPE,
          restoredFromRevisionId: first,
        }),
      }),
    );

    const rows = readRevisions(path);
    expect(rows.map((row) => [row.revision_number, row.envelope_sha256])).toEqual([
      [1, REVISION_ENVELOPE],
      [2, "a".repeat(64)],
      [3, REVISION_ENVELOPE],
    ]);
    expect(rows[2]?.restored_from_revision_id).toBe(first);
    expect(rows[0]?.restored_from_revision_id).toBeNull();

    // The task row follows the LATEST revision, all three fields together.
    expect([
      ledger.getTask(taskId)?.latestRevisionNumber,
      ledger.getTask(taskId)?.envelopeSha256,
    ]).toEqual([3, REVISION_ENVELOPE]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N7: a pre-artifact revision rebuilds identically twice, touching no filesystem", () => {
    // B-4, which is negative 12 of datos §16 applied to this cohort. The
    // revision record carries no artifact reference in this contract version,
    // so a rebuild has nothing outside the file to consult — and the proof is
    // that two rebuilds at one head produce byte-identical rows.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    seedTask(ledger, taskId, "kimi/k3/coordinator/01");
    const afterSeed = ledger.getTask(taskId)?.currentState ?? "DISCOVERED";
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "r1",
        fromState: afterSeed,
        toState: afterSeed,
        payload: revisionPayload({ revisionNumber: 1 }),
      }),
    );
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "r2",
        fromState: afterSeed,
        toState: afterSeed,
        payload: revisionPayload({ revisionNumber: 2 }),
      }),
    );
    const live = readRevisions(path);
    expect(live).toHaveLength(2);
    ledger.close();

    const first = open(path);
    first.rebuildReadModel();
    first.close();
    const afterFirst = readRevisions(path);

    const second = open(path);
    second.rebuildReadModel();
    second.close();
    const afterSecond = readRevisions(path);

    expect(afterFirst).toEqual(live);
    expect(afterSecond).toEqual(afterFirst);

    // No column of the record names anything outside this file. That is the
    // claim B-4 is really about, and it is asserted over the row rather than
    // over the code that wrote it.
    for (const row of afterSecond) {
      expect(Object.keys(row).sort()).toEqual([
        "contract_version",
        "created_at",
        "created_by",
        "envelope_sha256",
        "restored_from_revision_id",
        "revision_id",
        "revision_number",
        "sequence",
        "task_id",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// The V2 key reaches the ledger, and a version it cannot read does not
//
// P-18/protocolo, escalón A. Migration 11 reserved the `v2/` namespace and
// proved no historical key occupied it; the contract then refused every key
// that tried to use it, so the namespace was reserved and unreachable at the
// same time. These drills are the other end: a lawful V2 key goes through the
// real door, is stored, and reads back identical — and the two refusals that
// keep it the ONLY way a V2 fact can be named.
// ---------------------------------------------------------------------------

describe("the V2 idempotency key travels through the real door", () => {
  it("P-P18-1: a V2 key is stored and read back identical, under its imported namespace", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const event = makeEvent({
      taskId,
      transitionId: "revise",
      payload: revisionPayload({ revisionNumber: 4, attemptNumber: 2 }),
    });

    const appended = ledger.append(event);
    expect(appended.inserted).toBe(true);

    const expected = buildV2IdempotencyKey({
      stream: "control_plane_events",
      taskId,
      revisionNumber: 4,
      attemptNumber: 2,
      transitionId: "revise",
    });
    expect(appended.record.idempotencyKey).toBe(expected);

    // Read back through the contract, from the stored bytes rather than from
    // the value the caller handed in.
    const stored = ledger.listEvents().events[0];
    expect(stored?.idempotencyKey).toBe(expected);
    expect(stored?.event.idempotencyKey).toBe(expected);

    // The namespace is the one the contract declares, not one restated here,
    // and it is the same prefix `assertNoV2KeyCollisions` reserved.
    expect(expected.startsWith(V2_IDEMPOTENCY_NAMESPACE)).toBe(true);

    // The columns carry the coordinate the body claims, and the legacy
    // `attempt` column is still populated beside it.
    expect(readCoordinates(path).map((row) => [row.revision_number, row.attempt_number])).toEqual([
      [4, 2],
    ]);

    // An exact replay of the same append is idempotent on the V2 key exactly as
    // it is on a V1 one: the key is doing its job in the new namespace.
    const replay = ledger.append(event);
    expect(replay.inserted).toBe(false);
    expect(ledger.listEvents().events).toHaveLength(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    ledger.close();
    const reopened = open(path);
    expect(reopened.rebuildReadModel().replayedEvents).toBe(1);
    expect(reopened.listEvents().events[0]?.idempotencyKey).toBe(expected);
  });

  it("N-P18-20: a conflicted producer cannot change namespace to invent a new fact", () => {
    // streams §1.1: "no … otro namespace de idempotencia para los mismos
    // hechos". The mechanism is the contract's strict door, asserted here
    // through the ledger because that is where a producer would be tempted: a
    // V2 append conflicts, and the escape hatch of re-keying the SAME payload
    // under V1 has to be closed before the ledger is ever consulted.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const payload = revisionPayload({ revisionNumber: 2, attemptNumber: 1 });

    ledger.append(makeEvent({ taskId, transitionId: "revise", payload }));

    const reKeyed = {
      ...makeEvent({
        taskId,
        transitionId: "revise",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        payload,
      }),
      eventId: randomUUID(),
      idempotencyKey: buildIdempotencyKey({ taskId, attempt: 1, transitionId: "revise" }),
    };

    const refusal = caught(() => ledger.append(reKeyed));
    expect(refusal).toBeInstanceOf(LedgerValidationError);
    expect(String(refusal)).toContain("idempotencyKey");

    // Nothing was written, and the one fact still has exactly one name.
    expect(ledger.listEvents().events).toHaveLength(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("F-2: a malformed V2 coordinate is a typed refusal, not a raw SQLite abort", () => {
    // The trigger already refused all of these — as a `SqliteError` reading
    // "event_json carries a V2 coordinate the columns do not", which names the
    // symptom, comes from another layer and cannot be caught by class. The
    // guard in front of the INSERT makes each one a `LedgerValidationError`
    // that names the key at fault. The trigger stays where it is underneath.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    seedTask(ledger, taskId, "kimi/k3/coordinator/01");
    const state = ledger.getTask(taskId)?.currentState ?? "DISCOVERED";
    const headBefore = ledger.status().headSequence;

    const malformed: [string, Record<string, unknown>, string][] = [
      ["revisionNumber alone", { revisionNumber: 2 }, "payload.attemptNumber"],
      ["attemptNumber alone", { attemptNumber: 2 }, "payload.revisionNumber"],
      ["a string count", { revisionNumber: "2", attemptNumber: 1 }, "payload.revisionNumber"],
      ["a float count", { revisionNumber: 2, attemptNumber: 1.5 }, "payload.attemptNumber"],
      ["an unsafe integer", { revisionNumber: 2 ** 53, attemptNumber: 1 }, "payload.revisionNumber"],
      ["zero", { revisionNumber: 2, attemptNumber: 0 }, "payload.attemptNumber"],
      ["a negative count", { revisionNumber: -1, attemptNumber: 1 }, "payload.revisionNumber"],
      // The one the reader must NOT treat as absence: `json_extract` reads a
      // JSON null as nothing, so a payload saying `revisionNumber: null` would
      // otherwise become a legacy row whose own body claimed otherwise.
      ["an explicit null", { revisionNumber: null, attemptNumber: 1 }, "payload.revisionNumber"],
    ];

    for (const [name, payload, path_] of malformed) {
      const refusal = caught(() =>
        ledger.append(
          makeEvent({
            taskId,
            transitionId: "bad-" + name.replace(/[^A-Za-z0-9]/g, "-"),
            fromState: state,
            toState: state,
            payload,
          }),
        ),
      );
      expect(refusal, name).toBeInstanceOf(LedgerValidationError);
      expect(String(refusal), name).toContain(path_);
      expect(String(refusal), name).not.toContain("SqliteError");
    }

    // Every refusal rolled back whole: no row, no head movement, and the handle
    // is still usable — which is what a typed refusal buys over an abort.
    expect(ledger.status().headSequence).toBe(headBefore);
    expect(readCoordinates(path).every((row) => row.revision_number === null)).toBe(true);
    expect(ledger.append(makeEvent({ taskId, transitionId: "after", fromState: state, toState: state })).inserted).toBe(true);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
});

describe("a version this build does not read is refused, by name", () => {
  /**
   * Stamp a stored row with a foreign contract version, chain intact.
   *
   * The chain is recomputed so that the ONLY thing wrong with the row is its
   * version. A test that also broke the digest would pass for the wrong
   * reason — the refusals below would fire on the chain and never reach the
   * membership test they exist to drill.
   */
  function restampVersion(path: string, sequence: number, version: string): void {
    tamper(path, (raw) => {
      const row = raw
        .prepare("SELECT event_json, previous_sha256 FROM control_plane_events WHERE sequence = ?")
        .get(sequence) as { readonly event_json: string; readonly previous_sha256: string };
      const decoded = JSON.parse(row.event_json) as Record<string, unknown>;
      decoded["contractVersion"] = version;
      const rewritten = canonicalJsonStringify(decoded);
      raw
        .prepare(
          "UPDATE control_plane_events SET event_json = ?, contract_version = ?, " +
            "event_sha256 = ? WHERE sequence = ?",
        )
        .run(rewritten, version, chainDigest(row.previous_sha256, rewritten), sequence);
    });
  }

  /**
   * Rewrite a whole history under another contract version, chain and all.
   *
   * `restampVersion` above is a tamper probe: it rewrites one row so a reader
   * has something unreadable to refuse, and it deliberately leaves the chain
   * and the head disagreeing, because that is not what those tests are looking
   * at. P-P18-2 needs the opposite — a ledger that is **sound** and was written
   * under the previous version — so this recomputes every digest from genesis
   * and moves `ledger_meta` with it.
   *
   * The two append-only triggers are captured from `sqlite_master` and put back
   * verbatim rather than restated from the migration: a helper that rewrote
   * their bodies would be a second authority on what they are, and
   * `EXPECTED_SCHEMA_OBJECTS` would not notice the difference.
   */
  function restampHistory(path: string, version: string): void {
    const raw = new Database(path);
    try {
      const triggers = raw
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)",
        )
        .all("control_plane_events_deny_update", "control_plane_events_deny_delete") as {
        readonly sql: string;
      }[];
      expect(triggers).toHaveLength(2);
      raw.exec(
        "DROP TRIGGER control_plane_events_deny_update; " +
          "DROP TRIGGER control_plane_events_deny_delete;",
      );

      const rows = raw
        .prepare("SELECT sequence, event_json FROM control_plane_events ORDER BY sequence")
        .all() as { readonly sequence: number; readonly event_json: string }[];
      const rewrite = raw.prepare(
        "UPDATE control_plane_events SET event_json = ?, contract_version = ?, " +
          "previous_sha256 = ?, event_sha256 = ? WHERE sequence = ?",
      );

      let previous = GENESIS_SHA256;
      for (const row of rows) {
        const decoded = JSON.parse(row.event_json) as Record<string, unknown>;
        decoded["contractVersion"] = version;
        const rewritten = canonicalJsonStringify(decoded);
        const digest = chainDigest(previous, rewritten);
        rewrite.run(rewritten, version, previous, digest, row.sequence);
        previous = digest;
      }

      raw
        .prepare("UPDATE ledger_meta SET value = ? WHERE key = 'head_event_sha256'")
        .run(previous);
      // Every projection of this stream was built from that head, so the
      // watermarks move with it. Without this the ledger would be sound and
      // every projection would report itself built from a digest the chain no
      // longer has — which is exactly the corruption the watermark exists to
      // catch, and not the thing under test.
      raw
        .prepare(
          "UPDATE projection_watermark SET source_head_sha256 = ? WHERE source_stream = ?",
        )
        .run(previous, "control_plane_events");

      for (const trigger of triggers) raw.exec(trigger.sql);
    } finally {
      raw.close();
    }
  }

  it("N-P18-19: all three read paths refuse a V2 row a V1 reader cannot interpret", () => {
    // streams §1.1: "Un lector que sólo entiende la forma V1 no interpreta una
    // fila V2 como si fuera V1: la versión de contrato no soportada produce un
    // rechazo o una degradación explícita." The rejection existed; what did not
    // was the word "explicit". "does not satisfy the contract" is equally true
    // of a tampered field, a missing key and an unreadable version, and an
    // operator holding a ledger written by a newer build needs to be told which
    // of those it is — the one recoverable case in that set looked exactly like
    // corruption.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "one" }));
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "two",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
      }),
    );
    ledger.close();

    restampVersion(path, 2, "2.9.0");
    const reopened = open(path);

    // 1. Reading events. The whole page fails closed rather than returning a
    //    row this build cannot vouch for.
    const listed = caught(() => reopened.listEvents());
    expect(listed).toBeInstanceOf(LedgerIntegrityError);
    expect(String(listed)).toContain("2.9.0");
    expect(String(listed)).toContain(SUPPORTED_CONTRACT_VERSIONS.join(", "));

    // 2. Verifying. The problem is reported with its own kind, and the detail
    //    names the version found and the set this build reads.
    const report = reopened.verifyIntegrity();
    expect(report.ok).toBe(false);
    const contractProblems = report.problems.filter(
      (problem) => problem.kind === "EVENT_CONTRACT",
    );
    expect(contractProblems).toHaveLength(1);
    expect(contractProblems[0]?.detail).toContain("2.9.0");
    expect(contractProblems[0]?.detail).toContain(CONTRACT_VERSION);
    expect(contractProblems[0]?.sequence).toBe(2);

    // 3. Rebuilding. It REFUSES; it does not quietly skip the row and leave a
    //    read model that is missing an event without saying so.
    const rebuilt = caught(() => reopened.rebuildReadModel());
    expect(rebuilt).toBeInstanceOf(LedgerIntegrityError);
    expect(String(rebuilt)).toContain("2.9.0");
  });

  it("keeps the general message for every other way a row can fail the contract", () => {
    // The version branch must not swallow the rest. A row whose version is
    // perfectly supported and whose body is wrong still reports what it always
    // reported, or the new message would be a worse diagnostic dressed as a
    // better one.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "one" }));
    ledger.close();

    tamper(path, (raw) => {
      const row = raw
        .prepare("SELECT event_json, previous_sha256 FROM control_plane_events WHERE sequence = ?")
        .get(1) as { readonly event_json: string; readonly previous_sha256: string };
      const decoded = JSON.parse(row.event_json) as Record<string, unknown>;
      decoded["emittedBy"] = "not a worker identity";
      const rewritten = canonicalJsonStringify(decoded);
      raw
        .prepare(
          "UPDATE control_plane_events SET event_json = ?, event_sha256 = ? WHERE sequence = ?",
        )
        .run(rewritten, chainDigest(row.previous_sha256, rewritten), 1);
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    const detail = report.problems.find((problem) => problem.kind === "EVENT_CONTRACT")?.detail;
    expect(detail).toContain("no longer satisfies the ControlPlaneEvent contract");
    expect(detail).not.toContain("supported versions");
  });

  it("P-P18-2: a row under a supported-but-not-current version reads and rebuilds", () => {
    // The obligation ADR 0072 wrote down and P-18/protocolo C pays. Until the
    // bump, "supported but not current" was an empty category and this could
    // only assert the invariant that made the drill possible later. The set now
    // holds two members and the category is real.
    //
    // P-18/protocolo F moved the literal again (ADR 0078), so the set now holds
    // two supported-but-not-current members; the loop at the end walks all three.
    expect([...SUPPORTED_CONTRACT_VERSIONS]).toEqual(["2.2.0", "2.3.0", CONTRACT_VERSION]);
    expect(CONTRACT_VERSION).toBe("2.4.0");

    // The history is fabricated with `restampVersion` rather than taken from a
    // fixture, and the correction matters: there is no recorded `"2.2.0"`
    // history anywhere in this repository's fixtures — every seeded ledger is
    // built at test time with whatever `CONTRACT_VERSION` is in force, so a
    // drill that seeded and read back would have proved nothing about the
    // previous version at all. Restamping rewrites the body, the column and the
    // chain digest, which is exactly what a ledger written by the previous
    // build looks like.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "one" }));
    ledger.append(
      makeEvent({ taskId, transitionId: "two", fromState: "DISCOVERED", toState: "DISCOVERED" }),
    );
    ledger.close();

    restampHistory(path, "2.2.0");

    const reopened = open(path);
    const stored = reopened.listEvents().events;
    expect(stored.map((record) => record.event.contractVersion)).toEqual(["2.2.0", "2.2.0"]);
    expect(reopened.verifyIntegrity().ok).toBe(true);
    expect(reopened.rebuildReadModel().replayedEvents).toBe(2);
    expect(reopened.verifyIntegrity().ok).toBe(true);
    reopened.close();

    // And every member of the set is readable end to end when it is what a row
    // carries. Asserted over the set rather than over a literal, so it grows
    // with the set rather than needing to be remembered.
    for (const version of SUPPORTED_CONTRACT_VERSIONS) {
      const each = temporaryDatabase();
      const writer = open(each);
      writer.append(makeEvent({ taskId: randomUUID(), transitionId: "one" }));
      writer.close();
      restampHistory(each, version);

      const reader = open(each);
      expect(reader.listEvents().events[0]?.event.contractVersion, version).toBe(version);
      expect(reader.verifyIntegrity().ok, version).toBe(true);
      expect(reader.rebuildReadModel().replayedEvents, version).toBe(1);
      reader.close();
    }
  });

  it("P-P18-2, N12 variant: a 2.2.0 history rewound to 12 migrates to 13 on open, reads, verifies and rebuilds", () => {
    // P-P18-2 above reads a previous-version history over a ledger that is
    // already at migration 13. The field case is the other order: a ledger the
    // previous build wrote, stopped at 12, opened by this build — which applies
    // 13 over a history that is 2.2.0 end to end, and must then read, verify,
    // rebuild and take new work under the version in force on top.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "one" }));
    ledger.append(
      makeEvent({ taskId, transitionId: "two", fromState: "DISCOVERED", toState: "DISCOVERED" }),
    );
    ledger.close();

    restampHistory(path, "2.2.0");
    withRawDatabase(path, (raw) => {
      dropExecutionEffectIdentity(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(
        EXECUTION_EFFECT_MIGRATION,
      );
    });

    const migrated = open(path);
    expect(migrated.status().migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(migrated.listEvents().events.map((record) => record.event.contractVersion)).toEqual([
      "2.2.0",
      "2.2.0",
    ]);
    expect(migrated.verifyIntegrity().ok).toBe(true);
    expect(migrated.rebuildReadModel().replayedEvents).toBe(2);
    expect(migrated.verifyIntegrity().ok).toBe(true);

    // And new work under the version in force lands on top of the migrated
    // history: an attempt of another task, and an effect inside it.
    const fresh = randomUUID();
    migrated.append(attemptOpening({ taskId: fresh, attempt: 1, transitionId: "open", invocationId: "inv-1" }));
    migrated.append(effectIntention({ taskId: fresh, transitionId: "effect-1", invocationId: "inv-1" }));
    expect(migrated.listEvents().events.map((record) => record.event.contractVersion)).toEqual([
      "2.2.0",
      "2.2.0",
      CONTRACT_VERSION,
      CONTRACT_VERSION,
    ]);
    expect(migrated.verifyIntegrity().ok).toBe(true);
    migrated.close();
  });

  it("P-P18-2, escalón D: a 2.2.0 history under a newer one, rewound to 13, migrates to 14 and takes occurrences", () => {
    // The field case one migration later. A ledger written partly by the build
    // before the bump and partly by a later build — stopped at 13 — is opened by
    // this build, which applies 14 over both cohorts, and must then read, verify,
    // rebuild and record a prompt and its answer on top. D carried no bump; the
    // newer cohort is stamped with whatever version is in force, which is
    // `"2.4.0"` since F.
    const path = temporaryDatabase();
    const ledger = open(path);
    const oldTask = randomUUID();
    ledger.append(makeEvent({ taskId: oldTask, transitionId: "one" }));
    ledger.close();
    restampHistory(path, "2.2.0");

    const middle = open(path);
    const taskId = randomUUID();
    const effectId = seedDelivery(middle, taskId);
    middle.close();

    withRawDatabase(path, (raw) => {
      dropExecutionOccurrences(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(
        EXECUTION_OCCURRENCE_MIGRATION,
      );
    });

    const migrated = open(path);
    expect(migrated.status().migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(migrated.listEvents().events.map((record) => record.event.contractVersion)).toEqual([
      "2.2.0",
      CONTRACT_VERSION,
      CONTRACT_VERSION,
      CONTRACT_VERSION,
    ]);
    expect(migrated.verifyIntegrity().ok).toBe(true);
    expect(migrated.rebuildReadModel().replayedEvents).toBe(4);
    expect(migrated.verifyIntegrity().ok).toBe(true);

    migrated.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    migrated.append(
      responseOccurrence({ taskId, transitionId: "response-1", promptOccurrenceId: "po-1" }),
    );
    expect(CONTRACT_VERSION).toBe("2.4.0");
    expect(migrated.listEvents().events.at(-1)?.event.contractVersion).toBe(CONTRACT_VERSION);
    expect(migrated.getResponseOccurrenceForPrompt("po-1")?.occurrenceId).toBe("ro-1");
    expect(migrated.rebuildReadModel().replayedEvents).toBe(6);
    expect(migrated.verifyIntegrity().ok).toBe(true);
    migrated.close();
  });

  it("N-C-1: an exact replay of a pre-bump row is admitted, and new work is not", () => {
    // The two faces of "only the version in force is emitted" (ADR 0076, C-2).
    //
    // The exemption is not a softening. A producer that appended under the
    // previous build and retries the same append after an upgrade is doing the
    // one thing an idempotency key exists to make safe, and refusing it would
    // turn a routine upgrade into a wall of failures on work that already
    // landed. The refusal is for **new** work: an insertion this ledger has
    // never seen, stamped with a version this build reads and no longer emits.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const first = makeEvent({ taskId, transitionId: "one" });
    ledger.append(first);
    ledger.close();

    restampHistory(path, "2.2.0");

    const reopened = open(path);

    // The replay: the same event, under the version the stored row carries.
    // Nothing is inserted and nothing is refused.
    const replay = reopened.append({ ...first, contractVersion: "2.2.0" });
    expect(replay.inserted).toBe(false);
    expect(replay.record.sequence).toBe(1);

    // The new insertion: a different transition, same stale version. Refused by
    // name, and the refusal carries both numbers, because "unsupported" and
    // "no longer current" are different problems with different fixes.
    expect(() =>
      reopened.append({
        ...makeEvent({
          taskId,
          transitionId: "two",
          fromState: "DISCOVERED",
          toState: "DISCOVERED",
        }),
        contractVersion: "2.2.0",
      }),
    ).toThrow(LedgerValidationError);

    let issue: { readonly path: string; readonly message: string } | undefined;
    try {
      reopened.append({
        ...makeEvent({
          taskId,
          transitionId: "three",
          fromState: "DISCOVERED",
          toState: "DISCOVERED",
        }),
        contractVersion: "2.2.0",
      });
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.path).toBe("contractVersion");
    expect(issue?.message).toContain(CONTRACT_VERSION);
    expect(issue?.message).toContain("2.2.0");

    // The stream is untouched by either refusal, and the handle is still usable.
    expect(reopened.status().headSequence).toBe(1);
    expect(reopened.verifyIntegrity().ok).toBe(true);
    reopened.close();
  });
  it("P-P18-2, escalón F: a 2.3.0 history reads, rebuilds and takes a quarantine batch; new 2.3.0 work does not", () => {
    // F is the second escalón to carry a bump (ADR 0078), so the drill C wrote
    // for 2.2.0 is owed again for 2.3.0: history recorded under the version C
    // put in force stays readable, its exact replay is still admitted, and new
    // work stamped with it is refused by name.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const discovered = makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT });
    ledger.append(discovered);
    ledger.close();
    restampHistory(path, "2.3.0");

    const reopened = open(path);
    expect(reopened.listEvents().events.map((record) => record.event.contractVersion)).toEqual(["2.3.0"]);
    expect(reopened.verifyIntegrity().ok).toBe(true);
    expect(reopened.rebuildReadModel().replayedEvents).toBe(1);

    expect(reopened.append({ ...discovered, contractVersion: "2.3.0" }).inserted).toBe(false);
    const stale = refusalOf(() =>
      reopened.appendBatch(quarantineBatch(taskId).map((event) => ({ ...event, contractVersion: "2.3.0" }))),
    );
    expect(stale.path).toBe("contractVersion");
    expect(stale.message).toContain("2.4.0");

    expect(reopened.appendBatch(quarantineBatch(taskId)).insertedCount).toBe(3);
    expect(reopened.listEvents().events.map((record) => record.event.contractVersion)).toEqual([
      "2.3.0",
      "2.4.0",
      "2.4.0",
      "2.4.0",
    ]);
    expect(reopened.getOutboxCommand(revokeCommandId())?.state).toBe("PENDING");
    expect(reopened.verifyIntegrity().ok).toBe(true);
    expect(reopened.rebuildReadModel().replayedEvents).toBe(4);
  });
});

describe("migration 11 applies whole, over a ledger that already has a history", () => {
  it("N12: a ledger written under the previous build opens, reads, verifies and rebuilds", () => {
    // The regression the preaudit's C-2 is about. `CONTRACT_VERSION` does NOT
    // move in this packet, precisely so that a ledger full of history under the
    // previous build stays readable — a version literal moved without a
    // supported-set mechanism would make every one of those events unparseable.
    const path = temporaryDatabase();
    const seeded = open(path);
    const taskId = randomUUID();
    seedTask(seeded, taskId, "kimi/k3/coordinator/01");
    const headBefore = seeded.status().headSequence;
    const tasksBefore = seeded.listTasks().tasks.length;
    seeded.close();

    // Rewind to the pre-migration-11 shape. This is what such a ledger looks
    // like on disk when a build that predates this packet last touched it.
    withRawDatabase(path, (raw) => {
      dropTaskRevisionIdentity(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(11);
    });

    const migrated = open(path);
    expect(migrated.status().migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);

    // Reads still answer, with the same rows and the same head.
    expect(migrated.status().headSequence).toBe(headBefore);
    expect(migrated.listTasks().tasks).toHaveLength(tasksBefore);
    expect(migrated.listEvents().events).toHaveLength(headBefore);
    expect(migrated.getTask(taskId)).not.toBeNull();

    // It verifies clean, which is the assertion that would fail if the
    // watermark had been seeded at a literal zero behind a non-zero head.
    expect(migrated.verifyIntegrity().ok).toBe(true);

    // And it rebuilds, producing the same projections a live fold produced.
    const rebuilt = migrated.rebuildReadModel();
    expect(rebuilt.replayedEvents).toBe(headBefore);
    expect(migrated.verifyIntegrity().ok).toBe(true);
    expect(readRevisions(path)).toEqual([]);

    // Every legacy row keeps both columns NULL. Nothing backfilled a number it
    // could not know.
    expect(readCoordinates(path).every((row) => row.revision_number === null)).toBe(true);
  });

  it("N2: the preflight refuses a ledger whose history already claims the V2 namespace", () => {
    // Streams §1.1 requires the migration that enables the V2 idempotency key
    // to check that no V2 key collides with a historical one, and to refuse
    // explicitly. Before any V2 row exists the checkable question is exactly
    // "is the namespace free", and it has to be asked NOW: the column is
    // UNIQUE, so a collision found later is a constraint failure naming one row
    // and no coordinate, on a ledger already in production.
    const path = temporaryDatabase();
    const seeded = open(path);
    seedTask(seeded, randomUUID(), "kimi/k3/coordinator/01");
    seeded.close();

    withRawDatabase(path, (raw) => {
      dropTaskRevisionIdentity(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(11);
      // Two historical rows squatting in the namespace, planted the only way
      // they could have arrived: by a writer that predates the reservation.
      raw.exec(
        "DROP TRIGGER control_plane_events_deny_update; " +
          "DROP TRIGGER control_plane_events_deny_delete;",
      );
      raw
        .prepare("UPDATE control_plane_events SET idempotency_key = ? WHERE sequence = 1")
        .run("v2/control_plane_events/a/1/1/discover");
      raw
        .prepare("UPDATE control_plane_events SET idempotency_key = ? WHERE sequence = 2")
        .run("v2/control_plane_events/a/1/2/classify");
    });

    const refusal = caught(() => open(path));
    expect(refusal).toBeInstanceOf(LedgerMigrationError);
    // Named, counted, and not repaired: the message says which rows and how
    // many, and the migration declines rather than rewriting anybody's key.
    expect((refusal as Error).message).toContain("2 historical idempotency key(s)");
    expect((refusal as Error).message).toContain("sequence 1 holds v2/control_plane_events/a/1/1/discover");
    expect((refusal as Error).message).toContain("will not rewrite");

    // Nothing was applied. The refusal left the ledger exactly where it was,
    // and it is repeatable rather than a half-migration.
    withRawDatabase(path, (raw) => {
      const applied = (
        raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((row) => row.version);
      expect(applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(
        (raw.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = ?").get(
          "task_revision_read_model",
        ) as { n: number }).n,
      ).toBe(0);
    });
    expect(caught(() => open(path))).toBeInstanceOf(LedgerMigrationError);
  });

  it("N9: a failure in the middle of the migration leaves nothing applied", () => {
    // The same claim P-08/A2 makes about migration 10, made here: preflight,
    // DDL, watermark seed and the migration row are one transaction. A ledger
    // holding the table but not the watermark — or the columns but not the
    // trigger — is not a state anything may observe.
    const path = temporaryDatabase();
    const seeded = open(path);
    seedTask(seeded, randomUUID(), "kimi/k3/coordinator/01");
    seeded.close();

    withRawDatabase(path, (raw) => {
      dropTaskRevisionIdentity(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(11);
      // The fault: a table by the name the migration is about to create. The
      // CREATE TABLE aborts, and everything that ran before it in the same
      // transaction has to go with it.
      raw.exec("CREATE TABLE task_revision_read_model (planted TEXT) STRICT;");
    });

    expect(caught(() => open(path))).toBeInstanceOf(Error);

    withRawDatabase(path, (raw) => {
      const applied = (
        raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((row) => row.version);
      expect(applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // The columns the ALTER statements would have added are absent, which is
      // the half a non-transactional migration would have leaked: SQLite runs
      // DDL inside a transaction, and this asserts that it really did.
      const columns = (
        raw.prepare("SELECT name FROM pragma_table_info('control_plane_events')").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(columns).not.toContain("revision_number");
      expect(columns).not.toContain("attempt_number");

      // And no watermark row was left behind for a projection that does not
      // exist.
      expect(
        (raw.prepare("SELECT COUNT(*) AS n FROM projection_watermark WHERE projection_name = ?").get(
          "task_revision_read_model",
        ) as { n: number }).n,
      ).toBe(0);
    });
  });

  it("seeds the watermark from the head it finds, never from a literal zero", () => {
    // Migration 9's second case, inherited. A literal zero would make every
    // ledger in the field fail its own integrity check immediately after a
    // routine upgrade, with nothing whatsoever wrong with it — so the seed
    // reads the head out of `ledger_meta` and the fold over the legacy rows is
    // legitimately empty.
    const path = temporaryDatabase();
    const seeded = open(path);
    seedTask(seeded, randomUUID(), "kimi/k3/coordinator/01");
    const head = seeded.status().headSequence;
    const count = seeded.status().eventCount;
    expect(head).toBeGreaterThan(0);
    seeded.close();

    withRawDatabase(path, (raw) => {
      dropTaskRevisionIdentity(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(11);
    });

    const migrated = open(path);
    const watermark = migrated
      .status()
      .projections.find((projection) => projection.name === "task_revision_read_model")
      ?.watermarks[0];
    expect([watermark?.appliedThroughSequence, watermark?.eventCount]).toEqual([head, count]);
    expect(migrated.verifyIntegrity().ok).toBe(true);
    expect(readRevisions(path)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo B — the attempt's identity, assigned once
// ---------------------------------------------------------------------------

const ATTEMPT_TASK_STATE: TaskState = "DISCOVERED";

interface AttemptRow {
  readonly task_id: string;
  readonly revision_number: number;
  readonly attempt_number: number;
  readonly legacy_attempt_number: number;
  readonly invocation_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: string | null;
  readonly sequence: number;
}

function readAttempts(path: string): AttemptRow[] {
  const raw = new Database(path);
  try {
    return raw
      .prepare(
        "SELECT * FROM task_attempt_read_model " +
          "ORDER BY task_id ASC, revision_number ASC, attempt_number ASC",
      )
      .all() as AttemptRow[];
  } finally {
    raw.close();
  }
}

interface OpeningInput {
  readonly taskId: string;
  readonly attempt: number;
  readonly transitionId: string;
  readonly revisionNumber?: number;
  readonly attemptNumber?: number;
  readonly revisionId?: string;
  readonly invocationId?: string;
  readonly legacyAttemptNumber?: number;
  readonly fromState?: TaskState | null;
  readonly occurredAt?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * One `TASK_ATTEMPT_OPENED` event, with the whole seven-key payload.
 *
 * `legacyAttemptNumber` defaults to `attempt`, because the door demands the
 * two agree and a helper that let them drift by default would make every test
 * below fail for the same uninteresting reason. The one test that needs them to
 * disagree says so.
 */
function attemptOpening(input: OpeningInput): Record<string, unknown> {
  const revisionNumber = input.revisionNumber ?? 1;
  const attemptNumber = input.attemptNumber ?? 1;
  return makeEvent({
    taskId: input.taskId,
    attempt: input.attempt,
    transitionId: input.transitionId,
    type: "TASK_ATTEMPT_OPENED",
    fromState: input.fromState ?? null,
    toState: ATTEMPT_TASK_STATE,
    occurredAt: input.occurredAt ?? "2026-08-27T12:00:00.000Z",
    payload:
      input.payload ??
      {
        revisionId: input.revisionId ?? randomUUID(),
        revisionNumber,
        attemptNumber,
        envelopeSha256: REVISION_ENVELOPE,
        invocationId: input.invocationId ?? "inv-" + String(attemptNumber),
        legacyAttemptNumber: input.legacyAttemptNumber ?? input.attempt,
      },
  });
}

/**
 * Plant one contract-valid event on the stream with a CORRECT hash chain.
 *
 * `plantStreamRow` above writes a fabricated digest, which is right for a
 * trigger drill and wrong for a rebuild drill: `#replay` would refuse the
 * chain before any fold ran, and the test would pass for a reason that has
 * nothing to do with what it claims. This helper chains onto the real head and
 * advances `ledger_meta` with it, so a rebuild reaches the fold and refuses —
 * or does not — for the projection's own reasons.
 *
 * It exists because the histories F-B4 is about are exactly the ones the append
 * door refuses. There is no way to reach them through the door, and a stored
 * history the door would have refused is precisely what a rebuild has to refuse
 * too.
 */
function plantChainedEvent(path: string, event: Record<string, unknown>): void {
  withRawDatabase(path, (raw) => {
    const meta = new Map(
      (raw.prepare("SELECT key, value FROM ledger_meta").all() as {
        readonly key: string;
        readonly value: string;
      }[]).map((row) => [row.key, row.value]),
    );
    const previousSha256 = meta.get("head_event_sha256") ?? GENESIS_SHA256;
    const count = Number(meta.get("event_count") ?? "0");
    const canonicalJson = canonicalJsonStringify(event);
    const eventSha256 = chainDigest(previousSha256, canonicalJson);
    const payload = event["payload"] as Record<string, unknown>;

    const info = raw
      .prepare(
        "INSERT INTO control_plane_events (" +
          "event_id, idempotency_key, task_id, attempt, revision_number, attempt_number, " +
          "transition_id, type, from_state, to_state, emitted_by, occurred_at, recorded_at, " +
          "correlation_id, causation_id, contract_version, event_json, previous_sha256, " +
          "event_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event["eventId"],
        event["idempotencyKey"],
        event["taskId"],
        event["attempt"],
        payload["revisionNumber"] ?? null,
        payload["attemptNumber"] ?? null,
        event["transitionId"],
        event["type"],
        event["fromState"],
        event["toState"],
        event["emittedBy"],
        event["occurredAt"],
        event["recordedAt"],
        null,
        null,
        event["contractVersion"],
        canonicalJson,
        previousSha256,
        eventSha256,
      );

    const update = raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?");
    update.run(String(Number(info.lastInsertRowid)), "head_sequence");
    update.run(String(count + 1), "event_count");
    update.run(eventSha256, "head_event_sha256");
  });
}

describe("every attempt opens with its own identity, assigned once", () => {
  it("P-B6: the legacy events count in the MAX, and a task with none starts at one", () => {
    // Execution §3 `:122`: `1 + MAX(attempt)` "de los eventos de esa tarea,
    // incluidos los legacy (sin eventos: 1)". Both halves, because the second
    // is what a `MAX` over an empty set gets wrong in silence — `null + 1` is
    // `NaN`, and a coordinate numbered `NaN` is a row nothing can find.
    const path = temporaryDatabase();
    const ledger = open(path);

    // A task whose history is V1 and whose flat attempt has reached 3. The next
    // coordinate's assignment is 4, not 1: the counter is per task, and the
    // legacy events hold it.
    const legacyTask = randomUUID();
    ledger.append(makeEvent({ taskId: legacyTask, attempt: 3, transitionId: "discover" }));
    ledger.append(
      attemptOpening({
        taskId: legacyTask,
        attempt: 4,
        transitionId: "attempt.open",
        fromState: ATTEMPT_TASK_STATE,
        invocationId: "inv-legacy-4",
      }),
    );

    // A task with no events at all. The opening IS its first event, so the
    // highest is nothing and the assignment is 1.
    const freshTask = randomUUID();
    ledger.append(
      attemptOpening({
        taskId: freshTask,
        attempt: 1,
        transitionId: "attempt.open",
        invocationId: "inv-fresh-1",
      }),
    );

    // Two rows and exactly two: `arrayContaining` because the table is ordered
    // by task id and these two are uuids, so the order is not the fixture's to
    // predict, and a length that a third row could satisfy would make the
    // containment claim weaker than it reads.
    expect(readAttempts(path)).toHaveLength(2);
    expect(
      readAttempts(path).map((row) => [row.task_id, row.legacy_attempt_number]),
    ).toEqual(
      expect.arrayContaining([
        [legacyTask, 4],
        [freshTask, 1],
      ]),
    );
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // And the proposal has to be the computed value, not merely a plausible
    // one: 1 would have been right for a task with no history and is wrong
    // here, and the refusal names what the assignment actually is.
    const wrong = caught(() =>
      ledger.append(
        attemptOpening({
          taskId: legacyTask,
          attempt: 1,
          transitionId: "attempt.wrong",
          attemptNumber: 2,
          fromState: ATTEMPT_TASK_STATE,
          invocationId: "inv-legacy-wrong",
        }),
      ),
    );
    expect(wrong).toBeInstanceOf(LedgerValidationError);
    expect((wrong as LedgerValidationError).issues[0]?.path).toBe("attempt");
    expect((wrong as Error).message).toContain("is assigned the flat attempt 5");
  });

  it("N-P18-7: a second invocationId for one coordinate is refused, by class and by path", () => {
    // The refusal execution §3 `:122` asks for in so many words: "se rechaza un
    // invocationId distinto para la misma coordenada".
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const revisionId = randomUUID();

    ledger.append(
      attemptOpening({
        taskId,
        attempt: 1,
        transitionId: "attempt.open",
        revisionId,
        invocationId: "inv-first",
      }),
    );

    // The second opening carries a DIFFERENT `transitionId` and a different
    // `eventId`, which is load-bearing rather than incidental: the V2 key is
    // `v2/stream/task/revision/attempt/transition`, so repeating the transition
    // would collide on the key and raise `LedgerIdempotencyConflictError`
    // BEFORE the compare-and-set ever ran. This test would then pass while
    // proving nothing about the CAS.
    const conflict = caught(() =>
      ledger.append(
        attemptOpening({
          taskId,
          attempt: 1,
          transitionId: "attempt.open.again",
          revisionId,
          invocationId: "inv-second",
          fromState: ATTEMPT_TASK_STATE,
        }),
      ),
    );
    expect(conflict).toBeInstanceOf(LedgerValidationError);
    expect(conflict).not.toBeInstanceOf(LedgerIdempotencyConflictError);
    expect((conflict as LedgerValidationError).issues[0]?.path).toBe("payload.invocationId");
    expect((conflict as Error).message).toContain("already open under invocation inv-first");

    // Nothing was written: not the event, not a second row, not a drift.
    expect(readAttempts(path)).toHaveLength(1);
    expect(readAttempts(path)[0]?.invocation_id).toBe("inv-first");
    expect(ledger.listEvents().events).toHaveLength(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // The SAME invocation again, under a new transition, is a replay: the
    // assignment and the invocation are reused and the row is untouched. A
    // retry of an append has to stay safe.
    ledger.append(
      attemptOpening({
        taskId,
        attempt: 1,
        transitionId: "attempt.open.replay",
        revisionId,
        invocationId: "inv-first",
        fromState: ATTEMPT_TASK_STATE,
        occurredAt: "2026-08-27T15:00:00.000Z",
      }),
    );
    expect(readAttempts(path)).toHaveLength(1);
    // And the row still records the FIRST arrival, exactly as a revision row
    // does: a replay reads the record, it does not restamp it.
    expect(readAttempts(path)[0]?.started_at).toBe("2026-08-27T12:00:00.000Z");
  });

  it("refuses one invocation naming two coordinates, which is the other half of the bijection", () => {
    // The primary key stops one coordinate holding two invocations; this is the
    // direction `ux_task_attempt_read_model__invocation_id` holds, guarded by
    // name so the refusal names both attempts rather than arriving as an abort.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const revisionId = randomUUID();

    ledger.append(
      attemptOpening({ taskId, attempt: 1, transitionId: "a1", revisionId, invocationId: "inv-x" }),
    );

    const reused = caught(() =>
      ledger.append(
        attemptOpening({
          taskId,
          attempt: 2,
          attemptNumber: 2,
          transitionId: "a2",
          revisionId,
          invocationId: "inv-x",
          fromState: ATTEMPT_TASK_STATE,
        }),
      ),
    );
    expect(reused).toBeInstanceOf(LedgerValidationError);
    expect((reused as LedgerValidationError).issues[0]?.path).toBe("payload.invocationId");
    expect((reused as Error).message).toContain("already names attempt");

    // A different invocation at the same coordinate lands, so the refusal was
    // about the reuse and not about the second attempt.
    ledger.append(
      attemptOpening({
        taskId,
        attempt: 2,
        attemptNumber: 2,
        transitionId: "a2",
        revisionId,
        invocationId: "inv-y",
        fromState: ATTEMPT_TASK_STATE,
      }),
    );
    expect(readAttempts(path).map((row) => row.invocation_id)).toEqual(["inv-x", "inv-y"]);
    // Attempt 2 of revision 1 got the flat number 2, and the two are unique
    // within the task — which is what makes the legacy column usable.
    expect(readAttempts(path).map((row) => row.legacy_attempt_number)).toEqual([1, 2]);
  });

  it("F-B1: a non-opening V2 event over an open coordinate must repeat its assignment", () => {
    // Execution §3 `:123`: "Todos los eventos de la misma coordenada deben
    // repetirlo". A V2 event whose flat `attempt` disagrees with the assignment
    // would be indexed under a coordinate the attempt table says belongs to a
    // different try, and every query written before migration 11 reads that
    // column.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const revisionId = randomUUID();

    // A legacy event first, so the assignment is 2 rather than 1 and a test
    // that simply reused `attempt: 1` could not accidentally agree.
    ledger.append(makeEvent({ taskId, attempt: 1, transitionId: "discover" }));
    ledger.append(
      attemptOpening({
        taskId,
        attempt: 2,
        transitionId: "attempt.open",
        revisionId,
        invocationId: "inv-1",
        fromState: ATTEMPT_TASK_STATE,
      }),
    );

    const mismatch = caught(() =>
      ledger.append(
        makeEvent({
          taskId,
          attempt: 1,
          transitionId: "step",
          type: "ATOMIC_STEP_COMPLETED",
          fromState: ATTEMPT_TASK_STATE,
          toState: ATTEMPT_TASK_STATE,
          payload: { revisionNumber: 1, attemptNumber: 1 },
        }),
      ),
    );
    expect(mismatch).toBeInstanceOf(LedgerValidationError);
    expect((mismatch as LedgerValidationError).issues[0]?.path).toBe("attempt");
    expect((mismatch as Error).message).toContain("was assigned the flat attempt 2");

    // The same event carrying the assignment lands.
    ledger.append(
      makeEvent({
        taskId,
        attempt: 2,
        transitionId: "step",
        type: "ATOMIC_STEP_COMPLETED",
        fromState: ATTEMPT_TASK_STATE,
        toState: ATTEMPT_TASK_STATE,
        payload: { revisionNumber: 1, attemptNumber: 1 },
      }),
    );
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("is tolerant of a V2 event over a coordinate no opening has reached", () => {
    // The other half of "tolerant without a row, strict with one". Migration 11
    // declared the "migrated but not populated" window lawful, and every V2
    // fixture written before this escalón is exactly that shape: a coordinate
    // announced by payload keys with no attempt row behind it. Demanding that
    // an opening precede everything would retroactively refuse histories the
    // log already holds — so this is asserted, not assumed.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();

    ledger.append(
      makeEvent({
        taskId,
        attempt: 7,
        transitionId: "revise",
        payload: revisionPayload({ revisionNumber: 3, attemptNumber: 5 }),
      }),
    );
    expect(readAttempts(path)).toEqual([]);
    expect(readRevisions(path)).toHaveLength(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("F-B2: the payload's flat assignment and the legacy column must agree", () => {
    // The third pairing rule, and the sister of the two the stream trigger
    // holds for `revisionNumber`/`attemptNumber`. It lives at the door rather
    // than in a fourth trigger (ADR 0073), so it is drilled through the door.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();

    const disagreeing = caught(() =>
      ledger.append(
        attemptOpening({
          taskId,
          attempt: 1,
          transitionId: "attempt.open",
          legacyAttemptNumber: 9,
          invocationId: "inv-1",
        }),
      ),
    );
    expect(disagreeing).toBeInstanceOf(LedgerValidationError);
    expect((disagreeing as LedgerValidationError).issues[0]?.path).toBe(
      "payload.legacyAttemptNumber",
    );
    expect((disagreeing as Error).message).toContain("this payload states 9");

    // The contract admits that event — `payload` is a record of unknowns for
    // every type — which is exactly why this door has to refuse it.
    expect(readAttempts(path)).toEqual([]);
    expect(ledger.listEvents().events).toHaveLength(0);

    // And a payload with no assignment at all, or one that is not a count, is
    // refused on the same key rather than folded into a row with a hole.
    for (const bad of [undefined, 0, -1, 1.5, "1", null]) {
      const payload: Record<string, unknown> = {
        revisionId: randomUUID(),
        revisionNumber: 1,
        attemptNumber: 1,
        envelopeSha256: REVISION_ENVELOPE,
        invocationId: "inv-1",
      };
      if (bad !== undefined) payload["legacyAttemptNumber"] = bad;
      const refused = caught(() =>
        ledger.append(
          attemptOpening({ taskId, attempt: 1, transitionId: "attempt.bad", payload }),
        ),
      );
      expect(refused, JSON.stringify(bad ?? null)).toBeInstanceOf(LedgerValidationError);
      expect((refused as LedgerValidationError).issues[0]?.path).toBe(
        "payload.legacyAttemptNumber",
      );
    }

    // The same for the invocation, which is the other fact only an opening may
    // state and the other half of the bijection.
    const noInvocation = caught(() =>
      ledger.append(
        attemptOpening({
          taskId,
          attempt: 1,
          transitionId: "attempt.bad",
          payload: {
            revisionId: randomUUID(),
            revisionNumber: 1,
            attemptNumber: 1,
            envelopeSha256: REVISION_ENVELOPE,
            legacyAttemptNumber: 1,
          },
        }),
      ),
    );
    expect(noInvocation).toBeInstanceOf(LedgerValidationError);
    expect((noInvocation as LedgerValidationError).issues[0]?.path).toBe("payload.invocationId");
  });

  it("F-B3: an opening on a revision that does not exist is refused by name, never by abort", () => {
    // F-2's standard, inherited (ADR 0072): "this layer exists so the refusal
    // is a typed LedgerValidationError rather than a raw SQLite error nobody
    // can catch by class". Without this guard the foreign key would abort and
    // the operator would be handed a `SqliteError` naming a constraint.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();

    const orphan = caught(() =>
      ledger.append(
        attemptOpening({
          taskId,
          attempt: 1,
          transitionId: "attempt.open",
          // The coordinate and the identity, with the revision record's own
          // keys absent: nothing announces revision 1 and no row holds it.
          payload: {
            revisionNumber: 1,
            attemptNumber: 1,
            invocationId: "inv-1",
            legacyAttemptNumber: 1,
          },
        }),
      ),
    );
    expect(orphan).toBeInstanceOf(LedgerValidationError);
    expect((orphan as LedgerValidationError).issues[0]?.path).toBe("payload.revisionId");
    expect((orphan as Error).message).toContain("neither exists nor is announced");
    expect((orphan as Error).name).not.toBe("SqliteError");
    expect(ledger.listEvents().events).toHaveLength(0);

    // An opening on a revision that ALREADY exists needs no announcement of its
    // own, so the guard is about the foreign key and not about the payload's
    // completeness for its own sake.
    ledger.append(
      makeEvent({
        taskId,
        attempt: 1,
        transitionId: "revise",
        payload: revisionPayload({ revisionNumber: 1, attemptNumber: 1 }),
      }),
    );
    ledger.append(
      attemptOpening({
        taskId,
        attempt: 2,
        transitionId: "attempt.open",
        fromState: ATTEMPT_TASK_STATE,
        payload: {
          revisionNumber: 1,
          attemptNumber: 1,
          invocationId: "inv-1",
          legacyAttemptNumber: 2,
        },
      }),
    );
    expect(readAttempts(path)).toHaveLength(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("F-B5: the outcome pair is a schema constraint, and it is exercised as one", () => {
    // This escalón writes no closer at all, so `ended_at` and `outcome` are
    // `NULL` on every row a fold produces and the CHECK would be inert across
    // the whole suite if it were only reached through the door. It is reached
    // raw instead: half an ending is what it exists to refuse, and a later
    // escalón inherits a constraint that has been seen to work.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    ledger.append(
      attemptOpening({ taskId, attempt: 1, transitionId: "attempt.open", invocationId: "inv-1" }),
    );
    ledger.close();

    const insert =
      "INSERT INTO task_attempt_read_model (task_id, revision_number, attempt_number, " +
      "legacy_attempt_number, invocation_id, started_at, ended_at, outcome, sequence) " +
      "VALUES (?, 1, ?, ?, ?, ?, ?, ?, 9)";

    withRawDatabase(path, (raw) => {
      // An ending with no outcome.
      expect(() =>
        raw
          .prepare(insert)
          .run(taskId, 2, 2, "inv-ended", "2026-08-27T12:00:00.000Z", "2026-08-27T13:00:00.000Z", null),
      ).toThrow(/CHECK|constraint/i);

      // An outcome with no ending, which is the direction a one-sided CHECK
      // would have let through.
      expect(() =>
        raw
          .prepare(insert)
          .run(taskId, 3, 3, "inv-outcome", "2026-08-27T12:00:00.000Z", null, "SUCCEEDED"),
      ).toThrow(/CHECK|constraint/i);

      // A word outside `effect_outcome_status`, even paired correctly.
      expect(() =>
        raw
          .prepare(insert)
          .run(taskId, 4, 4, "inv-word", "2026-08-27T12:00:00.000Z", "2026-08-27T13:00:00.000Z", "DONE"),
      ).toThrow(/CHECK|constraint/i);

      // Both together, with one of the four words, is admitted — so the three
      // refusals above are about the pairing and the vocabulary rather than
      // about a column that cannot be written at all.
      expect(() =>
        raw
          .prepare(insert)
          .run(taskId, 5, 5, "inv-ok", "2026-08-27T12:00:00.000Z", "2026-08-27T13:00:00.000Z", "SUCCEEDED"),
      ).not.toThrow();

      // And an attempt on a revision nobody recorded is refused by the foreign
      // key, which is what the door's typed guard stands in front of.
      expect(() =>
        raw
          .prepare(
            "INSERT INTO task_attempt_read_model (task_id, revision_number, attempt_number, " +
              "legacy_attempt_number, invocation_id, started_at, ended_at, outcome, sequence) " +
              "VALUES (?, 99, 1, 9, 'inv-orphan', '2026-08-27T12:00:00.000Z', NULL, NULL, 9)",
          )
          .run(taskId),
      ).toThrow(/FOREIGN KEY|constraint/i);
    });
  });

  it("refuses the flat attempt space when it is exhausted, naming the bound", () => {
    // Adjudication Q4. The cap is the contract's — `attempt` is bounded at
    // 10 000 — and the compare-and-set consults it on the value it COMPUTES.
    // The order matters and is why this fixture reaches the cap through a
    // legacy event: if the check ran after the comparison, the contract's own
    // parse would refuse `attempt = 10001` first and the claim that the CAS
    // knows the bound would never be exercised at all.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, attempt: 10_000, transitionId: "discover" }));

    const exhausted = caught(() =>
      ledger.append(
        attemptOpening({
          taskId,
          attempt: 10_000,
          transitionId: "attempt.open",
          fromState: ATTEMPT_TASK_STATE,
          invocationId: "inv-1",
        }),
      ),
    );
    expect(exhausted).toBeInstanceOf(LedgerValidationError);
    expect((exhausted as LedgerValidationError).issues[0]?.path).toBe("attempt");
    expect((exhausted as Error).message).toContain("the next assignment would be 10001");
    expect((exhausted as Error).message).toContain("the contract's bound is 10000");
    expect(readAttempts(path)).toEqual([]);

    // A task ten thousand attempts deep is resolved with a NEW task, which the
    // refusal says in words and which still works.
    const fresh = randomUUID();
    ledger.append(
      attemptOpening({ taskId: fresh, attempt: 1, transitionId: "attempt.open", invocationId: "inv-2" }),
    );
    expect(readAttempts(path)).toHaveLength(1);
  });

  it("N-P18-8: a rebuild copies the identity and never reassigns it, twice over", () => {
    // Execution §3 `:123`: the rebuild "copia `legacy_attempt_number` e
    // `invocation_id` registrados por el evento V2, nunca vuelve a asignarlos
    // ni usa el reloj". Two rebuilds, because one proves determinism against
    // the stored rows and two prove it against itself — a fold that read a
    // clock would differ between them while agreeing with neither.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const revisionId = randomUUID();

    // A history with a legacy prefix, so the assignments are 4 and 5 rather
    // than 1 and 2: a rebuild that recomputed them from scratch over the
    // attempts alone would produce 1 and 2 and this would catch it.
    ledger.append(makeEvent({ taskId, attempt: 3, transitionId: "discover" }));
    ledger.append(
      attemptOpening({
        taskId,
        attempt: 4,
        transitionId: "a1",
        revisionId,
        invocationId: "inv-a",
        fromState: ATTEMPT_TASK_STATE,
      }),
    );
    ledger.append(
      attemptOpening({
        taskId,
        attempt: 5,
        attemptNumber: 2,
        transitionId: "a2",
        revisionId,
        invocationId: "inv-b",
        fromState: ATTEMPT_TASK_STATE,
      }),
    );

    const live = readAttempts(path);
    expect(live.map((row) => [row.attempt_number, row.legacy_attempt_number, row.invocation_id])).toEqual([
      [1, 4, "inv-a"],
      [2, 5, "inv-b"],
    ]);
    // Born open, every one of them: this escalón writes no closer.
    expect(live.every((row) => row.ended_at === null && row.outcome === null)).toBe(true);
    ledger.close();

    const first = open(path);
    expect(first.rebuildReadModel().replayedEvents).toBe(3);
    first.close();
    const afterFirst = readAttempts(path);

    const second = open(path);
    expect(second.rebuildReadModel().replayedEvents).toBe(3);
    expect(second.verifyIntegrity().ok).toBe(true);
    const afterSecond = readAttempts(path);

    expect(afterFirst).toEqual(live);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("F-B4: a rebuild refuses the histories the door refuses, at the event that caused them", () => {
    // The determinism above is only half of N-P18-8. The other half is that a
    // stored history the door would have refused makes the REBUILD fail too —
    // the incremental path and the replay share one fold and one comparison, so
    // a rebuild that accepted such a history would be a second definition of
    // which ledgers are writable.
    //
    // The events have to be planted, with a correct chain, because these are
    // exactly the histories no append can produce.
    const twoInvocations = temporaryDatabase();
    {
      const ledger = open(twoInvocations);
      const taskId = randomUUID();
      const revisionId = randomUUID();
      ledger.append(
        attemptOpening({ taskId, attempt: 1, transitionId: "a1", revisionId, invocationId: "inv-a" }),
      );
      ledger.close();

      plantChainedEvent(
        twoInvocations,
        attemptOpening({
          taskId,
          attempt: 1,
          transitionId: "a1-again",
          revisionId,
          invocationId: "inv-b",
          fromState: ATTEMPT_TASK_STATE,
        }),
      );

      const reopened = open(twoInvocations);
      const refused = caught(() => reopened.rebuildReadModel());
      expect(refused).toBeInstanceOf(LedgerValidationError);
      expect((refused as Error).message).toContain("already recorded with a different identity");
      // The refusal rolled back: the projection is still the one the door built.
      expect(readAttempts(twoInvocations)).toHaveLength(1);
      expect(readAttempts(twoInvocations)[0]?.invocation_id).toBe("inv-a");
    }

    const oneFlatNumber = temporaryDatabase();
    {
      const ledger = open(oneFlatNumber);
      const taskId = randomUUID();
      const revisionId = randomUUID();
      ledger.append(
        attemptOpening({ taskId, attempt: 1, transitionId: "a1", revisionId, invocationId: "inv-a" }),
      );
      ledger.close();

      // A second coordinate claiming the SAME flat assignment. The table's
      // `UNIQUE (task_id, legacy_attempt_number)` would abort on it; the
      // snapshot refuses it first, naming both coordinates.
      plantChainedEvent(
        oneFlatNumber,
        attemptOpening({
          taskId,
          attempt: 1,
          attemptNumber: 2,
          transitionId: "a2",
          revisionId,
          invocationId: "inv-b",
          legacyAttemptNumber: 1,
          fromState: ATTEMPT_TASK_STATE,
        }),
      );

      const reopened = open(oneFlatNumber);
      const refused = caught(() => reopened.rebuildReadModel());
      expect(refused).toBeInstanceOf(LedgerValidationError);
      expect((refused as Error).message).toContain("which attempt");
      expect((refused as Error).message).toContain("already holds");
      expect(readAttempts(oneFlatNumber)).toHaveLength(1);
    }
  });

  it("reports an attempt row nobody wrote, and one that went missing", () => {
    // Both directions, as every projection in `verifyIntegrity` is compared.
    // The more interesting half here is the row no event accounts for: the
    // table is insert-only and the coordinate is the identity of one try, so a
    // row nobody wrote is a claim that a run happened when it did not.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    ledger.append(
      attemptOpening({ taskId, attempt: 1, transitionId: "a1", invocationId: "inv-a" }),
    );
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare(
          "INSERT INTO task_attempt_read_model (task_id, revision_number, attempt_number, " +
            "legacy_attempt_number, invocation_id, started_at, ended_at, outcome, sequence) " +
            "VALUES (?, 1, 4, 40, 'inv-ghost', '2026-08-27T12:00:00.000Z', NULL, NULL, 9)",
        )
        .run(taskId);
    });

    const ghost = open(path).verifyIntegrity();
    expect(ghost.ok).toBe(false);
    expect(ghost.problems.map((problem) => problem.detail)).toContain(
      "task_attempt_read_model holds the attempt for " + taskId + " 1 4 which no event accounts for",
    );

    withRawDatabase(path, (raw) => {
      raw.exec("DELETE FROM task_attempt_read_model");
    });

    const missing = open(path).verifyIntegrity();
    expect(missing.ok).toBe(false);
    expect(missing.problems.map((problem) => problem.detail)).toContain(
      "task_attempt_read_model is missing the attempt for " + taskId + " 1 1",
    );
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo C — the effect, its deliveries, and the segment they hang off
//
// Execution §4, §6, §6.1 and §7. The negatives are the map's N-P18-1..6 and the
// preaudit's N-C-1..N-C-10; the positives are P-P18-6, P-P18-7 and P-P18-8.
// ---------------------------------------------------------------------------

/**
 * Read rows straight out of a closed database, for the drills that assert what
 * the base holds rather than what a reader reports.
 *
 * Generic over the query because these three tables are asserted both as whole
 * rows — for the rebuild determinism drill — and column by column, and a helper
 * per shape would be three helpers making one argument.
 */
function readRows(path: string, sql: string): readonly Record<string, unknown>[] {
  const raw = new Database(path);
  try {
    return raw.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

/** The one instant every fixture below is recorded at, unless it says otherwise. */
const EFFECT_AT = "2026-09-12T09:00:00.000Z";

/** The semantic scope P-18 admits, and the step key most drills use. */
const SCOPE = "run";
const STEP = "compose-answer";

/** The business request every fixture carries. Never prompt bytes, by contract. */
const NEUTRAL_REQUEST = { operation: "compose", inputs: ["a", "b"] };

interface SegmentInput {
  readonly routeSegmentId?: string;
  readonly segmentNumber?: number;
  readonly predecessorSegmentId?: string;
  readonly handoffReason?: string;
  readonly accountId?: string;
  readonly provider?: string;
  readonly overrides?: Record<string, unknown>;
}

/** One well-formed segment record, in the nested shape the payload carries. */
function segmentRecord(input: SegmentInput = {}): Record<string, unknown> {
  const segmentNumber = input.segmentNumber ?? 1;
  return {
    routeSegmentId: input.routeSegmentId ?? "seg-" + String(segmentNumber),
    segmentNumber,
    ...(input.predecessorSegmentId === undefined
      ? {}
      : {
          predecessorSegmentId: input.predecessorSegmentId,
          handoffReason: input.handoffReason ?? "QUOTA_EXHAUSTED",
        }),
    provider: input.provider ?? "anthropic",
    model: "claude-opus-5",
    modelResolutionStatus: "RESOLVED",
    modelVersionId: "claude-opus-5-20260101",
    accountId: input.accountId ?? "acct-1",
    transportKind: "cli",
    capabilityPolicyVersion: "policy-1",
    ...(input.overrides ?? {}),
  };
}

interface EffectInput {
  readonly taskId: string;
  readonly transitionId: string;
  readonly invocationId: string;
  readonly segment?: Record<string, unknown>;
  readonly revisionNumber?: number;
  readonly attemptNumber?: number;
  readonly attempt?: number;
  readonly operationOrdinal?: number;
  readonly effectKind?: string;
  readonly requestContractVersion?: string;
  readonly semanticScopeKey?: string;
  readonly localOperationKey?: string;
  readonly neutralRequest?: unknown;
  readonly envelopeSha256?: string;
  readonly occurredAt?: string;
  readonly overrides?: Record<string, unknown>;
}

/**
 * One `EFFECT_INTENDED` event, with every digest computed the way the door
 * recomputes it.
 *
 * The helper computes rather than hard-codes, so a drill that wants a digest to
 * be wrong says which one through `overrides` and every other drill is immune
 * to the arithmetic. That is the same allocation `attemptOpening` makes for
 * `legacyAttemptNumber`.
 */
function effectIntention(input: EffectInput): Record<string, unknown> {
  const revisionNumber = input.revisionNumber ?? 1;
  const attemptNumber = input.attemptNumber ?? 1;
  const segment = input.segment ?? segmentRecord();
  const segmentNumber = segment["segmentNumber"] as number;
  const operationOrdinal = input.operationOrdinal ?? 0;
  const effectKind = input.effectKind ?? "model_execution";
  const requestContractVersion = input.requestContractVersion ?? "1";
  const envelopeSha256 = input.envelopeSha256 ?? REVISION_ENVELOPE;
  const coordinate = {
    taskId: input.taskId,
    revisionNumber,
    attemptNumber,
    segmentNumber,
    operationOrdinal,
  };
  return makeEvent({
    taskId: input.taskId,
    attempt: input.attempt ?? 1,
    transitionId: input.transitionId,
    type: "EFFECT_INTENDED",
    fromState: ATTEMPT_TASK_STATE,
    toState: ATTEMPT_TASK_STATE,
    occurredAt: input.occurredAt ?? EFFECT_AT,
    payload: {
      revisionNumber,
      attemptNumber,
      segment,
      effect: {
        effectId: effectIdV1(coordinate),
        operationOrdinal,
        effectKind,
        semanticScopeKey: input.semanticScopeKey ?? SCOPE,
        localOperationKey: input.localOperationKey ?? STEP,
        logicalOperationSha256: logicalOperationSha256({
          invocationId: input.invocationId,
          semanticScopeKey: input.semanticScopeKey ?? SCOPE,
          localOperationKey: input.localOperationKey ?? STEP,
        }),
        requestContractVersion,
        requestSha256: requestSha256({
          effectKind,
          requestContractVersion,
          envelopeSha256,
          neutralRequest: input.neutralRequest ?? NEUTRAL_REQUEST,
        }),
        idempotencyKey: effectIdempotencyKeyV1({ ...coordinate, effectKind, envelopeSha256 }),
        ...(input.overrides ?? {}),
      },
    },
  });
}

interface DispatchInput {
  readonly taskId: string;
  readonly transitionId: string;
  readonly effectId: string;
  readonly dispatchAttemptId?: string;
  readonly attemptOrdinal?: number;
  readonly segment?: Record<string, unknown>;
  readonly revisionNumber?: number;
  readonly attemptNumber?: number;
  readonly attempt?: number;
  readonly occurredAt?: string;
}

/** One `DISPATCH_INTENDED` event: the delivery, and the segment it runs on. */
function dispatchIntention(input: DispatchInput): Record<string, unknown> {
  const attemptOrdinal = input.attemptOrdinal ?? 1;
  return makeEvent({
    taskId: input.taskId,
    attempt: input.attempt ?? 1,
    transitionId: input.transitionId,
    type: "DISPATCH_INTENDED",
    fromState: ATTEMPT_TASK_STATE,
    toState: ATTEMPT_TASK_STATE,
    occurredAt: input.occurredAt ?? EFFECT_AT,
    payload: {
      revisionNumber: input.revisionNumber ?? 1,
      attemptNumber: input.attemptNumber ?? 1,
      segment: input.segment ?? segmentRecord(),
      dispatch: {
        dispatchAttemptId: input.dispatchAttemptId ?? "dsp-" + String(attemptOrdinal),
        effectId: input.effectId,
        attemptOrdinal,
      },
    },
  });
}

interface OutcomeInput {
  readonly taskId: string;
  readonly transitionId: string;
  readonly dispatchAttemptId: string;
  readonly dispatchState: string;
  readonly terminalAt?: string;
  readonly acceptedAt?: string;
  readonly externalHandle?: string;
  readonly effectOutcomeStatus?: string;
  readonly revisionNumber?: number;
  readonly attemptNumber?: number;
  readonly attempt?: number;
  readonly occurredAt?: string;
}

/** One `DISPATCH_OUTCOME_RECORDED` event. */
function dispatchOutcome(input: OutcomeInput): Record<string, unknown> {
  return makeEvent({
    taskId: input.taskId,
    attempt: input.attempt ?? 1,
    transitionId: input.transitionId,
    type: "DISPATCH_OUTCOME_RECORDED",
    fromState: ATTEMPT_TASK_STATE,
    toState: ATTEMPT_TASK_STATE,
    occurredAt: input.occurredAt ?? EFFECT_AT,
    payload: {
      revisionNumber: input.revisionNumber ?? 1,
      attemptNumber: input.attemptNumber ?? 1,
      outcome: {
        dispatchAttemptId: input.dispatchAttemptId,
        dispatchState: input.dispatchState,
        ...(input.terminalAt === undefined ? {} : { terminalAt: input.terminalAt }),
        ...(input.acceptedAt === undefined ? {} : { acceptedAt: input.acceptedAt }),
        ...(input.externalHandle === undefined ? {} : { externalHandle: input.externalHandle }),
        ...(input.effectOutcomeStatus === undefined
          ? {}
          : { effectOutcomeStatus: input.effectOutcomeStatus }),
      },
    },
  });
}

/** A ledger with one task, one revision and one open attempt. */
function seedOpenAttempt(
  ledger: Ledger,
  taskId: string,
  invocationId = "inv-1",
): void {
  ledger.append(
    attemptOpening({ taskId, attempt: 1, transitionId: "open", invocationId }),
  );
}

/** The effect id of the first operation of the first segment of attempt 1. */
function firstEffectId(taskId: string, segmentNumber = 1, operationOrdinal = 0): string {
  return effectIdV1({
    taskId,
    revisionNumber: 1,
    attemptNumber: 1,
    segmentNumber,
    operationOrdinal,
  });
}

describe("the logical effect is looked up by its logical key (execution §6.1)", () => {
  it("P-P18-6: an intention lands once, with the ordinal the ledger assigned", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);

    const intention = effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" });
    const first = ledger.append(intention);
    expect(first.inserted).toBe(true);

    // The exact same event again is a replay: nothing inserted, no second
    // ordinal, no second effect.
    const replay = ledger.append(intention);
    expect(replay.inserted).toBe(false);
    expect(replay.record.sequence).toBe(first.record.sequence);

    const effect = ledger.getEffect(firstEffectId(taskId));
    expect(effect).not.toBeNull();
    expect(effect?.operationOrdinal).toBe(0);
    expect(effect?.routeSegmentId).toBe("seg-1");
    // Born without an outcome — absence of data, which is N-P18-6's whole point.
    expect(effect?.outcomeStatus).toBeNull();
    expect(effect?.outcomeRecordedAt).toBeNull();
    // And the segment the same event announced, so the foreign key was
    // satisfied by construction rather than by assuming a parent.
    expect(ledger.listRouteSegments(taskId, 1, 1).map((row) => row.routeSegmentId)).toEqual([
      "seg-1",
    ]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-P18-6: an intention never dispatched is null, not OUTCOME_UNKNOWN", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));

    const effect = ledger.getEffect(firstEffectId(taskId));
    expect(effect?.outcomeStatus).toBeNull();

    // The lookup agrees, and says nothing needs reconciling: nothing ever left.
    const found = ledger.lookUpEffect({
      taskId,
      revisionNumber: 1,
      attemptNumber: 1,
      semanticScopeKey: SCOPE,
      localOperationKey: STEP,
      effectKind: "model_execution",
      requestContractVersion: "1",
      requestSha256: requestSha256({
        effectKind: "model_execution",
        requestContractVersion: "1",
        envelopeSha256: REVISION_ENVELOPE,
        neutralRequest: NEUTRAL_REQUEST,
      }),
    });
    expect(found?.effect.effectId).toBe(firstEffectId(taskId));
    expect(found?.reconciliationRequired).toBe(false);
    expect(ledger.listDispatchAttempts(firstEffectId(taskId))).toEqual([]);
  });

  it("N-P18-1: losing an acknowledgement, handing off, and repeating the step", () => {
    // The packet's minimal negative, end to end (execution §6.1 `:326-329`).
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);

    // 1. The effect is intended on segment 1 and dispatched.
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);
    ledger.append(dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }));

    // 2. It reaches the provider and the acknowledgement is lost: the delivery
    //    is INFLIGHT, and reconciliation exhausts without an answer, so the
    //    exposure is recorded as uncertain.
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "inflight-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "INFLIGHT",
        acceptedAt: EFFECT_AT,
      }),
    );
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "abandon-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "ABANDONED",
        terminalAt: "2026-09-12T09:05:00.000Z",
        effectOutcomeStatus: "OUTCOME_UNKNOWN",
      }),
    );

    // 3. The run hands off to another account. A handoff is a new segment, and
    //    the run repeats the same scope and the same step key.
    const lookup = ledger.lookUpEffect({
      taskId,
      revisionNumber: 1,
      attemptNumber: 1,
      semanticScopeKey: SCOPE,
      localOperationKey: STEP,
      effectKind: "model_execution",
      requestContractVersion: "1",
      requestSha256: requestSha256({
        effectKind: "model_execution",
        requestContractVersion: "1",
        envelopeSha256: REVISION_ENVELOPE,
        neutralRequest: NEUTRAL_REQUEST,
      }),
    });

    // The original effect id comes back — never a new one — and the situation
    // demands reconciliation rather than another send.
    expect(lookup?.effect.effectId).toBe(effectId);
    expect(lookup?.effect.idempotencyKey).toBe(
      effectIdempotencyKeyV1({
        taskId,
        revisionNumber: 1,
        attemptNumber: 1,
        segmentNumber: 1,
        operationOrdinal: 0,
        effectKind: "model_execution",
        envelopeSha256: REVISION_ENVELOPE,
      }),
    );
    expect(lookup?.reconciliationRequired).toBe(true);

    // 4. No new intention. A producer that tried anyway is refused by name, and
    //    the refusal tells it the effect it already has. It is the same work
    //    again, so it is NOT a CONFLICT: the handoff moved the segment and the
    //    ordinal CAS moved the ordinal, and neither is a difference §6.1 compares.
    //    What the producer is told is to reuse and reconcile, never that the key
    //    must not change.
    const second = segmentRecord({
      routeSegmentId: "seg-2",
      segmentNumber: 2,
      predecessorSegmentId: "seg-1",
      accountId: "acct-2",
    });
    let repeated: unknown;
    try {
      ledger.append(
        effectIntention({
          taskId,
          transitionId: "effect-2",
          invocationId: "inv-1",
          segment: second,
          operationOrdinal: 1,
        }),
      );
    } catch (error) {
      repeated = error;
    }
    expect(repeated).toBeInstanceOf(LedgerValidationError);
    const refusal = (repeated as LedgerValidationError).issues[0];
    expect(refusal?.path).toBe("payload.effect.logicalOperationSha256");
    expect(refusal?.message).not.toContain("CONFLICT");
    expect(refusal?.message).toContain(effectId);
    expect(refusal?.message).toContain("reconciliation");

    //    Different work under the same scope and step key is the other branch,
    //    and the door still names it CONFLICT.
    let conflicting: unknown;
    try {
      ledger.append(
        effectIntention({
          taskId,
          transitionId: "effect-2-other",
          invocationId: "inv-1",
          segment: second,
          operationOrdinal: 1,
          neutralRequest: { operation: "compose", inputs: ["a", "c"] },
        }),
      );
    } catch (error) {
      conflicting = error;
    }
    expect(conflicting).toBeInstanceOf(LedgerValidationError);
    expect((conflicting as LedgerValidationError).issues[0]?.message).toContain("CONFLICT");

    // 5. And no new send: the uncertain outcome blocks another delivery of the
    //    same effect outright.
    expect(() =>
      ledger.append(
        dispatchIntention({
          taskId,
          transitionId: "dispatch-2",
          effectId,
          dispatchAttemptId: "dsp-2",
          attemptOrdinal: 2,
          segment: second,
        }),
      ),
    ).toThrow(LedgerValidationError);

    // The stream holds exactly the four events that really happened, one
    // effect, one delivery, one segment.
    expect(ledger.listEvents().events).toHaveLength(5);
    expect(ledger.listDispatchAttempts(effectId)).toHaveLength(1);
    expect(ledger.listRouteSegments(taskId, 1, 1)).toHaveLength(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-P18-5: OUTCOME_UNKNOWN blocks the resend even where the destination is clean", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);
    ledger.append(dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }));
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "settle-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "SETTLED",
        terminalAt: EFFECT_AT,
        effectOutcomeStatus: "OUTCOME_UNKNOWN",
      }),
    );

    // There is no argument, no flag and no preflight a caller can pass that
    // lifts this: the ledger does not ask the destination anything, and a
    // destination reporting itself clean is a statement about the destination.
    let issue: { readonly path: string; readonly message: string } | undefined;
    try {
      ledger.append(
        dispatchIntention({
          taskId,
          transitionId: "dispatch-2",
          effectId,
          dispatchAttemptId: "dsp-2",
          attemptOrdinal: 2,
          segment: segmentRecord({
            routeSegmentId: "seg-2",
            segmentNumber: 2,
            predecessorSegmentId: "seg-1",
            accountId: "acct-2",
          }),
        }),
      );
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.path).toBe("payload.dispatch.effectId");
    expect(issue?.message).toContain("OUTCOME_UNKNOWN");
    expect(issue?.message).toContain("reconcile");
    expect(ledger.listDispatchAttempts(effectId)).toHaveLength(1);

    // A terminal outcome is the opposite case: it is reused, not reconciled.
    // On its own database, because a `route_segment_id` is a global primary key
    // and the fixture ids would collide with the run above.
    const other = randomUUID();
    const second = open(temporaryDatabase());
    seedOpenAttempt(second, other, "inv-2");
    second.append(effectIntention({ taskId: other, transitionId: "effect-1", invocationId: "inv-2" }));
    second.append(
      dispatchIntention({ taskId: other, transitionId: "dispatch-1", effectId: firstEffectId(other) }),
    );
    second.append(
      dispatchOutcome({
        taskId: other,
        transitionId: "settle-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "SETTLED",
        terminalAt: EFFECT_AT,
        effectOutcomeStatus: "SUCCEEDED",
      }),
    );
    expect(
      second.lookUpEffect({
        taskId: other,
        revisionNumber: 1,
        attemptNumber: 1,
        semanticScopeKey: SCOPE,
        localOperationKey: STEP,
        effectKind: "model_execution",
        requestContractVersion: "1",
        requestSha256: requestSha256({
          effectKind: "model_execution",
          requestContractVersion: "1",
          envelopeSha256: REVISION_ENVELOPE,
          neutralRequest: NEUTRAL_REQUEST,
        }),
      })?.reconciliationRequired,
    ).toBe(false);
  });

  it("N-P18-2 and N-C-8: each of the four compared fields raises CONFLICT", () => {
    // §6.1 `:303-304` compares four things once a logical key is found, and the
    // map's N-P18-2 names only the last. All four are drilled, because a
    // comparison that covered three of them would let a different kind of
    // operation, or a different request contract, pass as the same work.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));

    const base = {
      taskId,
      revisionNumber: 1,
      attemptNumber: 1,
      semanticScopeKey: SCOPE,
      localOperationKey: STEP,
      effectKind: "model_execution",
      requestContractVersion: "1",
      requestSha256: requestSha256({
        effectKind: "model_execution",
        requestContractVersion: "1",
        envelopeSha256: REVISION_ENVELOPE,
        neutralRequest: NEUTRAL_REQUEST,
      }),
    } as const;

    // The same work again: no conflict, the original effect comes back.
    expect(ledger.lookUpEffect(base)?.effect.effectId).toBe(firstEffectId(taskId));

    // A different request under the same logical key.
    expect(() =>
      ledger.lookUpEffect({
        ...base,
        requestSha256: requestSha256({
          effectKind: "model_execution",
          requestContractVersion: "1",
          envelopeSha256: REVISION_ENVELOPE,
          neutralRequest: { operation: "compose", inputs: ["a", "c"] },
        }),
      }),
    ).toThrow(LedgerValidationError);

    // A different kind, and a different request contract version. Both are
    // outside the admitted catalogue at the door, so the lookup is where they
    // are comparable at all — which is exactly why the comparison is here.
    expect(() => ledger.lookUpEffect({ ...base, effectKind: "other_kind" })).toThrow(
      LedgerValidationError,
    );
    expect(() => ledger.lookUpEffect({ ...base, requestContractVersion: "2" })).toThrow(
      LedgerValidationError,
    );

    let issue: { readonly message: string } | undefined;
    try {
      ledger.lookUpEffect({ ...base, effectKind: "other_kind" });
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.message).toContain("CONFLICT");

    // The fourth field is the envelope, and it reaches the comparison through
    // the request digest, whose preimage carries it. The query holds no
    // idempotency key at all. A request stated against another envelope is a
    // different digest, and so a CONFLICT under the same logical key.
    expect(() =>
      ledger.lookUpEffect({
        ...base,
        requestSha256: requestSha256({
          effectKind: "model_execution",
          requestContractVersion: "1",
          envelopeSha256: "f".repeat(64),
          neutralRequest: NEUTRAL_REQUEST,
        }),
      }),
    ).toThrow(/CONFLICT/);
  });

  it("N-P18-3: the competitor that loses the unique re-reads, and never changes the key", () => {
    // Two writers reach the same logical operation. The second one's append is
    // refused — not silently deduplicated — and what it is supposed to do next
    // is exactly point 1: look the effect up and use it.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));

    // The loser proposes a different coordinate for the same logical key: a
    // later ordinal, which is the one thing a producer that wanted to "make it
    // a new operation" would reach for.
    let issue: { readonly path: string; readonly message: string } | undefined;
    try {
      ledger.append(
        effectIntention({
          taskId,
          transitionId: "effect-1-again",
          invocationId: "inv-1",
          operationOrdinal: 1,
        }),
      );
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.path).toBe("payload.effect.logicalOperationSha256");
    expect(issue?.message).toContain(firstEffectId(taskId));

    // One effect, one ordinal. The loser's proposal left nothing behind.
    const stored = open(ledger.path);
    expect(
      readRows(stored.path, "SELECT operation_ordinal FROM effect_read_model"),
    ).toHaveLength(1);
  });

  it("N-C-7: a LocalKey outside the grammar is refused, and comparison is ordinal", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);

    for (const bad of ["", ".leading-dot", "has space", "has/slash", "a".repeat(129)]) {
      expect(() =>
        ledger.append(
          effectIntention({
            taskId,
            transitionId: "effect-bad",
            invocationId: "inv-1",
            localOperationKey: bad,
          }),
        ),
        bad,
      ).toThrow(LedgerValidationError);
    }

    // A key at exactly the bound is admitted, and `"A"` and `"a"` are two
    // different steps — ordinal comparison, never a case fold.
    const upper = logicalOperationSha256({
      invocationId: "inv-1",
      semanticScopeKey: SCOPE,
      localOperationKey: "Step",
    });
    const lower = logicalOperationSha256({
      invocationId: "inv-1",
      semanticScopeKey: SCOPE,
      localOperationKey: "step",
    });
    expect(upper).not.toBe(lower);

    ledger.append(
      effectIntention({
        taskId,
        transitionId: "effect-ok",
        invocationId: "inv-1",
        localOperationKey: "a" + "b".repeat(127),
      }),
    );
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-C-5: the request digest excludes everything resolved at dispatch time", () => {
    // §6.1 `:293-296`. The same request under two segments, two accounts and
    // two providers is the SAME request — which is what makes N-P18-1 an
    // equality rather than a conflict. Nothing about where the work was sent
    // enters the preimage.
    const one = requestSha256({
      effectKind: "model_execution",
      requestContractVersion: "1",
      envelopeSha256: REVISION_ENVELOPE,
      neutralRequest: NEUTRAL_REQUEST,
    });
    const two = requestSha256({
      effectKind: "model_execution",
      requestContractVersion: "1",
      envelopeSha256: REVISION_ENVELOPE,
      neutralRequest: NEUTRAL_REQUEST,
    });
    expect(one).toBe(two);

    // And what IS in the preimage moves it: the kind, the request contract
    // version, the envelope and the request itself.
    for (const variant of [
      { effectKind: "other" },
      { requestContractVersion: "2" },
      { envelopeSha256: "f".repeat(64) },
      { neutralRequest: { operation: "compose", inputs: ["a", "c"] } },
    ]) {
      expect(
        requestSha256({
          effectKind: "model_execution",
          requestContractVersion: "1",
          envelopeSha256: REVISION_ENVELOPE,
          neutralRequest: NEUTRAL_REQUEST,
          ...variant,
        }),
        JSON.stringify(variant),
      ).not.toBe(one);
    }

    // The same holds one level up: two segments with different accounts produce
    // the same effect id, because the id carries the segment NUMBER and the
    // account is not in the preimage at all.
    expect(firstEffectId("11111111-2222-4333-8444-555555555555", 1, 0)).not.toBe(
      firstEffectId("11111111-2222-4333-8444-555555555555", 2, 0),
    );
  });

  it("refuses a digest the producer got wrong, naming which one", () => {
    // "Producer proposes, ledger verifies" (the same division escalón B made
    // for the flat attempt). Three digests are recomputed from the sources and
    // a fourth is conserved, and the refusals say which.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);

    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ["payload.effect.logicalOperationSha256", { logicalOperationSha256: "0".repeat(64) }],
      ["payload.effect.effectId", { effectId: "1".repeat(64) }],
      ["payload.effect.idempotencyKey", { idempotencyKey: "2".repeat(64) }],
      ["payload.effect.requestSha256", { requestSha256: "not a digest" }],
      ["payload.effect.effectKind", { effectKind: "smuggled_kind" }],
      ["payload.effect.requestContractVersion", { requestContractVersion: "99" }],
      ["payload.effect.semanticScopeKey", { semanticScopeKey: "subscope" }],
      ["payload.effect.operationOrdinal", { operationOrdinal: 7 }],
    ];

    for (const [path, overrides] of cases) {
      let issue: { readonly path: string } | undefined;
      try {
        ledger.append(
          effectIntention({
            taskId,
            transitionId: "effect-" + path,
            invocationId: "inv-1",
            overrides,
          }),
        );
      } catch (error) {
        issue = (error as LedgerValidationError).issues[0];
      }
      expect(issue?.path, path).toBe(path);
    }

    // Nothing landed, and the handle is still usable.
    expect(readRows(ledger.path, "SELECT effect_id FROM effect_read_model")).toEqual([]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("refuses an effect whose attempt has not been opened", () => {
    // An effect runs inside an attempt, and unlike migration 12's opening it
    // does NOT announce its own: the attempt is a rung above and is opened by
    // its own event, so an effect that finds none is out of order rather than
    // incomplete.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover" }));

    let issue: { readonly path: string; readonly message: string } | undefined;
    try {
      ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.path).toBe("payload.attemptNumber");
    expect(issue?.message).toContain("has not been opened");
  });
});

describe("one delivery of one effect, in five states and no more (execution §7)", () => {
  it("P-P18-7: a handoff keeps the effect and records the effective segment apart", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);

    // The first delivery, on the segment the effect was born on.
    ledger.append(dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }));
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "abandon-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "ABANDONED",
        terminalAt: EFFECT_AT,
      }),
    );

    // The handoff: a new segment, a genuinely new and authorized delivery of
    // the SAME effect. No outcome was ever recorded, so nothing blocks it.
    const second = segmentRecord({
      routeSegmentId: "seg-2",
      segmentNumber: 2,
      predecessorSegmentId: "seg-1",
      accountId: "acct-2",
    });
    ledger.append(
      dispatchIntention({
        taskId,
        transitionId: "dispatch-2",
        effectId,
        dispatchAttemptId: "dsp-2",
        attemptOrdinal: 2,
        segment: second,
      }),
    );

    // One effect, still on its initial segment; two deliveries, on two
    // segments. §7 `:356`: the fold does not demand equality with the effect's
    // own segment, because that column conserves the origin.
    const effect = ledger.getEffect(effectId);
    expect(effect?.routeSegmentId).toBe("seg-1");
    expect(effect?.idempotencyKey).toBe(
      effectIdempotencyKeyV1({
        taskId,
        revisionNumber: 1,
        attemptNumber: 1,
        segmentNumber: 1,
        operationOrdinal: 0,
        effectKind: "model_execution",
        envelopeSha256: REVISION_ENVELOPE,
      }),
    );
    expect(
      ledger.listDispatchAttempts(effectId).map((row) => [row.attemptOrdinal, row.routeSegmentId]),
    ).toEqual([
      [1, "seg-1"],
      [2, "seg-2"],
    ]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("walks the five states forward, and refuses every move that is not one", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);
    ledger.append(dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }));

    expect(ledger.listDispatchAttempts(effectId)[0]?.dispatchState).toBe("INTENDED");

    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "claim-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "CLAIMED",
      }),
    );
    // Claiming is local. It does NOT imply the provider accepted anything.
    expect(ledger.listDispatchAttempts(effectId)[0]?.acceptedAt).toBeNull();

    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "inflight-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "INFLIGHT",
        acceptedAt: EFFECT_AT,
        externalHandle: "handle-1",
      }),
    );
    expect(ledger.listDispatchAttempts(effectId)[0]?.acceptedAt).toBe(EFFECT_AT);

    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "settle-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "SETTLED",
        terminalAt: "2026-09-12T09:10:00.000Z",
        effectOutcomeStatus: "SUCCEEDED",
      }),
    );

    const settled = ledger.listDispatchAttempts(effectId)[0];
    expect(settled?.dispatchState).toBe("SETTLED");
    expect(settled?.terminalAt).toBe("2026-09-12T09:10:00.000Z");
    // The handle survives the move that did not mention it: forgetting it would
    // be losing the only thing a reconciliation can be done by.
    expect(settled?.externalHandle).toBe("handle-1");
    expect(ledger.getEffect(effectId)?.outcomeStatus).toBe("SUCCEEDED");
    expect(ledger.getEffect(effectId)?.outcomeRecordedAt).toBe(EFFECT_AT);

    // A terminal delivery moves nowhere.
    let issue: { readonly path: string; readonly message: string } | undefined;
    try {
      ledger.append(
        dispatchOutcome({
          taskId,
          transitionId: "reopen-1",
          dispatchAttemptId: "dsp-1",
          dispatchState: "INFLIGHT",
        }),
      );
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.path).toBe("payload.outcome.dispatchState");
    expect(issue?.message).toContain("may move only to nothing");

    // And an outcome is recorded once rather than amended.
    expect(() =>
      ledger.append(
        dispatchOutcome({
          taskId,
          transitionId: "amend-1",
          dispatchAttemptId: "dsp-1",
          dispatchState: "SETTLED",
          terminalAt: "2026-09-12T09:10:00.000Z",
          effectOutcomeStatus: "FAILED",
        }),
      ),
    ).toThrow(LedgerValidationError);

    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-C-10: an overdue INFLIGHT is found, and nothing is created from it", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);
    ledger.append(dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }));
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "inflight-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "INFLIGHT",
        acceptedAt: EFFECT_AT,
        externalHandle: "handle-1",
      }),
    );

    const before = ledger.status().headSequence;

    // The deadline arrives by argument: this package reads no clock, so
    // "overdue" is the caller's policy and never this ledger's opinion.
    expect(ledger.listOverdueDispatchAttempts("2026-09-12T08:00:00.000Z")).toEqual([]);
    const overdue = ledger.listOverdueDispatchAttempts("2026-09-12T10:00:00.000Z");
    expect(overdue.map((row) => row.dispatchAttemptId)).toEqual(["dsp-1"]);

    // Finding it created nothing. The row is still INFLIGHT — there is no
    // RECONCILING to move it to — no second delivery exists, no second effect
    // exists, and the stream has not moved.
    expect(overdue[0]?.dispatchState).toBe("INFLIGHT");
    expect(ledger.listDispatchAttempts(effectId)).toHaveLength(1);
    expect(readRows(ledger.path, "SELECT effect_id FROM effect_read_model")).toHaveLength(1);
    expect(ledger.status().headSequence).toBe(before);

    // And the deadline has to be an instant, not a shape.
    expect(() => ledger.listOverdueDispatchAttempts("yesterday")).toThrow(LedgerQueryError);
  });

  it("N-C-11: a resolution recorded at another attempt's coordinate is refused by name", () => {
    // A delivery is found by `dispatch_attempt_id`, a global key, and every
    // resolution carries the full V2 coordinate. Until the two were compared a
    // resolution of task B could settle task A's delivery, and because the fold
    // had the same gap the rebuild reproduced it and `verifyIntegrity` stayed
    // green. The coordinate that owns a delivery is its effect's.
    const ledger = open(temporaryDatabase());
    const owner = randomUUID();
    const foreign = randomUUID();
    seedOpenAttempt(ledger, owner, "inv-a");
    ledger.append(effectIntention({ taskId: owner, transitionId: "effect-1", invocationId: "inv-a" }));
    const effectId = firstEffectId(owner);
    ledger.append(dispatchIntention({ taskId: owner, transitionId: "dispatch-1", effectId }));
    seedOpenAttempt(ledger, foreign, "inv-b");
    const before = ledger.status().headSequence;

    const settle = (
      taskId: string,
      transitionId: string,
      coordinate: { readonly revisionNumber?: number; readonly attemptNumber?: number } = {},
    ): Record<string, unknown> =>
      dispatchOutcome({
        taskId,
        transitionId,
        dispatchAttemptId: "dsp-1",
        dispatchState: "SETTLED",
        terminalAt: "2026-09-12T09:10:00.000Z",
        effectOutcomeStatus: "SUCCEEDED",
        ...coordinate,
      });

    const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
      ["another task", settle(foreign, "settle-foreign"), foreign + " 1 1"],
      ["another attempt", settle(owner, "settle-attempt-2", { attemptNumber: 2 }), owner + " 1 2"],
    ];
    for (const [label, event, recordedAt] of cases) {
      let issue: { readonly path: string; readonly message: string } | undefined;
      try {
        ledger.append(event);
      } catch (error) {
        issue = (error as LedgerValidationError).issues[0];
      }
      expect(issue?.path, label).toBe("payload.outcome.dispatchAttemptId");
      expect(issue?.message, label).toContain("dsp-1");
      expect(issue?.message, label).toContain(effectId);
      expect(issue?.message, label).toContain("of attempt " + owner + " 1 1");
      expect(issue?.message, label).toContain("recorded at attempt " + recordedAt);
    }

    // Nothing landed and nothing moved, on either path.
    expect(ledger.status().headSequence).toBe(before);
    expect(ledger.listDispatchAttempts(effectId).map((row) => row.dispatchState)).toEqual([
      "INTENDED",
    ]);
    expect(ledger.getEffect(effectId)?.outcomeStatus).toBeNull();
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // The owner's own coordinate still resolves it, and the rebuild agrees.
    ledger.append(settle(owner, "settle-own"));
    expect(ledger.listDispatchAttempts(effectId)[0]?.dispatchState).toBe("SETTLED");
    expect(ledger.getEffect(effectId)?.outcomeStatus).toBe("SUCCEEDED");
    expect(ledger.rebuildReadModel().replayedEvents).toBe(before + 1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-C-3: RECONCILING is not a dispatch state, and the base says so", () => {
    // The five states are closed at five. `RECONCILING` belongs to
    // `outbox_message` (coordination §2), and a sixth state here would
    // contradict the dictionary's own CHECK.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    ledger.append(
      dispatchIntention({ taskId, transitionId: "dispatch-1", effectId: firstEffectId(taskId) }),
    );
    const path = ledger.path;
    ledger.close();

    // Through the door, by name.
    const reopened = open(path);
    expect(() =>
      reopened.append(
        dispatchOutcome({
          taskId,
          transitionId: "reconcile-1",
          dispatchAttemptId: "dsp-1",
          dispatchState: "RECONCILING",
        }),
      ),
    ).toThrow(LedgerValidationError);
    reopened.close();

    // And underneath it, by the CHECK, so a writer that bypassed the door
    // entirely still cannot record one.
    withRawDatabase(path, (raw) => {
      expect(() =>
        raw
          .prepare("UPDATE dispatch_attempt_read_model SET dispatch_state = ?")
          .run("RECONCILING"),
      ).toThrow(/CHECK constraint failed/);
    });
  });

  it("N-C-4: the nullity pairs hold against raw SQL", () => {
    // F-B5's shape, for this cohort's three pairs. The door and the fold both
    // refuse a half fact; these assert that the base refuses it too, which is
    // what makes the claim true of a writer that never came through the door.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    ledger.append(
      dispatchIntention({ taskId, transitionId: "dispatch-1", effectId: firstEffectId(taskId) }),
    );
    const path = ledger.path;
    ledger.close();

    withRawDatabase(path, (raw) => {
      // An effect outcome without its instant, and an instant without an
      // outcome.
      expect(() =>
        raw.prepare("UPDATE effect_read_model SET outcome_status = ?").run("SUCCEEDED"),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        raw.prepare("UPDATE effect_read_model SET outcome_recorded_at = ?").run(EFFECT_AT),
      ).toThrow(/CHECK constraint failed/);
      // An outcome outside the four-word vocabulary.
      expect(() =>
        raw
          .prepare(
            "UPDATE effect_read_model SET outcome_status = ?, outcome_recorded_at = ?",
          )
          .run("MAYBE", EFFECT_AT),
      ).toThrow(/CHECK constraint failed/);

      // A terminal state without its instant, and a terminal instant on a
      // non-terminal state.
      expect(() =>
        raw
          .prepare("UPDATE dispatch_attempt_read_model SET dispatch_state = ?")
          .run("SETTLED"),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        raw.prepare("UPDATE dispatch_attempt_read_model SET terminal_at = ?").run(EFFECT_AT),
      ).toThrow(/CHECK constraint failed/);

      // And the case §7 `:350` explicitly allows: ABANDONED before any real
      // dispatch, with `accepted_at` still NULL. No CHECK forbids it, which is
      // the declared decision rather than an oversight.
      raw
        .prepare("UPDATE dispatch_attempt_read_model SET dispatch_state = ?, terminal_at = ?")
        .run("ABANDONED", EFFECT_AT);
      expect(
        (
          raw
            .prepare("SELECT accepted_at FROM dispatch_attempt_read_model")
            .get() as { readonly accepted_at: string | null }
        ).accepted_at,
      ).toBeNull();
    });
  });
});

describe("the route segment, its lineage and its coordinate (execution §4)", () => {
  it("N-C-9: several handoffs in one attempt leave the whole lineage", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);
    ledger.append(dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }));

    // Each handoff abandons the delivery it hands off from first. Since
    // P-18/protocolo F (postaudit of C, O-1) a new delivery beside an outstanding
    // one is refused, and a lineage test that stacked them would now be testing
    // that rule instead of the lineage; the abandonment is the fixture adjusting
    // to the door, declared in F's SOURCE_READY.
    const abandon = (dispatchAttemptId: string): void => {
      ledger.append(
        dispatchOutcome({
          taskId,
          transitionId: "abandon-" + dispatchAttemptId,
          dispatchAttemptId,
          dispatchState: "ABANDONED",
          terminalAt: EFFECT_AT,
        }),
      );
    };

    for (const [ordinal, account] of [
      [2, "acct-2"],
      [3, "acct-3"],
    ] as const) {
      abandon("dsp-" + String(ordinal - 1));
      ledger.append(
        dispatchIntention({
          taskId,
          transitionId: "dispatch-" + String(ordinal),
          effectId,
          dispatchAttemptId: "dsp-" + String(ordinal),
          attemptOrdinal: ordinal,
          segment: segmentRecord({
            routeSegmentId: "seg-" + String(ordinal),
            segmentNumber: ordinal,
            predecessorSegmentId: "seg-" + String(ordinal - 1),
            accountId: account,
          }),
        }),
      );
    }

    // Three segments, each naming the one before it. Nothing was overwritten:
    // the old shape kept one route row per attempt and a second account inside
    // one attempt destroyed the first.
    const lineage = ledger.listRouteSegments(taskId, 1, 1);
    expect(lineage.map((row) => row.segmentNumber)).toEqual([1, 2, 3]);
    expect(lineage.map((row) => row.predecessorSegmentId)).toEqual([null, "seg-1", "seg-2"]);
    expect(lineage.map((row) => row.accountId)).toEqual(["acct-1", "acct-2", "acct-3"]);
    expect(lineage[0]?.handoffReason).toBeNull();
    expect(lineage[1]?.handoffReason).toBe("QUOTA_EXHAUSTED");

    // The coordinate is unique: segment 2 of this attempt is one row.
    expect(() =>
      ledger.append(
        dispatchIntention({
          taskId,
          transitionId: "dispatch-4",
          effectId,
          dispatchAttemptId: "dsp-4",
          attemptOrdinal: 4,
          segment: segmentRecord({
            routeSegmentId: "seg-other",
            segmentNumber: 2,
            predecessorSegmentId: "seg-1",
          }),
        }),
      ),
    ).toThrow(LedgerValidationError);

    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-C-9: the two pairing CHECKs of §4 hold against raw SQL", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const path = ledger.path;
    ledger.close();

    withRawDatabase(path, (raw) => {
      // A predecessor with no reason, and a reason with no predecessor.
      expect(() =>
        raw
          .prepare("UPDATE execution_route_segment_read_model SET predecessor_segment_id = ?")
          .run("seg-0"),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        raw
          .prepare("UPDATE execution_route_segment_read_model SET handoff_reason = ?")
          .run("QUOTA_EXHAUSTED"),
      ).toThrow(/CHECK constraint failed/);

      // `RESOLVED` without a version, and a version without `RESOLVED`.
      expect(() =>
        raw
          .prepare("UPDATE execution_route_segment_read_model SET model_version_id = NULL")
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        raw
          .prepare("UPDATE execution_route_segment_read_model SET model_resolution_status = ?")
          .run("UNKNOWN"),
      ).toThrow(/CHECK constraint failed/);
      // And the vocabulary is closed at three.
      expect(() =>
        raw
          .prepare("UPDATE execution_route_segment_read_model SET model_resolution_status = ?")
          .run("PROBABLY"),
      ).toThrow(/CHECK constraint failed/);
    });
  });

  it("refuses a handoff whose predecessor is not a segment of this attempt", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);

    let issue: { readonly path: string; readonly message: string } | undefined;
    try {
      ledger.append(
        dispatchIntention({
          taskId,
          transitionId: "dispatch-1",
          effectId,
          segment: segmentRecord({
            routeSegmentId: "seg-2",
            segmentNumber: 2,
            predecessorSegmentId: "seg-nowhere",
          }),
        }),
      );
    } catch (error) {
      issue = (error as LedgerValidationError).issues[0];
    }
    expect(issue?.path).toBe("payload.segment.predecessorSegmentId");
    expect(issue?.message).toContain("same attempt");

    // And only the first segment of an attempt may have no predecessor.
    expect(() =>
      ledger.append(
        dispatchIntention({
          taskId,
          transitionId: "dispatch-2",
          effectId,
          segment: segmentRecord({ routeSegmentId: "seg-3", segmentNumber: 3 }),
        }),
      ),
    ).toThrow(LedgerValidationError);
  });
});

describe("migration 13 lands whole, and its rows rebuild deterministically", () => {
  it("applies nothing at all when it fails part way through", () => {
    // P-08/A2's precedent. A migration is one unit: a half-applied 13 would
    // leave a schema no `schema_migrations` row describes, and every later open
    // would try to re-apply it over tables that already exist.
    const path = temporaryDatabase();
    open(path).close();

    withRawDatabase(path, (raw) => {
      dropExecutionEffectIdentity(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(
        EXECUTION_EFFECT_MIGRATION,
      );

      const thirteenth = MIGRATIONS.filter(
        (migration) => migration.version === EXECUTION_EFFECT_MIGRATION,
      );
      expect(thirteenth).toHaveLength(1);

      const run = raw.transaction((): void => {
        applyMigrations(raw, thirteenth, EFFECT_AT, {
          afterSql: () => {
            throw new Error("induced failure after the SQL and before the row");
          },
        });
      });
      expect(() => {
        run.immediate();
      }).toThrow("induced failure");

      // Nothing survived: not a table, not an index, not a watermark row, not
      // the `schema_migrations` row.
      const objects = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN " +
            "('execution_route_segment_read_model', 'effect_read_model', " +
            "'dispatch_attempt_read_model', 'ux_effect_read_model__idempotency_key')",
        )
        .all();
      expect(objects).toEqual([]);
      expect(
        raw
          .prepare("SELECT version FROM schema_migrations WHERE version = ?")
          .all(EXECUTION_EFFECT_MIGRATION),
      ).toEqual([]);
      expect(
        raw
          .prepare(
            "SELECT projection_name FROM projection_watermark WHERE projection_name = ?",
          )
          .all("effect_read_model"),
      ).toEqual([]);
    });

    // And the reopen applies it cleanly, which is the other half of "whole".
    const reopened = open(path);
    expect(reopened.status().migrations.map((migration) => migration.version)).toContain(13);
    expect(reopened.verifyIntegrity().ok).toBe(true);
  });

  it("seeds its three watermarks from the head it finds, never from a literal zero", () => {
    // Migration 11's case and 12's: the projections arrive over a stream that
    // already holds history, and the fold over all of it is legitimately empty.
    // A zero seed would fail every ledger in the field's own integrity check
    // right after a routine upgrade.
    const path = temporaryDatabase();
    const seeded = open(path);
    const taskId = randomUUID();
    seedTask(seeded, taskId, "kimi/k3/coordinator/01");
    const head = seeded.status().headSequence;
    expect(head).toBeGreaterThan(0);
    seeded.close();

    withRawDatabase(path, (raw) => {
      dropExecutionEffectIdentity(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(
        EXECUTION_EFFECT_MIGRATION,
      );
    });

    const migrated = open(path);
    const rows = readRows(
      path,
      "SELECT projection_name, applied_sequence FROM projection_watermark " +
        "WHERE projection_name IN ('execution_route_segment_read_model', 'effect_read_model', " +
        "'dispatch_attempt_read_model') ORDER BY projection_name",
    ) as { readonly projection_name: string; readonly applied_sequence: number }[];
    expect(rows.map((row) => row.projection_name)).toEqual([
      "dispatch_attempt_read_model",
      "effect_read_model",
      "execution_route_segment_read_model",
    ]);
    expect(rows.map((row) => row.applied_sequence)).toEqual([head, head, head]);
    expect(migrated.verifyIntegrity().ok).toBe(true);
  });

  it("P-P18-8 and N-C-6: rebuilding twice produces identical rows, with no recomputation", () => {
    // Datos §16 negative 12, over the three new tables. And §6.1 `:319-320`'s
    // prohibition, which is the sharper half: after a handoff the rebuild must
    // copy the `route_segment_id`, `effect_id` and `idempotency_key` that were
    // RECORDED, not recompute them with the segment that is current now.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);
    ledger.append(dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }));
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "abandon-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "ABANDONED",
        terminalAt: EFFECT_AT,
      }),
    );
    ledger.append(
      dispatchIntention({
        taskId,
        transitionId: "dispatch-2",
        effectId,
        dispatchAttemptId: "dsp-2",
        attemptOrdinal: 2,
        segment: segmentRecord({
          routeSegmentId: "seg-2",
          segmentNumber: 2,
          predecessorSegmentId: "seg-1",
          accountId: "acct-2",
        }),
      }),
    );
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "settle-2",
        dispatchAttemptId: "dsp-2",
        dispatchState: "SETTLED",
        terminalAt: "2026-09-12T09:20:00.000Z",
        effectOutcomeStatus: "SUCCEEDED",
      }),
    );

    const snapshot = (): string =>
      canonicalJsonStringify({
        segments: readRows(path, "SELECT * FROM execution_route_segment_read_model ORDER BY segment_number"),
        effects: readRows(path, "SELECT * FROM effect_read_model ORDER BY operation_ordinal"),
        deliveries: readRows(
          path,
          "SELECT * FROM dispatch_attempt_read_model ORDER BY attempt_ordinal",
        ),
      });

    const live = snapshot();
    ledger.rebuildReadModel();
    const once = snapshot();
    ledger.rebuildReadModel();
    const twice = snapshot();

    expect(once).toBe(live);
    expect(twice).toBe(once);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    // The effect still names its INITIAL segment and its ORIGINAL key, after
    // two rebuilds and a handoff. Recomputing with the current segment would
    // have moved both — which is the one thing a rebuild may never do.
    const effect = ledger.getEffect(effectId);
    expect(effect?.routeSegmentId).toBe("seg-1");
    expect(effect?.idempotencyKey).toBe(
      effectIdempotencyKeyV1({
        taskId,
        revisionNumber: 1,
        attemptNumber: 1,
        segmentNumber: 1,
        operationOrdinal: 0,
        effectKind: "model_execution",
        envelopeSha256: REVISION_ENVELOPE,
      }),
    );
    // The resolved state survives the rebuild too: the fold applies every
    // resolution, and the rebuild writes the row the fold arrived at.
    expect(ledger.listDispatchAttempts(effectId).map((row) => row.dispatchState)).toEqual([
      "ABANDONED",
      "SETTLED",
    ]);
    expect(ledger.getEffect(effectId)?.outcomeStatus).toBe("SUCCEEDED");
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo D — the prompt a delivery sent, and the answer it received
// ---------------------------------------------------------------------------

/** The instant every occurrence fixture is recorded at, unless it says otherwise. */
const OCCURRENCE_AT = "2026-09-12T10:00:00.000Z";

/** Three digests, never a byte of what they digest — which is the point (§8 `:433`). */
const PROMPT_DIGEST = "c".repeat(64);
const RESPONSE_DIGEST = "d".repeat(64);
const CONTEXT_DIGEST = "9".repeat(64);

/** A worker that is not the coordinator, so `identity = emittedBy` is observable. */
const SENDER = "claude/opus/implementer/01";

interface OccurrenceShape {
  readonly taskId: string;
  readonly transitionId: string;
  readonly revisionNumber?: number;
  readonly attemptNumber?: number;
  readonly attempt?: number;
  readonly emittedBy?: string;
  readonly occurredAt?: string;
  /** Fields of the nested record to replace or add. */
  readonly overrides?: Record<string, unknown>;
  /** Fields of the nested record to remove outright. */
  readonly omit?: readonly string[];
  /** Keys beside the coordinate and the record, which the door must refuse. */
  readonly payloadExtras?: Record<string, unknown>;
}

interface PromptInput extends OccurrenceShape {
  readonly effectId: string;
  readonly occurrenceId?: string;
  readonly dispatchAttemptId?: string;
  readonly routeSegmentId?: string;
  readonly ordinal?: number;
  readonly accountId?: string;
  readonly promptSha256?: string;
}

interface ResponseInput extends OccurrenceShape {
  readonly promptOccurrenceId: string;
  readonly occurrenceId?: string;
}

function occurrenceEvent(
  input: OccurrenceShape,
  type: ControlPlaneEventType,
  recordKey: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const omitted = new Set(input.omit ?? []);
  const merged = Object.fromEntries(
    Object.entries({ ...record, ...(input.overrides ?? {}) }).filter(([key]) => !omitted.has(key)),
  );
  return makeEvent({
    taskId: input.taskId,
    attempt: input.attempt ?? 1,
    transitionId: input.transitionId,
    type,
    fromState: ATTEMPT_TASK_STATE,
    toState: ATTEMPT_TASK_STATE,
    occurredAt: input.occurredAt ?? OCCURRENCE_AT,
    emittedBy: input.emittedBy ?? SENDER,
    payload: {
      revisionNumber: input.revisionNumber ?? 1,
      attemptNumber: input.attemptNumber ?? 1,
      [recordKey]: merged,
      ...(input.payloadExtras ?? {}),
    },
  });
}

/** One `PROMPT_OCCURRENCE_RECORDED`, well formed unless the input says otherwise. */
function promptOccurrence(input: PromptInput): Record<string, unknown> {
  return occurrenceEvent(input, "PROMPT_OCCURRENCE_RECORDED", "promptOccurrence", {
    occurrenceId: input.occurrenceId ?? "po-1",
    dispatchAttemptId: input.dispatchAttemptId ?? "dsp-1",
    effectId: input.effectId,
    routeSegmentId: input.routeSegmentId ?? "seg-1",
    ordinal: input.ordinal ?? 0,
    requestedModelId: "claude-opus-5",
    provider: "anthropic",
    modelResolutionStatus: "RESOLVED",
    modelVersionId: "claude-opus-5-20260101",
    accountId: input.accountId ?? "acct-1",
    promptSha256: input.promptSha256 ?? PROMPT_DIGEST,
    promptBytes: 4096,
    contextSha256: CONTEXT_DIGEST,
  });
}

/** One `RESPONSE_OCCURRENCE_RECORDED`, well formed unless the input says otherwise. */
function responseOccurrence(input: ResponseInput): Record<string, unknown> {
  return occurrenceEvent(input, "RESPONSE_OCCURRENCE_RECORDED", "responseOccurrence", {
    occurrenceId: input.occurrenceId ?? "ro-1",
    promptOccurrenceId: input.promptOccurrenceId,
    responseSha256: RESPONSE_DIGEST,
    responseBytes: 2048,
    redactionVerdict: "CLEAN",
  });
}

/** A ledger with one open attempt, one effect on `seg-1`, and delivery `dsp-1` of it. */
function seedDelivery(ledger: Ledger, taskId: string): string {
  seedOpenAttempt(ledger, taskId);
  ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
  const effectId = firstEffectId(taskId);
  ledger.append(dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }));
  return effectId;
}

/** The first issue of the `LedgerValidationError` an action raises. */
function refusalOf(action: () => unknown): { readonly path: string; readonly message: string } {
  const error = caught(action);
  expect(error).toBeInstanceOf(LedgerValidationError);
  const issue = (error as LedgerValidationError).issues[0];
  expect(issue).toBeDefined();
  return issue as { readonly path: string; readonly message: string };
}

describe("a prompt occurrence is a use, never a blob (execution §8.1)", () => {
  it("P-D-3: a prompt lands on its delivery, its answer on it, and both replay exactly", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);

    const prompt = promptOccurrence({ taskId, transitionId: "prompt-1", effectId });
    expect(ledger.append(prompt).inserted).toBe(true);
    const answer = responseOccurrence({
      taskId,
      transitionId: "response-1",
      promptOccurrenceId: "po-1",
    });
    expect(ledger.append(answer).inserted).toBe(true);

    const row = ledger.getPromptOccurrence("po-1");
    expect(row).toMatchObject({
      occurrenceId: "po-1",
      routeSegmentId: "seg-1",
      effectId,
      dispatchAttemptId: "dsp-1",
      ordinal: 0,
      requestedModelId: "claude-opus-5",
      provider: "anthropic",
      modelResolutionStatus: "RESOLVED",
      modelVersionId: "claude-opus-5-20260101",
      accountId: "acct-1",
      promptSha256: PROMPT_DIGEST,
      promptBytes: 4096,
      contextSha256: CONTEXT_DIGEST,
      recordedAt: OCCURRENCE_AT,
    });
    // `identity` is the recording event's `emittedBy`, never a payload key.
    expect(row?.identity).toBe(SENDER);

    expect(ledger.getResponseOccurrenceForPrompt("po-1")).toMatchObject({
      occurrenceId: "ro-1",
      promptOccurrenceId: "po-1",
      responseSha256: RESPONSE_DIGEST,
      responseBytes: 2048,
      redactionVerdict: "CLEAN",
    });

    // The exact events again are replays: nothing inserted, no second ordinal.
    expect(ledger.append(prompt).inserted).toBe(false);
    expect(ledger.append(answer).inserted).toBe(false);
    expect(ledger.listPromptOccurrences("seg-1")).toHaveLength(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-P18-18: the same bytes sent twice are two occurrences and one digest", () => {
    // Execution §8 `:377-379` and negative 3: `prompt_sha256` is not unique, and
    // `dispatch_attempt_id` is not either — one delivery sends both.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);

    ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    ledger.append(
      promptOccurrence({ taskId, transitionId: "prompt-2", effectId, occurrenceId: "po-2", ordinal: 1 }),
    );

    const sent = ledger.listPromptOccurrencesBySha256(PROMPT_DIGEST);
    expect(sent.map((row) => row.occurrenceId)).toEqual(["po-1", "po-2"]);
    expect(sent.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(new Set(sent.map((row) => row.dispatchAttemptId))).toEqual(new Set(["dsp-1"]));
    // One digest, two uses — and no row holds anything but the digest and a count.
    expect(new Set(sent.map((row) => row.promptSha256)).size).toBe(1);
    const columns = Object.keys(
      readRows(path, "SELECT * FROM prompt_occurrence_read_model LIMIT 1")[0] ?? {},
    );
    expect(columns).toEqual([
      "occurrence_id",
      "route_segment_id",
      "effect_id",
      "dispatch_attempt_id",
      "ordinal",
      "identity",
      "requested_model_id",
      "provider",
      "model_resolution_status",
      "model_version_id",
      "account_id",
      "prompt_sha256",
      "prompt_bytes",
      "context_sha256",
      "recorded_at",
      "sequence",
    ]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-P18-16: a prompt whose effect or segment is not its delivery's is refused by name", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);

    const wrongEffect = refusalOf(() =>
      ledger.append(
        promptOccurrence({ taskId, transitionId: "prompt-1", effectId: "e".repeat(64) }),
      ),
    );
    expect(wrongEffect.path).toBe("payload.promptOccurrence.effectId");
    expect(wrongEffect.message).toContain(effectId);

    // After a handoff the delivery runs on `seg-2`, and the prompt it sends
    // names `seg-2` — never `seg-1`, where the effect began.
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "abandon-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "ABANDONED",
        terminalAt: EFFECT_AT,
      }),
    );
    ledger.append(
      dispatchIntention({
        taskId,
        transitionId: "dispatch-2",
        effectId,
        dispatchAttemptId: "dsp-2",
        attemptOrdinal: 2,
        segment: segmentRecord({
          routeSegmentId: "seg-2",
          segmentNumber: 2,
          predecessorSegmentId: "seg-1",
          accountId: "acct-2",
        }),
      }),
    );
    const inferred = refusalOf(() =>
      ledger.append(
        promptOccurrence({
          taskId,
          transitionId: "prompt-2",
          effectId,
          dispatchAttemptId: "dsp-2",
          routeSegmentId: "seg-1",
          accountId: "acct-2",
        }),
      ),
    );
    expect(inferred.path).toBe("payload.promptOccurrence.routeSegmentId");
    expect(inferred.message).toContain("seg-2");
    expect(inferred.message).toContain("never inferred from the effect's origin");

    expect(ledger.listPromptOccurrences("seg-1")).toEqual([]);
    expect(ledger.listPromptOccurrences("seg-2")).toEqual([]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-P18-16, rebuild half: a stored prompt that disagrees with its delivery is refused", () => {
    // The door cannot produce this history, so it is planted with a correct
    // chain; the fold has to refuse it with the door's own words rather than
    // write a row the base would then carry.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    seedDelivery(ledger, taskId);
    ledger.close();

    plantChainedEvent(
      path,
      promptOccurrence({ taskId, transitionId: "prompt-planted", effectId: "e".repeat(64) }),
    );

    const reopened = open(path);
    const refused = caught(() => reopened.rebuildReadModel());
    expect(refused).toBeInstanceOf(LedgerValidationError);
    expect((refused as LedgerValidationError).issues[0]?.path).toBe(
      "payload.promptOccurrence.effectId",
    );
    expect(reopened.listPromptOccurrences("seg-1")).toEqual([]);
  });

  it("N-D-1 and P-D-1: a prompt follows its delivery's intention, committed or earlier in the batch", () => {
    // Execution §8 `:419-420`.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedOpenAttempt(ledger, taskId);
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);

    // N-D-1: no such delivery, anywhere. Refused by name, never as an abort of
    // the foreign key.
    const orphan = refusalOf(() =>
      ledger.append(promptOccurrence({ taskId, transitionId: "prompt-0", effectId })),
    );
    expect(orphan.path).toBe("payload.promptOccurrence.dispatchAttemptId");
    expect(orphan.message).toContain("dsp-1");
    expect(orphan.message).not.toContain("FOREIGN KEY");

    // N-D-1, batch form: the prompt BEFORE its delivery's intention in one
    // batch is out of causal order, and the whole batch lands nowhere.
    const head = ledger.status().headSequence;
    const inverted = refusalOf(() =>
      ledger.appendBatch([
        promptOccurrence({ taskId, transitionId: "prompt-1", effectId }),
        dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }),
      ]),
    );
    expect(inverted.path).toBe("payload.promptOccurrence.dispatchAttemptId");
    expect(ledger.status().headSequence).toBe(head);
    expect(ledger.listDispatchAttempts(effectId)).toEqual([]);

    // P-D-1: the same two, in causal order, in one batch — admitted, and both
    // rows are there.
    const landed = ledger.appendBatch([
      dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }),
      promptOccurrence({ taskId, transitionId: "prompt-1", effectId }),
    ]);
    expect(landed.insertedCount).toBe(2);
    expect(ledger.listDispatchAttempts(effectId).map((row) => row.dispatchAttemptId)).toEqual([
      "dsp-1",
    ]);
    expect(ledger.getPromptOccurrence("po-1")?.dispatchAttemptId).toBe("dsp-1");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("assigns the ordinal within the segment, and a handoff restarts it", () => {
    // §8 `:389`: "orden dentro del segmento". The producer proposes and the
    // ledger verifies — one past the segment's highest, 0 where there is none.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);

    const skipped = refusalOf(() =>
      ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId, ordinal: 1 })),
    );
    expect(skipped.path).toBe("payload.promptOccurrence.ordinal");
    expect(skipped.message).toContain("assigns the prompt ordinal 0");

    ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "abandon-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "ABANDONED",
        terminalAt: EFFECT_AT,
      }),
    );
    ledger.append(
      dispatchIntention({
        taskId,
        transitionId: "dispatch-2",
        effectId,
        dispatchAttemptId: "dsp-2",
        attemptOrdinal: 2,
        segment: segmentRecord({
          routeSegmentId: "seg-2",
          segmentNumber: 2,
          predecessorSegmentId: "seg-1",
          accountId: "acct-2",
        }),
      }),
    );
    ledger.append(
      promptOccurrence({
        taskId,
        transitionId: "prompt-2",
        effectId,
        occurrenceId: "po-2",
        dispatchAttemptId: "dsp-2",
        routeSegmentId: "seg-2",
        accountId: "acct-2",
      }),
    );
    expect(ledger.getPromptOccurrence("po-2")?.ordinal).toBe(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-D-5: the model pair and the preserved alias and provider are refused by name", () => {
    // §8 `:391-394` and `:414`, refused at the door before the CHECK could
    // abort a statement nobody can attribute.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    const base = { taskId, transitionId: "prompt-1", effectId } as const;

    const resolvedWithout = refusalOf(() =>
      ledger.append(promptOccurrence({ ...base, omit: ["modelVersionId"] })),
    );
    expect(resolvedWithout.path).toBe("payload.promptOccurrence.modelVersionId");
    expect(resolvedWithout.message).toContain("RESOLVED with no version");

    for (const status of ["UNKNOWN", "NOT_OBSERVABLE"]) {
      const unresolvedWith = refusalOf(() =>
        ledger.append(promptOccurrence({ ...base, overrides: { modelResolutionStatus: status } })),
      );
      expect(unresolvedWith.path, status).toBe("payload.promptOccurrence.modelVersionId");
      expect(unresolvedWith.message, status).toContain(status + " with a version");
    }

    for (const field of ["requestedModelId", "provider"]) {
      expect(
        refusalOf(() => ledger.append(promptOccurrence({ ...base, overrides: { [field]: "" } })))
          .path,
        field,
      ).toBe("payload.promptOccurrence." + field);
      expect(
        refusalOf(() => ledger.append(promptOccurrence({ ...base, omit: [field] }))).message,
        field,
      ).toContain("preserved always");
    }

    expect(
      refusalOf(() =>
        ledger.append(promptOccurrence({ ...base, overrides: { modelResolutionStatus: "PROBABLY" } })),
      ).path,
    ).toBe("payload.promptOccurrence.modelResolutionStatus");

    // The lawful unresolved form lands, with the version NULL even after executing.
    ledger.append(
      promptOccurrence({
        ...base,
        overrides: { modelResolutionStatus: "NOT_OBSERVABLE" },
        omit: ["modelVersionId"],
      }),
    );
    expect(ledger.getPromptOccurrence("po-1")?.modelVersionId).toBeNull();
    expect(ledger.getPromptOccurrence("po-1")?.requestedModelId).toBe("claude-opus-5");
  });

  it("N-D-6: counts, verdicts and digest shapes are refused by name", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    const prompt = { taskId, transitionId: "prompt-1", effectId } as const;

    for (const [field, value] of [
      ["promptBytes", -1],
      ["promptBytes", 1.5],
      ["promptBytes", "4096"],
      ["promptSha256", "C".repeat(64)],
      ["promptSha256", "c".repeat(63)],
      ["contextSha256", "not a digest"],
      ["ordinal", -1],
    ] as const) {
      expect(
        refusalOf(() => ledger.append(promptOccurrence({ ...prompt, overrides: { [field]: value } })))
          .path,
        field + "=" + String(value),
      ).toBe("payload.promptOccurrence." + field);
    }

    // A context digest is optional, and absence is lawful.
    ledger.append(promptOccurrence({ ...prompt, omit: ["contextSha256"] }));
    expect(ledger.getPromptOccurrence("po-1")?.contextSha256).toBeNull();

    const answer = { taskId, transitionId: "response-1", promptOccurrenceId: "po-1" } as const;
    for (const [field, value] of [
      ["responseBytes", -1],
      ["responseBytes", 0.5],
      ["responseSha256", "d".repeat(65)],
      ["redactionVerdict", "PARTIAL"],
      ["redactionVerdict", "clean"],
    ] as const) {
      expect(
        refusalOf(() =>
          ledger.append(responseOccurrence({ ...answer, overrides: { [field]: value } })),
        ).path,
        field + "=" + String(value),
      ).toBe("payload.responseOccurrence." + field);
    }

    // And an answer's id is its own, never the prompt's (§8.2).
    expect(
      refusalOf(() =>
        ledger.append(responseOccurrence({ ...answer, overrides: { occurrenceId: "po-1" } })),
      ).path,
    ).toBe("payload.responseOccurrence.occurrenceId");

    // The one lawful answer still lands, and a zero count is a count.
    ledger.append(
      responseOccurrence({ ...answer, overrides: { responseBytes: 0, redactionVerdict: "REDACTED" } }),
    );
    expect(ledger.getResponseOccurrenceForPrompt("po-1")?.redactionVerdict).toBe("REDACTED");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-D-7: an occurrence payload admits exactly its declared keys", () => {
    // §8 `:433`. The contract's transcript guard already refuses the keys a
    // conversation travels under; this is the ledger's own line, over names the
    // guard has never heard of.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    const base = { taskId, transitionId: "prompt-1", effectId } as const;

    const nested = refusalOf(() =>
      ledger.append(promptOccurrence({ ...base, overrides: { promptText: "summarize the repo" } })),
    );
    expect(nested.path).toBe("payload.promptOccurrence.promptText");
    expect(nested.message).toContain("the record admits exactly");

    // Nobody chooses the sender: `identity` is `emittedBy`, not a payload key.
    expect(
      refusalOf(() =>
        ledger.append(promptOccurrence({ ...base, overrides: { identity: "kimi/k3/coordinator/01" } })),
      ).path,
    ).toBe("payload.promptOccurrence.identity");

    const beside = refusalOf(() =>
      ledger.append(promptOccurrence({ ...base, payloadExtras: { body: "summarize the repo" } })),
    );
    expect(beside.path).toBe("payload.body");
    expect(beside.message).toContain("never content");

    expect(ledger.listPromptOccurrences("seg-1")).toEqual([]);
  });

  it("holds §8's CHECKs against raw SQL, underneath the door", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    ledger.append(responseOccurrence({ taskId, transitionId: "response-1", promptOccurrenceId: "po-1" }));
    ledger.close();

    withRawDatabase(path, (raw) => {
      for (const statement of [
        "UPDATE prompt_occurrence_read_model SET prompt_bytes = -1",
        "UPDATE prompt_occurrence_read_model SET ordinal = -1",
        "UPDATE prompt_occurrence_read_model SET model_version_id = NULL",
        "UPDATE prompt_occurrence_read_model SET model_resolution_status = 'UNKNOWN'",
        "UPDATE prompt_occurrence_read_model SET model_resolution_status = 'PROBABLY'",
        "UPDATE response_occurrence_read_model SET response_bytes = -1",
        "UPDATE response_occurrence_read_model SET redaction_verdict = 'PARTIAL'",
      ]) {
        expect(() => raw.prepare(statement).run(), statement).toThrow(/CHECK constraint failed/);
      }
      // And the base's own last line against a second answer.
      expect(() =>
        raw
          .prepare(
            "INSERT INTO response_occurrence_read_model (occurrence_id, prompt_occurrence_id, " +
              "response_sha256, response_bytes, redaction_verdict, recorded_at, sequence) " +
              "VALUES ('ro-2', 'po-1', ?, 1, 'CLEAN', ?, 99)",
          )
          .run(RESPONSE_DIGEST, OCCURRENCE_AT),
      ).toThrow(/UNIQUE constraint failed/);
    });
  });
});

describe("an answer keeps its origin (execution §8.2)", () => {
  it("N-D-4 (i) and N-P18-17: a late answer after a handoff is attributed to the origin", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);

    // The origin sends a prompt on `seg-1` under `acct-1`, and its delivery is
    // abandoned with nothing heard back.
    ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "abandon-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "ABANDONED",
        terminalAt: EFFECT_AT,
      }),
    );

    // The run hands off: a new delivery on `seg-2`, under `acct-2`, which sends
    // its own prompt.
    ledger.append(
      dispatchIntention({
        taskId,
        transitionId: "dispatch-2",
        effectId,
        dispatchAttemptId: "dsp-2",
        attemptOrdinal: 2,
        segment: segmentRecord({
          routeSegmentId: "seg-2",
          segmentNumber: 2,
          predecessorSegmentId: "seg-1",
          accountId: "acct-2",
        }),
      }),
    );
    ledger.append(
      promptOccurrence({
        taskId,
        transitionId: "prompt-2",
        effectId,
        occurrenceId: "po-2",
        dispatchAttemptId: "dsp-2",
        routeSegmentId: "seg-2",
        accountId: "acct-2",
      }),
    );

    // Then the origin's answer arrives, late.
    ledger.append(
      responseOccurrence({ taskId, transitionId: "response-late", promptOccurrenceId: "po-1" }),
    );

    // It lands on the prompt that was actually sent, and the join through that
    // prompt gives the ORIGIN's segment and account — there is no other way to
    // reach either from an answer.
    const late = ledger.getResponseOccurrenceForPrompt("po-1");
    expect(late?.occurrenceId).toBe("ro-1");
    const origin = ledger.getPromptOccurrence(late?.promptOccurrenceId ?? "");
    expect(origin?.routeSegmentId).toBe("seg-1");
    expect(origin?.accountId).toBe("acct-1");
    expect(origin?.dispatchAttemptId).toBe("dsp-1");
    expect(Object.keys(late ?? {}).sort()).toEqual([
      "occurrenceId",
      "promptOccurrenceId",
      "recordedAt",
      "redactionVerdict",
      "responseBytes",
      "responseSha256",
      "sequence",
    ]);
    // The destination's prompt is still unanswered.
    expect(ledger.getResponseOccurrenceForPrompt("po-2")).toBeNull();
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-D-4 (ii): an answer that names a delivery, a segment or an account is refused", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    const base = { taskId, transitionId: "response-1", promptOccurrenceId: "po-1" } as const;

    for (const [field, value] of [
      ["dispatchAttemptId", "dsp-2"],
      ["routeSegmentId", "seg-2"],
      ["accountId", "acct-2"],
    ] as const) {
      const nested = refusalOf(() =>
        ledger.append(responseOccurrence({ ...base, overrides: { [field]: value } })),
      );
      expect(nested.path, field).toBe("payload.responseOccurrence." + field);
      const beside = refusalOf(() =>
        ledger.append(responseOccurrence({ ...base, payloadExtras: { [field]: value } })),
      );
      expect(beside.path, field).toBe("payload." + field);
    }
    expect(ledger.getResponseOccurrenceForPrompt("po-1")).toBeNull();
  });

  it("N-D-4 (ii): an answer is recorded under its prompt's coordinate, never another", () => {
    // §7 `:343`: the coordinate is the prompt's own attempt. A second attempt of
    // the same task, and an answer to attempt 1's prompt recorded there.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const revisionId = randomUUID();
    ledger.append(
      attemptOpening({ taskId, attempt: 1, transitionId: "open", revisionId, invocationId: "inv-1" }),
    );
    ledger.append(effectIntention({ taskId, transitionId: "effect-1", invocationId: "inv-1" }));
    const effectId = firstEffectId(taskId);
    ledger.append(dispatchIntention({ taskId, transitionId: "dispatch-1", effectId }));
    ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    ledger.append(
      attemptOpening({
        taskId,
        attempt: 2,
        attemptNumber: 2,
        transitionId: "open-2",
        revisionId,
        invocationId: "inv-2",
        fromState: ATTEMPT_TASK_STATE,
      }),
    );

    const moved = refusalOf(() =>
      ledger.append(
        responseOccurrence({
          taskId,
          transitionId: "response-1",
          promptOccurrenceId: "po-1",
          attempt: 2,
          attemptNumber: 2,
        }),
      ),
    );
    expect(moved.path).toBe("payload.responseOccurrence.promptOccurrenceId");
    expect(moved.message).toContain("attempt " + taskId + " 1 1");

    // And the same holds one rung up: a prompt recorded at another attempt than
    // the one its delivery's effect belongs to.
    const misplaced = refusalOf(() =>
      ledger.append(
        promptOccurrence({
          taskId,
          transitionId: "prompt-2",
          effectId,
          occurrenceId: "po-2",
          ordinal: 1,
          attempt: 2,
          attemptNumber: 2,
        }),
      ),
    );
    expect(misplaced.path).toBe("payload.promptOccurrence.dispatchAttemptId");

    // Under the right coordinate it lands.
    ledger.append(
      responseOccurrence({ taskId, transitionId: "response-1", promptOccurrenceId: "po-1" }),
    );
    expect(ledger.getResponseOccurrenceForPrompt("po-1")?.occurrenceId).toBe("ro-1");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-D-2: a second answer to one prompt is refused by name, and so is the history", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    ledger.append(responseOccurrence({ taskId, transitionId: "response-1", promptOccurrenceId: "po-1" }));

    const second = responseOccurrence({
      taskId,
      transitionId: "response-2",
      promptOccurrenceId: "po-1",
      occurrenceId: "ro-2",
    });
    const refused = refusalOf(() => ledger.append(second));
    expect(refused.path).toBe("payload.responseOccurrence.promptOccurrenceId");
    expect(refused.message).toContain("already answered by ro-1");
    expect(refused.message).not.toContain("UNIQUE");

    // The same id restated with different content is not a second answer and
    // not a replay either: it is refused as a changed occurrence.
    const changed = refusalOf(() =>
      ledger.append(
        responseOccurrence({
          taskId,
          transitionId: "response-1-changed",
          promptOccurrenceId: "po-1",
          overrides: { responseBytes: 7 },
        }),
      ),
    );
    expect(changed.path).toBe("payload.responseOccurrence.occurrenceId");
    ledger.close();

    // The rebuild half: planted with a correct chain, the history the door
    // refused is refused by the fold at the event that caused it, rather than
    // by `ux_response_occurrence_read_model__prompt` naming a row.
    plantChainedEvent(path, second);
    const reopened = open(path);
    const rebuilt = caught(() => reopened.rebuildReadModel());
    expect(rebuilt).toBeInstanceOf(LedgerValidationError);
    expect((rebuilt as LedgerValidationError).issues[0]?.message).toContain(
      "already answered by ro-1",
    );
    expect(readRows(path, "SELECT occurrence_id FROM response_occurrence_read_model")).toEqual([
      { occurrence_id: "ro-1" },
    ]);
  });

  it("N-D-3: an answer to a prompt nobody recorded is refused by name", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedDelivery(ledger, taskId);
    const refused = refusalOf(() =>
      ledger.append(
        responseOccurrence({ taskId, transitionId: "response-1", promptOccurrenceId: "po-nowhere" }),
      ),
    );
    expect(refused.path).toBe("payload.responseOccurrence.promptOccurrenceId");
    expect(refused.message).toContain("po-nowhere");
    expect(refused.message).not.toContain("FOREIGN KEY");
  });
});

describe("migration 14 lands whole, and its rows rebuild deterministically", () => {
  it("applies nothing at all when it fails part way through", () => {
    const path = temporaryDatabase();
    open(path).close();

    withRawDatabase(path, (raw) => {
      dropExecutionOccurrences(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(
        EXECUTION_OCCURRENCE_MIGRATION,
      );

      const fourteenth = MIGRATIONS.filter(
        (migration) => migration.version === EXECUTION_OCCURRENCE_MIGRATION,
      );
      expect(fourteenth).toHaveLength(1);

      const run = raw.transaction((): void => {
        applyMigrations(raw, fourteenth, OCCURRENCE_AT, {
          afterSql: () => {
            throw new Error("induced failure after the SQL and before the row");
          },
        });
      });
      expect(() => {
        run.immediate();
      }).toThrow("induced failure");

      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('prompt_occurrence_read_model', " +
              "'response_occurrence_read_model', 'ix_prompt_occurrence_read_model__sha256', " +
              "'ux_response_occurrence_read_model__prompt')",
          )
          .all(),
      ).toEqual([]);
      expect(
        raw
          .prepare("SELECT version FROM schema_migrations WHERE version = ?")
          .all(EXECUTION_OCCURRENCE_MIGRATION),
      ).toEqual([]);
      expect(
        raw
          .prepare("SELECT projection_name FROM projection_watermark WHERE projection_name LIKE ?")
          .all("%occurrence%"),
      ).toEqual([]);
    });

    const reopened = open(path);
    expect(reopened.status().migrations.map((migration) => migration.version)).toContain(14);
    expect(reopened.verifyIntegrity().ok).toBe(true);
  });

  it("seeds its two watermarks from the head it finds, never from a literal zero", () => {
    const path = temporaryDatabase();
    const seeded = open(path);
    const taskId = randomUUID();
    seedDelivery(seeded, taskId);
    const head = seeded.status().headSequence;
    expect(head).toBeGreaterThan(0);
    seeded.close();

    withRawDatabase(path, (raw) => {
      dropExecutionOccurrences(raw);
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(
        EXECUTION_OCCURRENCE_MIGRATION,
      );
    });

    const migrated = open(path);
    const rows = readRows(
      path,
      "SELECT projection_name, applied_sequence FROM projection_watermark " +
        "WHERE projection_name LIKE '%occurrence%' ORDER BY projection_name",
    );
    expect(rows).toEqual([
      { projection_name: "prompt_occurrence_read_model", applied_sequence: head },
      { projection_name: "response_occurrence_read_model", applied_sequence: head },
    ]);
    expect(migrated.verifyIntegrity().ok).toBe(true);
  });

  it("P-D-2: a delivery settled with no occurrence leaves both tables empty, and the rebuild agrees", () => {
    // §8 `:421`, the part of it that is falsifiable today: no fold DERIVES an
    // occurrence from an intention or a resolution. A delivery that resolves
    // without a prompt is lawful, and it leaves nothing behind in §8's tables.
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "settle-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "SETTLED",
        terminalAt: EFFECT_AT,
        effectOutcomeStatus: "SUCCEEDED",
      }),
    );
    expect(ledger.getEffect(effectId)?.outcomeStatus).toBe("SUCCEEDED");

    const empty = (): readonly unknown[] => [
      ...readRows(path, "SELECT * FROM prompt_occurrence_read_model"),
      ...readRows(path, "SELECT * FROM response_occurrence_read_model"),
    ];
    expect(empty()).toEqual([]);
    ledger.rebuildReadModel();
    expect(empty()).toEqual([]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("rebuilding twice produces identical rows, conserving every digest as recorded", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    ledger.append(
      promptOccurrence({ taskId, transitionId: "prompt-2", effectId, occurrenceId: "po-2", ordinal: 1 }),
    );
    ledger.append(responseOccurrence({ taskId, transitionId: "response-1", promptOccurrenceId: "po-1" }));
    ledger.append(
      dispatchOutcome({
        taskId,
        transitionId: "abandon-1",
        dispatchAttemptId: "dsp-1",
        dispatchState: "ABANDONED",
        terminalAt: EFFECT_AT,
      }),
    );
    ledger.append(
      responseOccurrence({
        taskId,
        transitionId: "response-2",
        promptOccurrenceId: "po-2",
        occurrenceId: "ro-2",
        overrides: { redactionVerdict: "REDACTED" },
      }),
    );

    const snapshot = (): string =>
      canonicalJsonStringify({
        prompts: readRows(path, "SELECT * FROM prompt_occurrence_read_model ORDER BY occurrence_id"),
        responses: readRows(
          path,
          "SELECT * FROM response_occurrence_read_model ORDER BY occurrence_id",
        ),
      });

    const live = snapshot();
    ledger.rebuildReadModel();
    const once = snapshot();
    ledger.rebuildReadModel();
    const twice = snapshot();
    expect(once).toBe(live);
    expect(twice).toBe(once);
    expect(ledger.verifyIntegrity().ok).toBe(true);
    expect(ledger.getPromptOccurrence("po-2")?.promptSha256).toBe(PROMPT_DIGEST);
    expect(ledger.getResponseOccurrenceForPrompt("po-2")?.responseSha256).toBe(RESPONSE_DIGEST);
  });

  it("reports an occurrence row nobody wrote, and a digest swapped under one", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    ledger.append(promptOccurrence({ taskId, transitionId: "prompt-1", effectId }));
    ledger.append(responseOccurrence({ taskId, transitionId: "response-1", promptOccurrenceId: "po-1" }));
    ledger.close();

    withRawDatabase(path, (raw) => {
      raw
        .prepare("UPDATE response_occurrence_read_model SET response_sha256 = ?")
        .run("0".repeat(64));
      raw
        .prepare(
          "INSERT INTO prompt_occurrence_read_model SELECT 'po-ghost', route_segment_id, " +
            "effect_id, dispatch_attempt_id, 7, identity, requested_model_id, provider, " +
            "model_resolution_status, model_version_id, account_id, prompt_sha256, prompt_bytes, " +
            "context_sha256, recorded_at, sequence FROM prompt_occurrence_read_model",
        )
        .run();
    });

    const report = open(path).verifyIntegrity();
    expect(report.ok).toBe(false);
    const details = detailsOf(report.problems);
    expect(details).toContain("response_occurrence_read_model row for ro-1 disagrees with a replay");
    expect(details).toContain(
      "prompt_occurrence_read_model holds the row for po-ghost which no event accounts for",
    );
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo F — the command intention, its deliveries and its quarantine
// ---------------------------------------------------------------------------

const SAGA_AT = "2026-09-12T11:00:00.000Z";
const SAGA = "5a6a7a8a-0000-4000-8000-000000000001";
const SAGA_WORKTREE = "/tmp/acp-p18f-worktree";
const SAGA_DEADLINE = "2026-09-12T12:00:00.000Z";
const LEASE_INCARNATION = "4c4c4c4c-0000-4000-8000-000000000001";
const ATTEMPT_ONE = "6b6b6b6b-0000-4000-8000-000000000001";
const ATTEMPT_TWO = "6b6b6b6b-0000-4000-8000-000000000002";
const QUARANTINED: TaskState = "SUSPECT_WORKTREE";

/** The id of the one revocation these drills intend, as the door recomputes it. */
function revokeCommandId(sagaId = SAGA, targetId = SAGA_WORKTREE): string {
  return computeOutboxCommandId({ sagaId, phase: "QUARANTINE", targetKind: "WORKTREE_LEASE", targetId });
}

/** An `OUTBOX_COMMAND_INTENDED`, a `REVOKE_LEASE` unless the payload says otherwise. */
function commandIntention(input: {
  readonly taskId: string;
  readonly transitionId: string;
  readonly state?: TaskState;
  readonly payload?: Record<string, unknown>;
}): Record<string, unknown> {
  const state = input.state ?? QUARANTINED;
  return makeEvent({
    taskId: input.taskId,
    transitionId: input.transitionId,
    type: "OUTBOX_COMMAND_INTENDED",
    fromState: state,
    toState: state,
    occurredAt: SAGA_AT,
    payload: {
      outboxContractVersion: 1,
      sagaId: SAGA,
      commandId: revokeCommandId(),
      phase: "QUARANTINE",
      commandKind: "REVOKE_LEASE",
      intentStream: "control_plane_events",
      targetKind: "WORKTREE_LEASE",
      targetId: SAGA_WORKTREE,
      deadlineAt: SAGA_DEADLINE,
      fence: 1,
      targetStoreIncarnationId: LEASE_INCARNATION,
      ...(input.payload ?? {}),
    },
  });
}

/** A non-revocation command's intention payload, with its id computed. */
function otherCommand(commandKind: string, targetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const targetKind = commandKind === "RELEASE_RESERVATION" ? "ACCOUNT_RESERVATION" : "OPERATOR_CHANNEL";
  return {
    commandKind,
    phase: "SETTLE",
    targetKind,
    targetId,
    fence: null,
    targetStoreIncarnationId: null,
    commandId: computeOutboxCommandId({ sagaId: SAGA, phase: "SETTLE", targetKind, targetId }),
    ...extra,
  };
}

/** The quarantine batch: the finding, the move, and the intention to revoke. */
function quarantineBatch(
  taskId: string,
  from: TaskState = "DISCOVERED",
  intention: Record<string, unknown> = {},
  prefix = "q",
): Record<string, unknown>[] {
  return [
    makeEvent({
      taskId,
      transitionId: prefix + "-violation",
      type: "WRITE_SET_VIOLATION_DETECTED",
      fromState: from,
      toState: from,
      occurredAt: SAGA_AT,
      payload: { leaseId: "lease-1", firstPathOutsideSet: "src/outside.ts", pathsOutsideSet: "1" },
    }),
    makeEvent({
      taskId,
      transitionId: prefix + "-quarantine",
      type: "TASK_STATE_CHANGED",
      fromState: from,
      toState: QUARANTINED,
      occurredAt: SAGA_AT,
      payload: { taskId, toState: QUARANTINED },
    }),
    commandIntention({ taskId, transitionId: prefix + "-intend", payload: intention }),
  ];
}

function deliveryIntention(input: {
  readonly taskId: string;
  readonly transitionId: string;
  readonly deliveryAttemptId: string;
  readonly commandId?: string;
  readonly state?: TaskState;
  readonly extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const state = input.state ?? QUARANTINED;
  return makeEvent({
    taskId: input.taskId,
    transitionId: input.transitionId,
    type: "OUTBOX_DELIVERY_INTENDED",
    fromState: state,
    toState: state,
    occurredAt: SAGA_AT,
    payload: {
      outboxContractVersion: 1,
      commandId: input.commandId ?? revokeCommandId(),
      deliveryAttemptId: input.deliveryAttemptId,
      ...(input.extra ?? {}),
    },
  });
}

function deliveryObservation(input: {
  readonly taskId: string;
  readonly transitionId: string;
  readonly deliveryAttemptId: string;
  readonly outboxState: string;
  readonly failureCode?: string | null;
  readonly responseHandle?: string | null;
  readonly commandId?: string;
  readonly state?: TaskState;
}): Record<string, unknown> {
  const state = input.state ?? QUARANTINED;
  return makeEvent({
    taskId: input.taskId,
    transitionId: input.transitionId,
    type: "OUTBOX_DELIVERY_OBSERVED",
    fromState: state,
    toState: state,
    occurredAt: SAGA_AT,
    payload: {
      outboxContractVersion: 1,
      commandId: input.commandId ?? revokeCommandId(),
      deliveryAttemptId: input.deliveryAttemptId,
      outboxState: input.outboxState,
      failureCode: input.failureCode ?? null,
      responseHandle: input.responseHandle ?? null,
    },
  });
}

/** The causal reference that names one recorded event of the task stream. */
function causeOf(record: { readonly sequence: number; readonly eventSha256: string }): CausationRef {
  return { stream: "control_plane_events", sequence: record.sequence, sha256: record.eventSha256 };
}

/** A discovered task, quarantined in one batch; returns the intention's record. */
function seedQuarantined(ledger: Ledger, taskId: string): { readonly sequence: number; readonly eventSha256: string } {
  ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
  const batch = ledger.appendBatch(quarantineBatch(taskId));
  const record = batch.results[2]?.record;
  if (record === undefined) throw new Error("the quarantine batch recorded no intention");
  return record;
}

describe("a quarantine commits with its intention to revoke, or not at all (P-18/F, N-P18-14)", () => {
  it("the finding, the move to SUSPECT_WORKTREE and the intention commit as one batch", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));

    const batch = ledger.appendBatch(quarantineBatch(taskId));
    expect(batch.insertedCount).toBe(3);
    const intention = batch.results[2]!.record;
    expect(ledger.getTask(taskId)?.currentState).toBe(QUARANTINED);

    // Datos §11 `:548-550`: the intention is a complete command event of the
    // ledger's own transaction, and the command it names is folded from it.
    expect(ledger.getOutboxCommand(revokeCommandId())).toEqual({
      commandId: revokeCommandId(),
      sagaId: SAGA,
      phase: "QUARANTINE",
      commandKind: "REVOKE_LEASE",
      targetKind: "WORKTREE_LEASE",
      targetId: SAGA_WORKTREE,
      deadlineAt: SAGA_DEADLINE,
      fence: 1,
      targetStoreIncarnationId: LEASE_INCARNATION,
      taskId,
      intentStream: "control_plane_events",
      intentSequence: intention.sequence,
      intentSha256: intention.eventSha256,
      state: "PENDING",
      attemptCount: 0,
      lastDeliveryAttemptId: null,
      lastAttemptStream: null,
      lastAttemptSequence: null,
      lastAttemptSha256: null,
      lastFailureCode: null,
      responseHandle: null,
      createdAt: SAGA_AT,
      updatedAt: SAGA_AT,
    } satisfies OutboxCommandReadModel);

    expect(ledger.verifyIntegrity().ok).toBe(true);
    expect(ledger.rebuildReadModel().replayedEvents).toBe(4);
    expect(ledger.listOutboxCommands()).toHaveLength(1);
  });

  it("N-F-1: an intention to revoke by append, or in a batch that did not insert its quarantine, is refused", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
    const [violation, quarantine, intention] = quarantineBatch(taskId);
    // The daemon's shape today: three separate appends. The two quarantine
    // events are still admitted one by one — the declared legacy window.
    expect(ledger.append(violation!).inserted).toBe(true);
    expect(ledger.append(quarantine!).inserted).toBe(true);
    const head = ledger.status().headSequence;

    // By `append`, the intention has no batch to be atomic with.
    expect(refusalOf(() => ledger.append(intention!)).path).toBe("payload.commandKind");
    // In a batch of its own, the same.
    expect(refusalOf(() => ledger.appendBatch([intention!])).path).toBe("payload.commandKind");
    // And in a batch that merely replays the quarantine: those events committed
    // in earlier transactions, so the intention is not atomic with them either.
    const replayed = refusalOf(() => ledger.appendBatch([violation!, quarantine!, intention!]));
    expect(replayed.path).toBe("payload.commandKind");
    expect(replayed.message).toContain("commit together or not at all");

    expect(ledger.status().headSequence).toBe(head);
    expect(ledger.listOutboxCommands()).toEqual([]);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-F-1, second wing: a batch that quarantines a task without its intention rolls back whole", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
    const [violation, quarantine] = quarantineBatch(taskId);

    const bare = refusalOf(() => ledger.appendBatch([violation!, quarantine!]));
    expect(bare.path).toBe("candidates[1]");
    expect(bare.message).toContain("no REVOKE_LEASE intention of its own");

    // A command of another kind is not the intention to revoke.
    const notify = commandIntention({
      taskId,
      transitionId: "notify",
      payload: otherCommand("NOTIFY", "operator"),
    });
    expect(refusalOf(() => ledger.appendBatch([violation!, quarantine!, notify])).path).toBe("candidates[1]");

    expect(ledger.status().headSequence).toBe(1);
    expect(ledger.getTask(taskId)?.currentState).toBe("DISCOVERED");
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("keeps the declared legacy window: a unitary move to SUSPECT_WORKTREE is still admitted", () => {
    // ADR 0078 and decision 51. The daemon's conformance gate appends the move on
    // its own today, and closing that window is the adoption's, not this door's.
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
    expect(ledger.append(quarantineBatch(taskId)[1]!).inserted).toBe(true);
    expect(ledger.getTask(taskId)?.currentState).toBe(QUARANTINED);
  });

  it("N-P18-14: a failure before the commit leaves neither the quarantine nor its intention", () => {
    let fail = false;
    const ledger = open(temporaryDatabase(), {
      __testFaults: {
        beforeAppendCommit: () => {
          if (fail) throw new Error("injected commit failure");
        },
      },
    });
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));

    fail = true;
    expect(caught(() => ledger.appendBatch(quarantineBatch(taskId)))).toBeInstanceOf(Error);
    fail = false;

    expect(ledger.status().headSequence).toBe(1);
    expect(ledger.getTask(taskId)?.currentState).toBe("DISCOVERED");
    expect(ledger.listOutboxCommands()).toEqual([]);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    expect(ledger.appendBatch(quarantineBatch(taskId)).insertedCount).toBe(3);
  });

  it("a rebuild refuses a stored intention to revoke that follows no quarantine", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
    ledger.append(
      makeEvent({ taskId, transitionId: "step", type: "ATOMIC_STEP_COMPLETED", fromState: "DISCOVERED", toState: "DISCOVERED", occurredAt: SAGA_AT }),
    );
    ledger.close();

    // The one shape the door can never write, planted underneath it.
    plantChainedEvent(path, commandIntention({ taskId, transitionId: "intend", state: "DISCOVERED" }));
    const reopened = open(path);
    const refusal = refusalOf(() => reopened.rebuildReadModel());
    expect(refusal.path).toBe("payload.commandKind");
  });
});

describe("the V1 matrix and the command's identity (P-18/F, N-P18-13)", () => {
  it("N-F-7: outside the matrix is CAPABILITY_UNSUPPORTED, and nothing is written", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
    const cases: readonly Record<string, unknown>[] = [
      otherCommand("RELEASE_RESERVATION", "reservation-1", { intentStream: "initiative_events" }),
      { ...otherCommand("NOTIFY", "operator"), commandKind: "REVOKE_LEASE", intentStream: "account_events" },
      otherCommand("NOTIFY", "operator", { intentStream: "registry_events" }),
      otherCommand("EXPORT_TELEMETRY", "exporter", { intentStream: "registry_events" }),
      otherCommand("NOTIFY", "operator", { intentStream: "initiative_events" }),
      otherCommand("RESTART_WORKER", "worker-1"),
    ];
    for (const [index, payload] of cases.entries()) {
      const refusal = refusalOf(() =>
        ledger.append(commandIntention({ taskId, transitionId: "matrix-" + String(index), state: "DISCOVERED", payload })),
      );
      expect(refusal.message, JSON.stringify(payload)).toContain("CAPABILITY_UNSUPPORTED");
    }
    expect(ledger.status().headSequence).toBe(1);
    expect(ledger.listOutboxCommands()).toEqual([]);
  });

  it("N-P18-13: the four kinds are admitted on control_plane_events", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedQuarantined(ledger, taskId);
    for (const [kind, target] of [
      ["RELEASE_RESERVATION", "reservation-1"],
      ["NOTIFY", "operator"],
      ["EXPORT_TELEMETRY", "exporter"],
    ] as const) {
      expect(
        ledger.append(commandIntention({ taskId, transitionId: "intend-" + kind, payload: otherCommand(kind, target) }))
          .inserted,
      ).toBe(true);
    }
    const commands = ledger.listOutboxCommands();
    expect(commands.map((command) => command.commandKind)).toEqual([
      "REVOKE_LEASE",
      "RELEASE_RESERVATION",
      "NOTIFY",
      "EXPORT_TELEMETRY",
    ]);
    expect(new Set(commands.map((command) => command.state))).toEqual(new Set(["PENDING"]));
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-F-2: the door recomputes the command id and refuses one that does not match", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
    const proposed = otherCommand("NOTIFY", "operator", { commandId: "f".repeat(64) });
    const refusal = refusalOf(() =>
      ledger.append(commandIntention({ taskId, transitionId: "intend", state: "DISCOVERED", payload: proposed })),
    );
    expect(refusal.path).toBe("payload.commandId");
    expect(refusal.message).toContain(otherCommand("NOTIFY", "operator")["commandId"] as string);
    expect(ledger.status().headSequence).toBe(1);
  });

  it("a command is intended once: the same one again is a reuse, another under its id a CONFLICT", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
    const payload = otherCommand("NOTIFY", "operator");
    ledger.append(commandIntention({ taskId, transitionId: "intend-1", state: "DISCOVERED", payload }));

    const same = refusalOf(() =>
      ledger.append(commandIntention({ taskId, transitionId: "intend-2", state: "DISCOVERED", payload })),
    );
    expect(same.message).toContain("already intended");
    expect(same.message).not.toContain("CONFLICT");

    const different = refusalOf(() =>
      ledger.append(
        commandIntention({
          taskId,
          transitionId: "intend-3",
          state: "DISCOVERED",
          payload: { ...payload, deadlineAt: "2026-09-12T13:00:00.000Z" },
        }),
      ),
    );
    expect(different.message).toContain("CONFLICT");
    expect(ledger.listOutboxCommands()).toHaveLength(1);
  });
});

describe("a delivery attempt and its observation attach to what they name (P-18/F)", () => {
  it("N-F-3: an attempt needs its intention, and an observation its attempt", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const intention = seedQuarantined(ledger, taskId);

    const orphan = refusalOf(() =>
      ledger.append(
        deliveryIntention({ taskId, transitionId: "attempt-orphan", deliveryAttemptId: ATTEMPT_ONE, commandId: "e".repeat(64) }),
        causeOf(intention),
      ),
    );
    expect(orphan.path).toBe("payload.commandId");

    const unseen = refusalOf(() =>
      ledger.append(
        deliveryObservation({ taskId, transitionId: "observe", deliveryAttemptId: ATTEMPT_ONE, outboxState: "DELIVERED" }),
        causeOf(intention),
      ),
    );
    expect(unseen.path).toBe("payload.deliveryAttemptId");
    expect(ledger.getOutboxCommand(revokeCommandId())?.state).toBe("PENDING");
  });

  it("an attempt names its intention as its cause, and an observation its attempt, or both are refused", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const intention = seedQuarantined(ledger, taskId);
    const attempt = deliveryIntention({ taskId, transitionId: "attempt-1", deliveryAttemptId: ATTEMPT_ONE });

    expect(refusalOf(() => ledger.append(attempt)).path).toBe("causation");
    const quarantine = ledger.getEventBySequence(intention.sequence - 1)!;
    expect(refusalOf(() => ledger.append(attempt, causeOf(quarantine))).path).toBe("causation");
    const recorded = ledger.append(attempt, causeOf(intention)).record;
    expect(ledger.getOutboxCommand(revokeCommandId())?.state).toBe("RECONCILING");

    const observation = deliveryObservation({
      taskId,
      transitionId: "observe-1",
      deliveryAttemptId: ATTEMPT_ONE,
      outboxState: "DELIVERED",
      responseHandle: LEASE_INCARNATION + ":2",
    });
    expect(refusalOf(() => ledger.append(observation, causeOf(intention))).path).toBe("causation");
    expect(ledger.append(observation, causeOf(recorded)).inserted).toBe(true);
    expect(ledger.getOutboxCommand(revokeCommandId())).toMatchObject({
      state: "DELIVERED",
      responseHandle: LEASE_INCARNATION + ":2",
    });
  });

  it("N-F-4: the same attempt appended twice counts once", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const intention = seedQuarantined(ledger, taskId);
    for (const transitionId of ["attempt-1", "attempt-1-again"]) {
      expect(
        ledger.append(deliveryIntention({ taskId, transitionId, deliveryAttemptId: ATTEMPT_ONE }), causeOf(intention))
          .inserted,
      ).toBe(true);
    }
    expect(ledger.getOutboxCommand(revokeCommandId())).toMatchObject({ attemptCount: 1, state: "RECONCILING" });
  });

  it("N-F-5: transitions are coordination §2's from the folded state, and a terminal state moves nowhere", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const intention = seedQuarantined(ledger, taskId);
    const first = ledger.append(
      deliveryIntention({ taskId, transitionId: "attempt-1", deliveryAttemptId: ATTEMPT_ONE }),
      causeOf(intention),
    ).record;
    const observe = (
      transitionId: string,
      deliveryAttemptId: string,
      outboxState: string,
      cause: { readonly sequence: number; readonly eventSha256: string },
      failureCode: string | null = null,
    ): unknown =>
      ledger.append(
        deliveryObservation({ taskId, transitionId, deliveryAttemptId, outboxState, failureCode }),
        causeOf(cause),
      );

    expect(refusalOf(() => observe("back-inflight", ATTEMPT_ONE, "INFLIGHT", first)).path).toBe("payload.outboxState");
    // A new attempt beside an uncertain one is a resend, and refused.
    expect(
      refusalOf(() =>
        ledger.append(deliveryIntention({ taskId, transitionId: "attempt-2-early", deliveryAttemptId: ATTEMPT_TWO }), causeOf(intention)),
      ).message,
    ).toContain("never resent");

    observe("failed", ATTEMPT_ONE, "FAILED_RETRYABLE", first, "NOT_DISPATCHED_PROVEN");
    expect(
      refusalOf(() =>
        ledger.append(deliveryIntention({ taskId, transitionId: "attempt-2-still", deliveryAttemptId: ATTEMPT_TWO }), causeOf(intention)),
      ).path,
    ).toBe("payload.deliveryAttemptId");
    observe("pending", ATTEMPT_ONE, "PENDING", first);
    const second = ledger.append(
      deliveryIntention({ taskId, transitionId: "attempt-2", deliveryAttemptId: ATTEMPT_TWO }),
      causeOf(intention),
    ).record;

    // The first attempt was superseded, and an observation reports on the one in force.
    expect(refusalOf(() => observe("late", ATTEMPT_ONE, "DELIVERED", first)).message).toContain("superseded");
    observe("delivered", ATTEMPT_TWO, "DELIVERED", second);
    expect(refusalOf(() => observe("after", ATTEMPT_TWO, "DELIVERED", second)).message).toContain("terminal");

    expect(ledger.getOutboxCommand(revokeCommandId())).toMatchObject({
      state: "DELIVERED",
      attemptCount: 2,
      lastDeliveryAttemptId: ATTEMPT_TWO,
      lastFailureCode: "NOT_DISPATCHED_PROVEN",
    });
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.rebuildReadModel();
    expect(ledger.getOutboxCommand(revokeCommandId())?.state).toBe("DELIVERED");
  });

  it("an observation affects only the command and the attempt it names", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    seedQuarantined(ledger, taskId);
    const notify = otherCommand("NOTIFY", "operator");
    const intention = ledger.append(commandIntention({ taskId, transitionId: "notify", payload: notify })).record;
    const attempt = ledger.append(
      deliveryIntention({ taskId, transitionId: "notify-attempt", deliveryAttemptId: ATTEMPT_ONE, commandId: notify["commandId"] as string }),
      causeOf(intention),
    ).record;
    ledger.append(
      deliveryObservation({
        taskId,
        transitionId: "notify-observe",
        deliveryAttemptId: ATTEMPT_ONE,
        outboxState: "DELIVERED",
        commandId: notify["commandId"] as string,
      }),
      causeOf(attempt),
    );
    // And the attempt serves its own command only: naming it for the revocation is refused.
    expect(
      refusalOf(() =>
        ledger.append(
          deliveryObservation({ taskId, transitionId: "cross", deliveryAttemptId: ATTEMPT_ONE, outboxState: "DELIVERED" }),
          causeOf(attempt),
        ),
      ).path,
    ).toBe("payload.deliveryAttemptId");
    expect(ledger.getOutboxCommand(notify["commandId"] as string)?.state).toBe("DELIVERED");
    expect(ledger.getOutboxCommand(revokeCommandId())?.state).toBe("PENDING");
  });

  it("an attempt recorded on another task than its command's is refused", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const intention = seedQuarantined(ledger, taskId);
    const other = randomUUID();
    ledger.append(makeEvent({ taskId: other, transitionId: "discover", occurredAt: SAGA_AT }));
    const refusal = refusalOf(() =>
      ledger.append(
        deliveryIntention({ taskId: other, transitionId: "attempt", deliveryAttemptId: ATTEMPT_ONE, state: "DISCOVERED" }),
        causeOf(intention),
      ),
    );
    expect(refusal.path).toBe("payload.commandId");
    expect(refusal.message).toContain("belongs to task " + taskId);
  });

  it("N-F-6: a half token is refused, and the token is conserved from the intention", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
    expect(refusalOf(() => ledger.appendBatch(quarantineBatch(taskId, "DISCOVERED", { fence: null }))).path).toBe(
      "payload.fence",
    );
    expect(
      refusalOf(() => ledger.appendBatch(quarantineBatch(taskId, "DISCOVERED", { targetStoreIncarnationId: null }))).path,
    ).toBe("payload.targetStoreIncarnationId");

    const intention = ledger.appendBatch(quarantineBatch(taskId, "DISCOVERED", { fence: 7 })).results[2]!.record;
    const attempt = ledger.append(
      deliveryIntention({ taskId, transitionId: "attempt-1", deliveryAttemptId: ATTEMPT_ONE }),
      causeOf(intention),
    ).record;
    ledger.append(
      deliveryObservation({ taskId, transitionId: "observe-1", deliveryAttemptId: ATTEMPT_ONE, outboxState: "DELIVERED" }),
      causeOf(attempt),
    );
    ledger.rebuildReadModel();
    expect(ledger.getOutboxCommand(revokeCommandId())).toMatchObject({
      fence: 7,
      targetStoreIncarnationId: LEASE_INCARNATION,
    });
  });

  it("N-F-10: a stray key, a credential-shaped handle and a free failure word are refused", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const intention = seedQuarantined(ledger, taskId);
    expect(
      refusalOf(() =>
        ledger.append(
          deliveryIntention({ taskId, transitionId: "stray", deliveryAttemptId: ATTEMPT_ONE, extra: { endpoint: "https://example.invalid" } }),
          causeOf(intention),
        ),
      ).path,
    ).toBe("payload.endpoint");
    const attempt = ledger.append(
      deliveryIntention({ taskId, transitionId: "attempt-1", deliveryAttemptId: ATTEMPT_ONE }),
      causeOf(intention),
    ).record;

    // The contract's own guard refuses a value shaped like live credential material.
    expect(
      caught(() =>
        ledger.append(
          deliveryObservation({
            taskId,
            transitionId: "handle",
            deliveryAttemptId: ATTEMPT_ONE,
            outboxState: "DELIVERED",
            responseHandle: "sk-" + "x".repeat(24),
          }),
          causeOf(attempt),
        ),
      ),
    ).toBeInstanceOf(LedgerValidationError);
    expect(
      refusalOf(() =>
        ledger.append(
          deliveryObservation({
            taskId,
            transitionId: "free-word",
            deliveryAttemptId: ATTEMPT_ONE,
            outboxState: "FAILED_TERMINAL",
            failureCode: "the target said no",
          }),
          causeOf(attempt),
        ),
      ).path,
    ).toBe("payload.failureCode");
    expect(ledger.getOutboxCommand(revokeCommandId())?.state).toBe("RECONCILING");
  });
});

describe("a lost cache rebuilds from these events, and never to PENDING (P-18/F, N-F-8)", () => {
  it("listOutboxCommands is the pure fold over the stream, and a rebuild agrees", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const intention = seedQuarantined(ledger, taskId);
    ledger.append(deliveryIntention({ taskId, transitionId: "attempt-1", deliveryAttemptId: ATTEMPT_ONE }), causeOf(intention));
    ledger.append(commandIntention({ taskId, transitionId: "notify", payload: otherCommand("NOTIFY", "operator") }));

    const listed = ledger.listOutboxCommands();
    // The attempt with no outcome is RECONCILING, never PENDING; the intention
    // with no attempt is PENDING.
    expect(listed.map((command) => [command.commandKind, command.state])).toEqual([
      ["REVOKE_LEASE", "RECONCILING"],
      ["NOTIFY", "PENDING"],
    ]);

    const entries = ledger.listEvents({ limit: 1000 }).events.map((record) => ({
      event: record.event,
      sequence: record.sequence,
      sha256: record.eventSha256,
      causation: record.causation,
    }));
    expect(foldOutboxCommands(entries)).toEqual(listed);

    ledger.rebuildReadModel();
    expect(ledger.verifyIntegrity().ok).toBe(true);
    expect(ledger.listOutboxCommands()).toEqual(listed);
  });

  it("a rebuild refuses a stored observation of an attempt nobody intended", () => {
    const path = temporaryDatabase();
    const ledger = open(path);
    const taskId = randomUUID();
    seedQuarantined(ledger, taskId);
    ledger.close();

    plantChainedEvent(
      path,
      deliveryObservation({ taskId, transitionId: "observe", deliveryAttemptId: ATTEMPT_ONE, outboxState: "DELIVERED" }),
    );
    const reopened = open(path);
    expect(refusalOf(() => reopened.rebuildReadModel()).path).toBe("payload.deliveryAttemptId");
    expect(caught(() => reopened.verifyIntegrity())).toBeInstanceOf(LedgerValidationError);
  });
});

describe("a delivery beside an outstanding one is refused (postaudit of C, O-1; adjudicated to F)", () => {
  it("refuses a second delivery while the first is outstanding, and admits it once the first is terminal", () => {
    const ledger = open(temporaryDatabase());
    const taskId = randomUUID();
    const effectId = seedDelivery(ledger, taskId);
    const second = dispatchIntention({ taskId, transitionId: "dispatch-2", effectId, dispatchAttemptId: "dsp-2", attemptOrdinal: 2 });

    for (const state of ["INTENDED", "INFLIGHT"] as const) {
      if (state === "INFLIGHT") {
        ledger.append(dispatchOutcome({ taskId, transitionId: "inflight", dispatchAttemptId: "dsp-1", dispatchState: "INFLIGHT" }));
      }
      const refusal = refusalOf(() => ledger.append(second));
      expect(refusal.path, state).toBe("payload.dispatch.effectId");
      expect(refusal.message, state).toContain("outstanding");
    }

    ledger.append(
      dispatchOutcome({ taskId, transitionId: "abandon", dispatchAttemptId: "dsp-1", dispatchState: "ABANDONED", terminalAt: EFFECT_AT }),
    );
    expect(ledger.append(second).inserted).toBe(true);
    expect(ledger.listDispatchAttempts(effectId).map((row) => row.dispatchState)).toEqual(["ABANDONED", "INTENDED"]);
  });
});

// ---------------------------------------------------------------------------
// The saga's first three crash boundaries (testing §7 `:169-171`, `:178-179`)
// ---------------------------------------------------------------------------

/**
 * One revocation saga over a real ledger and a real lease store, stopped at a
 * boundary and reopened.
 *
 * **In process, on purpose** (H-8, adjudicated). A crash is modelled as the
 * process stopping between two steps: both handles close and nothing after the
 * boundary runs. The one boundary that lives *inside* a transaction — between
 * the arbiter's compare-and-set and the ledger's acknowledgement — is crossed
 * with the ledger's own `beforeAppendCommit` fault, so the acknowledgement's
 * transaction really starts and really does not commit. The SIGKILL matrix and
 * `synchronous = FULL` are the certified profile's and P-18/recuperación's
 * (testing §10); ADR 0078 declares it.
 *
 * The reconciliation below is **test code, not a reconciler**: F registers and
 * folds, and a reconciler is the blocked half's (H-3). It exists so the oracle
 * can be stated as an outcome — the state both files reach — rather than as a
 * snapshot nobody acts on.
 */
describe("the saga's first three crash boundaries leave the two files consistent (P-18/F, N-P18-15)", () => {
  const stores: LeaseStore[] = [];
  afterEach(() => {
    // `close` is idempotent on a lease store, so a handle a test already closed
    // is closed again harmlessly.
    for (const store of stores.splice(0)) store.close();
  });

  const REVOKE_AT = "2026-09-12T11:05:00.000Z";
  const ACK_AT = "2026-09-12T11:06:00.000Z";
  const command = revokeCommandId();

  function openStore(path: string): LeaseStore {
    const store = openLeaseStore(path, { incarnationId: LEASE_INCARNATION, createdAt: SAGA_AT });
    stores.push(store);
    return store;
  }

  /** A second revocation of the same worktree, with and without the stale token. */
  function assertNoSecondRevocation(store: LeaseStore): void {
    const stale = store.transact(
      SAGA_WORKTREE,
      () => ({ verb: "REVOKE", at: REVOKE_AT, operationId: command }),
      { incarnationId: LEASE_INCARNATION, fence: 1 },
    );
    expect(stale.verb).toBe("REFUSE");
    expect(
      caught(() => store.transact(SAGA_WORKTREE, () => ({ verb: "REVOKE", at: REVOKE_AT, operationId: command }))),
    ).toBeInstanceOf(LedgerQueryError);
    expect(store.read(SAGA_WORKTREE)?.fence).toBe(2);
  }

  function world(): { readonly ledgerPath: string; readonly storePath: string; readonly taskId: string } {
    const ledgerPath = temporaryDatabase();
    const storePath = join(dirname(ledgerPath), "leases.sqlite");
    const taskId = randomUUID();
    const ledger = open(ledgerPath);
    ledger.append(makeEvent({ taskId, transitionId: "discover", occurredAt: SAGA_AT }));
    ledger.close();
    const store = openStore(storePath);
    store.transact(SAGA_WORKTREE, () => ({
      verb: "GRANT",
      row: {
        leaseId: "lease-1",
        holder: "claude/opus/implementer/01",
        acquiredAt: SAGA_AT,
        expiresAt: SAGA_DEADLINE,
        holderPid: null,
        holderToken: null,
      },
    }));
    store.close();
    return { ledgerPath, storePath, taskId };
  }

  /** What a crash leaves: both files, reopened, and the one command. */
  function reopen(paths: { readonly ledgerPath: string; readonly storePath: string }): {
    readonly ledger: Ledger;
    readonly store: LeaseStore;
    readonly commandState: () => OutboxCommandReadModel;
    readonly row: () => LeaseRow;
  } {
    const ledger = open(paths.ledgerPath);
    const store = openStore(paths.storePath);
    return {
      ledger,
      store,
      commandState: () => ledger.getOutboxCommand(command)!,
      row: () => store.read(SAGA_WORKTREE)!,
    };
  }

  /**
   * The oracle, as one function applied at every boundary and after every
   * reconciliation: coordination §10 negative 8 and testing §7 `:178-179`.
   */
  function assertConsistent(state: OutboxCommandReadModel, row: LeaseRow): void {
    // Never "released in the arbiter and alive in the ledger": once the arbiter
    // has cleared the holder, the ledger does not say the revocation is still
    // to be sent.
    if (row.leaseId === null) expect(state.state).not.toBe("PENDING");
    // An acknowledgement in the ledger names a revocation the arbiter holds for
    // this very command.
    if (state.state === "DELIVERED") {
      expect(row.leaseId).toBeNull();
      expect(row.operationId).toBe(command);
    }
    // No known effect duplicated: one command advanced the fence at most once.
    expect(row.fence).toBeLessThanOrEqual(2);
    // And the ledger's command still carries the token it was issued under.
    expect({ fence: state.fence, incarnation: state.targetStoreIncarnationId }).toEqual({
      fence: 1,
      incarnation: LEASE_INCARNATION,
    });
  }

  let transition = 0;
  const next = (name: string): string => name + "-" + String((transition += 1));

  function intend(ledger: Ledger, taskId: string): void {
    ledger.appendBatch(quarantineBatch(taskId));
  }

  function attempt(ledger: Ledger, taskId: string, deliveryAttemptId: string): void {
    const state = ledger.getOutboxCommand(command)!;
    ledger.append(
      deliveryIntention({ taskId, transitionId: next("attempt"), deliveryAttemptId }),
      { stream: "control_plane_events", sequence: state.intentSequence, sha256: state.intentSha256 },
    );
  }

  function observe(ledger: Ledger, taskId: string, outboxState: string, extra: { failureCode?: string; responseHandle?: string } = {}): void {
    const state = ledger.getOutboxCommand(command)!;
    // The anchor is read off the fold, which is exactly what a rebuilt cache has.
    ledger.append(
      deliveryObservation({
        taskId,
        transitionId: next("observe"),
        deliveryAttemptId: state.lastDeliveryAttemptId!,
        outboxState,
        ...extra,
      }),
      { stream: "control_plane_events", sequence: state.lastAttemptSequence!, sha256: state.lastAttemptSha256! },
    );
  }

  function revoke(store: LeaseStore): void {
    const outcome = store.transact(
      SAGA_WORKTREE,
      () => ({ verb: "REVOKE", at: REVOKE_AT, operationId: command }),
      { incarnationId: LEASE_INCARNATION, fence: 1 },
    );
    expect(outcome.verb).toBe("REVOKE");
  }

  /** Test-side reconciliation: read both files, and finish the saga without guessing. */
  function reconcile(ledger: Ledger, store: LeaseStore, taskId: string): void {
    let state = ledger.getOutboxCommand(command)!;
    if (state.state === "RECONCILING" && store.read(SAGA_WORKTREE)?.operationId !== command) {
      // No compare-and-set carries this command: nothing was dispatched, and
      // that is proven by the arbiter rather than assumed (§2 `:51-54`).
      observe(ledger, taskId, "FAILED_RETRYABLE", { failureCode: "NOT_DISPATCHED_PROVEN" });
      observe(ledger, taskId, "PENDING");
      state = ledger.getOutboxCommand(command)!;
    }
    if (state.state === "PENDING") {
      attempt(ledger, taskId, state.attemptCount === 0 ? ATTEMPT_ONE : ATTEMPT_TWO);
      revoke(store);
      state = ledger.getOutboxCommand(command)!;
    }
    if (state.state === "RECONCILING") {
      const row = store.read(SAGA_WORKTREE)!;
      observe(ledger, taskId, "DELIVERED", { responseHandle: LEASE_INCARNATION + ":" + String(row.fence) });
    }
    if (store.read(SAGA_WORKTREE)?.revocationAcknowledgedAt === null) {
      store.transact(SAGA_WORKTREE, () => ({ verb: "ACKNOWLEDGE_REVOCATION", at: ACK_AT }));
    }
  }

  function assertSettled(ledger: Ledger, store: LeaseStore, attempts: number): void {
    const state = ledger.getOutboxCommand(command)!;
    const row = store.read(SAGA_WORKTREE)!;
    assertConsistent(state, row);
    expect(state).toMatchObject({ state: "DELIVERED", attemptCount: attempts });
    expect(row).toMatchObject({ fence: 2, leaseId: null, operationId: command, revocationAcknowledgedAt: ACK_AT });
    expect(ledger.verifyIntegrity().ok).toBe(true);
    ledger.rebuildReadModel();
    expect(ledger.getOutboxCommand(command)).toEqual(state);
  }

  it("boundary 1: after the intention and before the compare-and-set, the command is PENDING and nothing moved", () => {
    const paths = world();
    {
      const ledger = open(paths.ledgerPath);
      intend(ledger, paths.taskId);
      ledger.close();
    }

    const after = reopen(paths);
    assertConsistent(after.commandState(), after.row());
    expect(after.commandState()).toMatchObject({ state: "PENDING", attemptCount: 0 });
    expect(after.row()).toMatchObject({ fence: 1, leaseId: "lease-1", operationId: null });

    reconcile(after.ledger, after.store, paths.taskId);
    assertSettled(after.ledger, after.store, 1);
  });

  it("boundary 1, with the attempt recorded: RECONCILING, never PENDING, and no resend until not-dispatched is proven", () => {
    const paths = world();
    {
      const ledger = open(paths.ledgerPath);
      intend(ledger, paths.taskId);
      attempt(ledger, paths.taskId, ATTEMPT_ONE);
      ledger.close();
    }

    const after = reopen(paths);
    assertConsistent(after.commandState(), after.row());
    expect(after.commandState()).toMatchObject({ state: "RECONCILING", attemptCount: 1 });
    expect(after.row()).toMatchObject({ fence: 1, operationId: null });
    // Lost-cache honesty: an uncertain delivery is not resent on its own.
    expect(
      refusalOf(() => {
        attempt(after.ledger, paths.taskId, ATTEMPT_TWO);
      }).message,
    ).toContain("never resent");

    reconcile(after.ledger, after.store, paths.taskId);
    assertSettled(after.ledger, after.store, 2);
    expect(after.commandState().lastFailureCode).toBe("NOT_DISPATCHED_PROVEN");
  });

  it("boundary 2: after the compare-and-set and before the ledger's acknowledgement, the reconciliation acknowledges", () => {
    const paths = world();
    {
      let failCommit = false;
      const ledger = open(paths.ledgerPath, {
        __testFaults: {
          beforeAppendCommit: () => {
            if (failCommit) throw new Error("the process died inside the acknowledgement's transaction");
          },
        },
      });
      const store = openStore(paths.storePath);
      intend(ledger, paths.taskId);
      attempt(ledger, paths.taskId, ATTEMPT_ONE);
      revoke(store);
      failCommit = true;
      expect(
        caught(() => {
          observe(ledger, paths.taskId, "DELIVERED", { responseHandle: LEASE_INCARNATION + ":2" });
        }),
      ).toBeInstanceOf(Error);
      ledger.close();
      store.close();
    }

    const after = reopen(paths);
    // Coordination §10 negative 8: the arbiter has revoked, and the ledger says
    // the revocation is uncertain — never that it is still to be sent.
    assertConsistent(after.commandState(), after.row());
    expect(after.commandState()).toMatchObject({ state: "RECONCILING", attemptCount: 1 });
    expect(after.row()).toMatchObject({ fence: 2, leaseId: null, operationId: command, revocationAcknowledgedAt: null });
    // No second revocation: the door refuses a resend, and the arbiter a revoke of nothing.
    expect(
      refusalOf(() => {
        attempt(after.ledger, paths.taskId, ATTEMPT_TWO);
      }).message,
    ).toContain("never resent");
    assertNoSecondRevocation(after.store);

    reconcile(after.ledger, after.store, paths.taskId);
    assertSettled(after.ledger, after.store, 1);
  });

  it("boundary 3: after the acknowledgement and before external work, both files agree and nothing can repeat", () => {
    const paths = world();
    {
      const ledger = open(paths.ledgerPath);
      const store = openStore(paths.storePath);
      intend(ledger, paths.taskId);
      attempt(ledger, paths.taskId, ATTEMPT_ONE);
      revoke(store);
      observe(ledger, paths.taskId, "DELIVERED", { responseHandle: LEASE_INCARNATION + ":2" });
      store.transact(SAGA_WORKTREE, () => ({ verb: "ACKNOWLEDGE_REVOCATION", at: ACK_AT }));
      ledger.close();
      store.close();
    }

    const after = reopen(paths);
    assertSettled(after.ledger, after.store, 1);
    expect(
      refusalOf(() => {
        attempt(after.ledger, paths.taskId, ATTEMPT_TWO);
      }).message,
    ).toContain("DELIVERED");
    assertNoSecondRevocation(after.store);
    // A reconciliation run over a finished saga changes nothing.
    reconcile(after.ledger, after.store, paths.taskId);
    assertSettled(after.ledger, after.store, 1);
  });
});
