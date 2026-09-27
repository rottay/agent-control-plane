# ADR 0126 — A commit authorization is recorded and revalidated

- Status: accepted (P-17, cut A, recorded 2026-09-27).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0121's stated limit that `authorizeCommit` takes its writer id issuer and its
  policy digest from its caller, which this cut pays; and the "§10.4–§10.5 (P-17/A)"
  wording of decisions 241 and 244, which decision 245 re-routes (§10.4 is P-17/C's).

## Context

P-16 left the commit authorization as a pure function nobody called and whose result
nothing recorded. Execution §10.5 (P-16/0, decisions 225–227) fixed the table, the
closed transitions, the in-force predicate and the gate's preconditions before any code.
P-16/B (ADR 0122) recorded the receipt and the verdict, P-16/C (ADR 0123) gave the policy
digest one producer and the writer id issuer one producer, and P-16/D1 (ADR 0124) made a
recorded walk produce both rows. The P-17 row assigns to P-17/A the table, the in-force
predicate, the last-receipt precondition, `authorizeCommit` on `writerIdIssuerFor` and the
recorded envelope, and decision 231's N-3 re-check under the lock.

The brief (`p17-a/brief-v1`, measured at `d4d996e`) was pre-reviewed by the DT
(`ACCEPT_WITH_CORRECTIONS`: B-1 thirteen columns and six keys, B-2 the reference row type
in the write-set, B-3 no trailer literal in the runtime, B-4 a runtime word for
`NO_COMMIT`). ND-Q1 and ND-1 to ND-17 were ruled and adopted. P-17/A opens on the seven
P-16 cut receipts; P-16's packet acceptance stays a later docs-only act (ND-Q1 (a)). The
owner ordered delivery over iteration (2026-09-26): targeted checks, no full `pnpm check`.
Kimi and Fable are not used; an independent Claude verifier checks the result.

## Decision

### Migration 29: the table, as §10.5 wrote it (decision 245)

`commit_authorization_read_model` is `STRICT`, with no defaults and thirteen columns:
`task_id`, `receipt_sha256` (the composite key), `revision_number`, `attempt_number`,
`audit_id`, `commit_message_sha256`, `authorized_at`, `authorized_sequence`, `state`,
`commit_sha` and `superseded_by_receipt_sha256` (the only two nullable ones),
`recorded_at` and `sequence`. It has four `DEFERRABLE INITIALLY DEFERRED` keys (the
receipt, the superseding receipt, the verdict and the attempt) and two immediate keys into
the stream (the authorizing event, and the event of the last transition). Every CHECK is
named. The three state CHECKs are §10.5's, spelled in both directions so a `NULL`
satisfies neither. The two instants carry §10.1's GLOB. It also has the attempt index, the
partial unique index `ux_…__intended_task` (at most one `INTENDED` row per task), and one
`BEFORE UPDATE` trigger (ND-9 (a)). The trigger aborts unless `(OLD.state, NEW.state)` is
one of the five listed pairs and the eight immutable columns compare `IS` equal. The
predicate is `COALESCE`d, so a `NULL` cannot make it vacuous. The watermark is born at the
task head, migration 28's mould. Nothing is backfilled (ND-17).

### The record form, same-state in `AUDITING` (ND-2, ND-3)

A V2-subject `COMMIT_AUTHORIZED` is admitted only in record form: exactly the coordinate
and `commitAuthorization: {receiptSha256, auditId, commitMessageSha256}`, closed at every
level, lowercase hex, and the verdict event's own id. Without the key it is
`AUTHORIZATION_RECORD_ABSENT`. The key on a V1 subject, or a missing, extra or mistyped
member, is `AUTHORIZATION_RECORD_INVALID`. The key under another type is
`AUTHORIZATION_FORM_MISPLACED`, and so is a state change (`toState`) or any origin state
other than `AUDITING` (`fromState`). The P7C pilot's bare V1 candidate
`{taskId, receiptSha256, authorizedBy}` is admitted byte-unchanged and projects nothing
(owner P-21). No walk emits the record form in this cut (ND-14 (a)), and step 8 is
unchanged.

### One decision, door and fold (decisions 56 and 245)

`decideCommitAuthorizationRecord` (ledger `commit-authorization-record`) is pure over the
event and a view. The door answers the view from the tables and the stream its
`BEGIN IMMEDIATE` keeps level. The fold answers it from the snapshot. Both reach the same
word. The order is: the grammar; the instant (`RECORDED_AT_NOT_CANONICAL`); the policy the
intake recorded (`AUTHORIZATION_NO_COMMIT` for `NO_COMMIT`, `AUTHORIZATION_POLICY_UNRECORDED`
for a task that entered without one); the receipt row (`RECEIPT_UNRECORDED`,
`RECEIPT_COORDINATE_MISMATCH`, `RECEIPT_NOT_PASS`); the verdict row (`VERDICT_UNRECORDED`,
`VERDICT_RECEIPT_MISMATCH`, `VERDICT_NOT_ACCEPT`, so `ACCEPT_WITH_CORRECTIONS` does not
authorize); and the last receipt (`RECEIPT_NOT_LAST`). Next comes the key already held: a
replay with the same metadata keeps its first `INTENDED` row, and other metadata is
`AUTHORIZATION_METADATA_CONFLICT`. Another row of the task `INTENDED` or `OUTCOME_UNKNOWN`
is `AUTHORIZATION_STATE_INVALID` (execution `:851-853`; ND-8 (a)). Last is the in-force
predicate over the candidate row. The grant is `#assertCommitAuthorizationGranted`, called
once in `#appendOneInTransaction` after the verification grant and before the event
insert. The row is born `INTENDED`, with `authorized_at = recorded_at` and
`authorized_sequence = sequence` taken from the event.

**The last receipt (ND-5 (a)).** It is the task's receipt-form row with the greatest
`sequence`. Read literally, "no later `VERIFICATION_COMPLETED`" would refuse every
authorization, because D1's step-6 consumer beat always follows its receipt. A consumer
beat names an existing receipt and never makes an older one last again.

### One in-force predicate (ND-6, ND-7)

`commitAuthorizationInForce` is §10.5's "Vigencia", exported for P-17/B and C. It refuses:

- a row that is not `INTENDED` (`AUTHORIZATION_STATE_INVALID`);
- a lease that does not exist (`LEASE_ABSENT`), before any comparison;
- a lease instant that is not canonical (`LEASE_INSTANT_NOT_CANONICAL`; never normalized);
- a lease held by anyone but the receipt's writer (`LEASE_HOLDER_MISMATCH`);
- `authorized_at` not strictly before the expiry by epoch, where equality counts as
  expired (`LEASE_EXPIRED`);
- any revalidated equality it is given that does not hold (condition 3; an absent member
  is not judged).

The canon calls it at `COMMIT_RECORDED` and at `OUTCOME_UNKNOWN → INTENDED` (execution
`:855-857`). In this cut the decision calls it over the **candidate** `INTENDED` row, so
the gate's own precondition, "lease vivo", is this same function. P-17/C adds the
canonical call at `COMMIT_RECORDED`. P-17/B and C extend condition 3 with base and tree
against Git through `revalidated`, so they extend the call and not the function.

**The lease is the recorded one (ND-6 (a)).** It is the task stream's own `LEASE_ACQUIRED`
and `LEASE_REVOKED` whose payload coordinate is the receipt's, folded by runtime
`enforcement`'s rule. Per `leaseId`, the last acquisition in ledger order counts. A
revocation is terminal. The attempt's lease is the last one acquired. The coordination
store is a separate file that no ledger transaction holds and no rebuild could re-read,
so the recorded lease is what makes the predicate "reproducible en replay". The holder is
checked against the receipt's `writer_identity`. On the live wiring both are the walk
label (`walk.spec.emittedBy`). The runner's and the auditor's "holding" windows are
artifact holdings, not worktree leases. The worktree path is not compared, because the
envelope carries none.

### The door's bytes, and the fold's copy (ND-7 (a), ND-10 (a))

Byte-derived facts are the door's alone. `readCommitAuthorizationArtifacts` reads two
artifacts by reference before the lock, as values: the receipt, by the receipt row's
reference, and the envelope, by the revision row's `TASK_ENVELOPE` reference.
`assertCommitAuthorizationArtifacts` judges them inside the transaction:

- **The references.** Each is re-asserted under the lock: class, scope `TASK` and the task,
  pinned digest (`RECEIPT_REFERENCE_INVALID`, `ENVELOPE_REFERENCE_INVALID`).
- **The receipt.** Its bytes must parse and name the row (`RECEIPT_UNREADABLE`).
- **The commit message.** Its digest is recomputed over the receipt's body and its one
  trailer with `commitMessageWithReceiptTrailer`, the trailer's one home
  (`COMMIT_MESSAGE_DIGEST_MISMATCH`).
- **The envelope.** It must be this task's envelope (`ENVELOPE_UNREADABLE`) and be
  `LOCAL_COMMIT_WITH_RECEIPT` (`AUTHORIZATION_NO_COMMIT` at `envelope.commitPolicy`).
- **The policy digest.** `verificationPolicySha256` is recomputed over the envelope's
  three members exactly as the runner computes it; its `LedgerValidationError` is
  `ENVELOPE_UNREADABLE`. It must equal the receipt row's `policy_sha256`
  (`POLICY_DIGEST_MISMATCH`).
- **The write-set.** The envelope's write-set, as a set, must be the receipt's declared
  one (`WRITE_SET_MISMATCH`).

The fold and `verifyIntegrity()` copy what the door admitted and never reopen a blob.
`verifyIntegrity()` compares the table row by row and reports a refused record by
sequence. `rebuildReadModel()` throws it.

**Decision 231's N-3 re-check runs under the lock.** It covers every reference the task
door read before its lock: B's and D1's receipt and evidence, and A's receipt and
envelope. The reference row read inside the transaction now carries `tombstoned_at` and
`expires_at` (`VerificationReferenceRow` gains both). A tombstoned reference is refused
by the reference's existing word. So is one whose `expires_at` is at or before the
event's `recordedAt`, compared by epoch and never as text, at
`…tombstonedAt` / `…expiresAt`. The ledger reads no clock. `VERIFICATION_REFUSALS` stays
at twenty-seven.

### Supersession (ND-4 (a))

A later receipt-form `VERIFICATION_COMPLETED` of the task, in any revision or attempt,
moves the task's `INTENDED` row to `SUPERSEDED`. The row then names the new receipt and
takes that event's `recorded_at` and `sequence`, in the same transaction, in door and
fold; `authorized_*` never move. `#transitionCommitAuthorization` is the table's one
`UPDATE`, and it sets only the state columns. Consumer beats and V1 beats never
supersede.

### `authorizeCommit` reads what it once took (decision 246; ND-11 (a), B-3, B-4)

- **The request's keys.** They lose `writerIdIssuer`, `policySha256` and
  `declaredWriteSet`. They gain `routeSegments` (the attempt's recorded segments) and
  `envelope` (the recorded envelope). A caller that still names a removed key is
  `REQUEST_INVALID` at it.
- **The envelope.** It is parsed right after the key set. A `NO_COMMIT` envelope is
  `COMMIT_POLICY_NO_COMMIT` at `request.envelope.commitPolicy`, before independence, and
  an envelope of another task is `REQUEST_INVALID` at `request.envelope.taskId`.
- **The issuer.** It is `writerIdIssuerFor(request.routeSegments)`: `WRITER_ID_UNISSUED`
  at `request.routeSegments`.
- **The write-set and the policy.** The declared write-set is the envelope's. The policy
  digest is `verificationPolicySha256` of its three members.
- **The four body words.** They are named immediately before the receipt parse:
  - an empty body is `COMMIT_MESSAGE_BODY_EMPTY`;
  - a trailing `\n` is `COMMIT_MESSAGE_BODY_ENDS_IN_LF`;
  - a `\r` is `COMMIT_MESSAGE_BODY_HOLDS_CR`;
  - `COMMIT_MESSAGE_BODY_HOLDS_TRAILER` applies when the body is within the contract's
    2000 characters and the receipt's own `commitMessageBody` schema still refuses it,
    since the trailer line is then the only rule left.

  The runtime never spells the trailer's key (L-P16A2-1). An over-long body still falls
  through to `RECEIPT_INVALID`.

`AUTHORIZATION_REFUSALS` goes 14 → **19**. `RUNTIME_PUBLIC_EXPORTS` does not move: the
request type is reshaped and no name is added. The P7C pilot's five calls move to the
segments and its admitted envelope.

### No bump (ND-12 (a))

The new form is discriminated by a key on an existing type. The fold copies
`commit_message_sha256` and never reopens bytes. The trailer's bytes and the policy
preimage carry their own versions. `CONTRACT_VERSION` stays 2.11.0 and
`API_CONTRACT_VERSION` 0.25.0: no route, no verb and no schema move.
`CONTRACTS_SCHEMA_EXPORTS` stays 191.

## Restamp (decision 203's format)

| Pin | Before | After |
| --- | --- | --- |
| `MIGRATIONS` | 28 | 29 |
| `DERIVED_TABLES` | 37 | 38 (the new table before P-16/B's pair) |
| `PROJECTION_NAMES` (task) | 18 | 19 |
| `PROJECTION_SOURCES` | 34 | 35 |
| `EXPECTED_SCHEMA_OBJECTS` | 138 | 142 (table, `ix_…__attempt`, `ux_…__intended_task`, `tr_…__transition`) |
| `tr_` objects | 19 | 20 |
| `status().projections` / watermark rows | 33 / 34 | 34 / 35 |
| last applied migration | 28 (`VERIFICATION_AUDIT_MIGRATION`) | 29 (`COMMIT_AUTHORIZATION_MIGRATION`) |
| `AUTHORIZATION_REFUSALS` (runtime) | 14 | 19 |
| `COMMIT_AUTHORIZATION_REFUSALS` (ledger) | — | 26 |
| `PATH_SCOPED_LAWS` | 186 | 188 |
| L-P15I-1 `INSTANT_GLOB_COUNT` | 2 | 4 |
| L-P15F-1 (ii) `readByReference(` callers | 4 | 5 |
| ADR corpus | 125 | 126 |

Every pin was recalculated and never lifted. The rewind fixtures of the ledger, CLI and
gateway suites drop migration 29's objects first.

## Fence

- **L-P17A-1**, "an authorization row has one door, and changes only by a listed
  transition" (L-P16B-1's mould). Every write naming `commit_authorization_read_model` in
  `packages/*/*/src` is in `ledger/src/ledger/index.ts`. The table has one `INSERT`, with
  no conflict clause, inside `#insertCommitAuthorization`. It has one `UPDATE`, inside
  `#transitionCommitAuthorization`, whose `SET` names exactly `state`, `commit_sha`,
  `superseded_by_receipt_sha256`, `recorded_at` and `sequence`. No `DELETE FROM` names it.
  `this.#assertCommitAuthorizationGranted(` is called once, in `#appendOneInTransaction`,
  before its `INSERT INTO control_plane_events`.
- **L-P17A-2**, "one in-force predicate, one vocabulary, and the issuer and the policy
  are read, never supplied":
  - `commitAuthorizationInForce` is declared once, in the module, and called only there;
  - `COMMIT_AUTHORIZATION_REFUSALS` is declared there only, sorted and without repeats;
  - the module calls `commitMessageWithReceiptTrailer(` and `verificationPolicySha256(`;
  - the runtime's `authorizeCommit` calls `writerIdIssuerFor(` and
    `verificationPolicySha256(`;
  - its `REQUEST_KEYS` names none of `"writerIdIssuer"`, `"policySha256"`,
    `"declaredWriteSet"`;
  - its body never reads `request.policySha256`;
  - `AUTHORIZATION_REFUSALS` holds the four body words and `COMMIT_POLICY_NO_COMMIT`.
- **Amended**, each in its own row:
  - L-P15I-1 admits the §10.1 GLOB four times in the migrations file, one per instant
    column of migrations 28 and 29;
  - L-P15F-1 (ii) admits a fifth `readByReference(` caller, the authorization reader, a
    re-derivation and not a sink.
- **Re-bitten unchanged:** L-P16B-1, which governs only the two P-16/B tables; L-P16B-2;
  L-P16A2-1, where an `ACP-Receipt:` literal in runtime `src` is red; and L-P16D2-1.
- **The write-set.** `P17A_WRITE_SET` freezes the 32 paths of the cut, 4 of them new.
- **Limits.** Both new laws are textual (L-P27C-1's limits). The semantic guards are
  migration 29's trigger, CHECKs and partial unique index, `verifyIntegrity()`, and the
  door and fold negatives of `test/commit-authorization-record`.

## Consequences

- A commit authorization is a recorded fact with one door, revalidated from bytes at the
  door and reproduced by the fold, instead of a value a pure function returned.
- A second receipt of the task retires the prior authorization in the same transaction,
  so the partial unique index never blocks the current receipt.
- `authorizeCommit` can no longer be told which issuer, policy or write-set applies.

## Stated limits

- **`CHECKPOINTED` does not credit success. `COMPLETED` is P-21's** (contracts §12).
- No production caller records the form yet (ND-14 (a)). The runner's receipt body is
  `envelope.title` and `authorizeCommit`'s is a request key. Aligning the two belongs to
  P-17/B's production caller.
- A record-form event planted before migration 29 is judged by the fold on its own terms.
  A row is byte-verified only if its event was admitted at 29 or later (ADR 0122's N-1
  limit, restated).
- The lease is the recorded one. A lease revoked in coordination but not yet recorded is
  still live to the predicate. The effect's own fence-token check is P-17/B's, and so is
  the open question of whether a lapsed but unreassigned lease still holds a valid token.
- Git's `whitespace` cleanup and a NUL in a body are not among §10.5's four words. The
  runtime still grants those bodies, and they fail closed at reconciliation. The writer
  that meets Git is P-17/B, not this cut.
- Base and tree against the repository, and NB-2 (the tree's diff against the base tree
  within the write-set), need a Git read and are P-17/B's and P-17/C's.

## Not in this record

- `commit_read_model` (§10.4), `COMMIT_RECORDED`, `INTENDED → RECORDED`, the four
  revalidation equalities at commit time, `OUTCOME_UNKNOWN` and its reconciliation,
  `VERIFICATION_COMPLETED` refused while a row is `OUTCOME_UNKNOWN`, `cat-file`, and
  step 9 as a consumer beat (P-17/C).
- The Git writer, `update-ref`, the committer identity, `authorized_at` as the Git
  dates, and the fence-token question (P-17/B).
- `workspaceMode` / `READ_ONLY`, and relaxing `WRITE_SET_EMPTY` (P-17, its own cut).
- Revoking an authorization, and issuers beyond the Claude CLI (P-28).
- P-16's packet acceptance (a later docs-only act; decision 247).
