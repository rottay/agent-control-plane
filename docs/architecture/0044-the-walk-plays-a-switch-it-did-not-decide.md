# ADR 0044 — The walk plays a switch it did not decide

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

Three packets built the parts of a switch and none of them could perform one.

ADR 0041 made provider pressure a durable, attributed fact. ADR 0042 gave those
rows a reader and a decision: the elector folds them into a trigger, calls
`decideSwitch`, and prints a plan. ADR 0043 made a **failing** walk record the
pressure its own trail already carried, instead of discarding it at the throw.

What none of them could do is act. `executeSwitchPlan` had no production caller
since it was written, `ACCOUNT_SWITCH_STARTED` had no producer, and the elector's
plan was a document nothing read back. The landing packet waits on a durable
started row that nothing produced.

Between ADR 0043's drains and the settlement there is one moment where acting is
possible, and it is the only one in the plane:

```
:507   const outcome = await execute(input);
:527   usage drain      over outcome.trail    ─┐ reached on BOTH paths
:549   pressure drain   over outcome.trail    ─┘
:596   if (!outcome.ok) throw new ExecutionEffectError(outcome.refusal, outcome.at);
```

The throw reaches the supervisor's catch, which classifies the failure and then
settles it. **At that instant the task is still `RUNNING`, its INTENT is
durable, its pressure rows are in the ledger, the lease is held, and nothing has
settled yet.** There is one INTENT/OUTCOME pair in the plan, the provider effect
is one beat with no ledger read inside it, and the supervisor re-reads the ledger
only between beats — so no second such moment exists.

## Decision

**The elector decides, the door admits, the walk plays, and no stratum does two
of those.**

A decided switch reaches a walk exactly as its route does: as data. Routing needs
an accounts file, a policy document and a `RoutingRequest`, and the process that
walks a task holds none of them — D5 and ADR 0018 refused precisely the daemon
that resolves in-process. So `SwitchAuthorization` is admitted by
`parseExecutionSection`, the same door that admits `route` and `bindings`, with
refusals by path.

The authorization carries the plan verbatim plus an audit block: who decided,
when, against which account, on which trigger, and **from which recorded pressure
row**. That last field is also the value handed to `executeSwitchPlan`'s
`causedBy` — the cross-task cause that field was designed for.

### Data crosses the door; a closure crosses into the walk

The authorization is a value an operator wrote, so it travels with the route. The
**lease** is a live grant this process holds and renews: serializing it into a
configuration document would let a second holder claim the same grant, which is
the shape the enforcement fence exists to refuse. Only a closure can carry both,
and it is the idiom this composition already uses three times — for spend, for
conformance and for pressure.

`L-F4D-3` asserts that every walk seam carrying a switch port also carries the
lease this process actually holds, and that the daemon reaches the executor
through the composed port and by no other path.

### The fork, and what it must not disturb

```
} catch (error: unknown) {
  const decision = classifyFailure(error);            // unchanged
  if (decision.settle && this.#switchPort !== undefined) {
    const played = await this.#switchPort.consider(context);
    if (played.kind === "SWITCHED") throw error;      // settle nothing
  }
  if (decision.settle) await settleFailure(context, decision.reason);
  throw error;                                        // unchanged, always
}
```

`classifyFailure` is **not edited**: it is the shared decision both drivers ask,
so editing it would move Restate's verdicts too. **`SWITCHED` means *do not
settle*; it never means *do not fail*** — the original error is still thrown on
every path. The gate on `decision.settle` keeps the port out of the way of
everything else: a plan failure, a postcondition unknown and a bound exhaustion
never reach it.

The port is optional, and **the optionality is the refusal**: a construction with
no port truthfully cannot switch, which is true of both drill children and every
lifecycle verb, and their behaviour is byte-identical to what it was.

### The walk never decides, and the refusals say which condition failed

`considerSwitch` refuses at the first failure, in order: `NO_AUTHORIZATION`,
`NO_PRESSURE`, `TRIGGER_MISMATCH`, `ACCOUNT_MISMATCH`, `NO_DESTINATION`,
`DESTINATION_UNBOUND`, `DESTINATION_UNLANDABLE`.

The trigger is folded by **F4b's own `foldPressureTrigger`**, never a second
fold, over this attempt's own rows — filtered by task, by attempt, by a
`pressure.` transition id and by a payload carrying a member of the observation
vocabulary. That last filter is load bearing: a played plan appends its own
`QUOTA_WARNING` row with payload `{accountId}` and no `pressure` key, and reading
one of those back would let a switch justify the next switch.

`readAccountPressure` is deliberately not reused here: its `since` is strictly
exclusive and every row of this walk carries `occurredAt = submittedAt`, so it
would exclude exactly the rows this decision is about.

**A mismatch declines; it never re-decides.** Filling a null `selectedAccountId`
from the bindings, ranking two authorizations, or expiring one on `decidedAt`
would each be a routing decision, and `L-F4D-2` makes that mechanical: no runtime
`src` file may name `decideSwitch`, `rankAccounts`, `loadPolicyRegistry` or
`resolveRoute`. One home is exempt by name — `runtime/src/submission/index.ts`,
ADR 0018's own declared home — and the exemption carries a vacuity half so it
cannot outlive its reason.

### What lands, and where it stops

Four rows, named by the executor's own position naming:
`switch.0.quota_warning`, `switch.1.task_state_changed` (`RUNNING →
QUOTA_BLOCKED`), `switch.2.lease_revoked` carrying the daemon's real lease, and
`switch.3.account_switch_started` carrying the destination.

**F4d stops there.** No session, no `ACCOUNT_SWITCH_COMPLETED` — the executor
refuses that by name — and no continuation. The attempt ends at `QUOTA_BLOCKED`
with its INTENT open, which is exactly the state a landing requires.

## Why `decidedAt` is audit and not policy

Nothing expires an authorization on it. How old a decision may be before it stops
meaning anything is a routing judgement, and the walk may not make one. What it
buys is that the row a reader finds later can be aged, and that this record can
state the window rather than leave it implicit. **A max-age check would be a
routing decision**, and a test asserts an arbitrarily old authorization still
plays.

## Why a partial play is not resumed

A crash between the switch's rows leaves the attempt at `QUOTA_BLOCKED` with its
INTENT open. On restart `nextStep` finds no step for that state and throws a plan
error, which `classifyFailure` refuses to settle — so the walk stops **visibly**
rather than settling a task a landing is still owed, and it forges no started row
it did not earn. The operator's exit is the cancel verb, which proceeds from any
non-terminal state.

Resuming instead would require `executeSwitchPlan` to skip rows already durable —
a behaviour change to a module this packet calls and does not touch. That belongs
to the landing packet or a successor.

The mechanism is measured rather than asserted: a second play rebuilds row 0 from
the ledger's **new** current state, producing a different `fromState` and a
different body under the same idempotency key, and the ledger refuses it. That
refusal is what makes **one switch per attempt** structural rather than a policy
this module invented.

## Why a cross-provider destination is refused

A plan naming a codex or kimi binding is playable — the binding is present — and
never landable: the session that would land it is refused before any spawn. One
switch per attempt is structural, no plan step leaves `QUOTA_BLOCKED`, and the
only exit is cancellation. Starting a switch known not to finish would park the
attempt.

So the door **and** `considerSwitch` refuse `DESTINATION_UNLANDABLE` when the
destination binding's declared provider differs from the route's. The daemon
already holds every binding's provider (ADR 0040), so the check costs no import
and no handshake. **A temporary refusal, inherited from the provider-framing
decision, and lifted by the packet that lifts it.**

## Why the alternatives were not chosen

**The walk decides.** ADR 0018 quotes D5 verbatim rejecting the daemon that
resolves in-process from an accounts file, and `L-B7S` closes the proxy route.
`L-F4D-2` now closes the stratum below it.

**The walk suspends and polls.** The scheduler has *"no retry loop, no
backpressure and no waiting room"*, and no external door exists — the signal
handler takes only SIGTERM and SIGINT.

**The elector takes the lease.** A second acquirer bumps it, the renewal reads
`lost`, and the abort path reaps the provider children: the elector would kill the
walk it is switching.

**The daemon spawns the elector.** It still needs accounts and policy paths in the
daemon's configuration — Shape A with a pipe in the middle.

**Carrying the plan in an error.** An error object holding a plan is one
`JSON.stringify` from a log line, and `classifyFailure` branches on the class
alone. The same reasoning ADR 0043 used for the trail.

**Admitting a fragment.** An operator merging a plan into a config by hand is a
second door: nothing would stop them pairing one packet's plan with another
packet's route, and each half would parse. The elector prints the **whole**
document instead.

**Redacting `worktreePath`.** Refused, with evidence: the enforcement fold
compares `lease.worktreePath` against the candidate's, and *"each payload carries
the whole lease, so the fold is computable from the ledger alone."* A redacted
path makes lease history uncomputable — the exact property the unified payload
exists to guarantee. And the surface is not new: the arbiter appends
`LEASE_ACQUIRED`/`LEASE_REVOKED` with `{leaseId, worktreePath, holder, cause}` at
every grant and release, and the conformance gate appends the quarantine's
revocation with the same field. **F4d is a third producer of an existing
surface.** The exposure is named here, its bound stated — a worktree path, never
a directory outside the repository root — and narrowing it is its own packet, one
that would have to give the fold another way to compute lease identity.

## Consequences

**`executeSwitchPlan` has a production caller for the first time**, and
`ACCOUNT_SWITCH_STARTED` has a producer. The landing packet's destination
authority now exists.

**The switch is latent in production until provider framing lands, and the drill
says so in its own title.** At this HEAD no shipped parser can produce a quota
classification: Claude publishes none, and codex and kimi are refused before any
spawn. So the real drill **seeds** the exhaustion — through the real recorder,
under a `pressure.` transition id for the attempt — and everything after the
observation is real: the door, the fold, the executor, the daemon's own lease,
and the supervisor that does not settle. This is the same honesty ADR 0041 used
for the quota half, and the production reach arrives with the framing packet.

Two measured details the seeding surfaced, recorded so a successor does not
rediscover them: the walk's own drain occupies the trail position it observed, so
a seeded row must take a position the trail cannot reach; and the cross-task
cause must be a row of **another** task, because a decision is taken from
evidence recorded before this walk.

**Two `LEASE_REVOKED` rows exist per lease on a switched walk** — `switch.2` with
cause `ACCOUNT_SWITCH`, and the arbiter's own `RELEASED` on the unwind, which
reads the current state at flush time and is a lawful passthrough at
`QUOTA_BLOCKED`. The enforcement fold tolerates a second revocation of an
already-terminal id.

**One window is widened**: between `switch.2.lease_revoked` and the unwind's
actual release, the ledger says the lease was revoked while the process still
holds it. Bounded by the unwind, identical in shape to what shipped before, and
no reader acts on `LEASE_REVOKED` today.

**The Restate lane refuses an authorization at the door**, with a classified
error naming the deferral. Silence would let an operator write one, watch the
daemon start, and believe a switch was armed in a mode with no such fork.

**A first walk on an account cannot switch**, because the elector needs a
recorded pressure row to decide from. That is true of an account's first
pressure, not of a task's first walk: the elector reads by account, so a new task
on an already-exhausted account can carry an authorization on its first walk.

**`MARK_ACCOUNT_DRAINING` still records nothing.** F4d records that a switch
*started*; it moves no account state. That remains the account-state packet's
question, and that packet is now downstream of this one.

**Pins.** `PATH_SCOPED_LAWS` 106 → 109; the ADR corpus 43 → 44;
`RUNTIME_PUBLIC_EXPORTS` 242 → 246; `CONTRACTS_SCHEMA_EXPORTS` 101 → 104.
`ACCOUNTS_PUBLIC_EXPORTS` stays **82**, the scope notes stay at 134 / 123 / 20 /
418 / 151, the execution seams stay **2**, and `CONTRACT_VERSION`, the 24-name
event vocabulary, the 24 → 5 channel map, the 20/4 routes, `SWITCH_STEPS` **11**,
`CLAIMABLE_STEPS` **5** and the six migrations are unchanged. No package source
or test file is created.

## Not in this record

The landing — no session is opened, no checkpoint rehydrated, no completion
appended. The account-state seam. The settlement-interposition packet, which
decides whether *non-switched* failures settle and which this packet leaves
untouched. The provider-framing packet that would make a real exhaustion
observable end to end and lift `DESTINATION_UNLANDABLE`. Resuming a partial play.
Any UI, console, protocol or API surface, and every form of cutover.
