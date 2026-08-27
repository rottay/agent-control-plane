import {
  API_ALLOWED_METHODS,
  API_CONTRACT_VERSION,
  API_ROUTE_PATTERNS,
  LEDGER_CONTRACT_VERSION,
  type ApiAllowedMethod,
  type ApiRoutePattern,
} from "@acp/api-contracts";
import { LEDGER_MIGRATIONS } from "@acp/ledger";

/**
 * The read-only observation server.
 *
 * P1B scaffold. This module states the laws the server lane must implement and
 * implements none of them. It opens no socket, opens no ledger and answers no
 * request, and `start()` throws rather than pretending otherwise.
 *
 * The laws, stated here so they are code rather than prose in a document:
 *
 * 1. **Loopback only.** The listener binds `127.0.0.1`. The control plane is a
 *    local tool; a bind address of `0.0.0.0` would publish an unauthenticated
 *    view of every task and worker to the local network, so the host is a
 *    constant here and not a configuration knob.
 * 2. **Reads only.** `GET` is the whole method set. Every other verb is
 *    answered with the `METHOD_NOT_ALLOWED` error envelope.
 * 3. **One contract.** Every response is produced by parsing through
 *    `@acp/api-contracts` on the way out. A response that does not satisfy the
 *    contract is a server error, not a payload for a browser to interpret.
 * 4. **Redaction at this boundary.** The ledger's absolute path is converted
 *    into an opaque identity here, because this is the last place that knows
 *    the path at all.
 */

/** The marker every unimplemented P1B surface reports. */
export const NOT_IMPLEMENTED = "NOT_IMPLEMENTED_P1B_SHARED_FOUNDATION";

/** Loopback. Not configurable, by design. */
export const SERVER_BIND_HOST = "127.0.0.1";

/** Default local port. The server lane may make the port configurable. */
export const SERVER_DEFAULT_PORT = 7517;

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

export interface PlannedSurface {
  readonly status: typeof NOT_IMPLEMENTED;
  readonly bindHost: typeof SERVER_BIND_HOST;
  readonly defaultPort: typeof SERVER_DEFAULT_PORT;
  readonly allowedMethods: readonly ApiAllowedMethod[];
  readonly routes: readonly ApiRoutePattern[];
  readonly apiContractVersion: typeof API_CONTRACT_VERSION;
  readonly ledgerContractVersion: typeof LEDGER_CONTRACT_VERSION;
  readonly ledgerSchemaVersion: number;
}

/**
 * Describe the surface this package will serve.
 *
 * This is not a health check and must never be mistaken for one: it reports
 * what was compiled in, not what is running, because nothing is running.
 */
export function describePlannedSurface(): PlannedSurface {
  return {
    status: NOT_IMPLEMENTED,
    bindHost: SERVER_BIND_HOST,
    defaultPort: SERVER_DEFAULT_PORT,
    allowedMethods: [...API_ALLOWED_METHODS],
    routes: [...API_ROUTE_PATTERNS],
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
  };
}

/**
 * Start the observation server.
 *
 * Throws. A scaffold that returned an inert handle would let a caller believe a
 * server was listening, which is the exact failure this phase is trying to
 * avoid.
 */
export function start(): never {
  throw new Error(
    NOT_IMPLEMENTED +
      ": the observation server is not implemented; the P1B shared foundation " +
      "pins the contract and the package boundary only",
  );
}
