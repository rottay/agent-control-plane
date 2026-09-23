import type { HealthProbe, ResolvedRoute, WorkerIdentityString } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import type { ProviderName, SessionState } from "../../src/contract/index.js";
import { unknownCapabilities } from "../../src/contract/index.js";
import type { NormalizedEvent } from "../../src/events/index.js";
import type { InterruptRecord } from "../../src/process/handle/index.js";
import type { AdapterSession } from "../../src/session/index.js";
import { createAgentHarness } from "../../src/harness/index.js";

/**
 * The owned session lifecycle, driven directly (V2-B4a).
 *
 * No port and no process anywhere in this file. The harness is a registry
 * whose whole job is to answer "is this child still ours", so it is proved
 * against sessions whose state a test can move at will — which is the only way
 * to reach the terminal-state branches deterministically, without a real child
 * and without sleeping on a wall clock.
 *
 * The port's use of the harness is proved in `test/execution-port`, over real
 * spawned children; this suite is the unit underneath it.
 */

const IDENTITY = "anthropic/claude-opus-5/implementer/01" as WorkerIdentityString;
const AT = "2026-09-03T15:00:00.000Z";

function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    provider: "claude",
    model: "opus",
    accountId: "acct-primary",
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "v2-b4a",
    resolvedAt: AT,
    ...overrides,
  };
}

/**
 * A session whose state a test owns.
 *
 * It records what was asked of it rather than doing it: the point of this
 * suite is which sessions the harness reaches, not what a real one does when
 * reached. `close` and `interrupt` move the state exactly as the real session
 * does, so a harness that reads state after acting reads the truth.
 */
interface FakeSession extends AdapterSession {
  state: SessionState;
  readonly calls: { interrupts: number; closes: number };
}

function fakeSession(pid: number, state: SessionState = "STARTING"): FakeSession {
  const calls = { interrupts: 0, closes: 0 };
  const session: FakeSession = {
    provider: "claude" as ProviderName,
    state,
    capabilities: unknownCapabilities(),
    pid,
    calls,
    events: async function* (): AsyncIterable<NormalizedEvent> {
      // Never yields: no test here drains a stream.
    },
    interrupt: (): Promise<InterruptRecord> => {
      calls.interrupts += 1;
      session.state = "CLOSED";
      return Promise.resolve({ steps: Object.freeze(["SIGINT" as const]), escalated: false, viaProtocolCancel: false });
    },
    close: (): Promise<void> => {
      calls.closes += 1;
      session.state = "CLOSED";
      return Promise.resolve();
    },
    health: (): HealthProbe => ({ status: "UNKNOWN", checkedAt: AT, latencyMs: null, classifiedError: null }),
    settled: (): Promise<void> => Promise.resolve(),
    // No process and no verdict: the harness never asks either (P-07 escalón C).
    exit: () => null,
    operation: () => null,
  };
  return session;
}

describe("the agent harness", () => {
  it("holds a registered session under its execution name", () => {
    const harness = createAgentHarness();
    const session = fakeSession(4_101);
    harness.register("task/1/acct-primary", { session, route: route(), identity: IDENTITY });

    const entry = harness.lookup("task/1/acct-primary");
    expect(entry).not.toBeNull();
    expect(entry?.session).toBe(session);
    expect(entry?.identity).toBe(IDENTITY);
    expect(entry?.route).toEqual(route());
    // The two mutable fields are the port's to move, and start where the
    // lifetime law says: nothing is draining it, and it has reported no step.
    expect(entry?.attached).toBe(false);
    expect(entry?.lastStepIndex).toBe(0);
  });

  it("answers null for a name it never held", () => {
    expect(createAgentHarness().lookup("nobody/1/acct-primary")).toBeNull();
  });

  // A7.
  it("treats a CLOSED or FAILED session as absent, so a dead child cannot be reattached", () => {
    for (const terminal of ["CLOSED", "FAILED"] as const) {
      const harness = createAgentHarness();
      const session = fakeSession(4_102, "STREAMING");
      harness.register("task/1/acct-primary", { session, route: route(), identity: IDENTITY });
      expect(harness.lookup("task/1/acct-primary")).not.toBeNull();

      session.state = terminal;
      expect(harness.lookup("task/1/acct-primary")).toBeNull();
      // Pruned as it was read: the name is gone from `live()` too, so a dead
      // entry cannot be double-released or reaped a second time.
      expect(harness.live()).toEqual([]);
    }
  });

  it("releases a name idempotently, whether or not it held one", () => {
    const harness = createAgentHarness();
    harness.register("task/1/acct-primary", { session: fakeSession(4_103), route: route(), identity: IDENTITY });

    harness.release("task/1/acct-primary");
    expect(harness.lookup("task/1/acct-primary")).toBeNull();
    expect(() => {
      harness.release("task/1/acct-primary");
      harness.release("never-held");
    }).not.toThrow();
  });

  it("reports what is live, with the pid and state each session carries", () => {
    const harness = createAgentHarness();
    const first = fakeSession(4_201, "STREAMING");
    const second = fakeSession(4_202, "STARTING");
    harness.register("a/1/acct-primary", { session: first, route: route(), identity: IDENTITY });
    harness.register("b/1/acct-primary", { session: second, route: route(), identity: IDENTITY });

    const live = harness.live();
    expect([...live]).toEqual([
      { sessionId: "a/1/acct-primary", pid: 4_201, state: "STREAMING" },
      { sessionId: "b/1/acct-primary", pid: 4_202, state: "STARTING" },
    ]);
    expect(Object.isFrozen(live)).toBe(true);
    expect(Object.isFrozen(live[0])).toBe(true);
  });

  it("interrupts the child it owns, then forgets the name", async () => {
    const harness = createAgentHarness();
    const session = fakeSession(4_301, "STREAMING");
    harness.register("task/1/acct-primary", { session, route: route(), identity: IDENTITY });

    await harness.interrupt("task/1/acct-primary");
    expect(session.calls.interrupts).toBe(1);
    expect(harness.lookup("task/1/acct-primary")).toBeNull();
  });

  // N8, at the unit the port delegates to.
  it("is idempotent about interrupting, and does nothing for a name it does not hold", async () => {
    const harness = createAgentHarness();
    const session = fakeSession(4_302, "STREAMING");
    harness.register("task/1/acct-primary", { session, route: route(), identity: IDENTITY });

    await harness.interrupt("task/1/acct-primary");
    await expect(harness.interrupt("task/1/acct-primary")).resolves.toBeUndefined();
    await expect(harness.interrupt("never-held")).resolves.toBeUndefined();
    // The second call reached no session: a released name owns no process, and
    // signalling one it does not own is the failure this method exists to make
    // impossible.
    expect(session.calls.interrupts).toBe(1);
  });

  // A6.
  it("reaps every live entry on closeAll, reports what it reaped, and empties", async () => {
    const harness = createAgentHarness();
    const first = fakeSession(4_401, "STREAMING");
    const second = fakeSession(4_402, "STARTING");
    harness.register("a/1/acct-primary", { session: first, route: route(), identity: IDENTITY });
    harness.register("b/1/acct-primary", { session: second, route: route(), identity: IDENTITY });

    const reaped = await harness.closeAll();
    expect([...reaped]).toEqual(["a/1/acct-primary", "b/1/acct-primary"]);
    expect(first.calls.closes).toBe(1);
    expect(second.calls.closes).toBe(1);
    expect(harness.live()).toEqual([]);
  });

  it("is idempotent about closeAll: the second sweep reaps nothing and signals nothing", async () => {
    const harness = createAgentHarness();
    const session = fakeSession(4_403, "STREAMING");
    harness.register("a/1/acct-primary", { session, route: route(), identity: IDENTITY });

    expect([...(await harness.closeAll())]).toEqual(["a/1/acct-primary"]);
    expect([...(await harness.closeAll())]).toEqual([]);
    expect(session.calls.closes).toBe(1);
  });

  it("reaps a session that failed on its own, without signalling it twice", async () => {
    const harness = createAgentHarness();
    const session = fakeSession(4_404, "FAILED");
    harness.register("a/1/acct-primary", { session, route: route(), identity: IDENTITY });

    // Not live, so it is not reattachable and not listed...
    expect(harness.lookup("a/1/acct-primary")).toBeNull();
    // ...and the read pruned it, so the unwind has nothing left to reap. The
    // session tore its own child down when it failed; `settled()` is what a
    // caller awaits for that, not this.
    expect([...(await harness.closeAll())]).toEqual([]);
    expect(session.calls.closes).toBe(0);
  });
});
