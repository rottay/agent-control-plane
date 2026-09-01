import { type ReactNode, type JSX } from "react";

export type ColumnPriority = "essential" | "secondary" | "tertiary";

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  /**
   * `essential` columns always show. `secondary` columns drop first on a
   * narrow viewport, `tertiary` columns drop next. This is deliberate
   * information prioritization: the columns that survive on a phone are
   * chosen per table, not "every column scaled down".
   */
  readonly priority?: ColumnPriority;
  readonly render: (row: T) => ReactNode;
  readonly align?: "start" | "end";
}

export interface DataTableProps<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  /** Column key rendered as the row's `<th scope="row">` instead of a `<td>`. */
  readonly rowHeaderKey?: string;
  /** Hide the caption visually while keeping it in the accessibility tree. */
  readonly captionHidden?: boolean;
}

/**
 * A semantic, responsive data table.
 *
 * The table itself never scrolls the page horizontally: it sits inside its
 * own `overflow-x` container, and columns above `essential` priority are
 * dropped by CSS at narrow widths rather than shrunk into unreadable text.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowHeaderKey,
  captionHidden = true,
}: DataTableProps<T>): JSX.Element {
  return (
    <div className="data-table" tabIndex={0} role="region" aria-label={caption}>
      <table>
        <caption className={captionHidden ? "sr-only" : undefined}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" data-priority={column.priority ?? "essential"} data-align={column.align ?? "start"}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr key={key}>
                {columns.map((column) =>
                  column.key === rowHeaderKey ? (
                    <th key={column.key} scope="row" data-priority={column.priority ?? "essential"} data-align={column.align ?? "start"}>
                      {column.render(row)}
                    </th>
                  ) : (
                    <td key={column.key} data-priority={column.priority ?? "essential"} data-align={column.align ?? "start"}>
                      {column.render(row)}
                    </td>
                  ),
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
