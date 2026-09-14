# ADR 0091 — A price interval is published whole by document and version, or not at all

- Status: accepted (P-33/catálogo escalón A, recorded 2026-09-14).
- Supersedes: none.
- Superseded-by: none.
- Amends: `0088-a-settlement-fold-never-invents-a-number.md`, by a dated errata that
  withdraws one line of its **Eleven** for every new declaration (Twelve; C-2). No
  other line of that record is rewritten, and its status stays accepted.
  Three precisions on the specification, which is read and not
  edited. Economy §3 `:206` names `ix_price_interval_read_model__lookup` over the
  primary key's eight columns in the primary key's order; it is not created (Four).
  `docs/audit/architecture/database/index.md` §13 `:669-670` states the no-overlap rule
  over `(provider, model_version_id, token_class, currency)`; the key followed is
  economy's (Five). Economy §3 `:194-195` places the overlap negative in
  `docs/audit/quality/testing/index.md`, which does not hold it; it lives in the
  ledger suite as N-P33-1.

## Context

Economy §3 replaces `price_read_model` with `price_interval_read_model`: one row per
interval of one catalog version, the document **and** the version in every key, a
half-open `[effective_from, effective_to)`, an integer price in nanounits of an
explicit currency, no two intervals of one quintuple that meet within a version, the
version published whole in one transaction, no zero price by default, and a rebuild
that is deterministic from `registry_events`. The registry stream has carried
`PRICE_TABLE` since migration 9 (`ck_registry_events__document_kind`); nothing folded
it, and the registry door "sets no price".

The P-33 map cut the packet A → B: storing and publishing a catalog is the ledger's,
resolving a price at an instant inside a pinned version is economy's. The DT
adjudicated the map's five questions: the pin's physical home on a segment or a
dispatch is P-15's (Q1); the payload is inline under the registry's 64 KiB bound, and
a catalog that does not fit is its own packet on the artifact plane (Q2); the door
requires every `model_version_id` to be registered, in any status (Q3); a currency is
`^[A-Z]{3}$`, the form of the execution dictionary's `:682`, with no closed ISO list (Q4); and the lookup
index is not created (Q5). The Fable preaudit of the writer's brief
(ACCEPT_WITH_CORRECTIONS, H-1..H-11) fixed what the brief left open — the table's
name (H-1), the four sites of the fold (H-2), the door's hybrid form (H-3), how the
overlap key relates to database `:670` (H-4), the payload's names (H-7), the canonical
instant (H-8), the reading's empty answer (H-9) — and asked the DT whether the door
crosses the provider (H-11); the DT ruled option (a).

## Decision

**One — the table is economy's, under economy's name** (H-1). Migration 21 is named
`price_interval_catalog`; the table it creates is `price_interval_read_model`, and so
is its watermark's `projection_name` (migration 17's precedent). Twelve columns, STRICT:
`catalog_document_id`, `catalog_version`, `provider`, `model_version_id`,
`transport_kind`, `token_class`, `currency`, `effective_from`, `effective_to` (the one
nullable column: `NULL` is no declared end), `price_per_million_nanos` (INTEGER, no
float anywhere), `recorded_by`, `sequence`. `pk_price_interval_read_model` is the
eight-column key of `:205`. The checks carry the §3.2 names:
`ck_price_interval_read_model__token_class` (`input`, `output`, `cache_write`,
`cache_read`), `__interval_order` (`effective_to IS NULL OR effective_to >
effective_from`), `__price_per_million_nanos` (`>= 0`), `__currency`
(`length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'`, Q4), `__catalog_version`
and `__sequence` (`>= 1`, migration 17's pair). No foreign key — not into
`registry_events`, not into `model_version_read_model` — and no trigger: the checks a
catalog needs across rows or tables are the door's.

**Two — the payload is closed, and its names are fixed** (H-7). A `PRICE_TABLE`
payload is `{ intervals }` and nothing else (`PRICE_TABLE_PAYLOAD_KEYS`); `intervals`
is a non-empty list; each interval carries exactly `provider`, `modelVersionId`,
`transportKind`, `tokenClass`, `currency`, `effectiveFrom`, `effectiveTo`,
`pricePerMillionNanos` (`PRICE_INTERVAL_KEYS`), every key required and `effectiveTo`
present as `null` or as an instant (`deprecatedAt`'s precedent). `provider` and
`modelVersionId` are text of 1 to 512 characters; `transportKind` is a word of the
contract's `TRANSPORT_KINDS`; `tokenClass` one of `PRICE_TOKEN_CLASSES`; `currency`
three upper-case letters; `pricePerMillionNanos` a safe integer of zero or greater.
`catalog_document_id` and `catalog_version` are the document's own coordinate, and
`recorded_by` and `sequence` the event's: none of the four is written in the payload.
The three closed sets are exported beside `DOCUMENT_KINDS`, for its reason.

**Three — instants are canonical, because the checks compare text** (H-8).
`effectiveFrom` and `effectiveTo` are held to `OUTBOX_INSTANT_PATTERN` and to a
round trip through `Date` (`isModelVersionInstant`): `+00:00`, a missing millisecond
field and a day that does not exist are refused. For that form text order is time
order, which is what `__interval_order` and the overlap check rely on.

**Four — no lookup index** (Q5). `ix_price_interval_read_model__lookup` would name
the primary key's eight columns in the primary key's order; SQLite's automatic index
behind the key is that index, written on every insert and used by the same lookups.
A second copy is not created. `EXPECTED_SCHEMA_OBJECTS` gains one table and nothing
else: the automatic index carries the reserved prefix the inventory excludes.

**Five — the overlap key is the primary key without `effective_from`** (H-4). Within
one version, no two intervals of one `(provider, model_version_id, transport_kind,
token_class, currency)` meet — the quintuple of economy `:190-191`. Database `:670`
abbreviates the same rule without the transport; economy is followed because the
primary key and the price both distinguish transport, so two transports of one model
may carry different prices over the same window. The rule is fail-closed at the door
before the version is admitted: the same primary key twice is
`PRICE_INTERVAL_DUPLICATE`, two intervals that meet otherwise are
`PRICE_INTERVAL_OVERLAP`, each at the later interval's path. Adjacent intervals,
`[a, b)` then `[b, c)`, do not meet; an open end meets every later start.

**Six — the door is hybrid, on its own branch** (H-3, Q3, H-11).
`#assertRegistryDocumentAdmissible` dispatches three ways: `MODEL_VERSION` to
`modelVersionPayloadIssues`, `PRICE_TABLE` to `priceTableIssues`, and every other kind
to `globalAssignmentIssues`, which admits the kinds it does not gate. `priceTableIssues`
is `globalAssignmentIssues`' form: the pure shape (`priceTablePayloadIssues`) first,
refused before any lookup; then a lookup of `model_version_read_model` injected by the
door. Each interval's model version must be registered, in any status — a RETIRED
version keeps its historical price — or the refusal is `MODEL_VERSION_UNKNOWN` at
`payload.intervals[i].modelVersionId`; and registered under the interval's own
provider, or it is `MODEL_VERSION_PROVIDER_MISMATCH` at `payload.intervals[i].provider`
(the lookup already returns the row). The transport is not held against the version's
admitted transports: that is the resolver's. `LedgerValidationError`, the closed word at
the head of the message, no value echoed, no new error class. The order is the
registry door's: the 64 KiB body bound before the transaction (Q2: about two hundred
intervals fit, four hundred do not), then replay, event id, lineage, this gate,
causation, the insert.

**Seven — existence is the door's, and the fold reads the shape** (H-3). The fold does
not ask whether a model version is registered. A rebuild folds what the door admitted
(N-P14A-7): a version retired, or re-registered under other words, after a catalog
named it does not unpublish the price. So "migration 21 folds what the door would"
(N-P33-12) means it folds the same shape; whether each model version existed was
decided when the version was admitted.

**Eight — one fold, total and whole per version, in four sites** (H-2).
`nextPriceIntervalProjection` returns every interval of a `PRICE_TABLE` version, or the
version with no row when `priceTablePayloadIssues` refuses its payload — never a part,
and never a throw: the stream has no delete path, and a fold that kept the readable
half of an unreadable version would publish exactly what the door refuses. Only
history written before migration 21, or planted past the door, reaches that branch.
Insert-only: a version's rows are keyed by the version, so a later version —
retroactive or not — adds rows beside the earlier version's and changes none. One
writer, `writePriceIntervalProjection`, plain `INSERT`, no `ON CONFLICT`. The four
sites:

- **the door**, `#projectRegistryDocument`, inside the registry append's transaction,
  after the insert and before the head and the watermarks: a failure anywhere leaves
  no event, no row, no head and no watermark;
- **migration 21's `afterSql`**, which folds every `PRICE_TABLE` the stream already
  holds in the transaction that applies the migration;
- **the rebuild**, which clears the table (it is in `DERIVED_TABLES`), folds the
  registry into a snapshot and writes it back through the door's writer;
- **`verifyIntegrity`**, which folds the same snapshot and compares the table row for
  row in canonical form in both directions, naming the document and the version of a
  rewritten, missing or unaccounted row and never its price.

**Nine — migration 21.** One watermark seeded from the registry head in migration 17's
form, and the retroactive fold in the same transaction, so the table is level with the
head the moment the migration commits; a failure applies nothing.
`PRICE_INTERVAL_CATALOG_MIGRATION = 21`, `PRICE_INTERVAL_PROJECTION`.
`REGISTRY_PROJECTION_NAMES` gains the name and `PROJECTION_SOURCES` the pair, so
`status()` and the integrity report carry the watermark.

**Ten — reading exactly by document and version** (E8, H-9).
`Ledger.readPriceIntervals({ catalogDocumentId, catalogVersion })` returns every
interval of that version and of no other, in primary-key order, from one read
transaction, with no clock and no write. A version that holds no row — a document or a
version never published, or a version the fold could not read — is `[]`, never an
error and never a zero row: whether no price is `PRICE_MISSING` is escalón B's to say,
fail-closed. A malformed pin is `LedgerQueryError`. No watermark travels with the
answer, unlike `getModelVersion`'s: a published version's rows are written once in the
transaction of its event and never change, so the pin is the whole of what the answer
was read at. `PriceIntervalQuery` is structural; escalón B's pin fits it.

**Eleven — no bump.** No contract, event type or document kind is new: `PRICE_TABLE` is
in both CHECKs since migration 9, and a catalog is configuration recorded by the
registry. ADR 0076's criterion adds no way of computing an identity; decision 41's adds
no cohort. `CONTRACT_VERSION` stays `2.6.0`, `API_CONTRACT_VERSION` `0.17.0`,
`PROJECTOR_VERSION` 1.

**Twelve — every new declaration of this packet lives in the semantic leaf, and
ADR 0088's inline exception is withdrawn** (C-1, C-2 of the writer brief v3, on the
restart audit's H1). The owner's law is `docs/audit/architecture/index.md` §7: all of
a concept's `interface`, `type` and alias declarations live in its `types/index.ts`
leaf, private ones included, and named declarations are never interleaved with
implementation. So `PriceTableRefusal` and `PriceTableModelVersion` leave
`src/projection/index.ts`, `PriceIntervalRow` leaves `src/ledger/index.ts`, and all
three sit in `src/types/index.ts` beside this packet's other declarations and beside
the row types already there (`AccountActionRecordRow`,
`RoutingAssignmentFallbackRow`). Their consumers import them with `import type`. The
vocabulary travels with the derived union, as §7.1's one-way derivation requires:
`PRICE_TABLE_REFUSALS` moves to the leaf beside `PRICE_TOKEN_CLASSES`,
`PRICE_TABLE_PAYLOAD_KEYS` and `PRICE_INTERVAL_KEYS`, because a leaf may not import
a value back from the implementation it types. No published surface moves: the
package exports only its barrel, and the barrel's exports are unchanged.

ADR 0088's line "Types live inline in the module (H-11)" is therefore
**SUPERSEDED** for every new declaration, by a dated errata in that record and by
decision 90 — a brief's acceptance and an auditor's `ACCEPT` do not amend an owner
law, so that line never carried the authority to admit the exception. The
declarations already inline in `usage-settlement`, `artifact-plane`,
`artifact-lease-store`, `initiative-registration`, `assignment` (accounts) and
`intake` (runtime) are **pre-existing debt, named here and not paid here**: their
bounded, mechanical correction is a separate adjudicated packet with its own
write-set (C-3), opened after this escalón closes. Folding it in would have made
this packet's write-set something other than what was frozen, which is the one
thing a packet may not do to itself.

## Consequences

- `MIGRATIONS` 20 → 21. `DERIVED_TABLES` +1. `REGISTRY_PROJECTION_NAMES` 5 → 6; the task
  stream's `PROJECTION_NAMES` stays 16. `PROJECTION_SOURCES` 25 → 26, which reaches
  `status()` (25 projections, 26 heads). `EXPECTED_SCHEMA_OBJECTS` +1; the `tr_`
  inventory stays nine. `RebuildResult` gains `priceIntervalRows`.
- The ledger barrel gains `PRICE_TABLE_PAYLOAD_KEYS`, `PRICE_INTERVAL_KEYS`,
  `PRICE_TOKEN_CLASSES`, `PriceIntervalReadModel`, `PriceIntervalQuery` and
  `PriceTokenClass`. No law is coined: `PATH_SCOPED_LAWS` stays 143.
- Every rewind past 20 drops the table and its watermark row first. The CLI and gateway
  rewinds publish one catalog version and assert that the re-applied 21 folds it back
  into the same rows.
- A `PRICE_TABLE` that some earlier build recorded with another payload stays in the
  stream and publishes no row; the integrity report stays clean over it.
- The packet's write-set is sixteen paths: the fifteen it was frozen with, plus
  ADR 0088 for the errata alone (C-2). The decision register 86 → 90: three rows for
  the catalog, and one for the separation of declarations, the errata and the debt
  the separate packet pays (C-1, C-2, C-3).

## Not in this record

- Resolving a price at an instant, `PricePin`, `PriceKey` and `PRICE_MISSING`: escalón B.
- Persisting the pin on a segment or a dispatch before the spend: P-15, with the
  execution dictionary's amendment (Q1).
- A catalog on the artifact plane, for versions past the registry's bound (Q2).
- Cost snapshots, valuation policy, rationals and rounding (economy §4), periods and
  proration (§5-§6), performance (§7), and retiring `price_read_model` (§8).
- A lifecycle rule between catalog versions — whether version 2 must cover version 1's
  span, or keep its provider — is neither dictated nor invented here.
