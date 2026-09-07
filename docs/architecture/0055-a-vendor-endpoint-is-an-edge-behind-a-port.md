# ADR 0055 — A vendor endpoint is an edge behind a port

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

`emitTelemetry` (`packages/domains/observation/src/telemetry/index.ts:599`)
projects a ledger page into a neutral, redaction-gated `TelemetryBatch`. It has
zero callers in any `src/`, and `packages/domains/observation/README.md` said so
in as many words, adding that "a sink is owed to R11 and to the owner's
dependency answer, which the frozen dependency graph makes an owner decision
rather than a writer's".

Row 9 of the boundary audit carried the same shape as a gate: a
`TelemetryExporterPort` and an OTLP edge, blocked on an **owner dependency
authorization**.

**The owner ruling of 2026-09-07 dissolved the gate rather than granting it.**
The neutral contract is the authority and a vendor is an edge behind a port; no
vendor is required; and no dependency is authorized because none is needed. The
OTLP/JSON encoding is hand-rolled, on the precedent this repository already set
for MCP in B4b and for two provider wire protocols before that. **The absence of
a lockfile package delta is part of this packet's evidence**, not an accident of
it: `pnpm install` adds exactly two importer blocks and zero external packages.

Restriction 3 is what the packet is measured against: OTel/OpenInference as the
contract, a first backend that is optional and **whose falling over cannot
affect routing, execution or recovery**, and no vendor required. Restriction 5
governs what may be claimed afterwards: capabilities stay `UNKNOWN` until a
drill with a real subject, and that drill is owner-gated.

## Decision

**One new package, `packages/edges/telemetry`, declaring one dependency.** Six
source modules: a closed contract, an admission, a pure serializer, a transport,
a port and a barrel. `@acp/observation` is the only dependency and there is no
external package at all — no `@opentelemetry/*`, not even dev-only for "just the
types".

**The port takes `TelemetryBatch`, and the brand is the guarantee.**
`TelemetryEvent` is branded with `emitTelemetry` as its only mint site, so an
exporter typed on it is structurally incapable of receiving a record that did
not pass the redaction gate. A structurally-typed `ExportableSpan` declared in
the edge would have compiled, added no dependency edge, and quietly discarded
exactly that — which is the whole reason the alternative was rejected.

**The cost of that choice is declared rather than hidden.**
`@acp/observation` declares `@acp/ledger`, which declares `better-sqlite3`, so
the driver sits in this edge's **transitive** graph. `P1B_DEPENDENCY_LAW`'s
`forbidden` check is name-based over the manifest text, so the row still passes
and still means exactly what it says — this edge names no ledger and no driver —
but a reader should know the transitive reality before the row is read.

**The port stays in the edge.** It has exactly one agreeing party today,
whichever composition root constructs it, so promoting `TelemetryExporterPort`
into `@acp/contracts` would be a kernel widening nobody needs. This is the
`ToolProtocolPort` case letter for letter
(`packages/edges/tools/src/port/index.ts:14-20`): when a domain takes an
exporter by injection, that is the trigger to move the type, on purpose, in the
packet that creates the caller.

**Loopback plaintext only, and both halves are decisions.** The admission
accepts `http://127.0.0.1[:port]` and `http://[::1][:port]`. `localhost` is
refused **by name**, because resolving a name means DNS and a name that resolves
on-box today is a remote collector tomorrow. `https` is refused in R11 too: a
loopback TLS endpoint needs a trust decision this package cannot make honestly,
and plaintext to a literal loopback address on this host is what the restriction
authorised. A remote host and TLS would be this repository's first non-loopback
egress; they deserve their own argument, their own law and their own record. The
admission is the one file that would change, which is the point of putting the
decision there.

**Two authorities, each confined to one file by exact path.**
`src/admission/index.ts` is the only file that parses a URL, names a loopback
address or knows the traces path, and it joins the target exactly once.
`src/http/index.ts` is the only file that calls `fetch`, contains no URL literal
of any kind, and posts the admitted string verbatim: a transport that could
assemble a target could assemble a different one. Both directions are pinned —
every other file fails on a `fetch(`, and the fetch site fails if it stops
calling one, names a target, drops `redirect: "manual"` or drops its timeout.

**Sub-millisecond precision is preserved.** Epoch nanoseconds for any instant
after 1970 exceed `Number.MAX_SAFE_INTEGER` by two orders of magnitude, so
`Date.parse(iso) * 1e6` produces a `Number` that cannot represent the value
exactly and, worse, silently truncates the ISO fraction to milliseconds.
Timestamps are built as decimal digit strings through `BigInt`, with the
fractional digits read out of the string and padded to nine places. An instant
that does not parse is **counted** as unexportable, never written to the wire as
`NaN`.

**`scope.version` is not sent.** Every package in this repository is `0.0.0`,
and a version that carries no information should not be sent as though it did. A
collector reading `0.0.0` would conclude something false about what produced
these spans.

**Every span is `kind: 1`.** OTel's `SpanKind` and OpenInference's span kind are
different vocabularies; `openinference.span.kind` stays the attribute it already
is. Mapping `AGENT` or `TOOL` onto `SERVER`/`CLIENT`/`PRODUCER`/`CONSUMER` would
invent a correspondence neither convention states — the emitter's own naming law
applied one layer out: a conventional field filled with a value that does not
carry that meaning looks standard and is false.

**An event with no span context is dropped and counted.** `unexportableCount`
joins `refusedCount` and `unresolvedCausationCount` on the resource, because a
read model that silently dropped records would be indistinguishable from one
that had none to drop. **No synthetic id is minted**: one would collect every
degenerate event into a fictional trace, which the emitter already refuses by
name for the all-zero case.

**The ceilings are pinned data.** `OTLP_BODY_MAX_BYTES` is 4 MiB and is enforced
against the serialized body **before** the send, because a body over the ceiling
is a decision this edge makes rather than a verdict it asks a collector for. The
timeout lives on the admitted endpoint, defaults to 10 s and is capped at 30 s;
headers are bounded at eight, token-shaped keys and bounded values, and the
credential-shaped names are refused outright.

## Why the walk wiring is a separate packet

R11 is the port, the edge, the conformance against a scripted peer and this
record. Binding an exporter into the walk is R11b, and the split is a decision
rather than a deferral.

The emitter is page-scoped by law — "the signature takes contract values and
nothing else … so parentage is bounded by the page the caller passed"
(`telemetry/index.ts:592-597`). A caller must therefore decide the batch
boundary, the cadence, the backpressure, at-least-once against at-most-once, and
what happens to an unexported tail at shutdown. Those are a packet's worth of
decisions, not a tail on a serializer, and the page boundary is not plumbing:
`unresolvedCausationCount` is a direct function of it, so the wiring determines
how much of the causal tree survives.

Landing a port with no caller is also this repository's own established move.
`emitTelemetry` shipped that way, and R9, R10 and R9b each re-affirmed "no sink"
while moving the projection.

**The honest cost is stated.** An uncalled port is the deficiency the boundary
audit flags elsewhere — row 2 cites `CheckpointPort.read` as declared and
uncalled — and B5's own score moves less than the landing looks like. That is
accepted here in exchange for R11b's drill being written against a real exporter
rather than a stub of one.

## What R11 proves about restriction 3, and what it does not

Three mechanisms are proved, in increasing order of strength.

1. **The port never throws.** Six named refusals, exhaustively drilled against a
   scripted peer: a rejected connection, an abort, a `500` and a `404`, a `302`
   with a `location`, a batch with nothing exportable, and a body over the
   ceiling. Each returns `{ok: false, reason, at, receipt}` with the receipt
   populated on the failure branch, because a failed export still knows how many
   spans it would have sent.
2. **A failure is appended to nothing.** The package names no ledger in its
   manifest or its imports and calls `.append(` nowhere, and the fence asserts
   all three over `src` and `test` alike. Recording an export failure in the
   ledger would make a collector's availability part of the evidence chain.
3. **The import graph is the proof.** No production source in the repository
   names `@acp/telemetry` — a repository-wide fence law, not a scoped one — and
   `@acp/runtime`, `@acp/accounts` and `@acp/observation` forbid it by name in
   their manifests. "Removing the collector does not affect routing" is
   therefore a property a reader checks by reading the graph.

**What is OWED to R11b** is the assertion restriction 3 actually asks for: a
real walk driven end to end with the exporter bound to a dead endpoint, whose
resulting ledger chain is byte-identical to the same walk with no exporter at
all. It needs a caller, and there is none yet. Saying so here is the point;
gesturing at it would not be.

## Why the causal drill lives in the gateway

The serializer's unit evidence lives in this package, over typed literals
projected by the **real** `emitTelemetry` — nothing hand-builds a
`TelemetryEvent`, because the brand makes that impossible.

Its **causal** evidence cannot live here, and the reason is mechanism 2 above.
Driving `buildEvent`, `acquireLease`, `revokeLease`, `recordTokenObservation`,
`recordProviderPressure`, `executeSwitchPlan` and `settleFailure` over a real
disposable ledger requires `@acp/runtime` and `@acp/ledger`, which this package
forbids by name — and the `forbidden` check is over the raw manifest text, so
merely declaring them as devDependencies fails the row.

The first writer stopped on exactly that contradiction and wrote it down rather
than resolving it. **The DT adjudicated the drill into the gateway's
already-registered `telemetry` test-only domain**, where C1-C23 already drive
exactly those emitters over exactly such a ledger. The alternatives were
rejected on their costs: widening this edge's test surface would have narrowed
"the edge names no ledger" from whole-package to `src/`-only, retiring the
checkable half of mechanism 3; and abandoning causal fixtures for hand-built
ones would have abandoned the discipline that suite exists to embody.

The drill is C24-C28. It appends through the real emitters, reads the chain back
**out** of the ledger, projects it with the real `emitTelemetry`, and serializes
that batch with the real `serializeTelemetryBatch` imported from
`@acp/telemetry`. It asserts one `resourceSpans` and one `scopeSpans`; ids that
round-trip to the rows the ledger holds; `parentSpanId` absent on a root,
present on a resolved edge, and absent again on three switch events whose cause
is another task's real event; `status.code` 2 for a settled `TASK_FAILED`, 0 for
a `LEASE_REVOKED` whose cause the classification leaves unclassified, and 1 for
a clean step; and `intValue` as a JSON string carrying the spend the recorder
really wrote.

**The gateway gains one devDependency and one project reference.** No production
graph moves. `GATEWAY_TS_REFERENCES` and `GATEWAY_TS_ALIASES` are untouched: the
reference lands on the **test** project, whose references no law pins, and it
declares no path mapping.

## The nanosecond conversion was written red first

The naive implementation compiles, is deterministic, and passes every
parsed-object assertion. So the assertion is on the **raw request text**: a
quoted decimal string of exactly nineteen digits, no exponential notation
anywhere in the body, and the sub-millisecond digits present.

Neutralizing the conversion to `String(Date.parse(iso) * 1e6)` turns the
sub-millisecond assertion red — `1788685200123000000` where
`1788685200123456000` is owed. Neutralizing it to the barer
`Date.parse(iso) * 1e6` turns two red, adding the quoting: the body carries
`"startTimeUnixNano":1788685200000000000` with no quotes at all, which is
malformed OTLP. Both neutralizations were run and reverted, and the restored
file's SHA-256 equals the pre-edit one.

A fixture that cannot fail proves nothing, and the same discipline was applied
to the gateway drill: collapsing the three status codes to one and emitting
`parentSpanId` unconditionally turns C26 and C27 red. That probe also recorded
an operational fact worth keeping — the gateway project resolves this package
through its manifest to `dist/`, so a neutralization proves nothing until
`tsc --build` has run.

## Consequences

**`packages/domains/observation/README.md` had to change, because it became
false.** Its "No production sink exists" paragraph said the package "adds no
exporter, no port and no edge" and that a sink was owed "to R11 and to the
owner's dependency answer". Both clauses are discharged: the answer is *no
dependency*, and the port and the edge exist. The paragraph now says what is
true — the edge exists behind the port, `emitTelemetry` keeps zero callers in
any `src/`, and the wiring is owed to R11b. The R9b baseline paragraph beside it
was not reopened.

**Five new path-scoped laws, and one of them is repository-wide.**
`PATH_SCOPED_LAWS` and the `requireScope` call sites move 112 → 117 together.
The repository-wide one — no production source names `@acp/telemetry` — is
scoped to `src/` only, so the gateway's test naming the package is outside the
law's subject rather than excused from it.

**`PACKAGE_STRATA.edges` moves 3 → 4 and `TOPOLOGY_ACTIVE_TREES` 13 → 14**, in
the same commit that creates the package, on the convention those comments
already state: activating a tree later only buys a window in which the law did
not apply to it. `TEST_ONLY_DOMAINS.telemetry` registers `testing` for the
scripted peer, on the `tools` precedent, because a fake mirrors no source
module.

**`P1B_DEPENDENCY_LAW` moves 9 → 10 rows**, and three existing rows gain
`@acp/telemetry` in `forbidden`: runtime, accounts and the observation manifest
surface. A domain naming the exporter would put a vendor endpoint in the routing
plane's own graph, which is what mechanism 3 exists to refuse.

**The export record is pinned by law, not by prose.** `OTLP_EXPORT_RECORD` reads
`SOCKET_EXERCISED: "NONE"`, `LIVE_CONFORMANCE: "NONE"` and
`CAPABILITIES: "UNKNOWN"`, and the fence reads those three literals out of the
package README and compares them. Prose is how a claim drifts from a record
silently.

**No capability moved to CONFIRMED, and none could.** No socket is bound in any
test of this package: every drill substitutes `globalThis.fetch`. No real
collector has accepted these bytes. The drill against a real Phoenix instance
would establish that a collector answers 2xx, that the trace resolves into a
tree in its interface, that our attribute names render usefully and that the
OpenInference attribute is read the way we expect — and it is **owner-gated**
under law 8 and is explicitly not part of R11.

**`pnpm-workspace.yaml` was not touched.** The glob is `packages/*/*`, and no
catalog entry is needed because there is no external dependency. That absence is
the ruling's own evidence and is recorded here for that reason.

## Not in this record

**Langfuse stays.** ADR 0048:287-290 holds, restriction 3 still names it a
permitted pure translator, and its removal is a separately adjudicated,
worktree-only decision. Nothing under
`packages/domains/observation/src/telemetry/` was touched, the translator
included.

**No OTel semantic-convention key was added** beyond `service.name`, which is a
real resource key and is honest here. Everything else on the resource is
`acp.`-namespaced. The emitter's naming law governs the envelope too: a
conventional key is never filled with a value that does not carry that meaning.

**Nothing is adopted into operation.** This record lands a package and a set of
laws. Adoption is a single explicit decision after P8 certification and a
separate P9 authorization, and R11 is not it.
