import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Route } from "../../../src/routing/hash-route/index.js";
import { NotFoundView } from "../../../src/views/not-found-view/index.js";

describe("NotFoundView", () => {
  it("names the unroutable hash and offers a way back to the overview", () => {
    const route: Route = { view: "not-found", taskId: null, workerIdentity: null, query: {}, raw: "#/nonsense" };
    const html = renderToStaticMarkup(<NotFoundView route={route} />);
    expect(html).toContain("Not found");
    expect(html).toContain("#/nonsense");
    expect(html).toContain('href="#/overview"');
  });
});
