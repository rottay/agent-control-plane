import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Route } from "../../src/routing/hash-route/index.js";
import { EventsView } from "../../src/views/events-view/index.js";
import { IntegrityView } from "../../src/views/integrity-view/index.js";
import { OverviewView } from "../../src/views/overview-view/index.js";
import { StatusView } from "../../src/views/status-view/index.js";
import { TaskDetailView } from "../../src/views/task-detail-view/index.js";
import { TasksListView } from "../../src/views/tasks-list-view/index.js";
import { WorkerDetailView } from "../../src/views/worker-detail-view/index.js";
import { WorkersListView } from "../../src/views/workers-list-view/index.js";
import { WorkspaceView } from "../../src/views/workspace-view/index.js";

/**
 * These views load their data through an effect, and effects do not run
 * under `renderToStaticMarkup` (there is no jsdom in this dependency graph —
 * see vitest.config.ts). Every render below therefore observes the view in
 * its initial loading state. That is still worth asserting: the heading, the
 * announced loading status, and every filter/jump form's label wiring are
 * all present on the very first render, before any network response exists.
 */

function route(overrides: Partial<Route>): Route {
  return { view: "overview", taskId: null, workerIdentity: null, initiativeId: null, query: {}, raw: "", ...overrides };
}

const noop = (): void => {
  // navigation is not exercised in a loading-state smoke test
};

describe("OverviewView", () => {
  it("renders a heading and an announced loading state", () => {
    const html = renderToStaticMarkup(<OverviewView />);
    expect(html).toContain("<h1");
    expect(html).toContain("Overview");
    expect(html).toContain('role="status"');
  });
});

describe("StatusView", () => {
  it("renders a heading and an announced loading state", () => {
    const html = renderToStaticMarkup(<StatusView />);
    expect(html).toContain("Ledger status");
    expect(html).toContain('role="status"');
  });
});

describe("IntegrityView", () => {
  it("renders a heading and an announced loading state", () => {
    const html = renderToStaticMarkup(<IntegrityView />);
    expect(html).toContain("Integrity");
    expect(html).toContain('role="status"');
  });
});

describe("TasksListView", () => {
  it("wires the jump-by-id form and the state filter field to their labels", () => {
    const html = renderToStaticMarkup(<TasksListView route={route({ view: "tasks" })} navigate={noop} />);
    expect(html).toContain('for="task-jump"');
    expect(html).toContain('id="task-jump"');
    expect(html).toContain('for="tasks-state"');
    expect(html).toContain('id="tasks-state"');
    expect(html).toContain('role="search"');
  });
});

describe("WorkersListView", () => {
  it("wires the jump-by-identity form and the role/provider filter fields to their labels", () => {
    const html = renderToStaticMarkup(<WorkersListView route={route({ view: "workers" })} navigate={noop} />);
    expect(html).toContain('for="worker-jump"');
    expect(html).toContain('for="workers-role"');
    expect(html).toContain('for="workers-provider"');
  });
});

describe("EventsView", () => {
  it("wires every filter field to its label", () => {
    const html = renderToStaticMarkup(<EventsView route={route({ view: "events" })} navigate={noop} />);
    expect(html).toContain('for="events-taskId"');
    expect(html).toContain('for="events-type"');
    expect(html).toContain('for="events-emittedBy"');
    expect(html).toContain('for="events-toState"');
  });
});

describe("TaskDetailView", () => {
  it("renders the task id and an announced loading state when the id is present", () => {
    const html = renderToStaticMarkup(
      <TaskDetailView route={route({ view: "task-detail", taskId: "123e4567-e89b-12d3-a456-426614174000" })} />,
    );
    expect(html).toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(html).toContain('role="status"');
  });

  it("falls back to the not-found view when the route carries no task id", () => {
    const html = renderToStaticMarkup(<TaskDetailView route={route({ view: "task-detail", taskId: null })} />);
    expect(html).toContain("Not found");
  });
});

describe("WorkspaceView", () => {
  it("renders an announced loading state when the route carries an initiative id", () => {
    // Unlike every view above, the workspace has no static title to show
    // before the fetch resolves — "Overview" is known in advance, but this
    // view's own heading is the initiative's name, which is earned by the
    // fetch. The loading state is therefore the landed async-section
    // skeleton alone, with no `<h1>` yet: asserted as what is actually
    // there, not a heading this render cannot honestly show.
    const html = renderToStaticMarkup(
      <WorkspaceView route={route({ view: "workspace", initiativeId: "123e4567-e89b-12d3-a456-426614174000" })} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the initiative");
  });

  it("falls back to the not-found view when the route carries no initiative id", () => {
    const html = renderToStaticMarkup(<WorkspaceView route={route({ view: "workspace", initiativeId: null })} />);
    expect(html).toContain("Not found");
  });
});

describe("WorkerDetailView", () => {
  it("renders the worker identity and an announced loading state when present", () => {
    const html = renderToStaticMarkup(
      <WorkerDetailView route={route({ view: "worker-detail", workerIdentity: "claude/opus/implementer/01" })} />,
    );
    expect(html).toContain("claude/opus/implementer/01");
    expect(html).toContain('role="status"');
  });

  it("falls back to the not-found view when the route carries no identity", () => {
    const html = renderToStaticMarkup(<WorkerDetailView route={route({ view: "worker-detail", workerIdentity: null })} />);
    expect(html).toContain("Not found");
  });
});
