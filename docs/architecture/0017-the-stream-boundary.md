# ADR 0017 — The ledger sequence is the stream, and the only cursor

- Status: accepted (V2-B3a, recorded 2026-09-03).
- Supersedes: none.
- Superseded-by: none.

## Context

The observation plane has answered with bounded bodies since P1. A reader that
wants to know what is happening polls `/api/v1/events` with a cursor, and the
console re-fetches on an interval. That is honest and it works, but it makes
two things impossible to state well: how fresh a screen is, and whether a
reader missed anything while it was away.

The ledger already has the material to answer both. `control_plane_events` is
append-only with a monotonic `sequence`; `listEvents({ afterSequence, … })`
orders by it and returns a `nextCursor`; `status().headSequence` names the head.
The log is **never pruned** — the only `DELETE FROM` in the ledger is inside
`rebuildReadModel`, and it targets projection tables — so any position a reader
once held is still reachable.

What forced a decision was the shape of the thing that reads it. A live
connection is not a bigger response; it is a different object with its own
failure modes. It drops halfway. It gets resumed by a browser that remembers
one string. It can outlive the process's willingness to hold it. It can be
opened nine times by a reconnect loop with a bug. And it can be open at the
moment somebody closes the server, holding a cursor into a database another
hook is about to close.

Every one of those is a way for a stream to be *quietly* wrong: showing stale
data as live, skipping rows across a reconnect, delivering a row twice, or
hanging a shutdown. B3a exists to make each of them either impossible or loud.

## Decision

**One route, `GET /api/v1/events/stream`, and the ledger's `sequence` is the
only identity and the only cursor.**

- **The `id:` line is the row's sequence, verbatim.** Only an `event` frame
  gets one. `hello` and `resync` are written by an encoder that takes no
  sequence, and the keep-alive is an SSE **comment** (`: heartbeat`), which
  conforming parsers discard before dispatch. A browser's `Last-Event-ID` can
  therefore only ever hold a value that was a row's sequence.
- **The stream mints nothing.** `packages/entrypoints/gateway/src/stream/**`
  contains no counter, no `Date.now()` used as an identifier, no `randomUUID`.
  The fence law *"the stream mints no identity"* is path-scoped to that
  directory and fails on any of them.
- **Resuming is by header, exclusively.** `Last-Event-ID` is the cursor
  authority; `StreamQuery` is `EventsQuery` minus `cursor` and `limit`, so
  there is no second place to say where a reader is.
- **The two unusable anchors are answered, never papered over.** A malformed
  anchor is an ordinary `BAD_REQUEST` envelope sent *before* the hijack. An
  anchor ahead of the head means this is not the ledger the client was reading:
  one `resync` frame carrying `ANCHOR_AHEAD_OF_HEAD`, then close. **No silent
  restart from zero** — replaying a whole history at a client that asked to
  resume would present a fresh stream as a resumed one.
- **The body is the existing redacted projection.** Every frame is built with
  `timelineItem` — the same mapper the paged route uses — and validated against
  `StreamFrame` before a byte is written, so the contract's credential and
  transcript guards run on the way out here as everywhere else. No payload
  value, no prompt, no transcript, no absolute path.
- **Five channels, total and one-to-one over the twenty-three event types.**
  `STREAM_CHANNEL_BY_EVENT_TYPE` is declared as data in `@acp/protocol`. The
  fence law *"the stream channel map is total over the event vocabulary"* reads
  `CONTROL_PLANE_EVENT_TYPES` out of the contracts source and requires each
  member exactly once.
- **Bounded on four axes**, all in `gateway/src/constants`: poll interval,
  heartbeat interval, replay page, and a ceiling of 8 connections. The ninth is
  refused with `STREAM_CAPACITY` — one new code in `API_ERROR_CODES`, mapping
  to **503** — before anything is hijacked.
- **Shutdown is an order, not a race.** A `preClose` hook drains every open
  stream; the ledger closes in `onClose`, after.
- `API_CONTRACT_VERSION` moves `0.8.0 → 0.9.0`. `LEDGER_CONTRACT_VERSION` does
  not move: nothing about recorded history changed.

### The tail is a polled read, and this record says so plainly

The gateway opens the ledger **read-only**, and the process that appends is a
different process. SQLite's `update_hook` fires only for changes made on the
same connection, so there is nothing here to subscribe to. The tail therefore
calls `listEvents` again every `STREAM_POLL_INTERVAL_MS`.

This is **SSE transport over a polled read.** It is not push, and no wording in
the contract, the reference or the console may imply that it is. What the design
does buy — and what polling from the browser did not — is that the freshness
budget is one server-side interval instead of a client interval plus a request,
that a reconnect resumes from a position instead of re-fetching a page, and that
the client is told when it cannot be resumed.

## Why a pub/sub broker was not chosen

A broker would give a genuine push tail. It was refused for the reason that
outranks latency here: **it would be a second authority over ordering.** The
whole design rests on there being exactly one answer to "what came after row
*k*", and that answer being the ledger's. A broker introduces a second sequence
— its own delivery order — which agrees with the ledger's right up until a
redelivery, a restart, or a dropped subscriber, and then diverges in a way no
client can detect. It would also be a new dependency and a new process to
supervise, for a single-operator loopback plane.

## Why `?live=1` on the paged route was not chosen

Reusing `/api/v1/events` with a flag would have avoided a route. It would also
have made one URL sometimes return a body that ends and sometimes one that does
not, which breaks every reader's simplest assumption and makes the method law
harder to state. A sibling path costs one row in the table and keeps both
contracts legible.

## Why a second cursor was not chosen

An opaque stream token — a connection id, an offset of the server's own — would
have allowed filtering and paging to be renumbered per connection. It was
refused because the ledger's sequence already *is* a cursor, and a second one
would need reconciling with it at exactly the moment reconciliation is hardest:
after a reconnect the client cannot explain. A filtered stream therefore carries
the ledger's own sequences, and its ids remain a subsequence of the unfiltered
stream's — narrowing the selection without renumbering it.

## Consequences

- **Three of the five channels are structurally live and behaviourally empty.**
  Nothing outside a test emits `LEASE_ACQUIRED`, `COMMIT_AUTHORIZED`,
  `TOKEN_USAGE_RECORDED`, or the account-switch pair yet; B7 is what gives them
  a producer. The map is over the **vocabulary**, not over what happens to be
  emitted, so it carries them anyway, and B3a's drills seed those types directly
  into a disposable ledger so the evidence is not vacuous. This plane must not
  be described as five channels of observed traffic until B7 lands.
- **An anchored reconnect receives no `hello`.** The frame is sent only on the
  live path, so a client resuming by header is not told which database it
  reached. That matters for exactly one case — the ledger was swapped or rebuilt
  between connections and the new head is still ahead of the client's anchor,
  so `ANCHOR_AHEAD_OF_HEAD` does not fire. The stream cannot detect it, and this
  record does not pretend otherwise: **B3b owns it**, by verifying `database.id`
  through the REST route on reconnect, or the DT widens the opening frame.
- **The freshness floor is the poll interval**, and it is a server cost that
  scales with open connections: eight streams are eight `listEvents` calls per
  interval against a read-only handle. The ceiling of 8 is what bounds it.
- **`app.close()` now depends on the drain.** Without it, `close()` does not
  merely close untidily — it never resolves, because an SSE response is an
  in-flight request rather than an idle connection. The drill for this is a
  reverted restore: removing the drain hangs the suite.
- **The parity table gains its second union and its second `LIVENESS` field.**
  `reason` is bound to `LIVENESS` because "this connection cannot serve your
  anchor" is a fact about this process's handle, not about the ledger.
- **`STREAM_CAPACITY` is a permanent widening of a closed list.** Ten error
  codes became eleven, and the list is short on purpose so that a reader can
  hold it.

## Not in this record

- **The console.** How a browser reconciles frames into a view — the drop /
  apply / gap arms, the `recovering` and `degraded` states, and the
  `database.id` law above — is B3b's, and belongs in its own record.
- **Retention.** No pruning exists, so "your anchor is too old" cannot arise
  today. A future retention policy adds a second `resync` reason; the closed
  list and the client's handling of it are shaped so that this is an addition
  rather than a redesign.
- **Authentication.** The stream is a read, and reads on this plane are
  unauthenticated by the standing decision in ADR 0003. Nothing here changes it.
- **Whether the console should keep `@tanstack/react-query`.** Measured as
  present-but-unused during B3's mapping; it is a real defect and it is not this
  packet's to fix.
