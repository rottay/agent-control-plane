import { describe, expect, it } from "vitest";

import {
  bindingForRoute,
  checkpointsFor,
  cliBindingsOf,
  conformanceGateFor,
  executionPortFor,
  switchPortFor,
} from "../../../src/composition/ports/index.js";

/**
 * The mirror of `src/composition/ports/index.ts` (structure §5). P-13's
 * escalón 2 partitioned the extracted composition root: every seam the root
 * closes over a live dependency — the per-binding execution port, the switch
 * port, the conformance gate and the checkpoint port — lives in this module
 * now. This suite is the cheap proof that the partition is real and
 * importable; the behavioural drills live in the suites that always owned
 * them.
 */

describe("the composed ports", () => {
  it("carries the execution-port seam builders", () => {
    expect(typeof executionPortFor).toBe("function");
    expect(typeof bindingForRoute).toBe("function");
    expect(typeof cliBindingsOf).toBe("function");
  });

  it("carries the switch, conformance and checkpoint seam builders", () => {
    expect(typeof switchPortFor).toBe("function");
    expect(typeof conformanceGateFor).toBe("function");
    expect(typeof checkpointsFor).toBe("function");
  });
});
