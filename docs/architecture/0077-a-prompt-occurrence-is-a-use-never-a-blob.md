# ADR 0077 — A prompt occurrence is a use, never a blob, and a late answer keeps its origin

- Status: accepted (P-18/protocolo D, recorded 2026-09-12).
- Supersedes: none.
- Superseded-by: none.

## Context

Execution §8 specifies two read models: `prompt_occurrence_read_model`, one row
per prompt a delivery sent, and `response_occurrence_read_model`, the one
answer to one such prompt. §8 `:377` says they replace `prompt_record_read_model`,
whose primary key was `prompt_sha256` and so mixed the identity of some bytes
with the fact of sending them. Streams §1.1 `:120-135` fixes that the prompt
occurrence records `dispatchAttemptId`, that its schemas and checks belong to
execution §§3/6/7/8 alone, and that there is no backfill and no second
idempotency namespace for the same facts.

Escalón C (ADR 0076) landed the rungs these hang off: the segment, the effect
and the delivery, with `dispatch_attempt_id` as the delivery's key. What §8 adds
is small in DDL and dense in rules: the prompt's effect and segment must equal
its delivery's (`:416`); an answer keeps its link to the prompt, and a late
answer is not attributed to the destination (`:418-419`); occurrence, row and
watermark commit after the delivery's intention or in the same batch in causal
order (`:419-420`); no occurrence for a call a transport does not make
observable (`:421`); one answer per prompt (`:431`); and never a byte of a
prompt or an answer in any row (`:433`).

Six things were underdetermined, and a writer could not have proceeded without
settling them.

**How many event types.** The adjudication (Q5) fixed the form — every type
P-18 adds is a same-state passthrough — and left the count to each escalón's
brief, which ADR 0076 repeated.

**`prompt_record_read_model`.** §8 replaces it. It exists nowhere in this tree:
there is nothing to migrate and nothing to drop, which is the same situation C
met with `execution_route_segment_read_model`.

**Who assigns `ordinal`.** §8 `:389` says "orden dentro del segmento", with a
CHECK `>= 0` and a non-unique index `(route_segment_id, ordinal)`. It does not
say who assigns it.

**Where `identity`, the model quartet and `redaction_verdict` come from.** §8
gives each a column. It does not say whether `identity` is a payload key,
whether the model fields are copied from the segment, or where the redaction
vocabulary lives — it existed nowhere in the tree.

**What is verified about the digests.** `prompt_sha256`, `context_sha256` and
`response_sha256` are digests of bytes §8 `:433` keeps out of every row.

**Whether the contract version moves.** ADR 0076 moved it to `"2.3.0"` and
wrote down why C carried the bump and B did not.

## Decision

**1. Migration 14, `execution_occurrences`**, creates the two tables of §8 with
the columns, CHECKs and indexes it lists: five schema objects, two watermarks
seeded from the head in migration 13's form, no trigger, and four foreign keys
`DEFERRABLE INITIALLY DEFERRED`. `dispatch_attempt_id` is a foreign key and is
**not** unique; `prompt_sha256` is indexed and is **not** unique;
`prompt_occurrence_id` on the answer is unique. The digests carry no shape
CHECK, because §8 lists none. `DERIVED_TABLES` clears the answer, then the
prompt, before migration 13's cohort.

**2. Two event types, named here**: `PROMPT_OCCURRENCE_RECORDED` and
`RESPONSE_OCCURRENCE_RECORDED`, same-state passthroughs on the `execution`
channel. `CONTROL_PLANE_EVENT_TYPES` 28 → 30 and the channel map's `execution`
partition 10 → 12. Two and not one because §8 leaves no other reading: the
answer has its own primary key (`:406`), its own `recorded_at` and `sequence`
(`:411-412`), and may arrive late (`:418`) — a fact that happens at another
instant cannot ride the event of the prompt it answers.

**3. The payloads are closed.** Each carries the V2 coordinate and one nested
record — `promptOccurrence` or `responseOccurrence` — and nothing else, and each
record admits exactly its declared keys. The answer's record is
`{occurrenceId, promptOccurrenceId, responseSha256, responseBytes,
redactionVerdict}`: the answer's own `occurrenceId` is part of it because §8.2
gives the answer a key of its own, distinct from the prompt's. An answer that
names a delivery, a segment or an account is refused by name. The contract's
transcript guard already refuses the keys a conversation travels under; the
ledger's closed grammar is the line over every name that guard has never heard
of.

**4. One reader serves the door and the fold.** `readPromptOccurrence` and
`readResponseOccurrence` return a row or a named refusal;
`promptOccurrenceLinkRefusal` and `responseOccurrenceLinkRefusal` decide the
links against rows the caller supplies — the base, at the door; the snapshot,
in a rebuild. The door therefore refuses, by name and before any constraint:

- a prompt whose delivery has not been intended, committed or earlier in the
  same `appendBatch` (`:419-420`);
- a prompt whose `effectId` or `routeSegmentId` differs from its delivery's
  (`:416`) — the segment is the delivery's **effective** one;
- a prompt or an answer recorded at another coordinate than the attempt that
  owns the effect (§7 `:343`);
- an answer to a prompt nobody recorded (`:407`), and a second answer to one
  prompt (`:431`);
- every field that breaks its grammar, including the §4 pair and the
  preserved alias and provider (`:391-394`, `:414`), a count that is not a
  non-negative safe integer, a verdict outside the vocabulary, and a digest that
  is not 64 lowercase hex (`:397`, `:409-410`).

A rebuild refuses the same histories with the same words, and the snapshot
holds the answer's unique index in memory to do it, on ADR 0076's precedent.

**5. The ordinal is assigned by the ledger**: one past the segment's highest,
`0` where there is none. The producer proposes and the ledger verifies, as for
`operation_ordinal` and `attempt_ordinal`. §8's index is not unique and that is
not evidence against the rule: §8 asks for the index, not for the claim, and an
ordinal nobody verifies orders nothing. Over the **segment**, as §8 says, so a
handoff restarts it — unlike an effect's operation ordinal, which is over the
attempt.

**6. `identity` is the recording event's `emittedBy`**, never a payload key, so
a payload cannot name another worker as the sender. The model quartet travels
in the prompt's payload rather than being copied from the segment: §8 gives the
prompt columns of its own under §4's contract, and a prompt may resolve a
version its segment could not. `MODEL_RESOLUTION_STATUSES` is reused, and the
new vocabulary `REDACTION_VERDICTS = ["CLEAN", "REDACTED"]` lives in
`@acp/ledger` beside it, on decision 45's reasoning: it is a word this package's
door and migration impose on its own read model, not the grammar of a key.
`CONTRACTS_SCHEMA_EXPORTS` stays at 113. `account_id` is recorded as the
prompt states it and is not compared with the segment's nullable `account_id`:
§8 lists no such rule, and this record does not invent one.

**7. The three digests are conserved, never recomputed.** Their preimages are
exactly the bytes §8 `:433` keeps out, so this ledger has no source to recompute
them from. The door checks their shape as payload grammar and nothing more.
That is `request_sha256`'s class in ADR 0076, and it is declared for the same
reason: a check that only appeared to be one would be worse than saying so.

**8. `CONTRACT_VERSION` stays `"2.3.0"`.** ADR 0076's criterion is that C
carried the bump because its payloads carry digests the fold **verifies** and a
per-payload contract version — history whose reconstruction depends on
preimages that did not exist before. B added facts; C added a way of computing
identity. D adds facts: conserved digests, counts and vocabulary words, with no
identity formula and no new preimage prefix. That is B's class, and B did not
bump. Streams §1.1 `:128` — new payloads carry an explicit contract version — is
satisfied by the event's `contractVersion` under the append door's "only the
version in force" rule, exactly as `TASK_ATTEMPT_OPENED` satisfies it.

**9. §8 `:421` is the producer's guarantee.** No occurrence is created for a
call a transport does not make observable, and nothing in this build produces
occurrences at all; escalón G owes that. What is falsifiable today is that no
fold derives one: a delivery that goes from intention to `SETTLED` with no
prompt leaves both tables empty, and a rebuild agrees.

## Why one event carrying both halves was not chosen

It would have kept the vocabulary at 29 and made the answer a nullable part of
the prompt's event. It fails §8 on its own terms: the answer has its own key,
instant and sequence, and the case §8 names — an answer that arrives after a
handoff — is precisely one where the prompt's event was recorded long before.
A late answer would either need to rewrite a recorded event, which the stream
forbids, or be an event of the prompt's type that is not a prompt.

## Why the ledger does not accept any ordinal `>= 0`

§8's CHECK and non-unique index would admit it, and it would be simpler. But the
ordinal is the only order §8 gives prompts inside a segment, and an ordinal the
producer may choose freely can repeat, skip or run backwards without anything
noticing. Escalón B and escalón C settled the same question for their ordinals
the same way, and a third answer here would be a third rule for one idea.

## Consequences

- `MIGRATIONS` 13 → 14. `DERIVED_TABLES` 13 → 15, `PROJECTION_NAMES` 8 → 10,
  `PROJECTION_SOURCES` 12 → 14, `status().projections` 11 → 13 and its
  watermark rows 12 → 14. `EXPECTED_SCHEMA_OBJECTS` gains five entries and the
  `tr_` inventory stays at eight.
- `CONTROL_PLANE_EVENT_TYPES` 28 → 30 at every pinned site, and `execution`
  10 → 12. `CONTRACT_VERSION`, `SUPPORTED_CONTRACT_VERSIONS`,
  `AdmittedContractVersion`, `API_CONTRACT_VERSION` and
  `CONTRACTS_SCHEMA_EXPORTS` do not move.
- The `cli` and `gateway` rewind fixtures each undo two more tables and three
  more indexes, answers first.
- `@acp/ledger` gains four read verbs — `listPromptOccurrences`,
  `listPromptOccurrencesBySha256`, `getPromptOccurrence`,
  `getResponseOccurrenceForPrompt` — and no error class: every refusal is a
  `LedgerValidationError` with a `path`, so the README's thirteen-class claim
  stands.
- The closed payload grammar is stricter than C's intentions, which admit keys
  beside their records. That asymmetry is deliberate and bounded to these two
  types: they are the two whose content, if it leaked, would be a transcript.
- **Nothing produces any of this.** The tables are correct and empty on every
  ledger in the field until escalón G's producer arrives.
- `account_id` is not cross-checked with the segment. If a later reading of §8
  or of accounts makes that rule necessary, it is a door check with its own
  record, not a migration.

## Not in this record

The outbox and the saga (E, F), the producer in `@acp/runtime` and the packet
index (G), and the population of B1–B3 are each their own escalón. Verifying a
prompt or response digest against a blob is the artifact store's, not this
ledger's. O-Δ1 and O-Δ2 remain registered debt with their own packet.
