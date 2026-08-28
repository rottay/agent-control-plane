import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

import type { ControlPlaneEvent } from "@acp/contracts";
import { canonicalJsonStringify, openLedger, sha256Hex } from "@acp/ledger";

import { checkArtifactName, observationRootPath } from "./roots.js";
import type { Baseline } from "./baseline.js";
import { computeBaseline, serializeBaseline } from "./baseline.js";

/**
 * The disposable shadow ledger.
 *
 * This is the one module in the observation package that writes anything, and
 * the bounds on it are what make that acceptable. It is not a writer into any
 * product authority: it builds a throwaway `@acp/ledger` instance under the
 * ignored `.acp-local/shadow` root, feeds it synthetic lifecycle events that a
 * collector already validated, and reads back what it wrote. Nothing here
 * observes a live session, and nothing here can name a path a caller chose —
 * the location is derived internally from an admitted neutral name, exactly as
 * `roots.ts` derives every other observation location.
 *
 * Why a ledger at all, rather than a report file: the claim P3C makes is that
 * a measurement survives a rebuild. Proving that needs a chain that can
 * actually be rebuilt and an integrity check that can actually fail. A plain
 * report has neither, and would be a second fixture format to drift.
 *
 * The module writes only through `@acp/ledger`'s public API. It runs no SQL,
 * names no database driver, and creates and deletes nothing on the filesystem:
 * the root must already exist, and removing a drill's own root is the drill's
 * job, after its own realpath check.
 */

/** The subdirectory shadow ledgers live under, inside the shadow root. */
export const SHADOW_LEDGER_DIRECTORY = "ledgers";

export type ShadowRefusal =
  | "ROOT_ABSENT"
  | "BAD_SHADOW_NAME"
  | "PATH_NOT_CANONICAL"
  | "OUTSIDE_ALLOWLIST"
  | "ALREADY_EXISTS"
  | "APPEND_NOT_INSERTED"
  | "CHAIN_DISAGREES"
  | "INTEGRITY_FAILED"
  | "REBUILD_DIVERGED";

/**
 * The one error this module throws.
 *
 * Like `BaselineStopError`, it carries a closed reason and never a path, a
 * username or content. `redactObservationPath` exists for the same reason and
 * this module simply never has the chance to use it: no absolute path reaches
 * a message or a receipt.
 */
export class ShadowLedgerError extends Error {
  readonly reason: ShadowRefusal;

  constructor(reason: ShadowRefusal, detail: string) {
    super(reason + ": " + detail);
    this.reason = reason;
    this.name = "ShadowLedgerError";
  }
}

export interface ShadowSnapshot {
  readonly eventCount: number;
  readonly headSequence: number;
  readonly headEventSha256: string;
  /** Digest of the canonical event chain, in ledger order. */
  readonly chainSha256: string;
  /** Digest of the deterministic task and worker read models. */
  readonly readModelSha256: string;
}

export interface ShadowReceipt {
  readonly snapshot: ShadowSnapshot;
  readonly baseline: Baseline;
  readonly baselineSha256: string;
  readonly integrityOk: boolean;
  readonly checkedEvents: number;
  readonly replayedEvents: number;
  /** The whole point: the rebuilt read model and baseline are byte-identical. */
  readonly rebuildIdentical: boolean;
}

/**
 * Where one shadow ledger lives, derived rather than supplied.
 *
 * A caller passes a name, never a path — the same law `admitArtifact` enforces
 * for reads, applied to the one thing this package writes. The name is checked
 * by the existing `checkArtifactName`, so there is one opinion in the package
 * about what a safe name is rather than two that can disagree.
 */
export function shadowLedgerDirectory(): string {
  return join(observationRootPath("scenarios"), "..", SHADOW_LEDGER_DIRECTORY);
}

/**
 * Admit a shadow ledger location, derived from a name.
 *
 * The directory must already exist: this module creates nothing on the
 * filesystem, so a drill that wants a shadow ledger sets up and tears down its
 * own root. The file itself is created by `@acp/ledger`, which is the only
 * writer in the package.
 */
function admitShadowFile(name: string): string {
  const named = checkArtifactName(name);
  if (!named.ok) {
    throw new ShadowLedgerError("BAD_SHADOW_NAME", "the shadow name was refused: " + named.reason);
  }

  const directory = shadowLedgerDirectory();
  if (!existsSync(directory)) {
    throw new ShadowLedgerError("ROOT_ABSENT", "the shadow ledger directory does not exist");
  }
  const canonical = realpathSync(directory);
  if (canonical !== directory) {
    throw new ShadowLedgerError("PATH_NOT_CANONICAL", "the shadow directory traverses a symlink");
  }

  const file = join(canonical, name);
  if (!file.startsWith(canonical + sep)) {
    throw new ShadowLedgerError("OUTSIDE_ALLOWLIST", "the shadow name resolved outside its root");
  }
  if (existsSync(file)) {
    throw new ShadowLedgerError("ALREADY_EXISTS", "a shadow ledger of that name is already present");
  }
  return file;
}

/** Every event in the authoritative chain, paged in sequence order. */
function readChain(ledger: ReturnType<typeof openLedger>): readonly ControlPlaneEvent[] {
  const all: ControlPlaneEvent[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = ledger.listEvents({ afterSequence: cursor, limit: 100 });
    for (const record of page.events) all.push(record.event);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return all;
}

/** A deterministic digest of the read models the ledger projects. */
function readModelDigest(ledger: ReturnType<typeof openLedger>): string {
  const tasks = ledger.listTasks({ limit: 1000 }).tasks;
  const workers = ledger.listWorkers({ limit: 1000 }).workers;
  return sha256Hex(
    canonicalJsonStringify({
      // Projected facts only, and no timestamps: `createdAt`/`updatedAt` are
      // event-carried here, but keeping them out of the digest keeps this a
      // statement about the projection's shape rather than about the fixture's
      // clock values.
      tasks: tasks.map((task) => [
        task.taskId,
        task.currentState,
        task.latestAttempt,
        task.eventCount,
        task.isTerminal,
      ]),
      workers: workers.map((worker) => [
        worker.identity,
        worker.role,
        worker.eventCount,
        worker.taskCount,
      ]),
    }),
  );
}

/**
 * Build one disposable shadow ledger from already-typed synthetic events, and
 * prove the measurement survives a rebuild.
 *
 * The proof is the sequence, not any one step: append exactly what was given
 * and require every append to be genuinely inserted; read the chain back from
 * the ledger rather than from the input; verify integrity; measure; rebuild
 * the read model from the events; measure again; and compare digests. If the
 * rebuilt answer differed, the baseline would be a property of the run rather
 * than of the chain, which is the thing P3C exists to rule out.
 */
export function buildShadowLedger(
  name: string,
  events: readonly ControlPlaneEvent[],
): ShadowReceipt {
  const file = admitShadowFile(name);
  const ledger = openLedger(file);
  try {
    for (const event of events) {
      const result = ledger.append(event);
      if (!result.inserted) {
        throw new ShadowLedgerError(
          "APPEND_NOT_INSERTED",
          "an event was refused as a replay; a shadow chain is built once",
        );
      }
    }

    const chain = readChain(ledger);
    if (chain.length !== events.length) {
      throw new ShadowLedgerError(
        "CHAIN_DISAGREES",
        "the ledger returned a different number of events than were appended",
      );
    }

    const integrity = ledger.verifyIntegrity();
    if (!integrity.ok) {
      throw new ShadowLedgerError("INTEGRITY_FAILED", "the shadow chain failed its integrity check");
    }

    const status = ledger.status();
    const chainSha256 = sha256Hex(canonicalJsonStringify(chain));
    const beforeReadModel = readModelDigest(ledger);
    const baseline = computeBaseline(chain);
    const baselineSha256 = sha256Hex(serializeBaseline(baseline));

    // Rebuild from the events alone, then ask both questions again.
    const rebuild = ledger.rebuildReadModel();
    const afterReadModel = readModelDigest(ledger);
    const rebuiltChain = readChain(ledger);
    const rebuiltBaselineSha256 = sha256Hex(serializeBaseline(computeBaseline(rebuiltChain)));
    const rebuildIdentical =
      afterReadModel === beforeReadModel && rebuiltBaselineSha256 === baselineSha256;
    if (!rebuildIdentical) {
      throw new ShadowLedgerError(
        "REBUILD_DIVERGED",
        "the rebuilt read model or baseline did not match the original",
      );
    }

    return Object.freeze({
      snapshot: Object.freeze({
        eventCount: status.eventCount,
        headSequence: status.headSequence,
        headEventSha256: status.headEventSha256,
        chainSha256,
        readModelSha256: afterReadModel,
      }),
      baseline,
      baselineSha256,
      integrityOk: integrity.ok,
      checkedEvents: integrity.checkedEvents,
      replayedEvents: rebuild.replayedEvents,
      rebuildIdentical,
    });
  } finally {
    ledger.close();
  }
}
