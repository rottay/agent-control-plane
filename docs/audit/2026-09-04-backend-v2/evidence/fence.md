# acp-fence — audit report (snapshot 4569478)

Scope: `scripts/check-architecture.mjs` (16,994 lines / 811,801 bytes), `scripts/acquire-restate-server.mjs`, `scripts/architecture/{roots.mjs,roots.test.mjs}`, `.githooks/pre-push`, `.github/workflows/ci.yml`, plus doc-vs-code drift and `.acp-local` evidence durability. All numbers below came from commands run inside the pinned snapshot. The fence run failed on one violation, `SNAPSHOT_SHA.txt` — dropped at repo root by the snapshot-preparation step, not a repository defect — but printed all 123 passing checks first; those are what the anatomy below is built from.

## Scores + justification

**Proportionality of scripts/gates: 5/10.** The design intent — prove exactly what a commit touched, self-test via subprocess against synthetic trees, pin everything by digest or equality — is a defensible answer to "multiple AI agents write into one repo without a human reviewing every line." But the implementation cost is extreme relative to that goal: 138 near-duplicate frozen `*_WRITE_SET` arrays that could be one data file, a change tax of ~0.43 fence-lines per src-line over the last 39 commits, and a durability/CI gap (F1) that undercuts the very proof the machinery exists to provide.

**Documentation fidelity to code: 6/10.** Claims the fence itself enforces (route bijection, 6 package "Public surface" sections, ADR corpus, SECURITY.md's 19 claims, the capability-policy digest) hold exactly. The root `README.md`'s free-text architecture summary — package count, route count, the Git-observer claim — is fence-checked nowhere and carries three concrete, unenforced drifts.

## Findings

**F1 — Restate server pin covers only darwin-arm64; CI cannot obtain the binary the durability/daemon suites require. Class 1.**
`scripts/restate-server.pin.json` has exactly one `platforms` entry, `darwin-arm64`; its own comment says "A platform absent from this file is refused. There is no trust-on-first-use." `pnpm check` runs `vitest`, whose `durability`/`daemon` projects each "start a real Restate server on 8080/9070" and whose drills hard-assert `serverAvailability()` equals `{available:true, reason:"verified"}` (`.../drivers/drills/index.test.ts:719,773,935`). `server-handle/index.ts:34`: "Nothing here downloads. The binary is acquired by an explicit operator [command]." `ci.yml` runs on `ubuntu-latest` and never invokes `acquire-restate-server.mjs`; no `postinstall`/`prepare` exists anywhere; no CI-only skip logic references Restate. As configured, these two vitest projects cannot pass on Linux CI — either it has been red since the workflow "became live" 2026-09-03 (one day before HEAD), or an unseen provisioning path exists. Fix: add a `linux-x64` pin entry and an acquire step to `ci.yml`, or gate on `serverAvailability()` with an honest skip.

**F2 — README's "no production Git observer" is stale; the observer is wired into the production conformance gate. Class 1.**
`README.md:86-88`: "There is no production Git observer… no implementation ships in the package." `packages/entrypoints/daemon/src/git-observer/index.ts` (263 lines) is a real implementation, imported into `daemon/src/index.ts:51` (`createGitObserver`, `observeWorktree`) and governed by its own fence law ("one daemon module invokes git… the conformance gate precedes the evidence marker"). The module's own docblock quotes the claim it supersedes, attributed to `@acp/runtime`'s docblock rather than README. This sits in README's "what's still inert" trust list, read by an audience checking exactly that. Fix: two-line edit.

**F3 — Root README prose (package count, route count) drifts because no law checks it; package-level "Public surface" sections do. Class 2.**
`README.md:108` and its tree say "Five strata, twelve packages," 12 rows, omitting `edges/tools`; the fence certifies "13 packages… 5 strata," confirmed by `find packages -name package.json` (13 hits). `README.md:68` says "17 routes… 2 guarded writes"; `docs/api-reference.md`'s table has 19 rows and 3 writes, matching the fence's own bijection count exactly — two independent sources agree with each other, not README. Cause: `README_SURFACE_CLAIMS` verifies 6 package READMEs' "Public surface" sections against their barrels, but nothing reads the root README's prose or diagram — the document a new reader hits first has zero drift protection. Fix: update the two lines/one row; consider a 7th surface-claim entry for the root table.

**F4 — 138 frozen write-set arrays plus the retired-path/move-map record are ~40% of the file; the tax on new feature work is ~0.43 fence-lines per src-line. Class 2/3.**
See tables below. One V2-range commit (`b8116085`, "close inherited V2 fence debt") refactors the fence's own accretion alone: +133/-57 in the fence against +8/-4 in `src/`. Not a correctness bug — every array is legible and commented — but an economics problem: the same guarantee is available at a fraction of the line count (delete/simplify list).

**F5 — The evidence trail (`.acp-local`, 1,135 `.md` records) is entirely gitignored and not indexed by commit. Class 2.**
The fence confirms `.acp-local/` is ignored. `docs/certification/p8-matrix.md` cites evidence files by SHA-256, and `AGENTS.md`'s worker laws depend on briefs/verifications/postaudits existing. None of the last 19 commits (`fcedb7d^..HEAD`) appears by short-SHA in any of the 1,204 filenames — naming is phase-code/role ("p2c-opus-preflight.md"), not commit-keyed, so tracing evidence for a given commit needs a manual match with no direct index. Nothing here is fabricated, but the linkage is tribal and the evidence has no retention guarantee beyond whatever machine produced it.

**F6 — Positive-control (synthetic-failure) test coverage is narrow relative to the law count. Class 3.**
`roots.test.mjs` (539 lines, 26 cases) genuinely spawns the fence as a subprocess against synthetic trees (`ACP_FENCE_ROOT`) and proves specific laws fire on a violation: write-set conformance (3), remote/hook checks (4), README-regression guard (2), barrel-prose-count (2), export-helper honesty (3). That covers a handful of ~123 law families; most domain-specific laws (sections 15-23: durable gate, arbitration store, tool-claim store) are proven only by "the real tree currently satisfies them" — never a constructed negative.

## Fence anatomy table

| Region | Lines | Comment | Code | Blank | Content |
| --- | --- | --- | --- | --- | --- |
| Preamble (1-199) | 199 | 101 | 90 | 8 | header, imports |
| `RETIRED_PATHS` block (200-5496) | 5,297 | 3,450 | 1,722 | 125 | 178-entry retired list + 138 `*_WRITE_SET`/`P1B_LANE_ENVELOPES` arrays, per-phase rationale |
| `PUBLICATION_WRITE_SET` (5497-5729) | 233 | 118 | 102 | 13 | 14-entry publish-fence write-set |
| Combinators + registries (5730-6962) | 1,233 | 427 | 776 | 30 | `WRITE_SET` union, `ROADMAP_LITERALS`, `PATH_SCOPED_LAWS` (88), `AUTHORITY_LITERALS`, `EXPIRED_LITERALS` |
| Sections 1-23, law logic (6963-16994) | 10,032 | 2,532 | 7,093 | 407 | actual checks, incl. `G1_MOVE_MAP` (302 pairs, 304 lines) |
| **Whole file** | **16,994** | **6,628 (39%)** | **9,783** | **583** | |

123 `✓` notes print (distinct laws); 532 `fail(` call sites exist (~4.3 per law — most loop over files/exports and call `fail()` per violation, so 532 overstates "532 rules"). 164 sites read real source text (`readIfPresent`), 92 through a comment-stripping normalizer; matching is 100% text/regex (166 `.includes(`, 115 `.test(`, 19 `.match(`, 31 `.matchAll(`) — no AST parser is imported anywhere. 9 packages carry an equality-pinned export list (72-206 entries each); 6 carry a bidirectionally-checked README "Public surface"; 7 do not (2 spot-checked — `domains/accounts`, `kernel/protocol` — no drift found: narrative READMEs, and the one pinned literal each carries matches the fence's own digest check).

## Change-tax table (V2 range, `e437d5a..HEAD`, 39 commits)

| | Added | Deleted |
| --- | --- | --- |
| `scripts/check-architecture.mjs` | 7,289 | 325 |
| `packages/**/src/**` | 17,018 | 918 |
| everything else (tests, docs) | 33,235 | 1,034 |

Mean fence+/commit = 186.9; mean src+/commit = 436.4; ratio ≈ 0.43 fence-lines per src-line. Two commits (`c0684316`, `eab4bfec`) add 117 and 243 fence-only lines with zero `src/` changes. One (`b8116085`) is fence-debt cleanup (F4). Concrete walkthrough, HEAD `4569478`: 117 lines added solely to declare `V2B3C_WRITE_SET` (18 literal paths, 5 packages + 3 docs + the fence's own path) and splice it into `WRITE_SET`, for a real footprint of ~9 files; ~90 of the 117 lines are prose. (a) A new `src/<module>/index.ts` in the already-activated `domains/runtime` tree needs no `TOPOLOGY_ACTIVE_TREES` edit, but its path must join the current `*_WRITE_SET` (scanned repo-wide, not per-package), a mirrored test file is required, and if re-exported, the name joins `RUNTIME_PUBLIC_EXPORTS` (206 entries) and a 1,450-name collision scan. (b) A new barrel export is the same equality-array edit (one of 9), plus the README if that package is among the 6 covered. (c) A new package needs `PACKAGE_STRATA`, `TOPOLOGY_ACTIVE_TREES`, `TEST_TREE_SCANNED_PREFIXES`, a new `*_DEPENDENCY_LAW` entry, a fresh `*_WRITE_SET` array plus splice — and, unenforced (F3), the root README's tree/count, exactly the step that already drifted for `edges/tools`.

## Delete/simplify list (ranked)

1. **Collapse 138 `*_WRITE_SET` arrays + `RETIRED_PATHS` into one external JSON/YAML ledger**, read once, same exact-equality semantics. Est. 3,000-4,000 lines saved; risk low (representational only). Class 2.
2. **Parameterize the 9 `*_PUBLIC_EXPORTS` equality-pin blocks into one `assertPinnedSurface(barrelPath, pinnedNames)` helper** (the barrel-reading helpers already exist). A few hundred lines saved; risk low. Class 2.
3. **Adopt dependency-cruiser / eslint-plugin-boundaries for the "N sources import only what the domain/edge is allowed" law family**, replacing hand-rolled regex import scanning with real-AST rules. 1,000+ lines potentially saved across sections 15-21; risk medium, and it reintroduces an npm dependency the header explicitly avoids ("deliberately dependency free"). Class 2, larger lift.
4. **Swap the 7-regex credential scanner for gitleaks/trufflehog**, vendored and digest-pinned like the Restate server. Better coverage in less code, but only if "dependency-free" is relaxed — an owner call, not a unilateral swap. Class 2/3.
5. **Leave the genuinely bespoke laws alone**: the pre-push drill matrix, ADR numbering, the roadmap digest pin, and the ~90 domain-shape laws. No off-the-shelf tool encodes invariants this product-specific. Class 4, correctly bespoke.

## Doc-drift table

| Claim | Location | Reality |
| --- | --- | --- |
| "Five strata, twelve packages" | `README.md:108`, tree 110-124 | 13 packages; `edges/tools` missing from prose and tree (F3) |
| "17 routes… 2 of them guarded writes" | `README.md:68` | 19 routes, 3 writes, per `docs/api-reference.md` and the fence's own bijection (F3) |
| "There is no production Git observer… no implementation ships" | `README.md:86-88` | Implemented and wired into the production conformance gate (F2) |
| "`docs/ROADMAP.md` is the canonical authority for this repository" | `README.md:331` | Byte-pinned P0 kickoff snapshot; 0 mentions of "V2" in 900 lines; Estado line stops at `P8_COMPLETE`/`NO_PRODUCT_CUTOVER`; 39 V2 commits sit outside it |
| 6 of 13 package READMEs are bidirectionally fence-checked | `README_SURFACE_CLAIMS` array | `contracts, durability, gateway, ledger(errors), providers, tools` checked; 7 others not — 2 spot-checked (`accounts`, `protocol`), no drift found |
| AGENTS.md's 5-role worker table | `AGENTS.md:15-21` | Note only: `.acp-local` filename role-token counts — fable 313, opus 271, sonnet 224, kimi 154, codex 15; not a contradiction, Codex's "phase-boundary checkpoint" cadence is inherently rarer |

## Verified claims that hold

- `docs/certification/p8-matrix.md`'s 22 short-SHA commit citations all resolve to real commit objects (`git cat-file -t`).
- `docs/ROADMAP.md`'s digest pin, `SECURITY.md`'s 19 claims, the ADR corpus (28, contiguous), the capability-policy digest (`2026-08-30.1`), and the route-table bijection are all enforced by the fence and confirmed by direct inspection.
- `.acp-local/` is genuinely gitignored (no tracked file under it); 143 of 145 commits touch the fence, 39 in the V2 range.
- The pre-push hook (128 lines) is drilled with 13 denied + 2 permitted synthetic cases and matches its pinned digest.
- `roots.test.mjs`'s 26 cases genuinely run the fence as a subprocess against synthetic fixtures via `ACP_FENCE_ROOT` — a real, if narrow, positive control.
