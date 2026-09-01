# Rottay Agent Control Plane

A local, provider-neutral control plane that coordinates multiple coding agents
across providers, accounts and quotas, while keeping repositories safe.

Status: **P0, P1, P2, P3, P4, P5, P6, P7 and P7I complete. Next: P8.** Contracts,
fences, the append-only event ledger, a read-only observation plane over it — a
loopback HTTP server, a CLI and a local UI — a durability plane with two
orchestration drivers under a supervised local daemon, a shadow-mode
observation package with a measured baseline, three read-only provider adapters
behind one process boundary, an accounts domain that estimates quota, ranks
candidates and recommends a switch without ever acting, and a
writer-enforcement plane that decides leases, worktree conflicts and commit
authorization without touching a worktree. P3 closed on committed evidence: the
ledger, the server, the CLI and the UI are proven to agree exactly across all
nine frozen routes — the CLI building its own answer from the same ledger
without ever seeing the server's, and the UI proven to project the server's
answer unchanged, with `health` bound in the contract as its named non-ledger
exception, and with ordering and pagination part of the equality. Collectors
read already-emitted artifacts and synthetic scenarios passively, and the
baseline is recomputed over a disposable shadow ledger and proven
byte-identical after a rebuild.

P4 closed on committed evidence and on an explicit account of what that
evidence does *not* cover. `@acp/adapters` holds one spawn authority, one
session controller and three provider descriptors — Claude headless
`stream-json`, Kimi ACP over stable v1 NDJSON, and the Codex App Server — each
a pure module that builds argv and turns bytes into normalized events, and none
of which can spawn anything itself. Every parser claims an exact method subset
and answers everything outside it with a classified refusal rather than a
guess.

**All five capabilities — `STREAMING`, `RESUME`, `MODEL_PIN`, `SESSION_ID` and
`PROTOCOL_CANCEL` — leave P4 `UNKNOWN` for all three providers, with no
evidence, and no live-conformance claim is made anywhere.** No provider
protocol was handshaked, no account or credential touched, and no real provider
session run: every negative is driven by a scripted fake, which proves our
parser and our machinery and nothing whatsoever about a provider. Each real
capability claim waits for its own separately authorized protocol proof.
Interruption works for all three regardless, because the signal floor is a
property of our process handle rather than a provider feature.

P5 closed on committed evidence and, as with P4, on an explicit account of what
that evidence does *not* cover. `@acp/accounts` holds the owner-file loader and
its admission ladder over a read-only registry (P5A), a clock-injected quota
estimator with its reset calendar (P5B), a quota-aware router that refuses an
account without margin for the next atomic step plus its checkpoint (P5C), and
a switching policy that classifies its trigger fail-closed and returns an
ordered plan of named steps (P5D). The structural normalization that ran
alongside it made accounts the eleventh tree under the folder/index law (P5N,
C11). Every surface is pure and clock-injected: the current instant is an
argument at each entry point, so an answer depends on what it was given rather
than on when it ran.

**Nothing in P5 acts.** No provider session was started, no socket opened, no
credential resolved — `authProfileRef` and `credentialRef` are opaque locators
this package carries and never dereferences. The router recommends and reserves
nothing; the switching policy returns candidate events as values and leaves
every step of its own plan to an executor that does not exist yet. No account
was drained, no task moved, and no quota measured against a live provider: the
estimator reasons over observations it is handed. What P5 completion means is
that the decisions are made and proven, not that anything has been decided *for*
a running system.

P6 closed on committed evidence and, as with P4 and P5, on an explicit account
of what that evidence does *not* cover. `@acp/runtime` gained the
writer-enforcement core (P6A): leases that admit at most one live holder per
worktree, write-set conformance scanned across tracked *and* untracked paths,
prestate verification by digest, and a violation that revokes the lease and
quarantines the worktree — a record whose shape has no field in which a
restore, reset, stash or clean could be written. The conflict graph (P6B)
computes the complete pairwise verdict over task envelopes and is the admission
gate applied before any lease is acquired. Commit authorization (P6C) requires
an independent verifier, every recorded check exiting zero, an observation
inside the declared write-set and a base head projected from that same
observation, and constructs a receipt in which `pushAuthorized` is `false` at
the shared schema — `true` is not a value the module can produce.

**Nothing in P6 acts on a real worktree.** No production observer exists: the
read-only git port is a *type* naming the four verbs an observer may ever
speak, no implementation of it lives in the package, and wiring one is a
separately authorized packet. No lease was acquired over a real worktree, no
commit was authorized for a running system, no worktree was quarantined, and
nothing here ran git. Every proof is a pure function over injected values and
scripted fakes. What P6 completion means is that the enforcement decisions are
made and proven, not that anything is enforcing.

Shadow mode measured synthetic and already-emitted artifacts only. Nothing was
observed from any live session, nothing here is adopted into any real
operation, and no cutover is authorized.

The launchd template stays inert, nothing is installed, and no launch agent
survives a drill. No adapter has been pointed at a real provider, and there is
**no product adoption of any kind**: adoption is a separate owner decision at
P9 that nothing here anticipates or authorizes.

**P1A is not P1 completion**, and neither was P1B. P1 closed only once the
server served the frozen contract, the CLI read it and the UI rendered it, each
under an independent verifier's receipt. Completion is still not product
adoption of any kind: see the isolation section below.

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

## What P1A adds

`packages/ledger` implements the authority decided in ADR 0001: an append-only
`ControlPlaneEvent` log in SQLite WAL, with derived, rebuildable read models.
See `packages/ledger/README.md` for the API and
`docs/architecture/0002-sqlite-event-ledger.md` for the decision.

| Guarantee | How it is enforced |
| --- | --- |
| Append-only | `BEFORE UPDATE` and `BEFORE DELETE` triggers abort unconditionally; no raw connection is exposed |
| Tamper evidence | canonical JSON plus a SHA-256 chain, re-verified end to end by `verifyIntegrity()` |
| Idempotency | exact replay writes nothing and returns the original; same key with different content fails closed |
| Stale writes | a transition must declare the state the task is actually in |
| Derived read models | one projection implementation shared by the live path and by replay, so a rebuild is byte-equivalent |
| Atomicity | event, projection and head metadata move together, or not at all |
| Schema drift | ordered migrations under checksum, verified on every open; read-only never migrates |

`better-sqlite3` is the one native dependency and the only name on the
install-time build allow-list. `pnpm check:architecture` asserts that it stays
the only one.

## Operating this plane

Five operational pages, written to be run by someone who has not seen this
repository before. Their examples use concrete scratch paths so they can be
followed literally; each page says where a real operator substitutes their own.

| page | answers |
| --- | --- |
| [Runbook](docs/operations/runbook.md) | how to build, start and stop the surfaces, and what fails closed until you wire it |
| [Troubleshooting](docs/operations/troubleshooting.md) | the failure classes this system actually produces, by the names it uses for them |
| [Backup and restore](docs/operations/backup-restore.md) | why WAL makes "copy the file" the wrong instinct, and how to prove a restore |
| [Switching accounts](docs/operations/account-switch.md) | which file governs, when the ledger takes over, and why a later file edit does not win |
| [Update and rollback](docs/operations/update-rollback.md) | changing pins deliberately, and rolling back without destroying anything |

## Repository layout

```
.githooks/pre-push                 unconditional no-push fence
scripts/check-architecture.mjs     authority and write-set fence
docs/ROADMAP.md                    canonical authority (byte-exact copy)
docs/architecture/                 architecture decision records
packages/contracts/                frozen runtime contracts
packages/ledger/                   append-only event ledger and read models
packages/runtime/                  durability plane: one lifecycle, two drivers
packages/daemon/                   supervised process and inert launchd template
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
