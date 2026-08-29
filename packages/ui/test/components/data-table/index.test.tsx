import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DataTable, type Column } from "../../../src/components/data-table/index.js";

interface Row {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

const ROWS: readonly Row[] = [
  { id: "1", name: "Alpha", detail: "first" },
  { id: "2", name: "Beta", detail: "second" },
];

const COLUMNS: readonly Column<Row>[] = [
  { key: "id", header: "Id", priority: "essential", render: (row) => row.id },
  { key: "name", header: "Name", priority: "essential", render: (row) => row.name },
  { key: "detail", header: "Detail", priority: "tertiary", render: (row) => row.detail },
];

describe("DataTable", () => {
  it("renders a semantic table with a caption, column headers and one row per item", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Widgets" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />,
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<caption");
    expect(html).toContain("Widgets");
    expect(html).toContain('scope="col"');
    expect((html.match(/<tr>/g) ?? []).length).toBe(3); // header row + 2 body rows
  });

  it("hides the caption visually by default while keeping it in the markup", () => {
    const html = renderToStaticMarkup(<DataTable caption="Widgets" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    expect(html).toContain('class="sr-only"');
  });

  it("shows the caption visually when captionHidden is false", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Widgets" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} captionHidden={false} />,
    );
    expect(html).not.toContain('class="sr-only"');
  });

  it("marks columns with their priority so responsive CSS can drop them", () => {
    const html = renderToStaticMarkup(<DataTable caption="Widgets" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    expect(html).toContain('data-priority="tertiary"');
    expect(html).toContain('data-priority="essential"');
  });

  it("renders the designated row-header column as th scope=row", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Widgets" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} rowHeaderKey="id" />,
    );
    expect(html).toContain('scope="row"');
  });
});
