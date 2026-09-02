#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDaemonChild } from "../../daemon-child/index.js";
import { loadDaemonConfig } from "../config-file/index.js";

/**
 * The packaged entry launchd executes.
 *
 * One positional argument: an absolute config-file path. Not a `--config` flag,
 * because the tracked template already fixes the shape — `Program` is
 * `PROGRAM_PATH` and `ProgramArguments` is `[PROGRAM_PATH, CONFIG_PATH]`,
 * exactly two strings, and the validator refuses a third. The committed artifact
 * dictates the contract, which is what "no caller wrapper" means concretely:
 * the thing launchd runs is the built form of a file in this repository, with
 * nothing an operator wrote sitting in between.
 *
 * The first line is the portable `#!/usr/bin/env node`. The build materializes
 * the interpreter into the ignored `dist/` artifact, because a launchd gui job
 * runs with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and a Node installed outside
 * that PATH would never be found. Host-specific bytes belong in the ignored
 * build output, never in a tracked file.
 *
 * Importing this module does nothing. It runs only when executed directly.
 */

/**
 * Classified exits, so a caller can branch without parsing prose.
 *
 * `EXIT_OK`/`EXIT_USAGE` are the convention all three binaries share and are
 * declared once in `@acp/contracts` (G7 D1); the two below are this entry's own.
 */
import { EXIT_OK, EXIT_USAGE } from "@acp/contracts";
export { EXIT_OK, EXIT_USAGE };
export const EXIT_CONFIG_PATH = 3;
export const EXIT_CONFIG_CONTENT = 4;

const PATH_REFUSALS = new Set([
  "PATH_NOT_ABSOLUTE",
  "PATH_NOT_CANONICAL",
  "PATH_MISSING",
  "PATH_NOT_REGULAR_FILE",
  "PATH_NOT_OWNED",
  "UNSAFE_PERMISSIONS",
  "TOO_LARGE",
]);

/**
 * Run the packaged entry over an argv tail.
 *
 * Exported for testing, and testable without spawning: everything before the
 * daemon starts is a pure decision about one string.
 */
export async function runPackagedEntry(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1) {
    process.stderr.write("acp-daemon: exactly one argument is required: an absolute config path\n");
    return EXIT_USAGE;
  }
  const configPath = argv[0];
  if (configPath === undefined || configPath === "" || configPath.startsWith("-")) {
    process.stderr.write("acp-daemon: the argument must be a config path, not an option\n");
    return EXIT_USAGE;
  }

  const loaded = loadDaemonConfig(configPath);
  if (!loaded.ok) {
    // The classified reason only. Config content never reaches stderr.
    process.stderr.write("acp-daemon: " + loaded.reason + "\n");
    return PATH_REFUSALS.has(loaded.reason) ? EXIT_CONFIG_PATH : EXIT_CONFIG_CONTENT;
  }

  return await runDaemonChild(loaded.config);
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url))
) {
  void runPackagedEntry(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
