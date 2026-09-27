import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  CONTRACT_VERSION,
  TERMINAL_STATES,
  VerificationReceipt,
  WRITER_ID_UNISSUED,
  WorkerIdentityString,
  buildV2IdempotencyKey,
  commitMessageWithReceiptTrailer,
} from "@acp/contracts";
import {
  ARTIFACT_ACCESS_POLICY_IDS,
  LedgerVerificationRefusedError,
  canonicalJsonStringify,
  receiptVerificationColumns,
  supervisedWorkerIdFor,
  verificationPolicySha256,
  writerWorkerIdFor,
} from "@acp/ledger";
import { readRecordedTask, writerIdIssuerFor } from "@acp/runtime";
import type { WorktreeObservation } from "@acp/runtime";

import { createGitObserver, observeWorktree } from "../git-observer/index.js";
import { hashCopyTree, indexPaths } from "../tree-hasher/index.js";
import type { TreeHashRefusal } from "../tree-hasher/index.js";

import type {
  CheckTermination,
  RanCheck,
  RunnerBounds,
  RunnerRefusal,
  VerificationRunInput,
  VerificationRunOutcome,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and are
 * re-exported here unchanged (owner law §7).
 */
export type {
  CheckTermination,
  RanCheck,
  RunnerBounds,
  RunnerRefusal,
  VerificationRunInput,
  VerificationRunOutcome,
} from "./types/index.js";

/**
 * The verification runner — P-16/C, ADR 0123 (decisions 227, 230, 234-236).
 *
 * The plane's first real verification, and its fifth spawn site: it runs **only the
 * check commands the recorded envelope declares**, in a disposable copy of the
 * worktree, under an environment it builds, within bounds, and its one product is a
 * private `RECEIPT` artifact and the receipt-form `VERIFICATION_COMPLETED` that the
 * ledger's door admits into `verification_read_model`. It is a daemon-internal
 * function: no route and no verb reaches it; the recorded walk's verification phase
 * calls it before step 6 (P-16/D1, ADR 0124).
 *
 * ## The order is the design
 *
 * Everything that can refuse does so before the first spawn, and names its word:
 *
 * 1. The scratch root: absolute, real, a directory, not a link, not inside the
 *    worktree (`RUNNER_SCRATCH_ROOT_INVALID`); the bounds tighten only
 *    (`RUNNER_INPUT_INVALID`).
 * 2. The task, through runtime's `readRecordedTask`: the envelope held to its intake
 *    digest and the route to the intake's resolution (`RUNNER_TASK_UNREADABLE`, the
 *    reader's word carried); not in a terminal state (`RUNNER_TASK_TERMINAL`).
 * 3. The envelope: declared checks (`RUNNER_CHECKS_UNDECLARED`), a write-set
 *    (`RUNNER_WRITE_SET_EMPTY`; since P-16/D2 both are refused before spend at the
 *    recorded start, the empty write-set at the intake too, and this is the
 *    backstop), a title the
 *    commit body rule admits (`RUNNER_COMMIT_BODY_INVALID`), a writer label that is a
 *    worker identity other than the runner's.
 * 4. The object format, before any observation could misread a 64-hex id: `sha1` or
 *    `OBJECT_FORMAT_UNSUPPORTED`, class `CAPABILITY_UNSUPPORTED` (P-38 owns sha256);
 *    and the worktree is its repository's root, realpath-equal to `rev-parse
 *    --show-toplevel` (`RUNNER_WORKTREE_NOT_ROOT`, P-16/D1 NB-3).
 * 5. The observation, through the one git read authority: a HEAD
 *    (`BASE_HEAD_MISSING`), and no change outside the declared write-set
 *    (`RUNNER_WRITE_SET_VIOLATION`: no receipt, the quarantine is the conformance
 *    gate's).
 * 6. The writer id's issuer from the attempt's recorded segments
 *    (`WRITER_ID_UNISSUED`), and the verifier's run id: the next ordinal of the
 *    attempt, its id `supervisedWorkerIdFor(task, flat, "verifier", runId)`.
 * 7. The copy (below) and its tree, hashed in process; every index path the
 *    observation did not report as changed or untracked must hash to the index's own
 *    mode and object id (`RUNNER_INDEX_DIVERGED`: an `assume-unchanged` or
 *    `skip-worktree` flag hid a change, P-16/D1 NB-2).
 * 8. The checks, in declared order, failing fast: the first nonzero or killed check
 *    ends the run `FAIL`, and the receipt lists the checks that ran.
 * 9. The original worktree observed again: any observed difference is `FAIL` (ND-16).
 * 10. The receipt, parsed by `VerificationReceipt`, published through the plane, and
 *     its event appended through `Ledger.append`; a refusal of either is carried
 *     (`RUNNER_PUBLICATION_REFUSED`, `RUNNER_RECORD_REFUSED`).
 * 11. The per-run directory removed, in `finally`, and only it: made owner-writable
 *     first by a no-follow walk, so a check that removed its own write bits cannot
 *     leave it behind (P-16/D1 NB-4).
 *
 * ## The copy
 *
 * One per-run directory under the scratch root holds three siblings: `tree`, the copy
 * the checks run in; `home` and `tmp`, their `HOME` and `TMPDIR`. The copy holds
 * exactly the tree the receipt names: every index path plus every observed untracked
 * path (all inside the write-set, or step 5 refused), minus what is deleted, copied
 * with no-follow (a link is copied as a link), never `.git`, never an ignored file,
 * bounded in files and bytes (`RUNNER_COPY_BOUND_EXCEEDED`). So the tree hashed and
 * the tree the checks saw are one set of bytes. A check that needs an ignored
 * artifact (dependencies) must build it: real toolchains are out of this cut.
 *
 * ## The environment, and the absent sandbox
 *
 * Built, never inherited: `PATH=/usr/bin:/bin`, `LC_ALL=C`, `HOME` and `TMPDIR` in
 * the per-run directory, and Git confined to the copy (`GIT_CEILING_DIRECTORIES` at
 * the scratch root, so a check's `git` finds no repository above it;
 * `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`). Nothing of the parent's
 * environment reaches a check, and this file never names it. There is **no operating
 * system sandbox** in this cut: a declared check is a shell command and can reach
 * any path the daemon can. The confinement is by construction -- declared commands
 * only, a disposable cwd, a built environment, bounds -- and the mechanism is P-25's.
 *
 * ## Bounds, and what a check's output becomes
 *
 * Per-check wall time, per-check output bytes (stdout and stderr counted raw, as
 * they arrive: `maxBuffer` does nothing on `spawn`), and the run's total wall time.
 * Exceeding one kills the check's whole process group, grandchildren included, destroys
 * both pipes and records `137` at once. A check that exits is settled with its own code
 * when both pipes close or at its deadline, whichever comes first, so a grandchild that
 * left the group (`setsid`) and holds a pipe cannot hold the run past its bound; that
 * escapee is not reaped, a limit P-25 owns (P-16/D1 NB-1, ND-14). A check that could not be started records `127`, one ended by a
 * signal `128 +` its number (an unmapped signal `255`), all `FAIL`. The output is
 * counted and discarded: it reaches no row, event, stream, log, error or artifact.
 */

/** The closed vocabulary, sorted. The hasher's three words are its own. */
export const RUNNER_REFUSALS = [
  "BASE_HEAD_MISSING",
  "OBJECT_FORMAT_UNSUPPORTED",
  "RUNNER_CHECKS_UNDECLARED",
  "RUNNER_COMMIT_BODY_INVALID",
  "RUNNER_COPY_BOUND_EXCEEDED",
  "RUNNER_COPY_FAILED",
  "RUNNER_INDEX_DIVERGED",
  "RUNNER_INPUT_INVALID",
  "RUNNER_OBSERVATION_FAILED",
  "RUNNER_PUBLICATION_REFUSED",
  "RUNNER_RECEIPT_INVALID",
  "RUNNER_RECORD_REFUSED",
  "RUNNER_SCRATCH_ROOT_INVALID",
  "RUNNER_TASK_TERMINAL",
  "RUNNER_TASK_UNREADABLE",
  "RUNNER_WORKTREE_NOT_ROOT",
  "RUNNER_WRITE_SET_EMPTY",
  "RUNNER_WRITE_SET_VIOLATION",
  "WRITER_ID_UNISSUED",
] as const;

/** The runner's own bounds: ceilings a caller may tighten and never loosen. */
export const RUNNER_BOUNDS: RunnerBounds = Object.freeze({
  checkTimeoutMs: 10 * 60 * 1000,
  checkOutputBytes: 8 * 1024 * 1024,
  runTimeoutMs: 30 * 60 * 1000,
  copyFileCount: 20_000,
  copyTotalBytes: 256 * 1024 * 1024,
});

/** The verifier's label: the runner itself, a worker identity no writer holds. */
export const VERIFIER_IDENTITY = "acp/verification-runner/verifier/01";

/** The one shell a declared check runs under, by absolute path. */
const CHECK_SHELL = "/bin/sh";

/** The `PATH` every check sees, and nothing else of the parent's. */
const CHECK_PATH = "/usr/bin:/bin";

/**
 * POSIX signal numbers identical on darwin and linux, for `128 +` the number. A signal
 * outside the list records 255. Closed, so no `node:os` is needed to read a number.
 */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGTERM: 15,
});

/** The exit code of a check that could not be started: the shell's "not found". */
const EXIT_UNSPAWNABLE = 127;
/** The exit code of a check the runner killed for a bound: 128 + SIGKILL. */
const EXIT_KILLED_BY_BOUND = 128 + 9;
/** The exit code of a check ended by a signal the list does not name. */
const EXIT_UNMAPPED = 255;

/** The artifact's media type and profile: the receipt's canonical JSON, plaintext at rest. */
const RECEIPT_MEDIA_TYPE = "application/json";
const RECEIPT_ENCRYPTION_PROFILE = "local-plaintext-v1";
/** How long the plane's holding of the receipt's blob lasts. */
const RECEIPT_HOLDING_WINDOW_MS = 5 * 60 * 1000;

/**
 * What one check ended as, as the number the receipt records (ND-3). Pure.
 *
 * Unspawnable is 127, a bound's kill 137, an exit its own code, a signal `128 +` its
 * number from the closed list or 255. Never `-0`, never outside `[0, 255]`.
 */
export function checkExitCode(termination: CheckTermination): number {
  if (termination.spawnFailed) return EXIT_UNSPAWNABLE;
  if (termination.killedByBound) return EXIT_KILLED_BY_BOUND;
  const code = termination.code;
  if (code !== null && Number.isInteger(code) && code >= 0 && code <= 255) return code === 0 ? 0 : code;
  const signal = termination.signal;
  if (code === null && signal !== null) {
    const number = SIGNAL_NUMBERS[signal];
    return number === undefined ? EXIT_UNMAPPED : 128 + number;
  }
  return EXIT_UNMAPPED;
}

/**
 * The environment every check runs under: constants, plus the per-run directory and
 * the admitted scratch root. Nothing inherited (L-P16C-1).
 */
function builtEnvironment(runDirectory: string, scratchRoot: string): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: CHECK_PATH,
    LC_ALL: "C",
    HOME: join(runDirectory, "home"),
    TMPDIR: join(runDirectory, "tmp"),
    GIT_CEILING_DIRECTORIES: scratchRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
}

type Refused = Extract<VerificationRunOutcome, { ok: false }>;

function refuse(
  refusal: RunnerRefusal | TreeHashRefusal,
  at: string,
  word: string | null = null,
): Refused {
  const refusalClass = refusal === "OBJECT_FORMAT_UNSUPPORTED" ? ("CAPABILITY_UNSUPPORTED" as const) : null;
  return Object.freeze({ ok: false as const, refusal, at, word, refusalClass });
}

/** Whether `inner` is `outer` or below it, by path components. */
function within(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/** The scratch root, admitted, or null. */
function admittedScratchRoot(scratchRoot: unknown, worktreePath: string): string | null {
  if (typeof scratchRoot !== "string" || !isAbsolute(scratchRoot) || resolve(scratchRoot) !== scratchRoot) return null;
  try {
    const stats = lstatSync(scratchRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
    if (realpathSync(scratchRoot) !== scratchRoot) return null;
    const worktree = realpathSync(worktreePath);
    if (within(scratchRoot, worktree)) return null;
  } catch {
    return null;
  }
  return scratchRoot;
}

/** The bounds in force: the runner's, tightened by the caller's, or null for a loosened or malformed one. */
function boundsInForce(requested: Partial<RunnerBounds> | undefined): RunnerBounds | null {
  if (requested === undefined) return RUNNER_BOUNDS;
  const merged: Record<string, number> = { ...RUNNER_BOUNDS };
  for (const key of Object.keys(RUNNER_BOUNDS) as (keyof RunnerBounds)[]) {
    const value: unknown = requested[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > RUNNER_BOUNDS[key]) return null;
    merged[key] = value;
  }
  return merged as unknown as RunnerBounds;
}

/** Every observed path inside the declared write-set, or the index of the first that is not. */
function outsideWriteSet(observation: WorktreeObservation, declared: ReadonlySet<string>): string | null {
  for (const [index, change] of observation.trackedChanges.entries()) {
    if (!declared.has(change.path)) return "observation.trackedChanges[" + String(index) + "]";
  }
  for (const [index, path] of observation.untrackedPaths.entries()) {
    if (!declared.has(path)) return "observation.untrackedPaths[" + String(index) + "]";
  }
  return null;
}

type CopyOutcome = { readonly ok: true; readonly paths: readonly string[] } | Refused;

/**
 * Copy `paths` from the worktree into `target`, no-follow, bounded. A path absent from
 * the worktree is a deletion and is not copied; a parent that is a link, or an entry
 * that is neither a file nor a link, is refused by name.
 */
function copyTree(worktreePath: string, target: string, paths: readonly string[], bounds: RunnerBounds): CopyOutcome {
  const copied: string[] = [];
  let bytes = 0;
  for (const [index, path] of paths.entries()) {
    const at = "copy.paths[" + String(index) + "]";
    const parts = path.split("/");
    let parent = worktreePath;
    let absentParent = false;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      try {
        const stats = lstatSync(parent);
        if (stats.isSymbolicLink() || !stats.isDirectory()) return refuse("TREE_ENTRY_UNSUPPORTED", at);
      } catch (error: unknown) {
        if ((error as { code?: unknown }).code === "ENOENT") {
          absentParent = true;
          break;
        }
        return refuse("RUNNER_COPY_FAILED", at);
      }
    }
    if (absentParent) continue;
    const source = join(worktreePath, path);
    let stats;
    try {
      stats = lstatSync(source);
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code === "ENOENT") continue;
      return refuse("RUNNER_COPY_FAILED", at);
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) return refuse("TREE_ENTRY_UNSUPPORTED", at);
    bytes += stats.isFile() ? stats.size : 0;
    if (copied.length + 1 > bounds.copyFileCount || bytes > bounds.copyTotalBytes) {
      return refuse("RUNNER_COPY_BOUND_EXCEEDED", at);
    }
    const destination = join(target, path);
    try {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      if (stats.isSymbolicLink()) {
        symlinkSync(readlinkSync(source, { encoding: "buffer" }), destination);
      } else {
        copyFileSync(source, destination, constants.COPYFILE_EXCL);
        chmodSync(destination, (stats.mode & 0o100) === 0 ? 0o644 : 0o755);
      }
    } catch {
      return refuse("RUNNER_COPY_FAILED", at);
    }
    copied.push(path);
  }
  return { ok: true, paths: copied };
}

/**
 * Run one declared check, bounded, in its own process group. Its output is counted and
 * discarded; the answer is how it ended.
 */
function runCheck(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
  bounds: RunnerBounds,
  deadline: number,
): Promise<CheckTermination> {
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(CHECK_SHELL, ["-c", command], {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      settle({ spawnFailed: true, killedByBound: false, code: null, signal: null });
      return;
    }
    let settled = false;
    let killedByBound = false;
    let spawnFailed = false;
    let counted = 0;
    let exited: { readonly code: number | null; readonly signal: string | null } | null = null;
    const group = child.pid;
    const stdout = child.stdout;
    const stderr = child.stderr;
    const killGroup = (): void => {
      if (group === undefined) return;
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      // Never wait on a pipe a process outside the group may hold (NB-1, ND-14).
      stdout.destroy();
      stderr.destroy();
      settle({ spawnFailed, killedByBound, code, signal });
    };
    // A bound settles at once: the group is killed, the pipes destroyed, 137 recorded.
    const bound = (): void => {
      if (killedByBound || settled) return;
      killedByBound = true;
      killGroup();
      finish(null, "SIGKILL");
    };
    // The deadline: a check that already exited keeps its own code; one still running is bound.
    const timer = setTimeout(
      () => {
        if (exited !== null) finish(exited.code, exited.signal);
        else bound();
      },
      Math.max(0, Math.min(bounds.checkTimeoutMs, deadline - Date.now())),
    );
    const count = (chunk: Buffer): void => {
      counted += chunk.length;
      if (counted > bounds.checkOutputBytes) bound();
    };
    stdout.on("data", count);
    stderr.on("data", count);
    child.on("error", () => {
      spawnFailed = group === undefined;
      finish(null, null);
    });
    // The shell is gone: its group goes with it, so a background grandchild that stayed
    // in the group cannot outlive the check. One that left it may still hold a pipe, so
    // the exit is remembered and settled on `close` or at the deadline, whichever first.
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      killGroup();
    });
    child.on("close", (code, signal) => {
      finish(exited?.code ?? code, exited?.signal ?? signal);
    });
  });
}

/**
 * Give the owner back its bits on every directory under `directory`, no-follow (NB-4):
 * a check that `chmod 000`ed a directory in its copy cannot leave the run behind. A
 * link is never followed and a file's mode is not touched; best effort, since `rmSync`
 * is the step that reports.
 */
function ownerWritable(directory: string): void {
  try {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return;
    chmodSync(directory, (stats.mode & 0o7777) | 0o700);
    for (const name of readdirSync(directory)) ownerWritable(join(directory, name));
  } catch {
    // Gone, or not ours to open: the removal below is the step that answers.
  }
}

/** The observation's comparable form: the same bytes before and after, or a difference. */
function observationKey(observation: WorktreeObservation): string {
  return canonicalJsonStringify({
    head: observation.head,
    trackedChanges: observation.trackedChanges.map((change) => ({ path: change.path, sha256: change.sha256 })),
    untrackedPaths: [...observation.untrackedPaths],
  });
}

/** Run the recorded task's declared checks, and record the receipt. */
export async function runVerification(input: VerificationRunInput): Promise<VerificationRunOutcome> {
  const now = input.now ?? ((): string => new Date().toISOString());
  const mintId = input.mintId ?? ((): string => randomUUID());

  // 1. The worktree, the scratch root and the bounds.
  const worktreePath = input.worktreePath;
  if (typeof worktreePath !== "string" || !isAbsolute(worktreePath) || resolve(worktreePath) !== worktreePath) {
    return refuse("RUNNER_INPUT_INVALID", "worktreePath");
  }
  const scratchRoot = admittedScratchRoot(input.scratchRoot, worktreePath);
  if (scratchRoot === null) return refuse("RUNNER_SCRATCH_ROOT_INVALID", "scratchRoot");
  const bounds = boundsInForce(input.bounds);
  if (bounds === null) return refuse("RUNNER_INPUT_INVALID", "bounds");

  // 2. The task, read back whole and held to its intake.
  const read = readRecordedTask({ ledger: input.ledger, plane: input.plane, taskId: input.taskId, route: input.route });
  if (!read.ok) return refuse("RUNNER_TASK_UNREADABLE", read.at, read.refusal);
  const task = read.task;
  const state = input.ledger.getTask(task.taskId)?.currentState ?? null;
  if (state === null) return refuse("RUNNER_TASK_UNREADABLE", "task");
  if (TERMINAL_STATES.includes(state)) return refuse("RUNNER_TASK_TERMINAL", "task.currentState");

  // 3. The envelope's own facts.
  const envelope = task.envelope;
  const commands = envelope.validation.commands;
  if (commands.length === 0) return refuse("RUNNER_CHECKS_UNDECLARED", "envelope.validation.commands");
  if (envelope.writeSet.length === 0) return refuse("RUNNER_WRITE_SET_EMPTY", "envelope.writeSet");
  try {
    commitMessageWithReceiptTrailer(envelope.title, "0".repeat(64));
  } catch {
    return refuse("RUNNER_COMMIT_BODY_INVALID", "envelope.title");
  }
  if (!WorkerIdentityString.safeParse(input.writerIdentity).success || input.writerIdentity === VERIFIER_IDENTITY) {
    return refuse("RUNNER_INPUT_INVALID", "writerIdentity");
  }

  // 4. The object format, before anything reads an object id.
  const git = createGitObserver(worktreePath);
  const format = git({ verb: "rev-parse", args: ["--show-object-format"] });
  if (!format.ok) return refuse("RUNNER_OBSERVATION_FAILED", "objectFormat");
  if (format.stdout.trim() !== "sha1") return refuse("OBJECT_FORMAT_UNSUPPORTED", "objectFormat");
  // The worktree is its repository's root: a subdirectory, or a plain directory inside
  // another repository, would observe and copy a tree the receipt does not name (NB-3).
  const toplevel = git({ verb: "rev-parse", args: ["--show-toplevel"] });
  if (!toplevel.ok) return refuse("RUNNER_OBSERVATION_FAILED", "toplevel");
  try {
    if (realpathSync(toplevel.stdout.replace(/\n$/, "")) !== realpathSync(worktreePath)) {
      return refuse("RUNNER_WORKTREE_NOT_ROOT", "worktreePath");
    }
  } catch {
    return refuse("RUNNER_WORKTREE_NOT_ROOT", "worktreePath");
  }

  // 5. The observation: a HEAD, and nothing outside the write-set.
  const observed = observeWorktree(git, worktreePath);
  if (!observed.ok) return refuse("RUNNER_OBSERVATION_FAILED", "observation");
  const observation = observed.observation;
  if (observation.head === null) return refuse("BASE_HEAD_MISSING", "observation.head");
  const declared = new Set(envelope.writeSet);
  const outside = outsideWriteSet(observation, declared);
  if (outside !== null) return refuse("RUNNER_WRITE_SET_VIOLATION", outside);
  const listed = git({ verb: "ls-files", args: ["-s", "-z"] });
  if (!listed.ok) return refuse("RUNNER_OBSERVATION_FAILED", "index");
  const index = indexPaths(listed.stdout);
  if (!index.ok) return refuse(index.refusal, index.at);
  if (observation.untrackedPaths.some((path) => path.includes("�"))) {
    return refuse("TREE_PATH_UNSUPPORTED", "observation.untrackedPaths");
  }

  // 6. The writer's issuer, and the verifier's run.
  const { revisionNumber, attemptNumber } = task.revision;
  const flat = task.attempt;
  const segments = input.ledger.listRouteSegments(task.taskId, revisionNumber, attemptNumber);
  if (writerIdIssuerFor(segments) === null) return refuse(WRITER_ID_UNISSUED, "route.segments");
  const recorded = input.ledger.listVerifications(task.taskId, revisionNumber, attemptNumber);
  const runId = recorded.reduce((last, row) => Math.max(last, row.verifierRunId), 0) + 1;
  const verifierWorkerId = supervisedWorkerIdFor(task.taskId, flat, "verifier", runId);
  const writerWorkerId = writerWorkerIdFor(task.taskId, flat);

  // 7-11. The copy, its tree, the checks, and the record; the per-run directory goes last.
  const runDirectory = join(scratchRoot, "acp-verify-" + mintId());
  let made: { readonly dev: number; readonly ino: number } | null = null;
  try {
    try {
      mkdirSync(runDirectory, { mode: 0o700 });
      const stats = lstatSync(runDirectory);
      made = { dev: stats.dev, ino: stats.ino };
      for (const child of ["tree", "home", "tmp"]) mkdirSync(join(runDirectory, child), { mode: 0o700 });
    } catch {
      return refuse("RUNNER_COPY_FAILED", "scratchRoot");
    }
    const copyRoot = join(runDirectory, "tree");
    const wanted = [...new Set([...index.paths, ...observation.untrackedPaths])].sort();
    const copy = copyTree(worktreePath, copyRoot, wanted, bounds);
    if (!copy.ok) return copy;
    const tree = hashCopyTree(copyRoot, copy.paths);
    if (!tree.ok) return refuse(tree.refusal, tree.at);
    // Every index path the observation reported as neither changed nor untracked is
    // held to the index's own mode and object id, before any check runs (NB-2): a
    // flag that hid a change from the observation cannot hide it from the tree.
    const reported = new Set([...observation.trackedChanges.map((change) => change.path), ...observation.untrackedPaths]);
    const hashed = new Map(tree.entries.map((entry) => [entry.path, entry]));
    for (const [position, entry] of index.entries.entries()) {
      if (reported.has(entry.path)) continue;
      const copied = hashed.get(entry.path);
      if (copied?.mode !== entry.mode || copied.sha1 !== entry.sha1) {
        return refuse("RUNNER_INDEX_DIVERGED", "index[" + String(position) + "]");
      }
    }

    // 8. The checks, in declared order, failing fast.
    const env = builtEnvironment(runDirectory, scratchRoot);
    const deadline = Date.now() + bounds.runTimeoutMs;
    const checks: { command: string; exitCode: number; ranAt: string }[] = [];
    let passed = true;
    for (const command of envelope.validation.commands) {
      const ranAt = now();
      const termination = await runCheck(command, copyRoot, env, bounds, deadline);
      const exitCode = checkExitCode(termination);
      checks.push({ command, exitCode, ranAt });
      if (exitCode !== 0 || termination.killedByBound) {
        passed = false;
        break;
      }
    }

    // 9. The original worktree, observed again: a writer racing the verifier is seen.
    const again = observeWorktree(git, worktreePath);
    if (!again.ok || observationKey(again.observation) !== observationKey(observation)) passed = false;

    // 10. The receipt, its artifact and its event.
    let receipt: VerificationReceipt;
    try {
      receipt = VerificationReceipt.parse({
        contractVersion: CONTRACT_VERSION,
        taskId: task.taskId,
        revisionNumber,
        attemptNumber,
        baseSha: observation.head,
        treeSha: tree.treeSha,
        objectFormat: "sha1",
        policySha256: verificationPolicySha256({
          commands,
          independentVerifierRequired: envelope.validation.independentVerifierRequired,
          commitPolicy: envelope.commitPolicy,
        }),
        declaredWriteSet: [...envelope.writeSet],
        observedTrackedChanges: observation.trackedChanges.map((change) => ({ path: change.path, sha256: change.sha256 })),
        observedUntrackedPaths: [...observation.untrackedPaths],
        writer: { identity: input.writerIdentity, workerId: writerWorkerId },
        verifier: { identity: VERIFIER_IDENTITY, workerId: verifierWorkerId, runId },
        runStatus: passed ? "PASS" : "FAIL",
        checks,
        commitMessageBody: envelope.title,
        pushAuthorized: false,
      });
    } catch {
      return refuse("RUNNER_RECEIPT_INVALID", "receipt");
    }
    const columns = receiptVerificationColumns(receipt);
    const content = Buffer.from(canonicalJsonStringify(receipt), "utf8");
    const recordedAt = now();
    const artifactReferenceId = mintId();
    const commandId = mintId();
    const published = input.plane.publish({
      content,
      mediaType: RECEIPT_MEDIA_TYPE,
      encryptionStatus: "PLAINTEXT",
      encryptionProfile: RECEIPT_ENCRYPTION_PROFILE,
      commandId,
      artifactPinId: mintId(),
      reference: {
        artifactReferenceId,
        artifactClass: "RECEIPT",
        classification: "INTERNAL",
        scopeKind: "TASK",
        scopeId: task.taskId,
        producerIdentity: VERIFIER_IDENTITY,
        accessPolicyId: ARTIFACT_ACCESS_POLICY_IDS[0],
        retentionClass: "PERMANENT",
        expiresAt: null,
      },
      recordedBy: VERIFIER_IDENTITY,
      intention: {
        eventId: mintId(),
        idempotencyKey: "receipt/" + commandId + "/intended",
        occurredAt: recordedAt,
        recordedAt,
      },
      terminal: {
        eventId: mintId(),
        idempotencyKey: "receipt/" + commandId + "/succeeded",
        occurredAt: recordedAt,
        recordedAt,
      },
      holding: {
        holder: VERIFIER_IDENTITY,
        holderPid: process.pid,
        acquiredAt: recordedAt,
        expiresAt: new Date(Date.parse(recordedAt) + RECEIPT_HOLDING_WINDOW_MS).toISOString(),
      },
    });
    if (published.verb !== "PUBLISHED") {
      return refuse("RUNNER_PUBLICATION_REFUSED", "receipt", "refusal" in published ? published.refusal : published.verb);
    }

    const transitionId = "verification.run." + String(runId);
    const event = {
      contractVersion: CONTRACT_VERSION,
      eventId: mintId(),
      taskId: task.taskId,
      attempt: flat,
      transitionId,
      idempotencyKey: buildV2IdempotencyKey({
        stream: "control_plane_events",
        taskId: task.taskId,
        revisionNumber,
        attemptNumber,
        transitionId,
      }),
      type: "VERIFICATION_COMPLETED",
      // Same state: the runner records a fact and moves no lifecycle (P-16/D1 places it).
      fromState: state,
      toState: state,
      emittedBy: VERIFIER_IDENTITY,
      occurredAt: recordedAt,
      recordedAt,
      correlationId: null,
      causationId: null,
      payload: {
        revisionNumber,
        attemptNumber,
        verification: {
          receiptSha256: columns.receiptSha256,
          artifactReferenceId: published.reference.artifactReferenceId,
          baseSha: columns.baseSha,
          treeSha: columns.treeSha,
          policySha256: columns.policySha256,
          writeSetSha256: columns.writeSetSha256,
          checksSha256: columns.checksSha256,
          runStatus: columns.runStatus,
          allChecksZero: columns.allChecksZero,
          writer: { ...columns.writer },
          verifier: { ...columns.verifier },
        },
      },
    };
    try {
      input.ledger.append(event);
    } catch (error: unknown) {
      if (error instanceof LedgerVerificationRefusedError) return refuse("RUNNER_RECORD_REFUSED", error.at, error.reason);
      const code = (error as { code?: unknown }).code;
      return refuse("RUNNER_RECORD_REFUSED", "event", typeof code === "string" ? code : null);
    }

    const ran: RanCheck[] = checks.map((check) => Object.freeze({ command: check.command, exitCode: check.exitCode }));
    return Object.freeze({
      ok: true as const,
      runStatus: columns.runStatus,
      receiptSha256: columns.receiptSha256,
      artifactReferenceId: published.reference.artifactReferenceId,
      runId,
      verifierWorkerId,
      treeSha: tree.treeSha,
      checks: Object.freeze(ran),
    });
  } finally {
    // 11. Only the directory this run made, and only while it is still that directory.
    if (made !== null) {
      try {
        const stats = lstatSync(runDirectory);
        if (stats.isDirectory() && stats.dev === made.dev && stats.ino === made.ino && dirname(runDirectory) === scratchRoot) {
          ownerWritable(runDirectory);
          rmSync(runDirectory, { recursive: true, force: true });
        }
      } catch {
        // Already gone.
      }
    }
  }
}
