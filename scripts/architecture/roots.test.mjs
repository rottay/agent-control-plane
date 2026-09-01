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
  packageLocation,
  packageOf,
  packagePrefix,
  packagesIn,
  stratumOf,
  topSegmentOf,
} from "./roots.mjs";

/**
 * The strata table the resolver is handed, matching the fence's own.
 *
 * It is written out here rather than imported because the resolver's contract
 * is "answer against the table you are given": a probe that shared the fence's
 * object could not tell a resolver that reads the table from one that ignores
 * it and happens to agree.
 */
const STRATA = {
  kernel: ["contracts", "api-contracts"],
  persistence: ["ledger"],
  domains: ["runtime", "accounts", "observation"],
  edges: ["adapters", "durability"],
  entrypoints: ["daemon", "server", "cli", "ui"],
};

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
    expect(packagePrefix("ui", STRATA)).toBe("packages/entrypoints/ui/");
    expect(inPackage("packages/entrypoints/ui/src/app.ts", "ui", STRATA)).toBe(true);
    // The trailing separator is the whole point: without it this is a match.
    expect(inPackage("packages/entrypoints/ui-extras/src/app.ts", "ui", STRATA)).toBe(false);
  });

  it("scopes to an area, including a nested one", () => {
    expect(inArea("packages/entrypoints/ui/src/a.ts", "ui", "src", STRATA)).toBe(true);
    expect(inArea("packages/entrypoints/ui/test/a.ts", "ui", "src", STRATA)).toBe(false);
    expect(
      inArea("packages/entrypoints/daemon/src/launchd/a.ts", "daemon", "src/launchd", STRATA),
    ).toBe(true);
    expect(
      inArea("packages/entrypoints/daemon/src/bin/a.ts", "daemon", "src/launchd", STRATA),
    ).toBe(false);
  });

  it("scopes to several areas at once", () => {
    expect(
      inAnyArea("packages/entrypoints/server/test/a.ts", "server", ["src", "test"], STRATA),
    ).toBe(true);
    expect(
      inAnyArea("packages/entrypoints/server/docs/a.md", "server", ["src", "test"], STRATA),
    ).toBe(false);
  });

  it("names the package a path belongs to, and refuses to guess", () => {
    expect(packageOf("packages/domains/runtime/src/a.ts", STRATA)).toBe("runtime");
    expect(packageOf("scripts/check-architecture.mjs", STRATA)).toBeNull();
    expect(packageOf("packages/domains/runtime", STRATA)).toBeNull();
    expect(packageOf(PACKAGES_DIR + "/", STRATA)).toBeNull();
  });

  it("reads the table it is handed rather than one of its own", () => {
    // The purity claim, made falsifiable: the same path resolves differently
    // under a different table, and a resolver holding its own inventory could
    // not produce the second answer.
    const moved = { kernel: ["contracts"], entrypoints: ["runtime"] };
    expect(packagePrefix("runtime", STRATA)).toBe("packages/domains/runtime/");
    expect(packagePrefix("runtime", moved)).toBe("packages/entrypoints/runtime/");
    expect(stratumOf("runtime", STRATA)).toBe("domains");
    expect(stratumOf("nothing-owns-this", STRATA)).toBeNull();
    expect(() => packagePrefix("nothing-owns-this", STRATA)).toThrow(/no stratum classifies/);
  });

  it("resolves a package two levels down, stratum and name together (G1')", () => {
    // The shape G1' produced. This was a rehearsal over a synthetic listing
    // while the packages still sat one level up; it is now the real layout, and
    // the resolver is asked the questions the fence actually asks it.
    const listing = [
      "packages/kernel/contracts/src/index.ts",
      "packages/kernel/contracts/test/index.test.ts",
      "packages/edges/adapters/src/index.ts",
      "docs/ROADMAP.md",
    ];
    expect(packagesIn(listing, STRATA)).toEqual(["adapters", "contracts"]);
    expect(packageLocation("packages/kernel/contracts/src/index.ts", STRATA)).toEqual({
      stratum: "kernel",
      name: "contracts",
    });
    expect(inArea("packages/kernel/contracts/src/index.ts", "contracts", "src", STRATA)).toBe(true);
    expect(inPackage("packages/edges/adapters/src/index.ts", "adapters", STRATA)).toBe(true);
    expect(inPackage("packages/edges/adapters/src/index.ts", "contracts", STRATA)).toBe(false);
    // `durability` is classified and does not exist yet. Naming a destination
    // is not the same as having files there, and the resolver says so.
    expect(packagePrefix("durability", STRATA)).toBe("packages/edges/durability/");
    expect(packagesIn(listing, STRATA)).not.toContain("durability");
  });

  it("refuses a file left under an old single-level prefix (G1')", () => {
    // The failure the move-map's absence law is written against: a file at the
    // pre-G1' location. It must not resolve — if it did, a half-completed
    // relocation would keep passing every path-scoped law that reads it.
    for (const stale of [
      "packages/contracts/src/index.ts",
      "packages/ui/src/app/index.tsx",
      "packages/daemon/test/fallback/index.test.ts",
    ]) {
      expect(packageLocation(stale, STRATA)).toBeNull();
      expect(packageOf(stale, STRATA)).toBeNull();
    }
    // It is unresolvable, but it is still describable — which is what lets the
    // fence fail on it by name instead of skipping it in silence.
    expect(topSegmentOf("packages/contracts/src/index.ts")).toBe("contracts");
    expect(packagesIn(["packages/contracts/src/index.ts"], STRATA)).toEqual([]);
  });

  it("refuses a package directory that never got its stratum (G1')", () => {
    // "At most two levels" has a floor as well as a ceiling. A package sitting
    // directly under `packages/`, and a stratum directory with loose files in
    // it, are both refused: neither is `packages/<stratum>/<name>/`.
    expect(packageLocation("packages/durability/src/index.ts", STRATA)).toBeNull();
    expect(packageLocation("packages/kernel/README.md", STRATA)).toBeNull();
    expect(packageLocation("packages/kernel", STRATA)).toBeNull();
    // A stratum that exists but does not own the name is refused too, so a
    // package cannot be filed under the wrong one and still resolve.
    expect(packageLocation("packages/kernel/ledger/src/index.ts", STRATA)).toBeNull();
    expect(packageLocation("packages/persistence/ledger/src/index.ts", STRATA)).toEqual({
      stratum: "persistence",
      name: "ledger",
    });
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

describe("the classification law covers every package (L8, G1')", () => {
  it("refuses a package that exists but no stratum classifies", () => {
    // The synthetic tree carries a package the strata table does not name, so
    // the completeness half of the law has to speak. This is the failure a
    // hand-maintained second list would eventually produce for real: a package
    // lands, and nothing says which stratum owns it.
    //
    // G1' merged the two halves of that guarantee rather than weakening it.
    // Before the move a package could sit at a valid location and still be
    // unclassified; now a valid location *is* a classified one, so it is the
    // two-level shape law that refuses this tree, by name and with a message
    // that says which part is missing. The property under test is unchanged —
    // a package the table does not name cannot exist — and this asserts it
    // through the law that now enforces it.
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
    expect(output).not.toContain(join(REAL_REPO, "packages", "domains", "runtime"));
  });
});
