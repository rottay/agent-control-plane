import { type AppliedMigrationDto, type ProjectionStatusDto } from "@acp/protocol";
import { type JSX } from "react";

import { fetchStatus } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { DataTable, type Column } from "../../components/data-table/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { formatCount, formatTimestamp } from "../../format/index.js";
import { useAsyncResource } from "../../hooks/use-async-resource/index.js";

const MIGRATION_COLUMNS: readonly Column<AppliedMigrationDto>[] = [
  { key: "version", header: "Version", priority: "essential", align: "end", render: (row) => row.version },
  { key: "name", header: "Name", priority: "essential", render: (row) => row.name },
  { key: "sha256", header: "Digest", priority: "secondary", render: (row) => <IdValue value={row.sha256} kind="migration digest" /> },
  {
    key: "appliedAt",
    header: "Applied",
    priority: "secondary",
    render: (row) => (
      <time dateTime={row.appliedAt} title={formatTimestamp(row.appliedAt)}>
        {formatTimestamp(row.appliedAt, "compact")}
      </time>
    ),
  },
];

/**
 * One table row per (projection, stream), flattened for rendering only.
 *
 * A projection fed by two streams carries two fixed heads, and a table with one
 * row per projection could only show one of them. This type is deliberately
 * local and unexported: a "row per pair" shape is the DTO the adjudication
 * rejected, and letting one out of this module is how it would come back.
 */
interface ProjectionWatermarkRow {
  readonly name: string;
  readonly rowCount: number;
  readonly updatedAt: string;
  readonly sourceStream: string;
  readonly appliedThroughSequence: number;
  readonly eventCount: number;
  readonly sourceHeadSha256: string;
}

function watermarkRows(
  projections: readonly ProjectionStatusDto[],
): readonly ProjectionWatermarkRow[] {
  return projections.flatMap((projection) =>
    projection.watermarks.map((watermark) => ({
      name: projection.name,
      rowCount: projection.rowCount,
      updatedAt: projection.updatedAt,
      sourceStream: watermark.sourceStream,
      appliedThroughSequence: watermark.appliedThroughSequence,
      eventCount: watermark.eventCount,
      sourceHeadSha256: watermark.sourceHeadSha256,
    })),
  );
}

const PROJECTION_COLUMNS: readonly Column<ProjectionWatermarkRow>[] = [
  { key: "name", header: "Projection", priority: "essential", render: (row) => row.name },
  { key: "sourceStream", header: "Stream", priority: "essential", render: (row) => row.sourceStream },
  { key: "appliedThrough", header: "Applied through", priority: "essential", align: "end", render: (row) => formatCount(row.appliedThroughSequence) },
  { key: "eventCount", header: "Events", priority: "secondary", align: "end", render: (row) => formatCount(row.eventCount) },
  { key: "rowCount", header: "Rows", priority: "secondary", align: "end", render: (row) => formatCount(row.rowCount) },
  { key: "sourceHead", header: "Source head", priority: "tertiary", render: (row) => <IdValue value={row.sourceHeadSha256} kind="source head digest" /> },
  {
    key: "updatedAt",
    header: "Updated",
    priority: "secondary",
    render: (row) => (
      <time dateTime={row.updatedAt} title={formatTimestamp(row.updatedAt)}>
        {formatTimestamp(row.updatedAt, "compact")}
      </time>
    ),
  },
];

export function StatusView(): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource(fetchStatus, []);

  return (
    <section aria-labelledby="status-heading">
      <h1 id="status-heading">Ledger status</h1>
      <p className="view-lede">The ledger's own operating status: pragmas, applied migrations and read model projections.</p>
      <AsyncSection resource={resource} lastFetchedAt={lastFetchedAt} onRefresh={refresh} label="the ledger status">
        {(data) => (
          <div className="detail">
            <p>
              Reading <strong>{data.database.label}</strong> (<IdValue value={data.database.id} kind="database digest" />
              ), {data.readOnly ? "read-only" : "read-write"}.
            </p>
            <dl className="stat-list">
              <div>
                <dt>Events</dt>
                <dd>{formatCount(data.eventCount)}</dd>
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
                <dt>Journal mode</dt>
                <dd>{data.pragmas.journalMode}</dd>
              </div>
              <div>
                <dt>Foreign keys</dt>
                <dd>{data.pragmas.foreignKeys ? "on" : "off"}</dd>
              </div>
              <div>
                <dt>Synchronous</dt>
                <dd>{data.pragmas.synchronous}</dd>
              </div>
              <div>
                <dt>Busy timeout</dt>
                <dd>{formatCount(data.pragmas.busyTimeoutMs)} ms</dd>
              </div>
              <div>
                <dt>Query only</dt>
                <dd>{data.pragmas.queryOnly ? "yes" : "no"}</dd>
              </div>
            </dl>

            <section aria-labelledby="status-migrations-heading">
              <h2 id="status-migrations-heading">Applied migrations</h2>
              {data.migrations.length === 0 ? (
                <p>No migrations recorded.</p>
              ) : (
                <DataTable caption="Applied migrations" columns={[...MIGRATION_COLUMNS]} rows={data.migrations} rowKey={(row) => String(row.version)} />
              )}
            </section>

            <section aria-labelledby="status-projections-heading">
              <h2 id="status-projections-heading">Read model projections</h2>
              {data.projections.length === 0 ? (
                <p>No projections recorded.</p>
              ) : (
                <DataTable
                  caption="Read model projections"
                  columns={[...PROJECTION_COLUMNS]}
                  rows={watermarkRows(data.projections)}
                  rowKey={(row) => row.name + ":" + row.sourceStream}
                />
              )}
            </section>
          </div>
        )}
      </AsyncSection>
    </section>
  );
}
