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
| `append(event, causation?)` | Validate, canonicalize and append atomically. Exact replay is a no-op. The optional reference is resolved, not merely stored. |
| `appendBatch(events, causations?)` | The task stream only. One or more events, one transaction: rows, projections, head and watermarks commit together or not at all. Added beside `append`, which is unchanged. The references, when given, are one per event. |
| `getEvent(eventId)` | One record by event id, or null. |
| `getEventBySequence(sequence)` | One record by position, or null. |
| `getEventByIdempotencyKey(key)` | One record by idempotency key, or null. |
| `listEvents(query?)` | Sequence-ordered page. Filters: task, type, emitter, destination state. |
| `getTask(taskId)` / `listTasks(query?)` | Derived task read model, ordered by task id. |
| `getWorker(identity)` / `listWorkers(query?)` | Derived worker read model, ordered by identity. |
| `getExecutionRoute(taskId, attempt)` / `listExecutionRoutes(taskId)` | The route an attempt was admitted on, keyed by the pair. Null, or empty, when nothing recorded one. |
| `appendInitiativeEvent(event, causation?)` | The same pipeline on the initiative stream: validate, canonicalize, append. |
| `appendRegistryEvent(document, causation?)` | The same pipeline on the registry stream: one version of one configuration document, on its own chain. A unit door; there is no registry batch. |
| `getInitiative(id)` | Derived initiative read model, or null. |
| `listRoadmapVersions(id)` | An initiative's recorded roadmap versions, in version order. |
| `listInitiativeEvents(query?)` | Sequence-ordered page of the initiative stream. |
| `decideRoadmapVersion(request)` | Pure. The caller supplies the folded head; nothing here reads a ledger. |
| `rebuildReadModel()` | Drop and replay every projection of both streams, transactionally. |
| `verifyIntegrity()` | Full report. Never throws on a finding; returns problems. |
| `status()` | Effective pragmas, applied migrations, head, counts, projections, this file's identity. |
| `identity()` | Which file this is and which restore of it. A read; works read-only. |
| `recordRestore()` | Record that this file is the product of a formal restore. Writes a fresh random restore id before any later append. |
| `close()` | Release the handle. |
| `envelopeSha256(value)` | Pure. The revision identity of a task envelope; parses before it hashes. |
| `envelopeIdentityPreimageV1(value)` | Pure. The bytes that digest is taken over. |

Options are `{ readOnly?, busyTimeoutMs? }`. Pages are bounded: default 100,
maximum 1000, and cursors are exclusive.

### Typed causality

Two streams' sequences are not comparable, so "this happened because of that"
cannot be said by ordering. It is said by a triple — which stream, which
position in it, and the digest of the event found there:

```ts
const cause = ledger.appendInitiativeEvent(registration);

ledger.append(discovery, {
  stream: "initiative_events",
  sequence: cause.record.sequence,
  sha256: cause.record.eventSha256,
});
```

Every record carries `causation`, a `CausationRef` or `null`. Omitting the
argument is the ordinary case: the first event of a chain, or one an owner
action outside the system provoked.

The digest is the whole point. A reference whose digest is not the referenced
event's own is refused as an **invalid reference**, not recorded as a weak link,
and so is one naming a position no row occupies. Both refusals are a
`LedgerValidationError` from the door, and the same rules are carried underneath
by a `BEFORE INSERT` trigger per stream, so reaching past the door with raw SQL
does not get a caller a triple the door would have refused. The trigger is where
the contract's `ck_<table>__causation_pair` and the 64-hex digest shape live,
because SQLite cannot add a `CHECK` to a table that already exists and an applied
migration is never rewritten.

**Only the streams with a hash chain may be named** — three of the contract's
four. `registry_events` joined them in P-09/log-C, which is the packet that gave
that stream a chain; the widening is a `DROP TRIGGER` and a `CREATE TRIGGER`
under the same names in migration 9, because migration 8's text is immutable by
checksum and every ledger in the field compares it on every open.

`account_events` is still refused as a value of `causation_stream`. It has no
`event_sha256` at all, so a reference naming it could be believed but never
checked, and widening the vocabulary to four belongs to the packet that gives it
a digest.

A retry under the same idempotency key is still a silent no-op only when the
reference matches too. The triple is not part of `event_json`, so a comparison
of bodies alone would answer `inserted: false` to a caller claiming a different
cause; the discrepancy is a `LedgerIdempotencyConflictError`, as any other reuse
of one key for two different appends is.

Two things this does **not** give you, stated because the alternative is to let
a reader assume them:

- **The triple is outside the hash chain.** `event_sha256` is computed over the
  canonical event body alone and cannot be widened to cover these columns
  without rehashing every event ever written. What protects a triple already on
  disk is therefore physical, not cryptographic: the append-only triggers refuse
  every `UPDATE` and `DELETE`, and the validating trigger refuses a bad triple at
  the door.
- **`verifyIntegrity()` does not re-verify historical triples.** It reports what
  it always reported. Adding a finding for a reference that no longer resolves
  needs a new `IntegrityProblemKind`, which lives in `@acp/protocol`; reusing an
  existing kind would misname the cause. That check is a later packet's.

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
| `control_plane_events` | authority | the append-only log, with `previous_sha256` and `event_sha256`, and the nullable causal triple |
| `initiative_events` | authority | the sibling append-only stream, on its own hash chain, with the same triple |
| `registry_events` | authority | versioned configuration documents, on a third hash chain, with the common field profile complete from its first migration |
| `account_event_integrity` | authority | the account stream's hash chain, one link per row from sequence 1. Evidence, not a projection: a rebuild never touches it |
| `ledger_meta` | authority | head sequence, head digest and event count, one set per stream; plus this file's own identity: `instance_id`, `restore_id`, `restore_epoch` |
| `task_read_model` | derived | current state, attempt, counts, first and last position, and the initiative the discovery named (nullable) |
| `worker_read_model` | derived | observed emitters, event and distinct task counts |
| `worker_task_read_model` | derived | emitter to task associations |
| `execution_route_read_model` | derived | the route each `(task, attempt)` was admitted on: provider, model, account, transport and the capability-policy version that chose them |
| `initiative_read_model` | derived | current status, counts, first and last position |
| `roadmap_version_read_model` | derived | the recorded versions of an initiative's roadmap, by digest |
| `routing_assignment_read_model` | derived | which model version a role and slot is assigned, per scope — the one projection fed by **two** streams |
| `routing_assignment_fallback` | derived | one row per fallback of one assignment, in attempt order |
| `projection_watermark` | derived | one row per `(projection, source stream)`: projector version, applied sequence, event count, and the source digest at that sequence |
| `projection_meta` | legacy | frozen at the values migration 7 found. Not written, and not read for truth. |

`projection_watermark` replaced `projection_meta` in migration 7. The old table
had one row per projection, which is only an answer while every projection folds
exactly one stream: a projection fed by two streams has two independent heads,
and stamping it with either one makes the other unverifiable. The composite key
makes the question well posed before there is a projection that needs it.

The old table is not dropped and not rewritten — the migrations that created it
are applied and immutable by checksum — so it stays inert, and nothing derives a
fact from it.

Two properties are worth naming because they are what the table exists for. The
`UPDATE` of `applied_sequence` is the single source of truth for how far a
projection has been applied; `updated_at` is operational bookkeeping and never
an authority on that question. And `source_head_sha256` is verified **at**
`applied_sequence`, not against whatever the head has since become — the two
coincide while a watermark is level, which is exactly why the weaker check would
look correct until the first time it mattered.

**The account stream carries no certified watermark, and the reason has moved.**
It was excluded because it had no hash chain to verify a source digest against;
P-08 gave it one, in the sidecar below. What keeps it excluded now is the other
half of the pair: a watermark row is `(projection, stream)`, and no projection of
accounts exists. Inventing one to fill a row would be a read model built to
satisfy a table rather than to answer a question. The pair is seeded by the first
packet that creates an account read model; until then nothing is blocked, because
nothing consumes an account watermark — `listAccountActions` reads the stream
directly. A row claiming that stream today is still refused by
`verifyIntegrity()` rather than believed.

## The envelope revision digest

`envelopeSha256(value)` and `envelopeIdentityPreimageV1(value)` compute the
identity of a **revision of the work** — the third of the four digests
`docs/audit/architecture/contracts/index.md` §14 keeps apart, beside the
authority document's, the prompt's and an artifact's.

```
preimage = ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1 + canonicalJsonStringify(TaskEnvelope.parse(value))
digest   = sha256(preimage)
```

There is **no separator between the two**: the LF is the last byte of the
prefix, exactly as `ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1` carries its own. One
LF, and a formula that added a second would move every digest.

**No list of fields, anywhere.** `docs/audit/architecture/database/index.md`
§6.2 requires the preimage to cover every field of the contract and refuses to
enumerate them, because a list written twice goes stale. This code refuses for
the same reason: the preimage is the whole parsed envelope, so coverage is a
property of `TaskEnvelope` being a `z.strictObject` and a field added to the
schema is in the digest the day it is added. The exclusions §6.2 names — the
default clock, the attempt, the account, the resolved model, any process id —
are enforced from the other side by the same strictness: none is a field, and an
object carrying one is refused rather than hashed.

**The function takes `unknown` and parses.** A signature typed against
`TaskEnvelope` would trust its caller's cast and hand back a digest of something
that is not an envelope. Refusals are `ZodError` from the parse, and
`LedgerCanonicalizationError` for a value that parses and still has no canonical
form — today exactly negative zero, which `int().nonnegative()` accepts and
`JSON.stringify` would rewrite to `0`. **No error class is added.**

Two consequences are deliberate. `issuedAt` is a field, so re-issuing the same
packet at a later instant is a new revision. `contractVersion` is a field, so
moving `CONTRACT_VERSION` changes the digest of envelopes issued under the new
contract — and no historical digest is migrated, because no history is rehashed.

**This does not close finding N01.** Nothing here is wired into the submission
path yet: `daemon-child` still compares the submission digest, which covers the
task coordinates, the instant and the elected route and not one envelope field.
This is the half that can be a pure function; the wiring is a later packet.
ADR 0066 carries the reasoning.

## The revision coordinate, and the revision's own record

Migration 11 gives the task stream the second rung of the identity ladder.
`task_id` is stable for life; `(task_id, revision_number)` is a unit of work,
and a change to any field of the envelope produces a new one. A retry of the
same revision is a new **attempt**, and attempts are not here — they are P-18's.

**Two additive columns, `NULL` only on legacy rows.** Migration 1 is immutable
and `attempt` is `NOT NULL`, so the coordinate arrives beside the flat integer
rather than replacing it: `control_plane_events.revision_number` and
`.attempt_number`, both absent or both present, both positive when present, and
both equal to what the event's own body says.

`tr_control_plane_events__validate_v2_coordinate` enforces that **in both
directions**. Forward, a column that disagrees with `event_json` is refused.
Backward, a payload carrying the V2 keys may not arrive with the columns empty:
without that half, a writer could record the coordinate in the body, leave the
columns `NULL`, and the row would read as legacy for ever while its own event
said otherwise.

**The "migrated but not populated" window is real and lawful**, and it is the
opposite of the account sidecar's activation. Nothing in migration 11 writes a
coordinate. Rows written before it keep both columns `NULL` for ever, and a
ledger that has applied 11 and holds no V2 row at all is a **correct** ledger.
Migration 10 activated as it migrated, so absence there was tampering; here it
is the ordinary state until a producer exists.

**No new event type.** The coordinate rides payload keys on the stream that
already exists, so `CONTROL_PLANE_EVENT_TYPES` does not move. The fold therefore
keys off the **presence** of a complete key set rather than off a type —
`revisionId`, `revisionNumber`, `attemptNumber`, `envelopeSha256`, plus the
optional `restoredFromRevisionId`. A partial set is not a malformed revision; it
is not a revision, and it projects no row.

`CONTRACT_VERSION` does **not** move with this migration. The cohort is told
apart by `revision_number IS NOT NULL`, not by a version literal — moving the
literal without a supported-versions mechanism would make every event already
recorded under the previous one unreadable. The first V2 producer moves it,
together with that mechanism. ADR 0067 carries the reasoning.

### `task_revision_read_model`

One row per revision. `revision_id` is the stable global handle for naming a
revision without carrying the coordinate.

**The row is insert-only.** A second arrival at the same coordinate with the
same content is an idempotent replay and writes nothing; with *different*
content it is `LedgerValidationError`, never an update. A revision is a record
of what was asked, and rewriting it would destroy the thing it preserves. The
replay path takes the same two branches, so a rebuild refuses exactly the
histories the incremental path refused.

**There is deliberately no `UNIQUE(task_id, envelope_sha256)`.** Restoring an
earlier envelope is a *new* revision with the *same* digest, and that uniqueness
would forbid exactly the case the model exists to allow;
`restored_from_revision_id` is what says why the two agree. The index over the
digest answers "which revisions share this envelope" and is not unique.

`envelope_artifact_reference_id` is **absent, not forgotten**. The artifact
plane is P-36/local, the column is `NOT NULL` in the target dictionary, and a
`NOT NULL` column cannot be populated without the plane that mints the
reference. Nothing here ever derives a reference from a digest. Decision 41
records the deferral; P-36/local adds the column with a cohort trigger.

### What `task_read_model` gained, and what is still empty

`envelope_sha256`, `latest_revision_number` and `latest_attempt_number` are a
convenience denormalization of the latest revision — never the authority, which
is the revision row.

The rule, in one sentence: **the envelope and the revision number move together
with the higher revision; the attempt keeps the highest within the same
revision; an older revision moves nothing.**

The first two move together or not at all — a task advertising revision 3's
number beside revision 2's envelope is the one failure a convenience column must
never produce, and both are facts of the revision rather than of the attempt.
The attempt answers a different question. Within one revision the attempts are a
sequence, and a late event announcing attempt 1 after attempt 3 has been seen
must not lower it, exactly as `latest_attempt` never decreases. A *higher*
revision does reset it: attempt 1 of revision 3 is not lower than attempt 3 of
revision 2, it is a different unit of work.

A ledger written before this rule can hold a lowered attempt, and it stays that
way until `rebuildReadModel()` — as with every change to a fold. It is a
`PROJECTION` finding, not a chain finding, and nothing is rehashed.

`role`, `step_id` and `commit_policy` are additive and have **no producer
today**. The nullity is documented rather than accidental: no event carries
them, nobody invents a payload key to fill them, and a reader treats `NULL` as
"not recorded yet" rather than as "absent". `duel_id` and `state_vocabulary` are
**not** created at all — their producers are the model-duel flow and the state
vocabulary transition, and each goes with its own packet.

**The preflight.** Before any of the above, the migration checks that no
historical `idempotency_key` already occupies the `v2/` namespace the V2 key
will use, and refuses — naming the rows and repairing nothing — if one does. It
has to be asked now: the column is `UNIQUE`, so a collision discovered later is
a constraint failure naming one row and no coordinate, on a ledger already in
production.

## The account stream's hash chain

`account_events` shipped in migration 5 with no `previous_sha256` and no
`event_sha256`, and an applied migration is never rewritten. The chain therefore
arrives **beside** the stream rather than inside it: `account_event_integrity`,
one row per row of the stream, keyed by and foreign-keyed to its sequence,
starting at sequence 1.

**What it proves, and what it does not.** It covers the historical bytes `1..H`
exactly as they stood when it was activated, and detects any change made after
that. It does **not** prove those rows were authentic *before* that moment —
nobody hashed them when they were written, so an earlier change is not excluded.
Those are two different facts, and no text in this system may present them as
one.

The digest of each link is SHA-256 over the versioned preimage of the data
contract's §8.1: a type-and-length encoding over the stored values, in a closed
field order, with `event_json` entering as complete TEXT. It is **not** canonical
JSON and must never be confused with it — canonical JSON rewrites a value into a
canonical form, and this hashes what is on disk unchanged. The encoding lives in
its own module and is pinned by fixed vectors, because a mistake in it would
produce a chain that is internally consistent and wrong over history that cannot
be rehashed.

**"The stored values" is meant literally, and the readers are shaped by it.**
The TEXT columns are selected as `CAST(col AS BLOB)` and the row reaches the
encoder as bytes; the INTEGER columns are read in `safeIntegers` mode and reach
it as `bigint`. Both are the same claim twice. A TEXT column holds bytes SQLite
never checked for well-formed UTF-8, and reading it as a string replaces every
invalid sequence with U+FFFD — so a note holding the single byte `80` and one
holding the three bytes of U+FFFD would hash alike, and substituting one for the
other would verify clean. An INTEGER column is 64 bits, and reading it as a
JavaScript number rounds anything past `2**53` — the digest would cover an
integer the row does not hold. Neither is a hypothetical: both are exactly what
a writer reaching past the door can leave behind, which is what the sidecar is
for.

This changed the fidelity of the read, **not the shape of the preimage**. `v1` is
still `v1`. For every row whose TEXT is valid UTF-8 — every row any door of this
system has ever written — the bytes read as a BLOB are byte-for-byte the bytes
the previous reader re-encoded, so no digest already recorded moves and nothing
is re-anchored. The rows whose digests change are precisely the rows the chain
used to describe wrongly, and they are **reported, never repaired**.

**Activation happens once, inside migration 10's own transaction**: the duplicate
preflight, then the DDL, then the retroactive load of every historical row, then
the five activation keys, then the migration row. All of it or none of it. `H` is
therefore fixed at the first **writable** open of a build that knows the sidecar —
literally true for a new file and the closest honest statement for one that
already exists. A read-only handle cannot activate and refuses a pending
migration, so there is no readable ledger in a "migrated but not activated"
state.

The **baseline** pair records where the retroactive coverage was taken and never
moves again; the **head** pair follows the chain as the stream grows. They are
equal at activation and diverge afterwards, which is why there are two.

**A duplicate is named, never repaired.** Before the sidecar's DDL, the migration
counts rows sharing an `(account_id, version)` and fails naming them. It does not
deduplicate: two rows claiming one version of one account are two claims about
what an operator did, and choosing between them is an owner's decision recorded
in the decisions register. In practice the count is expected to be zero, and not
by luck — the account contract derives the idempotency key from those two fields
and `UNIQUE(idempotency_key)` has been in the schema since migration 5, so a
duplicate would have had to arrive past the door. Migration 10 adds the
constraint the base was missing.

**On corruption the segment is preserved.** `verifyIntegrity()` reports a link
that does not verify, a baseline that no longer names its row, coverage that
stops short of the stream, or an activation partly or wholly missing. It repairs
nothing, re-anchors nothing and moves the coverage point nowhere: repair is an
explicit, recorded decision outside the migration flow.

**And it reports rather than throws.** A row the preimage cannot encode at all
is recorded as a `HASH_CHAIN` finding at its own sequence and the walk continues,
so the links after it are still checked. A verifier that let that refusal escape
would answer "is this ledger sound?" with an exception naming no sequence —
which reads as a broken verifier rather than as the broken ledger it is, and
says nothing about the rest of the chain.

### The projection with two heads

`routing_assignment_read_model` is the first projection fed by more than one
stream, and it is why the watermark table is keyed by a pair rather than by a
name. Its `GLOBAL` partition is folded from `registry_events`, its
`INITIATIVE`/`STEP` partition from `initiative_events`, and it therefore holds
**two** watermark rows under one name. `appendRegistryEvent` advances one of
them, `appendInitiativeEvent` advances the other, and neither can move the
other's, because the `UPDATE` targets the composite key. Read precedence is
`STEP` > `INITIATIVE` > `GLOBAL`, resolved against the vector — never against
"the latest" of a single stream, whose sequences are not comparable anyway.

Three things about it are stated here rather than left to be discovered.

- **The `INITIATIVE`/`STEP` partition is empty, by construction.** The event
  type that fills it, `ROUTING_ASSIGNMENT_RECORDED`, is not one of the three
  names in the initiative contract's closed vocabulary, and widening a contract
  that lives in another package belongs to the planning packet that needs it.
  The fold over that stream is total and returns no row for every type that does
  exist, and a test names them one by one. What this build establishes is the
  mechanism, not the rows.
- **It is published in `status()` as a vector, since P-09/log-D.** A projection
  fed by two streams has two independent heads and no single "how far"
  describes it — stamping it with either makes the other unverifiable, which is
  the exact defect `projection_meta` had. So `ProjectionStatus` carries a
  `watermarks` array, one entry per source stream, each with its own
  `appliedThroughSequence`, `eventCount` and `sourceHeadSha256`; the projection
  level keeps only `name`, `rowCount` and `updatedAt`. Between C and D this
  projection was omitted from `status()` altogether, because there was no shape
  that could describe it honestly.

  `updatedAt` for a projection with more than one row is the **latest** of
  them: each stream's door updates only its own row, and "when did this
  projection last move" has one answer. `status()` publishes the rows as
  stored — it does not recompute a head and does not judge. That division is
  deliberate: `verifyIntegrity()` is what judges.
- **The fold validates no eligibility.** The contract has `model_version_id`
  checked fail-closed against an ACTIVE model version; that is the write gate of
  the module owning the semantics, not this one. The registry is storage, this
  package may not import `@acp/accounts`, and `model_version_read_model` does not
  exist. A document whose payload this fold cannot read projects **no row while
  the document still stands**, exactly as a malformed route does.

The document vocabulary itself — `DOCUMENT_KINDS`, fourteen names — is exported
from this package and is **provisional there**. It belongs in `@acp/contracts`,
which owns no schema for these documents yet and whose schema barrel is a pinned
re-export that cannot receive a definition. It is validated by hand here because
this package may not import `zod`, and the `CHECK` in migration 9 is a second,
independent declaration of the same list that a test holds against it.

Only the derived tables are ever cleared. Neither event table has a delete path
at all: each carries its own `BEFORE UPDATE` and `BEFORE DELETE` triggers, which
abort unconditionally, and a `BEFORE INSERT` trigger that refuses a malformed
digest or a broken causal triple on the way in. All of them are inventoried by
name, because dropping one leaves `schema_migrations` untouched and no other
check would notice.

The three streams share a database and the transaction discipline, and nothing
else. An initiative registration has no task and no lifecycle state, and a
configuration document has neither; none of them can ride in the task stream
without either a null in a NOT NULL column or an initiative id in a field named
`taskId`. Each gets its own table, its own chain and its own head instead.
`rebuildReadModel()` replays all three, and `verifyIntegrity()` verifies all
three — each watermark is checked against the head of the stream it names, never
another's.

## Integrity

`verifyIntegrity()` checks SQLite integrity and foreign keys, the migration set,
the live schema shape, every stored body against its canonical form and the
contract, columns against body, the whole hash chain, sequence contiguity, head
and count metadata, the projection watermarks, and the stored projections
against a fresh replay.

The watermark checks are membership and level: exactly one row per
`(projection, source stream)` pair this build defines — no unknown pair, and
none missing — each at its own stream's head, each carrying that stream's digest
at its `applied_sequence`, each written by this build's projector version. A
watermark from another projector version invalidates the derived table without
anything having happened to the stream, and it does so **per pair**: one head of
the two-source projection can be reported without implicating the other, and a
rebuild rewrites both.

Invalidation is `verifyIntegrity()` plus `rebuildReadModel()`, and deliberately
not something `openLedger` does. An open that silently compared projector
versions and rebuilt would repair a ledger nobody asked it to touch; an open
that compared and refused would make a routine upgrade fail. It reports, and the
operator decides.

It cannot prove the events were true when written, and it cannot detect a
coherent whole-file replacement. Both need an external anchor that P1A does not
have.

## Instance and restore identity

**Which ledger this is, and which ledger this is, are two questions.** A server
identifies the file it serves by a digest of its absolute path. That answers
*which location*: it is unchanged when the file behind it is replaced, and it
changes when the same file is moved. Three rows in `ledger_meta` answer the
other half.

| Key | Rule |
| --- | --- |
| `instance_id` | A v4 UUID, written **once** and never rewritten. Stable for the life of the file. |
| `restore_id` | A v4 UUID, rewritten by **every** formal restore with a fresh random value. |
| `restore_epoch` | A monotone integer, informative only. Participates in no uniqueness claim. |

**The restore id is random, and that is the point.** An identifier derived from
a counter collides when the same backup is restored twice: both copies compute
the same next value, and a client holding a cursor cannot tell the two restores
apart. A random UUID per restore cannot collide, and `restore_epoch` exists
beside it only so a human can read the order — never as an identity.

**No migration writes these.** A migration's checksum is taken over fixed SQL
text, so a UUID embedded in one would be the same UUID in every ledger this
build ever created. `instance_id` is written by `openLedger` on the first
**writable** open by a build that knows about it, and never again; `restore_id`
is seeded beside it and then rewritten by every formal restore, which is what
`recordRestore()` is for. A ledger written before
this build gets its identity on its next writable open, with nothing asked of an
operator — the same upgrade path the migration seeds take.

**A reader never invents one.** A read-only handle over a ledger that has no
identity yet reports all three as `null`, together. It does not write, because
an identity a reader made up would give every observer a different answer to
"which file is this". A *partial* set is not that state: the three rows are
written in one transaction and nothing removes one, so a missing member is
tampering and is refused, as is a value that is not a v4 UUID.

**What this does not promise.** It detects a **formal** restore — one where the
restoring process wrote a new `restore_id` before admitting work. It does not
detect an arbitrary manual copy of the file with identical metadata; nothing
inside the file can, without external state. And it is not a backup: making the
ledger, its WAL and the artifact store consistent under one window is a separate
concern, and this package supplies the identity such a mechanism writes and the
ordering rule it must obey, not the mechanism.

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

A rebuild is a function of the whole **vector** of heads. All three chains are
replayed and checked against their own head metadata *before* a single derived
row is deleted, and any one of them being unsound refuses the whole rebuild:
repairing two streams while the third was corrupt would hand back a
clean-looking read model over a ledger that is not clean. Two rebuilds of an
unchanged ledger produce byte-identical derived tables and byte-identical
watermarks, which is what makes the read model a fact about the log rather than
about when it was last regenerated.

## Tests

`pnpm test` runs the suite. It uses temporary databases only, removes them in
teardown, and touches no repository path.

The concurrency tests spawn real child processes. Two handles in one event loop
would prove nothing, because `better-sqlite3` is synchronous and the calls would
simply run in sequence with the file lock never contended.

## The tool-coordinate claim store

A third database beside the ledger, answering a third question. The ledger
answers *what happened*; the worktree arbiter answers *may I write here, now*;
this one answers *may I run this tool call, now*.

It exists because `runToolCall` reads a coordinate's receipt, awaits an external
process, then appends — so two processes can both read "no receipt", both spawn
the tool, and both append. The ledger absorbs the second as an exact replay, and
the plane ends up with **one row for two effects**. What the plane guarantees
today is an exactly-once *receipt* over an at-least-once *effect*.

`openToolClaimStore` gives one row per coordinate, arbitrated by `BEGIN
IMMEDIATE`: the `coordinate_key` primary key prevents two records, and the
immediate transaction prevents two decisions. Both halves are needed. States run
`CLAIMED → IN_FLIGHT → SETTLED`, one way; a poison is not a fourth state but a
caller appending a `POSTCONDITION_UNKNOWN` receipt and then settling. The row
also carries everything such a receipt needs, written at claim time, so any
recoverer rebuilds identical bytes from the claim rather than from itself.

It reads no clock: every instant is the caller's argument, so expiry is decided
where the policy is. It deletes nothing, probes no process, and composes exactly
one path — `toolClaimStorePath`, derived from the ledger's own.

**Nothing calls it yet.** This is substrate, landed alone and adopted later, the
way the worktree arbiter was.

**What it will permit us to say, and what it will not.** Once adopted: an
exactly-once receipt, and an exactly-once effect per coordinate across processes
**except** across a claimant crash in the window between the tool answering and
the receipt landing, where the coordinate settles fail-closed and is never
re-run. Never an unqualified "exactly once". If the claim database is destroyed
while a coordinate is in flight and before any caller has promoted that claim
into a receipt, that coordinate becomes re-runnable — narrow, because the first
recoverer promotes the poison into the ledger, but open. ADR 0025 records why
closing it would mean one database for two questions.

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
