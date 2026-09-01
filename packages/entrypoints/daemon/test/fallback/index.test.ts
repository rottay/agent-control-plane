import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { openLedger } from "@acp/ledger";
import {
  LIFECYCLE_PLAN,
  RESERVED_LOOPBACK_PORTS,
  RESTATE_ADMIN_PORT,
  RESTATE_INGRESS_PORT,
  RUNTIME_SERVICE_PORT,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";

import { portIsFree } from "../../src/lifecycle/index.js";

/**
 * The runtime fallback gate. (P8-6.)
 *
 * The roadmap's P8 addendum, law 5: Restate is replaceable, the ledger stays
 * the only authority either way, and the documented SQLite fallback must
 * remain valid. Its removal bullet is specific — disabling Restate must leave
 * the documented fallback path **operational** — and that is a claim about
 * the whole path with the other driver gone, not about the SQLite supervisor
 * in isolation.
 *
 * P2 already proved the machinery this gate depends on, named here as the
 * evidence it composes with rather than re-runs:
 *
 * - **D4, the fail-closed refusal.**
 *   `packages/edges/durability/test/drivers/drills/index.test.ts`,
 *   `"D4 server unavailable fails closed and never fails over on its own"` —
 *   proves the Restate driver never quietly falls back to SQLite on its own.
 *   This gate proves the complementary fact: SQLite mode does not need it to.
 * - **The 3/3 kill/restart drill.**
 *   `packages/domains/runtime/test/drivers/sqlite-supervisor/index.test.ts`,
 *   `describe("kill and restart, 3/3", ...)` — proves the SQLite supervisor's
 *   own durability under a real SIGKILL, at the driver level.
 * - **Byte-equivalence.**
 *   `packages/edges/durability/test/drivers/drills/index.test.ts`,
 *   `"produces a byte-identical head from two independent ledgers"` — proves
 *   the two drivers reach the same ledger state from the same invocation.
 *
 * None of the three is a positive gate that Restate can be **absent** and the
 * documented path still runs end to end through the daemon itself, over a
 * real process, with the pinned Restate ports genuinely unbound throughout —
 * which is what the acceptance bullet asks for and what this file adds.
 *
 * A real process, real ports, on purpose: a daemon driven in-process cannot
 * prove it never touched a socket, and a mocked port check cannot prove one
 * is not just deliberately silent. This test spawns the same child entry the
 * P2 drills spawn, over the same `SQLITE_SUPERVISOR` mode `startDaemon`
 * already serves, and probes the pinned ports for real, before and after.
 *
 * It carries none of the launchd-gated drills' skip conditions: it needs no
 * `launchctl`, no pinned Restate binary and no macOS-specific agent
 * directory, so it always runs.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "daemon-child", "index.js");
const DIGEST = "c".repeat(64);
const EMITTED_BY = "claude/opus/implementer/01";
/** One fixed initiative for this gate's packet. */
const GATE_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a02";
/** The pinned Restate addresses law 5's removal bullet is about. */
const RESTATE_PORTS: readonly number[] = [RESTATE_INGRESS_PORT, RESTATE_ADMIN_PORT, RUNTIME_SERVICE_PORT];

const scenarios: string[] = [];

interface ReadyLine {
  readonly ready: boolean;
  readonly pid: number;
  readonly serverPid: number | null;
  readonly phases: string[];
}

beforeAll(() => {
  const built = spawnSync(process.execPath, [
    join(PACKAGE_ROOT, "..", "..", "..", "node_modules", "typescript", "bin", "tsc"),
    "--build",
    join(PACKAGE_ROOT, "tsconfig.json"),
  ]);
  if (built.status !== 0 || !existsSync(CHILD_ENTRY)) {
    throw new Error("could not build the daemon package for the fallback gate");
  }
}, 120_000);

afterEach(() => {
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
});

// This file spawns no process it does not immediately await the close of, so
// there is nothing for a final leak receipt to check here -- unlike the
// signal drills, which deliberately leave processes alive between steps.
afterAll(() => {
  process.stdout.write(
    "RECEIPT " + JSON.stringify({ drill: "P8-6-FALLBACK-GATE", scenariosRun: 1 }) + "\n",
  );
});

function scenario(name: string): string {
  scenarios.push(name);
  resolveScenarioRoot(name);
  return name;
}

/** Spawn the child and resolve once it announces readiness. */
function startChild(config: string): { child: ChildProcess; ready: Promise<ReadyLine> } {
  const child = spawn(process.execPath, [CHILD_ENTRY, config], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: PACKAGE_ROOT,
  });

  const ready = new Promise<ReadyLine>((resolvePromise, rejectPromise) => {
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.includes('"ready"')) resolvePromise(JSON.parse(line) as ReadyLine);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      rejectPromise(new Error("the child exited before readiness (" + String(code) + "): " + stderr));
    });
  });
  return { child, ready };
}

/** Wait for a child to close, returning its exit code. */
function closed(child: ChildProcess): Promise<{ code: number | null }> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode });
      return;
    }
    child.once("close", (code) => {
      resolvePromise({ code });
    });
  });
}

describe("the runtime fallback gate: SQLite mode operates with Restate disabled", () => {
  it("checkpoints a toy scenario over SQLITE_SUPERVISOR with the full plan trail, the pinned Restate ports unbound throughout", async () => {
    // Nothing Restate-shaped is running before the drill starts. "Disabling
    // Restate" is not simulated here: this is the actual state of the ports
    // the removal bullet is about, checked directly rather than assumed.
    for (const port of RESTATE_PORTS) {
      await expect(portIsFree(port)).resolves.toBe(true);
    }

    const id = scenario("daemon-fallback-gate");
    const taskId = randomUUID();
    const config = JSON.stringify({
      mode: "SQLITE_SUPERVISOR",
      scenarioId: id,
      emittedBy: EMITTED_BY,
      taskId,
      attempt: 1,
      submittedAt: "2026-08-30T00:00:00.000Z",
      submissionDigest: DIGEST,
      initiativeId: GATE_INITIATIVE_ID,
      holdOpen: false,
      // The landed drills' own idiom: SQLITE_SUPERVISOR binds nothing, so the
      // precheck inside the daemon is not what this gate is drilling. The
      // direct port probes below, run before and after, are the evidence.
      checkPorts: false,
    });

    const { child, ready } = startChild(config);
    await ready;
    const exit = await closed(child);
    expect(exit.code).toBe(0);

    const ledger = openLedger(scenarioLedgerPath(resolveScenarioRoot(id)));
    try {
      expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");
      expect(ledger.verifyIntegrity().ok).toBe(true);

      // The full plan trail, not only the terminal state: every event the
      // daemon's LOCAL_COMMIT_WITH_RECEIPT plan produces, in the order the
      // plan defines them. "Reached CHECKPOINTED" means this trail, not a
      // task row that merely says so.
      const trail = ledger.listEvents({ limit: 20 }).events.map((record) => record.event.type);
      expect(trail).toEqual(LIFECYCLE_PLAN.map((step) => step.eventType));
    } finally {
      ledger.close();
    }

    // The port precheck's own evidence, checked again: still unbound after
    // the daemon ran its full plan and exited cleanly. SQLITE_SUPERVISOR
    // mode's own doc comment states it binds no socket and spawns no child;
    // this is that claim, drilled rather than read.
    for (const port of RESTATE_PORTS) {
      await expect(portIsFree(port)).resolves.toBe(true);
    }
    // The broader reserved set too, for the same reason the landed
    // `"the SQLite mode"` drill checks it: nothing this daemon does should
    // ever touch a pinned address it was not asked to.
    for (const port of RESERVED_LOOPBACK_PORTS) {
      await expect(portIsFree(port)).resolves.toBe(true);
    }
  });
});
