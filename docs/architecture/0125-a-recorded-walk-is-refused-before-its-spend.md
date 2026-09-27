# ADR 0125 — A recorded walk is refused before its spend

- Status: accepted (P-16, cut D2, recorded 2026-09-27).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0124's stated limit on the post-spend refusals (the no-issuer transport,
  the undeclared checks, the empty write-set of a recorded walk), which this cut pays.

## Context

P-16/D1 (`d99be2b`, ADR 0124) made every recorded (V2) walk verify and audit before its
steps 6 and 7. It left three unlawful recorded tasks refused only **after** the provider
spend: an envelope with no declared checks (the runner's `RUNNER_CHECKS_UNDECLARED`), an
empty write-set (the runner's `RUNNER_WRITE_SET_EMPTY`; inline, the conformance gate's
`WRITE_SET_EMPTY`), and a writer transport with no writer id issuer (the runner's
`WRITER_ID_UNISSUED`). Decision 160 (D-S1-2) asked P-16 to decide the lawful `NO_COMMIT`
path, whether an empty write-set is lawful and where it is refused before any spend,
"sin valor por defecto". Decision 241 and the P-28 row gave the pre-spend refusals to
P-16/D2.

The brief (`p16-d2/brief-v1`, measured at `d99be2b`) was pre-reviewed by the DT
(`ACCEPT_WITH_CORRECTIONS`, no blocking correction). Its ND-1 to ND-11 were ruled and
adopted. The owner ordered delivery over iteration (2026-09-26): targeted checks, no full
`pnpm check`. Kimi and Fable are not used. An independent Claude verifier checks the
result.

## Decision

### An empty write-set is unlawful under both commit policies, until P-17 (ND-1 (b))

Decision 13 and contracts §12 define `NO_COMMIT` as "may edit inside the write-set". They
put `READ_ONLY` on a separate `workspace_mode` axis that P-17 adds. A `NO_COMMIT` task
that may edit nothing is `READ_ONLY` spelled on the wrong axis, and the P-16 row forbids
introducing that vocabulary here. Every recorded walk now verifies, and
`VerificationReceipt.declaredWriteSet` is `min(1)`, so a lawful empty write-set would
also need a receipt-grammar change. **The lawful `NO_COMMIT` path is a non-empty
write-set.** It walks `READ_ONLY_PLAN` from `AUDITING` to `CHECKPOINTED`, with no
`READY_TO_COMMIT` and no `COMMIT_*`. The auditor's `DIFF_PRESENT_FOR_COMMIT` is vacuous
there, so a writer that changed nothing is still `ACCEPT`. The drills prove this end to
end through the doors (P3).

The contract's comment "An empty write-set means a read-only packet" describes what the
schema can express. It does not describe what the plane admits, which is P-17's
`workspaceMode` to relax.

### The intake refuses it by name (decision 242)

`intakeTask` refuses a `NO_COMMIT` envelope with `writeSet: []` as `REQUEST_INVALID`
`WRITE_SET_EMPTY` at `envelope.writeSet`. The check sits in `preconditions`, after the
key's replay comparison and beside `ROLE_NOT_IN_ENVELOPE`, so nothing is published and
nothing is appended. `TASK_INTAKE_CODES` grows from 12 to 13, and the new word sorts
last. Both doors carry it: `acp intake` answers `WRITE_REFUSED` with the word, and
`POST /api/v1/tasks` answers 409 `WRITE_REFUSED`, detail `envelope.writeSet`. Under
`LOCAL_COMMIT_WITH_RECEIPT` the contract's own refinement refuses first, as 400
`ENVELOPE_INVALID` at `envelope.commitPolicy`, unchanged (ND-7). The intake still admits
an envelope with no check commands (NB-7): refusing that is the recorded walk's job, and
many fixtures that never walk rely on it.

### The recorded start refuses the three before any spend (decision 243)

Runtime's `recorded-task` gains a pure `recordedWalkRefusal(task, route)` beside the
reader (ND-2 (a)). The reader is unchanged. The function reads only the envelope and the
elected route. It answers `null` or the first of three closed words, in the runner's own
order (ND-3 (a); no `RUNNER_` prefix, because no runner ran):

1. `CHECKS_UNDECLARED` at `envelope.validation.commands`;
2. `WRITE_SET_EMPTY` at `envelope.writeSet`;
3. `WRITER_ID_UNISSUED` at `route`, from `writerIdIssuerFor([route])`, with the elected
   route as a one-segment attempt (ND-6 (a)). The issuer set is the commit
   authorization's own and is never restated. The word is imported from
   `@acp/contracts`.

`RECORDED_WALK_REFUSALS` is that sorted list, and `RUNTIME_PUBLIC_EXPORTS` grows from
314 to 317. The daemon's `recordedSubject` asks it once, right after `readRecordedTask`
succeeds and before it returns the subject. A refusal throws
`StartupError("the recorded walk is refused before any spend: <WORD> at <path>")`
(ND-11 (a)). This prefix differs from the reader's `the recorded task is refused:`, so a
reader of the log knows which gate spoke. Nothing is appended, leased, dispatched or
spent: no `RUN_STARTED`, `LEASE_ACQUIRED`, `EFFECT_INTENDED`, `DISPATCH_*`, `PROMPT_*`,
`USAGE_*` or `RESPONSE_*`. The task stays `DISCOVERED`, and its trail is byte-equal
before and after.

The `codex`/`CLI_SUBSCRIPTION` route never reaches the check at a real start, because
`usageSourceFor` refuses it first. The unit suite covers it.

The runner and the auditor keep their own checks (`RUNNER_CHECKS_UNDECLARED`,
`RUNNER_WRITE_SET_EMPTY`, `WRITER_ID_UNISSUED` over the recorded segments) as a backstop.
A lawful start no longer reaches them, but they still refuse by name if one is reached.
Only the runner's stale comment changed.

### The re-pins, and what they suspend (ND-5 (a), with its conditions)

- D1's drill N2 (no declared check) now fails at start with `CHECKS_UNDECLARED`: no spawn
  log, no receipt, `DISCOVERED`. N1 and N3 are unchanged.
- **D-F-4** (API_KEY, entered by `POST /tasks`) is folded with the API_KEY **401/429**
  case and the **N-E-21** transport-failure case into one parameterized pre-spend case
  (ND-5 condition 3). Each substitute answer is never asked: zero calls, zero strays,
  no spend type, `DISCOVERED`, and the canary sweep is kept.
- **D-F-5** (LOCAL, auth `CREDENTIAL` and `NONE`, entered by `acp intake`) is refused
  the same way. The real loopback socket is started and never receives a
  `POST /v1/chat/completions`.
- `CREDENTIAL_ENTRY_ABSENT` is unchanged. The credential resolves before the ledger
  opens, so a missing entry is still refused there first.

**This suspends the end-to-end evidence that ADR 0108 made P-15/E's acceptance
condition** ("E is not acceptable without those two rows", ADR 0107; ADR 0108 §Status).
The API_KEY Messages leaf and the LOCAL leaf over a real loopback socket are no longer
run through the recorded daemon and read back through both doors. What still proves
each piece:

- the leaves themselves: the providers' `api-key/http` and `local/http` suites (the
  latter over a real loopback), `execution-port` N-E-21, and `sse`;
- `AUTH_REQUIRED` pressure from a 401: the accounts and runtime pressure suites;
- reading a result back through both doors: the CLI recorded drills (P-15/D4, P-15/F).

**P-28 restores the chain** when it widens the issuers. The substitute, `eConfigFile`,
`fServer` and the loopback fixture stay in the suite and are used by the re-pinned cases,
so the restoration is a re-pin, not a rewrite. The two read-back helpers that only the
old assertions used, `eReadBack` and `eBlocksText`, were removed from the file and can
be recovered from history. The P-15 row and ADRs 0107 and 0108 are history and are not
edited.

### No bump (ND-8 (a))

No route, schema field or `API_ERROR_CODES` member changes. The intake refusal uses the
existing 409 `WRITE_REFUSED`/`REQUEST_INVALID` class with a new word. `API_CONTRACT_VERSION`
stays `0.25.0` and `CONTRACT_VERSION` stays `2.11.0`. There is no migration.

## Fence

One law, L-P16D2-1, "a recorded walk is refused before its spend" (ND-10 (a);
`PATH_SCOPED_LAWS` 185 → 186). It checks comments-stripped text:

- `RECORDED_WALK_REFUSALS` is declared once, and it holds exactly the three words, sorted;
- `function recordedWalkRefusal(` is defined once, its body calls `writerIdIssuerFor(`,
  and it spells neither `"CLI_SUBSCRIPTION"` nor `"CLAUDE_CLI_SESSION"`;
- the daemon's `composition/index.ts` calls it exactly once, inside `recordedSubject`,
  after `readRecordedTask(` and before the body's first `return {`;
- no other daemon `src` file calls it;
- the intake holds `refuse("REQUEST_INVALID", "WRITE_SET_EMPTY"` once, inside
  `preconditions`.

This law has the same stated limit as L-P27C-1: it matches text. The semantic guards are
the unit, door, `runDaemonChild` and drill cases. `P16D2_WRITE_SET` freezes the 22 paths
of the cut, one of them new: this record. The twenty-second is the runner suite, admitted
on a measured red: N5's empty-write-set fixture is re-planted because the intake now
refuses that task, which corrects the pre-review's measurement that it was already planted. The
re-plant rewrites the ledger with `node:sqlite`, so the daemon import law's fixture
exception widens from one named test file to two, `DAEMON_SQLITE_FIXTURE_FILES` (the bin
suite and the runner suite, by exact name, for the N5 empty-write-set plant); no daemon
source touches SQLite and the manifest is unchanged.

## Consequences

- A recorded task can no longer spend before being refused for a fact its envelope or
  its route already showed at the start.
- An API_KEY or local recorded walk cannot run at all until P-28. Inline walks and the
  scheduled form are unaffected.
- P-16's cut list is closed. Accepting the packet as a whole is a later, docs-only act
  (ND-9 (a)).

## Stated limits

- **`CHECKPOINTED` does not credit success. `COMPLETED` is P-21's** (contracts §12,
  repeated here as required of the P-16/D ADR).
- The inline (V1) form still refuses an empty write-set only after its spend, at its
  conformance gate (`WRITE_SET_EMPTY`, thrown as `OBSERVATION_FAILED`). It retires with
  the V1 form (P-21, ND-4 (a)).
- A switch landed mid-attempt onto a transport with no issuer still fails
  `WRITER_ID_UNISSUED` at the runner, after spend (P-28).
- The intake does not refuse an envelope with no check commands. Only the recorded start
  does (NB-7).
- A lawful empty write-set (`READ_ONLY`) waits for P-17's `workspaceMode`.

## Not in this record

- `workspaceMode` / `READ_ONLY`, and relaxing `WRITE_SET_EMPTY` (P-17).
- `commit_authorization_read_model`, the in-force predicate, and `authorizeCommit`
  taking `writerIdIssuerFor` (P-17/A). Git writer identity (P-17/B).
- Issuers beyond the Claude CLI, and restoring the API/local recorded result chain
  (P-28).
- The packet-level acceptance of P-16 (a later docs-only act).
