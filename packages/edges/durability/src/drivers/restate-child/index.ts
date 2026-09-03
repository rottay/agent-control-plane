import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CommitPolicy, ResolvedRoute } from "@acp/contracts";
import type { ExecutionEvent, ExecutionRequest, ModelExecutionPort } from "@acp/contracts";
import { openLedger } from "@acp/ledger";

import {
  INTENT_STEP,
  RESTATE_INGRESS_URL,
  RUNTIME_SERVICE_PORT,
  SupervisorError,
  applyEffect,
  probeEffect,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";
import type { BeatContext, DurableInvocation, ScenarioRoot } from "@acp/runtime";
import { createExecutionEffects } from "@acp/runtime";
import { createAcpTaskObject } from "../restate-driver/index.js";
import { startEndpoint } from "../restate-endpoint/index.js";
import { attachAdvance, deriveInvocation } from "../../submit/index.js";

/**
 * The service endpoint, hosted in its own process so a drill can kill it.
 *
 * Mirrors `sqlite-supervisor-child/index.ts`. A restart drill is only evidence if the
 * process actually dies: an exception caught in the same process leaves the
 * ledger handle, the page cache and every object intact, which is exactly what
 * a crash does not do. So the endpoint runs here and the drill sends it a real
 * SIGKILL at a chosen beat.
 *
 * It hosts a second role for the same reason (V2-B2-4a). A client-death drill
 * is evidence only if the CLIENT process actually dies, and an aborted fetch
 * inside the drill's own process is not that: the process that held the
 * attach keeps its module state, its sockets and its memory of the address.
 * So `role: "ATTACH"` runs an attaching client here, in its own process, and
 * the drill sends it a real SIGKILL. It rebuilds the address from
 * `(taskId, attempt)` through `deriveInvocation` rather than being told it,
 * which is what makes the drill's later, fresh attach a proof that the handle
 * needs no client state.
 *
 * Importing this module does nothing. It runs only as a process entry point.
 */

const FAULT_POINTS: readonly string[] = ["AFTER_INTENT", "AFTER_EFFECT", "AFTER_OUTCOME"];
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface RestateChildConfig {
  readonly scenarioId: string;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /** The packet's commit policy. Required in the JSON, never defaulted here. */
  readonly commitPolicy: CommitPolicy;
  /** The packet's initiative. Required in the JSON, never defaulted here. */
  readonly initiativeId: string;
  readonly faultPoint: string | null;
  /**
   * Beat at which to pause and announce, for the server-kill drill.
   *
   * The drill has to kill Restate while a plan is genuinely in flight. Without
   * a handshake the only alternatives are a blind sleep or killing before
   * submission, and neither proves anything about mid-plan behaviour. The child
   * therefore stops at a named beat, says so on stdout, and waits for a release
   * file the drill creates.
   */
  readonly pauseAt: string | null;
  readonly port: number;
  /**
   * Which role this process plays (V2-B2-4a).
   *
   * `ENDPOINT` — the default, so every drill that predates this packet keeps
   * its meaning — hosts the service. `ATTACH` hosts nothing: it rejoins one
   * invocation and reports what it got. The default follows the `effect`
   * selector's precedent for the same reason.
   */
  readonly role: "ENDPOINT" | "ATTACH";
  /**
   * Which effect the journalled beats perform (V2-B2-2).
   *
   * `TOY` stays the default for the drills that predate this packet. With
   * `EXECUTION` the beats drive `createExecutionEffects`: an awaited drain to a
   * terminal event, digest-keyed evidence under `executions/`, and the
   * three-verdict probe. Recovery is re-proved over that path because the toy
   * settles inside one tick and so leaves no interval for a restart to land in.
   */
  readonly effect: "TOY" | "EXECUTION";
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
export function drillRoute(invocation: DurableInvocation): ResolvedRoute {
  return ResolvedRoute.parse({
    provider: "toy",
    model: "toy-effect",
    accountId: "drill",
    transportKind: "LOCAL_OR_SELF_HOSTED",
    capabilityPolicyVersion: "drill",
    resolvedAt: invocation.submittedAt,
  });
}

/** Where the scripted port records each start, for a later process to count. */
// Module-local in both drill children rather than exported from one and
// imported by the other: unifying it would mean widening the runtime barrel,
// which is outside this packet's write-set. The name is a filename the drills
// read back, not a contract.
const EXECUTION_STARTS = "execution-starts.log";

/** The route an execution-backed drill walk records (V2-B2-2). */
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
 * A scripted execution, standing in for a provider this package may not import.
 *
 * `@acp/durability` may name contracts, the ledger, the runtime and the Restate
 * SDK — not the providers edge — so the subject is scripted here for the same
 * reason it is in the SQLite drill child. What is under test is recovery, which
 * is a property of the effect module and the ledger rather than of whatever
 * sits on the far side of the port.
 */
function scriptedPort(scenarioRoot: ScenarioRoot): ModelExecutionPort {
  return {
    start(candidate: ResolvedRoute, request: ExecutionRequest) {
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
              // Genuinely asynchronous, so an AFTER_EFFECT kill has an interval
              // to land in. A synchronous stream would reproduce the toy's shape.
              await Promise.resolve();
              yield event;
            }
          },
        }),
      });
    },
    interrupt: () => Promise.resolve(),
    healthProbe: () =>
      Promise.resolve({ status: "OK" as const, checkedAt: new Date(0).toISOString(), latencyMs: null, classifiedError: null }),
  };
}

/** Validate the child's configuration. Nothing is read from the environment. */
export function parseRestateChildConfig(raw: unknown): RestateChildConfig {
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
  // Admitted by the contract's own enum. A child that did not say which policy
  // it runs under is refused rather than handed the commit-capable plan.
  const commitPolicy = CommitPolicy.safeParse(value["commitPolicy"]);
  if (!commitPolicy.success) {
    throw new SupervisorError("child config requires an explicit commitPolicy");
  }
  // Symmetric with the policy above, and for the same reason: the value
  // reaches the discovery event's payload, so a default would be a silent
  // attribution no later event could correct.
  const initiativeId = value["initiativeId"];
  if (typeof initiativeId !== "string" || initiativeId.length === 0) {
    throw new SupervisorError("child config requires an explicit initiativeId");
  }
  const rawFault = value["faultPoint"] ?? null;
  const faultPoint = typeof rawFault === "string" ? rawFault : null;
  const rawPause = value["pauseAt"] ?? null;
  const pauseAt = typeof rawPause === "string" ? rawPause : null;
  // V2-B2-2. Absence means TOY, so the drills that predate this packet keep
  // their meaning; anything else is refused rather than coerced.
  const effect = value["effect"] ?? "TOY";
  if (effect !== "TOY" && effect !== "EXECUTION") {
    throw new SupervisorError("effect must be TOY or EXECUTION");
  }
  // V2-B2-4a, and symmetric with `effect`: absence means the role every
  // earlier drill relied on, and anything else is refused rather than coerced.
  const role = value["role"] ?? "ENDPOINT";
  if (role !== "ENDPOINT" && role !== "ATTACH") {
    throw new SupervisorError("role must be ENDPOINT or ATTACH");
  }
  const rawPort = value["port"] ?? RUNTIME_SERVICE_PORT;

  if (typeof scenarioId !== "string") throw new SupervisorError("scenarioId must be a string");
  if (typeof emittedBy !== "string") throw new SupervisorError("emittedBy must be a string");
  if (rawFault !== null && faultPoint === null) {
    throw new SupervisorError("faultPoint must be null or a string");
  }
  if (faultPoint !== null && !FAULT_POINTS.includes(faultPoint)) {
    throw new SupervisorError("faultPoint must be null or a known fault point");
  }
  if (rawPause !== null && pauseAt === null) {
    throw new SupervisorError("pauseAt must be null or a string");
  }
  if (pauseAt !== null && !FAULT_POINTS.includes(pauseAt)) {
    throw new SupervisorError("pauseAt must be null or a known beat");
  }
  if (pauseAt !== null && faultPoint !== null) {
    throw new SupervisorError("a child may pause or fault, never both");
  }
  if (typeof rawPort !== "number" || !Number.isInteger(rawPort)) {
    throw new SupervisorError("port must be an integer");
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
    faultPoint,
    pauseAt,
    port: rawPort,
    effect,
    role,
    invocation: { taskId, attempt, invocationId, submittedAt, submissionDigest },
  };
}

/** The file whose appearance releases a paused child. */
export function releasePath(scenarioRoot: string, beat: string): string {
  return join(scenarioRoot, "release-" + beat.toLowerCase().replace(/_/g, "-"));
}

/**
 * Block this process until the drill releases it, or the deadline passes.
 *
 * Synchronous on purpose, and still so now that the beats themselves are
 * asynchronous (V2-B1b, stage 1). The handler calls `__onBeat` between its
 * awaited `ctx.run` calls and never awaits the hook, so an async wait here
 * would return at once and the handler would issue the next `ctx.run` while
 * the drill still believed the plan was paused. Blocking the thread at the
 * beat is what holds the invocation open, and the block happens outside every
 * `ctx.run` closure -- after the previous beat has settled and before the
 * next is journaled -- which is exactly where it happened while the beats
 * were synchronous. `Atomics.wait` sleeps without burning a core, and the
 * deadline means a drill that forgets to release fails rather than hangs.
 */
/**
 * Hold this invocation until the drill releases it (V2-B2-3).
 *
 * Asynchronous, and that is the whole point of the change. The previous form
 * spun on `Atomics.wait`, which blocks the main thread: every other invocation
 * on this endpoint stopped too, so a drill could never tell whether a second
 * task was waiting because Restate serializes per key or because the harness
 * had stopped the process. Measured before the change — concurrent work did not
 * run during the block and ran the moment it lifted.
 *
 * Awaiting a poll holds exactly one invocation and leaves the endpoint live,
 * which is what makes the same-key and different-key drills discriminate. The
 * interval is a poll, not a sleep: the wait ends on the condition, and the
 * deadline is a bound on failure rather than a duration anyone relies on.
 */
async function blockUntilReleased(file: string, deadlineMs: number): Promise<void> {
  const started = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - started > deadlineMs) return;
    await new Promise<void>((wake) => {
      setTimeout(wake, 25);
    });
  }
}

/**
 * Attach to one invocation, from a process that holds nothing else (V2-B2-4a).
 *
 * The address is REBUILT here rather than read from the config's invocation.
 * That is the whole content of the role: `deriveInvocation` is pure in
 * `(taskId, attempt)`, so a process that never saw the first submission can
 * still name the invocation, and the drill's proof that a fresh client can
 * rejoin after the previous one was killed does not quietly depend on the
 * drill having handed this process the answer.
 *
 * No ledger is opened and no endpoint is started. A client that could read the
 * authority directly would prove nothing about attaching.
 */
async function runAttachClient(config: RestateChildConfig): Promise<void> {
  const derived = deriveInvocation(
    config.invocation.taskId,
    config.invocation.attempt,
    config.invocation.submittedAt,
    config.invocation.submissionDigest,
  );
  process.stdout.write(
    JSON.stringify({ attaching: true, invocationId: derived.invocationId }) + "\n",
  );

  try {
    const result = await attachAdvance(RESTATE_INGRESS_URL, derived, 120_000);
    process.stdout.write(
      JSON.stringify({ attached: true, status: result.status, body: result.body }) + "\n",
    );
  } catch (error: unknown) {
    // Classified, never a guessed result: an attach that could not complete
    // says nothing about whether the task advanced.
    process.stdout.write(
      JSON.stringify({
        attached: false,
        reason: error instanceof Error ? error.name : "unknown",
      }) + "\n",
    );
  }
}

/** Host the endpoint until this process is killed, or attach and report. */
export async function runRestateChild(config: RestateChildConfig): Promise<void> {
  if (config.role === "ATTACH") {
    await runAttachClient(config);
    return;
  }
  const scenarioRoot = resolveScenarioRoot(config.scenarioId);
  const ledger = openLedger(scenarioLedgerPath(scenarioRoot));

  const beat = (invocation: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
    ledger,
    effects:
      config.effect === "EXECUTION"
        ? createExecutionEffects({
            port: scriptedPort(scenarioRoot),
            route: executionDrillRoute(invocation),
            request: {
              taskId: invocation.taskId,
              attempt: invocation.attempt,
              identity: config.emittedBy,
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
    invocation,
    emittedBy: config.emittedBy,
    route:
      config.effect === "EXECUTION" ? executionDrillRoute(invocation) : drillRoute(invocation),
  });

  const onBeat = async (point: string, taskId: string): Promise<void> => {
    // A real signal. SIGKILL cannot be caught, so nothing here flushes, closes
    // or tidies up, which is the only honest simulation of losing the process
    // mid-step. The INTENT fault fires only on the intent step's own append.
    // Derived from the plan, never a literal. The handler names the intent beat
    // by the step's own index, so a plan edit that moved the intent would
    // silently stop matching a hard-coded number and every fault and pause drill
    // would quietly become a no-op.
    const intentBeat = "AFTER_INTENT_" + String(INTENT_STEP.index);
    const matches = (wanted: string): boolean =>
      wanted === "AFTER_EFFECT"
        ? point === "AFTER_EFFECT"
        : wanted === "AFTER_OUTCOME"
          ? point === "AFTER_OUTCOME"
          : point === intentBeat;

    if (config.faultPoint !== null && matches(config.faultPoint)) {
      process.kill(process.pid, "SIGKILL");
      return;
    }

    // The pause handshake: announce, then hold the invocation open until the
    // drill has done whatever it needed a live plan for.
    if (config.pauseAt !== null && matches(config.pauseAt)) {
      // The task is named so a drill can count DISTINCT held invocations; a
      // bare count cannot tell two invocations from one redelivered twice.
      process.stdout.write(JSON.stringify({ paused: config.pauseAt, taskId }) + "\n");
      await blockUntilReleased(releasePath(scenarioRoot, config.pauseAt), 120_000);
    }
  };

  const endpoint = await startEndpoint({
    services: [
      createAcpTaskObject({
        beat,
        commitPolicy: config.commitPolicy,
        initiativeId: config.initiativeId,
        ledger,
        __onBeat: onBeat,
      }),
    ],
    port: config.port,
  });

  // The parent waits for this line before it registers and submits.
  process.stdout.write(
    JSON.stringify({ ready: true, host: endpoint.host, port: endpoint.port }) + "\n",
  );

  // Stay alive. The drill ends this process, one way or another.
  await new Promise<void>(() => undefined);
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url))
) {
  const raw = process.argv[2];
  if (raw === undefined) {
    process.stderr.write("acp-restate-child: a JSON config argument is required\n");
    process.exitCode = 2;
  } else {
    void runRestateChild(parseRestateChildConfig(JSON.parse(raw)));
  }
}
