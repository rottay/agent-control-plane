# ADR 0024 — Write-set conformance: the plane observes what a packet wrote, records it, and changes nothing

- Status: accepted (V2 concurrency C4, recorded 2026-09-04). Supersedes: none.
  Superseded-by: none.

## Context

`checkWriteSetConformance` has existed in `@acp/runtime` since the enforcement
module was written, and so has `GitReadPort` — whose own docblock said *"No
implementation of this exists in production source"*. The rule for judging a
worktree was complete; nothing could see one.

C1 gave the plane an arbitration store, C2 a fenced lease, C3 several walks at
once. Each of those answers *may I write here*. None answers *did you write only
what you said you would* — and under C3 that question became more urgent rather
than less, because several packets now write into several worktrees at the same
time.

Two facts shaped the answer.

The first is that a walk which finds a verified evidence marker **never
re-enters `apply`**. Any check placed after the marker is unreachable on exactly
the window it exists to cover.

The second is that C3 left **two** execution seams: the legacy singular path and
the scheduler's per-walk path. Only the walks form carried a `TaskEnvelope`, so
only it had a declared write-set. Gating one seam and not the other would have
left a production path that conformance could not judge.

## Decision

`packages/entrypoints/daemon/src/git-observer/index.ts` is the production
`GitReadPort`, and the daemon runs a conformance gate after every atomic step —
on **both** execution seams.

**Option B: the singular path carries an authoritative envelope.** `DaemonOptions`
gains a **required** `TaskEnvelope`, validated at the config door with the same
parser and the same two agreement checks C3 already applies to `walks[]`. It is
required in the *type*, so the compiler finds a caller that forgot; and it is a
contract envelope rather than a bare `writeSet: string[]`, because a bare list
would be a second declaration of what the envelope already declares.

With that, the two seams are symmetric and the gate is **one closure with two
call sites**. `L-C-4c` asserts both halves: the gate precedes the marker in
`execution-effects`, and *every* `createExecutionEffects` call in the daemon
passes one. That is what makes "no production path bypasses declared write-set
conformance" a check rather than a review promise.

**The gate's six steps, in this order.** Observe; refuse if the observation
could not be taken; append the verdict's events — `WRITE_SET_VIOLATION_DETECTED`
then `LEASE_REVOKED`; **append a `TASK_STATE_CHANGED` to the verdict's own
`recommendedTaskState`**; release the hold; throw, so the walk stops here rather
than continuing to a checkpoint.

Recording precedes revoking because a revocation whose cause has no event is a
lease that vanished for no recorded reason. And the quarantine is the step that
makes the violation *stick*: `SUSPECT_WORKTREE` is terminal, so the ledger — the
authority — records that this task is finished rather than merely interrupted. A
gate that stopped the walk without it would leave the task resumable, and the
next start would re-run the provider, re-write outside the declared set and
re-violate, indefinitely. The state is read from `checkWriteSetConformance`'s
recommendation, never restated here: the rule decides what a violation means.
Coordinates are derived from the operation index, so a retry appends nothing new.

**The observer can only read, and that is structural.** The verb is checked
against `GIT_READ_VERBS` before anything is spawned, so a denied verb never
reaches the process boundary; `L-C-4a` asserts the mutating words are absent
from the file. `/usr/bin/git` by absolute path so `PATH` cannot choose the
program; the child environment is built rather than inherited, so `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_GLOBAL` and
`GIT_ALTERNATE_OBJECT_DIRECTORIES` are absent because nothing puts them there;
`--no-optional-locks` because under C3's N walks an observation must take no
lock a sibling walk is waiting on. `spawnSync`, so there is no child to reap and
the observer adds no unwind resource.

## Why nothing is cleaned

The plane's answer to a violation is to record it and stop. The offending file
stays where the packet put it, with the bytes it wrote; the index is untouched;
`git status` is byte-identical to the moment before the check.

That is a decision, not an omission. A violation is the one moment when the
evidence of what a packet actually did is most valuable and most fragile, and
every tidy-up — a checkout, a restore, a stash, a reset, a staged file — destroys
it in the name of leaving things neat. `L-C-4b` asserts the conformance closure
cannot write, unlink, rename or remove, so the tidy-up is unavailable rather
than merely discouraged.

The cost is real and is accepted: an operator inherits a dirty worktree and has
to decide what to do with it. That is the right person to be making that
decision.

## Why an unobservable worktree is not a pass

An observation that could not be taken says nothing about conformance, so it is
a refusal — `OBSERVATION_FAILED` — and the walk stops.

Three specific shapes of this were closed deliberately, because each would have
turned a failure into a fabricated observation:

- a failed `git status` refuses outright;
- a failed `rev-parse` reads as an unborn HEAD **only because the status that
  preceded it proved the repository readable**. Taken the other way round, a
  broken or absent repository would be reported as a pristine new one with
  `head: null`;
- an unreadable file refuses, rather than digesting the empty string. Only a
  genuine `ENOENT` — a deletion — digests no bytes, because "there is nothing
  here" is a fact, not a failure to establish one.

A digest is of the file's own bytes, not of a `git diff`: a diff's digest would
depend on what it is being compared against rather than on what is there.

## Why the gate is a sink and not a driver change

`execution-effects` gains a `ConformanceGate` beside its existing `UsageSink`,
injected as a function. The alternative — teaching the SQLite supervisor, the
step executor or `@acp/durability` about worktrees — would have put a git
dependency inside the durability plane and made the same change in three places.

The sink seam already exists for exactly this reason, and using it means those
modules stay untouched: `execution-effects` still opens no ledger, spawns
nothing and reads no worktree. The daemon closes over the observer, the lease,
the envelope's declared write-set and the ledger — all already in scope at both
construction sites — and hands the closure in.

Optionality in the type is made safe by a fence law rather than by hope, which
is the same arrangement `recordUsage` has under `L-B7T-2`.

## Consequences

- **A worktree that is not a git repository stops the walk.** In production a
  worktree always is one; the drills' fixtures had to become real repositories,
  which is a fixture becoming honest rather than a cost.
- **A drill must declare what its provider writes.** Under-declaring is caught,
  which is the gate working. One fixture that writes its own pid file now says
  so.
- **A daemon whose runtime root *is* its worktree observes its own log** and
  refuses itself. The launchd fixture now separates them, as production does.
- **`WRITE_SET_VIOLATION_DETECTED` has its first production producer**, so the
  protocol's no-producer list moves seven → six.
- **The observer is a fourth spawn authority**, and the only one added since the
  provider spawn site. It is bounded in time and output and spawns
  synchronously, so it leaks nothing.
- **Conformance is judged by exact path membership**, not by globs. A declared
  set of `src/**` matches a file literally named `src/**` and nothing else. That
  is the existing rule in `checkWriteSetConformance`; this record only notes it
  where a reader will need it.

## Not in this record

- Glob or prefix matching in the declared write-set — the rule is
  `enforcement/index.ts`'s and this packet consumes it unchanged.
- A commit-authorization receipt built from an observation. The observation is
  already the receipt's shape (`baseHead`, `observedTrackedChanges`,
  `observedUntrackedPaths`), which is P6C's to use.
- Any recovery from a violation. The plane records and stops; what happens to a
  quarantined worktree is an operator's decision and a later packet's subject.
- A certification-matrix row — that file belongs to another lane.
- Real multi-walk Restate, cross-checkout arbitration, dynamic submission, and
  P9, which remains deferred.
