import { type InitiativePortfolioResponse, type InitiativeSummary } from "@acp/api-contracts";
import { type JSX } from "react";

import { fetchInitiatives } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { formatCount, formatRelativeTime, formatTimestamp, humanizeConstant, truncateMiddle } from "../../format/index.js";
import { initiativeStatusTone } from "../../format/status-tone/index.js";
import { type Resource, useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { buildInitiativeHash } from "../../routing/hash-route/index.js";

/**
 * The portfolio: every initiative, unscoped.
 *
 * A working set, not a poster (blueprint v2 §1) — the header carries a count
 * and nothing else, and every card answers "what is this, what state is it
 * in, is it current" without a second click. Detail lives one click away, at
 * the initiative-scoped routes this view links into; nothing here fetches or
 * renders a single initiative's own detail.
 */
export function PortfolioView(): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource(fetchInitiatives, []);
  return <PortfolioSection resource={resource} lastFetchedAt={lastFetchedAt} onRefresh={refresh} />;
}

export interface PortfolioSectionProps {
  readonly resource: Resource<InitiativePortfolioResponse>;
  readonly lastFetchedAt: Date | null;
  readonly onRefresh: () => void;
}

/**
 * The resource-driven half of the portfolio, split out from `PortfolioView`
 * so a test can drive every state directly with a constructed `Resource`
 * fixture. `useAsyncResource`'s fetch runs in an effect, and effects do not
 * run under `renderToStaticMarkup` (C5: no DOM environment) — this seam is
 * what lets the states contract (blueprint v2 §7) be asserted at all, rather
 * than only ever observing the initial loading state.
 */
export function PortfolioSection({ resource, lastFetchedAt, onRefresh }: PortfolioSectionProps): JSX.Element {
  const count =
    resource.status === "success" || resource.status === "refreshing" || resource.status === "stale"
      ? resource.data.count
      : null;

  return (
    <section aria-labelledby="portfolio-heading">
      <h1 id="portfolio-heading">{count !== null ? "Initiatives (" + formatCount(count) + ")" : "Initiatives"}</h1>
      <AsyncSection
        resource={resource}
        lastFetchedAt={lastFetchedAt}
        onRefresh={onRefresh}
        label="the initiatives"
        isEmpty={(data) => data.items.length === 0}
        emptyMessage="Nothing is observed yet. An initiative appears here once it is registered on the ledger."
      >
        {(data) => <PortfolioGrid data={data} />}
      </AsyncSection>
    </section>
  );
}

/** The card grid alone, given an already-resolved response. Pure, no hook. */
export function PortfolioGrid({ data }: { readonly data: InitiativePortfolioResponse }): JSX.Element {
  return (
    <ul className="portfolio-grid">
      {data.items.map((initiative) => (
        <PortfolioCard key={initiative.initiativeId} initiative={initiative} />
      ))}
    </ul>
  );
}

/** The display name for an initiative that may have registered without a slug or a title. */
function initiativeName(initiative: InitiativeSummary): string {
  return initiative.slug ?? initiative.title ?? truncateMiddle(initiative.initiativeId);
}

function PortfolioCard({ initiative }: { readonly initiative: InitiativeSummary }): JSX.Element {
  const name = initiativeName(initiative);
  const statusLabel = humanizeConstant(initiative.status);
  const degraded = initiative.rollup.skippedMalformed > 0;
  const degradedTitle =
    String(initiative.rollup.skippedMalformed) +
    (initiative.rollup.skippedMalformed === 1 ? " record was" : " records were") +
    " skipped as malformed during the token rollup fold; the totals below are incomplete.";

  return (
    <li className="portfolio-card">
      <div className="portfolio-card__head">
        <h2 className="portfolio-card__name">
          <a className="portfolio-card__link" href={buildInitiativeHash(initiative.initiativeId)}>
            {name}
            <span className="sr-only">{", " + statusLabel}</span>
          </a>
        </h2>
        <span aria-hidden="true">
          <StatusBadge label={statusLabel} tone={initiativeStatusTone(initiative.status)} />
        </span>
      </div>

      {initiative.objective !== null ? (
        <p className="portfolio-card__objective">{initiative.objective}</p>
      ) : (
        <p className="portfolio-card__objective portfolio-card__objective--empty">No objective recorded.</p>
      )}

      <dl className="portfolio-card__facts">
        <div>
          <dt>Roadmap</dt>
          <dd>
            {initiative.headRoadmapDigest !== null ? (
              <>
                <code>{truncateMiddle(initiative.headRoadmapDigest, 8, 6)}</code>
                {" · v" + String(initiative.roadmapVersionCount)}
              </>
            ) : (
              "no roadmap version yet"
            )}
          </dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {degraded ? (
              <span title={degradedTitle}>
                {"— used · — reserved"}
              </span>
            ) : (
              formatCount(initiative.rollup.tokensUsed) + " used · " + formatCount(initiative.rollup.tokensReserved) + " reserved"
            )}
          </dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>
            <time dateTime={initiative.updatedAt} title={formatTimestamp(initiative.updatedAt)}>
              {formatRelativeTime(initiative.updatedAt, new Date())}
            </time>
          </dd>
        </div>
      </dl>
    </li>
  );
}
