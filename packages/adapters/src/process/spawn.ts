import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { AdmittedBinary, SessionDescriptor, SessionLimits } from "../contract.js";
import { AdapterError } from "../errors.js";

/**
 * The process-spawn authority. One file, one import of `node:child_process`,
 * and exactly one caller (`../session.ts`).
 *
 * Duplicating a spawner is the thing being prevented. Two spawners drift, and
 * the drift is discovered only when they disagree about how to stop something
 * — which is the moment it matters most. Three providers share this one.
 *
 * Note what is NOT here: `maxBuffer`. It is an `exec`/`execFile` option that
 * `spawn` silently ignores, so mandating it would enforce a dead argument
 * while the real output bound went unimplemented. The bound is a manual byte
 * count in `session.ts`, taken on raw bytes before decoding.
 */

export interface SpawnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly startedAt: number;
}

/**
 * Admit a binary, and brand it.
 *
 * The admission lives with the authority that has to re-assert it, so there is
 * no window between "somebody checked this" and "we executed it" that belongs
 * to a different module.
 */
export function admitBinary(
  candidate: string,
  context: { readonly provider: string; readonly taskId: string },
): AdmittedBinary {
  if (!isAbsolute(candidate)) throw new AdapterError("BINARY_NOT_ADMITTED", context);
  if (!existsSync(candidate)) throw new AdapterError("BINARY_NOT_ADMITTED", context);
  if (realpathSync(candidate) !== candidate) {
    throw new AdapterError("BINARY_NOT_ADMITTED", context);
  }
  const stats = statSync(candidate);
  if (!stats.isFile()) throw new AdapterError("BINARY_NOT_ADMITTED", context);
  if (stats.uid !== process.getuid?.()) throw new AdapterError("BINARY_NOT_ADMITTED", context);
  // An executable others can rewrite is not the binary anyone reviewed. Same
  // rule the program-path admission uses elsewhere in this repository.
  if ((stats.mode & 0o022) !== 0) throw new AdapterError("BINARY_NOT_ADMITTED", context);
  return candidate as AdmittedBinary;
}

/**
 * Spawn one admitted binary. Shell-free, array argv, pinned environment.
 *
 * `stdio`, `timeout` and `killSignal` are passed explicitly on every call
 * rather than left to defaults, because a default is a decision nobody wrote
 * down.
 */
export function spawnAdmitted(
  binary: AdmittedBinary,
  descriptor: SessionDescriptor,
  limits: SessionLimits,
  context: { readonly provider: string; readonly taskId: string },
): SpawnedProcess {
  // Re-assert immediately before exec: the path was admitted at some earlier
  // moment, and a check that is only ever done early is a memory, not a check.
  admitBinary(binary, context);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(binary, [...descriptor.argv], {
      cwd: descriptor.cwd,
      env: { ...descriptor.env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: limits.timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch {
    throw new AdapterError("SPAWN_FAILED", context);
  }

  const pid = child.pid;
  if (typeof pid !== "number") {
    throw new AdapterError("SPAWN_FAILED", context);
  }
  return { child, pid, startedAt: 0 };
}
