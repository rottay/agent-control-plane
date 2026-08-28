import { RESERVED_LOOPBACK_PORTS } from "@acp/runtime";

import { PORT_PRECHECK_TIMEOUT_MS } from "./constants.js";
import { ShutdownError, StartupError } from "./errors.js";

/**
 * The daemon's states, and the stack that undoes them.
 *
 * Two ideas, kept deliberately free of any driver detail so both modes share
 * one definition of what "started" and "unwound" mean.
 *
 * The first is that **readiness is RECONCILED, not SERVER_UP**. A server that
 * is listening but has not been reconciled against the ledger is not ready, and
 * calling it ready is exactly how a derived driver quietly becomes an authority.
 *
 * The second is that acquisition order defines release order. Every resource is
 * pushed as it is acquired and released in strict reverse, each with its own
 * bound, so a failure half way through startup leaves nothing behind and a
 * shutdown cannot hang on one uncooperative step.
 */

export type DaemonMode = "SQLITE_SUPERVISOR" | "RESTATE";

export const DAEMON_MODES: readonly DaemonMode[] = Object.freeze([
  "SQLITE_SUPERVISOR",
  "RESTATE",
]);

/** Is this a mode the daemon serves? Explicit input; never inferred. */
export function isDaemonMode(value: unknown): value is DaemonMode {
  return typeof value === "string" && (DAEMON_MODES as readonly string[]).includes(value);
}

/**
 * A resource that has been acquired and must be given back.
 *
 * `release` may not throw: a release that fails takes the whole unwind with it
 * and strands everything acquired earlier. Failures are reported instead.
 */
export interface Resource {
  readonly name: string;
  release(): Promise<string | null>;
}

export interface UnwindOutcome {
  readonly released: readonly string[];
  readonly failures: readonly string[];
}

/**
 * Acquisition order in, reverse release order out.
 *
 * The stack is the only record of what this process owns, which is what makes
 * "clean up exactly what we acquired" checkable rather than aspirational.
 */
export class UnwindStack {
  readonly #resources: Resource[] = [];
  #unwound = false;

  push(resource: Resource): void {
    if (this.#unwound) {
      throw new ShutdownError("a resource was acquired after the unwind began");
    }
    this.#resources.push(resource);
  }

  get acquired(): readonly string[] {
    return this.#resources.map((resource) => resource.name);
  }

  /** Release everything in reverse. Idempotent: a second call is a no-op. */
  async unwindAll(): Promise<UnwindOutcome> {
    if (this.#unwound) return { released: [], failures: [] };
    this.#unwound = true;

    const released: string[] = [];
    const failures: string[] = [];
    while (this.#resources.length > 0) {
      const resource = this.#resources.pop();
      if (resource === undefined) break;
      try {
        const failure = await resource.release();
        if (failure === null) released.push(resource.name);
        else failures.push(resource.name + ": " + failure);
      } catch (error: unknown) {
        failures.push(resource.name + ": " + classify(error));
      }
    }
    return { released, failures };
  }
}

/**
 * Reduce an unknown throw to a classified word.
 *
 * Never the rendered exception: that is unbounded text of unknown provenance,
 * and it is how absolute paths and payload fragments reach a log file.
 */
export function classify(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}

/**
 * Run a promise under a deadline.
 *
 * Returns a classified marker rather than throwing, because every caller here
 * is already on a failure path and needs to keep unwinding.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T | { readonly timedOut: true; readonly label: string }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ readonly timedOut: true; readonly label: string }>((resolve) => {
    timer = setTimeout(() => { resolve({ timedOut: true, label }); }, deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Did a deadline race time out? */
export function timedOut(value: unknown): value is { readonly timedOut: true; readonly label: string } {
  return typeof value === "object" && value !== null && (value as { timedOut?: unknown }).timedOut === true;
}

/**
 * Is something already listening on a loopback port?
 *
 * Deliberately implemented with `fetch` rather than a socket. The daemon may
 * not import `node:net` at all: a durability plane with a raw socket in it is
 * one refactor away from being a network service, and the fence forbids it. A
 * connection refusal is the only unambiguous evidence a port is free.
 *
 * Anything else — a response, a timeout, a protocol error from something that
 * did accept the connection — counts as occupied. Fail closed: claiming a port
 * that another process holds is how two test suites corrupt each other's run.
 */
export async function portIsFree(port: number): Promise<boolean> {
  try {
    await fetch("http://127.0.0.1:" + String(port) + "/", {
      signal: AbortSignal.timeout(PORT_PRECHECK_TIMEOUT_MS),
    });
    return false;
  } catch (error: unknown) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code === "ECONNREFUSED";
  }
}

/**
 * Refuse to start if a pinned port is taken.
 *
 * The addresses are part of the contract, so the answer to a collision is to
 * fail loudly rather than to pick a different port: a daemon that silently
 * moved would pass its own drills and then not be where anything expects it.
 */
export async function assertReservedPortsFree(
  ports: readonly number[] = RESERVED_LOOPBACK_PORTS,
): Promise<void> {
  const taken: number[] = [];
  for (const port of ports) {
    if (!(await portIsFree(port))) taken.push(port);
  }
  if (taken.length > 0) {
    throw new StartupError(
      "refusing to start: loopback port(s) already in use: " + taken.join(", "),
    );
  }
}
