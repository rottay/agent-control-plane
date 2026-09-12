/**
 * The bounded lifecycle use cases of the Agent Control Plane daemon (P-13,
 * escalón 2).
 *
 * `stopDaemon` and `terminateDaemon` are the aggregate-drain wrappers the
 * package barrel re-exports beside `startDaemon`: each runs the run's own
 * drain inside the contract's drain bound, so a shutdown that cannot finish
 * inside the bound reports `stopped: false` rather than hanging the caller.
 * `lockResource` is the unwind-stack entry that releases the daemon-root
 * singleton last, because everything else was acquired under it. All four
 * functions moved here verbatim from the composition root; nothing renamed,
 * nothing re-ordered.
 */

import type { RecordedIdentity } from "../../identity-probe/index.js";
import type { DaemonErrorCode } from "../../errors/index.js";
import type { Resource } from "../../lifecycle/index.js";
import { classify } from "../../lifecycle/index.js";
import type { DaemonRoot } from "../../paths/index.js";
import { releaseSingleton } from "../../singleton/index.js";

import { DRAIN_DEADLINE_MS } from "../../constants/index.js";

import type { DaemonRun, StopResult } from "../index.js";

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
export function lockResource(root: DaemonRoot, identity: RecordedIdentity): Resource {
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
