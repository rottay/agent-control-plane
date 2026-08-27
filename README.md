# Rottay Agent Control Plane

A local, provider-neutral control plane that coordinates multiple coding agents
across providers, accounts and quotas, while keeping repositories safe.

Status: **P0 — bootstrap and authority.** Contracts and fences only. There is no
ledger, no orchestrator, no adapter and no UI in this phase.

## Authority

`docs/ROADMAP.md` is the canonical, durable authority for this repository once
P0 is accepted. It is a byte-for-byte copy of the owner roadmap frozen at
kickoff, and `scripts/check-architecture.mjs` verifies its SHA-256 on every
`pnpm check`. If the roadmap and this README ever disagree, the roadmap wins.

Anything not written in `docs/ROADMAP.md` is not authority. In particular, no
chat message, no agent summary and no audit report grants permission to widen a
write-set, add a dependency or touch another repository.

## Isolation, and what this repository may not do

This implementation is isolated and has **no product cutover authority**.

- It does not touch, pause, observe or take control of Modern Rescue, the UI
  Design System refactor, any Rottay product repository, or any existing tmux
  session. Those remain the only real operation.
- It sends no messages, signals, prompts or commands to any existing agent
  session, and takes no leases on anything outside this repository.
- It is not adopted subsystem by subsystem. Even when an isolated piece works,
  it is not used productively until the whole product passes pre-cutover
  certification in P8 and the owner separately authorizes P9.
- Writes are exercised only in toy repositories and disposable worktrees.

Cutover is a single, explicit, reversible owner decision. It is never inferred
from progress.

## Requirements

- Node 22.17.0 (see `.nvmrc`)
- pnpm 10.26.2

## Setup

Install dependencies and arm the mechanical Git fence. The hook path is a local
Git setting, so it is not carried by a clone and must be set once per checkout:

```sh
pnpm install
git config core.hooksPath .githooks
```

`pnpm check` fails until that command has been run, by design: an unarmed fence
is worse than no fence, because it looks like protection.

## Checks

```sh
pnpm check              # architecture fence, lint, typecheck, tests
pnpm check:architecture # authority, write-set, fence and remote checks only
pnpm lint
pnpm typecheck
pnpm test
```

CI runs the identical `pnpm check` against a frozen lockfile.

## What P0 froze

`packages/contracts` holds the runtime contracts every later phase must agree
on. They are strict, versioned and provider-neutral:

| Contract | Purpose |
| --- | --- |
| `WorkerIdentity` | `<provider>/<model>/<role>/<instance>` |
| `TaskEnvelope` | objective, authority by path and digest, exact write-set, budget, commit policy |
| `WorkerSlot` | resolved model, account, quota, reservation, lease, health probe |
| `Checkpoint` | bounded, digest-based continuity and one next safe action |
| `ControlPlaneEvent` | append-only ledger record keyed by `(taskId, attempt, transitionId)` |
| `CommitAuthorizationReceipt` | independent verification, write-set conformance, push permanently false |
| `AccountRecord` | account metadata with opaque local auth references only |

Two rules are structural rather than advisory. Credential-bearing keys and
secret-shaped values are rejected anywhere inside a checkpoint, event or account
record; and continuity is carried by digests, receipts and the next safe action,
never by replaying a provider transcript.

## Repository layout

```
.githooks/pre-push                 unconditional no-push fence
scripts/check-architecture.mjs     authority and write-set fence
docs/ROADMAP.md                    canonical authority (byte-exact copy)
docs/architecture/                 architecture decision records
packages/contracts/                frozen runtime contracts
```

## Secrets

No secret may enter this repository, the ledger, logs, checkpoints, prompts,
artifacts or commits. The owner account file lives at
`~/.rottay-agent-control-plane/accounts.local.json` with mode `0600`, outside
every repository. Contracts carry opaque references such as
`keychain://`, `profile://` or `file://` locators, never material.

## Git policy

Local commits are allowed only with a `CommitAuthorizationReceipt`. Pushing is
denied unconditionally by `.githooks/pre-push`, and no remote is configured.
Destructive Git operations (`git restore` on directories, destructive checkout
or reset, `stash`, auto-clean) are forbidden: a suspected worktree is quarantined
and inspected, never cleaned.
