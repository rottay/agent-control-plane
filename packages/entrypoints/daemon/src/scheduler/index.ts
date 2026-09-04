import type { TaskEnvelope } from "@acp/contracts";
import { checkAdmission } from "@acp/runtime";

import type { DaemonExecutionConfig } from "../daemon-child/index.js";

/**
 * Many walks, one plane — V2 concurrency C3.
 *
 * C1 built the arbitration store, C2 made one daemon hold one fenced lease.
 * This is the packet that lets one daemon hold several, and the whole of its
 * difficulty is in *which order the two gates are asked*.
 *
 * ## Two gates, one order
 *
 * A walk needs two independent permissions and they answer different questions:
 *
 * - the **conflict graph** decides whether this packet's envelope is compatible
 *   with the ones already admitted — write-sets, authority, conflict keys;
 * - the **lease** decides whether anybody else holds the worktree it writes in.
 *
 * `conflict-graph/index.ts` stated the order before anything implemented it:
 * *"the graph first, then acquire, then write"*. This module is that sentence.
 * The order is not a preference — a lease taken before the graph refuses is a
 * worktree claimed for a walk that will never run, and on a refusal the arbiter
 * is therefore **never called at all**, which `L-C-3a` pins and the suite
 * asserts by call count rather than by reading this paragraph.
 *
 * ## Refusals are returned, never queued
 *
 * There is no retry loop, no backpressure and no waiting room. A refused walk
 * comes back as a typed outcome naming its reason and the field the reason is
 * about. A scheduler that quietly waits is one whose refusals nobody sees, and
 * the operator learns about the conflict from a stall instead of a sentence.
 *
 * The concurrency cap is a **constant** and not an option
 * ({@link WALK_CONCURRENCY_MAX}). A caller able to set it to one could make
 * every concurrency drill in this repository vacuous while leaving each of them
 * green.
 *
 * ## Admission is sequential, execution is concurrent
 *
 * Every walk is admitted against the walks already admitted, one at a time, so
 * two candidates that conflict with each other cannot both pass by being asked
 * simultaneously. Only then do the admitted walks run, up to the cap.
 */

/**
 * How many walks may be in flight at once.
 *
 * Bounded because each walk owns a provider child, a ledger handle and a lease;
 * unbounded concurrency here is unbounded processes and file handles. Four
 * matches the cross-process drills this repository already runs.
 */
export const WALK_CONCURRENCY_MAX = 4;

/** Everything one walk needs that is not its envelope or its worktree. */
export interface WalkSpec {
  readonly scenarioId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly submittedAt: string;
  readonly submissionDigest: string;
  readonly initiativeId: string;
  readonly emittedBy: string;
  readonly execution: DaemonExecutionConfig;
}

export interface ScheduledWalk {
  /** The graph's input. Supplied per walk; never invented, defaulted or derived. */
  readonly envelope: TaskEnvelope;
  /** `execution.binding.workdir`, the worktree this walk writes into. */
  readonly worktreePath: string;
  readonly spec: WalkSpec;
}

/** What the lease gate answered. */
export interface WalkLease {
  readonly ok: boolean;
  readonly reason: string;
  readonly at: string;
}

export type WalkRefusal = "CONFLICT" | "LEASE_REFUSED" | "FAILED";

export type WalkOutcome =
  | { readonly ok: true; readonly taskId: string; readonly finalState: string }
  | {
      readonly ok: false;
      readonly taskId: string;
      readonly refusal: WalkRefusal;
      readonly reason: string;
      readonly at: string;
    };

/**
 * Everything this module reaches the world through.
 *
 * No clock, no filesystem, no spawn and no ledger of its own: the scheduler
 * decides an order and nothing else, so every one of these is injected and the
 * suite can observe each call.
 */
export interface SchedulerPorts {
  /** Take the worktree lease. Never called for a walk the graph refused. */
  readonly acquire: (walk: ScheduledWalk) => Promise<WalkLease>;
  /** Run the walk to a terminal state, or reject. */
  readonly run: (walk: ScheduledWalk) => Promise<string>;
  /** Give the lease back. Called exactly once per walk that acquired one. */
  readonly release: (walk: ScheduledWalk, cause: string) => void;
}

export interface Admission {
  /** The walks that passed both gates, in submission order. */
  readonly admitted: readonly ScheduledWalk[];
  /** Submission index of each admitted walk, parallel to {@link admitted}. */
  readonly admittedAt: readonly number[];
  /** One outcome per walk the graph or the lease refused. */
  readonly refused: readonly WalkOutcome[];
  /** Submission index of each refusal, parallel to {@link refused}. */
  readonly refusedAt: readonly number[];
}

function classify(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}

/**
 * The graph, then the lease — in that order, for every walk.
 *
 * Sequential on purpose. Admitting concurrently would ask the graph about a set
 * that does not yet contain the other candidate, and two mutually conflicting
 * walks would both be told yes.
 */
export async function admitWalks(
  walks: readonly ScheduledWalk[],
  ports: SchedulerPorts,
): Promise<Admission> {
  const admitted: ScheduledWalk[] = [];
  const admittedAt: number[] = [];
  const refused: WalkOutcome[] = [];
  // Positional throughout. Outcomes keyed by `taskId` would collapse two walks
  // that carry the same one -- which the door refuses, but a scheduler that
  // depends on the door for its own correctness is one gate pretending to be
  // two.
  const refusedAt: number[] = [];

  for (const [index, walk] of walks.entries()) {
    // Gate one. The verdict's own `compatible` flag is read rather than an
    // empty `pairs` list inferred from: the flag is also false when the
    // *admitted set itself* carries a duplicate id, which is fail-closed and
    // exactly the case an empty-list inference would wave through.
    const verdict = checkAdmission({
      admitted: admitted.map((entry) => entry.envelope),
      candidate: walk.envelope,
    });
    if (!verdict.ok) {
      refused.push({
        ok: false,
        taskId: walk.spec.taskId,
        refusal: "CONFLICT",
        reason: verdict.reason,
        at: verdict.at,
      });
      refusedAt.push(index);
      continue;
    }
    if (!verdict.compatible) {
      const pair = verdict.pairs[0];
      const duplicate = verdict.duplicateTaskIds[0];
      refused.push({
        ok: false,
        taskId: walk.spec.taskId,
        refusal: "CONFLICT",
        // The kind and the pair the verdict itself carries, never a sentence
        // invented here and never an echoed path.
        reason:
          pair !== undefined
            ? pair.kinds.join(",")
            : duplicate !== undefined
              ? "DUPLICATE_TASK_ID"
              : "INCOMPATIBLE",
        at:
          pair !== undefined
            ? "walk.envelope[" + pair.taskIdA + "," + pair.taskIdB + "]"
            : "walk.envelope.taskId",
      });
      refusedAt.push(index);
      continue;
    }

    // Gate two, and only now. A lease taken before the graph refused would
    // claim a worktree for a walk that never runs.
    const lease = await ports.acquire(walk);
    if (!lease.ok) {
      refused.push({
        ok: false,
        taskId: walk.spec.taskId,
        refusal: "LEASE_REFUSED",
        reason: lease.reason,
        at: lease.at,
      });
      refusedAt.push(index);
      continue;
    }
    admitted.push(walk);
    admittedAt.push(index);
  }

  return { admitted, admittedAt, refused, refusedAt };
}

/**
 * Run the admitted walks, at most {@link WALK_CONCURRENCY_MAX} at a time.
 *
 * One walk's failure is that walk's outcome and nobody else's: the pool keeps
 * going and every lease is given back, including the failed walk's, so a wedged
 * packet never strands a worktree.
 */
export async function runAdmitted(
  admitted: readonly ScheduledWalk[],
  ports: SchedulerPorts,
  cap: number = WALK_CONCURRENCY_MAX,
): Promise<readonly WalkOutcome[]> {
  const outcomes: (WalkOutcome | null)[] = admitted.map(() => null);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const walk = admitted[index];
      if (walk === undefined) return;
      try {
        const finalState = await ports.run(walk);
        outcomes[index] = { ok: true, taskId: walk.spec.taskId, finalState };
        ports.release(walk, "RELEASED");
      } catch (error: unknown) {
        outcomes[index] = {
          ok: false,
          taskId: walk.spec.taskId,
          refusal: "FAILED",
          reason: classify(error),
          at: "walk.run",
        };
        // The lease goes back even when the walk did not finish. A worktree
        // held by a dead walk is exactly the stall the lease exists to avoid.
        ports.release(walk, "FAILED");
      }
    }
  };

  const width = Math.max(1, Math.min(cap, admitted.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return admitted.map(
    (walk, index) =>
      outcomes[index] ?? {
        ok: false,
        taskId: walk.spec.taskId,
        refusal: "FAILED",
        reason: "NO_OUTCOME",
        at: "walk.run",
      },
  );
}

/**
 * Admit, then run. One classified outcome per submitted walk, in order.
 */
export async function runScheduledWalks(
  walks: readonly ScheduledWalk[],
  ports: SchedulerPorts,
  cap: number = WALK_CONCURRENCY_MAX,
): Promise<readonly WalkOutcome[]> {
  const admission = await admitWalks(walks, ports);
  const ran = await runAdmitted(admission.admitted, ports, cap);
  const byIndex: (WalkOutcome | null)[] = walks.map(() => null);
  admission.refusedAt.forEach((at, position) => {
    byIndex[at] = admission.refused[position] ?? null;
  });
  admission.admittedAt.forEach((at, position) => {
    byIndex[at] = ran[position] ?? null;
  });
  return walks.map(
    (walk, index) =>
      byIndex[index] ?? {
        ok: false,
        taskId: walk.spec.taskId,
        refusal: "FAILED",
        reason: "NO_OUTCOME",
        at: "walk",
      },
  );
}
