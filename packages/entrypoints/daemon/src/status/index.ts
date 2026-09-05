import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";

import { FILE_MODE } from "../constants/index.js";
import type { DaemonErrorCode } from "../errors/index.js";
import type { DaemonRoot } from "../paths/index.js";
import { statusPath } from "../paths/index.js";

/**
 * A bounded, redacted observation of what the daemon is doing.
 *
 * Observational only. Nothing in the lifecycle, the mode drivers or the
 * singleton reads this document to make a decision, and the architecture fence
 * asserts that by forbidding the import. The moment a decision depends on it,
 * it stops being an observation and becomes a second authority that can
 * disagree with the ledger.
 *
 * Process ids are included deliberately: they are not secrets, and an operator
 * or a drill needs them to terminate exactly the right process rather than
 * pattern-matching across the machine.
 */

export type DaemonPhase =
  | "INIT"
  | "ROOTS_VALIDATED"
  | "SINGLETON_HELD"
  | "LEDGER_OPEN"
  | "BINARY_VERIFIED"
  | "SERVER_UP"
  | "ENDPOINT_UP"
  | "DEPLOYMENT_REGISTERED"
  | "RECONCILED"
  | "READY"
  | "SUPERVISING"
  | "DRAINING"
  | "STOPPED"
  | "TERMINAL";

export interface DaemonStatusDocument {
  readonly phase: DaemonPhase;
  readonly mode: string;
  /** The scenario identifier, which is a relative name and never a path. */
  readonly scenarioId: string;
  readonly pid: number;
  readonly serverPid: number | null;
  /**
   * The identity of the server this daemon spawned, recorded at the instant its
   * pid first existed (V2-B2-6).
   *
   * A pid alone answers nothing, because pids are reused. These two fields are
   * what let explicit recovery prove that the process now holding a pid is the
   * same server this daemon started, before it signals anything.
   *
   * **Atomic with `serverPid`: all three null, or all three set.** A document
   * carrying a pid without an identity is a pre-packet document, and recovery
   * treats it as no evidence at all.
   */
  readonly serverStartToken: string | null;
  readonly serverArgvDigest: string | null;
  readonly ledgerHeadSequence: number | null;
  readonly ledgerHeadSha256: string | null;
  /** A classified code, never a rendered exception. */
  readonly errorCode: DaemonErrorCode | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** Total serialized size a status document may occupy. */
export const STATUS_MAX_BYTES = 2_048;

const SHA256_HEX = new RegExp("^[0-9a-f]{64}$");
/**
 * The probe's five-field C-locale `lstart` rendering, e.g. "Wed Aug 27
 * 18:46:07 2026".
 *
 * Bounded here for the same reason every other field is: a status document is
 * an observation surface, and an unbounded string is where a path or a payload
 * arrives. It mirrors the probe's own line grammar rather than accepting any
 * text that happens to be a date.
 */
const PS_START_TOKEN = new RegExp(
  "^\\S+\\s+\\S+\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}$",
);
const SCENARIO_ID = new RegExp("^[a-z0-9-]{1,64}$");
const ISO_TIMESTAMP = new RegExp(
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$",
);

const PHASES: readonly string[] = Object.freeze([
  "INIT",
  "ROOTS_VALIDATED",
  "SINGLETON_HELD",
  "LEDGER_OPEN",
  "BINARY_VERIFIED",
  "SERVER_UP",
  "ENDPOINT_UP",
  "DEPLOYMENT_REGISTERED",
  "RECONCILED",
  "READY",
  "SUPERVISING",
  "DRAINING",
  "STOPPED",
  "TERMINAL",
]);

const MODES: readonly string[] = Object.freeze(["SQLITE_SUPERVISOR", "RESTATE"]);

const ERROR_CODES: readonly string[] = Object.freeze([
  "DAEMON_ROOT",
  "SINGLETON",
  "STALE_LOCK",
  "IDENTITY_PROBE",
  "MODE",
  "STARTUP",
  "SUPERVISION",
  "SHUTDOWN",
  "STATUS",
  "LOG",
]);

/** Exactly these keys, no more and no fewer. */
const STATUS_KEYS: readonly string[] = Object.freeze([
  "phase",
  "mode",
  "scenarioId",
  "pid",
  "serverPid",
  "serverStartToken",
  "serverArgvDigest",
  "ledgerHeadSequence",
  "ledgerHeadSha256",
  "errorCode",
  "startedAt",
  "updatedAt",
]);

function isPid(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Is this a status document, checked at runtime rather than by the type?
 *
 * The type annotation was doing no work: every read cast parsed JSON straight to
 * the interface, and every field except the scenario id and one digest went
 * unchecked. A document is either exactly this shape or it is not a status.
 */
export function validateStatus(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "not an object";
  const record = value as Record<string, unknown>;

  const keys = Object.keys(record).sort();
  const expected = [...STATUS_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    // Extra keys are how a payload or a path arrives in an observation that
    // every other check would still pass.
    return "unexpected key set";
  }

  if (!PHASES.includes(record["phase"] as string)) return "unknown phase";
  if (!MODES.includes(record["mode"] as string)) return "unknown mode";
  if (!SCENARIO_ID.test(String(record["scenarioId"]))) return "scenarioId is not an identifier";
  if (!isPid(record["pid"])) return "pid is not a positive integer";
  if (record["serverPid"] !== null && !isPid(record["serverPid"])) {
    return "serverPid is not null or a positive integer";
  }
  const startToken = record["serverStartToken"];
  if (startToken !== null && (typeof startToken !== "string" || !PS_START_TOKEN.test(startToken))) {
    return "serverStartToken is not null or a ps start token";
  }
  const argvDigest = record["serverArgvDigest"];
  if (argvDigest !== null && (typeof argvDigest !== "string" || !SHA256_HEX.test(argvDigest))) {
    return "serverArgvDigest is not null or 64 lowercase hex";
  }
  // The triple is atomic. A pid without an identity cannot prove anything about
  // the process now holding it, and an identity without a pid names nothing to
  // probe -- so a half-identity is a malformed document rather than a partial
  // one, and recovery never has to decide what half of a proof means.
  const identityFields = [record["serverPid"], startToken, argvDigest];
  const present = identityFields.filter((field) => field !== null).length;
  if (present !== 0 && present !== identityFields.length) {
    return "server identity is partial: serverPid, serverStartToken and serverArgvDigest move together";
  }
  const sequence = record["ledgerHeadSequence"];
  if (sequence !== null && (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0)) {
    return "ledgerHeadSequence is not null or a non-negative integer";
  }
  const digest = record["ledgerHeadSha256"];
  if (digest !== null && (typeof digest !== "string" || !SHA256_HEX.test(digest))) {
    return "ledgerHeadSha256 is not null or 64 lowercase hex";
  }
  const code = record["errorCode"];
  if (code !== null && !ERROR_CODES.includes(code as string)) return "unknown errorCode";
  for (const field of ["startedAt", "updatedAt"]) {
    if (!ISO_TIMESTAMP.test(String(record[field]))) return field + " is not an ISO timestamp";
  }
  return null;
}

/**
 * Reject anything that must never reach disk.
 *
 * A denylist would be guesswork, so this is a shape check: every field is a
 * known key with a known type, and the two free-form-looking fields are
 * constrained to a digest and an identifier grammar. There is nowhere for an
 * absolute path, a payload or an environment value to sit.
 */
export function assertPublishable(document: DaemonStatusDocument): void {
  const problem = validateStatus(document);
  if (problem !== null) {
    throw new Error("refusing to publish a malformed status document: " + problem);
  }
  const encoded = JSON.stringify(document);
  if (Buffer.byteLength(encoded, "utf8") > STATUS_MAX_BYTES) {
    throw new Error("a status document must stay within its size bound");
  }
}

/**
 * Publish the status atomically.
 *
 * Write-then-rename, because a reader that catches a partially written file
 * sees corruption rather than an older truth, and `rename` within one directory
 * is atomic. The temporary file is removed on failure so a crash mid-write
 * cannot leave debris behind.
 */
export function writeStatus(root: DaemonRoot, document: DaemonStatusDocument): void {
  assertPublishable(document);
  const target = statusPath(root);
  const temporary = target + ".tmp";
  const handle = openSync(temporary, "w", FILE_MODE);
  try {
    writeSync(handle, JSON.stringify(document));
  } catch (error: unknown) {
    closeSync(handle);
    try {
      unlinkSync(temporary);
    } catch {
      // nothing to clean up
    }
    throw error;
  }
  closeSync(handle);
  renameSync(temporary, target);
}

/**
 * Read this daemon's own status.
 *
 * Takes no argument: the owned root is resolved by this package, so there is no
 * caller-supplied filesystem path anywhere in the public surface.
 */
export function readStatusFrom(root: DaemonRoot): DaemonStatusDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statusPath(root), "utf8"));
  } catch {
    return null;
  }
  // A widened or malformed document is not a status. Casting one to the
  // interface would let a reader act on fields nothing ever checked.
  if (validateStatus(parsed) !== null) return null;
  return parsed as DaemonStatusDocument;
}

/** Remove the observation. Called only during an owned shutdown. */
export function clearStatus(root: DaemonRoot): void {
  try {
    unlinkSync(statusPath(root));
  } catch {
    // already gone
  }
}
