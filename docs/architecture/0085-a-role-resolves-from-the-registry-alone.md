# ADR 0085 — A role resolves from the registry alone, or not at all

- Status: accepted (P-14 escalón A, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.
- Amends: the comment on `nextRoutingAssignmentProjection`
  (`packages/persistence/ledger/src/projection/index.ts`), whose second half said
  the fail-closed check on `model_version_id` belongs to another module's gate
  because "`model_version_read_model` does not exist" — the table exists now, and
  the ledger's append door makes the check. The ledger README's matching bullet
  ("The fold validates no eligibility") is amended in the same way. Precision for
  `docs/audit/architecture/database/index.md` `:236-237` ("`registry_events` …
  no decide elegibilidad"): the stream still decides nothing; its **door** makes
  two typed lookups over read models of the same stream, by name, as decision 68
  made the door look up a `TASK_ENVELOPE` reference. The header comment of
  migration 8 ("Nothing … validates a `model_version_id` against anything") is
  history and stays as written. No earlier record's decision changes.

## Context

Accounts §6 moves the one registry of model versions into `accounts`, as three
tables folded from the registry stream's `MODEL_VERSION` documents. Planning §6
says a routing assignment names a `model_version_id` "validado fail-closed contra
`model_version_read_model.status = 'ACTIVE'` … comprobación tipada, no FK física",
and contracts §5 (`:255-258`) that an unknown, retired, role-ineligible or
transport-inadmissible version refuses the edit with its reason, and a retired one
blocks and proposes migration. Resolution is made against a vector of watermarks,
never against "the latest" (`:249-253`).

At `e2924a4` the registry stream carried `MODEL_VERSION` and
`ROUTING_ASSIGNMENT_GLOBAL` since migration 9 and folded the second into
`routing_assignment_read_model`; nothing folded the first, and the eligibility a
role was resolved against lived in `policy/capability-policy.json`, a registry of
facto beside the one the dictionary names (P-14 map, E3/E5; adjudication Q5).

The P-14 map cut the packet A → B → C. This is A: the registry, the gate, the
reading and the resolver, and no product door. The Fable preaudit of the writer's
brief (ACCEPT_WITH_CORRECTIONS) found three things the brief did not decide, and
the DT ruled each before a line moved:

- **Where the gate lives** (H-1). The ledger may not import `@acp/accounts` and
  `@acp/accounts` may not import `@acp/ledger` (`LEDGER_ALLOWED_PACKAGES`,
  `ACCOUNTS_ALLOWED_PACKAGES`), and the registry door has no production producer
  yet. A gate only in accounts would make "nothing appended" depend on a future
  caller remembering to call it; a gate only in the ledger would put transport and
  time, which the door cannot see, nowhere.
- **Transport** (H-2). A `ROUTING_ASSIGNMENT_GLOBAL` payload names `role, slot,
  provider, modelVersionId, fallbacks` and no transport; planning §6 has no
  transport column. "Not admitted for the transport" cannot be checked at the
  door without widening the payload, which is new design.
- **The payload of `MODEL_VERSION`** (M-5). Nothing spelled it. The fold that
  reads it is the first reader, and a tolerant fold over an unreadable RETIRE
  would leave an ACTIVE row standing.

## Decision

**One — two layers, on decision 68's precedent.** The **door** of the ledger
(`#appendRegistryInTransaction`, after the replay, event-id and lineage checks and
before the insert) refuses a `ROUTING_ASSIGNMENT_GLOBAL` whose `modelVersionId`
does not name an `ACTIVE` row of `model_version_read_model`, or whose `role` is not
among that row's eligible roles. The **resolver** in `@acp/accounts`
(`src/assignment/index.ts`) decides what the door cannot see: transport admission,
with the transport handed in by the caller, and a version retired **after** its
assignment was admitted. Both are typed lookups by name; neither scores nor
chooses.

**Two — the door's refusals, by word and path.** `LedgerValidationError`, no new
error class (the fourteen stand), each issue's path the `at` and a closed word at
the head of its message:

| Word | Path | Meaning |
| --- | --- | --- |
| `MODEL_VERSION_UNKNOWN` | `payload.modelVersionId` | no row with that id |
| `MODEL_VERSION_RETIRED` | `payload.modelVersionId` | blocks; the message proposes migrating the assignment to an ACTIVE version (no successor column exists, so it names what to do, never which version) |
| `MODEL_VERSION_DEPRECATED` | `payload.modelVersionId` | refused, because planning §6 admits `ACTIVE` only; no proposal |
| `ROLE_NOT_ELIGIBLE` | `payload.role` | the version does not declare the role |

Each fallback is held to the same rule, at `payload.fallbacks[i]` (contracts §5
does not distinguish a fallback from the version it backs), including the role: a
fallback that does not admit the role is refused at the fallback's own path. An
assignment the fold could not read — a role outside the vocabulary, a negative
slot, an empty provider or version, fallbacks that are not strings — is refused
field by field before any lookup: an assignment the fold would project no row for
is not one the door admits. No value is echoed.

**Three — the `MODEL_VERSION` payload is fixed, and the door holds it.** Nine keys,
the camelCase mirror of accounts §6, each required and no other admitted:
`provider`, `model`, `release`, `status` (`ACTIVE`/`DEPRECATED`/`RETIRED`),
`contextTokens` (integer ≥ 0), `policyVersion`, `deprecatedAt` (null if and only if
`ACTIVE`, else an ISO-8601 instant), `eligibleRoles` (distinct worker roles) and
`transports` (distinct words of the contract's `TRANSPORT_KINDS`).
`latest_performance_window` is not read: its column stays `NULL`, because the
snapshot it references is economy's. The set is closed so a rating or a price
cannot be parked in the capability registry under a name nobody reads — the
"no duplica ratings" of database §4. `MODEL_VERSION_PAYLOAD_KEYS` and
`MODEL_VERSION_STATUSES` are exported beside `DOCUMENT_KINDS`, for its reason.

**Four — order.** Replay, then event id, then lineage, then these checks, then
causation, then the insert. An exact replay of an assignment admitted before its
version was retired is a replay (`inserted: false`), and another body under its key
is `LedgerIdempotencyConflictError`, neither of them consulting the gate.

**Five — the fold stays total.** `nextModelVersionProjection` refuses nothing: a
rebuild folds history the door accepted, and an assignment whose model was retired
afterwards is folded as it was recorded. One row per `model_version_id`, written by
the version applied last in stream order (the dictionary's `document_version` is
"the last version projected"); its children are replaced whole with it. A version
the fold cannot read — only history written before migration 17 can hold one —
yields **no row**, and removes the row an earlier version left: a version the
registry holds and nobody can read is not a version that rules, and an ACTIVE row
surviving it is the danger M-5 named. The door, the rebuild and migration 17's
retroactive fold write through one function.

**Six — migration 17.** Three `STRICT` tables with the dictionary's constraints
under the §3.2 names, `ix_model_version_read_model__status`, the two `ux_` indexes
of §6.1, foreign keys only from each child to its parent (none into
`registry_events`, none into the routing tables), no trigger, and one watermark
seeded from the registry head in migration 15's form. Because the stream may
already hold `MODEL_VERSION` documents and SQL cannot run the fold, the ledger folds
them in the same transaction (`afterSql`, migration 10's precedent) through the fold
above; a failure applies nothing. `MODEL_VERSION_REGISTRY_MIGRATION = 17`.

**Seven — reading with the vector.** Two read-only verbs, each executing entirely
inside one deferred `this.#db.transaction(...)()` — a read transaction, legal on a
`query_only` handle, whose snapshot is fixed by its first read — with no clock, no
file and no append:

- `getGlobalRoutingAssignment({ role, slot })` →
  `{ assignment, fallbacks, modelVersion: { row, eligibleRoles, transports } | null,
  watermarks }`, where `watermarks` are the three rows the answer was read at:
  `model_version_read_model`@registry, and both heads of the routing projection.
  No assignment in force is `assignment: null` with the vector all the same, because
  "nothing was assigned at this vector" is the fact a refusal records. Two
  assignments in force for one `(role, slot)` — two documents, or two branches of
  one — is refused with `LedgerQueryError` rather than settled by picking one.
- `getModelVersion(modelVersionId)` → `{ modelVersion, watermarks }`, with the one
  watermark row of the registry.

If the registry moves between a read and a decision, the caller holds the vector it
read; a later read shows the head one position on (N-P14-3). Planning §6's rebuild
rule — both chains at a fixed vector, refused if either is broken — is already
`rebuildReadModel`'s, which verifies head, digest and count on all three streams
before it clears a row; nothing new was built for it.

**Eight — the resolver.** `resolveAssignment(request, reading)` in `@acp/accounts`
is pure: no clock, no I/O, no import but `@acp/contracts`. Its input is structural
— this package's own types, which the caller of escalón C maps from the ledger's
reading. It refuses, each with a path and never a value: a request outside the
vocabularies; a reading with no vector, or describing another coordinate or
version; `ASSIGNMENT_ABSENT` (no default, no fallback to the policy file,
N-P14-2); `MODEL_VERSION_UNKNOWN`; `MODEL_VERSION_RETIRED` with the proposal
`MIGRATE_TO_ACTIVE_MODEL_VERSION` (never a silent move to a fallback);
`MODEL_VERSION_DEPRECATED`; `ROLE_NOT_ELIGIBLE`; `TRANSPORT_NOT_ADMITTED`; and
`ASSIGNMENT_PROVIDER_MISMATCH` when the assignment and the version it names
disagree about the provider. Every outcome carries the vector. The resolution
carries the version's identity and the fallbacks; it does **not** carry the
version's `policyVersion`, because restriction 6 of the capability registry keeps
every read of a policy version inside the policy module, and whether the
registry's `policy_version` becomes the version a route stamps is the convergence
P-28 and P-19 own. `resolveRoute` and `policy/capability-policy.json` are untouched
and stay the legacy path (Q5).

## Consequences

- `MIGRATIONS` 16 → 17. `EXPECTED_SCHEMA_OBJECTS` gains three tables and three
  indexes; the `tr_` inventory stays 9. `DERIVED_TABLES` gains the three tables,
  children first. `REGISTRY_PROJECTION_NAMES` 4 → 5 and `PROJECTION_SOURCES` gains
  one pair (18 → 19), which reaches `WATERMARK_KEYS`, `status()` (18 projections, 19
  heads) and `verifyIntegrity`, which compares the three tables row for row against
  a replay. `RebuildResult` gains three counts.
- `PROJECTOR_VERSION` stays 1: a fold was added, none changed. `CONTRACT_VERSION`
  stays `2.5.0`, `CONTRACTS_SCHEMA_EXPORTS` and `API_CONTRACT_VERSION` do not move:
  the document vocabulary lives in the ledger, nothing in `@acp/contracts` changes,
  and no product door lands (ADR 0076's criterion adds no way of computing
  identity; decision 41's adds no cohort).
- `ACCOUNTS_PUBLIC_EXPORTS` 85 → 97: `resolveAssignment`, `ASSIGNMENT_REFUSALS` and
  ten types. No law is coined, so `PATH_SCOPED_LAWS` does not move; the resolver's
  purity and its imports are held by its suite and by the accounts import law that
  already refuses `@acp/ledger`.
- Every test that records a GLOBAL assignment registers its model versions first,
  and the registry sequences it asserts move by the documents it registers. The six
  `MODEL_VERSION` fixtures written with `payload: {}` carry the fixed payload.
- Every rewind past 17 drops its two children and their indexes, the parent and
  its index, and its watermark row, before undoing 16. The CLI and gateway rewinds
  do, and assert that the re-applied 17 folds the document back into the same rows.
- A writer that bypasses the door can still record an assignment naming a retired
  version; the resolver refuses it at resolution, and the fold keeps it as history.

## Not in this record

Any product door — a CLI verb or a gateway route that publishes a `MODEL_VERSION`
or an assignment (B/C, under L-B4B-11), and the task intake that records a
resolution with its vector (C). The `INITIATIVE` and `STEP` partitions and
`ROUTING_ASSIGNMENT_RECORDED` (P-28, Q4). Precedence across scopes and override
ceilings (P-28). A lifecycle rule between versions (whether a RETIRED version may
become ACTIVE again) and a check that a document's provider is stable across its
versions: neither is dictated, and neither is invented here. The convergence of
the policy file with this registry (P-28/P-19).
