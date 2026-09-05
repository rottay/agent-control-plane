# acp-tests — audit report (snapshot 4569478)

Assertion quality and false security. Paths snapshot-relative, verified at `456947875c453269ab7d105fa5088e947bc3cb90`. The live tree was never read.

## Scores + justification

**Testabilidad (los tests prueban comportamiento): 9/10.** ~94% of sampled assertions are behavioural: input to observable outcome, measured against an external oracle rather than a fixture. The drills are real — a real `SIGKILL` at three fault points with a filesystem marker counted afterwards, eight real OS processes contending for one claim, a real broken SSE connection reconciled against the database. Several suites carry deliberate vacuity guards and hand-written mutants. Off for: no mutation or property-based testing; one count pin whose name is a claim its assertion does not make (T6); the contracts suite being largely "the Zod schema accepts or rejects this value", which is real but shallow.

**Los checks/receipts NO dan falsa seguridad: 4/10.** Three of the four load-bearing gates do not bind. CI cannot pass at this HEAD while the README claims it runs the identical local gate (T1). The commit-authorization receipt has no production caller and there is no pre-commit hook (T2). The law requiring an independent-verifier receipt per commit has not been honoured for the last 18 commits, the highest-risk ones in the repository (T3). The fence's most-quoted summary line describes a branch no test executes (T5).

## Findings

**T1 — CI cannot pass at this HEAD; the README claims it runs the identical gate. Class 1.**
`.github/workflows/ci.yml:34` sets `runs-on: ubuntu-latest`; `:68` runs `pnpm check`, which chains to `pnpm test` over every project. Two projects cannot succeed there. The launchd drills invoke the macOS-only parser at `packages/entrypoints/daemon/test/launchd/drills/index.test.ts:106` (`spawnSync("/usr/bin/plutil", ...)`) and assert its status at `:197` and `:287` (`expect(plutilLint(...)).toBe(0)`); on Linux the binary is absent, `status` is null, the helper returns `-1`, the assertion fails. The Restate drills refuse to skip by explicit design, `packages/edges/durability/test/drivers/drills/index.test.ts:854-859`:

```
    const availability = serverAvailability();
    // No skip: a drill suite that skipped here would be indistinguishable from
    // one that passed, and the adoption decision rests on these drills.
    expect(availability.reason).toBe("verified");
    expect(availability.available).toBe(true);
```

The binary lives under gitignored `.acp-local/tools/restate-server-1.7.7/`, CI has no `scripts/acquire-restate-server.mjs` step, and `scripts/restate-server.pin.json` declares only `darwin-arm64` while its own comment states "A platform absent from this file is refused" — so an acquisition step would not help on Linux either. `README.md:181` describes CI as "GitHub Actions running the identical check a local writer runs".
Impact: the headline mechanical gate is decorative; every claim resting on "CI runs the same check" is unbacked.
Fix: `macos-14` plus an acquisition step, or a hermetic CI project set and a corrected README sentence. Phase: now.

**T2 — the commit-authorization receipt is a value, not a gate. Class 1.**
`authorizeCommit` and `recordCommit` are exported at `packages/domains/runtime/src/index.ts:68-71`. Callers exist only in `packages/domains/runtime/test/commit-authorization/index.test.ts`, `packages/domains/runtime/test/pilots/writer/index.test.ts` and one README sentence. `.githooks/` holds a single file, `pre-push`; there is no pre-commit hook, so nothing verifies a receipt when a commit is created. `CommitAuthorizationReceipt` is a well-tested pure function no production path calls.
Impact: the invariants it encodes (verifier is not the writer, no nonzero check, no write outside the declared set) rest on agent discipline alone.
Fix: a pre-commit hook that machine-verifies a receipt, or an AGENTS.md sentence calling the receipt a convention. Phase: next.

**T3 — the last 18 commits carry no verifier receipt at all. Class 1.**
`fcedb7d..4569478` is exactly 18 commits, spanning 2026-09-03 21:28 to 2026-09-04 17:32. In the `.acp-local` listing, commit-authorization receipts stop at `p5n-c6-commit-authorization-receipt.md`, dated Aug 28. Artifact production collapses over the same window: 324 files on Aug 28, 71 on Sep 2, 9 on Sep 3, 6 on Sep 4. The newest commit referenced by any surviving artifact is `7144662`, 19 behind HEAD. `AGENTS.md:45-53` requires that "a different worker actually executed the checks and recorded their exit codes"; `AGENTS.md:147` requires handing a receipt to the integrator.
Impact: those 18 commits are the highest-risk in the repository — write-set enforcement, worktree lease arbitration, tool-coordinate arbitration across processes, cross-process tool effects. The evidence discipline lapsed exactly where it mattered most, and nothing mechanical noticed.
Fix: retroactive receipts for the 18, or a written exception naming them. Phase: now.

**T4 — SECURITY.md "claim checks" are literal-presence; one is pinned to a comment. Class 2.**
The law at `scripts/check-architecture.mjs:16580` is `if (!anchored.includes(literal ?? ""))`. Four of the 19 anchors:
- `SECURITY.md:115` anchors `Exactly 0600` to `packages/domains/accounts/src/registry/index.ts`. That literal is a **comment** at `:341`; the predicate is at `:343`. Changing `0o600` to `0o644` leaves the anchor satisfied. The claim is proven anyway, by a real test at `packages/domains/accounts/test/registry/index.test.ts:232` — the anchor adds nothing.
- `SECURITY.md:73` anchors `timingSafeEqual`; it is satisfied by the import at `packages/entrypoints/gateway/src/bearer/index.ts:1`, independent of the comparison at `:144`.
- `SECURITY.md:102-103` anchor two literals to `scripts/check-architecture.mjs` itself — the fence verifying its own source text.
- `SECURITY.md:42` anchors `SERVER_BIND_HOST = "127.0.0.1"`; literal-presence, but corroborated by a real refusal at `packages/entrypoints/gateway/src/start/index.ts:49-55`.
All four are literal-presence, not behavioural. The fence says so itself at `:4708` ("a counted claim the SECURITY law cannot check").
Impact: "19 SECURITY.md claims ... every one of them holds" reads as verified security behaviour; it is verified documentation freshness.
Fix: rename the note; require each anchor to also name the test proving the claim. Phase: next.

**T5 — the fence's fail-closed branch is never exercised. Class 2.**
`requireScope` at `scripts/check-architecture.mjs:6907` fails when `count === 0`. In a passing run that branch never executes, and `scripts/architecture/roots.test.mjs` contains no occurrence of `requireScope`, `emptyScopes`, `empty scope` or `selected no files`. Its probes cover hook configuration, remotes, credentials, write-set conformance and the epoch — never an empty scope. I ran the fence and it printed `88 path-scoped laws fail-closed on an empty scope`.
Impact: the property most cited as proof the fence cannot silently scope to nothing rests on inspection of an eight-line function. Correct by reading, unproven by test.
Fix: one probe running the fence against a synthetic tree with a registered law's folder absent. Phase: next.

**T6 — a count pin whose test name is a claim its assertion does not make. Class 3.**
`packages/domains/runtime/test/failure/index.test.ts:360`, inside `describe("N8: this packet introduced no state and no event type")` and `it("leaves the contract's two closed lists exactly where they were")`, asserts `expect(CONTROL_PLANE_EVENT_TYPES).toHaveLength(24)`. Commit `1fb0bd1`, "test(runtime): correct event type count baseline", changed that number from 23 to 24. The name asserts nothing was added; the assertion asserts a number that is edited when it fails. This is the one place in the suite where a red test was resolved by moving the test to the implementation.
Fix: assert the set difference against a frozen list, or drop the pin. Phase: opportunistic.

## Assertion classification table

Eighteen files, 2,225 assertion statements parsed; percentages are of that file.

| File (test/…) | Assertions | Behaviour | Structural pin | Source-text | Tautology/replay |
|---|---|---|---|---|---|
| kernel/contracts/schemas | 275 | 93% | 7% | 0% | 0% |
| runtime/core/events | 42 | 88% | 12% | 0% | 0% |
| runtime/cancellation | 77 | 97% | 3% | 0% | 0% |
| runtime/failure | 61 | 90% | 10% | 0% | 0% |
| durability/drivers/restate-driver | 239 | 92% | 8% | 0% | 0% |
| gateway/stream | 104 | 91% | 9% | 0% | 0% |
| gateway/parity | 113 | 94% | 6% | 0% | 0% |
| daemon/scheduler | 25 | 92% | 8% | 0% | 0% |
| daemon/drills/leases | 87 | 100% | 0% | 0% | 0% |
| providers/execution-port | 83 | 90% | 10% | 0% | 0% |
| tools/port | 112 | 96% | 4% | 0% | 0% |
| ledger/ledger | 382 | 95% | 5% | 0% | 0% |
| accounts/routing | 115 | 94% | 4% | 2% | 0% |
| console/live-dom | 74 | 96% | 4% | 0% | 0% |
| scripts/architecture/roots.test.mjs | 75 | 92% | 8% | 0% | 0% |
| runtime/drivers/sqlite-supervisor | 195 | 95% | 5% | 0% | 0% |
| ledger/tool-claim-store | 63 | 94% | 3% | 3% | 0% |
| runtime/enforcement | 103 | 94% | 3% | 3% | 0% |
| **Overall** | **2,225** | **~94%** | **~6%** | **~1%** | **~0%** |

Repository-wide, for scale: 133 test files, 2,873 `it(`, 8,153 `expect(`, 117 `readFileSync` across 43 files, 57 sorted-key pins, 62 length/size count pins. Tautology and fixture-replay are effectively absent — I found no assertion comparing a constant to itself or a recording to its own recording. The source-text assertions that exist are careful: `runtime/test/enforcement/index.test.ts:84` and `ledger/test/tool-claim-store/index.test.ts:365-369` both strip comments before scanning, so a docblock explaining an absence cannot read as a presence. Caveat on the contracts row: most of its 275 assertions are `Schema.safeParse(value).success`, which validates the validator rather than the system.

## Regression-sensitivity table

| Claim | Assertion that would catch a regression | Verdict |
|---|---|---|
| (a) cancellation settles exactly once | `runtime/test/cancellation/index.test.ts:509-510` — after a repeated `settleCancellation`, `expect(ledger.status().eventCount).toBe(afterFirst.eventCount)` and the same for `headEventSha256`; plus `:316` `expect(keys.length - new Set(keys).size).toBe(0)` | Caught, sequentially. No concurrent double-settle test; that case rests on the store's uniqueness constraint, untested at this seam. |
| (b) the SSE stream never duplicates or skips a sequence | `gateway/test/stream/index.test.ts:613-615` — `expect(union).toEqual([...union].sort(...))`, `expect(new Set(union).size).toBe(union.length)`, `expect(union).toEqual(sequencesInLedger(path))` | Caught, strongly. The oracle is the database, and the connection is genuinely broken mid-replay. |
| (c) a write outside the write-set quarantines the task | `runtime/test/enforcement/index.test.ts:284-288` — `expect(outcome.recommendedTaskState).toBe("SUSPECT_WORKTREE")` and `expect(outcome.events.map(e => e.type)).toEqual(["WRITE_SET_VIOLATION_DETECTED","LEASE_REVOKED"])`; closed-key pin at `:291` | Caught. |
| (d) the SQLite driver refuses a capability it lacks with a typed error | `runtime/test/drivers/sqlite-supervisor/index.test.ts:933-936` — field-exact `{ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at }` for all four verbs; correspondence law at `:988`; hand-written mutant at `:997` asserting `["CANCEL: declared SUPPORTED but refused"]` | Caught, with a negative control. The strongest claim in the suite. |
| (e) recovery after SIGKILL does not re-run a completed step | `runtime/test/drivers/sqlite-supervisor/index.test.ts:261` — `expect(effectMarkerCount(root)).toBe(1)` after a real `SIGKILL` at each of three fault points, re-asserted at `:269` after a third replay, with `:268` pinning the head digest unmoved | Caught. A real signal and an external filesystem observable, not an in-process exception. |
| (f) the tool claim prevents a second process executing the same coordinate | `ledger/test/tool-claim-store/index.test.ts:515-520` — eight real OS processes, `expect(winners).toHaveLength(1)`, seven refusals, and `expect(outcomes.filter(o => o.errorName !== null)).toEqual([])` so a lock-contention crash cannot make the count pass for the wrong reason | Caught, strongly. |

All six hold; only (a) has a gap, and it is narrow.

## The two failures

Environment- and tree-state-dependent, **not a defect at HEAD**. Both are in `packages/entrypoints/daemon/test/launchd/drills/index.test.ts` — `:569` `expect(runWithRoadmap(benign)).toBe(0)` and `:581` `expect(status).toBe(0)` — and both are controls that expect the fence to *pass*, yet received exit 1. Chain, reproduced in a throwaway clone with the snapshot untouched:

1. The fence at HEAD on a clean tree exits 0. Verified in the snapshot and again in a fresh clone with `core.hooksPath` and the canonical remote configured.
2. The `benign` control — `docs/ROADMAP.md` plus one newline, fence digest re-pinned — also exits 0. So the roadmap gate is sound and `:569` is not detecting a real defect.
3. The fence exits 1 on *any* untracked, non-ignored path. Injecting one stray file produced exactly `path is outside the exact P0 plus P1A plus P1B write-set: packages/entrypoints/daemon/stray-artifact.ts`. The law reads `git ls-files --cached --others --exclude-standard` at `scripts/check-architecture.mjs:7031`.
4. Therefore both failures require a transient file in the working tree when the drill spawned the fence.

**The file is now identified.** The team lead confirmed it was `SNAPSHOT_SHA.txt`, an untracked file the audit harness wrote into the snapshot root; removing it returns the fence to exit 0. I reproduced the exact message in a clone: `path is outside the exact P0 plus P1A plus P1B write-set: SNAPSHOT_SHA.txt`. So both failures are an audit artifact, not a defect at HEAD. I had independently ruled out the in-repo candidates — daemon and launchd runtime state lands under `.acp-local/` (`packages/entrypoints/daemon/src/constants/index.ts:11`, `src/launchd/render/index.ts:42`), TypeScript output in `dist/` per `packages/entrypoints/daemon/tsconfig.json`, all gitignored — and I tested and **withdraw** a tempting hypothesis: the log shows the daemon project completed all 19 of its files before durability began, so `sequence.groupOrder` did serialise them.

**Judgement on the side effect. Class 3 for the policy, Class 2 for the coupling.** I measured the blast radius in a clone: any untracked, non-gitignored path anywhere in the tree fails the whole gate — `SNAPSHOT_SHA.txt`, `notes.md`, `scratch.tmp`, `docs/draft.md` and `README.bak` each produced exit 1; only `.env.local` passed, because `.env.*` is gitignored. This is **not a bug**. `scripts/check-architecture.mjs:7035-7062` implements the exact-write-set law as a closed repository-wide allowlist, and `CONTRIBUTING.md:64-70` states the intent plainly: "Every change is authorized as a specific list of paths... the fence will refuse the diff, and that refusal is the mechanism working." The owner has chosen strictness deliberately and documented it, so the policy itself is a preference, not a finding.

What is worth fixing is the coupling. These two drills assert a *global* property of the working tree from inside a test that mutates that tree, so an unrelated stray file turns two daemon tests red with a message about write-set authorization rather than about an untracked file. The result is a test that cannot fail for its stated reason and can fail for many others. Minimal fix: have the drills assert the fence's verdict on a synthetic tree, as `scripts/architecture/roots.test.mjs:363` already does for its own probes ("runs against the synthetic tree and never against the real one"), rather than on the live repository.

## Suite integrity

**A truncated run does not exit 0, but its summary reads green.** The recorded truncation exited 1 and not on an assertion (`[vitest-worker]: Timeout calling "onTaskUpdate"`), so a gate keyed on exit code is safe. A human is not: the tail printed `Test Files 69 passed (69)` when 111 were expected, and 42 files never ran. Nothing pins the expected file or test count, and `pnpm test` runs `--reporter=dot`, so the drop is invisible in the summary.

**Skipped drills are not reported as green, by explicit design** (`durability/test/drivers/drills/index.test.ts:855-857`). That is the repository at its best, and it is exactly why T1 bites: on CI they fail rather than skip.

**No mutation testing and no property-based testing exist.** I checked the root and all 13 package manifests: no `stryker`, `fast-check` or equivalent. The roadmap mentions both; they are correctly absent rather than falsely claimed — Class 4, planned-and-correctly-absent.

**One structural note:** `packages/persistence/ledger/dist-test/` holds 8 compiled `.test.js` copies. They are not double-counted; every project's `include` matches only `.ts`/`.tsx`.

## Verified claims that hold

- All six core regression claims are caught by a specific assertion, five strongly.
- The negative controls are real: `edges/tools/test/port/index.test.ts:403` ("fails against a server that answers nothing") is an explicit vacuity guard; `runtime/test/drivers/sqlite-supervisor/index.test.ts:997` is a hand-written mutant; `ledger/test/tool-claim-store/index.test.ts:520` rules out a lock-contention crash faking the win.
- `requireScope` (`scripts/check-architecture.mjs:6907`) does fail closed as written, and `assertPathScopedInventory` genuinely prevents adding a path-shaped law without registering it, by counting call sites against the register.
- The pre-push fence denies by default and is drilled case by case against 13 deny and 2 permit rows (`scripts/check-architecture.mjs:7241-7257`), not merely digest-pinned.
- The fence runs in 0.97 s and passes at HEAD, certifying 13 packages across 5 strata.

## Open questions

1. Has CI ever run green on any commit, given T1? The workflow header calls the contract "live" since 2026-09-03, and every commit since postdates that.
2. Does the claim store's uniqueness hold under two *concurrent* cancellations (claim a), or only under sequential repeats?
3. Was the receipt lapse in T3 an explicit owner decision to trade evidence for velocity in the final push, or unnoticed drift? The two have different remedies.
