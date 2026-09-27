/**
 * The value types of the tree hasher (P-16/C, ADR 0123; P-17/B, ADR 0127).
 *
 * The entry a tree is built from, the index entry the observer's `ls-files -s -z`
 * yields, the outcomes, and since P-17/B the objects a writer needs (a tree object's
 * body, a worktree blob with the bytes that were hashed, a commit object's parts): the
 * declarations this concept owns, in the concept's own leaf. A pure type leaf: it declares data, imports only types, and `../index.ts`
 * re-exports every one.
 */

import type { TREE_HASH_REFUSALS } from "../index.js";

export type TreeHashRefusal = (typeof TREE_HASH_REFUSALS)[number];

/** The three blob modes a tree may hold: a file, an executable file and a symbolic link. */
export type TreeBlobMode = "100644" | "100755" | "120000";

/** One blob of a tree: its repository-relative path, its mode and its sha1 object id. */
export interface TreeEntry {
  readonly path: string;
  readonly mode: TreeBlobMode;
  readonly sha1: string;
}

/** A refusal by name. `at` names the argument and its index, never a path's value. */
export interface TreeHashRefused {
  readonly ok: false;
  readonly refusal: TreeHashRefusal;
  readonly at: string;
}

/**
 * One index record as `ls-files -s` states it: the path, its mode and its object id
 * (P-16/D1, ND-12). The mode is carried as written; the runner compares it and the id
 * with the copy's own entry.
 */
export interface IndexEntry {
  readonly path: string;
  readonly mode: string;
  readonly sha1: string;
}

/**
 * The index's paths, stage 0 and no gitlink, in the order the index lists them, and
 * the same records with their modes and object ids.
 */
export type IndexPathsOutcome =
  | { readonly ok: true; readonly paths: readonly string[]; readonly entries: readonly IndexEntry[] }
  | TreeHashRefused;

/** The tree of a copy: its sha1 tree id and the entries it was built from, in path order. */
export type CopyTreeOutcome =
  | { readonly ok: true; readonly treeSha: string; readonly entries: readonly TreeEntry[] }
  | TreeHashRefused;

/** One object as Git stores it: its sha1 id and its body, without the type header (P-17/B). */
export interface GitObject {
  readonly sha1: string;
  readonly body: Buffer;
}

/** Every tree object of a tree, children first and the root last, and the root's id (P-17/B). */
export type TreeObjectsOutcome =
  | { readonly ok: true; readonly treeSha: string; readonly trees: readonly GitObject[] }
  | TreeHashRefused;

/** One blob of a worktree, read once: its entry and the bytes that were hashed. */
export interface WorktreeBlob extends TreeEntry {
  readonly bytes: Buffer;
}

/** A worktree's tree: its id, its blobs in path order with their bytes, and its tree objects. */
export type WorktreeTreeOutcome =
  | {
      readonly ok: true;
      readonly treeSha: string;
      readonly blobs: readonly WorktreeBlob[];
      readonly trees: readonly GitObject[];
    }
  | TreeHashRefused;

/** What one commit object is made of (P-17/B, ND-11, ND-12). */
export interface CommitObjectInput {
  readonly treeSha: string;
  readonly parentSha: string;
  readonly name: string;
  readonly email: string;
  /** The recorded `authorized_at`, floored to its second. */
  readonly seconds: number;
  /** The message's exact bytes: the body and its one trailer. */
  readonly message: string;
}
