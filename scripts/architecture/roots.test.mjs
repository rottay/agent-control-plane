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

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Run the real fence against a synthetic tree. Never against the real one.
 *
 * **Asynchronous on purpose, and it is the runner that requires it.** This file
 * spawns the whole fence fifteen times, and the fence takes seconds per run. A
 * `spawnSync` here blocks the vitest worker's event loop for essentially the
 * file's entire duration, so the worker cannot answer the runner's `onTaskUpdate`
 * RPC; past a certain number of probes the runner gives up on it and the project
 * exits non-zero with every assertion green -- a gate that reports failure while
 * proving nothing. Awaiting `spawn` leaves the loop free between runs, so the
 * worker stays reachable and the exit code means what it says.
 *
 * The contract is deliberately identical to the `spawnSync` it replaces:
 * `status` is the child's exit code and is `null` when a signal killed it, and
 * `output` is stdout and stderr concatenated in that order -- the fence writes
 * its `✗` lines to stderr, so a probe that read stdout alone would miss exactly
 * the lines it exists to assert. No timeout is imposed here, as none was before;
 * vitest's own per-test timeout remains the only bound.
 */
function runFenceAgainst(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FENCE], {
      env: { ...process.env, ACP_FENCE_ROOT: root },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    // A spawn that never started is reported rather than swallowed. `spawnSync`
    // would have returned `status: null` with empty output here, which a probe
    // asserting "not 0" would read as a pass -- a false green on a fence that
    // never ran.
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code, output: stdout + stderr });
    });
  });
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
  it("refuses a package that exists but no stratum classifies", async () => {
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

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("unclassified");
  });
});

describe("the fence fires its laws against a synthetic tree (L7)", () => {
  it("refuses a tree whose hook path is not configured", async () => {
    const root = syntheticTree();
    execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd: root });
    write(root, "README.md", "# probe\n");
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("core.hooksPath");
  });

  // The publication ruling of 2026-09-03 replaced "no remote may exist" with
  // "one remote may exist, and it is this one". These three cases are what that
  // law actually forbids, and they replace the single case that used to be
  // enough when every remote was a violation. A lone canonical origin is now
  // legal, so asserting that ANY remote fails would assert the old law.
  it("refuses a remote that is not the canonical repository", async () => {
    const root = syntheticTree();
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/x.git"], { cwd: root });
    write(root, "README.md", "# probe\n");
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output.toLowerCase()).toContain("remote");
    expect(output).toContain("only authorized repository");
  });

  it("refuses a second remote beside the canonical one", async () => {
    const root = syntheticTree();
    execFileSync("git", ["remote", "add", "origin", "https://github.com/rottay/agent-control-plane.git"], { cwd: root });
    execFileSync("git", ["remote", "add", "mirror", "https://example.invalid/x.git"], { cwd: root });
    write(root, "README.md", "# probe\n");
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("found also the remote(s): mirror");
  });

  it("refuses a canonical remote whose URL carries credentials", async () => {
    // The credential case is checked before the URL comparison, so the refusal
    // names the problem without echoing the secret back into the output.
    const root = syntheticTree();
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://token@github.com/rottay/agent-control-plane.git"],
      { cwd: root },
    );
    write(root, "README.md", "# probe\n");
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("embedded credentials");
    expect(output).not.toContain("token@");
  });

  it("refuses an entrypoint that hands the estimator an empty observation set (L-V2B1D-1)", async () => {
    // V2-B1d's law, with a fixture that can falsify it. Before that packet both
    // production doors passed `observations: []`, so every account estimated at
    // its full declared limit from zero evidence and the router ranked on a
    // constant. A law with no failing fixture is a law nobody has tested.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line rather than a nonzero exit — the
    // same discipline the conformance probe above holds to. Asserting only
    // "nonzero" would prove nothing about this law.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/probe/src/index.ts",
      "export const outcome = estimateQuota({ record, observations: [], limitKey, now });\n",
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("hands estimateQuota an empty observation set");
    expect(output).toContain("packages/entrypoints/probe/src/index.ts");
  });

  it("refuses an entrypoint that derives an account's effective state for itself (L-V2B1E-1)", async () => {
    // V2-B1e's law, with a fixture that can falsify it. The fold moved to
    // `@acp/accounts` so the CLI election and the gateway read model could
    // share one implementation; what the law guards is that a door needing the
    // answer does not write the authority law a second time.
    //
    // The fixture assigns the `stateSource:` LITERAL, which is the law's shape
    // predicate — deciding which source governs — rather than merely mentioning
    // `resultingState`, which several lawful readers do at HEAD when they
    // render a recorded value. A probe on the wrong shape would pass while the
    // law it claims to test was never exercised.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line and the offending path. Asserting
    // only "nonzero" would prove nothing about this law.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/probe/src/index.ts",
      'export const folded = { effectiveState: newest.resultingState, stateSource: "OPERATOR_ACTION" };\n',
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("assigns a stateSource literal");
    expect(output).toContain("packages/entrypoints/probe/src/index.ts");
  });

  it("leaves the lawful stateSource forms alone: a type member, a pass-through, a comparison", async () => {
    // The other half of a shape predicate's evidence, and the half a probe
    // usually lacks. Each of these three exists in production at HEAD and must
    // stay lawful; a law that caught them would be a law its own author had to
    // keep explaining. If the predicate ever widens to catch a declaration, a
    // forwarding assignment or a read, this fails and names the line.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/probe/src/index.ts",
      [
        'export interface Row { readonly stateSource: "OWNER_FILE" | "OPERATOR_ACTION"; }',
        "export const carried = { stateSource: folded.stateSource };",
        'export const operatorSet = account.stateSource === "OPERATOR_ACTION";',
        "export const rendered = { resultingState: row.event.resultingState };",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("assigns a stateSource literal");
    expect(output).not.toContain("assigns effectiveState from a recorded action");
  });

  it("refuses a module that constructs an ACCOUNT_SWITCH_COMPLETED event (L-B1F-1)", async () => {
    // V2-B1f/F1's law, with the fixture that can falsify it. The planner used to
    // emit a completion beside `ACCOUNT_SWITCH_STARTED`, before any of the steps
    // it names could have happened; F1 removed that producer and this law is
    // what keeps it removed.
    //
    // **After F1 the law has no permitted site anywhere in `src`.** That is what
    // makes this probe the law's only positive evidence: nothing in the tree
    // exercises it, so without a synthetic failure the law would ship enforced
    // and unfalsified -- passing over a hundred and thirty sources while proving
    // nothing about any of them.
    //
    // The fixture uses the **constructor** shape, which is the law's predicate.
    // A probe that merely mentioned the type would pass while testing a rule
    // nobody wrote: naming the type is lawful and stays lawful, since the event
    // remains in the frozen vocabularies and every read model that renders it.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line and the offending path.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/probe/src/index.ts",
      'export const completion = { type: "ACCOUNT_SWITCH_COMPLETED", payload: {} };\n',
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("constructs an ACCOUNT_SWITCH_COMPLETED event");
    expect(output).toContain("packages/domains/probe/src/index.ts");
  });

  it("leaves the lawful ACCOUNT_SWITCH_COMPLETED forms alone: a case, a comparison, a member", async () => {
    // The negative control, and the half that keeps the law honest. Every form
    // below exists lawfully in the tree today -- the frozen contracts and
    // protocol vocabularies list the type, read models switch and compare on it,
    // and the executor's own refusal must name what it refuses. A law that
    // caught these would be a law its author had to keep explaining.
    //
    // If the predicate ever widens from "constructs one" to "mentions one",
    // this fails and names the line.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/probe/src/index.ts",
      [
        'export const TYPES = ["ACCOUNT_SWITCH_STARTED", "ACCOUNT_SWITCH_COMPLETED"];',
        'export const isDone = (t) => t === "ACCOUNT_SWITCH_COMPLETED";',
        "export function render(t) {",
        "  switch (t) {",
        '    case "ACCOUNT_SWITCH_COMPLETED":',
        '      return "done";',
        "    default:",
        "      return null;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("constructs an ACCOUNT_SWITCH_COMPLETED event");
  });

  it("refuses a daemon source that reads a singular execution binding (L-B1F2-1)", async () => {
    // V2-B1f/F2's law, with the fixture that can falsify it. The daemon's
    // config carried one `execution.binding`, so a switch had nowhere to land:
    // the destination account had no binding no matter what the planner decided.
    // The break to `execution.bindings` is clean, and this law is what keeps it
    // from being quietly undone.
    //
    // The fixture uses the MEMBER shape, which is the law's predicate. A probe
    // on the bare word would test a rule nobody wrote: `const binding = ...` and
    // `binding.release()` are lawful in the daemon today and must stay lawful.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line and the offending path.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/daemon/src/probe/index.ts",
      "export const dir = options.execution.binding.workdir;\n",
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("names execution.binding");
    expect(output).toContain("packages/entrypoints/daemon/src/probe/index.ts");
  });

  it("leaves the lawful binding forms alone: a bare identifier, a typed parameter, the plural", async () => {
    // The negative control, and the half that keeps this law honest. Every form
    // below exists lawfully in the daemon today: the signal-handler resource is
    // called `binding`, it is typed as a parameter, it is released by method
    // call, and the execution section's own plural member is spelled
    // `bindings`. A law that caught any of them would be a law its author had
    // to keep explaining.
    //
    // The refusal message case is here too, and it is the load-bearing one: the
    // parser must NAME the singular key in order to refuse it, so a law that
    // read prose would forbid its own enforcement.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/daemon/src/probe/index.ts",
      [
        "export const finish = (binding) => { binding.release(); };",
        "export const held = installSignalHandlers(() => {});",
        "export const dirs = execution.bindings.map((entry) => entry.workdir);",
        'export const refuse = () => { throw new Error("execution.binding is no longer accepted"); };',
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("names execution.binding");
    expect(output).not.toContain("reads the singular binding member");
    expect(output).not.toContain("authors a singular binding: key");
  });

  it("refuses a daemon source that selects its CLI adapter from the route (L-F2B-1)", async () => {
    // V2-B1f/F2b's law. Before that packet `executionPortFor` hoisted one
    // adapter out of the entry loop -- `CLI_ADAPTERS[route.provider]` -- so
    // every admitted binding carried the route's, whatever account it served,
    // and the port's cross-provider guard compared a value against itself for
    // every map the daemon built. This is what keeps that shape from returning.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line and the offending path.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/daemon/src/probe/index.ts",
      "export const pick = (route) => CLI_ADAPTERS[route.provider];\n",
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("selects a CLI adapter from the route's provider");
    expect(output).toContain("packages/entrypoints/daemon/src/probe/index.ts");
  });

  it("leaves the lawful provider forms alone: per-entry selection, a refusal, a docblock", async () => {
    // The negative control, and the half that keeps this law from widening from
    // "selects from the route" to "mentions the route". Every form below is
    // lawful and must stay lawful: the composition selects per entry and builds
    // its context from the entry; the parser must NAME `execution.route
    // .provider` in order to refuse a routed entry that disagrees with it; and
    // a docblock has to be able to describe the shape the law forbids, which is
    // exactly what the comment above this law does.
    //
    // The anti-vacuity half fires here -- this synthetic tree has no real
    // composition site -- which is why only the forbidden-shape messages are
    // asserted absent, exactly as the `L-F3-2` pair does.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/daemon/src/probe/index.ts",
      [
        "// The defect this replaced selected CLI_ADAPTERS[route.provider] once,",
        "// out of the loop, and built every context as provider: route.provider.",
        "export const adapterFor = (entry) => CLI_ADAPTERS[entry.provider];",
        "export const contextFor = (entry, taskId) => ({ provider: entry.provider, taskId });",
        "export const agree = (route, routed) => {",
        "  if (routed.provider !== route.provider) {",
        '    throw new Error("execution.route.provider is " + route.provider + " but the entry serving it declares " + routed.provider);',
        "  }",
        "};",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("selects a CLI adapter from the route's provider");
    expect(output).not.toContain("builds an admission context from the route's provider");
  });

  it("refuses a domain source that constructs a CHECKPOINT_WRITTEN event (L-F3-1)", async () => {
    // V2-B1f/F3's law, with a fixture that can falsify it. Before that packet
    // the terminal appended the event and nothing was ever written, so a third
    // producer beside the plan and the guard would have been indistinguishable
    // from the two that are lawful. This is what keeps one from appearing.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line and the offending path.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/probe/index.ts",
      'export const forged = { type: "CHECKPOINT_WRITTEN", payload: {} };\n',
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "packages/domains/runtime/src/probe/index.ts constructs a CHECKPOINT_WRITTEN event",
    );
  });

  it("leaves the lawful CHECKPOINT_WRITTEN forms alone: a case, a comparison, a member, a message", async () => {
    // The negative control, and the half that keeps the law honest. Every form
    // below is lawful and must stay lawful: the terminal guard compares the
    // step's event type, the frozen contract vocabularies list the name, a
    // status renderer switches on it, and a refusal has to name what it
    // refuses. A law that caught any of them would be a law its author had to
    // keep explaining -- and the last one is load bearing, because the guard
    // that enforces this packet must be able to say the word.
    //
    // The provider mapping is here too. `"checkpoint.emitted" ->
    // "CHECKPOINT_WRITTEN"` is a name in a table, and the edges stratum is
    // outside the law's scope by construction rather than by exemption; the
    // form is included so a future re-scoping cannot quietly catch it.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/probe/index.ts",
      [
        'export const TYPES = ["TASK_DISCOVERED", "CHECKPOINT_WRITTEN"];',
        'export const isTerminal = (t) => t === "CHECKPOINT_WRITTEN";',
        'export const label = (t) => { switch (t) { case "CHECKPOINT_WRITTEN": return "checkpointed"; default: return t; } };',
        'export const persist = (step) => { if (step.eventType === "CHECKPOINT_WRITTEN") throw new Error("refusing to append CHECKPOINT_WRITTEN without a persisted checkpoint"); };',
        'export const SIGNAL = { "checkpoint.emitted": "CHECKPOINT_WRITTEN" };',
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("index.ts constructs a CHECKPOINT_WRITTEN event");
  });

  it("refuses a second artifact-root rule anywhere but the store that owns it (L-F3-2)", async () => {
    // N13, mechanically. The rule used to live in the gateway's roadmap-write
    // seam and was DELETED when it moved into `artifact-store`; this is what
    // keeps a second copy from coming back into any `src` the law scans.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/gateway/src/probe/index.ts",
      [
        'import { dirname, join } from "node:path";',
        'export function artifactRootFor(ledgerPath) { return join(dirname(ledgerPath), "artifacts"); }',
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("declares a second artifactRootFor");
    expect(output).toContain("packages/entrypoints/gateway/src/probe/index.ts");
  });

  it("leaves a lawful consumer of the one rule alone: importing and calling it", async () => {
    // The negative control for L-F3-2. Every consumer now imports the helper
    // and calls it, which is exactly what "one home" is supposed to look like.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/gateway/src/probe/index.ts",
      [
        'import { artifactRootFor, publishArtifact } from "@acp/ledger";',
        "export const publish = (ledgerPath, content) => publishArtifact(artifactRootFor(ledgerPath), content);",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("declares a second artifactRootFor");
    expect(output).not.toContain("composes an artifacts directory");
  });

  it("refuses an adapter that builds a pressure signal carrying a number (L-V2B1F4-1)", async () => {
    // V2-B1f/F4a's first law. The observation vocabulary carries a
    // classification and no quantity, so "never fabricate remaining quota" is
    // a property of the shape. This is what keeps an adapter from reading a
    // number out of a provider message and putting it beside the
    // classification, where the router would eventually act on it.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line and the offending path.
    const root = syntheticTree();
    write(
      root,
      "packages/edges/providers/src/probe/index.ts",
      'export const signal = { kind: "pressure", pressure: "QUOTA_EXHAUSTED", remaining: 12 };\n',
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("builds a pressure signal carrying a number");
    expect(output).toContain("packages/edges/providers/src/probe/index.ts");
  });

  it("leaves a lawful pressure constructor alone: a classification, and prose about numbers", async () => {
    // The negative control, and the half that keeps this law from widening
    // from "carries a quantity" to "mentions one". A constructor carrying only
    // the classification is the shipped shape; a comment describing the
    // members the law forbids is exactly what the law's own home does, and a
    // digit elsewhere in the file is not a digit in the constructor.
    const root = syntheticTree();
    write(
      root,
      "packages/edges/providers/src/probe/index.ts",
      [
        "// A pressure carries no remaining count, ratio, resetAt or retryAfter:",
        "// there is no field one of those could occupy, which is the point.",
        "export const MAX_FRAMES = 100;",
        'export const signal = { kind: "pressure", pressure: "QUOTA_EXHAUSTED" };',
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("builds a pressure signal carrying a number");
    expect(output).not.toContain("builds a pressure signal carrying a remaining member");
  });

  it("refuses an effects module that writes its marker before recording pressure (L-V2B1F4-2)", async () => {
    // V2-B1f/F4a's second law, the `L-B7T-3` twin. `closeIntent` probes first
    // and, on DONE, appends without re-entering `apply`, so a sink after the
    // marker is unreachable on exactly the resume window it covers.
    //
    // The fixture carries the spend sink and the conformance gate BEFORE the
    // marker deliberately: their own laws must stay silent, so what this probe
    // proves is that the new law fires on its own line rather than riding one
    // of theirs.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/execution-effects/index.ts",
      [
        "export const apply = (operation, target, trail) => {",
        "  recordUsage({ operationIndex: operation.operationIndex });",
        "  checkConformance(operation.operationIndex);",
        "  writeMarker(target, { eventCount: trail.length });",
        "  recordPressure({ operationIndex: operation.operationIndex });",
        "};",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("writes the evidence marker before recording pressure");
    expect(output).toContain("packages/domains/runtime/src/execution-effects/index.ts");
    // Its neighbours over the same two anchors stay silent: the spend sink and
    // the gate both precede the marker in this fixture.
    expect(output).not.toContain("writes the evidence marker before recording usage");
    expect(output).not.toContain("runs the conformance gate after the evidence marker");
  });

  it("leaves an effects module that records before its marker alone", async () => {
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/execution-effects/index.ts",
      [
        "export const apply = (operation, target, trail) => {",
        "  recordUsage({ operationIndex: operation.operationIndex });",
        "  recordPressure({ operationIndex: operation.operationIndex });",
        "  checkConformance(operation.operationIndex);",
        "  writeMarker(target, { eventCount: trail.length });",
        "};",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("writes the evidence marker before recording pressure");
    expect(output).not.toContain("no longer calls the pressure sink inside apply");
  });

  it("refuses a daemon seam that builds execution effects without a pressure sink (L-V2B1F4-3)", async () => {
    // V2-B1f/F4a's third law, written in `L-C-4c`'s shape rather than
    // `L-B7T-2`'s: `L-B7T-2` uses `indexOf` and checks only the FIRST
    // construction site, and this daemon builds two. The fixture below is the
    // isolation test N12 asks for -- both literals carry a conformance gate,
    // a usage sink and the recorder call, and the file selects its adapter per
    // entry, so `L-C-4c`, `L-B7T-2` and `L-F2B-1` all stay silent and only the
    // new law fires.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/daemon/src/index.ts",
      [
        "export const adapterFor = (entry) => CLI_ADAPTERS[entry.provider];",
        "export const singular = () => createExecutionEffects({",
        "  recordUsage: (sample) => recordTokenObservation(ledger, sample),",
        "  checkConformance: gate,",
        "});",
        "export const plural = () => createExecutionEffects({",
        "  recordUsage: (sample) => recordTokenObservation(ledger, sample),",
        "  checkConformance: gate,",
        "});",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("builds execution effects without a pressure sink");
    // Isolation: the three landed laws over the same file and the same call
    // sites report nothing here.
    expect(output).not.toContain("builds execution effects without a conformance gate");
    expect(output).not.toContain("builds the execution effects without a usage sink");
    expect(output).not.toContain("selects a CLI adapter from the route's provider");
  });

  it("leaves a daemon whose every seam carries a sink alone, and needs the recorder too", async () => {
    // Two halves in one control. A composition carrying a sink at both seams
    // and reaching the recorder is lawful and must stay silent; the same
    // composition with the sink but WITHOUT the recorder is the structurally-
    // live-behaviourally-empty shape, and it must not be.
    const lawful = syntheticTree();
    write(
      lawful,
      "packages/entrypoints/daemon/src/index.ts",
      [
        "export const adapterFor = (entry) => CLI_ADAPTERS[entry.provider];",
        "export const singular = () => createExecutionEffects({",
        "  recordUsage: (sample) => recordTokenObservation(ledger, sample),",
        "  recordPressure: (sample) => recordProviderPressure(ledger, sample),",
        "  checkConformance: gate,",
        "});",
        "export const plural = () => createExecutionEffects({",
        "  recordUsage: (sample) => recordTokenObservation(ledger, sample),",
        "  recordPressure: (sample) => recordProviderPressure(ledger, sample),",
        "  checkConformance: gate,",
        "});",
        "",
      ].join("\n"),
    );
    commitAll(lawful);

    const clean = await runFenceAgainst(lawful);
    expect(clean.output).not.toContain("builds execution effects without a pressure sink");
    expect(clean.output).not.toContain("passes a pressure sink that does not reach the recorder");

    const empty = syntheticTree();
    write(
      empty,
      "packages/entrypoints/daemon/src/index.ts",
      [
        "export const adapterFor = (entry) => CLI_ADAPTERS[entry.provider];",
        "export const singular = () => createExecutionEffects({",
        "  recordUsage: (sample) => recordTokenObservation(ledger, sample),",
        "  recordPressure: (sample) => sample,",
        "  checkConformance: gate,",
        "});",
        "",
      ].join("\n"),
    );
    commitAll(empty);

    const hollow = await runFenceAgainst(empty);
    expect(hollow.status).not.toBe(0);
    expect(hollow.output).toContain("passes a pressure sink that does not reach the recorder");
  });

  it("refuses two vocabularies that disagree on the quota members (L-V2B1F4-4)", async () => {
    // V2-B1f/F4a's fourth law, the `L-B7T-4` twin. The observation vocabulary
    // and the decision vocabulary stay two sets on purpose -- an auth
    // requirement and a transient are lawful observations that must never be
    // triggers -- but the overlap must be spelled identically on both sides,
    // or a pressure is recorded under a name the elector never derives.
    // `accounts` may not import the contracts' execution boundary, so the
    // fence is the only reader of both files.
    const root = syntheticTree();
    write(
      root,
      "packages/kernel/contracts/src/schemas/execution-boundary/index.ts",
      [
        "export const PROVIDER_PRESSURES = [",
        '  "AUTH_REQUIRED",',
        '  "QUOTA_EXHAUSTED",',
        '  "TRANSIENT",',
        "] as const;",
        "",
      ].join("\n"),
    );
    write(
      root,
      "packages/domains/accounts/src/switching/index.ts",
      [
        'export const SWITCH_TRIGGERS = ["QUOTA_WARNING", "QUOTA_EXHAUSTED"];',
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("disagree; a pressure recorded under a name the elector does not derive");
  });

  it("leaves two vocabularies that agree on the overlap alone, non-quota members included", async () => {
    // The negative control, and the half that keeps this law from collapsing
    // the two sets into one: the observation vocabulary carries three members
    // the decision vocabulary must NOT have, and that is lawful.
    const root = syntheticTree();
    write(
      root,
      "packages/kernel/contracts/src/schemas/execution-boundary/index.ts",
      [
        "export const PROVIDER_PRESSURES = [",
        '  "AUTH_REQUIRED",',
        '  "QUOTA_EXHAUSTED",',
        '  "QUOTA_WARNING",',
        '  "TRANSIENT",',
        '  "UNCLASSIFIED",',
        "] as const;",
        "",
      ].join("\n"),
    );
    write(
      root,
      "packages/domains/accounts/src/switching/index.ts",
      [
        'export const SWITCH_TRIGGERS = ["QUOTA_WARNING", "QUOTA_EXHAUSTED"];',
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("disagree; a pressure recorded under a name the elector does not derive");
  });

  it("refuses a claude or kimi adapter that classifies pressure (L-V2B1F4-5)", async () => {
    // V2-B1f/F4a's fifth law. Codex is the one adapter with protocol evidence
    // for a quota vocabulary; claude's result subtype is an open token and
    // kimi names exactly one code. Two empty tables are the honest result, and
    // this is what makes the packet that acquires the evidence move a law on
    // purpose rather than add a row quietly.
    const root = syntheticTree();
    write(
      root,
      "packages/edges/providers/src/kimi/index.ts",
      'export const guess = { kind: "pressure", pressure: "QUOTA_EXHAUSTED" };\n',
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("constructs a pressure signal; this adapter's provider publishes no quota");
    expect(output).toContain("packages/edges/providers/src/kimi/index.ts");
  });

  it("leaves the two evidence-free adapters alone while they classify nothing", async () => {
    // The negative control. Both files exist, both name the vocabulary in
    // prose, and neither constructs a carrier -- which is the shipped state
    // and must stay silent.
    const root = syntheticTree();
    write(
      root,
      "packages/edges/providers/src/claude/index.ts",
      [
        "// No quota row: the result subtype is an open token, so a QUOTA_EXHAUSTED",
        "// classification here would be an invention rather than a reading.",
        'export const signal = { kind: "authRequired", reason: "LOGIN_REQUIRED" };',
        "",
      ].join("\n"),
    );
    write(
      root,
      "packages/edges/providers/src/kimi/index.ts",
      [
        "// Kimi names exactly one code, and it is an auth refusal.",
        'export const signal = { kind: "authRequired", reason: "LOGIN_REQUIRED" };',
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("constructs a pressure signal; this adapter's provider publishes no quota");
  });

  it("refuses a decision verb that writes instead of deciding (L-F4B-1)", async () => {
    // V2-B1f/F4b's first law. The verb reaches the switch policy from an
    // entrypoint whose ledger handle is query-only, so an append is already a
    // database-level error; this is what stops that becoming untrue quietly.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line and the offending path.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/cli/src/cli/index.ts",
      [
        "function runSwitchDecision(values, io, ledger) {",
        "  const outcome = decideSwitch({ trigger, currentAccountId, routing });",
        "  return executeSwitchPlan({ ledger, plan: outcome.plan });",
        "}",
        "export interface CliSeams {}",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("names executeSwitchPlan inside the decision verb");
    expect(output).toContain("packages/entrypoints/cli/src/cli/index.ts");
  });

  it("leaves a decision verb that only decides alone, and needs both region anchors", async () => {
    // Two halves. The lawful verb — it folds, decides and prints, and names a
    // refusal in prose, which the literal-blanking makes safe — must stay
    // silent. And a file that loses the closing anchor must NOT silently widen
    // the region to the end of the file: the law says so by name.
    const lawful = syntheticTree();
    write(
      lawful,
      "packages/entrypoints/cli/src/cli/index.ts",
      [
        "function runSwitchDecision(values, io, ledger) {",
        "  const read = readAccountPressure(ledger, accountId, { since });",
        "  const folded = foldPressureTrigger(read.observations);",
        '  if (!folded.ok) return { decision: "NONE", reason: folded.reason };',
        "  const outcome = decideSwitch({ trigger: folded.trigger, currentAccountId, routing });",
        '  return { decision: outcome.plan.kind, plan: outcome.plan };',
        "}",
        "export interface CliSeams {}",
        "",
      ].join("\n"),
    );
    commitAll(lawful);

    const clean = await runFenceAgainst(lawful);
    expect(clean.output).not.toContain("inside the decision verb");

    const unanchored = syntheticTree();
    write(
      unanchored,
      "packages/entrypoints/cli/src/cli/index.ts",
      [
        "function runSwitchDecision(values, io, ledger) {",
        "  return decideSwitch({ trigger, currentAccountId, routing });",
        "}",
        "function somethingElse() {}",
        "",
      ].join("\n"),
    );
    commitAll(unanchored);

    const drifted = await runFenceAgainst(unanchored);
    expect(drifted.status).not.toBe(0);
    expect(drifted.output).toContain("no longer declares the CliSeams interface");
  });

  it("refuses a fold that restates the trigger names, in either form (L-F4B-2)", async () => {
    // V2-B1f/F4b's second law, and the reason it has two predicates. The fold
    // ranks an exhaustion above a warning; it must do that by walking the one
    // declared vocabulary, not by spelling the names again. A quoted literal
    // is the obvious restatement; a severity record is the one a string-only
    // law would have let through while defeating its whole purpose.
    const quoted = syntheticTree();
    write(
      quoted,
      "packages/domains/accounts/src/switching/index.ts",
      [
        "const SWITCH_TRIGGERS = [];",
        "function isTrigger(value) { return SWITCH_TRIGGERS.includes(value); }",
        "export function foldPressureTrigger(observations) {",
        "  void SWITCH_TRIGGERS;",
        "  void isTrigger(null);",
        '  const worst = observations.find((row) => row.pressure === "QUOTA_EXHAUSTED");',
        "  return worst;",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(quoted);

    const literal = await runFenceAgainst(quoted);
    expect(literal.status).not.toBe(0);
    expect(literal.output).toContain("restates a trigger name as a string literal inside the fold");

    const record = syntheticTree();
    write(
      record,
      "packages/domains/accounts/src/switching/index.ts",
      [
        "const SWITCH_TRIGGERS = [];",
        "function isTrigger(value) { return SWITCH_TRIGGERS.includes(value); }",
        "export function foldPressureTrigger(observations) {",
        "  void SWITCH_TRIGGERS;",
        "  void isTrigger(null);",
        "  const severity = { QUOTA_EXHAUSTED: 0, QUOTA_WARNING: 1 };",
        "  return observations.sort((a, b) => severity[a.pressure] - severity[b.pressure])[0];",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(record);

    const table = await runFenceAgainst(record);
    expect(table.status).not.toBe(0);
    expect(table.output).toContain("restates the trigger names as record keys inside the fold");
    // The two forms report differently, so a reader is told which one they wrote.
    expect(table.output).not.toContain("restates a trigger name as a string literal");
  });

  it("leaves a fold that walks the vocabulary and asks the predicate alone", async () => {
    // The negative control that matters. This fold ranks by severity and names
    // neither trigger: it walks the declared array and asks the module-private
    // predicate, which is the only shape the law permits — and it must stay
    // silent, or the law would forbid its own first rule.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/accounts/src/switching/index.ts",
      [
        "// The vocabulary is most-severe-first, and QUOTA_EXHAUSTED outranks",
        "// QUOTA_WARNING — prose the law must not catch.",
        'const SWITCH_TRIGGERS = ["QUOTA_EXHAUSTED", "QUOTA_WARNING"];',
        "function isTrigger(value) { return SWITCH_TRIGGERS.includes(value); }",
        "export function foldPressureTrigger(observations) {",
        "  for (const candidate of SWITCH_TRIGGERS) {",
        "    for (const row of observations) {",
        "      if (isTrigger(row.pressure) && row.pressure === candidate) return row;",
        "    }",
        "  }",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("restates a trigger name as a string literal inside the fold");
    expect(output).not.toContain("restates the trigger names as record keys inside the fold");
    expect(output).not.toContain("folds a trigger without walking SWITCH_TRIGGERS");
    expect(output).not.toContain("folds a trigger without asking isTrigger");
  });

  it("refuses a refusal raised inside the trail producer (L-F4E-1)", async () => {
    // V2-B1f/F4a errata, first assertion. The original defect lived INSIDE
    // `execute`: it threw on an error terminal and discarded a fully built,
    // contract-validated trail before `apply` reached either drain. A law
    // anchored only on the call site would never have looked here.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line and the offending path.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/execution-effects/index.ts",
      [
        "async function execute(input) {",
        "  const started = await input.port.start(input.route, input.request);",
        '  if (terminal.kind === "error") throw new ExecutionEffectError(terminal.refusal, "events.error");',
        "  return { ok: true, trail };",
        "}",
        "export function createExecutionEffects(input) {",
        "  return { async apply(operation) {",
        "    const outcome = await execute(input);",
        "    recordUsage({ operationIndex: operation.operationIndex });",
        "    recordPressure({ operationIndex: operation.operationIndex });",
        "    recordPressure({ operationIndex: operation.operationIndex });",
        "    if (!outcome.ok) throw new ExecutionEffectError(outcome.refusal, outcome.at);",
        "    checkConformance(operation.operationIndex);",
        "    writeMarker(target, { eventCount: outcome.trail.length });",
        "  } };",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("raises a refusal inside execute");
    expect(output).toContain("packages/domains/runtime/src/execution-effects/index.ts");
  });

  it("refuses a refusal raised between the trail and the last drain (L-F4E-1)", async () => {
    // The second assertion, and the reason the window ends at the LAST sink
    // call rather than the first: the pressure drain calls its sink once for a
    // pressure event and once for an auth requirement, so a throw between them
    // would break the auth half while passing a law that stopped at the first.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/execution-effects/index.ts",
      [
        "async function execute(input) {",
        "  return { ok: true, trail };",
        "}",
        "export function createExecutionEffects(input) {",
        "  return { async apply(operation) {",
        "    const outcome = await execute(input);",
        "    recordPressure({ operationIndex: operation.operationIndex });",
        "    if (!outcome.ok) throw new ExecutionEffectError(outcome.refusal, outcome.at);",
        "    recordPressure({ operationIndex: operation.operationIndex });",
        "    checkConformance(operation.operationIndex);",
        "    writeMarker(target, { eventCount: outcome.trail.length });",
        "  } };",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("raises a refusal between producing the trail and draining it");
  });

  it("refuses a composition that drains and then never refuses at all (L-F4E-1)", async () => {
    // The positive half. Without it, deleting the refusal outright satisfies
    // both negative halves — and a failed execution would then reach the
    // conformance gate and the marker, so `closeIntent` would append an
    // OUTCOME and the plane would record as completed an effect that failed.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/execution-effects/index.ts",
      [
        "async function execute(input) {",
        "  return { ok: true, trail };",
        "}",
        "export function createExecutionEffects(input) {",
        "  return { async apply(operation) {",
        "    const outcome = await execute(input);",
        "    recordPressure({ operationIndex: operation.operationIndex });",
        "    recordPressure({ operationIndex: operation.operationIndex });",
        "    checkConformance(operation.operationIndex);",
        "    writeMarker(target, { eventCount: outcome.trail.length });",
        "  } };",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("raises 0 refusals between the last drain and the conformance gate");
  });

  it("leaves the lawful order alone: produce, drain both, refuse, gate, marker", async () => {
    // The negative control, and the half that keeps this law from widening
    // from "refuses between the trail and the sinks" to "mentions the error
    // class". Every form below is lawful and must stay lawful: the producer
    // returns its outcome, both sink calls run, the refusal sits between the
    // last drain and the gate, and the file names the error class in exactly
    // the one place it is allowed to.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/execution-effects/index.ts",
      [
        "async function execute(input) {",
        "  const started = await input.port.start(input.route, input.request);",
        '  if (!started.ok) return { ok: false, refusal: started.refusal, at: started.at, trail: [] };',
        '  if (terminal === null) return { ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "events.terminal", trail };',
        '  if (terminal.kind === "error") return { ok: false, refusal: terminal.refusal, at: "events.error", trail };',
        "  return { ok: true, trail };",
        "}",
        "export function createExecutionEffects(input) {",
        "  return { async apply(operation) {",
        "    const outcome = await execute(input);",
        "    recordUsage({ operationIndex: operation.operationIndex });",
        "    recordPressure({ operationIndex: operation.operationIndex });",
        "    recordPressure({ operationIndex: operation.operationIndex });",
        "    if (!outcome.ok) throw new ExecutionEffectError(outcome.refusal, outcome.at);",
        "    checkConformance(operation.operationIndex);",
        "    writeMarker(target, { eventCount: outcome.trail.length });",
        "  } };",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("raises a refusal inside execute");
    expect(output).not.toContain("raises a refusal between producing the trail and draining it");
    expect(output).not.toContain("refusals between the last drain and the conformance gate, not one");
    expect(output).not.toContain("refuses on something other than the execution outcome");
  });

  it("refuses an admitted plan that drifts from the decided plan (L-F4D-1)", async () => {
    // V2-B1f/F4d's first law. A plan an operator writes into a configuration
    // document is admitted by a schema in the contracts; the plan an elector
    // produces is a value in the decision module. Neither package may import
    // the other's shape, so the fence is the only reader of both — and if the
    // two drift, a plan that parses at the door is one the decision could
    // never have made.
    const root = syntheticTree();
    write(
      root,
      "packages/kernel/contracts/src/schemas/execution-boundary/index.ts",
      [
        'export const SWITCH_STEP_NAMES = ["MARK_ACCOUNT_DRAINING", "CONTINUE"] as const;',
        "export const SwitchPlanShape = z.strictObject({",
        '  kind: z.enum(["DRAIN", "SWITCH"]),',
        '  accountStatus: z.enum(["DRAINING", "EXHAUSTED"]),',
        '  taskState: z.enum(["QUOTA_BLOCKED"]).nullable(),',
        "});",
        "",
      ].join("\n"),
    );
    write(
      root,
      "packages/domains/accounts/src/switching/index.ts",
      [
        'export const SWITCH_STEPS = Object.freeze(["MARK_ACCOUNT_DRAINING", "CONTINUE"]);',
        "export interface SwitchPlan {",
        '  readonly kind: "DRAIN" | "SWITCH" | "ESCALATE";',
        '  readonly taskState: "QUOTA_BLOCKED" | null;',
        "}",
        'export type SwitchAccountStatus = "DRAINING" | "EXHAUSTED";',
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the admitted and decided plan disagree on the plan kinds");
  });

  it("leaves an admitted plan that matches the decided one alone", async () => {
    const root = syntheticTree();
    write(
      root,
      "packages/kernel/contracts/src/schemas/execution-boundary/index.ts",
      [
        'export const SWITCH_STEP_NAMES = ["MARK_ACCOUNT_DRAINING", "CONTINUE"] as const;',
        "export const SwitchPlanShape = z.strictObject({",
        '  kind: z.enum(["DRAIN", "SWITCH", "ESCALATE"]),',
        '  accountStatus: z.enum(["DRAINING", "EXHAUSTED"]),',
        '  taskState: z.enum(["QUOTA_BLOCKED", "AUTH_REQUIRED"]).nullable(),',
        "});",
        "",
      ].join("\n"),
    );
    write(
      root,
      "packages/domains/accounts/src/switching/index.ts",
      [
        'export const SWITCH_STEPS = Object.freeze(["CONTINUE", "MARK_ACCOUNT_DRAINING"]);',
        "export interface SwitchPlan {",
        '  readonly kind: "ESCALATE" | "DRAIN" | "SWITCH";',
        '  readonly taskState: "AUTH_REQUIRED" | "QUOTA_BLOCKED" | null;',
        "}",
        'export type SwitchAccountStatus = "EXHAUSTED" | "DRAINING";',
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    // Compared as SETS, so a different declaration order is lawful — what the
    // law forbids is a different membership.
    expect(output).not.toContain("the admitted and decided plan disagree");
  });

  it("refuses a runtime source that names an elector symbol (L-F4D-2)", async () => {
    // The ruling made mechanical. `L-B7S` closes the daemon's stratum against
    // the four elector symbols; this closes the one below it, so the shape
    // where a walk resolves its own route cannot return under a symbol that
    // list has not learned.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/probe/index.ts",
      "export const pick = (request) => decideSwitch(request);\n",
    );
    write(
      root,
      "packages/domains/runtime/src/submission/index.ts",
      'import { resolveRoute } from "@acp/accounts";\nexport const compose = (r) => resolveRoute(r);\n',
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("names decideSwitch");
    expect(output).toContain("packages/domains/runtime/src/probe/index.ts");
  });

  it("keeps the one exemption honest: submission may name resolveRoute, and must", async () => {
    // Two halves. The exemption is lawful — ADR 0018 declares that home — and
    // it may not outlive its reason: a submission module that stopped naming
    // `resolveRoute` would be an exemption protecting nothing.
    const lawful = syntheticTree();
    write(
      lawful,
      "packages/domains/runtime/src/submission/index.ts",
      'import { resolveRoute } from "@acp/accounts";\nexport const compose = (r) => resolveRoute(r);\n',
    );
    commitAll(lawful);

    const clean = await runFenceAgainst(lawful);
    expect(clean.output).not.toContain("names resolveRoute");
    expect(clean.output).not.toContain("has outlived its");

    const hollow = syntheticTree();
    write(
      hollow,
      "packages/domains/runtime/src/submission/index.ts",
      "export const compose = (r) => r;\n",
    );
    commitAll(hollow);

    const stale = await runFenceAgainst(hollow);
    expect(stale.status).not.toBe(0);
    expect(stale.output).toContain("no longer names resolveRoute");
  });

  it("refuses a switch port composed without the lease this process holds (L-F4D-3)", async () => {
    // A switch appended without the lease it revokes would record an
    // enrichment naming nothing, and a lease invented at this seam rather than
    // taken from the arbiter would forge enforcement state.
    const root = syntheticTree();
    write(
      root,
      "packages/entrypoints/daemon/src/index.ts",
      [
        "export const walk = async () => {",
        "  const result = await runSqliteMode({",
        "    ledger: openedLedger,",
        "    switchPort: switchPortFor({ execution, ledger: openedLedger }),",
        "    emittedBy: options.emittedBy,",
        "  });",
        "  return result;",
        "};",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("composes a switch port without the lease this process holds");
  });

  it("leaves a seam that carries the real lease alone, and refuses a direct executor call", async () => {
    const lawful = syntheticTree();
    write(
      lawful,
      "packages/entrypoints/daemon/src/index.ts",
      [
        "export const walk = async () => {",
        "  const result = await runSqliteMode({",
        "    ledger: openedLedger,",
        "    switchPort: switchPortFor({ execution, ledger: openedLedger, lease: hold.lease }),",
        "    emittedBy: options.emittedBy,",
        "  });",
        "  return result;",
        "};",
        "",
      ].join("\n"),
    );
    commitAll(lawful);

    const clean = await runFenceAgainst(lawful);
    expect(clean.output).not.toContain("composes a switch port without the lease");
    expect(clean.output).not.toContain("names executeSwitchPlan directly");

    // The boundary itself: the daemon reaches the executor through the
    // composed port and by no other path.
    const direct = syntheticTree();
    write(
      direct,
      "packages/entrypoints/daemon/src/index.ts",
      [
        "export const walk = async () => {",
        "  const result = await runSqliteMode({",
        "    switchPort: switchPortFor({ execution, lease: hold.lease }),",
        "  });",
        "  executeSwitchPlan({ ledger, plan });",
        "  return result;",
        "};",
        "",
      ].join("\n"),
    );
    commitAll(direct);

    const bypass = await runFenceAgainst(direct);
    expect(bypass.status).not.toBe(0);
    expect(bypass.output).toContain("names executeSwitchPlan directly");
  });

  it("refuses a second source that appends an account action (L-F4C-1)", async () => {
    // The door moved down a stratum; what must not follow is a second one.
    // Two appends fold two histories, and the version each builds from its own
    // fold is the ledger's only concurrency guard — so a second door does not
    // merely duplicate code, it removes the guard.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/actions/index.ts",
      "export const record = (l, e) => l.appendAccountAction(e);\n",
    );
    write(
      root,
      "packages/entrypoints/gateway/src/account-actions/index.ts",
      "export const alsoRecord = (l, e) => l.appendAccountAction(e);\n",
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("appends an account action");
    expect(output).toContain("packages/entrypoints/gateway/src/account-actions/index.ts");
  });

  it("keeps the permitted door honest, and refuses an invented account status", async () => {
    // Three halves of one law, driven separately.
    //
    // Half 2, non-vacuity: a law whose permitted producer has gone away
    // passes over nothing, so the door must still be a door.
    const hollow = syntheticTree();
    write(
      hollow,
      "packages/domains/runtime/src/actions/index.ts",
      "export const record = (outcome) => outcome;\n",
    );
    commitAll(hollow);

    const gone = await runFenceAgainst(hollow);
    expect(gone.status).not.toBe(0);
    expect(gone.output).toContain("no longer appends an account action");

    // Half 3: no source outside the contracts stratum may construct an action
    // whose resulting state is a literal EXHAUSTED or COOLDOWN. No verb
    // implies either, so writing one would forge an override nobody asked for.
    const forged = syntheticTree();
    write(
      forged,
      "packages/domains/runtime/src/actions/index.ts",
      [
        "export const record = (l, e) => l.appendAccountAction(e);",
        'export const forge = () => ({ action: "DRAIN", resultingState: "EXHAUSTED" });',
        "",
      ].join("\n"),
    );
    commitAll(forged);

    const invented = await runFenceAgainst(forged);
    expect(invented.status).not.toBe(0);
    expect(invented.output).toContain("resultingState is a literal EXHAUSTED or COOLDOWN");

    // The negative control, and the law is worth little without it: an
    // operator-supplied state threaded through as a VALUE is exactly what the
    // override verb is for, and must stay lawful. Without this half the law
    // would quietly widen from "invents a status" to "mentions one".
    const lawful = syntheticTree();
    write(
      lawful,
      "packages/domains/runtime/src/actions/index.ts",
      [
        "export const record = (l, e) => l.appendAccountAction(e);",
        "export const overrideFor = (setState) => ({",
        '  action: "OWNER_OVERRIDE",',
        "  resultingState: setState,",
        "});",
        'export const REACHABLE = ["EXHAUSTED", "COOLDOWN"];',
        "",
      ].join("\n"),
    );
    commitAll(lawful);

    const value = await runFenceAgainst(lawful);
    expect(value.output).not.toContain("resultingState is a literal EXHAUSTED or COOLDOWN");
    expect(value.output).not.toContain("no longer appends an account action");
  });

  it("refuses a tracked file that no write-set declares (write-set conformance)", async () => {
    // Relabelled: this exercises the conformance law — a path outside every
    // declared write-set — which is a different law from the epoch below. The
    // earlier label claimed it proved the epoch, and it did not.
    const root = syntheticTree();
    write(root, "packages/invented/src/index.ts", "export const x = 1;\n");
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("packages/invented/src/index.ts");
  });

  it("refuses a declared, tracked file that was genuinely deleted (the epoch, L5)", async () => {
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

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("tracked path is missing: README.md");
  });

  it("refuses a retired path that came back (the epoch's other direction, L5)", async () => {
    // The mirror of the above: a path already retired may not reappear. Together
    // the two make the epoch a boundary rather than a suggestion — nothing
    // leaves the declared set without being retired, and nothing retired returns.
    const root = syntheticTree();
    write(root, "vitest.workspace.ts", "export default {};\n");
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("retired path is present again: vitest.workspace.ts");
  });

  it("runs against the synthetic tree and never against the real one", async () => {
    // The guarantee the whole mechanism rests on: the child's root is the
    // temporary directory, and the repository it was launched from is not it.
    const root = syntheticTree();
    write(root, "README.md", "# probe\n");
    commitAll(root);

    expect(root.startsWith(REAL_REPO)).toBe(false);
    const { output } = await runFenceAgainst(root);
    // Whatever it reported, it reported about the synthetic tree: the real
    // repository's own paths cannot appear in a run rooted somewhere else.
    expect(output).not.toContain(join(REAL_REPO, "packages", "domains", "runtime"));
  });
});
describe("the expired-literal table catches the fragments V2-B6-fence armed", () => {
  // Both probes drive the real fence as a subprocess against a synthetic tree,
  // so what is proved is that THIS table entry fires — not that some
  // neighbouring law happens to be red at the same time. The restore half is
  // the drill recorded in the packet report: with the entry removed, the same
  // tree passes, which is the pre-fix state.

  it("refuses a README that brings back the pre-G5 two-drivers sentence", async () => {
    const root = syntheticTree();
    // The pre-G10 bytes, across the wrap they had in the file. `flatten`
    // lowercases and collapses whitespace, so the line break is immaterial and
    // the literal matches the sentence as it was actually written.
    write(
      root,
      "README.md",
      "# probe\n\nloopback HTTP server, a CLI and a local UI — a durability plane with two\n" +
        "orchestration drivers under a supervised local daemon, a shadow-mode\n",
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("still says");
    expect(output).toContain("a durability plane with two orchestration drivers under a supervised local daemon");
  });

  it("does not fire on the successor sentence, which still names two drivers", async () => {
    // The discriminator, and the reason the literal is long. The live README
    // says "two orchestration drivers" too; a shorter pin would have made this
    // tree red and the law useless.
    const root = syntheticTree();
    write(
      root,
      "README.md",
      "# probe\n\na durability plane whose two orchestration drivers live in two packages\n" +
        "since G5, the SQLite supervisor in `@acp/runtime` and the Restate driver\n" +
        "in `@acp/durability`\n",
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).not.toContain("a durability plane with two orchestration drivers under a supervised local daemon");
  });

  it("refuses a contracts barrel that still counts its capability modules in prose", async () => {
    const root = syntheticTree();
    write(root, "README.md", "# probe\n");
    write(
      root,
      "packages/kernel/contracts/src/schemas/index.ts",
      "/**\n * Subdivided by P8-T G6 into fourteen capability modules, one per the section\n" +
        " * bands this file already carried.\n */\nexport {};\n",
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("still says");
    expect(output).toContain("fourteen capability modules");
  });
});

describe("the six barrel pin laws parse through one helper (V2-B6-fence)", () => {
  const FENCE_SOURCE = readFileSync(join(REAL_REPO, "scripts", "check-architecture.mjs"), "utf8");

  /**
   * The idiom the five laws carried inline until V2-B6-fence, verbatim.
   *
   * Kept here as a fixture rather than described in prose: the claim is that
   * it is WRONG in a specific way, and a claim about parsing is only checkable
   * against the parser.
   */
  function inlineIdiom(source) {
    const names = new Set();
    for (const block of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const piece of (block[1] ?? "").split(",")) {
        const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
        if (name !== undefined && name !== "") names.add(name);
      }
    }
    return names;
  }

  /** `barrelExportNames`, verbatim from the fence, kept in step by the assertion below. */
  function helper(source) {
    const names = new Set();
    for (const block of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const piece of (block[1] ?? "").split(",")) {
        const trimmed = piece.trim().replace(/^type\s+/, "");
        const name = trimmed.split(/\s+as\s+/).pop()?.trim();
        if (name !== undefined && name !== "") names.add(name);
      }
    }
    return names;
  }

  const BARREL = 'export { a, type B } from "./x.js";\n';

  it("shows the old idiom producing a name no barrel declares", () => {
    // Two failures out of one correct line: the law would report `type B` as an
    // export outside the closed surface, and then `B` as a pinned name the
    // barrel no longer exports. A false failure that looks exactly like a real
    // one -- which is the whole reason the helper exists.
    expect([...inlineIdiom(BARREL)].sort()).toEqual(["a", "type B"]);
    expect(inlineIdiom(BARREL).has("B")).toBe(false);
  });

  it("shows the helper producing the names the barrel actually exports", () => {
    expect([...helper(BARREL)].sort()).toEqual(["B", "a"]);
  });

  it("keeps the fixture honest against the fence's own helper", () => {
    // The fixture above only means something if it behaves like the function
    // the fence actually calls. So the fence's own declaration is lifted out
    // of its source and evaluated here, and the two are compared on their
    // ANSWERS rather than on their bytes -- byte equality would fail on
    // indentation, which is not what either of them means, and would pass on a
    // rewrite that changed the text without changing the parse.
    const declared = FENCE_SOURCE.match(/function barrelExportNames\(source\) \{([\s\S]*?)\n\}/);
    expect(declared).not.toBeNull();
    const real = new Function("source", declared[1]);

    for (const sample of [
      BARREL,
      'export { a } from "./x.js";\n',
      'export type { C, D } from "./y.js";\n',
      'export { e as f, type G as H } from "./z.js";\n',
      'export { i, type J, k } from "./w.js";\n',
      "",
    ]) {
      expect({ sample, names: [...real(sample)].sort() }).toEqual({
        sample,
        names: [...helper(sample)].sort(),
      });
    }

    // And the property the whole cleanup is for, asserted against the real one.
    expect(real(BARREL).has("B")).toBe(true);
    expect(real(BARREL).has("type B")).toBe(false);
  });

  it("routes exactly the six equality-pinned barrels through it, and no others", () => {
    // The wiring half. Reverting any one of the six to the inline idiom makes
    // this fail, which is what stops the cleanup from silently coming undone.
    const routed = [...FENCE_SOURCE.matchAll(/=\s*barrelExportNames\((\w+)\)/g)].map((m) => m[1]);
    expect(routed.sort()).toEqual(
      [
        "accountsIndex",
        "adaptersIndex",
        "durabilityBarrel",
        "observationIndex",
        "runtimeBarrel",
        "toolsIndex",
      ].sort(),
    );

    // And the two block-idiom sites that remain are the two the map excluded:
    // the daemon law, which also parses direct declarations, and the helper's
    // own body. Neither is one of the six.
    const inlineSites = [...FENCE_SOURCE.matchAll(/matchAll\(\/export\\s/g)].length;
    expect(inlineSites).toBe(2);
  });
});
