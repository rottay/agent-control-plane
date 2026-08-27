import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Route } from "../routing/hashRoute.js";
import { AppShell } from "./AppShell.js";

function route(view: Route["view"]): Route {
  return { view, taskId: null, workerIdentity: null, query: {}, raw: "" };
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
});
