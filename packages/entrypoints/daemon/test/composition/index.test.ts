import { describe, expect, it } from "vitest";

import {
  readOwnStatus,
  recoverOwnStaleLock,
  renderLaunchAgent,
  startDaemon,
  stopDaemon,
  terminateDaemon,
  validatePlist,
  validateTemplate,
  writeLaunchAgent,
} from "../../src/composition/index.js";
import type {
  DaemonOptions,
  DaemonRun,
  LaunchAgentValues,
  LaunchdRefusal,
  LaunchdVerdict,
  StopResult,
} from "../../src/composition/index.js";

/**
 * The mirror of `src/composition/index.ts` (structure §5). P-13 moved the
 * composition root out of the package barrel; this suite is the cheap proof
 * that the move is real and importable: the lifecycle functions, the
 * observation and recovery helpers, and the launchd surface all arrive from
 * the composition module now. The behavioural drills live in the suites that
 * always owned them — `test/paths`, `test/launchd/lifecycle` and
 * `test/drills` import these functions from here.
 */

describe("the composition root", () => {
  it("carries the extracted daemon lifecycle and observation surface", () => {
    expect(typeof startDaemon).toBe("function");
    expect(typeof stopDaemon).toBe("function");
    expect(typeof terminateDaemon).toBe("function");
    expect(typeof readOwnStatus).toBe("function");
    expect(typeof recoverOwnStaleLock).toBe("function");
  });

  it("re-exports the launchd surface from its declaring leaves", () => {
    expect(typeof renderLaunchAgent).toBe("function");
    expect(typeof writeLaunchAgent).toBe("function");
    expect(typeof validatePlist).toBe("function");
    expect(typeof validateTemplate).toBe("function");
  });

  it("keeps the extracted public types reachable from the composition module", () => {
    // Type-only assertions: if any of these stops being exported from the
    // composition module, the package no longer compiles.
    const options: DaemonOptions | null = null;
    const run: DaemonRun | null = null;
    const stopped: StopResult | null = null;
    const values: LaunchAgentValues | null = null;
    const refusal: LaunchdRefusal | null = null;
    const verdict: LaunchdVerdict | null = null;
    expect([options, run, stopped, values, refusal, verdict]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});
