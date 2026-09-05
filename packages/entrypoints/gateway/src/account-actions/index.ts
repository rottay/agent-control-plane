import { ACCOUNT_ACTION_STATE } from "@acp/ledger";
import { foldEffectiveState as foldAccountState } from "@acp/accounts";
import type { EffectiveState } from "@acp/accounts";
import type { AccountActionRequest } from "@acp/protocol";
import type { AccountAction, AccountActionRecordRow, AccountStatus, Ledger } from "@acp/ledger";

import { recordAccountAction as recordAccountActionWrite } from "@acp/runtime";

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

/**
 * One account's effective state, and where the answer came from.
 *
 * Re-exported from `@acp/accounts` rather than restated (V2-B1e). The name
 * this module has always published keeps working, and there is exactly one
 * declaration of the shape behind it.
 */
export type { EffectiveState };

/**
 * Fold one account's effective state, over the ledger's row projection.
 *
 * **The law itself moved to `@acp/accounts` in V2-B1e, and this is a wrapper
 * over it — not a second implementation.** The CLI election needs the same
 * fold and may not import the gateway, so a fold that stayed here would have
 * had to be written twice; two folds of one authority law are two answers to
 * "which state governs", differing on the day one of them is edited.
 *
 * What remains here is the only thing that is genuinely this module's: the
 * translation from `@acp/ledger`'s `AccountActionRecordRow` — a row with a
 * sequence and an event inside it — to the kernel event the domain fold reads.
 * `@acp/accounts` may not import a ledger, so this unwrapping has to happen on
 * the side of the boundary that may, and it happens once.
 *
 * Its one call site here is `overlayFor` in the accounts read model. The
 * write door used to be the second, and since V2-B1f/F4c it lives in
 * `@acp/runtime` and calls the domain fold directly over the row's own event,
 * so the unwrapping happens once on each side of the boundary and never twice
 * on this one. `L-V2B1E-1` in the architecture fence is what proves no copy
 * came back.
 */
export function foldEffectiveState(
  fileState: AccountStatus,
  history: readonly AccountActionRecordRow[],
): EffectiveState {
  return foldAccountState(
    fileState,
    history.map((row) => row.event),
  );
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
 * **A delegating wrapper since V2-B1f/F4c**, and the shape is the one this
 * module already uses for `foldEffectiveState` above: the export, its
 * signature and every refusal it can produce are exactly what they were, and
 * the ledger-writing door itself now lives in `@acp/runtime` beside the reader
 * of the same history.
 *
 * **What stays here is what belongs to an entrypoint**: the wire type, the
 * owner-file path, and the admission ladder that turns that path into a
 * baseline. The refusals that ladder produces stay here with it — deliberately.
 * `accounts.reason` is this gateway's own five-word vocabulary, mapped from the
 * loader's fourteen refusals by a table this package keeps private, and it
 * travels into a 409's detail. Surfacing the loader's raw reason instead would
 * describe an operator's filesystem to anyone who can reach the port, and no
 * test would have caught the change.
 *
 * So the two refusals that depend on the file are produced **here**, before the
 * runtime is called, by the same two lines that produced them before; the three
 * that depend on the ledger are the runtime's, and its vocabulary is a subset
 * of this one, so its outcome is returned unchanged.
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

  // The state is a value from here on. The runtime opens no owner file, names
  // no loader, and cannot reach this package.
  return recordAccountActionWrite({
    source: ledger,
    accountId,
    baseline: baseline.state as AccountStatus,
    action: request.action,
    setState: request.setState,
    actor: request.actor,
    note: request.note,
    recordedAt,
    eventId,
  });
}
