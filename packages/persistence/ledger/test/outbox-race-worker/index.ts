/**
 * Child process entry point for the cross-process compare-and-set test.
 *
 * Two handles inside one event loop would not prove what this escalón claims.
 * `better-sqlite3` is synchronous, so two in-process calls simply run one after
 * the other: the second one's `cas` sees the first one's committed row, takes
 * the version mismatch and reports `CONFLICT` — which exercises the predicate
 * but never the lock. The property the outbox actually depends on is that two
 * operating system processes which have both read **the same version** cannot
 * both apply, and the only way to arrange that is to read in two processes
 * before either writes.
 *
 * So this worker reads its token, announces that it holds it, waits for the
 * parent to say go, and only then runs the compare-and-set. Every racer is
 * therefore holding a token for the same version at the moment the race starts,
 * which is the situation a dispatcher is in after it has read a row and before
 * it has finished talking to a destination.
 *
 * It is not part of the public API and is not exported from index.ts.
 *
 * Usage: node index.js <storePath> <incarnationId> <commandId> <targetState> [tokenVersion]
 *
 * With `tokenVersion` supplied the worker uses that version instead of the one
 * it read, which is how the parent drills a token that was already stale before
 * the race began.
 *
 * It prints exactly one JSON line to stdout describing the outcome, so the
 * parent can assert on it without parsing prose, and one `READY` line to stderr
 * before it blocks — a marker rather than a timer, because a drill that sleeps
 * is a drill that passes on a slow machine for the wrong reason.
 */

import { readSync, writeSync } from "node:fs";

import type { OutboxState } from "../../src/outbox-store/index.js";
import { openOutboxStore } from "../../src/outbox-store/index.js";

interface WorkerOutcome {
  readonly ok: boolean;
  readonly verb: string | null;
  readonly rowVersion: number | null;
  readonly state: string | null;
  readonly ownerProcessId: number | null;
  readonly errorName: string | null;
}

function emit(outcome: WorkerOutcome): void {
  process.stdout.write(JSON.stringify(outcome) + "\n");
}

/**
 * Block until the parent writes a byte on stdin.
 *
 * `readSync` on the descriptor rather than a stream listener: the racers must
 * all be released at one instant, and an event-loop callback would hand the
 * first process a head start measured in scheduler ticks.
 */
function awaitStart(): void {
  const buffer = Buffer.alloc(1);
  try {
    readSync(0, buffer, 0, 1, null);
  } catch {
    /* the parent closed the pipe; race anyway */
  }
}

function main(): number {
  const storePath = process.argv[2];
  const incarnationId = process.argv[3];
  const commandId = process.argv[4];
  const targetState = process.argv[5];
  const tokenVersion = process.argv[6];

  if (
    storePath === undefined ||
    incarnationId === undefined ||
    commandId === undefined ||
    targetState === undefined
  ) {
    emit({ ok: false, verb: null, rowVersion: null, state: null, ownerProcessId: null, errorName: "UsageError" });
    return 2;
  }

  // A generous busy timeout: the point of the drill is to prove the writers
  // serialize, not to measure how quickly one of them gives up.
  const store = openOutboxStore(storePath, {
    incarnationId,
    createdAt: "2026-01-01T00:00:00.000Z",
    busyTimeoutMs: 30_000,
  });
  try {
    const token = store.readToken(commandId);
    if (token === null) {
      emit({ ok: false, verb: null, rowVersion: null, state: null, ownerProcessId: null, errorName: "NoSuchRow" });
      return 1;
    }
    const row = store.read(commandId);

    writeSync(2, "READY\n");
    awaitStart();

    const outcome = store.cas(
      tokenVersion === undefined ? token : { ...token, expectedVersion: Number(tokenVersion) },
      {
        state: targetState as OutboxState,
        attemptCount: row?.attemptCount ?? 0,
        nextEligibleAt: null,
        deadlineAt: row?.deadlineAt ?? "2026-01-01T01:00:00.000Z",
        responseHandle: null,
        lastFailureCode: null,
        lastAttempt: row?.lastAttempt ?? null,
        ownerProcessId: targetState === "INFLIGHT" ? process.pid : null,
        updatedAt: "2026-01-01T00:10:00.000Z",
      },
    );
    emit({
      ok: true,
      verb: outcome.verb,
      rowVersion: outcome.row?.rowVersion ?? null,
      state: outcome.row?.state ?? null,
      ownerProcessId: outcome.row?.ownerProcessId ?? null,
      errorName: null,
    });
    return 0;
  } catch (error: unknown) {
    emit({
      ok: false,
      verb: null,
      rowVersion: null,
      state: null,
      ownerProcessId: null,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return 1;
  } finally {
    store.close();
  }
}

process.exitCode = main();
