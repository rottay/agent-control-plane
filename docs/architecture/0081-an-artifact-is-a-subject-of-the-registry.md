# ADR 0081 — An artifact is a subject of the registry before its first byte moves

- Status: accepted (P-36/local escalón A, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.

## Context

Artifacts §1.1 puts every artifact event — publication, reference, pin,
reclamation, tombstone — in `registry_events`, with `subject_kind = 'ARTIFACT'`
and the resource as the subject. There is no fifth stream and no fabricated task:
a price catalog or a policy document belongs to none. §3-§6 specify four read
models with named keys and checks, and §8.1 the table from event to projection,
with its nullity folds: `first_published_*` fixed once, `released_sequence` never
below `acquired_sequence`, and a rebuild that reads no file and no clock.

`P-36/local` does not fit in one delivery. The DT cut it into A (this record: the
ledger plane, migration 15, no filesystem), B (the lease coordination store), C
(the publisher, the reader and the reconciliation) and D (decision 41). Its five
questions were adjudicated before this escalón (`acp-p36-kimi-dt-adjudication-v1`),
and the Fable preaudit of the first brief found four things the writer could not
have settled alone (H-1..H-4), all of them adjudicated in the second.

**The stream could not hold an artifact.** Migration 9 created `registry_events`
for documents: `document_kind` is NOT NULL and closed by a CHECK, and SQLite does
not widen a CHECK in place. Adjudication 1 rejected the cheap alternative — a
fifteenth document kind named `ARTIFACT` — because it contradicts the literal
`subject_kind` of the authority.

**The rebuild aborts in its obvious form.** The preaudit probed it (H-2):
`ALTER TABLE ... RENAME` re-parses the whole schema, and the two triggers
migration 9 recreated on `control_plane_events` and `initiative_events` name
`registry_events` in their bodies. At the instant of the rename that table does
not exist, and the rename fails. `PRAGMA legacy_alter_table` would hide it and was
discarded; `PRAGMA foreign_keys = OFF` is a no-op inside the one transaction that
applies every pending migration.

**The artifact row was undefined.** `document_id`, `document_version`,
`content_digest`, `recorded_by` and `effective_from` are NOT NULL, the version is
unique per `document_id`, and the table had no column for an event kind (H-3).

**The access policy has no table.** §4 names `fk_..__access_policy_read_model`,
and no dictionary defines that table anywhere (adjudication 3).

**The register said a credential resolver "exists".** It does not: nothing in the
tree resolves a credential, and the real `CredentialResolverPort` is P-19's
(adjudication 4).

## Decision

**1. Migration 15, `artifact_registry`, rebuilds `registry_events` in a fixed
order**, SQLite's documented procedure for a change `ALTER TABLE` cannot make
([lang_altertable §7](https://www.sqlite.org/lang_altertable.html#otheralter)),
reduced to the steps this table needs, and migration 9's DROP/CREATE of the same
two foreign triggers as the precedent in this file:

1. `CREATE TABLE registry_events__rebuilt` STRICT, with `subject_kind`, a nullable
   `document_kind`, `artifact_event_kind`, and migration 9's CHECKs under
   migration 9's names;
2. `INSERT ... SELECT` of every row, `sequence` included, `ORDER BY sequence`,
   with `subject_kind = 'DOCUMENT'` and a NULL `artifact_event_kind`;
3. `DROP TRIGGER` of the three own triggers **and** of
   `tr_control_plane_events__validate_new_rows` and
   `tr_initiative_events__validate_new_rows`;
4. `DROP TABLE registry_events`, then `RENAME` into place;
5. the three indexes of migration 9, one new index
   (`ix_registry_events__subject_kind__document_id`), and the five triggers — the
   two foreign ones byte-identical to migration 9's text;
6. only then the four read models, because each carries a foreign key into this
   table, their indexes, and four watermarks.

No pragma is set. The chain is `chainDigest(previous_sha256, event_json)`; both
columns are copied and no new column enters the preimage, so every
`event_sha256` still verifies, the registry head in `ledger_meta` does not move,
and `sqlite_sequence` follows the copied rows. The suite proves each of those on a
ledger that already holds documents, causal references in both directions, and a
rewind fixture that runs the same procedure in reverse.

**After this migration four tables reference `registry_events` by a foreign key.**
A future rebuild of the stream must drop those children first, in the same
transaction, and cannot switch foreign keys off to avoid it.

**2. The stream carries a subject kind, with two mirrors.**
`ck_registry_events__subject_kind` admits `DOCUMENT` and `ARTIFACT`;
`ck_registry_events__document_kind_matches_subject` and
`ck_registry_events__artifact_event_kind_matches_subject` are equalities of truth
values — a document has a `document_kind` and no `artifact_event_kind`, an
artifact the reverse. `ck_registry_events__artifact_event_kind` names **all nine**
words of the contract although this build records six: after this migration a
rebuild is no longer cheap, and migration 7's `ck_projection_watermark__source_stream`
is the precedent for a CHECK that names the domain while the code's closed set
decides the subset. `subject_kind` has no default: every writer states its plane.

**3. An artifact row (H-3, adjudicated).**

| Column | Artifact row |
| --- | --- |
| `document_id` | the subject: `content_sha256` for the three publication events, `artifact_reference_id` for `REFERENCE_RECORDED`, `artifact_pin_id` for the two pin events |
| `document_version` | the ordinal of the event within its subject, `1 + MAX(document_version)` |
| `parent_document_version` | the ordinal before it, or NULL on the first |
| `content_digest` | the content digest, in all six |
| `effective_from` | the event's `occurredAt` |
| `recorded_by` | the producer's identity |

`ux_registry_events__document_id__document_version` stays the compare-and-set per
subject. The ordinal is **proposed by the producer and verified by the ledger**,
the ruling P-18 fixed for `1 + MAX(attempt)`: the body is digested before the write
lock, so the ledger cannot write the number in. `subjectKind`,
`artifactEventKind`, `subjectOrdinal` and `parentSubjectOrdinal` are also inside
the body, because the columns sit outside the preimage, and replay holds every
column to the body. A subject keeps its kind across its events: each door refuses
an identifier the other plane already uses.

**4. The contract owns the vocabulary and the shapes (H-1).** A new capability
module, `@acp/contracts`' `artifact-record`, declares artifacts §2's vocabularies
— `ARTIFACT_CLASSES`, `ARTIFACT_CLASSIFICATIONS`, `ENCRYPTION_STATUSES`,
`RETENTION_CLASSES`, `REFERENCE_SCOPE_KINDS`, `BLOB_LIFECYCLE_STATES`,
`ARTIFACT_EVENT_KINDS` — and §5's `PIN_HOLDER_KINDS`, each as its list and its
schema, and `ArtifactRegistryEvent`: six strict shapes discriminated by
`artifactEventKind`, with the base's pairing rules and the credential and
transcript guards over the whole event, as `ControlPlaneEvent` carries them. The
door parses with it (M-6). Which six words a build records
(`DELIVERED_ARTIFACT_EVENT_KINDS`) and which policy it admits
(`ARTIFACT_ACCESS_POLICY_IDS`) are facts about the build and live in `@acp/ledger`,
decision 45's class.

**5. The four read models land with every constraint name of the dictionary**
(M-7), including the four the preaudit proposed for rules §3, §4 and §8.1 state
without a name: `ux_artifact_blob_read_model__content_sha256__unreclaimed`,
`ck_artifact_reference_read_model__expires_at_matches_retention_class`,
`ck_artifact_blob_read_model__first_published_pair` and
`ck_artifact_blob_read_model__first_published_matches_state`. The writer adds,
declared, the rules the dictionary states with no name at all: the two
`reclaim_*` nullity folds of §8.1, `released_sequence >= acquired_sequence`,
`authority_sha256`'s digest shape, and `applied_sequence >= 0`. Two foreign keys
of the pin share §5's `fk_..__registry_events` and are named apart by their column.
There is no uniqueness over `(scope, digest, producer)`.

**6. One fold for the door and the rebuild.** `nextArtifactProjection` decides
what an event writes against a view of the four tables; the door hands it the base
inside its transaction, a rebuild the snapshot it is filling, so a planted history
fails the rebuild in the door's words (decision 56's precedent). §8.1 is read as
follows, and decision 61 records the readings the table does not spell out:

- `PUBLICATION_INTENDED` opens `1 + highest` generation when none is unreclaimed;
  reuses a `PUBLISHED` generation whole; stages a `PUBLICATION_ABANDONED` one again
  with its grace instant; and refuses a `STAGED` one, because a publication of
  that content is in flight. It takes a `PUBLICATION` pin on the exact generation,
  held by its `commandId`.
- A reused generation keeps its encryption status, key reference and profile. An
  intention that disagrees is refused with **`LedgerArtifactEncryptionConflictError`**,
  the named error §3 and §10.1 require (L-11); the message names the fields, never
  their values.
- `PUBLICATION_SUCCEEDED` and `PUBLICATION_ABANDONED` release exactly the pin
  their intention took — a live `PUBLICATION` pin of the same command on the same
  generation — and are refused without one. Success publishes a `STAGED`
  generation, fixing `first_published_*` at its own sequence and instant, and
  records the reference in the same append.
- `REFERENCE_RECORDED` needs a `PUBLISHED` generation. `PIN_ACQUIRED` of the same
  pin again is idempotent; a second live pin of one holder under another id, and
  the id of a released pin, are refused. A `PUBLICATION` pin is never taken by
  `PIN_ACQUIRED` nor released by `PIN_RELEASED`.

**7. Refused by name at the door.** `RECLAIM_INTENDED`, `RECLAIM_COMPLETED` and
`REFERENCE_TOMBSTONED` at `artifactEventKind`, before the schema is asked
(N-P36-18): reclamation, collection and tombstoning are P-36 completo. A
`SECRET_BEARING` reference, which never enters the stream. An `access_policy_id`
other than `SCOPE_EQUALITY_V1`.

**8. The access policy is closed in code, with no foreign key and no CHECK**
(adjudication 3, decision 59). A CHECK would make a second policy a reconstruction
of the read model; the closed set makes it an edit. The authority keeps §4's
foreign key under an errata line that says so, and that §8.1 lists nine events of
which this escalón delivers six.

**9. The register is corrected** (adjudication 4, decision 60). `P-36/local`'s row
said "resolver de credenciales existente". It now says that no resolver exists:
this escalón holds the negative — a credential sentinel in an artifact event is
refused by the contract's guards and reaches neither the error nor the stream,
and `SECRET_BEARING` is refused — and the real `CredentialResolverPort` is P-19's.

**10. No bump (H-4, the DT's ruling).** The escalón defines no preimage and no
derived key: every identifier is the producer's, and the subject is derived by
rule, never by hash. ADR 0076's criterion does not fire, and `CONTRACT_VERSION`
stays `"2.4.0"`. Deriving `artifact_reference_id` or `artifact_pin_id` from
anything would be a bump and an escalón of its own.

## Consequences

- `MIGRATIONS` 14 → 15. `PROJECTION_SOURCES` 14 → 18, `DERIVED_TABLES` 15 → 19
  with the four artifact tables first, children before the blob,
  `REGISTRY_PROJECTION_NAMES` new, `status().projections` 13 → 17 and its
  watermark rows 14 → 18. `EXPECTED_SCHEMA_OBJECTS` gains fourteen entries and the
  `tr_` inventory stays at eight.
- `CONTRACTS_SCHEMA_EXPORTS` 115 → 132. `CONTROL_PLANE_EVENT_TYPES` (33) and the
  channel map do not move: an artifact event is a registry row. `DOCUMENT_KINDS`
  stays at fourteen.
- The ledger README's error classes 13 → 14. `RebuildResult` gains four row
  counts.
- The CHECK over the nine artifact words is pinned equal to
  `ARTIFACT_EVENT_KINDS`, and every vocabulary CHECK of the four read models equal
  to its list in the contract.
- The `cli` and `gateway` rewind fixtures, and the ledger suite's, undo migration
  15 as a reconstruction in reverse before anything else, and hold that the
  re-applied 15 conserved the rows, the sequence counter and both foreign
  triggers. A rewind over a ledger that holds an artifact event refuses to run.
- Every registry append — document or artifact — advances all five registry
  watermarks, the routing projection's registry row among them.
- **Nothing produces an artifact event yet**, and nothing reads the four tables
  outside the ledger. `artifact-store` is untouched, and its P8 pins do not move.

## Not in this record

The filesystem — staging, hash verification, `fsync`, rename, directory
permissions, rejection of symlinks — and the reader by reference are escalón C.
The `artifact_blob_lease` coordination store is escalón B. Decision 41's
`envelope_artifact_reference_id` is escalón D. Reclamation, garbage collection,
tombstoning, backup and restore of the artifact tree are P-36 completo. The
producer that publishes a task envelope or a prompt is an adoption of its own.
