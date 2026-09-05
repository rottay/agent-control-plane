# ADR 0033 — The daemon records what it spawned, so recovery can prove what to stop

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

A `RESTATE`-mode daemon spawns `restate-server` as an undetached child in its
own process group, with no reaper. The only thing that stops it is the unwind
resource on the graceful path. A `SIGKILL` runs no unwind, so the server
outlives the daemon, keeps the reserved loopback ports, and the next daemon
refuses to start — `refusing to start: loopback port(s) already in use`. There
is a recorded incident of exactly this orphan class.

Recovery had the pid the whole time and declined to look at it. The status
document has carried `serverPid` since the daemon first published one, and a
drill already asserted it survives a terminal exit; `recoverStaleLock` read only
the pidfile, probed the *daemon's* identity, unlinked on `NOT_SAME`, and
signalled nothing.

A pid alone is not enough to act on, which is why declining was reasonable
rather than lazy. Pids are reused. Signalling one because a dead daemon once
wrote it down is how a recovery tool kills a stranger.

## Decision

The daemon records the **identity** of the server it spawned — pid, process
start token and argv digest — at the instant the pid first exists, and explicit
recovery verifies that identity before it stops anything. **No identity, no
signal.**

**Capture at `SERVER_UP`, not at `READY`.** The pid arrives in the `SERVER_UP`
callback; the endpoint, the deployment registration and the reconciliation all
follow before startup returns. Capturing at `READY` would leave a daemon killed
*during registration* — the window most like the recorded incident — with a
`serverPid` and no identity, which the matrix below answers by refusing to
signal. So `onPhase`'s return widened from `void` to `void | Promise<void>` and
`SERVER_UP` is awaited. No other phase awaits and no phase moved, so the
published order is unchanged.

That widening has a third consequence worth recording, because it is not
obvious: TypeScript lets a function returning anything satisfy a `=> void`
parameter, and that exemption applies only when the target return type is
*exactly* `void`. Widening to the union withdrew it, so two expression-bodied
callbacks in a drill file (`onPhase: (phase) => phases.push(phase)`) became type
errors. They are now statement-bodied. It is a type-only touch in a file this
packet otherwise has no business in.

**Recorded, never recomputed.** The identity is asked of `ps`, both when
recording and when verifying. The repository already stated why: `process.argv`
is what the runtime parsed and `ps` is the operating system's rendering, and
they differ outright under a test runner or any launcher that re-executes.
Recording one and observing the other would make every live server look
indeterminate.

**A `ps` failure at capture refuses the start.** The stack already holds the
server resource, so the unwind stops what was spawned, and `ps` is already a
startup dependency one phase earlier. The alternative — catching to a null
identity — is lawful and would degrade to the migration row, but it would make a
daemon that cannot see its own machine start anyway.

**Atomic identity fields.** `serverPid`, `serverStartToken` and
`serverArgvDigest` are all null or all set. A pid without an identity proves
nothing about the process now holding it; an identity without a pid names
nothing to probe. A half-identity is a malformed document rather than a partial
one, so recovery never has to decide what half a proof means.

**Reaping is bound to `adoptStale`.** It runs only inside `recoverStaleLock`
under an explicit decision, reached in production only through
`recoverOwnStaleLock`. No bin flag, config field or launchd template passes it,
so **a launchd restart cannot reap**. A daemon starting normally signals nothing
it did not spawn.

### The verdict matrix

| Condition | Action |
| --- | --- |
| no identity forwarded (absent, malformed, pre-packet, half, or `SQLITE_SUPERVISOR`) | reclaim the lock only; never signal |
| the observation's own pid is not the lock's pid | reclaim the lock only; report `STATUS_NOT_OWNER`; never signal |
| identity probes `NOT_SAME` | nothing to reap; reclaim; report `ABSENT` |
| identity probes `INDETERMINATE` / `UNSUPPORTED_PLATFORM` | refuse to signal, **reclaim nothing**, report the indeterminacy |
| identity probes `SAME_LIVE_DAEMON` | `SIGTERM` → deadline → **re-probe** → `SIGKILL` only on a second match → confirm ports |

The indeterminate row reclaims nothing on purpose. Removing the lock there would
invite the next daemon to start against a machine that may still be holding the
ports by a process nobody could identify — and the port check would refuse it
anyway, with the lock gone and less evidence than before.

**The re-probe is the difference between this and `ServerHandle.stop()`.**
`stop()` could not be reused: it closes over a live `ChildProcess` and recovery
holds only a pid. Its discipline — `SIGTERM`, a bounded deadline, then
`SIGKILL` — is reproduced with one addition it does not need and this does. A
pid freed by a graceful exit can be recycled inside the deadline, so the
identity is proved **twice**: once before the `SIGTERM` and again before any
`SIGKILL`. An unguarded escalation is exactly the harm the indeterminate row
exists to prevent.

**A held port after a successful kill is reported, not returned as success.**
`assertReservedPortsFree` throws; inside recovery the throw is the report, so it
is caught and carried as `PORTS_STILL_HELD`.

## Why the status law was kept rather than exempted

An existing fence law forbids `lifecycle`, `singleton`, `mode-sqlite` and
`mode-restate` from importing the status module: *"The status document is an
observation. The moment a decision reads it, it becomes a second authority that
can disagree with the ledger."* The obvious implementation — having
`recoverStaleLock` read the status — is precisely what that law forbids, and the
fence refused it.

Exempting `singleton` was rejected. It would turn a law stated as a principle
into a list of exceptions, and the exception would be the exact case the
principle names.

Instead the observation is read where reading it is already lawful — the
top-level entry point, which reads it for other reasons — and crosses into the
decision as a **closed value** the decision cannot re-read, re-interpret or ask
for more of. The entry point performs no comparison and no probe; it lifts a
validated observation into a struct. So there is one reader of the pidfile, one
reader of the status, and one decider, and the decider consumes a value rather
than consulting a source. The law is unweakened and no fence edit was needed.

The ownership binding stays inside `singleton`, where the lock record is parsed:
the comparison is made against a value that module read itself rather than one
it was handed.

## Why `assertReservedPortsFree` was not softened

It is correct. A daemon that silently moved ports would pass its own drills and
then not be where anything expects it. The fix removes the orphan *before* the
check runs; it never lowers the check. After a successful reap the ports are
free and the next daemon starts, which is the headline claim and is drilled with
`checkPorts: true` against a real second daemon.

## Why the server stays undetached

The graceful unwind depends on it, and that path is the common one. Detaching
the server into its own process group would make every ordinary shutdown a
reaping problem in order to fix the exceptional one.

## `SAME_LIVE_DAEMON` applied to a server pid

The probe returns `SAME_LIVE_DAEMON`, and this record applies it to a server.
The comparison is correct — the function compares a recorded triple against live
`ps` facts and knows nothing about roles — but the literal says *daemon*. It is
reused unchanged and named here so a reader is not misled. Renaming it would
touch the lock path, the arbiter and their suites, which is a different packet.

## Consequences

**Widening the status key set invalidates every pre-packet status document**,
and that direction is correct. `validateStatus` refuses an unexpected key set,
so a document written by an older binary fails validation, `readStatusFrom`
returns null, and recovery reclaims the lock and signals nothing. A binary that
never recorded a server's identity cannot vouch for one.

**`RecoveryResult` grew fields, not a name.** `reaped` and `serverExit` are new
fields on an already-pinned public type, and `STATUS_NOT_OWNER` joins its verdict
union. A new exported *name* would have moved a fence pin; fields move nothing.

**`SQLITE_SUPERVISOR` is byte-identical.** It spawns no server, writes three
nulls, and reaches the no-identity row.

## Not in this record

- **The spawn-before-`SERVER_UP` window.** A daemon killed between `spawn` and
  the callback never learned a pid, so nothing can prove the server. This case
  remains manual, and the runbook's `ps` check stays for exactly it.
- **PID collision.** A recycled pid whose start second *and* argv both match is
  not distinguishable. What makes it remote is that the argv contains the
  scenario's own config path.
- **Detaching the server**, renaming `SAME_LIVE_DAEMON`, and softening the port
  check — each excluded above.
- **Whether the production `RESTATE` walk should route through
  `OrchestrationDriver`.** It calls the ingress directly and constructs no
  driver, unlike `SQLITE_SUPERVISOR`. That is a real question and a candidate for
  a later packet; folding it in here would be scope improvisation.
