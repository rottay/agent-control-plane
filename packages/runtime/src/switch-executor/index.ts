import { CONTRACT_VERSION, ControlPlaneEvent } from "@acp/contracts";
import type {
  ControlPlaneEvent as ParsedControlPlaneEvent,
  ControlPlaneEventType,
  Lease,
  TaskState,
} from "@acp/contracts";
import type { SwitchPlan } from "@acp/accounts";

import type { DurableInvocation } from "../contracts/index.js";
import { deriveEventCoordinate } from "../core/coordinates/index.js";
import type { LedgerPort } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";

/**
 * The switch executor.
 *
 * `decideSwitch` returns a lawful plan as a value and never acts; this module
 * is the executor that plan has been waiting for. It takes the plan, appends
 * its events to the ledger in the order the module returned them, and holds no
 * state of its own — everything it needs beyond the plan it reads back out of
 * the ledger, which is what keeps the ledger the authority rather than this
 * module's memory.
 *
 * **The `LEASE_REVOKED` enrichment.** The switching module emits that event
 * with `{accountId}`, because an account policy is all it knows; the
 * enforcement plane emits the same name with
 * `{leaseId, worktreePath, holder, cause}`. P7B recorded the divergence as a
 * forward-carry rather than patching around it, and this is where it closes:
 * at `RELEASE_LEASE` time the executor holds the real lease, so it appends the
 * unified payload — the enforcement shape **plus** the module's own
 * `accountId`. Additive, so a `leaseId`-keyed fold now sees the revocation it
 * used to skip, and nothing that read `accountId` stops working.
 *
 * The envelope is this module's to supply, exactly as the switching module's
 * documentation says: coordinates from the durable invocation, instants fixed,
 * nothing minted from a clock or a random source.
 */

export interface SwitchExecutionInput {
  readonly ledger: LedgerPort;
  readonly invocation: DurableInvocation;
  readonly plan: SwitchPlan;
  readonly emittedBy: string;
  /**
   * The lease the packet actually holds, or null when it holds none.
   *
   * Required to be stated. A `SWITCH` plan releases a lease, so executing one
   * without saying which lease is being released is a gap the executor refuses
   * rather than fills: the whole point of the enrichment is that the revocation
   * names a real lease.
   */
  readonly lease: Lease | null;
  /**
   * The state the task is in when the plan is played.
   *
   * Read by the caller from the ledger and passed in, so this module makes one
   * decision — what to append — rather than two.
   */
  readonly taskState: TaskState;
}

export interface SwitchExecutionResult {
  readonly appended: number;
  readonly events: readonly ParsedControlPlaneEvent[];
}

/**
 * Play a switch plan against the ledger.
 *
 * Every event is appended in plan order under a durable transition id derived
 * from its position, so replaying the same plan for the same invocation
 * appends nothing the second time.
 */
export function executeSwitchPlan(input: SwitchExecutionInput): SwitchExecutionResult {
  const { ledger, invocation, plan, emittedBy, lease, taskState } = input;

  const task = ledger.getTask(invocation.taskId);
  if (task === null) {
    throw new SupervisorError(
      "refusing to execute a switch plan for a task the ledger has never seen",
    );
  }

  // A plan that revokes a lease must be given the lease it revokes. Appending
  // the revocation without one would record an enrichment that names nothing,
  // which is worse than the unenriched payload it replaces.
  const revokes = plan.events.some((candidate) => candidate.type === "LEASE_REVOKED");
  if (revokes && lease === null) {
    throw new SupervisorError(
      "refusing to execute a switch plan that revokes a lease without the lease" +
        " it revokes; the revocation would name no worktree and no holder",
    );
  }

  const changes = plan.events.filter((candidate) => candidate.type === "TASK_STATE_CHANGED");
  if (changes.length > 0 && plan.taskState === null) {
    throw new SupervisorError(
      "refusing to execute a switch plan whose events change the task state" +
        " while the plan names no state to change it to",
    );
  }

  const appended: ParsedControlPlaneEvent[] = [];
  let inserted = 0;

  // The state walks with the plan. Every account-side fact is a same-state
  // passthrough, but the plan's own `TASK_STATE_CHANGED` is a real transition
  // -- the contract refuses a state-change event that changes nothing -- so
  // the events after it are passthroughs at the NEW state, exactly as the P7B
  // pilot drilled the chain by hand.
  let state: TaskState = taskState;

  for (const [index, candidate] of plan.events.entries()) {
    const transitionId = "switch." + String(index) + "." + candidate.type.toLowerCase();
    const coordinate = deriveEventCoordinate(invocation, transitionId, index);

    const fromState = state;
    const toState =
      candidate.type === "TASK_STATE_CHANGED" && plan.taskState !== null
        ? plan.taskState
        : state;

    const event = ControlPlaneEvent.parse({
      contractVersion: CONTRACT_VERSION,
      eventId: coordinate.eventId,
      taskId: invocation.taskId,
      attempt: invocation.attempt,
      transitionId,
      idempotencyKey: coordinate.idempotencyKey,
      type: candidate.type,
      fromState,
      toState,
      emittedBy,
      occurredAt: coordinate.occurredAt,
      recordedAt: coordinate.recordedAt,
      correlationId: null,
      causationId: null,
      payload: payloadFor(candidate.type, candidate.payload, lease),
    });

    const result = ledger.append(event);
    if (result.inserted) inserted += 1;
    appended.push(result.record.event);
    state = toState;
  }

  return { appended: inserted, events: appended };
}

/**
 * The payload to append for one candidate.
 *
 * Verbatim for every type but one. `LEASE_REVOKED` is enriched with the lease
 * the packet holds, which is the P7B forward-carry closing: the module's
 * `accountId` is kept, and the enforcement plane's four fields are added
 * beside it, so one event now satisfies both readers.
 */
function payloadFor(
  type: ControlPlaneEventType,
  payload: Readonly<Record<string, string>>,
  lease: Lease | null,
): Record<string, string> {
  if (type !== "LEASE_REVOKED" || lease === null) return { ...payload };

  return {
    ...payload,
    leaseId: lease.leaseId,
    worktreePath: lease.worktreePath,
    holder: lease.holder,
    cause: "ACCOUNT_SWITCH",
  };
}
