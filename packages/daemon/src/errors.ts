/**
 * Classified daemon failures.
 *
 * Every refusal in this package carries a code, because a daemon that fails
 * with free text gives an operator nothing to branch on and gives a test
 * nothing to assert. The codes are the contract; the messages are for humans.
 */

export type DaemonErrorCode =
  | "DAEMON_ROOT"
  | "SINGLETON"
  | "STALE_LOCK"
  | "IDENTITY_PROBE"
  | "MODE"
  | "STARTUP"
  | "SUPERVISION"
  | "SHUTDOWN"
  | "STATUS"
  | "LOG";

export class DaemonError extends Error {
  readonly code: DaemonErrorCode;

  constructor(code: DaemonErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DaemonError";
  }
}

/** The owned root is missing, unsafe, or not owner-only. */
export class DaemonRootError extends DaemonError {
  constructor(message: string) {
    super("DAEMON_ROOT", message);
    this.name = "DaemonRootError";
  }
}

/** Another daemon holds the lock, and this one will not disturb it. */
export class SingletonError extends DaemonError {
  constructor(message: string) {
    super("SINGLETON", message);
    this.name = "SingletonError";
  }
}

/**
 * A lock file exists whose owner is not this daemon.
 *
 * Separate from `SingletonError` on purpose: a live duplicate and an abandoned
 * file need different operator responses, and collapsing them would invite
 * reclaiming a lock that is still in use.
 */
export class StaleLockError extends DaemonError {
  constructor(message: string) {
    super("STALE_LOCK", message);
    this.name = "StaleLockError";
  }
}

/**
 * The identity of a recorded process could not be established.
 *
 * This is the fail-closed case. Nothing is signalled and nothing is removed
 * when this is thrown, because the ambiguous case is exactly the one where a
 * signal would land on an innocent process.
 */
export class IdentityProbeError extends DaemonError {
  constructor(message: string) {
    super("IDENTITY_PROBE", message);
    this.name = "IdentityProbeError";
  }
}

/** A mode was requested that cannot be served, or was not requested at all. */
export class ModeError extends DaemonError {
  constructor(message: string) {
    super("MODE", message);
    this.name = "ModeError";
  }
}

/** Startup failed at a named state; the unwind result is reported separately. */
export class StartupError extends DaemonError {
  constructor(message: string) {
    super("STARTUP", message);
    this.name = "StartupError";
  }
}

/** Shutdown exceeded its bound, or could not release an owned resource. */
export class ShutdownError extends DaemonError {
  constructor(message: string) {
    super("SHUTDOWN", message);
    this.name = "ShutdownError";
  }
}

/**
 * Something the daemon was supervising ended without being asked to.
 *
 * Distinct from `STARTUP`: startup failures happen before readiness and unwind
 * a partially built daemon, while this happens to a daemon that was working.
 * Collapsing the two would lose exactly the distinction an operator needs.
 */
export class SupervisionError extends DaemonError {
  constructor(message: string) {
    super("SUPERVISION", message);
    this.name = "SupervisionError";
  }
}
