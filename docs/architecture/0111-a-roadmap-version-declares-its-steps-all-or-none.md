# ADR 0111 — A roadmap version declares its steps, all or none

- Status: accepted (P-26, cut B, recorded 2026-09-24).
- Supersedes: none.
- Superseded-by: none.

## Context

Planning §3–§4 give an initiative's roadmap its steps and their dependencies. A step
belongs to exactly one roadmap version, a new revision never mutates the previous
one's steps, and a cycle is refused where it is written, its result recorded "como
parte del evento que declaró la dependencia". Cut A (ADR 0110) made the roadmap
version's own law run inside the append; until this cut a version carried no steps at
all.

Three facts shaped the cut:

- A step's texts (objective, acceptance, expected write set) are free text. The stream
  is append-only and read by every door, so free text belongs in the private plane.
  The stream holds a digest.
- A version and its steps are one fact. A version recorded without its steps, or
  steps without their version, is a history no reader can interpret.
- Decision 160 lets P-26 take the first contract bump after it. ADR 0072 binds that
  escalón to three acts, not a constant (Fable C1).

## Decision

### One — the contract: four initiative types, a private manifest, a step cohort (decision 172)

- `INITIATIVE_EVENT_TYPES` grows from three to four with `ROADMAP_STEP_DECLARED`, a
  passthrough of the initiative's status like `ROADMAP_VERSION_RECORDED`.
- **`RoadmapStepManifest`** is the private document. It carries
  `manifestContractVersion: 1` and 1..`ROADMAP_STEPS_MAX` (200) steps. Each step
  carries:
  - a `stepId` (`BOUNDED_IDENTIFIER`, stable across versions);
  - a `title` (≤ 200);
  - an `objective` and an `acceptance` (≤ 4 000 each, credential-guarded);
  - an `expectedWriteSet` (`RepoRelativePath[]`, ≤ 500, unique);
  - its `dependsOn` (unique, not itself, naming steps of the manifest,
    ≤ `ROADMAP_STEP_DEPENDS_ON_MAX` = 32).

  The serialized manifest is bounded by `ROADMAP_STEP_MANIFEST_MAX_BYTES` (1 MiB of
  UTF-8), the binding bound. The counts alone admit tens of megabytes (Fable C4).
- **`RoadmapStepDeclaration`** is a step's event payload. It carries the version id,
  `stepId`, `stepIndex`, `title`, the three digests, `dependsOn` and `dependencyRank`.
  It carries no text but the title and no version of its own.
- **`ROADMAP_WRITE_SET_PREIMAGE_PREFIX_V1`** (`acp/roadmap-write-set/v1\n`) lives in
  contracts, on `OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1`'s precedent (ADR 0078; Fable
  C6). The computation is the ledger's.
- **`RoadmapVersion`'s cohort from 2.10.0.** `stepCount`,
  `stepManifestArtifactReferenceId` and `stepManifestSha256` are required on 2.10.0
  and later, and absent on the closed list `2.2.0` … `2.9.0`, never a version
  comparison. The reference and the digest are null together, and null exactly when
  `stepCount` is 0.

`CONTRACT_VERSION` moves from 2.9.0 to **2.10.0**. The move pays both classes:

- a cohort by version, decision 41's class;
- identities the door recomputes rather than believes, ADR 0076's class (the step
  digests, the rank, the manifest digest).

`SUPPORTED_CONTRACT_VERSIONS` grows from eight to nine, keeping `"2.9.0"` for ever.
`LEDGER_CONTRACT_VERSION` follows by derivation. `CONTRACTS_SCHEMA_EXPORTS` moves
from 172 to 178.

### Two — the bump's three acts (decision 173; Fable C1)

1. **The version in force at both initiative doors, for a new insertion, with an exact
   replay exempt.** `appendInitiativeEvent` and `appendInitiativeBatch` refuse
   `event.contractVersion !== CONTRACT_VERSION` after the replay short-circuit, in the
   task door's words. The P-18/C record left this pin "to the escalón that owns its
   stream's producer". B is that escalón.
2. **A roadmap payload's version is its event's.** `#assertRoadmapVersionGranted`
   refuses `payload.contractVersion !== event.contractVersion` as `REQUEST_INVALID` at
   `candidate.contractVersion`. Without it, a new 2.10.0 event could carry a payload
   stamped 2.9.0 with no step field and pass the cohort as the old shape.
3. **P-P18-2 for the initiative stream.** Take a ledger whose initiative history is
   2.9.0 end to end, with registrations and roadmap versions, and rewind it to
   migration 24. Under 2.10.0 it:
   - opens;
   - migrates to 25, with each version's recording version and step fields backfilled
     from its own event through the fold's own function;
   - reads, verifies and rebuilds to identical rows;
   - takes new 2.10.0 work on top.

The three contract shapes held to `AdmittedContractVersion` move through the symbol.
Their literal fixtures are restamped, never re-lifted (§Evidence).

### Three — the batch door: all or none, replay judged whole (decision 174)

`appendInitiativeBatch(events)` records one `ROADMAP_VERSION_RECORDED` followed by
its `ROADMAP_STEP_DECLARED`s, in `stepIndex` order, for one initiative. The version's
`stepCount` must equal the number of steps. Everything happens in one
`BEGIN IMMEDIATE`, the task batch's mould. Any other shape is `LedgerValidationError`.

**Replay is judged for the whole batch** (Fable C5), which departs from the task
batch on purpose. There, an exact replay is a per-event no-op and the rest append.
Here:

- **Whole replay.** Every key is recorded, every stored body equals its candidate,
  and the stored rows are contiguous in the batch's own order. The answer is the
  stored records.
- **Conflict.** Some keys are recorded, or any body differs. The answer is
  **`LedgerInitiativeBatchConflictError`** (`LEDGER_INITIATIVE_BATCH_CONFLICT`,
  ledger barrel +1, the README's sixteenth error row). It carries the count of keys
  already recorded, never a body.

The rule is sound **only because L-P26B-1 makes a partial batch unwritable by any
door**. The single initiative door refuses a `ROADMAP_STEP_DECLARED` and a version
whose `stepCount` is above 0. So "some keys exist" can only mean another writer or a
torn history.

### Four — the door re-derives, and the read is not a sink (decision 175; ND-B3, Fable C7)

The door reads the version's manifest **by reference, outside the transaction**
(`readRoadmapStepManifest`, through `readByReference`). The blob is content-addressed
and immutable, and the read verifies the bytes against the reference's digest.
Inside the transaction, `#assertStepManifestReference` (the `#assertResultReference`
mould) asserts:

- the reference row is a `PLAN_DOCUMENT`;
- scoped to `INITIATIVE/<initiativeId>`;
- whose `content_sha256` is the version's `stepManifestSha256`.

Whatever bytes were read hash to that digest, so nothing between the read and the
assert can change what the events name. The one decision then judges the version and
every step against the manifest.

Declared limit, the `#assertResultReference` sentence kept: retention, tombstone and
blob lifecycle are not checked, because nothing in this build tombstones a reference
or reclaims a blob. The cost is one private-plane read per step-bearing append.

**The privacy boundary.** The door's read is a re-derivation, not a sink.
`objective`, `acceptance` and the paths reach no event, response, timeline entry or
log; only their digests do. The one text the stream persists is each step's
**title** (≤ 200, guarded), in the event and the step row. That is the class of
`initiative_read_model.title` (decision 76). B adds no read route for step rows;
that is cut C's.

L-P15F-1's list of `readByReference` callers gains the concept, and its comment
states the same boundary.

### Five — one derivation, one decision, one producer (decision 176; ND-B1, ND-B4, ND-B8, Fable C6)

**`roadmapStepDigests(manifest)`** (ledger concept `roadmap-steps`) is the one
derivation (L-P26B-2):

| Field | Derived as |
| --- | --- |
| `objectiveSha256`, `acceptanceSha256` | sha-256 of the text's UTF-8 bytes |
| `expectedWriteSetSha256` | sha-256 of the prefix plus the canonical JSON of the paths, **sorted** (order is not identity) |
| `dependencyRank` | the longest path from a step with no dependencies |

A cycle has no rank. It is `STEP_DEPENDENCY_CYCLE` at the first stepId on it in
manifest order: an identifier, never content. This follows planning §4 literally,
and the DT admitted the one planning §3 column that holds it, `dependency_rank`
(ND-B1). The spec edit is in this cut.

**`decideRoadmapVersion`** takes the batch's declarations and the manifest. After
every version law it applies five more words, so the vocabulary grows from 7 to
**12**:

- `ROLLBACK_STEPS_MISMATCH`: a rollback restores the steps with the bytes, or no
  steps on both sides;
- `STEP_COUNT_MISMATCH`;
- `STEP_DECLARATION_INVALID`: parse before compare; wrong index; repeated id; a
  dependency the batch does not declare;
- `STEP_DEPENDENCY_CYCLE`;
- `STEP_DIGEST_MISMATCH`: covers every derived field, the rank and the dependencies.

The gateway's list widens by spread.

**`recordRoadmapRevision`** is the one producer of both paths. It works in this
order:

1. publish the document;
2. fold;
3. derive and decide, **before** the manifest is published, so a refused revision
   (a cycle) publishes no manifest;
4. publish the manifest as `PLAN_DOCUMENT` / `INTERNAL` / scope `INITIATIVE`, in the
   registration's mould;
5. append through the single door with `stepCount` 0, or through the batch door.

It is not named `recordRoadmapVersion`, which the gateway already exports (ND-B8).

**Who mints what.** The gateway's roadmap route mints every identity and reads the
instant and the pid:
- the version's id and its event's;
- for a request with steps, the registration route's set (`commandId`,
  `artifactPinId`, `artifactReferenceId`, `intentionEventId`, `terminalEventId`,
  `holderPid: process.pid`, a lease store incarnation) and one `randomUUID()` per step
  event.

Neither the seam nor the producer can. Both are under the house determinism laws (no
clock, pid or random source), so the same inputs build the same events and a retry
is idempotent at the ledger's own keys. No identity is derived in the ledger (DT
ruling). The route builds the response's version field by field, the two new fields
included, because a strict DTO refuses a spread. The
gateway seam is now a thin caller that keeps its error mapping. A.'s one `instanceof`
branch extends to `LedgerInitiativeBatchConflictError`: one branch, a lost race,
`WRITE_CONFLICT`.

### Six — migration 25 `roadmap_steps`, and the fold (decision 177; Fable C2, C3)

`roadmap_version_read_model` gains four columns with CHECKs:

- `recording_contract_version`;
- `step_count`, 0..200;
- `step_manifest_artifact_reference_id`;
- `step_manifest_sha256`, with its shape checked.

Three more CHECKs span the columns: the reference and the digest are both null or both
set, a digest implies `step_count > 0`, and a `step_count` above 0 implies a digest
(Fable C-B1). Two cohort triggers key on the closed list
of the eight prior versions. Their first statement catches a NULL version, in
migration 22's wording.

The step tables follow planning §3–§4:

- `roadmap_step_read_model`: PK `(roadmap_version_id, step_id)`, a unique index on
  `(roadmap_version_id, step_index)`, `dependency_rank`, and `state` spelled
  `IS NOT NULL AND … IN (…six…)`;
- `roadmap_step_dependency`: PK over three columns, two FKs onto the step PK, and
  `ck_…__no_self`;
- two watermarks, seeded at the initiative head with the head event's own instant.

The backfill writes each existing version's cohort from its own event through
`nextRoadmapVersionProjection`.

The fold works from payloads only and never reopens the blob. A step dependency row
is written once every step of its version is folded, because the manifest order is
not a topological order (a cycle is possible at all only because of that). The fold
refuses, by the door's words:

- an unknown version;
- an index out of order;
- a repeated id;
- a step past its count;
- a dependency on an undeclared step.

A version whose steps stop short is refused once the stream is folded. `state` is
`DECLARED` and `routing_assignment_version` NULL always. L-P26A-1 extends
insert-only to the step rows.

Pins that move with the new table family:

| Pin | Change |
| --- | --- |
| `MIGRATIONS` | 24 → 25 |
| `tr_` | 13 → 15 |
| `DERIVED_TABLES` | +2, children first, both before the version table |
| `INITIATIVE_PROJECTION_NAMES` | +2 |
| `PROJECTION_SOURCES` | 26 → 28 |
| `status().projections` | 25 → 27 |
| watermark rows | 26 → 28 |
| `EXPECTED_SCHEMA_OBJECTS` | +7 |

Every migration after this one owes an undo, in its CHECK order, to the three
rewinds ADR 0110 named: the ledger suite's `drop…` chain (`dropRoadmapSteps` first
in `dropRoadmapVersionUniqueness`), `cli/test/cli` and `gateway/test/build-server`.

### Seven — the API, 0.19.0 → 0.20.0 (decision 177; Fable C4, C5)

- `InitiativeEventTypeDto` widens by derivation.
- `RoadmapVersionWriteRequest` gains an optional `steps`, the contract's manifest.
- `RoadmapVersionDto` gains `stepCount` (null for a version recorded before steps) and
  `stepManifestSha256`. It never gains the reference id or a step's text.
- The write route's transport limit becomes
  `ROADMAP_CONTENT_MAX_BYTES + ROADMAP_STEP_MANIFEST_MAX_BYTES +
  ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES` (2 MiB + 64 KiB). A document at its ceiling
  and a manifest beside it otherwise overflow the envelope allowance. This is a
  measured API-limit change, recorded in `docs/api-reference.md`. One byte past it is
the transport's refusal, which the plane answers as it answers every framework error:
`400` with `FST_ERR_CTP_BODY_TOO_LARGE` in `detail`. That is measured; the map said
413.

**The console.** The console's `edit-roadmap-dialog` never sends `steps`, so its own
requests never receive a B word. An API caller that does can: the producer's own
decision refuses a cycle before any door, as `WRITE_REFUSED` with the word in the
message. The console's `DECISION_REFUSAL_NAMES` is G-UI's to widen when a steps UI
opens. Its timeline view special-cases only `ROADMAP_VERSION_RECORDED`, so a step
renders "Active → Active". This is declared under G-UI and not fixed. No console
source is edited.

## Evidence

The gateway rows run through the real route, against a real ledger, blob lease
store and private plane:

- **S1.** Three steps (A→B, A→C) answer 200 with `stepCount` 3 and the manifest's
  digest. The events are one version and three steps, contiguous and in order, with
  ranks 0/1/1 and two dependency rows. No private text appears in the response or in
  any `event_json`. The timeline parses under 0.20.0 with three step entries.
- **S2.** A stepless v2 counts 0 and names no manifest, and v1's steps are untouched.
- **S3.** A cycle answers 409 `WRITE_REFUSED` with `STEP_DEPENDENCY_CYCLE`, and
  nothing is appended.
- **S4, measured against the map.** A self-edge, an unknown dependency and a repeated
  stepId answer **400** at the field. The request parses the contract's manifest
  whole, and the manifest refuses these three itself. `STEP_DECLARATION_INVALID` is
  the door's word for a raw batch.
- **S5 and S5b.** A rollback with another manifest, or with steps onto a stepless
  version, is `ROLLBACK_STEPS_MISMATCH`. A plain rollback to the stepless version is
  recorded with a null pair. A rollback to v1 carrying v1's manifest re-declares v1's
  steps.
- **S6.** The exact batch again writes nothing.
- **S7.** A stale fold meets a batch that landed first under the same key. The seam
  answers `WRITE_CONFLICT` through A's extended branch.
- **S8.** A 2.9.0 history rewound to 24 migrates, verifies and rebuilds. The route
  serves it with `stepCount` null and takes a three-step v2 on top.
- **S9, measured against the map.** A body at the new limit is admitted. One byte
  over is the transport's refusal, which the plane answers as **400** with
  `FST_ERR_CTP_BODY_TOO_LARGE`; the map said 413.

The ledger drills:

- **The derivation**, against node:crypto: the texts' bytes and the sorted write set
  under the prefix. The rank across a forward reference and a chain. A cycle named at
  its first member. The manifest's digest independent of key order.
- **The producer:**
  - one contiguous batch, with ranks 0/1/1, two dependency rows, and the reference
    a `PLAN_DOCUMENT` of the initiative that reads back whole;
  - no objective, acceptance or path in any `event_json`, and every title present;
  - a stepless version through the single door;
  - a cycle refused with nothing published or appended;
  - a rollback re-declaring its steps, and `ROLLBACK_STEPS_MISMATCH`.
- **The batch door:**
  - a whole replay writes nothing;
  - a partial replay (3 of 4 keys) and a byte-different replay are one conflict;
  - four shape refusals;
  - a raw batch that re-derives is granted, and each tampered digest, rank and title
    is `STEP_DIGEST_MISMATCH` by field;
  - an unknown, foreign-scoped or other-digest reference is refused;
  - the single door is fed a step and a counting version;
  - acts 1 and 2 at the batch door;
  - a rebuild twice gives identical rows.
- **The acts:** act 1 at the single door, with the stored 2.9.0 replay exempt; act 2;
  act 3 (P-P18-2).
- **Rebuild refusals:** a planted orphan step and a planted short version refuse the
  rebuild by name, and the check reports the short version as a problem.
- **The decision's step laws**, one example per word and their order.
- **Migration 25:**
  - its text: the closed list spelled four times, children-first clearing;
  - the cohort on the INSERT and UPDATE paths over 144 cells each, against an oracle
    written from this rule;
  - one NULL per predicate of the step table, the unique index and the no-self
    CHECK.

The base holds both directions of "a manifest exactly with steps", as the contract and
the door do: a digest needs a count above 0, and a count above 0 needs a digest (the
second added by the post-audit, Fable C-B1, before the migration landed).

**Restamp, never re-lift.** The contract's version pins move to 2.10.0 through the
symbol wherever the test means "the version in force". The literals that meant it
were rewritten, and the ones that meant a particular version were left alone. A
literal "2.10.0" that stood for "a version this build does not read" became
"2.11.0". The envelope identity's three pinned vectors, whose envelope carries the
version, were **recomputed** from a copy of the fixture outside the suite, by
`envelopeSha256` and by node:crypto over the preimage. The two agree on all three.
Every restamped literal:

| Site | Old → new | How |
| --- | --- | --- |
| contracts `CONTRACT_VERSION`; the supported set | "2.9.0" → "2.10.0"; + "2.10.0" | the bump |
| protocol `API_CONTRACT_VERSION` | "0.19.0" → "0.20.0" | the bump |
| `ledger/test/envelope-identity`, three vectors | `9bdea2fa…f4a9` → `08e07650…b7c0`; `9d28fabc…55d2` → `0fac75bb…9169`; `e56d454e…05f3` → `0ca58d12…be45` | fixture version "2.9.0" → "2.10.0"; recomputed outside the suite, two ways agreeing |
| `daemon/test/drills/execution` `D4_V1_TRAIL_SHA256` | `f61ca58b…ed93` → `b11912ea…a346` | recomputed by its recorded method: `git archive be3b06f` with the c1bb414 test reproduced the old value (control), and with only the version literal moved gave the new one, which the current tree also gives |
| `ledger/test/ledger` N-P18-19; `contracts/test` two sites | "2.10.0" → "2.11.0" | a version this build does not read |
| `expect(CONTRACT_VERSION).toBe(…)`: `contracts/test` ×6, `ledger/test/ledger` ×6, `runtime/test/core/events` ×2 | "2.9.0" → "2.10.0" | the version in force |
| supported-set lists: `contracts/test` ×7, `ledger/test/ledger` ×2 | + "2.10.0" | — |
| `contracts/test` admission | "2.9.0" admitted → "2.10.0" admitted; "2.9.0" refused | — |
| `protocol/test` `LEDGER_CONTRACT_VERSION` | "2.9.0" → "2.10.0" | — |
| API version literals: `protocol/test` ×7, `cli/test/cli`, `cli/test/tool-call`, `gateway/test/tool-calls` | "0.19.0" → "0.20.0" | — |
| `ledger/test/ledger` PC-C2 dispatch row; `runtime/test/core/step-executor` dispatch version | "2.9.0" → "2.10.0" | the version in force, as a literal |
| cohort fixtures in the ledger, contracts, runtime and gateway suites | + `stepCount: 0` and a null manifest pair | no digest involved |
| DTO fixtures: protocol ×2, console ×4 sites in 3 files | + `stepCount: 0, stepManifestSha256: null` | no digest involved |
| migration count pins | 24 → 25, `tr_` 13 → 15, watermarks 26 → 28, projections 25 → 27 | — |

No other pinned 64-hex literal went red.

## Why the alternatives were not chosen

- **Steps inside the version's payload.** A payload holds 8 KiB, and a step's texts
  are private. The digests fit and the texts do not, which is why the texts live in
  the manifest.
- **A topological-order digest on the version** (map v1). That moves planning §4's
  placement. The per-step rank follows it literally.
- **Per-event replay in the batch door.** It would admit a torn history as a partial
  retry. A partial batch is unwritable by construction, so a partial replay is a
  conflict.
- **Two producers**, the seam keeping A's stepless composition beside a ledger
  producer for steps. Two compositions of one act drift.
- **The door trusting the declared digests.** That makes the manifest decorative.
  The door re-derives.

## Consequences

The pins that move:

| Pin | Change |
| --- | --- |
| `CONTRACT_VERSION` | 2.9.0 → 2.10.0 |
| `SUPPORTED_CONTRACT_VERSIONS` | 8 → 9 |
| `API_CONTRACT_VERSION` | 0.19.0 → 0.20.0 |
| `INITIATIVE_EVENT_TYPES` | 3 → 4 |
| `MIGRATIONS` | 24 → 25 |
| `ROADMAP_VERSION_REFUSALS` | 7 → 12 |
| `CONTRACTS_SCHEMA_EXPORTS` | 172 → 178 |
| `PATH_SCOPED_LAWS` | 163 → 165 |
| ledger barrel | +1 error class, +2 functions |

A real operator ledger at 24 migrates to 25 only with the owner's authorization
(A's ND-4). A manifest published for a refused batch after publication, a race lost
at the door, stays published and unreferenced until P-36's collector (ND-B7).

## Not in this record

- **Cut C:** A10, the diff by `stepId`, and a read route for step rows.
- **P-27:** step state transitions.
- **P-28:** STEP routing.
- **G-UI:** a steps UI, the timeline's rendering and the console's refusal list.
- **P-36:** reclaiming an orphan manifest.
