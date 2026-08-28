# ADR 0006 — Daemon process lifecycle

- Status: accepted for P2D
- Date: 2026-08-27
- Supersedes nothing. Extends ADR 0001 (ledger authority), ADR 0004
  (durability and supervisor) and ADR 0005 (Restate driver).

## Scope, stated first

P2D adds a supervised process and nothing above it. No launchd path, no
observation route, no provider adapter, no installation and no cutover.
**P2D is not P2 completion**, and it is **no product adoption**.

## Context

P2C left the repository with two working drivers and no way to run either
outside a test. A durable plane that only executes under Vitest is not a plane;
it is a fixture. P2D supplies the process that runs one, and stops.

## Decision

### 1. A dedicated package, not a folder in the runtime

The daemon is `@acp/daemon` in `packages/daemon`. `@acp/runtime` stays an
import-safe durability library and gains no process lifecycle.

The boundary is not cosmetic. Process lifecycle means pidfiles, signal handlers,
spawning and log rotation — every one of which is a side effect, and all of
which would sit in a package whose central promise is that importing it has
none. Keeping them apart means the promise stays checkable.

The daemon consumes only the public `@acp/runtime` entry point; deep imports are
refused by the fence. The dependency edge from the daemon to the ledger is
**deliberate**: the daemon opens the sole authority and the runtime drives it.
The graph remains acyclic — `@acp/daemon` → `@acp/runtime` → `@acp/ledger` →
`@acp/contracts`.

### 2. The daemon adds no authority

The ledger stays the only one. The lock file and the status document are
**observations**, and the fence forbids the lifecycle, the modes and the
singleton from importing the status module at all. A convention that says "do
not read this" is a convention; an import that cannot compile is a boundary.

### 3. Both drivers, selected explicitly

`SQLITE_SUPERVISOR` and `RESTATE` are explicit inputs. No auto-detection, no
retry, no failover. A requested `RESTATE` with an absent or invalid pin fails
closed; a requested `SQLITE_SUPERVISOR` never starts a server.

A SQLite-only daemon was rejected: P2C passed the adoption drills, so leaving
the selected durable driver unusable outside tests would not satisfy P2. Silent
failover was rejected for a different reason — it would make the mode flag a
lie, and an operator would discover which driver actually ran only by reading
the ledger afterwards.

### 4. Readiness is reconciliation, not a listening socket

The Restate order is fixed: validate roots, acquire the singleton, open and
verify the ledger, verify the pinned binary, start the server, start the
loopback endpoint, register the deployment, **reconcile**, and only then declare
readiness and accept the invocation.

Readiness sits after reconciliation because a server that is up but has not
agreed with the ledger is not ready. Declaring readiness at "the socket is
listening" is the precise mistake that lets a derived driver behave as an
authority for the window between the two.

### 5. Acquisition order defines release order

Every resource is pushed onto an unwind stack as it is acquired and released in
strict reverse, each release bounded by its own deadline and none permitted to
abort the others. A failure at any state releases exactly what was taken.

The ordering is load-bearing beyond tidiness: the endpoint must close before the
server, because Restate holds persistent HTTP/2 sessions and P2C proved that
closing them in the other order never resolves.

An unexpected server death after readiness is **terminal**. The status becomes a
classified code, the endpoint closes, owned resources unwind and the process
exits nonzero. Never a restart, never a failover.

### 6. Imports have no side effects, proven in a fresh process

Importing any daemon module must not parse argv, create a directory, open a
database, bind a socket, spawn a child, install a signal handler or write a
file. The drill runs a **new process** that imports the built entry point and
reports what exists afterwards.

A same-process snapshot would not do. It cannot distinguish an effect that never
happened from one that happened before the check, and under a test runner
something has always happened first.

### 7. The singleton is per checkout; ports are the machine-wide backstop

The lock is an exclusively created file, so the operating system arbitrates
rather than a check-then-write. A second live daemon refuses without touching
the first.

Stated accurately: the pidfile is scoped to **one canonical checkout**. A second
checkout would pass its own lock and then collide on the pinned loopback ports,
which the precheck turns into a classified refusal **before readiness**, with a
clean unwind and no cross-talk. Ports are the machine-wide guarantee; the
pidfile is the per-checkout one.

A stale lock is never silently reclaimed. Recovery requires an explicit action
and may remove only the exact owned pidfile, after a fail-closed identity probe
proves the recorded process is not the same live daemon.

### 8. The identity probe is asymmetric, and never signals

Darwin process inspection runs absolute `/bin/ps` through `execFile` with fixed
argv, `LC_ALL=C` pinned, no shell, and both a time and an output bound. It sits
behind an injectable interface so all four verdicts are testable without
spawning anything.

The asymmetry is the design. `NOT_SAME` is returned only when provable — the
process is gone, or its start time is later than the one recorded, which is what
a recycled pid looks like. A start time that matches while the argv digest does
not is `INDETERMINATE`, not `NOT_SAME`, because it could be a rendering
difference or a different program and both are reasons to leave the lock alone.
A probe that cannot run is `INDETERMINATE`. Off Darwin it is
`UNSUPPORTED_PLATFORM`.

**No signal is sent and nothing is removed on an ambiguous result.** A wrong
"yes" refuses a start that should have succeeded, which is annoying. A wrong
"no" evicts a live daemon, which corrupts the thing the lock exists to protect.

Identity is recorded from `ps` rather than `process.argv`: the two render the
command line differently, and recording one while observing the other would
classify every live daemon as indeterminate.

### 9. The status document is bounded, redacted and observational

Written atomically by write-then-rename, shape-checked before it reaches disk,
and capped in size. It may carry the daemon pid and the Restate child pid —
**process ids are not secrets**, and an operator or a drill needs them to end
exactly the right process rather than pattern-matching across the machine. It
may not carry absolute paths, payloads, environment, credentials or raw
exception text, and its shape leaves nowhere for one to sit.

### 10. Logs bind three ways

Total bytes, file count, and a single line. Each is necessary: bytes alone let
rotated files accumulate, file count alone lets each grow without limit, and a
line cap stops one enormous message defeating both in a single write. Rotation
is a rename, which is atomic within a directory. Each cap is tested past its
limit rather than argued for.

### 11. No public executable before P8

`packages/daemon/package.json` declares no `bin`. The internal child entry
exists solely so the drills can signal a real process, it accepts a validated
JSON argument rather than reading the environment, and it takes a **scenario
identifier** rather than a filesystem path, so a caller cannot name a directory.

## Consequences

`packages/runtime/src/restate/server-handle.ts` is promoted from test-only to
public, because the daemon must start the pinned server and duplicating the
spawner would create two implementations that drift. The promotion is paid for
in the same change: the public handle exposes no child process, no stdio and no
absolute data root, the entry points take the opaque `ScenarioRoot` rather than
a string, stop is bounded with escalation, and exits are classified rather than
carrying raw stderr. There remains exactly one Restate spawner in the
repository, and exactly one other permitted subprocess site — the identity
probe — each allow-listed by path and purpose.

Two projects now bind the pinned ports, so they are serialised with respect to
each other by `sequence.groupOrder`. P2D also found that `fileParallelism: false`
declared inside a project is not honoured, which had left the runtime project's
files running in parallel over a shared root since P2B;
`poolOptions.forks.singleFork` is the control that does bind, and both projects
now set it.

## Compliance

The architecture fence asserts the package boundary, the absence of deep
imports, the two purpose-bound subprocess sites, the forbidden network builtins,
the absence of a `bin`, the entry-point guard, and that lifecycle code never
imports the status observation. Stale prose that a later phase has falsified is
caught by an expired-literal table rather than left to a reader to notice.
