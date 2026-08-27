import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FilterBar } from "./FilterBar.js";

describe("FilterBar", () => {
  it("is a labelled search form with an apply and a clear control", () => {
    const html = renderToStaticMarkup(
      <FilterBar onApply={() => { /* noop */ }} onClear={() => { /* noop */ }} hasActiveFilters={true}>
        <div className="field">
          <label htmlFor="x">State</label>
          <input id="x" type="text" />
        </div>
      </FilterBar>,
    );
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="Filters"');
    expect(html).toContain("Apply filters");
    expect(html).toContain("Clear filters");
    expect(html).toContain('for="x"');
  });

  it("disables Clear filters when there is nothing active to clear", () => {
    const html = renderToStaticMarkup(
      <FilterBar onApply={() => { /* noop */ }} onClear={() => { /* noop */ }} hasActiveFilters={false}>
        <div />
      </FilterBar>,
    );
    const clearMatch = /<button[^>]*>\s*Clear filters\s*<\/button>/.exec(html);
    expect(clearMatch?.[0]).toContain("disabled");
  });
});
