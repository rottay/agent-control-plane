import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { AdmittedConfigRoot, AdmittedWorkdir, ProviderName } from "./contract.js";
import { AdapterError } from "./errors.js";

/**
 * Config-root admission and the environment allowlist.
 *
 * P3A's law, applied to the two places P4 genuinely needs a path: a caller
 * hands over a directory it already owns, and this module decides whether the
 * adapter may use it. The brands exist so a raw string cannot reach `spawn`;
 * only this module mints them.
 *
 * The root is never created here. An absent root is refused, exactly as the
 * observation package refuses one: a component that creates the directory it
 * is pointed at can be aimed anywhere and will report, truthfully and
 * uselessly, that it found nothing.
 */

/**
 * Path fragments that mean "this is somebody's product checkout".
 *
 * A config root or working directory inside one of these is refused outright,
 * whatever else is true about it. P4 adapters read; they do not go near real
 * work.
 */
const PRODUCT_PATH_MARKERS: readonly string[] = Object.freeze([
  "/Rottay/app-",
  "/Rottay/dm-",
  "/Rottay/svc-",
  "/Rottay/ui-",
  "/Rottay/platform",
]);

/** Exactly the configuration variable each provider is permitted. */
export const PROVIDER_CONFIG_ENV: Readonly<Record<ProviderName, string>> = Object.freeze({
  claude: "CLAUDE_CONFIG_DIR",
  kimi: "KIMI_CODE_HOME",
  codex: "CODEX_HOME",
});

/** Variables every provider gets, and the only ones. */
export const BASE_ENV_KEYS: readonly string[] = Object.freeze(["HOME", "LC_ALL", "PATH"]);

/** The complete allowlist for one provider, sorted, for equality pinning. */
export function allowedEnvKeys(provider: ProviderName): readonly string[] {
  return Object.freeze([...BASE_ENV_KEYS, PROVIDER_CONFIG_ENV[provider]].sort());
}

function admitDirectory(
  candidate: string,
  context: { readonly provider: string; readonly taskId: string },
): string {
  if (!isAbsolute(candidate)) {
    throw new AdapterError("CONFIG_ROOT_REFUSED", context);
  }
  if (!existsSync(candidate)) {
    throw new AdapterError("CONFIG_ROOT_REFUSED", context);
  }
  // Canonical, so a symlinked root cannot point somewhere the checks below
  // never looked at.
  if (realpathSync(candidate) !== candidate) {
    throw new AdapterError("CONFIG_ROOT_REFUSED", context);
  }
  const stats = statSync(candidate);
  if (!stats.isDirectory()) {
    throw new AdapterError("CONFIG_ROOT_REFUSED", context);
  }
  if (stats.uid !== process.getuid?.()) {
    throw new AdapterError("CONFIG_ROOT_REFUSED", context);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new AdapterError("CONFIG_ROOT_REFUSED", context);
  }
  for (const marker of PRODUCT_PATH_MARKERS) {
    if (candidate.includes(marker)) {
      throw new AdapterError("CONFIG_ROOT_REFUSED", context);
    }
  }
  return candidate;
}

export function admitConfigRoot(
  candidate: string,
  context: { readonly provider: string; readonly taskId: string },
): AdmittedConfigRoot {
  return admitDirectory(candidate, context) as AdmittedConfigRoot;
}

export function admitWorkdir(
  candidate: string,
  context: { readonly provider: string; readonly taskId: string },
): AdmittedWorkdir {
  return admitDirectory(candidate, context) as AdmittedWorkdir;
}

/**
 * Build the environment for one session.
 *
 * Constructed key by key from the allowlist. `process.env` is read here and
 * nowhere else in the package, and it is never spread: a variable absent from
 * the allowlist cannot reach a provider even by accident.
 */
export function buildEnv(
  provider: ProviderName,
  configRoot: AdmittedConfigRoot,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env[PROVIDER_CONFIG_ENV[provider]] = configRoot;
  return Object.freeze(env);
}
