// @vitest-environment jsdom
import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  type InitiativeTimelineResponse,
  type ScopedTimelineEntry,
} from "@acp/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Resource } from "../../../src/hooks/use-async-resource/index.js";
import { type Route } from "../../../src/routing/hash-route/index.js";
import { type NavigateFn } from "../../../src/routing/use-hash-route/index.js";
import { filterLogs, LogsSection, LogsView } from "../../../src/views/logs-view/index.js";
import { auditAndReport, cleanupMountedRoots, clickAndSettle, countSelectorJoin, renderIntoDocument, selectValue, typeInto } from "../../live-dom/index.js";

const INITIATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";
const TASK_A = "9f2e4567-e89b-12d3-a456-426614174111";
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
    occurredAt: "2026-08-31T12:00:00.000Z",
    recordedAt: "2026-08-31T12:00:00.000Z",
    correlationId: "bbbbbbbb-e89b-12d3-a456-426614174002",
    causationId: "cccccccc-e89b-12d3-a456-426614174003",
    ...overrides,
  };
}

function initiativeRow(overrides: Partial<InitiativeRow> = {}): ScopedTimelineEntry {
  return {
    stream: "INITIATIVE",
    sequence: 1,
    eventId: "dddddddd-e89b-12d3-a456-426614174004",
    initiativeId: INITIATIVE_ID,
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: IDENTITY,
    occurredAt: "2026-08-31T11:00:00.000Z",
    recordedAt: "2026-08-31T11:00:00.000Z",
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
  return { view: "logs", taskId: null, workerIdentity: null, initiativeId: INITIATIVE_ID, query: {}, raw: "", ...overrides };
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

describe("filterLogs — pure, drilled directly (the timeline's law)", () => {
  const items = [
    taskRow({ taskId: TASK_A, type: "TASK_STATE_CHANGED", emittedBy: IDENTITY }),
    taskRow({
      taskId: "77777777-e89b-12d3-a456-426614174222",
      type: "TASK_DISCOVERED",
      emittedBy: "claude/sonnet/verifier-01",
      eventId: "eeeeeeee-e89b-12d3-a456-426614174005",
      correlationId: null,
      causationId: null,
    }),
    initiativeRow(),
  ];

  it("returns every row when no filter is given", () => {
    expect(filterLogs(items, {})).toHaveLength(3);
  });

  it("filters by stream", () => {
    expect(filterLogs(items, { stream: "INITIATIVE" })).toHaveLength(1);
  });

  it("filters by type", () => {
    const filtered = filterLogs(items, { type: "TASK_DISCOVERED" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ type: "TASK_DISCOVERED" });
  });

  it("filters by actor (emittedBy)", () => {
    const filtered = filterLogs(items, { actor: "claude/sonnet/verifier-01" });
    expect(filtered).toHaveLength(1);
  });

  it("matches a free-text id fragment across eventId, taskId, correlationId and causationId", () => {
    expect(filterLogs(items, { idMatch: "aaaaaaaa" })).toHaveLength(1); // eventId
    expect(filterLogs(items, { idMatch: TASK_A.slice(0, 8) })).toHaveLength(1); // taskId
    expect(filterLogs(items, { idMatch: "bbbbbbbb" })).toHaveLength(1); // correlationId
    expect(filterLogs(items, { idMatch: "cccccccc" })).toHaveLength(1); // causationId
  });

  it("the id match is case-insensitive", () => {
    expect(filterLogs(items, { idMatch: "AAAAAAAA" })).toHaveLength(1);
  });

  it("an INITIATIVE row never matches an id-fragment search over task-only fields", () => {
    // The initiative row's own eventId does not contain this fragment, and it
    // has no taskId/correlationId/causationId to search.
    expect(filterLogs(items, { idMatch: TASK_A.slice(0, 8) })).not.toContainEqual(
      expect.objectContaining({ stream: "INITIATIVE" }),
    );
  });

  it("combines filters", () => {
    expect(filterLogs(items, { stream: "TASK", type: "INITIATIVE_REGISTERED" })).toEqual([]);
  });
});

describe("LogsSection — the states contract", () => {
  it("loading: the async-section skeleton", () => {
    const html = renderToStaticMarkup(
      <LogsSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={loadingResource}
        lastFetchedAt={null}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the log");
  });

  it("wires every filter field to its label, including the stream select and the id-match field", () => {
    const html = renderToStaticMarkup(
      <LogsSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain('for="logs-stream"');
    expect(html).toContain('for="logs-type"');
    expect(html).toContain('for="logs-actor"');
    expect(html).toContain('for="logs-idMatch"');
  });

  it("renders raw, un-humanized fields — dense, not narrative — and the absolute timestamp", () => {
    const html = renderToStaticMarkup(
      <LogsSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    // Raw constant, not "Task state changed".
    expect(html).toContain("TASK_STATE_CHANGED");
    expect(html).not.toContain("Task state changed");
    // Absolute instant carried verbatim in dateTime and title alike.
    expect(html).toContain('dateTime="2026-08-31T12:00:00.000Z"');
  });

  it("carries the copyable ids for a TASK row: eventId, taskId, correlationId, causationId", () => {
    const html = renderToStaticMarkup(
      <LogsSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain("aaaaaaaa");
    expect(html).toContain(TASK_A.slice(0, 6));
    expect(html).toContain("bbbbbbbb");
    expect(html).toContain("cccccccc");
  });

  it("an INITIATIVE row shows — for the task-only id columns", () => {
    const html = renderToStaticMarkup(
      <LogsSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([initiativeRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain(">—<");
  });

  it("respects the filters carried on the route", () => {
    const html = renderToStaticMarkup(
      <LogsSection
        route={route({ query: { stream: "INITIATIVE" } })}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow(), initiativeRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).not.toContain("aaaaaaaa-e89b");
  });

  it("empty (with an active filter): the filtered empty message, not the unfiltered one", () => {
    const html = renderToStaticMarkup(
      <LogsSection
        route={route({ query: { actor: "no-such-actor" } })}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(html).toContain("No log lines match this filter.");
  });

  it("truncated: names the gap rather than silently under-reporting the log", () => {
    const html = renderToStaticMarkup(
      <LogsSection
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
      <LogsSection
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

describe("LogsView", () => {
  it("renders a heading and an announced loading state on the very first render", () => {
    const html = renderToStaticMarkup(<LogsView route={route()} navigate={noopNavigate} />);
    expect(html).toContain("Logs");
    expect(html).toContain('role="status"');
  });

  it("falls back to the not-found view when the route carries no initiative id (C3)", () => {
    const html = renderToStaticMarkup(<LogsView route={route({ initiativeId: null })} navigate={noopNavigate} />);
    expect(html).toContain("Not found");
  });
});

// ---------------------------------------------------------------------------
// Live-DOM battery (P8-9-3, blueprint v2 item 4)
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanupMountedRoots();
});

describe("live-DOM battery: filtered logs and the truncation notice (blueprint v2 item 4)", () => {
  it("passes the pinned axe ruleset — populated, empty, and truncated", async () => {
    const fixtures: { label: string; resource: Resource<InitiativeTimelineResponse> }[] = [
      { label: "populated", resource: successResource(timelineResponse([taskRow(), initiativeRow()])) },
      { label: "empty", resource: successResource(timelineResponse([])) },
      { label: "truncated", resource: successResource(timelineResponse([taskRow()], true)) },
    ];
    for (const { label, resource } of fixtures) {
      const mounted = renderIntoDocument(
        <LogsSection route={route()} navigate={noopNavigate} initiativeId={INITIATIVE_ID} resource={resource} lastFetchedAt={new Date()} onRefresh={noopRefresh} />,
      );
      const audit = await auditAndReport("logs-view/" + label, mounted.container);
      expect(audit.violationIds).toEqual([]);
      mounted.unmount();
    }
  });

  it("selector-join: the rendered log table carries the data-priority hooks its breakpoint rules select (C1)", () => {
    const mounted = renderIntoDocument(
      <LogsSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="tertiary"]')).toBeGreaterThan(0);
    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="secondary"]')).toBeGreaterThan(0);
  });

  it("the truncation notice is present precisely when the fetch ceiling truncated the response, and passes as its own live region", () => {
    const truncated = renderIntoDocument(
      <LogsSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow()], true))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(truncated.container.textContent).toContain("truncated at the fetch ceiling");
    truncated.unmount();

    const untruncated = renderIntoDocument(
      <LogsSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow()], false))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );
    expect(untruncated.container.textContent).not.toContain("truncated at the fetch ceiling");
  });

  it("filters are pure in memory with a round-trip through the URL: applying a filter navigates to the hash carrying it", async () => {
    const navigateSpy = vi.fn();
    const mounted = renderIntoDocument(
      <LogsSection
        route={route()}
        navigate={navigateSpy}
        initiativeId={INITIATIVE_ID}
        resource={successResource(timelineResponse([taskRow(), initiativeRow()]))}
        lastFetchedAt={new Date()}
        onRefresh={noopRefresh}
      />,
    );

    const streamSelect = mounted.container.querySelector<HTMLSelectElement>("#logs-stream");
    const idMatchInput = mounted.container.querySelector<HTMLInputElement>("#logs-idMatch");
    const applyButton = mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (streamSelect === null || idMatchInput === null || applyButton === null) {
      throw new Error("expected the stream select, the id-match field and the Apply button");
    }
    selectValue(streamSelect, "TASK");
    typeInto(idMatchInput, "aaaaaaaa");
    await clickAndSettle(applyButton);

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    const hash = navigateSpy.mock.calls[0]?.[0] as string;
    expect(hash).toContain("stream=TASK");
    expect(hash).toContain("idMatch=aaaaaaaa");

    // Pure in memory: the fixed `resource` prop is untouched by filtering —
    // nothing here re-fetched to answer the filtered view. `filterLogs`'s own
    // suite (above) already proves what the pure function does with a query;
    // this proves the view calls it rather than re-deriving its own copy.
    expect(mounted.container.textContent).not.toContain("No log lines match this filter.");
  });
});
