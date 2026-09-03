# ADR 0018 — The submission path elects the route, and the walk still does not

- Status: accepted (V2-B7S, recorded 2026-09-03).
- Supersedes: none.
- Superseded-by: none.

## Context

`resolveRoute` has existed since V2-B1a and has had **zero** production
consumers. The policy document, the accounts registry, the quota estimator, the
router and the resolver are all real and all drilled; what has been missing is a
caller. Production has run on a route a human typed into a JSON config file, and
the V2 gate criterion `model switch por política sin código` therefore had no
producer at all.

The obvious place to wire the resolver in — the daemon, where the route is
already consumed — is the one place it may not go. D5
(`.acp-local/v2-b1b-brief.md:83-93`) records the decision in its own words:

> "The alternative (the daemon resolves in-process from an accounts file) was
> weighed and rejected for B1b: `RoutingRequest` composition … **belongs to the
> submission path, not the walk**; `resolveRoute`'s first cross-package consumer
> is the conformance fixture, and **the production resolver arrives with the
> CLI/API submission path**. Recorded here so the deferral is a decision, not an
> omission."

and the B1b stage-2 commit `0418cae` carries it into tracked history verbatim:

> "Record note: **resolveRoute's production wiring lands with B3's submission
> path** — until then its consumers are the fixtures, a deliberate staging
> recorded here."

So D5 did not defer election indefinitely. It forbade **the walk** electing and
named where the elector belongs. This record is that home being built. D5 is
discharged as written: not reversed, not reinterpreted, not worked around.

One mechanical knot had to be untied first. The composition root must compute
`submissionDigest`, because the daemon's config door refuses a declared digest
that is not exactly the computed one — and the digest producer was pinned by a
fence law to a single file inside the daemon.

## Decision

**The composition root is `@acp/cli`, as one new verb: `acp submission`**
(D-B7S-1 = alpha). It reads a daemon config document, an accounts file and a
capability policy document; elects provider, model, account and policy version
through `resolveRoute`; composes the submission; computes its digest; and prints
the updated config document on stdout. It opens no ledger, writes no file, and
changes no existing verb's behaviour or exit code.

**The producer moved; the door did not.** `canonicalSubmission`,
`canonicalSubmissionDigest` and the submission type are now declared in
`packages/domains/runtime/src/submission/index.ts`, alongside the new pure
`composeSubmission`. `packages/entrypoints/daemon/src/daemon-child/index.ts`
**re-exports** them. The `expectedDigest` computation and the
`submissionDigest !== expectedDigest` refusal are byte-unchanged and still live
in the daemon.

Three properties make that split safe rather than merely convenient:

- A re-export is not a declaration, so there is still exactly **one** producer.
  The fence's one-producer arm is now pinned to the runtime module, its
  six-route-field arm reads the runtime module, and its door arm reads the
  daemon module. All three arms survive; the law became more precise, not
  weaker.
- All five daemon test files import these names through
  `src/daemon-child/index.js` and needed **no edit**. `daemon/test/fallback`,
  which B2-4a certifies as untouched, was never opened by this packet.
- `@acp/runtime` already depended on `@acp/accounts` and `@acp/ledger`, in both
  the manifest and `RUNTIME_ALLOWED_PACKAGES`, so the elector reaches
  `resolveRoute` with zero dependency churn — and nothing anywhere gained a
  dependency on `@acp/daemon`.

**`composeSubmission` is pure.** Values in, a value out: no clock, no file, no
environment. `resolvedAt` is a parameter for the same reason it is a parameter
of `resolveRoute` — a route lands in a ledger event, and nothing that lands in a
ledger event may depend on when the code happened to run. Loading the two
documents is the CLI verb's job, one layer out, where a filesystem is allowed to
exist.

**The daemon is behaviourally unchanged.** It still receives an admitted route
it did not resolve, through the same door, compared against the same digest. A
new fence law, **L-B7S — "the elector is not the walk"**, makes that mechanical:
no daemon *source* may name `@acp/accounts`, `resolveRoute`, `loadPolicyRegistry`
or `composeSubmission`. Daemon *tests* still may, which is what the conformance
fixture has done since B1b.

## Why a gateway write route was not chosen

Option β was a third write route, `POST /api/v1/submissions`. The gateway
already consumes `@acp/accounts` in production and already owns a bearer-guarded
registrar, so it would have worked. It was rejected: `API_WRITE_ROUTES` would
grow 2 → 3, `@acp/protocol`, the gateway and `docs/api-reference.md` would all
move, and — the decisive objection — the observation plane would acquire an
orchestration decision. A read surface that elects is no longer a read surface.

The CLI leg lands first and the API leg stays available as a later symmetric
packet; nothing in this record forecloses it.

## Why a new `entrypoints/composer` package was not chosen

Option γ had the cleanest identity and the worst size: a manifest, a tsconfig, a
`pnpm-workspace.yaml` entry, a fourteenth vitest project, a `PACKAGE_STRATA` row,
a public/internal classification, a new import-purity law and a README — roughly
twelve scaffold paths before a line of product code, for one function. The CLI's
identity widens honestly instead, from observation to observation-and-planning,
and this record is where that widening is stated rather than left to drift.

Both alternatives are recorded here as adjudicated and closed. Neither is
re-argued.

## Consequences

- Editing `packages/domains/accounts/policy/capability-policy.json` changes the
  elected model with a byte-identical source tree, and the recorded
  `capabilityPolicyVersion` moves with it. That is the V2 gate criterion, and it
  is drilled twice — in process and through the verb — over a **copy** of the
  shipped document, with the shipped document's digest asserted unchanged across
  both runs.
- A re-elected route cannot resume an in-flight attempt. The route is inside the
  submission preimage, so a new election is a new digest, step 0 rebuilds to
  different bytes, and the B1c continuity guard refuses. This packet strengthens
  that path and does not weaken it.
- The CLI gains exactly two workspace edges, `@acp/accounts` and `@acp/runtime`,
  declared in the manifest, in `CLI_ALLOWED_PACKAGES`, in the dependency law and
  in the lockfile's `importers` block — which is where a pnpm workspace edge is
  actually materialized.
- `@acp/runtime`'s closed export surface grows by eight names, pinned by
  equality in both directions.

**Transport is not electable from the shipped document, and this record says so
plainly rather than implying otherwise.** Every model in
`capability-policy.json` version `2026-08-30.1` declares
`transports: ["CLI_SUBSCRIPTION"]` and nothing else. A policy edit can therefore
move provider, model and account, but it **cannot** elect `API_KEY` or
`LOCAL_OR_SELF_HOSTED`. Transport equivalence stays proven where it was proven —
at the port level, by substituting the transport in the B1b conformance fixture
— and not by election. The packet drills what happens if a policy were edited to
make a non-CLI transport electable: the port refuses `TRANSPORT_UNAVAILABLE` at
`route.transportKind`, from the port and never from the composer.

**The equivalence this packet proves is CLI/in-process only.** The verb's stdout
document and an in-process `composeSubmission` over the same inputs and the same
injected instant produce the same digest. There is no API submission leg in this
repository, so nothing here is three-way equivalence and nothing here should be
read as such.

## Not in this record

- No lease fold and no `acquireLease` in the walk. That needs a ledger lease
  projection that does not exist, and it is a different subject. Owed to B7-L.
- No `TASK_FAILED` on the supervisor's throw path, and no `TOKEN_USAGE_RECORDED`
  from the port's usage events. Both edit `step-executor` and the supervisor,
  which this packet does not touch. Owed to B7-T.
- No scheduler, no queue, no slot pool. `DaemonOptions` names one task and one
  attempt, and that is unchanged.
- No API submission leg, and no gateway change of any kind.
