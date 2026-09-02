import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  type InitiativeAgentsResponse,
  type ScopedAgentSummary,
} from "@acp/protocol";
// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { type Resource } from "../../../src/hooks/use-async-resource/index.js";
import { type Route } from "../../../src/routing/hash-route/index.js";
import { AgentsSection, AgentsView } from "../../../src/views/agents-view/index.js";
import { auditAndReport, cleanupMountedRoots, renderIntoDocument } from "../../live-dom/index.js";

const INITIATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";
const TASK_A = "9f2e4567-e89b-12d3-a456-426614174111";
const IDENTITY = "claude/opus/implementer/01";

function agentSummary(overrides: Partial<ScopedAgentSummary> = {}): ScopedAgentSummary {
  return {
    identity: IDENTITY,
    provider: "claude",
    model: "opus",
    role: "implementer",
    instance: "01",
    eventCount: 12,
    taskCount: 3,
    firstSeenAt: "2026-08-30T10:00:00.000Z",
    lastSeenAt: "2026-08-30T12:00:00.000Z",
    currentTaskId: TASK_A,
    lastEventType: "TASK_STATE_CHANGED",
    ...overrides,
  };
}

function agentsResponse(items: ScopedAgentSummary[]): InitiativeAgentsResponse {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    initiativeId: INITIATIVE_ID,
    items,
    count: items.length,
  };
}

function route(overrides: Partial<Route> = {}): Route {
  return { view: "agents", taskId: null, workerIdentity: null, initiativeId: INITIATIVE_ID, query: {}, raw: "", ...overrides };
}

function successResource<T>(data: T): Resource<T> {
  return { status: "success", data, error: null };
}

const loadingResource: Resource<never> = { status: "loading", data: null, error: null };
const noop = (): void => {
  // refresh is not exercised in these fixture-driven renders
};

describe("AgentsSection — the states contract", () => {
  it("loading: the async-section skeleton", () => {
    const html = renderToStaticMarkup(
      <AgentsSection route={route()} initiativeId={INITIATIVE_ID} resource={loadingResource} lastFetchedAt={null} onRefresh={noop} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the agents");
  });

  it("empty: no worker has acted on this initiative yet", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={successResource(agentsResponse([]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("No worker has acted on this initiative yet.");
  });

  it("renders identity, role, the scoped current task and the last action (blueprint §3)", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={successResource(agentsResponse([agentSummary()]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain(IDENTITY);
    expect(html).toContain("Implementer");
    expect(html).toContain(TASK_A.slice(0, 6));
    expect(html).toContain("Task state changed");
  });

  it("role is rendered via the landed StatusBadge component, never color alone", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={successResource(agentsResponse([agentSummary({ role: "verifier" })]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("badge--neutral");
    expect(html).toContain("Verifier");
  });

  it("renders one row per distinct worker identity", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={successResource(
          agentsResponse([agentSummary({ identity: IDENTITY }), agentSummary({ identity: "claude/sonnet/verifier-01" })]),
        )}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain(IDENTITY);
    expect(html).toContain("claude/sonnet/verifier-01");
  });

  it("an unknown initiative (404) renders the landed not-found view (C3/C5)", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
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
      <AgentsSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={{ status: "error", data: null, error: { kind: "api-error", message: "the configured ledger database is not currently available", detail: null, status: 503 } }}
        lastFetchedAt={null}
        onRefresh={noop}
      />,
    );
    expect(html).not.toContain("Not found");
    expect(html).toContain("Could not load the agents.");
  });
});

describe("AgentsView", () => {
  it("renders a heading and an announced loading state on the very first render", () => {
    const html = renderToStaticMarkup(<AgentsView route={route()} />);
    expect(html).toContain("Agents");
    expect(html).toContain('role="status"');
  });

  it("falls back to the not-found view when the route carries no initiative id (C3)", () => {
    const html = renderToStaticMarkup(<AgentsView route={route({ initiativeId: null })} />);
    expect(html).toContain("Not found");
  });
});

// ---------------------------------------------------------------------------
// Live-DOM battery (P8-9-3, blueprint v2 item 9, C3 restored)
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanupMountedRoots();
});

describe("live-DOM battery: active agents, current action, empty/degraded (blueprint v2 item 9, C3 restored)", () => {
  it("passes the pinned axe ruleset — active agents, empty, and a stale-degraded fetch", async () => {
    const fixtures: { label: string; resource: Resource<InitiativeAgentsResponse> }[] = [
      { label: "active-agents", resource: successResource(agentsResponse([agentSummary(), agentSummary({ identity: "claude/sonnet/verifier-01" })])) },
      { label: "empty", resource: successResource(agentsResponse([])) },
      {
        label: "stale-degraded",
        resource: {
          status: "stale",
          data: agentsResponse([agentSummary()]),
          error: { kind: "network-error", message: "The request could not reach the server.", detail: null, status: null },
        },
      },
    ];
    for (const { label, resource } of fixtures) {
      const mounted = renderIntoDocument(<AgentsSection route={route()} initiativeId={INITIATIVE_ID} resource={resource} lastFetchedAt={new Date()} onRefresh={noop} />);
      const audit = await auditAndReport("agents-view/" + label, mounted.container);
      expect(audit.violationIds).toEqual([]);
      mounted.unmount();
    }
  });

  it("an active agent renders its identity, role and current action live", () => {
    const mounted = renderIntoDocument(
      <AgentsSection route={route()} initiativeId={INITIATIVE_ID} resource={successResource(agentsResponse([agentSummary()]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(mounted.container.textContent).toContain(IDENTITY);
    expect(mounted.container.textContent).toContain("Implementer");
    expect(mounted.container.textContent).toContain(TASK_A.slice(0, 6));
    expect(mounted.container.textContent).toContain("Task state changed");
  });

  it("degraded (stale): last-known agents stay visible rather than vanishing behind a refresh hiccup", () => {
    const mounted = renderIntoDocument(
      <AgentsSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        resource={{
          status: "stale",
          data: agentsResponse([agentSummary()]),
          error: { kind: "network-error", message: "The request could not reach the server.", detail: null, status: null },
        }}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(mounted.container.textContent).toContain(IDENTITY);
  });

  it("the empty state renders live, naming that no worker has acted", () => {
    const mounted = renderIntoDocument(
      <AgentsSection route={route()} initiativeId={INITIATIVE_ID} resource={successResource(agentsResponse([]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(mounted.container.textContent).toContain("No worker has acted on this initiative yet.");
  });
});
