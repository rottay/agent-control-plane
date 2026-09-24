import { WorkerIdentityString } from "@acp/contracts";
import { z } from "zod";

import { EffectIdParam } from "../schemas/index.js";

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
  // V2-B3a: the ledger sequence as a stream. A GET, under the same versioned
  // prefix, and deliberately a **sibling** of `events` rather than a mode of
  // it: the two answer the same rows with different liveness contracts, and a
  // `?live=1` on the paged route would have made one path sometimes return a
  // body that ends and sometimes one that does not. It reads, and left the
  // write table below untouched.
  eventStream: "/api/v1/events/stream",
  // V2-B4b stage 3C: the plane's third write door, and the first that makes
  // this process start a child and speak a protocol to it. GET reads a task's
  // recorded tool calls; POST executes one explicit call through the shared
  // operation. Registered through the same guarded registrar as the other two,
  // so the bearer is inherited structurally rather than remembered.
  taskToolCalls: "/api/v1/tasks/:taskId/tool-calls",
  // V2 L3: the plane's fourth write door, and the first whose write acts on
  // work already in flight rather than recording something new. GET reads the
  // task's lifecycle coordinates; POST cancels an attempt or rejoins its
  // invocation, through the same `@acp/runtime` operation the CLI door calls.
  // Registered through the same guarded registrar as the other three, so the
  // bearer is inherited structurally rather than remembered.
  taskLifecycle: "/api/v1/tasks/:taskId/lifecycle",
  // P-15/F: how a caller learns a task's effect ids. A plain read like every
  // other GET here: ids, coordinates and outcome words, never a digest, a
  // reference or a byte of a result.
  taskEffects: "/api/v1/tasks/:taskId/effects",
  // P-15/F: one effect's result, read back by reference. A GET, and the one read
  // of this plane that is NOT free: it answers model output, so it is named in
  // `API_PRIVATE_READ_ROUTES` below and registered behind the bearer.
  taskEffectResult: "/api/v1/tasks/:taskId/effects/:effectId/result",
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
 * reclassify every read this table declares.
 */
export const API_ALLOWED_METHODS = Object.freeze(["GET"] as const);
export type ApiAllowedMethod = (typeof API_ALLOWED_METHODS)[number];

/**
 * The write routes, frozen — and deliberately a **separate** table. (P8-8D-pre.)
 *
 * The plane was GET-only through P8-8C, and the honest way to record its first
 * exception is a second closed list rather than a softened first one. A reader
 * asking "what can mutate?" gets one short answer here; a reader asking "is
 * this route a read?" still gets the unchanged answer above. The table is
 * separate **so that** growth is a visible edit rather than a method quietly
 * appearing on a route — which is the whole of the guarantee, and it holds at
 * any length.
 *
 * This block counted itself twice and was wrong both times: it said "one route
 * is in this table" while there were three, and a second docblock stacked
 * beneath it said "now three" over four entries. Two stale sentences describing
 * one array is what a cardinal in a comment costs. The property is stated
 * without one now, and the array below is the only place the members are named.
 *
 * The members are not alike, and the difference is worth stating where the
 * table is read. `initiativeRoadmap` and `accountActions` record a decision the
 * caller had already made; `taskToolCalls` makes this process start a child and
 * speak a protocol to it, and `taskLifecycle` speaks to an execution engine
 * about an invocation already running. That is why the API contract version
 * moves with those two, and why they are the only places in this plane where
 * process-start authority exists at all.
 *
 * The value is the route **name**, not the pattern, so the two tables cannot
 * disagree about a path: the pattern always comes from `API_ROUTES`.
 */
export const API_WRITE_ROUTES = Object.freeze([
  "initiativeRoadmap",
  "accountActions",
  "taskToolCalls",
  // V2 L3. The fourth, and the second that reaches beyond the ledger: the
  // tool-call door starts a child, and this one speaks to an execution engine
  // about an invocation already running. The API contract version moves with
  // it, as it did for the third.
  "taskLifecycle",
  // P-14/B. The fifth, and a return to the first kind: it records a decision
  // the caller already made — an initiative, by the caller's own id — and
  // publishes its objective to the private plane before the event names it. The
  // GET beside it is the portfolio, unchanged.
  "initiatives",
  // P-14/C. The sixth, and of the fifth's kind: it records a task the caller
  // already composed — under the caller's own key and the caller's own task id —
  // and publishes its envelope to the private plane before the event names it.
  // It executes nothing. The GET beside it is the task list, unchanged.
  "tasks",
] as const);
export type ApiWriteRouteName = (typeof API_WRITE_ROUTES)[number];

/**
 * The private read routes, frozen — a third closed table (P-15 escalón F, ADR 0107).
 *
 * Observation is free on this plane, and every GET above stays so. A route that
 * answers **model output** is the exception tests §8.1 admits only as a read
 * "explícitamente autorizada", audited before it exists (decision 149): it is a
 * GET, `API_ALLOWED_METHODS` does not change, and it is named here so the
 * exception is a visible table rather than a guard remembered in one handler. The
 * gateway registers every member through its bearer-guarded read registrar and
 * nothing else. The initiative's objective, an internal plan document on an
 * unguarded GET since decision 76, is not model output and is not in this table.
 */
export const API_PRIVATE_READ_ROUTES = Object.freeze(["taskEffectResult"] as const);
export type ApiPrivateReadRouteName = (typeof API_PRIVATE_READ_ROUTES)[number];

/** Is this route a private read, answered only behind the bearer? Data, so the server asserts rather than recalls. */
export function isPrivateReadRoute(route: ApiRouteName): boolean {
  return (API_PRIVATE_READ_ROUTES as readonly string[]).includes(route);
}

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

/**
 * Build the tool-calls path for a single task.
 *
 * Built through `taskPath`, so the identifier is validated and encoded by the
 * same rule every other task-scoped path uses: one validator, not a second one
 * that could drift from it.
 */
export function toolCallsPath(taskId: string): string {
  return taskPath(taskId) + "/tool-calls";
}

/**
 * Build the lifecycle path for a single task.
 *
 * Built through `taskPath` for the same reason `toolCallsPath` is: one
 * validator for every task-scoped path, rather than a second that could drift.
 */
export function lifecyclePath(taskId: string): string {
  return taskPath(taskId) + "/lifecycle";
}

/** Build the effects path for a single task (P-15/F), through `taskPath`'s one validator. */
export function taskEffectsPath(taskId: string): string {
  return taskPath(taskId) + "/effects";
}

/**
 * Build the result path for one effect of one task (P-15/F).
 *
 * Both components are validated before either is encoded: the task id by
 * `taskPath`'s rule, the effect id by the ledger's own shape.
 */
export function taskEffectResultPath(taskId: string, effectId: string): string {
  return taskEffectsPath(taskId) + "/" + encodeURIComponent(EffectIdParam.parse(effectId)) + "/result";
}
