# ADR 0023 — Many walks, one plane: two gates in one order, and a cap where the truth requires one

- Status: accepted (V2 concurrency C3, recorded 2026-09-04). Supersedes: none.
  Superseded-by: none.

## Context

ADR 0021 gave the plane a store that can arbitrate. ADR 0022 made one daemon
hold one fenced lease on the worktree it writes into. Neither made the plane
capable of more than one walk at a time: the daemon opened one ledger, took one
lease and ran one walk to a checkpoint.

Two facts constrained what "more than one" could mean here.

The first is that a walk needs **two independent permissions**, and they answer
different questions. The conflict graph decides whether a packet's envelope is
compatible with the ones already admitted — write-sets, authority, conflict
keys. The lease decides whether anybody else holds the worktree. Neither
subsumes the other: two packets can be envelope-compatible and want the same
worktree, or want different worktrees and still collide on a write-set.

The second is the shape of the Restate driver. Its mode builds **one** endpoint
on a fixed port, hosting **one** task object closed over **one** walk's ledger,
effects, route, commit policy and initiative. That was measured, not assumed,
and it had not moved in the six commits before this packet.

## Decision

`packages/entrypoints/daemon/src/scheduler/index.ts` admits and runs N walks
inside one daemon. The singleton and the five fixed ports are **kept**: this is
concurrency obtained *inside* one control plane per checkout, not several planes
negotiating.

**Two gates, one order: the graph, then the lease, then the walk.**
`conflict-graph/index.ts` stated that order before anything implemented it —
*"the graph first, then acquire, then write"* — and the scheduler is that
sentence. A walk the graph refuses **never reaches the arbiter at all**. Fence
law `L-C-3a` pins it by source order and the suite asserts it by call count,
because "the arbiter was not called" is a fact and "we call them in this order"
is a comment.

Admission is **sequential**; execution is **concurrent** and capped by a
constant, not an option. Admitting concurrently would ask the graph about a set
that does not yet contain the other candidate, and two mutually conflicting
walks would both be told yes. A cap a caller could set to one would make every
concurrency drill in this repository vacuous while leaving each of them green.

**Refusals are returned, never queued.** There is no retry loop, no backpressure
and no waiting room: every submitted walk comes back as a typed outcome naming
its reason and the field the reason is about.

**One harness serves N walks.** `executionSessionId` is
`taskId/attempt/accountId`, unique per walk, so one `closeAll()` reaps
everything and one `interrupt(id)` reaps exactly one walk's child. The push
order extends ADR 0022's: each walk's ledger, then its lease, and the shared
harness **last**, so the reverse unwind reaps every child before any worktree is
handed back. `L-C-2b` compares the *first* `name: "lease"` with the *first*
`name: "agent-harness"` and therefore says nothing about this second pair;
`L-C-3d` compares the *last* of each and requires the harness push to follow
`admitWalks(`.

**Every acquired walk beats, and a lost lease reaps only its own session.**
Without a per-walk heartbeat the fenced lease of ADR 0022 degrades to a plain
TTL exactly when several tasks run at once: a walk longer than the TTL expires
while it runs, a successor lawfully takes the worktree, and the running walk
never re-reads the fence. So each hold owns a timer on the existing renewal
interval. On a lost fence — or a throwing beat, which is the conservative
reading of "this daemon can no longer prove it holds the worktree" — that walk's
timer stops, the loss is logged classified, and the harness **interrupts that
one session by id**. Not `closeAll`: the harness is shared, so `closeAll` would
answer one walk's lost lease by killing its siblings' providers. `L-C-3c` slices
the multi-walk region and checks it alone, because the presence check it
replaces was satisfiable from the single-walk branch while the multi-walk branch
renewed nothing.

**When a lease is actually handed back.** Two moments, and only one of them is
the unwind. The release that reaches the store happens at **walk completion**,
in the scheduler's `release` port, before any unwind — safe because the provider
session tears its child down before `run` settles, so the child is already gone
when the worktree is freed. The unwind's release is the idempotent second one:
it writes nothing and exists so that a walk interrupted *before* completion
still gives its worktree back. So "reaps before it releases" is precisely true
of the unwind, and true of completion for a different reason — the session, not
the stack.

**The envelope is supplied per walk and must describe the walk that runs.** The
config door parses the whole `TaskEnvelope` contract and refuses an entry whose
envelope declares a different `taskId` or `initiativeId` than the entry runs.
Without those two checks the graph would decide correctly about the wrong set.

## Why Restate is capped at one walk rather than approximated

Feeding N walks to the Restate mode as it stands would route N task keys through
**one walk's** machinery: every walk's events into one walk's ledger, under one
walk's route, attributed to one walk's emitter. That is not concurrency. It is a
mislabelled single walk, and it would pass any test that only counted walks.

Making it real needs a per-invocation resolver inside `createAcpTaskObject`,
which lives in `@acp/durability` and is a redesign of the driver's input.

So `RESTATE` **declares one walk and refuses more**. That is the shape the
drivers already use for `SERIALIZED_PER_TASK`: a capability stated at the value
it actually has, where the honest value is sometimes the narrow one. It is not a
regression — Restate mode runs exactly one walk today — and it is deliberately
**not a runtime fallback**: a `RESTATE` daemon handed two walks refuses to
start, rather than silently running the first and leaving an operator to
discover that the other never happened.

The refusal is at **both** doors, because `DaemonOptions` can be built by hand
and the config door alone is not the guard. `L-C-3b` keeps both true as the code
moves, and it is the law a later packet is likeliest to break by letting Restate
through "just for now".

## Why the singleton and the fixed ports were not relaxed

The alternative to N walks in one daemon is N daemons. That needs machine-scoped
arbitration instead of checkout-scoped, port negotiation instead of five fixed
addresses, and a second daemon-discovery mechanism for anything that wants to
find "the" daemon.

Each of those is a different architecture with its own failure modes, and none
of them is required to run several walks: the walks are already independent —
their own ledger, their own lease, their own provider session — and what they
share is a process. Keeping one plane per checkout also keeps the lease store,
the status document and the log a single place to look.

## What `SERIALIZED_PER_TASK` still does not mean

It is per **task key** — one Virtual Object per task id. Two tasks writing into
one worktree are two keys and run concurrently, so it says nothing about
worktree exclusivity and the lease stays mandatory in both modes. ADR 0022 said
this; it is repeated because a record is where a future packet will look, and
because C3 is the packet that makes several tasks run at once, which is exactly
when the mistake becomes reachable.

`DRIVER_CAPABILITY_PROPERTIES` does not move.

## Consequences

- **The plane can be busy in ways it could not be before**: N provider children,
  N ledgers and N leases at once, bounded by the cap.
- **A refused walk is visible, and costs nothing.** It appears in the outcomes
  with its reason; no worktree was claimed for it and nothing was appended.
- **A failing walk is one walk's failure.** Its lease goes back — under cause
  `FAILED` — so a wedged packet never strands a worktree, and the others finish.
- **The status document reports no ledger head in the multi-walk form**, because
  there is no single head to report. That is honest rather than a gap: a head
  chosen from one of N ledgers would be a number that means nothing.
- **Restate mode is unchanged, and stays that way.** Capping it is what keeps
  `mode-restate/index.ts` byte-identical; the cost is that real Restate
  concurrency is owed to a later packet with its own adjudication.
- **The cross-daemon-crash limitation from ADR 0022 is unchanged.** N walks do
  not make the grant-to-append window narrower or safer, and nothing in this
  record should be read as closing it.

## Not in this record

- The in-flight form of the unwind-order drill. A daemon installs its signal
  handlers only after readiness, so a graceful stop cannot be delivered while
  walks are still running; the reachable proof is a held-open daemon stopped
  after readiness, and that is what ships. Making the in-flight form reachable
  means moving handler installation, which is not this packet's region.
- Whether a walk whose provider is killed mid-effect *fails*. Measured, it does
  not: the runtime settles the classified failure and the walk still reaches a
  terminal state (V2-B7R), which C3 does not change. The N-walk isolation of a
  rejecting walk is proven in-process by the scheduler suite; joining that to a
  real child death at the daemon layer is owed.
- Write-set conformance enforced against a held lease — C4.
- Dynamic submission: walks arriving over time rather than as one admitted set.
- Real multi-walk Restate, which needs a per-invocation resolver in
  `@acp/durability`.
- A single production control-plane ledger, and where it lives.
- Cross-checkout and cross-machine arbitration, and any relaxation of the
  singleton or the five fixed ports.
- A certification-matrix row for the Restate cap: the declaration lives here and
  in `L-C-3b`, and `docs/certification/p8-matrix.md` belongs to another lane.
- Dynamic submission and any form of product cutover. P9 remains deferred.
