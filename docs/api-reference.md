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
  The routes that also accept a write are named in a separate frozen table,
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
| `taskToolCalls` | GET, POST | `/api/v1/tasks/:taskId/tool-calls` | `taskId` (uuid) | `ToolCallsQuery` | `ToolCallPageResponse` / `ToolCallExecuteResponse` |
| `taskLifecycle` | GET, POST | `/api/v1/tasks/:taskId/lifecycle` | `taskId` (uuid) | none | `TaskLifecycleResponse` / `TaskLifecycleExecuteResponse` |

## The writes

All are registered through the same guarded registrar, so the local bearer
check is structural rather than remembered. With no token configured, a write
answers `403` — an unconfigured door is shut, never open. `SECURITY.md` records
the mechanism and its anchors.

| Route | Request body | Records |
| --- | --- | --- |
| `initiativeRoadmap` | `RoadmapVersionWriteRequest` | a roadmap version, content-addressed; the event carries the digest and the bytes live in the artifact store |
| `accountActions` | `AccountActionRequest` | an account action, with the refusal vocabulary the accounts domain defines |
| `taskToolCalls` | `ToolCallExecuteRequest` | one explicit tool call, and whatever it did: this is the only route that starts a child process, and a refused call is a `200` with a recorded row rather than an error |
| `taskLifecycle` | `TaskLifecycleRequest` | one lifecycle verb — `CANCEL` or `ATTACH` — against an attempt already running; the rows it appends are the ones the cancellation settlement already produced, and `ATTACH` appends none |

A write that is refused answers with a classified refusal rather than a bare
failure: `AccountActionRefusalDto` names which rule refused it.

**Every write route answers its read as well as its write, and the two halves
are guarded differently.** The `POST` passes the bearer; the `GET` does not,
because observation is free on this plane and the asymmetry is the design. On
`taskLifecycle` this matters more than elsewhere: the read tells a caller which
attempt is the latest and what state the task is in, so a caller can decide
whether to cancel without issuing a write to find out.

**`taskLifecycle` names no scenario, no ledger, no route and no commit policy.**
Its request is a strict object of four fields — `verb`, `mode`, `taskId`,
`attempt` — and every other value the operation needs is recovered from the
ledger and verified against the digest the attempt's own events carry. The
scenario is startup configuration (`--scenario`); a body that names one is a
`400` on the unknown key, before any ledger is opened.

**`ATTACH` blocks until the invocation completes, and no request timeout is
imposed.** A caller that attaches to a long run holds the HTTP connection open
for the length of that run. This is the honest consequence of the verb rather
than an oversight: rejoining an invocation means waiting for it. A caller that
cannot hold a connection should poll the `GET` instead.

## The one stream

`eventStream` is the only route that answers with a connection rather than a
body. It is still a **read** — registered through a twin of the read registrar
that reuses the same 405 set, so `API_ALLOWED_METHODS` is still `["GET"]` and
it added nothing to `API_WRITE_ROUTES`.

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
repeated. Omit the header and the stream serves live from the current head —
history is `events`' job, not the stream's.

**Every open begins with a `hello`, resumed or not.** It carries the ledger's
redacted identity, its `headSequence`, and `resumedFrom`: the anchor this
connection resumed at, or `null` if you opened live. The frame carries **no**
`id:` line, so reading it moves no cursor. It arrives *before* any replayed row,
which is what lets a client decide whether it is still reading the same ledger
before it applies anything from the new one.

`resumedFrom` is required and nullable rather than optional. `null` means "you
opened live"; `0` means "you asked for the whole log"; these are different
answers and a client must be able to tell them apart. Because the frame is
strict, a client pinned to an older `apiContractVersion` will reject it — see
`API_CONTRACT_VERSION`, which moved to `0.12.0` with this field and stands at
`0.13.0` since the lifecycle route arrived.

**The server does not detect a foreign resume, and cannot.** `Last-Event-ID` is
a bare decimal sequence: only event frames carry an `id:`, and its value is that
row's `sequence` verbatim, so the header has nowhere to put a ledger identity.
The server's obligation is to restate identity on every open; comparing it
against what you anchored to is **yours**. If `hello.database.id` is not the one
you were reading, discard your cache and refetch — the rows the server is about
to replay belong to a different file, and their sequences will collide with
yours. `docs/architecture/0028-the-resumed-stream-identity.md` records why the
division of labour is this way round.

**The two unusable anchors, and how they differ.** An anchor that is not a
decimal sequence is a `BAD_REQUEST` envelope, answered before the connection is
hijacked. An anchor **ahead of the head** receives one `resync` frame with
`reason: "ANCHOR_AHEAD_OF_HEAD"` and a close, with no `hello` before it, and is
never silently restarted from zero. There is no "too old": the event log is
never pruned.

Note what that refusal does and does not cover. It fires only when your anchor
is beyond this ledger's head — a *shorter* replacement. A rebuilt or different
ledger whose head is at or beyond your anchor produces no refusal at all and is
served as an ordinary resume; the `hello`'s `database.id` is the only thing that
tells you, which is why it is now sent on resumed connections too. A server
refusal and a client-side scope reset are deliberately different events: one
closes the connection, the other continues against the new ledger.

**Channels.** Every frame carries a `channel`, one of `lifecycle`, `execution`,
`steps`, `state`, `progress`. The mapping from the twenty-four ledger event
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

### The three conflicts, and why they are three

`409` is answered by three codes, and a client that treats them alike will do
the wrong thing with at least one of them.

| Code | What happened | What the caller should do |
| --- | --- | --- |
| `CONTRACT_VERSION_MISMATCH` | the request names a contract this build does not speak | upgrade one side; do not retry |
| `WRITE_REFUSED` | the write lost to a concurrent one | worth retrying against a fresh head |
| `CLAIM_HELD` | another operating-system process holds this durable tool coordinate | **read** the recorded call; do not retry |

### `501` and `503`, and why a capability gap is neither an outage nor a defect

| Code | Status | What happened | What the caller should do |
| --- | --- | --- | --- |
| `CAPABILITY_UNSUPPORTED` | `501` | the engine this attempt runs on does not serve that lifecycle verb | do not retry; nothing an operator does makes it succeed |
| `SCENARIO_UNCONFIGURED` | `503` | this server was started without a scenario naming its ledger | an operator restarts it with `--scenario`; then retry |
| `NOT_FOUND` | `404` | the engine was reached and answered that it holds no invocation at this attempt's address | not as a loop; confirm the endpoint is registered, then ask once more — the ledger remains the authority |
| `LEDGER_UNAVAILABLE` | `503` | the ledger could not be read, or the engine could not be reached | retry |

The distinction between the first and the last two is the reason
`CAPABILITY_UNSUPPORTED` exists as its own code. A `503` invites a retry loop,
and a retry loop against a SQLite supervisor asked to cancel will spin forever
on an answer that cannot move. `SCENARIO_UNCONFIGURED` is on the operator side
like `TOOL_SERVERS_UNCONFIGURED`, and is reachable only **after** the bearer has
passed, so an unauthenticated caller learns nothing about how the process was
started.

A driver's own refusal is not an error at all. `TASK_TERMINAL` and
`POSTCONDITION_UNKNOWN` answer `200` with `ok: false` and the refusal named in
the document, because the request became an operation; `4xx` and `5xx` are
reserved for requests that never did.

`INVOCATION_NOT_FOUND` is the exception, and the second and last one beside
`CAPABILITY_UNSUPPORTED`: it arrives as a **`404` envelope with no document**,
because the engine holds nothing to report on. `NOT_FOUND` therefore has two
sources on the lifecycle route — the ledger pre-check, when the ledger holds no
such task or attempt, and this, when the ledger holds the attempt and the engine
does not. They share a code deliberately, because to a caller they mean the same
thing: there is nothing there to act on.

The retry guidance is bounded rather than absolute, and the reason is measured.
A `404` on the attach path has two causes — an invocation that is genuinely
absent, and a deployment that is not registered — and the plane will not read
the engine's response body to tell them apart. A caller whose endpoint is not
yet registered would otherwise be told to abandon a live attempt. So: confirm
the endpoint is registered, ask once more, and read the ledger, which is the
authority on what the task actually did.

`CLAIM_HELD` is the one that most looks retryable and most is not. Nothing was
wrong with the request and the plane is not overloaded — so it is neither a
`400` nor a `503` — but the winner of the race is about to record the receipt
for that coordinate, and a caller that retries risks a **second real tool
effect** rather than a second row. Poll `taskToolCalls` for the coordinate
instead; the receipt is the answer.

The refusal names no coordinate, no holder and no path. A loser learns that it
lost, not who beat it.

### The tool-call guarantee, stated exactly

`taskToolCalls` is the only route that starts a child process, so it is the
only one where "how many times did this happen" is a question about the world
rather than about the ledger. Since V2 X1b it is arbitrated by a claim beside
the ledger that every caller in every process passes through:

- the **receipt** is exactly-once per coordinate, canonical;
- the **effect** is exactly-once per coordinate across operating-system
  processes, **except** across a claimant crash in the window between the tool
  answering and the receipt landing.

In that exception the plane cannot know whether the effect happened, so the
coordinate is neither re-run nor reported as done: the next caller promotes it
to a receipt with `outcome: "REFUSED"` and `refusal: "POSTCONDITION_UNKNOWN"`,
and the coordinate is spent. Read that as "this may or may not have run, and
nothing will run it again".

The exception is not a rounding error to be dropped from the sentence. A reader
who takes away an unqualified "exactly once" has taken away something this
plane does not provide.
