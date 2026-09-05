# ADR 0042 — The elector reads the pressure the plane recorded

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0041 made provider pressure a durable, attributed fact: a walk that observes
a provider refusing an account records one row naming the account, the provider
and the classification. **Nothing read it.**

`packages/domains/runtime/src/pressure/index.ts` exported a recorder and no
reader. No `src` file anywhere read a `QUOTA_WARNING` or `AUTH_REQUIRED_RAISED`
row back. `decideSwitch` (`packages/domains/accounts/src/switching/index.ts`) —
the module that turns pressure into a lawful plan — had **no production caller
since it was written**; its only other `src` occurrences were the accounts
barrel and two docblocks. And `SwitchRequest.trigger` is a bare `string` because
classification is that module's own first job, so nothing in the plane produced
a value for the one field the decision turns on.

That is the shape this wave exists to remove: **structurally live and
behaviourally empty**. F4a's rows were real, durable and unread; the decision
policy was written, tested and uncalled.

Everything the decision needs already existed and was composed exactly once, in
the CLI's re-election verb (`packages/entrypoints/cli/src/cli/index.ts`): the
accounts file, the policy registry, the operator-state overlay that refuses
rather than falling back, the exhaustive usage read, the estimator call, and one
clock read. `decideSwitch`'s own docblock says that composition *is* its
`routing` field.

So the missing pieces were exactly three: a reader, a trigger fold, and a caller
that reuses the composition rather than building a second one.

## Decision

**One reader, one fold, one verb. The plane's recorded pressure reaches the
switch decision policy in production, and what was observed and what was decided
are both visible. Nothing is executed, landed, mutated or appended.**

`readAccountPressure` lives **inside F4a's own module**, beside the recorder,
because `usage/index.ts` already holds both halves and the discriminator that
decides what counts as a row of this kind must be written once. It is the third
sibling of `readAccountUsage` and `readAccountActions`, and it adds no package
edge: `@acp/accounts` owns the arithmetic and may not import a ledger, so the
paging lives on the side of the boundary that may.

`foldPressureTrigger` lives in `@acp/accounts`, **beside `SWITCH_TRIGGERS`**,
for one mechanical reason: `isTrigger` is module-private, and the fold's whole
job is to ask it. A fold anywhere else would need that predicate exported,
putting the fail-closed boundary on the public surface where a caller could
route around it.

The verb is `acp switch-decision`, inline beside the re-election verb rather
than in a module of its own — a new `packages/entrypoints/*` source would force
a mirrored test path under the topology law and move five scope notes for no
gain.

### Severity is declared, not assumed

The fold walks `SWITCH_TRIGGERS` **in its declared order** and returns the first
member some observation proves under `isTrigger`. That array is
`["QUOTA_EXHAUSTED", "QUOTA_WARNING"]` — already most-severe-first, but until
this packet only by alphabetical coincidence. Its docblock now states the order
as a law of that module, and **a test pins the exact list in order** rather than
by membership.

This matters because the fence's `L-V2B1F4-4` compares that vocabulary against
the contract's observation vocabulary **as a set**, in both directions, and
deliberately still does: the two genuinely are sets, and a set comparison would
let anyone re-sort the array without a single check firing. The ordering is
therefore this module's own claim, enforced by its own test, and `L-F4B-2`
forbids the fold from declaring a severity of its own in either of the two forms
that would let it: a quoted `"QUOTA_…"` literal, and a
`{ QUOTA_EXHAUSTED: 0, QUOTA_WARNING: 1 }` severity record that would pass a
string-only check while defeating its entire purpose.

An exhaustion therefore decides even when a warning was recorded after it, and
`causedBy` names the deciding member's own latest row — not the newest row
overall. All ties are broken by the ledger's `sequence`, never by `occurredAt`:
F4a rows carry the walk's submission instant, so two rows of one walk are
indistinguishable by time and only the ledger's monotone position orders them.

### An authentication requirement is never a trigger, and is never anonymous

`AUTH_REQUIRED` refuses `NO_TRIGGER_CLASSIFIED` **with `at` naming the member**,
and every arm of the fold — success and refusal alike — carries an `observed`
summary: a count per observed vocabulary member, plus the latest row's id and
instant.

This is not decoration. At this HEAD the **only** pressure a real daemon can
observe is claude's `auth_required` frame (ADR 0041): codex and kimi stay
refused at `startSession` until framing is authorized. A verb that answered the
one production-reachable case with a bare `decision: "NONE", reason:
"NO_TRIGGER_CLASSIFIED"` would print, for the only thing that actually happens,
the same words a malformed row would produce — and the operator action that
answers it (`REAUTH_REQUIRED`) would never be suggested by anything.

It is not a gap that the trigger cannot carry it: `decideSwitch` reaches its
escalation branch from the **folded account state**, never from the trigger.

### A decision may never feed its own next decision

A row counts as an observation only if `payload.pressure` is a member of the
observation vocabulary **and** `payload.accountId` and `payload.provider` are
non-empty strings. Anything else is **skipped, not refused**.

That is not hypothetical. `decideSwitch`'s own DRAIN plan emits a
`QUOTA_WARNING` event and its escalation emits an `AUTH_REQUIRED_RAISED`, both
with payload `{accountId}` and no `pressure` key. The day a successor plays such
a plan, those rows must not read back as observations — a decision that folded
its own output would ratchet itself. The discriminator makes that structural
rather than remembered, and it is skipped rather than refused because such a row
is lawful: the ledger is not malformed, it simply holds something that is not an
observation.

**The mirror rule belongs to the landing packet**: read only rows whose
transition id is `switch.<n>.<type>`, never a pressure row.

### The reader is exhaustive, bounded, and refuses rather than truncating

Both event types are paged to exhaustion, because the fold must see an auth-only
account to refuse it honestly. Above `PRESSURE_OBSERVATIONS_MAX` the reader
returns `PRESSURE_HISTORY_EXCEEDED`: folding a prefix would let an exhaustion at
row *n+1* read as a warning, and this is a set where the **most severe** row
decides rather than the newest. An empty result is a success and means what it
says. A read failure is never coerced into it.

`since` is the account's own `quotaEstimate.estimatedAt` — the same baseline the
usage reader uses, so pressure and spend cannot disagree about "since when" —
and the comparison is **strictly exclusive**, the usage fold's rule verbatim: a
row at the exact instant the baseline was published is already inside it. An
unparseable `since` is refused (`SINCE_INVALID`) rather than treated as the
beginning of time, so the reader is total even though the one production caller
passes a contract `Timestamp` and cannot reach that refusal.

### Nothing is appended, and that is structural

The CLI opens its ledger `readOnly: true`, which puts SQLite itself in
query-only mode, and hands *that* handle to the verb. An append is a
database-level error rather than a policy violation. `L-F4B-1` keeps it that
way by name: the verb's own region — bounded by two **literal** anchors, so it
cannot silently grow to the end of the file — may not name `executeSwitchPlan`,
`recordAccountAction`, `appendAccountAction`, `.append(` or a second
`openLedger(`.

There is therefore no crash window, no replay semantics, no idempotency key and
no partial state to design.

## Why the plan is printed and not played

`executeSwitchPlan` refuses a plan carrying `LEASE_REVOKED` without a real
`Lease`, and the only lawful producer of one is the daemon's arbiter. An
out-of-process elector cannot construct one without forging enforcement state.
A `DRAIN` or `ESCALATE` plan needs no lease — but by the time any out-of-process
reader can see a pressure row, the task that produced it is already past its
`run.outcome`: the walk writes the row inside the open INTENT and closes that
INTENT immediately afterward, with no suspension between. **A decision that
moved that task would move a task with nothing left to do.**

What is still worth deciding is the account-side question, which is what the
DRAIN branch says in its own words: a warning drains, and the account stops
taking new work while the packet in flight finishes on it. That is why this
packet is account-scoped rather than task-scoped.

## Why no account state is written

The owner file is written by nothing in the plane, and this packet does not
become the first. An `AccountActionEvent` carrying `DRAIN` would map onto the
plan's `DRAINING` exactly — but the only implementation lives in an entrypoint
the CLI may not import, and reproducing its baseline read, fold, no-op refusal,
monotone `version` and race handling elsewhere is the duplication this packet
exists to avoid. For a `SWITCH` plan it is worse than duplication: the plan
yields `EXHAUSTED` or `COOLDOWN`, and **no `ACCOUNT_ACTIONS` verb produces
either**; `OWNER_OVERRIDE` would forge an owner's decision.

The account-state transition the switch executor names by hand as unowned is
therefore answered here **in evidence and not in code**, and left to the packet
that moves `recordAccountAction` out of the gateway.

## Why the routing composition was extracted rather than copied

The submission verb built exactly the request the decision verb needs. A second
copy would be a second registry that could disagree with the first about which
accounts exist and what they have left — with a second operator-state overlay, a
second usage read, a second estimator call and a second clock read, each free to
drift. `composeRoutingRequest` is called twice and reads one clock; the
re-election verb's output is byte-identical afterwards, which its existing suite
asserts.

## Why the fold was not put in the runtime

It would have required exporting `isTrigger`. The predicate is the fail-closed
boundary between what a provider said and what may move a task; a caller holding
it could route around the vocabulary entirely. The fold goes where the predicate
already is, and the reader — which needs a ledger the accounts package may not
import — stays on the other side of that boundary.

## Why a severity constant was not exported

An exported `TRIGGER_SEVERITY` would restate the two names in a second place,
which is the drift the vocabulary exists to prevent, and would move
`ACCOUNTS_PUBLIC_EXPORTS` for a fact the array itself already carries. The order
is documented on the array and pinned by a test instead.

## Consequences

**`decideSwitch` has a production caller for the first time.** A recorded
exhaustion now yields a `SWITCH` plan naming a real destination account, a
recorded warning yields a `DRAIN`, and both are printed rather than performed.
The trigger derivation is one tested, fail-closed function instead of something
each future caller would invent.

**The verb requires `--model`, and that is a measured consequence rather than a
convenience.** `decideSwitch` ranks the other accounts by calling `rankAccounts`
**directly**, and that admission reads
`record.enabledModels.includes(task.model)`. The submission verb never states an
alias because the policy seam above it chooses one and re-ranks per candidate
model (`accounts/src/policy/index.ts`, which calls `rankAccounts` once per
eligible entry with that entry's own alias). A verb that ranks without that seam
and left the alias empty would find **every account ineligible whatever its
quota**, and every exhaustion would refuse `NO_ELIGIBLE_ACCOUNT` — a fail-closed
answer that reads exactly like "there is nowhere to go" when the truth is
"nobody said where from". The alias is therefore required and never defaulted,
for the reason a token budget is never guessed. **The brief did not measure
this**; it is recorded here so the successor packets inherit the fact.

**The observation window is walk-granular and there is no staleness policy.**
F4a rows carry `occurredAt = invocation.submittedAt`, so the fold sees every
pressure row of every walk submitted after the account's published baseline,
**with no reset awareness**: an exhaustion recorded before a reset window passed
keeps yielding a `SWITCH` recommendation until the owner republishes the
estimate. `decideSwitch` already reads the estimator's reset to choose
`COOLDOWN` over `EXHAUSTED`, which is the only reset reasoning in the plane.
Adding a second one here would be a routing judgement made in an entrypoint, so
the verb prints `since` and the deciding row's `occurredAt` and leaves the
judgement where it belongs. **The omission is chosen, not overlooked.**

**Nothing durable is produced, so this packet alone does not make a landing
reachable.** No `TASK_STATE_CHANGED` for a switch, no `ACCOUNT_SWITCH_STARTED`,
and no account reaches `EXHAUSTED`, `COOLDOWN` or `DRAINING`. The packet the
landing actually waits on is the one that carries a decision into an open walk
and plays the plan while something still holds the daemon's lease — and that
packet's design turns on a settlement question nobody has answered yet.

**A finding against ADR 0041's committed tree, recorded here because it has no
other home.** `apply` reaches the usage drain, the pressure drain, the
conformance gate and the evidence marker **only if `execute` returned**. A
stream that ends in an `error` terminal, or with no terminal at all, throws
first (`execution-effects/index.ts:416-417`) and **the fully-built trail —
pressure events included — is discarded**; the task then settles `FAILED`
terminally. So:

| Shape | Terminal | Pressure recorded? |
| --- | --- | --- |
| provider reports quota, exits cleanly | `completed` | **yes** |
| provider reports quota and dies, or the session state is `FAILED` | `error` | **no — nothing at all** |
| the stream fails to normalize | `error` | **no** |

**ADR 0041 records the crash-window loss and is silent on the error terminal**,
and the postaudit that accepted it did not surface this. The accept stands on
its own terms — that packet implemented its ratified brief, which placed the
sink exactly where the usage sink is and never claimed the error path. Whether
an execution ending in `error` should record the pressure its own trail already
carries is a design decision nobody has taken. It is named here so an errata
packet inherits a measured question; this packet does not absorb it, because
editing an F4a path inside a successor would make the diff unaccountable to
both. It is not a blocker: the reachable DRAIN path runs entirely on rows the
success path records.

**Cite corrections carried forward**, so the next rebase does not copy them: the
two daemon execution seams are at `daemon/src/index.ts:651` and `:979` (not
`:649`/`:952`); `L-B7S` is at `check-architecture.mjs:11698`; the region-slicing
law `L-C-4b` is at `:17844`; `SwitchRequest` is at `switching/index.ts:165-182`.

**Pins.** `ACCOUNTS_PUBLIC_EXPORTS` 76 → 82, `RUNTIME_PUBLIC_EXPORTS` 239 → 242,
`PATH_SCOPED_LAWS` 103 → 105, the ADR corpus 41 → 42. The five scope notes stay
at 134 / 123 / 418 / 20 / 151, because no new package source or test file is
created. `CONTRACT_VERSION`, `API_CONTRACT_VERSION`, the 24-name event
vocabulary, the 24 → 5 channel map, the 20/4 routes, the six migrations,
`CONTRACTS_SCHEMA_EXPORTS`, `PROVIDERS_PUBLIC_EXPORTS`, `DAEMON_PUBLIC_EXPORTS`,
`SWITCH_REFUSALS`, `SWITCH_STEPS` and `ACCOUNT_ACTIONS` are unmoved.

## Not in this record

The account-state seam that would let an elector record what it decided. The
packet that carries a decision into an open walk and plays the plan. The
settlement interposition it turns on. The landing that opens a session on a
second binding and appends a completion. The errata for the error-terminal
finding above. The usage recorder's step-index collision. Any rollup or
projection over pressure rows, any UI, console, protocol or API surface, and
every form of cutover.
