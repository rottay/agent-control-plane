import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

import { canonicalSubmissionDigest } from "../../src/daemon-child/index.js";
import type { DaemonExecutionConfig } from "../../src/daemon-child/index.js";
import { portIsFree } from "../../src/lifecycle/index.js";
import { CONTRACT_VERSION } from "@acp/contracts";

/**
 * The instruction content for a fixture whose prose is `text` (P-06/B, ADR 0094).
 *
 * One text block, so the envelope's `objective` equals the first text block of its
 * content and the two spellings stay one fact. `contentSha256` is a placeholder:
 * escalón B admits and publishes, and escalón C is where a digest is checked
 * against the bytes it describes.
 */
function fixtureContent(text: string): Record<string, unknown> {
  return {
    contentContractVersion: 1,
    blocks: [
      {
        kind: "text",
        blockId: "b1",
        mediaType: "text/plain; charset=utf-8",
        byteLength: new TextEncoder().encode(text).byteLength,
        contentSha256: "0".repeat(64),
        artifactRefId: null,
        text,
        toolCallId: null,
        effectId: null,
      },
    ],
  };
}


/**
 * Make a fixture directory an actual worktree.
 *
 * A "worktree" that is not a git repository is not a worktree, and since V2
 * concurrency C4 the walk observes the one it writes into. Everything the
 * fixture already wrote is committed, so the only changes the observer can see
 * are the walk's own — which is what makes a conformant drill conformant and a
 * violating one violating.
 *
 * A temporary directory, never this repository (stop 3).
 */
function initWorktree(directory: string): void {
  const git = (...args: string[]): void => {
    spawnSync("/usr/bin/git", args, { cwd: directory, encoding: "utf8" });
  };
  git("init", "--quiet");
  git("config", "user.email", "drill@example.invalid");
  git("config", "user.name", "drill");
  // V2-B1f/F3. The worktree holds every path its envelope declares.
  //
  // A write-set is a declaration, and `checkWriteSetConformance` compares it as
  // an exact string: it never required a declared entry to EXIST, so a drill
  // could declare `src/**` and have a gate that matched nothing. The checkpoint
  // digests the declared set against this worktree, so a declaration naming
  // nothing is now visible as `PATH_MISSING` -- which is the honest answer, and
  // the fixture is what has to change. Committed, so an unmodified declared
  // path is not itself an observed change.
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "src", "walk.ts"), "export const walked = true;\n", "utf8");
  git("add", "-A");
  git("commit", "--allow-empty", "-q", "-m", "fixture base");
}


/**
 * The packet's envelope, required on every daemon config since V2 concurrency
 * C4 (DT Option B): a production path with no declared write-set is a path
 * write-set conformance cannot judge, and this drill reaches the daemon through
 * the same config door production does.
 */
function envelopeFor(taskId: string, initiativeId: string): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    initiativeId,
    title: "a drill packet",
    objective: "walk the plan",
    content: fixtureContent("walk the plan"),
    classification: "MECHANICAL",
    issuedBy: EMITTED_BY,
    issuedAt: SUBMITTED_AT,
    authority: [],
    readSet: [],
    writeSet: ["src/walk.ts"],
    conflictKeys: [],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "a patch" },
    validation: { commands: [], independentVerifierRequired: false },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1_000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 10 },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: false, maxStepsWithoutCheckpoint: 5 },
  };
}


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
const SUBMITTED_AT = "2026-08-30T00:00:00.000Z";
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

/**
 * The fake provider the daemon's execution effect runs (V2-B1b, stage 2).
 *
 * The daemon binds the real Claude adapter to whatever binary the config
 * admits, so a config naming node itself cannot walk the plan: node rejects
 * the adapter's `--output-format`. This is an owner-only script whose
 * interpreter line is node's canonical path and whose only act is to speak the
 * stream-json scenario the adapter parses, then exit 0. It proves the daemon's
 * wiring and nothing about any provider; every capability stays UNKNOWN by law.
 */
const FAKE_PROVIDER_LINES: readonly string[] = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-20260115" }),
  JSON.stringify({ type: "assistant", message: { usage: { output_tokens: 1234 } } }),
  JSON.stringify({ type: "result", subtype: "turn_completed" }),
];

let executionRoot: string | null = null;

/** The `execution` section the gate's config carries. */
function executionConfig(): DaemonExecutionConfig {
  if (executionRoot === null) {
    const created = mkdtempSync(join(realpathSync(tmpdir()), "acp-daemon-fallback-"));
    chmodSync(created, 0o700);
    writeFileSync(
      join(created, "fake-provider"),
      "#!" + realpathSync(process.execPath) + "\n" +
        "const lines = " + JSON.stringify([...FAKE_PROVIDER_LINES]) + ";\n" +
        "for (const line of lines) process.stdout.write(line + \"\\n\");\n" +
        "process.exit(0);\n",
      { mode: 0o700 },
    );
    initWorktree(created);
    executionRoot = created;
  }
  return {
    route: {
      provider: "claude",
      model: "opus",
      accountId: "acct-fallback-gate",
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: "2026-08-30.1",
      resolvedAt: "2026-08-30T00:00:00.000Z",
    },
    bindings: [
      {
        accountId: "acct-fallback-gate",
        transportKind: "CLI_SUBSCRIPTION",
        provider: "claude",
        binary: join(executionRoot, "fake-provider"),
        configRoot: executionRoot,
        workdir: executionRoot,
        limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
      },
    ],
  };
}

afterAll(() => {
  if (executionRoot !== null) rmSync(executionRoot, { recursive: true, force: true });
});

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
      submittedAt: SUBMITTED_AT,
      // Computed through the one producer: the door refuses a digest that is
      // not the digest of this submission, route included (V2-B1c, stage 2).
      submissionDigest: canonicalSubmissionDigest({
        taskId,
        attempt: 1,
        submittedAt: SUBMITTED_AT,
        initiativeId: GATE_INITIATIVE_ID,
        route: executionConfig().route,
      }),
      initiativeId: GATE_INITIATIVE_ID,
      envelope: envelopeFor(taskId, GATE_INITIATIVE_ID),
      holdOpen: false,
      // The landed drills' own idiom: SQLITE_SUPERVISOR binds nothing, so the
      // precheck inside the daemon is not what this gate is drilling. The
      // direct port probes below, run before and after, are the evidence.
      checkPorts: false,
      execution: executionConfig(),
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
      //
      // V2-B7T: the plan's own trail is now interleaved with what the walk
      // SPENT. The daemon passes a usage sink to `createExecutionEffects`, so
      // every `{kind:"usage"}` entry the port reports becomes one
      // `TOKEN_USAGE_RECORDED` event — appended from inside the INTENT beat's
      // effect, which is why it lands after `RUN_STARTED` and before the
      // outcome that closes that intent. The plan is unchanged; what changed is
      // that the log now records the cost of walking it.
      //
      // Asserted causally rather than as a new integer: the plan's own events
      // must still appear in the plan's own order, and the extra events must
      // all be usage events sitting in that window.
      const trail = ledger.listEvents({ limit: 20 }).events.map((record) => record.event.type);
      const planTypes = LIFECYCLE_PLAN.map((step) => step.eventType);
      // Riders on the task's thread: recorded against the walk, never steps of
      // it. Usage arrived with V2-B7T and the two lease events with V2
      // concurrency C2, when the daemon began holding a fenced lease over the
      // worktree it writes into. The plan itself has not moved, and this
      // comparison is still exact — which is the point of naming the riders
      // rather than loosening the assertion to a subset check.
      const RIDERS = ["TOKEN_USAGE_RECORDED", "LEASE_ACQUIRED", "LEASE_REVOKED"];
      expect(trail.filter((type) => !RIDERS.includes(type))).toEqual(planTypes);
      expect(trail.filter((type) => type === "TOKEN_USAGE_RECORDED").length).toBeGreaterThan(0);

      const usageAt = trail.indexOf("TOKEN_USAGE_RECORDED");
      expect(usageAt).toBeGreaterThan(trail.indexOf("RUN_STARTED"));
      expect(usageAt).toBeLessThan(trail.indexOf("ATOMIC_STEP_COMPLETED"));

      // And what it recorded is safe to have recorded: exactly the pair the
      // rollup fold reads, attributed to the route's own account, with no
      // provider output and no path anywhere near it.
      const spend = ledger
        .listEvents({ limit: 20 })
        .events.filter((record) => record.event.type === "TOKEN_USAGE_RECORDED");
      for (const record of spend) {
        expect(Object.keys(record.event.payload).sort()).toEqual(["accountId", "tokens"]);
        expect(record.event.payload["accountId"]).toBe(executionConfig().route.accountId);
        expect(Number.isInteger(record.event.payload["tokens"])).toBe(true);
        expect(record.event.transitionId.startsWith("usage.")).toBe(true);
      }

      // V2-B2-2: the gate is re-proved over the ASSEMBLED path, not inherited
      // from the toy era. This daemon built a real `ModelExecutionPort` from
      // its admitted CLI binding, so the walk recorded the admitted route and
      // the effect left digest-keyed evidence. Restriction 1 — "removing
      // Restate leaves the fallback operational" — is therefore discharged
      // against what the plane actually runs.
      expect(ledger.getExecutionRoute(taskId, 1)).toMatchObject({
        provider: executionConfig().route.provider,
        model: executionConfig().route.model,
        accountId: executionConfig().route.accountId,
        transportKind: "CLI_SUBSCRIPTION",
      });
    } finally {
      ledger.close();
    }

    // Evidence under the scenario's own `executions/`, and no toy marker at
    // all. This is the assertion that fails if the fallback is ever quietly
    // pointed back at the toy.
    const scenarioRoot = resolveScenarioRoot(id);
    const evidence = existsSync(join(scenarioRoot, "executions"))
      ? readdirSync(join(scenarioRoot, "executions")).filter((name) => name.endsWith(".json"))
      : [];
    expect(evidence).toHaveLength(1);
    expect(existsSync(join(scenarioRoot, "effects"))).toBe(false);

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
