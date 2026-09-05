import { realpathSync } from "node:fs";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { API_CONTRACT_VERSION, LEDGER_CONTRACT_VERSION } from "@acp/protocol";
import { TaskLifecycleExecuteResponse, TaskLifecycleRequest, TaskLifecycleResponse } from "@acp/protocol";
import { RestateDriver } from "@acp/durability";
import {
  RESTATE_ADMIN_URL,
  RESTATE_INGRESS_URL,
  SqliteSupervisor,
  admitDriverMode,
  createEvidenceProbe,
  lifecycleBeat,
  resolveScenarioRoot,
  restateInvocation,
  runLifecycleOperation,
  scenarioLedgerPath,
} from "@acp/runtime";
import type {
  AdmittedDriverMode,
  LifecycleVerb,
  OrchestrationDriver,
  RecoveredLifecycleContext,
} from "@acp/runtime";

import { ApiRouteError } from "../errors/index.js";

/**
 * The lifecycle door on the API (V2 L3).
 *
 * The plane's fourth write route, and the second that reaches past the ledger:
 * the tool-call door starts a child, and this one speaks to an execution engine
 * about an invocation that is already running. It is deliberately shaped like
 * the CLI door it must agree with — recover, construct, act once, answer one
 * document — because the equivalence this packet proves is not that two doors
 * behave similarly but that they return *the same bytes*.
 *
 * Five properties are worth stating because a reader will look for them.
 *
 * **The door recovers; it does not ask, and a body may not tell it.** A caller
 * supplies a verb, a mode, a task and an attempt. Everything else — the
 * invocation, the submitted instant, the submission digest, the emitting
 * worker, the initiative and the route — comes out of the ledger through
 * `restateInvocation`, the same producer the CLI door calls. The request schema
 * is a `strictObject`, so a body naming a scenario root, a database path, a
 * route or a commit policy is refused on the unknown key before a ledger is
 * opened. That is the D2 boundary made structural: derivation in either
 * direction stays refused, and the refusal cannot rot as fields are added.
 *
 * **The scenario is startup configuration, never request configuration.** It is
 * loaded once from the operator's flag, validated the way `loadToolServers`
 * validates its document, and checked against the ledger this process serves. A
 * server started without one answers `SCENARIO_UNCONFIGURED` — after the bearer
 * has passed, so an unauthenticated caller learns nothing about how this
 * process was started.
 *
 * **The door does not choose the driver.** `mode` is required and reaches the
 * constructor through `admitDriverMode`; there is no probing and no fallback. A
 * driver that failed over on its own would turn an unreachable engine into a
 * silently different execution plane, which is what drill D4 refuses — and no
 * construction is reachable from a `catch`, which is what `L-V2L-2` asserts.
 *
 * **The effect port can only read.** `settleCancellation` probes an open intent
 * and never applies, so the port supplied here is `createEvidenceProbe`, whose
 * `apply` throws. The full port cannot be built in this package in any case: it
 * needs a `ModelExecutionPort` from `@acp/providers`, which the gateway may not
 * import.
 *
 * **A capability gap is not an outage.** A SQLite supervisor asked to cancel
 * answers `CAPABILITY_UNSUPPORTED`, which is 501; an engine that could not be
 * reached is `LEDGER_UNAVAILABLE`, which is 503. A caller's retry loop must be
 * able to tell them apart, because one of them can never succeed.
 *
 * The door is deliberately **not** exported from this package's barrel. It is a
 * route, not a public API of the package, and the gateway README's public
 * surface is pinned against that barrel by equality — so keeping it out is both
 * the cheaper half and the more honest one.
 */

/** Why an operator's scenario was refused. Reasons, never paths. */
export type ScenarioLoadRefusal =
  | "PATH_NOT_SUPPLIED"
  | "SCENARIO_UNRESOLVABLE"
  | "LEDGER_MISMATCH";

export type ScenarioLoadOutcome =
  | { readonly ok: true; readonly scenarioId: string }
  | { readonly ok: false; readonly reason: ScenarioLoadRefusal };

/**
 * Load the operator's scenario, once, and prove it names this server's ledger.
 *
 * Mirrors `loadToolServers` in shape and in discipline: resolved through the
 * filesystem so a symlink cannot make two names look different, refused with a
 * reason that names no path, and read **at startup** rather than per request —
 * a scenario re-resolved per call would let a directory replaced mid-flight
 * change the answer between two calls of one batch.
 *
 * The agreement check is the same one the CLI door makes and for the same
 * reason: the evidence a cancellation probes lives under the scenario's own
 * directory and is addressable only through the brand `resolveScenarioRoot`
 * mints, while the ledger is named by a path. A door that derived one from the
 * other would be choosing, on the operator's behalf, which of two things they
 * meant.
 */
export function loadScenario(scenarioId: unknown, ledgerPath: string): ScenarioLoadOutcome {
  if (typeof scenarioId !== "string" || scenarioId.trim() === "") {
    return { ok: false, reason: "PATH_NOT_SUPPLIED" };
  }

  let expected: string;
  try {
    expected = realpathSync(scenarioLedgerPath(resolveScenarioRoot(scenarioId)));
  } catch {
    return { ok: false, reason: "SCENARIO_UNRESOLVABLE" };
  }

  let actual: string;
  try {
    actual = realpathSync(ledgerPath);
  } catch {
    return { ok: false, reason: "SCENARIO_UNRESOLVABLE" };
  }

  if (expected !== actual) return { ok: false, reason: "LEDGER_MISMATCH" };
  return { ok: true, scenarioId };
}

/**
 * How a driver is built for one mode.
 *
 * Injected for the same topology reason the CLI door injects it: the `gateway`
 * vitest project runs in the default parallel group and binds no Restate port,
 * so a door that could only be driven against a live engine would have no suite
 * in its own package. Optional in the type and defaulted to the real factory,
 * so production has one construction and no test hook on its path. The
 * real-engine proofs are L2's and stay L2's, over the identical construction.
 */
export type LifecycleDriverFactory = (input: {
  readonly mode: AdmittedDriverMode;
  readonly ledger: Ledger;
  readonly context: RecoveredLifecycleContext;
  readonly scenarioId: string;
}) => OrchestrationDriver;

/**
 * Build the driver the mode names.
 *
 * A `switch` over the contract's own closed vocabulary, never a `try`/`catch`
 * chain: a door that constructed one driver inside the catch of another's
 * failure would reintroduce the failover D4 refuses, one layer up from the
 * driver that refuses it.
 */
const realDriver: LifecycleDriverFactory = ({ mode, ledger, context, scenarioId }) => {
  const effects = createEvidenceProbe(resolveScenarioRoot(scenarioId));

  switch (mode) {
    case "SQLITE_SUPERVISOR":
      return SqliteSupervisor.forLifecycle({
        ledger,
        invocation: context.invocation,
        effects,
        emittedBy: context.emittedBy,
        initiativeId: context.initiativeId,
        route: context.route,
      });
    default:
      return RestateDriver.forLifecycle(
        {
          ledger,
          invocation: context.invocation,
          emittedBy: context.emittedBy,
          ingressUrl: RESTATE_INGRESS_URL,
          adminUrl: RESTATE_ADMIN_URL,
        },
        lifecycleBeat(ledger, effects, context),
        context.initiativeId,
      );
  }
};

/** Recovery's closed refusals, mapped onto the API's vocabulary. */
function refuseRecovery(refusal: string, at: string): ApiRouteError {
  switch (refusal) {
    case "TASK_UNKNOWN":
      return new ApiRouteError("NOT_FOUND", "the ledger holds no such task", at);
    case "ATTEMPT_NOT_LATEST":
      return new ApiRouteError(
        "NOT_FOUND",
        "this attempt is not the task's latest, and acting on it would record an" +
          " outcome against work another attempt began",
        at,
      );
    case "ROUTE_NOT_RECORDED":
      return new ApiRouteError(
        "BAD_REQUEST",
        "this attempt has not recorded the route it was admitted on, so there is" +
          " nothing to recover; the lifecycle verbs serve an attempt from its run" +
          " onward",
        at,
      );
    case "SUBMISSION_DIGEST_MISMATCH":
      return new ApiRouteError(
        "WRITE_REFUSED",
        "the recorded route disagrees with the digest this attempt's events carry",
        at,
      );
    default:
      return new ApiRouteError(
        "WRITE_REFUSED",
        "this attempt's first event could not be read as a discovery",
        at,
      );
  }
}

/** What the read half answers, from the read-only source and nothing else. */
export function buildLifecycleRead(ledger: Ledger, taskId: string): TaskLifecycleResponse {
  const task = ledger.getTask(taskId);
  if (task === null) {
    throw new ApiRouteError("NOT_FOUND", "no task with that id was found");
  }
  return TaskLifecycleResponse.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    taskId: task.taskId,
    latestAttempt: task.latestAttempt,
    currentState: task.currentState,
  });
}

export interface LifecycleExecuteDependencies {
  readonly ledger: Ledger;
  readonly scenario: ScenarioLoadOutcome;
  readonly taskId: string;
  readonly body: unknown;
  readonly makeDriver?: LifecycleDriverFactory | undefined;
}

/**
 * Run one lifecycle verb and answer with the document it produced.
 *
 * The order below is the whole of the door's fail-closed story, and it is the
 * order rather than the checks that matters. Everything a caller could have got
 * wrong is refused before a ledger is opened; the scenario is refused before a
 * ledger is opened too, so an unconfigured server never touches one; everything
 * the ledger could disagree about is refused before a driver is constructed;
 * and a driver is constructed before any engine is asked. So a mode this engine
 * cannot serve answers `CAPABILITY_UNSUPPORTED` from a real driver rather than
 * from a branch that guessed, and an attempt with no recorded route is refused
 * in the same words whichever mode was named.
 *
 * The writable handle is the register the roadmap write established and the
 * tool-call door followed: the served ledger is opened read-only, so a route
 * that appends opens its own, uses it, and closes it in a `finally`. Never held
 * between requests and never reachable from the read path.
 */
export async function executeLifecycleVerb(
  dependencies: LifecycleExecuteDependencies,
): Promise<TaskLifecycleExecuteResponse> {
  const { ledger, scenario, taskId } = dependencies;

  // The body first, so a malformed request never learns whether this process
  // was started with a scenario. `safeParse` and a field path: the value is
  // never echoed, because a value in an error body is a value in a log.
  const parsed = TaskLifecycleRequest.safeParse(dependencies.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // An unknown key — the D2 boundary, and the refusal that matters most here
    // — is an `unrecognized_keys` issue whose `path` is EMPTY, because the
    // offending key is not part of the schema and so has no position in it.
    // Joining an empty path yields `""`, which is neither a field path nor
    // `null` and tells a client branching on `detail` nothing at all. The
    // stable answer is the body itself: the caller's own key is never echoed,
    // since a caller-supplied string in an error body is a caller-supplied
    // string in a log, and the value it labels is exactly the thing D2 refuses
    // to acknowledge. Named paths are preserved untouched for every issue that
    // has one, so a missing `mode` still refuses at `mode`.
    const at = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
    throw new ApiRouteError("BAD_REQUEST", "the lifecycle request is not valid", at);
  }
  const request = parsed.data;

  // The path and the body must name the same task. Two ids in one request is a
  // request that does not know what it is asking for.
  if (request.taskId !== taskId) {
    throw new ApiRouteError(
      "BAD_REQUEST",
      "the task in the path and the task in the body must be the same",
      "taskId",
    );
  }

  if (!scenario.ok) {
    throw new ApiRouteError(
      "SCENARIO_UNCONFIGURED",
      "this server was started without a scenario that names its ledger, so no" +
        " lifecycle verb can address the evidence it would probe",
    );
  }

  // Admitted through the shared producer, so this door adds no vocabulary of
  // its own; the schema has already closed the enum, and this is what carries
  // the admitted value into the constructor.
  const mode = admitDriverMode(request.mode);
  if (mode === null) {
    throw new ApiRouteError(
      "BAD_REQUEST",
      "mode must name a driver the contract declares, and is never inferred",
      "mode",
    );
  }

  const verb: LifecycleVerb = request.verb;
  // Built inside the try and validated outside it, so a schema failure — which
  // would be a defect in this door rather than an engine's silence — is never
  // caught by the classifier below and reported as an unreachable engine.
  let document: unknown;
  const writable = openLedger(ledger.path);
  try {
    const recovered = restateInvocation(writable, request.taskId, request.attempt);
    if (!recovered.ok) throw refuseRecovery(recovered.refusal, recovered.at);

    const driver = (dependencies.makeDriver ?? realDriver)({
      mode,
      ledger: writable,
      context: recovered.context,
      scenarioId: scenario.scenarioId,
    });

    const result = await runLifecycleOperation({
      driver,
      verb,
      invocation: recovered.context.invocation,
    });

    // A capability gap is the one driver refusal that is **not** answered as a
    // document, and the asymmetry is deliberate (D1). `TASK_TERMINAL` and
    // `POSTCONDITION_UNKNOWN` describe an operation that happened: the driver
    // looked, and the answer is about the work. `CAPABILITY_UNSUPPORTED` says
    // the verb was never servable here at all, so no operation occurred and
    // there is nothing to hand back a document about. 501 is the status for a
    // request the server does not implement on this engine, and keeping it out
    // of the 503 family is what lets a caller's retry loop tell "try again"
    // from "this can never succeed".
    if (!result.outcome.ok && result.outcome.refusal === "CAPABILITY_UNSUPPORTED") {
      throw new ApiRouteError(
        "CAPABILITY_UNSUPPORTED",
        "the engine this attempt runs on does not serve that lifecycle verb, and" +
          " no retry will change that",
        verb === "CANCEL" ? "cancel" : "attach",
      );
    }

    // V2 L4, and deliberate because **nothing forces it**: a fourth refusal
    // would otherwise flow into `document.refusal` and answer 200 with
    // `ok: false`, which no type error announces. The engine was reached and
    // said it holds no invocation at this address; that is a not-found, and the
    // API says so with the code it already has. No document, for the same
    // reason a capability gap carries none — the request never became an
    // operation this plane can report on.
    //
    // `NOT_FOUND` now has two sources on this route: the ledger pre-check, when
    // the ledger holds no such task or attempt, and this, when the ledger holds
    // it and the engine does not. They share a code deliberately, because to a
    // caller they mean the same thing — there is nothing there to act on — and
    // the ledger remains the authority on what the task did.
    if (!result.outcome.ok && result.outcome.refusal === "INVOCATION_NOT_FOUND") {
      throw new ApiRouteError(
        "NOT_FOUND",
        "the engine holds no invocation at this attempt's address; confirm the" +
          " endpoint is registered and ask once more, and the ledger remains the" +
          " authority on what the task did",
        verb === "CANCEL" ? "cancel" : "attach",
      );
    }

    document = {
      verb: result.verb,
      mode: result.mode,
      taskId: request.taskId,
      attempt: request.attempt,
      ok: result.outcome.ok,
      finalSequence: result.outcome.ok ? (result.outcome.finalSequence ?? null) : null,
      refusal: result.outcome.ok ? null : result.outcome.refusal,
    };
  } catch (error: unknown) {
    if (error instanceof ApiRouteError) throw error;

    // Every other throw from below this line is a driver's, and what reaches
    // here is now genuinely a channel failure: a server that could not be
    // reached, or an address that does not resolve.
    //
    // This comment used to include "an invocation the engine never heard of" in
    // that list, and V2 L4 retired the claim because it was false. It was
    // written when the driver threw on every non-ok attach status, so the door
    // had no way to tell a reached engine's plain answer from an unreachable
    // one — and the sentence described the driver's limitation as though it
    // were a fact about the world. The drills had measured the opposite all
    // along. That answer is now `INVOCATION_NOT_FOUND` and is handled above.
    //
    // The message never crosses. A driver error carries a status number, and a
    // status number is the one thing about an engine this plane puts in no body.
    throw new ApiRouteError(
      "LEDGER_UNAVAILABLE",
      "the engine could not be reached, and the ledger remains the authority on" +
        " what the task did",
      verb === "CANCEL" ? "cancel" : "attach",
    );
  } finally {
    writable.close();
  }

  return TaskLifecycleExecuteResponse.parse(document);
}
