import { type TaskDetail } from "@acp/protocol";
import { useMemo, type JSX } from "react";

import { fetchTaskDetail } from "../../api/client/index.js";
import { STREAM_VIEW_ITEMS } from "../../api/stream/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { StreamStatus } from "../../components/stream-status/index.js";
import { TimelineList } from "../../components/timeline-list/index.js";
import { formatCount, formatTimestamp, humanizeConstant } from "../../format/index.js";
import { taskStateTone } from "../../format/status-tone/index.js";
import { useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { useEventStream } from "../../hooks/use-event-stream/index.js";
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

  /**
   * The live tail, selected down to this task (V2-B3b).
   *
   * The subscription is the same unfiltered one the timeline uses, for the
   * reason `api/stream` gives at length: a `?taskId=` stream would deliver a
   * subsequence of the ledger, and a client cannot tell a missing row from a
   * non-adjacent one in a subsequence. Selecting locally keeps the exact-next
   * sequence law checkable and costs this browser rows it will not draw.
   */
  const stream = useEventStream({ onDatabaseChanged: refresh });
  const liveItems = useMemo(
    () => stream.items.filter((item) => item.taskId === taskId).slice(-STREAM_VIEW_ITEMS),
    [stream.items, taskId],
  );

  return (
    <section aria-labelledby="task-detail-heading">
      <p>
        <a href={buildHash("tasks")}>← Back to tasks</a>
      </p>
      <h1 id="task-detail-heading">
        Task <IdValue value={taskId} kind="task id" />
      </h1>

      <StreamStatus status={stream} label="this task" />

      {liveItems.length > 0 ? (
        <section className="stream-live" aria-labelledby="task-detail-live-heading">
          <h2 id="task-detail-live-heading" className="stream-live__heading">
            Live since this page opened
          </h2>
          <p className="stream-live__note">
            Events for this task, applied in ledger sequence order. The detail below is the response
            that was fetched and does not move on its own.
          </p>
          <TimelineList caption="Live events for this task" items={liveItems} showTaskColumn={false} />
        </section>
      ) : null}

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
