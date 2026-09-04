# `@acp/durability`

The Restate edge. One durable-execution engine, behind the orchestration port
`@acp/runtime` declares.

## Scope

Everything Restate-shaped lives here: the Virtual Object and its driver, the
SDK endpoint, the spawned child, the ingress submission path, the pinned
server's lifecycle, and the four contracts whose only consumers are on this
side of the boundary. G5 created the package by moving all of it out of
`@acp/runtime`.

Nothing here is adopted into real operation. Adoption is a single explicit
decision that happens after P8 certification and a separate P9 authorization.

## The direction of the dependency is the design

`durability → runtime` is legal — an edge may reach a domain. The reverse is
not, and after the split it is not merely discouraged but absent:
`@restatedev/restate-sdk` appears under no import specifier anywhere outside
this package, which the fence asserts repository-wide by parsing import
statements rather than by scanning for the string.

The port itself deliberately does **not** live here. `OrchestrationDriver`,
`DurableInvocation`, the coordinates, beats and probes stay in `@acp/runtime`,
because the domain declares the shape a driver must satisfy and the edge
satisfies it. An edge that owned the port would be an edge implementing
itself.

## The cache is never a fact

`RestateCacheState` is the Virtual Object's entire durable state, and both of
its fields are copies of something the ledger already knows. Deleting all of it
loses nothing — the data-root-deletion drill exists to prove exactly that.

Nothing may be added to that state without an ADR, because a field that is
**not** derivable from the ledger would make Restate a second authority over
control-plane state, whatever the documents say. The ledger is the single
authority (`docs/architecture/0001-control-plane-authority.md`); this package
is a way of executing against it durably, not a second place where truth
lives.

## Public surface

The barrel exports the names the runtime barrel gave up in the split, plus
what later packets have added to the edge's own surface, and the fence pins
the set by equality in both directions — against the table below as well as
against the barrel, so a name can neither appear nor disappear on one side
alone. The count deliberately does not appear in this sentence: an integer in
prose is a fact no gate checks, and it goes stale the first time an export
lands. The package-internal surface — `advanceHandler`, `parseCacheReply`, the raw
`startServer`/`ServerHandle` pair, `releasePath` — stays internal and is
deep-imported only by this package's own tests, exactly as before the move. A
split that widened the public surface while it was at it would make the
before-and-after comparison meaningless.

| Export | Kind |
| --- | --- |
| `RESTATE_MODE` | the driver's mode literal |
| `RestateDriver` | the driver, satisfying the domain's port |
| `RestateDriverOptions` | type: how a driver is constructed |
| `createAcpTaskObject` | the Virtual Object factory |
| `createAcpGateWorkflow` | the durable gate's workflow factory |
| `GateDependencies` | type: the gate factory's parameter — one optional drill seam |
| `ObjectDependencies` | type: what the Virtual Object is handed |
| `reconcile` | the pure reconciliation step |
| `ReconcileInput` | type: what reconciliation reads |
| `RestateCacheState` | type: the cache that is never a fact |
| `DurableStepContext` | type: the SDK context, narrowed to `run`/`rand`/`date` |
| `LedgerLike` | type: the ledger surface this edge needs |
| `startEndpoint` | start the SDK endpoint |
| `EndpointHandle` | type: the running endpoint |
| `StartEndpointOptions` | type: how the endpoint is started |
| `deriveInvocation` | derive the durable invocation for a step |
| `submitAdvance` | submit an advance through the ingress and wait for it |
| `SubmitResult` | type: what a blocking submission returns |
| `sendAdvance` | submit an advance without waiting for it |
| `SendResult` | type: what a send returns — no engine identity, by shape |
| `attachAdvance` | rejoin an invocation by its derived id |
| `AttachResult` | type: what an attach returns |
| `readCacheThroughHandler` | read the cache by the same path the handler does |
| `registerDeployment` | register this deployment with the server |
| `startVerifiedServer` | start the pinned server and verify it answered |
| `serverAvailability` | is the pinned server reachable |
| `SafeServerHandle` | type: the narrowed handle — no raw child, no data root |
| `ServerExit` | type: how the server ended |

`startServer` and `ServerHandle` are absent from that list on purpose: they
carry the raw child process and the absolute data root, which the drills need
and no consumer should have.

`GateDependencies` is present, and the reason is worth stating because the
first draft of this table left it out. It is `createAcpGateWorkflow`'s own
parameter type, so a barrel that exported the factory without it would export a
function the package root cannot describe — a consumer writing a wrapper would
have to re-declare the shape by hand or deep-import, and the pin would be
asserting a set that does not match what the package offers. Its one member,
`__onGate`, is an optional announcement seam for the drills, exactly like
`__onBeat`; it carries no fact, because the gate holds no ledger and appends
nothing. Publishing the type does not make a production endpoint's use of the
seam legal — the fence asserts that the daemon calls the factory with no
argument at all.

## Two services, both servable

The edge hosts a Virtual Object and a workflow, and both factories are on the
surface. `AcpTask` walks the plan; `AcpGate` holds the durable promise that
makes `SIGNAL` real without the object ever blocking. An endpoint that
registered only the first would answer a gate release with "no such service",
which is what a `SUPPORTED` capability must not mean.

`registerDeployment` posts `force: false`, and that does not mean what it looks
like: measured against the pinned server, registering a URI the data root
already knows answers `200` with the deployment already held and runs **no
discovery**, whether the service set behind that URI is identical or different.
So a caller must not read a successful registration as proof that the engine
will route to what it just started — it has to read the reply, which enumerates
the services, and check. The daemon does exactly that and fails closed; see
`docs/architecture/0027-the-production-gate.md`.

## The pinned server

The Restate server is an external binary acquired by an explicit operator
command with a checksum, never by an install hook. The upstream server package
and the install-time telemetry beacon it pulls may never enter the dependency
graph; the fence holds that list by name and asserts their absence from the
lockfile and from every tracked file, which is why this README does not spell
them. The SDK itself is pinned exactly — a range would let a
replay-determinism fix arrive unreviewed.

## Import purity

This package may import only its own modules, `@acp/runtime`,
`@acp/contracts`, `@acp/ledger`, the Restate SDK and a named set of node
builtins. It opens exactly one listener, from one file named by the fence, and
spawns from one allow-listed site. Each of those is a fence law, not a
convention.

## Tests

`pnpm test` runs the `durability` project. The drills spawn and kill real
processes: an in-process exception would prove nothing about durability.
