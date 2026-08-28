/**
 * Public surface of the Agent Control Plane daemon package.
 *
 * This is P2D: the supervised process lifecycle around the runtime durability
 * plane. The launchd template, the observation route and any product adoption
 * are not here.
 *
 * Importing this module has no side effects. It parses no argv, creates no
 * directory, opens no database, binds no socket, spawns no child, installs no
 * signal handler and writes no file. Effects begin only inside `startDaemon` or
 * the internal child entry, and a fresh-process drill proves it rather than a
 * comment claiming it.
 *
 * The daemon adds no authority. The ledger remains the only one: the status
 * document and the lock file are observations, and no daemon authority exists
 * that could disagree with the ledger.
 *
 * P2D is not P2 completion, and it is no product adoption.
 */

import type { Ledger } from "@acp/ledger";
import { openLedger } from "@acp/ledger";
import type { DurableInvocation, ScenarioRoot } from "@acp/runtime";
import { deriveInvocation, resolveScenarioRoot, scenarioLedgerPath } from "@acp/runtime";

import { DRAIN_DEADLINE_MS } from "./constants.js";
import type { DaemonErrorCode } from "./errors.js";
import { ModeError, StartupError } from "./errors.js";
import type { ProcessInspector, RecordedIdentity } from "./identity-probe.js";
import { createPsInspector, ownIdentity } from "./identity-probe.js";
import type { DaemonMode, Resource, UnwindOutcome } from "./lifecycle.js";
import { UnwindStack, assertReservedPortsFree, classify, isDaemonMode } from "./lifecycle.js";
import { createLogger } from "./log.js";
import type { DaemonRoot } from "./paths.js";
import { existingDaemonRoot, resolveDaemonRoot } from "./paths.js";
import { runSqliteMode } from "./mode-sqlite.js";
import { startRestateMode, superviseRestate } from "./mode-restate.js";
import { acquireSingleton, recoverStaleLock, releaseSingleton } from "./singleton.js";
import type { DaemonPhase, DaemonStatusDocument } from "./status.js";
import { clearStatus, readStatusFrom, writeStatus } from "./status.js";

/**
 * The closed public surface: start, stop, terminate, observe, recover.
 *
 * Everything else is an implementation detail and stays behind the package
 * boundary. The first version of this file re-exported the root brand and its
 * resolver, the logger, signal installation, the identity inspector, the unwind
 * stack, the lock primitives and every constant — a second wide surface around
 * precisely the boundaries this package exists to draw. A consumer given
 * `resolveDaemonRoot` and `installSignalHandlers` can assemble its own daemon
 * beside this one, and then the singleton means nothing.
 *
 * Tests import the relative modules directly. That is deliberate: they are
 * inside the boundary, and narrowing the public surface is not meant to make
 * the package harder to prove.
 */
export type { DaemonMode } from "./lifecycle.js";
export type { DaemonErrorCode } from "./errors.js";
export {
  DaemonError,
  DaemonRootError,
  IdentityProbeError,
  ModeError,
  ShutdownError,
  SingletonError,
  StaleLockError,
  StartupError,
  SupervisionError,
} from "./errors.js";
export type { IdentityVerdict } from "./identity-probe.js";
export type { RecoveryResult } from "./singleton.js";
export type { DaemonPhase, DaemonStatusDocument } from "./status.js";

export interface DaemonOptions {
  /** Explicit. There is no auto-detection and no failover. */
  readonly mode: DaemonMode;
  /** A scenario identifier, never a path: a caller cannot name a directory. */
  readonly scenarioId: string;
  readonly emittedBy: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly submittedAt: string;
  readonly submissionDigest: string;
  /** Injectable so the identity verdicts are testable without a real process. */
  readonly inspector?: ProcessInspector | undefined;
  readonly clock?: (() => string) | undefined;
  /** Off only for unit tests that never bind anything. */
  readonly checkPorts?: boolean | undefined;
}

export interface StopResult {
  readonly stopped: boolean;
  readonly outcome: UnwindOutcome;
}

/**
 * A running daemon, as much of one as a caller may hold.
 *
 * Deliberately does not carry the raw `Ledger`, the absolute daemon root or the
 * recorded process identity. Handing out the ledger would give a consumer a
 * second way to write to the authority behind the driver's back; handing out
 * the root or the identity would let it rewrite the lock this run depends on.
 */
export interface DaemonRun {
  readonly mode: DaemonMode;
  readonly phases: readonly DaemonPhase[];
  readonly serverPid: number | null;
  /** Resolves if the external server dies while the daemon is supervising. */
  readonly terminal: Promise<string> | null;
  stop(): Promise<StopResult>;
  /**
   * Shut down because something failed, not because we were asked.
   *
   * Publishes a classified `TERMINAL` status **before** unwinding, and
   * deliberately leaves that document in place afterwards. A clean shutdown
   * removes its status because nothing remains to explain; a terminal one is
   * the only record of why the daemon is gone, and clearing it would destroy
   * the evidence at exactly the moment somebody needs it.
   */
  terminate(errorCode: DaemonErrorCode, detail: string): Promise<StopResult>;
}

/**
 * Read this daemon's own status. Resolves the owned root itself.
 *
 * Creates nothing. Reading the status of a daemon that has never run returns
 * `null` and leaves the checkout untouched — an observation that had to create
 * a directory before it could report "there is nothing here" would be making
 * the thing it claims to observe.
 */
export function readOwnStatus(): DaemonStatusDocument | null {
  const root = existingDaemonRoot();
  return root === null ? null : readStatusFrom(root);
}

/** Explicitly reclaim an abandoned lock. Never removes a live daemon's lock. */
export function recoverOwnStaleLock(options: {
  readonly adoptStale: boolean;
  readonly inspector?: ProcessInspector | undefined;
}): ReturnType<typeof recoverStaleLock> {
  const root = existingDaemonRoot();
  if (root === null) {
    return Promise.resolve({
      recovered: false,
      verdict: "ABSENT" as const,
      detail: "there is no daemon root, so there is no lock to recover",
    });
  }
  return recoverStaleLock(root, options.inspector ?? createPsInspector(), {
    adoptStale: options.adoptStale,
  });
}

/**
 * Start the daemon, in order, and stop at the first thing that fails.
 *
 * Every acquisition is pushed before the next is attempted, so the unwind
 * releases exactly what was taken. Nothing is retried and nothing falls back:
 * a requested mode that cannot be served is a refusal.
 */
export async function startDaemon(options: DaemonOptions): Promise<DaemonRun> {
  if (!isDaemonMode(options.mode)) {
    throw new ModeError("a daemon mode must be requested explicitly");
  }
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const inspector = options.inspector ?? createPsInspector();
  const startedAt = clock();
  const phases: DaemonPhase[] = [];
  const stack = new UnwindStack();

  // S1.
  const root = resolveDaemonRoot();
  phases.push("ROOTS_VALIDATED");
  const logger = createLogger(root, clock);

  let identity: RecordedIdentity;
  let ledger: Ledger | null = null;
  let serverPid: number | null = null;
  let terminal: Promise<string> | null = null;

  const publish = (phase: DaemonPhase, errorCode: DaemonStatusDocument["errorCode"]): void => {
    phases.push(phase);
    // The last phases are published *after* the unwind, and the unwind closes
    // the ledger. Reading it there is not an error condition, it is the normal
    // order of a shutdown, so an unavailable head is simply absent rather than
    // a second failure on top of whatever we were already doing.
    let head: { headSequence: number; headEventSha256: string } | null = null;
    try {
      head = ledger === null ? null : ledger.status();
    } catch {
      head = null;
    }
    // The status is an observation, so failing to publish one must never stop
    // the reverse unwind or the exact lock release. It is recorded and the
    // shutdown continues: losing the note about what happened is bad, and
    // stranding a lock and a running server because of it is worse.
    try {
      writeStatus(root, {
        phase,
        mode: options.mode,
        scenarioId: options.scenarioId,
        pid: process.pid,
        serverPid,
        ledgerHeadSequence: head?.headSequence ?? null,
        ledgerHeadSha256: head?.headEventSha256 ?? null,
        errorCode,
        startedAt,
        updatedAt: clock(),
      });
    } catch (error: unknown) {
      logger.log("warn", "status.unpublished", "STATUS", { phase, reason: classify(error) });
    }
  };

  try {
    // S2. The operating system arbitrates, not a check-then-write here.
    identity = await ownIdentity(inspector);
    await acquireSingleton(root, identity, options.mode, startedAt, inspector);
    stack.push(lockResource(root, identity));
    publish("SINGLETON_HELD", null);

    // The pinned addresses are part of the contract, so a collision is a loud
    // failure rather than a quiet move to another port.
    if (options.checkPorts !== false) await assertReservedPortsFree();

    // S3.
    const scenarioRoot: ScenarioRoot = resolveScenarioRoot(options.scenarioId);
    ledger = openLedger(scenarioLedgerPath(scenarioRoot));
    const openedLedger = ledger;
    stack.push({
      name: "ledger",
      release: (): Promise<string | null> => {
        try {
          openedLedger.close();
          return Promise.resolve(null);
        } catch (error: unknown) {
          return Promise.resolve(classify(error));
        }
      },
    });
    publish("LEDGER_OPEN", null);

    const invocation: DurableInvocation = deriveInvocation(
      options.taskId,
      options.attempt,
      options.submittedAt,
      options.submissionDigest,
    );

    if (options.mode === "SQLITE_SUPERVISOR") {
      // S8. No S4-S7: this mode binds nothing and spawns nothing.
      const result = await runSqliteMode({
        ledger: openedLedger,
        invocation,
        scenarioRoot,
        emittedBy: options.emittedBy,
      });
      publish("RECONCILED", null);
      publish("READY", null);
      logger.log("info", "ready", null, { mode: options.mode, verdict: result.verdict });
      publish("SUPERVISING", null);
      logger.log("info", "supervised", null, { finalState: result.finalState });
    } else {
      const handles = await startRestateMode({
        ledger: openedLedger,
        invocation,
        scenarioRoot,
        emittedBy: options.emittedBy,
        stack,
        onPhase: (phase, pid) => {
          // Published where it happens, in the order it happens. Deferring
          // SERVER_UP until this call returned made the recorded sequence
          // disagree with the actual one.
          if (pid !== undefined) serverPid = pid;
          publish(phase, null);
        },
      });
      serverPid = handles.server.pid;
      publish("READY", null);
      logger.log("info", "ready", null, { mode: options.mode, verdict: handles.verdict });

      // From here an unexpected death is terminal, never a restart.
      terminal = handles.server.exited.then((exit) =>
        exit.reason === "UNEXPECTED_EXIT" ? "UNEXPECTED_EXIT" : exit.reason,
      );

      await superviseRestate(handles.server, invocation);
      publish("SUPERVISING", null);
      logger.log("info", "supervised", null, { mode: options.mode });
    }
  } catch (error: unknown) {
    const code = classify(error);
    logger.log("error", "startup.failed", null, { at: phases[phases.length - 1] ?? "INIT", code });
    const outcome = await stack.unwindAll();
    logger.log("info", "unwound", null, {
      released: outcome.released.join(","),
      failures: outcome.failures.length,
    });
    clearStatus(root);
    throw error instanceof Error ? error : new StartupError("startup failed: " + code);
  }

  // One unwind, two endings. The stack is idempotent, so a signal arriving
  // during a terminal drain (or the reverse) cannot start a second one.
  const drain = async (
    kind: "SIGNAL" | "TERMINAL",
    errorCode: DaemonErrorCode | null,
  ): Promise<StopResult> => {
    if (kind === "TERMINAL") {
      publish("TERMINAL", errorCode);
      logger.log("error", "terminal", errorCode, { mode: options.mode });
    } else {
      publish("DRAINING", null);
      logger.log("info", "draining", null, {});
    }

    const outcome = await stack.unwindAll();

    if (kind === "TERMINAL") {
      // The TERMINAL document stays. It is the only account of why this
      // process is gone.
      logger.log("error", "terminated", errorCode, { failures: outcome.failures.length });
    } else {
      publish("STOPPED", null);
      logger.log("info", "stopped", null, { failures: outcome.failures.length });
      clearStatus(root);
    }
    return { stopped: outcome.failures.length === 0, outcome };
  };

  const run: DaemonRun = {
    mode: options.mode,
    phases,
    serverPid,
    terminal,
    stop: () => drain("SIGNAL", null),
    terminate: (errorCode: DaemonErrorCode, detail: string) => {
      logger.log("error", "terminal.cause", errorCode, { detail });
      return drain("TERMINAL", errorCode);
    },
  };
  return run;
}

/**
 * Stop a run within the aggregate drain bound.
 *
 * This is the bound the contract declares, and it only means anything if the
 * real entry point goes through it. Per-resource deadlines keep any single
 * release honest; this one keeps the whole shutdown honest, and both are
 * needed — a dozen releases each finishing just inside their own bound would
 * still add up to a hang.
 *
 * The deadline is a parameter so the timeout branch can be proven in
 * milliseconds rather than by a test that sits for half a minute.
 */
export function stopDaemon(run: DaemonRun, deadlineMs = DRAIN_DEADLINE_MS): Promise<StopResult> {
  return bounded(run.stop(), deadlineMs);
}

/** Terminate a run within the same aggregate bound. */
export function terminateDaemon(
  run: DaemonRun,
  errorCode: DaemonErrorCode,
  detail: string,
  deadlineMs = DRAIN_DEADLINE_MS,
): Promise<StopResult> {
  return bounded(run.terminate(errorCode, detail), deadlineMs);
}

async function bounded(work: Promise<StopResult>, deadlineMs: number): Promise<StopResult> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<StopResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ stopped: false, outcome: { released: [], failures: ["drain-deadline"] } });
    }, deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The lock is released last, because everything else was acquired under it. */
function lockResource(root: DaemonRoot, identity: RecordedIdentity): Resource {
  return {
    name: "singleton",
    release: (): Promise<string | null> => {
      try {
        releaseSingleton(root, identity);
        return Promise.resolve(null);
      } catch (error: unknown) {
        return Promise.resolve(classify(error));
      }
    },
  };
}
