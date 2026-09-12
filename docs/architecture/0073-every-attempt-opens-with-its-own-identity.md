# ADR 0073 — Every attempt opens with its own identity, assigned once

- Status: accepted (P-18/protocolo escalón B, recorded 2026-09-12).
- Supersedes: none.
- Superseded-by: none.
- Amends: nothing. ADR 0067 said attempts "are not here — they are P-18's" and
  ADR 0072 said "the attempt identity table they populate (escalón B) [is] not
  decided here". This record is that escalón, so it completes two deferrals
  rather than revising either, and neither file is touched.

## Context

Execution §3 specifies `task_attempt_read_model`: a triple primary key
`(task_id, revision_number, attempt_number)`, a foreign key on the revision, a
globally unique `invocation_id`, a flat `legacy_attempt_number` that is
"asignación plana, monótona por tarea y estable para esta coordenada", and
`ck_task_attempt_read_model__outcome_pair`. Streams §1.1 adds the reason the
flat number has to exist at all: migration 1 is immutable and
`control_plane_events.attempt` is `NOT NULL`, so a task with revisions and
attempts does not fit the integer it already has, and every new row still has to
populate it.

Migration 11 gave the stream the revision coordinate and deliberately added no
event type: the coordinate rides payload keys, so the revision fold keys off the
**presence** of a complete key set. ADR 0072 then opened the contract's door so a
V2 key could actually be composed. What was left was the rung above — the
attempt — and three questions execution §3 states but does not settle.

**Who assigns the flat number.** §3 `:122` says that in `BEGIN IMMEDIATE` the
coordinate is looked up and, if absent, `1 + MAX(attempt)` of the task's events
"se asigna". Read literally, the ledger writes a number into the event. But an
event arrives *signed*: `canonicalJsonStringify` runs before the transaction
opens, `event_sha256 = chainDigest(previous, canonicalJson)` covers `attempt`,
and `ControlPlaneEvent` requires `attempt` on every event. A ledger that
"assigned" would have to recanonicalize and rehash a body its caller had already
hashed, or grow a second append path that builds and signs events of its own.

**Whether the attempt has an event type of its own.** Migration 11's precedent
says no new type; the adjudication (Q5) says every type P-18 does add is a
same-state passthrough and that the `CONTROL_PLANE_EVENT_TYPES` pin moves per
escalón, declared.

**What holds the pairing between the payload and the legacy column.** Migration
11 put a trigger on `control_plane_events` for `revisionNumber`/`attemptNumber`,
"porque sostiene la línea contra un writer que esquiva la puerta". The flat
number is a third value of the same kind.

## Decision

**One.** `task_attempt_read_model` arrives in migration 12, exactly as execution
§3 specifies it, with both unique indexes and both `CHECK`s. It enters
`DERIVED_TABLES` **before** `task_revision_read_model`, because `foreign_keys` is
ON and the rebuild clears children before parents. Its watermark is seeded from
`ledger_meta`, never from a literal zero.

**Two.** The opening is a **new event type**, `TASK_ATTEMPT_OPENED`, a same-state
passthrough on the `execution` channel. `CONTROL_PLANE_EVENT_TYPES` moves 24 →
25 — the pin P-05/B managed not to touch and this escalón cannot avoid.

Its payload is the coordinate, the revision record, and the two identity facts:
`{revisionId, revisionNumber, attemptNumber, envelopeSha256,
restoredFromRevisionId?, invocationId, legacyAttemptNumber}`.

**Three.** The producer **proposes** `attempt` and `legacyAttemptNumber`. The
ledger computes the expected value inside the transaction and refuses, by name,
if the proposal differs:

- the coordinate already exists → its assignment and its `invocation_id` are
  reused, and a different invocation for the same coordinate is refused;
- it does not → `1 + MAX(attempt)` over every event of the task, legacy rows
  included, and `1` for a task with no events.

The 10 000 cap is checked on the **computed** value, before the comparison. No
new append API, no recanonicalization, nothing mutated after signing.

**Four.** The pairing rule `payload.legacyAttemptNumber = attempt` is a typed
refusal at the append door, **not** a fourth trigger. The `tr_` inventory stays
at eight.

**Five.** Escalón B writes **no closer**. `ended_at` and `outcome` are `NULL` on
every row it produces.

## Why the producer proposes and the ledger verifies

This is the reading that the shape of an append admits. The alternative —
`openAttempt(...)` building, canonicalizing and signing an event inside the
transaction — matches §3's verb more closely and costs more than it is worth: a
second entry on the ledger's public surface, a second code path that produces
events, and a fork in the one place this package keeps deliberately singular. The
chain, the idempotency key and the projection all flow from one `append`, and a
door that sometimes authored its own events would make "what did the caller
record" a question with two answers.

Streams §1.1 is the authority that settles it in words: the repetition
"reutiliza la asignación existente mediante `compare-and-set` sobre la
proyección". A compare-and-set compares something against something. What the
producer proposes is the left side.

The refusal names the expected value, which is what makes the division workable
rather than merely defensible: a producer that read a stale projection is told
what the assignment actually is, in one round trip, and can retry with it.

## Why the attempt gets a type and the revision did not

Not inconsistency — the two folds answer different questions.

A revision record is *entirely* derivable from payload keys that any event may
carry: `revisionId`, `envelopeSha256` and the coordinate. Two events of one
revision that both carry them agree by construction, so a fold keyed off presence
is safe and ADR 0067 could avoid the pin.

An attempt is not. `invocationId` and `legacyAttemptNumber` are facts about
*this* attempt's birth, and nothing in a later event of the same coordinate is
entitled to restate them. Keyed off presence, the tenth event of an attempt could
announce a different invocation and the fold would have to either take it,
silently, or refuse — and refusing at replay is exactly what the totality rule
forbids. A type makes "who may state this" structural, and leaves the fold total:
an event of any other type produces no attempt row at all.

## Why the pairing rule is at the door and not in a trigger

Migration 11's trigger compares two columns against `json_extract` of the row's
own body. It is cheap, local, and needs nothing but the row.

The flat assignment is not that kind of fact. Its expected value comes from
`MAX(attempt)` over the task's events and from the attempt projection, so a
`BEFORE INSERT` trigger would have to reimplement the compare-and-set in SQL —
in a place where it cannot name the expected value, cannot be caught by class,
and would be a second implementation of a rule that already has one.

**The cost, stated.** A writer that bypasses the append door entirely can still
record an event whose `payload.legacyAttemptNumber` disagrees with its `attempt`
column, and a rebuild over that history would project the payload's value. What
the base still refuses is the consequence: two coordinates cannot share a flat
number and two attempts cannot share an invocation, because those are unique
indexes. So the damage such a writer can do is bounded to one row disagreeing
with its own event, and `verifyIntegrity` reports the row as disagreeing with a
replay only if the two produce different values — which they do not, since both
read the payload. That last part is the honest limit: this is the one pairing
rule of the three that has no backstop underneath the door.

## Why there is no closer

`ended_at` and `outcome` are in execution §3's dictionary, and the escalón that
writes them needs a mapping from a terminal task state to `effect_outcome_status`
— which of `SUCCEEDED`, `FAILED`, `CANCELLED`, `OUTCOME_UNKNOWN` a
`TASK_FAILED`, a `TASK_CANCELLED` or a quiet disappearance becomes. Nobody has
adjudicated that, and `OUTCOME_UNKNOWN` in particular is a durable claim about
what a system does *not* know, which the map records as not existing in the
vocabulary yet (§2.6).

Inventing the mapping here would have put a guess into a column that later
reads as evidence. So every row is born `NULL/NULL`, the nullity is declared
rather than accidental, and `ck_task_attempt_read_model__outcome_pair` is what
stops a later writer recording half of an ending. The escalón that owns the
closer is the one that lands `effect_read_model` (C) or the producer (G),
whichever adjudicates the mapping first.

A consequence worth naming: with no fold producing either column, the CHECK
would have been inert across the whole suite. It is therefore exercised at the
schema, by raw insert, in both directions and against the vocabulary — so the
escalón that inherits it inherits a constraint that has been seen to work rather
than one that has only been declared.

## Consequences

- `CONTROL_PLANE_EVENT_TYPES` is 25, and every count of it moves: the channel
  map's `execution` partition, and two `toHaveLength(24)` assertions in
  `@acp/runtime`. Three prose sites in `@acp/observation` still say "24" in
  comments; they are declared stale rather than corrected, because they are not
  assertions, are not under the fence's README law, and the next escalón moves
  the number again.
- The flat attempt space is finite and the ledger says so. 10 000 accumulated
  attempts per task is the contract's bound; the compare-and-set reads it off
  `IdempotencyCoordinates.shape.attempt.maxValue` rather than restating the
  literal, and exhausting it is a typed refusal that names the bound. A task
  that far gone is resolved with a new task. This is a real limit, not a
  theoretical one, and it is the adjudicated trade (Q4) against a counter that
  wraps or a column that overflows opaquely.
- A V2 event over a coordinate no opening has reached is still lawful. The door
  is tolerant without an attempt row and strict with one. Migration 11 declared
  the "migrated but not populated" window, every V2 fixture written before this
  escalón is exactly that shape, and demanding that an opening precede
  everything would retroactively refuse histories the log already holds. The
  escalón that produces openings for real (G) may narrow this; no escalón may
  narrow it retroactively.
- A rebuild refuses two histories it previously could not have met: two
  invocations for one coordinate, and one flat assignment across two. The
  snapshot carries the table's two unique indexes in memory to do it, which is a
  small amount of state the other folds do not need — and is the price of
  refusing at the event that caused the collision rather than at an index that
  can only name a row.
- `@acp/contracts` grows by **no** export. The cap is read off a schema, the
  event type is a member of a list that was already exported, and
  `CONTRACTS_SCHEMA_EXPORTS` does not move.
- Nothing emits an opening. The contract, the channel, the migration, the fold
  and the door all land without a production caller, exactly as
  `TOOL_CALL_RECORDED` landed in V2-B4b stage 2. Escalón G owes the producer,
  and until it arrives `task_attempt_read_model` is a correct and empty table on
  every ledger in the field.

## Not in this record

Whether `CONTRACT_VERSION` moves, and to what: still ADR 0072's deferral, still
owed by the escalón whose payload changes the durable meaning of an event. The
effect and dispatch read models (C), the occurrences (D), the outbox and
incarnation (E), the saga (F) and the producer (G) are each their own escalón
with their own write-set and their own record. The `ended_at`/`outcome` mapping
is named above as owed and is not decided here.
