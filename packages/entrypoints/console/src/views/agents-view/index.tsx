import { type InitiativeAgentsResponse, type ScopedAgentSummary } from "@acp/protocol";
import { type JSX } from "react";

import { fetchInitiativeAgents } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { type Column, DataTable } from "../../components/data-table/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { formatCount, formatTimestamp, humanizeConstant } from "../../format/index.js";
import { useAsyncResource, type Resource } from "../../hooks/use-async-resource/index.js";
import { buildTaskDetailHash, buildWorkerDetailHash, type Route } from "../../routing/hash-route/index.js";
import { NotFoundView } from "../not-found-view/index.js";
import { WorkspaceSubnav } from "../workspace-view/index.js";

/**
 * The scoped agents surface (P8-8E, blueprint §3): the workers that have
 * acted on one initiative (`fetchInitiativeAgents`, P8-8E-pre's C3) —
 * identity, role, the task each last touched *here*, and its last action.
 *
 * Every count and instant is already scoped by the server (C3's own point):
 * `currentTaskId` names the task this identity last acted on within this
 * initiative, never the global worker projection's `lastTaskId`, which
 * routinely names a task elsewhere. This view does not re-derive or second
 * -guess that; it renders what the endpoint already scoped correctly.
 */

export interface AgentsViewProps {
  readonly route: Route;
}

export function AgentsView({ route }: AgentsViewProps): JSX.Element {
  const initiativeId = route.initiativeId;
  if (initiativeId === null) {
    return <NotFoundView route={route} />;
  }
  return <AgentsHooked route={route} initiativeId={initiativeId} />;
}

function AgentsHooked({ route, initiativeId }: { readonly route: Route; readonly initiativeId: string }): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource(
    (signal) => fetchInitiativeAgents(initiativeId, signal),
    [initiativeId],
  );
  return (
    <AgentsSection
      route={route}
      initiativeId={initiativeId}
      resource={resource}
      lastFetchedAt={lastFetchedAt}
      onRefresh={refresh}
    />
  );
}

export interface AgentsSectionProps {
  readonly route: Route;
  readonly initiativeId: string;
  readonly resource: Resource<InitiativeAgentsResponse>;
  readonly lastFetchedAt: Date | null;
  readonly onRefresh: () => void;
}

/**
 * The resource-driven half of the agents view, split out the same way every
 * other scoped section in this cohort was, for the same reason: a test
 * drives every state with a constructed `Resource` fixture.
 */
export function AgentsSection({ route, initiativeId, resource, lastFetchedAt, onRefresh }: AgentsSectionProps): JSX.Element {
  // The id-validation law (C3/C5): read from this fetch's own 404, the same
  // as every other scoped view — `initiativeAgents` 404s on an unknown id
  // exactly as `initiativeById` does.
  if (resource.status === "error" && resource.error.status === 404) {
    return <NotFoundView route={route} />;
  }

  return (
    <section aria-labelledby="agents-heading">
      <h1 id="agents-heading">Agents</h1>
      <p className="view-lede">
        The workers that have acted on this initiative — identity, role, the task each last touched
        here, and its last action.
      </p>

      <WorkspaceSubnav route={route} initiativeId={initiativeId} />

      <AsyncSection
        resource={resource}
        lastFetchedAt={lastFetchedAt}
        onRefresh={onRefresh}
        label="the agents"
        isEmpty={(data) => data.items.length === 0}
        emptyMessage="No worker has acted on this initiative yet."
      >
        {(data) => <DataTable caption="Initiative agents" columns={AGENT_COLUMNS} rows={data.items} rowKey={(agent) => agent.identity} />}
      </AsyncSection>
    </section>
  );
}

/**
 * Role reuses the landed `StatusBadge` component — the same accessible,
 * never-color-only presentation every other status in this package uses —
 * at a uniform `neutral` tone. A worker role (`coordinator`, `implementer`,
 * `reviewer`, `consultant`, `verifier`) is a categorical identity, not a
 * state of success, warning or failure, so this view does not invent a
 * good/bad ranking among roles the way `taskStateTone` legitimately can for
 * a lifecycle state.
 */
const AGENT_COLUMNS: Column<ScopedAgentSummary>[] = [
  {
    key: "identity",
    header: "Identity",
    priority: "essential",
    render: (agent) => <a href={buildWorkerDetailHash(agent.identity)}>{agent.identity}</a>,
  },
  {
    key: "role",
    header: "Role",
    priority: "essential",
    render: (agent) => <StatusBadge label={humanizeConstant(agent.role)} tone="neutral" />,
  },
  {
    key: "currentTask",
    header: "Current task",
    priority: "essential",
    render: (agent) => (
      <a href={buildTaskDetailHash(agent.currentTaskId)}>
        <IdValue value={agent.currentTaskId} kind="task id" />
      </a>
    ),
  },
  {
    key: "lastAction",
    header: "Last action",
    priority: "essential",
    render: (agent) => humanizeConstant(agent.lastEventType),
  },
  {
    key: "provider",
    header: "Provider",
    priority: "secondary",
    render: (agent) => agent.provider,
  },
  {
    key: "model",
    header: "Model",
    priority: "secondary",
    render: (agent) => agent.model,
  },
  {
    key: "eventCount",
    header: "Events",
    priority: "secondary",
    align: "end",
    render: (agent) => formatCount(agent.eventCount),
  },
  {
    key: "taskCount",
    header: "Tasks",
    priority: "secondary",
    align: "end",
    render: (agent) => formatCount(agent.taskCount),
  },
  {
    key: "lastSeenAt",
    header: "Last seen",
    priority: "tertiary",
    render: (agent) => (
      <time dateTime={agent.lastSeenAt} title={formatTimestamp(agent.lastSeenAt)}>
        {formatTimestamp(agent.lastSeenAt, "compact")}
      </time>
    ),
  },
];
