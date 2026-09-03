/**
 * `@acp/durability` — the Restate edge (P8-T G5).
 *
 * One engine, behind the port the domain declares. Everything Restate-shaped
 * that used to live inside `@acp/runtime` lives here: the Virtual Object and
 * its driver, the SDK endpoint, the spawned child, the ingress submission path,
 * the pinned server's lifecycle, and the four contracts whose only consumers
 * are on this side of the boundary.
 *
 * The direction of the dependency is the whole design. `durability → runtime`
 * is legal (an edge may reach a domain); the reverse is not, and after this
 * split it is not merely discouraged but absent — `@restatedev/restate-sdk`
 * appears under no import specifier anywhere outside this package, which the
 * fence asserts repository-wide rather than trusting.
 *
 * This barrel exports the names the runtime barrel gave up, plus what later
 * packets have added to the edge's own surface, and the fence pins the set by
 * equality in both directions rather than by a count in a sentence. The
 * package-internal surface — `advanceHandler`, `parseCacheReply`, the raw
 * `startServer`/`ServerHandle` pair, `releasePath` — stays internal and is
 * deep-imported only by this package's own tests, exactly as it was before the
 * move. A split that widened the public surface while it was at it would make
 * the before/after comparison meaningless.
 */

export { RESTATE_MODE, RestateDriver, createAcpTaskObject, reconcile } from "./drivers/restate-driver/index.js";
export type { ObjectDependencies, ReconcileInput } from "./drivers/restate-driver/index.js";

export { startEndpoint } from "./drivers/restate-endpoint/index.js";
export type { EndpointHandle, StartEndpointOptions } from "./drivers/restate-endpoint/index.js";

export {
  attachAdvance,
  deriveInvocation,
  readCacheThroughHandler,
  registerDeployment,
  sendAdvance,
  submitAdvance,
} from "./submit/index.js";
export type { AttachResult, SendResult, SubmitResult } from "./submit/index.js";

/**
 * The narrowed server lifecycle.
 *
 * Only the safe pair is exported. `startServer` and `ServerHandle` stay
 * package-internal because they carry the raw child and the absolute data root,
 * which the drills need and no consumer should have.
 */
export { startVerifiedServer, serverAvailability } from "./server-handle/index.js";
export type { SafeServerHandle, ServerExit } from "./server-handle/index.js";

export type {
  DurableStepContext,
  LedgerLike,
  RestateCacheState,
  RestateDriverOptions,
} from "./contracts/index.js";
