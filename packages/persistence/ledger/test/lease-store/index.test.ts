import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { LedgerClosedError, LedgerMigrationError, LedgerOpenError, LedgerQueryError } from "../../src/errors/index.js";
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
