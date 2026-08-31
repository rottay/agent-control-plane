import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  type InitiativeDetail,
  type InitiativeDetailResponse,
  type InitiativeQuotaConfidence,
  type InitiativeRoadmapResponse,
  type InitiativeSummary,
  type InitiativeTaskDto,
  type RoadmapVersionDto,
} from "@acp/api-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchInitiativeDetail, fetchInitiativeRoadmap } from "../../../src/api/client/index.js";
import { type Resource } from "../../../src/hooks/use-async-resource/index.js";
import { type Route } from "../../../src/routing/hash-route/index.js";
import { WorkspaceSection, WorkspaceSubnav, WorkspaceView } from "../../../src/views/workspace-view/index.js";

const INITIATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";
const DIGEST_A = "a".repeat(64);

function route(overrides: Partial<Route> = {}): Route {
  return { view: "workspace", taskId: null, workerIdentity: null, initiativeId: INITIATIVE_ID, query: {}, raw: "", ...overrides };
}

function initiativeSummary(overrides: Partial<InitiativeSummary> = {}): InitiativeSummary {
  return {
    initiativeId: INITIATIVE_ID,
    slug: "acp",
    title: "Agent Control Plane",
    objective: "Coordinate the cohort's dispatches end to end.",
    status: "ACTIVE",
    eventCount: 42,
    headRoadmapDigest: DIGEST_A,
    roadmapVersionCount: 1,
    taskCount: 2,
    rollup: { tokensUsed: 12_400, tokensReserved: 3_000, skippedMalformed: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-08-30T23:58:00.000Z",
    ...overrides,
  };
}

function taskDto(overrides: Partial<InitiativeTaskDto> = {}): InitiativeTaskDto {
  return {
    taskId: "9f2e4567-e89b-12d3-a456-426614174111",
    currentState: "RUNNING",
    eventCount: 3,
    rollup: { tokensUsed: 100, tokensReserved: 0, skippedMalformed: 0 },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-30T23:00:00.000Z",
    ...overrides,
  };
}

function quotaConfidence(overrides: Partial<InitiativeQuotaConfidence> = {}): InitiativeQuotaConfidence {
  return { confidence: "HIGH", skippedMalformed: 0, unscopedTokensUsed: 0, ...overrides };
}

function detailModel(overrides: Partial<InitiativeDetail> = {}): InitiativeDetail {
  return {
    initiative: initiativeSummary(),
    roadmap: [],
    tasks: [taskDto()],
    quota: quotaConfidence(),
    ...overrides,
  };
}

function detailResponse(overrides: Partial<InitiativeDetail> = {}): InitiativeDetailResponse {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    initiative: detailModel(overrides),
  };
}

function roadmapVersion(overrides: Partial<RoadmapVersionDto> = {}): RoadmapVersionDto {
  return {
    roadmapVersionId: "9f2e4567-e89b-12d3-a456-426614174222",
    initiativeId: INITIATIVE_ID,
    version: 1,
    contentDigest: DIGEST_A,
    parentVersionId: null,
    kind: "EDIT",
    restoresVersionId: null,
    recordedBy: "claude/opus/implementer/01",
    recordedAt: "2026-08-30T23:58:00.000Z",
    sequence: 5,
    head: true,
    ...overrides,
  };
}

function roadmapResponse(items: RoadmapVersionDto[]): InitiativeRoadmapResponse {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    initiativeId: INITIATIVE_ID,
    items,
    count: items.length,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function successResource<T>(data: T): Resource<T> {
  return { status: "success", data, error: null };
}

const loadingResource: Resource<never> = { status: "loading", data: null, error: null };

const noop = (): void => {
  // refresh/reload are not exercised in these fixture-driven renders
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkspaceSection — the fixture renders (blueprint v2 §2)", () => {
  const html = renderToStaticMarkup(
    <WorkspaceSection
      route={route()}
      initiativeId={INITIATIVE_ID}
      detailResource={successResource(detailResponse())}
      detailLastFetchedAt={new Date()}
      onRefreshDetail={noop}
      roadmapResource={successResource(roadmapResponse([roadmapVersion()]))}
      roadmapLastFetchedAt={new Date()}
      onRefreshRoadmap={noop}
    />,
  );

  it("renders the name and status badge (reading order item 1)", () => {
    expect(html).toContain('id="workspace-heading"');
    expect(html).toContain("acp");
    expect(html).toContain(">Active<");
  });

  it("renders the objective (reading order item 1)", () => {
    expect(html).toContain("Coordinate the cohort&#x27;s dispatches end to end.");
  });

  it("renders the roadmap head version, digest, kind and recordedBy (reading order item 2)", () => {
    expect(html).toContain("v1");
    expect(html).toContain("Edit");
    expect(html).toContain("claude/opus/implementer/01");
    expect(html).not.toContain(DIGEST_A);
    expect(html).toContain("aaaaaaaa"); // the truncated head, not the full digest
  });

  it("renders the work state: task count, tokens, and a state breakdown (reading order item 3)", () => {
    expect(html).toContain("12,400 used");
    expect(html).toContain("3,000 reserved");
    expect(html).toContain(">1<"); // one task in the fixture
    expect(html).toContain("Running"); // BarBreakdown's humanized state label
  });

  it("renders the quota-confidence row: the fold's confidence badge and unscoped tokens used (P8-8D C1's deferral, P8-8F)", () => {
    expect(html).toContain("Quota confidence");
    expect(html).toContain("High");
    expect(html).toContain("Unscoped tokens used");
  });

  it("carries nothing the data plane does not serve (C1)", () => {
    expect(html).not.toContain("agents active");
    expect(html).not.toContain("reset in");
  });
});

describe("WorkspaceSection — the states contract (blueprint v2 §5)", () => {
  it("loading: the outer async-section skeleton, nothing else, while the detail fetch is unresolved", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={loadingResource}
        detailLastFetchedAt={null}
        onRefreshDetail={noop}
        roadmapResource={loadingResource}
        roadmapLastFetchedAt={null}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the initiative");
    expect(html).not.toContain('id="workspace-heading"');
  });

  it("loading: the roadmap region alone shows its own skeleton once the detail resolves", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={successResource(detailResponse())}
        detailLastFetchedAt={new Date()}
        onRefreshDetail={noop}
        roadmapResource={loadingResource}
        roadmapLastFetchedAt={null}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).toContain('id="workspace-heading"'); // the header rendered
    expect(html).toContain("Loading the roadmap");
    expect(html).toContain("12,400 used"); // work state, independent of the roadmap fetch
  });

  it("empty: the roadmap's first-version affordance, no fake CTA elsewhere", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={successResource(detailResponse())}
        detailLastFetchedAt={new Date()}
        onRefreshDetail={noop}
        roadmapResource={successResource(roadmapResponse([]))}
        roadmapLastFetchedAt={new Date()}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).toContain("No roadmap version has been recorded yet.");
    expect(html).toContain("Record the first version");
  });

  it("error: the roadmap region's own error idiom, with retry, while the header still renders", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={successResource(detailResponse())}
        detailLastFetchedAt={new Date()}
        onRefreshDetail={noop}
        roadmapResource={{
          status: "error",
          data: null,
          error: { kind: "network-error", message: "The request could not reach the server.", detail: "boom", status: null },
        }}
        roadmapLastFetchedAt={null}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).toContain('id="workspace-heading"');
    expect(html).toContain("Could not load the roadmap.");
    expect(html).toContain(">Try again<");
  });

  it("degraded: skippedMalformed > 0 marks the tokens field, never a silent zero (C2)", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={successResource(
          detailResponse({ initiative: initiativeSummary({ rollup: { tokensUsed: 500, tokensReserved: 0, skippedMalformed: 2 } }) }),
        )}
        detailLastFetchedAt={new Date()}
        onRefreshDetail={noop}
        roadmapResource={successResource(roadmapResponse([roadmapVersion()]))}
        roadmapLastFetchedAt={new Date()}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).toContain("— used · — reserved");
    expect(html).not.toContain("500 used");
    expect(html).toContain("2 records were skipped as malformed");
  });

  it("quota confidence HIGH: unscoped tokens used renders a real count, never —", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={successResource(
          detailResponse({ quota: quotaConfidence({ confidence: "HIGH", unscopedTokensUsed: 4_200 }) }),
        )}
        detailLastFetchedAt={new Date()}
        onRefreshDetail={noop}
        roadmapResource={successResource(roadmapResponse([roadmapVersion()]))}
        roadmapLastFetchedAt={new Date()}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).toContain("High");
    expect(html).toContain("4,200");
  });

  it("quota confidence LOW marks the unscoped-tokens field —, with an explaining title (P8-8D C1's degraded law)", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={successResource(
          detailResponse({ quota: quotaConfidence({ confidence: "LOW", unscopedTokensUsed: 4_200 }) }),
        )}
        detailLastFetchedAt={new Date()}
        onRefreshDetail={noop}
        roadmapResource={successResource(roadmapResponse([roadmapVersion()]))}
        roadmapLastFetchedAt={new Date()}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).toContain("Low");
    expect(html).not.toContain("4,200");
    expect(html).toMatch(/title="[^"]*confidence is low[^"]*">—</);
  });

  it("a nonzero skip count on the quota fold also marks the field —, even at HIGH confidence", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={successResource(
          detailResponse({ quota: quotaConfidence({ confidence: "HIGH", skippedMalformed: 3, unscopedTokensUsed: 4_200 }) }),
        )}
        detailLastFetchedAt={new Date()}
        onRefreshDetail={noop}
        roadmapResource={successResource(roadmapResponse([roadmapVersion()]))}
        roadmapLastFetchedAt={new Date()}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).not.toContain("4,200");
    expect(html).toMatch(/title="[^"]*3 records were skipped as malformed during the unscoped quota fold[^"]*">—</);
  });
});

describe("WorkspaceSubnav — the six initiative pages (P8-8E/P8-8F, C5)", () => {
  it("renders all six links, scoped to the initiative", () => {
    const html = renderToStaticMarkup(<WorkspaceSubnav route={route()} initiativeId={INITIATIVE_ID} />);
    expect(html).toContain('href="#/i/' + INITIATIVE_ID + '"');
    expect(html).toContain('href="#/i/' + INITIATIVE_ID + '/graph"');
    expect(html).toContain('href="#/i/' + INITIATIVE_ID + '/events"');
    expect(html).toContain('href="#/i/' + INITIATIVE_ID + '/agents"');
    expect(html).toContain('href="#/i/' + INITIATIVE_ID + '/roadmap"');
    expect(html).toContain('href="#/i/' + INITIATIVE_ID + '/logs"');
  });

  it("marks the current page's link with an explicit aria-current, and no other", () => {
    const html = renderToStaticMarkup(<WorkspaceSubnav route={route({ view: "graph" })} initiativeId={INITIATIVE_ID} />);
    const overviewHref = 'href="#/i/' + INITIATIVE_ID + '"';
    const graphHref = 'href="#/i/' + INITIATIVE_ID + '/graph"';
    // The Graph link carries aria-current="page"...
    expect(html).toContain(graphHref + " aria-current=\"page\"");
    // ...and the sibling Overview link does not carry aria-current at all
    // (React omits a `false`/`undefined` boolean-ish attribute entirely
    // rather than rendering `aria-current="false"`, which is not a valid
    // token of the aria-current enumeration).
    expect(html).toContain(overviewHref);
    expect(html).not.toContain(overviewHref + " aria-current");
  });

  it("renders on the bare workspace page too, with Overview marked current", () => {
    const html = renderToStaticMarkup(<WorkspaceSubnav route={route({ view: "workspace" })} initiativeId={INITIATIVE_ID} />);
    expect(html).toMatch(/href="#\/i\/[^"]+" aria-current="page"/);
  });
});

describe("WorkspaceSection — includes the sub-navigation (P8-8E, C5)", () => {
  it("renders the four-page sub-navigation alongside the workspace content", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={successResource(detailResponse())}
        detailLastFetchedAt={new Date()}
        onRefreshDetail={noop}
        roadmapResource={successResource(roadmapResponse([roadmapVersion()]))}
        roadmapLastFetchedAt={new Date()}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).toContain('aria-label="Initiative views"');
    expect(html).toContain('href="#/i/' + INITIATIVE_ID + '/graph"');
  });
});

describe("WorkspaceView — the id-validation law (C3)", () => {
  it("falls back to the not-found view when the route carries no initiative id", () => {
    const html = renderToStaticMarkup(<WorkspaceView route={route({ initiativeId: null })} />);
    expect(html).toContain("Not found");
  });
});

describe("WorkspaceSection — an unknown initiative renders not-found (C3)", () => {
  it("renders the landed not-found view when the detail fetch answers 404", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={{
          status: "error",
          data: null,
          error: { kind: "api-error", message: "no initiative with that id was found", detail: null, status: 404 },
        }}
        detailLastFetchedAt={null}
        onRefreshDetail={noop}
        roadmapResource={loadingResource}
        roadmapLastFetchedAt={null}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).toContain("Not found");
  });

  it("renders the generic error state, not not-found, for a non-404 failure", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSection
        route={route()}
        initiativeId={INITIATIVE_ID}
        detailResource={{
          status: "error",
          data: null,
          error: { kind: "api-error", message: "the configured ledger database is not currently available", detail: null, status: 503 },
        }}
        detailLastFetchedAt={null}
        onRefreshDetail={noop}
        roadmapResource={loadingResource}
        roadmapLastFetchedAt={null}
        onRefreshRoadmap={noop}
      />,
    );
    expect(html).not.toContain("Not found");
    expect(html).toContain("Could not load the initiative.");
  });
});

describe("fetchInitiativeDetail / fetchInitiativeRoadmap — the redaction drill (C7)", () => {
  it("refuses a planted credential-shaped objective at the client parse; it renders nowhere", async () => {
    const planted = detailResponse({ initiative: initiativeSummary({ objective: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA" }) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, planted)));

    const result = await fetchInitiativeDetail(INITIATIVE_ID);

    expect(result.kind).toBe("contract-mismatch");
    if (result.kind === "contract-mismatch") {
      expect(result.detail).toContain("credential material is forbidden");
      expect(result.detail).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAA");
    }
  });

  it("refuses a planted credential-shaped recordedBy in a roadmap version at the client parse", async () => {
    const planted = roadmapResponse([roadmapVersion({ recordedBy: "sk-ant-api03-BBBBBBBBBBBBBBBBBBBB" })]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, planted)));

    const result = await fetchInitiativeRoadmap(INITIATIVE_ID);

    // recordedBy is a WorkerIdentityString; a credential-shaped value fails
    // that pattern too, so this is refused at the shape check as well as by
    // the guard — either way, the point holds: it never reaches an "ok".
    expect(result.kind).toBe("contract-mismatch");
    if (result.kind === "contract-mismatch") {
      expect(result.detail).not.toContain("sk-ant-api03-BBBBBBBBBBBBBBBBBBBB");
    }
  });
});
