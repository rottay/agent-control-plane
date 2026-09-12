import { describe, expect, it } from "vitest";

import type { DaemonRun, StopResult } from "../../../src/composition/index.js";
import { lockResource, stopDaemon, terminateDaemon } from "../../../src/composition/usecases/index.js";

/**
 * The mirror of `src/composition/usecases/index.ts` (structure §5). P-13's
 * escalón 2 moved the bounded stop/terminate wrappers and the singleton lock
 * resource out of the composition root into this module; the root re-exports
 * the wrappers without compatibility shims. This suite is the cheap proof
 * that the move is real and importable; the drain-bound behaviour itself is
 * drilled where it always was.
 */

describe("the bounded lifecycle use cases", () => {
  it("carries the stop and terminate wrappers", () => {
    expect(typeof stopDaemon).toBe("function");
    expect(typeof terminateDaemon).toBe("function");
    expect(typeof lockResource).toBe("function");
  });

  it("keeps the extracted types reachable across the type-only edge", () => {
    // Type-only assertions: the usecases module reads these from the
    // composition module; if that edge breaks, the package no longer compiles.
    const run: DaemonRun | null = null;
    const stopped: StopResult | null = null;
    expect([run, stopped]).toEqual([null, null]);
  });
});
