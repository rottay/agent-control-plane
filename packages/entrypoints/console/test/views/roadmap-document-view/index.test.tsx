import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  type InitiativeRoadmapResponse,
  type RoadmapContentResponse,
  type RoadmapVersionDto,
} from "@acp/protocol";
// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Resource } from "../../../src/hooks/use-async-resource/index.js";
import { type Route } from "../../../src/routing/hash-route/index.js";
import { type NavigateFn } from "../../../src/routing/use-hash-route/index.js";
import { RoadmapDocumentSection, RoadmapDocumentView } from "../../../src/views/roadmap-document-view/index.js";
import { auditAndReport, cleanupMountedRoots, renderIntoDocument, selectValue } from "../../live-dom/index.js";

const INITIATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";
const DIGEST_A = "a".repeat(64);
const IDENTITY = "claude/opus/implementer/01";

function versionItem(overrides: Partial<RoadmapVersionDto> = {}): RoadmapVersionDto {
  return {
    roadmapVersionId: "9f2e4567-e89b-12d3-a456-426614174222",
    initiativeId: INITIATIVE_ID,
    version: 1,
    contentDigest: DIGEST_A,
    parentVersionId: null,
    kind: "EDIT",
    restoresVersionId: null,
    recordedBy: IDENTITY,
    recordedAt: "2026-08-31T12:00:00.000Z",
    sequence: 1,
    head: true,
    ...overrides,
  };
}

function historyResponse(items: RoadmapVersionDto[]): InitiativeRoadmapResponse {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    initiativeId: INITIATIVE_ID,
    items,
    count: items.length,
  };
}

function contentResponse(overrides: Partial<RoadmapContentResponse> = {}): RoadmapContentResponse {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    initiativeId: INITIATIVE_ID,
    version: 1,
    contentDigest: DIGEST_A,
    kind: "EDIT",
    content: "# Roadmap\n\nDocument body, verbatim.",
    ...overrides,
  };
}

function route(overrides: Partial<Route> = {}): Route {
  return {
    view: "roadmap-document",
    taskId: null,
    workerIdentity: null,
    initiativeId: INITIATIVE_ID,
    query: {},
    raw: "",
    ...overrides,
  };
}

function successResource<T>(data: T): Resource<T> {
  return { status: "success", data, error: null };
}

const loadingResource: Resource<never> = { status: "loading", data: null, error: null };
const noopNavigate: NavigateFn = () => {
  // navigation is not exercised in these fixture-driven renders
};
const noopRefresh = (): void => {
  // refresh is not exercised in these fixture-driven renders
};

describe("RoadmapDocumentSection — the states contract", () => {
  it("loading: the history region's own skeleton", () => {
    const html = renderToStaticMarkup(
      <RoadmapDocumentSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={loadingResource}
        historyLastFetchedAt={null}
        onRefreshHistory={noopRefresh}
        resolvedVersion={null}
        contentResource={loadingResource}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the roadmap history");
  });

  it("no versions: the named empty state, pointing at the workspace's first-version affordance", () => {
    const html = renderToStaticMarkup(
      <RoadmapDocumentSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(historyResponse([]))}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={null}
        contentResource={loadingResource}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(html).toContain("No roadmap version has been recorded yet.");
    expect(html).toContain("Record the first version from the workspace");
    expect(html).toContain('href="#/i/' + INITIATIVE_ID + '"');
  });

  it("renders the head version by default: kind badge, digest, recordedBy, recorded-at, and the document bytes verbatim", () => {
    const html = renderToStaticMarkup(
      <RoadmapDocumentSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(historyResponse([versionItem()]))}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={1}
        contentResource={successResource(contentResponse())}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(html).toContain("v1");
    expect(html).toContain("Edit");
    expect(html).toContain(IDENTITY);
    // IdValue always exposes the full value to assistive technology (an
    // sr-only span), so the full digest legitimately appears in the markup;
    // what matters is that the truncated, visible form is present too.
    expect(html).toContain("aaaaaaaa…aaaaaa");
    expect(html).toContain("# Roadmap");
    expect(html).toContain("Document body, verbatim.");
  });

  it("the version selector lists every version, newest first as the endpoint orders them, head marked", () => {
    const html = renderToStaticMarkup(
      <RoadmapDocumentSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(
          historyResponse([
            versionItem({ roadmapVersionId: "v2", version: 2, head: true }),
            versionItem({ roadmapVersionId: "v1", version: 1, head: false }),
          ]),
        )}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={2}
        contentResource={successResource(contentResponse({ version: 2 }))}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(html).toContain('id="roadmap-document-version"');
    expect(html).toContain("(head)");
    expect(html).toContain('value="1"');
    expect(html).toContain('value="2"');
  });

  it("a deep-linked ?version= selects a non-head version explicitly", () => {
    const html = renderToStaticMarkup(
      <RoadmapDocumentSection
        route={route({ query: { version: "1" } })}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(
          historyResponse([
            versionItem({ roadmapVersionId: "v2", version: 2, head: true }),
            versionItem({ roadmapVersionId: "v1", version: 1, head: false, kind: "ROLLBACK" }),
          ]),
        )}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={1}
        contentResource={successResource(contentResponse({ version: 1, kind: "ROLLBACK" }))}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(html).toContain("v1");
    expect(html).toContain("Rollback");
  });

  it("only the two landed kinds ever render as the contract kind (v2, C3)", () => {
    const html = renderToStaticMarkup(
      <RoadmapDocumentSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(historyResponse([versionItem({ kind: "ROLLBACK" })]))}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={1}
        contentResource={successResource(contentResponse({ kind: "ROLLBACK" }))}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(html).toContain("Rollback");
  });

  it("unknown version: the named state, not a silent fall to head", () => {
    const html = renderToStaticMarkup(
      <RoadmapDocumentSection
        route={route({ query: { version: "99" } })}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(historyResponse([versionItem()]))}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={99}
        contentResource={{
          status: "error",
          data: null,
          error: { kind: "api-error", message: "no roadmap version with that number was found", detail: null, status: 404 },
        }}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(html).toContain("Version 99 was not found for this initiative.");
    // Not the head version's own content.
    expect(html).not.toContain("Document body, verbatim.");
  });

  it("the edit affordance is a single link back to the workspace, and nothing here writes", () => {
    const html = renderToStaticMarkup(
      <RoadmapDocumentSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(historyResponse([versionItem()]))}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={1}
        contentResource={successResource(contentResponse())}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(html).toContain('href="#/i/' + INITIATIVE_ID + '"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<textarea");
  });

  it("an unknown initiative (404, from the history fetch) renders the landed not-found view (C3/C5)", () => {
    const html = renderToStaticMarkup(
      <RoadmapDocumentSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={{
          status: "error",
          data: null,
          error: { kind: "api-error", message: "no initiative with that id was found", detail: null, status: 404 },
        }}
        historyLastFetchedAt={null}
        onRefreshHistory={noopRefresh}
        resolvedVersion={null}
        contentResource={loadingResource}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(html).toContain("Not found");
  });
});

describe("RoadmapDocumentView", () => {
  it("renders a heading and an announced loading state on the very first render", () => {
    const html = renderToStaticMarkup(<RoadmapDocumentView route={route()} navigate={noopNavigate} />);
    expect(html).toContain("Roadmap document");
    expect(html).toContain('role="status"');
  });

  it("falls back to the not-found view when the route carries no initiative id (C3)", () => {
    const html = renderToStaticMarkup(<RoadmapDocumentView route={route({ initiativeId: null })} navigate={noopNavigate} />);
    expect(html).toContain("Not found");
  });
});

// ---------------------------------------------------------------------------
// Live-DOM battery (P8-9-3, blueprint v2 item 5)
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanupMountedRoots();
});

describe("live-DOM battery: the document view — version select, deep link, unknown-version (blueprint v2 item 5)", () => {
  it("passes the pinned axe ruleset — the head version and the unknown-version state", async () => {
    const headMount = renderIntoDocument(
      <RoadmapDocumentSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(historyResponse([versionItem()]))}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={1}
        contentResource={successResource(contentResponse())}
        onRefreshContent={noopRefresh}
      />,
    );
    const headAudit = await auditAndReport("roadmap-document-view/head-version", headMount.container);
    expect(headAudit.violationIds).toEqual([]);
    headMount.unmount();

    const unknownMount = renderIntoDocument(
      <RoadmapDocumentSection
        route={route({ query: { version: "99" } })}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(historyResponse([versionItem()]))}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={99}
        contentResource={{
          status: "error",
          data: null,
          error: { kind: "api-error", message: "no roadmap version with that number was found", detail: null, status: 404 },
        }}
        onRefreshContent={noopRefresh}
      />,
    );
    const unknownAudit = await auditAndReport("roadmap-document-view/unknown-version", unknownMount.container);
    expect(unknownAudit.violationIds).toEqual([]);
  });

  it("the unknown-version state is distinguished from the initiative-level 404 (C3/C5) — different named states, not the same not-found view", () => {
    const unknownVersion = renderIntoDocument(
      <RoadmapDocumentSection
        route={route({ query: { version: "99" } })}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(historyResponse([versionItem()]))}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={99}
        contentResource={{
          status: "error",
          data: null,
          error: { kind: "api-error", message: "no roadmap version with that number was found", detail: null, status: 404 },
        }}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(unknownVersion.container.textContent).toContain("Version 99 was not found for this initiative.");
    expect(unknownVersion.container.textContent).not.toContain("Not found");
    unknownVersion.unmount();

    const unknownInitiative = renderIntoDocument(
      <RoadmapDocumentSection
        route={route()}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={{
          status: "error",
          data: null,
          error: { kind: "api-error", message: "no initiative with that id was found", detail: null, status: 404 },
        }}
        historyLastFetchedAt={null}
        onRefreshHistory={noopRefresh}
        resolvedVersion={null}
        contentResource={loadingResource}
        onRefreshContent={noopRefresh}
      />,
    );
    expect(unknownInitiative.container.textContent).toContain("Not found");
  });

  it("the version select is operable by keyboard (N3): a real selection navigates to the picked version's deep link", () => {
    const navigateSpy = vi.fn();
    const mounted = renderIntoDocument(
      <RoadmapDocumentSection
        route={route()}
        navigate={navigateSpy}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(
          historyResponse([
            versionItem({ roadmapVersionId: "v2", version: 2, head: true }),
            versionItem({ roadmapVersionId: "v1", version: 1, head: false }),
          ]),
        )}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={2}
        contentResource={successResource(contentResponse({ version: 2 }))}
        onRefreshContent={noopRefresh}
      />,
    );

    const select = mounted.container.querySelector<HTMLSelectElement>("#roadmap-document-version");
    if (select === null) throw new Error("expected the version select");
    selectValue(select, "1");

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    const hash = navigateSpy.mock.calls[0]?.[0] as string;
    expect(hash).toContain("version=1");
  });

  it("a deep-linked ?version= renders live in the DOM, not only in a static string", () => {
    const mounted = renderIntoDocument(
      <RoadmapDocumentSection
        route={route({ query: { version: "1" } })}
        navigate={noopNavigate}
        initiativeId={INITIATIVE_ID}
        historyResource={successResource(
          historyResponse([
            versionItem({ roadmapVersionId: "v2", version: 2, head: true }),
            versionItem({ roadmapVersionId: "v1", version: 1, head: false, kind: "ROLLBACK" }),
          ]),
        )}
        historyLastFetchedAt={new Date()}
        onRefreshHistory={noopRefresh}
        resolvedVersion={1}
        contentResource={successResource(contentResponse({ version: 1, kind: "ROLLBACK" }))}
        onRefreshContent={noopRefresh}
      />,
    );
    const select = mounted.container.querySelector<HTMLSelectElement>("#roadmap-document-version");
    expect(select?.value).toBe("1");
    expect(mounted.container.textContent).toContain("Rollback");
  });
});
