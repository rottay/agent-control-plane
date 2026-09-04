# ADR 0027 — The production endpoint hosts every service the driver declares

- Status: accepted (V2-B2-5G, recorded 2026-09-04).
- Supersedes: none.
- Superseded-by: none.

## Context

V2-B2-5 landed the durable gate whole. `AcpGate` is a dedicated Restate
workflow with a named durable promise; its `resolve` handler is SHARED so
releasing never queues behind the `run` it releases; `RestateDriver.signal`
reaches it with one request addressed by the invocation id this side derives
before ingress; the capability declaration says `SIGNAL: "SUPPORTED"`; and six
drills measure it against the pinned server, including the case the rejected
awakeable design structurally could not pass.

Every one of those drills registered the gate through
`packages/edges/durability/src/drivers/restate-child/index.ts` — the drill
child. `startRestateMode`, which is the only endpoint an operator can start,
registered `createAcpTaskObject` and nothing else. `createAcpGateWorkflow` was
not on the `@acp/durability` barrel at all, so the daemon could not have
registered it without a deep import the daemon's own import law forbids.

The consequence is exact and it is worth stating without softening. The plane
declared a capability that its assembled form could not honour: a release
through the daemon's ingress reached no such service. ADR 0016 says a driver
declares what it cannot do so a caller can discover it without trying; a
`SUPPORTED` that only a fixture honours inverts that — it is wrong in the
direction a caller acts on, and it was invisible to every test in the
repository, because the drills that proved the gate were measuring a service
the assembled system did not host.

That gap is the general defect V2 exists to correct — a library with fixtures
and no assembled consumer — appearing in the one place it is hardest to see:
the fixture was more complete than the product.

## Decision

**A capability declaration is a claim about the assembled system, and the
endpoint an operator starts must host every service the declaration depends
on.** Concretely:

`createAcpGateWorkflow` and its parameter type `GateDependencies` join
`@acp/durability`'s closed export surface, pinned by equality against both the
barrel and the README table. The type joins because it is the factory's own
parameter: an exported function whose parameter type the package root cannot
name has a surface the pin cannot describe, and a consumer writing a wrapper
would have to re-declare the shape by hand or deep-import. Publishing it grants
nothing — its one member is the drills' optional `__onGate` announcement seam,
and the gate holds no ledger and appends nothing.

`startRestateMode` registers the gate beside the object, **with no argument**.
Hosted beside, never inside: waiting inside the exclusive `advance` handler
would hold the task key for the whole wait, so `advance` for that task would
queue behind an unresolved gate and the per-task serialization V2-B2-3
certified would be indistinguishable from a deadlock.

Two gates enforce it. `L-B25G-1` in `scripts/check-architecture.mjs` — "the
production endpoint hosts both services" — parses the `startEndpoint` call and
is driven over four cases, three of them negative: a dropped gate, a dropped
object, and a gate handed a dependency. And
`packages/entrypoints/daemon/test/drills/lifecycle/index.test.ts` measures the
behaviour against a real pinned server, through `startRestateMode` itself: a
gate held on that endpoint releases exactly once and appends nothing, a repeated
release leaves the head unchanged in both fields, a durable timer survives the
server's `SIGKILL` and a restart on the same data root, scheduling the same walk
twice is one walk, `SQLITE_SUPERVISOR` still refuses all four verbs with zero
capability mismatch, no engine-minted identity reaches any surface, refusal or
thrown message, and a daemon started on a data root whose registration does not
serve the gate refuses instead of coming up without one.

The registration half of that last drill is not a detail; it is a second
invariant this record closes, and it has its own section below.

The law is the cheap half and the drill is the expensive one, and both are kept:
the law tells a reader editing the service list immediately, and the drill is
what would actually have caught the original defect.

## Registering is not being routable, and S7 now proves the second

`registerDeployment` posts `{ uri, force: false }`. This packet's brief stated
that a data root already holding a registration would therefore answer `409` and
that `startRestateMode` would fail closed on it. **That is not what the pinned
server does**, and the true behaviour is the more dangerous of the two, so it is
recorded here and then closed rather than left as an observation.

Measured against `restate-server` 1.7.7, both cases asserted by the drill:

- Killing the server and restarting it on the **same data root**, then
  re-registering the identical service set, answers **`200`** and returns the
  **same deployment id**. A restart on the daemon's own root is idempotent and
  starts.
- Closing that endpoint, binding a **narrowed** one on the same URI — the task
  object alone, exactly what this endpoint served before this packet — and
  registering again also answers **`200` with the same deployment id**, and the
  admin registry still lists **both** services. No discovery ran.

So `force: false` means *do not replace*: it reports success while doing
nothing. A successful registration proves that a registration exists, not that
it describes the endpoint that just started.

**The hazard, stated plainly.** A Restate data root registered by a build that
served only `AcpTask` keeps serving only `AcpTask`. Without a check, a daemon
from *this* build restarted against such a root would register "successfully",
reach `RECONCILED`, declare `SIGNAL: "SUPPORTED"` — and have no gate. That is
exactly the defect the rest of this record closes, resurrected by a stale root.

**So it is a closed invariant, not an observation.** S7 has two acts. Act 1
registers and refuses a non-2xx, as before. Act 2 reads the reply — which is the
engine's own account of what it will route — compares it against
`REGISTERED_SERVICES`, the literal naming every service this mode hosts, and
throws `StartupError` naming any the engine will not route.
`DEPLOYMENT_REGISTERED` is announced only after that comparison, because a phase
published before the check would tell a status reader the deployment was good
while the daemon was still deciding.

Three gates hold it, and each fails differently:

- `L-B25G-2` pins all four properties — the reply is read, it is compared, a
  missing service fails closed, and the phase follows the comparison — driven
  over four cases, three of them negative.
- `L-B25G-1` pins `REGISTERED_SERVICES` against the services actually passed to
  `startEndpoint`, in both directions. A name the endpoint does not host would
  refuse every startup; a hosted service the literal omits would let the very
  divergence act 2 exists to catch through unnoticed.
- The drill prepares a data root the way an older build would have left it — a
  registration naming only `AcpTask`, asserted to name only that — shuts
  everything down, and starts this build's `startRestateMode` on it. It refuses
  with `StartupError`, the message names `AcpGate` and no engine identity, the
  published phases stop at `ENDPOINT_UP`, nothing is appended, and the unwind
  releases the endpoint and the server in reverse.

**`force: true` was rejected.** It would let a daemon silently overwrite a
registration whose service list this process has not compared, which is the same
class of untruth in the other direction. An operator who means to replace a
registration can do it deliberately; a daemon should not do it on the way past.

**No migration is claimed, and none is needed.** P9 is unauthorized and no
partial cutover is permitted (AGENTS.md law 8), so every Restate data root this
repository has ever written is a disposable scenario root under `.acp-local`,
created and removed by the drills that make it. There is no stale root in
existence to meet — which is why the invariant is closed now, before there is
one, rather than after an operator finds it.

## Why exporting only the factory was not chosen

The first draft of this packet put `createAcpGateWorkflow` on the barrel and
held `GateDependencies` back, on the reasoning that the type's only member is a
test seam and that a narrower surface is a better surface.

The pre-audit rejected it and was right. The type is already structurally
reachable through the factory's signature, so withholding it narrows nothing —
it only makes the surface undeclarable. `DURABILITY_PUBLIC_EXPORTS` would have
been asserting, by equality in both directions, a set that did not describe what
the package offers, which is worse than a slightly wider pin: it is a pin that
lies. The honest form is to export both and say plainly what the type is for,
which is what the barrel comment and the README now do.

## Why a fence law alone was not chosen

A law that parses the `startEndpoint` call is cheap, runs in a second, and would
have caught this. It is not sufficient on its own, because it proves the source
mentions a factory and not that the ingress serves the workflow: a registration
that failed at runtime, a workflow whose name did not match the address the
driver builds, or a server that rejected the deployment would all pass it.

The drill is what closes that, and it is why the drill starts a real pinned
server rather than a fake: the assertion is that a release travelling over
loopback reaches a handler and returns `{"released":true}`. Both are kept
because they fail differently, and the cheap one is not a substitute for the
one that measures.

## Why the drills were not added to the durability package

The obvious home is beside the six gate drills that already exist. It was
rejected because those drills are exactly the ones that could not see this
defect: they register the gate themselves through the drill child, so a drill
added there would prove the gate works when the drill hosts it — which was never
in doubt — and would be blind to the endpoint the daemon actually starts.

A drill belongs where the thing it measures is assembled. The daemon package is
where `startRestateMode` lives, so that is where a claim about what the daemon
serves is measured. The six existing drills are untouched by this packet.

## Consequences

The daemon's endpoint now hosts two services, so its startup surface is one
service wider and the deployment it registers describes both. A restart against
the daemon's own data root is idempotent and starts. A restart against a data
root registered by an older, narrower build **refuses**, naming the service the
engine will not route. That is a real operational limitation and it is the
intended one: a daemon that cannot honour what it declares should not reach
readiness. The cost is that adopting a new service onto an existing root becomes
an explicit operator act rather than something that happens quietly, and the
packet that decides what that act looks like is named above as not-yet-existing
rather than assumed away.

`@acp/durability`'s public surface moves from twenty-six names to twenty-eight.
Every future service this edge learns to host inherits the obligation this
record creates: the factory reaches the barrel, the endpoint registers it, the
law is extended, and a drill measures it through the assembled path. A packet
that declares a capability without doing all four is declaring something the
product cannot honour.

The daemon drill suite grows by one file that starts a real server, so the
daemon project costs more wall clock. That is the price of measuring the
assembled system rather than a fixture, and this record exists because the
cheaper alternative already failed once.

## Not in this record

How a driver's capability declaration is *published* to a caller over the API or
the CLI — there is no such door, and adding one is its own packet.

Whether the gate should ever be reachable from a route rather than only from the
driver. Nothing outside `RestateDriver` releases a gate today, and a door is
where authority is granted; bundling one with the service it opens would put
both behind a single review.

The unification of the `RESTATE_*` constants' two homes, named as owed work in
`packages/edges/durability/src/contracts/index.ts` and still owed.

Any change to the gate's own semantics. `restate-driver/index.ts`,
`submit/index.ts`, the edge's contracts and the six V2-B2-5 drills are untouched
by this packet, and this record makes no claim about them beyond the one
V2-B2-5 already established.
