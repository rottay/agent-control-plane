import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  ARTIFACT_BLOB_LEASE_OPERATIONS,
  ARTIFACT_BLOB_LEASE_QUIESCENCE_BASES,
  ARTIFACT_BLOB_LEASE_REFUSALS,
  MAX_ARTIFACT_BLOB_LEASE_GENERATION,
  artifactBlobLeaseStorePath,
  openArtifactBlobLeaseStore,
} from "../../src/artifact-lease-store/index.js";
import type {
  ArtifactBlobLeaseGrant,
  ArtifactBlobLeaseOutcome,
  ArtifactBlobLeaseRow,
  ArtifactBlobLeaseStore,
  ArtifactBlobLeaseTestFaults,
  ArtifactBlobLeaseToken,
} from "../../src/artifact-lease-store/index.js";

/**
 * Evidence for the artifact blob lease store (P-36/local escalón B).
 *
 * The escalón exists for one exclusion, so the suite is organised around the
 * negatives that exclusion must make impossible rather than around the module's
 * surface:
 *
 *   • **N-P36-13** (the lease wing) — two publishers of one digest, and exactly
 *     one holds it; in one process and in four.
 *   • **N-P36-8** — a holder that dies after taking the exclusion keeps it: no
 *     verb frees it by the clock, and ending it requires a named quiescence.
 *   • **N-P36-14** (the store's half) — a holder whose incarnation or generation
 *     has been superseded is refused. That it then touches no file is C's half.
 *   • **N-P36B-1..13** of the preaudit — the schema of artifacts §7 driven
 *     against the database, the whole token, the replay, the two operations,
 *     the wrong file, the digest's form, and a race with two arms.
 *
 * A store that refused everything would satisfy most of those, so the positives
 * — the first grant, the release that conserves the generation, the take-over
 * that advances it — are not optional.
 *
 * **No wall-clock sleep anywhere.** Every instant is a literal, and the
 * cross-process drills release their children on a marker they write.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Five levels: this file sits at packages/persistence/ledger/test/artifact-lease-store/.
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const WORKER_ENTRY = join(PACKAGE_ROOT, "dist-test", "test", "artifact-lease-race-worker", "index.js");

const I1 = "11111111-1111-4111-8111-111111111111";
const I2 = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const ACQUIRED_AT = "2026-01-01T00:10:00.000Z";
const EXPIRES_AT = "2026-01-01T00:20:00.000Z";
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const D3 = "c".repeat(64);

const temporaryDirectories: string[] = [];
const openStores: ArtifactBlobLeaseStore[] = [];

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
  const directory = mkdtempSync(join(tmpdir(), "acp-blob-lease-"));
  temporaryDirectories.push(directory);
  return directory;
}

function temporaryStorePath(): string {
  return join(temporaryDirectory(), "artifact-blob-leases.sqlite");
}

function open(path: string, incarnationId = I1, faults?: ArtifactBlobLeaseTestFaults): ArtifactBlobLeaseStore {
  const store = openArtifactBlobLeaseStore(path, {
    incarnationId,
    createdAt: CREATED_AT,
    ...(faults === undefined ? {} : { __testFaults: faults }),
  });
  openStores.push(store);
  return store;
}

function grantOf(overrides: Partial<ArtifactBlobLeaseGrant> = {}): ArtifactBlobLeaseGrant {
  return {
    contentSha256: D1,
    operation: "PUBLISH",
    operationId: "cmd-publish-1",
    holder: "claude/opus/publisher/01",
    holderPid: 4242,
    acquiredAt: ACQUIRED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

/** The token a holder carries away from the row it was granted. */
function tokenOf(row: ArtifactBlobLeaseRow | null): ArtifactBlobLeaseToken {
  const holder = row?.holder ?? null;
  const operationId = row?.operationId ?? null;
  if (row === null || holder === null || operationId === null) {
    throw new Error("the row carries no holding to take a token from");
  }
  return {
    incarnationId: row.storeIncarnationId,
    contentSha256: row.contentSha256,
    generation: row.generation,
    holder,
    operationId,
  };
}

function applied(outcome: ArtifactBlobLeaseOutcome): ArtifactBlobLeaseRow {
  if (outcome.verb !== "APPLIED") throw new Error("expected APPLIED, got " + JSON.stringify(outcome));
  return outcome.row;
}

function refusalOf(outcome: ArtifactBlobLeaseOutcome): string | null {
  return outcome.verb === "REFUSE" ? outcome.refusal : null;
}

/** A raw handle on the same file, for the drills that must bypass the module. */
function raw(path: string): Database.Database {
  return new Database(path);
}

const QUIESCENT = { basis: "DEATH_AND_REAP_PROVEN", holderPid: 4242 } as const;

// ---------------------------------------------------------------------------

describe("the path, and its single producer (Q-P36B-2)", () => {
  it("composes the blob lease store beside the ledger it belongs to", () => {
    expect(artifactBlobLeaseStorePath("/var/acp/ledger.sqlite")).toBe("/var/acp/artifact-blob-leases.sqlite");
  });

  it("refuses a ledger path that is not one", () => {
    expect(() => artifactBlobLeaseStorePath("")).toThrow(LedgerQueryError);
  });
});

describe("N-P36B-6 -- opening, and refusing the wrong file before writing", () => {
  it("creates, migrates and reopens, and the stored incarnation stands", () => {
    const path = temporaryStorePath();
    const first = open(path);
    const incarnation = first.incarnation();
    first.close();

    const second = open(path, I2);
    expect(second.incarnation()).toEqual(incarnation);
    expect(incarnation).toEqual({ storeKind: "ARTIFACT_BLOB_LEASE", incarnationId: I1, createdAt: CREATED_AT });
  });

  it("registers the incarnation as migration one, before the table it governs", () => {
    const path = temporaryStorePath();
    open(path).close();
    const handle = raw(path);
    const migrations = handle
      .prepare("SELECT version, name FROM artifact_blob_lease_schema_migrations ORDER BY version ASC")
      .all();
    const tables = (
      handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%schema_migrations'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    handle.close();
    expect(migrations).toEqual([
      { version: 1, name: "coordination_store_meta" },
      { version: 2, name: "artifact_blob_lease" },
    ]);
    expect(tables).toEqual(["artifact_blob_lease_schema_migrations"]);
  });

  it("requires an incarnation and its instant, and has no adoption window", () => {
    const path = temporaryStorePath();
    expect(() => openArtifactBlobLeaseStore(path, { incarnationId: "", createdAt: CREATED_AT })).toThrow(
      LedgerQueryError,
    );
    expect(() => openArtifactBlobLeaseStore(path, { incarnationId: I1, createdAt: "" })).toThrow(LedgerQueryError);
    expect(() =>
      openArtifactBlobLeaseStore(path, {} as unknown as { incarnationId: string; createdAt: string }),
    ).toThrow(LedgerQueryError);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a directory, a file that is not SQLite, and a ledger", () => {
    expect(() => open(temporaryDirectory())).toThrow(LedgerOpenError);

    const notSqlite = temporaryStorePath();
    writeFileSync(notSqlite, "this is not a database");
    expect(() => open(notSqlite)).toThrow(LedgerOpenError);

    const ledgerLike = temporaryStorePath();
    const handle = raw(ledgerLike);
    handle.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;");
    handle.close();
    expect(() => open(ledgerLike)).toThrow(LedgerOpenError);
  });

  it("refuses every sibling store of this package, and writes nothing into it", () => {
    for (const sibling of ["lease_schema_migrations", "tool_claim_schema_migrations", "outbox_schema_migrations"]) {
      const path = temporaryStorePath();
      const handle = raw(path);
      handle.exec("CREATE TABLE " + sibling + " (version INTEGER PRIMARY KEY) STRICT;");
      handle.close();
      expect(() => open(path)).toThrow(LedgerOpenError);
      const after = raw(path);
      const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name)
        .sort();
      after.close();
      expect({ sibling, tables }).toEqual({ sibling, tables: [sibling] });
    }
  });

  it("refuses a coordination file whose store kind is not ARTIFACT_BLOB_LEASE (decision 47)", () => {
    const path = temporaryStorePath();
    open(path).close();
    const handle = raw(path);
    handle.exec("UPDATE coordination_store_meta SET store_kind = 'OUTBOX' WHERE singleton_id = 1");
    handle.close();
    expect(() => open(path)).toThrow(LedgerOpenError);
  });

  it("refuses a migration history this build does not carry", () => {
    const path = temporaryStorePath();
    open(path).close();
    const handle = raw(path);
    handle.exec("UPDATE artifact_blob_lease_schema_migrations SET sha256 = 'deadbeef' WHERE version = 2");
    handle.close();
    expect(() => open(path)).toThrow(LedgerMigrationError);
  });

  it("holds exactly one metadata row, by CHECK", () => {
    const path = temporaryStorePath();
    open(path).close();
    const handle = raw(path);
    expect(() =>
      handle
        .prepare(
          "INSERT INTO coordination_store_meta (singleton_id, store_kind, store_incarnation_id, created_at)" +
            " VALUES (2, 'ARTIFACT_BLOB_LEASE', ?, ?)",
        )
        .run(I2, CREATED_AT),
    ).toThrow();
    handle.close();
  });

  it("refuses every verb after close", () => {
    const store = open(temporaryStorePath());
    const token = tokenOf(applied(store.acquire(grantOf())));
    store.close();
    expect(() => store.incarnation()).toThrow(LedgerClosedError);
    expect(() => store.read(D1)).toThrow(LedgerClosedError);
    expect(() => store.readToken(D1)).toThrow(LedgerClosedError);
    expect(() => store.acquire(grantOf())).toThrow(LedgerClosedError);
    expect(() => store.release(token)).toThrow(LedgerClosedError);
    expect(() => store.revoke(token, QUIESCENT)).toThrow(LedgerClosedError);
    expect(() => store.takeOver(token, QUIESCENT, grantOf())).toThrow(LedgerClosedError);
    expect(() => store.listOverdue(EXPIRES_AT)).toThrow(LedgerClosedError);
  });
});

// ---------------------------------------------------------------------------

describe("the schema of artifacts section 7, against the database", () => {
  const INSERT =
    "INSERT INTO artifact_blob_lease (content_sha256, generation, store_incarnation_id, operation, operation_id," +
    " holder, holder_pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const held = (digest: string, generation: number, operationId: string, operation = "PUBLISH"): unknown[] => [
    digest,
    generation,
    I1,
    operation,
    operationId,
    "holder",
    4242,
    ACQUIRED_AT,
    EXPIRES_AT,
  ];
  const free = (digest: string, generation: number): unknown[] => [
    digest,
    generation,
    I1,
    null,
    null,
    null,
    null,
    null,
    null,
  ];

  function freshHandle(): { readonly path: string; readonly handle: Database.Database } {
    const path = temporaryStorePath();
    open(path).close();
    openStores.length = 0;
    return { path, handle: raw(path) };
  }

  it("keys the table on the digest alone, and is STRICT", () => {
    const { handle } = freshHandle();
    handle.prepare(INSERT).run(...held(D1, 1, "op-1"));
    expect(() => handle.prepare(INSERT).run(...free(D1, 1))).toThrow(/UNIQUE|PRIMARY/);
    expect(() => handle.prepare(INSERT).run(...free(D2, "one" as unknown as number))).toThrow();
    const sql = (
      handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact_blob_lease'").get() as { sql: string }
    ).sql;
    handle.close();
    expect(sql).toContain("CONSTRAINT pk_artifact_blob_lease PRIMARY KEY (content_sha256)");
    expect(sql).toContain(") STRICT");
  });

  it("refuses a generation that is not positive", () => {
    const { handle } = freshHandle();
    expect(() => handle.prepare(INSERT).run(...free(D1, 0))).toThrow(/generation_positive/);
    expect(() => handle.prepare(INSERT).run(...free(D1, -1))).toThrow(/generation_positive/);
    handle.close();
  });

  it("admits both words of blob_lease_operation and no third (Q-P36B-1)", () => {
    const { handle } = freshHandle();
    handle.prepare(INSERT).run(...held(D1, 1, "op-1", "PUBLISH"));
    handle.prepare(INSERT).run(...held(D2, 1, "op-2", "RECLAIM"));
    expect(() => handle.prepare(INSERT).run(...held(D3, 1, "op-3", "COLLECT"))).toThrow(/operation_enum/);
    handle.close();
    expect([...ARTIFACT_BLOB_LEASE_OPERATIONS]).toEqual(["PUBLISH", "RECLAIM"]);
  });

  it("N-P36B-3 -- the five operation columns are null exactly when the operation is", () => {
    const { handle } = freshHandle();
    const columns = ["operation_id", "holder", "holder_pid", "acquired_at", "expires_at"];
    for (const [offset, column] of columns.entries()) {
      // A holding missing one of the five.
      const partial = held(D1, 1, "op-1");
      partial[4 + offset] = null;
      expect(() => handle.prepare(INSERT).run(...partial)).toThrow(new RegExp(column + "_matches_operation"));
      // A free row carrying one of them.
      const stray = free(D2, 1);
      stray[4 + offset] = column === "holder_pid" ? 7 : "stray";
      expect(() => handle.prepare(INSERT).run(...stray)).toThrow(new RegExp(column + "_matches_operation"));
    }
    // And an operation with every column but itself: the five present, the word absent.
    const wordless = held(D3, 1, "op-3");
    wordless[3] = null;
    expect(() => handle.prepare(INSERT).run(...wordless)).toThrow(/_matches_operation/);
    // The two lawful shapes.
    handle.prepare(INSERT).run(...held(D1, 1, "op-1"));
    handle.prepare(INSERT).run(...free(D2, 1));
    handle.close();
  });

  it("N-P36B-4 -- one operation id holds one digest at most, and free rows share none", () => {
    const { handle } = freshHandle();
    handle.prepare(INSERT).run(...held(D1, 1, "op-shared"));
    expect(() => handle.prepare(INSERT).run(...held(D2, 1, "op-shared"))).toThrow(/UNIQUE/);
    handle.prepare(INSERT).run(...free(D2, 1));
    handle.prepare(INSERT).run(...free(D3, 1));
    const index = (
      handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'ux_artifact_blob_lease__operation_id'").get() as {
        sql: string;
      }
    ).sql;
    handle.close();
    expect(index).toContain("WHERE operation_id IS NOT NULL");
  });

  it("N-P36B-5 -- the incarnation is validated on insert and on update, by trigger", () => {
    const { handle } = freshHandle();
    const foreign = held(D1, 1, "op-1");
    foreign[2] = I2;
    expect(() => handle.prepare(INSERT).run(...foreign)).toThrow(/incarnation of the file/);
    handle.prepare(INSERT).run(...held(D1, 1, "op-1"));
    expect(() =>
      handle.prepare("UPDATE artifact_blob_lease SET store_incarnation_id = ? WHERE content_sha256 = ?").run(I2, D1),
    ).toThrow(/incarnation of the file/);
    // With the metadata row gone, no incarnation is the file's, so no row is admitted.
    handle.exec("DELETE FROM coordination_store_meta");
    expect(() => handle.prepare(INSERT).run(...free(D2, 1))).toThrow(/incarnation of the file/);
    handle.close();
  });

  it("N-P36B-2 -- the generation moves by the mutation's rule, never backwards and never by two", () => {
    const { handle } = freshHandle();
    const update = (sets: string, digest: string): void => {
      handle.prepare("UPDATE artifact_blob_lease SET " + sets + " WHERE content_sha256 = ?").run(digest);
    };
    handle.prepare(INSERT).run(...held(D1, 3, "op-1"));

    // Never backwards, never by more than one.
    expect(() => {
      update("generation = 2", D1);
    }).toThrow(/zero or one/);
    expect(() => {
      update("generation = 5", D1);
    }).toThrow(/zero or one/);

    // The same holding conserves it: an ordinary write moves nothing.
    expect(() => {
      update("expires_at = 'later', generation = 4", D1);
    }).toThrow(/same artifact blob lease holding/);
    update("expires_at = 'later', generation = 3", D1);

    // A new holding advances it by exactly one: another holder, or another operation id.
    expect(() => {
      update("holder = 'other', generation = 3", D1);
    }).toThrow(/new holding/);
    expect(() => {
      update("operation_id = 'op-9', generation = 3", D1);
    }).toThrow(/new holding/);
    expect(() => {
      update("operation = 'RECLAIM', generation = 3", D1);
    }).toThrow(/new holding/);
    update("holder = 'other', generation = 4", D1);

    // Clearing: a release conserves it, a revocation advances it by one.
    handle.prepare(INSERT).run(...held(D2, 7, "op-2"));
    const clear =
      "operation = NULL, operation_id = NULL, holder = NULL, holder_pid = NULL, acquired_at = NULL, expires_at = NULL";
    update(clear + ", generation = 4", D1);
    update(clear + ", generation = 8", D2);

    // A free row stays where it was freed until it is granted.
    expect(() => {
      update("generation = 5", D1);
    }).toThrow(/no holding conserves/);
    // And a grant over it is a new holding.
    expect(() => {
      update(
        "operation = 'PUBLISH', operation_id = 'op-4', holder = 'h', holder_pid = 1, acquired_at = 'a'," +
          " expires_at = 'e', generation = 4",
        D1,
      );
    }).toThrow(/new holding/);

    // The digest is immutable.
    expect(() => {
      update("content_sha256 = '" + D3 + "'", D1);
    }).toThrow(/immutable/);

    const rows = handle.prepare("SELECT content_sha256, generation FROM artifact_blob_lease ORDER BY 1").all();
    handle.close();
    expect(rows).toEqual([
      { content_sha256: D1, generation: 4 },
      { content_sha256: D2, generation: 8 },
    ]);
  });

  it("refuses the step past the largest generation this build can compare", () => {
    const path = temporaryStorePath();
    open(path).close();
    openStores.length = 0;
    const handle = raw(path);
    handle.prepare(INSERT).run(...free(D1, MAX_ARTIFACT_BLOB_LEASE_GENERATION));
    handle.close();

    const store = open(path);
    expect(() => store.acquire(grantOf())).toThrow(LedgerQueryError);
    expect(store.read(D1)?.operation).toBeNull();
    expect(() =>
      store.release({
        incarnationId: I1,
        contentSha256: D1,
        generation: MAX_ARTIFACT_BLOB_LEASE_GENERATION + 2,
        holder: "h",
        operationId: "o",
      }),
    ).toThrow(LedgerQueryError);
  });

  it("N-P36B-7 -- no row is ever removed, so the generation survives a release and rises on the next grant", () => {
    const store = open(temporaryStorePath());
    const first = applied(store.acquire(grantOf()));
    const released = applied(store.release(tokenOf(first)));
    expect(released).toEqual({
      contentSha256: D1,
      generation: 1,
      storeIncarnationId: I1,
      operation: null,
      operationId: null,
      holder: null,
      holderPid: null,
      acquiredAt: null,
      expiresAt: null,
    });
    const second = applied(store.acquire(grantOf({ operationId: "cmd-publish-2" })));
    expect(second.generation).toBe(2);
    applied(store.release(tokenOf(second)));
    const third = applied(store.acquire(grantOf({ operationId: "cmd-publish-3", operation: "RECLAIM" })));
    expect(third.generation).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe("acquire -- the exclusion is taken first (artifacts section 8, step 1)", () => {
  it("inserts the first grant at generation one, under the live incarnation", () => {
    const store = open(temporaryStorePath());
    const row = applied(store.acquire(grantOf()));
    expect(row).toEqual({
      contentSha256: D1,
      generation: 1,
      storeIncarnationId: I1,
      operation: "PUBLISH",
      operationId: "cmd-publish-1",
      holder: "claude/opus/publisher/01",
      holderPid: 4242,
      acquiredAt: ACQUIRED_AT,
      expiresAt: EXPIRES_AT,
    });
    expect(store.readToken(D1)).toEqual({
      incarnationId: I1,
      contentSha256: D1,
      generation: 1,
      holder: "claude/opus/publisher/01",
      operationId: "cmd-publish-1",
    });
  });

  it("N-P36-13 -- a second publisher of the same digest is refused as a value, and the first keeps it", () => {
    const store = open(temporaryStorePath());
    const first = applied(store.acquire(grantOf()));
    const second = store.acquire(grantOf({ holder: "claude/opus/publisher/02", operationId: "cmd-publish-2" }));
    expect(second).toEqual({ verb: "REFUSE", refusal: "HELD", row: first });
    expect(store.read(D1)).toEqual(first);
  });

  it("N-P36B-9 -- PUBLISH and RECLAIM on one digest exclude each other", () => {
    const store = open(temporaryStorePath());
    applied(store.acquire(grantOf({ contentSha256: D1, operation: "PUBLISH", operationId: "p-1" })));
    expect(
      refusalOf(store.acquire(grantOf({ contentSha256: D1, operation: "RECLAIM", operationId: "r-1", holder: "gc" }))),
    ).toBe("HELD");

    applied(store.acquire(grantOf({ contentSha256: D2, operation: "RECLAIM", operationId: "r-2", holder: "gc" })));
    // The collector holds it, so the publisher cannot take a pin on these bytes
    // until the collector's generation is released: section 9's first negative
    // cannot be sequenced.
    expect(refusalOf(store.acquire(grantOf({ contentSha256: D2, operation: "PUBLISH", operationId: "p-2" })))).toBe(
      "HELD",
    );
  });

  it("N-P36B-10 -- replaying the grant that stands answers UNCHANGED and moves nothing", () => {
    const store = open(temporaryStorePath());
    const first = applied(store.acquire(grantOf()));
    const replay = store.acquire(
      grantOf({ holderPid: 9999, acquiredAt: "2026-01-01T00:11:00.000Z", expiresAt: "2026-01-01T00:30:00.000Z" }),
    );
    // The idempotency key is the operation id with its holder and its word; a
    // retry carries fresh instants and possibly a fresh process, and neither
    // makes it a second grant.
    expect(replay).toEqual({ verb: "UNCHANGED", row: first });
    // The same operation id under another holder is not a replay.
    expect(refusalOf(store.acquire(grantOf({ holder: "someone-else" })))).toBe("HELD");
    // Nor under another word.
    expect(refusalOf(store.acquire(grantOf({ operation: "RECLAIM" })))).toBe("HELD");
  });

  it("refuses an operation id that already holds another digest, as a value", () => {
    const store = open(temporaryStorePath());
    const holding = applied(store.acquire(grantOf({ contentSha256: D1, operationId: "cmd-shared" })));
    const outcome = store.acquire(grantOf({ contentSha256: D2, operationId: "cmd-shared" }));
    expect(outcome).toEqual({ verb: "REFUSE", refusal: "OPERATION_ID_IN_USE", row: holding });
    expect(store.read(D2)).toBeNull();
  });

  it("N-P36B-13 -- a digest out of form is refused at the door, before the database", () => {
    const path = temporaryStorePath();
    const store = open(path);
    for (const digest of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "../" + "a".repeat(61), ""]) {
      expect(() => store.acquire(grantOf({ contentSha256: digest }))).toThrow(LedgerQueryError);
      expect(() => store.read(digest)).toThrow(LedgerQueryError);
      expect(() => store.readToken(digest)).toThrow(LedgerQueryError);
      expect(() =>
        store.release({ incarnationId: I1, contentSha256: digest, generation: 1, holder: "h", operationId: "o" }),
      ).toThrow(LedgerQueryError);
    }
    store.close();
    const handle = raw(path);
    const count = (handle.prepare("SELECT COUNT(*) AS n FROM artifact_blob_lease").get() as { n: number }).n;
    handle.close();
    expect(count).toBe(0);
  });

  it("refuses a grant out of shape by name", () => {
    const store = open(temporaryStorePath());
    expect(() => store.acquire(grantOf({ operation: "COLLECT" as "PUBLISH" }))).toThrow(/operation must be one of/);
    expect(() => store.acquire(grantOf({ holderPid: 0 }))).toThrow(/holderPid/);
    expect(() => store.acquire(grantOf({ holderPid: 1.5 }))).toThrow(/holderPid/);
    expect(() => store.acquire(grantOf({ holder: "" }))).toThrow(/holder/);
    expect(() => store.acquire(grantOf({ operationId: "" }))).toThrow(/operationId/);
    expect(() => store.acquire(grantOf({ expiresAt: "" }))).toThrow(/expiresAt/);
    expect(store.read(D1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("N-P36B-8 -- the ordinary release is the holder's own, with the whole token", () => {
  it("releases on the whole token, conserving the generation", () => {
    const store = open(temporaryStorePath());
    const row = applied(store.acquire(grantOf()));
    const released = applied(store.release(tokenOf(row)));
    expect({ generation: released.generation, operation: released.operation }).toEqual({
      generation: 1,
      operation: null,
    });
    expect(store.readToken(D1)).toBeNull();
  });

  it("refuses the right generation under another identity, and keeps the holding", () => {
    const store = open(temporaryStorePath());
    const row = applied(store.acquire(grantOf()));
    const token = tokenOf(row);
    expect(store.release({ ...token, holder: "claude/opus/publisher/02" })).toEqual({
      verb: "REFUSE",
      refusal: "HOLDER_MISMATCH",
      row,
    });
    expect(refusalOf(store.release({ ...token, operationId: "cmd-other" }))).toBe("HOLDER_MISMATCH");
    expect(store.read(D1)).toEqual(row);
  });

  it("refuses the right identity at a superseded generation", () => {
    const store = open(temporaryStorePath());
    const first = applied(store.acquire(grantOf()));
    const stale = tokenOf(first);
    applied(store.release(stale));
    // The same holder and the same operation id are granted again: only the
    // generation separates the old token from the live holding.
    const again = applied(store.acquire(grantOf()));
    expect(again.generation).toBe(2);
    expect(store.release(stale)).toEqual({ verb: "REFUSE", refusal: "GENERATION_SUPERSEDED", row: again });
    expect(store.read(D1)).toEqual(again);
  });

  it("answers NOT_HELD over a free row and over a digest nothing holds, as values", () => {
    const store = open(temporaryStorePath());
    const row = applied(store.acquire(grantOf()));
    const token = tokenOf(row);
    const freed = applied(store.release(token));
    // A repeated release changes nothing and throws nothing.
    expect(store.release(token)).toEqual({ verb: "REFUSE", refusal: "NOT_HELD", row: freed });
    expect(store.release({ ...token, contentSha256: D2 })).toEqual({ verb: "REFUSE", refusal: "NOT_HELD", row: null });
  });
});

// ---------------------------------------------------------------------------

describe("N-P36-14 and section 8.1 -- a superseded holder does not operate", () => {
  it("refuses a token of the previous incarnation although every number in it matches", () => {
    const path = temporaryStorePath();
    const before = open(path, I1);
    const token = tokenOf(applied(before.acquire(grantOf())));
    before.close();

    // The store is lost and recreated under a new incarnation, and the same
    // grant is taken again: generation 1, same holder, same operation id.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    const after = open(path, I2);
    const rebuilt = applied(after.acquire(grantOf()));
    expect({ ...tokenOf(rebuilt), incarnationId: I1 }).toEqual(token);

    expect(after.release(token)).toEqual({ verb: "REFUSE", refusal: "INCARNATION_SUPERSEDED", row: rebuilt });
    expect(refusalOf(after.revoke(token, QUIESCENT))).toBe("INCARNATION_SUPERSEDED");
    expect(refusalOf(after.takeOver(token, QUIESCENT, grantOf({ holder: "reconciler" })))).toBe(
      "INCARNATION_SUPERSEDED",
    );
    expect(after.read(D1)).toEqual(rebuilt);

    // And the live incarnation's token operates, so the refusal was the incarnation's.
    expect(applied(after.release({ ...token, incarnationId: I2 })).generation).toBe(1);
  });

  it("reads the incarnation inside the transaction, and a holding across a rotation is frozen, not freed", () => {
    const path = temporaryStorePath();
    const store = open(path, I1);
    const row = applied(store.acquire(grantOf()));
    const token = tokenOf(row);

    const handle = raw(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();

    expect(store.incarnation().incarnationId).toBe(I2);
    // The token of the old incarnation, against the live metadata.
    expect(refusalOf(store.release(token))).toBe("INCARNATION_SUPERSEDED");
    // A token naming the live incarnation, against a row the old one wrote.
    expect(refusalOf(store.release({ ...token, incarnationId: I2 }))).toBe("INCARNATION_SUPERSEDED");
    expect(refusalOf(store.takeOver({ ...token, incarnationId: I2 }, QUIESCENT, grantOf({ holder: "r" })))).toBe(
      "INCARNATION_SUPERSEDED",
    );
    // And the exclusion still stands: nobody else is granted the blob.
    expect(refusalOf(store.acquire(grantOf({ holder: "other", operationId: "cmd-other" })))).toBe("HELD");
    expect(store.read(D1)).toEqual(row);
  });

  it("refuses a displaced holder's token after a take-over, on every verb", () => {
    const store = open(temporaryStorePath());
    const old = tokenOf(applied(store.acquire(grantOf())));
    const taken = applied(store.takeOver(old, QUIESCENT, grantOf({ holder: "reconciler", holderPid: 5151 })));
    expect(taken.generation).toBe(2);
    expect(refusalOf(store.release(old))).toBe("GENERATION_SUPERSEDED");
    expect(refusalOf(store.revoke(old, QUIESCENT))).toBe("GENERATION_SUPERSEDED");
    expect(store.read(D1)).toEqual(taken);
  });
});

// ---------------------------------------------------------------------------

describe("N-P36-8 and H-2 -- nothing releases by the clock, and ending a holding names its quiescence", () => {
  it("N-P36B-1 -- an expired holding stays held, and listing it moves nothing", () => {
    const store = open(temporaryStorePath());
    const overdue = applied(store.acquire(grantOf({ contentSha256: D1, operationId: "o-1", expiresAt: "2026-01-01T00:15:00.000Z" })));
    const later = applied(store.acquire(grantOf({ contentSha256: D2, operationId: "o-2", expiresAt: "2026-01-01T00:05:00.000Z" })));
    applied(store.acquire(grantOf({ contentSha256: D3, operationId: "o-3", expiresAt: "2026-01-02T00:00:00.000Z" })));
    const freedRow = applied(store.acquire(grantOf({ contentSha256: "d".repeat(64), operationId: "o-4", expiresAt: "2026-01-01T00:01:00.000Z" })));
    applied(store.release(tokenOf(freedRow)));

    const listed = store.listOverdue("2026-01-01T00:16:00.000Z");
    expect(listed.map((row) => row.contentSha256)).toEqual([D2, D1]);
    expect(listed).toEqual([later, overdue]);
    // Expiry enables reconciliation; it concedes nothing.
    expect(refusalOf(store.acquire(grantOf({ contentSha256: D1, holder: "late", operationId: "o-9" })))).toBe("HELD");
    expect(store.read(D1)).toEqual(overdue);
  });

  it("offers no verb that frees a row by the clock", () => {
    const store = open(temporaryStorePath());
    expect(Object.keys(store).sort()).toEqual([
      "acquire",
      "close",
      "incarnation",
      "listOverdue",
      "read",
      "readToken",
      "release",
      "revoke",
      "takeOver",
    ]);
  });

  it("N-P36-8 -- a holder that dies after taking the exclusion keeps it, across processes' reopenings", () => {
    const path = temporaryStorePath();
    const publisher = open(path);
    const row = applied(publisher.acquire(grantOf()));
    // The publisher dies between step 1 and step 2: no release, no intention.
    publisher.close();

    const reconciler = open(path);
    expect(reconciler.read(D1)).toEqual(row);
    expect(refusalOf(reconciler.acquire(grantOf({ holder: "reconciler", operationId: "cmd-publish-9" })))).toBe("HELD");
    expect(reconciler.listOverdue("2030-01-01T00:00:00.000Z")).toEqual([row]);
    // The holding keeps the operation id that correlates it with its intention.
    expect(reconciler.readToken(D1)?.operationId).toBe("cmd-publish-1");
  });

  it("requires a quiescence attestation to revoke, and it must name the recorded process", () => {
    const store = open(temporaryStorePath());
    const row = applied(store.acquire(grantOf()));
    const token = tokenOf(row);

    expect(() => store.revoke(token, undefined as unknown as typeof QUIESCENT)).toThrow(LedgerQueryError);
    expect(() => store.revoke(token, { basis: "TTL_EXPIRED" as "DEATH_AND_REAP_PROVEN", holderPid: 4242 })).toThrow(
      /quiescence.basis/,
    );
    expect(() => store.revoke(token, { basis: "DEATH_AND_REAP_PROVEN", holderPid: 0 })).toThrow(/quiescence.holderPid/);
    expect(store.revoke(token, { basis: "DEATH_AND_REAP_PROVEN", holderPid: 7 })).toEqual({
      verb: "REFUSE",
      refusal: "QUIESCENCE_OF_ANOTHER_PROCESS",
      row,
    });
    expect(store.read(D1)).toEqual(row);

    // Two grounds, and expiry is not one of them (artifacts section 9).
    expect([...ARTIFACT_BLOB_LEASE_QUIESCENCE_BASES]).toEqual([
      "DEATH_AND_REAP_PROVEN",
      "STALE_FENCE_REFUSED_BY_BACKEND",
    ]);
    const revoked = applied(store.revoke(token, { basis: "STALE_FENCE_REFUSED_BY_BACKEND", holderPid: 4242 }));
    // A revocation advances the generation and grants nothing.
    expect({ generation: revoked.generation, operation: revoked.operation, holder: revoked.holder }).toEqual({
      generation: 2,
      operation: null,
      holder: null,
    });
    expect(refusalOf(store.release(token))).toBe("GENERATION_SUPERSEDED");
    expect(applied(store.acquire(grantOf({ operationId: "cmd-publish-2" }))).generation).toBe(3);
  });

  it("takes a quiescent holder's blob at generation OLD + 1, and a second reconciler on the same observation loses", () => {
    const store = open(temporaryStorePath());
    const observed = tokenOf(applied(store.acquire(grantOf())));

    // Section 8: "el lease conserva su operation_id vinculado a ese comando" --
    // the reconciler may keep the operation id and still be a new holding.
    const first = store.takeOver(observed, QUIESCENT, grantOf({ holder: "reconciler/01", holderPid: 5151 }));
    const won = applied(first);
    expect({ generation: won.generation, holder: won.holder, operationId: won.operationId }).toEqual({
      generation: 2,
      holder: "reconciler/01",
      operationId: "cmd-publish-1",
    });

    const second = store.takeOver(observed, QUIESCENT, grantOf({ holder: "reconciler/02", holderPid: 6161 }));
    expect(second).toEqual({ verb: "REFUSE", refusal: "GENERATION_SUPERSEDED", row: won });

    // The winner, retrying after a crash it cannot see past, is answered from the row.
    const replay = store.takeOver(observed, QUIESCENT, grantOf({ holder: "reconciler/01", holderPid: 5151 }));
    expect(replay).toEqual({ verb: "UNCHANGED", row: won });
  });

  it("refuses a take-over whose attestation, digest, holding or operation id does not fit", () => {
    const store = open(temporaryStorePath());
    const row = applied(store.acquire(grantOf()));
    const token = tokenOf(row);

    expect(
      store.takeOver(token, { basis: "DEATH_AND_REAP_PROVEN", holderPid: 1 }, grantOf({ holder: "r" })),
    ).toEqual({ verb: "REFUSE", refusal: "QUIESCENCE_OF_ANOTHER_PROCESS", row });
    expect(() => store.takeOver(token, QUIESCENT, grantOf({ contentSha256: D2, holder: "r" }))).toThrow(
      /must name the digest/,
    );
    const elsewhere = applied(store.acquire(grantOf({ contentSha256: D2, operationId: "cmd-elsewhere", holder: "x" })));
    expect(store.takeOver(token, QUIESCENT, grantOf({ holder: "r", operationId: "cmd-elsewhere" }))).toEqual({
      verb: "REFUSE",
      refusal: "OPERATION_ID_IN_USE",
      row: elsewhere,
    });

    applied(store.release(token));
    expect(refusalOf(store.takeOver(token, QUIESCENT, grantOf({ holder: "r" })))).toBe("NOT_HELD");
    expect(store.read(D1)?.generation).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("a missing or foreign incarnation freezes admission", () => {
  it("throws on every verb once the metadata row is gone, and refuses to adopt the rows on reopen", () => {
    const path = temporaryStorePath();
    const store = open(path);
    const token = tokenOf(applied(store.acquire(grantOf())));

    const handle = raw(path);
    handle.exec("DELETE FROM coordination_store_meta");
    handle.close();

    expect(() => store.incarnation()).toThrow(LedgerIntegrityError);
    expect(() => store.acquire(grantOf({ contentSha256: D2, operationId: "x" }))).toThrow(LedgerIntegrityError);
    expect(() => store.release(token)).toThrow(LedgerIntegrityError);
    expect(() => store.revoke(token, QUIESCENT)).toThrow(LedgerIntegrityError);
    expect(() => store.takeOver(token, QUIESCENT, grantOf({ holder: "r" }))).toThrow(LedgerIntegrityError);
    store.close();

    // Reopening with the same incarnation id it had would otherwise make every
    // old token valid again: a store recreated without the restore procedure.
    expect(() => open(path, I1)).toThrow(/no incarnation; admission stays frozen/);
    expect(() => open(path, I2)).toThrow(LedgerOpenError);
  });

  it("throws on a handle whose file was relabelled as another kind", () => {
    const path = temporaryStorePath();
    const store = open(path);
    const handle = raw(path);
    handle.exec("UPDATE coordination_store_meta SET store_kind = 'TOOL_CLAIM' WHERE singleton_id = 1");
    handle.close();
    expect(() => store.incarnation()).toThrow(LedgerIntegrityError);
    expect(() => store.acquire(grantOf())).toThrow(LedgerIntegrityError);
  });
});

// ---------------------------------------------------------------------------

describe("the fault seam escalón C drills against (H-7)", () => {
  it("rolls every mutating verb back when it fails after the write and before commit", () => {
    const path = temporaryStorePath();
    const seeding = open(path);
    const token = tokenOf(applied(seeding.acquire(grantOf())));
    const standing = seeding.read(D1);
    seeding.close();

    const failing = open(path, I1, {
      beforeLeaseCommit: () => {
        throw new Error("injected");
      },
    });
    expect(() => failing.acquire(grantOf({ contentSha256: D2, operationId: "cmd-2" }))).toThrow("injected");
    expect(() => failing.release(token)).toThrow("injected");
    expect(() => failing.revoke(token, QUIESCENT)).toThrow("injected");
    expect(() => failing.takeOver(token, QUIESCENT, grantOf({ holder: "r" }))).toThrow("injected");

    expect(failing.read(D2)).toBeNull();
    expect(failing.read(D1)).toEqual(standing);
  });
});

// ---------------------------------------------------------------------------

describe("N-P36B-12 and H-1 -- what this module does not do", () => {
  it("reads no clock, no environment and no process", () => {
    const source = readModuleSource();
    for (const forbidden of ["Date.now(", "new Date(", "process.env", "process.pid", "process.hrtime"]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("mints no identity of its own", () => {
    const source = readModuleSource();
    for (const forbidden of ["randomUUID", "randomBytes", "Math.random"]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("contains no DELETE and no sweep", () => {
    const source = readModuleSource();
    expect(source.includes("DELETE")).toBe(false);
    expect(/\bsweep\b/i.test(source)).toBe(false);
  });

  it("neither imports nor reads the ledger: the blob's state is step 2's, inside the ledger's append", () => {
    const source = readModuleSource();
    // The pattern is assembled rather than written as a literal, so the fence's
    // import scanner does not read it as an import of this suite.
    const specifier = new RegExp("\\bfro" + 'm "([^"]+)";', "g");
    const imports = [...source.matchAll(specifier)].map((match) => String(match[1])).sort();
    expect(imports).toEqual(["../canonical-json/index.js", "../errors/index.js", "better-sqlite3", "node:path"]);
    for (const foreign of ["registry_events", "artifact_blob_read_model", "artifact_pin_read_model", "openLedger"]) {
      expect({ foreign, present: source.includes(foreign) }).toEqual({ foreign, present: false });
    }
  });

  it("names its refusals as facts about the file, closed", () => {
    expect([...ARTIFACT_BLOB_LEASE_REFUSALS]).toEqual([
      "HELD",
      "OPERATION_ID_IN_USE",
      "NOT_HELD",
      "INCARNATION_SUPERSEDED",
      "GENERATION_SUPERSEDED",
      "HOLDER_MISMATCH",
      "QUIESCENCE_OF_ANOTHER_PROCESS",
    ]);
  });
});

// ---------------------------------------------------------------------------

interface WorkerOutcome {
  readonly ok: boolean;
  readonly verb: string | null;
  readonly refusal: string | null;
  readonly generation: number | null;
  readonly holder: string | null;
  readonly errorName: string | null;
}

function ensureWorkerBuilt(): void {
  if (existsSync(WORKER_ENTRY)) return;
  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "--build", join(PACKAGE_ROOT, "test", "tsconfig.json")],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (result.status !== 0 || !existsSync(WORKER_ENTRY)) {
    throw new Error("could not build the ledger test tree for the cross-process test: " + result.stdout + result.stderr);
  }
}

/**
 * Start a racer and resolve once it is prepared and waiting.
 *
 * Every racer has opened the store and read whatever token it needs before any
 * of them is released, which is the situation this store exists to arbitrate.
 */
function startWorker(
  storePath: string,
  mode: "acquire" | "takeover" | "release",
  holder: string,
  operationId: string,
  operation: "PUBLISH" | "RECLAIM" = "PUBLISH",
  incarnationId = I1,
): Promise<{ readonly release: () => void; readonly outcome: Promise<WorkerOutcome> }> {
  const argv = [WORKER_ENTRY, storePath, incarnationId, mode, D1, holder, operationId, operation];
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
    child.on("close", () => {
      reject(new Error("the worker exited before it was ready"));
    });
  });
}

function seededStore(): string {
  const path = temporaryStorePath();
  open(path).close();
  openStores.length = 0;
  return path;
}

describe("N-P36B-11 -- cross-process exclusion, with two arms", () => {
  it("(a) four processes publish one free digest: exactly one holds it, and nobody errors", async () => {
    ensureWorkerBuilt();
    const path = seededStore();

    const racers = await Promise.all(
      [1, 2, 3, 4].map((n) => startWorker(path, "acquire", "publisher/0" + String(n), "cmd-publish-" + String(n))),
    );
    for (const racer of racers) racer.release();
    const outcomes = await Promise.all(racers.map((racer) => racer.outcome));

    // A second APPLIED would be two publishers writing one blob. It is a stop
    // condition, not a flake. And no racer may fail on the lock: a busy error
    // is a crash the arbiter was supposed to turn into a refusal.
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const winners = outcomes.filter((outcome) => outcome.verb === "APPLIED");
    const losers = outcomes.filter((outcome) => outcome.verb === "REFUSE");
    expect({ applied: winners.length, refused: losers.length }).toEqual({ applied: 1, refused: 3 });
    expect(losers.every((outcome) => outcome.refusal === "HELD" && outcome.holder === winners[0]?.holder)).toBe(true);

    const store = open(path);
    const row = store.read(D1);
    expect({ generation: row?.generation, holder: row?.holder }).toEqual({ generation: 1, holder: winners[0]?.holder });
  });

  it("(a') a publisher and a collector race for one digest, and exactly one operation holds it", async () => {
    ensureWorkerBuilt();
    const path = seededStore();

    const racers = await Promise.all([
      startWorker(path, "acquire", "publisher", "cmd-publish", "PUBLISH"),
      startWorker(path, "acquire", "collector", "cmd-reclaim", "RECLAIM"),
    ]);
    for (const racer of racers) racer.release();
    const outcomes = await Promise.all(racers.map((racer) => racer.outcome));
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(outcomes.map((outcome) => outcome.verb).sort()).toEqual(["APPLIED", "REFUSE"]);
    expect(outcomes.find((outcome) => outcome.verb === "REFUSE")?.refusal).toBe("HELD");
  });

  it("(b) two reconcilers observe the same generation of a dead holder: one takes it at OLD + 1, one is refused", async () => {
    ensureWorkerBuilt();
    const path = temporaryStorePath();
    const seeder = open(path);
    applied(seeder.acquire(grantOf({ holderPid: 4242 })));
    seeder.close();
    openStores.length = 0;

    const racers = await Promise.all([
      startWorker(path, "takeover", "reconciler/01", "cmd-publish-1"),
      startWorker(path, "takeover", "reconciler/02", "cmd-publish-1"),
    ]);
    for (const racer of racers) racer.release();
    const outcomes = await Promise.all(racers.map((racer) => racer.outcome));

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const winner = outcomes.find((outcome) => outcome.verb === "APPLIED");
    const loser = outcomes.find((outcome) => outcome.verb === "REFUSE");
    expect(winner?.generation).toBe(2);
    expect({ refusal: loser?.refusal, generation: loser?.generation, holder: loser?.holder }).toEqual({
      refusal: "GENERATION_SUPERSEDED",
      generation: 2,
      holder: winner?.holder,
    });

    const store = open(path);
    expect(store.read(D1)?.generation).toBe(2);
  });

  it("refuses a token whose incarnation was rotated between the read and the write, across processes", async () => {
    ensureWorkerBuilt();
    const path = temporaryStorePath();
    const seeder = open(path);
    applied(seeder.acquire(grantOf()));
    seeder.close();
    openStores.length = 0;

    const racer = await startWorker(path, "release", "claude/opus/publisher/01", "cmd-publish-1");
    const handle = raw(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();
    racer.release();

    const outcome = await racer.outcome;
    expect({ ok: outcome.ok, verb: outcome.verb, refusal: outcome.refusal }).toEqual({
      ok: true,
      verb: "REFUSE",
      refusal: "INCARNATION_SUPERSEDED",
    });
    const store = open(path, I2);
    expect(store.read(D1)?.operation).toBe("PUBLISH");
  });
});

/**
 * The module's code with its prose removed, so a docblock explaining why there
 * is no `DELETE` does not read as one. The fence's `stripComments`, restated
 * because the fence is not importable from a package suite.
 */
function readModuleSource(): string {
  const source = readFileSync(join(PACKAGE_ROOT, "src", "artifact-lease-store", "index.ts"), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
