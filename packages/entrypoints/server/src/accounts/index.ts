import {
  ACCOUNTS_FILE_MAX_BYTES,
  buildRegistry,
  estimateQuota,
  loadAccountsFile,
  resetCalendar,
} from "@acp/accounts";
import type { AccountsRefusal } from "@acp/accounts";
import type { AccountActionRecordRow, AccountStatus } from "@acp/ledger";

import { foldEffectiveState } from "../account-actions/index.js";

/**
 * The accounts read model (P8-8F).
 *
 * The one route on this plane whose source is not the ledger. It composes the
 * landed accounts domain — `loadAccountsFile` → `buildRegistry` → per-account
 * `estimateQuota` and `resetCalendar` — and maps every possible refusal into a
 * value. **Nothing here throws for a missing or malformed owner file**: on a
 * fresh machine there is no accounts file, and a 500 would report a broken
 * server for the commonest correct state there is.
 *
 * The clock is injected, exactly as the accounts domain requires. This module
 * never reads one, so two calls with the same file and the same instant produce
 * byte-identical output — which is what makes the endpoint testable at all, and
 * what the parity table's `estimatedAt` binding relies on.
 *
 * **What is not here.** `credentialRef` and `authProfileRef` are on the landed
 * `AccountRecord` and are never read by this module. Not read, not nulled, not
 * redacted: a projection that never touches a field cannot leak it, and that is
 * a stronger property than one that touches it carefully.
 */

/** The five words this plane uses, mapped from the loader's fourteen. */
export type AccountsUnavailableReasonModel =
  | "ACCOUNTS_FILE_UNCONFIGURED"
  | "ACCOUNTS_FILE_ABSENT"
  | "ACCOUNTS_FILE_UNREADABLE"
  | "ACCOUNTS_FILE_SCHEMA_REFUSED"
  | "ACCOUNTS_FILE_OVERSIZE";

/**
 * The refusal map, total over the registry's closed vocabulary.
 *
 * Written as a `Record` keyed by `AccountsRefusal` so it is **exhaustive by
 * type**: a refusal added to the accounts domain fails this file to compile
 * rather than falling through to a default. There is deliberately no default
 * arm — a default is how a new refusal quietly becomes "unreadable" and stops
 * telling the operator what to fix.
 *
 * The coarsening is intentional and is the security argument. `NOT_OWNED` and
 * `UNSAFE_PERMISSIONS` are different facts calling for the same action, and
 * saying which one it was describes the operator's filesystem to anyone who can
 * reach the port.
 */
const REASON_BY_REFUSAL: Readonly<Record<AccountsRefusal, AccountsUnavailableReasonModel>> =
  Object.freeze({
    // Nobody wired a path. The only reason that means "configure me".
    PATH_NOT_SUPPLIED: "ACCOUNTS_FILE_UNCONFIGURED",

    // A path was given and nothing is there.
    OWNER_FILE_ABSENT: "ACCOUNTS_FILE_ABSENT",

    // Something is there, and this process declined to read through it. The
    // path-shape refusals live here rather than under UNCONFIGURED because a
    // path *was* supplied: what failed is the read, not the wiring.
    PATH_NOT_ABSOLUTE: "ACCOUNTS_FILE_UNREADABLE",
    PATH_NOT_CANONICAL: "ACCOUNTS_FILE_UNREADABLE",
    OWNER_FILE_NOT_REGULAR: "ACCOUNTS_FILE_UNREADABLE",
    OWNER_FILE_NOT_OWNED: "ACCOUNTS_FILE_UNREADABLE",
    OWNER_FILE_UNSAFE_PERMISSIONS: "ACCOUNTS_FILE_UNREADABLE",

    // Too big to read at all. Its own word because the fix is different:
    // shrink the file, not repair it.
    OWNER_FILE_TOO_LARGE: "ACCOUNTS_FILE_OVERSIZE",

    // Read, and not a valid accounts file. The guard refusals belong here too:
    // an owner file carrying credential or transcript material is a schema
    // violation of the strictest kind, and it is refused rather than sanitized.
    OWNER_FILE_NOT_JSON: "ACCOUNTS_FILE_SCHEMA_REFUSED",
    OWNER_FILE_INVALID: "ACCOUNTS_FILE_SCHEMA_REFUSED",
    OWNER_FILE_UNEXPECTED_KEY: "ACCOUNTS_FILE_SCHEMA_REFUSED",
    OWNER_FILE_CREDENTIAL_MATERIAL: "ACCOUNTS_FILE_SCHEMA_REFUSED",
    OWNER_FILE_TRANSCRIPT_MATERIAL: "ACCOUNTS_FILE_SCHEMA_REFUSED",
    DUPLICATE_ACCOUNT_ID: "ACCOUNTS_FILE_SCHEMA_REFUSED",
  });

/** One account, already stripped to what the plane may publish. */
export interface AccountReadModel {
  readonly accountId: string;
  readonly provider: string;
  readonly models: readonly string[];
  readonly plan: string | null;
  readonly state: string;
  readonly quota: {
    readonly remainingRatio: number | null;
    readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  };
  readonly reset: {
    readonly nextResetAt: string | null;
    readonly source: "OBSERVED" | "DECLARED" | "UNKNOWN";
    readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  };
  readonly lastProbeAt: string | null;
  readonly lastError: string | null;
  /**
   * The state that actually governs, and where it came from (P8-8G packet 2).
   *
   * The raw `state` above stays: it is what the owner file says, and a reader
   * comparing the two is exactly how an operator notices that the file and
   * the ledger disagree — which is a real and useful thing to see, not a
   * discrepancy to hide behind one number.
   */
  readonly effectiveState: string;
  readonly stateSource: "OWNER_FILE" | "OPERATOR_ACTION";
  readonly lastAction: {
    readonly action: string;
    readonly at: string;
    readonly by: string;
  } | null;
}

export type AccountsOutcome =
  | { readonly ok: true; readonly items: readonly AccountReadModel[]; readonly estimatedAt: string }
  | {
      readonly ok: false;
      readonly reason: AccountsUnavailableReasonModel;
      /** The loader's own field path. Never a value from the file. */
      readonly detail: string;
    };

/**
 * Read the owner's accounts, or say honestly why not.
 *
 * `accountsFilePath` is `undefined` when the operator did not wire one. That is
 * passed straight through to the loader rather than defaulted here: the loader's
 * "no default path" law is only true if this module declines to invent one, and
 * the loader answers `PATH_NOT_SUPPLIED` for exactly this case.
 */
export function readAccounts(
  accountsFilePath: string | undefined,
  now: string,
  /**
   * The action history source, when one is available.
   *
   * Optional so the seam can fold the baseline without recursing into itself:
   * `recordAccountAction` calls this to find the account, and handing it a
   * ledger here would make the baseline depend on the history it is the
   * baseline for. Absent means "file only", which is the honest answer when
   * nobody asked about actions.
   */
  actionsFor?: (accountId: string) => readonly AccountActionRecordRow[],
): AccountsOutcome {
  const loaded = loadAccountsFile(accountsFilePath);
  if (!loaded.ok) {
    return { ok: false, reason: REASON_BY_REFUSAL[loaded.reason], detail: loaded.at };
  }

  const registry = buildRegistry(loaded.registry.accounts);
  const items = registry.accounts.map((record) => {
    // The quota fold is handed no observations here: this endpoint reports what
    // the account record itself declares, and the spend-derived estimate is the
    // ledger's story, told by the initiative plane. An estimate over an empty
    // observation set is refused by the domain rather than returning zero, and
    // that refusal is reported as an unknown ratio rather than as a false one.
    const estimate = estimateQuota({
      record,
      observations: [],
      limitKey: Object.keys(record.knownLimits)[0] ?? "",
      now,
    });
    const calendar = resetCalendar(record, now);

    return Object.freeze({
      accountId: record.accountId,
      provider: record.provider,
      models: record.enabledModels,
      plan: record.plan,
      state: record.status,
      quota: Object.freeze({
        remainingRatio: estimate.ok ? estimate.estimate.remainingRatio : record.quotaEstimate.remainingRatio,
        confidence: estimate.ok ? estimate.estimate.confidence : record.quotaEstimate.confidence,
      }),
      reset: Object.freeze({
        nextResetAt: calendar.ok ? calendar.calendar.nextResetAt : null,
        source: calendar.ok ? calendar.calendar.kind : ("UNKNOWN" as const),
        confidence: calendar.ok ? calendar.calendar.confidence : ("LOW" as const),
      }),
      lastProbeAt: record.lastHealthProbe === null ? null : record.lastHealthProbe.checkedAt,
      lastError: record.lastClassifiedError,
      ...overlayFor(record.status, actionsFor?.(record.accountId) ?? []),
    });
  });

  return { ok: true, items: Object.freeze(items), estimatedAt: now };
}

/** Re-exported so the route's bound can be stated from one place. */
export { ACCOUNTS_FILE_MAX_BYTES };

/**
 * The authority overlay, applied per account.
 *
 * Delegates to the seam's own fold so there is exactly one implementation of
 * the law — the read and the write cannot disagree about which state governs,
 * because they compute it with the same function.
 */
function overlayFor(
  fileState: string,
  history: readonly AccountActionRecordRow[],
): {
  readonly effectiveState: string;
  readonly stateSource: "OWNER_FILE" | "OPERATOR_ACTION";
  readonly lastAction: { readonly action: string; readonly at: string; readonly by: string } | null;
} {
  const folded = foldEffectiveState(fileState as AccountStatus, history);
  return Object.freeze({
    effectiveState: folded.effectiveState,
    stateSource: folded.stateSource,
    lastAction: folded.lastAction,
  });
}
