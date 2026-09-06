# ADR 0048 — Telemetry reads the route the walk writes

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

Law 9 of the P8 addendum fixes an order of dependence: observability emits
neutral events first, shaped to the OpenTelemetry and OpenInference
conventions, and no observability vendor is ever required for routing, recovery
or evidence. `emitTelemetry` is the neutral half, and the old-V2 draft asks for
those conventions "como contrato" (`.acp-local/v2-roadmap-draft.md:77-78`,
restriction 3 at `:37-39`).

The projection was not holding up its half of that contract, and the gap was
not a matter of degree. Seven separate findings, each measured at the source:

**The route was written nested and read flat.** The INTENT beat is the sole
writer of a route, and it writes it under one pinned payload key
(`runtime/src/core/events/index.ts:85`, `:127-140`). `PAYLOAD_ATTRIBUTES` read
nine FLAT payload keys. `RUN_STARTED` is the one event that carries a model, a
provider, a transport kind and a capability policy version, and the projection
emitted none of them: `gen_ai.request.model` and every `acp.route.*` attribute
were absent from every production chain that has ever run.

**Three of those flat keys had no writer at all.** `model`, `transportKind` and
`capabilityPolicyVersion` are only ever written nested. `verdict` has one
producer, `authorizeCommit`, which has zero callers in any `src/`.

**One of them was not a control-plane payload key.** `resolvedModel` is a field
of the provider contract (`execution-boundary/index.ts:260-266`), never of
`ControlPlaneEvent`. It also targeted the same attribute as `model`, so had
both ever been present the later entry would have silently overwritten the
earlier one.

**The token count carried a key whose meaning it did not have.**
`gen_ai.usage.output_tokens` names output tokens. The daemon writes whichever
count arrived into one key: the Claude adapter reads `usage.output_tokens`, the
Codex adapter reads a **total** (`providers/src/codex/index.ts:399-401`), the
Kimi adapter reads an unspecified `_meta.tokensUsed` (`kimi/index.ts:215-219`).
`TOKEN_USAGE_RECORDED.payload` is `{accountId, tokens}` and carries no provider,
so the projection could not branch per provider even if a neutral projection
were allowed to.

**Two entries of the error vocabulary named nothing.** `TASK_QUARANTINED` and
`COMMIT_REFUSED` are not members of the frozen 24-type vocabulary
(`contracts/src/schemas/control-plane-event/index.ts:20-65`), so no event could
ever have selected them. Meanwhile `WRITE_SET_VIOLATION_DETECTED` — which is
produced in production, and means a walk wrote outside its declared set — was
absent from that list and reported `OK`.

**Every clean walk ended in an `ERROR` span.** `LEASE_REVOKED` was an error on
every revocation, and a clean walk ends by releasing its lease with
`cause: "RELEASED"` (`daemon/src/index.ts:694`, `:1121`). A lawful account
switch revokes with `cause: "ACCOUNT_SWITCH"` (`switch-executor:329`). The
projection reported both as faults.

**A tool-call receipt was stamped `AGENT`.** `TELEMETRY_SPAN_KIND` was applied
to every event including `TOOL_CALL_RECORDED`, which is the one event
OpenInference names a `TOOL` span.

Underneath all seven sits one fact that shapes what this record may decide:
`emitTelemetry` has **zero production callers**, and the consumer the draft
names — an optional exporter — is owner-gated under adjudication C1
(`v2-roadmap-draft.md:136-142`). A defect nothing calls is still a defect, but
the repair cannot be validated by pointing at a caller.

## Decision

The projection reads the route where the walk writes it, names the token count
after what it actually is, classifies status from the event rather than from
its type alone, and stamps a tool call as a tool call. The full attribute
surface after the change:

| Attribute | Source | Emitted on |
| --- | --- | --- |
| `acp.task.id` | `event.taskId` | every event |
| `acp.task.attempt` | `event.attempt` | every event |
| `acp.event.type` | `event.type` | every event |
| `acp.event.transition_id` | `event.transitionId` | every event |
| `acp.task.state.to` | `event.toState` | every event |
| `acp.task.state.from` | `event.fromState` | every event with a prior state |
| `acp.worker.identity` | `event.emittedBy` | every event |
| `openinference.span.kind` | the span-kind table | every event |
| `acp.initiative.id` | `payload.initiativeId` | `TASK_DISCOVERED` |
| `acp.account.id` | `payload.accountId`, or `route.accountId` | usage, pressure, switch, tool receipt; and any event carrying a route |
| `acp.pressure.provider` | `payload.provider` | the pressure recorder's events |
| `acp.usage.tokens` | `payload.tokens` | `TOKEN_USAGE_RECORDED` only |
| `gen_ai.request.model` | `route.model` | any event carrying a route |
| `acp.route.provider` | `route.provider` | any event carrying a route |
| `acp.route.transport_kind` | `route.transportKind` | any event carrying a route |
| `acp.route.capability_policy_version` | `route.capabilityPolicyVersion` | any event carrying a route |

The route is parsed through `ResolvedRoute.safeParse` and the five identifying
fields are promoted. `resolvedAt` is not promoted: the instant a route was
chosen at is not an identifying field. **A route that does not parse projects
zero route attributes and raises no refusal** — the same allocation of duties
the ledger's own route projection makes (`ledger/src/projection/index.ts:189-213`):
refusal belongs at the producer, and a projection that refused would either
disown history the log accepted or mis-signal a redaction failure that did not
occur. The event's own attributes still emit.

`gen_ai.request.model` is honest for `route.model`, because the contract calls
that field "the routing alias the DT scheduled against, not the provider's
exact resolution" (`execution-boundary/index.ts:222`), which is exactly OTel's
request-side model. **`gen_ai.response.model` is absent by construction**: the
provider's own `resolvedModel` is a field of a different contract and never
reaches the ledger, so there is no source for it and no event on which it could
be emitted.

Two provider attributes, because there are two facts. `acp.route.provider` is
the provider the route named. `acp.pressure.provider` is the provider that
reported pressure, as the adapter classified it — the daemon deliberately
passes the adapter's own classification there and not `route.provider`
(`daemon/src/index.ts:1237-1243`), so emitting it as a route attribute would
assert a route its event does not carry. The `pressure` payload key itself is
not promoted.

**Status is a function of the event.** The table is stated here in full so the
classification is a written rule rather than a reading of the code:

| Event | Status | Why |
| --- | --- | --- |
| `TASK_FAILED`, `AUTH_REQUIRED_RAISED`, `WRITE_SET_VIOLATION_DETECTED` | `ERROR` | produced in production; each is a fault |
| `LEASE_REVOKED` with `payload.cause` in {`WRITE_SET_VIOLATION_DETECTED`, `HOLDER_DEAD`, `EXPIRED`} | `ERROR` | the three fault causes production writes (`enforcement:596`; `arbiter:389`) |
| `LEASE_REVOKED` with `cause` in {`RELEASED`, `ACCOUNT_SWITCH`} | `OK` | a clean walk's end (`daemon:694`, `:1121`) and a lawful switch (`switch-executor:329`) are not faults |
| `LEASE_REVOKED` with any other or absent `cause` | `UNSET` | `cause` is typed `string` (`enforcement:418`), not an enum; an unknown cause is unclassified, and `UNSET` is the OTel status for exactly that |
| `TASK_STATE_CHANGED` with `toState === "SUSPECT_WORKTREE"` | `ERROR` | this is what the dead `TASK_QUARANTINED` literal meant; quarantine is a state change (`daemon:1542`), and the truthful replacement classifies on the state |
| `TASK_CANCELLED`, `QUOTA_WARNING`, every other type | `OK` | a cancellation is an outcome, a warning is a warning; OTel `ERROR` is not "not-success" |

Both cause sets are frozen and **unexported**, so no export name moves and the
fence's surface pin does not shift. `TASK_QUARANTINED` and `COMMIT_REFUSED` are
deleted from the table; neither is minted into the event vocabulary, which
stays at 24 members.

**The span kind is a per-type table with a default.** `TOOL_CALL_RECORDED` maps
to `"TOOL"`; every other type takes `TELEMETRY_SPAN_KIND`, which keeps both its
name and its value `"AGENT"`.

**The fence gains a third `RECORDED_ROUTE_KEY` declarer, and proves it.** The
law "the recorded route travels under one pinned key" pinned two declarers, the
producer and the ledger projection, and compared their literals. The telemetry
module is now the third: it declares the key, and a **reader arm** asserts it
genuinely contains `payload[RECORDED_ROUTE_KEY]` and `ResolvedRoute.safeParse(`,
mirroring the arm the ledger projection already has. Naming `"route"` inline
here to stay outside the law would be exactly the drift the law exists to
refuse. The law's row and its single scope call are unchanged, so the
path-scoped register does not move.

**The causal drill lives in the gateway**, at
`packages/entrypoints/gateway/test/telemetry/index.test.ts`, registered in
`TEST_ONLY_DOMAINS.gateway` beside `parity` because it tests an agreement
between two packages the gateway already depends on, not a gateway module. It
drives the real emitters, appends to a real disposable ledger, reads the events
back out of that ledger and only then projects them. The one build-graph
declaration is a project reference in the gateway's **test** tsconfig, whose
`references` are not fence-pinned. Zero manifest, lockfile or dependency-graph
change. The drill reaches the two contract types it needs through the two
packages the gateway does depend on, because this package may not name the
contracts package in `src` or in `test`, and the fence enforces that.

## Why not `gen_ai.usage.output_tokens`

Because it is false for two of the three adapters, and the event carries no
provider to branch on. Keeping a conventional key filled with a value that does
not have that key's meaning is the same class of mislabel this record removes
everywhere else: it looks standard, and a reader who trusts the convention
reads a total as an output count. Branching the key per provider was the third
option and is rejected on its own terms — per-vendor semantics in a projection
whose whole purpose is neutrality — but it is also structurally unavailable,
since `TOKEN_USAGE_RECORDED.payload` is `{accountId, tokens}` and holds no
provider at all.

`acp.usage.tokens` is the honest name. It says the count is ours, and the
module documents it as "the count the adapter reported; its provider-specific
meaning is not normalized". A key under `acp.` makes no promise the value
cannot keep.

## Why not `gen_ai.system` or `gen_ai.provider.name`

Two independent reasons, and either alone is sufficient.

The key has been superseded. This record is written against the OpenTelemetry
semantic conventions for generative AI at **v1.36.0**, in which `gen_ai.system`
is replaced by `gen_ai.provider.name`. That version is recorded here as a
documentary pin and nothing more: this repository depends on no OpenTelemetry
package, so there is no resolvable version for a fence to check, and a later
reader should treat the number as the state of the conventions this record was
reasoned against rather than as a dependency.

The second reason needs no external version at all, and is checkable in this
tree. The convention's well-known values are **vendor** identifiers —
`anthropic`, `openai` and the like. `route.provider` is an **adapter**
identifier: `claude`, `codex`, `kimi`, the members of
`CLI_SUBSCRIPTION_PROVIDERS` (`execution-boundary/index.ts:47`). Mapping one
onto the other requires a per-vendor table, which is the per-vendor semantics a
neutral projection refuses to hold, and which ADR 0034 defers by name for
exactly Codex and Kimi. The provider travels as `acp.route.provider`, which is
truthful without a table.

## Why not a production caller

Because there is no lawful one in this packet. The designed consumer is the
optional exporter, and that is a new port, a new edge package and a new
dependency — owner-authorized first, under adjudication C1
(`v2-roadmap-draft.md:136-142`). No entrypoint can reach `emitTelemetry`
without either a graph change or a new product surface: the CLI does not depend
on this package, and a gateway caller would mean a new route, a protocol
response schema and a contract-version consequence, which the draft's own
ordering puts after the work that is not yet done. A caller manufactured to
satisfy a "has a caller" criterion would be scope invention, and would export a
read model to a surface nobody asked for.

So the packet's honesty comes from causality rather than from a call site, and
that is a stronger standard rather than a weaker one: the real emitters are
driven, their real appended events are read back out of a real ledger, and
those events are what the projection is asked to explain.

## Why not the drill inside the observation package

Because it would buy a test with a real dependency edge. `@acp/runtime` is in
neither `OBSERVATION_ALLOWED_PACKAGES` nor `OBSERVATION_TEST_ONLY_IMPORTS`, and
the package's manifest law pins its devDependencies to `vitest` alone. Hosting
the drill there means adding a workspace edge, moving the manifest law and
touching the lockfile — for a test. The gateway already depends on both
packages the drill needs, so hosting it there costs one project reference in a
tsconfig whose references nothing pins.

## Why not the baseline in this record

Because it is a different projection with a different defect, and folding it in
would either ship a change nothing could observe or grow this packet past its
subject. `computeBaseline` demands three payload fields no production emitter
writes and throws `MISSING_REASON` at event index 1 of any real chain, so
repairing the token measure alone would move nothing a reader could see. The
honest repair changes public baseline members, retires three public stop
reasons and adds two source paths — a packet of its own. It is named and owed
below rather than half-done here.

## Consequences

Every attribute this projection emits is now either read off the contract's own
fields or read through a contract parser, and there is no entry in the surface
whose writer cannot be named. The seven findings above are closed as
behaviour, and the drill's negative controls make three of them permanent: an
absolute worktree path still cannot leave, a field production never writes
still projects nothing rather than `"unknown"`, and a malformed route still
projects nothing without a refusal.

The costs are real and worth stating. `TELEMETRY_ATTRIBUTE_KEYS` changed
several of its **members**, and the vendor translator forwards attributes
verbatim, so any consumer that had learned the old key names sees new ones —
acceptable precisely because there is no production consumer, and cheap now in
a way it will not be after R11. The route attributes are emitted on any event
whose payload carries an admissible route, which today is the INTENT beat
alone; an emitter that later records a route on another event will emit them
there too, without a further decision, which is the behaviour the allowlist
model implies. `acp.account.id` now has two possible sources and the route wins
when both are present, which is deterministic and stated, not silent.

The fence carries a third declarer of one payload key, so a fourth reader is a
deliberate edit rather than a quiet one. And the drill is the first gateway
test registered as a test-only domain besides `parity`, which sets the shape a
later agreement drill should follow.

## Not in this record

**No production sink.** R9 aligns the keys and adds no exporter, no port and no
edge. A sink is owed to R11 and to the owner's dependency answer (draft
`:136-142`). The projection keeps zero production callers, and that is a
declared state rather than an unnoticed one.

**Baseline totality is owed to R9b**, with this shape: the token measure read
from `TOKEN_USAGE_RECORDED.payload.tokens`, the row `rollups/index.ts:130-138`
already reads; `reason` and `verdict` absent-tolerant with explicit unreported
counts, because a fold that skipped silently would let its zero counts lie; and
`MISSING_REASON`, `MISSING_TOKENS_USED` and `MISSING_VERDICT` retired or
documented as reachable from synthetic chains only.

**The `pressure` kind and any reservation attribute are not decided here.** The
pressure vocabulary (`AUTH_REQUIRED`, `QUOTA_WARNING`, `QUOTA_EXHAUSTED`) is
written to the ledger and not promoted; a reservation attribute is not minted
because no production emitter writes a reservation. The smallest truthful
packet is the goal, and truthfulness does not require completeness.

**The trace tree** — `correlationId`, `causationId` and `eventId` as parent and
span identity — is R10's, not this record's. **Langfuse stays**: the translator
forwards attributes verbatim, so every change here lands in the vendor shape
without an edit, and its removal is separately adjudicated.
