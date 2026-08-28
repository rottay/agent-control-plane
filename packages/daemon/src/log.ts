import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";

import {
  FILE_MODE,
  LOG_MAX_BYTES,
  LOG_MAX_FILES,
  LOG_MAX_LINE_BYTES,
} from "./constants.js";
import type { DaemonErrorCode } from "./errors.js";
import type { DaemonRoot } from "./paths.js";
import { logFilePath } from "./paths.js";

/**
 * A bounded, redacted log.
 *
 * Three caps, and all three are needed. A byte cap alone lets an unbounded
 * number of rotated files accumulate. A file cap alone lets each one grow
 * without limit. A line cap stops one enormous message from defeating both in a
 * single write. Only the three together are a bound, and each is tested past
 * its limit rather than argued for.
 *
 * Fields are structured on purpose. A log line assembled by concatenating an
 * exception into a template is how absolute paths, payload fragments and
 * environment values end up on disk; here a line can only carry an event name,
 * a classified code and a small map of scalars.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface LogLine {
  readonly at: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly code: DaemonErrorCode | null;
  readonly fields: LogFields;
}

export interface Logger {
  log(level: LogLevel, event: string, code: DaemonErrorCode | null, fields?: LogFields): void;
}

const SAFE_EVENT = new RegExp("^[a-z0-9._-]{1,64}$");

/**
 * Reduce a value to something that cannot leak.
 *
 * Strings are the only risk, so they are capped and stripped of anything that
 * looks like a filesystem path. This is deliberately blunt: a truncated field
 * is a small loss, and a leaked home directory is not.
 */
export function scrub(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value !== "string") return value;
  const withoutPaths = value.replace(new RegExp("(/[^\\s]{2,})", "g"), "<path>");
  return withoutPaths.length > 200 ? withoutPaths.slice(0, 200) : withoutPaths;
}

/** Render one line, already bounded and scrubbed. */
export function renderLine(line: LogLine): string {
  if (!SAFE_EVENT.test(line.event)) {
    throw new Error("a log event name must be a short identifier");
  }
  const fields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(line.fields)) {
    if (!SAFE_EVENT.test(key)) continue;
    fields[key] = scrub(value);
  }
  const rendered = JSON.stringify({
    at: line.at,
    level: line.level,
    event: line.event,
    code: line.code,
    fields,
  });
  return rendered.length > LOG_MAX_LINE_BYTES ? rendered.slice(0, LOG_MAX_LINE_BYTES) : rendered;
}

/**
 * Rotate when the active file would exceed its cap.
 *
 * Rotation is a rename, which is atomic within a directory, so a reader never
 * observes a half-moved file. The oldest generation is removed first, which is
 * what makes the file count a cap rather than a suggestion.
 */
export function rotateIfNeeded(root: DaemonRoot, incomingBytes: number): boolean {
  const active = logFilePath(root);
  if (!existsSync(active)) return false;
  const size = statSync(active).size;
  if (size + incomingBytes <= LOG_MAX_BYTES) return false;

  const oldest = active + "." + String(LOG_MAX_FILES - 1);
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = LOG_MAX_FILES - 2; index >= 1; index -= 1) {
    const from = active + "." + String(index);
    if (existsSync(from)) renameSync(from, active + "." + String(index + 1));
  }
  renameSync(active, active + ".1");
  return true;
}

/** Total bytes the log occupies across every generation. */
export function logBytes(root: DaemonRoot): number {
  const active = logFilePath(root);
  let total = 0;
  for (const candidate of [active, ...generationPaths(active)]) {
    if (existsSync(candidate)) total += statSync(candidate).size;
  }
  return total;
}

/** Every rotated generation path, oldest last. */
export function generationPaths(active: string): string[] {
  const paths: string[] = [];
  for (let index = 1; index < LOG_MAX_FILES; index += 1) {
    paths.push(active + "." + String(index));
  }
  return paths;
}

/** A logger bound to one owned root. */
export function createLogger(root: DaemonRoot, clock: () => string): Logger {
  return {
    log(level, event, code, fields = {}) {
      const rendered = renderLine({ at: clock(), level, event, code, fields });
      const bytes = Buffer.byteLength(rendered, "utf8") + 1;
      rotateIfNeeded(root, bytes);
      appendFileSync(logFilePath(root), rendered + "\n", { mode: FILE_MODE });
    },
  };
}
