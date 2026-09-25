import type { TaskGraphDeclarationRequest } from "@acp/protocol";
import {
  LedgerError,
  LedgerInitiativeBatchConflictError,
  LedgerTaskGraphRefusedError,
  declareTaskGraph,
  openLedger,
} from "@acp/ledger";
import type { Ledger, RoadmapVersionReadModel, TaskGraphRefusal, TaskGraphRevisionReadModel } from "@acp/ledger";
import { readinessOf } from "@acp/runtime";

/**
 * A step's task graph: the write seam and the read (P-27 cut A, ADR 0115).
 *
 * Both halves in one module, by the write-set: the declaration opens a short-lived
 * writable handle, hands the request to the ledger's one producer, `declareTaskGraph`,
 * and maps what comes back; the read resolves the step and asks the runtime's
 * `readinessOf` for the current revision's verdicts. This module **decides nothing**:
 * the graph law is `decideTaskGraph`'s, run by the producer as the fast path and by
 * the batch door as the law, and READY is `evaluateReady`'s. Nothing here dispatches.
 *
 * **The instant and the identifiers are injected** by the route, the roadmap seam's
 * rule, so the same request with the same coordinates builds the same events.
 */

/** A version and a step of it, resolved inside one initiative's history. */
export type StepResolution =
  | { readonly ok: true; readonly version: RoadmapVersionReadModel }
  | { readonly ok: false; readonly reason: "UNKNOWN_VERSION" };

/** Resolve a version number inside the initiative, as the steps read does. */
export function resolveStepVersion(ledger: Ledger, initiativeId: string, version: number): StepResolution {
  const recorded = ledger.listRoadmapVersions(initiativeId).find((entry) => entry.version === version);
  if (recorded === undefined) return Object.freeze({ ok: false as const, reason: "UNKNOWN_VERSION" as const });
  return Object.freeze({ ok: true as const, version: recorded });
}

export interface TaskGraphWriteInput {
  /** The read-only handle, used to read the history. Never appended through. */
  readonly ledger: Ledger;
  readonly initiativeId: string;
  readonly version: RoadmapVersionReadModel;
  readonly stepId: string;
  readonly request: TaskGraphDeclarationRequest;
  /** Injected: the recording instant. This module reads no clock. */
  readonly recordedAt: string;
  /** Injected: the header's event id, and one per node in node order. */
  readonly headerEventId: string;
  readonly nodeEventIds: readonly string[];
}

export type TaskGraphWriteOutcome =
  | {
      readonly ok: true;
      readonly revision: TaskGraphRevisionReadModel;
      readonly nodeCount: number;
      readonly sequence: number;
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: TaskGraphRefusal | "WRITE_CONFLICT";
      /** A field path, or the nodes on a cycle. Never content. */
      readonly at: string;
    };

/**
 * The ledger codes that mean another writer got there first, matched by name: the
 * roadmap seam's two (P8-8G R1).
 */
const RACE_LOST_CODES: readonly string[] = Object.freeze(["LEDGER_IDEMPOTENCY_CONFLICT", "LEDGER_EVENT_ID_CONFLICT"]);

/**
 * Declare one revision of a step's task graph.
 *
 * The producer's refusal is the caller's to read, by its word. A refusal from the
 * door after the producer granted, a batch that met a stream holding part of it, or
 * a lost key race all mean the history moved between the read and the append: one
 * answer, `WRITE_CONFLICT`, and no new word reaches a caller. Anything else is
 * re-thrown untouched and classifies as `INTERNAL`.
 */
export function recordTaskGraph(input: TaskGraphWriteInput): TaskGraphWriteOutcome {
  const writable = openLedger(input.ledger.path);
  try {
    let outcome;
    try {
      outcome = declareTaskGraph({
        reader: input.ledger,
        writable,
        initiativeId: input.initiativeId,
        roadmapVersionId: input.version.roadmapVersionId,
        stepId: input.stepId,
        request: {
          graphRevisionId: input.request.graphRevisionId,
          supersedesGraphRevisionId: input.request.supersedesGraphRevisionId,
          declaredBy: input.request.declaredBy,
          nodes: input.request.nodes.map((node) => ({
            taskId: node.taskId,
            taskRevisionNumber: node.taskRevisionNumber,
            dependsOn: node.dependsOn.map((edge) => ({
              taskId: edge.taskId,
              taskRevisionNumber: edge.taskRevisionNumber,
              failPolicy: edge.failPolicy,
            })),
          })),
        },
        recordedAt: input.recordedAt,
        headerEventId: input.headerEventId,
        nodeEventIds: input.nodeEventIds,
      });
    } catch (error: unknown) {
      if (
        (error instanceof LedgerError && RACE_LOST_CODES.includes(error.code)) ||
        error instanceof LedgerTaskGraphRefusedError ||
        error instanceof LedgerInitiativeBatchConflictError
      ) {
        return Object.freeze({ ok: false as const, reason: "WRITE_CONFLICT" as const, at: "taskGraph" });
      }
      throw error;
    }
    if (!outcome.ok) return Object.freeze({ ok: false as const, reason: outcome.reason, at: outcome.at });
    return Object.freeze({
      ok: true as const,
      revision: outcome.revision,
      nodeCount: outcome.nodeCount,
      sequence: outcome.sequence,
      replayed: outcome.replayed,
    });
  } finally {
    writable.close();
  }
}

/** What the read answers: the step's current revision and its verdicts, or why not. */
export type StepGraphOutcome =
  | {
      readonly ok: true;
      readonly version: RoadmapVersionReadModel;
      readonly reading: NonNullable<ReturnType<typeof readinessOf>>;
    }
  | { readonly ok: false; readonly reason: "UNKNOWN_VERSION" | "UNKNOWN_STEP" | "NO_GRAPH" };

/**
 * One step's current task graph revision, with each node's READY verdict computed now
 * against the injected instant, and never stored.
 */
export function stepGraph(
  ledger: Ledger,
  initiativeId: string,
  versionNumber: number,
  stepId: string,
  now: string | null,
): StepGraphOutcome {
  const resolved = resolveStepVersion(ledger, initiativeId, versionNumber);
  if (!resolved.ok) return resolved;
  const version = resolved.version;
  if (!ledger.listRoadmapSteps(version.roadmapVersionId).some((step) => step.stepId === stepId)) {
    return Object.freeze({ ok: false as const, reason: "UNKNOWN_STEP" as const });
  }
  const current = ledger
    .listTaskGraphRevisions(version.roadmapVersionId, stepId)
    .find((revision) => revision.supersededBy === null);
  const reading = current === undefined ? null : readinessOf(ledger, current.graphRevisionId, now);
  if (reading === null) return Object.freeze({ ok: false as const, reason: "NO_GRAPH" as const });
  return Object.freeze({ ok: true as const, version, reading });
}
