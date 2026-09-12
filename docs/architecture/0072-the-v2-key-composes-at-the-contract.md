# ADR 0072 — The V2 key composes at the contract, and the door reads every supported version

- Status: accepted (P-18/protocolo escalón A, recorded 2026-09-12).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0067 §4, in one definition and nothing else. That record makes the
  revision row insert-only and says a second arrival at one coordinate "with the
  same content" is an idempotent replay, without saying what content is. This
  record defines it: `revisionId`, `envelopeSha256` and `restoredFromRevisionId`.
  Everything else in 0067 — no new event type, the two-directional trigger, the
  insert-only rule itself, the absent artifact column — stands unchanged, and its
  file is not touched.

## Context

Migration 11 (P-05/B) reserved the `v2/` idempotency namespace on
`control_plane_events`, refused to apply if any historical key already sat
inside it, and left the composition of the full key to "the producer (P-18)".
The namespace was reserved and, at the same moment, physically unreachable:
`ControlPlaneEvent`'s refinement compared `idempotencyKey` against
`buildIdempotencyKey({taskId, attempt, transitionId})` unconditionally, so an
event carrying a V2 key was refused by the contract before the ledger ever saw
it. The constant that declared the namespace was a private `const` in
`@acp/ledger`, and its own docblock said a producer would "import this constant
rather than restating it" — an import no producer could perform.

Nothing in the tree had noticed, because nothing had tried. P-18's later
escalones all write through that door: the attempt identity table
(`task_attempt_read_model`), the effect and dispatch read models, the prompt and
response occurrences. All of them need a revision-aware key.

Two further facts constrained the repair.

**Moving the version literal is not a local edit.** `ContractVersion` was
`z.literal(CONTRACT_VERSION)`, and a literal is symmetric: it refuses every value
that is not the current one, in both directions. The ledger re-parses stored
bodies with `ControlPlaneEvent` on all three of its read paths — `#rowToRecord`,
`#validateRowShape` and `#replay`. Moving `CONTRACT_VERSION` without a
supported-set mechanism would therefore have made every event already recorded
under the previous value unreadable, and its rebuild a refusal. A version bump is
not supposed to be a data loss event.

**Two P-05/B defects were still open.** Its postaudit named them F-1 and F-2 and
deferred both. F-1: the revision comparison included `createdAt`, `createdBy` and
`contractVersion`, so a second *attempt* of one revision — which execution §3
calls "un reintento de la misma revisión, no una revisión nueva" — conflicted
against its own row unless it restated the first arrival's timestamp. The only
way to advance `latest_attempt_number` was to lie about when the attempt
happened. F-2: a malformed V2 payload reached SQLite and came back as a raw
`SqliteError` from the stream trigger, in a file whose own
`#assertCausationResolves` states the opposite standard — "this layer exists so
the refusal is a typed `LedgerValidationError` rather than a raw SQLite error
nobody can catch by class".

F-1 and F-2 are not independent of the version question. `contractVersion` sat in
the revision comparison, so the moment the supported set grows and a producer
stamps a newer member, a second attempt of a revision opened under the older one
would conflict against its own row while agreeing about every fact recorded in
it. Fixing the comparison and building the version mechanism is one change or two
failures.

## Decision

Four rules, landed together without a migration or any DDL.

**1. The V2 key is composed by `@acp/contracts`.** `V2_IDEMPOTENCY_NAMESPACE`
moves out of `@acp/ledger` into the contracts package, and the ledger imports it;
the private const is deleted, so the literal `"v2/"` lives in exactly one `src`
file of the monorepo (test N-A-3). Beside it,
`buildV2IdempotencyKey({stream, taskId, revisionNumber, attemptNumber,
transitionId})` composes streams §1.1's preimage in its order with `/` as the
separator, and `stream` is typed to the closed set `V2_IDEMPOTENCY_STREAMS`,
whose single member in this escalón is `"control_plane_events"`.

This revises P-05/B's placement decision, which declared the separator "here and
nowhere else" in the ledger. It is recorded as decision 42: a namespace is
grammar of the key, and the key is the contract's. The direction is also the only
one available — `@acp/ledger` already imports `@acp/contracts`, and the contracts
package may reach no `node:` builtin, so the constant could not have travelled
the other way without a cycle. `ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1` (P-05/A) is
the standing precedent for exactly this shape: a preimage's version prefix
declared in contracts and computed in the ledger.

**2. The refinement's rule is strict in both directions.** If an event's payload
carries a complete V2 coordinate — `revisionNumber` and `attemptNumber`, both
safe integers of at least one — then `idempotencyKey` must be exactly the V2 key
of that coordinate. If it does not, `idempotencyKey` must be exactly the V1 key.
No other form parses. An incomplete or ill-typed coordinate reads as no
coordinate here and is refused by name at the ledger's append door instead.

**3. Reading and writing are separated.** `SUPPORTED_CONTRACT_VERSIONS` is the
set a reader admits and `ContractVersion` is `z.enum` of it;
`CONTRACT_VERSION` remains `"2.2.0"` and is what a producer stamps. The three
ledger read paths now name the version found and the supported set when that is
why a stored row was refused. With one member the mechanism is inert and
indistinguishable from the literal it replaces, which is what makes it safe to
land before it is needed.

**4. "Same content" is defined, and defined once.** `canonicalRevision` compares
`revisionId`, `envelopeSha256` and `restoredFromRevisionId`, and nothing else —
`sequence`, `createdAt`, `createdBy` and `contractVersion` are birth attributes of
the arrival that first announced the revision, not of the revision. The function
is exported from `projection/index.ts` and imported by the append door, so the
incremental path and a rebuild cannot drift apart; two implementations of "same
content" would be two definitions of it.

**The obligation this record places on the escalón that bumps the version.**
`ContractVersion` is shared by every top-level contract, including the admission
shapes `TaskEnvelope`, `WorkerSlot` and `CommitAuthorizationReceipt`. A set that
is correct for reading history is wrong for admitting new work: once the set
holds more than one member, admission would silently accept the older version.
The escalón that moves `CONTRACT_VERSION` must therefore widen the set first,
**pin the current version separately at every admission door**, and land
**P-P18-2** — a ledger written under the previous version reads and rebuilds
without error — as a required test. It is not optional and it is not deferrable
past that escalón, because from that point the two are the same act.

## Why permitting the V2 form rather than requiring it was not chosen

The smaller repair was to let the refinement accept the V1 form always and the V2
form additionally, whenever the payload carried a coordinate. It touches no
existing fixture, and it unblocks the namespace just as well.

It also makes two lawful names for one fact. The same task, revision, attempt and
transition could enter the ledger twice — once V1-keyed, once V2-keyed — and
neither the `UNIQUE` on the column nor `assertNoV2KeyCollisions` would see
anything wrong, because the two keys genuinely differ. streams §1.1's "no … otro
namespace de idempotencia para los mismos hechos" would have become advice with
nothing enforcing it, and the concrete failure it forbids would have been
reachable: a producer whose V2 append conflicts re-keys the same payload under V1
and calls the conflict a new operation. Under the strict rule that escape hatch
does not exist, because the namespace is not something the producer chooses — the
payload decides and the producer obeys (negative N-P18-20).

The cost is that every existing fixture appending a revision payload moves to the
V2 key. It came to one helper function, because those fixtures all compose their
key in one place.

## Why bumping `CONTRACT_VERSION` in this escalón was not chosen

The mechanism and the bump are separable, and separating them is nearly free. The
bump would move thirteen pinned sites and would require proving that a ledger
written under `2.2.0` still reads and rebuilds — a proof worth having, but worth
having *against a payload change that actually justifies the bump*. There is no
such payload in escalón A: nothing here changes what a stored event means.

Deferring also keeps this escalón honest about what it verified. With one member
in the set, "supported but not current" is an empty category and P-P18-2 cannot
be drilled. Claiming the mechanism works across versions while being unable to
exercise it across versions would be a claim resting on prose. What is asserted
instead is the invariant that makes the later drill possible — the set contains
what the producer writes, has no duplicates, and is not empty (N-A-1) — plus the
obligation recorded above.

## Why deferring F-1 again was not chosen

P-05/B's postaudit recommended deferring F-1, and for that commit it was right:
the defect was reachable only by a producer that did not exist. This escalón is
the one that admits that producer, so the deferral expires here on its own terms.

The crossing with the version mechanism settles it. `contractVersion` was inside
the comparison. Landing the supported-set mechanism and leaving F-1 open would
have built the machinery for a future bump while leaving a defect that the bump
detonates — a second attempt of a revision opened under the older version
conflicting against its own row. One change closes both, and splitting them would
have meant landing the second half under time pressure from the first.

## Consequences

- The `v2/` namespace is reachable. Every later escalón of `P-18/protocolo` can
  write a revision-aware key, and P-05/B's reservation stops being a promise.
- Producers lose a choice they should never have had. A payload's shape now
  determines its key, which means a producer cannot resolve an idempotency
  conflict by renaming the fact.
- The contracts surface grows by five names, `CONTRACTS_SCHEMA_EXPORTS` 105 → 110.
  No fixture pinned to the `"2.2.0"` literal moves, and no consumer of
  `CONTRACT_VERSION` moves: with one member the inferred type is still the
  literal.
- A revision's birth attributes are no longer part of its identity. This is a
  real loss of strictness: two arrivals at one coordinate that disagree about
  `createdAt`, `createdBy` or `contractVersion` are now a replay rather than a
  conflict, and the first arrival's values are the ones kept. That is the
  intended reading — those fields record an arrival, and a retry is a different
  arrival at the same revision — but it does mean the ledger no longer refuses a
  producer that misreports when a replay happened. What it still refuses is any
  disagreement about what was asked.
- The escalón that bumps `CONTRACT_VERSION` inherits the admission-pinning
  obligation and P-P18-2 above. Landing a bump without them would reintroduce, at
  the admission doors, exactly the asymmetry this record removed from the read
  paths.
- Three refusals now guard the V2 coordinate — the contract's key rule, the
  ledger's typed guard, the stream trigger — where two existed. The trigger is
  deliberately not removed: it is the only one of the three that holds against a
  writer that bypasses the door entirely.

## Not in this record

Whether `CONTRACT_VERSION` moves, and to what: deferred to the escalón whose
payload changes the durable meaning of an event, with its own write-set and its
own record. The new event types the later escalones need (Q5) and the attempt
identity table they populate (escalón B) are not decided here — this escalón adds
no member to `CONTROL_PLANE_EVENT_TYPES` and no migration. The 10 000 cap on
`attempt` against a monotonic `legacy_attempt_number` is adjudicated (Q4) but
belongs to escalón B's compare-and-set, which is where the cap is consulted.
