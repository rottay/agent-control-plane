import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

import { LedgerDatabaseIdentity } from "@acp/api-contracts";

/**
 * Redact an absolute ledger path into the identity a reader is allowed to see.
 *
 * The digest is computed once, server side, from the path this process was
 * told to open. Nothing downstream of this function ever sees the path again:
 * every route hands the caller `LedgerDatabaseIdentity`, never the string this
 * module consumed to build it.
 *
 * The path is resolved to absolute before it is hashed. The contract defines
 * `id` as the digest of the absolute path, so hashing whatever string the
 * caller happened to pass would make the identity depend on the working
 * directory the process was started from: the same database opened as
 * `./acp.sqlite` and as `/tmp/acp.sqlite` would report two different ids, and
 * the CLI, which resolves, would disagree with this server about which ledger
 * a reader is looking at.
 */
export function computeDatabaseIdentity(path: string): LedgerDatabaseIdentity {
  const resolved = resolve(path);
  return LedgerDatabaseIdentity.parse({
    id: createHash("sha256").update(resolved, "utf8").digest("hex"),
    label: basename(resolved),
    pathRedacted: true,
  });
}
