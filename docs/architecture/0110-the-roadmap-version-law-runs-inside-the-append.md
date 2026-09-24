# ADR 0110 — The roadmap-version law runs inside the append

- Status: accepted (P-26, cut A, recorded 2026-09-24).
- Supersedes: none.
- Superseded-by: none.

## Context

Requirement A2 says: "Revisiones inmutables con autor, digest y OCC; la unicidad
`(initiative_id, version)` es una restricción, no una convención". Until this cut the
ledger met the first half and missed the rest, in four measured ways:

- **D1, optimistic concurrency lived only in the caller.** `appendInitiativeEvent`
  parsed an `InitiativeEvent`, whose payload is a record of unknowns, and never a
  `RoadmapVersion`. `decideRoadmapVersion` (ADR 0013) had one caller, the gateway seam.
  The seam folded `listRoadmapVersions` on the server's read-only handle and appended
  through a second, writable one: two transactions. Only the derived idempotency key
  `initiativeId/1/roadmap.v<N>` held the line, and only while the gateway was the sole
  producer.
- **D2, uniqueness was a convention.** Migration 4 indexes
  `roadmap_version_read_model (initiative_id, version)` with a plain index.
- **D3, an immutable row could be overwritten, at two sites.** The read model's write
  was `INSERT … ON CONFLICT (roadmap_version_id) DO UPDATE` on every column. The
  rebuild's in-memory fold, `snapshot.roadmapVersions.set(id, …)`, dropped a second
  claim on an identity before any SQL could see it.
- **D4, a malformed payload was disowned.** `nextRoadmapVersionProjection` returned
  `null` for a payload that did not parse, or that named another initiative. The event
  stood and projected no row: "an append-only log does not get to disown an event it
  accepted".

The fix belongs in the ledger door. `#appendInitiativeInTransaction` runs under
`BEGIN IMMEDIATE`, and it is the only place where the fold and the append share one
transaction.

## Decision

### One — the door decides (decision 165)

Inside `#appendInitiativeInTransaction`, for `type === "ROADMAP_VERSION_RECORDED"`
only, the door calls `decideRoadmapVersion`, the one decision function. The checks run
in this order:

1. `existingByKey`. An exact replay returns the stored record; the same key with other
   content is `LedgerIdempotencyConflictError`.
2. `existingById`, which throws `LedgerEventIdConflictError`.
3. The lifecycle contiguity guard.
4. **The roadmap decision.**
5. Causation, head, `INSERT`, projection and watermarks, all unchanged.

The door's fold is the gateway's. `head` and `knownVersions` come from
`listRoadmapVersions(event.initiativeId)` (`ORDER BY version ASC`, last is the head).
They are read inside the transaction, on the projection that the same transaction
keeps level with the stream. No second way of folding the history exists.

A payload whose `initiativeId` is a string naming another initiative is refused
before the decision runs, with `REQUEST_INVALID` at `candidate.initiativeId`. The
decision alone would not see this on a first version, where it has no head to compare
against. A missing or mistyped `initiativeId` is left to the decision's own parse
path.

A refusal throws **`LedgerRoadmapVersionRefusedError`** (`LEDGER_ROADMAP_VERSION_REFUSED`),
carrying `reason` (one of the decision's words) and `at`, never the roadmap. The class is
exported on the ledger barrel, and the barrel's error table in the ledger README gains
its row.

The interplay is exact:

- **An exact replay is never re-judged.** A head that moved after the event was
  accepted does not turn its replay into `VERSION_NOT_MONOTONIC` or `HEAD_MISMATCH`.
- **Two gateway writers on one head** build one key with different content. The key
  conflict fires before the decision, and the seam answers `WRITE_CONFLICT`, as it
  already did.
- **A producer with another key** and a non-successor version reaches the decision and
  is refused by name.

The gateway's own call stays, as the fast path. L-P26A-1 pins that the door makes the
call.

### Two — the gateway hears the door (decision 166)

`gateway/src/roadmap-write` gains one `instanceof LedgerRoadmapVersionRefusedError`
branch beside `RACE_LOST_CODES`, and it answers **`WRITE_CONFLICT` at `roadmapVersion`**.
The seam's decision and the door's are the same function. If the door refuses what the
seam's decision granted, the fold must have moved between the seam's read and its
append, so the loss is a race and the answer is 409.

The route renders every seam refusal the same way: `WRITE_REFUSED`, 409, with the word
in the message and `at` in `detail` (`routes:1128–1133`). A retry re-folds and hears
the truth, for example `HEAD_MISMATCH`. Without this branch, a race lost to another
producer, or to cut B's batch door, would be rethrown and classified as 500 `INTERNAL`.

### Three — insert-only, on both keys, in the fold (decision 167)

`assertRoadmapVersionUnfolded(version, folded)`, in the projection module, refuses:

- a `roadmapVersionId` already folded, with `VERSION_ID_REUSED` at
  `candidate.roadmapVersionId`;
- an `(initiativeId, version)` already folded, with `VERSION_NOT_MONOTONIC` at
  `candidate.version`.

The error is the door's error, and the identity is asked first. The rebuild's step,
`applyInitiativeEventToSnapshot`, asks its in-memory snapshot. The live step,
`#projectInitiativeEvent`, asks the read model inside the append's transaction. Both
use the one function.

The SQL write is now a plain `INSERT`: `#upsertRoadmapVersion` is renamed
`#insertRoadmapVersion` at the live site and the rebuild site. The named refusal is the
first line of defence. The primary key and migration 24's unique index are the second;
reaching either means a writer bypassed the fold.

The live check is where an identity held by **another** initiative is refused. The
decision folds one initiative and cannot see that claim.

`nextRoadmapVersionProjection` now **throws** the door's error for a payload that does
not parse as a `RoadmapVersion`, or that names another initiative. Its docblock is
rewritten rather than deleted. The old reason gets its successor: the door now refuses
such an event before accepting it, so the fold meets one only in a history that no
producer at this build could write. There, refusing by name is the honest answer, and
skipping it silently is not.

`verifyIntegrity()` folds through the same function. It reports that refusal as a
`PROJECTION` problem at the event's sequence rather than throwing: a check describes a
ledger, and the rebuild is what refuses it. This is a measured addition. The map named
only the rebuild, and without it, a ledger holding such an event would make the check
itself throw.

### Four — the seventh word (decision 168)

`ROADMAP_VERSION_REFUSALS` goes from six words to seven, sorted, with
**`VERSION_ID_REUSED`** at `candidate.roadmapVersionId`. The decision tests it after
the three claims about the head (monotonicity, parent, head digest) and before a
rollback's claims.

- Monotonicity comes first, so a replayed version offered under a fresh key is refused
  as the non-successor it is. G1 relies on this.
- The word catches only the version that is a successor in every other respect and
  borrows an identity the fold holds.

The gateway's `ROADMAP_WRITE_REFUSALS` widens by spread, and its test re-pins the
vocabulary at seven.

**No new word reaches a caller.** `VERSION_ID_REUSED` is unreachable from the gateway,
which mints a fresh UUID for each request. With Two, any door refusal is answered as
`WRITE_CONFLICT`, a word the API already had. The protocol, the API contract version and
the CLI are unchanged; the CLI has no roadmap verb.

The console's `DECISION_REFUSAL_NAMES` (`edit-roadmap-dialog:84–92`) enumerates:

- six of the decision's words, plus `CONTENT_REJECTED`;
- not `WRITE_CONFLICT`, measured at this cut.

So a lost race already renders there as "Refused: unknown." followed by the server's
message, both before this cut and after it. That limitation belongs to the console,
under G-UI. It is not introduced here, and no console edit is made.

### Five — migration 24 `roadmap_version_uniqueness` (decision 169)

The preflight is `assertNoDuplicateRoadmapVersions`. It runs in `beforeSql`, inside the
one migration transaction, following `assertNoDuplicateAccountVersions`' pattern. It
counts from the **stream**, not the read model: the read model's former
upsert-by-identity has already collapsed the second family.

It reads `initiative_events WHERE type = 'ROADMAP_VERSION_RECORDED'`, grouped twice by
`json_extract`:

- duplicate `(payload.initiativeId, payload.version)`;
- duplicate `payload.roadmapVersionId`.

It names up to twenty of each, as UUIDs and integers only, and throws the existing
`LedgerMigrationError`. No new error class is added.

Then `CREATE UNIQUE INDEX ux_roadmap_version_read_model__initiative_id__version ON
roadmap_version_read_model (initiative_id, version)` runs. The change is additive:

- no table is rebuilt;
- no watermark moves;
- no trigger is added;
- migration 4's plain index stays.

The index is inventoried in `EXPECTED_SCHEMA_OBJECTS`.

**What a failure does.** The preflight throws inside
`db.transaction(() => applyMigrations(...))`:

- every pending migration rolls back, and `schema_migrations` stays at 23;
- the ledger **does not open under this build**, because opening applies migrations,
  and it refuses on every open;
- the previous build still opens it.

The migration never deletes, renumbers or rewrites a version. What to do with such a
ledger is the owner's decision, in the P-08 row's words ("su resultado puede exigir
decisión del owner"): an **exception entry**, or a **quarantined ledger** (ND-4). A
history holding a malformed roadmap event refuses rebuild by name, and the same owner
decision applies (ND-5).

### Six — L-P26A-1 (decision 170)

This is a path-scoped law over `packages/persistence/ledger/src/ledger/index.ts`:

- `#appendInitiativeInTransaction` calls the door's roadmap check;
- that check calls `decideRoadmapVersion`;
- the file imports `decideRoadmapVersion` from `roadmap-version`;
- no statement that writes `roadmap_version_read_model` contains `ON CONFLICT`.

Stated limit: the law matches `INSERT INTO` and `UPDATE` only. An `INSERT OR REPLACE`,
a `REPLACE INTO` or an `INSERT OR IGNORE` on `roadmap_version_read_model` is not
matched. The fold's `assertRoadmapVersionUnfolded`, which runs before every insert,
still guards against the second claim that any of them would silently resolve.

`PATH_SCOPED_LAWS` moves from 161 to 162. Three rules are held by existing structure
rather than by new code:

- the decision module reads no ledger;
- there is one decision function;
- there is one fold order in both callers.

## Evidence

The gateway rows run through the real route against a real ledger and a real
artifact store:

- **G1.** v1 and then v2 are recorded, 200 each. The route answers 200, measured; the
  map said 201. The recorded v2 payload is then appended again by the ledger door alone,
  under a new transition id, and is refused `LEDGER_ROADMAP_VERSION_REFUSED`,
  `VERSION_NOT_MONOTONIC`. This test is spy-free.
- **G1b.** The same raw append under the route's own key, with other content, is
  refused `LEDGER_IDEMPOTENCY_CONFLICT`. No decision word appears.
- **G2.** A rollback carrying the wrong bytes is refused `ROLLBACK_DIGEST_MISMATCH`, by
  the route and by the door alike. The lawful rollback is then recorded.
- **G3.** A reader snapshot is taken, and another producer appends a raw v2 under a key
  the route never builds. The seam, whose fold is that snapshot, grants its own
  "version 2" under `roadmap.v2`. The door refuses it, the seam answers
  `WRITE_CONFLICT` at `roadmapVersion` (never a throw), the stream holds only the other
  producer's v2, and a retry through the route answers 409 `HEAD_MISMATCH`. The stale
  fold is staged by a proxy over the reader, because the route admits no injected fold.
  **The lost race's own 409 is not observed over HTTP.** The proof has two halves:
  - the seam's word, `WRITE_CONFLICT` at `roadmapVersion`, observed here;
  - the route's one rendering line for every seam refusal (409 `WRITE_REFUSED`, the
    word in the message, `routes:1128–1133`), exercised over HTTP by G2's
    `ROLLBACK_DIGEST_MISMATCH` and by this row's retry, `HEAD_MISMATCH`.

  The independent verifier also measured a real HTTP race: 20 rounds and no 500.
- **G3a.** The existing event-id race is unchanged.

The ledger drills cover:

- every decision word at the door, with zero delta;
- a lawful successor and a lawful rollback;
- the exact replay after the head moved;
- the key conflict before the decision;
- a cross-initiative identity refused by the live projection;
- each of the eleven required fields, null and then absent (22 cases, plus a control);
- each direction of the contract's three biconditionals, six in all;
- the primary key refusing a raw second row.

The rebuild drills plant raw events on a scratch file with the chain recomputed: a
duplicate identity, a duplicate number and a malformed payload are each refused by
name. A clean history rebuilds to identical rows twice.

Migration 24 is tested:

- on a fresh ledger;
- on a ledger at 23 upgraded with versions 1..3, whose rows are unchanged;
- with both duplicate families planted in the stream, each named, the ledger left at 23
  and unopenable. This is the positive control that the preflight can fail.
- with both families at once, named without their content;
- after a clean migration, where a raw duplicate `INSERT` aborts on the index. That is
  the only route to the anonymous SQLite error.

**Instants:** none are compared. Order is `sequence`.

**The per-migration restamp class.** Two integrity tests rewind a ledger past
migration 10 by hand and re-apply every later migration on reopen:

- `packages/entrypoints/cli/test/cli/index.test.ts`;
- `packages/entrypoints/gateway/test/build-server/index.test.ts`.

Each spells out the objects to drop and pins the highest applied version. Every new
migration therefore owes both files an edit: undo its objects in the rewind, and move
the pin. That includes a migration that only adds an index, as this one does; without
the drop, the re-applied `CREATE UNIQUE INDEX` aborts because the index already
exists. The same holds for the ledger suite's `drop…` helper chain. A migration's
brief should list these files up front. Here, both files drop the index, pin 24, and
assert that the index is back after the re-apply.

## Why the alternatives were not chosen

- **Keeping OCC in the caller** is advisory: two transactions cannot enforce it, and
  only a single producer made it look like enforcement.
- **A second fold inside the door** (reading the stream rather than the read model)
  would be a second opinion about the same history, and two opinions drift.
- **A new migration error class** would be a second vocabulary for one act; P-08
  already named it.
- **Mapping the door's refusal to its own word at the API** would move the API
  vocabulary for a case the seam can already name truthfully: a lost race.
- **Deduplicating in the migration** would make a migration decide which version of an
  initiative's history is true. That is the owner's decision.

## Consequences

- A2 is closed for cut A. A10 is left to cut C.
- `MIGRATIONS` 23 → 24; the ledger barrel +1; `ROADMAP_VERSION_REFUSALS` 6 → 7;
  `PATH_SCOPED_LAWS` 161 → 162.
- These do not move: `CONTRACT_VERSION` (2.9.0), `INITIATIVE_EVENT_TYPES` (3),
  `API_CONTRACT_VERSION` (0.19.0), `CONTRACTS_SCHEMA_EXPORTS`,
  `RUNTIME_PUBLIC_EXPORTS` and `tr_`.
- A real operator ledger holding a duplicate refuses to open under this build until
  the owner decides. Running migration 24 on a real ledger is an owner authorization,
  not this cut's.

## Not in this record

- **Cut B** (ND-6, ND-7): step declarations through an all-or-none initiative batch
  door, with whole-batch replay. A partial replay is a new failure family, and B's
  brief must name it. B also brings the `PLAN_DOCUMENT` manifest, `stepId` as a stable
  bounded identifier, cycles refused at the door, the `RoadmapVersion` cohort from
  2.10.0, and planning §4's cycle-result placement in B's spec edit. The fourth event
  type is B's API bump. The console rendering a step as "Active → Active" is a declared
  G-UI limitation.
- **Cut C**: A10, and the diff by `stepId`.
- Any console edit, a CLI roadmap verb, and M9 enablement.
