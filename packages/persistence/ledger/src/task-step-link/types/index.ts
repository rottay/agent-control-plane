/**
 * The value types of a task's step link (P-27 cut C, ADR 0116).
 *
 * The decision's request and outcome, and the producer's input and outcome: the
 * declarations this concept owns, in the concept's own leaf (owner law
 * `docs/audit/architecture/index.md` §7; the task graph's leaf is the precedent). A
 * pure type leaf: it declares data and imports only types, and `../index.ts`
 * re-exports every one.
 */

import type { TaskStepLinkDeclaration } from "@acp/contracts";
import type { Ledger } from "../../ledger/index.js";
import type { TaskGraphTaskLink } from "../../task-graph/index.js";
import type { TaskStepLinkReadModel } from "../../types/index.js";
import type { TaskStepLinkRefusal } from "../index.js";

/**
 * What the decision is handed: the payload, untrusted, the linking initiative, and the
 * questions about the history that only the caller can answer. Pure over what it is
 * given: the door answers them from the read model inside its transaction, the
 * producer from its reader, and a suite from values.
 */
export interface TaskStepLinkDecisionRequest {
  /** The initiative whose stream the link is appended to. */
  readonly initiativeId: string;
  /** The `TASK_STEP_LINKED` payload. Parsed here through the contract. */
  readonly link: unknown;
  /** Is `(roadmapVersionId, stepId)` a step declared under the linking initiative? */
  readonly stepDeclared: (roadmapVersionId: string, stepId: string) => boolean;
  /** The version's number, when it is a version of the linking initiative; else null. */
  readonly versionNumber: (roadmapVersionId: string) => number | null;
  /** Does the task stream record this task's revision 1? Cross-stream, never a foreign key. */
  readonly taskKnown: (taskId: string) => boolean;
  /**
   * The step the task entered on, from its recorded intake, or null when it has none
   * (a task that entered any other way). Cross-stream, never a foreign key.
   */
  readonly taskIntake: (taskId: string) => TaskGraphTaskLink | null;
  /** The task's recorded links, in any order: the read orders them by `sequence`. */
  readonly taskLinks: (taskId: string) => readonly TaskStepLinkReadModel[];
}

export interface TaskStepLinkGranted {
  readonly ok: true;
  readonly link: TaskStepLinkDeclaration;
}

export interface TaskStepLinkRefused {
  readonly ok: false;
  readonly reason: TaskStepLinkRefusal;
  /** The field that failed. Never content. */
  readonly at: string;
}

export type TaskStepLinkOutcome = TaskStepLinkGranted | TaskStepLinkRefused;

export interface TaskStepLinkInput {
  /** The handle the history is read from. Never appended through. */
  readonly reader: Ledger;
  /** A writable handle of the same ledger: the link is appended through it. */
  readonly writable: Ledger;
  readonly initiativeId: string;
  readonly taskId: string;
  /** The target step: the pair the task is of from this link on. */
  readonly roadmapVersionId: string;
  readonly stepId: string;
  /** The step the caller says the task is of now: both null for an adoption. */
  readonly fromRoadmapVersionId: string | null;
  readonly fromStepId: string | null;
  readonly linkedBy: string;
  /** Injected: the recording instant, ISO-8601 in UTC with milliseconds. */
  readonly recordedAt: string;
  /** Injected: the event's id. */
  readonly eventId: string;
}

export type TaskStepLinkInputOutcome =
  | {
      readonly ok: true;
      /** The link as the read model holds it after the append, or before it on a replay. */
      readonly link: TaskStepLinkReadModel;
      /** The initiative-stream position of the link's event. */
      readonly sequence: number;
      /** True when the link was already recorded with exactly this content. */
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: TaskStepLinkRefusal;
      /** A field path. Never content. */
      readonly at: string;
    };
