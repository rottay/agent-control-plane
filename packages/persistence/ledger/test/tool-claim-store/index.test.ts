import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
