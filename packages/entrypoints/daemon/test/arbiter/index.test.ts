import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLeaseStore } from "@acp/ledger";
import type { LeaseStore } from "@acp/ledger";
import { deriveInvocation, deterministicUuid } from "@acp/runtime";
import type { DurableInvocation, LedgerPort } from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalInstant, createArbiter } from "../../src/arbiter/index.js";
import type { ArbiterOptions } from "../../src/arbiter/index.js";
import type { ProcessFacts, ProcessInspector } from "../../src/identity-probe/index.js";

/**
 * Evidence for the fenced worktree lease (V2 concurrency C2).
 *
 * Two properties carry this file. The first is the packet's reason to exist:
 * one holder per worktree, and a fence that a successor moves so the loser can
 * find out. The second is K2 — every instant reaching the store is canonical
 * UTC — and it is drilled by **demonstrating the hazard** rather than by
 * asserting the rule: the store orders `expires_at` as SQLite TEXT, so two
 * spellings of one instant sort differently, and the drills below show that
 * divergence and then show the canonicaliser closing it.
 *
 * No wall-clock sleep: the clock is injected and death is a fact the fake
 * inspector reports.
 */

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * SQLite's own comparison for a TEXT column, restated over two runtime values.
 *
 * Through a function on purpose: with the literals inline the compiler folds
 * the comparison and the linter calls the assertion unnecessary — which is
 * exactly backwards. That the ordering is decidable at compile time is the
 * hazard, not a reason to stop asserting it.
 */
function lexicallyBefore(left: string, right: string): boolean {
  return left < right;
}
const WORKTREE = "/tmp/acp-c2-worktree";
const HOLDER = "anthropic/opus/implementer/0001";
const T0 = "2026-09-04T05:00:00.000Z";

const directories: string[] = [];
const stores: LeaseStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryStore(): LeaseStore {
  const directory = mkdtempSync(join(tmpdir(), "acp-c2-"));
  directories.push(directory);
  const store = openLeaseStore(join(directory, "leases.sqlite"));
  stores.push(store);
  return store;
}

/** A ledger that records what it was handed, and knows one task. */
function fakeLedger(state: { task: string | null } = { task: "RUNNING" }): LedgerPort & {
  readonly appended: unknown[];
} {
  const appended: unknown[] = [];
  const keys = new Set<string>();
  return {
    appended,
    append(candidate: unknown) {
      const event = candidate as { idempotencyKey: string; eventId: string };
      // The real ledger refuses a duplicate idempotency key as an exact replay.
      const inserted = !keys.has(event.idempotencyKey);
      if (inserted) {
        keys.add(event.idempotencyKey);
        appended.push(candidate);
      }
      return { inserted, record: { event: candidate as never } };
    },
    getTask(_taskId: string) {
      void _taskId;
      return state.task === null
        ? null
        : { currentState: state.task as never, latestAttempt: 1, firstSequence: 1 };
    },
    getEventBySequence: () => null,
    getEventByIdempotencyKey: () => null,
  };
}

function inspector(inspect: (pid: number) => Promise<ProcessFacts | null>): ProcessInspector {
  return { inspect };
}

const ALIVE: ProcessInspector = inspector(() =>
  Promise.resolve({ startToken: "token-1", argvDigest: "digest-1" }),
);
const GONE: ProcessInspector = inspector(() => Promise.resolve(null));
const REUSED: ProcessInspector = inspector(() =>
  Promise.resolve({ startToken: "token-OTHER", argvDigest: "digest-1" }),
);
const HOSTILE: ProcessInspector = inspector(() => Promise.reject(new Error("ps unavailable")));

function invocationOf(): DurableInvocation {
  return deriveInvocation("task-c2", 1, T0, "a".repeat(64));
}

function arbiterOn(
  store: LeaseStore,
  overrides: Partial<ArbiterOptions> = {},
): ReturnType<typeof createArbiter> {
  return createArbiter({
    store,
    ledger: fakeLedger(),
    invocation: invocationOf(),
    worktreePath: WORKTREE,
    holder: HOLDER,
    identity: { pid: 4242, startToken: "token-1", argvDigest: "digest-1" },
    inspector: ALIVE,
    ttlMs: 60_000,
    now: () => T0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe("one holder per worktree", () => {
  it("grants a free worktree, at fence one, with exactly the five contract fields", async () => {
    const store = temporaryStore();
    const ledger = fakeLedger();
    const outcome = await arbiterOn(store, { ledger }).acquire();

    if (!outcome.ok) throw new Error("expected a grant, got " + outcome.reason);
    expect(outcome.hold.fence).toBe(1);
    // The store's own columns stay in the store: the contract's Lease is five
    // fields and gains no fence, pid, token or release stamp.
    expect(Object.keys(outcome.hold.lease).sort()).toEqual([
      "acquiredAt",
      "expiresAt",
      "holder",
      "leaseId",
      "worktreePath",
    ]);
    // Derived, never minted.
    expect(outcome.hold.lease.leaseId).toBe(deterministicUuid("lease/" + WORKTREE + "/1"));
    expect(outcome.events.map((event) => event.type)).toEqual(["LEASE_ACQUIRED"]);
    expect(ledger.appended).toHaveLength(1);

    const row = store.read(WORKTREE);
    expect(row?.holderPid).toBe(4242);
    expect(row?.holderToken).toBe("token-1");
  });

  it("refuses a second holder with the pure rule's own reason and field, writing nothing", async () => {
    const store = temporaryStore();
    await arbiterOn(store).acquire();
    const before = store.read(WORKTREE);

    const ledger = fakeLedger();
    const second = await arbiterOn(store, {
      ledger,
      holder: "anthropic/opus/implementer/0002",
      identity: { pid: 5252, startToken: "token-2", argvDigest: "digest-2" },
    }).acquire();

    expect(second).toEqual({
      ok: false,
      reason: "LEASE_HELD_BY_ANOTHER",
      at: "request.candidate.worktreePath",
    });
    // No event, and the record is exactly as it was.
    expect(ledger.appended).toEqual([]);
    expect(store.read(WORKTREE)).toEqual(before);
  });

  it("grants two different worktrees independently", async () => {
    const store = temporaryStore();
    const first = await arbiterOn(store).acquire();
    const second = await arbiterOn(store, { worktreePath: "/tmp/acp-c2-other" }).acquire();
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(store.list()).toHaveLength(2);
  });
});

describe("recovery: expiry and proven death", () => {
  it("lets a successor take an expired lease, bumping the fence and recording the cause", async () => {
    const store = temporaryStore();
    await arbiterOn(store).acquire();

    const ledger = fakeLedger();
    const later = "2026-09-04T06:00:00.000Z"; // past the 60s ttl
    const successor = await arbiterOn(store, {
      ledger,
      holder: "anthropic/opus/implementer/0002",
      identity: { pid: 5252, startToken: "token-2", argvDigest: "digest-2" },
      now: () => later,
    }).acquire();

    if (!successor.ok) throw new Error("expected a grant, got " + successor.reason);
    expect(successor.hold.fence).toBe(2);
    expect(successor.events.map((event) => event.type)).toEqual([
      "LEASE_REVOKED",
      "LEASE_ACQUIRED",
    ]);
    expect(successor.events[0]?.payload["cause"]).toBe("EXPIRED");
  });

  it("decides a reclaim on the two facts the store carries, and fails closed on the rest", async () => {
    // The four rows of the liveness rule, each against a live, unexpired lease
    // so that only the probe can decide the outcome.
    const rows: readonly { readonly probe: ProcessInspector; readonly reclaim: boolean }[] = [
      { probe: GONE, reclaim: true },
      { probe: REUSED, reclaim: true },
      { probe: ALIVE, reclaim: false },
      { probe: HOSTILE, reclaim: false },
    ];

    for (const row of rows) {
      const store = temporaryStore();
      await arbiterOn(store).acquire();
      const before = store.read(WORKTREE);

      const successor = await arbiterOn(store, {
        holder: "anthropic/opus/implementer/0002",
        identity: { pid: 5252, startToken: "token-2", argvDigest: "digest-2" },
        inspector: row.probe,
      }).acquire();

      expect({ probe: rows.indexOf(row), granted: successor.ok }).toEqual({
        probe: rows.indexOf(row),
        granted: row.reclaim,
      });
      if (!row.reclaim) {
        // A refused reclaim changes nothing at all.
        expect(store.read(WORKTREE)).toEqual(before);
      } else if (successor.ok) {
        expect(successor.events[0]?.payload["cause"]).toBe("HOLDER_DEAD");
      }
    }
  });
});

describe("a liveness verdict is bound to the record it judged", () => {
  it("grants exactly one successor when two race a dead predecessor, and blames no live holder", async () => {
    const store = temporaryStore();

    // A predecessor that is provably gone, unexpired, so only the probe can
    // decide anything.
    store.transact(WORKTREE, () => ({
      verb: "GRANT",
      row: {
        leaseId: "00000000-0000-4000-8000-0000000000ff",
        holder: "anthropic/opus/implementer/0009",
        acquiredAt: T0,
        expiresAt: "2099-01-01T00:00:00.000Z",
        holderPid: 999_001,
        holderToken: "token-dead",
      },
    }));

    // Successor A's probe proves death but resolves only when the gate opens.
    // Successor B's proves it at once. Gated, not timed: the interleaving is
    // chosen by the test rather than raced for.
    let openGate = (): void => undefined;
    const gate = new Promise<void>((resolvePromise) => {
      openGate = (): void => {
        resolvePromise();
      };
    });
    const slowlyGone: ProcessInspector = {
      inspect: async () => {
        await gate;
        return null;
      },
    };

    const a = arbiterOn(store, {
      holder: "anthropic/opus/implementer/0002",
      identity: { pid: 1001, startToken: "token-a", argvDigest: "digest-a" },
      inspector: slowlyGone,
    });
    const ledgerB = fakeLedger();
    const b = arbiterOn(store, {
      ledger: ledgerB,
      holder: "anthropic/opus/implementer/0003",
      identity: { pid: 1002, startToken: "token-b", argvDigest: "digest-b" },
      inspector: GONE,
    });

    // A reads the row and stalls inside its probe; B reclaims and becomes the
    // live holder; A then resumes holding a verdict about a record that is gone.
    const pendingA = a.acquire();
    const outcomeB = await b.acquire();
    openGate();
    const outcomeA = await pendingA;

    if (!outcomeB.ok) throw new Error("expected B to reclaim the dead predecessor");
    // Exactly one successor holds the worktree. This is stop 1: two holders,
    // ever, in any drill.
    expect({ a: outcomeA.ok, b: outcomeB.ok }).toEqual({ a: false, b: true });
    expect(outcomeA.ok ? null : outcomeA.reason).toBe("LEASE_HELD_BY_ANOTHER");

    // B's record is exactly as B left it: the loser wrote nothing.
    const row = store.read(WORKTREE);
    expect(row?.leaseId).toBe(outcomeB.hold.lease.leaseId);
    expect(row?.fence).toBe(2);
    expect(row?.holderPid).toBe(1002);

    // And no death was recorded against a living holder. B's own reclaim of the
    // dead predecessor is legitimate and names the predecessor's lease; nothing
    // names B's.
    const blamed = ledgerB.appended
      .map((event) => event as { type: string; payload: Record<string, string> })
      .filter((event) => event.type === "LEASE_REVOKED")
      .map((event) => event.payload["leaseId"]);
    expect(blamed).toEqual(["00000000-0000-4000-8000-0000000000ff"]);
    expect(blamed).not.toContain(outcomeB.hold.lease.leaseId);
  });
});

describe("the fence is what bounds overlap", () => {
  it("tells a holder whose fence moved that it lost the lease, and it modifies nothing", async () => {
    const store = temporaryStore();
    const first = await arbiterOn(store).acquire();
    if (!first.ok) throw new Error("expected a grant");

    // A successor proves the holder is gone and takes the worktree at fence 2.
    const successor = await arbiterOn(store, {
      holder: "anthropic/opus/implementer/0002",
      identity: { pid: 5252, startToken: "token-2", argvDigest: "digest-2" },
      inspector: GONE,
    }).acquire();
    if (!successor.ok) throw new Error("expected the reclaim to grant");

    const before = store.read(WORKTREE);
    const renewal = first.hold.renew();
    expect(renewal).toEqual({ ok: false, lost: true, reason: "LEASE_FENCE_LOST" });
    // The loser must not touch the winner's record.
    expect(store.read(WORKTREE)).toEqual(before);

    // And a losing holder's release is not a way to free the winner's lease.
    expect(first.hold.release("RELEASED")).toEqual([]);
    expect(store.read(WORKTREE)?.leaseId).toBe(successor.hold.lease.leaseId);
  });

  it("refuses a renewal that would not extend, in the pure rule's own words", () => {
    // The clock is frozen, so the recomputed expiry equals the existing one:
    // re-stamping is not an extension, and the rules say so rather than the
    // arbiter inventing a reason.
    const store = temporaryStore();
    return arbiterOn(store)
      .acquire()
      .then((outcome) => {
        if (!outcome.ok) throw new Error("expected a grant");
        expect(outcome.hold.renew()).toEqual({
          ok: false,
          lost: false,
          reason: "LEASE_RENEWAL_NOT_EXTENDING",
        });
      });
  });

  it("extends and re-records when the clock has advanced", async () => {
    const store = temporaryStore();
    const ledger = fakeLedger();
    let instant = T0;
    const outcome = await arbiterOn(store, { ledger, now: () => instant }).acquire();
    if (!outcome.ok) throw new Error("expected a grant");

    instant = "2026-09-04T05:00:30.000Z";
    expect(outcome.hold.renew()).toEqual({ ok: true, lost: false, reason: null });
    expect(store.read(WORKTREE)?.expiresAt).toBe("2026-09-04T05:01:30.000Z");
    // The renewal is recorded: a fold that never saw it would believe the lease
    // expires earlier than it does.
    expect(ledger.appended).toHaveLength(2);
  });
});

describe("release and idempotency", () => {
  it("releases once, keeps the record and its fence, and is a no-op afterwards", async () => {
    const store = temporaryStore();
    const outcome = await arbiterOn(store).acquire();
    if (!outcome.ok) throw new Error("expected a grant");

    const events = outcome.hold.release("RELEASED");
    expect(events.map((event) => event.type)).toEqual(["LEASE_REVOKED"]);
    const row = store.read(WORKTREE);
    expect(row?.leaseId).toBeNull();
    expect(row?.fence).toBe(1);

    // Idempotent by checking the hold, never by catching C1's throw: the store
    // throws on a RELEASE of a never-granted record, and routing contention
    // through that throw would turn a programming error into an outcome.
    expect(outcome.hold.release("RELEASED")).toEqual([]);
  });

  it("derives the same identifiers for the same worktree and fence", async () => {
    const first = await arbiterOn(temporaryStore()).acquire();
    const second = await arbiterOn(temporaryStore()).acquire();
    if (!first.ok || !second.ok) throw new Error("expected grants");
    expect(first.hold.lease.leaseId).toBe(second.hold.lease.leaseId);
  });

  it("appends nothing until the ledger knows the task, then appends it once", async () => {
    const store = temporaryStore();
    const state = { task: null as string | null };
    const ledger = fakeLedger(state);
    const outcome = await arbiterOn(store, { ledger }).acquire();
    if (!outcome.ok) throw new Error("expected a grant");

    // The walk opens the task; an event appended before it would create the
    // task row and the walk would resume at step 1, never writing its own
    // TASK_DISCOVERED.
    expect(ledger.appended).toEqual([]);
    const arbiter = arbiterOn(store, { ledger });
    void arbiter;

    state.task = "RUNNING";
    outcome.hold.release("RELEASED");
    // Both the grant and the revocation land, in order, once the task exists.
    expect(ledger.appended).toHaveLength(2);
  });

  it("rolls back and rethrows when a decision throws, leaving the record untouched", async () => {
    const store = temporaryStore();
    await arbiterOn(store).acquire();
    const before = store.read(WORKTREE);
    expect(() =>
      store.transact(WORKTREE, () => {
        throw new Error("policy exploded");
      }),
    ).toThrow("policy exploded");
    expect(store.read(WORKTREE)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// K2 — the store orders text, the runtime orders instants
// ---------------------------------------------------------------------------

describe("every instant handed to the store is canonical UTC", () => {
  it("writes canonical instants at all four seams", async () => {
    const store = temporaryStore();
    const outcome = await arbiterOn(store).acquire();
    if (!outcome.ok) throw new Error("expected a grant");

    const granted = store.read(WORKTREE);
    for (const value of [granted?.acquiredAt, granted?.expiresAt]) {
      expect({ value, canonical: CANONICAL.test(value ?? ""), length: value?.length }).toEqual({
        value,
        canonical: true,
        length: 24,
      });
    }

    outcome.hold.release("RELEASED");
    const released = store.read(WORKTREE)?.releasedAt;
    expect({ canonical: CANONICAL.test(released ?? ""), length: released?.length }).toEqual({
      canonical: true,
      length: 24,
    });
    // The fourth seam: the sweep boundary is the same producer's output.
    expect(CANONICAL.test(canonicalInstant(T0, "now"))).toBe(true);
  });

  it("demonstrates the hazard: an offset spelling sorts before the same instant in UTC", async () => {
    const offset = "2026-09-04T00:00:00.000-05:00";
    const utc = "2026-09-04T05:00:00.000Z";
    // The same instant...
    expect(Date.parse(offset)).toBe(Date.parse(utc));
    // ...and the store compares TEXT, where they are not the same at all. A
    // lease stamped in the offset form would be swept while it was still live.
    expect(lexicallyBefore(offset, utc)).toBe(true);

    const store = temporaryStore();
    const outcome = await arbiterOn(store, { now: () => offset }).acquire();
    if (!outcome.ok) throw new Error("expected a grant");
    // Canonicalised at the door: the offset form never reaches the store.
    expect(store.read(WORKTREE)?.acquiredAt).toBe(utc);
  });

  it("demonstrates the hazard: a missing-millis spelling sorts after, and would survive its sweep", async () => {
    const short = "2026-09-04T05:00:00Z";
    const utc = "2026-09-04T05:00:00.000Z";
    expect(Date.parse(short)).toBe(Date.parse(utc));
    // `Z` (0x5A) sorts after `.` (0x2E), so an expired lease stamped this way
    // would fail `expires_at <= now` and stay held.
    expect(lexicallyBefore(utc, short)).toBe(true);

    const store = temporaryStore();
    const outcome = await arbiterOn(store, { ttlMs: 1_000, now: () => short }).acquire();
    if (!outcome.ok) throw new Error("expected a grant");
    expect(store.read(WORKTREE)?.expiresAt).toBe("2026-09-04T05:00:01.000Z");
    // And the sweep at the boundary actually clears it.
    expect(store.sweep(canonicalInstant("2026-09-04T05:00:02Z", "now"))).toHaveLength(1);
    expect(store.read(WORKTREE)?.leaseId).toBeNull();
  });

  it("refuses a value that is not an instant, by field name, before the store sees it", async () => {
    for (const bad of ["soon", "", "2026-13-45T99:99:99Z"]) {
      expect(() => canonicalInstant(bad, "expiresAt")).toThrow("expiresAt");
      const store = temporaryStore();
      // `requireText` would have accepted the first two: it guards emptiness,
      // not meaning. The refusal belongs to the producer that owns the
      // semantics, and it happens before any row is written.
      await expect(arbiterOn(store, { now: () => bad }).acquire()).rejects.toThrow("now");
      expect(store.list()).toEqual([]);
    }
  });

  it("agrees with instant ordering on every row of a boundary table", () => {
    // The carry-in's requirement, stated as a measurement: for instants around
    // an expiry boundary, the store's lexical `expires_at <= now` verdict and
    // the runtime's parsed-instant verdict must agree on every row.
    const boundary = "2026-09-04T05:00:00.000Z";
    const table = [
      "2026-09-04T04:59:59.999Z",
      "2026-09-04T05:00:00.000Z",
      "2026-09-04T05:00:00.001Z",
      "2026-09-03T23:59:59.999Z",
      "2026-09-04T23:59:59.999Z",
      "2026-12-31T23:59:59.999Z",
      "2027-01-01T00:00:00.000Z",
    ];

    const disagreements: string[] = [];
    for (const expiresAt of table) {
      const store = temporaryStore();
      const canonical = canonicalInstant(expiresAt, "expiresAt");
      store.transact(WORKTREE, () => ({
        verb: "GRANT",
        row: {
          leaseId: deterministicUuid("lease/" + WORKTREE + "/1"),
          holder: HOLDER,
          acquiredAt: "2026-09-01T00:00:00.000Z",
          expiresAt: canonical,
          holderPid: 4242,
          holderToken: "token-1",
        },
      }));
      const lexical = store.sweep(boundary).length === 1;
      const byInstant = Date.parse(canonical) <= Date.parse(boundary);
      if (lexical !== byInstant) disagreements.push(expiresAt);
    }
    expect(disagreements).toEqual([]);
  });
});
