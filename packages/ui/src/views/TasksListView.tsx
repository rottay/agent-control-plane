import { DEFAULT_PAGE_LIMIT, type TaskSummary } from "@acp/api-contracts";
import { useState, type SubmitEvent, type JSX } from "react";

import { fetchTasks } from "../api/client.js";
import { AsyncSection } from "../components/AsyncSection.js";
import { DataTable, type Column } from "../components/DataTable.js";
import { FilterBar } from "../components/FilterBar.js";
import { IdValue } from "../components/IdValue.js";
import { Pagination } from "../components/Pagination.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatCount, formatTimestamp, humanizeConstant, looksLikeUuid } from "../format/format.js";
import { taskStateTone } from "../format/statusTone.js";
import { useAsyncResource } from "../hooks/useAsyncResource.js";
import { buildHash, buildTaskDetailHash, buildWorkerDetailHash, type Route } from "../routing/hashRoute.js";
import { type NavigateFn } from "../routing/useHashRoute.js";

export interface TasksListViewProps {
  readonly route: Route;
  readonly navigate: NavigateFn;
}

export function TasksListView({ route, navigate }: TasksListViewProps): JSX.Element {
  const stateFilter = route.query["state"];
  const cursor = route.query["cursor"];
  const [stateInput, setStateInput] = useState(stateFilter ?? "");
  const [jumpId, setJumpId] = useState("");
  const [jumpError, setJumpError] = useState<string | null>(null);

  const { resource, lastFetchedAt, refresh } = useAsyncResource(
    (signal) => fetchTasks({ state: stateFilter, cursor, limit: DEFAULT_PAGE_LIMIT }, signal),
    [stateFilter, cursor],
  );

  function applyFilters(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = stateInput.trim();
    navigate(buildHash("tasks", { state: trimmed === "" ? undefined : trimmed }));
  }

  function clearFilters(): void {
    setStateInput("");
    navigate(buildHash("tasks"));
  }

  function jumpToTask(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = jumpId.trim();
    if (!looksLikeUuid(trimmed)) {
      setJumpError("Enter a full task id (a uuid) to open it directly.");
      return;
    }
    setJumpError(null);
    navigate(buildTaskDetailHash(trimmed));
  }

  const columns: Column<TaskSummary>[] = [
    {
      key: "taskId",
      header: "Task",
      priority: "essential",
      render: (task) => (
        <a href={buildTaskDetailHash(task.taskId)}>
          <IdValue value={task.taskId} kind="task id" />
        </a>
      ),
    },
    {
      key: "state",
      header: "State",
      priority: "essential",
      render: (task) => <StatusBadge label={humanizeConstant(task.currentState)} tone={taskStateTone(task.currentState, task.isTerminal)} />,
    },
    {
      key: "attempt",
      header: "Attempt",
      priority: "secondary",
      align: "end",
      render: (task) => task.latestAttempt,
    },
    {
      key: "events",
      header: "Events",
      priority: "secondary",
      align: "end",
      render: (task) => formatCount(task.eventCount),
    },
    {
      key: "lastEvent",
      header: "Last event",
      priority: "secondary",
      render: (task) => humanizeConstant(task.lastEventType),
    },
    {
      key: "lastEmittedBy",
      header: "Last worker",
      priority: "tertiary",
      render: (task) => <a href={buildWorkerDetailHash(task.lastEmittedBy)}>{task.lastEmittedBy}</a>,
    },
    {
      key: "createdAt",
      header: "Created",
      priority: "tertiary",
      render: (task) => (
        <time dateTime={task.createdAt} title={formatTimestamp(task.createdAt)}>
          {formatTimestamp(task.createdAt, "compact")}
        </time>
      ),
    },
    {
      key: "updatedAt",
      header: "Updated",
      priority: "secondary",
      render: (task) => (
        <time dateTime={task.updatedAt} title={formatTimestamp(task.updatedAt)}>
          {formatTimestamp(task.updatedAt, "compact")}
        </time>
      ),
    },
  ];

  return (
    <section aria-labelledby="tasks-heading">
      <h1 id="tasks-heading">Tasks</h1>
      <p className="view-lede">Every task the ledger has observed, its current state and the attempt it is on.</p>

      <form className="jump-form" onSubmit={jumpToTask} role="search" aria-label="Open a task by id">
        <label htmlFor="task-jump">Open task by id</label>
        <div className="jump-form__row">
          <input
            id="task-jump"
            name="task-jump"
            type="text"
            value={jumpId}
            onChange={(event) => {
              setJumpId(event.target.value);
            }}
            placeholder="00000000-0000-0000-0000-000000000000"
            aria-describedby={jumpError !== null ? "task-jump-error" : undefined}
          />
          <button type="submit" className="button button--quiet">
            Open
          </button>
        </div>
        {jumpError !== null ? (
          <p id="task-jump-error" role="alert" className="field-error">
            {jumpError}
          </p>
        ) : null}
      </form>

      <FilterBar onApply={applyFilters} onClear={clearFilters} hasActiveFilters={stateFilter !== undefined}>
        <div className="field">
          <label htmlFor="tasks-state">State</label>
          <input
            id="tasks-state"
            name="state"
            type="text"
            value={stateInput}
            onChange={(event) => {
              setStateInput(event.target.value);
            }}
            placeholder="e.g. RUNNING"
            aria-describedby="tasks-state-hint"
          />
          <p id="tasks-state-hint" className="field-hint">
            Matches a task state exactly, as the API returns it.
          </p>
        </div>
      </FilterBar>

      <AsyncSection
        resource={resource}
        lastFetchedAt={lastFetchedAt}
        onRefresh={refresh}
        label="tasks"
        isEmpty={(data) => data.items.length === 0}
        emptyMessage={stateFilter !== undefined ? "No tasks match this filter." : "No tasks have been observed yet."}
      >
        {(data) => (
          <>
            <DataTable caption="Tasks" columns={columns} rows={data.items} rowKey={(task) => task.taskId} rowHeaderKey="taskId" />
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
                  navigate(buildHash("tasks", { state: stateFilter, cursor: data.page.nextCursor }));
                }
              }}
            />
          </>
        )}
      </AsyncSection>
    </section>
  );
}
