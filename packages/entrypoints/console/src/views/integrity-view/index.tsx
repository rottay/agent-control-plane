import { type IntegrityProblemDto } from "@acp/protocol";
import { type JSX } from "react";

import { fetchIntegrity } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { DataTable, type Column } from "../../components/data-table/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { formatCount, formatTimestamp, humanizeConstant } from "../../format/index.js";
import { integrityTone } from "../../format/status-tone/index.js";
import { useAsyncResource } from "../../hooks/use-async-resource/index.js";

const PROBLEM_COLUMNS: readonly Column<IntegrityProblemDto>[] = [
  { key: "kind", header: "Kind", priority: "essential", render: (row) => humanizeConstant(row.kind) },
  { key: "detail", header: "Detail", priority: "essential", render: (row) => row.detail },
  { key: "sequence", header: "Sequence", priority: "secondary", align: "end", render: (row) => (row.sequence !== null ? formatCount(row.sequence) : "—") },
];

export function IntegrityView(): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource(fetchIntegrity, []);

  return (
    <section aria-labelledby="integrity-heading">
      <h1 id="integrity-heading">Integrity</h1>
      <p className="view-lede">
        The result of verifying the hash chain, the schema shape and the derived read models against a
        fresh replay.
      </p>
      <AsyncSection resource={resource} lastFetchedAt={lastFetchedAt} onRefresh={refresh} label="the integrity report">
        {(data) => (
          <div className="detail">
            <p>
              <StatusBadge label={data.ok ? "Passing" : "Failing"} tone={integrityTone(data.ok)} />
            </p>
            <dl className="stat-list">
              <div>
                <dt>Checked events</dt>
                <dd>{formatCount(data.checkedEvents)}</dd>
              </div>
              <div>
                <dt>Head sequence</dt>
                <dd>{formatCount(data.headSequence)}</dd>
              </div>
              <div>
                <dt>Head digest</dt>
                <dd>
                  <IdValue value={data.headEventSha256} kind="head digest" />
                </dd>
              </div>
              <div>
                <dt>Checked at</dt>
                <dd>{formatTimestamp(data.checkedAt)}</dd>
              </div>
            </dl>

            <section aria-labelledby="integrity-problems-heading">
              <h2 id="integrity-problems-heading">Problems</h2>
              {data.truncated ? (
                <p role="alert" className="field-error">
                  This list was truncated at the server's reporting ceiling; more problems exist than are
                  shown here.
                </p>
              ) : null}
              {data.problems.length === 0 ? (
                <p>No problems found.</p>
              ) : (
                <DataTable
                  caption="Integrity problems"
                  columns={[...PROBLEM_COLUMNS]}
                  rows={data.problems}
                  rowKey={(row) => row.kind + ":" + String(row.sequence ?? "none") + ":" + row.detail}
                />
              )}
            </section>
          </div>
        )}
      </AsyncSection>
    </section>
  );
}
