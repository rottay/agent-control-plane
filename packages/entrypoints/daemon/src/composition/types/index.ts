/**
 * The composition context types of the Agent Control Plane daemon (P-13,
 * escalón 2, DT adjudication V11.2).
 *
 * The two inputs the single walk construction takes. They were declared beside
 * the builders in `../walk/index.ts` when the escalón-2 collapse landed; they
 * live here because they are the contract BETWEEN the composition root and the
 * walk module rather than an internal of either — the root fills them at its
 * two call sites and the walk module reads them, so a reader following "what
 * does a walk need" arrives at one leaf instead of at a builder's signature.
 *
 * A pure type leaf: it declares data and nothing else, imports only types, and
 * carries no behaviour to mirror — the same shape, and the same absence of a
 * test mirror, as `packages/persistence/ledger/src/types/index.ts`. The
 * topology law bounds where tests may live, and does not require a suite for a
 * file with no conduct to drill.
 *
 * Nothing was renamed and no field changed: this is the same declaration,
 * moved.
 */

import type { ModelExecutionPort, ResolvedRoute, TaskEnvelope } from "@acp/contracts";
import type { Ledger } from "@acp/ledger";
import type { DurableInvocation, ScenarioRoot } from "@acp/runtime";

import type { LeaseHold } from "../../arbiter/index.js";
import type { DaemonExecutionConfig } from "../../daemon-child/index.js";

/**
 * The dependencies one walk's execution effects close over, named.
 *
 * Every field is a value the caller already holds at its call site: the port
 * and the final route, the ledger and invocation the observations are
 * recorded against, the coordinates and identity the execution is attributed
 * to, the scenario root the evidence markers live under, the landing
 * generation that leads the usage rows' durable names, and the conformance
 * gate the walk asks before it marks an operation done. Nothing is optional:
 * the optionality on `ExecutionEffectsInput` exists for the two drill
 * children, and the fence laws (`L-B7T-2`, `L-V2B1F4-3`, `L-C-4c`) are what
 * assert this production site passes all three sinks — a builder that made
 * one optional would move that defect from a checked law to an unchecked
 * default.
 */
export interface WalkEffectsInput {
  /** The owned boundary, built by `executionPortFor` at the caller's site. */
  readonly port: ModelExecutionPort;
  /** The final route. Executed, never interpreted, exactly as the port's law says. */
  readonly route: ResolvedRoute;
  /** The ledger this walk's observations are recorded against. */
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly taskId: string;
  readonly attempt: number;
  readonly emittedBy: string;
  /** The instruction the execution carries; the caller produces it with `instructionFor`. */
  readonly instructions: string;
  readonly scenarioRoot: ScenarioRoot;
  /**
   * The landing generation that leads the usage rows' durable names
   * (V2-B1f/F5). Zero for an unlanded walk, uniformly, and never
   * special-cased here.
   */
  readonly generation: number;
  /** The one gate per seam, whoever asks it (V2-B1f/F5). */
  readonly gate: (operationIndex: number) => void;
}

/**
 * The dependencies the ONE SQLite walk composition closes over, named.
 *
 * Both walk forms — the singular `SQLITE_SUPERVISOR` walk and each scheduled
 * walk the scheduler admits — call `runComposedSqliteWalk` with exactly the
 * values their inline literal used to carry. The landing has already answered
 * at the call site: `route`, `generation` and `landed` are its dispatch, and
 * `hold` is the live lease grant the walk runs under.
 */
export interface ComposedSqliteWalkInput {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly execution: DaemonExecutionConfig;
  readonly envelope: TaskEnvelope;
  readonly scenarioRoot: ScenarioRoot;
  readonly worktreePath: string;
  readonly port: ModelExecutionPort;
  readonly route: ResolvedRoute;
  readonly generation: number;
  readonly landed: boolean;
  /** The live grant this walk holds and renews; the switch port closes over it. */
  readonly hold: LeaseHold;
  readonly gate: (operationIndex: number) => void;
  readonly instructions: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly emittedBy: string;
  readonly initiativeId: string;
}
