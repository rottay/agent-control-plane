# API reference

Every route the observation plane serves, with its methods, parameters and
response schema.

This document is checked, not trusted. The architecture fence asserts a
**bijection** against `API_ROUTES` in `packages/kernel/protocol/src/routes/index.ts`:
a route named here that the table does not carry fails, and a route in the
table that this document omits fails. It also asserts that every response and
query schema named below is exported by `@acp/protocol`.

The parity suite remains the behavioral authority — it proves the gateway, the
CLI and the console agree route by route, including ordering, pagination,
cursors and redaction. This document is the readable form of the same table.

## Conventions

- **Base path.** Every route is under `/api/v1`. The prefix is part of the
  contract rather than a deployment detail: a reader that finds itself talking
  to an unversioned path is talking to something the contract did not
  describe, and should fail rather than guess.
- **Methods.** `API_ALLOWED_METHODS` is `["GET"]` and describes the read plane.
  The two routes that also accept a write are named in a separate frozen table,
  `API_WRITE_ROUTES`, and are marked `GET, POST` below.
- **Parameters** are validated before they are encoded. A traversal segment, a
  query string or a raw path produces a thrown validation error rather than a
  request to somewhere else.
- **Every response carries both version lines**, `apiContractVersion` and
  `ledgerContractVersion`. They are deliberately different numbers.
- **Pages are bounded and cursors are exclusive.** The default limit is 100 and
  the maximum is 1000.
- **Unknown keys are rejected.** Responses are strict objects, so a field that
  appeared server-side fails at the boundary instead of being carried.

## Routes

| Route | Methods | Path | Path parameters | Query schema | Response schema |
| --- | --- | --- | --- | --- | --- |
| `health` | GET | `/api/v1/health` | — | none | `HealthResponse` |
| `overview` | GET | `/api/v1/overview` | — | none | `OverviewResponse` |
| `tasks` | GET | `/api/v1/tasks` | — | `TasksQuery` | `TaskPageResponse` |
| `taskById` | GET | `/api/v1/tasks/:taskId` | `taskId` (uuid) | none | `TaskDetailResponse` |
| `workers` | GET | `/api/v1/workers` | — | `WorkersQuery` | `WorkerPageResponse` |
| `workerByIdentity` | GET | `/api/v1/workers/:identity` | `identity` (worker identity string) | none | `WorkerDetailResponse` |
| `events` | GET | `/api/v1/events` | — | `EventsQuery` | `EventPageResponse` |
| `status` | GET | `/api/v1/status` | — | none | `LedgerStatusResponse` |
| `integrity` | GET | `/api/v1/integrity` | — | none | `IntegrityResult` |
| `initiatives` | GET | `/api/v1/initiatives` | — | none | `InitiativePortfolioResponse` |
| `initiativeById` | GET | `/api/v1/initiatives/:initiativeId` | `initiativeId` (uuid) | none | `InitiativeDetailResponse` |
| `initiativeRoadmap` | GET, POST | `/api/v1/initiatives/:initiativeId/roadmap` | `initiativeId` (uuid) | none | `InitiativeRoadmapResponse` / `RoadmapVersionWriteResponse` |
| `initiativeRoadmapContent` | GET | `/api/v1/initiatives/:initiativeId/roadmap/content` | `initiativeId` (uuid) | `RoadmapContentQuery` | `RoadmapContentResponse` |
| `initiativeEvents` | GET | `/api/v1/initiatives/:initiativeId/events` | `initiativeId` (uuid) | none | `InitiativeTimelineResponse` |
| `initiativeAgents` | GET | `/api/v1/initiatives/:initiativeId/agents` | `initiativeId` (uuid) | none | `InitiativeAgentsResponse` |
| `accounts` | GET | `/api/v1/accounts` | — | none | `AccountsResponse` |
| `accountActions` | GET, POST | `/api/v1/accounts/:accountId/actions` | `accountId` (bounded label) | none | `AccountActionsResponse` / `AccountActionWriteResponse` |
| `eventStream` | GET | `/api/v1/events/stream` | — | `StreamQuery` | `StreamFrame` (Server-Sent Events) |

## The two writes

Both are registered through the same guarded registrar, so the local bearer
check is structural rather than remembered. With no token configured, a write
answers `403` — an unconfigured door is shut, never open. `SECURITY.md` records
the mechanism and its anchors.

| Route | Request body | Records |
| --- | --- | --- |
| `initiativeRoadmap` | `RoadmapVersionWriteRequest` | a roadmap version, content-addressed; the event carries the digest and the bytes live in the artifact store |
| `accountActions` | `AccountActionRequest` | an account action, with the refusal vocabulary the accounts domain defines |

A write that is refused answers with a classified refusal rather than a bare
failure: `AccountActionRefusalDto` names which rule refused it.

## The one stream

`eventStream` is the only route that answers with a connection rather than a
body. It is still a **read** — registered through a twin of the read registrar
that reuses the same 405 set, so `API_ALLOWED_METHODS` is still `["GET"]` and
`API_WRITE_ROUTES` is still the two routes above.

| Property | Value |
| --- | --- |
| Media type | `text/event-stream`, `cache-control: no-store`, no `content-length` |
| Cursor | the `Last-Event-ID` request header, and nothing else |
| Frame identity | an `id:` line on **event frames only**, equal to the ledger `sequence` |
| Body | one `StreamFrame` per frame, JSON, on a single `data:` line |
| Keep-alive | `: heartbeat`, an SSE comment, so it cannot advance a cursor |
| Connections | at most 8 at once; the next is refused `STREAM_CAPACITY` (503) |

**Resuming.** Send `Last-Event-ID` with the sequence you last received. The
cursor is exclusive, like every other cursor here, so the row you name is not
repeated. Omit the header and the stream serves live from the current head
after one `hello` frame — history is `events`' job, not the stream's.

**The two unusable anchors, and how they differ.** An anchor that is not a
decimal sequence is a `BAD_REQUEST` envelope, answered before the connection is
hijacked. An anchor **ahead of the head** is a ledger this client was not
reading — rebuilt, or a different file — and receives one `resync` frame with
`reason: "ANCHOR_AHEAD_OF_HEAD"` and a close. It is never silently restarted
from zero. There is no "too old": the event log is never pruned.

**Channels.** Every frame carries a `channel`, one of `lifecycle`, `execution`,
`steps`, `state`, `progress`. The mapping from the twenty-three ledger event
types onto them is `STREAM_CHANNEL_BY_EVENT_TYPE`, and it is total and
one-to-one — the fence and the protocol suite both assert it against the
contract's own vocabulary, so a new event type cannot appear unmapped.

**The tail is a polled read, not a push.** This process opens the ledger
read-only and the writer is a different process, so there is no change
notification to subscribe to. ADR 0017 records why a broker was refused.

## Parameter validation

| Parameter | Shape | Why |
| --- | --- | --- |
| `taskId` | uuid | refuses path separators and traversal segments by parsing |
| `initiativeId` | uuid | the same property, for the initiative stream |
| `identity` | worker identity string | a structured identity, parsed rather than interpolated |
| `accountId` | 1–80 chars, `[A-Za-z0-9][A-Za-z0-9._-]*` | an account id is the operator's own label from the owner file, not a uuid — so it is bounded and pattern-checked instead |

Route helpers (`taskPath`, `workerPath`, `initiativePath`,
`initiativeRoadmapPath`, `initiativeRoadmapContentPath`,
`initiativeEventsPath`, `initiativeAgentsPath`, `accountActionsPath`) validate
before they encode. Do not build these paths by string concatenation.

## What no response carries

- **No absolute path.** The ledger's location crosses as a digest of the path
  plus the bare file label.
- **No event payload.** A timeline item carries the event's key names and its
  serialized size only.
- **No credential-shaped or transcript-shaped key**, on any route, in any
  client. The parity suite asserts this as absence, and detects a blanked value
  rather than accepting it as redaction.

## Errors

`ApiError` with a code from `API_ERROR_CODES`. `health` is the contract's named
non-ledger exception: it answers even when the ledger cannot be opened, which
is what makes it useful for deciding whether the ledger can be opened.
