import { ACCOUNT_ACTIONS_MAX } from "@acp/accounts";
import type { AccountActionEvent } from "@acp/contracts";

/**
 * The acquisition half of the operator-state fold (V2-B1e).
 *
 * `@acp/accounts` owns the fold and may not import a ledger, so this module —
 * which already owns the acquisition half of the quota estimate for exactly
 * the same reason — reads one account's recorded actions and hands them to
 * that one fold. Arithmetic on one side of the boundary, I/O on the other.
 *
 * It is the sibling of `readAccountUsage`, and the differences between them
 * are the ledger's, not this module's:
 *
 *   - **Account-filtered in SQL.** `listAccountActions` carries
 *     `WHERE account_id = ?`, so there is no cross-account association to make
 *     here and no plane-wide scan to bound.
 *   - **Ordered by the per-account monotone counter**, `ORDER BY version ASC`,
 *     which is exactly what the fold's `at(-1)` depends on. The ordering is
 *     the ledger's; this module neither sorts nor may.
 *   - **Unpaginated.** The read returns the whole array, so "exhaustive" holds
 *     by construction: there is no cursor to follow and no partial-history
 *     state to guard against.
 *
 * Because the read is all-or-nothing, the ceiling below is a **refusal
 * threshold and never a truncation point** — see `readAccountActions`.
 */

/**
 * The ledger surface `readAccountActions` needs, and nothing more.
 *
 * Structural rather than the `Ledger` class, exactly as `UsageEventSource` is,
 * and for the same two reasons: the ceiling case needs more rows than it is
 * reasonable to append to a real database, and a domain module must not name a
 * persistence class to state what it reads. The real `Ledger` is assignable,
 * so the CLI passes the query-only handle it already holds.
 */
export interface ActionEventSource {
  listAccountActions(accountId: string): readonly { readonly event: AccountActionEvent }[];
}

/** What the reader answers with: the whole history, or a named refusal. */
export type AccountActionsRead =
  | { readonly ok: true; readonly history: readonly AccountActionEvent[] }
  | {
      readonly ok: false;
      readonly reason: "ACTION_HISTORY_EXCEEDED";
      /** A field name. Never a value out of the ledger. */
      readonly at: string;
    };

/**
 * Read one account's recorded operator actions, exhaustively (V2-B1e).
 *
 * **A refusal, never a truncation.** Above `ACCOUNT_ACTIONS_MAX` this returns
 * `ACTION_HISTORY_EXCEEDED` rather than folding a prefix. Folding a prefix
 * would silently resurrect an older state — an account drained at row 10 001
 * would read as available — which is the exact widening this packet exists to
 * prevent; and truncating the *newest* end is worse still, since the newest
 * row is the one that decides.
 *
 * **The refusal is a domain refusal, not a wire code.** It is deliberately not
 * a `QuotaRefusal` member: `QUOTA_REFUSALS` stays at thirteen, and an
 * action-history ceiling is not a quota fact. The CLI maps it to its own
 * closed error vocabulary at its door.
 *
 * **An empty history is a success, and means something specific**: the owner
 * file stands. A caller must never coerce a refusal into an empty history, and
 * this function never returns one for a read it could not complete.
 */
export function readAccountActions(
  source: ActionEventSource,
  accountId: string,
): AccountActionsRead {
  const rows = source.listAccountActions(accountId);
  if (rows.length > ACCOUNT_ACTIONS_MAX) {
    return { ok: false, reason: "ACTION_HISTORY_EXCEEDED", at: "history" };
  }
  return { ok: true, history: Object.freeze(rows.map((row) => row.event)) };
}
