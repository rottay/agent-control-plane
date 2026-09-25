# `@acp/runtime`

The durability and supervisor plane of the Agent Control Plane.

**P8-T G5 split the Restate edge out.** The lifecycle engine, the
`OrchestrationDriver` port, the coordinates, the beats and the `SQLITE_SUPERVISOR`
driver stay here; the Restate driver, its endpoint, child, submission path and
pinned server moved to `@acp/durability` under `packages/edges/durability`. This
package no longer depends on `@restatedev/restate-sdk` at all. Where the text
below describes what the Restate driver does, it is describing the edge that now
implements this package's port — the design did not change, its address did.

## Scope

**P2D built one shared lifecycle engine and both of its drivers, and P6
completed the enforcement plane over it**: the writer-enforcement core, the
conflict graph, and commit authorization with quarantine. That plane is
**decision machinery only — there is no production observer**, so nothing here
acts on a real worktree. The `SQLITE_SUPERVISOR` and the `RESTATE` driver walk
the same plan over the append-only ledger and recover from real process kills.
Enforcement adds leases, write-set conformance and prestate verification as
pure functions over injected values: one writer per worktree, an exact
write-set scanned tracked-and-untracked, and a violation that revokes the lease
and quarantines the worktree rather than cleaning it. Process lifecycle now
lives in `@acp/daemon`, which drives this package. There is no `launchd`
template and no observation route yet.

P6A admits at most one live holder **per worktree**, and makes no
cross-worktree claim: whether two worktrees may be written in parallel is the
conflict graph's decision, which is P6B's gate applied before acquire. The
enforcement core computes no conflict check of its own; the conflict-graph
module computes the complete one, over task envelopes, before any lease is
taken. Revocation is the caller folding the lease out of the set it passes in
— derived from `LEASE_ACQUIRED` and `LEASE_REVOKED` in the ledger, which is the
authority — because the engine holds no state of its own.

The fold rule, completely: per `leaseId`, the **last `LEASE_ACQUIRED` in ledger
order** defines the lease — ledger order, not `expiresAt` order — and a
`LEASE_REVOKED` is **terminal** for that id, so a later `LEASE_ACQUIRED` for a
revoked id is not a resurrection and the fold ignores it. A renewal re-emits
`LEASE_ACQUIRED` with the same `leaseId` and a later expiry, never changing
`worktreePath`, `holder` or `acquiredAt`: the frozen event vocabulary has no
renewal type, and "revoke and re-acquire under a new id" would record a cause
that did not happen and break continuity for every receipt already naming the
lease. Each payload carries the whole lease — id, worktree, holder,
`acquiredAt`, `expiresAt` — so the fold is computable from the ledger alone.

The enforcement core observes nothing itself. Its read-only git port is a type
naming the four verbs an observer may ever speak — `status`, `diff`,
`ls-files`, `rev-parse` — so a mutation verb is unrepresentable; no
implementation of it exists in this package, and no production source here
imports a process module. Wiring a real observer is a separate authorized
packet.

P6C decides whether a commit is authorized, and never performs one. The
receipt's envelope is injected whole: this module mints no identifier, reads no
clock and never speaks git, so the bytes a verifier audits are the bytes the
integrator commits under. Authorization requires an independent verifier — a
receipt whose verifier is its own writer is refused — every recorded check
exiting zero, an observation inside the declared write-set, a base head the
receipt was taken against, and a lease held by the writer for that worktree and
still live at the moment of authorization. A receipt can never authorize a
push: the field is `false` at the type, so `true` is unrepresentable rather
than merely unused. Recording a commit afterwards is a second decision: a first
parent that is not the receipt's base head, a message that is not the
authorized one, or a malformed object id is refused rather than logged.

When the observation falls outside the declared set the outcome is a quarantine
record — the violating paths, the evidence digests and a recommended
`SUSPECT_WORKTREE` — and quarantine is **never cleanup**. The record has no
field in which a clean, a reset or a restore could be written, which is the law
expressed as a shape rather than as a warning.

`buildQuarantineBatch` (P-18/protocolo F, ADR 0078) turns that record into the
batch the ledger commits atomically: the finding, the move to
`SUSPECT_WORKTREE`, and the intention to revoke the lease, in that order and for
one `appendBatch`. It is pure and it mints nothing — the saga is the caller's and
a request without one is refused, and the command id is computed by
`@acp/ledger`'s `computeOutboxCommandId`, the one function the ledger's door
recomputes it with. It records no `LEASE_REVOKED`: inside the ledger's
transaction nothing has happened at the arbiter yet.

Importing this package has **no side effects**. It binds no socket, starts no
listener, spawns no process and creates no directory. Filesystem work happens
only inside an explicitly invoked drill, under a root this package resolves for
itself. The architecture fence asserts both.

This is **no product adoption**. Nothing here is connected to, observed from or
used by any real operation.

## One core, two drivers — now in two packages

`src/core/lifecycle/index.ts` holds one step table and one plan per commit
policy. The supervisor here and the Restate driver in `@acp/durability` both
walk a plan from it, and neither encodes a transition of its own: two copies of
a state machine drift, and the drift is only ever discovered when the two
disagree about a recovery. The split made that sharing structural rather than
conventional — the edge imports the plan across a package boundary, so it cannot
quietly grow one of its own.

That is also why the second plan is **derived rather than written twice**.
`READ_ONLY_PLAN` is the writer plan's own frozen steps 0-7 plus one closing step
that takes its transition id, event type and target state from the writer plan's
checkpoint step; only the `fromState` differs, because a `NO_COMMIT` packet
closes from `AUDITING` instead of from `COMMITTED`. Sharing the objects is what
makes "they cannot drift" a fact about the values rather than a promise about
future edits.

Which plan a run walks is chosen at the **driver boundary**, from the packet's
`commitPolicy`, and there is no default: `SqliteSupervisorOptions` and the
Restate object's dependencies both require it, so a caller that never said which
policy it is under cannot be handed the commit-capable plan by omission. A
read-only packet therefore never passes through `READY_TO_COMMIT` or
`COMMITTED`, and no `COMMIT_*` event can appear in its trail, because no step
exists that could produce one.

The commit-authorization module is unaffected by that second path and cannot be
reached from it: `authorizeCommit` and `recordCommit` belong to the writer plan
by construction, since the task envelope refuses a commit policy on an empty
write-set, so a read-only close can never be followed by a receipt.

The supervisor holds **no cursor**. Every decision about what to do next is read
back out of the ledger, which is what makes "the ledger is the authority" true
rather than aspirational. `RUNNING` is the one ambiguous state, because both the
intent and its outcome land there; the tie is broken by asking the ledger
whether the outcome event exists, which is evidence rather than memory.

**V2-B4b stage 3B adds the explicit tool-call operation**, and it is the
operation only: `runToolCall` joins a structural calling scope, the stage 2
receipt and the ledger row, and there is no door here — no route, no CLI verb,
no process start, and no import of the package that owns the tool vocabulary.
Its contract is an ordering invariant: a throw means the request never became an
operation, so no row was appended and nothing was spawned, while a return means
it did become one and a row always exists. Nine checks — the bounded names, the
worker identity, both indices, the invocation's own attempt and `submittedAt`,
the causal link, the scope's own id, the task, the attempt bound, and the replay
read — run before the scope is reachable, and after it every outcome is
recorded, refusals as much as successes. The list is derived from one rule
rather than collected: every caller-supplied value the recorder would hand to
the event contract is bounded here, because a refusal that arrives from the
recorder arrives after the call already happened, which is a real effect with no
row. The three that judge the invocation and the cause use the contract's own
field schemas rather than a restatement of them, so a precheck cannot drift from
the parse it stands in front of. Replay is decided by the durable
coordinate alone: a spent `(taskId, attempt, transitionId)` returns the recorded
row without calling anything, which is why a repeat can never become a second
real effect. The call's content reaches the caller and never a ledger row, so a
replay returns none — it was never durable to begin with.

## The laws frozen here

### Authority

`packages/persistence/ledger` is the sole application authority. Restate is a **derived**
driver whose state may be deleted and reconstructed from the ledger. The SQLite
supervisor is not a degraded path: it is a first-class alternate driver over the
same core. It was the predetermined default had the Restate drills failed; they
passed, so the driver is now an explicit choice the daemon is given rather than
a fallback it works out for itself.

The `OrchestrationDriver` interface deliberately has no method that reads state
back from a driver in order to make a decision. That is how a derived
orchestrator becomes an authority in practice while a document still claims it
is derived.

**The fallback path an operator uses.** Disabling Restate, or never installing
it, does not degrade what a task means: pass `mode: "SQLITE_SUPERVISOR"` to
`startDaemon` (or the packaged binary's config) and the daemon reconciles and
walks the same plan documented above, binding no socket and spawning no
child — the server acquisition in "External tools" below is simply never
reached. The ledger stays the sole authority either way; only which driver
walks it changes. This is the documented, drilled path: P8-6's fallback gate
(`packages/entrypoints/daemon/test/fallback/index.test.ts`) runs the mode to
`CHECKPOINTED` over a real child process, the full plan trail asserted event
by event, with the pinned Restate ports checked unbound before and after — so
"the fallback is operational" is a claim proven by a re-runnable drill, not
one left to a comment.

### Recovery order

Ledger-first **intent**, then an idempotent and probeable **effect**, then a
ledger-verified **outcome**. A completion fact is never appended before the
effect has happened: an append is a claim, and a claim written early is a lie
the log cannot retract.

A crash after the effect but before the outcome append is closed by a
deterministic postcondition probe. A probe that returns `UNKNOWN` fails closed
and leaves an unclosed intent for an operator; it is never guessed in either
direction.

### Replay determinism

Every event and operation coordinate must come from one of exactly three
places: pure derivation over durable invocation inputs, the submission payload
captured before ingress, or a journaled durable step. Never from a clock, a
random source or mutable environment — in any code that can replay, whether it
sits inside `ctx.run` or outside it.

This is not fastidiousness. The ledger treats *same idempotency key, different
canonical bytes* as a typed conflict and fails closed, and the Restate SDK
documents that "there is a small window where an action may be re-run, if a
failure occurred between a successful run and persisting the result." A
coordinate built from `Date.now()` in that window comes back different, and a
benign replay becomes a hard conflict at the exact moment recovery is running.

The V2 coordinate follows the same law (P-18/protocolo G, ADR 0080). A
`DurableInvocation` may carry an optional `revision` — `revisionId`,
`revisionNumber`, `attemptNumber`, `envelopeSha256` and, since P-36/local D,
`envelopeArtifactReferenceId` — captured at submission. Without it, every key,
id and payload is what the walk built before G, save the contract version every
event states. With it:

- every event carries `revisionNumber` and `attemptNumber` and keys by
  `buildV2IdempotencyKey`, imported from `@acp/contracts` and never restated
  here; the contract refuses a V2 payload under any other key;
- the walk's first event is `TASK_ATTEMPT_OPENED` (`attempt.opened`, outside the
  plan, from no state into `DISCOVERED`), and the discovery follows it as a
  same-state event caused by it. The producer proposes the flat attempt as
  `1 + latestAttempt` read from the ledger port, refuses before the append when
  that differs from the invocation's, and refuses any other V2 step whose
  opening is not in the ledger;
- event ids, operation ids and `invocationId` stay over the flat attempt, which
  is already one per coordinate: no identity formula is new;
- the opening names the envelope by the registered `TASK_ENVELOPE` reference the
  caller hands in (P-36/local D, ADR 0084). Contract version `2.5.0` requires it
  on every revision record, and the ledger's door refuses one the registry does
  not hold. The reference is **carried, not published**: it is not in any
  preimage, this domain mints none and never derives one from the digest, and
  writing the envelope's bytes is adoption's.

What does not speak V2 yet is declared, not hidden. The daemon, durability, the
CLI and the gateway derive V1 invocations until the adoption binds a revision.

**The exceptional producers speak it since P-15 escalón B (ADR 0102).** These
producers build their own events outside `buildEvent`:

- provider pressure;
- the switch player and its landing;
- the failure and cancellation settlements;
- the tool-call receipt.

Each one spreads `payloadCoordinate(invocation)` into its payload. That is empty
for a V1 invocation, so every V1 byte is what it was (pinned by vectors lifted
from the pre-B source). For a V2 invocation it is the revision's
`revisionNumber` and `attemptNumber`, never the flat attempt.

Each producer also refuses a V2 invocation whose attempt has not been opened. It
does so before it builds, probes or appends anything, through the step
executor's `assertAttemptOpened`.

A switch candidate that names either coordinate key is refused before any
append: the coordinate is the walk's, never a plan's.

`restateInvocation` reads an opening-first task:

- the revision comes from the opening;
- the discovery is found by its V2 key;
- an opening that names an invocation other than this coordinate's is
  unreadable, like any other present-invalid field;
- the discovery's digest check is the one that vouches for the submission.

An intake-first task stays refused until P-15/D, so a task admitted through the
P-14/C intake cannot be cancelled or attached through the lifecycle door until
then.

**`recordTokenObservation` is not adopted** (adjudication v2 C1). Under V2 a
legacy `TOKEN_USAGE_RECORDED` stays refused by the contract. V2 spend is recorded
only as `USAGE_STREAM_DECLARED` / `USAGE_OBSERVATION_RECORDED`, which D wires. So
`readAccountUsage` and the quota fold see **no spend from a V2 walk until P-19**.

No producer of effects, deliveries or occurrences ships here: those are adoption
and recovery.

The two usage recorders of P-32/captura C (ADR 0090) are the exception to that
exception, and speak **only** V2. `recordUsageStreamDeclaration` and
`recordUsageObservation` require `invocation.revision` and refuse by name an
invocation without one, before building anything: a usage record names a route
segment or an effect, and a V1 invocation has neither. The payload's
`revisionNumber` and `attemptNumber` are read off the revision, never off the
flat `attempt`. What they record is what a normalizing adapter already
normalized:

- the stream id is `measurementStreamIdV1`, imported from `@acp/ledger` and never
  restated; a declaration is keyed `usage-stream.<id>`, an observation
  `usage-observation.<id>.<ordinal>` — no clock, and no landing generation,
  because the account and the segment are already inside the id;
- the recorders refuse by name only an invocation without a revision, a task the
  ledger has never seen, and a word outside `USAGE_SOURCE_CLASSES` or
  `USAGE_REPORT_KINDS`. The classes, the total, the range, the correction and
  the source's `occurredAt` pass verbatim; the ledger's door decides the rest in
  the append's transaction — a stream never declared (`STREAM_UNKNOWN`), an
  effect not yet delivered, a total that is not the sum (`TOTAL_MISMATCH`);
- a restart never reinvents a generation. `readUsageStreamLineage` reads the
  latest declared epoch of `(source, accountId, routeSegmentId)` back off the
  event stream through `UsageEventSource`, exhaustively or as a refusal
  (`LINEAGE_SCAN_INCOMPLETE`, `LINEAGE_DECLARATION_UNREADABLE`), and answers
  `latest: null`, never `0`, when nothing is declared. The caller restates that
  epoch, or declares it plus one after a counter reset, and chooses `0` only on
  `null`.

Since P-15 escalón D3 (ADR 0105) both recorders are wired, by one caller: the
execution chain below. L-P32C-1, which held them unwired until an adapter could
normalize a report, is retired into L-P15D-1: no other production source names them.

### The result recorder

P-07 escalón D (ADR 0100) gives an effect its answer, in three pieces.

- **`operation-result/`** decides, assembles and publishes. The decider reads the
  three facts of a trail by `kind` alone and decides only a `completed` terminal.
  The crossed pairs and an unobservable verdict are `FAILED`. The assembler builds
  the result document under the C4 rule: text blocks of at most 4 000 UTF-16
  units, at most 100 of them, or one markdown document by reference, never both.
  It refuses output that is too large, credential-shaped or empty instead of
  truncating or redacting it. The publisher first asks the ledger's own
  `effectOutcomeArrival`, which it calls and never mirrors. Only then does it put
  the document on the private plane as this task's `RESPONSE`, before anything
  references it. A replay publishes nothing, and a conflict is refused in the
  ledger's words before a byte moves.
- **`execution-effects`** takes an optional `recordResult`. With one, `apply`
  builds a private collector and passes its sink as `start`'s third argument. The
  sink never throws: past 8 MiB it stops retaining and says so, and a fault makes
  the output unreadable. The recorder is called once, on the `completed` branch
  only, with the three facts and the whole output, before the conformance gate and
  the marker. That is the usage sink's crash-safety order, so a throwing recorder
  leaves no marker and the effect re-executes. Without a recorder, `start` keeps
  its two arguments and the marker is byte-identical to the legacy path.
- **`buildResponseOccurrenceEvent`** records the answer's digest and length, which
  are the published `RESPONSE`'s own, against the prompt it answers. It builds its
  record as one literal of the ledger's five keys.
- **`readEffectResult`** (P-15/F, ADR 0107; on the barrel) reads an effect's result
  back by reference, for the two private-read doors only: the gateway's
  bearer-guarded route and the CLI's `result` verb. It returns a closed answer --
  `NOT_FOUND`, `NO_OUTCOME`, `OUTCOME_UNKNOWN`, `CANCELLED`, `NO_RESULT_RECORDED` with
  its cohort, `RESULT` with the parsed document and, when asked, one block read by its
  own reference, or `RESULT_UNREADABLE` with a closed word -- and serves `RESPONSE`
  bytes and nothing else (`CLASS_REFUSED`). It reads through the ledger's
  `readByReference` and appends, writes and logs nothing.
- **`resolveCredential`** (P-15/E, ADR 0108; on the barrel, with its port
  `CredentialResolverPort`, its answer `CredentialResolution` and its closed words
  `CREDENTIAL_REFUSALS`) resolves one account's `file://<name>` reference to a
  closure over the credential, for the one HTTP client the daemon's composition hands
  it to. It reads the accounts file through `loadAccountsFile`, then the one entry in
  the owner's `credentials.local.json` — the sibling derived beside that file, never
  configured — through the owner-file ladder `admitOwnerFile`, a strict
  `{contractVersion, credentials}` document, an own-property lookup and a visible-ASCII
  value grammar. `keychain://` is unsupported until P-19 and `profile://` is not a
  secret. It reads no environment variable, writes nothing, and a refusal carries a
  closed word and a path that names a file or an entry, never a byte of either.

Since P-15 escalón D3 the recorder is wired, through the execution chain below,
and the task's terminal state is coupled to the effect's outcome there.

### The execution chain

P-15 escalón D3 (ADR 0105, decisions 139 to 142) runs a task the intake recorded.
`execution-chain/` is the one behaviour authority for what a revision's walk
records around its one execution; the daemon builds it and hands its hooks to
`createExecutionEffects`, and orders nothing itself.

- **Before the start:** the `PRICE_TABLE` version in force at the walk's instant and
  covering the segment, or `DispatchRefusedError` with nothing intended and nothing
  spent; then `EFFECT_INTENDED` and `DISPATCH_INTENDED` with the pin. A delivery
  already on record is never started again: its session would answer under the same
  id (D2's resumed-run obligation), and reconciling it is P-18's.
- **Around the start:** `INFLIGHT` and the prompt occurrence when the port accepts,
  `ABANDONED` with the effect `FAILED` and no prompt when it refuses.
- **The spend:** one declared stream and one observation per report whose four
  classes are known; a class the source did not state records nothing, never 0.
  **No `TOKEN_USAGE_RECORDED` under a revision** (C1): `accounts/quota` and the
  rollups do not see a V2 walk's spend until P-19 folds settlements.
- **The result:** published before it is referenced, `SETTLED` with the pair, the
  response occurrence; a failed effect throws `OperationFailedError` after its
  appends, so no marker is written and the walk settles `TASK_FAILED`.
- **Before the marker:** the chain confirms the outcome is `SUCCEEDED` and the
  response is recorded, or the marker is refused.

Every identity is derived under the invocation and every instant is its
`submittedAt`; a delivery's `acceptedAt` therefore records the submission, not the
provider's acceptance. `createExecutionEffects` refuses part of a chain, and the
chain beside the legacy usage sink, at construction: "never emits" is refused at
runtime, not only by the fence. `settleFailure` settles nothing over a delivery left
open, `INTENDED` or `INFLIGHT`: an intention on record does not prove nothing was
sent, and the one sound `ABANDONED` is the chain's own, recorded where the port
refused the start.

`evidence-root/` admits the evidence directory beside an operator ledger —
`dirname(L)/executions`, the providers' six checks restated, the product-path
markers from `@acp/contracts` — and mints it as a `ScenarioRoot`.

### The READY predicate

P-27 cut A (ADR 0115, requirement A5) gives a scheduler concept its predicate and
nothing that dispatches. `ready/` holds two things, kept apart by body (L-P27-1):

- **`evaluateReady`** (on the barrel, with `READY_UNSATISFIED_REASONS` and
  `READY_UNKNOWN_REASONS`) judges one node on four conditions — **R1** in force (the
  graph revision and the task revision current, the task `CLASSIFIED` in the V2
  cohort), **R2** every edge's dependency by its `failPolicy`, **R3** the step admits
  work and the initiative is active, **R4** the assignment still resolves and the
  approval of the A6 class, if one is required, is in force against the injected
  instant. Each answers `SATISFIED`, `UNSATISFIED(reason)` or `UNKNOWN(reason)`; a node
  is READY iff all four are satisfied, and `UNKNOWN` never is. Within a condition a
  known block outranks an absence. The three policies' oracle is the definition ADR
  0115 records: `WAIT_SUCCESS` ⇐ `COMPLETED`, `ALLOW_FAILURE` ⇐ `COMPLETED | FAILED`,
  `REQUIRE_TERMINAL` ⇐ `COMPLETED | FAILED | CANCELLED`; `SUSPECT_WORKTREE` satisfies
  none, a legacy terminal satisfies none, and an effect in `OUTCOME_UNKNOWN` is an
  absence, never a failure. Pure and total: it reads no clock and no ledger, and `now`
  is an input — null answers `UNKNOWN(INSTANT_UNAVAILABLE)` wherever an expiry must be
  compared.
- **`readinessOf`** (on the barrel) is the production adapter. It reads one revision's
  nodes and edges and feeds each input from a row that exists or names its absence:
  every task is of the legacy cohort (the V2 cohort is P-21's), a dependency's terminal
  is its task's state only for the revision the task is at (the per-revision terminal
  is P-18's), the step's state and whether it depends on other steps (step transitions
  are a later cut's), the assignment through the intake's own recorded resolution
  against today's GLOBAL reading (STEP and INITIATIVE precedence is P-28's), and no
  approval producer (P-28). So no node reads READY in production — never a false READY
  and never a false block. The verdicts are computed at read time and never stored.

The intake (P-14/C) gained two refusal words with the task graph (decision 193's
obligation): a step its linked version does not declare is `REQUEST_INVALID`
`ROADMAP_STEP_UNKNOWN`, and a version of the cohort before steps, which declares
nothing, is `ROADMAP_STEPS_UNDECLARED` — unknown is never zero.

### Loopback and data roots

Every address is loopback and constant: Restate ingress `127.0.0.1:8080`, admin
`127.0.0.1:9070`, this service `127.0.0.1:9080`. The observation API (7517) and
UI (5178) are unchanged and restated only so port collisions are provable.

Data roots are repository-relative, git-ignored segments — never captured
absolute paths, which name a home directory, a user account and a machine
layout.

### The drill boundary

The runtime does **not** accept a target directory. It accepts a scenario
identifier and resolves it, itself, under `.acp-local/drills/`. A caller cannot
name a path, so a caller cannot name someone else's path. The identifier
grammar admits no dot and no separator, so no traversal segment can be spelled
at all, and containment is checked twice: once on the resolved string and once
through `realpathSync`, because those differ the moment a symlink is involved.

The toy effect is a single atomic marker write keyed by operation id. Re-running
it writes identical bytes; a marker with *different* content is never
overwritten, because that is somebody else's write and replacing it would
destroy the only evidence that something unexpected happened.

## External tools

`@restatedev/restate-sdk` is pinned at `1.16.9` and is a normal dependency; its
whole graph is itself plus one core package, and neither declares an install
script.

The Restate **server** `1.7.7` is deliberately **not** an npm dependency. The
`@restatedev/restate-server` package depends on `@scarf/scarf`, whose
`postinstall` is a network beacon, and this repository's install policy exists
precisely so nothing phones home while being installed. The server is acquired
as an external pinned binary under `.acp-local/tools/` by an explicit operator
command — never by an install hook. **Two** digests are pinned, the archive's
and the extracted binary's, and the pin is the authority rather than the
receipt: the receipt is bound to the pin field by field, and the installed
binary is independently re-hashed against the pin's own digest. Pinning only the
archive would have left the binary attested by nothing but the receipt that
travels with it.

## Tests

`pnpm test` runs the `runtime` project. For the supervisor it includes three
kill/restart drills against fresh, owned toy roots: killed after the intent,
after the effect, and after the outcome. For Restate it adds D1 through D5, a
final leak sweep, a cross-driver equivalence check and the acquisition-boundary
negatives. The children are real processes terminated with `SIGKILL`. An
exception caught in-process would prove nothing, because the page cache, the
open database handle and every object survive a thrown error, which is exactly
what a crash does not leave behind.

Each drill asserts the same things after restart: final state `CHECKPOINTED`,
the effect applied exactly once, `verifyIntegrity().ok`, no duplicate
idempotency keys, a third run that moves neither the event count nor the chain
head, and rebuilt projections equal to the live ones.
