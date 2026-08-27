import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Pagination } from "./Pagination.js";

describe("Pagination", () => {
  it("disables Previous on the first page and enables Next when more is available", () => {
    const html = renderToStaticMarkup(
      <Pagination canGoPrevious={false} hasMore={true} returned={50} limit={50} onPrevious={() => { /* noop */ }} onNext={() => { /* noop */ }} />,
    );
    const previousMatch = /<button[^>]*>\s*Previous\s*<\/button>/.exec(html);
    const nextMatch = /<button[^>]*>\s*Next\s*<\/button>/.exec(html);
    expect(previousMatch?.[0]).toContain("disabled");
    expect(nextMatch?.[0]).not.toContain("disabled");
  });

  it("disables Next when there is no further page", () => {
    const html = renderToStaticMarkup(
      <Pagination canGoPrevious={true} hasMore={false} returned={12} limit={50} onPrevious={() => { /* noop */ }} onNext={() => { /* noop */ }} />,
    );
    const nextMatch = /<button[^>]*>\s*Next\s*<\/button>/.exec(html);
    expect(nextMatch?.[0]).toContain("disabled");
    expect(html).toContain("12 of up to 50 shown");
  });

  it("is a labelled navigation landmark", () => {
    const html = renderToStaticMarkup(
      <Pagination canGoPrevious={true} hasMore={true} returned={50} limit={50} onPrevious={() => { /* noop */ }} onNext={() => { /* noop */ }} />,
    );
    expect(html).toContain('aria-label="Pagination"');
  });
});
