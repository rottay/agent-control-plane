# ADR 0043 — A failed execution records what its trail already said

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0041 made provider pressure durable: a walk that observes a provider
refusing an account records one row naming the account, the provider and the
classification. ADR 0042 gave those rows a reader and a decision.

**Neither noticed that a failed execution recorded nothing at all.**

`execute` in `packages/domains/runtime/src/execution-effects/index.ts` built the
trail, validated event by event by the port as it was yielded, and then threw at
each of its three refusal points. `apply` calls it once and reaches the usage
drain, the pressure drain, the conformance gate and the evidence marker **only
if `execute` returned**. So on every error terminal — and on a stream that ended
with no terminal at all — a fully built, contract-validated trail was discarded
by the `throw`, and there was no second copy: `apply` never saw it. The task
then settled `FAILED` and the evidence was gone.

**The asymmetry ran exactly backwards.** A provider that reported pressure and
kept working recorded it reliably. A provider that reported an exhaustion and
then died recorded nothing — and the second is the case an elector exists to
answer.

| Shape | Terminal | Pressure recorded before this errata |
| --- | --- | --- |
| provider reports pressure, exits cleanly | `completed` | **yes** |
| provider reports pressure, then the stream fails | `error` | **no — nothing at all** |
| stream ends with no terminal | none | **no** |
| `port.start` refused | — | no, correctly: no stream existed |

ADR 0041 records the crash-window loss between the drains and the marker and is
**silent on the error terminal**; the postaudit that accepted it did not surface
this. That accept stands on its own terms — the packet implemented its ratified
brief, which placed the sink exactly where the usage sink is and never claimed
the error path.

### Which failures actually reach that terminal — measured, because an earlier account was wrong

An earlier draft of this record said "the provider reports quota and dies"
reaches the `error` terminal through `finish()`. **Measured at `ad27b90`, that
example is wrong.** `session.fail()` is invoked only from a digest failure or a
read-only violation; a child that simply *exits*, with any exit code and without
a `result` frame, reaches `onExit → end()` only, `finish()` finds no `FAILED`
state, returns `null`, and `terminated` yields **`completed`**. A dead provider
is read today as a completed execution — its pressure was already recorded by
that path, and a marker was written.

The real producers of an `error` terminal are exactly six: a signal the port
cannot express; a normalized event that fails the `ExecutionEvent` contract; a
malformed or unrecognized frame; an output budget exceeded; a read-only
violation; and a stream that ends without a terminal. The defect is real and the
value of this errata is unchanged — but its account of the reach had to be
exact, and this is it.

**A fourth finding follows from that measurement and is left to its owner**: a
premature child exit with no terminal frame produces `completed`, not `error`,
so the port's terminal law is weaker than its docblock claims. It belongs to the
reachability packet, not to this one.

## Decision

**An execution that produced a trail records the pressure and the spend on it,
before it refuses.** `execute` returns instead of throwing; both drains move
above the refusal; the refusal stays above the conformance gate and the marker.

```
const outcome = await execute(input);   // was: const trail = await execute(input)
  usage drain      over outcome.trail   ─┐ reached on BOTH paths now
  pressure drain   over outcome.trail   ─┘
if (!outcome.ok) throw new ExecutionEffectError(outcome.refusal, outcome.at);
  conformance gate                      ─┐ unchanged: success path only
  writeMarker                           ─┘
```

### Why a result union and not an error carrying the trail

Both shapes would let `apply` see what a failed execution observed. The union is
right on three measured grounds:

1. **It would put provider output inside an Error.** `ExecutionEvent` includes
   `text`, `toolUse` and `write`. Errors here travel to the daemon log and past
   `classifyFailure`, and the contract already refuses to let an exception
   message reach a payload — `TASK_FAILED` carries a digest and a closed reason
   and nothing else. An error object holding a transcript is a transcript one
   `JSON.stringify` from a log line.
2. **It would move twelve construction sites across three strata.**
   `new ExecutionEffectError(` is built at three sites in this module, one in
   the Restate child, and eight in tests. A required third argument breaks all
   twelve; an optional one makes "the trail is carried" unprovable by
   construction — the structurally-live-behaviourally-empty shape this wave
   exists to remove.
3. **The error's job is to be classified, not read.** `classifyFailure` branches
   on the class alone. Nothing downstream wants the trail, and giving it one
   invites a future reader to take it.

`ExecutionOutcome` is **module-private**: not exported, not in any barrel, and
`RUNTIME_PUBLIC_EXPORTS` stays **242**. `createExecutionEffects`,
`ExecutionEffectsInput` and `EffectPort` keep their exact signatures, so the two
drill children that build the port with no sinks at all compile and behave
unchanged.

### No message is parsed and no classification re-derived

This is the constraint the packet was built around, and both shortcuts were
close at hand. The `error` terminal carries `detail`, filled by the port with a
classified sentence — *our* text, not the provider's, which is what makes
parsing it tempting and still wrong: `detail` is for a human reading a log, and
a second parser over it is a second classifier that drifts from the first. And
the terminal's `refusal` is **always** `TRANSPORT_UNAVAILABLE`, so recovering a
cause from it would mean re-implementing an adapter's classification table one
stratum up.

Neither is necessary, and that is the point: the classification is **already on
the trail**, as `pressure` and `authRequired` events an adapter produced and the
contract validated. The defect was never that the information was missing; it
was that the function holding it threw it away.

### The law, and why it is three assertions rather than one

`L-F4E-1` stands over this one file and asserts:

1. **The producer returns, never throws.** The original defect lived *inside*
   `execute`, ahead of any window anchored on its call site — a later edit
   reinstating it there would pass a one-window law unnoticed.
2. **Nothing refuses between the trail and the last drain.** The pressure drain
   calls its sink twice, once per kind, so a window ending at the first call
   would let a throw between them through while it broke the auth half.
3. **The refusal exists, and precedes the gate and the marker.** Without a
   positive half, deleting the refusal outright satisfies both negative halves —
   and a failed execution would then reach the gate and the marker, so
   `closeIntent` would append an OUTCOME and the plane would record as completed
   an effect that failed.

`L-B7T-3` and `L-V2B1F4-2` keep their anchors and stay green, and become
stronger: the sink call sites they order against the marker are now reached on
both paths.

## Why the spend was drained beside the pressure, and on whose authority

The two drains sit eleven lines apart inside one window, and the argument for
recording pressure from a discarded trail is word for word the argument for
recording spend from it: the tokens were reported by the provider, the spend
happened, and the ledger's own rule is that it may under-report but never
over-report.

Draining only pressure would have left two adjacent loops over one array with
opposite reachability and no honest sentence to explain the difference — and the
omission would have come back as a second errata against the same eleven lines.

The assignment named pressure, so this is a widening, and **it was ruled on in
writing by the independent verifier the owner asked for the opening
authorization**, not taken by the writer. The narrow variant was fully specified
and cost no path.

## Why the conformance gate still does not run on the error path

A failed execution must not leave a marker — a marker is what makes a step
un-re-runnable — and must not run a gate whose revocation would confuse the
settlement about to happen. Today's behaviour is preserved exactly: no gate, no
marker, `probe → NOT_DONE`, `TASK_FAILED`.

That leaves a real question unanswered: a provider that violated the declared
write-set and then died is not caught. It is **not** this packet's, because
changing it changes settlement behaviour; it belongs to the settlement packet.

## Consequences

**What the plane can now say that it could not.** An execution that failed
records the pressure and the spend its own trail already carried, one row per
observed frame, under the same durable names the success path builds from the
same inputs — so a resumed attempt replays rather than double-recording.

**The refusal, its `at`, the absent marker, the `NOT_DONE` probe and the
`FAILED` settlement are unchanged.** This packet adds evidence and changes no
verdict. A refused `start` still records nothing, because no stream existed —
the empty trail there is the absence of an observation, never an observation of
silence.

**One qualification the objective did not carry, stated plainly.** "The
settlement stays exactly as it is" is not quite true when a recorder throws on
the error path: the sink's own error preempts the `ExecutionEffectError`, and
`classifyFailure` refuses to settle a class it does not recognise, so the walk
propagates **unsettled** — `RUNNING`, INTENT open, no marker, no `TASK_FAILED`.
That is the rule the success path already follows and the fail-closed direction:
an unsettled walk is visible, where a silently discarded observation was not.

**The crash window is widened to the error path.** The task settles `FAILED` and
`FAILED` is terminal, so the ordinary error path does not resume and cannot
double-record. The exception is a hard kill between the drains and the
`TASK_FAILED` append: the restart finds the task `RUNNING` with an open INTENT
and no marker, the effect re-executes, and the drains run again. If the provider
says the same thing at the same trail position the ledger replays; if it says
something different the append conflicts and the walk propagates unsettled. This
window **already exists on the success path** and is fail-closed in the safe
direction — the ledger refuses rather than corrupts. It is not drillable at
daemon level, so it is proved at unit level with a throwing sink and stated here
as prose, never claimed as drill evidence.

**On the Restate leg the drains run inside the same journalled action as the
effect**, so a redelivery in the SDK's at-least-once window re-drains and
replays by key. Same mechanism, same fail-closed conflict.

**The daemon drill reaches the error terminal on the shipped Claude parser**,
with no test seam, no adapter injection, no providers edit and no new fixture
option — and the fixture it uses was decided by measurement. A line that is not
a JSON record does **not** work: `claudeAdapter.parse` refuses the whole chunk
it was handed and discards every signal it had already parsed from earlier lines
in that same chunk, and a subject writing three lines in a row delivers them in
one chunk, so the `auth_required` frame would never be emitted and the drill
would prove nothing. The fixture instead ends with a frame that parses and
normalizes but **fails the contract in the port**, which throws after the
earlier events have already been yielded — one of the six producers above, and
the same mechanism the landed reaping drill uses.

**The amended invariant** is *an execution that produced a trail records the
pressure on it*. ADR 0041's *"a verified evidence marker implies the pressure on
that trail was recorded"* remains true, and is amended here **by reference**:
0041 is a committed record and is not rewritten.

**Ordering.** This errata was mapped before ADR 0042's packet and landed after
it, so it carries **0043** and `PATH_SCOPED_LAWS` **106**. The packet that
carries a decision into an open walk names this one a hard prerequisite and is
inert without it: without the error path recording, the window that packet opens
exists but holds no evidence.

**Pins.** `PATH_SCOPED_LAWS` 105 → 106; the ADR corpus 42 → 43.
`RUNTIME_PUBLIC_EXPORTS` **242**, `ACCOUNTS_PUBLIC_EXPORTS` **82**,
`PROVIDERS_PUBLIC_EXPORTS` **88**, `CONTRACTS_SCHEMA_EXPORTS` **101**/17,
`DAEMON_PUBLIC_EXPORTS` **30**, the scope notes **134 / 123 / 20**, **418**
package files, **151** test paths, the **2** execution seams, `CONTRACT_VERSION`
2.2.0, the 24-name event vocabulary, the 24 → 5 channel map, the 20/4 routes and
the six migrations are all unchanged. No new source or test file is created.

## Not in this record

The settlement interposition — whether a quota-classified failure should settle
`FAILED` at all. The conformance gate's absence on the error path. The `error`
terminal's refusal carrying no cause, which this packet routes around rather
than repairs. The premature-exit finding above. The usage recorder's step-index
collision. Any decision, plan, account state or switch — nothing here reads a
row it wrote. No adapter, port, contract, protocol, ledger, gateway, console,
CLI, accounts, durability or daemon source edit, and every form of cutover.
