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
