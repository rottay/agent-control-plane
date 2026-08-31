import { describe, expect, it } from "vitest";

import {
  buildHash,
  buildInitiativeAgentsHash,
  buildInitiativeGraphHash,
  buildInitiativeHash,
  buildInitiativeTimelineHash,
  buildPortfolioHash,
  buildTaskDetailHash,
  buildWorkerDetailHash,
  parseHash,
  serializeQuery,
} from "../../../src/routing/hash-route/index.js";

const INITIATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("parseHash", () => {
  it("defaults an empty hash to the overview", () => {
    expect(parseHash("")).toMatchObject({ view: "overview", taskId: null, workerIdentity: null, initiativeId: null });
    expect(parseHash("#/")).toMatchObject({ view: "overview" });
    expect(parseHash("#/overview")).toMatchObject({ view: "overview" });
  });

  it("parses a plain view route", () => {
    expect(parseHash("#/tasks")).toMatchObject({ view: "tasks", taskId: null });
    expect(parseHash("#/workers")).toMatchObject({ view: "workers" });
    expect(parseHash("#/events")).toMatchObject({ view: "events" });
    expect(parseHash("#/status")).toMatchObject({ view: "status" });
    expect(parseHash("#/integrity")).toMatchObject({ view: "integrity" });
  });

  it("parses a task detail route", () => {
    const route = parseHash("#/tasks/123e4567-e89b-12d3-a456-426614174000");
    expect(route.view).toBe("task-detail");
    expect(route.taskId).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("parses a worker detail route, keeping every identity segment", () => {
    const route = parseHash("#/workers/claude/opus/implementer/01");
    expect(route.view).toBe("worker-detail");
    expect(route.workerIdentity).toBe("claude/opus/implementer/01");
  });

  it("parses query parameters", () => {
    const route = parseHash("#/tasks?state=RUNNING&limit=10");
    expect(route.query).toEqual({ state: "RUNNING", limit: "10" });
  });

  it("falls back to not-found for an unroutable path", () => {
    expect(parseHash("#/nonsense").view).toBe("not-found");
    expect(parseHash("#/tasks/abc/extra").view).toBe("not-found");
    expect(parseHash("#/status/extra").view).toBe("not-found");
  });

  it("keeps the raw hash for diagnostics", () => {
    expect(parseHash("#/tasks?state=RUNNING").raw).toBe("#/tasks?state=RUNNING");
  });
});

describe("parseHash — the initiative-scoped prefix (P8-8C, blueprint v2 §4)", () => {
  it("parses the bare portfolio route, unscoped", () => {
    expect(parseHash("#/i")).toMatchObject({ view: "portfolio", taskId: null, workerIdentity: null, initiativeId: null });
  });

  it("parses a bare #/i/<id> to the workspace (P8-8D, blueprint v2 §3, C3)", () => {
    const route = parseHash("#/i/123e4567-e89b-12d3-a456-426614174000");
    expect(route.view).toBe("workspace");
    expect(route.initiativeId).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("parses a bare #/i/<id> with a trailing slash the same way", () => {
    const route = parseHash("#/i/123e4567-e89b-12d3-a456-426614174000/");
    expect(route.view).toBe("workspace");
    expect(route.initiativeId).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("parses a plain view route the same way whether or not it is initiative-scoped", () => {
    const unscoped = parseHash("#/tasks");
    const scoped = parseHash("#/i/123e4567-e89b-12d3-a456-426614174000/tasks");
    expect(scoped.view).toBe(unscoped.view);
    expect(scoped.taskId).toBe(unscoped.taskId);
    expect(scoped.initiativeId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(unscoped.initiativeId).toBeNull();
  });

  it("parses an initiative-scoped task detail route, carrying both ids", () => {
    const route = parseHash("#/i/123e4567-e89b-12d3-a456-426614174000/tasks/9f2e4567-e89b-12d3-a456-426614174111");
    expect(route.view).toBe("task-detail");
    expect(route.initiativeId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(route.taskId).toBe("9f2e4567-e89b-12d3-a456-426614174111");
  });

  it("parses an initiative-scoped worker detail route, keeping every identity segment", () => {
    const route = parseHash("#/i/123e4567-e89b-12d3-a456-426614174000/workers/claude/opus/implementer/01");
    expect(route.view).toBe("worker-detail");
    expect(route.initiativeId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(route.workerIdentity).toBe("claude/opus/implementer/01");
  });

  it("falls back to not-found for an unroutable scoped path, the same grammar as unscoped", () => {
    expect(parseHash("#/i/123e4567-e89b-12d3-a456-426614174000/tasks/abc/extra").view).toBe("not-found");
    expect(parseHash("#/i/123e4567-e89b-12d3-a456-426614174000/nonsense").view).toBe("not-found");
  });
});

describe("parseHash — the three scope-only views (P8-8E, C5)", () => {
  it("parses the scoped task graph route", () => {
    const route = parseHash("#/i/" + INITIATIVE_ID + "/graph");
    expect(route).toMatchObject({ view: "graph", taskId: null, workerIdentity: null, initiativeId: INITIATIVE_ID });
  });

  it("parses the scoped agents route", () => {
    const route = parseHash("#/i/" + INITIATIVE_ID + "/agents");
    expect(route).toMatchObject({ view: "agents", taskId: null, workerIdentity: null, initiativeId: INITIATIVE_ID });
  });

  it("parses the scoped /events route to the distinct 'timeline' view, never the global EventsView", () => {
    const scoped = parseHash("#/i/" + INITIATIVE_ID + "/events");
    expect(scoped.view).toBe("timeline");
    expect(scoped.initiativeId).toBe(INITIATIVE_ID);

    // The unprefixed route keeps resolving to the ordinary global view — the
    // divergence exists only when an initiative scopes the route.
    const unscoped = parseHash("#/events");
    expect(unscoped.view).toBe("events");
    expect(unscoped.initiativeId).toBeNull();
  });

  it("carries query parameters on a scoped timeline route", () => {
    const route = parseHash("#/i/" + INITIATIVE_ID + "/events?stream=TASK&type=TASK_STATE_CHANGED");
    expect(route.view).toBe("timeline");
    expect(route.query).toEqual({ stream: "TASK", type: "TASK_STATE_CHANGED" });
  });

  it("has no unscoped counterpart: bare #/graph and #/agents are not-found", () => {
    expect(parseHash("#/graph").view).toBe("not-found");
    expect(parseHash("#/agents").view).toBe("not-found");
  });

  it("falls back to not-found for a scoped graph/agents route with an extra segment", () => {
    expect(parseHash("#/i/" + INITIATIVE_ID + "/graph/extra").view).toBe("not-found");
    expect(parseHash("#/i/" + INITIATIVE_ID + "/agents/extra").view).toBe("not-found");
  });
});

describe("buildHash and serializeQuery", () => {
  it("builds a bare view hash with no query", () => {
    expect(buildHash("overview")).toBe("#/overview");
  });

  it("omits undefined, null and empty-string query values", () => {
    expect(buildHash("tasks", { state: "RUNNING", cursor: undefined, other: null, blank: "" })).toBe("#/tasks?state=RUNNING");
  });

  it("round-trips through parseHash", () => {
    const hash = buildHash("tasks", { state: "RUNNING", cursor: "abc123" });
    const route = parseHash(hash);
    expect(route.view).toBe("tasks");
    expect(route.query["state"]).toBe("RUNNING");
    expect(route.query["cursor"]).toBe("abc123");
  });

  it("serializeQuery mirrors the same omission rules", () => {
    expect(serializeQuery({ a: "1", b: undefined })).toBe("?a=1");
    expect(serializeQuery({})).toBe("");
  });
});

describe("buildPortfolioHash and buildInitiativeHash", () => {
  it("builds the bare portfolio hash", () => {
    expect(buildPortfolioHash()).toBe("#/i");
    expect(parseHash(buildPortfolioHash())).toMatchObject({ view: "portfolio", initiativeId: null });
  });

  it("builds an initiative hash that parses back scoped to the same id, landing on the workspace (P8-8D, C3)", () => {
    const hash = buildInitiativeHash("123e4567-e89b-12d3-a456-426614174000");
    expect(hash).toBe("#/i/123e4567-e89b-12d3-a456-426614174000");
    expect(parseHash(hash)).toMatchObject({ view: "workspace", initiativeId: "123e4567-e89b-12d3-a456-426614174000" });
  });

  it("encodes the initiative id", () => {
    const hash = buildInitiativeHash("has/slash");
    expect(hash).toBe("#/i/has%2Fslash");
  });
});

describe("buildTaskDetailHash and buildWorkerDetailHash", () => {
  it("builds a task detail hash that parses back to the same id", () => {
    const hash = buildTaskDetailHash("123e4567-e89b-12d3-a456-426614174000");
    expect(parseHash(hash)).toMatchObject({ view: "task-detail", taskId: "123e4567-e89b-12d3-a456-426614174000" });
  });

  it("builds a worker detail hash that parses back to the same identity", () => {
    const hash = buildWorkerDetailHash("claude/opus/implementer/01");
    expect(parseHash(hash)).toMatchObject({ view: "worker-detail", workerIdentity: "claude/opus/implementer/01" });
  });
});

describe("buildInitiativeGraphHash, buildInitiativeTimelineHash and buildInitiativeAgentsHash (P8-8E)", () => {
  it("builds a graph hash that parses back to the graph view, scoped", () => {
    const hash = buildInitiativeGraphHash(INITIATIVE_ID);
    expect(hash).toBe("#/i/" + INITIATIVE_ID + "/graph");
    expect(parseHash(hash)).toMatchObject({ view: "graph", initiativeId: INITIATIVE_ID });
  });

  it("builds an agents hash that parses back to the agents view, scoped", () => {
    const hash = buildInitiativeAgentsHash(INITIATIVE_ID);
    expect(hash).toBe("#/i/" + INITIATIVE_ID + "/agents");
    expect(parseHash(hash)).toMatchObject({ view: "agents", initiativeId: INITIATIVE_ID });
  });

  it("builds a bare timeline hash that parses back to the timeline view, scoped", () => {
    const hash = buildInitiativeTimelineHash(INITIATIVE_ID);
    expect(hash).toBe("#/i/" + INITIATIVE_ID + "/events");
    expect(parseHash(hash)).toMatchObject({ view: "timeline", initiativeId: INITIATIVE_ID });
  });

  it("builds a timeline hash with query parameters that round-trip", () => {
    const hash = buildInitiativeTimelineHash(INITIATIVE_ID, { stream: "TASK", type: undefined });
    expect(hash).toBe("#/i/" + INITIATIVE_ID + "/events?stream=TASK");
    const route = parseHash(hash);
    expect(route.view).toBe("timeline");
    expect(route.query["stream"]).toBe("TASK");
  });

  it("encodes the initiative id on every builder", () => {
    expect(buildInitiativeGraphHash("has/slash")).toBe("#/i/has%2Fslash/graph");
    expect(buildInitiativeAgentsHash("has/slash")).toBe("#/i/has%2Fslash/agents");
    expect(buildInitiativeTimelineHash("has/slash")).toBe("#/i/has%2Fslash/events");
  });
});
