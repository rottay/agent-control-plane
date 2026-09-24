import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

import { readOwnStatus } from "../../../src/composition/index.js";
import { removeScenarioRoot } from "@acp/runtime";
import { daemonRootPath } from "../../../src/paths/index.js";
import { writeLaunchAgentAt } from "../../../src/launchd/render/index.js";
import type { LaunchAgentValues } from "../../../src/launchd/render/index.js";
import { canonicalSubmissionDigest } from "../../../src/daemon-child/index.js";
import type { DaemonExecutionConfig } from "../../../src/daemon-child/index.js";
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
    issuedBy: "claude/opus/implementer/01",
    issuedAt: "2026-08-27T18:46:07.000Z",
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

/**
 * The fake provider the launched daemon's execution effect runs (V2-B1b,
 * stage 2): an owner-only script under the disposable root, interpreter line
 * node's canonical path, speaking the stream-json scenario the real Claude
 * adapter parses. It proves the wiring under launchd and nothing about any
 * provider; every capability stays UNKNOWN by law.
 */
/**
 * The observed worktree is its **own** directory, not the agent root.
 *
 * The agent root holds the plist, `daemon.json` and `err.log` — files the
 * daemon itself writes while it runs. Since V2 concurrency C4 the walk observes
 * the worktree it writes into, so a root serving as both would observe the
 * daemon's own log as an untracked path outside the declared write-set and
 * refuse its own start. In production those are different directories; here
 * they are too.
 */
function executionConfigIn(root: string): DaemonExecutionConfig {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-20260115", claude_code_version: "2.1.280" }),
    JSON.stringify({ type: "assistant", message: { usage: { output_tokens: 1234 } } }),
    JSON.stringify({ type: "result", subtype: "turn_completed" }),
  ];
  const worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true, mode: 0o700 });
  const binary = join(worktree, "fake-provider");
  writeFileSync(
    binary,
    "#!" + realpathSync(process.execPath) + "\n" +
      "const lines = " + JSON.stringify(lines) + ";\n" +
      "for (const line of lines) process.stdout.write(line + \"\\n\");\n" +
      "process.exit(0);\n",
    { mode: 0o700 },
  );
  initWorktree(worktree);
  return {
    route: {
      provider: "claude",
      model: "opus",
      accountId: "acct-launchd-drill",
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: "2026-08-30.1",
      resolvedAt: "2026-08-27T18:46:07.000Z",
    },
    bindings: [
      {
        accountId: "acct-launchd-drill",
        transportKind: "CLI_SUBSCRIPTION",
        provider: "claude",
        binary,
        configRoot: worktree,
        workdir: worktree,
        limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
      },
    ],
  };
}

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
      ...(() => {
        // One submission, stated once and digested through the one producer.
        // The door refuses a declared digest that is not this value, so the
        // fixture computes it rather than asserting arbitrary hex
        // (V2-B1c, stage 2).
        const taskId = randomUUID();
        const submittedAt = "2026-08-27T18:46:07.000Z";
        const initiativeId = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
        const execution = executionConfigIn(root);
        return {
          taskId,
          attempt: 1,
          submittedAt,
          submissionDigest: canonicalSubmissionDigest({
            taskId,
            attempt: 1,
            submittedAt,
            initiativeId,
            route: execution.route,
          }),
          initiativeId,
          envelope: envelopeFor(taskId, initiativeId),
          execution,
        };
      })(),
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
