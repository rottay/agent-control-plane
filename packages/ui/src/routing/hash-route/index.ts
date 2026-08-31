/**
 * Hash based routing, with no router dependency.
 *
 * The whole of the UI's navigable state — which view, which detail id, which
 * filters, which cursor — lives in `location.hash`. That is what makes every
 * view deep linkable and back/forward navigable with nothing more than the
 * browser's own history stack.
 *
 * Shape: `#/<view>[/<id-or-identity>][?<query>]`. Worker identities contain
 * slashes (`provider/model/role/instance`), so a worker detail route captures
 * every remaining path segment rather than exactly one.
 *
 * **P8-8C's initiative scope, the same way.** `#/i` is the portfolio — every
 * initiative, unscoped — and `#/i/<id>/…` prefixes any of the plain view
 * routes with an initiative: the remaining segments parse exactly as they do
 * unprefixed, and `initiativeId` rides beside them on the `Route`. No second
 * router, no global: the switcher and every view read the same one field.
 *
 * **P8-8D's workspace, at the bare scope.** `#/i/<id>` alone — naming an
 * initiative with no view segment after it — now routes to the workspace
 * (blueprint v2 §3, C3): the one address that means "this initiative, its own
 * page." An id the workspace's own fetch cannot resolve renders not-found
 * from inside the view, per the id-validation law; the sibling scoped routes
 * (`#/i/<id>/tasks`, `#/i/<id>/workers`, …) keep their own, unvalidated
 * shape, deferred to their own cohorts by name.
 *
 * **P8-8E's three scope-only views.** `#/i/<id>/graph`, `#/i/<id>/events` and
 * `#/i/<id>/agents` do not share the plain grammar `parseViewSegments`
 * builds: the scoped `/events` in particular must render a different view
 * from the unprefixed `#/events` (the merged, stream-tagged timeline, not the
 * global `EventsView` with a filter applied), and `/graph` and `/agents` have
 * no unprefixed counterpart to share with at all — a task graph or a scoped
 * worker roster is only ever a fact about one initiative. `parseScopedOnlySegments`
 * is checked first, before the shared grammar, so the two never drift into
 * resolving the same segment two different ways.
 */

export const VIEW_NAMES = [
  "overview",
  "portfolio",
  "workspace",
  "tasks",
  "task-detail",
  "workers",
  "worker-detail",
  "events",
  "graph",
  "timeline",
  "agents",
  "status",
  "integrity",
  "not-found",
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

export interface Route {
  readonly view: ViewName;
  readonly taskId: string | null;
  readonly workerIdentity: string | null;
  /**
   * The initiative this route is scoped to, from `#/i/<id>/…`. `null` on
   * every unprefixed route, including `#/i` itself — the portfolio is the
   * view of *every* initiative, so it is the one place a specific id would
   * be a contradiction rather than a scope.
   */
  readonly initiativeId: string | null;
  readonly query: Readonly<Record<string, string>>;
  /** The raw hash this route was parsed from, kept for diagnostics. */
  readonly raw: string;
}

function parseQuery(queryPart: string): Record<string, string> {
  const query: Record<string, string> = {};
  const search = new URLSearchParams(queryPart);
  for (const [key, value] of search.entries()) {
    query[key] = value;
  }
  return query;
}

/**
 * The plain-view grammar, shared by the unprefixed routes and the
 * initiative-scoped ones.
 *
 * Written once so `#/tasks/<id>` and `#/i/<initiative>/tasks/<id>` cannot
 * drift into two different ideas of what a tasks route looks like — the
 * initiative prefix changes nothing about how the remainder parses, only
 * which value rides beside it.
 */
function parseViewSegments(
  segments: readonly string[],
  initiativeId: string | null,
  query: Readonly<Record<string, string>>,
  raw: string,
): Route {
  const head = segments[0];

  if (head === undefined || head === "overview") {
    return { view: "overview", taskId: null, workerIdentity: null, initiativeId, query, raw };
  }
  if (head === "tasks") {
    const taskId = segments[1];
    if (taskId === undefined) {
      return { view: "tasks", taskId: null, workerIdentity: null, initiativeId, query, raw };
    }
    if (segments.length === 2) {
      return { view: "task-detail", taskId, workerIdentity: null, initiativeId, query, raw };
    }
    return { view: "not-found", taskId: null, workerIdentity: null, initiativeId, query, raw };
  }
  if (head === "workers") {
    if (segments.length === 1) {
      return { view: "workers", taskId: null, workerIdentity: null, initiativeId, query, raw };
    }
    const identity = segments.slice(1).join("/");
    return { view: "worker-detail", taskId: null, workerIdentity: identity, initiativeId, query, raw };
  }
  if (head === "events" && segments.length === 1) {
    return { view: "events", taskId: null, workerIdentity: null, initiativeId, query, raw };
  }
  if (head === "status" && segments.length === 1) {
    return { view: "status", taskId: null, workerIdentity: null, initiativeId, query, raw };
  }
  if (head === "integrity" && segments.length === 1) {
    return { view: "integrity", taskId: null, workerIdentity: null, initiativeId, query, raw };
  }
  return { view: "not-found", taskId: null, workerIdentity: null, initiativeId, query, raw };
}

/**
 * Routes that only make sense scoped to one initiative — the task graph, the
 * scoped timeline and the agents surface (P8-8E). Returns `null` for
 * anything that is not exactly one of these three single-segment routes, so
 * the caller falls through to the shared grammar unchanged.
 */
function parseScopedOnlySegments(
  segments: readonly string[],
  initiativeId: string,
  query: Readonly<Record<string, string>>,
  raw: string,
): Route | null {
  if (segments.length !== 1) {
    return null;
  }
  if (segments[0] === "graph") {
    return { view: "graph", taskId: null, workerIdentity: null, initiativeId, query, raw };
  }
  if (segments[0] === "events") {
    return { view: "timeline", taskId: null, workerIdentity: null, initiativeId, query, raw };
  }
  if (segments[0] === "agents") {
    return { view: "agents", taskId: null, workerIdentity: null, initiativeId, query, raw };
  }
  return null;
}

export function parseHash(hash: string): Route {
  const raw = hash;
  const withoutMarker = hash.startsWith("#") ? hash.slice(1) : hash;
  const withoutSlash = withoutMarker.startsWith("/") ? withoutMarker.slice(1) : withoutMarker;
  const questionIndex = withoutSlash.indexOf("?");
  const pathPart = questionIndex === -1 ? withoutSlash : withoutSlash.slice(0, questionIndex);
  const queryPart = questionIndex === -1 ? "" : withoutSlash.slice(questionIndex + 1);
  const query = parseQuery(queryPart);
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);

  if (segments[0] === "i") {
    if (segments.length === 1) {
      // The portfolio: every initiative, so no single id applies here.
      return { view: "portfolio", taskId: null, workerIdentity: null, initiativeId: null, query, raw };
    }
    const initiativeId = segments[1];
    if (initiativeId === undefined) {
      // `#/i/` with a trailing slash and nothing after it. Not a shape
      // anything builds; parsed the same as `#/i` itself would be wrong
      // (it would carry a scope), so this is the honest not-found.
      return { view: "not-found", taskId: null, workerIdentity: null, initiativeId: null, query, raw };
    }
    if (segments.length === 2) {
      // `#/i/<id>` alone: the workspace. Whether the id names a real
      // initiative is a question only a fetch can answer, so the route
      // grammar admits it here and the view itself renders not-found for
      // an id its own fetch cannot resolve (the id-validation law, C3).
      return { view: "workspace", taskId: null, workerIdentity: null, initiativeId, query, raw };
    }
    const rest = segments.slice(2);
    const scopedOnly = parseScopedOnlySegments(rest, initiativeId, query, raw);
    if (scopedOnly !== null) {
      return scopedOnly;
    }
    return parseViewSegments(rest, initiativeId, query, raw);
  }

  return parseViewSegments(segments, null, query, raw);
}

/** Build a hash string for a plain view with no id segment. */
export function buildHash(
  view: Exclude<ViewName, "task-detail" | "worker-detail" | "not-found" | "portfolio" | "workspace">,
  query: Readonly<Record<string, string | number | undefined | null>> = {},
): string {
  return "#/" + view + serializeQuery(query);
}

/** The portfolio route: every initiative, unscoped. */
export function buildPortfolioHash(): string {
  return "#/i";
}

/**
 * The hash the switcher navigates to when an operator picks a specific
 * initiative: the workspace, bare (P8-8D, blueprint v2 §3, C3). Landing on
 * the tasks view was the P8-8C default, before the initiative had a page of
 * its own; now that it does, the bare address is the more useful landing —
 * name, objective, roadmap and work state in one place, one click from
 * either a task or worker list should a reader want the scoped detail.
 */
export function buildInitiativeHash(initiativeId: string): string {
  return "#/i/" + encodeURIComponent(initiativeId);
}

export function buildTaskDetailHash(taskId: string): string {
  return "#/tasks/" + encodeURIComponent(taskId);
}

/** The scoped task graph route (P8-8E). */
export function buildInitiativeGraphHash(initiativeId: string): string {
  return "#/i/" + encodeURIComponent(initiativeId) + "/graph";
}

/** The scoped, merged timeline route (P8-8E). Shares `/events` with the
 * unprefixed grammar in spelling only — `parseHash` resolves it to the
 * distinct `"timeline"` view, never the global `EventsView`. */
export function buildInitiativeTimelineHash(
  initiativeId: string,
  query: Readonly<Record<string, string | number | undefined | null>> = {},
): string {
  return "#/i/" + encodeURIComponent(initiativeId) + "/events" + serializeQuery(query);
}

/** The scoped agents route (P8-8E). */
export function buildInitiativeAgentsHash(initiativeId: string): string {
  return "#/i/" + encodeURIComponent(initiativeId) + "/agents";
}

export function buildWorkerDetailHash(identity: string): string {
  return "#/workers/" + identity.split("/").map(encodeURIComponent).join("/");
}

export function serializeQuery(
  query: Readonly<Record<string, string | number | undefined | null>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized === "" ? "" : "?" + serialized;
}
