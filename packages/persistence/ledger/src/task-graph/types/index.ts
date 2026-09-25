/**
 * The value types of a step's task graph (P-27 cut A, ADR 0115).
 *
 * The decision's request and outcome, and the producer's input and outcome: the
 * declarations this concept owns, in the concept's own leaf (owner law
 * `docs/audit/architecture/index.md` §7; the roadmap steps' leaf is the precedent). A
 * pure type leaf: it declares data and imports only types, and `../index.ts`
 * re-exports every one.
 */

import type { TaskGraphDeclaration, TaskGraphNodeDeclaration } from "@acp/contracts";
import type { Ledger } from "../../ledger/index.js";
import type { DependencyFailurePolicy, TaskGraphRevisionReadModel } from "../../types/index.js";
import type { TaskGraphRefusal } from "../index.js";

/**
 * The step a task entered on, as its recorded intake says (revision 1's
 * `TASK_DISCOVERED` under the intake transition): the initiative, and the roadmap
 * link, both null or both set.
 */
export interface TaskGraphTaskLink {
  readonly initiativeId: string;
  readonly roadmapVersionId: string | null;
  readonly stepId: string | null;
}

/**
 * What the decision is handed: the batch's payloads, untrusted, the declaring
 * initiative, and the questions about the history that only the caller can answer.
 * Pure over what it is given: the door answers them from the read model inside its
 * transaction, the producer from its reader, and a suite from values.
 */
export interface TaskGraphRequest {
  /** The initiative whose stream the batch is appended to. */
  readonly initiativeId: string;
  /** The `TASK_GRAPH_DECLARED` payload. Parsed here through the contract. */
  readonly header: unknown;
  /** The `TASK_GRAPH_NODE_DECLARED` payloads, in batch order. Parsed here. */
  readonly nodes: readonly unknown[];
  /** Is a revision of this id already recorded? */
  readonly graphRevisionKnown: (graphRevisionId: string) => boolean;
  /** Is `(roadmapVersionId, stepId)` a step declared under the declaring initiative? */
  readonly stepDeclared: (roadmapVersionId: string, stepId: string) => boolean;
  /** The step's current revision's id, or null when it has none. */
  readonly currentGraphRevisionId: (roadmapVersionId: string, stepId: string) => string | null;
  /** Does the task stream record this task revision? Cross-stream, never a foreign key. */
  readonly taskRevisionKnown: (taskId: string, taskRevisionNumber: number) => boolean;
  /**
   * The step the task entered on, from its recorded intake, or null when it has
   * none (a task that entered any other way). Cross-stream, never a foreign key.
   */
  readonly taskLink: (taskId: string) => TaskGraphTaskLink | null;
}

export interface TaskGraphGranted {
  readonly ok: true;
  readonly declaration: TaskGraphDeclaration;
  /** The nodes, in `nodeIndex` order. */
  readonly nodes: readonly TaskGraphNodeDeclaration[];
}

export interface TaskGraphRefused {
  readonly ok: false;
  readonly reason: TaskGraphRefusal;
  /** The field that failed, or the nodes on a cycle by task id and revision. Never content. */
  readonly at: string;
}

export type TaskGraphOutcome = TaskGraphGranted | TaskGraphRefused;

/** One edge of a node, as a caller declares it. */
export interface TaskGraphEdgeRequest {
  readonly taskId: string;
  readonly taskRevisionNumber: number;
  /** Required: the door fills in no default. */
  readonly failPolicy: DependencyFailurePolicy;
}

/** One node, as a caller declares it: its position is its index in the request. */
export interface TaskGraphNodeRequest {
  readonly taskId: string;
  readonly taskRevisionNumber: number;
  readonly dependsOn: readonly TaskGraphEdgeRequest[];
}

/** What a caller asks to declare for one step. */
export interface TaskGraphRevisionRequest {
  /** The producer's identity for the revision: checked for existence, never derived. */
  readonly graphRevisionId: string;
  /** The step's current revision, or null for its first. */
  readonly supersedesGraphRevisionId: string | null;
  readonly declaredBy: string;
  readonly nodes: readonly TaskGraphNodeRequest[];
}

export interface TaskGraphDeclarationInput {
  /** The handle the history is read from. Never appended through. */
  readonly reader: Ledger;
  /** A writable handle of the same ledger: the batch is appended through it. */
  readonly writable: Ledger;
  readonly initiativeId: string;
  readonly roadmapVersionId: string;
  readonly stepId: string;
  readonly request: TaskGraphRevisionRequest;
  /** Injected: the recording instant, ISO-8601 in UTC with milliseconds. */
  readonly recordedAt: string;
  /** Injected: the header event's id, and one per node in node order. */
  readonly headerEventId: string;
  readonly nodeEventIds: readonly string[];
}

export type TaskGraphDeclarationOutcome =
  | {
      readonly ok: true;
      /** The revision as the read model holds it after the append, or before it on a replay. */
      readonly revision: TaskGraphRevisionReadModel;
      readonly nodeCount: number;
      /** The initiative-stream position of the header event. */
      readonly sequence: number;
      /** True when the revision was already recorded with exactly this declaration. */
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: TaskGraphRefusal;
      /** A field path, or the nodes on a cycle. Never content. */
      readonly at: string;
    };
