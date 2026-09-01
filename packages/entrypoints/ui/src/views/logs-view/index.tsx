import { type InitiativeTimelineResponse, type ScopedTimelineEntry } from "@acp/api-contracts";
import { useState, type SubmitEvent, type JSX } from "react";

import { fetchInitiativeTimeline } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { type Column, DataTable } from "../../components/data-table/index.js";
import { FilterBar } from "../../components/filter-bar/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { formatTimestamp } from "../../format/index.js";
import { type Resource, useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { buildInitiativeLogsHash, type Route } from "../../routing/hash-route/index.js";
import { type NavigateFn } from "../../routing/use-hash-route/index.js";
import { NotFoundView } from "../not-found-view/index.js";
import { WorkspaceSubnav } from "../workspace-view/index.js";

/**
 * The scoped operator log (P8-8F, blueprint §3c): the same merged timeline
 * `TimelineView` narrates, rendered instead for debugging — raw fields,
 * absolute times, copyable ids, density. Distinct by intent, not by data:
 * both consume `fetchInitiativeTimeline`; nothing new is served.
 *
 * `initiativeEvents` answers no query parameters (`assertEmptyQuery` on the
 * server side), so every filter here runs client-side over the one fetched
 * page, exactly as the timeline's do — only the filter vocabulary differs
 * (stream, type, actor, a free-text match over the ids).
 */

export interface LogsViewProps {
  readonly route: Route;
  readonly navigate: NavigateFn;
}

export function LogsView({ route, navigate }: LogsViewProps): JSX.Element {
  const initiativeId = route.initiativeId;
  if (initiativeId === null) {
    return <NotFoundView route={route} />;
  }
  return <LogsHooked route={route} navigate={navigate} initiativeId={initiativeId} />;
}

function LogsHooked({
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
    <LogsSection
      route={route}
      navigate={navigate}
      initiativeId={initiativeId}
      resource={resource}
      lastFetchedAt={lastFetchedAt}
      onRefresh={refresh}
    />
  );
}

export interface LogFilters {
  readonly stream?: string | undefined;
  readonly type?: string | undefined;
  readonly actor?: string | undefined;
  readonly idMatch?: string | undefined;
}

/**
 * Filter one merged-timeline page in memory. Pure, exported, and this view's
 * own test drills it directly — the timeline's own law (`filterTimeline`),
 * restated here for this view's different filter vocabulary.
 */
export function filterLogs(items: readonly ScopedTimelineEntry[], filters: LogFilters): readonly ScopedTimelineEntry[] {
  return items.filter((item) => {
    if (filters.stream !== undefined && item.stream !== filters.stream) {
      return false;
    }
    if (filters.type !== undefined && item.type !== filters.type) {
      return false;
    }
    if (filters.actor !== undefined && item.emittedBy !== filters.actor) {
      return false;
    }
    if (filters.idMatch !== undefined && filters.idMatch !== "") {
      const needle = filters.idMatch.toLowerCase();
      const ids: string[] = [item.eventId];
      if (item.stream === "TASK") {
        ids.push(item.taskId);
        if (item.correlationId !== null) ids.push(item.correlationId);
        if (item.causationId !== null) ids.push(item.causationId);
      }
      if (!ids.some((id) => id.toLowerCase().includes(needle))) {
        return false;
      }
    }
    return true;
  });
}

interface FilterInputs {
  readonly stream: string;
  readonly type: string;
  readonly actor: string;
  readonly idMatch: string;
}

export interface LogsSectionProps {
  readonly route: Route;
  readonly navigate: NavigateFn;
  readonly initiativeId: string;
  readonly resource: Resource<InitiativeTimelineResponse>;
  readonly lastFetchedAt: Date | null;
  readonly onRefresh: () => void;
}

/**
 * The resource-driven half of the logs view, split out the same way every
 * other scoped section in this cohort was, for the same reason: a test
 * drives every state with a constructed `Resource` fixture.
 */
export function LogsSection({ route, navigate, initiativeId, resource, lastFetchedAt, onRefresh }: LogsSectionProps): JSX.Element {
  const stream = route.query["stream"];
  const type = route.query["type"];
  const actor = route.query["actor"];
  const idMatch = route.query["idMatch"];

  const [inputs, setInputs] = useState<FilterInputs>({
    stream: stream ?? "",
    type: type ?? "",
    actor: actor ?? "",
    idMatch: idMatch ?? "",
  });

  // The id-validation law (C3/C5): read from this fetch's own 404, the same
  // as every other scoped view.
  if (resource.status === "error" && resource.error.status === 404) {
    return <NotFoundView route={route} />;
  }

  const hasActiveFilters = stream !== undefined || type !== undefined || actor !== undefined || idMatch !== undefined;

  function applyFilters(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    navigate(
      buildInitiativeLogsHash(initiativeId, {
        stream: inputs.stream === "" ? undefined : inputs.stream,
        type: inputs.type.trim() === "" ? undefined : inputs.type.trim(),
        actor: inputs.actor.trim() === "" ? undefined : inputs.actor.trim(),
        idMatch: inputs.idMatch.trim() === "" ? undefined : inputs.idMatch.trim(),
      }),
    );
  }

  function clearFilters(): void {
    setInputs({ stream: "", type: "", actor: "", idMatch: "" });
    navigate(buildInitiativeLogsHash(initiativeId));
  }

  function field(key: keyof FilterInputs, value: string): void {
    setInputs((previous) => ({ ...previous, [key]: value }));
  }

  return (
    <section aria-labelledby="logs-heading">
      <h1 id="logs-heading">Logs</h1>
      <p className="view-lede">
        The same merged timeline, rendered dense for debugging: raw fields, absolute times, and every
        id copyable.
      </p>

      <WorkspaceSubnav route={route} initiativeId={initiativeId} />

      <FilterBar onApply={applyFilters} onClear={clearFilters} hasActiveFilters={hasActiveFilters}>
        <div className="field">
          <label htmlFor="logs-stream">Stream</label>
          <select
            id="logs-stream"
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
        <div className="field">
          <label htmlFor="logs-type">Event type</label>
          <input
            id="logs-type"
            type="text"
            value={inputs.type}
            onChange={(event) => {
              field("type", event.target.value);
            }}
            placeholder="e.g. TASK_STATE_CHANGED"
          />
        </div>
        <div className="field">
          <label htmlFor="logs-actor">Actor</label>
          <input
            id="logs-actor"
            type="text"
            value={inputs.actor}
            onChange={(event) => {
              field("actor", event.target.value);
            }}
            placeholder="provider/model/role/instance"
          />
        </div>
        <div className="field">
          <label htmlFor="logs-idMatch">Id contains</label>
          <input
            id="logs-idMatch"
            type="text"
            value={inputs.idMatch}
            onChange={(event) => {
              field("idMatch", event.target.value);
            }}
            placeholder="any part of any id"
          />
        </div>
      </FilterBar>

      <AsyncSection
        resource={resource}
        lastFetchedAt={lastFetchedAt}
        onRefresh={onRefresh}
        label="the log"
        isEmpty={(data) => filterLogs(data.items, { stream, type, actor, idMatch }).length === 0}
        emptyMessage={hasActiveFilters ? "No log lines match this filter." : "No events have been recorded yet."}
      >
        {(data) => {
          const filtered = filterLogs(data.items, { stream, type, actor, idMatch });
          return (
            <>
              {data.truncated ? (
                <p className="async-state async-state--stale" role="alert">
                  This log was truncated at the fetch ceiling (the scoped timeline's own cap); older
                  lines may be missing.
                </p>
              ) : null}
              <div className="log-table">
                <DataTable caption="Operator log" columns={LOG_COLUMNS} rows={filtered} rowKey={(item) => item.eventId} />
              </div>
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
 * Dense, raw, un-humanized columns — the log debugs, it does not narrate
 * (blueprint §3c). `type` renders the literal constant rather than
 * `humanizeConstant`'s prose form, and `occurredAt` renders the absolute
 * instant rather than the timeline's relative one: both are the same
 * distinction stated at the byte level.
 */
const LOG_COLUMNS: Column<ScopedTimelineEntry>[] = [
  {
    key: "sequence",
    header: "Seq",
    priority: "essential",
    align: "end",
    render: (item) => item.sequence,
  },
  {
    key: "stream",
    header: "Stream",
    priority: "essential",
    render: (item) => <StatusBadge label={STREAM_LABEL[item.stream]} tone={item.stream === "TASK" ? "neutral" : "good"} />,
  },
  {
    key: "occurredAt",
    header: "Occurred",
    priority: "essential",
    render: (item) => (
      <time dateTime={item.occurredAt} title={item.occurredAt}>
        {formatTimestamp(item.occurredAt)}
      </time>
    ),
  },
  {
    key: "type",
    header: "Type",
    priority: "essential",
    render: (item) => <code>{item.type}</code>,
  },
  {
    key: "emittedBy",
    header: "Emitted by",
    priority: "secondary",
    render: (item) => <code>{item.emittedBy}</code>,
  },
  {
    key: "eventId",
    header: "Event id",
    priority: "secondary",
    render: (item) => <IdValue value={item.eventId} kind="event id" />,
  },
  {
    key: "taskId",
    header: "Task id",
    priority: "secondary",
    render: (item) => (item.stream === "TASK" ? <IdValue value={item.taskId} kind="task id" /> : "—"),
  },
  {
    key: "correlationId",
    header: "Correlation id",
    priority: "tertiary",
    render: (item) =>
      item.stream === "TASK" && item.correlationId !== null ? (
        <IdValue value={item.correlationId} kind="correlation id" />
      ) : (
        "—"
      ),
  },
  {
    key: "causationId",
    header: "Causation id",
    priority: "tertiary",
    render: (item) =>
      item.stream === "TASK" && item.causationId !== null ? <IdValue value={item.causationId} kind="causation id" /> : "—",
  },
];
