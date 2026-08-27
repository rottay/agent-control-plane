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
 */

export const VIEW_NAMES = [
  "overview",
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

export function parseHash(hash: string): Route {
  const raw = hash;
  const withoutMarker = hash.startsWith("#") ? hash.slice(1) : hash;
  const withoutSlash = withoutMarker.startsWith("/") ? withoutMarker.slice(1) : withoutMarker;
  const questionIndex = withoutSlash.indexOf("?");
  const pathPart = questionIndex === -1 ? withoutSlash : withoutSlash.slice(0, questionIndex);
  const queryPart = questionIndex === -1 ? "" : withoutSlash.slice(questionIndex + 1);
  const query = parseQuery(queryPart);
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);

  const head = segments[0];

  if (head === undefined || head === "overview") {
    return { view: "overview", taskId: null, workerIdentity: null, query, raw };
  }
  if (head === "tasks") {
    const taskId = segments[1];
    if (taskId === undefined) {
      return { view: "tasks", taskId: null, workerIdentity: null, query, raw };
    }
    if (segments.length === 2) {
      return { view: "task-detail", taskId, workerIdentity: null, query, raw };
    }
    return { view: "not-found", taskId: null, workerIdentity: null, query, raw };
  }
  if (head === "workers") {
    if (segments.length === 1) {
      return { view: "workers", taskId: null, workerIdentity: null, query, raw };
    }
    const identity = segments.slice(1).join("/");
    return { view: "worker-detail", taskId: null, workerIdentity: identity, query, raw };
  }
  if (head === "events" && segments.length === 1) {
    return { view: "events", taskId: null, workerIdentity: null, query, raw };
  }
  if (head === "status" && segments.length === 1) {
    return { view: "status", taskId: null, workerIdentity: null, query, raw };
  }
  if (head === "integrity" && segments.length === 1) {
    return { view: "integrity", taskId: null, workerIdentity: null, query, raw };
  }
  return { view: "not-found", taskId: null, workerIdentity: null, query, raw };
}

/** Build a hash string for a plain view with no id segment. */
export function buildHash(
  view: Exclude<ViewName, "task-detail" | "worker-detail" | "not-found">,
  query: Readonly<Record<string, string | number | undefined | null>> = {},
): string {
  return "#/" + view + serializeQuery(query);
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
