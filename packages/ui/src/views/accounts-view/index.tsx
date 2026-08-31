import { type AccountDto, type AccountsResponse } from "@acp/api-contracts";
import { type JSX } from "react";

import { fetchAccounts } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { BarBreakdown } from "../../components/bar-breakdown/index.js";
import { type Column, DataTable } from "../../components/data-table/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { formatCount, formatRelativeTime, formatTimestamp, humanizeConstant } from "../../format/index.js";
import { type Tone } from "../../format/status-tone/index.js";
import { type Resource, useAsyncResource } from "../../hooks/use-async-resource/index.js";

/**
 * The accounts surface (P8-8F, blueprint §3a): which accounts exist, and
 * whether their quota can be trusted right now.
 *
 * `#/accounts` is a plain, unscoped view — accounts and quota are global by
 * roadmap law, exactly like the portfolio, so this view takes no route prop
 * and reads none.
 *
 * **`AccountsResponse` is a closed union, and both arms are a 200 (blueprint
 * §4).** The `UNAVAILABLE` arm is not this view's error state — it is the
 * state a fresh machine actually shows, and it renders first-class with the
 * refusal's own vocabulary word visible, never as the landed error idiom.
 * `AsyncSection`'s own loading/error machinery is still what this view uses
 * for genuine transport and contract failures; branching on `data.status`
 * happens only once past that, inside the success render.
 */

export function AccountsView(): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource(fetchAccounts, []);
  return <AccountsSection resource={resource} lastFetchedAt={lastFetchedAt} onRefresh={refresh} />;
}

export interface AccountsSectionProps {
  readonly resource: Resource<AccountsResponse>;
  readonly lastFetchedAt: Date | null;
  readonly onRefresh: () => void;
}

/**
 * The resource-driven half of the accounts view, split out the same way
 * every other scoped section in this cohort was: a test drives every state
 * with a constructed `Resource` fixture, since `useAsyncResource`'s effect
 * never runs under `renderToStaticMarkup` (C5).
 */
export function AccountsSection({ resource, lastFetchedAt, onRefresh }: AccountsSectionProps): JSX.Element {
  return (
    <section aria-labelledby="accounts-heading">
      <h1 id="accounts-heading">Accounts</h1>
      <p className="view-lede">
        The owner file's accounts, with each one&apos;s quota and reset confidence — read-only, from a
        secrets-free projection.
      </p>

      <AsyncSection resource={resource} lastFetchedAt={lastFetchedAt} onRefresh={onRefresh} label="the accounts">
        {(data) => {
          if (data.status === "UNAVAILABLE") {
            return <UnavailableNotice reason={data.reason} detail={data.detail ?? null} />;
          }
          if (data.items.length === 0) {
            return (
              <div className="async-state async-state--empty">
                <p>The owner file holds zero accounts.</p>
              </div>
            );
          }
          return (
            <>
              <p className="accounts-estimated-at" role="status" aria-live="polite">
                Estimated{" "}
                <time dateTime={data.estimatedAt} title={formatTimestamp(data.estimatedAt)}>
                  {formatRelativeTime(data.estimatedAt, new Date())}
                </time>
                .
              </p>
              <DataTable caption="Accounts" columns={ACCOUNT_COLUMNS} rows={data.items} rowKey={(account) => account.accountId} />
            </>
          );
        }}
      </AsyncSection>
    </section>
  );
}

/**
 * Reason words a fresh operator has not seen before still deserve a plain
 * sentence, not just the frozen constant — the closed vocabulary is exactly
 * five, but this map degrades gracefully if that ever widens (the same
 * heuristic discipline every tone mapping in this package already holds).
 */
const UNAVAILABLE_REASON_LABEL: Readonly<Record<string, string>> = {
  ACCOUNTS_FILE_UNCONFIGURED: "No accounts file has been configured for this server.",
  ACCOUNTS_FILE_ABSENT: "The configured accounts file does not exist.",
  ACCOUNTS_FILE_UNREADABLE: "The configured accounts file could not be read.",
  ACCOUNTS_FILE_SCHEMA_REFUSED: "The configured accounts file was refused: its contents do not match the expected shape.",
  ACCOUNTS_FILE_OVERSIZE: "The configured accounts file is too large to read.",
};

/**
 * The `UNAVAILABLE` arm, first-class (blueprint §5). `role="status"`, not
 * `role="alert"`: this is the plane's honest state, not an exceptional
 * failure this view needs to interrupt a reader over.
 */
function UnavailableNotice({ reason, detail }: { readonly reason: string; readonly detail: string | null }): JSX.Element {
  return (
    <div className="async-state async-state--empty" role="status" aria-live="polite">
      <p>
        <StatusBadge label={humanizeConstant(reason)} tone="warn" />
      </p>
      <p>{UNAVAILABLE_REASON_LABEL[reason] ?? "The accounts file is unavailable."}</p>
      {detail !== null ? (
        <p className="async-state__detail">
          <code>{detail}</code>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A worker role's tone isn't the right precedent here — an account state is
 * a real good/warn/bad axis, so this maps it directly rather than reusing a
 * uniform tone the way `agents-view` does for role. Local, not in
 * `format/status-tone/index.ts`: that file is outside this packet's
 * write-set, and this heuristic — like every other in this package — never
 * claims to enumerate the domain's full vocabulary.
 */
function accountStateTone(state: string): Tone {
  switch (state) {
    case "AVAILABLE":
      return "good";
    case "DRAINING":
    case "COOLDOWN":
      return "warn";
    case "EXHAUSTED":
    case "AUTH_REQUIRED":
      return "bad";
    default:
      return "neutral";
  }
}

function confidenceTone(confidence: string): Tone {
  switch (confidence) {
    case "HIGH":
      return "good";
    case "MEDIUM":
      return "neutral";
    case "LOW":
      return "warn";
    default:
      return "neutral";
  }
}

/**
 * The full models list, keyboard-reachable rather than title-only (v2, N1).
 * A native `<details>` disclosure: no state, no new dependency, and reachable
 * by keyboard and by a screen reader exactly as a native control is.
 */
function ModelsCell({ models }: { readonly models: readonly string[] }): JSX.Element {
  return (
    <details className="models-disclosure">
      <summary>
        {formatCount(models.length)} {models.length === 1 ? "model" : "models"}
      </summary>
      <ul>
        {models.map((model) => (
          <li key={model}>{model}</li>
        ))}
      </ul>
    </details>
  );
}

const ACCOUNT_COLUMNS: Column<AccountDto>[] = [
  {
    key: "accountId",
    header: "Alias",
    priority: "essential",
    render: (account) => account.accountId,
  },
  {
    key: "provider",
    header: "Provider",
    priority: "essential",
    render: (account) => account.provider,
  },
  {
    key: "models",
    header: "Models",
    priority: "essential",
    render: (account) => <ModelsCell models={account.models} />,
  },
  {
    key: "plan",
    header: "Plan",
    priority: "secondary",
    render: (account) => account.plan ?? "—",
  },
  {
    key: "state",
    header: "State",
    priority: "essential",
    render: (account) => <StatusBadge label={humanizeConstant(account.state)} tone={accountStateTone(account.state)} />,
  },
  {
    key: "quotaRemaining",
    header: "Quota remaining",
    priority: "essential",
    render: (account) =>
      account.quota.remainingRatio === null ? (
        <span title="The owner record does not publish a remaining-quota estimate for this account.">—</span>
      ) : (
        <BarBreakdown
          caption={account.accountId + " quota remaining"}
          total={1}
          items={[{ label: "Remaining", count: account.quota.remainingRatio }]}
        />
      ),
  },
  {
    key: "confidence",
    header: "Confidence",
    priority: "secondary",
    render: (account) => <StatusBadge label={humanizeConstant(account.quota.confidence)} tone={confidenceTone(account.quota.confidence)} />,
  },
  {
    key: "reset",
    header: "Reset",
    priority: "secondary",
    render: (account) =>
      account.reset.nextResetAt === null ? (
        "—"
      ) : (
        <time dateTime={account.reset.nextResetAt} title={formatTimestamp(account.reset.nextResetAt)}>
          {formatRelativeTime(account.reset.nextResetAt, new Date())}
        </time>
      ),
  },
  {
    key: "resetSource",
    header: "Reset source",
    priority: "tertiary",
    render: (account) => humanizeConstant(account.reset.source),
  },
  {
    key: "resetConfidence",
    header: "Reset confidence",
    priority: "tertiary",
    render: (account) => <StatusBadge label={humanizeConstant(account.reset.confidence)} tone={confidenceTone(account.reset.confidence)} />,
  },
  {
    key: "lastProbeAt",
    header: "Last probe",
    priority: "tertiary",
    render: (account) =>
      account.lastProbeAt === null ? (
        "—"
      ) : (
        <time dateTime={account.lastProbeAt} title={formatTimestamp(account.lastProbeAt)}>
          {formatRelativeTime(account.lastProbeAt, new Date())}
        </time>
      ),
  },
  {
    key: "lastError",
    header: "Last error",
    priority: "tertiary",
    render: (account) => account.lastError ?? "—",
  },
];
