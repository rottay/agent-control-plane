import {
  ACCOUNT_ACTION_STATE,
  LEDGER_ACCOUNT_CONTRACT_VERSION,
  LedgerError,
  openLedger,
} from "@acp/ledger";
import type { AccountActionRequest } from "@acp/protocol";
import type { AccountAction, AccountActionRecordRow, AccountStatus, Ledger } from "@acp/ledger";

import { readAccounts } from "../accounts/index.js";

/**
 * The account-actions seam (P8-8G packet 2).
 *
 * **The authority law, including its silent case.** An account's *existence*,
 * plan and limits come from the owner file, always. Its *operational state*
 * has two possible owners, and which one governs is decided by one fact:
 * whether any action has ever been recorded for that account.
 *
 *   - No action recorded → the owner file's `state` governs. The file is the
 *     only thing that has said anything, so it is the answer.
 *   - Any action recorded → the **ledger** owns the operational lifecycle from
 *     that moment on, and the newest action's resulting state is the effective
 *     state.
 *
 * The case worth stating out loud, because it is the one a reader would
 * otherwise assume the other way: **a later owner-file edit does not override
 * an earlier action.** Authority never returns to the file implicitly. If an
 * operator drained an account on Monday and edits the file on Tuesday, the
 * account is still draining — because the file cannot know what happened on
 * Monday, and silently letting it win would erase a recorded decision with an
 * unrecorded one.
 *
 * The correction path is therefore always an explicit act: `ACCOUNT_READY` or
 * `OWNER_OVERRIDE`, recorded with its own receipt like every other action. An
 * operator who wants the file to govern again says so, and the saying is
 * itself a fact in the log.
 *
 * The seam decides; the ledger records. The ledger carries no account policy —
 * duplicating these rules there would put one policy in two places with
 * nothing keeping them equal.
 */

/** Why an action was refused. Closed, and each name says what to do about it. */
export const ACCOUNT_ACTION_REFUSALS = Object.freeze([
  "ACCOUNTS_UNAVAILABLE",
  "UNKNOWN_ACCOUNT",
  "ALREADY_IN_STATE",
  "WRITE_CONFLICT",
] as const);
export type AccountActionRefusal = (typeof ACCOUNT_ACTION_REFUSALS)[number];

export type AccountActionOutcome =
  | {
      readonly ok: true;
      readonly record: AccountActionRecordRow;
      readonly inserted: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: AccountActionRefusal;
      /** A field path or a state name. Never a value out of the owner file. */
      readonly at: string;
    };

/**
 * What the executor needs to record one action (G7 D3).
 *
 * Renamed from `AccountActionInput`, which named the same thing as the console's
 * unrelated wire-body type and as the protocol schema below — three different
 * concepts, one word. This one is an *execution* input: a ledger handle, a file
 * path, a record. The wire object it carries is `AccountActionRequest`, and that
 * shape is `@acp/protocol`'s to own, not this module's to restate.
 */
export interface AccountActionExecution {
  readonly ledger: Ledger;
  readonly accountsFilePath: string | undefined;
  readonly accountId: string;
  readonly request: AccountActionRequest;
  /** Injected; this module never reads a clock. */
  readonly recordedAt: string;
  readonly eventId: string;
}

/** One account's effective state, and where the answer came from. */
export interface EffectiveState {
  readonly effectiveState: AccountStatus;
  readonly stateSource: "OWNER_FILE" | "OPERATOR_ACTION";
  readonly lastAction: {
    readonly action: AccountAction;
    readonly at: string;
    readonly by: string;
  } | null;
}

/**
 * Fold one account's effective state from the file's baseline and its history.
 *
 * The whole authority law in six lines: the baseline is the file's, the
 * history overrides it if it exists at all, and the newest entry wins. Pure
 * over its two inputs, so the same file and the same history always produce
 * the same answer — which is what makes a restart re-fold to the same state
 * rather than to whatever the file happens to say now.
 */
export function foldEffectiveState(
  fileState: AccountStatus,
  history: readonly AccountActionRecordRow[],
): EffectiveState {
  const newest = history.at(-1);
  if (newest === undefined) {
    return { effectiveState: fileState, stateSource: "OWNER_FILE", lastAction: null };
  }
  return {
    effectiveState: newest.event.resultingState,
    stateSource: "OPERATOR_ACTION",
    lastAction: {
      action: newest.event.action,
      at: newest.event.recordedAt,
      by: newest.event.actor,
    },
  };
}

/** The state an action produces: the verb's, or the override's own. */
export function resultingStateFor(
  action: AccountAction,
  setState: AccountStatus | null,
): AccountStatus | null {
  const implied = ACCOUNT_ACTION_STATE[action];
  return implied ?? setState;
}

/**
 * Record one action, or refuse it by name.
 *
 * The order is the design, and it mirrors the roadmap write: gather the fold,
 * decide against it, then append. Nothing is written before the decision, and
 * the decision reads only what it needs.
 */
export function recordAccountAction(input: AccountActionExecution): AccountActionOutcome {
  const { ledger, accountsFilePath, accountId, request, recordedAt, eventId } = input;

  // The baseline. Without an owner file there is no account to act on — not
  // "an account in an unknown state", but no account — so the refusal names
  // the missing baseline rather than inventing one.
  const accounts = readAccounts(accountsFilePath, recordedAt);
  if (!accounts.ok) {
    return { ok: false, reason: "ACCOUNTS_UNAVAILABLE", at: accounts.reason };
  }

  const baseline = accounts.items.find((item) => item.accountId === accountId);
  if (baseline === undefined) {
    return { ok: false, reason: "UNKNOWN_ACCOUNT", at: "accountId" };
  }

  const history = ledger.listAccountActions(accountId);
  const current = foldEffectiveState(baseline.state as AccountStatus, history);

  const resulting = resultingStateFor(request.action, request.setState);
  if (resulting === null) {
    // Only reachable for OWNER_OVERRIDE without a state; the schema refuses
    // that shape first, so this is a belt to the schema's braces rather than
    // a path a well-formed request takes.
    return { ok: false, reason: "UNKNOWN_ACCOUNT", at: "setState" };
  }

  // A no-op is refused by name rather than granted silently. Recording an
  // action that changes nothing would put an entry in the history that a
  // reader must then reason about, and "nothing happened" is exactly the
  // thing a log should not have to say.
  if (resulting === current.effectiveState) {
    return { ok: false, reason: "ALREADY_IN_STATE", at: current.effectiveState };
  }

  const version = (history.at(-1)?.event.version ?? 0) + 1;
  const event = {
    contractVersion: LEDGER_ACCOUNT_CONTRACT_VERSION,
    eventId,
    accountId,
    version,
    idempotencyKey: accountId + "/1/action." + String(version),
    action: request.action,
    resultingState: resulting,
    actor: request.actor,
    note: request.note,
    occurredAt: recordedAt,
    recordedAt,
  };

  // The short-lived writable handle, opened here and closed in `finally` —
  // the read path never holds one.
  const writable = openLedger(ledger.path);
  try {
    const appended = writable.appendAccountAction(event);
    return { ok: true, record: appended.record, inserted: appended.inserted };
  } catch (error: unknown) {
    // The same narrow catch packet 1 established, for the same reason: two
    // operators acting on one account at once both fold version N and both
    // build the same key. The loser is late, not broken.
    if (error instanceof LedgerError && RACE_LOST_CODES.includes(error.code)) {
      return { ok: false, reason: "WRITE_CONFLICT", at: "version" };
    }
    throw error;
  } finally {
    writable.close();
  }
}

/** Exactly the two conflict codes, matched by name. See packet 1's seam. */
const RACE_LOST_CODES: readonly string[] = Object.freeze([
  "LEDGER_IDEMPOTENCY_CONFLICT",
  "LEDGER_EVENT_ID_CONFLICT",
]);
