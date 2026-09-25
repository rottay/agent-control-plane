# ADR 0116 — A task changes step only by a recorded link

- Status: accepted (P-27, cut C, recorded 2026-09-25).
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0115 made a node's task "of its step": the task graph door refuses, as
`GRAPH_TASK_OUT_OF_SCOPE`, a node whose task did not enter on the graph's own
`(roadmapVersionId, stepId)`. The step a task entered on is its intake's fact, recorded
once in revision 1's `TASK_DISCOVERED`, and nothing moved it. Decision 196 and ADR 0115
§Two and §Consequences named what was missing: adopting a task that entered with no step,
and re-linking a task to the step of a later version, "quedan con dueño: un corte
posterior de P-27". This is that cut. The canon names the producer and nothing of its
design, so every choice below was the brief's proposal, audited by Fable before a line
was written (`fable-preaudit-wf.md`: B1–B4, N1–N17, ND-1..ND-10 adopted as rulings).

Five facts shaped the cut:

- Every intaken task already has an initiative: the envelope requires it and the intake
  refuses `INITIATIVE_UNKNOWN`. "Unlinked" means the pair `(roadmapVersionId, stepId)` is
  null, never the initiative, so a link always has a real initiative stream to live in.
- The graph door that consumes the fact reads the initiative read model inside the batch
  door's `BEGIN IMMEDIATE`; a link table of the same cohort is read in the same
  transaction, with no new cross-stream read.
- `task_read_model.step_id` is written once, from the intake, and decision 196's
  revision invariant rests on one writer of task-stream rows. Writing a link on the task
  stream would force either a cross-cohort rewrite or a second writer there.
- `TaskGraphDeclaration.nodeCount` has a minimum of 1, so a rule refusing a re-link while
  the task is a node of its step's current graph would leave a sole node unmovable.
- The step grammars are not nested (Fable B1). The intake DTO's `StepLocalKey` and the
  ledger's `LOCAL_KEY_PATTERN` admit 128 characters and no colon; `BoundedIdentifier`,
  the declared step's grammar, admits 120 and a colon.

The serial numbers were read from HEAD `4373ea7`: ADR 0116, decisions 200–203,
migration 27, `PATH_SCOPED_LAWS` 169 → 170, `API_CONTRACT_VERSION` 0.22.0 → 0.23.0,
`CONTRACT_VERSION` unmoved at 2.10.0.

## Decision

### One — the event, the stream and the identity (decision 200; ND-1, ND-6)

- `INITIATIVE_EVENT_TYPES` 6 → 7: **`TASK_STEP_LINKED`**, appended, a passthrough of the
  initiative's status as the graph types are. It is recorded on `initiative_events`: a
  task's step is planning semantics, and planning owns steps and graphs (datos §4).
- **`TaskStepLinkDeclaration`** (contracts, initiatives): `taskId`, `roadmapVersionId`,
  `stepId`, `fromRoadmapVersionId` nullable and `fromStepId` nullable, strict, under the
  standard guards. Both step ids are `BoundedIdentifier`, the declared step's grammar. A
  recorded intake pair copies into `from` **by construction, not by grammar**: decision
  197 admits an intake step only when its version declares it (`intake/index.ts`), and a
  declared step's id is a `BoundedIdentifier`. The schema proves what one value can prove
  about itself: the `from` pair is whole or absent (the issue names the missing half), and
  the target is not the `from` pair.
- **Identity, deterministic.** `transitionId = "link." + taskId + "." + roadmapVersionId`,
  78 characters, and the idempotency key is `buildInitiativeIdempotencyKey` over it. The
  chain rule (§Two) makes `(task, version)` unique: a task's targets are strictly later
  versions, so it is linked to one version at most once. No client link id, no link
  number; a retry from any client is a replay. `emittedBy` is the request's `linkedBy`;
  `occurredAt = recordedAt`, injected.
- **No contract bump** (ND-1): a new type whose ids are derived and where no existing
  shape gains a cohort is ADR 0072's "B declined" and ND-P27-5's precedent. A bump would
  also make every 2.10.0 task envelope unreadable (`readRecordedTask` admits the version
  in force, D-B-1) before P-16/A1 exists. P-16/A1 keeps 2.11.0 and renumbers its API
  minor to 0.23.0 → 0.24.0.

### Two — the door, the decision and the producer (decision 200; ND-5)

- **The single door, with its own grant.** A link is one event, through
  `appendInitiativeEvent`. After the exact replay and the contiguity guard, before
  causation and `#insertInitiativeRow(`, the door runs
  `if (event.type === "TASK_STEP_LINKED") this.#assertTaskStepLinkGranted(event);`, the
  roadmap version's mould. The batch door refuses the type by shape: a batch opens with a
  version or a graph header, and every event after either must be its step or its node.
  L-P26B-1 does not change.
- **One decision, six words.** `decideTaskStepLink` (ledger concept `task-step-link`) is
  pure over the payload and five questions only its caller answers; it runs at the door
  as the law and at the producer as the fast path. `TASK_STEP_LINK_REFUSALS`, closed and
  sorted: `LINK_DECLARATION_INVALID`, `LINK_HEAD_MISMATCH`, `LINK_STEP_UNKNOWN`,
  `LINK_TARGET_NOT_LATER`, `LINK_TASK_OUT_OF_SCOPE`, `LINK_TASK_UNKNOWN`. The order is
  the design, coarsest first, the task stream last and existence before scope:

  | # | Check | Word | `at` |
  | --- | --- | --- | --- |
  | 1 | the payload refused by the contract | `LINK_DECLARATION_INVALID` | the zod path under `link.` |
  | 2 | the target not declared under the event's initiative | `LINK_STEP_UNKNOWN` | `link.stepId` |
  | 3 | no task revision 1 recorded | `LINK_TASK_UNKNOWN` | `link.taskId` |
  | 4 | no recorded intake (a legacy task), or an intake of another initiative | `LINK_TASK_OUT_OF_SCOPE` | `link.taskId` |
  | 5 | `from` is not the task's current step | `LINK_HEAD_MISMATCH` | `link.fromRoadmapVersionId` when the versions differ or one is null, `link.fromStepId` when only the step differs (N9) |
  | 6 | a re-link whose target is another step id, or not a strictly later version | `LINK_TARGET_NOT_LATER` | `link.roadmapVersionId` |

  An **adoption** (`from` null, the task entered with no step) goes to any declared step
  of the task's initiative: no head-only rule, which ADR 0115 does not claim. A
  **re-link** goes to the same step id in a strictly later version, skipping versions
  allowed. The task's lifecycle state is not a condition: the main use of a re-link is
  carrying a `COMPLETED` dependency into the new version's graph. A different step id and
  another initiative are refused by name.
- **The producer.** `linkTaskToStep` (the `declareTaskGraph` mould): an unknown
  initiative is `LINK_STEP_UNKNOWN` at `initiativeId`; a row already recorded at
  `(taskId, roadmapVersionId)` is answered from that row — the same step, `from` pair and
  initiative are a replay, anything else `LINK_DECLARATION_INVALID` at
  `link.roadmapVersionId` (N17); otherwise it decides over its reader and appends through
  the single door. It opens nothing and reads no clock and no random source; ledger
  errors are thrown untouched. `LedgerTaskStepLinkRefusedError(reason, at)` carries the
  door's refusal, `LedgerTaskGraphRefusedError`'s mould.
- **The gateway.** `initiativeTaskStep`, `/api/v1/initiatives/:initiativeId/tasks/:taskId/step`,
  one route key with two arms (decision 194's house shape), both `API_ONLY`. POST, the
  eighth write, behind the bearer the registrar inherits: `TaskStepLinkRequest`
  (`version`, `stepId`, `from: { version, stepId } | null`, `linkedBy`), versions by
  number resolved inside the initiative, so a version of another initiative is
  unrepresentable; an unknown initiative, target version or `from` version is `404`; a
  decision refusal `409 WRITE_REFUSED` with its word and field; a door refusal after a
  grant or a lost key or id race `409 WRITE_REFUSED` carrying `WRITE_CONFLICT`, detail
  `taskStepLink` (the graph route's shape). GET, `TaskStepResponse`: `enteredOn`
  (the intake's pair, null when it named none), `links` in `sequence` order, and
  `current`, every version by number; an unknown initiative, or a task not of that
  initiative (a legacy task has none), is `404`. The path helper
  `initiativeTaskStepPath` validates both ids before encoding either (N3).

### Three — the table and the fold (decision 200; ND-2, ND-9)

- **Migration 27 `task_step_link`** creates `task_step_link_read_model`: `task_id`,
  `roadmap_version_id`, `step_id`, `initiative_id`, `from_roadmap_version_id` and
  `from_step_id` (NULL both or neither), `sequence`, `linked_at`. Primary key
  `(task_id, roadmap_version_id)`; an immediate foreign key `(roadmap_version_id, step_id)`
  to `roadmap_step_read_model`, of the same cohort (datos §8 item 1); the pair's CHECK
  spelled per predicate, `(a IS NULL AND b IS NULL) OR (a IS NOT NULL AND b IS NOT NULL)`;
  `ix_task_step_link_read_model__task_sequence` for "the last link"; and
  `tr_task_step_link_read_model__insert_only`, which aborts every update (ND-9). No
  foreign key to the task stream: that reference crosses streams and is checked at the
  door (datos §8 item 3). One watermark is seeded at the initiative head.
- **The fold.** `foldTaskStepLink` (projection, `foldTaskGraph`'s home) runs at the single
  door's projection, through a fresh fold over the read model, and at the rebuild's
  `applyInitiativeEventToSnapshot`. It refuses by the door's words only what the
  initiative stream judges alone: the shape; the step undeclared under the initiative; a
  `(task, version)` held twice (`LINK_DECLARATION_INVALID`); `from` against the task's
  last link, when it has one (`LINK_HEAD_MISMATCH`); a re-link's target as the same step
  in a strictly later version — a `from` version the initiative does not hold included
  (N8) — (`LINK_TARGET_NOT_LATER`). It asks no task-stream question. The row and the
  per-task head move only after every refusal of the event, and the head is held, never
  scanned for (decision 199's rule).
- `DERIVED_TABLES` lists the table beside the three graph tables, before the steps it
  names (N6); the rebuild inserts it after the steps.

### Four — the graph door's read, and READY's R1 (decisions 201 and 202; ND-3, B4)

- **One read of a task's current step.** `currentTaskStepLink(intake, links)` is pure:
  the last link by `sequence` (never by array position), projected to
  `{ initiativeId, roadmapVersionId, stepId }`, or failing that the intake's link, or
  failing that null. Three ledger callers: the graph door's `taskLink`, the graph
  producer's `taskLink` (through `getTaskStepLinks`), and the link decision's `from`
  check; and two consumers: the runtime's READY adapter (`readinessOf`) and the gateway's
  chain read (`taskStepChain`).
  `decideTaskGraph` and its seven words do not change; `GRAPH_TASK_OUT_OF_SCOPE` now means
  "not of the graph's step by its current link".
- **R1 gains a clause.** `ReadyInput.taskLinkCurrent: boolean` — the task's current link,
  by `currentTaskStepLink`, is this graph's `(roadmapVersionId, stepId)` under its
  initiative. R1 = `combine([graph revision current, task revision current,
  taskLinkCurrent ? SATISFIED : UNSATISFIED(TASK_LINK_MOVED), state])`.
  `READY_UNSATISFIED_REASONS` 11 → 12, sorted between `STEP_NOT_ADMITTING` and
  `TASK_NOT_CLASSIFIED`. Without it a re-linked task would be a node of two current graphs,
  and once P-21 declares the V2 cohort both could read READY: a false READY, later a
  double dispatch. `readinessOf` reads the revision-1 intake once per node and hands it to
  both this clause and R4's assignment, and reads `getTaskStepLinks`.
- **No current link is a block by definition**, on the `ASSIGNMENT_UNRESOLVED` precedent:
  a node whose task has no intake and no link reads `taskLinkCurrent: false`. Measured at
  the gateway: such a task — a legacy task planted as a node past the door that refuses
  it — also has no revision row, so R1's earlier clause, `TASK_REVISION_SUPERSEDED`,
  answers first; a planted task that entered with no step and was never adopted reads
  `UNSATISFIED(TASK_LINK_MOVED)`. No graph of this build holds either, because the door
  refuses both.
- In production nothing reads READY: a moved task's old node now reads the known block,
  which outranks the cohort's absence; every other node still reads
  `UNKNOWN(TASK_COHORT_LEGACY)`.

### Five — integrity (decision 202; ND-4, B3, N10)

- **The fold's refusal is reported, not thrown** (B3): `verifyIntegrity()`'s initiative
  replay admits `LedgerTaskStepLinkRefusedError` beside the version and graph refusals,
  with its own detail (`" records a task step link the fold refuses: "`), a `PROJECTION`
  problem at its sequence, and keeps folding. `rebuildReadModel()` still lets it throw.
- **Two cross-stream reports**, never a rebuild refusal: the task stream's intakes are
  captured in `verifyIntegrity()`'s own task replay (one pass, no reopen), and
  1. a task's first link must leave its intake — the link's `from` pair the intake's pair
     and its initiative the intake's (a link whose task has no intake is reported too);
  2. a graph node's task must have been of the graph's step **at the node's sequence** —
     its last link before the node, else its intake.
  Both are `PROJECTION` problems with the link's or the node's sequence. A node whose task
  moved later is lawful history and is not reported; READY answers it. This pays ADR 0115
  "Not in this record" item 4 now that a second producer of a task's step exists.
- The table is compared with a replay by the same three questions as the graph tables.

### Six — the numbers and the restamp class (decision 203; N1, N2, N4, N5)

- **The API literal.** Fourteen occurrences of `0.22.0` in seven files were measured at
  HEAD (Fable N1). Eleven are live literals and were restamped by recomputation to
  `0.23.0`, in five files: `protocol/src/version` (1), `protocol/test/schemas` (7),
  `cli/test/cli` (1), `cli/test/tool-call` (1), `gateway/test/tool-calls` (1). Three are
  history and were kept, each gaining its own `0.23.0` line: the version docblock's
  `0.21.0 → 0.22.0` paragraph, the protocol README's P-27 cut A bullet and the API
  reference's `ROADMAP_STEP_UNKNOWN, from 0.22.0`. ADR 0115, decisions 194 and 197, the
  P-27 packets row and the fence's P27A/P27B docblocks hold `0.22.0` as history and are
  not restamped.
- **Migration 27's restamp class.** Every rewind past 26 undoes 27 first:
  `dropTaskStepLink` first inside `dropTaskGraph` (`ledger/test/ledger`), the first line of
  `rewindTo23` and of the migration-26 upgrade (`ledger/test/migrations`), and the first
  statements of the five inline blocks (`cli/test/cli`, `gateway/test/build-server`,
  `gateway/test/roadmap-write`, `gateway/test/task-intake`, `gateway/test/task-graph`) —
  trigger, index, table, watermark. Pins recomputed, never lifted: `MIGRATIONS` 26 → 27,
  `tr_` 16 → 17, `PROJECTION_SOURCES` 31 → 32, `INITIATIVE_PROJECTION_NAMES` 7 → 8,
  `DERIVED_TABLES` 34 → 35, `EXPECTED_SCHEMA_OBJECTS` 129 → 132; in the ledger suite
  `status().projections` 30 → 31 (three sites, one beyond Fable's two), the watermark rows
  31 → 32 (six sites), `TASK_GRAPH_MIGRATION` → `TASK_STEP_LINK_MIGRATION` as the last
  applied (twelve sites), eight migration-version lists and two zero vectors that Fable's
  inventory did not list, each grown by one; the last-applied `26` → `27` at
  `roadmap-write`, `task-graph`, `cli/test/cli` and `gateway/test/build-server` (the
  fourth also unlisted). P-P18-2 for 26 → 27 lives in `gateway/test/task-step-link`, and
  `gateway/test/task-graph`'s P-P18-2 now rewinds 27 then 26 and lands at 27.
- **Other pins.** `API_ROUTES` 25 → 26, `API_WRITE_ROUTES` 7 → 8, `SURFACE_MAP` 36 → 38,
  `PARITY_ROUTES` 25 → 26 (the chain read bound whole to the ledger),
  `CONTRACTS_SCHEMA_EXPORTS` 183 → 184. Unmoved: `CONTRACT_VERSION` 2.10.0,
  `TASK_INTAKE_CODES` 12, `API_ERROR_CODES` 16, `RUNTIME_PUBLIC_EXPORTS` 307,
  `API_PRIVATE_READ_ROUTES` 1.
- **L-P27C-1** (`PATH_SCOPED_LAWS` 169 → 170, ND-8): the door grants the link under its
  literal before it inserts, and nowhere else; the batch door names the type nowhere;
  `decideTaskStepLink` and `currentTaskStepLink` have one home, and
  `TASK_STEP_LINK_REFUSALS` is a sorted literal there; every write naming the table is the
  door's `INSERT` inside `#insertTaskStepLink`, with no conflict clause, no `UPDATE` and
  no `DELETE FROM` by name. Its limits are L-P27-2's, plus one of its own: "declared
  once" matches only the spelling `export function <name>(`, so an `export const` of either
  name is caught only by the cross-package duplicate-export law, and a non-exported
  `function <name>(` in another package passes both; migration 27's trigger is the
  behaviour.

## Evidence

- `contracts/test/schemas`: an adoption and a re-link, each field absent or null, the
  half pair each way naming its half, the target equal to `from`, both step ids at 120
  and 121 and with a colon, a credential-shaped id, the passthrough.
- `ledger/test/task-step-link`: the six words, each by its one input in order, with
  existence before scope; adoption to a non-head step; V1 → V2 and V1 → V3; V2 → V1,
  V1:A → V1:B and V1:A → V2:B refused; a stale `from`; `currentTaskStepLink` over none,
  intake, intake and chain, and a chain out of array order; and B1's three grammar cases
  over `BoundedIdentifier`, the intake DTO's `StepLocalKey` (through `TaskIntakeRequest`)
  and the ledger's `LOCAL_KEY_PATTERN`. The contracts suite cannot import the other two
  grammars, so the three-way case lives here.
- `ledger/test/ledger`: an adoption through the single door with its row, watermark and
  an identical double rebuild; every word at the door with nothing appended and the head
  unmoved; an exact replay never re-judged after its own link moved the head, and a
  reused key conflicting; the batch door refusing the type in both shapes; the graph door
  after an adoption and a re-link, with a successor revision naming the moved task
  refused; the producer's replay, its `from` and initiative arms; a stale reader losing at
  the door; a planted out-of-chain link refused at rebuild and reported by
  `verifyIntegrity()`; and both membership reports on planted history.
- `ledger/test/projection`: the fold's words, a refused event consuming neither row nor
  head, N8, and the rebuild snapshot folding through the same function.
- `ledger/test/migrations`: migration 27's text and rosters, a fresh and an upgraded
  ledger, one NULL per predicate, both half-NULL cases, both lawful shapes, the foreign
  key, the primary key, and the trigger bitten by an update of every column.
- `runtime/test/ready`: the new producer row from an otherwise READY node, R1's clause
  order, and production's shape of a moved node.
- `gateway/test/task-step-link`: adoption and re-link through the real gateway and intake
  door, the graph door granting and refusing after them, the retry replay, every word as
  `409` at its field with the stream unmoved, `WRITE_CONFLICT` on a stale reader, the
  surface and the `404`s, the old graph reading `TASK_LINK_MOVED`, `readinessOf` over the
  two planted nodes of §Four, and P-P18-2 at 27. The runtime project may not import
  `node:sqlite`, so the planted-node cases live here, beside the real doors.
- `node scripts/check-architecture.mjs` with L-P27C-1, and each of its bites red on a
  disposable copy.

## Why the alternatives were not chosen

- **The task stream** would rewrite `task_read_model.step_id` across cohorts or add a
  second writer of task-stream rows beside the intake.
- **A client link id** adds a field and an id-reuse refusal and buys nothing the chain
  rule does not already give.
- **Refusing a re-link while the task is a node** of its step's current graph (ND-3 (A))
  leaves a sole node unmovable, since `nodeCount` is at least 1.
- **No READY change** (ND-3 (B-lite)) leaves `evaluateReady` a definition P-21 would
  inherit wrong.
- **No table** (ND-2 (b)), probing the stream by the derived key, would make an
  idempotency key a query key and give the read and the reports no rows.
- **Bumping the contract** would push P-16/A1 to 2.12.0 and strand every 2.10.0 envelope
  before A1 exists.

## Consequences

- A3's unambiguous step holds across versions: at every sequence a task has exactly one
  current step, or none, derived from its intake and its ordered links, never inferred,
  and the graph door reads it.
- A task can be carried into a later version's graph of the same step, and a task that
  entered with no step can be adopted onto one. A moved task's old node reads a known
  block. Nothing dispatches, and no node reads READY in production.
- The initiative stream's vocabulary is seven names; the timeline and every consumer
  derive it.

## Residuals, with their owners

- The chain read's `links` is bounded by `MAX_PAGE_LIMIT` (200), the roadmap history's
  bound; a task with more links than that answers `INTERNAL` on its read. A task gains one
  link per later version, so the bound is a version count. Owner: **P-27**, with the
  roadmap history's same bound.
- The gateway's vitest project resolves `@acp/runtime` from its build output (ADR 0115's
  residual, unchanged).
- The single door does not require the derived identity: a direct caller of
  `appendInitiativeEvent` may record a `TASK_STEP_LINKED` under another `transitionId` or
  idempotency key. The chain rule and the primary key still keep `(task, version)` unique,
  the producer replays from rows, and integrity stays clean; the graph door has the same
  mould (it does not enforce `graph.<id>`). Owner: **P-27**, beside the graph door's.

## Not in this record

- **A colon in a step id** (B1 (iii)): `BoundedIdentifier` admits one, the intake's
  `StepLocalKey` does not, so a step so declared can never receive a task by intake. A
  P-27/A residual; owner the **P-27** row. This cut does not touch the intake.
- **"Tasks currently of a step"** as a read (ND-7's rejected alternative): its rows would
  need the intake's version, which `task_read_model` does not hold. A residual for the
  planner UI.
- **Un-linking** a task back to no step: unrepresentable, the target is required.
- **A move to a different step id, or across initiatives**: refused by name. The canon
  names only adoption and same-id re-link; a wider move needs a new DT or owner decision.
- **The three sibling O(N²) rebuild scans** (`foldRoadmapStep`, `assertRoadmapStepsComplete`,
  `hasVersionNumber`): decision 199's, a later cut of **P-27**.
- **`task_read_model.step_id`** stays the intake's fact, never rewritten. The task read
  (`GET /tasks/:taskId`) names no step at all; a task's current step is read on
  `initiativeTaskStep`.
- Step transitions (with **P-21**), the V2 cohort (**P-21**), A5's measurements (**P-19**,
  **P-21**), re-resolving a moved task's routing assignment (**P-28**: a moved task keeps
  its intake's resolution), a CLI verb for the link, and a console view (G-UI).
