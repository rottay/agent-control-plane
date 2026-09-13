# ADR 0082 — A blob lease excludes the second publisher, and no clock releases it

- Status: accepted (P-36/local escalón B, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.
- Amends: nothing. ADR 0081 left "no lease store" to escalones B and C; this
  record is B's half, and ADR 0074's consequence that `artifact_blob_lease` was
  "in no escalón of this packet" is answered by a later packet rather than
  revised.

## Context

Artifacts §8 opens publication with "la exclusión se adquiere primero": step 1 is
a compare-and-set over `artifact_blob_lease`, and only step 2 touches
`registry_events` and the four read models escalón A delivered. §9 opens
collection the same way, with `operation = 'RECLAIM'`. §7 specifies the table —
a separate file, no history, a monotonic generation distinct from
`blob_generation` — and coordination §8.1 names it as the fifth coordination
file, with its own `coordination_store_meta` and the token
`(store_incarnation_id, generation)`, "además de la identidad del holder".

Four facts shaped the store, and none of them is in the table alone.

**The ledger and this file share no transaction.** Coordination §1 says so, and
the brief's first version described the compare-and-set as "contra el estado del
blob del read model". It cannot be: this store is another SQLite file, and the
blob's state — staged, published, a generation to deduplicate — is read by the
publisher inside the ledger's own append, which is step 2 (preaudit H-1).

**The store cannot prove quiescence.** §8 `:266-267` releases a holding whose
holder died "sólo tras quiescencia probada", and §9 `:343-347` says expiry
"habilita reconciliar, no transferir". Proven death and reap, or a backend that
refuses a stale fence, are facts about processes. This package's stores read no
clock and no process, by law (H-2).

**The mould that fits is the outbox's, not the lease store's.** E1's retrofit put
the metadata second, made the incarnation optional and deferred the validators.
§8.1 `:385` says reservations and the blob lease "nacen con CHECKs de
estado/nulidad y validadores de token" (H-3).

**The file has no name in any authority.** Coordination §1 lists four files,
artifacts §7 says "archivo separado", and datos §11 is silent (H-6).

## Decision

**One.** `artifact-blob-leases.sqlite`, beside the ledger, produced only by
`artifactBlobLeaseStorePath(ledgerPath)` (decision 62). Its own migration list
under `artifact_blob_lease_schema_migrations`, `STRICT`, no clock, no environment,
no `DELETE`, and the rule-shaped wrong-file guard that refuses the ledger and
every sibling before anything is written. Coordination §1 gains the row.

**Two.** Migration 1 is `coordination_store_meta`, with the five-kind CHECK, and
`openArtifactBlobLeaseStore` requires `incarnationId` and `createdAt`: no
adoption window. `incarnation()` throws `LedgerIntegrityError` when the row is
gone or declares another kind, and every verb reads it inside its transaction. A
file that holds lease rows and no metadata is refused at `open` rather than
adopted, because registering an incarnation there would re-validate tokens
nobody can place.

**Three.** Migration 2 is §7 `:214-227` column by column: `pk_artifact_blob_lease`
on `content_sha256` alone; `ck_artifact_blob_lease__generation_positive`;
`ck_artifact_blob_lease__operation_enum` over `PUBLISH` and `RECLAIM`; the five
operation columns null exactly when `operation` is, each as an equality of
nullity tests; `ux_artifact_blob_lease__operation_id` partial. The incarnation is
validated by `tr_artifact_blob_lease__validate_insert` and
`tr_artifact_blob_lease__validate_update`, because SQLite admits no subquery in a
CHECK.

**Four.** The generation rule by mutation lives in the update trigger. A new
holding — a grant over a free row or a take-over — advances it by exactly one; a
write under the same holding (same operation, operation id, holder and
incarnation) conserves it; clearing a holding conserves it for a release and
advances it for a revocation; a free row stays where it was freed. Never
backwards, never by two, and never past `MAX_ARTIFACT_BLOB_LEASE_GENERATION`.

**Five.** Four verbs, each one `BEGIN IMMEDIATE` with the decision inside the
lock:

- `acquire(grant)` — insert at 1 or advance a free row; `HELD` over any holding,
  expired or not; `UNCHANGED` for the grant that already stands;
  `OPERATION_ID_IN_USE` when the id holds another digest.
- `release(token)` — the holder's own: incarnation against the live metadata and
  against the row, then generation, then holding, then holder and operation id;
  the generation is conserved.
- `revoke(token, quiescence)` — ends a holding without granting it; generation
  `OLD + 1`.
- `takeOver(token, quiescence, grant)` — a new grant over a quiescent holder at
  `OLD + 1`, compared against the incarnation and generation observed; a replay of
  the take-over that stands answers `UNCHANGED`.

The two verbs that end somebody else's holding take an
`ArtifactBlobLeaseQuiescence` — `DEATH_AND_REAP_PROVEN` or
`STALE_FENCE_REFUSED_BY_BACKEND`, and the pid it is about — as a **required**
argument. The store refuses one that names a process the row does not record,
and verifies nothing else about it: the proof is the caller's (decision 63).

**Six.** Refusals are values from a closed set of facts about the file:
`HELD`, `OPERATION_ID_IN_USE`, `NOT_HELD`, `INCARNATION_SUPERSEDED`,
`GENERATION_SUPERSEDED`, `HOLDER_MISMATCH`, `QUIESCENCE_OF_ANOTHER_PROCESS`. A
malformed argument throws `LedgerQueryError`, including a digest that is not 64
lowercase hex characters, before the database is touched. No error class is
added.

**Seven.** No verb frees a row by the clock. There is no `sweep`; `listOverdue`
reads and returns.

**Eight.** The fault seam escalón C drills against is named here, as H-7
requires. It is the verb boundary: each verb commits whole or not at all, so
"dies after step 1 and before step 2" is a committed `acquire` followed by
nothing, and needs no hook in this store. For the half no reading of the code can
prove — that a verb failing after its write leaves nothing behind —
`__testFaults.beforeLeaseCommit` runs inside every mutating transaction after the
write and before commit, on the ledger's `LedgerTestFaults` precedent, and the
suite throws from it in all four verbs. Neither moves a row by the clock.

**Nine.** Fence: `COORDINATION_STORES` gains the fourth entry, so L-P18E1-1..3
hold over this file; `L-X1-4` counts five names; `L-P36B-1..4` — immediate,
purity, one producer, no clock — are the outbox's twins; `TEST_ONLY_DOMAINS.ledger`
registers `artifact-lease-race-worker`.

## Why the compare-and-set does not read the blob's state

Because it cannot without a transaction across two files, and coordination §1
forbids claiming one. Were this store to consult a copy of the blob's state, it
would be a second read model of the registry, out of date by construction. The
order of §8 is the design: exclusion first, then — under it — the ledger's append
reads the head, decides deduplication and records the intention atomically with
the pin. The exclusion is what makes that read stable for the duration.

## Why the store takes a quiescence attestation it cannot verify

The alternatives were worse in named ways. A `sweep`, or a take-over admitted on
`expires_at`, is the transfer §9 `:343` forbids. A take-over with no argument
would let a caller end a holding without ever being asked the question §8.2 step
3 makes blocking. Probing the pid here would read a process from a substrate that
may not, and would still not prove reap. So the store names the precondition in
the signature, checks the one part of it that is a fact about this file — that it
is about the recorded process — and guarantees the compare-and-set that keeps two
reconcilers from both succeeding. Whoever supplies the attestation owns its
truth, and escalón C's ADR must say how it obtains it.

## Why `RECLAIM` is admitted as data

Q-P36B-1. The mechanism is identical for both words — one holding per digest —
and admitting both is what makes §9's first negative impossible by construction:
a collector holding `RECLAIM` refuses a publisher's `PUBLISH` on the same bytes,
and the reverse. Refusing `RECLAIM` by name would put a policy word in a
substrate and force collection to move a pin later. The ledger still refuses
`RECLAIM_*` events by name (ADR 0081): the store admitting the word executes no
collection.

## Consequences

- The exclusion is proven across processes in two arms: four processes acquiring
  one free digest yield exactly one holder and no lock errors, and two
  reconcilers holding the same observed generation yield one take-over at
  `OLD + 1` and one `GENERATION_SUPERSEDED`. A token read before an incarnation
  rotation is refused in another process too.
- A holding written under an incarnation that has since rotated is **frozen**:
  its own holder's token is refused by the live metadata, a token naming the live
  incarnation is refused by the row, and nobody else is granted the blob. That is
  fail-closed and deliberate; the procedure that re-issues holdings under a new
  incarnation is coordination §8.2's and not here.
- N-P36-14 is closed by half: the store refuses a superseded holder. That the
  holder then touches no file is escalón C's.
- N-P36-8 is closed by half: a dead holder's exclusion survives every reopening
  and every expiry, and ending it requires an attestation. Proving the
  attestation is C's.
- There is no renewal verb. The trigger admits a write under the same holding
  that conserves the generation, so adding one is a verb and a test, not a
  migration.
- Nothing calls this. `artifact-blob-leases.sqlite` exists on no ledger in the
  field.

## Not in this record

The publisher, the private reader, the reconciler and their filesystem order are
escalón C's, as is how the quiescence attestation is obtained. Collection and its
events are P-36 completo. Decision 41 is escalón D's. The restore procedure of
coordination §8.2 — freezing, reconciling against the ledger, rotating the
incarnation and re-issuing holdings — is P-18/recuperación's.
