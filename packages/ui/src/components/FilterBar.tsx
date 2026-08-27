import { type ReactNode, type SubmitEvent, type JSX } from "react";

export interface FilterBarProps {
  readonly onApply: (event: SubmitEvent<HTMLFormElement>) => void;
  readonly onClear: () => void;
  readonly hasActiveFilters: boolean;
  readonly children: ReactNode;
}

/** Consistent chrome around a view's own filter fields. */
export function FilterBar({ onApply, onClear, hasActiveFilters, children }: FilterBarProps): JSX.Element {
  return (
    <form className="filter-bar" role="search" aria-label="Filters" onSubmit={onApply}>
      <div className="filter-bar__fields">{children}</div>
      <div className="filter-bar__actions">
        <button type="submit" className="button">
          Apply filters
        </button>
        <button type="button" className="button button--quiet" onClick={onClear} disabled={!hasActiveFilters}>
          Clear filters
        </button>
      </div>
    </form>
  );
}
