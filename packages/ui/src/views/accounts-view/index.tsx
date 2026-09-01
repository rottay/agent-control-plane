import {
  AccountActionDto,
  AccountStatusDto,
  type AccountActionDtoRecord,
  type AccountDto,
  type AccountsResponse,
} from "@acp/api-contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState, type JSX } from "react";

import { fetchAccounts, postAccountAction } from "../../api/client/index.js";
import { AsyncSection } from "../../components/async-section/index.js";
import { BarBreakdown } from "../../components/bar-breakdown/index.js";
import { classifyBearerErrorCode } from "../../components/bearer-field/index.js";
import { type Column, DataTable } from "../../components/data-table/index.js";
import { StatusBadge } from "../../components/status-badge/index.js";
import { classNames, formatCount, formatRelativeTime, formatTimestamp, humanizeConstant } from "../../format/index.js";
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
 *
 * **P8-8G packet 3** adds the write half: per-row action controls, gated on
 * `bearerArmed` — a prop from the app root, not a context, because this view
 * is one of the two places `App`'s switch calls directly and can just hand
 * it down (blueprint v2 §3).
 */

export interface AccountsViewProps {
  readonly bearerArmed?: boolean;
}

export function AccountsView({ bearerArmed = false }: AccountsViewProps = {}): JSX.Element {
  const { resource, lastFetchedAt, refresh } = useAsyncResource(fetchAccounts, []);
  return <AccountsSection resource={resource} lastFetchedAt={lastFetchedAt} onRefresh={refresh} bearerArmed={bearerArmed} />;
}

export interface AccountsSectionProps {
  readonly resource: Resource<AccountsResponse>;
  readonly lastFetchedAt: Date | null;
  readonly onRefresh: () => void;
  readonly bearerArmed?: boolean;
}

/**
 * The resource-driven half of the accounts view, split out the same way
 * every other scoped section in this cohort was: a test drives every state
 * with a constructed `Resource` fixture, since `useAsyncResource`'s effect
 * never runs under `renderToStaticMarkup` (C5).
 */
export function AccountsSection({ resource, lastFetchedAt, onRefresh, bearerArmed = false }: AccountsSectionProps): JSX.Element {
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
              <DataTable
                caption="Accounts"
                columns={accountColumns(bearerArmed, onRefresh)}
                rows={data.items}
                rowKey={(account) => account.accountId}
              />
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

/**
 * The state column (P8-8G packet 3, blueprint v2 §3): renders
 * `effectiveState` — what actually governs — rather than the owner file's
 * raw `state`. A row whose effective state came from a recorded action
 * (`stateSource === "OPERATOR_ACTION"`) is marked "operator-set", with the
 * last action's own word and instant carried in the title rather than
 * invented prose; the raw owner-file baseline stays reachable in a
 * `<details>` disclosure, the same keyboard- and screen-reader-reachable
 * idiom `ModelsCell` already uses, so the two facts (baseline vs. what
 * governs) are never collapsed into one number a reader has to take on
 * faith.
 */
function AccountStateCell({ account }: { readonly account: AccountDto }): JSX.Element {
  const operatorSet = account.stateSource === "OPERATOR_ACTION";
  const sourceTitle =
    operatorSet && account.lastAction !== null
      ? humanizeConstant(account.lastAction.action) + " at " + formatTimestamp(account.lastAction.at)
      : undefined;
  return (
    <div className="account-state-cell">
      <StatusBadge label={humanizeConstant(account.effectiveState)} tone={accountStateTone(account.effectiveState)} />
      {operatorSet ? (
        <span className="account-state-cell__source" title={sourceTitle}>
          operator-set
        </span>
      ) : null}
      <details className="account-state-cell__baseline">
        <summary>Baseline</summary>
        <p>{humanizeConstant(account.state)}</p>
      </details>
    </div>
  );
}

const ACTION_LABEL: Readonly<Record<AccountActionDto, string>> = {
  DRAIN: "Drain",
  ACCOUNT_READY: "Mark ready",
  REAUTH_REQUIRED: "Flag reauth",
  OWNER_OVERRIDE: "Override state",
};

const ACTION_CONSEQUENCE: Readonly<Record<AccountActionDto, string>> = {
  DRAIN: "Marks this account DRAINING. New work stops choosing it once requests already in flight finish.",
  ACCOUNT_READY: "Marks this account AVAILABLE again.",
  REAUTH_REQUIRED: "Marks this account AUTH_REQUIRED, flagging it for the operator's attention before it is used again.",
  OWNER_OVERRIDE: "Sets this account's effective state directly to the state you choose below, overriding the automatic rules.",
};

export type AccountActionSubmitState =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly phase: "granted"; readonly record: AccountActionDtoRecord }
  | { readonly phase: "refused-schema"; readonly field: string; readonly message: string }
  | { readonly phase: "refused-decision"; readonly name: string | null; readonly message: string }
  | { readonly phase: "refused-unauthorized"; readonly message: string }
  | { readonly phase: "refused-unarmed"; readonly message: string }
  | { readonly phase: "refused-internal"; readonly message: string }
  | { readonly phase: "refused-other"; readonly message: string };

const ACCOUNT_ACTION_REFUSAL_NAMES = ["ACCOUNTS_UNAVAILABLE", "UNKNOWN_ACCOUNT", "ALREADY_IN_STATE", "WRITE_CONFLICT"] as const;

/** The refusal's own vocabulary name, read out of the message that carries it (N2), matching `decisionRefusalName`'s idiom. */
export function accountActionRefusalName(message: string): string | null {
  return ACCOUNT_ACTION_REFUSAL_NAMES.find((name) => message.includes(name)) ?? null;
}

/**
 * The refusal-state table for one account action confirm, the exact sibling
 * of `RefusalOutcome` in `edit-roadmap-dialog` (blueprint v2 §3, C4):
 * `WRITE_REFUSED` carries the seam's own refusal word, the bearer's two
 * first-class states stay apart, and every other classified failure lands
 * in the generic retryable state. Exported for the same reason its sibling
 * is: a fixture `AccountActionSubmitState` is the only way this table's
 * static half is reachable in a DOM-less test.
 */
export function AccountActionRefusalOutcome({ submit }: { readonly submit: AccountActionSubmitState }): JSX.Element | null {
  if (submit.phase === "refused-decision") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">Refused: {submit.name ?? "unknown"}.</p>
        <p>{submit.message}</p>
      </div>
    );
  }
  if (submit.phase === "refused-unauthorized") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">The presented token was not accepted.</p>
        <p>{submit.message}</p>
      </div>
    );
  }
  if (submit.phase === "refused-unarmed") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">This server holds no write token to check against.</p>
        <p>{submit.message}</p>
      </div>
    );
  }
  if (submit.phase === "refused-internal") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">Something went wrong. This is retryable.</p>
        <p>{submit.message}</p>
      </div>
    );
  }
  if (submit.phase === "refused-other") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">The request did not go through.</p>
        <p>{submit.message}</p>
      </div>
    );
  }
  return null;
}

/**
 * The granted receipt, carrying the sequence (v2, N2) — the same
 * granted-edit idiom `GrantedReceipt` uses in `edit-roadmap-dialog`.
 */
export function AccountActionGrantedReceipt({
  record,
  onClose,
}: {
  readonly record: AccountActionDtoRecord;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div role="status" aria-live="polite" className="dialog__outcome dialog__outcome--granted">
      <p className="dialog__outcome-title">
        Recorded: {humanizeConstant(record.action)} → {humanizeConstant(record.resultingState)}.
      </p>
      <p>Sequence {record.sequence}.</p>
      <button type="button" className="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

interface AccountActionDialogBodyProps {
  readonly account: AccountDto;
  readonly action: AccountActionDto;
  readonly onGranted: () => void;
  readonly onClose: () => void;
}

function AccountActionDialogBody({ account, action, onGranted, onClose }: AccountActionDialogBodyProps): JSX.Element {
  const [actor, setActor] = useState("");
  const [note, setNote] = useState("");
  const [setState, setSetState] = useState<AccountStatusDto>("AVAILABLE");
  const [submit, setSubmit] = useState<AccountActionSubmitState>({ phase: "idle" });

  async function handleSubmit(): Promise<void> {
    setSubmit({ phase: "submitting" });
    const result = await postAccountAction(account.accountId, {
      action,
      setState: action === "OWNER_OVERRIDE" ? setState : null,
      note: note.trim() === "" ? null : note,
      actor,
    });

    if (result.kind === "ok") {
      setSubmit({ phase: "granted", record: result.data.action });
      onGranted();
      return;
    }
    if (result.kind === "api-error") {
      if (result.code === "BAD_REQUEST") {
        setSubmit({ phase: "refused-schema", field: result.detail ?? "(root)", message: result.message });
        return;
      }
      if (result.code === "WRITE_REFUSED") {
        setSubmit({ phase: "refused-decision", name: accountActionRefusalName(result.message), message: result.message });
        return;
      }
      const bearerErrorKind = classifyBearerErrorCode(result.code);
      if (bearerErrorKind === "unauthorized") {
        setSubmit({ phase: "refused-unauthorized", message: result.message });
        return;
      }
      if (bearerErrorKind === "unconfigured") {
        setSubmit({ phase: "refused-unarmed", message: result.message });
        return;
      }
      if (result.code === "INTERNAL") {
        setSubmit({ phase: "refused-internal", message: result.message });
        return;
      }
      setSubmit({ phase: "refused-other", message: result.message });
      return;
    }
    if (result.kind === "network-error") {
      setSubmit({ phase: "refused-other", message: result.detail });
      return;
    }
    setSubmit({ phase: "refused-other", message: "The response did not match the API contract this build expects." });
  }

  if (submit.phase === "granted") {
    return <AccountActionGrantedReceipt record={submit.record} onClose={onClose} />;
  }

  const fieldError = submit.phase === "refused-schema" ? submit : null;
  const disabled = submit.phase === "submitting" || actor.trim() === "";

  return (
    <form
      className="dialog__form"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <div className="field">
        <label htmlFor="account-action-actor">Recorded by</label>
        <input
          id="account-action-actor"
          type="text"
          value={actor}
          onChange={(event) => {
            setActor(event.target.value);
          }}
          placeholder="provider/model/role/instance"
          aria-describedby="account-action-actor-hint"
        />
        <p id="account-action-actor-hint" className="field-hint">
          Your own worker identity, in the landed format.
        </p>
      </div>

      {action === "OWNER_OVERRIDE" ? (
        <>
          <div className="field">
            <label htmlFor="account-action-set-state">Set state</label>
            <select
              id="account-action-set-state"
              value={setState}
              onChange={(event) => {
                setSetState(event.target.value as AccountStatusDto);
              }}
            >
              {AccountStatusDto.options.map((state) => (
                <option key={state} value={state}>
                  {humanizeConstant(state)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="account-action-note">Note</label>
            <textarea
              id="account-action-note"
              className={classNames("dialog__textarea", fieldError?.field === "note" ? "has-error" : undefined)}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              rows={3}
              aria-describedby={fieldError?.field === "note" ? "account-action-note-error" : undefined}
              aria-invalid={fieldError?.field === "note" ? true : undefined}
            />
            {fieldError?.field === "note" ? (
              <p id="account-action-note-error" className="field-error">
                {fieldError.message}
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      <div role="status" aria-live="polite" className="dialog__outcome-region">
        <AccountActionRefusalOutcome submit={submit} />
      </div>

      <div className="dialog__actions">
        <button type="button" className="button button--quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button" disabled={disabled}>
          {submit.phase === "submitting" ? "Recording…" : "Confirm"}
        </button>
      </div>
    </form>
  );
}

interface AccountActionDialogProps {
  readonly account: AccountDto;
  readonly action: AccountActionDto | null;
  readonly onClose: () => void;
  readonly onGranted: () => void;
}

/**
 * One account action's deliberate confirm — the edit dialog's idiom
 * (`@radix-ui/react-dialog`, already a dependency; no `Portal`, no
 * `forceMount`, the closed-content law held everywhere in this cohort).
 * Fully controlled by `action`; `key={action}` on the body so switching
 * directly from one action to another (without closing first) starts a
 * fresh draft rather than carrying the previous action's fields over.
 */
function AccountActionDialog({ account, action, onClose, onGranted }: AccountActionDialogProps): JSX.Element {
  // The row button that opened this dialog, captured on open and focused again
  // on close. See the handlers below for why the capture lives there.
  const openerRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Dialog.Overlay className="dialog__overlay" />
      <Dialog.Content
        className="dialog__content"
        aria-describedby="account-action-description"
        // Focus restore (P8-9-4). Same defect and same seam as the roadmap
        // edit dialog: Radix's modal content composes a default
        // `onCloseAutoFocus` that `preventDefault()`s the focus-scope restore
        // and focuses `context.triggerRef.current?.`, and this dialog is fully
        // controlled with no `Dialog.Trigger`, so nothing was focused on close
        // and keyboard focus fell to the document body.
        //
        // Captured in `onOpenAutoFocus` because that is the one self-contained
        // place whose ordering holds: the focus scope reads
        // `document.activeElement` before dispatching this event and before
        // focusing the first control, so here it is still the row button that
        // opened the dialog. That matters more here than anywhere — every row
        // has its own action buttons, so there is no single opener a ref
        // threaded from the view could name. A parent `useEffect` captures too
        // late (the child's passive effects run first) and a `useLayoutEffect`
        // runs on the workspace's static renders, where this component renders
        // closed.
        //
        // The capture refreshes on every open, so no staleness guard is needed:
        // do not add one. If the captured button has left the document by close
        // time — a row that vanished from the refreshed table — `focus()` is a
        // no-op and focus stays where Radix left it, named rather than faked.
        onOpenAutoFocus={() => {
          openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          openerRef.current?.focus();
        }}
      >
        <Dialog.Title className="dialog__title">
          {action !== null ? ACTION_LABEL[action] : ""} — {account.accountId}
        </Dialog.Title>
        <Dialog.Description id="account-action-description" className="dialog__description">
          {action !== null ? ACTION_CONSEQUENCE[action] : ""}
        </Dialog.Description>
        {action !== null ? (
          <AccountActionDialogBody key={action} account={account} action={action} onGranted={onGranted} onClose={onClose} />
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * The per-row action controls (P8-8G packet 3, blueprint v2 §3). Unarmed is
 * a posture, not a failure (N1): with no operator token held, this cell
 * explains that plainly rather than rendering disabled buttons a reader
 * would have to guess the reason for.
 */
function AccountActionsCell({
  account,
  bearerArmed,
  onGranted,
}: {
  readonly account: AccountDto;
  readonly bearerArmed: boolean;
  readonly onGranted: () => void;
}): JSX.Element {
  const [openAction, setOpenAction] = useState<AccountActionDto | null>(null);

  if (!bearerArmed) {
    return <p className="account-actions-cell account-actions-cell--unarmed">Paste an operator token above to act.</p>;
  }

  return (
    <div className="account-actions-cell">
      {AccountActionDto.options.map((action) => (
        <button
          key={action}
          type="button"
          className="button button--quiet"
          onClick={() => {
            setOpenAction(action);
          }}
        >
          {ACTION_LABEL[action]}
        </button>
      ))}
      {/*
        onGranted is passed straight through — it must not also close the
        dialog. A grant lands `AccountActionDialogBody` in its "granted"
        phase, and closing here would unmount that phase in the same batch,
        before AccountActionGrantedReceipt (and its sequence, in the live
        region) ever paints. Closing stays a later, explicit act: the
        receipt's own Close button, or Escape/overlay, both routed through
        `onClose` below.
      */}
      <AccountActionDialog
        account={account}
        action={openAction}
        onClose={() => {
          setOpenAction(null);
        }}
        onGranted={onGranted}
      />
    </div>
  );
}

function accountColumns(bearerArmed: boolean, onGranted: () => void): Column<AccountDto>[] {
  return [
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
      render: (account) => <AccountStateCell account={account} />,
    },
    {
      key: "actions",
      header: "Actions",
      priority: "essential",
      render: (account) => <AccountActionsCell account={account} bearerArmed={bearerArmed} onGranted={onGranted} />,
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
}
