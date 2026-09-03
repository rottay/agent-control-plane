# @acp/ledger

The append-only event ledger and its derived read models. This is the single
authority for control plane state, as decided in
`docs/architecture/0001-control-plane-authority.md` and detailed in
`docs/architecture/0002-sqlite-event-ledger.md`.

## Scope

**P1A is not P1 completion.** P1 also requires a minimal CLI and a local
read-only UI, and neither exists yet. Nothing in this package is adopted into
real operation: adoption is a single explicit decision that happens after P8
certification and a separate P9 authorization.

Not in this package, by design: daemon, Restate, provider adapters, accounts,
quotas, leases, CLI, UI.

## Public API

```ts
import { openLedger } from "@acp/ledger";

const ledger = openLedger("/path/to/control-plane.sqlite");

const result = ledger.append(event); // ControlPlaneEvent, validated
result.inserted; // false means it was an exact replay
result.record.sequence; // monotonic position
result.record.eventSha256; // chain digest

ledger.close();
```

| Member | Purpose |
| --- | --- |
| `openLedger(path, options?)` | Open writable or read-only. Applies missing migrations only when writable. |
| `append(event)` | Validate, canonicalize and append atomically. Exact replay is a no-op. |
| `getEvent(eventId)` | One record by event id, or null. |
| `getEventBySequence(sequence)` | One record by position, or null. |
| `getEventByIdempotencyKey(key)` | One record by idempotency key, or null. |
| `listEvents(query?)` | Sequence-ordered page. Filters: task, type, emitter, destination state. |
| `getTask(taskId)` / `listTasks(query?)` | Derived task read model, ordered by task id. |
| `getWorker(identity)` / `listWorkers(query?)` | Derived worker read model, ordered by identity. |
| `getExecutionRoute(taskId, attempt)` / `listExecutionRoutes(taskId)` | The route an attempt was admitted on, keyed by the pair. Null, or empty, when nothing recorded one. |
| `appendInitiativeEvent(event)` | The same pipeline on the initiative stream: validate, canonicalize, append. |
| `getInitiative(id)` | Derived initiative read model, or null. |
| `listRoadmapVersions(id)` | An initiative's recorded roadmap versions, in version order. |
| `listInitiativeEvents(query?)` | Sequence-ordered page of the initiative stream. |
| `decideRoadmapVersion(request)` | Pure. The caller supplies the folded head; nothing here reads a ledger. |
| `rebuildReadModel()` | Drop and replay every projection of both streams, transactionally. |
| `verifyIntegrity()` | Full report. Never throws on a finding; returns problems. |
| `status()` | Effective pragmas, applied migrations, head, counts, projections. |
| `close()` | Release the handle. |

Options are `{ readOnly?, busyTimeoutMs? }`. Pages are bounded: default 100,
maximum 1000, and cursors are exclusive.

Raw SQLite access is deliberately absent. A caller holding the connection could
bypass the append-only triggers and the hash chain, and the ledger would have no
way to notice.

### Errors

Every error is typed and carries a `code`. None of them embeds event content,
so all of them are safe to log or attach to a checkpoint.

Thirteen classes are exported, and this is the complete list — the
architecture fence asserts it against the barrel in both directions, so a
fourteenth class cannot arrive without appearing here.

| Class | Raised when |
| --- | --- |
| `LedgerError` | the base every other class below extends; never thrown on its own |
| `LedgerOpenError` | the database cannot be opened, or opening it is refused |
| `LedgerClosedError` | the handle has been released and is used again |
| `LedgerReadOnlyError` | a write is attempted through a read-only handle |
| `LedgerMigrationError` | the migration set does not apply, or disagrees with the recorded one |
| `LedgerValidationError` | an event fails its contract |
| `LedgerCanonicalizationError` | an event cannot be canonicalized deterministically |
| `LedgerIdempotencyConflictError` | an idempotency key is reused with different content |
| `LedgerEventIdConflictError` | an event id is reused with different content |
| `LedgerLifecycleConflictError` | a transition the lifecycle does not allow |
| `LedgerSequenceError` | the sequence is not contiguous, or the chain does not link |
| `LedgerIntegrityError` | an integrity check finds the stored state inconsistent |
| `LedgerQueryError` | a query is malformed — a bad cursor, an out-of-range limit |

## Tables

| Table | Kind | Contents |
| --- | --- | --- |
| `schema_migrations` | authority | applied version, name, SHA-256, timestamp |
| `control_plane_events` | authority | the append-only log, with `previous_sha256` and `event_sha256` |
| `initiative_events` | authority | the sibling append-only stream, on its own hash chain |
| `ledger_meta` | authority | head sequence, head digest and event count, one set per stream |
| `task_read_model` | derived | current state, attempt, counts, first and last position, and the initiative the discovery named (nullable) |
| `worker_read_model` | derived | observed emitters, event and distinct task counts |
| `worker_task_read_model` | derived | emitter to task associations |
| `execution_route_read_model` | derived | the route each `(task, attempt)` was admitted on: provider, model, account, transport and the capability-policy version that chose them |
| `initiative_read_model` | derived | current status, counts, first and last position |
| `roadmap_version_read_model` | derived | the recorded versions of an initiative's roadmap, by digest |
| `projection_meta` | derived | applied-through sequence, source head digest |

Only the derived tables are ever cleared. Neither event table has a delete path
at all: each carries its own `BEFORE UPDATE` and `BEFORE DELETE` triggers, which
abort unconditionally.

The two streams share a database and the transaction discipline, and nothing
else. An initiative registration has no task and no lifecycle state, so it
cannot ride in the task stream without either a null in a NOT NULL column or an
initiative id in a field named `taskId`; it gets its own table, its own chain
and its own head instead. `rebuildReadModel()` replays both, and
`verifyIntegrity()` verifies both — each projection is checked against the head
of the stream it was built from, never the other's.

## Integrity

`verifyIntegrity()` checks SQLite integrity and foreign keys, the migration set,
the live schema shape, every stored body against its canonical form and the
contract, columns against body, the whole hash chain, sequence contiguity, head
and count metadata, projection metadata, and the stored projections against a
fresh replay.

It cannot prove the events were true when written, and it cannot detect a
coherent whole-file replacement. Both need an external anchor that P1A does not
have.

## Concurrency

WAL gives one writer and many concurrent readers. Appends serialize on the write
lock through `BEGIN IMMEDIATE`, across processes as well as within one. A writer
that exceeds the busy timeout fails rather than queueing forever. Single host
only; a network filesystem is not supported.

`better-sqlite3` is synchronous, so an append blocks the event loop for its
duration.

## Recovery

A damaged projection is repaired by `rebuildReadModel()`, which is transactional:
a failed rebuild leaves the previous projection untouched.

A damaged event stream is deliberately not repaired here. `verifyIntegrity()`
names what is wrong, and a rebuild refuses to run over an inconsistent log
rather than laundering it into a clean-looking read model. Recovering a damaged
authority is an owner decision made with evidence.

## Tests

`pnpm test` runs the suite. It uses temporary databases only, removes them in
teardown, and touches no repository path.

The concurrency tests spawn real child processes. Two handles in one event loop
would prove nothing, because `better-sqlite3` is synchronous and the calls would
simply run in sequence with the file lock never contended.

## The artifact store

The Checkpoint law says a record carries **digests and references**, never
content. A roadmap document cannot fit in an event payload and should not: the
ledger is a chain of small canonical facts. So content lives beside the
database, in a content-addressed store this package owns, and the event records
only the digest.

The store is here rather than in a caller because this package already owns the
data root and the CLI already resolves references through it. A second package
owning the bytes would be a second authority over what a digest in this ledger
means, and there would be two ways to resolve one reference.

Two laws, both about what a filesystem actually promises:

- **Publication is atomic.** Bytes are written to a temporary name in the same
  directory and renamed into place, so a reader sees a complete object or none.
  A plain write at the final path leaves a torn file after any crash — and a
  torn file whose *name is a digest* is worse than a missing one, because its
  name is a claim about content it does not have. The temporary name is derived
  from the digest rather than from a clock, so a retry after a crash overwrites
  its own partial file instead of leaving a new orphan on every attempt.
- **An existing object is verified, never trusted.** Publishing content whose
  digest already exists re-reads the stored bytes. Equal bytes are a no-op,
  which is what makes a retried write safe. Unequal bytes are refused rather
  than overwritten: replacing them would destroy the evidence of a collision or
  a corruption at the exact moment it mattered.

**There is no delete.** No function removes an object, and none is exposed that
could. An append-only ledger whose referenced bytes can disappear is
append-only in name only. Removing an artifact is a deliberate operator act
against the filesystem, outside this API.

The root is an explicit absolute path the caller supplies — no default, no
discovery, no environment read — exactly as `openLedger` takes its own.
