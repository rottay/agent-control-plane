# ADR 0127 — A read-only task declares no write-set and never commits

- Status: accepted (P-17, cut workspaceMode, recorded 2026-09-27).
- Supersedes: none.
- Superseded-by: none.
- Amends: decision 242's rule that an empty write-set is refused under both commit
  policies, which this cut relaxes for `READ_ONLY` only (the act ADR 0125 and decision 242
  left to P-17); and ADR 0125's stated limit "a lawful empty write-set (`READ_ONLY`) waits
  for P-17's `workspaceMode`", which it pays.

## Context

Decision 13 and contracts §2 name two orthogonal axes: `commit_policy` (`NO_COMMIT`,
`LOCAL_COMMIT_WITH_RECEIPT`) and `workspace_mode` (`READ_ONLY`,
`MUTABLE_WITHIN_WRITE_SET`). Contracts §2.1 says a `READ_ONLY` task "recorre el mismo
camino sin mutar el workspace; el plane sí registra su propio estado y sus checkpoints".
Contracts §12 said the envelope did not carry the axis yet, that P-17 would add it, and
that adding it moves `envelope_sha256` (the class of decision 48).

Until this cut the envelope held only the commit axis. P-16/D2 (ADR 0125, decision 242)
therefore made the empty write-set unlawful under both policies: a `NO_COMMIT` task that
may edit nothing is `READ_ONLY` spelled on the wrong axis. The intake, the recorded
walk's admission, the conformance gate and the runner all refuse `WRITE_SET_EMPTY`, and
`VerificationReceipt.declaredWriteSet` is `min(1)`. The P-17 row, ADR 0125 (:44, :173,
:177) and ADR 0126 (:284) leave `workspaceMode`/`READ_ONLY` and the relaxation to P-17,
as its own cut.

The brief (`p17-workspace-mode/brief-v1`, measured at `404546e`) was pre-reviewed by the
DT (`ACCEPT_WITH_CORRECTIONS`). B-1: seven daemon fixtures build envelopes by cast, so
the mode can be `undefined` at runtime, and every guard is spelled
`workspaceMode !== "READ_ONLY"`. B-2: the new parameter is optional and typed
`| undefined` at both daemon seams. ND-NUM and ND-1 to ND-14 were ruled (a) and adopted.
The numbers are taken from the real HEAD: this ADR and decisions 248–250. P-17/B, whose
draft reserved the same numbers, renumbers at its reopen. The owner ordered delivery over
iteration (2026-09-26): targeted checks, no full `pnpm check`. Kimi and Fable are not
used; an independent Claude verifier checks the result.

## Decision

### The axis (decision 248)

`@acp/contracts` exports `WorkspaceMode = z.enum(["MUTABLE_WITHIN_WRITE_SET",
"READ_ONLY"])`, sorted, exactly two members. `TaskEnvelope` gains
`workspaceMode: WorkspaceMode.default("MUTABLE_WITHIN_WRITE_SET")` (ND-1 (a)). The parsed
envelope always carries the field, so it is always in the preimage: an absent field and
an explicit `MUTABLE_WITHIN_WRITE_SET` are one parsed value and one `envelope_sha256`.

The contract couples the axes where the combination has no meaning. In `superRefine`,
before the existing commit-policy rule and in this order (ND-2 (a)):

1. `READ_ONLY` with a commit policy other than `NO_COMMIT` is an issue at
   `workspaceMode`;
2. `READ_ONLY` with a non-empty write-set is an issue at `writeSet`;
3. `LOCAL_COMMIT_WITH_RECEIPT` with an empty write-set stays an issue at `commitPolicy`.

`MUTABLE_WITHIN_WRITE_SET` with `NO_COMMIT` and an empty write-set still parses: refusing
it stays the intake's job. The comment on `writeSet` now says an empty write-set is
lawful only under `READ_ONLY`. The doors answer the existing `ENVELOPE_INVALID`, `400`
and `BAD_REQUEST` at those paths. No intake word is added, and `TASK_INTAKE_CODES` stays
13.

### The version moves for an identity (decision 248)

The preimage gains a field, so every envelope digest moves: ADR 0076's criterion.
`CONTRACT_VERSION` moves from `2.11.0` to `2.12.0`, and `SUPPORTED_CONTRACT_VERSIONS`
grows from ten members to eleven. `"2.11.0"` stays in the set for ever.
`AdmittedContractVersion` follows the literal, so `TaskEnvelope`, `WorkerSlot`,
`VerificationReceipt` and `CommitAuthorizationReceipt` admit only `2.12.0`. The ledger's
append door does too. No column holds the field and every SQL cohort list closes at or
before `2.9.0`, so no migration follows.

The three acts of ADR 0072 are re-proved on the task stream at `2.12.0`:

- act 1, at the task, initiative and registry doors: new work stamped `2.11.0` is refused
  naming both versions, and an exact replay of a stored `2.11.0` event returns its
  record;
- act 2: the stored envelope's version is the intake event's, the one in force;
- act 3: a `2.11.0` task history opens, reads, verifies, rebuilds row for row under
  `2.12.0` and takes new work.

A `2.11.0` task read back to be walked is `ENVELOPE_VERSION_SUPERSEDED` (decision 221; no
change to the reader).

`API_CONTRACT_VERSION` moves from `0.25.0` to `0.26.0`, on decision 222's reading: the
intake request embeds the envelope, so the request shape moves (ND-7 (a)). No route,
method, write route, private read or error code moves, and there are still 27 routes.
`LEDGER_CONTRACT_VERSION` follows `CONTRACT_VERSION` by derivation.

### The vectors are re-sealed by their recorded methods (decision 248; decision 224)

- The three `envelope-identity` vectors were recomputed twice, from a copy of the fixture
  outside the suite: by `envelopeSha256`, and by `node:crypto` over an independently
  key-sorted JSON of `TaskEnvelope.parse`. The two agree on all three. Their subjects did
  not move: the fixture states the default, and a new case proves the absent field
  digests the same. `ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1` did not move.
- `D4_V1_TRAIL_SHA256` was re-sealed by its docblock's method (ND-14 (a)):
  1. `git archive be3b06f` into the scratchpad, with the drill as `c1bb414` wrote it.
  2. A control run reproduced `f61ca58b…ed93`.
  3. An edited run applied A1's contract edits and this cut's there, with the drill's
     envelope literals without `objective`. It gave `d971f660…c970`.
  4. The current tree gives the same value.

  The scratch archive was deleted after the run.

### The relaxation (decision 249)

An empty write-set is lawful only under `READ_ONLY`. Each of the four refusal sites
guards its refusal with `workspaceMode !== "READ_ONLY"` (B-1). A missing or `undefined`
mode keeps today's strict rule. The four sites:

- **Intake** (`preconditions`): `REQUEST_INVALID` `WRITE_SET_EMPTY` at
  `envelope.writeSet`. A `READ_ONLY` `NO_COMMIT` envelope with an empty write-set enters
  `DISCOVERED`, revision 1, with one publication. L-P16D2-1's refusal text and place do
  not move.
- **Recorded walk's admission** (`recordedWalkRefusal`): `WRITE_SET_EMPTY`.
  `RECORDED_WALK_REFUSALS` stays the three words, in the same order: checks, then
  write-set, then issuer. A `READ_ONLY` task still needs a declared check and a writer id
  issuer.
- **Conformance gate** (`checkWriteSetConformance`): `ConformanceRequest` gains an
  optional `workspaceMode?: WorkspaceMode | undefined` (ND-4 (a), B-2). The mode is
  validated before the declared set:
  1. a defined value outside the vocabulary is `REQUEST_INVALID` at
     `request.workspaceMode`;
  2. `READ_ONLY` with a declared path is the same;
  3. any mode other than `READ_ONLY` with an empty set is `WRITE_SET_EMPTY`;
  4. `READ_ONLY` with the empty set proceeds, and the existing comparison makes every
     observed tracked or untracked path a violation: revoke, `SUSPECT_WORKTREE`, and
     nothing else.

  `ENFORCEMENT_REFUSALS` stays 14.
- **Runner** (`runVerification`, step 3): `RUNNER_WRITE_SET_EMPTY`. A `READ_ONLY` run
  verifies over `declaredWriteSet: []`. Any change observed at step 5 is
  `RUNNER_WRITE_SET_VIOLATION`, and a change between the two observations is `FAIL`.
  `RUNNER_REFUSALS` stays 19.

The daemon reads the mode and never states it. Both `conformanceGateFor` sites pass it
from the walked envelope: `workspaceMode: walked.envelope.workspaceMode,` and
`workspaceMode: walk.envelope.workspaceMode,`. `conformanceGateFor` takes it as an
optional input and forwards `workspaceMode: input.workspaceMode` into
`checkWriteSetConformance` (B-2). Plan selection does not change. `READ_ONLY` implies
`NO_COMMIT`, which selects `READ_ONLY_PLAN` at both walk sites (L-P16D1-3). The walk ends
`AUDITING` → `CHECKPOINTED`, never `COMPLETED` (ND-12 (a)).

**The receipt** (ND-3 (a)). `VerificationReceipt.declaredWriteSet` is `min(0)`. Its
existing refinements then admit no observed change under the empty set, so the receipt
itself says the worktree ended byte-identical. `CommitAuthorizationReceipt` adds a
refinement at `declaredWriteSet`: a commit is authorized only over a non-empty declared
write-set. The receipt identity, SQL and migrations are unchanged. The policy digest
keeps its three members (ND-5 (a)): the mode is carried by the envelope and by the
receipt's empty set. Over an empty set with no observation, the auditor's
`CHANGES_WITHIN_WRITE_SET` evaluates to `PASS`.

**Never an authorization.** A `READ_ONLY` task is never authorized to commit:

- the contract refuses `READ_ONLY` with `LOCAL_COMMIT_WITH_RECEIPT`;
- `authorizeCommit` on a `READ_ONLY`, and therefore `NO_COMMIT`, envelope answers the
  existing `COMMIT_POLICY_NO_COMMIT` at `request.envelope.commitPolicy`, and a
  `READ_ONLY`+`LOCAL` literal is `REQUEST_INVALID` at `request.envelope.workspaceMode`
  (the recorded-task suite, ND-9 (a));
- the ledger door's `AUTHORIZATION_NO_COMMIT` covers the record form.

`runtime/src/commit-authorization` is not edited.

**Through the real doors** (A13): `acp intake` of a `READ_ONLY`/`NO_COMMIT`/empty
envelope, then the packaged recorded daemon start with a fake Claude and zero spend.

- **A writer that changes nothing:** the task ends `CHECKPOINTED` with one `PASS`
  receipt whose declared set, tracked changes and untracked paths are all empty. The
  verdict is `ACCEPT`, there is no `READY_TO_COMMIT` and no `COMMIT_*`, and the integrity
  walk is clean.
- **A worktree that holds a change:** the start rejects with
  `WRITE_SET_VIOLATION_DETECTED`. `LEASE_REVOKED` and `SUSPECT_WORKTREE` are recorded,
  and there is no receipt and no `COMMIT_*`.

## Why a required field was not chosen

Without a default, every envelope literal in about 27 suites would have to state the
field. That includes `runtime/test/commit-authorization` and
`ledger/test/commit-authorization-record`, both in P-17/B's uncommitted draft, so this cut
could not land without touching B's files. `.optional()` was rejected too: two spellings
of one mode would hash apart (ND-1).

## Why a new intake word was not chosen

A `WRITE_SET_NOT_EMPTY` intake word would state, in a second place, a rule the contract
states once, and move `TASK_INTAKE_CODES` from 13 to 14 (ND-2 (b)).

## Why verification was not skipped for READ_ONLY

Keeping `min(1)` and skipping the verification for `READ_ONLY` contradicts contracts
§2.1: "recorre el mismo camino". The empty declared set, with no observed change, is
exactly the read-only claim, and the receipt now states it (ND-3 (b)).

## Consequences

- A lawful read-only task exists end to end: `READ_ONLY` + `NO_COMMIT` + no write-set
  enters by both doors, walks `READ_ONLY_PLAN`, verifies, audits and checkpoints.
- **The identity bump's declared cost.** Every envelope recorded under `2.11.0` has a
  different digest from the same work issued now. A `2.11.0` task read back to be walked
  is `ENVELOPE_VERSION_SUPERSEDED` and must be re-submitted. A receipt or envelope
  recorded under `2.11.0` no longer parses at the authorization door
  (`RECEIPT_UNREADABLE`, `ENVELOPE_UNREADABLE`). Only local test ledgers hold such rows;
  nothing operational does.
- The D2 limits this cut closes are named in ADRs 0109, 0117, 0118, 0120, 0125 and 0126.
  Those ADRs are history and are not edited.
- The re-sealed values are the three envelope-identity vectors, and `D4_V1_TRAIL_SHA256`
  moving from `96593135…89e5` to `d971f660…c970`. The bin suite's E5 and E4 titles, which
  named `2.11.0` as the version in force, now say "the version in force". The plant
  itself needed no change: it starts from the stored parsed bytes, which already carry
  the field.
- P-17/B rebases its draft on this cut and renumbers at its reopen (ADR 0128, decisions
  from its HEAD).

## Fence

Two laws; `PATH_SCOPED_LAWS` moves from 188 to 190 (ND-10 (a)).

**L-P17WM-1, "an empty write-set is lawful only under READ_ONLY".** It checks:

- `task-envelope/index.ts` declares `export const WorkspaceMode = z.enum([` once, with
  exactly the two members, sorted;
- the strict object holds `workspaceMode: WorkspaceMode` once;
- the `superRefine` body couples `"READ_ONLY"` to `commitPolicy` and to
  `writeSet.length`;
- each of the four refusals occurs once, inside its function, and its nearest guarding
  `if (` condition holds `workspaceMode !== "READ_ONLY"`, with whitespace collapsed;
- no other `packages/*/*/src` file declares a `z.enum(` holding `"READ_ONLY"`.

**L-P17WM-2, "the workspace mode is read, never stated"** (L-P16D1-3's mould). It checks:

- no daemon `src` file states `workspaceMode:` with a string literal;
- the composition root passes both walked-envelope reads once each;
- ports forwards `workspaceMode: input.workspaceMode` into `checkWriteSetConformance({`.

`CONTRACTS_SCHEMA_EXPORTS` moves from 191 to 192 (`WorkspaceMode`). `P17WM_WRITE_SET`
freezes the cut's 41 paths, one of them new: this record. Both laws have L-P27C-1's
stated limit: they match text. The semantic guards are the contracts, runtime, runner,
door and drill suites.

## Stated limits

- **The read-only guarantee is post hoc (ND-8 (a)).** A `READ_ONLY` writer's session
  keeps its role's tools. A write is caught by the conformance gate and the runner, which
  quarantine it with no receipt and no commit, but the tools do not prevent it.
  Tool-level read-only enforcement is **P-25**'s sandbox mechanism and, for the duel's
  "tools read-only comprobadas", **P-35 / H-8**'s.
- **`CHECKPOINTED` does not credit success.** `COMPLETED` is P-21's (contracts §12).
- A `READ_ONLY` walk needs a writer id issuer, like any recorded walk. Only the Claude CLI
  has one until P-28 widens the set.
- No read model or event payload carries the mode (ND-6 (a)). Readers take it from the
  recorded envelope.

## Not in this record

- The Git writer, `update-ref`, the committer identity and the production caller of
  `authorizeCommit` (P-17/B).
- Execution §10.4, `COMMIT_RECORDED`, `OUTCOME_UNKNOWN` and its reconciliation (P-17/C).
- `COMPLETED` and the inline V1 form's retirement (P-21).
- Wider writer id issuers (P-28). Tool-level read-only (P-25, P-35/H-8).
- The requirement and quality rows and the packet-acceptance reading, which live in files
  owned elsewhere (P-16/M and those files' owners).
