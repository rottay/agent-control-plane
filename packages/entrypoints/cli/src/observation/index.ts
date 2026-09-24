/**
 * The observation layer: ledger read models in, validated DTOs out.
 *
 * Everything the CLI prints is produced here and passed through the schemas of
 * `@acp/protocol` before it reaches a formatter. That is not belt and
 * braces. The mapping code in this file is the new code between two things that
 * are already careful, and a boundary that only trusts the layer below it is not
 * a boundary. If a projection grows a field, a digest stops being a digest or a
 * count stops agreeing with its collection, the parse fails here rather than
 * printing a plausible answer.
 *
 * Three laws this module keeps:
 *
 * 1. Read only. It opens the ledger with `readOnly: true` and calls no mutating
 *    method. `rebuildReadModel()` and `append()` are never reachable from the
 *    CLI at all.
 * 2. No absolute path. The ledger path is replaced by a digest of the resolved
 *    path plus the bare file name. The path itself never enters a DTO, a human
 *    line or an error.
 * 3. No payload values. Only payload key names and the serialized payload size
 *    cross, because payloads are the one part of an event whose contents the
 *    contract does not fix.
 */

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

import {
  API_CONTRACT_VERSION,
  EventPageResponse,
  IntegrityResult,
  LEDGER_CONTRACT_VERSION,
  LedgerDatabaseIdentity,
  LedgerStatusResponse,
  MAX_DETAIL_TIMELINE_ITEMS,
  MAX_TASK_EFFECTS,
  OverviewResponse,
  TaskDetailResponse,
  TaskEffectResultResponse,
  TaskEffectsResponse,
  TaskPageResponse,
  TimelineItem,
  ToolCallPageResponse,
  WorkerDetailResponse,
  WorkerPageResponse,
} from "@acp/protocol";
import { canonicalRows } from "@acp/protocol";
import type { ApiRouteName, OverviewState } from "@acp/protocol";
import { payloadKeys } from "@acp/observation";
import { readEffectResult } from "@acp/runtime";
import type {
  EventQuery,
  IntegrityReport,
  Ledger,
  LedgerEventRecord,
  LedgerStatus,
  TaskQuery,
  TaskReadModel,
  WorkerQuery,
  WorkerReadModel,
} from "@acp/ledger";

/**
 * What one tool-call page is asked for (V2-B4b stage 3D).
 *
 * A task and an optional window. Declared here rather than imported because it
 * is the CLI's own call shape, not a wire contract: `ToolCallsQuery` is the
 * HTTP query, and reusing it would tie a local function signature to a
 * transport it does not speak.
 */
export interface ToolCallPageQuery {
  readonly taskId: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

/** Ceiling on the problems an integrity result may carry, from the contract. */
const MAX_INTEGRITY_PROBLEMS = 500;

/**
 * The two version lines every response carries.
 *
 * They are aliased once here so no call site can stamp a literal of its own. A
 * response that claimed a version this build is not compiled against would be
 * worse than one that failed to parse.
 */
const API_VERSION = API_CONTRACT_VERSION;
const LEDGER_VERSION = LEDGER_CONTRACT_VERSION;

/** A clock, injected so a test can render a fixed document. */
export type Clock = () => string;

/**
 * The CLI's adapter into the shared canonical row model (P3D).
 *
 * Thin on purpose. The row model is defined once, in `@acp/protocol`, and
 * each client contributes only the step from its own output shape into it —
 * three definitions kept in step would be three chances to drift, which is the
 * thing parity exists to catch.
 */
export function cliRowModel(route: ApiRouteName, response: unknown): unknown {
  return canonicalRows(route, response);
}

export const systemClock: Clock = () => new Date().toISOString();

/**
 * Identify the ledger without naming it.
 *
 * The absolute path of a ledger names a home directory, a user account and a
 * machine layout, so it is replaced by a digest of the resolved path plus the
 * bare file name. That is enough to tell two ledgers apart and useless for
 * reaching either of them.
 */
export function databaseIdentity(path: string): LedgerDatabaseIdentity {
  const resolved = resolve(path);
  return LedgerDatabaseIdentity.parse({
    id: createHash("sha256").update(resolved, "utf8").digest("hex"),
    label: basename(resolved),
    pathRedacted: true,
  });
}

function payloadByteSize(payload: Readonly<Record<string, unknown>>): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

export function toTimelineItem(record: LedgerEventRecord): TimelineItem {
  const event = record.event;
  return TimelineItem.parse({
    sequence: record.sequence,
    eventId: event.eventId,
    taskId: event.taskId,
    attempt: event.attempt,
    transitionId: event.transitionId,
    type: event.type,
    fromState: event.fromState,
    toState: event.toState,
    emittedBy: event.emittedBy,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    // Passed through from the event, verbatim, exactly as the server's mapper
    // does (P8-8E-pre, C1). The parity law is that three clients fold the same
    // ledger identically; two of them deriving these and one omitting them
    // would be the first way that law could quietly become false.
    correlationId: event.correlationId,
    causationId: event.causationId,
    previousSha256: record.previousSha256,
    eventSha256: record.eventSha256,
    payloadByteSize: payloadByteSize(event.payload),
    payloadKeys: payloadKeys(event.payload),
  });
}

function taskSummaryFields(task: TaskReadModel): Record<string, unknown> {
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

function workerSummaryFields(worker: WorkerReadModel): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function buildTaskPage(ledger: Ledger, query: TaskQuery): TaskPageResponse {
  const page = ledger.listTasks(query);
  const limit = query.limit ?? page.tasks.length;
  return TaskPageResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    items: page.tasks.map(taskSummaryFields),
    page: {
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      limit,
      returned: page.tasks.length,
    },
  });
}

export function buildWorkerPage(ledger: Ledger, query: WorkerQuery): WorkerPageResponse {
  const page = ledger.listWorkers(query);
  const limit = query.limit ?? page.workers.length;
  return WorkerPageResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    items: page.workers.map(workerSummaryFields),
    page: {
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      limit,
      returned: page.workers.length,
    },
  });
}

export function buildEventPage(ledger: Ledger, query: EventQuery): EventPageResponse {
  const page = ledger.listEvents(query);
  const limit = query.limit ?? page.events.length;
  return EventPageResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    items: page.events.map(toTimelineItem),
    page: {
      // The ledger cursor is an integer sequence. It crosses as a string because
      // the contract says a cursor is opaque, and a reader that starts doing
      // arithmetic on it makes the pagination strategy a breaking change.
      nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
      hasMore: page.hasMore,
      limit,
      returned: page.events.length,
    },
  });
}

/**
 * One task's recorded tool calls, oldest first (V2-B4b stage 3D).
 *
 * A fold of `TOOL_CALL_RECORDED` rows, and the CLI half of the parity claim:
 * this projection and the gateway's are two independent producers over one
 * ledger, so the equality between them is evidence rather than a shared code
 * path. It is deliberately *not* imported from the gateway — an entrypoint that
 * read another entrypoint's projection would prove only that one function
 * agrees with itself.
 *
 * There is no content member to omit: the recorder never wrote one, so the
 * absence is structural.
 */
export function buildToolCallPage(ledger: Ledger, query: ToolCallPageQuery): ToolCallPageResponse {
  const page = ledger.listEvents({
    taskId: query.taskId,
    type: "TOOL_CALL_RECORDED",
    ...(query.afterSequence === undefined ? {} : { afterSequence: query.afterSequence }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  });

  const items = page.events.map((row) => {
    const payload = row.event.payload;
    return {
      sequence: row.sequence,
      eventId: row.eventId,
      transitionId: row.event.transitionId,
      occurredAt: row.event.occurredAt,
      emittedBy: row.event.emittedBy,
      causedBy: row.event.causationId,
      accountId: payload["accountId"],
      serverId: payload["serverId"],
      toolName: payload["toolName"],
      transport: payload["transport"],
      outcome: payload["outcome"],
      refusal: payload["refusal"],
      argumentBytes: payload["argumentBytes"],
      resultBytes: payload["resultBytes"],
      contentBlocks: payload["contentBlocks"],
    };
  });

  return ToolCallPageResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    taskId: query.taskId,
    items,
    count: items.length,
    // The ledger's own cursor, stringified, for the reason `buildEventPage`
    // gives: a cursor is opaque, and arithmetic on it makes the pagination
    // strategy a breaking change.
    nextCursor: page.hasMore && page.nextCursor !== null ? String(page.nextCursor) : null,
  });
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/**
 * The most recent events matching a filter, newest first.
 *
 * The ledger pages forward by sequence and offers no descending query, so the
 * stream is walked once with a rolling window of the last N records. Memory is
 * bounded by the window rather than by the size of the ledger, and the result is
 * the genuine tail rather than a prefix that happened to be cheap to read.
 */
function recentRecords(
  ledger: Ledger,
  filter: Pick<EventQuery, "taskId" | "emittedBy">,
  windowSize: number,
): LedgerEventRecord[] {
  const window: LedgerEventRecord[] = [];
  let cursor: number | undefined;

  for (;;) {
    const page = ledger.listEvents({
      ...filter,
      ...(cursor === undefined ? {} : { afterSequence: cursor }),
      limit: 200,
    });
    for (const record of page.events) {
      window.push(record);
      if (window.length > windowSize) window.shift();
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  return window.reverse();
}

export function buildTaskDetail(ledger: Ledger, taskId: string): TaskDetailResponse | null {
  const task = ledger.getTask(taskId);
  if (task === null) return null;

  const recent = recentRecords(ledger, { taskId }, MAX_DETAIL_TIMELINE_ITEMS);
  return TaskDetailResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    task: {
      ...taskSummaryFields(task),
      lastEventId: task.lastEventId,
      lastTransitionId: task.lastTransitionId,
      recentEvents: recent.map(toTimelineItem),
    },
  });
}

/**
 * A task's effects, or null when the ledger holds no such task (P-15/F).
 *
 * The CLI's side of the `taskEffects` pairing: ids, coordinates and outcome
 * words, and whether a result exists — never its reference or its digest.
 */
export function buildTaskEffects(ledger: Ledger, taskId: string): TaskEffectsResponse | null {
  if (ledger.getTask(taskId) === null) return null;
  const page = ledger.listTaskEffects(taskId, { limit: MAX_TASK_EFFECTS });
  return TaskEffectsResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    taskId,
    truncated: page.truncated,
    effects: page.effects.map((effect) => ({
      effectId: effect.effectId,
      revisionNumber: effect.revisionNumber,
      attemptNumber: effect.attemptNumber,
      operationOrdinal: effect.operationOrdinal,
      effectKind: effect.effectKind,
      intendedAt: effect.intendedAt,
      outcomeStatus: effect.outcomeStatus,
      outcomeRecordedAt: effect.outcomeRecordedAt,
      // The pair is whole or absent (the ledger's trigger), so its digest's presence
      // is the answer; the reference itself is never read here (L-P15F-1 (i)).
      hasResult: effect.resultSha256 !== null,
    })),
  });
}

/**
 * What the `result` verb answers: the document, or which refusal it is.
 *
 * The refusals are the verb's to turn into an exit code and an envelope; this
 * module only reads, and never prints.
 */
export type EffectResultAnswer =
  | { readonly kind: "DOCUMENT"; readonly response: TaskEffectResultResponse }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "BLOCK_REFUSED" }
  | { readonly kind: "UNREADABLE"; readonly refusal: string };

/**
 * One effect's result (P-15 escalón F, ADR 0107): the CLI's private read.
 *
 * The same runtime reader the gateway's bearer-guarded route calls, and the same
 * document it answers — the parity suite holds the two equal. On the CLI the
 * authorization is the operator's own filesystem access to the ledger and to the
 * private plane beside it (root `0700`, objects `0600`). The text leaves this
 * function only inside the document it returns: no log, no stream, no stderr.
 */
export function buildEffectResult(
  ledger: Ledger,
  taskId: string,
  effectId: string,
  block: number | null,
): EffectResultAnswer {
  const reading = readEffectResult(ledger, { taskId, effectId, block });
  const base = {
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    taskId,
    effectId,
  };
  switch (reading.kind) {
    case "NOT_FOUND":
      return { kind: "NOT_FOUND" };
    case "BLOCK_REFUSED":
      return { kind: "BLOCK_REFUSED" };
    case "RESULT_UNREADABLE":
      return { kind: "UNREADABLE", refusal: reading.refusal };
    case "NO_OUTCOME":
      return {
        kind: "DOCUMENT",
        response: TaskEffectResultResponse.parse({
          ...base,
          state: "NO_OUTCOME",
          outcomeStatus: null,
          outcomeRecordedAt: null,
          cohort: null,
          result: null,
          blockContent: null,
        }),
      };
    case "OUTCOME_UNKNOWN":
    case "CANCELLED":
      return {
        kind: "DOCUMENT",
        response: TaskEffectResultResponse.parse({
          ...base,
          state: reading.kind,
          outcomeStatus: reading.kind,
          outcomeRecordedAt: reading.outcomeRecordedAt,
          cohort: null,
          result: null,
          blockContent: null,
        }),
      };
    case "NO_RESULT_RECORDED":
      return {
        kind: "DOCUMENT",
        response: TaskEffectResultResponse.parse({
          ...base,
          state: "NO_RESULT_RECORDED",
          outcomeStatus: reading.status,
          outcomeRecordedAt: reading.outcomeRecordedAt,
          cohort: reading.cohort,
          result: null,
          blockContent: null,
        }),
      };
    case "RESULT":
      return {
        kind: "DOCUMENT",
        response: TaskEffectResultResponse.parse({
          ...base,
          state: "RESULT",
          outcomeStatus: reading.status,
          outcomeRecordedAt: reading.outcomeRecordedAt,
          cohort: "CURRENT",
          result: {
            resultSha256: reading.resultSha256,
            artifactReferenceId: reading.artifactReferenceId,
            document: reading.document,
          },
          blockContent: reading.block,
        }),
      };
    default: {
      const unreachable: never = reading;
      return unreachable;
    }
  }
}

export function buildWorkerDetail(
  ledger: Ledger,
  identity: string,
): WorkerDetailResponse | null {
  const worker = ledger.getWorker(identity);
  if (worker === null) return null;

  const recent = recentRecords(ledger, { emittedBy: identity }, MAX_DETAIL_TIMELINE_ITEMS);
  return WorkerDetailResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    worker: {
      ...workerSummaryFields(worker),
      lastTaskId: worker.lastTaskId,
      recentEvents: recent.map(toTimelineItem),
    },
  });
}

// ---------------------------------------------------------------------------
// Status and integrity
// ---------------------------------------------------------------------------

export function buildStatus(
  status: LedgerStatus,
  database: LedgerDatabaseIdentity,
  now: Clock,
): LedgerStatusResponse {
  // The ledger status carries an absolute path. Every field is copied across
  // explicitly rather than spread, and the response schema is strict, so a
  // spread that forwarded the path would fail to parse instead of leaking it.
  return LedgerStatusResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    database,
    // Field by field, never a spread: only what is named here crosses.
    instance: {
      instanceId: status.instance.instanceId,
      restoreId: status.instance.restoreId,
      restoreEpoch: status.instance.restoreEpoch,
    },
    readOnly: status.readOnly,
    headSequence: status.headSequence,
    headEventSha256: status.headEventSha256,
    eventCount: status.eventCount,
    pragmas: {
      journalMode: status.pragmas.journalMode,
      foreignKeys: status.pragmas.foreignKeys,
      synchronous: status.pragmas.synchronous,
      busyTimeoutMs: status.pragmas.busyTimeoutMs,
      queryOnly: status.pragmas.queryOnly,
    },
    migrations: status.migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      sha256: migration.sha256,
      appliedAt: migration.appliedAt,
    })),
    projections: status.projections.map((projection) => ({
      name: projection.name,
      rowCount: projection.rowCount,
      updatedAt: projection.updatedAt,
      // Entry by entry, for the same reason the fields above are copied one by
      // one rather than spread: a spread forwards whatever the producer added,
      // and the point of this mapper is that only what is named here crosses.
      watermarks: projection.watermarks.map((watermark) => ({
        sourceStream: watermark.sourceStream,
        appliedThroughSequence: watermark.appliedThroughSequence,
        eventCount: watermark.eventCount,
        sourceHeadSha256: watermark.sourceHeadSha256,
      })),
    })),
    observedAt: now(),
  });
}

export function buildIntegrity(report: IntegrityReport, now: Clock): IntegrityResult {
  const kept = report.problems.slice(0, MAX_INTEGRITY_PROBLEMS);
  return IntegrityResult.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    ok: report.ok,
    checkedEvents: report.checkedEvents,
    headSequence: report.headSequence,
    headEventSha256: report.headEventSha256,
    problems: kept.map((problem) => ({
      kind: problem.kind,
      detail: problem.detail.slice(0, 500),
      sequence: problem.sequence,
    })),
    coverage: report.coverage.map((entry) => ({
      sourceStream: entry.sourceStream,
      coverageKind: entry.coverageKind,
      coveredSinceSequence: entry.coveredSinceSequence,
      checkedThroughSequence: entry.checkedThroughSequence,
      integrityActivatedAt: entry.integrityActivatedAt,
      baselineSequence: entry.baselineSequence,
      baselineSha256: entry.baselineSha256,
    })),
    truncated: kept.length < report.problems.length,
    checkedAt: now(),
  });
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/**
 * Walk every page of a projection.
 *
 * The overview reports totals, and a total computed from one page is a lie the
 * size of the second page. The walk is bounded by the ledger rather than by a
 * ceiling, because a silently truncated total is exactly the failure this
 * function exists to avoid.
 */
function allTasks(ledger: Ledger): TaskReadModel[] {
  const tasks: TaskReadModel[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = ledger.listTasks({
      ...(cursor === undefined ? {} : { afterTaskId: cursor }),
      limit: 200,
    });
    tasks.push(...page.tasks);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return tasks;
}

function allWorkers(ledger: Ledger): WorkerReadModel[] {
  const workers: WorkerReadModel[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = ledger.listWorkers({
      ...(cursor === undefined ? {} : { afterIdentity: cursor }),
      limit: 200,
    });
    workers.push(...page.workers);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return workers;
}

function tally<TKey extends string>(values: readonly TKey[]): { key: TKey; count: number }[] {
  const counts = new Map<TKey, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

export interface OverviewInput {
  readonly ledger: Ledger;
  readonly database: LedgerDatabaseIdentity;
  readonly integrity: IntegrityReport | null;
  readonly now: Clock;
}

export function buildOverview(input: OverviewInput): OverviewResponse {
  const { ledger, database, integrity, now } = input;
  const status = ledger.status();
  const tasks = allTasks(ledger);
  const workers = allWorkers(ledger);

  const terminal = tasks.filter((task) => task.isTerminal).length;
  const lastRecord =
    status.headSequence > 0 ? ledger.getEventBySequence(status.headSequence) : null;

  const failing = integrity !== null && !integrity.ok;
  const state: OverviewState = failing
    ? "DEGRADED"
    : status.eventCount === 0
      ? "EMPTY"
      : "ACTIVE";

  const notice = failing
    ? "the ledger failed its integrity check; run acp integrity for the problems"
    : null;

  return OverviewResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    state,
    observedAt: now(),
    database,
    ledger: {
      eventCount: status.eventCount,
      headSequence: status.headSequence,
      headEventSha256: status.headEventSha256,
      lastEventAt: lastRecord === null ? null : lastRecord.event.recordedAt,
    },
    integrity:
      integrity === null
        ? { checked: false, ok: null, problemCount: null, checkedAt: null }
        : {
            checked: true,
            ok: integrity.ok,
            problemCount: integrity.problems.length,
            checkedAt: now(),
          },
    tasks: {
      total: tasks.length,
      terminal,
      active: tasks.length - terminal,
      byState: tally(tasks.map((task) => task.currentState)).map((entry) => ({
        state: entry.key,
        count: entry.count,
      })),
    },
    workers: {
      total: workers.length,
      byRole: tally(workers.map((worker) => worker.role)).map((entry) => ({
        role: entry.key,
        count: entry.count,
      })),
    },
    capabilities: {
      readOnly: true,
      writes: false,
      routing: false,
      accounts: false,
      leases: false,
    },
    notice,
  });
}

/**
 * The overview a plane that could not read its ledger is allowed to publish.
 *
 * `EMPTY` and `UNAVAILABLE` are different answers and must not be conflated: a
 * control plane with no events and a control plane that cannot open its ledger
 * look identical on anything that only counts rows, and they mean the opposite
 * thing. The notice states the closed reason and never the path.
 */
export function buildUnavailableOverview(notice: string, now: Clock): OverviewResponse {
  return OverviewResponse.parse({
    apiContractVersion: API_VERSION,
    ledgerContractVersion: LEDGER_VERSION,
    state: "UNAVAILABLE",
    observedAt: now(),
    database: null,
    ledger: null,
    integrity: { checked: false, ok: null, problemCount: null, checkedAt: null },
    tasks: { total: 0, terminal: 0, active: 0, byState: [] },
    workers: { total: 0, byRole: [] },
    capabilities: {
      readOnly: true,
      writes: false,
      routing: false,
      accounts: false,
      leases: false,
    },
    notice,
  });
}
