import { ACCOUNT_ACTIONS_MAX, foldEffectiveState } from "@acp/accounts";
import { ACCOUNT_ACTION_STATE } from "@acp/contracts";
import type {
  AccountAction,
  AccountActionEvent,
  AccountStatus,
  WorkerIdentityString,
} from "@acp/contracts";
import { LedgerError, openLedger } from "@acp/ledger";
import type { AccountActionRecordRow } from "@acp/ledger";
import { LEDGER_ACCOUNT_CONTRACT_VERSION } from "@acp/ledger";

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

// ---------------------------------------------------------------------------
// The writer (V2-B1f/F4c)
// ---------------------------------------------------------------------------

/**
 * The other half of the seam: one door that records what an account's state
 * became.
 *
 * **Why it is here and not where it was.** The one door that appended an
 * `AccountActionEvent` lived in an entrypoint, so no module in a domain
 * stratum could reach it — the switch executor names that gap by hand at its
 * first step, and two records have deferred it. Moving the door into the
 * stratum that already owns the acquisition half puts the write beside the
 * read, under the boundary this module's own docblock states: arithmetic on
 * one side, I/O on the other.
 *
 * **What did not move, and that is the point.** The entrypoint keeps its
 * export as a delegating wrapper with the same signature — the shape that file
 * already uses for the effective-state fold — so no route, status, wire type
 * or payload changes and its own suite passes with no assertion edited.
 *
 * **The baseline is a value, never a file.** This module opens no owner file
 * and names no loader. The caller resolves the account's file state through
 * whatever admission ladder it already owns and passes the answer in. Two
 * things follow, and both are deliberate: the refusal vocabulary that ladder
 * produces stays private to the caller that owns it — it reaches an HTTP
 * payload, and coarsening it would describe an operator's filesystem to anyone
 * who can reach the port — and **any** caller that can supply a baseline can
 * record, including one that is forbidden the owner file entirely.
 */

/**
 * The ledger surface the writer needs, and nothing more.
 *
 * `ActionEventSource` widened by exactly what appending requires: the path to
 * open a short-lived writable handle on. Structural for the reason the reader's
 * is — the real `Ledger` is assignable, and a fake can drive the conflict case
 * without racing two real processes.
 */
export interface ActionWriteSource extends ActionEventSource {
  listAccountActions(accountId: string): readonly AccountActionRecordRow[];
  readonly path: string;
}

/**
 * What recording one action needs, over kernel primitives only.
 *
 * Deliberately **not** the protocol's wire type: `@acp/protocol` is not in this
 * stratum's allowlist, and the allowlist is not widened for a packet's
 * convenience. The caller that holds the wire object destructures it here, the
 * way this module's reader already declares its own ledger surface rather than
 * naming a persistence class.
 */
export interface AccountActionWrite {
  readonly source: ActionWriteSource;
  readonly accountId: string;
  /**
   * The account's state according to the owner file, already resolved.
   *
   * A value, never a path. It is where the fold starts; the newest recorded
   * action wins over it, and authority never returns to the file implicitly.
   */
  readonly baseline: AccountStatus;
  readonly action: AccountAction;
  /** The operator's own state, for the override verb. Never invented here. */
  readonly setState: AccountStatus | null;
  readonly actor: WorkerIdentityString;
  readonly note: string | null;
  /** Injected; this module reads no clock. */
  readonly recordedAt: string;
  readonly eventId: string;
}

/**
 * Why an action was refused, on the ledger side of the seam.
 *
 * Three names, and the set is deliberately narrower than the door's public
 * one: the two refusals that depend on the owner file are produced by the
 * caller that owns the file, before this function is reached. This is a subset
 * of that vocabulary, so a caller may return what it gets back unchanged.
 */
export const ACCOUNT_WRITE_REFUSALS = Object.freeze([
  "UNKNOWN_ACCOUNT",
  "ALREADY_IN_STATE",
  "WRITE_CONFLICT",
] as const);
export type AccountWriteRefusal = (typeof ACCOUNT_WRITE_REFUSALS)[number];

export type AccountActionWriteOutcome =
  | {
      readonly ok: true;
      readonly record: AccountActionRecordRow;
      readonly inserted: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: AccountWriteRefusal;
      /** A field path or a state name. Never a value out of the owner file. */
      readonly at: string;
    };

/** Exactly the two conflict codes, matched by name. */
const RACE_LOST_CODES: readonly string[] = Object.freeze([
  "LEDGER_IDEMPOTENCY_CONFLICT",
  "LEDGER_EVENT_ID_CONFLICT",
]);

/**
 * Record one account action, or refuse it by name.
 *
 * The order is the design, and it is preserved verbatim from the door this
 * replaces: fold the recorded history over the baseline, decide against it,
 * then append. Nothing is written before the decision, and the decision reads
 * only what it needs.
 *
 * **The verb governs the state.** `ACCOUNT_ACTION_STATE` maps three of the
 * four verbs to the state they imply; the fourth is the operator's override,
 * which carries its own. Nothing here invents a state a verb does not imply —
 * so the two account statuses no verb implies stay unrecordable, which is an
 * open gap recorded in this packet's own architecture decision rather than
 * closed by forging an override nobody requested.
 */
export function recordAccountAction(input: AccountActionWrite): AccountActionWriteOutcome {
  const { source, accountId, baseline, action, setState, actor, note, recordedAt, eventId } = input;

  const history = source.listAccountActions(accountId);
  // The one fold, over the events the rows carry. `@acp/accounts` owns the
  // law and may not import a ledger, so the unwrapping happens on this side of
  // the boundary — once, here, exactly as the read path does it.
  const current = foldEffectiveState(
    baseline,
    history.map((row) => row.event),
  );

  const implied = ACCOUNT_ACTION_STATE[action];
  const resulting = implied ?? setState;
  if (resulting === null) {
    // Only reachable for an override carrying no state; the contract refuses
    // that shape first, so this is a belt to the schema's braces rather than a
    // path a well-formed request takes.
    return { ok: false, reason: "UNKNOWN_ACCOUNT", at: "setState" };
  }

  // A no-op is refused by name rather than granted silently. Recording an
  // action that changes nothing would put an entry in the history that a
  // reader must then reason about, and "nothing happened" is exactly the thing
  // a log should not have to say.
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
    action,
    resultingState: resulting,
    actor,
    note,
    occurredAt: recordedAt,
    recordedAt,
  };

  // The short-lived writable handle, opened here and closed in `finally` — the
  // read path never holds one.
  const writable = openLedger(source.path);
  try {
    const appended = writable.appendAccountAction(event);
    return { ok: true, record: appended.record, inserted: appended.inserted };
  } catch (error: unknown) {
    // The narrow catch, for the reason the seam established: two operators
    // acting on one account at once both fold version N and both build the
    // same key. The loser is late, not broken.
    if (error instanceof LedgerError && RACE_LOST_CODES.includes(error.code)) {
      return { ok: false, reason: "WRITE_CONFLICT", at: "version" };
    }
    throw error;
  } finally {
    writable.close();
  }
}
