import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";

import { FILE_MODE, SERVER_STOP_DEADLINE_MS } from "../constants/index.js";
import { IdentityProbeError, SingletonError, StaleLockError } from "../errors/index.js";
import type { IdentityVerdict, ProcessInspector, RecordedIdentity } from "../identity-probe/index.js";
import { probeIdentity } from "../identity-probe/index.js";
import { assertReservedPortsFree } from "../lifecycle/index.js";
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

/**
 * What the observation said about the server, carried in as a closed value.
 *
 * The status document is an observation, and a lifecycle decision may not read
 * one: the moment a decision reads it, it becomes a second authority that can
 * disagree with the ledger. That law is kept unweakened here. The document is
 * read where reading is already lawful — the top-level entry point — and what
 * crosses into this module is a struct that cannot be re-read, re-interpreted
 * or asked for more.
 *
 * So there is one reader of the pidfile (this module), one reader of the status
 * (the entry point), and one decider (this module), and the decider consumes a
 * value rather than consulting a source.
 */
export interface RecordedServer {
  /** `status.pid`: the daemon that wrote the observation, bound to the lock below. */
  readonly statusPid: number;
  /** The server's own triple. */
  readonly identity: RecordedIdentity;
}

export interface RecoveryResult {
  readonly recovered: boolean;
  readonly verdict: IdentityVerdict | "ABSENT" | "UNREADABLE" | "STATUS_NOT_OWNER";
  readonly detail: string;
  /**
   * What recovery did about the server the dead daemon spawned (V2-B2-6).
   *
   * Fields rather than a new exported name, deliberately: `RecoveryResult` is
   * already a pinned public export, and adding to its shape moves no pin while
   * a new type name would.
   *
   * `reaped` is true only when a signal was sent to a server whose identity was
   * proved twice — once before `SIGTERM` and again before any `SIGKILL`.
   */
  readonly reaped?: boolean;
  readonly serverExit?: ServerReapOutcome;
}

/**
 * How a reap ended. Closed, and every arm says what is now true of the machine.
 *
 * `NO_IDENTITY` and `STATUS_NOT_OWNER` are the two "we declined to look"
 * answers, and they are kept apart because they mean different things to an
 * operator: one is a document that never recorded a server, the other a
 * document left by a different run.
 */
export type ServerReapOutcome =
  | "NOT_ATTEMPTED"
  | "NO_IDENTITY"
  | "STATUS_NOT_OWNER"
  | "ABSENT"
  | "INDETERMINATE"
  | "STOPPED"
  | "PORTS_STILL_HELD";

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
  options: {
    readonly adoptStale: boolean;
    readonly server?: RecordedServer | null | undefined;
  },
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

  // The daemon is provably gone. Before the pidfile is removed, deal with the
  // server it spawned: undetached, in the daemon's own process group, and
  // therefore still holding the reserved ports if the daemon died without
  // running its unwind. Recovery has held the pid all along and declined to
  // look at it; V2-B2-6 is where it looks.
  const serverExit = await reapServer(options.server ?? null, existing, inspector);

  // An indeterminate server is the one case that reclaims nothing. The lock is
  // left exactly where it is, because removing it would invite the next daemon
  // to start against a machine that may still be holding the reserved ports by
  // a process nobody could identify -- and the port check would then refuse the
  // start anyway, with the lock gone and less evidence than before.
  if (serverExit === "INDETERMINATE") {
    return {
      recovered: false,
      verdict: "INDETERMINATE",
      detail: "the server this daemon spawned could not be identified; refusing to signal or reclaim",
      reaped: false,
      serverExit,
    };
  }

  unlinkSync(path);
  return {
    recovered: true,
    verdict: serverExit === "STATUS_NOT_OWNER" ? "STATUS_NOT_OWNER" : verdict,
    detail: "removed the abandoned lock",
    reaped: serverExit === "STOPPED",
    serverExit,
  };
}

/**
 * Stop the server the dead daemon spawned, if and only if it can be proved.
 *
 * **No identity, no signal.** The asymmetry `probeIdentity` already keeps — it
 * says `NOT_SAME` only when it can prove it — is the posture here too: every
 * path that cannot establish what a pid is now running returns without sending
 * anything. A recovery that guessed would be a recovery that killed a process
 * doing its job, on a machine an operator had not adjudicated.
 *
 * `ServerHandle.stop()` could not be reused: it closes over a live
 * `ChildProcess` and recovery holds only a pid. Its discipline is reproduced —
 * `SIGTERM`, a bounded deadline, then `SIGKILL` — with one addition it does not
 * need and this does: the identity is **re-probed at the deadline**, because a
 * pid freed by a graceful exit can be recycled inside the window, and an
 * unguarded escalation would then kill a stranger.
 */
async function reapServer(
  server: RecordedServer | null,
  lockRecord: RecordedIdentity,
  inspector: ProcessInspector,
): Promise<ServerReapOutcome> {
  // Absent is the migration row and the no-identity row at once, and neither
  // needs a second validator here: a document written before the identity
  // fields existed fails the key-set check, and a half-identity fails the
  // atomicity check, so both reach this module as `null`.
  //
  // SQLITE_SUPERVISOR spawns no server, and a RESTATE daemon killed before its
  // server came up never learned a pid; both are `null` too.
  if (server === null) return "NO_IDENTITY";
  // B3. A status document left by a DIFFERENT run is a stale witness. The lock
  // record is the thing recovery has proved dead, and it is parsed HERE, so the
  // binding is made against a value this module read rather than one it was
  // told. If the observation does not belong to that same process, nothing in
  // it may be trusted about a server.
  if (server.statusPid !== lockRecord.pid) return "STATUS_NOT_OWNER";

  const recorded: RecordedIdentity = server.identity;
  // Never this process, and never the pid the lock names: those are the two
  // pids recovery must not signal under any verdict.
  if (recorded.pid === process.pid || recorded.pid === lockRecord.pid) return "NO_IDENTITY";

  // `SAME_LIVE_DAEMON` reads oddly against a server pid. It is reused unchanged
  // and on purpose: the function compares a recorded triple against live `ps`
  // facts and knows nothing about roles, so the verdict is correct and only the
  // name is role-flavoured. Renaming it would touch the lock path and the
  // arbiter, which is a different packet.
  const before = await probeIdentity(recorded, inspector);
  if (before === "NOT_SAME") return "ABSENT";
  if (before !== "SAME_LIVE_DAEMON") return "INDETERMINATE";

  // Immediately, with no intervening await: anything between the proof and the
  // signal is a window in which the pid could be freed and recycled.
  try {
    process.kill(recorded.pid, "SIGTERM");
  } catch {
    return "ABSENT";
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, SERVER_STOP_DEADLINE_MS);
  });

  // The re-probe. A pid that is gone, or that is now a different process, ends
  // the reap here rather than escalating into a stranger.
  const after = await probeIdentity(recorded, inspector);
  if (after === "NOT_SAME") return await confirmPorts();
  if (after !== "SAME_LIVE_DAEMON") return "INDETERMINATE";

  try {
    process.kill(recorded.pid, "SIGKILL");
  } catch {
    return await confirmPorts();
  }
  return await confirmPorts();
}

/**
 * A reap that could not free the ports is reported, never returned as success.
 *
 * `assertReservedPortsFree` throws a `StartupError`; inside recovery the throw
 * is the report, so it is caught and carried in the result rather than escaping
 * as a startup error from a recovery call.
 */
async function confirmPorts(): Promise<ServerReapOutcome> {
  try {
    await assertReservedPortsFree();
    return "STOPPED";
  } catch {
    return "PORTS_STILL_HELD";
  }
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
