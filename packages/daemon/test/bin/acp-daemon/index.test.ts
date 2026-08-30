import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CONFIG_MAX_BYTES, checkConfigPath, loadDaemonConfig } from "../../../src/bin/config-file/index.js";
import { EXIT_CONFIG_CONTENT, EXIT_CONFIG_PATH, EXIT_USAGE, runPackagedEntry } from "../../../src/bin/acp-daemon/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
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

function validConfig(): Record<string, unknown> {
  return {
    mode: "SQLITE_SUPERVISOR",
    scenarioId: "config-contract",
    emittedBy: "claude/opus/implementer/01",
    taskId: randomUUID(),
    attempt: 1,
    submittedAt: "2026-08-27T18:46:07.000Z",
    submissionDigest: "c".repeat(64),
    initiativeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01",
    holdOpen: false,
    checkPorts: false,
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
    for (const broken of [
      { ...validConfig(), mode: "AUTO" },
      { ...validConfig(), submissionDigest: "nope" },
      { ...validConfig(), attempt: 0 },
      { ...validConfig(), taskId: 7 },
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
