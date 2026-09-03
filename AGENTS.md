# Agent operating law

This file binds every agent that works in this repository, regardless of
provider or model. `docs/ROADMAP.md` is the canonical authority; this file is
the operational encoding of it. Where they disagree, the roadmap wins.

## Identity

Every worker has a uniform identity: `<provider>/<model>/<role>/<instance>`.

Roles are closed: `coordinator`, `implementer`, `reviewer`, `consultant`,
`verifier`. Providers and models are open, because the roadmap forbids assuming
that current model preferences are permanent.

| Worker | Role |
| --- | --- |
| `kimi/k3/coordinator/01` | Technical owner / DT. Classifies packets, issues briefs and write-sets, adjudicates disputes, accepts or rejects milestones. Not the routine writer. |
| `claude/opus/implementer/01` | Architecture integrator and principal writer. Owns contracts, ledger, orchestration, leases, recovery, adapters. The only worker that integrates into the canonical worktree. |
| `claude/sonnet/implementer/NN` | Mechanical implementers. Scaffolding, fixtures, tests, bounded adapters. Isolated, disjoint worktrees only. Never integrate, never widen scope. |
| `claude/fable/reviewer/01` | Strict auditor. Structurally read-only. Emits exactly one `ACCEPT`, `ACCEPT_WITH_CORRECTIONS` or `REJECT`. |
| `codex/<resolved-model>/consultant/01` | Owner-facing consultant and phase-boundary checkpoint auditor. Concise by design. |

## The laws

### 1. Single writer

There is exactly one **single writer** per worktree, at all times. Two writers
never share a worktree. Parallel work happens only in isolated, disjoint git
worktrees whose write-sets, authorities and derived outputs do not intersect.

Only the architecture integrator merges into the canonical worktree.

### 2. Exact write-set

Every packet carries an **exact write-set**. Creating or modifying any path
outside it is a violation, not a judgement call. After every atomic step, the
tracked diff and the untracked paths are compared against the write-set.

A violation revokes the lease and moves the task to `SUSPECT_WORKTREE`. The
worktree is quarantined and inspected. It is never cleaned, reset or restored.

If a needed path is missing from the write-set, **stop** and propose the exact
addition. Do not improvise a twenty-fourth path.

### 3. Independent validation

The writer is never its own verifier. Tests and receipts are the primary
evidence; writer prose is not evidence. **Independent validation** means a
different worker actually executed the checks and recorded their exit codes.

A `CommitAuthorizationReceipt` is invalid if the verifier equals the writer, if
any recorded check exited nonzero, or if any observed change falls outside the
declared write-set.

### 4. The auditor is structurally read-only

`claude/fable/reviewer/01` is **structurally read-only**: it never edits files,
never commits, never spawns implementers, and never runs the build to make a
failing check pass. Read-only is enforced by the contract, not by good manners.

### 5. Local commits, and publication only by explicit owner act

Local commits require a `CommitAuthorizationReceipt` issued after independent
validation. Agents **never push**, to any remote, for any ref, on their own
authority or on any instruction that does not come from the owner directly.

The repository is published. The owner authorized it on 2026-09-03:
*"Autorizo retirar la fence de no-push de Agent Control Plane y publicar main"*.
That authorization covers publishing committed `main` to one canonical remote
and nothing else.

`.githooks/pre-push` therefore **denies by default** and permits exactly one
shape: `refs/heads/main` to `refs/heads/main` on `origin` at
`https://github.com/rottay/agent-control-plane.git`, fast-forward only, with
`ACP_OWNER_PUBLISH=1` set for that single command:

```sh
ACP_OWNER_PUBLISH=1 git push origin main
```

Deletions, tags, other branches, other remotes, non-fast-forward updates and
credential-bearing URLs are all refused. `ACP_OWNER_PUBLISH` is a one-shot
signal: exporting it from a profile, writing it into a tracked file, or setting
it for an agent turns an explicit authorization into a standing one, which is
precisely what it exists to prevent. No agent may set it.

Arm the hook once per checkout:

```sh
git config core.hooksPath .githooks
```

`pnpm check` fails if that setting is missing, drives the hook over its whole
deny/permit matrix, and asserts the remote is the canonical one by exact URL
with no credentials in it.

**Publishing the repository is not operational cutover.** P9 remains deferred
and unauthorized; law 8 is untouched by this ruling, and the fence still
refuses a `NEXT_P9` or any cutover claim in the roadmap.

### 6. No destructive Git

**No destructive Git.** Forbidden without exception:

- `git restore` or `git checkout --` on directories or path sets;
- `git reset --hard`, and any reset that discards uncommitted work;
- `git stash`, `git clean`, and any auto-clean;
- force operations of any kind.

If files are broken, fix the specific broken lines. Recovery revalidates
authority and prestate; it never forces the tree back to an old snapshot.

### 7. No product-repo access

**No product-repo access.** This repository may not read, write, observe,
message or take leases on Modern Rescue, the UI Design System refactor, any
other Rottay repository, or any existing tmux session. Writes are exercised only
in toy repositories and disposable worktrees.

### 8. No partial cutover

**No partial cutover.** The new system is not adopted subsystem by subsystem,
however well an isolated piece works. It must reach complete pre-cutover
certification in P8, and the owner must then separately authorize P9. Cutover is
a single, reversible, explicit decision with a tested rollback.

### 9. No secrets, anywhere

No secret enters this repository, the ledger, read models, logs, checkpoints,
prompts, artifacts or commits. Contracts carry opaque references only. The owner
account file lives outside every repository at
`~/.rottay-agent-control-plane/accounts.local.json`, mode `0600`.

### 10. Continuity is digest-based

A checkpoint carries the last atomic step, HEAD, authority/read/write digests,
receipts, pending work, one next safe action, and artifact references by digest.
It is bounded in bytes. It never carries a provider transcript, and never
carries credentials.

## Working rhythm

1. Receive a brief with an exact write-set and authority by path plus digest.
2. Verify prestate: branch, HEAD, authority digests, and that the write-set
   paths are what the brief says they are.
3. Work in atomic steps. After each one, checkpoint and re-check conformance.
4. Hand the diff, the check exit codes and a receipt to the integrator.
5. Stop at the write-set boundary. Escalate rather than widen scope.

## Supervision budget

Audit effort is bounded on purpose, so review does not become its own project:

- mechanical, reversible packet: automatic verifier plus one post-audit;
- semantic packet: one pre-audit of the brief plus one post-audit;
- architecture, leases, credentials, Git or recovery: pre-audit and post-audit,
  plus a single consultant review at the phase checkpoint;
- after a `REJECT`, the DT adjudicates one concrete correction. Auditors are not
  asked to draft successive versions of the same contract without new code.

## Checks

```sh
pnpm install
git config core.hooksPath .githooks
pnpm check
```

`pnpm check` runs the architecture fence first: write-set conformance, the
roadmap digest, authority literals, the publication hook's deny/permit matrix,
the hook path, the canonical remote and the absence of credential stores.
