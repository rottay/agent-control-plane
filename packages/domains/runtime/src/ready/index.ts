import { resolveAssignment } from "@acp/accounts";
import { isCanonicalInstant } from "@acp/contracts";
import type { TransportKind, WorkerRole } from "@acp/contracts";
import { LedgerIntegrityError, taskIntakePayloadOf } from "@acp/ledger";
import type { Ledger, TaskReadModel } from "@acp/ledger";

import { assignmentReadingOf } from "../intake/index.js";

import type {
  ReadinessNode,
  ReadinessReading,
  ReadyApproval,
  ReadyDependency,
  ReadyEdge,
  ReadyEvaluation,
  ReadyInput,
  ReadyUnknownReason,
  ReadyUnsatisfiedReason,
  ReadyVerdict,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and
 * are re-exported here unchanged (owner law §7).
 */
export type {
  ReadinessNode,
  ReadinessReading,
  ReadyApproval,
  ReadyApprovalRow,
  ReadyDependency,
  ReadyEdge,
  ReadyEvaluation,
  ReadyInput,
  ReadyTaskState,
  ReadyTaskStateV2,
  ReadyUnknownReason,
  ReadyUnsatisfiedReason,
  ReadyVerdict,
} from "./types/index.js";

/**
 * The READY predicate — P-27 cut A, ADR 0115 (requirement A5; ND-P27-1 adjudication).
 *
 * ## Four conditions, three answers
 *
 * A node is READY iff four conditions are `SATISFIED`: **R1** it is in force (the
 * graph revision is current, the task revision is current, and the task is
 * `CLASSIFIED` in the V2 cohort); **R2** every edge's dependency satisfies the edge's
 * policy; **R3** its step admits work and its initiative is active; **R4** its
 * assignment still resolves and the approval of the A6 class it needs, if any, is in
 * force. Each condition answers `SATISFIED`, `UNSATISFIED(reason)` — a known block —
 * or `UNKNOWN(reason)` — a fact no producer states. `UNKNOWN` is never READY. Within
 * a condition a known block outranks an absence: the first `UNSATISFIED` clause is the
 * answer, else the first `UNKNOWN`, else `SATISFIED`.
 *
 * ## The policies' definition
 *
 * No canon defines the three failure policies (planning §5.3 delegates them to a
 * scheduler contract that does not exist), so the oracle below **is** the definition
 * (adjudication 3, 4): `WAIT_SUCCESS` is satisfied by `COMPLETED` alone,
 * `ALLOW_FAILURE` by `COMPLETED` or `FAILED`, `REQUIRE_TERMINAL` by `COMPLETED`,
 * `FAILED` or `CANCELLED`. `SUSPECT_WORKTREE` satisfies none (a reconciliation lifts
 * it, not an approval), and a dependency not ended is pending. A legacy state
 * satisfies nothing, and an effect in `OUTCOME_UNKNOWN` is not a failure (§2.1).
 *
 * ## Pure, and fed named absences
 *
 * `evaluateReady` reads no clock and no ledger (L-P27-1): `now` is an input, and a
 * null one is `UNKNOWN(INSTANT_UNAVAILABLE)` wherever an expiry must be compared.
 * `readinessOf` is the production adapter: it builds every input from rows that exist
 * and names every fact that has no producer. In this build every task is of the
 * legacy cohort (the DT did not declare V2), so no node reads READY in production —
 * never a false READY, never a false block.
 */

/** A known block's reasons, closed and sorted. */
export const READY_UNSATISFIED_REASONS = [
  "APPROVAL_REQUIRED",
  "APPROVAL_STALE",
  "ASSIGNMENT_UNRESOLVED",
  "DEPENDENCY_BLOCKED",
  "DEPENDENCY_PENDING",
  "DEPENDENCY_QUARANTINED",
  "GRAPH_REVISION_SUPERSEDED",
  "INITIATIVE_NOT_ACTIVE",
  "STEP_NOT_ADMITTING",
  "TASK_NOT_CLASSIFIED",
  "TASK_REVISION_SUPERSEDED",
] as const;

/** An absence's reasons, closed and sorted. Each names a fact whose producer is owed. */
export const READY_UNKNOWN_REASONS = [
  "APPROVAL_UNPRODUCED",
  "DEPENDENCY_COHORT_LEGACY",
  "DEPENDENCY_OUTCOME_UNKNOWN",
  "DEPENDENCY_OUTCOME_UNPRODUCED",
  "INSTANT_UNAVAILABLE",
  "STEP_DEPENDENCIES_UNPRODUCED",
  "TASK_COHORT_LEGACY",
] as const;

const SATISFIED: ReadyVerdict = Object.freeze({ verdict: "SATISFIED" as const });

function unsatisfied(reason: ReadyUnsatisfiedReason): ReadyVerdict {
  return Object.freeze({ verdict: "UNSATISFIED" as const, reason });
}

function unknown(reason: ReadyUnknownReason): ReadyVerdict {
  return Object.freeze({ verdict: "UNKNOWN" as const, reason });
}

/** A condition from its clauses: the first known block, else the first absence. */
function combine(clauses: readonly ReadyVerdict[]): ReadyVerdict {
  return (
    clauses.find((clause) => clause.verdict === "UNSATISFIED") ??
    clauses.find((clause) => clause.verdict === "UNKNOWN") ??
    SATISFIED
  );
}

/** One edge, by the oracle: the definition of the three policies. */
function edgeVerdict(edge: ReadyEdge): ReadyVerdict {
  const dependency: ReadyDependency = edge.dependency;
  if (!dependency.produced) return unknown("DEPENDENCY_OUTCOME_UNPRODUCED");
  if (dependency.state.vocabulary !== "TASK_V2") return unknown("DEPENDENCY_COHORT_LEGACY");
  if (dependency.effectOutcomeUnknown) return unknown("DEPENDENCY_OUTCOME_UNKNOWN");
  switch (dependency.state.value) {
    case "COMPLETED":
      return SATISFIED;
    case "FAILED":
      return edge.failPolicy === "ALLOW_FAILURE" || edge.failPolicy === "REQUIRE_TERMINAL"
        ? SATISFIED
        : unsatisfied("DEPENDENCY_BLOCKED");
    case "CANCELLED":
      return edge.failPolicy === "REQUIRE_TERMINAL" ? SATISFIED : unsatisfied("DEPENDENCY_BLOCKED");
    case "SUSPECT_WORKTREE":
      return unsatisfied("DEPENDENCY_QUARANTINED");
    default:
      return unsatisfied("DEPENDENCY_PENDING");
  }
}

/** R1: the revisions in force and the task's state in its cohort. */
function inForce(input: ReadyInput): ReadyVerdict {
  const state: ReadyVerdict =
    input.taskState.vocabulary !== "TASK_V2"
      ? unknown("TASK_COHORT_LEGACY")
      : input.taskState.value === "CLASSIFIED"
        ? SATISFIED
        : unsatisfied("TASK_NOT_CLASSIFIED");
  return combine([
    input.graphRevisionCurrent ? SATISFIED : unsatisfied("GRAPH_REVISION_SUPERSEDED"),
    input.taskRevisionCurrent ? SATISFIED : unsatisfied("TASK_REVISION_SUPERSEDED"),
    state,
  ]);
}

/** R3: the step admits work, and the initiative is active. */
function inScope(input: ReadyInput): ReadyVerdict {
  const step: ReadyVerdict =
    input.stepState === "READY" || input.stepState === "RUNNING"
      ? SATISFIED
      : input.stepState === "DECLARED"
        ? input.stepHasDependsOn
          ? unknown("STEP_DEPENDENCIES_UNPRODUCED")
          : SATISFIED
        : unsatisfied("STEP_NOT_ADMITTING");
  return combine([step, input.initiativeStatus === "ACTIVE" ? SATISFIED : unsatisfied("INITIATIVE_NOT_ACTIVE")]);
}

/** R4's approval clause, over the A6 class only. */
function approvalVerdict(approval: ReadyApproval, now: string | null): ReadyVerdict {
  if (!approval.produced) return unknown("APPROVAL_UNPRODUCED");
  if (!approval.required) return SATISFIED;
  const row = approval.approval;
  if (row === null) return unsatisfied("APPROVAL_REQUIRED");
  if (row.state === "REVOKED" || row.state === "EXPIRED") return unsatisfied("APPROVAL_STALE");
  if (row.state !== "GRANTED") return unsatisfied("APPROVAL_REQUIRED");
  if (row.subjectRevisionSha256 !== approval.subjectRevisionSha256) return unsatisfied("APPROVAL_STALE");
  if (row.expiresAt === null) return SATISFIED;
  // Both instants are compared as text, which is sound only in the canonical form: a
  // non-canonical expiry cannot be shown in force, and a missing or non-canonical
  // instant cannot show it expired.
  if (!isCanonicalInstant(row.expiresAt)) return unsatisfied("APPROVAL_STALE");
  if (now === null || !isCanonicalInstant(now)) return unknown("INSTANT_UNAVAILABLE");
  return row.expiresAt > now ? SATISFIED : unsatisfied("APPROVAL_STALE");
}

/** R4: the assignment still resolves, and the approval clause holds. */
function authorized(input: ReadyInput): ReadyVerdict {
  return combine([
    input.assignmentResolved ? SATISFIED : unsatisfied("ASSIGNMENT_UNRESOLVED"),
    approvalVerdict(input.approval, input.now),
  ]);
}

/**
 * Judge one node: the four conditions, and READY iff all four are satisfied. Pure and
 * total: every input answers, and nothing outside the input is read.
 */
export function evaluateReady(input: ReadyInput): ReadyEvaluation {
  const R1 = inForce(input);
  const R2 = combine(input.dependencies.map(edgeVerdict));
  const R3 = inScope(input);
  const R4 = authorized(input);
  const ready = [R1, R2, R3, R4].every((condition) => condition.verdict === "SATISFIED");
  return Object.freeze({ ready, conditions: Object.freeze({ R1, R2, R3, R4 }) });
}

/** The most effects of one task the adapter reads to learn whether any is unknown. */
const EFFECTS_READ_MAX = 500;

/**
 * What production knows of a dependency, for the revision an edge names: the task's
 * state, of the legacy cohort, when the edge names the task's current revision; and
 * nothing produced otherwise, because no producer records a revision's own terminal
 * (the attempt's `ended_at` and `outcome` have none, D-S1-4).
 */
function dependencyOf(ledger: Ledger, taskId: string, taskRevisionNumber: number): ReadyDependency {
  const task = ledger.getTask(taskId);
  if (task?.latestRevisionNumber !== taskRevisionNumber) return Object.freeze({ produced: false as const });
  const effects = ledger.listTaskEffects(taskId, { limit: EFFECTS_READ_MAX });
  return Object.freeze({
    produced: true as const,
    state: Object.freeze({ vocabulary: "LEGACY" as const, value: task.currentState }),
    effectOutcomeUnknown: effects.truncated || effects.effects.some((effect) => effect.outcomeStatus === "OUTCOME_UNKNOWN"),
  });
}

/**
 * Whether the assignment a task entered under still resolves (option (a) of the
 * pre-audit's C3): the intake recorded the role, the slot, the transport and the
 * assignment it resolved; the current GLOBAL reading for that role and slot must
 * resolve, through the intake's own resolution, to the same assignment. A task that
 * entered with no recorded intake has no assignment to hold. GLOBAL only: the
 * precedence STEP > INITIATIVE > GLOBAL is P-28's.
 */
function assignmentResolvedFor(ledger: Ledger, task: TaskReadModel | null): boolean {
  if (task === null) return false;
  const opening = ledger.getTaskRevision(task.taskId, 1);
  const record = opening === null ? null : ledger.getEventBySequence(opening.sequence);
  const intake = record === null ? null : taskIntakePayloadOf(record.event);
  if (intake === null) return false;
  const reading = ledger.getGlobalRoutingAssignment({ role: intake.role, slot: intake.resolution.slot });
  const resolved = resolveAssignment(
    {
      role: intake.role as WorkerRole,
      slot: intake.resolution.slot,
      transportKind: intake.resolution.transportKind as TransportKind,
    },
    assignmentReadingOf(reading),
  );
  return resolved.ok && resolved.assignmentId === intake.resolution.assignmentId;
}

/**
 * The readiness of every node of one task graph revision, from the rows that exist,
 * computed at read time and never stored; null when the revision is not recorded.
 *
 * Each input is read or named: the task's state as the legacy cohort (no V2 cohort is
 * declared in this build; P-21), a dependency's terminal for the revision the edge
 * names (P-18, D-S1-4), the step's state and whether it depends on other steps, the
 * initiative's status, the assignment through the intake's resolution, and no
 * approval producer (P-28). `now` is the caller's instant, or null.
 */
export function readinessOf(ledger: Ledger, graphRevisionId: string, now: string | null): ReadinessReading | null {
  const revision = ledger.getTaskGraphRevision(graphRevisionId);
  if (revision === null) return null;
  const version = ledger.getRoadmapVersion(revision.roadmapVersionId);
  const step = ledger.listRoadmapSteps(revision.roadmapVersionId).find((row) => row.stepId === revision.stepId);
  const initiative = version === null ? null : ledger.getInitiative(version.initiativeId);
  if (version === null || step === undefined || initiative === null) {
    throw new LedgerIntegrityError(["a task graph revision names a step or a version the read model does not hold"]);
  }
  const stepHasDependsOn = ledger
    .listRoadmapStepDependencies(revision.roadmapVersionId)
    .some((dependency) => dependency.stepId === revision.stepId);
  const edges = ledger.listTaskDependencies(graphRevisionId);

  const nodes: ReadinessNode[] = ledger.listTaskGraphNodes(graphRevisionId).map((node, nodeIndex) => {
    const task = ledger.getTask(node.taskId);
    const incoming = edges.filter(
      (edge) => edge.taskId === node.taskId && edge.taskRevisionNumber === node.taskRevisionNumber,
    );
    const evaluation = evaluateReady({
      graphRevisionCurrent: revision.supersededBy === null,
      taskRevisionCurrent: task?.latestRevisionNumber === node.taskRevisionNumber,
      taskState: Object.freeze({ vocabulary: "LEGACY" as const, value: task?.currentState ?? "" }),
      dependencies: incoming.map((edge) => ({
        failPolicy: edge.failPolicy,
        dependency: dependencyOf(ledger, edge.dependsOnTaskId, edge.dependsOnTaskRevisionNumber),
      })),
      stepState: step.state,
      stepHasDependsOn,
      initiativeStatus: initiative.currentStatus,
      assignmentResolved: assignmentResolvedFor(ledger, task),
      approval: Object.freeze({ produced: false as const }),
      now,
    });
    return Object.freeze({
      taskId: node.taskId,
      taskRevisionNumber: node.taskRevisionNumber,
      nodeIndex,
      dependsOn: Object.freeze(
        incoming.map((edge) =>
          Object.freeze({
            taskId: edge.dependsOnTaskId,
            taskRevisionNumber: edge.dependsOnTaskRevisionNumber,
            failPolicy: edge.failPolicy,
          }),
        ),
      ),
      evaluation,
    });
  });
  return Object.freeze({ revision, nodes: Object.freeze(nodes) });
}
