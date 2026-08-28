import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";

import { FILE_MODE } from "../constants/index.js";
import { IdentityProbeError, SingletonError, StaleLockError } from "../errors/index.js";
import type { IdentityVerdict, ProcessInspector, RecordedIdentity } from "../identity-probe/index.js";
import { probeIdentity } from "../identity-probe/index.js";
import type { DaemonRoot } from "../paths/index.js";
import { pidfilePath } from "../paths/index.js";

/**
 * One daemon per canonical checkout.
 *
 * The lock is an exclusively created file, so the operating system arbitrates
 * rather than a check-then-write in this process. Two daemons racing both call
 * `open` with `wx`; exactly one succeeds, and the loser never had a window in
 * which it believed it had won.
 *
 * The fixed loopback ports are the machine-wide backstop behind this: a second
 * checkout would pass its own lock and then fail to bind, before readiness and
 * without disturbing the first daemon.
 */

export interface LockRecord extends RecordedIdentity {
  readonly mode: string;
  readonly acquiredAt: string;
}

export interface LockHandle {
  readonly record: LockRecord;
}

/** Parse a lock file. A lock we cannot read is never a lock we may remove. */
export function parseLockRecord(raw: string): LockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  const pid = value["pid"];
  const startToken = value["startToken"];
  const digest = value["argvDigest"];
  const mode = value["mode"];
  const acquiredAt = value["acquiredAt"];
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof startToken !== "string" ||
    startToken === "" ||
    typeof digest !== "string" ||
    typeof mode !== "string" ||
    typeof acquiredAt !== "string"
  ) {
    return null;
  }
  return { pid, startToken, argvDigest: digest, mode, acquiredAt };
}

/**
 * Take the lock, or refuse with a classified reason.
 *
 * Every refusal leaves the existing file exactly as it was. Nothing here
 * removes anything: reclaiming is a separate, explicit operator action.
 */
export async function acquireSingleton(
  root: DaemonRoot,
  identity: RecordedIdentity,
  mode: string,
  acquiredAt: string,
  inspector: ProcessInspector,
): Promise<LockHandle> {
  const path = pidfilePath(root);
  const record: LockRecord = { ...identity, mode, acquiredAt };

  let handle: number;
  try {
    handle = openSync(path, "wx", FILE_MODE);
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    await refuseExistingLock(path, inspector);
    // refuseExistingLock always throws; this keeps the type checker honest.
    throw new SingletonError("the daemon lock is held");
  }

  try {
    writeSync(handle, JSON.stringify(record));
  } finally {
    closeSync(handle);
  }
  return { record };
}

/** Classify an existing lock and throw the matching refusal. */
async function refuseExistingLock(path: string, inspector: ProcessInspector): Promise<never> {
  const existing = parseLockRecord(readFileSync(path, "utf8"));
  if (existing === null) {
    throw new IdentityProbeError(
      "a lock file exists but cannot be parsed; it will not be removed automatically",
    );
  }
  const verdict = await probeIdentity(existing, inspector);
  throw refusalFor(verdict, existing);
}

function refusalFor(verdict: IdentityVerdict, existing: LockRecord): Error {
  switch (verdict) {
    case "SAME_LIVE_DAEMON":
      return new SingletonError(
        "a live daemon already holds the lock (pid " + String(existing.pid) + ")",
      );
    case "NOT_SAME":
      return new StaleLockError(
        "the lock records pid " +
          String(existing.pid) +
          ", which is not this daemon; explicit recovery is required",
      );
    case "UNSUPPORTED_PLATFORM":
      return new IdentityProbeError(
        "process identity cannot be established on this platform; refusing to touch the lock",
      );
    default:
      return new IdentityProbeError(
        "the identity of pid " + String(existing.pid) + " is indeterminate; refusing to touch the lock",
      );
  }
}

export interface RecoveryResult {
  readonly recovered: boolean;
  readonly verdict: IdentityVerdict | "ABSENT" | "UNREADABLE";
  readonly detail: string;
}

/**
 * Explicitly reclaim an abandoned lock.
 *
 * Only `NOT_SAME` permits removal, and only of the exact owned pidfile. Every
 * other verdict returns without touching the filesystem and without sending a
 * signal, because the ambiguous case is precisely the one where acting would
 * hit a process that is doing its job.
 */
export async function recoverStaleLock(
  root: DaemonRoot,
  inspector: ProcessInspector,
  options: { readonly adoptStale: boolean },
): Promise<RecoveryResult> {
  if (!options.adoptStale) {
    return {
      recovered: false,
      verdict: "INDETERMINATE",
      detail: "recovery requires an explicit decision",
    };
  }

  const path = pidfilePath(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { recovered: false, verdict: "ABSENT", detail: "there is no lock to recover" };
  }

  const existing = parseLockRecord(raw);
  if (existing === null) {
    return {
      recovered: false,
      verdict: "UNREADABLE",
      detail: "the lock cannot be parsed, so its owner cannot be established",
    };
  }

  const verdict = await probeIdentity(existing, inspector);
  if (verdict !== "NOT_SAME") {
    return { recovered: false, verdict, detail: "the recorded process may still be live" };
  }

  unlinkSync(path);
  return { recovered: true, verdict, detail: "removed the abandoned lock" };
}

/**
 * Release a lock this daemon owns.
 *
 * Re-reads and compares first: a lock that no longer records our identity
 * belongs to somebody else, and unlinking it would evict a live daemon.
 */
export function releaseSingleton(root: DaemonRoot, identity: RecordedIdentity): boolean {
  const path = pidfilePath(root);
  let existing: LockRecord | null;
  try {
    existing = parseLockRecord(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (existing === null) return false;
  if (existing.pid !== identity.pid || existing.startToken !== identity.startToken) return false;
  unlinkSync(path);
  return true;
}
