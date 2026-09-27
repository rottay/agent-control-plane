import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import type {
  CommitObjectInput,
  CopyTreeOutcome,
  GitObject,
  IndexEntry,
  IndexPathsOutcome,
  TreeBlobMode,
  TreeEntry,
  TreeHashRefusal,
  TreeHashRefused,
  TreeObjectsOutcome,
  WorktreeBlob,
  WorktreeTreeOutcome,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and are
 * re-exported here unchanged (owner law §7).
 */
export type {
  CommitObjectInput,
  CopyTreeOutcome,
  GitObject,
  IndexEntry,
  IndexPathsOutcome,
  TreeBlobMode,
  TreeEntry,
  TreeHashRefusal,
  TreeHashRefused,
  TreeObjectsOutcome,
  WorktreeBlob,
  WorktreeTreeOutcome,
} from "./types/index.js";

/**
 * The tree hasher — P-16/C, ADR 0123 (decisions 227, 235).
 *
 * The receipt's `treeSha` is the git tree id of the bytes the checks ran over. This
 * module computes it **in process**: the sha1 of each blob object
 * (`"blob " + length + "\0" + bytes`) and of each tree object (`"tree " + length +
 * "\0"` + its entries), in git's own entry order. It spawns nothing and runs no Git,
 * and it can write nothing: it reads a copy with no-follow and returns a value
 * (L-P16C-2). The oracle that proves it is the test's, a `git write-tree` over the
 * same content in a disposable repository, for every fixture shape.
 *
 * ## What a tree may hold
 *
 * Three blob modes: `100644` (a regular file), `100755` (a regular file whose owner
 * may execute it: git keeps only that bit) and `120000` (a symbolic link, whose blob
 * is the link's target bytes, never what it points at). Anything else is refused by
 * name, `TREE_ENTRY_UNSUPPORTED`: a gitlink (`160000`, a submodule), a FIFO, a socket,
 * a device, or a path under a parent that is itself a link, which would read outside
 * the tree. A conflicted index (any stage but 0) is `TREE_INDEX_CONFLICTED`: there is
 * no one tree to name. A path this module cannot state as git's bytes -- empty, a
 * `.`, `..` or `.git` component, a leading or doubled `/`, or one that arrived through
 * the observer's UTF-8 decoding as a replacement character (a name that was not valid
 * UTF-8) -- is `TREE_PATH_UNSUPPORTED`, never hashed from a mangled name.
 *
 * ## The order
 *
 * Git sorts a tree's entries by their name bytes, with a tree's name compared as if
 * it ended in `/`: `a-b` (0x2d), then `a.b` (0x2e), then the tree `a` (as `a/`, 0x2f),
 * then `a0` (0x30). Compared as `Buffer`s, bytewise, never as JavaScript
 * strings, whose code-unit order differs from UTF-8's above the BMP.
 *
 * ## The objects a writer needs (P-17/B, ADR 0127)
 *
 * The Git writer writes exactly the objects this module names, and checks every id Git
 * prints against the id computed here: `treeObjects` gives each tree object's body and
 * id, children first; `readWorktreeTree` reads a worktree's blobs **once** and returns
 * their bytes beside their ids, so the bytes written are the bytes hashed; and
 * `commitObject` gives the exact body and id of the one commit object a recorded
 * authorization names (`tree`, one `parent`, `author` and `committer` with the recorded
 * second at `+0000`, a blank line, the message's bytes). Still no spawn and no write:
 * the writer is `git-writer`'s.
 *
 * ## One object format
 *
 * sha1 only. A repository in another format is refused before this module is reached
 * (`OBJECT_FORMAT_UNSUPPORTED`, the runner's), and P-38 owns sha256.
 */

/**
 * The hasher's closed vocabulary, sorted. Every refusal names the argument that
 * failed, never a value.
 */
export const TREE_HASH_REFUSALS = ["TREE_ENTRY_UNSUPPORTED", "TREE_INDEX_CONFLICTED", "TREE_PATH_UNSUPPORTED"] as const;

/** The mode of a tree object inside its parent: git writes it without a leading zero. */
const TREE_MODE = "40000";

/** The three blob modes, as a list a caller's value is checked against at run time. */
const BLOB_MODES: readonly string[] = Object.freeze(["100644", "100755", "120000"]);

/** The mode of a gitlink, which no tree this plane names may hold. */
const GITLINK_MODE = "160000";

/** The owner-execute bit, the one permission bit git keeps. */
const OWNER_EXECUTE = 0o100;

/** A sha1 object id, as the index lists it. */
const SHA1_OBJECT_ID = /^[0-9a-f]{40}$/;

/** What the observer's UTF-8 decoding leaves where a byte was not UTF-8. */
const REPLACEMENT_CHARACTER = "�";

function refuse(refusal: TreeHashRefusal, at: string): TreeHashRefused {
  return Object.freeze({ ok: false as const, refusal, at });
}

function objectSha1(kind: "blob" | "tree" | "commit", body: Buffer): string {
  return createHash("sha1")
    .update(kind + " " + String(body.length) + "\0", "utf8")
    .update(body)
    .digest("hex");
}

/** The sha1 id of one blob object over `bytes`: what `git hash-object` prints. */
export function gitBlobSha1(bytes: Buffer): string {
  return objectSha1("blob", bytes);
}

/** Whether a path can be stated as git's own bytes. */
function isTreePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes(REPLACEMENT_CHARACTER) || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");
}

interface Directory {
  readonly blobs: Map<string, TreeEntry>;
  readonly trees: Map<string, Directory>;
}

function directory(): Directory {
  return { blobs: new Map(), trees: new Map() };
}

/**
 * One tree object's body and id, its entries in git's order; every child tree is pushed
 * to `out` before its parent, so `out` ends with the root.
 */
function treeObject(node: Directory, out: GitObject[]): string {
  const entries: { readonly key: Buffer; readonly line: Buffer }[] = [];
  for (const [name, blob] of node.blobs) {
    const line = Buffer.concat([Buffer.from(blob.mode + " " + name + "\0", "utf8"), Buffer.from(blob.sha1, "hex")]);
    entries.push({ key: Buffer.from(name, "utf8"), line });
  }
  for (const [name, child] of node.trees) {
    const line = Buffer.concat([Buffer.from(TREE_MODE + " " + name + "\0", "utf8"), Buffer.from(treeObject(child, out), "hex")]);
    entries.push({ key: Buffer.from(name + "/", "utf8"), line });
  }
  entries.sort((left, right) => Buffer.compare(left.key, right.key));
  const body = Buffer.concat(entries.map((entry) => entry.line));
  const sha1 = objectSha1("tree", body);
  out.push(Object.freeze({ sha1, body }));
  return sha1;
}

/**
 * Every tree object of a set of blobs, children first and the root last, each with its
 * body and its id: what the writer hands `hash-object -t tree` one by one (P-17/B, ND-5).
 * Refused exactly as `treeSha` is, because `treeSha` is this function's root id.
 */
export function treeObjects(entries: readonly TreeEntry[]): TreeObjectsOutcome {
  const root = directory();
  for (const [index, entry] of entries.entries()) {
    const at = "entries[" + String(index) + "]";
    if (!isTreePath(entry.path)) return refuse("TREE_PATH_UNSUPPORTED", at);
    if (!BLOB_MODES.includes(entry.mode)) return refuse("TREE_ENTRY_UNSUPPORTED", at);
    if (!SHA1_OBJECT_ID.test(entry.sha1)) return refuse("TREE_ENTRY_UNSUPPORTED", at);
    const parts = entry.path.split("/");
    const name = parts.pop() ?? "";
    let node = root;
    for (const part of parts) {
      if (node.blobs.has(part)) return refuse("TREE_PATH_UNSUPPORTED", at);
      let child = node.trees.get(part);
      if (child === undefined) {
        child = directory();
        node.trees.set(part, child);
      }
      node = child;
    }
    if (node.blobs.has(name) || node.trees.has(name)) return refuse("TREE_PATH_UNSUPPORTED", at);
    node.blobs.set(name, entry);
  }
  const trees: GitObject[] = [];
  const rootSha = treeObject(root, trees);
  return { ok: true, treeSha: rootSha, trees: Object.freeze(trees) };
}

/**
 * The git tree id of a set of blobs: what `git write-tree` prints for an index holding
 * exactly these entries. Empty entries give the empty tree,
 * `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
 *
 * Refused, never coerced: a path this module cannot state, a mode outside the three,
 * an id that is not a sha1, a path listed twice, or a path that is both a blob and a
 * directory (`a` and `a/b`) is `TREE_PATH_UNSUPPORTED` or `TREE_ENTRY_UNSUPPORTED` at
 * `entries[i]`.
 */
export function treeSha(entries: readonly TreeEntry[]): { readonly ok: true; readonly treeSha: string } | TreeHashRefused {
  const objects = treeObjects(entries);
  if (!objects.ok) return objects;
  return { ok: true, treeSha: objects.treeSha };
}

/**
 * The index's paths from the observer's `ls-files -s -z` output, or a refusal.
 *
 * Each record is `<mode> <object id> <stage>\t<path>`, NUL-terminated. A stage other
 * than 0 is `TREE_INDEX_CONFLICTED`; a gitlink is `TREE_ENTRY_UNSUPPORTED`; a record
 * this parser cannot read, or a path it cannot state, is `TREE_PATH_UNSUPPORTED`. The
 * tree is hashed from the copy's bytes, the ones the checks ran over; the index's mode
 * and object id of each path are carried beside it (P-16/D1, ND-12, NB-2), so the
 * runner can hold every path the observation did not report as changed to what the
 * index says it is, before any check runs.
 */
export function indexPaths(stdout: string): IndexPathsOutcome {
  const paths: string[] = [];
  const entries: IndexEntry[] = [];
  const records = stdout.split("\0");
  for (const [index, record] of records.entries()) {
    if (record === "") continue;
    const at = "index[" + String(index) + "]";
    const tab = record.indexOf("\t");
    if (tab < 0) return refuse("TREE_PATH_UNSUPPORTED", at);
    const [mode, id, stage] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode === undefined || id === undefined || stage === undefined) return refuse("TREE_PATH_UNSUPPORTED", at);
    if (stage !== "0") return refuse("TREE_INDEX_CONFLICTED", at);
    if (mode === GITLINK_MODE) return refuse("TREE_ENTRY_UNSUPPORTED", at);
    if (!isTreePath(path)) return refuse("TREE_PATH_UNSUPPORTED", at);
    paths.push(path);
    entries.push(Object.freeze({ path, mode, sha1: id }));
  }
  return { ok: true, paths, entries: Object.freeze(entries) };
}

/**
 * The tree of a copy: every path of `paths`, read under `root` with no-follow, hashed.
 *
 * Each parent component must be a real directory, never a link; the path itself must
 * be a regular file (`100644`, or `100755` when its owner may execute it) or a symbolic
 * link (`120000`, the blob is the target's bytes). A path absent from the copy, a FIFO,
 * a socket, a device or a directory in a blob's place is `TREE_ENTRY_UNSUPPORTED` at
 * `paths[i]`; a path it cannot state is `TREE_PATH_UNSUPPORTED`. Reads only.
 */
export function hashCopyTree(root: string, paths: readonly string[]): CopyTreeOutcome {
  const entries: TreeEntry[] = [];
  for (const [index, path] of paths.entries()) {
    const at = "paths[" + String(index) + "]";
    if (!isTreePath(path)) return refuse("TREE_PATH_UNSUPPORTED", at);
    const parts = path.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      try {
        const stats = lstatSync(parent);
        if (!stats.isDirectory() || stats.isSymbolicLink()) return refuse("TREE_ENTRY_UNSUPPORTED", at);
      } catch {
        return refuse("TREE_ENTRY_UNSUPPORTED", at);
      }
    }
    const full = join(root, path);
    let mode: TreeBlobMode;
    let bytes: Buffer;
    try {
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) {
        mode = "120000";
        bytes = readlinkSync(full, { encoding: "buffer" });
      } else if (stats.isFile()) {
        mode = (stats.mode & OWNER_EXECUTE) === 0 ? "100644" : "100755";
        bytes = readFileSync(full);
      } else {
        return refuse("TREE_ENTRY_UNSUPPORTED", at);
      }
    } catch {
      return refuse("TREE_ENTRY_UNSUPPORTED", at);
    }
    entries.push({ path, mode, sha1: gitBlobSha1(bytes) });
  }
  const tree = treeSha(entries);
  if (!tree.ok) return tree;
  const ordered = [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  return { ok: true, treeSha: tree.treeSha, entries: Object.freeze(ordered.map((entry) => Object.freeze(entry))) };
}

/**
 * The blobs of a worktree, read **once** with no-follow, and its tree: the bytes the
 * writer sends to `hash-object` are the bytes this read hashed (P-17/B, ND-5).
 *
 * The runner's set: `paths` is every index path plus every observed untracked path. A
 * path that is absent, or under an absent parent, is a deletion and is not in the tree
 * (the runner's copy skips it the same way); a parent that is a link or not a directory,
 * or an entry that is neither a regular file nor a link, is `TREE_ENTRY_UNSUPPORTED`; a
 * path it cannot state is `TREE_PATH_UNSUPPORTED`. Reads only.
 */
export function readWorktreeTree(root: string, paths: readonly string[]): WorktreeTreeOutcome {
  const blobs: WorktreeBlob[] = [];
  for (const [index, path] of paths.entries()) {
    const at = "paths[" + String(index) + "]";
    if (!isTreePath(path)) return refuse("TREE_PATH_UNSUPPORTED", at);
    const parts = path.split("/");
    let parent = root;
    let absent = false;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      try {
        const stats = lstatSync(parent);
        if (!stats.isDirectory() || stats.isSymbolicLink()) return refuse("TREE_ENTRY_UNSUPPORTED", at);
      } catch (error: unknown) {
        if ((error as { code?: unknown }).code !== "ENOENT") return refuse("TREE_ENTRY_UNSUPPORTED", at);
        absent = true;
        break;
      }
    }
    if (absent) continue;
    const full = join(root, path);
    let mode: TreeBlobMode;
    let bytes: Buffer;
    try {
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) {
        mode = "120000";
        bytes = readlinkSync(full, { encoding: "buffer" });
      } else if (stats.isFile()) {
        mode = (stats.mode & OWNER_EXECUTE) === 0 ? "100644" : "100755";
        bytes = readFileSync(full);
      } else {
        return refuse("TREE_ENTRY_UNSUPPORTED", at);
      }
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code === "ENOENT") continue;
      return refuse("TREE_ENTRY_UNSUPPORTED", at);
    }
    blobs.push(Object.freeze({ path, mode, sha1: gitBlobSha1(bytes), bytes }));
  }
  const objects = treeObjects(blobs.map((blob) => ({ path: blob.path, mode: blob.mode, sha1: blob.sha1 })));
  if (!objects.ok) return objects;
  const ordered = [...blobs].sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  return { ok: true, treeSha: objects.treeSha, blobs: Object.freeze(ordered), trees: objects.trees };
}

/**
 * The one commit object a recorded authorization names: its exact body and its id
 * (P-17/B, ND-12). `tree`, one `parent`, the same identity as `author` and `committer`
 * at the recorded second `+0000`, a blank line, then the message's bytes as given --
 * no cleanup, no signature and no encoding header, which is exactly what `commit-tree`
 * writes from stdin under the writer's pinned configuration. The writer requires Git's
 * printed id to equal this one.
 */
export function commitObject(input: CommitObjectInput): GitObject {
  const person = input.name + " <" + input.email + "> " + String(input.seconds) + " +0000";
  const header =
    "tree " + input.treeSha + "\n" + "parent " + input.parentSha + "\n" + "author " + person + "\n" + "committer " + person + "\n\n";
  const body = Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(input.message, "utf8")]);
  return Object.freeze({ sha1: objectSha1("commit", body), body });
}
