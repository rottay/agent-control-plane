# The eval lane

The producer of immutable versions of the capability registry. Dev-only,
operator-invoked, and dependency-free.

This lane does not run evaluations. It **turns the output of one into a lawful
version of the registry that already exists** — and refuses everything else.

## What is here

| Path | What it is |
| --- | --- |
| `registry-cut.mjs` | the producer: one pure function, plus an entry point that reads only the paths an operator names |
| `registry-cut.test.mjs` | its probes, run by the `evals` project in `vitest.config.ts` |

## The four laws of this lane

**Dev-only, and outside the package graph.** `pnpm-workspace.yaml` globs
workspace members exactly two levels under `packages/`, so nothing in the package
graph can resolve anything here. `L-R15-2` — no such law exists, and that is the
point: containment is structural, not a rule someone has to remember.

**No dependency, ever.** `L-R15-1` in the architecture fence pins the root's
`devDependencies` to exactly seven names and forbids the root any runtime
dependency at all. Nothing in this lane may add one. That law is why the section
below exists.

**Operator-invoked, never automatic.** There is no CI job and no lifecycle hook.
`.github/workflows/ci.yml` says nothing in it may diverge from `pnpm check`, and
`pnpm check` does not cut policy versions. Nothing here runs unless a person
types it.

**Output lands under `.acp-local/`.** That directory is gitignored and the fence
asserts it stays ignored. The write-set conformance law counts untracked files,
so an eval output left anywhere else fails the build with "path is outside the
exact write-set" — which is the correct outcome, not an inconvenience.

## Why there is no evaluation runner here

Because its graph was measured, and the owner refused it.

An owner ruling on 2026-09-07 authorized a hosted evaluation runner as a root
devDependency. The install was performed under that authorization, audited, and
fully reverted. The audit found:

- **798 packages added** to a lockfile of 414, for a tool that runs by hand;
- **seven of them declaring install-time lifecycle hooks**, in a repository whose
  `.npmrc` sets `ignore-scripts=true` precisely so nothing runs at install time;
- one of those seven a **second major of `better-sqlite3`** — the only name
  `onlyBuiltDependencies` carries. That allow-list matches by name, not by
  version, so a dev tool's transitive copy would have inherited the native-build
  authorization granted to the ledger's engine **without adding a name**: the law
  textually unchanged, its meaning quietly widened.

The owner revoked the authorization on the strength of that measurement, on the
same day. This lane produces registry versions without a vendor, and a real
runner stays owner-gated and run **outside this repository's graph**. See ADR
0056.

## The eval-output shape

This lane's own, not a vendor's. Two keys, exactly:

```json
{
  "models": [
    {
      "model": "haiku",
      "quality": { "score": 0.91, "confidence": "LOW" },
      "latency": { "p50Seconds": 1.4, "confidence": "LOW" },
      "contextTokens": 200000,
      "supports": { "tools": "YES", "vision": "NO", "streaming": "YES" }
    }
  ],
  "accounting": {
    "runId": "2026-09-07-a",
    "evaluatedAt": "2026-09-07T00:00:00.000Z",
    "perProvider": [
      {
        "provider": "claude",
        "transport": "CLI_API",
        "calls": 40,
        "tokensUsed": 128000,
        "observedAt": "2026-09-07T00:00:00.000Z"
      }
    ],
    "subscriptionCalls": 0
  }
}
```

Every key is in the table below, and **any key outside it is refused by name**.
An eval-output may not smuggle a run identifier, a tool version or a metadata
block into a document the loader would refuse anyway.

| Key | Meaning |
| --- | --- |
| `models[].model` | the model measured. It must already exist in the document being merged into |
| `models[].quality` | `score` (a non-negative number or `null`) and `confidence` |
| `models[].latency` | `p50Seconds` (a non-negative number or `null`) and `confidence` |
| `models[].contextTokens` | a non-negative number, or `null` |
| `models[].supports` | `tools`, `vision`, `streaming`, each `YES`, `NO` or `UNKNOWN` |
| `accounting.runId` | what run this was |
| `accounting.evaluatedAt` | when it ran |
| `accounting.perProvider[]` | `provider`, `transport`, `calls`, `tokensUsed`, `observedAt` |
| `accounting.subscriptionCalls` | the total subscription calls, which must equal the calls actually declared on subscription transports |

`tokensUsed` and `observedAt` are `QuotaObservation`'s names, reused rather than
reinvented; `L-R15-4` holds the two vocabularies equal in both directions.

Any future runner emits **this** shape. An adapter from some vendor's format into
this one would be a separate, owner-gated packet — not a widening of this lane.

## What a cut is

A cut is a `(document bytes, policyVersion, SHA-256)` triple such that the
version is new, the document still satisfies the loader's key tables, and the
digest is appended as a row to the pin.

```
cutRegistryVersion({ current, evalOutput, version, evaluatedAt, consumption })
  -> { ok: true, document, digest, pinRow }
   | { ok: false, reason, at }
```

- `current` — the document being merged into, parsed. Everything editorial in it
  carries through: the model set, providers, roles, transports, fallbacks, cost,
  and the selection rule. A measurement may not appoint a model or grant it a
  role.
- `version` — **always the caller's.** Deriving it from a clock would let two
  cuts in one day collide under one version, which is the exact lie the editorial
  law exists to prevent.
- `evaluatedAt` — written to the document header **and** to every entry the run
  measured. A header that disagreed with its rows would attest two runs.
- `consumption` — the seam an owner authorization would arrive through. **In R15
  no value of it is lawful**, so claiming one is itself the refusal.

**The producer writes nothing.** It returns bytes and a digest; writing them is
the operator's act:

```sh
node scripts/evals/registry-cut.mjs \
  --current=/abs/path/to/capability-policy.json \
  --eval-output=/abs/path/to/eval-output.json \
  --version=2026-09-08.1 \
  --evaluated-at=2026-09-08T00:00:00.000Z > /abs/path/to/candidate.json
```

Absolute paths only, no defaults and no discovery — the same hermeticity law the
loader holds, for the same reason. The digest and the pin row are written to
stderr. Publishing them is two data edits and a commit: the document at
`packages/domains/accounts/policy/capability-policy.json`, and one appended row
in `scripts/policy-version-digests.json`. The fence is what checks the pair.

## The refusals

| Refusal | When |
| --- | --- |
| `EVAL_REGISTRY_INVALID` | the document being merged into is not one |
| `EVAL_VERSION_INVALID` | no version was supplied |
| `EVAL_VERSION_REUSED` | the version in force, republished over content that moved |
| `EVAL_OUTPUT_INVALID` | the eval-output is malformed at the named path |
| `EVAL_UNKNOWN_KEY` | a key outside the tables above, at any level |
| `EVAL_MODEL_UNKNOWN` | a model the registry does not carry. Adding one is editorial, not measured |
| `EVAL_MODEL_DUPLICATE` | the same model measured twice in one output |
| `EVAL_CONFIDENCE_UNEARNED` | a confidence above `LOW` |
| `EVAL_CONSUMPTION_UNACCOUNTED` | the accounting block is absent, malformed, or does not add up |
| `EVAL_SUBSCRIPTION_UNAUTHORIZED` | any subscription consumption, or any claim on the authorization seam |

## What is owner-gated, and therefore owed

None of this is a limitation of the producer. Each is a measurement nobody has
taken, and taking it needs a decision that is not a writer's.

- **A run against a real provider.** Restriction 6 and law 8. The tool that
  produces it is chosen then, and it runs outside this repository's graph.
- **The first real cut.** R15 publishes nothing: `capability-policy.json` is
  byte-identical and the pin keeps its two rows. Cutting from a producer no real
  run has fed would write invented measurements into the shipped registry.
- **Any confidence above `UNKNOWN` / `LOW`.** Restriction 5: `CONFIRMED` only by
  a drill with a real subject. The producer's ceiling is `LOW` and raising it is
  an owner decision backed by that drill, not an edit here.
- **A `QUALITY_SCORE` selection in the published document.** A measuring rule over
  an unmeasured registry refuses `POLICY_NO_MEASURED_MODEL` by design, so this
  follows the first real cut and never precedes it.
