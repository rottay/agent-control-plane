import type { CommitPolicy, ResolvedRoute } from "@acp/contracts";
import type { Ledger } from "@acp/ledger";
import type { EndpointHandle, SafeServerHandle } from "@acp/durability";
import type { BeatContext, DurableInvocation, EffectPort, ScenarioRoot } from "@acp/runtime";
import {
  attachAdvance,
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
   */
  readonly onPhase: (
    phase: "BINARY_VERIFIED" | "SERVER_UP" | "ENDPOINT_UP" | "DEPLOYMENT_REGISTERED" | "RECONCILED",
    serverPid?: number,
  ) => void;
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
): (invocation: DurableInvocation) => Omit<BeatContext, "plan" | "initiativeId"> {
  return (invocation: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
    ledger,
    effects,
    invocation,
    emittedBy,
    route,
  });
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
  input.onPhase("BINARY_VERIFIED");

  // S5.
  const server = await startVerifiedServer(input.scenarioRoot);
  input.stack.push(serverResource(server));
  input.onPhase("SERVER_UP", server.pid);

  // S6.
  const endpoint = await startEndpoint({
    services: [
      createAcpTaskObject({
        beat: beatFor(input.ledger, input.emittedBy, input.effects, input.route),
        commitPolicy: input.commitPolicy,
        initiativeId: input.initiativeId,
        ledger: input.ledger,
      }),
    ],
    port: RUNTIME_SERVICE_PORT,
  });
  input.stack.push(endpointResource(endpoint));
  input.onPhase("ENDPOINT_UP");

  // S7.
  const registration = await registerDeployment(server.adminUrl, RUNTIME_SERVICE_URL);
  if (!registration.ok) {
    throw new StartupError(
      "the deployment was refused with status " + String(registration.status),
    );
  }
  input.onPhase("DEPLOYMENT_REGISTERED");

  // S8. Readiness is here, not at S5.
  const report = await reconcile({
    ledger: input.ledger,
    invocation: input.invocation,
    readCache: () => readCacheThroughHandler(server.ingressUrl, input.invocation.taskId),
  });
  if (!report.safeToResume) {
    throw new ModeError("reconciliation refused to resume in RESTATE mode: " + report.verdict);
  }
  input.onPhase("RECONCILED");

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
