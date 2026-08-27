import { type ReactNode, type JSX } from "react";

import { type Resource } from "../hooks/useAsyncResource.js";
import { formatRelativeTime, formatTimestamp } from "../format/format.js";

export interface AsyncSectionProps<T> {
  readonly resource: Resource<T>;
  readonly lastFetchedAt: Date | null;
  readonly onRefresh: () => void;
  /** Noun phrase used in status prose, e.g. "tasks", "the task detail". */
  readonly label: string;
  readonly isEmpty?: (data: T) => boolean;
  readonly emptyMessage?: string;
  readonly children: (data: T) => ReactNode;
}

/**
 * The one place loading, error, stale and empty states are decided.
 *
 * Every view that reads from the API renders through this component so the
 * five states required of a major view — loading, empty, stale/degraded,
 * unavailable, error — are handled once, consistently, instead of once per
 * view with its own small drift each time.
 */
export function AsyncSection<T>({
  resource,
  lastFetchedAt,
  onRefresh,
  label,
  isEmpty,
  emptyMessage,
  children,
}: AsyncSectionProps<T>): JSX.Element {
  if (resource.status === "loading") {
    return (
      <div className="async-state async-state--loading" role="status" aria-live="polite">
        <span className="async-state__spinner" aria-hidden="true" />
        Loading {label}…
      </div>
    );
  }

  if (resource.status === "error") {
    return (
      <div className="async-state async-state--error" role="alert">
        <p className="async-state__title">Could not load {label}.</p>
        <p className="async-state__message">{resource.error.message}</p>
        {resource.error.detail !== null ? (
          <p className="async-state__detail">
            <code>{resource.error.detail}</code>
          </p>
        ) : null}
        <button type="button" className="button" onClick={onRefresh}>
          Try again
        </button>
      </div>
    );
  }

  const empty = isEmpty?.(resource.data) === true;

  return (
    <div className="async-section">
      <div className="async-section__status" role="status" aria-live="polite">
        <span className="async-section__updated">
          {resource.status === "refreshing" ? (
            "Refreshing…"
          ) : lastFetchedAt !== null ? (
            <>
              Updated{" "}
              <time dateTime={lastFetchedAt.toISOString()} title={formatTimestamp(lastFetchedAt.toISOString())}>
                {formatRelativeTime(lastFetchedAt.toISOString(), new Date())}
              </time>
            </>
          ) : (
            "Updated: never"
          )}
        </span>
        <button type="button" className="button button--quiet" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      {resource.status === "stale" ? (
        <div className="async-state async-state--stale" role="alert">
          <p className="async-state__title">The last refresh of {label} failed. Showing the last known data.</p>
          <p className="async-state__message">{resource.error.message}</p>
        </div>
      ) : null}

      {empty ? (
        <div className="async-state async-state--empty">
          <p>{emptyMessage ?? "There is nothing to show yet."}</p>
        </div>
      ) : (
        children(resource.data)
      )}
    </div>
  );
}
