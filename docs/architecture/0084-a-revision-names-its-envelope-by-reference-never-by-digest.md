# ADR 0084 — A revision of the new cohort names its envelope by reference, never by digest

- Status: accepted (P-36/local escalón D, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0067 §5 — the column that was absent is added, by the cohort that
  section anticipated. ADR 0083's consequence that "the door does not look inside
  `intendedReference`" — it does now (postaudit O-1). ADR 0080's statement that
  without a revision every payload is byte-identical to `a6ed7c3` — it still is,
  save the contract version every event states. Precision for
  `docs/audit/architecture/database/execution/index.md` `:73`: where it says
  "NOT NULL desde P-36/local", the exact reading is **required from contract
  version `2.5.0`**; the migration adds the column nullable and the cohort, not
  the migration, decides which rows hold a value. No record's decision changes.

## Context

Execution §2 `:73` puts `envelope_artifact_reference_id` in
`task_revision_read_model`: the envelope's full content is an artifact of class
`TASK_ENVELOPE`, and it "se recupera por esta referencia autorizada, no por el
digest" — knowing `envelope_sha256` grants no access to the bytes. P-05/B could not
create the column: it is `NOT NULL` in the dictionary and only the artifact plane
mints its value. ADR 0067 §5 and decision 41 recorded the deferral and its shape —
`ADD COLUMN`, a `BEFORE INSERT` trigger by cohort of `contract_version`, the value
carried as a key of the revision record's payload, `NULL` on every earlier
revision, and **nothing ever derives a reference from a digest**. Until now the fold
refused the key outright.

Escalones A, B and C built the plane: the registry's artifact events and four read
models (ADR 0081), the blob lease (ADR 0082) and the publisher (ADR 0083). This is
the last escalón of P-36/local. The map (§3, corte D) and the DT's adjudication of
it (point 5) scoped it as "column + cohort + fold + version", and placed the
publication of a task envelope by the runtime in adoption.

Three things were not in the brief as first written and were ruled before a line
moved:

- **The version** (preaudit H-2). Every revision written since P-18/protocolo F is
  stamped `2.4.0`. A trigger keyed on `contract_version` cannot tell a `2.4.0`
  revision recorded before migration 16 from one recorded after it, and the two
  ways around that are both unlawful: a cohort by sequence contradicts the letter of
  decision 41, and a column nobody fills is the "column with no producer pointing at
  an empty port" ADR 0067 §5 refused.
- **The live producer** (writer NEEDS_DECISION Q-D1). P-18/protocolo G delivered a
  runtime walk that opens its attempt with `TASK_ATTEMPT_OPENED`, and that event
  carries a revision record. A bump puts it in the new cohort. The DT ruled that the
  runtime **carries** the reference its caller hands in, as it carries the digest,
  and does not publish it.
- **The upgrade** (Q-D2). `canonicalRevision` excludes `contractVersion` so that a
  second attempt stamped after a bump does not conflict with its own row. A revision
  opened under `2.4.0` holds `NULL` for ever; its second attempt, stamped `2.5.0`,
  must carry a reference.

## Decision

**One — migration 16.** `ALTER TABLE task_revision_read_model ADD COLUMN
envelope_artifact_reference_id TEXT` — nullable, no default, so every existing row
reads `NULL`, which is the cohort before. No table is rebuilt, no index moves, no
watermark is seeded or moved: the fold over the existing history yields the same
rows with `NULL` in the new field, so the projection is level with its stream the
moment the column exists. One trigger,
`tr_task_revision_read_model__validate_envelope_reference`, `BEFORE INSERT`, two
sides (M-5.1):

- `contract_version IN ('2.2.0', '2.3.0', '2.4.0')` with a value → `RAISE`;
- `contract_version NOT IN ('2.2.0', '2.3.0', '2.4.0')` with `NULL` or `''` → `RAISE`.

The cohort before is a **closed list frozen in the migration**, never a comparison
of version strings (M-5.2): a migration is immutable, the three are every version
a build before it could stamp, and a later bump falls into the cohort after without
touching it. The fold spells the same three in
`PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS`, and the suite holds the spellings
equal. The trigger checks no existence (M-5.3; see Four).

**Two — the bump pays the cohort, not an identity.** `CONTRACT_VERSION` moves to
`"2.5.0"`; `SUPPORTED_CONTRACT_VERSIONS` becomes `["2.2.0", "2.3.0", "2.4.0",
"2.5.0"]`; `AdmittedContractVersion` pins the version in force; the append door
refuses new work stamped with any other; an exact replay stays exempt. `"2.4.0"`
stays readable for ever.

ADR 0076's criterion is about identity — "B added facts; C added a way of computing
identity" — and it stays the criterion for a bump carried by identity. Read alone,
it would not carry this one: the envelope reference is a **fact**, like
`intendedReference` in decision 64. Nothing is derived from it, the identity of a
revision (`(task_id, revision_number)`) and of its envelope (`envelope_sha256`) do
not move, and the fold checks only its form. This record does not bend 0076 to make
the reference look like identity. It adds a second legitimate reason to move the
version, of a different kind: **when a law fixes a cohort by version, the version
is the discriminator, and it must move for the cohort to exist.** Decision 41 is
such a law. A future escalón asking whether to bump asks both questions: does it
add a way of computing identity (0076), and does a law key a cohort on the version
it would otherwise leave still (this record).

**Three — the fold checks form and cohort.** The revision record is still born from
the presence of its four keys on an event of any type, and a partial set is still no
revision. When the four are present, `nextTaskRevisionProjection` reads
`payload.envelopeArtifactReferenceId` by name (`ENVELOPE_ARTIFACT_REFERENCE_KEY`)
and decides it by `event.contractVersion`:

- a version of the cohort before, with the key → refused by name (the old N6,
  conditioned on the cohort);
- a version of the cohort after, without the key → refused by name, and the refusal
  says a reference is never derived from the envelope's digest;
- a present value that is not a non-empty string — `null`, `""`, a number, an
  object → refused by name, never read as absent (CORR-2, decision 56).

These are refusals rather than rows with a hole, which keeps the exception ADR 0067
§5 made to the fold's totality: a payload claiming, or omitting, a fact its own
version decides is a reader being asked to pretend. The door, the incremental
projection and the rebuild all reach the same function.

**Four — the door checks existence, by name and nowhere else.** Before the insert,
and before the attempt's compare-and-set, the append door folds the event and, for
a record that names a reference, looks it up in `artifact_reference_read_model`:
absent → `LedgerValidationError` at `payload.envelopeArtifactReferenceId`; present
with `artifact_class` other than `TASK_ENVELOPE` → the same path, naming the class.
The value is producer-supplied text and is never echoed. This is the precedent the
opening's foreign key set (a `SELECT` before SQLite would abort), with a stronger
reason not to push it down: the reference is a projection of the **registry**
stream and the revision a projection of the **task** stream. A trigger or a foreign
key across them would make a rebuild — which clears every derived table and folds
one chain at a time — depend on the order it folds the streams in, and abort on
history the door accepted. So a rebuild trusts what the door checked, as it trusts
every other cross-stream fact.

Not checked, declared: the reference's scope, retention and tombstone. Scope is the
private reader's law (decision 66 (g)); nothing in this build tombstones a
reference; and a revision records which bytes were asked about, not who may read
them.

**Five — written once, and the reference counts only where the row holds one.**
`sameRevisionRecord(stored, arriving)` is the one exported comparison for the door
and the snapshot. It compares `canonicalRevision`'s three facts always, and the
reference **only when the stored row holds one** (Q-D2). A row of the new cohort
holds a reference, so another reference — or none — at its coordinate is refused
with the written-once words; the same reference is a replay. A row of the cohort
before holds `NULL` for ever (insert-only, and the trigger keeps it so); a second
attempt stamped after the upgrade agrees on the three facts and is admitted, and
its reference stays in the log, not in the row. The alternative — refusing, and
resolving every task in flight at the upgrade with a new revision — was a liveness
cost with nothing bought.

**Six — the runtime carries the reference; it does not publish it.**
`InvocationRevision` gains `envelopeArtifactReferenceId`, **required** on the V2
extension because the walk stamps the version in force and an optional member would
build openings the door refuses. `deriveInvocation` projects it field by field;
`buildAttemptOpening` puts it in the payload; it enters no preimage, and
`invocationId` does not move. An invocation without a revision is the V1 walk, and
every byte of it is what `a6ed7c3` built except the contract version every event of
every producer states. The runtime mints no reference, writes no envelope and
derives nothing from the digest. Publishing a task envelope's bytes through the
private plane, and binding its reference at submission, is adoption.

**Seven — the intention's block earns the stream's rules (O-1).**
`artifactEventRefusal` runs its two reference rules — `SECRET_BEARING` never enters
the stream, the access policy is `SCOPE_EQUALITY_V1` — over **every** reference an
event carries: the success's and `REFERENCE_RECORDED`'s, as before, and now
`payload.intendedReference` of a `PUBLICATION_INTENDED`, at the paths
`payload.intendedReference.classification` and
`payload.intendedReference.accessPolicyId`, with the same words. The fold still
never reads the block, and a body without it is admitted as before (decision 64).
The door and the rebuild call the same function, so a planted intention with such a
block fails a rebuild — and the integrity replay — in the door's words.

## Consequences

- `MIGRATIONS` 15 → 16. `EXPECTED_SCHEMA_OBJECTS` gains one trigger; the `tr_`
  inventory 8 → 9. `DERIVED_TABLES`, `PROJECTION_NAMES`, `PROJECTION_SOURCES` and
  the watermark rows do not move.
- `TaskRevisionReadModel` gains `envelopeArtifactReferenceId: string | null`, and
  `verifyIntegrity` compares it like every other field. No new export on the
  ledger's barrel: the key, the frozen list and `sameRevisionRecord` are reached by
  the package's own modules and its suite.
- The bump's baggage, site by site: the contract's pins and the `"2.5.0"` literals
  that asserted a refusal move to `"2.6.0"`; the three `envelope-identity` vectors
  move with the fixture's version and by no other cause (consequence V3, declared a
  third time), computed twice, by `envelopeSha256` and independently; the telemetry
  fixture stays at `"2.2.0"`, stored history the reader admits; the runtime's two
  V1 walk vectors lifted from `a6ed7c3` are **not** re-pinned — they are held over
  the same walk with the version field stamped as it was, which proves the version
  is the only byte the bump moved.
- A test ledger that takes a revision of the new cohort needs a registered
  `TASK_ENVELOPE` first. The suites plant one through the artifact door, as a
  fixture. A fixture that rewinds a V2 history past migration 15 must first rewrite
  it into the shape a build before 16 left — `2.4.0`, no key, no artifact event —
  because no such build could have written either.
- Rewinds past 16 drop the trigger before the column: SQLite refuses `DROP COLUMN`
  for a column a trigger names (M-7). The CLI and gateway fixtures undo 16 by name
  before 15.
- N-P36C-20 is replanted: its `SECRET_BEARING` block is now refused at the append,
  so the history it drills — a block the intention's door admits and the success's
  door refuses — is built with a reference id another publication already
  registered.
- A writer that bypasses the door can still insert a new-cohort row naming a
  reference nobody registered; the trigger checks presence, not existence. That is
  the cost of keeping the streams independent at rebuild, stated rather than hidden.

## Not in this record

Publishing a task envelope's bytes, binding its reference at submission, and every
composition that derives a V2 invocation — the daemon, durability, the CLI, the
gateway — are adoption, which "no partial cutover" holds back. Scope checks on the
envelope reference, tombstoning, collection and the restore of §11 are P-36
completo. `execution/index.md` is not edited here; this record carries its
precision.
