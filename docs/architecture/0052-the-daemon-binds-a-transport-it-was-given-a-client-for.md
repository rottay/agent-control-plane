# ADR 0052 — The daemon binds a transport it was given a client for

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The execution port has served `API_KEY` end to end since B7s: `admitApiRoute`
carries three closed refusals, the owned `ApiStreamingClient` interface exists
with no SDK behind it, and the B1 conformance fixture already drives one
scenario through both legs to an identical normalized trail.

The daemon could not reach any of it. Two independent blockers, either alone
fatal:

**A. The composition never built the map.** `executionPortFor` gated its whole
binding loop on `transportKind === "CLI_SUBSCRIPTION"` and called
`createExecutionPort({ bindings, harness })` with no `apiBindings`. The port
then answered every API route with `TRANSPORT_UNAVAILABLE` at
`route.transportKind` — a sentence that was true of the port it had been handed
and false of the one the daemon could have built.

**B. The config could not express the binding.** `DaemonExecutionBinding.provider`
was typed to the closed CLI vocabulary and the parser refused anything outside
it, while every entry had to carry `binary` and `configRoot`. An API route had
to declare a CLI binding for an account that has neither — and would still be
refused.

So B1's *"the second transport is composed in the daemon"* rested on a seam that
could not be reached from any configuration an operator could write.

## Decision

### D1a — one array, discriminated, and the discriminant is required

`execution.bindings` stays a single array. Every entry declares `transportKind`
explicitly:

| | CLI_SUBSCRIPTION | API_KEY |
| --- | --- | --- |
| `accountId`, `workdir`, `limits` | required | required |
| `provider`, `binary`, `configRoot` | required | **refused** |

**Required, not optional, and that is the whole distinction.** A
conditionally-required field would give the config two shapes and leave a reader
inferring which one it holds — the second-spelling defect ADR 0040 refused by
name. A required discriminant gives two shapes *one reading*: the compiler
narrows on it, and so does the person.

**API entries are refused their CLI fields rather than having them ignored.** An
operator who wrote a `binary` for an API binding believed this transport spawns
something. Ignoring the field lets the belief survive a green start; naming it
is the correction. The path is the diagnosis — the value never travels.

### D2a — an injected factory, absent by default

`DaemonOptions` gains an optional `apiClientFor`, the fourth use of the
`harness?` / `recordUsage?` / `walks?` precedent, so every existing caller keeps
compiling and keeps its behaviour byte for byte.

**There is no default of any kind, and that is the control this record exists
for.** No factory, or a factory that returns `undefined` for an account, leaves
that account **unbound**. Unbound is a refusal at `route.accountId` — never a
fallback to a sibling's binding, never a fabricated client, never a network one.
A default would open this transport for every operator who never asked for it,
which is exactly what *"subscription operation does not depend on an API key"*
forbids.

**The daemon never holds a credential.** The factory returns a client that has
already closed over its own key. Nothing reaches the config — which is written
to a file and handed to a child process — nor the bindings, the ledger, the
marker, any serialization or the idempotency preimage.

### D3 — the client declares the provider and the models

`ApiStreamingClient.provider` and `.models` are the sole declarations of both,
and `admitApiRoute` refuses the route against them: `ROUTE_INVALID` at
`route.provider`, `CAPABILITY_UNSUPPORTED` at `route.model`. The config
duplicates neither. A second spelling in a file could disagree with the thing
that actually answers the call, and the file would look authoritative while
being wrong.

### D4 — `workdir` stays mandatory on every transport

It locates the **walk**, not the CLI, and six sites read it without asking which
transport served it. A transport that needed no workdir would not be one this
daemon can run.

### D5 — capabilities stay UNKNOWN

No probe, no discovery, no health check, no capability claim. This packet
composes a transport the port already serves; it learns nothing about the
provider at startup and asserts nothing about it. **A later packet must not read
this record as precedent for probing.**

## The consequence that widened the write-set

Making the discriminant required governs **every object literal assigned to
`DaemonExecutionBinding`**, and those literals do not name the type — they
inherit it from context. Five fixture files outside this packet's original eight
paths build them, and all five would have failed `tsc --build --force`.

The first writer measured that, hit its STOP-2 and **implemented nothing**. The
adjudication widened the write-set from eight paths to thirteen rather than
relaxing the type, because the two alternatives were worse: making
`transportKind` optional contradicts D1a word for word, and requiring it in the
parser but not in the type leaves the operator's config under one law and the
in-process fixtures under another.

In those five files the only permitted edit is adding
`transportKind: "CLI_SUBSCRIPTION"`. The staged diff there is seven added lines
and zero deletions.

**This is worth recording as a general fact rather than as an incident.** A
required field on a widely-assigned interface is a repository-wide change whose
blast radius is invisible to a search for the type's *name*. The measurement
that finds it is a search for the *literals*.

## Evidence

**P1, the positive, red first.** The parity fixture proves the *port* serves
both legs; P1 proves the *daemon* composes the API one, driving `startDaemon` —
the composition root — because `executionPortFor` is private and stays private.
Before the change it failed with exactly:

```
ExecutionEffectError: the execution effect was refused: TRANSPORT_UNAVAILABLE at route.transportKind
```

Its anti-vacuity control is the recorded route: a composed API leg that silently
fell back to a CLI binding would satisfy every other assertion, so P1 asserts the
ledger's own `route.transportKind` is still `API_KEY`.

**N1-N8, each at the layer where its evidence exists.**

| # | Condition | Port | Daemon |
| --- | --- | --- | --- |
| N1 | no factory | `TRANSPORT_UNAVAILABLE` @ `route.accountId` | rejects with the same pair; `TASK_FAILED` / `EXECUTION_FAILED`, no checkpoint |
| N2 | factory declines | same | same |
| N3 | client's provider differs | `ROUTE_INVALID` @ `route.provider` | same |
| N4 | client cannot serve the model | `CAPABILITY_UNSUPPORTED` @ `route.model` | same |
| N5 | API entry with `binary`, `configRoot` or `provider` | — | parser refuses, naming the path |
| N6 | API entry with no `workdir` | — | parser refuses |
| N7 | a ninth binding of any transport | — | refused whole, never truncated |
| N8 | the client's secret canary | — | absent from trail, marker, serialization and preimage |

N1 and N2 are the assertions this record most depends on: they keep the
transport closed for every operator who did not explicitly open it.

**One finding upgraded the evidence.** The brief expected the daemon to expose
no `at`, on the reading that a mid-walk refusal reaches the ledger only as
`TASK_FAILED` / `EXECUTION_FAILED`. It reaches the caller as well:
`startDaemon` rejects with the `ExecutionEffectError` the effect raised, and
that error carries the port's own `refusal` and `at` verbatim. So N1-N4 assert
the typed diagnosis at *both* layers rather than only at the port. Nothing was
invented — the field was already there.

## Consequences

- The ADR corpus moves 51 → 52 and the write-set gains one path.
- `PATH_SCOPED_LAWS` stays at **112**: this packet registers no path-shaped law.
- **No export pin moves.** The union widens under `DaemonExecutionBinding`, the
  name this package already published; its two arms are unexported;
  `ApiStreamingClient` is reused from `@acp/providers`; and `executionPortFor`
  stays private — a test that needed it exported would be a test asking the
  production surface to grow for its convenience.
- No `CONTRACT_VERSION`, no `API_CONTRACT_VERSION`, no dependency, no SDK, no
  network egress.
- The API adapter and the execution port are unchanged. This packet is
  composition, not capability.

**Declared follow-up, not fixed here.** `packages/entrypoints/cli/test/cli/index.test.ts`
builds a CLI binding fixture whose comment claims it exists *"to prove the
passthrough over the shape the daemon actually accepts"*. After this record that
document is one the daemon refuses. No gate breaks — the local type is open and
the file never starts the daemon — so it is not in this write-set. It is a
truthfulness debt for a separate packet.

## Lineage

- `0038-a-binding-for-every-account-the-switch-may-reach.md` — why the array
  carries every reachable account rather than only the route's.
- `0040-a-binding-declares-the-provider-it-serves.md` — why a binding declares
  what it speaks instead of inheriting it, and why a conditionally-required
  field was refused. D1a is that rule applied to a second axis.
