/**
 * The value types of the READY predicate (P-27 cut A, ADR 0115; requirement A5).
 *
 * The verdict, the input one node is judged on, and the production reading: the
 * declarations this concept owns, in the concept's own leaf (owner law
 * `docs/audit/architecture/index.md` §7). A pure type leaf: it declares data and
 * imports only types; the two closed reason sets stay in `../index.ts` and are read
 * here type-only.
 */

import type { InitiativeStatus } from "@acp/contracts";
import type { DependencyFailurePolicy, RoadmapStepReadModel, TaskGraphRevisionReadModel } from "@acp/ledger";

import type { READY_UNKNOWN_REASONS, READY_UNSATISFIED_REASONS } from "../index.js";

/** A known block: the condition is false, and the reason says which fact makes it so. */
export type ReadyUnsatisfiedReason = (typeof READY_UNSATISFIED_REASONS)[number];

/** An absence: no producer states the fact the condition needs, so it is not known. */
export type ReadyUnknownReason = (typeof READY_UNKNOWN_REASONS)[number];

/** One condition's answer, tri-state. `UNKNOWN` is never READY. */
export type ReadyVerdict =
  | { readonly verdict: "SATISFIED" }
  | { readonly verdict: "UNSATISFIED"; readonly reason: ReadyUnsatisfiedReason }
  | { readonly verdict: "UNKNOWN"; readonly reason: ReadyUnknownReason };

/**
 * The V2 automaton's states (contracts §2.1), spelled here as a type because no code
 * enum declares them yet: P-21 owns the V2 state machine. Nothing in this build
 * produces one; the predicate is total over them anyway.
 */
export type ReadyTaskStateV2 =
  | "DISCOVERED"
  | "CLASSIFIED"
  | "READY"
  | "RESERVED"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "VERIFYING"
  | "AUDITING"
  | "READY_TO_COMMIT"
  | "COMMITTED"
  | "CHECKPOINTED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "SUSPECT_WORKTREE";

/**
 * A task's state as contracts §2.2's strict union: the cohort is part of the value,
 * and a legacy state is never read as a V2 one.
 */
export type ReadyTaskState =
  | { readonly vocabulary: "LEGACY"; readonly value: string }
  | { readonly vocabulary: "TASK_V2"; readonly value: ReadyTaskStateV2 };

/**
 * What an edge's dependency is known to have reached, for the revision the edge
 * names: a state, with whether any of its effects is `OUTCOME_UNKNOWN`, or nothing
 * produced for that revision at all.
 */
export type ReadyDependency =
  | { readonly produced: false }
  | { readonly produced: true; readonly state: ReadyTaskState; readonly effectOutcomeUnknown: boolean };

export interface ReadyEdge {
  readonly failPolicy: DependencyFailurePolicy;
  readonly dependency: ReadyDependency;
}

/**
 * One approval of the class A6 speaks of (planning §8): its subject a plan, a step or
 * a task, never a commit. `EXPIRED` and `REVOKED` are states an event wrote, never a
 * clock's reading; `expiresAt` is compared against the injected instant.
 */
export interface ReadyApprovalRow {
  readonly subjectKind: "PLAN" | "STEP" | "TASK";
  readonly state: "PENDING" | "GRANTED" | "DENIED" | "EXPIRED" | "CANCELLED" | "REVOKED";
  readonly subjectRevisionSha256: string;
  readonly expiresAt: string | null;
}

/** Whether an approval producer exists, whether one is required, and the row if any. */
export type ReadyApproval =
  | { readonly produced: false }
  | { readonly produced: true; readonly required: false }
  | {
      readonly produced: true;
      readonly required: true;
      /** The digest of the revision the approval must be bound to. */
      readonly subjectRevisionSha256: string;
      readonly approval: ReadyApprovalRow | null;
    };

/** Everything one node is judged on. Values only: no handle, no clock. */
export interface ReadyInput {
  /** R1: the graph revision is the step's current one. */
  readonly graphRevisionCurrent: boolean;
  /** R1: the node's task revision is the task's current one. */
  readonly taskRevisionCurrent: boolean;
  /**
   * R1: the task's current link — its last link row by `sequence`, else its intake's
   * pair, by `currentTaskStepLink` — is this graph's `(roadmapVersionId, stepId)` (P-27
   * cut C, ADR 0116 §Four). False for a task with no current link at all: a block by
   * definition, as an unresolved assignment is.
   */
  readonly taskLinkCurrent: boolean;
  /** R1: the task's state, with its cohort. */
  readonly taskState: ReadyTaskState;
  /** R2: every incoming edge. */
  readonly dependencies: readonly ReadyEdge[];
  /** R3: the step's state, and whether the step depends on other steps. */
  readonly stepState: RoadmapStepReadModel["state"];
  readonly stepHasDependsOn: boolean;
  /** R3: the initiative's status. */
  readonly initiativeStatus: InitiativeStatus;
  /** R4: whether the assignment the task entered under still resolves. */
  readonly assignmentResolved: boolean;
  /** R4: the approval clause. */
  readonly approval: ReadyApproval;
  /** The instant approvals expire against, or null when none was given. */
  readonly now: string | null;
}

/** The four conditions, each with its answer, and READY iff all four are satisfied. */
export interface ReadyEvaluation {
  readonly ready: boolean;
  readonly conditions: {
    readonly R1: ReadyVerdict;
    readonly R2: ReadyVerdict;
    readonly R3: ReadyVerdict;
    readonly R4: ReadyVerdict;
  };
}

/** One node of a revision, with its edges and its verdict, as production reads it. */
export interface ReadinessNode {
  readonly taskId: string;
  readonly taskRevisionNumber: number;
  readonly nodeIndex: number;
  readonly dependsOn: readonly {
    readonly taskId: string;
    readonly taskRevisionNumber: number;
    readonly failPolicy: DependencyFailurePolicy;
  }[];
  readonly evaluation: ReadyEvaluation;
}

/** A revision's readiness, computed at read time and never stored. */
export interface ReadinessReading {
  readonly revision: TaskGraphRevisionReadModel;
  readonly nodes: readonly ReadinessNode[];
}
