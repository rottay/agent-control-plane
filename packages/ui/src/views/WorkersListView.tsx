import { DEFAULT_PAGE_LIMIT, type WorkerSummary } from "@acp/api-contracts";
import { useState, type SubmitEvent, type JSX } from "react";

import { fetchWorkers } from "../api/client.js";
import { AsyncSection } from "../components/AsyncSection.js";
import { DataTable, type Column } from "../components/DataTable.js";
import { FilterBar } from "../components/FilterBar.js";
import { Pagination } from "../components/Pagination.js";
import { formatCount, formatTimestamp, humanizeConstant } from "../format/format.js";
import { useAsyncResource } from "../hooks/useAsyncResource.js";
import { buildHash, buildWorkerDetailHash, type Route } from "../routing/hashRoute.js";
import { type NavigateFn } from "../routing/useHashRoute.js";

export interface WorkersListViewProps {
  readonly route: Route;
  readonly navigate: NavigateFn;
}

export function WorkersListView({ route, navigate }: WorkersListViewProps): JSX.Element {
  const roleFilter = route.query["role"];
  const providerFilter = route.query["provider"];
  const cursor = route.query["cursor"];
  const [roleInput, setRoleInput] = useState(roleFilter ?? "");
  const [providerInput, setProviderInput] = useState(providerFilter ?? "");
  const [jumpIdentity, setJumpIdentity] = useState("");
  const [jumpError, setJumpError] = useState<string | null>(null);

  const { resource, lastFetchedAt, refresh } = useAsyncResource(
    (signal) => fetchWorkers({ role: roleFilter, provider: providerFilter, cursor, limit: DEFAULT_PAGE_LIMIT }, signal),
    [roleFilter, providerFilter, cursor],
  );

  function applyFilters(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const role = roleInput.trim();
    const provider = providerInput.trim();
    navigate(buildHash("workers", { role: role === "" ? undefined : role, provider: provider === "" ? undefined : provider }));
  }

  function clearFilters(): void {
    setRoleInput("");
    setProviderInput("");
    navigate(buildHash("workers"));
  }

  function jumpToWorker(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = jumpIdentity.trim();
    if (trimmed.split("/").length !== 4) {
      setJumpError("Enter a full identity: provider/model/role/instance.");
      return;
    }
    setJumpError(null);
    navigate(buildWorkerDetailHash(trimmed));
  }

  const columns: Column<WorkerSummary>[] = [
    {
      key: "identity",
      header: "Identity",
      priority: "essential",
      render: (worker) => <a href={buildWorkerDetailHash(worker.identity)}>{worker.identity}</a>,
    },
    {
      key: "role",
      header: "Role",
      priority: "essential",
      render: (worker) => humanizeConstant(worker.role),
    },
    {
      key: "events",
      header: "Events",
      priority: "secondary",
      align: "end",
      render: (worker) => formatCount(worker.eventCount),
    },
    {
      key: "tasks",
      header: "Tasks",
      priority: "secondary",
      align: "end",
      render: (worker) => formatCount(worker.taskCount),
    },
    {
      key: "lastEvent",
      header: "Last event",
      priority: "tertiary",
      render: (worker) => humanizeConstant(worker.lastEventType),
    },
    {
      key: "firstSeenAt",
      header: "First seen",
      priority: "tertiary",
      render: (worker) => (
        <time dateTime={worker.firstSeenAt} title={formatTimestamp(worker.firstSeenAt)}>
          {formatTimestamp(worker.firstSeenAt, "compact")}
        </time>
      ),
    },
    {
      key: "lastSeenAt",
      header: "Last seen",
      priority: "secondary",
      render: (worker) => (
        <time dateTime={worker.lastSeenAt} title={formatTimestamp(worker.lastSeenAt)}>
          {formatTimestamp(worker.lastSeenAt, "compact")}
        </time>
      ),
    },
  ];

  return (
    <section aria-labelledby="workers-heading">
      <h1 id="workers-heading">Workers</h1>
      <p className="view-lede">
        Identities that have emitted at least one event. An observation, not a registry: routing,
        accounts and leases do not exist in this phase.
      </p>

      <form className="jump-form" onSubmit={jumpToWorker} role="search" aria-label="Open a worker by identity">
        <label htmlFor="worker-jump">Open worker by identity</label>
        <div className="jump-form__row">
          <input
            id="worker-jump"
            name="worker-jump"
            type="text"
            value={jumpIdentity}
            onChange={(event) => {
              setJumpIdentity(event.target.value);
            }}
            placeholder="provider/model/role/instance"
            aria-describedby={jumpError !== null ? "worker-jump-error" : undefined}
          />
          <button type="submit" className="button button--quiet">
            Open
          </button>
        </div>
        {jumpError !== null ? (
          <p id="worker-jump-error" role="alert" className="field-error">
            {jumpError}
          </p>
        ) : null}
      </form>

      <FilterBar onApply={applyFilters} onClear={clearFilters} hasActiveFilters={roleFilter !== undefined || providerFilter !== undefined}>
        <div className="field">
          <label htmlFor="workers-role">Role</label>
          <input
            id="workers-role"
            name="role"
            type="text"
            value={roleInput}
            onChange={(event) => {
              setRoleInput(event.target.value);
            }}
            placeholder="e.g. implementer"
          />
        </div>
        <div className="field">
          <label htmlFor="workers-provider">Provider</label>
          <input
            id="workers-provider"
            name="provider"
            type="text"
            value={providerInput}
            onChange={(event) => {
              setProviderInput(event.target.value);
            }}
            placeholder="e.g. claude"
          />
        </div>
      </FilterBar>

      <AsyncSection
        resource={resource}
        lastFetchedAt={lastFetchedAt}
        onRefresh={refresh}
        label="workers"
        isEmpty={(data) => data.items.length === 0}
        emptyMessage={roleFilter !== undefined || providerFilter !== undefined ? "No workers match this filter." : "No worker has emitted an event yet."}
      >
        {(data) => (
          <>
            <DataTable caption="Workers" columns={columns} rows={data.items} rowKey={(worker) => worker.identity} rowHeaderKey="identity" />
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
                  navigate(buildHash("workers", { role: roleFilter, provider: providerFilter, cursor: data.page.nextCursor }));
                }
              }}
            />
          </>
        )}
      </AsyncSection>
    </section>
  );
}
