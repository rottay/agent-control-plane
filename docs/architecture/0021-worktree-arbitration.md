# ADR 0021 — Worktree arbitration: the question history cannot answer gets a lock, not a query

- Status: accepted (V2 concurrency C1, recorded 2026-09-04). Supersedes: none.
  Superseded-by: none.

## Context

Two questions look alike and are not.

*What happened?* is history. ADR 0001 makes the append-only ledger its only
authority, ADR 0002 gives it a hash-chained SQLite form, and every later record
has kept that single-authority rule intact.

*May I write into this worktree, now?* is mutual exclusion. It cannot be
answered by reading history, and the reason is structural rather than a matter
of care: reading the last lease event and then acting on the answer is a
check-then-write, and two processes can both pass the check before either
writes. No amount of appending fixes that, because the gap is between the read
and the write, not inside either.

The plane already has the *rules* for leases. `acquireLease`, `renewLease` and
`revokeLease` in `@acp/runtime`'s enforcement module are pure decisions: they
fold caller-supplied state, decide, and return events for the caller to append.
They are correct, and this record does not change them. What they have never
had is a substrate that can arbitrate — something that holds a lock across the
read, the decision and the write, so that the second process to arrive sees the
first one's result rather than the state it raced against.

Nothing else in the tree fills that gap. The ledger's own `append` is atomic per
event, which makes each write safe and says nothing about a decision spanning a
read and a write. C2 needs a lease something can hold, C3 needs concurrent
walks that cannot both claim one worktree, and C4 needs a holder to enforce a
write-set against. All three are blocked on the same missing object.

## Decision

A separate SQLite database — the **arbitration store** — at
`packages/persistence/ledger/src/lease-store/index.ts`, exported as
`openLeaseStore`.

It lives in `@acp/ledger` because `better-sqlite3` is fenced to that package by
equality (`LEDGER_DEPENDENCIES`), not because arbitration is a ledger concern.
It is a **different database** with its own migration list in its own module:
`LEDGER_MIGRATIONS` is immutable by law and describes the control-plane ledger,
and appending to it would be a schema change to the authority for a file that
is not the authority.

**The seam is an injected decision.** `transact(worktreePath, decide)` runs
`decide` inside `db.transaction(...).immediate()`. `better-sqlite3` is
synchronous, so no `await` can interleave between the read, the decision and
the write: they are one unit under the write lock. `decide` receives the record
as it is *inside* the lock and returns `GRANT`, `RELEASE` or `REFUSE`. The
store cannot call the pure decisions itself — `@acp/ledger` may not import
`@acp/runtime`, and should not: it is a substrate, not a policy.

**Both halves of the mechanism are load-bearing.** `worktree_path` is the
PRIMARY KEY, so at most one *record* can exist per worktree. `BEGIN IMMEDIATE`
takes the write lock at `BEGIN` rather than at first write, so at most one
*decision* is taken at a time. Neither alone is the mechanism, and this is not
a theoretical distinction: with the transaction removed, four processes racing
for a *fresh* worktree still produced exactly one grant — the key caught it —
and four racing for an *existing, released* record produced **two**. A drill
that only ever raced on an empty table would have certified a store with no
arbitration in it.

**The record is created on the first grant and is never deleted.** Release
clears the holder columns and stamps `released_at`; `fence` survives and is
bumped only by a grant. Fence law `L-C-1b` asserts there is no `DELETE` in the
module at all, and that every mutation sits inside a balanced
`.transaction(...).immediate()` region.

**No clock, no environment, no process.** Every timestamp, including
`released_at` and the sweep boundary, is a parameter. Liveness probing belongs
to the caller. `L-C-1c` asserts the absence.

**No refusal vocabulary.** `REFUSE` carries a caller-supplied reason. The
policy words belong to the layer with the policy; a closed enum here would be
this module legislating for a caller it cannot see.

Three fence laws hold the shape: `L-C-1a` (only this module names the lease
table, over every tracked source file), `L-C-1b` (every mutation immediate, no
delete), `L-C-1c` (no driver, engine, capability, clock, environment or
process).

## Why a second authority was not chosen, and why this is not one

The obvious objection is that ADR 0001 says the ledger is the only authority,
and this record adds a database.

It does not add an authority. The precedent is already in the tree:
`acquireSingleton` takes an operating-system file lock with `open(…, "wx")`
precisely because *the operating system arbitrates rather than a check-then-write
in this process*. The arbitration store is that same object, scaled from one
daemon per checkout to one writer per worktree. The lease **events** still go to
the ledger and the ledger remains the only place history lives.

The store holds no history. It is rebuildable, and losing it costs liveness —
some worktree is briefly unclaimable until a sweep — never evidence. An
authority is a thing you would have to reconstruct the truth from; this is a
thing you would throw away and re-derive.

## Why a lease table inside the control-plane ledger was not chosen

It would have avoided a second file. It would also have put mutable,
frequently-overwritten rows inside an append-only database whose entire value is
that its rows are never overwritten, and it would have required appending to
`LEDGER_MIGRATIONS`, which is immutable by law and checksum-verified on every
open of every existing ledger.

The two databases also have opposite failure postures. A corrupt ledger is a
catastrophe and must fail closed. A corrupt arbitration store should also fail
closed — and it does — but the recovery is "delete it and re-derive", which is
not a sentence anyone should be able to write about the ledger. Keeping them in
one file would eventually make someone write it. The store refuses outright to
open a file carrying `control_plane_events`, so the mistake is caught rather
than merged.

## Why a driver capability was not chosen

The tempting shortcut is to declare that Restate mode already serializes, add a
`SERIALIZED_PER_WORKTREE` property, and skip the lease when the property is
present.

It is false. `DRIVER_CAPABILITY_PROPERTIES` is `["SERIALIZED_PER_TASK"]`, and
Restate serializes per **task key** — one Virtual Object per task id. Two
different tasks writing one worktree are two keys and run concurrently. SQLite
mode declares `SERIALIZED_PER_TASK: "UNSUPPORTED"` and says nothing about
worktrees either. Neither driver has ever offered worktree exclusivity, so
neither can be credited with it.

The lease is therefore **mandatory in both modes**, and no capability property
moves in this record. `L-C-1c` makes it mechanically impossible for the file
that provides arbitration to name a driver, which is what "no false SQLite
parity" means as a check rather than as an intention. The claim this guards
against — *"Restate serializes, so this path needs no lease"* — is
true-sounding, false, and exactly the kind of thing a future packet would look
for a record to confirm.

## Consequences

- **A second database file exists per checkout**, at a path the caller supplies.
  The store defaults nothing: resolving the daemon root lives in `@acp/daemon`,
  one stratum out, and a default here would be a path a caller could silently
  point elsewhere — which is two stores, which is two answers.
- **Callers must now hold a lease**, in both durability modes, and that
  obligation lands on C2 and C4 rather than here.
- **The fence is now part of the lease contract.** C2's abort test is "has the
  fence moved since I was granted?", so `fence` must never reset. That
  constrains every future schema change to this table: a migration that dropped
  and recreated the record would silently break aborting holders, and the
  no-delete law is what keeps it visible.
- **Nothing holds the lease yet.** This packet adds a primitive with no
  production caller. That is deliberate — it is the smallest change that
  unblocks C2 — but it means the store is exercised only by its own drills
  until C2 lands.
- **Arbitration is per checkout.** The lock is a file lock in a SQLite
  database; it excludes processes on one machine sharing one filesystem, and
  nothing beyond that.

## Not in this record

- The daemon holding a lease, and the elector that decides who asks for one —
  C2.
- N concurrent walks scheduled against distinct worktrees — C3.
- Write-set conformance enforced against a held lease — C4.
- A single production control-plane ledger, and where it lives.
- Cross-checkout and cross-machine arbitration. The store excludes processes
  that share a filesystem; two machines against one network volume are not
  addressed, and SQLite's own locking guidance argues against it.
- Dynamic submission, and any form of product cutover. P9 remains deferred and
  this record does not approach it.
