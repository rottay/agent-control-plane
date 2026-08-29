import type { LedgerDatabaseIdentity } from "@acp/api-contracts";
import { type Ledger, openLedger } from "@acp/ledger";

import { computeDatabaseIdentity } from "../database-identity/index.js";

/**
 * The outcome of the one, and only, ledger open this process performs.
 *
 * Every route consults this rather than opening the ledger itself. That is
 * what makes "open it only via `openLedger(path, { readOnly: true })`" true by
 * construction rather than by review: there is exactly one call site.
 */
export type LedgerSource =
  | {
      readonly kind: "open";
      readonly ledger: Ledger;
      readonly database: LedgerDatabaseIdentity;
    }
  | {
      readonly kind: "unavailable";
      readonly code: "LEDGER_UNAVAILABLE" | "CONTRACT_VERSION_MISMATCH";
      readonly detail: string;
    };

/**
 * Open the ledger read-only, and never anything else.
 *
 * A read-only handle from `@acp/ledger` never appends, never rebuilds and
 * never migrates; it fails closed if the file is missing or the applied
 * migration set does not match this build. Both failures are caught here and
 * turned into a typed, path-free outcome instead of propagating an error whose
 * message names the absolute path.
 */
export function openLedgerSource(path: string): LedgerSource {
  try {
    const ledger = openLedger(path, { readOnly: true });
    return { kind: "open", ledger, database: computeDatabaseIdentity(path) };
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : "";
    if (name === "LedgerMigrationError") {
      return {
        kind: "unavailable",
        code: "CONTRACT_VERSION_MISMATCH",
        detail: "the ledger database has not been migrated to the schema this build expects",
      };
    }
    return {
      kind: "unavailable",
      code: "LEDGER_UNAVAILABLE",
      detail: "the configured ledger database could not be opened read-only",
    };
  }
}
