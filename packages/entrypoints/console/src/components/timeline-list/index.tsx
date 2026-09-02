import { type TimelineItem } from "@acp/protocol";
import { useMemo, type JSX } from "react";

import { buildTaskDetailHash, buildWorkerDetailHash } from "../../routing/hash-route/index.js";
import { verifyChainLinkage, type ChainLinkStatus } from "../../format/chain/index.js";
import { formatByteSize, formatTimestamp, humanizeConstant } from "../../format/index.js";
import { type Column, DataTable } from "../data-table/index.js";
import { IdValue } from "../id-value/index.js";
import { StatusBadge } from "../status-badge/index.js";

export interface TimelineListProps {
  readonly caption: string;
  readonly items: readonly TimelineItem[];
  readonly showTaskColumn?: boolean;
  readonly showWorkerColumn?: boolean;
}

const CHAIN_LABEL: Record<ChainLinkStatus, string> = {
  linked: "Linked",
  gap: "Not on this page",
  anomaly: "Chain mismatch",
};

const CHAIN_TONE: Record<ChainLinkStatus, "good" | "neutral" | "bad"> = {
  linked: "good",
  gap: "neutral",
  anomaly: "bad",
};

/** The append-only event timeline, shared by the task, worker and events views. */
export function TimelineList({
  caption,
  items,
  showTaskColumn = true,
  showWorkerColumn = true,
}: TimelineListProps): JSX.Element {
  const linkage = useMemo(() => verifyChainLinkage(items), [items]);

  const columns: Column<TimelineItem>[] = [
    {
      key: "sequence",
      header: "Seq",
      priority: "essential",
      align: "end",
      render: (item) => item.sequence,
    },
    {
      key: "chain",
      header: "Chain",
      priority: "secondary",
      render: (item) => {
        const status = linkage.get(item.sequence) ?? "gap";
        return <StatusBadge label={CHAIN_LABEL[status]} tone={CHAIN_TONE[status]} />;
      },
    },
    {
      key: "type",
      header: "Event",
      priority: "essential",
      render: (item) => humanizeConstant(item.type),
    },
    {
      key: "transition",
      header: "Transition",
      priority: "essential",
      render: (item) => (
        <span className="transition">
          <span className="transition__from">{item.fromState !== null ? humanizeConstant(item.fromState) : "—"}</span>
          <span aria-hidden="true"> → </span>
          <span className="sr-only"> to </span>
          <span className="transition__to">{humanizeConstant(item.toState)}</span>
        </span>
      ),
    },
    ...(showWorkerColumn
      ? [
          {
            key: "worker",
            header: "Worker",
            priority: "secondary",
            render: (item: TimelineItem) => <a href={buildWorkerDetailHash(item.emittedBy)}>{item.emittedBy}</a>,
          } satisfies Column<TimelineItem>,
        ]
      : []),
    ...(showTaskColumn
      ? [
          {
            key: "task",
            header: "Task",
            priority: "secondary",
            render: (item: TimelineItem) => (
              <a href={buildTaskDetailHash(item.taskId)}>
                <IdValue value={item.taskId} kind="task id" />
              </a>
            ),
          } satisfies Column<TimelineItem>,
        ]
      : []),
    {
      key: "occurredAt",
      header: "Occurred",
      priority: "secondary",
      render: (item) => (
        <time dateTime={item.occurredAt} title={formatTimestamp(item.occurredAt)}>
          {formatTimestamp(item.occurredAt, "compact")}
        </time>
      ),
    },
    {
      key: "eventId",
      header: "Event id",
      priority: "tertiary",
      render: (item) => <IdValue value={item.eventId} kind="event id" />,
    },
    {
      key: "payload",
      header: "Payload",
      priority: "tertiary",
      render: (item) => formatByteSize(item.payloadByteSize) + " · " + String(item.payloadKeys.length) + " keys",
    },
  ];

  return <DataTable caption={caption} columns={columns} rows={items} rowKey={(item) => item.eventId} />;
}
