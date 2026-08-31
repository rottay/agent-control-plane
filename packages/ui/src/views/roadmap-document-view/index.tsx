import {
  type InitiativeRoadmapResponse,
  type RoadmapContentResponse,
  type RoadmapVersionDto,
} from "@acp/api-contracts";
import { type JSX } from "react";

import { fetchInitiativeRoadmap, fetchRoadmapContent, type ApiResult } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { IdValue } from "../../components/id-value/index.js";
import { formatRelativeTime, formatTimestamp, humanizeConstant } from "../../format/index.js";
import { roadmapVersionKindTone } from "../../format/status-tone/index.js";
import { type Resource, useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { buildInitiativeHash, buildInitiativeRoadmapHash, type Route } from "../../routing/hash-route/index.js";
import { type NavigateFn } from "../../routing/use-hash-route/index.js";
import { NotFoundView } from "../not-found-view/index.js";
import { WorkspaceSubnav } from "../workspace-view/index.js";

/**
 * The roadmap document view (P8-8F, blueprint §3d): the content-read's
 * second consumer (P8-8D-c2 was the first, inside the edit dialog), read
 * only by name. This view opens nothing, confirms nothing, writes nothing —
 * the one edit affordance is a link back to the workspace, where the landed
 * dialog lives.
 *
 * **Version resolution.** `?version=` selects a specific, well-formed
 * positive version number immediately — the content fetch does not wait on
 * the history fetch in that case, since the requested number is already
 * everything it needs. Absent (or malformed) falls back to the roadmap
 * history's own head marker once that fetch resolves; until it does, the
 * content fetch has nothing to ask for and stays inert (see
 * `RoadmapDocumentHooked`'s own comment). This is a genuinely two-stage
 * dependency, not two independent fetches the way the workspace's own two
 * are — the content fetch's identity depends on the history fetch's answer
 * whenever no explicit version rides on the URL.
 */

export interface RoadmapDocumentViewProps {
  readonly route: Route;
  readonly navigate: NavigateFn;
}

export function RoadmapDocumentView({ route, navigate }: RoadmapDocumentViewProps): JSX.Element {
  const initiativeId = route.initiativeId;
  if (initiativeId === null) {
    return <NotFoundView route={route} />;
  }
  return <RoadmapDocumentHooked route={route} navigate={navigate} initiativeId={initiativeId} />;
}

/** A well-formed explicit version from the query string, or null. */
function parseExplicitVersion(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function RoadmapDocumentHooked({
  route,
  navigate,
  initiativeId,
}: {
  readonly route: Route;
  readonly navigate: NavigateFn;
  readonly initiativeId: string;
}): JSX.Element {
  const history = useAsyncResource((signal) => fetchInitiativeRoadmap(initiativeId, signal), [initiativeId]);

  const explicitVersion = parseExplicitVersion(route.query["version"]);
  const headVersion =
    history.resource.status === "success" || history.resource.status === "refreshing" || history.resource.status === "stale"
      ? (history.resource.data.items.find((item) => item.head)?.version ?? null)
      : null;
  const resolvedVersion = explicitVersion ?? headVersion;

  const content = useAsyncResource<RoadmapContentResponse>(
    (signal) => {
      if (resolvedVersion === null) {
        // Nothing to resolve yet: either the history fetch has not answered,
        // or an explicit version was not given. A promise that never settles
        // is a harmless placeholder here — nothing observes `content` while
        // `resolvedVersion` is null (see `RoadmapDocumentSection`), and the
        // next resolution replaces this effect entirely once a real version
        // is known.
        return new Promise<ApiResult<RoadmapContentResponse>>(() => {
          // deliberately never resolves
        });
      }
      return fetchRoadmapContent(initiativeId, resolvedVersion, signal);
    },
    [initiativeId, resolvedVersion],
  );

  return (
    <RoadmapDocumentSection
      route={route}
      navigate={navigate}
      initiativeId={initiativeId}
      historyResource={history.resource}
      historyLastFetchedAt={history.lastFetchedAt}
      onRefreshHistory={history.refresh}
      resolvedVersion={resolvedVersion}
      contentResource={content.resource}
      onRefreshContent={content.refresh}
    />
  );
}

export interface RoadmapDocumentSectionProps {
  readonly route: Route;
  readonly navigate: NavigateFn;
  readonly initiativeId: string;
  readonly historyResource: Resource<InitiativeRoadmapResponse>;
  readonly historyLastFetchedAt: Date | null;
  readonly onRefreshHistory: () => void;
  readonly resolvedVersion: number | null;
  readonly contentResource: Resource<RoadmapContentResponse>;
  readonly onRefreshContent: () => void;
}

/**
 * The resource-driven half of the roadmap document view, split out the same
 * way every other scoped section in this cohort was, for the same reason: a
 * test drives every state with constructed `Resource` fixtures rather than
 * depending on the hooked component's own effects.
 */
export function RoadmapDocumentSection({
  route,
  navigate,
  initiativeId,
  historyResource,
  historyLastFetchedAt,
  onRefreshHistory,
  resolvedVersion,
  contentResource,
  onRefreshContent,
}: RoadmapDocumentSectionProps): JSX.Element {
  // The id-validation law (C3/C5): the roadmap-history fetch is what
  // answers whether this initiative exists at all.
  if (historyResource.status === "error" && historyResource.error.status === 404) {
    return <NotFoundView route={route} />;
  }

  return (
    <section aria-labelledby="roadmap-document-heading">
      <h1 id="roadmap-document-heading">Roadmap document</h1>
      <p className="view-lede">
        The stored roadmap document, read only. <a href={buildInitiativeHash(initiativeId)}>Edit from the workspace</a>.
      </p>

      <WorkspaceSubnav route={route} initiativeId={initiativeId} />

      <AsyncSection resource={historyResource} lastFetchedAt={historyLastFetchedAt} onRefresh={onRefreshHistory} label="the roadmap history">
        {(history) => {
          if (history.items.length === 0) {
            return (
              <div className="async-state async-state--empty">
                <p>No roadmap version has been recorded yet.</p>
                <a href={buildInitiativeHash(initiativeId)}>Record the first version from the workspace</a>
              </div>
            );
          }

          const head = history.items.find((item) => item.head) ?? null;
          const selectedLabel = resolvedVersion ?? head?.version ?? null;

          return (
            <>
              <VersionSelector
                items={history.items}
                selectedVersion={resolvedVersion ?? head?.version ?? null}
                onSelect={(version) => {
                  navigate(buildInitiativeRoadmapHash(initiativeId, { version }));
                }}
              />

              {contentResource.status === "error" && contentResource.error.status === 404 ? (
                <div className="async-state async-state--empty" role="alert">
                  <p>{selectedLabel !== null ? "Version " + String(selectedLabel) : "That version"} was not found for this initiative.</p>
                </div>
              ) : (
                <AsyncSection
                  resource={contentResource}
                  lastFetchedAt={null}
                  onRefresh={onRefreshContent}
                  label="the roadmap document"
                >
                  {(content) => {
                    const historyItem = history.items.find((item) => item.version === content.version) ?? null;
                    return <DocumentBody content={content} historyItem={historyItem} />;
                  }}
                </AsyncSection>
              )}
            </>
          );
        }}
      </AsyncSection>
    </section>
  );
}

function VersionSelector({
  items,
  selectedVersion,
  onSelect,
}: {
  readonly items: readonly RoadmapVersionDto[];
  readonly selectedVersion: number | null;
  readonly onSelect: (version: number) => void;
}): JSX.Element {
  return (
    <div className="field roadmap-document__version-field">
      <label htmlFor="roadmap-document-version">Version</label>
      <select
        id="roadmap-document-version"
        value={selectedVersion !== null ? String(selectedVersion) : ""}
        onChange={(event) => {
          const version = Number.parseInt(event.target.value, 10);
          if (Number.isInteger(version)) {
            onSelect(version);
          }
        }}
      >
        {items.map((item) => (
          <option key={item.roadmapVersionId} value={item.version}>
            v{item.version} · {humanizeConstant(item.kind)}
            {item.head ? " (head)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function DocumentBody({
  content,
  historyItem,
}: {
  readonly content: RoadmapContentResponse;
  readonly historyItem: RoadmapVersionDto | null;
}): JSX.Element {
  return (
    <article className="roadmap-document" aria-labelledby="roadmap-document-version-heading">
      <div className="roadmap-document__meta">
        <span id="roadmap-document-version-heading" className={"badge badge--" + roadmapVersionKindTone(content.kind)}>
          v{content.version} · {humanizeConstant(content.kind)}
        </span>
        <IdValue value={content.contentDigest} kind="content digest" />
        {historyItem !== null ? (
          <span className="roadmap-document__recorded">
            {historyItem.recordedBy},{" "}
            <time dateTime={historyItem.recordedAt} title={formatTimestamp(historyItem.recordedAt)}>
              {formatRelativeTime(historyItem.recordedAt, new Date())}
            </time>
          </span>
        ) : null}
      </div>
      <pre className="roadmap-document__body">{content.content}</pre>
    </article>
  );
}
