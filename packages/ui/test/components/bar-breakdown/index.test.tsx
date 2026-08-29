import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BarBreakdown } from "../../../src/components/bar-breakdown/index.js";

describe("BarBreakdown", () => {
  it("is a labelled figure whose rows carry the same facts as the visual bar, as text", () => {
    const html = renderToStaticMarkup(
      <BarBreakdown
        caption="Tasks by state"
        total={10}
        items={[
          { label: "Running", count: 7 },
          { label: "Committed", count: 3 },
        ]}
      />,
    );
    expect(html).toContain("<figure");
    expect(html).toContain("<figcaption");
    expect(html).toContain("Tasks by state");
    expect(html).toContain("Running");
    expect(html).toContain("7");
    expect(html).toContain("70%");
    expect(html).toContain("Committed");
    expect(html).toContain("30%");
  });

  it("hides the decorative bar fill from assistive technology", () => {
    const html = renderToStaticMarkup(<BarBreakdown caption="Tasks by state" total={1} items={[{ label: "Running", count: 1 }]} />);
    expect(html).toContain('aria-hidden="true"');
  });

  it("orders rows by descending count", () => {
    const html = renderToStaticMarkup(
      <BarBreakdown
        caption="Tasks by state"
        total={3}
        items={[
          { label: "Small", count: 1 },
          { label: "Big", count: 2 },
        ]}
      />,
    );
    expect(html.indexOf("Big")).toBeLessThan(html.indexOf("Small"));
  });

  it("renders a zero total without dividing by zero", () => {
    const html = renderToStaticMarkup(<BarBreakdown caption="Empty" total={0} items={[]} />);
    expect(html).toContain("Empty");
  });
});
