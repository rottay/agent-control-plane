# ADR 0090 — A usage recorder reports what the adapter already normalized, and restarts never reinvent an epoch

- Status: accepted (P-32/captura escalón C, recorded 2026-09-13).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0089 §Thirteen — L-P32B-1 gains a second reach for the stream
  identity, in its own row. Economy §1 (`docs/audit/architecture/database/economy/index.md`)
  is read, not edited.

## Context

Escalón A (ADR 0088) landed the fold and the stream identity; escalón B (ADR 0089)
landed the two event types, the door that settles them and the tables. What was left
is economy §1.1 `:36-38` from the producer's side: an adapter registers a generation
**before** its reports, and a restart does not invent it again for a report already
registered.

The DT's adjudication of the map (Q5) keeps C unwired: the walk reports one total and
emits no effect, so wiring it today would invent classes or effects, and the wiring
belongs to P-15. The writer's first brief named the recorders. The Fable preaudit
(ACCEPT_WITH_CORRECTIONS, H-1..H-8) found what it left open — L-P32B-1 forbids the
runtime from naming the identity it must import (H-1), the "read verb of B" does not
exist (H-2), both payloads need the V2 coordinate (H-3) — and the DT adjudicated H-1,
H-2 (option a) and H-3, and adopted H-4..H-8 as written.

## Decision

**One — two recorders in `@acp/runtime`'s usage module, beside the legacy one.**
`recordUsageStreamDeclaration(ledger, declaration)` appends one
`USAGE_STREAM_DECLARED`; `recordUsageObservation(ledger, report)` appends one
`USAGE_OBSERVATION_RECORDED`. Both are same-state passthroughs whose state is read
from the ledger, both answer `{ inserted, event, measurementStreamId }`, and both take
the ledger through `LedgerPort`. `recordTokenObservation`, `usageTransitionId`,
`TOKEN_USAGE_RECORDED`, the rollups and quota are untouched; L-V2B1D-1 is quiet.

**Two — the identity is imported, never recomputed** (H-1, H-8). The declaration's
`measurementStreamId` is `measurementStreamIdV1` from `@acp/ledger`, the one encoder
the door recomputes. The observation takes the stream id its declaration or the
lineage read named. The record keys `usageStream` and `usageObservation` and their
field names are restated in the module, as `{accountId, tokens}` is: the ledger's
projection holds them off its barrel, and exporting two words would widen a surface
for nothing.

**Three — the V2 coordinate, and only the V2 coordinate** (H-3). Both recorders
require `invocation.revision` and refuse by name an invocation without one before
building anything: a usage record names a segment or an effect, and a V1 invocation
has neither. The payload's `revisionNumber` and `attemptNumber` are the revision's,
never `invocation.attempt`, which the door compares with nothing. The runtime README's
paragraph on the exceptional producers now names `recordTokenObservation` and states
these two as the V2 exception.

**Four — the durable names carry the stream and nothing else** (H-5). A declaration
is keyed `usage-stream.<measurementStreamId>` (77 characters); an observation
`usage-observation.<measurementStreamId>.<ordinal>` (at most 99). The ordinal is the
source report's, never a counter of the recorder. Neither carries the landing
generation `usageTransitionId` needs: that key needed it because the legacy payload
names an account the key did not, and here the account and the segment are inside the
id, so a switch's destination declares another stream under another name. The event's
`occurredAt` and `recordedAt` are the invocation's `submittedAt` through
`deriveEventCoordinate`; the observation record's `occurredAt` is the adapter's.

**Five — what the recorder refuses, and what it leaves to the door** (H-7). The
recorder refuses by name, with `SupervisorError` and without appending, exactly: an
invocation without a revision; a task the ledger has never seen (neither recorder
opens a task); a `sourceClass` outside `USAGE_SOURCE_CLASSES`; a `reportKind` outside
`USAGE_REPORT_KINDS`. The four classes, the total, the range, the correction, the
effect and `isFinal` pass verbatim, and the door decides them inside the append's
transaction: `STREAM_UNKNOWN`, an effect not yet exposed, `TOTAL_MISMATCH`, the report
shape, the duplicates. A second validation here would be a second authority.

**Six — a restart reads its generation back; the reader never answers zero** (H-2,
option a). `readUsageStreamLineage(source, { source, accountId, routeSegmentId })`
pages `USAGE_STREAM_DECLARED` through the structural `UsageEventSource` and answers the
lineage's highest declared epoch with its id, class and policy, or `latest: null`. No
read verb is added to the ledger: a declaration the door refused never lands, so the
stream answers what the table would. The caller restates `latest.sourceEpoch`, declares
it plus one after a counter reset, and chooses `0` only on `null`. The law is
`readAccountUsage`'s — **exhaustive, or a refusal**: a page that claims more without a
cursor past the last is `LINEAGE_SCAN_INCOMPLETE`, a declaration whose coordinate
cannot be read is `LINEAGE_DECLARATION_UNREADABLE` rather than skipped, and a page read
that throws propagates. A truncated `null` would license epoch `0` over a lineage that
already declared it — E2 inverted.

**Seven — the observation cannot stand without its declaration.** Held by the door,
not restated: an observation of an undeclared stream is refused `STREAM_UNKNOWN`, and
the suite proves it through the real door on a chain the walk opened.

**Eight — which guard refuses a restated report with other bytes** (N-P32C-10). The
same report restated is an exact replay. The same stream and ordinal with other bytes
is the same key, so the ledger's idempotency guard refuses it
(`LedgerIdempotencyConflictError`) before the door is asked. The same observation id
at another ordinal is another key, and the door refuses it as the same identity with
other bytes.

**Nine — L-P32B-1 is amended in its row** (H-1). The fold keeps its four sites: no
tracked `packages/*/*/src/` file other than the settlement module, the ledger barrel,
`ledger/index.ts` and `projection/index.ts` names `usage-settlement/index.js` or
`foldUsageSettlement`. The identity (`measurementStreamIdV1`,
`measurementStreamPreimageV1`) admits one more site,
`packages/domains/runtime/src/usage/index.ts` (`USAGE_IDENTITY_CALLERS`). Same row,
same `requireScope`.

**Ten — unwired is a law** (Q5, H-6). **L-P32C-1**: no tracked `packages/*/*/src/`
file other than the usage module and the runtime barrel names
`recordUsageStreamDeclaration` or `recordUsageObservation` after comments are stripped.
P-15 retires it in the packet that binds a normalizing adapter, and names the
retirement. `PATH_SCOPED_LAWS` 142 → 143.

**Eleven — no bump.** No contract, event type, table, migration or identity is new:
`CONTRACT_VERSION` stays `2.6.0`. `RUNTIME_PUBLIC_EXPORTS` gains eleven names — the
two recorders, the two durable names, the lineage reader and six types.

## Consequences

- A normalizing adapter has a producer that declares a stream before its reports and
  reads its generation back after a restart; nothing it hands over is normalized a
  second time.
- A V1 invocation cannot produce a usage record of economy §1, and a revision-bearing
  one cannot produce a legacy `TOKEN_USAGE_RECORDED`.
- Scanning a lineage costs one query per thousand declarations across every lineage;
  the correctness bound is exhaustiveness, stated rather than implied.

## Not in this record

- Wiring the recorders into the walk, the daemon or a driver, and normalizing classes
  in real adapters: P-15.
- A read verb or an API route for a stream or a settlement.
- Moving quota or the rollups onto settlements: P-19. Prices and valuation: P-33.
