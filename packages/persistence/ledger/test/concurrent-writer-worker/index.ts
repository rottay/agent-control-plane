/**
 * Child process entry point for the cross-process concurrency test.
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
 * Usage: node index.js <databasePath> <eventJson>
 *
 * It prints exactly one JSON line to stdout describing the outcome, so the
 * parent can assert on it without parsing prose.
 */

import { openLedger } from "../../src/ledger/index.js";

interface WorkerOutcome {
  readonly ok: boolean;
  readonly inserted: boolean | null;
  readonly sequence: number | null;
  readonly eventSha256: string | null;
  readonly errorName: string | null;
  readonly errorCode: string | null;
}

function emit(outcome: WorkerOutcome): void {
  process.stdout.write(JSON.stringify(outcome) + "\n");
}

function main(): number {
  const databasePath = process.argv[2];
  const eventJson = process.argv[3];

  if (databasePath === undefined || eventJson === undefined) {
    emit({
      ok: false,
      inserted: null,
      sequence: null,
      eventSha256: null,
      errorName: "UsageError",
      errorCode: null,
    });
    return 2;
  }

  // A generous busy timeout: the point of the test is to prove the writers
  // serialize, not to measure how quickly one of them gives up.
  const ledger = openLedger(databasePath, { busyTimeoutMs: 30_000 });
  try {
    const result = ledger.append(JSON.parse(eventJson));
    emit({
      ok: true,
      inserted: result.inserted,
      sequence: result.record.sequence,
      eventSha256: result.record.eventSha256,
      errorName: null,
      errorCode: null,
    });
    return 0;
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { readonly code: unknown }).code)
        : null;
    emit({
      ok: false,
      inserted: null,
      sequence: null,
      eventSha256: null,
      errorName: name,
      errorCode: code,
    });
    return 1;
  } finally {
    ledger.close();
  }
}

process.exitCode = main();
