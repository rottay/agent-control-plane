import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { GIT_READ_VERBS } from "@acp/runtime";
import type { GitReadOutcome, GitReadPort, GitReadRequest, WorktreeObservation } from "@acp/runtime";

/**
 * The one git read authority — V2 concurrency C4.
 *
 * `GitReadPort` has existed in `@acp/runtime` since the enforcement module was
 * written, with its own docblock saying *"No implementation of this exists in
 * production source"*. This is that implementation, and it is deliberately the
 * narrowest thing that can satisfy the port.
 *
 * ## It can only read, and that is structural rather than intentional
 *
 * The verb is checked against `GIT_READ_VERBS` **before** anything is spawned,
 * so a mutating verb never reaches the process boundary — it is refused as a
 * value, not merely unused. The four read verbs are the whole vocabulary; there
 * is no branch here that could carry `commit`, `checkout`, `restore`, `clean`,
 * `stash`, `reset`, `add` or `rm`, and `L-C-4a` asserts those words are absent
 * from this file. **A mutation must be unrepresentable, not merely unused.**
 *
 * This matters most at the moment it is used. A write-set violation is
 * discovered *by* this observer, and the plane's answer to a violation is to
 * record it and stop — never to tidy the worktree. The evidence of what a
 * packet did is worth more than a clean directory, and the module that could
 * clean it does not exist.
 *
 * ## Why `spawnSync`
 *
 * The gate that calls this is synchronous by contract, and a synchronous read
 * that cannot outlive its call leaks nothing: there is no child to reap, no
 * handle to close and therefore **no unwind resource**. Under C3's N walks
 * several observers may read sibling worktrees at once, which is why
 * `--no-optional-locks` is passed — an observation must never take a lock a
 * walk is waiting on.
 *
 * ## What the environment cannot decide
 *
 * `/usr/bin/git` by absolute path, so `PATH` cannot choose which program
 * answers — the same reasoning as `PS_BINARY`. The child environment is
 * **built, never inherited**: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_CONFIG_GLOBAL` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` are absent because
 * nothing puts them there, and each of them could otherwise redirect the
 * observation to a different repository than the one being judged. `LC_ALL=C`
 * for the reason `identity-probe` sets it: parsed output must not depend on a
 * locale.
 *
 * `worktreePath` comes from the already-admitted binding — never a
 * caller-supplied option, and never a relative path.
 */

/**
 * The binary and its bounds, declared here rather than in `constants/index.ts`.
 *
 * `constants/` is outside this packet's write-set, and C3 set the precedent for
 * exactly this when it declared `WALK_CONCURRENCY_MAX` in the scheduler: a
 * value that belongs to one authority can live with that authority.
 *
 * An absolute path, so `PATH` cannot decide which program answers the question
 * "what did this packet write" — the same reasoning as `PS_BINARY`. Bounded in
 * time and in output, because an observation is taken inside a walk and must
 * never be the thing that hangs it.
 */
const GIT_BINARY = "/usr/bin/git";
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Fixed flags, on every invocation, before the verb. */
const GIT_PREFIX: readonly string[] = Object.freeze([
  // Paths verbatim, so a path with a space or a quote is not re-encoded into
  // something the parser would have to un-escape.
  "-c",
  "core.quotePath=false",
  // Never take a lock a concurrent walk might be waiting on.
  "--no-optional-locks",
]);

function isReadVerb(value: unknown): value is (typeof GIT_READ_VERBS)[number] {
  return typeof value === "string" && (GIT_READ_VERBS as readonly string[]).includes(value);
}

/**
 * Build one git read port over one already-admitted worktree.
 *
 * Refuses rather than throws: a `GitReadOutcome` is the port's own vocabulary,
 * and a caller that cannot observe must be able to fail closed without catching.
 */
export function createGitObserver(worktreePath: string): GitReadPort {
  if (!isAbsolute(worktreePath) || resolve(worktreePath) !== worktreePath) {
    throw new Error("the observed worktree must be an absolute, resolved path");
  }

  return (request: GitReadRequest): GitReadOutcome => {
    // Before the spawn, always. A denied verb never reaches the boundary.
    if (!isReadVerb(request.verb)) {
      return { ok: false, reason: "verb is not one of the four read verbs" };
    }
    // No caller-supplied `-c`: configuration is this module's, not the
    // request's, and a `-c` from outside could turn a read into an alias.
    for (const argument of request.args) {
      if (typeof argument !== "string") return { ok: false, reason: "an argument is not a string" };
      if (argument === "-c" || argument.startsWith("--exec-path")) {
        return { ok: false, reason: "configuration arguments are not accepted from a caller" };
      }
    }

    const result = spawnSync(GIT_BINARY, [...GIT_PREFIX, request.verb, ...request.args], {
      cwd: worktreePath,
      // Built, never inherited: nothing here can redirect git at another
      // repository, because none of the redirecting variables is present.
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      shell: false,
      windowsHide: true,
    });

    if (result.error !== undefined) {
      return { ok: false, reason: "git could not be run: " + result.error.name };
    }
    if (result.status !== 0) {
      // A status line and a code, never file bytes: stderr from a read verb can
      // carry path fragments and this value reaches a log.
      return { ok: false, reason: "git exited with status " + String(result.status) };
    }
    return { ok: true, stdout: result.stdout };
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A git object id, and nothing that merely looks like one. */
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * Take one observation of a worktree, in the receipt's own shape.
 *
 * `status -z --porcelain=v1 --untracked-files=all --ignored=no`, parsed by NUL.
 * `-z` is load-bearing twice over: paths are never quoted, so nothing has to be
 * un-escaped; and a rename emits `XY<NUL>new<NUL>old`, so **both sides are
 * observed** — a writer who moves a file out of its write-set has still written
 * outside it, and a parser that read only the new name would miss it.
 *
 * `??` becomes an untracked path, one entry per file: `--untracked-files=all`
 * is what stops an untracked directory concealing everything beneath it. Any
 * other code becomes a tracked change, digested. A **deletion** digests the
 * empty string — the sha256 of no bytes is a real digest of what is there now,
 * and a deletion is an observed path like any other.
 *
 * A port failure returns no observation. The caller must treat that as
 * `OBSERVATION_FAILED`, never as a pass: an observation that could not be taken
 * says nothing about conformance.
 */
export function observeWorktree(
  port: GitReadPort,
  worktreePath: string,
): { readonly ok: true; readonly observation: WorktreeObservation } | { readonly ok: false; readonly reason: string } {
  // **Status first, and it is load-bearing.** A successful status is what
  // proves this is a readable repository. Only then can a failing `rev-parse`
  // be read as an unborn HEAD — a repository at its initial commit, which the
  // receipt's own `baseHead` allows to be null.
  //
  // Taken the other way round, a `rev-parse` that failed for any reason at all
  // would become `head: null`, and a broken or absent repository would be
  // reported as a pristine new one. That is a **fabricated observation**, and
  // it is the shape this function must never produce: an observation that could
  // not be taken says nothing about conformance, so it is a refusal.
  const status = port({
    verb: "status",
    args: ["-z", "--porcelain=v1", "--untracked-files=all", "--ignored=no"],
  });
  if (!status.ok) return { ok: false, reason: status.reason };

  const head = port({ verb: "rev-parse", args: ["HEAD"] });
  let baseHead: string | null = null;
  if (head.ok) {
    const trimmed = head.stdout.trim();
    // A successful read that is not an object id is not an object id. It is
    // not null either — it is an answer this parser does not understand, and
    // guessing would be the same fabrication one line up.
    if (!GIT_OBJECT_ID.test(trimmed)) {
      return { ok: false, reason: "rev-parse returned no git object id" };
    }
    baseHead = trimmed;
  }

  const fields = status.stdout.split("\0");
  const trackedChanges: { path: string; sha256: string }[] = [];
  const untrackedPaths: string[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry === undefined || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path === "") continue;

    if (code === "??") {
      untrackedPaths.push(path);
      continue;
    }

    // A rename or a copy carries its source in the NEXT field. Both sides are
    // observed; the source is consumed here so it is not read as a status line.
    if (code.includes("R") || code.includes("C")) {
      const source = fields[index + 1];
      index += 1;
      if (source !== undefined && source !== "") {
        const sourceDigest = digestOf(worktreePath, source);
        if (sourceDigest === null) return { ok: false, reason: "a tracked path could not be read" };
        trackedChanges.push({ path: source, sha256: sourceDigest });
      }
    }
    const digest = digestOf(worktreePath, path);
    if (digest === null) return { ok: false, reason: "a tracked path could not be read" };
    trackedChanges.push({ path, sha256: digest });
  }

  trackedChanges.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  untrackedPaths.sort();
  return {
    ok: true,
    observation: {
      head: baseHead,
      trackedChanges: Object.freeze(trackedChanges.map((entry) => Object.freeze({ ...entry }))),
      untrackedPaths: Object.freeze([...untrackedPaths]),
    },
  };
}

/**
 * The digest of what is at `path` **now**, or null if it could not be read.
 *
 * A **deleted** file digests the sha256 of no bytes. That is not a fallback: a
 * deletion is an observed path, and "there is nothing here" is a fact this
 * function can establish — `ENOENT` is the answer, not a failure to get one.
 *
 * **Every other read failure returns null and refuses the observation.** A
 * permission error or an unreadable file must not become the digest of the
 * empty string, because that is indistinguishable from a deletion and would
 * quietly report a file this observer never actually saw.
 *
 * A plain read, not a `git diff`: the digest is of the file's own bytes, and
 * digesting a *diff* would make the value depend on what it is being compared
 * against rather than on what is there. Reading is all this does — `L-C-4b`
 * asserts nothing here can write, unlink, rename or remove.
 */
function digestOf(worktreePath: string, path: string): string | null {
  try {
    return sha256(readFileSync(join(worktreePath, path)));
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return sha256(Buffer.alloc(0));
    return null;
  }
}
