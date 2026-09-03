# Agent Control Plane

A local, provider-neutral control plane for coordinating multiple coding agents across
providers, accounts and quotas — on one machine, with an append-only ledger as the authority
and a loopback-only surface over it.

Agent Control Plane runs on an operator's own machine. It records everything that happens as an
append-only, hash-chained SQLite event log, derives every read model from that log, and exposes
the result through three readers — an HTTP server, a terminal CLI and a browser console — that
are proven to agree with each other rather than assumed to.

MIT licensed. Node 22, TypeScript, pnpm workspace.

---

## The problem

Running several coding agents at once is not a scheduling problem, it is an accounting and
safety problem:

- **Providers differ.** Claude, Kimi and Codex speak different protocols with different
  capabilities, and none of them tells you what it will actually support before you ask.
- **Quotas are invisible until they bite.** An agent that runs out of quota mid-task leaves
  work in an unknown state, and you find out afterwards.
- **Concurrent writers corrupt repositories.** Two agents in one worktree is not a merge
  conflict; it is lost work.
- **Crashes lose context.** A restart that cannot say what was already done has to guess, and
  guessing is how a supposedly idempotent step runs twice.

This project treats all four as one problem: make every decision explicit, record every
transition, and never let a component act on state it cannot prove.

## What it does

- **Coordinates work as concurrent initiatives.** Not a flat task list. Every task is scoped to
  an initiative, and that attribution lives in exactly one place — the task — so worktrees,
  leases, checkpoints and commits inherit it rather than holding a second copy that could
  disagree. Roadmap versions are per-initiative; accounts and quota are deliberately global;
  per-initiative token rollups report the spend they cannot place rather than hiding it.
- **Keeps one authoritative history.** An append-only SQLite log, hash-chained and
  tamper-evident, with every projection rebuildable from it byte-for-byte.
- **Runs work durably.** A single lifecycle engine with two interchangeable drivers — a built-in
  SQLite supervisor and a Restate-backed durable-execution edge — that walk the same plan and
  recover from real process kills.
- **Estimates quota and recommends switching.** A clock-injected estimator with a reset calendar,
  a router that refuses an account without margin for the next atomic step plus its checkpoint,
  and a switching policy that returns an ordered plan.
- **Decides writer safety before anyone writes.** At most one lease holder per worktree, an
  exact write-set checked across tracked and untracked paths, prestate verification by digest,
  and commit authorization that requires an independent verifier.
- **Shows all of it locally.** One HTTP server, one CLI and one browser console over the same
  ledger.

---

## Status and maturity

This is working software with an unusually explicit account of its own limits. The distinction
that matters is between *decisions that are made and proven* and *actions taken against live
systems*.

### Shipped

| Area | State |
| --- | --- |
| Contracts | Frozen, strict, versioned, provider-neutral. Credential-shaped keys rejected structurally. |
| Event ledger | Append-only SQLite (WAL), hash-chained, idempotent, with checksummed migrations and rebuildable read models. |
| Observation plane | 17 routes over Fastify on loopback, 2 of them guarded writes. Server, CLI and console proven equal route by route. |
| Durable execution | One lifecycle engine, two drivers, recovery proven against real process kills. |
| Daemon | Supervised local process with a singleton lock, bounded logs and fail-closed port checks. |
| Provider adapters | Claude, Kimi and Codex, behind a single spawn authority with a per-provider environment allowlist. |
| Model execution | One execution port with three transports, behind which the daemon runs a resolved route in an admitted working directory under a durable driver. |
| Accounts and quota | Owner-file admission, quota estimation, quota-aware routing, switching policy. |
| Writer enforcement | Leases, conflict graph, write-set conformance, quarantine, commit authorization. |
| Governance | An executable architecture fence enforcing roadmap authority, write-sets, import purity, topology, dependency and documentation laws. |

### Not shipped, stated plainly

- **No provider protocol has been handshaked.** Streaming, resume, model pinning, session
  identity and protocol-level cancellation are recorded as `UNKNOWN` for all three providers.
  No adapter has ever been pointed at a running provider: no handshake, no credential, no real
  session. Every drill and every negative in the suite runs a scripted fake, which proves the
  port, the parsers and the recovery path and makes no claim about any provider's live behaviour.
  Interruption works regardless, because the signal floor is a property of the process handle
  rather than a provider feature.
- **There is no production Git observer.** The read-only Git port is a type naming the four verbs
  an observer may speak; no implementation ships in the package. No lease has been taken over a
  real worktree and no commit has been authorized for a running system.
- **Routing recommends; it does not act.** No account is drained, no reservation is held, and the
  opaque authentication and credential references are never dereferenced.
- **The performance baseline is synthetic.** The measurement machinery is proved and pinned, but
  it has only ever run over already-emitted artifacts and synthetic scenarios. No throughput,
  token or latency improvement is claimed.
- **The launchd integration is an inert template.** Nothing installs it and nothing invokes
  `launchctl`.
- **Nothing here is adopted into real operation.** This repository has **no product cutover
  authority**. Adoption is a separate, explicit, reversible owner decision, and it is not implied
  by anything working.

Out of scope by decision, so absence is not mistaken for oversight: authentication on the read
plane, TLS, multi-tenancy and authorization roles, network hardening of the pinned durable
server, and sandboxing of provider processes.

---

## Architecture

Five strata, twelve packages. Dependencies point inward: an edge may reach a domain, a domain may
not reach an edge.

```
kernel/       contracts        frozen runtime contracts, provider-neutral
              protocol         the browser-safe observation contract

persistence/  ledger           append-only event log and derived read models

domains/      runtime          lifecycle engine, orchestration port, writer enforcement
              accounts         quota estimation, ranking, switch recommendation
              observation      passive collectors and the measured baseline

edges/        providers        three provider adapters behind one spawn authority
              durability       the Restate edge: driver, endpoint, pinned server

entrypoints/  daemon           supervised process and inert launchd template
              gateway          the loopback HTTP front
              console          the local operator surface, browser-safe
              cli              the terminal reader over the same ledger
```

Four ideas hold it together.

**The ledger is the authority.** Every read model is derived and rebuildable; one projection
implementation serves both the live path and replay, so a rebuild is byte-equivalent to what it
replaces. Updates and deletes abort unconditionally at the database level.

**Domains declare ports; edges implement them.** The orchestration port lives in the runtime
domain, not in the Restate edge that satisfies it — an edge that owned its own port would be an
edge implementing itself. The same shape applies to model execution: the daemon builds the port
from admitted bindings and injects it, so the runtime domain never imports a provider.

**Continuity is carried by digests, never by transcripts.** A checkpoint records bounded,
digest-based state and one next safe action. Replaying a provider transcript is not a recovery
strategy this system offers.

**Agreement is proven, not assumed.** The CLI builds its answer from the ledger without ever
seeing the server's; the console is proven to project the server's answer unchanged. Ordering,
pagination, cursors and redaction are part of that equality.

---

## Use cases

- **Read the recorded history of a run.** `acp integrity` verifies the hash chain end to end;
  `acp events` pages through transitions filtered by task, type, emitting worker or resulting
  state.
- **Watch concurrent initiatives.** The console renders the portfolio, per-initiative task graph,
  timeline, agents, accounts and roadmap documents from the same contract the server serves.
- **Run one resolved route durably.** The daemon takes a resolved route and an admitted provider
  binding, walks the plan under a durable driver, and survives a kill mid-step.
- **Decide before acting.** Ask the conflict graph whether two task envelopes may run in
  parallel, or the router whether an account still has margin for the next step plus its
  checkpoint — both are pure functions over values you supply.
- **Measure a baseline.** Collect over already-emitted artifacts or synthetic scenarios and
  recompute the baseline over a disposable ledger.

---

## Technology

| Area | Choice |
| --- | --- |
| Language and build | TypeScript 5.9, ESM throughout, project references |
| Runtime | Node 22.17 (`>=22.17.0 <23`) |
| Packages | pnpm 10.26 workspace, exact-version catalog, install scripts disabled |
| Storage | SQLite in WAL mode via `better-sqlite3` — the only native dependency in the graph |
| Validation | Zod, at every boundary, with unknown keys rejected |
| HTTP | Fastify, bound to `127.0.0.1` |
| Console | React 19, Vite, TanStack Query, Radix primitives, React Flow |
| Durable execution | Restate SDK, with the Restate server acquired as an external pinned binary rather than an npm dependency |
| Tests and lint | Vitest across 13 project scopes, ESLint with typescript-eslint, jsdom and axe-core for the console |
| CI | GitHub Actions running the identical check a local writer runs, against a frozen lockfile |

Optional integrations are the provider CLIs themselves — `claude`, `kimi` and `codex`. None is
bundled or downloaded; each is admitted by absolute path, with ownership, permission and
canonical-path checks, and receives an environment built key by key from a four-variable
allowlist.

An API-key or local/self-hosted route takes an injected client instead of a binary. The bindings
are optional at construction: a port built without them refuses those routes with a classified
reason rather than downgrading them to a CLI, so subscription operation never depends on a paid
API account or a local server.

---

## Quick start

Requires Node 22.17.0 and pnpm 10.26.2.

```sh
pnpm install
git config core.hooksPath .githooks
```

The second line is required, once per checkout. Git's hook path is local configuration that a
clone does not carry, and the checks fail until it is set — by design, because an unarmed fence
is worse than no fence.

One further step is needed before the full suite passes, and it is the only script this
repository ships that reaches the network:

```sh
node scripts/acquire-restate-server.mjs
```

It verifies the platform and the SHA-256 against a pinned manifest, allows a single redirect
hop, and unpacks into an ignored directory inside the checkout. Nothing downloads at import time
and no install hook is involved. To ask whether the binary is present without fetching:

```sh
node scripts/acquire-restate-server.mjs --verify-only
```

Then verify the tree:

```sh
pnpm check
```

## Commands

```sh
pnpm check                 # architecture fence, lint, typecheck, tests
pnpm check:architecture    # authority, write-set, topology and fence checks only
pnpm lint
pnpm typecheck
pnpm test
```

### Running the surfaces

Both binaries must be built before they exist:

```sh
pnpm --filter @acp/cli build
pnpm --filter @acp/gateway build
```

**Read a ledger.** `--database` is required and has no default; the CLI does not guess which
ledger you mean, and it cannot write to one.

```sh
node packages/entrypoints/cli/dist/index.js status --database /absolute/path/acp.sqlite3
```

The verbs are `overview`, `tasks`, `task`, `workers`, `worker`, `events`, `status` and
`integrity`.

**Serve the observation plane.** Every path flag must be absolute; the server binds `127.0.0.1`
and defaults to port 7517.

```sh
node packages/entrypoints/gateway/dist/bin/index.js \
  --ledger /absolute/path/acp.sqlite3 \
  [--accounts-file <absolute path>] \
  [--write-bearer <absolute path>] \
  [--port <n>]
```

Two fail-closed behaviours are worth knowing before you start. Without `--accounts-file`, the
accounts surface answers `UNAVAILABLE` with reason `ACCOUNTS_FILE_UNCONFIGURED` — a true
statement about the process, not an error. Without `--write-bearer`, every write answers `403`:
an unconfigured door is shut, not open.

**Open the console.** It proxies `/api` to the server on loopback and refuses to fall back to
another port.

```sh
pnpm --filter @acp/console dev      # http://127.0.0.1:5178
```

**Stop cleanly.** Send `SIGTERM`, not `SIGKILL`. The daemon's supervised shutdown is what reaps
the durable server it started; killing it outright leaves that process behind with nothing
owning it.

---

## Security and local-first boundaries

**Loopback is the boundary, and it is deliberate rather than titular.** The observation surface
shows every task, worker and transition with no authentication in front of it. The data is
already on the operator's own machine, so a login there buys ceremony rather than security —
what makes it safe is the bind address, which is a constant in code and not a deployment
preference. A routable bind would publish the whole control plane to the local network.

**Reads are free; writes are guarded structurally.** The two write routes are registered through
a single guarded registrar, so a route is protected because of where it is registered rather than
because someone remembered. The bearer token file must be absolute, canonical, a regular file,
owned by the running user, and mode `0600`. A request with no credential and a request with the
wrong one both answer `401`, and they are indistinguishable on purpose.

**No secret enters this repository.** Not the ledger, not logs, not checkpoints, prompts,
artifacts or commit messages. The owner's account file lives at
`~/.rottay-agent-control-plane/accounts.local.json` with mode `0600`, outside every repository.
Contracts carry opaque locators — `keychain://`, `profile://`, `file://` — and never material.
Redaction is absence rather than masking: a value that must not travel is not serialized at all.

**The browser holds nothing it should not.** The console's only workspace dependency is the
observation contract. No absolute path, no event payload and no database driver reaches it, and
the architecture fence asserts that rather than trusting it.

**Supply chain is pinned and quiet.** Install scripts are disabled globally; exactly one package
is authorized to build natively, and the fence asserts it stays the only one. Every runtime
dependency is pinned to an exact version through a shared catalog. The durable server is not an
npm dependency, because the published package carries a postinstall network beacon.

**Publishing is a deliberate, narrowly authorized act.** The pre-push hook denies by default and
only permits a fast-forward update from local `main` to `main` on this repository's canonical
`origin` when the owner supplies the one-shot `ACP_OWNER_PUBLISH=1` signal. Deletions, tags, other
refs, other remotes, credential-bearing URLs and non-fast-forward updates remain blocked. Local
commits still require independent verification; publishing the repository does not authorize it to
control another project or begin an operational cutover.

**Destructive Git operations are forbidden.** A suspected worktree is quarantined and inspected,
never cleaned. The violation record has no field in which a restore, reset, stash or clean could
be written.

---

## Documentation

`docs/ROADMAP.md` is the canonical authority for this repository; its SHA-256 is verified on
every check, and where it and any other document disagree, the roadmap wins.

| Document | What it answers |
| --- | --- |
| [Runbook](docs/operations/runbook.md) | how to build, start and stop the surfaces, and what fails closed until you wire it |
| [Troubleshooting](docs/operations/troubleshooting.md) | the failure classes this system produces, by the names it uses for them |
| [Backup and restore](docs/operations/backup-restore.md) | why WAL makes "copy the file" the wrong instinct, and how to prove a restore |
| [Switching accounts](docs/operations/account-switch.md) | which file governs, when the ledger takes over, and why a later file edit does not win |
| [Update and rollback](docs/operations/update-rollback.md) | changing pins deliberately, and rolling back without destroying anything |
| [API reference](docs/api-reference.md) | every route, checked in both directions against the frozen route table |
| [Architecture decisions](docs/architecture/index.md) | the sixteen records behind the choices above |
| [Contributing](CONTRIBUTING.md) | the write-set, single-writer and independent-validation rules every change follows |
| [Security](SECURITY.md) | the boundary, the write door, the supply chain, and what is out of scope |

Each package carries its own README describing its surface; where a list claims to be complete,
it is checked against the actual exported barrel, so documentation drift fails the build.

## Licence

MIT. See [LICENSE](LICENSE).
