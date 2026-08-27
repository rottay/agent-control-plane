import { type JSX } from "react";

export interface PaginationProps {
  readonly canGoPrevious: boolean;
  readonly hasMore: boolean;
  readonly returned: number;
  readonly limit: number;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

/**
 * Cursor pagination controls.
 *
 * There is no page count and no jump-to-page: the API hands back an opaque,
 * forward-only cursor, not a total, and a control that implied either would
 * be lying about what the server actually knows. "Previous" retraces the
 * browser history entry the matching "Next" push created, which is also what
 * keeps every page individually deep linkable.
 */
export function Pagination({ canGoPrevious, hasMore, returned, limit, onPrevious, onNext }: PaginationProps): JSX.Element {
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="pagination__summary">
        {returned} of up to {limit} shown
      </span>
      <div className="pagination__controls">
        <button type="button" className="button button--quiet" onClick={onPrevious} disabled={!canGoPrevious}>
          Previous
        </button>
        <button type="button" className="button button--quiet" onClick={onNext} disabled={!hasMore}>
          Next
        </button>
      </div>
    </nav>
  );
}
