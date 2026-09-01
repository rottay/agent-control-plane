/**
 * The fence's own probes (P8-T G0, L7 and L9).
 *
 * Two kinds of test live here, and the split is deliberate.
 *
 * The resolver is a pure module, so it is exercised by direct import: no
 * subprocess, no filesystem, no tree. That is L9's rehearsal — G1' is going to
 * move real packages on the strength of this resolver, and the rehearsal
 * happens over a synthetic two-level layout before anything touches the real
 * one.
 *
 * The fence itself is exercised **as a subprocess**, pointed at synthetic trees
 * in temporary directories via `ACP_FENCE_ROOT`. Three properties follow from
 * that choice rather than from discipline: the fence never imports itself, so
 * the self-import hazard is structurally impossible; the probes never read or
 * mutate the real tree, so a failing probe cannot damage the repository; and
 * the real-tree run stays what it always was — `pnpm check`, outside vitest.
 *
 * Every child is run to completion inside the test that spawns it (spawn, wait,
 * assert), and every temporary directory is removed in teardown, so this file
 * leaves no process and no directory behind. That is why the `fence` project
 * does not join the serialized pools: it binds no port and outlives nothing.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  PACKAGES_DIR,
  fenceRoot,
  inAnyArea,
  inArea,
  inPackage,
  packageOf,
  packagePrefix,
  packagesIn,
} from "./roots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FENCE = resolve(HERE, "..", "check-architecture.mjs");
const REAL_REPO = resolve(HERE, "..", "..");

const roots = [];

afterEach(() => {
  // Same discipline as the drill teardowns: remove what this file created, and
  // only that. Each root was produced by `mkdtemp`, so the path is this file's
  // own and cannot be a tree someone else owns.
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A synthetic tree, git-initialised, that the fence can actually be run against. */
function syntheticTree() {
  const root = mkdtempSync(join(tmpdir(), "acp-fence-probe-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "probe@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "probe"], { cwd: root });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root });
  return root;
}

function write(root, relativePath, content) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function commitAll(root) {
  execFileSync("git", ["add", "-A", "-f"], { cwd: root });
  execFileSync("git", ["-c", "user.email=p@e.invalid", "-c", "user.name=p", "commit", "-qm", "probe"], {
    cwd: root,
  });
}

/** Run the real fence against a synthetic tree. Never against the real one. */
function runFenceAgainst(root) {
  const result = spawnSync(process.execPath, [FENCE], {
    encoding: "utf8",
    env: { ...process.env, ACP_FENCE_ROOT: root },
  });
  return { status: result.status, output: (result.stdout ?? "") + (result.stderr ?? "") };
}

describe("the resolver answers package-path questions (L1)", () => {
  it("gives a prefix that cannot match a differently-named sibling", () => {
    expect(packagePrefix("ui")).toBe("packages/ui/");
    expect(inPackage("packages/ui/src/app.ts", "ui")).toBe(true);
    // The trailing separator is the whole point: without it this is a match.
    expect(inPackage("packages/ui-extras/src/app.ts", "ui")).toBe(false);
  });

  it("scopes to an area, including a nested one", () => {
    expect(inArea("packages/ui/src/a.ts", "ui", "src")).toBe(true);
    expect(inArea("packages/ui/test/a.ts", "ui", "src")).toBe(false);
    expect(inArea("packages/daemon/src/launchd/a.ts", "daemon", "src/launchd")).toBe(true);
    expect(inArea("packages/daemon/src/bin/a.ts", "daemon", "src/launchd")).toBe(false);
  });

  it("scopes to several areas at once", () => {
    expect(inAnyArea("packages/server/test/a.ts", "server", ["src", "test"])).toBe(true);
    expect(inAnyArea("packages/server/docs/a.md", "server", ["src", "test"])).toBe(false);
  });

  it("names the package a path belongs to, and refuses to guess", () => {
    expect(packageOf("packages/runtime/src/a.ts")).toBe("runtime");
    expect(packageOf("scripts/check-architecture.mjs")).toBeNull();
    expect(packageOf("packages/runtime")).toBeNull();
    expect(packageOf(PACKAGES_DIR + "/")).toBeNull();
  });

  it("rehearses on a synthetic two-level layout before G1' trusts it (L9)", () => {
    // The shape G1' will produce: packages grouped one level deeper. The
    // resolver is asked the same questions it will be asked then.
    const listing = [
      "packages/kernel/contracts/src/index.ts",
      "packages/kernel/contracts/test/index.test.ts",
      "packages/edges/durability/src/index.ts",
      "docs/ROADMAP.md",
    ];
    expect(packagesIn(listing)).toEqual(["edges", "kernel"]);
    expect(inArea("packages/kernel/contracts/src/index.ts", "kernel", "contracts/src")).toBe(true);
    expect(inPackage("packages/edges/durability/src/index.ts", "edges")).toBe(true);
    expect(inPackage("packages/edges/durability/src/index.ts", "kernel")).toBe(false);
  });
});

describe("the injectable root defaults to the real one (L7, L10)", () => {
  it("returns the caller's own root when nothing is set", () => {
    const fallback = "/somewhere/that/is/the/default";
    expect(fenceRoot({}, fallback)).toBe(fallback);
    expect(fenceRoot({ ACP_FENCE_ROOT: undefined }, fallback)).toBe(fallback);
  });

  it("treats an empty or whitespace value as unset, never as the filesystem root", () => {
    const fallback = "/default";
    expect(fenceRoot({ ACP_FENCE_ROOT: "" }, fallback)).toBe(fallback);
    expect(fenceRoot({ ACP_FENCE_ROOT: "   " }, fallback)).toBe(fallback);
  });

  it("uses the supplied root when one is set", () => {
    expect(fenceRoot({ ACP_FENCE_ROOT: "/tmp/synthetic" }, "/default")).toBe("/tmp/synthetic");
  });
});

describe("the classification law covers every package (L8)", () => {
  it("refuses a package that exists but no stratum classifies", () => {
    // The synthetic tree carries a package the strata table does not name, so
    // the completeness half of the law has to speak. This is the failure a
    // hand-maintained second list would eventually produce for real: a package
    // lands, and nothing says which stratum owns it.
    const root = syntheticTree();
    write(root, "packages/unclassified/package.json", '{"name":"@acp/unclassified","private":true,"license":"UNLICENSED"}\n');
    commitAll(root);

    const { status, output } = runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("unclassified");
  });
});

describe("the fence fires its laws against a synthetic tree (L7)", () => {
  it("refuses a tree whose hook path is not configured", () => {
    const root = syntheticTree();
    execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd: root });
    write(root, "README.md", "# probe\n");
    commitAll(root);

    const { status, output } = runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("core.hooksPath");
  });

  it("refuses a tree that declares a remote", () => {
    const root = syntheticTree();
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/x.git"], { cwd: root });
    write(root, "README.md", "# probe\n");
    commitAll(root);

    const { status, output } = runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output.toLowerCase()).toContain("remote");
  });

  it("refuses a tracked file that no write-set declares (write-set conformance)", () => {
    // Relabelled: this exercises the conformance law — a path outside every
    // declared write-set — which is a different law from the epoch below. The
    // earlier label claimed it proved the epoch, and it did not.
    const root = syntheticTree();
    write(root, "packages/invented/src/index.ts", "export const x = 1;\n");
    commitAll(root);

    const { status, output } = runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("packages/invented/src/index.ts");
  });

  it("refuses a declared, tracked file that was genuinely deleted (the epoch, L5)", () => {
    // The scenario the epoch law actually names. `README.md` is declared by a
    // frozen write-set array, so once it has entered the index it may not simply
    // vanish: retiring a pre-epoch path is a deliberate act that moves it into
    // RETIRED_PATHS, not something a deletion accomplishes on its own.
    const root = syntheticTree();
    write(root, "README.md", "# probe\n");
    commitAll(root);

    // Deleted from the worktree, still known to the index — which is exactly
    // the "genuinely deleted" state, and is why the law can tell it apart from
    // a declared path that has never been created.
    rmSync(join(root, "README.md"));

    const { status, output } = runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("tracked path is missing: README.md");
  });

  it("refuses a retired path that came back (the epoch's other direction, L5)", () => {
    // The mirror of the above: a path already retired may not reappear. Together
    // the two make the epoch a boundary rather than a suggestion — nothing
    // leaves the declared set without being retired, and nothing retired returns.
    const root = syntheticTree();
    write(root, "vitest.workspace.ts", "export default {};\n");
    commitAll(root);

    const { status, output } = runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("retired path is present again: vitest.workspace.ts");
  });

  it("runs against the synthetic tree and never against the real one", () => {
    // The guarantee the whole mechanism rests on: the child's root is the
    // temporary directory, and the repository it was launched from is not it.
    const root = syntheticTree();
    write(root, "README.md", "# probe\n");
    commitAll(root);

    expect(root.startsWith(REAL_REPO)).toBe(false);
    const { output } = runFenceAgainst(root);
    // Whatever it reported, it reported about the synthetic tree: the real
    // repository's own paths cannot appear in a run rooted somewhere else.
    expect(output).not.toContain(join(REAL_REPO, "packages", "runtime"));
  });
});
