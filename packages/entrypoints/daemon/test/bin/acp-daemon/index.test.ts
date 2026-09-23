import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CONFIG_MAX_BYTES, checkConfigPath, loadDaemonConfig } from "../../../src/bin/config-file/index.js";
import { DEFAULT_ROUTING_CONFIG, EVIDENCE_ABSENT, loadPolicyRegistry } from "@acp/accounts";
import type { CandidateEvidence, PolicyRouteRequest, QuotaOutcome, RoutingRequest } from "@acp/accounts";
import { AccountRecord, CONTRACT_VERSION, buildInitiativeIdempotencyKey } from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import { admitBinary, admitConfigRoot, admitWorkdir, claudeAdapter, createExecutionPort } from "@acp/providers";
import {
  artifactBlobLeaseStorePath,
  canonicalJsonStringify,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
} from "@acp/ledger";
import { composeSubmission, intakeTask } from "@acp/runtime";

// V2-B7S: still imported through this module, which is now a re-export of
// `@acp/runtime`. That these two lines need no edit is the point of the
// re-export -- the other four daemon suites that reach for the same names are
// untouched by this packet, `test/fallback` included.
import {
  MAX_EXECUTION_BINDINGS,
  canonicalSubmission,
  canonicalSubmissionDigest,
  parseDaemonChildConfig,
  runDaemonChild,
} from "../../../src/daemon-child/index.js";
import type { DaemonExecutionBinding, DaemonExecutionConfig, DaemonSubmission } from "../../../src/daemon-child/index.js";
import { EXIT_CONFIG_CONTENT, EXIT_CONFIG_PATH, EXIT_USAGE, runPackagedEntry } from "../../../src/bin/acp-daemon/index.js";

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
    bindings: [
      {
        accountId: "acct-config-contract",
        transportKind: "CLI_SUBSCRIPTION",
        provider: "claude",
        binary: realpathSync(process.execPath),
        configRoot: home,
        workdir: home,
        limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
      },
    ],
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

/**
 * A parsed binding, read as the CLI shape it declares (V2-BE/R6).
 *
 * `DaemonExecutionBinding` is a discriminated union since R6, so the CLI fields
 * are reachable only after the discriminant is checked. These assertions are
 * about CLI configs; the check is the narrowing, and a binding that turned out
 * to be an API one fails here rather than reading `undefined`.
 */
function cli(binding: DaemonExecutionBinding | undefined): Extract<DaemonExecutionBinding, { transportKind: "CLI_SUBSCRIPTION" }> {
  if (binding === undefined) throw new Error("expected a CLI_SUBSCRIPTION binding");
  if (binding.transportKind !== "CLI_SUBSCRIPTION") {
    throw new Error("expected a CLI_SUBSCRIPTION binding");
  }
  return binding;
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
      {
        ...validConfig(),
        execution: {
          ...execution,
          bindings: [{ ...execution.bindings[0], binary: "relative/node" }],
        },
      },
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
    content: fixtureContent("walk the plan"),
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
    if (parsed.recorded !== null) throw new Error("expected the inline form");
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
      bindings: [{ ...execution.bindings[0], workdir: "relative/path" }],
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
        bindings: [
          {
            accountId: composed.submission.route.accountId,
            transportKind: "CLI_SUBSCRIPTION",
            provider: composed.submission.route.provider,
            binary: realpathSync(process.execPath),
            configRoot: home,
            workdir: home,
            limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
          },
        ],
      },
    };

    // The real door, not a re-implementation of it.
    const parsed = parseDaemonChildConfig(document);
    if (parsed.recorded !== null) throw new Error("expected the inline form");
    expect(parsed.submissionDigest).toBe(composed.submissionDigest);
    expect(parsed.execution.route).toEqual(composed.submission.route);
    expect(parsed.execution.route.capabilityPolicyVersion).toBe("2026-09-06.1");
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
          bindings: [
            {
              accountId: swapped.accountId,
              transportKind: "CLI_SUBSCRIPTION",
              provider: swapped.provider,
              binary: realpathSync(process.execPath),
              configRoot: home,
              workdir: home,
              limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
            },
          ],
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
      modalities: ["text"],
      reattach: null,
    });

    expect(outcome).toMatchObject({ ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.transportKind" });
  });
});


/**
 * V2-B1f/F2: the execution section binds every account a switch may reach.
 *
 * The port layer was already plural -- `createExecutionPort` has always taken
 * one `CliBinding` per `accountId` and always refused a route whose account it
 * had no binding for. The singularity lived here, in the daemon's own config:
 * one `execution.binding`, so a switch had nowhere to land no matter what the
 * planner decided.
 *
 * Every refusal below is asserted **by its path**, because a refusal that names
 * the wrong field sends an operator to the wrong line. Nothing is defaulted and
 * nothing is inherited: an entry that omits a field is refused rather than
 * filled from a sibling or from the route.
 */
describe("F2: execution.bindings is a plural, fully-admitted array", () => {
  /** The valid plural document, with `execution` replaced wholesale. */
  function withExecution(execution: unknown): Record<string, unknown> {
    return { ...validConfig(), execution };
  }

  /** One well-formed entry for an arbitrary account, sharing the worktree. */
  function entryFor(accountId: string, home: string): Record<string, unknown> {
    return {
      accountId,
      transportKind: "CLI_SUBSCRIPTION",
      provider: "claude",
      binary: realpathSync(process.execPath),
      configRoot: home,
      workdir: home,
      limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
    };
  }

  it("P3 round-trips every entry's fields exactly, for two admitted accounts", () => {
    const execution = validExecution();
    const home = execution.bindings[0]?.workdir;
    if (home === undefined) throw new Error("expected a workdir");
    const plural = {
      ...execution,
      bindings: [execution.bindings[0], entryFor("acct-second", home)],
    };

    const parsed = parseDaemonChildConfig(withExecution(plural));
    expect(parsed.execution.bindings).toHaveLength(2);
    expect(parsed.execution.bindings.map((b) => b.accountId)).toEqual([
      "acct-config-contract",
      "acct-second",
    ]);
    // P2: each entry keeps its own fields; neither inherits the other's.
    expect(cli(parsed.execution.bindings[1]).configRoot).toBe(home);
    expect(parsed.execution.bindings[1]?.limits.timeoutMs).toBe(20_000);
    expect(parsed.execution.bindings[0]?.accountId).toBe(parsed.execution.route.accountId);
  });

  it("P4 accepts a one-entry array, the same fact the singular key carried", () => {
    const parsed = parseDaemonChildConfig(validConfig());
    expect(parsed.execution.bindings).toHaveLength(1);
    expect(parsed.execution.bindings[0]?.accountId).toBe(parsed.execution.route.accountId);
  });

  it("N5 refuses the singular binding key, and names its replacement", () => {
    // A clean break: `binding` and `bindings` are never both accepted. The
    // config is an internal artifact -- no contractVersion, no wire, no
    // producer outside this repository -- so the refusal IS the migration.
    const execution = validExecution();
    const singular = {
      route: execution.route,
      binding: { ...execution.bindings[0] },
    };
    const message = refusalOf(withExecution(singular));
    expect(message).toContain("execution.binding is no longer accepted");
    expect(message).toContain("execution.bindings");
  });

  it("N4 refuses a non-array and an empty array, each by name", () => {
    const execution = validExecution();
    expect(refusalOf(withExecution({ ...execution, bindings: {} }))).toContain(
      "execution.bindings must be an array",
    );
    expect(refusalOf(withExecution({ ...execution, bindings: [] }))).toContain(
      "execution.bindings must name at least one account",
    );
  });

  it("N2 refuses a repeated accountId, naming the index of the repeat", () => {
    // Reachable only because the shape is an array. `JSON.parse` keeps the LAST
    // duplicate key of an object silently, so a keyed shape would have made
    // last-wins the real behaviour and this refusal unfailable.
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");
    const message = refusalOf(
      withExecution({ ...execution, bindings: [first, { ...first }] }),
    );
    expect(message).toContain("execution.bindings[1].accountId");
    expect(message).toContain("repeats an account already bound");
  });

  it("N3 refuses a missing or malformed field per entry, by path, defaulting nothing", () => {
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");
    const home = first.workdir;

    for (const field of ["binary", "configRoot", "workdir"] as const) {
      // Rebuilt without the field rather than deleted from a copy: the absence
      // is what is under test, and constructing it directly says so.
      const complete = entryFor("acct-second", home);
      const broken = Object.fromEntries(
        Object.entries(complete).filter(([key]) => key !== field),
      );
      const message = refusalOf(withExecution({ ...execution, bindings: [first, broken] }));
      // The index and the field, so nothing is inherited from the sibling that
      // does carry it.
      expect(message).toContain("execution.bindings[1]." + field);
    }

    for (const budget of ["timeoutMs", "outputBudgetBytes", "interruptGraceMs", "termGraceMs"] as const) {
      const broken = entryFor("acct-second", home);
      const limits = Object.fromEntries(
        Object.entries(broken["limits"] as Record<string, unknown>).filter(
          ([key]) => key !== budget,
        ),
      );
      const message = refusalOf(
        withExecution({ ...execution, bindings: [first, { ...broken, limits }] }),
      );
      expect(message).toContain("execution.bindings[1].limits." + budget);
    }

    // A missing accountId is refused too, rather than taken from the route.
    const withAccount = entryFor("acct-second", home);
    const noAccount = Object.fromEntries(
      Object.entries(withAccount).filter(([key]) => key !== "accountId"),
    );
    expect(refusalOf(withExecution({ ...execution, bindings: [first, noAccount] }))).toContain(
      "execution.bindings[1].accountId",
    );
  });

  it("N6 refuses nine entries, and never truncates to eight", () => {
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");
    const home = first.workdir;

    // Exactly the ceiling is admitted, so the threshold is the stated number.
    const atCeiling = [
      first,
      ...Array.from({ length: MAX_EXECUTION_BINDINGS - 1 }, (_, i) => entryFor("acct-" + String(i), home)),
    ];
    expect(parseDaemonChildConfig(withExecution({ ...execution, bindings: atCeiling })).execution.bindings)
      .toHaveLength(MAX_EXECUTION_BINDINGS);

    const overCeiling = [...atCeiling, entryFor("acct-overflow", home)];
    const message = refusalOf(withExecution({ ...execution, bindings: overCeiling }));
    expect(message).toContain("execution.bindings carries more than " + String(MAX_EXECUTION_BINDINGS));
  });

  it("N12 refuses entries that disagree on workdir, naming both accounts", () => {
    // One worktree per packet. A per-binding worktree would move the checkout
    // mid switch, which is the context loss the objective forbids.
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");
    // The suite's own staging convention, so teardown removes it.
    const elsewhere = stage();

    const message = refusalOf(
      withExecution({
        ...execution,
        bindings: [first, { ...entryFor("acct-second", first.workdir), workdir: elsewhere }],
      }),
    );
    expect(message).toContain("execution.bindings disagree on workdir");
    expect(message).toContain("acct-second");
    expect(message).toContain(first.accountId);
  });

  it("N12 refuses a route whose account has no entry, naming execution.route.accountId", () => {
    // No fallback to "the first entry" and no default: running the route on
    // somebody else's binding is the cross-account leak this packet prevents.
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");
    const message = refusalOf(
      withExecution({
        ...execution,
        bindings: [{ ...first, accountId: "acct-somebody-else" }],
      }),
    );
    expect(message).toContain("execution.route.accountId names no entry");
  });

  it("N11/N10 admits every entry without spawning a provider or reaching a network", () => {
    // The whole suite parses documents; nothing here starts a process, opens a
    // socket or moves a capability out of UNKNOWN.
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");
    const parsed = parseDaemonChildConfig(
      withExecution({ ...execution, bindings: [first, entryFor("acct-second", first.workdir)] }),
    );
    expect(parsed.execution.bindings.every((b) => b.workdir === first.workdir)).toBe(true);
  });
});

/**
 * V2-B1f/F2b — a binding declares the provider it serves.
 *
 * F2 gave the entry an `accountId` but not a provider, so the composition had
 * nothing per-entry to select an adapter from and hoisted the route's out of
 * the loop. The config door is where that is fixed: every entry declares its
 * own provider, from the same vocabulary the route's own refinement uses, and
 * the routed entry must agree with the route.
 *
 * Every refusal is asserted **by its path**, and nothing is inherited: an entry
 * that omits the field is refused rather than filled from the route or from a
 * sibling that does carry it. Nothing here spawns a process, opens a socket or
 * names a credential; every case is a pure parse.
 */
describe("F2b: every execution binding declares its own provider", () => {
  function withExecution(execution: unknown): Record<string, unknown> {
    return { ...validConfig(), execution };
  }

  /** One well-formed entry, provider included, sharing the route's worktree. */
  function entryFor(accountId: string, provider: string, home: string): Record<string, unknown> {
    return {
      accountId,
      transportKind: "CLI_SUBSCRIPTION",
      provider,
      binary: realpathSync(process.execPath),
      configRoot: home,
      workdir: home,
      limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
    };
  }

  it("P2 admits a mixed-provider config: one route, two providers, one worktree", () => {
    // The claude route is served by the claude entry; a codex account sits
    // beside it, reachable but not routed. This is the shape F5's landing needs
    // and the shape the defect used to flatten onto one adapter.
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");
    const elsewhere = stage();

    const parsed = parseDaemonChildConfig(
      withExecution({
        ...execution,
        bindings: [
          first,
          { ...entryFor("acct-second", "codex", first.workdir), configRoot: elsewhere },
        ],
      }),
    );

    expect(parsed.execution.bindings).toHaveLength(2);
    expect(parsed.execution.bindings.map((b) => cli(b).provider)).toEqual(["claude", "codex"]);
    // One worktree, two credential roots: the switch lands without moving the
    // checkout, and neither account borrows the other's configuration.
    expect(parsed.execution.bindings.every((b) => b.workdir === first.workdir)).toBe(true);
    expect(cli(parsed.execution.bindings[1]).configRoot).toBe(elsewhere);
    expect(cli(parsed.execution.bindings[0]).configRoot).not.toBe(elsewhere);
  });

  it("P3 round-trips each entry's provider, and neither inherits the other's", () => {
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");

    const parsed = parseDaemonChildConfig(
      withExecution({
        ...execution,
        bindings: [
          first,
          entryFor("acct-second", "codex", first.workdir),
          entryFor("acct-third", "kimi", first.workdir),
        ],
      }),
    );

    expect(parsed.execution.bindings.map((b) => [b.accountId, cli(b).provider])).toEqual([
      ["acct-config-contract", "claude"],
      ["acct-second", "codex"],
      ["acct-third", "kimi"],
    ]);
    // The route's provider is not the map's default: two of the three differ
    // from it and survive.
    expect(parsed.execution.route.provider).toBe("claude");
  });

  it("N1 refuses an entry with no provider, by path, filling it from nothing", () => {
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");

    // Rebuilt without the field rather than deleted from a copy: the absence is
    // what is under test, and constructing it directly says so.
    const complete = entryFor("acct-second", "codex", first.workdir);
    const broken = Object.fromEntries(
      Object.entries(complete).filter(([key]) => key !== "provider"),
    );
    const message = refusalOf(withExecution({ ...execution, bindings: [first, broken] }));
    expect(message).toContain("execution.bindings[1].provider must be a non-empty string");
    // Not filled from `route.provider`, and not filled from the sibling that
    // does carry one: the document produces nothing at all.
    expect(refusalOf(withExecution({ ...execution, bindings: [first, broken] }))).not.toBe("");
  });

  it("N2 refuses a provider outside the CLI vocabulary, and a malformed one, by path", () => {
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");
    const home = first.workdir;

    // A real provider name this control plane has no CLI transport for. The
    // vocabulary refusal is separate from the shape refusal because they are
    // separate operator mistakes.
    const unknown = refusalOf(
      withExecution({ ...execution, bindings: [first, entryFor("acct-second", "gemini", home)] }),
    );
    expect(unknown).toContain("execution.bindings[1].provider");
    expect(unknown).toContain("names no CLI subscription provider");

    for (const malformed of [7, null, true, [], {}, ""]) {
      const message = refusalOf(
        withExecution({
          ...execution,
          bindings: [first, { ...entryFor("acct-second", "codex", home), provider: malformed }],
        }),
      );
      expect(message).toContain("execution.bindings[1].provider must be a non-empty string");
    }
  });

  it("N3 refuses a routed entry that disagrees with the route, naming both values", () => {
    // Refused at admission, not deferred to session time, where it would
    // surface as a port refusal in the middle of a walk.
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");

    const message = refusalOf(
      withExecution({ ...execution, bindings: [{ ...first, provider: "codex" }] }),
    );
    expect(message).toContain("execution.route.provider is claude");
    expect(message).toContain("but the entry serving it declares codex");
    expect(message).toContain("the routed entry must declare the provider the route names");
  });

  it("N4 lets a NON-routed entry differ freely from the route", () => {
    // The agreement rule binds the entry that serves the route and no other.
    // A backup account on a second provider is the point of the packet.
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");

    const parsed = parseDaemonChildConfig(
      withExecution({
        ...execution,
        bindings: [first, entryFor("acct-second", "codex", first.workdir)],
      }),
    );
    expect(cli(parsed.execution.bindings[0]).provider).toBe(parsed.execution.route.provider);
    expect(cli(parsed.execution.bindings[1]).provider).toBe("codex");
  });

  it("N9 leaves F2's invariants exactly as they were, with the field present", () => {
    // The new field neither relaxes the ceiling, the duplicate refusal, the
    // singular-key break nor the one-worktree law.
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");
    const home = first.workdir;

    const atCeiling = [
      first,
      ...Array.from({ length: MAX_EXECUTION_BINDINGS - 1 }, (_, i) =>
        entryFor("acct-" + String(i), "codex", home),
      ),
    ];
    expect(
      parseDaemonChildConfig(withExecution({ ...execution, bindings: atCeiling })).execution.bindings,
    ).toHaveLength(MAX_EXECUTION_BINDINGS);
    expect(
      refusalOf(
        withExecution({ ...execution, bindings: [...atCeiling, entryFor("acct-over", "kimi", home)] }),
      ),
    ).toContain("execution.bindings carries more than " + String(MAX_EXECUTION_BINDINGS));

    // Duplicate by index, still.
    expect(
      refusalOf(withExecution({ ...execution, bindings: [first, { ...first }] })),
    ).toContain("execution.bindings[1].accountId");

    // The singular key, still refused by name.
    expect(
      refusalOf(withExecution({ route: execution.route, binding: { ...first } })),
    ).toContain("execution.binding is no longer accepted");

    // One worktree, still, and both accounts still named.
    const elsewhere = stage();
    const split = refusalOf(
      withExecution({
        ...execution,
        bindings: [first, { ...entryFor("acct-second", "codex", home), workdir: elsewhere }],
      }),
    );
    expect(split).toContain("execution.bindings disagree on workdir");
    expect(split).toContain("acct-second");
  });

  it("N11 names the index of the entry that omitted it, not a sibling's value", () => {
    const execution = validExecution();
    const first = execution.bindings[0];
    if (first === undefined) throw new Error("expected an entry");

    const complete = entryFor("acct-second", "codex", first.workdir);
    const broken = Object.fromEntries(
      Object.entries(complete).filter(([key]) => key !== "provider"),
    );
    const message = refusalOf(withExecution({ ...execution, bindings: [first, broken] }));
    expect(message).toContain("execution.bindings[1].provider");
    // The first entry carries `claude`; the refusal is about index 1 and does
    // not report index 0 as the offender.
    expect(message).not.toContain("execution.bindings[0].provider");
  });
});

// ---------------------------------------------------------------------------
// V2-B1f/F4d — the door admits a decided switch, or refuses it by path
// ---------------------------------------------------------------------------

/**
 * A switch reaches a walk exactly as its route does: as data an elector
 * decided and this door admitted. What the door refuses is an authorization
 * that disagrees with the config it arrived in — because the walk that plays
 * it will not re-decide, so a disagreement admitted here becomes a switch
 * played against the wrong account, or toward one nothing can reach.
 */

function twoBindingExecution(): DaemonExecutionConfig {
  const base = validExecution();
  const routed = base.bindings[0];
  if (routed === undefined) throw new Error("the fixture declares no binding");
  return {
    ...base,
    bindings: [routed, { ...cli(routed), accountId: "acct-second", provider: "claude" as const }],
  };
}

function authorizationDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    trigger: "QUOTA_EXHAUSTED",
    decidedForAccountId: "acct-config-contract",
    decidedBy: "claude/opus/implementer/01",
    decidedAt: SUBMITTED_AT,
    decidedFromEventId: "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b01",
    observedSince: SUBMITTED_AT,
    plan: {
      kind: "SWITCH",
      accountStatus: "EXHAUSTED",
      taskState: "QUOTA_BLOCKED",
      steps: ["MARK_TASK_QUOTA_BLOCKED"],
      selectedAccountId: "acct-second",
      events: [{ type: "ACCOUNT_SWITCH_STARTED", payload: { toAccountId: "acct-second" } }],
    },
    ...overrides,
  };
}

function configWithAuthorization(
  authorization: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = validConfig();
  const execution = twoBindingExecution();
  const taskId = base["taskId"] as string;
  return {
    ...base,
    submissionDigest: canonicalSubmissionDigest({
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      initiativeId: CONFIG_INITIATIVE_ID,
      route: execution.route,
    }),
    execution: { ...execution, switchAuthorization: authorization },
    ...overrides,
  };
}

describe("F4d: the switch authorization is admitted at the same door as the route", () => {
  it("admits a complete, agreeing authorization", () => {
    const parsed = parseDaemonChildConfig(configWithAuthorization(authorizationDocument()));
    expect(parsed.execution.switchAuthorization?.trigger).toBe("QUOTA_EXHAUSTED");
    expect(parsed.execution.switchAuthorization?.plan.selectedAccountId).toBe("acct-second");
  });

  it("is optional, so every landed config still parses unchanged", () => {
    // The property that keeps every existing fixture valid: absent is the
    // ordinary case and is not a refusal.
    const parsed = parseDaemonChildConfig(validConfig());
    expect(parsed.execution.switchAuthorization).toBeUndefined();
  });

  it("refuses by path when the contract is not satisfied", () => {
    for (const [omitted, fragment] of [
      ["decidedAt", "switchAuthorization.decidedAt"],
      ["decidedFromEventId", "switchAuthorization.decidedFromEventId"],
      ["observedSince", "switchAuthorization.observedSince"],
      ["decidedBy", "switchAuthorization.decidedBy"],
    ] as const) {
      const authorization = Object.fromEntries(
        Object.entries(authorizationDocument()).filter(([key]) => key !== omitted),
      );
      expect({ omitted, refusal: refusalOf(configWithAuthorization(authorization)) }).toEqual({
        omitted,
        refusal: expect.stringContaining(fragment) as unknown as string,
      });
    }
  });

  it("refuses an authorization decided for another account than the route names", () => {
    // The agreement rule, beside the routed entry's. A decision taken against
    // another account is a decision a re-election overtook.
    const refusal = refusalOf(
      configWithAuthorization(authorizationDocument({ decidedForAccountId: "acct-elsewhere" })),
    );
    expect(refusal).toContain("decidedForAccountId");
    expect(refusal).toContain("acct-config-contract");
  });

  it("refuses a SWITCH plan naming no destination, and will not fill one in", () => {
    const authorization = authorizationDocument();
    const plan = { ...(authorization["plan"] as Record<string, unknown>), selectedAccountId: null };
    const refusal = refusalOf(configWithAuthorization({ ...authorization, plan }));
    expect(refusal).toContain("selectedAccountId is null for a SWITCH plan");
  });

  it("refuses a destination no binding declares", () => {
    const authorization = authorizationDocument();
    const plan = {
      ...(authorization["plan"] as Record<string, unknown>),
      selectedAccountId: "acct-unbound",
    };
    const refusal = refusalOf(configWithAuthorization({ ...authorization, plan }));
    expect(refusal).toContain("declares no entry in execution.bindings");
  });

  it("refuses a cross-provider destination, which is playable and never landable", () => {
    const base = validConfig();
    const routed = validExecution().bindings[0];
    if (routed === undefined) throw new Error("the fixture declares no binding");
    const execution: DaemonExecutionConfig = {
      ...validExecution(),
      bindings: [routed, { ...cli(routed), accountId: "acct-second", provider: "codex" as const }],
    };
    const taskId = base["taskId"] as string;
    const refusal = refusalOf({
      ...base,
      submissionDigest: canonicalSubmissionDigest({
        taskId,
        attempt: 1,
        submittedAt: SUBMITTED_AT,
        initiativeId: CONFIG_INITIATIVE_ID,
        route: execution.route,
      }),
      execution: { ...execution, switchAuthorization: authorizationDocument() },
    });
    expect(refusal).toContain("cross-provider switch cannot be landed yet");
  });

  it("refuses a non-SWITCH plan that selects an account anyway", () => {
    const authorization = authorizationDocument();
    const plan = {
      ...(authorization["plan"] as Record<string, unknown>),
      kind: "DRAIN",
      accountStatus: "DRAINING",
      taskState: null,
    };
    const refusal = refusalOf(configWithAuthorization({ ...authorization, plan }));
    expect(refusal).toContain("which selects no account");
  });

  it("N9: RESTATE refuses an authorization at the door rather than accepting it silently", () => {
    // Silence would let an operator write an authorization, watch the daemon
    // start, and believe a switch was armed in a mode that cannot play one.
    const execution = twoBindingExecution();
    const refusal = refusalOf(
      walksConfig(
        [
          walkEntry({
            execution: { ...execution, switchAuthorization: authorizationDocument() },
          }),
        ],
        { mode: "RESTATE" },
      ),
    );
    expect(refusal).toContain("switchAuthorization is admitted only under SQLITE_SUPERVISOR");
  });

  it("admits the same walk under SQLITE_SUPERVISOR", () => {
    const execution = twoBindingExecution();
    const parsed = parseDaemonChildConfig(
      walksConfig([
        walkEntry({ execution: { ...execution, switchAuthorization: authorizationDocument() } }),
      ]),
    );
    expect(parsed.walks?.[0]?.spec.execution.switchAuthorization?.trigger).toBe("QUOTA_EXHAUSTED");
  });
});

// ---------------------------------------------------------------------------
// V2-BE/R6: the parser admits a second transport, and refuses its confusions
// ---------------------------------------------------------------------------

describe("R6: an API_KEY binding is a shape of its own", () => {
  /** A config whose one binding is the API shape, with `patch` merged over it. */
  function apiConfig(patch: Record<string, unknown> = {}): Record<string, unknown> {
    const home = realpathSync(tmpdir());
    const config = validConfig();
    const execution = config["execution"] as Record<string, unknown>;
    const route = { ...(execution["route"] as { accountId: string }), transportKind: "API_KEY" };
    return {
      ...config,
      // Recomputed, never restated: the route is inside the submission
      // preimage, so changing the transport changes the digest the door checks.
      submissionDigest: canonicalSubmissionDigest({
        taskId: config["taskId"] as string,
        attempt: 1,
        submittedAt: SUBMITTED_AT,
        initiativeId: CONFIG_INITIATIVE_ID,
        route: route as unknown as DaemonExecutionConfig["route"],
      }),
      execution: {
        ...execution,
        route,
        bindings: [
          {
            accountId: route.accountId,
            transportKind: "API_KEY",
            workdir: home,
            limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
            ...patch,
          },
        ],
      },
    };
  }

  it("admits an API entry that carries only what that transport needs", () => {
    // The positive, so the refusals below are about the fields named and not
    // about the shape being unloadable in the first place.
    const parsed = parseDaemonChildConfig(apiConfig());
    const binding = parsed.execution.bindings[0];
    expect(binding?.transportKind).toBe("API_KEY");
    // D3: neither is a field of this shape, so neither can disagree with the
    // client that actually answers the call.
    expect(Object.hasOwn(binding ?? {}, "provider")).toBe(false);
    expect(Object.hasOwn(binding ?? {}, "binary")).toBe(false);
  });

  it("N5: refuses an API entry carrying binary or configRoot, naming the path", () => {
    // Refused, not ignored. An API entry carrying a binary is an operator who
    // believes this transport spawns something; ignoring the field would let
    // that belief survive a green start.
    expect(() => parseDaemonChildConfig(apiConfig({ binary: realpathSync(process.execPath) }))).toThrow(
      "execution.bindings[0].binary is not a field of an API_KEY binding",
    );
    expect(() => parseDaemonChildConfig(apiConfig({ configRoot: realpathSync(tmpdir()) }))).toThrow(
      "execution.bindings[0].configRoot is not a field of an API_KEY binding",
    );
    // And `provider`, for D3's reason rather than for the spawn's.
    expect(() => parseDaemonChildConfig(apiConfig({ provider: "claude" }))).toThrow(
      "execution.bindings[0].provider is not a field of an API_KEY binding",
    );
  });

  it("N6: refuses an API entry with no workdir", () => {
    // D4: the workdir locates the WALK, not the CLI. Every transport carries
    // it, and an entry without one is refused rather than defaulted from a
    // sibling.
    expect(() => parseDaemonChildConfig(apiConfig({ workdir: undefined }))).toThrow(
      "execution.bindings[0].workdir",
    );
  });

  it("N7: refuses a ninth binding of any transport, never truncating", () => {
    // The bound is on accounts reachable, and it does not care which transport
    // reaches them. Nine is refused whole: silently dropping the ninth would
    // leave a route naming it unservable for a reason nothing reported.
    const home = realpathSync(tmpdir());
    const config = apiConfig();
    const execution = config["execution"] as Record<string, unknown>;
    const first = (execution["bindings"] as Record<string, unknown>[])[0];
    const nine = Array.from({ length: 9 }, (_unused, index) => ({
      ...first,
      accountId: "acct-r6-" + String(index),
      workdir: home,
    }));
    expect(() =>
      parseDaemonChildConfig({ ...config, execution: { ...execution, bindings: nine } }),
    ).toThrow("execution.bindings carries more than 8 entries");
  });

  it("refuses a routed entry that declares a different transport than the route", () => {
    // The check the discriminant made possible, and the one that narrows the
    // provider comparison below it. An API route served by a CLI entry would
    // otherwise surface at session time as a spawn nobody asked for; refused
    // at the door, the operator learns it before anything runs.
    const home = realpathSync(tmpdir());
    const config = apiConfig();
    const execution = config["execution"] as Record<string, unknown>;
    const route = execution["route"] as { accountId: string };
    const cliEntry = {
      accountId: route.accountId,
      transportKind: "CLI_SUBSCRIPTION",
      provider: "claude",
      binary: realpathSync(process.execPath),
      configRoot: home,
      workdir: home,
      limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
    };
    expect(() =>
      parseDaemonChildConfig({ ...config, execution: { ...execution, bindings: [cliEntry] } }),
    ).toThrow("the routed entry must declare the transport the route names");
  });

  it("refuses an entry whose transport this daemon does not compose", () => {
    // Fail-closed on the vocabulary rather than on a list of the forbidden: a
    // transport added to the contract and named here reaches this line
    // unclassified, and is refused until somebody composes it.
    expect(() => parseDaemonChildConfig(apiConfig({ transportKind: "LOCAL" }))).toThrow(
      "execution.bindings[0].transportKind names no transport this daemon composes",
    );
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón D3: the recorded form (ADR 0105; decision 139, C6)
// ---------------------------------------------------------------------------

describe("the recorded form names a recorded task, and states none of the inline coordinates (P-15/D3)", () => {
  /** A present operator ledger file, canonical, in an owner-only directory. */
  function ledgerFile(): string {
    const dir = stage();
    const path = join(dir, "control-plane.sqlite");
    writeFileSync(path, "");
    return path;
  }

  function recordedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      mode: "SQLITE_SUPERVISOR",
      databasePath: ledgerFile(),
      taskId: randomUUID(),
      emittedBy: "claude/opus/implementer/01",
      holdOpen: false,
      checkPorts: false,
      execution: { ...validExecution(), catalogDocumentId: "catalog-recorded" },
      ...overrides,
    };
  }

  it("admits the recorded form and reads it as recorded, never as inline", () => {
    const document = recordedConfig();
    const parsed = parseDaemonChildConfig(document);
    expect(parsed.recorded).toEqual({ databasePath: document["databasePath"], catalogDocumentId: "catalog-recorded" });
    expect(parsed.taskId).toBe(document["taskId"]);
    expect(parsed.walks).toBeNull();
    expect(parsed.execution.route.accountId).toBe("acct-config-contract");
  });

  it("N-D1: refuses every inline coordinate beside databasePath, by name", () => {
    const inline = validConfig();
    for (const field of ["envelope", "walks", "scenarioId", "attempt", "submittedAt", "submissionDigest", "initiativeId"]) {
      const value = field === "walks" ? [] : inline[field];
      expect(refusalOf(recordedConfig({ [field]: value })), field).toBe(
        "config.databasePath and config." + field + " are exclusive; the recorded form reads the task's coordinates back from its ledger",
      );
    }
  });

  it("N-D19: databasePath is refused null, empty, relative, with a .. segment, absent on disk or through a symlink", () => {
    const dir = stage();
    const real = join(dir, "real.sqlite");
    writeFileSync(real, "");
    const link = join(dir, "link.sqlite");
    symlinkSync(real, link);
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["null", null, "config.databasePath must be an absolute path"],
      ["empty", "", "config.databasePath must be an absolute path"],
      ["relative", "ledger/control-plane.sqlite", "config.databasePath must be an absolute path"],
      // Concatenated, not joined: `join` would resolve the segment away.
      ["dotdot", dir + "/../control-plane.sqlite", "config.databasePath must contain no .. segment"],
      ["absent", join(dir, "missing.sqlite"), "config.databasePath does not exist"],
      ["symlink", link, "config.databasePath must be canonical; it traverses a symlink"],
    ];
    for (const [label, value, message] of cases) {
      expect(refusalOf(recordedConfig({ databasePath: value })), label).toBe(message);
    }
  });

  it("N-D19: taskId is refused absent, null or not a uuid; emittedBy absent or empty", () => {
    const withoutTask = recordedConfig();
    delete withoutTask["taskId"];
    expect(refusalOf(withoutTask)).toBe("config.taskId must be a uuid");
    expect(refusalOf(recordedConfig({ taskId: null }))).toBe("config.taskId must be a uuid");
    expect(refusalOf(recordedConfig({ taskId: "not-a-uuid" }))).toBe("config.taskId must be a uuid");
    expect(refusalOf(recordedConfig({ emittedBy: "" }))).toBe("config.emittedBy must be a non-empty string");
    const withoutEmitter = recordedConfig();
    delete withoutEmitter["emittedBy"];
    expect(refusalOf(withoutEmitter)).toBe("config.emittedBy must be a non-empty string");
  });

  it("ND-D3-2: the price catalog is named in the execution section, never defaulted, and only by the recorded form", () => {
    for (const value of [undefined, null, "", 7]) {
      const execution: Record<string, unknown> = { ...validExecution() };
      if (value !== undefined) execution["catalogDocumentId"] = value;
      expect(refusalOf(recordedConfig({ execution })), String(value)).toBe(
        "config.execution.catalogDocumentId must be a non-empty string; the recorded form names the price catalog" +
          " its delivery is pinned against, and there is no default",
      );
    }
    expect(refusalOf({ ...validConfig(), execution: { ...validExecution(), catalogDocumentId: "catalog-recorded" } })).toBe(
      "execution.catalogDocumentId belongs to the recorded form; an inline walk pins no price catalog",
    );
  });

  it("runs under SQLITE_SUPERVISOR only", () => {
    expect(refusalOf(recordedConfig({ mode: "RESTATE" }))).toBe(
      "config.mode RESTATE does not run the recorded form; it runs under SQLITE_SUPERVISOR",
    );
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón D3 v2: the recorded form, end to end through runDaemonChild
// ---------------------------------------------------------------------------

describe("the recorded form runs a fresh recorded task to its checkpoint (P-15/D3 v2, V-C1)", () => {
  const INITIATIVE = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7ad3e2";
  const REGISTRY_AT = "2026-08-01T00:00:00.000Z";
  const INTAKE_AT = "2026-09-13T12:00:00.000Z";
  const MODEL_VERSION = "claude-opus-5@2026-06-01";
  const CATALOG = "catalog-recorded-e2e";
  const ACCOUNT = "acct-recorded-e2e";
  const OPERATOR = "claude/opus/implementer/01";
  const WRITTEN = "docs/recorded.md";
  const INSTRUCTION = "echo the recorded instruction";

  function digest(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  /** An operator ledger with its registry, one priced catalog and one task entered through the real intake. */
  function operatorLedger(directory: string): { readonly databasePath: string; readonly taskId: string } {
    const databasePath = join(directory, "control-plane.sqlite");
    const taskId = randomUUID();
    const ledger = openLedger(databasePath);
    const leases = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(databasePath), {
      incarnationId: randomUUID(),
      createdAt: REGISTRY_AT,
    });
    try {
      const plane = openArtifactPlane({ ledger, leaseStore: leases, ledgerPath: databasePath });
      ledger.appendInitiativeEvent({
        contractVersion: CONTRACT_VERSION,
        eventId: randomUUID(),
        initiativeId: INITIATIVE,
        transitionId: "initiative.registered",
        idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId: INITIATIVE, transitionId: "initiative.registered" }),
        type: "INITIATIVE_REGISTERED",
        fromStatus: null,
        toStatus: "ACTIVE",
        emittedBy: OPERATOR,
        occurredAt: REGISTRY_AT,
        recordedAt: REGISTRY_AT,
        payload: {},
      });
      const document = (documentKind: string, documentId: string, payload: Record<string, unknown>): Record<string, unknown> => ({
        contractVersion: CONTRACT_VERSION,
        eventId: randomUUID(),
        idempotencyKey: documentId + "/1",
        documentKind,
        documentId,
        documentVersion: 1,
        parentDocumentVersion: null,
        contentDigest: digest(canonicalJsonStringify(payload)),
        recordedBy: "kimi/k3/coordinator/01",
        effectiveFrom: REGISTRY_AT,
        occurredAt: REGISTRY_AT,
        recordedAt: REGISTRY_AT,
        payload,
      });
      ledger.appendRegistryEvent(
        document("MODEL_VERSION", MODEL_VERSION, {
          provider: "claude",
          model: "claude-opus-5",
          release: "2026-06-01",
          status: "ACTIVE",
          contextTokens: 200000,
          policyVersion: "2026.09.0",
          deprecatedAt: null,
          eligibleRoles: ["implementer"],
          transports: ["CLI_SUBSCRIPTION"],
        }),
      );
      ledger.appendRegistryEvent(
        document("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", {
          role: "implementer",
          slot: 0,
          provider: "claude",
          modelVersionId: MODEL_VERSION,
          fallbacks: [],
        }),
      );
      ledger.appendRegistryEvent(
        document("PRICE_TABLE", CATALOG, {
          intervals: [
            {
              provider: "claude",
              modelVersionId: MODEL_VERSION,
              transportKind: "CLI_SUBSCRIPTION",
              tokenClass: "output",
              currency: "USD",
              effectiveFrom: REGISTRY_AT,
              effectiveTo: null,
              pricePerMillionNanos: 75_000_000_000,
            },
          ],
        }),
      );
      const envelope = {
        ...envelopeFor(taskId, INITIATIVE, [WRITTEN]),
        objective: INSTRUCTION,
        content: fixtureContent(INSTRUCTION),
        readSet: [WRITTEN],
      };
      const intake = intakeTask({
        ledger,
        plane,
        request: {
          envelope,
          clientScope: OPERATOR,
          clientRequestKey: "recorded-e2e-0001",
          roadmapVersionId: null,
          stepId: null,
          role: "implementer",
          slot: 0,
          transportKind: "CLI_SUBSCRIPTION",
          recordedBy: OPERATOR,
        },
        recordedAt: INTAKE_AT,
        holderPid: process.pid,
        identities: {
          eventId: randomUUID(),
          revisionId: randomUUID(),
          commandId: randomUUID(),
          artifactPinId: randomUUID(),
          artifactReferenceId: randomUUID(),
          intentionEventId: randomUUID(),
          terminalEventId: randomUUID(),
        },
      });
      if (!intake.ok) throw new Error("the fixture's intake was refused: " + intake.reason);
    } finally {
      leases.close();
      ledger.close();
    }
    return { databasePath, taskId };
  }

  /** A git worktree holding the one path the envelope declares, committed. */
  function worktree(): string {
    const directory = stage();
    const git = (...args: string[]): void => {
      spawnSync("/usr/bin/git", args, { cwd: directory, encoding: "utf8" });
    };
    git("init", "--quiet");
    git("config", "user.email", "drill@example.invalid");
    git("config", "user.name", "drill");
    mkdirSync(join(directory, "docs"), { recursive: true });
    writeFileSync(join(directory, WRITTEN), "recorded\n", "utf8");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture base");
    return directory;
  }

  /**
   * A synthetic Claude CLI behind the real adapter's argv: it reads the instruction
   * from stdin, keeps it in a side file it owns (never on stdout, which the adapter
   * parses), and answers in the captured stream-json shape with the instruction as
   * its text and one result usage. It is no provider and it spends nothing.
   */
  function fakeClaude(directory: string, echoPath: string): string {
    const binary = join(directory, "fake-claude");
    const program = [
      "#!" + realpathSync(process.execPath),
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => {",
      "  const text = Buffer.concat(chunks).toString('utf8');",
      "  require('node:fs').writeFileSync(" + JSON.stringify(echoPath) + ", text);",
      "  const at = process.argv.indexOf('--session-id');",
      "  const session = at >= 0 ? process.argv[at + 1] : 'session-recorded';",
      "  const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
      "  out({ type: 'system', subtype: 'init', model: 'claude-opus-5-20260601' });",
      "  out({ type: 'assistant', message: { id: 'msg_recorded_1', content: [{ type: 'text', text }] } });",
      "  out({ type: 'result', subtype: 'success', is_error: false, session_id: session,",
      "    usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } });",
      "  process.exit(0);",
      "});",
    ].join("\n");
    writeFileSync(binary, program + "\n", { mode: 0o700 });
    return binary;
  }

  function recordedDocument(databasePath: string, taskId: string, binary: string, workdir: string): Record<string, unknown> {
    const configRoot = stage();
    return {
      mode: "SQLITE_SUPERVISOR",
      databasePath,
      taskId,
      emittedBy: OPERATOR,
      holdOpen: false,
      checkPorts: false,
      execution: {
        route: {
          provider: "claude",
          model: "claude-opus-5",
          accountId: ACCOUNT,
          transportKind: "CLI_SUBSCRIPTION",
          capabilityPolicyVersion: "2026-08-30.1",
          resolvedAt: INTAKE_AT,
        },
        bindings: [
          {
            accountId: ACCOUNT,
            transportKind: "CLI_SUBSCRIPTION",
            provider: "claude",
            binary,
            configRoot,
            workdir,
            limits: { timeoutMs: 20_000, outputBudgetBytes: 65_536, interruptGraceMs: 200, termGraceMs: 200 },
          },
        ],
        catalogDocumentId: CATALOG,
      },
    };
  }

  it("V-C1: runDaemonChild starts a recorded task no walk has opened, and walks it to CHECKPOINTED with its whole chain", async () => {
    const home = stage();
    const { databasePath, taskId } = operatorLedger(home);
    const echoPath = join(stage(), "echo.txt");
    const binary = fakeClaude(stage(), echoPath);
    const config = parseDaemonChildConfig(recordedDocument(databasePath, taskId, binary, worktree()));

    await expect(runDaemonChild(config)).resolves.toBe(0);

    // The child ran once and was handed the composed instruction on stdin.
    expect(readFileSync(echoPath, "utf8")).toBe(INSTRUCTION);
    const ledger = openLedger(databasePath);
    try {
      expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");
      const types = ledger.listEvents({ taskId, limit: 200 }).events.map((record) => record.event.type);
      const at = types.indexOf("RUN_STARTED");
      expect(types.slice(at + 1, at + 9)).toEqual([
        "EFFECT_INTENDED",
        "DISPATCH_INTENDED",
        "DISPATCH_OUTCOME_RECORDED",
        "PROMPT_OCCURRENCE_RECORDED",
        "USAGE_STREAM_DECLARED",
        "USAGE_OBSERVATION_RECORDED",
        "DISPATCH_OUTCOME_RECORDED",
        "RESPONSE_OCCURRENCE_RECORDED",
      ]);
      expect(types).not.toContain("TOKEN_USAGE_RECORDED");
      // The lease was recorded once the walk opened the attempt, never before it.
      expect(types.indexOf("LEASE_ACQUIRED")).toBeGreaterThan(types.indexOf("TASK_ATTEMPT_OPENED"));
      expect(types.filter((type) => type === "LEASE_ACQUIRED")).toHaveLength(1);
      expect(ledger.verifyIntegrity().problems).toEqual([]);
    } finally {
      ledger.close();
    }
    // The marker lives beside the operator ledger, under the evidence root.
    expect(readdirSync(join(home, "executions", "executions"))).toHaveLength(1);
  });

  it("V-C2: a database under a product checkout, in any case, is refused before anything is created there", async () => {
    // Case-insensitive, as macOS filesystems are: the lowercase spelling is the same checkout.
    for (const segments of [["Rottay", "app-recorded"], ["rottay", "app-recorded"], ["ROTTAY", "Platform"]]) {
      const product = join(stage(), ...segments);
      mkdirSync(product, { recursive: true, mode: 0o700 });
      const databasePath = join(product, "control-plane.sqlite");
      writeFileSync(databasePath, "");
      const config = parseDaemonChildConfig(
        recordedDocument(databasePath, randomUUID(), fakeClaude(stage(), join(stage(), "never.txt")), worktree()),
      );
      await expect(runDaemonChild(config), segments.join("/")).rejects.toThrow("PRODUCT_PATH at databasePath; nothing was created");
      expect(existsSync(join(product, "executions")), segments.join("/")).toBe(false);
    }
  });
});
