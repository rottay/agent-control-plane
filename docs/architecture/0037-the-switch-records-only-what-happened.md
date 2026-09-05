# ADR 0037 — The switch records only what happened

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

`decideSwitch` plans an account switch as a value: eleven lawful steps, and a
list of candidate events for an executor to append. `executeSwitchPlan` is that
executor. Between them they were meant to make a quota-driven switch a recorded
fact rather than an improvisation.

They recorded a fact that had not happened.

The planner's `SWITCH` branch emitted **five** events, and the fifth was
`ACCOUNT_SWITCH_COMPLETED`, carrying `{fromAccountId, toAccountId}` and sitting
directly beside `ACCOUNT_SWITCH_STARTED` — emitted in the same breath, before any
of steps 6–11 had happened or **could** happen. Nothing had selected an account,
probed it, opened a fresh session, revalidated authority and prestate, or
rehydrated a checkpoint. The completion was a claim about the end of a switch,
produced at its beginning.

The executor could not catch it, because the executor never looked. It iterated
`plan.events` and **never read `plan.steps` at all**. Its three guards were real
and remain so — the task must be known, a plan that revokes a lease must carry
the lease it revokes, a plan whose events change task state must name the state —
but not one of them asks whether the work an event *claims* was performed.

**None of this is reachable yet, and that is the mitigation rather than the fix.**
Neither function has a production caller, so no ledger holds a fabricated switch
today. That is exactly why the contract is closed now: before the caller exists,
the fix costs nothing and breaks nothing.

## Decision

**The planner may no longer emit a completion.** The `SWITCH` branch's events end
at `ACCOUNT_SWITCH_STARTED`; five become four. The *producer* is removed, never
the type: `ACCOUNT_SWITCH_COMPLETED` stays in the frozen contracts and protocol
vocabularies and in every read model that renders it. A switch will be completed
one day, by the session-opener that actually finishes one, and that component
will append it.

**The executor becomes step-aware, and refuses before any append.**

### The correspondence table, and why names cannot be matched

Event names and step names are **not** in correspondence, and a guard assuming
they were would refuse plans that are lawful today. Two measured facts force the
shape:

- a `DRAIN` plan declares three steps — `MARK_ACCOUNT_DRAINING`,
  `FINISH_CURRENT_ATOMIC_STEP`, `WRITE_CHECKPOINT` — and emits one event,
  `QUOTA_WARNING`, which names none of them;
- an `ESCALATE` plan declares **zero** steps and still emits
  `AUTH_REQUIRED_RAISED`.

A naive "every event needs a step of the same name" rule refuses both. So each
event type is classified exactly once, in a module-private table:

- **Step-independent** — records of a *decision*, not claims that work was done:
  `QUOTA_WARNING`, `AUTH_REQUIRED_RAISED`, `ACCOUNT_SWITCH_STARTED`.
- **Step-claiming** — each maps to exactly one step:
  `TASK_STATE_CHANGED` → `MARK_TASK_QUOTA_BLOCKED`, `LEASE_REVOKED` →
  `RELEASE_LEASE`, `ACCOUNT_SWITCH_COMPLETED` → `CONTINUE`.

An event type in neither set is **refused**, so a type added to the vocabulary
later cannot slip through unclassified.

**`ACCOUNT_SWITCH_STARTED` is step-independent although it carries
`toAccountId`**, which is the one entry that invites objection. That field records
a choice `rankAccounts` had **already made** when the plan was built; it is not a
claim that `SELECT_ACCOUNT` (step 6) was performed. A switch that has been decided
on has, by then, genuinely chosen an account.

### The claimable prefix — what may be recorded, not what is performed

The word is exact, and it is the correction that matters most in this record.
**The executor performs no step.** It appends events and does nothing else: no
account is drained here, no checkpoint written, no lease released. So the only
honest question a guard can ask is not "was this step performed" but "may a record
of this step be appended yet".

The answer is steps **1–5**, and within that prefix only two steps have a claiming
event at all:

| Step | Claiming event | F1's position |
| --- | --- | --- |
| 1 `MARK_ACCOUNT_DRAINING` | none | The plan's `accountStatus` is never appended by the executor, and the plan vocabulary has no account-state event. **Nothing is claimed here**, and where that transition gets recorded is a later packet's question |
| 2 `MARK_TASK_QUOTA_BLOCKED` | `TASK_STATE_CHANGED` | claimed |
| 3 `FINISH_CURRENT_ATOMIC_STEP` | none | no event, no artifact. **Nothing is claimed** |
| 4 `WRITE_CHECKPOINT` | none | no event and no artifact — nothing calls `Checkpoint.parse` anywhere in `src`. **Nothing is claimed**; a later packet produces one |
| 5 `RELEASE_LEASE` | `LEASE_REVOKED` | claimed |

Steps 6–11 need a session nothing opens yet, so a record claiming them would be a
record of work no code performs. **The prefix is data**, so the packet that builds
the session-opener widens one list rather than rewriting a condition.

### Three refusals, all ahead of the append loop

1. `ACCOUNT_SWITCH_COMPLETED` in a plan's events is refused **by name**, with a
   message stating that only the session-opener may append it.
2. An event claiming a step the plan does not declare is refused; so is an event
   in neither set of the table.
3. An event claiming a step outside the claimable prefix is refused.

**Refusal 1 is redundant under refusal 3** — `CONTINUE` is step 11, outside the
prefix — and it is **kept deliberately**. The defect this record exists to close
was a fabricated completion; a refusal that names it makes the defect
unrepeatable by name rather than only by arithmetic, and whoever later widens the
prefix far enough to admit `CONTINUE` has to delete that guard on purpose.

Every refusal throws `SupervisorError` **before** the loop, exactly as the three
existing guards do, so a refused plan leaves the ledger precisely as it found it.

### What is preserved, on purpose

`executeSwitchPlan` and `decideSwitch` keep their shape, their three existing
guards and their idempotency. Transition ids stay derived from event position, so
replaying a plan still appends nothing the second time. The planner keeps **all
eleven steps**: the steps are what the control plane must do, and shortening them
to match what is currently claimable would foreclose the very sessions the later
packets open. The successor inherits a working executor rather than a rebuilt one.

## Why a name-correspondence guard was not chosen

It is the obvious rule — every event must name a declared step — and it is wrong
here, measurably. It refuses `DRAIN`, whose one event names none of its three
steps, and it refuses `ESCALATE`, which has no steps at all. Adopting it would
have meant either breaking two lawful plan kinds or carving exceptions for them
until the rule described nothing. A declared table is longer to write and says
what is actually true.

## Why the completion was not simply left for the executor to filter

Removing the event only at the executor would leave the planner producing a false
claim that happened to be dropped downstream. Any second consumer of a plan — a
read model, a test fixture, a later caller — would see the completion and be
entitled to believe it. The producer is the defect.

## Consequences

- A `SWITCH` plan's events are exactly four types, ending at
  `ACCOUNT_SWITCH_STARTED`, and a pin now enumerates them; there was none before,
  which is how the fabricated fifth survived every existing law.
- The executor refuses three shapes it previously played, always before any
  append.
- `DRAIN` and `ESCALATE` trails are byte-identical to what they were.
- `SWITCH_STEPS` stays **11**, `ACCOUNTS_PUBLIC_EXPORTS` **76** and
  `RUNTIME_PUBLIC_EXPORTS` **230**: the table and the prefix are module-private,
  and the executor already imported what it needed. `PATH_SCOPED_LAWS` moves
  94 → 95 for `L-B1F-1`.
- `G1_MOVE_MAP` stays **302**, untouched, because nothing moves.
- `L-B1F-1` forbids any module under `packages/domains/**/src` or
  `packages/entrypoints/**/src` from constructing an `ACCOUNT_SWITCH_COMPLETED`
  event. After this packet the law has **no permitted site**, so its only positive
  evidence is a probe; a negative control beside it asserts the skipped forms —
  `case`, `===`, enum membership — do not trip it.

## Not in this record

The session-opener that will append the completion, the checkpoint producer, the
plural account bindings, the quota-pressure classification and the production
caller for `decideSwitch` are all later packets, named here only so this design
does not foreclose them. No new event type, wire schema, persistence path, route
or error vocabulary. No capability leaves `UNKNOWN`; nothing here spawns a
provider process, opens a socket or spends. `G1_MOVE_MAP` is untouched. The
frozen contracts and protocol vocabularies are unchanged.
