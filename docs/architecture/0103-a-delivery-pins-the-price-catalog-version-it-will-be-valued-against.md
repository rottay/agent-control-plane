# ADR 0103 — A delivery pins the price catalog version it will be valued against

- Status: accepted (P-15 escalón C, recorded 2026-09-23).
- Supersedes: none.
- Superseded-by: none.
- Amends: none. `L-P33B-1` is amended in its own fence row; execution §7 is amended
  in place.

## Context

The economy dictionary prices a spend against a catalog version fixed before the
spend and reused by every later replay (economy §3 `:208`). P-33/catálogo gave the
catalog its table (ADR 0091) and a pure resolver inside one pinned version (ADR
0092), and ADR 0092 left the pin with no physical home: persisting it on a segment
or a delivery was P-15's. ADR 0080 §7 reassigned the producers of `EFFECT_INTENDED`
and `DISPATCH_INTENDED` to P-15 as well; no `src/` produced either.

Adjudication v2 C3 fixed the rule this record applies:

- the pin is a document and one of its versions;
- the version pinned is the one **in force** at the dispatch instant — the greatest
  `effective_from` at or before it;
- it must **cover** the segment's model;
- `CLI_SUBSCRIPTION` is priced like any other transport;
- a NULL pin is admitted **only** for the cohort before 2.9.0.

The DT's answers settled the rest:

- **Q-C1.** From 2.9.0, a NULL `model_version_id` refuses dispatch before spend.
- **Q-C2.** The outcome builder is C's.
- **Q-C3.** A tie between versions is refused as ambiguous. A transition id stays
  within its bound.
- **C-D2.** One discriminated transition builder covers the three arms.
- **C-R2.** The tie negative is a pure selector test.
- **Round 2.** A single-constructor law is added.

## Decision

**One — the pin's home and its cohort.** A `DISPATCH_INTENDED` carries
`catalogDocumentId` and `catalogVersion` in `payload.dispatch`, and
`dispatch_attempt_read_model` gains three columns: `dispatch_contract_version`,
`catalog_document_id` and `catalog_version`.

The cohort is a closed list, `PRE_CATALOG_PIN_CONTRACT_VERSIONS`: 2.2.0 through
2.8.0. A delivery of one of those versions names no pin; one of any later version
names one. The fold, the door and migration 23's two triggers hold the same seven,
and the suite holds the spellings equal.

The reader, `dispatchPinReading`, reads each key three ways: absent, lawful, or
present-invalid. Present-invalid includes JSON `null`, an empty string, a zero, a
string number and a fraction, and it is refused naming the field, never read as
absent. The reader also refuses:

- half a pair;
- a pin on the cohort before;
- none on the cohort after.

The door, the write path and the fold all ask it first and refuse in its words.
The pin is part of the delivery's birth, so the same delivery with another pin is
the existing "intended once" conflict.

**Two — in force, and covering, checked before any spend.** For a delivery of 2.9.0
or later, the append door asks three questions of the registry stream. It asks them
before the delivery exists, and so before any provider is called:

- **(a) Published.** The pin names a published `PRICE_TABLE` version.
- **(b) In force.** It is the version in force at the event's `occurredAt`, chosen by
  `selectVigentCatalogVersion`. A version not yet in effect is refused. So is an
  older one while a newer rules. A tie at the ruling instant is refused as
  ambiguous and never resolved by picking one.
- **(c) Covering.** It covers the segment, per `pinCovers`: an interval of that exact
  version names the segment's provider, model version and transport kind, with its
  half-open window holding the instant. A segment with no resolved model version is
  never covered (ADR 0092 Four), so from 2.9.0 it cannot be dispatched (Q-C1).

Class and currency are not asked here: their absence is valuation's `PRICE_MISSING`.
Every refusal names the field and states the instant and the version in force. It
never states a price, a zero or an estimate.

**The dispatch instant is the walk's canonical instant, not the time of the call.**
It is the event's `occurredAt`, which is the invocation's submission instant, carried
by every event of the walk. For a task that entered through the intake, it is the
intake's `occurredAt`. It is derived, never read from a clock. Two consequences
follow:

- A catalog version that takes effect between the submission and the real call to
  the provider is not the one pinned. The window is the walk's latency.
- A resumed walk pins what its first run pinned, because its instant does not move.

**The instant must be canonical, and it is checked first.** The selector compares
instants as text, and text order is time order only in the contract's one canonical
form: ISO-8601 with milliseconds, in UTC, ending in `Z` (ADR 0092's inherited
obligation). The event's `occurredAt` is a contract `Timestamp`, which admits
offsets and other precisions. An instant such as `2026-08-01T01:00:00+02:00`, which is
`2026-07-31T23:00Z`, sorts after a version that takes effect at
`2026-08-01T00:00:00.000Z`. It would pick that version while the previous one rules.
So a delivery of 2.9.0 or later whose `occurredAt` is not canonical is refused at
`occurredAt`, before any version is selected. It is never normalized.
`getVigentCatalogPin` refuses a non-canonical `instant` the same way, rather than
answering it.

For P-15/D: choose the pin with `Ledger.getVigentCatalogPin(documentId,
invocation.submittedAt)`, never with a clock.

The door is the only place these checks run, on the result reference's precedent
(ADR 0098). The registry is another stream, and a rebuild folds one chain at a time.

**Three — one authority for the choice and the check.** `selectVigentCatalogVersion`
and `pinCovers` are pure functions of the price-catalog concept, exported from the
ledger barrel. `Ledger.getVigentCatalogPin(documentId, instant)` answers which
version is in force over the rows the door reads. P-15/D's composition chooses its
pin with the same functions the door holds it to. `resolvePrice` stays uncalled:
the door decides whether a pin may be recorded, never a price.

**Four — migration 23 and 2.9.0.** Migration 23 is additive and rebuilds no table:

- three nullable columns;
- CHECKs for the version-independent row law: non-empty text, a version number of
  at least 1, and the pair both or neither;
- two cohort triggers, whose first statement refuses a row with no version, so
  `NULL NOT IN (...)` never lets one through;
- a backfill in the same transaction that writes each existing delivery's version
  and pin from its own intention, through the same reader.

A raw-SQL matrix proves the rule. It covers every combination of the three columns
(11 × 3 × 3), on INSERT and on UPDATE separately, against an oracle written from
this rule and not from the SQL. It asserts which statement or CHECK refuses each
cell. `CONTRACT_VERSION` moves to 2.9.0, and `SUPPORTED_CONTRACT_VERSIONS` grows to
eight.

**Five — the builders.** The runtime's events concept gains three builders. Each is
closed by construction, refuses a V1 invocation by name, and stays off the runtime
barrel until D wires it:

- **`buildEffectIntentionEvent`** derives the effect id, its idempotency key and the
  logical digest with the ledger's own functions, which it never restates.
- **`buildDispatchIntentionEvent`** takes the pin as a required input, so it cannot
  emit a pin-less delivery.
- **`buildDispatchTransitionEvent`** is discriminated, with one record literal per
  arm:
  - `INFLIGHT` has an accepted instant and a handle;
  - `ABANDONED` has a terminal instant and never an accepted instant or a handle;
  - `SETTLED` has a terminal instant, the outcome, and the result pair only when
    there is one.

Transition ids are bounded:

- `effect-intended.` plus the 64-hex effect id is 80 characters;
- a delivery's intention and moves are named by the kind plus the sha-256 of the
  delivery id, so no id can overflow the contract's 120.

**Six — the laws.**

- **`L-P15C-1`** (new, path-scoped). In `src/`, only `runtime/src/core/events/index.ts`
  constructs `EFFECT_INTENDED`, `DISPATCH_INTENDED` or `DISPATCH_OUTCOME_RECORDED`.
  The home must construct each of the three. A construction is `type:` followed by
  the literal, or by any `src/` constant declared as one of the three words, such
  as the ledger's `EFFECT_INTENDED`. Stated limit: a name renamed on import, a value
  computed at run time, or a spread of an object that already carries `type` is not
  seen.
- **`L-P33B-1`**, amended in its row. The ledger's `ledger/index.ts` is admitted as the
  one caller of the concept, for exactly `selectVigentCatalogVersion` and
  `pinCovers`, and may not name `resolvePrice`.

## The tie, and where it is refused

The registry does not forbid publishing two versions of one document with the same
`effective_from`: its index on `(document_id, effective_from)` is not unique, and
no door rule orders the instants. So the selector is the one place the ambiguity is
caught.

The lasting test is a pure one: the tie is fed straight to
`selectVigentCatalogVersion` (C-R2). A door test that plants the tie through the
registry's own door exists only while this escalón precedes the rule that will
forbid publishing it. Once that rule lands, the selector's refusal is reachable
only on ledgers written before it.

## Why the pin's coverage is not checked by a trigger

A trigger sees one row of one stream. Whether a version is published, in force and
covering is a question about the registry stream's projections. Answered in a
trigger, it would make a rebuild of the task stream depend on the order in which
another stream was folded. The door asks it, as it asks whether a result reference
exists (ADR 0098). The base holds only what a row can know by itself.

## Consequences

- `MIGRATIONS` 22 → 23. The `tr_` inventory goes 11 → 13.
- `CONTRACT_VERSION` 2.8.0 → 2.9.0, with eight supported.
- `PATH_SCOPED_LAWS` 150 → 151.
- The ADR corpus goes 102 → 103, and the decision register gains 122–126.
- `CONTRACTS_SCHEMA_EXPORTS`, `RUNTIME_PUBLIC_EXPORTS`, `PROVIDERS_PUBLIC_EXPORTS`
  and the event vocabulary do not move.
- The envelope-identity vectors move with the version once more, for that reason
  only. The other held vectors are restamped with the version they were lifted
  under, and none of their literals changes:
  - the core/events V1 and V2 walk vectors;
  - since this escalón, P-15/B's six PC-B1 vectors (pressure, tool receipt, failure,
    cancellation, switch player, switch landing). Each hashed the whole stored
    event, so the bump alone moved them.
- **Verifier instruction.** Confirm by restamping that no other V1 byte moved: take
  each of those suites' V1 events, set `contractVersion` to `"2.8.0"`, and check
  that the canonical bytes hash to the pinned literal. The suites do exactly this,
  and none of the literals was re-lifted.
- **Fixtures gained a pin.** Pre-2.9.0 fixtures that write a delivery through the
  real door had to gain one, because the version in force now requires it. They
  publish a `PRICE_TABLE` through the registry door that covers their segment
  (prices are fixture data, never zero). Their segments use the contract's
  transport word, `CLI_SUBSCRIPTION`, because a price interval admits only the
  contract's three and the segment's transport must match to be covered.
- A smoke prerequisite follows from Q-C1: the catalog must cover the exact resolved
  model version of the smoke's segment under its transport.

## Not in this record

- **P-15/D:**
  - which `catalog_document_id` a provider maps to (C3 (i)), which is configuration
    its composition root admits;
  - appending from the daemon walk;
  - exporting the builders.
- **Economy §4:** valuation.
- **A later packet:** the registry rule that forbids two versions of one document
  sharing an effective instant.
- **P-15/D:** a pre-existing gap in the segment door, which admits a segment
  `transportKind` outside `TRANSPORT_KINDS`. Such a segment can never be covered by
  a price interval, which admits only the contract's three words, so from 2.9.0 it
  cannot be dispatched. It is refused at the pin, not at the segment, until D
  closes the segment's grammar.
