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
| `claude/opus/coordinator/01` | Technical owner / DT since 2026-09-22. Classifies packets, issues briefs and write-sets, adjudicates disputes, accepts or rejects milestones, manages local commits. Not the routine writer. |
| `kimi/k3/coordinator/01` | Historical: the DT until 2026-09-22, superseded by the owner's order of that date. Its past briefs, adjudications and receipts stay as recorded. |
| `claude/opus/implementer/01` | Architecture integrator and principal writer. Owns contracts, ledger, orchestration, leases, recovery, adapters. The only worker that integrates into the canonical worktree. |
| `claude/sonnet/implementer/NN` | Mechanical implementers. Scaffolding, fixtures, tests, bounded adapters. Isolated, disjoint worktrees only. Never integrate, never widen scope. |
| `claude/fable/reviewer/01` | Strict auditor, convened at the DT's discretion. Structurally read-only. Emits exactly one `ACCEPT`, `ACCEPT_WITH_CORRECTIONS` or `REJECT`. |
| `codex/<resolved-model>/consultant/01` | Occasional consultant, reached through the owner. Concise by design. |

## Reparto vigente — the standing assignment

The table above is a **catalogue of roles, not a roster**. The assignment
actually in force is the one the owner ordered on 2026-09-22, recorded in
`docs/audit/kickoff.md` §0. It supersedes, in that document, §1–2 as far as they
assign Kimi or Codex, §3 entirely, commit ownership in §5, and §6 as a historical
artefact; that text, which named `kimi/k3/coordinator/01` as DT, stays as history.

Under the same order, the staffing mentions in `docs/ROADMAP.md` — Kimi as DT,
per-phase Codex checkpoints, the Kimi/Fable/Codex line-up of the 2026-08-31
debrief ruling and the P9 staffing line — are historical and do not govern
staffing; who runs the future debrief is pending owner confirmation. The roadmap
remains canonical for scope, sequence and gates, and its bytes are not edited:
the fence pins them.

- `claude/opus/coordinator/01`, a Claude session on the claude-admin account, is
  the DT and sole coordinator. Its model is verified from session metadata, not
  from a terminal title. It plans packets within the authorized scope, delegates
  implementation and verification, adjudicates findings, and **manages staging,
  receipts, local commits and checkpoints**, continuing autonomously after each
  accepted delivery. It does not become the routine writer and does not approve
  its own changes: an edit it makes personally goes to an independent verifier
  before commit.
- `claude/opus/implementer/01`, on claude-admin, is the only canonical writer
  and **integrates directly on `main`**. Exactly one writer at a time; it may be
  a subagent or tmux session the DT spawns under claude-admin. No new branch and
  no new worktree is created for this work. Other Opus instances prepare maps and
  proposals, or verify, read-only — with scope disjoint in files, outputs and
  resources, not merely in folders. Nothing falls back to the `claude-daniel`
  profile or any other account, silently or otherwise.
- Every delivery gets independent validation by a worker other than its writer.
  For an ordinary batch another independent subagent suffices.
- `claude/fable/reviewer/01`, on claude-admin, is re-convened as a strictly read-only
  auditor (law 4), called at the DT's technical discretion:
  important milestones, contract or architecture changes, recovery, credentials,
  Git effects, or a relevant controversy. It is not required for every commit.
  If Fable is unavailable its review is never simulated; that closure stays
  pending.
- `codex/<resolved-model>/consultant/01` is an occasional consultant through the
  owner, not a standing supervisor and not a requirement for any commit.
- `claude/sonnet/implementer/NN` is **historical staffing, not currently
  convened.** Its row stays above because the role remains available and its
  contract still binds whoever holds it.

Unchanged by that order: work directly on `main`; single writer; never push —
earlier publication authorizations are consumed; no UI; no P9 or cutover; no
other repository; no stash, clean, destructive reset or force; no secrets.
Authorization to run development agents on claude-admin does not authorize a
product smoke that consumes real providers; that needs an explicit profile,
model and limits. The functional scope of the roadmap does not change.

Reading is obligatory in both directions before a packet opens: `docs/ROADMAP.md`,
which is canonical, and `docs/audit/`, the consolidated specification of what
this control plane must become — architecture, data model, contracts,
requirements, quality rubric and packet inventory. ADR 0061 admits that folder to
the fence's exact write-set. **Admission is not authority**: where the two speak,
the roadmap governs, and changing that is a separate act of the owner.

This section reassigns nobody's obligations. Law 1 governs concurrency per
worktree and holds unchanged where there is exactly one; law 3 still forbids a
writer from verifying itself, whoever is assigned to write.

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
That authorization covered publishing committed `main` to one canonical remote
and nothing else, and it is consumed (owner order, 2026-09-22): a further push
needs a new, direct owner instruction.

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
  plus a read-only Fable audit at the milestone when the DT judges the risk
  warrants it; a Codex consultation goes through the owner;
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
