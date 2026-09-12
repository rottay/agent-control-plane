import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerClosedError,
  LedgerIntegrityError,
  LedgerMigrationError,
  LedgerOpenError,
  LedgerQueryError,
} from "../../src/errors/index.js";
import {
  TOOL_CLAIM_STATES,
  openToolClaimStore,
  toolClaimStorePath,
} from "../../src/tool-claim-store/index.js";
import type { ToolClaimGrant, ToolClaimStore } from "../../src/tool-claim-store/index.js";

/**
 * Evidence for the tool-coordinate claim store (V2 X1a).
 *
 * The packet's reason to exist is that one coordinate may be taken once, and the
 * assertions that carry it are **S2** — a second decision sees the *written* row
 * rather than the state its caller read before the lock — and **S4**, that the
 * three states are one-way.
 *
 * Everything else exists so those cannot pass for the wrong reason: that expiry
 * is the caller's judgement and not the store's (S3, S10), that a throwing
 * decision leaves nothing behind (S5), that the recovery record survives
 * verbatim (S7), and that a store whose migration history this build does not
 * understand refuses to open at all (S9).
 *
 * No wall-clock sleep and no clock: every instant here is an argument.
 */

const KEY = "task-1|1|tool.call.0";
const T0 = "2026-09-04T05:00:00.000Z";
const T1 = "2026-09-04T05:00:30.000Z";
const T2 = "2026-09-04T05:01:00.000Z";

const directories: string[] = [];
const stores: ToolClaimStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const created = mkdtempSync(join(tmpdir(), "acp-x1a-"));
  directories.push(created);
  return created;
}

function open(path: string, options: Parameters<typeof openToolClaimStore>[1] = {}): ToolClaimStore {
  const store = openToolClaimStore(path, options);
  stores.push(store);
  return store;
}

function temporaryStore(): { store: ToolClaimStore; path: string } {
  const path = join(temporaryDirectory(), "tool-claims.sqlite");
  return { store: open(path), path };
}

// ---------------------------------------------------------------------------
// The incarnation fixtures (P-18/protocolo E1)
// ---------------------------------------------------------------------------

const I1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const I2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const CREATED_AT = "2026-09-12T00:00:00.000Z";

/**
 * The checksum of migration 1, pinned as a literal.
 *
 * This is the whole of "migration 2 changed nothing that shipped": a shipped
 * migration is compared against this source on every open, so an edit to
 * `tool_claim`'s DDL moves this digest and every store in the field refuses to
 * reopen. Pinned rather than recomputed, because a test that recomputed it would
 * agree with any edit at all — and because the legacy fixture below has to write
 * the digest a previous build recorded.
 */
const MIGRATION_ONE_SHA256 = "ccf0061592ed755fbc5817f1fb2998ec817867f3c85530de9d0ef2067a0b9cc0";

/** Migration 1 verbatim, as a build that predates the metadata left it. */
const MIGRATION_ONE_SQL = `
CREATE TABLE tool_claim (
  coordinate_key TEXT    NOT NULL PRIMARY KEY,
  state          TEXT    NOT NULL,
  claim_id       TEXT,
  holder         TEXT,
  claimed_at     TEXT,
  expires_at     TEXT,
  in_flight_at   TEXT,
  settled_at     TEXT,
  task_id        TEXT    NOT NULL,
  attempt        INTEGER NOT NULL,
  transition_id  TEXT    NOT NULL,
  submitted_at   TEXT    NOT NULL,
  account_id     TEXT    NOT NULL,
  server_id      TEXT    NOT NULL,
  tool_name      TEXT    NOT NULL,
  argument_bytes INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX tool_claim_claim_id
  ON tool_claim (claim_id)
  WHERE claim_id IS NOT NULL;
`;

function storePath(): string {
  return join(temporaryDirectory(), "tool-claims.sqlite");
}

/**
 * A claim file as the previous build wrote it: migration 1 only, with a row.
 *
 * Built by hand rather than by checking out an old build, because what has to be
 * reproduced is the *file*, and the file is fully described by its schema and
 * its migration bookkeeping. If this fixture drifted from what the previous
 * build produced, the open would fail on the checksum rather than pass for the
 * wrong reason.
 */
function legacyClaimFile(state: string): string {
  const path = storePath();
  const handle = new Database(path);
  handle.exec(
    "CREATE TABLE IF NOT EXISTS tool_claim_schema_migrations (" +
      " version INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL) STRICT;",
  );
  handle.exec(MIGRATION_ONE_SQL);
  handle
    .prepare("INSERT INTO tool_claim_schema_migrations (version, name, sha256) VALUES (1, 'tool_claim', ?)")
    .run(MIGRATION_ONE_SHA256);
  handle
    .prepare(
      "INSERT INTO tool_claim (coordinate_key, state, claim_id, holder, claimed_at, expires_at," +
        " in_flight_at, settled_at, task_id, attempt, transition_id, submitted_at, account_id," +
        " server_id, tool_name, argument_bytes)" +
        " VALUES (?, ?, 'legacy-claim', 'opus@legacy', ?, ?, ?, NULL," +
        " '11111111-2222-4333-8444-555555555555', 1, 'tool.call.0', ?, 'acct-legacy', 'docs'," +
        " 'docs.search', 42)",
    )
    .run(KEY, state, T0, T1, state === "IN_FLIGHT" ? T0 : null, T0);
  handle.close();
  return path;
}

function grantOf(overrides: Partial<ToolClaimGrant> = {}): ToolClaimGrant {
  return {
    claimId: "11111111-1111-4111-8111-111111111111",
    holder: "claude/opus/implementer/01",
    claimedAt: T0,
    expiresAt: T1,
    taskId: "11111111-2222-4333-8444-555555555555",
    attempt: 1,
    transitionId: "tool.call.0",
    submittedAt: T0,
    accountId: "acct-x1a",
    serverId: "docs",
    toolName: "docs.search",
    argumentBytes: 42,
    ...overrides,
  };
}

function caught(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error: unknown) {
    return error;
  }
}

// ---------------------------------------------------------------------------

describe("S1 — a coordinate is taken once, and the row is created claimed", () => {
  it("creates the record in CLAIMED with the whole recovery set", () => {
    const { store } = temporaryStore();
    const outcome = store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));

    expect(outcome.verb).toBe("TAKE");
    const row = store.read(KEY);
    expect(row?.state).toBe("CLAIMED");
    expect(row?.claimId).toBe(grantOf().claimId);
    expect(row?.inFlightAt).toBeNull();
    expect(row?.settledAt).toBeNull();
    // Three states and no fourth: a poison is a caller's SETTLE, not a state.
    expect([...TOOL_CLAIM_STATES]).toEqual(["CLAIMED", "IN_FLIGHT", "SETTLED"]);
  });
});

describe("S2 — the decision sees the written row, never a stale read", () => {
  it("hands decide the record as it is inside the lock", () => {
    const { store, path } = temporaryStore();
    const second = open(path);

    // A caller reads, and finds nothing.
    const stale = second.read(KEY);
    expect(stale).toBeNull();

    // Another handle takes the coordinate in between.
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));

    // The second caller's decision must see the take, not the emptiness it read.
    // This is the packet's whole mechanism: the PRIMARY KEY prevents two
    // records, and only the immediate transaction prevents two decisions.
    let seen: unknown = "decide did not run";
    const outcome = second.transact(KEY, (current) => {
      seen = current?.state ?? null;
      return { verb: "REFUSE", reason: "CLAIM_HELD" };
    });
    expect(seen).toBe("CLAIMED");
    expect(outcome).toEqual({
      verb: "REFUSE",
      reason: "CLAIM_HELD",
      row: store.read(KEY),
    });
  });

  it("refuses without writing anything", () => {
    const { store } = temporaryStore();
    const outcome = store.transact(KEY, () => ({ verb: "REFUSE", reason: "CLAIM_HELD" }));
    expect(outcome).toEqual({ verb: "REFUSE", reason: "CLAIM_HELD", row: null });
    // A refusal on an unknown coordinate creates no record: the store does not
    // write under a read.
    expect(store.read(KEY)).toBeNull();
  });
});

describe("S3 — expiry is the caller's judgement, and a reclaim is not silent", () => {
  it("lets a caller retake an expired CLAIMED coordinate, in place", () => {
    const { store } = temporaryStore();
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    const before = store.read(KEY);

    // The caller compares `expiresAt` against its own `now` and decides. The
    // store neither knows the time nor forms an opinion about it.
    const outcome = store.transact(KEY, (current) => {
      const expired = current !== null && current.expiresAt !== null && current.expiresAt <= T2;
      return expired
        ? { verb: "TAKE", row: grantOf({ claimId: "22222222-2222-4222-8222-222222222222", claimedAt: T2, expiresAt: "2026-09-04T05:01:30.000Z" }) }
        : { verb: "REFUSE", reason: "CLAIM_HELD" };
    });

    expect(outcome.verb).toBe("TAKE");
    const after = store.read(KEY);
    expect(after?.claimId).toBe("22222222-2222-4222-8222-222222222222");
    expect(after?.state).toBe("CLAIMED");
    // Reclaimed in place: the record was never deleted, and the reclaimer has
    // attempted no effect, so the in-flight stamp is cleared rather than kept.
    expect(after?.inFlightAt).toBeNull();
    expect(before?.coordinateKey).toBe(after?.coordinateKey);
  });

  it("never re-grants an expired IN_FLIGHT coordinate on its own", () => {
    const { store } = temporaryStore();
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T0 }));

    // An expired IN_FLIGHT is the dangerous case: the effect may have run. The
    // store offers no verb that quietly re-grants it — the caller's only honest
    // moves are to refuse, or to promote a poison receipt and SETTLE.
    const refused = store.transact(KEY, () => ({ verb: "REFUSE", reason: "POSTCONDITION_UNKNOWN" }));
    expect(refused.verb).toBe("REFUSE");
    expect(store.read(KEY)?.state).toBe("IN_FLIGHT");

    const settled = store.transact(KEY, () => ({ verb: "SETTLE", at: T2 }));
    expect(settled.verb).toBe("SETTLE");
    expect(store.read(KEY)?.state).toBe("SETTLED");
  });
});

describe("S4 — the three states are one-way", () => {
  it("advances CLAIMED to IN_FLIGHT to SETTLED and never backwards", () => {
    const { store } = temporaryStore();
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T0 }));
    expect(store.read(KEY)?.inFlightAt).toBe(T0);

    // Not twice: only a CLAIMED coordinate may open the window.
    expect(caught(() => store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T1 })))).toBeInstanceOf(
      LedgerQueryError,
    );

    store.transact(KEY, () => ({ verb: "SETTLE", at: T1 }));
    expect(store.read(KEY)?.state).toBe("SETTLED");

    // Terminal, in every direction. A settled coordinate is spent forever: it
    // cannot be settled again, re-opened, or advanced.
    expect(caught(() => store.transact(KEY, () => ({ verb: "SETTLE", at: T2 })))).toBeInstanceOf(
      LedgerQueryError,
    );
    expect(caught(() => store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T2 })))).toBeInstanceOf(
      LedgerQueryError,
    );
    expect(store.read(KEY)?.state).toBe("SETTLED");

    // And not by the back door either. `TAKE` is the one verb that rewrites the
    // row in place, so before V2 X1b it could re-open a spent coordinate and
    // clear its `settled_at` — terminality enforced for two verbs out of three.
    const before = store.read(KEY);
    expect(
      caught(() => store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }))),
    ).toBeInstanceOf(LedgerQueryError);
    expect(store.read(KEY)).toEqual(before);
    expect(store.read(KEY)?.settledAt).toBe(T1);
  });

  it("refuses to advance a coordinate nobody claimed", () => {
    const { store } = temporaryStore();
    for (const decision of [
      { verb: "MARK_IN_FLIGHT", at: T0 } as const,
      { verb: "SETTLE", at: T0 } as const,
    ]) {
      expect(caught(() => store.transact(KEY, () => decision))).toBeInstanceOf(LedgerQueryError);
      expect(store.read(KEY)).toBeNull();
    }
  });
});

describe("S5 — a throwing decision leaves nothing behind", () => {
  it("rolls back and rethrows, byte-unchanged", () => {
    const { store } = temporaryStore();
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    const before = store.read(KEY);

    const failure = caught(() =>
      store.transact(KEY, () => {
        throw new Error("policy exploded");
      }),
    );
    expect((failure as Error).message).toBe("policy exploded");
    expect(store.read(KEY)).toEqual(before);
  });

  it("writes nothing when a grant is malformed", () => {
    const { store } = temporaryStore();
    expect(
      caught(() => store.transact(KEY, () => ({ verb: "TAKE", row: grantOf({ claimId: "" }) }))),
    ).toBeInstanceOf(LedgerQueryError);
    expect(store.read(KEY)).toBeNull();
    expect(
      caught(() => store.transact(KEY, () => ({ verb: "TAKE", row: grantOf({ attempt: 0 }) }))),
    ).toBeInstanceOf(LedgerQueryError);
    expect(store.read(KEY)).toBeNull();
  });
});

describe("S6 — the module contains no DELETE", () => {
  it("cannot remove a claim, and says so in its own source", () => {
    // The record is created once and never deleted, so a coordinate's history
    // cannot be erased by the thing that arbitrates it. Asserted over code with
    // the prose removed: a docblock explaining an absence must not read as a
    // presence.
    expect(codeOfModule().includes("DELETE")).toBe(false);
  });
});

describe("S7 — the recovery record round-trips exactly", () => {
  it("returns every field a recoverer needs, unchanged", () => {
    const { store, path } = temporaryStore();
    const grant = grantOf({ argumentBytes: 0, attempt: 7, toolName: "docs.搜索" });
    store.transact(KEY, () => ({ verb: "TAKE", row: grant }));

    const first = store.read(KEY);
    const second = open(path).read(KEY);
    // Two reads, two handles, identical values — which is what lets any
    // recoverer rebuild a byte-identical receipt from the claim rather than
    // from itself.
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      taskId: grant.taskId,
      attempt: 7,
      transitionId: grant.transitionId,
      submittedAt: grant.submittedAt,
      accountId: grant.accountId,
      serverId: grant.serverId,
      toolName: "docs.搜索",
      argumentBytes: 0,
    });
    // And they survive the transitions, because a recoverer arrives late.
    store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T0 }));
    expect(store.read(KEY)).toMatchObject({ toolName: "docs.搜索", argumentBytes: 0, attempt: 7 });
  });
});

describe("S8 — the path has one producer and is pure", () => {
  it("derives from the ledger path, stably", () => {
    const ledgerPath = "/tmp/scenario/control-plane.sqlite";
    const once = toolClaimStorePath(ledgerPath);
    expect(once).toBe(toolClaimStorePath(ledgerPath));
    // Beside the ledger, never inside it, and never the ledger itself.
    expect(dirname(once)).toBe(dirname(ledgerPath));
    expect(once).not.toBe(ledgerPath);
    expect(toolClaimStorePath("/other/place/control-plane.sqlite")).not.toBe(once);
    expect(caught(() => toolClaimStorePath(""))).toBeInstanceOf(LedgerQueryError);
  });
});

describe("S9 — a history this build does not understand refuses to open", () => {
  it("refuses a checksum mismatch, and never migrates around it", () => {
    const { store, path } = temporaryStore();
    store.close();
    const db = new Database(path);
    db.prepare("UPDATE tool_claim_schema_migrations SET sha256 = ? WHERE version = 1").run("0".repeat(64));
    db.close();
    expect(caught(() => openToolClaimStore(path))).toBeInstanceOf(LedgerMigrationError);
  });

  it("refuses a file that already belongs to another store in this package", () => {
    // A rule rather than a list of foreign table names: every database in this
    // package records its migrations under a name ending `schema_migrations`,
    // so one already present means the file is somebody else's.
    const path = join(temporaryDirectory(), "not-ours.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;");
    db.close();
    expect(caught(() => openToolClaimStore(path))).toBeInstanceOf(LedgerOpenError);
  });

  it("fails closed on a directory, a corrupt file and an empty path", () => {
    const directory = temporaryDirectory();
    expect(caught(() => openToolClaimStore(directory))).toBeInstanceOf(LedgerOpenError);
    const corrupt = join(directory, "corrupt.sqlite");
    writeFileSync(corrupt, "this is not a database");
    expect(caught(() => openToolClaimStore(corrupt))).toBeInstanceOf(LedgerOpenError);
    expect(caught(() => openToolClaimStore(""))).toBeInstanceOf(LedgerQueryError);
  });

  it("refuses every verb after close", () => {
    const { store } = temporaryStore();
    store.close();
    expect(caught(() => store.read(KEY))).toBeInstanceOf(LedgerClosedError);
    expect(caught(() => store.transact(KEY, () => ({ verb: "REFUSE", reason: "x" })))).toBeInstanceOf(
      LedgerClosedError,
    );
  });
});

describe("S10 — the store reads no clock", () => {
  it("names no clock in its own source", () => {
    const code = codeOfModule();
    for (const forbidden of ["Date.now(", "new Date(", "process.env", "process.hrtime"]) {
      expect({ forbidden, present: code.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("stores only instants a caller supplied", () => {
    const { store } = temporaryStore();
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T1 }));
    store.transact(KEY, () => ({ verb: "SETTLE", at: T2 }));
    const row = store.read(KEY);
    // Every timestamp in the row is one of the arguments above and nothing
    // else. A store that read a clock could not be drilled at an expiry
    // boundary without sleeping.
    const supplied = new Set([T0, T1, T2]);
    for (const instant of [row?.claimedAt, row?.expiresAt, row?.inFlightAt, row?.settledAt]) {
      expect({ instant, supplied: supplied.has(instant ?? "") }).toEqual({ instant, supplied: true });
    }
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo E1 — the metadata, the incarnation and the token
// ---------------------------------------------------------------------------

describe("the file carries its own incarnation", () => {
  it("registers the incarnation it is given, as migration two", () => {
    const path = storePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    expect(store.incarnation()).toEqual({
      storeKind: "TOOL_CLAIM",
      incarnationId: I1,
      createdAt: CREATED_AT,
    });
    store.close();

    const handle = new Database(path);
    const migrations = handle
      .prepare("SELECT version, name FROM tool_claim_schema_migrations ORDER BY version ASC")
      .all() as { version: number; name: string }[];
    const recorded = handle
      .prepare("SELECT sha256 FROM tool_claim_schema_migrations WHERE version = 1")
      .get() as { sha256: string };
    handle.close();
    // Migration 1 is shipped and immutable, so the metadata can only arrive
    // behind the table it governs — and its digest is untouched by that.
    expect(migrations).toEqual([
      { version: 1, name: "tool_claim" },
      { version: 2, name: "coordination_store_meta" },
    ]);
    expect(recorded.sha256).toBe(MIGRATION_ONE_SHA256);
  });

  it("does not rotate an incarnation a reopen disagrees with", () => {
    const path = storePath();
    open(path, { incarnationId: I1, createdAt: CREATED_AT }).close();
    const second = open(path, { incarnationId: I2, createdAt: "2026-09-13T00:00:00.000Z" });
    // Rotating an incarnation is coordination 8.2's restore, which has a
    // quiescence proof in front of it. It is not a side effect of reopening.
    expect(second.incarnation()).toEqual({
      storeKind: "TOOL_CLAIM",
      incarnationId: I1,
      createdAt: CREATED_AT,
    });
  });

  it("holds exactly one metadata row, uniquely, with no default", () => {
    const path = storePath();
    open(path, { incarnationId: I1, createdAt: CREATED_AT }).close();
    const handle = new Database(path);
    // Singleton by CHECK rather than by convention.
    expect(() =>
      handle
        .prepare(
          "INSERT INTO coordination_store_meta (singleton_id, store_kind, store_incarnation_id, created_at)" +
            " VALUES (2, 'TOOL_CLAIM', ?, ?)",
        )
        .run(I2, CREATED_AT),
    ).toThrow();
    // And no implicit default: a row that named no incarnation would be a file
    // that issued tokens nobody could later place.
    expect(() =>
      handle
        .prepare("INSERT INTO coordination_store_meta (singleton_id, store_kind, created_at) VALUES (3, 'OUTBOX', ?)")
        .run(CREATED_AT),
    ).toThrow();
    handle.close();
  });

  it("refuses an incarnation supplied without its instant, and the reverse", () => {
    const path = storePath();
    expect(caught(() => openToolClaimStore(path, { incarnationId: I1 }))).toBeInstanceOf(LedgerQueryError);
    expect(caught(() => openToolClaimStore(path, { createdAt: CREATED_AT }))).toBeInstanceOf(LedgerQueryError);
    expect(
      caught(() => openToolClaimStore(path, { incarnationId: I1, createdAt: "" })),
    ).toBeInstanceOf(LedgerQueryError);
  });

  it("refuses a coordination file whose store kind is not TOOL_CLAIM", () => {
    const path = storePath();
    open(path, { incarnationId: I1, createdAt: CREATED_AT }).close();
    const handle = new Database(path);
    handle.exec("UPDATE coordination_store_meta SET store_kind = 'WORKTREE_LEASE' WHERE singleton_id = 1");
    handle.close();
    // Reachable because the CHECK carries all five kinds of section 8.1's
    // dictionary rather than only this one. The identity of a coordination file
    // is the kind it declares, not the name it happens to have.
    expect(caught(() => openToolClaimStore(path))).toBeInstanceOf(LedgerOpenError);
  });

  it("reads the metadata now, and refuses a file that turned into another store", () => {
    const path = storePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });

    const handle = new Database(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();
    // Never cached: a handle that answered from memory would answer about the
    // file as it was before a restore.
    expect(store.incarnation()?.incarnationId).toBe(I2);

    const again = new Database(path);
    again.exec("UPDATE coordination_store_meta SET store_kind = 'OUTBOX' WHERE singleton_id = 1");
    again.close();
    // An absent metadata row is lawful here; a row that now belongs to somebody
    // else is not, and the open-time guard cannot catch what happened after it.
    expect(caught(() => store.incarnation())).toBeInstanceOf(LedgerIntegrityError);
  });

  it("refuses a sibling store of this package before writing anything to it", () => {
    for (const sibling of ["lease_schema_migrations", "outbox_schema_migrations"]) {
      const path = storePath();
      const handle = new Database(path);
      handle.exec("CREATE TABLE " + sibling + " (version INTEGER PRIMARY KEY) STRICT;");
      handle.close();

      expect(caught(() => openToolClaimStore(path))).toBeInstanceOf(LedgerOpenError);

      const after = new Database(path);
      const tables = (
        after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      after.close();
      // Refused before writing anything: a wrong file is a mistake, and
      // colonizing a neighbour with a foreign table would make it permanent.
      expect(tables).toEqual([sibling]);
    }
  });
});

describe("every claim is stamped with the incarnation that took it", () => {
  it("stamps the take and the reclaim, and conserves it across the forward transitions", () => {
    const path = storePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });

    const taken = store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    expect(taken.verb === "TAKE" ? taken.row.storeIncarnationId : null).toBe(I1);

    const marked = store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T1 }));
    // Advancing a claim is not taking one: the stamp names the incarnation that
    // granted it and would say something false about any other.
    expect(marked.verb === "MARK_IN_FLIGHT" ? marked.row.storeIncarnationId : null).toBe(I1);
    const settled = store.transact(KEY, () => ({ verb: "SETTLE", at: T2 }));
    expect(settled.verb === "SETTLE" ? settled.row.storeIncarnationId : null).toBe(I1);
  });

  it("stamps the reclaim of an expired coordinate too", () => {
    const path = storePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    const reclaimed = store.transact(KEY, () => ({
      verb: "TAKE",
      row: grantOf({ claimId: "22222222-2222-4222-8222-222222222222", claimedAt: T2 }),
    }));
    expect(reclaimed.verb === "TAKE" ? reclaimed.row.storeIncarnationId : null).toBe(I1);
  });

  it("stamps null while the file carries no incarnation, and refuses nothing", () => {
    const { store } = temporaryStore();
    // The adoption window: both doors open this file without one today.
    expect(store.incarnation()).toBeNull();
    const taken = store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    expect(taken.verb).toBe("TAKE");
    expect(taken.verb === "TAKE" ? taken.row.storeIncarnationId : "unset").toBeNull();
  });
});

describe("a file written before the metadata existed still works, and gains it", () => {
  it("migrates in place, leaving the claim intact and the new column null", () => {
    const path = legacyClaimFile("CLAIMED");
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    // Section 8.1 :384: additive and null on rows that predate the change.
    expect(store.read(KEY)).toMatchObject({
      state: "CLAIMED",
      claimId: "legacy-claim",
      taskId: "11111111-2222-4333-8444-555555555555",
      storeIncarnationId: null,
    });

    const handle = new Database(path);
    const recorded = handle
      .prepare("SELECT sha256 FROM tool_claim_schema_migrations WHERE version = 1")
      .get() as { sha256: string };
    handle.close();
    expect(recorded.sha256).toBe(MIGRATION_ONE_SHA256);
  });

  it("advances a legacy claim without inventing an incarnation for it", () => {
    const path = legacyClaimFile("CLAIMED");
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });

    const marked = store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T1 }));
    expect(marked.verb === "MARK_IN_FLIGHT" ? marked.row : null).toMatchObject({
      state: "IN_FLIGHT",
      storeIncarnationId: null,
    });
    const settled = store.transact(KEY, () => ({ verb: "SETTLE", at: T2 }));
    expect(settled.verb === "SETTLE" ? settled.row : null).toMatchObject({
      state: "SETTLED",
      storeIncarnationId: null,
    });
  });

  it("stamps the live incarnation when a legacy coordinate is reclaimed", () => {
    const path = legacyClaimFile("CLAIMED");
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    const reclaimed = store.transact(KEY, () => ({
      verb: "TAKE",
      row: grantOf({ claimId: "33333333-3333-4333-8333-333333333333", claimedAt: T2 }),
    }));
    // The coordinate is being claimed again, so it belongs to this incarnation
    // whatever it belonged to before.
    expect(reclaimed.verb === "TAKE" ? reclaimed.row.storeIncarnationId : null).toBe(I1);
  });
});

describe("N-P18-11 -- the claim id alone is never the token", () => {
  it("refuses a token whose claim id is right and whose incarnation is not", () => {
    const path = storePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));

    const handle = new Database(path);
    // The file is restored under a new incarnation. The claim is replayed into
    // it unchanged -- same coordinate, same claim id -- which is exactly the
    // shape a rebuild produces.
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();

    let ran = false;
    const refused = store.transact(
      KEY,
      () => {
        ran = true;
        return { verb: "MARK_IN_FLIGHT", at: T1 };
      },
      { incarnationId: I1, claimId: grantOf().claimId },
    );
    expect(refused.verb).toBe("REFUSE");
    // A stale token is a precondition that failed, not a policy that declined:
    // the caller's decision is never consulted, so it cannot write.
    expect(ran).toBe(false);
    expect(store.read(KEY)?.state).toBe("CLAIMED");

    // And the same call applies with the live incarnation and nothing else
    // changed, which proves the refusal was about the incarnation.
    const applied = store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T1 }), {
      incarnationId: I2,
      claimId: grantOf().claimId,
    });
    expect(applied.verb).toBe("MARK_IN_FLIGHT");
  });

  it("refuses a token whose incarnation is right and whose claim is not", () => {
    const path = storePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    store.transact(KEY, () => ({
      verb: "TAKE",
      row: grantOf({ claimId: "44444444-4444-4444-8444-444444444444", claimedAt: T2 }),
    }));

    // The holder from before the reclaim. Both halves of the pair are checked,
    // not only the one that is not in the row.
    const refused = store.transact(KEY, () => ({ verb: "SETTLE", at: T2 }), {
      incarnationId: I1,
      claimId: grantOf().claimId,
    });
    expect(refused.verb).toBe("REFUSE");
    expect(store.read(KEY)?.state).toBe("CLAIMED");
  });

  it("checks the incarnation inside the transaction, not at open", () => {
    const path = storePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));

    // The handle is already open when the metadata is rewritten from another
    // connection. A store that read the incarnation once at open would pass the
    // negative above by accident and fail in the field.
    const handle = new Database(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();

    expect(
      store.transact(KEY, () => ({ verb: "SETTLE", at: T2 }), {
        incarnationId: I1,
        claimId: grantOf().claimId,
      }).verb,
    ).toBe("REFUSE");
  });

  it("refuses every token on a file that carries no incarnation", () => {
    const { store } = temporaryStore();
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    // Fail closed. Nobody in the adoption window passes a token, and a store
    // that accepted one it cannot place would be answering a question it has no
    // instrument for.
    expect(
      store.transact(KEY, () => ({ verb: "SETTLE", at: T2 }), {
        incarnationId: I1,
        claimId: grantOf().claimId,
      }).verb,
    ).toBe("REFUSE");
  });

  it("refuses a malformed token by name rather than comparing it", () => {
    const { store } = temporaryStore();
    for (const token of [
      { incarnationId: "", claimId: grantOf().claimId },
      { incarnationId: I1, claimId: "" },
    ]) {
      expect(
        caught(() => store.transact(KEY, () => ({ verb: "REFUSE", reason: "x" }), token)),
      ).toBeInstanceOf(LedgerQueryError);
    }
  });

  it("behaves exactly as before when no token is supplied", () => {
    const path = storePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));

    const handle = new Database(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();

    // The gate is opt-in. Both doors pass no token and are not changed by this
    // escalón, so a restore they never heard about must not start refusing
    // their calls.
    expect(store.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T1 })).verb).toBe("MARK_IN_FLIGHT");
  });

  it("refuses the incarnation before it looks at the claim id", () => {
    const code = codeOfModule();
    // The shape half of section 4.3's "the number alone is never the token".
    // A comparison that reached the claim id first would be a store that could
    // answer about an id it cannot place, and no behavioural test distinguishes
    // the two orders.
    const incarnation = code.indexOf(".incarnationId !== token.incarnationId");
    const claim = code.indexOf("!== token.claimId");
    expect(incarnation).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(-1);
    expect(incarnation).toBeLessThan(claim);
  });

  it("mints no identity of its own", () => {
    const code = codeOfModule();
    // Section 8.1 gives the incarnation no implicit default, twice. A UUID
    // minted here would read an environment this module may not read -- and
    // would make the restore drills above impossible to aim, because a test
    // could no longer choose which incarnation a claim was taken under.
    for (const forbidden of ["randomUUID", "randomBytes", "Math.random"]) {
      expect({ forbidden, present: code.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});

/**
 * The module's code with its prose removed.
 *
 * The claims above are about what the module *does*, so they are asserted over
 * code and not over comments — a docblock explaining why there is no `DELETE`
 * must not read as a `DELETE`. The same distinction the architecture fence draws
 * with its own `stripComments`, restated locally because the fence is not
 * importable from a package suite.
 */
function codeOfModule(): string {
  const source = readFileSync(
    new URL("../../src/tool-claim-store/index.ts", import.meta.url),
    "utf8",
  );
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}


// ---------------------------------------------------------------------------
// S11 — the arbitration holds across operating-system processes (V2 X1b)
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..", "..");
const COMPILED_STORE = join(PACKAGE_ROOT, "dist-test", "src", "tool-claim-store", "index.js");

/**
 * A child process cannot use the vitest alias that points `@acp/contracts` at
 * its TypeScript source, so what a child runs is the **compiled** store. The
 * test tree's own `tsconfig.json` emits it into `dist-test/`, never into the
 * published `dist/`. The build is normally already there, because `pnpm check`
 * typechecks before it tests; this only pays for a build when these tests are
 * run on their own.
 *
 * The same shape the lease store uses for the same reason, and carried as its
 * own copy for the same one: the entry path differs, and a shared helper would
 * need a registered test-only domain of its own for forty lines.
 */
function ensureCompiledStore(): void {
  if (existsSync(COMPILED_STORE)) return;
  const result = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "--build",
      join(PACKAGE_ROOT, "test", "tsconfig.json"),
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (result.status !== 0 || !existsSync(COMPILED_STORE)) {
    throw new Error(
      "could not build the ledger test tree for the cross-process test: " + result.stdout + result.stderr,
    );
  }
}

interface ClaimantOutcome {
  readonly verb: string | null;
  readonly holder: string;
  readonly errorName: string | null;
}

/**
 * One real claimant, in its own operating-system process.
 *
 * It runs the *caller's* half of the protocol, which is the half that matters:
 * see no row, take it; see a row, refuse. Every process runs identical logic,
 * so if two of them could both observe `current === null` two would both
 * report `TAKE` — which is precisely the failure `BEGIN IMMEDIATE` exists to
 * prevent, and precisely what an in-process fake can never falsify.
 */
function claimant(storePath: string, holder: string, at: string): Promise<ClaimantOutcome> {
  const script = [
    "const { openToolClaimStore } = await import(" + JSON.stringify(pathToFileURL(COMPILED_STORE).href) + ");",
    "const store = openToolClaimStore(" + JSON.stringify(storePath) + ");",
    "let verb = null; let errorName = null;",
    "try {",
    "  const verdict = store.transact(" + JSON.stringify(KEY) + ", (current) =>",
    "    current === null",
    "      ? { verb: 'TAKE', row: {",
    "          claimId: 'c' + " + JSON.stringify(holder) + ".length.toString().padStart(8, '0')",
    "            + '-1111-4111-8111-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0'),",
    "          holder: " + JSON.stringify(holder) + ",",
    "          claimedAt: " + JSON.stringify(at) + ",",
    "          expiresAt: " + JSON.stringify(T2) + ",",
    "          taskId: '11111111-2222-4333-8444-555555555555',",
    "          attempt: 1, transitionId: 'tool.call.0',",
    "          submittedAt: " + JSON.stringify(at) + ", accountId: 'acct-x1b',",
    "          serverId: 'docs', toolName: 'docs.search', argumentBytes: 42 } }",
    "      : { verb: 'REFUSE', reason: 'CLAIM_HELD' });",
    "  verb = verdict.verb;",
    "} catch (error) { errorName = error?.name ?? 'Error'; }",
    "store.close();",
    "process.stdout.write(JSON.stringify({ verb, holder: " + JSON.stringify(holder) + ", errorName }));",
  ].join("\n");

  return new Promise<ClaimantOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: REPO_ROOT });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || out === "") {
        reject(new Error("claimant " + holder + " exited " + String(code) + ": " + err));
        return;
      }
      resolve(JSON.parse(out) as ClaimantOutcome);
    });
  });
}

describe("S11 — one coordinate, many processes, one winner", () => {
  it("grants the coordinate to exactly one of eight real processes", { timeout: 60_000 }, async () => {
    ensureCompiledStore();
    const path = join(temporaryDirectory(), "tool-claims.sqlite");
    // Migrated once, here, so the children contend over the claim rather than
    // over the schema — and so a failure names the race and not the migration.
    open(path).close();

    const holders = Array.from({ length: 8 }, (_, index) => "claude/opus/implementer/" + String(index + 1));
    const outcomes = await Promise.all(holders.map((holder) => claimant(path, holder, T0)));

    // The claim this whole packet rests on, and the only place it is made
    // against real operating-system processes rather than against a fake.
    const winners = outcomes.filter((outcome) => outcome.verb === "TAKE");
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.verb === "REFUSE")).toHaveLength(7);
    // No claimant died: a lock contention that surfaced as SQLITE_BUSY would be
    // a refusal the plane never asked for, and would make the count above pass
    // for the wrong reason.
    expect(outcomes.filter((outcome) => outcome.errorName !== null)).toEqual([]);

    // And the file agrees with the processes: one row, held by the winner.
    const store = open(path);
    const row = store.read(KEY);
    expect(row?.state).toBe("CLAIMED");
    expect(row?.holder).toBe(winners[0]?.holder);
  });

  it("refuses every process a coordinate already settled, with no reclaim", async () => {
    ensureCompiledStore();
    const path = join(temporaryDirectory(), "tool-claims.sqlite");
    const seed = open(path);
    seed.transact(KEY, () => ({ verb: "TAKE", row: grantOf() }));
    seed.transact(KEY, () => ({ verb: "MARK_IN_FLIGHT", at: T1 }));
    seed.transact(KEY, () => ({ verb: "SETTLE", at: T1 }));
    seed.close();

    const outcomes = await Promise.all(
      ["claude/opus/implementer/01", "claude/sonnet/implementer/07"].map((holder) =>
        claimant(path, holder, T2),
      ),
    );

    // Terminal means terminal, and it means it to a process that never saw the
    // settle happen. Non-vacuous against the case above, which differs only in
    // the state the coordinate was left in.
    expect(outcomes.every((outcome) => outcome.verb === "REFUSE")).toBe(true);
    const store = open(path);
    expect(store.read(KEY)?.state).toBe("SETTLED");
    expect(store.read(KEY)?.settledAt).toBe(T1);
  });
});
