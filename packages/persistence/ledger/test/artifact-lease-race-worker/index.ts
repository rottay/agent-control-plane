/**
 * Child process entry point for the cross-process blob lease tests.
 *
 * Two handles inside one event loop would not prove what escalón B claims.
 * `better-sqlite3` is synchronous, so two in-process calls run one after the
 * other and the second simply sees the first one's committed row — which
 * exercises the comparison but never the lock. The property the publisher and
 * the reconciler depend on is that two operating system processes, released at
 * the same instant, cannot both hold one blob; and that two reconcilers which
 * observed **the same** `(incarnation, generation)` cannot both take it. The only
 * way to arrange either is to prepare in two processes before either writes.
 *
 * So this worker opens the store, reads whatever token its mode needs, announces
 * `READY` on stderr, blocks until the parent writes a byte on stdin, and only
 * then runs its one verb — a marker rather than a timer, because a drill that
 * sleeps passes on a slow machine for the wrong reason.
 *
 * It is not part of the public API and is not exported from index.ts.
 *
 * Usage: node index.js <storePath> <incarnationId> <mode> <contentSha256> <holder> <operationId> <operation>
 *
 *   mode `acquire`  — take the free blob under the grant named by the arguments;
 *   mode `takeover` — read the standing token and its holder's pid before READY,
 *                     then take the blob over under the grant named by the
 *                     arguments, attesting quiescence of that pid;
 *   mode `release`  — read the standing token before READY, then release it.
 *
 * It prints exactly one JSON line to stdout describing the outcome.
 */

import { readSync, writeSync } from "node:fs";

import type {
  ArtifactBlobLeaseOperation,
  ArtifactBlobLeaseOutcome,
  ArtifactBlobLeaseToken,
} from "../../src/artifact-lease-store/index.js";
import { openArtifactBlobLeaseStore } from "../../src/artifact-lease-store/index.js";

interface WorkerOutcome {
  readonly ok: boolean;
  readonly verb: string | null;
  readonly refusal: string | null;
  readonly generation: number | null;
  readonly holder: string | null;
  readonly errorName: string | null;
}

function emit(outcome: WorkerOutcome): void {
  process.stdout.write(JSON.stringify(outcome) + "\n");
}

function failed(errorName: string): WorkerOutcome {
  return { ok: false, verb: null, refusal: null, generation: null, holder: null, errorName };
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
  const [storePath, incarnationId, mode, contentSha256, holder, operationId, operation] = process.argv.slice(2);
  if (
    storePath === undefined ||
    incarnationId === undefined ||
    mode === undefined ||
    contentSha256 === undefined ||
    holder === undefined ||
    operationId === undefined ||
    operation === undefined
  ) {
    emit(failed("UsageError"));
    return 2;
  }

  // A generous busy timeout: the drill proves the writers serialize, not how
  // quickly one of them gives up.
  const store = openArtifactBlobLeaseStore(storePath, {
    incarnationId,
    createdAt: "2026-01-01T00:00:00.000Z",
    busyTimeoutMs: 30_000,
  });
  try {
    const grant = {
      contentSha256,
      operation: operation as ArtifactBlobLeaseOperation,
      operationId,
      holder,
      holderPid: process.pid,
      acquiredAt: "2026-01-01T00:10:00.000Z",
      expiresAt: "2026-01-01T00:20:00.000Z",
    };

    let observed: ArtifactBlobLeaseToken | null = null;
    let observedPid: number | null = null;
    if (mode === "takeover" || mode === "release") {
      observed = store.readToken(contentSha256);
      observedPid = store.read(contentSha256)?.holderPid ?? null;
      if (observed === null || observedPid === null) {
        emit(failed("NoHolding"));
        return 1;
      }
    } else if (mode !== "acquire") {
      emit(failed("UsageError"));
      return 2;
    }

    writeSync(2, "READY\n");
    awaitStart();

    let outcome: ArtifactBlobLeaseOutcome;
    if (observed !== null && observedPid !== null && mode === "takeover") {
      outcome = store.takeOver(observed, { basis: "DEATH_AND_REAP_PROVEN", holderPid: observedPid }, grant);
    } else if (observed !== null && mode === "release") {
      outcome = store.release(observed);
    } else {
      outcome = store.acquire(grant);
    }
    emit({
      ok: true,
      verb: outcome.verb,
      refusal: outcome.verb === "REFUSE" ? outcome.refusal : null,
      generation: outcome.row?.generation ?? null,
      holder: outcome.row?.holder ?? null,
      errorName: null,
    });
    return 0;
  } catch (error: unknown) {
    emit(failed(error instanceof Error ? error.name : "UnknownError"));
    return 1;
  } finally {
    store.close();
  }
}

process.exitCode = main();
