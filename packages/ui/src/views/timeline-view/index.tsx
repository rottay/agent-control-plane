import { type InitiativeTimelineResponse, type ScopedTimelineEntry } from "@acp/api-contracts";
import { useState, type SubmitEvent, type JSX } from "react";

import { fetchInitiativeTimeline } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { type Column, DataTable } from "../../components/data-table/index.js";
import { FilterBar } from "../../components/filter-bar/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { formatTimestamp, humanizeConstant } from "../../format/index.js";
import { type Resource, useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { buildInitiativeTimelineHash, buildTaskDetailHash, buildWorkerDetailHash, type Route } from "../../routing/hash-route/index.js";
import { type NavigateFn } from "../../routing/use-hash-route/index.js";
import { NotFoundView } from "../not-found-view/index.js";
import { WorkspaceSubnav } from "../workspace-view/index.js";

/**
 * The scoped timeline (P8-8E, blueprint §2): one initiative's own stream
 * merged with every task it owns (`fetchInitiativeTimeline`, P8-8E-pre's
 * C2), stream-tagged so a reader can always tell which chain a row came from
 * (the two carry different facts and their sequences are not comparable
 * across streams).
 *
 * `initiativeEvents` answers no query parameters at all
 * (`assertEmptyQuery` on the server side) — unlike the global `EventsView`,
 * every filter here runs client-side over the one fetched page, in memory,
 * rather than by re-requesting. The filters still round-trip through the
 * URL (`route.query`), so a filtered view stays deep-linkable and
 * back/forward navigable, the same law every other filtered view in this
 * package already holds — only *how* the filter is applied differs here.
 */

export interface TimelineViewProps {
  readonly route: Route;
  readonly navigate: NavigateFn;
}

export function TimelineView({ route, navigate }: TimelineViewProps): JSX.Element {
  const initiativeId = route.initiativeId;
  if (initiativeId === null) {
    return <NotFoundView route={route} />;
  }
  return <TimelineHooked route={route} navigate={navigate} initiativeId={initiativeId} />;
}

function TimelineHooked({
  route,
  navigate,
  initiativeId,
}: {
  readonly route: Route;
  readonly navigate: NavigateFn;
  readonly initiativeId: string;
}): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource(
    (signal) => fetchInitiativeTimeline(initiativeId, signal),
    [initiativeId],
  );
  return (
    <TimelineSection
      route={route}
      navigate={navigate}
      initiativeId={initiativeId}
      resource={resource}
      lastFetchedAt={lastFetchedAt}
      onRefresh={refresh}
    />
  );
}

export interface TimelineFilters {
  readonly taskId?: string | undefined;
  readonly type?: string | undefined;
  readonly stream?: string | undefined;
}

/**
 * Filter one merged-timeline page in memory. Pure, exported, and this
 * view's own test drills it directly rather than only through the rendered
 * table — `taskId` narrows to TASK rows alone (an INITIATIVE row has no
 * task to match), never a partial match on a string that happens to
 * contain it.
 */
export function filterTimeline(
  items: readonly ScopedTimelineEntry[],
  filters: TimelineFilters,
): readonly ScopedTimelineEntry[] {
  return items.filter((item) => {
    if (filters.stream !== undefined && item.stream !== filters.stream) {
      return false;
    }
    if (filters.type !== undefined && item.type !== filters.type) {
      return false;
    }
    if (filters.taskId !== undefined && (item.stream !== "TASK" || item.taskId !== filters.taskId)) {
      return false;
    }
    return true;
  });
}

interface FilterInputs {
  readonly taskId: string;
  readonly type: string;
  readonly stream: string;
}

export interface TimelineSectionProps {
  readonly route: Route;
  readonly navigate: NavigateFn;
  readonly initiativeId: string;
  readonly resource: Resource<InitiativeTimelineResponse>;
  readonly lastFetchedAt: Date | null;
  readonly onRefresh: () => void;
}

/**
 * The resource-driven half of the timeline view, split out the same way
 * `WorkspaceSection`/`GraphSection` were, for the same reason: a test drives
 * every state with a constructed `Resource` fixture.
 */
export function TimelineSection({
  route,
  navigate,
  initiativeId,
  resource,
  lastFetchedAt,
  onRefresh,
}: TimelineSectionProps): JSX.Element {
  const taskId = route.query["taskId"];
  const type = route.query["type"];
  const stream = route.query["stream"];

  const [inputs, setInputs] = useState<FilterInputs>({
    taskId: taskId ?? "",
    type: type ?? "",
    stream: stream ?? "",
  });

  // The id-validation law (C3/C5): read from this fetch's own 404, the same
  // as every other scoped view — `initiativeEvents` 404s on an unknown id
  // exactly as `initiativeById` does.
  if (resource.status === "error" && resource.error.status === 404) {
    return <NotFoundView route={route} />;
  }

  const hasActiveFilters = taskId !== undefined || type !== undefined || stream !== undefined;

  function applyFilters(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    navigate(
      buildInitiativeTimelineHash(initiativeId, {
        taskId: inputs.taskId.trim() === "" ? undefined : inputs.taskId.trim(),
        type: inputs.type.trim() === "" ? undefined : inputs.type.trim(),
        stream: inputs.stream === "" ? undefined : inputs.stream,
      }),
    );
  }

  function clearFilters(): void {
    setInputs({ taskId: "", type: "", stream: "" });
    navigate(buildInitiativeTimelineHash(initiativeId));
  }

  function field(key: keyof FilterInputs, value: string): void {
    setInputs((previous) => ({ ...previous, [key]: value }));
  }

  return (
    <section aria-labelledby="timeline-heading">
      <h1 id="timeline-heading">Timeline</h1>
      <p className="view-lede">
        This initiative&apos;s own stream merged with every task it owns, stream-tagged and ordered by
        when each row was recorded.
      </p>

      <WorkspaceSubnav route={route} initiativeId={initiativeId} />

      <FilterBar onApply={applyFilters} onClear={clearFilters} hasActiveFilters={hasActiveFilters}>
        <div className="field">
          <label htmlFor="timeline-taskId">Task id</label>
          <input
            id="timeline-taskId"
            type="text"
            value={inputs.taskId}
            onChange={(event) => {
              field("taskId", event.target.value);
            }}
            placeholder="uuid"
          />
        </div>
        <div className="field">
          <label htmlFor="timeline-type">Event type</label>
          <input
            id="timeline-type"
            type="text"
            value={inputs.type}
            onChange={(event) => {
              field("type", event.target.value);
            }}
            placeholder="e.g. TASK_STATE_CHANGED"
          />
        </div>
        <div className="field">
          <label htmlFor="timeline-stream">Stream</label>
          <select
            id="timeline-stream"
            value={inputs.stream}
            onChange={(event) => {
              field("stream", event.target.value);
            }}
          >
            <option value="">All</option>
            <option value="TASK">Task</option>
            <option value="INITIATIVE">Initiative</option>
          </select>
        </div>
      </FilterBar>

      <AsyncSection
        resource={resource}
        lastFetchedAt={lastFetchedAt}
        onRefresh={onRefresh}
        label="the timeline"
        isEmpty={(data) => filterTimeline(data.items, { taskId, type, stream }).length === 0}
        emptyMessage={hasActiveFilters ? "No timeline rows match this filter." : "No timeline rows have been recorded yet."}
      >
        {(data) => {
          const filtered = filterTimeline(data.items, { taskId, type, stream });
          return (
            <>
              <DataTable caption="Initiative timeline" columns={TIMELINE_COLUMNS} rows={filtered} rowKey={(item) => item.eventId} />
              {data.truncated ? (
                <p className="async-state async-state--stale" role="alert">
                  This timeline was truncated at the fetch ceiling; older rows may be missing.
                </p>
              ) : null}
            </>
          );
        }}
      </AsyncSection>
    </section>
  );
}

const STREAM_LABEL: Record<ScopedTimelineEntry["stream"], string> = {
  TASK: "Task",
  INITIATIVE: "Initiative",
};

/**
 * Roadmap-version rows render distinctly rather than as a status transition
 * (blueprint §2: "first-class rows"). `ScopedTimelineEntry`'s INITIATIVE
 * branch carries only `fromStatus`/`toStatus`, never a version number, kind
 * or digest — recording a roadmap version does not necessarily change the
 * initiative's own status, so an "ACTIVE → ACTIVE" transition would be a
 * confusing, information-free rendering of what is actually a different
 * kind of fact. This view does not fabricate the missing version/kind/
 * digest by joining against the separate roadmap-history endpoint: that
 * response carries no event id or sequence to correlate against a timeline
 * row, and inventing that link would be exactly the kind of guess C1/C2's
 * own "never invented" law forbids elsewhere in this packet.
 */
function TimelineDetail({ item }: { readonly item: ScopedTimelineEntry }): JSX.Element {
  if (item.stream === "TASK") {
    return (
      <span className="transition">
        <span className="transition__from">{item.fromState !== null ? humanizeConstant(item.fromState) : "—"}</span>
        <span aria-hidden="true"> → </span>
        <span className="sr-only"> to </span>
        <span className="transition__to">{humanizeConstant(item.toState)}</span>
      </span>
    );
  }
  if (item.type === "ROADMAP_VERSION_RECORDED") {
    return <StatusBadge label="Roadmap version recorded" tone="neutral" />;
  }
  return (
    <span className="transition">
      <span className="transition__from">{item.fromStatus !== null ? humanizeConstant(item.fromStatus) : "—"}</span>
      <span aria-hidden="true"> → </span>
      <span className="sr-only"> to </span>
      <span className="transition__to">{humanizeConstant(item.toStatus)}</span>
    </span>
  );
}

const TIMELINE_COLUMNS: Column<ScopedTimelineEntry>[] = [
  {
    key: "stream",
    header: "Stream",
    priority: "essential",
    render: (item) => <StatusBadge label={STREAM_LABEL[item.stream]} tone={item.stream === "TASK" ? "neutral" : "good"} />,
  },
  {
    key: "sequence",
    header: "Seq",
    priority: "secondary",
    align: "end",
    render: (item) => item.sequence,
  },
  {
    key: "type",
    header: "Event",
    priority: "essential",
    render: (item) => humanizeConstant(item.type),
  },
  {
    key: "detail",
    header: "Detail",
    priority: "essential",
    render: (item) => <TimelineDetail item={item} />,
  },
  {
    key: "task",
    header: "Task",
    priority: "secondary",
    render: (item) =>
      item.stream === "TASK" ? (
        <a href={buildTaskDetailHash(item.taskId)}>
          <IdValue value={item.taskId} kind="task id" />
        </a>
      ) : (
        "—"
      ),
  },
  {
    key: "emittedBy",
    header: "Emitted by",
    priority: "secondary",
    render: (item) => <a href={buildWorkerDetailHash(item.emittedBy)}>{item.emittedBy}</a>,
  },
  {
    key: "occurredAt",
    header: "Occurred",
    priority: "secondary",
    render: (item) => (
      <time dateTime={item.occurredAt} title={formatTimestamp(item.occurredAt)}>
        {formatTimestamp(item.occurredAt, "compact")}
      </time>
    ),
  },
  {
    key: "eventId",
    header: "Event id",
    priority: "tertiary",
    render: (item) => <IdValue value={item.eventId} kind="event id" />,
  },
];
