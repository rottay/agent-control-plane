# ADR 0083 — A publication names its bytes only after they survive the fsync

- Status: accepted (P-36/local escalón C, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0081's consequence that "nothing reads the four tables outside the
  ledger" — the ledger now exposes their read-only view — and ADR 0082's open
  point that escalón C's record must say how a quiescence attestation is
  obtained. Neither record's decision changes.

## Context

Escalón A made an artifact a subject of the registry: six events, four read
models, one fold shared by the door and the rebuild, and no file. Escalón B made
the exclusion artifacts §8 acquires first: one holding per digest, a monotonic
generation, and two verbs that end somebody else's holding only on a quiescence
attestation the store cannot verify. Neither moved a byte. This escalón is the
one that does, and artifacts §8-§10 fix what it must be:

- **§8 `:237-253`** — the order: the lease, `PUBLICATION_INTENDED`, staging written
  and its hash verified, `fsync(file)`, `rename`, `fsync(dir)`,
  `PUBLICATION_SUCCEEDED` recording the reference and releasing the pin in one
  append, the lease released. The reference is written after the bytes, never
  before (`:255-256`); directories `0700`, files `0600` (`:257`); no pin survives a
  success (`:258-259`).
- **§8 `:260-271`** — the crashes: 1→2 is a holding with no intention, released
  only after quiescence; 2→3 is an intention and a pin with no bytes, retried or
  abandoned by `command_id` under the same idempotency key; 3→4 with valid bytes
  "may complete the original reference", and without them is an abandonment that
  keeps the blob's grace instant. §9 `:338` adds the fifth: after the outcome,
  release the generation.
- **§10 `:358-371`** — expiry revokes nothing; paths derive from the digest,
  sharded by two hex characters; the root is resolved once and symlinks are
  refused when opened; `SECRET_BEARING` is no permission for credentials.
  **§10.1 `:373-382`** — the digest is of the content in clear.

Adjudication 2 of the map put the private plane in a subroot of its own, apart
from the legacy digest store whose readers resolve a bare digest. The preaudit
(REJECT, H-1..H-17) found two things the brief could not execute without the DT:
the plane had no way to read the ledger it must propose against (H-1), and
nothing durable said which reference 3→4 should complete (H-2). The delta
(ACCEPT_WITH_CORRECTIONS, C-1..C-7) fixed the shape of the second.

## Decision

**One — the subroot.** `private-artifacts/`, a sibling of the legacy
`artifacts/` beside the ledger, produced only by
`artifactPlaneRootFor(ledgerPath)`, which does not call `artifactRootFor`
(decision 65, C-6). `openArtifactPlane` creates it `0700` without `recursive` if
absent, refuses a link or a non-directory, resolves it **once** with
`realpathSync`, and records its device and inode. Every entry point checks that
the directory at the resolved path is still that one, and throws
`LedgerIntegrityError` if not.

**Two — the order.** `publish` performs §8 exactly:

1. `acquire` a `PUBLISH` holding whose operation id is the command id;
2. `appendArtifactEvent(PUBLICATION_INTENDED)` — not `appendBatch` — with the
   generation and ordinal proposed from the ledger under the holding, and the
   reference it will record in `intendedReference`;
3. the shard ensured; any staging residue unlinked; staging opened
   `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, `fchmod 0600`, written; **re-opened and
   verified** (regular file, size, SHA-256); `fsync`; `rename` onto
   `<root>/<2hex>/<digest>`; `fsync` of the shard;
4. `appendArtifactEvent(PUBLICATION_SUCCEEDED)` with the intention's own reference;
5. `release`.

The staging name is `<digest>.staging` in the shard: the same filesystem, so the
rename is atomic, and derived from the checked digest alone. Before every
filesystem mutation and before the success the plane reads the token again and,
if its holding no longer stands, returns `LEASE_SUPERSEDED` and writes nothing
more. That comparison is defence in depth; the guarantee is the quiescence proven
before a take-over (§9 `:343-347`).

**Three — a destination that exists.** Bytes already at the digest's path are
verified: equal, and nothing is written or renamed (a deduplicated publication, or
a re-staged generation over bytes an abandonment left); unequal, a link, or not a
file, and nothing is overwritten or removed — the publication is abandoned with
`CONTENT_DOES_NOT_VERIFY` or `SYMLINK_REFUSED`. Staged bytes that fail their own
verification are unlinked and the publication abandoned. The one `unlink` in the
module is of its staging path.

**Four — what is refused before the lease.** The digest and size are computed
from the bytes; a declared digest or size that disagrees is refused. Content over
`ARTIFACT_PLANE_CONTENT_MAX_BYTES` (16 MiB, a memory bound: the plane digests the
whole object before asking for the lease) is refused. `ENCRYPTED_AT_REST` is
refused by name (§10.1: only `PLAINTEXT` here). A `SECRET_BEARING` reference and a
policy outside `SCOPE_EQUALITY_V1` are refused in the door's words, and so is a
reference id the ledger already records, unless this command's own success
recorded it (see Consequences). The intention
and the success the request would record are parsed through `ArtifactRegistryEvent`
first, so the credential and transcript guards refuse a sentinel in any metadata
field by path, before a lease row, an event or a file exists. Malformed arguments
throw `LedgerValidationError` or `LedgerQueryError`; no error class is added.

**Five — every identity is the caller's.** Event ids, idempotency keys and
instants of the intention and of the terminal event, the command id, the pin id,
the reference id, the holding's holder and pid, and the attestation all arrive in
the request. The plane reads no clock, no process and no environment, and mints
nothing — so it computes no identity, and nothing here is a preimage.

**Six — the reconciler.** `reconcile({ contentSha256, holding, quiescence?,
terminal, recordedBy })` checks the digest's form before any path exists, then
reads the lease row and the live `PUBLICATION` pins of that digest:

- a `RECLAIM` holding → `HELD_FOR_RECLAIM`, nothing moves;
- a `PUBLISH` holding and no attestation → `QUIESCENCE_UNPROVEN`; an attestation
  about another pid → `QUIESCENCE_OF_ANOTHER_PROCESS`; nothing moves (N-P36C-8);
- a holding whose command has no live pin — no intention (1→2) or an outcome
  already recorded (4→5) → `revoke`, with no file touched and no event appended;
- a holding whose command has a live pin → `takeOver` under the same operation
  id, then steps 3-5 with no bytes to write: a staging residue is unlinked, a
  destination that verifies completes **the intention's `intendedReference`, field
  for field** (N-P36-10, N-P36C-17), and one that is absent or does not verify is
  abandoned, which the fold records keeping `grace_started_at`; a success the
  door refuses is abandoned the same way, `REFERENCE_REFUSED_BY_DOOR`;
- no holding and a live pin — a holding revoked with its pin still live — →
  `acquire` and the same drive: nobody is displaced, so no attestation is needed;
- neither → `NOTHING_TO_RECONCILE`.

An intention with no `intendedReference` is abandoned even over valid bytes, which
stay (N-P36C-18); the next intention of the same content re-stages the generation
(decision 61) and verifies them without rewriting.

**Seven — the restarted publisher.** It does not replay `acquire` (C-5). It calls
`publish` again with the same request and an attestation about the recorded pid:
the plane takes the holding over under the same operation id, **finds** its
intention — re-appending would be refused by the fold, and a body with another
reference under the same key is `LedgerIdempotencyConflictError` — and continues
from step 3. An outcome already recorded is answered as a replay. `UNCHANGED` from
`acquire` is reserved for re-entry in the same process: same holder, pid and
incarnation. A displacing holder must name itself differently from the holder it
displaces, because `takeOver` answers a grant under the same holder as a replay and
would leave the dead pid on the row, where a later attestation about that dead pid
would be true while a live process holds the blob (B's O-1, closed here by a
refusal).

**Eight — quiescence is an input.** H-8: the attestation is the caller's
`ArtifactBlobLeaseQuiescence`, never `process.kill(pid, 0)` inside the plane. That
answers ADR 0082's open point: the plane obtains it from whoever calls it, checks
that it names the recorded pid, and passes it to the store.

**Nine — the reader.** `read({ artifactReferenceId, scopeKind, scopeId })`:
`SCOPE_EQUALITY_V1` is equality of kind and id; a `SYSTEM` reader carries no id
and reads only a `SYSTEM` scope; a foreign scope and an absent reference get the
same `REFERENCE_NOT_READABLE` (N-P36C-9). Then `CONTENT_DELETED` for a tombstone,
`BLOB_NOT_PUBLISHED` for a generation not `PUBLISHED`,
`ENCRYPTED_AT_REST_NOT_DELIVERED` by name, and the bytes opened with `O_NOFOLLOW`
and verified: `CONTENT_ABSENT`, `SYMLINK_REFUSED` or `CONTENT_DOES_NOT_VERIFY`,
never an empty answer and never unverified bytes. Expiry is not read.

**Ten — the fault seams.** `__testFaults` names eight points, one between each two
steps: `afterLeaseAcquired`, `afterIntentionRecorded`, `afterStagingWritten`,
`afterStagingVerified`, `afterStagingSynced`, `afterRename`,
`afterDirectorySynced`, `afterOutcomeRecorded`. A hook that throws ends the call
where it stands with no cleanup; the suite closes the handles and reconciles from a
new plane over the same ledger, lease file and subroot. B's `beforeLeaseCommit` and
the ledger's `beforeProjection`/`beforeAppendCommit` stay the seams inside each
transaction. No `SIGKILL`, no worker.

**Eleven — the ledger's read verbs** (H-1). `getArtifactBlob`,
`getUnreclaimedArtifactBlob`, `getHighestArtifactBlobGeneration`,
`listArtifactBlobsInState`, `getArtifactReference`, `getArtifactPin`,
`listLiveArtifactPins`, `listArtifactEvents`: the fold's own view outside a
transaction, on `getOutboxCommand`'s pattern, reading no file and no clock and
writing nothing. The door and every fold are unchanged.

**Twelve — fence.** `L-P36C-1` root resolved once and checked, `L-P36C-2` no link
followed, `L-P36C-3` digest checked before a path, `L-P36C-4` one producer of the
subroot and no legacy store, `L-P36C-5` no clock, no identity, no removal of a
published object and no `RECLAIM`. `PATH_SCOPED_LAWS` 133 → 138.

## The contract change: the intention carries its reference

`PublicationIntendedPayload` gains `intendedReference:
ArtifactReferenceRecord.optional()` (H-2, C-1, decision 64). It is the whole
record the success will carry — `artifactReferenceId`, `artifactClass`,
`classification`, `scopeKind`, `scopeId`, `producerIdentity`, `accessPolicyId`,
`retentionClass`, `expiresAt` — with its two refinements inherited. The id is
what makes a reconciled reference **the original one**; the fold's
`assertReferenceIsNew` still verifies it at the success.

It is facts, not identity. ADR 0076 `:131-139` moves the version for a way of
computing identity — a digest the fold verifies, a derived key, a version per
payload. The fold reads no field of the block, nothing is derived from it, and a
body without it parses as before and keeps its chain digest. So
`CONTRACT_VERSION` stays `2.4.0` and `SUPPORTED_CONTRACT_VERSIONS` does not move.
The optionality is the schema's, for history; the plane always writes the block,
and `publish` requires the reference as input (C-2).

Because the block is inside the canonical body, the door's exact-replay rule
settles the retry question on its own: the same body under the same key is a
replay, and another reference under the same key is
`LedgerIdempotencyConflictError`. The fold does **not** compare the success's
reference with the block — folds do not change in this escalón — so that equality
is the plane's to keep, and its suite shows it.

## Why the reconciler does not complete a reference without the block

The preaudit's option (a) — only a retry of the same command, re-presenting the
reference, completes it — would leave an autonomous reconciler unable to finish a
publication whose bytes are provably correct, which §8 `:260-262` names as the
thing reconciliation may do. Option (c), a sidecar file of intentions in the
subroot, would be a second authority over metadata the ledger records. With the
block, the reference is in the ledger before a byte moves; without it — an
intention from another producer — the plane abandons, which is the safe
direction: the bytes stay, no reference is invented, and the grace clock does not
restart.

## Why the plane reads the ledger instead of guessing by refusal

The fold verifies a proposed generation and ordinal; it does not hand them out.
Proposing by trying and parsing a `LedgerValidationError` would make an error
message an interface, and opening SQLite from the plane would bypass the package's
one statement that raw access is absent. The read verbs are the view the fold
already had, exposed without a transaction, and the lease is what keeps the answer
stable while the plane acts on it.

## Consequences

- N-P36-1..17 that the preaudit assigned to C, N-P36C-1..20, and N-P36-19 (the
  rebuild with a block in the stream) have tests in
  `test/artifact-plane/index.test.ts`, `test/ledger/index.test.ts` and the
  contract's suite.
- **Pin live, lease revoked** (H-10) is a legal state: a holding revoked while its
  publication pin is live leaves a publication nobody holds. The reconciler takes
  it with a fresh `acquire`, needing no attestation because nobody is displaced,
  and ends it. **Pin released, lease held** (4→5) is legal too, and ends by
  `revoke`.
- A holder displaced mid-operation stops at its next check; a filesystem write
  already in the kernel is not recalled. That window is closed by quiescence, not
  by the check.
- A staging residue of a displaced holder stays until the next holder of that
  digest unlinks it.
- **No refusal leaves a digest held** (postaudit C-1). A reference id the ledger
  already records is refused before the lease, by path
  `reference.artifactReferenceId`, unless it is this command's own recorded
  success, which a retry replays. The check cannot close the window before step 4,
  so the door may still refuse the success — a reference recorded meanwhile, or a
  block no success may carry. That refusal is final, and the plane records
  `PUBLICATION_ABANDONED` under the **same** terminal identity and answers
  `ABANDONED` with `REFERENCE_REFUSED_BY_DOOR`: the bytes stay, the generation
  keeps `grace_started_at`, and the next intention re-stages it, the direction
  decision 64 already fixes for a missing block (N-P36C-19, N-P36C-20). Any other
  failure of a terminal append — a terminal key already spent, integrity, the
  filesystem — releases the holding this live process took and is thrown, leaving
  the pin live for a retry under a corrected identity.
- `publish` refuses a `RECLAIM` holding recorded under its own command id with
  `HELD_FOR_RECLAIM`, as `reconcile` does; it never takes a collector's holding
  over as a publication (postaudit O-2).
- The door does not look inside `intendedReference`: `artifactEventRefusal` —
  `SECRET_BEARING`, the closed policy set — runs on the reference of a success and
  of `REFERENCE_RECORDED`, as before. The plane refuses both words before writing
  the block, and no success over such a block can fold; an intention from another
  producer that carries one into `event_json` ends, under the plane, in the
  abandonment above rather than a held digest. Closing it at the door is a change
  to `projection/index.ts`, outside this escalón's write-set: it is escalón D's
  (postaudit O-1), with a decision row and a rebuild over a stream that already
  holds a valid block.
- `artifact-store` is untouched; its readers still cannot see a private object,
  and the plane cannot see theirs.
- Nothing in the field calls the plane.

## Not in this record

Collection, `RECLAIM_*`, `REFERENCE_TOMBSTONED` and the restore of §11 are P-36
completo. Encryption at rest is not delivered. Decision 41's envelope reference is
escalón D's, and a producer that publishes a task envelope or a prompt through the
plane is an adoption apart. The procedure that re-issues holdings under a rotated
incarnation is coordination §8.2's.
