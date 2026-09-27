import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  GIT_WRITER_REFUSALS,
  GIT_WRITER_VERBS,
  OPERATIONAL_GIT_WRITING,
  admitIdentity,
  admitRepository,
  commitAndCompareAndSet,
  gitDateOf,
  gitWrite,
  gitWriterSpawnCount,
} from "../../src/git-writer/index.js";
import type { AdmittedRepository, CommitEffectInput, CommitEffectOutcome } from "../../src/git-writer/index.js";
import { commitObject, readWorktreeTree } from "../../src/tree-hasher/index.js";

/**
 * The Git writer in disposable repositories (P-17/B, ADR 0127; decisions 248-250; brief
 * v1 with the DT pre-review's corrections B-1..B-7 and its rulings, adopted).
 *
 * Every repository here is created by its own test under the checkout's `.acp-local/`
 * (the one root the writer admits while operational writing is off, ND-10 (b)) and
 * deleted by it; the one exception is N7's repository under `os.tmpdir()`, which exists
 * to be refused. Real `/usr/bin/git` on both sides: the writer's plumbing, and the
 * test's own fixture and oracle spawns (`init`, `update-index` on a temporary index,
 * `write-tree`, `cat-file`), which the writer never runs. The canonical checkout's
 * `.git` is digested before and after the suite and must be byte-identical (A10).
 */

const GIT = "/usr/bin/git";
const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const DISPOSABLE = join(ROOT, ".acp-local");
const IDENTITY = Object.freeze({ name: "Agent Control Plane", email: "plane@agent-control-plane.invalid" });
const AUTHORIZED_AT = "2026-09-27T12:00:19.999Z";
const AUTHORIZED_SECONDS = Math.floor(Date.parse(AUTHORIZED_AT) / 1000);
const MESSAGE = "feat(fixture): a written change\n\nACP-Receipt: " + "a".repeat(64) + "\n";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    spawnSync("/bin/chmod", ["-R", "u+w", directory]);
    rmSync(directory, { recursive: true, force: true });
    expect(existsSync(directory)).toBe(false);
  }
});

function disposable(prefix: string): string {
  mkdirSync(DISPOSABLE, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(DISPOSABLE, prefix)));
  directories.push(directory);
  return directory;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// A10: the canonical checkout is byte-identical before and after
// ---------------------------------------------------------------------------

function listing(directory: string, prefix = ""): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    const stats = lstatSync(full);
    if (stats.isDirectory()) out.push(...listing(full, prefix + name + "/"));
    else out.push(prefix + name + " " + sha256(readFileSync(full)));
  }
  return out;
}

function canonicalDigest(): string {
  const dotGit = join(ROOT, ".git");
  const parts = ["HEAD", "index", "packed-refs"].map((name) => {
    const path = join(dotGit, name);
    return name + " " + (existsSync(path) ? sha256(readFileSync(path)) : "absent");
  });
  const objects = readdirSync(join(dotGit, "objects"))
    .filter((name) => /^[0-9a-f]{2}$/.test(name))
    .sort()
    .flatMap((name) => readdirSync(join(dotGit, "objects", name)).sort().map((object) => name + object));
  const head = spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: ROOT, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8" }).stdout;
  return sha256([...parts, ...listing(join(dotGit, "refs")), sha256(objects.join("\n")), head].join("\n"));
}

let canonicalBefore = "";
beforeAll(() => {
  canonicalBefore = canonicalDigest();
});
afterAll(() => {
  expect(canonicalDigest()).toBe(canonicalBefore);
});

// ---------------------------------------------------------------------------
// The test's own Git: fixtures and oracles, never the writer's
// ---------------------------------------------------------------------------

function hermetic(home: string, extra: Record<string, string> = {}): Record<string, string> {
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
    ...extra,
  };
}

function git(repo: string, args: readonly string[], input?: Buffer, extra: Record<string, string> = {}): string {
  const result = spawnSync(GIT, ["-c", "core.quotePath=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    env: hermetic(repo, extra),
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
  readonly content: string;
}

function place(repo: string, fixture: Fixture): void {
  const full = join(repo, fixture.path);
  mkdirSync(dirname(full), { recursive: true });
  rmSync(full, { force: true });
  if (fixture.kind === "link") {
    symlinkSync(fixture.content, full);
  } else {
    writeFileSync(full, fixture.content);
    chmodSync(full, fixture.kind === "exec" ? 0o755 : 0o644);
  }
}

/** A repository whose HEAD (`refs/heads/main`) commits `base`, with the same files on disk. */
function repository(base: readonly Fixture[], options: { format?: "sha1" | "sha256"; commit?: boolean; root?: string } = {}): string {
  const repo = options.root ?? disposable("acp-p17b-repo-");
  git(repo, ["init", "-q", "--object-format=" + (options.format ?? "sha1"), "."]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  for (const fixture of base) {
    place(repo, fixture);
    const sha = git(repo, ["hash-object", "-w", "--stdin"], Buffer.from(fixture.content)).trim();
    const mode = fixture.kind === "link" ? "120000" : fixture.kind === "exec" ? "100755" : "100644";
    git(repo, ["update-index", "--add", "--cacheinfo", mode + "," + sha + "," + fixture.path]);
  }
  if (options.commit !== false) {
    const tree = git(repo, ["write-tree"]).trim();
    const commit = git(repo, ["commit-tree", tree, "-m", "base"]).trim();
    git(repo, ["update-ref", "refs/heads/main", commit]);
  }
  return repo;
}

/** The oracle: `write-tree` over a temporary index holding exactly these fixtures. */
function oracleTree(repo: string, fixtures: readonly Fixture[]): string {
  const index = join(repo, ".git", "oracle-index");
  const extra = { GIT_INDEX_FILE: index };
  for (const fixture of fixtures) {
    const sha = git(repo, ["hash-object", "--stdin"], Buffer.from(fixture.content), extra).trim();
    const mode = fixture.kind === "link" ? "120000" : fixture.kind === "exec" ? "100755" : "100644";
    git(repo, ["update-index", "--add", "--cacheinfo", mode + "," + sha + "," + fixture.path], undefined, extra);
  }
  const tree = git(repo, ["write-tree"], undefined, extra).trim();
  rmSync(index, { force: true });
  return tree;
}

function admitted(repo: string): AdmittedRepository {
  const outcome = admitRepository(repo);
  if (!outcome.ok) throw new Error("the fixture repository was refused: " + outcome.refusal + " at " + outcome.at);
  return outcome.admitted;
}

function refOf(repo: string): string {
  return git(repo, ["rev-parse", "refs/heads/main"]).trim();
}

function looseObjects(repo: string): string[] {
  const objects = join(repo, ".git", "objects");
  return readdirSync(objects)
    .filter((name) => /^[0-9a-f]{2}$/.test(name))
    .flatMap((name) => readdirSync(join(objects, name)).map((object) => name + object))
    .sort();
}

const BASE: readonly Fixture[] = [
  { path: "README.md", kind: "file", content: "readme\n" },
  { path: "src/a.ts", kind: "file", content: "export const a = 1;\n" },
];

/** Every blob mode, nesting, git's sort-order edge names, depth 3, a space and non-ASCII (P1, B3). */
const SHAPES: readonly Fixture[] = [
  ...BASE.filter((fixture) => fixture.path !== "src/a.ts"),
  { path: "src/a.ts", kind: "file", content: "export const a = 10;\n" },
  { path: "bin/run.sh", kind: "exec", content: "#!/bin/sh\nexit 0\n" },
  { path: "docs/link", kind: "link", content: "../README.md" },
  { path: "a-b", kind: "file", content: "dash\n" },
  { path: "a.b", kind: "file", content: "dot\n" },
  { path: "a/x", kind: "file", content: "tree\n" },
  { path: "a0", kind: "file", content: "zero\n" },
  { path: "deep/er/est/file.txt", kind: "file", content: "three levels\n" },
  { path: "names/with space é.txt", kind: "file", content: "utf-8\n" },
];

/** The effect's input over a repository whose worktree now holds `fixtures`. */
function effectOver(repo: string, fixtures: readonly Fixture[], overrides: Partial<CommitEffectInput> = {}): CommitEffectInput {
  for (const fixture of fixtures) place(repo, fixture);
  const tree = readWorktreeTree(
    repo,
    fixtures.map((fixture) => fixture.path),
  );
  if (!tree.ok) throw new Error("the fixture tree was refused: " + tree.refusal);
  const repository = admitted(repo);
  return {
    admitted: repository,
    identity: IDENTITY,
    authorizedAt: AUTHORIZED_AT,
    baseSha: repository.head,
    treeSha: tree.treeSha,
    blobs: tree.blobs,
    trees: tree.trees,
    writeSet: fixtures.map((fixture) => fixture.path),
    message: MESSAGE,
    fence: () => ({ ok: true, reason: null }),
    ...overrides,
  };
}

function written(outcome: CommitEffectOutcome): Extract<CommitEffectOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error("expected a commit, and the effect was refused " + outcome.refusal + " at " + outcome.at + " (" + String(outcome.word) + ")");
  return outcome;
}

function lastReflog(repo: string): string {
  const lines = readFileSync(join(repo, ".git", "logs", "refs", "heads", "main"), "utf8").trimEnd().split("\n");
  return lines.at(-1) ?? "";
}

// ---------------------------------------------------------------------------

describe("the vocabulary, the verbs and the switch", () => {
  it("is one sorted, repeat-free list; three plumbing verbs; operational writing is off", () => {
    expect([...GIT_WRITER_REFUSALS]).toEqual([...GIT_WRITER_REFUSALS].sort());
    expect(new Set(GIT_WRITER_REFUSALS).size).toBe(GIT_WRITER_REFUSALS.length);
    expect([...GIT_WRITER_VERBS]).toEqual(["commit-tree", "hash-object", "update-ref"]);
    expect(OPERATIONAL_GIT_WRITING).toBe(false);
  });
});

describe("P1-P4: objects, one commit and one compare-and-set, all of them Git's own", () => {
  it("P1, P2, P4, B3: every object id is the hasher's and the oracle's; the commit is exactly the recorded facts; the ref moves and the index does not", () => {
    const repo = repository(BASE);
    const indexBefore = readFileSync(join(repo, ".git", "index"));
    const input = effectOver(repo, SHAPES);
    const outcome = written(commitAndCompareAndSet(input));

    // P1: every blob and tree exists, with the id the hasher computed; the oracle, a
    // temporary index's write-tree over the same content (it writes no object, and
    // write-tree needs the blobs to exist: the writer wrote them), agrees.
    for (const object of [...input.blobs, ...input.trees]) expect(git(repo, ["cat-file", "-t", object.sha1]).trim()).toMatch(/^(blob|tree)$/);
    expect(oracleTree(repo, SHAPES)).toBe(input.treeSha);
    // P2: the commit object, read back by the test.
    const body = git(repo, ["cat-file", "commit", outcome.commitSha]);
    const person = "Agent Control Plane <plane@agent-control-plane.invalid> " + String(AUTHORIZED_SECONDS) + " +0000";
    expect(body).toBe("tree " + input.treeSha + "\nparent " + input.baseSha + "\nauthor " + person + "\ncommitter " + person + "\n\n" + MESSAGE);
    expect(body).not.toContain("gpgsig");
    expect(sha256(body.slice(body.indexOf("\n\n") + 2))).toBe(sha256(MESSAGE));
    const expected = commitObject({ treeSha: input.treeSha, parentSha: input.baseSha, name: IDENTITY.name, email: IDENTITY.email, seconds: AUTHORIZED_SECONDS, message: MESSAGE });
    expect(outcome.commitSha).toBe(expected.sha1);
    // P4: the ref read back is the commit; the index is byte-unchanged; the reflog is the injected identity's.
    expect(outcome).toEqual({ ok: true, commitSha: expected.sha1, treeSha: input.treeSha, baseSha: input.baseSha, ref: "refs/heads/main" });
    expect(refOf(repo)).toBe(outcome.commitSha);
    expect(readFileSync(join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(lastReflog(repo)).toContain(" " + person);
    expect(lastReflog(repo)).not.toMatch(/acp-fixture|davila/);
  });

  it("P3, B1: the same recorded facts in two fresh repositories give one commit id; the second is floored, never rounded", () => {
    const ids = ["2026-09-27T12:00:19.999Z", "2026-09-27T12:00:19.000Z"].map((authorizedAt) => {
      const repo = repository(BASE);
      return written(commitAndCompareAndSet(effectOver(repo, SHAPES, { authorizedAt }))).commitSha;
    });
    expect(ids[0]).toBe(ids[1]);
    expect(gitDateOf("2026-09-27T12:00:19.999Z")).toBe("@" + String(AUTHORIZED_SECONDS) + " +0000");
    expect(gitDateOf("2026-09-27T12:00:20.000Z")).toBe("@" + String(AUTHORIZED_SECONDS + 1) + " +0000");
  });
});

describe("N1, B5: a compare-and-set that does not land is reported by name, never as success", () => {
  it("N1: the ref moved between commit-tree and update-ref keeps the mover's value", () => {
    const repo = repository(BASE);
    const other = git(repo, ["commit-tree", git(repo, ["write-tree"]).trim(), "-p", refOf(repo), "-m", "a racer"]).trim();
    const outcome = commitAndCompareAndSet(
      effectOver(repo, SHAPES, {
        fence: () => {
          git(repo, ["update-ref", "refs/heads/main", other]);
          return { ok: true, reason: null };
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: false, refusal: "GIT_WRITER_REF_MOVED", at: "ref" });
    expect(refOf(repo)).toBe(other);
  });

  it("B5: a held ref lock leaves the base, and a vanished ref is an unknown outcome", () => {
    const repo = repository(BASE);
    const base = refOf(repo);
    const lock = join(repo, ".git", "refs", "heads", "main.lock");
    const locked = commitAndCompareAndSet(
      effectOver(repo, SHAPES, {
        fence: () => {
          writeFileSync(lock, "");
          return { ok: true, reason: null };
        },
      }),
    );
    rmSync(lock, { force: true });
    expect(locked).toMatchObject({ ok: false, refusal: "GIT_WRITER_REF_UNCHANGED", at: "ref" });
    expect(refOf(repo)).toBe(base);

    const gone = repository(BASE);
    const unknown = commitAndCompareAndSet(
      effectOver(gone, SHAPES, {
        fence: () => {
          git(gone, ["update-ref", "-d", "refs/heads/main"]);
          return { ok: true, reason: null };
        },
      }),
    );
    expect(unknown).toMatchObject({ ok: false, refusal: "GIT_WRITER_REF_OUTCOME_UNKNOWN", at: "ref" });
  });

  it("the fence refuses by its own word before the ref moves; a body Git refuses is GIT_WRITER_COMMIT_FAILED", () => {
    const repo = repository(BASE);
    const base = refOf(repo);
    const fenced = commitAndCompareAndSet(effectOver(repo, SHAPES, { fence: () => ({ ok: false, reason: "LEASE_FENCE_LOST" }) }));
    expect(fenced).toEqual({ ok: false, refusal: "GIT_WRITER_FENCE_REFUSED", at: "fence", word: "LEASE_FENCE_LOST" });
    expect(refOf(repo)).toBe(base);
    const nul = commitAndCompareAndSet(effectOver(repo, SHAPES, { message: "feat: x\u0000y\n\nACP-Receipt: " + "a".repeat(64) + "\n" }));
    expect(nul).toMatchObject({ ok: false, refusal: "GIT_WRITER_COMMIT_FAILED", at: "commitObject" });
    expect(refOf(repo)).toBe(base);
  });
});

describe("N2-N6: what the repository, the host and the caller cannot decide", () => {
  it("N2: a verb outside the closed set is refused as a value, before any spawn", () => {
    const repo = repository(BASE);
    const repository_ = admitted(repo);
    const before = gitWriterSpawnCount();
    for (const verb of ["push", "commit", "checkout", "reset", "config", "update-index", "read-tree", "write-tree"]) {
      expect(gitWrite({ admitted: repository_, identity: IDENTITY, verb, args: [], stdin: Buffer.alloc(0), authorizedAt: null })).toEqual({
        ok: false,
        refusal: "GIT_WRITER_VERB_DENIED",
        at: "verb",
        status: null,
      });
    }
    // A shape that was never admitted is not a repository the writer may touch.
    expect(gitWrite({ admitted: { ...repository_ }, identity: IDENTITY, verb: "hash-object", args: ["--stdin"], stdin: Buffer.alloc(0), authorizedAt: null })).toMatchObject({
      refusal: "GIT_WRITER_OPERATIONAL_DISABLED",
    });
    expect(gitWriterSpawnCount()).toBe(before);
  });

  it("N3, N4: repository-local hooks and hooksPath never run; signing, a foreign gpg and a foreign encoding change nothing", () => {
    const repo = repository(BASE);
    const marker = join(dirname(repo), "hook-ran-" + String(process.pid));
    const script = "#!/bin/sh\ntouch " + marker + "\n";
    const hooks = join(repo, "hooks-elsewhere");
    mkdirSync(hooks);
    for (const name of ["reference-transaction", "pre-commit", "post-commit", "post-rewrite"]) {
      for (const directory of [join(repo, ".git", "hooks"), hooks]) {
        writeFileSync(join(directory, name), script);
        chmodSync(join(directory, name), 0o755);
      }
    }
    git(repo, ["config", "core.hooksPath", hooks]);
    git(repo, ["config", "commit.gpgSign", "true"]);
    git(repo, ["config", "gpg.program", "/nonexistent"]);
    git(repo, ["config", "i18n.commitEncoding", "ISO-8859-1"]);
    const outcome = written(commitAndCompareAndSet(effectOver(repo, SHAPES)));
    expect(existsSync(marker)).toBe(false);
    const body = git(repo, ["cat-file", "commit", outcome.commitSha]);
    expect(body).not.toContain("gpgsig");
    expect(body).not.toContain("encoding");
  });

  it("N5, N6: repository-local identity keys, the caller's environment and a HOME gitconfig are ignored; the injected identity is the only one", () => {
    const repo = repository(BASE);
    for (const [key, value] of [
      ["user.name", "Personal"],
      ["user.email", "me@real.example"],
      ["author.name", "Personal Author"],
      ["author.email", "author@real.example"],
      ["committer.name", "Personal Committer"],
      ["committer.email", "committer@real.example"],
    ] as const) {
      git(repo, ["config", key, value]);
    }
    const home = disposable("acp-p17b-home-");
    const marker = join(home, "alias-or-hook-ran");
    mkdirSync(join(home, "hooks"));
    writeFileSync(join(home, "hooks", "reference-transaction"), "#!/bin/sh\ntouch " + marker + "\n");
    chmodSync(join(home, "hooks", "reference-transaction"), 0o755);
    writeFileSync(join(home, ".gitconfig"), "[core]\n\thooksPath = " + join(home, "hooks") + "\n[user]\n\tname = Home User\n\temail = home@real.example\n");
    const saved = { ...process.env };
    try {
      process.env["HOME"] = home;
      process.env["XDG_CONFIG_HOME"] = home;
      process.env["GIT_AUTHOR_NAME"] = "Env Author";
      process.env["GIT_AUTHOR_EMAIL"] = "env@real.example";
      process.env["GIT_COMMITTER_NAME"] = "Env Committer";
      process.env["GIT_COMMITTER_EMAIL"] = "envc@real.example";
      process.env["GIT_DIR"] = join(ROOT, ".git");
      const outcome = written(commitAndCompareAndSet(effectOver(repo, SHAPES)));
      const body = git(repo, ["cat-file", "commit", outcome.commitSha]);
      expect(body).not.toMatch(/Personal|Home User|Env |real\.example/);
      expect(lastReflog(repo)).not.toMatch(/Personal|Home User|Env |real\.example|davila/);
      expect(lastReflog(repo)).toContain("Agent Control Plane <plane@agent-control-plane.invalid> " + String(AUTHORIZED_SECONDS) + " +0000");
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) Reflect.deleteProperty(process.env, key);
      Object.assign(process.env, saved);
    }
  });

  it("N5, ND-ID: an absent, malformed or personal identity is refused with zero spawns", () => {
    expect(admitIdentity(IDENTITY)).toBeNull();
    for (const [identity, at] of [
      [undefined, "identity"],
      [{ name: "Agent <x>", email: IDENTITY.email }, "identity.name"],
      [{ name: "Agent >", email: IDENTITY.email }, "identity.name"],
      [{ name: "Agent\nPlane", email: IDENTITY.email }, "identity.name"],
      [{ name: "Agent\u0000Plane", email: IDENTITY.email }, "identity.name"],
      [{ name: " Agent", email: IDENTITY.email }, "identity.name"],
      [{ name: IDENTITY.name, email: "plane@agent-control-plane.example" }, "identity.email"],
      [{ name: IDENTITY.name, email: "daniel@m2.local" }, "identity.email"],
      [{ name: IDENTITY.name, email: "plane@<x>.invalid" }, "identity.email"],
      [{ name: IDENTITY.name, email: "plane@invalid" }, "identity.email"],
    ] as const) {
      expect(admitIdentity(identity)).toEqual({ ok: false, refusal: "GIT_WRITER_IDENTITY_INVALID", at, word: null });
    }
    const repo = repository(BASE);
    const input = effectOver(repo, SHAPES);
    const before = gitWriterSpawnCount();
    const objects = looseObjects(repo);
    expect(commitAndCompareAndSet({ ...input, identity: { name: IDENTITY.name, email: "me@real.example" } })).toMatchObject({
      refusal: "GIT_WRITER_IDENTITY_INVALID",
    });
    expect(gitWriterSpawnCount()).toBe(before);
    expect(looseObjects(repo)).toEqual(objects);
  });
});

describe("N7, N8: admission, before any write", () => {
  it("N7: the canonical checkout, a link into it, a repository outside .acp-local/ and a directory with no .git of its own are OPERATIONAL_DISABLED", () => {
    const before = gitWriterSpawnCount();
    const holder = disposable("acp-p17b-admit-");
    symlinkSync(ROOT, join(holder, "into-canonical"));
    const plain = join(holder, "plain");
    mkdirSync(plain);
    const repo = repository(BASE);
    mkdirSync(join(repo, "sub"));
    // A well-formed repository under the operating system's temporary directory: out of the root.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "acp-p17b-outside-")));
    directories.push(outside);
    repository(BASE, { root: outside });
    for (const target of [ROOT, join(holder, "into-canonical"), outside, join(repo, "sub"), plain, DISPOSABLE]) {
      expect(admitRepository(target)).toEqual({ ok: false, refusal: "GIT_WRITER_OPERATIONAL_DISABLED", at: "repository", word: null });
    }
    // A .git that is a file (a gitlink) is not a repository of its own.
    const gitlink = disposable("acp-p17b-gitlink-");
    writeFileSync(join(gitlink, ".git"), "gitdir: " + join(repo, ".git") + "\n");
    expect(admitRepository(gitlink)).toMatchObject({ refusal: "GIT_WRITER_OPERATIONAL_DISABLED" });
    expect(admitRepository("relative/path")).toMatchObject({ refusal: "GIT_WRITER_INPUT_INVALID", at: "repository" });
    expect(admitRepository(repo + "/")).toMatchObject({ refusal: "GIT_WRITER_INPUT_INVALID" });
    expect(gitWriterSpawnCount()).toBe(before);
    expect(admitRepository(repo)).toMatchObject({ ok: true, admitted: { repository: repo, ref: "refs/heads/main" } });
  });

  it("N7, V-1: a .git whose commondir names another repository is OPERATIONAL_DISABLED; the other repository's branch does not move", () => {
    // The victim is a well-formed repository outside .acp-local/.
    const victim = realpathSync(mkdtempSync(join(tmpdir(), "acp-p17b-victim-")));
    directories.push(victim);
    repository(BASE, { root: victim });
    const victimRef = refOf(victim);
    const escape = disposable("acp-p17b-commondir-");
    // Real refs/heads/ and objects/ of its own, so only the common directory sends Git elsewhere.
    mkdirSync(join(escape, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(join(escape, ".git", "objects"));
    writeFileSync(join(escape, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(escape, ".git", "commondir"), join(victim, ".git") + "\n");
    const before = gitWriterSpawnCount();
    expect(admitRepository(escape)).toEqual({ ok: false, refusal: "GIT_WRITER_OPERATIONAL_DISABLED", at: "repository", word: null });
    expect(gitWriterSpawnCount()).toBe(before);
    expect(refOf(victim)).toBe(victimRef);
  });

  it("N7, V-1: a .git whose refs/ (or objects/, HEAD, packed-refs) is a link is OPERATIONAL_DISABLED; the linked repository's branch does not move", () => {
    const victim = realpathSync(mkdtempSync(join(tmpdir(), "acp-p17b-victim-")));
    directories.push(victim);
    repository(BASE, { root: victim });
    const victimRef = refOf(victim);
    const before = gitWriterSpawnCount();
    for (const entry of ["refs", "objects", "HEAD", "packed-refs"]) {
      const repo = repository(BASE);
      rmSync(join(repo, ".git", entry), { recursive: true, force: true });
      symlinkSync(join(victim, ".git", entry), join(repo, ".git", entry));
      expect(admitRepository(repo)).toEqual({ ok: false, refusal: "GIT_WRITER_OPERATIONAL_DISABLED", at: "repository", word: null });
    }
    // refs/heads alone, linked into the victim.
    const heads = repository(BASE);
    rmSync(join(heads, ".git", "refs", "heads"), { recursive: true, force: true });
    symlinkSync(join(victim, ".git", "refs", "heads"), join(heads, ".git", "refs", "heads"));
    expect(admitRepository(heads)).toMatchObject({ ok: false, refusal: "GIT_WRITER_OPERATIONAL_DISABLED" });
    expect(gitWriterSpawnCount()).toBe(before);
    expect(refOf(victim)).toBe(victimRef);
  });

  it("A4, N-a: gitWrite runs update-ref only as a three-operand compare-and-set of the admitted branch", () => {
    const repo = repository(BASE);
    const repository_ = admitted(repo);
    const base = refOf(repo);
    const before = gitWriterSpawnCount();
    for (const args of [
      ["-d", "refs/heads/main"],
      ["-d", "refs/heads/main", base],
      ["refs/heads/main", base],
      ["--stdin"],
      ["refs/heads/other", base, base],
      ["refs/heads/main", "HEAD", base],
      ["refs/heads/main", base, base, base],
    ]) {
      expect(gitWrite({ admitted: repository_, identity: IDENTITY, verb: "update-ref", args, stdin: Buffer.alloc(0), authorizedAt: null })).toEqual({
        ok: false,
        refusal: "GIT_WRITER_INPUT_INVALID",
        at: "args",
        status: null,
      });
    }
    expect(gitWriterSpawnCount()).toBe(before);
    expect(refOf(repo)).toBe(base);
  });

  it("N8: a sha256 repository, a detached HEAD and an unborn HEAD are refused by their own words", () => {
    expect(admitRepository(repository(BASE, { format: "sha256" }))).toMatchObject({ refusal: "OBJECT_FORMAT_UNSUPPORTED", at: "objectFormat" });
    const detached = repository(BASE);
    git(detached, ["update-ref", "--no-deref", "HEAD", refOf(detached)]);
    expect(admitRepository(detached)).toMatchObject({ refusal: "GIT_WRITER_HEAD_DETACHED", at: "ref" });
    expect(admitRepository(repository(BASE, { commit: false }))).toMatchObject({ refusal: "BASE_HEAD_MISSING", at: "head" });
  });
});

describe("N12: NB-2 at the object level", () => {
  it("a tree whose diff against the base leaves the write-set is refused before commit-tree; blobs and trees exist, the ref does not move", () => {
    const repo = repository(BASE);
    const base = refOf(repo);
    const input = effectOver(repo, SHAPES, { writeSet: ["src/a.ts"] });
    const before = gitWriterSpawnCount();
    const outcome = commitAndCompareAndSet(input);
    expect(outcome).toMatchObject({ ok: false, refusal: "GIT_WRITER_TREE_OUTSIDE_WRITE_SET" });
    // One spawn per blob and per tree, and no commit-tree.
    expect(gitWriterSpawnCount() - before).toBe(input.blobs.length + input.trees.length);
    expect(git(repo, ["cat-file", "-t", input.treeSha]).trim()).toBe("tree");
    expect(refOf(repo)).toBe(base);
  });

  it("an id Git would print differently is refused, never trusted", () => {
    const repo = repository(BASE);
    const input = effectOver(repo, SHAPES);
    const [first, ...rest] = input.blobs;
    if (first === undefined) throw new Error("the fixture has blobs");
    const outcome = commitAndCompareAndSet({ ...input, blobs: [{ ...first, sha1: "0".repeat(40) }, ...rest] });
    expect(outcome).toMatchObject({ ok: false, refusal: "GIT_WRITER_OBJECT_MISMATCH", at: "blobs[0]" });
    expect(commitAndCompareAndSet({ ...input, treeSha: "1".repeat(40) })).toMatchObject({ refusal: "GIT_WRITER_OBJECT_MISMATCH", at: "treeSha" });
  });
});
