import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { DAEMON_ROOT_SEGMENTS, DIR_MODE, LOG_DIR_NAME, LOG_FILE_NAME, PIDFILE_NAME, STATUS_NAME } from "./constants.js";
import { DaemonRootError } from "./errors.js";

/**
 * The daemon's owned filesystem, resolved by this package rather than named by
 * a caller.
 *
 * The same rule the toy boundary already enforces for scenarios: a caller that
 * can name a directory can name someone else's directory, so no public entry
 * point accepts a path. `DaemonRoot` is opaque and only `resolveDaemonRoot` can
 * produce one.
 */

declare const daemonRootBrand: unique symbol;
export type DaemonRoot = string & { readonly [daemonRootBrand]: true };

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..");

/** Where the daemon root must live, as an absolute path. */
export function daemonRootPath(): string {
  return join(REPO_ROOT, ...DAEMON_ROOT_SEGMENTS);
}

/**
 * Create the owned root and prove it is what it should be.
 *
 * The mode argument to `mkdirSync` is masked by the process umask, so a
 * directory requested as 0700 can arrive as 0755 and nothing complains. The
 * check is therefore a `stat`, not the constant: the request is an intention
 * and the stat is the evidence.
 */
export function resolveDaemonRoot(): DaemonRoot {
  const target = daemonRootPath();
  mkdirSync(target, { recursive: true, mode: DIR_MODE });

  // Containment is checked after realpath, because the string and the resolved
  // path diverge the moment a symlink is involved.
  const real = realpathSync(target);
  const expectedPrefix = realpathSync(REPO_ROOT) + sep;
  if (!real.startsWith(expectedPrefix)) {
    throw new DaemonRootError("the daemon root resolved outside the repository");
  }

  assertOwnerOnlyDirectory(real);
  const logs = join(real, LOG_DIR_NAME);
  mkdirSync(logs, { recursive: true, mode: DIR_MODE });
  assertOwnerOnlyDirectory(realpathSync(logs));

  return real as DaemonRoot;
}

/**
 * The owned root **if it already exists**, without creating it.
 *
 * An observation that mutates the checkout is not an observation. Reading the
 * status of a daemon that has never run must leave the filesystem exactly as it
 * found it, so this resolves and validates but never calls `mkdir`.
 */
export function existingDaemonRoot(): DaemonRoot | null {
  const target = daemonRootPath();
  if (!existsSync(target)) return null;

  const real = realpathSync(target);
  const expectedPrefix = realpathSync(REPO_ROOT) + sep;
  if (!real.startsWith(expectedPrefix)) {
    throw new DaemonRootError("the daemon root resolved outside the repository");
  }
  assertOwnerOnlyDirectory(real);
  return real as DaemonRoot;
}

/** A directory must be a directory, and owner-only. Verified, never assumed. */
export function assertOwnerOnlyDirectory(path: string): void {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    throw new DaemonRootError(path + " is not a directory");
  }
  const mode = stats.mode & 0o777;
  if (mode !== DIR_MODE) {
    throw new DaemonRootError(
      "the daemon directory is mode " + mode.toString(8) + ", not " + DIR_MODE.toString(8),
    );
  }
}

export function pidfilePath(root: DaemonRoot): string {
  return join(root, PIDFILE_NAME);
}

export function statusPath(root: DaemonRoot): string {
  return join(root, STATUS_NAME);
}

export function logDirPath(root: DaemonRoot): string {
  return join(root, LOG_DIR_NAME);
}

export function logFilePath(root: DaemonRoot): string {
  return join(logDirPath(root), LOG_FILE_NAME);
}

/**
 * Render a path for an observation.
 *
 * Absolute paths name a home directory, a user account and a machine layout, so
 * nothing that leaves this process in a status document or a log line may carry
 * one. Anything inside the repository becomes repository-relative; anything
 * else becomes a placeholder rather than a leak.
 */
export function redactPath(path: string): string {
  const root = realpathSync(REPO_ROOT);
  if (path === root) return ".";
  if (path.startsWith(root + sep)) return path.slice(root.length + 1);
  return "<outside-repository>";
}
