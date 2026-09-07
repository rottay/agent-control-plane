# ADR 0054 — The baseline measures the walk that actually runs

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

`computeBaseline` (`packages/domains/observation/src/baseline/index.ts:207`) is
one of two read models over a ledger-ordered chain. It demanded three payload
fields, and no production emitter wrote any of them.

- **`TASK_CLASSIFIED.payload.reason`** (`:254-258`). The walk emits
  `TASK_CLASSIFIED` as a `PLAIN` beat at plan index 1
  (`runtime/src/core/lifecycle/index.ts:53`), and `payloadFor` returns
  `{ submissionDigest, beat: "PLAIN", planIndex }`
  (`runtime/src/core/events/index.ts:152`). No `reason`.
- **`ATOMIC_STEP_COMPLETED.payload.tokensUsed`** (`:263-266`). That event is the
  plan's `OUTCOME` beat (`lifecycle/index.ts:57`), and the OUTCOME arm of
  `payloadFor` returns
  `{ submissionDigest, beat, operationId, operationIndex, contentDigest, postcondition }`
  (`core/events/index.ts:142-151`). No `tokensUsed`, and there never was one.
- **`AUDIT_COMPLETED.payload.verdict`** (`:279-287`). Also a `PLAIN` beat
  (`lifecycle/index.ts:59`). The single emitter that does write a `verdict`,
  `authorizeCommit` (`runtime/src/commit-authorization/index.ts:334-340`),
  builds an `AuthorizationEvent` (`:114-117`) — not a `ControlPlaneEvent` — and
  has zero callers outside its own module.

The consequence was not a wrong number. It was no number at all: a real chain
threw `MISSING_REASON` on event index 1 and the measurement never happened.

**The measure the walk does write is elsewhere and was already being read.**
`recordTokenObservation` writes `payload: { accountId, tokens }` on
`TOKEN_USAGE_RECORDED` (`runtime/src/usage/index.ts:208`); the daemon's
`recordUsage` closure is the production caller
(`packages/entrypoints/daemon/src/index.ts:880-894`); and the sibling read model
in this same package already folds exactly that pair
(`observation/src/rollups/index.ts:130-138`). One package held two read models
over one chain, and only one of them read the chain that exists.

**The lane is cold, which is why this was owed rather than urgent.**
`computeBaseline`'s only `src/` caller is `buildShadowLedger`
(`observation/src/shadow-ledger/index.ts:216, :223`), whose own only `src/`
reference is the barrel. ADR 0048 measured the same defect and declined to
half-fix it — "repairing the token measure alone would move nothing a reader
could see" (`0048-…md:230-239`) — recording the whole repair as owed to R9b at
`:274-280`, as does `packages/domains/observation/README.md:181-188`.

## Decision

**Spend is read from `TOKEN_USAGE_RECORDED.payload.tokens`.** The baseline gains
that arm and loses the `ATOMIC_STEP_COMPLETED` one. `TOKEN_USAGE_RECORDED` is
already in the frozen 24-type vocabulary
(`kernel/contracts/src/schemas/control-plane-event/index.ts:42`), so nothing was
minted and no kernel path was touched. `TOKEN_RESERVATION_RECORDED` carries the
identical key and is deliberately not read: a hold is not a spend, which is the
same boundary the rollup keeps. `TOKENS_USED_MAX` stays the ceiling and is the
same 10,000,000 the recorder itself refuses above (`USAGE_TOKENS_MAX`) and the
rollup bounds by (`ROLLUP_TOKENS_MAX`), so a row this measure would call out of
range is a row the writer would never have appended.

**`reason` and `verdict` are absent-tolerant with explicit unreported counts.**
`RoutingBaseline` gains `unreported` and `AcceptanceBaseline` gains
`unreported`. A chain of classifications that report nothing yields
`routing.total = 0` **and** `routing.unreported = N` — never a bare zero, which
could equally mean no classification happened. Absence is tolerated because the
walk's silence is a fact about the walk; a field that is *present and broken* —
an empty reason, an 81-character one, a non-string verdict, a verdict outside
the closed set — still stops, because that is a defective artifact and ADR 0009
forbids waving one through. The distinction is `Object.hasOwn`, not a truthiness
test, so a payload that genuinely carries `reason: ""` is refused rather than
counted as unreported.

**`MISSING_REASON`, `MISSING_TOKENS_USED` and `MISSING_VERDICT` are documented,
not retired.** All three stay in the closed `BaselineStopReason` union
(`baseline/index.ts:59-68`), each now reachable only from a chain hand-built to
carry a broken field, each documented as such at the union and pinned by its own
synthetic test. The suite asserts them through the union type rather than
through strings, so retiring or renaming one is a compile error rather than a
silently passing test.

**The agreement is proved causally.** The drill is C22 and C23 in
`packages/entrypoints/gateway/test/telemetry/index.test.ts`: it walks the real
`LIFECYCLE_PLAN` through the real `buildEvent`, appends to a real disposable
ledger, writes spend through the real `recordTokenObservation`, reads the chain
back **out** of the ledger, and only then measures it. The expected token total
is summed from the rows themselves rather than restated as a literal. The
gateway hosts it because it is the only package whose manifest already names
both `@acp/observation` and `@acp/runtime`, and `TEST_ONLY_DOMAINS.gateway`
already registers `telemetry` for exactly this class of drill
(`scripts/check-architecture.mjs:14304-14310`) — so no manifest, lockfile,
tsconfig or dependency-graph change was needed.

The drill was written red first. At the pre-repair HEAD it failed with
`BaselineStopError: baseline stopped: MISSING_REASON at TASK_CLASSIFIED`, and
neutralizing the repair by restoring the `tokensUsed` read turns it red again at
the first `ATOMIC_STEP_COMPLETED` — plan index 5 — with `MISSING_TOKENS_USED`.
A fixture that cannot fail proves nothing, and this one fails in both directions.

## Why widening the event vocabulary was not chosen

The straightforward-looking repair is to make the walk write what the baseline
asked for: put a `reason` on the classification beat, a `tokensUsed` on the
outcome beat, a `verdict` on the audit beat. It was not chosen, on three counts.

It would invent data. The walk has no classification reason to state — the beat
records that a classification happened, and the DT's reasoning is not in the
event's reach. A field written only to satisfy a reader would be the estimate
ADR 0009 exists to forbid, dressed as an artifact.

It would duplicate a measure that already has a home. Spend is already recorded,
already bounded, already attributed to the elected account, and already folded
by the rollup. A second token field on a second event type would be two
declarations of one quantity, free to disagree.

And it would move the contract. `payloadFor` projects INTENT fields one by one
precisely so a wider object cannot smuggle a key past the contract's guards
(`core/events/index.ts:124-126`); adding payload fields to three beats to please
a cold read model is the tail wagging the dog. The frozen vocabulary already had
the event this measure needed.

## Why retiring the three stop reasons was not chosen

ADR 0048 prescribed the three as "retired **or** documented", so both were open.
Documenting was chosen because the shadow ledger replays synthetic chains, and
those are precisely the chains that can carry a malformed field. A baseline that
had dropped `MISSING_TOKENS_USED` would have had to either accept a usage row
whose count is the string `"many"` or invent a new reason code for it. Retiring
three public members to add one back is churn that buys nothing, and the closed
union plus a synthetic test per member costs a reader less than a gap would.

The honest cost is stated in the next section: three members of a public union
are now unreachable from production, which a reader must be told rather than
left to discover.

## Consequences

**The serialized baseline changed shape.** `serializeBaseline` now emits
`routing.unreported` and `acceptance.unreported`, so `baselineSha256` moves.
`docs/certification/metrics-baseline.md` and `docs/certification/p8-matrix.md`
are deliberately untouched: both are dated records anchored to the HEAD they
were written against, a class this repository's fence already settles
(`scripts/check-architecture.mjs:9224-9229`), and the memo says so of itself
(`metrics-baseline.md:135-138`). **The `baselineSha256` pin `f31fb8ec…` at
`p8-matrix.md:35` is therefore historical from this record forward, not false:**
it remains the correct digest for the HEAD that produced it. No source or test
anywhere pins that digest as a literal, and every determinism assertion in the
suite compares two live computations rather than a frozen string.

**Three public stop reasons are now production-unreachable.** They are reachable
only from synthetic chains, documented as such at the union, and each is held by
a test. A future reader who finds one in a real incident should treat it as
evidence that the chain was not produced by the walk.

**This record supersedes ADR 0048's cost sketch, not its prescription.** ADR
0048 estimated that R9b "retires three public stop reasons and adds two source
paths" (`:237-238`). Measured: it retires none — the document-not-retire ruling
above — and adds no source path, because the drill joined an existing test file
in an already-registered test-only domain. The prescription at `:274-280` is
adopted in full.

**`OBSERVATION_PUBLIC_EXPORTS` does not move.** Members were added to
`RoutingBaseline` and `AcceptanceBaseline`, both already exported by name, so
the package's closed surface stays at 65 and no consumer's import changes. No
package outside observation names either type.

## Not in this record

**The projection still has no production sink.** `emitTelemetry` keeps zero
callers in any `src/`; that is owed to R11 and to the owner's dependency answer,
exactly as ADR 0048 and `packages/domains/observation/README.md:175-179` state.
This record adds no exporter, no port and no edge.

**Langfuse stays.** ADR 0048:287-290 holds — the translator forwards attributes
verbatim and its removal is separately adjudicated. Nothing under
`packages/domains/observation/src/telemetry/` was touched here.

**The baseline still has no production caller.** `buildShadowLedger` remains its
only one, and giving the measurement a live consumer is a separate question from
making it truthful. This record makes it truthful; whether anything should read
it in production is not decided here.
