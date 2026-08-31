import { describe, expect, it } from "vitest";

import {
  buildHash,
  buildInitiativeHash,
  buildPortfolioHash,
  buildTaskDetailHash,
  buildWorkerDetailHash,
  parseHash,
  serializeQuery,
} from "../../../src/routing/hash-route/index.js";

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
