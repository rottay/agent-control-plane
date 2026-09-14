# ADR 0089 — Usage is a declared stream and a measured observation, and the door settles them in the same transaction

- Status: accepted (P-32/captura escalón B, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0088 §Ten — L-P32A-1 is retired here, as that record said it would be.
  Economy §1–2 (`docs/audit/architecture/database/economy/index.md`) is read, not
  edited.

## Context

Escalón A (ADR 0088) landed the settlement fold and the stream identity as pure,
inert functions. Economy §1.2 `:81` writes a stream, an observation and the
settlement with the append and the head in one transaction, and §2.3 `:164` writes a
revision's header, vector and list in the transaction of its trigger. So the tables,
the event types, the door, the rebuild and the migration cannot land apart, and they
land here.

The DT's adjudication of the map fixed the shape (Q1–Q5): two event types, a
declaration and an observation; an ambiguous range refused at the door; the first
`DISPATCH_INTENDED` of an effect as its exposure; the policy pinned in `@acp/ledger`;
no live producer. The writer's first brief named the work. The Fable preaudit
(ACCEPT_WITH_CORRECTIONS, H-1..H-12) found what it left open — a migration that did
not fold the exposures a ledger already holds (H-1), the retirement of L-P32A-1
(H-2), the snapshot, rebuild and integrity comparison (H-3), the trigger's own digest
as the cut (H-4), what "first" means (H-5), the channel (H-6), a non-final report
after a final one (H-7), and what the bump is paid by (H-8) — and the DT adopted all
of it, adjudicating H-5, H-6, H-7 and H-11.

## Decision

**One — two event types, named here** (Q1). `USAGE_STREAM_DECLARED` and
`USAGE_OBSERVATION_RECORDED`, appended last to `CONTROL_PLANE_EVENT_TYPES` (33 → 35).
Both are same-state passthroughs, and the door refuses one that moves a state — no
earlier type of the vocabulary had the door impose that, and a usage record that
moved a task would be a lifecycle fact wearing a spend's name. Neither is, nor extends,
`TOKEN_USAGE_RECORDED`, which is untouched.

**Two — both on `progress`** (H-6, adjudicated). `progress` is "usage attribution,
which moves no state". D kept its prompt and response occurrences on `execution`
because their byte counts are part of what an occurrence *is*; an observation's counts
are the other case — spend, attributed through its stream to an account and a segment.
The declaration names where that attribution goes and sits beside it. The partition
moves `progress` 2 → 4; `execution` stays 15.

**Three — closed payloads, on P-18/D's shape.** The V2 coordinate and one record, and
nothing beside them. `usageStream` carries exactly `measurementStreamId`, `source`,
`accountId`, `routeSegmentId`, `sourceEpoch`, `sourceClass` and
`normalizationPolicySha256` (`USAGE_STREAM_RECORD_KEYS`). `usageObservation` carries
exactly `observationId`, `measurementStreamId`, `ordinal`, `sourceObservationId`,
`reportKind`, `rangeFromCounter`, `rangeToCounter`, `correctsObservationId`,
`effectId`, `isFinal`, the four classes, `totalTokens` and `occurredAt`
(`USAGE_OBSERVATION_RECORD_KEYS`); the two range bounds and the corrected id may be
absent or `null` as the report kind decides. No source class on an observation: it is
the stream's (ADR 0088 §Four). No `recordedAt` and no `sequence`: they are the
event's.

**Four — what one event can be wrong about is the reader's.** `readUsageStreamDeclaration`
recomputes `measurementStreamIdV1` from the four coordinate fields and refuses by name
when the payload's id is not that digest (`STREAM_COORDINATE_INVALID`); a registered
class and a lowercase policy digest are required. `readUsageObservation` holds
`ck_usage_observation__report_shape` by name, the four classes and their total to a
safe integer `>= 0`, the total to their `BigInt` sum (`TOTAL_MISMATCH`), `isFinal` to
0 or 1, `occurredAt` to the instant form, and refuses a correction of itself
(`CORRECTION_CYCLE`).

**Five — what needs the base is the link's, in this order.** For a declaration: the
segment exists (H-11, adjudicated); the event is recorded at the attempt that owns it;
an id already declared with another class or policy is refused, and the same stream
restated writes nothing and keeps the `sequence` of the event that first declared it.
For an observation: the stream is declared (`STREAM_UNKNOWN`); the effect exists —
by name, never as an abort of the foreign key (N-P32-15); the event is recorded at the
attempt that owns the effect (N-P32B-20); the stream's segment is of that same
attempt; the effect is exposed (Six); the same observation restated writes nothing, the
same id with other bytes is a conflict, another id at a held ordinal or source report
id is `ORDINAL_DUPLICATE` or `SOURCE_REPORT_DUPLICATE`; a correction names a recorded
report of its own stream and effect (`CORRECTION_TARGET_UNKNOWN`,
`CORRECTION_CROSS_STREAM`, `CORRECTION_CROSS_EFFECT`). The door runs these before the
row is written, in `#assertExecutionOccurrence`'s place; `applyEventToSnapshot` runs
the same functions, so a rebuild refuses the same history in the same words.

**Six — the exposure is the effect's first revision, and "first" means "has none"**
(Q3, H-5, adjudicated). A `DISPATCH_INTENDED` of an effect with no settlement revision
folds revision 1: `UNKNOWN`, five NULL counts, an empty list, `last_observation_id`
NULL, `computed_at` and `sequence` the delivery's. One of an effect that already has a
revision writes nothing — never decided by `attemptOrdinal`, so a second delivery after
an abandoned first writes no second exposure. An observation of an effect with no
delivery is refused by name: before it there is no spend to measure, and revision 1 is
always the exposure. That "has a revision" and "has been delivered" are the same fact
is held by construction: migration 20 writes the exposure of every effect already
delivered.

**Seven — one capture function, and the settlement at the trigger's own head** (H-3,
H-4). `nextUsageCapture(view, event, sequence, sha256)` decides what one event writes
to the five tables, over a `UsageCaptureView` the door and the migration answer from
the tables and the rebuild answers from the snapshot — `ArtifactFoldView`'s allocation.
An observation is folded with every report of its effect through escalón A's fold,
with `cut.controlHead = { sequence, sha256 }` of the trigger itself and
`trigger.sequence` the same sequence, so a rebuild at a later head reconsiders nothing
the trigger did not see. `#projectEvent` and `applyEventToSnapshot` receive the
event's chain digest to make that possible: the door the one it is about to write, the
replay the one the row holds. The fold's own refusals — `COVERAGE_OVERLAP`,
`CORRECTIONS_FORKED`, `TOKENS_OVERFLOW` and the rest of `USAGE_SETTLEMENT_REFUSALS` —
are raised as `LedgerValidationError` naming the arriving record's field while
`#projectEvent` folds, inside the append's transaction, so the event, its row and its
head roll back with them.

**Eight — a non-final report after a final one is admitted** (H-7, adjudicated). It is
economy's late arrival: a new revision, `had_late_arrival = 1` when it arrives after a
FINAL revision's trigger, and — by ADR 0088's existential reading of `is_final` — still
FINAL if the stream stays gapless. Only a correction withdraws a final.

**Nine — migration 20, literally.** Economy's five tables, STRICT, with every CHECK,
UNIQUE and INDEX the dictionary writes under the names it gives:
`ux_usage_measurement_stream__identity`, `ux_usage_observation__stream_ordinal`,
`ux_usage_observation__source_report`, `ix_usage_observation__effect`,
`ix_usage_observation__corrects`, `ix_usage_settlement__latest`,
`ck_usage_observation__report_shape` and the five nullity checks of §2.1. Constraint
names without a dictionary name follow §3.2 on the dictionary's own abbreviated table
prefix (`ck_usage_observation__…`, `pk_usage_settlement`). Every foreign key the
dictionary names is present and `DEFERRABLE INITIALLY DEFERRED`, for migration 13's
reason: a batch may deliver an effect and record its first report, and a header names
the observation its own event records. Every one carries `ON DELETE RESTRICT` (datos
§8.1) except the observation's self-reference, which carries none: SQLite fires
RESTRICT at once even on a deferred key, and a probe confirmed that clearing a table
whose rows correct one another in one `DELETE` aborts under RESTRICT and commits
without it. `DERIVED_TABLES` clears the cohort children-first, before D's pair and C's
cohort. Every digest column carries datos §3.4's shape CHECK, as migration 13's did. No
CHECK that a total equals its classes' sum: the dictionary states that rule as the
door's, and the door holds it with `BigInt`. No trigger. Five watermarks, seeded from
`ledger_meta` at the task head.

**Ten — the migration folds what the ledger already holds** (H-1). As 20 lands,
`afterSql` folds every `DISPATCH_INTENDED`, `USAGE_STREAM_DECLARED` and
`USAGE_OBSERVATION_RECORDED` of the task stream, in sequence order and at each row's
own digest, through `nextUsageCapture` over the base and the door's own writer, inside
the migration's transaction (`foldTaskSubmissionsAtMigration`'s precedent). A ledger
that delivered an effect before the upgrade verifies and rebuilds to the same rows;
one rewound past 20 over usage it already holds folds back into them.

**Eleven — the comparison is textual** (H-3). `verifyIntegrity` reads the five tables
with `safeIntegers` and compares them with a replay as exact sets both ways, every
integer on both sides as its decimal digits (`usageRowText`):
`canonicalJsonStringify` refuses a `bigint`, and a count compared through `number`
could agree with a row it does not equal.

**Twelve — the bump, and what pays it** (H-8). `CONTRACT_VERSION` `2.5.0` → `2.6.0`;
`SUPPORTED_CONTRACT_VERSIONS` gains it, five members; the append door and
`AdmittedContractVersion` pin the version in force. ADR 0076's criterion, read for B:
the door recomputes `measurement_stream_id` from a versioned preimage rather than
believing it, and every declaration carries `normalization_policy_sha256`, the
adapter's own version. That is C's class and F's. `envelope_sha256` is not part of
either payload and pays nothing here. The envelope identity's three vectors move with
the version for ADR 0078's consequence V3, computed twice; the telemetry fixture stays
at `2.2.0`.

**Thirteen — L-P32A-1 is retired, and L-P32B-1 takes its row** (H-2). No tracked
`packages/*/*/src/` file other than the settlement module, the ledger barrel,
`ledger/index.ts` and `projection/index.ts` names `usage-settlement/index.js`,
`foldUsageSettlement`, `measurementStreamIdV1` or `measurementStreamPreimageV1`.
`PATH_SCOPED_LAWS` stays 142: one law out, one in. L-P32A-2 stays.

## Why the fold's refusals are raised while projecting, and not before the row

The fold needs the arriving observation beside every one already recorded, and the
revision it produces is written in the same statement sequence that writes the row.
Folding once before the insert and again while projecting would fold every report
twice; folding before the insert and carrying the result across would give
`#projectEvent` a second input the rebuild does not have. The refusal is raised inside
the append's transaction either way, and nothing of the event commits.

## Why the stream's attempt and the effect's attempt are held equal

Neither is written in economy. A stream attributes spend to one segment, and a segment
belongs to one attempt; an observation belongs to one effect, and an effect belongs to
one attempt. Without both anchors a declaration could be recorded under another task's
coordinate, and a report of one attempt's effect could be attributed to a segment of
another attempt — the same looseness P-18/C and D refuse for a delivery and a prompt.
Neither anchor constrains a lawful producer.

## Why a lineage's mixed class is not refused at the declaration

ADR 0088's `STREAM_LINEAGE_CLASS_MIXED` is refused by the fold when two observed epochs
of one lineage carry different classes. The door could refuse the second declaration
earlier. It does not: a declaration is not yet a measurement of any effect, and the
refusal belongs where a rank is needed. A later escalón may move it forward.

## Consequences

- A usage report lands with its settlement or not at all; a delivery exposes its
  effect; the highest revision is in force and no earlier revision is ever rewritten.
- Every effect a ledger delivered before migration 20 has revision 1 `UNKNOWN` at its
  first delivery, and nothing counts spend that no report stated.
- `#projectEvent` and `applyEventToSnapshot` take the event's chain digest as a fourth
  argument; every caller passes it.
- A reader of the settlement's five counts reads `bigint`; narrowing to `number` is a
  place precision can be lost, and must say so.
- New work stamped `2.5.0` is refused by the append door naming both versions; a
  replay of a row recorded under it is admitted.

## Not in this record

- The recorders that produce streams and observations, and their keys: escalón C.
- A read verb or an API route for a settlement.
- Wiring the walk and normalizing classes in real adapters: P-15.
- Prices, valuation, cost snapshots: P-33. Moving quota or the rollups onto
  settlements: P-19.
