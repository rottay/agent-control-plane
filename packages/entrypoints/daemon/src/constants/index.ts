/**
 * Fixed values the daemon owns.
 *
 * Everything here is a constant rather than an option, because each one is
 * either a safety boundary or part of a contract another phase has to be able
 * to check. A configurable log cap is a log cap that is one deployment away
 * from being infinite.
 */

/** The daemon's own root, relative to the repository. Ignored, never tracked. */
export const DAEMON_ROOT_SEGMENTS: readonly string[] = Object.freeze([".acp-local", "daemon"]);

/** One daemon per canonical checkout: one pidfile, at a fixed name. */
export const PIDFILE_NAME = "daemon.pid";

/** The status observation. Never an input to a lifecycle decision. */
export const STATUS_NAME = "status.json";

/** Bounded log directory and its two independent caps. */
export const LOG_DIR_NAME = "logs";
export const LOG_FILE_NAME = "daemon.log";

/**
 * Both caps bind, and both are tested past their limit.
 *
 * Bytes alone lets an unbounded number of rotated files accumulate; files alone
 * lets each one grow without limit. Only the pair is a bound.
 */
export const LOG_MAX_BYTES = 256 * 1024;
export const LOG_MAX_FILES = 4;

/** A single line is capped too, so one enormous message cannot defeat the cap. */
export const LOG_MAX_LINE_BYTES = 4 * 1024;

/** Least privilege: owner-only directories, owner-only files. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * Identity probe.
 *
 * An absolute path, so `PATH` cannot decide which program answers the question
 * "is this process still mine". Fixed argv, no shell, and both a time and an
 * output bound.
 */
export const PS_BINARY = "/bin/ps";
export const PS_TIMEOUT_MS = 5_000;
export const PS_MAX_BUFFER_BYTES = 64 * 1024;

/** Bounded deadlines for each unwind step. A daemon that hangs is not stopped. */
export const SERVER_STOP_DEADLINE_MS = 15_000;
export const ENDPOINT_CLOSE_DEADLINE_MS = 10_000;
export const DRAIN_DEADLINE_MS = 30_000;

/** How long a port must be observed free before the daemon will claim it. */
export const PORT_PRECHECK_TIMEOUT_MS = 2_000;
