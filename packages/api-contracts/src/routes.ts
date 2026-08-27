import { WorkerIdentityString } from "@acp/contracts";
import { z } from "zod";

/**
 * The read-only observation route table.
 *
 * Every route in P1 is a GET under a single versioned prefix. The prefix is
 * part of the contract rather than a deployment detail: a reader that finds
 * itself talking to an unversioned path is talking to something this package
 * did not describe, and should fail rather than guess.
 *
 * There is no mutating route here and there will not be one in P1. Observation
 * is the whole of the phase.
 */

export const API_BASE_PATH = "/api/v1";

/**
 * Route patterns, frozen.
 *
 * Dynamic routes carry a `:param` placeholder in the pattern and are never
 * built by string concatenation at the call site. Use the helpers below, which
 * validate the component before encoding it.
 */
export const API_ROUTES = Object.freeze({
  health: "/api/v1/health",
  overview: "/api/v1/overview",
  tasks: "/api/v1/tasks",
  taskById: "/api/v1/tasks/:taskId",
  workers: "/api/v1/workers",
  workerByIdentity: "/api/v1/workers/:identity",
  events: "/api/v1/events",
  status: "/api/v1/status",
  integrity: "/api/v1/integrity",
} as const);

export type ApiRouteName = keyof typeof API_ROUTES;
export type ApiRoutePattern = (typeof API_ROUTES)[ApiRouteName];

/** Every route pattern, in declaration order. */
export const API_ROUTE_PATTERNS: readonly ApiRoutePattern[] = Object.freeze(
  Object.values(API_ROUTES),
);

/**
 * The only method the observation plane answers.
 *
 * Stated as data rather than as prose so the server lane can assert it instead
 * of remembering it.
 */
export const API_ALLOWED_METHODS = Object.freeze(["GET"] as const);
export type ApiAllowedMethod = (typeof API_ALLOWED_METHODS)[number];

const TaskIdParam = z.uuid();

/**
 * Build the path for a single task.
 *
 * The identifier is validated before it is encoded. A caller that passes a
 * traversal segment, a query string or a raw path gets a thrown validation
 * error rather than a request to somewhere else.
 */
export function taskPath(taskId: string): string {
  return API_ROUTES.tasks + "/" + encodeURIComponent(TaskIdParam.parse(taskId));
}

/**
 * Build the path for a single worker.
 *
 * A worker identity is `<provider>/<model>/<role>/<instance>` and therefore
 * contains slashes. It is validated against the canonical identity pattern and
 * then percent-encoded as one path component, so the separators inside the
 * identity can never be mistaken for route separators.
 */
export function workerPath(identity: string): string {
  return (
    API_ROUTES.workers +
    "/" +
    encodeURIComponent(WorkerIdentityString.parse(identity))
  );
}
