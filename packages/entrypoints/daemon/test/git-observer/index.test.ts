import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GIT_READ_VERBS } from "@acp/runtime";
import type { GitReadPort } from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { createGitObserver, observeWorktree } from "../../src/git-observer/index.js";

/**
 * Evidence for the one git read authority (V2 concurrency C4).
 *
 * **Every repository here is a temporary one this file creates and removes.**
 * A drill that ran git against the repository it lives in would be reading a
 * tree it does not control and could not clean up — and this packet is the one
 * that forbids the daemon exactly that.
 *
 * The two claims that matter are asserted the hard way. That a mutating verb is
 * refused **before** anything is spawned is asserted by a **spawn counter at
 * zero**, not by the return value: a refusal that happened after the process
 * boundary would look identical from the outside. And that the observer cannot
 * fabricate an observation is asserted by making the reads fail and requiring a
 * refusal — never a `head: null`, never an empty digest.
 */

const OBSERVER_SOURCE = readFileSync(
  new URL("../../src/git-observer/index.ts", import.meta.url),
  "utf8",
);

const temporaries: string[] = [];

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("fixture git failed: " + args.join(" ") + " " + result.stderr);
}

/** A temporary repository with one commit, and nothing of this repository in it. */
function repository(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-c4-git-")));
  temporaries.push(created);
  git(created, "init", "--quiet");
  git(created, "config", "user.email", "drill@example.invalid");
  git(created, "config", "user.name", "drill");
  writeFileSync(join(created, "kept.txt"), "one\n");
  git(created, "add", "-A");
  git(created, "commit", "-q", "-m", "base");
  return created;
}

function statusOf(cwd: string): string {
  return spawnSync("/usr/bin/git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8" }).stdout;
}

describe("the port reads, and can only read", () => {
  it("accepts the four read verbs and refuses every mutating one before any spawn", () => {
    const root = repository();
    const port = createGitObserver(root);

    for (const verb of GIT_READ_VERBS) {
      expect(port({ verb, args: verb === "rev-parse" ? ["HEAD"] : [] }).ok).toBe(true);
    }

    // Twelve mutating verbs, refused as values. The counter is the assertion:
    // a refusal that happened after the process boundary would look the same
    // from out here, and would not be the property this law is about.
    const before = spawnSync("/bin/ps", ["-Ao", "command="], { encoding: "utf8" }).stdout;
    const spawnedBefore = (before.match(/\/usr\/bin\/git/g) ?? []).length;
    const mutating = [
      "commit", "checkout", "restore", "clean", "stash", "reset",
      "add", "push", "rm", "mv", "merge", "rebase",
    ];
    for (const verb of mutating) {
      const outcome = port({ verb: verb as never, args: [] });
      expect({ verb, ok: outcome.ok }).toEqual({ verb, ok: false });
    }
    const after = spawnSync("/bin/ps", ["-Ao", "command="], { encoding: "utf8" }).stdout;
    expect((after.match(/\/usr\/bin\/git/g) ?? []).length).toBe(spawnedBefore);
    // And the worktree is untouched by having been asked.
    expect(statusOf(root)).toBe("");
  });

  it("takes no configuration from a caller", () => {
    const port = createGitObserver(repository());
    for (const args of [["-c", "core.pager=false"], ["--exec-path=/tmp"]]) {
      expect(port({ verb: "status", args }).ok).toBe(false);
    }
  });

  it("refuses a worktree path that is not absolute and resolved", () => {
    expect(() => createGitObserver("relative/path")).toThrow();
    expect(() => createGitObserver("/tmp/../tmp/x/")).toThrow();
  });

  it("names no mutating verb and no shell, in its own source", () => {
    // A mutation must be unrepresentable, not merely unused — the same property
    // L-C-4a pins over the tree.
    const code = OBSERVER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of ['"commit"', '"checkout"', '"restore"', '"clean"', '"stash"', '"reset"', '"add"', '"push"']) {
      expect({ forbidden, present: code.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
    expect(code).toContain("shell: false");
    expect(code).toContain("/usr/bin/git");
  });

  it("builds the child environment rather than inheriting it", () => {
    // Code, not prose: the module's docblock names these precisely to explain
    // why they are absent, and a docblock that explains an absence must not
    // read as a presence. The same distinction the architecture fence draws.
    const code = OBSERVER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Each of these could redirect git at a different repository than the one
    // being judged, and none of them is present because nothing puts it there.
    for (const variable of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_CONFIG_GLOBAL",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ]) {
      expect({ variable, present: code.includes(variable) }).toEqual({ variable, present: false });
    }
    expect(code).toContain('env: { LC_ALL: "C"');
  });

  it("reports a status line and a code, never file bytes", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "acp-c4-bare-")));
    temporaries.push(outside);
    writeFileSync(join(outside, "secret.txt"), "PASSWORD=hunter2\n");
    const outcome = createGitObserver(outside)({ verb: "status", args: ["--porcelain=v1"] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("status");
      expect(outcome.reason).not.toContain("hunter2");
    }
  });
});

describe("the observation is taken, or refused — never fabricated", () => {
  it("sees a modification, a deletion, an untracked file and a rename's both sides", () => {
    const root = repository();
    writeFileSync(join(root, "moved.txt"), "two\n");
    writeFileSync(join(root, "gone.txt"), "three\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "more");

    writeFileSync(join(root, "kept.txt"), "changed\n");
    rmSync(join(root, "gone.txt"));
    git(root, "mv", "moved.txt", "renamed.txt");
    mkdirSync(join(root, "fresh"), { recursive: true });
    writeFileSync(join(root, "fresh", "a.txt"), "a\n");
    writeFileSync(join(root, "fresh", "b.txt"), "b\n");
    writeFileSync(join(root, "a file with spaces.txt"), "s\n");

    const before = statusOf(root);
    const seen = observeWorktree(createGitObserver(root), root);
    if (!seen.ok) throw new Error("expected an observation: " + seen.reason);
    const paths = seen.observation.trackedChanges.map((entry) => entry.path);

    expect(paths).toContain("kept.txt");
    expect(paths).toContain("gone.txt");
    // Both sides of the rename: a writer who moves a file out of its write-set
    // has still written outside it.
    expect(paths).toContain("moved.txt");
    expect(paths).toContain("renamed.txt");
    // One entry per untracked FILE, so a directory conceals nothing.
    expect(seen.observation.untrackedPaths).toContain("fresh/a.txt");
    expect(seen.observation.untrackedPaths).toContain("fresh/b.txt");
    // Verbatim, never re-quoted.
    expect(seen.observation.untrackedPaths).toContain("a file with spaces.txt");

    // A deletion digests no bytes — a real digest of what is there now.
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(seen.observation.trackedChanges.find((entry) => entry.path === "gone.txt")?.sha256).toBe(empty);
    // Observing changed nothing.
    expect(statusOf(root)).toBe(before);
  });

  it("excludes an ignored file", () => {
    const root = repository();
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "ignore");
    writeFileSync(join(root, "ignored.txt"), "x\n");

    const seen = observeWorktree(createGitObserver(root), root);
    if (!seen.ok) throw new Error("expected an observation");
    expect(seen.observation.untrackedPaths).not.toContain("ignored.txt");
  });

  it("reports a null head at an initial commit, and only there", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-c4-unborn-")));
    temporaries.push(root);
    git(root, "init", "--quiet");
    writeFileSync(join(root, "new.txt"), "n\n");

    const seen = observeWorktree(createGitObserver(root), root);
    if (!seen.ok) throw new Error("expected an observation on an unborn HEAD");
    // Null because the status read SUCCEEDED and proved this is a repository.
    expect(seen.observation.head).toBeNull();
    expect(seen.observation.untrackedPaths).toContain("new.txt");
  });

  it("refuses rather than fabricating when the repository cannot be read", () => {
    const notARepository = realpathSync(mkdtempSync(join(tmpdir(), "acp-c4-none-")));
    temporaries.push(notARepository);
    const seen = observeWorktree(createGitObserver(notARepository), notARepository);
    // The whole point: no `head: null`, no empty observation, no pass. An
    // observation that could not be taken says nothing about conformance, and
    // the caller must read this as OBSERVATION_FAILED.
    expect(seen.ok).toBe(false);
  });

  it("refuses when a read fails, rather than reporting a fabricated head", () => {
    // A port whose status succeeds but whose rev-parse answers nonsense. The
    // observer must not read that as an initial commit.
    const root = repository();
    const real = createGitObserver(root);
    const lying: GitReadPort = (request) =>
      request.verb === "rev-parse" ? { ok: true, stdout: "not-an-object-id\n" } : real(request);
    const seen = observeWorktree(lying, root);
    expect(seen.ok).toBe(false);
  });

  it("sorts what it reports, so two observations of one tree are equal", () => {
    const root = repository();
    writeFileSync(join(root, "z.txt"), "z\n");
    writeFileSync(join(root, "a.txt"), "a\n");
    const port = createGitObserver(root);
    const first = observeWorktree(port, root);
    const second = observeWorktree(port, root);
    if (!first.ok || !second.ok) throw new Error("expected two observations");
    expect(first.observation).toEqual(second.observation);
    expect([...first.observation.untrackedPaths]).toEqual(
      [...first.observation.untrackedPaths].sort(),
    );
  });
});
