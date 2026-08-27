# `@acp/runtime`

The durability and supervisor plane of the Agent Control Plane.

## Scope

**This is P2A: a contract freeze.** The package exports frozen types and
constants and nothing else. There is no state machine, no driver, no daemon, no
Restate service, no listener and no filesystem access.

Importing this package has no side effects. The architecture fence asserts that:
a scaffold that quietly bound a socket or created a directory would be a working
capability nobody authorised, and it would be indistinguishable from progress.

**P2A is not P2 completion**, and it is **no product adoption**. Nothing here is
connected to, observed from or used by any real operation.

## Why the package exists before the code does

Two drivers will advance one state machine: the SQLite supervisor and the
Restate driver. Freezing what they must agree on first is what stops them from
each inventing their own answer to the same question, which is the integration
cost P1 already paid once.

## The laws frozen here

### Authority

`packages/ledger` is the sole application authority. Restate is a **derived**
driver whose state may be deleted and reconstructed from the ledger. The SQLite
supervisor is not a degraded path: it is a first-class alternate driver over the
same core, and it is the predetermined default if the Restate drills fail.

The `OrchestrationDriver` interface deliberately has no method that reads state
back from a driver in order to make a decision. That is how a derived
orchestrator becomes an authority in practice while a document still claims it
is derived.

### Recovery order

Ledger-first **intent**, then an idempotent and probeable **effect**, then a
ledger-verified **outcome**. A completion fact is never appended before the
effect has happened: an append is a claim, and a claim written early is a lie
the log cannot retract.

A crash after the effect but before the outcome append is closed by a
deterministic postcondition probe. A probe that returns `UNKNOWN` fails closed
and leaves an unclosed intent for an operator; it is never guessed in either
direction.

### Replay determinism

Every event and operation coordinate must come from one of exactly three
places: pure derivation over durable invocation inputs, the submission payload
captured before ingress, or a journaled durable step. Never from a clock, a
random source or mutable environment — in any code that can replay, whether it
sits inside `ctx.run` or outside it.

This is not fastidiousness. The ledger treats *same idempotency key, different
canonical bytes* as a typed conflict and fails closed, and the Restate SDK
documents that "there is a small window where an action may be re-run, if a
failure occurred between a successful run and persisting the result." A
coordinate built from `Date.now()` in that window comes back different, and a
benign replay becomes a hard conflict at the exact moment recovery is running.

### Loopback and data roots

Every address is loopback and constant: Restate ingress `127.0.0.1:8080`, admin
`127.0.0.1:9070`, this service `127.0.0.1:9080`. The observation API (7517) and
UI (5178) are unchanged and restated only so port collisions are provable.

Data roots are repository-relative, git-ignored segments — never captured
absolute paths, which name a home directory, a user account and a machine
layout.

## External tools

`@restatedev/restate-sdk` is pinned at `1.16.9` and is a normal dependency; its
whole graph is itself plus one core package, and neither declares an install
script.

The Restate **server** `1.7.7` is deliberately **not** an npm dependency. The
`@restatedev/restate-server` package depends on `@scarf/scarf`, whose
`postinstall` is a network beacon, and this repository's install policy exists
precisely so nothing phones home while being installed. The server is acquired
as an external pinned binary under `.acp-local/tools/` by an explicit operator
command that verifies platform and SHA-256 — never by an install hook.

## Tests

There is no test project for this package yet, and that is deliberate: it
exports types and constants, which its own compilation already proves. The
public data contracts it references are covered by the `contracts` project. P2B
adds the project together with the first driver test.
