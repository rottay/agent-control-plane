# ADR 0039 — The checkpoint the walk claims is one it wrote

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

`CHECKPOINT_WRITTEN` was a claim.

Both plans terminate in it. `LIFECYCLE_PLAN` index 10 walks
`COMMITTED → CHECKPOINTED`, and `READ_ONLY_PLAN`'s closing step walks
`AUDITING → CHECKPOINTED`; both name the same event type and both carried
`beat: "PLAIN"`. A plain beat appends and does nothing else, so every completed
walk in this repository — under either commit policy, through either driver,
in a child or under the production daemon — recorded that a checkpoint had been
written, and no checkpoint was ever written.

The contract was not the gap. `Checkpoint` has been in `@acp/contracts` since
P8-T G6, with its credential guards and its 16 KiB budget in its own
`superRefine`. What was missing was a producer: **no `Checkpoint.parse` existed
anywhere in `src`**. The schema was a shape nothing filled.

Two constraints shaped every option. `RUNTIME_ALLOWED_BUILTINS` is crypto, fs,
path and url, so `@acp/runtime` cannot spawn `git` and cannot assemble the git
half of a checkpoint itself. And the bytes a digest names live in
`@acp/ledger`'s artifact store, which the runtime may read through but does not
own. So whatever produced a checkpoint could not be one module.

A third fact was discovered rather than assumed, and it belongs in the record:
`TaskEnvelope.writeSet` is a **declaration**, and
`checkWriteSetConformance` compares it against an observation by exact string
equality. It never required a declared entry to exist. Every daemon drill in
the repository therefore declared `writeSet: ["src/**"]` — a pattern that
matched nothing, over a gate that consequently proved nothing.

## Decision

**The terminal persists a real `Checkpoint`, and appends the event only after
the store holds it.**

- **`CheckpointSource`** (`packages/domains/runtime/src/checkpoint/index.ts`)
  assembles `Checkpoint | CheckpointRefused` for a plan step. **`CheckpointPort`**
  persists one and reads one back. The domain **declares both and implements
  neither**: no value of either type is constructed anywhere in
  `@acp/runtime`'s `src`, and `packages/domains/runtime/test/checkpoint`
  asserts that the module's only runtime export is the refusal vocabulary.
- **Every field comes from a fact the plane already holds**, and none is a
  literal in the source: `checkpointId` from `deterministicUuid` over the
  invocation and the terminal transition id; `taskId`, `attempt` and
  `createdAt` from the derived coordinate — **no clock read**; `worker` from
  the walk's `emittedBy`; `lastAtomicStep` from the ledger's own `run.outcome`
  row, read rather than remembered; `authorityDigest` copied from the envelope,
  which already holds it as `PathDigest[]`; `readSetDigest` and `writeSetDigest`
  digested against the leased worktree; the four git facts from one
  `observeWorktree` plus one further `rev-parse --abbrev-ref HEAD` through the
  **same** `GitReadPort`.
- **Two honest git refusals.** `Checkpoint.git.head` is a 40-character object
  id while an observation's head is nullable, so an unborn HEAD refuses
  `GIT_HEAD_UNBORN`; an observation that could not be taken refuses
  `GIT_UNOBSERVABLE` rather than becoming a null, because an observation that
  could not be taken says nothing at all.
- **`PATH_MISSING`, with exactly one exception.** A declared path the worktree
  does not hold refuses. The exception is the observer's own rule: a path git
  reports as a **tracked deletion** digests the empty string, because "there is
  nothing here" is a fact the observer established. No other absence produces a
  digest.
- **Two terminal constants.** `pendingWork` is always `[]`, and `nextSafeAction`
  is always exactly `Await the next owner-authorized action.` — a module
  constant, never composed and never varied. `receipts` and `artifacts` are
  `[]` because the plane produces no reference at a terminal today; that is the
  truth rather than a placeholder.
- **`persist(step)` runs before the append.** `appendPlanStep` calls it when
  `step.eventType === "CHECKPOINT_WRITTEN"`, in the shape
  `assertCausalPredecessor` already establishes. Absent member → refuse and
  append nothing; a refusing `persist` → refuse and append nothing; success →
  the store's own digest into the payload, then the append. The refusal is a
  `SupervisorError`, which `classifyFailure` does not settle, so "appends
  nothing" is true of the whole walk and not only of the beat.
- **Publish, then append.** `roadmap-write` already named the unrecoverable
  order — *"an event naming a digest the store does not hold"*. The two crash
  windows are publish→crash, which leaves an unreferenced artifact (correct and
  cheap, because the store is content-addressed), and append→crash, which
  leaves an event whose digest the store holds. The forbidden third case cannot
  arise, because nothing appends inside the store.
- **A `(taskId, attempt)` guard was rejected.** The store is content-addressed
  only — `objectPath` is keyed by digest — and `runToCheckpoint` offers no hook
  between step 9 and step 10, so such a guard could neither learn the digest nor
  answer "was one persisted". The port answers both by returning the digest.
- **Child processes receive git facts as data.** `ChildConfig`
  (`sqlite-supervisor-child`) and `RestateChildConfig` (`restate-child`) gain a
  `checkpointFacts` member, observed by the **spawning suite** with its own
  `spawnGit` over a repository the scenario really has. Neither child creates a
  `GitReadPort` and neither executes git. **`DaemonChildConfig` gains nothing**:
  it is the production child's config, and production observes git itself.
  Absent facts → no member → the terminal refuses, exactly as production does.
- **One artifact-root rule, with one home.** `artifactRootFor` moved out of
  `packages/entrypoints/gateway/src/roadmap-write/index.ts` into
  `packages/persistence/ledger/src/artifact-store/index.ts`, beside the store it
  governs, and the gateway's copy was **deleted rather than duplicated**.
  `@acp/runtime`, `@acp/durability` and the daemon may not import the gateway,
  so the adapter could not have been written without re-stating the rule — and a
  re-statement is exactly the *"second answer to where a digest in this ledger
  resolves"* that the seam's own note warns against. `ARTIFACT_DIRECTORY` stays
  module-private, so exactly one new name leaves the ledger for it. It is in
  `artifact-store` and not `checkpoint-store` because the rule governs where
  *artifacts* resolve; putting it beside the checkpoints would make a roadmap
  write import the checkpoint module.
- **Two fence laws.** `L-F3-1` — within `packages/domains/*/src` and
  `packages/entrypoints/*/src`, only the plan module and the terminal guard may
  construct a `CHECKPOINT_WRITTEN` event; it is non-vacuous, failing if the
  permitted producer goes away. `L-F3-2` — no source outside `artifact-store`
  declares a second `artifactRootFor` or composes an artifacts directory from a
  path, which is what keeps the deleted copy from returning.
- **The provider signal is a different thing, and it is outside `L-F3-1`'s
  scope by construction.** `packages/edges/providers/src/events/index.ts` maps
  `"checkpoint.emitted" → "CHECKPOINT_WRITTEN"` as a **name in a mapping
  table**; the execution port turns it into `ExecutionEvent{kind:"checkpoint"}`,
  an execution-trail fact that never reaches a ledger append. The edges stratum
  is not selected by the law, so no exemption list is needed to spare it. This
  is asserted here rather than tested because a causal test would need a
  providers path this packet does not add.

## Why a required `checkpoints` member was not chosen

The member is optional, and the optionality is the refusal rather than a
default. A required member would have forced every construction that never
reaches a terminal to invent one: `SqliteSupervisor.forLifecycle` walks
`SHARED_PLAN_PREFIX`, which has no closing step, and the cancel and reattach
verbs read no plan at all. An invented port at that seam is the same defect one
module further along — a checkpoint nothing wrote, produced by a construction
that had nothing to write about. Optional-with-refusal makes "this walk cannot
write a checkpoint" a representable and honest state, and the terminal refuses
on it.

## Why the source was not put in `@acp/runtime`

It is where the plan is, which is the tempting answer. It is also the one
package that cannot do the work: `RUNTIME_ALLOWED_BUILTINS` admits crypto, fs,
path and url, so nothing there can spawn `git`; the enforcement core's whole
posture is that it observes nothing itself and holds a read-only port as a
*type* with no implementation. A source there would have had to either import a
process module — breaking a law this repository enforces mechanically — or take
the git facts as data on every construction, which is what the two drill
children already do and what production must not do, because production has an
observer and should use it.

## Why the checkpoint was not written after the append

It would have been simpler, and it is the one order that cannot be recovered
from. An append is a claim, and a log that only grows cannot retract one: a
crash between the append and the write leaves an event naming a digest the store
does not hold, and every later reader — rehydrate, audit, the CLI — has to treat
that as corruption because it cannot tell it from corruption. The reverse crash
window leaves an unreferenced artifact, which is cheap, self-correcting on the
next attempt with the same bytes, and invisible to every reader.

## Why the drills' declared write-sets were changed rather than the rule

Digesting the declared write-set against the worktree made every daemon drill
refuse `PATH_MISSING`, because they declared `src/**` — a pattern the
conformance gate had always compared as a literal string and therefore never
matched. Two answers were possible: weaken §2.3 so a declared path need not
exist, or fix the declarations.

Weakening the rule would have made the checkpoint's `writeSetDigest` an
optimistic list rather than an observation, and would have left the gate's
existing vacuity in place. The declarations were wrong: a drill declaring
`src/**` had a gate that matched nothing, and one declaring `child.pid` while
its subject wrote that file into a *different* directory was under-declaring in
a way nothing had ever noticed. Each fixture now holds every path its envelope
declares. The checkpoint found two real fixture defects on its first run, which
is the argument for the stricter rule rather than against it.

## Consequences

- **A walk that cannot observe its worktree no longer reaches a terminal.**
  That is the intended cost: a checkpoint is continuity, and continuity assembled
  from facts nobody observed is worse than none. It also means a declared path
  that goes missing mid-walk turns a completed walk into a refused one.
- **The 16 KiB budget is now reachable in production.** A packet with a large
  read-set will refuse `CHECKPOINT_INVALID` with the contract's own message. No
  truncation and no summarisation: the packet is too big to checkpoint, and the
  honest answer is to say so rather than to record a partial one.
- **`DIGEST_MISMATCH` is unreachable in practice.** `publishArtifact` re-digests
  stored bytes first, so different bytes under an existing name are
  `ARTIFACT_CORRUPT`; `DIGEST_MISMATCH` is the branch for bytes that *do* hash
  to that name and still differ — an actual sha256 collision. Both names are
  carried through unchanged, and the observable one is asserted.
- **A checkpoint carries the worktree it was taken over**, so two legs of an
  equivalence drill running in two directories no longer produce byte-identical
  terminal events. Both such drills now hand their legs one worktree, which is
  what an equivalence over identical inputs always meant.
- **The endpoint's checkpoint port is built per invocation.** A Restate endpoint
  serves whatever is submitted to it, so a port bound once at construction would
  have answered every task with the first task's `run.outcome`. `beatFor` takes
  a factory, and the member is built where the invocation is known.
- **Thirty-eight paths, two of them admitted by adjudication.** The brief's
  table named thirty-six; its own enumeration rule — *every suite whose walk
  reaches `CHECKPOINTED` by any route is in the set and is edited* — reaches
  `packages/domains/runtime/test/cancellation/index.test.ts` (a direct
  `BeatContext` that walks to the terminal to drill `cancellationPrecheck`'s
  terminal refusal) and
  `packages/entrypoints/daemon/test/launchd/lifecycle/index.test.ts` (a real
  daemon under launchd whose envelope declares a write-set the production source
  digests). Both were proposed and adjudicated rather than improvised.
- **F5 owes the read side.** `CheckpointPort.read` is declared and is **not
  called** by this packet. It exists now rather than later because a port whose
  reader arrives in a different packet is a port two packets disagree about.

## Not in this record

Rehydration — how a checkpoint is read back and a walk resumed from it — is F5's,
and this record does not anticipate its shape beyond declaring `read`. No
identity index over checkpoints is created, and no checkpoints table exists:
the artifact store is the only home for the bytes. Whether a future packet
should expand a declared write-set pattern rather than compare it literally is a
question about `checkWriteSetConformance`, not about this record; the vacuity it
would fix is noted above and left open.
