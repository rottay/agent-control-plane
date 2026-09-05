# acp-wiring — audit report (snapshot 4569478)

## Score: 4 / 10 for end-to-end connectivity

The one production path is genuinely joined: `acp-daemon` really does read a
config, take a lease, walk a ledger plan, spawn an admitted provider binary and
record what came back, and I traced every hop in source rather than in prose.
What travels that path is empty — nothing anywhere in the tree ever tells the
model what to do, and five of the eleven lifecycle steps append a claim
(verified, audited, committed, checkpointed) that no code performs. Around that
spine, three of the nine public-side packages are near-total islands: the
enforcement plane, the observation plane and the account-switch chain are
complete, tested and reachable from nothing.

---

## Findings

### W1 — No instruction ever reaches the model; stdin is opened and abandoned
**Class 1 (real blocking defect).**

`buildArgv` (`packages/edges/providers/src/claude/index.ts:81-106`) produces
exactly seven arguments and none is a prompt. The suite pins it by equality:

```
packages/edges/providers/test/claude/index.test.ts:121-133
expect([...descriptor.argv]).toEqual([
  "-p","--output-format","stream-json","--model","opus","--session-id",TASK ]);
```

Run at HEAD:
```
$ pnpm exec vitest run --project providers packages/edges/providers/test/claude/index.test.ts
 ✓ |providers| test/claude/index.test.ts (29 tests) 874ms
 Test Files  1 passed (1)   Tests  29 passed (29)
```

`claude -p` with no positional prompt reads the prompt from stdin. Nothing writes
it and nothing ends it:
```
$ grep -rn "stdin" packages/edges/providers/src/
(none)
```
`spawnAdmitted` opens `stdio: ["pipe","pipe","pipe"]`
(`packages/edges/providers/src/process/spawn/index.ts:73-79`) and no module in
the package touches `child.stdin`. The only `child.stdin.write` in the repository
is the MCP transport at `packages/edges/tools/src/stdio/index.ts:115`, a
different path.

The absence is structural, not an oversight at one call site.
`SessionRequest` (`packages/edges/providers/src/contract/index.ts:193-203`) has
nine fields and no content field. `ExecutionRequest`
(`packages/kernel/contracts/src/schemas/execution-boundary/index.ts:202-216`) has
four: `taskId`, `attempt`, `identity`, `reattach`. `TaskEnvelope.objective` does
exist (`packages/kernel/contracts/src/schemas/task-envelope/index.ts:42`) and the
daemon validates it at the config door, but no production module reads it:
```
$ grep -rn objective --include='*.ts' packages/ | grep -v /test/ | grep -v /dist/
```
returns only the schema declaration, comments, and the gateway's initiative
*projection* (`gateway/src/initiatives/index.ts:99`, `mappers/index.ts:124`),
which is a read model of a different entity.

Kimi and Codex are worse than silent. Their argv are `["acp"]`
(`kimi/index.ts:146-148`) and `["app-server","--listen",…]`
(`codex/index.ts:240-242`) — bidirectional JSON-RPC servers that produce nothing
until a client writes a request frame on stdin, which this package cannot do.

**Impact.** The claim "the control plane runs agents" is false at HEAD. A real
`claude` binary spawned this way blocks on stdin until `limits.timeoutMs` and is
SIGKILLed. Every green drill uses a fake binary that ignores argv and writes
canned lines (`daemon/test/drills/execution/index.test.ts:1654-1675`;
`providers/test/testing/index.ts:47-60`), so no test can see this.

**Minimal fix.** Add one content field to `ExecutionRequest` and
`SessionRequest`, source it from `TaskEnvelope.objective` at the daemon call
site, pass it as the `-p` positional (or write-then-`end()` stdin), and add an
argv/stdin assertion driven by a child that *echoes what it received*.
**Phase:** V2 wave B1 — nothing downstream is worth building until this lands.

### W2 — No door starts a task; the daemon is a one-shot config runner
**Class 1.**

`startDaemon` runs the work inside startup and returns: `admitWalks` at
`daemon/src/index.ts:898`, `runAdmitted` at `:920`, then `publish("READY")` and
`publish("SUPERVISING")` at `:934-937`. There is no queue, no poll loop and no
listener. `runDaemonChild` (`daemon-child/index.ts:494-575`) then either calls
`stopDaemon` and exits, or holds a `setInterval` keep-alive waiting for a signal
while doing no further work.

The walks come from the config file only, as literal JSON (`parseWalks`,
`daemon-child/index.ts:236-300`). Nothing constructs a `TaskEnvelope`: every
production reference declares the schema, `safeParse`s one, or reads its fields.

The other doors do not submit either. The API has three write routes —
`accountActions` (`gateway/src/routes/index.ts:737`), `initiativeRoadmap`
(`:820`), `taskToolCalls` (`:922`) — and none starts an execution. The CLI has
eleven verbs (`cli/src/cli/index.ts:191-260`): nine read-only ledger queries,
`tool-call` (one MCP call plus a receipt), and `submission`, which reads a config
document, re-elects its route and prints it — "It writes nothing and opens no
ledger" (`cli/index.ts:775-777`), confirmed by the body at `:930-1010`.

`docs/operations/runbook.md` has no procedure for running a task at all. It
covers `pnpm check`, building the two surfaces, reading a ledger, starting
`acp-server`, acquiring Restate and stopping. `acp-daemon` appears nowhere in it:
```
$ grep -rn "acp-daemon" docs/
docs/architecture/0008-…:31, :58   docs/architecture/0006-…:156
```
Three ADR mentions, zero runbook mentions.

**Impact.** An operator has no supported way to run one task, and no example
config exists to copy. **Minimal fix.** Either a submission door that composes
an envelope, or — cheaper and honest — a documented `acp-daemon` procedure with a
worked config in the runbook. **Phase:** B1 (doc) / B-C (door).

### W3 — Five of eleven plan steps append claims that nothing performs
**Class 1.**

`LIFECYCLE_PLAN` (`runtime/src/core/lifecycle/index.ts:51-64`) has one
effect-bearing step. Index 4 is `INTENT`, index 5 is `OUTCOME`; indices 6-10 —
`VERIFICATION_COMPLETED`, `AUDIT_COMPLETED`, `TASK_STATE_CHANGED` to
`READY_TO_COMMIT`, `COMMIT_RECORDED`, `CHECKPOINT_WRITTEN` — are all `PLAIN`.
`appendPlanStep` (`core/step-executor/index.ts:264-278`) builds an event and
appends it; there is no other branch. `payloadFor` (`core/events/index.ts:103-150`)
gives a `PLAIN` step `{submissionDigest, beat, planIndex}` — no commit sha, no
checkpoint digest, no verifier verdict. The `Checkpoint` schema
(`contracts/src/schemas/checkpoint/index.ts:26`) is produced by nothing.

Compounding it: the daemon hardcodes `commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT"`
at three call sites (`daemon/src/index.ts:638`, `:655`, `:882`) and never reads
`envelope.commitPolicy`, which the config door validated. A `NO_COMMIT` packet
walks the commit plan.

**Impact.** A completed walk leaves a ledger that reads as verified, audited,
committed and checkpointed work. Every downstream projection and the console
inherit that. **Minimal fix.** Read the policy from the envelope; make 6/7/9/10
`INTENT` beats with real effect ports, or delete them from the plan until they
have one. **Phase:** B-D.

### W4 — The enforcement plane is complete and unreachable, and the daemon
re-implements one of its decisions inline. **Class 2.**

`authorizeCommit`, `recordCommit`, `quarantineWorktree` and `verifyPrestate` are
exported from `@acp/runtime` and imported by nothing outside their own package.
Meanwhile the daemon's conformance gate (`daemon/src/index.ts:1092-1172`) reaches
the same outcome by hand: on a non-conformant worktree it appends
`verdict.events` and then a `TASK_STATE_CHANGED` to
`verdict.recommendedTaskState` (`:1140-1166`) rather than calling
`quarantineWorktree`. That is a second producer of the quarantine decision, which
this codebase forbids everywhere else it states the rule.

`checkWriteSetConformance` is the one enforcement name that *is* wired
(`daemon/src/index.ts:1116`), and P6 shipped the rest. **Minimal fix.** Route the
gate through `quarantineWorktree`; give commit authorization a call site or mark
the modules unadopted in the barrel. **Phase:** B-D.

### W5 — `@acp/observation` has one importer and three names
**Class 2.**

```
$ grep -rn '@acp/observation' --include='*.ts' packages/*/*/src/
gateway/src/initiatives/index.ts:2: import { UNSCOPED_INITIATIVE, computeTokenRollups } …
gateway/src/initiatives/index.ts:3: import type { TaskTokenRollup, TokenRollups } …
```
One file, four names, out of 64 barrel exports. `emitTelemetry`,
`toLangfuseTrace`, `computeBaseline`, `buildShadowLedger`, `admitArtifact`,
`serializeBaseline` and the whole acceptance/rework/routing baseline family have
no production caller anywhere. Telemetry is emitted by nothing, so no span, trace
or baseline is ever produced by a running plane.

**Impact.** The P8 exit criteria (routing agreement ≥95%, token deltas, median
time) are computed by code no run invokes, so they cannot be measured from a real
walk. **Minimal fix.** Call `emitTelemetry` and `computeBaseline` from the daemon
walk boundary where `recordUsage` already sits. **Phase:** B-E.

### W6 — The account-switch chain never fires
**Class 2.**

`decideSwitch`, `planSwitch` (`@acp/accounts`) and `executeSwitchPlan`
(`@acp/runtime`) have no cross-package importer. `routeWithPolicy` likewise. The
gateway's `account-actions` route records an `AccountAction` row
(`gateway/src/account-actions/index.ts:1-10`) and never consults them, and the
daemon has no quota-exhaustion path. `switch-executor/index.ts:8` imports only
the `SwitchPlan` *type*. `docs/operations/account-switch.md` documents a
behaviour that no code triggers.

Note this is *not* true of the conflict graph: the fence claim "the scheduler
asks the conflict graph before it takes a lease" holds — `admitWalks` calls
`checkAdmission` (`daemon/src/scheduler/index.ts:155`), which shares
`verdictOver` with `buildConflictGraph` (`conflict-graph/index.ts:351`, `:384`).
`buildConflictGraph` is a redundant second entry point, not a dead decision.

**Phase:** B-E.

---

## Connected vs island map

Island counts are a **lower bound**: the sweep matched each barrel name anywhere
in another package's `src/`, comments included, so a name mentioned only in prose
counts as used.

| package | barrel exports | zero external | real production consumers |
| --- | --- | --- | --- |
| contracts | 100 | ≥29 | every package — **connected** |
| protocol | 132 | ≥59 | gateway, cli, console — **connected** |
| ledger | 96 | ≥52 | runtime, observation, durability, daemon, gateway, cli — **connected** |
| runtime | 206 | ≥127 | daemon, durability, gateway, cli — **partly connected** |
| accounts | 72 | ≥53 | `resolveRoute` via runtime; `estimateQuota`, loaders via gateway/cli — **thin** |
| observation | 64 | ≥58 | gateway, 1 file, 4 names — **island** |
| providers | 87 | ≥70 | daemon only, ~10 names — **thin but load-bearing** |
| durability | 28 | ≥10 | daemon only — **connected** |
| tools | 42 | ≥33 | gateway + cli, via `admitToolServers`/`openToolOperation` — **connected** |

Named suspects, resolved: **islands** — `emitTelemetry`, `toLangfuseTrace`,
`executeSwitchPlan`, `buildConflictGraph`, `authorizeCommit`, `recordCommit`,
`quarantineWorktree`, `verifyPrestate`, `computeBaseline`, `routeWithPolicy`,
`decideSwitch`, `planSwitch`, `rankAccounts`, `Checkpoint`. **Connected** —
`checkAdmission` (daemon scheduler), `computeTokenRollups` (gateway),
`resolveRoute` (runtime submission → CLI), `cancellationPrecheck` /
`settleCancellation` (restate driver), `openToolClaimStore` and `publishArtifact`
(gateway), `acquireLease` (daemon arbiter). `startSession` and `admitWalks` are
package-internal, not islands.

**Verdict on "módulos correctos pero aislados": confirmed, with a sharper
diagnosis.** The isolation is real but secondary. The spine is wired; what it
carries is empty. A plane that executed instructions and skipped telemetry would
be a plane with a gap. This one runs a provider that was told nothing, then
records that the result was verified, audited, committed and checkpointed.

---

## Verified claims that hold

- **One spawn authority.** `node:child_process` is imported once in the providers
  package (`process/spawn/index.ts:1`) and called from one place
  (`session/index.ts`, via `spawnAdmitted`).
- **Environment is allowlisted, never inherited.** `buildEnv`
  (`config-root/index.ts:105-116`) constructs `{HOME, LC_ALL, PATH,
  CLAUDE_CONFIG_DIR}` key by key; `process.env` is read there and nowhere else in
  the package and is never spread.
- **The daemon does not resolve routes.** The route arrives parsed through the
  contract's own `ResolvedRoute` at the config door
  (`daemon-child/index.ts:172-180`) and is pinned by a submission digest
  recomputed at `:446-460`.
- **Graph before lease.** `admitWalks` calls `checkAdmission` before
  `ports.acquire` and `continue`s on refusal without touching the arbiter
  (`scheduler/index.ts:155-207`).
- **Three write routes**, matching the fence line "19 routes … with 3 write
  routes agreeing both ways".

## Open questions

1. Was the empty `ExecutionRequest` a deliberate transport-agnostic decision
   deferring content to a later wave, or was the instruction channel simply never
   specified? The contract comment at `execution-boundary/index.ts:193-201`
   explains what was *excluded* (budgets, binaries, workdirs) and never mentions
   content, which reads as an omission rather than a ruling.
2. Is `RESTATE` mode intended to become the resident service, or is
   one-shot-per-config the settled shape? `startRestateMode` supervises a server,
   but the walk still completes inside `startDaemon`.
