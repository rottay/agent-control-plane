import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ResolvedRoute, TaskEnvelope } from "@acp/contracts";
import { canonicalSubmission, canonicalSubmissionDigest } from "@acp/runtime";

import { ModeError } from "../errors/index.js";
import { WALK_CONCURRENCY_MAX } from "../scheduler/index.js";
import type { ScheduledWalk } from "../scheduler/index.js";
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
  /**
   * The packet's envelope, and the singular form's write-set authority
   * (V2 concurrency C4, DT Option B). Required, exactly as `walks[].envelope`
   * has been since C3 — a production path with no declared write-set is a path
   * conformance cannot judge.
   */
  readonly envelope: TaskEnvelope;
  /**
   * Many walks inside one plane (V2 concurrency C3), or null for the one-walk
   * form this door has always accepted.
   *
   * The two forms are **exclusive in the JSON**: a config carrying `walks` must
   * not also carry the singular coordinates, because a config that says both
   * has two answers to "what runs here" and nothing decides between them. When
   * `walks` is present the singular fields above are the **first walk's**, so
   * the one-walk case is literally the same config either way.
   */
  readonly walks: readonly ScheduledWalk[] | null;
}

/**
 * The submission, its preimage and its digest -- declared in `@acp/runtime`,
 * re-exported here (V2-B7S).
 *
 * **The door did not move; the producer did.** Everything below this comment
 * about what the digest means still holds, and the comparison that enforces it
 * is still in this file, a hundred lines down, unchanged. What changed is the
 * address of the declaration: the composition root that elects a route now has
 * to compute the digest this door will recompute, and it lives above the walk
 * in `@acp/runtime`. Leaving the producer here would have forced that root to
 * depend on `@acp/daemon` -- an entrypoint depending on an entrypoint, through
 * a `.`-only export map and a fence-pinned public surface -- for one function.
 *
 * Re-exported rather than re-declared, and that distinction is the whole point:
 * a second declaration would be a second answer to "what was asked for", which
 * is exactly what the fence's one-producer arm refuses. It is a re-export, so
 * the five daemon test files that import these names through this module keep
 * resolving with no edit at all, `test/fallback` included -- B2-4a certifies
 * that file untouched and this packet never opens it.
 *
 * V2-B1c stage 2's reasoning, which the move does not disturb: stage 1 recorded
 * the admitted route on the INTENT event, which made the route explainable
 * after the fact but left it **unpinned**, so a resume that reached the daemon
 * with a different route was adopted rather than refused. The determinism law
 * admits three provenances and a resolved route is none of `DERIVED` -- it is a
 * function of the policy document, the registry, quota state and a
 * caller-supplied instant. It is therefore `SUBMISSION`, and `SUBMISSION` is
 * only worth anything if it is pinned by a digest that rides an event replayed
 * on every resume. A changed route changes the digest, a changed digest changes
 * step 0's bytes, and the continuity guard refuses -- with no new law and no new
 * vocabulary.
 */
// Imported above so the door below can call it verbatim, and re-exported here
// so the five daemon suites that reach for these names through this module
// keep resolving unchanged. A re-export, never a second declaration.
export { canonicalSubmission, canonicalSubmissionDigest };
export type { DaemonSubmission } from "@acp/runtime";

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
/**
 * The envelope door (V2 concurrency C3).
 *
 * Ten checks, each naming a reason word and a field path and **never echoing a
 * value** — an envelope carries objectives and paths, and a refusal that
 * printed one would put a packet's contents in a log line.
 *
 * Two of them are the ones a writer omits, and they are the reason this door
 * exists rather than a `length` check: an entry whose envelope declares one
 * `taskId` (or `initiativeId`) while the entry runs another would have the
 * conflict graph deciding over a set that does not describe what runs. Every
 * later gate would then be correct about the wrong thing.
 *
 * The duplicate-id check is here deliberately too. `checkAdmission` is
 * fail-closed over a corrupt admitted set — `compatible` is false whatever the
 * candidate looks like — so catching it at the door gives the operator the
 * accurate error instead of an unexplained blanket refusal much later.
 */
function parseWalks(raw: unknown, mode: DaemonMode): readonly ScheduledWalk[] {
  if (!Array.isArray(raw)) throw new ModeError("config.walks must be an array");
  const walks: ScheduledWalk[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const at = "config.walks[" + String(index) + "]";
    const entry: unknown = raw[index];
    if (typeof entry !== "object" || entry === null) throw new ModeError(at + " must be an object");
    const value = entry as Record<string, unknown>;

    // The whole contract, not a subset: a partially checked envelope is one the
    // graph will read fields from that nobody validated.
    const envelope = TaskEnvelope.safeParse(value["envelope"]);
    if (!envelope.success) throw new ModeError(at + ".envelope must satisfy the TaskEnvelope contract");

    const taskId = value["taskId"];
    const attempt = value["attempt"];
    const submittedAt = value["submittedAt"];
    const submissionDigest = value["submissionDigest"];
    const initiativeId = value["initiativeId"];
    const scenarioId = value["scenarioId"];
    const emittedBy = value["emittedBy"];

    if (typeof scenarioId !== "string" || scenarioId.length === 0) {
      throw new ModeError(at + ".scenarioId must be a string");
    }
    if (typeof emittedBy !== "string" || emittedBy.length === 0) {
      throw new ModeError(at + ".emittedBy must be a string");
    }
    if (typeof taskId !== "string") throw new ModeError(at + ".taskId must be a string");
    if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
      throw new ModeError(at + ".attempt must be a positive integer");
    }
    if (typeof submittedAt !== "string") throw new ModeError(at + ".submittedAt must be a string");
    if (typeof initiativeId !== "string" || !UUID.test(initiativeId)) {
      throw new ModeError(at + ".initiativeId must be a uuid");
    }
    if (typeof submissionDigest !== "string" || !SHA256_HEX.test(submissionDigest)) {
      throw new ModeError(at + ".submissionDigest must be 64 lowercase hex characters");
    }

    // The envelope must describe the walk that runs. Without these two the
    // graph decides over a set that does not.
    if (envelope.data.taskId !== taskId) {
      throw new ModeError(at + ".taskId disagrees with the envelope it carries");
    }
    if (envelope.data.initiativeId !== initiativeId) {
      throw new ModeError(at + ".initiativeId disagrees with the envelope it carries");
    }

    const execution = parseExecutionSection(value["execution"]);
    if (!isAbsolute(execution.binding.workdir)) {
      throw new ModeError(at + ".execution.binding.workdir must be absolute");
    }

    // The same producer, per walk. No second spelling of the preimage.
    const expected = canonicalSubmissionDigest({
      taskId,
      attempt,
      submittedAt,
      initiativeId,
      route: execution.route,
    });
    if (submissionDigest !== expected) {
      throw new ModeError(
        at + ".submissionDigest is not the digest of the submission this walk declares",
      );
    }

    if (seen.has(taskId)) throw new ModeError("config.walks carries a duplicate taskId");
    seen.add(taskId);

    walks.push({
      envelope: envelope.data,
      worktreePath: execution.binding.workdir,
      spec: {
        scenarioId,
        taskId,
        attempt,
        submittedAt,
        submissionDigest,
        initiativeId,
        emittedBy,
        execution,
      },
    });
  }

  if (walks.length === 0) throw new ModeError("config.walks must carry at least one walk");
  if (walks.length > WALK_CONCURRENCY_MAX) {
    throw new ModeError(
      "config.walks exceeds the concurrency this plane admits (" + String(WALK_CONCURRENCY_MAX) + ")",
    );
  }
  // The capability, refused at the door as well as in `startDaemon`.
  if (mode === "RESTATE" && walks.length > 1) {
    throw new ModeError(
      "config.mode RESTATE supports exactly one walk; N walks would route N task keys" +
        " through one walk's endpoint and call the result concurrency",
    );
  }
  return walks;
}

export function parseDaemonChildConfig(raw: unknown): DaemonChildConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ModeError("child config must be an object");
  }
  const value = raw as Record<string, unknown>;
  const mode = value["mode"];
  if (!isDaemonMode(mode)) throw new ModeError("mode must be an explicit daemon mode");

  // V2 concurrency C3. Exactly one of the two forms. Both is refused because a
  // config that states its coordinates twice has two answers to what runs here,
  // and nothing in the daemon decides between them.
  if (value["walks"] !== undefined) {
    for (const singular of ["taskId", "attempt", "submittedAt", "submissionDigest", "execution"]) {
      if (value[singular] !== undefined) {
        throw new ModeError("config.walks and the singular walk fields are exclusive");
      }
    }
    const walks = parseWalks(value["walks"], mode);
    const first = walks[0];
    if (first === undefined) throw new ModeError("config.walks must carry at least one walk");
    const scenarioId = value["scenarioId"];
    const emittedBy = value["emittedBy"];
    if (typeof scenarioId !== "string" && scenarioId !== undefined) {
      throw new ModeError("scenarioId must be a string");
    }
    if (typeof emittedBy !== "string" && emittedBy !== undefined) {
      throw new ModeError("emittedBy must be a string");
    }
    const holdOpenValue = value["holdOpen"] ?? true;
    const checkPortsValue = value["checkPorts"] ?? true;
    if (typeof holdOpenValue !== "boolean") throw new ModeError("holdOpen must be a boolean");
    if (typeof checkPortsValue !== "boolean") throw new ModeError("checkPorts must be a boolean");
    return {
      mode,
      // The first walk's, so the one-walk case is the same config either way.
      scenarioId: typeof scenarioId === "string" ? scenarioId : first.spec.scenarioId,
      emittedBy: typeof emittedBy === "string" ? emittedBy : first.spec.emittedBy,
      taskId: first.spec.taskId,
      attempt: first.spec.attempt,
      submittedAt: first.spec.submittedAt,
      submissionDigest: first.spec.submissionDigest,
      initiativeId: first.spec.initiativeId,
      holdOpen: holdOpenValue,
      checkPorts: checkPortsValue,
      execution: first.spec.execution,
      envelope: first.envelope,
      walks,
    };
  }

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

  // V2 concurrency C4, DT Option B. The same three checks C3 applies to every
  // `walks[]` entry, applied to the singular form — the same parser, not a
  // second envelope validator. The whole contract, then the two agreements that
  // make the envelope describe the walk that actually runs: without them a
  // config could declare one packet's write-set and run another's, and every
  // gate downstream would be correct about the wrong thing.
  const singularEnvelope = TaskEnvelope.safeParse(value["envelope"]);
  if (!singularEnvelope.success) {
    throw new ModeError("config.envelope must satisfy the TaskEnvelope contract");
  }
  if (singularEnvelope.data.taskId !== taskId) {
    throw new ModeError("config.taskId disagrees with the envelope it carries");
  }
  if (singularEnvelope.data.initiativeId !== initiativeId) {
    throw new ModeError("config.initiativeId disagrees with the envelope it carries");
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
    envelope: singularEnvelope.data,
    walks: null,
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
    envelope: config.envelope,
    // Undefined, not null: the option is additive, and a caller that never
    // heard of C3 must produce exactly the object it always produced.
    ...(config.walks === null ? {} : { walks: config.walks }),
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
