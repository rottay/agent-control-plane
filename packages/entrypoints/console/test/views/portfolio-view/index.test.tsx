import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  type InitiativePortfolioResponse,
  type InitiativeSummary,
} from "@acp/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchInitiatives } from "../../../src/api/client/index.js";
import { type Resource } from "../../../src/hooks/use-async-resource/index.js";
import { PortfolioGrid, PortfolioSection } from "../../../src/views/portfolio-view/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function initiative(overrides: Partial<InitiativeSummary> = {}): InitiativeSummary {
  return {
    initiativeId: "123e4567-e89b-12d3-a456-426614174000",
    slug: "acp",
    title: "Agent Control Plane",
    objective: "Coordinate the cohort's dispatches end to end.",
    status: "ACTIVE",
    eventCount: 42,
    headRoadmapDigest: DIGEST_A,
    roadmapVersionCount: 4,
    taskCount: 12,
    rollup: { tokensUsed: 12_400, tokensReserved: 3_000, skippedMalformed: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-08-30T23:58:00.000Z",
    ...overrides,
  };
}

function portfolio(items: InitiativeSummary[]): InitiativePortfolioResponse {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
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

const noop = (): void => {
  // refresh is not exercised in these fixture-driven renders
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PortfolioGrid — the fixture portfolio renders (blueprint v2 §2)", () => {
  const acp = initiative();
  const uiDesign = initiative({
    initiativeId: "9f2e4567-e89b-12d3-a456-426614174111",
    slug: "ui-design",
    title: "UI Design System",
    objective: "Refactor the design system's engine layer.",
    status: "PAUSED",
    headRoadmapDigest: DIGEST_B,
    roadmapVersionCount: 1,
    rollup: { tokensUsed: 0, tokensReserved: 0, skippedMalformed: 0 },
  });
  const html = renderToStaticMarkup(<PortfolioGrid data={portfolio([acp, uiDesign])} />);

  it("renders each initiative's name and status, in reading order item 1", () => {
    expect(html).toContain("acp");
    expect(html).toContain("Active");
    expect(html).toContain("ui-design");
    expect(html).toContain("Paused");
  });

  it("renders the objective, clamped (reading order item 2)", () => {
    expect(html).toContain("Coordinate the cohort&#x27;s dispatches end to end.");
    expect(html).toContain("Refactor the design system&#x27;s engine layer.");
  });

  it("renders the head roadmap digest, truncated, with the version count (reading order item 3)", () => {
    expect(html).toContain("v4");
    expect(html).toContain("v1");
    expect(html).not.toContain(DIGEST_A);
    expect(html).not.toContain(DIGEST_B);
  });

  it("renders the token rollup, used and reserved, never recomputed (reading order item 4)", () => {
    expect(html).toContain("12,400 used");
    expect(html).toContain("3,000 reserved");
    expect(html).toContain("0 used");
    expect(html).toContain("0 reserved");
  });

  it("renders last activity from updatedAt, humanized, not the invented attention flag (reading order item 5, C1)", () => {
    expect(html).toContain("<time");
    expect(html).toContain(acp.updatedAt);
    expect(html).not.toContain("needs attention");
    expect(html).not.toContain("blocked task");
  });

  it("links each card to the initiative-scoped route, the name as the accessible name (C3)", () => {
    expect(html).toContain('href="#/i/123e4567-e89b-12d3-a456-426614174000"');
    expect(html).toContain('href="#/i/9f2e4567-e89b-12d3-a456-426614174111"');
  });

  it("carries a visually hidden status readout on the name-anchor link (C3)", () => {
    expect(html).toContain('<span class="sr-only">, Active</span>');
    expect(html).toContain('<span class="sr-only">, Paused</span>');
  });

  it("marks the visual status badge aria-hidden, so the name-anchor's own readout is not doubled", () => {
    expect(html).toContain('<span aria-hidden="true"><span class="badge badge--good">');
    expect(html).toContain('<span aria-hidden="true"><span class="badge badge--warn">');
  });

  it("status is never color-only: the badge's own text is present", () => {
    expect(html).toContain('class="badge__glyph"');
    expect(html).toContain(">Active<");
    expect(html).toContain(">Paused<");
  });
});

describe("PortfolioGrid — a card with no objective, slug or title", () => {
  it("falls back to a truncated id for the name and an honest 'no objective' line", () => {
    const bare = initiative({ slug: null, title: null, objective: null });
    const html = renderToStaticMarkup(<PortfolioGrid data={portfolio([bare])} />);
    expect(html).toContain("No objective recorded.");
    expect(html).toContain("123e4567"); // the truncated id's head
  });
});

describe("PortfolioSection — the states contract (blueprint v2 §7)", () => {
  it("loading: renders the landed async-section skeleton", () => {
    const html = renderToStaticMarkup(
      <PortfolioSection resource={{ status: "loading", data: null, error: null }} lastFetchedAt={null} onRefresh={noop} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the initiatives");
    expect(html).toContain("Initiatives</h1>"); // the count-free heading, honest about not knowing yet
  });

  it("empty: one honest sentence, no fake CTA (N5)", () => {
    const html = renderToStaticMarkup(
      <PortfolioSection resource={successResource(portfolio([]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(html).toContain("Nothing is observed yet.");
    expect(html).toContain("Initiatives (0)");

    // The status bar's own "Refresh" button is landed async-section chrome,
    // present in every non-loading state — it is not a fake CTA. What N5
    // rules out is a call to action *inside* the empty message itself (e.g.
    // "Create an initiative"), which a read-only surface cannot honor.
    const emptyBlockStart = html.indexOf('class="async-state async-state--empty"');
    expect(emptyBlockStart).toBeGreaterThan(-1);
    const emptyBlockEnd = html.indexOf("</div>", emptyBlockStart);
    const emptyBlockHtml = html.slice(emptyBlockStart, emptyBlockEnd);
    expect(emptyBlockHtml).not.toContain("<button");
    expect(emptyBlockHtml).not.toContain("<a ");
  });

  it("error: the landed error idiom, with the retry affordance", () => {
    const html = renderToStaticMarkup(
      <PortfolioSection
        resource={{
          status: "error",
          data: null,
          error: { kind: "contract-mismatch", message: "The response did not match the API contract this build expects.", detail: "rollup: Required", status: 200 },
        }}
        lastFetchedAt={null}
        onRefresh={noop}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load the initiatives.");
    expect(html).toContain(">Try again<");
  });

  it("degraded: skippedMalformed > 0 marks the tokens field, never a silent zero (C2)", () => {
    const degraded = initiative({ rollup: { tokensUsed: 500, tokensReserved: 0, skippedMalformed: 3 } });
    const html = renderToStaticMarkup(
      <PortfolioSection resource={successResource(portfolio([degraded]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(html).toContain("— used · — reserved");
    expect(html).not.toContain("500 used");
    expect(html).toContain("3 records were skipped as malformed");
    expect(html).toContain('title="3 records were skipped as malformed during the token rollup fold; the totals below are incomplete."');
  });

  it("a non-degraded card never carries the degraded title", () => {
    const html = renderToStaticMarkup(
      <PortfolioSection resource={successResource(portfolio([initiative()]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(html).not.toContain("skipped as malformed");
  });

  it("the count in the h1 tracks the response's own count, and nothing else joins it (§2)", () => {
    const html = renderToStaticMarkup(
      <PortfolioSection resource={successResource(portfolio([initiative(), initiative({ initiativeId: "9f2e4567-e89b-12d3-a456-426614174111" })]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(html).toContain("<h1 id=\"portfolio-heading\">Initiatives (2)</h1>");
  });
});

describe("PortfolioGrid — the rollback fixture (N6)", () => {
  it("renders the version count and head digest as the post-rollback truth, not a generic history", () => {
    // Narrative: v1 recorded DIGEST_A; v2 edited it to DIGEST_B; v3 rolled
    // back, restoring DIGEST_A's content as a *new*, third version. The head
    // digest equals v1's content again, but the count must still read 3 — a
    // client that recomputed anything, or collapsed the rollback into "the
    // same version as v1", would get this wrong. PortfolioGrid does neither:
    // it only ever prints what the response already says.
    const rolledBack = initiative({ headRoadmapDigest: DIGEST_A, roadmapVersionCount: 3 });
    const html = renderToStaticMarkup(<PortfolioGrid data={portfolio([rolledBack])} />);
    expect(html).toContain("v3");
    expect(html).not.toContain("v1");
    expect(html).not.toContain("v2");
  });

  it("renders 'no roadmap version yet' rather than a digest when the initiative has none", () => {
    const fresh = initiative({ headRoadmapDigest: null, roadmapVersionCount: 0 });
    const html = renderToStaticMarkup(<PortfolioGrid data={portfolio([fresh])} />);
    expect(html).toContain("no roadmap version yet");
  });
});

describe("fetchInitiatives — the fifth-surface redaction drill (C7)", () => {
  it("refuses a planted credential-shaped field at the client parse; it renders nowhere", async () => {
    const planted = initiative({ objective: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, portfolio([planted]))));

    const result = await fetchInitiatives();

    expect(result.kind).toBe("contract-mismatch");
    if (result.kind === "contract-mismatch") {
      expect(result.detail).toContain("credential material is forbidden");
      expect(result.detail).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAA");
    }

    // Refused at the parse means it is never `ok`, so nothing downstream —
    // PortfolioSection, PortfolioGrid — ever receives it to render. There is
    // no separate "scrub before render" step because there is nothing to
    // scrub: the value never crosses into a renderable ApiResult at all.
  });

  it("a missing rollup is a parse failure and lands in the error state (C2)", async () => {
    const withoutRollup = { ...initiative() } as Record<string, unknown>;
    delete withoutRollup["rollup"];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, portfolio([withoutRollup as unknown as InitiativeSummary]))));

    const result = await fetchInitiatives();

    expect(result.kind).toBe("contract-mismatch");
  });
});
