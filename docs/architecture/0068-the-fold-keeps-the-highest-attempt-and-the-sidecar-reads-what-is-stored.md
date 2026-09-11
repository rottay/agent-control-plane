# ADR 0068 — The fold keeps the highest attempt, and the sidecar reads what is stored

- Status: accepted (CORR-1, recorded 2026-09-11).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0067 §6, in one clause and nothing else. That record says the
  three denormalized task columns "move together or not at all"; this one
  separates the attempt from the other two and states its rule. Everything else
  in 0067 — no new event type, `CONTRACT_VERSION` frozen, the two-directional
  trigger, the insert-only revision row, the absent artifact column — stands
  unchanged, and its file is not touched.

## Context

Three findings, reproduced against `cac03f4` before anything was written
(`.acp-local/evidence/p05/acp-corr-fable-repro-v1.md`). They are unrelated in
cause and related in shape: each is a place where a mechanism describes
something other than what is on disk, and in all three cases nothing could go
red, because every test agreed with the defect.

**1. The task row's attempt went backwards.** `nextTaskProjection` decided
whether a revision "advances" with `revisionNumber >= current`, and on that one
predicate replaced all three denormalized columns. Two events at the *same*
revision therefore made the later arrival win: revision 2 attempt 3 followed by
revision 2 attempt 1 left `latest_attempt_number = 1`. The incremental path and
the replay share that fold, so `verifyIntegrity()` compared a stored projection
against a rebuild that computed the same wrong answer and reported nothing.

**2. The account sidecar hashed a decoding, not the bytes.** The contract's §8.1
defines `T(s)` over "los bytes UTF-8 del valor TEXT **tal como está
almacenado** … sin volver a parsear su contenido". The readers selected those
columns as TEXT, so the driver handed them over as JavaScript strings with every
invalid sequence already replaced by U+FFFD, and `encodeText` re-encoded that
string. A note holding the single byte `80` and a note holding the three bytes
`EF BF BD` hashed identically: replacing one with the other — an edit only a
writer reaching past the door can make, which is the entire scenario the sidecar
exists for — left `verifyIntegrity()` green. The module's own docblock claimed
the opposite of what it did.

**3. An integer out of range escaped the verifier as an exception.** The same
reads took `sequence` and `version` as JavaScript numbers. `version = 2**53` is
a lawful 64-bit INTEGER and a rounded `number`, and the encoder rightly refuses
to guess which integer a rounded number stood for — but nothing caught the
refusal, so `verifyIntegrity()` **threw** instead of reporting. An operator
asking "is this ledger sound?" got a `LedgerValidationError` naming no sequence,
which reads as a broken verifier rather than as the broken ledger it is, and
said nothing at all about the links after it.

## Decision

**1. Three cases in the fold, not two.** The predicate is split. `newer`
(strictly greater, or no revision recorded yet) replaces the envelope and the
revision number together. `same` (equal revision numbers) keeps both and takes
`Math.max` of the attempt. Anything else keeps all three. The rule, as one
sentence and written into `execution/index.md` §1 and the ledger README:

> The envelope and the revision number move together with the higher revision;
> the attempt keeps the highest within the same revision; an older revision
> moves nothing.

The first two still move together — 0067's reason for that is untouched, and a
task advertising revision 3's number beside revision 2's envelope remains the
one failure a denormalization must never produce. What 0067 did not distinguish
is that the attempt is not a fact *of* the revision. Within one revision the
attempts are a sequence, and the projection must not claim a task went backwards
— the same rule the legacy `latest_attempt` has always had. A higher revision
does reset it: attempt 1 of revision 3 is not lower than attempt 3 of revision 2,
it is a different unit of work.

**2. The sidecar reads bytes, and integers of sixty-four bits.** The eleven TEXT
columns that enter the preimage are selected as `CAST(col AS BLOB)`, aliased
back to their own names; `AccountEventRow` types them `Buffer`; `encodeText`
takes the buffer and prefixes its length without ever constructing it from a
string. The two INTEGER columns are read with `.safeIntegers(true)` on those
three statements and nowhere else; `encodeInteger` takes `bigint` and renders it
with `String()`, and keeps its refusal for a `number` that is not a safe integer.
The comparisons that cross the two number types go through one exported
predicate, `sameStoredInteger`, because three spellings of one rule is how two
of them come to disagree.

**The preimage `v1` does not change shape, and no history is rehashed.** This is
the constraint the correction was designed around rather than a happy result.
For every row whose TEXT is valid UTF-8 — every row any door of this system has
ever written — the bytes read as a BLOB are byte-for-byte the bytes the previous
reader produced by re-encoding, so every digest already recorded is unmoved and
nothing is re-anchored. The pinned vectors `ROW_ONE_SHA256` and `ROW_TWO_SHA256`
are the assertion of exactly that, and they did not move. The only rows whose
digests change are the rows the chain used to describe wrongly, and they are
**reported, never repaired** — §8.2 is explicit that repair is a separate,
recorded decision.

**3. The verifier is total.** `#checkAccountIntegrity` takes each digest inside
a guard for `LedgerValidationError`, records a finding at that row's own
sequence, and continues the walk with the stored digest so every later link is
still checked. The kind is the existing `HASH_CHAIN`: the protocol's vocabulary
of kinds is closed, and this is the one that means "the stored row does not
answer for the digest filed against it". The detail carries the preimage's own
refusal, whose every form names coordinates and digests and never a stored
value, which is what keeps `IntegrityProblem.detail` loggable. Anything that is
not a `LedgerValidationError` is a defect in this package rather than a fact
about the ledger, and goes up.

With the read widened, `version = 2**53` is no longer unhashable, so that guard
is reached by no SQL this package can be handed. It is kept because totality is
the property being decided, not because a case is expected: the preimage may
refuse for other reasons in a future version, and a verifier that aborts is a
verifier that reports nothing about the rest of the chain.

## Why a new preimage version was not chosen

The obvious reading of "the digest changes for some rows" is "this is `v2`".
It is not. `v1` says the preimage is taken over the stored values; the previous
code did not do that, for reasons of how a column was read rather than of what
the format is. Minting `v2` would ratify the defect as having been the contract,
and — worse — would oblige a re-anchoring of chains whose digests are correct,
over history the contract forbids rehashing. The format is unchanged; the
fidelity of the read is corrected.

## Why the projection was not migrated

A ledger already written can hold a lowered `latest_attempt_number`. There is no
migration for it, and that is the standing treatment of every change to a fold:
the stored row disagrees with the replay until `rebuildReadModel()`, which is a
`PROJECTION` finding, which is what `verifyIntegrity()` is for. Writing a
migration to patch a derived column would put a second writer on a value that
already has one.

## Why the kind vocabulary was not widened

"The row cannot be hashed" is arguably its own kind. Adding one would move
`packages/kernel/protocol`, and a closed vocabulary crossing the wire is not
widened to improve the phrasing of a finding an operator reads in the detail
anyway. `HASH_CHAIN` at a named sequence, with the cause in the detail, says
what happened.

## Consequences

`verifyIntegrity()` now reports findings on ledgers where it used to be silent
(a TEXT column holding invalid bytes) and returns where it used to throw (an
INTEGER past `2**53`). Both are the verifier working; an operator who read
"green" from a tampered account stream was reading an answer the chain could not
support.

`AccountEventRow` is bytes and `bigint` at its edges, so any future reader of
`account_events` that wants text or a `number` must decode deliberately. One
such place exists today and is marked: `#appendAccountIntegrity` binds
`recorded_at` back into `computed_at` as text. That is lawful exactly there —
this process wrote the value from a JavaScript string moments earlier in the
same transaction, so the round trip is lossless, and `computed_at` is outside
the preimage, so no digest depends on it.

Nothing else moves. No new event type, no new error class, no migration, no DDL,
no protocol change, and neither `CONTRACT_VERSION` nor `API_CONTRACT_VERSION`.

## Not in this record

**Whether `createdAt`/`createdBy` belong to a revision's identity.** Today a
second event at one revision is admitted only if its revision row is identical
including those two, so the fold's same-revision case is reachable only by a
"twin" event. That is a producer question and it is P-18's; the attempt rule is
correct either way.

**A replay that mutates before it refuses.** In `applyEventToSnapshot` the task
map is updated before the revision conflict check throws. It is harmless today
because a rebuild aborts whole. Recorded as advisory; not corrected here.

**`activateAccountIntegrity` has the same unguarded call.** Migration 10 hashes
every historical row without the guard added above, so a pre-existing row with
`version >= 2**53` would fail the migration with `LedgerValidationError` instead
of `LedgerMigrationError`. No such row can exist today — the append door
validates `version` — so this is a diagnostic-quality defect, recorded here and
left to whoever opens that path.

**The producer.** Still nothing writes a revision coordinate. 0067's "what this
does not close" stands in full.
