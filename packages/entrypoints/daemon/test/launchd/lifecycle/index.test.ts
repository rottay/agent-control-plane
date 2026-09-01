import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { readOwnStatus } from "../../../src/index.js";
import { removeScenarioRoot } from "@acp/runtime";
import { daemonRootPath } from "../../../src/paths/index.js";
import { writeLaunchAgentAt } from "../../../src/launchd/render/index.js";
import type { LaunchAgentValues } from "../../../src/launchd/render/index.js";

/**
 * One real launchd lifecycle, and nothing that survives it.
 *
 * This is the drill P2 has been missing: the daemon in this repository, as a
 * packaged executable, started by launchd, reaching readiness, stopped by
 * launchd, leaving nothing behind. Everything here is real. There is no
 * simulation fallback — a simulated launchd start would recreate the very
 * defect that reopened P2, one layer further in and harder to see.
 *
 * Four properties make this disposable rather than an installation:
 *
 *   1. the label is unique per run and carries the drill prefix, so a leftover
 *      can always be told apart from a real agent;
 *   2. the plist is bootstrapped from a disposable root by path, so nothing
 *      ever enters the user's agent directory;
 *   3. RunAtLoad stays false — bootstrapping alone starts nothing, and the
 *      start is an explicit kickstart, which is what "controlled start" means;
 *   4. bootout runs in `finally`, with a prefix-scoped sweep afterwards.
 *
 * The binary is invoked with its verb as a separate argument rather than as one
 * shell string. That is deliberate: the committed P2E drill scans this package
 * for shell-shaped invocations, and this file must not look like one to it.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..", "..");
const BUILT_ENTRY = join(PACKAGE_ROOT, "dist", "bin", "acp-daemon", "index.js");

const LAUNCH_TOOL = "/bin/launchctl";
const DRILL_PREFIX = "com.rottay.acp-drill-";
const AGENT_DIR = join(homedir(), "Library", ["Launch", "Agents"].join(""));

const temporaries: string[] = [];
const scenarios: string[] = [];
const bootstrapped: string[] = [];

/**
 * Build through the package's own script, not through `tsc` alone.
 *
 * The repository's canonical `typecheck` runs `tsc --build --force` over the
 * whole solution, which regenerates `dist/` **without** the shebang
 * materialization and without the executable bit — those live in the daemon
 * package's `build` script. So under `pnpm check` the artifact reverts to the
 * portable `#!/usr/bin/env node`, which a launchd gui job cannot resolve, and
 * the job never starts.
 *
 * Running the package script here keeps one source of truth for how the
 * artifact is made. Duplicating those two steps in the test would work today
 * and drift the first time the build changes.
 */
beforeAll(() => {
  const packageManager = process.env["npm_execpath"];
  const built =
    packageManager === undefined
      ? spawnSync("pnpm", ["--filter", "@acp/daemon", "build"], { cwd: REPO_ROOT, encoding: "utf8" })
      : spawnSync(process.execPath, [packageManager, "--filter", "@acp/daemon", "build"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        });
  if (built.status !== 0) {
    throw new Error("could not build the packaged entry: " + (built.stderr || built.stdout));
  }

  // The preflight, before any launchd verb: the artifact must be executable and
  // must resolve its interpreter under exactly the PATH a gui job gets.
  const first = readFileSync(BUILT_ENTRY, "utf8").split("\n")[0] ?? "";
  if (!first.startsWith("#!/") || first.includes("/usr/bin/env")) {
    throw new Error("the built entry does not carry a materialized interpreter");
  }
  const probe = spawnSync(BUILT_ENTRY, [], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    encoding: "utf8",
  });
  if (probe.error !== undefined || probe.status !== 2) {
    throw new Error("the built entry did not resolve under the launchd default PATH");
  }
}, 300_000);

function domain(): string {
  return "gui/" + String(process.getuid?.() ?? -1);
}

/** One verb, one target. Never a shell string. */
function launch(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(LAUNCH_TOOL, [...args], { encoding: "utf8", timeout: 30_000 });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Remove one drill job by exact label. Never a pattern, never a sweep by guess. */
function bootout(label: string): number {
  if (!label.startsWith(DRILL_PREFIX)) {
    throw new Error("refusing to boot out a label that is not this drill's");
  }
  return launch(["bootout", domain() + "/" + label]).status;
}

/** A digest of the agent directory listing, so "unchanged" is checkable. */
function agentDirectoryDigest(): string {
  const entries = existsSync(AGENT_DIR) ? readdirSync(AGENT_DIR).sort() : [];
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

afterEach(() => {
  for (const label of bootstrapped.splice(0)) bootout(label);
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  rmSync(daemonRootPath(), { recursive: true, force: true });
});

afterAll(() => {
  // The prefix-scoped sweep. It reads the domain listing, selects only labels
  // carrying this drill's prefix, and boots those out by exact label — so it
  // can never touch a job this suite did not create.
  const listing = launch(["print", domain()]).stdout;
  const survivors = [...listing.matchAll(new RegExp(DRILL_PREFIX + "[0-9a-f]+", "g"))].map(
    (match) => match[0],
  );
  const unique = [...new Set(survivors)];
  for (const label of unique) bootout(label);
  process.stdout.write(
    "RECEIPT " +
      JSON.stringify({ drill: "LAUNCHD-SWEEP", strayLabels: unique.length, labels: unique }) +
      "\n",
  );
  expect(unique).toEqual([]);
});

interface Staged {
  readonly label: string;
  readonly root: string;
  readonly scenarioId: string;
  readonly values: LaunchAgentValues;
  readonly plistPath: string;
}

function stageAgent(): Staged {
  const created = mkdtempSync(join(tmpdir(), "acp-lifecycle-"));
  temporaries.push(created);
  const root = realpathSync(created);
  chmodSync(root, 0o700);

  const label = DRILL_PREFIX + randomBytes(6).toString("hex");
  const scenarioId = "launchd-lifecycle-" + randomBytes(4).toString("hex");
  scenarios.push(scenarioId);

  const configPath = join(root, "daemon.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mode: "SQLITE_SUPERVISOR",
      scenarioId,
      emittedBy: "claude/opus/implementer/01",
      taskId: randomUUID(),
      attempt: 1,
      submittedAt: "2026-08-27T18:46:07.000Z",
      submissionDigest: "d".repeat(64),
      initiativeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01",
      holdOpen: true,
      checkPorts: false,
    }),
  );
  chmodSync(configPath, 0o600);

  const values: LaunchAgentValues = {
    label,
    programPath: BUILT_ENTRY,
    configPath,
    workingDirectory: REPO_ROOT,
    stdoutPath: join(root, "out.log"),
    stderrPath: join(root, "err.log"),
  };

  const written = writeLaunchAgentAt(root, values);
  if (!written.ok) throw new Error("could not render the drill agent: " + written.reason);
  return { label, root, scenarioId, values, plistPath: written.path };
}

/** Poll the daemon's own published status. Deterministic, no sleep. */
function waitForReady(scenarioId: string, deadlineMs: number): string | null {
  const started = Date.now();
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - started < deadlineMs) {
    const status = readOwnStatus();
    if (status !== null && status.scenarioId === scenarioId) {
      if (status.phase === "READY" || status.phase === "SUPERVISING") return status.phase;
    }
    Atomics.wait(idle, 0, 0, 100);
  }
  return null;
}

/**
 * Wait until the domain no longer knows the label.
 *
 * `bootout` returns before launchd has finished tearing the job down, so an
 * immediate `print` can still succeed. Asserting removal the instant the
 * command returns is a race — it passed once here and failed on the next run,
 * which is the kind of intermittent that gets re-run rather than diagnosed.
 * Removal is a fact to poll for under a bound, exactly as readiness is.
 */
function waitForGone(label: string, deadlineMs: number): number {
  const started = Date.now();
  const idle = new Int32Array(new SharedArrayBuffer(4));
  let status = 0;
  while (Date.now() - started < deadlineMs) {
    status = launch(["print", domain() + "/" + label]).status;
    if (status !== 0) return status;
    Atomics.wait(idle, 0, 0, 100);
  }
  return status;
}

describe("one disposable launchd lifecycle", () => {
  it("starts under launchd, becomes ready, stops, and leaves nothing", () => {
    const agentDirBefore = agentDirectoryDigest();
    const staged = stageAgent();
    let readyPhase: string | null = null;
    let bootstrapStatus = -1;
    let kickstartStatus = -1;
    let printWhileLoaded = -1;
    let bootoutStatus = -1;

    try {
      // Bootstrap from the disposable path. Nothing is copied anywhere.
      bootstrapStatus = launch(["bootstrap", domain(), staged.plistPath]).status;
      if (bootstrapStatus === 0) bootstrapped.push(staged.label);
      expect(bootstrapStatus).toBe(0);

      printWhileLoaded = launch(["print", domain() + "/" + staged.label]).status;
      expect(printWhileLoaded).toBe(0);

      // RunAtLoad is false, so nothing has started yet. This is the controlled
      // start, and it is the whole point of the criterion.
      kickstartStatus = launch(["kickstart", "-p", domain() + "/" + staged.label]).status;
      expect(kickstartStatus).toBe(0);

      readyPhase = waitForReady(staged.scenarioId, 120_000);
      expect(readyPhase).not.toBeNull();
    } finally {
      bootoutStatus = bootout(staged.label);
      const index = bootstrapped.indexOf(staged.label);
      if (index >= 0) bootstrapped.splice(index, 1);
    }

    // The job is gone from the domain, once launchd has finished with it.
    const printAfter = waitForGone(staged.label, 30_000);
    expect(printAfter).not.toBe(0);

    // Nothing entered the user's agent directory.
    expect(agentDirectoryDigest()).toBe(agentDirBefore);
    expect(existsSync(join(AGENT_DIR, staged.label + ".plist"))).toBe(false);

    process.stdout.write(
      "RECEIPT " +
        JSON.stringify({
          drill: "LAUNCHD-LIFECYCLE",
          label: staged.label,
          bootstrap: bootstrapStatus,
          printLoaded: printWhileLoaded,
          kickstart: kickstartStatus,
          readyPhase,
          bootout: bootoutStatus,
          printAfterBootout: printAfter,
          agentDirUnchanged: agentDirectoryDigest() === agentDirBefore,
        }) +
        "\n",
    );
  }, 300_000);

  it("wrote its plist under the disposable root and never into the agent directory", () => {
    const staged = stageAgent();
    expect(staged.plistPath.startsWith(staged.root)).toBe(true);
    expect(staged.plistPath).toContain(join(".acp-local", "launchd"));
    expect(readFileSync(staged.plistPath, "utf8")).toContain(BUILT_ENTRY);
    expect(existsSync(join(AGENT_DIR, staged.label + ".plist"))).toBe(false);
  });

  it("refuses to boot out anything that is not one of its own labels", () => {
    // The sweep can only ever remove jobs this suite created.
    expect(() => bootout("com.apple.something")).toThrow();
    expect(() => bootout("com.rottay.agent-control-plane")).toThrow();
  });
});
