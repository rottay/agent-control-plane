# ADR 0087 — A task enters once by its client's key, with its revision and its envelope by reference

- Status: accepted (P-14 escalón C, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.
- Amends: execution §1 (`task_read_model`), whose `step_id`, `role` and
  `commit_policy` rows said "sin productor todavía" and "nadie inventa una clave de
  payload para llenarla" — the intake door is their producer now, through named
  payload keys, and §1.1 gives the client key its home. It names, without editing it,
  the amendment ADR 0080 §4 receives when P-15 lands (Decision Ten). No earlier
  record's decision changes.

## Context

Contracts §5 (`:153-169`) gives the request link its preconditions — a strict
envelope, an initiative that exists, the roadmap revision and step when the task
belongs to one, a role with a resolved assignment — its three refusals and its rule
of idempotency; contracts §15 (`:599-616`) gives that rule its key,
`UNIQUE(client_scope, client_request_key)`, with the envelope digest as a compared
precondition and never part of the key. At `f7cd466` no dictionary gave the pair a
home for tasks, and nothing entered a task: a task was a hand-written daemon config
plus `acp submission`, which opens nothing and writes nothing, plus the daemon's
start.

The P-14 map cut the packet A → B → C and the DT adjudicated Q1-Q5: the client key
lives in one insert-only row folded from the event that opens the task (Q1); the
intake publishes the envelope to the private plane and links its reference (Q2); the
minimum "generates work" is a durable intake — `DISCOVERED`, revision 1, the
resolution recorded — observable by the existing task reads, and nothing executes it
(Q3); only `GLOBAL` assignments (Q4); and the new door resolves from the registry
alone (Q5). A (`1418e58`) landed the registry and the resolver; B (`f7cd466`) the shape
of a door pair. The Fable preaudit of the writer's brief (ACCEPT_WITH_CORRECTIONS,
H-1..H-5, M-6..M-9, L-10) and the DT's rulings on it fixed what the brief left open:
a migration and a named table (H-1); the roadmap step as declared debt (H-2); where
the non-envelope fields live (H-3); the event's type, transition and coordinate (H-4);
the write-set (H-5); the envelope's publication (M-6); the refusal map (M-7); the
version, verb and wire pair (M-8); and the named race refusal and the fence law (M-9).

## Decision

**One — one orchestration, two doors, in the runtime.** `intakeTask` in
`packages/domains/runtime/src/intake/index.ts` is the only code that decides, resolves,
publishes and appends an intake. It receives a writable ledger, the private plane, the
request fields, the recording instant, the holder's pid and every identifier, and
opens nothing and reads no clock. It lives in `@acp/runtime` and not beside B's
registration in `@acp/ledger` for one import: the role resolves through
`resolveAssignment`, which is `@acp/accounts`', and the ledger may not import
accounts. The gateway's seam (`src/task-intake`) and the CLI's verb (`src/intake`) open
the ledger, `openArtifactBlobLeaseStore` and `openArtifactPlane`, mint the identifiers
— never the client key and never the task id, which are the caller's — and map the
outcome. `@acp/runtime` exports `intakeTask`, `TASK_INTAKE_WRITE_REFUSALS` and six types.

**Two — the request travels beside the envelope, never inside it (H-3).** The request
is `{ envelope, clientScope, clientRequestKey, roadmapVersionId, stepId, role, slot,
transportKind, recordedBy }`. The envelope is `TaskEnvelope`, parsed whole; everything
that is not the work stays out of it, because a field inside would enter the envelope's
identity preimage and move every pinned digest and `CONTRACT_VERSION`.
`@acp/contracts` is not touched and `CONTRACT_VERSION` stays `2.5.0`. The digest is
the orchestration's computation — `envelopeSha256(TaskEnvelope.parse(value))` from
`@acp/ledger` — and never a value a caller declares. The client key's grammar is
`TASK_CLIENT_KEY_PATTERN`, ASCII of at most two hundred characters with no space;
`@acp/protocol` restates it.

**Three — the client key's one home: migration 19 (Q1, H-1).** `task_submission`
creates `task_submission_read_model` `STRICT`: `client_scope`, `client_request_key`,
`task_id`, `revision_number`, `envelope_sha256`, `sequence`, `created_at`, with
`ux_task_submission_read_model__request UNIQUE (client_scope, client_request_key)` and
checks on non-empty halves, a revision of at least one, a lowercase sha-256 and a
positive sequence. No trigger and no foreign key: it is derived, a rebuild clears it,
and the task it names is born by the same event. One watermark is seeded at the task
head, and because a stream may already hold an intake the ledger folds the task stream
again in the same transaction (`afterSql`, migration 17's precedent), writing the key
rows and the three task columns and nothing else. It is in `DERIVED_TABLES`,
`PROJECTION_NAMES`, `PROJECTION_SOURCES` and `EXPECTED_SCHEMA_OBJECTS`;
`status().projections` goes 18 → 19 and the watermark rows 19 → 20.

The row is **insert-only, by the fold**: `nextTaskSubmissionProjection` reads the
task, revision number and envelope digest from the same revision record the revision
row comes from, so the two rows cannot name two envelopes. The same key naming the same
task, revision and envelope is a replay that writes nothing; the same key naming
anything else is refused by `assertSameTaskSubmission` with
`LedgerIdempotencyConflictError` — by name, never a `SqliteError`, and never
`ON CONFLICT DO UPDATE` — in the append door and in `applyEventToSnapshot` alike. The
client key is the request link's idempotency key, so its refusal is that class, and no
error class is added. `verifyIntegrity` compares the rows as an exact set in both
directions. The read verb is `getTaskSubmission(clientScope, clientRequestKey)`.
`TASK_SUBMISSION_MIGRATION = 19`; `LEDGER_CONTRACT_VERSION` does not move.

**Four — the intake event (H-4).** One `TASK_DISCOVERED` — the vocabulary stays at
thirty-three — with `fromState: null`, `toState: DISCOVERED`, and its own transition,
`TASK_INTAKE_TRANSITION_ID = "intake"`, never `discovered`: the daemon's walk writes
its discovery under that name with a submission digest P-15's continuity expects to
find, and an intake under the same name would be a discovery that carries none. The
payload carries a revision record, so it keys V2 at revision 1, attempt 1:
`v2/control_plane_events/<taskId>/1/1/intake`, flat `attempt: 1`. `causationId` and
`correlationId` are null; `emittedBy` is the request's `recordedBy`; `occurredAt` and
`recordedAt` are the door's instant.

The payload is closed, `TASK_INTAKE_PAYLOAD_KEYS`: the revision record —
`revisionId`, `revisionNumber`, `attemptNumber`, `envelopeSha256`,
`restoredFromRevisionId: null`, `envelopeArtifactReferenceId` — then `initiativeId`,
the attribution the fold already reads from this type; `clientScope`,
`clientRequestKey`, `roadmapVersionId`, `stepId`, `role`, `commitPolicy` (the
envelope's); and `resolution`, `TASK_INTAKE_RESOLUTION_KEYS`: `assignmentId`,
`assignmentVersion`, `slot`, `modelVersionId`, `provider`, `model`, `release`,
`transportKind` and `watermarks`, the vector read. `slot` is in the resolution because
a second submission under the same key with another slot must be a conflict and the
recorded intake is the only place it could be compared. With three watermarks the
payload is well inside `EVENT_PAYLOAD_MAX_BYTES`. The envelope is not in it.

`taskIntakePayloadOf` is the fold's reading, total, on B's precedent: a
`TASK_DISCOVERED` from no state under `intake` whose payload carries every key in its
shape and no other — a roadmap link present on both halves or on neither, a role and a
commit policy of the contract's vocabularies, a non-empty vector — or not an intake at
all, folding exactly as before. `nextTaskProjection` writes `step_id`, `role` and
`commit_policy` from it once and carries them on every later event; `TaskReadModel`
gains `stepId`, `role` and `commitPolicy`. The revision row is folded by presence as
it always was, and the append door checks its envelope reference as it always did.

Declared, for execution §1: the task's `latest_attempt_number` is 1 while
`task_attempt_read_model` has no row, since the attempt row is born only of
`TASK_ATTEMPT_OPENED`.

**Five — the producer proposes, the ledger verifies, and the order of the
preconditions (E6-E10, M-7, M-9).** The orchestration proposes revision 1 and its
identity. The ledger verifies the revision is written once, the envelope reference
exists as a `TASK_ENVELOPE`, the client key is unique and the lifecycle opens from
nothing. The orchestration refuses, in order, with `{ ok: false, reason, code, at,
proposal }`:

1. the form — producer, key halves, role, slot, transport, the roadmap link as a
   pair in both directions (N-P14-8, `ROADMAP_LINK_INCOMPLETE` at the missing half),
   the envelope (`ENVELOPE_INVALID` at its path, the credential guards included) —
   `REQUEST_INVALID`, before anything is read;
2. the key: a recorded key is compared against the envelope digest, the roadmap link,
   the step, the role, the slot and the transport, in that order; equal is a replay
   answering the rows that exist, different is `CONFLICT`/`CLIENT_KEY_CONFLICT` at
   the field — before every other precondition, so a replay answers what was recorded
   whatever the registry has become;
3. a task id another key already entered: `CONFLICT`/`TASK_ALREADY_RECORDED` at
   `envelope.taskId`, read with `getTask` before the append (M-9 a);
4. an initiative with no row: `REQUEST_INVALID`/`INITIATIVE_UNKNOWN` at
   `envelope.initiativeId` (N-P14-7) — for this door; the legacy daemon walk is
   untouched and still admits a uuid-only attribution;
5. a roadmap version that is not the initiative's: `REQUEST_INVALID`/
   `ROADMAP_VERSION_UNKNOWN` at `roadmapVersionId`;
6. a role the envelope's eligibility does not list: `REQUEST_INVALID`/
   `ROLE_NOT_IN_ENVELOPE` at `role`;
7. the resolution: `getGlobalRoutingAssignment({ role, slot })` mapped structurally
   onto `resolveAssignment`. Its code and its path are the resolver's; its class is
   `REQUEST_INVALID` for `ASSIGNMENT_REQUEST_INVALID` and `ASSIGNMENT_READING_INVALID`
   and `AUTHORITY_REFUSED` for the other seven; `MODEL_VERSION_RETIRED` carries
   `MIGRATE_TO_ACTIVE_MODEL_VERSION` to both doors. No default, no fallback, no policy
   file (N-P14-2). Two assignments in force for one `(role, slot)` stay what A made
   them, the ledger's `LedgerQueryError`, thrown rather than refused: nothing here
   picks one.

The step's existence **inside** the roadmap document is not verified: no step model
exists at `f7cd466`, and it is P-26's, named here as debt. `envelope.authority[]` is not
checked against the tree: that is preflight, P-23's. The orchestration adds the plane's
`CONTENT_REJECTED` and the lost race's `WRITE_CONFLICT`
(`TASK_INTAKE_WRITE_REFUSALS`). An append that loses a race —
`LEDGER_IDEMPOTENCY_CONFLICT`, the client key's refusal included,
`LEDGER_EVENT_ID_CONFLICT`, `LEDGER_LIFECYCLE_CONFLICT` — re-reads the key and decides
again: the same request is a replay, another is `CONFLICT`, a task another key entered
is `CONFLICT` on its id (M-9 b). A publication that loses the race does the same before
answering `WRITE_CONFLICT`.

**Six — the envelope in the private plane (Q2, M-6).** (i) The bytes are
`canonicalJsonStringify(TaskEnvelope.parse(value))` in UTF-8,
`application/json; charset=utf-8`, `PLAINTEXT`, `local-plaintext-v1`. There are two
digests and they are different things: `envelope_sha256` is the digest of
`ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1` plus those bytes, the revision's identity, and
the reference's `contentSha256` is the digest of the bytes alone, the publication's
subject. (ii) `TASK_ENVELOPE`, `INTERNAL`, scope `TASK`/`taskId`, `PERMANENT` with
`expiresAt: null`, the plane's one access policy, `producerIdentity = recordedBy`.
(iii) The intention's and terminal's keys are `taskId/envelope/<envelope_sha256>/
intended` and `…/succeeded`, derived from the revision's identity; the holding is
`recordedBy`, the door's pid, five minutes from the instant, informative. (iv) The
order is decide → publish → append, forced by the door that requires the reference
before the revision. A retry finds the intention by its derived key and reuses its
identities, and ignores the fresh ones. Accepted by name: one envelope of one task has
exactly one publication; a crash between the publication and the append leaves a
reference that names no task until a retry names it — not E11, since no event claims
work not done; a publication of the pair that ended `ABANDONED` is refused
`CONTENT_REJECTED`/`PUBLICATION_ALREADY_ABANDONED` until another decision. (v) Neither
door reads the envelope back in this escalón.

The vector a resolution records is the one read before the publication, and the
publication itself appends to the registry stream, so the recorded vector is behind
the registry head at the moment of the append by construction. That is E4's point, not
a gap: the intake records what it read.

**Seven — entering is not acquiring (E8, Q3).** The intake reads no conflict graph,
takes no lease and wakes no scheduler, and nothing executes the task it records. Two
tasks whose write-sets or conflict keys overlap both enter; the conflict is reported
at acquisition, which is the scheduler's.

**Eight — the doors, and the version (M-8).** `API_WRITE_ROUTES` gains `tasks` (5 →
6), registered through `registerGetAndPost`: the bearer is inherited — 403
`WRITE_BEARER_UNCONFIGURED`, 401 `AUTH_REQUIRED` — and the GET is the task list,
unguarded and unchanged. A body `TaskIntakeRequest` refuses, the envelope's contract
included, is 400 `BAD_REQUEST` at the field; a refused intake is 409 `WRITE_REFUSED`
whose message carries the class, the code and any proposal, and whose detail is the
`at`. `acp intake --request <path>` reads its document through `readOperatorDocument`
and takes `openForWrite`, so L-B4B-11 and `CLI_WRITABLE_OPEN_SITE` do not move. Both
doors print `TaskIntakeResponse` — `apiContractVersion`, `ledgerContractVersion`,
`replayed`, `sequence`, and the task's id, revision number and id, envelope digest and
reference, state and resolution — and neither echoes the envelope. `SURFACE_MAP` gains
`intake` → `tasks` POST, `DOCUMENT`; `submission` stays `CLI_ONLY`.
`API_CONTRACT_VERSION` `0.16.0` → `0.17.0`; `API_ALLOWED_METHODS` stays `["GET"]`, and
`API_ERROR_CODES` stays fifteen.

**Nine — L-P14C-1 (M-9, N-P14-11).** Over `packages/*/*/src/**`: no `taskId` is
assigned from `randomUUID(`, and an event under the intake transition —
`transitionId: TASK_INTAKE_TRANSITION_ID` or the literal — is built in exactly one
module, the orchestration's. `PATH_SCOPED_LAWS` 139 → 140.

**Ten — the amendment ADR 0080 §4 inherits.** ADR 0080 §4 makes the attempt's opening
the first event of a task, from `null` to `DISCOVERED`. For a task that entered by this
door the first event is the intake, and the task is already `DISCOVERED`: an opening
from `null` is `LedgerLifecycleConflictError`. When P-15 composes an execution for an
intake, its opening goes from `DISCOVERED`, and ADR 0080 §4 is amended then, by that
packet, in those words. Nothing in the daemon changes here.

## Consequences

- `MIGRATIONS` 18 → 19. Every rewind past 19 drops the table and its watermark first:
  the ledger's `dropTaskSubmission`, and the CLI and gateway rewinds by name.
- `@acp/ledger` exports the intake's closed vocabularies, the client key's grammar,
  `taskIntakePayloadOf` and four types; `Ledger` gains `getTaskSubmission`;
  `TaskReadModel` gains three fields. `@acp/protocol` exports the request and the
  response. `RUNTIME_PUBLIC_EXPORTS` gains eight names.
- The gateway's task list path answers POST; the read-route 405 matrices name it as a
  write route by the write table. The CLI has five writing verbs, in its banner, its
  README and its manifest.
- `API_CONTRACT_VERSION` pins move to `0.17.0`, the two tool-call suites included.
- Execution §1 names the producer of `step_id`, `role` and `commit_policy` and gains
  §1.1 for the client key.

## Not in this record

Executing an intake, and any change to the scheduler, the daemon or `acp submission`
(Q3, Q5). A read of the envelope by either door. The step's existence inside a roadmap
document (P-26). Preflight of the envelope's authority (P-23). `INITIATIVE` and `STEP`
partitions of routing (Q4, P-28). A retry of an abandoned envelope publication, and the
reconciliation of a holding a dead process left. A revision beyond the first: a new
revision is a new operation under a new key (contracts §15).
