#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_BIND_HOST } from "../constants/index.js";
import { startServer } from "../start/index.js";

/**
 * The operator's start entry (P8-8G packet 2, C6).
 *
 * An operator has had no way to start this server except by writing their own
 * script around `startServer`, which is exactly the "caller wrapper" the
 * daemon's packaged entry exists to avoid: the thing run should be a built
 * file from this repository, with nothing hand-written in between.
 *
 * **Flags, not positionals**, unlike the daemon's entry — this one takes up to
 * four paths and a port, and four positional arguments in a fixed order is the
 * kind of interface an operator gets wrong at 2am. Hand-rolled parsing, no new
 * dependency: an argv loop is a dozen lines and a parser library is a supply
 * chain.
 *
 * **The classified-exit idiom, from the daemon's entry.** Usage goes to stderr,
 * only classified reason words travel, never configuration content, and the
 * exit codes are distinct so a caller can branch without parsing prose.
 *
 * **Loopback is restated here** rather than assumed from `startServer`: the
 * entry an operator invokes is where the reader looks to learn what the
 * process binds, and a law stated only in a module they will not open is a law
 * they will not know.
 *
 * Importing this module does nothing. It runs only when executed directly.
 */

/**
 * Classified exits, so a caller can branch without parsing prose.
 *
 * `EXIT_OK`/`EXIT_USAGE` are the convention all three binaries share and are
 * declared once in `@acp/contracts` (G7 D1); `EXIT_PATH` is this entry's own.
 */
import { EXIT_OK, EXIT_USAGE } from "@acp/protocol";
export { EXIT_OK, EXIT_USAGE };
export const EXIT_PATH = 3;

const USAGE = [
  "acp-server: start the local observation and write plane",
  "",
  "  --ledger <path>          required; the SQLite ledger this process reads",
  "  --accounts-file <path>   optional; the owner accounts file",
  "  --write-bearer <path>    optional; the write bearer token file",
  "  --port <n>               optional; 0 asks the OS for a free port",
  "",
  "  Every path must be absolute. The server binds " + SERVER_BIND_HOST + " only.",
].join("\n");

export interface ParsedArgv {
  readonly ledgerPath: string;
  readonly accountsFilePath?: string | undefined;
  readonly writeBearerPath?: string | undefined;
  readonly port?: number | undefined;
}

export type ArgvOutcome =
  | { readonly ok: true; readonly options: ParsedArgv }
  | { readonly ok: false; readonly reason: string; readonly exit: number };

const PATH_FLAGS = new Map<string, keyof ParsedArgv>([
  ["--ledger", "ledgerPath"],
  ["--accounts-file", "accountsFilePath"],
  ["--write-bearer", "writeBearerPath"],
]);

/**
 * Parse an argv tail into options, or classify why not.
 *
 * Pure over its input and exported, so the whole decision is testable without
 * starting a server or spawning a process.
 */
export function parseArgv(argv: readonly string[]): ArgvOutcome {
  const values = new Map<keyof ParsedArgv, string>();
  let port: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;

    if (flag === "--port") {
      const raw = argv[index + 1];
      index += 1;
      if (raw === undefined || !/^\d+$/.test(raw)) {
        return { ok: false, reason: "PORT_NOT_A_NUMBER", exit: EXIT_USAGE };
      }
      const parsed = Number.parseInt(raw, 10);
      if (parsed > 65535) return { ok: false, reason: "PORT_OUT_OF_RANGE", exit: EXIT_USAGE };
      port = parsed;
      continue;
    }

    const key = PATH_FLAGS.get(flag);
    if (key === undefined) {
      // Named, not echoed: an unknown flag is the operator's typo and the
      // reason word is enough to find it. Echoing argv would put whatever
      // they typed — possibly a path, possibly worse — into a log.
      return { ok: false, reason: "UNKNOWN_FLAG", exit: EXIT_USAGE };
    }
    const raw = argv[index + 1];
    index += 1;
    if (raw === undefined || raw === "" || raw.startsWith("-")) {
      return { ok: false, reason: "FLAG_WITHOUT_VALUE", exit: EXIT_USAGE };
    }
    if (!isAbsolute(raw)) {
      // Refused here rather than deep in a loader, because a relative path is
      // a usage error: it means something different depending on where the
      // operator happened to be standing.
      return { ok: false, reason: "PATH_NOT_ABSOLUTE", exit: EXIT_PATH };
    }
    values.set(key, raw);
  }

  const ledgerPath = values.get("ledgerPath");
  if (ledgerPath === undefined) {
    return { ok: false, reason: "LEDGER_PATH_REQUIRED", exit: EXIT_USAGE };
  }

  return {
    ok: true,
    options: {
      ledgerPath,
      accountsFilePath: values.get("accountsFilePath"),
      writeBearerPath: values.get("writeBearerPath"),
      port,
    },
  };
}

/** Run the entry over an argv tail. Exported for testing. */
export async function runServerEntry(argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) {
    process.stderr.write("acp-server: " + parsed.reason + "\n");
    process.stderr.write(USAGE + "\n");
    return parsed.exit;
  }

  await startServer(parsed.options);
  return EXIT_OK;
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url))
) {
  void runServerEntry(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
