import { type InitiativeTimelineResponse, type ScopedTimelineEntry } from "@acp/api-contracts";
import { Background, MarkerType, ReactFlow, type Edge as XyEdge, type Node as XyNode } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useState, type JSX } from "react";

import { fetchInitiativeTimeline } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { type Column, DataTable } from "../../components/data-table/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { humanizeConstant, truncateMiddle } from "../../format/index.js";
import { taskStateTone, type Tone } from "../../format/status-tone/index.js";
import { type Resource, useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { buildTaskDetailHash, type Route } from "../../routing/hash-route/index.js";
import { NotFoundView } from "../not-found-view/index.js";
import { WorkspaceSubnav } from "../workspace-view/index.js";

/**
 * The task graph (P8-8E, blueprint §1, C6).
 *
 * Nodes are tasks, state-toned; edges are real causal facts, never invented
 * — derived below, purely, from the same merged timeline the scoped
 * `TimelineView` renders (`fetchInitiativeTimeline`, P8-8E-pre's C2). One
 * fetch feeds the canvas and the list both, so they are never two different
 * ideas of the data.
 *
 * **C6 is binding**: the layout (`layoutGraph`) is a pure exported function,
 * unit-tested without a canvas. The `@xyflow/react` canvas itself mounts
 * behind a client-only seam (`GraphCanvas`) — it measures real DOM nodes and
 * cannot render under `renderToStaticMarkup` (C5) — and it is marked
 * `aria-hidden` with every element inside it made unfocusable, because the
 * **list below it, not the canvas, is the keyboard surface** and carries the
 * identical node/edge facts (the same-data contract, N-notes). This is not a
 * closed-content-for-test-convenience trick (the P8-8C/8D correction this
 * cohort was told to hold): the canvas is genuinely absent from the tree
 * under static rendering, not present-but-hidden, and in a real browser it
 * mounts for real once React's effects run.
 */

export interface GraphViewProps {
  readonly route: Route;
}

export function GraphView({ route }: GraphViewProps): JSX.Element {
  const initiativeId = route.initiativeId;
  if (initiativeId === null) {
    // The route grammar only ever builds a "graph" route scoped to an
    // initiative (hash-route/index.ts). A runtime guard, not a non-null
    // assertion, so a routing regression fails loudly here.
    return <NotFoundView route={route} />;
  }
  return <GraphHooked route={route} initiativeId={initiativeId} />;
}

function GraphHooked({ route, initiativeId }: { readonly route: Route; readonly initiativeId: string }): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource(
    (signal) => fetchInitiativeTimeline(initiativeId, signal),
    [initiativeId],
  );
  return (
    <GraphSection
      route={route}
      initiativeId={initiativeId}
      resource={resource}
      lastFetchedAt={lastFetchedAt}
      onRefresh={refresh}
    />
  );
}

export interface GraphSectionProps {
  readonly route: Route;
  readonly initiativeId: string;
  readonly resource: Resource<InitiativeTimelineResponse>;
  readonly lastFetchedAt: Date | null;
  readonly onRefresh: () => void;
}

/**
 * The resource-driven half of the graph view, split out the same way
 * `WorkspaceSection`/`PortfolioSection` were: a test drives every state with
 * a constructed `Resource` fixture, since `useAsyncResource`'s effect never
 * runs under `renderToStaticMarkup`.
 */
export function GraphSection({ route, initiativeId, resource, lastFetchedAt, onRefresh }: GraphSectionProps): JSX.Element {
  // The id-validation law (C3/C5): an unknown initiative renders not-found,
  // read from this fetch's own 404 — `initiativeEvents` 404s on an unknown
  // id the same way `initiativeById` does.
  if (resource.status === "error" && resource.error.status === 404) {
    return <NotFoundView route={route} />;
  }

  return (
    <section aria-labelledby="graph-heading">
      <h1 id="graph-heading">Task graph</h1>
      <p className="view-lede">
        This initiative&apos;s tasks and the causal links its timeline records between them. A link is
        drawn only from a task event&apos;s own recorded <code>causationId</code>, resolved to another
        task&apos;s event on this page — never inferred from timing or adjacency.
      </p>

      <WorkspaceSubnav route={route} initiativeId={initiativeId} />

      <AsyncSection
        resource={resource}
        lastFetchedAt={lastFetchedAt}
        onRefresh={onRefresh}
        label="the task graph"
        isEmpty={(data) => deriveGraph(data.items).nodes.length === 0}
        emptyMessage="No tasks have been recorded on this initiative's timeline yet."
      >
        {(data) => {
          const { nodes, edges } = deriveGraph(data.items);
          const positioned = layoutGraph(nodes, edges);
          return (
            <>
              <GraphCanvas nodes={positioned} edges={edges} />
              <GraphList nodes={nodes} edges={edges} />
              {data.truncated ? (
                <p className="async-state async-state--stale" role="alert">
                  This timeline was truncated at the fetch ceiling; the graph may be missing tasks or
                  causal links recorded further back than this page reaches.
                </p>
              ) : null}
            </>
          );
        }}
      </AsyncSection>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The pure model: derivation and layout (C6)
// ---------------------------------------------------------------------------

export interface GraphNode {
  readonly taskId: string;
  readonly state: string;
  readonly tone: Tone;
}

export interface GraphEdge {
  /** `<causingEventId>-><causedEventId>`, unique per caused event. */
  readonly key: string;
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly causingEventId: string;
  readonly causedEventId: string;
}

export interface GraphModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface PositionedGraphNode extends GraphNode {
  readonly x: number;
  readonly y: number;
}

type TaskTimelineRow = Extract<ScopedTimelineEntry, { readonly stream: "TASK" }>;

/**
 * `ScopedTimelineEntry`'s TASK rows carry a task's current state but not the
 * `isTerminal` bit `taskStateTone` wants — only a full `TaskSummary`/
 * `TaskDetail` fetch carries that, and this view makes no such fetch (one
 * fetch feeds the whole graph, deliberately). This derives it the same way
 * every tone in this package is derived: a name-shape heuristic, never an
 * enumeration — the UI package does not depend on `@acp/contracts`, so a
 * state this does not recognise just is not "terminal", it is not an error.
 */
const TERMINAL_STATE_MARKERS = ["COMMITTED", "CHECKPOINTED"];
function looksTerminal(state: string): boolean {
  const upper = state.toUpperCase();
  return TERMINAL_STATE_MARKERS.some((marker) => upper.includes(marker));
}

/**
 * Derive the graph's nodes and edges from one initiative's merged timeline —
 * the same rows `TimelineView` renders directly, so the graph and the
 * timeline are never two different accounts of one initiative's history.
 *
 * A node is one task, toned by the state its **last** TASK-stream row
 * carries (`InitiativeTimelineResponse.items` arrives `recordedAt`
 * ascending — P8-8E-pre's stated order — so the last occurrence per task is
 * the latest). INITIATIVE-stream rows never contribute a node or an edge:
 * they carry no `taskId`.
 *
 * An edge is a real causal fact, never invented: a TASK row whose
 * `causationId` resolves to a **different** task's event present on this
 * same page. `causationId` resolving to an event of the *same* task is
 * internal sequencing, not a task dependency, and is not an edge.
 * `causationId` resolving to nothing on this page — outside the fetch
 * window, or the timeline was truncated — produces no edge either: an edge
 * this view cannot verify from data it actually has is not drawn.
 *
 * As of this packet, no production code path ever populates `causationId`/
 * `correlationId` with anything but `null` (verified across every event
 * constructor in `packages/runtime` and `packages/cli`) — an all-null,
 * edge-free graph is the realistic common case today, not a corner case,
 * which is why the empty-edges state is a first-class rendering path here
 * rather than a fallback.
 */
export function deriveGraph(items: readonly ScopedTimelineEntry[]): GraphModel {
  const latestByTask = new Map<string, TaskTimelineRow>();
  const eventIdToTaskId = new Map<string, string>();

  for (const item of items) {
    if (item.stream !== "TASK") {
      continue;
    }
    latestByTask.set(item.taskId, item);
    eventIdToTaskId.set(item.eventId, item.taskId);
  }

  const nodes: GraphNode[] = [...latestByTask.entries()]
    .map(([taskId, row]) => ({
      taskId,
      state: row.toState,
      tone: taskStateTone(row.toState, looksTerminal(row.toState)),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  const edges: GraphEdge[] = [];
  for (const item of items) {
    if (item.stream !== "TASK" || item.causationId === null) {
      continue;
    }
    const fromTaskId = eventIdToTaskId.get(item.causationId);
    if (fromTaskId === undefined || fromTaskId === item.taskId) {
      continue;
    }
    edges.push({
      key: item.causationId + "->" + item.eventId,
      fromTaskId,
      toTaskId: item.taskId,
      causingEventId: item.causationId,
      causedEventId: item.eventId,
    });
  }
  edges.sort((a, b) => a.key.localeCompare(b.key));

  return { nodes, edges };
}

/**
 * Best-effort lifecycle-phase ordering (C6: "layered by lifecycle phase,
 * never force-directed"). This is a layout hint, not a claimed enumeration
 * of the lifecycle — the UI package does not depend on `@acp/contracts` and
 * never will, so a state this list does not recognise is not an error: it
 * is placed in one trailing column rather than crashing or being dropped.
 */
const LIFECYCLE_PHASE_ORDER: readonly string[] = [
  "DISCOVERED",
  "DT_CLASSIFIED",
  "READY",
  "RESERVED",
  "RUNNING",
  "VERIFYING",
  "AUDITING",
  "READY_TO_COMMIT",
  "COMMITTED",
  "CHECKPOINTED",
];

function phaseIndex(state: string): number {
  const index = LIFECYCLE_PHASE_ORDER.indexOf(state);
  return index === -1 ? LIFECYCLE_PHASE_ORDER.length : index;
}

const COLUMN_WIDTH = 220;
const ROW_HEIGHT = 96;

/**
 * Nodes and edges to positions — pure, unit-tested without a canvas (C6).
 *
 * Columns are lifecycle phases, left to right. Within a column, a node with
 * more incoming edges (more tasks whose events caused this one) sits nearer
 * the top; ties — and every node when no edges exist at all, the common case
 * today — break on `taskId`, so the result is deterministic and directly
 * testable rather than depending on object insertion order.
 */
export function layoutGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): readonly PositionedGraphNode[] {
  const incomingCount = new Map<string, number>();
  for (const edge of edges) {
    incomingCount.set(edge.toTaskId, (incomingCount.get(edge.toTaskId) ?? 0) + 1);
  }

  const byPhase = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const phase = phaseIndex(node.state);
    const bucket = byPhase.get(phase);
    if (bucket === undefined) {
      byPhase.set(phase, [node]);
    } else {
      bucket.push(node);
    }
  }

  const positioned: PositionedGraphNode[] = [];
  for (const [phase, bucket] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...bucket].sort((a, b) => {
      const degreeDelta = (incomingCount.get(b.taskId) ?? 0) - (incomingCount.get(a.taskId) ?? 0);
      return degreeDelta !== 0 ? degreeDelta : a.taskId.localeCompare(b.taskId);
    });
    ordered.forEach((node, index) => {
      positioned.push({ ...node, x: phase * COLUMN_WIDTH, y: index * ROW_HEIGHT });
    });
  }

  return positioned;
}

// ---------------------------------------------------------------------------
// The canvas — client-only seam
// ---------------------------------------------------------------------------

const TONE_BORDER: Record<Tone, string> = {
  good: "var(--color-good-fg)",
  neutral: "var(--color-border-strong)",
  warn: "var(--color-warn-fg)",
  bad: "var(--color-bad-fg)",
};

function GraphCanvas({
  nodes,
  edges,
}: {
  readonly nodes: readonly PositionedGraphNode[];
  readonly edges: readonly GraphEdge[];
}): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  const xyNodes: XyNode[] = nodes.map((node) => ({
    id: node.taskId,
    position: { x: node.x, y: node.y },
    data: { label: <GraphNodeLabel node={node} /> },
    style: { borderColor: TONE_BORDER[node.tone] },
    focusable: false,
  }));
  const xyEdges: XyEdge[] = edges.map((edge) => ({
    id: edge.key,
    source: edge.fromTaskId,
    target: edge.toTaskId,
    focusable: false,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));

  return (
    // `aria-hidden`: the list below carries the identical facts and is the
    // keyboard surface (see this file's own header comment). Every node and
    // edge is marked unfocusable and selection/dragging/connecting are all
    // off, so nothing inside this wrapper is reachable by keyboard — hiding
    // it from assistive technology does not strand focus inside hidden
    // content.
    <div className="graph-canvas" aria-hidden="true">
      <ReactFlow
        nodes={xyNodes}
        edges={xyEdges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
      </ReactFlow>
    </div>
  );
}

function GraphNodeLabel({ node }: { readonly node: GraphNode }): JSX.Element {
  return (
    <span className="graph-canvas__node-label">
      <code>{truncateMiddle(node.taskId, 6, 4)}</code>
      <span>{humanizeConstant(node.state)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The list alternative — the same-data contract, the keyboard surface
// ---------------------------------------------------------------------------

function GraphList({ nodes, edges }: { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] }): JSX.Element {
  const nodeColumns: Column<GraphNode>[] = [
    {
      key: "taskId",
      header: "Task",
      priority: "essential",
      render: (node) => (
        <a href={buildTaskDetailHash(node.taskId)}>
          <IdValue value={node.taskId} kind="task id" />
        </a>
      ),
    },
    {
      key: "state",
      header: "State",
      priority: "essential",
      render: (node) => <StatusBadge label={humanizeConstant(node.state)} tone={node.tone} />,
    },
  ];

  const edgeColumns: Column<GraphEdge>[] = [
    {
      key: "from",
      header: "From task",
      priority: "essential",
      render: (edge) => (
        <a href={buildTaskDetailHash(edge.fromTaskId)}>
          <IdValue value={edge.fromTaskId} kind="task id" />
        </a>
      ),
    },
    {
      key: "to",
      header: "To task",
      priority: "essential",
      render: (edge) => (
        <a href={buildTaskDetailHash(edge.toTaskId)}>
          <IdValue value={edge.toTaskId} kind="task id" />
        </a>
      ),
    },
    {
      key: "causingEvent",
      header: "Causing event",
      priority: "tertiary",
      render: (edge) => <IdValue value={edge.causingEventId} kind="event id" />,
    },
    {
      key: "causedEvent",
      header: "Caused event",
      priority: "tertiary",
      render: (edge) => <IdValue value={edge.causedEventId} kind="event id" />,
    },
  ];

  return (
    <div className="graph-list">
      <h2 id="graph-list-tasks-heading">Tasks</h2>
      <DataTable caption="Task graph — tasks" columns={nodeColumns} rows={nodes} rowKey={(node) => node.taskId} />
      <h2 id="graph-list-edges-heading">Causal links</h2>
      {edges.length === 0 ? (
        <p className="async-state async-state--empty">
          No causal link is recorded between any two tasks on this initiative&apos;s timeline yet.
        </p>
      ) : (
        <DataTable caption="Task graph — causal links" columns={edgeColumns} rows={edges} rowKey={(edge) => edge.key} />
      )}
    </div>
  );
}
