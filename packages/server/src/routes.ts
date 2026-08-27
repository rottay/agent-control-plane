import {
  API_CONTRACT_VERSION,
  API_ROUTES,
  EventPageResponse,
  EventsQuery,
  HealthResponse,
  IntegrityResult,
  LEDGER_CONTRACT_VERSION,
  type LedgerDatabaseIdentity,
  LedgerStatusResponse,
  type ObservationCapabilities,
  OverviewResponse,
  TaskDetailResponse,
  TaskPageResponse,
  TasksQuery,
  WorkerDetailResponse,
  WorkerPageResponse,
  WorkersQuery,
} from "@acp/api-contracts";
import type { Ledger } from "@acp/ledger";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { countTasks, countWorkers, recentEventsForTask, recentEventsForWorker } from "./aggregates.js";
import { ApiRouteError, classifyUnexpectedError, sendApiError } from "./errors.js";
import type { LedgerSource } from "./ledger-source.js";
import { taskDetail, taskSummary, timelineItem, workerDetail, workerSummary } from "./mappers.js";
import { assertEmptyQuery, parseQuery, parseTaskIdParam } from "./query-schemas.js";

/**
 * Route registration for the P1 read-only observation surface.
 *
 * Every route here is `GET`. `registerGet` additionally answers every other
 * verb on the same path with `METHOD_NOT_ALLOWED`, so the allowed method set
 * is enforced per path rather than left to Fastify's default 404-for-unmatched
 * behaviour, which would answer a `POST` the same way as a route that does not
 * exist at all.
 */

const CAPABILITIES: ObservationCapabilities = Object.freeze({
  readOnly: true,
  writes: false,
  routing: false,
  accounts: false,
  leases: false,
});

const OTHER_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

function registerGet(
  app: FastifyInstance,
  path: string,
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown,
): void {
  app.get(path, guarded(handler));
  app.route({
    method: [...OTHER_METHODS],
    url: path,
    handler: (request, reply) => {
      sendApiError(
        reply,
        "METHOD_NOT_ALLOWED",
        "method " + request.method + " is not allowed on this route; only GET is",
      );
    },
  });
}

/**
 * Wrap a handler so a deliberately raised `ApiRouteError` and any unexpected
 * thrown value both end in the one error envelope, and nothing else does.
 */
function guarded(
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    try {
      const body = await handler(request, reply);
      reply.code(200).send(body);
    } catch (error: unknown) {
      if (error instanceof ApiRouteError) {
        sendApiError(reply, error.code, error.message, error.detail);
        return;
      }
      const classified = classifyUnexpectedError(error);
      sendApiError(reply, classified.code, classified.message);
    }
  };
}

function unavailableMessage(code: "LEDGER_UNAVAILABLE" | "CONTRACT_VERSION_MISMATCH"): string {
  return code === "LEDGER_UNAVAILABLE"
    ? "the configured ledger database is not currently available"
    : "the ledger database schema does not match this build's contract";
}

/** Narrow a `LedgerSource` to its open branch, or raise the classified failure. */
function requireOpen(source: LedgerSource): { ledger: Ledger; database: LedgerDatabaseIdentity } {
  if (source.kind === "unavailable") {
    throw new ApiRouteError(source.code, unavailableMessage(source.code), source.detail);
  }
  return source;
}

function queryOf(request: FastifyRequest): Record<string, unknown> {
  return request.query as Record<string, unknown>;
}

function paramsOf(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

export function registerRoutes(app: FastifyInstance, source: LedgerSource): void {
  registerGet(app, API_ROUTES.health, (request) => {
    assertEmptyQuery(queryOf(request));
    return buildHealth(source);
  });

  registerGet(app, API_ROUTES.overview, (request) => {
    assertEmptyQuery(queryOf(request));
    return buildOverview(source);
  });

  registerGet(app, API_ROUTES.status, (request) => {
    assertEmptyQuery(queryOf(request));
    return buildStatus(source);
  });

  registerGet(app, API_ROUTES.integrity, (request) => {
    assertEmptyQuery(queryOf(request));
    return buildIntegrity(source);
  });

  registerGet(app, API_ROUTES.tasks, (request) => {
    const query = parseQuery(TasksQuery, queryOf(request));
    const { ledger } = requireOpen(source);
    const page = ledger.listTasks({ state: query.state, afterTaskId: query.cursor, limit: query.limit });
    const items = page.tasks.map(taskSummary);
    return TaskPageResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items,
      page: {
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        limit: query.limit,
        returned: items.length,
      },
    });
  });

  registerGet(app, API_ROUTES.taskById, (request) => {
    assertEmptyQuery(queryOf(request));
    const taskId = parseTaskIdParam(paramsOf(request)["taskId"] ?? "");
    const { ledger } = requireOpen(source);
    const task = ledger.getTask(taskId);
    if (task === null) {
      throw new ApiRouteError("NOT_FOUND", "no task with that id was found");
    }
    const recentEvents = recentEventsForTask(ledger, task.taskId);
    return TaskDetailResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      task: taskDetail(task, recentEvents),
    });
  });

  registerGet(app, API_ROUTES.workers, (request) => {
    const query = parseQuery(WorkersQuery, queryOf(request));
    const { ledger } = requireOpen(source);
    const page = ledger.listWorkers({
      role: query.role,
      provider: query.provider,
      afterIdentity: query.cursor,
      limit: query.limit,
    });
    const items = page.workers.map(workerSummary);
    return WorkerPageResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items,
      page: {
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        limit: query.limit,
        returned: items.length,
      },
    });
  });

  registerGet(app, API_ROUTES.workerByIdentity, (request) => {
    assertEmptyQuery(queryOf(request));
    const raw = paramsOf(request)["identity"] ?? "";
    let identity: string;
    try {
      identity = decodeURIComponent(raw);
    } catch {
      throw new ApiRouteError("BAD_REQUEST", "the worker identity path segment is not validly percent-encoded");
    }
    const { ledger } = requireOpen(source);
    const worker = ledger.getWorker(identity);
    if (worker === null) {
      throw new ApiRouteError("NOT_FOUND", "no worker with that identity was found");
    }
    const recentEvents = recentEventsForWorker(ledger, worker.identity);
    return WorkerDetailResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      worker: workerDetail(worker, recentEvents),
    });
  });

  registerGet(app, API_ROUTES.events, (request) => {
    const query = parseQuery(EventsQuery, queryOf(request));
    const { ledger } = requireOpen(source);
    const page = ledger.listEvents({
      taskId: query.taskId,
      type: query.type,
      emittedBy: query.emittedBy,
      toState: query.toState,
      afterSequence: query.cursor,
      limit: query.limit,
    });
    const items = page.events.map((record) => timelineItem(record));
    return EventPageResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items,
      page: {
        nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
        hasMore: page.hasMore,
        limit: query.limit,
        returned: items.length,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    sendApiError(reply, "NOT_FOUND", "no route matches " + request.method + " " + request.url);
  });
}

function buildHealth(source: LedgerSource) {
  const observedAt = new Date().toISOString();
  if (source.kind === "unavailable") {
    return HealthResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      status: "UNAVAILABLE",
      readOnly: true,
      observedAt,
      database: null,
      detail: source.detail,
    });
  }
  try {
    source.ledger.status();
  } catch {
    return HealthResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      status: "DEGRADED",
      readOnly: true,
      observedAt,
      database: source.database,
      detail: "the ledger is open but a status read failed",
    });
  }
  return HealthResponse.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    status: "OK",
    readOnly: true,
    observedAt,
    database: source.database,
    detail: null,
  });
}

function emptyOverview(
  state: "UNAVAILABLE",
  observedAt: string,
  notice: string,
) {
  return OverviewResponse.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    state,
    observedAt,
    database: null,
    ledger: null,
    integrity: { checked: false, ok: null, problemCount: null, checkedAt: null },
    tasks: { total: 0, terminal: 0, active: 0, byState: [] },
    workers: { total: 0, byRole: [] },
    capabilities: CAPABILITIES,
    notice,
  });
}

function buildOverview(source: LedgerSource) {
  const observedAt = new Date().toISOString();
  if (source.kind === "unavailable") {
    return emptyOverview("UNAVAILABLE", observedAt, source.detail);
  }

  let status;
  try {
    status = source.ledger.status();
  } catch {
    return emptyOverview("UNAVAILABLE", observedAt, "the ledger is open but a status read failed");
  }

  const taskCounts = countTasks(source.ledger);
  const workerCounts = countWorkers(source.ledger);

  let lastEventAt: string | null = null;
  if (status.headSequence > 0) {
    const head = source.ledger.getEventBySequence(status.headSequence);
    lastEventAt = head === null ? null : head.event.recordedAt;
  }

  return OverviewResponse.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    state: status.eventCount === 0 ? "EMPTY" : "ACTIVE",
    observedAt,
    database: source.database,
    ledger: {
      eventCount: status.eventCount,
      headSequence: status.headSequence,
      headEventSha256: status.headEventSha256,
      lastEventAt,
    },
    integrity: { checked: false, ok: null, problemCount: null, checkedAt: null },
    tasks: {
      total: taskCounts.total,
      terminal: taskCounts.terminal,
      active: taskCounts.active,
      byState: [...taskCounts.byState].map(([state, count]) => ({ state, count })),
    },
    workers: {
      total: workerCounts.total,
      byRole: [...workerCounts.byRole].map(([role, count]) => ({ role, count })),
    },
    capabilities: CAPABILITIES,
    notice: null,
  });
}

function buildStatus(source: LedgerSource) {
  const { ledger, database } = requireOpen(source);
  const status = ledger.status();
  return LedgerStatusResponse.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    database,
    readOnly: status.readOnly,
    headSequence: status.headSequence,
    headEventSha256: status.headEventSha256,
    eventCount: status.eventCount,
    pragmas: status.pragmas,
    migrations: status.migrations,
    projections: status.projections,
    observedAt: new Date().toISOString(),
  });
}

function buildIntegrity(source: LedgerSource) {
  const { ledger } = requireOpen(source);
  const report = ledger.verifyIntegrity();
  const problems = report.problems.slice(0, 500);
  return IntegrityResult.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    ok: report.ok,
    checkedEvents: report.checkedEvents,
    headSequence: report.headSequence,
    headEventSha256: report.headEventSha256,
    problems: problems.map((problem) => ({
      kind: problem.kind,
      detail: problem.detail,
      sequence: problem.sequence,
    })),
    truncated: report.problems.length > problems.length,
    checkedAt: new Date().toISOString(),
  });
}
