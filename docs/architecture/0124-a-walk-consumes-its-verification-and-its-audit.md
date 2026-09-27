# ADR 0124 — A walk consumes its verification and its audit

- Status: accepted (P-16, cut D1, recorded 2026-09-26).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0122's and ADR 0123's frozen vocabulary (twenty-one words become
  twenty-seven), and ADR 0122's open question on a form key under the wrong type.

## Context

P-16/B (ADR 0122) gave a receipt and a verdict a door. P-16/C (`cb69657`, ADR 0123)
gave the plane a runner that produces a receipt, and named the verifier and the auditor
by their spawn. Neither cut changed the walk. Steps 6 (`verified`,
`VERIFICATION_COMPLETED`, `RUNNING → VERIFYING`) and 7 (`audited`, `AUDIT_COMPLETED`,
`VERIFYING → AUDITING`) stayed `PLAIN` beats: a recorded task reached `CHECKPOINTED`
with nothing verified and nothing audited. Decision 237 and ADR 0123 "Not in this record"
left to this cut, by name, the consumer beats, `AuditorPort`, the auditor's producer and
its evidence grammar, where the lifecycle calls the runner, and N03 (both daemon walk
sites stated `LOCAL_COMMIT_WITH_RECEIPT` instead of reading the envelope).

The brief (`p16-d1/brief-v1`, measured at `cb69657`) was pre-reviewed by the DT
(`ACCEPT_WITH_CORRECTIONS`, five blocking corrections B-1 to B-5). Its ND-1 to ND-18
were ruled and adopted. The owner ordered delivery over iteration (2026-09-26): one cut
(ND-16), targeted checks, no full `pnpm check`. Kimi and Fable are not used; an
independent Claude verifier checks the result.

**The D1/D2 split.** map-v3 and the P-16 packets row said "D2 = N03 + D-S1-2". Decision
237's "Sigue abierto" and ADR 0123, both later and adjudicated, put N03 in D1 and leave
only D-S1-2 in D2. This record follows them, and the packets row is re-sealed to
"Quedan: D2 (D-S1-2)".

## Decision

### One — the phased walk and its consumer beats (decision 238; ND-1, ND-2, ND-3, ND-10)

The plan table is byte-unchanged: indices, transition ids, event types and states. On a
revision-bearing (V2) invocation only, steps 6 and 7 become **consumer beats** at their
indices (map-v1 D-1 (b)):

- Before the synchronous append of a `PLAIN` step, the SQLite supervisor's
  `#executeStep` awaits runtime's `produceBeforeStep(context, step)`. For step 6 it asks
  the verifier port for the coordinate's largest-run `PASS` receipt. If there is one, it
  is reused: a resumed walk does not run the checks again. Otherwise the port runs once
  and records a receipt-form `VERIFICATION_COMPLETED`. For step 7 it asks the auditor
  port for the largest-run `ACCEPT` verdict on **the receipt step 6's recorded event
  carries**, read back from the ledger and never re-derived, and otherwise audits once.
- In the append, `appendPlanStep` adds one closed key naming that row, in the
  `CHECKPOINT_WRITTEN` mould: `verifiedReceipt: {receiptSha256}` on step 6 and
  `auditedVerdict: {auditId, receiptSha256}` on step 7. A beat already recorded is
  rebuilt from its own recorded reference, so a replay rebuilds the same bytes
  whatever was recorded after it.

The ports are optional on `SqliteSupervisorOptions` and `BeatContext`, and **the
optionality is the refusal**: a V2 walk with no ports is refused at step 6 with a
`SupervisorError` and appends nothing past step 5. This holds for `advance()` too, the
same `#executeStep`: a lifecycle-verb advance of a V2 task past step 5 refuses. The
Restate driver is not touched; it walks V1 only (the recorded form is refused under
Restate). `LedgerPort` is not widened: the ports read the rows.

A V1 invocation has no coordinate a receipt could name, so its beats stay `PLAIN`, byte
for byte (ND-3); PC-D3's pinned V1 trail is unchanged. The producer forms are facts
recorded **same-state**: the receipt at `RUNNING`, the verdict at `VERIFYING`.

### Two — the ports, and what a failed phase does (decision 238; ND-4, B-5)

Runtime declares `VerifierPort` (`recordedPass`, `latest`, `verify`), `AuditorPort`
(`recordedAccept`, `latest`, `audit`), `VerificationPorts`, `VerifyOutcome` and
`AuditOutcome`. A runner refusal or a `FAIL` receipt throws
`VerificationPhaseError("VERIFICATION_FAILED", word)`. An auditor refusal or a verdict
other than `ACCEPT` throws `VerificationPhaseError("AUDIT_NOT_ACCEPTED", word)`.
`classifyFailure` gains that one class, tested first, and settles it under its reason:
`FAILURE_REASONS` becomes `AUDIT_NOT_ACCEPTED`, `BOUND_EXHAUSTED`, `EXECUTION_FAILED`,
`VERIFICATION_FAILED`. The word rides the error message only (P-18 owns causes). The
receipt and verdict rows already recorded stay.

On a resume there is no retry until green (ND-4). A coordinate with no `PASS` and a
latest `FAIL` settles `VERIFICATION_FAILED` without a new run. A latest non-`ACCEPT`
verdict with no `ACCEPT` settles `AUDIT_NOT_ACCEPTED` without a new audit.

The supervisor's switch fork does not consider a `VerificationPhaseError` (B-5). A
`FAIL` receipt or a `REJECT` is a verdict on the work, not pressure on the account, and
a switch would run the same work again. It settles directly and the switch port is not
consulted, whatever pressure the attempt observed.

### Three — the door and the fold (decision 238; ND-2, ND-11, ND-18, B-4)

`decideVerificationRecord`, one decision with two callers (decision 56), gains the
consumer forms. On a V2 subject, an event of the two types that is not a same-state
producer form must be a state-changing consumer form:

- no reference key, or a same-state bare beat: `CONSUMER_REFERENCE_ABSENT`;
- a malformed reference (a missing or extra member, uppercase hex, an audit id that is
  not a lowercase UUID), the key on a same-state event, on a V1 subject, under the other
  type, or beside a producer key: `CONSUMER_REFERENCE_INVALID`;
- a reference that names no `PASS` receipt of the same coordinate, or no `ACCEPT`
  verdict of the same coordinate on that receipt: `CONSUMER_REFERENCE_UNRECORDED`.

An admitted consumer event projects no row. The producer forms must be same-state: a
receipt or verdict form on a state-changing event would move the task past the consumer
gate, and it is `RECORD_FORM_MISPLACED` at `toState` (B-4). A producer key under the
other type, the question ADR 0122 left open, is the same word at its key (ND-18); B
admitted it as a beat, a silent half-record.

The fold refuses the same histories in the same words. No migration and no
`CONTRACT_VERSION` bump (ND-11 (a)): the producer forms' keys are unchanged, the
consumer keys are new and join decision 232/236's condition, and V2 bare-beat history
exists in tests only, before P9. A rebuild refuses it by name.

### Four — the deterministic local auditor and the evidence grammar (decision 239; ND-6, ND-7, ND-8, ND-17)

`daemon/src/auditor` exports `createLocalAuditor({ledger, plane, route})`, an
`AuditorPort`, off the daemon barrel. It is a rule engine, not a model. It spawns
nothing, runs no Git, reaches no provider or network, and writes only through the plane
and the ledger. Its label is `acp/deterministic-auditor/reviewer/01` (role `reviewer`,
matching `WORKER_IDENTITY_PATTERN`, distinct from the writer and from
`acp/verification-runner/verifier/01`). One audit does this:

1. It reads the receipt row (`getVerification`) of the coordinate asked about. The row
   must be `PASS`: otherwise `AUDITOR_RECEIPT_UNKNOWN` or `AUDITOR_RECEIPT_NOT_PASS`.
2. It reads the task back through `readRecordedTask`, which must not be terminal
   (`AUDITOR_TASK_UNREADABLE`, `AUDITOR_TASK_TERMINAL`). It reads the receipt's bytes
   by reference and parses them (`AUDITOR_RECEIPT_UNREADABLE`, a refusal, never a
   verdict).
3. It computes its run before anything is published: `runId = 1 +` the coordinate's
   largest `auditor_run_id` (through `listVerifications` and `listAuditVerdicts`, the
   door's `lastRunId("reviewer", …)`), and its id
   `supervisedWorkerIdFor(task, flat, "reviewer", runId)`.
4. It applies six closed rules, each `PASS` or `FAIL`:
   - `RECEIPT_BYTES_MATCH`: the bytes recompute the row's name.
   - `RECEIPT_PASS`: `PASS`, at least one check, all zero.
   - `CHANGES_WITHIN_WRITE_SET`: every observed tracked and untracked path is declared.
   - `POLICY_MATCHES_ENVELOPE`: `verificationPolicySha256` of the recorded envelope.
   - `INDEPENDENT_IDS`: writer, verifier and auditor are pairwise distinct by label and
     by id.
   - `DIFF_PRESENT_FOR_COMMIT`: under `LOCAL_COMMIT_WITH_RECEIPT`, at least one
     observed difference; vacuous under `NO_COMMIT`.

   The verdict is `ACCEPT` iff every rule passes, and `REJECT` otherwise. A rule engine
   has no corrections to propose. The "diff" is the receipt's recorded observation,
   never a file's content.
5. It publishes the evidence as a private `EVIDENCE` artifact of the task,
   `PERMANENT`, with no expiry (`AUDITOR_PUBLICATION_REFUSED`).
6. It appends the verdict-form `AUDIT_COMPLETED`, same-state, under
   `audit.run.<runId>`, through `Ledger.append` (`AUDITOR_RECORD_REFUSED`, with the
   door's word carried).

The evidence grammar is contracts' `AuditEvidence`: a strict object of
`evidenceVersion` `acp/audit-evidence/v1`, `receiptSha256`, `treeSha`, `auditor
{identity, workerId, runId}`, `verdict`, and the `rules` from the closed list, each at
most once and in sorted order. An `ACCEPT` over a failed rule is not an `AuditEvidence`.
It is published as canonical JSON, and `evidence_sha256` is the artifact's
`content_sha256`, which binds the verdict to its receipt (§10.3). The door checks it in
this order, so B's word stays reachable:

1. B's reference checks (`EVIDENCE_REFERENCE_INVALID`).
2. B's binding (`EVIDENCE_RECEIPT_MISMATCH`).
3. The strict, canonical parse (`EVIDENCE_UNREADABLE`).
4. `treeSha`, `auditor` and `verdict` equal to the record (`EVIDENCE_FIELD_MISMATCH`).

The fold never reopens the blob. `VERIFICATION_REFUSALS` 21 → **27**, sorted.

Observation's baseline counts a verdict-form audit by `auditVerdict.verdict`. It skips
the step-7 consumer beat, which is not an audit, and keeps a V1 bare beat
`acceptance.unreported` (ND-17). This closes ADR 0122's second named limit.

### Five — N03 and the runner's fold-ins (decision 240; ND-9, ND-12, ND-13, ND-14)

Both daemon walk sites read the policy: `runComposedSqliteWalk` passes
`input.envelope.commitPolicy`, and the Restate site passes
`walked.envelope.commitPolicy`. A `NO_COMMIT` envelope walks `READ_ONLY_PLAN`, with no
`READY_TO_COMMIT` and no `COMMIT_*`. A `LOCAL_COMMIT_WITH_RECEIPT` inline walk is byte
for byte what it was.

The recorded composition makes `<daemon root>/verification` (0700, realpath'd, spelled
once in `composition/index.ts`) and hands it to the runner-backed `VerifierPort` with
the admitted worktree and the walk's own label as the writer's. An inline walk has no
ports and no scratch root.

The runner folds in the P-16/C verifier's notes:

- NB-1 (ND-14): on a bound, the group is killed, both pipes destroyed, and 137 settles
  at once. On `exit`, the check settles with its own code when both pipes close or at
  its deadline, whichever comes first. A grandchild that left the group can no longer
  hold the run past its bound. That escapee is not reaped: a stated limit P-25 owns.
- NB-2 (ND-12 (a)): `indexPaths` carries each record's mode and object id. After the
  copy, every index path the observation reported as neither changed nor untracked must
  hash to them, before any spawn (`RUNNER_INDEX_DIVERGED`: an `assume-unchanged` or
  `skip-worktree` flag hid a change).
- NB-3: `rev-parse --show-toplevel` is realpath-equal to the worktree, or
  `RUNNER_WORKTREE_NOT_ROOT`, with zero spawns.
- NB-4: a no-follow walk gives the owner back its bits before the per-run directory is
  removed.

`RUNNER_REFUSALS` 17 → **19**. NB-5: ADR 0123's "any difference" of the second
observation reads "any observed difference" (the runner compares the two observations),
and the runner's own comment says so. ADR 0123 is not edited. NB-7: of two concurrent
runs of one attempt, the second append is refused `LEDGER_IDEMPOTENCY_CONFLICT` (both
derive the same `verification.run.<n>` key); the module comment is corrected. Decision
231 N-3, the re-check under the lock, stays with P-17/A (ND-13).

### Six — the fixtures that reach `CHECKPOINTED` (B-3)

Under `LOCAL_COMMIT_WITH_RECEIPT` the auditor accepts only an observed difference, and
the recorded fixtures' worktrees were clean. The mechanism is the brief's alternative:
the drill's worktree builder leaves one in-write-set change after its base commit, and
it is built after the intake and before the start. This covers the D4 worktree, the bin
suite's worktree and the composition suite's. The fake children are unchanged.
PC-D3's inline worktree is its own, so its trail pin is untouched. The recorded intakes
declare synthetic checks (`test -f docs/d4.md`), which read the copy and spend nothing.
The no-change case stays N3's: `REJECT`, settled `AUDIT_NOT_ACCEPTED`.

### Seven — laws, bites and pins (decision 241; ND-15)

- **L-P16D1-1**, "a lifecycle beat consumes a recorded verification and audit":
  - The two consumer keys are spelled only in runtime's `verification-phase` (declared
    once each), the ledger's `verification-record` and observation's `baseline`.
  - The door refuses by `CONSUMER_REFERENCE_ABSENT`, `CONSUMER_REFERENCE_UNRECORDED` and
    `RECORD_FORM_MISPLACED` at `toState`.
  - `#executeStep` awaits `produceBeforeStep(context, step)` exactly once, and the step
    executor asks `consumerReference(context, step)` once.
  - The phase names no `child_process`, `/usr/bin/git`, `@acp/providers` or `.append(`.
- **L-P16D1-2**, "one auditor, deterministic, local and read-only, and one evidence
  grammar":
  - `createLocalAuditor` is declared once, in the daemon, and `AuditEvidence` once, in
    contracts.
  - The auditor is not a spawn site and names no spawn, provider, network, console,
    write sink, log or Git.
  - It publishes only `EVIDENCE` and parses by `AuditEvidence.parse(`, and the door
    judges by `AuditEvidence.safeParse(`.
- **L-P16D1-3**, "the commit policy is read, never stated": no `commitPolicy:` in the
  daemon's `src` takes a string literal, and both walk sites read the envelope.
- **Pins:** `PATH_SCOPED_LAWS` 182 → **185**; `RUNTIME_PUBLIC_EXPORTS` 308 → **314**
  (`VerificationPhaseError` and the five port types; the phase and its coordinate type
  stay off the barrel); `CONTRACTS_SCHEMA_EXPORTS` 190 → **191** (`AuditEvidence`;
  its rule words are its own enum, not an export); the ADR corpus 123 → **124**.
  `P16D1_WRITE_SET` is frozen at 46 paths, 7 of them new.
- **Unchanged:** `CONTRACT_VERSION` 2.11.0, `API_CONTRACT_VERSION` 0.25.0,
  `MIGRATIONS` 28, `SPAWN_ALLOWED_FILES` 5, `DAEMON_PUBLIC_EXPORTS`,
  `COMPOSITION_PUBLIC_EXPORTS`, `DAEMON_ALLOWED_BUILTINS`, `PROVIDERS_PUBLIC_EXPORTS`
  97.

The laws are text matchers, as L-P27C-1's are. The semantic guards are the ledger's
consumer-form suites (door and fold, including a producer form made state-changing), the
phase's suite, the auditor's suite and the composition suite's N03 case.

## Alternatives rejected

- **A split driver API (ND-1 (b)).** Split `runToCheckpoint` into "to outcome" and
  "from verification", with the daemon in between. It needs a new driver API and would
  re-plumb every walking test.
- **Reusing B's words for the consumer (ND-2 (b)).** A consumer refusal and a producer
  refusal would then read the same.
- **Refusing a V1 walk at step 6 (ND-3 (b)).** Every V1 drill would stop at `RUNNING`,
  Restate included.
- **Leaving a failed phase unsettled (ND-4 (b)).** That is the V2-B7T defect: a task
  with no terminal.
- **Refusing at the recorded composition's start (ND-5 (b)).** The P-15/E recorded
  client suites would lose their end-to-end coverage. The pre-spend refusal is D2's
  class.
- **An auditor that always accepts a `PASS` (ND-6 (b)).** An auditor in name only.
- **A ledger-private grammar, or no door check (ND-7 (b), (c)).**
- **A runtime auditor (ND-8 (b)).** More runtime pins, and a public surface nobody
  calls.
- **A 2.12.0 bump (ND-11 (b)).** A cohort for a form no history outside tests holds.

## Consequences

- A recorded task that reaches `CHECKPOINTED` has a `PASS` receipt of its coordinate
  and an `ACCEPT` verdict on it, each named by its beat.
- A recorded task whose checks fail, or whose writer changed nothing under a commit
  policy, settles `FAILED` with a closed reason after its spend.

## Stated limits

- **`CHECKPOINTED` does not credit success. `COMPLETED` is P-21's** (contracts §12; the
  P-16/D ADR repeats it).
- The label offset: the plan's step 6 enters `VERIFYING` on a `PASS` receipt, one step
  earlier than contracts §2.1's "verificación completada" label. It is an offset of
  labels, not of gates.
- V1 bare beats stay admitted until the V1 form retires (P-21, ND-3).
- API_KEY and local transports have no writer-id issuer (P-28). A recorded walk on them
  spends and then fails verification `WRITER_ID_UNISSUED`. So does a recorded envelope
  with no declared checks (`RUNNER_CHECKS_UNDECLARED`). Refusing both before spend is
  P-16/D2's (D-S1-2 class, ND-5). D-F-4 and D-F-5 keep their result-chain assertions and
  change only their final state. The empty write-set also fails only after spend
  (inline `WRITE_SET_EMPTY`, recorded `RUNNER_WRITE_SET_EMPTY`), D2's as before.
- The daemon root lives inside the ACP checkout. A recorded task whose worktree is the
  ACP checkout is refused `RUNNER_SCRATCH_ROOT_INVALID` (P-21).
- The NB-1 escapee outlives its group: the return is bounded, the process is not
  reaped (P-25).
- A spawn that crashed before its receipt or verdict was recorded leaves no row, and
  its ordinal is reused. Concurrent runs are P-18's.

## Not in this record

- D-S1-2: the lawful `NO_COMMIT` path with an empty write-set, `WRITE_SET_EMPTY` at
  intake before any spend, and the pre-spend refusals of ND-5 (P-16/D2).
- The following are P-17/A's: `commit_authorization_read_model` (§10.5) and §10.4; the
  in-force predicate; `authorizeCommit` taking `writerIdIssuerFor` and the recorded
  policy; "the authorized receipt is the last `VERIFICATION_COMPLETED`"; and the
  lock-window re-check of decision 231 N-3.
- The git writer and committer identity (P-17/B). `cat-file` and step 9 as a consumer
  beat (P-17/C).
- The process sandbox and the escapee's reaping (P-25). Issuers beyond the Claude CLI
  (P-28). SHA-256 (P-38). A real (LLM) auditor, which needs its own owner order.
- Any HTTP or CLI surface for runs, receipts or verdicts.
