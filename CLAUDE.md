# Claude Code rules — Agent Control Plane

Read `AGENTS.md` first. It is the full operating law and binds every agent
regardless of provider. This file adds only what is specific to Claude Code
sessions in this repository.

This repository is standalone. The Rottay monorepo rules in
`/Users/daniel/Developer/Rottay/CLAUDE.md` do not apply here, except the shared
conventions repeated below.

## Non-negotiables, restated

- **single writer** per worktree. Never open a second writer on a worktree that
  already has one, including via subagents.
- **exact write-set**. Touch nothing outside the write-set in your brief. If a
  needed path is missing, stop and propose the exact addition.
- **never push**, on your own authority or on anything short of a direct owner
  instruction. The repository is published (owner ruling, 2026-09-03), so
  `.githooks/pre-push` now denies by default rather than unconditionally: it
  permits only `main` to `main` on the canonical `origin`, fast-forward only,
  with `ACP_OWNER_PUBLISH=1` set for that one command. Never set that variable,
  never add a remote, and never use `gh` to publish. `pnpm check` drives the
  hook's full deny/permit matrix. That publication authorization is consumed
  (owner order, 2026-09-22); a further push needs a new owner instruction.
- Local commits require a `CommitAuthorizationReceipt` from an independent
  verifier. Do not commit unless the owner or the DT asked for it.
- **no partial cutover**. Nothing here is adopted into real operation before P8
  certification and a separate P9 authorization.
- No product-repo access. Modern Rescue, the UI Design System refactor, other
  Rottay repositories and existing tmux sessions are out of scope.
- No secrets in code, contracts, tests, fixtures, logs or commit messages.

## Where Claude sits, and what it reads

The standing assignment is in `AGENTS.md` under "Reparto vigente" and originates
in the owner's order of 2026-09-22, recorded in `docs/audit/kickoff.md` §0. Every
session in it runs on the claude-admin account; none falls back to the
`claude-daniel` profile or any other account. Three consequences bind Claude Code
sessions here:

- **One Opus integrates, directly on `main`.** It is the only canonical writer.
  Other Opus sessions prepare maps, proposals and oracles or verify authorized
  snapshots, read-only. Nothing about that widens a write-set.
- **The DT commits.** This is the same rule already stated above — do not commit
  unless the owner or the DT asked for it — read from the other side: the commit
  window belongs to the DT, `claude/opus/coordinator/01`, and a writer does not
  stage, commit or mutate the index inside it. The DT's own file edits go to an
  independent verifier before it commits them.
- **Fable audits when the DT calls it.** `claude/fable/reviewer/01` is read-only
  and convened at the DT's discretion, not on every commit; an unavailable Fable
  leaves its closure pending, never simulated.

Read `docs/ROADMAP.md`, which is canonical, and `docs/audit/`, the consolidated
specification, before opening a packet. ADR 0061 admits that folder to the
fence's exact write-set; admission is not authority, and where the two speak the
roadmap governs.

## Subagents

Do not spawn subagents for shared bootstrap or authority paths: contracts,
schemas, ledger, orchestrator, leases, adapters base, the Git fence, or the
authority documents. Those are integrator-owned and single-writer by law.

The one exception is the canonical writer itself: the DT may spawn it as a
subagent or tmux session under claude-admin. That subagent is the single writer,
not a second one; while it holds the worktree no other session, subagent or not,
writes, and it spawns no writing subagents of its own on those paths.

Subagents are appropriate only for disjoint leaves with their own exact
write-sets and a scope that is disjoint in files, outputs and resources — not in
a worktree of their own. No new branch and no new worktree is created for this
work; the coordination mandate excludes them. And only when the DT has issued
that split.

## Git

- Author identity for this repository: `davila23 <daniel.avila@rottay.com>`.
  Verify with `git config user.name` and `git config user.email`. Never change
  global Git config to fix a repository-local problem.
- Conventional commits: `type(scope): description`.
- Never include `Co-Authored-By` or any AI attribution in commit messages.
- Never run `git restore` or `git checkout --` on a directory, never
  `git reset --hard`, never `stash` or `clean`. Fix broken lines directly.
- Ask before any restore, checkout, reset or rebase operation.

## Formatting

- No emojis in code, commits or documentation.
- Text icons only: `✓`, `✗`, `→`, `•`, `─`, `│`, `├`, `└`.

## Before you finish

```sh
pnpm install
git config core.hooksPath .githooks
pnpm check
```

Report the actual exit codes. If a check fails, say so and show the output. Do
not describe work as complete on the strength of prose: in this repository the
tests and receipts are the evidence.
