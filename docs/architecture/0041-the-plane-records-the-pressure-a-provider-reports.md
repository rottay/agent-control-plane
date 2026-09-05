# ADR 0041 — The plane records the pressure a provider reports

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The plane could see a provider refuse an account and could not remember it.

`ProviderSignal` (`packages/edges/providers/src/contract/index.ts`) had six
kinds and none of them was pressure. Codex's own protocol schema names
`usageLimitExceeded` as one of seventeen error variants, and this repository
had vendored that schema and pinned the list — and `usageLimitExceeded` had
**no reader in any `src` tree**: the parser turned it into the state token
`ERROR_usageLimitExceeded` and nothing anywhere read the token back.

The one pressure the one executable provider can actually raise fared no
better. Claude's `{"type":"system","subtype":"auth_required"}` frame parsed to
`{kind:"authRequired", reason:"LOGIN_REQUIRED"}`, normalized to
`auth.required`, mapped to the `AUTH_REQUIRED_RAISED` frozen type, crossed the
owned boundary as an `ExecutionEvent`, and reached the walk's own trail. Then
the effects module drained that trail reading exactly one kind —
`if (event.kind !== "usage") continue`
(`packages/domains/runtime/src/execution-effects/index.ts`) — folded everything
else into `sha256(canonicalJsonStringify(trail))` and discarded it. The walk
settled at `CHECKPOINTED` exactly as if nothing had happened. **An account that
needed a human at a credential path was never recorded as needing one.**

Downstream, the consequence had a name. `AUTH_REQUIRED_RAISED`'s only `src`
producer was `decideSwitch`'s ESCALATE branch, and `decideSwitch`
(`packages/domains/accounts/src/switching/index.ts`) had **no production caller
at all** — its only other `src` occurrences were the accounts barrel and two
docblocks. Its entire input is a `SwitchTrigger`, and nothing in the plane
produced one. The switch executor said so in its own words at step 1
`MARK_ACCOUNT_DRAINING`: *"no event; the plan's `accountStatus` is never
appended here… Where that transition gets recorded is F4/F5's question."*

Two facts about reach shaped what could honestly be built. The auth half is
**live**: claude declares a `STDIN` delivery and executes through the daemon
today. The quota half is **dormant**: codex and kimi declare
`UNSUPPORTED/HANDSHAKE_REQUIRED`, and `startSession` throws
`PROTOCOL_UNSUPPORTED` before any spawn, so a real Codex `usageLimitExceeded`
cannot reach a real daemon walk until framing is authorized (ADR 0040).

## Decision

**The plane classifies what a provider said about an account's standing into
one neutral vocabulary, carries it to the walk, and records it once — against
the account and the provider that produced it — into the event vocabulary and
the task state that already exist. It decides nothing with it.**

The vocabulary is `PROVIDER_PRESSURES` in
`packages/kernel/contracts/src/schemas/execution-boundary/index.ts`, beside
`CLI_SUBSCRIPTION_PROVIDERS` and for the reason that file already gives — one
list, one home, no drift. It is **five members and not two**: `AUTH_REQUIRED`,
`QUOTA_EXHAUSTED`, `QUOTA_WARNING`, `TRANSIENT`, `UNCLASSIFIED`. The last two
are what make it structurally impossible for an unrecognised or merely-failed
frame to arrive at a quota destination: the classifier has somewhere honest to
put an utterance it does not understand, so "unrecognised" cannot be squeezed
into "quota" to make a table total.

**Classification is total; emission is narrow.** The Codex table answers for
all eighteen tokens — the schema's seventeen plus `unclassified` — and only the
two quota members construct a pressure carrier. `AUTH_REQUIRED` routes onto the
**landed** `authRequired` signal rather than a second carrier, and `TRANSIENT`
and `UNCLASSIFIED` construct nothing at all. `sessionBudgetExceeded` is
`TRANSIENT` and not quota: a session budget is a per-session ceiling this plane
sets, not the account's allowance, and reading it as quota would drain an
account over a limit of our own making.

**The shape carries no number and no instant.** No remaining count, no ratio,
no reset, no retry-after, no limit. "Never fabricate remaining quota" is
therefore a property of the vocabulary rather than a rule someone has to
remember — there is no field a fabrication could occupy — and
`ACCOUNT_QUOTA_UNPUBLISHED` and `RESET_UNKNOWN` remain the only answers to "how
much is left" and "when does it come back". `L-V2B1F4-1` holds the adapters to
it: no object literal carrying `kind: "pressure"` may contain a numeric member
or a `remaining` / `ratio` / `resetAt` / `nextResetAt` / `retryAfter` / `limit`
/ `tokens` key.

**No frozen event type was created, and none may be.**
`CONTROL_PLANE_EVENT_TYPES` stays 24 names and
`STREAM_CHANNEL_BY_EVENT_TYPE` stays a total function from 24 onto 5 channels;
a 25th moves the protocol, the console and `API_CONTRACT_VERSION`.
`QUOTA_EXHAUSTED` is therefore recorded **under the `QUOTA_WARNING` event type
with the classified kind in the payload** — which is not a compromise invented
here: `decideSwitch`'s own SWITCH branch already emits
`event("QUOTA_WARNING", {accountId})` for an exhaustion.

**The provider recorded is the adapter's own.** The `pressure`
`ExecutionEvent` member carries a `provider`, filled by the port from
`normalized.provider` — the value `session/index.ts` sets from
`adapter.provider`, which post-ADR 0040 comes from the binding's own declared
provider. It is carried, never re-derived. **`L-F2B-1`'s second predicate was
met in advance by spelling the daemon literal differently**: the sink closure
in `packages/entrypoints/daemon/src/index.ts` spells
`provider: sample.provider`, never `provider: route.provider`. ADR 0040 asked a
successor to know that constraint rather than discover it; this is that
successor, and the law is neither re-scoped nor widened.

An `authRequired` event carries no provider — it is a landed contract member,
and widening it would bind the two structural chunk pass-throughs in
`api-key` and `local` to its exact shape forever — so for that kind the effects
module supplies `input.route.provider`. That is not a guess: `startExecution`
refuses `ROUTE_INVALID` at `route.provider` when
`binding.adapter.provider !== admitted.provider`, **before** `startSession`, so
for any session that produced an event the route's provider *is* the adapter's.
The sample and observation types spell that field as
`ResolvedRoute["provider"]` — a bounded string, not the CLI union — because the
API and local transports already put `authRequired` on the trail under an
opaque provider segment, and narrowing would silently drop those observations:
a fail-open on evidence in the one module built not to lose it.

**The recorder is a same-state passthrough that never opens a task.**
`packages/domains/runtime/src/pressure/index.ts` is built to the exact shape of
`recordTokenObservation`: it reads `ledger.getTask` first and throws if the
task is unknown, sets `fromState = toState = task.currentState` read from the
ledger, takes its coordinates from `deriveEventCoordinate` with no clock and no
random source, and builds its payload field by field as
`{accountId, provider, pressure}` — three safe scalars, none of which
normalizes into the contract's `DENIED_KEYS` or ends in a `DENIED_KEY_STEMS`
stem. Observing pressure moves no lifecycle state: **entering `QUOTA_BLOCKED`
is `decideSwitch`'s call and F4b's append, never this recorder's.** No
`AccountActionEvent` is appended either — an observed provider refusal is not
an operator act, and recording it as `DRAIN` would forge a human decision.

**The durable name is the trail position.**
`pressureTransitionId(operationIndex, trailIndex)`, never a provider-reported
ordinal. The landed usage recorder derives its name from the `stepIndex` the
adapter reported and Codex hardcodes that to `0`, so two usage frames in one
operation from such a provider would collide on one idempotency key and the
second append would be a silent replay — under-counted spend. That defect is
unreachable today, is named here, and is left to its own packet; this recorder
does not copy the shape. A resumed attempt rebuilds the identical name, so the
second append is a replay; two *different* frames in one stream get two trail
positions and two rows.

**The sink runs before the evidence marker**, synchronously, in the same window
as the spend sink and for the same reason: `closeIntent` probes first and never
re-enters `apply` on a verified marker, so a sink after the marker would be
permanently unreachable on exactly the resume path it exists to cover. A
throwing sink leaves no marker, the probe answers `NOT_DONE`, and the effect
re-executes. `L-V2B1F4-2` asserts the ordering; `L-V2B1F4-3` asserts that
**every** `createExecutionEffects` seam in the production daemon passes a sink
and that the file reaches the recorder — written in `L-C-4c`'s per-seam shape
rather than `L-B7T-2`'s `indexOf`, which checks only the first of the two.

**The two vocabularies stay two.** `SWITCH_TRIGGERS` is not merged into
`PROVIDER_PRESSURES`: one is an observation vocabulary and the other a decision
vocabulary, and `AUTH_REQUIRED`, `TRANSIENT` and `UNCLASSIFIED` are lawful
observations that must never be triggers — `isTrigger`'s fail-closed guard *is*
that boundary. What must not drift is the overlap, and `L-V2B1F4-4` asserts the
two quota members are spelled identically on both sides, in both directions,
because the fence is the only place that can read both files.

**Claude and Kimi get no quota row, and the emptiness is mechanical.** Claude's
`result.subtype` is an open token and kimi names exactly one code, so neither
holds evidence for an allowance classification. `L-V2B1F4-5` forbids a
`kind: "pressure"` constructor in either adapter, so the packet that acquires
that evidence moves a law on purpose rather than adding a row quietly.

**A landed reservation was narrowed, on the record.**
`packages/edges/providers/test/events/index.test.ts` asserted that no
`FROZEN_TYPE_BY_EVENT` value matched `/^(COMMIT_|LEASE_|QUOTA_)/`, under the
title *"claims no commit, lease or quota type — those are P5 and P6"*. Those
phases have been reached and this packet earns the type, so the commit and
lease reservations stay exactly as they were and the quota reservation becomes
an equality against a single expected pair: `quota.pressure → QUOTA_WARNING`,
**one** quota type, and it is an observation of pressure rather than a switch
decision. A *second* quota type still fails there.

## Why the switch decision was not made here

`decideSwitch` needs a `RoutingRequest` — records, estimates, evidence, task,
config, now. The walk holds none of it and is forbidden it twice over:
`DAEMON_ALLOWED_PACKAGES` does not contain `@acp/accounts` (*"a daemon source
naming it would be a daemon that resolves, which D5 refused"*), and `L-B7S`
bans `@acp/accounts`, `resolveRoute`, `loadPolicyRegistry` and
`composeSubmission` across every daemon production source.
`DaemonExecutionConfig` is `{route, bindings}`: no `AccountRecord`, no
`QuotaOutcome`, no evidence row, no policy, no clock.

Doing both at once would require either widening the daemon's import allowlist
— reversing D5 and ADR 0018 — or shipping a snapshot of the routing state into
the daemon config, whose staleness is a fail-open the first time an account
changes state mid-walk. The split is forced by the topology rather than chosen
for size: **this record's packet records; its successor decides**, in the CLI's
re-election verb or the gateway's account-actions door, where the routing state
already is.

## Why merging SWITCH_TRIGGERS into the observation vocabulary was not chosen

It would delete the boundary the two sets exist to draw. `isTrigger`'s
fail-closed guard is what stops an auth requirement or a transient failure from
moving a task; collapsing the vocabularies makes every observation a candidate
trigger and leaves nothing to guard. Re-pointing `SwitchTrigger` at
`Extract<ProviderPressure, "QUOTA_*">` was considered as the milder form and
declined too: it still restates the two names, it moves
`ACCOUNTS_PUBLIC_EXPORTS`, and it erases the observation/decision distinction
in the type rather than in the prose.

## Why the chunk unions were not widened

`ApiStreamChunk` and `LocalChatChunk` were in an earlier draft of this packet's
write-set and were dropped on measurement. Both mappers assign every
non-`started` chunk **structurally** into `ExecutionEvent` (`: chunk`), so
adding the member would bind two chunk unions and one contract member to the
same shape forever — including on `provider` — for a transport where no client
ships, no classifier lands and nothing can produce the member. A narrower union
assigned to a wider one still typechecks, so nothing forced it. Under ADR
0010's posture, declaring a capability nothing can produce is nearer overclaim
than honesty.

## Why the provider was not attributed from the binding in the daemon

`bindingForRoute(execution).provider` is in scope at both construction sites
and would give the same value lawfully. It was declined because it is a
**second** reading of a fact the trail already carries, taken at a different
layer from the one that classified it. One reading, one provenance: the
provider travels with the classification from the adapter that made it.

## Why a pressure signal is not emitted for every classified member

Letting the recorder drop `TRANSIENT` and `UNCLASSIFIED` would put events on
the trail that no reader will ever use, and would make the fail-closed default
"a signal that means nothing" instead of "no signal". The filter is written
once, at the one named construction site, and the tests assert both halves: the
table stays total, and the emission stays narrow.

## Why a companion type was not exported from the contracts

`PROVIDER_PRESSURES` is exported as a bare list with no companion type, exactly
as `CLI_SUBSCRIPTION_PROVIDERS` is, and each consumer spells the union locally
from it — the precedent ADR 0040's `daemon-child` alias set. That is why
`CONTRACTS_SCHEMA_EXPORTS` moves by one and not two.

## Consequences

**What the plane can now say that it could not.** An account can be named as
having been refused, with the provider that refused it, at the moment it
happened, in the ledger. `AUTH_REQUIRED_RAISED` acquires a producer that is not
an uncalled ESCALATE branch. `decideSwitch`'s `trigger` field acquires, in the
successor packet, something real to be derived from.

**The rows reach the observation edge, and that is intended.**
`packages/domains/observation/src/telemetry/index.ts` lists
`AUTH_REQUIRED_RAISED` among its OTel error types and promotes `accountId` and
`provider` — not `pressure` — to span attributes. So an auth row surfaces as an
error-status span carrying the account and the provider, and a quota row as an
ordinary span; both types map to the `execution` stream channel and reach the
gateway stream that already carries them. No schema moves for this, and no
rollup folds a pressure row in this packet.

**The rows are facts about instants, not standing state.** They are
append-only, per-frame and coordinate-addressed; nothing is written to
`AccountRecord`, and `lastClassifiedError` — the one field shaped like a
standing answer — deliberately still has no producer. Every row carries
`occurredAt`/`recordedAt` from `deriveEventCoordinate`, which sets both to
`invocation.submittedAt` with `origin: "DERIVED"`: **the submission instant of
the walk, not of the frame**, so staleness is answerable at walk granularity
and ordering within a walk is the ledger's own `sequence`. How old a
`QUOTA_EXHAUSTED` row may be before it stops meaning anything is a routing
judgement, and routing judgements live in `@acp/accounts`, which the walk may
not name. The obligation discharged here is the narrower one: not to make
staleness unanswerable.

**During the window between observation and decision the account keeps taking
work.** No `AccountStatus` moves; `AVAILABLE` stays `AVAILABLE` until an
operator acts or a plan is played. That is a deliberate fail-open on scheduling
and a fail-closed on evidence, and it is the correct trade for a recording
packet: the alternative is a walk that drains an account on its own authority,
which is the elector-inside-the-walk that D5, ADR 0018 and `L-B7S` refuse.

**Replay is exact-bytes-only, and that exposure is inherited.** The ledger
replays a repeated idempotency key only when the event is byte-identical and
throws `LedgerIdempotencyConflictError` otherwise. So a re-executed attempt
whose provider said something *different* at the same trail position conflicts
rather than replays — the same exposure the landed usage recorder carries,
inherited rather than introduced.

**A crash between the execution and the marker loses that execution's
observations**, exactly as it loses that execution's spend. The invariant this
buys, stated no louder than it is: a verified evidence marker implies the
pressure on that trail was recorded. It never records pressure for work that
did not happen.

**The quota half is dormant in production, and this record says so rather than
leaving a reader to discover it.** Codex and kimi stay refused at
`startSession` with `PROTOCOL_UNSUPPORTED` until framing is authorized (ADR
0040), so a real Codex `usageLimitExceeded` cannot reach a real daemon walk.
The end-to-end daemon evidence for this packet is therefore the **auth** half,
on the shipped Claude parser over the shipped wire format; the quota half is
proven at adapter, normalizer, mapping-function and recorder level. "Port
level" here means `toExecutionEvent` called directly with a hand-built
normalized event, because a live codex session is unreachable even in a test —
the scripted adapter keeps the base delivery. No test seam was added around
that refusal, and none may be.

**Pins.** `CONTRACTS_SCHEMA_EXPORTS` 100 → 101, `PROVIDERS_PUBLIC_EXPORTS`
87 → 88, `RUNTIME_PUBLIC_EXPORTS` 234 → 239, `PATH_SCOPED_LAWS` 98 → 103, the
ADR corpus 40 → 41. The scope counts the fence prints move because a new
runtime source lands inside them: `L-B1F-1`/`L-F3-1` 133 → 134,
`L-V2B1D-1`/`L-V2B1E-1` 122 → 123, tracked package files 416 → 418 — none of
the three is an asserted pin. `CONTRACT_VERSION`, `API_CONTRACT_VERSION`, the
24-name event vocabulary, the 24 → 5 channel map, `ACCOUNTS_PUBLIC_EXPORTS`,
`DAEMON_PUBLIC_EXPORTS` and every migration are unmoved.

## Not in this record

**The switch decision itself** — no `decideSwitch` caller, no
`executeSwitchPlan` caller, no `RoutingRequest` composition, no CLI verb, no
gateway route. **The landing** — no session opened on a second binding, no
checkpoint rehydrated (`CheckpointPort.read` stays declared and uncalled), no
`ACCOUNT_SWITCH_COMPLETED`. **The codex/kimi handshake** that would make either
reachable through the port: it is evidence, not a defect to repair. **The
`usageTransitionId` step-index collision**, named above and left to its own
packet. **Rollups or projections over pressure rows.** **Any UI, console,
protocol or API surface.** **The six F3 advisories and F2b's A2**, including
`L-F3-2`'s widening, which shares `L-F3-1`'s printed scope and belongs to a
fence-hygiene errata packet. No new event type, task state, account status,
account action, wire schema, migration, capability state, store or registry —
and no capability moves from `UNKNOWN`.
