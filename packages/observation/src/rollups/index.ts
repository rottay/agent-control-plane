import type { ControlPlaneEvent } from "@acp/contracts";

/**
 * Token rollups: what was spent and what is held, per task and per initiative.
 *
 * A pure fold over a ledger-ordered chain of frozen `ControlPlaneEvent`
 * values, in the observation plane's own discipline. There is no ledger here,
 * no clock, no filesystem and no randomness: the caller pages the events and
 * folds the task-to-initiative mapping out of the task projection, and hands
 * both in. Two folds over the same inputs are byte-identical, which is the
 * only reason a rollup recorded today can be compared against the same chain
 * replayed tomorrow.
 *
 * The events arrive as contract values rather than ledger records because this
 * package has exactly one module allowed to name `@acp/ledger`, and it is not
 * this one. That is a fence law, not a preference, and it costs nothing: the
 * fold reads only what the contract already guarantees.
 *
 * Three laws shape the arithmetic, and they are not the same law twice:
 *
 * 1. **Usage accumulates.** Every `TOKEN_USAGE_RECORDED` adds to its task's
 *    total. Spend is history, and history sums.
 * 2. **A reservation is a current hold, not a history.** A task's
 *    `tokensReserved` is the **last** `TOKEN_RESERVATION_RECORDED` in ledger
 *    order — a re-record supersedes rather than adds. Summing reservations
 *    would double-count a hold that was merely restated, and would report a
 *    task as holding more than any single reservation ever claimed.
 * 3. **An initiative is the sum of its tasks**, for both measures, because a
 *    hold is current per task and those holds coexist.
 *
 * Two shapes of honesty matter more than the numbers:
 *
 * - A task whose mapping is null — an old `TASK_DISCOVERED` that predates
 *   initiative scoping — folds into an explicit **unscoped** bucket. It is
 *   never dropped and never attributed to an initiative it does not belong to,
 *   because a rollup that quietly loses spend is worse than one that admits it
 *   cannot place it.
 * - An event whose payload does not carry the named shape is **skipped and
 *   counted**, per task, in `skippedMalformed`. This module is a read model,
 *   not an authority: it may not refuse, and it may not lie by silence. The
 *   count is the difference between the two.
 */

/** The event types this fold reads. Nothing else is inspected. */
export const ROLLUP_USAGE_TYPE = "TOKEN_USAGE_RECORDED";
export const ROLLUP_RESERVATION_TYPE = "TOKEN_RESERVATION_RECORDED";

/**
 * Ceiling for a single `payload.tokens`, matching the budget convention the
 * baseline uses for its own measure. Declared here rather than imported, so
 * this module's bounds are its own and a change to one measure cannot silently
 * move another.
 */
export const ROLLUP_TOKENS_MAX = 10_000_000;

/** Bound on an account id, so one event cannot dominate a key set. */
export const ROLLUP_ACCOUNT_ID_MAX_LENGTH = 80;

/**
 * The bucket a task with no initiative folds into.
 *
 * A sentinel rather than a null key, so the unscoped total is a first-class
 * row a reader has to look at rather than an absence they might not notice.
 */
export const UNSCOPED_INITIATIVE = "<unscoped>" as const;

export interface TaskTokenRollup {
  readonly taskId: string;
  /** The initiative this task is scoped to, or null when it has none. */
  readonly initiativeId: string | null;
  /** Sum of every well-formed usage event for this task. */
  readonly tokensUsed: number;
  /** The last well-formed reservation for this task. Zero when never held. */
  readonly tokensReserved: number;
  readonly usageEvents: number;
  readonly reservationEvents: number;
  /** Usage or reservation events whose payload the convention does not name. */
  readonly skippedMalformed: number;
}

export interface InitiativeTokenRollup {
  /** An initiative id, or `UNSCOPED_INITIATIVE` for tasks with no mapping. */
  readonly initiativeId: string;
  readonly tokensUsed: number;
  readonly tokensReserved: number;
  /** Distinct tasks that contributed at least one well-formed event. */
  readonly taskCount: number;
  readonly skippedMalformed: number;
}

export interface TokenRollups {
  /** Sorted by task id. */
  readonly byTask: readonly TaskTokenRollup[];
  /** Sorted by initiative id; the unscoped bucket sorts among them by name. */
  readonly byInitiative: readonly InitiativeTokenRollup[];
  readonly tokensUsed: number;
  readonly tokensReserved: number;
  /** Across every task, so a caller sees the total it cannot place. */
  readonly skippedMalformed: number;
}

export interface TokenRollupInput {
  /** The task-stream events, in ledger order. The caller pages them. */
  readonly events: readonly ControlPlaneEvent[];
  /**
   * Task to initiative, folded by the caller from the task projection. A task
   * absent from the map, or mapped to null, is unscoped — the two are the same
   * fact stated two ways, and both are honored.
   */
  readonly initiativeByTask: ReadonlyMap<string, string | null>;
}

interface MutableTaskRollup {
  taskId: string;
  initiativeId: string | null;
  tokensUsed: number;
  tokensReserved: number;
  usageEvents: number;
  reservationEvents: number;
  skippedMalformed: number;
}

/**
 * The token count an event carries, or null when it carries none.
 *
 * Null is the module's whole vocabulary for "this payload is not what the
 * convention names": there is no error to raise, because a read model that
 * refused would stop being a read model.
 */
function readTokens(event: ControlPlaneEvent): number | null {
  const accountId = event.payload["accountId"];
  if (typeof accountId !== "string") return null;
  if (accountId.length === 0 || accountId.length > ROLLUP_ACCOUNT_ID_MAX_LENGTH) return null;

  const tokens = event.payload["tokens"];
  if (typeof tokens !== "number" || !Number.isInteger(tokens)) return null;
  if (tokens < 0 || tokens > ROLLUP_TOKENS_MAX) return null;
  return tokens;
}

function emptyRollup(taskId: string, initiativeId: string | null): MutableTaskRollup {
  return {
    taskId,
    initiativeId,
    tokensUsed: 0,
    tokensReserved: 0,
    usageEvents: 0,
    reservationEvents: 0,
    skippedMalformed: 0,
  };
}

/**
 * Fold the token rollups.
 *
 * Every task that carries at least one usage or reservation event appears,
 * including one whose every event was malformed: its totals are zero and its
 * `skippedMalformed` says why, which is the point.
 */
export function computeTokenRollups(input: TokenRollupInput): TokenRollups {
  const byTask = new Map<string, MutableTaskRollup>();

  for (const event of input.events) {
    if (event.type !== ROLLUP_USAGE_TYPE && event.type !== ROLLUP_RESERVATION_TYPE) continue;

    const mapped = input.initiativeByTask.get(event.taskId);
    const initiativeId = mapped === undefined ? null : mapped;

    let rollup = byTask.get(event.taskId);
    if (rollup === undefined) {
      rollup = emptyRollup(event.taskId, initiativeId);
      byTask.set(event.taskId, rollup);
    }

    const tokens = readTokens(event);
    if (tokens === null) {
      rollup.skippedMalformed += 1;
      continue;
    }

    if (event.type === ROLLUP_USAGE_TYPE) {
      const next = rollup.tokensUsed + tokens;
      // A sum that has left the safe-integer range is not a number this module
      // may report. It is counted as skipped rather than thrown, for the same
      // reason a malformed payload is: nothing here is an authority.
      if (!Number.isSafeInteger(next)) {
        rollup.skippedMalformed += 1;
        continue;
      }
      rollup.tokensUsed = next;
      rollup.usageEvents += 1;
      continue;
    }

    // Law 2: the last reservation stands. An earlier hold is superseded, not
    // added to, so a task that re-records the same hold still holds it once.
    rollup.tokensReserved = tokens;
    rollup.reservationEvents += 1;
  }

  const tasks = [...byTask.values()]
    .map(
      (rollup): TaskTokenRollup => ({
        taskId: rollup.taskId,
        initiativeId: rollup.initiativeId,
        tokensUsed: rollup.tokensUsed,
        tokensReserved: rollup.tokensReserved,
        usageEvents: rollup.usageEvents,
        reservationEvents: rollup.reservationEvents,
        skippedMalformed: rollup.skippedMalformed,
      }),
    )
    .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));

  const initiatives = new Map<
    string,
    { tokensUsed: number; tokensReserved: number; taskCount: number; skippedMalformed: number }
  >();

  for (const task of tasks) {
    const key = task.initiativeId ?? UNSCOPED_INITIATIVE;
    const current = initiatives.get(key) ?? {
      tokensUsed: 0,
      tokensReserved: 0,
      taskCount: 0,
      skippedMalformed: 0,
    };
    initiatives.set(key, {
      tokensUsed: current.tokensUsed + task.tokensUsed,
      tokensReserved: current.tokensReserved + task.tokensReserved,
      // A task counts once it has contributed a well-formed event. One whose
      // every event was malformed is present in byTask and in the skip count,
      // but claiming it as a contributor would overstate the evidence.
      taskCount:
        current.taskCount + (task.usageEvents > 0 || task.reservationEvents > 0 ? 1 : 0),
      skippedMalformed: current.skippedMalformed + task.skippedMalformed,
    });
  }

  const byInitiative = [...initiatives.entries()]
    .map(
      ([initiativeId, totals]): InitiativeTokenRollup => ({
        initiativeId,
        tokensUsed: totals.tokensUsed,
        tokensReserved: totals.tokensReserved,
        taskCount: totals.taskCount,
        skippedMalformed: totals.skippedMalformed,
      }),
    )
    .sort((left, right) =>
      left.initiativeId < right.initiativeId ? -1 : left.initiativeId > right.initiativeId ? 1 : 0,
    );

  return {
    byTask: Object.freeze(tasks),
    byInitiative: Object.freeze(byInitiative),
    tokensUsed: tasks.reduce((total, task) => total + task.tokensUsed, 0),
    tokensReserved: tasks.reduce((total, task) => total + task.tokensReserved, 0),
    skippedMalformed: tasks.reduce((total, task) => total + task.skippedMalformed, 0),
  };
}
