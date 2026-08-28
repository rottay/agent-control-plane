import type { Ledger } from "@acp/ledger";
import type { DurableInvocation, ScenarioRoot } from "@acp/runtime";
import { SqliteSupervisor } from "@acp/runtime";

import { ModeError } from "../errors/index.js";

/**
 * The SQLite mode.
 *
 * Binds no socket and spawns no child. That is not an incidental property of
 * the implementation, it is the whole point of the mode: it is the driver that
 * still works when the external server is unavailable, so anything it needed
 * from the network would defeat it.
 *
 * Reconciliation runs before the plan is walked, for the same reason it does in
 * Restate mode: a driver that starts advancing before it has agreed with the
 * ledger is deciding on its own memory.
 */

export interface SqliteModeInput {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly scenarioRoot: ScenarioRoot;
  readonly emittedBy: string;
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
    scenarioRoot: input.scenarioRoot,
    emittedBy: input.emittedBy,
  });

  const report = await supervisor.reconcile();
  if (!report.safeToResume) {
    throw new ModeError(
      "reconciliation refused to resume in SQLITE_SUPERVISOR mode: " + report.verdict,
    );
  }

  const run = supervisor.runToCheckpoint();
  return {
    verdict: report.verdict,
    finalState: run.finalState,
    appended: run.appended,
    replayed: run.replayed,
  };
}
