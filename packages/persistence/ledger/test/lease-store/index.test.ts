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
import { openLeaseStore } from "../../src/lease-store/index.js";
import type { LeaseGrant, LeaseStore } from "../../src/lease-store/index.js";

/**
 * Evidence for the worktree arbitration store (V2 concurrency C1).
 *
 * The packet's reason to exist is one assertion — **four real operating system
 * processes contend for one worktree and exactly one is granted** — and almost
 * everything else here exists so that assertion cannot pass for the wrong
 * reason. A design that refused everything would pass a same-key race, so the
 * different-key drill is the positive half and is not optional. A fence that
 * reset on release would pass every acquisition test, so monotonicity across a
 * release/re-acquire cycle is drilled directly.
 *
 * **No wall-clock sleep anywhere.** Expiry uses the injected clock, races use
 * real processes, and the crash drill kills on a readiness marker the child
 * writes rather than after a timer.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Five levels, not four: this file sits at
// packages/persistence/ledger/test/lease-store/, so `../../../..` lands on
// `packages/` and the tsc lookup below would fail. It is only reachable when
// `dist-test/` is absent, which is why a wrong value stays dormant until
// somebody runs the suite on a clean tree.
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const WORKER_ENTRY = join(PACKAGE_ROOT, "dist-test", "test", "lease-race-worker", "index.js");

const temporaryDirectories: string[] = [];
const openStores: LeaseStore[] = [];

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
  const directory = mkdtempSync(join(tmpdir(), "acp-lease-"));
  temporaryDirectories.push(directory);
  return directory;
}

function temporaryStorePath(): string {
  return join(temporaryDirectory(), "leases.sqlite");
}

function open(path: string, options: Parameters<typeof openLeaseStore>[1] = {}): LeaseStore {
  const store = openLeaseStore(path, options);
  openStores.push(store);
  return store;
}

function grantOf(overrides: Partial<LeaseGrant> = {}): LeaseGrant {
  return {
    leaseId: "11111111-1111-4111-8111-111111111111",
    holder: "opus@worker-1",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    holderPid: 4242,
    holderToken: null,
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

const WORKTREE = "/tmp/acp-worktree-a";

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
 * `worktree_lease`'s DDL moves this digest and every store in the field refuses
 * to reopen. Pinned rather than recomputed from the source, because a test that
 * recomputed it would agree with any edit at all — and because the legacy
 * fixture below has to write the digest a previous build recorded.
 */
const MIGRATION_ONE_SHA256 = "56c731bc5c2e2f63d387b979166f0d58e86d5145c84b7fd5a0751b8f9be0028f";

/** Migration 1 verbatim, as a build that predates the metadata left it. */
const MIGRATION_ONE_SQL = `
CREATE TABLE worktree_lease (
  worktree_path TEXT    NOT NULL PRIMARY KEY,
  fence         INTEGER NOT NULL,
  lease_id      TEXT,
  holder        TEXT,
  acquired_at   TEXT,
  expires_at    TEXT,
  holder_pid    INTEGER,
  holder_token  TEXT,
  released_at   TEXT
) STRICT;

CREATE UNIQUE INDEX worktree_lease_lease_id
  ON worktree_lease (lease_id)
  WHERE lease_id IS NOT NULL;
`;

function raw(path: string): Database.Database {
  return new Database(path);
}

/**
 * A store file as the previous build wrote it: migration 1 only, with rows.
 *
 * Built by hand rather than by checking out an old build, because what has to be
 * reproduced is the *file*, and the file is fully described by its schema and
 * its migration bookkeeping. If this fixture drifted from what the previous
 * build produced, the open below would fail on the checksum rather than pass for
 * the wrong reason.
 */
function legacyStoreFile(rows: readonly { readonly worktreePath: string; readonly fence: number }[]): string {
  const path = temporaryStorePath();
  const handle = raw(path);
  handle.exec(
    "CREATE TABLE IF NOT EXISTS lease_schema_migrations (" +
      " version INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL) STRICT;",
  );
  handle.exec(MIGRATION_ONE_SQL);
  handle
    .prepare("INSERT INTO lease_schema_migrations (version, name, sha256) VALUES (1, 'worktree_lease', ?)")
    .run(MIGRATION_ONE_SHA256);
  for (const [index, row] of rows.entries()) {
    handle
      .prepare(
        "INSERT INTO worktree_lease (worktree_path, fence, lease_id, holder, acquired_at," +
          " expires_at, holder_pid, holder_token, released_at)" +
          " VALUES (?, ?, ?, 'opus@legacy', '2026-01-01T00:00:00.000Z'," +
          " '2026-01-01T01:00:00.000Z', 4242, NULL, NULL)",
      )
      .run(row.worktreePath, row.fence, "legacy-lease-" + String(index));
  }
  handle.close();
  return path;
}

// ---------------------------------------------------------------------------
// The cross-process racer
// ---------------------------------------------------------------------------

interface WorkerOutcome {
  readonly ok: boolean;
  readonly verb: string | null;
  readonly fence: number | null;
  readonly leaseId: string | null;
  readonly errorName: string | null;
}

/**
 * A child process cannot use the vitest alias that points @acp/contracts at
 * its TypeScript source, so the compiled entry point is what it runs. The
 * worker lives under `test/`, outside the package's shipped `src/` build, so
 * it is compiled by the test tree's own `tsconfig.json` into `dist-test/`,
 * never into the published `dist/`. The build is normally already there,
 * because `pnpm check` typechecks before it tests; this only pays for a build
 * when the tests are run on their own.
 *
 * Carried as its own copy rather than shared with the ledger suite: the entry
 * path differs, and a shared helper would need a registered test-only domain
 * of its own for forty lines.
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
      "could not build the ledger test tree for the cross-process test: " + result.stdout + result.stderr,
    );
  }
}

function runWorker(
  storePath: string,
  worktreePath: string,
  holder: string,
  leaseId: string,
  expiresAt = "2026-01-01T01:00:00.000Z",
): Promise<WorkerOutcome> {
  return new Promise<WorkerOutcome>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKER_ENTRY, storePath, worktreePath, holder, leaseId, expiresAt],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
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

/**
 * Start a worker, wait for it to announce that it holds the write lock, then
 * SIGKILL it between BEGIN and COMMIT.
 *
 * Killed on the marker rather than after a timer: the drill must land inside
 * the transaction on every machine, and a sleep only makes that likely.
 */
function killWorkerMidTransaction(storePath: string, worktreePath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        WORKER_ENTRY,
        storePath,
        worktreePath,
        "opus@doomed",
        "99999999-9999-4999-8999-999999999999",
        "2026-01-01T01:00:00.000Z",
        "60000",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let killed = false;
    child.stderr.on("data", (chunk: Buffer) => {
      if (!killed && chunk.toString("utf8").includes("HOLDING")) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      if (!killed) {
        reject(new Error("the worker exited before it announced the lock"));
        return;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------

describe("cross-process arbitration", () => {
  it("grants exactly one lease when four separate processes race for one worktree", async () => {
    ensureWorkerBuilt();
    const path = temporaryStorePath();

    // Create and migrate, then release the file so the children genuinely
    // contend for the write lock rather than queueing behind this handle.
    open(path).close();

    const holders = ["opus@a", "opus@b", "opus@c", "opus@d"];
    const leaseIds = [
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000003",
      "aaaaaaaa-0000-4000-8000-000000000004",
    ];
    const outcomes = await Promise.all(
      holders.map((holder, index) => runWorker(path, WORKTREE, holder, leaseIds[index] ?? "")),
    );

    const grants = outcomes.filter((outcome) => outcome.verb === "GRANT");
    const refusals = outcomes.filter((outcome) => outcome.verb === "REFUSE");
    // This is the packet's reason to exist. A second grant is a stop condition,
    // not a flake.
    expect({ grants: grants.length, refusals: refusals.length }).toEqual({ grants: 1, refusals: 3 });
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);

    const store = open(path);
    expect(store.list()).toHaveLength(1);
    const row = store.read(WORKTREE);
    // The record names the winner, not merely somebody.
    expect(row?.leaseId).toBe(grants[0]?.leaseId);
    expect(row?.fence).toBe(1);
  });

  it("grants exactly one when they race for a record that already exists and is free", async () => {
    ensureWorkerBuilt();
    const path = temporaryStorePath();

    // The record is created and then released, so the racers meet an existing
    // free row and every one of them takes the UPDATE branch. The PRIMARY KEY
    // protects nothing here -- it prevents two records, and there is already
    // one. Only BEGIN IMMEDIATE prevents two decisions, which is why both
    // halves of the mechanism are named in the module docblock rather than
    // just the key.
    const seed = open(path);
    seed.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    seed.transact(WORKTREE, () => ({ verb: "RELEASE", at: "2026-01-01T00:30:00.000Z" }));
    seed.close();

    const outcomes = await Promise.all(
      ["e", "f", "g", "h"].map((suffix, index) =>
        runWorker(path, WORKTREE, "opus@" + suffix, "cccccccc-0000-4000-8000-00000000000" + String(index)),
      ),
    );

    const grants = outcomes.filter((outcome) => outcome.verb === "GRANT");
    expect({ grants: grants.length, refusals: outcomes.length - grants.length }).toEqual({
      grants: 1,
      refusals: 3,
    });
    const store = open(path);
    // The fence moved exactly once more than the seed's single grant.
    expect(store.read(WORKTREE)?.fence).toBe(2);
    expect(store.list()).toHaveLength(1);
  });

  it("grants every process when they contend for different worktrees", async () => {
    ensureWorkerBuilt();
    const path = temporaryStorePath();
    open(path).close();

    // The positive half. Without it a store that refused everything would pass
    // the same-key drill and look correct.
    const worktrees = ["/tmp/wt-1", "/tmp/wt-2", "/tmp/wt-3", "/tmp/wt-4"];
    const outcomes = await Promise.all(
      worktrees.map((worktree, index) =>
        runWorker(path, worktree, "opus@" + String(index), "bbbbbbbb-0000-4000-8000-00000000000" + String(index)),
      ),
    );

    expect(outcomes.map((outcome) => outcome.verb)).toEqual(["GRANT", "GRANT", "GRANT", "GRANT"]);
    const store = open(path);
    expect(store.list()).toHaveLength(4);
    expect(store.list().every((row) => row.leaseId !== null && row.fence === 1)).toBe(true);
  });

  it("survives a holder killed between BEGIN and COMMIT, half-writing nothing", async () => {
    ensureWorkerBuilt();
    const path = temporaryStorePath();
    open(path).close();

    await killWorkerMidTransaction(path, WORKTREE);

    // The store is intact and the record is all-or-nothing: never a lease id
    // with no holder, never a holder with no lease id.
    const store = open(path, { busyTimeoutMs: 30_000 });
    const row = store.read(WORKTREE);
    if (row !== null) {
      expect(row.leaseId === null).toBe(row.holder === null);
    }

    // And the store still arbitrates afterwards.
    const outcome = store.transact(WORKTREE, (current) =>
      current !== null && current.leaseId !== null
        ? { verb: "REFUSE", reason: "held" }
        : { verb: "GRANT", row: grantOf() },
    );
    expect(["GRANT", "REFUSE"]).toContain(outcome.verb);
    expect(store.list().length).toBeLessThanOrEqual(1);
  });
});

describe("the decision is taken under the lock", () => {
  it("hands decide the record as it is inside the transaction, not as it was read before", () => {
    const path = temporaryStorePath();
    const a = open(path);
    const b = open(path);

    const stale = a.read(WORKTREE);
    expect(stale).toBeNull();

    // Another handle moves the record between the stale read and the decision.
    b.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));

    let seen: unknown = "decide did not run";
    a.transact(WORKTREE, (current) => {
      seen = current?.leaseId ?? null;
      return { verb: "REFUSE", reason: "held" };
    });
    // The whole point of the callback seam: the decision sees the new value.
    expect(seen).toBe(grantOf().leaseId);
  });

  it("rolls back and rethrows when decide throws, leaving the record untouched", () => {
    const path = temporaryStorePath();
    const store = open(path);
    store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    const before = store.read(WORKTREE);

    const failure = caught(() =>
      store.transact(WORKTREE, () => {
        throw new Error("policy exploded");
      }),
    );
    expect((failure as Error).message).toBe("policy exploded");
    expect(store.read(WORKTREE)).toEqual(before);
  });

  it("refuses without writing anything", () => {
    const path = temporaryStorePath();
    const store = open(path);
    const outcome = store.transact(WORKTREE, () => ({ verb: "REFUSE", reason: "held by another" }));
    expect(outcome).toEqual({ verb: "REFUSE", reason: "held by another", row: null });
    // A refusal on an unknown worktree creates no record: the store does not
    // write under a read.
    expect(store.list()).toEqual([]);
  });
});

describe("the fence is monotonic and the record is never deleted", () => {
  it("raises the fence on every grant and keeps it across a release", () => {
    const path = temporaryStorePath();
    const store = open(path);

    const first = store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    expect(first.verb === "GRANT" ? first.row.fence : null).toBe(1);

    const released = store.transact(WORKTREE, () => ({
      verb: "RELEASE",
      at: "2026-01-01T00:30:00.000Z",
    }));
    // Released, not deleted. This is the drill that would have caught a DDL
    // whose release removed the row: the fence would restart at 1 below and a
    // stale holder would read its own old value as current.
    expect(released.verb === "RELEASE" ? released.row : null).toMatchObject({
      leaseId: null,
      holder: null,
      fence: 1,
      releasedAt: "2026-01-01T00:30:00.000Z",
    });
    expect(store.list()).toHaveLength(1);

    const second = store.transact(WORKTREE, () => ({
      verb: "GRANT",
      row: grantOf({ leaseId: "22222222-2222-4222-8222-222222222222", holder: "opus@worker-2" }),
    }));
    expect(second.verb === "GRANT" ? second.row.fence : null).toBe(2);
  });

  it("keeps the record and its fence across close and reopen", () => {
    const path = temporaryStorePath();
    const first = open(path);
    first.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    first.close();

    const reopened = open(path);
    expect(reopened.read(WORKTREE)).toMatchObject({ fence: 1, leaseId: grantOf().leaseId });
  });
});

describe("expiry is swept on an injected clock", () => {
  it("frees an expired record without moving the fence, and the next grant moves it", () => {
    const path = temporaryStorePath();
    const store = open(path);
    store.transact(WORKTREE, () => ({
      verb: "GRANT",
      row: grantOf({ expiresAt: "2026-01-01T00:00:01.000Z" }),
    }));

    // The clock is a parameter. No test in this file sleeps.
    const cleared = store.sweep("2026-01-01T00:00:02.000Z");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ leaseId: null, fence: 1, releasedAt: "2026-01-01T00:00:02.000Z" });

    const next = store.transact(WORKTREE, () => ({
      verb: "GRANT",
      row: grantOf({ leaseId: "33333333-3333-4333-8333-333333333333" }),
    }));
    // Strictly greater: a sweep frees, only a grant raises the fence.
    expect(next.verb === "GRANT" ? next.row.fence : null).toBe(2);
  });

  it("leaves an unexpired record alone", () => {
    const path = temporaryStorePath();
    const store = open(path);
    store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    expect(store.sweep("2026-01-01T00:00:30.000Z")).toEqual([]);
    expect(store.read(WORKTREE)?.leaseId).toBe(grantOf().leaseId);
  });
});

describe("the store fails closed", () => {
  it("throws rather than returning a handle that would grant", () => {
    const directory = temporaryDirectory();

    // A directory where a file must be.
    expect(caught(() => openLeaseStore(directory))).toBeInstanceOf(LedgerOpenError);

    // A path under a file, so the parent cannot hold a database.
    const file = join(directory, "not-a-directory");
    writeFileSync(file, "x");
    expect(caught(() => openLeaseStore(join(file, "leases.sqlite")))).toBeInstanceOf(LedgerOpenError);

    // A file that is not SQLite at all.
    const corrupt = join(directory, "corrupt.sqlite");
    writeFileSync(corrupt, "this is not a database");
    expect(caught(() => openLeaseStore(corrupt))).toBeInstanceOf(LedgerOpenError);

    // The empty path.
    expect(caught(() => openLeaseStore(""))).toBeInstanceOf(LedgerQueryError);
  });

  it("refuses a control-plane ledger handed to it by mistake", () => {
    const path = join(temporaryDirectory(), "control-plane.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE control_plane_events (sequence INTEGER PRIMARY KEY) STRICT;");
    db.close();
    // Two schemas in the authority's own database is not a recoverable state,
    // so it is refused before anything is created.
    expect(caught(() => openLeaseStore(path))).toBeInstanceOf(LedgerOpenError);
  });

  it("refuses a store whose migration history this build does not carry", () => {
    const path = temporaryStorePath();
    open(path).close();
    const db = new Database(path);
    db.prepare("UPDATE lease_schema_migrations SET sha256 = ? WHERE version = 1").run("0".repeat(64));
    db.close();
    expect(caught(() => openLeaseStore(path))).toBeInstanceOf(LedgerMigrationError);
  });

  it("refuses a malformed grant and a use after close", () => {
    const path = temporaryStorePath();
    const store = open(path);
    expect(
      caught(() => store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf({ leaseId: "" }) }))),
    ).toBeInstanceOf(LedgerQueryError);
    // The refused grant wrote nothing.
    expect(store.list()).toEqual([]);
    expect(caught(() => store.transact("", () => ({ verb: "REFUSE", reason: "x" })))).toBeInstanceOf(
      LedgerQueryError,
    );
    expect(
      caught(() => store.transact(WORKTREE, () => ({ verb: "RELEASE", at: "2026-01-01T00:00:00.000Z" }))),
    ).toBeInstanceOf(LedgerQueryError);

    store.close();
    expect(caught(() => store.read(WORKTREE))).toBeInstanceOf(LedgerClosedError);
    expect(caught(() => store.list())).toBeInstanceOf(LedgerClosedError);
    expect(caught(() => store.sweep("2026-01-01T00:00:00.000Z"))).toBeInstanceOf(LedgerClosedError);
    expect(caught(() => store.transact(WORKTREE, () => ({ verb: "REFUSE", reason: "x" })))).toBeInstanceOf(
      LedgerClosedError,
    );
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo E1 — the metadata, the incarnation and the token
// ---------------------------------------------------------------------------

describe("the file carries its own incarnation", () => {
  it("registers the incarnation it is given, as migration two", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    expect(store.incarnation()).toEqual({
      storeKind: "WORKTREE_LEASE",
      incarnationId: I1,
      createdAt: CREATED_AT,
    });
    store.close();

    const handle = raw(path);
    const migrations = handle
      .prepare("SELECT version, name FROM lease_schema_migrations ORDER BY version ASC")
      .all() as { version: number; name: string }[];
    handle.close();
    // Migration 1 is shipped and immutable, so the metadata can only arrive
    // behind the table it governs. The outbox, built from nothing, puts it
    // first.
    expect(migrations).toEqual([
      { version: 1, name: "worktree_lease" },
      { version: 2, name: "coordination_store_meta" },
    ]);
  });

  it("leaves migration one byte-identical", () => {
    const path = temporaryStorePath();
    open(path, { incarnationId: I1, createdAt: CREATED_AT }).close();
    const handle = raw(path);
    const recorded = handle
      .prepare("SELECT sha256 FROM lease_schema_migrations WHERE version = 1")
      .get() as { sha256: string };
    handle.close();
    // A shipped migration is never edited: every store in the field compares
    // this digest on open and refuses a file whose history it does not carry.
    expect(recorded.sha256).toBe(MIGRATION_ONE_SHA256);
  });

  it("does not rotate an incarnation a reopen disagrees with", () => {
    const path = temporaryStorePath();
    open(path, { incarnationId: I1, createdAt: CREATED_AT }).close();

    const second = open(path, { incarnationId: I2, createdAt: "2026-09-13T00:00:00.000Z" });
    // Rotating an incarnation is coordination 8.2's restore, which has a
    // quiescence proof in front of it. It is not a side effect of reopening.
    expect(second.incarnation()?.incarnationId).toBe(I1);
    expect(second.incarnation()?.createdAt).toBe(CREATED_AT);
  });

  it("holds exactly one metadata row, by CHECK rather than by convention", () => {
    const path = temporaryStorePath();
    open(path, { incarnationId: I1, createdAt: CREATED_AT }).close();
    const handle = raw(path);
    expect(() =>
      handle
        .prepare(
          "INSERT INTO coordination_store_meta (singleton_id, store_kind, store_incarnation_id, created_at)" +
            " VALUES (2, 'WORKTREE_LEASE', ?, ?)",
        )
        .run(I2, CREATED_AT),
    ).toThrow();
    // And the incarnation is unique, and has no default: a row that named no
    // incarnation would be a file that issued tokens nobody could place.
    expect(() =>
      handle
        .prepare("INSERT INTO coordination_store_meta (singleton_id, store_kind, created_at) VALUES (3, 'OUTBOX', ?)")
        .run(CREATED_AT),
    ).toThrow();
    handle.close();
  });

  it("refuses an incarnation supplied without its instant, and the reverse", () => {
    const path = temporaryStorePath();
    expect(caught(() => openLeaseStore(path, { incarnationId: I1 }))).toBeInstanceOf(LedgerQueryError);
    expect(caught(() => openLeaseStore(path, { createdAt: CREATED_AT }))).toBeInstanceOf(LedgerQueryError);
    expect(caught(() => openLeaseStore(path, { incarnationId: "", createdAt: CREATED_AT }))).toBeInstanceOf(
      LedgerQueryError,
    );
  });

  it("refuses a coordination file whose store kind is not WORKTREE_LEASE", () => {
    const path = temporaryStorePath();
    open(path, { incarnationId: I1, createdAt: CREATED_AT }).close();
    const handle = raw(path);
    handle.exec("UPDATE coordination_store_meta SET store_kind = 'OUTBOX' WHERE singleton_id = 1");
    handle.close();
    // Reachable because the CHECK carries all five kinds of section 8.1's
    // dictionary rather than only this one. Narrowed to 'WORKTREE_LEASE' the
    // refusal could not be constructed, and a guard nobody can drill is not a
    // guard. The identity of a coordination file is its kind, not its name.
    expect(caught(() => openLeaseStore(path))).toBeInstanceOf(LedgerOpenError);
  });

  it("refuses a sibling store of this package before writing anything to it", () => {
    for (const sibling of ["tool_claim_schema_migrations", "outbox_schema_migrations", "schema_migrations"]) {
      const path = join(temporaryDirectory(), "leases.sqlite");
      const handle = raw(path);
      handle.exec("CREATE TABLE " + sibling + " (version INTEGER PRIMARY KEY) STRICT;");
      handle.close();

      expect(caught(() => openLeaseStore(path))).toBeInstanceOf(LedgerOpenError);

      // And it is refused *before writing anything*. The old guard was a list
      // of foreign table names, so a lease store opened on a sibling's file
      // created `lease_schema_migrations` there, failed later in migration 2,
      // and left the sibling carrying a table its own guard then refuses
      // forever. Colonizing a neighbour is not a recoverable mistake.
      const after = raw(path);
      const tables = (
        after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      after.close();
      expect(tables).toEqual([sibling]);
    }
  });

  it("reads the metadata now, not as it was at open", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    const handle = raw(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();
    // A handle that cached the incarnation at open would carry the answer from
    // before a restore into the first decision taken after one -- which is the
    // only decision that needed it.
    expect(store.incarnation()?.incarnationId).toBe(I2);
  });

  it("refuses to keep arbitrating a file that turned into another store", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    const handle = raw(path);
    handle.exec("UPDATE coordination_store_meta SET store_kind = 'ARTIFACT_BLOB_LEASE' WHERE singleton_id = 1");
    handle.close();
    // An absent metadata row is lawful here; a row that now belongs to somebody
    // else is not, and the open-time guard cannot catch what happened after it.
    expect(caught(() => store.incarnation())).toBeInstanceOf(LedgerIntegrityError);
  });
});

describe("every grant is stamped with the incarnation that made it", () => {
  it("stamps the first grant and the re-grant, and conserves it across release and sweep", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });

    const first = store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    expect(first.verb === "GRANT" ? first.row.storeIncarnationId : null).toBe(I1);

    const released = store.transact(WORKTREE, () => ({ verb: "RELEASE", at: "2026-01-01T00:30:00.000Z" }));
    // Release clears the holder and conserves the incarnation: the column names
    // the incarnation that granted the lease being released, and would say
    // something false about any other.
    expect(released.verb === "RELEASE" ? released.row.storeIncarnationId : null).toBe(I1);

    const second = store.transact(WORKTREE, () => ({
      verb: "GRANT",
      row: grantOf({ leaseId: "22222222-2222-4222-8222-222222222222" }),
    }));
    expect(second.verb === "GRANT" ? second.row : null).toMatchObject({ fence: 2, storeIncarnationId: I1 });

    const cleared = store.sweep("2026-01-01T02:00:00.000Z");
    expect(cleared[0]).toMatchObject({ leaseId: null, fence: 2, storeIncarnationId: I1 });
  });

  it("stamps null while the file carries no incarnation, and refuses nothing", () => {
    const path = temporaryStorePath();
    // The adoption window: every caller in the field opens without one today.
    const store = open(path);
    expect(store.incarnation()).toBeNull();

    const granted = store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    expect(granted.verb === "GRANT" ? granted.row.storeIncarnationId : "unset").toBeNull();
    expect(granted.verb).toBe("GRANT");
  });

  it("writes neither the operation nor the revocation acknowledgement", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    store.transact(WORKTREE, () => ({ verb: "RELEASE", at: "2026-01-01T00:30:00.000Z" }));
    store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    // Coordination section 3 declares both columns; escalon F fills them. A
    // store that invented an operation id would be claiming an intention it
    // cannot read.
    expect(store.read(WORKTREE)).toMatchObject({ operationId: null, revocationAcknowledgedAt: null });
  });
});

describe("a file written before the metadata existed still works, and gains it", () => {
  it("migrates in place, leaving the rows intact and the new columns null", () => {
    const path = legacyStoreFile([
      { worktreePath: WORKTREE, fence: 7 },
      { worktreePath: "/tmp/acp-worktree-b", fence: 2 },
    ]);
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });

    expect(store.list().map((row) => ({ worktreePath: row.worktreePath, fence: row.fence }))).toEqual([
      { worktreePath: WORKTREE, fence: 7 },
      { worktreePath: "/tmp/acp-worktree-b", fence: 2 },
    ]);
    // Section 8.1 :384: additive and null on rows that predate the change.
    expect(store.read(WORKTREE)).toMatchObject({
      leaseId: "legacy-lease-0",
      storeIncarnationId: null,
      operationId: null,
      revocationAcknowledgedAt: null,
    });

    const handle = raw(path);
    const recorded = handle
      .prepare("SELECT sha256 FROM lease_schema_migrations WHERE version = 1")
      .get() as { sha256: string };
    handle.close();
    expect(recorded.sha256).toBe(MIGRATION_ONE_SHA256);
  });

  it("releases and sweeps a legacy record without inventing an incarnation for it", () => {
    const path = legacyStoreFile([{ worktreePath: WORKTREE, fence: 7 }]);
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });

    const released = store.transact(WORKTREE, () => ({ verb: "RELEASE", at: "2026-01-01T00:30:00.000Z" }));
    // Releasing is not granting. The record belonged to an incarnation nobody
    // recorded, and stamping the live one here would claim this file granted a
    // lease it never granted.
    expect(released.verb === "RELEASE" ? released.row : null).toMatchObject({
      fence: 7,
      storeIncarnationId: null,
    });
  });

  it("stamps the live incarnation when a legacy record is granted again", () => {
    const path = legacyStoreFile([{ worktreePath: WORKTREE, fence: 7 }]);
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });

    const regranted = store.transact(WORKTREE, () => ({
      verb: "GRANT",
      row: grantOf({ leaseId: "44444444-4444-4444-8444-444444444444" }),
    }));
    // Section 4 :153: NOT NULL for grants of the active incarnation. The record
    // is being granted again, so it belongs to this incarnation whatever it
    // belonged to before.
    expect(regranted.verb === "GRANT" ? regranted.row : null).toMatchObject({
      fence: 8,
      storeIncarnationId: I1,
    });
  });
});

describe("N-P18-11 -- the fence number alone is never the token", () => {
  it("refuses a token whose fence is right and whose incarnation is not", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));

    const handle = raw(path);
    // The file is restored under a new incarnation. Nothing else changes: the
    // record still stands at fence 1, which is exactly what a rebuilt file
    // hands out again.
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();

    let ran = false;
    const refused = store.transact(
      WORKTREE,
      () => {
        ran = true;
        return { verb: "RELEASE", at: "2026-01-01T00:30:00.000Z" };
      },
      { incarnationId: I1, fence: 1 },
    );
    expect(refused.verb).toBe("REFUSE");
    // A stale token is a precondition that failed, not a policy that declined:
    // the caller's decision is never consulted, so it cannot write.
    expect(ran).toBe(false);
    expect(store.read(WORKTREE)?.releasedAt).toBeNull();

    // And the same call applies once the caller carries the incarnation that is
    // actually live -- which proves the refusal was about the incarnation and
    // not about anything else in the token.
    const applied = store.transact(
      WORKTREE,
      () => ({ verb: "RELEASE", at: "2026-01-01T00:30:00.000Z" }),
      { incarnationId: I2, fence: 1 },
    );
    expect(applied.verb).toBe("RELEASE");
  });

  it("refuses a token whose incarnation is right and whose fence is not", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    store.transact(WORKTREE, () => ({ verb: "RELEASE", at: "2026-01-01T00:30:00.000Z" }));
    store.transact(WORKTREE, () => ({
      verb: "GRANT",
      row: grantOf({ leaseId: "55555555-5555-4555-8555-555555555555" }),
    }));

    // The holder from before the re-grant. Both halves of the pair are checked,
    // not just the one that is not in the row.
    const refused = store.transact(WORKTREE, () => ({ verb: "RELEASE", at: "x" }), {
      incarnationId: I1,
      fence: 1,
    });
    expect(refused.verb).toBe("REFUSE");
    expect(store.read(WORKTREE)?.fence).toBe(2);
  });

  it("checks the incarnation inside the transaction, not at open", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));

    // The handle is already open when the metadata is rewritten from another
    // connection. A store that read the incarnation once at open would pass the
    // negative above by accident and fail in the field.
    const handle = raw(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();

    const refused = store.transact(WORKTREE, () => ({ verb: "RELEASE", at: "x" }), {
      incarnationId: I1,
      fence: 1,
    });
    expect(refused.verb).toBe("REFUSE");
  });

  it("refuses every token on a file that carries no incarnation", () => {
    const path = temporaryStorePath();
    const store = open(path);
    store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));
    // Fail closed. Nobody in the adoption window passes a token, and a store
    // that accepted one it cannot place would be answering a question it has no
    // instrument for.
    expect(
      store.transact(WORKTREE, () => ({ verb: "RELEASE", at: "x" }), { incarnationId: I1, fence: 1 }).verb,
    ).toBe("REFUSE");
  });

  it("refuses a malformed token by name rather than comparing it", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    expect(
      caught(() =>
        store.transact(WORKTREE, () => ({ verb: "REFUSE", reason: "x" }), { incarnationId: "", fence: 1 }),
      ),
    ).toBeInstanceOf(LedgerQueryError);
    expect(
      caught(() =>
        store.transact(WORKTREE, () => ({ verb: "REFUSE", reason: "x" }), { incarnationId: I1, fence: 0 }),
      ),
    ).toBeInstanceOf(LedgerQueryError);
  });

  it("behaves exactly as before when no token is supplied", () => {
    const path = temporaryStorePath();
    const store = open(path, { incarnationId: I1, createdAt: CREATED_AT });
    store.transact(WORKTREE, () => ({ verb: "GRANT", row: grantOf() }));

    const handle = raw(path);
    handle.prepare("UPDATE coordination_store_meta SET store_incarnation_id = ? WHERE singleton_id = 1").run(I2);
    handle.close();

    // The gate is opt-in. The adopters pass no token and are not changed by
    // this escalon, so a restore they never heard about must not start
    // refusing their calls.
    expect(store.transact(WORKTREE, () => ({ verb: "RELEASE", at: "2026-01-01T00:30:00.000Z" })).verb).toBe(
      "RELEASE",
    );
  });

  it("refuses the incarnation before it looks at the number", () => {
    const source = readModuleSource();
    // The shape half of section 4.3's "the fence number alone is never the
    // token". A comparison that reached the fence first would be a store that
    // could answer about a number it cannot place, and no behavioural test
    // distinguishes the two orders.
    const incarnation = source.indexOf(".incarnationId !== token.incarnationId");
    const fence = source.indexOf("!== token.fence");
    expect(incarnation).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(-1);
    expect(incarnation).toBeLessThan(fence);
  });
});

describe("the store claims no driver capability", () => {
  it("names no engine, no mode and no capability property", () => {
    const source = readModuleSource();
    // The test-side half of L-C-1c. Arbitration is not a durability-engine
    // property: SERIALIZED_PER_TASK is per task key, and two tasks writing one
    // worktree are two keys. The file that provides exclusion may not imply
    // that an engine already did.
    for (const forbidden of [
      "SERIALIZED_PER_TASK",
      "DRIVER_CAPABILITY_PROPERTIES",
      "RESTATE",
      "@acp/runtime",
      "@acp/durability",
    ]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("reads no clock, no environment and no process", () => {
    const source = readModuleSource();
    for (const forbidden of ["Date.now(", "new Date(", "process.env", "process.kill", "process.pid"]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("contains no DELETE at all", () => {
    // The record is never deleted, so the fence cannot reset. Asserted over the
    // source rather than inferred from the behaviour above.
    expect(readModuleSource().includes("DELETE")).toBe(false);
  });

  it("mints no identity of its own", () => {
    const source = readModuleSource();
    // Section 8.1 gives the incarnation no implicit default, twice. A UUID
    // minted here would read an environment this module may not read -- and
    // would make the restore drills above impossible to aim, because a test
    // could no longer choose which incarnation a record was granted under.
    for (const forbidden of ["randomUUID", "randomBytes", "Math.random"]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("declares the two columns escalón F owns and writes neither of them", () => {
    const source = readModuleSource();
    // Every statement in this module that mutates the table, from the verb to
    // the `.run(` that executes it. Four: the first grant, the re-grant, the
    // release and the sweep.
    const mutations = [...source.matchAll(/(?:INSERT INTO|UPDATE) worktree_lease[\s\S]*?\.run\(/g)].map(
      (match) => match[0],
    );
    expect(mutations).toHaveLength(4);

    for (const column of ["operation_id", "revocation_acknowledged_at"]) {
      // Declared, so escalón F can fill it without reopening the migration.
      expect({ column, declared: source.includes("ADD COLUMN " + column) }).toEqual({ column, declared: true });
      // And written by nothing here. A store that stamped an operation id would
      // be claiming an intention it cannot read.
      for (const statement of mutations) {
        expect({ column, written: statement.includes(column) }).toEqual({ column, written: false });
      }
    }

    // Non-vacuous: the column this escalón *does* stamp is in the two grants,
    // and absent from the release and the sweep, which conserve it.
    const stamping = mutations.filter((statement) => statement.includes("store_incarnation_id"));
    expect(stamping).toHaveLength(2);
  });
});

/**
 * The module's code with its prose removed.
 *
 * The claims below are about what the module *does*, so they are asserted over
 * code and not over comments — a docblock that explains why there is no
 * `DELETE` must not read as a `DELETE`. This is the same distinction the
 * architecture fence draws with its own `stripComments`, restated locally
 * because the fence is not importable from a package suite.
 */
function readModuleSource(): string {
  const source = readFileSync(join(PACKAGE_ROOT, "src", "lease-store", "index.ts"), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
