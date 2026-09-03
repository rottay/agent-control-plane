import { DEFAULT_PAGE_LIMIT } from "@acp/protocol";
import { useMemo, useState, type SubmitEvent, type JSX } from "react";

import { fetchEvents } from "../../api/client/index.js";
import { STREAM_VIEW_ITEMS } from "../../api/stream/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { FilterBar } from "../../components/filter-bar/index.js";
import { Pagination } from "../../components/pagination/index.js";
import { StreamStatus } from "../../components/stream-status/index.js";
import { TimelineList } from "../../components/timeline-list/index.js";
import { useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { useEventStream } from "../../hooks/use-event-stream/index.js";
import { buildHash, type Route } from "../../routing/hash-route/index.js";
import { type NavigateFn } from "../../routing/use-hash-route/index.js";

export interface EventsViewProps {
  readonly route: Route;
  readonly navigate: NavigateFn;
}

interface FilterInputs {
  readonly taskId: string;
  readonly type: string;
  readonly emittedBy: string;
  readonly toState: string;
}

export function EventsView({ route, navigate }: EventsViewProps): JSX.Element {
  const taskId = route.query["taskId"];
  const type = route.query["type"];
  const emittedBy = route.query["emittedBy"];
  const toState = route.query["toState"];
  const cursor = route.query["cursor"];

  const [inputs, setInputs] = useState<FilterInputs>({
    taskId: taskId ?? "",
    type: type ?? "",
    emittedBy: emittedBy ?? "",
    toState: toState ?? "",
  });

  const { resource, lastFetchedAt, refresh } = useAsyncResource(
    (signal) => fetchEvents({ taskId, type, emittedBy, toState, cursor, limit: DEFAULT_PAGE_LIMIT }, signal),
    [taskId, type, emittedBy, toState, cursor],
  );

  /**
   * The live tail (V2-B3b).
   *
   * The connection carries no filter. It is the whole ledger tail, reconciled
   * once in `api/stream`, and the selection below is a *display* filter over
   * rows this browser already holds — never a second subscription with a
   * second cursor. A filtered stream would be a subsequence, and "apply only
   * the next sequence" is not a claim anyone can make about a subsequence.
   *
   * A `hello` naming a different ledger clears the live scope on its own; the
   * paged resource beside it is just as stale in that case, so it refetches.
   */
  const stream = useEventStream({ onDatabaseChanged: refresh });
  const liveItems = useMemo(
    () =>
      stream.items
        .filter(
          (item) =>
            (taskId === undefined || item.taskId === taskId) &&
            (type === undefined || item.type === type) &&
            (emittedBy === undefined || item.emittedBy === emittedBy) &&
            (toState === undefined || item.toState === toState),
        )
        .slice(-STREAM_VIEW_ITEMS),
    [stream.items, taskId, type, emittedBy, toState],
  );

  const hasActiveFilters = taskId !== undefined || type !== undefined || emittedBy !== undefined || toState !== undefined;

  function applyFilters(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    navigate(
      buildHash("events", {
        taskId: inputs.taskId.trim() === "" ? undefined : inputs.taskId.trim(),
        type: inputs.type.trim() === "" ? undefined : inputs.type.trim(),
        emittedBy: inputs.emittedBy.trim() === "" ? undefined : inputs.emittedBy.trim(),
        toState: inputs.toState.trim() === "" ? undefined : inputs.toState.trim(),
      }),
    );
  }

  function clearFilters(): void {
    setInputs({ taskId: "", type: "", emittedBy: "", toState: "" });
    navigate(buildHash("events"));
  }

  function field(key: keyof FilterInputs, value: string): void {
    setInputs((previous) => ({ ...previous, [key]: value }));
  }

  return (
    <section aria-labelledby="events-heading">
      <h1 id="events-heading">Timeline</h1>
      <p className="view-lede">
        The append-only event stream, in sequence order, with chain digests. Event payload contents
        never reach this browser — only key names and byte sizes do.
      </p>

      <FilterBar onApply={applyFilters} onClear={clearFilters} hasActiveFilters={hasActiveFilters}>
        <div className="field">
          <label htmlFor="events-taskId">Task id</label>
          <input
            id="events-taskId"
            type="text"
            value={inputs.taskId}
            onChange={(event) => {
              field("taskId", event.target.value);
            }}
            placeholder="uuid"
          />
        </div>
        <div className="field">
          <label htmlFor="events-type">Event type</label>
          <input
            id="events-type"
            type="text"
            value={inputs.type}
            onChange={(event) => {
              field("type", event.target.value);
            }}
            placeholder="e.g. TASK_STATE_CHANGED"
          />
        </div>
        <div className="field">
          <label htmlFor="events-emittedBy">Emitted by</label>
          <input
            id="events-emittedBy"
            type="text"
            value={inputs.emittedBy}
            onChange={(event) => {
              field("emittedBy", event.target.value);
            }}
            placeholder="provider/model/role/instance"
          />
        </div>
        <div className="field">
          <label htmlFor="events-toState">To state</label>
          <input
            id="events-toState"
            type="text"
            value={inputs.toState}
            onChange={(event) => {
              field("toState", event.target.value);
            }}
            placeholder="e.g. RUNNING"
          />
        </div>
      </FilterBar>

      <StreamStatus status={stream} label="the timeline" />

      {liveItems.length > 0 ? (
        <section className="stream-live" aria-labelledby="events-live-heading">
          <h2 id="events-live-heading" className="stream-live__heading">
            Live since this page opened
          </h2>
          <p className="stream-live__note">
            Applied in ledger sequence order, newest last. The page below is a fixed page and does not
            move.
          </p>
          <TimelineList caption="Live event stream" items={liveItems} />
        </section>
      ) : null}

      <AsyncSection
        resource={resource}
        lastFetchedAt={lastFetchedAt}
        onRefresh={refresh}
        label="the timeline"
        isEmpty={(data) => data.items.length === 0}
        emptyMessage={hasActiveFilters ? "No events match this filter." : "No events have been recorded yet."}
      >
        {(data) => (
          <>
            <TimelineList caption="Event timeline" items={data.items} />
            <Pagination
              canGoPrevious={cursor !== undefined}
              hasMore={data.page.hasMore}
              returned={data.page.returned}
              limit={data.page.limit}
              onPrevious={() => {
                window.history.back();
              }}
              onNext={() => {
                if (data.page.nextCursor !== null) {
                  navigate(buildHash("events", { taskId, type, emittedBy, toState, cursor: data.page.nextCursor }));
                }
              }}
            />
          </>
        )}
      </AsyncSection>
    </section>
  );
}
