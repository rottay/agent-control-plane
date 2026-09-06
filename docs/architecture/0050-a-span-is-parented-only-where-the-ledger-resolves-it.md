# ADR 0050 — A span is parented only where the ledger resolves it

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0048 made the telemetry projection read the route the walk actually writes.
It left a larger hole open, and the measurement is blunt: a `grep` across the
whole of `packages/domains/observation/src/` for `eventId`, `correlationId` or
`causationId` returned **zero** matches. The projection read none of the three
causal columns the contract exists to carry.

The consequence was not a missing attribute. It was a missing shape. A walk of
the eleven-step lifecycle plan projected as eleven unrelated spans; an account
switch projected as three; a whole attempt projected as a bag of events with no
statement anywhere that they belonged to one run, let alone that one followed
from another. "Neutral events first, shaped to the OpenTelemetry and
OpenInference conventions" was true of the attribute names and false of the
thing those conventions are mostly for. A trace viewer given that output draws a
flat list.

The ledger has held the answer since P8-8E2. Every event carries `correlationId`
— the invocation's own id, shared by every event of one attempt — and
`causationId`, the event this one followed from. The contract is explicit that
neither is verified, and equally explicit about what follows:

> A row whose causation names a missing event, or an event in another task, is a
> valid row. Causation is therefore advisory, and its trustworthiness comes from
> two guards outside this contract: the producer refuses to append a link whose
> predecessor is not durably present, and **the consumer refuses to draw an edge
> it cannot resolve**.
>
> — `packages/kernel/contracts/src/schemas/control-plane-event/index.ts:121-128`

This record is the consumer half of that sentence, implemented.

## Decision

`emitTelemetry` folds a span context out of the three causal columns and out of
nothing else, and attaches it to every event it emits as a top-level member:

```ts
export interface TelemetrySpanContext {
  readonly traceId: string;          // 32 lowercase hex, never all-zero
  readonly spanId: string;           // 16 lowercase hex, never all-zero
  readonly parentSpanId: string | null;  // a span in the SAME trace, or a root
}
```

### The fold: two total functions

```
uuidHex(u)    = u with "-" removed, lower-cased                 -> 32 hex chars
traceIdOf(u)  = null if u is null or uuidHex(u) is all zero, else uuidHex(u)
spanIdOf(u)   = null if u is null or the head is all zero, else uuidHex(u)[0..16]
```

Pure and total: no clock, no randomness, no filesystem, no environment, no
crypto. Two runs over the same events are byte-identical, which is the property
that lets telemetry emitted today be compared against the same chain replayed
tomorrow.

Reference vectors, recomputed from the real derivation chain while writing this
record:

```
attempt 1  invocationId b4882309-ec77-5e10-a1dd-a69ed4d6e0a2 -> trace b4882309ec775e10a1dda69ed4d6e0a2
  discovered   84bfee60-e1e1-53a2-8892-afbaef6c4f83          -> span  84bfee60e1e153a2
  classified   421bf2eb-a752-558f-a75d-768741015b20          -> span  421bf2eba752558f
  run.started  60ee53ea-2781-50b7-9caf-cd3320d39aea          -> span  60ee53ea278150b7
attempt 2  invocationId 8d1bc265-4376-5ca1-84d8-292dfab3b358 -> trace 8d1bc26543765ca184d8292dfab3b358
  discovered   44a760b5-6c0f-5001-b68f-fa00749cd25e          -> span  44a760b56c0f5001
```

### The parent relation: four clauses, and each one is load-bearing

`parentSpanId` is `spanIdOf(e.causationId)` **if and only if all four hold**:

1. `e.causationId` is not null, and is not `e.eventId` itself;
2. an event whose `eventId` equals `e.causationId` is among the events this
   batch **emitted** — not merely among the events it was handed;
3. that event's `correlationId` equals `e.correlationId`, so parent and child
   are in one trace;
4. `spanIdOf(e.causationId)` does not degenerate.

Otherwise `e` is a root of its trace, and the batch counts it.

Clause 2's *emitted, not merely handed* is why the fold is two passes rather
than one. The gate runs first; the resolution index is built from the survivors
alone; only then is anything shaped. A one-pass fold differs from this one on
exactly one case, and it is the case that matters: an event whose cause the
redaction gate refused would be handed a `parentSpanId` naming a span that was
never emitted — a structural handle on precisely the record the gate exists to
withhold. The evidence for that is a test rather than this paragraph: **U10**
asserts the refused record's span id appears nowhere in `JSON.stringify(batch)`,
and **C20** asserts the same over a real ledger chain with a real planted
credential.

### A trace is honestly a forest

Every `causationId: null` event emits `parentSpanId: null`. No synthetic root is
minted, for any reason. Several roots may share one `traceId`, and that is the
correct output rather than a degradation to be smoothed over: a synthetic root
would be a span naming no ledger row, invented by the projection to make its own
output look tidier than the chain it read. A real walk with lease and
conformance events has **six** roots — the plan's discovery, both lease events,
both conformance events, and the pressure event — and `C15` asserts that count
exactly, so a later move to a synthetic root is a named change rather than a
drift.

### Clause 3 is not defensive; it is production behaviour

The switch executor threads its causation from the elector's audit link:

```ts
// The plan, verbatim. … `causedBy` is the audit link the elector recorded — the
// cross-task cause that field was designed for, not the row that satisfied the
// match.
causedBy: authorization.decidedFromEventId,
```
— `packages/domains/runtime/src/switch-executor/index.ts:552-554`, `:572`

The daemon's own drill seeds `decidedFromEventId` on a **different task** and
asserts it lands as the causation of `ACCOUNT_SWITCH_STARTED`. A different task
means a different `taskId`, hence a different `invocationId`
(`submission/index.ts:146`), hence a different `correlationId`, hence a
different trace id. Without clause 3, every real account switch would emit spans
claiming a parent in another trace. In OpenTelemetry that is not a weak edge; it
is a corrupt one, and a viewer given it draws a tree that never happened.

So the relation is refused and the **fact** is kept: `acp.event.causation_id`
carries the raw ledger id verbatim, and `unresolvedCausationCount` counts the
event. `C17` drives exactly this through the real executor against a real
second task in the same ledger.

### The limit is counted, not described

`emitTelemetry` keeps its signature — `(events: readonly ControlPlaneEvent[]) =>
TelemetryBatch` — and stays pure and ledger-free. Parentage is therefore
**batch-scoped**: a cause outside the page the caller passed cannot be resolved,
however durably the ledger holds it.

That is a real limitation, so it is measured rather than described.
`TelemetryBatch` gains `unresolvedCausationCount`: the number of emitted events
that name a cause and emit no parent for it. It exists for the reason
`refusedCount` exists, in the module's own words — *"A read model that silently
dropped records would be indistinguishable from one that had none to drop"*. A
tree that discarded every cross-task edge in silence would look identical to one
whose chains had no cross-task edges. Refused records are **not** counted: a
refused record projects nothing at all, so counting it would report one
withholding under two counters.

### Two new attributes, and one deliberately absent

| Key | Source | Emitted when |
| --- | --- | --- |
| `acp.event.id` | `event.eventId` | always |
| `acp.event.causation_id` | `event.causationId` | when non-null |

Both exist because the context is lossy in two specific ways. A `spanId` is 64
of the event id's 128 bits, so the ledger row is not recoverable from the span
alone; and `parentSpanId` is *dropped* whenever the four clauses refuse it,
which for a real account switch is always.

**`acp.event.correlation_id` is not emitted.** `traceId` is
`uuidHex(correlationId)` — a lossless, trivially invertible encoding — so
wherever there is a correlation to report there is already a trace id reporting
it, and wherever there is no trace id (a correlation-less event) there is no
correlation either. A third key would be a second spelling of a fact the output
already carries.

## The alternatives, and why each was refused

### Why truncation and not a hash

A digest over the event id would buy uniform bits. It would cost a
`node:crypto` import in a module whose entire claim is that it is a pure fold
with no capability, and it would buy those bits for ids that are *already*
derived deterministically. It would also destroy something worth more here:
truncation keeps a span id **inspectable**, so a reader holding one can find its
ledger row by prefix. A digest makes that impossible.

**The entropy is 60 bits, not 64, and this record states it rather than hiding
it.** `deterministicUuid` forces the version nibble into byte 6
(`runtime/src/core/coordinates/index.ts:50`), which is hex index 12 — inside the
truncation window. Every production span id therefore carries a fixed `5` at
position 12. Verified against the reference vectors above: all five carry it.
Over the ten to forty spans one correlation holds, the birthday probability is
below `10^-15`. Over a corpus large enough for 60 bits to matter, a pure
batch-scoped projection is the wrong instrument anyway.

### Why a degenerate context is not a refusal

Four cases, and only the first produces a context:

| Case | `correlationId` | `eventId` | `spanContext` | `refusedCount` |
| --- | --- | --- | --- | --- |
| A | usable | usable | present | untouched |
| B | null | usable | `null` | **untouched** |
| C | usable | folds to all-zero | `null` | **untouched** |
| D | folds to all-zero | any | `null` | **untouched** |

An unplaceable span is not a withheld record. This is the module's own settled
allocation, already law for the malformed route: *"A bad route is not a
redaction failure: refusing the event would mis-signal the refusal count"*. The
event emits with every attribute it has, and `refusedCount` stays honest.

The all-zero guards are not decorative. OpenTelemetry names the all-zero trace
and span ids invalid, and emitting one would collect every degenerate event of
every chain into a single enormous fictional trace. Measured against `zod@4.1.13`:
`z.uuid()` **admits** the nil UUID `00000000-0000-0000-0000-000000000000`, so
case D is reachable from any hand-built or foreign record. Case C is narrower
than it looks — hex index 12 is the version nibble, and only the nil UUID may
leave it zero, so an all-zero span head on a *schema-valid* id is unreachable.
Both guards are implemented anyway, because the value space this module is total
over is TypeScript's, not the schema's.

### Why the span context is a field and not an attribute

Trace and span identity is span *context* in the OpenTelemetry data model, not
attribute data, and every exporter reads it from a different place. Nesting the
three ids in one object also makes all-or-nothing **structural** rather than a
convention three sibling fields would each have to remember: a span id without a
trace id is not a span, and this shape cannot express one. It is the same move
the module already makes with the gate brand.

### Why the Langfuse translator is untouched — the smaller claim, stated

**The vendor trace stays a flat observation list and carries no tree.** This
record claims the tree for the neutral OpenTelemetry/OpenInference surface and
for nothing else. `toLangfuseTrace` forwards `attributes` and no other member,
so a span context expressed as a top-level field reaches it and is not
forwarded — the translator needed no edit, and got none.
`packages/domains/observation/src/telemetry/langfuse/index.ts` is not in this
packet's write-set. A vendor exporter that can represent a tree is a later and
separate question, and this record does not answer it.

### Why a self-caused event is not its own parent

The four clauses as first drafted did not exclude `e.causationId === e.eventId`.
Such an event is in the batch and trivially shares its own correlation, so all
four would pass and the span would become its own parent.

Measured: **no production writer can produce it.** `core/events` uses the
previous plan step, `switch-landing` uses `started.eventId`, `switch-executor` a
foreign `decidedFromEventId`; `pressure`, `cancellation`, `failure`,
`daemon/index` and `daemon/arbiter` all write null; `usage` and `tool-receipt`
take a caller-supplied `causedBy` whose value the caller cannot know before the
recorder derives the coordinate. The case is contract-representable and
unreachable.

It is closed anyway, inside clause 1 rather than as a fifth clause, because a
self-parent is an *invalid* edge rather than a weak one — the same class of
corrupt relation clause 3 refuses for cross-trace parents — and the rule
"parentage only where the ledger resolves it" already implies a cause distinct
from its effect. It needs no change to the counter: a guarded self-causation is
an emitted event with a non-null causation and a null parent, so the existing
predicate counts it. `U15` pins it.

## The isolation ceiling, declared

Uniqueness is claimed **per `(taskId, attempt)` invocation, within one ledger,
and no further.**

Inside that boundary it holds by construction and is asserted as a set
operation: `C18` walks attempt 1 and records attempt 2 of the same task into one
ledger and proves the two span-id sets are disjoint, the two trace ids distinct,
and no parent in either trace a span of the other.

Outside it, nothing is claimed. Two ledgers that both walk the same `taskId` at
the same `attempt` derive the same ids, because `deterministicUuid` is a pure
function of the coordinate and knows nothing about which ledger it is writing
into. **No ledger salt was invented and `submissionDigest` was not folded in**,
because either would be this packet answering a question that belongs to
another: cross-ledger identity is **R3**, and the boundary audit's row on
identity isolation is **R17**. Both remain separate work, and a later reader
should not mistake this record's silence for a claim.

## What this record does not do

- **No sink.** `emitTelemetry` has zero callers in any `src/` at this commit and
  zero after it — one barrel re-export and five docblock mentions, no call site.
  The exporter stays owed to R11 and to the owner's dependency answer.
- **No producer change.** R10 reads what the walk, the recorders and the switch
  executor already write. Not one file under `packages/domains/runtime/**` or
  `packages/entrypoints/daemon/**` is in the write-set.
- **No contract change.** All three columns already existed with the right types
  and nullability.
- **No dependency.** Measured: zero occurrences of `opentelemetry` or
  `openinference` in any manifest or in `pnpm-lock.yaml`.
- **No span links.** A `links` member is not added to `TelemetryEvent`,
  `TelemetryEventFields` or `TelemetryBatch`. A cross-task link is a shape worth
  having only once an exporter can resolve cross-task context, and none can.

## Conventions, recorded as documentary

This record is written against the OpenTelemetry data model and the
OpenInference conventions, and both are documentary pins in the precedent ADR
0048 set (`0048:184-191`): this repository depends on no OpenTelemetry package,
so there is no resolvable version for a fence to check. A later reader should
treat the framing as the state of the conventions this record was reasoned
against rather than as a dependency.

**OpenInference contributes nothing to identity here.** It is attribute
conventions only — `openinference.span.kind` and its one exception. The trace,
the span and the parent are the OpenTelemetry data model's, and the values in
them are the ledger's.

## Consequences

**Pins that move.** The ADR corpus 49 → 50. `OBSERVATION_PUBLIC_EXPORTS` 64 → 65
(`TelemetrySpanContext`). `PATH_SCOPED_LAWS` and the `requireScope` call sites
111 → 112, for the one new law below. `TELEMETRY_ATTRIBUTE_KEYS` 16 → 18.

**Pins that do not.** `CONTROL_PLANE_EVENT_TYPES` stays **24** — this packet
reads ids and mints no vocabulary. `TELEMETRY_REFUSAL_REASONS` stays 2;
`TELEMETRY_SPAN_KIND` stays `AGENT` with `TOOL_CALL_RECORDED` its one exception;
`ERROR_TYPES` 3, `FAULT_REVOCATION_CAUSES` 3, `CLEAN_REVOCATION_CAUSES` 2. The
route key's three-declarer law is untouched: R10 adds a reader of *ids*, not of
the route. `API_CONTRACT_VERSION`, `API_ROUTES`, `TEST_ONLY_DOMAINS`,
`GATEWAY_TS_REFERENCES`, every manifest and the lockfile do not move.

**The law.** `L-V2B5R10`, *"the span context is derived from the causal columns"*,
scoped over `packages/domains/observation/src/**/*.ts`, asserts four things
against the comment-stripped source: that all three columns are still read; that
the module reaches for no clock, randomness, environment, filesystem or crypto;
that the resolution is named code built from the **survivors** and gated on
correlation equality; and that no second module in the package declares the
fold. Each arm was falsified against a deliberate mutation before being trusted.

**The evidence.** Fifteen unit assertions and a neutralization probe in
`packages/domains/observation/test/telemetry/index.test.ts`, and ten causal
assertions in `packages/entrypoints/gateway/test/telemetry/index.test.ts` driven
through the real emitters against a real disposable SQLite ledger. The causal
fixtures deliberately cross the default order, because on a plan-only chain the
cause **is** the previous element and ledger order **is** plan order — so a
wholly wrong `parentSpanId = previousElement` implementation would satisfy a
naive suite. `C13` interleaves lease events between causally adjacent steps,
`C16` gives three siblings one parent, and `C14`/`U14` reverse the batch so the
previous element is the successor. The neutralization probe replaces every
`causationId` with null and requires every parent to disappear: if one survives,
the implementation is reading something other than causation and the whole suite
is measuring the wrong thing.
