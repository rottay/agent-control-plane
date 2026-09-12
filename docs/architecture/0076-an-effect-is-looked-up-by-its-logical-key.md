# ADR 0076 — An effect is looked up by its logical key, and the contract grows a version to say so

- Status: accepted (P-18/protocolo escalón C, recorded 2026-09-12).
- Supersedes: none.
- Superseded-by: none.
- Amends: nothing, and **pays** one debt. ADR 0072 deferred the bump of
  `CONTRACT_VERSION` to "the escalón whose payload changes the durable meaning
  of an event", and wrote down what that escalón would owe. This is that
  escalón. ADR 0072 is not edited — the corpus is append-only — and what it said
  was owed is discharged here in full.

## Context

Execution §6 specifies `effect_read_model`, §6.1 the logical identity and the
lookup that uses it, §7 `dispatch_attempt_read_model` and its five states, and
§4 `execution_route_segment_read_model`, the table both of the first two carry a
foreign key onto. Datos §11 fixes the transactional order — the intention of a
dispatch is recorded **before** anything is sent — and streams §1.1 fixes the
reading rule for a version a build does not understand.

The packet's minimal negative is §6.1 `:326-329`, and it is the reason the whole
escalón exists: a run loses an acknowledgement, hands off to another account,
and repeats the same step. It must get the **original** effect back, it must
reconcile rather than send, and it must not mint a second intention or a second
delivery. Everything below is in service of making that sentence executable.

Five things were underdetermined, and a writer could not have proceeded without
settling them.

**The formula for `effect_id`.** §6 `:238` says it "conserva la fórmula
existente" over the quintuple `(task_id, revision_number, attempt_number,
segment_number, operation_ordinal)`. **There is no existing formula.** The
nearest things in the tree are `operationId` — a deterministic uuid over a
name — and `operationDigest`, a sha-256 hex over slash-joined coordinates, and
both are V1 shapes that know nothing of a revision or a segment. Two writers
reading that sentence would have produced two identities.

**Where the segment comes from.** §6 `:242` and §7 `:343` both carry a foreign
key onto `execution_route_segment_read_model`, and the formula above takes
`segment_number` from it. That table existed nowhere in `packages/`. Without it
there is no `route_segment_id` to insert, no `segment_number` for the formula,
and no way to represent a handoff at all — which makes the packet's own minimal
negative unrepresentable.

**How many event types, and which.** The adjudication (Q5) fixed the *form* —
every type P-18 adds is a same-state passthrough — and left the count to each
escalón's brief.

**What "only the version in force" means.** ADR 0072 built the pair
`SUPPORTED_CONTRACT_VERSIONS` / `CONTRACT_VERSION` and recorded that the escalón
moving the literal "must pin the *current* version separately at every admission
door, because a set that is right for reading history is wrong for admitting new
work". Where that pin goes, and what is exempt from it, was not decided.

**Whether `RECONCILING` is a dispatch state.** The map's N-P18-4 read "INFLIGHT
vencido → RECONCILING, nunca reintento", fusing two authorities: datos §11 and
execution §7 `:360`, which says an overdue `INFLIGHT` "habilita reconciliación,
no reintento" — a verb, not a state. §7 `:347`'s CHECK admits five states and
`RECONCILING` is not one of them.

## Decision

**1. `execution_route_segment_read_model` lands in migration 13**, with the
effect and its deliveries. §1.8 forbids cutting an invariant to get a smaller
delivery, and the two foreign keys of §6 and §7 are exactly that invariant.
Migration 13 therefore creates three tables, seven indexes and three watermarks,
and no trigger: every pairing rule it imposes is a CHECK the base can evaluate
on the row in front of it, unlike migration 11's coordinate rule, which had to
compare a column against a JSON body.

**2. The two derived keys are written down, with versioned prefixes.**

```
effect_id       = SHA256(EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1 + canonicalJson([
                    task_id, revision_number, attempt_number,
                    segment_number, operation_ordinal,
                  ]))
idempotency_key = SHA256(EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1 + canonicalJson([
                    effect_kind, task_id, revision_number, attempt_number,
                    segment_number, operation_ordinal, envelope_sha256,
                  ]))

EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1          = "acp/execution-effect/v1\n"
EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1 = "acp/execution-effect-idempotency/v1\n"
```

`ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1` is the shape being followed and the LF is
the last byte of the prefix, with **no separator** between prefix and JSON. The
prefixes live in `@acp/contracts` because a key's grammar is the contract's
(decision 42, reiterated by decision 44) and the computation lives in
`@acp/ledger` because that package owns the one canonicalizer and the one
sha-256 — the same forced split `envelopeSha256` made. `v1` is frozen: a change
to the encoding is a **new** prefix with a new name, and no history is ever
rehashed.

The clock is not a member of either preimage, and neither is anything resolved
at dispatch time. Both are fixed once, with the **initial** segment, and
conserved through every replay and every handoff.

§6.1's own two digests — `logical_operation_sha256` and `request_sha256` — are
given verbatim by the dictionary and are implemented exactly as written, tag and
all. They carry no prefix constant, because the tag inside the canonical array
is already the versioned discriminator §6.1 chose.

**3. Three event types, named here**: `EFFECT_INTENDED`, `DISPATCH_INTENDED` and
`DISPATCH_OUTCOME_RECORDED`. All three are same-state passthroughs on the
`execution` channel, which moves `CONTROL_PLANE_EVENT_TYPES` 25 → 28 and the
channel map's `execution` partition 7 → 10.

The third is the one it would have been easy to leave out, and leaving it out
would have been a silent hole: without an event that records a delivery's
resolution, `dispatch_state` could never leave `INTENDED`,
`effect_read_model.outcome_status` could never be written at all, and
`OUTCOME_UNKNOWN` would be a column no producer can reach — which would make
execution §6 `:252`'s whole rule unenforceable. "Outcome" spans every move after
the intention, because every one of them is a report about how that delivery
went: claimed locally, accepted externally, settled, abandoned. When the
delivery's ending is also the effect's, the same event carries both.

The **segment** gets no type of its own. It rides both intention events as a
nested payload record, which is migration 12's pattern one rung down:
`TASK_ATTEMPT_OPENED` carries the revision record so the attempt's foreign key
is satisfied by construction rather than by assuming a parent is there. Here an
effect's intention announces the initial segment and a dispatch's intention
announces the effective one — which, after a handoff, is a segment nothing has
seen before.

**4. `CONTRACT_VERSION` moves to `"2.3.0"`, and the admission rule is "only the
version in force is emitted".**

The criterion that makes this escalón the carrier and not escalón B — which also
added a type with durable facts and did **not** bump — is this: C's payloads
carry **digests the fold verifies** (`logicalOperationSha256`, and the two
derived keys) and a **per-payload contract version** of their own
(`request_contract_version`, streams §1.1 `:128`). That is history whose
reconstruction depends on preimages that did not exist before. A reader at
`"2.2.0"` would already reject C's rows by the type enum; the bump is what makes
the rejection **name its cause** (streams `:154-158`) instead of looking like
corruption. B added facts; C added a way of computing identity.

`SUPPORTED_CONTRACT_VERSIONS` becomes `["2.2.0", "2.3.0"]` and `"2.2.0"` stays
in it for ever: every event any earlier build recorded carries it, and a set that
dropped it would make a routine upgrade a data loss event — which is the failure
ADR 0072 built this pair to prevent.

`AdmittedContractVersion = z.literal(CONTRACT_VERSION)` is the issuer's rule. It
governs the three shapes ADR 0072 named — `TaskEnvelope`, `WorkerSlot`,
`CommitAuthorizationReceipt` — plus the ledger's append door for a genuinely new
insertion. **The exemption is the replay**: an event already recorded, appended
again byte for byte, returns its existing record without reaching the check. A
producer that retries an append written before the upgrade is doing the one
thing an idempotency key exists to make safe, and refusing it would turn a
routine upgrade into a wall of failures on work that already landed.

`ControlPlaneEvent` deliberately keeps the **reader's** set. That schema is what
the ledger re-parses over every stored row in `#rowToRecord`, `#validateRowShape`
and `#replay`; pinning the literal there would be exactly the symmetry ADR 0072
removed, one version later. Issuing and reading are separated by *when* rather
than by *what*.

**5. The five states of §7 stay five, and `RECONCILING` is the outbox's word.**
An overdue `INFLIGHT` **remains** `INFLIGHT` and is found by
`ix_dispatch_attempt_read_model__state`; `listOverdueDispatchAttempts` takes the
deadline as an argument, because this package reads no clock and "overdue" is
the caller's policy. Finding such a row creates nothing: no verb of this ledger
moves it, mints another delivery for its effect, or intends a second effect from
it. That is what "habilita reconciliación, no reintento" means in a schema.

## Why the producer proposes and the ledger verifies, again

Escalón B settled the division for the flat attempt number and the argument
generalizes unchanged: an event arrives **signed**, so "assign" cannot mean
writing into the body without recanonicalizing and rehashing it. So the producer
proposes and the ledger computes the answer itself, refusing by name when the
two disagree.

Here that applies to `operation_ordinal` (one past the attempt's highest, `0`
where there is none), to `attempt_ordinal` (one past the effect's highest), and
to three of the four digests. `logical_operation_sha256` is recomputed from the
`invocation_id` on the attempt row; `effect_id` and `idempotency_key` from the
coordinate and from the `envelope_sha256` on the revision row. None of those
three is believed — each is recomputed from a **source this ledger recorded**,
which is what §6.1 `:319` means by "comprueban los digests contra
intención/fuentes".

`request_sha256` is the exception, and it is declared rather than quiet: its
preimage carries `neutralRequest`, and §6.1 `:296` forbids a business payload in
a ledger event outright. It is recorded and conserved. A check that only appeared
to be one would be worse than saying so.

## Why the lookup is a verb and the second intention is a refusal

§6.1 point 1 describes what happens inside `BEGIN IMMEDIATE` **before** an
ordinal is assigned: look the logical key up, and on a hit reuse the original
`effect_id` and `idempotency_key` "sin ordinal ni intención nuevos".

Read as a write path, that is a door that silently deduplicates. It is
implemented instead as two halves. `lookUpEffect` is the read verb a producer
calls first: it returns the effect that already exists, with the ids it was born
with, and says whether the situation demands reconciliation. And the append door
**refuses** an `EFFECT_INTENDED` whose logical key is taken, naming the effect
that holds it.

The split is what makes the negative real. A door that deduplicated would let a
producer append blindly and never learn that it must reconcile; a producer that
has to look up, and is refused when it does not, cannot skip that step by
accident. The four-field comparison of §6.1 `:303-304` lives in both halves, and
a difference in any of them is a **CONFLICT** — raised, never returned, because
there is no answer a caller could act on. A producer never resolves it by
changing the key.

`reconciliationRequired` is `true` for an `OUTCOME_UNKNOWN` and for an effect
with no outcome and a delivery still outstanding; it is `false` for a terminal
outcome, which §6.1 says is reused, and `false` for an intention that never left.

## Consequences

- **V3, and it is the visible cost of the bump.** `TaskEnvelope.contractVersion`
  is now the version in force, the envelope preimage covers every field of the
  schema, and therefore `envelope_sha256` differs for the same work issued
  before and after this escalón. The three pinned vectors in
  `ledger/test/envelope-identity` move with the fixture, and they move because
  the envelopes genuinely differ — not because the encoding changed under a
  fixed value, which is the one thing that suite exists to catch. No recorded
  digest is ever recomputed: history keeps what it was written with.
- `CONTRACTS_SCHEMA_EXPORTS` 110 → **113**: `AdmittedContractVersion` and the two
  preimage prefixes.
- `MIGRATIONS` 12 → 13. `DERIVED_TABLES` 10 → 13, with the three new tables
  **before** `task_attempt_read_model` because the foreign keys point upward.
  `PROJECTION_NAMES` 5 → 8, `PROJECTION_SOURCES` 9 → 12, `status().projections`
  8 → 11 and its watermark rows 9 → 12. `EXPECTED_SCHEMA_OBJECTS` gains ten
  entries and the `tr_` inventory stays at **eight**.
- The `cli` and `gateway` rewind fixtures each undo three more tables and six
  more indexes, children first. A migration 13 without its half of those blocks
  would leave them asserting a schema version that is no longer the previous one.
- **`accepted_at` carries no CHECK.** §7 fixes the pair for `terminal_at` and
  says only prose about `accepted_at`: it is populated on entering `INFLIGHT`
  *with external confirmation*, or directly at `SETTLED` where a provider does
  not distinguish acceptance from result, and an `ABANDONED` before any real
  dispatch leaves it `NULL`. A CHECK making `INFLIGHT` imply a non-null
  `accepted_at` would make `INFLIGHT` unreachable while B2 is blocked, and an
  unreachable state cannot be tested.
- **`effect_kind` carries no CHECK either, and its catalogue lives in
  `@acp/ledger`.** The minimum is one member, `"model_execution"`, with request
  contract version `"1"` — the shape `V2_IDEMPOTENCY_STREAMS` took in escalón A.
  It is **not** in `@acp/contracts`, and the choice is argued rather than
  assumed: decision 42 puts the *grammar of a key* in the contract, which is why
  the two prefixes are there, but a catalogue of business operations is
  decision 45's class — it grows with the adapters that serve it, so binding it
  to an immutable migration, or to the package every other package imports,
  would make each growth of the catalogue a migration of this database. The
  tension is real and is stated rather than hidden: `effect_kind` is a *member*
  of the idempotency preimage, and an escalón that finds the catalogue behaving
  like grammar may move it, with its own record.
- **B1–B3 exist and stay unpopulated.** `provider_idempotency_key`,
  `external_handle` and `accepted_at` need a composed adapter (map §3.3, P-15).
  The columns exist, their nullity is documented, and no producer in this build
  fills them with an external fact. The suite reaches `INFLIGHT` with an
  acceptance passed by argument, which is how `execution-effects` is tested
  today.
- **The append door's version pin covers `control_plane_events` only.** The
  initiative, registry and account doors are unchanged. That is a chosen scope,
  not a limit the write-set imposed: `appendInitiativeEvent`,
  `appendRegistryEvent` and `appendAccountAction` live in `ledger/index.ts`,
  which this escalón writes, and a door-level `!== CONTRACT_VERSION` there
  would touch no schema. It is left out because the version each of those
  streams emits belongs to the escalón that owns its producer — and the shapes
  that would carry the rule into the contract, `initiatives`,
  `account-record`, `checkpoint`, `durability-plane`, are that escalón's to
  change. The partial coverage is declared rather than silent; the escalón
  that owns each other stream's producer extends it.
- **Nothing produces any of this.** The contract, the channel, the migration,
  the folds, the door and the lookup all land without a production caller,
  exactly as escalón B's opening did. Escalón G owes the producer, and until it
  arrives the three tables are correct and empty on every ledger in the field.
- A rebuild refuses histories it previously could not have met: two effects
  under one logical key, two effects under one idempotency key, two segments at
  one coordinate, two deliveries at one ordinal. The snapshot carries each
  table's unique indexes in memory to do it, at the event that caused the
  collision rather than at an index that can only name a row. It is also the
  first fold in this package that **reduces** rather than inserts — a delivery
  is born and then resolved — and the rebuild writes the row the fold arrived
  at rather than replaying the resolutions a second time.

## Not in this record

The occurrences of §8 (escalón D), the outbox and incarnation (E, landed), the
saga (F) and the producer in `@acp/runtime` (G) are each their own escalón with
their own write-set and their own record. Reconciliation *by handle* is P-15's:
this escalón makes an uncertain exposure recordable and makes it block a resend,
and it does not consult any destination about anything. `API_CONTRACT_VERSION`
does not move. The `ended_at`/`outcome` closer on `task_attempt_read_model` is
still ADR 0073's declared debt and is not decided here.
