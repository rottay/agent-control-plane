import { MAX_DETAIL_TIMELINE_ITEMS, type TimelineItem } from "@acp/api-contracts";
import type { EventQuery, Ledger } from "@acp/ledger";

import { timelineItem } from "../mappers/index.js";

/**
 * Server-side aggregation over the ledger's cursor-paged read APIs.
 *
 * The ledger exposes pages, not counts or "most recent N" queries, so the
 * overview and detail routes assemble what they need by walking pages. This
 * is a deliberate P1 choice for a local, single-operator tool: a control plane
 * large enough for this to matter has outgrown a loopback SQLite file anyway.
 */

/** Ledger's own page ceiling, used to walk aggregates in as few round trips as possible. */
const AGGREGATE_PAGE_LIMIT = 1000;

export interface TaskCounts {
  readonly total: number;
  readonly terminal: number;
  readonly active: number;
  readonly byState: ReadonlyMap<string, number>;
}

export function countTasks(ledger: Ledger): TaskCounts {
  let total = 0;
  let terminal = 0;
  const byState = new Map<string, number>();
  let cursor: string | undefined;
  for (;;) {
    const page = ledger.listTasks({ afterTaskId: cursor, limit: AGGREGATE_PAGE_LIMIT });
    for (const task of page.tasks) {
      total += 1;
      if (task.isTerminal) terminal += 1;
      byState.set(task.currentState, (byState.get(task.currentState) ?? 0) + 1);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { total, terminal, active: total - terminal, byState };
}

export interface WorkerCounts {
  readonly total: number;
  readonly byRole: ReadonlyMap<string, number>;
}

export function countWorkers(ledger: Ledger): WorkerCounts {
  let total = 0;
  const byRole = new Map<string, number>();
  let cursor: string | undefined;
  for (;;) {
    const page = ledger.listWorkers({ afterIdentity: cursor, limit: AGGREGATE_PAGE_LIMIT });
    for (const worker of page.workers) {
      total += 1;
      byRole.set(worker.role, (byRole.get(worker.role) ?? 0) + 1);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { total, byRole };
}

/**
 * The most recent events matching a filter, newest first, bounded to the
 * contract's detail ceiling.
 *
 * There is no descending ledger query, so this walks forward in pages and
 * keeps a sliding window of the tail. Per-task and per-worker event counts are
 * small in practice; a control plane large enough to make this walk expensive
 * has outgrown a single loopback SQLite file.
 */
function recentEvents(
  ledger: Ledger,
  filter: Pick<EventQuery, "taskId" | "emittedBy">,
): TimelineItem[] {
  const window: TimelineItem[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = ledger.listEvents({
      ...filter,
      afterSequence: cursor,
      limit: AGGREGATE_PAGE_LIMIT,
    });
    for (const record of page.events) {
      window.push(timelineItem(record));
      if (window.length > MAX_DETAIL_TIMELINE_ITEMS) window.shift();
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return window.reverse();
}

export function recentEventsForTask(ledger: Ledger, taskId: string): TimelineItem[] {
  return recentEvents(ledger, { taskId });
}

export function recentEventsForWorker(ledger: Ledger, identity: string): TimelineItem[] {
  return recentEvents(ledger, { emittedBy: identity });
}
