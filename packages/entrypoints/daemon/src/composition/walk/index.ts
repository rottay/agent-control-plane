/**
 * The single walk construction of the Agent Control Plane daemon (P-13,
 * escalón 2).
 *
 * Until this packet the daemon built its execution effects twice — once at
 * the singular walk and once per scheduled walk — and composed the SQLite
 * walk at the same two call sites. Both copies now collapse into the two
 * builders here: `buildWalkEffects` is the ONE `createExecutionEffects`
 * construction, with every dependency named as an input instead of closed
 * over a caller's scope, and `runComposedSqliteWalk` is the ONE
 * `runSqliteMode({` literal, built from those effects. The singular form and
 * the scheduled form (V2 concurrency C3) both call here, so "one law, two
 * call sites" becomes one seam, two callers — and the two construction sites
 * the spend, pressure, switch and conformance laws each had to read become
 * the one site each law reads.
 *
 * The collapse is behaviourally equivalent by construction: the closures
 * moved verbatim, and the values they closed over are now the inputs the two
 * callers passed at those exact sites. No symbol was renamed and no
 * behaviour changed.
 *
 * The two input shapes themselves live in `../types/index.ts` (DT
 * adjudication V11.2): they are the contract between the composition root and
 * this module, so both sides read them from one leaf rather than one side
 * reading the other's signature.
 */

import type { EffectPort } from "@acp/runtime";
import {
  createExecutionEffects,
  pressureTransitionId,
  recordProviderPressure,
  recordTokenObservation,
  scenarioLedgerPath,
  usageTransitionId,
} from "@acp/runtime";

import type { SqliteModeResult } from "../../mode-sqlite/index.js";
import { runSqliteMode } from "../../mode-sqlite/index.js";
import { checkpointsFor, switchPortFor } from "../ports/index.js";
import type { ComposedSqliteWalkInput, WalkEffectsInput } from "../types/index.js";

/**
 * Build the execution effects for one walk (V2-B7T, V2-B1f, V2 concurrency C4).
 *
 * The ONE production `createExecutionEffects` construction. The two closures
 * below moved here verbatim from the two inline sites they used to live at;
 * what they closed over is now `input`, field for field, and both callers
 * pass exactly the values their inline copy used.
 */
export function buildWalkEffects(input: WalkEffectsInput): EffectPort {
  return createExecutionEffects({
    port: input.port,
    route: input.route,
    request: {
      taskId: input.taskId,
      attempt: input.attempt,
      identity: input.emittedBy,
      instructions: input.instructions,
      modalities: [...input.modalities],
      reattach: null,
    },
    scenarioRoot: input.scenarioRoot,
    // V2-B7T. The port has always reported what it spent and the walk has
    // always thrown the trail away. This closure is where spend becomes a
    // ledger fact: one `TOKEN_USAGE_RECORDED` per trail `usage` entry, under
    // a name derived from the operation and the step so a resumed attempt
    // replays rather than double-counts.
    //
    // A closure and not a new dependency: `input.ledger`, `input.invocation`,
    // `input.route` and `input.emittedBy` are all already in scope at the
    // call site, so `execution-effects` still imports no ledger and the
    // runtime still owes nothing new to anyone. Attribution is the elected
    // account's, read from the same `route` the port executes — the value the
    // config door already admitted, never a second reading of it.
    recordUsage: (sample) => {
      recordTokenObservation(input.ledger, {
        invocation: input.invocation,
        kind: "USAGE",
        accountId: input.route.accountId,
        tokens: sample.tokensUsed,
        // The landing generation leads the name (V2-B1f/F5). A destination
        // re-executes the same operation at the same step indices, so
        // without it the second walk's first usage row would collide with
        // the first walk's under one idempotency key and the ledger would
        // fail closed. An unlanded walk passes zero, uniformly.
        transitionId: usageTransitionId(input.generation, sample.operationIndex, sample.stepIndex),
        emittedBy: input.emittedBy,
      });
    },
    // V2-B1f. What the provider said about this account, made durable: one
    // row per observed frame, against the account the route elected and the
    // provider the sample carries.
    //
    // `sample.provider`, never `route.provider`. The value resolved in
    // `@acp/runtime` is the adapter's own — the parser that classified the
    // frame — and the resolution belongs there, one layer from the trail
    // that carries it. The daemon spells nothing: this closure receives an
    // already-resolved provider and passes it through, which is why the
    // binding law's second predicate is met by construction here rather
    // than remembered.
    //
    // The transition name is the operation's plan index and the event's own
    // trail position, so a resumed attempt replays instead of appending a
    // second row, and two different frames in one stream stay two rows.
    recordPressure: (sample) => {
      recordProviderPressure(input.ledger, {
        invocation: input.invocation,
        accountId: input.route.accountId,
        provider: sample.provider,
        pressure: sample.pressure,
        transitionId: pressureTransitionId(sample.operationIndex, sample.trailIndex),
        emittedBy: input.emittedBy,
      });
    },
    // V2 concurrency C4, DT Option B. Both walk forms are gated exactly the
    // same way: same builder, same five steps, each form's own envelope's
    // declared write-set. A production path without this is the bypass the
    // ruling forbids.
    //
    // The same closure the landing already called, not a second one: one
    // gate per seam, whoever asks it (V2-B1f/F5).
    checkConformance: input.gate,
  });
}

/**
 * Compose and run one SQLite walk (V2-B1b stage 2, V2-B1c, V2-B1f/F3,
 * V2-B1f/F4d, V2 concurrency C3).
 *
 * The ONE `runSqliteMode({` literal in the daemon. The effects are built by
 * `buildWalkEffects` above; the checkpoint port composes this walk's ledger,
 * envelope and admitted worktree; the switch port — when the config admitted
 * an authorization and this attempt has not landed — closes over the lease
 * this process actually holds. The commit policy is the explicit
 * `LOCAL_COMMIT_WITH_RECEIPT` both inline sites used to state, said once, in
 * one place a reader can find.
 */
export async function runComposedSqliteWalk(input: ComposedSqliteWalkInput): Promise<SqliteModeResult> {
  const effects = buildWalkEffects({
    port: input.port,
    route: input.route,
    ledger: input.ledger,
    invocation: input.invocation,
    taskId: input.taskId,
    attempt: input.attempt,
    emittedBy: input.emittedBy,
    instructions: input.instructions,
    modalities: [...input.modalities],
    scenarioRoot: input.scenarioRoot,
    generation: input.generation,
    gate: input.gate,
  });

  // V2-B1f/F3. A factory per invocation, not one port: the SQLite leg walks
  // exactly this invocation, and the worktree is the leased one the
  // conformance gate observes, so the source is built where the invocation is
  // known. The store resolves under the ledger this daemon opened.
  return runSqliteMode({
    ledger: input.ledger,
    invocation: input.invocation,
    effects,
    checkpoints: checkpointsFor({
      ledger: input.ledger,
      ledgerPath: scenarioLedgerPath(input.scenarioRoot),
      invocation: input.invocation,
      emittedBy: input.emittedBy,
      envelope: input.envelope,
      worktreePath: input.worktreePath,
    }),
    switchPort: switchPortFor({
      execution: input.execution,
      ledger: input.ledger,
      lease: input.hold.lease,
      landed: input.landed,
    }),
    emittedBy: input.emittedBy,
    // Today's behaviour, said out loud. The daemon supervises packets that
    // may commit locally under a receipt; a read-only packet is a policy
    // this process has never been asked to run, and when it is, the policy
    // will arrive with the packet rather than be assumed here.
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    initiativeId: input.initiativeId,
    route: input.route,
  });
}
