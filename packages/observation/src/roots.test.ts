import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ObservationError } from "./errors.js";
import {
  ARTIFACT_MAX_BYTES,
  OBSERVATION_KINDS,
  admitArtifact,
  checkArtifactName,
  observationRootPath,
  redactObservationPath,
  resolveObservationRoot,
} from "./roots.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = dirname(HERE);
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

/**
 * The suite owns the shadow roots for the duration of a test and removes them
 * afterwards. It creates them deliberately: production code cannot, which is
 * the law under test, so the fixture has to.
 */
function makeRoots(): void {
  for (const kind of OBSERVATION_KINDS) {
    mkdirSync(observationRootPath(kind), { recursive: true, mode: 0o700 });
  }
}

function removeRoots(): void {
  rmSync(join(REPO_ROOT, ".acp-local", "shadow"), { recursive: true, force: true });
}

afterEach(() => {
  removeRoots();
});

describe("the allowlist", () => {
  it("names exactly the two ignored shadow roots", () => {
    expect([...OBSERVATION_KINDS]).toEqual(["artifacts", "scenarios"]);
    for (const kind of OBSERVATION_KINDS) {
      const path = observationRootPath(kind);
      expect(path.startsWith(join(REPO_ROOT, ".acp-local", "shadow"))).toBe(true);
      expect(redactObservationPath(path)).toBe(join(".acp-local", "shadow", kind));
    }
  });

  it("resolves a root that exists", () => {
    makeRoots();
    for (const kind of OBSERVATION_KINDS) {
      expect(resolveObservationRoot(kind)).toBe(observationRootPath(kind));
    }
  });

  it("refuses an absent root rather than creating one", () => {
    // The law that separates observation from invention: a collector able to
    // create the directory it reads can be aimed at a fresh directory anywhere
    // and will cheerfully report that it found nothing.
    removeRoots();
    for (const kind of OBSERVATION_KINDS) {
      expect(() => resolveObservationRoot(kind)).toThrow(ObservationError);
      try {
        resolveObservationRoot(kind);
      } catch (error: unknown) {
        expect((error as ObservationError).code).toBe("ROOT_ABSENT");
      }
      expect(existsSync(observationRootPath(kind))).toBe(false);
    }
  });

  it("refuses a symlinked root", () => {
    const shadow = join(REPO_ROOT, ".acp-local", "shadow");
    mkdirSync(shadow, { recursive: true, mode: 0o700 });
    const elsewhere = join(shadow, "elsewhere");
    mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, observationRootPath("artifacts"));
    try {
      resolveObservationRoot("artifacts");
      expect.unreachable("a symlinked root must be refused");
    } catch (error: unknown) {
      expect((error as ObservationError).code).toBe("PATH_NOT_CANONICAL");
    }
  });

  it("refuses a group- or world-writable root", () => {
    makeRoots();
    chmodSync(observationRootPath("artifacts"), 0o777);
    try {
      resolveObservationRoot("artifacts");
      expect.unreachable("a writable root must be refused");
    } catch (error: unknown) {
      expect((error as ObservationError).code).toBe("UNSAFE_PERMISSIONS");
    }
  });
});

describe("artifact names are names, not paths", () => {
  it("accepts the admitted grammar", () => {
    for (const name of ["run.json", "a", "task-01.ndjson", "x_y.z-1"]) {
      expect(checkArtifactName(name)).toEqual({ ok: true });
    }
  });

  it("refuses anything carrying a path", () => {
    for (const name of ["a/b", "../escape", "..", ".", "/etc/passwd", "with space"]) {
      expect(checkArtifactName(name)).toMatchObject({ reason: "PATH_SUPPLIED" });
    }
  });

  it("refuses names outside the grammar", () => {
    for (const name of ["", "-leading", "UPPER", "sym$bol", "x".repeat(200)]) {
      const verdict = checkArtifactName(name);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("BAD_ARTIFACT_NAME");
    }
  });
});

describe("admitting an artifact", () => {
  it("admits an owned, owner-only, in-bounds regular file", () => {
    makeRoots();
    const root = resolveObservationRoot("artifacts");
    const path = join(root, "run.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o600);

    const admitted = admitArtifact(root, "run.json");
    expect(admitted.ok).toBe(true);
    if (admitted.ok) expect(readFileSync(admitted.handle, "utf8")).toBe("{}");
  });

  it("refuses an absent artifact", () => {
    makeRoots();
    const root = resolveObservationRoot("artifacts");
    expect(admitArtifact(root, "missing.json")).toMatchObject({ reason: "NOT_OWNED_FILE" });
  });

  it("refuses a directory", () => {
    makeRoots();
    const root = resolveObservationRoot("artifacts");
    mkdirSync(join(root, "nested"), { mode: 0o700 });
    expect(admitArtifact(root, "nested")).toMatchObject({ reason: "NOT_OWNED_FILE" });
  });

  it("refuses a symlinked artifact", () => {
    makeRoots();
    const root = resolveObservationRoot("artifacts");
    const real = join(root, "real.json");
    writeFileSync(real, "{}");
    chmodSync(real, 0o600);
    symlinkSync(real, join(root, "link.json"));
    expect(admitArtifact(root, "link.json")).toMatchObject({ reason: "PATH_NOT_CANONICAL" });
  });

  it("refuses a group- or world-writable artifact", () => {
    // An artifact anyone can rewrite is a way to feed the baseline whatever
    // somebody likes.
    makeRoots();
    const root = resolveObservationRoot("artifacts");
    const path = join(root, "open.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o666);
    expect(admitArtifact(root, "open.json")).toMatchObject({ reason: "UNSAFE_PERMISSIONS" });
  });

  it("refuses an oversized artifact on the stat, before reading it", () => {
    makeRoots();
    const root = resolveObservationRoot("artifacts");
    const path = join(root, "big.json");
    writeFileSync(path, "x".repeat(ARTIFACT_MAX_BYTES + 1));
    chmodSync(path, 0o600);
    expect(admitArtifact(root, "big.json")).toMatchObject({ reason: "TOO_LARGE" });
  });

  it("refuses a path even when the file behind it would be admissible", () => {
    // The traversal case, stated as a whole: the target is perfectly fine, and
    // the request is still refused, because the caller named a path.
    makeRoots();
    const scenarios = resolveObservationRoot("scenarios");
    const target = join(scenarios, "ok.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o600);

    const artifacts = resolveObservationRoot("artifacts");
    expect(admitArtifact(artifacts, ".." + sep + "scenarios" + sep + "ok.json")).toMatchObject({
      reason: "PATH_SUPPLIED",
    });
  });
});

describe("the package cannot mutate or reach out", () => {
  it("imports no process, network, signal or write API in production modules", () => {
    // Structural, not behavioural. The roadmap forbids attaching, signalling
    // and writing; the honest way to guarantee that is for the code to have no
    // way to do it, checked here and again by the architecture fence.
    const forbidden = [
      "node:child_process",
      "node:net",
      "node:http",
      "node:https",
      "node:tls",
      "node:dgram",
      "node:dns",
      "node:worker_threads",
    ];
    const mutators = [
      "writeFileSync",
      "appendFileSync",
      "mkdirSync",
      "rmSync",
      "unlinkSync",
      "renameSync",
      "chmodSync",
    ];
    for (const entry of readdirSync(HERE, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      const source = readFileSync(join(HERE, entry.name), "utf8");
      for (const name of forbidden) expect(source).not.toContain(name);
      for (const name of mutators) expect(source).not.toContain(name);
      expect(source).not.toContain("process.env");
      expect(source).not.toContain("process.kill");
    }
  });

  it("opens exactly one read-only descriptor in the whole package", () => {
    // `openSync` used to sit in the mutator list above, banned by token. That
    // ban was wrong rather than strict: closing the admission-then-read gap
    // honestly requires an `fstat` on the *opened inode*, which only a
    // descriptor can provide. A token ban would have forced the dishonest
    // alternative — re-checking the path and trusting it still named the same
    // file.
    //
    // The ban is therefore an exception with exactly one member, checked in
    // both directions across every production module in the package: that one
    // file opens once, read-only, refusing symlinks; every other file may not
    // open at all; and no file anywhere may name a write-capable flag.
    const OPEN_SITE = "collect/artifact.ts";
    // The exact normalized call, not a set of tokens that must appear
    // somewhere: checking only for `O_RDONLY` and `O_NOFOLLOW` would admit a
    // different handle, or a numeric flag no name-based scan can read.
    const OPEN_CALL = "openSync(handle, constants.O_RDONLY | constants.O_NOFOLLOW)";
    const WRITE_FLAGS = ["O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND", "O_EXCL"];
    const callsIn = (source: string): string[] =>
      [...source.matchAll(/openSync\([^()]*\)/g)].map((match) => match[0].replace(/\s+/g, " ").trim());

    const sources: { readonly name: string; readonly source: string }[] = [];
    for (const directory of [HERE, join(HERE, "collect")]) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue;
        const relative = directory === HERE ? entry.name : "collect/" + entry.name;
        sources.push({ name: relative, source: readFileSync(join(directory, entry.name), "utf8") });
      }
    }
    expect(sources.map((entry) => entry.name)).toContain(OPEN_SITE);

    for (const { name, source } of sources) {
      const opens = source.split("openSync(").length - 1;
      const calls = callsIn(source);
      if (name === OPEN_SITE) {
        // Token count and parsed calls must agree, so an unreadable call is a
        // failure rather than an omission.
        expect({ name, opens, parsed: calls.length }).toEqual({ name, opens: 1, parsed: 1 });
        expect({ name, call: calls[0] }).toEqual({ name, call: OPEN_CALL });
      } else {
        expect({ name, opens }).toEqual({ name, opens: 0 });
        expect({ name, parsed: calls.length }).toEqual({ name, parsed: 0 });
      }
      for (const flag of WRITE_FLAGS) expect({ name, flag, present: source.includes(flag) }).toEqual({ name, flag, present: false });
    }
  });

  it("names no product repository or session tool", () => {
    // The tokens are assembled from pieces and this file excludes itself, for
    // the same reason the launchd drills do: a scan that spells the strings it
    // forbids fails on its own assertion list, and would trip the repository
    // wide fence this packet adds.
    const forbidden = [
      ["Modern", "Rescue"].join(" "),
      ["ui-design", "system"].join("-"),
      ["tm", "ux"].join(""),
    ];
    for (const entry of readdirSync(HERE, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      const source = readFileSync(join(HERE, entry.name), "utf8");
      for (const token of forbidden) expect(source).not.toContain(token);
    }
  });
});
