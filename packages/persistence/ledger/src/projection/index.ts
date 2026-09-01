import {
  RoadmapVersion,
  TERMINAL_STATES,
  parseWorkerIdentity,
  type ControlPlaneEvent,
  type InitiativeEvent,
} from "@acp/contracts";

import type {
  InitiativeReadModel,
  RoadmapVersionReadModel,
  TaskReadModel,
  WorkerReadModel,
} from "../types/index.js";

/**
 * Pure projection rules.
 *
 * There is exactly one implementation of what an event does to a read model,
 * and both callers use it: the incremental path inside append, and the full
 * replay inside rebuildReadModel and verifyIntegrity.
 *
 * That is deliberate. If incremental projection and replay were written twice,
 * they would drift, and the drift would only ever be discovered by a rebuild
 * silently producing a different answer than the live projection. With one
 * function, byte-equivalence after a rebuild is a property of the design rather
 * than a coincidence that has to be tested for on every field.
 *
 * Nothing here reads a clock. Every timestamp in a read model comes from the
 * event that produced it, so the projection is a pure function of the event
 * stream and two rebuilds of the same ledger cannot differ.
 */

function isTerminalState(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The initiative a discovering event attributes its task to, if any.
 *
 * Read from the `TASK_DISCOVERED` payload and from nowhere else: that is the
 * event that opens a task, so it is the one place the attribution can be
 * stated. Every event older than the field simply has no `initiativeId` in its
 * payload and folds to null, which is what keeps a ledger written before P7I
 * replaying byte-for-byte.
 */
function initiativeIdFromEvent(event: ControlPlaneEvent): string | null {
  if (event.type !== "TASK_DISCOVERED") return null;
  const value = event.payload["initiativeId"];
  return typeof value === "string" ? value : null;
}

/** Apply one event to a task projection row, or create it from nothing. */
export function nextTaskProjection(
  current: TaskReadModel | null,
  event: ControlPlaneEvent,
  sequence: number,
): TaskReadModel {
  const base = {
    taskId: event.taskId,
    currentState: event.toState,
    lastSequence: sequence,
    lastEventId: event.eventId,
    lastEventType: event.type,
    lastTransitionId: event.transitionId,
    lastEmittedBy: event.emittedBy,
    updatedAt: event.occurredAt,
    isTerminal: isTerminalState(event.toState),
  } as const;

  if (current === null) {
    return {
      ...base,
      initiativeId: initiativeIdFromEvent(event),
      latestAttempt: event.attempt,
      eventCount: 1,
      firstSequence: sequence,
      createdAt: event.occurredAt,
    };
  }

  return {
    ...base,
    // Attribution is written once and then carried. The `??` covers only the
    // case where the row was created by something other than the discovering
    // event; a later event can supply the id but can never change one.
    initiativeId: current.initiativeId ?? initiativeIdFromEvent(event),
    // A retry raises the attempt; a late event from an older attempt must not
    // lower it, or the projection would claim the task went backwards.
    latestAttempt: Math.max(current.latestAttempt, event.attempt),
    eventCount: current.eventCount + 1,
    firstSequence: current.firstSequence,
    createdAt: current.createdAt,
  };
}

/**
 * Apply one event to a worker projection row, or create it from nothing.
 *
 * taskIsNewForWorker comes from the caller because the two callers hold that
 * fact in different places: the incremental path looks it up in
 * worker_task_read_model, the replay path holds it in memory. The arithmetic
 * itself stays here, in one place.
 */
export function nextWorkerProjection(
  current: WorkerReadModel | null,
  event: ControlPlaneEvent,
  sequence: number,
  taskIsNewForWorker: boolean,
): WorkerReadModel {
  const identity = parseWorkerIdentity(event.emittedBy);

  const base = {
    identity: event.emittedBy,
    provider: identity.provider,
    model: identity.model,
    role: identity.role,
    instance: identity.instance,
    lastSequence: sequence,
    lastSeenAt: event.occurredAt,
    lastTaskId: event.taskId,
    lastEventType: event.type,
  } as const;

  if (current === null) {
    return {
      ...base,
      eventCount: 1,
      taskCount: 1,
      firstSequence: sequence,
      firstSeenAt: event.occurredAt,
    };
  }

  return {
    ...base,
    eventCount: current.eventCount + 1,
    taskCount: current.taskCount + (taskIsNewForWorker ? 1 : 0),
    firstSequence: current.firstSequence,
    firstSeenAt: current.firstSeenAt,
  };
}

/** One worker/task association row, derived from observed emitters. */
export interface WorkerTaskProjection {
  readonly identity: string;
  readonly taskId: string;
  readonly eventCount: number;
  readonly lastSequence: number;
}

export function nextWorkerTaskProjection(
  current: WorkerTaskProjection | null,
  event: ControlPlaneEvent,
  sequence: number,
): WorkerTaskProjection {
  return {
    identity: event.emittedBy,
    taskId: event.taskId,
    eventCount: (current?.eventCount ?? 0) + 1,
    lastSequence: sequence,
  };
}

/**
 * In-memory projection of an entire event stream.
 *
 * Used by rebuildReadModel to replay, and by verifyIntegrity to compute what
 * the stored projection should have been so the two can be compared.
 */
export interface ProjectionSnapshot {
  readonly tasks: Map<string, TaskReadModel>;
  readonly workers: Map<string, WorkerReadModel>;
  readonly workerTasks: Map<string, WorkerTaskProjection>;
}

export function createProjectionSnapshot(): ProjectionSnapshot {
  return {
    tasks: new Map<string, TaskReadModel>(),
    workers: new Map<string, WorkerReadModel>(),
    workerTasks: new Map<string, WorkerTaskProjection>(),
  };
}

export function workerTaskKey(identity: string, taskId: string): string {
  // The identity pattern forbids a space, so this separator cannot collide.
  return identity + " " + taskId;
}

/** Fold one event into an in-memory snapshot. */
export function applyEventToSnapshot(
  snapshot: ProjectionSnapshot,
  event: ControlPlaneEvent,
  sequence: number,
): void {
  snapshot.tasks.set(
    event.taskId,
    nextTaskProjection(snapshot.tasks.get(event.taskId) ?? null, event, sequence),
  );

  const pairKey = workerTaskKey(event.emittedBy, event.taskId);
  const existingPair = snapshot.workerTasks.get(pairKey) ?? null;

  snapshot.workers.set(
    event.emittedBy,
    nextWorkerProjection(
      snapshot.workers.get(event.emittedBy) ?? null,
      event,
      sequence,
      existingPair === null,
    ),
  );

  snapshot.workerTasks.set(pairKey, nextWorkerTaskProjection(existingPair, event, sequence));
}

// ---------------------------------------------------------------------------
// The initiative stream's projections
// ---------------------------------------------------------------------------

/** Apply one initiative event to an initiative projection row. */
export function nextInitiativeProjection(
  current: InitiativeReadModel | null,
  event: InitiativeEvent,
  sequence: number,
): InitiativeReadModel {
  const base = {
    initiativeId: event.initiativeId,
    currentStatus: event.toStatus,
    lastSequence: sequence,
    lastEventId: event.eventId,
    lastEventType: event.type,
    lastTransitionId: event.transitionId,
    lastEmittedBy: event.emittedBy,
    updatedAt: event.occurredAt,
  } as const;

  if (current === null) {
    return { ...base, eventCount: 1, firstSequence: sequence, createdAt: event.occurredAt };
  }

  return {
    ...base,
    eventCount: current.eventCount + 1,
    firstSequence: current.firstSequence,
    createdAt: current.createdAt,
  };
}

/**
 * The roadmap version a `ROADMAP_VERSION_RECORDED` event records, if its
 * payload carries one.
 *
 * The version travels in the event's payload as a `RoadmapVersion` value, and
 * it is parsed here through the contract rather than trusted: the payload is a
 * bounded record of unknowns, so the only way to know it is a version is to
 * ask the schema. A payload that does not parse, or that names a different
 * initiative than the event it rides on, projects **no row** — the event still
 * stands in the stream and still moves the initiative projection, because an
 * append-only log does not get to disown an event it accepted. Live projection
 * and replay share this one function, so both agree about which events produce
 * a row.
 */
export function nextRoadmapVersionProjection(
  event: InitiativeEvent,
  sequence: number,
): RoadmapVersionReadModel | null {
  if (event.type !== "ROADMAP_VERSION_RECORDED") return null;

  const parsed = RoadmapVersion.safeParse(event.payload);
  if (!parsed.success) return null;
  if (parsed.data.initiativeId !== event.initiativeId) return null;

  return {
    roadmapVersionId: parsed.data.roadmapVersionId,
    initiativeId: parsed.data.initiativeId,
    version: parsed.data.version,
    contentDigest: parsed.data.contentDigest,
    parentVersionId: parsed.data.parentVersionId,
    kind: parsed.data.kind,
    restoresVersionId: parsed.data.restoresVersionId,
    recordedBy: parsed.data.recordedBy,
    recordedAt: parsed.data.recordedAt,
    sequence,
  };
}

/** In-memory projection of the whole initiative stream. */
export interface InitiativeProjectionSnapshot {
  readonly initiatives: Map<string, InitiativeReadModel>;
  readonly roadmapVersions: Map<string, RoadmapVersionReadModel>;
}

export function createInitiativeProjectionSnapshot(): InitiativeProjectionSnapshot {
  return {
    initiatives: new Map<string, InitiativeReadModel>(),
    roadmapVersions: new Map<string, RoadmapVersionReadModel>(),
  };
}

/** Fold one initiative event into an in-memory snapshot. */
export function applyInitiativeEventToSnapshot(
  snapshot: InitiativeProjectionSnapshot,
  event: InitiativeEvent,
  sequence: number,
): void {
  snapshot.initiatives.set(
    event.initiativeId,
    nextInitiativeProjection(snapshot.initiatives.get(event.initiativeId) ?? null, event, sequence),
  );

  const version = nextRoadmapVersionProjection(event, sequence);
  if (version !== null) snapshot.roadmapVersions.set(version.roadmapVersionId, version);
}
