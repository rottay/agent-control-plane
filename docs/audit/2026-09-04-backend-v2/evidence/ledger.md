# acp-ledger — audit report (snapshot 4569478)

All paths are snapshot-relative to `scratchpad/acp-snapshot`.

## Scores + justification

**Durabilidad y recuperación (ledger side): 8/10.**
Every append is one `BEGIN IMMEDIATE` transaction (`packages/persistence/ledger/src/ledger/index.ts:804-808`), with rollback proven by fault injection at two points inside it (`test/ledger/index.test.ts:580`, `:629`). Cross-process contention is drilled with real spawned processes, not mocks: 4 racing writers (`:1529`, `:1560`) and 8 racing claimants (`test/tool-claim-store/index.test.ts:502`). Artifact publication is `write`-then-`rename`, ordered before the append, so a crash orphans bytes instead of stranding a dangling digest (`packages/entrypoints/gateway/src/roadmap-write/index.ts:129-139`). Points lost: no batch append, so any multi-event effect is multiple transactions; provider execution is at-least-once with real money attached; the lease grant commits before its ledger event.

**El ledger es la fuente de verdad: 8/10.**
Append-only is enforced by database triggers on all three event tables, and trigger *removal* is caught by a schema-object inventory (`src/migrations/index.ts:410-456`), which I confirmed fires. The daemon status document is explicitly observational and the architecture fence forbids the lifecycle importing it (`packages/entrypoints/daemon/src/status/index.ts:8-16`). Points lost: the account stream sits outside the hash chain and outside `verifyIntegrity`, and the lease store takes decisions the log never sees.

## Findings

### L1 — A forged account action passes `verifyIntegrity()` with `ok: true`
**Class 2 (improvement).**
`account_events` (migration 5, `src/migrations/index.ts:271-285`) has no `previous_sha256` and no `event_sha256` column, unlike its two siblings. `verifyIntegrity` walks only those two streams (`src/ledger/index.ts:1786`, `:1792`); no code path reads `account_events` for verification. Reproduced against a throwaway database built from `dist/`:

```
# drop triggers, rewrite action DRAIN -> OWNER_OVERRIDE, recreate triggers
triggers restored after a forged account action -> integrity.ok = true
problems: 0
forged row still reads as: "OWNER_OVERRIDE"
```

**Impact.** Account actions decide which accounts are drained, exhausted or owner-overridden, so they steer spend. A shape-valid forgery is undetectable; only a shape-invalid one throws at read time via `AccountActionEvent.parse`. ADR 0002's "what it does not and cannot prove" list (`docs/architecture/0002-sqlite-event-ledger.md:145-155`) does not mention the account stream, so the documented integrity boundary is wider than the implemented one. Not Class 1 because the triggers do bite (proven in L2) and the tamper needs the same filesystem write access ADR 0002 already concedes defeats the design wholesale.
**Minimal fix.** Chain `account_events` like its siblings, or state the exclusion in ADR 0002 and in `verifyIntegrity`'s doc comment. **Phase.** Next ledger packet.

### L2 — The account-stream append-only test asserts nothing about the triggers
**Class 2.**
`test/ledger/index.test.ts:2124` is named `"is append-only: the stream denies UPDATE and DELETE"` and its whole body is `ledger.appendAccountAction(action()); expect(ledger.verifyIntegrity().ok).toBe(true)`. The inline comment claims "this proves they bite." It does not: it proves the schema inventory lists the trigger names. The task stream's equivalent (`:656-674`) and the initiative stream's (`:2002-2006`) both issue a real `UPDATE`/`DELETE` and assert the message contains `append-only`.
The triggers *are* correct — I supplied the positive control the test lacks:

```
append OK seq= 1
denied -> account_events is append-only: UPDATE is denied
denied -> account_events is append-only: DELETE is denied
```

A trap for whoever writes the fix: SQLite `BEFORE` row triggers do not fire on a statement matching zero rows, so the assertion must run against a populated table.
**Minimal fix.** Copy the shape of the test at `:656`. **Phase.** Immediate.

### L3 — The provider executes twice across the crash window, and the ledger records once
**Class 2.**
`createExecutionEffects.apply` runs the effect, then the usage sink, then the conformance gate, then writes the evidence marker (`packages/domains/runtime/src/execution-effects/index.ts:363-427`). A `SIGKILL` after `execute()` returns and before `writeMarker` leaves no marker, so `probe` answers `NOT_DONE` and the walk re-executes. Asserted, not inferred, at `packages/domains/runtime/test/execution-effects/index.test.ts:450-476`: after one failed sink and one recovery, `expect(staged.calls.starts).toBe(2)` and `expect(seen).toHaveLength(1)`. Two provider runs, one recorded observation.
**Impact.** Real double token spend on any crash in that window, with the ledger under-reporting it. The source states this honestly (`execution-effects/index.ts:394-400`), and the ordering is the right trade — append-then-effect would record spend that never happened. But nothing marks the attempt as having burned an unrecorded execution.
**Minimal fix.** A pre-execution intent marker carrying the operation digest, so a resumed walk can see an execution was started and record the exposure even though the trail is lost. **Phase.** Needs an owner decision on cost.

### L4 — `lease-store`'s "rebuildable" claim has no implementation and no test
**Class 2.**
`src/lease-store/index.ts:27-28` states the store "holds no history and is rebuildable — losing it costs liveness, never evidence." No rebuilder exists: grepping `rebuild` across `packages/**/*.ts` outside `dist/` returns only that sentence and two unrelated `tool-claim-store` comments. The claim is also not straightforwardly true. `fence` is monotonic and load-bearing — an aborting holder's whole test is "has the fence moved?" (`:44-52`) — and it reaches the ledger only indirectly, through `leaseIdFor(fence) = deterministicUuid("lease/" + worktreePath + "/" + fence)` (`packages/entrypoints/daemon/src/arbiter/index.ts:259-260`). Worse, the store's `GRANT` commits inside `store.transact` while `LEASE_ACQUIRED` is appended after it returns (`arbiter/index.ts:358-418`), so a crash between them leaves a granted fence the log never recorded. A rebuild taking `max(recorded fence) + 1` would then hand out a fence at or below one a stale holder already believes it owns.
**Minimal fix.** Write the rebuilder and a drill, or downgrade the comment: the store is the arbiter of record and its loss is not recoverable from the log alone. **Phase.** Next concurrency packet.

### L5 — The conformance quarantine is three transactions, and a crash between them leaves the task resumable
**Class 2.**
`conformanceGateFor` appends `WRITE_SET_VIOLATION_DETECTED`, then `LEASE_REVOKED`, then a `TASK_STATE_CHANGED` to `SUSPECT_WORKTREE` (`packages/entrypoints/daemon/src/index.ts:1131-1166`). Each `ledger.append` is its own immediate transaction; the ledger exposes no batch append (no `appendMany`/`appendBatch`/`appendAll` in `src/ledger/index.ts`). The daemon's own comment says the quarantine is "the step that makes the violation stick" and that without it "the next start re-runs the provider, re-writes outside the set and re-violates, indefinitely" (`:1073-1079`). A `SIGKILL` after the first append and before the third produces exactly that state. Mitigating: coordinates derive from `operationIndex`, so a resumed walk re-appends idempotently and converges — at the cost of one more provider execution (L3).
**Minimal fix.** A batch append taking several events under one transaction and one head advance. **Phase.** Next ledger packet.

### L6 — The claim TTL is not pinned to the tool edge's timeout; the only test checks the restatement against itself
**Class 2.**
`TOOL_CLAIM_TTL_MS` derives from `TOOL_CALL_BOUND_MS = 30_000` (`packages/domains/runtime/src/tool-call/index.ts:196-198`), a deliberate restatement of the tool edge's `TOOL_CALL_TIMEOUT_MS = 30_000` (`packages/edges/tools/src/contract/index.ts:152`), because the runtime's import allowlist forbids reaching `@acp/tools`. The source says "If the tool edge's bound moves, this must move with it" (`tool-call/index.ts:190-193`). Nothing enforces that. The only assertion, `packages/domains/runtime/test/tool-call/index.test.ts:866`, is `expect(TOOL_CLAIM_TTL_MS).toBe(TOOL_CALL_BOUND_MS + TOOL_CLAIM_MARGIN_MS)` — true by construction from the line defining `TOOL_CLAIM_TTL_MS`. I searched every `*.test.ts` for a cross-package comparison of the two literals and found none. Contrast the usage ceiling, whose equivalent restatement *is* described as fence-pinned (`packages/domains/runtime/src/usage/index.ts:38-42`).
**Impact.** If the tool edge's timeout is raised past 60s, a live claimant's claim expires while its tool still runs. A recoverer appends a `POSTCONDITION_UNKNOWN` receipt and settles the coordinate; the original's `recordToolCall` then takes an idempotency conflict. Safety survives — the tool is never re-run — but healthy calls start being poisoned and the log records "unknown" for calls that completed.
**Minimal fix.** A fence check reading both source files and asserting the two literals equal. **Phase.** Immediate; a test, not a design change.

### Class 3 notes
- `SQLITE_SUPERVISOR` declares all four verbs `UNSUPPORTED` (`drivers/sqlite-supervisor/index.ts:168-175`) and each method returns a typed `CAPABILITY_UNSUPPORTED` rather than throwing or no-opping (`:111-199`). That refusal is production code, but the law checking declaration against behaviour, `driverCapabilityMismatches`, is called only from two test files, never from a door.
- `src/tool-claim-store/index.ts:26-27` still says the store is "deliberately inert. Nothing calls it yet", which ADR 0026 superseded; both doors open it.

### Correctly absent (Class 4)
`recordCommit` and `authorizeCommit` (`runtime/src/commit-authorization/index.ts:194`, `:387`) have no production caller, only the barrel export. That is right: there is no real git-commit effect in the plane, and the lifecycle's `COMMIT_RECORDED` at step 9 is a `PLAIN` beat, a pure append (`runtime/src/core/lifecycle/index.ts:61`). Stated so a future reader does not mistake the unwired reconciler for a gap.

## Effect-by-effect idempotency table

| Effect | Idempotency key | Ordering | Outcome on SIGKILL in the window | Class | Crash-window test |
|---|---|---|---|---|---|
| (a) Provider execution | `operationId` + `operationDigest` in the `executions/` marker | effect → usage → gate → marker | Marker absent, probe `NOT_DONE`, provider runs again; first run's tokens spent and unrecorded | **at-least-once** | `execution-effects/index.test.ts:450` asserts `calls.starts === 2` |
| (b) `recordTokenObservation` | `usage.<operationIndex>.<stepIndex>` via `deriveEventCoordinate` (`runtime/src/usage/index.ts:68`) | inside the re-executed apply | Re-recorded under the same key; second append is an exact replay | **exactly-once per recorded execution**, under-reports real spend | `execution-effects/index.test.ts:450` (`seen` length 1 after 2 starts) |
| (c) Tool call | claim key = ledger `idempotencyKey` from `(taskId, attempt, transitionId)`; TTL 60s = 30s bound + 30s margin (`runtime/src/tool-call/index.ts:196-198`) | receipt read → `TAKE` → `MARK_IN_FLIGHT` → tool → `recordToolCall` → `SETTLE` only if the receipt landed | Claim stays `IN_FLIGHT`; on expiry nobody may re-run it — a `POSTCONDITION_UNKNOWN` receipt is built from the *stored claim* and settled | **exactly-once effect across processes; at-most-once on retry, fail-closed** | `tool-call/index.test.ts:716`, `:754`, `:799`, `:817`; `tool-claim-store/index.test.ts:502` (8 processes) |
| — claim expires while the tool still runs | same | — | Recoverer poisons and settles; the original's `recordToolCall` then hits `LedgerIdempotencyConflictError`. Effect ran once; log says unknown | at-most-once | `tool-claim-store/index.test.ts:179` |
| (d) `settleCancellation` / `settleFailure` | derived transition ids, probe-first (`runtime/src/cancellation/index.ts:169-224`) | probe → optional `OUTCOME` append → cancellation append | Two transactions; a crash between them replays exactly on resume | **exactly-once**, convergent | `sqlite-supervisor/index.test.ts:447` |
| (e) Conformance + `LEASE_REVOKED` + quarantine | `conformance.<operationIndex>.<n>` | three separate appends | Violation recorded, task not quarantined, walk resumable (L5) | **exactly-once per event, non-atomic as a group** | none for the inter-append window |
| (f) `recordCommit` | pure decision, appends nothing | n/a | n/a — unwired | n/a | n/a |

## Verified claims that hold

- Append-only triggers exist on all three event tables and abort unconditionally. Trigger removal is detected: my probe drew `the trigger account_events_deny_update was created by a migration but is no longer present` from `EXPECTED_SCHEMA_OBJECTS`.
- Migrations are checksummed on every open and a divergent prefix blocks the missing tail rather than compounding (`src/migrations/index.ts:557-561`); a read-only handle refuses to migrate (`src/ledger/index.ts:479-492`).
- Hash chain from a 64-zero genesis over canonical bytes, with column/body agreement checked on every read (`src/ledger/index.ts:648-770`). Tampering, truncation, mid-log gaps and rewritten links each have a named test with a real assertion (`test/ledger/index.test.ts:990-1128`).
- Rebuild is byte-equivalent across repeated runs and refuses to rebuild over a broken chain (`test/ledger/index.test.ts:894`, `:944`, `:1072`).
- Two writers in different processes serialize on `BEGIN IMMEDIATE` under WAL, default `busy_timeout` 5s (max 300s). Four racing processes yield one insert and three exact replays; with conflicting content, one winner and three `LedgerIdempotencyConflictError`. I re-ran both: `Tests 2 passed | 97 skipped`.
- The claim store refuses a control-plane ledger handed to it by mistake, and `toolClaimStorePath` is its path's only producer.
- The daemon status document is observational; no lifecycle code imports it.
- Integrity is checked on every daemon start in both modes (`packages/entrypoints/daemon/src/mode-sqlite/index.ts:78`, `mode-restate/index.ts:262`), via a `reconcile` that runs a full `verifyIntegrity` and returns `INDETERMINATE` with `safeToResume: false` on failure (`drivers/sqlite-supervisor/index.ts:230-262`). Also reachable from a gateway route and two CLI verbs.
- The SQLite driver does not simulate parity. `settleCancellation` is reached only from the Restate driver (`packages/edges/durability/src/drivers/restate-driver/index.ts:841`); the supervisor's `cancel` returns `CAPABILITY_UNSUPPORTED`. Both drivers share `settleFailure`, but each calls it from its own supervision path rather than through a faked `cancel`.

## Open questions

1. Is the account stream's exclusion from the chain a decision or an oversight? Migration 5's comment shows the triggers were added deliberately after review, which suggests the chain columns were considered and dropped — but nothing records why.
2. Was the lease store's "rebuildable" ever true, or is it aspirational text carried from ADR 0021?
3. Is there an intended compensating record for L3, or is the under-reported spend accepted?
4. Integrity is checked at every daemon start but not while it runs. Given that the check is a full replay of both streams, is a periodic re-check affordable, or is start-time the deliberate boundary?
