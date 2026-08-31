import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  type InitiativeTimelineResponse,
  type ScopedTimelineEntry,
} from "@acp/api-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Resource } from "../../../src/hooks/use-async-resource/index.js";
import { type Route } from "../../../src/routing/hash-route/index.js";
import { deriveGraph, GraphSection, GraphView, layoutGraph, type GraphEdge, type GraphNode } from "../../../src/views/graph-view/index.js";

const INITIATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";
const TASK_A = "9f2e4567-e89b-12d3-a456-426614174111";
const TASK_B = "9f2e4567-e89b-12d3-a456-426614174222";
const TASK_C = "9f2e4567-e89b-12d3-a456-426614174333";
const EVENT_1 = "aaaaaaaa-e89b-12d3-a456-426614174001";
const EVENT_2 = "bbbbbbbb-e89b-12d3-a456-426614174002";
const EVENT_3 = "cccccccc-e89b-12d3-a456-426614174003";
const EVENT_4 = "dddddddd-e89b-12d3-a456-426614174004";
const IDENTITY = "claude/opus/implementer/01";

type TaskRow = Extract<ScopedTimelineEntry, { readonly stream: "TASK" }>;
type InitiativeRow = Extract<ScopedTimelineEntry, { readonly stream: "INITIATIVE" }>;

function taskRow(overrides: Partial<TaskRow> = {}): ScopedTimelineEntry {
  return {
    stream: "TASK",
    sequence: 1,
    eventId: EVENT_1,
    taskId: TASK_A,
    type: "TASK_STATE_CHANGED",
    fromState: null,
    toState: "RUNNING",
    emittedBy: IDENTITY,
    occurredAt: "2026-08-30T12:00:00.000Z",
    recordedAt: "2026-08-30T12:00:00.000Z",
    correlationId: null,
    causationId: null,
    ...overrides,
  };
}

function initiativeRow(overrides: Partial<InitiativeRow> = {}): ScopedTimelineEntry {
  return {
    stream: "INITIATIVE",
    sequence: 1,
    eventId: EVENT_4,
    initiativeId: INITIATIVE_ID,
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: IDENTITY,
    occurredAt: "2026-08-30T11:00:00.000Z",
    recordedAt: "2026-08-30T11:00:00.000Z",
    ...overrides,
  };
}

function timelineResponse(items: ScopedTimelineEntry[], truncated = false): InitiativeTimelineResponse {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    initiativeId: INITIATIVE_ID,
    items,
    count: items.length,
    truncated,
  };
}

function route(overrides: Partial<Route> = {}): Route {
  return { view: "graph", taskId: null, workerIdentity: null, initiativeId: INITIATIVE_ID, query: {}, raw: "", ...overrides };
}

function successResource<T>(data: T): Resource<T> {
  return { status: "success", data, error: null };
}

const loadingResource: Resource<never> = { status: "loading", data: null, error: null };
const noop = (): void => {
  // refresh is not exercised in these fixture-driven renders
};

describe("deriveGraph — nodes and edges, never invented (C6)", () => {
  it("returns no nodes and no edges for an empty timeline", () => {
    expect(deriveGraph([])).toEqual({ nodes: [], edges: [] });
  });

  it("derives one node per distinct task, ignoring INITIATIVE-stream rows entirely", () => {
    const model = deriveGraph([
      initiativeRow(),
      taskRow({ taskId: TASK_A, eventId: EVENT_1, toState: "RUNNING" }),
      taskRow({ taskId: TASK_B, eventId: EVENT_2, toState: "READY" }),
    ]);
    expect(model.nodes).toHaveLength(2);
    expect(model.nodes.map((node) => node.taskId).sort()).toEqual([TASK_A, TASK_B].sort());
    expect(model.edges).toEqual([]);
  });

  it("realistic case: every causationId/correlationId is null in production today — an all-null timeline produces an edge-free graph, not an error", () => {
    const model = deriveGraph([
      taskRow({ taskId: TASK_A, eventId: EVENT_1, causationId: null, correlationId: null }),
      taskRow({ taskId: TASK_B, eventId: EVENT_2, causationId: null, correlationId: null }),
    ]);
    expect(model.nodes).toHaveLength(2);
    expect(model.edges).toEqual([]);
  });

  it("a node's state is its task's LAST row in the array (items arrive recordedAt ascending)", () => {
    const model = deriveGraph([
      taskRow({ taskId: TASK_A, eventId: EVENT_1, toState: "READY", recordedAt: "2026-08-30T12:00:00.000Z" }),
      taskRow({ taskId: TASK_A, eventId: EVENT_2, toState: "RUNNING", recordedAt: "2026-08-30T12:05:00.000Z" }),
    ]);
    expect(model.nodes).toEqual([{ taskId: TASK_A, state: "RUNNING", tone: "neutral" }]);
  });

  it("draws an edge when a TASK row's causationId resolves to a DIFFERENT task's event on this page", () => {
    const model = deriveGraph([
      taskRow({ taskId: TASK_A, eventId: EVENT_1, causationId: null }),
      taskRow({ taskId: TASK_B, eventId: EVENT_2, causationId: EVENT_1 }),
    ]);
    expect(model.edges).toEqual<GraphEdge[]>([
      { key: EVENT_1 + "->" + EVENT_2, fromTaskId: TASK_A, toTaskId: TASK_B, causingEventId: EVENT_1, causedEventId: EVENT_2 },
    ]);
  });

  it("does NOT draw an edge when causationId resolves to the SAME task's own earlier event (internal sequencing, not a dependency)", () => {
    const model = deriveGraph([
      taskRow({ taskId: TASK_A, eventId: EVENT_1, causationId: null }),
      taskRow({ taskId: TASK_A, eventId: EVENT_2, causationId: EVENT_1 }),
    ]);
    expect(model.edges).toEqual([]);
  });

  it("does NOT draw an edge when causationId resolves to nothing on this page (outside the fetch window, or truncated) — never invented", () => {
    const model = deriveGraph([taskRow({ taskId: TASK_A, eventId: EVENT_2, causationId: "ffffffff-e89b-12d3-a456-426614174999" })]);
    expect(model.edges).toEqual([]);
  });

  it("draws every distinct causal fact, even when two events of one task are each caused by a different task", () => {
    const model = deriveGraph([
      taskRow({ taskId: TASK_A, eventId: EVENT_1, causationId: null }),
      taskRow({ taskId: TASK_B, eventId: EVENT_2, causationId: null }),
      taskRow({ taskId: TASK_C, eventId: EVENT_3, causationId: EVENT_1 }),
      taskRow({ taskId: TASK_C, eventId: EVENT_4, causationId: EVENT_2 }),
    ]);
    expect(model.edges).toHaveLength(2);
    expect(model.edges.map((edge) => edge.fromTaskId).sort()).toEqual([TASK_A, TASK_B].sort());
  });
});

describe("layoutGraph — pure positions, layered by lifecycle phase, never force-directed (C6)", () => {
  it("returns no positions for no nodes", () => {
    expect(layoutGraph([], [])).toEqual([]);
  });

  it("positions a single node at the origin of its phase column (N3: the single-node fixture)", () => {
    const nodes: GraphNode[] = [{ taskId: TASK_A, state: "RUNNING", tone: "neutral" }];
    const positioned = layoutGraph(nodes, []);
    expect(positioned).toHaveLength(1);
    expect(positioned[0]).toMatchObject({ taskId: TASK_A, y: 0 });
  });

  it("gives an earlier lifecycle phase a smaller x than a later one", () => {
    const nodes: GraphNode[] = [
      { taskId: TASK_A, state: "RUNNING", tone: "neutral" },
      { taskId: TASK_B, state: "DISCOVERED", tone: "neutral" },
    ];
    const positioned = layoutGraph(nodes, []);
    const running = positioned.find((node) => node.taskId === TASK_A);
    const discovered = positioned.find((node) => node.taskId === TASK_B);
    expect(discovered?.x).toBeLessThan(running?.x ?? Number.POSITIVE_INFINITY);
  });

  it("places a state it does not recognise in a trailing column rather than crashing or dropping it", () => {
    const nodes: GraphNode[] = [
      { taskId: TASK_A, state: "RUNNING", tone: "neutral" },
      { taskId: TASK_B, state: "SOME_FUTURE_STATE_THIS_BUILD_DOES_NOT_KNOW", tone: "neutral" },
    ];
    const positioned = layoutGraph(nodes, []);
    const running = positioned.find((node) => node.taskId === TASK_A);
    const unknown = positioned.find((node) => node.taskId === TASK_B);
    expect(unknown).toBeDefined();
    expect(unknown?.x).toBeGreaterThan(running?.x ?? 0);
  });

  it("orders same-phase nodes with no edges deterministically by taskId, not insertion order", () => {
    const nodes: GraphNode[] = [
      { taskId: TASK_C, state: "READY", tone: "neutral" },
      { taskId: TASK_A, state: "READY", tone: "neutral" },
      { taskId: TASK_B, state: "READY", tone: "neutral" },
    ];
    const positioned = layoutGraph(nodes, []);
    const byY = [...positioned].sort((a, b) => a.y - b.y).map((node) => node.taskId);
    expect(byY).toEqual([TASK_A, TASK_B, TASK_C]);
  });

  it("sorts a same-phase node with more incoming edges nearer the top", () => {
    const nodes: GraphNode[] = [
      { taskId: TASK_A, state: "READY", tone: "neutral" },
      { taskId: TASK_B, state: "READY", tone: "neutral" },
    ];
    const edges: GraphEdge[] = [
      { key: "x1", fromTaskId: TASK_C, toTaskId: TASK_B, causingEventId: EVENT_1, causedEventId: EVENT_2 },
      { key: "x2", fromTaskId: TASK_C, toTaskId: TASK_B, causingEventId: EVENT_3, causedEventId: EVENT_4 },
    ];
    const positioned = layoutGraph(nodes, edges);
    const a = positioned.find((node) => node.taskId === TASK_A);
    const b = positioned.find((node) => node.taskId === TASK_B);
    expect(b?.y).toBeLessThan(a?.y ?? Number.POSITIVE_INFINITY);
  });
});

describe("GraphSection — the states contract", () => {
  it("loading: the async-section skeleton", () => {
    const html = renderToStaticMarkup(
      <GraphSection route={route()} initiativeId={INITIATIVE_ID} resource={loadingResource} lastFetchedAt={null} onRefresh={noop} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the task graph");
  });

  it("empty: no tasks recorded yet, an explicit empty state (N3)", () => {
    const html = renderToStaticMarkup(
      <GraphSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("No tasks have been recorded on this initiative&#x27;s timeline yet.");
  });

  it("single-node fixture (N3): renders the one task, no causal-links table", () => {
    const html = renderToStaticMarkup(
      <GraphSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow({ taskId: TASK_A, eventId: EVENT_1 })]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain(TASK_A.slice(0, 6));
    expect(html).toContain("No causal link is recorded between any two tasks");
  });

  it("list-as-contract: a rendered edge names the same from/to tasks and event ids deriveGraph produced", () => {
    const items = [
      taskRow({ taskId: TASK_A, eventId: EVENT_1, causationId: null }),
      taskRow({ taskId: TASK_B, eventId: EVENT_2, causationId: EVENT_1 }),
    ];
    const { edges } = deriveGraph(items);
    expect(edges).toHaveLength(1);

    const html = renderToStaticMarkup(
      <GraphSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse(items))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    // Both tasks appear in the tasks table, and the causal-links table names
    // the exact pair `deriveGraph` computed — the canvas and the list are
    // never two different accounts of the same facts.
    expect(html).toContain(TASK_A.slice(0, 6));
    expect(html).toContain(TASK_B.slice(0, 6));
    expect(html).toContain(EVENT_1.slice(0, 6));
    expect(html).toContain(EVENT_2.slice(0, 6));
    expect(html).not.toContain("No causal link is recorded");
  });

  it("the canvas is genuinely absent under static rendering — not a placeholder standing in for it (C5/C6)", () => {
    const html = renderToStaticMarkup(
      <GraphSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow({ taskId: TASK_A, eventId: EVENT_1 })]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).not.toContain("graph-canvas");
    expect(html).not.toContain("react-flow");
  });

  it("truncated: names the gap rather than silently under-reporting the graph", () => {
    const html = renderToStaticMarkup(
      <GraphSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow()], true))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("truncated at the fetch ceiling");
  });

  it("an unknown initiative (404) renders the landed not-found view (C3/C5)", () => {
    const html = renderToStaticMarkup(
      <GraphSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={{ status: "error", data: null, error: { kind: "api-error", message: "no initiative with that id was found", detail: null, status: 404 } }}
        lastFetchedAt={null}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("Not found");
  });

  it("a non-404 failure renders the generic error state, not not-found", () => {
    const html = renderToStaticMarkup(
      <GraphSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={{ status: "error", data: null, error: { kind: "api-error", message: "the configured ledger database is not currently available", detail: null, status: 503 } }}
        lastFetchedAt={null}
        onRefresh={noop}
      />,
    );
    expect(html).not.toContain("Not found");
    expect(html).toContain("Could not load the task graph.");
  });
});

describe("GraphView", () => {
  it("renders a heading and an announced loading state on the very first render (the hook's effect has not run yet)", () => {
    const html = renderToStaticMarkup(<GraphView route={route()} />);
    expect(html).toContain("Task graph");
    expect(html).toContain('role="status"');
  });

  it("falls back to the not-found view when the route carries no initiative id (C3)", () => {
    const html = renderToStaticMarkup(<GraphView route={route({ initiativeId: null })} />);
    expect(html).toContain("Not found");
  });
});
