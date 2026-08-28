import type { SessionLimits } from "../../contract/index.js";
import { AdapterError } from "../../errors/index.js";
import type { SpawnedProcess } from "../spawn/index.js";

/**
 * PID ownership, the interrupt ladder and the leak sweep.
 *
 * A handle owns exactly one PID for its lifetime and refuses to act on any
 * other. PIDs are reused by the operating system, so "is this still my child?"
 * is answered the way P2D's identity probe answers it: the handle only ever
 * signals a PID it created and has not yet reaped. It never scans, never
 * matches a pattern, never signals a process group it did not make. A sweep
 * that guesses is a sweep that eventually kills something else.
 *
 * The ladder is the signal floor, and it is always available: it is our own
 * mechanism, not a provider feature. A provider-native cancel, when one is
 * ever proven, runs *before* this ladder rather than instead of it.
 */

export type LadderStep = "PROTOCOL_CANCEL" | "SIGINT" | "SIGTERM" | "SIGKILL";

export interface InterruptRecord {
  readonly steps: readonly LadderStep[];
  /** True when the first attempt was not enough and the ladder had to climb. */
  readonly escalated: boolean;
  readonly viaProtocolCancel: boolean;
}

export class ProcessHandle {
  readonly pid: number;
  private readonly process: SpawnedProcess;
  private readonly limits: SessionLimits;
  private readonly context: { readonly provider: string; readonly taskId: string };
  private reaped = false;
  private readonly steps: LadderStep[] = [];

  constructor(
    spawned: SpawnedProcess,
    limits: SessionLimits,
    context: { readonly provider: string; readonly taskId: string },
  ) {
    this.process = spawned;
    this.pid = spawned.pid;
    this.limits = limits;
    this.context = context;
  }

  get isReaped(): boolean {
    return this.reaped;
  }

  /** The child's streams, so the session can pump them. Read-only access. */
  get stdout(): NodeJS.ReadableStream {
    return this.process.child.stdout;
  }

  get stderr(): NodeJS.ReadableStream {
    return this.process.child.stderr;
  }

  /** Resolves when the child has exited, however it exited. */
  onExit(listener: () => void): void {
    this.process.child.once("close", listener);
  }

  /** Refuse any operation naming a PID this handle did not create. */
  assertOwns(pid: number): void {
    if (pid !== this.pid) {
      throw new AdapterError("EXIT_UNEXPECTED", this.context);
    }
  }

  /** Has the child already exited? */
  get exited(): boolean {
    return this.process.child.exitCode !== null || this.process.child.signalCode !== null;
  }

  /**
   * Walk the ladder until the child is gone.
   *
   * `protocolCancel` is invoked first when the caller has one that is actually
   * proven; when it is absent the ladder is signal-only, which is why the
   * roadmap's interrupt requirement holds for a provider whose protocol we
   * have never confirmed.
   */
  async interrupt(protocolCancel?: () => Promise<void>): Promise<InterruptRecord> {
    let viaProtocolCancel = false;
    if (protocolCancel !== undefined) {
      this.steps.push("PROTOCOL_CANCEL");
      viaProtocolCancel = true;
      await protocolCancel();
      if (await this.waitGone(this.limits.interruptGraceMs)) {
        return this.record(viaProtocolCancel);
      }
    }

    for (const [step, grace] of [
      ["SIGINT", this.limits.interruptGraceMs],
      ["SIGTERM", this.limits.termGraceMs],
    ] as const) {
      if (this.exited) break;
      this.steps.push(step);
      this.signal(step);
      if (await this.waitGone(grace)) return this.record(viaProtocolCancel);
    }

    if (!this.exited) {
      this.steps.push("SIGKILL");
      this.signal("SIGKILL");
      await this.waitGone(this.limits.termGraceMs);
    }
    return this.record(viaProtocolCancel);
  }

  /** Idempotent: reaping twice is a no-op, not an error. */
  async close(): Promise<void> {
    if (this.reaped) return;
    if (!this.exited) {
      this.signal("SIGKILL");
      await this.waitGone(this.limits.termGraceMs);
    }
    this.reaped = true;
  }

  /** Is this handle's PID gone? The only question the sweep is allowed to ask. */
  sweep(): boolean {
    return this.exited || this.reaped;
  }

  private record(viaProtocolCancel: boolean): InterruptRecord {
    return Object.freeze({
      steps: Object.freeze([...this.steps]),
      escalated: this.steps.length > 1,
      viaProtocolCancel,
    });
  }

  private signal(step: LadderStep): void {
    if (step === "PROTOCOL_CANCEL") return;
    try {
      // Exactly the owned PID, via the child handle rather than a bare
      // `process.kill`, so there is no path where a computed number is signalled.
      this.process.child.kill(step);
    } catch {
      // Already gone between the check and the signal. Nothing to escalate.
    }
  }

  private async waitGone(graceMs: number): Promise<boolean> {
    const deadline = graceMs;
    let waited = 0;
    const step = 5;
    while (waited < deadline) {
      if (this.exited) return true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, step);
      });
      waited += step;
    }
    return this.exited;
  }
}
