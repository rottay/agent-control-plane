# ADR 0005 — The Restate driver, and what adoption would mean

- Status: Accepted
- Date: 2026-08-27
- Phase: P2C
- Deciders: `kimi/k3/coordinator/01` (DT), `claude/opus/implementer/01` (integrator)
- Audited by: `claude/fable/reviewer/01` (preaudit, ACCEPT_WITH_CORRECTIONS)
- Supersedes: nothing
- Refines: `docs/architecture/0004-durability-and-supervisor.md`
- Authority: `docs/ROADMAP.md`

## Scope, stated first

This ADR covers the Restate driver: the Virtual Object, the reconciler, the
loopback endpoint, the deterministic submitter, and the external server pin.

**P2C is not P2 completion.** The daemon and the `launchd` template are P2D, and
no observation route exposes any of this. P2C is also **no product adoption**:
nothing here observes, connects to or is used by any real operation, and there
is **no partial cutover**. Adoption still happens once, after P8 certification
and under a separate P9 authorisation.

## Context

ADR 0001 made Restate conditional: it may run durable execution, but it is
derived, and it is adopted only if it passes the P2 drills. ADR 0004 fixed the
recovery law and the determinism rules. What neither settled is how a second
driver can exist without quietly becoming a second authority, which is the only
interesting question here.

## Decision

### 1. One core, journaled three times

P2B put the beats inside `SqliteSupervisor` as private methods. That was fine
with one driver and wrong with two: the Restate handler must wrap each durable
step in its own `ctx.run`, and a method that fuses "append the intent" with
"perform the effect" cannot be journaled as two entries. Fusing them would make
the crash-between-effect-and-outcome case unreachable — the only case the whole
three-beat law exists for.

The beats therefore live in `packages/runtime/src/core/step-executor.ts`, and
both drivers walk them. The supervisor delegates with byte-identical behaviour;
the extraction is gated on its existing suite passing unchanged.

### 2. The handler walks a fixed sequence and never branches on an unjournaled read

The object handler walks the plan from index 0 every time. It does not read the
ledger to decide what to do next, because control flow that branches on an
unjournaled read diverges on replay: the journal is matched by entry order, and
a different order is a different execution. Idempotent appends make the already
done steps free — each returns `inserted: false` — so a fixed walk costs nothing
and removes the whole class of divergence.

Each `ctx.run` returns the smallest canonical value that describes what
happened, `{ inserted, sequence }`. Never an event, never a buffer, never
anything whose JSON encoding could differ between the first execution and a
replay.

### 3. Object state is a cache, and deleting it proves it

The object holds exactly one key, `acpCache`, carrying
`{ lastAppliedSequence, lastAppliedEventSha256 }`. Both are copies of values the
ledger already holds. `ctx.stateKeys()` returning anything else is itself a
finding.

The load-bearing evidence is D3: stop the server, delete the entire Restate data
root, restart, resubmit. The ledger's event count and head digest are unchanged
and the effect marker count stays 1. Restate's durable state can be destroyed in
full without losing anything, which is what "derived" has to mean if it means
anything.

### 4. Reconciliation runs first, and fails closed

The handler reconciles **before** the continuity guard and before any probe,
effect or append. A non-resumable verdict becomes a `TerminalError` with zero
ledger and zero marker delta.

Five verdicts, first match wins: an unreadable head or a failed integrity check
or a cache read that throws is `INDETERMINATE`; an absent cache is
`DRIVER_BEHIND`, because absence is the reconstructible case; agreement is
`CONSISTENT`; a cache behind a corroborated position is `DRIVER_BEHIND`; a cache
ahead of the head is `DRIVER_AHEAD`; a cache disagreeing at the same position is
`DIVERGED`. Exactly two verdicts permit resuming -- `CONSISTENT` and
`DRIVER_BEHIND` -- and the contract enforces that rather than the algorithm:
`safeToResume` is forced by `superRefine` to equal
membership in `RESUMABLE_VERDICTS`, so a mis-set flag is a parse failure at the
source instead of a wrong answer downstream.

**There is no merge policy.** A merge is how a second log becomes authoritative.

`DRIVER_AHEAD` and `DIVERGED` are unreachable in a correct run — a cache of two
ledger-derived fields cannot outrun the ledger — so the tests reach them by
injecting state directly. A drill that produces either without injection is an
adoption-blocking defect, not a flaky test.

The cache is read through a **shared object handler**, never through admin
introspection. Admin is a mutation surface; reconciliation is a read.

### 5. The SDK cannot bind loopback, so the endpoint is ours

In `dist/endpoint/node_endpoint.js`, `NodeEndpoint.listen(port)` calls
`server.listen(actualPort)` with **no host argument**, and `ServeOptions` has no
host field anywhere. ADR 0004 pins `127.0.0.1:9080` and requires the drills to
prove no non-loopback listener exists, so `serve()` and `endpoint().listen()`
are both unusable here.

`restate-endpoint.ts` is the only file permitted to import `node:http2`. It uses
the documented remedy — `createEndpointHandler` plus a server we own — and
listens with an explicit `{ host, port }`. `server.address()` is asserted to be
an object at `127.0.0.1`, because it returns a string for a unix socket and null
when nothing is bound, and either would mean the pin was not honoured. The fence
enforces both halves: the file must contain the loopback host, and must not
match a bare `serve(` or `.listen(<number>`.

Teardown is bounded. `http2.Server.close()` waits for every session to end and
Restate holds persistent sessions, so an unbounded close never resolves and
whatever cleanup follows it never runs. Sessions are tracked and destroyed, with
a deadline, and drills stop the server **before** closing the endpoint.

### 6. Submission assigns identity, once, before ingress

`invocationId` is `deterministicUuid("invocation/" + taskId + "/" + attempt)`,
derived before the request and sent as the HTTP `idempotency-key`. A
resubmission after a crash reuses the identity rather than minting a new one,
which is what makes a retry a replay. The handler reads no clock and no random
source: every coordinate is `DERIVED`, exactly as the supervisor's are.

Submission uses global `fetch`. `@restatedev/restate-sdk-clients` is not
installed and adding it is not authorised, and a global costs no import
allowance, so the runtime dependency surface stays exactly what P2A froze.

### 7. The server is an external pinned binary, and the redirect boundary is explicit

`@restatedev/restate-server` depends on `@scarf/scarf`, whose postinstall is a
network beacon, so the server is not an npm dependency. It is acquired by an
explicit operator command that verifies a tracked SHA-256 before extraction.
No Docker: `@restatedev/restate-sdk-testcontainers` stays out of the graph,
because a drill that only passes under a container runtime proves nothing about
the deployment it is meant to de-risk.

The pin establishes **two** digests: the archive's and the extracted binary's.
Pinning the archive alone was not enough. The binary that actually runs is the
one that matters, and with no tracked digest for it the installed binary could
only be compared against the `binarySha256` in its own verification receipt —
which is circular, because a substituted binary would travel with a receipt
describing itself.

The receipt is therefore **not** the authority. The tracked pin is. On every
availability check the receipt is bound to the pin field by field — version,
platform, asset, url, archive digest, binary digest — *and*, independently, the
installed binary is re-hashed and required to equal the pin's `binarySha256`.
Both must hold. The receipt's only remaining job is to record what was fetched;
it can no longer vouch for anything on its own. The comparison helper takes the
tracked entry as a required argument with no default, so a caller cannot fall
back to self-attestation by omitting it, and the fence parses the pin to refuse
a file that establishes only one of the two digests.

The pinned GitHub asset URL legitimately redirects to GitHub's release CDN, so a
blanket redirect refusal would refuse the real download. The boundary is
therefore explicit rather than absolute: the first request must be the exact
pinned URL, and exactly one HTTPS hop to exactly `release-assets.githubusercontent.com`
is permitted, with no credentials and no second hop. The tracked digest remains
the content authority; a mismatch unlinks everything and fails closed.

### 8. `RestateDriver.advance` keeps the claim-check law

The frozen one-step method checks the caller's claimed state against the ledger
before anything leaves the process, exactly as the supervisor does, and then
refuses: the object handler owns the walk, and a second advancement path is how
two implementations come to disagree. The handler never calls it.

Both drivers' `advance` are `async`, so a refused claim is a rejection rather
than a synchronous throw from a promise-returning method.

### 9. `DriverStatus.dataRoot` is the drills root, for both drivers

Both report `.acp-local/drills`, because that is genuinely the root everything
they write lives under. `restate-data` stays the name of the per-scenario
subdirectory. No scenario id and no absolute path crosses the boundary, and no
public contract changed: `packages/contracts/` is untouched by P2C.

## Cancellation is an out-of-band engine call plus a ledger settlement, and deliberately not a third handler (V2-B2-4b)

Decision 1 fixed the Virtual Object as the shape of this driver, and decisions
2 and 3 fixed what may live in it. Cancellation is the first verb that has to
be reconciled against all three, because the obvious design — a `cancel`
handler on the object — contradicts every one of them.

**It cannot be a handler, and the reason is the property B2-3 certified.**
`advance` is `handlers.object.exclusive`, so while a walk holds the key nothing
else runs on that key. A domain-level cancel handler would therefore **queue
behind the very walk it was meant to interrupt**, which makes it useless
against a walk that is retrying — the case cancellation exists for.
`createAcpTaskObject` keeps its two handlers, and no `RESTATE_HANDLER_CANCEL`
constant exists.

**So cancellation is three ordered acts, and the order is the content.**

1. **Refuse a terminal task, before the engine and before the ledger.** The
   ledger will not catch this: `Ledger.append` enforces continuity — the
   event's `fromState` must equal the row's current state — and says nothing
   about terminality. A `TASK_CANCELLED` declaring `fromState: "CHECKPOINTED"`
   matches the row and *would be accepted*, quietly appending a cancellation
   after a completed task. The guard is the driver's, and the drill measures
   the driver rather than the ledger's manners.
2. **Stop the engine, out of band.** The admin API cancels by an invocation id
   Restate minted, which on its own would have inverted decision 6: the ledger
   would depend on an address the engine owns. It does not, because the ingress
   resolves that id on demand. Measured against the pinned binary, `POST
   /restate/lookup` answers `{"invocationId": "inv_..."}` for
   `(service, key, handler, idempotencyKey)` alone — every one of which this
   side already holds, the last being `deriveInvocation`'s output. The id is a
   local constant inside one function, and the function's return type has no
   member it could occupy, so it is never returned, stored, logged, appended or
   projected. `404` and `409` are treated as success here: both mean the engine
   is not running this invocation, which is the postcondition this act exists
   to reach. Anything else throws, before the ledger is touched.
3. **Settle the ledger, probe-first.** The three-verdict discipline of decision
   3's recovery law, unchanged: `DONE` closes the open intent — the OUTCOME is
   appended *before* the cancellation — `NOT_DONE` appends one cancellation,
   and `UNKNOWN` **appends nothing** and refuses, leaving the intent open for
   an operator exactly as `PostconditionUnknownError` does. It does not call
   `closeIntent`, because that function's `NOT_DONE` branch performs the
   effect: a cancellation that repaired a missing effect would be doing the
   work it was asked to abandon.

**Engine before ledger, never the reverse.** If the ledger were settled first,
the still-running invocation could append its own next beat between the two
acts and the log would carry a cancellation followed by progress. Cancelling
first makes the settlement the last write. The residual window — engine
stopped, ledger not yet settled — is safe and self-healing: it leaves an open
intent, which is the state `reconcile` classifies without guessing, and the
drill kills a real process in exactly that window to show it.

**The event is not a `PlanStep`, and could not be.** `PlanStep.toState` is a
`LifecycleState`; `CANCELLED` is an `ExceptionalState`. `buildEvent` therefore
cannot express a cancellation, and widening `PlanStep` would break the plan
module's own law that every `toState` comes from the frozen `LIFECYCLE_STATES`.
The precedent followed instead is `switch-executor`, which builds a
`ControlPlaneEvent` directly from `deriveEventCoordinate` over the full
`TaskState` union. The settlement policy lives in `@acp/runtime`, not here, for
the reason decision 1 gives: one core, both drivers.

**Mid-beat preemption is deferred, and both routes to it are refused with
reasons.** A cancellation flag in `RestateCacheState` is forbidden without an
ADR by decision 3's own law, and would be a fact the ledger does not hold — a
second authority. A *shared* cancel handler that appended while the exclusive
walk also appended would put two concurrent ledger writers on one task,
destroying the per-task serialization ADR 0004 records. So a cancellation takes
effect **between beats, not inside one**, and this record says so rather than
leaving a reader to assume it is instantaneous.

**The SQLite supervisor still declares `CANCEL: UNSUPPORTED`,** and its source
is untouched. The asymmetry is the same one ADR 0004 records for per-task
serialization: the capability declaration carries the difference so a caller
can read it rather than discover it.

## Waiting is a dedicated workflow, and the timer is the engine's own schedule (V2-B2-5)

The last two verbs stop being refusals here. They are recorded together because
they were decided together, and because the reasoning that separates them is the
same reasoning in both cases: put the durable thing where the engine already
keeps durable things, and keep it out of `AcpTask`.

### TIMER is a delayed send, not a sleep in the walk

`timer(invocation, delayMs)` issues one nonblocking send to the object's own
`advance` handler with `?delay=<ISO8601>`, under the derived invocation id as
the idempotency key — the same target and the same key `sendAdvance` already
uses. The engine holds the schedule, so the timer survives the death of the
process that set it and the death of the server that accepted it.

`ctx.sleep` inside `advance` was rejected. The port method is called from
outside a handler and could not reach one; and adding a wait to the fixed walk
would change the journal entry order every existing drill counts, for a wait
nothing asked for. The determinism law is unchanged: the duration is a caller
value, never a clock read, and it reaches no ledger event — so it is neither
`DERIVED`, `SUBMISSION` nor `JOURNALED`, and it enters the coordinate
vocabulary nowhere.

**The client-side validation is load-bearing, and that is a measured claim.**
The pinned server does not police the parameter it accepts: `?delay=3s` answers
`202 Accepted` with an `executionTime` of the current instant, so a malformed
duration silently becomes no delay at all and a timer nobody set is
indistinguishable from one that already fired. The parameter *is* understood —
on a blocking call it is refused by name, `400 "cannot use the delay query
parameter with calls. The delay is supported only with sends"`. Understood on
sends, unvalidated on sends, therefore validated here, before the URL is built,
at a cost of zero engine calls.

### SIGNAL is a named durable promise on a dedicated `AcpGate` workflow

`signal(invocation)` performs exactly one ingress POST to
`/AcpGate/{invocation.invocationId}/resolve`. The workflow key IS
`deriveInvocation`'s output for `(taskId, attempt)`. There is no
`/restate/lookup`, no admin call and no journal read, so — unlike `cancel`, which
must still resolve an engine id transiently — this path never learns an
engine-minted identifier at all. `SignalResult` is exactly `{ok, status}`.

`run` awaits `ctx.promise(GATE)`; `resolve` is a **shared** handler that
resolves the same named promise, so releasing never queues behind the wait it is
releasing.

**Why not an awakeable inside `AcpTask`.** That was the first design and it was
rejected on evidence, not taste:

- *A signal arriving first would be permanently lost.* An awakeable identifier
  does not exist until the handler has executed to that journal command. In
  production the resolver and the waiter are independent processes and their
  order is not ours to guarantee, so that is a race, not an edge case. A named
  durable promise has no such window: it is engine state keyed by the workflow
  key, and a release that arrives first simply completes it. The drill is S0,
  and the awakeable design structurally cannot pass it.
- *It would have depended on engine introspection internals.* Recovering the
  identifier meant reading admin `/invocations/{id}/journal/{idx}/metadata` or
  the `sys_journal` table — operational surfaces that version separately from
  ingress. This repository already refuses to CONSTRUCT an address from a format
  it cannot check; reading one out of an engine journal is the same refusal.
- *The discovery would have been a heuristic.* "Scan a bounded index range and
  accept exactly one awakeable entry" couples SIGNAL to the shape of the fixed
  walk, and every future plan step moves the range — silently.
- *It would have blocked `AcpTask`.* An exclusive `wait` holds the object key
  for the whole wait, so `advance` for that task would queue behind an
  unresolved gate. The per-task serialization certified at V2-B2-3 would become
  indistinguishable from a deadlock.

Registering an engine-minted identifier in object state or in the ledger is
rejected **permanently**, not held as a fallback: it contradicts the
`RestateCacheState` law and creates a second authority.

### What the gate deliberately does not do

It appends nothing. It holds no ledger and is handed none, so it could not
append if it wanted to — `GateDependencies` carries one optional announcement
seam and nothing else. Waiting is not a lifecycle transition: the ledger records
what a task DID, and a task that paused did nothing. Inventing a `TASK_WAITING`
event would have added a lifecycle state, a transition, a module and a mirrored
suite for a fact no caller needs, so both verbs answer with the bare
`{ ok: true }` that `DriverAccepted` already sanctions for a verb observing no
ledger position.

`AcpTask` is untouched by this packet — no handler added, none changed — which
is why the cancellation and serialization drills are re-run **unmodified** as
preservation assertions rather than rewritten.

### Idempotency, and one correction the engine made

`signal()` sends the derived invocation id as the idempotency key, so calling
the verb twice is the SAME call: the engine replays its first answer and reports
success. A caller retrying after a timeout therefore gets a truthful `ok`
instead of a spurious conflict, and the gate is still released exactly once. A
genuinely distinct second request — one without the key — is refused with
`409 "promise was already completed"`, and the driver does not launder that into
success: only a caller holding the ledger may decide what a second signal means.

The drill for this originally asserted the opposite and the engine corrected it;
the assertion now records what was measured.

Workflow `run` submissions carry **no** idempotency-key header, because the
engine refuses one there — a workflow handler is already idempotent by its key.
The derived id is still the authority; it is carried as the workflow key rather
than as a header.

### Two homes for the Restate names, named rather than fixed

`RESTATE_WORKFLOW_GATE`, `RESTATE_HANDLER_GATE_RUN`,
`RESTATE_HANDLER_GATE_RESOLVE` and `RESTATE_GATE_PROMISE` are declared
edge-local in `packages/edges/durability/src/contracts/index.ts`, while the
pre-existing `RESTATE_*` constants still live in
`packages/domains/runtime/src/constants/index.ts` — split residue from before
P8-T G5 moved this edge out of the domain. Edge-local is the smaller change and
the more correct home, since a domain package should not name an engine's
services. Unifying the two is owed work and is deliberately not this packet's.

`StartEndpointOptions.services` widened from Virtual Objects alone to admit
workflows. The SDK always accepted both; the narrowing was this repository's,
made when an object was the only thing there was to host.

## Adoption criterion, stated so it can fail

RESTATE is adopted only if D1 passes 3/3, D2–D5 pass, and the head digest after
a Restate run is byte-identical to the supervisor's for the same
`DurableInvocation` — measured across **two independent ledgers**, with a
control proving the comparison can discriminate. A second driver replaying an
already-complete ledger matches vacuously and proves nothing.

Anything less and `SQLITE_SUPERVISOR` becomes permanent, which costs nothing
about authority: switching modes changes who advances the machine and nothing
about where the truth lives.

## Consequences

Positive:

- one beat implementation, journaled by one driver and called directly by the
  other, so the two cannot drift;
- Restate's entire durable state is provably disposable;
- the loopback pin is enforced by the fence, not by a habit;
- no install-time beacon, no Docker, no new npm dependency.

Negative, and accepted:

- the endpoint is hand-built because the SDK's helper cannot bind loopback, so a
  future SDK change has to be re-checked against F1 rather than assumed fixed;
- the drills need an external binary an operator must fetch;
- the fixed walk re-appends every earlier step on every delivery. At eleven
  steps that is free; at a thousand it would not be, and a later phase that
  needs a longer plan must revisit it deliberately rather than by adding a
  branch on an unjournaled read.

## Compliance

`scripts/check-architecture.mjs` verifies that this document still states the
decision, that the P2C write-set is exact, that `node:http2` appears only in the
endpoint file, that the endpoint pins loopback and calls neither `serve()` nor a
numeric `listen`, that no production module reaches the server handle, that the
forbidden package names appear nowhere outside the ADRs and the fence, and that
the acquisition script guards its network call behind an entry-point check.

For V2-B2-4b it additionally pins both drivers' capability declarations by
equality, so `CANCEL` cannot move without the packet and the drill that earn
it, and pins `SendResult` and `CancelResult` to exactly `{ok, status}` — the
fence half of "no engine-minted invocation id leaves this edge", stated as a
shape rather than as a scan because a shape cannot be forgotten.

For V2-B2-5 it additionally widens that identity law to loop over
`SendResult`, `CancelResult`, `TimerResult` and `SignalResult` in one place —
one loop rather than four copies, because copies are how the four would come to
disagree about what "exactly two members" means — and pins that the gate's
`resolve` handler is registered SHARED and that `AcpTask`'s handler set is
unchanged. A shared `resolve` matters structurally: an exclusive one would
queue behind the very `run` it exists to release, and an added `AcpTask` handler
is exactly how waiting would creep back into the object whose exclusivity B2-3
certified.

P2D adds the daemon and the `launchd` template.
