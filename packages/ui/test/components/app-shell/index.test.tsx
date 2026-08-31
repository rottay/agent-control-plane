import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Route } from "../../../src/routing/hash-route/index.js";
import { AppShell } from "../../../src/components/app-shell/index.js";

function route(view: Route["view"], initiativeId: string | null = null): Route {
  return { view, taskId: null, workerIdentity: null, initiativeId, query: {}, raw: "" };
}

describe("AppShell", () => {
  it("renders a skip link as the first focusable element, targeting main content", () => {
    const html = renderToStaticMarkup(
      <AppShell route={route("overview")}>
        <p>content</p>
      </AppShell>,
    );
    const skipIndex = html.indexOf('href="#main-content"');
    const mainIndex = html.indexOf('id="main-content"');
    expect(skipIndex).toBeGreaterThan(-1);
    expect(mainIndex).toBeGreaterThan(-1);
    expect(skipIndex).toBeLessThan(mainIndex);
  });

  it("declares the primary landmarks", () => {
    const html = renderToStaticMarkup(
      <AppShell route={route("overview")}>
        <p>content</p>
      </AppShell>,
    );
    expect(html).toContain("<header");
    expect(html).toContain('<nav class="app-shell__nav" aria-label="Primary"');
    expect(html).toContain('<main id="main-content"');
    expect(html).toContain("<footer");
  });

  it("marks the current view's nav entry with aria-current", () => {
    const html = renderToStaticMarkup(
      <AppShell route={route("tasks")}>
        <p>content</p>
      </AppShell>,
    );
    expect(html).toContain('aria-current="page"');
  });

  it("also marks the tasks nav entry current while viewing a task's detail", () => {
    const html = renderToStaticMarkup(
      <AppShell route={route("task-detail")}>
        <p>content</p>
      </AppShell>,
    );
    expect(html).toContain('aria-current="page"');
  });

  it("renders the child content inside main", () => {
    const html = renderToStaticMarkup(
      <AppShell route={route("overview")}>
        <p>unique-marker-content</p>
      </AppShell>,
    );
    const mainIndex = html.indexOf("<main");
    expect(html.indexOf("unique-marker-content")).toBeGreaterThan(mainIndex);
  });

  it("marks no primary nav entry current while viewing the workspace (P8-8D)", () => {
    // The workspace is reached from the switcher, not the primary nav —
    // `navMatches` names no entry for it, deliberately: NAV_ITEMS lists the
    // six read views the header always offers, and the workspace is a
    // seventh place a route can be, not an eighth item to add there.
    const html = renderToStaticMarkup(
      <AppShell route={route("workspace", "123e4567-e89b-12d3-a456-426614174000")}>
        <p>content</p>
      </AppShell>,
    );
    expect(html).not.toContain('aria-current="page"');
  });

  describe("the initiative switcher (P8-8C, blueprint v2 §4)", () => {
    it("places the switcher trigger after the skip link and before the primary nav", () => {
      const html = renderToStaticMarkup(
        <AppShell route={route("overview")}>
          <p>content</p>
        </AppShell>,
      );
      const skipIndex = html.indexOf('href="#main-content"');
      const triggerIndex = html.indexOf('class="switcher__trigger"');
      const navIndex = html.indexOf('class="app-shell__nav"');
      expect(skipIndex).toBeGreaterThan(-1);
      expect(triggerIndex).toBeGreaterThan(-1);
      expect(navIndex).toBeGreaterThan(-1);
      expect(skipIndex).toBeLessThan(triggerIndex);
      expect(triggerIndex).toBeLessThan(navIndex);
    });

    it("rests on 'All initiatives' on a route with no initiative id (N2)", () => {
      const html = renderToStaticMarkup(
        <AppShell route={route("overview")}>
          <p>content</p>
        </AppShell>,
      );
      expect(html).toContain("All initiatives");
    });

    it("rests on the literal ellipsis for a route naming an initiative that has not resolved", () => {
      // The switcher's own fetch runs in an effect, and effects do not run
      // under renderToStaticMarkup (no DOM environment — C5): the initiative
      // list is always unresolved here, so a route naming one can never be
      // matched to a name and the honest fallback is the one this asserts.
      const html = renderToStaticMarkup(
        <AppShell route={route("tasks", "123e4567-e89b-12d3-a456-426614174000")}>
          <p>content</p>
        </AppShell>,
      );
      const triggerStart = html.indexOf('class="switcher__trigger"');
      const triggerEnd = html.indexOf("</button>", triggerStart);
      const triggerHtml = html.slice(triggerStart, triggerEnd);
      expect(triggerHtml).toContain("…");
      expect(triggerHtml).not.toContain("All initiatives");
    });

    /**
     * Corrected by the live-evidence round.
     *
     * The test this replaces asserted that the string
     * `aria-label="Switch initiative"` appeared **somewhere** in the markup.
     * It did — on the force-mounted menu content — while the trigger, the
     * control a reader actually reaches, had no accessible name at all. A
     * substring search over a whole document cannot tell those two apart, and
     * this one certified a defect for exactly that reason. The assertion is
     * now scoped to the trigger element itself.
     */
    it("gives the trigger its own accessible name, on the trigger (C3)", () => {
      const html = renderToStaticMarkup(
        <AppShell route={route("overview")}>
          <p>content</p>
        </AppShell>,
      );
      const start = html.indexOf("<button");
      const end = html.indexOf(">", start);
      const triggerTag = html.slice(start, end);

      expect(triggerTag).toContain('class="switcher__trigger"');
      // The name carries the current label, so what the button says and what
      // it is called cannot drift apart.
      expect(triggerTag).toContain('aria-label="Switch initiative, currently All initiatives"');
    });

    /**
     * The `forceMount` fix's static proof.
     *
     * A closed `DropdownMenu.Content` that stayed mounted made Radix apply its
     * accessibility isolation to the rest of the page — the skip link, the
     * brand, the trigger, the primary nav, the `h1` and the footer all became
     * `aria-hidden="true"` in the live tree while the pixels looked correct.
     * The menu now mounts on open, so a closed switcher contributes no menu
     * markup at all, and that absence is what this asserts.
     */
    it("contributes no menu content while closed", () => {
      const html = renderToStaticMarkup(
        <AppShell route={route("overview")}>
          <p>content</p>
        </AppShell>,
      );
      expect(html).not.toContain('role="menu"');
      expect(html).not.toContain("switcher__content");
      // The portfolio link lives inside the menu, so it is absent too — the
      // trigger is the switcher's whole closed surface.
      expect(html).not.toContain('href="#/i"');
      // And nothing in the shell is hidden from assistive technology while the
      // menu is closed, which is the defect this round exists to remove.
      expect(html).not.toContain('aria-hidden="true" class="app-shell');
      expect(html).not.toContain("data-aria-hidden");
    });

    /**
     * What static rendering can no longer reach, stated rather than faked.
     *
     * The menu's item-level behaviour — `is-current` on the entry matching the
     * route, one entry per initiative, selection and focus return — lives in
     * content that only exists while the menu is open. Opening it needs a DOM
     * and a user event, and there is no DOM in this dependency graph. Those
     * assertions therefore belong to the live battery, which P8-9 owns; the
     * two tests that previously covered them were only passing because the
     * closed menu was mounted, which is the defect itself. Asserting them from
     * a closed switcher would be inventing evidence again.
     */
  });
});
