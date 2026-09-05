import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CONFIG_MAX_BYTES, checkConfigPath, loadDaemonConfig } from "../../../src/bin/config-file/index.js";
import { DEFAULT_ROUTING_CONFIG, EVIDENCE_ABSENT, loadPolicyRegistry } from "@acp/accounts";
import type { CandidateEvidence, PolicyRouteRequest, QuotaOutcome, RoutingRequest } from "@acp/accounts";
import { AccountRecord, CONTRACT_VERSION } from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import { admitBinary, admitConfigRoot, admitWorkdir, claudeAdapter, createExecutionPort } from "@acp/providers";
import { composeSubmission } from "@acp/runtime";

// V2-B7S: still imported through this module, which is now a re-export of
// `@acp/runtime`. That these two lines need no edit is the point of the
// re-export -- the other four daemon suites that reach for the same names are
// untouched by this packet, `test/fallback` included.
import { canonicalSubmission, canonicalSubmissionDigest, parseDaemonChildConfig } from "../../../src/daemon-child/index.js";
import type { DaemonExecutionConfig, DaemonSubmission } from "../../../src/daemon-child/index.js";
import { EXIT_CONFIG_CONTENT, EXIT_CONFIG_PATH, EXIT_USAGE, runPackagedEntry } from "../../../src/bin/acp-daemon/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..", "..");
const BUILT_ENTRY = join(PACKAGE_ROOT, "dist", "bin", "acp-daemon", "index.js");
/** What a launchd gui job gets, and nothing more. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const temporaries: string[] = [];

/**
 * Build through the package's own script before asserting on the artifact.
 *
 * The repository's canonical `typecheck` runs `tsc --build --force`, which
 * regenerates `dist/` without the shebang materialization or the executable
 * bit — those live in the daemon package's `build` script. Without this the
 * result depends on whether some other suite happened to rebuild first, which
 * is an order-dependent pass, not a pass.
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
}, 300_000);

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stage(): string {
  const created = mkdtempSync(join(tmpdir(), "acp-config-"));
  temporaries.push(created);
  const dir = realpathSync(created);
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * A valid `execution` section (V2-B1b, D5): canonical, existing paths the
 * config-file law admits at load. Ownership and permission admissions belong
 * to the providers package and run only when a daemon actually starts, which
 * nothing in this file does.
 */
function validExecution(): DaemonExecutionConfig {
  const home = realpathSync(tmpdir());
  return {
    route: {
      provider: "claude",
      model: "opus",
      accountId: "acct-config-contract",
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: "2026-08-30.1",
      resolvedAt: "2026-08-27T18:46:07.000Z",
    },
    binding: {
      binary: realpathSync(process.execPath),
      configRoot: home,
      workdir: home,
      limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
    },
  };
}

const SUBMITTED_AT = "2026-08-27T18:46:07.000Z";
const CONFIG_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";

function validConfig(): Record<string, unknown> {
  const taskId = randomUUID();
  const execution = validExecution();
  return {
    mode: "SQLITE_SUPERVISOR",
    scenarioId: "config-contract",
    emittedBy: "claude/opus/implementer/01",
    taskId,
    attempt: 1,
    submittedAt: SUBMITTED_AT,
    // The digest of this very submission, route included. The door refuses
    // anything else, so a literal here would make every case below invalid
    // for a reason none of them is about (V2-B1c, stage 2).
    submissionDigest: canonicalSubmissionDigest({
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      initiativeId: CONFIG_INITIATIVE_ID,
      route: execution.route,
    }),
    initiativeId: CONFIG_INITIATIVE_ID,
    // V2 concurrency C4, DT Option B: every config declares what it may write.
    envelope: envelopeFor(taskId, CONFIG_INITIATIVE_ID),
    holdOpen: false,
    checkPorts: false,
    execution,
  };
}

function writeConfig(dir: string, body: unknown, mode = 0o600): string {
  const path = join(dir, "daemon.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  chmodSync(path, mode);
  return path;
}

describe("the config path law", () => {
  it("accepts a canonical, owned, owner-only file", () => {
    const dir = stage();
    expect(checkConfigPath(writeConfig(dir, validConfig()))).toEqual({ ok: true });
  });

  it("refuses a relative path or one containing ..", () => {
    expect(checkConfigPath("etc/daemon.json")).toMatchObject({ reason: "PATH_NOT_ABSOLUTE" });
    expect(checkConfigPath("/tmp/../etc/hosts")).toMatchObject({ reason: "PATH_NOT_ABSOLUTE" });
  });

  it("refuses a symlinked component", () => {
    // The file that decides what the daemon runs must be the file a reviewer
    // read, not whatever a link points at today.
    const dir = stage();
    const real = writeConfig(dir, validConfig());
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    expect(checkConfigPath(link)).toMatchObject({ reason: "PATH_NOT_CANONICAL" });
  });

  it("refuses a missing file and a directory", () => {
    const dir = stage();
    expect(checkConfigPath(join(dir, "absent.json"))).toMatchObject({ reason: "PATH_MISSING" });
    expect(checkConfigPath(dir)).toMatchObject({ reason: "PATH_NOT_REGULAR_FILE" });
  });

  it("refuses a file owned by another account, without privilege", () => {
    expect(checkConfigPath("/private/etc/hosts")).toMatchObject({ reason: "PATH_NOT_OWNED" });
  });

  it("refuses a group- or world-writable config", () => {
    // A config anyone can rewrite is a way to make the daemon run something else.
    const dir = stage();
    expect(checkConfigPath(writeConfig(dir, validConfig(), 0o666))).toMatchObject({
      reason: "UNSAFE_PERMISSIONS",
    });
  });

  it("refuses an oversized config on the stat, before reading it", () => {
    const dir = stage();
    const path = writeConfig(dir, "x".repeat(CONFIG_MAX_BYTES + 1));
    expect(checkConfigPath(path)).toMatchObject({ reason: "TOO_LARGE" });
  });
});

describe("the config content law", () => {
  it("accepts a valid document through the existing schema", () => {
    const dir = stage();
    const loaded = loadDaemonConfig(writeConfig(dir, validConfig()));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.config.mode).toBe("SQLITE_SUPERVISOR");
  });

  it("refuses malformed JSON", () => {
    const dir = stage();
    expect(loadDaemonConfig(writeConfig(dir, "{ not json"))).toMatchObject({
      reason: "MALFORMED_JSON",
    });
  });

  it("refuses a document the daemon schema rejects", () => {
    // One schema, not two: the file contract cannot drift from the argv one.
    const dir = stage();
    const execution = validExecution();
    for (const broken of [
      { ...validConfig(), mode: "AUTO" },
      { ...validConfig(), submissionDigest: "nope" },
      { ...validConfig(), attempt: 0 },
      { ...validConfig(), taskId: 7 },
      // V2-B1b D5: the execution section is required, the route is the
      // contract's (a CLI route naming a non-CLI provider refuses at load),
      // and every binding path is absolute and canonical.
      { ...validConfig(), execution: undefined },
      { ...validConfig(), execution: { ...execution, route: { ...execution.route, provider: "acme" } } },
      { ...validConfig(), execution: { ...execution, binding: { ...execution.binding, binary: "relative/node" } } },
      // V2-B1c stage 2: the digest must be the digest of THIS submission.
      // Well-formed hex is no longer enough — that shape check is what let an
      // unbound value through, and an unbound value is what let a resume adopt
      // a changed route.
      { ...validConfig(), submissionDigest: "a".repeat(64) },
    ]) {
      expect(loadDaemonConfig(writeConfig(dir, broken))).toMatchObject({
        reason: "INVALID_CONFIG",
      });
    }
  });

  it("never echoes config content in its refusal", () => {
    const dir = stage();
    const secretish = { ...validConfig(), scenarioId: "s3cr3t-looking-value" };
    const loaded = loadDaemonConfig(writeConfig(dir, secretish));
    if (!loaded.ok) expect(loaded.detail).not.toContain("s3cr3t");
  });
});

describe("the packaged entry argv contract", () => {
  it("requires exactly one argument", async () => {
    await expect(runPackagedEntry([])).resolves.toBe(EXIT_USAGE);
    await expect(runPackagedEntry(["/a", "/b"])).resolves.toBe(EXIT_USAGE);
  });

  it("refuses an option in place of a path", async () => {
    // The template gives exactly two strings, so there is no room for a flag —
    // and accepting one would invite a shape the validator refuses.
    await expect(runPackagedEntry(["--config"])).resolves.toBe(EXIT_USAGE);
  });

  it("separates a refused path from refused content by exit code", async () => {
    const dir = stage();
    await expect(runPackagedEntry(["relative.json"])).resolves.toBe(EXIT_CONFIG_PATH);
    await expect(runPackagedEntry([writeConfig(dir, "{")])).resolves.toBe(EXIT_CONFIG_CONTENT);
  });
});

describe("the built artifact", () => {
  it("resolves its interpreter under the launchd default PATH", () => {
    // B1. A launchd gui job runs with this PATH and nothing else. A tracked
    // `#!/usr/bin/env node` would not resolve here, so the build materializes
    // the interpreter into the ignored artifact; this proves it before any
    // launchctl verb runs.
    const result = spawnSync(BUILT_ENTRY, [], {
      env: { PATH: LAUNCHD_PATH },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("exactly one argument");
  });

  it("carries an absolute interpreter and the executable bit", () => {
    const first = readFileSync(BUILT_ENTRY, "utf8").split("\n")[0] ?? "";
    expect(first.startsWith("#!/")).toBe(true);
    expect(first).not.toContain("/usr/bin/env");
    const probe = spawnSync("/bin/test", ["-x", BUILT_ENTRY]);
    expect(probe.status).toBe(0);
  });

  it("keeps the portable shebang in the tracked source", () => {
    // Host-specific bytes belong only in the ignored build output.
    const source = readFileSync(join(PACKAGE_ROOT, "src", "bin", "acp-daemon", "index.ts"), "utf8");
    expect(source.split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("does nothing when imported rather than executed", () => {
    const probe = [
      "import(" + JSON.stringify("file://" + BUILT_ENTRY) + ").then((m) => {",
      "  console.log(JSON.stringify({ entry: typeof m.runPackagedEntry, code: process.exitCode ?? 0 }));",
      "});",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout.trim()) as { entry: string; code: number };
    expect(observed.entry).toBe("function");
    expect(observed.code).toBe(0);
  });
});
describe("the submission digest binds the route (V2-B1c, stage 2)", () => {
  it("accepts a config whose declared digest is the digest of its own submission", () => {
    const dir = stage();
    expect(loadDaemonConfig(writeConfig(dir, validConfig()))).toMatchObject({ ok: true });
  });

  it("refuses a config whose route moved without its digest", () => {
    // The exact shape of the hole this stage closes: everything else about the
    // submission is unchanged, and only the account differs. Before the digest
    // covered the route, this config was indistinguishable from the original.
    const dir = stage();
    const base = validConfig();
    const execution = base["execution"] as DaemonExecutionConfig;
    const moved = {
      ...base,
      execution: { ...execution, route: { ...execution.route, accountId: "acct-substituted" } },
    };
    expect(loadDaemonConfig(writeConfig(dir, moved))).toMatchObject({ reason: "INVALID_CONFIG" });
  });

  it("refuses a config whose coordinates moved without its digest", () => {
    const dir = stage();
    expect(
      loadDaemonConfig(writeConfig(dir, { ...validConfig(), attempt: 2 })),
    ).toMatchObject({ reason: "INVALID_CONFIG" });
  });

  it("has no fallback: an absent digest is refused, never recomputed", () => {
    // A recompute-if-absent branch would restore exactly the silence the
    // binding removes, so absence is a refusal like any other.
    const dir = stage();
    const withoutDigest: Record<string, unknown> = { ...validConfig() };
    delete withoutDigest["submissionDigest"];
    expect(loadDaemonConfig(writeConfig(dir, withoutDigest))).toMatchObject({
      reason: "INVALID_CONFIG",
    });
  });
});

// ---------------------------------------------------------------------------
// V2 concurrency C3: the envelope door
// ---------------------------------------------------------------------------

/**
 * One negative per row of the ten-check table, plus the two positives.
 *
 * Every refusal names a reason word and a field path and **echoes no value** —
 * an envelope carries objectives, paths and commands, and a refusal that
 * printed one would put a packet's contents in a log line the operator then
 * pastes somewhere.
 */
function envelopeFor(taskId: string, initiativeId: string, writeSet: readonly string[] = []): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    initiativeId,
    title: "a walk",
    objective: "walk the plan",
    classification: "MECHANICAL",
    issuedBy: "claude/opus/implementer/01",
    issuedAt: SUBMITTED_AT,
    authority: [],
    readSet: [],
    writeSet: writeSet.length > 0 ? [...writeSet] : ["src/walk.ts"],
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

function walkEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const taskId = (overrides["taskId"] as string | undefined) ?? randomUUID();
  const initiativeId = (overrides["initiativeId"] as string | undefined) ?? CONFIG_INITIATIVE_ID;
  const execution = (overrides["execution"] as DaemonExecutionConfig | undefined) ?? validExecution();
  return {
    scenarioId: "c3-walk",
    emittedBy: "claude/opus/implementer/01",
    taskId,
    attempt: 1,
    submittedAt: SUBMITTED_AT,
    submissionDigest: canonicalSubmissionDigest({
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      initiativeId,
      route: execution.route,
    }),
    initiativeId,
    envelope: envelopeFor(taskId, initiativeId),
    execution,
    ...overrides,
  };
}

function walksConfig(walks: readonly unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    mode: "SQLITE_SUPERVISOR",
    scenarioId: "c3",
    emittedBy: "claude/opus/implementer/01",
    initiativeId: CONFIG_INITIATIVE_ID,
    holdOpen: false,
    checkPorts: false,
    walks,
    ...overrides,
  };
}

/** The message, with no value from the config echoed into it. */
function refusalOf(document: unknown): string {
  try {
    parseDaemonChildConfig(document);
    return "";
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("the singular form declares what it may write (DT Option B)", () => {
  it("admits a config carrying a well-formed envelope, and echoes it exactly", () => {
    const parsed = parseDaemonChildConfig(validConfig());
    expect(parsed.envelope.taskId).toBe(parsed.taskId);
    expect(parsed.envelope.initiativeId).toBe(parsed.initiativeId);
    expect(parsed.walks).toBeNull();
  });

  it("refuses a config with no envelope at all", () => {
    // The bypass Option B exists to close: a production path with no declared
    // write-set is a path conformance cannot judge, so there is no default and
    // nothing is derived.
    const without: Record<string, unknown> = { ...validConfig() };
    delete without["envelope"];
    expect(refusalOf(without)).toContain("config.envelope");
  });

  it("refuses an envelope that is not the whole contract", () => {
    const partial = { ...validConfig(), envelope: { taskId: randomUUID() } };
    expect(refusalOf(partial)).toContain("config.envelope");
  });

  it("refuses an envelope whose taskId disagrees with the config", () => {
    const base = validConfig();
    const moved = {
      ...base,
      envelope: envelopeFor(randomUUID(), CONFIG_INITIATIVE_ID),
    };
    const message = refusalOf(moved);
    expect(message).toContain("config.taskId");
    expect(message).toContain("disagrees");
    // No value is echoed: an envelope carries objectives and paths.
    expect(message).not.toContain(base["taskId"] as string);
  });

  it("refuses an envelope whose initiativeId disagrees with the config", () => {
    const base = validConfig();
    const moved = {
      ...base,
      envelope: envelopeFor(base["taskId"] as string, "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a09"),
    };
    expect(refusalOf(moved)).toContain("config.initiativeId");
  });

  it("echoes no value in any of these refusals", () => {
    const base = validConfig();
    const without: Record<string, unknown> = { ...base };
    delete without["envelope"];
    for (const document of [without, { ...base, envelope: {} }]) {
      const message = refusalOf(document);
      expect(message).not.toContain(base["taskId"] as string);
      expect(message).not.toContain(CONFIG_INITIATIVE_ID);
    }
  });
});

describe("the envelope door admits many walks, or refuses precisely", () => {
  it("accepts two well-formed walks", () => {
    const parsed = parseDaemonChildConfig(walksConfig([walkEntry(), walkEntry()]));
    expect(parsed.walks).toHaveLength(2);
    // The singular fields are the first walk's, so the one-walk case is the
    // same config either way.
    expect(parsed.taskId).toBe(parsed.walks?.[0]?.spec.taskId);
  });

  it("refuses an entry that is not an object (check 1)", () => {
    expect(refusalOf(walksConfig(["not-an-object"]))).toContain("config.walks[0]");
  });

  it("refuses an envelope that is not the whole contract (check 2)", () => {
    const broken = walkEntry();
    broken["envelope"] = { taskId: broken["taskId"] };
    expect(refusalOf(walksConfig([broken]))).toContain("config.walks[0].envelope");
  });

  it("refuses an envelope whose taskId disagrees with its entry (check 3)", () => {
    // The check a writer omits. Without it a walk declares one task in its
    // envelope and runs another, and the graph decides over a set that does not
    // describe what runs.
    const entry = walkEntry();
    entry["envelope"] = envelopeFor(randomUUID(), CONFIG_INITIATIVE_ID);
    const message = refusalOf(walksConfig([entry]));
    expect(message).toContain("config.walks[0].taskId");
    expect(message).toContain("disagrees");
    expect(message).not.toContain(entry["taskId"] as string);
  });

  it("refuses an envelope whose initiativeId disagrees with its entry (check 4)", () => {
    const other = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a09";
    const entry = walkEntry();
    entry["envelope"] = envelopeFor(entry["taskId"] as string, other);
    expect(refusalOf(walksConfig([entry]))).toContain("config.walks[0].initiativeId");
  });

  it("refuses a walk whose digest is not its own submission's (check 5)", () => {
    const entry = walkEntry();
    entry["attempt"] = 2;
    const message = refusalOf(walksConfig([entry]));
    expect(message).toContain("config.walks[0].submissionDigest");
    expect(message).not.toContain(entry["submissionDigest"] as string);
  });

  it("refuses a walk with no absolute workdir (check 6)", () => {
    const execution = validExecution();
    const relative = {
      ...execution,
      binding: { ...execution.binding, workdir: "relative/path" },
    } as unknown as DaemonExecutionConfig;
    expect(refusalOf(walksConfig([walkEntry({ execution: relative })]))).toContain("workdir");
  });

  it("refuses a duplicate taskId across entries (check 7)", () => {
    // Caught here deliberately: `checkAdmission` is fail-closed over a corrupt
    // admitted set, so the operator would otherwise meet an unexplained blanket
    // refusal much later.
    const first = walkEntry();
    const second = walkEntry({ taskId: first["taskId"] as string });
    const message = refusalOf(walksConfig([first, second]));
    expect(message).toContain("config.walks");
    expect(message).toContain("duplicate");
  });

  it("refuses an empty set and one beyond the cap (check 8)", () => {
    expect(refusalOf(walksConfig([]))).toContain("at least one walk");
    const many = [walkEntry(), walkEntry(), walkEntry(), walkEntry(), walkEntry()];
    expect(refusalOf(walksConfig(many))).toContain("concurrency this plane admits");
  });

  it("refuses RESTATE with more than one walk, naming the mode (check 9)", () => {
    // The capability-truth negative. One endpoint, one task object closed over
    // one walk's ledger, effects and route: N walks there would be one walk
    // wearing N task ids.
    const message = refusalOf(walksConfig([walkEntry(), walkEntry()], { mode: "RESTATE" }));
    expect(message).toContain("RESTATE");
    expect(message).toContain("exactly one walk");
    // And one walk in RESTATE is accepted, unchanged.
    expect(parseDaemonChildConfig(walksConfig([walkEntry()], { mode: "RESTATE" })).walks).toHaveLength(1);
  });

  it("refuses a config that states both forms (check 10)", () => {
    const both = walksConfig([walkEntry()]) as Record<string, unknown>;
    both["taskId"] = randomUUID();
    expect(refusalOf(both)).toContain("exclusive");
  });

  it("leaves the singular form untouched", () => {
    // The form every existing caller uses still parses, and now says so.
    expect(parseDaemonChildConfig(validConfig()).walks).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// V2-B7S: the elected route, at the door it has to survive
// ---------------------------------------------------------------------------

/**
 * The submission path's own end of the contract, drilled where the door lives.
 *
 * The composer is proved as a function in `runtime/test/submission`. What can
 * only be proved here is the join: that a config document built from an
 * election is a document this daemon's door admits, and that the digest the
 * composer computed is the digest the door recomputes. If those two ever
 * disagree there are two spellings of the preimage, which is exactly what the
 * one-producer law exists to prevent.
 *
 * `@acp/accounts` is imported by a **test** here, which is what the daemon's
 * import law has always allowed and what its comment says in as many words: a
 * daemon *source* naming it would be a daemon that resolves, and D5 refused
 * that. Nothing in `src/` names it, and the fence's new L-B7S law now says so
 * mechanically.
 */

const B7S_ACCOUNT = "acct-b7s-door";
const B7S_INITIATIVE = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const B7S_TASK = "b7500000-0000-4000-8000-000000000001";
const B7S_NOW = "2026-09-01T12:00:00Z";
const B7S_RESET = "2026-12-01T00:00:00Z";
const B7S_SUBMITTED_AT = "2026-09-01T00:00:00.000Z";
const B7S_RESOLVED_AT = "2026-09-01T00:00:05.000Z";
const SHIPPED_POLICY = join(REPO_ROOT, "packages", "domains", "accounts", "policy", "capability-policy.json");

/**
 * The digest of a fixed submission under the **pre-move** implementation, at
 * base `cd8367c` (A3).
 *
 * A literal lifted from before the relocation, not a value recomputed from the
 * code under test: recomputing would assert only that the implementation agrees
 * with itself, which is precisely the thing a move must not be allowed to do
 * quietly. The same literal is pinned in `runtime/test/submission`, so both
 * ends of the re-export are held to the identical number.
 */
const B7S_PRE_MOVE_DIGEST = "af1d5cf93384691b6b526a59b6a319b1907864bd1e7a0c42ba4883580aad0d94";

const B7S_FIXED_SUBMISSION: DaemonSubmission = Object.freeze({
  taskId: B7S_TASK,
  attempt: 1,
  submittedAt: B7S_SUBMITTED_AT,
  initiativeId: B7S_INITIATIVE,
  route: Object.freeze({
    provider: "claude",
    model: "opus",
    accountId: "acct-b7s-fixture",
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "2026-08-30.1",
    resolvedAt: B7S_RESOLVED_AT,
  }),
});

function b7sRecord(): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId: B7S_ACCOUNT,
    provider: "claude",
    alias: B7S_ACCOUNT,
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-b7s-" + B7S_ACCOUNT,
    credentialRef: null,
    plan: "max",
    enabledModels: ["opus", "sonnet"],
    knownLimits: { weekly: 1_000_000 },
    resetSchedule: { kind: "DECLARED", nextResetAt: B7S_RESET, timezone: "UTC", confidence: "HIGH" },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      estimatedAt: B7S_NOW,
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-b7s-" + B7S_ACCOUNT,
    contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
  });
  if (!parsed.success) throw new Error("fixture is not a valid AccountRecord");
  return parsed.data;
}

function b7sRouting(): RoutingRequest {
  const outcome: QuotaOutcome = {
    ok: true,
    estimate: {
      accountId: B7S_ACCOUNT,
      limitKey: "weekly",
      limitTokens: 1_000_000,
      observedTokensUsed: 500_000,
      observationCount: 3,
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      overBudget: false,
      confidence: "MEDIUM",
      estimatedAt: B7S_NOW,
      reset: { kind: "DECLARED", nextResetAt: B7S_RESET, timezone: "UTC", millisUntilReset: 3_600_000, confidence: "HIGH" },
    },
  };
  const evidence: CandidateEvidence = {
    accountId: B7S_ACCOUNT,
    acceptance: EVIDENCE_ABSENT,
    contextAffinity: EVIDENCE_ABSENT,
    capabilities: { known: false },
  };
  return {
    records: [b7sRecord()],
    estimates: [{ accountId: B7S_ACCOUNT, outcome }],
    evidence: [evidence],
    task: {
      model: "",
      estimatedTokens: 10_000,
      estimatedDurationSeconds: 60,
      reserveTokens: 5_000,
      requiredCapabilities: [],
    },
    config: DEFAULT_ROUTING_CONFIG,
    now: B7S_NOW,
  };
}

function b7sRequest(transportKind: PolicyRouteRequest["transportKind"]): PolicyRouteRequest {
  return { role: "implementer", routing: b7sRouting(), transportKind };
}

function b7sRegistry(path: string = SHIPPED_POLICY) {
  const outcome = loadPolicyRegistry(path);
  if (!outcome.ok) throw new Error("the policy document did not load: " + outcome.reason);
  return outcome.registry;
}

describe("A3: the relocated producer is still reachable here, and unchanged", () => {
  it("exports both names from this module, as values", () => {
    // The five daemon suites import these through this path. A re-export that
    // stopped exporting either would break four files this packet may not open.
    expect(typeof canonicalSubmission).toBe("function");
    expect(typeof canonicalSubmissionDigest).toBe("function");
  });

  it("computes the digest the pre-move implementation computed", () => {
    expect(canonicalSubmissionDigest(B7S_FIXED_SUBMISSION)).toBe(B7S_PRE_MOVE_DIGEST);
  });

  it("still builds the preimage over the six route fields and nothing else", () => {
    const preimage: unknown = JSON.parse(canonicalSubmission(B7S_FIXED_SUBMISSION));
    const route = (preimage as { route: Record<string, unknown> }).route;
    expect(Object.keys(route).sort()).toEqual([
      "accountId",
      "capabilityPolicyVersion",
      "model",
      "provider",
      "resolvedAt",
      "transportKind",
    ]);
  });
});

describe("A2: an elected route survives the door", () => {
  it("admits a config the composer built, and recomputes the same digest", () => {
    const composed = composeSubmission(b7sRequest("CLI_SUBSCRIPTION"), b7sRegistry(), {
      taskId: B7S_TASK,
      attempt: 1,
      submittedAt: B7S_SUBMITTED_AT,
      initiativeId: B7S_INITIATIVE,
      resolvedAt: B7S_RESOLVED_AT,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    const home = realpathSync(tmpdir());
    const document = {
      mode: "SQLITE_SUPERVISOR",
      scenarioId: "b7s-door",
      emittedBy: "claude/opus/implementer/01",
      taskId: B7S_TASK,
      attempt: 1,
      submittedAt: B7S_SUBMITTED_AT,
      submissionDigest: composed.submissionDigest,
      initiativeId: B7S_INITIATIVE,
      envelope: envelopeFor(B7S_TASK, B7S_INITIATIVE),
      holdOpen: false,
      checkPorts: false,
      execution: {
        route: composed.submission.route,
        binding: {
          binary: realpathSync(process.execPath),
          configRoot: home,
          workdir: home,
          limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
        },
      },
    };

    // The real door, not a re-implementation of it.
    const parsed = parseDaemonChildConfig(document);
    expect(parsed.submissionDigest).toBe(composed.submissionDigest);
    expect(parsed.execution.route).toEqual(composed.submission.route);
    expect(parsed.execution.route.capabilityPolicyVersion).toBe("2026-08-30.1");
  });

  it("refuses the same document when the elected route is swapped underneath the digest", () => {
    // The negative that makes the first case mean something: if the door did
    // not recompute, an elected route could be replaced after election and
    // nothing downstream would notice.
    const composed = composeSubmission(b7sRequest("CLI_SUBSCRIPTION"), b7sRegistry(), {
      taskId: B7S_TASK,
      attempt: 1,
      submittedAt: B7S_SUBMITTED_AT,
      initiativeId: B7S_INITIATIVE,
      resolvedAt: B7S_RESOLVED_AT,
    });
    if (!composed.ok) throw new Error("the election refused");

    const home = realpathSync(tmpdir());
    const swapped: ResolvedRoute = { ...composed.submission.route, model: "sonnet" };
    expect(() =>
      parseDaemonChildConfig({
        mode: "SQLITE_SUPERVISOR",
        scenarioId: "b7s-door",
        emittedBy: "claude/opus/implementer/01",
        taskId: B7S_TASK,
        attempt: 1,
        submittedAt: B7S_SUBMITTED_AT,
        submissionDigest: composed.submissionDigest,
        initiativeId: B7S_INITIATIVE,
        holdOpen: false,
        checkPorts: false,
        execution: {
          route: swapped,
          binding: {
            binary: realpathSync(process.execPath),
            configRoot: home,
            workdir: home,
            limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
          },
        },
      }),
    ).toThrow(/submissionDigest is not the digest/);
  });
});

describe("N2: a non-CLI elected transport fails closed at the port", () => {
  it("is refused by the port with TRANSPORT_UNAVAILABLE at route.transportKind", async () => {
    // The shipped document cannot elect this: every model in it declares
    // CLI_SUBSCRIPTION only. So the policy is copied and edited to make an
    // API_KEY route electable -- which is what makes the refusal below a
    // statement about the PORT rather than about the policy.
    const dir = stage();
    const copy = join(dir, "capability-policy.json");
    const document = JSON.parse(readFileSync(SHIPPED_POLICY, "utf8")) as {
      models: { model: string; transports: string[] }[];
    };
    for (const entry of document.models) entry.transports = ["CLI_SUBSCRIPTION", "API_KEY"];
    writeFileSync(copy, JSON.stringify(document));
    chmodSync(copy, 0o600);

    const composed = composeSubmission(b7sRequest("API_KEY"), b7sRegistry(copy), {
      taskId: B7S_TASK,
      attempt: 1,
      submittedAt: B7S_SUBMITTED_AT,
      initiativeId: B7S_INITIATIVE,
      resolvedAt: B7S_RESOLVED_AT,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    // The composer elected it. It did not refuse, and it must not: whether a
    // transport can be served is the port's question, not the elector's.
    expect(composed.submission.route.transportKind).toBe("API_KEY");

    const home = realpathSync(tmpdir());
    const port = createExecutionPort({
      bindings: new Map([
        [
          B7S_ACCOUNT,
          {
            adapter: claudeAdapter,
            binary: admitBinary(realpathSync(process.execPath), { provider: "claude", taskId: B7S_TASK }),
            configRoot: admitConfigRoot(home, { provider: "claude", taskId: B7S_TASK }),
            workdir: admitWorkdir(home, { provider: "claude", taskId: B7S_TASK }),
            limits: { timeoutMs: 10_000, outputBudgetBytes: 65_536, interruptGraceMs: 120, termGraceMs: 120 },
          },
        ],
      ]),
    });

    const outcome = await port.start(composed.submission.route, {
      taskId: B7S_TASK,
      attempt: 1,
      identity: "claude/opus/implementer/01",
      instructions: "start the packet",
      reattach: null,
    });

    expect(outcome).toMatchObject({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.transportKind" });
  });
});
