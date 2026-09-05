import { realpathSync } from "node:fs";

import type { ApiErrorCode } from "@acp/protocol";
import { LedgerError } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
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
  LifecycleOperationResult,
  LifecycleVerb,
  OrchestrationDriver,
  RecoveredLifecycleContext,
} from "@acp/runtime";

/**
 * A driver's own answer, as this door passes it back.
 *
 * Taken from the operation's result type rather than named from
 * `@acp/contracts`, which this package may not import: the vocabulary is still
 * the contract's, reached through the one module that owns the operation.
 */
export type LifecycleOutcome = LifecycleOperationResult["outcome"];

import { openForWrite } from "../tool-call/index.js";

/**
 * The lifecycle door: cancel and rejoin, from a terminal (V2 L2).
 *
 * `acp` observes, plans, and — since V2-B4b stage 3D — records one tool call.
 * This module adds the second thing it does that changes a ledger, and it is
 * deliberately shaped like the first: the verb branches above the read-only
 * open, takes the one writable handle this package owns, composes an operation
 * that lives in `@acp/runtime`, and prints one validated document.
 *
 * Four properties are worth stating because a reader will look for them.
 *
 * **The door recovers; it does not ask.** An operator supplies coordinates — a
 * task, an attempt, a mode, a scenario — and nothing else. The invocation
 * identity, the submitted instant, the submission digest, the emitting worker,
 * the initiative and the route all come out of the ledger through
 * `restateInvocation`, which is the same producer the API door will call. There
 * is no flag for any of them, because a flag would be a second authority for a
 * value the log already holds, and the two could then disagree about which
 * attempt is being cancelled.
 *
 * **`--mode` is required and never inferred.** Probing an engine and falling
 * back to the other one is exactly what drill D4 refuses: a driver that fails
 * over on its own turns an unreachable engine into a silently different
 * execution plane. Reading the daemon's status document is not open to this
 * package either — that document is keyed by a brand only `@acp/daemon` mints,
 * and nothing here reaches the daemon. So the mode is stated, and a missing one
 * is a usage error rather than a guess.
 *
 * **The effect port can only read.** `settleCancellation` probes an open intent
 * and never applies, so the port this door supplies is `createEvidenceProbe`:
 * the reader half of the execution port, whose `apply` throws. The full port
 * cannot be built here in any case — it needs a `ModelExecutionPort` from
 * `@acp/providers`, which this package may not import and must not.
 *
 * **The driver is injectable, and that is a topology necessity rather than a
 * testing convenience.** The `cli` vitest project runs in the default parallel
 * group and binds no ports; the three port-binding projects hold distinct
 * numbers precisely so they cannot collide. A door that could only be tested
 * against a live engine would therefore have no suite at all in its own
 * package. The real-engine proofs — idempotency, a `SIGKILL` in the settlement
 * window, an attach after a door death — live in the durability project, over
 * the same construction this door builds.
 */

/** A refusal that never became an operation. Shaped exactly like the tool call's. */
export class LifecycleRefused extends Error {
  readonly code: ApiErrorCode;
  /** The field path a refusal names. Never the operator's own value. */
  readonly at: string | null;

  constructor(code: ApiErrorCode, message: string, at: string | null = null) {
    super(message);
    this.name = "LifecycleRefused";
    this.code = code;
    this.at = at;
  }
}

/**
 * What the verb prints.
 *
 * Bounded by construction: five fields on the accepting arm, five on the
 * refusing one, and nothing that could carry an engine's identity, a path, a
 * route, a payload or an operator's own value. `finalSequence` is a ledger
 * coordinate — a number the ledger can restate for itself — which is the only
 * thing either driver verb returns.
 */
export interface LifecycleDocument {
  readonly verb: LifecycleVerb;
  readonly mode: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly ok: boolean;
  /** The ledger head the verb reached, or null when it refused. */
  readonly finalSequence: number | null;
  /** The driver's own closed refusal name, or null when it did not refuse. */
  readonly refusal: string | null;
}

/**
 * How a driver is built for one mode.
 *
 * Injected so the CLI's own suite can drive both branches without binding a
 * port. Optional in the type and defaulted to the real factory, so production
 * has exactly one construction and no test hook on its path.
 */
export type LifecycleDriverFactory = (input: {
  readonly mode: AdmittedDriverMode;
  readonly ledger: Ledger;
  readonly context: RecoveredLifecycleContext;
  readonly scenarioId: string;
}) => OrchestrationDriver;

export interface LifecycleVerbInput {
  readonly verb: LifecycleVerb;
  readonly databasePath: string;
  readonly scenarioId: string;
  readonly taskId: string;
  /** The operator's own strings. Parsed here, never trusted. */
  readonly attempt: string;
  readonly mode: string;
  readonly makeDriver?: LifecycleDriverFactory | undefined;
}

export interface LifecycleVerbResult {
  readonly document: LifecycleDocument;
  /** Decided by the caller's table, from the document this module returns. */
  readonly outcome: LifecycleOutcome;
}

/**
 * Build the driver the mode names.
 *
 * A `switch` over the contract's own closed vocabulary, and deliberately not a
 * `try`/`catch` chain: a door that constructed one driver inside the catch of
 * another's failure would be reintroducing the failover D4 refuses, one layer
 * up from the driver that refuses it. `L-V2L-2` asserts the shape.
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

/**
 * The mode, admitted through the shared producer or refused by field name.
 *
 * The admission itself is `@acp/runtime`'s, so this door adds no vocabulary of
 * its own; what it adds is the refusal, which names the flag and never the
 * value the operator typed.
 */
function admitMode(raw: string): AdmittedDriverMode {
  const mode = admitDriverMode(raw);
  if (mode === null) {
    throw new LifecycleRefused(
      "BAD_REQUEST",
      "--mode must name a driver the contract declares, and is never inferred",
      "mode",
    );
  }
  return mode;
}

/** The attempt, as a positive integer or not at all. */
function admitAttempt(raw: string): number {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    throw new LifecycleRefused("BAD_REQUEST", "--attempt must be a positive integer", "attempt");
  }
  return parsed;
}

/**
 * Prove that `--database` and `--scenario` name the same ledger.
 *
 * Both are required and neither defaults the other, which is the honest
 * arrangement rather than a strict one. The evidence a cancellation probes
 * lives under the scenario's own directory and can only be addressed through
 * the brand `resolveScenarioRoot` mints; the ledger is named by a path. A door
 * that derived one from the other would be choosing, on the operator's behalf,
 * which of two things they meant — so instead both are stated and this function
 * refuses unless they agree, compared through the filesystem so a symlink
 * cannot make two names look different.
 */
function admitScenario(scenarioId: string, databasePath: string): string {
  if (scenarioId.trim() === "") {
    throw new LifecycleRefused("BAD_REQUEST", "--scenario is required", "scenario");
  }

  let expected: string;
  try {
    expected = realpathSync(scenarioLedgerPath(resolveScenarioRoot(scenarioId)));
  } catch {
    // The message never crosses: a boundary error names the drill root, and a
    // resolution error names a path.
    throw new LifecycleRefused(
      "BAD_REQUEST",
      "the scenario does not resolve to a ledger this plane owns",
      "scenario",
    );
  }

  let actual: string;
  try {
    actual = realpathSync(databasePath);
  } catch {
    throw new LifecycleRefused("LEDGER_UNAVAILABLE", "the ledger could not be opened", "database");
  }

  if (expected !== actual) {
    throw new LifecycleRefused(
      "BAD_REQUEST",
      "--database and --scenario name different ledgers",
      "database",
    );
  }
  return scenarioId;
}

/** Recovery's closed refusals, mapped onto the door's vocabulary. */
function refuseRecovery(refusal: string, at: string): LifecycleRefused {
  switch (refusal) {
    case "TASK_UNKNOWN":
      return new LifecycleRefused("NOT_FOUND", "the ledger holds no such task", at);
    case "ATTEMPT_NOT_LATEST":
      return new LifecycleRefused(
        "BAD_REQUEST",
        "this attempt is not the task's latest, and acting on it would record an" +
          " outcome against work another attempt began",
        at,
      );
    case "ROUTE_NOT_RECORDED":
      return new LifecycleRefused(
        "BAD_REQUEST",
        "this attempt has not recorded the route it was admitted on, so there is" +
          " nothing to recover; the lifecycle verbs serve an attempt from its run" +
          " onward",
        at,
      );
    case "SUBMISSION_DIGEST_MISMATCH":
      return new LifecycleRefused(
        "WRITE_REFUSED",
        "the recorded route disagrees with the digest this attempt's events carry",
        at,
      );
    default:
      return new LifecycleRefused(
        "WRITE_REFUSED",
        "this attempt's first event could not be read as a discovery",
        at,
      );
  }
}

/**
 * Run one lifecycle verb and return the document to print.
 *
 * The order below is the whole of the door's fail-closed story, and it is the
 * order rather than the checks that matters. Everything an operator could have
 * got wrong is refused before a ledger is opened; everything the ledger could
 * disagree about is refused before a driver is constructed; and a driver is
 * constructed before any engine is asked. So a mode this engine cannot serve
 * answers `CAPABILITY_UNSUPPORTED` from a real driver rather than from a branch
 * that guessed, and an attempt with no recorded route is refused in the same
 * words whichever mode was named.
 *
 * Since V2 L4 a fourth driver refusal passes through here unchanged:
 * `INVOCATION_NOT_FOUND`, which the engine answers when it holds no invocation
 * at an address. It needed no branch — the door prints whatever refusal the
 * outcome carries — and the exit table maps it to `EXIT_NOT_FOUND`. Before L4
 * that answer arrived as a throw and was reported as an unreachable engine,
 * which told an operator to retry something that could never change.
 */
export async function runLifecycleVerb(input: LifecycleVerbInput): Promise<LifecycleVerbResult> {
  const mode = admitMode(input.mode);
  const attempt = admitAttempt(input.attempt);
  if (input.taskId.trim() === "") {
    throw new LifecycleRefused("BAD_REQUEST", "--task is required", "task");
  }
  const scenarioId = admitScenario(input.scenarioId, input.databasePath);

  const ledger = openForWrite(input.databasePath);
  try {
    const recovered = restateInvocation(ledger, input.taskId, attempt);
    if (!recovered.ok) throw refuseRecovery(recovered.refusal, recovered.at);

    const driver = (input.makeDriver ?? realDriver)({
      mode,
      ledger,
      context: recovered.context,
      scenarioId,
    });

    const result = await runLifecycleOperation({
      driver,
      verb: input.verb,
      invocation: recovered.context.invocation,
    });

    return {
      outcome: result.outcome,
      document: {
        verb: result.verb,
        mode: result.mode,
        taskId: input.taskId,
        attempt,
        ok: result.outcome.ok,
        finalSequence: result.outcome.ok ? (result.outcome.finalSequence ?? null) : null,
        refusal: result.outcome.ok ? null : result.outcome.refusal,
      },
    };
  } catch (error: unknown) {
    // A ledger that cannot be opened or is not migrated refuses through the
    // same function every read verb refuses through.
    if (error instanceof LedgerError) throw error;
    if (error instanceof LifecycleRefused) throw error;

    // Every other throw from below this line is a driver's. The contract's only
    // refusal is `CAPABILITY_UNSUPPORTED` and the capability is present, so a
    // server that could not be reached, an address that does not resolve or an
    // invocation the engine never heard of are failures of the CHANNEL, not
    // answers about the work. They are told apart from a capability gap by
    // their code, because an operator's script must not retry one as the other.
    //
    // The message never crosses. A driver error carries a status number, and a
    // status number is the one thing about an engine this package prints
    // nowhere.
    throw new LifecycleRefused(
      "LEDGER_UNAVAILABLE",
      "the engine could not be reached, and the ledger remains the authority on" +
        " what the task did",
      input.verb === "CANCEL" ? "cancel" : "attach",
    );
  } finally {
    ledger.close();
  }
}
