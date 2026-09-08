# ADR 0056 — The registry gains a producer, never a second one

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The capability registry has had every part of itself except the one that makes
it move.

It has a schema, in `packages/domains/accounts/src/policy/index.ts`: two closed
key tables, thirteen entry names and four document names, and an unknown key at
either level is `POLICY_UNKNOWN_KEY` rather than a tolerated extension. It has a
loader that takes an explicit absolute path and reads no environment. It has one
seam that consults it, `routeWithPolicy`, and one field it produces,
`capabilityPolicyVersion`. Since ADR 0047 it has a published rule for how
preference is read, and since ADR 0051 it has a version pin that lives as data
and that the architecture fence validates fail-closed in ten arms.

What it did not have was a **producer**. Every measurement in the shipped
document is `null` at confidence `UNKNOWN`, deliberately — a registry that
defaulted an unmeasured quality to a number would be inventing exactly the
evidence law 4 exists to record. And the documented way to change that was a hand
edit of two data files. Nothing in `packages/`, `scripts/` or `docs/` writes
`capability-policy.json`; the boundary audit's row 12 records the gap as
`AUSENTE`.

The old-V2 draft says what should fill it, in two clauses that bind together
(restriction 6): evaluations produce **immutable versions of the existing
registry — never a second one**, and **no subscription benchmark without
accounting for what it consumed**. Restriction 5 adds the ceiling: `CONFIRMED`
only by a drill with a real subject.

The obvious way to build it was to adopt a hosted evaluation runner. An owner
ruling on 2026-09-07 authorized exactly that — `promptfoo` as a root
devDependency, CI and benchmark use only — on the understanding, carried through
the map and made mechanical in the writer's brief, that the graph would be clean,
as P1B, P2A and P8-8B through 8E had each verified for their own additions.

It was not. The install was performed under that authorization, audited, and
fully reverted:

- the lockfile went from **414 to 1212 packages**: 798 added, for a dev-only tool;
- **seven of them declare install-time lifecycle hooks** —
  `@playwright/browser-chromium`, `@swc/core`, `better-sqlite3@12.11.1`,
  `onnxruntime-node`, two majors of `protobufjs`, and `sharp`;
- and the sharpest of those, `better-sqlite3@12.11.1`, is a **second major of the
  only name `onlyBuiltDependencies` carries**. That allow-list matches by name,
  not by version, and its own comment says no second name may be added without a
  new owner authorisation. A dev tool's transitive copy would have inherited the
  build authorization granted to the ledger's engine **without adding a name** —
  the law textually unchanged and its meaning silently widened.

The writer stopped rather than adjudicate that, and the owner ruled on the same
day (the second ruling of 2026-09-07): **no vendor enters the graph for R15.**
The earlier authorization is revoked by the measurement that followed it.

## Decision

**R15 ships the producer, not the runner.**

`scripts/evals/registry-cut.mjs` exports one pure function:

```
cutRegistryVersion({ current, evalOutput, version, evaluatedAt, consumption })
  -> { ok: true, document, digest, pinRow }
   | { ok: false, reason, at }
```

Five properties are the decision, and each has a test:

1. **It merges into `current`. It never synthesizes.** The model set, provider,
   roles, transports, fallbacks, cost and selection rule carry through
   untouched. Only what an evaluation measures moves: quality, latency, context,
   modality and tool support, and `evaluatedAt` — on the document **and** on
   every entry it measured, since a header disagreeing with its rows would
   attest two different runs. A model in the eval-output that the registry does
   not carry is `EVAL_MODEL_UNKNOWN`, never an insertion: appointing a model is
   an editorial act, and this producer performs none.
2. **The key sets are the loader's, exactly.** No run identifier, no runner
   version, no metadata block. The loader would refuse those by name; the
   producer refuses them first, so the failure is legible where it was caused.
3. **It writes nothing.** It returns bytes, their digest and one pin row.
   Publishing is the operator's act and the operator's commit. A producer that
   could write the published paths could overwrite a version a route already
   recorded.
4. **`policyVersion` is an input.** Deriving it — from a clock, from a counter —
   would let two cuts in one day collide under one version, which is the exact
   lie the editorial law exists to prevent.
5. **Nothing here has earned a confidence above `LOW`.** This lane knows no
   runner that ever ran against a real subject, so `HIGH` and `MEDIUM` are
   refused as `EVAL_CONFIDENCE_UNEARNED` rather than published.

**The lane defines its own eval-output shape.** A JSON document of exactly two
keys — `models` and `accounting` — whose measured fields are the fields the
registry measures, and whose accounting block is
`{ runId, evaluatedAt, perProvider: [{ provider, transport, calls, tokensUsed,
observedAt }], subscriptionCalls }`. Any key outside those tables is refused by
name. It is not a vendor's format and it is not derived from one: whatever
produces evaluations in the future emits this shape, or an adapter from that
vendor to this shape is written as a separate, owner-gated packet.

**Consumption is accounted for or there is no cut.** A missing or malformed
block is `EVAL_CONSUMPTION_UNACCOUNTED`, and so is a declared subscription total
that does not equal the subscription calls actually declared — without that, a
run could reach a subscription and report zero of it. `tokensUsed` and
`observedAt` are `QuotaObservation`'s own names, reused rather than reinvented.

**A subscription run is refused unconditionally.** In R15 there is no lawful
value of the owner authorization, so `EVAL_SUBSCRIPTION_UNAUTHORIZED` fires on
any subscription consumption and on any attempt to claim the authorization seam
at all. Law 8 as a refusal in code rather than a promise in prose.

**Three fence laws make the shape checkable.**

- **L-R15-1** pins the root's dependency surface to exactly its seven dev names,
  with no runtime dependencies. Nothing pinned it before: `P1B_DEPENDENCY_LAW`
  covers nine package manifests and `LEDGER_DEV_DEPENDENCIES` a tenth, three
  package manifests have no exact-set law at all, and the root was asserted only
  for `private`, `license` and the absence of a second build allow-list. This is
  where "the lane has no vendor" stops being prose.
- **L-R15-3** reads `ENTRY_KEYS` and `DOCUMENT_KEYS` out of the loader as text
  and holds the producer's mirror tables equal to them in **both** directions,
  and refuses any third registry-shaped path the producer names. Two of the three
  ways to get a second registry are already caught at load — an extra document
  key and an extra entry key. The third is not: a sidecar written beside the
  document, which the loader never sees.
- **L-R15-4** holds the producer's consumption vocabulary equal to
  `QuotaObservation`'s members, both directions.

**The lane lives in `scripts/evals/`**, outside the workspace: `pnpm-workspace.yaml`
globs members exactly two levels under `packages/`, so no package can resolve
this module. It runs by explicit operator command; no CI job is added, because
the workflow's own contract says nothing there may diverge from `pnpm check`.

## Why adopting the evaluation runner anyway was not chosen

It was chosen, by the owner, and then unchosen by the owner on measurement. The
arguments for it were real: a maintained runner is more capable than anything
this repository would write, its output format is a thing other tools already
speak, and a dev-only dependency withdrawn later breaks no product pin.

The measurement outweighed them. 798 packages nearly triples a lockfile of 414
for a tool that runs by hand; seven install-script declarations in a repository
whose `.npmrc` turns install scripts off precisely so nothing phones home while
being installed; and an allow-list that would have been widened by inheritance
rather than by an edit anyone could review. The repository already refused this
trade once, and the refusal still holds: the durability server's npm package was
not adopted, because it pulls a telemetry package whose postinstall is a network
beacon — both are banned here by name, so this record describes them rather than
writing them — and the binary is fetched instead by an operator-invoked script,
verified against a tracked digest. `scripts/evals/` is the same answer to the
same question.

## Why a workspace package was not chosen

A `packages/tooling/evals` would be caught by the classification law — a package
no stratum classifies — and would need a stratum entry, a manifest with the G10
public/internal disposition, a tsconfig project reference and a
`P1B_DEPENDENCY_LAW` row. All of which is to say: it would put the lane **inside**
the package graph, which is the one place restriction 6 says it must not be.
`scripts/` is already where this repository keeps tooling the package graph
cannot see — the fence itself, the fence's probes, the operator-invoked
acquisition script, and two pinned data files.

## Why the producer does not write the files it produces

Returning bytes and a digest is less convenient than writing them. It is also the
only shape in which the producer cannot destroy a published version: the
editorial law says same content under a new version is a lawful re-cut and same
version under different content is invalid, and the second failure is
unrecoverable in the way that matters — every `capabilityPolicyVersion` already
written into a route or an event becomes a lie about what was in force.

The producer refuses the case it can see: `version` equal to the version in force
over content that moved is `EVAL_VERSION_REUSED`. The rest is the fence's, which
is the pin's only reader. A producer grading its own digest against history it
cannot see would be attesting itself, which is the same argument ADR 0051 makes
about the loader.

## Consequences

- Publishing a measured capability policy is now a producer run plus a two-file
  data edit, and no source edit at all. ADR 0018's promise and ADR 0051's
  mechanism finally have something to drive them.
- **R15 cuts no version.** `capability-policy.json` stays byte-identical and the
  pin keeps its two rows. Cutting one from a producer that no real run has fed
  would write invented measurements into the shipped registry.
- **What stays owner-gated**, and why it is owed rather than done: any run
  against a real provider; the first real cut; any confidence above `UNKNOWN` /
  `LOW`; and a `QUALITY_SCORE` selection in the shipped document, which today
  would refuse `POLICY_NO_MEASURED_MODEL` by design over an unmeasured registry.
  Each needs a drill with a real subject, and the measured reason the runner that
  would have produced it is absent is recorded above.
- The root's dependency surface is now pinned. Adding any dependency to the root
  — vendor, tool or otherwise — fails the build until an integrator edits
  `ROOT_DEV_DEPENDENCIES`, which is what the owner's authorization was always
  supposed to mean.
- The producer's key tables are a second copy of the loader's, and copies drift.
  L-R15-3 is the cost of that choice and the reason it is safe: a key added on
  either side and not the other fails the build, naming which side moved.
- `PATH_SCOPED_LAWS` stays at **117**. All three laws read named literals, so
  none registers a scope. The ADR corpus moves 55 → 56, and the write set gains
  four distinct paths.
- `vitest.config.ts` gains an `evals` project. Without it the producer's suite
  would be a file no command runs, and a suite that only runs under a command
  nobody types is not a gate.

## Not in this record

Which tool produces a real evaluation, and on what hardware — deferred to the
owner-gated packet that runs one, outside this repository's graph. Red-team and
jailbreak evaluations, named in restriction 6, measure no registry field and are
a separate packet. Whether the eval lane is ever wired into CI: the workflow
contract freezes that question behind an owner decision to amend it.
