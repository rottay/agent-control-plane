import { type TaskDetail } from "@acp/api-contracts";
import { type JSX } from "react";

import { fetchTaskDetail } from "../api/client.js";
import { AsyncSection } from "../components/AsyncSection.js";
import { IdValue } from "../components/IdValue.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { TimelineList } from "../components/TimelineList.js";
import { formatCount, formatTimestamp, humanizeConstant } from "../format/format.js";
import { taskStateTone } from "../format/statusTone.js";
import { useAsyncResource } from "../hooks/useAsyncResource.js";
import { buildHash, buildWorkerDetailHash, type Route } from "../routing/hashRoute.js";
import { NotFoundView } from "./NotFoundView.js";

export interface TaskDetailViewProps {
  readonly route: Route;
}

export function TaskDetailView({ route }: TaskDetailViewProps): JSX.Element {
  const taskId = route.taskId;
  if (taskId === null) {
    return <NotFoundView route={route} />;
  }
  return <TaskDetailLoaded taskId={taskId} />;
}

function TaskDetailLoaded({ taskId }: { readonly taskId: string }): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource((signal) => fetchTaskDetail(taskId, signal), [taskId]);

  return (
    <section aria-labelledby="task-detail-heading">
      <p>
        <a href={buildHash("tasks")}>← Back to tasks</a>
      </p>
      <h1 id="task-detail-heading">
        Task <IdValue value={taskId} kind="task id" />
      </h1>
      <AsyncSection resource={resource} lastFetchedAt={lastFetchedAt} onRefresh={refresh} label="the task">
        {(data) => <TaskDetailContent task={data.task} />}
      </AsyncSection>
    </section>
  );
}

function TaskDetailContent({ task }: { readonly task: TaskDetail }): JSX.Element {
  return (
    <div className="detail">
      <div className="detail__state">
        <StatusBadge label={humanizeConstant(task.currentState)} tone={taskStateTone(task.currentState, task.isTerminal)} />
        {task.isTerminal ? <span className="detail__terminal-note">Terminal — will not progress further on its own.</span> : null}
      </div>

      <dl className="stat-list">
        <div>
          <dt>Attempt</dt>
          <dd>{task.latestAttempt}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{formatCount(task.eventCount)}</dd>
        </div>
        <div>
          <dt>Sequence range</dt>
          <dd>
            {formatCount(task.firstSequence)}–{formatCount(task.lastSequence)}
          </dd>
        </div>
        <div>
          <dt>Last event</dt>
          <dd>{humanizeConstant(task.lastEventType)}</dd>
        </div>
        <div>
          <dt>Last worker</dt>
          <dd>
            <a href={buildWorkerDetailHash(task.lastEmittedBy)}>{task.lastEmittedBy}</a>
          </dd>
        </div>
        <div>
          <dt>Last event id</dt>
          <dd>
            <IdValue value={task.lastEventId} kind="event id" />
          </dd>
        </div>
        <div>
          <dt>Last transition</dt>
          <dd>
            <code>{task.lastTransitionId}</code>
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatTimestamp(task.createdAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatTimestamp(task.updatedAt)}</dd>
        </div>
      </dl>

      <section aria-labelledby="task-detail-events-heading">
        <h2 id="task-detail-events-heading">Recent events</h2>
        {task.recentEvents.length === 0 ? (
          <p>No events are inlined for this task.</p>
        ) : (
          <TimelineList caption="Recent events for this task" items={task.recentEvents} showTaskColumn={false} />
        )}
      </section>
    </div>
  );
}
