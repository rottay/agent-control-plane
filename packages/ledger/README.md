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

`LedgerOpenError`, `LedgerClosedError`, `LedgerReadOnlyError`,
`LedgerMigrationError`, `LedgerValidationError`, `LedgerCanonicalizationError`,
`LedgerIdempotencyConflictError`, `LedgerEventIdConflictError`,
`LedgerLifecycleConflictError`, `LedgerSequenceError`, `LedgerIntegrityError`,
`LedgerQueryError`.

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
