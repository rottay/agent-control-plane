import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { IdValue } from "./IdValue.js";

describe("IdValue", () => {
  it("renders a short value plainly, with no disclosure control", () => {
    const html = renderToStaticMarkup(<IdValue value="abc" />);
    expect(html).toContain("abc");
    expect(html).not.toContain("<button");
  });

  it("truncates a long value visually but exposes the full value to assistive technology unconditionally", () => {
    const long = "0123456789abcdef0123456789abcdef";
    const html = renderToStaticMarkup(<IdValue value={long} kind="task id" />);
    expect(html).toContain('class="sr-only"');
    expect(html).toContain(long);
    expect(html).toContain("Show full task id");
    expect(html).toContain('aria-expanded="false"');
  });
});
