# ADR 0065 — Coverage says since when, not whether it was true

- Status: accepted (P-08/B, recorded 2026-09-10).
- Supersedes: none.
- Superseded-by: none.
- Extends: none.

## Context

P-08/A2 gave `account_events` a hash chain. It could not be a column on the
stream — migration 5 is applied and immutable — so the chain lives in a sidecar
beside it, `account_event_integrity`, created and filled by migration 10 in one
transaction. The load is retroactive: at activation the code fixes
`H = COALESCE(MAX(sequence), 0)`, computes links for `1..H`, and records the
triple `(baseline_sequence, baseline_sha256, activated_at)` in `ledger_meta`.

That produced a stream which is chained but whose chain has a *start date*, and
the start date is not the start of the stream. `verifyIntegrity()` could say
whether the chain held. It had no way to say from when it held anything at all.

The gap this leaves is not academic. An operator runs the check, reads
`ok: true`, and concludes that the account action recorded eight months ago was
verified. It was not. What was verified is that its bytes have not moved *since
activation* — which was this morning. Nobody hashed that row when it was
written, and no chain installed afterwards can retrofit the fact. `docs/audit/
architecture/database/streams/index.md` §8.2 states the distinction in one line
and this record exists to put it on the wire: coverage of `1..H` means **bytes
preserved since activation**, not authenticity before it.

The other three streams do not have this problem — they chained as they
appended, so there was never an instant at which they were not covered. But a
report that said nothing about them and spoke only about accounts would make
"covered" look like an account-specific concern rather than a property every
stream has an answer for. Related: ADR 0064, which made a different half-truth
on the same route visible (a path digest that could not tell one file from its
restore).

## Decision

**The report gains a coverage array, beside the problem list and never inside
it.**

`IntegrityResult` gains one required field, `coverage`: exactly four entries,
one per stream, ordered by stream name.

```
coverage: [{ sourceStream, coverageKind, coveredSinceSequence,
             checkedThroughSequence, integrityActivatedAt,
             baselineSequence, baselineSha256 }, ...]
```

Beside and not inside, because a problem is something wrong and coverage is true
of a sound ledger as much as a broken one. Folding coverage into `problems`
would mean an operator only learns how far back the evidence goes on a ledger
where something has already failed, which is the worst moment to learn it.

Exactly four and never a subset, for the reason the interesting answer is
`account_events`: a report free to omit a stream is free to omit exactly that
one.

Four things this record decides, each of which had a live alternative.

**1. The vocabulary belongs to the protocol; the ledger imports the type.**
`COVERAGE_KINDS` and `CoverageKind` are declared in `@acp/protocol` and
`@acp/ledger` imports the type rather than restating the union. This is the G7
D4 pattern, already used for `IntegrityProblemKind` in the same file: the
protocol owns it because the vocabulary is what the integrity route serializes,
and two hand-maintained lists of one meaning is exactly the drift nothing would
notice. `sourceStream` reuses `WatermarkSourceStream` for the same reason.

**2. `NOT_ACTIVATED` stays in the enum although this build cannot emit it from a
ledger it opened cleanly.** A ledger with migration 10 pending cannot be opened
at all — a read-only handle refuses a pending migration and a writable one
applies it, activating as it goes — so "migrated but not activated" is not a
reachable state here. The value is kept for two reasons. It is the honest answer
when the activation is unreadable, which *is* reachable: somebody reached past
the door and deleted or edited `ledger_meta`, and the report then says
`NOT_ACTIVATED` with every nullable field null **beside** a `LEDGER_META`
finding, never instead of one. And another build, or a later cut of this one,
may legitimately open a ledger that has no sidecar.

What the contract refuses is emitting it inside a passing verdict:
`IntegrityResult` rejects any result that is `ok` and reports a `NOT_ACTIVATED`
stream. §8.2's own words are that such a stream "does not satisfy the integrity
gate even though a legacy read may be possible", and a gate that a passing
result could walk through is not a gate.

Equally, a partial or divergent activation is an integrity **error**, never a
quiet `NOT_ACTIVATED`. Degrading it to the word for "never activated" is
precisely how a tampered baseline would pass for an honest absence.

**3. `integrityActivatedAt` is comparable, not volatile.** It looks like an
observation instant and is not: it records when the chain was computed —
written once at activation and never rewritten — rather than when this process
looked. `VOLATILE_FIELDS` stays exactly `["observedAt", "checkedAt"]`, and
`coverage` is bound to `LEDGER` in `PARITY_BINDINGS`. Declaring the instant
volatile would have stripped the one field that makes a baseline auditable while
leaving the three-client comparison green, which is the worst possible
combination.

Nothing in the array is recomputed. The baseline fields are read from
`ledger_meta` verbatim, because a verifier that recomputed them from the current
head would be asserting the very thing the chain exists to prove.

**4. `status()` does not publish coverage; `verifyIntegrity()` does.** Coverage
is the product of examining a cut — it carries `checkedThroughSequence`, which
is only meaningful about a pass that happened. `status()` is a cheap read that
answers what the file says about itself without verifying anything, and putting
a field named for a check into a response that runs no check would invite the
exact conflation the rest of this record is about.

## `API_CONTRACT_VERSION` moves to 0.15.0

Minor, for the mechanical reason every recent move here has been.
`IntegrityResult` is a `z.strictObject`, so a reader pinned at `0.14.0` parsing
a `0.15.0` result **rejects it** on the unknown key. That is a shape a `0.14.0`
reader has never seen, which is this contract's own rule for the minor.

Optional was rejected for the reason it keeps being rejected: it would make "an
older server that does not say" and "a ledger with no coverage" the same wire
shape, and telling those two apart is the entire point of a field whose
vocabulary includes `NOT_ACTIVATED`.

The route surface does not move — `API_ROUTES` and `API_WRITE_ROUTES` are
untouched. Neither does `LEDGER_CONTRACT_VERSION`, and that deserves saying out
loud because this packet's sibling added a migration: migration 10 creates the
account integrity sidecar, which is **ledger schema**, not the shape of a
recorded event. No event type, payload key or history is reinterpreted.

## Consequences

Both doors carry the field, copied entry by entry rather than spread, so the
next thing the ledger's report gains does not reach a strict wire schema by
accident.

The CLI prints a `Coverage` section on **every** run, including a clean one, and
prints `coverageKind` verbatim — `BASELINED_AT_ACTIVATION`, not "Baselined at
activation". It is a closed wire vocabulary a reader greps for; prettifying it
would make the word on the screen and the word in the JSON two different strings
for one fact. The account row carries `baselineSequence` and
`integrityActivatedAt` in the same line, because "covered from sequence 1" with
neither is a claim with nothing behind it.

An empty stream reports `coveredSinceSequence: 1` against
`checkedThroughSequence: 0`. That reads like a contradiction and is not:
covered from the first row it will ever hold, holding none yet. `null` there
would say "covers nothing", which is the vocabulary for a stream with no chain
at all.

## What this does not close

**The console does not render `coverage`.** The field crosses the wire and both
the API and the CLI publish it; the browser UI has not been touched and shows
the verdict and the problem list as it did before. An operator reading the
console today still cannot see from when the account chain is evidence. That is
a UI packet, not this one.

**`account_events` still has no projection watermark** (D3). The stream now has
a chain, which was the reason D3 used to give; what it still lacks is a
projection reading it, and nothing here creates one. The reconciled comment in
`PROJECTION_SOURCES` names the destination.

**Nothing proves authenticity before activation, and nothing here ever will.**
A chain installed after the fact can only say that bytes have not moved since it
was installed. Establishing what those rows said before that instant requires
evidence from outside the file, and no field of this report claims otherwise.

## Not in this record

How the sidecar is built, what the preimage encodes, and why the chain lives
beside the stream rather than in it — those are P-08/A1 and P-08/A2, and
`packages/persistence/ledger/README.md` carries them. This record is about what
crosses the wire and what a reader is entitled to conclude from it.
