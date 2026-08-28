#!/usr/bin/env node
/**
 * Process entry point of the read-only observation CLI.
 *
 * This file is deliberately thin. All behaviour lives in `./cli.js`, which is
 * importable without side effects, so the whole surface can be exercised in
 * process by the test suite instead of by spawning a shell and reading bytes
 * back. The only thing that happens here is the decision to actually run.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export {
  EXIT_OK,
  EXIT_INTERNAL,
  EXIT_USAGE,
  EXIT_NOT_FOUND,
  EXIT_UNAVAILABLE,
  EXIT_INTEGRITY,
  LEDGER_SCHEMA_VERSION,
  run,
} from "./cli/index.js";
export type { CliIo } from "./cli/index.js";

export { OUTPUT_FORMATS, isOutputFormat } from "./format/index.js";
export type { OutputFormat } from "./format/index.js";

import { run } from "./cli/index.js";

/**
 * Run only when this module is the process entry point.
 *
 * `process.argv[1]` is the path the shell invoked, which for a package `bin` is
 * a symlink in a `node_modules/.bin` directory, while `import.meta.url` is
 * always the real file. Comparing them without resolving the link makes the CLI
 * silently do nothing when it is invoked the way it is actually installed, which
 * is the one invocation path that matters. Both sides are therefore resolved
 * through the filesystem before they are compared.
 */
function isProcessEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved is not this module.
    return false;
  }
}

if (isProcessEntryPoint()) {
  process.exitCode = run(process.argv.slice(2));
}
