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
| `getTaskRevision(taskId, revisionNumber)` | One revision as the revision read model holds it — its id, envelope digest and envelope reference — or null. What recovery holds a restated opening's revision to (P-15/D1). A coordinate that is not one is a `LedgerQueryError`. |
| `getTaskSubmission(clientScope, clientRequestKey)` | The row one client key produced — the task, its revision and the envelope digest — or null. Both halves are held to `TASK_CLIENT_KEY_PATTERN` first; a key the fold could never have written is a `LedgerQueryError`. |
| `getWorker(identity)` / `listWorkers(query?)` | Derived worker read model, ordered by identity. |
| `getExecutionRoute(taskId, attempt)` / `listExecutionRoutes(taskId)` | The route an attempt was admitted on, keyed by the pair. Null, or empty, when nothing recorded one. |
| `getOutboxCommand(commandId)` / `listOutboxCommands()` | An outbox command folded from its own events, or every one in intention order: what a lost outbox cache is rebuilt to. No table holds it. |
| `appendInitiativeEvent(event, causation?)` | The same pipeline on the initiative stream: validate, canonicalize, append. A `ROADMAP_VERSION_RECORDED` that is not an exact replay is judged by `decideRoadmapVersion` inside the append's transaction and refused as `LedgerRoadmapVersionRefusedError` (P-26/A). |
| `appendRegistryEvent(document, causation?)` | The same pipeline on the registry stream: one version of one configuration document, on its own chain. A unit door; there is no registry batch. In `src/`, only `publishRegistryDocument` calls it (L-P15R-1). |
| `getRegistryDocumentVersion(documentId, documentVersion)` | One recorded version of one configuration document by coordinate, whatever key wrote it, or null. What the publication decides a replay or a conflict against. |
| `appendArtifactEvent(event, causation?)` | The registry stream's second door: one artifact event, `subject_kind = 'ARTIFACT'`, parsed by `@acp/contracts`' `ArtifactRegistryEvent` and folded into the four artifact read models in the same transaction. Facts of the bytes, never the bytes, and no file is touched. |
| `getArtifactBlob(digest, generation)` / `getUnreclaimedArtifactBlob(digest)` / `getHighestArtifactBlobGeneration(digest)` / `listArtifactBlobsInState(state)` | The artifact fold's own view of the blob read model, read-only and outside a transaction: what a publisher proposes a generation from. |
| `getArtifactReference(id)` / `getArtifactPin(id)` / `listLiveArtifactPins(kind)` | A reference, a pin, and every live pin of one holder kind in the order taken: what a reader authorizes by and a reconciler works from. |
| `listArtifactEvents(subjectId)` | The events of one artifact subject in ordinal order, each re-parsed: the next ordinal, and an intention's exact recorded body. |
| `getGlobalRoutingAssignment({ role, slot })` | The GLOBAL assignment in force for one role and slot, its fallbacks, the model version it names with its roles and transports, and the three watermark rows it was read at — all from one read transaction. `assignment: null` when none is in force; two in force is a `LedgerQueryError`. |
| `getModelVersion(modelVersionId)` | One model version with its roles and transports, or null, and the registry watermark it was read at, from one read transaction. |
| `readPriceIntervals({ catalogDocumentId, catalogVersion })` | Every price interval of exactly that catalog version, in primary-key order, from one read transaction. Never another version's rows; `[]` when the version holds none, never a zero row. |
| `getInitiative(id)` | Derived initiative read model, or null. |
| `listRoadmapVersions(id)` | An initiative's recorded roadmap versions, in version order. |
| `listInitiativeEvents(query?)` | Sequence-ordered page of the initiative stream. |
| `decideRoadmapVersion(request)` | Pure. The caller supplies the folded head; nothing here reads a ledger. Two callers: the initiative door, which is the law, and the gateway seam, which is the fast path. Seven words, `ROADMAP_VERSION_REFUSALS`. |
| `decideInitiativeRegistration(request)` | Pure. Parses a candidate through `Initiative`, guards included, and compares it with the registration the stream holds under the same id: grant, replay or `CONFLICT`. |
| `registerInitiative(input)` | The one registration both doors call: decide, publish the objective to the private plane, append one `INITIATIVE_REGISTERED` whose closed payload carries the objective's digest and reference. Handles, instants, the pid and identifiers are injected; it opens nothing and reads no clock. |
| `publishRegistryDocument(input)` | The one publication of a `MODEL_VERSION`, a `ROUTING_ASSIGNMENT_GLOBAL` or a `PRICE_TABLE` (P-15/R, ADR 0104): derives the digest, the key and a version 5 event id, answers an exact retry as a replay, refuses a version recorded otherwise, and carries the door's refusals by field and word. `acp registry` calls it. |
| `readInitiativeObjective(ledger, event)` | The objective a registration published, read back by reference under the initiative's scope; null for a registration that never published one, and a `LedgerIntegrityError` rather than null when the plane cannot produce it. |
| `readByReference(ledger, { artifactReferenceId, scopeKind, scopeId })` | The bytes a reference authorizes one scope to read, holding nothing (P-15/F, ADR 0107). Checks that the private root stands before it opens the plane, so a read never creates it, and answers the plane's own `READ` or `REFUSE`, plus `ROOT_ABSENT` / `ROOT_NOT_A_DIRECTORY` (`REFERENCE_READ_ROOT_REFUSALS`). A refusal is a value; the caller decides what it means. `readInitiativeObjective` and the runtime's `readEffectResult` read through it. |
| `listTaskEffects(taskId)` | A task's effects, in the order their intentions were recorded (P-15/F). `[]` for a task that intended none; the caller tells that apart from an unknown task by asking for the task. |
| `rebuildReadModel()` | Drop and replay every projection of both streams, transactionally. |
| `verifyIntegrity()` | Full report. Never throws on a finding; returns problems. |
| `status()` | Effective pragmas, applied migrations, head, counts, projections, this file's identity. |
| `identity()` | Which file this is and which restore of it. A read; works read-only. |
| `recordRestore()` | Record that this file is the product of a formal restore. Writes a fresh random restore id before any later append. |
| `close()` | Release the handle. |
| `envelopeSha256(value)` | Pure. The revision identity of a task envelope; parses before it hashes. |
| `envelopeIdentityPreimageV1(value)` | Pure. The bytes that digest is taken over. |
| `computeOutboxCommandId(input)` / `outboxCommandIdPreimageV1(input)` | Pure. The id of one command, over `(sagaId, phase, targetKind, targetId)` under the contract's prefix; the door recomputes it. |
| `foldOutboxCommands(entries)` | Pure. Every command a sequence of stream events folds to, refusing what the append door refuses. |
| `measurementStreamIdV1(coordinate)` / `measurementStreamPreimageV1(coordinate)` | Pure. The id of one usage measurement stream, over `(source, accountId, routeSegmentId, sourceEpoch)` under its versioned prefix; refuses a malformed field by name before hashing. |
| `foldUsageSettlement(request)` | Pure. One effect's observations, at one cut, into one settlement revision — header, control-head vector, considered list and per-segment election — or one refusal from `USAGE_SETTLEMENT_REFUSALS`. The append door and the rebuild call it for every usage observation and every first delivery (P-32/captura B). |

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

Fifteen classes are exported, and this is the complete list — the
architecture fence asserts it against the barrel in both directions, so a
sixteenth class cannot arrive without appearing here.

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
| `LedgerArtifactEncryptionConflictError` | a publication would reuse a blob generation under another encryption status, key reference or profile; a deduplication never changes a blob's encryption |
| `LedgerRoadmapVersionRefusedError` | the initiative door refuses a roadmap version by the decision's word, or the fold meets a second claim on a version's identity or number; carries `reason` and `at`, never the roadmap |

## Tables

| Table | Kind | Contents |
| --- | --- | --- |
| `schema_migrations` | authority | applied version, name, SHA-256, timestamp |
| `control_plane_events` | authority | the append-only log, with `previous_sha256` and `event_sha256`, and the nullable causal triple |
| `initiative_events` | authority | the sibling append-only stream, on its own hash chain, with the same triple |
| `registry_events` | authority | versioned configuration documents and artifact events, on a third hash chain, with the common field profile complete from its first migration; `subject_kind` says which, since migration 15 |
| `account_event_integrity` | authority | the account stream's hash chain, one link per row from sequence 1. Evidence, not a projection: a rebuild never touches it |
| `ledger_meta` | authority | head sequence, head digest and event count, one set per stream; plus this file's own identity: `instance_id`, `restore_id`, `restore_epoch` |
| `task_read_model` | derived | current state, attempt, counts, first and last position, and the initiative the discovery named (nullable); since P-14 C, the `step_id`, `role` and `commit_policy` an intake recorded, written once (`NULL` for a task that entered any other way) |
| `task_submission_read_model` | derived | one row per client key a task entered under, since migration 19: the task, its revision and the envelope digest, insert-only and refused by name under another task |
| `worker_read_model` | derived | observed emitters, event and distinct task counts |
| `worker_task_read_model` | derived | emitter to task associations |
| `execution_route_read_model` | derived | the route each `(task, attempt)` was admitted on: provider, model, account, transport and the capability-policy version that chose them |
| `task_revision_read_model` | derived | one row per `(task, revision)`: the revision's stable handle, its envelope digest, the registered reference its envelope's bytes are read by (`NULL` before contract version `2.5.0`, since migration 16) and what it restored |
| `task_attempt_read_model` | derived | one row per `(task, revision, attempt)`: the flat assignment that goes in the legacy `attempt` column, and the invocation the attempt is in bijection with |
| `execution_route_segment_read_model` | derived | one row per stretch of one attempt's route, with explicit lineage back to the segment that handed off to it |
| `effect_read_model` | derived | one row per logical operation of a run, found by its logical key rather than by a physical coordinate; since migration 22, the contract version that recorded its outcome and, with the outcome, the registered `RESPONSE` reference and digest of its result |
| `dispatch_attempt_read_model` | derived | one row per concrete external delivery of one effect, in the five states of execution §7 |
| `prompt_occurrence_read_model` | derived | one row per prompt a delivery sent: digests and counts, the effective segment and account, never the bytes |
| `response_occurrence_read_model` | derived | the one answer to one prompt occurrence, attributed through that prompt and nothing else |
| `usage_measurement_stream_read_model` | derived | one row per declared measurement stream, since migration 20: its recomputed id, source, account, segment, epoch, source class and normalization policy, and the event that first declared it |
| `usage_observation_read_model` | derived | one row per usage report on one stream for one effect: DELTA, CUMULATIVE or CORRECTION, its counter range, four exclusive token classes and their total, `is_final` as the source said it |
| `usage_settlement_read_model` | derived | one row per settlement revision of one effect: FINAL, PARTIAL, UNKNOWN or DISPUTED, the five counts (NULL iff UNKNOWN or DISPUTED, read as `bigint`), the policy digest and fold version, the last observation considered and whether one arrived after a FINAL. Insert-only: the highest revision is in force |
| `usage_settlement_source_head_read_model` | derived | the cut each revision was folded at: the control stream's sequence and digest of its own trigger |
| `usage_settlement_observation_read_model` | derived | every observation each revision considered, winners, losers and corrected alike |
| `initiative_read_model` | derived | current status, counts, first and last position; since migration 18, the `title` and `objective_sha256` a registration recorded in the closed payload (`NULL` otherwise), and `repository_sha256`, which nothing produces |
| `roadmap_version_read_model` | derived | the recorded versions of an initiative's roadmap, by digest |
| `routing_assignment_read_model` | derived | which model version a role and slot is assigned, per scope — the one projection fed by **two** streams |
| `routing_assignment_fallback` | derived | one row per fallback of one assignment, in attempt order |
| `model_version_read_model` | derived | the one registry of model versions, one row per `MODEL_VERSION` document at the version applied last: provider, model, release, lifecycle status, context, policy version, `deprecated_at` null if and only if `ACTIVE`. `latest_performance_window` stays `NULL`: economy's |
| `model_version_eligible_role` | derived | one row per role a model version declares eligible, in declared order, each role once |
| `model_version_transport` | derived | one row per transport a model version admits, in declared order, each transport once |
| `price_interval_read_model` | derived | one row per interval of one `PRICE_TABLE` version, since migration 21: the document and the version in the key, provider, model version, transport, token class, currency, a half-open `[effective_from, effective_to)` and an integer price in nanounits per million tokens. Insert-only: a later version adds rows and changes none |
| `artifact_blob_read_model` | derived | one row per generation of some bytes, keyed `(content_sha256, blob_generation)`: size, media type, lifecycle state, encryption, and the event that first published it. No owner and no scope |
| `artifact_reference_read_model` | derived | one row per authorized access to one generation: class, classification, scope, producer, policy, retention. Here lives the permission |
| `artifact_pin_read_model` | derived | one row per protection of one generation from collection, with the sequences that took and released it |
| `artifact_tombstone_read_model` | derived | the revocation of a reference. The table exists; nothing in this build writes a row |
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
recorded under the previous one unreadable. ADR 0067 carries the reasoning.

**The mechanism arrived without the bump** (P-18/protocolo A, ADR 0072).
`@acp/contracts` separates `SUPPORTED_CONTRACT_VERSIONS`, the set a reader
admits, from `CONTRACT_VERSION`, the one value a producer stamps. What changed
there is that the three read paths (`#rowToRecord`, `#validateRowShape`,
`#replay`) now say *which* version they found and *which* set they read when
that is why a stored row was refused. They already refused; "does not satisfy
the contract" was equally true of a tampered field and of a ledger written by a
newer build, and only one of those is recoverable.

**And the bump arrived in P-18/protocolo C** (ADR 0076). `CONTRACT_VERSION` is
`"2.3.0"`; the set is `["2.2.0", "2.3.0"]` and `"2.2.0"` stays in it for ever,
so a ledger full of history under the previous build opens, reads, passes
`verifyIntegrity()` and rebuilds. The other half of the pair is the issuer's
rule — **only the version in force is emitted** — which this package enforces at
the append door of `control_plane_events`, on a genuinely **new** insertion.
The replay is exempt and that is the design: an event already recorded, appended
again byte for byte, returns its existing record before the check is reached,
because a producer retrying an append written before an upgrade is doing the one
thing an idempotency key exists to make safe. `ControlPlaneEvent` itself keeps
the reader's set, since it is the schema every stored row is re-parsed with.

### The V2 key, and the door that admits it

Migration 11 reserved the `v2/` namespace. Composing the key belongs to the
producer, and until P-18/protocolo A no producer could exist: `ControlPlaneEvent`
demanded the V1 key of every event, so the namespace was reserved and
unreachable at once. `V2_IDEMPOTENCY_NAMESPACE` now lives in `@acp/contracts`
beside `buildV2IdempotencyKey`, and **this package imports it** (decision 42) —
a namespace is grammar of the key, and the key is the contract's.

The rule at the contract's door is strict in both directions: a payload carrying
a complete V2 coordinate must key V2, a payload without one must key V1, and
nothing else parses. That is what makes "no other idempotency namespace for the
same facts" enforceable rather than advisory — a producer whose V2 append
conflicts cannot re-key the same payload under V1 and call it a new operation.

This package's append door adds the second of three guards: a payload whose V2
coordinate is malformed — one key without the other, a value that is not a safe
integer of at least one, or an explicit `null` — is refused before the `INSERT`
as a `LedgerValidationError` naming the key at fault. The trigger below stays
exactly where it is, as the backstop against a writer that bypasses the door.

### `task_revision_read_model`

One row per revision. `revision_id` is the stable global handle for naming a
revision without carrying the coordinate.

**The row is insert-only.** A second arrival at the same coordinate with the
same content is an idempotent replay and writes nothing; with *different*
content it is `LedgerValidationError`, never an update. A revision is a record
of what was asked, and rewriting it would destroy the thing it preserves. The
replay path takes the same two branches, so a rebuild refuses exactly the
histories the incremental path refused.

**"Same content" is three fields** — `revision_id`, `envelope_sha256` and
`restored_from_revision_id` (ADR 0072, amending 0067 §4). `sequence`,
`created_at`, `created_by` and `contract_version` record the *arrival* that
first announced the revision, not the revision, and they are excluded for the
reason `sequence` always was: an exact replay landing later is the same
revision. Concretely this is what lets a second **attempt** of one revision
carry its own `occurred_at` — execution §3 calls that "un reintento de la misma
revisión, no una revisión nueva" — where before, advancing
`latest_attempt_number` required restating the first arrival's timestamp. The
replay keeps the first arrival's birth attributes; a rebuild reproduces them.
One exported function, `sameRevisionRecord`, is what both the append door and the
snapshot compare with, because two implementations of "same content" would be
two definitions of it. It compares `canonicalRevision`'s three fields always, and
the envelope reference **only when the stored row holds one** (below).

**There is deliberately no `UNIQUE(task_id, envelope_sha256)`.** Restoring an
earlier envelope is a *new* revision with the *same* digest, and that uniqueness
would forbid exactly the case the model exists to allow;
`restored_from_revision_id` is what says why the two agree. The index over the
digest answers "which revisions share this envelope" and is not unique.

### The envelope reference, by cohort (migration 16)

P-36/local escalón D (decision 41; ADR 0084, decisions 67-69). Migration 11
created the table without `envelope_artifact_reference_id` on purpose — a
`NOT NULL` column nothing could fill. Migration 16 adds it by `ADD COLUMN`,
nullable and with no default, so every row already there reads `NULL`, and one
`BEFORE INSERT` trigger holds the cohort in both directions:

| `contract_version` | `envelope_artifact_reference_id` |
| --- | --- |
| `2.2.0`, `2.3.0`, `2.4.0` — a closed list frozen in the migration | must be `NULL` |
| anything else — `2.5.0` and `2.6.0` today, and every later bump without touching 16 | required, and not empty |

The cohort is keyed on the version, so the version had to move: P-36/local D
moved `CONTRACT_VERSION` to `"2.5.0"`. That bump paid the cohort, not an identity
(ADR 0084) — a reference is a fact the fold reads, and nothing is derived from it.
P-32/captura B moved it on to `"2.6.0"` for an identity (ADR 0089), and fell into
the same cohort without touching migration 16.

The reference travels as `payload.envelopeArtifactReferenceId` of the revision
record. **The fold checks form and cohort**, and refuses by name: the key on a
record of the cohort before; no key on a record of the cohort after; a present
value that is not a non-empty string (`null`, `""`, a number), which is never read
as absent. **The append door checks existence**, by name and before anything is
written: the reference must be in `artifact_reference_read_model` with
`artifact_class = 'TASK_ENVELOPE'`. That look-up lives at the door and nowhere
else, because the reference is a projection of the registry stream and the
revision of the task stream: a trigger or a foreign key across them would make a
rebuild depend on the order it folds the streams in. Scope, retention and
tombstones are not asked — scope is the private reader's law.

**Written once, and the reference counts only where the row holds one.** A row of
the new cohort holds a reference, so a second arrival naming another is refused
as a second answer to where the envelope's bytes are. A row of the cohort before
holds `NULL` for ever; a second attempt of that revision stamped after the upgrade
carries the reference its version requires, agrees with the row on the three
facts, and is admitted — the reference stays in the log, not in the row.

**Nothing derives a reference from a digest**, here or anywhere: a revision whose
digest the registry holds bytes under, and that names no reference, is refused
all the same. This build publishes no envelope: `@acp/runtime` carries the
reference its caller hands in, and writing the envelope's bytes is adoption's.

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

## The attempt, and the number it was assigned once

Migration 12 gives the task stream the third rung of the identity ladder
(execution §3, P-18/protocolo B). `task_id` is stable for life;
`(task_id, revision_number)` is a unit of work; `(task_id, revision_number,
attempt_number)` is one try at it. `attempt_number` restarts at 1 in each new
revision and cannot collide with a restore, because the coordinate carries the
revision.

**Two numbers, and only one of them counts anything.** `attempt_number` is the
coordinate's third component. `legacy_attempt_number` is the flat integer
migration 1's `attempt` column has always demanded: monotone **per task**,
assigned once, stable for this coordinate for ever, and equal to
`control_plane_events.attempt` on every event of the coordinate. It is not a
per-revision counter and not a second authority about which attempt this is.
`UNIQUE (task_id, legacy_attempt_number)` is what makes it usable as the legacy
column — two coordinates sharing it would make that column ambiguous for every
query written before migration 11.

`invocation_id` is unique **globally**, and with the primary key that is the
bijection: one invocation names one attempt and one attempt names one
invocation. It is not a worker run id and not an engine's private handle; a
replay or a handoff carries the value rather than minting a second one.

### `TASK_ATTEMPT_OPENED`, and why this rung has a type

Migration 11 deliberately added no event type: the revision coordinate rides
payload keys, so the revision fold keys off the **presence** of a complete key
set. The attempt is the opposite case, and the asymmetry is the point.
`invocationId` and `legacyAttemptNumber` are facts that only the arrival opening
the attempt is entitled to state, so a fold keyed off presence would let any
later event of the coordinate restate — and therefore contradict — the identity
that was assigned. `CONTROL_PLANE_EVENT_TYPES` moves 24 → 25, which is the pin
P-05/B avoided and P-18 cannot.

The type is a **same-state passthrough** (`fromState === toState`), like
`TOKEN_USAGE_RECORDED` and `TOOL_CALL_RECORDED`: opening an attempt records an
identity, it does not move a lifecycle state. Its payload is the coordinate plus
the revision record plus the two identity facts — `{revisionId, revisionNumber,
attemptNumber, envelopeSha256, restoredFromRevisionId?, invocationId,
legacyAttemptNumber}`. Carrying the revision keys is not redundancy: it is what
satisfies `fk_task_attempt_read_model__task_revision_read_model` by
construction, because the revision row is folded from the same event in the same
transaction rather than assumed to be already there.

**Nothing in this build emits one.** The producer is escalón G, in
`@acp/runtime`. This escalón lands the contract, the channel, the migration, the
fold and the door; ADR 0073 records the debt rather than discharging it.

### The compare-and-set, and who proposes what

The producer **proposes** `attempt` and `legacyAttemptNumber`; the ledger, inside
the `BEGIN IMMEDIATE` an append already holds, computes what the answer must have
been and refuses by name if the proposal differs.

That division is forced by the shape of an append rather than chosen for taste.
An event arrives *signed*: `canonicalJson` and therefore `event_sha256` cover
`attempt`, and both are computed before the transaction opens. So execution §3's
"se asigna" cannot mean "the ledger writes a number into the event" without
either recanonicalizing a body the caller already hashed or growing a second
append path that builds and signs events of its own. ADR 0073 records the
reading.

What the door computes:

- **The coordinate is already open** → its assignment and its invocation are
  reused. An opening that agrees is a replay; one naming a different invocation,
  or a different flat assignment, is refused.
- **The coordinate is new** → `1 + MAX(attempt)` over every event of the task,
  **legacy rows included**, and `1` for a task with no events at all.
- **The coordinate is not open but already holds events** (P-15/D1, ADR 0105) →
  their flat attempt is reused. That is the intake's `TASK_DISCOVERED`, written at
  revision 1, attempt 1 before any opening, so intake, opening and discovery are one
  attempt. Events of one coordinate at two flat attempts refuse the opening.

Three refusals sit around it, all `LedgerValidationError` with a `path` — never a
`SqliteError` from an index (F-2's standard, ADR 0072):

- `payload.legacyAttemptNumber` must equal the event's `attempt` column. This is
  the third pairing rule, the sister of the two the stream trigger holds for
  `revisionNumber`/`attemptNumber`, and it lives at the door rather than in a
  fourth trigger (ADR 0073). The cost is stated rather than hidden: a writer that
  bypasses this door can still record a row whose payload and column disagree.
- An opening must find a revision or announce one, so the foreign key is guarded
  by name before SQLite guards it by abort.
- One invocation may not name two coordinates, guarded so the refusal names both
  attempts instead of arriving from
  `ux_task_attempt_read_model__invocation_id`.

**The cap is the contract's, and the door consults it.** `attempt` is bounded at
10 000 by `IdempotencyCoordinates`, and this file reads the bound off that schema
rather than restating the literal. The check runs on the value the ledger
**computes**, *before* the comparison with what the event proposed: reversed, the
contract's own parse would refuse `attempt = 10001` first and the claim that the
compare-and-set knows the cap would never be exercised. Exhausting the space is a
typed refusal naming the cap (adjudication Q4) — a task ten thousand attempts
deep is resolved with a new task, not with a wrapped counter.

**Tolerant without a row, strict with one.** A V2 event that is *not* an opening
is checked against the assignment only if the attempt has been opened. A V2 event
over a coordinate with no attempt row is lawful: migration 11 declared the
"migrated but not populated" window, and demanding that an opening precede
everything would retroactively refuse histories the log already holds.

### What this escalón does not write

`ended_at` and `outcome` are `NULL` on every row this build produces, and the
nullity is declared rather than accidental. Mapping a terminal task state onto
`effect_outcome_status` is a decision nobody has taken, so escalón B records the
opening and no closer; ADR 0073 names the escalón that owes it.
`ck_task_attempt_read_model__outcome_pair` — `(ended_at IS NULL) = (outcome IS
NULL)` — is what stops a later writer recording half of an ending, and it is
exercised at the schema rather than through a fold that cannot reach it.

The row is **insert-only**, on `task_revision_read_model`'s terms. "Same
attempt" is two fields — `legacy_attempt_number` and `invocation_id` — by the
argument `canonicalRevision` makes about three: the coordinate is the key both
callers look the row up by, and `sequence` and `started_at` record the *arrival*
that announced the attempt rather than the attempt. One exported function,
`canonicalAttempt`, is what the append door and the snapshot compare with. The
snapshot additionally carries the table's two unique indexes in memory, so a
**rebuild** refuses the histories the base would refuse — two invocations for one
coordinate, or one flat assignment across two — at the event that caused them
rather than several layers away.

## The effect, its deliveries, and the segment they hang off

Migration 13, the rungs below the attempt (execution §4, §6, §6.1 and §7;
ADR 0076). Three tables land together because §6 and §7 both carry a foreign key
onto the segment and the effect's own identity takes `segment_number` from it —
§1.8 forbids cutting an invariant to get a smaller delivery.

### The logical key, and why a lookup exists

An effect is recognised by **what it is** before any physical coordinate is
assigned to it: the run's invocation, a semantic scope and the step's own key.
That triple is what `logical_operation_sha256` digests and what
`ux_effect_read_model__logical_operation_sha256` makes unique, and it is what
makes losing an acknowledgement survivable. A run that lost one, handed off to
another account and repeated the same step calls `lookUpEffect` and gets the
**original** `effect_id` and `idempotency_key` back — never a new pair —
together with whether the situation demands reconciliation.

The write side is the refusal that makes the read side necessary. An
`EFFECT_INTENDED` whose logical key is already taken is refused by name, and a
difference in any of execution §6.1's four compared fields — kind, request
contract version, envelope or request digest — is a **CONFLICT**. A producer
never resolves a conflict by changing the key.

### The identity formula, stated once

`effect_id` and `idempotency_key` are sha-256 over versioned preimages declared
in `@acp/contracts` and computed here, exactly as `envelope_sha256` is. Neither
carries the clock and neither carries anything resolved at dispatch time: both
are fixed once, with the **initial** segment, and conserved through every replay
and every handoff. A later authorized delivery after a handoff records its own
effective segment in `dispatch_attempt_read_model`, and the effect keeps its
origin — which is what keeps one operation from acquiring two idempotency keys.

The producer proposes and the ledger verifies, on escalón B's terms. Three of
the four digests are recomputed here from sources this ledger recorded — the
`invocation_id` on the attempt row, the `envelope_sha256` on the revision row —
and refused by name when they disagree. `request_sha256` is the exception and it
is declared: its preimage carries the business request, and a business request
does not enter a ledger event, so it is recorded and conserved rather than
checked.

### Five states, and no sixth

`dispatch_state` is `INTENDED`, `CLAIMED`, `INFLIGHT`, `SETTLED` or `ABANDONED`.
`RECONCILING` is `outbox_message`'s word, not a sixth state here: an overdue
`INFLIGHT` **stays** `INFLIGHT` and is found by `listOverdueDispatchAttempts`,
whose deadline arrives by argument because this package reads no clock. Finding
one creates nothing — no verb here moves it, mints another delivery for its
effect, or intends a second effect from it.

`outcome_status` is `NULL` until something actually ends, and `NULL` is not
`OUTCOME_UNKNOWN`: an intention never dispatched is absence of data, while
`OUTCOME_UNKNOWN` is a recorded uncertain exposure. It is not a failure, and it
**blocks** another delivery of that effect outright — a destination reporting
itself clean is a statement about the destination, not about whether the earlier
delivery landed.

### What the dispatch door refuses

Every refusal is a `LedgerValidationError` with a `path`. Beside the refusals of
the segment it announces, a `DISPATCH_INTENDED` is refused, in this order, when:

- its payload does not constitute an intention — `payload.dispatch`;
- its delivery id is already recorded with a different birth — an identical one
  is a replay and writes nothing;
- its effect has not been intended — `payload.dispatch.effectId`;
- its effect ended `OUTCOME_UNKNOWN`: an uncertain exposure is reconciled, never
  resent — `payload.dispatch.effectId`;
- its effect ended `SUCCEEDED`, `FAILED` or `CANCELLED`: **a known outcome is
  reused, never redelivered** (execution §6.1, CORR-2), and a genuinely new
  operation intends a new effect — `payload.dispatch.effectId`. There is no
  exception for `FAILED` or `CANCELLED`. The rule reads the effect's outcome, not
  the deliveries' states: after an `ABANDONED` delivery, or a `SETTLED` one that
  reported no outcome, the next delivery is admitted;
- an earlier delivery of the effect is still `INTENDED`, `CLAIMED` or `INFLIGHT`
  — `payload.dispatch.effectId`;
- its effect belongs to another attempt — `payload.dispatch.effectId`;
- its ordinal is not one past the effect's highest —
  `payload.dispatch.attemptOrdinal`.

The two outcome rules are door-only: every stored delivery passed them when it
was written, and the fold does not restate them.

A `DISPATCH_OUTCOME_RECORDED` is refused when its payload does not constitute a
resolution, when its delivery does not exist or belongs to another attempt, when
its state is not a forward move of the five, or when it names an outcome — or a
result — other than the one the effect already recorded. And **a present-invalid value is never
read as absence** (CORR-2): each of the four optional fields —
`effectOutcomeStatus`, `acceptedAt`, `externalHandle`, `providerIdempotencyKey`
— is either absent, lawful (a word of `EFFECT_OUTCOME_STATUSES`, or non-empty
text), or refused at `payload.outcome.<field>`. A word outside the vocabulary, a
number, an object, an empty string and an explicit `null` are all refused, and
the refusal shows a string only when it is shaped like an identifier. The door
and `applyEventToSnapshot` read through one function and throw the same issue,
so `rebuildReadModel` refuses a stored history holding one in the door's words.

Since P-15/D1 (ADR 0105) the two instants are held to more than text: `acceptedAt`,
when present, and `terminalAt`, when present and not null, are the canonical instant
— ISO-8601 with milliseconds in UTC ending in `Z`, the form that round-trips — or
refused at their key. P-18 orders them as text, which is time order only in that
form, so an offset or a missing millisecond is refused and never normalized. The
segment an intention announces is held to its transport the same way: a
`transportKind` outside `TRANSPORT_KINDS`, absent, null or empty, is refused at
`payload.segment.transportKind`, and `applyEventToSnapshot` throws the same issue
(`segmentTransportRefusal`), so a rebuild refuses such a history by name.

### The result reference, by cohort (migration 22)

P-07 escalón B (ADR 0098, decisions 108-109). An effect's result is a document
whose bytes a `RESPONSE` artifact holds, so the outcome names it by that
artifact's registered reference and its conserved digest, in the same event —
`payload.outcome.resultArtifactReferenceId` and `payload.outcome.resultSha256`.
Migration 22 adds three nullable columns by `ADD COLUMN` —
`outcome_contract_version`, `result_artifact_reference_id` and `result_sha256` —
and two triggers, one per path a row arrives by (a rebuild inserts, the door
updates), that hold the cohort:

| `outcome_contract_version` | result pair |
| --- | --- |
| `2.2.0` … `2.7.0` — a closed list frozen in the migration | must be `NULL` |
| anything else — `2.8.0` and `2.9.0` today | required on `SUCCEEDED`; optional on `FAILED` |

Version-independent row law is a CHECK: the pair is both `NULL` or both present,
the digest has the common shape, a result exists only on `SUCCEEDED` or `FAILED`,
and a version implies an outcome. The other half — an outcome implies a version
— is in the triggers, because a CHECK added by `ADD COLUMN` is tested against the
rows already there. On upgrade, code in the migration's transaction writes each
recorded outcome's version (and pair) from its own event, through the reader the
door and the fold use.

**The reader checks form and cohort**, present-invalid, and refuses by name: a
key that is not text (or not 64 lowercase hex), half a pair, a pair with no
outcome, a pair on `CANCELLED` or `OUTCOME_UNKNOWN`, a pair on a version of the
cohort before, and a `SUCCEEDED` of a later version without one. The statuses
that may carry a result are the result contract's own `RESULT_STATUSES`,
imported. **The door checks existence**: the reference must be this task's
registered `RESPONSE` and its `content_sha256` must equal the digest — published
before referenced (datos §11 step 7). The base checks presence, never existence.
Replay and conflict are decided on the status and the pair together, by one
function the door and the fold share.

The cohort is keyed on the version, so the version moved: P-07 escalón B moved
`CONTRACT_VERSION` to `"2.8.0"`, a cohort and not an identity (ADR 0084's reason).

### The delivery's price pin, by cohort (migration 23)

P-15 escalón C (ADR 0103). A delivery names the price catalog version it will be
valued against before any spend: `payload.dispatch.catalogDocumentId` and
`payload.dispatch.catalogVersion`. Migration 23 adds `dispatch_contract_version`,
`catalog_document_id` and `catalog_version` to `dispatch_attempt_read_model` by
`ADD COLUMN`, with CHECKs for the row law that holds in every version (non-empty
text, a version of at least 1, the pair both or neither), and two triggers that hold
the cohort:

| `dispatch_contract_version` | pin |
| --- | --- |
| `2.2.0` … `2.8.0` — a closed list frozen in the migration | must be `NULL` |
| anything else — `2.9.0` today | required |
| `NULL` | refused, by the first statement |

On upgrade, code in the migration's transaction writes each delivery's version (and
pin) from its own `DISPATCH_INTENDED`, through the reader the door and the fold use.

**The reader checks form and cohort**, present-invalid, and refuses by name: a key
that is not what it names (`null` included), half a pair, a pin on a version of the
cohort before, and none on a later one. **The door checks the registry**: the pin
names a published `PRICE_TABLE` version; it is the version **in force** at the
dispatch instant (`selectVigentCatalogVersion`: the greatest `effectiveFrom` at or
before it; none in force, or a tie at that instant, is refused, never picked); and it
**covers** the delivery's segment (`pinCovers`: an interval of that version for the
segment's provider, model version and transport kind, half-open around the instant).
A segment with no resolved model version is never covered. The pin is part of the
delivery's birth, so the same delivery with another pin is the "intended once"
conflict.

`Ledger.getVigentCatalogPin(documentId, instant)` answers which version is in force,
over the rows the door reads, so the pin a composition chooses is the one the door
admits; `selectVigentCatalogVersion` and `pinCovers` are on the barrel for the same
reason. `resolvePrice` stays uncalled: the door decides whether a pin may be
recorded, never a price. The version moved again for this cohort: P-15 escalón C
moved `CONTRACT_VERSION` to `"2.9.0"`.

### What this escalón does not write

`provider_idempotency_key`, `external_handle` and `accepted_at` exist with their
nullity documented and no producer fills them with an external fact: populating
them needs a composed adapter, which is P-15. `accepted_at` carries no CHECK on
purpose — one making `INFLIGHT` imply a non-null value would make `INFLIGHT`
unreachable while that adapter is missing, and an unreachable state cannot be
tested. `effect_kind` carries no CHECK either: the catalogue is one member today
and lives in this package, on decision 45's reasoning rather than decision 42's.

Nothing emits any of the three event types. The migration, the folds, the door
and the lookup land without a production caller, exactly as escalón B's opening
did; escalón G owes the producer.

## The prompt a delivery sent, and the answer it received

Migration 14 (execution §8; ADR 0077). Two tables hanging off migration 13's
delivery, and two event types — `PROMPT_OCCURRENCE_RECORDED` and
`RESPONSE_OCCURRENCE_RECORDED` — both same-state passthroughs on `execution`.
The answer is its own type because it has its own key, its own instant and its
own position, and because it may arrive **late**.

### A use, never a blob

A prompt occurrence is the fact that some bytes were sent, not the bytes. The
same prompt sent twice is two rows under two occurrence ids with one
`prompt_sha256` between them, which is why that column is indexed and never
unique, and why `listPromptOccurrencesBySha256` returns a list.
`dispatch_attempt_id` is not unique either: one delivery may send several
prompts. No row holds a byte of a prompt or of an answer — only digests and
counts — and the append door refuses any payload key the occurrence grammar
does not declare, beside the contract's own transcript guard.

The three digests are **conserved, never recomputed**. Their preimages are the
bytes that never enter, so this ledger has no source to recompute them from; it
checks their shape and says that is all it checks. What it does verify is
everything it has a source for: the delivery exists, the prompt's effect and
segment are that delivery's — the **effective** segment, never the one the
effect began on — the event is recorded at the attempt that owns the effect, and
the ordinal is one past the segment's highest. `identity` is the recording
event's `emittedBy`.

### Causal order, and one batch

A prompt is recorded after its delivery's intention, or later in the same
`appendBatch`. The door reads the delivery inside the transaction, so a batch
that intends a delivery and records its prompt, in that order, lands whole; the
reverse order is refused by name and the batch lands nowhere.

### A late answer keeps its origin

`response_occurrence_read_model` has no account and no segment column, and the
door refuses an answer payload that names a delivery, a segment or an account.
Its only link to where the work ran is `prompt_occurrence_id`, and its V2
coordinate must be the prompt's own. So an answer that arrives after its
delivery was abandoned and another account took over on a new segment is
attributed to the prompt that was actually sent — the origin — and there is no
path by which it could be attributed to the destination. One answer per prompt:
a second is refused by name at the door, and a rebuild refuses a history that
holds one.

### What this escalón does not do

No contract bump: D adds facts — conserved digests, counts, vocabulary words —
and no identity formula, which is ADR 0076's criterion for staying on `"2.3.0"`.
No occurrence is derived from an intention or a resolution, and a delivery that
resolves with no prompt leaves both tables empty. Nothing emits either type:
execution §8 `:421` — no occurrence for a call a transport does not make
observable — is a guarantee the producer of escalón G owes.

## An artifact is a subject of the registry before its first byte moves

Migration 15 (artifacts §1.1, §3-6 and §8.1; P-36/local escalón A; ADR 0081).
Artifact events live in `registry_events`, not in a fifth stream, and not on a
task: a price catalog or a policy document has no task to hang off.

### The stream, rebuilt once and changed in no row

Migration 9 made the stream for documents alone — `document_kind` NOT NULL and
closed by a CHECK — and a CHECK cannot be widened in place. So migration 15
rebuilds the table: a new table beside it, every row copied with its
`sequence`, `event_json`, `previous_sha256` and `event_sha256`, the three own
triggers **and the two triggers on the task and initiative streams that name it**
dropped, the old table dropped, the new one renamed into place, and every index
and trigger recreated under its name — the two foreign triggers byte-identical to
migration 9's. The rename re-parses the whole schema, and a trigger naming a table
that does not exist at that instant aborts it; that is why the foreign pair goes
too. No pragma is set. The chain digests `previous_sha256` and `event_json`, both
copied, so every row still verifies, the head does not move and the next append
takes the next sequence.

Each row now says `subject_kind` — `DOCUMENT` or `ARTIFACT` — with two mirrors:
`document_kind` is present exactly on a document, `artifact_event_kind` exactly on
an artifact. The artifact CHECK names all **nine** words of the contract though
this build records six, so P-36 completo does not rebuild the stream again. And
after this migration four tables carry a foreign key into `registry_events`: a
future rebuild of it drops those children first.

### One row per event, on one subject

An artifact event's subject is the resource it is about: the content digest for
the three publication events, the reference for `REFERENCE_RECORDED`, the pin for
the two pin events. `document_id` is that subject, `document_version` its ordinal
— one past the subject's highest, proposed in the body and verified at the door —
`content_digest` the content digest, `effective_from` the event's own instant.
`subject_kind` and `artifact_event_kind` are also inside the body, because the
chain digests the body and not the columns, and replay holds every column to it.
A subject keeps its kind: an identifier used by one plane is refused by the other.

### The four read models, and the fold both doors share

`nextArtifactProjection` decides what an event writes against a view of the four
tables, and the door and the rebuild each hand it their own view — the base
inside the transaction, the snapshot being filled — so a planted history fails a
rebuild in the door's words. A `PUBLICATION_INTENDED` opens the next generation,
or reuses the one that is not reclaimed: a `PUBLISHED` one is conserved whole, a
`PUBLICATION_ABANDONED` one is staged again with its grace instant, a `STAGED` one
is refused because a publication is in flight. A reused generation keeps its
encryption, and an intention that disagrees is `LedgerArtifactEncryptionConflictError`.
The intention takes a `PUBLICATION` pin on the exact generation; its success
records the reference and releases the pin in one append, and its abandonment
releases the pin. A reference is recorded only over a `PUBLISHED` generation, a
`PUBLICATION` pin is never taken or released by hand, and taking the same pin
again is idempotent.

### What the door refuses by name

`RECLAIM_INTENDED`, `RECLAIM_COMPLETED` and `REFERENCE_TOMBSTONED` at
`artifactEventKind`: reclamation, collection and tombstoning are P-36 completo. A
`SECRET_BEARING` reference, which never enters the stream. An access policy other
than `SCOPE_EQUALITY_V1`, the one identifier closed in code while the policy table
has no dictionary (decision 59). Both rules run over **every** reference an event
carries, the `intendedReference` block of a `PUBLICATION_INTENDED` included
(P-36/local D, decision 69): the fold never reads that block, but it rides the
stream, and a rebuild meeting a planted one refuses it in the door's words. And every credential key or secret-shaped value,
by the contract's guards — the refusal names the path, never the value.

### What this escalón does not do

No filesystem: nothing opens, writes, synchronizes or renames a file, and no
read path resolves an artifact. No lease store — escalón B landed it as its own
file; see **The artifact blob lease store** below — and no publisher and no
reconciler: escalón C landed both, beside the ledger rather than in it; see **The
private artifact plane** below. No producer: nothing outside the suite appends an artifact
event. No contract bump: the escalón defines no preimage and no derived key.
`artifact-store` above is untouched and stays the legacy digest store it was.

## The command intention, and the quarantine it commits with

P-18/protocolo F (coordination §6.2, datos §11; ADR 0078). Three same-state types
on `execution` — `OUTBOX_COMMAND_INTENDED`, `OUTBOX_DELIVERY_INTENDED`,
`OUTBOX_DELIVERY_OBSERVED` — and **no table**. The separate outbox is a cache;
what the ledger records is the complete event, and a command's state is a fold
of at most one intention, its attempts and their observations.

### One intention, and an identity the door recomputes

The intention carries its saga, command id, phase, kind, stream, target,
deadline and the nullable pair of fence and target store incarnation, and
nothing else: the payload is closed and versioned `outboxContractVersion = 1`.
`commandId` is the digest of `(sagaId, phase, targetKind, targetId)` under
`OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1`; the door recomputes it and refuses one
that does not match. A command is intended once — the same one again is refused
as a reuse, another under its id as a `CONFLICT`. The V1 matrix is checked before
any of that: a kind outside it, or a stream this door does not realise, is
refused `CAPABILITY_UNSUPPORTED`.

### A quarantine commits with its intention to revoke

Inside the ledger the quarantine and the intention to revoke the lease are
atomic. A `REVOKE_LEASE` intention is admitted only inside `appendBatch`,
immediately after the quarantine event it answers — `WRITE_SET_VIOLATION_DETECTED`
or the move to `SUSPECT_WORKTREE` — of the same task, inserted by that same
batch. And a batch that moves a task to `SUSPECT_WORKTREE` without a
`REVOKE_LEASE` intention of its own rolls back whole. A unitary `append` of that
move is still admitted: the daemon's conformance gate writes one, and the
window is declared and fenced (`L-P18F-1`) until the adoption closes it.

### Attempts, observations, and what a lost cache comes back as

An attempt names its command and the intention as its causal reference; an
observation names the attempt as its own. A new attempt needs the command
`PENDING`, and the same attempt again counts once. An observation reports on the
attempt in force, moves the state by coordination §2's transitions, carries a
failure word from `OUTBOX_FAILURE_CODES` exactly when the state is a failure, and
nothing leaves a terminal state. So an intention with no attempt folds `PENDING`,
and an attempt with no outcome folds `RECONCILING` — never `PENDING`: losing the
cache never turns an uncertain delivery into one that may be resent.
`rebuildReadModel` and `verifyIntegrity` drive the same fold, so a stored history
the door would have refused fails the rebuild at the event that caused it.

### What this escalón does not do

No reconciler and no dispatcher: F records and folds, and the rules a future
reconciler must follow are written into ADR 0078. No migration. The contract
moves to `"2.4.0"`, because the door and the fold recompute an identity that did
not exist and every payload carries a version of its own — ADR 0076's criterion.

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
- **The fold validates no eligibility, and the door does** (amended by ADR
  0085). A rebuild folds what the door admitted, so a document whose payload this
  fold cannot read still projects **no row while the document still stands**,
  and an assignment whose model was retired afterwards is folded as recorded. The
  contract's fail-closed check on `model_version_id` is made at the append door,
  against `model_version_read_model`, before the insert — see the model version
  registry below.

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

## The model version registry, and the gate a GLOBAL assignment passes

Accounts §6's one registry of model versions is folded here from the registry
stream's `MODEL_VERSION` documents (P-14 A, migration 17, ADR 0085): a row per
document and two child tables, `model_version_eligible_role` and
`model_version_transport`, rather than JSON columns. The ledger folds it; the
semantics of resolving a role against it are `@acp/accounts`'.

### A fixed payload, held at the door

A `MODEL_VERSION` payload has exactly nine keys, the camelCase mirror of the
dictionary: `provider`, `model`, `release`, `status`, `contextTokens`,
`policyVersion`, `deprecatedAt`, `eligibleRoles`, `transports`
(`MODEL_VERSION_PAYLOAD_KEYS`). Every one is required and no other is admitted,
so a rating cannot be parked in the capability registry under a name nobody
reads. `status` is one of `MODEL_VERSION_STATUSES`; `deprecatedAt` is null if and
only if the status is `ACTIVE`; roles come from the worker vocabulary and
transports from the contract's `TRANSPORT_KINDS`, each once. A payload outside
the shape is a `LedgerValidationError` naming each path, and nothing is appended.

### What the door refuses for an assignment

After the replay, event-id and lineage checks and before the insert,
`appendRegistryEvent` holds a `ROUTING_ASSIGNMENT_GLOBAL` against the registry:

| Word at the head of the message | Path | When |
| --- | --- | --- |
| `MODEL_VERSION_UNKNOWN` | `payload.modelVersionId` | no model version with that id |
| `MODEL_VERSION_RETIRED` | `payload.modelVersionId` | retired: blocks, and proposes migrating to an ACTIVE version |
| `MODEL_VERSION_DEPRECATED` | `payload.modelVersionId` | deprecated: an assignment names ACTIVE only |
| `ROLE_NOT_ELIGIBLE` | `payload.role` | the version does not declare the role |

Each fallback is held to the same four rules at `payload.fallbacks[i]`. An
assignment the fold could not read is refused field by field before any lookup.
An exact replay of an assignment admitted before its version was retired is
still a replay. Transport is not in the assignment, so it is not checked here.

### The fold, the migration and the vector

The fold refuses nothing. The row is the version applied last, its children
replaced whole; a version the fold cannot read — only history from before
migration 17 can hold one — leaves no row and removes the one an earlier version
left. Migration 17 seeds one watermark at the registry head and, in the same
transaction, folds the model versions the stream already holds through the same
function the door and the rebuild write with.

`getGlobalRoutingAssignment` and `getModelVersion` read everything inside one read
transaction and return the watermark rows the answer came from, so a caller
records the vector it read and not whatever the registry has become since.

### What this escalón does not do

No product door publishes a model version or an assignment, and no task intake
records a resolution: escalones B and C of P-14. No `INITIATIVE`/`STEP` partition.
No lifecycle rule between versions and no check that a provider is stable across
them. The policy file and `resolveRoute` in `@acp/accounts` are untouched.

## The price interval catalog, and the gate a PRICE_TABLE passes

Economy §3's catalog is folded here from the registry stream's `PRICE_TABLE`
documents (P-33/catálogo A, migration 21, ADR 0091; decisions 87-89): one row per
interval of one document's version, the document **and** the version in every
key, so a lookup inside a pinned version never reads another. The ledger stores and
publishes the catalog; resolving a price at an instant is escalón B's.

### A closed payload, held at the door

A `PRICE_TABLE` payload is `{ intervals }` (`PRICE_TABLE_PAYLOAD_KEYS`), a non-empty
list. Each interval has exactly `provider`, `modelVersionId`, `transportKind`,
`tokenClass`, `currency`, `effectiveFrom`, `effectiveTo` and `pricePerMillionNanos`
(`PRICE_INTERVAL_KEYS`): `effectiveTo` present as null or as an instant later than
`effectiveFrom`, both instants in the canonical millisecond UTC form, a price that is
a safe integer of zero or greater, a transport of the contract's `TRANSPORT_KINDS`, a
token class of `PRICE_TOKEN_CLASSES` and a currency of three upper-case letters. The
document's id and version, and the event's author and sequence, complete the row.
The body stays under the registry's 64 KiB bound.

### What the door refuses, by name

After the replay, event-id and lineage checks and before the insert, on its own
branch of the registry gate:

| Word at the head of the message | Path | When |
| --- | --- | --- |
| `PRICE_INTERVAL_DUPLICATE` | `payload.intervals[i]` | the same primary key twice in the version |
| `PRICE_INTERVAL_OVERLAP` | `payload.intervals[i]` | two intervals of one `(provider, modelVersionId, transportKind, tokenClass, currency)` meet |
| `MODEL_VERSION_UNKNOWN` | `payload.intervals[i].modelVersionId` | no model version with that id is registered, in any status |
| `MODEL_VERSION_PROVIDER_MISMATCH` | `payload.intervals[i].provider` | the model version is registered under another provider |

A field outside its shape is refused at its own path first, before any lookup, and
one bad interval refuses the whole version: no event, no row. Adjacent intervals,
`[a, b)` then `[b, c)`, do not meet. A RETIRED model version keeps its price. The
transport is not held against the version's admitted transports.

### One fold, whole per version, in four places

`nextPriceIntervalProjection` writes every interval of a version or none of them: a
version whose payload it cannot read — only history from before migration 21 can
hold one — publishes no row, and nothing is refused. It asks for no model version:
existence was the door's. It runs at the door in the append's transaction, in
migration 21's retroactive fold over the stream a ledger already holds, in the
rebuild, and in `verifyIntegrity`, which names a rewritten, missing or unaccounted
row by its document and version. There is no lookup index beside the primary key:
the dictionary's index is the primary key's own.

### What this escalón does not do

No pin on a segment or a dispatch (P-15). No catalog on the artifact plane, no cost
snapshot, no valuation. Price resolution and `PRICE_MISSING` were escalón B's, and
are described next.

## Publishing registry configuration, through one door

A first task needs a model version, its role's GLOBAL slot and a catalog covering the
model, and `publishRegistryDocument` is how they are written (P-15 escalón R, ADR 0104;
decisions 127-131). It publishes exactly `PUBLISHABLE_DOCUMENT_KINDS` — `MODEL_VERSION`,
`PRICE_TABLE`, `ROUTING_ASSIGNMENT_GLOBAL` — and refuses every other kind by name.

The operator states the kind, the document and its version, the parent, the instant
the version rules from, the author and the payload. The publication derives the rest:

| Field | Derived as |
| --- | --- |
| `contentDigest` | `sha256Hex(canonicalJsonStringify(payload))` |
| `idempotencyKey` | `registry/<documentId>/<documentVersion>` |
| `eventId` | a version 5 UUID over the key, under `REGISTRY_PUBLICATION_UUID_NAMESPACE` |
| `occurredAt`, `recordedAt` | the door's instant, injected |
| `contractVersion` | the version in force |

The same version with the same kind, digest, parent and instant is a replay; the
author and the door's instants are not compared. Any other difference is
`REGISTRY_VERSION_CONFLICT` at the first field that differs. The ledger door's own
refusal is `REGISTRY_DOCUMENT_REFUSED`, with its field and closed word. Nothing is
defaulted in a price table: no interval, end, currency or price the owner did not give.

The registry door holds two rules of its own since this escalón, words at the head of
the message (`REGISTRY_DOCUMENT_REFUSALS`):

| Word | Path | When |
| --- | --- | --- |
| `REGISTRY_CONTENT_DIGEST_MISMATCH` | `contentDigest` | a document of `INLINE_CONTENT_DOCUMENT_KINDS` whose digest is not its payload's; checked first, for every writer, after the replay and lineage checks |
| `REGISTRY_EFFECTIVE_FROM_TAKEN` | `effectiveFrom` | a `PRICE_TABLE` version taking effect at the instant another version of the same document already does |

Both are write invariants. The fold re-verifies neither: stored history keeps its
digests, and a tie a ledger already holds opens, verifies and rebuilds, with no version
in force at its instant (decision 56's asymmetry).

## Resolving a price inside a pinned catalog version

`resolvePrice(intervals, pin, key, instant)` is the answer the catalog above exists
to give (P-33/catálogo B, ADR 0092; decisions 92-93). A **pure** function: the rows
of one version — as `readPriceIntervals` returned them — a pin, a key and the
dispatch's authoritative instant go in, and a verdict comes out. No database handle,
no clock, no identity, no I/O, so the same four arguments always give the same
verdict and a replay reprices a spend to the number the spend was charged.

| Verdict | Carries | When |
| --- | --- | --- |
| `{ status: "FOUND", interval }` | the row itself: the price, its currency, and the window it was read from | one interval of the pinned version prices the key at the instant |
| `{ status: "PRICE_MISSING", pin }` | the pin, and **nothing else** | no interval does |

There is no third member and no amount field that could be zero: economy §3 has no
fallback rate of `0`, and `PRICE_MISSING` with the pin intact is `:284-286`'s
sentence as a value — document and version kept, interval reference empty.

What it decides, in order: a null `modelVersionId` is `PRICE_MISSING` and never
aliased to another model version's price; the document and the version come before
everything, so a row of another version is not a candidate however current it looks;
the quintuple (`provider`, `modelVersionId`, `transportKind`, `tokenClass`,
`currency`) matches exactly, with no fallback between currencies, transports or token
classes; and the window is **half-open**, `effectiveFrom <= instant < effectiveTo`,
with a null `effectiveTo` meaning no declared end — so at the boundary between two
adjacent intervals exactly one prices the instant, and it is the later one.

It **selects and does not re-admit**: overlap, row shape and whether a model version
is still registered were the door's to decide (N-P14A-7), so at most one row of a
quintuple can cover an instant and the first match is the only match. A malformed pin
matches nothing and is answered missing.

**Nothing calls it yet, and L-P33B-1 holds that**: the resolution is reached through
this package's barrel by name and reimplemented nowhere, and the law admits no caller
at all until P-15 gives the pin a home on a segment or a dispatch. The caller's
instant is not validated here — it must be the canonical millisecond UTC form the
catalog's own columns carry — which is a boundary P-15 makes checkable.

## An initiative's registration, by command and by API

The gateway's `POST /api/v1/initiatives` and the CLI's `acp initiative` register
an initiative through one orchestration, `registerInitiative` (P-14 B, migration
18, ADR 0086). The doors open a writable ledger, the blob lease store and the
private plane, mint the identifiers and read the clock; everything about whether
a registration may be recorded and what it says lives here.

### The request is not the payload

The candidate is composed from the request — the caller's own `initiativeId`, the
slug, the title, the objective — with this build's contract version, `ACTIVE` and
the recording instant, and parsed through `@acp/contracts`' `Initiative` whole, so
the credential guards run over the objective before anything is published. The
event records a closed payload of four keys, `INITIATIVE_REGISTRATION_PAYLOAD_KEYS`:
`slug`, `title`, `objectiveSha256` and `objectiveArtifactReferenceId`. The objective
is never in `event_json`. The append door does not close the payload — the
contract's is still a bounded record, and history written under another shape
stays readable — the orchestration is the one producer of the closed shape.

### The key, the replay and the conflict

The idempotency key is `initiativeId/1/register`. A registration under an id the
stream already holds is compared with the recorded event, field by field: the same
slug, title and objective digest is a replay that publishes nothing, appends
nothing and answers the row that exists; any difference is `CONFLICT` at the field
that differs. A registration older than the closed payload compares as different.
An append that loses a race re-reads the stream and decides again.

| Refusal | At | When |
| --- | --- | --- |
| `REQUEST_INVALID` | `candidate.<field>`, or `recordedBy` | outside `Initiative`, a credential in the objective, a status other than `ACTIVE`, a producer that is not a worker identity |
| `CONFLICT` | `candidate.slug`, `candidate.title` or `candidate.objective` | the id is registered with other content |
| `CONTENT_REJECTED` | the plane's own word | the plane refused or abandoned the objective's publication |
| `WRITE_CONFLICT` | `objective` or `initiativeId` | another writer's publication or registration landed first and the re-read found neither a replay nor a conflict |

### The objective in the private plane

The objective's UTF-8 bytes are published as a `PLAN_DOCUMENT`, `INTERNAL`,
scoped `INITIATIVE`/`initiativeId`, `PERMANENT`, under `SCOPE_EQUALITY_V1`, as
`text/plain; charset=utf-8` in plaintext. The intention and terminal keys are
derived from the initiative and the digest, so one objective of one initiative
has exactly one publication: a retry finds the intention by its key and reuses its
identities, instants and reference, and whatever identifiers the retry's door
minted are ignored. The holding is taken under the door's `recordedBy` and pid for
an informative five minutes. Two initiatives with one objective share one blob
and hold two references, and neither can read the other's.

### The migration, and the read back

Migration 18 adds `title`, `objective_sha256` and `repository_sha256` to
`initiative_read_model` in place, nullable, and folds the initiative stream again
in the same transaction so a registration already recorded in the closed payload
is level with its row. No watermark, schema object or derived table moves. The
gateway's initiative read serves the objective through `readInitiativeObjective`,
which opens the plane over the handle it is given with a lease store that refuses
every holding, only after the private root was seen to stand.

### What this escalón does not do

No task intake and no `client_scope`: escalón C delivered both, beside this, in
**A task's intake and its client key** below. No reconciliation of a holding a
dead process left inside a publication — the plane answers `QUIESCENCE_UNPROVEN` —
and no retry of a publication that ended abandoned: the pair is refused
`PUBLICATION_ALREADY_ABANDONED` until another decision. No producer of
`repository_sha256`. A reference published and not yet named by a registration,
because the process died between the two, stays until a retry names it.

## A task's intake and its client key

P-14 escalón C (ADR 0087; decisions 77-79). The orchestration that enters a task,
`intakeTask`, lives in `@acp/runtime`, because it resolves the role through
`@acp/accounts` and this package may not import it. What lives here is the ledger's
half: the fold of the intake, the client key's one home, and the refusals that keep
both true.

### The intake, as the stream records it

An intake is one `TASK_DISCOVERED` from no state under its own transition,
`TASK_INTAKE_TRANSITION_ID` (`intake`), keyed V2 at revision 1, attempt 1. Its
payload is closed — `TASK_INTAKE_PAYLOAD_KEYS`: the revision record the fold already
reads by presence, the initiative, the client key, the roadmap link as a pair, the
role, the commit policy and a `resolution` (`TASK_INTAKE_RESOLUTION_KEYS`) with the
vector of watermarks it was read at. The envelope is not in it. `taskIntakePayloadOf`
is the fold's one reading, and it is total: anything short of the closed shape is not
an intake, and folds as it did before. `nextTaskProjection` writes `step_id`, `role`
and `commit_policy` from an intake once and carries them. An intake's task reads
`latest_attempt_number` 1 with no attempt row: the attempt row is born of its own
opening, and an opening from nothing is refused for a task an intake opened.

### The client key

Migration 19 creates `task_submission_read_model`, `STRICT`, unique on
`(client_scope, client_request_key)`, with no trigger and no foreign key, seeds its
watermark at the task head and folds the task stream again in the same transaction.
The row is insert-only by the fold: its task, revision and digest come from the same
revision record the revision row does. The same key naming the same row is a replay;
naming anything else is refused by `assertSameTaskSubmission` with
`LedgerIdempotencyConflictError` — at the append door and in `applyEventToSnapshot`,
by one comparison — so a door that lost a race reads the class and decides again, and
never meets a `SqliteError`. `verifyIntegrity` compares the rows both ways.

## A usage settlement, folded before anything records one

P-32/captura escalón A (ADR 0088; decisions 80-82). Economy §1–2 records spend as
observations on measurement streams and folds them, per effect, into a settlement
revision. This escalón lands the half that can be a pure function, in
`usage-settlement/`, and nothing else: no migration, no event type, no door. The
module was **inert** — the fence held that no source outside it and the barrel named
it — until escalón B's door called the fold and retired that law (next section).

### The stream identity

`measurementStreamIdV1(coordinate)` is the SHA-256 of
`USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1` (`acp/usage-measurement-stream/v1` and one
LF) followed by the canonical JSON of the positional array `[source, accountId,
routeSegmentId, sourceEpoch]`, with no separator; `measurementStreamPreimageV1` is the
first step, exported so a vector pins each. It takes the coordinate, never a preimage,
and refuses a field by name before hashing — three non-empty texts and a safe epoch
`>= 0` — as a `LedgerValidationError` opening with `STREAM_COORDINATE_INVALID`. The
provider's reusable connection id never enters; a restarted counter is a new epoch and
so a new id.

### The policy and the version

`USAGE_SOURCE_POLICY_V1` is the precedence and coverage policy as a frozen literal
document; `USAGE_SOURCE_POLICY_SHA256_V1` is its canonical digest, and a test pins the
hex. `USAGE_FOLD_VERSION_V1` is `1`. The fold refuses a request whose policy digest or
fold version is not the one it runs (`POLICY_UNSUPPORTED`, `FOLD_VERSION_UNSUPPORTED`):
a header never stamps a version that did not execute.

### The fold

`foldUsageSettlement(request)` takes the cut (effect and control head), the trigger
(sequence and instant), the effect's streams with their class, its observations, the
previous revision and the trigger sequence of the last FINAL one, the policy and the
fold version. It returns `{ ok: true, settlement }` — the §2.1 header with the five
counts as `bigint | null`, the vector with the control row only, every considered
observation id by sequence, and the per-segment election — or `{ ok: false, reason,
at }` with a word from the sorted, closed `USAGE_SETTLEMENT_REFUSALS`. DISPUTED is a
settlement, never a refusal.

- Inside a stream, reports are read by ordinal. A chain of corrections ends in one
  effective report that takes the last correction's values and the root's coverage; two
  corrections of one report are `CORRECTIONS_FORKED`. A DELTA overlapping an effective
  range, a partial overlap, and a CUMULATIVE strictly inside an earlier one are
  `COVERAGE_OVERLAP`; a CUMULATIVE containing earlier ranges whole replaces them.
- The four token classes are exclusive; a total that is not their sum is
  `TOTAL_MISMATCH`, sums run in `BigInt`, and a published count above
  `USAGE_SETTLEMENT_TOKENS_MAX` (int64) is `TOKENS_OVERFLOW`.
- A lineage `(source, account, segment)` sums its epochs and carries one class. Inside a
  segment lineages compete: the highest class wins; equal-class winners that agree on
  all four sums yield the least stream id, and ones that disagree make the settlement
  DISPUTED with five NULL. Across segments the elected coverages sum.
- FINAL needs every elected stream gapless and with an effective `is_final = 1`;
  otherwise PARTIAL; with no observation, UNKNOWN. `had_late_arrival` is 1 iff an
  observation arrived, by ledger sequence, after the last FINAL revision's trigger —
  never by `occurred_at` or ordinal. The revision is the previous one plus one;
  `computed_at` and `sequence` are the trigger's.

### What this escalón does not do

No table, migration, event type, append door, rebuild or read verb (B). No recorder
(C). `TOKEN_USAGE_RECORDED`, the rollups and the quota estimate are untouched. No
price, cost or valuation (P-33).

## Usage, declared and measured, and settled by the door

**Where the vocabularies live (P-15/D2, ADR 0105; decision 137).** `USAGE_SOURCE_CLASSES`
and `USAGE_REPORT_KINDS` are declared in `@acp/contracts` — the execution port's usage
report names a kind, and a port shape cannot import this package — and
`usage-settlement` re-exports them under the same names. The read models' unions
derive from them; migration 20's CHECK text stays as written and a test holds it equal
to the constants; `USAGE_SOURCE_POLICY_V1.precedence` stays a literal, attested by its
digest.

P-32/captura escalón B (ADR 0089; decisions 83-85). Economy §1.2 writes a stream, an
observation and the settlement with the append and the head in one transaction, so
migration 20, two event types, the door and the rebuild land together, and escalón
A's fold is what they call.

### Two events, and what each carries

`USAGE_STREAM_DECLARED` records a measurement stream before its first report;
`USAGE_OBSERVATION_RECORDED` records one report on it for one effect. Both are
same-state passthroughs — the door refuses a moved state — on the stream's
`progress` channel, and both payloads are closed: the V2 coordinate and one record,
`usageStream` (`USAGE_STREAM_RECORD_KEYS`) or `usageObservation`
(`USAGE_OBSERVATION_RECORD_KEYS`), and no other key. An observation carries no source
class, no `recordedAt` and no `sequence`: the class is the stream's and the other two
are the event's. `CONTRACT_VERSION` is `"2.6.0"`: the door recomputes the stream's id
and every declaration names its adapter's normalization policy (ADR 0076's criterion).

### What the door refuses, by name

- A stream id that is not `measurementStreamIdV1` of its coordinate
  (`STREAM_COORDINATE_INVALID`); a segment nobody opened, or one of another attempt; a
  stream already declared with another class or policy. The same stream restated
  writes nothing and keeps its first `sequence`.
- A report on a stream nobody declared (`STREAM_UNKNOWN`); an effect nobody intended;
  an effect of another attempt than the event's, or a stream whose segment is of
  another attempt than the effect's; an effect with no delivery yet — nothing was
  spent, and its first delivery is what opens its settlement.
- A shape `ck_usage_observation__report_shape` would refuse; a total that is not the
  `BigInt` sum of the four classes (`TOTAL_MISMATCH`); a count that is not a safe
  integer `>= 0`. The same observation restated writes nothing; the same id with
  other bytes is a conflict; another id at a held ordinal or source report id is
  `ORDINAL_DUPLICATE` or `SOURCE_REPORT_DUPLICATE`; a correction of a report of
  another stream or effect, of nobody, or of itself.
- Whatever the fold refuses once the report joins the effect's others —
  `COVERAGE_OVERLAP`, `CORRECTIONS_FORKED`, `TOKENS_OVERFLOW` — raised as the event is
  projected, inside the same transaction, so nothing of it commits.

### The settlement, and the exposure

`nextUsageCapture` is the one function the door (`#projectEvent`), the rebuild
(`applyEventToSnapshot`) and migration 20 call. An observation writes itself and the
effect's next revision, folded with every report of the effect at the event's own
head: the vector's control row is the trigger's sequence and chain digest, so a
rebuild at a later head reconsiders nothing the trigger did not see. A
`DISPATCH_INTENDED` of an effect that has no revision writes revision 1 — `UNKNOWN`,
five NULL counts, an empty list, no observation invented — and one of an effect that
has a revision writes nothing, whatever its ordinal. A non-final report after a final
one is admitted and is the late arrival: a new revision with `had_late_arrival = 1`;
only a correction withdraws a final.

Migration 20 folds the task stream through the same function as it lands, so every
effect a ledger already delivered has its exposure at its first delivery's sequence,
digest and instant. `verifyIntegrity` compares the five tables with a replay as text,
every integer as its digits, so a sum past `Number.MAX_SAFE_INTEGER` is compared
exactly.

### What this escalón does not do

No recorder or producer, and no read verb or route (C and later). No FINAL and no
zero by default. `TOKEN_USAGE_RECORDED`, the rollups and quota are untouched. No
price, cost or valuation (P-33).

## A roadmap version is decided at the door, and unique by number

P-26/A (ADR 0110; requirement A2): revisions are immutable, carry author, digest
and OCC, and `(initiative_id, version)` uniqueness is a constraint, not a convention.

### The door decides

Optimistic concurrency on an initiative's roadmap is the door's, not the caller's.
`appendInitiativeEvent` runs `decideRoadmapVersion` under the append's own
`BEGIN IMMEDIATE`, after the exact replay, the identity check and the contiguity
guard and before causation, head and `INSERT`, over `listRoadmapVersions`' fold,
which that transaction keeps level with the stream. An exact replay returns the
stored record and is never re-judged, even after the head moved; the same key with
other content is `LedgerIdempotencyConflictError` before any decision; a new event
whose version is not the head's successor, or whose claims about the head are
false, is `LedgerRoadmapVersionRefusedError` with the decision's word. A payload
naming another initiative is refused even on a first version. The seventh word,
`VERSION_ID_REUSED`, refuses an identity the fold already holds.

### Insert-only, on both keys

A recorded version is immutable: the read model's write is a plain `INSERT`, and
the fold shared by the live step and the rebuild refuses a second claim on a
`roadmapVersionId` (`VERSION_ID_REUSED`) or on an `(initiativeId, version)`
(`VERSION_NOT_MONOTONIC`) by name, before the primary key or the unique index could
refuse it anonymously. A payload that is not a `RoadmapVersion`, or names another
initiative, is refused too, where it used to project nothing. A ledger whose stream
already holds such an event no longer rebuilds; `verifyIntegrity()` reports it as a
`PROJECTION` problem at its sequence rather than throwing.

### Migration 24, and what its failure does

Migration 24 adds `ux_roadmap_version_read_model__initiative_id__version`, a unique
index beside migration 4's plain one, and nothing else. Its preflight counts the
**stream**, not the read model, for both families — two events with one
`(initiativeId, version)`, two with one `roadmapVersionId` — and names up to twenty
of each, as UUIDs and integers, inside `LedgerMigrationError`. A refusal rolls back
every pending migration: the ledger stays at 23 and does not open under this build,
while the previous build still opens it. Nothing is deduplicated, renumbered or
deleted; what to do with such a ledger is the owner's decision (an exception entry,
or a quarantined ledger).

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
where the policy is. It deletes nothing, probes no process, mints no identity,
and composes exactly one path — `toolClaimStorePath`, derived from the ledger's
own. Since P-18/E1 it also carries its own incarnation; see **The incarnation
every coordination store carries** below.

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

## The outbox message store

A fourth database, answering a fourth question. The ledger answers *what
happened*; the worktree arbiter answers *may I write here, now*; the claim store
answers *may I run this tool call, now*; this one answers *what should I send,
now*.

It is a **cache of delivery and nothing else**. The durable fact that a command
was intended is an event in the ledger, and losing this entire file costs
liveness rather than evidence — so an absent outbox answers absence as absence
and never synthesises a `PENDING` for work nobody owes.

`openOutboxStore` gives one row per command, with `UNIQUE (command_id)` and a
compare-and-set over a persisted `row_version`. That is the one thing the other
two arbiters do not have, and the reason is structural rather than stylistic.
They take the write lock at `BEGIN` and run the caller's decision inside it, so
the decision sees the state it is deciding against. An outbox row is read by one
process, carried across an **external dispatch**, and written back afterwards —
and no lock may be held across a network call. The window between the read and
the write is what the version closes.

The store's value types — the anchor, the incarnation, the row, the seed, the
token, the mutation, the compare-and-set outcome, the handle and its options —
are declared in the pure type leaf `src/outbox-store/types/index.ts` and
re-exported by the store's module, exactly as the P-18 reading types of the
projection live in `src/projection/types/index.ts` (CORR-2). No import changes.

A read returns four things: the file's incarnation, the command, the version and
the state. A mutation hands the same four back. Three of them are the `UPDATE`'s
predicate; the fourth is not a column of the row at all.

**Why the fourth matters.** Every row is born at version zero, so restoring this
file from a backup produces rows whose versions repeat numbers that were already
issued — and a token held from before the restore matches a rebuilt row in every
term. The incarnation is the only thing that separates them. It lives once per
file in `coordination_store_meta`, it arrives as an argument rather than being
minted here, and it is read **inside** the transaction on every mutation: a
handle that read it at `open` would carry a stale answer into the first decision
taken after a restore, which is exactly the decision that matters.

**Zero rows changed is a value, not an exception.** It means re-read and decide
again — never a success and never an implicit resend — so `cas` returns
`CONFLICT` with the row as it actually stands. A mutation that would write
nothing returns `UNCHANGED` and writes nothing, including the `updated_at`
stamp: an effective change increments the version, and were the instant counted
as substance, no retry could ever be a replay. More than one row changed is not
a refusal but a missing unique index, and throws.

**Nothing moves by the clock.** An expired message obliges a caller to
reconcile; it does not authorise this store to transition anything. There is no
`sweep` — `listOverdue` reads and returns, and that is the whole of this store's
relationship with an instant.

It reads no clock, mints no identity, deletes nothing, and composes exactly one
path — `outboxStorePath`, derived from the ledger's own. It does **not** derive
`command_id`: the key is deterministic over the saga coordinate, the producer
computes it, and this store imposes uniqueness and nothing else.

**Nothing calls it yet.** This is substrate, landed alone and adopted later, the
way the worktree arbiter and the claim store were. The saga, the command
identity and the events that rebuild a row from history arrived in P-18/protocolo
F, in the ledger rather than here — `listOutboxCommands` is what a row is rebuilt
from (ADR 0078). `readToken` reads the row and the incarnation from one read
transaction, so a token never pairs a version with another incarnation's id.

## The artifact blob lease store

P-36/local escalón B (artifacts §7-§9, coordination §8.1; ADR 0082). A fifth
database, answering the question artifacts §8 asks **first**: *may I operate on
these bytes, now?* One holding per digest, whichever operation it is —
`PUBLISH` or `RECLAIM` — held from before the intention is recorded until the
filesystem has finished.

`openArtifactBlobLeaseStore` opens `artifact-blob-leases.sqlite`, whose path has
one producer, `artifactBlobLeaseStorePath`, derived from the ledger's own. It is
built in the outbox's mould: its own migration list under
`artifact_blob_lease_schema_migrations`, `coordination_store_meta` as migration 1,
a **required** incarnation, and the wrong-file guard that refuses the ledger and
every sibling before writing. Migration 2 is artifacts §7's table: the digest as
the whole primary key, a positive generation, the two-word operation, five
operation columns that are null exactly when the operation is, and a partial
unique operation id. Two triggers validate the incarnation on insert and update
and hold the generation rule: a new holding advances it by exactly one, the same
holding conserves it, a release conserves it, a revocation advances it, and a
free row stays where it was freed. No row is ever removed.

Every verb is one immediate transaction with the decision inside the lock, as in
the worktree arbiter — no version is carried across a dispatch here.

| Verb | What it does |
| --- | --- |
| `acquire(grant)` | Take a free blob: generation 1 on the first grant, `OLD + 1` over a freed row. A holding answers `HELD`, expired or not; the grant that already stands answers `UNCHANGED`. |
| `release(token)` | The holder's own. The whole token — incarnation, generation, holder, operation id — is compared; the generation is conserved. |
| `revoke(token, quiescence)` | End a quiescent holder's holding without granting it. `OLD + 1`. |
| `takeOver(token, quiescence, grant)` | Grant a quiescent holder's blob to someone else at `OLD + 1`, against the incarnation and generation observed. Two reconcilers on one observation: one wins. |
| `read` / `readToken` / `incarnation` | The row, the token of the holding that stands, this file's incarnation read now. |
| `listOverdue(now)` | The holdings expired at `now`. Reads, and moves nothing. |

**The store does not read the ledger.** The blob's state — staged, published, a
generation to deduplicate — is consulted by the publisher inside the ledger's
append, which is step 2 of §8. The two files share no transaction, and none is
claimed.

**Nothing frees a blob by the clock.** Expiry enables reconciliation and
concedes nothing; there is no `sweep`.

**Quiescence is named, not proven.** The store reads no process, so it cannot
tell whether a holder is dead and reaped. The two verbs that end somebody else's
holding therefore require a quiescence attestation — `DEATH_AND_REAP_PROVEN` or
`STALE_FENCE_REFUSED_BY_BACKEND`, and the pid it is about — and refuse one that
names a process the row does not record. The proof is the caller's.

**Refusals are values.** `HELD`, `OPERATION_ID_IN_USE`, `NOT_HELD`,
`INCARNATION_SUPERSEDED`, `GENERATION_SUPERSEDED`, `HOLDER_MISMATCH` and
`QUIESCENCE_OF_ANOTHER_PROCESS` are facts about the file, returned with the row as
it stands. A malformed argument — a digest that is not 64 lowercase hex
characters included — throws `LedgerQueryError` before the database is touched.

A holding written under an incarnation that has since rotated is frozen, not
freed, and a file with lease rows but no metadata is refused at `open`: the
procedure that re-issues holdings is coordination §8.2's.

**Its one caller is the private artifact plane** of escalón C, below; nothing in the field calls either yet.

## The private artifact plane

P-36/local escalón C (artifacts §8-§10; ADR 0083, decisions 64-66). The module
that moves the bytes a digest names, over the ledger's artifact door and the blob
lease store, under a subroot of its own: `private-artifacts/`, a sibling of the
legacy `artifacts/` below, produced only by `artifactPlaneRootFor`. The legacy
store and its readers resolve a bare digest there and cannot reach a private
object here.

`openArtifactPlane({ ledger, leaseStore, ledgerPath })` creates the subroot
`0700` if it is absent, refuses a link or a non-directory, resolves it **once**
and records its device and inode; every entry point checks that the directory at
that path is still the one resolved.

### A publication, in §8's order

| Step | What happens |
| --- | --- |
| 1 | `acquire` a `PUBLISH` holding, operation id = command id. A holding of another command answers `LEASE_HELD`, and nothing else moves. |
| 2 | `appendArtifactEvent(PUBLICATION_INTENDED)`: the generation and ordinal proposed from the ledger under the holding, and the reference to be recorded carried as `intendedReference`. |
| 3 | Staging `<digest>.staging` in the shard, opened with `O_EXCL` and `O_NOFOLLOW`, then `fchmod 0600`; written; re-opened and **verified**; `fsync`; `rename` onto `<2hex>/<digest>`; `fsync` of the shard. |
| 4 | `appendArtifactEvent(PUBLICATION_SUCCEEDED)` with the intention's own reference: the reference and the pin's release in one append. |
| 5 | `release`. A refused release is reported in the outcome and the publication stands. |

**The reference is named only after the bytes survived the directory's
synchronization.** Bytes already at the digest's path are verified and never
rewritten; bytes there that do not verify, or a link, are neither overwritten nor
removed, and the publication is abandoned. The one unlink in the module is of its
own staging path. Before every filesystem mutation and before the success the
plane reads the token again and stops with `LEASE_SUPERSEDED` if its holding no
longer stands — defence in depth; quiescence before a take-over is the guarantee.

Refused before the lease is asked for: a declared digest or size the bytes
disagree with (the plane computes both), content over
`ARTIFACT_PLANE_CONTENT_MAX_BYTES`, `ENCRYPTED_AT_REST` by name, a `SECRET_BEARING`
reference, a policy other than `SCOPE_EQUALITY_V1`, and a credential sentinel in any
metadata field — the contract's guards run over the intention and the success
the request would record.

**Every identity is the caller's**: event ids, idempotency keys and instants, the
command, pin and reference ids, the holder, its pid and any quiescence
attestation. The plane reads no clock, no process and no environment.

### Reading

`read({ artifactReferenceId, scopeKind, scopeId })` authorizes by reference and
scope, never by digest: `SCOPE_EQUALITY_V1` is equality of kind and id, a `SYSTEM`
reader reads only a `SYSTEM` scope, and a foreign scope gets the same
`REFERENCE_NOT_READABLE` as an absent reference. Expiry is not read — expiring
revokes nothing. Then `CONTENT_DELETED`, `BLOB_NOT_PUBLISHED`,
`ENCRYPTED_AT_REST_NOT_DELIVERED`, and the bytes opened with `O_NOFOLLOW` and
verified: `CONTENT_ABSENT`, `SYMLINK_REFUSED` or `CONTENT_DOES_NOT_VERIFY`, never
an empty answer and never unverified bytes.

### Reconciling a crash

`reconcile({ contentSha256, holding, quiescence?, terminal, recordedBy })` checks
the digest's form first, then decides from the lease row and the live publication
pins of that digest:

| What stands | What it does |
| --- | --- |
| a `PUBLISH` holding, no attestation or one about another pid | nothing: `QUIESCENCE_UNPROVEN` / `QUIESCENCE_OF_ANOTHER_PROCESS` |
| a holding whose command has no live pin (crash 1→2, or 4→5) | `revoke`; no file, no event |
| a holding whose command has a live pin (crash 2→3, 3→4) | `takeOver`, then steps 3-5 without bytes: a destination that verifies completes the intention's reference field for field; absent or unverifiable bytes are abandoned, keeping the grace instant |
| no holding, a live pin | `acquire`, and the same |
| either of the two above, and the ledger refuses the success the bytes earned | `PUBLICATION_ABANDONED` under the same terminal identity, `REFERENCE_REFUSED_BY_DOOR`; the bytes stay and the lease is released |
| a `RECLAIM` holding / nothing | `HELD_FOR_RECLAIM` / `NOTHING_TO_RECONCILE` |

An intention without `intendedReference` — another producer's — is abandoned even
over valid bytes, which stay. One with a block the door admits on the intention
but refuses on the success — a reference id already registered — ends the same
way; a `SECRET_BEARING` block or a foreign policy never reaches the reconciler,
because the door refuses the intention itself (P-36/local D). **No refusal leaves a digest held**: `publish`
refuses a reference id the ledger already records before the lease (unless it is
this command's own recorded success, which replays), a success the door still
refuses is the abandonment in the table, and any other failure of a terminal
append releases the holding and is thrown with the pin live. `publish` refuses a
`RECLAIM` holding under its own command id with `HELD_FOR_RECLAIM`, as
`reconcile` does. A restarted publisher calls `publish` again with the
same request and an attestation: it takes the holding over, **finds** its
intention rather than appending it again, and continues from step 3. It must name
itself differently from the holder it displaces: the store answers a take-over
under the same holder as a replay and would keep the dead pid on the row.

Eight test-only fault seams sit between the steps (`afterLeaseAcquired` …
`afterOutcomeRecorded`); the suite crashes at each and reconciles from a new
plane over the same files. **Nothing in the field calls the plane yet.**

## The incarnation every coordination store carries

Four of the five databases in this package coordinate rather than record: the
worktree arbiter, the claim store, the outbox and the artifact blob lease store.
Each of them hands out a number that a caller carries away and brings back — a
`fence`, a `claim_id`, a `row_version`, a `generation` — and every one of those
numbers **repeats** when the file is lost and rebuilt. A fence and a generation
restart at 1. A version is born at 0. A claim replayed into a new file carries
the id it always had.

So the number is never the token. Each of these files carries one row of
`coordination_store_meta`: the kind of store it is, out of a closed dictionary of
five, an incarnation, and the instant that incarnation began. The token is the
**pair** — `(store_incarnation_id, fence)` for a lease, the incarnation plus
`claim_id` for a claim, the incarnation plus command, version and state for an
outbox message, `(store_incarnation_id, generation)` plus the holder's identity
for a blob lease — and a token whose number matches a rebuilt record is refused
anyway.

Three properties hold across all four stores, and a fence law keeps each one:

- **The kind is the identity, not the filename.** A file whose metadata declares
  another store's kind is refused at `open`, before a handle exists. The `CHECK`
  carries all five kinds rather than the one each file uses, because a constraint
  narrowed to one value would make that refusal impossible to construct — and a
  guard nobody can drill is not a guard.
- **Nothing mints an identity.** The incarnation and its instant arrive as
  arguments, always. A UUID generated inside one of these modules would read an
  environment they may not read, and would make a restore drill impossible to
  aim.
- **The incarnation is read inside the lock, and before the number.** A handle
  that read it at `open` would carry the answer from before a restore into the
  first decision taken after one.

**The adoption window, stated.** The outbox and the artifact blob lease store
require an incarnation: they were built after the rule and have no callers. The lease store and the claim store take it
as an **optional** argument, because they were shipped first and their callers —
the daemon, the CLI, the gateway — open them with no options at all. A file with
no metadata registers none and refuses nothing: grants stamp `NULL` and no token
is compared. Until a packet makes those callers supply an incarnation, what the
pair proves is proven in this package's suite and not in the field. ADR 0075
records the window; refusing at runtime for missing metadata is forbidden there
by name, because it would close the window by stopping the daemon.

**The lease's revocation, and its acknowledgement.** P-18/protocolo F gave the
worktree arbiter the two verbs coordination §3 `:96-97` describes. `REVOKE`
advances the fence by exactly one, clears the holder and stamps the ledger
command it serves in `operation_id`; `ACKNOWLEDGE_REVOCATION` records
`revocation_acknowledged_at` and does not move the fence again. A grant may
carry the command it answers, and a release or a sweep of a live grant ends
that correlation, so a released record never passes for a revocation. No
trigger and no token compare-and-set came with them: decision 46's retrofit is
still its own packet.

In the two retrofitted stores the metadata is migration **2**, behind the table
it governs, and the new columns are nullable on every row written before them:
migration 1 shipped, its checksum is compared on every open, and editing it would
make every file in the field refuse to open. The suite pins version 1's digest
as a literal so that an edit fails a test instead.

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
