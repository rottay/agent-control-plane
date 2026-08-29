import { describe, expect, it } from "vitest";

import { buildHash, buildTaskDetailHash, buildWorkerDetailHash, parseHash, serializeQuery } from "../../../src/routing/hash-route/index.js";

describe("parseHash", () => {
  it("defaults an empty hash to the overview", () => {
    expect(parseHash("")).toMatchObject({ view: "overview", taskId: null, workerIdentity: null });
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
