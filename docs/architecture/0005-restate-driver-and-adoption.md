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

P2D adds the daemon and the `launchd` template.
