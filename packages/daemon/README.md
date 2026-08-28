# `@acp/daemon`

The supervised process around the durability plane.

## Scope

**This is P2D: process lifecycle, and nothing above it.** The daemon starts one
invocation under an explicitly chosen driver, supervises it, and stops cleanly
when signalled. The launchd template is P2E. There is no observation route, no
provider adapter and no product adoption.

Importing this package has **no side effects**. It parses no argv, creates no
directory, opens no database, binds no socket, spawns no child, installs no
signal handler and writes no file. Effects begin only inside `startDaemon` or
the internal child entry. A fresh-process drill proves it: a same-process
snapshot could not tell an effect that never happened from one that happened
before the check.

**P2D is not P2 completion**, and it is **no product adoption**.

## The daemon adds no authority

`packages/ledger` remains the only one. The daemon opens it and `@acp/runtime`
drives it; the edge from this package to the ledger is deliberate and the graph
stays acyclic.

The lock file and the status document are **observations**. Nothing in the
lifecycle, the modes or the singleton reads the status to make a decision, and
the architecture fence forbids the import rather than trusting the convention.
The moment a decision depends on it, it stops being an observation and becomes a
second authority that can disagree with the ledger.

## Two modes, chosen explicitly

`SQLITE_SUPERVISOR` and `RESTATE` are inputs, never inferences. There is no
auto-detection, no retry and no failover. A requested `RESTATE` whose pinned
binary is absent or unverified is a refusal; a requested `SQLITE_SUPERVISOR`
never starts a server. A silent failover would make the mode flag a lie, and an
operator would learn which driver actually ran only by reading the ledger.

`SQLITE_SUPERVISOR` binds zero sockets and spawns zero children. That is not an
incidental property: it is the mode that still works when the external server is
unavailable, so anything it needed from the network would defeat it.

## Startup order, and where readiness is

```
S1  roots validated       owner-only, verified by stat rather than requested
S2  singleton held        exclusive create; the OS arbitrates, not this process
S3  ledger open           and its integrity verified
S4  binary verified       pin, receipt and actual digest must all agree
S5  server up             the pinned server, on loopback
S6  endpoint up           127.0.0.1 only
S7  deployment registered
S8  reconciled            <- readiness is HERE
S9  ready
S10 supervising
```

Readiness is **S8, not S5**. A server that is listening but has not been
reconciled against the ledger is not ready, and calling it ready is exactly how
a derived driver quietly becomes an authority.

Acquisition order defines release order. Every resource is pushed onto an unwind
stack as it is taken and released in strict reverse, each with its own deadline,
so a failure half way through startup leaves nothing behind. The endpoint closes
before the server it is connected to — reverse order gives that for free, and it
matters in itself, because Restate holds persistent HTTP/2 sessions open and
closing them the other way round is what P2C proved will hang.

An unexpected server death after readiness is **terminal**: the status is
classified, the endpoint closes, owned resources unwind and the process exits
nonzero. It never restarts and never falls back.

## The singleton, and why the probe is asymmetric

One daemon per canonical checkout, held by an exclusively created lock file, so
two racing daemons are arbitrated by the operating system rather than by a
check-then-write in either of them. The fixed loopback ports are the machine-wide
backstop behind it: a second checkout passes its own lock and then fails the port
precheck, before readiness and without disturbing the first.

A stale lock is never silently reclaimed. Deciding whether a recorded process is
still *this* daemon is the one question here where being wrong is dangerous, so
the probe is deliberately asymmetric:

- **NOT_SAME** only when it can be proven — no such process, or a start time
  later than the one recorded, which is what a recycled pid looks like;
- **INDETERMINATE** whenever it cannot — including a start time that matches
  while the argv digest does not, and a probe that could not run at all;
- **UNSUPPORTED_PLATFORM** off Darwin.

Only `NOT_SAME` permits removal, only of the exact owned pidfile, and only with
an explicit `adoptStale` decision. **No signal is ever sent on an ambiguous
result**, because the ambiguous case is precisely the one where a signal would
land on a process that is doing its job.

Identity is recorded from `ps`, not from `process.argv`. The two are different
strings — `process.argv` is what this runtime parsed, `ps` is the operating
system's own rendering of the command line — and recording one while later
observing the other would make every live daemon look indeterminate.

## Bounds

Logs are capped three ways: total bytes, file count, and a single line. All
three are needed, and each is tested past its limit. A byte cap alone lets
rotated files accumulate; a file cap alone lets each one grow; a line cap stops
one enormous message defeating both at once.

The status document is bounded, shape-checked and written atomically. It carries
process ids deliberately — they are not secrets, and an operator or a drill
needs them to end exactly the right process instead of pattern-matching across
the machine. It carries no absolute path, payload, environment value, credential
or raw exception text, because there is nowhere in its shape for one to sit.

## Tests

The drills use real processes and real signals: SIGTERM, SIGINT, SIGKILL
followed by explicit recovery, a partial start refused on a held port, and the
external server killed by the exact pid the daemon published. A shutdown
demonstrated by calling a function in-process proves nothing, because the file
handles, the page cache and every object survive it, which is precisely what
losing a process does not do.

There is **no package `bin`** before P8. The child entry exists solely so the
drills have a real process to signal.
