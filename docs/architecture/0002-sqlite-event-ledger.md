# ADR 0002 — The SQLite event ledger

- Status: Accepted
- Date: 2026-08-27
- Phase: P1A
- Deciders: `kimi/k3/coordinator/01` (DT), `claude/opus/implementer/01` (integrator)
- Audited by: `claude/fable/reviewer/01`
- Supersedes: nothing
- Refines: `docs/architecture/0001-control-plane-authority.md`
- Authority: `docs/ROADMAP.md`

## Scope, stated first

This ADR covers `packages/ledger` only. It is the P1A slice of P1.

**P1A is not P1 completion.** P1 also requires a minimal CLI and a local
read-only UI, and neither exists yet. P1A is also **no product adoption**: the
ledger is not used by, connected to, or observed from any real operation, and
nothing here changes the rule that adoption happens once, after P8 certification
and a separate P9 authorization.

There is no daemon, no Restate integration, no provider adapter, no account or
quota handling, and no lease engine in this package.

## Context

ADR 0001 decided *where* authority lives: an append-only event log owned by the
application, with everything else derived from it. It did not decide how that
log resists being wrong.

That gap matters more than it first appears. An append-only table is only
append-only if something enforces it. A derived read model is only derived if a
rebuild actually reproduces it. A replayed durable step is only idempotent if
the log can tell a replay from a new fact. Each of those is a claim, and a claim
that cannot be checked is indistinguishable from a claim that is false.

## Decision

### 1. One SQLite file, with the schema under checksum

The ledger is a single SQLite file. Schema changes are an ordered, numbered
migration set, and each migration records the SHA-256 of its own SQL text in
`schema_migrations`.

On every open, the applied set is compared against the set this build defines,
position by position, on version, name and checksum. Missing, extra, reordered
and mismatched are distinguished, because only one of them is recoverable: a
writable handle may apply a missing tail, and everything else fails closed.

Migration source is immutable. A shipped migration is never edited; a schema
change is a new version appended to the end. Editing one would make every
existing ledger refuse to open, which is the correct outcome rather than an
inconvenience to be worked around.

### 2. Append-only is enforced by the database, not by convention

`control_plane_events` carries `BEFORE UPDATE` and `BEFORE DELETE` triggers that
abort unconditionally. The package exposes no raw connection, no statement
handle and no escape hatch, so the only way to change history is to go around
the library entirely.

Because the checksums prove only what was applied, and dropping a trigger
leaves `schema_migrations` untouched, `verifyIntegrity()` additionally asserts
that every table, index and trigger the migrations created is still present and
that nothing else has been added.

### 3. Canonical JSON and a hash chain

Each event is stored as canonical JSON: keys in ascending code unit order, and
any value that JSON cannot round-trip losslessly is rejected rather than
coerced. `undefined`, array holes, non-finite numbers, negative zero, bigint,
symbols, accessors, non-enumerable properties, exotic prototypes and cycles all
fail with a typed error.

This is not fastidiousness. `JSON.stringify` silently turns a hole into `null`,
a `Date` into a string and an `undefined` member into nothing at all. A hash
chain computed over silently rewritten bytes proves nothing about what the
caller actually appended.

Each row then records

```
event_sha256 = sha256(previous_sha256 + LF + canonical_event_json)
```

with a genesis previous digest of sixty-four zeroes. Altering any earlier event
invalidates every digest after it, so tampering cannot be local.

### 4. Idempotency is a first-class outcome, not an error

`append()` runs one `BEGIN IMMEDIATE` transaction and distinguishes three cases:

- the idempotency key is present and the canonical bytes are identical: this is
  an exact replay. Nothing is written, and the original record is returned with
  `inserted: false`. This is what makes a durable step safe to retry;
- the same key is present with different bytes: a typed conflict, fail closed;
- the same `eventId` under a different key: a typed conflict, fail closed.

`BEGIN IMMEDIATE` rather than a deferred transaction is deliberate: the write
lock is taken at the start, so concurrent writers serialize instead of doing
optimistic work and discovering at commit that they hold a snapshot they cannot
upgrade.

### 5. Lifecycle preconditions are checked against the projection

A first event for a task must declare `fromState: null`. Every later event must
declare the state the task is actually in. A writer working from a stale view
therefore cannot append a transition computed against a state the task has
already left.

### 6. Read models are derived, and provably so

`task_read_model` and `worker_read_model` are projections. The worker projection
is built from observed `emittedBy` identities, so it can never claim a worker
the ledger has no evidence for.

There is exactly one implementation of what an event does to a projection, and
both the incremental path and the full replay use it. Writing those twice is how
a live projection and a rebuild drift apart, and the drift is only ever
discovered by the rebuild silently producing a different answer.

Projections contain no clock reading. Every timestamp comes from the event that
produced it, so a projection is a pure function of the event stream and two
rebuilds of the same ledger cannot differ.

### 7. Failure is atomic, including projection failure

The event insert, the projection update and the head metadata update are one
transaction. If projection fails, the event does not survive. If a rebuild
fails, the previous projection is still there: a control plane that loses its
read model during a repair is worse off than one that never attempted it.

A rebuild refuses outright when the head metadata disagrees with the actual
tail. Rebuilding a truncated log would produce a clean-looking read model over a
history that is missing events, which is precisely the failure this package
exists to make impossible.

## Integrity boundaries

`verifyIntegrity()` reports rather than throws, because an operator needs the
whole list of what is wrong, not the first thing. It covers SQLite integrity and
foreign keys, the migration set, the live schema shape, every stored body
against its canonical form and against the contract, the agreement between
columns and body, the full hash chain, sequence contiguity, head and count
metadata, projection metadata, and the stored projections against a fresh
replay.

What it does not and cannot prove:

- that the events were true when they were written. It proves the log has not
  changed since, not that a worker reported honestly;
- that a whole-file replacement did not occur. Someone who replaces the file and
  its metadata coherently produces a self-consistent ledger. Detecting that
  needs an external anchor, which P1A does not have;
- anything about a database opened outside this package.

## SQLite concurrency limits, stated plainly

WAL allows one writer and many concurrent readers. It does not make the ledger
concurrent in any deeper sense:

- concurrent `append()` calls serialize on the write lock. Throughput is one
  append at a time, per file, across all processes;
- a writer that exceeds the busy timeout fails rather than queueing forever, and
  the bound is deliberate so a stuck writer cannot hang a reader;
- the ledger is single-host by design. Two machines over a network filesystem is
  not supported and would need a new ADR, not a configuration change;
- `better-sqlite3` is synchronous, so an append blocks the event loop for its
  duration. Bounded and acceptable at control-plane volumes, not at product
  volumes.

## Recovery

A corrupted projection is repaired with `rebuildReadModel()` and costs nothing
but time; it is the reason projections hold no fact that is not already in the
events.

A corrupted event stream is not repairable by this package, and deliberately so.
`verifyIntegrity()` names what is wrong and the ledger refuses to rebuild over
it. Recovering a damaged authority is an owner decision made with evidence, not
something a library should do automatically at open time.

## Consequences

Positive:

- append-only is enforced by the database and re-verified on demand;
- an exact replay is free and a conflicting one is impossible;
- the read model is disposable, which makes projection bugs cheap;
- the whole authority is one file the owner can copy, inspect and back up.

Negative, and accepted:

- one native dependency, `better-sqlite3`, is now in the graph. It is the only
  name on the install-time build allow-list and the fence asserts that;
- every append costs a canonicalization, a hash and a projection write;
- verification is O(n) over the whole log, so it is an operator action rather
  than something to run on every open;
- the log grows without bound. Compaction, if ever needed, is a separate
  decision and must preserve replay equivalence.

## Compliance

`scripts/check-architecture.mjs` verifies that this document still states the
decision, that the native build allow-list names exactly one package, that the
ledger dependency surface is exactly what was authorized, and that no file
outside the authority documents references the product environment.

P1 is complete: the CLI and the read-only UI read this ledger through the
observation contract, and neither can write to it. P2 runs the Restate drills
that decide whether the conditional orchestrator is adopted or the
single-process fallback becomes permanent.
