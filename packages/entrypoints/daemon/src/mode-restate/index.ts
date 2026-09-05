import type { CommitPolicy, ResolvedRoute } from "@acp/contracts";
import type { Ledger } from "@acp/ledger";
import type { EndpointHandle, SafeServerHandle } from "@acp/durability";
import type {
  BeatContext,
  CheckpointPort,
  DurableInvocation,
  EffectPort,
  ScenarioRoot,
} from "@acp/runtime";
import {
  attachAdvance,
  createAcpGateWorkflow,
  createAcpTaskObject,
  readCacheThroughHandler,
  reconcile,
  registerDeployment,
  sendAdvance,
  serverAvailability,
  startEndpoint,
  startVerifiedServer,
} from "@acp/durability";
import { RUNTIME_SERVICE_PORT, RUNTIME_SERVICE_URL } from "@acp/runtime";

import {
  ENDPOINT_CLOSE_DEADLINE_MS,
  SERVER_STOP_DEADLINE_MS,
} from "../constants/index.js";
import { ModeError, StartupError } from "../errors/index.js";
import type { Resource, UnwindStack } from "../lifecycle/index.js";
import { classify } from "../lifecycle/index.js";

/**
 * The Restate mode, in the one order it is allowed to start in.
 *
 * Each step acquires something, and each acquisition is pushed onto the unwind
 * stack before the next is attempted. A failure at any point therefore releases
 * exactly what was taken, in reverse, and never more.
 *
 * The pinned binary is verified before it is started, not after. A drill that
 * ran against an unverified binary would prove nothing about the pinned one,
 * and a daemon that started one would be worse than a drill.
 */

export interface RestateModeInput {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly scenarioRoot: ScenarioRoot;
  readonly emittedBy: string;
  /**
   * The packet's commit policy, which selects the plan the object walks.
   *
   * Required and passed through, never defaulted here: see
   * `SqliteModeInput.commitPolicy`.
   */
  readonly commitPolicy: CommitPolicy;
  /** The packet's initiative, passed through: see `SqliteModeInput.initiativeId`. */
  readonly initiativeId: string;
  /** The side effect the beats perform, passed through: see `SqliteModeInput.effects`. */
  readonly effects: EffectPort;
  /**
   * Where a walk's checkpoint is persisted (V2-B1f/F3).
   *
   * **A factory per invocation, not one port.** The endpoint this mode starts
   * serves whatever invocation is submitted to it, and a checkpoint is
   * assembled from an invocation's own coordinates and its own last atomic
   * step. One port bound at construction would answer every task with the
   * first task's facts, so the member is built where the beat context is --
   * once per invocation, from that invocation.
   */
  readonly checkpoints?: ((invocation: DurableInvocation) => CheckpointPort) | undefined;
  /** The route the walk was admitted on, passed through: see `SqliteModeInput.route`. */
  readonly route: ResolvedRoute;
  readonly stack: UnwindStack;
  /**
   * Announce a phase at the instant it is reached.
   *
   * `SERVER_UP` carries the child's pid, because the caller needs it for the
   * status document and previously had to wait for this function to return
   * before it could publish. Waiting reordered the published sequence: the
   * server appeared to come up after the endpoint, the registration and the
   * reconciliation, which is not the order anything actually happened in.
   *
   * The return widened to `void | Promise<void>` at V2-B2-6 and `SERVER_UP` is
   * awaited below, because the caller now records the server's identity — a `ps`
   * probe — at the instant the pid first exists. Capturing later would leave a
   * daemon killed during registration with a pid and no identity, which is the
   * window the recorded orphan incident sat in. Only `SERVER_UP` is awaited and
   * no phase moved, so the published order this docblock protects is unchanged.
   *
   * The other four calls are marked `void` rather than awaited, which is the
   * design and not a lint concession: awaiting them would reintroduce exactly
   * the deferral this seam exists to prevent.
   */
  readonly onPhase: (
    phase: "BINARY_VERIFIED" | "SERVER_UP" | "ENDPOINT_UP" | "DEPLOYMENT_REGISTERED" | "RECONCILED",
    serverPid?: number,
  ) => void | Promise<void>;
  /**
   * How to decide whether the pinned binary may be started.
   *
   * A seam, defaulting to the real check. The refusal path is the one that
   * matters most and it cannot be exercised otherwise: proving it for real
   * would mean tampering with the verified install, and a drill that damaged
   * the thing it is verifying would be worse than no drill.
   */
  readonly readAvailability?: (() => { readonly available: boolean; readonly reason: string }) | undefined;
}

export interface RestateModeHandles {
  readonly server: SafeServerHandle;
  readonly endpoint: EndpointHandle;
  readonly verdict: string;
}

/**
 * Bind a ledger and an effect port into the shared beat context.
 *
 * The port is the caller's (V2-B1b, stage 2). This seam used to construct the
 * toy marker effect itself, which made the toy the only effect a production
 * Restate walk could ever have; now the daemon hands in the execution-backed
 * port over the owned boundary and this function binds nothing of its own.
 *
 * The route travels the same way and for the same reason (V2-B1c): it is the
 * caller's admitted value, bound once beside the port it was built from, so
 * the route the object records is the route the effect executes.
 */
export function beatFor(
  ledger: Ledger,
  emittedBy: string,
  effects: EffectPort,
  route: ResolvedRoute,
  checkpoints: ((invocation: DurableInvocation) => CheckpointPort) | undefined,
): (invocation: DurableInvocation) => Omit<BeatContext, "plan" | "initiativeId"> {
  return (invocation: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
    ledger,
    effects,
    invocation,
    emittedBy,
    route,
    // Built HERE, from this invocation, for the reason stated on the input:
    // the endpoint serves more than one, and a checkpoint assembled from
    // another task's coordinates would name work this walk did not do.
    checkpoints: checkpoints?.(invocation),
  });
}

/**
 * Every service this mode hosts, by the name the engine registers it under.
 *
 * A literal beside the `startEndpoint` call rather than something derived from
 * it, because the SDK's service definitions do not expose their names as a
 * readable list and a derivation that guessed would be a check that could
 * quietly stop checking. `L-B25G-1` asserts that this set and the services
 * actually registered below stay in step, which is what keeps a literal honest.
 */
const REGISTERED_SERVICES: readonly string[] = ["AcpTask", "AcpGate"];

/**
 * The service names in a deployment reply, or nothing at all.
 *
 * A body that is not a deployment yields an EMPTY set rather than a thrown
 * parse error, and that is deliberate: the caller treats an empty set as "none
 * of the required services are served" and fails closed, so an unreadable reply
 * and a wrong reply take the same path. A parse that threw would take a
 * different one, and the difference would be a way to reach readiness on a
 * reply nobody could read.
 */
function servedServiceNames(body: string): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Set<string>();
  }
  if (typeof parsed !== "object" || parsed === null) return new Set<string>();
  const services = (parsed as Record<string, unknown>)["services"];
  if (!Array.isArray(services)) return new Set<string>();

  const names = new Set<string>();
  for (const service of services) {
    if (typeof service !== "object" || service === null) continue;
    const name = (service as Record<string, unknown>)["name"];
    if (typeof name === "string") names.add(name);
  }
  return names;
}

/**
 * Start Restate, in order, pushing each resource as it is acquired.
 *
 * Returns once reconciliation has agreed with the ledger. Readiness belongs to
 * the caller and is declared only after this resolves.
 */
export async function startRestateMode(input: RestateModeInput): Promise<RestateModeHandles> {
  // S4. Fails closed: an absent or invalid pin is a refusal, never a fallback
  // to the other driver. A silent failover would make the mode flag a lie.
  const availability = (input.readAvailability ?? serverAvailability)();
  if (!availability.available) {
    throw new ModeError(
      "RESTATE was requested but the pinned server is not verified: " + availability.reason,
    );
  }
  void input.onPhase("BINARY_VERIFIED");

  // S5.
  const server = await startVerifiedServer(input.scenarioRoot);
  input.stack.push(serverResource(server));
  await input.onPhase("SERVER_UP", server.pid);

  // S6. Two services, and the second one is what this packet adds.
  //
  // `AcpGate` is hosted beside `AcpTask`, never inside it, for the reason the
  // gate is a workflow at all: waiting inside the exclusive object handler
  // would hold the task key for the whole wait, so `advance` for that task
  // would queue behind an unresolved gate and the per-task serialization
  // V2-B2-3 certified would be indistinguishable from a deadlock.
  //
  // Until now this endpoint registered only the object, so the daemon served a
  // plane on which `RestateDriver.signal` was declared `SUPPORTED` and the
  // ingress answered a release with "no such service". The capability was
  // honoured by the drills' own child and by nothing an operator could start,
  // which is a capability declaration running ahead of the assembled system.
  // Registering it here is the whole packet; see
  // `docs/architecture/0027-the-production-gate.md`.
  //
  // No argument, deliberately. The factory's only parameter is the drills'
  // `__onGate` announcement seam, and a production endpoint that passed one
  // would be a production endpoint carrying a test hook.
  const endpoint = await startEndpoint({
    services: [
      createAcpTaskObject({
        beat: beatFor(
          input.ledger,
          input.emittedBy,
          input.effects,
          input.route,
          input.checkpoints,
        ),
        commitPolicy: input.commitPolicy,
        initiativeId: input.initiativeId,
        ledger: input.ledger,
      }),
      createAcpGateWorkflow(),
    ],
    port: RUNTIME_SERVICE_PORT,
  });
  input.stack.push(endpointResource(endpoint));
  void input.onPhase("ENDPOINT_UP");

  // S7, in two acts, and the second one is not optional.
  //
  // **Act 1: register.** `registerDeployment` posts `force: false`. A refused
  // registration is a refused startup, as it always was.
  const registration = await registerDeployment(server.adminUrl, RUNTIME_SERVICE_URL);
  if (!registration.ok) {
    throw new StartupError(
      "the deployment was refused with status " + String(registration.status),
    );
  }

  // **Act 2: verify that the engine will actually route to what was just
  // started.** This exists because `force: false` was measured rather than
  // assumed, and it does not do what its name suggests.
  //
  // Against a data root that already holds a registration for this URI, the
  // pinned server answers `200` with the deployment it ALREADY HAD and runs no
  // discovery — whether the service set behind the URI is identical or
  // different. So act 1 succeeding proves only that a registration exists, not
  // that it describes this endpoint. A root registered by a build that served
  // one service keeps serving one service, and without this act the daemon
  // would reach readiness declaring `SIGNAL: "SUPPORTED"` over an ingress that
  // answers a gate release with "no such service" — which is precisely the
  // defect this packet exists to close, resurrected by a stale root.
  //
  // The reply body is the engine's own account of what it will route, so it is
  // read rather than trusted. Every service this mode hosts must appear in it
  // or the daemon fails closed here, before readiness, before reconciliation
  // and before anything is submitted. Fail-closed and not `force: true`:
  // overwriting a registration whose service list this process has not compared
  // is the same class of untruth in the other direction, and the operator who
  // meant to do it can do it deliberately.
  //
  // The refusal names the missing service and the status, never the body: a
  // router's text is engine output and may carry an engine invocation id.
  const served = servedServiceNames(registration.body);
  const missing = REGISTERED_SERVICES.filter((name) => !served.has(name));
  if (missing.length > 0) {
    throw new StartupError(
      "the engine's deployment for this endpoint does not serve " +
        missing.join(", ") +
        "; registration answered " +
        String(registration.status) +
        " without rediscovering, so this data root still carries an older" +
        " service set and the capabilities this driver declares would not hold",
    );
  }
  void input.onPhase("DEPLOYMENT_REGISTERED");

  // S8. Readiness is here, not at S5.
  const report = await reconcile({
    ledger: input.ledger,
    invocation: input.invocation,
    readCache: () => readCacheThroughHandler(server.ingressUrl, input.invocation.taskId),
  });
  if (!report.safeToResume) {
    throw new ModeError("reconciliation refused to resume in RESTATE mode: " + report.verdict);
  }
  void input.onPhase("RECONCILED");

  return { server, endpoint, verdict: report.verdict };
}

/**
 * Advance the invocation through the running endpoint, and wait for it.
 *
 * Two calls where there was one blocking submission (V2-B2-4a), and the
 * daemon's own behaviour is unchanged by design: it still waits, still returns
 * the status the walk ended with, and still publishes `SUPERVISING` only after
 * the ledger has reached its terminal state. What moved is HOW it waits —
 * through the address this side derived before ingress, rather than by holding
 * the submitting request open.
 *
 * The substitution is the point, not an optimisation. A send/attach pair
 * exercised only by drills would be exactly the defect V2 exists to correct:
 * a library with fixtures and no assembled consumer. Putting the production
 * seam on it means the daemon drills regress it for free, and means the
 * capability this packet declares is one something actually calls.
 *
 * A send the server refused returns that status and never attaches: there is
 * no invocation to rejoin, and attaching anyway would turn a clean refusal
 * into a second, less specific one.
 */
export async function superviseRestate(
  server: SafeServerHandle,
  invocation: DurableInvocation,
): Promise<{ readonly status: number }> {
  const sent = await sendAdvance(server.ingressUrl, invocation);
  if (!sent.ok) return { status: sent.status };
  const attached = await attachAdvance(server.ingressUrl, invocation);
  return { status: attached.status };
}
/**
 * The endpoint is released before the server.
 *
 * Reverse acquisition order, and it also matters in itself: Restate holds
 * persistent HTTP/2 sessions open, so closing the endpoint while the server is
 * still connected is what P2C proved will hang. The stack gives this ordering
 * for free, which is the point of having one.
 */
function endpointResource(endpoint: EndpointHandle): Resource {
  return {
    name: "endpoint",
    async release(): Promise<string | null> {
      try {
        await endpoint.close(ENDPOINT_CLOSE_DEADLINE_MS);
        return null;
      } catch (error: unknown) {
        return classify(error);
      }
    },
  };
}

function serverResource(server: SafeServerHandle): Resource {
  return {
    name: "restate-server",
    async release(): Promise<string | null> {
      try {
        const exit = await server.stop("SIGTERM", SERVER_STOP_DEADLINE_MS);
        return exit.reason === "KILLED_AFTER_DEADLINE" ? "KILLED_AFTER_DEADLINE" : null;
      } catch (error: unknown) {
        return classify(error);
      }
    },
  };
}
