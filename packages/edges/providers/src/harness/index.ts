import type { ResolvedRoute, WorkerIdentityString } from "@acp/contracts";

import type { SessionState } from "../contract/index.js";
import type { AdapterSession } from "../session/index.js";

/**
 * The owned session lifecycle (V2-B4a).
 *
 * One process holds live provider children; this is the only thing that knows
 * which. Before B4a the execution port kept that knowledge in a `Map` whose
 * entries died with the **stream generator** rather than with the session, so
 * a caller that stopped reading left a running child nothing could name,
 * interrupt or reap. ADR 0010 already said abandoning an iteration is not
 * cancellation; this module is where that sentence stops being a leak.
 *
 * **An entry's lifetime is the session's.** It is created when a session is
 * registered and released when the session reaches `CLOSED` or `FAILED` —
 * never when a stream ends. An abandoned stream leaves an entry that is live,
 * named, reattachable and interruptible, and `closeAll` reaps it when the
 * daemon unwinds. Trading an invisible leak for a visible one would not have
 * been worth a packet.
 *
 * **It is a registry, not an authority.** It starts nothing, admits nothing,
 * routes nothing and decides nothing about whether a reattach is lawful — the
 * port applies those rules and this module answers questions. It cannot spawn:
 * it imports neither the spawner nor `node:child_process`, and the fence keeps
 * `session/index.ts` the single caller of `spawnAdmitted`.
 *
 * **There is exactly one of these per process, and the fence says so.**
 * L-B4A-1 refuses a second live-session registry in the port, because two
 * registries are two answers to "is this child still ours", and the answer
 * that loses is the one holding the process nobody reaps.
 */

/**
 * What the harness holds for one live execution.
 *
 * Exported from this module so the port's `lookup` result has a name in the
 * emitted declarations; deliberately **not** re-exported from the package
 * barrel, where the closed surface is exactly `AgentHarness` and
 * `createAgentHarness`. A caller outside this package has no business holding
 * a session handle.
 *
 * Two fields are mutable, and both are the port's to move:
 *
 * - `attached` is true while a stream generator is draining this session. The
 *   port refuses a reattach onto an attached entry rather than fanning one
 *   queue out to two readers — `Session.events()` shifts from a single queue
 *   and a second concurrent reader starves the first.
 * - `lastStepIndex` is the last `usage` step **this execution** reported,
 *   across every stream that has drained it. It lives here rather than in a
 *   generator because a reattached stream must still be able to report the
 *   execution's last step in its `completed` event; a per-generator counter
 *   would restart at zero and make the contract's "the last step the transport
 *   reported, for reconciliation against usage" false on exactly the path this
 *   packet adds.
 */
export interface HarnessEntry {
  readonly session: AdapterSession;
  /** The route this child was started on. Compared field by field on reattach. */
  readonly route: ResolvedRoute;
  /** The identity the work is attributed to. A reattach may not change it. */
  readonly identity: WorkerIdentityString;
  attached: boolean;
  lastStepIndex: number;
}

/** What `register` is handed. The mutable fields are the harness's to seed. */
export interface HarnessRegistration {
  readonly session: AdapterSession;
  readonly route: ResolvedRoute;
  readonly identity: WorkerIdentityString;
}

/**
 * The owned lifecycle, as six methods: three the port drives and three the
 * process owner drives.
 *
 * Port-facing: `register`, `lookup`, `release`. Owner-facing: `interrupt`,
 * `live`, `closeAll`. The split is documented rather than enforced by two
 * interfaces, because one object with a stated division reads better than two
 * that a caller has to hold together.
 */
export interface AgentHarness {
  /**
   * Take ownership of a session under its durable execution name.
   *
   * The caller has already established that no live execution holds this name
   * — the port refuses `EXECUTION_IN_FLIGHT` before it reaches here — so this
   * replaces only a terminal entry, never a live one.
   */
  register(sessionId: string, registration: HarnessRegistration): void;
  /**
   * The live entry under this name, or `null`.
   *
   * A session in `CLOSED` or `FAILED` is **absent**, not present-and-dead:
   * both states are terminal in `LEGAL_TRANSITIONS`, so an entry that reaches
   * one can never become live again and is pruned as it is read. That is what
   * makes a dead session unreattachable and undouble-releasable without the
   * caller having to remember to ask a second question.
   */
  lookup(sessionId: string): HarnessEntry | null;
  /** Forget this name. Idempotent; releasing an absent name is not an error. */
  release(sessionId: string): void;
  /**
   * Interrupt the child owned under this name, then forget it.
   *
   * Idempotent, and structurally incapable of touching a foreign process: an
   * unknown name resolves with nothing done, and a known one walks the
   * session's own signal ladder against the one PID its handle created.
   */
  interrupt(sessionId: string): Promise<void>;
  /** What is live right now. Frozen, and a copy: a caller cannot mutate the registry. */
  live(): readonly { readonly sessionId: string; readonly pid: number; readonly state: SessionState }[];
  /**
   * Close every live child and report the names reaped.
   *
   * The daemon's unwind calls this. `AdapterSession.close()` bottoms out in
   * the idempotent `ProcessHandle.close()`, so calling it twice reaps nothing
   * twice; the second call returns an empty list because the first emptied the
   * registry.
   */
  closeAll(): Promise<readonly string[]>;
}

/** Terminal states. An entry in one of these is not live and never will be again. */
function isLive(entry: HarnessEntry): boolean {
  return entry.session.state !== "CLOSED" && entry.session.state !== "FAILED";
}

/** Build one harness. Holds nothing until a session is registered. */
export function createAgentHarness(): AgentHarness {
  const entries = new Map<string, HarnessEntry>();

  /** Read an entry, pruning it if the session has since gone terminal. */
  const liveEntry = (sessionId: string): HarnessEntry | null => {
    const entry = entries.get(sessionId);
    if (entry === undefined) return null;
    if (isLive(entry)) return entry;
    entries.delete(sessionId);
    return null;
  };

  return {
    register(sessionId: string, registration: HarnessRegistration): void {
      entries.set(sessionId, {
        session: registration.session,
        route: registration.route,
        identity: registration.identity,
        attached: false,
        lastStepIndex: 0,
      });
    },

    lookup(sessionId: string): HarnessEntry | null {
      return liveEntry(sessionId);
    },

    release(sessionId: string): void {
      entries.delete(sessionId);
    },

    async interrupt(sessionId: string): Promise<void> {
      const entry = liveEntry(sessionId);
      if (entry === null) return;
      await entry.session.interrupt();
      entries.delete(sessionId);
    },

    live(): readonly { readonly sessionId: string; readonly pid: number; readonly state: SessionState }[] {
      const rows: { readonly sessionId: string; readonly pid: number; readonly state: SessionState }[] = [];
      for (const sessionId of [...entries.keys()]) {
        const entry = liveEntry(sessionId);
        if (entry === null) continue;
        rows.push(Object.freeze({ sessionId, pid: entry.session.pid, state: entry.session.state }));
      }
      return Object.freeze(rows);
    },

    async closeAll(): Promise<readonly string[]> {
      const reaped: string[] = [];
      for (const sessionId of [...entries.keys()]) {
        const entry = entries.get(sessionId);
        entries.delete(sessionId);
        if (entry === undefined) continue;
        // Closed whatever its state: an entry that reached `CLOSED` on its own
        // was pruned by the reads above, and one that reached `FAILED` already
        // started its own teardown. `close()` is idempotent, so reaping a child
        // that is already gone costs a no-op and never a second signal.
        await entry.session.close();
        reaped.push(sessionId);
      }
      return Object.freeze(reaped);
    },
  };
}
