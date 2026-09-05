# acp-structure — audit report (snapshot 4569478)

Target: an isolated scratchpad copy of the repository, HEAD
`456947875c453269ab7d105fa5088e947bc3cb90`, working tree clean, verified before and
after. All paths below are snapshot-relative. Nothing was written outside this report.

## Score + justification

**6 / 10 — mantenibilidad/legibilidad estructural.**

The package rank is excellent and the folder rank is unfinished. Five strata
(`kernel, persistence, domains, edges, entrypoints`) are declared once in
`scripts/check-architecture.mjs:89` (`PACKAGE_STRATA`) and asserted in both
directions, so a `domains → edges` import is mechanically refused. Three of the
owner's laws are honored perfectly and measurably: **195 of 195** `src` files are
named `index.ts(x)`, **zero** `export *` in any of the 13 root barrels, and
**zero** `*.test.*` under any `src`. That beats the Rottay reference modules.

What costs four points is that the criterion the owner stated most specifically —
*"when two or three folders mean something similar they are grouped into a
level"* — is unmet in 11 of 13 packages. Measured as top-level `src` folders over
total `src` files, no intermediate family level exists except in
`kernel/contracts` (0.05) and `entrypoints/console` (0.19). Gateway sits at 0.95,
ledger 0.91, tools 0.90. A ratio near 1.0 means one folder per file: a flat bag
wearing folder syntax. Add a 1,216-line "barrel", five things named contract(s),
a production folder called `toy`, and packet-id narration in 143 of 195 files,
and a contributor can locate a file but cannot read the architecture off the tree.

## Findings

### S1 — The daemon's public barrel is a 731-line composition root
**Class 1 (real blocking).**
**Evidence.** `packages/entrypoints/daemon/src/index.ts` is 1,216 lines: 30 imports,
13 local declarations, `startDaemon` spanning 274–1005, plus the adapter table
(`CLI_ADAPTERS`, 1034), conformance gate (1092), execution port (1173) and lock
resource (1204). `docs/ROADMAP.md:378` states the law it breaks: *"el `src/index.ts`
raíz de cada paquete es sólo un barrel público estable"*. Every domain and edge
barrel obeys it (0 imports, 0 declarations);
`packages/entrypoints/gateway/src/index.ts` is the model at 19 lines, 5 exports.
**Impact.** The file a newcomer opens first is the one that hides the wiring.
Nothing can be swapped without editing the public surface.
**Minimal fix.** Move lines 122–1216 to `src/composition/index.ts`; the barrel
re-exports `startDaemon`, `stopDaemon`, `terminateDaemon` and the types. One file
added, no symbol renamed, no fence register touched.
**Phase.** Immediate; independent of every other finding.

### S2 — Eleven packages have no family level
**Class 2 (improvement).**
**Evidence.** Top-level `src` dirs / files: gateway 18/19, runtime 17/22, daemon
17/20, providers 14/16, ledger 10/11, tools 9/10, accounts 7/8, observation 7/11.
Runtime's 17 siblings are `cancellation, commit-authorization, conflict-graph,
constants, contracts, core, drivers, enforcement, errors, execution-effects,
failure, submission, switch-executor, tool-call, tool-receipt, toy, usage` — a walk
order with no precedence, in which `tool-call` is a peer of `constants`.
**Impact.** The first level answers "what files exist", not "what this package is".
**Minimal fix.** One grouping level per package (target tree below). Pure directory
moves; `index.ts` names and export lists unchanged.
**Phase.** After S1, before any new packet.

### S3 — Two accepted ADR decisions never landed; a third record is already stale
**Class 2 (improvement).**
**Evidence.** ADR 0014 (accepted, `docs/architecture/0014-repository-topology.md:130`)
decided *"The drill machinery moves from `toy/` to `scenarios/`, off the main barrel
and onto the `@acp/runtime/scenarios` subpath"*, and at line 138 that
*"`runtime/src/constants/` becomes `kernel/contracts/src/topology/`"*. Neither
landed: `packages/domains/runtime/src/toy/repository/index.ts` (392 lines) is still
exported at `packages/domains/runtime/src/index.ts:200-201`; the package declares
only the `"."` export, so the subpath does not exist; and
`packages/kernel/contracts/src/schemas/` has no `topology` folder. ADR 0015's strata
table (accepted 2026-09-02) also lists `edges: providers, durability` while
`PACKAGE_STRATA` lists three, including `tools`.
**Impact.** The normative record describes a tree that does not exist, misleading
anyone who trusts the ADR corpus about the two most-questioned folders.
**Minimal fix.** Land 0014's two moves, or amend it with a record saying they were
deferred. Add `tools` to 0015's table.
**Phase.** With S2 (same moves).

### S4 — Packet-id narration in 143 of 195 source files
**Class 1 (real blocking, against the owner's standing law).**
**Evidence.** 539 lines under `packages/*/src` match `P<n>…`/`V2…`/`G<n>`, over 143
of 195 files; 1,028 lines over 242 files including `test`; the fence adds 816, for
1,844 repo-wide. (The lead's 1,322 does not reproduce under a word-boundary packet
regex — I report both scopes rather than the difference.) Comment ratio runs 18.2 %
(console) to 41.8 % (runtime, durability). Three quotes:

- `packages/domains/runtime/src/index.ts:313` — `// V2-B4b stage 2: the durable tool-call receipt. The seam between the tool edge`
- `packages/persistence/ledger/src/index.ts:41` — `// P8-8D-pre: the content-addressed artifact store. The Checkpoint law's twin —`
- `packages/entrypoints/cli/src/index.ts:22` — `// V2 X1b. A lost claim is a seventh answer, and it is on the barrel for the`

**Impact.** The Rottay `no-change-narration-comments` law, violated at scale. The
prose is often good and the reasons worth keeping, but every sentence is stamped
with a build-order id no outside contributor can resolve.
**Minimal fix.** A mechanical sweep deleting only the leading packet token and its
separator (`// V2-B4b stage 2: the durable…` → `// The durable…`). 539 lines in
`src`, no semantic edit, one commit so review is a diff of prefixes.
**Phase.** Any time; touches no structure and no export.

### S5 — Five different things are named "contract(s)"; ports are split three ways
**Class 2 (improvement).**
**Evidence.** `kernel/contracts` (shared schemas), `domains/runtime/src/contracts`
(the `OrchestrationDriver` port and coordinate types), `edges/durability/src/contracts`
(Restate gate literals and driver options), `edges/tools/src/contract` (tool
vocabulary and byte limits) and `edges/providers/src/contract` (provider vocabulary
and session state machine) — plural and singular both in use. The 13 port
declarations land in three strata and six folders (see the table below);
`edges/providers` declares `ProviderAdapter` and `AgentHarness` with **no**
corresponding domain port.
**Impact.** "The path explains what the file does" fails on the word that appears
most. Providers is the only adapter whose seam is defined by its implementation.
**Minimal fix.** Rename by role: `runtime/src/ports/`, `durability/src/restate-gate/`,
`tools/src/vocabulary/`, `providers/src/vocabulary/`. Reserve "contracts" for the
kernel. Declare the provider port in `domains/runtime/src/ports/`.
**Phase.** With S2.

### S6 — Test scaffolding duplicated across packages and invisible to the fence
**Class 2 (improvement).**
**Evidence.** `makeRandom`, `intBetween`, `pick` and `forAll` are byte-identical
(23 lines; one doc comment differs) between
`packages/kernel/protocol/test/routes/helpers/index.ts` and
`packages/persistence/ledger/test/canonical-json/helpers/index.ts`. `foldLiveLeases`
is near-identical between `packages/domains/runtime/test/pilots/helpers/index.ts`
and `packages/domains/accounts/test/pilots/helpers/index.ts`. The fence's duplication
scanner filters to `src` only (`scripts/check-architecture.mjs:8752`), so none of it
is measured. Scaffolding also carries four names for one concept: `pilots` (runtime,
accounts), `drills` (daemon, durability), `testing` (providers, tools), `helpers`
(four locations).
**Impact.** 71,002 test lines against 55,261 src lines, with the shared parts
unadjudicated. A seeded-PRNG fix must be applied twice.
**Minimal fix.** Add `/test/` to the scanner's filter and adjudicate the hits in
`DUPLICATION_ADJUDICATED`, or add `packages/kernel/testkit`. Pick one noun.
**Phase.** After S2.

## Per-package tree verdicts

| Package | top-dirs / files | ratio | verdict |
|---|---|---|---|
| `kernel/contracts` | 1 / 19 | 0.05 | **Family tree.** All under `schemas/`. The model. |
| `kernel/protocol` | 4 / 5 | 0.80 | Flat but only 5 files; 2,156 lines in one `schemas/index.ts`. Split by resource. |
| `domains/runtime` | 17 / 22 | 0.77 | **Flat bag, worst case.** `core/` a bucket, `toy/` production, `constants/` an entrypoint concern. |
| `domains/accounts` | 7 / 8 | 0.88 | Flat but coherent — all seven are account lifecycle. Acceptable. |
| `domains/observation` | 7 / 11 | 0.64 | Best domain. `collect/{artifact,scenario}`, `telemetry/langfuse` nest properly. |
| `persistence/ledger` | 10 / 11 | 0.91 | **Flat bag.** Three `*-store` siblings ungrouped; `types/` is 28 interfaces in 362 lines. |
| `edges/durability` | 4 / 7 | 0.57 | Adequate. `submit/` vs runtime's `submission/` is a real collision. |
| `edges/providers` | 14 / 16 | 0.88 | **Flat bag.** Four adapters sit as peers of `errors` and `redact`. |
| `edges/tools` | 9 / 10 | 0.90 | **Flat bag.** Four transports never grouped. |
| `entrypoints/daemon` | 17 / 20 | 0.85 | **Flat bag** plus the 1,216-line barrel (S1). |
| `entrypoints/gateway` | 18 / 19 | 0.95 | **Flattest.** `aggregates`/`mappers`/`query-schemas`/`ledger-source` are one read-model family. |
| `entrypoints/cli` | 4 / 5 | 0.80 | Fine at this size. Barrel runs argv under a guard: soft P5N violation. |
| `entrypoints/console` | 8 / 42 | 0.19 | **Family tree.** `components`, `views`, `api`, `hooks`, `format`, `routing`, `styles`, `app`. Best in repo. |

## Vocabulary / port placement

| Concern | Where it lives now | Where it belongs |
|---|---|---|
| `LIFECYCLE_STATES`, `TERMINAL_STATES`, `EXECUTION_REFUSALS`, `DRIVER_*` | `kernel/contracts` (17 of 50 vocabularies) | correct |
| `API_ROUTES`, `API_ERROR_CODES`, `HEALTH_STATES`, `STREAM_RESYNC_REASONS` | `kernel/protocol` | correct |
| 6 × `*_REFUSALS` in accounts, 4 in runtime, 3 in ledger, 2 in gateway | per package | correct — each is a bounded-context union; the fence already adjudicates the `refuse` builders |
| `LOOPBACK_HOST`, `RESTATE_*_PORT`, `UI_PORT`, `OBSERVATION_API_PORT`, `RESERVED_LOOPBACK_PORTS` | `domains/runtime/src/constants` — consumed only by `edges/durability` and `entrypoints/daemon`, never by runtime itself | `kernel/contracts/src/topology/` (ADR 0014 already decided this) |
| `RESTATE_OBJECT_NAME`, `RESTATE_HANDLER_ADVANCE`, `RESTATE_HANDLER_READ_CACHE` | same file, a domain | `edges/durability` — they name one driver's handlers |
| `ModelExecutionPort` (`kernel/contracts/src/schemas/execution-boundary/index.ts:268`) | `kernel/contracts` | correct (contract rank) |
| `LedgerPort`, `EffectPort` (`runtime/src/core/step-executor/index.ts:43,56`), `ToolCallPort`, `ToolClaimPort` (`runtime/src/tool-call/index.ts:160,281`), `GitReadPort` (`runtime/src/enforcement/index.ts:81`), `OrchestrationDriver` (`runtime/src/contracts`) | 4 runtime folders | one `domains/runtime/src/ports/` |
| `ProviderAdapter` (`providers/src/contract:248`), `AgentHarness` (`providers/src/harness:84`) | `edges/providers` only — **no domain port** | declare the port in `domains/runtime/src/ports/` |
| `ToolProtocolPort` (`tools/src/port:74`) | `edges/tools` | port and adapter in one edge; move the port to the domain |
| `LeaseStore`, `ToolClaimStore` | `persistence/ledger` | correct (the store *is* the adapter) |
| `errors/` folders | 7 packages have one, 6 do not; 38 error classes total | one per package, or none |

## Proposed target tree

```
packages/
  kernel/
    contracts/src/{schemas/*, topology/, ports/execution/}          # +topology (ADR 0014)
    protocol/src/{routes/, schemas/{task,worker,event,integrity,stream,accounts}/, parity/, version/}
    testkit/src/{random/, fixtures/}                                 # new: kills S6 duplication
  persistence/
    ledger/src/
      core/{ledger, migrations, projection, canonical-json}/
      stores/{artifact, lease, tool-claim}/
      read-model/{types, roadmap-version}/
      errors/
  domains/
    runtime/src/
      ports/{ledger, effect, tool-call, tool-claim, git-read, orchestration-driver, provider}/
      model/{coordinates, events, lifecycle}/
      execution/{step-executor, execution-effects, switch-executor, submission, cancellation, failure}/
      authorization/{commit, enforcement, conflict-graph}/
      tools/{call, receipt}/
      usage/
      scenarios/                       # was toy/repository — own subpath export, off the main barrel
      errors/
      # drivers/sqlite-supervisor* -> edges/durability   (a driver is an edge)
      # constants/ -> kernel/contracts/src/topology/ + edges/durability
    accounts/src/{policy, quota, registry, resolution, routing, switching, errors}/   # unchanged
    observation/src/{baseline, collect/*, rollups, roots, shadow-ledger, telemetry/*, errors}/  # unchanged
  edges/
    durability/src/
      restate/{driver, endpoint, child, gate, submit}/
      sqlite/{supervisor, supervisor-child}/              # from domains/runtime/drivers
      server-handle/
    providers/src/
      adapters/{claude, codex, kimi, local, api-key}/
      runtime/{harness, session, events, execution-port, process/{spawn, handle}}/
      admission/{config-root, redact}/
      vocabulary/                                        # was contract/
      errors/
    tools/src/
      transport/{stdio, http-loopback, jsonrpc, client}/
      policy/{admission, port, operation, receipt}/
      vocabulary/                                        # was contract/
  entrypoints/
    daemon/src/
      composition/                                       # was the 1,216-line index.ts body
      process/{bin/*, child, signals, singleton, lifecycle, launchd/*}/
      supervision/{arbiter, scheduler, git-observer, identity-probe}/
      modes/{restate, sqlite}/
      observability/{log, status}/
      shared/{constants, paths, errors}/
    gateway/src/
      http/{bin, build-server, start, routes, stream, bearer}/
      resources/{accounts, account-actions, initiatives, roadmap-write, tool-calls}/
      read-model/{ledger-source, database-identity, mappers, aggregates, query-schemas}/
      shared/{constants, errors}/
    cli/src/{bin, cli, format, observation, tool-call}/
    console/src/{api/*, app, components/*, format/*, hooks/*, routing/*, styles, views/*}/   # unchanged
```

**Cost.** ~150 of 195 `src` files move (console, accounts and observation stay put),
and the mirror `test` tree moves with them. The expensive part is the fence, not the
code. `scripts/check-architecture.mjs` (16,994 lines) holds **1,453** quoted
`packages/**/(src|test)/**` path literals, 560 distinct; a 178-entry `RETIRED_PATHS`
register (line 200) that permanently forbids recreating a retired path; and six
pinned export registers totaling 499 names (`RUNTIME` 206, `PROVIDERS` 87,
`ACCOUNTS` 72, `OBSERVATION` 64, `TOOLS` 42, `DURABILITY` 28).
`tsconfig.base.json` (26 refs), `vitest.config.ts` (22) and `eslint.config.mjs` (3)
also carry paths. The repo did a 302-pair move once (P8-T G1'), so the machinery
exists, but the fence has roughly doubled since. Do it as one atomic map.

**Sequencing risk.** Every added export costs two edits today, the barrel plus its
fence register. Landing S2 before slimming those registers pays that cost 499 times.

## Verified claims that hold

- **13 packages, 5 strata**, against `PACKAGE_STRATA` and 13 `package.json` files.
- **195 `src` files / 55,261 lines; 71,002 test lines** (1.28 test lines per src line).
- **The daemon barrel is 1,216 lines** with `startDaemon` at 274–1005, against `docs/ROADMAP.md:378`.
- **`domains/runtime/src` has 17 top-level folders** (the brief's ~22 is its file count; both are in the table).
- **Three folders named `contracts`**, plus two named `contract`, for five.
- **`runtime/src/constants` exports `UI_PORT`, `OBSERVATION_API_PORT` and the Restate ports, object and handler names**, consumed only outside the domain.
- **`toy/repository` is on the runtime barrel** and is consumed by *production* source in `entrypoints/daemon` and `edges/durability`, not only by drills.
- **Barrels are closed:** zero `export *` repo-wide.
- **Corrected:** there are **7** `errors/` folders under `src`, not 13 (gateway, providers, runtime, accounts, observation, ledger, daemon). An eighth match is untracked build output under `packages/persistence/ledger/dist-test/`.
- **Corrected:** narration measures **539** lines over 143 `src` files, not 1,322; 1,028 including `test`, 1,844 including the fence. The file count (143 against 142) corroborates the brief's census; the line figure does not reproduce.

## Rottay reference: what to port, what not to

**Port (5).**
1. **`ports/` as a named folder** — `dm-staff/application/ports/interfaces/{repositories,services,controllers,config}`. ACP scatters 13 port declarations across 4 strata with no folder that says "port".
2. **`domain/errors/` per bounded context with a shared `base/`** — dm-staff has 14 error families under one root. ACP has 38 error classes and 7 inconsistent `errors/` folders.
3. **A shipped `testing/` surface** — `platform/packages/core/testing/{assertions,doubles,use-case-test-base}` is an exported surface, exactly the `kernel/testkit` that kills S6.
4. **Split-by-role subfolders under one parent** — `config/di/use-cases/{mutations,queries}/<domain>` gives 14 domains one predictable path. This is the grouping level ACP lacks.
5. **Named export bundles** — `core/exports/{rag,session,testing,workers}.ts` are extra entry points beside the root barrel: precisely the `@acp/runtime/scenarios` subpath ADR 0014 asked for and never got.

**Do not port (3).**
1. **Multi-tenancy.** `tenantId` on every call, tenant-scoped repositories, super-admin switching. ACP is a single-operator local control plane; a tenant column would be dead weight and a false security signal.
2. **Full hexagonal ceremony.** `adapters/in/{controllers,dto,middleware,routes,websocket}` plus `application/{actors,rbac,services,use-cases}` plus `infrastructure/{data,messaging,security,runtime,observability}` is ~15 mandatory layers. ACP's largest domain is 22 files; the ceremony would exceed the code. Take the vocabulary, not the depth.
3. **The 1,276-line root barrel.** `dm-staff/index.ts` is a pure barrel and still unreadable. ACP's closed, explicitly-listed barrels are better than the reference. Do not adopt its size, and do not adopt `export *` to shrink it.
