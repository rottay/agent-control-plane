import { type TaskDetail } from "@acp/protocol";
import { type JSX } from "react";

import { fetchTaskDetail } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { TimelineList } from "../../components/timeline-list/index.js";
import { formatCount, formatTimestamp, humanizeConstant } from "../../format/index.js";
import { taskStateTone } from "../../format/status-tone/index.js";
import { useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { buildHash, buildWorkerDetailHash, type Route } from "../../routing/hash-route/index.js";
import { NotFoundView } from "../not-found-view/index.js";

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
