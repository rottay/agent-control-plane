/**
 * The value types of the semantic diff between two roadmap versions (P-26 cut C,
 * ADR 0113).
 *
 * The input the diff reads, the diff it answers and the refusal it can give: the
 * declarations this concept owns, in the concept's own leaf (owner law
 * `docs/audit/architecture/index.md` §7; the roadmap steps' leaf is the precedent).
 * A pure type leaf: it declares data and imports only types, and `../index.ts`
 * re-exports every one.
 */

import type { RoadmapVersionKind } from "@acp/contracts";
import type {
  RoadmapStepDependencyReadModel,
  RoadmapStepReadModel,
  RoadmapVersionReadModel,
} from "../../types/index.js";

/** One side of a diff: a recorded version and the rows the read model holds for it. */
export interface RoadmapDiffSide {
  readonly version: RoadmapVersionReadModel;
  /** `listRoadmapSteps(version.roadmapVersionId)`, as read. */
  readonly steps: readonly RoadmapStepReadModel[];
  /** `listRoadmapStepDependencies(version.roadmapVersionId)`, as read. */
  readonly dependencies: readonly RoadmapStepDependencyReadModel[];
}

export interface RoadmapDiffInput {
  readonly from: RoadmapDiffSide;
  readonly to: RoadmapDiffSide;
  /**
   * The version `to` restores, resolved by the caller inside the same initiative's
   * history: the row whose id is `to.version.restoresVersionId`, or null when `to`
   * is an `EDIT`.
   */
  readonly restored: RoadmapVersionReadModel | null;
}

/**
 * The fields of a step the diff compares, by name. `state` and
 * `routingAssignmentVersion` are not among them: nothing in this build writes a
 * state other than `DECLARED`, and the STEP scope has no producer (`roles`).
 */
export type RoadmapDiffField =
  | "stepIndex"
  | "title"
  | "objectiveSha256"
  | "acceptanceSha256"
  | "expectedWriteSetSha256"
  | "dependencyRank";

/** A version as the diff echoes it: enough to tell a pre-cohort side from an empty one. */
export interface RoadmapDiffVersion {
  readonly version: number;
  readonly roadmapVersionId: string;
  readonly kind: RoadmapVersionKind;
  /** Null: recorded before steps existed, declared nothing. 0: declared none. */
  readonly stepCount: number | null;
}

/** One dependency edge, `stepId` depends on `dependsOnStepId`. */
export interface RoadmapDiffDependency {
  readonly stepId: string;
  readonly dependsOnStepId: string;
}

export interface RoadmapDiffChange {
  readonly stepId: string;
  /** The names of the fields that differ, in `RoadmapDiffField`'s declared order. */
  readonly fields: readonly RoadmapDiffField[];
}

/** What a diff answers for `roles` in this build: the STEP scope has no producer. */
export type RoadmapDiffRoles = "STEP_ASSIGNMENTS_UNPRODUCED";

export interface RoadmapDiff {
  readonly from: RoadmapDiffVersion;
  readonly to: RoadmapDiffVersion;
  /** StepIds in `to` and not in `from`, sorted. */
  readonly added: readonly string[];
  /** StepIds in `from` and not in `to`, sorted. */
  readonly removed: readonly string[];
  /** Steps in both whose compared fields differ, sorted by stepId. */
  readonly changed: readonly RoadmapDiffChange[];
  readonly dependencies: {
    /** Pairs in `to` and not in `from`, sorted by stepId then dependsOnStepId. */
    readonly added: readonly RoadmapDiffDependency[];
    readonly removed: readonly RoadmapDiffDependency[];
  };
  /** Whether the two versions name different document bytes. */
  readonly contentChanged: boolean;
  /** The version `to` restores, when `to` is a rollback and differs from `from`. */
  readonly restores: { readonly version: number; readonly roadmapVersionId: string } | null;
  readonly roles: RoadmapDiffRoles;
}

/**
 * Why a diff was refused: rows the caller's own resolution cannot produce, so an
 * integrity failure rather than a caller's mistake.
 *
 * - `VERSIONS_OF_TWO_INITIATIVES`: `from`, `to` or `restored` belong to different
 *   initiatives.
 * - `ROWS_OF_ANOTHER_VERSION`: a step or dependency row names another version than
 *   its side, or `restored` is not the version `to` names (or is given for an edit).
 * - `STEP_ASSIGNMENT_PRESENT`: a step row carries a routing assignment, which no
 *   producer in this build can have written.
 */
export type RoadmapDiffRefusal =
  | "VERSIONS_OF_TWO_INITIATIVES"
  | "ROWS_OF_ANOTHER_VERSION"
  | "STEP_ASSIGNMENT_PRESENT";

export type RoadmapDiffOutcome =
  | { readonly ok: true; readonly diff: RoadmapDiff }
  | {
      readonly ok: false;
      readonly reason: RoadmapDiffRefusal;
      /** A field path or a stepId. An identifier, never content. */
      readonly at: string;
    };
