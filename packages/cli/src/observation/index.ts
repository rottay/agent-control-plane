/**
 * The observation layer: ledger read models in, validated DTOs out.
 *
 * Everything the CLI prints is produced here and passed through the schemas of
 * `@acp/api-contracts` before it reaches a formatter. That is not belt and
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
  OverviewResponse,
  TaskDetailResponse,
  TaskPageResponse,
  TimelineItem,
  WorkerDetailResponse,
  WorkerPageResponse,
} from "@acp/api-contracts";
import { canonicalRows } from "@acp/api-contracts";
import type { ApiRouteName, OverviewState } from "@acp/api-contracts";
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
 * Ceiling on the payload key names a single timeline item may carry.
 *
 * The contract caps the array at sixty four names. An event payload is capped
 * by bytes rather than by key count, so a pathological payload of very short
 * keys can exceed it. Such an item is rendered with its first sixty four key
 * names in sort order, and the byte size, which is exact, is what tells a reader
 * the item was larger than the name list suggests.
 */
const MAX_TIMELINE_PAYLOAD_KEYS = 64;

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
 * Thin on purpose. The row model is defined once, in `@acp/api-contracts`, and
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

function payloadKeys(payload: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(payload).sort().slice(0, MAX_TIMELINE_PAYLOAD_KEYS);
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
      appliedThroughSequence: projection.appliedThroughSequence,
      eventCount: projection.eventCount,
      sourceHeadSha256: projection.sourceHeadSha256,
      updatedAt: projection.updatedAt,
      rowCount: projection.rowCount,
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
