/**
 * The value types of the tree hasher (P-16/C, ADR 0123).
 *
 * The entry a tree is built from, the index entry the observer's `ls-files -s -z`
 * yields, and the two outcomes: the declarations this concept owns, in the concept's
 * own leaf. A pure type leaf: it declares data, imports only types, and `../index.ts`
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

/** The index's paths, stage 0 and no gitlink, in the order the index lists them. */
export type IndexPathsOutcome = { readonly ok: true; readonly paths: readonly string[] } | TreeHashRefused;

/** The tree of a copy: its sha1 tree id and the entries it was built from, in path order. */
export type CopyTreeOutcome =
  | { readonly ok: true; readonly treeSha: string; readonly entries: readonly TreeEntry[] }
  | TreeHashRefused;
