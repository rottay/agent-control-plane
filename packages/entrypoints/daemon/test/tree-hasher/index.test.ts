import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TREE_HASH_REFUSALS, gitBlobSha1, hashCopyTree, indexPaths, treeSha } from "../../src/tree-hasher/index.js";

/**
 * The tree hasher and its oracle (P-16/C, ADR 0123; decision 235).
 *
 * The hasher computes a git tree id in process. The **oracle** is Git itself: for every
 * fixture shape, the same content is written into a fresh disposable repository under
 * `os.tmpdir()` with plumbing only -- `init`, `hash-object -w --stdin`,
 * `update-index --add --cacheinfo`, `write-tree` -- and the two ids must be equal.
 * The Git environment is built, hermetic (`GIT_CONFIG_GLOBAL=/dev/null`,
 * `GIT_CONFIG_NOSYSTEM=1`, a `HOME` of its own), under the synthetic fixture identity
 * `acp-fixture <fixture@invalid>`; no porcelain, never the canonical repository, and
 * every repository is deleted by its test (owner grant 2026-09-25 item 3; ND-18).
 */

const GIT = "/usr/bin/git";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    spawnSync("/bin/chmod", ["-R", "u+w", directory]);
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

function hermetic(home: string): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "acp-fixture",
    GIT_AUTHOR_EMAIL: "fixture@invalid",
    GIT_COMMITTER_NAME: "acp-fixture",
    GIT_COMMITTER_EMAIL: "fixture@invalid",
    GIT_AUTHOR_DATE: "2026-09-26T12:00:00Z",
    GIT_COMMITTER_DATE: "2026-09-26T12:00:00Z",
  };
}

/** One plumbing command in a disposable repository; its stdout, or a thrown status. */
function git(repo: string, args: readonly string[], input?: Buffer): string {
  const result = spawnSync(GIT, ["-c", "core.quotePath=false", ...args], {
    cwd: repo,
    env: hermetic(repo),
    input,
    encoding: "buffer",
  });
  if (result.status !== 0) throw new Error("git " + String(args[0]) + " exited " + String(result.status));
  return result.stdout.toString("utf8");
}

type Kind = "file" | "exec" | "link";
interface Fixture {
  readonly path: string;
  readonly kind: Kind;
  readonly content: Buffer;
}

function file(path: string, content: string | Buffer, kind: Kind = "file"): Fixture {
  return { path, kind, content: typeof content === "string" ? Buffer.from(content, "utf8") : content };
}

/** The oracle: `git write-tree` over exactly these entries, in a fresh sha1 repository. */
function oracleTree(fixtures: readonly Fixture[]): string {
  const repo = scratch("acp-p16c-oracle-");
  git(repo, ["init", "-q", "--object-format=sha1", "."]);
  for (const fixture of fixtures) {
    const sha = git(repo, ["hash-object", "-w", "--stdin"], fixture.content).trim();
    const mode = fixture.kind === "link" ? "120000" : fixture.kind === "exec" ? "100755" : "100644";
    git(repo, ["update-index", "--add", "--cacheinfo", mode + "," + sha + "," + fixture.path]);
  }
  return git(repo, ["write-tree"]).trim();
}

/** The same fixtures as a directory the hasher reads. */
function materialize(fixtures: readonly Fixture[]): string {
  const root = scratch("acp-p16c-copy-");
  for (const fixture of fixtures) {
    const full = join(root, fixture.path);
    mkdirSync(dirname(full), { recursive: true });
    if (fixture.kind === "link") {
      symlinkSync(fixture.content, full);
    } else {
      writeFileSync(full, fixture.content);
      chmodSync(full, fixture.kind === "exec" ? 0o755 : 0o644);
    }
  }
  return root;
}

function hashed(fixtures: readonly Fixture[]): string {
  const outcome = hashCopyTree(materialize(fixtures), fixtures.map((fixture) => fixture.path));
  if (!outcome.ok) throw new Error("the hasher refused " + outcome.refusal + " at " + outcome.at);
  return outcome.treeSha;
}

describe("the vocabulary and the known vectors", () => {
  it("is one sorted list of three words", () => {
    expect([...TREE_HASH_REFUSALS]).toEqual([...TREE_HASH_REFUSALS].sort());
    expect(TREE_HASH_REFUSALS).toEqual(["TREE_ENTRY_UNSUPPORTED", "TREE_INDEX_CONFLICTED", "TREE_PATH_UNSUPPORTED"]);
  });

  it("P8: the empty blob and the empty tree are git's", () => {
    expect(gitBlobSha1(Buffer.alloc(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(treeSha([])).toEqual({ ok: true, treeSha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
    expect(oracleTree([])).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
});

describe("P8: the hasher equals git write-tree for every fixture shape", () => {
  const shapes: Readonly<Record<string, readonly Fixture[]>> = {
    "an empty file": [file("empty.txt", "")],
    "nested directories": [file("a/b/c/deep.txt", "deep\n"), file("a/top.txt", "top\n"), file("z.txt", "z\n")],
    "a file and a directory sharing a prefix": [
      file("a.b", "dot\n"),
      file("a/b", "slash\n"),
      file("a-b", "dash\n"),
      file("a0", "zero\n"),
      file("a/a.b", "inner\n"),
    ],
    "an executable file": [file("run.sh", "#!/bin/sh\nexit 0\n", "exec"), file("plain.sh", "exit 0\n")],
    "a symbolic link, hashed as its target's bytes": [file("target.txt", "t\n"), file("link", "target.txt", "link"), file("dangling", "no/such/file", "link")],
    "a path with a space and non-ASCII UTF-8": [file("dír with space/ñandú ü.txt", "unicode\n"), file("日本/語.md", "cjk\n")],
    "a 1 MiB file": [file("big.bin", Buffer.alloc(1024 * 1024, 0x61))],
  };

  for (const [name, fixtures] of Object.entries(shapes)) {
    it(name, () => {
      expect(hashed(fixtures)).toBe(oracleTree(fixtures));
    });
  }

  it("every shape at once, whatever order the paths are given in", () => {
    // Each shape under its own directory: "nested directories" and the prefix trio
    // would otherwise name `a/b` as both a directory and a file.
    const all = Object.values(shapes).flatMap((fixtures, index) =>
      fixtures.map((fixture) => ({ ...fixture, path: "shape-" + String(index) + "/" + fixture.path })),
    );
    const expected = oracleTree(all);
    expect(hashed(all)).toBe(expected);
    expect(hashed([...all].reverse())).toBe(expected);
  });

  it("returns the entries in path byte order, each with its mode", () => {
    const fixtures = [file("b", "b"), file("a/x", "x", "exec"), file("l", "b", "link")];
    const outcome = hashCopyTree(materialize(fixtures), fixtures.map((fixture) => fixture.path));
    expect(outcome.ok && outcome.entries.map((entry) => [entry.path, entry.mode])).toEqual([
      ["a/x", "100755"],
      ["b", "100644"],
      ["l", "120000"],
    ]);
  });
});

describe("N18: what a tree may not hold is refused by name", () => {
  it("a gitlink and a conflicted stage, as a real index lists them", () => {
    const repo = scratch("acp-p16c-index-");
    git(repo, ["init", "-q", "--object-format=sha1", "."]);
    const blob = git(repo, ["hash-object", "-w", "--stdin"], Buffer.from("x\n")).trim();
    git(repo, ["update-index", "--add", "--cacheinfo", "100644," + blob + ",plain.txt"]);
    // P-16/D1 (ND-12, NB-2): each index record's mode and object id travel with its path.
    expect(indexPaths(git(repo, ["ls-files", "-s", "-z"]))).toEqual({
      ok: true,
      paths: ["plain.txt"],
      entries: [{ path: "plain.txt", mode: "100644", sha1: blob }],
    });

    git(repo, ["update-index", "--add", "--cacheinfo", "160000," + "1".repeat(40) + ",sub"]);
    expect(indexPaths(git(repo, ["ls-files", "-s", "-z"]))).toEqual({ ok: false, refusal: "TREE_ENTRY_UNSUPPORTED", at: "index[1]" });

    const conflicted = scratch("acp-p16c-conflict-");
    git(conflicted, ["init", "-q", "--object-format=sha1", "."]);
    const base = git(conflicted, ["hash-object", "-w", "--stdin"], Buffer.from("base\n")).trim();
    git(conflicted, ["update-index", "--index-info"], Buffer.from("100644 " + base + " 1\tclash.txt\n100644 " + base + " 2\tclash.txt\n"));
    expect(indexPaths(git(conflicted, ["ls-files", "-s", "-z"]))).toEqual({ ok: false, refusal: "TREE_INDEX_CONFLICTED", at: "index[0]" });
  });

  it("a FIFO, an absent path, a directory in a blob's place and a path under a linked parent", () => {
    const root = materialize([file("real/inside.txt", "in\n"), file("ok.txt", "ok\n")]);
    expect(spawnSync("/usr/bin/mkfifo", [join(root, "pipe")]).status).toBe(0);
    symlinkSync("real", join(root, "linked"));
    expect(hashCopyTree(root, ["ok.txt", "pipe"])).toEqual({ ok: false, refusal: "TREE_ENTRY_UNSUPPORTED", at: "paths[1]" });
    expect(hashCopyTree(root, ["absent.txt"])).toEqual({ ok: false, refusal: "TREE_ENTRY_UNSUPPORTED", at: "paths[0]" });
    expect(hashCopyTree(root, ["real"])).toEqual({ ok: false, refusal: "TREE_ENTRY_UNSUPPORTED", at: "paths[0]" });
    // No read outside the tree: the parent is a link, even to a directory inside it.
    expect(hashCopyTree(root, ["linked/inside.txt"])).toEqual({ ok: false, refusal: "TREE_ENTRY_UNSUPPORTED", at: "paths[0]" });
  });

  it("a path git's bytes cannot state, including a name that was not UTF-8", () => {
    const root = materialize([file("ok.txt", "ok\n")]);
    for (const path of ["", "a//b", "/abs", "../up", "./here", ".git/config", "sub/.git", "bad�name", "nul\0byte"]) {
      expect(hashCopyTree(root, [path]), JSON.stringify(path)).toEqual({ ok: false, refusal: "TREE_PATH_UNSUPPORTED", at: "paths[0]" });
    }
    expect(indexPaths("100644 " + "1".repeat(40) + " 0\tbad�name\0")).toEqual({
      ok: false,
      refusal: "TREE_PATH_UNSUPPORTED",
      at: "index[0]",
    });
    expect(indexPaths("not an index record\0")).toEqual({ ok: false, refusal: "TREE_PATH_UNSUPPORTED", at: "index[0]" });
  });

  it("a set of entries that is not a tree: a blob and a directory of one name, a path twice, a foreign mode or id", () => {
    const id = "1".repeat(40);
    expect(treeSha([{ path: "a", mode: "100644", sha1: id }, { path: "a/b", mode: "100644", sha1: id }])).toEqual({
      ok: false,
      refusal: "TREE_PATH_UNSUPPORTED",
      at: "entries[1]",
    });
    expect(treeSha([{ path: "a/b", mode: "100644", sha1: id }, { path: "a", mode: "100644", sha1: id }])).toEqual({
      ok: false,
      refusal: "TREE_PATH_UNSUPPORTED",
      at: "entries[1]",
    });
    expect(treeSha([{ path: "a", mode: "100644", sha1: id }, { path: "a", mode: "100644", sha1: id }])).toEqual({
      ok: false,
      refusal: "TREE_PATH_UNSUPPORTED",
      at: "entries[1]",
    });
    expect(treeSha([{ path: "s", mode: "160000" as never, sha1: id }])).toEqual({ ok: false, refusal: "TREE_ENTRY_UNSUPPORTED", at: "entries[0]" });
    expect(treeSha([{ path: "s", mode: "100644", sha1: "2".repeat(64) }])).toEqual({ ok: false, refusal: "TREE_ENTRY_UNSUPPORTED", at: "entries[0]" });
  });
});
