/**
 * Child process entry point for the cross-process arbitration test.
 *
 * Two handles inside one event loop would not prove anything about
 * concurrency: better-sqlite3 is synchronous, so the two calls would simply
 * run one after the other and the file lock would never actually be contended.
 * The only way to exercise BEGIN IMMEDIATE, the busy timeout and the unique
 * constraint under real contention is to have separate operating system
 * processes race for the write lock, which is what this file exists for.
 *
 * It is not part of the public API and is not exported from index.ts.
 *
 * Usage: node index.js <storePath> <worktreePath> <holder> <leaseId> <expiresAt> [pauseMs]
 *
 * The decision it carries is the simplest honest one: grant if the record is
 * free, refuse if somebody holds it. The policy vocabulary belongs to the
 * caller, so the reason is a plain word this worker owns rather than one the
 * store defines.
 *
 * `pauseMs` is the crash hook. When set, the worker busy-waits *inside* the
 * decision — that is, between BEGIN and COMMIT, with the write lock held — so
 * the parent can SIGKILL it mid-transaction and assert the store is intact. It
 * is a spin rather than a sleep because the decision callback is synchronous
 * by contract; nothing here can await.
 *
 * It prints exactly one JSON line to stdout describing the outcome, so the
 * parent can assert on it without parsing prose.
 */

import { writeSync } from "node:fs";

import { openLeaseStore } from "../../src/lease-store/index.js";

interface WorkerOutcome {
  readonly ok: boolean;
  readonly verb: string | null;
  readonly fence: number | null;
  readonly leaseId: string | null;
  readonly errorName: string | null;
}

function emit(outcome: WorkerOutcome): void {
  process.stdout.write(JSON.stringify(outcome) + "\n");
}

function main(): number {
  const storePath = process.argv[2];
  const worktreePath = process.argv[3];
  const holder = process.argv[4];
  const leaseId = process.argv[5];
  const expiresAt = process.argv[6];
  const pauseMs = Number(process.argv[7] ?? "0");

  if (
    storePath === undefined ||
    worktreePath === undefined ||
    holder === undefined ||
    leaseId === undefined ||
    expiresAt === undefined
  ) {
    emit({ ok: false, verb: null, fence: null, leaseId: null, errorName: "UsageError" });
    return 2;
  }

  // A generous busy timeout: the point of the drill is to prove the writers
  // serialize, not to measure how quickly one of them gives up.
  const store = openLeaseStore(storePath, { busyTimeoutMs: 30_000 });
  try {
    const outcome = store.transact(worktreePath, (current) => {
      if (pauseMs > 0) {
        // Announce that the write lock is held, then hold it. The parent kills
        // this process on the marker rather than after a timer: a drill that
        // sleeps is a drill that passes on a slow machine for the wrong reason.
        // `writeSync` because stderr to a pipe is asynchronous in Node and the
        // spin below never yields the event loop.
        writeSync(2, "HOLDING\n");
        const until = performance.now() + pauseMs;
        while (performance.now() < until) {
          /* hold the lock between BEGIN and COMMIT */
        }
      }
      if (current !== null && current.leaseId !== null) {
        return { verb: "REFUSE", reason: "held" };
      }
      return {
        verb: "GRANT",
        row: {
          leaseId,
          holder,
          acquiredAt: "2026-01-01T00:00:00.000Z",
          expiresAt,
          holderPid: process.pid,
          holderToken: null,
        },
      };
    });
    emit({
      ok: true,
      verb: outcome.verb,
      fence: outcome.verb === "REFUSE" ? (outcome.row?.fence ?? null) : outcome.row.fence,
      leaseId: outcome.verb === "GRANT" ? outcome.row.leaseId : null,
      errorName: null,
    });
    return 0;
  } catch (error: unknown) {
    emit({
      ok: false,
      verb: null,
      fence: null,
      leaseId: null,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return 1;
  } finally {
    store.close();
  }
}

process.exitCode = main();
