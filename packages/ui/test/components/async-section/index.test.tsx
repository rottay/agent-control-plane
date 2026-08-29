import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Resource } from "../../../src/hooks/use-async-resource/index.js";
import { AsyncSection } from "../../../src/components/async-section/index.js";

interface Extra {
  readonly isEmpty?: (data: { readonly label: string }) => boolean;
  readonly emptyMessage?: string;
}

function render(resource: Resource<{ readonly label: string }>, extra: Extra = {}): string {
  return renderToStaticMarkup(
    <AsyncSection
      resource={resource}
      lastFetchedAt={null}
      onRefresh={() => { /* noop */ }}
      label="widgets"
      {...extra}
    >
      {(data) => <p data-testid="content">{data.label}</p>}
    </AsyncSection>,
  );
}

describe("AsyncSection", () => {
  it("renders an announced loading state with no content", () => {
    const html = render({ status: "loading", data: null, error: null });
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading widgets");
    expect(html).not.toContain("data-testid");
  });

  it("renders an alert with the message, optional detail and a retry control on error", () => {
    const html = render({
      status: "error",
      data: null,
      error: { kind: "network-error", message: "The request could not reach the server.", detail: "boom", status: null },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load widgets.");
    expect(html).toContain("The request could not reach the server.");
    expect(html).toContain("boom");
    expect(html).toContain("Try again");
  });

  it("renders children and a refresh control on success", () => {
    const html = render({ status: "success", data: { label: "hello" }, error: null });
    expect(html).toContain("hello");
    expect(html).toContain("Refresh");
    expect(html).toContain("Updated: never");
  });

  it("renders the empty message instead of children when isEmpty matches", () => {
    const html = render(
      { status: "success", data: { label: "hello" }, error: null },
      { isEmpty: () => true, emptyMessage: "Nothing here." },
    );
    expect(html).toContain("Nothing here.");
    expect(html).not.toContain("hello");
  });

  it("keeps showing the last good data, marked stale, when a refresh fails", () => {
    const html = render({
      status: "stale",
      data: { label: "still here" },
      error: { kind: "api-error", message: "Server said no.", detail: null, status: 500 },
    });
    expect(html).toContain("still here");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Server said no.");
  });

  it("announces a refresh in progress without hiding existing content", () => {
    const html = render({ status: "refreshing", data: { label: "still here" }, error: null });
    expect(html).toContain("Refreshing…");
    expect(html).toContain("still here");
  });
});
