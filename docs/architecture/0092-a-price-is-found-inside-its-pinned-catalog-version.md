# ADR 0092 — A price is found inside its pinned catalog version, or named missing, never zero

- Status: accepted (P-33/catálogo escalón B, recorded 2026-09-14).
- Supersedes: none.
- Superseded-by: none.
- Amends: none. One reconciliation of the specification, which is read and not
  edited: `docs/audit/architecture/contracts/estimation/index.md:286` says
  "PricePin referencia la PK completa del intervalo de economy §3". That is the
  estimation DTO's pin, and it is right about the identity. This record's
  `PricePin` is the two columns that choose a *version*; `PriceKey` carries the five
  that choose a row inside it; the eighth, `effectiveFrom`, is what resolution
  finds. Two plus five plus one is economy §3's eight-column key, so the identity is
  the same one, split at the join the map cut A from B along. Economy §3 `:284-286`
  is the authority for the split: a known catalog pin with no applicable interval
  "conserva documento/versión, deja vacía la referencia de intervalo y marca
  PRICE_MISSING" — document and version are the pin; the interval is a separate
  reference.

## Context

Escalón A made the catalog storable and readable. Migration 21 created
`price_interval_read_model` with economy §3's twelve columns and eight-column key;
the registry's append door holds a `PRICE_TABLE` to a closed payload, refuses two
intervals of one quintuple that meet, and publishes a version whole or not at all;
`Ledger.readPriceIntervals({ catalogDocumentId, catalogVersion })` reads one version
exactly, in primary-key order, and answers `[]` rather than throwing when a version
holds nothing (ADR 0091).

What A deliberately did not do is answer a price. The ledger's own types say the
registry "sets no price", and the map cut the packet there: storing a catalog is the
ledger's, and selecting the interval in force at an instant is economy's semantics.
A's `readPriceIntervals` therefore returns rows and no verdict, and its ADR closed
with resolution listed under "Not in this record".

The rule to implement is small and exact, which is the danger. Economy §3 fixes a
half-open window `[effective_from, effective_to)` with `NULL` meaning no declared
end (`:184-185`), an identity of eight columns that includes `token_class` and
`currency` (`:176-189`, `:205`), a lookup that "nunca cruza versiones" (`:205`), and
**no fallback rate of `0`**: with no applicable interval in force the valuation
status is `PRICE_MISSING`, "nunca costo cero" (`:195-197`; data `:674-675`).
Estimation `:291` states the same comparison from the other side, as
`effectiveFrom <= asOf < effectiveTo`. Four comparisons and a boundary rule is
exactly the size of thing a caller writes inline instead of importing — and the
boundary is the half that gets written wrong.

The DT's Q1 settled where the pin lives: no table of execution or dispatch declares
`catalog_document_id` today, and giving it one is P-15's, with the amendment to the
execution dictionary that needs. So B can deliver the verdict but must not wire it.

## Decision

**One — a new concept, `price-catalog`, born conforming to §7.** The module is
`packages/persistence/ledger/src/price-catalog/`, on `usage-settlement/`'s pattern.
Its type leaf `types/index.ts` declares everything it declares — `PricePin`,
`PriceKey`, `PriceFound`, `PriceMissing`, `PriceResolution` and the
`PriceResolutionStatus` union derived from the vocabulary — and `index.ts` holds the
vocabulary value `PRICE_RESOLUTION_STATUSES` beside the resolver, which is §7.1's
one-way derivation. No inline declaration: the ADR 0088 errata of 2026-09-14
withdrew that exception for every new declaration, decision 90 registered it and
C-3 / P-37 seam 1 paid it off for six older concepts. This one starts where they
ended rather than adding a seventh debt.

**Two — the verdict has two members and carries no amount.**
`PriceResolution = { status: "FOUND", interval } | { status: "PRICE_MISSING", pin }`.
`FOUND` carries the row itself, so the price, its currency and the window it was read
from travel together and a caller cannot keep the number while losing what it means.
`PRICE_MISSING` carries the pin, rebuilt field by field so the verdict cannot alias a
caller's object, and **nothing else**: there is no amount field to be zero, which is
economy §3 `:195-197` expressed in a type rather than in a comment. There is no
third member — no "defaulted", no "estimated", no amount-bearing failure.
`PRICE_MISSING` is spelled as economy §4's valuation status spells it, so the ledger
and the dictionary do not drift into two names for one outcome.

**Three — `resolvePrice` is a pure function of four arguments.**
`resolvePrice(intervals, pin, key, instant)`. Rows in — the ones
`readPriceIntervals` already returned, already bounded to a version — a pin, a key
and the dispatch's authoritative instant; a verdict out. No database handle, no
clock, no randomness, no identity, no I/O. The same four arguments always give the
same verdict, which is what lets a replay reprice a spend and get the number the
spend was charged (economy §3's rebuild row, `:207`).

**Four — the match is the whole quintuple, and a null model version is missing.**
`provider`, `modelVersionId`, `transportKind`, `tokenClass` and `currency`, each
exactly, with no fallback between any of them: the currency is part of the identity
and is never converted here, so "no price in USD" is a missing price and not a reason
to read the EUR row (`:176-189`; data `:648-649`). `PriceKey.modelVersionId` is
nullable because the asking side may not know it — an execution route segment records
provider and transport but admits a NULL `model_version_id` — and a null is answered
`PRICE_MISSING` and **never** aliased to another model version's price. A price for a
model nobody named is an invented number, which §3 forbids more strongly than it
dislikes a missing one. The guard is stated twice on purpose: once before the scan,
and once as the row comparison itself, so neither alone is load-bearing.

**Five — the window is half-open, and the version is checked first.**
`effectiveFrom <= instant` and, when `effectiveTo` is not null, `instant <
effectiveTo`; a null `effectiveTo` covers every instant at or after the start. So the
start is covered and the end is not: at the boundary between two adjacent intervals
exactly one prices the instant, and it is the later one. Before the window and before
the key, the document and the version are checked: a row of another document or
another version is not a candidate however current it looks (`:205`), so passing a
wider list than one version is safe by construction rather than permitted by
accident.

**Six — it selects, and does not re-admit.** The resolver does not re-check overlap,
does not re-validate a row's shape and does not ask whether a model version is still
registered. A rebuild folds what the door admitted (N-P14A-7), and a resolver that
re-judged stored rows would be a second, weaker door whose verdict could differ from
the one the door gave. At most one row of a quintuple can cover an instant because
the door refused the version otherwise, so taking the first match is selection and
not a tie-break. What the resolver does check is the *question* — the pin, the key
and the instant — against the rows it was handed. A malformed pin needs no branch: no
stored row carries an empty document id or a version below 1, so it matches nothing
and is answered missing, carrying back the pin it was asked with.

**Seven — L-P33B-1, and no caller.** The resolution is reached through the ledger's
barrel by name, and reimplemented nowhere: no `src/` outside the concept — the module
**and** its type leaf — and the package barrel imports the module's path or names the
verb. The law is scoped over the concept and not over one file, which is C-3 / P-37
seam 1's adjudicated mould (decision 91). Unlike L-P32B-1 this law admits **no
caller at all**, because nothing may call it yet: the pin has no physical home until
P-15, so a caller today would be pricing against a version nothing recorded.
`PATH_SCOPED_LAWS` 143 → 144.

**Eight — no bump.** No table, no migration, no event type, no document kind and no
door is new. These are facts about what A already published, and ADR 0076's criterion
adds no way of computing an identity. `CONTRACT_VERSION` stays `"2.6.0"`,
`API_CONTRACT_VERSION` `"0.17.0"`, `PROJECTOR_VERSION` 1, `MIGRATIONS` 21.

## Why a resolver that reads the catalog itself was not chosen

`resolvePrice(ledger, pin, key, instant)` would be one call instead of two and would
remove the chance of handing it the wrong rows. It was rejected for three reasons.
A read inside the resolver is a read at a moment, and the whole point of a pin is
that the answer does not depend on when it is asked; a caller that reads once and
resolves many keys against the same rows — which is what a settlement over several
token classes does — would otherwise read the same version once per class. And a
function that touches the database cannot be exercised as arithmetic: the drills for
the boundary, the null key and the currency identity are twenty-one assertions with
no file on disk. The wrong-rows risk is answered instead by the document-and-version
check being the first thing the loop does, which makes a wider list harmless.

## Why a fallback to the nearest interval was not chosen

A missing price is operationally annoying: a spend that cannot be valued blocks a
cost line. Reaching for the nearest interval in time, or the only row in a
single-row catalog, or the same key in a later version, would make that annoyance
disappear. Each of those is economy §3's forbidden zero wearing a different
costume — a number nobody published, attributed to a version that did not contain
it. `:195-197` is unambiguous, and `:284-286` says what to do instead: keep the pin,
empty the interval reference, mark `PRICE_MISSING`. A cost that cannot be computed
is reported as uncomputed, and what that means for a budget belongs to whoever reads
it, not to the selection.

## Why the resolver does not validate the caller's instant

The comparison is textual, and it is only sound for the canonical millisecond UTC
form. A's door guarantees that form on every stored `effective_from` and
`effective_to` (ADR 0091 §Three), so the catalog side is safe; the *caller's* instant
is not checked here. Adding a check was considered and rejected for this escalón: the
grammar has no importable single home — `OUTBOX_INSTANT_PATTERN` and
`isModelVersionInstant` are module-private in `projection/index.ts` — so the check
would have restated the grammar in a second place, which is the drift this repository
refuses elsewhere. Restating it to guard against a caller that does not exist yet
trades a real, permanent second encoder for a hypothetical bug.

This is named rather than hidden: **the caller must pass the canonical form**, and
P-15 is where that obligation becomes checkable, because P-15 is where a real caller
appears and where the dispatch's authoritative instant is recorded. A non-canonical
instant today compares as text and can select wrongly; that is a boundary of this
record, not an accident of it.

## Consequences

- `PATH_SCOPED_LAWS` 143 → 144. The ADR corpus 91 → 92; the decision register
  91 → 93. The ledger barrel gains `PRICE_RESOLUTION_STATUSES`, `resolvePrice` and
  six types. Nothing else moves: no schema object, no projection, no watermark, no
  migration and no contract, because a pure function adds none of them.
- **Nothing calls it.** That is the intended state and the law enforces it. The
  module is inert until P-15 records a pin before the spend; anyone reading the
  package and expecting prices to flow will find the verb, the law and this
  paragraph, in that order.
- The obligation P-15 inherits is specific: give the pin a physical home on an
  execution route segment or a dispatch, amend the execution dictionary for it, hold
  the caller's instant to the canonical form, and amend L-P33B-1's row to admit the
  one caller it wires. Until then a cost line that needs a price has none.
- A caller that holds rows of several versions may resolve against any of them by
  changing only the pin, which is what a replay does. The cost is that the resolver
  cannot tell a caller it was handed the wrong version — only that the version it
  pinned has no answer.

## Not in this record

- Persisting the pin on a segment or a dispatch before the spend, and the execution
  dictionary's amendment that needs: P-15 (the DT's Q1).
- Rationals, the exact numerator, rounding and `HALF_TO_EVEN`, `cost_snapshot_*` and
  the valuation policy digest: economy §4. Periods and proration: §5-§6.
- Performance measurement (§7) and retiring the legacy `price_read_model` (§8).
- The estimation DTO's own `PricePin` with its request digest, which is P-29's
  simulation pin and not this one.
- Whether a later catalog version must cover an earlier one's span, or keep its
  provider: neither dictated nor invented here, as ADR 0091 also declined to.
