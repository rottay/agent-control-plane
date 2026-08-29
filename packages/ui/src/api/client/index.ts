import {
  API_ROUTES,
  ApiError,
  EventPageResponse,
  IntegrityResult,
  LedgerStatusResponse,
  OverviewResponse,
  TaskDetailResponse,
  TaskPageResponse,
  WorkerDetailResponse,
  WorkerPageResponse,
  taskPath,
  workerPath,
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
