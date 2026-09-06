# ADR 0047 — The policy decides on what it measures

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

Law 4 of the P8 addendum asks for a versioned capability and policy registry
that lives outside application code, and it names eleven fields the registry
carries. One of them is measured quality. The acceptance criterion is blunt: a
policy update must change the elected model with no source change, and the
outcome must record which version of the policy chose it
(`docs/ROADMAP.md:627-632`, `:666-668`).

The registry has carried `quality` since P8-5. Nothing has ever read it. The
loader validates `quality.score` and `quality.confidence`
(`packages/domains/accounts/src/policy/index.ts:233-241`) and builds them onto
every entry (`:277-280`); the one seam that elects a model reads
`eligibleRoles`, `transports` and `allowedFallbacks` and nothing else
(`:435-437`, `:481-489`). Preference was document order, stated as such in the
module (`:21-24`) and in the package README (`:151-153`): the first eligible
entry a candidate account can serve is the one chosen, and reordering the array
is the whole diff.

Document order satisfies law 4's acceptance criterion, and it is why the P8-5
drill passes (`packages/domains/accounts/test/policy/index.test.ts:446-480`).
It does not satisfy the old-V2 draft's B5, which asks for *adaptive routing over
the single registry* — the routing decision reading what the evaluations
measure, with the registry's immutable versions as the only carrier
(`.acp-local/v2-roadmap-draft.md:77-78`, restriction 6 at `:43-45`). Between the
two sits restriction 5: a capability is `UNKNOWN` by law until a drill with a
real subject says otherwise (`:42`). Every entry in the shipped document is
`{ "score": null, "confidence": "UNKNOWN" }` today, honestly, because nothing has
been measured.

So the decision to take is not *how to rank by quality*. It is what a routing
rule may do with a registry that has measured nothing yet, and where that rule
is allowed to live — because the packet that first measures a model must not
also be the packet that changes how models are compared.

## Decision

**The selection rule is a field of the document.** `PolicyRegistry` gains
`selection`, a fourth `DOCUMENT_KEYS` member under the loader's existing
exact-key law, discriminated by rule:

```json
"selection": { "by": "DOCUMENT_ORDER" }
"selection": { "by": "QUALITY_SCORE", "minimumConfidence": "HIGH" }
```

`DOCUMENT_ORDER` carries no floor, because it reads no measurement;
`QUALITY_SCORE` requires one, because "measured" without a threshold is a claim
about the document rather than a rule. Both a floor under `DOCUMENT_ORDER` and a
missing floor under `QUALITY_SCORE` are refused by name at load
(`POLICY_UNKNOWN_KEY` at `selection.minimumConfidence`), and a document with no
`selection` key at all is refused by the root key law rather than defaulted: a
default here would be a rule no version records. The floor's type is
`ConfidenceLevel` from `@acp/contracts`, so `UNKNOWN` is not representable as a
floor — a floor of `UNKNOWN` would admit exactly the unmeasured claims the rule
exists to exclude.

**An unmeasured entry is not orderable under a measuring rule.** Under
`QUALITY_SCORE`, an eligible entry qualifies when `score` is not null, its
confidence is not `UNKNOWN`, and its confidence is at or above the floor on the
one confidence ladder the package already exports
(`CONFIDENCE_ORDER`, `src/quota/index.ts:97-101`). An entry that does not
qualify is not a candidate. Qualifying entries are ordered by score descending,
ties broken by document position, so the comparator is total by construction and
the sort does not depend on the engine's stability.

**Eligibility and measurement refuse separately.** Role and transport still
decide eligibility first and alone, and `POLICY_NO_ELIGIBLE_MODEL` keeps meaning
"the registry has nothing for this role and transport". When eligibility admits
entries and the measuring rule admits none of them, the new
`POLICY_NO_MEASURED_MODEL` at `"models"` refuses. It never relaxes to document
order: a rule that silently stops being the rule when its inputs are missing is
not a rule.

**A declared fallback is a permission, not an exemption.** A qualifying fallback
of entry E is attempted immediately after E and before the next entry in the
order, and the choice records `viaFallbackFrom: E`. A fallback that does not
itself qualify under the rule in force is skipped, exactly as a fallback the
role may not use is already skipped.

**The explanation lands on the choice value.** `PolicyRouteChoice` gains
`selectedBy: { rule, measurement, confidence }`, describing the entry actually
elected — after a fallback, the fallback's own numbers. It is not carried by
`resolveRoute`, by `composeSubmission`, by any contract, event or read model.

**What ships now is `DOCUMENT_ORDER` at a new immutable version.** The shipped
document publishes `2026-09-06.1` with `"selection": { "by": "DOCUMENT_ORDER" }`
and every other byte unchanged, both `evaluatedAt` values included: no
evaluation happened, so no evaluation date moves. The elected model at every
door is exactly the one the previous version elects. The fence gains the row
pinning `2026-09-06.1` to the digest of the bytes published under it, in the
same commit as the document edit, and keeps the `2026-08-30.1` row.

## Why a hardcoded comparator was not chosen

The alternative was to leave the document alone and put the rule in
`routeWithPolicy`: measured entries before unmeasured ones, or unmeasured
entries treated as average. Both are claims no version records.

The first is worse than it looks. The moment the first evaluation writes a
single score, a "measured beats unmeasured" comparator silently promotes that
one model above every other entry in the registry — a routing change nobody
edited, published by no version, explained by nothing. The second is
`UNKNOWN_TERM` (`src/routing/index.ts:385-395`), which is a deliberate neutral
value *inside a weighted mean* and is documented there as explicitly not a
measurement; borrowing it onto the model axis would be inventing the evidence
law 4 exists to record. The governing precedent is the other one:
`CAPABILITY_UNKNOWN` (`:840-848`), the fail-closed reading, "since the
alternative is to hope".

With the rule in the document, a switch from document order to measured quality
is an editorial act carried by a version — which is what "model switch por
política sin código" asks for (`.acp-local/v2-roadmap-draft.md:86`, `:112`).

## Why a seventh field on `ResolvedRoute` was not chosen

Carrying the explanation on the wire would be more convenient for a reader of
the ledger, and it is not affordable. `ResolvedRoute` is a `z.strictObject` of
exactly six fields
(`packages/kernel/contracts/src/schemas/execution-boundary/index.ts:219-228`);
the submission preimage projects those six one by one
(`packages/domains/runtime/src/submission/index.ts:94-109`), the resulting digest
rides every event's base payload, is rebuilt on every resume, and is pinned as a
frozen literal in two suites. A seventh field cascades through the contracts,
the INTENT beat, the ledger row, the read model, the projection, the execution
port's continuity check and the lifecycle operation, and costs a
`CONTRACT_VERSION` bump — to carry a value that is already recoverable, because
the version names the document, the document names the rule and the score, and
the fence pins the version to the bytes.

## Why a tail position for unmeasured entries was not chosen

Ordering measured entries first and unmeasured ones after them keeps every
model reachable, which reads like the safe option. It is the same substitution
in a different costume: it gives an unmeasured entry a *position* on an axis it
was never measured on, and that position is decided by the code rather than by
the document. It also makes the rule's behaviour change silently as evaluations
land, one model at a time. Ineligible-and-refuse is legible: the document says
what it measured, and when it has measured nothing under a measuring rule the
seam says so by name.

## Why `LATENCY`, `COST` and `CONTEXT` rules were not chosen

An enum member is earned by the drill that needs it. Nothing in this repository
measures latency, cost or context for a model; `latency.p50Seconds` and
`costPerMillionTokens` are `null` with `UNKNOWN` confidence in every shipped
entry, exactly as quality is. Cost in particular is product semantics that the
old-V2 boundary places outside B5. Two members are what the evidence supports.

## Why ledger-derived quality was not chosen

Acceptance rate over recorded outcomes is a real signal and it is not this
signal. Restriction 6 says the evaluations produce immutable versions of the
existing registry; a router that derived quality from the event log would be a
second registry with no version at all. It is also structurally unavailable
here: `@acp/ledger` is a test-only import for this package and the fence refuses
a production source that reaches for one
(`scripts/check-architecture.mjs:12896-12902`).

## Consequences

- The version literal follows in three suites that read the shipped document,
  in the package README, and in the fence's digest row. The nine hand-built
  route fixtures that carry `2026-08-30.1` as a past shape do not move, and
  neither does ADR 0018's mention of it: the corpus is append-only, and the
  version that record names is historical.
- The accounts barrel grows from 82 pinned exports to 85.
  `POLICY_SELECTION_RULES` is exported because the evaluation loop that will
  eventually write a score needs the closed vocabulary without reaching into the
  module.
- A policy document written before this packet — three document keys, no
  `selection` — is refused at load by the existing root key law. Nothing is in
  operation (law 8) and the only production loader call is the CLI over an
  explicit `--policy` path, so no compatibility shim is owed; a document that
  must keep working gains one line.
- The first packet that writes a real `quality.score` inherits a decided
  comparator and does not have to invent one under the pressure of its own
  measurement. It also inherits the obligation: publishing `QUALITY_SCORE` over
  a registry that has measured nothing refuses every election, which is the
  correct behaviour and a deployment mistake worth stating out loud.
- The account axis is untouched. `rankAccounts` still knows nothing about a
  policy, `decideSwitch` and the switch landing are unchanged, and quota
  pressure still moves *which account* answers and never *which model* the
  policy elected.

## Not in this record

Who writes the first score, and how an evaluation run produces a version — that
is the evaluation loop, and it is the packet after this one. Telemetry keys,
exporters, Promptfoo, the trace tree, cost class, transports beyond
`CLI_SUBSCRIPTION`, any console or gateway surface, and P9 are all outside it.
Election itself still belongs to ADR 0018, and `L-F4D-2` remains the law that
keeps the walk out of it.
