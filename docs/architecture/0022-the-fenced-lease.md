# ADR 0022 — The fenced lease: one daemon writes into one worktree, and a stalled holder finds out

- Status: accepted (V2 concurrency C2, recorded 2026-09-04). Supersedes: none.
  Superseded-by: none.

## Context

ADR 0021 added an arbitration store: one record per worktree, one decision at a
time under `BEGIN IMMEDIATE`. It deliberately shipped with no production caller.

`@acp/runtime` had the other half already. `acquireLease`, `renewLease` and
`revokeLease` are pure folds over a caller-supplied live set — correct, tested,
and unable to arbitrate anything on their own, because a pure function has no
lock. The store cannot decide and the rules cannot exclude.

Two further facts shaped what composing them had to look like.

The first is that a **TTL alone bounds nothing**. A holder that stalls past its
expiry and then resumes still believes it holds the worktree, while a successor
has already taken it. The overlap is unbounded, and neither process can detect
it, because each one's own view is internally consistent.

The second is that the plane's three components **order instants differently**.
The store compares `expires_at <= ?`, which SQLite evaluates as TEXT — lexical
bytes. The runtime compares parsed instants. The contract's `Timestamp` permits
offsets. They agree only while every string has one spelling.

## Decision

`packages/entrypoints/daemon/src/arbiter/index.ts` composes the rules with the
store, and `daemon/src/index.ts` holds exactly one lease for the worktree it is
about to write into, in **both** durability modes, before either one starts.

The daemon is where this lives because it is the only component that imports
both `@acp/runtime` and `@acp/ledger`, and the only consumer. A port in
`@acp/contracts` would be a third party to a conversation with two
participants.

**The rules are unchanged.** `decide` maps the store row to the live set,
calls the existing pure function, and maps its outcome back to a
`LeaseDecision`. `runtime/src/enforcement/index.ts` is outside this packet's
write-set, so an edit there is a hard failure rather than a permitted silence.

**The fence bounds overlap.** Every grant bumps a monotonic counter; every
renewal re-reads the row and compares. A moved fence means this walk lost the
lease, and the daemon is told within one renewal interval — a third of the TTL,
so two consecutive missed beats still precede expiry. Overlap ends in a
classified abort instead of in two writers.

**The unwind order is the packet.** The lease resource is pushed onto the
unwind stack **before** the agent harness. The stack unwinds in reverse, so
provider children are reaped *before* the worktree is released. Fence law
`L-C-2b` pins it by source order, and the drill observes it at runtime in the
daemon's own log.

**The arbiter is the only producer of these instants, and it emits one form** —
canonical UTC, `YYYY-MM-DDTHH:MM:SS.sssZ`, at all four seams: `acquiredAt`,
`expiresAt`, the release stamp and the sweep boundary. It refuses a value that
is not an instant rather than coercing it.

Identifiers are derived, never minted: `leaseId` is
`deterministicUuid("lease/" + worktreePath + "/" + fence)`, so a grant whose
record is flushed twice **inside one process** produces the same event and the
ledger refuses the duplicate as an exact replay. Across a crash it is not a
replay at all — see Consequences.

Fence laws: `L-C-2a` (the daemon opens the store, acquires before either mode,
registers a release, renews), `L-C-2b` (the push order above), `L-C-2c` (no
daemon source conditions acquisition on a mode, engine or driver capability).

## Why a driver capability was not chosen

The tempting shortcut is that Restate mode already serializes, so a lease is
redundant there.

It is false in a specific way. `DRIVER_CAPABILITY_PROPERTIES` is
`["SERIALIZED_PER_TASK"]`, and Restate serializes per **task key** — one Virtual
Object per task id. Two *different* tasks writing into one worktree are two keys
and run concurrently. SQLite mode declares the property `UNSUPPORTED` and says
nothing about worktrees either.

So the lease is mandatory in **both** modes, no capability property moves, and
`L-C-2c` makes it mechanically impossible to make acquisition depend on which
engine is running. This is recorded because *"Restate serializes, so this path
needs no lease"* is true-sounding, false, and exactly the sentence a future
packet would look to a record to confirm.

## Why a TTL without a fence was not chosen

A TTL is necessary — a holder that dies without releasing must not lock a
worktree forever — and it is not sufficient. Expiry is a statement about
*wall-clock time*, and the danger is a holder whose own clock never told it
anything was wrong.

The fence converts an undetectable overlap into a detected one. It costs one
integer column and one comparison per renewal, and it is the difference between
"the lease expired, and both processes kept writing" and "the lease expired, the
successor took it, and the loser aborted".

## Why the instant form is pinned at the producer rather than in the store

The alternative was a format guard inside C1's `requireGrant`, which would make
the property structural: the store would refuse a non-canonical instant from any
future caller.

It was not chosen **now** for two reasons. C1 is committed, and amending a
landed module is a re-authorization rather than a composition. And the store is
deliberately a substrate that owns no semantics — `requireText` guards emptiness
and nothing else, by design — while the caller that owns the semantics is this
one, and today it is the only one.

The trade is real and is recorded rather than hidden: the guarantee currently
rests on one producer being disciplined, not on the store being strict. **When a
second caller appears, the guard belongs in the store**, and this paragraph is
the reason a future reader will find for moving it.

## Why the reclaim is recorded, and why the probe fails closed

Two mechanisms free a worktree: expiry, which always works and is slow; and a
liveness probe, which is fast and only sometimes works. The probe is a
**shortcut, never a substitute** — if it cannot prove the holder is gone, the
successor waits for expiry.

It fails closed for the same reason `recoverStaleLock` does. A wrong "still
alive" refuses a start that should have succeeded, which is annoying. A wrong
"dead" hands a worktree to a second writer, which is the thing this record
exists to prevent. So only a proof of absence — the process is gone, or its
start token no longer matches the recorded one — permits a reclaim; an
unavailable operating system is not a proof of death.

The probe uses the two facts the store actually carries, `holder_pid` and
`holder_token`, and deliberately passes no placeholder `argvDigest`: that field
only separates `INDETERMINATE` from `SAME_LIVE_DAEMON`, and both refuse.

**Every reclaim writes `LEASE_REVOKED` with its cause**, `EXPIRED` or
`HOLDER_DEAD`. A worktree that changed hands silently would leave a ledger in
which two acquisitions appear and nothing explains the gap. The event is written
by the successor rather than by `revokeLease`, because that function answers
"may this holder revoke its live lease" — a question an expired record fails by
construction, and a reclaim is a different act.

## Consequences

- **A refused acquisition stops the walk before it starts**, and the refusal
  carries the pure rule's own word at the pure rule's own field.
- **The lease record is written before the ledger event.** The walk is what
  opens a task, and an event appended before it would create the task row and
  make the walk resume at step 1, never writing its own `TASK_DISCOVERED`. So
  the arbiter holds its events and appends them at every moment the ledger can
  accept them.
- **That window is not crash-idempotent, and the ledger is lopsided if a
  process dies inside it.** The queue is in memory. In-process, a repeated flush
  is an exact replay and `append` refuses the duplicate. But a daemon that dies
  after the grant and before the task exists never flushes again: a successor
  finds the dead holder, reclaims at the next fence, and writes a
  `LEASE_REVOKED` naming a lease no `LEASE_ACQUIRED` ever recorded. That
  revocation is the surviving evidence of the lost holder, and the store row is
  the operational fact throughout, so no worktree is stranded — but a reader
  folding the ledger alone will see a revocation without its acquisition, and
  should read it as exactly that. Closing the gap means persisting the queue or
  appending inside the same transaction as the grant, and neither is in this
  record.
- **A dead holder costs one TTL** where the probe cannot prove death.
- **The renewal heartbeat is a timer in the daemon**, unreferenced so it never
  keeps the process alive, and stopped before the release so a beat cannot
  re-extend a lease that was just given up.
- **Two daemons on one checkout are still refused by the singleton**, earlier
  and for a different reason. The lease answers a question the singleton cannot:
  does somebody *else's* checkout hold this worktree.

## Not in this record

- N concurrent walks against distinct worktrees — C3.
- Write-set conformance enforced against a held lease — C4.
- A single production control-plane ledger, and where it lives.
- Cross-checkout and cross-machine arbitration: the store excludes processes
  sharing a filesystem, and nothing beyond that.
- A canonical-instant guard inside the store — see above; it is owed when a
  second producer appears.
- A crash-idempotency drill for the grant-to-append window. The brief asked for
  one; it is **not delivered**, and the paragraph above states the behaviour it
  would have measured rather than leaving the gap to be discovered.
- Dynamic submission and any form of product cutover. P9 remains deferred.
