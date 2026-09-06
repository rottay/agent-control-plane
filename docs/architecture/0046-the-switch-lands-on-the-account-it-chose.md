# ADR 0046 — The switch lands on the account it chose

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The switch plan declares eleven steps and the plane could perform five of them.

`SWITCH_STEP_NAMES` (`packages/kernel/contracts/src/schemas/execution-boundary/index.ts:90-102`)
lists the sequence, and `decideSwitch` restates it in every plan it builds
(`packages/domains/accounts/src/switching/index.ts:506-518`). What existed
before this packet stopped at step 5. The executor's own claimable prefix says
so by name (`packages/domains/runtime/src/switch-executor/index.ts:146-152`):
the account may be marked, the task may be blocked, the atomic step may be
finished, a checkpoint may be written and the lease may be revoked. Steps 6 to
11 — `SELECT_ACCOUNT`, `READ_ONLY_HEALTH_PROBE`, `OPEN_FRESH_SESSION`,
`REVALIDATE_AUTHORITY_AND_PRESTATE`, `REHYDRATE_CHECKPOINT`, `CONTINUE` — had an
executor for none of them, and the file says why: *"Steps 6-11 need a session
that nothing opens yet, so a record claiming them would be a record of work no
code performs."*

Nothing was allowed to construct the completion either. `L-B1F-1` refused an
`ACCOUNT_SWITCH_COMPLETED` anywhere in the domains or the entrypoints, and its
failure message said the quiet part out loud: *"only the session-opener that
finishes a switch may append one, and nothing opens a session yet."* The
decision module says the same thing twice
(`packages/domains/accounts/src/switching/index.ts:522-533`).

So a played switch parked the attempt. `QUOTA_BLOCKED` has no outbound plan
step: `nextStep` falls through to `stepFrom`
(`packages/domains/runtime/src/core/step-executor/index.ts:246-254`), finds no
step leaving that state, and throws `LifecyclePlanError` — which
`classifyFailure` refuses to settle. ADR 0044 recorded that as deliberate: the
walk stops **visibly** rather than settling a task a landing is still owed. This
packet is the landing that was owed.

Three prior packets made it reachable, and the shape of this one is what they
left behind:

- **F4d gave the landing its destination authority.** `considerSwitch` refuses
  to report a switch that appended no `ACCOUNT_SWITCH_STARTED` row, in its own
  words (`switch-executor/index.ts:575-581`): *"the destination authority a
  landing reads would not exist."* So the landing consumes a **durable record**
  rather than a decision. It carries no `SwitchPlan`, and the daemon holds no
  `@acp/accounts` symbol.
- **F4c relocated the account-action door**, and F5 does not touch it. The
  landing appends one control-plane event and no `AccountActionEvent`;
  `L-F4C-1` keeps exactly one door and reads 135 sources after this packet, as
  do `L-B1F-1` and `L-F3-1`, which share its scope.
- **F2/F2b made the destination bindable.** Every admitted binding carries its
  own declared provider, so the landing's cross-provider check costs no import
  and no `describe` call.

## Decision

**The landing is a restart-time interposition in the daemon, before the walk's
route is bound.** It reads what the plane already recorded, admits a destination
the config already carries, calls the walk's own conformance gate once, and
appends exactly one event.

**Why restart-time.** There is no in-process continuation to interpose on. The
play happens inside the supervisor's catch
(`packages/domains/runtime/src/drivers/sqlite-supervisor/index.ts:479-481`), and
a `SWITCHED` answer **rethrows the original error**; `startDaemon` unwinds and
the process ends. Everything the landing needs is durable by then, so the next
start is where the switch can be finished — and it is the only place the route
can still be bound to the account the switch chose.

**The daemon binds a route at two sites, and the landing interposes at both.**
`startDaemon` forks once, into the single-walk form and the many-walks form, and
each binds its own route and composes its own seam. Landing only the first would
leave a switched walk under concurrency permanently unlandable, and silently.
The seam counts do not move: there are still exactly two execution seams, two
pressure sinks and two switch-port seams, because the landing composes nothing
new. It is the file's own idiom, stated at its second gate site: *"One law, two
call sites."*

**The dispatch, at each seam, in order.** The `switch.landed.1` key is probed
**first**. A durable completion means the walk is landed — the destination route
comes from what was recorded, no switch port is composed, and the generation is
the completion's own. Absent, the task is read: no task, or a task that is not
`QUOTA_BLOCKED`, owes nothing, and the walk binds the source route and composes
its switch port exactly as it did before this packet. Only a blocked task
reaches the landing proper. The probe has to precede the state read, and that is
not a preference: after a durable completion the task is `RUNNING`, so a state
check taken first would refuse the very restart it exists to serve.

**Preconditions, each read and refused rather than assumed:** the attempt is the
ledger's latest; `switch.3.account_switch_started` is durable and names a
destination; `switch.1.task_state_changed` is durable and left `RUNNING`; and
the `run.started` INTENT is durable.

**Then, in order:** the destination is the started row's `toAccountId` and
nothing else — never `bindings[0]`, never `route.accountId`, never "the first
that admits", and `L-F5-1` keeps it that way in both directions. The
destination binding's own declared provider must equal the route's, or the
landing refuses `DESTINATION_UNLANDABLE` — the same word `considerSwitch` uses,
for the same reason. The destination route is the submission's route with
`accountId` replaced and every other field carried verbatim, re-parsed so the
contract's CLI-provider refinement applies. `healthProbe` is asked, and its
refusal set is exactly `FAILED`: `UNKNOWN` is the only answer the CLI leg can
give for a bound account, and reading it as `OK` would report the configuration
rather than the transport. Nothing is spawned.

**The prestate is revalidated through the one gate, once, before the append.**
The landing calls the value `conformanceGateFor` returns — the seam's own
closure — rather than building a second digester. A violation records the
finding, quarantines the task to the terminal `SUSPECT_WORKTREE` and throws.
The consequence is stated rather than hidden: a pre-landing violation writes
`conformance.<n>.<i>` rows under the names the post-effect gate would use, so an
identical finding replays and a different one conflicts — and the conflict is
the correct refusal.

**No session is opened.** Step 8 is an admission, not a spawn. The completion's
`sessionId` is **a name the resumed walk will execute under**, not a claim that
a process exists; the session itself is opened by the walk's own effect, and
only when the intent's probe says the work is not already done. The name is
derived by the one producer that owns it, in the providers edge, and reaches the
landing as a closure — because `@acp/runtime` may not import that package and
restating the scheme would be the second naming scheme that producer's docblock
forbids.

**One append, last.** `ACCOUNT_SWITCH_COMPLETED` under `switch.landed.1`, with
`fromState: QUOTA_BLOCKED` and **`toState` read from the blocked row, never a
literal** — the player takes the pre-block state from its caller, and nothing in
the type system makes it `RUNNING`. `causationId` is the started row's own
`eventId`, a durably-present predecessor. The payload is four bounded scalars:
`{fromAccountId, toAccountId, sessionId, generation}`. No clock and no random
source, so a repeated landing rebuilds byte-identical bytes and the ledger
replays it. `switch.landed.1` cannot collide with a played row: the executor
derives ids from plan positions, and `landed` is not an integer.

**A durable OUTCOME does not refuse the landing.** The last precondition
requires the durable INTENT and says **nothing about the OUTCOME**. This
deliberately departs from the pre-audit's `intentIsOpen` parenthetical while
honouring its C17 sentence. `intentIsOpen`
(`packages/domains/runtime/src/failure/index.ts:316-333`) is two conditions —
INTENT present **and** OUTCOME absent — and importing it whole would refuse a
landing whose OUTCOME is already durable, stranding the legitimate crash window
that opens after an effect has completed. The step executor already owns that
question, and answers it correctly in one line (`step-executor/index.ts:240`):
`RUNNING` resolves to the outcome step when the outcome is absent and to the
step after it when the outcome is durable. Both are lawful, and the landing
refuses neither. It does not import, restate or reimplement `intentIsOpen`.

**A landing is the derived completion of an authorization already given.** There
is no `execution.landing.enabled`, no expiry rule and no renewed authorization
field. The operator's explicit exit is the existing cancel operation. A second
veto would duplicate an authority the ledger already expresses durably, widen
the write-set and create a fail-open configuration seam; and ageing a routing
decision is a routing judgement, which belongs to routing policy and is not
invented here.

**No switch port is composed on a walk this process landed.** An unlanded walk
retains its port; a landed one has none at all, so a second switch cannot be
considered, played or declined. This is the deliberate invariant — one landed
attempt cannot initiate a second switch — and it replaces an accident:
`ACCOUNT_MISMATCH` used to stand in the way only because the route had been
re-elected, which is a fact about routing rather than about landings. The
suppression is a **runtime condition inside `switchPortFor`**, never a deleted
literal: `L-F4D-3` reads the text of each `runSqliteMode({` literal, so both
sites keep their `switchPort:` member and the lease beside it, and the note
stays at two.

**`L-B1F-1` moves rather than being worked around.** The law that forbade every
producer gains exactly one named permitted site — the landing module — in
`L-F3-1`'s shipped shape: a named literal, a site counter, an explicit vacuity
guard, and a note printing both the site count and the scope. Its failure
message is rewritten, because "nothing opens a session yet" stops being true and
the landing is not a session-opener either.

**The usage transition id gains a generation.** After a landing the destination
re-executes the **same operation**: `operationName` carries the invocation, the
task, the attempt, the transition id and the plan index, and names no account.
So the destination emits usage entries at the same step indices under the same
name with a different account in the payload, and the ledger fails closed on the
second append. The name is now
`usage.<generation>.<operationIndex>.<stepIndex>`, spelled uniformly, with every
unlanded caller passing `0` and nothing zero-special-cased. The generation
reaches both existing sinks through the daemon's existing closures, so there is
no third seam and no `execution-effects` edit.

**`WRITE_CHECKPOINT` and `REHYDRATE_CHECKPOINT` are recorded as not performed,
and exit 2 was taken.** `Checkpoint.lastAtomicStep` is a required non-nullable
object (`packages/kernel/contracts/src/schemas/checkpoint/index.ts:36`), so the
switch's own checkpoint is not expressible mid-walk: a walk that has completed
no atomic step has nothing to name there, and inventing one would put a fiction
in the ledger. `CheckpointPort.read` stays declared and called nowhere in any
`src` after this packet, deferred to an F3 successor rather than edited.
**Rehydration therefore means exactly two things**: the destination inherits an
unmoved worktree and the same ledger. The worktree is pinned by the parser, not
merely by an invariant — `parseExecutionSection` refuses a config whose bindings
declare different workdirs
(`packages/entrypoints/daemon/src/daemon-child/index.ts:410-421`), in its own
words: *"One worktree per packet. A switch must not lose context, so a switch
must not move the checkout."* It is never an artifact and never a prompt
injection.

**Why the resume is continuous.** The submission digest pins all six route
fields, including the account, and it is **immutable across a landing**: the
landing does not recompute it and `submission/index.ts` is not touched. What
makes a destination-route resume continuous instead of a continuity failure is
that step 0 is a `PLAIN` beat and carries no route, so
`assertInvocationContinuity` rebuilds identical bytes. The attempt must not move
either, because the evidence marker is keyed by it.

**A cross-provider destination is refused three times over** — at the config
door, in the player, and defensively in the landing — which is why
`eligibility.providers` **still has no reader** after this packet. The landing's
own check is present so a hand-built row cannot walk past it, not because a
production-produced row could reach it.

**The lease is neither released nor re-taken by the landing.** It takes none,
releases none and renews none. A landed walk runs under a **new** lease on the
**same** worktree: the arbiter grants it, and the recorded revocation from the
play does not block a successor.

**The Restate leg is excluded.** The same dispatch runs there and can never
reach the landing: the door refuses a `switchAuthorization` under `RESTATE`
(`daemon-child/index.ts:586-589`, `:731-735`, and again in `startDaemon`), so no
play exists that could leave a task `QUOTA_BLOCKED`. Rebinding a route inside a
live invocation is a second design, and it is not this one.

**The failure vocabulary is closed, ordered cheapest-first, and F5's own:**
`ATTEMPT_MISMATCH`, `NOT_BLOCKED`, `SWITCH_NOT_STARTED`,
`RESUME_STATE_UNSUPPORTED`, `DESTINATION_UNBOUND`, `DESTINATION_UNLANDABLE`,
`ROUTE_INVALID`, `TRANSPORT_UNHEALTHY`. Every member refuses **before any
append**, so a refused landing leaves the ledger head where it was and the task
at `QUOTA_BLOCKED` — the same visible stop ADR 0044 describes. It extends no
frozen enum. Three words are reused rather than invented, because they refuse
the same thing for the same reason one layer up.

**The seven crash windows, and the state none may reach.** Play complete with no
landing: the landing runs from the start, and no completion exists to be false.
Gate passed, append not reached: identical, and the gate is re-run. Append
durable, walk not started: the probe finds the landing, returns it and lands
nothing. Mid-execution on the destination: the walk re-executes, keyed by the
generation the completion carries. Destination OUTCOME durable: the walk
finishes and F3's terminal checkpoint assembles. Landed but the provider not
re-invoked: the intent's probe answers `DONE` and the outcome is appended from
existing evidence, with zero destination executions. Landed with a stale
authorization still in the config: no switch port is composed at all, so there
is nothing to decline.

**The forbidden state, which is the design's whole safety claim:** no
`ACCOUNT_SWITCH_COMPLETED` is durable without a destination-bound, admitted,
gated route resolved in the same process; and no destination session is opened
without a durable completion. Both halves hold by ordering — the gate precedes
the append, the append precedes the route binding, and the route binding
precedes any `start`. The second half is structural rather than drilled: the
landing has no `start` call to get wrong.

**The INTENT records where the run was admitted; the completion records where it
landed.** A reader needs both, and neither restates the other.

## Why refusing a durable OUTCOME was not chosen

Importing `intentIsOpen` whole would have been the smaller diff and the wrong
rule. It answers a different question — is this intent still open — and a
landing does not need that question answered. The crash window after an effect
has completed but before its outcome was appended is legitimate and recoverable,
and a landing that refused it would leave the attempt parked with cancellation
as its only exit. Two state machines would then own the same decision, and they
would eventually disagree. One line in the step executor already owns it.

## Why a second authorization was not chosen

The alternative was a `execution.landing.enabled` field, or an expiry on the
recorded authorization, so an operator could veto a landing without cancelling
the task. It was rejected for three measured reasons. The authority is already
expressed durably: the elector decided, the door admitted, and the player
appended a started row naming a destination — a landing completes that, it does
not begin anything. A configuration toggle that defaults to permitting is a
fail-open seam in the one path whose entire purpose is to fail closed. And
ageing a routing decision is a routing judgement; a walk may not make one. The
operator's exit already exists, and it is `cancel`.

## Why a positional destination was not chosen

Reaching for `bindings[0]`, or falling back to the route's own account when the
named destination is unbound, would make the failure quiet: the switch would
finish, on the wrong account, with a completion indistinguishable from a correct
one. `DESTINATION_UNBOUND` is a refusal for the same reason `NO_DESTINATION` is
one layer up — the walk may not choose, because choosing is routing. `L-F5-1`
makes it mechanical in both directions, and its negative control is the three
lawful `find`s on account identity that serve the route or the decided
destination.

## Consequences

- **`ACCOUNT_SWITCH_COMPLETED` has exactly one producer**, named by
  `L-B1F-1`, with a vacuity half. The law's scope moves 134 → 135 together with
  `L-F3-1`'s and `L-F4C-1`'s, which share its shape; a tree where one moved and
  the others did not has a defect.
- **`L-F5-1` is new**: `PATH_SCOPED_LAWS` 110 → 111.
- **`RUNTIME_PUBLIC_EXPORTS` 249 → 255**, in a block disjoint from F4c's.
- **Pre-F5 ledgers re-key their usage rows on resume.** A ledger written before
  this packet carries the two-component spelling, so a walk resumed across the
  commit appends its usage under new keys. Nothing is in operation and every
  ledger in the tree is a drill ledger; the cost is recorded rather than
  migrated around.
- **`pressureTransitionId` has exactly the same exposure and is deliberately
  out of scope.** `pressure.<operationIndex>.<trailIndex>` carries no
  generation, so a source and a destination that both report pressure for one
  operation collide on that key. It is unreachable in production at this HEAD
  because no shipped parser classifies pressure, it is named here so a successor
  does not rediscover it, and this packet's own D7 drill works around it rather
  than pretending it is absent.
- **The trigger is seeded until provider framing lands.** ADR 0044's own
  consequence stands: no shipped parser can produce a quota classification —
  Claude publishes none, and codex and kimi are refused before any spawn. So the
  switch, and therefore the landing, is latent in production. The drills seed
  the exhaustion through the **real** recorder and say so in their titles.
  Everything after the observation is real: the door, the fold, the executor,
  the daemon's lease, the restart and the landing.
- **Two drill windows are constructed rather than signalled**, and the titles
  say that too. `DaemonOptions` carries no fault passthrough, and adding one to
  serve a drill would be a production change made for a test. The durable
  completion window is produced by calling the landing itself against the real
  ledger before the daemon starts; the verified-marker window is produced by
  driving the supervisor's own declared fault seam over the same scenario. No
  process is signalled in this section.
- **`CLAIMABLE_STEPS` does not widen.** The docblock predicted that *"the packet
  that builds the session-opener widens one list"*. It was wrong in a small way,
  and this is the answer rather than an edit to F4d's file two commits after it
  landed: the landing appends directly, widens nothing, and is not a
  session-opener. `CLAIMABLE_STEPS` is still exactly five, `SWITCH_STEPS` is
  still eleven, and `executeSwitchPlan` still refuses a plan carrying a
  completion, by name.
- **No frozen vocabulary moves.** No event type, task state, refusal in a frozen
  enum, wire field, channel, migration or second store. `ACCOUNT_SWITCH_COMPLETED`,
  `QUOTA_BLOCKED` and `RUNNING` all existed and were already channel-mapped.
  That is this packet's defining property.

## Not in this record

The provider-framing packet that would make an exhaustion observable end to end
and lift `DESTINATION_UNLANDABLE` at all three places. The pressure-key
generation. The settlement-interposition question for *non-switched* failures.
The Restate leg. CLI-to-API transport crossing. Resuming a partial play. Any
change to `decideSwitch`'s policy, to `executeSwitchPlan`'s body, or to
`considerSwitch`. The `EXHAUSTED`/`COOLDOWN` vocabulary packet. What a checkpoint
means for a walk that has completed no atomic step. Product cutover of any kind:
nothing here is in operation.
