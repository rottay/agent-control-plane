# ADR 0122 — A verification is recorded by its receipt, and a verdict by its tree

- Status: accepted (P-16, cut B, recorded 2026-09-26).
- Supersedes: none.
- Superseded-by: none.

## Context

P-16/0 (`505562f`, decisions 225–227) put execution §10.2–§10.5 under contract before
any code. P-16/A2 (`5fc9588`, ADR 0121, decisions 228–230) named a receipt by its
content: `receiptSha256` over thirteen members in ledger `receipt-identity`, and the
writer's instance id `writerWorkerIdFor(taskId, flat attempt)`. A2 left four things to
this cut by name. It did not land the §10.2 and §10.3 tables. It did not refuse
`RECEIPT_DIGEST_MISMATCH` at the door. It did not prove the coordinate → flat-attempt
bijection (decision 229 declared it as a limit). And it did not decide the bump
(ADR 0121 §Seven: "P-16/B decides that bump").

`VERIFICATION_COMPLETED` and `AUDIT_COMPLETED` already exist. The daemon's walk emits
both as **beats**: `{submissionDigest, [revisionNumber, attemptNumber], beat,
planIndex}`. Observation's fixtures also carry a top-level `verdict`. At HEAD the door
admitted any payload for either type, and no production writer emitted a receipt.

The brief (`p16-b/brief-v1`, measured at `5fc9588`) was pre-reviewed by the DT
(`ACCEPT_WITH_CORRECTIONS`, five blocking corrections B-1 to B-5). Its ND-1 to ND-17
were adopted as rulings, and the DT closed the payload grammar. One stop ruling
followed (the reference key's name, Four). Kimi and Fable are not used (owner,
2026-09-26). Independent Claude verifiers check the result.

## Decision

### One — two tables, migration 28 (decision 231; ND-9, ND-10, ND-12, B-4)

Migration 28, `verification_audit` (`VERIFICATION_AUDIT_MIGRATION = 28`), creates
`verification_read_model` and `audit_verdict_read_model` exactly as execution §10.2,
§10.3 and the §10 common block write them:

- Both tables are `STRICT`, with no defaults, and every column is `NOT NULL`.
- Every CHECK is named. Each word list is spelled `IS NOT NULL AND … IN (…)`.
- `recorded_at` carries §10.1's GLOB, a storage guard under the door's predicate.
- Each table has a deferred foreign key to `task_attempt_read_model`. The verdict also
  has a deferred key to its receipt. Both have an immediate key to
  `control_plane_events(sequence)`.
- Each table has `ix_<table>__attempt`.
- Each table has an insert-only trigger (ND-9): `tr_verification_read_model__insert_only`
  and `tr_audit_verdict_read_model__insert_only` abort every update.
- There is no `object_format` column and there are no `subject_*` columns.

**B-4.** The receipt's `verifier.runId` is `z.number().int().min(1)`, and the canon had
typed `verifier_run_id` and `auditor_run_id` as `TEXT`. Both columns are now
`INTEGER NOT NULL` with `ck_verification_read_model__verifier_run_id_positive` and
`ck_audit_verdict_read_model__auditor_run_id_positive` (`>= 1`). The execution cells
are amended so the spec does not contradict the code.

Two watermarks are born at the task head. They use migration 20's task-stream keys
with migrations 25–27's instant: the head event's `recorded_at`, and the epoch only
for an empty stream. **Nothing is backfilled** (ND-10), because no history before 28
holds either form. That is a stated limit. A history written before 28 that holds a
receipt-form payload is reported by `verifyIntegrity()` as a table divergence, and the
rebuild folds it. One the fold refuses is refused by name.

The DT ruling's shorthand for ND-10 was "refused or reported on rebuild or verify".
The code does something narrower, and this record states that (verification v1,
N-1):

- The fold judges the record and never the blob (Three).
- So a pre-28 receipt-form event whose bytes the door would have refused is not
  refused. For example, its carried name might not recompute, or its reference might
  not exist.
- Before the rebuild, `verifyIntegrity()` reports only the table divergence, and no
  refusal word appears.
- `rebuildReadModel()` then folds the event into a row whose receipt bytes the door
  never checked. After that, verify is clean.

**A row is byte-verified only when its event was admitted at migration 28 or
later.** The same holds for any history planted past the door, as it does for every
projection. No claim here is false, because no producer of either key existed before 28.
P-17/A reads the rows on those terms (Not in this record). `test/verification-record`
N10 pins the behaviour.

`DERIVED_TABLES` clears `audit_verdict_read_model`, then `verification_read_model`,
both before `task_attempt_read_model`. `ON DELETE RESTRICT` fires at once even on a
deferred key, so the order is load-bearing. `PROJECTION_NAMES` 16 → 18,
`PROJECTION_SOURCES` 32 → 34 (both `TASK_STREAM`), `DERIVED_TABLES` 35 → 37,
`EXPECTED_SCHEMA_OBJECTS` 132 → 138 (`tr_` 17 → 19).

### Two — two forms of one type (decision 231; ND-2)

An event is in **receipt form** when its type is `VERIFICATION_COMPLETED` and its
payload holds the key `verification`. It is in **verdict form** when its type is
`AUDIT_COMPLETED` and its payload holds `auditVerdict`. The key is never `verdict`,
because beat payloads already use that. Any other event of those types is a beat: it
is admitted byte-unchanged and projects nothing. Both forms are closed at every level.

A form is its type and its key together (verification v2, NB-1). An
`AUDIT_COMPLETED` whose payload carries a full `verification` record, or a
`VERIFICATION_COMPLETED` whose payload carries `auditVerdict`, is a beat of its type:
admitted byte-unchanged, no byte read, no row, even when the record would be granted
under its own type. A reader of authorization (P-17/A) reads the two tables and never a
payload key. Refusing a form key under the wrong type is left to P-16/D1, which retires
the beat form (Not in this record). `test/verification-record` P6 pins it.

The two forms:

    { revisionNumber, attemptNumber, verification: { receiptSha256, artifactReferenceId,
      baseSha, treeSha, policySha256, writeSetSha256, checksSha256, runStatus,
      allChecksZero, writer: { identity, workerId },
      verifier: { identity, workerId, runId } } }

    { revisionNumber, attemptNumber, auditVerdict: { receiptSha256, treeSha,
      writerWorkerId, auditor: { identity, workerId, runId }, verdict,
      evidenceSha256, artifactReferenceId } }

A missing, extra or mistyped member at either level is `RECEIPT_RECORD_INVALID` or
`AUDIT_RECORD_INVALID` at its path. A carried member is held to the grammar of the
receipt member it copies: the contract's own field schemas, reached through
`VerificationReceipt.shape`. `PASS` with `allChecksZero: false` is the one forbidden
cell. The task, the revision, the attempt, `recorded_at` and `sequence` come from the
envelope and the append. `audit_id` is the event's own `eventId` (ND-6), unique by the
stream's `event_id` index.

The keys and readers are the ledger's own (ND-3). No contracts schema moves, and the
three verdicts are a module-private list: the ledger may not import observation.

### Three — one decision, two callers, and the bytes are the door's alone (decisions 231–232; ND-4, ND-5, ND-17, B-3, B-5)

`decideVerificationRecord` in ledger `verification-record` is pure over the event and
what its caller answers about the history. The task door calls it inside its
transaction, over the tables that transaction keeps level. The fold calls it over the
snapshot. Both throw `LedgerVerificationRefusedError` with the same word (decision 56).
In order, it checks:

1. the grammar;
2. the instant (B-3), since `ControlPlaneEvent.recordedAt` admits an offset and §10.2
   never does, so a non-canonical instant is `RECORDED_AT_NOT_CANONICAL` before any
   write, by contracts' `isCanonicalInstant`;
3. that the coordinate names an opened attempt (`RECEIPT_ATTEMPT_UNOPENED`) and that the
   event's flat `attempt` is that row's `legacy_attempt_number`;
4. the writer's id, as `writerWorkerIdFor(taskId, legacy_attempt_number)`
   (`WRITER_ID_MISMATCH`), never the per-revision number (**the bijection**, ND-17: the
   fold recomputes it too);
5. for a receipt, the verifier's independence from the writer by label and by instance
   (`VERIFIER_NOT_INDEPENDENT`);
6. for a verdict, its receipt row: known (`AUDIT_RECEIPT_UNKNOWN`), of the same task,
   revision and attempt (`RECEIPT_COORDINATE_MISMATCH`), `PASS`
   (`AUDIT_RECEIPT_NOT_PASS`), the same tree (`AUDIT_TREE_MISMATCH`) and the same
   writer (`AUDIT_WRITER_MISMATCH`); then the auditor's independence from that row's
   writer by label and by instance (`AUDITOR_NOT_INDEPENDENT`), judged after the row
   because it compares against the row's writer (verification v2, NB-2);
7. the key already held: the same metadata (every column but `sequence` and
   `recorded_at`, byte-equal) keeps the first row, its `sequence` and its
   `recorded_at`; other metadata is `RECEIPT_METADATA_CONFLICT`.

**The bytes.** Before its lock, `append` and `appendBatch` read the receipt or the
evidence the record names with `readByReference`, scoped `TASK` and the event's task.
The answer is held as a value: the bytes, or the reader's refusal. Inside the
transaction the replay and event-id checks run first, so an exact replay returns its
first record even when the bytes have since become unreadable (B-5). Then comes the
decision. Then `assertVerificationArtifact` judges the value:

- For a receipt, the registry row is re-asserted as a `RECEIPT` scoped to the task
  that pins the bytes read (`RECEIPT_REFERENCE_INVALID`). The bytes are parsed
  (`RECEIPT_UNREADABLE`). The receipt's name is **recomputed** from them with
  `receiptVerificationColumns`, one parse in `receipt-identity`, which returns
  `receiptSha256`'s digest byte for byte, and a difference is
  `RECEIPT_DIGEST_MISMATCH`. The receipt's coordinate must be the event's, and every
  carried column must be the one derived from it (`RECEIPT_FIELD_MISMATCH` at its
  path). The artifact's `content_sha256` and `receipt_sha256` are different digests and
  are never compared.
- For a verdict (ND-5), the registry row is an `EVIDENCE` scoped to the task whose
  `content_sha256` is the carried `evidenceSha256` and pins the bytes read
  (`EVIDENCE_REFERENCE_INVALID`). The bytes must be a JSON object whose string member
  `receiptSha256` is the verdict's (`EVIDENCE_RECEIPT_MISMATCH`). The rest of the
  evidence grammar is P-16/D1's.

**The window between the read and the lock (verification v1, N-3).** Inside the
transaction, the door re-asserts the reference's class, its scope and its
`content_sha256` against the registry row. It does not re-check a tombstone or an
expiry that lands between the pre-lock read and the lock. The bytes it judges were
already checked against the pinned digest, so the recorded content is genuine. Still,
the reference may have lapsed by the moment of the write. Today no admission rule
depends on a reference staying live, so this is a stated limit. If an expiry or a
tombstone ever gates admission, P-16/C or P-16/D1 owns the re-check under the lock.

Every refusal writes nothing and leaves the head unmoved. The fold and
`verifyIntegrity()` copy what the door admitted and never reopen a blob (§10.1). The
rebuild throws a refusal. `verifyIntegrity()` reports it at its sequence and compares
both tables row by row, so a re-pointed verdict or a flipped status is caught even when
the counts agree.

### Four — the reference is `artifactReferenceId` (decision 231; DT stop ruling 1)

The record names its reference `artifactReferenceId`, the ledger's standing name for a
registry reference id (the artifact plane, `envelopeArtifactReferenceId`,
`stepManifestArtifactReferenceId`). `artifactRefId` is the content-block vocabulary
(contracts §4.1, ADR 0093), which L-P06C-1 contains to four block readers. In this
record it is an unknown key. The column keeps the canon's name, `artifact_ref_id`, and
the row mapper translates. L-P06C-1 is not amended.

### Five — the words and the class (decision 231; ND-8)

One class, `LedgerVerificationRefusedError(reason, at)`, code
`LEDGER_VERIFICATION_REFUSED`, carries the field that failed and never a value. The
vocabulary `VERIFICATION_REFUSALS` is frozen here as written, sorted and repeat-free,
nineteen words:

`AUDITOR_NOT_INDEPENDENT`, `AUDIT_RECEIPT_NOT_PASS`, `AUDIT_RECEIPT_UNKNOWN`,
`AUDIT_RECORD_INVALID`, `AUDIT_TREE_MISMATCH`, `AUDIT_WRITER_MISMATCH`,
`EVIDENCE_RECEIPT_MISMATCH`, `EVIDENCE_REFERENCE_INVALID`,
`RECEIPT_ATTEMPT_UNOPENED`, `RECEIPT_COORDINATE_MISMATCH`,
`RECEIPT_DIGEST_MISMATCH`, `RECEIPT_FIELD_MISMATCH`, `RECEIPT_METADATA_CONFLICT`,
`RECEIPT_RECORD_INVALID`, `RECEIPT_REFERENCE_INVALID`, `RECEIPT_UNREADABLE`,
`RECORDED_AT_NOT_CANONICAL`, `VERIFIER_NOT_INDEPENDENT`, `WRITER_ID_MISMATCH`.

Two readers join `Ledger` (ND-13): `getVerification(receiptSha256)` and
`listAuditVerdicts(receiptSha256)`. They are read-only, P-17/A's inputs, and no route
or verb exposes them, so `API_CONTRACT_VERSION` stays 0.25.0. No lifecycle rule and no
`transitionId` rule is added (ND-14). Two receipts of one attempt are lawful, and each
verdict binds to its own.

### Six — no bump, with a condition (decision 232; ND-1)

`CONTRACT_VERSION` stays `2.11.0`. ADR 0076 reserves a bump for a digest the fold
verifies, or an identity a reader of recorded history must reconstruct. No such
reader recomputes `receipt_sha256`: the fold and `verifyIntegrity()` copy it. The
preimage carries its own version in `acp/receipt-identity/v1`. The beat form stays
byte-identical, and the forms are told apart by a key, not by a version, so no existing
shape gains a cohort. A bump would re-trigger the stored-envelope class
(`ENVELOPE_VERSION_SUPERSEDED` for every 2.11.0 task) for no reader.

**The condition.** Under ND-17 the fold does recompute `writerWorkerIdFor` over
recorded events. From migration 28 on, the v5 rule (the contracts namespace and the
name `taskId + "/" + attempt`) and either form's key grammar are readings of recorded
history. Any later change to them owes a `CONTRACT_VERSION` bump with a cohort
(ADR 0076).

**Stated limit (adopted from the brief).** A receipt artifact is stamped
`AdmittedContractVersion`. After a later bump, a recorded receipt's bytes no longer
parse as `VerificationReceipt`. The door read them once, at insertion. P-17/A owns
that class if it re-reads bytes.

### Seven — the verifier's and the auditor's ids (decision 232; ND-7)

The canon says `verifier_worker_id`, `verifier_run_id` and the auditor's pair come from
the runner's spawn record, which does not exist until P-16/C. Until then B checks their
shape (lowercase v5, integer ≥ 1) and their independence from the writer, by label and
by instance, in the CHECK and at the door. It records the ids the receipt or the verdict
declares. The execution cells say so, and the spawn-record check lands with P-16/C.

### Eight — the fence (decision 233; ND-16, B-1, B-2)

- **L-P16B-1**, "a verification row and a verdict row have one door, and neither is
  rewritten", uses L-P27C-1's mould for two tables. Every write naming either table in
  `packages/*/*/src` is the one `INSERT` inside `#insertVerification` or
  `#insertAuditVerdict`, with no conflict clause, and none is an `UPDATE` or a
  `DELETE FROM` by name. `this.#assertVerificationGranted(` is called once, in
  `#appendOneInTransaction`, before its `INSERT INTO control_plane_events`.
- **L-P16B-2**, "the door recomputes the receipt's name, and the words live in one
  home". `verification-record` imports `receiptVerificationColumns` from
  `../receipt-identity/index.js` and calls it in `assertVerificationArtifact`, whose body
  refuses a differing name as `RECEIPT_DIGEST_MISMATCH`. `VERIFICATION_REFUSALS` is
  declared there only, sorted and repeat-free. `export function
  decideVerificationRecord(` is declared once in `src`, there.
- **L-P15F-1 (ii), amended in its own row (B-1).** `REFERENCE_READ_CALLERS` admits
  `ledger/src/verification-record/index.ts` as a fourth caller of `readByReference(`, on
  P-26 cut B's terms: a re-derivation and not a sink. The bytes reach the door's
  comparison and nothing else, not an event, a response, a log or an error message.
- **L-P15I-1, amended in its own row (B-2).** Its grammar matcher reads the SQL template
  literal of migration 28, and §10.1's GLOB holds three digit classes before `Z`. One
  named, counted exception is added. In `ledger/src/migrations/index.ts` alone, the
  exact §10.1 GLOB literal is admitted exactly twice, one per table, and blanked
  before the file is scanned as before. The GLOB is never respelled to dodge the
  matcher. It is a storage guard, not a second predicate.
- `PATH_SCOPED_LAWS` 177 → **179**. The two amendments add no row. Both new laws are
  text matchers with L-P27C-1's stated limits. The semantic guards are migration 28's
  triggers and CHECKs and the door drills.
- One of those limits is a literal written with escapes. For example, a TypeScript
  string that spells the table name with escaped quotes (`UPDATE
  \"verification_read_model\"`) is not seen by L-P16B-1. The verifier's bite V-E3
  stayed green, as the law declares (verification v1, N-2). At runtime the
  insert-only triggers still abort any `UPDATE`, whatever the spelling, and
  `verifyIntegrity()` reports a `DELETE`, which the rebuild then restores.
  `test/verification-record` N11 drives both.
- Bites, each on a disposable copy, are recorded in decision 233.

### Nine — the restamp class (decision 233)

Every pin is recomputed, never lifted:

- `MIGRATIONS` 27 → 28;
- the last applied version `27` → `28` in five entrypoint suites;
- `TASK_STEP_LINK_MIGRATION` → `VERIFICATION_AUDIT_MIGRATION` as the tail;
- `status().projections` 31 → 33;
- watermark rows 32 → 34, and the task-stream zero and level vectors 16 → 18;
- `rewindTo23` and the two inline rewinds, the P-P18-2 rewinds and the integrity rewinds
  in the ledger, migrations, cli and gateway suites, which undo migration 28 first.

## Why the alternatives were not chosen

- **A bump to 2.12.0 (ND-1 (b)).** It is owed only if the fold or verify recomputed a
  receipt's name from bytes. Neither does.
- **Requiring the receipt form for every V2 `VERIFICATION_COMPLETED` (ND-2 (b)).** That
  breaks the daemon's registered walk until P-16/C and D1 produce receipts.
- **Contracts schemas for the forms (ND-3 (b)).** Five more paths and
  `CONTRACTS_SCHEMA_EXPORTS` +2..3 for a grammar only the ledger reads.
- **Re-reading bytes in `verifyIntegrity()` (ND-4 (b)).** It turns a copy into a
  recomputation and pushes ND-1 to a bump.
- **A producer-supplied or derived `audit_id` (ND-6 (b), (c)).** A new uniqueness
  check, or a new preimage, for what the stream's `event_id` already guarantees.
- **Widening L-P06C-1 to the ledger (stop ruling, option (b)).** It widens a
  content-block containment law for files that never read a block.
- **Respelling the GLOB.** That writes the SQL for the fence. The counted exception
  names the one literal and bites on a third copy or a changed character.

## Consequences

- A receipt-form or verdict-form event is admitted only with its receipt or evidence
  readable by reference under its task. A producer publishes the bytes first.
- The door holds one more read before its lock per such event. A beat costs nothing.
- `rebuildReadModel()` refuses by name a history the fold would refuse, and
  `verifyIntegrity()` reports it. Both tables are compared row by row. The fold never
  reads bytes. So a history planted past the door, or written before 28, whose record
  passes the decision is folded even when its bytes would have been refused (One).
- The execution cells for `verifier_run_id`, `auditor_run_id`, `writer_worker_id`,
  `audit_id`, both `artifact_ref_id`, §10.2's "Validación de referencia" and the
  auditor's id are amended, and the §10 intro and common block say §10.2–§10.3 exist
  in code.

## Not in this record

- The runner that produces `PASS` and `FAIL` receipts and emits receipt-form
  `VERIFICATION_COMPLETED`. The verifier and auditor v5 over `(task, attempt, role,
  spawn ordinal)`, `runId` minting, and the check against the spawn record (§10.2
  "Validación de referencia", Seven). The tree hasher and its `write-tree` oracle,
  `policy_sha256`'s object, the `writerIdIssuer` producer, and
  `OBJECT_FORMAT_UNSUPPORTED` (P-16/C).
- `AuditorPort` and the consumer beats that replace the walk's beat form, so a
  registered task records a real receipt; the evidence grammar beyond its receipt
  binding; N03; D-S1-2 (P-16/D1–D2). **Two named limits, owner P-16/D1:** beats still
  stand against contracts §12 ("efectos con receipt propio, no eventos PLAIN"); and
  observation's baseline reads a top-level `verdict` (`observation/src/baseline`), so a
  verdict-form audit counts as `acceptance.unreported` until D1 introduces the producer.
  When D1 retires the beat form, it decides whether a form key under the wrong type
  (Two) is refused instead of admitted as a beat.
- `commit_authorization_read_model` (§10.5), `commit_read_model` (§10.4), the in-force
  predicate, "authorized receipt = last `VERIFICATION_COMPLETED`", `SUPERSEDED` on a
  later one, a `VERIFICATION_COMPLETED` refused while a row is `OUTCOME_UNKNOWN`,
  `authorizeCommit`'s candidate payloads (ND-11), the body-rule words and the git
  cleanup limit (P-17/A–C). A row is byte-verified only when its event was admitted
  at migration 28 or later (One), and P-17/A holds that as an input.
- A re-check under the lock of a reference's tombstone or expiry, if either ever gates
  admission (Three; P-16/C or P-16/D1).
- Revocation, writer-id issuers beyond the Claude CLI, and the adjudication triple's
  consumer (P-28). SHA-256 object format (P-38).
- Any HTTP or CLI read of these rows (ND-13).
- The `streams` and `quality/testing` prose for the new grammar, which waits for the
  foreign doc edits to be reconciled.
- The ledger README's `### Errors` prose count, which predates this cut.
