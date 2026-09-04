# ADR 0025 — The tool-coordinate claim: one coordinate, one effect, and the window that stays open

- Status: accepted (V2 X1a, recorded 2026-09-04). Supersedes: none.
  Superseded-by: none. Adopted by: ADR 0026, which is where "nothing changes
  until X1b" below stops being true — the store is no longer inert, and the
  semantics this record describes as *permitted once X1b adopts it* are the
  semantics the plane now has. The decision recorded here is unchanged and is
  not superseded; only its adoption status moved.

## Context

`runToolCall` reads the receipt for a coordinate, awaits an external process,
and appends the result:

```
recorded = ledger.getEventByIdempotencyKey(key)
if recorded  -> replay
outcome = await scope.callTool(...)      // the external side effect
result  = recordToolCall(ledger, ...)    // the append
```

Two processes can both read "no receipt", both spawn the tool, and both append.
The ledger absorbs the second as an exact replay, so what the plane records is
**one row for two effects**. The gateway closes this within one process with an
in-flight `Map`, and both door headers already name the real fix as *a lock the
ledger itself arbitrates* which *must name both doors*.

The honest description of what the plane guarantees today is therefore an
**exactly-once receipt over an at-least-once effect** — the receipt is canonical,
the effect is not.

Two further facts shaped the answer.

A tool call is **hard-bounded in time** (`TOOL_CALL_TIMEOUT_MS`), so a dead
claimant can be detected by expiry rather than by probing a process — which
matters because probing is what makes a lock machine-local and fragile.

And a recovering caller must be able to write a receipt that is **byte-identical**
to the one any other recoverer would write. The idempotency key is built from
`(taskId, attempt, transitionId)` alone, but the event body carries the
submission instant, the account, the emitter, the server, the tool and the byte
count. Two recoverers with different submission instants would build one key from
different bytes, and the second would take an idempotency conflict.

## Decision

A third SQLite database beside the ledger and the worktree arbiter:
`packages/persistence/ledger/src/tool-claim-store/index.ts`, one row per tool
coordinate, arbitrated by `BEGIN IMMEDIATE`.

**This packet lands the store alone and adopts it nowhere.** Nothing calls it;
it changes no behaviour. That is the same shape ADR 0021 used before ADR 0022
took the lease, and it is what lets the substrate be reviewed on its own terms.

**Both halves of the mechanism are load-bearing.** `coordinate_key` is the
PRIMARY KEY, so at most one *record* can exist per coordinate; `BEGIN IMMEDIATE`
takes the write lock at `BEGIN`, so at most one *decision* is taken at a time.
Fence law `L-X1-1` asserts the second, because the key will not catch a decision
moved outside the transaction.

**The row is a recovery record, not only a lock.** Every field a poison receipt
needs is written at claim time by the original holder, so a recoverer rebuilds
the receipt from the **claim** rather than from itself.

**Three stored states, one way: `CLAIMED → IN_FLIGHT → SETTLED`.** A poison is
not a fourth state. It is what a *caller* does on finding an expired
`IN_FLIGHT`: append the `POSTCONDITION_UNKNOWN` receipt, then `SETTLE`. The store
transitions straight to `SETTLED` and holds no opinion about which receipt was
written — it arbitrates, it does not adjudicate.

**No clock, no environment, no process probe, no `DELETE`, no sweep, and one
path producer.** `L-X1-2` asserts the absences; `L-X1-3` asserts that
`toolClaimStorePath` is the only module composing the filename; `L-X1-4` asserts
the three databases in this package migrate under three distinct table names.

## What this permits us to claim, and what it does not

**Permitted, once X1b adopts it:** an exactly-once receipt, canonical; and an
exactly-once *effect* per coordinate across operating-system processes, **except**
across a claimant crash in the window between the tool answering and the receipt
landing — where the coordinate settles fail-closed as `POSTCONDITION_UNKNOWN` and
is never re-run.

**Forbidden, in code, comment, README, record or report: any unqualified
"exactly once".** The qualification is the honest part, and a claim that drops it
is a claim about a system nobody built.

### The residual window, stated rather than hidden

If the claim database is **destroyed** while a coordinate sits `IN_FLIGHT` and
before any caller has promoted that claim into a receipt, the coordinate becomes
re-runnable and the plane degrades to at-least-once for it. The window is exactly
"from the loss until the next caller touches that coordinate".

It is narrow, because the first recoverer promotes the poison **into the ledger**:
once that receipt exists, losing this file is harmless, which restores ADR 0021's
framing — losing the store costs liveness, never evidence — for every coordinate
except one mid-flight at the moment of loss.

It is not closed. Closing it would require the claim and the receipt to be
written atomically, which means one database for two questions, which is the
arrangement ADR 0001 exists to prevent.

## Why the claim is not a table inside the ledger

It would have avoided a third file, and it would have put mutable,
frequently-overwritten rows inside an append-only database whose entire value is
that its rows are never overwritten. It would also have required appending to the
ledger's own migration list — checksum-verified on every open of every existing
ledger — for a concern that is not the ledger's.

The two databases have opposite failure postures, exactly as ADR 0021 recorded
for the lease store. A corrupt ledger is a catastrophe. A corrupt claim store
should also fail closed, and it does, but its recovery is "delete it and accept
the window above" — a sentence that must never become sayable about the ledger.

## Why expiry, and not a liveness probe

The worktree lease can probe: its holder is a process on this machine, and ADR
0022 uses that as a fast path with expiry as the guarantee. A tool coordinate's
holder need not be, and a probe would quietly make this store machine-local.

A tool call is time-bounded by contract, so the expiry is *derivable* rather than
guessed — and the store does not compute it. Every instant is the caller's
argument, which is what lets an expiry boundary be drilled without sleeping and
keeps the one judgement that matters where the policy is.

## Consequences

- **Nothing changes until X1b.** The store is inert; the plane's semantics are
  exactly what they were.
- **A third database exists per scenario**, beside the ledger, at a path with one
  producer.
- **A claim row outlives its coordinate.** Rows are never deleted, so the file
  grows with the number of tool coordinates ever claimed. Bounded by work done,
  not by time; compaction is nobody's yet and is named out below.
- **An expired `IN_FLIGHT` coordinate can only be settled, never silently
  re-granted.** The store offers no verb for it: a caller's honest moves are to
  refuse, or to promote a poison receipt and settle.
- **A caller must decide expiry itself**, because the store will not. That is a
  cost paid deliberately.

## Not in this record

- Adoption: both doors taking a claim, the required port, the poison receipt and
  the refusal a cross-process loser receives — all X1b.
- Any change to `TOOL_REFUSALS`, `CONTROL_PLANE_EVENT_TYPES`, the contracts or
  the protocol. The poison is a `TOOL_CALL_RECORDED` receipt, not a new type.
- Compaction or retention of settled claim rows.
- A distributed lock service, a cross-process wait, or any socket. One SQLite
  file, arbitrated by `BEGIN IMMEDIATE`.
- Cross-machine arbitration: the store excludes processes sharing a filesystem
  and nothing beyond that.
- P9, which remains deferred.
