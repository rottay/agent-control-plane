# ADR 0088 — A settlement fold never invents a number, and a late report revises, never rewrites

- Status: accepted (P-32/captura escalón A, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.
- Amends: nothing. Economy §1–2 (`docs/audit/architecture/database/economy/index.md`)
  is read, not edited; the rule for what sums and what competes below is the reading
  of §1.3.3–§1.3.4 the Fable preaudit fixed (H-3) and the DT adjudicated, and it is
  recorded here rather than folded back into the dictionary.

## Errata, 2026-09-14

One line of **Eleven** below — "Types live inline in the module (H-11)" — is
**SUPERSEDED** for every new declaration by the owner's law in
`docs/audit/architecture/index.md` §7: all of a concept's `interface`, `type` and
alias declarations live in its semantic leaf, private ones included, and named
declarations are never interleaved with implementation. A brief's acceptance and an
auditor's `ACCEPT` do not amend an owner law, so that line never carried the
authority to admit the exception, and this record withdraws it rather than defend it.

What this errata does **not** do: it does not touch the sentence that follows it —
escalón B still types its five row interfaces in `src/types/index.ts` from these
shapes, never restated — and it does not rewrite any other line of this ADR. The
declarations already inline in `usage-settlement`, `artifact-plane`,
`artifact-lease-store`, `initiative-registration`, `assignment` (accounts) and
`intake` (runtime) are pre-existing debt, named and bounded: correcting them is its
own adjudicated packet with its own write-set (C-3 of the P-33/catálogo A writer
brief v3), not a clause of this errata and not a repository-wide reorganization.

Reconciled by P-33/catálogo escalón A (ADR 0091, decision 90), which separated its
own new declarations into the ledger's `src/types/index.ts` leaf.

## Context

Economy §1 records spend as observations on **measurement streams** — one per
`(source, account_id, route_segment_id, source_epoch)` — and §2 folds them, per
effect, into a **settlement revision**: a header with four token classes and a
total, the vector of heads it was computed at, and the exact list of observations
it considered. §1.3 is the fold: correction chains, disjoint DELTAs, CUMULATIVEs
that contain whole or stay disjoint, a precedence of source classes frozen by
`source_policy_sha256`, alternatives that never sum, DISPUTED with NULL counts,
FINAL only on gapless coverage with an explicit final, UNKNOWN without reports, and
lateness by ledger arrival order.

At `bd29905` none of that existed. The only usage record was `TOKEN_USAGE_RECORDED`,
one total with no classes, range, stream or effect, and the observation rollups
**sum** it — the opposite of "alternatives never sum". Nothing could be extended
from it without inventing classes (P-32 map, §2).

Economy §1.2 makes stream, observation and settlement one transaction with the
append, so the door, the tables and the fold cannot land apart. The fold, as a pure
function over values, can land first. The DT cut P-32/captura A → B → C
(adjudication Q1–Q5): A is that function and the stream identity, inert; B the
migration, two event types, the door and the rebuild; C the recorders, unwired.

The writer's first brief named the fold and its laws. The Fable preaudit
(ACCEPT_WITH_CORRECTIONS) found what two honest writers would have built
differently: the preimage's shape (H-1), what the policy digest is a digest of
(H-2), what sums and what competes (H-3), the fold's exact input and output (H-4),
how a refusal is spoken (H-5), which "earlier" coverage rules mean (H-6), how the
counts are represented (H-7), and that "inert" was prose no law measured (H-8). The
DT adopted all eight.

## Decision

**One — the stream identity is a versioned preimage of its coordinate.**
`measurementStreamPreimageV1(coordinate)` is
`USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1` — `acp/usage-measurement-stream/v1`
and exactly one LF — followed, with no separator, by the canonical JSON of the
positional array `[source, accountId, routeSegmentId, sourceEpoch]`;
`measurementStreamIdV1` is its SHA-256. Two exported steps, so a vector pins each,
on `effectIdV1`'s shape. The function takes the coordinate, never an assembled
preimage, and refuses by name before hashing: three non-empty texts (migration 13
gives the segment no shape CHECK, so no grammar is invented) and a safe epoch
`>= 0`, `-0` excluded; the refusal is a `LedgerValidationError` whose issue names
the field and opens with `STREAM_COORDINATE_INVALID`. The provider's reusable
connection id never enters. Only `canonicalJsonStringify` and `sha256Hex` from the
package's canonical-json module are used.

**Two — the policy is a literal document, and the fold runs only its own version.**
`USAGE_SOURCE_POLICY_V1` is a frozen literal — `policyVersion: 1`, the precedence
`PROVIDER_AUTHORITATIVE > WRAPPER_MEASURED > ESTIMATE`, `alternatives: NEVER_SUM`,
`incomparable: DISPUTED`, and the coverage rules (`delta: DISJOINT`, `cumulative:
CONTAINS_WHOLE_OR_DISJOINT`, `partialOverlap: REFUSE`, `forkedCorrections: REFUSE`).
`USAGE_SOURCE_POLICY_SHA256_V1` is `sha256Hex(canonicalJsonStringify(...))`, pinned by
the suite as `ba36f058…2c95`. `USAGE_FOLD_VERSION_V1` is `1`. Both live in
`@acp/ledger`, decision 45's class (Q4). The fold receives the policy and the fold
version as parameters and refuses a policy whose digest is not V1's
(`POLICY_UNSUPPORTED`) or a version other than 1 (`FOLD_VERSION_UNSUPPORTED`): the
algorithm is the policy, and a header must not stamp a version that did not execute.

**Three — the fold's input and output are fixed.** `foldUsageSettlement(request)`
takes: `cut` `{ effectId, controlHead: { sequence, sha256 } }`; `trigger`
`{ sequence, recordedAt }`; `streams` with their `sourceClass`; `observations` in
§1.2's shape; `previous` `{ settlementRevision, status, sequence } | null`;
`lastFinalSequence`; `policy`; `foldVersion`. It returns `{ ok: true, settlement }`
— `header` with §2.1's fourteen fields (the five counts `bigint | null`),
`sourceHeads` with exactly the control row (genesis iff sequence 0), `observationIds`
with every considered observation ordered by sequence (then id), and `segments`, the
per-segment election (not persisted by B; the segment-level settlement P-33 reads).
Revision is `previous + 1` or 1; `computed_at` and `sequence` are the trigger's,
byte for byte; `last_observation_id` is the considered observation with the greatest
sequence, whether it won, lost or was corrected, or NULL. Zero observations give an
empty list, not an absent one.

**Four — what sums, and what competes** (H-3, adjudicated):

1. `source_class` belongs to the stream and enters through it; an observation
   carries none.
2. The unit of competition is the **lineage** `(source, account_id,
   route_segment_id)`. Ranges are compared only inside one stream; a lineage's
   epochs are consecutive stretches with distinct counter spaces, so their effective
   coverages **sum**.
3. Inside a segment, lineages are alternatives: the highest class wins. Equal-class
   winners are comparable iff their four class sums agree, and the lineage with the
   least `measurement_stream_id` (code points) is chosen; if they differ the segment
   and the settlement are DISPUTED, the five counts NULL, every contender listed.
4. Across segments the elected coverages sum.
5. FINAL needs every stream of every elected lineage gapless **and** carrying an
   effective `is_final = 1`; anything less is PARTIAL. No observation is UNKNOWN.

**Five — refusals are a closed, sorted vocabulary.** `USAGE_SETTLEMENT_REFUSALS`, on
`decideRoadmapVersion`'s shape, outcome `{ ok: false, reason, at }` where `at` names
the field and indexes the caller's array, never a count. DISPUTED is a settlement,
not a refusal (Q2). The order of the checks: fold version, policy, request, streams,
each observation alone, stream membership and the cut, identity duplicates, the
correction graph, the effect, lineage class, coverage, and last the int64 ceiling.
B's door converts a refusal into `LedgerValidationError` by name, as P-18/D did.

**Six — coverage rules that depend on order** (H-6). Inside a stream, reports are
read by ascending ordinal, not arrival. A CORRECTION's coverage is its target's; a
chain A ← B ← C is one effective report with C's values and A's coverage, and the
list holds all three. Two corrections of one target are `CORRECTIONS_FORKED` even
with equal bytes: two ids are two reports, and replay by identity is the door's. A
DELTA that touches any effective range is `COVERAGE_OVERLAP`; a CUMULATIVE replaces
every earlier effective range it contains whole and is `COVERAGE_OVERLAP` on a
partial overlap or when it sits strictly inside an earlier one. "Gapless" is one
contiguous half-open interval; economy fixes no origin, so none is required.

**Seven — arithmetic** (H-7). Every input count is a safe integer `>= 0`; a total
that is not the `BigInt` sum of its four classes is `TOTAL_MISMATCH`, which is also
what makes counting cached input twice impossible. Sums run in `BigInt`; a segment
or header count above `USAGE_SETTLEMENT_TOKENS_MAX` (`2^63 - 1`) is
`TOKENS_OVERFLOW`; exactly `2^63 - 1` passes. `better-sqlite3` binds `bigint`, so B
does not convert.

**Eight — lateness is arrival order.** `had_late_arrival` is 1 iff
`lastFinalSequence` is not null and some considered observation has a sequence
greater than it. It never reads `occurred_at` or an ordinal; the observation whose
event produced the FINAL is not late to itself.

**Nine — the exposure is an input in A, and an event in B** (Q3). The first
`DISPATCH_INTENDED` of an effect is what B folds into revision 1 UNKNOWN. In A that
is simply a trigger with no observations: the fold cannot tell an exposure from any
other trigger, and does not need to.

**Ten — inertness is a law, not a sentence** (H-8). Two fence laws, registered in
`PATH_SCOPED_LAWS` (140 → 142): **L-P32A-1**, no tracked `packages/*/*/src/` file
other than the module and the ledger barrel names `usage-settlement/index.js`,
`foldUsageSettlement`, `measurementStreamIdV1` or `measurementStreamPreimageV1`
after comments are stripped; **L-P32A-2**, the module names no `Date.now(`,
`new Date(`, `process.env`, `Math.random(`, `node:crypto` or `createHash(` and
imports from `../canonical-json/index.js`. B retires L-P32A-1 in the packet that
wires the door and names the retirement.

**Eleven — details the preaudit left open, decided here and declared.**

- The vocabulary adds five words to the preaudit's floor: `OBSERVATION_DUPLICATE`
  (one id twice), `REQUEST_INVALID` (a malformed cut, trigger or previous revision),
  `STREAM_DUPLICATE`, `STREAM_SOURCE_CLASS_INVALID`, and
  `STREAM_LINEAGE_CLASS_MIXED` — two observed epochs of one lineage declaring
  different classes. Rule 3 ranks a lineage by its class; a lineage with two has no
  rank, and choosing one would invent it.
- A request is consistent or refused: the trigger lies in `[1, head]`; the head's
  digest is genesis iff its sequence is 0; a previous revision's sequence precedes
  the trigger; with a FINAL previous revision, `lastFinalSequence` is that revision's
  sequence; otherwise it is null or earlier.
- "Un `is_final = 1` efectivo" is read existentially over a stream's effective
  reports after correction and replacement: a correction that withdraws the flag
  withdraws it.
- A declared stream no observation names is ignored: it has no coverage to elect.
- A correction whose target belongs to another effect is `CORRECTION_CROSS_EFFECT`,
  checked before the generic `OBSERVATION_FOREIGN_EFFECT`.
- Types live inline in the module (H-11). B types its five row interfaces in
  `src/types/index.ts` from these shapes, never restated.

## Why a hex literal for the policy was not chosen

A pinned sixty-four-character constant with no document behind it attests that
someone typed it. The fence's policy pin (L4) already refuses trust-on-first-use for
the same reason. Deriving the digest from a literal document makes a change of rule
a change of pin, visible in review, and lets a reader recompute it.

## Why a fold that throws was not chosen

A thrown error is either an unrecognised class at B's door or a new error class
here, and the ledger's README bijection would grow for a vocabulary only this module
speaks. A closed outcome union is exhaustible by the door, testable without
`try/catch`, and already the package's shape for a pure decision.

## Why epochs of one source were not made alternatives

A restarted counter is the same measurement continuing (economy §1.1: a new epoch
and a new id, never a mutated row). Making epoch 1 compete with epoch 0 would drop
everything spent before the restart, which is exactly the undercount the stream
identity exists to prevent. Two sources reporting the same spend are alternatives;
two stretches of one source are not.

## Why a partial overlap was not made DISPUTED

Adjudication Q2 and DB:702: an ambiguous range is refused. DISPUTED is for two
sources that cannot be compared, where the spend is real and its size is contested;
a partial overlap inside one stream is a report that cannot be placed, and settling
it would require inventing a distribution to subtract.

## Consequences

- B's door calls this fold inside the trigger's transaction, persists the header,
  the vector and the list, and converts a refusal by name; it must retire L-P32A-1
  in the same packet. B's migration must hold the same nullity law with CHECKs, and
  the suite already asserts it as a property of every settlement the fold produced.
- The five counts are `bigint` from the fold outward; any reader that narrows to
  `number` is a place precision can be lost, and must say so.
- A change of precedence, coverage rule or aggregation is a new policy document,
  a new digest and a new fold version beside this one. Revisions recorded under V1
  keep their digest and are rebuilt by V1.
- `STREAM_LINEAGE_CLASS_MIXED` means an adapter that reclassifies a source across a
  restart must use a new `source` name; B's door may want to refuse such a
  declaration earlier, and that is B's decision.
- Per-segment settlements exist as values now; P-33 must use them rather than
  re-deriving an election.

## Not in this record

- The tables, the event types and their payloads, the door, the rebuild and the
  `CONTRACT_VERSION` bump: escalón B (ADR 0089, to be written).
- The recorders that produce normalized observations, and their keys: escalón C.
- Wiring the walk, normalizing classes in real adapters: P-15.
- Prices, `valuation_status`, cost snapshots and subscription allocation: P-33 and
  M11.
- Migrating the quota estimate or the rollups onto settlements: P-19.
