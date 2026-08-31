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
 */

export const VIEW_NAMES = [
  "overview",
  "portfolio",
  "tasks",
  "task-detail",
  "workers",
  "worker-detail",
  "events",
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
    if (initiativeId === undefined || segments.length === 2) {
      // `#/i/<id>` names an initiative but no view within it. There is
      // nothing here to land on yet, so this is the honest answer rather
      // than a silent default into some other view.
      return { view: "not-found", taskId: null, workerIdentity: null, initiativeId: initiativeId ?? null, query, raw };
    }
    return parseViewSegments(segments.slice(2), initiativeId, query, raw);
  }

  return parseViewSegments(segments, null, query, raw);
}

/** Build a hash string for a plain view with no id segment. */
export function buildHash(
  view: Exclude<ViewName, "task-detail" | "worker-detail" | "not-found" | "portfolio">,
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
 * initiative. Lands on the tasks view scoped to it — the most detailed
 * landed view there is, and the same default a fresh workspace would open
 * on until P8-8D+ gives the initiative its own overview.
 */
export function buildInitiativeHash(initiativeId: string): string {
  return "#/i/" + encodeURIComponent(initiativeId) + "/tasks";
}

export function buildTaskDetailHash(taskId: string): string {
  return "#/tasks/" + encodeURIComponent(taskId);
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
