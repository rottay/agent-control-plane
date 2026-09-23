# ADR 0080 — The producer speaks the V2 coordinate, and the protocol half is delivered

- Status: accepted (P-18/protocolo, escalón G, recorded 2026-09-12).
- Supersedes: none.
- Superseded-by: none.
- Amends: the escalón G brief's H-5 on **position only** (Q-G1, adjudicated
  option (c)): the attempt's opening is the task's first event, not the event
  after `TASK_DISCOVERED`. It also settles, by name, the "escalón G owes the
  producer" sentences of ADRs 0073, 0074, 0076, 0077 and 0079. Their files are
  not touched.

## Errata, 2026-09-23

**4** and **5** below are **AMENDED** by P-15 escalón D1, recorded in ADR 0105
(decision 132), for the one task this record did not have: a task that entered
through the intake (P-14/C, ADR 0087).

- **4.** The opening is the task's first event **unless the task entered through the
  intake**. There the intake's `TASK_DISCOVERED` is first and already left the task
  `DISCOVERED`, so the opening is the same event — same transition, key, id and
  payload — out of `DISCOVERED` instead of out of no state, and the discovery follows
  it as before: intake → opening → discovery, one attempt.
- **5.** The ledger does not assign `1 + MAX(attempt)` to an opening whose coordinate
  already holds events: it reuses their flat attempt (the intake's), and refuses the
  opening when they hold two. The producer proposes by the same rule. Continuity reads
  an intake-first task's first event as the intake and holds every fact it shares with
  the invocation to it, then rebuilds the opening.

Nothing else in this record changes. The "fails closed" line on `restateInvocation`
was already superseded by ADR 0102 for opening-first tasks, and ADR 0105 extends the
recovery to intake-first ones.

## Context

Escalones A–F and CORR-2 delivered the protocol at the ledger and store level:
the V2 key composes in `@acp/contracts` (0072), an attempt opens with its own
identity and the ledger assigns its flat number (0073), the outbox is a
versioned store (0074), coordination stores name their incarnation (0075), an
effect is looked up by its logical key (0076), a prompt occurrence is a use
(0077), a command intention commits with its quarantine (0078), and a known
outcome is reused (0079).

None of it had a producer. At `a6ed7c3` no `src` file in runtime, daemon or
durability imported `buildV2IdempotencyKey`; `DurableInvocation` carried only a
flat `attempt`; `buildEvent` wrote no coordinate into any payload; nothing
emitted `TASK_ATTEMPT_OPENED`; and the producer guard `assertCausalPredecessor`
composed the V1 key by hand, so a V2 walk would have refused its own second step.
The contract decides the key's form **by the payload** (streams §1.1, the door
of 0072), so moving the key without the payload — or the payload without the
key — makes every event of the walk inadmissible.

The brief's preaudit (H-1) widened the write-set to the three files where the
producer actually lives: `core/events`, `core/step-executor` and `submission`.

Its H-5 then placed the opening immediately after the discovery. The writer
stopped before the first edit (Q-G1) because the ledger's own arithmetic makes
that position unrealisable: a new coordinate is assigned `1 + MAX(attempt)` over
**every** event of the task, and every later V2 event of the coordinate must
repeat it (execution §3 `:122-123`). A discovery appended first already holds
flat attempt `A`, so the opening becomes `A + 1` — while a walk has one
invocation, one flat attempt stamped on every event, one `invocationId` derived
from it, and a continuity check comparing it with `latestAttempt`. No value
serves both. A probe on HEAD's sources confirmed both halves: the H-5 order is
refused at the opening and again at the first V2 beat; the opening-first order
is admitted, the initiative folds from the later discovery, and
`verifyIntegrity()` is green.

## Decision

**1. The revision rides the invocation, optionally.** `DurableInvocation` gains
`revision?: InvocationRevision` — `revisionId`, `revisionNumber`,
`attemptNumber`, `envelopeSha256`, all `SUBMISSION`-origin.
`deriveInvocation` takes it as an optional fifth argument, projects it field by
field and freezes it, and does **not** put it in the preimage of
`invocationId`: the flat attempt is monotone per task, so the id is already one
per coordinate, and a second formula would give an existing run a second
identity. Absent, the returned object has no `revision` member at all.

- `restoredFromRevisionId` is not carried. A restored revision is recovery's to
  produce, and a member no producer fills is stocking.
- Optional rather than required, because a required member breaks the typecheck
  of every construction outside this domain — the daemon's two, durability's,
  the CLI's and the gateway's — and binding a revision in them is adoption,
  which "no partial cutover" blocks.

**2. The key follows the invocation, through the imported composer.**
`deriveEventCoordinate` keys a revision-bearing invocation by
`buildV2IdempotencyKey({stream: "control_plane_events", …})` imported from
`@acp/contracts`, and a revision-free one by `buildIdempotencyKey` exactly as
before (N-P18-20: the producer never restates the namespace or the join).
`eventName` and `operationName` stay over the flat attempt; no event id, no
operation id and no invocation id is a new formula.

**3. Every payload carries the coordinate.** `buildEvent` adds
`revisionNumber` and `attemptNumber` to the base payload of every event of a
revision-bearing walk. The base of a revision-free walk is untouched, and the
suite pins it: two sha-256 vectors over both plans' events, computed by running
`a6ed7c3`'s own `buildEvent` (lifted, not re-derived), equal the tree's.

**4. The opening is the task's first event** (Q-G1, option (c)).
`ATTEMPT_OPENING_STEP` is a beat **outside the plan** — `transitionId:
"attempt.opened"`, `fromState: null`, `toState: "DISCOVERED"`,
`TASK_ATTEMPT_OPENED`, `PLAIN` — because inserting a step into the plan would
change the `planIndex` of every V1 event after it and make continuity refuse
every ledger written before G. Its `index` is `-1`: it has no position, performs
no effect and enters no payload.

- **Payload, field by field:** `revisionId`, `revisionNumber`, `attemptNumber`,
  `envelopeSha256`, `invocationId`, `legacyAttemptNumber` (= the invocation's
  flat attempt). No `submissionDigest`, route or initiative.
- **Instants:** `occurredAt` and `recordedAt` are `invocation.submittedAt`
  (DERIVED law). **Causation:** `null`; nothing causes an attempt's opening.
- **The discovery follows as a same-state V2 event**, `DISCOVERED → DISCOVERED`,
  caused by the opening. The builder alone decides that `fromState`; the plan's
  frozen step 0 is not copied or edited, and `nextStep` returns it by identity.
- H-5's form stands: out of plan, own `transitionId`, submission instants. Its
  position is amended, because the ledger's arithmetic governs.

**5. The step executor navigates to both and guards both.**

- `nextStep`, for a revision-bearing invocation only: no task → the opening;
  `DISCOVERED` with no discovery under its V2 key → the plan's step 0. The real
  loop of `SqliteSupervisor.runToCheckpoint` walks both without a driver edit.
  Its bound allows `plan.length + 2` iterations; a V2 walk spends
  `plan.length + 1` appends and one terminal check, so it fits **exactly**, where
  a V1 walk kept one iteration spare. Both plans are drilled to `CHECKPOINTED`.
- **Producer proposes, ledger verifies** (ADR 0073). Before appending an opening
  not yet recorded under its key, `appendPlanStep` computes
  `1 + getTask().latestAttempt` (or 1 with no task) from the `LedgerPort` and
  refuses with `SupervisorError`, zero delta, when it differs from
  `invocation.attempt`. A recorded opening is a replay, and the arithmetic it has
  since moved is not asked again. The ledger's refusal stays the authority and is
  drilled separately behind a port that hides the task.
- **Nothing of a coordinate before its opening** (N-G-3). Every other step of a
  revision-bearing walk requires the opening to be in the ledger under its V2 key
  and to carry this invocation's event id. This narrows B's tolerant door
  (O-2 of B's postaudit) **in the producer**; the ledger is not touched.
- **Causation resolves by the derivation that keyed it.**
  `causalPredecessorOf` is the one answer for the builder and the guard: `null`
  for the opening, the opening for step 0 under a revision, `null` for step 0
  without one, the plan's previous step otherwise. The guard looks the
  predecessor up by `deriveEventCoordinate`, so a V2 walk finds it under the V2
  key (N-G-8).
- **Continuity rebuilds the task's first event** — the opening under a
  revision — and, once present, the discovery. The opening binds the revision
  and the invocation; the discovery binds the submission digest and the
  initiative, one event later than a V1 walk binds them. The window between the
  two holds no work, and two processes racing it conflict on the discovery's key.

**6. No `CONTRACT_VERSION` bump.** ADR 0076's criterion puts a bump on the
escalón whose payloads carry **digests the fold verifies** and a **per-payload
contract version** of their own (C: `requestContractVersion` → 2.3.0; F:
`outboxContractVersion` → 2.4.0). G adds neither: no event type (vocabulary 33,
`execution` 15), no preimage, no prefix, no identity formula, no payload
grammar — the opening's payload is B's, and the coordinate keys are the ones the
contract's door already reads. G connects what exists. `CONTRACT_VERSION` stays
`"2.4.0"`, `CONTRACTS_SCHEMA_EXPORTS` and `API_CONTRACT_VERSION` do not move,
and there is no migration (`MIGRATIONS` 14).

**7. The debts written to G are settled by name — paid or reassigned, never
silently dropped** (DT decision H-2, option (a)).

| Record | What it said G owes | Settlement |
| --- | --- | --- |
| 0073 `:198` | the producer of the attempt's opening | **Paid** here: the walk emits `TASK_ATTEMPT_OPENED` V2 first. |
| 0074 `:244` | the outbox producer | **Paid in F** by `buildQuarantineBatch` (0078, pure). Wiring it into the daemon's quarantine is **adoption**, the legacy window `L-P18F-1` names. |
| 0076 `:274` | the producers of `EFFECT_INTENDED`, `DISPATCH_INTENDED`, `DISPATCH_OUTCOME_RECORDED` | **Reassigned** to the adoption packet and P-18/recuperación: they need the real execution port (`createExecutionEffects`) and a provider. |
| 0077 `:144` | the producers of `PROMPT_OCCURRENCE_RECORDED` and `RESPONSE_OCCURRENCE_RECORDED` | **Reassigned**, for the same reason. |
| 0079 Consequences | a producer that intends a second delivery and is refused | **Reassigned** with 0076's; the refusal is drilled on the walk's coordinate (below). |

**8. The minimal negative end to end, redefined** (N-G-10). The real walk opens
the V2 attempt and walks its beats into `RUNNING` through `appendPlanStep`. On
**that** coordinate — its task, revision, attempt, flat assignment, invocation,
key derivation and state — the effect intention, the delivery, the lost
acknowledgement, the handoff to a new segment and the replay are appended
through the ledger's **real door**, as C's drills are, because no producer of
them ships here. The suite asserts: the logical lookup returns the original
`effect_id` with `reconciliationRequired`; the exact intention replays; an
honest retry on the handed-off segment is refused **without** `CONFLICT`,
naming the effect and reconciliation; no second delivery is admitted; and on a
known outcome, `DISPATCH_INTENDED` is refused at `payload.dispatch.effectId`
with "a known outcome is reused, never redelivered" (decision 55). That refusal
**is** the reuse instruction: no other reuse artifact exists.

**9. The registry is marked once** (Q7). The `P-18/protocolo` row of the packet
register's §1.8 gains a delivered marker in its second column, its existing text
word for word, and in its third column the limits below. The `P-18` inventory row
stays `DESIGN_READY`: P-18 as a whole closes with recovery. P-09/log and P-05 are
not marked retroactively. "Cache outbox reconstruible" is read as F's fold
(decision 54), not as an operative rebuild.

## Consequences

`P-18/protocolo` is delivered at the level it is defined: ledger, stores and the
runtime domain's producer. A revision-bearing invocation walks from opening to
`CHECKPOINTED` under the V2 door through the real supervisor loop, and every
guard above is drilled against a real ledger, with mutation probes confirming
that removing any one of them turns a named test red.

What fails closed rather than speaking V2, drilled or declared:

- **The exceptional producers** — settlement, cancellation, usage, tool
  receipts, pressure, switches — build their payloads without the coordinate
  while `deriveEventCoordinate` keys them V2, so the contract refuses the event
  before any append (drilled for the settlement). In `runToCheckpoint`'s catch
  that refusal replaces the original error for a V2 walk; it is still a refusal
  with zero delta, and no V2 walk exists outside this suite.
- **`restateInvocation`** (`lifecycle-operation`) reads the task's first event
  as a discovery and refuses a V2 task with `DISCOVERY_UNREADABLE` (drilled).
- **The daemon, durability, the CLI and the gateway** keep deriving V1
  invocations (`composition:512/:935`) until the adoption binds a revision.
- **The ledger door still admits an eighth opening key.** The builder is the
  guard and the suite pins the exact key set; the contract's own comment already
  assigns that law to the producer. Narrowing the door is ledger work, not G's.

## Not in this record

**Recovery.** Boundaries 4-8, effective fencing, effective quarantine, the
reconciler and the dispatcher (B7/B8/B9/B10) remain P-18/recuperación's, blocked
on P-15, P-36/local and P-17. No boundary is certified and no operative commit is
enabled.

**Adoption.** Binding a revision in the daemon's composition, rewriting the
exceptional producers and `restateInvocation` for V2, and the producers of
effects, deliveries and occurrences.

**O-Δ1 and O-Δ2.** Registered debt, untouched.
