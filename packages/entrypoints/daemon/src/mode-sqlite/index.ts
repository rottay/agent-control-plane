import type { CommitPolicy, ResolvedRoute } from "@acp/contracts";
import type { Ledger } from "@acp/ledger";
import type { DurableInvocation, EffectPort } from "@acp/runtime";
import { SqliteSupervisor } from "@acp/runtime";

import { ModeError } from "../errors/index.js";

/**
 * The SQLite mode.
 *
 * Binds no socket and spawns no child of its own. That is not an incidental
 * property of the implementation, it is the whole point of the mode: it is the
 * driver that still works when the external server is unavailable, so anything
 * it needed from the network would defeat it. Whatever the injected effect
 * port runs is the port's, admitted by the daemon that built it, and is not a
 * dependency of this driver on any server (V2-B1b, stage 2).
 *
 * Reconciliation runs before the plan is walked, for the same reason it does in
 * Restate mode: a driver that starts advancing before it has agreed with the
 * ledger is deciding on its own memory.
 */

export interface SqliteModeInput {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  /**
   * The side effect the walk performs, built by the daemon from its config
   * and handed through (V2-B1b, stage 2). Required and never defaulted here,
   * for the same reason the policy is: the toy effect is no longer bound at
   * this seam, and a mode that assumed one would re-hide the binding.
   */
  readonly effects: EffectPort;
  readonly emittedBy: string;
  /**
   * The packet's commit policy, which selects the plan the supervisor walks.
   *
   * Required and passed through, never defaulted here: the daemon says which
   * policy it is running under at its own call site, in one place a reader can
   * find, rather than this mode assuming one on its behalf.
   */
  readonly commitPolicy: CommitPolicy;
  /**
   * The packet's initiative, passed through for the same reason and in the
   * same way as the policy above: the daemon says it once, at its own call
   * site, and this mode never invents one.
   */
  readonly initiativeId: string;
  /**
   * The route the walk was admitted on, passed through for the same reason and
   * in the same way as the policy and the initiative above (V2-B1c).
   *
   * It is the SAME value the daemon built the effect port from — one binding
   * at the call site, read twice — so the route the log records and the route
   * the execution runs cannot be two different values.
   */
  readonly route: ResolvedRoute;
}

export interface SqliteModeResult {
  readonly verdict: string;
  readonly finalState: string;
  readonly appended: number;
  readonly replayed: number;
}

/** Reconcile, then walk the plan to a checkpoint. */
export async function runSqliteMode(input: SqliteModeInput): Promise<SqliteModeResult> {
  const supervisor = new SqliteSupervisor({
    ledger: input.ledger,
    invocation: input.invocation,
    effects: input.effects,
    emittedBy: input.emittedBy,
    commitPolicy: input.commitPolicy,
    initiativeId: input.initiativeId,
    route: input.route,
  });

  const report = await supervisor.reconcile();
  if (!report.safeToResume) {
    throw new ModeError(
      "reconciliation refused to resume in SQLITE_SUPERVISOR mode: " + report.verdict,
    );
  }

  const run = await supervisor.runToCheckpoint();
  return {
    verdict: report.verdict,
    finalState: run.finalState,
    appended: run.appended,
    replayed: run.replayed,
  };
}
