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

/**
 * The two services this edge hosts, and both are on the surface (V2-B2-5G).
 *
 * `createAcpGateWorkflow` joins `createAcpTaskObject` because the gate had a
 * driver verb, a contract, a capability declaration and drills, and no way for
 * an assembled consumer to serve it: the factory was reachable only from this
 * package's own drill child, so `RestateDriver.signal` was `SUPPORTED` against
 * a service the daemon's endpoint did not host. A capability that only a
 * fixture can honour is the defect V2 exists to correct, and closing it means
 * the factory has to leave the package.
 *
 * `GateDependencies` joins it because it is the factory's own parameter type,
 * and an exported function may not reach the package root carrying a type the
 * root cannot name. The first draft of this packet held it back and was
 * corrected: hiding a type that is already structurally reachable through
 * `createAcpGateWorkflow`'s signature does not narrow the surface, it only
 * makes the surface undeclarable — a consumer writing a wrapper would have to
 * re-declare the shape by hand or deep-import, and the barrel pin would be
 * asserting a set that does not describe what the package actually offers.
 *
 * What the type is stays exactly what it was, and is worth saying plainly
 * rather than dressing up: its one member, `__onGate`, is an announcement seam
 * that exists for the drills for the same reason `__onBeat` does, so a drill
 * can proceed on a handshake rather than on elapsed time. It is optional, it
 * carries no fact — the gate holds no ledger and appends nothing — and the
 * production endpoint calls the factory with no argument at all, which
 * `L-B25G-1` asserts by shape. Publishing the type does not make hanging a
 * callback on a production gate legal; it makes the signature honest.
 */
export {
  RESTATE_MODE,
  RestateDriver,
  createAcpGateWorkflow,
  createAcpTaskObject,
  reconcile,
} from "./drivers/restate-driver/index.js";
export type {
  GateDependencies,
  ObjectDependencies,
  ReconcileInput,
} from "./drivers/restate-driver/index.js";

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
