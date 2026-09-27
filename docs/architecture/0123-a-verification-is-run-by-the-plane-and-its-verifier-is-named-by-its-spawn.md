# ADR 0123 — A verification is run by the plane, and its verifier is named by its spawn

- Status: accepted (P-16, cut C, recorded 2026-09-26).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0122's frozen vocabulary (nineteen words become twenty-one).

## Context

P-16/B (`d8e4fa4`, ADR 0122, decisions 231–233) gave a verification a door: a
receipt-form `VERIFICATION_COMPLETED` is admitted into `verification_read_model` only
with its receipt readable by reference, and the door recomputes the receipt's name from
its bytes. B left six things to this cut by name. No code produced a receipt. The
verifier's and the auditor's ids were checked for shape and independence only, because
no spawn registry existed (decision 232, ND-7 (a); §10.2 "Validación de referencia",
"Hasta P-16/C"). The tree hasher and its `write-tree` oracle were missing, and so were
the object of `policy_sha256`, the `writerIdIssuer` producer and the word
`OBJECT_FORMAT_UNSUPPORTED` (decisions 227, 229, 230, 233).

The brief (`p16-c/brief-v1`, measured at `d8e4fa4`) was pre-reviewed by the DT
(`ACCEPT_WITH_CORRECTIONS`, four blocking corrections B1 to B4). Its ND-1 to ND-19 were
adopted as rulings. The owner granted Git in disposable repositories, a bounded runner
and a non-personal fixture identity in those repositories (2026-09-25, item 3). Kimi and
Fable are not used (owner, 2026-09-26). Independent Claude verifiers check the result.

## Decision

### One — the runner: the fifth spawn site (decision 234; ND-1..7, ND-10, ND-14, ND-16, ND-17)

`packages/entrypoints/daemon/src/verification-runner` exports `runVerification(input)`.
It is a daemon-internal function: off the daemon barrel, with no route, verb or beat
(ND-2; P-16/D1 wires it). Its input has **no command field**. The checks are the
recorded envelope's `validation.commands`, read through runtime's `readRecordedTask`,
with the envelope held to its intake digest and the elected `route` to the intake's
resolution (B2). The order is the design. Everything that can refuse does so by name
before the first spawn:

1. The scratch root is absolute, real, a directory, not a link and not inside the
   worktree (`RUNNER_SCRATCH_ROOT_INVALID`). Bounds tighten only
   (`RUNNER_INPUT_INVALID`).
2. The task is read back (`RUNNER_TASK_UNREADABLE`, carrying the reader's word) and
   must not be in a contracts `TERMINAL_STATES` state (`RUNNER_TASK_TERMINAL`).
3. The envelope must declare checks (`RUNNER_CHECKS_UNDECLARED`). Its write-set must
   not be empty (`RUNNER_WRITE_SET_EMPTY`, ND-10; the lawful `NO_COMMIT` path is
   P-16/D2's D-S1-2). Its title must be one the commit body rule admits
   (`RUNNER_COMMIT_BODY_INVALID`, ND-17). The writer's label must be a worker identity
   other than the runner's.
4. The object format is read through the one git read authority
   (`rev-parse --show-object-format`) before anything reads an object id. `sha1`, or
   `OBJECT_FORMAT_UNSUPPORTED`, carried on the outcome with class
   `CAPABILITY_UNSUPPORTED` (contracts §16.2; ND-14 (a): the word lives in the runner's
   vocabulary until P-38 or P-17 reads it).
5. The worktree is observed through `observeWorktree`. An unborn HEAD is
   `BASE_HEAD_MISSING`. An observed change outside the declared write-set is
   `RUNNER_WRITE_SET_VIOLATION`, with no receipt. The quarantine stays the conformance
   gate's (ADR 0024, decision 228).
6. The writer id's issuer comes from the attempt's recorded route segments
   (`WRITER_ID_UNISSUED`; Four). The verifier's run id is the next ordinal of the
   attempt (Three).

Then comes the **copy** (ND-5 (a)). One per-run directory under the scratch root holds
three siblings: `tree`, the copy the checks run in, plus `home` and `tmp`. The copy
holds exactly the tree the receipt names: every index path (`ls-files -s -z`) and every
observed untracked path, minus deletions. It is copied no-follow (a link stays a link),
with no `.git` and no ignored file. It is bounded in files and bytes
(`RUNNER_COPY_BOUND_EXCEEDED`). The tree the checks see and the tree that is hashed are
one set of bytes (Two).

The **checks** run in declared order, each as
`spawn("/bin/sh", ["-c", command], {shell: false, detached: true, stdio: ["ignore",
"pipe", "pipe"], cwd: copy, env})`, and fail fast (ND-4): the first nonzero or killed
check ends the run `FAIL`, and the receipt lists the checks that ran. After the checks
the original worktree is observed again (ND-16). Any difference makes the run `FAIL`,
with the checks as they ran: a writer racing the verifier is seen. The receipt is
parsed by `VerificationReceipt` and published as a private `RECEIPT`, scoped to the
task. Its receipt-form event is appended through `Ledger.append` in the same state
(`fromState = toState`, `transitionId = "verification.run.<runId>"`, V2 key, ND-14),
with `emittedBy` set to the runner's label `acp/verification-runner/verifier/01`.
Refusals of either are carried (`RUNNER_PUBLICATION_REFUSED`, `RUNNER_RECORD_REFUSED`
with the door's or ledger's word). The per-run directory is removed in `finally`, and
only when its recorded dev/ino still match and it is a direct child of the admitted
root (ND-6).

**The environment is built, never inherited:** `PATH=/usr/bin:/bin`, `LC_ALL=C`,
`HOME` and `TMPDIR` in the per-run directory, and Git confined to the copy (B1):
`GIT_CEILING_DIRECTORIES` at the admitted scratch root, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`. The copy has no `.git`, so without the ceiling a check's
`git` would walk up into any repository that holds the scratch root.

**Bounds** (ND-3 as corrected by B4, ND-7) are per-check wall time, per-check output
bytes (stdout and stderr counted raw as they arrive; `maxBuffer` does nothing on
`spawn`) and the run's total wall time. Exceeding one kills the check's whole process
group, grandchildren included. The exit code is recorded as follows:

- a check the runner killed for a bound: `137`;
- a check that could not be started: `127`;
- a check ended by a signal: `128 +` its number from a closed literal (SIGHUP 1, SIGINT
  2, SIGQUIT 3, SIGABRT 6, SIGKILL 9, SIGSEGV 11, SIGPIPE 13, SIGTERM 15; no
  `node:os`), or `255` for a signal outside it.

All three record the run `FAIL`. A check's **output is counted and discarded**. It
reaches no row, event, stream, log, error or artifact.

**There is no operating-system sandbox in this cut** (ND-1 (a)). A declared check is a
shell command and can reach any path the daemon can reach. The confinement is by
construction: declared commands only, a disposable cwd, a built environment with the
git ceiling, and bounds. The mechanism is P-25's, and its row says so.

### Two — the tree hasher and its oracle (decision 235; ND-18, ND-19)

`packages/entrypoints/daemon/src/tree-hasher` computes the receipt's `treeSha` in
process. It hashes sha1 blob objects (`"blob " + length + "\0" + bytes`) and sha1 tree
objects in git's entry order: by name bytes, with a tree's name compared as if it ended
in `/`. It reads a copy with no-follow:

- A regular file is `100644`, or `100755` when its owner may execute it.
- A symbolic link is `120000`, and its blob is the link's target bytes.
- A gitlink, a FIFO, a socket, a device or a path under a linked parent is
  `TREE_ENTRY_UNSUPPORTED`.
- A conflicted index is `TREE_INDEX_CONFLICTED`.
- A path git's bytes cannot state is `TREE_PATH_UNSUPPORTED`. This includes a name that
  was not UTF-8, which reaches the plane through the observer's decoding as a
  replacement character and is never hashed from a mangled name (ND-5, a stated
  limit).

The hasher spawns nothing, runs no Git and cannot write (L-P16C-2). Its **oracle** is
test-only. For every fixture shape, the same content is written into a fresh disposable
sha1 repository under `os.tmpdir()` with plumbing only (`init`, `hash-object -w
--stdin`, `update-index --add --cacheinfo`, `write-tree`), under a hermetic environment
and the synthetic identity `acp-fixture <fixture@invalid>`. The two ids must be equal.
The shapes are an empty file, nested directories, the `a-b`/`a.b`/`a/`/`a0` prefix
order, an executable file, a symbolic link, a path with a space and non-ASCII UTF-8,
and a 1 MiB file. The empty blob and the empty tree are also checked.

### Three — the spawn registry, at the door and in the fold (decision 236; ND-8, ND-9, ND-13; B3)

Contracts `commit-authorization` declares `SUPERVISED_WORKER_ID_UUID_NAMESPACE =
370c3107-1424-5cc1-b7ca-74d37eb0fb68`. It is itself `uuid5(writer namespace,
"acp/supervised-worker-id/v1")` (ND-9 (a), "bajo su propio espacio de nombres").
Ledger `receipt-identity` computes `supervisedWorkerIdFor(taskId, flatAttempt, role,
ordinal)`, the v5 over `taskId/flatAttempt/role/ordinal`. The role is a `WORKER_ROLES`
literal: `verifier` for a verification and `reviewer` for an audit, because an auditor
is a reviewer and there is no `auditor` role. The ordinal is the spawn's run id. The
v5 construction is one private function shared with `writerWorkerIdFor`, whose four
vectors are unchanged.

The registry is **this derivation plus the recorded rows** (ND-8 (a)). There is no
migration. `lastRunId` is the largest recorded `verifier_run_id` or `auditor_run_id` of
the coordinate, and the door answers it through `ix_*__attempt`. B's
`decideVerificationRecord` checks each key it does not already hold, in this order
(B3):

1. `runId === 1 + lastRunId`, or the record is refused `VERIFIER_NOT_REGISTERED` at
   `…verifier.runId`.
2. `workerId === supervisedWorkerIdFor(task, legacy, "verifier", runId)`, or the same
   word at `…verifier.workerId`.

The auditor mirrors this with `reviewer` and `AUDITOR_NOT_REGISTERED`. A receipt is
judged only when `view.verification(sha)` is null, so a replay of the same receipt
with the same metadata keeps its first row. A verdict is judged whenever its event id
is new: always at the door, and in the fold only when `view.auditVerdict(eventId)` is
null. An uppercase id is still B's `RECEIPT_RECORD_INVALID`, refused by grammar before
the registry is asked. `VERIFICATION_REFUSALS` goes from 19 to **21** (this amends ADR
0122's freeze). Ledger gains the read-only `listVerifications(task, revision,
attempt)`, which the runner uses for its next ordinal. `receiptVerificationColumns`
leaves the module for its second caller, the runner.

**Stated limits, owner P-18.** A spawn that crashed before its receipt was recorded
leaves no row, and the retry reuses its ordinal. Two concurrent runs of one attempt
both take the same run id, and the second append is refused. The stream's idempotency
key `verification.run.<runId>` refuses it first (`LEDGER_IDEMPOTENCY_CONFLICT`), before
the door would say `VERIFIER_NOT_REGISTERED`.

**No bump** (ND-13 (a)). The key grammar and the writer's rule are unchanged. History
admitted between migration 28 and this cut with ids outside the registry had no
producer: it exists in tests only, and there is no operational history before P9. Such
history is refused by name on rebuild, a declared limit in the mould of B's ND-10.
From this cut on, the supervised rule joins decision 232's bump condition: any later
change to it owes a bump with its cohort. `CONTRACT_VERSION` stays 2.11.0.

### Four — the writer id issuer's producer (decision 236; ND-11)

Runtime `commit-authorization` exports `writerIdIssuerFor(segments)`. When every
recorded segment of the attempt is `provider = "claude"` with `transportKind =
"CLI_SUBSCRIPTION"`, it returns `CLAUDE_CLI_SESSION`. It returns `null` for no segment,
or for any other segment: an API key, a local model, another provider's CLI, or a mixed
handoff. The runner refuses `WRITER_ID_UNISSUED` on `null`, before any spawn.
`WRITER_ID_ISSUERS` stays module-private, and the function is the promotion decision
229 anticipated. `authorizeCommit` keeps its caller-supplied field until P-17/A gives
it this answer. The door and the fold do not check the issuer.

### Five — the object of `policy_sha256` (decision 235; ND-12)

`verificationPolicySha256(policy)` in ledger `receipt-identity` computes:

    sha256("acp/verification-policy/v1\n" +
           canonicalJson({commands, independentVerifierRequired, commitPolicy}))

This is the fourth versioned prefix of that module, and L-P16A2-1 is amended. The three
members are the recorded envelope's, and the commands keep their declared order.
P-17/A recomputes the digest from the envelope alone. The runner's bounds are not in
the object, a stated limit. Two vectors are computed by Python `hashlib` over literal
preimages.

### Six — laws, bites and pins (decision 237; ND-15)

- **L-P16C-1** — "one bounded runner: it spawns only declared checks, with a built
  environment, and prints nothing". It applies to the daemon's `src`. The shell
  literal appears once, as `CHECK_SHELL`, with one spawn of that shape. There is no
  `process.env`. `builtEnvironment(runDirectory, scratchRoot)` is one frozen literal of
  constants plus those two, with the git ceiling and both config variables (B1 admits
  the two arguments). The commands come only from `envelope.validation.commands`, and
  the input type names no `commands`. There is no `console.`, `appendFileSync`,
  `writeFileSync`, `createWriteStream`, log import or `/usr/bin/git`. `runVerification`
  is declared once.
- **L-P16C-2** — "one tree hasher, in-process, sha1, and it cannot write".
  `function treeSha(` appears once in `src`. `createHash("sha1")` appears in the
  daemon's `src` only in the hasher. The hasher names no spawn or write verb.
- **L-P16C-3** — "the verifier and the auditor are named by their spawn, and the door
  checks it". The namespace literal appears once, in contracts. `function
  supervisedWorkerIdFor(` appears once, in `receipt-identity`, which imports the
  namespace. `verification-record` imports and calls the derivation for both forms and
  refuses by both words.
- **Amended in its own row:** L-P16A2-1 adds `acp/verification-policy/v1`,
  `function verificationPolicySha256(` and `function supervisedWorkerIdFor(`.
- **Pins:** `PATH_SCOPED_LAWS` 179 → **182**; `SPAWN_ALLOWED_FILES` 4 → **5**, and the
  stale "two production files" texts are corrected; `CONTRACTS_SCHEMA_EXPORTS` 189 →
  **190**; `RUNTIME_PUBLIC_EXPORTS` 307 → **308**; the ADR corpus 122 → **123**.
  `P16C_WRITE_SET` is frozen at 32 paths, 7 of them new.
- **Unchanged:** `API_CONTRACT_VERSION` 0.25.0, `MIGRATIONS` 28,
  `PROVIDERS_PUBLIC_EXPORTS` 97, `DAEMON_PUBLIC_EXPORTS` and `DAEMON_ALLOWED_BUILTINS`.

## Alternatives rejected

- **`sandbox-exec` now (ND-1 (b)).** It chooses P-25's mechanism early, it is
  deprecated, and it may fail nested under an agent's own seatbelt.
- **A daemon beat now (ND-2 (b)).** It widens into composition and the walk, and it
  collides with D1.
- **A fixed 124 for every kill (ND-3 (b)).** It loses the signal.
- **Running every check (ND-4 (b)).** A killed run has to stop anyway, and more output
  is not evidence the receipt can carry.
- **A blind recursive copy (ND-5 (b)).** It is heavy, and the checks would see bytes
  outside the receipt's tree.
- **A spawn event and table (ND-8 (b)).** Migration 29, a new event type and probably a
  bump, for a crash case P-18 owns.
- **Bounds in the policy object (ND-12 (b)).** P-17/A would need the runner's constants.
- **A 2.12.0 bump (ND-13 (b)).** `ENVELOPE_VERSION_SUPERSEDED` for every 2.11.0 task,
  for no reader.

## Consequences

- A registered task can have a real receipt. The runner produces one on demand, and
  D1 decides when the lifecycle calls it.
- Every receipt-form or verdict-form record now carries a registry id. A producer
  derives the id. It cannot choose it.
- The checks run with nothing of the daemon's environment, in a copy that is removed.
  Real toolchain checks, such as `pnpm check` inside the copy, need ignored
  dependencies and a toolchain `PATH`, so they are out of this cut. Their environment
  profile belongs to P-25 and P-21.

## Not in this record

- The consumer beats that replace the walk's verify and audit beats, `AuditorPort`,
  the auditor's producer and evidence grammar, where the lifecycle calls the runner
  (`RUNNING → VERIFYING`), and N03 (P-16/D1). D-S1-2, the lawful `NO_COMMIT` path and
  `WRITE_SET_EMPTY` before spend, stays with P-16/D2.
- `authorizeCommit` taking `writerIdIssuerFor` and the recorded policy, §10.4–§10.5,
  the in-force predicate, and the lock-window re-check of decision 231 N-3 unless D1
  takes it (P-17/A). The git writer and the committer identity (P-17/B). `cat-file`
  (P-17/C).
- The process sandbox (P-25). Resource admission of runs with spend (P-34).
  Writer-id issuers beyond the Claude CLI, and revocation (P-28). SHA-256 (P-38).
- Crash reconciliation of a spawn with no receipt, and concurrent runners (P-18).
- Any HTTP or CLI surface for runs or receipts.
