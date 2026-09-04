/**
 * The MCP stdio transport — `@acp/tools` (V2-B4b stage 1).
 *
 * The one file in this package that imports `node:child_process`, and the one
 * file that starts anything. Duplicating a spawner is the thing being
 * prevented: two spawners drift, and the drift is found only when they
 * disagree about how to stop something, which is the moment it matters most.
 * The provider edge holds exactly this law over its own child; this package
 * has a child of its own now, with a different lifetime, and so it holds its
 * own copy of the law rather than borrowing the other's authority.
 *
 * `stdio`, `timeout` and `killSignal` are passed explicitly on every spawn
 * rather than left to defaults, because a default is a decision nobody wrote
 * down. `shell` is never passed, the environment is never spread from the
 * ambient one, and `maxBuffer` is absent because `spawn` ignores it — a
 * mandated dead argument would leave the real bound unimplemented, which is
 * the failure it would look like it was preventing.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { AdmittedStdioToolServer } from "../admission/index.js";
import type { ToolTransportConnection } from "../client/index.js";
import { TOOL_SERVER_LIFETIME_MS } from "../contract/index.js";

export interface ToolStdioConnection extends ToolTransportConnection {
  /** The child's pid, so a caller can assert a reap rather than trust one. */
  readonly pid: number;
}

/**
 * Start one admitted tool server and speak newline-delimited JSON-RPC to it.
 *
 * `lifetimeMs` is the child's hard backstop, handed to `spawn` as its
 * `timeout`. It is a parameter rather than a constant read in place for one
 * reason: a ceiling no test can reach is a number, not a bound, and five
 * minutes of real wall clock is not a test. A suite passes a small value and
 * observes the child die; production takes the default.
 */
export function openToolStdioConnection(
  server: AdmittedStdioToolServer,
  lifetimeMs: number = TOOL_SERVER_LIFETIME_MS,
): ToolStdioConnection {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(server.command, [...server.args], {
      env: { ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: lifetimeMs,
      killSignal: "SIGKILL",
    });
  } catch {
    throw new Error("tool server " + server.serverId + " could not be started");
  }

  const pid = child.pid;
  if (typeof pid !== "number") {
    throw new Error("tool server " + server.serverId + " could not be started");
  }

  // A chunk boundary can split a multi-byte character as easily as it splits a
  // frame. The decoder holds the partial code point; the frame reader upstream
  // holds the partial frame. Both carry-overs are needed and neither covers
  // the other.
  const decoder = new StringDecoder("utf8");
  const sinks: ((chunk: string) => void)[] = [];
  const enders: (() => void)[] = [];
  let ended = false;

  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const listener of enders) listener();
  };

  child.stdout.on("data", (chunk: Buffer): void => {
    const text = decoder.write(chunk);
    if (text.length === 0) return;
    for (const sink of sinks) sink(text);
  });
  // stderr is deliberately drained and discarded. A tool server's diagnostics
  // are not this plane's to carry: nothing here may hold server output, and a
  // stream nobody reads eventually fills its pipe and stalls the child.
  // `resume()` rather than an empty data handler: it discards without ever
  // materializing a chunk this package would then have to be trusted not to
  // keep.
  child.stderr.resume();
  child.on("error", end);
  child.on("exit", end);

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => {
      resolve();
    });
    child.once("error", () => {
      resolve();
    });
  });

  let closing: Promise<void> | null = null;

  return {
    pid,

    write(frame: string): void {
      if (ended || child.stdin.destroyed) {
        throw new Error("tool server " + server.serverId + " is not accepting frames");
      }
      child.stdin.write(frame);
    },

    subscribe(sink: (chunk: string) => void): void {
      sinks.push(sink);
    },

    onEnd(listener: () => void): void {
      if (ended) {
        listener();
        return;
      }
      enders.push(listener);
    },

    /**
     * Reap the child, and mean it.
     *
     * stdin is ended first so a well-behaved server sees EOF, then `SIGKILL`
     * without waiting on a grace period. The alternative — SIGTERM, then a
     * timer, then SIGKILL — buys a politer shutdown at the price of a
     * wall-clock race in every test that asserts the reap. This package's
     * whole claim is that closing reaps; a claim that holds only when a timer
     * wins is not the claim.
     *
     * Idempotent: the second call awaits the same exit the first started.
     */
    async close(): Promise<void> {
      if (closing !== null) {
        await closing;
        return;
      }
      closing = (async (): Promise<void> => {
        if (!child.stdin.destroyed) child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        end();
      })();
      await closing;
    },
  };
}
