# `@acp/runtime`

The durability and supervisor plane of the Agent Control Plane.

## Scope

**P2D built one shared lifecycle engine and both of its drivers**, **P6A adds
the writer-enforcement core**, and **P6B adds the conflict graph.** The
`SQLITE_SUPERVISOR` and the `RESTATE`
driver walk the same plan over the append-only ledger and recover from real
process kills. Enforcement adds leases, write-set conformance and prestate
verification as pure functions over injected values: one writer per worktree,
an exact write-set scanned tracked-and-untracked, and a violation that revokes
the lease and quarantines the worktree rather than cleaning it. Process
lifecycle now lives in `@acp/daemon`, which drives this package. There is no
`launchd` template and no observation route yet.

P6A admits at most one live holder **per worktree**, and makes no
cross-worktree claim: whether two worktrees may be written in parallel is the
conflict graph's decision, which is P6B's gate applied before acquire. The
enforcement core computes no conflict check of its own; the conflict-graph
module computes the complete one, over task envelopes, before any lease is
taken. Revocation is the caller folding the
lease out of the set it passes in — derived from `LEASE_ACQUIRED` and
`LEASE_REVOKED` in the ledger, which is the authority — because the engine
holds no state of its own.

The enforcement core observes nothing itself. Its read-only git port is a type
naming the four verbs an observer may ever speak — `status`, `diff`,
`ls-files`, `rev-parse` — so a mutation verb is unrepresentable; no
implementation of it exists in this package, and no production source here
imports a process module. Wiring a real observer is a separate authorized
packet.

Importing this package has **no side effects**. It binds no socket, starts no
listener, spawns no process and creates no directory. Filesystem work happens
only inside an explicitly invoked drill, under a root this package resolves for
itself. The architecture fence asserts both.

This is **no product adoption**. Nothing here is connected to, observed from or
used by any real operation.

## One core, two drivers

`src/core/lifecycle/index.ts` holds the single plan. The supervisor and the
Restate
driver both walk it. Neither encodes a transition of its own: two copies of a
state machine drift, and the drift is only ever discovered when the two disagree
about a recovery.

The supervisor holds **no cursor**. Every decision about what to do next is read
back out of the ledger, which is what makes "the ledger is the authority" true
rather than aspirational. `RUNNING` is the one ambiguous state, because both the
intent and its outcome land there; the tie is broken by asking the ledger
whether the outcome event exists, which is evidence rather than memory.

## The laws frozen here

### Authority

`packages/ledger` is the sole application authority. Restate is a **derived**
driver whose state may be deleted and reconstructed from the ledger. The SQLite
supervisor is not a degraded path: it is a first-class alternate driver over the
same core. It was the predetermined default had the Restate drills failed; they
passed, so the driver is now an explicit choice the daemon is given rather than
a fallback it works out for itself.

The `OrchestrationDriver` interface deliberately has no method that reads state
back from a driver in order to make a decision. That is how a derived
orchestrator becomes an authority in practice while a document still claims it
is derived.

### Recovery order

Ledger-first **intent**, then an idempotent and probeable **effect**, then a
ledger-verified **outcome**. A completion fact is never appended before the
effect has happened: an append is a claim, and a claim written early is a lie
the log cannot retract.

A crash after the effect but before the outcome append is closed by a
deterministic postcondition probe. A probe that returns `UNKNOWN` fails closed
and leaves an unclosed intent for an operator; it is never guessed in either
direction.

### Replay determinism

Every event and operation coordinate must come from one of exactly three
places: pure derivation over durable invocation inputs, the submission payload
captured before ingress, or a journaled durable step. Never from a clock, a
random source or mutable environment — in any code that can replay, whether it
sits inside `ctx.run` or outside it.

This is not fastidiousness. The ledger treats *same idempotency key, different
canonical bytes* as a typed conflict and fails closed, and the Restate SDK
documents that "there is a small window where an action may be re-run, if a
failure occurred between a successful run and persisting the result." A
coordinate built from `Date.now()` in that window comes back different, and a
benign replay becomes a hard conflict at the exact moment recovery is running.

### Loopback and data roots

Every address is loopback and constant: Restate ingress `127.0.0.1:8080`, admin
`127.0.0.1:9070`, this service `127.0.0.1:9080`. The observation API (7517) and
UI (5178) are unchanged and restated only so port collisions are provable.

Data roots are repository-relative, git-ignored segments — never captured
absolute paths, which name a home directory, a user account and a machine
layout.

### The drill boundary

The runtime does **not** accept a target directory. It accepts a scenario
identifier and resolves it, itself, under `.acp-local/drills/`. A caller cannot
name a path, so a caller cannot name someone else's path. The identifier
grammar admits no dot and no separator, so no traversal segment can be spelled
at all, and containment is checked twice: once on the resolved string and once
through `realpathSync`, because those differ the moment a symlink is involved.

The toy effect is a single atomic marker write keyed by operation id. Re-running
it writes identical bytes; a marker with *different* content is never
overwritten, because that is somebody else's write and replacing it would
destroy the only evidence that something unexpected happened.

## External tools

`@restatedev/restate-sdk` is pinned at `1.16.9` and is a normal dependency; its
whole graph is itself plus one core package, and neither declares an install
script.

The Restate **server** `1.7.7` is deliberately **not** an npm dependency. The
`@restatedev/restate-server` package depends on `@scarf/scarf`, whose
`postinstall` is a network beacon, and this repository's install policy exists
precisely so nothing phones home while being installed. The server is acquired
as an external pinned binary under `.acp-local/tools/` by an explicit operator
command — never by an install hook. **Two** digests are pinned, the archive's
and the extracted binary's, and the pin is the authority rather than the
receipt: the receipt is bound to the pin field by field, and the installed
binary is independently re-hashed against the pin's own digest. Pinning only the
archive would have left the binary attested by nothing but the receipt that
travels with it.

## Tests

`pnpm test` runs the `runtime` project. For the supervisor it includes three
kill/restart drills against fresh, owned toy roots: killed after the intent,
after the effect, and after the outcome. For Restate it adds D1 through D5, a
final leak sweep, a cross-driver equivalence check and the acquisition-boundary
negatives. The children are real processes terminated with `SIGKILL`. An
exception caught in-process would prove nothing, because the page cache, the
open database handle and every object survive a thrown error, which is exactly
what a crash does not leave behind.

Each drill asserts the same things after restart: final state `CHECKPOINTED`,
the effect applied exactly once, `verifyIntegrity().ok`, no duplicate
idempotency keys, a third run that moves neither the event count nor the chain
head, and rebuilt projections equal to the live ones.
