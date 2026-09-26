# ADR 0121 — A receipt is named by its content, and the plane names its writer

- Status: accepted (P-16, cut A2, recorded 2026-09-26).
- Supersedes: none.
- Superseded-by: none.

## Context

P-16/0 (`505562f`, decisions 225–227) put execution §10.2–§10.5 and contracts §12
under contract before any code. The receipt a verification produces is named by its
content: `receipt_sha256`, the effective key of `verification_read_model`, over a
versioned prefix and the canonical JSON of thirteen named members. The canon states
that only the ledger's `receipt-identity` computes it. It also says the plane, not a
worker, fills the writer's and the verifier's instance ids. It removes the
initial-commit receipt (D-9): a receipt's base is never null. And it adds the one
trailer `ACP-Receipt: <receipt_sha256>` to the commit message's body at authorization.

The code still carried the V1 receipt (P8-T G6). `baseHead` could be null for a
bootstrap claim, `commitMessage` was the whole message, `writer` and `verifier` were
bare labels, a `receiptId` was the caller's uuid, and nothing computed a digest.
Execution §10.2 also named one question and left it open for this cut: the writer id
is `claudeSessionId`'s v5 derivation over `(taskId, attempt)`, "elevada a contracts",
and it lacks a revision coordinate.

The brief (`p16-a2/brief-v1`, measured at `505562f`) was pre-reviewed by the DT
(`ACCEPT_WITH_CORRECTIONS`, four blocking corrections B-1 to B-4). Its ND-1 to ND-14
recommendations were adopted as rulings, some amended by the corrections. Kimi and
Fable are not used (owner, 2026-09-26). Independent Claude verifiers check the result.

## Decision

### One — two schemas, one set of bytes (decision 228; ND-6)

`@acp/contracts`' `commit-authorization` declares `VerificationReceipt`: the bytes of a
§10.2 row, `PASS` or `FAIL`. `CommitAuthorizationReceipt` is that same object with one
more refine, `runStatus === "PASS"`. So a value the authorization admits always parses
as a verification receipt and digests the same. AGENTS law 3 is read literally: a
`CommitAuthorizationReceipt` whose run did not pass, or any of whose checks exited
nonzero, is not a value. The name `CommitAuthorizationReceipt` stays (D-3), so
`docs/ROADMAP.md`, `AGENTS.md` and `CLAUDE.md` are byte-identical.

The write-set conformance refine stays on `VerificationReceipt`. A run that observed a
change outside its declared set is a quarantine (P6A/P6C), never a receipt, `FAIL`
included. **This is the limit P-16/C inherits:** its runner does not emit a `FAIL`
receipt for a conformance failure; it quarantines.

### Two — the v2 shape (decision 228)

- `baseSha` is `GitCommitSha` and NOT NULL. There is no initial-commit receipt (D-9),
  because that was the one path on which "first parent = base" could not be checked.
- `treeSha` (`GitCommitSha`) and `objectFormat: z.literal("sha1")` join. The named
  refusal `OBJECT_FORMAT_UNSUPPORTED` stays at P-16/C's runner; SHA-256 is P-38's.
- `policySha256` (`Sha256Hex`) is supplied; its producer is P-16/C.
- The writer is `{identity, workerId}` and the verifier `{identity, workerId, runId}`,
  with `runId` an integer ≥ 1. Both `workerId`s go through one module-private schema:
  `z.uuid({version: "v5"})` **plus a lowercase-canonical refine**. zod 4.1.13's
  versioned UUID grammar is case-insensitive. Without the refine, an uppercase copy of
  the writer's id would pass both the shape and the `!==` independence check while
  naming the same instance, and it would give one receipt two digests (B-3).
  Independence is refused by label **and** by instance, so renaming the role does not
  pass.
- `runStatus ∈ {PASS, FAIL}`. `PASS` with a nonzero check is the one forbidden cell.
  `FAIL` with every check zero is lawful.
- A check's `exitCode` is an integer in `[0, 255]` and is never `-0`. `-0` passes
  `min(0)` and `!== 0`, but canonical JSON refuses it, so without the refine a receipt
  could parse and still have no `receipt_sha256`. The other numbers of the preimage
  are `min(1)`, which already refuses `-0`. `authorizeCommit` meets it as
  `RECEIPT_INVALID` at `receipt.checks.<i>.exitCode` and never throws.
- Every instant is `CanonicalInstant`, refused and never normalized (C-M4).
- `declaredWriteSet` refuses a duplicate (a new refine).
- `commitMessageBody` replaces `commitMessage`. The body rules sit **on the field's
  schema**, not on the object's `superRefine`. Emptiness is the field's minimum. The
  schema also refuses a body that ends in `\n`, one that holds `\r`, and one with a line
  that begins `ACP-Receipt:`. The named words for these refusals are P-17/A's.
- `pushAuthorized: false` stays.
- `receiptId`, `authorizedBy`, `authorizedAt`, `worktreePath`, `branch`, `baseHead`,
  `attempt` and `commitMessage` leave (ND-7). The identity is the digest. The others are
  facts of the authorization and the lease: two receipts with one digest would otherwise
  differ, which P-16/B's fold calls corruption, and a re-authorization could not reuse
  its receipt.

### Three — the identity, in the ledger (decision 228; ND-7, ND-8)

`@acp/ledger` gains `receipt-identity`:

    receiptSha256(value) = sha256Hex("acp/receipt-identity/v1\n" + canonicalJsonStringify(preimage))

`value` is `unknown` and is parsed by `VerificationReceipt` first (ADR 0066's shape).
The preimage holds exactly the canon's thirteen members. Two of them are digests the
module derives, and the receipt never carries them, so a carried digest that disagrees
with its list cannot exist:

- `checksSha256` over the checks **in execution order**, under
  `acp/receipt-checks/v1\n`. The order is evidence.
- `writeSetSha256` over the declared write-set **sorted** with `[...paths].sort()`, the
  default UTF-16 code-unit comparator (the `roadmap-steps` precedent), under
  `acp/receipt-write-set/v1\n`. A set has no order. A vector pins a case where
  code-unit order and a locale's order differ.

Each prefix ends in its one LF, and there is no separator after it. **The three
prefixes are the ledger's own.** They encode a digest this package computes, as
`ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1` and the usage-settlement prefixes do, and no
contract declares them. The contracts-declared prefix precedent (the envelope and the
outbox command id) is not the precedent here. The barrel exports
`RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1`, `receiptIdentityPreimageV1`, `receiptSha256` and
`writerWorkerIdFor`. The two sub-prefixes stay in the module.

**Stated limit:** the observed lists and `contractVersion` are outside the preimage.
The same digest over different observations is P-16/B's fold-level refusal.

The vectors (`PASS` `13f80972…22e3`, `FAIL` `6f80ac84…70e5`) were computed outside the
package by Python's `hashlib` over preimages written out by hand. The ledger suite
recomputes them with its own `node:crypto`. The two vectors differ only in `runStatus`
and the checks.

### Four — the trailer, in contracts (decision 228; B-2, ND-9)

The trailer is not in the preimage, because it carries the preimage's digest (C-M1).
A body that already holds one is refused by the receipt's schema before anything is
hashed. The trailer's bytes live once, in contracts:

    commitMessageWithReceiptTrailer(body, receiptSha256) = body + "\n\nACP-Receipt: " + receiptSha256 + "\n"

It is pure string work with no hash, so contracts may hold it. It parses the body with
the receipt's own field schema and the digest with `Sha256Hex`, and it throws that
parse's `ZodError`. The key `ACP-Receipt:` is one module-private constant, read by both
the body rule and the builder. It sits in contracts and not in the ledger because the
schema must refuse a body carrying the key. A ledger builder would have spelled the
literal a second time, or duplicated the four rules.

### Five — the writer id: rule in contracts, computation in the ledger, input the flat attempt (decision 229; ND-3, ND-4, ND-5, ND-12)

- **The rule:** `WRITER_WORKER_ID_UUID_NAMESPACE` is the bytes of the Claude session
  namespace since P-15/A (ADR 0101), and `WRITER_ID_UNISSUED` is the refusal word. Both
  are declared in contracts.
- **The computation:** `writerWorkerIdFor(taskId, attempt)` in ledger
  `receipt-identity` is the RFC 4122 v5 UUID over `taskId + "/" + String(attempt)`. The
  canon says "elevada a contracts", but contracts may import no `node:` builtin, and a
  pure-JS SHA-1 would be a second hash authority. That is the house split, rule in
  contracts and function in the ledger. The ledger is also where P-16/B's door
  recomputes it. An invalid input throws `LedgerValidationError` naming `taskId` or
  `attempt`, as the ledger's other pure identity functions do. No error class is added.
- **The input** is the **flat per-task attempt** (`legacy_attempt_number`, monotonic per
  task), never the per-revision `attemptNumber`. That one restarts at 1 in each
  revision and would collide. So the derivation needs no revision coordinate, and it
  stays byte-identical to the session a Claude CLI writer runs under: `claudeSessionId`
  receives the same flat attempt (`providers/src/claude/index.ts:124`). The four Python
  vectors of `session-name` hold in both suites.
- **Stated limit:** the receipt's preimage carries `(revisionNumber, attemptNumber)` and
  not the flat attempt. Proving the coordinate → flat-attempt bijection at the door is
  P-16/B's.
- **Stated limit (B-3):** `taskId` stays `Uuid`, which admits uppercase like every task
  id in the system. `writerWorkerIdFor` hashes the bytes it is given, so an uppercase
  `taskId` derives a different writer id. Those are the bytes the CLI ran under, and
  the limit is not this cut's to close.
- **Providers:** `CLAUDE_SESSION_UUID_NAMESPACE` becomes the contracts constant under its
  old name, and `claudeSessionId` keeps its own SHA-1. Providers may import only
  contracts, and L-P15A-1 requires that leaf to hash once with `sha1`. L-P15A-1 is
  byte-unchanged and green. `PROVIDERS_PUBLIC_EXPORTS` stays 97.

### Six — the runtime's authorization and record (decision 229; ND-10, ND-11)

`authorizeCommit` takes the v2 request as a **closed key set**. A key outside it is
`REQUEST_INVALID` at `request.<key>`. One rule covers `initialCommit`, `receiptId`,
`branch`, `commitMessage`, any writer-id field and any unknown key, so no hand-kept list
of forbidden names is needed.

- The request's `writer` is the identity label. The module derives the writer's
  `workerId`, and no caller supplies it.
- The verifier is parsed with the contract's own schema before it is compared, so an
  uppercase or malformed `workerId` is `REQUEST_INVALID`, never
  `VERIFIER_NOT_INDEPENDENT`.
- A `null` head is `BASE_HEAD_MISSING`, and no receipt is issued over it.
  `BASE_HEAD_MISMATCH` leaves the vocabulary with the bootstrap claim it answered.
  `WRITER_ID_UNISSUED` joins, sorted before `WRITE_SET_VIOLATION`.
- `writerIdIssuer` must belong to a closed set with one member today,
  `CLAUDE_CLI_SESSION`. That set is a **module-private constant of the runtime**,
  exported by neither contracts nor the runtime (`RUNTIME_PUBLIC_EXPORTS` stays 307).
  P-16/C, its producer, or P-28, its widening, promotes it when a second reader exists.
  Until P-16/C the caller supplies it, a stated limit.
- `authorizedAt` is a `CanonicalInstant`, the future `authorized_at`. `lease.expiresAt`
  stays the `Lease` contract's `Timestamp`, compared by epoch, and equality counts as
  expired.
- The output carries `receiptSha256`, and the candidate payloads carry it in place of
  `receiptId`.

`recordCommit` requires `parents[0] === receipt.baseSha`, with no null branch: a root
commit is `COMMIT_PARENT_MISMATCH`. It compares the observed message byte for byte with
`commitMessageWithReceiptTrailer(receipt.commitMessageBody, receiptSha256(receipt))`,
so a message without the trailer is a difference. The writer pilot proves this through
a real `git commit -m`, read back from `git cat-file commit`: for the pilot's body, git
keeps the body, the blank line, the trailer and its one LF byte-identical, and the
committed tree is the receipt's `treeSha`.

**Stated limit, handed to P-17/A by name.** That byte-identity is not a guarantee for
every body the schema admits. `git commit -m` uses the `whitespace` cleanup mode: it
strips trailing whitespace from each line, drops leading and trailing blank lines, and
collapses runs of blank lines. `CommitMessageBody` refuses only an empty body, a final
`\n`, a `\r` and an `ACP-Receipt:` line, so it admits bodies git rewrites. Measured
against git 2.52.0: `feat: x  ` (which `authorizeCommit` grants), `feat: x\n\n\n\nmore`
and `\nfeat: x` are each rewritten. Such a commit fails closed: `recordCommit` refuses it
as `COMMIT_MESSAGE_MISMATCH`, so a granted receipt is never reconciled with a message
it did not name, but it is never reconciled at all. P-17/A, which mints the named words
for the body rules, closes it one of two ways: it commits with `--cleanup=verbatim`, or
it adds the body rules (no trailing whitespace on any line, no leading blank line, no
run of blank lines).

One admitted byte is refused by git under either remedy. `CommitMessageBody` admits
`\u0000`, and `authorizeCommit` grants such a body, but git will not write the object:
measured against git 2.52.0, `git commit -F <file> --cleanup=verbatim` exits 128 with "a
NUL byte in commit log message not allowed", and `-m` cannot carry a NUL through argv.
It fails closed, since no commit exists to reconcile, but `--cleanup=verbatim` does not
close it. So P-17/A's body rules refuse `\u0000` whichever remedy it picks. The other C0
controls are not refused by git (`\u0001` is written byte-identical under
`--cleanup=verbatim`); P-17/A's named words say whether they are refused too.

The trailer-key body rule is case-sensitive, and so is L-P16A2-1's matcher: a body
line `acp-receipt: <hex>` is admitted. Git's trailer keys are case-insensitive, but the
appended trailer is always its own final paragraph, so git's parse of it is not
ambiguous. P-17/A's named words say whether a case-folded key is refused too.

### Seven — no version moves (decision 228; ND-1)

`CONTRACT_VERSION` stays `2.11.0` and `API_CONTRACT_VERSION` stays `0.25.0`. No event
payload embeds the receipt, no receipt is stored, and neither function has a production
caller. The receipt is an instrument of new work held to `AdmittedContractVersion`, so a
v2 receipt at `2.11.0` has no V1 twin anywhere. P-05/A (ADR 0066) is the precedent for a
new identity preimage without a bump. ADR 0076 reserves a bump for identity that a
reader of **recorded** history must reconstruct. The first recorded receipt digest is
P-16/B's `VERIFICATION_COMPLETED`, and **P-16/B decides that bump**.

### Eight — the fence (decision 230; ND-14)

- **L-P16A2-1** has two homes. The ledger's `receipt-identity` holds the three prefixes
  and defines `receiptSha256` and `writerWorkerIdFor`. The contracts'
  `commit-authorization` holds `ACP-Receipt:` and defines
  `commitMessageWithReceiptTrailer`. Each appears exactly once in its home and nowhere
  else in `src`, and an absent home fails.
- **L-P16A2-2:** the namespace literal appears in one `src` file, the contracts home.
  Both v5 sites import it from `@acp/contracts`.
- Both laws are text matchers, and the vectors are their semantic guard.
- `PATH_SCOPED_LAWS` goes 175 → 177. `CONTRACTS_SCHEMA_EXPORTS` goes 185 → 189
  (`VerificationReceipt`, `WRITER_WORKER_ID_UUID_NAMESPACE`, `WRITER_ID_UNISSUED`,
  `commitMessageWithReceiptTrailer`).

## Why the alternatives were not chosen

- **A version bump (ND-1 (b)).** It would buy nothing: nothing recorded can be
  misread. It would also re-trigger the stored-envelope restamp class for no reader.
- **One schema admitting `FAIL` (ND-6 (b)).** That contradicts AGENTS law 3 as the owner
  wrote it.
- **`PASS`-only now, with `VerificationReceipt` deferred to P-16/C (ND-6 (c)).** C would
  then have to widen `receiptSha256`'s input.
- **Hashing the whole parsed receipt (ND-7 (b)).** That needs a spec edit, and it puts
  the authorization's facts into the verification's identity.
- **Reusing the roadmap's write-set prefix (ND-8 (b)).** That needs an export from
  `roadmap-steps` and puts a roadmap-named prefix on a task fact.
- **The trailer builder in the ledger.** The contracts schema must refuse the trailer
  key, so the literal would live in two `src` files (B-2).
- **SHA-1 in contracts, or the writer id only in providers (ND-4 (a), (c)).** The first
  is a second hash authority. With the second, the ledger's door could not recompute,
  because the ledger cannot import providers.
- **Hashing `(taskId, revision, attempt)` (ND-3 (b)).** It would break byte-identity
  with the session the CLI ran under.

## Consequences

- A V1 caller of `authorizeCommit` fails loudly (`REQUEST_INVALID` at the first V1
  key), never silently.
- `authorizeCommit` builds only `PASS` receipts. A `FAIL` receipt is P-16/C's runner's,
  and it never reaches this function's success path.
- An observed commit message must carry the trailer exactly. `%s`, `.trim()` or a CRLF
  rewrite is a difference.
- The execution §10.2 `writer_worker_id` cell is amended (ND-13 (a)) so the spec does
  not contradict the code.

## Not in this record

- `verification_read_model`, `audit_verdict_read_model`, the `VERIFICATION_COMPLETED` /
  `AUDIT_COMPLETED` door grammar, `RECEIPT_DIGEST_MISMATCH` at the door, the
  coordinate → flat-attempt bijection, and the bump question (P-16/B).
- The receipt-producing runner (`PASS` and `FAIL`), the verifier and auditor v5 over
  `(task, attempt, role, spawn ordinal)`, `runId`, the tree hasher and its `write-tree`
  oracle, `policy_sha256`'s object, the `writerIdIssuer` producer, and
  `OBJECT_FORMAT_UNSUPPORTED` by name (P-16/C).
- `AuditorPort`, the consumer beats, N03 and D-S1-2 (P-16/D1–D2).
- `commit_authorization_read_model`, `commit_message_sha256`, the refusal words for the
  body rules, the git-cleanup limit of Six (`--cleanup=verbatim` or the body rules, and
  in either case a body rule refusing `\u0000`), and
  the in-force predicate (P-17/A–C).
- Writer-id issuers beyond the Claude CLI, and revocation (P-28). SHA-256 object format
  (P-38).
- The `ledger` README's `### Errors` prose count, which predates this cut (no class is
  added here).
