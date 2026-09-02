/**
 * The read-only observation server.
 *
 * Implements every frozen `GET` route in `@acp/protocol`'s `API_ROUTES`
 * over one loopback-bound Fastify application. Nothing here mutates the
 * ledger: the one handle this package ever opens is requested read-only, and
 * every response is validated against its contract DTO before it is sent.
 *
 * Importing this module has no side effect. `buildServer` builds an
 * application without listening, for tests and for embedding; `startServer`
 * is the only function in this package that opens a socket, and it does so
 * only when called with an explicit ledger path.
 */

export { buildServer, type BuildServerOptions } from "./build-server/index.js";
export { SERVER_BIND_HOST, SERVER_DEFAULT_PORT } from "./constants/index.js";
export { computeDatabaseIdentity } from "./database-identity/index.js";
export { openLedgerSource, type LedgerSource } from "./ledger-source/index.js";
export { type RunningServer, startServer, type StartServerOptions } from "./start/index.js";
