# `@acp/telemetry`

The telemetry export edge. One hand-rolled OTLP/JSON serializer behind a port,
posting to one admitted loopback endpoint, refusing by name and appending to
nothing.

## Scope

This package turns a `TelemetryBatch` — the neutral projection
`@acp/observation` already produces — into an OTLP/JSON trace request and posts
it. That is the whole scope. It decides nothing about what is worth exporting,
holds no schedule, batches nothing over time, and reads no configuration: an
endpoint is handed to it, already admitted, by whoever composes it.

Nothing here is adopted into real operation. Adoption is a single explicit
decision that happens after P8 certification and a separate P9 authorization.

## No vendor is required, and none is depended on

The neutral contract is ours and the vendor is an edge behind a port. That is
the owner ruling of 2026-09-07 restated as a dependency graph: this package
declares exactly one dependency, `@acp/observation`, and **no external package
at all**. There is no `@opentelemetry/*` here, not even dev-only for "just the
types".

The OTLP/JSON encoding is therefore hand-rolled, on the precedent this
repository already set for MCP and for two provider wire protocols. The
encoding is `resourceSpans[] → scopeSpans[] → spans[]` and six mapping
decisions; an SDK would have brought a transport, a batcher and a clock, every
one of which this edge refuses on purpose.

**The specification was cited, not vendored.** `SPEC_MANIFEST_DIGEST` is `NONE`
because no protocol bytes were placed on disk, so there is nothing to digest
and this serializer's constants are asserted against no manifest.
`SPEC_CITATION` names the encoding, the specification URL and the retrieval
date instead. That is the weaker of the two footings this repository defines,
and it is stated rather than left to be inferred.

## What was and was not established

`OTLP_EXPORT_RECORD` is the machine-readable half of this section, and the
fence asserts that the two cannot disagree — it reads the three lines below out
of this file and compares them against the record.

- `SOCKET_EXERCISED: "NONE"` — no socket is bound in any test of this package.
  Every drill substitutes `globalThis.fetch` with a scripted peer. That is a
  ruling rather than a convenience: `node:http` and `node:net` are banned
  across this package's `src` **and** `test` and would have to be weakened to
  do it any other way, and this repository has twice recorded that undici
  `fetch` is intermittent against loopback inside a Vitest worker.
- `LIVE_CONFORMANCE: "NONE"` — no real collector has ever accepted these bytes.
  R11 proves the serialization against the published OTLP/JSON shape and the
  refusals against a scripted peer, and it proves nothing about any real
  collector.
- `CAPABILITIES: "UNKNOWN"` — restriction 5, and the owner ruling with it:
  CONFIRMED only from a drill with a real subject. That drill is **owner-gated**
  and is explicitly not part of R11. What it would establish, when authorized:
  that a real collector accepts the payload with a 2xx, that the trace resolves
  into a tree in its interface, that our attribute names render usefully, and
  that the OpenInference attribute is read the way we expect.

## What R11 does not do, said rather than left to be inferred

**Nothing calls this.** `emitTelemetry` keeps zero callers in any `src/`, and
so does this package: no domain, no entrypoint and no edge names
`@acp/telemetry`, and the fence asserts that over every production source in
the repository. Wiring the exporter into a walk is R11b, and it is a packet's
worth of decisions rather than a tail on a serializer — batch boundary,
cadence, backpressure, at-least-once against at-most-once, and what happens to
an unexported tail at shutdown. The page boundary is not plumbing: it
determines how much of the causal tree survives, which is why
`unresolvedCausationCount` travels.

**The dead-endpoint walk drill is owed to R11b.** The assertion restriction 3
actually asks for — a real walk driven end to end with the exporter bound to a
dead endpoint, whose resulting ledger chain is byte-identical to the same walk
with no exporter at all — needs a caller, and there is none yet. What R11 does
prove instead is in the next section.

**The port stays in this package.** It has exactly one agreeing party today,
whichever composition root constructs it, so promoting `TelemetryExporterPort`
into `@acp/contracts` would be a kernel widening nobody needs. The moment a
domain takes an exporter by injection, that is the trigger to move the type —
on purpose, in the packet that creates the caller.

## What R11 does prove about restriction 3

Three mechanisms, in increasing order of strength, and all three are checked
rather than described.

1. **The port never throws.** Every way a request can fail is caught and
   classified into one of six named refusals, and `export()` returns
   `{ok: false, reason, at, receipt}`. A caller that ignores the return value
   has already got the behaviour restriction 3 asks for.
2. **A failure is a value and a counter, and is appended to nothing.** This
   package names no ledger — not in its manifest, not in its imports — and
   calls `.append(` nowhere. Recording an export failure in the ledger would
   make a collector's availability part of the evidence chain, which is the
   precise thing law 9 and restriction 3 exist to prevent.
3. **The import graph is the proof, not the prose.** No production source in
   this repository names `@acp/telemetry`, and `@acp/runtime`, `@acp/accounts`
   and `@acp/observation` forbid it by name in their manifests. So "removing
   the collector does not affect routing" is a property a reader can check by
   reading the graph.

The one consumer outside this package is a **test**: the gateway's
`test/telemetry/` drill, in an already-registered test-only domain. It lives
there because the causal evidence needs the real production emitters and a real
disposable ledger, both of which this package is forbidden to name — and
narrowing that prohibition to `src/` only, so the drill could live here, would
have retired the checkable half of mechanism 3.

## Loopback, plaintext, literal

The admission accepts `http://127.0.0.1[:port]` and `http://[::1][:port]` and
nothing else. `localhost` is refused **by name**, because resolving a name
means DNS and a name that resolves on-box today is a remote collector tomorrow.
`https` is refused in R11 as well: a loopback TLS endpoint needs a trust
decision this package cannot make honestly, and plaintext to a literal loopback
address on this host is what the restriction authorised.

Both refusals are decisions rather than oversights. A remote host and TLS would
be this repository's first non-loopback egress and deserve their own argument,
their own law and their own record. The admission is the one file that would
change, which is the point of putting the decision there.

## Two authorities, each confined to one file

`src/admission/index.ts` is the only file that parses a URL, the only one that
names a loopback address, and the only one that knows the traces path. It joins
the base and that path exactly once and hands down an `AdmittedOtlpEndpoint`
carrying the final target verbatim.

`src/http/index.ts` is the only file that calls `fetch`. It contains no URL
literal of any kind and parses no URL: the admitted string is posted verbatim,
because a transport that could assemble a target could assemble a different
one. It uses the **platform global** rather than a socket library, and the
builtin ban applies to it like every other file, which is what makes "no socket
library" a property of the build.

The fence pins both by exact path, in both directions: every other file in the
package fails on a `fetch(`, and the fetch site itself fails if it stops
calling one, starts naming a target, drops `redirect: "manual"` or drops its
timeout.

## No credential can travel

There is no credential input anywhere on this package's surface. The
environment is never read, in any file. The transport sends the admitted
headers and a content type and nothing else — no authorization default, no
cookie, no `credentials`, no dispatcher — and the admission refuses the
credential-shaped header names outright rather than merely not adding them.
Userinfo in an endpoint is refused as `ENDPOINT_CREDENTIALED`.

If a collector ever requires an API key, it arrives as an admitted header
through the same config path the endpoint does, by a named decision, and the
credential-guard laws apply to it. It does not arrive because nothing stopped
it.

## The brand is the guarantee at the sending surface

`TelemetryExporterPort.export` takes a `TelemetryBatch`, whose events are
branded with `emitTelemetry` as their only mint site. An exporter typed on it
is therefore structurally incapable of receiving a record that did not pass the
redaction gate. A structurally-typed `ExportableSpan` declared here would have
compiled, added no dependency edge, and quietly discarded exactly that.

The cost is stated rather than hidden: `@acp/observation` declares
`@acp/ledger`, which declares `better-sqlite3`, so the driver sits in this
edge's **transitive** graph. The dependency law is name-based over the manifest
text, so `forbidden` still passes and still means what it says — this edge
names no ledger and no driver — but a reader should know the transitive reality
before the row is read.

## The counters travel; what was withheld does not

Three counts ride the resource, and only counts:
`acp.telemetry.refused_count`, `acp.telemetry.unresolved_causation_count` and
`acp.telemetry.unexportable_count`. That is the Langfuse precedent — a reader
of the vendor surface can see **that** something was withheld without the
vendor surface being told **what** — and it is the only honest place for a
batch-level fact in a per-span format.

`unexportableCount` is this package's own. An event whose span context folded
to nothing has no OTLP representation, because a span without a trace id is not
a span. It is dropped and counted, and **no synthetic id is minted**: minting
one would collect every degenerate event into a fictional trace, which the
emitter already refuses by name for the all-zero case. An instant that does not
parse is counted the same way rather than written to the wire as `NaN`.

## Two encodings that are easy to get half right

**Epoch nanoseconds exceed `Number.MAX_SAFE_INTEGER`.** `Date.parse(iso) * 1e6`
compiles, is deterministic, passes a parsed-object comparison and produces
bytes a collector rejects. Timestamps are built as decimal digit strings
through `BigInt`, and the fractional digits are read out of the ISO string and
padded to nine places rather than routed through `Date`, which truncates at
milliseconds. Sub-millisecond precision is therefore **preserved**, and that is
a decision rather than an accident.

**int64 is a JSON string in proto3's JSON mapping.** That governs both the
timestamps and `intValue`, and getting the first right while getting the second
wrong is the likely half-fix. Both are asserted on the raw request text rather
than on the parsed object, because `JSON.parse` turns a quoted integer and a
bare one into the same value.

## Two vocabularies OTel and OpenInference do not share

Every span is emitted with `kind: 1`, and `openinference.span.kind` stays the
attribute it already is. OTel's `SpanKind` and OpenInference's span kind are
different vocabularies, and mapping `AGENT` or `TOOL` onto
`SERVER`/`CLIENT`/`PRODUCER`/`CONSUMER` would invent a correspondence neither
convention states. A conventional field filled with a value that does not carry
that meaning looks standard and is false.

`scope.name` is this module's own name. There is **no** `scope.version`: every
package in this repository is `0.0.0`, and a version that carries no
information should not be sent as though it did.

## Public surface

| Name | What it is |
| --- | --- |
| `TelemetryExporterPort` | the seam: one `export(batch)`, returning an outcome and never throwing |
| `createOtlpExporterPort` | binds a port to one admitted endpoint |
| `admitOtlpEndpoint` | the only mint site for an `AdmittedOtlpEndpoint` |
| `AdmittedOtlpEndpoint` | a judged endpoint; branded, so a raw string cannot stand in for one |
| `OtlpEndpointCandidate` | what an operator's config offers, before anything has judged it |
| `OtlpAdmissionOutcome` | admitted, or a named refusal and the field it fired on |
| `serializeTelemetryBatch` | the pure mapping, exported so the causal drill can reach it |
| `OtlpSerialization` | the bytes and what they account for |
| `TelemetryExportOutcome` | `ok`-discriminated, with a receipt on both branches |
| `TelemetryExportReceipt` | spans, unexportable, refused, bytes |
| `TelemetryExportRefusal` | the closed six-member export vocabulary |
| `TelemetryAdmissionRefusal` | the closed admission vocabulary, deliberately separate |
| `TELEMETRY_EXPORT_REFUSALS` | that vocabulary as a frozen table |
| `TELEMETRY_ADMISSION_REFUSALS` | the same, for admission |
| `OTLP_EXPORT_RECORD` | what this exporter has and has not been proved against |
| `OTLP_BODY_MAX_BYTES` | the body ceiling, refused before the send |
| `OTLP_TIMEOUT_DEFAULT_MS` | what an endpoint gets when its config names no timeout |
| `OTLP_TIMEOUT_MAX_MS` | the cap the admission refuses past |
| `OTLP_HEADERS_MAX` | the most headers an admitted endpoint may carry |
| `OTLP_HEADER_VALUE_MAX_BYTES` | the most one admitted header value may carry |
| `OTLP_SCOPE_NAME` | the instrumentation scope this edge reports itself as |
| `OTLP_SERVICE_NAME_DEFAULT` | what `service.name` reads when the config names none |
| `OTLP_SERVICE_NAME_MAX_LENGTH` | the bound on a configured service name, which rides the wire |

The transport is not on this surface, and neither is the scripted peer at
`test/testing/index.ts`: a fake on a public surface is eventually mistaken for
evidence.

## Record

`docs/architecture/0055-a-vendor-endpoint-is-an-edge-behind-a-port.md`.
