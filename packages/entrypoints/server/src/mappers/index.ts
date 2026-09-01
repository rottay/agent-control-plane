import type {
  InitiativeDetail,
  InitiativeSummary,
  InitiativeTaskDto,
  RoadmapVersionDto,
  TaskDetail,
  TaskSummary,
  TimelineItem,
  WorkerDetail,
  WorkerSummary,
} from "@acp/api-contracts";
import type { LedgerEventRecord, RoadmapVersionReadModel, TaskReadModel, WorkerReadModel } from "@acp/ledger";

import type { InitiativeDetailModel, InitiativePortfolioRow } from "../initiatives/index.js";

/**
 * Ledger read models to observation DTOs.
 *
 * Written as plain field-by-field object literals, not spreads, so that a
 * field added to a read model does not silently ride along into a DTO that
 * never asked for it: the strict response schema would already catch that at
 * `.parse()` time, but a reader of this file should not have to trust the
 * schema to know what crosses.
 */

export function taskSummary(task: TaskReadModel): TaskSummary {
  return {
    taskId: task.taskId,
    currentState: task.currentState,
    isTerminal: task.isTerminal,
    latestAttempt: task.latestAttempt,
    eventCount: task.eventCount,
    firstSequence: task.firstSequence,
    lastSequence: task.lastSequence,
    lastEventType: task.lastEventType,
    lastEmittedBy: task.lastEmittedBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function taskDetail(task: TaskReadModel, recentEvents: readonly TimelineItem[]): TaskDetail {
  return {
    ...taskSummary(task),
    lastEventId: task.lastEventId,
    lastTransitionId: task.lastTransitionId,
    recentEvents: [...recentEvents],
  };
}

export function workerSummary(worker: WorkerReadModel): WorkerSummary {
  return {
    identity: worker.identity,
    provider: worker.provider,
    model: worker.model,
    role: worker.role,
    instance: worker.instance,
    eventCount: worker.eventCount,
    taskCount: worker.taskCount,
    firstSequence: worker.firstSequence,
    lastSequence: worker.lastSequence,
    firstSeenAt: worker.firstSeenAt,
    lastSeenAt: worker.lastSeenAt,
    lastEventType: worker.lastEventType,
  };
}

export function workerDetail(
  worker: WorkerReadModel,
  recentEvents: readonly TimelineItem[],
): WorkerDetail {
  return {
    ...workerSummary(worker),
    lastTaskId: worker.lastTaskId,
    recentEvents: [...recentEvents],
  };
}

/**
 * A ledger event record to the timeline item a reader is allowed to see.
 *
 * The payload itself never crosses. Only its key names and its serialized
 * byte size do, computed here rather than imported: this package depends on
 * `@acp/api-contracts` and `@acp/ledger` only, so the byte-counting helper
 * `@acp/contracts` exports is out of reach by design, and it is one line to
 * restate.
 */
export function timelineItem(record: LedgerEventRecord): TimelineItem {
  const event = record.event;
  const payloadJson = JSON.stringify(event.payload);
  return {
    sequence: record.sequence,
    eventId: record.eventId,
    taskId: event.taskId,
    attempt: event.attempt,
    transitionId: event.transitionId,
    type: event.type,
    fromState: event.fromState,
    toState: event.toState,
    emittedBy: event.emittedBy,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    // Passed through, never derived (C1). One constructor serves the global
    // events route, task detail and the scoped timeline, so the facts reach
    // all three from here or from nowhere.
    correlationId: event.correlationId,
    causationId: event.causationId,
    previousSha256: record.previousSha256,
    eventSha256: record.eventSha256,
    payloadByteSize: new TextEncoder().encode(payloadJson).byteLength,
    payloadKeys: Object.keys(event.payload),
  };
}

// ---------------------------------------------------------------------------
// Initiatives (P8-8A)
// ---------------------------------------------------------------------------

export function initiativeSummary(row: InitiativePortfolioRow): InitiativeSummary {
  return {
    initiativeId: row.initiative.initiativeId,
    slug: row.detail.slug,
    title: row.detail.title,
    objective: row.detail.objective,
    status: row.initiative.currentStatus,
    eventCount: row.initiative.eventCount,
    headRoadmapDigest: row.headRoadmapDigest,
    roadmapVersionCount: row.roadmapVersionCount,
    taskCount: row.taskCount,
    rollup: {
      tokensUsed: row.rollup.tokensUsed,
      tokensReserved: row.rollup.tokensReserved,
      skippedMalformed: row.rollup.skippedMalformed,
    },
    createdAt: row.initiative.createdAt,
    updatedAt: row.initiative.updatedAt,
  };
}

export function roadmapVersion(version: RoadmapVersionReadModel, head: boolean): RoadmapVersionDto {
  return {
    roadmapVersionId: version.roadmapVersionId,
    initiativeId: version.initiativeId,
    version: version.version,
    contentDigest: version.contentDigest,
    parentVersionId: version.parentVersionId,
    kind: version.kind,
    restoresVersionId: version.restoresVersionId,
    recordedBy: version.recordedBy,
    recordedAt: version.recordedAt,
    sequence: version.sequence,
    head,
  };
}

export function initiativeTask(
  task: TaskReadModel,
  rollup: { readonly tokensUsed: number; readonly tokensReserved: number; readonly skippedMalformed: number } | null,
): InitiativeTaskDto {
  return {
    taskId: task.taskId,
    currentState: task.currentState,
    eventCount: task.eventCount,
    // A task the fold never saw has spent nothing, which is a zero rather than
    // an absence: the task exists in the projection either way, and reporting
    // null here would make a caller distinguish "no spend" from "no data" when
    // the ledger draws no such distinction.
    rollup: {
      tokensUsed: rollup?.tokensUsed ?? 0,
      tokensReserved: rollup?.tokensReserved ?? 0,
      skippedMalformed: rollup?.skippedMalformed ?? 0,
    },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function initiativeDetailDto(model: InitiativeDetailModel): InitiativeDetail {
  return {
    initiative: initiativeSummary(model.row),
    roadmap: model.roadmap.map((entry) => roadmapVersion(entry.version, entry.head)),
    tasks: model.tasks.map((entry) => initiativeTask(entry.task, entry.rollup)),
    quota: {
      confidence: model.quota.confidence,
      skippedMalformed: model.quota.skippedMalformed,
      unscopedTokensUsed: model.quota.unscopedTokensUsed,
    },
  };
}
