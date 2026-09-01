import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { openLedger } from "@acp/ledger";

import type { DurableInvocation } from "../../../../src/contracts/index.js";
import type { FaultPoint } from "../../../../src/drivers/sqlite-supervisor/index.js";
import type { ScenarioRoot } from "../../../../src/toy/repository/index.js";
import { deterministicUuid } from "../../../../src/core/coordinates/index.js";

/**
 * P7B leg 1 pilot helpers: fixed fixtures and a read-only ledger snapshot for
 * the kill/restart drill over the read-only plan.
 *
 * Nothing here spawns. The real child process, the real SIGKILL and the real
 * `git` invocations all stay in `test/pilots/recovery/index.test.ts` -- the
 * only file in this pair whose name ends `.test.ts`, which is what the
 * fence's import-purity check treats as test-only. A helper module under
 * `test/` that is not itself `*.test.ts` is still scanned as
 * production-shaped source, exactly as the P7A helpers are.
 */

// ---------------------------------------------------------------------------
// Fixed instants and invocations -- no clock, no random source
// ---------------------------------------------------------------------------

const RECOVERY_SUBMITTED_AT = "2026-08-30T09:00:00.000Z";
const RECOVERY_SUBMISSION_DIGEST = "b".repeat(64);

export const RECOVERY_LEASE_ACQUIRED_AT = "2026-08-30T08:55:00.000Z";
export const RECOVERY_LEASE_EXPIRES_AT = "2026-08-30T10:00:00.000Z";

const RECOVERY_TASK_ID_AFTER_INTENT = "7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b01";
const RECOVERY_TASK_ID_AFTER_EFFECT = "7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b02";
const RECOVERY_TASK_ID_AFTER_OUTCOME = "7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b03";

/** A durable invocation for one fault scenario, from fixed inputs only. */
export function recoveryInvocation(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("p7b-recovery-invocation/" + taskId),
    submittedAt: RECOVERY_SUBMITTED_AT,
    submissionDigest: RECOVERY_SUBMISSION_DIGEST,
  };
}

export interface RecoveryFaultScenario {
  readonly id: string;
  readonly taskId: string;
  readonly fault: FaultPoint;
  /** The lease this scenario's writer acquires, pre-spawn. */
  readonly leaseId: string;
  /** A second lease id, for the same worktree, that must be refused. */
  readonly secondLeaseId: string;
}

/** One scenario per `FaultPoint`, in the roadmap's durability-law order. */
export const RECOVERY_FAULT_SCENARIOS: readonly RecoveryFaultScenario[] = Object.freeze([
  {
    id: "p7b-recovery-after-intent",
    taskId: RECOVERY_TASK_ID_AFTER_INTENT,
    fault: "AFTER_INTENT",
    leaseId: "7b7b7b7b-0000-4000-8000-000000000011",
    secondLeaseId: "7b7b7b7b-0000-4000-8000-000000000012",
  },
  {
    id: "p7b-recovery-after-effect",
    taskId: RECOVERY_TASK_ID_AFTER_EFFECT,
    fault: "AFTER_EFFECT",
    leaseId: "7b7b7b7b-0000-4000-8000-000000000021",
    secondLeaseId: "7b7b7b7b-0000-4000-8000-000000000022",
  },
  {
    id: "p7b-recovery-after-outcome",
    taskId: RECOVERY_TASK_ID_AFTER_OUTCOME,
    fault: "AFTER_OUTCOME",
    leaseId: "7b7b7b7b-0000-4000-8000-000000000031",
    secondLeaseId: "7b7b7b7b-0000-4000-8000-000000000032",
  },
]);

// ---------------------------------------------------------------------------
// A read-only view of the recovered ledger
// ---------------------------------------------------------------------------

export interface LedgerSnapshot {
  readonly eventCount: number;
  readonly headEventSha256: string;
  readonly state: string | null;
}

/** Open, read and close, without holding the ledger open across a spawn. */
export function readLedgerSnapshot(ledgerPath: string, taskId: string): LedgerSnapshot {
  const ledger = openLedger(ledgerPath, { readOnly: true });
  try {
    const status = ledger.status();
    const task = ledger.getTask(taskId);
    return {
      eventCount: status.eventCount,
      headEventSha256: status.headEventSha256,
      state: task === null ? null : task.currentState,
    };
  } finally {
    ledger.close();
  }
}

/** Count the effect markers a scenario's child has written, if any. */
export function countEffectMarkers(scenarioRoot: ScenarioRoot): number {
  const effects = join(scenarioRoot, "effects");
  if (!existsSync(effects)) return 0;
  return readdirSync(effects).filter((name) => name.endsWith(".marker")).length;
}
