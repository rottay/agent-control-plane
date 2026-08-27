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
- **never push**. No remote, no push, no `gh` publishing. `.githooks/pre-push`
  refuses unconditionally, and `pnpm check` verifies it still does.
- Local commits require a `CommitAuthorizationReceipt` from an independent
  verifier. Do not commit unless the owner or the DT asked for it.
- **no partial cutover**. Nothing here is adopted into real operation before P8
  certification and a separate P9 authorization.
- No product-repo access. Modern Rescue, the UI Design System refactor, other
  Rottay repositories and existing tmux sessions are out of scope.
- No secrets in code, contracts, tests, fixtures, logs or commit messages.

## Subagents

Do not spawn subagents for shared bootstrap or authority paths: contracts,
schemas, ledger, orchestrator, leases, adapters base, the Git fence, or the
authority documents. Those are integrator-owned and single-writer by law.

Subagents are appropriate only for disjoint leaves with their own exact
write-sets and their own isolated worktrees, and only when the DT has issued
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
