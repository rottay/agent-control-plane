# ADR 0067 — The revision coordinate rides the stream it already has

- Status: accepted (P-05/B, recorded 2026-09-11).
- Supersedes: none.
- Superseded-by: none.
- Extends: `0066-the-revision-digest-covers-the-whole-envelope.md`.

## Context

ADR 0066 gave a revision its identity: `envelope_sha256`, computed over the
whole parsed envelope. What it could not give was a *place to put it*. The
ledger had `task_id` and a flat `attempt`, and nothing between them — so a task
with revisions and attempts did not fit the schema at all.

Migration 1 is immutable and its `attempt` column is `NOT NULL`, so the
coordinate cannot replace what is there. Streams §1.1 settles the shape: two
additive columns, `NULL` only on legacy rows, agreeing with the event's own body
wherever they are present, and a `legacy_attempt_number` still written into
`attempt` so every query that predates this migration keeps working.

## Decision

Six things this record decides.

**1. No new event type; the coordinate rides payload keys.** Streams §1.1 says
the columns "coinciden con el valor del `event_json`" and that the new payloads
"no son eventos nuevos de composición". So `CONTROL_PLANE_EVENT_TYPES` stays at
its current size and the channel map is untouched.

The consequence lands on the fold, and it is the most important thing in this
record: **the revision record is born from the presence of a complete key set,
on an event of any type.** A fold that keyed off a type would need a type of its
own, and the adjudication forbids one. The keys, by name:

```
revisionId, revisionNumber, attemptNumber, envelopeSha256   (all required)
restoredFromRevisionId                                       (optional)
```

They are declared **once**, in `src/projection/index.ts`. When the producer
(P-18) arrives it inherits them and the fence pins the equality of the two
declarations, exactly as it does for the recorded route's key today. Adding that
law now would pin one declaration against nothing.

A partial set is not a malformed revision — it is not a revision, and it
projects no row. That keeps replay total over every ledger written before this
migration.

**2. `CONTRACT_VERSION` does not move.** This is a correction of an earlier
ruling, and the reasoning is worth preserving because it nearly went the other
way. `ContractVersion` is a single `z.literal` shared by every event schema.
Moving it without a supported-versions mechanism would make every event already
recorded under the previous literal fail to parse — which is to say it would
make every ledger with history unreadable, in the name of a migration that adds
two columns.

So B records no event, and the cohort is told apart by
`revision_number IS NOT NULL` rather than by a version. The version moves with
the first V2 **producer** (P-18), together with the read-side mechanism for
accepting a set of versions rather than one. `API_CONTRACT_VERSION` does not
move either: `status().projections` is a list, and no strict object gains a key.

**3. The trigger enforces the pairing in both directions.** Forward: both
columns or neither, positive when present, equal to `event_json`. Backward: a
payload carrying the V2 keys may not arrive with the columns empty or
disagreeing. The second half is the one a forward-only trigger would miss, and
without it a writer could record the coordinate in the body, leave the columns
`NULL`, and produce a row that reads as legacy for ever while its own event says
otherwise — invisible to every query written against the columns.

**4. The revision row is insert-only, and its digest is not unique.** A second
arrival at one coordinate with the same content is an idempotent replay; with
different content it is refused. `ON CONFLICT DO UPDATE` is forbidden: a
revision records what was asked, and a coordinate that could be overwritten
would make "revision 2" a name for whichever event arrived last.

There is deliberately **no** `UNIQUE(task_id, envelope_sha256)` (§7.3):
restoring an earlier envelope is a new revision with the same digest, and that
constraint would forbid exactly the case the model exists to allow.
`restored_from_revision_id` is what says why two revisions agree, instead of
leaving a reader to infer it.

**5. `envelope_artifact_reference_id` is absent, not nullable.** The column is
`NOT NULL` in the target dictionary and its value can only be minted by the
artifact plane, which is P-36/local. Creating it nullable here would be a column
with no producer pointing at an empty port; omitting it is honest about what
exists. P-36/local adds it by `ADD COLUMN` with a cohort trigger keyed on
`contract_version`, `NULL` on every revision recorded before that migration, and
**nothing ever derives a reference from a digest**. Decision 41 records this;
the deferral's cause is the ordering in §15.5 and `packets/index.md:65`.

The fold refuses — rather than ignores — an event that carries that key today.
The distinction is deliberate: a payload this contract has no opinion about is
ignored, and a payload claiming a fact this contract cannot represent is a
reader being asked to pretend it understood something.

**6. Three task columns get a producer, three do not, and two are not created.**
`envelope_sha256`, `latest_revision_number` and `latest_attempt_number` are
derived from the revision record and move together or not at all — a task
advertising one revision's number beside another's envelope is the single
failure a denormalization must never produce.

`role`, `step_id` and `commit_policy` are created `NULL`-able with **documented
nullity**, which execution §1 explicitly authorizes. No event carries them,
nobody invents a payload key to fill them, and `NULL` there means "not recorded
yet" rather than "absent".

`duel_id` and `state_vocabulary` are **not created at all**, and each is
deferred to a named producer: `duel_id` to the model-duel flow (planning §9) and
`state_vocabulary` to the state-vocabulary transition (contracts §2.2), which
brings its own `CHECK` and its own per-cohort write. A column with neither a
producer nor its constraint would be a shape the dictionary does not authorize.

## The migration is atomic, and it refuses before it builds

Preflight, DDL, watermark seed and the migration row are one transaction, on the
shape migration 10 set. A ledger holding the table but not the watermark, or the
columns but not the trigger, is not a state anything may observe.

The preflight is streams §1.1's: the migration that enables the V2 idempotency
key must check that no V2 key collides with a historical one and refuse
explicitly. Before any V2 row exists that reduces to one checkable question — is
the `v2/` namespace free? — and it has to be asked **now**, because the column is
`UNIQUE` and a collision discovered later surfaces as a constraint failure
naming one row and no coordinate, on a ledger already in production. It names
what it finds and repairs nothing, on the shape the account duplicate preflight
set.

The watermark is seeded from the head in `ledger_meta`, never from a literal
zero. This projection arrives over a stream that may hold a long history whose
fold is legitimately empty, so it is level with the stream the moment the table
exists. A zero there would make every ledger in the field fail its own integrity
check immediately after a routine upgrade, with nothing wrong with it.

## Consequences

`status().projections` goes from six to seven. No wire DTO changes: the vector
of watermarks is a list, and a list gaining an entry is not a new key.

The "migrated but not populated" window is **real and lawful**, and it is the
exact inverse of migration 10's. Nothing here writes a coordinate, so a ledger
that has applied 11 and holds no V2 row is correct rather than half-applied, and
its legacy rows keep both columns `NULL` for ever. Migration 10 activated as it
migrated, which is why absence there was tampering. A reader carrying the wrong
intuition across will misjudge both.

## What this does not close

**There is no producer.** Nothing in this build writes a revision coordinate:
the columns are populated from a payload no code currently sends. B builds the
place; P-18 puts something in it.

**`task_attempt_read_model` and `legacy_attempt_number` are not here.** The
monotonic per-task assignment, its compare-and-set and the attempt table are
P-18/M4. B creates the two columns and the pairing rule that make that
assignment safe, and no more.

**No concurrent write path.** There is no CAS in this packet, in either
direction.

**The envelope digest still is not compared at any door.** ADR 0066 said this
about N01 and it remains true: `daemon-child` compares the submission digest,
and closing N01 means making a door compare `envelope_sha256`. Neither A nor B
does that.
