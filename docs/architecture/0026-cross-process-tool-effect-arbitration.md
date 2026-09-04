# ADR 0026 — Both doors take the claim: the tool effect becomes exactly-once across processes

- Status: accepted (V2 X1b, recorded 2026-09-04). Supersedes: none.
  Superseded-by: none.

## Context

ADR 0025 landed `tool_claim` and adopted it nowhere. The store was inert by
design — "nothing changes until X1b" — so that the substrate could be reviewed
on its own terms before anything depended on it. This is X1b, and it is the half
that changes what the plane guarantees.

What it changes it from is worth stating plainly, because it was true of every
build up to this one. `runToolCall` read the receipt for a coordinate, awaited an
external process, and appended the result:

```
recorded = ledger.getEventByIdempotencyKey(key)
if recorded  -> replay
outcome = await scope.callTool(...)      // the external side effect
result  = recordToolCall(ledger, ...)    // the append
```

Two processes could both read "no receipt", both spawn the tool, and both
append. The ledger absorbed the second as an exact replay, so what the plane
recorded was **one row for two effects**. The gateway closed this within one
process with an in-flight `Map` and said so; the CLI could not close it at all,
because every `acp tool-call` is a new process that exits when the call is done.
Both door headers already named the real fix as *a lock the ledger itself
arbitrates* which *must name both doors*.

Two further facts shaped what adoption could look like.

A tool call is **hard-bounded in time**, so a dead claimant is detected by expiry
rather than by probing a process — which is what keeps the arbitration from
becoming machine-local.

And a recovering caller must be able to write a receipt **byte-identical** to the
one any other recoverer would write. The idempotency key is built from
`(taskId, attempt, transitionId)` alone, but the event body carries the
submission instant, the account, the emitter, the server, the tool and the byte
count. Two recoverers that differed in any of those would build one key from
different bytes, and the second would take an idempotency conflict.

## Decision

**Both doors take a claim before a tool port is reachable on any path.** The CLI
verb and the API route each open the claim store from the ledger they already
hold — through `toolClaimStorePath` and through nothing else — and each adapts it
to the runtime's structural `ToolClaimPort` at the door. Neither carries a lock
of its own. `L-X1-5` asserts that every source reaching `runToolCall` also opens
the claim store, and that the set of such sources is exactly the two doors;
`L-X1-7` asserts that neither composes the path itself.

**The order inside the operation is the contract.** Read the receipt, take the
claim, open the window, call the tool, append the receipt, settle the claim.

Reading the receipt **first** is what makes a crash between the append and the
settle benign: the claim still says `IN_FLIGHT`, but the receipt exists, so a
later caller replays and never reaches the arbitration at all.

Settling **only against a landed receipt** is the load-bearing half of the
`finally`. Settling unconditionally would spend the coordinate on the one path
where the effect may have run and left no row — the port threw, or the append
did — and a spent coordinate with no receipt is exactly the unaudited effect this
plane exists to refuse. Leaving the claim `IN_FLIGHT` instead hands that case to
expiry, which classifies it and writes the receipt saying so.

**The claim transaction commits before the port is called.** No SQLite write lock
is held across an external process; `L-X1-6` asserts it.

**A poison is rebuilt from the claim, never from the recoverer.** On finding an
expired `IN_FLIGHT` coordinate a caller appends a `TOOL_CALL_RECORDED` receipt
with `outcome: "REFUSED"` and `refusal: "POSTCONDITION_UNKNOWN"`, then settles.
Every field it needs was written at claim time by the original holder —
including the **holder itself**, because `emittedBy` is a durable field and a
recoverer that signed with its own identity would build different bytes under one
key. The causation id is pinned to `null` for the same reason and a further one:
causation records what *this* caller was caused by, and a poison is not caused by
the recoverer's request. Two recoverers therefore build byte-identical rows, so
the first appends and the second replays exactly.

**A cross-process loser is told to read, not to retry.** `CLAIM_HELD` is the
thirteenth `API_ERROR_CODES` member and moves `API_CONTRACT_VERSION` `0.10.0` →
`0.11.0`. At the API it is `409`; at the CLI it is `EXIT_CLAIM_HELD` = `7`. It is
raised as a named class, `ToolClaimHeldError`, and both doors classify it by type
rather than by matching a message.

**The claim carries no payload.** Coordinates, identities, an instant and a byte
*count* — never the argument the count measures, never a result block, never a
prompt. `L-X1-8` pins the twelve members by equality in both directions.

## What this permits us to claim, and what it does not

**Permitted:** an exactly-once *receipt* per coordinate, canonical; and an
exactly-once *effect* per coordinate across operating-system processes,
**except** across a claimant crash in the window between the tool answering and
the receipt landing — where the coordinate settles fail-closed as
`POSTCONDITION_UNKNOWN` and is never re-run.

**Forbidden, in code, comment, README, record or report: any unqualified
"exactly once".** ADR 0025 wrote that prohibition against a store nothing called.
It now applies to live behaviour, and it has not weakened.

The residual window ADR 0025 stated is unchanged and is not closed here. If the
claim database is destroyed while a coordinate sits `IN_FLIGHT` and before any
caller has promoted that claim into a receipt, that coordinate becomes
re-runnable. It is narrow, because the first recoverer promotes the poison into
the ledger and after that losing the file is harmless. It is not closed, because
closing it would require the claim and the receipt to be written atomically,
which means one database for two questions — the arrangement ADR 0001 exists to
prevent.

## Why the gateway's in-flight map was not deleted

It would have been the tidier change, and the argument for keeping it is narrow
but real. It no longer closes a gap; the claim does. What it still does is keep
this door's same-process answer courteous: without it, a second concurrent
request for one coordinate would lose the claim and take a `409`, where waiting a
moment lets it replay the winner's row and answer `200`.

So it is **demoted, not deleted**, and the demotion is the point. Nothing rests
on it — delete the map and the plane is still exactly-once per coordinate, with
one more `409` in it. That is the correct relationship between an optimisation
and an invariant, and it is the reverse of what stage 3C had, where the map *was*
the guarantee and its bound was a paragraph asking the reader to remember it.

## Why `CLAIM_HELD` is not `WRITE_REFUSED`

Both are conflicts, both answer `409`, and reusing the existing code would have
avoided a contract-version move. It was rejected because `WRITE_REFUSED` carries
a documented hint — *worth retrying against a fresh head* — and that hint is
precisely wrong here. A tool-call retry is not a cheap re-read; it risks a second
real effect against the world. The one script most likely to meet this refusal is
a wrapper that retries on a timeout, and telling it to retry is the single
response that must not follow.

The same reasoning produced a distinct CLI exit code rather than folding into
`EXIT_USAGE`: a `2` says *fix the arguments*, and nothing about the invocation
was wrong.

## Why expiry is still judged by the caller

The store holds no clock, and adoption did not give it one. Every instant is the
caller's argument, which is what lets an expiry boundary be drilled without
sleeping and keeps the one judgement that matters where the policy is. The cost
is that the ttl lives in the runtime: `TOOL_CLAIM_TTL_MS` is the tool edge's own
bound plus an append margin, **restated** rather than imported because
`RUNTIME_ALLOWED_PACKAGES` forbids this stratum from reaching `@acp/tools`. Two
numbers in two homes is the price; the alternative is a dependency edge added for
one integer. If the tool edge's bound moves, this must move with it — which is
why the derivation is written out rather than the sum being written down, and why
a test asserts the derivation rather than the value.

## Consequences

- **The plane's headline semantics changed**, and every description of them had
  to change with it — the two door headers, the API reference, and this record.
  A door header that still described the old race would be worse than no header.
- **A tool call can now fail without becoming an operation**, at both doors. That
  is a new outcome for a caller to handle, and it is why the refusal got its own
  code at both doors rather than being folded into an existing one.
- **A crashed claimant costs a coordinate.** It is settled
  `POSTCONDITION_UNKNOWN` and never re-run, which is the fail-closed answer and
  is also an operational cost: work that may never have happened will not be
  retried by the plane. Re-driving it is a human decision, at a new coordinate.
- **Every tool call now touches a third database.** One more file to open, one
  more to lose, and one more whose loss is recoverable but not free.
- **`TOOL_CALL_BOUND_MS` is off the runtime barrel on purpose.** Publishing it
  would offer importers a second authority for a number `@acp/tools` owns.

## Not in this record

- Compaction or retention of settled claim rows. Still nobody's.
- Any change to `TOOL_REFUSALS` or `CONTROL_PLANE_EVENT_TYPES`, which stays at
  24. The poison is a `TOOL_CALL_RECORDED` receipt carrying a shape-bounded
  refusal word, not a new event type.
- Cross-machine arbitration. The store excludes processes sharing a filesystem
  and nothing beyond that.
- A distributed lock service, a cross-process wait, or any socket.
- P9, which remains deferred and unauthorized. Adopting this into the operation
  is not operational cutover.
