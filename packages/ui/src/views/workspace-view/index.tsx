import { type InitiativeDetailResponse, type InitiativeRoadmapResponse, type RoadmapVersionDto } from "@acp/api-contracts";
import { useState, type JSX } from "react";

import { fetchInitiativeDetail, fetchInitiativeRoadmap } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { BarBreakdown } from "../../components/bar-breakdown/index.js";
import { EditRoadmapDialog } from "../../components/edit-roadmap-dialog/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { formatCount, formatRelativeTime, formatTimestamp, humanizeConstant, truncateMiddle } from "../../format/index.js";
import { initiativeStatusTone, roadmapVersionKindTone } from "../../format/status-tone/index.js";
import { type Resource, useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { type Route } from "../../routing/hash-route/index.js";
import { NotFoundView } from "../not-found-view/index.js";

/**
 * The initiative workspace: one initiative, understood and steered
 * (blueprint v2 §1).
 *
 * Reading order (desktop): the objective leads, then the roadmap (the
 * editable spine), then the work state — exactly what the data plane
 * serves and nothing it does not (C1): no "agents active", no "reset in
 * 2d". Two independent fetches, two independent loading/error regions
 * (blueprint v2 §5): `fetchInitiativeDetail` for the header and the work
 * state (one response, so one region — splitting it further would be a
 * false independence the data does not have), and `fetchInitiativeRoadmap`
 * for the roadmap card and its history, per the blueprint's own instruction
 * to read history from the history endpoint rather than the detail
 * response's own `roadmap` field.
 */

export interface WorkspaceViewProps {
  readonly route: Route;
}

export function WorkspaceView({ route }: WorkspaceViewProps): JSX.Element {
  const initiativeId = route.initiativeId;
  if (initiativeId === null) {
    // The route grammar only ever builds a "workspace" route with an id
    // (hash-route/index.ts). Kept as a runtime guard rather than a
    // non-null assertion, so a routing regression fails loudly here
    // instead of reading `null` as a string somewhere below.
    return <NotFoundView route={route} />;
  }
  return <WorkspaceHooked route={route} initiativeId={initiativeId} />;
}

interface DialogRequest {
  readonly kind: "EDIT" | "ROLLBACK";
  readonly prefillVersion: number | null;
  readonly expectedHeadDigest: string | null;
  readonly restoresVersionId: string | null;
  readonly restoresVersionLabel: string | null;
}

/** Wires the two hooks, then hands their resources to the pure section below. */
function WorkspaceHooked({ route, initiativeId }: { readonly route: Route; readonly initiativeId: string }): JSX.Element {
  const detail = useAsyncResource((signal) => fetchInitiativeDetail(initiativeId, signal), [initiativeId]);
  const roadmap = useAsyncResource((signal) => fetchInitiativeRoadmap(initiativeId, signal), [initiativeId]);

  return (
    <WorkspaceSection
      route={route}
      initiativeId={initiativeId}
      detailResource={detail.resource}
      detailLastFetchedAt={detail.lastFetchedAt}
      onRefreshDetail={detail.refresh}
      roadmapResource={roadmap.resource}
      roadmapLastFetchedAt={roadmap.lastFetchedAt}
      onRefreshRoadmap={roadmap.refresh}
    />
  );
}

export interface WorkspaceSectionProps {
  readonly route: Route;
  readonly initiativeId: string;
  readonly detailResource: Resource<InitiativeDetailResponse>;
  readonly detailLastFetchedAt: Date | null;
  readonly onRefreshDetail: () => void;
  readonly roadmapResource: Resource<InitiativeRoadmapResponse>;
  readonly roadmapLastFetchedAt: Date | null;
  readonly onRefreshRoadmap: () => void;
}

/**
 * The resource-driven half of the workspace, split out from `WorkspaceView`
 * so a test can drive every state directly with constructed `Resource`
 * fixtures — the same seam P8-8C's `PortfolioSection` established, for the
 * same reason: effects do not run under `renderToStaticMarkup` (C5), so
 * without this seam the suite could only ever observe the initial loading
 * state of both resources at once.
 */
export function WorkspaceSection({
  route,
  initiativeId,
  detailResource,
  detailLastFetchedAt,
  onRefreshDetail,
  roadmapResource,
  roadmapLastFetchedAt,
  onRefreshRoadmap,
}: WorkspaceSectionProps): JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dialogRequest, setDialogRequest] = useState<DialogRequest | null>(null);

  // The id-validation law (C3): an unknown initiative renders the landed
  // not-found view. Read from the detail fetch's own 404 rather than
  // hand-rolled here — the server already knows what "no initiative with
  // that id" means, by HTTP status, which `useAsyncResource` preserves even
  // though it drops the classified error code on the way to `ResourceError`.
  if (detailResource.status === "error" && detailResource.error.status === 404) {
    return <NotFoundView route={route} />;
  }

  return (
    <AsyncSection
      resource={detailResource}
      lastFetchedAt={detailLastFetchedAt}
      onRefresh={onRefreshDetail}
      label="the initiative"
    >
      {(response) => {
        const data = response.initiative;
        const initiative = data.initiative;
        const name = initiative.slug ?? initiative.title ?? truncateMiddle(initiative.initiativeId);
        const degraded = initiative.rollup.skippedMalformed > 0;
        const stateCounts = new Map<string, number>();
        for (const task of data.tasks) {
          stateCounts.set(task.currentState, (stateCounts.get(task.currentState) ?? 0) + 1);
        }

        return (
          <section aria-labelledby="workspace-heading">
            <div className="workspace__header">
              <h1 id="workspace-heading" className="workspace__name">
                {name}
              </h1>
              <StatusBadge label={humanizeConstant(initiative.status)} tone={initiativeStatusTone(initiative.status)} />
            </div>
            {initiative.objective !== null ? (
              <p className="workspace__objective">{initiative.objective}</p>
            ) : (
              <p className="workspace__objective workspace__objective--empty">No objective recorded.</p>
            )}

            <div className="workspace__body">
              <section className="panel" aria-labelledby="workspace-roadmap-heading">
                <h2 id="workspace-roadmap-heading">Roadmap</h2>
                <AsyncSection
                  resource={roadmapResource}
                  lastFetchedAt={roadmapLastFetchedAt}
                  onRefresh={onRefreshRoadmap}
                  label="the roadmap"
                >
                  {(roadmapData) => {
                    if (roadmapData.items.length === 0) {
                      // The empty roadmap's first-version affordance
                      // (blueprint v2 §5): the same dialog, no head to claim
                      // against.
                      return (
                        <div className="async-state async-state--empty">
                          <p>No roadmap version has been recorded yet.</p>
                          <button
                            type="button"
                            className="button"
                            onClick={() => {
                              setDialogRequest({
                                kind: "EDIT",
                                prefillVersion: null,
                                expectedHeadDigest: null,
                                restoresVersionId: null,
                                restoresVersionLabel: null,
                              });
                            }}
                          >
                            Record the first version
                          </button>
                        </div>
                      );
                    }

                    const head = roadmapData.items.find((item) => item.head) ?? null;

                    return (
                      <>
                        {head !== null ? <HeadVersionCard version={head} /> : null}
                        <button
                          type="button"
                          className="button button--quiet"
                          aria-expanded={historyOpen}
                          aria-controls="workspace-roadmap-history"
                          onClick={() => {
                            setHistoryOpen((previous) => !previous);
                          }}
                        >
                          {historyOpen ? "Hide history" : "History (" + formatCount(roadmapData.items.length) + ")"}
                        </button>
                        {historyOpen ? (
                          <ol id="workspace-roadmap-history" className="roadmap-history">
                            {roadmapData.items.map((item) => (
                              <li key={item.roadmapVersionId} className="roadmap-history__row">
                                <span className={"badge badge--" + roadmapVersionKindTone(item.kind)}>
                                  v{item.version} · {humanizeConstant(item.kind)}
                                </span>
                                <code className="roadmap-history__digest">{truncateMiddle(item.contentDigest, 8, 6)}</code>
                                <span className="roadmap-history__meta">
                                  {item.recordedBy},{" "}
                                  <time dateTime={item.recordedAt} title={formatTimestamp(item.recordedAt)}>
                                    {formatRelativeTime(item.recordedAt, new Date())}
                                  </time>
                                </span>
                                {!item.head ? (
                                  <button
                                    type="button"
                                    className="button button--quiet"
                                    onClick={() => {
                                      setDialogRequest({
                                        kind: "ROLLBACK",
                                        prefillVersion: item.version,
                                        expectedHeadDigest: head?.contentDigest ?? null,
                                        restoresVersionId: item.roadmapVersionId,
                                        restoresVersionLabel: "v" + String(item.version),
                                      });
                                    }}
                                  >
                                    Restore this version
                                  </button>
                                ) : null}
                              </li>
                            ))}
                          </ol>
                        ) : null}
                        <button
                          type="button"
                          className="button"
                          onClick={() => {
                            setDialogRequest({
                              kind: "EDIT",
                              prefillVersion: head?.version ?? null,
                              expectedHeadDigest: head?.contentDigest ?? null,
                              restoresVersionId: null,
                              restoresVersionLabel: null,
                            });
                          }}
                        >
                          Edit
                        </button>
                      </>
                    );
                  }}
                </AsyncSection>
              </section>

              <section className="panel" aria-labelledby="workspace-work-heading">
                <h2 id="workspace-work-heading">Work state</h2>
                <dl className="stat-list">
                  <div>
                    <dt>Tasks</dt>
                    <dd>{formatCount(data.tasks.length)}</dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd>
                      {degraded ? (
                        <span
                          title={
                            String(initiative.rollup.skippedMalformed) +
                            (initiative.rollup.skippedMalformed === 1 ? " record was" : " records were") +
                            " skipped as malformed during the token rollup fold; the totals below are incomplete."
                          }
                        >
                          — used · — reserved
                        </span>
                      ) : (
                        formatCount(initiative.rollup.tokensUsed) +
                        " used · " +
                        formatCount(initiative.rollup.tokensReserved) +
                        " reserved"
                      )}
                    </dd>
                  </div>
                </dl>
                {stateCounts.size > 0 ? (
                  <BarBreakdown
                    caption="Tasks by state"
                    total={data.tasks.length}
                    items={[...stateCounts.entries()].map(([state, count]) => ({
                      label: humanizeConstant(state),
                      count,
                    }))}
                  />
                ) : null}
              </section>
            </div>

            <EditRoadmapDialog
              open={dialogRequest !== null}
              onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                  setDialogRequest(null);
                }
              }}
              initiativeId={initiativeId}
              kind={dialogRequest?.kind ?? "EDIT"}
              prefillVersion={dialogRequest?.prefillVersion ?? null}
              expectedHeadDigest={dialogRequest?.expectedHeadDigest ?? null}
              restoresVersionId={dialogRequest?.restoresVersionId ?? null}
              restoresVersionLabel={dialogRequest?.restoresVersionLabel ?? null}
              onGranted={() => {
                onRefreshRoadmap();
                onRefreshDetail();
              }}
            />
          </section>
        );
      }}
    </AsyncSection>
  );
}

function HeadVersionCard({ version }: { readonly version: RoadmapVersionDto }): JSX.Element {
  return (
    <div className="roadmap-head">
      <span className={"badge badge--" + roadmapVersionKindTone(version.kind)}>
        v{version.version} · {humanizeConstant(version.kind)}
      </span>
      <code className="roadmap-head__digest">{truncateMiddle(version.contentDigest, 8, 6)}</code>
      <span className="roadmap-head__meta">
        {version.recordedBy},{" "}
        <time dateTime={version.recordedAt} title={formatTimestamp(version.recordedAt)}>
          {formatRelativeTime(version.recordedAt, new Date())}
        </time>
      </span>
    </div>
  );
}
