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
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
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
 * The one permitted producer of a switch completion, as a minimal fixture.
 *
 * Two laws carry a vacuity half that names this exact path — `L-B1F-1`, which
 * permits it to construct an `ACCOUNT_SWITCH_COMPLETED`, and `L-F5-1`, which
 * requires it to name the durable field it selects a destination from. A
 * synthetic tree that omitted it would fail both for a reason no probe here is
 * about, so any fixture that wants a quiet baseline writes it.
 */
function landingHome(root) {
  write(
    root,
    "packages/domains/runtime/src/switch-landing/index.ts",
    [
      "export function land(started) {",
      "  const toAccountId = started.payload.toAccountId;",
      '  return { type: "ACCOUNT_SWITCH_COMPLETED", payload: { toAccountId } };',
      "}",
      "",
    ].join("\n"),
  );
}

/**
 * Run the real fence against a synthetic tree. Never against the real one.
 *
 * **Asynchronous on purpose, and it is the runner that requires it.** This file
 * spawns the whole fence once per probe, and the fence takes seconds per run. A
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
 *
 * `fenceScript` defaults to the real fence and is overridden by exactly one
 * caller: the roadmap probe below, which needs a fence whose roadmap digest pin
 * matches the fixture's own roadmap rather than this repository's. The override
 * is a path, not a behaviour flag -- the copy it points at is byte-identical to
 * `FENCE` apart from that one constant, and `fenceRepinnedTo` refuses to produce
 * it if the substitution did not happen.
 */
function runFenceAgainst(root, fenceScript = FENCE) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fenceScript], {
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

  it("refuses a SECOND module that constructs an ACCOUNT_SWITCH_COMPLETED event (L-B1F-1)", async () => {
    // V2-B1f/F1's law, with the fixture that can falsify it. The planner used to
    // emit a completion beside `ACCOUNT_SWITCH_STARTED`, before any of the steps
    // it names could have happened; F1 removed that producer and this law is
    // what keeps it removed.
    //
    // **V2-B1f/F5 moved the law rather than working around it**, so it now has
    // exactly ONE permitted site: the landing that finishes a switch. This
    // probe is therefore about the SECOND producer -- the fixture writes the
    // permitted site as well, so what trips the law is the second one and not
    // the absence of the first.
    //
    // The fixture uses the **constructor** shape, which is the law's predicate.
    // A probe that merely mentioned the type would pass while testing a rule
    // nobody wrote: naming the type is lawful and stays lawful, since the event
    // remains in the frozen vocabularies and every read model that renders it.
    //
    // A minimal synthetic tree trips several fail-closed `requireScope` laws at
    // once, so this asserts the SPECIFIC line and the offending path.
    const root = syntheticTree();
    landingHome(root);
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
    // And the permitted site is not what it named.
    expect(output).not.toContain(
      "packages/domains/runtime/src/switch-landing/index.ts constructs an ACCOUNT_SWITCH_COMPLETED",
    );
  });

  it("keeps the permitted completion producer honest: a landing that stops building one (L-B1F-1)", async () => {
    // The vacuity half V2-B1f/F5 added, in `L-F3-1`'s shipped shape. A law
    // whose permitted producer has gone away passes over a hundred and
    // thirty-five sources while proving nothing about any of them, so the site
    // must still be a site. The fixture keeps the module -- and the field
    // `L-F5-1` requires of it -- and takes away only the constructor.
    const root = syntheticTree();
    write(
      root,
      "packages/domains/runtime/src/switch-landing/index.ts",
      [
        "export function land(started) {",
        "  const toAccountId = started.payload.toAccountId;",
        "  return { landed: false, toAccountId };",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("no longer builds the completion a landed switch earns");
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
    landingHome(root);
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
    expect(output).not.toContain("no longer builds the completion a landed switch earns");
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

  it("refuses a module that selects a switch destination by position (L-F5-1)", async () => {
    // V2-B1f/F5's law, with the fixture that can falsify it. The failure it
    // exists to make impossible is the quiet one: a landing that, finding no
    // destination it liked, reached for the first admitted binding and finished
    // the switch on the wrong account with a completion that looks exactly like
    // a correct one. Nothing lawful selects by position today, so without a
    // synthetic failure the law would ship enforced and unfalsified.
    //
    // The permitted landing site is written too, so what trips the law is the
    // positional selection rather than either vacuity half.
    const root = syntheticTree();
    landingHome(root);
    write(
      root,
      "packages/entrypoints/probe/src/index.ts",
      [
        "export function destinationFor(execution) {",
        "  return execution.bindings[0];",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("selects a binding or a destination by position");
    expect(output).toContain("packages/entrypoints/probe/src/index.ts");
  });

  it("keeps the destination read honest, and leaves all three lawful finds alone (L-F5-1)", async () => {
    // Two halves, driven separately.
    //
    // Half 2, the vacuity guard: a landing that stopped naming the field it
    // selects from would satisfy the positional half vacuously — it indexes
    // nothing at all — while landing on whatever account the route carried.
    const hollow = syntheticTree();
    write(
      hollow,
      "packages/domains/runtime/src/switch-landing/index.ts",
      [
        "export function land(route) {",
        '  return { type: "ACCOUNT_SWITCH_COMPLETED", payload: { account: route.accountId } };',
        "}",
        "",
      ].join("\n"),
    );
    commitAll(hollow);

    const gone = await runFenceAgainst(hollow);
    expect(gone.status).not.toBe(0);
    expect(gone.output).toContain("no longer names toAccountId");

    // The negative control, and the law is worth little without it. There are
    // THREE lawful `find`s on account identity in the tree — `bindingForRoute`
    // exists twice with a byte-identical predicate, in the config door and in
    // the daemon's own composition, and the player has its own
    // `destinations.find` — and every one of them serves the route or the
    // DECIDED destination rather than a position. A law that caught these would
    // have widened from "selects by position" to "selects at all".
    const lawful = syntheticTree();
    landingHome(lawful);
    write(
      lawful,
      "packages/entrypoints/probe/src/index.ts",
      [
        "export function bindingForRoute(execution) {",
        "  return execution.bindings.find((entry) => entry.accountId === execution.route.accountId);",
        "}",
        "export function alsoBindingForRoute(execution) {",
        "  return execution.bindings.find((entry) => entry.accountId === execution.route.accountId);",
        "}",
        "export function destinationFor(destinations, decided) {",
        "  return destinations.find((entry) => entry.accountId === decided);",
        "}",
        "export const history = (rows) => rows.at(-1);",
        "",
      ].join("\n"),
    );
    commitAll(lawful);

    const kept = await runFenceAgainst(lawful);
    expect(kept.output).not.toContain("selects a binding or a destination by position");
    expect(kept.output).not.toContain("no longer names toAccountId");
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

  it("delivers every diagnostic of a failing run, under concurrent load (H1)", async () => {
    // Codex 2026-09-08 observation 2, and a defect three phases had already
    // measured before it was named. Toward a pipe Node's stdio is asynchronous,
    // and the `process.exit(1)` this fence used to end a red run with tore the
    // process down without draining it: the exit code arrived intact and the
    // TAIL of the `✗` block did not — a gate that announces 626 violations and
    // then shows 397 of them. P-01 saw the tail go; P-03 measured 693-1226 of
    // 1227 lines lost; P-02's N24 went red on a line the fence had printed and
    // then dropped, and passed on the re-run. The fence now assigns
    // `process.exitCode` and lets the module end, so the writes complete first.
    //
    // Reproducing it needs three conditions at once, and all three are here: a
    // failing run whose output is far larger than a pipe buffer, which a bare
    // synthetic tree gives for free by breaking hundreds of laws at once;
    // capture THROUGH a pipe, which is what `runFenceAgainst` does and what
    // every real caller does; and enough concurrency that the pending writes
    // cannot finish before the process would have exited. K was chosen by
    // measurement rather than taste: against the parent commit, K = 20 truncated
    // 7 runs of 20, the worst delivering 397 of 626 `✗` lines, and it costs
    // about 17s of the project's 120s budget. K = 1 reproduces nothing.
    //
    // The assertion is deliberately not a fixed string. The fence's own counter
    // announces how many violations it is about to print, so each run is held to
    // its own promise: N announced, N `✗` lines delivered, and the blank line
    // the failure block closes with actually arriving. That stays true however
    // the set of laws a bare tree breaks changes.
    const K = 20;
    const root = syntheticTree();

    const runs = await Promise.all(Array.from({ length: K }, () => runFenceAgainst(root)));

    for (const [index, { status, output }] of runs.entries()) {
      expect(status, `run ${index} should have failed`).not.toBe(0);

      const counter = /Architecture fence FAILED with (\d+) violation\(s\):/.exec(output);
      expect(counter, `run ${index} printed no violation counter`).not.toBeNull();
      const announced = Number(counter[1]);
      // The load condition itself, asserted rather than assumed: a fixture that
      // one day failed two laws would make everything below vacuously true.
      expect(announced, `run ${index} output too small to prove anything`).toBeGreaterThan(100);

      const delivered = (output.match(/^ {2}✗ /gm) ?? []).length;
      expect(`run ${index}: ${delivered}/${announced}`).toBe(`run ${index}: ${announced}/${announced}`);
      // The very last write of all, and the one with the least chance of
      // surviving a torn-down process.
      expect(output.endsWith("\n\n"), `run ${index} lost the blank line closing the block`).toBe(true);
    }
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

  it("routes exactly the seven equality-pinned barrels through it, and no others", () => {
    // The wiring half. Reverting any one of the seven to the inline idiom makes
    // this fail, which is what stops the cleanup from silently coming undone.
    //
    // V2-B5/R11 adds the seventh, `telemetryIndex`. A new equality-pinned
    // barrel that reached for the inline idiom instead would be exactly the
    // drift this probe exists to catch, so the pin moves with the barrel rather
    // than being widened to "at least six".
    const routed = [...FENCE_SOURCE.matchAll(/=\s*barrelExportNames\((\w+)\)/g)].map((m) => m[1]);
    expect(routed.sort()).toEqual(
      [
        "accountsIndex",
        "adaptersIndex",
        "durabilityBarrel",
        "observationIndex",
        "runtimeBarrel",
        "telemetryIndex",
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

// ---------------------------------------------------------------------------
// The policy version pin, as data the fence validates (V2-B5/R14)
// ---------------------------------------------------------------------------

/**
 * Probes for the relocated capability-policy version pin.
 *
 * The pin moved out of a `const` in the fence and into
 * `scripts/policy-version-digests.json`, so a policy re-cut edits data rather
 * than code. Relocation is only safe if the fence reads that data **fail-closed**
 * — a law that skipped a missing or malformed pin would be weaker than the
 * literal it replaced while still printing green, which is the way to get this
 * packet wrong.
 *
 * **Every fixture below declares a version the old literal never pinned.** That
 * is deliberate and it is what makes these probes evidence: a fixture reusing a
 * historical version would be answered by the hardcoded table too, so the probe
 * would pass before the packet as well as after, and prove nothing about where
 * the fence read its row. Declaring `2099-01-01.1` means only a fence that
 * genuinely consults the data file can produce the expected message.
 *
 * Each probe asserts a nonzero exit **and its own law's message**: a synthetic
 * tree trips many unrelated laws, so the exit code alone identifies nothing.
 */
const POLICY_PATH = "packages/domains/accounts/policy/capability-policy.json";
const PIN_PATH = "scripts/policy-version-digests.json";
const PROBE_VERSION = "2099-01-01.1";

/** A policy document, and the digest the fence will compute over its bytes. */
function writePolicyDocument(root, version) {
  const document = JSON.stringify({ policyVersion: version, capabilities: {} }, null, 2) + "\n";
  write(root, POLICY_PATH, document);
  return createHash("sha256").update(document, "utf8").digest("hex");
}

function writePin(root, pin) {
  write(root, PIN_PATH, JSON.stringify(pin, null, 2) + "\n");
}

describe("the policy version pin is data, and the fence validates it (V2-B5/R14)", () => {
  it("N1: refuses a tree whose policy document is shipped with no pin file", async () => {
    const root = syntheticTree();
    writePolicyDocument(root, PROBE_VERSION);
    landingHome(root);
    commitAll(root);

    // Withheld, not malformed. Before this packet the table travelled inside
    // the fence and could not go missing; as data it can, and a law that
    // tolerated its absence would attest nothing at all.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("scripts/policy-version-digests.json is missing");
  });

  it("N2: refuses a pin file that is not valid JSON", async () => {
    const root = syntheticTree();
    writePolicyDocument(root, PROBE_VERSION);
    write(root, PIN_PATH, "{\n");
    landingHome(root);
    commitAll(root);

    // Path-qualified on purpose: the Restate pin law owns a message of the same
    // shape, so an unqualified assertion could be satisfied by the wrong law.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("scripts/policy-version-digests.json is not valid JSON");
  });

  it("N3: refuses a pin that establishes no version", async () => {
    const root = syntheticTree();
    writePolicyDocument(root, PROBE_VERSION);
    writePin(root, { document: POLICY_PATH, versions: {} });
    landingHome(root);
    commitAll(root);

    // A present-but-empty table is the shape that would otherwise pass every
    // structural check while pinning nothing.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the policy version pin establishes no version, so it pins nothing");
  });

  it("N4: refuses a published version the pin does not carry", async () => {
    const root = syntheticTree();
    writePolicyDocument(root, PROBE_VERSION);
    writePin(root, {
      document: POLICY_PATH,
      versions: { "2026-08-30.1": "6fee0b392f19e44ebcd01b29d83d23ee09941e839d1f13c9243a141613d83922" },
    });
    landingHome(root);
    commitAll(root);

    // The old law's own words were "which POLICY_VERSION_DIGESTS does not pin".
    // Asserting the NEW wording is what makes this probe fail before the packet
    // and pass after it, rather than being answered by the literal it replaces.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "which the policy version pin does not pin; add its digest in the same commit",
    );
  });

  it("N5: refuses content that changed under an unchanged version", async () => {
    const root = syntheticTree();
    writePolicyDocument(root, PROBE_VERSION);
    // The row exists and is well-formed; it simply is not this document's
    // digest. Only a fence reading the data file can reach this verdict for a
    // version the old literal never carried.
    writePin(root, {
      document: POLICY_PATH,
      versions: { [PROBE_VERSION]: "a".repeat(64) },
    });
    landingHome(root);
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "changed content under an unchanged policyVersion " + PROBE_VERSION,
    );
  });

  it("N6: refuses a row whose value is not an established digest", async () => {
    const root = syntheticTree();
    writePolicyDocument(root, PROBE_VERSION);
    writePin(root, { document: POLICY_PATH, versions: { [PROBE_VERSION]: "not-a-digest" } });
    landingHome(root);
    commitAll(root);

    // Shape before comparison. A pin whose value is not a digest cannot attest
    // anything, and there is no trust-on-first-use here either.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "the policy version pin's " + PROBE_VERSION + " is not an established 64-lowercase-hex digest",
    );
  });

  it("N7: refuses a pin that names a document it does not attest", async () => {
    const root = syntheticTree();
    const digest = writePolicyDocument(root, PROBE_VERSION);
    writePin(root, {
      document: "packages/domains/accounts/policy/some-other-document.json",
      versions: { [PROBE_VERSION]: digest },
    });
    landingHome(root);
    commitAll(root);

    // Data may not redirect the read. The fence compares the declared document
    // against its own fixed path, so a pin cannot quietly attest something else
    // and report green about it.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the policy version pin names a document it does not attest");
  });

  it("P1: accepts a document its pin attests, and says so", async () => {
    const root = syntheticTree();
    const digest = writePolicyDocument(root, PROBE_VERSION);
    writePin(root, {
      document: POLICY_PATH,
      versions: {
        "2026-08-30.1": "6fee0b392f19e44ebcd01b29d83d23ee09941e839d1f13c9243a141613d83922",
        "2026-09-06.1": "1112b310314acc3a8bf54d19fe94151514e3cfb3cbb5bc3946e0eace1c50976b",
        [PROBE_VERSION]: digest,
      },
    });
    landingHome(root);
    commitAll(root);

    // The neutralization control. Without it the seven negatives above could
    // all be passing on some other law's failure text, and nothing would show
    // that the pin law can reach a verdict of its own.
    //
    // The exit stays nonzero — a synthetic tree trips laws this packet is not
    // about, and a probe demanding exit 0 would be asserting the whole fence
    // rather than this law. What is asserted is that the law's own green note
    // is present and its own refusals are absent.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the capability policy " + PROBE_VERSION + " matches its pinned digest");
    expect(output).not.toContain("scripts/policy-version-digests.json is missing");
    expect(output).not.toContain("the policy version pin names a document it does not attest");
    expect(output).not.toContain("which the policy version pin does not pin");
  });
});

describe("the telemetry export edge is confined by five laws (V2-B5/R11)", () => {
  const TELEMETRY_SRC = "packages/edges/telemetry/src";

  /**
   * A minimal, lawful telemetry edge inside a synthetic tree.
   *
   * Written by every probe below, so each one changes exactly the file it is
   * about and the failure it asserts can only have come from that change. A
   * fixture that tripped the same law from three directions would prove the
   * law fires, not that it fires on what it claims to be about.
   */
  function telemetryEdge(root) {
    write(
      root,
      TELEMETRY_SRC + "/admission/index.ts",
      [
        'const HOSTS = ["127.0.0.1", "::1"];',
        'const TRACES = "/v1/traces";',
        "export function admit(raw) {",
        "  const url = new URL(raw);",
        '  if (url.protocol !== "http:") return null;',
        "  if (!HOSTS.includes(url.hostname)) return null;",
        "  return url.origin + TRACES;",
        "}",
        "",
      ].join("\n"),
    );
    write(
      root,
      TELEMETRY_SRC + "/http/index.ts",
      [
        "export async function post(endpoint, body) {",
        "  const response = await fetch(endpoint.target, {",
        '    method: "POST",',
        "    body,",
        '    redirect: "manual",',
        "    signal: AbortSignal.timeout(endpoint.timeoutMs),",
        "  });",
        '  if (response.status >= 300) return { ok: false, reason: "REDIRECT_REFUSED" };',
        "  return { ok: true };",
        "}",
        "",
      ].join("\n"),
    );
  }

  it("refuses a second file in the edge that calls fetch (L-R11-1)", async () => {
    const root = syntheticTree();
    telemetryEdge(root);
    // A second network authority is the failure this law exists to catch: the
    // confinement is what makes "one endpoint, and it came from the admission"
    // checkable rather than customary.
    write(
      root,
      TELEMETRY_SRC + "/port/index.ts",
      "export const ping = () => fetch(endpoint.target);\n",
    );
    landingHome(root);
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("calls fetch(; only packages/edges/telemetry/src/http/index.ts may");
    expect(output).toContain(TELEMETRY_SRC + "/port/index.ts");
  });

  it("refuses a second file in the edge that decides what loopback means (L-R11-2)", async () => {
    const root = syntheticTree();
    telemetryEdge(root);
    write(
      root,
      TELEMETRY_SRC + "/contract/index.ts",
      'export const FALLBACK = "127.0.0.1";\n',
    );
    landingHome(root);
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("decides what loopback means");
    expect(output).toContain(TELEMETRY_SRC + "/contract/index.ts");
  });

  it("refuses an admission that admits localhost, which is a name and not an address (L-R11-2)", async () => {
    const root = syntheticTree();
    telemetryEdge(root);
    write(
      root,
      TELEMETRY_SRC + "/admission/index.ts",
      [
        'const HOSTS = ["127.0.0.1", "::1", "localhost"];',
        "export function admit(raw) {",
        "  const url = new URL(raw);",
        '  if (url.protocol !== "http:") return null;',
        "  return HOSTS.includes(url.hostname) ? url.origin : null;",
        "}",
        "",
      ].join("\n"),
    );
    landingHome(root);
    commitAll(root);

    // The one a reviewer expects to pass. Resolving a name means DNS, and a
    // name that resolves on-box today is a remote collector tomorrow.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain('admits "localhost"');
  });

  it("refuses an edge source that names the ledger, and one that appends (L-R11-3)", async () => {
    const root = syntheticTree();
    telemetryEdge(root);
    write(
      root,
      TELEMETRY_SRC + "/port/index.ts",
      [
        'import { openLedger } from "@acp/ledger";',
        "export const record = (outcome) => openLedger(path).append(outcome);",
        "",
      ].join("\n"),
    );
    landingHome(root);
    commitAll(root);

    // Both halves, because either alone would let the other back in: an import
    // the manifest law would catch, and an `.append(` on a handle obtained some
    // other way. Recording an export failure in the ledger would make a
    // collector's availability part of the evidence chain.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("names @acp/ledger; the telemetry edge depends on one package");
    expect(output).toContain("calls .append(; an export failure is observed as a value, never as a row");
  });

  it("refuses an edge source that reads the environment (L-R11-3)", async () => {
    const root = syntheticTree();
    telemetryEdge(root);
    write(
      root,
      TELEMETRY_SRC + "/contract/index.ts",
      'export const TARGET = process.env["ACP_OTLP_ENDPOINT"] ?? "";\n',
    );
    landingHome(root);
    commitAll(root);

    // The endpoint is handed to the admission by a composition root. An
    // ambient read here is how a target — and then a credential — arrives
    // without anybody deciding it should.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("reads process.env; the telemetry edge is handed its endpoint");
  });

  it("refuses a fetch site that names a target of its own (L-R11-4)", async () => {
    const root = syntheticTree();
    telemetryEdge(root);
    write(
      root,
      TELEMETRY_SRC + "/http/index.ts",
      [
        "export async function post(body) {",
        '  return fetch("http://127.0.0.1:6006/v1/traces", {',
        '    method: "POST",',
        "    body,",
        '    redirect: "manual",',
        "    signal: AbortSignal.timeout(10000),",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    landingHome(root);
    commitAll(root);

    // A transport that can name a target can name a different one. The
    // exception licenses reaching the network, not choosing where.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("contains the URL literal http://");
  });

  it("refuses a fetch site that stops bounding what it sends (L-R11-4)", async () => {
    const root = syntheticTree();
    telemetryEdge(root);
    write(
      root,
      TELEMETRY_SRC + "/http/index.ts",
      [
        "export async function post(endpoint, body) {",
        '  return fetch(endpoint.target, { method: "POST", body });',
        "}",
        "",
      ].join("\n"),
    );
    landingHome(root);
    commitAll(root);

    // An exception that licensed reaching the network without bounding what is
    // sent would be a wider grant than the one that was made.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain('no longer sets redirect: "manual"');
    expect(output).toContain("no longer bounds a request in time");
  });

  it("refuses a production source anywhere in the tree that names the edge (L-R11-5)", async () => {
    const root = syntheticTree();
    telemetryEdge(root);
    write(
      root,
      "packages/domains/runtime/src/exporting/index.ts",
      'import { createOtlpExporterPort } from "@acp/telemetry";\nexport const port = createOtlpExporterPort;\n',
    );
    landingHome(root);
    commitAll(root);

    // The law restriction 3 actually rests on. "Removing the collector does not
    // affect routing" is checkable exactly when no `src/` in the tree can reach
    // the exporter, and this is the fixture that can falsify it.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("names @acp/telemetry; no production source may reach the exporter");
    expect(output).toContain("packages/domains/runtime/src/exporting/index.ts");
  });

  it("leaves a lawful edge alone, and a TEST that names it (L-R11-1 through L-R11-5)", async () => {
    const root = syntheticTree();
    telemetryEdge(root);
    // The test-only consumer, which is where the causal drill really lives. The
    // law is scoped to `src/`, so this is outside its subject rather than
    // excused from it — and a probe that only ever showed refusals could not
    // tell a law that discriminates from one that refuses everything.
    write(
      root,
      "packages/entrypoints/gateway/test/telemetry/index.test.ts",
      'import { serializeTelemetryBatch } from "@acp/telemetry";\nexport const fold = serializeTelemetryBatch;\n',
    );
    landingHome(root);
    commitAll(root);

    // The exit stays nonzero: a synthetic tree trips laws this packet is not
    // about, and demanding exit 0 would be asserting the whole fence rather
    // than these five. What is asserted is that none of their own refusals
    // fired.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).not.toContain("calls fetch(; only packages/edges/telemetry/src/http/index.ts may");
    expect(output).not.toContain("decides what loopback means");
    expect(output).not.toContain("the telemetry edge depends on one package");
    expect(output).not.toContain("contains the URL literal");
    expect(output).not.toContain("no production source may reach the exporter");
  });
});

/**
 * Probes for the eval lane's three laws (V2-B5/R15).
 *
 * The lane produces immutable versions of the capability registry and it is
 * dependency-free by ruling: the owner refused a hosted evaluation runner after
 * its graph was measured at 798 packages, seven of them declaring install-time
 * hooks. Three laws make that shape checkable rather than asserted.
 *
 * `L-R15-1` pins the root's dependency surface, which nothing pinned before —
 * `P1B_DEPENDENCY_LAW` covers package manifests and the root was asserted only
 * for `private`, `license` and the absence of a second build allow-list. So a
 * vendor could have arrived at the root and the fence would have printed green.
 *
 * `L-R15-3` holds the producer's key tables equal to the loader's in both
 * directions, and refuses a third registry-shaped path: "never a second
 * registry" reaches the form the loader cannot refuse, a sidecar the producer
 * writes beside the document.
 *
 * `L-R15-4` holds the producer's consumption vocabulary equal to
 * `QuotaObservation`'s, so an eval run and a ledger row cannot end up saying the
 * same thing in two different words.
 *
 * Each probe changes exactly the file it is about and asserts **its own law's
 * message**: a synthetic tree trips many unrelated laws, so an exit code
 * identifies nothing on its own. The last probe is the positive control.
 */
const ROOT_MANIFEST = "package.json";
const EVAL_ADAPTER = "scripts/evals/registry-cut.mjs";
const POLICY_LOADER = "packages/domains/accounts/src/policy/index.ts";
const QUOTA_SOURCE = "packages/domains/accounts/src/quota/index.ts";

const AUTHORIZED_DEV_DEPENDENCIES = [
  "@eslint/js",
  "@types/node",
  "eslint",
  "globals",
  "typescript",
  "typescript-eslint",
  "vitest",
];

const LOADER_ENTRY_KEYS = [
  "allowedFallbacks",
  "contextTokens",
  "costPerMillionTokens",
  "eligibleRoles",
  "evaluatedAt",
  "latency",
  "model",
  "provider",
  "quality",
  "quotaConfidence",
  "release",
  "supports",
  "transports",
];
const LOADER_DOCUMENT_KEYS = ["evaluatedAt", "models", "policyVersion", "selection"];

function frozenTable(name, keys, typed) {
  const head = typed
    ? "const " + name + ": readonly string[] = Object.freeze(["
    : "const " + name + " = Object.freeze([";
  return [head, ...keys.map((key) => '  "' + key + '",'), "]);"].join("\n");
}

/** The root manifest, written with whatever dependency surface a probe is about. */
function rootManifest(root, { devDependencies = AUTHORIZED_DEV_DEPENDENCIES, dependencies } = {}) {
  const manifest = {
    name: "@acp/root",
    private: true,
    license: "MIT",
    devDependencies: Object.fromEntries(devDependencies.map((name) => [name, "1.0.0"])),
  };
  if (dependencies !== undefined) manifest.dependencies = dependencies;
  write(root, ROOT_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
}

/** The loader, as far as the two laws read it: its two key tables and one interface. */
function registrySchema(root) {
  write(
    root,
    POLICY_LOADER,
    [
      frozenTable("ENTRY_KEYS", LOADER_ENTRY_KEYS, true),
      frozenTable("DOCUMENT_KEYS", LOADER_DOCUMENT_KEYS, true),
      "",
    ].join("\n"),
  );
  write(
    root,
    QUOTA_SOURCE,
    [
      "export interface QuotaObservation {",
      "  readonly tokensUsed: number;",
      "  readonly observedAt: string;",
      "}",
      "",
    ].join("\n"),
  );
}

/** The producer, with whichever of its three tables a probe is about. */
function evalProducer(
  root,
  {
    entryKeys = LOADER_ENTRY_KEYS,
    documentKeys = LOADER_DOCUMENT_KEYS,
    observationKeys = ["observedAt", "tokensUsed"],
    extraPath = null,
  } = {},
) {
  write(
    root,
    EVAL_ADAPTER,
    [
      'const POLICY_DOCUMENT_PATH = "packages/domains/accounts/policy/capability-policy.json";',
      'const POLICY_PIN_PATH = "scripts/policy-version-digests.json";',
      ...(extraPath === null ? [] : ['const SIDECAR = "' + extraPath + '";']),
      frozenTable("ADAPTER_ENTRY_KEYS", entryKeys, false),
      frozenTable("ADAPTER_DOCUMENT_KEYS", documentKeys, false),
      frozenTable("CONSUMPTION_OBSERVATION_KEYS", observationKeys, false),
      "export { POLICY_DOCUMENT_PATH, POLICY_PIN_PATH };",
      "",
    ].join("\n"),
  );
}

/** A tree carrying a lawful lane, which each probe then breaks in exactly one way. */
function evalLane(root, options = {}) {
  rootManifest(root, options.manifest);
  registrySchema(root);
  evalProducer(root, options.producer);
  landingHome(root);
}

describe("the eval lane is dependency-free and writes one registry (V2-B5/R15)", () => {
  it("R1: refuses a root that drops one of the names it was authorized", async () => {
    const root = syntheticTree();
    evalLane(root, {
      manifest: { devDependencies: AUTHORIZED_DEV_DEPENDENCIES.filter((name) => name !== "vitest") },
    });
    commitAll(root);

    // Exact in both directions. A name that leaves silently is a surface that
    // moved without an integrator edit, exactly like a name that arrives.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the root manifest's devDependencies must be exactly");
  });

  it("R2: refuses a root that gains an eighth name", async () => {
    const root = syntheticTree();
    evalLane(root, {
      manifest: { devDependencies: [...AUTHORIZED_DEV_DEPENDENCIES, "some-eval-runner"] },
    });
    commitAll(root);

    // This is the arm the owner ruling turns on. Before this law a vendor could
    // be added to the root and the fence would have said nothing at all.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the root manifest's devDependencies must be exactly");
    expect(output).toContain("some-eval-runner");
  });

  it("R3: refuses a root that declares a runtime dependency", async () => {
    const root = syntheticTree();
    evalLane(root, { manifest: { dependencies: { "some-eval-runner": "1.0.0" } } });
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the root manifest declares runtime dependencies");
  });

  it("R4: refuses a producer whose table omits a key the loader carries", async () => {
    const root = syntheticTree();
    evalLane(root, {
      producer: { entryKeys: LOADER_ENTRY_KEYS.filter((key) => key !== "quotaConfidence") },
    });
    commitAll(root);

    // Loader → producer. A producer blind to a field emits a document missing
    // it, and the loader refuses the whole registry at load.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the registry producer's entry key table omits: quotaConfidence");
  });

  it("R5: refuses a producer whose table invents a key the loader does not carry", async () => {
    const root = syntheticTree();
    evalLane(root, { producer: { documentKeys: [...LOADER_DOCUMENT_KEYS, "evalRunId"] } });
    commitAll(root);

    // Producer → loader, the other direction and a different failure: a key the
    // loader would refuse by name, written by the one thing that produces the
    // document.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the registry producer's document key table invents: evalRunId");
  });

  it("R6: refuses a producer that names a third registry-shaped path", async () => {
    const root = syntheticTree();
    evalLane(root, {
      producer: { extraPath: "packages/domains/accounts/policy/eval-scores.json" },
    });
    commitAll(root);

    // The form the loader cannot catch. An extra key it refuses by name; a
    // sidecar beside the document it never sees, and restriction 6 is about
    // exactly that file.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "the registry producer names a third registry-shaped path: packages/domains/accounts/policy/eval-scores.json",
    );
  });

  it("R7: refuses a producer that drops a consumption name the ledger records", async () => {
    const root = syntheticTree();
    evalLane(root, { producer: { observationKeys: ["observedAt"] } });
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the registry producer's consumption vocabulary omits: tokensUsed");
  });

  it("R8: refuses a producer that invents a second word for what it consumed", async () => {
    const root = syntheticTree();
    evalLane(root, {
      producer: { observationKeys: ["observedAt", "tokensUsed", "tokens_used"] },
    });
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the registry producer's consumption vocabulary invents: tokens_used");
  });

  it("P1: leaves a lawful lane alone, and says so about all three laws", async () => {
    const root = syntheticTree();
    evalLane(root);
    commitAll(root);

    // The positive control. Without it the eight negatives could every one be
    // passing on some other law's failure text, and nothing would show that
    // these three can reach a verdict of their own. The exit stays nonzero
    // because a synthetic tree trips laws this packet is not about.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the root dependency surface is exactly the 7 dev names authorized");
    expect(output).toContain("the registry producer mirrors the loader's key tables");
    expect(output).toContain("one consumption vocabulary");
    expect(output).not.toContain("the root manifest's devDependencies must be exactly");
    expect(output).not.toContain("the root manifest declares runtime dependencies");
    expect(output).not.toContain("the registry producer's entry key table");
    expect(output).not.toContain("the registry producer's document key table");
    expect(output).not.toContain("the registry producer names a third registry-shaped path");
    expect(output).not.toContain("the registry producer's consumption vocabulary");
  });
});

/**
 * Probes for the CI-subset laws (V2-B5/R18).
 *
 * R18 narrows the workflow's promise from "the same gate a local writer runs"
 * to a subset it can actually run, because two vitest projects require a Restate
 * binary pinned to darwin-arm64 and the runner is `linux-x64`. The subset is
 * declared by naming projects positively, which fails in the wrong direction on
 * its own: a project added later would silently never run in CI.
 *
 * `L-R18-1` buys that direction back. It computes the expected set from
 * `vitest.config.ts`, subtracts the two OWED names, and compares against the
 * workflow in both directions — so the last two probes here are the ones that
 * matter most, and they are the ones a positive list without a law would fail.
 * It also pins the job's steps, since acquisition in CI is the deferred option
 * and would arrive as an eighth step, and pins the split that makes the
 * exclusion nameable.
 *
 * `L-R18-2` holds the amended comment to the four things it must say. The defect
 * being closed is a sentence about CI that nobody checked, so the sentence that
 * replaces it is checked.
 *
 * Same discipline as every probe above: change exactly the file the probe is
 * about, and assert the law's own message rather than an exit code, since a
 * synthetic tree trips laws these probes are not about.
 */
const CI_WORKFLOW = ".github/workflows/ci.yml";
const VITEST_TOPOLOGY = "vitest.config.ts";

const CI_STEP_NAMES = [
  "Checkout",
  "Set up pnpm",
  "Set up Node",
  "Report toolchain",
  "Install dependencies",
  "Arm the mechanical Git fence",
  "Check",
];

/** The runnable projects a lawful synthetic topology defines, in config order. */
const RUNNABLE_PROJECTS = ["fence", "contracts", "runtime", "durability"];
const SERVER_GLOBS = [
  "test/lifecycle-operation/**/*.test.ts",
  "test/drivers/drills/**/*.test.ts",
];

/** One project entry, shaped as the real topology shapes them. */
function projectEntry(name, settings = []) {
  return [
    "      {",
    "        test: {",
    "          name: '" + name + "',",
    ...settings.map((line) => "          " + line),
    "        },",
    "      },",
  ];
}

/**
 * A synthetic `vitest.config.ts`, carrying whichever project set a probe is
 * about. The two OWED names are always present: they are what the law subtracts,
 * and a topology without them would test a different subtraction.
 */
function vitestTopology(root, { runnable = RUNNABLE_PROJECTS, durability = {}, server = {} } = {}) {
  const {
    globs: hermeticGlobs = ["test/drivers/restate-driver/**/*.test.ts"],
    groupOrder: hermeticGroupOrder = null,
  } = durability;
  const { globs: serverGlobs = SERVER_GLOBS, groupOrder: serverGroupOrder = 3 } = server;

  const entries = [];
  for (const name of runnable) {
    if (name === "durability") {
      entries.push(
        ...projectEntry("durability", [
          "include: [" + hermeticGlobs.map((glob) => "'" + glob + "'").join(", ") + "],",
          ...(hermeticGroupOrder === null
            ? []
            : ["sequence: { groupOrder: " + String(hermeticGroupOrder) + " },"]),
        ]),
      );
      continue;
    }
    entries.push(...projectEntry(name));
  }
  entries.push(
    ...projectEntry("durability-server", [
      "include: [" + serverGlobs.map((glob) => "'" + glob + "'").join(", ") + "],",
      ...(serverGroupOrder === null
        ? []
        : ["sequence: { groupOrder: " + String(serverGroupOrder) + " },"]),
    ]),
    ...projectEntry("daemon"),
  );

  write(
    root,
    VITEST_TOPOLOGY,
    ["export default {", "  test: {", "    projects: [", ...entries, "    ],", "  },", "};", ""].join("\n"),
  );
}

/**
 * A synthetic workflow. `declared` is what the gate step names; the header
 * comment carries the four literals L-R18-2 requires unless a probe drops one.
 */
function ciWorkflow(root, { declared = RUNNABLE_PROJECTS, steps = CI_STEP_NAMES, literals = true } = {}) {
  const header = literals
    ? [
        "# CI runs the fence, lint, typecheck and the vitest projects this runner can run.",
        "# durability-server and daemon are OWED: the pinned Restate server is",
        "# darwin-arm64 only, and the debt is discharged by POST_AUDIT_FOLLOW_UP B5.",
      ]
    : ["# CI runs the same gate a local writer runs."];

  const body = [];
  for (const step of steps) {
    body.push("      - name: " + step);
    if (step !== "Check") {
      body.push("        run: true");
      continue;
    }
    body.push("        run: |");
    body.push("          node scripts/check-architecture.mjs");
    body.push(
      "          pnpm exec vitest run --reporter=dot " +
        declared.map((name) => "--project " + name).join(" "),
    );
  }

  write(
    root,
    CI_WORKFLOW,
    [
      "name: ci",
      "",
      ...header,
      "",
      "jobs:",
      "  check:",
      "    runs-on: ubuntu-latest",
      "",
      "    steps:",
      ...body,
      "",
    ].join("\n"),
  );
}

/** A tree whose CI declaration and topology agree, which each probe then breaks once. */
function ciSubset(root, options = {}) {
  vitestTopology(root, options.topology);
  ciWorkflow(root, options.workflow);
  landingHome(root);
}

describe("CI declares the subset it can run, computed from the topology (V2-B5/R18)", () => {
  it("C1: refuses a subset that omits a project the topology defines", async () => {
    const root = syntheticTree();
    ciSubset(root, {
      workflow: { declared: RUNNABLE_PROJECTS.filter((name) => name !== "contracts") },
    });
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the CI subset omits vitest project(s) the topology defines: contracts");
  });

  it("C2: refuses a subset that runs a project the runner cannot run", async () => {
    const root = syntheticTree();
    ciSubset(root, { workflow: { declared: [...RUNNABLE_PROJECTS, "daemon"] } });
    commitAll(root);

    // The other direction of the same comparison. A well-meaning edit that
    // "restores full coverage" would land here and be red on the runner instead.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "the CI subset names project(s) that are OWED, not runnable on the runner: daemon",
    );
  });

  it("C3: refuses a subset naming a project the topology does not define", async () => {
    const root = syntheticTree();
    ciSubset(root, { workflow: { declared: [...RUNNABLE_PROJECTS, "durabilty"] } });
    commitAll(root);

    // A typo selects nothing and reports success, which is the quietest way a
    // positive list can stop running something.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "the CI subset names vitest project(s) vitest.config.ts does not define: durabilty",
    );
  });

  it("C4: refuses a topology whose new project never reached the workflow", async () => {
    const root = syntheticTree();
    // The fail-closed direction the positive list exists to be guarded in, and
    // the reason this law parses the config instead of pinning a literal list:
    // the config moved, the workflow did not, and nobody had to remember.
    ciSubset(root, {
      topology: { runnable: [...RUNNABLE_PROJECTS, "evals"] },
      workflow: { declared: RUNNABLE_PROJECTS },
    });
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the CI subset omits vitest project(s) the topology defines: evals");
    expect(output).toContain("must be added to .github/workflows/ci.yml or declared OWED");
  });

  it("C5: refuses an eighth step, which is how acquisition would arrive", async () => {
    const root = syntheticTree();
    ciSubset(root, {
      workflow: {
        steps: [...CI_STEP_NAMES.slice(0, 6), "Acquire the Restate server", "Check"],
      },
    });
    commitAll(root);

    // Option B is POST_AUDIT_FOLLOW_UP. Pinning the steps is what keeps it from
    // arriving one line at a time.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the CI job's steps must be exactly");
    expect(output).toContain("Acquire the Restate server");
  });

  it("C6: refuses a server tree that drifts back into the project CI runs", async () => {
    const root = syntheticTree();
    ciSubset(root, {
      topology: {
        durability: { globs: ["test/drivers/restate-driver/**/*.test.ts", SERVER_GLOBS[1]] },
      },
    });
    commitAll(root);

    // The split is the whole mechanism. Undone, the subset is a list of names
    // that is still exactly right and still red on the runner.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "the durability project includes test/drivers/drills/**/*.test.ts, which needs the pinned server",
    );
  });

  it("C7: refuses a durability-server that drops one of its two trees", async () => {
    const root = syntheticTree();
    ciSubset(root, { topology: { server: { globs: [SERVER_GLOBS[0]] } } });
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "the durability-server project no longer includes test/drivers/drills/**/*.test.ts",
    );
  });

  it("C8: refuses a server project that stops taking a group of its own", async () => {
    const root = syntheticTree();
    ciSubset(root, { topology: { server: { groupOrder: null } } });
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the durability-server project must keep groupOrder 3");
  });

  it("C9: refuses an amended clause that stops saying what it excludes and why", async () => {
    const root = syntheticTree();
    ciSubset(root, { workflow: { literals: false } });
    commitAll(root);

    // L-R18-2. The old sentence was false because nothing read it; this is the
    // reading.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the CI workflow's amended clause no longer states:");
    expect(output).toContain("durability-server");
    expect(output).toContain("POST_AUDIT_FOLLOW_UP");
  });

  it("P1: leaves an agreeing declaration alone, and says so about both laws", async () => {
    const root = syntheticTree();
    ciSubset(root);
    commitAll(root);

    // The positive control. Without it every negative above could be passing on
    // some other law's output. The exit stays nonzero because a synthetic tree
    // trips laws this packet is not about.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the CI subset is exactly the 4 vitest projects the runner can run");
    expect(output).toContain("with durability-server and daemon OWED");
    expect(output).toContain("the CI workflow states its excluded projects");
    expect(output).not.toContain("the CI subset omits vitest project(s)");
    expect(output).not.toContain("the CI subset names project(s) that are OWED");
    expect(output).not.toContain("the CI subset names vitest project(s)");
    expect(output).not.toContain("the CI job's steps must be exactly");
    expect(output).not.toContain("the durability project includes");
    expect(output).not.toContain("the durability-server project");
    expect(output).not.toContain("the CI workflow's amended clause no longer states:");
  });
});

// ---------------------------------------------------------------------------
// The backend certification record, as a computed gate (old-V2 R19)
// ---------------------------------------------------------------------------

/**
 * Probes for the B-E gate: the five laws that refuse to certify the backend
 * from a record that is incomplete, unclassified, unresolvable or dishonestly
 * owed.
 *
 * **Every probe below is red at HEAD by construction.** Before this packet the
 * record did not exist, so N1 fired on the empty tree and N2-N14 describe
 * shapes the file could not yet have. No assertion here compares a thing to
 * itself, and none of them could have been satisfied by the fence as it stood.
 *
 * **N13 is the one that proves the gate is computed rather than declared.** It
 * takes a pointer that resolves and changes a single character of its anchor.
 * A gate that merely checked the pointer was *present* would stay green; this
 * one goes red, which is the whole difference between a certification and a
 * document that says it certified something once.
 *
 * Each probe asserts a nonzero exit **and its own law's message**. A synthetic
 * tree trips laws this packet is not about, so an exit code identifies nothing
 * on its own — the same reasoning the policy-pin probes above record.
 */
const BE_RECORD = "docs/certification/v2-backend-certification.md";

const BE_IDS = [
  "BE-1-SERVICE-INDEPENDENCE",
  "BE-2-DOOR-EQUIVALENCE",
  "BE-3-KILL-WITHOUT-DUPLICATION",
  "BE-4-RESUMABLE-STREAM",
  "BE-5-NO-PAYLOAD-ON-RECORDED-SURFACES",
  "BE-6-REMOTE-MCP-REFUSED",
  "BE-7-POLICY-ONLY-MODEL-SWITCH",
];

/**
 * The five owed rows the fence authorizes, mirrored here on purpose.
 *
 * A fixture that read `BE_OWED_AUTHORIZED` out of the fence source would agree
 * with whatever the fence happens to say, including a register somebody
 * emptied. Stating them means N10 fails if the register is renamed away from
 * under it, which is what a probe of an authorization register owes.
 */
const BE_AUTHORIZED_OWED = [
  ["OWED-R11-PHOENIX-DRILL", "OWNER_GATED"],
  ["OWED-R15-BENCHMARK-CUT", "OWNER_GATED"],
  ["OWED-R18-CI-LINUX", "POST_AUDIT_FOLLOW_UP"],
  ["OWED-R11B-EXPORTER-WIRING", "RECONCILIATION"],
  ["OWED-GOVERNANCE-RECEIPTS", "CLOSURE_DEBRIEF"],
];

/** The one file every synthetic fixture already writes, and a string it holds. */
const BE_EVIDENCE_PATH = "packages/domains/runtime/src/switch-landing/index.ts";
const BE_EVIDENCE_ANCHOR = "ACCOUNT_SWITCH_COMPLETED";

/** Tokens after which a `/` is division rather than the start of a regex. */
const MIRROR_DIVISION_AFTER = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

/**
 * The fence's own comment blindness (R19b, rewritten to a scanner by P-03),
 * restated rather than imported.
 *
 * Same discipline as `BE_AUTHORIZED_OWED` above: a mirror that read the rule
 * out of the fence source would agree with a rule somebody weakened. The
 * scanner package is shared, because writing a second TypeScript lexer here
 * would be restating the tokenizer rather than the rule; the RULE — which
 * kinds are dropped, when a `/` is re-scanned as a regex, when a `}` is
 * re-read as the continuation of a template, and that a comment becomes one
 * space rather than nothing — is written out by hand below and is the only
 * thing this mirror and the fence have to agree about.
 *
 * The predecessor was line-oriented, and P-03 replaced it because it was wrong
 * in both directions at once: it kept the interior line of a block comment
 * (`N18`), and it cut real code at the `//` inside a regex literal shaped like
 * a URL (`N23b`).
 *
 * **R19d: a mirror that names an incomplete rule reflects an incomplete rule.**
 * R19c added the third clause above to the fence — a `}` that closes a `${…}`
 * is re-read as template, tracked with a stack so nesting stays right — and
 * this docblock went on describing the two-clause rule while the body
 * implemented it. Left alone, `` `hello ${1}` `` followed by a comment let the
 * closing backtick open a template that ran to end of file, so the mirror kept
 * a comment the fence drops: it over-accepted, which `P2`'s `toContain` cannot
 * see, and the sentence above claiming the two agree was false in one
 * direction. `M1`–`M5` are that measurement, red against this commit's parent
 * and green here.
 */
function beCodeOnly(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    text,
  );
  let out = "";
  let previous = ts.SyntaxKind.Unknown;
  /** One entry per brace still open: `true` when a `${…}` is what opened it. */
  const substitutions = [];
  let kind;
  while ((kind = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (
      (kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) &&
      !MIRROR_DIVISION_AFTER.has(previous)
    ) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === ts.SyntaxKind.OpenBraceToken) {
      substitutions.push(false);
    } else if (kind === ts.SyntaxKind.CloseBraceToken) {
      const closesSubstitution = substitutions.pop() === true;
      if (closesSubstitution) kind = scanner.reScanTemplateToken(/* isTaggedTemplate */ false);
    }
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle) {
      substitutions.push(true);
    }
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      out += " ";
      continue;
    }
    out += scanner.getTokenText();
    if (kind !== ts.SyntaxKind.WhitespaceTrivia && kind !== ts.SyntaxKind.NewLineTrivia) {
      previous = kind;
    }
  }
  return out;
}

/** Comfortably over the fence's floor, so a probe about something else is about something else. */
const BE_REASON = "Held elsewhere, and this sentence says where and why it is held.";

const beProven = (id) => ({ id, status: "PROVEN", reason: "—", destination: "—" });

/**
 * A synthetic record, valid unless a probe deliberately breaks one thing.
 *
 * The default is the shape the real record has — seven proven criteria, one
 * resolving pointer each, and the five authorized disclosures — so a probe's
 * fixture differs from a passing document in exactly the way it is named for.
 */
function beRecordDocument(options = {}) {
  const criteria = options.criteria ?? BE_IDS.map(beProven);
  const disclosures =
    options.disclosures ??
    BE_AUTHORIZED_OWED.map(([id, destination]) => ({
      id,
      status: "OWED",
      reason: BE_REASON,
      destination,
    }));
  const pointers =
    options.pointers ??
    criteria
      .filter((row) => row.status === "PROVEN")
      .map((row) => ({ id: row.id, path: BE_EVIDENCE_PATH, anchor: BE_EVIDENCE_ANCHOR }));

  const verdict = (row) =>
    "| `" + row.id + "` | " + (row.status === "" ? "" : "`" + row.status + "`") +
    " | " + row.reason + " | " + row.destination + " |";

  return [
    "# The V2 backend certification record",
    "",
    "The gate is withheld-is-failure. `AgentHarnessPort` is realized at the edge;",
    "a colliding append fails closed on `LEDGER_IDEMPOTENCY_CONFLICT`; the CI",
    "disclosure is destined `POST_AUDIT_FOLLOW_UP`.",
    "",
    "| Criterion | Status | Reason | Destination |",
    "| --- | --- | --- | --- |",
    ...criteria.map(verdict),
    "",
    "| Criterion | Path | Anchor |",
    "| --- | --- | --- |",
    ...pointers.map((p) => "| `" + p.id + "` | `" + p.path + "` | `" + p.anchor + "` |"),
    "",
    "| Row | Status | Reason | Destination |",
    "| --- | --- | --- | --- |",
    ...disclosures.map(verdict),
    "",
  ].join("\n");
}

/** A tree carrying the evidence file, and a record built from the options. */
function beTree(options) {
  const root = syntheticTree();
  landingHome(root);
  if (options !== null) write(root, BE_RECORD, beRecordDocument(options));
  commitAll(root);
  return root;
}

/**
 * Every refusal N1-N14 can produce, for the neutralization control to deny.
 *
 * **Qualified on purpose, and it was measured rather than assumed.** A bare
 * "would pass vacuously" is owned by at least a dozen laws in this fence — the
 * import-purity gate prints one on any synthetic tree — so denying the bare
 * fragment made the control fail on a fixture with nothing wrong with it. Every
 * entry here is therefore long enough that only this law family can produce it,
 * which is the same discipline the policy-pin probes above record for the pin
 * law's message shape.
 */
const BE_REFUSALS = [
  BE_RECORD + " is missing",
  "does not carry the criterion",
  "with no status; a criterion without a verdict is withheld",
  "which is not one of PROVEN, OWED",
  "which the backend gate does not define",
  "is OWED with no reason",
  "is OWED with no destination",
  "a destination and a stated reason are what make an owed row checkable",
  "is OWED but the fence authorizes no owed row for it",
  "retire the authorization in the same commit",
  "PROVEN with no evidence pointer",
  "which does not resolve in the tree",
  "which that file does not state",
  "the B-E criteria table parsed as empty; the backend certification law would pass vacuously",
  "the B-E evidence pointer table parsed as empty; the backend certification law would pass vacuously",
  "V2_BACKEND_CERTIFIED withheld",
  "states " + BE_IDS[3] + " twice",
  "which the record does not carry",
  // The four P-03 adds. Same qualification rule as above: each is long enough
  // that only this law family can produce it, so the control below denies this
  // family's refusals rather than any refusal shaped like them.
  "which states nothing; an empty anchor resolves against every file",
  "whose cited file is empty; an empty file is evidence of nothing",
  "whose cited file holds no code outside its comments",
  "whose extension this record cannot scan",
  // The A1-delta add. Same qualification rule: the tail is long enough that only
  // section 22a can produce it, and one entry covers all four forms because the
  // four refusals differ only in the form they name.
  "a specifier a run computes is a dependency no register can name",
];

/** The cited file, with the landing body every fixture needs and an extra tail. */
function evidenceHome(root, tail) {
  write(
    root,
    BE_EVIDENCE_PATH,
    [
      "export function land(started) {",
      "  const toAccountId = started.payload.toAccountId;",
      '  return { type: "ACCOUNT_SWITCH_COMPLETED", payload: { toAccountId } };',
      "}",
      ...tail,
      "",
    ].join("\n"),
  );
}

/** A record whose BE-1 row cites `anchor` and whose other six are ordinary. */
function recordCiting(anchor, path = BE_EVIDENCE_PATH) {
  return beRecordDocument({
    pointers: BE_IDS.map((id) => ({
      id,
      path: id === "BE-1-SERVICE-INDEPENDENCE" ? path : BE_EVIDENCE_PATH,
      anchor: id === "BE-1-SERVICE-INDEPENDENCE" ? anchor : BE_EVIDENCE_ANCHOR,
    })),
  });
}

describe("the backend certifies what the fence can compute (old-V2 R19)", () => {
  it("N1: refuses a tree with no B-E record at all", async () => {
    const root = beTree(null);

    // Withheld, not malformed. A certification whose record can go missing in
    // silence is weaker than the prose it replaced.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(BE_RECORD + " is missing");
  });

  it("N2: refuses a record that omits one of the seven criteria", async () => {
    const kept = BE_IDS.filter((id) => id !== "BE-4-RESUMABLE-STREAM").map(beProven);
    const root = beTree({
      criteria: kept,
      pointers: kept.map((row) => ({
        id: row.id,
        path: BE_EVIDENCE_PATH,
        anchor: BE_EVIDENCE_ANCHOR,
      })),
    });

    // Absence is the failure. A criterion that is simply not mentioned is the
    // cheapest way to certify seven things by stating six.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "does not carry the criterion BE-4-RESUMABLE-STREAM (the event stream is resumable), which the backend gate requires",
    );
  });

  it("N3: refuses a criterion present with no verdict", async () => {
    const root = beTree({
      criteria: BE_IDS.map((id) =>
        id === "BE-4-RESUMABLE-STREAM"
          ? { id, status: "", reason: "—", destination: "—" }
          : beProven(id),
      ),
    });

    // Present-without-status is the second way to say nothing while appearing
    // to have said something.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "carries BE-4-RESUMABLE-STREAM with no status; a criterion without a verdict is withheld",
    );
  });

  it("N4: refuses a verdict outside the closed vocabulary", async () => {
    const root = beTree({
      criteria: BE_IDS.map((id) =>
        id === "BE-4-RESUMABLE-STREAM"
          ? { id, status: "PARTIAL", reason: "—", destination: "—" }
          : beProven(id),
      ),
    });

    // "PARTIAL" is the word a certification reaches for when it wants credit
    // without a claim. There are two verdicts and no third.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "gives BE-4-RESUMABLE-STREAM the status PARTIAL, which is not one of PROVEN, OWED",
    );
  });

  it("N5: refuses a criterion the gate does not define", async () => {
    const root = beTree({ criteria: [...BE_IDS.map(beProven), beProven("BE-8-INVENTED")] });

    // The other direction of totality: without it, an id typo satisfies the
    // first direction with a row nothing checks.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("names BE-8-INVENTED, which the backend gate does not define");
  });

  it("N6: refuses an owed row with no reason", async () => {
    const root = beTree({
      criteria: BE_IDS.map((id) =>
        id === "BE-4-RESUMABLE-STREAM"
          ? { id, status: "OWED", reason: "—", destination: "OWNER_GATED" }
          : beProven(id),
      ),
    });

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("BE-4-RESUMABLE-STREAM is OWED with no reason");
  });

  it("N7: refuses an owed row with no destination", async () => {
    const root = beTree({
      criteria: BE_IDS.map((id) =>
        id === "BE-4-RESUMABLE-STREAM"
          ? { id, status: "OWED", reason: BE_REASON, destination: "—" }
          : beProven(id),
      ),
    });

    // An owed row with no destination is a debt with no creditor: nobody is
    // obliged to discharge it and nothing notices that nobody did.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("BE-4-RESUMABLE-STREAM is OWED with no destination");
  });

  it("N8: refuses a token where a reason should be", async () => {
    const root = beTree({
      criteria: BE_IDS.map((id) =>
        id === "BE-4-RESUMABLE-STREAM"
          ? { id, status: "OWED", reason: "TBD", destination: "OWNER_GATED" }
          : beProven(id),
      ),
    });

    // A length floor rather than a denylist of tokens, and deliberately so: a
    // denylist teaches a writer which three words to avoid, a floor asks for a
    // sentence.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "BE-4-RESUMABLE-STREAM is OWED with a reason of 3 characters; a destination and a stated reason are what make an owed row checkable",
    );
  });

  it("N9: refuses an owed row the fence never authorized", async () => {
    const root = beTree({
      criteria: BE_IDS.map((id) =>
        id === "BE-4-RESUMABLE-STREAM"
          ? { id, status: "OWED", reason: BE_REASON, destination: "OWNER_GATED" }
          : beProven(id),
      ),
    });

    // Reason and destination are both well formed here, so nothing else fires.
    // The refusal is about authority alone: withholding a criterion is a
    // decision somebody has to have taken by name.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "BE-4-RESUMABLE-STREAM is OWED but the fence authorizes no owed row for it",
    );
  });

  it("N10: refuses an authorization the record has outgrown", async () => {
    const root = beTree({
      disclosures: BE_AUTHORIZED_OWED.map(([id, destination]) =>
        id === "OWED-R18-CI-LINUX"
          ? { id, status: "PROVEN", reason: "—", destination: "—" }
          : { id, status: "OWED", reason: BE_REASON, destination },
      ),
    });

    // The direction that forces the register to shrink. Without it a closed row
    // leaves a live permission behind, and the register's size stops meaning
    // anything at all.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "the fence authorizes an owed row for OWED-R18-CI-LINUX, which the record proves; retire the authorization in the same commit",
    );
  });

  it("N11: refuses a proven criterion with no evidence at all", async () => {
    const root = beTree({
      pointers: BE_IDS.filter((id) => id !== "BE-4-RESUMABLE-STREAM").map((id) => ({
        id,
        path: BE_EVIDENCE_PATH,
        anchor: BE_EVIDENCE_ANCHOR,
      })),
    });

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("marks BE-4-RESUMABLE-STREAM PROVEN with no evidence pointer");
  });

  it("N12: refuses a pointer at a path that is not in the tree", async () => {
    const gone = "packages/domains/runtime/src/switch-landing/gone.ts";
    const root = beTree({
      pointers: BE_IDS.map((id) => ({
        id,
        path: id === "BE-4-RESUMABLE-STREAM" ? gone : BE_EVIDENCE_PATH,
        anchor: BE_EVIDENCE_ANCHOR,
      })),
    });

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "BE-4-RESUMABLE-STREAM points at " + gone + ", which does not resolve in the tree",
    );
  });

  it("N13: refuses a resolving path whose anchor moved by one character", async () => {
    // The probe that proves the gate is COMPUTED. Everything about this fixture
    // is valid — the criterion is stated, classified and pointed at a file that
    // exists — and one character of the cited anchor is wrong. A gate that read
    // presence rather than resolution would be green here, and would stay green
    // through every rename that follows.
    const moved = BE_EVIDENCE_ANCHOR.slice(0, -1) + "Q";
    const root = beTree({
      pointers: BE_IDS.map((id) => ({
        id,
        path: BE_EVIDENCE_PATH,
        anchor: id === "BE-4-RESUMABLE-STREAM" ? moved : BE_EVIDENCE_ANCHOR,
      })),
    });

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      'BE-4-RESUMABLE-STREAM points at ' +
        BE_EVIDENCE_PATH +
        ' for the anchor "' +
        moved +
        '", which that file does not state',
    );
  });

  it("N14: refuses a record whose tables parsed as empty", async () => {
    const root = syntheticTree();
    landingHome(root);
    write(
      root,
      BE_RECORD,
      [
        "# The V2 backend certification record",
        "",
        "The gate is withheld-is-failure, `AgentHarnessPort` is at the edge, a",
        "collision is `LEDGER_IDEMPOTENCY_CONFLICT`, and CI is `POST_AUDIT_FOLLOW_UP`.",
        "",
        "| Criterion | Status | Reason | Destination |",
        "| --- | --- | --- | --- |",
        "",
        "| Criterion | Path | Anchor |",
        "| --- | --- | --- |",
        "",
      ].join("\n"),
    );
    commitAll(root);

    // Headers and separators, no rows. Every totality check below would be
    // satisfied by a table with nothing in it, which is how a gate certifies by
    // reading nothing.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      "the B-E criteria table parsed as empty; the backend certification law would pass vacuously",
    );
  });

  it("P1: reaches its own verdict on a record with nothing wrong with it", async () => {
    const root = beTree({});

    // The neutralization control. Without it every negative above could be
    // passing on some other law's failure text, and nothing would show that
    // this law can reach a verdict of its own.
    //
    // The exit stays nonzero: a synthetic tree trips laws this packet is not
    // about, and a probe demanding exit 0 would be asserting the whole fence
    // rather than these five. What is asserted is that the law's own computed
    // note is present and every one of its refusals is absent. The receipt
    // itself prints only on a fully passing run, which is the real tree's job
    // and `pnpm check`'s, not a synthetic tree's.
    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    for (const refusal of BE_REFUSALS) {
      expect(output).not.toContain(refusal);
    }
  });

  it("P2: the shipped record satisfies the contract the shipped fence reads", () => {
    // The real-tree half, in this file's established idiom: read the real
    // documents rather than spawn the fence at the repository, because the
    // real-tree run is `pnpm check`, outside vitest. What is checked here is
    // the thing a synthetic fixture structurally cannot check — that the record
    // this repository actually ships states all seven criteria, that every
    // pointer it makes resolves against the real tree with its anchor still in
    // place, and that the fence's own register agrees with it row for row.
    const record = readFileSync(join(REAL_REPO, BE_RECORD), "utf8");
    const fence = readFileSync(join(REAL_REPO, "scripts", "check-architecture.mjs"), "utf8");
    const flat = (text) => text.toLowerCase().replace(/\s+/g, " ");

    const cell = (raw) => {
      const trimmed = raw.trim();
      return trimmed.length > 1 && trimmed.startsWith("`") && trimmed.endsWith("`")
        ? trimmed.slice(1, -1).trim()
        : trimmed;
    };
    const verdicts = [...record.matchAll(/^\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|$/gm)].map(
      (m) => ({ id: cell(m[1]), status: cell(m[2]), destination: cell(m[4]) }),
    );
    const pointers = [...record.matchAll(/^\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|$/gm)]
      .map((m) => ({ id: cell(m[1]), path: cell(m[2]), anchor: cell(m[3]) }))
      .filter((row) => /^BE-[A-Z0-9-]+$/.test(row.id));

    // Seven criteria, every one proven, and the count is asserted so a record
    // that lost a row cannot pass by having every row it kept be green.
    const criteria = verdicts.filter((row) => /^BE-[A-Z0-9-]+$/.test(row.id));
    expect(criteria.map((row) => row.id).sort()).toEqual([...BE_IDS].sort());
    for (const row of criteria) expect(row.status).toBe("PROVEN");

    // Every pointer resolves, with its anchor, in the part of the file the
    // fence is willing to read. This is the assertion that goes red when a
    // suite is renamed and nobody updated the record — and, since R19b, when a
    // pointer is anchored to prose. Mirroring the fence's comment blindness is
    // the point: a probe that read the cited files whole would keep passing
    // over exactly the six citations the re-audit falsified.
    //
    // P-03 rewrote the mirror to a scanner, so this is also the assertion that
    // the shipped record still resolves under the NEW rule: all 39 rows, none
    // of them re-anchored. Every cited path is one of the extensions the record
    // is allowed to cite, which is the fence's own guard restated.
    expect(pointers.length).toBeGreaterThan(BE_IDS.length);
    let codeEvidence = 0;
    for (const pointer of pointers) {
      const full = join(REAL_REPO, pointer.path);
      expect(() => statSync(full)).not.toThrow();
      expect(pointer.path).toMatch(/\.(?:ts|mts|js|mjs|md|json)$/);
      const raw = readFileSync(full, "utf8");
      const readable = /\.(?:ts|mts|js|mjs)$/.test(pointer.path) ? beCodeOnly(raw) : raw;
      if (readable !== raw) codeEvidence += 1;
      expect(flat(readable)).toContain(flat(pointer.anchor));
    }

    // Anti-vacuity: the mirror above proves nothing unless some pointer was
    // actually read stripped. A record that cited only `.md` files would
    // satisfy every assertion here while binding to no code at all.
    //
    // What is deliberately NOT asserted here is the differential — that some
    // pointer survives the scanner and would not have survived the line filter
    // P-03 removed. It was measured before this packet was written and it is
    // unsatisfiable on this tree: of the 680 block comments in the 19 cited
    // code files, not one keeps a single character under the old filter,
    // because this repository writes JSDoc uniformly and puts no comment after
    // code on a line. Asserting it here would force a fixture into a cited file
    // to make a green light. The differential proof is N18 below, which is red
    // against the fence this commit replaces and green against the one it
    // lands — a claim a synthetic tree can carry honestly and this one cannot.
    expect(codeEvidence).toBeGreaterThan(0);

    // The register and the record agree, both ways, and the register is really
    // the fence's rather than this file's copy of it.
    const owed = verdicts.filter((row) => /^OWED-[A-Z0-9-]+$/.test(row.id));
    expect(owed.map((row) => row.id).sort()).toEqual(BE_AUTHORIZED_OWED.map(([id]) => id).sort());
    for (const [id, destination] of BE_AUTHORIZED_OWED) {
      const row = owed.find((candidate) => candidate.id === id);
      expect(row?.status).toBe("OWED");
      expect(row?.destination).toBe(destination);
      expect(fence).toContain('{ id: "' + id + '", destination: "' + destination + '" }');
    }
  });
});

/**
 * The mirror reflects the whole rule, templates included (R19d).
 *
 * `beCodeOnly` is a hand-written restatement of the fence's `beCodeTokens`,
 * and its docblock calls the rule "the only thing this mirror and the fence
 * have to agree about". R19c added a clause to the fence — a `}` that closes a
 * `${…}` is re-read as template, so the literal's own closing backtick stops
 * opening a fresh one — and did not add it here. The sentence stopped being
 * true in one direction: the mirror KEPT comments the fence drops.
 *
 * That direction is exactly why nothing went red. `P2` above asserts
 * `toContain`, so a mirror that keeps too much still finds every anchor the
 * shipped record states — the defect is invisible to the assertion the mirror
 * exists to serve, and would have stayed invisible until a record anchored to
 * a comment sitting after a template: this file would have waved it through
 * while `pnpm check` refused it, which is the disagreement a mirror is for.
 *
 * These are unit probes of the helper rather than synthetic-tree runs, and
 * deliberately so. The fence's behaviour on these same shapes is already
 * `N24b`–`N24e`; spawning it again here would measure the fence a second time
 * and call it a measurement of the mirror. What is asserted below is the
 * mirror alone, on the fixtures R19c wrote for the fence.
 *
 * `M1`–`M4` are red against this commit's parent and green here. `M5` is the
 * acceptance side and the shape of the error that stays chosen: template TEXT
 * is code, code after a template is code, and a comment with no template in
 * front of it was already dropped.
 */
describe("the mirror reflects the whole rule, templates included (R19d)", () => {
  /** Stated by no fixture's CODE below, so finding it means a comment survived. */
  const COMMENTED = "the landing refuses a destination it never read";

  it("M1: drops a line comment that follows a template substitution", () => {
    // THE probe. At the parent the closing backtick of `` `hello ${1}` ``
    // opened a template that ran to end of file, and the comment below it came
    // back as string text.
    const source = "export const T = `hello ${1}`;\n// " + COMMENTED + "\n";
    expect(beCodeOnly(source)).not.toContain(COMMENTED);
  });

  it("M2: drops a block comment in the same position", () => {
    // The discriminator against a repair that only handles `//`: the swallowed
    // region is string text either way, so the comment's shape never mattered.
    const source = "export const T = `hello ${1}`;\n/* " + COMMENTED + " */\n";
    expect(beCodeOnly(source)).not.toContain(COMMENTED);
  });

  it("M3: drops a comment after a template with two substitutions", () => {
    // One substitution desynchronizes the scan and the second could have
    // re-paired the stray backticks by accident. It does not, and asserting it
    // stops a repair from passing by counting to one.
    const source = "export const T = `a ${1} b ${2}`;\n// " + COMMENTED + "\n";
    expect(beCodeOnly(source)).not.toContain(COMMENTED);
  });

  it("M4: drops a comment after a nested template, re-paired or not", () => {
    // Nesting is where a brace-counting repair goes wrong, so both shapes are
    // asserted and they are not the same evidence. `` `a ${ `b ${1}` }` `` was
    // already dropped at the parent, because its stray backticks happen to
    // re-pair into a complete literal — a regression pin. Give the OUTER
    // template something to continue with and the luck runs out: that half is
    // this packet's nested evidence.
    const paired = "export const T = `a ${ `b ${1}` }`;\n// " + COMMENTED + "\n";
    expect(beCodeOnly(paired)).not.toContain(COMMENTED);

    const continued = "export const T = `a ${ `b ${1}` } c ${2}`;\n// " + COMMENTED + "\n";
    expect(beCodeOnly(continued)).not.toContain(COMMENTED);
  });

  it("M5: keeps template text, keeps code after a template, and was already right without one", () => {
    // The acceptance half, and the reason the repair is a re-scan rather than a
    // rule about backticks. An anchor may quote what a template interpolates,
    // and `//` inside `` `http://a ${1}` `` is TEXT rather than the start of a
    // comment; both halves are green at the parent too, so `M1`-`M4` cannot
    // have bought their refusals by breaking either one.
    const inText = "export const U = `http://a ${1} " + COMMENTED + "`;\n";
    expect(beCodeOnly(inText)).toContain(COMMENTED);

    const afterTemplate = 'export const T = `hello ${1}`;\nexport const R = "' + COMMENTED + '";\n';
    expect(beCodeOnly(afterTemplate)).toContain(COMMENTED);

    // The control that says the drop above is about the template and not about
    // comments in general: this shape was law before R19c and stays law.
    expect(beCodeOnly("export const N = 1;\n// " + COMMENTED + "\n")).not.toContain(COMMENTED);
  });
});

/**
 * The gate's evidence binds to code, never to comments (old-V2 R19b).
 *
 * R19's own record says "delete a law … and the gate is red on the next run".
 * A re-audit falsified that sentence without touching the record: it deleted
 * the whole body of a cited fence law, left the header comment that names the
 * law standing, and the fence certified with "39 resolving pointers". The
 * anchor check read the cited file whole, so the prose describing a law
 * satisfied a citation to the law.
 *
 * Both probes below are red against the pre-R19b containment, which is the
 * only interesting property a probe of this defect can have: the fixtures are
 * documents the old law called evidence.
 */
describe("the gate's evidence binds to code, never to comments (old-V2 R19b)", () => {
  // `evidenceHome` and `recordCiting` were declared here and were raised to
  // file scope by P-03, which builds its own fixtures out of both. They are
  // unchanged apart from `recordCiting` gaining an optional path, which
  // defaults to the one every caller here already passed implicitly.

  it("N15: refuses an anchor that only a comment of the cited file states", async () => {
    const anchor = "the landing refuses a destination it never read";

    const commented = syntheticTree();
    evidenceHome(commented, ["// " + anchor]);
    write(commented, BE_RECORD, recordCiting(anchor));
    commitAll(commented);

    // The path resolves and the string is in the file. Everything the old law
    // asked for is satisfied, and the file does not do the thing it says.
    const refused = await runFenceAgainst(commented);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain(
      "BE-1-SERVICE-INDEPENDENCE points at " +
        BE_EVIDENCE_PATH +
        ' for the anchor "' +
        anchor +
        '", which that file does not state',
    );

    // The control, and it is what keeps this probe from being a probe that
    // refuses everything: the same anchor, the same record, moved into code.
    const executable = syntheticTree();
    evidenceHome(executable, ['const refusal = "' + anchor + '";', "export const REFUSAL = refusal;"]);
    write(executable, BE_RECORD, recordCiting(anchor));
    commitAll(executable);

    const accepted = await runFenceAgainst(executable);
    expect(accepted.output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    expect(accepted.output).not.toContain("which that file does not state");
  });

  it("N16: refuses a cited law whose body was deleted and whose comment survived", async () => {
    // The re-audit's own sequence, as a fixture. The header comment names the
    // law in the words the record quotes, which is exactly why deleting the
    // body used to be invisible: the sentence outlives the code that earned it.
    const anchor = "the two door tables were compared and disagreed";
    const header = [
      "// --- the two doors answer one vocabulary --------------------------",
      "//",
      "// " + anchor + " is what this law says when it refuses.",
    ];
    const body = ['export const REFUSAL = "' + anchor + '";'];

    const whole = syntheticTree();
    evidenceHome(whole, [...header, ...body]);
    write(whole, BE_RECORD, recordCiting(anchor));
    commitAll(whole);

    // Before: the law is there, and the pointer resolves against the code.
    const before = await runFenceAgainst(whole);
    expect(before.output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    expect(before.output).not.toContain("which that file does not state");

    // After: the body is gone and its comment is not. The record is untouched,
    // which is the whole point — nobody edits the certification when they
    // delete a law, so the gate is the only thing that can notice.
    const gutted = syntheticTree();
    evidenceHome(gutted, header);
    write(gutted, BE_RECORD, recordCiting(anchor));
    commitAll(gutted);

    const after = await runFenceAgainst(gutted);
    expect(after.status).not.toBe(0);
    expect(after.output).toContain(
      "BE-1-SERVICE-INDEPENDENCE points at " +
        BE_EVIDENCE_PATH +
        ' for the anchor "' +
        anchor +
        '", which that file does not state',
    );
    expect(after.output).toContain("V2_BACKEND_CERTIFIED withheld");
  });
});

/**
 * The adoption laws, drilled against synthetic trees rather than this checkout
 * (P-01).
 *
 * These six cases arrived from `packages/entrypoints/daemon/test/launchd/
 * drills/index.test.ts`, where each one edited a **tracked file of the live
 * repository**, ran the fence, and restored the file in a `finally`. Five
 * mutated the tree — one of them `docs/ROADMAP.md` and the fence itself — and
 * the sixth asserted the fence passed over the working tree as it stood. That
 * is a window in which a crash or a concurrent writer loses somebody else's
 * work, and it is why the full suite could not be run at all.
 *
 * Two things changed with the move, and both are the point.
 *
 * **The tree is synthetic.** Everything below writes only into `mkdtemp`
 * directories this file removes in teardown, so a failing probe cannot damage
 * the repository and the suite no longer has to be kept away from it.
 *
 * **The assertion is a diagnostic, not an exit code.** The old drills asserted
 * `status !== 0`, which a minimal synthetic tree produces for dozens of reasons
 * that have nothing to do with the law under test — a fence that exited 1
 * because a template was missing would have satisfied every one of them. Each
 * negative here asserts the **exact** refusal line and the offending path; the
 * positive control asserts the **absence** of those same lines on a tree the
 * fixture makes lawful. Neither direction reads the global exit code, because
 * on a fixture this small the global exit code carries no information.
 *
 * What is deliberately **not** here is the sixth drill's old claim — that the
 * real fence passes over the live checkout. That property is not a test's to
 * assert while the tree is anyone's to edit, and today it is simply false: the
 * repository is mid-packet with a documentation bridge open. It belongs to
 * `pnpm check`, which is where it always ran for real.
 *
 * The two forbidden tokens are assembled from pieces rather than written out,
 * for the reason the daemon drills give: the fence refuses the bare literals in
 * code, and this file is tracked code like any other. A probe exempted from the
 * law it probes is an exemption that quietly becomes the rule.
 */

/** The load command, never written literally in this file. */
const LOAD_COMMAND = ["launch", "ctl"].join("");
/** The user agent directory, never written literally in this file. */
const AGENT_DIR = ["Launch", "Agents"].join("");
/** The one file permitted to name the agent directory, as a denylist entry. */
const DENYLIST_FILE = "packages/entrypoints/daemon/src/launchd/validate/index.ts";

const FENCE_SOURCE = readFileSync(FENCE, "utf8");

/**
 * A constant read out of the fence, rather than restated here.
 *
 * The roadmap fixture has to satisfy the structural statements the fence
 * requires before the forbidden-literal law can be the only thing left to
 * object. Hard-coding those statements would rot silently: when the fence's own
 * literals moved, the benign control would start failing on a statement this
 * probe is not about, while the cutover assertions kept passing — a fixture
 * that had stopped isolating anything and could not say so.
 *
 * There is a second, harder reason. One of the required literals names the
 * product environment, and the fence refuses that token in any tracked file
 * that is not on its authority list. A fixture that spelled the literals out
 * would fail the repository's own gate on this very file. Reading them at run
 * time is the only form that is both durable and lawful.
 */
function fromFence(pattern, what) {
  const found = pattern.exec(FENCE_SOURCE);
  if (found === null || found[1] === undefined) {
    throw new Error("the fence no longer declares " + what + " in the expected shape");
  }
  return found[1];
}

/** Every double-quoted string in a declaration block, in source order. */
function quotedStrings(block) {
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse('"' + match[1] + '"'));
}

const ROADMAP_PIN = fromFence(
  /const ROADMAP_SHA256 =\s*\n?\s*"([0-9a-f]{64})";/,
  "ROADMAP_SHA256",
);
const ROADMAP_STATUS_LINE = JSON.parse(
  fromFence(
    /const ROADMAP_STATUS_LITERAL =\s*\n?\s*("(?:[^"\\]|\\.)*");/,
    "ROADMAP_STATUS_LITERAL",
  ),
);
const ROADMAP_REQUIRED = quotedStrings(
  fromFence(/const ROADMAP_LITERALS = \[([\s\S]*?)\n\];/, "ROADMAP_LITERALS"),
);

/** The claim the roadmap may never make. Owner authority at P9, and nobody else's. */
const CUTOVER_CLAIM = "PRODUCT_CUTOVER_AUTHORIZED";

/** A synthetic roadmap that makes every structural statement the fence requires. */
function roadmapText(extraLines) {
  return [
    "# Synthetic roadmap (fixture)",
    "",
    ROADMAP_STATUS_LINE,
    "",
    ...ROADMAP_REQUIRED.map((literal) => "- " + literal),
    ...(extraLines ?? []),
    "",
  ].join("\n");
}

/**
 * A copy of the fence whose roadmap digest pin the fixture owns.
 *
 * This is what keeps the roadmap probe attributable, and it is the one place a
 * probe here does not run `FENCE` itself. Any edit to a roadmap changes its
 * digest, so the digest gate would refuse the fixture's roadmap on sight and a
 * refusal would prove nothing about the literal law. Moving the pin to match
 * the fixture's own roadmap satisfies the digest gate, leaving the literal law
 * as the only gate that can still object — which the benign control below
 * demonstrates rather than assumes.
 *
 * The copy differs from `FENCE` in exactly one 64-character constant, and the
 * substitution is verified rather than trusted: the pin appears once, and a
 * replace that changed nothing throws instead of silently producing a fence
 * that still pins this repository's roadmap. `roots.mjs` travels beside it
 * because the fence imports it by relative path; it is copied byte-for-byte.
 *
 * The predecessor did all of this to `scripts/check-architecture.mjs` **in the
 * working tree**, under a `finally`. Same technique, same causal claim, no
 * tracked file touched.
 */
function fenceRepinnedTo(digest) {
  const repinned = FENCE_SOURCE.replace(ROADMAP_PIN, digest);
  if (repinned === FENCE_SOURCE) {
    throw new Error("the roadmap pin was not substituted; the fence copy would pin the real tree");
  }
  return fenceCopy(repinned);
}

/**
 * A copy of the fence, in a directory of this file's own, that can actually run.
 *
 * `roots.mjs` travels beside it because the fence imports it by relative path.
 * `node_modules` is symlinked beside it for the same reason and it is P-03 that
 * made it necessary: the fence imports the `typescript` scanner (ADR 0060), and
 * Node resolves a bare specifier by walking up from the importing FILE, not
 * from the tree under inspection. Without the link a copy under `mkdtemp` dies
 * on `ERR_MODULE_NOT_FOUND` before reaching any law, which turns every probe
 * that uses a fence copy into a probe of module resolution.
 *
 * The link is safe to tear down. `rmSync` unlinks a symlinked directory rather
 * than descending into it, so the teardown that removes these roots removes the
 * link and never its target — verified before this helper was written, because
 * the target is this repository's own `node_modules`.
 */
function fenceCopy(source) {
  const dir = mkdtempSync(join(tmpdir(), "acp-fence-copy-"));
  roots.push(dir);
  mkdirSync(join(dir, "architecture"), { recursive: true });
  writeFileSync(join(dir, "check-architecture.mjs"), source, "utf8");
  writeFileSync(
    join(dir, "architecture", "roots.mjs"),
    readFileSync(join(HERE, "roots.mjs"), "utf8"),
    "utf8",
  );
  symlinkSync(join(REAL_REPO, "node_modules"), join(dir, "node_modules"));
  return join(dir, "check-architecture.mjs");
}

/** A tree carrying a complete synthetic roadmap, and the fence that pins it. */
function treeWithRoadmap(extraLines) {
  const root = syntheticTree();
  landingHome(root);
  const text = roadmapText(extraLines);
  write(root, "docs/ROADMAP.md", text);
  commitAll(root);
  return { root, fence: fenceRepinnedTo(createHash("sha256").update(text, "utf8").digest("hex")) };
}

/** The denylist reader as it is lawfully allowed to look: the token, once, as an entry. */
function lawfulDenylist() {
  return [
    "export const HOST_SPECIFIC_LITERALS = [",
    '  "/Users/",',
    '  "' + AGENT_DIR + '",',
    "];",
    "",
  ].join("\n");
}

/** The exact refusals these six cases exist to observe. */
const REFUSALS = {
  loadCommand: " names " + LOAD_COMMAND + " in code; only the lifecycle drill may drive launchd",
  agentDirectory: " names the user agent directory in code; nothing may write there",
  nodeImport: DENYLIST_FILE + " must import nothing from node:; it is a pure reader",
  secondMention: DENYLIST_FILE + " names the user agent directory more than once",
  cutover:
    "docs/ROADMAP.md claims " +
    CUTOVER_CLAIM +
    ", which overstates what has actually been delivered",
};

describe("adoption stays impossible, proved without writing this checkout (P-01)", () => {
  it("refuses the load command appearing in code", async () => {
    // Was: a mutation of `daemon/src/launchd/render/index.ts` in the live tree.
    // The verb is a permitted one, so the persisting-verb law stays out of the
    // way and the bare-token law is the only one this can be refused by.
    const offender = "packages/entrypoints/probe/src/index.ts";
    const root = syntheticTree();
    landingHome(root);
    write(root, offender, 'export const NOTE = "' + LOAD_COMMAND + ' bootstrap";\n');
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).toContain(offender + REFUSALS.loadCommand);
  });

  it("refuses the agent directory appearing in test code", async () => {
    // Was: a mutation of `daemon/test/launchd/render/index.test.ts` in the live
    // tree. Test files used to be skipped wholesale by this scan, which made
    // the rule advisory for exactly the files most likely to reach for the
    // token, so the fixture is deliberately a test file.
    const offender = "packages/entrypoints/probe/test/index.test.ts";
    const root = syntheticTree();
    landingHome(root);
    write(root, offender, 'export const TARGET = "~/Library/' + AGENT_DIR + '";\n');
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).toContain(offender + REFUSALS.agentDirectory);
  });

  it("refuses a node import in the pure denylist reader", async () => {
    // Was: a mutation of `daemon/src/launchd/validate/index.ts` in the live
    // tree. The file keeps its single lawful mention, so the count and the
    // denylist-shape checks both pass and the import law is what refuses.
    const root = syntheticTree();
    landingHome(root);
    write(
      root,
      DENYLIST_FILE,
      'import { readFileSync } from "node:fs";\n' + lawfulDenylist() + "export const read = readFileSync;\n",
    );
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).toContain(REFUSALS.nodeImport);
  });

  it("refuses a second mention of the agent directory in the denylist reader", async () => {
    // Was: a second mutation of the same live file. The exemption is one
    // occurrence, and it is written that narrowly on purpose: a reader allowed
    // to name the directory twice is a reader that could name it as a target.
    const root = syntheticTree();
    landingHome(root);
    write(root, DENYLIST_FILE, 'const EXTRA = "' + AGENT_DIR + '";\n' + lawfulDenylist() + "export const extra = EXTRA;\n");
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).toContain(REFUSALS.secondMention);
  });

  it("refuses a roadmap that claims cutover authority, with the digest gate satisfied", async () => {
    // Was: an edit to `docs/ROADMAP.md` AND to `scripts/check-architecture.mjs`
    // in the live tree, nested two deep and restored in two `finally` blocks.
    // The causal structure is preserved exactly; only the tree is synthetic.
    //
    // The control comes first and is what gives the case its meaning: with the
    // pin moved to the fixture's own roadmap, the digest gate is green and the
    // roadmap section raises nothing at all. So when the claiming variant is
    // refused, the forbidden-literal law is demonstrably the only gate left.
    const benign = treeWithRoadmap([]);
    const control = await runFenceAgainst(benign.root, benign.fence);
    expect(control.output).toContain("docs/ROADMAP.md matches its pinned digest");
    expect(control.output).not.toContain(REFUSALS.cutover);
    expect(control.output).not.toContain("docs/ROADMAP.md no longer states");

    // Appended rather than substituted. Replacing the status line's
    // NO_PRODUCT_CUTOVER also destroys a required structural statement, so the
    // fence refuses on that instead and the law under test is never reached —
    // the predecessor wrote that version first and recorded the trap.
    const claiming = treeWithRoadmap([CUTOVER_CLAIM]);
    const refused = await runFenceAgainst(claiming.root, claiming.fence);
    expect(refused.output).toContain("docs/ROADMAP.md matches its pinned digest");
    expect(refused.output).toContain(REFUSALS.cutover);

    // The substituting shape is refused as well. In the live tree this could
    // only be asserted as a bare non-zero exit, because the edit tripped the
    // structural statements too; here the specific line is still assertable.
    const substituted = roadmapText([]).replace("NO_PRODUCT_CUTOVER", CUTOVER_CLAIM);
    expect(substituted).not.toBe(roadmapText([]));
    const root = syntheticTree();
    landingHome(root);
    write(root, "docs/ROADMAP.md", substituted);
    commitAll(root);
    const fence = fenceRepinnedTo(createHash("sha256").update(substituted, "utf8").digest("hex"));
    const also = await runFenceAgainst(root, fence);
    expect(also.output).toContain(REFUSALS.cutover);
  });

  it("leaves all five alone on a tree the fixture makes lawful", async () => {
    // Was: "passes with no mutation at all", which ran the real fence over this
    // repository and asserted exit 0 — a global claim about a tree the test did
    // not own, made by a file whose other cases were editing it.
    //
    // The honest successor is a positive control for the five laws above, on
    // one tree that satisfies all of them at once: the roadmap is complete and
    // its digest is pinned, the denylist reader names the directory exactly
    // once as an entry and imports nothing, and no file names the load command.
    // Five absences, each the exact line its negative asserts. The global exit
    // code is not read, because a fixture this small owes no other law.
    const { root, fence } = treeWithRoadmap([]);
    write(root, DENYLIST_FILE, lawfulDenylist());
    commitAll(root);

    const { output } = await runFenceAgainst(root, fence);

    expect(output).toContain("docs/ROADMAP.md matches its pinned digest");
    expect(output).not.toContain(REFUSALS.loadCommand);
    expect(output).not.toContain(REFUSALS.agentDirectory);
    expect(output).not.toContain(REFUSALS.nodeImport);
    expect(output).not.toContain(REFUSALS.secondMention);
    expect(output).not.toContain(REFUSALS.cutover);
  });
});

/**
 * A copy of the fence carrying one import its own law does not authorize.
 *
 * The extra specifier is a node builtin on purpose. It has to RESOLVE, or the
 * copy dies on load and the probe measures module resolution instead of the
 * law; and it has to be genuinely absent from the authorized set, or the law
 * has nothing to object to. `node:util` is both. The insertion point is the
 * resolver import, which is the one import shape this file can anchor on
 * without also encoding the scanner import the law is about.
 */
function fenceWithExtraImport(specifier = "node:util") {
  const marker = "import {\n  fenceRoot,";
  const injected = FENCE_SOURCE.replace(
    marker,
    'import { format } from "' + specifier + '";\n\n' + marker,
  );
  if (injected === FENCE_SOURCE) {
    throw new Error("the fence no longer opens its resolver import in the expected shape");
  }
  return fenceCopy(injected);
}

/**
 * No evidence anchor resolves from emptiness or a comment (P-03).
 *
 * R19b bound the anchor to code and left three ways to satisfy a citation with
 * nothing. Measured against the fence this packet replaces, in the section
 * evaluated in isolation:
 *
 *   all 39 anchors blanked           → 0 failures, "39 resolving pointers"
 *   an anchor written as an em dash  → 0 failures, "39 resolving pointers"
 *   an anchor only inside a block    → 0 failures, "39 resolving pointers"
 *
 * The first two are `flatten("")` meeting `String.includes("")`, which is true
 * of every file that has ever existed. The third is the line-oriented removal:
 * it dropped the line that OPENS a comment and the line that continues one in
 * the JSDoc style this repository writes, and kept the interior line of a bare
 * block, which is not a corner case but the shape a writer reaches for when
 * quoting a paragraph.
 *
 * The same measurement found the old rule wrong in the other direction too: it
 * cut real code at the `//` inside `/^https?:\/\//`, so a URL-shaped regex
 * literal made the gate manufacture a refusal against an honest citation. That
 * is `N23b`, and it is a positive rather than a negative for that reason.
 *
 * So the removal became a scanner. `N18`, `N19`, `N19b`, `N21`, `N21b` and
 * `N23b` are red against the fence at this commit's parent and green against
 * the one it lands; `N18b`, `N20`, `N22`, `N23` and `N24` were already law and
 * are pinned here as regressions rather than claimed as this packet's work.
 *
 * **R19c: the scanner had the same hole one layer down.** A scanner that never
 * re-reads the `}` closing a `${…}` leaves the template's own closing backtick
 * to open a fresh one, which runs to the next backtick or to end of file —
 * swallowing the comments below it as string text and resolving an anchor no
 * code states. Measured against the fence R19c repairs, in the section
 * evaluated in isolation:
 *
 *   `` `hello ${1}` `` then a line comment   → the anchor RESOLVED
 *   `` `hello ${1}` `` then a block comment  → the anchor RESOLVED
 *   `` `a ${1} b ${2}` `` then a comment     → the anchor RESOLVED
 *
 * `N24b`, `N24c`, `N24d` and the second half of `N24e` are that measurement,
 * red at the parent and green here. The first half of `N24e` is a pin: the
 * bare nested shape was already refused, because its stray backticks re-pair
 * by luck rather than by rule. `N22b` and the `before` phase of `N24b` are the
 * acceptance side — a template's text and the code after it are still code —
 * and are green at both commits on purpose.
 */
describe("no evidence anchor resolves from emptiness or a comment (P-03)", () => {
  /** The refusal the anchor laws share, for the id every fixture below breaks. */
  const pointsAt = (path = BE_EVIDENCE_PATH) =>
    BE_RECORD + ": BE-1-SERVICE-INDEPENDENCE points at " + path;

  it("N18: refuses an anchor stated only by the interior of a block comment", async () => {
    // THE probe of this packet. The anchor sits on a line that opens nothing
    // and continues nothing, so the line filter kept it and called it code.
    const anchor = "the landing refuses a destination it never read";
    const root = syntheticTree();
    evidenceHome(root, ["/*", anchor, "*/"]);
    write(root, BE_RECORD, recordCiting(anchor));
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(pointsAt() + ' for the anchor "' + anchor + '", which that file does not state');
  });

  it("N18b: refuses the same anchor in the JSDoc shape the old filter did catch", async () => {
    // The discriminator, and it is why N18 is written the way it is: this one
    // was already refused, because every interior line starts with `*`. A
    // packet that only shipped this case would have proved nothing.
    const anchor = "the landing refuses a destination it never read";
    const root = syntheticTree();
    evidenceHome(root, ["/**", " * " + anchor, " */"]);
    write(root, BE_RECORD, recordCiting(anchor));
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(pointsAt() + ' for the anchor "' + anchor + '", which that file does not state');
  });

  it("N19: refuses an empty anchor by name rather than resolving it", async () => {
    // The second probe of the packet, and the one with the widest blast
    // radius: an empty anchor resolved against every file in the tree, so a
    // record could certify seven clauses by citing seven paths and quoting
    // nothing. The refusal names emptiness rather than reporting absence.
    const root = beTree({
      pointers: BE_IDS.map((id) => ({ id, path: BE_EVIDENCE_PATH, anchor: "" })),
    });

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      pointsAt() + ' for the anchor "", which states nothing; an empty anchor resolves against every file',
    );
  });

  it("N19b: refuses an anchor written as an em dash, which the cell reader empties", async () => {
    // The way an empty anchor arrives without anybody writing an empty cell.
    // A markdown table cannot carry a blank legibly, so this record writes `—`
    // and `beCell` reads it as the empty string it is meant to be — which fed
    // the same vacuous comparison from a cell that looks filled in.
    const root = beTree({
      pointers: BE_IDS.map((id) => ({ id, path: BE_EVIDENCE_PATH, anchor: "—" })),
    });

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      pointsAt() + ' for the anchor "", which states nothing; an empty anchor resolves against every file',
    );
  });

  it("N20: pins the two empty-list refusals that were already law", async () => {
    // A declared regression pin, NOT evidence of this packet. The spec lists
    // "the anchor list is not empty" beside the three holes above as though it
    // were a fourth, and it has been law since R19 in two places. Writing it as
    // though it proved something would be a test that cannot go red against the
    // fence it was written against.
    const empty = beTree({ pointers: [] });
    const withoutRows = await runFenceAgainst(empty);
    expect(withoutRows.status).not.toBe(0);
    expect(withoutRows.output).toContain(
      "the B-E evidence pointer table parsed as empty; the backend certification law would pass vacuously",
    );

    const missing = beTree({
      pointers: BE_IDS.filter((id) => id !== "BE-1-SERVICE-INDEPENDENCE").map((id) => ({
        id,
        path: BE_EVIDENCE_PATH,
        anchor: BE_EVIDENCE_ANCHOR,
      })),
    });
    const withoutRow = await runFenceAgainst(missing);
    expect(withoutRow.status).not.toBe(0);
    expect(withoutRow.output).toContain(
      BE_RECORD + " marks BE-1-SERVICE-INDEPENDENCE PROVEN with no evidence pointer",
    );
  });

  it("N21: refuses an empty cited file by naming the emptiness", async () => {
    // Refused before this packet too, but as "which that file does not state",
    // which sends a reader to look for a string in a file that has nothing in
    // it. The hole this closes is diagnostic, and the assertion is therefore
    // about the message rather than about the refusal.
    const root = syntheticTree();
    write(root, BE_EVIDENCE_PATH, "");
    write(root, BE_RECORD, beRecordDocument({}));
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      pointsAt() +
        ' for the anchor "' +
        BE_EVIDENCE_ANCHOR +
        '", whose cited file is empty; an empty file is evidence of nothing',
    );
  });

  it("N21b: refuses a cited file that is nothing but comments", async () => {
    const root = syntheticTree();
    write(root, BE_EVIDENCE_PATH, "// " + BE_EVIDENCE_ANCHOR + "\n/* x */\n");
    write(root, BE_RECORD, beRecordDocument({}));
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      pointsAt() +
        ' for the anchor "' +
        BE_EVIDENCE_ANCHOR +
        '", whose cited file holds no code outside its comments',
    );
  });

  it("N22: accepts comment delimiters that sit inside a string", async () => {
    // A positive, and the shape of the assertion is the file's established one:
    // the exit code carries no information on a fixture this small, so what is
    // asserted is the law's own computed note and the absence of its refusal.
    const anchor = "the two door tables were compared and disagreed";
    const root = syntheticTree();
    evidenceHome(root, ['export const U = "' + anchor + ' // /* not a comment */";']);
    write(root, BE_RECORD, recordCiting(anchor));
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    expect(output).not.toContain("which that file does not state");
  });

  it("N23: accepts comment delimiters that sit inside a URL", async () => {
    const anchor = "the two door tables were compared and disagreed";
    const root = syntheticTree();
    evidenceHome(root, ['export const U = "https://example.invalid/' + anchor + '";']);
    write(root, BE_RECORD, recordCiting(anchor));
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    expect(output).not.toContain("which that file does not state");
  });

  it("N23b: accepts an anchor after a regex literal shaped like a URL", async () => {
    // The case that separates a scanner from a scanner that re-scans. Reading
    // `/^https?:\/\//` left to right, a lexer with no context sees `//` and
    // takes the rest of the line as a comment — which deletes the anchor and
    // makes the gate refuse an honest citation. Measured on the fence itself:
    // 955 scanner errors and 664 characters of real code lost without the
    // re-scan, none with it. Red against the fence this packet replaces, for
    // the same reason in its line-oriented form.
    const anchor = "the two door tables were compared and disagreed";
    const root = syntheticTree();
    evidenceHome(root, ['export const R = /^https?:\\/\\//.source + "' + anchor + '";']);
    write(root, BE_RECORD, recordCiting(anchor));
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    expect(output).not.toContain("which that file does not state");
  });

  it("N22b: accepts comment delimiters inside the text of a template that interpolates", async () => {
    // The acceptance half of R19c, and the reason the repair is a re-scan rather
    // than a rule about backticks. `//` inside `` `http://a ${1}` `` is template
    // TEXT, not the start of a comment, and it has to stay that way while the
    // substitution's closing brace starts being read as a template again. Green
    // against the fence at this commit's parent too, which is the point: the
    // repair below must not buy its negatives by breaking this.
    const anchor = "the two door tables were compared and disagreed";
    const root = syntheticTree();
    evidenceHome(root, ["export const U = `http://a ${1}` + \"" + anchor + '";']);
    write(root, BE_RECORD, recordCiting(anchor));
    commitAll(root);

    const { output } = await runFenceAgainst(root);
    expect(output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    expect(output).not.toContain("which that file does not state");
  });

  it("N24: refuses a mutation of the anchored code with the record left intact", async () => {
    // The spec's "a mutation of the anchored code must make the law fail", as
    // a before/after pair. Nobody edits a certification when they rename a
    // constant, which is exactly why the gate has to be the thing that notices.
    const anchor = "the landing refuses a destination it never read";
    const body = ['export const REFUSAL = "' + anchor + '";'];

    const whole = syntheticTree();
    evidenceHome(whole, body);
    write(whole, BE_RECORD, recordCiting(anchor));
    commitAll(whole);

    const before = await runFenceAgainst(whole);
    expect(before.output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    expect(before.output).not.toContain("which that file does not state");

    const mutated = syntheticTree();
    evidenceHome(mutated, ['export const REFUSAL = "the door tables agreed";']);
    write(mutated, BE_RECORD, recordCiting(anchor));
    commitAll(mutated);

    const after = await runFenceAgainst(mutated);
    expect(after.status).not.toBe(0);
    expect(after.output).toContain(
      pointsAt() + ' for the anchor "' + anchor + '", which that file does not state',
    );
    expect(after.output).toContain("V2_BACKEND_CERTIFIED withheld");
  });

  it("N24b: refuses an anchor left in a line comment after a template substitution", async () => {
    // THE probe of R19c, as a before/after pair on one shape. `beCodeTokens`
    // scanned the `}` of a `${…}` as an ordinary close brace, so the closing
    // backtick opened a template that ran to end of file and took every comment
    // below it as string text — R19b's defect, reopened through the lexer.
    //
    // The `before` phase is the positive the correction owes: an anchor stated
    // in real code AFTER a template that interpolates still resolves. It is
    // green at this commit's parent as well, so the pair attributes the change
    // to the comment and to nothing else.
    const anchor = "the landing refuses a destination it never read";
    const template = "export const T = `hello ${1}`;";

    const stated = syntheticTree();
    evidenceHome(stated, [template, 'export const REFUSAL = "' + anchor + '";']);
    write(stated, BE_RECORD, recordCiting(anchor));
    commitAll(stated);

    const before = await runFenceAgainst(stated);
    expect(before.output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    expect(before.output).not.toContain("which that file does not state");

    const commented = syntheticTree();
    evidenceHome(commented, [template, "// " + anchor]);
    write(commented, BE_RECORD, recordCiting(anchor));
    commitAll(commented);

    const after = await runFenceAgainst(commented);
    expect(after.status).not.toBe(0);
    expect(after.output).toContain(
      pointsAt() + ' for the anchor "' + anchor + '", which that file does not state',
    );
    expect(after.output).toContain("V2_BACKEND_CERTIFIED withheld");
  });

  it("N24c: refuses the same anchor in a block comment after a template substitution", async () => {
    // The discriminator against a repair that only handles `//`. The swallowed
    // region is string text either way, so the comment's shape never mattered —
    // and a fix that special-cased line comments would leave this one red.
    const anchor = "the landing refuses a destination it never read";
    const root = syntheticTree();
    evidenceHome(root, ["export const T = `hello ${1}`;", "/* " + anchor + " */"]);
    write(root, BE_RECORD, recordCiting(anchor));
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      pointsAt() + ' for the anchor "' + anchor + '", which that file does not state',
    );
    expect(output).toContain("V2_BACKEND_CERTIFIED withheld");
  });

  it("N24d: refuses an anchor commented after a template with two substitutions", async () => {
    // One substitution desynchronizes the scan; the second re-pairs the stray
    // backticks and could have hidden the defect by accident. It does not — the
    // template opened at the first `}` simply ends at the second, and a third
    // opens on the tail. Asserted so a repair cannot pass by counting to one.
    const anchor = "the landing refuses a destination it never read";
    const root = syntheticTree();
    evidenceHome(root, ["export const T = `a ${1} b ${2}`;", "// " + anchor]);
    write(root, BE_RECORD, recordCiting(anchor));
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      pointsAt() + ' for the anchor "' + anchor + '", which that file does not state',
    );
    expect(output).toContain("V2_BACKEND_CERTIFIED withheld");
  });

  it("N24e: refuses an anchor commented after a nested template, re-paired or not", async () => {
    // Nesting is where a brace-counting repair goes wrong, so both shapes are
    // asserted — and they are NOT the same evidence, which is worth stating
    // rather than hiding behind a shared assertion.
    //
    // Measured against the fence at this commit's parent: `` `a ${ `b ${1}` }` ``
    // was ALREADY refused, because its stray backticks happen to re-pair into a
    // complete literal and leave the comment below visible. That half is a
    // regression pin, in the sense N18b and N20 already use in this file, not
    // this packet's work. Give the OUTER template something to continue with —
    // `` `a ${ `b ${1}` } c ${2}` `` — and the luck runs out: that half resolved
    // a comment-only anchor at the parent and is this packet's nested evidence.
    const anchor = "the landing refuses a destination it never read";
    const refusal = pointsAt() + ' for the anchor "' + anchor + '", which that file does not state';

    const paired = syntheticTree();
    evidenceHome(paired, ["export const T = `a ${ `b ${1}` }`;", "// " + anchor]);
    write(paired, BE_RECORD, recordCiting(anchor));
    commitAll(paired);

    const pinned = await runFenceAgainst(paired);
    expect(pinned.status).not.toBe(0);
    expect(pinned.output).toContain(refusal);
    expect(pinned.output).toContain("V2_BACKEND_CERTIFIED withheld");

    const continued = syntheticTree();
    evidenceHome(continued, ["export const T = `a ${ `b ${1}` } c ${2}`;", "// " + anchor]);
    write(continued, BE_RECORD, recordCiting(anchor));
    commitAll(continued);

    const unlucky = await runFenceAgainst(continued);
    expect(unlucky.status).not.toBe(0);
    expect(unlucky.output).toContain(refusal);
    expect(unlucky.output).toContain("V2_BACKEND_CERTIFIED withheld");
  });

  it("N25: refuses a row citing a file whose extension the record cannot scan", async () => {
    // The declared limit, made fail-closed. `.tsx` is excluded because the
    // scanner cannot tokenize JSX without a parser's context — 343 errors over
    // this repository's 56 `.tsx` files even with the JSX language variant —
    // and an excluded extension that fell through to "read the file whole"
    // would reopen R19b's defect through the extension door.
    const tsx = "packages/entrypoints/ui/src/probe.tsx";
    const root = syntheticTree();
    landingHome(root);
    write(root, tsx, "export const Probe = () => null;\n");
    write(root, BE_RECORD, recordCiting(BE_EVIDENCE_ANCHOR, tsx));
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain(
      pointsAt(tsx) +
        ", whose extension this record cannot scan; admitted: .ts, .mts, .js, .mjs (code), " +
        ".md, .json (prose evidence)",
    );
  });

  it("N26: refuses a fence that imports something its own law does not authorize", async () => {
    // The law A1 asks for, and the reason it exists: this packet made the
    // fence's prose about itself false in one word, and the repair is not a
    // corrected sentence but a law that keeps the sentence true. A dependency
    // is now a thing the fence declares and checks, not a thing it claims.
    //
    // The control comes first, on the same tree, so the refusal below is
    // attributable to the extra import rather than to the copy.
    const root = beTree({});
    const control = await runFenceAgainst(root, fenceCopy(FENCE_SOURCE));
    expect(control.output).toContain("the fence imports exactly what it authorizes");
    expect(control.output).not.toContain("which its authorized import set does not name");

    const mutant = await runFenceAgainst(root, fenceWithExtraImport());
    expect(mutant.status).not.toBe(0);
    expect(mutant.output).toContain(
      "scripts/check-architecture.mjs imports node:util, which its authorized import set does not name",
    );
  });

  it("P4: reaches its own verdict on a record and a tree with nothing wrong with them", async () => {
    // The neutralization control, inherited from P1 and extended to this
    // packet's four refusals, which were added to `BE_REFUSALS` in the same
    // commit. Without it every negative above could be passing on some other
    // law's failure text, and the new laws could be firing on a lawful fixture
    // without anything here noticing.
    const root = beTree({});

    const { output } = await runFenceAgainst(root);
    expect(output).toContain("the B-E record states 7 criteria over 7 evidence pointers");
    expect(output).toContain("the fence imports exactly what it authorizes");
    for (const refusal of BE_REFUSALS) {
      expect(output).not.toContain(refusal);
    }
  });
});

/**
 * A copy of the fence that reaches for a dependency the way a register cannot
 * see it, inside a function nothing calls.
 *
 * Inert on purpose, and it is not a stylistic choice. `require` is not defined
 * in an ES module, so a top-level call would kill the copy with a ReferenceError
 * roughly 1.07 MB before section 22a runs; and a top-level `await import(v)`
 * would actually resolve. Either way the probe would be measuring module
 * loading instead of the law. A function declaration nobody invokes is parsed
 * and never evaluated, which is exactly the asymmetry this law exists to close:
 * the dependency is real to a reader and invisible to a run.
 *
 * The insertion point is the resolver import, the same anchor `fenceWithExtraImport`
 * uses, because a function declaration is legal between ESM imports. If a later
 * packet ever adds a law refusing functions with no consumer, these negatives
 * would go red for a reason that has nothing to do with section 22a.
 */
function fenceReachingFor(lines) {
  const marker = "import {\n  fenceRoot,";
  const injected = FENCE_SOURCE.replace(
    marker,
    ["function acpUnreachableDependency() {", ...lines, "}", "", marker].join("\n"),
  );
  if (injected === FENCE_SOURCE) {
    throw new Error("the fence no longer opens its resolver import in the expected shape");
  }
  return fenceCopy(injected);
}

/**
 * The fence's dependencies are declarations, not computations (A1-delta).
 *
 * Consultation A1 found section 22a comparing its register against
 * `preProcessFile`, which is a reference pre-processor rather than a reader of
 * declarations. Measured against the fence this packet corrects, in the section
 * evaluated in isolation:
 *
 *   import(next), a variable            → extractor saw NOTHING  → green
 *   import("node:fs" + "/promises")     → extractor saw "node:fs" → green, authorized
 *   require("node:fs")                  → extractor saw "node:fs" → green, authorized
 *
 * Three ways of acquiring a dependency in silence, through the very law written
 * to make silence impossible. The first is invisible to the old instrument; the
 * other two are worse, because the old instrument reports them as declarations
 * and the register then agrees with them.
 *
 * So the negatives below are the three shapes plus the template literal, which
 * is the form a writer reaches for without thinking. Each asserts the stable
 * prefix of the refusal rather than its line number, and each also asserts that
 * the law did not lose its other half — without that, a writer who broke the
 * second direction would leave every case here green.
 */
describe("the fence's dependencies are declarations, not computations (A1-delta)", () => {
  /** The refusal's stable head, per form; the trailing ` at line N` is not asserted. */
  const reachesThrough = (form) =>
    "scripts/check-architecture.mjs reaches for a dependency through " + form;

  it("N27: refuses an import whose specifier is a variable", async () => {
    // Invisible to the old extractor, so the old law returned no extra specifier
    // and passed. Nothing about the fence's register had to change for a
    // dependency to arrive.
    const root = beTree({});
    const { status, output } = await runFenceAgainst(
      root,
      fenceReachingFor(['  const next = "node:util";', "  return import(next);"]),
    );

    expect(status).not.toBe(0);
    expect(output).toContain(reachesThrough("import()"));
    expect(output).not.toContain("the fence imports exactly what it authorizes");
    expect(output).not.toContain("authorizes an import of");
  });

  it("N28: refuses an import whose specifier is a concatenation", async () => {
    // The sharpest of the four: the old extractor read the literal prefix
    // `node:fs`, which the register AUTHORIZES, so the law affirmatively agreed
    // that a dependency on `node:fs/promises` was one it had named.
    const root = beTree({});
    const { status, output } = await runFenceAgainst(
      root,
      fenceReachingFor(['  return import("node:fs" + "/promises");']),
    );

    expect(status).not.toBe(0);
    expect(output).toContain(reachesThrough("import()"));
    expect(output).not.toContain("the fence imports exactly what it authorizes");
    expect(output).not.toContain("authorizes an import of");
  });

  it("N28b: refuses an import whose specifier is a template literal", async () => {
    // Same blindness as N27, in the shape a writer produces by habit.
    const root = beTree({});
    const { status, output } = await runFenceAgainst(
      root,
      fenceReachingFor(['  const p = "util";', "  return import(`node:${p}`);"]),
    );

    expect(status).not.toBe(0);
    expect(output).toContain(reachesThrough("import()"));
    expect(output).not.toContain("the fence imports exactly what it authorizes");
    expect(output).not.toContain("authorizes an import of");
  });

  it("N29: refuses a require, even for a specifier the register authorizes", async () => {
    // The specifier has to be an AUTHORIZED one or this case proves nothing: the
    // old extractor reported `require("x")` as a declaration, so an
    // unauthorized `x` would have gone red today through the ordinary first
    // direction and the negative would not discriminate between the two laws.
    // `node:fs` is authorized, so the old law was green here.
    const root = beTree({});
    const { status, output } = await runFenceAgainst(
      root,
      fenceReachingFor(['  return require("node:fs");']),
    );

    expect(status).not.toBe(0);
    expect(output).toContain(reachesThrough("require()"));
    expect(output).not.toContain("the fence imports exactly what it authorizes");
    expect(output).not.toContain("authorizes an import of");
  });

  it("N30: reaches its own verdict on a fence copy that computes no specifier", async () => {
    // The positive control, on the same tree and through the same copy helper as
    // the four above, so their refusals are attributable to the injected
    // function rather than to being a copy. The note is the one N26 and P4 also
    // hold this law to.
    const root = beTree({});
    const { output } = await runFenceAgainst(root, fenceCopy(FENCE_SOURCE));

    expect(output).toContain("the fence imports exactly what it authorizes");
    expect(output).not.toContain("reaches for a dependency through");
  });
});
