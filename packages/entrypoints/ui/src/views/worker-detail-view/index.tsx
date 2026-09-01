import { type WorkerDetail } from "@acp/api-contracts";
import { type JSX } from "react";

import { fetchWorkerDetail } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { TimelineList } from "../../components/timeline-list/index.js";
import { formatCount, formatTimestamp, humanizeConstant } from "../../format/index.js";
import { useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { buildHash, buildTaskDetailHash, type Route } from "../../routing/hash-route/index.js";
import { NotFoundView } from "../not-found-view/index.js";

export interface WorkerDetailViewProps {
  readonly route: Route;
}

export function WorkerDetailView({ route }: WorkerDetailViewProps): JSX.Element {
  const identity = route.workerIdentity;
  if (identity === null) {
    return <NotFoundView route={route} />;
  }
  return <WorkerDetailLoaded identity={identity} />;
}

function WorkerDetailLoaded({ identity }: { readonly identity: string }): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource((signal) => fetchWorkerDetail(identity, signal), [identity]);

  return (
    <section aria-labelledby="worker-detail-heading">
      <p>
        <a href={buildHash("workers")}>← Back to workers</a>
      </p>
      <h1 id="worker-detail-heading">
        Worker <code>{identity}</code>
      </h1>
      <AsyncSection resource={resource} lastFetchedAt={lastFetchedAt} onRefresh={refresh} label="the worker">
        {(data) => <WorkerDetailContent worker={data.worker} />}
      </AsyncSection>
    </section>
  );
}

function WorkerDetailContent({ worker }: { readonly worker: WorkerDetail }): JSX.Element {
  return (
    <div className="detail">
      <dl className="stat-list">
        <div>
          <dt>Provider</dt>
          <dd>{worker.provider}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{worker.model}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{humanizeConstant(worker.role)}</dd>
        </div>
        <div>
          <dt>Instance</dt>
          <dd>{worker.instance}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{formatCount(worker.eventCount)}</dd>
        </div>
        <div>
          <dt>Tasks</dt>
          <dd>{formatCount(worker.taskCount)}</dd>
        </div>
        <div>
          <dt>Last event</dt>
          <dd>{humanizeConstant(worker.lastEventType)}</dd>
        </div>
        <div>
          <dt>Last task</dt>
          <dd>
            <a href={buildTaskDetailHash(worker.lastTaskId)}>
              <IdValue value={worker.lastTaskId} kind="task id" />
            </a>
          </dd>
        </div>
        <div>
          <dt>First seen</dt>
          <dd>{formatTimestamp(worker.firstSeenAt)}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{formatTimestamp(worker.lastSeenAt)}</dd>
        </div>
      </dl>

      <section aria-labelledby="worker-detail-events-heading">
        <h2 id="worker-detail-events-heading">Recent events</h2>
        {worker.recentEvents.length === 0 ? (
          <p>No events are inlined for this worker.</p>
        ) : (
          <TimelineList caption="Recent events for this worker" items={worker.recentEvents} showWorkerColumn={false} />
        )}
      </section>
    </div>
  );
}
