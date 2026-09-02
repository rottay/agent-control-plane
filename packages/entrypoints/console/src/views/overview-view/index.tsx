import { type ObservationCapabilities, type OverviewResponse } from "@acp/protocol";
import { type JSX } from "react";

import { fetchOverview } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { BarBreakdown } from "../../components/bar-breakdown/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { formatCount, formatTimestamp, humanizeConstant } from "../../format/index.js";
import { integrityTone, overviewStateTone } from "../../format/status-tone/index.js";
import { useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { buildHash } from "../../routing/hash-route/index.js";

const CAPABILITY_LABELS: readonly { readonly key: keyof ObservationCapabilities; readonly label: string }[] = [
  { key: "readOnly", label: "Read access" },
  { key: "writes", label: "Writes" },
  { key: "routing", label: "Task routing" },
  { key: "accounts", label: "Provider accounts" },
  { key: "leases", label: "Worktree leases" },
];

const FUTURE_SURFACES: readonly { readonly title: string; readonly summary: string }[] = [
  { title: "Diffs", summary: "Reviewing a packet's changes against its declared write-set." },
  { title: "Gates", summary: "The phase and authority gates a packet must clear before it can commit." },
  { title: "Accounts and leases", summary: "Which provider account and worktree a worker currently holds." },
];

export function OverviewView(): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource(fetchOverview, []);

  return (
    <section aria-labelledby="overview-heading">
      <h1 id="overview-heading">Overview</h1>
      <p className="view-lede">
        Whether the control plane is readable, empty, active or degraded, and what it can and cannot do
        in this phase.
      </p>
      <AsyncSection resource={resource} lastFetchedAt={lastFetchedAt} onRefresh={refresh} label="the overview">
        {(data) => <OverviewContent data={data} />}
      </AsyncSection>
    </section>
  );
}

function OverviewContent({ data }: { readonly data: OverviewResponse }): JSX.Element {
  return (
    <div className="overview">
      <div className="overview__state">
        <StatusBadge label={humanizeConstant(data.state)} tone={overviewStateTone(data.state)} srPrefix="Control plane state" />
        <span className="overview__observedAt">as of {formatTimestamp(data.observedAt)}</span>
      </div>

      {data.notice !== null ? (
        <p className="overview__notice" role={data.state === "DEGRADED" || data.state === "UNAVAILABLE" ? "alert" : undefined}>
          {data.notice}
        </p>
      ) : null}

      {data.database !== null ? (
        <p className="overview__database">
          Reading <strong>{data.database.label}</strong> (<IdValue value={data.database.id} kind="database digest" />)
        </p>
      ) : (
        <p className="overview__database">No database is open.</p>
      )}

      <div className="overview__grid">
        <section aria-labelledby="overview-ledger-heading" className="panel">
          <h2 id="overview-ledger-heading">Ledger</h2>
          {data.ledger === null ? (
            <p>No ledger reading is available.</p>
          ) : (
            <dl className="stat-list">
              <div>
                <dt>Events</dt>
                <dd>{formatCount(data.ledger.eventCount)}</dd>
              </div>
              <div>
                <dt>Head sequence</dt>
                <dd>{formatCount(data.ledger.headSequence)}</dd>
              </div>
              <div>
                <dt>Head digest</dt>
                <dd>
                  <IdValue value={data.ledger.headEventSha256} kind="head digest" />
                </dd>
              </div>
              <div>
                <dt>Last event</dt>
                <dd>{data.ledger.lastEventAt !== null ? formatTimestamp(data.ledger.lastEventAt) : "never"}</dd>
              </div>
            </dl>
          )}
        </section>

        <section aria-labelledby="overview-integrity-heading" className="panel">
          <h2 id="overview-integrity-heading">Integrity</h2>
          {!data.integrity.checked ? (
            <p>Not yet checked.</p>
          ) : (
            <>
              <p>
                <StatusBadge
                  label={data.integrity.ok === true ? "Passing" : "Failing"}
                  tone={integrityTone(data.integrity.ok)}
                />
              </p>
              <dl className="stat-list">
                <div>
                  <dt>Problems</dt>
                  <dd>{data.integrity.problemCount !== null ? formatCount(data.integrity.problemCount) : "unknown"}</dd>
                </div>
                <div>
                  <dt>Checked</dt>
                  <dd>{data.integrity.checkedAt !== null ? formatTimestamp(data.integrity.checkedAt) : "unknown"}</dd>
                </div>
              </dl>
            </>
          )}
          <p>
            <a href={buildHash("integrity")}>Open the full integrity report</a>
          </p>
        </section>

        <section aria-labelledby="overview-tasks-heading" className="panel">
          <h2 id="overview-tasks-heading">Tasks</h2>
          <dl className="stat-list">
            <div>
              <dt>Total</dt>
              <dd>{formatCount(data.tasks.total)}</dd>
            </div>
            <div>
              <dt>Active</dt>
              <dd>{formatCount(data.tasks.active)}</dd>
            </div>
            <div>
              <dt>Terminal</dt>
              <dd>{formatCount(data.tasks.terminal)}</dd>
            </div>
          </dl>
          {data.tasks.byState.length > 0 ? (
            <BarBreakdown
              caption="Tasks by state"
              total={data.tasks.total}
              items={data.tasks.byState.map((entry) => ({ label: humanizeConstant(entry.state), count: entry.count }))}
            />
          ) : null}
          <p>
            <a href={buildHash("tasks")}>Open the tasks list</a>
          </p>
        </section>

        <section aria-labelledby="overview-workers-heading" className="panel">
          <h2 id="overview-workers-heading">Workers</h2>
          <dl className="stat-list">
            <div>
              <dt>Total</dt>
              <dd>{formatCount(data.workers.total)}</dd>
            </div>
          </dl>
          {data.workers.byRole.length > 0 ? (
            <BarBreakdown
              caption="Workers by role"
              total={data.workers.total}
              items={data.workers.byRole.map((entry) => ({ label: humanizeConstant(entry.role), count: entry.count }))}
            />
          ) : null}
          <p>
            <a href={buildHash("workers")}>Open the workers list</a>
          </p>
        </section>
      </div>

      <section aria-labelledby="overview-capabilities-heading" className="panel">
        <h2 id="overview-capabilities-heading">What this plane can do</h2>
        <ul className="capability-list">
          {CAPABILITY_LABELS.map((entry) => {
            const value = data.capabilities[entry.key];
            return (
              <li key={entry.key}>
                <StatusBadge label={entry.label} tone={value ? "good" : "neutral"} srPrefix={value ? "Available" : "Not available"} />
              </li>
            );
          })}
        </ul>
        <h3>Planned, not yet observable</h3>
        <ul className="future-surface-list">
          {FUTURE_SURFACES.map((surface) => (
            <li key={surface.title}>
              <p className="future-surface-list__title">{surface.title}</p>
              <p>{surface.summary}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
