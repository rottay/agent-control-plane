# ADR 0115 — A step declares its task graph, all or none, and READY is pure

- Status: accepted (P-27, cut A, recorded 2026-09-25).
- Supersedes: none.
- Superseded-by: none.

## Context

Requirement A3 asks for a plan whose step, dependency and state are unambiguous, where a
cycle or a missing reference is refused naming the nodes. Requirement A5 asks that the
DAG run only nodes that satisfy "the READY predicate of four conditions", with fan-in,
concurrency and the failed-dependency policy measured. P-26 left what A3 hangs on: steps
addressed as `(roadmap_version_id, step_id)`, a `stepId` stable across versions and a
`dependencyRank` per step (ADR 0111). Planning §5 already specifies the three tables of
a step's task graph.

Six facts shaped the cut:

- No canon enumerates the four conditions (ND-P27-1: "cuatro condiciones" occurs once,
  at A5), and planning §5.3 delegates the three failure policies to "the scheduler's
  contract", which does not exist. The DT adjudicated both with Fable
  (`nd-p27-1-adjudication.md`): R1–R4, tri-state, `UNKNOWN` never READY, and the policy
  oracle as a **definition**.
- Contracts §2.2 forbids reading a legacy state as a V2 one, and no V2 task-state enum
  exists in code: `LIFECYCLE_STATES` is exactly §2.2's legacy cycle. The DT did not
  declare this build's tasks the V2 cohort (adjudication 2).
- No producer writes a step transition, an approval, a per-revision task terminal
  (D-S1-4) or a STEP/INITIATIVE routing assignment. What exists is the intake's
  recorded resolution and today's GLOBAL reading.
- The task stream records task revisions (`task_revision_read_model`, P-05/B); a graph
  names them across streams, which datos §8 item 3 says is typed and checked at the
  door, never a foreign key.
- P-26 left a debt reassigned here (decision 193): the intake admitted a `stepId` its
  linked version does not declare.
- A task's step is recorded once, by its intake: revision 1's `TASK_DISCOVERED` carries
  `initiativeId` and the pair `(roadmapVersionId, stepId)`, both null or both set.
  `task_read_model` holds the initiative and the step id but not the version, so a step
  id alone does not name a step across versions (datos §7 item 4).

The serial numbers were read from HEAD `b2207f8`, not from the brief's queue (Fable C1):
ADR 0115, decisions from 194, `PATH_SCOPED_LAWS` 167 → 169, `API_CONTRACT_VERSION`
0.21.0 → 0.22.0, `CONTRACT_VERSION` unmoved at 2.10.0, migration 26.

## Decision

### One — the storage, the doors and the numbers (decision 194; ND-P27-4, -5, -7, -8)

- **Migration 26 `task_graph`** creates planning §5's three tables exactly:
  `task_graph_revision_read_model` (PK `graph_revision_id`, an immediate foreign key on
  `(roadmap_version_id, step_id)` to the step table — same initiative-stream cohort —
  `declared_at`, `superseded_by` NULL, `sequence`), `task_graph_node_read_model` (PK
  `(graph_revision_id, task_id, task_revision_number)`, revision number ≥ 1) and
  `task_dependency_read_model` (PK over the revision and both task revisions, a foreign
  key to each end as a node of the same revision, `fail_policy` spelled
  `IS NOT NULL AND … IN (…)`, `step_id` denormalized, planning's pair-wise
  `ck_task_dependency_read_model__no_self`, and `ix_task_dependency_read_model__depends_on`).
  Three watermarks are seeded at the initiative head, migration 25's text. The
  `tr_task_graph_revision_read_model__supersede_once` trigger admits one update — a
  revision's `superseded_by`, from NULL to a revision — and aborts on a second
  supersede, on a NULL and on any other column, compared with `IS NOT` (Fable N3).
- **The contract** gains `TaskGraphDeclaration` (the header), `TaskGraphNodeDeclaration`
  (a node and its incoming edges), `DEPENDENCY_FAILURE_POLICIES` (datos §6.4, sorted),
  `TASK_GRAPH_NODES_MAX` (200) and `TASK_GRAPH_DEPENDS_ON_MAX` (32), and
  `INITIATIVE_EVENT_TYPES` gains `TASK_GRAPH_DECLARED` and `TASK_GRAPH_NODE_DECLARED`,
  both status passthroughs. The largest node — index 199 with 32 edges at the largest
  revision number — rides one event under `EVENT_PAYLOAD_MAX_BYTES`, asserted from the
  same constants (N6). A declaration carries every edge's `failPolicy`; the door fills
  in no default (N5).
- **`CONTRACT_VERSION` does not move** (ND-P27-5): `graphRevisionId` is the producer's,
  checked for existence and never derived, and no existing shape gains a cohort — ADR
  0072's "B declined" precedent for a new type.
- **One route key**, `initiativeStepGraph`,
  `/api/v1/initiatives/:initiativeId/roadmap/steps/graph?version=&stepId=`, two arms
  (ND-P27-4): POST declares a revision behind the bearer the registrar inherits, the
  seventh write; GET reads the step's current revision with each node's verdict,
  computed at read time and never stored, and echoes the instant as `evaluatedAt`,
  which is the gateway's composition clock, `options.now` (ND-P27-7, N12). Both arms
  are API_ONLY under the standing reasons (N10). `API_CONTRACT_VERSION` 0.21.0 →
  **0.22.0**: the route surface moves, the timeline's type enum widens by derivation,
  and the intake's refusal message gains two words.
- **The arithmetic, recomputed.** The brief counted two route keys; one key with two
  arms is the house's write shape, and two keys would demand three surface arms where
  the brief itself counts two. So `API_ROUTES` 24 → **25**, `API_WRITE_ROUTES` 6 → 7,
  `SURFACE_MAP` 34 → 36, `PARITY_ROUTES` 24 → **25**.
- **One cut** (ND-P27-8): the types alone would widen the timeline enum, so the door
  and the API land together.

### Two — the door refuses by name, and the fold writes from payloads (decision 196; A3, C4, N1, N2)

- **`decideTaskGraph`** (ledger concept `task-graph`, beside the fold) is pure over the
  batch's payloads, the declaring initiative, and five questions only its caller
  answers: whether the revision id is held, whether the step is declared under the
  initiative, the step's current revision, whether each task revision exists, and the
  step each task entered on. Seven words, sorted:
  `GRAPH_DECLARATION_INVALID` (a header or node the contract refuses, a reused id, a node
  of another revision, an index out of order, a repeated node, an edge to no node),
  `GRAPH_DEPENDENCY_CYCLE`, `GRAPH_HEAD_MISMATCH` (the supersedes claim is not the
  step's current revision, null only when there is none), `GRAPH_NODE_COUNT_MISMATCH`,
  `GRAPH_STEP_UNKNOWN`, `GRAPH_TASK_OUT_OF_SCOPE` and `GRAPH_TASK_UNKNOWN`. Coarsest
  first; the task stream is asked last, existence before scope, so a missing task is
  refused for its absence and never for its scope.
- **A node's task is of its step** (A3, "paso … inequívoco"; the verifier's V1-1, ruled
  (a) by Fable's stop-ruling 2). A node asserts that its task belongs to the graph's
  step, so the decision asks `taskLink(taskId)` — the task's recorded intake, read from
  revision 1's event through `taskIntakePayloadOf` — and refuses
  **`GRAPH_TASK_OUT_OF_SCOPE`** at `nodes[i]` in three cases under one word: the task
  entered under another initiative; it entered linked to another
  `(roadmapVersionId, stepId)`; or it has no link — it entered with none, or has no
  recorded intake at all (a legacy task holding revision rows). The match is exact on
  the pair, because the pair is the step's identity: after a roadmap revision a task
  entered on version 1's `A` is not a node of version 2's `A`. A task is therefore a
  node of one step's graphs only, and a graph's verdicts read only its own
  initiative's tasks. Adopting an unlinked task into a step, and re-linking a task to a
  later version's step, need a producer this cut does not have (owner: a later cut of
  **P-27**). The read rests on one invariant: a task revision record is written once.
  `task_revision_read_model` has one writer in `packages/*/*/src`, the task door's
  `#insertTaskRevision`, and the rebuild's snapshot keeps the same rule; both refuse a
  second, different record at a coordinate and never rewrite its `sequence`. So the
  event behind revision 1's row is the one first recorded there, and when that is an
  intake it stays the intake. A later writer of that table must keep the row's
  `sequence` fixed, because the graph door reads the link through it.
- **A cycle names its nodes** (A3): by task id and revision, in edge order, from the
  member of the lowest `nodeIndex`, back to it; sixteen members at most, then the count.
  Identifiers only.
- **The door.** `appendInitiativeBatch` gains a second shape, chosen by the first
  event's type: a `TASK_GRAPH_DECLARED` then its `TASK_GRAPH_NODE_DECLARED`s in
  `nodeIndex` order, one initiative, the header counting its nodes. Inside the batch's
  `BEGIN IMMEDIATE`, `#assertTaskGraphGranted` runs the one decision over the read model
  and the task stream's `task_revision_read_model` — the reader behind
  `getTaskRevision(taskId, revisionNumber)` (C4) — with each task's link read from its
  revision 1 row's event in the same transaction, and refuses with
  `LedgerTaskGraphRefusedError`. The producer answers the same question through its
  reader, `getTaskRevision(taskId, 1)` then `getEventBySequence`; both call
  `taskGraphLinkOf` over the same bytes. Whole-batch replay holds unchanged (decision
  174).
- **L-P26B-1 widened in place** (N1): the single door refuses the two literals
  `"TASK_GRAPH_DECLARED"` and `"TASK_GRAPH_NODE_DECLARED"` beside the step's, before its
  insert; the batch door reaches `#insertInitiativeRow(` only after both
  `#assertRoadmapVersionGranted(` and `#assertTaskGraphGranted(`; the graph shape
  requires its nodes' type. The register row names the task graph; the register does
  not move for it.
- **The fold**, shared by the batch and the rebuild, writes the three tables from the
  payloads only and refuses by the door's words what the door refuses of the initiative
  stream: the id, the step, the head, the count, the order and the edge ends. It asks
  no task-stream question — neither a task revision's existence nor its scope. Those
  are the door's, read against the task stream in the same transaction and never
  copied (planning §5 "Rebuild"), so the rebuild never reopens the task stream to ask
  them again. Rows are
  insert-only — no conflict clause — and the one update is the predecessor's
  `superseded_by`, at one site, `#supersedeTaskGraphRevision`, called only from
  `#projectTaskGraphBatch` (N2). **L-P27-2** holds it: every write naming the three
  tables — an `INSERT`, a `REPLACE`, an `UPDATE` or a `DELETE FROM`, the name bare or
  qualified with the `main` schema — is in the ledger door, none with a conflict clause and none a `DELETE FROM` by name (the rebuild clears
  them through `DERIVED_TABLES`), exactly one `UPDATE`, of that column, at that site. The rebuild writes each revision with the `superseded_by`
  its fold left it with, so it updates nothing.
- **The producer.** `declareTaskGraph` answers a revision id already recorded from the
  rows it wrote — the same step, predecessor, nodes and edges are a replay, anything
  else `GRAPH_DECLARATION_INVALID` at the id — and otherwise decides over its reader and
  appends through the batch door, where the decision runs again as the law. The gateway
  seam maps the producer's refusal to `409 WRITE_REFUSED` with the word, and a refusal
  from the door after a grant, a batch conflict or a lost key race to `WRITE_CONFLICT`.

### Three — READY: four conditions, three answers, one definition (decision 195; ND-P27-1, ND-P27-6)

`evaluateReady(input)` (runtime concept `ready`, a scheduler concept, ND-P27-6) judges
one node:

| Condition | Rule |
| --- | --- |
| **R1** in force | graph revision current, else `GRAPH_REVISION_SUPERSEDED`; task revision current, else `TASK_REVISION_SUPERSEDED`; the task's state as §2.2's union — `LEGACY` → `UNKNOWN(TASK_COHORT_LEGACY)`, `TASK_V2` not `CLASSIFIED` → `TASK_NOT_CLASSIFIED` |
| **R2** dependencies | each edge by the oracle below; nothing produced for the edge's revision → `UNKNOWN(DEPENDENCY_OUTCOME_UNPRODUCED)`; a legacy terminal → `UNKNOWN(DEPENDENCY_COHORT_LEGACY)`; an effect in `OUTCOME_UNKNOWN` → `UNKNOWN(DEPENDENCY_OUTCOME_UNKNOWN)` |
| **R3** scope | step `READY`/`RUNNING` admits; `DECLARED` admits only with no `dependsOn`, else `UNKNOWN(STEP_DEPENDENCIES_UNPRODUCED)`; `PAUSED`/`DONE`/`CANCELLED` → `STEP_NOT_ADMITTING`; initiative not `ACTIVE` → `INITIATIVE_NOT_ACTIVE` |
| **R4** authority | the assignment unresolved → `ASSIGNMENT_UNRESOLVED`; the approval clause over the A6 class only (`PLAN`, `STEP`, `TASK`): no producer → `UNKNOWN(APPROVAL_UNPRODUCED)`; required and absent, pending, denied or cancelled → `APPROVAL_REQUIRED`; `REVOKED`/`EXPIRED` by event, another digest, an `expires_at` not in canonical form (judged before `now` is consulted), or `expires_at` not after the injected `now` → `APPROVAL_STALE`; `now` null or not canonical where an expiry must be compared → `UNKNOWN(INSTANT_UNAVAILABLE)` |

A node is READY iff all four are `SATISFIED`; `UNKNOWN` is never READY. Within a
condition **a known block outranks an absence**: the first `UNSATISFIED` clause is the
answer, else the first `UNKNOWN`. The reasons are two closed, sorted vocabularies —
eleven blocks and seven absences — exported with their producer, each driven by one
test from an otherwise READY node (N11).

**The oracle is the definition of the three policies** (adjudication 3, 4; planning §5.3
names no semantics):

| dependency (TASK_V2) → | COMPLETED | FAILED | CANCELLED | SUSPECT_WORKTREE | not ended |
| --- | --- | --- | --- | --- | --- |
| **WAIT_SUCCESS** | SAT | `DEPENDENCY_BLOCKED` | `DEPENDENCY_BLOCKED` | `DEPENDENCY_QUARANTINED` | `DEPENDENCY_PENDING` |
| **ALLOW_FAILURE** | SAT | SAT | `DEPENDENCY_BLOCKED` | `DEPENDENCY_QUARANTINED` | `DEPENDENCY_PENDING` |
| **REQUIRE_TERMINAL** | SAT | SAT | SAT | `DEPENDENCY_QUARANTINED` | `DEPENDENCY_PENDING` |

plus two rows under every policy: `OUTCOME_UNKNOWN` → `UNKNOWN(DEPENDENCY_OUTCOME_UNKNOWN)`
and a legacy terminal → `UNKNOWN(DEPENDENCY_COHORT_LEGACY)`. One test per cell, 15 + 6.
`DEPENDENCY_BLOCKED` names the same fact as estimation's `UnknownReason` word on another
axis: two vocabularies, one of them not yet code (N7).

**L-P27-1** keeps it pure: one home, no clock named in the module (`Date`,
`performance`, `hrtime`, `uptime`, `Temporal`, `DateTimeFormat`), no ledger in the
predicate's body, and the two arrays sorted, disjoint and declared once.

### Four — production feeds named absences (decision 195; C3, ND-P27-9's sibling)

`readinessOf(ledger, graphRevisionId, now)` builds every input from a row that exists, or
names its absence and the row that owns the producer:

- the task's state is `LEGACY` always — no V2 cohort is declared (owner: **P-21**);
- a dependency's terminal is its task's state only when the edge names the task's current
  revision, else `UNPRODUCED`, because nothing records a revision's own terminal
  (D-S1-4, owner: **P-18**);
- the step's state and whether it has `dependsOn`, from P-26's rows (step transitions:
  a later cut of **P-27**, with **P-21**);
- the assignment, by option (a) of Fable's C3: the intake's own recorded resolution —
  role, slot, transport, assignment — read by task through the readers that exist
  (`getTaskRevision(taskId, 1)`, its event, `taskIntakePayloadOf`), re-resolved through
  the intake's `assignmentReadingOf` and `resolveAssignment` against today's
  `getGlobalRoutingAssignment({ role, slot })`; equal assignment id → satisfied, else
  `ASSIGNMENT_UNRESOLVED`. GLOBAL only; STEP > INITIATIVE > GLOBAL is **P-28**'s. No new
  ledger reader was needed for it; `getRoadmapVersion` is the one reader added, to read a
  revision back to its initiative. A task with no recorded intake has no assignment to
  hold and reads `UNSATISFIED(ASSIGNMENT_UNRESOLVED)`, a block by this definition and not
  an absence (Fable's C3(a)); since the door refuses such a task as a node
  (`GRAPH_TASK_OUT_OF_SCOPE`), no graph of this build holds one. The GLOBAL assignment
  document re-published, even with the same content, is another assignment by identity
  and reads the same block; its lifter, re-resolution after a registry re-publication,
  is **P-28**'s;
- approvals: no producer (owner: **P-28**).

**Declared consequence:** in this build no node reads READY in production — R1 is
`UNKNOWN(TASK_COHORT_LEGACY)` for every node — never a false READY and never a false
block. The door, the tables and the oracle are the work; the GET is the one production
consumer, and it dispatches nothing.

### Five — the intake's step exists in its version (decision 197; C2, decision 193)

`preconditions` in the runtime intake, right after `ROADMAP_VERSION_UNKNOWN`, with the
version in hand: `stepCount === null` → `REQUEST_INVALID` / **`ROADMAP_STEPS_UNDECLARED`**
at `stepId` — a version of the cohort before steps declares nothing, and says so by its
own word; otherwise a `stepId` absent from `listRoadmapSteps(roadmapVersionId)` →
`REQUEST_INVALID` / **`ROADMAP_STEP_UNKNOWN`** at `stepId`, which a version counting 0
answers for every step: unknown is never zero. The null cohort is refused, fail-closed,
rather than admitted (**ND-P27-9**): a write door has two answers, and datos §6.5 forbids
inventing a third. `TASK_INTAKE_CODES` 10 → 12, sorted; `TASK_INTAKE_WRITE_REFUSALS` and
the runtime barrel do not move; the words ride 0.22.0.

### Six — the restamp class, stated with its sites (decision 198; C1)

Every rewind that re-applies migrations past 25 undoes 26 first, children first:
`dropTaskGraph` inside `dropRoadmapSteps` (`ledger/test/ledger`), `rewindTo23`
(`ledger/test/migrations`), the two integrity rewinds (`cli/test/cli`,
`gateway/test/build-server`), the two rewinds of the new e2e suites, and the S8 rewind of
`gateway/test/roadmap-write`, which the brief's list omitted. Pins recomputed, never
lifted: `MIGRATIONS` 25 → 26 (ten length pins and two version lists), `tr_` 15 → 16
(seven), `PROJECTION_SOURCES` 28 → 31 (three length pins and the pair list), watermark rows 28 → 31 and projections 27 → 30 in the ledger suite,
`INITIATIVE_PROJECTION_NAMES` 4 → 7, `DERIVED_TABLES` 31 → 34, `EXPECTED_SCHEMA_OBJECTS`
124 → 129, the last applied migration `ROADMAP_STEPS_MIGRATION` → `TASK_GRAPH_MIGRATION`
(twelve sites), `API_CONTRACT_VERSION` at its eleven literal sites, `API_WRITE_ROUTES` at
eleven (five in the protocol's route suite, three in its schema suite, three in the
gateway's build-server suite), `CONTRACTS_SCHEMA_EXPORTS` 178 → 183, `RUNTIME_PUBLIC_EXPORTS` 303 → 307. P-P18-2 for
the initiative stream across 25 → 26 lives in `gateway/test/task-graph`: a 2.10.0 history
rewound to 25 migrates under 2.10.0 at 26, verifies and rebuilds identically, and takes
G1 on top. P-16/B later renumbers to 27+, and P-16/A1, when it lands, takes the next free
ADR, API minor and contract version at its open.

## Evidence

- `contracts/test/schemas`: the two schemas field by field, the bounds, the largest node
  under the payload budget, both types as passthroughs.
- `ledger/test/task-graph`: the decision over values, each word by its one input, the
  cycle's naming, the bounds, and `GRAPH_TASK_OUT_OF_SCOPE`'s five shapes (another step,
  another version, another initiative, no link, no intake) with existence judged first.
- `ledger/test/projection`: the fold, the supersession, every refusal by the door's word.
- `ledger/test/ledger`: the single door refuses both types; G1 at the door with the three
  tables, the watermarks and an identical double rebuild; G4's supersede and stale head;
  every door word with nothing appended; the shape; whole-batch replay; the producer's
  replay; a planted short revision and an orphan node refused at rebuild and reported by
  `verifyIntegrity()`; `GRAPH_TASK_OUT_OF_SCOPE` at the door and through the producer for
  a task entered on another step, version or initiative, with no link, or with no
  intake, nothing appended, and a task of step B refused on A once it is in B's graph.
- `ledger/test/migrations`: migration 26's text, rosters, a fresh and an upgraded
  ledger, one NULL per predicate, the policy's NULL refused by the CHECK itself, and the
  trigger bitten on NULL → NULL, another column while NULL, a second supersede and a
  clearing.
- `runtime/test/ready`: the 21 cells, 18 producers, the rules, production's shape, purity.
- `runtime/test/intake` and `gateway/test/task-intake`: both words, the null/0 pair, the
  null cohort through a real rewind of the stream, and an exact replay unaffected.
- `gateway/test/task-graph`: G1–G7 through the real gateway and intake door, the surface,
  `readinessOf` with and without an instant and with a moved assignment, and P-P18-2;
  the rank-0 read on a task entered on A; the verifier's two probes as refusals — a task
  entered on B declared on A (V1) and initiative 1's tasks declared on initiative 2's
  step (V2), each `409 WRITE_REFUSED` naming `GRAPH_TASK_OUT_OF_SCOPE` at the node with
  nothing appended — and version 1's task refused on version 2's step of the same id.

## Why the alternatives were not chosen

- **Two route keys** would have split one path's read and write the way no write of this
  plane is split, and demanded a third surface arm.
- **A derived graph revision id** (a v5 over initiative, step and predecessor) is an
  identity, and the bump would have followed (ND-P27-5).
- **A new UNKNOWN word for R4** (C3 option (b)) would have named an absence the readers
  already fill: the intake records its resolution, and today's GLOBAL reading exists.
- **Admitting the null cohort** on the intake would have been a third answer at a write
  door.
- **Recording the membership limit instead of refusing** (option (b) of V1-1) would have
  let the first production graph hold a node of another step or initiative as immutable
  history, and a later tightening would need a fold that refuses what it recorded.
- **`GRAPH_TASK_UNKNOWN` for scope** would name a present task absent; scope is its own
  fact, and gets its own word.

## Consequences

- A3's refusal of a cycle or a missing reference, naming the nodes, holds at the door for
  a step's task graph, and so does its unambiguous step: a node whose task is not of the
  graph's step is refused by name. A5's predicate exists, total and tested; its measured parts
  (fan-in, concurrency) stay with P-19 and P-21, and so does dispatch.
- Every node of this build reads not READY in production, by name. The first node to read
  READY needs the V2 cohort (P-21) and an approval rule that says none is required; on a
  step with `dependsOn` it also needs a producer of step transitions, because a node on a
  `DECLARED` step with no `dependsOn` already reads R3 `SATISFIED`.
- A task is a node of the graphs of the one step it entered on. A roadmap revision does
  not carry a task to the new version's step of the same id; a re-link producer does
  (owner: a later cut of **P-27**).
- The initiative stream's vocabulary is six names; the timeline and every consumer derive
  it.

## Residuals, with their owners

- `foldTaskGraph` counts a revision's folded nodes by scanning every node of the fold,
  and the rebuild's `currentRevision` scans every revision per header, so the rebuild and
  `verifyIntegrity()` cost grows with the square of the node events; the live door folds
  one batch through a fresh fold and is unaffected. A per-revision counter on the pending
  entry makes it linear, with no behaviour change; the `>=` branch beside it is
  unreachable, because the entry is deleted when the last node folds. Owner: a later cut
  of **P-27**.
- The gateway's vitest project resolves `@acp/runtime` from its build output, not its
  source, so a gateway file run alone after a runtime edit reads the previous build until
  `tsc --build` runs; `pnpm check` typechecks before it tests, so the gate is sound.

## Not in this record

- **G-UI.** The console's `graph-view` (P8-8E) and `timeline-view` render from the
  initiative timeline; a graph event renders as a passthrough of the initiative's status.
  Both suites run, unedited, and a view of the graph and its verdicts is not built.
- Step transitions, the V2 cohort, per-revision terminals, approvals and STEP routing:
  their owner rows carry them.
- Dispatch of any kind.
- A membership check in `verifyIntegrity()`. It does not report a node whose task's
  link no longer matches its graph's step. Scope is decided at the door against the
  task stream and is not copied into the fold. Because revision records are written
  once, this build's doors cannot produce such a mismatch; a history written by another
  producer would need its own check.
- A head-only rule for graphs. A graph can be declared on a roadmap version that is no
  longer the head: after version 2 exists, a graph on version 1's `B` for tasks that
  entered on version 1's `B` is granted. Nothing here claims graphs are head-only. Under
  exact-pair matching, version 1's `B` is the only step those tasks can belong to until
  the re-link producer exists (a later cut of **P-27**).
