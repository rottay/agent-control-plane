# ADR 0004 — Durability, the supervisor, and the recovery law

- Status: Accepted
- Date: 2026-08-27
- Phase: P2A
- Deciders: `kimi/k3/coordinator/01` (DT), `claude/opus/implementer/01` (integrator)
- Audited by: `claude/fable/reviewer/01` (preaudit, ACCEPT_WITH_CORRECTIONS)
- Supersedes: nothing
- Refines: `docs/architecture/0001-control-plane-authority.md`
- Authority: `docs/ROADMAP.md`

## Scope, stated first

This ADR covers the durability and supervisor contract: what a driver is, what
order an effect-bearing step happens in, how a crash is recovered, and where
coordinates are allowed to come from. It covers `packages/runtime` and the five
public contracts added to `@acp/contracts`.

**P2A is not P2 completion.** There is no state machine, no driver, no daemon,
no drills and no `launchd` template yet. `packages/runtime` exports frozen types
and constants and executes nothing.

P2A is also **no product adoption**. Nothing here observes, connects to or is
used by any real operation. Adoption still happens exactly once, after P8
certification and under a separate P9 authorisation, and there is **no partial
cutover**.

## Context

ADR 0001 decided that the append-only ledger is the authority and that Restate,
if adopted, is derived. It named the drills that would decide adoption but not
the contract those drills would test.

That gap is where the interesting failure lives. "The ledger is the authority"
is easy to write and hard to keep: a derived orchestrator maintains its own
durable journal, and a journal is a log. If any fact reaches that journal
without also reaching the ledger, authority has moved, whatever this document
says. P2A exists to make the boundary structural rather than aspirational,
before either driver is written.

## Decision

### 1. One package, two drivers, one core

`packages/runtime` holds one state machine and two driver entrypoints:
`SQLITE_SUPERVISOR` and `RESTATE`. Neither is a degraded path. The supervisor is
the predetermined default if the Restate drills fail, and it drives the same
core over the same ledger.

Duplicating lifecycle or reconciliation logic per driver would guarantee they
drift, and the drift would only be discovered when the two disagreed about a
recovery — which is the one moment there is no time to investigate.

### 2. The driver is told, never asked

`OrchestrationDriver` has no method that reads application state back from the
driver in order to make a decision. It advances the ledger and reports on
itself. This is the structural version of "Restate is derived": a driver that
is never consulted cannot become an authority by being convenient to read.

Restate Virtual Object state, when it exists, may hold a lock or a cache, never
a fact. Any state there that is not derivable from the ledger is authority
leakage.

### 3. The recovery law: intent, effect, outcome

Every effect-bearing step is three beats:

1. **INTENT** — append to the ledger that the step is about to happen;
2. **EFFECT** — perform the side effect, which must be idempotent and probeable;
3. **OUTCOME** — append the verified result.

"Event-first" does not mean claiming completion before it happens. An append is
a claim, and a claim written early is a lie the log cannot retract. The outcome
is appended only after the effect is known to have occurred.

A crash between beats 2 and 3 is the interesting one. It is closed by a
**deterministic postcondition probe** against the operation's coordinate:

- `DONE` — the outcome is appended, exactly once;
- `NOT_DONE` — the effect is re-attempted, safely, because it is idempotent;
- `UNKNOWN` — **fail closed.** The intent stays open for an operator.

`UNKNOWN` is not a retryable error to be smoothed over. A system that guesses
in either direction on an unobservable effect will eventually guess wrong about
something that mattered. P2 exercises one deterministic toy-repository action;
any later provider adapter must supply its own idempotency and probe contract
rather than inheriting an assumption that its effects are observable.

### 4. Coordinates have exactly three permitted origins

Every event and operation coordinate — `eventId`, `occurredAt`, `recordedAt`,
the idempotency coordinates, operation identifiers — must come from:

- **DERIVED**: a pure function of durable invocation inputs;
- **SUBMISSION**: captured before ingress and carried in the invocation payload;
- **JOURNALED**: produced by a journaled durable step, which includes
  `ctx.rand` and `ctx.date`, both deterministic per invocation.

Never from a clock, a random source or mutable environment, **in any code that
can replay, whether inside `ctx.run` or outside it**.

The "or outside it" is the part that is easy to get wrong, so it is worth
stating why it is not paranoia. The ledger treats *same idempotency key,
different canonical bytes* as a typed conflict and fails closed. The Restate SDK
documents its own re-run window: "There is a small window where an action may be
re-run, if a failure occurred between a successful run and persisting the
result." A coordinate built from `Date.now()` anywhere in the replayable path
comes back different inside that window, and a benign replay becomes a hard
idempotency conflict at the exact moment the system is trying to recover. The
SDK enforces the mirror image of this rule itself: calling `ctx.rand` from
inside `ctx.run` is disallowed.

### 5. Reconciliation is ledger-headed and fails closed

`ReconciliationReport` names the ledger head it was computed against, so a stale
comparison cannot pass as a fresh one, and carries `resolvedByLedger: true` as a
literal, so no report can describe a reconciliation that went the other way.

Five verdicts, of which exactly two permit resuming:

| Verdict | Resume | Meaning |
| --- | --- | --- |
| `CONSISTENT` | yes | driver agrees with the ledger head |
| `DRIVER_BEHIND` | yes | ledger is a superset; replay closes it |
| `DRIVER_AHEAD` | **no** | driver claims a fact the ledger lacks |
| `DIVERGED` | **no** | both claim different things for one coordinate |
| `INDETERMINATE` | **no** | the comparison could not be completed |

`DRIVER_AHEAD` is the authority violation this whole design exists to prevent,
and it halts rather than merging. There is no merge policy, because a merge
policy is how a second log quietly becomes authoritative.

### 6. Loopback is a constant, and data roots are relative

Restate ingress `127.0.0.1:8080`, admin `127.0.0.1:9070`, this service
`127.0.0.1:9080`. No reliance on defaults: the Restate configuration reference
documents the `bind-address` field but states no default value, so it is pinned
explicitly and the drills assert that no non-loopback listener exists. The
observation API (7517) and UI (5178) are unchanged.

Data roots are repository-relative, git-ignored segments. A captured absolute
path names a home directory, a user account and a machine layout, which is
exactly what the observation plane already goes to some trouble to redact.

### 7. The server is an external tool, not a dependency

`@restatedev/restate-sdk` is pinned at `1.16.9`. Its entire graph is itself plus
`@restatedev/restate-sdk-core`, and neither declares an install script.

The Restate **server** `1.7.7` is deliberately not an npm dependency. The
`@restatedev/restate-server` package depends on `@scarf/scarf`, whose
`postinstall` runs a network beacon. This repository disables install scripts
precisely so nothing phones home during `pnpm install`, and `onlyBuiltDependencies`
names exactly one package. Rather than add a dependency whose build must be
declined forever, the server is acquired as an external pinned binary under the
ignored `.acp-local/tools/` by an explicit operator command that verifies
platform and SHA-256. Never an install hook.

Docker is not used for the runtime drills. `@restatedev/restate-sdk-testcontainers`
requires it, and a drill that only passes under a container runtime proves
nothing about the `launchd` deployment it is supposed to de-risk.

### 8. `launchd` is last, and never automatic

A template may be written and linted. P2 automation may never call
`launchctl load` or `launchctl bootstrap`, and the template ships with
`RunAtLoad=false` and `KeepAlive=false`. Drills run from scripts first: a
failing plist and a failing drill are indistinguishable, and debugging the pair
together is how a phase loses a day.

## What this does not decide

- the state machine's transition table, which is P2B;
- whether Restate is adopted at all. That is what the drills decide. If they
  fail, the supervisor is the permanent answer and nothing about authority
  changes;
- any mutating observation route. P2 adds none, and may add a read-only,
  redacted driver-status view only after the runtime and drills are green.

## Consequences

Positive:

- the authority boundary is structural: the driver interface has no shape for
  asking a derived orchestrator what happened;
- fail-closed is encoded in the contract, not left to a handler's judgement;
- deleting the Restate data root is a recoverable event by construction;
- the browser and install-time attack surfaces both stay where P0 and P1 left
  them: one build-allowlist name, no telemetry, no Docker.

Negative, and accepted:

- the determinism law is a real constraint on how every future step is written,
  and it is enforced by review and drills rather than by the type system alone;
- an external pinned binary is a manual acquisition step, traded deliberately
  against an install-time network beacon;
- `UNKNOWN` postconditions require an operator. That is the intended cost of
  refusing to guess.

## Compliance

`scripts/check-architecture.mjs` verifies that this document still states the
decision, that the P2A write-set is exact, that `.acp-local/` is ignored, that
the runtime dependency surface is exactly the SDK plus the contracts package,
that no Restate server or Scarf package is present, that the build allow-list is
unchanged, that the scaffold opens no listener and spawns no process, and that
no automated `launchctl` invocation exists.

P2B implements the shared core and the SQLite supervisor.
