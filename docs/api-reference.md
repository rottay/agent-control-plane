# API reference

Every route the observation plane serves, with its methods, parameters and
response schema.

This document is checked, not trusted. The architecture fence asserts a
**bijection** against `API_ROUTES` in `packages/kernel/protocol/src/routes/index.ts`:
a route named here that the table does not carry fails, and a route in the
table that this document omits fails. It also asserts that every response and
query schema named below is exported by `@acp/protocol`.

The parity suite is the behavioral authority **where it reaches**, and it does
not reach every route. Eleven of the twenty-four arms below are compared in full
against an independently built CLI-side producer, including ordering,
pagination, cursors and redaction; `eventStream` GET is compared in part, on one
frame's item; `health` has no ledger content and so has no CLI build to compare
against, and is checked as the contract's declared non-ledger exception instead.
The remaining eleven arms — `taskLifecycle` GET, and the ten belonging to the
eight initiative and account routes — have no CLI-side comparison at all. The
`CLI` column below says which arms a command answers; that a command answers an
arm is not by itself a claim that a behavioral comparison exists for it.

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

| Route | Methods | Path | Path parameters | Query schema | Response schema | CLI |
| --- | --- | --- | --- | --- | --- | --- |
| `health` | GET | `/api/v1/health` | — | none | `HealthResponse` | — |
| `overview` | GET | `/api/v1/overview` | — | none | `OverviewResponse` | `overview`:GET |
| `tasks` | GET | `/api/v1/tasks` | — | `TasksQuery` | `TaskPageResponse` | `tasks`:GET |
| `taskById` | GET | `/api/v1/tasks/:taskId` | `taskId` (uuid) | none | `TaskDetailResponse` | `task`:GET |
| `workers` | GET | `/api/v1/workers` | — | `WorkersQuery` | `WorkerPageResponse` | `workers`:GET |
| `workerByIdentity` | GET | `/api/v1/workers/:identity` | `identity` (worker identity string) | none | `WorkerDetailResponse` | `worker`:GET |
| `events` | GET | `/api/v1/events` | — | `EventsQuery` | `EventPageResponse` | `events`:GET |
| `status` | GET | `/api/v1/status` | — | none | `LedgerStatusResponse` | `status`:GET |
| `integrity` | GET | `/api/v1/integrity` | — | none | `IntegrityResult` | `integrity`:GET |
| `initiatives` | GET | `/api/v1/initiatives` | — | none | `InitiativePortfolioResponse` | — |
| `initiativeById` | GET | `/api/v1/initiatives/:initiativeId` | `initiativeId` (uuid) | none | `InitiativeDetailResponse` | — |
| `initiativeRoadmap` | GET, POST | `/api/v1/initiatives/:initiativeId/roadmap` | `initiativeId` (uuid) | none | `InitiativeRoadmapResponse` / `RoadmapVersionWriteResponse` | — |
| `initiativeRoadmapContent` | GET | `/api/v1/initiatives/:initiativeId/roadmap/content` | `initiativeId` (uuid) | `RoadmapContentQuery` | `RoadmapContentResponse` | — |
| `initiativeEvents` | GET | `/api/v1/initiatives/:initiativeId/events` | `initiativeId` (uuid) | none | `InitiativeTimelineResponse` | — |
| `initiativeAgents` | GET | `/api/v1/initiatives/:initiativeId/agents` | `initiativeId` (uuid) | none | `InitiativeAgentsResponse` | — |
| `accounts` | GET | `/api/v1/accounts` | — | none | `AccountsResponse` | — |
| `accountActions` | GET, POST | `/api/v1/accounts/:accountId/actions` | `accountId` (bounded label) | none | `AccountActionsResponse` / `AccountActionWriteResponse` | — |
| `eventStream` | GET | `/api/v1/events/stream` | — | `StreamQuery` | `StreamFrame` (Server-Sent Events) | — |
| `taskToolCalls` | GET, POST | `/api/v1/tasks/:taskId/tool-calls` | `taskId` (uuid) | `ToolCallsQuery` | `ToolCallPageResponse` / `ToolCallExecuteResponse` | `tool-calls`:GET, `tool-call`:POST |
| `taskLifecycle` | GET, POST | `/api/v1/tasks/:taskId/lifecycle` | `taskId` (uuid) | none | `TaskLifecycleResponse` / `TaskLifecycleExecuteResponse` | `cancel`:POST, `attach`:POST |

Two commands have no row above, because they have no route. `submission`
re-elects a daemon config's route and prints the document; `switch-decision`
folds recorded provider pressure into a decision and prints it. Neither is
served by this plane, and both are recorded — with the reason — in `SURFACE_MAP`
(`packages/kernel/protocol/src/surface-map/index.ts`), which is the single place
the CLI/API relation is declared and the table the architecture fence checks the
`CLI` column against, both ways.

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
redacted identity, its `instance`, its `headSequence`, and `resumedFrom`: the
anchor this connection resumed at, or `null` if you opened live. `instance` is
`instanceId`, `restoreId` and `restoreEpoch` — which **file** this is and which
restore of it, as against `database`, which says which **path**. The three are
`null` only together, and only until the first writable open of a build that
knows about them. The frame carries **no**
`id:` line, so reading it moves no cursor. It arrives *before* any replayed row,
which is what lets a client decide whether it is still reading the same ledger
before it applies anything from the new one.

`resumedFrom` is required and nullable rather than optional. `null` means "you
opened live"; `0` means "you asked for the whole log"; these are different
answers and a client must be able to tell them apart. Because the frame is
strict, a client pinned to an older `apiContractVersion` will reject it — see
`API_CONTRACT_VERSION`, which moved to `0.12.0` with this field, to `0.13.0`
when the lifecycle route arrived, to `0.14.0` with `instance` — a required
key on a strict frame, for the same reason `resumedFrom` moved it — and to
`0.15.0` with `coverage` on the integrity result, which is a strict object for
the same reason every frame here is.

**The server does not detect a foreign resume, and cannot.** `Last-Event-ID` is
a bare decimal sequence: only event frames carry an `id:`, and its value is that
row's `sequence` verbatim, so the header has nowhere to put a ledger identity.
The server's obligation is to restate identity on every open; comparing it
against what you anchored to is **yours**. What you compare is the tuple
`(database.id, instance.instanceId, instance.restoreId)`: if any member is not
the one you were reading, discard your cache and refetch — the rows the server
is about to replay belong to a different file, or to a different restore of
this one, and their sequences will collide with yours. `null` is equal only to
`null`, so a ledger with no identity yet does not look like a change on every
reconnection. `instance.restoreEpoch` is informative — a human-readable
ordering of restores — and is deliberately **not** compared: it carries no
uniqueness, so two restores can share one. `docs/architecture/0028-the-resumed-stream-identity.md` records why the
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
served as an ordinary resume; the `hello`'s identity is the only thing that
tells you, which is why it is now sent on resumed connections too.

And `database.id` alone is **not** enough to tell you, which is what
`instance` is for. It is a digest of the ledger's absolute path, so a formal
restore that replaces every row behind that path leaves it identical; what
moves then is `restoreId`. What that detects is a **formal** restore — one
where the restoring process recorded a new restore id before admitting work. A
manual copy of the file with identical metadata is not detectable from inside
the file, by this or by anything else, without external state. A server
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

## The integrity report

`GET /api/v1/integrity` answers two different questions, and the whole design of
the response is about keeping them apart.

`ok` and `problems` say **whether the evidence holds**: the chains recompute,
the heads agree with the streams, the stored projections match a fresh replay.

`coverage` says **from when there is any evidence at all**. It is an array of
exactly four entries, one per stream, ordered by stream name — never a subset,
because the interesting answer is the account stream's and a report free to omit
a stream would be free to omit exactly that one.

| Field | Shape | Meaning |
| --- | --- | --- |
| `sourceStream` | one of the four streams | which stream this entry is about |
| `coverageKind` | `CHAIN_FROM_APPEND` / `BASELINED_AT_ACTIVATION` / `NOT_ACTIVATED` | how the coverage came to be — provenance, not a score |
| `coveredSinceSequence` | `>= 1`, or `null` | `1` wherever a verified chain is installed; `null` only for `NOT_ACTIVATED` |
| `checkedThroughSequence` | `>= 0` | the head of the cut examined; `[1, 0]` denotes an empty stream |
| `integrityActivatedAt` | instant, or `null` | when the chain was computed; present only for a baselined stream |
| `baselineSequence` | `>= 0`, or `null` | the `H` fixed at activation, including `H = 0` |
| `baselineSha256` | sha-256, or `null` | the baseline digest; sixty-four zeroes when `H = 0` |

`control_plane_events`, `initiative_events` and `registry_events` chain as they
append, so they report `CHAIN_FROM_APPEND` from sequence one with all three
baseline fields `null` — there was never an instant at which they were not
covered, so there is nothing for a baseline to record. `account_events` is the
only stream whose chain lives beside it and was installed after the fact, so it
is the only one that can report `BASELINED_AT_ACTIVATION`, and the only one that
can report `NOT_ACTIVATED`.

**Read the account entry exactly.** Coverage of `1..H` means **bytes preserved
since activation**. It is not authenticity before that instant, and it is not
evidence that those rows were hashed when they were inserted — nobody hashed
them when they were written. Those are two different facts and nothing in this
response presents them as one.

**A partial or divergent activation is an integrity error, never a quiet
`NOT_ACTIVATED`.** Degrading it to the word for "never activated" is precisely
how a tampered baseline would pass for an honest absence. What you get instead
is `ok: false`, a `LEDGER_META` problem naming what is missing, *and* a
`NOT_ACTIVATED` entry with every nullable field `null` — the finding and the
honest coverage claim, together. A result that is `ok` and reports any
`NOT_ACTIVATED` stream does not parse: that value does not satisfy the integrity
gate even where a legacy read is still possible.

Nothing in `coverage` is recomputed. The baseline fields are read from
`ledger_meta` verbatim, because a verifier that recomputed them from the current
head would be asserting the very thing the chain exists to prove. That is also
why `integrityActivatedAt` is **not** a volatile field: it says when the chain
was computed, not when this process looked, so two clients reading one file emit
it identically. ADR 0065 carries the reasoning.

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
