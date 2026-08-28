import type { Ledger } from "@acp/ledger";
import type {
  BeatContext,
  DurableInvocation,
  EndpointHandle,
  SafeServerHandle,
  ScenarioRoot,
} from "@acp/runtime";
import {
  RUNTIME_SERVICE_PORT,
  RUNTIME_SERVICE_URL,
  applyEffect,
  createAcpTaskObject,
  probeEffect,
  readCacheThroughHandler,
  reconcile,
  registerDeployment,
  serverAvailability,
  startEndpoint,
  startVerifiedServer,
  submitAdvance,
} from "@acp/runtime";

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

/** Bind a ledger and scenario into the shared beat context. */
export function beatFor(
  ledger: Ledger,
  scenarioRoot: ScenarioRoot,
  emittedBy: string,
): (invocation: DurableInvocation) => BeatContext {
  return (invocation: DurableInvocation): BeatContext => ({
    ledger,
    effects: {
      apply: (operation) => {
        applyEffect(scenarioRoot, operation);
      },
      probe: (operation) => probeEffect(scenarioRoot, operation),
    },
    invocation,
    emittedBy,
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
        beat: beatFor(input.ledger, input.scenarioRoot, input.emittedBy),
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

/** Advance the invocation through the running endpoint. */
export async function superviseRestate(
  server: SafeServerHandle,
  invocation: DurableInvocation,
): Promise<{ readonly status: number }> {
  const result = await submitAdvance(server.ingressUrl, invocation);
  return { status: result.status };
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
