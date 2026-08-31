import {
  API_CONTRACT_VERSION,
  API_ROUTES,
  EventPageResponse,
  EventsQuery,
  HealthResponse,
  InitiativeDetailResponse,
  InitiativePortfolioResponse,
  InitiativeRoadmapResponse,
  AccountActionRequest,
  AccountActionWriteResponse,
  AccountActionsResponse,
  AccountsResponse,
  InitiativeAgentsResponse,
  InitiativeTimelineResponse,
  MAX_SCOPED_AGENTS,
  MAX_SCOPED_TIMELINE_ITEMS,
  RoadmapContentQuery,
  RoadmapContentResponse,
  RoadmapVersionWriteRequest,
  RoadmapVersionWriteResponse,
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

import { randomUUID } from "node:crypto";

import { countTasks, countWorkers, recentEventsForTask, recentEventsForWorker } from "../aggregates/index.js";
import { ApiRouteError, classifyUnexpectedError, sendApiError } from "../errors/index.js";
import type { LedgerSource } from "../ledger-source/index.js";
import {
  initiativeDetail,
  portfolio,
  roadmapContent,
  roadmapHistory,
  scopedAgents,
  scopedTimeline,
} from "../initiatives/index.js";
import { readAccounts } from "../accounts/index.js";
import { recordAccountAction } from "../account-actions/index.js";
import { loadBearerGuard } from "../bearer/index.js";
import type { BearerLoadOutcome } from "../bearer/index.js";
import { artifactRootFor, recordRoadmapVersion } from "../roadmap-write/index.js";
import {
  initiativeDetailDto,
  initiativeSummary,
  roadmapVersion,
  taskDetail,
  taskSummary,
  timelineItem,
  workerDetail,
  workerSummary,
} from "../mappers/index.js";
import { assertEmptyQuery, parseQuery, parseTaskIdParam } from "../query-schemas/index.js";

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

/**
 * The methods a **write** route refuses. (C1.)
 *
 * `OTHER_METHODS` above stays exactly as it was, because every read route's
 * 405 set must be byte-unchanged; the write route needs its own list with
 * `POST` removed, since POST is now answered rather than refused there.
 */
const OTHER_METHODS_ON_WRITE = ["PUT", "PATCH", "DELETE"] as const;

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

const UUID_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate an initiative id from the path.
 *
 * Checked here rather than in `query-schemas` because this packet does not own
 * that module, and a validator is cheap to state twice while a widened
 * write-set is not. The refusal is the same classified `BAD_REQUEST` the task
 * id parser raises, so a caller sees one shape of error for one class of
 * mistake.
 */
/**
 * An account id is the operator's own label, not a uuid, so it is bounded and
 * pattern-checked. The pattern refuses path separators and traversal segments,
 * which is the property the uuid check buys for the initiative routes.
 */
const ACCOUNT_ID_PARAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function parseAccountIdParam(raw: string): string {
  if (!ACCOUNT_ID_PARAM.test(raw)) {
    throw new ApiRouteError("BAD_REQUEST", "accountId must be an account label");
  }
  return raw;
}

function parseInitiativeIdParam(raw: string): string {
  if (!UUID_PARAM.test(raw)) {
    throw new ApiRouteError("BAD_REQUEST", "initiativeId must be a UUID");
  }
  return raw;
}

/**
 * Register a route that answers GET **and** POST.
 *
 * Written as its own registrar rather than as `registerGet` plus an
 * `app.post`: `registerGet` mounts `[POST, PUT, PATCH, DELETE]` as one 405
 * catch-all on the same URL, so adding a POST beside it is a duplicate-route
 * error at boot — Fastify refuses the second registration for a method it has
 * already seen on that path, and the server would not start at all. The two
 * registrars therefore differ in exactly one thing: which methods fall through
 * to the 405, and every read route keeps the four-method set unchanged.
 */
/** One request header, lower-cased by Fastify, or undefined. */
function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Register a route that reads on GET and writes on POST.
 *
 * **The bearer guard lives here, not in the handler (P8-8G).** Structural
 * rather than remembered: every write on this plane is registered through this
 * one function, so a future write route is guarded by where it is registered
 * and a contributor has nowhere to forget the check from. The GET half is
 * deliberately *not* guarded — observation is free on this plane, and the
 * asymmetry is the design rather than an oversight.
 */
function registerGetAndPost(
  app: FastifyInstance,
  path: string,
  getHandler: (request: FastifyRequest, reply: FastifyReply) => unknown,
  postHandler: (request: FastifyRequest, reply: FastifyReply) => unknown,
  bearer: BearerLoadOutcome,
): void {
  app.get(path, guarded(getHandler));
  app.post(
    path,
    guarded((request, reply) => {
      // Fail-closed: no token file configured means no write proceeds, and the
      // 403 says whose problem it is. A caller cannot fix this with a better
      // header, so answering 401 would send it round a loop that cannot end.
      if (!bearer.ok) {
        throw new ApiRouteError(
          "WRITE_BEARER_UNCONFIGURED",
          "this server was started without a write bearer token, so no write can be authorized",
        );
      }
      // Missing and wrong are one answer on purpose: telling them apart would
      // confirm to an unauthenticated caller that a header it guessed had the
      // right shape.
      if (!bearer.guard.accepts(headerOf(request, "authorization"))) {
        throw new ApiRouteError("AUTH_REQUIRED", "a valid Bearer credential is required to write");
      }
      return postHandler(request, reply);
    }),
  );
  app.route({
    method: [...OTHER_METHODS_ON_WRITE],
    url: path,
    handler: (request, reply) => {
      sendApiError(
        reply,
        "METHOD_NOT_ALLOWED",
        "method " + request.method + " is not allowed on this route; only GET and POST are",
      );
    },
  });
}

export function registerRoutes(
  app: FastifyInstance,
  source: LedgerSource,
  accountsFilePath?: string,
  writeBearerPath?: string,
): void {
  // Loaded once, at registration. A token re-read per request would let a
  // file edited mid-flight change the answer between two writes of the same
  // batch; loading here means the process authorizes against the credential
  // it started with, and a rotation is a restart.
  const bearer = loadBearerGuard(writeBearerPath);

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
  // -------------------------------------------------------------------------
  // P8-8A: the initiative data plane. Read-only, like every route above it.
  // -------------------------------------------------------------------------

  registerGet(app, API_ROUTES.initiatives, (request) => {
    assertEmptyQuery(queryOf(request));
    const { ledger } = requireOpen(source);
    const items = portfolio(ledger).map(initiativeSummary);
    return InitiativePortfolioResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items,
      count: items.length,
    });
  });

  registerGet(app, API_ROUTES.initiativeById, (request) => {
    assertEmptyQuery(queryOf(request));
    const initiativeId = parseInitiativeIdParam(paramsOf(request)["initiativeId"] ?? "");
    const { ledger } = requireOpen(source);
    const model = initiativeDetail(ledger, initiativeId);
    if (model === null) {
      throw new ApiRouteError("NOT_FOUND", "no initiative with that id was found");
    }
    return InitiativeDetailResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiative: initiativeDetailDto(model),
    });
  });

  // The stored document itself. A read, through `registerGet` like every
  // other read — the GET-only law is untouched, and the write surface stays at
  // exactly one route.
  registerGet(app, API_ROUTES.initiativeRoadmapContent, (request) => {
    const query = parseQuery(RoadmapContentQuery, queryOf(request));
    const initiativeId = parseInitiativeIdParam(paramsOf(request)["initiativeId"] ?? "");
    const { ledger } = requireOpen(source);

    if (ledger.getInitiative(initiativeId) === null) {
      throw new ApiRouteError("NOT_FOUND", "no initiative with that id was found");
    }

    const outcome = roadmapContent(
      ledger,
      initiativeId,
      query.version,
      artifactRootFor(ledger.path),
    );

    if (!outcome.ok) {
      // Two absences, answered differently on purpose. A version that was
      // never recorded is the caller's mistake — 404. A version whose bytes
      // the store cannot produce is the ledger and the store disagreeing,
      // which is an integrity failure and is never a quiet empty body.
      if (outcome.reason === "UNKNOWN_VERSION") {
        throw new ApiRouteError("NOT_FOUND", "no roadmap version with that number was found");
      }
      throw new ApiRouteError(
        "LEDGER_INTEGRITY",
        "the recorded roadmap content could not be read from the artifact store",
        outcome.reason,
      );
    }

    return RoadmapContentResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId,
      version: outcome.version.version,
      contentDigest: outcome.version.contentDigest,
      kind: outcome.version.kind,
      content: outcome.content,
    });
  });

  // The merged timeline (C2). A read, through `registerGet`.
  registerGet(app, API_ROUTES.initiativeEvents, (request) => {
    assertEmptyQuery(queryOf(request));
    const initiativeId = parseInitiativeIdParam(paramsOf(request)["initiativeId"] ?? "");
    const { ledger } = requireOpen(source);

    const model = scopedTimeline(ledger, initiativeId, MAX_SCOPED_TIMELINE_ITEMS);
    if (model === null) {
      throw new ApiRouteError("NOT_FOUND", "no initiative with that id was found");
    }

    return InitiativeTimelineResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId,
      items: model.rows.map((row) =>
        row.stream === "TASK"
          ? {
              stream: "TASK",
              sequence: row.record.sequence,
              eventId: row.record.eventId,
              taskId: row.record.event.taskId,
              type: row.record.event.type,
              fromState: row.record.event.fromState,
              toState: row.record.event.toState,
              emittedBy: row.record.event.emittedBy,
              occurredAt: row.record.event.occurredAt,
              recordedAt: row.record.event.recordedAt,
              correlationId: row.record.event.correlationId,
              causationId: row.record.event.causationId,
            }
          : {
              stream: "INITIATIVE",
              sequence: row.record.sequence,
              eventId: row.record.eventId,
              initiativeId: row.record.event.initiativeId,
              type: row.record.event.type,
              fromStatus: row.record.event.fromStatus,
              toStatus: row.record.event.toStatus,
              emittedBy: row.record.event.emittedBy,
              occurredAt: row.record.event.occurredAt,
              recordedAt: row.record.event.recordedAt,
            },
      ),
      count: model.rows.length,
      truncated: model.truncated,
    });
  });

  // The scoped workers (C3). A read, through `registerGet`.
  registerGet(app, API_ROUTES.initiativeAgents, (request) => {
    assertEmptyQuery(queryOf(request));
    const initiativeId = parseInitiativeIdParam(paramsOf(request)["initiativeId"] ?? "");
    const { ledger } = requireOpen(source);

    const rows = scopedAgents(ledger, initiativeId, MAX_SCOPED_AGENTS);
    if (rows === null) {
      throw new ApiRouteError("NOT_FOUND", "no initiative with that id was found");
    }

    return InitiativeAgentsResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId,
      // The identity's parts come from the projection the ledger already keeps;
      // every count and instant beside them is the scoped fold's own.
      items: rows.map((row) => {
        const worker = ledger.getWorker(row.identity);
        if (worker === null) {
          throw new ApiRouteError(
            "LEDGER_INTEGRITY",
            "an identity that emitted a recorded event is absent from the worker projection",
            row.identity,
          );
        }
        return {
          identity: row.identity,
          provider: worker.provider,
          model: worker.model,
          role: worker.role,
          instance: worker.instance,
          eventCount: row.eventCount,
          taskCount: row.taskCount,
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt,
          currentTaskId: row.currentTaskId,
          lastEventType: row.lastEventType,
        };
      }),
      count: rows.length,
    });
  });

  // The owner's accounts (P8-8F). A read, through `registerGet` like every
  // other read — the GET-only law and every 405 set stay byte-unchanged, and
  // the write surface stays at exactly one route.
  //
  // The instant is taken once, here, and injected: the read model never reads a
  // clock, so this handler is the single place where "now" enters, and two
  // requests at the same instant over the same file produce identical bytes.
  registerGet(app, API_ROUTES.accounts, (request) => {
    assertEmptyQuery(queryOf(request));
    // The action history is handed in, so the read model folds the authority
    // overlay with the same function the write seam decides against — one
    // implementation of the law, so the two cannot disagree about which
    // source governs.
    const { ledger: openLedgerForActions } = requireOpen(source);
    const outcome = readAccounts(accountsFilePath, new Date().toISOString(), (accountId) =>
      openLedgerForActions.listAccountActions(accountId),
    );

    if (!outcome.ok) {
      // A 200, deliberately. A missing owner file is not this endpoint
      // failing — it is the plane's honest state, and the commonest one on a
      // fresh machine. The union says so in the body rather than in a status
      // code that would claim the server broke.
      return AccountsResponse.parse({
        status: "UNAVAILABLE",
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        reason: outcome.reason,
        detail: outcome.detail,
      });
    }

    return AccountsResponse.parse({
      status: "READY",
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items: outcome.items,
      count: outcome.items.length,
      estimatedAt: outcome.estimatedAt,
    });
  });

  // The second write door (P8-8G packet 2). Registered through the same
  // guarded registrar as the first, so the bearer is inherited by *where this
  // is written* rather than by anyone remembering to add a check — which is
  // the property packet 1 built the registrar to have.
  registerGetAndPost(
    app,
    API_ROUTES.accountActions,
    (request) => {
      assertEmptyQuery(queryOf(request));
      const accountId = parseAccountIdParam(paramsOf(request)["accountId"] ?? "");
      const { ledger } = requireOpen(source);

      const items = ledger.listAccountActions(accountId).map((row) => ({
        sequence: row.sequence,
        eventId: row.eventId,
        accountId: row.event.accountId,
        version: row.event.version,
        action: row.event.action,
        resultingState: row.event.resultingState,
        actor: row.event.actor,
        note: row.event.note,
        recordedAt: row.event.recordedAt,
      }));

      return AccountActionsResponse.parse({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        accountId,
        items,
        count: items.length,
      });
    },
    (request) => {
      const accountId = parseAccountIdParam(paramsOf(request)["accountId"] ?? "");
      const parsedBody = AccountActionRequest.safeParse(request.body);
      if (!parsedBody.success) {
        const issue = parsedBody.error.issues[0];
        throw new ApiRouteError(
          "BAD_REQUEST",
          "the account action request did not satisfy the contract",
          // The failing field, never its value — the note is free text.
          (issue?.path ?? []).map((segment) => String(segment)).join(".") || "(root)",
        );
      }
      const body = parsedBody.data;
      const { ledger } = requireOpen(source);

      const outcome = recordAccountAction({
        ledger,
        accountsFilePath,
        accountId,
        request: body,
        recordedAt: new Date().toISOString(),
        eventId: randomUUID(),
      });

      if (!outcome.ok) {
        // Every refusal is a 409 carrying its own name, exactly as the first
        // door does: the caller sent something coherent that the recorded
        // state refuses, and the name is what tells it which.
        throw new ApiRouteError(
          "WRITE_REFUSED",
          "the account action was refused: " + outcome.reason,
          outcome.at,
        );
      }

      return AccountActionWriteResponse.parse({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        action: {
          sequence: outcome.record.sequence,
          eventId: outcome.record.eventId,
          accountId: outcome.record.event.accountId,
          version: outcome.record.event.version,
          action: outcome.record.event.action,
          resultingState: outcome.record.event.resultingState,
          actor: outcome.record.event.actor,
          note: outcome.record.event.note,
          recordedAt: outcome.record.event.recordedAt,
        },
      });
    },
    bearer,
  );

  // The one write route. GET is unchanged; POST is the plane's first write.
  registerGetAndPost(
    app,
    API_ROUTES.initiativeRoadmap,
    (request) => {
      assertEmptyQuery(queryOf(request));
      const initiativeId = parseInitiativeIdParam(paramsOf(request)["initiativeId"] ?? "");
      const { ledger } = requireOpen(source);
      // The initiative must exist before its history can be empty: a 200 with no
      // versions for an id the ledger has never seen would say "this initiative
      // has no roadmap" about something that does not exist.
      if (ledger.getInitiative(initiativeId) === null) {
        throw new ApiRouteError("NOT_FOUND", "no initiative with that id was found");
      }
      const items = roadmapHistory(ledger, initiativeId).map((entry) =>
        roadmapVersion(entry.version, entry.head),
      );
      return InitiativeRoadmapResponse.parse({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        initiativeId,
        items,
        count: items.length,
      });
    },
    (request) => {
      assertEmptyQuery(queryOf(request));
      const initiativeId = parseInitiativeIdParam(paramsOf(request)["initiativeId"] ?? "");
      const { ledger } = requireOpen(source);

      // An initiative that does not exist cannot have a roadmap recorded
      // against it, and saying so is a 404 rather than a refusal: the
      // request is not in conflict with anything, it names nothing.
      if (ledger.getInitiative(initiativeId) === null) {
        throw new ApiRouteError("NOT_FOUND", "no initiative with that id was found");
      }

      // Door one: the schema. A body this fails is malformed, and malformed
      // is the caller's typing rather than the caller's timing — 400.
      const parsed = RoadmapVersionWriteRequest.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiRouteError(
          "BAD_REQUEST",
          "the roadmap version request did not satisfy the contract",
          // The failing field, never its value: the body is the one place
          // free text enters this plane.
          (issue?.path ?? []).map((segment) => String(segment)).join(".") || "(root)",
        );
      }

      const outcome = recordRoadmapVersion({
        ledger,
        initiativeId,
        request: parsed.data,
        // Injected at the seam rather than read inside it: the write module
        // builds the same envelope from the same inputs on every run.
        recordedAt: new Date().toISOString(),
        roadmapVersionId: randomUUID(),
        eventId: randomUUID(),
      });

      // Door two: the decision. A well-formed request it refuses conflicts
      // with the recorded state — 409, carrying the refusal's own name, so
      // a caller can tell a lost race from a bad request and retry the one
      // that is worth retrying.
      if (!outcome.ok) {
        throw new ApiRouteError(
          "WRITE_REFUSED",
          "the roadmap version was refused: " + outcome.reason,
          outcome.at,
        );
      }

      return RoadmapVersionWriteResponse.parse({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        // Field by field, and `head` supplied here: a recorded version is by
        // definition the newest, so it is the head of the history a reader
        // will fetch next.
        version: {
          roadmapVersionId: outcome.version.roadmapVersionId,
          initiativeId: outcome.version.initiativeId,
          version: outcome.version.version,
          contentDigest: outcome.version.contentDigest,
          parentVersionId: outcome.version.parentVersionId,
          kind: outcome.version.kind,
          restoresVersionId: outcome.version.restoresVersionId,
          recordedBy: outcome.version.recordedBy,
          recordedAt: outcome.version.recordedAt,
          sequence: outcome.sequence,
          head: true,
        },
        sequence: outcome.sequence,
      });
    },
    bearer,
  );
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
      // Sorted, not insertion-ordered. `Map` order here is a function of the
      // ledger walk — page size, cursor order, which key appeared first — so it
      // is declared nowhere and can change when unrelated data changes. The CLI
      // has always sorted these alphabetically; ordering is part of the parity
      // law, so the server converges onto that existing deterministic order
      // rather than onto a third one.
      byState: [...taskCounts.byState]
        .map(([state, count]) => ({ state, count }))
        .sort((left, right) => (left.state < right.state ? -1 : left.state > right.state ? 1 : 0)),
    },
    workers: {
      total: workerCounts.total,
      byRole: [...workerCounts.byRole]
        .map(([role, count]) => ({ role, count }))
        .sort((left, right) => (left.role < right.role ? -1 : left.role > right.role ? 1 : 0)),
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
