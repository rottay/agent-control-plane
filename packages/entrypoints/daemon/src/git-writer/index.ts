import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isCanonicalInstant } from "@acp/contracts";

import { createGitObserver } from "../git-observer/index.js";
import { commitObject } from "../tree-hasher/index.js";
import { RUNNER_BOUNDS } from "../verification-runner/index.js";

import type {
  AdmissionOutcome,
  AdmittedRepository,
  CommitEffectInput,
  CommitEffectOutcome,
  CommitterIdentity,
  GitWriteOutcome,
  GitWriteRequest,
  GitWriterRefusal,
  GitWriterRefused,
  GitWriterVerb,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and are
 * re-exported here unchanged (owner law §7).
 */
export type {
  AdmissionOutcome,
  AdmittedRepository,
  CommitEffectInput,
  CommitEffectOutcome,
  CommitterIdentity,
  FencePort,
  GitWriteOutcome,
  GitWriteRequest,
  GitWriterRefusal,
  GitWriterRefused,
  GitWriterVerb,
} from "./types/index.js";

/**
 * The Git writer -- P-17/B, ADR 0127 (decisions 248-250).
 *
 * The plane's sixth spawn site, and the only one that writes to a repository. It can
 * write objects, one commit and one compare-and-set of one branch, and nothing else, and
 * only inside a **disposable repository**: operational Git writing is off
 * (`OPERATIONAL_GIT_WRITING` is `false`, a frozen literal), and while it is off a target
 * is admitted only when its real path is strictly under the checkout's own `.acp-local/`
 * (ND-10 (b), B-5). The checkout root is derived here, with the daemon `paths` module's
 * own expression, and never taken from a caller (B-4).
 *
 * ## What it can run
 *
 * Three plumbing verbs, a closed constant checked **before** anything is spawned:
 * `hash-object` (every blob and every tree, one spawn each, the id Git prints held to the
 * one the tree hasher computed), `commit-tree` (the message on stdin, its printed id held
 * to the hasher's commit object id) and `update-ref <ref> <new> <old>` (always three
 * operands, held at `gitWrite` itself: the admitted branch and two object ids, so a
 * delete or a two-operand overwrite is refused before any spawn, and a lost
 * compare-and-set never moves the ref). Every read -- the object format,
 * the toplevel, HEAD, the diff of NB-2, the read-back -- goes through the one git read
 * authority, `createGitObserver`, so this file names no read verb and the observer names
 * no write verb. No porcelain, no index, no network verb is representable here.
 *
 * ## What the environment and the repository cannot decide
 *
 * `/usr/bin/git` by absolute path, `shell: false`, an environment **built** from
 * constants (no `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, a ceiling
 * at the repository's parent) plus the two dates, and a fixed `-c` prefix on **every**
 * spawn: hooks off (`core.hooksPath=/dev/null`), unsigned (`commit.gpgSign=false`), no
 * implicit identity (`user.useConfigOnly=true`), UTF-8 (`i18n.commitEncoding=UTF-8`, so a
 * repository-local encoding adds no header), and the injected identity on the six keys
 * Git reads (`user.*`, `author.*`, `committer.*`): a repository-local `author.name` or
 * `committer.email` would otherwise override `user.*`, and `update-ref` would otherwise
 * write its reflog entry under the host's implicit identity (B-1). The dates are the
 * recorded `authorized_at`, floored to its second, as `@<seconds> +0000` (ND-11): this
 * module reads no clock.
 *
 * ## The effect, in order
 *
 * The caller has already held the authorization in force (the one predicate, with base,
 * tree, write-set and policy revalidated). Then: the blobs and the trees, each id
 * checked; NB-2, every path of `diff --raw -z --no-renames <base> <tree>` in the declared
 * write-set, before any commit object exists; `commit-tree`, its id checked; the fence
 * port; `update-ref`; and the ref read back through the observer. A nonzero
 * `update-ref` is classified by the read-back (ND-13): the base is `GIT_WRITER_REF_UNCHANGED`,
 * another commit `GIT_WRITER_REF_MOVED`, no answer `GIT_WRITER_REF_OUTCOME_UNKNOWN`. A
 * nonzero `commit-tree` is `GIT_WRITER_COMMIT_FAILED` (a NUL in a body, which Git
 * refuses, lands here). None of these moves a ledger row: that is P-17/C's.
 *
 * ## Stated limits
 *
 * The writer never writes the index, so after the compare-and-set the disposable
 * repository's index still names the base tree (ND-14). There is no operating system
 * sandbox (P-25). Between the fence check and `update-ref` there is a window, closed by
 * the ref's own compare-and-set against the base (ND-9). Stderr is never read.
 */

/** The closed vocabulary, sorted. */
export const GIT_WRITER_REFUSALS = [
  "BASE_HEAD_MISSING",
  "GIT_WRITER_AUTHORIZATION_REFUSED",
  "GIT_WRITER_BOUND_EXCEEDED",
  "GIT_WRITER_COMMIT_FAILED",
  "GIT_WRITER_FENCE_REFUSED",
  "GIT_WRITER_HEAD_DETACHED",
  "GIT_WRITER_IDENTITY_INVALID",
  "GIT_WRITER_INPUT_INVALID",
  "GIT_WRITER_NOT_IN_FORCE",
  "GIT_WRITER_OBJECT_MISMATCH",
  "GIT_WRITER_OBJECT_WRITE_FAILED",
  "GIT_WRITER_OBSERVATION_FAILED",
  "GIT_WRITER_OPERATIONAL_DISABLED",
  "GIT_WRITER_RECEIPT_ABSENT",
  "GIT_WRITER_RECEIPT_MISMATCH",
  "GIT_WRITER_RECEIPT_UNREADABLE",
  "GIT_WRITER_RECORD_REFUSED",
  "GIT_WRITER_REF_MOVED",
  "GIT_WRITER_REF_OUTCOME_UNKNOWN",
  "GIT_WRITER_REF_UNCHANGED",
  "GIT_WRITER_TASK_STATE",
  "GIT_WRITER_TASK_UNREADABLE",
  "GIT_WRITER_TREE_OUTSIDE_WRITE_SET",
  "GIT_WRITER_TREE_UNREADABLE",
  "GIT_WRITER_VERB_DENIED",
  "GIT_WRITER_VERDICT_ABSENT",
  "OBJECT_FORMAT_UNSUPPORTED",
] as const;

/**
 * Operational Git writing: off. A frozen literal, and the fence reads it as one. Turning
 * it on is never this cut's act: it waits for P-18's recovery minimum and a separate
 * owner act (contracts §12; parallelism "No habilitar escritura operativa antes de
 * P-18/recuperación").
 */
export const OPERATIONAL_GIT_WRITING = false as boolean;

/** The three plumbing verbs, and nothing else. Checked before any spawn. */
export const GIT_WRITER_VERBS = Object.freeze(["commit-tree", "hash-object", "update-ref"] as const);

/** The binary and its bounds: the observer's reasoning, restated for the writer. */
const GIT_BINARY = "/usr/bin/git";
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * The checkout root, derived with the daemon `paths` module's own expression (B-4): this
 * file sits at `src/<module>/index.ts`, the same depth, so five steps up is the root. No
 * caller names it.
 */
const HERE = resolve(fileURLToPath(import.meta.url), "..");
const CHECKOUT_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

/** The one directory a disposable repository may live under while writing is off. */
const DISPOSABLE_DIRECTORY = ".acp-local";

/** A sha1 object id, and nothing that merely looks like one. */
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

/** A branch, as HEAD names it. */
const BRANCH_REF = /^refs\/heads\/[^\s\0]+$/;

/** An email on an RFC 2606 `.invalid` domain: the one shape admitted while writing is off. */
const INVALID_EMAIL = /^[^\s<>@\0]+@(?:[A-Za-z0-9-]+\.)+invalid$/;

/** A name Git writes as given: no angle bracket, line break or NUL, and no crud at either end. */
const COMMITTER_NAME = /^[A-Za-z0-9](?:[^<>\n\r\0]*[A-Za-z0-9])?$/;

/** Only a value `admitRepository` produced is admitted. */
const ADMITTED = new WeakSet<AdmittedRepository>();

/** Write spawns made by this module, for the suites' "zero spawns" assertions. */
let writeSpawns = 0;

/** How many write spawns this module has made since it was loaded. */
export function gitWriterSpawnCount(): number {
  return writeSpawns;
}

function refuse(refusal: GitWriterRefusal, at: string, word: string | null = null): GitWriterRefused {
  return Object.freeze({ ok: false as const, refusal, at, word });
}

/** Whether `inner` is strictly below `outer`, by path components. */
function strictlyUnder(inner: string, outer: string): boolean {
  return inner !== outer && inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/**
 * The injected identity, admitted, or the reason it is not (ND-ID). No default: an
 * absent identity is refused. While operational writing is off the email must be on an
 * `.invalid` domain, so "non-personal" is structural rather than a convention.
 */
export function admitIdentity(identity: unknown): GitWriterRefused | null {
  if (typeof identity !== "object" || identity === null) return refuse("GIT_WRITER_IDENTITY_INVALID", "identity");
  const { name, email } = identity as { readonly name?: unknown; readonly email?: unknown };
  if (typeof name !== "string" || !COMMITTER_NAME.test(name)) return refuse("GIT_WRITER_IDENTITY_INVALID", "identity.name");
  if (typeof email !== "string" || email.includes("\n") || email.includes("\0")) {
    return refuse("GIT_WRITER_IDENTITY_INVALID", "identity.email");
  }
  if (!OPERATIONAL_GIT_WRITING && !INVALID_EMAIL.test(email)) return refuse("GIT_WRITER_IDENTITY_INVALID", "identity.email");
  return null;
}

/**
 * Whether a git directory writes only into itself (V-1), with zero spawns: no
 * `commondir` (which would send refs and objects to another repository's `.git`),
 * `refs/`, `refs/heads/` and `objects/` real directories rather than links, and `HEAD`
 * and `packed-refs` (when present) not links. Throws on an unreadable entry; the
 * caller's catch refuses.
 */
function gitDirectoryIsItsOwn(gitDirectory: string): boolean {
  if (lstatOrNull(join(gitDirectory, "commondir")) !== null) return false;
  for (const name of ["refs", join("refs", "heads"), "objects"]) {
    const entry = lstatSync(join(gitDirectory, name));
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
  }
  if (lstatSync(join(gitDirectory, "HEAD")).isSymbolicLink()) return false;
  const packed = lstatOrNull(join(gitDirectory, "packed-refs"));
  return packed?.isSymbolicLink() !== true;
}

/** An entry's own status, or null when it does not exist. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Admit a disposable repository, or refuse by name (ND-10 (b), ND-14; A9).
 *
 * Pure first, with **zero spawns**: an absolute, resolved path whose real path is
 * strictly under the checkout's real `.acp-local/` (so never the checkout, never a
 * sibling repository, never a path under the operating system's temporary directory),
 * with a `.git` of its own that is a real directory (not a file, a gitlink or a link),
 * holding no `commondir` and no linked `refs/`, `refs/heads/`, `objects/`, `HEAD` or
 * `packed-refs` (V-1). Anything else is `GIT_WRITER_OPERATIONAL_DISABLED`. Then through
 * the observer: the object format `sha1` (`OBJECT_FORMAT_UNSUPPORTED`), the target is its
 * repository's toplevel, the git directory and the common directory Git resolves are
 * both its own `.git` (`GIT_WRITER_OPERATIONAL_DISABLED`), HEAD is born (`BASE_HEAD_MISSING`, asked first: `--symbolic-full-name` fails
 * on an unborn HEAD) and names a branch (`GIT_WRITER_HEAD_DETACHED`).
 */
export function admitRepository(target: unknown): AdmissionOutcome {
  if (typeof target !== "string" || !isAbsolute(target) || resolve(target) !== target) {
    return refuse("GIT_WRITER_INPUT_INVALID", "repository");
  }
  let repository: string;
  try {
    repository = realpathSync(target);
    const checkout = realpathSync(CHECKOUT_ROOT);
    const disposable = realpathSync(join(checkout, DISPOSABLE_DIRECTORY));
    if (OPERATIONAL_GIT_WRITING || !strictlyUnder(repository, disposable)) {
      return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "repository");
    }
    if (repository === checkout || strictlyUnder(checkout, repository)) {
      return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "repository");
    }
    const dotGit = lstatSync(join(repository, ".git"));
    if (dotGit.isSymbolicLink() || !dotGit.isDirectory()) return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "repository");
    if (!gitDirectoryIsItsOwn(join(repository, ".git"))) return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "repository");
  } catch {
    return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "repository");
  }

  const git = createGitObserver(repository);
  const format = git({ verb: "rev-parse", args: ["--show-object-format"] });
  if (!format.ok) return refuse("GIT_WRITER_OBSERVATION_FAILED", "objectFormat");
  if (format.stdout.trim() !== "sha1") return refuse("OBJECT_FORMAT_UNSUPPORTED", "objectFormat");
  const toplevel = git({ verb: "rev-parse", args: ["--show-toplevel"] });
  if (!toplevel.ok) return refuse("GIT_WRITER_OBSERVATION_FAILED", "toplevel");
  try {
    if (realpathSync(toplevel.stdout.replace(/\n$/, "")) !== repository) return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "repository");
  } catch {
    return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "repository");
  }
  // Where Git will write, not only where `.git` is (V-1): the git directory and the
  // common directory Git resolves are both the repository's own `.git`.
  const directories = git({ verb: "rev-parse", args: ["--path-format=absolute", "--git-dir", "--git-common-dir"] });
  if (!directories.ok) return refuse("GIT_WRITER_OBSERVATION_FAILED", "gitDir");
  const resolved = directories.stdout.split("\n").filter((line) => line !== "");
  try {
    const own = realpathSync(join(repository, ".git"));
    if (resolved.length !== 2 || !resolved.every((path) => realpathSync(path) === own)) {
      return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "repository");
    }
  } catch {
    return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "repository");
  }
  const head = git({ verb: "rev-parse", args: ["--verify", "-q", "HEAD"] });
  if (!head.ok) return refuse("BASE_HEAD_MISSING", "head");
  const headSha = head.stdout.trim();
  if (!GIT_OBJECT_ID.test(headSha)) return refuse("GIT_WRITER_OBSERVATION_FAILED", "head");
  const symbolic = git({ verb: "rev-parse", args: ["--symbolic-full-name", "HEAD"] });
  if (!symbolic.ok) return refuse("GIT_WRITER_OBSERVATION_FAILED", "ref");
  const ref = symbolic.stdout.trim();
  if (ref === "HEAD" || !BRANCH_REF.test(ref)) return refuse("GIT_WRITER_HEAD_DETACHED", "ref");

  const admitted: AdmittedRepository = Object.freeze({ repository, ref, head: headSha });
  ADMITTED.add(admitted);
  return { ok: true, admitted };
}

/** The recorded instant as Git's date: its second, floored, at `+0000` (ND-11). */
export function gitDateOf(authorizedAt: string): string {
  return "@" + String(Math.floor(Date.parse(authorizedAt) / 1000)) + " +0000";
}

/**
 * The environment of every writer spawn: one frozen literal of constants, the ceiling at
 * the repository's parent, and the two dates when a date is recorded. No `HOME`, no
 * identity variable, nothing inherited.
 */
function writerEnvironment(repository: string, date: string | null): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: dirname(repository),
    ...(date === null ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
  });
}

/** The fixed prefix of every writer spawn, the identity on all six keys Git reads (B-1). */
function writerPrefix(identity: CommitterIdentity): readonly string[] {
  return Object.freeze([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "user.useConfigOnly=true",
    "-c",
    "core.quotePath=false",
    "-c",
    "i18n.commitEncoding=UTF-8",
    "-c",
    "user.name=" + identity.name,
    "-c",
    "user.email=" + identity.email,
    "-c",
    "author.name=" + identity.name,
    "-c",
    "author.email=" + identity.email,
    "-c",
    "committer.name=" + identity.name,
    "-c",
    "committer.email=" + identity.email,
  ]);
}

function isWriterVerb(value: unknown): value is GitWriterVerb {
  return typeof value === "string" && (GIT_WRITER_VERBS as readonly string[]).includes(value);
}

/**
 * `update-ref` only as a compare-and-set of the admitted branch (A4, N-a): exactly three
 * operands, the admitted ref, a new id and an old id, so no delete (`-d`), no `--stdin`
 * and no two-operand overwrite is representable at the spawn boundary.
 */
function isCompareAndSet(args: readonly string[], ref: string): boolean {
  const [target, next, old] = args;
  return args.length === 3 && target === ref && BRANCH_REF.test(ref) && next !== undefined && GIT_OBJECT_ID.test(next) && old !== undefined && GIT_OBJECT_ID.test(old);
}

/**
 * One writer spawn, or a refusal before it. The verb is checked against the closed set
 * first (`GIT_WRITER_VERB_DENIED`), the repository must be one `admitRepository`
 * produced, and the identity is admitted again: a denied request never reaches the
 * process boundary.
 */
export function gitWrite(request: GitWriteRequest): GitWriteOutcome {
  if (!isWriterVerb(request.verb)) return { ok: false, refusal: "GIT_WRITER_VERB_DENIED", at: "verb", status: null };
  if (!ADMITTED.has(request.admitted)) return { ok: false, refusal: "GIT_WRITER_OPERATIONAL_DISABLED", at: "admitted", status: null };
  if (admitIdentity(request.identity) !== null) return { ok: false, refusal: "GIT_WRITER_IDENTITY_INVALID", at: "identity", status: null };
  for (const argument of request.args) {
    if (typeof argument !== "string" || argument === "-c" || argument.startsWith("--exec-path")) {
      return { ok: false, refusal: "GIT_WRITER_INPUT_INVALID", at: "args", status: null };
    }
  }
  // Every verb that is not an object write is the ref verb, and runs only as a compare-and-set.
  if (request.verb !== "hash-object" && request.verb !== "commit-tree" && !isCompareAndSet(request.args, request.admitted.ref)) {
    return { ok: false, refusal: "GIT_WRITER_INPUT_INVALID", at: "args", status: null };
  }
  let date: string | null = null;
  if (request.authorizedAt !== null) {
    if (!isCanonicalInstant(request.authorizedAt)) return { ok: false, refusal: "GIT_WRITER_INPUT_INVALID", at: "authorizedAt", status: null };
    date = gitDateOf(request.authorizedAt);
  }
  writeSpawns += 1;
  const result = spawnSync(GIT_BINARY, [...writerPrefix(request.identity), request.verb, ...request.args], {
    cwd: request.admitted.repository,
    env: writerEnvironment(request.admitted.repository, date),
    input: request.stdin,
    encoding: "buffer",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, refusal: "GIT_WRITER_OBJECT_WRITE_FAILED", at: request.verb, status: result.status };
  }
  return { ok: true, stdout: result.stdout.toString("utf8") };
}

/** The paths of a NUL-separated raw diff: each record is a `:`-header followed by its path. */
function rawDiffPaths(stdout: string): readonly string[] | null {
  const fields = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field === "") continue;
    if (!field.startsWith(":")) return null;
    const path = fields[index + 1];
    if (path === undefined || path === "") return null;
    paths.push(path);
    index += 1;
  }
  return paths;
}

/**
 * Write the objects, check NB-2, write the commit, ask the fence and compare-and-set the
 * branch; then read the ref back (B-2's order). The caller has held the authorization in
 * force immediately before; everything here that refuses before `update-ref` leaves the
 * ref where it was.
 */
export function commitAndCompareAndSet(input: CommitEffectInput): CommitEffectOutcome {
  const { admitted, identity } = input;
  if (!ADMITTED.has(admitted)) return refuse("GIT_WRITER_OPERATIONAL_DISABLED", "admitted");
  const invalid = admitIdentity(identity);
  if (invalid !== null) return invalid;
  if (!isCanonicalInstant(input.authorizedAt)) return refuse("GIT_WRITER_INPUT_INVALID", "authorizedAt");
  if (!GIT_OBJECT_ID.test(input.baseSha) || !GIT_OBJECT_ID.test(input.treeSha)) return refuse("GIT_WRITER_INPUT_INVALID", "objects");
  const root = input.trees.at(-1);
  if (root?.sha1 !== input.treeSha) return refuse("GIT_WRITER_OBJECT_MISMATCH", "treeSha");
  let bytes = 0;
  for (const blob of input.blobs) bytes += blob.bytes.length;
  if (input.blobs.length > RUNNER_BOUNDS.copyFileCount || bytes > RUNNER_BOUNDS.copyTotalBytes) {
    return refuse("GIT_WRITER_BOUND_EXCEEDED", "blobs");
  }

  // 1. Every blob and every tree, one spawn each; the printed id is the hasher's (ND-5, ND-6).
  for (const [index, blob] of input.blobs.entries()) {
    const at = "blobs[" + String(index) + "]";
    const written = gitWrite({ admitted, identity, verb: "hash-object", args: ["-w", "--no-filters", "--stdin"], stdin: blob.bytes, authorizedAt: null });
    if (!written.ok) return refuse(written.refusal, at);
    if (written.stdout.trim() !== blob.sha1) return refuse("GIT_WRITER_OBJECT_MISMATCH", at);
  }
  for (const [index, tree] of input.trees.entries()) {
    const at = "trees[" + String(index) + "]";
    const written = gitWrite({ admitted, identity, verb: "hash-object", args: ["-w", "-t", "tree", "--stdin"], stdin: tree.body, authorizedAt: null });
    if (!written.ok) return refuse(written.refusal, at);
    if (written.stdout.trim() !== tree.sha1) return refuse("GIT_WRITER_OBJECT_MISMATCH", at);
  }

  // 2. NB-2: every path the tree changes against the base is declared, before any commit exists (ND-8).
  const git = createGitObserver(admitted.repository);
  const diff = git({ verb: "diff", args: ["--raw", "-z", "--no-renames", input.baseSha, input.treeSha] });
  if (!diff.ok) return refuse("GIT_WRITER_OBSERVATION_FAILED", "diff");
  const changed = rawDiffPaths(diff.stdout);
  if (changed === null) return refuse("GIT_WRITER_OBSERVATION_FAILED", "diff");
  const declared = new Set(input.writeSet);
  for (const [index, path] of changed.entries()) {
    if (!declared.has(path)) return refuse("GIT_WRITER_TREE_OUTSIDE_WRITE_SET", "diff[" + String(index) + "]");
  }

  // 3. The commit object, its id held to the one the hasher computes (ND-12).
  const expected = commitObject({
    treeSha: input.treeSha,
    parentSha: input.baseSha,
    name: identity.name,
    email: identity.email,
    seconds: Math.floor(Date.parse(input.authorizedAt) / 1000),
    message: input.message,
  });
  const committed = gitWrite({
    admitted,
    identity,
    verb: "commit-tree",
    args: [input.treeSha, "-p", input.baseSha],
    stdin: Buffer.from(input.message, "utf8"),
    authorizedAt: input.authorizedAt,
  });
  if (!committed.ok) return refuse(committed.refusal === "GIT_WRITER_OBJECT_WRITE_FAILED" ? "GIT_WRITER_COMMIT_FAILED" : committed.refusal, "commitObject");
  const commitSha = committed.stdout.trim();
  if (commitSha !== expected.sha1) return refuse("GIT_WRITER_OBJECT_MISMATCH", "commitObject");

  // 4. The fence, immediately before the ref moves (ND-9).
  const fence = input.fence();
  if (!fence.ok) return refuse("GIT_WRITER_FENCE_REFUSED", "fence", fence.reason);

  // 5. The compare-and-set, always with its old operand, and the ref read back (A4, ND-13).
  const moved = gitWrite({ admitted, identity, verb: "update-ref", args: [admitted.ref, commitSha, input.baseSha], stdin: Buffer.alloc(0), authorizedAt: input.authorizedAt });
  const readBack = git({ verb: "rev-parse", args: ["--verify", "-q", admitted.ref] });
  const now = readBack.ok ? readBack.stdout.trim() : null;
  if (now === null || !GIT_OBJECT_ID.test(now)) return refuse("GIT_WRITER_REF_OUTCOME_UNKNOWN", "ref");
  if (!moved.ok) {
    if (now === input.baseSha) return refuse("GIT_WRITER_REF_UNCHANGED", "ref");
    if (now === commitSha) return refuse("GIT_WRITER_REF_OUTCOME_UNKNOWN", "ref");
    return refuse("GIT_WRITER_REF_MOVED", "ref");
  }
  if (now !== commitSha) return refuse("GIT_WRITER_REF_MOVED", "ref");
  return Object.freeze({ ok: true as const, commitSha: now, treeSha: input.treeSha, baseSha: input.baseSha, ref: admitted.ref });
}
