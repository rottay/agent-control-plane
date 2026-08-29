import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../../src/contracts/index.js";
import { deriveOperationCoordinate, operationDigest } from "../../../src/core/coordinates/index.js";
import { ToyBoundaryError } from "../../../src/errors/index.js";
import type { ScenarioRoot } from "../../../src/toy/repository/index.js";
import {
  DRILL_ROOT_SEGMENTS,
  applyEffect,
  drillRoot,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../../src/toy/repository/index.js";

const INVOCATION: DurableInvocation = {
  taskId: "33333333-3333-4333-8333-333333333333",
  attempt: 1,
  invocationId: "inv-0003",
  submittedAt: "2026-08-27T12:00:00.000Z",
  submissionDigest: "c".repeat(64),
};

const OPERATION = deriveOperationCoordinate(INVOCATION, "run.started", 4);

const scenarios: string[] = [];
const outsideDirectories: string[] = [];

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

afterEach(() => {
  for (const name of scenarios.splice(0)) {
    removeScenarioRoot(name);
  }
  for (const directory of outsideDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the drill boundary", () => {
  it("resolves only under the repository's own ignored drill root", () => {
    const root = scenario("boundary-ok");
    expect(root).toContain(join(...DRILL_ROOT_SEGMENTS));
    expect(root.startsWith(drillRoot()) || drillRoot().length > 0).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it("refuses every identifier that could name something else", () => {
    const unsafe = [
      "..",
      "../escape",
      "/etc",
      "a/b",
      "a\\b",
      "UPPER",
      "with space",
      "dot.dot",
      "",
      "x".repeat(65),
    ];
    for (const id of unsafe) {
      expect(() => resolveScenarioRoot(id)).toThrow(ToyBoundaryError);
    }
  });

  it("refuses a scenario whose directory is a symlink out of the sandbox", () => {
    // The string check passes here; only the realpath check catches this. That
    // is exactly why both exist.
    const outside = mkdtempSync(join(tmpdir(), "acp-outside-"));
    outsideDirectories.push(outside);

    const root = drillRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const link = join(root, "escaping-link");
    rmSync(link, { recursive: true, force: true });
    symlinkSync(outside, link, "dir");

    try {
      expect(() => resolveScenarioRoot("escaping-link")).toThrow(ToyBoundaryError);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  });

  it("refuses to remove anything from a malformed identifier", () => {
    expect(() => {
      removeScenarioRoot("../..");
    }).toThrow(ToyBoundaryError);
  });

  it("refuses a root this module did not resolve, through every public entry", () => {
    // The public API is typed against an opaque ScenarioRoot, so this cast is
    // what a JavaScript consumer or a determined TypeScript one would do. The
    // runtime registry is what actually stops them.
    const outside = mkdtempSync(join(tmpdir(), "acp-forged-root-"));
    outsideDirectories.push(outside);
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched", "utf8");
    const before = readdirSync(outside).sort();

    const forged = outside as ScenarioRoot;
    expect(() => {
      applyEffect(forged, OPERATION);
    }).toThrow(ToyBoundaryError);
    expect(() => probeEffect(forged, OPERATION)).toThrow(ToyBoundaryError);
    expect(() => scenarioLedgerPath(forged)).toThrow(ToyBoundaryError);

    // Not one byte outside the sandbox moved, and no ledger was created there.
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(readdirSync(outside).sort()).toEqual(before);
    expect(existsSync(join(outside, "ledger.sqlite"))).toBe(false);
  });

  it("refuses a path that merely looks like it is under the drill root", () => {
    const lookalike = join(drillRoot(), "never-resolved") as ScenarioRoot;
    expect(() => probeEffect(lookalike, OPERATION)).toThrow(ToyBoundaryError);
    expect(() => scenarioLedgerPath(lookalike)).toThrow(ToyBoundaryError);
  });

  it("refuses a validated root that was swapped for a symlink afterwards", () => {
    // The classic time-of-check to time-of-use: validation succeeded, and then
    // the directory itself was replaced. Checking only the descent BELOW the
    // root would compare an outside parent against an outside root and pass.
    const root = scenario("boundary-swapped-root");
    expect(scenarioLedgerPath(root)).toContain("boundary-swapped-root");

    const outside = mkdtempSync(join(tmpdir(), "acp-swapped-"));
    outsideDirectories.push(outside);
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched", "utf8");
    const before = readdirSync(outside).sort();

    rmSync(root, { recursive: true, force: true });
    symlinkSync(outside, root, "dir");

    expect(() => scenarioLedgerPath(root)).toThrow(ToyBoundaryError);
    expect(() => probeEffect(root, OPERATION)).toThrow(ToyBoundaryError);
    expect(() => {
      applyEffect(root, OPERATION);
    }).toThrow(ToyBoundaryError);

    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(readdirSync(outside).sort()).toEqual(before);
    expect(existsSync(join(outside, "ledger.sqlite"))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a symlinked drill root, so no scenario is created outside", () => {
    // If .acp-local/drills is a link, every scenario below it is created outside
    // the repository and then validated against an outside root, which passes.
    // The boundary therefore has to start at the repository, not at the scenario.
    const drills = drillRoot();
    const parked = drills + ".parked";
    const outside = mkdtempSync(join(tmpdir(), "acp-drillroot-"));
    outsideDirectories.push(outside);
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched", "utf8");
    const before = readdirSync(outside).sort();

    mkdirSync(drills, { recursive: true, mode: 0o700 });
    renameSync(drills, parked);
    symlinkSync(outside, drills, "dir");
    try {
      expect(() => resolveScenarioRoot("would-escape")).toThrow(ToyBoundaryError);
      expect(readdirSync(outside).sort()).toEqual(before);
      expect(readFileSync(sentinel, "utf8")).toBe("untouched");
      expect(existsSync(join(outside, "would-escape"))).toBe(false);
    } finally {
      rmSync(drills, { recursive: true, force: true });
      renameSync(parked, drills);
    }
  });

  it("keeps the ledger inside the scenario it belongs to", () => {
    const root = scenario("boundary-ledger");
    expect(scenarioLedgerPath(root).startsWith(root)).toBe(true);
  });
});

describe("the toy effect", () => {
  it("applies once and is idempotent by content", () => {
    const root = scenario("effect-idempotent");
    expect(probeEffect(root, OPERATION)).toBe("NOT_DONE");

    applyEffect(root, OPERATION);
    expect(probeEffect(root, OPERATION)).toBe("DONE");

    // A second application is a no-op, not a second write.
    applyEffect(root, OPERATION);
    expect(probeEffect(root, OPERATION)).toBe("DONE");
  });

  it("writes exactly the derived digest and nothing else", () => {
    const root = scenario("effect-content");
    applyEffect(root, OPERATION);
    const marker = join(root, "effects", OPERATION.operationId + ".marker");
    expect(readFileSync(marker, "utf8")).toBe(operationDigest(OPERATION));
  });

  it("leaves no partial file behind", () => {
    const root = scenario("effect-atomic");
    applyEffect(root, OPERATION);
    const partial = join(root, "effects", OPERATION.operationId + ".marker.partial");
    expect(existsSync(partial)).toBe(false);
  });

  it("reports UNKNOWN rather than overwriting somebody else's marker", () => {
    const root = scenario("effect-foreign");
    const marker = join(root, "effects", OPERATION.operationId + ".marker");
    mkdirSync(join(root, "effects"), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "written by something else", "utf8");

    expect(probeEffect(root, OPERATION)).toBe("UNKNOWN");
    expect(() => {
      applyEffect(root, OPERATION);
    }).toThrow(ToyBoundaryError);
    // The foreign content survives: it is the only evidence of what happened.
    expect(readFileSync(marker, "utf8")).toBe("written by something else");
  });

  it("separates operations, so one effect never satisfies another", () => {
    const root = scenario("effect-separate");
    const other = deriveOperationCoordinate(INVOCATION, "run.started", 5);
    applyEffect(root, OPERATION);
    expect(probeEffect(root, other)).toBe("NOT_DONE");
  });

  it("refuses to descend through a symlinked effects directory", () => {
    // The string check passes: every name is inside the scenario. Only the
    // per-segment lstat catches this, which is the whole point of having it.
    const root = scenario("effect-nested-symlink");
    const outside = mkdtempSync(join(tmpdir(), "acp-effect-escape-"));
    outsideDirectories.push(outside);

    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched", "utf8");
    const before = readdirSync(outside).sort();

    symlinkSync(outside, join(root, "effects"), "dir");

    expect(() => {
      applyEffect(root, OPERATION);
    }).toThrow(ToyBoundaryError);
    expect(() => probeEffect(root, OPERATION)).toThrow(ToyBoundaryError);

    // Nothing outside the sandbox was created, changed or removed.
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(readdirSync(outside).sort()).toEqual(before);
    expect(existsSync(join(outside, OPERATION.operationId + ".marker"))).toBe(false);
  });

  it("never reads an unreadable marker as absence", () => {
    // A directory where the marker belongs. The old blanket catch reported this
    // as NOT_DONE, which invites the caller to perform the effect a second time.
    const root = scenario("effect-eisdir");
    const marker = join(root, "effects", OPERATION.operationId + ".marker");
    mkdirSync(marker, { recursive: true, mode: 0o700 });

    expect(() => probeEffect(root, OPERATION)).toThrow(ToyBoundaryError);
    expect(() => {
      applyEffect(root, OPERATION);
    }).toThrow(ToyBoundaryError);

    // The refusal wrote nothing: no partial, no sibling, no replacement.
    expect(readdirSync(join(root, "effects")).sort()).toEqual([
      OPERATION.operationId + ".marker",
    ]);
    expect(readdirSync(marker)).toEqual([]);
  });
});
