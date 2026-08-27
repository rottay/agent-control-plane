import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "./StatusBadge.js";
import { type Tone } from "../format/statusTone.js";

const TONES: readonly Tone[] = ["good", "neutral", "warn", "bad"];

describe("StatusBadge", () => {
  it("always renders its label text, for every tone", () => {
    for (const tone of TONES) {
      const html = renderToStaticMarkup(<StatusBadge label="Running" tone={tone} />);
      expect(html).toContain("Running");
      expect(html).toContain("badge--" + tone);
    }
  });

  it("hides the decorative tone glyph from assistive technology", () => {
    const html = renderToStaticMarkup(<StatusBadge label="Running" tone="good" />);
    expect(html).toContain('aria-hidden="true"');
  });

  it("adds an optional screen-reader-only prefix without duplicating the visible label", () => {
    const html = renderToStaticMarkup(<StatusBadge label="Running" tone="good" srPrefix="Control plane state" />);
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("Control plane state");
  });
});
