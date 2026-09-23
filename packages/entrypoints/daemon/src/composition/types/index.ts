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
 * `ComposedInstruction`, what the root's `instructionFor` hands a walk, joined
 * them at P-06/CORR for the same reason (owner law §7).
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
import type { ArtifactPlane, Ledger } from "@acp/ledger";
import type { DurableInvocation, ExecutionChainInput, ScenarioRoot } from "@acp/runtime";

import type { LeaseHold } from "../../arbiter/index.js";
import type { DaemonExecutionConfig } from "../../daemon-child/index.js";
import type { ContentBlockKind } from "@acp/contracts";

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
  /**
   * The classes the instruction was composed from (P-06/C, ADR 0095). Carried, not
   * inspected: the adapter's `describe` is what decides whether a transport can take
   * them, and no block or byte travels with them.
   */
  readonly modalities: readonly ContentBlockKind[];
  readonly scenarioRoot: ScenarioRoot;
  /**
   * The landing generation that leads the usage rows' durable names
   * (V2-B1f/F5). Zero for an unlanded walk, uniformly, and never
   * special-cased here.
   */
  readonly generation: number;
  /** The one gate per seam, whoever asks it (V2-B1f/F5). */
  readonly gate: (operationIndex: number) => void;
  /** The composed instruction's digest and length (P-15 escalón D3): what a prompt occurrence records. */
  readonly promptSha256: string;
  readonly promptBytes: number;
  /**
   * The recorded walk's chain facts (P-15 escalón D3, ADR 0105), or null for an
   * inline walk. Present exactly when the invocation carries a revision: a
   * revision-bearing walk records its chain and never the legacy usage row, and
   * `buildWalkEffects` refuses either half without the other.
   */
  readonly chain: WalkChainFacts | null;
}

/**
 * The one walk a singular daemon runs, whichever form named it (P-15 escalón D3,
 * ADR 0105).
 *
 * The inline form states these; the recorded form reads them back from the
 * operator's ledger, and brings the chain's facts with them. Everything after S3
 * reads the walk from here, so the two forms share every later step.
 */
export interface WalkSubject {
  readonly invocation: DurableInvocation;
  readonly envelope: TaskEnvelope;
  readonly taskId: string;
  readonly attempt: number;
  readonly initiativeId: string;
  readonly chain: WalkChainFacts | null;
}

/**
 * What a recorded walk's chain needs beyond what every walk already carries
 * (P-15 escalón D3, ADR 0105; decision 140).
 *
 * The plane the result is published through, the intake's resolution of the
 * model version and routing assignment, the price catalog the config names, the
 * adapter's usage source, and the process that holds the publication's lease.
 */
export interface WalkChainFacts {
  readonly plane: ArtifactPlane;
  readonly modelVersionId: string;
  readonly routingAssignmentId: string | null;
  readonly catalogDocumentId: string;
  readonly usageSource: ExecutionChainInput["usageSource"];
  readonly holderPid: number;
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
  /**
   * The path the ledger was opened at (P-15 escalón D3): a scenario's for an
   * inline walk, the operator's for a recorded one. The checkpoint store resolves
   * beside it.
   */
  readonly ledgerPath: string;
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
  /**
   * The classes the instruction was composed from (P-06/C, ADR 0095). Carried, not
   * inspected: the adapter's `describe` is what decides whether a transport can take
   * them, and no block or byte travels with them.
   */
  readonly modalities: readonly ContentBlockKind[];
  readonly taskId: string;
  readonly attempt: number;
  readonly emittedBy: string;
  readonly initiativeId: string;
  /** The composed instruction's digest and length (P-15 escalón D3). */
  readonly promptSha256: string;
  readonly promptBytes: number;
  /** The recorded walk's chain facts, or null for an inline walk (P-15 escalón D3). */
  readonly chain: WalkChainFacts | null;
}

/**
 * What the composition produces: the bytes that cross, and the classes they came
 * from (P-06/C, ADR 0095; moved to this leaf by P-06/CORR, ADR 0096).
 */
export interface ComposedInstruction {
  readonly instructions: string;
  readonly modalities: readonly ContentBlockKind[];
  /**
   * The SHA-256 of the composed instruction's UTF-8 bytes, and their length (P-15
   * escalón D3, ADR 0105): what the prompt occurrence records, computed inside the
   * one composer so nothing downstream holds the bytes to hash them. A digest of
   * the instruction, never of a block.
   */
  readonly promptSha256: string;
  readonly promptBytes: number;
}
