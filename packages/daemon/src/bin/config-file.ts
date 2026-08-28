import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

import type { DaemonChildConfig } from "../daemon-child.js";
import { parseDaemonChildConfig } from "../daemon-child.js";

/**
 * The config file is what decides which program the daemon runs, so it is held
 * to the same law as the paths inside a rendered launch agent.
 *
 * launchd hands this entry one argument and nothing else. Everything the daemon
 * will do is therefore decided by a file, and a file anyone can rewrite is a way
 * to make the daemon do something else — which is why ownership and write
 * permissions are checked rather than assumed, and why the path must be the one
 * a reviewer read rather than whatever a symlink points at today.
 *
 * There is one schema, not two. The content is validated by the existing
 * `parseDaemonChildConfig`, so the file contract and the argv contract cannot
 * drift apart.
 */

export type ConfigRefusal =
  | "PATH_NOT_ABSOLUTE"
  | "PATH_NOT_CANONICAL"
  | "PATH_MISSING"
  | "PATH_NOT_REGULAR_FILE"
  | "PATH_NOT_OWNED"
  | "UNSAFE_PERMISSIONS"
  | "TOO_LARGE"
  | "MALFORMED_JSON"
  | "INVALID_CONFIG";

export type ConfigVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ConfigRefusal; readonly detail: string };

export type ConfigLoad =
  | { readonly ok: true; readonly config: DaemonChildConfig }
  | { readonly ok: false; readonly reason: ConfigRefusal; readonly detail: string };

/** A config document has no business being large. */
export const CONFIG_MAX_BYTES = 64 * 1024;

function refuse(reason: ConfigRefusal, detail: string): ConfigVerdict {
  return { ok: false, reason, detail };
}

/**
 * Check the path before anything is read.
 *
 * The size bound is checked here, on the stat, rather than after reading: a
 * bound applied to something already in memory is not a bound.
 */
export function checkConfigPath(path: string): ConfigVerdict {
  if (!isAbsolute(path)) return refuse("PATH_NOT_ABSOLUTE", "the config path must be absolute");
  if (path.split(sep).includes("..")) {
    return refuse("PATH_NOT_ABSOLUTE", "the config path must contain no .. segment");
  }

  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    return refuse("PATH_MISSING", "the config file does not exist");
  }
  if (resolved !== path) {
    return refuse("PATH_NOT_CANONICAL", "the config path traverses a symlink");
  }

  const stats = statSync(path);
  if (!stats.isFile()) return refuse("PATH_NOT_REGULAR_FILE", "the config path is not a file");
  if (stats.uid !== process.getuid?.()) {
    return refuse("PATH_NOT_OWNED", "the config file belongs to another account");
  }
  if ((stats.mode & 0o022) !== 0) {
    return refuse("UNSAFE_PERMISSIONS", "the config file is group- or world-writable");
  }
  if (stats.size > CONFIG_MAX_BYTES) {
    return refuse("TOO_LARGE", "the config file exceeds its size bound");
  }
  return { ok: true };
}

/** Check the path, then the content, refusing at the first failure. */
export function loadDaemonConfig(path: string): ConfigLoad {
  const pathVerdict = checkConfigPath(path);
  if (!pathVerdict.ok) return pathVerdict;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "PATH_MISSING", detail: "the config file became unreadable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "MALFORMED_JSON", detail: "the config file is not valid JSON" };
  }

  try {
    return { ok: true, config: parseDaemonChildConfig(parsed) };
  } catch (error: unknown) {
    // The classified code, never the rendered message: a config error must not
    // echo file content back into a log.
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      reason: "INVALID_CONFIG",
      detail: typeof code === "string" ? code : "the config does not satisfy the daemon schema",
    };
  }
}
