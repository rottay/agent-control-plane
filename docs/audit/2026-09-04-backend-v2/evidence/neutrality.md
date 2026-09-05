# acp-neutrality — audit report (snapshot 4569478)

Read-only. `node scripts/check-architecture.mjs` passes;
`packages/edges/providers/test/contract/index.test.ts` passes 12/12. Nothing was
modified.

## Scores + justification

**Neutralidad de proveedores — 6/10.** The *boundary* is genuinely neutral:
`ModelExecutionPort`
(`packages/kernel/contracts/src/schemas/execution-boundary/index.ts:268-275`) is
implemented by one factory serving three transports
(`packages/edges/providers/src/execution-port/index.ts:477-558`), events are
normalized to one union (`execution-boundary/index.ts:132-191`), and the API and
local legs take client interfaces this repository owns with no member able to
carry a credential (`packages/edges/providers/src/api-key/index.ts:83-96`). No
SDK is imported. The *provider axis* is where it drops: `ProviderId` is a closed
three-tuple in the kernel (`execution-boundary/index.ts:46`) and the adapter
registry is a hand-written object keyed by `string`
(`packages/entrypoints/daemon/src/index.ts:1034-1038`), so the one site a new
provider must register is the one site the compiler will not force. The
transport axis, by contrast, is compiler-enforced end to end.

**Ausencia de duplicación / registries paralelos — 8/10.** There is a real
duplication gate, not a convention: a cross-package name scan with an
adjudication register that fails a stale entry as loudly as a live collision
(`scripts/check-architecture.mjs:8672-8749`), reporting `4 cross-package name
collision(s), all adjudicated; 1450 exported names scanned across 195 sources`.
There is exactly one versioned capability registry, digest-pinned per revision
(`scripts/check-architecture.mjs:11711-11751`). Repeated values move by
re-export, not by copy. The deduction is for what a *name* scan cannot see: two
names for one number, and one port in three homes.

## Findings

**N1 — the adapter registry is keyed by `string`, so adding a provider compiles
clean and silently serves nothing.** Class 1 (latent; the shipped three are all
present).
Evidence: `packages/entrypoints/daemon/src/index.ts:1034` declares
`const CLI_ADAPTERS: Readonly<Record<string, ProviderAdapter>>`. Widening
`CLI_SUBSCRIPTION_PROVIDERS` therefore produces no error here. At
`daemon/src/index.ts:1180` a missing key leaves `adapter === undefined`, no
binding is added, and `execution-port/index.ts:617-618` refuses
`TRANSPORT_UNAVAILABLE` at `route.accountId` — blaming the account for a missing
adapter. `CLI_ADAPTERS` appears in no test and in no fence law (grep over
`packages/*/*/test` and `scripts/`: zero hits). The correct idiom exists twice
in-tree: `PROVIDER_CONFIG_ENV` is `Record<ProviderName, string>`
(`providers/src/config-root/index.ts:37`) and the CLI's transport map is keyed by
the union (`cli/src/cli/index.ts:805-811`); both break at compile time.
Impact: a fourth provider ships as a misclassified refusal.
Minimal fix: key the map `Readonly<Record<ProviderName, ProviderAdapter>>`.
Phase: now, one line.

**N2 — `ProviderId` is a closed enum plus a hardcoded map, not the ruling's
validated descriptor with static registration.** Class 2.
Evidence: `docs/ROADMAP.md:764-765` rules "`ProviderId` extensible por
descriptor validado con registro estático en el composition root". The code is
`CLI_SUBSCRIPTION_PROVIDERS = ["claude","codex","kimi"] as const`
(`execution-boundary/index.ts:46`) plus the map at `daemon/src/index.ts:1034`.
No descriptor type and no registration function exists anywhere.
`scripts/check-architecture.mjs:13287` names the five provider directories by
hand, and `13415/13419/13423` pin the three adapter exports. No ADR (0010, 0014,
0018) records the ruling as discharged.
Impact: the roadmap and the code disagree about the extension mechanism.
Minimal fix: state the divergence in an ADR, or land the descriptor.
Phase: P9 planning.

**N3 — the registry is versioned, but only 5 of its 13 fields can change a
decision.** Class 2.
Evidence: `PolicyEntry` declares 13 fields
(`packages/domains/accounts/src/policy/index.ts:144-166`). The eligibility
predicate reads two — `eligibleRoles` and `transports` (`policy/index.ts:436`);
`routeWithPolicy` adds `model` and `allowedFallbacks` (`:476-489`);
`resolveRoute` adds `provider` (`resolution/index.ts:157`). Preference is
document order (`policy/index.ts:20-24`, `478`). `quality`, `latency`,
`contextTokens`, `supports`, `quotaConfidence`, `costPerMillionTokens`,
`release` and `evaluatedAt` are validated, frozen and never consulted.
Impact: a Promptfoo score written into `quality.score` is a lawful new registry
revision that changes nothing. To move a choice the editor must also reorder
`models[]`, so the evaluation and the decision it should drive are two
independent edits with nothing tying them.
Minimal fix: make `quality.score` the ranking key when confidence is not
`UNKNOWN`, with document order as the tiebreak.
Phase: before any measured evaluation lands.

**N4 — editing the shipped policy requires editing the fence script; the
"no source change" drill runs over a copy.** Class 2.
Evidence: `scripts/check-architecture.mjs:11711-11713` holds
`POLICY_VERSION_DIGESTS`; `11726-11742` fails a version with no pinned digest
("add its digest in the same commit") and fails changed bytes under an unchanged
version. Every content edit to
`packages/domains/accounts/policy/capability-policy.json` therefore needs a new
row in a `.mjs` source file. `docs/architecture/0018-the-submission-path.md:114-117`
claims the edit works "with a byte-identical source tree"; the drill proving it
copies the document to a temp directory first
(`packages/domains/runtime/test/submission/index.test.ts:239-241`, again at
`463-465`), where the fence never runs.
Impact: "sin cambios de código fuente" holds for the drill, not the shipped
document. The immutability guarantee is right; its storage location is not.
Minimal fix: move the digest register to a committed JSON data file.
Phase: next policy revision.

**N5 — two names for one number, and one port in three homes; the duplication
gate cannot see either.** Class 2.
Evidence: `TOOL_CALL_TIMEOUT_MS = 30_000`
(`packages/edges/tools/src/contract/index.ts:152`) and `TOOL_CALL_BOUND_MS =
30_000` (`packages/domains/runtime/src/tool-call/index.ts:196`), self-described
as a restatement forced by `RUNTIME_ALLOWED_PACKAGES`
(`tool-call/index.ts:186-195`). No gate pins the equality: the literal `30_000`
appears zero times in `scripts/check-architecture.mjs`. Port 7517 is declared
three times — `gateway/src/constants/index.ts:12`,
`runtime/src/constants/index.ts:35`, `console/vite.config.ts:27` — and 5178
twice (`runtime/src/constants/index.ts:38`, `vite.config.ts:36`). The fence
records these as "topology-forced" in a comment
(`check-architecture.mjs:8705-8708`) and asserts nothing; `OBSERVATION_API_PORT`
is never compared to `SERVER_DEFAULT_PORT` in any test.
Impact: the owner's dedup law demands one declaration *and* a duplication gate.
These have neither, and the name-based scan is structurally blind to them.
Minimal fix: assert the two equalities in the fence (a regex pair, four lines).
Phase: now.

**N6 — a vendor type reaches a public barrel and survives into the emitted
`.d.ts`.** Class 2.
Evidence: `packages/edges/durability/src/contracts/index.ts:27` declares
`export type DurableStepContext = Pick<Context, "run" | "rand" | "date">` over
`@restatedev/restate-sdk`. It is exported from the barrel
(`durability/src/index.ts:92`), and the built artifact keeps both the alias and
the SDK import (`dist/contracts/index.d.ts:25`, import at line 2). `durability`
is a public-stratum package (`check-architecture.mjs:89-95`, with
`PUBLIC_STRATA` excluding only `entrypoints` at line 8152). `GateRunContext` and
`GateResolveContext` are the same shape but stay off the barrel.
Impact: replacing Restate changes a published type, the one thing law 5 says
must stay replaceable. The narrowing to three members bounds the damage.
Minimal fix: declare the three members structurally and assert SDK conformance
in a driver-side test.
Phase: before any package is published.

## "Add Gemini" change list (CLI subscription)

Twelve files; only 3 sites are compiler-forced.

1. `contracts/src/schemas/execution-boundary/index.ts:46` — widen the tuple.
2. `contracts/test/schemas/index.test.ts:1478` — the list pin.
3. `providers/src/gemini/index.ts` — new adapter.
4. `providers/src/index.ts:149-169` — export adapter + protocol constant.
5. `providers/src/config-root/index.ts:37` — **compile-forced** (`Record<ProviderName, string>`).
6. `providers/test/contract/index.test.ts:20,30` — pin, plus the test *name* "three providers".
7. `providers/test/execution-port/index.test.ts:164,170,177` — **compile-forced**, three `Record<ProviderName, …>`.
8. `providers/test/gemini/index.test.ts` — new; the mirrored-topology law requires it.
9. `providers/README.md:39-41` — fence-checked against `PROVIDERS_PUBLIC_EXPORTS` (`check-architecture.mjs:16435-16438`).
10. `daemon/src/index.ts:1034` — **not** compile-forced. See N1.
11. `accounts/policy/capability-policy.json` — a model entry plus a new `policyVersion`.
12. `scripts/check-architecture.mjs` — four edits: `PROVIDER_DIRECTORIES` (13287), `PROVIDERS_PUBLIC_EXPORTS` (13321+), `POLICY_VERSION_DIGESTS` (11711), and a `*_WRITE_SET` entry per new path, since every tracked file must appear in one (`7035-7062`).

## "Add Grok" change list (API_KEY route)

Two data edits and one client implementation. **Zero contract changes and zero
provider-package source changes.** `ResolvedRoute.provider` is
`z.string().min(1).max(40)` (`execution-boundary/index.ts:93`) and the
`superRefine` constrains the name only for `CLI_SUBSCRIPTION` (`:105-114`).
`ApiStreamingClient` carries `provider: string` and `models: readonly string[]`
(`api-key/index.ts:85-95`); `admitApiRoute` matches them against the route
(`:117-130`).

- `capability-policy.json` — one entry with `transports: ["API_KEY"]`, a version bump, and its fence digest row.
- An `ApiStreamingClient` implementation, anywhere; the credential lives in its closure.
- A composition-root change so the port is built with `apiBindings`.

The last is missing today: `executionPortFor` (`daemon/src/index.ts:1172-1198`)
passes `bindings` only, so `apiBindings` is `undefined` and any API route is
refused `TRANSPORT_UNAVAILABLE` at `route.transportKind`
(`execution-port/index.ts:488`). That absence is Class 4 — planned, documented,
and correctly a classified refusal rather than a fallback
(`docs/architecture/0018-the-submission-path.md:143-152`).

## Fourth transport — cost

`TRANSPORT_KINDS` is closed at three (`execution-boundary/index.ts:29`), by
design. The cost is almost entirely compiler-enforced: the enum, two `switch`
blocks in `execution-port/index.ts` (477-558, 693-713) ending in `const
unreachable: never`, the CLI's union-keyed record (`cli/src/cli/index.ts:805-811`),
the contracts test pin, and the policy JSON's `transports` strings. Only the JSON
is manual. This is the axis the repository got right, and the template N1 should
follow.

## Duplication table

| Item | Declarations | Verdict |
| --- | --- | --- |
| `deriveInvocation` | 1 (`runtime/src/submission/index.ts:137`); `durability/src/submit/index.ts:37` re-exports | correct |
| `DaemonSubmission`, `canonicalSubmission*` | 1 (runtime); `daemon-child/index.ts:143-145` re-exports | correct |
| `TOKENS_USED_MAX` | 1 (contracts); accounts `quota:119`, observation `baseline:33`, providers `events:78` re-export | correct, unified by D2 |
| `TOOL_CALL_BOUND_MS` / `TOOL_CALL_TIMEOUT_MS` | 2 names, one value, no gate | **defect** (N5) |
| port 7517 | 3 (gateway `constants:12`, runtime `constants:35`, `console/vite.config.ts:27`) | **defect**, prose-adjudicated only |
| port 5178 | 2 (runtime `constants:38`, `vite.config.ts:36`) | **defect**, same shape |
| `EXIT_OK` / `EXIT_USAGE` | 1 (`contracts/.../exit-codes/index.ts:22,25`) | correct, unified by D1 |
| other `EXIT_*` | 1 each, per entrypoint | correct, per-process (`exit-codes:15-18`) |
| 18 `*_REFUSALS` arrays | 18 bounded vocabularies | correct, no shared taxonomy wanted |
| refusal payload key | 2 shapes: `refusal` (contracts, scheduler) vs `reason` (accounts, ledger, gateway, launchd) | **minor defect**, one idea two names |
| `ProviderName` vs `ResolvedRoute.provider` | derived type vs `z.string()` | correct (`execution-boundary:102-104`) |
| `WorkerRole` / `TOOL_WRITE_ROLES` | 2, gated as strict subset (`check-architecture.mjs:14464-14496`) | correct |
| `CONTROL_PLANE_EVENT_TYPES` / `FROZEN_TYPE_BY_EVENT` / `STREAM_CHANNEL_BY_EVENT_TYPE` | 1 union + 2 type-exhaustive maps | correct, both break at compile time |
| `Ledger` / `LedgerPort` / `LedgerLike` | 1 class + 2 narrowings (`step-executor:43`, `durability/contracts:132`) | acceptable, but no gate proves `Ledger` still satisfies both |
| `DaemonSubmission` / `DaemonExecutionConfig` / `ScheduledWalk` | 3 distinct concepts | not duplication |
| `SessionRequest` vs `ExecutionRequest` | 2, deliberately split (`execution-port:88-100`) | correct |
| `TRANSPORT_KINDS` contracts vs CLI-local | 2, CLI's is union-keyed and unexported | acceptable, name shadow only |
| `CLI_ADAPTERS` keys vs `CLI_SUBSCRIPTION_PROVIDERS` | 2, ungated, `string`-keyed | **defect** (N1) |

## Verified claims that hold

- `PROVIDER_NAMES` is derived from the kernel list, not declared
  (`providers/src/contract/index.ts:26,35`), pinned in both directions by
  assertions rather than by a test name
  (`providers/test/contract/index.test.ts:44-54`).
- `@restatedev/restate-sdk` appears under no import specifier outside
  `packages/edges/durability/src` — grep-verified across every `src` tree, and
  fenced by allowlist (`check-architecture.mjs:10098-10103`).
- `better-sqlite3` appears only in `packages/persistence/ledger/src/{ledger,
  migrations,lease-store,tool-claim-store}`, and `Database` is **not** on the
  ledger barrel — grep-verified.
- `routeWithPolicy` is the only producer of `capabilityPolicyVersion`
  (`policy/index.ts:508`), asserted by a source-reading test
  (`accounts/test/resolution/index.test.ts:487-491`).
- "The elector is not the walk" holds mechanically: the fence reports `20 daemon
  production sources name none of @acp/accounts, resolveRoute,
  loadPolicyRegistry, composeSubmission`, and the digest pin fires.
- The policy *is* reachable from a shipped binary — `acp submission`
  (`cli/src/cli/index.ts:904-1014`), not tests only. It rewrites a config
  document on stdout; the daemon still receives a pre-resolved route.
- `zod` is a declared dependency of both kernel packages, so the emitted `.d.ts`
  is self-contained. Zod schemas as public kernel API are acceptable —
  validation *is* that package's job.
- Fastify types are on the gateway's public signatures (`build-server:88`,
  `start:33`), but `gateway` is an entrypoint, excluded from `PUBLIC_STRATA`
  (`check-architecture.mjs:8152`). Inside the internal boundary.

## Open questions

1. Is `CLI_SUBSCRIPTION_PROVIDERS` the discharge of the descriptor ruling, or is
   the descriptor owed to P9? No ADR records either.
2. Who runs `acp submission` in production, and does anything re-elect between
   attempts? Today a human step sits between a policy edit and a run.
3. Should `POLICY_VERSION_DIGESTS` live in the fence script at all?
4. Are `quality`, `latency`, `contextTokens` and `costPerMillionTokens` meant to
   become ranking inputs, or is the registry evidence-only by design?
