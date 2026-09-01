import {
  API_ROUTES,
  ApiError,
  AccountActionWriteResponse,
  AccountsResponse,
  EventPageResponse,
  InitiativeAgentsResponse,
  InitiativeDetailResponse,
  InitiativePortfolioResponse,
  InitiativeRoadmapResponse,
  InitiativeTimelineResponse,
  IntegrityResult,
  LedgerStatusResponse,
  OverviewResponse,
  RoadmapContentResponse,
  RoadmapVersionWriteResponse,
  TaskDetailResponse,
  TaskPageResponse,
  WorkerDetailResponse,
  WorkerPageResponse,
  accountActionsPath,
  initiativeAgentsPath,
  initiativeEventsPath,
  initiativePath,
  initiativeRoadmapContentPath,
  initiativeRoadmapPath,
  taskPath,
  workerPath,
  type AccountActionDto,
  type AccountStatusDto,
  type ApiErrorCode,
} from "@acp/api-contracts";

import { buildPath } from "../query-string/index.js";
import { canonicalRows } from "@acp/api-contracts";
import type { ApiRouteName } from "@acp/api-contracts";

/**
 * The read-only API client.
 *
 * Every response, success or failure, is parsed through the contract package
 * before this module hands it to a view. A response that does not satisfy the
 * contract is reported as `contract-mismatch`, never coerced or partially
 * trusted: requirement 7 of the UI packet makes a contract mismatch a first
 * class degraded state, not a thrown exception a view has to guess about.
 */

/** Structural shape shared by every schema this client parses with. */
interface Parsable<T> {
  safeParse(value: unknown): SafeParse<T>;
}
type SafeParse<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: readonly { message: string; path: readonly PropertyKey[] }[] } };

export type ApiResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "api-error"; status: number; code: ApiErrorCode; message: string; detail: string | null }
  | { kind: "contract-mismatch"; status: number | null; detail: string }
  | { kind: "network-error"; detail: string };

/**
 * The write surface's credential (P8-8G packet 3).
 *
 * Held in module scope, in memory only — never `localStorage`, never
 * `sessionStorage`, never a query parameter. That makes it session-only for
 * free: a reload re-evaluates this module and the variable starts back at
 * `null`, with nothing anywhere to read it back from. `App` (the app root)
 * owns the only `useState` that changes it; this module is the one place the
 * write calls below read it from, so a component several layers removed from
 * the root (the roadmap edit dialog, reached through an unrelated view) never
 * needs the value threaded through its own props to send the header.
 */
let sessionBearerToken: string | null = null;

export function setSessionBearerToken(token: string | null): void {
  sessionBearerToken = token;
}

export function getSessionBearerToken(): string | null {
  return sessionBearerToken;
}

function writeHeaders(): HeadersInit {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (sessionBearerToken !== null) {
    headers["authorization"] = "Bearer " + sessionBearerToken;
  }
  return headers;
}

function describeIssues(issues: readonly { message: string; path: readonly PropertyKey[] }[]): string {
  const first = issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return path + ": " + issue.message;
  });
  const suffix = issues.length > 3 ? " (+" + String(issues.length - 3) + " more)" : "";
  return first.join("; ") + suffix;
}

function describeThrown(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return "the request was cancelled";
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return "the request failed for an unknown reason";
}

async function fetchAndParse<T>(
  path: string,
  schema: Parsable<T>,
  signal: AbortSignal | undefined,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: signal ?? null,
    });
  } catch (cause) {
    return { kind: "network-error", detail: describeThrown(cause) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: "contract-mismatch",
      status: response.status,
      detail: "the response body was not valid JSON",
    };
  }

  if (!response.ok) {
    const errorEnvelope = ApiError.safeParse(body);
    if (errorEnvelope.success) {
      return {
        kind: "api-error",
        status: response.status,
        code: errorEnvelope.data.error.code,
        message: errorEnvelope.data.error.message,
        detail: errorEnvelope.data.error.detail,
      };
    }
    return {
      kind: "contract-mismatch",
      status: response.status,
      detail: "an error response did not match the API error contract: " + describeIssues(errorEnvelope.error.issues),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      kind: "contract-mismatch",
      status: response.status,
      detail: describeIssues(parsed.error.issues),
    };
  }
  return { kind: "ok", data: parsed.data };
}

/**
 * Every write this client makes goes through here. (P8-8D; P8-8G packet 3
 * adds the second door.)
 *
 * The request body is not validated here before it travels: the server's own
 * schema is the one authority on what it accepts, and a client-side copy of
 * that judgment is a second place it could drift from the server's. A
 * malformed body comes back as the same classified `api-error` a caller of
 * this module already knows how to read — the schema door and the decision
 * door are both just shapes of the response, not a second code path here.
 *
 * `writeHeaders` attaches `Authorization: Bearer <token>` when a token is
 * armed, and nothing when it is not — the request goes out either way, since
 * unarmed is this door's own first-class state (`WRITE_BEARER_UNCONFIGURED`
 * or `AUTH_REQUIRED`), never something this client pre-empts by refusing to
 * ask.
 */
async function postAndParse<T>(
  path: string,
  body: unknown,
  schema: Parsable<T>,
  signal: AbortSignal | undefined,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
  } catch (cause) {
    return { kind: "network-error", detail: describeThrown(cause) };
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    return {
      kind: "contract-mismatch",
      status: response.status,
      detail: "the response body was not valid JSON",
    };
  }

  if (!response.ok) {
    const errorEnvelope = ApiError.safeParse(responseBody);
    if (errorEnvelope.success) {
      return {
        kind: "api-error",
        status: response.status,
        code: errorEnvelope.data.error.code,
        message: errorEnvelope.data.error.message,
        detail: errorEnvelope.data.error.detail,
      };
    }
    return {
      kind: "contract-mismatch",
      status: response.status,
      detail: "an error response did not match the API error contract: " + describeIssues(errorEnvelope.error.issues),
    };
  }

  const parsed = schema.safeParse(responseBody);
  if (!parsed.success) {
    return {
      kind: "contract-mismatch",
      status: response.status,
      detail: describeIssues(parsed.error.issues),
    };
  }
  return { kind: "ok", data: parsed.data };
}

/**
 * The UI's adapter into the shared canonical row model (P3D).
 *
 * Takes an already-parsed response — the value a view would render — and
 * projects it through the one row model defined in `@acp/api-contracts`. It
 * deliberately does no fetching: parity is a claim about what the UI shows for
 * a given body, and the transport is proven elsewhere. Keeping it pure is also
 * what lets a Node test import this module at all.
 */
export function uiRowModel(route: ApiRouteName, response: unknown): unknown {
  return canonicalRows(route, response);
}

export interface TasksFilters {
  readonly state?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface WorkersFilters {
  readonly role?: string | undefined;
  readonly provider?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface EventsFilters {
  readonly taskId?: string | undefined;
  readonly type?: string | undefined;
  readonly emittedBy?: string | undefined;
  readonly toState?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export function fetchOverview(signal?: AbortSignal): Promise<ApiResult<OverviewResponse>> {
  return fetchAndParse(API_ROUTES.overview, OverviewResponse, signal);
}

export function fetchStatus(signal?: AbortSignal): Promise<ApiResult<LedgerStatusResponse>> {
  return fetchAndParse(API_ROUTES.status, LedgerStatusResponse, signal);
}

export function fetchIntegrity(signal?: AbortSignal): Promise<ApiResult<IntegrityResult>> {
  return fetchAndParse(API_ROUTES.integrity, IntegrityResult, signal);
}

export function fetchTasks(
  filters: TasksFilters,
  signal?: AbortSignal,
): Promise<ApiResult<TaskPageResponse>> {
  const path = buildPath(API_ROUTES.tasks, { ...filters });
  return fetchAndParse(path, TaskPageResponse, signal);
}

export function fetchTaskDetail(
  taskId: string,
  signal?: AbortSignal,
): Promise<ApiResult<TaskDetailResponse>> {
  let path: string;
  try {
    path = taskPath(taskId);
  } catch {
    return Promise.resolve({
      kind: "contract-mismatch",
      status: null,
      detail: "\"" + taskId + "\" is not a well formed task id",
    });
  }
  return fetchAndParse(path, TaskDetailResponse, signal);
}

export function fetchWorkers(
  filters: WorkersFilters,
  signal?: AbortSignal,
): Promise<ApiResult<WorkerPageResponse>> {
  const path = buildPath(API_ROUTES.workers, { ...filters });
  return fetchAndParse(path, WorkerPageResponse, signal);
}

export function fetchWorkerDetail(
  identity: string,
  signal?: AbortSignal,
): Promise<ApiResult<WorkerDetailResponse>> {
  let path: string;
  try {
    path = workerPath(identity);
  } catch {
    return Promise.resolve({
      kind: "contract-mismatch",
      status: null,
      detail: "\"" + identity + "\" is not a well formed worker identity",
    });
  }
  return fetchAndParse(path, WorkerDetailResponse, signal);
}

export function fetchEvents(
  filters: EventsFilters,
  signal?: AbortSignal,
): Promise<ApiResult<EventPageResponse>> {
  const path = buildPath(API_ROUTES.events, { ...filters });
  return fetchAndParse(path, EventPageResponse, signal);
}

// ---------------------------------------------------------------------------
// Initiatives (P8-8C)
// ---------------------------------------------------------------------------

export function fetchInitiatives(signal?: AbortSignal): Promise<ApiResult<InitiativePortfolioResponse>> {
  return fetchAndParse(API_ROUTES.initiatives, InitiativePortfolioResponse, signal);
}

export function fetchInitiativeDetail(
  initiativeId: string,
  signal?: AbortSignal,
): Promise<ApiResult<InitiativeDetailResponse>> {
  let path: string;
  try {
    path = initiativePath(initiativeId);
  } catch {
    return Promise.resolve({
      kind: "contract-mismatch",
      status: null,
      detail: "\"" + initiativeId + "\" is not a well formed initiative id",
    });
  }
  return fetchAndParse(path, InitiativeDetailResponse, signal);
}

export function fetchInitiativeRoadmap(
  initiativeId: string,
  signal?: AbortSignal,
): Promise<ApiResult<InitiativeRoadmapResponse>> {
  let path: string;
  try {
    path = initiativeRoadmapPath(initiativeId);
  } catch {
    return Promise.resolve({
      kind: "contract-mismatch",
      status: null,
      detail: "\"" + initiativeId + "\" is not a well formed initiative id",
    });
  }
  return fetchAndParse(path, InitiativeRoadmapResponse, signal);
}

/**
 * The stored roadmap document for one version. (P8-8D-c2's read, this
 * client's home for it.)
 *
 * Selected by version number, never by digest: the digest-addressed store is
 * initiative-agnostic, and a version selector is what makes the fold do the
 * authorization the store itself does not — see the server's own account of
 * this in `.acp-local/p8-8d-c2-opus-source-ready.md`.
 */
export function fetchRoadmapContent(
  initiativeId: string,
  version: number,
  signal?: AbortSignal,
): Promise<ApiResult<RoadmapContentResponse>> {
  let path: string;
  try {
    path = buildPath(initiativeRoadmapContentPath(initiativeId), { version });
  } catch {
    return Promise.resolve({
      kind: "contract-mismatch",
      status: null,
      detail: "\"" + initiativeId + "\" is not a well formed initiative id",
    });
  }
  return fetchAndParse(path, RoadmapContentResponse, signal);
}

export interface RoadmapVersionWriteInput {
  readonly content: string;
  readonly expectedHeadDigest: string | null;
  readonly kind: "EDIT" | "ROLLBACK";
  readonly restoresVersionId: string | null;
  readonly recordedBy: string;
}

/**
 * Record one roadmap version. (P8-8D-pre's write, this client's home for
 * it.)
 *
 * The one POST this client ever issues. Its request body is not typed
 * through `RoadmapVersionWriteRequest` here — the type is restated field by
 * field in `RoadmapVersionWriteInput` above, the same reason `mappers`
 * already gives elsewhere in this codebase for not spreading a contract type
 * across a boundary: it keeps this function's own signature the single
 * source of what a caller must supply, rather than a schema import a caller
 * would have to go read to know.
 */
export function writeRoadmapVersion(
  initiativeId: string,
  input: RoadmapVersionWriteInput,
  signal?: AbortSignal,
): Promise<ApiResult<RoadmapVersionWriteResponse>> {
  let path: string;
  try {
    path = initiativeRoadmapPath(initiativeId);
  } catch {
    return Promise.resolve({
      kind: "contract-mismatch",
      status: null,
      detail: "\"" + initiativeId + "\" is not a well formed initiative id",
    });
  }
  return postAndParse(path, input, RoadmapVersionWriteResponse, signal);
}

/**
 * The scoped, merged timeline (P8-8E, C2 of P8-8E-pre).
 *
 * One initiative's own stream merged with every task it owns, stream-tagged,
 * ordered `recordedAt` ascending. The task graph and the scoped timeline view
 * both read this same response — the graph derives nodes and edges from it,
 * the timeline view renders its rows directly — so there is exactly one
 * fetcher for it, not one per consumer.
 */
export function fetchInitiativeTimeline(
  initiativeId: string,
  signal?: AbortSignal,
): Promise<ApiResult<InitiativeTimelineResponse>> {
  let path: string;
  try {
    path = initiativeEventsPath(initiativeId);
  } catch {
    return Promise.resolve({
      kind: "contract-mismatch",
      status: null,
      detail: "\"" + initiativeId + "\" is not a well formed initiative id",
    });
  }
  return fetchAndParse(path, InitiativeTimelineResponse, signal);
}

/**
 * The scoped workers surface (P8-8E, C3 of P8-8E-pre).
 *
 * Folded from this initiative's own tasks alone — never the global worker
 * projection, which would report a worker's globally-latest task rather than
 * the one it last touched here.
 */
export function fetchInitiativeAgents(
  initiativeId: string,
  signal?: AbortSignal,
): Promise<ApiResult<InitiativeAgentsResponse>> {
  let path: string;
  try {
    path = initiativeAgentsPath(initiativeId);
  } catch {
    return Promise.resolve({
      kind: "contract-mismatch",
      status: null,
      detail: "\"" + initiativeId + "\" is not a well formed initiative id",
    });
  }
  return fetchAndParse(path, InitiativeAgentsResponse, signal);
}

/**
 * The owner's accounts (P8-8F).
 *
 * `AccountsResponse` is a closed union — `READY` or `UNAVAILABLE` — and both
 * arms are a 200 at the transport level, so this fetcher never classifies
 * `UNAVAILABLE` as a failure: parsing succeeds and the view branches on
 * `data.status` itself. Only a genuine transport, contract or unexpected-
 * status failure reaches `ApiResult`'s other kinds.
 */
export function fetchAccounts(signal?: AbortSignal): Promise<ApiResult<AccountsResponse>> {
  return fetchAndParse(API_ROUTES.accounts, AccountsResponse, signal);
}

export interface AccountActionInput {
  readonly action: AccountActionDto;
  /** Required for `OWNER_OVERRIDE`, refused for every other action — the schema's own rule. */
  readonly setState: AccountStatusDto | null;
  readonly note: string | null;
  readonly actor: string;
}

/**
 * Record one operator action against an account (P8-8G packet 3).
 *
 * The second write this client makes, alongside `writeRoadmapVersion` — both
 * travel through `postAndParse`, so both carry the bearer header the same
 * way and land in the same closed set of classified outcomes a caller
 * already knows how to read.
 */
export function postAccountAction(
  accountId: string,
  input: AccountActionInput,
  signal?: AbortSignal,
): Promise<ApiResult<AccountActionWriteResponse>> {
  let path: string;
  try {
    path = accountActionsPath(accountId);
  } catch {
    return Promise.resolve({
      kind: "contract-mismatch",
      status: null,
      detail: "\"" + accountId + "\" is not a well formed account id",
    });
  }
  return postAndParse(path, input, AccountActionWriteResponse, signal);
}

// ---------------------------------------------------------------------------
// Query keys (P8-8B)
// ---------------------------------------------------------------------------

/**
 * The cache vocabulary TanStack Query indexes this client by.
 *
 * Declared here, beside the fetchers, rather than at the call sites: a key
 * assembled inline is a key another call site can spell differently, and two
 * spellings of the same request are two caches that disagree while both look
 * correct. Every key starts with `"acp"` so this UI's entries are
 * distinguishable in a devtools panel from anything else a host page caches.
 *
 * The filters are part of the key because they are part of the request. A key
 * that ignored them would serve the first page's rows for the second page's
 * question and never look wrong doing it.
 */
export const queryKeys = {
  overview: () => ["acp", "overview"] as const,
  status: () => ["acp", "status"] as const,
  integrity: () => ["acp", "integrity"] as const,
  tasks: (filters: TasksFilters) => ["acp", "tasks", filters] as const,
  taskDetail: (taskId: string) => ["acp", "task", taskId] as const,
  workers: (filters: WorkersFilters) => ["acp", "workers", filters] as const,
  workerDetail: (identity: string) => ["acp", "worker", identity] as const,
  events: (filters: EventsFilters) => ["acp", "events", filters] as const,
  initiatives: () => ["acp", "initiatives"] as const,
  initiativeDetail: (initiativeId: string) => ["acp", "initiative", initiativeId] as const,
  initiativeRoadmap: (initiativeId: string) => ["acp", "initiative", initiativeId, "roadmap"] as const,
  roadmapContent: (initiativeId: string, version: number) =>
    ["acp", "initiative", initiativeId, "roadmap", "content", version] as const,
  initiativeTimeline: (initiativeId: string) => ["acp", "initiative", initiativeId, "timeline"] as const,
  initiativeAgents: (initiativeId: string) => ["acp", "initiative", initiativeId, "agents"] as const,
  accounts: () => ["acp", "accounts"] as const,
};
