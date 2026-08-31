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
import { type NavigateFn } from "../../../src/routing/use-hash-route/index.js";
import { filterTimeline, TimelineSection, TimelineView } from "../../../src/views/timeline-view/index.js";

const INITIATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";
const TASK_A = "9f2e4567-e89b-12d3-a456-426614174111";
const TASK_B = "9f2e4567-e89b-12d3-a456-426614174222";
const IDENTITY = "claude/opus/implementer/01";

type TaskRow = Extract<ScopedTimelineEntry, { readonly stream: "TASK" }>;
type InitiativeRow = Extract<ScopedTimelineEntry, { readonly stream: "INITIATIVE" }>;

function taskRow(overrides: Partial<TaskRow> = {}): ScopedTimelineEntry {
  return {
    stream: "TASK",
    sequence: 1,
    eventId: "aaaaaaaa-e89b-12d3-a456-426614174001",
    taskId: TASK_A,
    type: "TASK_STATE_CHANGED",
    fromState: "READY",
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
    eventId: "bbbbbbbb-e89b-12d3-a456-426614174002",
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
  return { view: "timeline", taskId: null, workerIdentity: null, initiativeId: INITIATIVE_ID, query: {}, raw: "", ...overrides };
}

function successResource<T>(data: T): Resource<T> {
  return { status: "success", data, error: null };
}

const loadingResource: Resource<never> = { status: "loading", data: null, error: null };
const noopNavigate: NavigateFn = () => {
  // filter navigation is not exercised in these fixture-driven renders
};
const noopRefresh = (): void => {
  // refresh is not exercised in these fixture-driven renders
};

describe("filterTimeline — client-side, since the endpoint answers no query parameters at all", () => {
  const items = [
    taskRow({ taskId: TASK_A, type: "TASK_STATE_CHANGED" }),
    taskRow({ taskId: TASK_B, type: "TASK_DISCOVERED", eventId: "cccccccc-e89b-12d3-a456-426614174003" }),
    initiativeRow(),
  ];

  it("returns every row when no filter is given", () => {
    expect(filterTimeline(items, {})).toHaveLength(3);
  });

  it("filters by stream", () => {
    const initiativeOnly = filterTimeline(items, { stream: "INITIATIVE" });
    expect(initiativeOnly).toHaveLength(1);
    expect(initiativeOnly[0]?.stream).toBe("INITIATIVE");
  });

  it("filters by type", () => {
    const filtered = filterTimeline(items, { type: "TASK_DISCOVERED" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ stream: "TASK", taskId: TASK_B });
  });

  it("filters by taskId, excluding INITIATIVE rows (which have no task to match)", () => {
    const filtered = filterTimeline(items, { taskId: TASK_A });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ stream: "TASK", taskId: TASK_A });
  });

  it("combines filters", () => {
    expect(filterTimeline(items, { taskId: TASK_A, type: "TASK_DISCOVERED" })).toEqual([]);
  });
});

describe("TimelineSection — the states contract", () => {
  it("loading: the async-section skeleton", () => {
    const html = renderToStaticMarkup(
      <TimelineSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={loadingResource}
        lastFetchedAt={null}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the timeline");
  });

  it("wires every filter field to its label, including the stream select (N2's third filter)", () => {
    const html = renderToStaticMarkup(
      <TimelineSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain('for="timeline-taskId"');
    expect(html).toContain('for="timeline-type"');
    expect(html).toContain('for="timeline-stream"');
    expect(html).toContain('id="timeline-stream"');
  });

  it("stream-tagged: every row's stream is visible, not implied by position or color alone", () => {
    const html = renderToStaticMarkup(
      <TimelineSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow(), initiativeRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain(">Task<");
    expect(html).toContain(">Initiative<");
  });

  it("a roadmap-version row renders as a distinct, first-class row rather than a status transition", () => {
    const html = renderToStaticMarkup(
      <TimelineSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(
          timelineResponse([initiativeRow({ type: "ROADMAP_VERSION_RECORDED", fromStatus: "ACTIVE", toStatus: "ACTIVE" })]),
        )}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain("Roadmap version recorded");
  });

  it("respects the stream filter carried on the route", () => {
    const html = renderToStaticMarkup(
      <TimelineSection
        route={route({ query: { stream: "INITIATIVE" } })}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow(), initiativeRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    // The TASK row's own event id never renders once filtered out.
    expect(html).not.toContain("aaaaaaaa-e89b");
  });

  it("empty (with an active filter): the filtered empty message, not the unfiltered one", () => {
    const html = renderToStaticMarkup(
      <TimelineSection
        route={route({ query: { taskId: "no-such-task" } })}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain("No timeline rows match this filter.");
  });

  it("truncated: names the gap rather than silently under-reporting the timeline", () => {
    const html = renderToStaticMarkup(
      <TimelineSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow()], true))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain("truncated at the fetch ceiling");
  });

  it("an unknown initiative (404) renders the landed not-found view (C3/C5)", () => {
    const html = renderToStaticMarkup(
      <TimelineSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={{ status: "error", data: null, error: { kind: "api-error", message: "no initiative with that id was found", detail: null, status: 404 } }}
        lastFetchedAt={null}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain("Not found");
  });
});

describe("TimelineView", () => {
  it("renders a heading and an announced loading state on the very first render", () => {
    const html = renderToStaticMarkup(<TimelineView route={route()} navigate={noopNavigate} />);
    expect(html).toContain("Timeline");
    expect(html).toContain('role="status"');
  });

  it("falls back to the not-found view when the route carries no initiative id (C3)", () => {
    const html = renderToStaticMarkup(<TimelineView route={route({ initiativeId: null })} navigate={noopNavigate} />);
    expect(html).toContain("Not found");
  });
});
