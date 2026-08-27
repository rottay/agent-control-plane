# ADR 0001 — Where state authority lives

- Status: Accepted
- Date: 2026-08-27
- Phase: P0
- Deciders: `kimi/k3/coordinator/01` (DT), `claude/opus/implementer/01` (integrator)
- Audited by: `claude/fable/reviewer/01`
- Supersedes: nothing
- Authority: `docs/ROADMAP.md`

## Context

The control plane coordinates several agent providers, several accounts and
several worktrees at once, and must survive crashes, restarts, quota exhaustion
and account switches without losing or fabricating work.

That requires answering one question before any code is written: when two
components disagree about what happened, which one is right?

Three candidate answers were considered.

1. **A durable workflow engine as the source of truth.** Restate holds
   execution state, and the application reads it back. Attractive because
   durability, retries and idempotent replay come for free.
2. **A conventional mutable state table.** Simple, familiar, and what most
   schedulers do.
3. **An append-only event log owned by the application**, with everything else
   derived from it.

Option 1 makes an external runtime the arbiter of truth. If it is unavailable,
downgraded, or replaced, the system has no independent account of what happened,
and the migration cost is unbounded. It also makes the orchestrator a
prerequisite for observability, which inverts the order the roadmap wants:
observation first, mutating controls later.

Option 2 loses history exactly where history matters most. Recovery has to
reconstruct intent from a snapshot, which is how a system ends up forcing a
worktree back to an old photograph and destroying real work.

## Decision

### 1. The append-only event ledger is the application authority

`ControlPlaneEvent` records are appended to a local SQLite database in WAL mode.
That log is the single **authority** for application state. Records are never
updated and never deleted; a correction is a new record.

Every append is keyed by the idempotency coordinates `(taskId, attempt,
transitionId)`, materialised as `taskId/attempt/transitionId` and enforced
unique by the ledger. A replayed step therefore appends nothing rather than
duplicating state. `attempt` is what distinguishes a genuine retry from a
replay of the same attempt.

SQLite is chosen because the control plane is local and single-host by design,
WAL gives durable appends with concurrent readers, and the whole authority is a
single file the owner can copy, inspect and back up without a service running.

### 2. Restate is a conditional, derived orchestrator

Restate may run durable execution, but it is **derived**, never authoritative.
It is adopted only if it passes the P2 drills:

- idempotency: replaying a durable step appends no duplicate ledger record;
- reconciliation: after a kill and restart, Restate state and the ledger agree,
  and where they disagree the ledger wins;
- `3/3` successful kill and restart cycles against a toy repository.

Event-first ordering is mandatory: the ledger append happens before the side
effect is considered done, so a crash between the two is recoverable by reading
the log, not by asking the orchestrator what it believes.

### 3. Read models are derived and rebuildable

The CLI and UI never read the ledger directly for presentation. They read a
**read model** projected from it. Any read model can be dropped and rebuilt from
the ledger alone, and a **rebuild** must be byte-identical for the same input
log. A read model therefore holds no fact that is not already in the ledger, and
corrupting one is an inconvenience rather than data loss.

This is also the P3 correctness test: the UI matches the ledger exactly, or the
UI is wrong.

### 4. The fallback is a single-process SQLite supervisor

If the Restate drills fail, or Restate is unavailable at runtime, the default
**fallback** is a single-process local supervisor driving the same ledger. This
is a supported operating mode, not a degraded one: it is the predetermined
default, and P2 requires it to be tested rather than assumed.

Because authority never moved out of the ledger, switching between the
orchestrator and the fallback changes only who advances the state machine.

### 5. No secrets in the authority path

Credential material never enters the ledger, read models, checkpoints, logs,
prompts or artifacts. The `Checkpoint`, `ControlPlaneEvent` and `AccountRecord`
contracts reject credential-bearing keys and secret-shaped values structurally.
Accounts carry opaque local references only.

### 6. Continuity is digest-based, not transcript-based

Recovery hydrates from a `Checkpoint`: last atomic step, HEAD, authority, read
and write digests, receipts, pending work, and exactly one next safe action.
Checkpoints are bounded in bytes and reject provider transcript keys.

A provider conversation is not state. Treating it as continuity would make
recovery provider-specific and unverifiable, and would smuggle unbounded and
possibly sensitive text into the authority path.

Recovery revalidates authority and prestate before continuing. It never forces
the working tree back to an old snapshot.

## Consequences

Positive:

- One arbiter of truth, and it is local, inspectable and file-backed.
- Restate becomes a swappable implementation detail rather than a dependency
  the architecture cannot survive.
- Recovery, audit and the UI all read the same history, so "what happened" has
  exactly one answer.
- Account and provider switching is safe: continuity is digests plus a next
  safe action, both provider-neutral.

Negative, and accepted:

- Every state change costs an append plus a projection update.
- Projections must be maintained alongside the ledger, and rebuild must be
  exercised regularly or it will rot.
- The append-only log grows; compaction, if ever needed, is a separate decision
  and must preserve replay equivalence.
- Single-host SQLite is a deliberate scope limit. Distributing the control plane
  would require a new ADR, not an incremental change.

## Compliance

P0 freezes the contracts that encode this decision in
`packages/contracts/src/schemas.ts`, and `scripts/check-architecture.mjs`
verifies that this document still states them. P1 implements the ledger and the
first read model. P2 runs the Restate drills that decide whether the conditional
orchestrator is adopted or the fallback becomes permanent.
