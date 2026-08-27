#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  API_ALLOWED_METHODS,
  API_CONTRACT_VERSION,
  API_ROUTE_PATTERNS,
  LEDGER_CONTRACT_VERSION,
} from "@acp/api-contracts";
import { LEDGER_MIGRATIONS } from "@acp/ledger";

/**
 * The read-only observation CLI.
 *
 * P1B scaffold. This entry point exists so the shared foundation can pin the
 * package boundary, the dependency direction and the argument parser before
 * the CLI lane starts. It implements no command.
 *
 * What it deliberately does NOT do:
 *
 * - it opens no ledger and reads no database;
 * - it invents no output format, because a format printed once is a contract;
 * - it reports no counts, no states and no health, because it has observed
 *   nothing and a CLI that prints plausible zeroes is worse than one that
 *   refuses.
 *
 * Argument parsing is `node:util` `parseArgs`. No third party parser is in the
 * graph and none is needed: the observation surface is a handful of read-only
 * verbs over a frozen route table.
 */

/** The marker every unimplemented P1B surface reports. */
export const NOT_IMPLEMENTED = "NOT_IMPLEMENTED_P1B_SHARED_FOUNDATION";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_NOT_IMPLEMENTED = 3;

/**
 * The ledger schema version this build is compiled against.
 *
 * Derived from the migration set rather than restated, so it cannot drift from
 * the ledger it will eventually read.
 */
export const LEDGER_SCHEMA_VERSION: number = LEDGER_MIGRATIONS.reduce(
  (highest, migration) => (migration.version > highest ? migration.version : highest),
  0,
);

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

const USAGE = [
  "acp - Agent Control Plane observation CLI",
  "",
  "Usage:",
  "  acp --help",
  "  acp --version",
  "",
  "Status:",
  "  " + NOT_IMPLEMENTED,
  "",
  "  No command is implemented. The P1B shared foundation pins the contract,",
  "  the package boundary and the argument parser only. The CLI lane implements",
  "  the read-only verbs over the routes below.",
  "",
  "Planned read-only routes:",
  ...API_ROUTE_PATTERNS.map((pattern) => "  " + [...API_ALLOWED_METHODS].join(",") + " " + pattern),
  "",
].join("\n");

function versionReport(): string {
  return [
    "apiContractVersion  " + API_CONTRACT_VERSION,
    "ledgerContractVersion  " + LEDGER_CONTRACT_VERSION,
    "ledgerSchemaVersion  " + String(LEDGER_SCHEMA_VERSION),
    "",
  ].join("\n");
}

function describeParseFailure(error: unknown): string {
  return error instanceof Error ? error.message : "could not parse the arguments";
}

/**
 * Run the CLI over an argument vector and return the process exit code.
 *
 * Separated from the entry point so the CLI lane can test it without spawning a
 * process, and so importing this module never runs anything.
 */
export function run(argv: readonly string[]): number {
  let values: { readonly help?: boolean | undefined; readonly version?: boolean | undefined };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
  } catch (error: unknown) {
    process.stderr.write("acp: " + describeParseFailure(error) + "\n\n" + USAGE);
    return EXIT_USAGE;
  }

  if (values.help === true) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }

  if (values.version === true) {
    process.stdout.write(versionReport());
    return EXIT_OK;
  }

  process.stderr.write(
    "acp: " +
      NOT_IMPLEMENTED +
      "\n" +
      "acp: no observation command exists yet; run acp --help\n",
  );
  return EXIT_NOT_IMPLEMENTED;
}

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
