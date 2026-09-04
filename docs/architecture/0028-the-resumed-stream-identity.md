# ADR 0028 — A resumed stream restates its identity, because the server cannot detect a foreign resume

- Status: accepted (V2-B3c, recorded 2026-09-04).
- Supersedes: none.
- Superseded-by: none.

## Context

A resumed SSE connection was never bound to the ledger it resumed from.

`#open()` in `packages/entrypoints/gateway/src/stream/index.ts` returned on the
`anchor.kind === "at"` branch **before** writing a `hello`. Only the live branch
wrote one. So `LedgerDatabaseIdentity` was restated on exactly the connections
that did not need it and withheld from exactly the ones that did.

The client half completes the picture. The identity comparison lives inside
`acceptHello` in `packages/entrypoints/console/src/api/stream/index.ts`, and its
own comment concedes the position: *"The server cannot enforce this —
`EventSource` sends no custom header, so it has nothing to compare — which makes
it a client law, and this is where the client keeps it."* Because a resumed
connection received no `hello`, that client law never ran on the connections it
was written for.

What existed instead was `ANCHOR_AHEAD_OF_HEAD`, the single member of
`STREAM_RESYNC_REASONS`. It catches a *shorter* replacement ledger — an anchor
this ledger has never reached. A rebuilt or different ledger whose head is at or
beyond the anchor produces no such anchor, and was served as a continuous resume
by both ends. `docs/api-reference.md` described the guarantee as though closed.

The concrete failure: a browser tab holding sequence 3 of ledger A reconnects,
the file behind the URL is now ledger B with a head of 40, and both sides treat
it as a resume. Rows from B are appended to a view rendering A, silently.

## The ruling: the server cannot detect a foreign resume

This is the load-bearing fact, and it is a property of the wire rather than a
gap in the implementation.

The resume cursor is the `Last-Event-ID` request header **and nothing else** —
`StreamQuery` is `EventsQuery` minus `cursor` and `limit` precisely so there is
no second place to say where a reader is. That header carries a bare decimal
sequence, and it cannot be widened to carry a ledger identity. Two independent
mechanisms hold that:

1. `StreamFrame`'s discriminated union gives an `id:` line only to the `event`
   arm, whose value is that row's `sequence` verbatim. `hello` and `resync`
   carry no `id:` at all, and a heartbeat is an SSE comment rather than a frame.
2. Fence law **L1 — "the stream mints no identity"**, path-scoped to
   `packages/entrypoints/gateway/src/stream/`, requires that directory to hold
   **exactly one** expression writing an `"id: "` line and requires it to match
   `"id: " + String(sequence)`. It additionally refuses `randomUUID`,
   `performance.now`, `Math.random`, `node:crypto`, and any `++` or `--`
   anywhere in the directory.

So the server is handed a number. It cannot tell a resume of this ledger from a
resume of a different one, and there is no honest place to put the information
that would let it.

An earlier draft of this analysis described the server answering a foreign
resume with a refusal frame and a close. **It cannot**, and that correction is
recorded here rather than quietly dropped, because the wrong version is the
intuitive one and someone will propose it again.

The client, by contrast, holds both halves: the identity it anchored to and the
identity the server just stated. So the division is: **the server restates, the
client decides.**

## Decision

**`hello` is sent on every open, and carries `resumedFrom`.**

The `hello` arm of `StreamFrame` gains `resumedFrom: SequenceOrZero.nullable()`
— the anchor this connection resumed at, or `null` on a live open. The anchored
branch of `#open()` writes a `hello` with `resumedFrom: anchor.sequence`
**before** assigning the cursor and before any replayed row; the live branch
adds `resumedFrom: null`, so the arm has one shape and two call sites.

Before the replay rather than after, because a client that learned the ledger
had changed only after applying rows from it would already have mixed two
ledgers in one scope. `encodeControlFrame` takes no sequence parameter, so this
frame structurally cannot carry an `id:` and cannot advance any cursor —
restating identity costs nothing at the seam.

**Required and nullable, not optional.** A missing key and a live open would
otherwise be the same wire shape, leaving a client to guess which it was looking
at. This is also what makes the version move honest: every arm is a
`z.strictObject`, so a reader pinned at `0.11.0` *rejects* a `0.12.0` `hello`
rather than ignoring the key, which is this repository's own rule for a minor
bump. `API_CONTRACT_VERSION` moves `0.11.0` → `0.12.0`.
`LEDGER_CONTRACT_VERSION` does not move: no recorded event changes shape, no
history is reinterpreted and no migration is implied.

**The client's decision, in four arms.** `acceptHello` gains one branch ahead of
the existing head checks:

- Identity differs → `resetScope` to the foreign head, `onDatabaseChanged`,
  `emit`. This arm already existed; the packet's whole effect on it is that it
  becomes reachable on anchored connections. The reset to the foreign head is
  also what disposes of the replay about to arrive: every replayed row carries a
  sequence at or below the head just adopted, so the duplicate arm drops each
  one and counts it. No foreign row is applied to either scope.
- Identity matches and `resumedFrom !== null` → **return without backfilling**,
  because the server is about to replay; halt only if
  `resumedFrom < lastApplied`.
- Identity matches and `resumedFrom === null` → the existing behaviour,
  unchanged: a reconnection with no id to send still leaves a hole, and the rows
  in between are fetched rather than skipped.
- `headSequence < lastApplied` → the existing halt, unchanged.

**The halt is one-directional, and the asymmetry is deliberate.**
`Last-Event-ID` is the last id the browser *received*; `lastApplied` is the last
one this scope *applied*. With a gap open at the moment the connection dropped,
held frames make `resumedFrom > lastApplied` perfectly legitimate — the gap
machinery is already running and the replay will close it. Only the other
direction is impossible: an anchor *behind* what this scope has applied means
the browser is resuming from a position the view has moved past. A symmetric
equality check would halt on an ordinary reconnect, which is why the first draft
of this rule was corrected before it landed.

**`resumedFrom` is compared and never assigned to the cursor.** Fence law **L4 —
"the console mints no sequence"** pins every assignment to `lastApplied` to a
row's `sequence`, `headSequence`, or zero, so `lastApplied = frame.resumedFrom`
would fail the fence. It is also the correct semantics independently: the server
replays, so the rows themselves move the cursor.

**The parity binding.** `resumedFrom` binds to `LIVENESS`, beside `reason`, and
the stream's declared exceptions widen from one field to two. "This connection
resumed at N" is a fact about *this process's handle* on the file — what cursor
the browser happened to send — and a CLI folding the same events would never
arrive at it. Binding it to `LEDGER` would claim otherwise.

## No new fence law, declared rather than omitted

The brief said this packet "adds its own laws" and named none. It adds none, and
the reason is that every line it edits is already governed: **L1** covers the new
`hello` write in the gateway stream directory, **L4** covers the client arm, and
**L5 — "the console opens the stream in one module"** still names exactly one
opener. `PATH_SCOPED_LAWS` stays at 88.

A new law here would have to be about something none of those three cover, and
there is nothing: the packet adds a field to a frame and a branch to a reader,
both inside directories that are already fenced. Inventing a fourth law to
satisfy the convention that new laws arrive with fixtures would be writing a law
for the fence rather than for the code.

## Why the cursor was not enriched

The intuitive fix is to make the resume cursor carry a ledger identity, so the
server can compare and refuse. It was rejected, and L1 is the reason.

`Last-Event-ID` is what a browser sends *on its own*, on a reconnection the
client never participated in. The platform `EventSource` cannot send a custom
header and reconnects by itself. So enriching the cursor means putting the
identity **into the `id:` line** — which would break the one law that makes the
whole plane's cursor story checkable: exactly one `id:` producer, and its value
is a row's sequence verbatim. A browser's `Last-Event-ID` could then hold a
value that was never a row's sequence, and "one sequence authority" would stop
being a shape and go back to being a sentence.

No polyfill, no `fetch`-based transport and no second opener were considered as
workarounds either. L5 refuses all three by name.

## Why `ANCHOR_AHEAD_OF_HEAD` was not widened

Reusing the existing refusal for the foreign-ledger case would have avoided a
contract change entirely. It was rejected because the two are different events
and an operator must be able to tell them apart: one is a **server refusal** —
the connection is closed and reconnecting would get the same answer — and the
other is a **client-side scope reset**, after which the stream continues
normally against the new ledger. Collapsing them would make a recoverable
condition indistinguishable from a terminal one. `STREAM_RESYNC_REASONS` stays
at one member, and a drill asserts the resync path sends no `hello`, so the two
answers stay distinguishable on the wire.

## Why the field is on `hello` rather than a new frame kind

A fourth frame kind would widen a closed union that three drills depend on, and
would need its own `id:`-absence proof, its own client arm and its own place in
the parity table. The fact being carried — "this is the ledger, this is its
head, this is where you resumed" — is the opening frame's existing job. Adding a
field to the frame that already restates identity is the smaller change and the
more honest one.

## Consequences

Every open now costs one control frame. On a resumed connection that is one
frame that did not previously exist, carrying no `id:` and moving no cursor.

A reader pinned at `0.11.0` will reject a `0.12.0` `hello`. That is the intended
failure and the reason the bump is minor: in-repo consumers are updated
atomically in the same commit, and every package is `private: true`, so there is
no external consumer to strand.

The stream's parity exceptions are now two fields rather than one. A third would
need the same argument made again from scratch, which is the point of pinning
the list by equality in both directions.

Drills that counted *frames* on an anchored connection now count *rows*: the
gateway suite gained `eventFrames`/`eventIds` helpers, because "the frames" and
"the rows" stopped being the same list the moment a control frame appeared in
front of the replay. That is a real maintenance cost and it is where a future
regression would most likely hide.

The client can now halt on a resumed connection, which is a new way for the live
view to stop. It is bounded to one cause — an anchor behind what was already
applied — and it names the sequences in its message.

## Not in this record

Whether the console should re-open a stream automatically after a scope reset.
The view refetches; the transport is the browser's business, and L5 keeps it in
one module.

Any change to the roadmap. `docs/ROADMAP.md` carries no B3c line; this packet is
a correction inside the B3a/B3b stream lane under those packets' existing laws,
and its intent matches the roadmap's standing requirement that closing or
reopening the UI neither cancels nor duplicates. No Estado change is implied and
the roadmap stayed outside the write-set.

P9, cutover and publication. Untouched, as everywhere else.
