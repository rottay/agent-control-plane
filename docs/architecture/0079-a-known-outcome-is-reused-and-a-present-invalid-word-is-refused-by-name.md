# ADR 0079 — A known outcome is reused, never redelivered, and a present-invalid word is refused by name

- Status: accepted (CORR-2, recorded 2026-09-12).
- Supersedes: none.
- Superseded-by: none.
- Amends: nothing. ADR 0076 specified the dispatch door and ADR 0078 left it
  as it found it; neither said a known outcome admits a second delivery, nor
  that an unreadable outcome is no outcome. Both behaviours were defects against
  execution §6.1, and this record states the rules those two ADRs already
  implied. Their files are not touched.

## Context

Two findings, reproduced against `e180ef5` before anything was written
(`.acp-local/evidence/corr2/acp-corr2-fable-repro-v1.md`, both PERSISTE). They
live in the same door, and in both cases nothing could go red: the fold agreed
with the defect, so `verifyIntegrity()` compared a stored projection against a
rebuild that computed the same wrong answer.

**C-H1 — a known outcome was redelivered.** `#assertDispatchIntention` consulted
`effect_read_model.outcome_status` exactly once, for `OUTCOME_UNKNOWN`. An effect
that had already ended `SUCCEEDED` admitted `DISPATCH_INTENDED dsp-2` at ordinal
2, the fold reproduced `[SETTLED, INTENDED]`, and the ledger reported itself
sound. The guard O-1 added in P-18/F did not interfere, because it counts
deliveries that are not `SETTLED` or `ABANDONED`, and `dsp-1` was `SETTLED`.
`lookUpEffect` already knew the answer — `reconciliationRequired: false` with
`outcomeStatus: "SUCCEEDED"` — and the door did not ask it. `FAILED` behaved the
same way.

Execution §6.1 `:304-305` says "un desenlace terminal se reutiliza; uno incierto
exige reconciliar", and `:310-311` "sólo una entrega realmente nueva y autorizada
crea un dispatch_attempt". The second clause was enforced and the first was not.

**C-H2 — a present-invalid value collapsed into absence.**
`dispatchOutcomeRecord` read `effectOutcomeStatus` with `recordWord`, which
answers `null` for a missing key, for a word outside the vocabulary and for a
value that is not a string. The door then returned at
`if (outcome.effectOutcomeStatus === null) return;`. A resolution carrying
`"INVALID_STATUS"` was stored with that word in `event_json` and projected as no
outcome at all; the migration-13 CHECK never fired because the invalid value was
never written. And because the effect's outcome was still `NULL`, a second
`SETTLED`/`SUCCEEDED` on the same delivery was admitted and recorded one — so the
rule "an outcome is recorded once, not amended" (§6 `:252`) had a way round it.
`42` and `"succeeded"` were admitted the same way. `dispatchState` did not have
the problem only because it is required: there, `null` already meant refusal.
The three optional text fields beside it — `acceptedAt`, `externalHandle`,
`providerIdempotencyKey`, read with `recordText` — had it for the same reason.

## Decision

**1. A known outcome is reused, never redelivered.** The dispatch door refuses
`DISPATCH_INTENDED` on an effect whose `outcome_status` is not null — all four
values. `OUTCOME_UNKNOWN` keeps its own refusal and its own text, unchanged and
first. `SUCCEEDED`, `FAILED` and `CANCELLED` take a new one, after it and before
O-1, at `payload.dispatch.effectId`:

> effect `<id>` already ended `<status>` at `<outcome_recorded_at>`; a known
> outcome is reused, never redelivered (execution §6.1), and a genuinely new
> operation intends a new effect

- **No exception for `FAILED` or `CANCELLED`.** §6.1 does not distinguish, and a
  retry of a failed operation is a genuinely new operation with a key of its own.
  Admitting a redelivery after either would be an owner's written decision, not
  a default.
- **The guard reads the effect, not the deliveries.** An `ABANDONED` delivery
  records no outcome, so the next delivery after it is still admitted — the
  handoff of P-P18-7 and the test O-1 wrote both depend on that. So is the next
  delivery after a `SETTLED` one that reported no outcome: the delivery ended and
  the operation's result was never recorded, so there is nothing to reuse.
- **An exact replay is still a replay.** The branch that compares a held
  delivery's birth runs before this rule, so the same `DISPATCH_INTENDED dsp-1`
  after `SUCCEEDED` writes nothing and refuses nothing.
- **Door-only, on O-1's precedent.** Every stored delivery passed the check when
  it was written, so the fold cannot produce what the door no longer admits, and
  `applyEventToSnapshot` does not change. A ledger that already holds a second
  delivery of a finished effect replays as it did; the rule governs what is
  appended from now on.

**2. Present-invalid is not absent.** `dispatchOutcomeRecord` returns
`DispatchOutcomeReading | null`, D's rejecting-union shape
(`OccurrenceReading`):

```ts
type DispatchOutcomeReading =
  | { kind: "record"; record: DispatchOutcomeRecord }
  | { kind: "refused"; path: string; message: string };
```

Each of the four optional fields of a resolution is read three ways:

| The event carries | Reads as |
| --- | --- |
| no such key | `null` in the record — the event did not say |
| a lawful value — a word of `EFFECT_OUTCOME_STATUSES`, or non-empty text | the value |
| anything else: a word outside the vocabulary, a number, an object, an array, an empty string, an explicit `null` | `refused`, at `payload.outcome.<field>` |

- **The scope is the four fields** — `effectOutcomeStatus`, `acceptedAt`,
  `externalHandle`, `providerIdempotencyKey` — and the one function. It is the
  same class of defect in the same reader, so it is closed as one.
- **JSON `null` is present.** A payload that writes the key has said something,
  and `null` is not a word of any of the four grammars. The occurrence door of
  escalón D refuses mistyped fields on the same criterion.
- **What is not a resolution still reads `null`.** No record, no delivery id, a
  state outside the five, or a terminal pair that disagrees: the door refuses
  those with its existing message and the fold projects nothing, as before. The
  refusal is reserved for a field that is present and inadmissible.
- **The message never echoes bytes.** A string is shown through `printable`,
  and only when it is shaped like an identifier; anything else is named by its
  kind ("a number", "an object", "null").
- **The door and the fold throw the same issue.** `#assertDispatchOutcome`
  translates the refusal to `LedgerValidationError`, `applyEventToSnapshot`
  throws it unchanged, and the write path inside `append` throws it again rather
  than ever reading one as absence. A history planted with a correct chain is
  refused by `rebuildReadModel()` with the door's path and message, and
  `verifyIntegrity()` refuses the same event.

**3. The P-18 value types live in their concepts' own type leaves.** Two pure
type leaves, on `packages/persistence/ledger/src/types/index.ts`' pattern and
`daemon/src/composition/types/index.ts`' precedent: they declare data and nothing
else, and import only types.

- `src/projection/types/index.ts` — the types escalones C, D and F declared in
  the projection: `DispatchOutcomeRecord`, the new `DispatchOutcomeReading`,
  `OccurrenceReading`, `OccurrenceRefusal`, `OccurrenceOwner`,
  `OutboxCommandIntention`, `OutboxDeliveryAttempt`, `OutboxDeliveryObservation`,
  `OutboxReading`, `OutboxEventEntry`, `OutboxAttemptRecord`,
  `OutboxPredecessor`, `OutboxFold`.
- `src/outbox-store/types/index.ts` — the types escalón E2 declared in the
  store: `OutboxEventAnchor`, `OutboxIncarnation`, `OutboxRow`,
  `OutboxMessageSeed`, `OutboxCasToken`, `OutboxMutation`, `OutboxCasOutcome`,
  `OutboxStore`, `OpenOutboxStoreOptions`.

Each concept's `index.ts` re-exports every name, so no import outside the
package changes and `@acp/ledger`'s public surface is identical. The vocabulary
types read off a constant — `OutboxState`, `OutboxCommandKind`, `OutboxStream` —
stay beside their constants, which is also `src/types/index.ts`' arrangement for
`DispatchState`; the outbox leaf reads them with one type-only import that is
erased at emit. The types older than P-18 (`ProjectionSnapshot`,
`WorkerTaskProjection`, `InitiativeProjectionSnapshot`) and the module-private
row shapes of the store stay where they are: this is not a reorganisation. Each
leaf's shape is pinned in its concept's existing suite, because a pure type leaf
carries no mirrored suite of its own.

## Consequences

A producer that intends a second delivery of a finished effect is refused, and
the refusal names the outcome to reuse. A producer that writes a malformed
optional field is refused and told which field, instead of having its event
stored and its fact silently dropped. Neither producer exists yet — escalón G
owes it — so no caller in this tree changes.

A ledger written before this record may hold either shape, because the door
admitted both. The first — a second delivery of a finished effect — replays
unchanged, since the rule is door-only. The second — a resolution with a
present-invalid field — is refused by `rebuildReadModel()` and by
`verifyIntegrity()` at the event that holds it, which is the verifier reporting
a history the door would now refuse. No such history exists outside test
fixtures: nothing emits `DISPATCH_OUTCOME_RECORDED`.

Nothing else moves. No migration, no DDL, no event type or shape (vocabulary 33,
`execution` 15), no error class, no `CONTRACT_VERSION` (`"2.4.0"`), no
`API_CONTRACT_VERSION`, no fence law.

## Not in this record

**`terminalAt` on a non-terminal state.** It is read with `recordText` too, but
it is not one of the four optional fields: it is required exactly when the state
is `SETTLED` or `ABANDONED`, and a disagreement there already makes the payload
not a resolution. A `CLAIMED` or `INFLIGHT` resolution that carries `terminalAt`
as a number or an explicit `null` still reads it as absent. The same three-way
reading would close it; it is outside this record's adjudicated scope and left to
whoever next opens this reader.

**A retry of a `FAILED` effect.** Refused here by default. If the owner ever wants
one admitted, it is a written decision with its own record, not an edit to this
guard.

**O-Δ1 and O-Δ2.** Registered debt, untouched.
