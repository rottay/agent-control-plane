import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { LedgerClosedError, LedgerMigrationError, LedgerOpenError, LedgerQueryError } from "../../src/errors/index.js";
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

function open(path: string): ToolClaimStore {
  const store = openToolClaimStore(path);
  stores.push(store);
  return store;
}

function temporaryStore(): { store: ToolClaimStore; path: string } {
  const path = join(temporaryDirectory(), "tool-claims.sqlite");
  return { store: open(path), path };
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
