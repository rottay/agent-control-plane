import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import { PS_BINARY, PS_MAX_BUFFER_BYTES, PS_TIMEOUT_MS } from "../constants/index.js";
import { IdentityProbeError } from "../errors/index.js";

/**
 * Is the process recorded in the lock file still the daemon that wrote it?
 *
 * This is the only question in the package where being wrong is dangerous. A
 * wrong "yes" refuses a start that should have succeeded, which is annoying. A
 * wrong "no" lets an operator reclaim a lock a live daemon still holds, which
 * corrupts the thing the lock exists to protect. So the probe is deliberately
 * asymmetric: it says NOT_SAME only when it can prove it, and INDETERMINATE
 * whenever it cannot.
 *
 * PIDs are reused. A pid alone answers nothing, so the recorded identity also
 * carries the process start time and a digest of its argv.
 */

export type IdentityVerdict =
  | "SAME_LIVE_DAEMON"
  | "NOT_SAME"
  | "INDETERMINATE"
  | "UNSUPPORTED_PLATFORM";

export interface RecordedIdentity {
  readonly pid: number;
  readonly startToken: string;
  readonly argvDigest: string;
}

export interface ProcessFacts {
  readonly startToken: string;
  readonly argvDigest: string;
}

/**
 * How the probe learns about a process.
 *
 * Injectable so every verdict, including the ones that need a hostile or
 * unavailable operating system, is testable without spawning anything.
 */
export interface ProcessInspector {
  /** Facts about a live process, null if no such process exists. */
  inspect(pid: number): Promise<ProcessFacts | null>;
}

/**
 * Fixed argv. Nothing here is interpolated except the pid, and no shell is
 * involved, so there is no string for an argument to escape out of.
 */
const PS_ARGV: readonly string[] = Object.freeze(["-ww", "-o", "lstart=,command=", "-p"]);

/** Collapse whitespace runs, so two renderings of one argv agree. */
const WHITESPACE_RUN = new RegExp("[ \\t]+", "g");

/**
 * One ps line: a fixed five-field C-locale start time, then the command.
 *
 * Built from a string rather than written inline only to keep the pattern on
 * one readable line. Under LC_ALL=C lstart renders as, for example,
 * "Wed Aug 27 18:46:07 2026", which is what the five groups match.
 */
const PS_LINE = new RegExp(
  "^(\\S+\\s+\\S+\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})\\s+(.*)$",
);

/**
 * Normalise a command line before digesting it.
 *
 * ps renders argv space-joined, so the digest of the recorded vector and the
 * digest of the observed line can only agree on a normalised form. Whitespace
 * runs collapse; nothing else is touched.
 */
export function commandDigest(commandLine: string): string {
  const collapsed = commandLine.trim().replace(WHITESPACE_RUN, " ");
  return createHash("sha256").update(collapsed).digest("hex");
}

/** Split one ps output line into its start token and its command line. */
export function parsePsLine(line: string): ProcessFacts | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const match = PS_LINE.exec(trimmed);
  if (match === null) return null;
  const startToken = match[1];
  const command = match[2];
  if (startToken === undefined || command === undefined || command === "") return null;
  return {
    startToken: startToken.replace(WHITESPACE_RUN, " "),
    argvDigest: commandDigest(command),
  };
}

/**
 * Interpret a completed `ps` invocation.
 *
 * Pure, so every branch is testable without a process. The distinction it
 * enforces is the one C6 found missing: exit 1 means the pid does not exist,
 * which is an answer. Exit 0 with output nobody can parse is **not** an answer,
 * and resolving it to "absent" made an unreadable line indistinguishable from a
 * dead process — which explicit recovery would then act on by removing a live
 * daemon's lock.
 */
export function interpretPsResult(
  exitCode: number | string | undefined,
  stdout: string,
): ProcessFacts | null {
  if (exitCode === 1) return null;
  const line = stdout.split("\n").find((candidate) => candidate.trim() !== "");
  if (line === undefined) {
    throw new IdentityProbeError("ps succeeded but reported nothing about the process");
  }
  const facts = parsePsLine(line);
  if (facts === null) {
    throw new IdentityProbeError("ps output could not be parsed; the identity is unknown");
  }
  return facts;
}

/**
 * The Darwin inspector.
 *
 * An absolute path, so PATH cannot decide which program answers the question.
 * LC_ALL=C, so the date format is the one PS_LINE was written against rather
 * than whatever the operator's locale produces. No shell, a time bound and an
 * output bound.
 */
export function createPsInspector(): ProcessInspector {
  return {
    inspect(pid: number): Promise<ProcessFacts | null> {
      if (!Number.isInteger(pid) || pid <= 0) {
        return Promise.reject(new IdentityProbeError("a pid must be a positive integer"));
      }
      return new Promise((resolvePromise, rejectPromise) => {
        execFile(
          PS_BINARY,
          [...PS_ARGV, String(pid)],
          {
            env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
            timeout: PS_TIMEOUT_MS,
            maxBuffer: PS_MAX_BUFFER_BYTES,
            windowsHide: true,
          },
          (error, stdout) => {
            const code =
              error === null ? 0 : (error as { code?: number | string }).code;
            // Anything other than a clean run or a plain "no such pid" is a
            // probe that did not work, not a process that is not there.
            if (error !== null && code !== 1) {
              rejectPromise(
                new IdentityProbeError("the identity probe could not run: " + error.message),
              );
              return;
            }
            try {
              resolvePromise(interpretPsResult(code, stdout));
            } catch (thrown: unknown) {
              rejectPromise(
                thrown instanceof Error
                  ? thrown
                  : new IdentityProbeError("the identity probe failed for an unknown reason"),
              );
            }
          },
        );
      });
    },
  };
}

/**
 * Classify a recorded identity.
 *
 * The asymmetry is the point:
 *
 * - no such process, or a different start time, is proof of NOT_SAME, because a
 *   recycled pid has a start time later than the one recorded;
 * - the start time matching while the argv digest does not is proof of nothing,
 *   so it is INDETERMINATE. It could be a rendering difference or a different
 *   program, and both are reasons to leave the lock alone;
 * - a probe that cannot run at all is INDETERMINATE, never NOT_SAME.
 */
export async function probeIdentity(
  recorded: RecordedIdentity,
  inspector: ProcessInspector,
  platform: string = process.platform,
): Promise<IdentityVerdict> {
  if (platform !== "darwin") return "UNSUPPORTED_PLATFORM";

  let facts: ProcessFacts | null;
  try {
    facts = await inspector.inspect(recorded.pid);
  } catch {
    return "INDETERMINATE";
  }

  if (facts === null) return "NOT_SAME";
  if (facts.startToken !== recorded.startToken) return "NOT_SAME";
  if (facts.argvDigest !== recorded.argvDigest) return "INDETERMINATE";
  return "SAME_LIVE_DAEMON";
}

/**
 * Read this process's own facts, for recording into a fresh lock file.
 *
 * Deliberately asks `ps` rather than digesting `process.argv`. The two are not
 * the same string: `process.argv` is what this runtime parsed, while `ps`
 * reports the operating system's own rendering of the command line, and under a
 * test runner or any launcher that re-executes, they differ outright. Recording
 * one and later observing the other would make every live daemon look
 * indeterminate. Both sides of the comparison must come from `ps`.
 */
export async function ownIdentity(inspector: ProcessInspector): Promise<RecordedIdentity> {
  const facts = await inspector.inspect(process.pid);
  if (facts === null) {
    throw new IdentityProbeError("this process could not observe itself");
  }
  return { pid: process.pid, startToken: facts.startToken, argvDigest: facts.argvDigest };
}
