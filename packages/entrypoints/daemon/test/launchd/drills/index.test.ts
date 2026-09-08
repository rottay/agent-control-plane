import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DIR_MODE, FILE_MODE } from "../../../src/constants/index.js";
// `writeLaunchAgentAt` is module-private: it is not exported from the package
// entry point, and reaching it by relative path is exactly how the tests reach
// the parser internals C3 withdrew.
import { renderDir, renderLaunchAgent, writeLaunchAgent, writeLaunchAgentAt } from "../../../src/launchd/render/index.js";
import type { LaunchAgentValues } from "../../../src/launchd/render/index.js";
import { TEMPLATE_PATH } from "../validate/index.test.js";
import { readValues, validateTemplate } from "../../../src/launchd/validate/index.js";

/**
 * The artifact is inert, and these drills are what make that falsifiable.
 *
 * `plutil` runs here and nowhere else. P2D established exactly two production
 * subprocess sites, each allow-listed by path and purpose; adding a third for a
 * lint would be the wrong trade. In a test file `node:child_process` is already
 * a permitted import, so the system parser can be used as an independent second
 * reader without touching that law.
 *
 * Nothing here installs, loads or copies anything. The load command is never
 * invoked, and the user agent directory is never written.
 *
 * The two forbidden tokens below are assembled from pieces rather than written
 * out. That is not decoration: the fence refuses the bare literals in code, and
 * a test file exempted from that rule is an exemption that quietly becomes the
 * rule — which is exactly how this file ended up on an exemption list whose own
 * comment claimed no code was exempt.
 */

/** The load command, never written literally in this file. */
const LOAD_COMMAND = ["launch", "ctl"].join("");
/** The user agent directory, never written literally in this file. */
const AGENT_DIR = ["Launch", "Agents"].join("");

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const TEMPLATE = readFileSync(TEMPLATE_PATH, "utf8");

const temporaries: string[] = [];

beforeAll(() => {
  const built = spawnSync(process.execPath, [
    join(PACKAGE_ROOT, "..", "..", "..", "node_modules", "typescript", "bin", "tsc"),
    "--build",
    join(PACKAGE_ROOT, "tsconfig.json"),
  ]);
  if (built.status !== 0) throw new Error("could not build the daemon package for the drills");
}, 120_000);

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  rmSync(renderDir(), { recursive: true, force: true });
});

function fixture(): LaunchAgentValues {
  const created = mkdtempSync(join(tmpdir(), "acp-launchd-drill-"));
  temporaries.push(created);
  const dir = realpathSync(created);
  chmodSync(dir, 0o700);
  const programPath = join(dir, "daemon");
  const configPath = join(dir, "config.json");
  writeFileSync(programPath, "#!/bin/sh\nexit 0\n");
  chmodSync(programPath, 0o700);
  writeFileSync(configPath, "{}");
  chmodSync(configPath, 0o600);
  return {
    label: "com.rottay.agent-control-plane",
    programPath,
    configPath,
    workingDirectory: dir,
    stdoutPath: join(dir, "out.log"),
    stderrPath: join(dir, "err.log"),
  };
}

/** Lint a document with the system parser, via a temporary file. */
function plutilLint(source: string): number {
  const dir = mkdtempSync(join(tmpdir(), "acp-plutil-"));
  temporaries.push(dir);
  const file = join(dir, "candidate.plist");
  writeFileSync(file, source, "utf8");
  return spawnSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" }).status ?? -1;
}

/** Parse a document with the system parser and return its JSON form. */
function plutilJson(source: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "acp-plutil-"));
  temporaries.push(dir);
  const file = join(dir, "candidate.plist");
  writeFileSync(file, source, "utf8");
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("plutil could not convert: " + result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// L1, L2
describe("the tracked template", () => {
  it("passes the system linter exactly as tracked", () => {
    const result = spawnSync("/usr/bin/plutil", ["-lint", TEMPLATE_PATH], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(validateTemplate(TEMPLATE)).toEqual({ ok: true });
  });

  it("is inert on its face, read by the system parser", () => {
    const parsed = plutilJson(TEMPLATE);
    // Booleans from the parsed structure, never a substring: the reason B1
    // exists is that text and structure can disagree.
    expect(parsed["RunAtLoad"]).toBe(false);
    expect(parsed["KeepAlive"]).toBe(false);
    for (const key of ["StartInterval", "StartCalendarInterval", "WatchPaths", "QueueDirectories"]) {
      expect(Object.keys(parsed)).not.toContain(key);
    }
  });
});

// L3
/**
 * Fixed inputs, not the temporary fixture.
 *
 * The published digest has to be reproducible by somebody else, and a fixture
 * rooted in `mkdtemp` changes every run — the first version of this drill
 * printed a different digest each time, which is a number that looks like
 * evidence and is not. Rendering is pure and checks no path, so a synthetic
 * value set is the honest input for a receipt.
 */
const CANONICAL_VALUES: LaunchAgentValues = {
  label: "com.rottay.agent-control-plane",
  programPath: "/opt/acp/bin/daemon",
  configPath: "/opt/acp/etc/daemon.json",
  workingDirectory: "/opt/acp",
  stdoutPath: "/opt/acp/var/out.log",
  stderrPath: "/opt/acp/var/err.log",
};

describe("determinism", () => {
  it("renders byte-identically across repeated calls", () => {
    const digests = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rendered = renderLaunchAgent(TEMPLATE, CANONICAL_VALUES);
      expect(rendered.ok).toBe(true);
      if (rendered.ok) {
        digests.add(createHash("sha256").update(rendered.document).digest("hex"));
      }
    }
    expect(digests.size).toBe(1);

    // Also stable for the temporary fixture, which is the realistic input.
    const live = fixture();
    const a = renderLaunchAgent(TEMPLATE, live);
    const b = renderLaunchAgent(TEMPLATE, live);
    if (a.ok && b.ok) expect(a.document).toBe(b.document);

    process.stdout.write(
      "RECEIPT " +
        JSON.stringify({
          drill: "L3-DETERMINISM",
          renders: 5,
          distinctDigests: digests.size,
          canonicalDigest: [...digests][0],
        }) +
        "\n",
    );
  });
});

// L4, L5
describe("the rendered document", () => {
  it("passes the system linter", () => {
    const rendered = renderLaunchAgent(TEMPLATE, fixture());
    expect(rendered.ok).toBe(true);
    if (rendered.ok) expect(plutilLint(rendered.document)).toBe(0);
  });

  it("reads the same through both readers", () => {
    // The two-reader claim, made falsifiable: our parser and the operating
    // system's must agree on all six values and both booleans, or one of them
    // is reading a document the other is not.
    const values = fixture();
    const rendered = renderLaunchAgent(TEMPLATE, values);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    const ours = readValues(rendered.document);
    const theirs = plutilJson(rendered.document);

    expect(ours?.["Label"]).toBe(values.label);
    expect(ours?.["Program"]).toBe(values.programPath);
    expect(ours?.["WorkingDirectory"]).toBe(values.workingDirectory);
    expect(ours?.["StandardOutPath"]).toBe(values.stdoutPath);
    expect(ours?.["StandardErrorPath"]).toBe(values.stderrPath);
    expect(ours?.["ProgramArguments"]).toBe(values.programPath + " " + values.configPath);

    expect(theirs["Label"]).toBe(values.label);
    expect(theirs["Program"]).toBe(values.programPath);
    expect(theirs["WorkingDirectory"]).toBe(values.workingDirectory);
    expect(theirs["StandardOutPath"]).toBe(values.stdoutPath);
    expect(theirs["StandardErrorPath"]).toBe(values.stderrPath);
    expect(theirs["ProgramArguments"]).toEqual([values.programPath, values.configPath]);

    expect(theirs["RunAtLoad"]).toBe(false);
    expect(theirs["KeepAlive"]).toBe(false);
    expect(ours?.["RunAtLoad"]).toBe("false");
    expect(ours?.["KeepAlive"]).toBe("false");
  });
});

// L6
describe("mutation negatives", () => {
  const values = (): LaunchAgentValues => fixture();

  it("refuses a template flipped to RunAtLoad true", () => {
    const tampered = TEMPLATE.replace(
      "<key>RunAtLoad</key>\n\t<false/>",
      "<key>RunAtLoad</key>\n\t<true/>",
    );
    expect(tampered).not.toBe(TEMPLATE);
    expect(validateTemplate(tampered)).toMatchObject({ reason: "RUN_AT_LOAD_TRUE" });
    expect(renderLaunchAgent(tampered, values())).toMatchObject({ reason: "RUN_AT_LOAD_TRUE" });
  });

  it("refuses a template flipped to KeepAlive true", () => {
    const tampered = TEMPLATE.replace(
      "<key>KeepAlive</key>\n\t<false/>",
      "<key>KeepAlive</key>\n\t<true/>",
    );
    expect(tampered).not.toBe(TEMPLATE);
    expect(validateTemplate(tampered)).toMatchObject({ reason: "KEEP_ALIVE_TRUE" });
  });

  it("refuses every injected auto-start trigger", () => {
    for (const key of ["StartInterval", "StartCalendarInterval", "WatchPaths", "QueueDirectories", "StartOnMount", "Sockets", "MachServices", "inetdCompatibility"]) {
      const tampered = TEMPLATE.replace(
        "<key>KeepAlive</key>",
        "<key>" + key + "</key>\n\t<string>x</string>\n\t<key>KeepAlive</key>",
      );
      expect(validateTemplate(tampered)).toMatchObject({ reason: "FORBIDDEN_KEY" });
    }
  });

  it("refuses a template with an inertness key removed", () => {
    const tampered = TEMPLATE.replace("<key>RunAtLoad</key>\n\t<false/>\n\t", "");
    expect(tampered).not.toBe(TEMPLATE);
    expect(validateTemplate(tampered)).toMatchObject({ reason: "MISSING_KEY" });
  });
});

// L9, and the write path
describe("writing a rendered agent", () => {
  it("writes only under the ignored local root, owner-only and atomically", () => {
    const values = fixture();
    const written = writeLaunchAgent(values);
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const directory = renderDir();
    expect(written.path).toBe(join(realpathSync(directory), values.label + ".plist"));
    expect(statSync(directory).mode & 0o777).toBe(DIR_MODE);
    expect(statSync(written.path).mode & 0o777).toBe(FILE_MODE);
    // Write-then-rename leaves no temporary behind.
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(plutilLint(readFileSync(written.path, "utf8"))).toBe(0);
  });

  it("refuses to write when a referenced path is unsafe, and leaves nothing behind", () => {
    const values = fixture();
    chmodSync(values.programPath, 0o777);
    const written = writeLaunchAgent(values);
    expect(written.ok).toBe(false);
    expect(existsSync(join(renderDir(), values.label + ".plist"))).toBe(false);
  });
});

// L10, L11
describe("purity", () => {
  it("refuses a symlinked local root before creating anything outside", () => {
    // The defect this closes: recursive mkdir ran before the containment check,
    // so a symlinked `.acp-local` meant an external directory was created and
    // only then refused. "Refused, nothing written" has to be literally true.
    //
    // A disposable root is used throughout; the real `.acp-local` is never
    // touched by this test.
    const stage = realpathSync(mkdtempSync(join(tmpdir(), "acp-fakeroot-")));
    temporaries.push(stage);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "acp-outside-")));
    temporaries.push(outside);

    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched", "utf8");
    const sentinelBefore = readFileSync(sentinel, "utf8");
    const outsideBefore = readdirSync(outside).sort();

    // `.acp-local` inside the disposable root is a symlink pointing outside.
    symlinkSync(outside, join(stage, ".acp-local"));

    const values = fixture();
    const written = writeLaunchAgentAt(stage, values);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.reason).toBe("DESTINATION_OUTSIDE_LOCAL");

    // Nothing was created through the link, and the sentinel is byte-identical.
    expect(readdirSync(outside).sort()).toEqual(outsideBefore);
    expect(readFileSync(sentinel, "utf8")).toBe(sentinelBefore);
    expect(existsSync(join(outside, "launchd"))).toBe(false);
  });

  it("does not truncate a symlink planted at the predictable temporary name", () => {
    // The discriminating version of this drill. The old writer used
    // `<target>.tmp` opened with "w", so a symlink waiting at that exact name
    // pointed at an external file would have been followed and truncated before
    // the rename ever ran.
    //
    // Two properties are tested at once, and both are needed: the temporary
    // name is not derivable from the target, and the open refuses to follow a
    // link even if it were. A test that only checked for leftover `.tmp` files
    // passed against the old code, which is why this one plants the trap and
    // reads the sentinel afterwards.
    const stage = realpathSync(mkdtempSync(join(tmpdir(), "acp-stage-")));
    temporaries.push(stage);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "acp-target-")));
    temporaries.push(outside);

    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched", "utf8");

    const launchd = join(stage, ".acp-local", "launchd");
    mkdirSync(launchd, { recursive: true, mode: DIR_MODE });

    const values = fixture();
    // The trap, at the name the old implementation would have used.
    symlinkSync(sentinel, join(launchd, values.label + ".plist.tmp"));

    const written = writeLaunchAgentAt(stage, values);
    expect(written.ok).toBe(true);

    // The sentinel is byte-identical: it was neither followed nor truncated.
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    // And the planted link is still a link, untouched by the writer.
    expect(lstatSync(join(launchd, values.label + ".plist.tmp")).isSymbolicLink()).toBe(true);
    // No temporary of our own survived.
    const ours = readdirSync(launchd).filter((name) => name.startsWith(".") && name.endsWith(".tmp"));
    expect(ours).toEqual([]);
  });

  it("leaves no residue when the destination cannot be renamed into", () => {
    // A rename failure used to leave the temporary behind, outside the try.
    const stage = realpathSync(mkdtempSync(join(tmpdir(), "acp-stage2-")));
    temporaries.push(stage);
    const launchd = join(stage, ".acp-local", "launchd");
    mkdirSync(launchd, { recursive: true, mode: DIR_MODE });

    const values = fixture();
    // A directory at the target path makes rename fail with EISDIR/ENOTEMPTY.
    mkdirSync(join(launchd, values.label + ".plist"), { mode: DIR_MODE });
    writeFileSync(join(launchd, values.label + ".plist", "occupant"), "x", "utf8");

    const written = writeLaunchAgentAt(stage, values);
    expect(written.ok).toBe(false);

    const leftovers = readdirSync(launchd).filter((name) => name.includes("tmp"));
    expect(leftovers).toEqual([]);
    // The occupant is untouched.
    expect(readFileSync(join(launchd, values.label + ".plist", "occupant"), "utf8")).toBe("x");
  });

  it("binds the write to the tracked template, with no way to supply another", () => {
    // C3 in one assertion: the writer takes no template argument, so a caller
    // holding a different otherwise-valid document cannot route it to disk.
    // Arity is the assertion: the public effect takes exactly one argument, so
    // there is no parameter through which a caller could aim the destination.
    expect(writeLaunchAgent.length).toBe(1);
    const stage = realpathSync(mkdtempSync(join(tmpdir(), "acp-stage3-")));
    temporaries.push(stage);
    const written = writeLaunchAgentAt(stage, fixture());
    expect(written.ok).toBe(true);
    if (written.ok) {
      expect(readFileSync(written.path, "utf8")).toContain("com.rottay.agent-control-plane");
    }
  });

  it("validating and rendering create nothing", () => {
    rmSync(renderDir(), { recursive: true, force: true });
    const values = fixture();
    validateTemplate(TEMPLATE);
    renderLaunchAgent(TEMPLATE, values);
    readValues(TEMPLATE);
    expect(existsSync(renderDir())).toBe(false);
  });

  it("importing the launchd modules does nothing at all", () => {
    rmSync(renderDir(), { recursive: true, force: true });
    const entry = join(PACKAGE_ROOT, "dist", "launchd", "render", "index.js");
    const probe = [
      "const fs = require('node:fs');",
      "const dir = " + JSON.stringify(renderDir()) + ";",
      "import(" + JSON.stringify("file://" + entry) + ").then((module) => {",
      "  console.log(JSON.stringify({",
      "    dirExists: fs.existsSync(dir),",
      "    resources: process.getActiveResourcesInfo(),",
      "    exportsRender: typeof module.renderLaunchAgent === 'function',",
      "  }));",
      "});",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout.trim()) as {
      dirExists: boolean;
      resources: string[];
      exportsRender: boolean;
    };
    expect(observed.exportsRender).toBe(true);
    expect(observed.dirExists).toBe(false);
    expect(observed.resources).not.toContain("ChildProcess");
    expect(observed.resources).not.toContain("TCPServerWrap");
  });
});

// L12, L13
describe("adoption is impossible from here", () => {
  /**
   * The mutation drills moved out in P-01, and this note records where and why.
   *
   * Six cases used to live here. Five edited a **tracked file of this
   * repository** — one of them `docs/ROADMAP.md` and the architecture fence
   * itself — ran the fence for real, asserted a non-zero exit, and restored the
   * file in a `finally`. A sixth asserted the fence passed over the working tree
   * as it stood. The restore was careful and digest-checked, and it was still
   * the wrong shape: for the length of each drill the live checkout was
   * modified, so a crash or a concurrent writer would have destroyed work that
   * was not this suite's to risk. That hazard is why the full suite could not
   * be run.
   *
   * They now run in `scripts/architecture/roots.test.mjs`, against synthetic
   * trees under the helper that already existed for exactly this, and they
   * assert the **exact refusal line** rather than a non-zero exit — a minimal
   * tree exits non-zero for many reasons, so the old assertion could not tell
   * the law under test from an unrelated one.
   *
   * The sixth case has no successor here, deliberately. "The fence passes over
   * this checkout" is a claim about a tree no test owns, and a file that
   * asserted it while its neighbours mutated that same tree was measuring its
   * own interference. `pnpm check` is where that property is established, which
   * is where it was always actually established.
   *
   * What stays below reads this package and writes nothing.
   */

  it("no source in this package invokes the load command", () => {
    const roots = [join(PACKAGE_ROOT, "src"), join(PACKAGE_ROOT, "launchd")];
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        const content = readFileSync(path, "utf8");
        if (new RegExp(LOAD_COMMAND + "\\s+(load|bootstrap|kickstart|enable)").test(content)) {
          // The README documents the manual command in order to say it is
          // never automated; that is prose, and it is the only exemption.
          if (!path.endsWith(join("launchd", "README.md"))) offenders.push(path);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });

  it("nothing names the user agent directory as a write target", () => {
    // Comments are stripped first. These files necessarily NAME the directory
    // in order to say nothing writes there, and a check that cannot tell code
    // from prose fails on its own documentation — the exact trap P2C's `serve(`
    // check fell into once already.
    const stripComments = (source: string): string =>
      source.replace(new RegExp("/\\*[\\s\\S]*?\\*/", "g"), "").replace(new RegExp("(^|[^:])//.*$", "gm"), "$1");

    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (path.endsWith(".md")) continue;
        // Production sources only. The claim is that no production code writes
        // there; a test file naming the directory in an assertion is the check
        // itself, not a violation of it.
        if (path.endsWith(".test.ts")) continue;
        // validate/index.ts carries it as a denylist entry: the one place the
        // string may appear in code is the list of literals that must never appear.
        if (path.endsWith(join("launchd", "validate", "index.ts"))) continue;
        if (stripComments(readFileSync(path, "utf8")).includes(AGENT_DIR)) {
          offenders.push(path);
        }
      }
    };
    walk(join(PACKAGE_ROOT, "src"));
    expect(offenders).toEqual([]);
  });
});
