import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CommitPolicy, ResolvedRoute } from "@acp/contracts";
import { openLedger } from "@acp/ledger";

import {
  INTENT_STEP,
  RUNTIME_SERVICE_PORT,
  SupervisorError,
  applyEffect,
  probeEffect,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";
import type { BeatContext, DurableInvocation } from "@acp/runtime";
import { createAcpTaskObject } from "../restate-driver/index.js";
import { startEndpoint } from "../restate-endpoint/index.js";

/**
 * The service endpoint, hosted in its own process so a drill can kill it.
 *
 * Mirrors `sqlite-supervisor-child/index.ts`. A restart drill is only evidence if the
 * process actually dies: an exception caught in the same process leaves the
 * ledger handle, the page cache and every object intact, which is exactly what
 * a crash does not do. So the endpoint runs here and the drill sends it a real
 * SIGKILL at a chosen beat.
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
function blockUntilReleased(file: string, deadlineMs: number): void {
  const started = Date.now();
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(file)) {
    if (Date.now() - started > deadlineMs) return;
    Atomics.wait(idle, 0, 0, 50);
  }
}

/** Host the endpoint until this process is killed. */
export async function runRestateChild(config: RestateChildConfig): Promise<void> {
  const scenarioRoot = resolveScenarioRoot(config.scenarioId);
  const ledger = openLedger(scenarioLedgerPath(scenarioRoot));

  const beat = (invocation: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
    ledger,
    effects: {
      apply: (operation) => {
        applyEffect(scenarioRoot, operation);
        return Promise.resolve();
      },
      probe: (operation) => Promise.resolve(probeEffect(scenarioRoot, operation)),
    },
    invocation,
    emittedBy: config.emittedBy,
    route: drillRoute(invocation),
  });

  const onBeat = (point: string): void => {
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
      process.stdout.write(JSON.stringify({ paused: config.pauseAt }) + "\n");
      blockUntilReleased(releasePath(scenarioRoot, config.pauseAt), 120_000);
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
