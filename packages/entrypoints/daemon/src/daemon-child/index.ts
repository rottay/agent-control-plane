import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ResolvedRoute } from "@acp/contracts";
import { canonicalJsonStringify, sha256Hex } from "@acp/ledger";

import { ModeError } from "../errors/index.js";
import { isDaemonMode } from "../lifecycle/index.js";
import type { DaemonMode } from "../lifecycle/index.js";
import { installSignalHandlers } from "../signals/index.js";
import { startDaemon, stopDaemon, terminateDaemon } from "../index.js";

/**
 * The daemon, hosted in its own process so a drill can signal it for real.
 *
 * This is not the packaged entry. P2F added that — `src/bin/acp-daemon/index.ts`,
 * exposed as the one `bin` — and it takes a config-file path, which is what
 * launchd passes. This module keeps its JSON-argv mode unchanged so the P2D
 * drills keep working; the packaged entry delegates here after validating a
 * config file.
 *
 * It exists so the drills can send SIGTERM, SIGINT and SIGKILL to an actual
 * process: a shutdown proven by calling a function in-process proves nothing,
 * because the handles, the page cache and every object survive it, which is
 * exactly what losing a process does not do.
 *
 * Importing this module does nothing at all. It runs only when executed
 * directly, and it accepts a validated JSON argument rather than reading the
 * environment, so nothing about its behaviour depends on ambient state.
 */

const SHA256_HEX = new RegExp("^[0-9a-f]{64}$");
const UUID = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", "i");

/** The session budgets the CLI binding carries. Positive integers, all four. */
export interface DaemonExecutionLimits {
  readonly timeoutMs: number;
  readonly outputBudgetBytes: number;
  readonly interruptGraceMs: number;
  readonly termGraceMs: number;
}

/**
 * The one CLI binding admission the config carries (V2-B1b, D5).
 *
 * Absolute, canonical paths -- the `config-file` manner -- checked here for
 * shape and existence. Ownership, permissions and the product-path ban are the
 * providers package's own admissions, applied by `startDaemon` when the port
 * is built, so neither law is restated in a second place.
 */
export interface DaemonExecutionBinding {
  readonly binary: string;
  readonly configRoot: string;
  readonly workdir: string;
  readonly limits: DaemonExecutionLimits;
}

/**
 * The resolved route the daemon executes, and the binding that serves it.
 *
 * The route arrives RESOLVED: the daemon does not resolve (D5). It is parsed
 * through the contracts' own schema, refinement included, so a CLI route
 * naming a provider outside the CLI vocabulary is refused at config load.
 */
export interface DaemonExecutionConfig {
  readonly route: ResolvedRoute;
  readonly binding: DaemonExecutionBinding;
}

export interface DaemonChildConfig {
  readonly mode: DaemonMode;
  readonly scenarioId: string;
  readonly emittedBy: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly submittedAt: string;
  readonly submissionDigest: string;
  /** The packet's initiative. Required in the JSON, checked as a uuid here. */
  readonly initiativeId: string;
  /** Stay alive after supervising, so a signal drill has something to signal. */
  readonly holdOpen: boolean;
  /** Skip the port precheck. Only for the SQLite drills, which bind nothing. */
  readonly checkPorts: boolean;
  /** The execution the walk performs. Required; there is no toy default (V2-B1b). */
  readonly execution: DaemonExecutionConfig;
}

/**
 * What this run was asked to do, as one value (V2-B1c, stage 2).
 *
 * B1c stage 1 recorded the admitted route on the INTENT event, which made the
 * route explainable after the fact but left it **unpinned**: nothing bound the
 * route to the submission, so a resume that reached the daemon with a
 * different route was adopted rather than refused. Where the INTENT had
 * already been appended the ledger caught it late, on an idempotency conflict.
 * Where the crash preceded the INTENT append, nothing caught it at all —
 * `assertInvocationContinuity` rebuilds step 0, and step 0 carried no route.
 *
 * The determinism law (`@acp/runtime`'s `CoordinateOrigin`) admits three
 * provenances, and a resolved route is none of `DERIVED` — it is a function of
 * the policy document, the registry, quota state and a caller-supplied instant,
 * so it cannot be recomputed from `DurableInvocation`. It is therefore
 * `SUBMISSION`, and `SUBMISSION` is only worth anything if it is pinned by a
 * digest that rides an event replayed on every resume. That mechanism already
 * exists: `submissionDigest` is carried in the base payload of **every** event
 * precisely so that resubmitting different content under the same coordinates
 * fails closed. This type is what that digest is taken over.
 *
 * So the route is bound by making it part of the preimage rather than by
 * adding a field to `DurableInvocation` (whose shape is B3's to change) or a
 * new event (which would change what a resuming SSE consumer sees between two
 * sequence numbers, also B3's). A changed route changes the digest, a changed
 * digest changes step 0's bytes, and the continuity guard refuses — with no
 * new law and no new vocabulary.
 *
 * **Only safe provenance enters the preimage.** Task coordinates, the instant,
 * the initiative, and the six contract fields of the admitted route: every one
 * an identifier or a timestamp. No credential, no prompt, no tool argument, no
 * environment value, no path. The preimage is hashed and discarded — it is
 * never logged, never persisted and never carried on an event; what travels is
 * the digest.
 */
export interface DaemonSubmission {
  readonly taskId: string;
  readonly attempt: number;
  readonly submittedAt: string;
  readonly initiativeId: string;
  /** The route as the contract admitted it. Never a wider or laxer value. */
  readonly route: ResolvedRoute;
}

/**
 * The canonical preimage, as bytes.
 *
 * `canonicalJsonStringify` is the ledger's own canonicalizer, the same one the
 * event chain is digested over, so key order here is a property of the
 * function rather than of how this literal happens to be written: two callers
 * spelling the fields in different orders produce identical bytes. The route's
 * six fields are projected one by one rather than spread, so a wider object
 * cannot widen the preimage and silently change every digest.
 */
export function canonicalSubmission(submission: DaemonSubmission): string {
  return canonicalJsonStringify({
    taskId: submission.taskId,
    attempt: submission.attempt,
    submittedAt: submission.submittedAt,
    initiativeId: submission.initiativeId,
    route: {
      provider: submission.route.provider,
      model: submission.route.model,
      accountId: submission.route.accountId,
      transportKind: submission.route.transportKind,
      capabilityPolicyVersion: submission.route.capabilityPolicyVersion,
      resolvedAt: submission.route.resolvedAt,
    },
  });
}

/** The digest of the canonical preimage. One producer, one algorithm. */
export function canonicalSubmissionDigest(submission: DaemonSubmission): string {
  return sha256Hex(canonicalSubmission(submission));
}

/**
 * An absolute, canonical path, in the `config-file` manner.
 *
 * Absolute, no `..` segment, and equal to its own realpath -- so it exists and
 * traverses no symlink. The refusal names the field, never the value.
 */
function admittedPath(candidate: unknown, at: string): string {
  if (typeof candidate !== "string" || candidate === "" || !isAbsolute(candidate)) {
    throw new ModeError(at + " must be an absolute path");
  }
  if (candidate.split(sep).includes("..")) throw new ModeError(at + " must contain no .. segment");
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    throw new ModeError(at + " does not exist");
  }
  if (resolved !== candidate) throw new ModeError(at + " must be canonical; it traverses a symlink");
  return candidate;
}

function positiveInteger(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ModeError(at + " must be a positive integer");
  }
  return value;
}

/** Validate the `execution` section: the contract's route, then the binding's paths and budgets. */
function parseExecutionSection(raw: unknown): DaemonExecutionConfig {
  if (typeof raw !== "object" || raw === null) throw new ModeError("execution must be an object");
  const value = raw as Record<string, unknown>;

  // The contract admits the route, refinement included, or the config is
  // refused at the door. The refusal carries the first failing field as a
  // path and never the value that failed there.
  const route = ResolvedRoute.safeParse(value["route"]);
  if (!route.success) {
    const issue = route.error.issues[0];
    const path = issue === undefined ? [] : issue.path.map((segment) => String(segment));
    throw new ModeError(["execution.route", ...path].join(".") + " does not satisfy the contract");
  }

  const binding = value["binding"];
  if (typeof binding !== "object" || binding === null) {
    throw new ModeError("execution.binding must be an object");
  }
  const admission = binding as Record<string, unknown>;
  const limits = admission["limits"];
  if (typeof limits !== "object" || limits === null) {
    throw new ModeError("execution.binding.limits must be an object");
  }
  const budgets = limits as Record<string, unknown>;

  return {
    route: route.data,
    binding: {
      binary: admittedPath(admission["binary"], "execution.binding.binary"),
      configRoot: admittedPath(admission["configRoot"], "execution.binding.configRoot"),
      workdir: admittedPath(admission["workdir"], "execution.binding.workdir"),
      limits: {
        timeoutMs: positiveInteger(budgets["timeoutMs"], "execution.binding.limits.timeoutMs"),
        outputBudgetBytes: positiveInteger(
          budgets["outputBudgetBytes"],
          "execution.binding.limits.outputBudgetBytes",
        ),
        interruptGraceMs: positiveInteger(
          budgets["interruptGraceMs"],
          "execution.binding.limits.interruptGraceMs",
        ),
        termGraceMs: positiveInteger(budgets["termGraceMs"], "execution.binding.limits.termGraceMs"),
      },
    },
  };
}

/** Validate the child's configuration. Nothing is read from the environment. */
export function parseDaemonChildConfig(raw: unknown): DaemonChildConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ModeError("child config must be an object");
  }
  const value = raw as Record<string, unknown>;
  const mode = value["mode"];
  const scenarioId = value["scenarioId"];
  const emittedBy = value["emittedBy"];
  const taskId = value["taskId"];
  const attempt = value["attempt"];
  const submittedAt = value["submittedAt"];
  const submissionDigest = value["submissionDigest"];
  const initiativeId = value["initiativeId"];
  const holdOpen = value["holdOpen"] ?? true;
  const checkPorts = value["checkPorts"] ?? true;

  if (!isDaemonMode(mode)) throw new ModeError("mode must be an explicit daemon mode");
  if (typeof scenarioId !== "string") throw new ModeError("scenarioId must be a string");
  if (typeof emittedBy !== "string") throw new ModeError("emittedBy must be a string");
  if (typeof taskId !== "string") throw new ModeError("taskId must be a string");
  if (typeof submittedAt !== "string") throw new ModeError("submittedAt must be a string");
  if (typeof submissionDigest !== "string" || !SHA256_HEX.test(submissionDigest)) {
    throw new ModeError("submissionDigest must be 64 lowercase hex characters");
  }
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    throw new ModeError("attempt must be a positive integer");
  }
  // Absence is a refusal, not a default: this value reaches the discovery
  // event's payload, and the contract will only accept a uuid there, so a
  // malformed one is caught at the door rather than three layers down.
  if (typeof initiativeId !== "string" || !UUID.test(initiativeId)) {
    throw new ModeError("initiativeId must be a uuid");
  }
  if (typeof holdOpen !== "boolean") throw new ModeError("holdOpen must be a boolean");
  if (typeof checkPorts !== "boolean") throw new ModeError("checkPorts must be a boolean");
  // Required, never defaulted (V2-B1b, D4/D5): a config that does not say
  // which route it executes, and through which admitted binding, gets no daemon.
  const execution = parseExecutionSection(value["execution"]);

  // The door (V2-B1c, stage 2). The declared digest must be exactly the digest
  // of the submission this config describes, route included.
  //
  // Until now any 64 lowercase hex characters passed, which made
  // `submissionDigest` a value the config asserted about itself and nothing
  // checked. That is the hole: the digest rides every event and the continuity
  // guard compares it, so an unbound digest let a resume under a different
  // route rebuild step 0 to the SAME bytes and be waved through. Binding it
  // here — at load, before a ledger is opened, before a beat runs, before
  // anything is appended — is what makes the route `SUBMISSION` rather than
  // ambient.
  //
  // Computed once, and compared. There is deliberately no fallback and no
  // "recompute if absent" branch: a config that cannot state its own digest
  // gets no daemon, because a default here would restore exactly the silence
  // this check exists to end. The refusal names the field and never prints
  // either digest — one is the caller's and one is derived from the route, and
  // neither belongs in a log line.
  const expectedDigest = canonicalSubmissionDigest({
    taskId,
    attempt,
    submittedAt,
    initiativeId,
    route: execution.route,
  });
  if (submissionDigest !== expectedDigest) {
    throw new ModeError(
      "submissionDigest is not the digest of the submission this config declares;" +
        " the route, the task coordinates and the instant are all part of it",
    );
  }

  return {
    mode,
    scenarioId,
    emittedBy,
    taskId,
    attempt,
    submittedAt,
    submissionDigest,
    initiativeId,
    holdOpen,
    checkPorts,
    execution,
  };
}

/** Run the daemon until a signal, or until the server dies under it. */
export async function runDaemonChild(config: DaemonChildConfig): Promise<number> {
  const run = await startDaemon({
    mode: config.mode,
    scenarioId: config.scenarioId,
    emittedBy: config.emittedBy,
    taskId: config.taskId,
    attempt: config.attempt,
    submittedAt: config.submittedAt,
    submissionDigest: config.submissionDigest,
    initiativeId: config.initiativeId,
    checkPorts: config.checkPorts,
    execution: config.execution,
  });

  const announce = (): void => {
    process.stdout.write(
      JSON.stringify({
        ready: true,
        pid: process.pid,
        serverPid: run.serverPid,
        phases: run.phases,
      }) + "\n",
    );
  };

  if (!config.holdOpen) {
    announce();
    await stopDaemon(run);
    return 0;
  }

  return await new Promise<number>((resolveExit) => {
    // An unresolved promise does NOT keep Node alive: promises are not handles,
    // and neither are signal listeners. Without a real handle the loop drains
    // the moment startup finishes and the process exits on its own, skipping
    // the drain path entirely and leaving the lock and status behind. A timer
    // is a handle, so this is what actually holds the daemon open.
    const keepAlive = setInterval(() => undefined, 60_000);

    const finish = (code: number, binding: { release(): void }): void => {
      clearInterval(keepAlive);
      binding.release();
      resolveExit(code);
    };

    const binding = installSignalHandlers((signal) => {
      void (async (): Promise<void> => {
        process.stdout.write(JSON.stringify({ draining: signal }) + "\n");
        // Through the bounded public operation, not straight to run.stop():
        // a declared aggregate bound the real entry point bypasses is not a
        // bound, it is a comment.
        const result = await stopDaemon(run);
        finish(result.stopped ? 0 : 1, binding);
      })();
    });

    // An unexpected server death after readiness is terminal. Nothing restarts
    // and nothing fails over: the classified status is published, the owned
    // resources unwind, and the process leaves with a nonzero code.
    if (run.terminal !== null) {
      void run.terminal.then((reason) => {
        if (reason !== "UNEXPECTED_EXIT") return;
        void (async (): Promise<void> => {
          // Publishes a classified TERMINAL status before unwinding, and
          // leaves that document behind: it is the only account of why this
          // process is gone.
          await terminateDaemon(run, "SUPERVISION", reason);
          process.stdout.write(JSON.stringify({ terminal: reason }) + "\n");
          finish(70, binding);
        })();
      });
    }

    // Announced last, deliberately. The drill signals the moment it sees this
    // line, so anything announced before the handlers exist is a race the test
    // would lose intermittently and blame on the daemon.
    announce();
  });
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url))
) {
  const raw = process.argv[2];
  if (raw === undefined) {
    process.stderr.write("acp-daemon-child: a JSON config argument is required\n");
    process.exitCode = 2;
  } else {
    void runDaemonChild(parseDaemonChildConfig(JSON.parse(raw))).then((code) => {
      process.exitCode = code;
    });
  }
}
