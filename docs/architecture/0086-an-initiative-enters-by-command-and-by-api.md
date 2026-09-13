# ADR 0086 — An initiative enters by command and by API, and its objective never touches the stream

- Status: accepted (P-14 escalón B, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.
- Amends: the docblock of `packages/entrypoints/gateway/src/initiatives/index.ts`,
  which said `objective` arrives in the registration's payload — for a registration
  of the closed payload it arrives from the private plane, by reference. The docblock
  of `InitiativeSummary` (`@acp/protocol`) keeps its wording: the field is still
  nullable for history that never carried one. The `SURFACE_MAP` entry for
  `initiativeRoadmap` POST ("the CLI … takes exactly one writable open, in the
  tool-call verb") stays literally true and is not amended. No earlier record's
  decision changes.

## Context

Requirements A1 (`:40`) and the P-14 map's E1/E2 ask for a real initiative created
by the minimal door of M2, **by command and by API**, with no seeded table, whose ids
and isolation survive a restart. Planning §1 (`:23-25`) gives
`initiative_read_model` three additive columns, `title`, `objective_sha256` and
`repository_sha256`, the last with no semantics. At `1418e58` nothing produced an
`INITIATIVE_REGISTERED` outside tests: the gateway served the initiative plane
read-only, the CLI had no verb, and the event's payload was a bounded free-form
record the gateway read with `stringOrNull`, objective included.

The P-14 map cut the packet A → B → C; adjudication Q2 ruled, for C's envelope and
by analogy here, that content goes to the private plane of P-36/local and the ledger
records its digest and reference. The Fable preaudit of the writer's brief
(ACCEPT_WITH_CORRECTIONS, H-1..H-5, M-6/M-7) and the DT's rulings on the writer's
NEEDS_DECISION (§1-§3) fixed what the brief had left open before a line moved: that
the request is not the payload (H-1); the key and what a second registration is
(H-2); that the CLI shares the tool call's writable open (H-3); the objective's
artifact class, identities, order and read back (H-4); the version bump (M-6); the
verb's name and shape (M-7); how a retry recovers a recorded publication (§3.a); the
holding and a dead holder (§3.b); the read on a GET (§3.c); one orchestration rather
than two (§3.d); the wire pair (§3.e); and the fence law (§3.f).

## Decision

**One — one orchestration, two doors.** `registerInitiative` in
`packages/persistence/ledger/src/initiative-registration/index.ts` is the only code
that decides, publishes and appends a registration. It receives a writable ledger,
the private plane, the request fields, the recording instant, the holder's pid and
every identifier; it opens nothing and reads no clock. The gateway's seam
(`src/initiative-write`) and the CLI's verb (`src/initiative`) open the handles —
the ledger, `openArtifactBlobLeaseStore` at `artifactBlobLeaseStorePath`, and
`openArtifactPlane` — mint the identifiers and map the outcome. The CLI may not
import the gateway, so a copy in each door would have been two answers.

**Two — the request is not the payload (H-1).** The candidate is composed from the
request with `CONTRACT_VERSION`, `status: "ACTIVE"` and `createdAt = recordedAt`
(the `recordRoadmapVersion` precedent) and parsed through `Initiative` whole, so the
contract's credential guards run over the objective before anything is published.
The event carries a closed four-key payload, `INITIATIVE_REGISTRATION_PAYLOAD_KEYS`:
`slug`, `title`, `objectiveSha256`, `objectiveArtifactReferenceId`. Never `objective`.
`InitiativeEvent` does not change, `@acp/contracts` is not touched and
`CONTRACT_VERSION` stays `2.5.0`. The append door does not close the payload: history
recorded under another shape stays readable, and the closed shape has one producer,
which L-P14B-1 holds (decision 71's "held by the door" is the orchestration here,
because the stream's own door must keep accepting what it accepted).

**Three — the key, the replay and the conflict (H-2).** The coordinate is the
client's `initiativeId` — no door mints one — with `transitionId` fixed at
`register`, so the idempotency key is `initiativeId/1/register`. The comparison is a
content precondition by analogy with contracts §15, not E10 (that is the task's
client key, escalón C's): `decideInitiativeRegistration` receives the registration
folded from the recorded `INITIATIVE_REGISTERED` and compares slug, title and
objective digest, in that order. Equal is a replay that publishes nothing and appends
nothing and answers the row that exists; a difference is `CONFLICT` at
`candidate.slug`, `candidate.title` or `candidate.objective`. A registration older
than the closed payload folds to nulls and compares as different. The decision's
vocabulary is `CONFLICT` and `REQUEST_INVALID`; the orchestration adds the plane's
`CONTENT_REJECTED` and the lost race's `WRITE_CONFLICT`
(`INITIATIVE_REGISTRATION_WRITE_REFUSALS`), each with an `at` that is a field path or
the plane's word, never a value. An append that loses a race
(`LEDGER_IDEMPOTENCY_CONFLICT`, `LEDGER_EVENT_ID_CONFLICT`,
`LEDGER_LIFECYCLE_CONFLICT`) re-reads the stream and decides again: replay, or
conflict (§3.d).

**Four — the objective in the private plane (H-4, §3.a, §3.b).** The objective's
UTF-8 bytes are published as `PLAN_DOCUMENT`, `INTERNAL`, `INITIATIVE`/`initiativeId`,
`PERMANENT` with `expiresAt: null`, under `SCOPE_EQUALITY_V1` (the plane's one
policy), `text/plain; charset=utf-8`, `PLAINTEXT`. A new artifact class would be a
contract version and was not taken. The intention's and the terminal's idempotency
keys are `initiativeId/objective/<digest>/intended` and `…/succeeded`. The order is
decide → publish → append. A retry finds the intention by its derived key and reuses
its command id, pin id, intended reference, producer, identity and instants — and the
terminal's, when one is recorded — so the fresh identifiers of the retry are ignored
from that point. The holding is `holder = recordedBy`, `holderPid` the door's
`process.pid`, `acquiredAt = recordedAt`, `expiresAt = recordedAt + 5 min`, informative
only: the lease store releases nothing by the clock.

Accepted by name, as consequences of the rulings:

- one objective of one initiative has exactly one publication;
- a pair whose publication ended `ABANDONED` is refused
  (`CONTENT_REJECTED`/`PUBLICATION_ALREADY_ABANDONED`) until another decision;
- a crash between the publication and the append leaves a reference that names no
  initiative until a retry names it — not E11, since no event claims work not done;
- a holding a dead process left inside the publication is not displaced by the door:
  the plane answers `QUIESCENCE_UNPROVEN`, mapped to `CONTENT_REJECTED`, and the
  reconciliation is not this escalón's.

**Five — the read back (H-4 iv, §3.c).** `readInitiativeObjective(ledger, event)`
returns null for an event that is not a registration of the closed payload — the
gateway then reads the payload as before — and otherwise the objective read by
`plane.read` under `INITIATIVE`/`initiativeId`. It first checks that the private root
stands (`artifactPlaneRootFor` and `lstat`, so a GET never creates it), and hands the
plane a lease store that refuses every holding, since a read asks none and opening
the real one would create a coordination file on a GET. A refused read, an absent
root or a digest that does not match is `LedgerIntegrityError` — `LEDGER_INTEGRITY` at
the API — and never `objective: null`. `InitiativeSummary` does not change shape.

**Six — migration 18.** `initiative_registration_detail`: three `ALTER TABLE
initiative_read_model ADD COLUMN`s, nullable, no default, no CHECK, no trigger, no
index, no watermark. The fold, `nextInitiativeProjection`, sets `title` and
`objective_sha256` from a registration's closed payload, carries them on every later
event and leaves `repository_sha256` null; it stays total. Because a stream may
already hold a closed registration, the ledger folds the initiative stream again in
the same transaction (`afterSql`, migration 17's precedent) and writes only the three
columns. `INITIATIVE_REGISTRATION_MIGRATION = 18`. `LEDGER_CONTRACT_VERSION` does not
move: this is ledger schema, not the shape of a recorded event.

**Seven — the doors.** `API_WRITE_ROUTES` gains `initiatives` (4 → 5), registered
through `registerGetAndPost`, so the bearer is inherited: 403
`WRITE_BEARER_UNCONFIGURED`, 401 `AUTH_REQUIRED`. The GET is the portfolio, unguarded
and unchanged. A body `InitiativeRegistrationRequest` refuses is 400 `BAD_REQUEST` at
the field; a refused registration is 409 `WRITE_REFUSED` with the refusal's word and
its `at`. `acp initiative --request <path>` reads its document through the tool
call's `readOperatorDocument`, now exported with one word (the `openForWrite`
precedent), and takes `openForWrite`: B and C share the **opening**, and L-B4B-11 and
`CLI_WRITABLE_OPEN_SITE` do not move (H-3). Both doors print
`InitiativeRegistrationResponse`. `SURFACE_MAP` gains `initiative` → `initiatives`
POST, `DOCUMENT`. No error code is added: `API_ERROR_CODES` stays fifteen.

**Eight — the version (M-6).** `API_CONTRACT_VERSION` `0.15.0` → `0.16.0`, for the
reason `0.13.0` gave: the write table moves. `API_ALLOWED_METHODS` stays `["GET"]`.

**Nine — L-P14B-1 (§3.f, N-P14-11).** Over `packages/*/*/src/**`: no `initiativeId` is
assigned from `randomUUID(` or from a uuid literal, and `type: "INITIATIVE_REGISTERED"`
is built in exactly one module, the orchestration's. Comparisons against the type
name remain everywhere they were. `PATH_SCOPED_LAWS` 138 → 139.

## Consequences

- `MIGRATIONS` 17 → 18. `EXPECTED_SCHEMA_OBJECTS`, `DERIVED_TABLES`,
  `PROJECTION_SOURCES` and `PROJECTOR_VERSION` do not move. Every rewind past 18 drops
  the three columns first; the ledger's `dropModelVersionRegistry` does, and the CLI
  and gateway rewinds do by name and assert the re-applied 18 folds a closed
  registration back into its columns.
- `@acp/ledger` exports the orchestration, the decision, the reader and their
  vocabulary. `@acp/protocol` exports the request and the response.
  `InitiativeReadModel` gains three fields.
- The gateway's portfolio path answers POST; its read-route 405 matrices name it as
  a write route by the write table. The CLI has four writing verbs, in its banner, its
  README and its manifest.
- `API_CONTRACT_VERSION` pins move to `0.16.0`, the two tool-call suites included.

## Not in this record

Task intake, `client_scope` and `client_request_key` (escalón C; Q1). A retry of an
abandoned objective publication, and the reconciliation of a holding a dead process
left. A producer of `repository_sha256`. A read of the objective by the CLI. Any change
to `resolveRoute` or the policy file. A new artifact class for objectives.
