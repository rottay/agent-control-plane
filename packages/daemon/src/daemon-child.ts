import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ModeError } from "./errors.js";
import { isDaemonMode } from "./lifecycle.js";
import type { DaemonMode } from "./lifecycle.js";
import { installSignalHandlers } from "./signals.js";
import { startDaemon, stopDaemon, terminateDaemon } from "./index.js";

/**
 * The daemon, hosted in its own process so a drill can signal it for real.
 *
 * There is no package `bin` and there will not be one before P8. This entry
 * exists solely so the drills can send SIGTERM, SIGINT and SIGKILL to an actual
 * process: a shutdown proven by calling a function in-process proves nothing,
 * because the handles, the page cache and every object survive it, which is
 * exactly what losing a process does not do.
 *
 * Importing this module does nothing at all. It runs only when executed
 * directly, and it accepts a validated JSON argument rather than reading the
 * environment, so nothing about its behaviour depends on ambient state.
 */

const SHA256_HEX = new RegExp("^[0-9a-f]{64}$");

export interface DaemonChildConfig {
  readonly mode: DaemonMode;
  readonly scenarioId: string;
  readonly emittedBy: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly submittedAt: string;
  readonly submissionDigest: string;
  /** Stay alive after supervising, so a signal drill has something to signal. */
  readonly holdOpen: boolean;
  /** Skip the port precheck. Only for the SQLite drills, which bind nothing. */
  readonly checkPorts: boolean;
}

/** Validate the child's configuration. Nothing is read from the environment. */
export function parseDaemonChildConfig(raw: unknown): DaemonChildConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ModeError("child config must be an object");
  }
  const value = raw as Record<string, unknown>;
  const mode = value["mode"];
  const scenarioId = value["scenarioId"];
  const emittedBy = value["emittedBy"];
  const taskId = value["taskId"];
  const attempt = value["attempt"];
  const submittedAt = value["submittedAt"];
  const submissionDigest = value["submissionDigest"];
  const holdOpen = value["holdOpen"] ?? true;
  const checkPorts = value["checkPorts"] ?? true;

  if (!isDaemonMode(mode)) throw new ModeError("mode must be an explicit daemon mode");
  if (typeof scenarioId !== "string") throw new ModeError("scenarioId must be a string");
  if (typeof emittedBy !== "string") throw new ModeError("emittedBy must be a string");
  if (typeof taskId !== "string") throw new ModeError("taskId must be a string");
  if (typeof submittedAt !== "string") throw new ModeError("submittedAt must be a string");
  if (typeof submissionDigest !== "string" || !SHA256_HEX.test(submissionDigest)) {
    throw new ModeError("submissionDigest must be 64 lowercase hex characters");
  }
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    throw new ModeError("attempt must be a positive integer");
  }
  if (typeof holdOpen !== "boolean") throw new ModeError("holdOpen must be a boolean");
  if (typeof checkPorts !== "boolean") throw new ModeError("checkPorts must be a boolean");

  return {
    mode,
    scenarioId,
    emittedBy,
    taskId,
    attempt,
    submittedAt,
    submissionDigest,
    holdOpen,
    checkPorts,
  };
}

/** Run the daemon until a signal, or until the server dies under it. */
export async function runDaemonChild(config: DaemonChildConfig): Promise<number> {
  const run = await startDaemon({
    mode: config.mode,
    scenarioId: config.scenarioId,
    emittedBy: config.emittedBy,
    taskId: config.taskId,
    attempt: config.attempt,
    submittedAt: config.submittedAt,
    submissionDigest: config.submissionDigest,
    checkPorts: config.checkPorts,
  });

  const announce = (): void => {
    process.stdout.write(
      JSON.stringify({
        ready: true,
        pid: process.pid,
        serverPid: run.serverPid,
        phases: run.phases,
      }) + "\n",
    );
  };

  if (!config.holdOpen) {
    announce();
    await stopDaemon(run);
    return 0;
  }

  return await new Promise<number>((resolveExit) => {
    // An unresolved promise does NOT keep Node alive: promises are not handles,
    // and neither are signal listeners. Without a real handle the loop drains
    // the moment startup finishes and the process exits on its own, skipping
    // the drain path entirely and leaving the lock and status behind. A timer
    // is a handle, so this is what actually holds the daemon open.
    const keepAlive = setInterval(() => undefined, 60_000);

    const finish = (code: number, binding: { release(): void }): void => {
      clearInterval(keepAlive);
      binding.release();
      resolveExit(code);
    };

    const binding = installSignalHandlers((signal) => {
      void (async (): Promise<void> => {
        process.stdout.write(JSON.stringify({ draining: signal }) + "\n");
        // Through the bounded public operation, not straight to run.stop():
        // a declared aggregate bound the real entry point bypasses is not a
        // bound, it is a comment.
        const result = await stopDaemon(run);
        finish(result.stopped ? 0 : 1, binding);
      })();
    });

    // An unexpected server death after readiness is terminal. Nothing restarts
    // and nothing fails over: the classified status is published, the owned
    // resources unwind, and the process leaves with a nonzero code.
    if (run.terminal !== null) {
      void run.terminal.then((reason) => {
        if (reason !== "UNEXPECTED_EXIT") return;
        void (async (): Promise<void> => {
          // Publishes a classified TERMINAL status before unwinding, and
          // leaves that document behind: it is the only account of why this
          // process is gone.
          await terminateDaemon(run, "SUPERVISION", reason);
          process.stdout.write(JSON.stringify({ terminal: reason }) + "\n");
          finish(70, binding);
        })();
      });
    }

    // Announced last, deliberately. The drill signals the moment it sees this
    // line, so anything announced before the handlers exist is a race the test
    // would lose intermittently and blame on the daemon.
    announce();
  });
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url))
) {
  const raw = process.argv[2];
  if (raw === undefined) {
    process.stderr.write("acp-daemon-child: a JSON config argument is required\n");
    process.exitCode = 2;
  } else {
    void runDaemonChild(parseDaemonChildConfig(JSON.parse(raw))).then((code) => {
      process.exitCode = code;
    });
  }
}
