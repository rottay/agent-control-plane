# ADR 0019 — The owned session lifecycle: a live execution is rejoinable, and a daemon reaps its own children

- Status: accepted (V2-B4a, recorded 2026-09-03). Supersedes: none.
  Superseded-by: none.
- Amends: ADR 0010. The provider adapter boundary recorded there stands
  unchanged; this record decides who owns a live session across the boundary,
  and for how long.

## Context

ADR 0010 drew the provider boundary and said, in as many words, that
abandoning an event iteration is not cancellation. Until this record, nothing
acted on that sentence. The execution port kept its live sessions in a `Map`
whose entries were deleted in the stream generator's `finally`, so the entry's
lifetime was the **stream's**. A caller that stopped reading — a `break`, a
thrown consumer, a failed contract mapping — left a running provider child
that the port had just forgotten. It could not be named, could not be
interrupted, and was reaped by nothing: `interrupt(sessionId)` looked the name
up, found nothing, and returned successfully having done nothing at all.

The same absence blocked the other half. `ExecutionRequest.reattach` has been
in the contract since the boundary was written, with a stated law that a
transport either rejoins the named execution or refuses `REATTACH_UNAVAILABLE`
— never a silent fresh start. Every transport refused, unconditionally,
because none of them held a live execution long enough to rejoin it.

Two facts about the CLI transport bound what "rejoin" can honestly mean, and
both were measured rather than assumed:

1. **The transport handle is process-local.** `spawnAdmitted` spawns with
   piped stdio and no `detached`, and the session pumps those pipes directly.
   A provider child does outlive the daemon on POSIX, but its stream ends go
   with the parent: a new process cannot re-open them, cannot re-derive the
   `ParseCursor`, and cannot recover what was emitted in between. Nothing
   durable is written per event; only the terminal evidence marker is.
2. **The only provider "resume" is a fresh spawn.** `SessionRequest.resumeSessionId`
   is honored by one adapter (`claude --resume`); `codex` and `kimi` cannot
   carry a resume id at all, their `buildArgv` taking no request. A fresh spawn
   is precisely the second execution this boundary exists to prevent, and
   `RESUME` is `UNKNOWN` under the capability law, which refuses `subject: "FAKE"`
   evidence — so no drill available in this repository could confirm it.

## Decision

**A live session is owned by an `AgentHarness`, and the entry's lifetime is the
session's rather than the stream's.**

- The harness lives at `packages/edges/providers/src/harness/index.ts` and is
  the only live-session registry in the process. It registers a session under
  its durable execution name, releases it when the session reaches `CLOSED` or
  `FAILED`, treats those two states as absent on lookup, interrupts by name,
  and reaps everything it holds through `closeAll()`. Fence law **L-B4A-1**
  refuses a second registry in the port.
- The stream's `finally` records only that nobody is draining. An abandoned
  stream leaves an entry that is live, named, reattachable and interruptible.
- **Reattach is live and in-process only.** The CLI leg grants a rejoin when
  the token is the caller's own derived `sessionId`, the entry is live, nobody
  is attached, the identity matches, and all six route fields match. It spawns
  nothing and looks up no binding — the child was admitted when it was spawned,
  and demanding the binding again would let a binding removed since orphan a
  live child. Every other reattach is refused `REATTACH_UNAVAILABLE` at
  `request.reattach`, one `at` string for every failing sub-condition.
- **The mirror is refused too.** A plain start naming an execution already in
  flight is `EXECUTION_IN_FLIGHT` — the fifth member of `EXECUTION_REFUSALS`,
  added by this packet.
- **Each transport leg states its own refusal.** The global pre-dispatch check
  is gone, because one leg can now honor a reattach. Fence law **L-B4A-3**
  asserts the count at three, so a fourth leg cannot be added that forgets one.
- **The production daemon owns a harness and reaps it.** `startDaemon` builds
  one, passes it to the port, and pushes a release resource after the ledger
  and before the effect port exists — so the reverse unwind reaps children
  before closing the ledger they report into, and no window exists in which a
  child could be spawned that the unwind would not find. Fence law **L-B4A-2**
  holds all three halves.

**The type is `AgentHarness`, at the edge.** The roadmap names an
`AgentHarnessPort`; this is that port, realized where its consumers are. It is
deliberately **not** in `@acp/contracts`: its only agreeing party today is the
daemon, which already depends on `@acp/providers`, and a kernel port whose sole
consumer sits one stratum away is speculative surface. Moving it to contracts
is the signal that the durable boundary below is being crossed — a domain or
driver taking it by injection cannot import an edge.

## Why cross-process reattach was not chosen

It is what the packet's own product sentence suggests, and it is not
implementable here. The two facts in Context are the reason: the pipes are
gone with the parent, and the only resume is a new process whose capability is
`UNKNOWN` by a law this repository wrote precisely to stop claims like it.
Building durable reattach on `--resume` would publish a provider capability
claim that no authorized evidence supports, and would do it on the one path
where a silent second execution is most expensive.

Crossing that boundary needs one of two things that do not exist: a
supervisor-owned relay process that outlives the daemon and re-serves the
stream, or confirmed provider-native `RESUME`/`SESSION_ID` from a real-subject
drill. The first changes who owns the child, which is the concurrency remap's
territory; the second is gated behind a restriction that puts it much later.
Until then the port keeps refusing the reattach it cannot honor, which is the
contract's own law and not a limitation this record invents.

## Why a silent rejoin was not chosen

When a plain start names a live execution, handing back the running session is
superficially helpful and is the mirror of the failure the boundary already
forbids. Law 3 refuses a silent fresh start because a caller that believes it
reattached must not get a new child; a caller that believes it started fresh
must not get somebody else's half-drained one. Both are the same defect read
from opposite ends. The alternative — spawning a second child under one name —
is worse still: the registry entry would be overwritten and the first child
lost, which is exactly the leak this record exists to close.

## Why the fifth refusal was not folded into an existing name

`TRANSPORT_UNAVAILABLE` is false — the transport is present and working.
`ROUTE_INVALID` is false — the route is valid; it is the world that changed.
`CAPABILITY_UNSUPPORTED` is false — nothing is missing. `REATTACH_UNAVAILABLE`
inverts the meaning: the execution is not unrejoinable, it is *rejoinable and
the caller did not ask to*. A closed vocabulary with no true member forces a
caller to be told something false, which is the one thing a refusal vocabulary
must never do.

## Consequences

- **A stream is single-reader, and that is now enforced rather than assumed.**
  `Session.events()` shifts from one queue; a second concurrent reader starves
  the first — measured, not theorized. A reattach onto an attached entry is
  refused. The port will not fan one queue out to two readers and does not
  pretend it can.
- **`completed.stepIndex` had to become the execution's, not the stream's.**
  `terminated` takes a seed and the CLI leg passes the entry's running value.
  Without it a reattached stream would report `0` and make the contract's
  reconciliation sentence false on exactly the path this record adds.
- **A live entry now outlives an abandoned stream, which is a visible retention
  where there used to be an invisible leak.** It is bounded by the daemon's
  unwind, and `closeAll()` reaps it. The trade is deliberate: a child that can
  be named and killed is strictly better than one that cannot, but this does
  oblige every future owner of a port to reap what it holds.
- **`harness?` is optional on `ExecutionPortInput`**, which keeps two drill
  children and four daemon suites compiling untouched. Optionality of exactly
  this kind produced the structurally-live-behaviourally-empty defect the B7
  wave was convened to fix, so it is made safe by L-B4A-2 rather than by
  intention — the same instrument, for the same reason, as L-B7T-2.
- **Nothing about provider capabilities changed.** `RESUME`, `SESSION_ID` and
  `PROTOCOL_CANCEL` stay `UNKNOWN`. The interrupt path is still the signal
  ladder, which is ours and always available.

## Not in this record

- **Cross-process reattach**, and the relay or capability confirmation it would
  need. Named above as the later boundary; it belongs with the concurrency
  remap, which changes who owns the child.
- **Durable cancellation killing a live child.** The durability plane's
  `cancel` verb still settles the ledger. What changed is that a daemon can
  interrupt and reap the children **it owns in its own process**, which is what
  the runtime's contracts module was pointing at with "killing a live agent
  session needs a harness port that does not exist yet". The cross-process half
  is unanswered here.
- **Tool protocol and MCP.** No tool vocabulary, allowlist, transport or
  receipt is added or reserved by this record.
- **Cutover.** P8 certification and a separate P9 authorization are untouched.
