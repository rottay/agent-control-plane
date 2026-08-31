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
  // P8-8A: the initiative data plane. Read-only like every route above it,
  // and under the same versioned prefix — an unversioned path would be one
  // this package did not describe.
  initiatives: "/api/v1/initiatives",
  initiativeById: "/api/v1/initiatives/:initiativeId",
  initiativeRoadmap: "/api/v1/initiatives/:initiativeId/roadmap",
  // P8-8D-c2: the stored roadmap document itself. A read, under the same
  // versioned prefix, selected by `?version=` rather than by digest — see the
  // schema for why the version is the safer selector.
  initiativeRoadmapContent: "/api/v1/initiatives/:initiativeId/roadmap/content",
  // P8-8E-pre: the scoped reads the graph/timeline/agents cohort needs. Both
  // are reads under the same versioned prefix; the GET-only law is untouched.
  initiativeEvents: "/api/v1/initiatives/:initiativeId/events",
  initiativeAgents: "/api/v1/initiatives/:initiativeId/agents",
  // P8-8F: the owner's accounts, with quota and reset confidence. A read, and
  // deliberately not scoped to an initiative — accounts are the plane's, not an
  // initiative's.
  accounts: "/api/v1/accounts",
  // P8-8G packet 2: the plane's second write door. GET reads one account's
  // action history; POST records an action. Registered through the same
  // guarded registrar as the first, so the bearer is inherited structurally.
  accountActions: "/api/v1/accounts/:accountId/actions",
} as const);

export type ApiRouteName = keyof typeof API_ROUTES;
export type ApiRoutePattern = (typeof API_ROUTES)[ApiRouteName];

/** Every route pattern, in declaration order. */
export const API_ROUTE_PATTERNS: readonly ApiRoutePattern[] = Object.freeze(
  Object.values(API_ROUTES),
);

/**
 * The methods the observation plane answers on a **read** route.
 *
 * Stated as data rather than as prose so the server lane can assert it instead
 * of remembering it. This list stays exactly `["GET"]`: it describes the read
 * plane, which did not change when the first write route arrived. A route that
 * accepts a write is named in `API_WRITE_ROUTES` below and is the exception the
 * table makes visible, rather than a widening of this one that would quietly
 * reclassify all nine reads.
 */
export const API_ALLOWED_METHODS = Object.freeze(["GET"] as const);
export type ApiAllowedMethod = (typeof API_ALLOWED_METHODS)[number];

/**
 * The write routes, frozen — and deliberately a **separate** table. (P8-8D-pre.)
 *
 * The plane was GET-only through P8-8C, and the honest way to record its first
 * exception is a second closed list rather than a softened first one. A reader
 * asking "what can mutate?" gets one short answer here; a reader asking "is
 * this route a read?" still gets the unchanged answer above. One route is in
 * this table, and adding a second is a visible edit to a list whose whole
 * purpose is to be short.
 *
 * The value is the route **name**, not the pattern, so the two tables cannot
 * disagree about a path: the pattern always comes from `API_ROUTES`.
 */
/**
 * The write routes, frozen — now two (P8-8G packet 2).
 *
 * The table grows **visibly**, which is the point of keeping it separate from
 * `API_ALLOWED_METHODS`: a reader asking "what can mutate?" still gets a short
 * answer they can read in one glance, and adding to it is an edit that shows
 * up in review rather than a method quietly appearing on a route.
 */
export const API_WRITE_ROUTES = Object.freeze([
  "initiativeRoadmap",
  "accountActions",
] as const);
export type ApiWriteRouteName = (typeof API_WRITE_ROUTES)[number];

/** The methods a write route answers: its read, plus the one write. */
export const API_WRITE_METHODS = Object.freeze(["GET", "POST"] as const);
export type ApiWriteMethod = (typeof API_WRITE_METHODS)[number];

/** Does this route accept a write? Data, so the server asserts rather than recalls. */
export function isWriteRoute(route: ApiRouteName): boolean {
  return (API_WRITE_ROUTES as readonly string[]).includes(route);
}

const TaskIdParam = z.uuid();
const InitiativeIdParam = z.uuid();

/**
 * An account id is not a uuid — it is the operator's own label from the owner
 * file — so it is bounded and pattern-checked rather than parsed as one. The
 * pattern refuses path separators and traversal segments, which is the same
 * property the uuid check buys for initiatives.
 */
const AccountIdParam = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "expected an account id, not a path segment");

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

/**
 * Build the path for a single initiative.
 *
 * Validated before it is encoded, exactly as `taskPath` is: a caller that
 * passes a traversal segment or a query string gets a thrown validation error
 * rather than a request to somewhere else.
 */
export function initiativePath(initiativeId: string): string {
  return API_ROUTES.initiatives + "/" + encodeURIComponent(InitiativeIdParam.parse(initiativeId));
}

/** Build the roadmap-history path for a single initiative. */
export function initiativeRoadmapPath(initiativeId: string): string {
  return initiativePath(initiativeId) + "/roadmap";
}

/** Build the actions path for a single account. */
export function accountActionsPath(accountId: string): string {
  return API_ROUTES.accounts + "/" + encodeURIComponent(AccountIdParam.parse(accountId)) + "/actions";
}

/** Build the merged-timeline path for a single initiative. */
export function initiativeEventsPath(initiativeId: string): string {
  return initiativePath(initiativeId) + "/events";
}

/** Build the scoped-workers path for a single initiative. */
export function initiativeAgentsPath(initiativeId: string): string {
  return initiativePath(initiativeId) + "/agents";
}

/** Build the content path for a single initiative's roadmap. */
export function initiativeRoadmapContentPath(initiativeId: string): string {
  return initiativeRoadmapPath(initiativeId) + "/content";
}
