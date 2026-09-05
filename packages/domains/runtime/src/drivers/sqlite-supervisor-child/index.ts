import { appendFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_VERSION, CommitPolicy, ResolvedRoute, buildIdempotencyKey } from "@acp/contracts";
import type {
  Checkpoint,
  ExecutionEvent,
  ExecutionRequest,
  ModelExecutionPort,
} from "@acp/contracts";
import { createCheckpointStore, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";

import type { CheckpointRefused, CheckpointSource } from "../../checkpoint/index.js";
import type { DurableInvocation } from "../../contracts/index.js";
import { deriveEventCoordinate, deterministicUuid } from "../../core/coordinates/index.js";
import { OUTCOME_STEP } from "../../core/lifecycle/index.js";
import type { PlanStep } from "../../core/lifecycle/index.js";
import { SupervisorError } from "../../errors/index.js";
import {
  applyEffect,
  probeEffect,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../toy/repository/index.js";
// The scenario-root brand, type-only: erased at compile time, so this adds no
// runtime edge and the toy-binding law counts the specifier above, not this.
import type { ScenarioRoot } from "../../toy/repository/index.js";
import { createExecutionEffects } from "../../execution-effects/index.js";
import { SqliteSupervisor } from "../sqlite-supervisor/index.js";
import type { FaultPoint } from "../sqlite-supervisor/index.js";

/**
 * The child entry point for the kill/restart drills.
 *
 * A restart drill is only evidence if the process actually dies. A thrown
 * exception caught by the same process proves nothing about durability: the
 * SQLite page cache, the open handle and every JavaScript object survive it.
 * So the drill runs the supervisor here, in a real child, and kills it with a
 * real signal at a chosen instant.
 *
 * Importing this module does nothing. It runs only when it is the process entry
 * point, and only on a config it has validated itself.
 */

const FAULT_POINTS: readonly string[] = ["AFTER_INTENT", "AFTER_EFFECT", "AFTER_OUTCOME"];

/** The digest pins what was asked for, so its shape is checked at the door. */
/**
 * The instruction the drill child asks for (V2-B1c).
 *
 * A module-level constant rather than a config field, and deterministic on
 * purpose: the drills compare ledgers across runs byte for byte, so an
 * instruction that varied would move a head digest for a reason that has
 * nothing to do with what a drill is proving. This child's config carries no
 * envelope and no objective, so there is nothing here to read one from.
 *
 * It is a second producer of an `ExecutionRequest` instruction in everything
 * but name, which is why `L-B1C-1` names this file explicitly as a drill-only
 * exception and asserts that the value is a module-level constant, is
 * deterministic, and reads no envelope. An unnamed third producer fails the law.
 */
const DRILL_INSTRUCTION = "walk the drill plan and record what happened";

const SHA256_HEX = /^[0-9a-f]{64}$/;

interface ChildConfig {
  readonly scenarioId: string;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /** The packet's commit policy. Required in the JSON, never defaulted here. */
  readonly commitPolicy: CommitPolicy;
  /** The packet's initiative. Required in the JSON, never defaulted here. */
  readonly initiativeId: string;
  readonly faultPoint: FaultPoint | null;
  /**
   * Which effect this walk performs (V2-B2-2).
   *
   * `TOY` is the historical binding and stays the default: the drills that
   * predate this packet spawn this child without saying, and changing what
   * they mean from outside their own files would re-anchor them rather than
   * re-prove anything.
   *
   * `EXECUTION` drives the real `createExecutionEffects` — an awaited drain to
   * a terminal event, digest-keyed evidence under the scenario's own
   * `executions/` directory, and the three-verdict probe. That is the path
   * recovery has to be re-proved over: the toy's completion is observable the
   * instant `apply` returns, and a real effect's is not, so a certificate
   * earned over the toy says nothing about a restart that lands between the
   * effect and its outcome.
   */
  readonly effect: "TOY" | "EXECUTION";
  /**
   * What the SPAWNING SUITE observed about this scenario's worktree (V2-B1f/F3).
   *
   * **Facts, as data.** This child creates no `GitReadPort` and executes no
   * git: `RUNTIME_ALLOWED_BUILTINS` is crypto, fs, path and url, so it could
   * not spawn one, and giving a drill child an observer would put a second
   * production-shaped git caller in a package whose whole enforcement story is
   * that it observes nothing itself. The suite has a real repository
   * (`initToyRepository`), observes it with its own `spawnGit`, and passes what
   * it saw.
   *
   * **Absent means absent, not empty.** A config without this field yields no
   * checkpoint port, and the terminal beat refuses exactly as production does
   * when its observation cannot be taken. Inventing a head here would put a
   * fiction in a drill ledger, which is the one thing a drill may never do.
   */
  readonly checkpointFacts: CheckpointFacts | null;
}

/** The four git facts a checkpoint carries, observed by the spawning suite. */
interface CheckpointFacts {
  readonly worktreePath: string;
  readonly head: string;
  readonly branch: string;
  readonly isDirty: boolean;
}

/**
 * Validate the child's configuration.
 *
 * Every field that reaches an event is checked here. Nothing is read from the
 * environment: an environment variable is mutable state, and mutable state that
 * reaches event bytes is exactly what breaks replay determinism.
 */
export function parseChildConfig(raw: unknown): ChildConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new SupervisorError("child config must be an object");
  }
  const value = raw as Record<string, unknown>;
  const invocation = value["invocation"];
  if (typeof invocation !== "object" || invocation === null) {
    throw new SupervisorError("child config requires an invocation");
  }
  const inv = invocation as Record<string, unknown>;

  const scenarioId = value["scenarioId"];
  const emittedBy = value["emittedBy"];
  // Admitted by the contract's own enum, like every other field that reaches an
  // event: a child that did not say which policy it runs under is refused
  // rather than handed the commit-capable plan.
  const commitPolicy = CommitPolicy.safeParse(value["commitPolicy"]);
  if (!commitPolicy.success) {
    throw new SupervisorError("child config requires an explicit commitPolicy");
  }
  // The same law as the policy above: a child that did not say which
  // initiative it runs under is refused rather than handed a default, because
  // the value reaches the discovery event's payload and a wrong attribution
  // cannot be corrected by any later event.
  const initiativeId = value["initiativeId"];
  if (typeof initiativeId !== "string" || initiativeId.length === 0) {
    throw new SupervisorError("child config requires an explicit initiativeId");
  }

  const rawFaultPoint = value["faultPoint"] ?? null;
  const faultPoint = typeof rawFaultPoint === "string" ? rawFaultPoint : null;
  if (rawFaultPoint !== null && faultPoint === null) {
    throw new SupervisorError("faultPoint must be null or a string");
  }

  if (typeof scenarioId !== "string") throw new SupervisorError("scenarioId must be a string");
  if (typeof emittedBy !== "string") throw new SupervisorError("emittedBy must be a string");
  if (faultPoint !== null && !FAULT_POINTS.includes(faultPoint)) {
    throw new SupervisorError("faultPoint must be null or a known fault point");
  }

  // V2-B2-2. Absence means TOY: the drills that predate this packet spawn this
  // child without saying which effect they want, and changing their meaning
  // from outside their own files would re-anchor them rather than re-prove
  // anything. A value that is neither is refused rather than coerced.
  const effect = value["effect"] ?? "TOY";
  if (effect !== "TOY" && effect !== "EXECUTION") {
    throw new SupervisorError("effect must be TOY or EXECUTION");
  }

  // V2-B1f/F3. Absent is lawful and means no checkpoint port; present is
  // checked field by field, exactly like the invocation below, because every
  // one of these values reaches a persisted artifact.
  const rawFacts = value["checkpointFacts"] ?? null;
  let checkpointFacts: CheckpointFacts | null = null;
  if (rawFacts !== null) {
    if (typeof rawFacts !== "object") {
      throw new SupervisorError("checkpointFacts must be null or an object");
    }
    const facts = rawFacts as Record<string, unknown>;
    const worktreePath = facts["worktreePath"];
    const head = facts["head"];
    const branch = facts["branch"];
    const isDirty = facts["isDirty"];
    if (
      typeof worktreePath !== "string" ||
      typeof head !== "string" ||
      typeof branch !== "string" ||
      typeof isDirty !== "boolean"
    ) {
      throw new SupervisorError("child config carries malformed checkpointFacts");
    }
    checkpointFacts = { worktreePath, head, branch, isDirty };
  }

  const taskId = inv["taskId"];
  const attempt = inv["attempt"];
  const invocationId = inv["invocationId"];
  const submittedAt = inv["submittedAt"];
  const submissionDigest = inv["submissionDigest"];

  if (
    typeof taskId !== "string" ||
    typeof invocationId !== "string" ||
    typeof submittedAt !== "string" ||
    typeof submissionDigest !== "string" ||
    typeof attempt !== "number" ||
    !Number.isInteger(attempt) ||
    attempt < 1
  ) {
    throw new SupervisorError("child config carries a malformed invocation");
  }
  if (!SHA256_HEX.test(submissionDigest)) {
    throw new SupervisorError("submissionDigest must be 64 lowercase hex characters");
  }

  return {
    scenarioId,
    emittedBy,
    commitPolicy: commitPolicy.data,
    initiativeId,
    faultPoint: faultPoint as FaultPoint | null,
    effect,
    checkpointFacts,
    invocation: { taskId, attempt, invocationId, submittedAt, submissionDigest },
  };
}

/**
 * The one next safe action a terminal ever names (V2-B1f/F3, §2.4).
 *
 * A module constant, never composed and never varied. It is declared here and,
 * identically, in `restate-child` and in the daemon's production source, for
 * the reason `DRILL_INSTRUCTION` and `EXECUTION_STARTS` are declared twice:
 * unifying it would mean widening the runtime barrel, and the barrel's names
 * are pinned by equality. The tests quote the literal verbatim rather than
 * importing it, so a drift in any one of the three fails rather than
 * propagating.
 */
const NEXT_SAFE_ACTION = "Await the next owner-authorized action.";

/**
 * Assemble a drill-labelled checkpoint from facts this process was handed.
 *
 * Every field still comes from something real: the coordinates this child
 * derived, the events it already appended, and the worktree its suite actually
 * observed. What it does NOT do is observe anything itself — that is the
 * difference between this and the daemon's production source, and it is the
 * whole reason the facts travel as config.
 *
 * The digest arrays are `[]` because this child's config carries no envelope,
 * so there is no authority, read-set or write-set it could truthfully digest.
 * An empty array is the honest answer; a fabricated one would be a fiction in a
 * drill ledger.
 */
function drillCheckpointSource(input: {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  readonly facts: CheckpointFacts;
}): CheckpointSource {
  return {
    assemble(step: PlanStep): Checkpoint | CheckpointRefused {
      // The last OUTCOME append, read from the ledger rather than remembered:
      // both plans pass through it, and its own `occurredAt` is when the last
      // atomic step actually completed.
      const recorded = input.ledger.getEventByIdempotencyKey(
        buildIdempotencyKey({
          taskId: input.invocation.taskId,
          attempt: input.invocation.attempt,
          transitionId: OUTCOME_STEP.transitionId,
        }),
      );
      if (recorded === null) {
        return { ok: false, reason: "CHECKPOINT_INVALID", at: "lastAtomicStep" };
      }
      const parsed: unknown = JSON.parse(recorded.canonicalJson);
      const completedAt =
        typeof parsed === "object" && parsed !== null && "occurredAt" in parsed
          ? (parsed as { readonly occurredAt: unknown }).occurredAt
          : undefined;
      if (typeof completedAt !== "string") {
        return { ok: false, reason: "CHECKPOINT_INVALID", at: "lastAtomicStep.completedAt" };
      }

      const coordinate = deriveEventCoordinate(input.invocation, step.transitionId, step.index);
      return {
        contractVersion: CONTRACT_VERSION,
        checkpointId: deterministicUuid(
          "checkpoint/" +
            input.invocation.invocationId +
            "/" +
            input.invocation.taskId +
            "/" +
            String(input.invocation.attempt) +
            "/" +
            step.transitionId,
        ),
        taskId: input.invocation.taskId,
        attempt: input.invocation.attempt,
        worker: input.emittedBy,
        createdAt: coordinate.occurredAt,
        lastAtomicStep: {
          index: OUTCOME_STEP.index,
          label: OUTCOME_STEP.transitionId,
          completedAt,
        },
        git: {
          head: input.facts.head,
          branch: input.facts.branch,
          worktreePath: input.facts.worktreePath,
          isDirty: input.facts.isDirty,
        },
        authorityDigest: [],
        readSetDigest: [],
        writeSetDigest: [],
        receipts: [],
        artifacts: [],
        pendingWork: [],
        nextSafeAction: NEXT_SAFE_ACTION,
        notes: null,
      };
    },
  };
}

/**
 * The route a toy-bound walk records (V2-B1c).
 *
 * A drill child binds the toy effect, so there is no admitted production route
 * here and inventing one that looked like a production route would put a
 * fiction in a drill ledger. What the walk records instead is what it truly
 * is: a locally-hosted toy effect, on no account and under no capability
 * policy. It is declared beside the toy binding rather than accepted from the
 * config for the same reason the toy binding itself is not configurable — this
 * file is one of the two the fence names as lawful toy binders, and a route
 * that arrived from a caller could arrive at a production seam too.
 *
 * The instant is the invocation's own `submittedAt`, never a clock read: a
 * value that reaches a ledger event may not depend on when the code ran. The
 * composition is parsed through the contract, so this is not a second, laxer
 * admission point — a malformed drill route refuses here exactly as a
 * malformed production route refuses at the daemon's door.
 */
function drillRoute(invocation: DurableInvocation): ResolvedRoute {
  return ResolvedRoute.parse({
    provider: "toy",
    model: "toy-effect",
    accountId: "drill",
    transportKind: "LOCAL_OR_SELF_HOSTED",
    capabilityPolicyVersion: "drill",
    resolvedAt: invocation.submittedAt,
  });
}

/**
 * The route an execution-backed drill walk records (V2-B2-2).
 *
 * Distinct from `drillRoute` and deliberately so: this walk really does drain a
 * `ModelExecutionPort` to a terminal event and write digest-keyed evidence, so
 * recording it as the toy would understate what happened. The subject is a
 * scripted local one — no provider, no account, no capability policy — and the
 * route says exactly that.
 */
/** Where the scripted port records each start, for a later process to count. */
// Module-local in both drill children rather than exported from one and
// imported by the other: unifying it would mean widening the runtime barrel,
// which is outside this packet's write-set. The name is a filename the drills
// read back, not a contract.
const EXECUTION_STARTS = "execution-starts.log";

function executionDrillRoute(invocation: DurableInvocation): ResolvedRoute {
  return ResolvedRoute.parse({
    provider: "drill",
    model: "scripted-execution",
    accountId: "drill",
    transportKind: "LOCAL_OR_SELF_HOSTED",
    capabilityPolicyVersion: "drill",
    resolvedAt: invocation.submittedAt,
  });
}

/**
 * A scripted execution, standing in for a provider the runtime may not import.
 *
 * `packages/domains/runtime` may name accounts, contracts and the ledger and
 * nothing else, so a real adapter cannot be reached from here and must not be:
 * the dependency direction is the law, not a convenience. What this stands in
 * for is the *subject*, not the mechanism — the port is driven, the events are
 * real `ExecutionEvent` values, and everything after the port is the production
 * module. The daemon's own execution drill is where a real adapter over a
 * scripted peer is exercised; what this child exists to prove is recovery, and
 * recovery is a property of the effect module and the ledger, not of the
 * provider on the other side of the port.
 *
 * The trail is fixed rather than generated, so two runs of the same drill
 * produce the same evidence digest and a restart is comparing like with like.
 */
function scriptedPort(route: ResolvedRoute, scenarioRoot: ScenarioRoot): ModelExecutionPort {
  return {
    start(candidate: ResolvedRoute, request: ExecutionRequest) {
      // One line per start, appended where a later process can read it. This is
      // what makes "the effect did not run a second time" an observation rather
      // than an inference: the restart is a different process, so an in-memory
      // counter could not survive to be asked.
      appendFileSync(join(scenarioRoot, EXECUTION_STARTS), request.taskId + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      const trail: ExecutionEvent[] = [
        { kind: "started", route: candidate, resolvedModel: "scripted-execution", protocolVersion: "drill-1" },
        { kind: "usage", stepIndex: 0, tokensUsed: 1 },
        { kind: "state", toState: "TURN_COMPLETED" },
        { kind: "completed", stepIndex: 0 },
      ];
      return Promise.resolve({
        ok: true as const,
        sessionId: request.taskId + "/" + String(request.attempt),
        route: candidate,
        events: (): AsyncIterable<ExecutionEvent> => ({
          async *[Symbol.asyncIterator]() {
            for (const event of trail) {
              // Yield across a turn of the loop so the drain is genuinely
              // asynchronous. A synchronous stream would let `apply` settle
              // within one tick, which is precisely the toy's shape and would
              // make an AFTER_EFFECT kill prove nothing new.
              await Promise.resolve();
              yield event;
            }
          },
        }),
      });
    },
    interrupt: () => Promise.resolve(),
    healthProbe: () =>
      Promise.resolve({
        status: "OK" as const,
        checkedAt: route.resolvedAt,
        latencyMs: null,
        classifiedError: null,
      }),
  };
}

/** Run one supervisor pass, optionally killing this process at a fault point. */
export async function runChild(config: ChildConfig): Promise<void> {
  const scenarioRoot = resolveScenarioRoot(config.scenarioId);
  const ledger = openLedger(scenarioLedgerPath(scenarioRoot));

  try {
    const supervisor = new SqliteSupervisor({
      ledger,
      invocation: config.invocation,
      // The toy port, bound explicitly and here only (V2-B1b, stage 2). A drill
      // child is not a production seam: the kill/restart drills prove the
      // ledger's recovery law over an effect whose completion is trivially
      // observable, and B2 re-proves them against the real one. The fence's
      // toy-binding law names this file as one of the two lawful deep importers.
      effects:
        config.effect === "EXECUTION"
          ? createExecutionEffects({
              port: scriptedPort(executionDrillRoute(config.invocation), scenarioRoot),
              route: executionDrillRoute(config.invocation),
              request: {
                taskId: config.invocation.taskId,
                attempt: config.invocation.attempt,
                identity: config.emittedBy,
                instructions: DRILL_INSTRUCTION,
                reattach: null,
              },
              scenarioRoot,
            })
          : {
              apply: (operation) => {
                applyEffect(scenarioRoot, operation);
                return Promise.resolve();
              },
              probe: (operation) => Promise.resolve(probeEffect(scenarioRoot, operation)),
            },
      emittedBy: config.emittedBy,
      commitPolicy: config.commitPolicy,
      initiativeId: config.initiativeId,
      route:
        config.effect === "EXECUTION"
          ? executionDrillRoute(config.invocation)
          : drillRoute(config.invocation),
      // V2-B1f/F3. Composed here, from a source over the facts the suite
      // observed and the store the ledger this child already opened resolves.
      // No facts, no member, and the terminal refuses -- as production does.
      checkpoints:
        config.checkpointFacts === null
          ? undefined
          : createCheckpointStore({
              ledgerPath: scenarioLedgerPath(scenarioRoot),
              source: drillCheckpointSource({
                ledger,
                invocation: config.invocation,
                emittedBy: config.emittedBy,
                facts: config.checkpointFacts,
              }),
            }),
      __faultPoint: config.faultPoint ?? undefined,
      // A real signal, not an exception. SIGKILL cannot be caught, so nothing
      // in this process gets a chance to flush, close or tidy up, which is the
      // only honest simulation of a machine losing power mid-step.
      __onFault: () => {
        process.kill(process.pid, "SIGKILL");
      },
    });

    // Awaited before it is written: the line the drill reads is the run's
    // resolved result, never a promise's stringification.
    const result = await supervisor.runToCheckpoint();
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    ledger.close();
  }
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url))
) {
  const raw = process.argv[2];
  if (raw === undefined) {
    process.stderr.write("acp-supervisor-child: a JSON config argument is required\n");
    process.exitCode = 2;
  } else {
    // Mirrors `restate-child`: a rejected run is an unhandled rejection, which
    // exits nonzero exactly as the synchronous throw did.
    void runChild(parseChildConfig(JSON.parse(raw)));
  }
}
