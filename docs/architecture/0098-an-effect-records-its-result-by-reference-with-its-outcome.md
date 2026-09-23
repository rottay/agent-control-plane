# ADR 0098 — An effect records its result by reference, with its outcome, and SUCCEEDED requires it

- Status: accepted (P-07 escalón B, recorded 2026-09-22).
- Supersedes: none.
- Superseded-by: none.
- Amends: none. `L-P07A-1` is amended in its own fence row; execution §6 gains the
  three columns, their CHECKs and the two triggers.

## Context

Contratos §4.2 `:208-219` demands a valid, recoverable result for `SUCCEEDED`, with
replay and conflict decided on the effect's digest. ADR 0097 froze the result
document and held it inert. Datos §11 step 7 orders the two facts: the result
artifact is published **before** the ledger references it.

`effect_read_model` recorded an outcome and nothing about the answer. So a
`SUCCEEDED` could land with no recoverable result, and two outcomes that differed
only in what they produced were indistinguishable.

The P-07 adjudication v2 (C1, C2 and the minor points) fixed the shape after
Fable's preaudit. B's brief measured two facts the adjudication did not have:

- The rebuild writes outcome rows by **INSERT**, so a trigger that is only
  `BEFORE UPDATE OF outcome_status` never fires on a rebuild.
- A column CHECK "version NULL iff status NULL" added by `ADD COLUMN` is tested
  against the existing rows (SQLite ≥ 3.37), so it aborts on any ledger that
  already holds an outcome.

The DT's answers Q-B1 and Q-B2 settle both.

## Decision

**One — the result travels with the outcome, by reference and digest.** A
`DISPATCH_OUTCOME_RECORDED` may carry `payload.outcome.resultArtifactReferenceId`
and `payload.outcome.resultSha256`. They name the registered `RESPONSE` artifact
whose bytes are the result document v1, and that artifact's `content_sha256`,
which is conserved and never recomputed (D10). One event carries the status and
the pair, so the pair is atomic with the outcome (D1).

**Two — migration 22, a cohort by version.** It adds three nullable columns to
`effect_read_model`: `outcome_contract_version`, `result_artifact_reference_id`
and `result_sha256`. Rows already there read `NULL`, so no table is rewritten
and no index moves.

The version-independent row law is CHECKs:

- the pair is both `NULL` or both present;
- the digest has the common SHA shape;
- a result exists only on `SUCCEEDED` or `FAILED` (D6/C2);
- a version implies an outcome.

The cohort is two triggers with one body:

- an outcome implies a version;
- an outcome of the six versions before (`2.2.0` … `2.7.0`, a closed list frozen in
  the text, never a version comparison) names no result;
- a `SUCCEEDED` of every later version names one.

There are two triggers because a rebuild INSERTs a row that already holds its
outcome and the door UPDATEs one. The UPDATE trigger names all four columns, so a
raw write to the result columns alone is held to the same rule (Q-B1). The half
"an outcome implies a version" is in the triggers, not in a CHECK, for the SQLite
reason above (Q-B2, datos §3.7 mechanism 2).

**Three — the backfill is code, through the one reader.** In migration 22's
`afterSql`, every `DISPATCH_OUTCOME_RECORDED` is read again, in sequence order,
through `dispatchOutcomeRecord`. Each outcome's row gets its event's version, first
event wins, on the migration-18 mould. It also gets the pair the event names:

- on a ledger that meets 22 for the first time, the pair is `NULL`;
- on a ledger rewound past 22 after it held later outcomes, the pair is what
  re-applies the rows the events say.

Without the backfill, `verifyIntegrity` fails right after the upgrade on any
ledger that holds outcomes, and the suite shows exactly that. SQL `json_extract`
was rejected because it would be a second reader of the outcome grammar.

**Four — the reader, present-invalid (decision 56).** It checks, in order, and
refuses each at its own path without echoing the value:

1. a present key that is not non-empty text (for the digest, 64 lowercase hex);
2. half a pair;
3. a pair with no outcome;
4. a pair on `CANCELLED` or `OUTCOME_UNKNOWN`, by name;
5. a pair on a version of the cohort before;
6. a `SUCCEEDED` of a later version without one.

`FAILED` is admitted with a pair or without one. The statuses that may carry a
result are the result contract's own `RESULT_STATUSES`, imported into the ledger's
projection and never copied. That makes the projection the one caller `L-P07A-1`
admits outside the concept, for that one name. The migration text cannot import,
so its `('SUCCEEDED', 'FAILED')` is the one forced restatement, and the migrations
suite holds it equal to `RESULT_STATUSES`.

**Five — existence at the door (datos §11 step 7).** Before the comparison, the
door reads `artifact_reference_read_model` for the named reference, on every
arrival, replay included. It refuses, by name:

- a reference the registry does not hold, which includes a publication only
  intended or abandoned, because a reference row exists only after success;
- a class other than `RESPONSE`;
- a scope other than this task;
- a `content_sha256` other than the digest.

The base checks presence, never existence. A cross-stream trigger or foreign key
would make a rebuild depend on the order it folds streams, which is ADR 0084
Four's reason. Retention, tombstone and blob lifecycle are not checked, and are
declared: nothing in this build tombstones a reference or reclaims a blob.

**Six — one comparison (C2, ADR 0084 Five).** `effectOutcomeArrival(stored,
arriving)` answers for the door and the fold alike:

- `write` when the row holds no outcome;
- `replay` when it holds the same status, reference and digest;
- `refused` otherwise, at the first differing key, with the written-once words.

Both inline compares are deleted. A row of the cohort before, holding no pair,
meeting a pair is refused. This departs from ADR 0084 Five's "counts only where
the row holds one", as the adjudication decides. The outcome is already known and
is reused, so nothing is stranded.

**Seven — the bump.** `CONTRACT_VERSION` 2.7.0 → 2.8.0 and
`SUPPORTED_CONTRACT_VERSIONS` six → seven, for ADR 0084 Two's reason: a cohort,
not an identity. The cohort is keyed on the recording version, so the literal had
to move for the cohort to exist. The three envelope-identity vectors move with it
and were computed twice. `LEDGER_CONTRACT_VERSION` moves by alias.
`API_CONTRACT_VERSION` does not move, because no route shape changes.

## Why a ledger copy of the status set was not chosen

Two vocabularies for one concept, held equal only by a test, is not a single
authority. The ledger already depends on `@acp/contracts` and the contract does
not depend on the ledger, so the import runs along the existing edge and adds no
cycle.

## Consequences

- `MIGRATIONS` 21 → 22.
- `EXPECTED_SCHEMA_OBJECTS` +2 triggers, so the `tr_` inventory goes 9 → 11.
- `EffectReadModel` and `DispatchOutcomeRecord` gain their fields. The leaf gains
  `EffectOutcomeArrival`, and the ledger barrel gains no name.
- `PATH_SCOPED_LAWS` stays 147 and `CONTRACTS_SCHEMA_EXPORTS` stays 160.
- The ADR corpus goes 97 → 98, and the decision register 107 → 109.
- Every `SUCCEEDED` a test appends at the version in force names a planted
  `RESPONSE` reference. One runtime drill about the reuse law moved to `FAILED`,
  because the law has no FAILED exception and that harness has no artifact
  fixtures.

## Not in this record

- Publishing the RESPONSE artifact and assembling the document, in that order:
  escalón D, which asserts the order in drills.
- Output bytes to the private sink: escalón C.
- Coupling the effect's result to the task's terminal state, and daemon wiring:
  P-15.
- A producer of `SUCCEEDED` in any `src/`: none exists (ADR 0080 §7).
