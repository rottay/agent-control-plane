import {
  LedgerError,
  LedgerIntegrityError,
  LedgerTaskStepLinkRefusedError,
  currentTaskStepLink,
  linkTaskToStep,
  openLedger,
  taskIntakePayloadOf,
} from "@acp/ledger";
import type { Ledger, RoadmapVersionReadModel, TaskStepLinkReadModel, TaskStepLinkRefusal } from "@acp/ledger";

/**
 * A task's step link: the write seam and the read (P-27 cut C, ADR 0116).
 *
 * Both halves in one module, the task graph seam's mould: the link opens a short-lived
 * writable handle, hands the request to the ledger's one producer, `linkTaskToStep`,
 * and maps what comes back; the read resolves the task's chain — the step it entered
 * on, its links in order and its current step — with every version resolved to its
 * number inside the initiative. This module **decides nothing**: the link law is
 * `decideTaskStepLink`'s, run by the producer as the fast path and by the single door
 * as the law, and the current step is `currentTaskStepLink`'s. Nothing here dispatches.
 *
 * **The instant and the event id are injected** by the route, the roadmap seam's rule.
 */

/** A step named inside one initiative: a version by number and a step id. */
export interface TaskStepPair {
  readonly version: number;
  readonly stepId: string;
}

export interface TaskStepLinkWriteInput {
  /** The read-only handle, used to read the history. Never appended through. */
  readonly ledger: Ledger;
  readonly initiativeId: string;
  readonly taskId: string;
  /** The target step: a version resolved inside the initiative, and a step id. */
  readonly version: RoadmapVersionReadModel;
  readonly stepId: string;
  /** The step the caller says the task is of now, resolved likewise; null for an adoption. */
  readonly from: { readonly version: RoadmapVersionReadModel; readonly stepId: string } | null;
  readonly linkedBy: string;
  /** Injected: the recording instant. This module reads no clock. */
  readonly recordedAt: string;
  /** Injected: the event's id. */
  readonly eventId: string;
}

export type TaskStepLinkWriteOutcome =
  | {
      readonly ok: true;
      readonly link: TaskStepLinkReadModel;
      readonly sequence: number;
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: TaskStepLinkRefusal | "WRITE_CONFLICT";
      /** A field path. Never content. */
      readonly at: string;
    };

/**
 * The ledger codes that mean another writer got there first, matched by name: the
 * roadmap seam's two (P8-8G R1).
 */
const RACE_LOST_CODES: readonly string[] = Object.freeze(["LEDGER_IDEMPOTENCY_CONFLICT", "LEDGER_EVENT_ID_CONFLICT"]);

/**
 * Link one task to one step.
 *
 * The producer's refusal is the caller's to read, by its word. A refusal from the door
 * after the producer granted, or a lost key or id race, means the history moved
 * between the read and the append: one answer, `WRITE_CONFLICT`, and no new word
 * reaches a caller. Anything else is re-thrown untouched and classifies as `INTERNAL`.
 */
export function recordTaskStepLink(input: TaskStepLinkWriteInput): TaskStepLinkWriteOutcome {
  const writable = openLedger(input.ledger.path);
  try {
    let outcome;
    try {
      outcome = linkTaskToStep({
        reader: input.ledger,
        writable,
        initiativeId: input.initiativeId,
        taskId: input.taskId,
        roadmapVersionId: input.version.roadmapVersionId,
        stepId: input.stepId,
        fromRoadmapVersionId: input.from === null ? null : input.from.version.roadmapVersionId,
        fromStepId: input.from === null ? null : input.from.stepId,
        linkedBy: input.linkedBy,
        recordedAt: input.recordedAt,
        eventId: input.eventId,
      });
    } catch (error: unknown) {
      if ((error instanceof LedgerError && RACE_LOST_CODES.includes(error.code)) || error instanceof LedgerTaskStepLinkRefusedError) {
        return Object.freeze({ ok: false as const, reason: "WRITE_CONFLICT" as const, at: "taskStepLink" });
      }
      throw error;
    }
    if (!outcome.ok) return Object.freeze({ ok: false as const, reason: outcome.reason, at: outcome.at });
    return Object.freeze({ ok: true as const, link: outcome.link, sequence: outcome.sequence, replayed: outcome.replayed });
  } finally {
    writable.close();
  }
}

/** One link of a task's chain, with its versions resolved to numbers. */
export interface TaskStepChainLink {
  readonly version: number;
  readonly stepId: string;
  readonly from: TaskStepPair | null;
  readonly sequence: number;
  readonly linkedAt: string;
}

/** What the read answers: the task's chain within the initiative, or why not. */
export type TaskStepChainOutcome =
  | {
      readonly ok: true;
      readonly enteredOn: TaskStepPair | null;
      readonly links: readonly TaskStepChainLink[];
      readonly current: TaskStepPair | null;
    }
  | { readonly ok: false; readonly reason: "UNKNOWN_TASK" };

/**
 * One task's step chain within one initiative: the step its intake named, its link rows
 * in `sequence` order, and its current step. A task the ledger does not hold, or holds
 * under another initiative or none (a legacy task), is `UNKNOWN_TASK`. A version a row
 * names that the read model does not hold is an integrity failure, `readinessOf`'s
 * mould, never a guessed number.
 */
export function taskStepChain(ledger: Ledger, initiativeId: string, taskId: string): TaskStepChainOutcome {
  const task = ledger.getTask(taskId);
  if (task?.initiativeId !== initiativeId) return Object.freeze({ ok: false as const, reason: "UNKNOWN_TASK" as const });

  const numbers = new Map<string, number>();
  const numberOf = (roadmapVersionId: string): number => {
    const known = numbers.get(roadmapVersionId);
    if (known !== undefined) return known;
    const version = ledger.getRoadmapVersion(roadmapVersionId);
    if (version?.initiativeId !== initiativeId) {
      throw new LedgerIntegrityError(["a task's step chain names a roadmap version the read model does not hold"]);
    }
    numbers.set(roadmapVersionId, version.version);
    return version.version;
  };
  const pair = (roadmapVersionId: string | null, stepId: string | null): TaskStepPair | null =>
    roadmapVersionId === null || stepId === null ? null : Object.freeze({ version: numberOf(roadmapVersionId), stepId });

  const opening = ledger.getTaskRevision(taskId, 1);
  const record = opening === null ? null : ledger.getEventBySequence(opening.sequence);
  const intake = record === null ? null : taskIntakePayloadOf(record.event);
  const intakeLink =
    intake === null
      ? null
      : { initiativeId: intake.initiativeId, roadmapVersionId: intake.roadmapVersionId, stepId: intake.stepId };
  const rows = ledger.getTaskStepLinks(taskId);
  const current = currentTaskStepLink(intakeLink, rows);

  return Object.freeze({
    ok: true as const,
    enteredOn: pair(intakeLink?.roadmapVersionId ?? null, intakeLink?.stepId ?? null),
    links: Object.freeze(
      rows.map((row) =>
        Object.freeze({
          version: numberOf(row.roadmapVersionId),
          stepId: row.stepId,
          from: pair(row.fromRoadmapVersionId, row.fromStepId),
          sequence: row.sequence,
          linkedAt: row.linkedAt,
        }),
      ),
    ),
    current: pair(current?.roadmapVersionId ?? null, current?.stepId ?? null),
  });
}
