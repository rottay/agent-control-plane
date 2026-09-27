# ADR 0127 — A commit is written only in a disposable repository, from its recorded authorization

- Status: accepted (P-17, cut B, recorded 2026-09-27).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0126's stated limits that no production caller records the form, that the
  runner's receipt body and `authorizeCommit`'s are two sources, that the effect's
  fence-token check and the lapsed-lease question are open, and that base and tree
  against the repository and NB-2 wait for a Git read. This cut pays each of them for the
  Git effect in disposable repositories; P-17/C still owns their use at `COMMIT_RECORDED`.

## Context

P-17/A (ADR 0126) made a commit authorization a recorded fact with one door and one
in-force predicate, and left the Git effect to P-17/B: the writer in disposable
repositories, `update-ref`, the committer identity, `authorized_at` as Git's dates, the
fence token, the production caller of `authorizeCommit`, base and tree against Git and
NB-2 (decision 247). The owner's grant of 2026-09-25 (item 3; map-v3 §5 items 1 and 4)
admits a new spawn site with `hash-object -w`, `write-tree`, `commit-tree` and
`update-ref <ref> <new> <old>`, only in per-test repositories under the OS temporary
directory or `.acp-local/`, with `/usr/bin/git`, a built environment, no hooks, unsigned,
dates set to the recorded `authorized_at`, a non-personal committer identity passed by
`-c`, and the canonical checkout proven byte-identical. It does not authorize the
canonical checkout, another repository, porcelain, `push`/`remote`/`fetch`, or
operational commits.

The brief (`p17-b/brief-v1`, measured at `404546e`) was pre-reviewed by the DT
(`ACCEPT_WITH_CORRECTIONS`, B-1 to B-7). ND-ID and ND-1 to ND-20 were ruled and adopted.
The owner ordered delivery over iteration (2026-09-26): targeted checks, no full
`pnpm check`. Kimi and Fable are not used; an independent Claude verifier checks the
result.

## Decision

### Two modules (ND-1 (a), ND-2 (a))

`daemon/src/git-writer` is the spawn site and does Git only. `daemon/src/commit-writer`
is the production caller of `authorizeCommit`; it spawns nothing (every spawn is the
writer's, every read the observer's, every record the ledger door's). Both are
daemon-internal and off the barrel, reached by no route, verb, CLI or beat, and not wired
into the walk: P-17/C wires steps 8 and 9 to the caller.

### The writer: three plumbing verbs, a built environment, a fixed prefix (B-1, ND-ID)

- `GIT_WRITER_VERBS` is the frozen literal `commit-tree`, `hash-object`, `update-ref`,
  checked before any spawn (`GIT_WRITER_VERB_DENIED`). `write-tree` is a test-only oracle
  (ND-5 (a)); `init` stays out, because tests create their own repositories (N-9).
- `/usr/bin/git`, `shell: false`, one `spawnSync` per call, bounded in time and output;
  stderr is never read.
- The environment is built from constants: `PATH`, `LC_ALL=C`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CEILING_DIRECTORIES` at the repository's parent, and
  the two dates. No `HOME` (N-1) and no identity variable.
- The prefix is on **every** spawn (`hash-object`, `commit-tree`, `update-ref`):
  `core.hooksPath=/dev/null`, `commit.gpgSign=false`, `user.useConfigOnly=true`,
  `core.quotePath=false`, `i18n.commitEncoding=UTF-8`, and the injected identity on the
  six keys Git reads: `user.name`, `user.email`, `author.name`, `author.email`,
  `committer.name`, `committer.email`.
- The identity is a required injected value with no default. While operational writing
  is off it must be on an RFC 2606 `.invalid` domain, and a name or email holding `<`,
  `>`, a line break or NUL is refused (`GIT_WRITER_IDENTITY_INVALID`, zero spawns). Tests
  use `Agent Control Plane <plane@agent-control-plane.invalid>`. The operational identity
  stays the owner's to name.

**Probe fact 5, restated.** `-c user.useConfigOnly=true` stops `commit-tree` from
inventing an author, but it does not cover reflogs: `update-ref` with no identity writes
its reflog entry under the host's implicit identity. And a repository-local
`author.name` or `committer.email` overrides `-c user.name`/`-c user.email`. Both are
closed by pinning all six keys on every spawn and binding `GIT_COMMITTER_DATE` on
`update-ref` too: the reflog line reads the injected identity at the recorded second.

### Admission, and operational writing off (ND-10 (b) narrowed, B-4, B-5, ND-14)

`OPERATIONAL_GIT_WRITING = false as boolean` is a frozen literal. While it is off a
target is admitted only if its real path is **strictly under** the checkout's real
`.acp-local/`. The checkout root is derived in the writer with the daemon `paths`
module's own expression (the same depth, five steps up), never supplied by a caller;
`paths/index.ts` is unchanged. `os.tmpdir()` is not admitted: it reads `TMPDIR`, and a
`TMPDIR` set to a parent directory would admit sibling repositories. So no `node:os`
enters the daemon's production files.

The pure pre-checks run with zero spawns: an absolute, resolved path; the strict
`.acp-local/` containment; never the checkout nor a path containing it; and a `.git`
that is a real directory (not a file, a gitlink or a link). Anything else is
`GIT_WRITER_OPERATIONAL_DISABLED`. Then, through the observer: the object format `sha1`
(`OBJECT_FORMAT_UNSUPPORTED`), the target is its own toplevel, HEAD is born
(`rev-parse --verify -q HEAD`, else `BASE_HEAD_MISSING`, asked first because
`--symbolic-full-name` exits 128 on an unborn HEAD) and names a branch
(`rev-parse --symbolic-full-name HEAD` is not `HEAD`, else `GIT_WRITER_HEAD_DETACHED`).
The ref the effect moves is that `refs/heads/*`. Admission also checks where Git
writes, not only where `.git` is (V-1): the `.git` holds no `commondir`, its `refs/`,
`refs/heads/` and `objects/` are real directories and its `HEAD` and `packed-refs` are
not links (zero spawns), and `rev-parse --path-format=absolute --git-dir
--git-common-dir` both resolve to the repository's own `.git`, else
`GIT_WRITER_OPERATIONAL_DISABLED`; so a repository under `.acp-local/` cannot move a
branch of another repository, the canonical checkout included. `gitWrite` itself runs
`update-ref` only as `<admitted ref> <new id> <old id>`, so no delete or two-operand
overwrite reaches the spawn (A4).

### Objects and the commit, each id checked (ND-5 (a), ND-6 (a), ND-11 (a), ND-12 (a))

The tree hasher gains three pure exports and stays the one `createHash("sha1")` home:
`treeObjects` (every tree body and id, children first), `readWorktreeTree` (the runner's
path set read **once**, no-follow, returning each blob's bytes beside its id, deletions
skipped), and `commitObject` (the exact body and id of the one commit object). The
writer sends to `hash-object -w --no-filters --stdin` the bytes that were hashed, then
each tree body to `hash-object -w -t tree --stdin`, one spawn per object, bounded by the
runner's copy bounds (`GIT_WRITER_BOUND_EXCEEDED`); every printed id must equal the
in-process one (`GIT_WRITER_OBJECT_MISMATCH`), and the root must equal the receipt's
`tree_sha`. The commit is `commit-tree <tree> -p <base>` with the message on **stdin**:
`commitMessageWithReceiptTrailer(body, receiptSha256)`, whose sha256 is the row's
`commit_message_sha256`. Both dates are `@<floor(authorized_at / 1000)> +0000`, from the
row. The printed id must equal `commitObject`'s. `commit-tree` does no whitespace
cleanup, so no word is needed for trailing whitespace; a nonzero exit (a NUL in a body,
which Git refuses) is `GIT_WRITER_COMMIT_FAILED` (ND-13).

### The compare-and-set, read back (ND-13 (a), ND-9 (a))

The fence port is called once, immediately before `update-ref`; a refusal is
`GIT_WRITER_FENCE_REFUSED` carrying the word. Then `update-ref <ref> <new> <old>`, always
three operands, `<old>` the revalidated base, and the ref read back through the observer.
A success is the read-back commit, never `commit-tree`'s output. A nonzero exit is
classified by the read-back: the base is `GIT_WRITER_REF_UNCHANGED`, another commit
`GIT_WRITER_REF_MOVED`, no answer `GIT_WRITER_REF_OUTCOME_UNKNOWN`. None moves a row.

### The fence token, and the lapsed lease: no (ND-9 (a), B-3)

A lapsed lease holds no valid token for a mediated mutation. The production binding of
the fence port is the walk's `LeaseHold.renew()`, and the check **is a renewal**: under
the store lock it re-reads the row, a moved fence or lease id is `LEASE_FENCE_LOST`, a
lapsed lease is refused by runtime `renewLease` as `LEASE_EXPIRED` (expiry at the
instant included), and a success extends `expiresAt` and records a `LEASE_ACQUIRED`
through the arbiter's own queue. A store `sweep` frees the row without moving the fence;
the lease id is gone, so a swept lease is a lost hold, `LEASE_FENCE_LOST`, and an
unswept lapsed one is `LEASE_EXPIRED`. A successor's grant moves the fence:
`LEASE_FENCE_LOST`. The renewal never reads incarnation metadata. The test binding is a
real arbiter over a real lease store.

### The production caller: the authorization, in `AUDITING` (ND-3, ND-4, ND-15, ND-16, ND-17, B-6)

`authorizeRecordedCommit` reads recorded facts alone: the task through
`readRecordedTask`, the coordinate's last receipt and its bytes by reference, and the
attempt's recorded lease. The lease id is the ledger's own fold, `recordedLeaseOf`, now
on the barrel with the `RecordedLeaseEvent` type, over the task stream's
`LEASE_ACQUIRED` and `LEASE_REVOKED` read through `listEvents` and merged by sequence;
the `Lease` is built from that id's last `LEASE_ACQUIRED` payload, and its worktree must
be the repository's real path (`LEASE_WORKTREE_MISMATCH`, `authorizeCommit`'s word,
carried). With the current observation, `authorizeCommit` rebuilds the receipt; its
`receiptSha256` must be the recorded one (`GIT_WRITER_RECEIPT_MISMATCH`), and so must the
observed paths, member by member, because the receipt's name does not cover them. Then the
record-form `COMMIT_AUTHORIZED` goes through `Ledger.append`, same-state in `AUDITING`,
transition `commit.authorized.<verifier run>`, at the injected clock's instant, emitted by
and authorized by `COMMITTER_IDENTITY_LABEL` = `acp/commit-writer/coordinator/01`. The role
segment is `coordinator`, because `WORKER_ROLES` is closed and has no `committer`. The
row is born `INTENDED` with `authorized_at` = that instant. An `INTENDED` row already
standing over the receipt is kept and not re-recorded.

**The body is read, never supplied (ND-3 (a)).** `authorizeCommit` takes its message body
from the recorded envelope's `title`, the source the runner's receipt body already reads;
`commitMessageBody` leaves `REQUEST_KEYS`, a caller that names it is `REQUEST_INVALID` at
`request.commitMessageBody`, and the body words land at `request.envelope.title`. An empty
title is refused by the envelope contract first, so `COMMIT_MESSAGE_BODY_EMPTY` stays in
the vocabulary and is unreachable through `authorizeCommit`.

### The production caller: the effect, in `READY_TO_COMMIT` (ND-7 (a), ND-8 (a), B-2)

`writeAuthorizedCommit` reads the row back (`getCommitAuthorization`) and uses its
`authorized_at`. The order is B-2's:

1. `commitAuthorizationInForce`, the one predicate, extended through `revalidated` with
   the base (HEAD's commit against the receipt's, `REVALIDATED_BASE_MISMATCH`), the tree
   read now against the receipt's (`REVALIDATED_TREE_MISMATCH`), the write-set digest
   (`WRITE_SET_MISMATCH`) and the policy digest (`POLICY_DIGEST_MISMATCH`). The two new
   words take the ledger's vocabulary from 26 to 28. A refusal is
   `GIT_WRITER_NOT_IN_FORCE` carrying the word, with zero write spawns.
2. Blobs and trees, each id checked.
3. NB-2: every path of `diff --raw -z --no-renames <base> <tree>`, through the observer's
   `diff` verb, is in the envelope's write-set, else `GIT_WRITER_TREE_OUTSIDE_WRITE_SET`
   before any commit object exists.
4. `commit-tree`, its id checked.
5. The fence port.
6. `update-ref`.
7. The read-back.

A refusal after step 2 leaves objects (from step 4 on, a commit object) in the
repository and the ref where it was. No `COMMIT_RECORDED` is appended and the row never
moves: that is P-17/C's.

### No bump, no migration (ND-19 (a), ND-20 (a))

No event type, key, route, table or verb is added. `CONTRACT_VERSION` stays 2.11.0 and
`API_CONTRACT_VERSION` 0.25.0; migration 30 stays free. One cut of 25 paths.

## Restamp (decision 203's format)

| Pin | Before | After |
| --- | --- | --- |
| `SPAWN_ALLOWED_FILES` | 5 | 6 (`daemon/src/git-writer/index.ts`) |
| `PATH_SCOPED_LAWS` / `requireScope` sites | 188 / 188 | 190 / 190 |
| `COMMIT_AUTHORIZATION_REFUSALS` (ledger) | 26 | 28 |
| ledger barrel | — | + `recordedLeaseOf`, + type `RecordedLeaseEvent` |
| `GIT_READ_VERBS` | 4 | 4 (`cat-file` is P-17/C's) |
| `AUTHORIZATION_REFUSALS` (runtime) / `RUNNER_REFUSALS` | 19 / 19 | 19 / 19 |
| `CONTRACT_VERSION` / API / `CONTRACTS_SCHEMA_EXPORTS` | 2.11.0 / 0.25.0 / 191 | unchanged |
| `RUNTIME_PUBLIC_EXPORTS` / `DAEMON_PUBLIC_EXPORTS` | 317 / — | unchanged |
| ADR corpus | 126 | 127 |

Every pin was recalculated and never lifted.

## Fence

- **`SPAWN_ALLOWED_FILES` 5 → 6.** The new entry is the writer, "the single git write
  authority, disposable repositories only". The commit writer is not a spawn site.
- **L-P17B-1 (new)**, "one Git writer, plumbing only, in a built environment, hooks off,
  unsigned, at recorded dates, the identity by -c": over the writer, comments stripped,
  the frozen verb literal checked before the one `spawnSync(`; none of the porcelain,
  network, index or signing words; `/usr/bin/git` once and `shell: false`; no
  `process.env`, `node:os`, `createHash(`, `Date.now(` or `new Date()`; the environment
  one frozen literal with `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`,
  `GIT_CEILING_DIRECTORIES` and no `HOME`; the two dates bound once from `gitDateOf(`; the
  prefix with the four configuration keys and the identity on six keys; no
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` name or email; `OPERATIONAL_GIT_WRITING` the literal
  false; `update-ref` with three operands; the checkout root by the `paths` expression and
  no root parameter; the vocabulary sorted. No other daemon `src` file names
  `"commit-tree"`, `"hash-object"` or `"update-ref"`.
- **L-P17B-2 (new)**, "the production caller of authorizeCommit reads and records, and
  never supplies": over the caller, no spawn, no `child_process`, no `/usr/bin/git`, no
  `"COMMIT_RECORDED"`, no clock read, no `commitMessageBody:`; `authorizeCommit(` and
  `commitAuthorizationInForce(` once each; `readRecordedTask(`, `recordedLeaseOf(`,
  `listEvents(` and `getCommitAuthorization(` named; every append through `ledger.append(`;
  the effect's date is the row's.
- **Amended**, each in its own row:
  - L-C-4a: `/usr/bin/git` is named in exactly two daemon files, the observer and the
    writer; the observer part is unchanged.
  - L-P17A-2: `commitAuthorizationInForce(` is called in the ledger module and exactly once
    in the commit writer, nowhere else; `REQUEST_KEYS` names no `"commitMessageBody"`;
    `authorizeCommit` reads `envelope.title` and no caller's body; the vocabulary holds
    exactly 28 words.
- **Re-bitten unchanged:** the daemon's builtins (no `node:os`), L-P16C-1, L-P16C-2,
  L-P16A2-1, L-C-4b and L-P16D1-2.
- **The write-set.** `P17B_WRITE_SET` freezes the 25 paths of the cut, 7 of them new.
- **Limits.** These laws are textual (L-P27C-1's limits). The semantic guards are the
  writer's suite (hooks, signing, encoding, identity, `HOME`, admission, verbs, NB-2, the
  compare-and-set, the canonical `.git` digest), the caller's end-to-end suite, and the
  hasher's oracles.

## Consequences

- The plane can write a real commit and compare-and-set a branch, and only in a
  disposable repository, only from a recorded authorization held in force at the effect.
- The commit object is a function of recorded facts: the tree, the first parent, the
  message, the injected identity and `authorized_at`. The same facts in two repositories
  give the same id.
- The runner and `authorizeCommit` read one body, so a rebuilt receipt equals the
  recorded one.

## Stated limits

- **The index is stale after the compare-and-set.** The writer never writes the index (no
  index verb is granted), so the disposable repository's index still names the base tree.
  Asking the owner for `read-tree` is the named fix, not this cut's (ND-14).
- **No OS sandbox** (P-25). The writer's confinement is by construction: admitted
  targets, a built environment, a fixed prefix, bounds.
- **The window between the fence check and `update-ref`** is closed by the ref's own
  compare-and-set against the base, and by §6.1 part 2 (P-18/recuperación).
- **Seconds are truncated.** Git dates carry whole seconds; P-17/C's reconciliation
  compares tree, first parent and message, not dates.
- **No `COMMIT_RECORDED`.** The effect leaves the row `INTENDED` and the task
  `READY_TO_COMMIT`; the record, `OUTCOME_UNKNOWN` and reconciliation are P-17/C's.
- **Observer reads run repository-local configuration.** A repository-local
  `core.fsmonitor` would execute on the observer's `status` (N-3). The observer is
  unchanged; disposable repositories are the tests' own. The owner of the fix is P-25 or
  the observer's own cut.
- **A second effect after success** is refused by the base revalidation
  (`REVALIDATED_BASE_MISMATCH`), before any write, because HEAD is the new commit.
- The receipt's name does not cover the observed paths; the caller holds them member by
  member at the authorization, and the effect holds the tree.

## Not in this record

- §10.4 `commit_read_model`, `COMMIT_RECORDED`, `INTENDED → RECORDED`, the canonical
  predicate call at `COMMIT_RECORDED`, `OUTCOME_UNKNOWN` and its reconciliation, refusing
  `VERIFICATION_COMPLETED` while a row is `OUTCOME_UNKNOWN`, `cat-file`
  (`GIT_READ_VERBS` 4 → 5), step 9 as a consumer beat, and wiring this caller before steps
  8 and 9 (P-17/C).
- `workspaceMode` / `READ_ONLY` and relaxing `WRITE_SET_EMPTY` (P-17, its own cut).
- Enabling operational Git writing, §6.1 part 2 confinement and reaping, and the crash
  matrix (P-18/recuperación, then a separate owner act).
- Revoking an authorization, and issuers beyond the Claude CLI (P-28).
- The sha256 object format (P-38). Porcelain, `push`, `remote` and `fetch` are
  unrepresentable (AGENTS law 5).
- The operational committer identity (the owner's to name).
- P-16's packet acceptance (a later docs-only act; decision 247).
