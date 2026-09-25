import { CONTRACT_VERSION, TaskStepLinkDeclaration, buildInitiativeIdempotencyKey } from "@acp/contracts";

import { LedgerIntegrityError } from "../errors/index.js";
import { taskGraphLinkOf } from "../task-graph/index.js";
import type { TaskGraphTaskLink } from "../task-graph/index.js";
import type { TaskStepLinkReadModel } from "../types/index.js";

import type {
  TaskStepLinkInput,
  TaskStepLinkInputOutcome,
  TaskStepLinkOutcome,
  TaskStepLinkDecisionRequest,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`,
 * and are re-exported here unchanged (owner law §7).
 */
export type {
  TaskStepLinkGranted,
  TaskStepLinkInput,
  TaskStepLinkInputOutcome,
  TaskStepLinkOutcome,
  TaskStepLinkRefused,
  TaskStepLinkDecisionRequest,
} from "./types/index.js";

/**
 * A task's step link — P-27 cut C, ADR 0116 (requirement A3; decisions 200-202).
 *
 * ## What a link is
 *
 * A task enters on a step, or on none, by its intake (decision 197), and that fact is
 * the task stream's and never rewritten. From then on the task changes step only
 * through a `TASK_STEP_LINKED` on its initiative's stream: an **adoption** of a task
 * that entered with no step, to any step its initiative declares, or a **re-link** of a
 * task to the same step id in a strictly later version of its roadmap. Each link names
 * the pair it leaves (`from`), which must be the task's current step: the links are a
 * chain, and the current step is the last link's target, or failing that the intake's.
 *
 * ## The decision
 *
 * `decideTaskStepLink` is pure over what it is handed: the payload, untrusted, and the
 * questions only its caller can answer about the history. The initiative single door
 * calls it inside its `BEGIN IMMEDIATE`, over the read model that transaction keeps
 * level with the streams, and refuses what it refuses; that call is the law.
 * `linkTaskToStep` calls it first over its reader, as the fast path. One function, two
 * callers: the task graph decision's mould (ADR 0115).
 *
 * ## One read of "the task's current step"
 *
 * `currentTaskStepLink` is the one answer to which step a task is of, for three
 * callers: the task graph door's scope question (`GRAPH_TASK_OUT_OF_SCOPE`, decision
 * 201), the task graph producer's, and this decision's `from` check.
 */

/**
 * The closed refusal vocabulary, sorted. Every refusal names the field that failed,
 * never a value.
 */
export const TASK_STEP_LINK_REFUSALS = [
  "LINK_DECLARATION_INVALID",
  "LINK_HEAD_MISMATCH",
  "LINK_STEP_UNKNOWN",
  "LINK_TARGET_NOT_LATER",
  "LINK_TASK_OUT_OF_SCOPE",
  "LINK_TASK_UNKNOWN",
] as const;

export type TaskStepLinkRefusal = (typeof TASK_STEP_LINK_REFUSALS)[number];

function refuse(reason: TaskStepLinkRefusal, at: string): TaskStepLinkOutcome {
  return Object.freeze({ ok: false as const, reason, at });
}

function issuePath(prefix: string, path: readonly PropertyKey[] | undefined): string {
  return [prefix, ...(path ?? []).map(String)].join(".");
}

/**
 * The step a task is of: the last of its links by `sequence`, or failing that the
 * step its intake named (both null when it entered with none), or failing that null
 * (a task with no recorded intake and no link).
 *
 * Pure, and picks by `sequence`, never by array position, so a caller may hand the
 * links in any order.
 */
export function currentTaskStepLink(
  intake: TaskGraphTaskLink | null,
  links: readonly TaskStepLinkReadModel[],
): TaskGraphTaskLink | null {
  let last: TaskStepLinkReadModel | null = null;
  for (const link of links) {
    if (last === null || link.sequence > last.sequence) last = link;
  }
  if (last !== null) {
    return Object.freeze({ initiativeId: last.initiativeId, roadmapVersionId: last.roadmapVersionId, stepId: last.stepId });
  }
  return intake;
}

/**
 * Decide whether one task may be linked to one step.
 *
 * The order is the design, coarsest first, with the task stream last and existence
 * before scope (ADR 0115's order):
 *
 * 1. the payload, through the contract (`LINK_DECLARATION_INVALID`, at the zod path
 *    under `link.`): a `from` pair half set, or a target that is the `from` pair;
 * 2. the target step, declared under this initiative (`LINK_STEP_UNKNOWN`);
 * 3. the task's revision 1, recorded (`LINK_TASK_UNKNOWN`);
 * 4. the task's recorded intake, of this initiative (`LINK_TASK_OUT_OF_SCOPE`): a task
 *    with no intake has no initiative and is adopted nowhere, and a task never moves
 *    across initiatives, because its initiative is part of its envelope's identity;
 * 5. the `from` pair, the task's current step (`LINK_HEAD_MISMATCH`, at
 *    `link.fromRoadmapVersionId` when the versions differ or one is null, at
 *    `link.fromStepId` when only the step differs);
 * 6. a re-link's target, the same step id in a strictly later version of this
 *    initiative (`LINK_TARGET_NOT_LATER`, at `link.roadmapVersionId`). An adoption goes
 *    to any declared step: no head-only rule. The task's lifecycle state is not asked.
 */
export function decideTaskStepLink(request: TaskStepLinkDecisionRequest): TaskStepLinkOutcome {
  const parsed = TaskStepLinkDeclaration.safeParse(request.link);
  if (!parsed.success) return refuse("LINK_DECLARATION_INVALID", issuePath("link", parsed.error.issues[0]?.path));
  const link = parsed.data;

  if (!request.stepDeclared(link.roadmapVersionId, link.stepId)) return refuse("LINK_STEP_UNKNOWN", "link.stepId");
  if (!request.taskKnown(link.taskId)) return refuse("LINK_TASK_UNKNOWN", "link.taskId");
  const intake = request.taskIntake(link.taskId);
  if (intake?.initiativeId !== request.initiativeId) return refuse("LINK_TASK_OUT_OF_SCOPE", "link.taskId");

  const current = currentTaskStepLink(intake, request.taskLinks(link.taskId));
  const currentVersion = current?.roadmapVersionId ?? null;
  const currentStep = current?.stepId ?? null;
  if (link.fromRoadmapVersionId !== currentVersion) return refuse("LINK_HEAD_MISMATCH", "link.fromRoadmapVersionId");
  if (link.fromStepId !== currentStep) return refuse("LINK_HEAD_MISMATCH", "link.fromStepId");

  if (link.fromRoadmapVersionId !== null) {
    const from = request.versionNumber(link.fromRoadmapVersionId);
    const target = request.versionNumber(link.roadmapVersionId);
    if (link.stepId !== link.fromStepId || from === null || target === null || target <= from) {
      return refuse("LINK_TARGET_NOT_LATER", "link.roadmapVersionId");
    }
  }

  return Object.freeze({ ok: true as const, link });
}

/**
 * The transition id of a link: its task and its target version, so the idempotency key
 * is a function of the link's identity and a retry from any client is a replay. The
 * chain rule makes the pair unique: a task's targets are strictly later versions.
 */
export function taskStepLinkTransitionId(taskId: string, roadmapVersionId: string): string {
  return "link." + taskId + "." + roadmapVersionId;
}

function refuseLink(reason: TaskStepLinkRefusal, at: string): TaskStepLinkInputOutcome {
  return Object.freeze({ ok: false as const, reason, at });
}

/**
 * Link one task to one step.
 *
 * The order is the design. An unknown initiative is `LINK_STEP_UNKNOWN` at
 * `initiativeId`, as the task graph producer answers it. A link already recorded at
 * `(taskId, roadmapVersionId)` is answered from its row: the same step, `from` pair
 * and initiative are a replay, and anything else is `LINK_DECLARATION_INVALID` at
 * `link.roadmapVersionId`. Otherwise decide over the reader, and append through the
 * single door, where the same decision runs again as the law.
 *
 * It opens nothing and reads no clock and no random source: the handles, the instant
 * and the event id arrive with the input. Ledger errors are thrown untouched.
 */
export function linkTaskToStep(input: TaskStepLinkInput): TaskStepLinkInputOutcome {
  const { reader, writable, initiativeId, taskId, roadmapVersionId, recordedAt } = input;

  const initiative = reader.getInitiative(initiativeId);
  if (initiative === null) return refuseLink("LINK_STEP_UNKNOWN", "initiativeId");

  const recorded = reader.getTaskStepLinks(taskId).find((row) => row.roadmapVersionId === roadmapVersionId);
  if (recorded !== undefined) {
    const same =
      recorded.initiativeId === initiativeId &&
      recorded.stepId === input.stepId &&
      recorded.fromRoadmapVersionId === input.fromRoadmapVersionId &&
      recorded.fromStepId === input.fromStepId;
    if (!same) return refuseLink("LINK_DECLARATION_INVALID", "link.roadmapVersionId");
    return Object.freeze({ ok: true as const, link: recorded, sequence: recorded.sequence, replayed: true });
  }

  const link = {
    taskId,
    roadmapVersionId,
    stepId: input.stepId,
    fromRoadmapVersionId: input.fromRoadmapVersionId,
    fromStepId: input.fromStepId,
  };
  const decision = decideTaskStepLink({
    initiativeId,
    link,
    stepDeclared: (versionId, id) =>
      reader.getRoadmapVersion(versionId)?.initiativeId === initiativeId &&
      reader.listRoadmapSteps(versionId).some((step) => step.stepId === id),
    versionNumber: (versionId) => {
      const version = reader.getRoadmapVersion(versionId);
      return version?.initiativeId === initiativeId ? version.version : null;
    },
    taskKnown: (id) => reader.getTaskRevision(id, 1) !== null,
    taskIntake: (id) => {
      const opening = reader.getTaskRevision(id, 1);
      const record = opening === null ? null : reader.getEventBySequence(opening.sequence);
      return record === null ? null : taskGraphLinkOf(record.event);
    },
    taskLinks: (id) => reader.getTaskStepLinks(id),
  });
  if (!decision.ok) return refuseLink(decision.reason, decision.at);

  const transitionId = taskStepLinkTransitionId(taskId, roadmapVersionId);
  const appended = writable.appendInitiativeEvent({
    contractVersion: CONTRACT_VERSION,
    eventId: input.eventId,
    initiativeId,
    transitionId,
    idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId, transitionId }),
    type: "TASK_STEP_LINKED",
    fromStatus: initiative.currentStatus,
    toStatus: initiative.currentStatus,
    emittedBy: input.linkedBy,
    occurredAt: recordedAt,
    recordedAt,
    payload: link,
  });
  const row = writable.getTaskStepLinks(taskId).find((candidate) => candidate.roadmapVersionId === roadmapVersionId);
  if (row === undefined) throw new LedgerIntegrityError(["a task step link's append answered with no link row"]);
  return Object.freeze({ ok: true as const, link: row, sequence: appended.record.sequence, replayed: !appended.inserted });
}
