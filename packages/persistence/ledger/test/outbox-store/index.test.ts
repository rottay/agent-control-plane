import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerClosedError,
  LedgerMigrationError,
  LedgerOpenError,
  LedgerQueryError,
} from "../../src/errors/index.js";
import {
  MAX_OUTBOX_ROW_VERSION,
  OUTBOX_STATES,
  OUTBOX_TERMINAL_STATES,
  OUTBOX_TRANSITIONS,
  openOutboxStore,
  outboxStorePath,
} from "../../src/outbox-store/index.js";
import type {
  OutboxMessageSeed,
  OutboxMutation,
  OutboxRow,
  OutboxState,
  OutboxStore,
} from "../../src/outbox-store/index.js";

/**
 * Evidence for the outbox message store (P-18/protocolo escalón E2).
 *
 * The escalón's reason to exist is a compare-and-set that cannot be fooled, so
 * the suite is organised around the four negatives the map names rather than
 * around the module's public surface:
 *
 *   • **N-P18-9** — a predicate that matches nothing changes no row and returns
 *     `CONFLICT`, in one process and in four.
 *   • **N-P18-10** — a row rebuilt at version zero refuses a token minted under
 *     the previous incarnation, even though every number in it matches.
 *   • **N-P18-11** — the number alone is never the token; the incarnation is
 *     read inside the transaction, not at `open`.
 *   • **N-P18-12**, its structural half — a missing outbox answers absence as
 *     absence and never synthesises a `PENDING`.
 *
 * Everything else exists so those four cannot pass for the wrong reason. A
 * store that refused every mutation would satisfy all four, so the positives —
 * the sixteen lawful moves, the version arithmetic, the replay that conserves
 * the row — are not optional.
 *
 * **No wall-clock sleep anywhere.** Every instant is a literal the caller
 * supplies, and the cross-process race releases its children on a marker they
 * write rather than after a timer.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Five levels, not four: this file sits at
// packages/persistence/ledger/test/outbox-store/, so `../../../..` lands on
// `packages/` and the tsc lookup below would fail.
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const WORKER_ENTRY = join(PACKAGE_ROOT, "dist-test", "test", "outbox-race-worker", "index.js");

const I1 = "11111111-1111-4111-8111-111111111111";
const I2 = "22222222-2222-4222-8222-222222222222";
const TARGET_INCARNATION = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const DEADLINE = "2026-01-01T01:00:00.000Z";
const LATER_DEADLINE = "2026-01-02T01:00:00.000Z";
const DIGEST = "a".repeat(64);
const ATTEMPT_DIGEST = "b".repeat(64);
const COMMAND = "saga-1:dispatch:worktree_lease:/w/one";

const temporaryDirectories: string[] = [];
const openStores: OutboxStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-outbox-"));
  temporaryDirectories.push(directory);
  return directory;
}

function temporaryStorePath(): string {
  return join(temporaryDirectory(), "outbox.sqlite");
}

function open(path: string, incarnationId = I1, createdAt = CREATED_AT): OutboxStore {
  const store = openOutboxStore(path, { incarnationId, createdAt });
  openStores.push(store);
  return store;
}

function seedOf(overrides: Partial<OutboxMessageSeed> = {}): OutboxMessageSeed {
  return {
    outboxMessageId: "aaaaaaaa-0000-4000-8000-000000000001",
    sagaId: "saga-1",
    commandId: COMMAND,
    phase: "dispatch",
    intent: { stream: "control_plane_events", sequence: 7, sha256: DIGEST },
    commandKind: "REVOKE_LEASE",
    targetKind: "worktree_lease",
    targetId: "/w/one",
    fence: 7,
    targetStoreIncarnationId: TARGET_INCARNATION,
    state: "PENDING",
    deadlineAt: DEADLINE,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/**
 * A lawful statement of every mutable column for a move into `state`.
 *
 * `deadlineAt` always differs from the seed's, so no pair of the transition
 * table is accidentally a replay: the suite must see the trigger's answer, not
 * the store's short circuit in front of it.
 */
function mutationInto(state: OutboxState, row: OutboxRow, overrides: Partial<OutboxMutation> = {}): OutboxMutation {
  // A move into RECONCILING carries the anchor of the attempt it is
  // reconciling, because the schema requires one there. Supplying it here
  // keeps the transition table's forty-nine pairs a test of the transition
  // trigger rather than of the anchor CHECK, which has drills of its own.
  const lastAttempt =
    state === "RECONCILING" && row.lastAttempt === null
      ? ({ stream: "control_plane_events", sequence: 9, sha256: ATTEMPT_DIGEST } as const)
      : row.lastAttempt;
  return {
    state,
    attemptCount: lastAttempt === null ? 0 : Math.max(row.attemptCount, 1),
    nextEligibleAt: null,
    deadlineAt: LATER_DEADLINE,
    responseHandle: null,
    lastFailureCode: null,
    lastAttempt,
    ownerProcessId: state === "INFLIGHT" ? 4242 : null,
    updatedAt: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

/** A row seeded straight into `state`, with the columns that state requires. */
function seededIn(store: OutboxStore, state: OutboxState): OutboxRow {
  return store.insert(
    seedOf({
      state,
      ownerProcessId: state === "INFLIGHT" ? 1111 : null,
      ...(state === "RECONCILING"
        ? {
            attemptCount: 1,
            lastAttempt: { stream: "control_plane_events", sequence: 9, sha256: ATTEMPT_DIGEST },
          }
        : {}),
    }),
  );
}

/** A raw handle on the same file, for the drills that must bypass the module. */
function raw(path: string): Database.Database {
  return new Database(path);
}

// ---------------------------------------------------------------------------

describe("the path, and its single producer", () => {
  it("composes the outbox beside the ledger it belongs to", () => {
    expect(outboxStorePath("/var/acp/ledger.sqlite")).toBe("/var/acp/outbox.sqlite");
  });

  it("refuses a ledger path that is not one", () => {
    expect(() => outboxStorePath("")).toThrow(LedgerQueryError);
  });
});

describe("opening, and failing closed", () => {
  it("creates, migrates and reopens without changing anything", () => {
    const path = temporaryStorePath();
    const first = open(path);
    const incarnation = first.incarnation();
    first.close();

    const second = open(path, I2);
    // The stored incarnation stands. Rotating one is a restore, which
    // coordination 8.2 puts a quiescence proof in front of -- not an argument
    // to a constructor, and certainly not a side effect of reopening.
    expect(second.incarnation()).toEqual(incarnation);
    expect(incarnation).toEqual({ storeKind: "OUTBOX", incarnationId: I1, createdAt: CREATED_AT });
  });

  it("registers the incarnation as migration one, before the table it governs", () => {
    const path = temporaryStorePath();
    open(path).close();
    const handle = raw(path);
    const migrations = handle
      .prepare("SELECT version, name FROM outbox_schema_migrations ORDER BY version ASC")
      .all() as { version: number; name: string }[];
    handle.close();
    expect(migrations).toEqual([
      { version: 1, name: "coordination_store_meta" },
      { version: 2, name: "outbox_message" },
    ]);
  });

  it("keeps its own migration bookkeeping name, apart from every sibling", () => {
    const path = temporaryStorePath();
    open(path).close();
    const handle = raw(path);
    const tables = (
      handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%schema_migrations'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    handle.close();
    expect(tables).toEqual(["outbox_schema_migrations"]);
  });

  it("refuses an incarnation it was not given", () => {
    const path = temporaryStorePath();
    expect(() => openOutboxStore(path, { incarnationId: "", createdAt: CREATED_AT })).toThrow(LedgerQueryError);
    expect(() => openOutboxStore(path, { incarnationId: I1, createdAt: "" })).toThrow(LedgerQueryError);
  });

  it("refuses a directory, a file that is not SQLite, and a ledger", () => {
    const directory = temporaryDirectory();
    expect(() => open(directory)).toThrow(LedgerOpenError);

    const notSqlite = join(temporaryDirectory(), "outbox.sqlite");
    writeFileSync(notSqlite, "this is not a database");
    expect(() => open(notSqlite)).toThrow(LedgerOpenError);

    const ledgerLike = join(temporaryDirectory(), "outbox.sqlite");
    const handle = raw(ledgerLike);
    handle.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;");
    handle.close();
    expect(() => open(ledgerLike)).toThrow(LedgerOpenError);
  });

  it("refuses a sibling coordination store of this package", () => {
    for (const sibling of ["lease_schema_migrations", "tool_claim_schema_migrations"]) {
      const path = join(temporaryDirectory(), "outbox.sqlite");
      const handle = raw(path);
      handle.exec("CREATE TABLE " + sibling + " (version INTEGER PRIMARY KEY) STRICT;");
      handle.close();
      expect(() => open(path)).toThrow(LedgerOpenError);
    }
  });

  it("refuses a coordination file whose store kind is not OUTBOX", () => {
    const path = temporaryStorePath();
    open(path).close();
    const handle = raw(path);
    handle.exec("UPDATE coordination_store_meta SET store_kind = 'TOOL_CLAIM' WHERE singleton_id = 1");
    handle.close();
    // The guard is reachable because the CHECK carries all five kinds of the
    // section 8.1 dictionary. Narrowed to 'OUTBOX' it could not be constructed,
    // and a guard nobody can drill is not a guard.
    expect(() => open(path)).toThrow(LedgerOpenError);
  });

  it("refuses a migration history this build does not carry", () => {
    const path = temporaryStorePath();
    open(path).close();
    const handle = raw(path);
    handle.exec("UPDATE outbox_schema_migrations SET sha256 = 'deadbeef' WHERE version = 2");
    handle.close();
    expect(() => open(path)).toThrow(LedgerMigrationError);
  });

  it("refuses every verb after close", () => {
    const path = temporaryStorePath();
    const store = open(path);
    store.close();
    expect(() => store.read(COMMAND)).toThrow(LedgerClosedError);
    expect(() => store.readToken(COMMAND)).toThrow(LedgerClosedError);
    expect(() => store.incarnation()).toThrow(LedgerClosedError);
    expect(() => store.listOverdue(DEADLINE)).toThrow(LedgerClosedError);
    expect(() => store.insert(seedOf())).toThrow(LedgerClosedError);
  });

  it("holds exactly one metadata row, by CHECK rather than by convention", () => {
    const path = temporaryStorePath();
    open(path).close();
    const handle = raw(path);
    expect(() =>
      handle
        .prepare(
          "INSERT INTO coordination_store_meta (singleton_id, store_kind, store_incarnation_id, created_at)" +
            " VALUES (2, 'OUTBOX', ?, ?)",
        )
        .run(I2, CREATED_AT),
    ).toThrow();
    handle.close();
  });
});

// ---------------------------------------------------------------------------

describe("identity, and what this store does not compute", () => {
  it("does not derive command_id: what the caller supplies is what is stored", () => {
    const store = open(temporaryStorePath());
    // Deliberately not the deterministic composition of section 6 -- a value
    // no derivation over (saga_id, phase, target_kind, target_id) could
    // produce. It is stored verbatim, which is the whole of this store's
    // relationship with the command identity: it imposes uniqueness and
    // nothing else. Escalon F computes the key.
    const row = store.insert(seedOf({ commandId: "not-a-composition-of-anything" }));
    expect(row.commandId).toBe("not-a-composition-of-anything");
    expect(store.read("not-a-composition-of-anything")?.outboxMessageId).toBe(row.outboxMessageId);
    expect(store.read("saga-1:dispatch:worktree_lease:/w/one")).toBeNull();
  });

  it("groups by saga and is unique by command", () => {
    const store = open(temporaryStorePath());
    store.insert(seedOf({ commandId: "c-1", outboxMessageId: "m-1", targetId: "/w/one" }));
    store.insert(
      seedOf({
        commandId: "c-2",
        outboxMessageId: "m-2",
        commandKind: "RELEASE_RESERVATION",
        targetKind: "account_reservation",
        targetId: "r-9",
      }),
    );
    // One saga revoking a lease and releasing a reservation: two rows, one
    // grouper. The uniqueness is on the command, not on the group.
    expect(store.read("c-1")?.sagaId).toBe("saga-1");
    expect(store.read("c-2")?.sagaId).toBe("saga-1");
    expect(() => store.insert(seedOf({ commandId: "c-1", outboxMessageId: "m-3" }))).toThrow(LedgerQueryError);
  });

  it("keeps the failure code open text, with no vocabulary of its own", () => {
    const store = open(temporaryStorePath());
    const row = store.insert(seedOf());
    const token = store.readToken(COMMAND);
    // The catalogue lives in contracts section 16 and the writer imposes it.
    // A CHECK here would bind this file's schema to another package's list.
    const outcome = store.cas(token!, mutationInto("PENDING", row, { lastFailureCode: "ANY_CODE_AT_ALL" }));
    expect(outcome.verb).toBe("APPLIED");
    expect(outcome.row?.lastFailureCode).toBe("ANY_CODE_AT_ALL");
  });
});

// ---------------------------------------------------------------------------

describe("the schema's cross-column invariants", () => {
  it("pairs the fence with the incarnation it was issued under", () => {
    const store = open(temporaryStorePath());
    expect(() => store.insert(seedOf({ fence: 7, targetStoreIncarnationId: null }))).toThrow(LedgerQueryError);
    expect(() => store.insert(seedOf({ fence: null, targetStoreIncarnationId: TARGET_INCARNATION }))).toThrow(
      LedgerQueryError,
    );
    const row = store.insert(seedOf({ fence: null, targetStoreIncarnationId: null }));
    expect({ fence: row.fence, incarnation: row.targetStoreIncarnationId }).toEqual({ fence: null, incarnation: null });
  });

  it("takes the attempt anchor whole, and the counter follows it", () => {
    const store = open(temporaryStorePath());
    const anchor = { stream: "control_plane_events", sequence: 9, sha256: ATTEMPT_DIGEST } as const;

    // A partial triple is refused at the door, by field name.
    expect(() =>
      store.insert(seedOf({ attemptCount: 1, lastAttempt: { ...anchor, sha256: "short" } })),
    ).toThrow(LedgerQueryError);
    // An anchor with no attempt counted, and an attempt counted with no anchor.
    expect(() => store.insert(seedOf({ attemptCount: 0, lastAttempt: anchor }))).toThrow(LedgerQueryError);
    expect(() => store.insert(seedOf({ attemptCount: 1, lastAttempt: null }))).toThrow(LedgerQueryError);

    const row = store.insert(seedOf({ attemptCount: 1, lastAttempt: anchor }));
    expect(row.lastAttempt).toEqual(anchor);
  });

  it("requires an attempt to sit on the intention's own stream", () => {
    const store = open(temporaryStorePath());
    expect(() =>
      store.insert(
        seedOf({
          intent: { stream: "control_plane_events", sequence: 7, sha256: DIGEST },
          attemptCount: 1,
          lastAttempt: { stream: "account_events", sequence: 9, sha256: ATTEMPT_DIGEST },
        }),
      ),
    ).toThrow(LedgerQueryError);
  });

  it("names an owner exactly in INFLIGHT", () => {
    const store = open(temporaryStorePath());
    expect(() => store.insert(seedOf({ state: "INFLIGHT", ownerProcessId: null }))).toThrow(LedgerQueryError);
    expect(() => store.insert(seedOf({ state: "PENDING", ownerProcessId: 4242 }))).toThrow(LedgerQueryError);
    expect(store.insert(seedOf({ state: "INFLIGHT", ownerProcessId: 4242 })).ownerProcessId).toBe(4242);
  });

  it("gives a terminal row no backoff", () => {
    const store = open(temporaryStorePath());
    expect(() => store.insert(seedOf({ state: "DELIVERED", nextEligibleAt: DEADLINE }))).toThrow(LedgerQueryError);
    expect(store.insert(seedOf({ state: "DELIVERED", nextEligibleAt: null })).state).toBe("DELIVERED");
  });

  it("refuses a vocabulary it does not carry, and a digest that is not one", () => {
    const store = open(temporaryStorePath());
    expect(() => store.insert(seedOf({ state: "SENT" as OutboxState }))).toThrow(LedgerQueryError);
    expect(() => store.insert(seedOf({ commandKind: "EMAIL" as never }))).toThrow(LedgerQueryError);
    expect(() => store.insert(seedOf({ intent: { stream: "tool_events" as never, sequence: 1, sha256: DIGEST } }))).toThrow(
      LedgerQueryError,
    );
    expect(() =>
      store.insert(seedOf({ intent: { stream: "control_plane_events", sequence: 0, sha256: DIGEST } })),
    ).toThrow(LedgerQueryError);
    expect(() =>
      store.insert(seedOf({ intent: { stream: "control_plane_events", sequence: 1, sha256: DIGEST.toUpperCase() } })),
    ).toThrow(LedgerQueryError);
  });
});

// ---------------------------------------------------------------------------

describe("the compare-and-set", () => {
  it("applies the lawful move and raises the version by exactly one", () => {
    const store = open(temporaryStorePath());
    const row = store.insert(seedOf());
    expect(row.rowVersion).toBe(0);

    const token = store.readToken(COMMAND);
    expect(token).toEqual({ incarnationId: I1, commandId: COMMAND, expectedVersion: 0, expectedState: "PENDING" });

    const outcome = store.cas(token!, mutationInto("INFLIGHT", row));
    expect({ verb: outcome.verb, version: outcome.row?.rowVersion, state: outcome.row?.state }).toEqual({
      verb: "APPLIED",
      version: 1,
      state: "INFLIGHT",
    });
  });

  it("raises the version for every effective change, state or not", () => {
    const store = open(temporaryStorePath());
    let row = store.insert(seedOf());
    const changes: Partial<OutboxMutation>[] = [
      { nextEligibleAt: "2026-01-01T00:05:00.000Z" },
      { deadlineAt: "2026-01-03T00:00:00.000Z" },
      { responseHandle: "opaque-handle-1" },
      { lastFailureCode: "DESTINATION_BUSY" },
    ];
    for (const [index, change] of changes.entries()) {
      const token = store.readToken(COMMAND);
      const outcome = store.cas(token!, mutationInto("PENDING", row, { ...change, deadlineAt: row.deadlineAt, ...change }));
      expect({ change, verb: outcome.verb, version: outcome.row?.rowVersion }).toEqual({
        change,
        verb: "APPLIED",
        version: index + 1,
      });
      row = outcome.row!;
    }

    // The owner is the fifth class of change, and it needs a state that admits
    // one: the bicondicional refuses an owner outside INFLIGHT.
    const token = store.readToken(COMMAND);
    const owned = store.cas(token!, mutationInto("INFLIGHT", row, { deadlineAt: row.deadlineAt }));
    expect({ verb: owned.verb, version: owned.row?.rowVersion, owner: owned.row?.ownerProcessId }).toEqual({
      verb: "APPLIED",
      version: 5,
      owner: 4242,
    });
  });

  it("conserves the row on a replay, and the instant does not make one a change", () => {
    const store = open(temporaryStorePath());
    const row = store.insert(seedOf());
    const token = store.readToken(COMMAND);

    const replay = store.cas(token!, {
      state: row.state,
      attemptCount: row.attemptCount,
      nextEligibleAt: row.nextEligibleAt,
      deadlineAt: row.deadlineAt,
      responseHandle: row.responseHandle,
      lastFailureCode: row.lastFailureCode,
      lastAttempt: row.lastAttempt,
      ownerProcessId: row.ownerProcessId,
      // A fresh instant, as every retry carries. Were this counted as
      // substance, "replay sin cambio" would be a case that never occurs.
      updatedAt: "2026-01-01T00:59:00.000Z",
    });
    expect({ verb: replay.verb, version: replay.row?.rowVersion, updatedAt: replay.row?.updatedAt }).toEqual({
      verb: "UNCHANGED",
      version: 0,
      updatedAt: CREATED_AT,
    });
    expect(store.read(COMMAND)).toEqual(row);
  });

  it("refuses a version beyond the one this build can compare", () => {
    const store = open(temporaryStorePath());
    const row = store.insert(seedOf());
    expect(() =>
      store.cas(
        { incarnationId: I1, commandId: COMMAND, expectedVersion: MAX_OUTBOX_ROW_VERSION, expectedState: "PENDING" },
        mutationInto("INFLIGHT", row),
      ),
    ).toThrow(LedgerQueryError);
  });

  it("refuses an exhausted row at the schema, under a writer that skipped the door", () => {
    const path = temporaryStorePath();
    const store = open(path);
    store.insert(seedOf());
    store.close();

    // Staged by INSERT rather than by UPDATE: the version trigger fires on
    // every update, so a row cannot be walked to the ceiling in order to prove
    // that the ceiling holds.
    const handle = raw(path);
    handle
      .prepare(
        "INSERT INTO outbox_message (outbox_message_id, saga_id, command_id, phase, intent_stream," +
          " intent_sequence, intent_sha256, command_kind, target_kind, target_id, state, row_version," +
          " deadline_at, created_at, updated_at)" +
          " VALUES ('m-max', 'saga-1', 'c-max', 'dispatch', 'control_plane_events', 7, ?," +
          " 'NOTIFY', 'worktree_lease', '/w/max', 'PENDING', ?, ?, ?, ?)",
      )
      .run(DIGEST, MAX_OUTBOX_ROW_VERSION, DEADLINE, CREATED_AT, CREATED_AT);
    // The trigger, not the door: a version at the ceiling cannot move, and the
    // refusal is typed rather than a silent wrap to a number already issued.
    expect(() =>
      handle.prepare("UPDATE outbox_message SET row_version = row_version + 1 WHERE command_id = 'c-max'").run(),
    ).toThrow(/exhausted/);
    handle.close();
  });

  it("refuses any step that is not exactly one", () => {
    const path = temporaryStorePath();
    const store = open(path);
    store.insert(seedOf());
    store.close();

    const handle = raw(path);
    for (const version of [0, 2, 5]) {
      expect(() =>
        handle.prepare("UPDATE outbox_message SET row_version = ? WHERE command_id = ?").run(version, COMMAND),
      ).toThrow(/exactly one/);
    }
    handle.close();
  });

  it("holds identity, destination, fence and the original anchor immutable", () => {
    const path = temporaryStorePath();
    const store = open(path);
    store.insert(seedOf());
    store.close();

    const handle = raw(path);
    const immutable: readonly [string, string | number][] = [
      ["outbox_message_id", "another-id"],
      ["saga_id", "saga-2"],
      ["command_id", "another-command"],
      ["phase", "settle"],
      ["command_kind", "NOTIFY"],
      ["target_kind", "tool_claim"],
      ["target_id", "/w/two"],
      ["fence", 8],
      ["target_store_incarnation_id", I2],
      ["intent_stream", "account_events"],
      ["intent_sequence", 8],
      ["intent_sha256", "c".repeat(64)],
      ["created_at", "2026-02-01T00:00:00.000Z"],
    ];
    for (const [column, value] of immutable) {
      expect(() =>
        handle
          .prepare(
            "UPDATE outbox_message SET " + column + " = ?, row_version = row_version + 1 WHERE command_id = ?",
          )
          .run(value, COMMAND),
      ).toThrow(/immutable/);
    }
    handle.close();
  });
});

// ---------------------------------------------------------------------------

describe("the transition table, and nothing else", () => {
  it("admits exactly the moves the vocabulary names, over all forty-nine pairs", () => {
    const legal: string[] = [];
    const refused: string[] = [];

    for (const from of OUTBOX_STATES) {
      for (const to of OUTBOX_STATES) {
        const store = open(temporaryStorePath());
        const row = seededIn(store, from);
        const token = store.readToken(COMMAND);
        let applied = false;
        try {
          applied = store.cas(token!, mutationInto(to, row)).verb === "APPLIED";
        } catch {
          applied = false;
        }
        store.close();
        (applied ? legal : refused).push(from + " -> " + to);
      }
    }

    // The constant and the trigger are two statements of coordination section
    // 2. This is the proof that they agree, driven against the database rather
    // than asserted about the source: a same-state write is not a transition
    // and is lawful while the row lives; every listed edge applies; nothing
    // leaves a terminal, including to itself.
    const expected: string[] = [];
    for (const from of OUTBOX_STATES) {
      if ((OUTBOX_TERMINAL_STATES as readonly string[]).includes(from)) continue;
      expected.push(from + " -> " + from);
      for (const to of OUTBOX_TRANSITIONS.get(from) ?? []) expected.push(from + " -> " + to);
    }
    expect(legal.slice().sort()).toEqual(expected.slice().sort());
    expect(legal.length + refused.length).toBe(49);
    expect(legal).toHaveLength(16);
  });

  it("lets nothing out of a terminal, by any verb", () => {
    for (const terminal of OUTBOX_TERMINAL_STATES) {
      const store = open(temporaryStorePath());
      const row = seededIn(store, terminal);
      const token = store.readToken(COMMAND);
      expect({ terminal, token: token?.expectedState }).toEqual({ terminal, token: terminal });
      expect(() => store.cas(token!, mutationInto(terminal, row, { responseHandle: "late-relay" }))).toThrow(
        LedgerQueryError,
      );
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe("N-P18-9 -- zero rows is CONFLICT, and never a success", () => {
  it("conflicts when the version does not match, and leaves the row untouched", () => {
    const store = open(temporaryStorePath());
    const row = store.insert(seedOf());
    store.cas(store.readToken(COMMAND)!, mutationInto("PENDING", row, { responseHandle: "h" }));
    const current = store.read(COMMAND)!;
    expect(current.rowVersion).toBe(1);

    const stale = { incarnationId: I1, commandId: COMMAND, expectedVersion: 0, expectedState: "PENDING" } as const;
    const outcome = store.cas(stale, mutationInto("INFLIGHT", current));
    expect(outcome.verb).toBe("CONFLICT");
    // The refusal hands back what actually stands, so the caller re-reads from
    // the answer rather than from a second query against a moving target.
    expect(outcome.row).toEqual(current);
    expect(store.read(COMMAND)).toEqual(current);
  });

  it("conflicts on the right version and the wrong state: the predicate has three terms", () => {
    const store = open(temporaryStorePath());
    const row = store.insert(seedOf());
    const outcome = store.cas(
      { incarnationId: I1, commandId: COMMAND, expectedVersion: 0, expectedState: "INFLIGHT" },
      mutationInto("DELIVERED", row),
    );
    expect({ verb: outcome.verb, version: outcome.row?.rowVersion }).toEqual({ verb: "CONFLICT", version: 0 });
  });

  it("conflicts on a command nothing carries, and invents no row", () => {
    const store = open(temporaryStorePath());
    const row = store.insert(seedOf());
    const outcome = store.cas(
      { incarnationId: I1, commandId: "no-such-command", expectedVersion: 0, expectedState: "PENDING" },
      mutationInto("INFLIGHT", row),
    );
    expect(outcome).toEqual({ verb: "CONFLICT", row: null });
    expect(store.read("no-such-command")).toBeNull();
  });

  it("hands a conflicting caller nothing it could dispatch on", () => {
    const store = open(temporaryStorePath());
    const row = store.insert(seedOf());
    const outcome = store.cas(
      { incarnationId: I1, commandId: COMMAND, expectedVersion: 3, expectedState: "PENDING" },
      mutationInto("INFLIGHT", row),
    );
    // Not APPLIED, not UNCHANGED, and carrying no handle: only the winner of
    // PENDING -> INFLIGHT may prepare a dispatch, and this caller did not win.
    expect(outcome.verb).toBe("CONFLICT");
    expect(outcome.row?.state).toBe("PENDING");
    expect(outcome.row?.ownerProcessId).toBeNull();
    expect(outcome.row?.responseHandle).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("N-P18-10 and N-P18-11 -- the incarnation is what the number cannot be", () => {
  it("refuses a token from the previous incarnation at exactly the same version", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "outbox.sqlite");

    const before = open(path, I1);
    before.insert(seedOf());
    const token = before.readToken(COMMAND);
    expect(token).toEqual({ incarnationId: I1, commandId: COMMAND, expectedVersion: 0, expectedState: "PENDING" });
    before.close();

    // The restore: the file is gone and a new one takes its place, with a new
    // incarnation and the row rebuilt from the events -- at version zero,
    // because every row is born there.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    const after = open(path, I2);
    const rebuilt = after.insert(seedOf());
    expect(rebuilt.rowVersion).toBe(0);
    expect(after.incarnation().incarnationId).toBe(I2);

    // Every number in the old token matches the rebuilt row exactly. That is
    // the ABA, and the incarnation is the only thing that separates them.
    const stale = after.cas(token!, mutationInto("INFLIGHT", rebuilt));
    expect(stale.verb).toBe("CONFLICT");
    expect(after.read(COMMAND)?.rowVersion).toBe(0);

    // And the same set applies once the caller carries the incarnation that is
    // actually live -- which proves the refusal was about the incarnation and
    // not about anything else in the tuple.
    const fresh = after.cas({ ...token!, incarnationId: I2 }, mutationInto("INFLIGHT", rebuilt));
    expect({ verb: fresh.verb, version: fresh.row?.rowVersion }).toEqual({ verb: "APPLIED", version: 1 });
  });

  it("checks the incarnation inside the transaction, not at open", () => {
    const path = temporaryStorePath();
    const store = open(path, I1);
    const row = store.insert(seedOf());
    const token = store.readToken(COMMAND);

    // A restore under a handle that is already open. A store that read the
    // incarnation once at `open` would pass this by accident and fail in the
    // field, which is the reason section 6.1 puts the check inside BEGIN
    // IMMEDIATE rather than in the constructor.
    const handle = raw(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();

    expect(store.incarnation().incarnationId).toBe(I2);
    expect(store.cas(token!, mutationInto("INFLIGHT", row)).verb).toBe("CONFLICT");
    expect(store.cas({ ...token!, incarnationId: I2 }, mutationInto("INFLIGHT", row)).verb).toBe("APPLIED");
  });

  it("keeps the destination's incarnation, and never substitutes its own", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "outbox.sqlite");
    const before = open(path, I1);
    before.insert(seedOf({ fence: 7, targetStoreIncarnationId: TARGET_INCARNATION }));
    before.close();

    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    const after = open(path, I2);
    const rebuilt = after.insert(seedOf({ fence: 7, targetStoreIncarnationId: TARGET_INCARNATION }));

    // Two incarnations in one file with opposite roles. The destination's is
    // carried from the intention in the ledger; writing the live one here
    // would be inventing authority over a fence this store does not own.
    expect({
      target: rebuilt.targetStoreIncarnationId,
      fence: rebuilt.fence,
      store: after.incarnation().incarnationId,
    }).toEqual({ target: TARGET_INCARNATION, fence: 7, store: I2 });
  });

  it("issues a token that is the incarnation and the row, never a bare number", () => {
    const store = open(temporaryStorePath());
    store.insert(seedOf({ fence: 7 }));
    const token = store.readToken(COMMAND);
    // The four terms of section 6.1, and the fence is not one of them: a fence
    // belongs to the destination, and this store authorises nothing with it.
    expect(Object.keys(token as object).sort()).toEqual([
      "commandId",
      "expectedState",
      "expectedVersion",
      "incarnationId",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("N-P18-12 -- losing the file produces no false PENDING", () => {
  it("answers absence as absence on a fresh file", () => {
    const store = open(temporaryStorePath());
    // A cache with nothing in it, not a queue with nothing due. The store
    // synthesises no row and no state: what is owed lives in the ledger.
    expect(store.read(COMMAND)).toBeNull();
    expect(store.readToken(COMMAND)).toBeNull();
    expect(store.listOverdue("2030-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("answers absence as absence after the file is destroyed", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "outbox.sqlite");
    const before = open(path);
    before.insert(seedOf());
    expect(before.read(COMMAND)?.state).toBe("PENDING");
    before.close();

    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    const after = open(path, I2);
    expect(after.read(COMMAND)).toBeNull();
    expect(after.listOverdue("2030-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("lets a row be born RECONCILING, not only PENDING", () => {
    const store = open(temporaryStorePath());
    // A durable attempt with no outcome is reconstructed here, never at
    // PENDING. The initial state is a parameter for exactly this reason; the
    // half that reads the events and decides which rows to rebuild is
    // escalon F's.
    const row = store.insert(
      seedOf({
        state: "RECONCILING",
        attemptCount: 1,
        lastAttempt: { stream: "control_plane_events", sequence: 9, sha256: ATTEMPT_DIGEST },
      }),
    );
    expect({ state: row.state, attempts: row.attemptCount }).toEqual({ state: "RECONCILING", attempts: 1 });
  });

  it("refuses a row born RECONCILING without its attempt anchor", () => {
    const store = open(temporaryStorePath());
    // The CHECK is what keeps the reconstruction honest: a row that claims a
    // durable attempt must be able to point at it.
    expect(() => store.insert(seedOf({ state: "RECONCILING", attemptCount: 0, lastAttempt: null }))).toThrow(
      LedgerQueryError,
    );
  });
});

// ---------------------------------------------------------------------------

describe("expiry obliges a caller and authorises nothing here", () => {
  it("lists the overdue and moves none of them", () => {
    const store = open(temporaryStorePath());
    store.insert(seedOf({ commandId: "c-1", outboxMessageId: "m-1", deadlineAt: "2026-01-01T00:30:00.000Z" }));
    store.insert(
      seedOf({
        commandId: "c-2",
        outboxMessageId: "m-2",
        state: "INFLIGHT",
        ownerProcessId: 4242,
        deadlineAt: "2026-01-01T00:10:00.000Z",
      }),
    );
    store.insert(seedOf({ commandId: "c-3", outboxMessageId: "m-3", deadlineAt: "2026-01-02T00:00:00.000Z" }));
    store.insert(
      seedOf({ commandId: "c-4", outboxMessageId: "m-4", state: "DELIVERED", deadlineAt: "2026-01-01T00:01:00.000Z" }),
    );

    const overdue = store.listOverdue("2026-01-01T00:40:00.000Z");
    expect(overdue.map((row) => row.commandId)).toEqual(["c-2", "c-1"]);
    // An expired INFLIGHT obliges reconciliation; it does not perform one. The
    // rows come back exactly as they were, at the version they were at.
    expect(overdue.map((row) => row.state)).toEqual(["INFLIGHT", "PENDING"]);
    expect(overdue.every((row) => row.rowVersion === 0)).toBe(true);
    expect(store.read("c-2")?.state).toBe("INFLIGHT");
  });

  it("offers no verb that moves a row by the clock", () => {
    const store = open(temporaryStorePath());
    // `sweep` is the lease store's, and it is lawful there because releasing a
    // lease concedes nothing. Here the same shape would be a transition the
    // vocabulary does not admit, so there is no verb to name.
    expect(Object.keys(store).sort()).toEqual([
      "cas",
      "close",
      "incarnation",
      "insert",
      "listOverdue",
      "read",
      "readToken",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("what this module does not do", () => {
  it("reads no clock, no environment and no process", () => {
    const source = readModuleSource();
    for (const forbidden of ["Date.now(", "new Date(", "process.env", "process.pid", "process.hrtime"]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("mints no identity of its own", () => {
    const source = readModuleSource();
    // Not the incarnation, not the message id, not the command id. Every
    // identity is the caller's argument -- which is also what makes the ABA
    // drill above aimable at all.
    for (const forbidden of ["randomUUID", "randomBytes", "Math.random"]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("contains no DELETE at all", () => {
    expect(readModuleSource().includes("DELETE")).toBe(false);
  });

  it("names no credential vocabulary", () => {
    const source = readModuleSource();
    // `response_handle` is an opaque reference and never a secret. Nothing in
    // this module constructs one, so nothing here can put sensitive material
    // into a column that is read back by whoever can read the file.
    for (const forbidden of ["secret", "password", "apiKey", "Authorization", "credential", "bearer"]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("carries the response handle through untouched", () => {
    const store = open(temporaryStorePath());
    const row = store.insert(seedOf());
    const handle = "opaque:7f3a/reference";
    const outcome = store.cas(store.readToken(COMMAND)!, mutationInto("PENDING", row, { responseHandle: handle }));
    expect(outcome.row?.responseHandle).toBe(handle);
  });
});

// ---------------------------------------------------------------------------

interface WorkerOutcome {
  readonly ok: boolean;
  readonly verb: string | null;
  readonly rowVersion: number | null;
  readonly state: string | null;
  readonly ownerProcessId: number | null;
  readonly errorName: string | null;
}

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
      "could not build the ledger test tree for the cross-process test: " + result.stdout + result.stderr,
    );
  }
}

/**
 * Start a racer and resolve once it has read its token and is waiting.
 *
 * The two halves are separate on purpose: every racer must be holding a token
 * for the same version before any of them is released, which is the situation
 * this store exists to arbitrate.
 */
function startWorker(
  storePath: string,
  incarnationId: string,
  commandId: string,
  targetState: string,
  tokenVersion?: number,
): Promise<{ readonly release: () => void; readonly outcome: Promise<WorkerOutcome> }> {
  const argv = [WORKER_ENTRY, storePath, incarnationId, commandId, targetState];
  if (tokenVersion !== undefined) argv.push(String(tokenVersion));
  const child = spawn(process.execPath, argv, { stdio: ["pipe", "pipe", "pipe"] });

  const outcome = new Promise<WorkerOutcome>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      const line = stdout.trim().split("\n").at(-1);
      if (line === undefined || line.length === 0) {
        reject(new Error("the worker printed no outcome"));
        return;
      }
      resolve(JSON.parse(line) as WorkerOutcome);
    });
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) {
        resolve({
          release: () => {
            child.stdin.write("g");
          },
          outcome,
        });
      }
    });
  });
}

describe("cross-process arbitration", () => {
  it("applies exactly one when four processes hold the same version", async () => {
    ensureWorkerBuilt();
    const path = temporaryStorePath();

    const seeder = open(path, I1);
    seeder.insert(seedOf());
    // Release the file so the children genuinely contend for the write lock
    // rather than queueing behind this handle.
    seeder.close();
    openStores.length = 0;

    const racers = await Promise.all([
      startWorker(path, I1, COMMAND, "INFLIGHT"),
      startWorker(path, I1, COMMAND, "INFLIGHT"),
      startWorker(path, I1, COMMAND, "INFLIGHT"),
      startWorker(path, I1, COMMAND, "INFLIGHT"),
    ]);
    for (const racer of racers) racer.release();
    const outcomes = await Promise.all(racers.map((racer) => racer.outcome));

    // This is the escalon's reason to exist. Four processes read version zero,
    // four compare-and-set against it, and a second APPLIED would mean two
    // dispatchers both believe they may send. It is a stop condition, not a
    // flake.
    const applied = outcomes.filter((outcome) => outcome.verb === "APPLIED");
    const conflicts = outcomes.filter((outcome) => outcome.verb === "CONFLICT");
    expect({ applied: applied.length, conflicts: conflicts.length }).toEqual({ applied: 1, conflicts: 3 });
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);

    // The losers were handed the row as it stands and no success of any kind:
    // zero rows changed is a re-read, never an implicit resend.
    expect(conflicts.every((outcome) => outcome.rowVersion === 1)).toBe(true);
    expect(conflicts.every((outcome) => outcome.state === "INFLIGHT")).toBe(true);

    const store = open(path, I1);
    const row = store.read(COMMAND);
    expect({ version: row?.rowVersion, state: row?.state }).toEqual({ version: 1, state: "INFLIGHT" });
    // The row names the winner, not merely somebody.
    expect(row?.ownerProcessId).toBe(applied[0]?.ownerProcessId);
  });

  it("refuses a token from another incarnation across processes too", async () => {
    ensureWorkerBuilt();
    const path = temporaryStorePath();
    const seeder = open(path, I1);
    seeder.insert(seedOf());
    seeder.close();
    openStores.length = 0;

    const racer = await startWorker(path, I1, COMMAND, "INFLIGHT");
    // The restore lands while the racer holds its token, between its read and
    // its write -- the window the whole mechanism is about.
    const handle = raw(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();
    racer.release();

    const outcome = await racer.outcome;
    expect({ ok: outcome.ok, verb: outcome.verb }).toEqual({ ok: true, verb: "CONFLICT" });

    const store = open(path, I2);
    expect(store.read(COMMAND)?.rowVersion).toBe(0);
  });
});

/**
 * The module's code with its prose removed.
 *
 * The claims above are about what the module *does*, so they are asserted over
 * code and not over comments — a docblock that explains why there is no
 * `DELETE` must not read as a `DELETE`. This is the same distinction the
 * architecture fence draws with its own `stripComments`, restated locally
 * because the fence is not importable from a package suite.
 */
function readModuleSource(): string {
  const source = readFileSync(join(PACKAGE_ROOT, "src", "outbox-store", "index.ts"), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
