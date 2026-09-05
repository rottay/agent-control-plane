import type { AccountAction, AccountActionEvent, AccountStatus } from "@acp/contracts";

/**
 * The operator-state fold (V2-B1e).
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
 * `OWNER_OVERRIDE`, recorded with its own receipt like every other action.
 *
 * **Why the fold lives here rather than in the gateway, where P8-8G packet 2
 * wrote it.** Two doors now need it. The gateway read model publishes the
 * effective state, and the CLI election must not elect an account an operator
 * drained. The CLI may not import the gateway, so a fold that stayed there
 * would have had to be written a second time — and two folds of one authority
 * law are two answers to "which state governs", differing on the day one of
 * them is edited. `L-V2B1E-1` in the architecture fence is what keeps the
 * count at one.
 *
 * **Why the history is contracts-typed.** `ACCOUNTS_ALLOWED_PACKAGES` is
 * `{@acp/contracts}`: this package may not import a ledger. The parameter is
 * therefore `AccountActionEvent`, the kernel's own event, rather than
 * `@acp/ledger`'s row projection — the same adjustment `usageObservationsFrom`
 * made in V2-B1d, for the same reason. Acquisition stays with the strata that
 * may open a ledger; the arithmetic stays here.
 *
 * Nothing here reads a clock, opens a file or resolves a credential. The fold
 * is pure over its two inputs, which is what makes a restart re-fold to the
 * same state rather than to whatever the file happens to say now.
 */

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
 * The most action rows one account's history may carry and still be folded.
 *
 * An operator action is a deliberate human act against one account — a drain,
 * a readiness, a re-auth demand, an owner override. Ten thousand of them is
 * three orders of magnitude above any plausible operator history.
 *
 * It is deliberately three orders of magnitude *below* `OBSERVATIONS_MAX`
 * (100 000), and the two numbers differ because they bound different things:
 * that one bounds a machine-generated usage stream, which grows with every
 * invocation, while this one bounds a hand-written log. A ceiling copied from
 * the other would be a ceiling nobody had reasoned about.
 *
 * It is a **refusal** threshold and never a truncation point. See
 * `readAccountActions` in `@acp/runtime`, which is the half that counts.
 */
export const ACCOUNT_ACTIONS_MAX = 10_000;

/**
 * Fold one account's effective state from the file's baseline and its history.
 *
 * The whole authority law in six lines: the baseline is the file's, the
 * history overrides it if it exists at all, and the newest entry wins.
 *
 * **`history` must be oldest-first and complete.** `at(-1)` is the newest
 * action only because the ledger reads `ORDER BY version ASC` over the
 * per-account monotone counter, and only because the read is exhaustive. A
 * caller holding a prefix must refuse rather than fold it: a prefix would
 * silently resurrect an older state, which is the exact widening this packet
 * exists to prevent.
 *
 * `resultingState` is **read, never recomputed**. The event carries the state
 * its action produced, derived at the moment it was recorded and checked by
 * the contract's own refinement; deriving it again here would put one policy
 * in two places with nothing keeping them equal, and `OWNER_OVERRIDE` — whose
 * state comes from the request rather than from the verb — could not be
 * derived at all.
 */
export function foldEffectiveState(
  fileState: AccountStatus,
  history: readonly AccountActionEvent[],
): EffectiveState {
  const newest = history.at(-1);
  if (newest === undefined) {
    return { effectiveState: fileState, stateSource: "OWNER_FILE", lastAction: null };
  }
  return {
    effectiveState: newest.resultingState,
    stateSource: "OPERATOR_ACTION",
    lastAction: {
      action: newest.action,
      at: newest.recordedAt,
      by: newest.actor,
    },
  };
}
