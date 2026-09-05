# ADR 0040 — A binding declares the provider it serves

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

F2 (ADR 0038) gave the execution config an array of bindings and gave each entry
the `accountId` it serves. It did not give the entry a **provider**, and there
was nowhere else for one to come from. So `executionPortFor`
(`packages/entrypoints/daemon/src/index.ts`) hoisted a single adapter out of the
entry loop:

```
const adapter = route.transportKind === "CLI_SUBSCRIPTION" ? CLI_ADAPTERS[route.provider] : undefined;
if (adapter !== undefined) {
  const context = { provider: route.provider, taskId };
  for (const entry of execution.bindings) {
    bindings.set(entry.accountId, { adapter, binary: admitBinary(entry.binary, context), … });
```

Every admitted binding therefore carried the **route's** adapter, whatever
account it served. A codex backup account declared beside a claude route was
admitted under `{ provider: "claude" }` and landed in a `CliBinding` holding
`claudeAdapter`.

**The context is not the cost.** `admitBinary` and the directory admissions pass
`context` into `AdapterError` and make no decision from it, so a wrongly-labelled
admission accepts the same paths. **The adapter is the cost.** Each adapter's
`describe` calls `buildEnv` with its own provider literal, and `buildEnv` sets
exactly `PROVIDER_CONFIG_ENV[provider]`: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`KIMI_CODE_HOME`. A codex account driven by the claude adapter has its codex
credential root exported as `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` is never set.
One provider's credential directory is handed to another provider's
configuration variable — and the adapter also decides argv, handshake and
parser, and `startSession` derives its own context from `adapter.provider`.

**The consequence is a check that cannot fire for the maps the daemon builds.**
The port's cross-provider guard is
`if (binding.adapter.provider !== admitted.provider) return refuse("ROUTE_INVALID", "route.provider")`.
For every entry the daemon built, those two values were the same by
construction. The guard is **not untested** — the providers suite asserts it at
four sites over hand-built binding maps — it was **vacuous for daemon-built
ports**, which is the narrower and true claim.

It was harmless at that HEAD only because the routed entry is the only one ever
executed, and its adapter is the route's. The moment a switch opens a session on
a **second** account, a cross-provider destination would be driven by the
source's adapter with the guard unable to say so. That is a fail-open, and it is
why this record lands before the landing does.

## Decision

**Every execution binding declares the provider it serves, and the composition
selects the adapter per entry.**

- **`DaemonExecutionBinding` gains `provider`**, second, after `accountId`,
  required on every entry for **every** transport kind. A conditionally-required
  field would give the config two shapes, which is the second-spelling defect F2
  refused by name.
- **The vocabulary is `CLI_SUBSCRIPTION_PROVIDERS`**, the contract's own list,
  which is the same list `ResolvedRoute`'s refinement uses. A config and a route
  therefore cannot disagree about what a provider name is. The alias is declared
  locally in `daemon-child`, over a value that module already imports;
  `@acp/providers`' `ProviderName` is defined as that same list, so the two types
  are identical by construction and no providers edge is added to the child's
  graph.
- **Membership is a predicate, never a cast.**
  `isCliSubscriptionProvider` narrows the parsed value; an
  `as CliSubscriptionProvider` anywhere in the parser would assert a value into
  the vocabulary that was never tested into it, which is the same failure as
  defaulting in another spelling.
- **Three refusals at the config door**, each naming a path and never a value:
  a shape refusal (`… .provider must be a non-empty string`), a vocabulary
  refusal (`… .provider names no CLI subscription provider`), and the routed
  entry's agreement with the route.
- **The routed entry must declare the provider the route names**, refused at
  **admission** rather than deferred to session time. The message names **both**
  values, following the workdir law's precedent: provider names are public
  vocabulary words, not values that could carry a secret.
- **Nothing is inherited, defaulted or discovered.** No provider is filled from
  `route.provider`, from a sibling entry, from the binary's basename, from the
  configRoot's name, or from any probe.
- **`executionPortFor` selects per entry.** The outer guard becomes the
  **transport**, not the adapter; the adapter is looked up from `entry.provider`
  behind `Object.hasOwn`; a provider with no adapter is a **refusal** naming the
  account, not an empty map; and the existing account-named refusal gains an
  appended clause saying which provider the entry was admitted as.
- **`L-F2B-1`** bans the two shapes the defect had — `CLI_ADAPTERS[route.` and
  `provider: route.provider` — across daemon `src`, with an anti-vacuity half
  requiring the composition site to still name `CLI_ADAPTERS[` and to name none
  of them from the route.

### Why the agreement rule is scoped to `CLI_SUBSCRIPTION`

`ResolvedRoute.provider` is `z.string().min(1).max(40)` and is constrained to the
CLI vocabulary **only** for CLI routes; the schema leaves a non-CLI provider
segment opaque. An `API_KEY` route may legitimately name `openai`, which no entry
can declare. An **unconditional** equality would therefore make every non-CLI
daemon config unloadable and would silently delete the documented behaviour that
a route on another transport is refused by the port with `TRANSPORT_UNAVAILABLE`
at `route.transportKind` at the first effect. The unconditional rule was
considered and **declined** for that reason; the scoped rule is the decision.

### Why `CLI_ADAPTERS` keeps its string-indexed type

`CLI_ADAPTERS` stays `Readonly<Record<string, ProviderAdapter>>`. With
`noUncheckedIndexedAccess` the lookup is `ProviderAdapter | undefined`, so the
compiler **forces** the refusal branch to be written. Retyping the table to
`Record<ProviderName, ProviderAdapter>` would erase that branch and with it the
door's own defence — and the door needs one, because `startDaemon` accepts a
`DaemonExecutionConfig` **value** that never passed the parser. For the same
reason the lookup is guarded with `Object.hasOwn`: `CLI_ADAPTERS` is a plain
object, so an entry naming `constructor` would otherwise resolve to
`Object.prototype.constructor` rather than to `undefined` and slip past the
refusal.

## Why <the alternative> was not chosen

**Deriving the provider from the route** is the defect, restated as a design. It
reproduces exactly the vacuity this record removes: the port would again compare
a value against itself.

**Deriving it from the binary's basename or the configRoot's name** would make a
credential decision from a filename. A binding assembled from two places is a
binding nobody wrote down.

**Editing the port** was rejected outright. `ROUTE_INVALID`, `CliBinding` and the
three adapters are correct as written; what was wrong was the value the daemon
fed them. `packages/edges/providers/**` is untouched by this packet.

**Making the field conditional on transport** would give the config two shapes.
`execution.bindings` are CLI bindings by their own definition, and
`executionPortFor` only ever puts them in the port's CLI `bindings` map.

**A "no fallback" clause in the fence** was considered and declined: `??`, `||`
and default parameters are fallbacks and none is nameable by a text predicate.
That property belongs to the tests, which assert that an entry missing
`provider` is refused rather than filled from the route or from a sibling.

## What is honestly observable, and what is not

Only the routed entry is executed before the landing packet, so a non-routed
entry's provider has exactly **two** observable consequences, and the suite is
built on those two rather than on a stronger claim:

1. **The named refusal** now reports the provider the entry was admitted as, so
   a refused second binding in a mixed config says `codex` where a route-derived
   admission would have said `claude`.
2. **The port's guard becomes reachable through the daemon's own door.** A config
   handed to `startDaemon` as a value, whose routed entry disagrees with
   `route.provider`, now produces a binding whose adapter really differs from the
   route's, and the walk fails at the first effect. Before, the same config ran
   silently under the route's adapter and reached `CHECKPOINTED`.

**Three facts this record must carry, so no successor rediscovers them:**

- **Codex and kimi cannot execute through the daemon at this HEAD.** Their
  `describe` returns `delivery: { kind: "UNSUPPORTED", reason: "HANDSHAKE_REQUIRED" }`,
  `startSession` throws `AdapterError("PROTOCOL_UNSUPPORTED")` **before any
  spawn** — no process is created, no byte is written — and the port turns that
  into `TRANSPORT_UNAVAILABLE` at `startSession/PROTOCOL_UNSUPPORTED`. This
  packet does not lift that limitation and must not; it is why the codex half of
  the adapter-selection proof is an **honest refusal** rather than an environment
  file, and why the cross-provider landing inherits the fact rather than
  rediscovering it.
- **The breadth of the second fence predicate.** `/provider\s*:\s*route\.provider/`
  spans **all** daemon `src`, not only admission contexts. No planned successor
  writes that literal today, but a future lawful daemon object literal with that
  key — usage attribution is the obvious candidate — must either spell it
  differently or re-scope `L-F2B-1` **in its own packet**. The constraint is
  recorded here so it is known in advance rather than met as a red fence.
- **What a mid-walk port refusal is observable as.** A port refusal raised inside
  a walk reaches the scenario **ledger only as `TASK_FAILED` with
  `reason: "EXECUTION_FAILED"`** — the supervisor classifies `ExecutionEffectError`
  that way, and the `TASK_FAILED` payload carries a digest and a closed reason and
  **no exception message** — and reaches the **daemon log only as the error's
  name**, `ExecutionEffectError`, because the classifier falls back to
  `error.name` when the error has no `code` and `ExecutionEffectError` carries
  `refusal` and `at` but no `code`. `startDaemon` does not return the walk
  outcomes. The refusal names — `ROUTE_INVALID` at `route.provider`,
  `TRANSPORT_UNAVAILABLE` at `startSession/PROTOCOL_UNSUPPORTED` — are therefore
  proven **at port level**, by the providers suite and by the adapters' own
  `describe`, and **not** at daemon level. **Successors must not assert a
  by-name refusal from the daemon ledger or the daemon log.** The daemon-level
  evidence available to them is the ledger's shape (`TASK_FAILED` /
  `EXECUTION_FAILED`, no `CHECKPOINT_WRITTEN`) plus the subject's own evidence:
  echo file and environment file absent, and the pid file still holding the
  committed literal `"0"` — the fixture commits that file for every subject root
  before the daemon starts, so its **absence** was never assertable and must not
  be asserted.

## Consequences

- A mixed-provider config is now expressible and admitted: one route, one
  worktree, one credential root per account, and each account's own transport.
- Every existing daemon execution document must add `provider` to every entry.
  The child config is an internal artifact — no `contractVersion`, no wire, no
  producer outside this repository — so a required new key is a rewrite of
  fixtures, not a contract break. Nine suites and the CLI suite moved; the CLI
  suite is test-only and pins the passthrough over the shape the daemon actually
  accepts.
- The port's cross-provider guard stops being vacuous for daemon-built maps, and
  a daemon drill now reaches it.
- The composition fails **closed** on a provider it has no adapter for, naming
  the account, instead of quietly building an empty binding map.
- **No public pin moves.** `DaemonExecutionBinding` and `DaemonExecutionConfig`
  are not public exports of `@acp/daemon`; `DAEMON_PUBLIC_EXPORTS` stays 30,
  `CONTRACTS_SCHEMA_EXPORTS` 100, `PROVIDERS_PUBLIC_EXPORTS` 87,
  `RUNTIME_PUBLIC_EXPORTS` 234, `ACCOUNTS_PUBLIC_EXPORTS` 76, and `G1_MOVE_MAP`
  302. The public surface stays provider-neutral: the only new fact is *which*
  member of an existing, already-public vocabulary an internal daemon binding
  names.

## Not in this record

No quota pressure and no switching decision: `decideSwitch` and
`executeSwitchPlan` are untouched and still have no production caller. No
landing: nothing here opens a session on a second account or rehydrates a
checkpoint, and `ACCOUNT_SWITCH_COMPLETED` is still constructed nowhere. **No
codex or kimi execution is enabled** — their `PROTOCOL_UNSUPPORTED` refusal
stands exactly as it was, and no test seam was added to work around it. No edit
under `packages/edges/providers/**`, `packages/kernel/contracts/**`, any package
barrel, or any runtime, accounts, ledger, protocol, gateway, console or
durability path. No new event type, task state, wire schema, migration,
capability state, store or registry; no capability leaves `UNKNOWN`. No
credential material enters the config, which names a `configRoot` directory and
never a token, key or profile body. Nothing here spawns a real provider, opens a
socket, reaches a network or spends.
