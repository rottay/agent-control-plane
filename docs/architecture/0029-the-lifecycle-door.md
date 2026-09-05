# ADR 0029 — The lifecycle door recovers what it acts on, and refuses to guess the one thing it cannot

- Status: accepted (V2 L2, recorded 2026-09-04).
- Supersedes: none.
- Superseded-by: none.

## Context

Four durable verbs — `cancel`, `reattach`, `signal`, `timer` — were implemented,
drilled against a real engine, and callerless. A sweep of production source at
`4569478` found no door for any of them: the only call sites were the drill
child and the suites. The plane could stop an invocation and rejoin one, and no
operator could ask it to.

Building the door turned out to be blocked on a single fact, and the fact is
worth stating before the decision, because everything else follows from it.

**Both drivers demanded a `CommitPolicy` in order to be constructed, and a door
that cancels has no evidence for one.** `RestateDriver`'s constructor took one
as its third argument and `SqliteSupervisor`'s options required one; both passed
it to `planFor`, which throws on anything but a member of the contract's enum —
deliberately, because the alternative comparison is total and would hand commit
capability to any caller that had lost its policy.

The policy is recoverable from nothing:

- it is in no event payload, no submission preimage (`canonicalSubmission`
  projects five fields and the policy is not among them) and no read model; the
  name appears in `persistence/ledger/src`, `kernel/protocol/src` and
  `kernel/contracts/src` only inside `task-envelope/index.ts`;
- `LIFECYCLE_PLAN` and `READ_ONLY_PLAN` share steps 0–7 as the same frozen
  objects and diverge only at index 8, so no event before step 8 distinguishes
  them — and step 8 on the read-only plan is the terminal `CHECKPOINT_WRITTEN`,
  which is to say the policy becomes evident exactly when a cancellation is
  already refused;
- the daemon does not derive it either. It passes the literal
  `"LOCAL_COMMIT_WITH_RECEIPT"` at three sites, and its own comment says why the
  door must not assume one: *"the policy will arrive with the packet rather than
  be assumed here"*.

A door in `DISCOVERED`…`AUDITING` — which is every state an operator actually
cancels from — therefore had nothing lawful to pass. Any value would have been a
guess made at the one seam in the plane where commit capability is decided.

Two smaller facts shaped the rest. `settleCancellation` probes an open intent,
and the only production probe was module-private inside a port that requires a
`ModelExecutionPort` from `@acp/providers` — a package the CLI may not import
and must not. And fence law `L-B4B-11` admits exactly one writable
`openLedger(` in the CLI source tree, counted over openings.

## Decision

**The cancel path is plan-inert, so the drivers gained a construction that takes
no commit policy.**

`SHARED_PLAN_PREFIX` is `LIFECYCLE_PLAN.slice(0, 8)`, frozen, and
`READ_ONLY_PLAN` is now built from it rather than from a second slice, so the
identity both plans have always had is a property of the construction. Both
drivers gained a `forLifecycle` static whose plan is that prefix and whose
`advance` refuses.

The inertness is measured rather than argued. On the cancel path the plan is
read in exactly three places, and all three land inside the shared prefix: the
DONE branch's `OUTCOME` append threads its causation to `plan[4]`,
`appendPlanStep` verifies that same predecessor, and `cancellationEvent` passes
`plan.length` to `deriveEventCoordinate`, which voids the argument. The driver
suite settles one cancellation three times over identically seeded ledgers —
under the prefix, under `NO_COMMIT`, and under `LOCAL_COMMIT_WITH_RECEIPT` — and
asserts the resulting event trails are **byte-identical**, with a `DONE` probe
so the branch that reads the most plan is the branch under test.

**One producer recovers everything else, from the ledger, and verifies it.**

`restateInvocation` reads the task, refuses an attempt that is not the latest,
reads the first event in the same order `assertInvocationContinuity` reads it,
and rebuilds five values from it: the invocation identity, the submitted
instant, the submission digest, the emitting worker and the initiative. The
route comes from `getExecutionRoute` and is then **checked**: the digest is
recomputed over the recovered values and compared against the one every event of
the attempt carries. A ledger whose route projection disagrees with its own
events is refused, not acted on.

`lifecycleBeat` builds the beat context from that result, and
`runLifecycleOperation` makes exactly one driver call and returns the outcome
verbatim. All three live in `@acp/runtime`, so the CLI door and the API door
that follows will compose identically; `L-V2L-1` pins that no door outside the
daemon recovers for itself.

**`--mode` is required and never inferred.** Probing an engine and falling back
is what drill D4 refuses, and reading the daemon's status document is not open
to the CLI: `readStatusFrom` takes a brand only `@acp/daemon` mints. So the mode
is stated, admitted through the contract's own `DriverMode` enum by
`admitDriverMode`, and a missing one is `EXIT_USAGE` rather than a guess. There
is no lowercase alias: a second spelling is a second vocabulary.

**The door's effect port can only read.** `createEvidenceProbe` shares the
execution module's private marker reader and its `apply` throws. `L-V2L-3` pins
that outside the daemon this is the only effect port an entrypoint constructs
and that no door names `.advance(`.

**Three verbs write, through one opening.** `openForWrite` is exported from the
tool-call module and called by the lifecycle door, so `L-B4B-11` still holds by
counting openings rather than by counting verbs.

### What an operator gets

`acp cancel` and `acp attach`, each taking `--database`, `--scenario`, `--task`,
`--attempt` and `--mode`, printing one bounded JSON document of seven fields —
no path, no route, no payload, no engine-minted identity — and exiting:

| Answer | Code |
| --- | --- |
| the verb succeeded | `0` |
| `TASK_TERMINAL` — the coordinates were the wrong ones to ask about | `2` |
| the task or attempt is not recorded | `4` |
| the engine could not be reached, or `POSTCONDITION_UNKNOWN` | `5` |
| the ledger disagrees with itself about this attempt | `6` |
| `CAPABILITY_UNSUPPORTED` — this engine does not serve the verb | `8` |

`8` is new and CLI-owned, by the exit-code document's own rule that codes beyond
`EXIT_OK` and `EXIT_USAGE` stay with the entrypoint that defines them. It exists
to keep a capability gap distinguishable from an unreachable engine: a retry is
the right response to `5` and the one response that can never help on `8`.

### The narrowing this record makes explicit

**The lifecycle verbs serve an attempt from `RUN_STARTED` onward.** The route
enters the ledger through the INTENT payload and nowhere else, so an earlier
attempt has no recorded route, and there is nothing honest to do about that: a
placeholder would put a route the plane never elected into an appended
`OUTCOME`. Earlier states are a daemon-internal window, and the door refuses
them by naming `attempt.route`. Widening this is a change to what step 0
carries, and it is not this packet.

**The cancellation is recorded under the attempt's identity, not the
operator's.** `emittedBy` is recovered from step 0, because that is what
continuity rebuilds against. The operator's identity is nowhere in the ledger
and this door does not put it there.

**The door takes an injected driver seam, and that is a topology fact.** The
`cli` vitest project sits in `groupOrder` 0 and binds no ports; `runtime`,
`daemon` and `durability` hold distinct numbers precisely so they cannot
collide. A door testable only against a live engine would have no suite in its
own package. `runToolCallVerb` has no such seam because it needs none, and a
reviewer who notices the difference is noticing the port topology.

## Why the alternatives were not chosen

**A `--commit-policy` flag.** It would be a second authority for a value the
plane never records, supplied by the one caller least able to know it. The
daemon's own comment forbids assuming the policy at a door; a flag is that
assumption with a prompt in front of it.

**Defaulting the policy to `LOCAL_COMMIT_WITH_RECEIPT`.** That is the daemon's
literal in a second place, and it would silently hand commit capability to a
door that had no business deciding.

**Widening `L-C-4c` to a CLI composition site.** The law asserts that every
`createExecutionEffects({` in the daemon passes a conformance gate. Widening it
to the CLI would pin a site that must never exist: the full port needs
`@acp/providers`, which the CLI may not import. A probe-only export and its own
law is the narrower instrument, and it needs no written exception because a
probe cannot perform an effect.

**A stub effect port at the door.** `settleCancellation` appends the plan's
`OUTCOME` when the probe says `DONE`. A stub would either append an outcome for
work that did not happen or refuse every cancellation as
`POSTCONDITION_UNKNOWN`. Both are worse than reading the evidence that exists.

**Deriving `--scenario` from `--database`, or the reverse.** The evidence lives
under a branded scenario root that only `resolveScenarioRoot` can mint; the
ledger is named by a path. Deriving one from the other would choose, on the
operator's behalf, which of two things they meant. Both are stated and the door
refuses unless they resolve to the same real path.

**A second writable `openLedger(` for the lifecycle module.** It would fail
`L-B4B-11`, and copying the two guards that surround the existing one would be a
second answer to "may this file be written".

**Landing the API door in the same packet.** Staged doors are this repository's
precedent — the explicit tool call landed as runtime operation, then gateway
door, then CLI door, then parity, each with its own recorded write-set. A
CLI-only L2 also leaves `@acp/protocol` byte-unchanged: no route, no error code,
no version move.

## Consequences

- `@acp/protocol` is untouched. `API_CONTRACT_VERSION` stays `0.12.0`,
  `CONTRACT_VERSION` stays `2.2.0`, `API_ROUTES` and `API_WRITE_ROUTES` are
  unchanged, and the 24 event types and 6 migrations stand.
- `RUNTIME_PUBLIC_EXPORTS` moves 206 → 226 (twenty names). `DURABILITY_PUBLIC_EXPORTS` stays at
  28: the lifecycle construction is a static on a class the barrel already
  exports, so the pinned durability README does not move.
- `CLI_ALLOWED_PACKAGES` and the CLI manifest move 5 → 6, and the lockfile's
  importer block gains one `link:` entry — three insertions, measured, exactly
  as V2-B7S recorded for the same mechanism.
- `PATH_SCOPED_LAWS` and the `requireScope` call sites move 88 → 91 together.
- The CLI `COMMANDS` table moves 11 → 13 and the exit table gains `8`.
- Three real-engine drills now run in the durability project: cancelling twice
  appends once, a `SIGKILL` between the engine call and the settlement leaves a
  ledger a fresh door drives to the same terminal head, and an attach after a
  door death rejoins rather than starting a second invocation.
- A ledger written by a producer that did not compute `submissionDigest` the way
  `canonicalSubmission` does — the pre-L2 drill fixtures, which used a
  placeholder — cannot be cancelled through this door. That is the intended
  direction of the failure: the verification is what makes the recovered route
  trustworthy, and a door that skipped it for old ledgers would be a door with
  two standards of evidence.

## Not in this record

- **The API door.** L3's claim is that two doors agree, and equivalence needs
  two doors to be a property at all. This packet builds one.
- **`signal` and `timer`.** Both remain unexposed. They are things a packet asks
  for while it runs, not things an operator asks for from outside, and neither
  has earned a door.
- **A typed status on `DriverOutcome`.** `RestateDriver.reattach` throws a
  `SupervisorError` whose status lives in prose, so the door cannot tell "no such
  invocation" from "unreachable" at the driver seam. It pre-checks the task and
  the attempt before the engine call and maps every driver throw to
  `EXIT_UNAVAILABLE`. Carrying the status on the outcome is a durability-edge
  change, deferred by name.
- **Mid-beat preemption.** Unchanged from ADR 0005's position: a cancellation
  takes effect between beats.
- **Cancelling before `RUN_STARTED`.** Stated above as a narrowing rather than an
  omission; it is a change to what step 0 carries.
- **`vitest.config.ts`.** Authorized as a bounded allowance and not written. The
  `cli` project resolves `@acp/runtime` from `dist` today and `@acp/durability`
  resolves the same way; source resolution was not needed. Noted while reading
  it: the alias for `@acp/api-contracts` at line 114 names a package that no
  longer exists — the package is `@acp/protocol`. It is dead and it is not this
  packet's to remove.
