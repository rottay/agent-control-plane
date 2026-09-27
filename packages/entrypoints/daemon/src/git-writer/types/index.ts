/**
 * The value types of the Git writer (P-17/B, ADR 0127; decision 248).
 *
 * The injected committer identity, the admitted disposable repository, one write
 * request, the fence port the effect calls before `update-ref`, and the outcomes: the
 * declarations this concept owns, in the concept's own leaf (owner law §7). A pure type
 * leaf: it declares data, imports only types, and `../index.ts` re-exports every one.
 */

import type { GitObject, WorktreeBlob } from "../../tree-hasher/index.js";
import type { GIT_WRITER_REFUSALS, GIT_WRITER_VERBS } from "../index.js";

export type GitWriterRefusal = (typeof GIT_WRITER_REFUSALS)[number];

export type GitWriterVerb = (typeof GIT_WRITER_VERBS)[number];

/**
 * The committer identity, injected and never defaulted (ND-ID). While operational
 * writing is off it is a synthetic, non-personal label on an RFC 2606 `.invalid` domain.
 */
export interface CommitterIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * A repository the writer admitted: its real path, the branch HEAD names and HEAD's
 * commit, read through the observer. Only `admitRepository` produces one; a value that
 * merely has this shape is not admitted.
 */
export interface AdmittedRepository {
  readonly repository: string;
  readonly ref: string;
  readonly head: string;
}

/** A refusal by name: the word, the argument that failed, and a carried word or null. */
export interface GitWriterRefused {
  readonly ok: false;
  readonly refusal: GitWriterRefusal;
  readonly at: string;
  readonly word: string | null;
}

export type AdmissionOutcome = { readonly ok: true; readonly admitted: AdmittedRepository } | GitWriterRefused;

/** One writer spawn, as a value: the verb is checked against the closed set before anything runs. */
export interface GitWriteRequest {
  readonly admitted: AdmittedRepository;
  readonly identity: CommitterIdentity;
  readonly verb: string;
  readonly args: readonly string[];
  readonly stdin: Buffer;
  /** The recorded `authorized_at`, bound to both date variables, or null for a spawn that records no date. */
  readonly authorizedAt: string | null;
}

export type GitWriteOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly refusal: GitWriterRefusal; readonly at: string; readonly status: number | null };

/**
 * The fence port (ND-9): called once, immediately before `update-ref`. Its production
 * binding is the walk's `LeaseHold.renew()`; a refusal carries the arbiter's word.
 */
export type FencePort = () => { readonly ok: boolean; readonly reason: string | null };

/** What the effect writes: the objects of one tree read once, the commit's parts, and the fence. */
export interface CommitEffectInput {
  readonly admitted: AdmittedRepository;
  readonly identity: CommitterIdentity;
  /** The row's recorded instant: the commit's two dates and the reflog's. */
  readonly authorizedAt: string;
  /** The receipt's base, revalidated as HEAD's commit. */
  readonly baseSha: string;
  /** The receipt's tree, revalidated as the tree read now. */
  readonly treeSha: string;
  readonly blobs: readonly WorktreeBlob[];
  /** Children first, the root last. */
  readonly trees: readonly GitObject[];
  /** The envelope's declared write-set: every path of the tree's diff against the base must be in it (NB-2). */
  readonly writeSet: readonly string[];
  /** The body and its one trailer, exactly as `commitMessageWithReceiptTrailer` builds them. */
  readonly message: string;
  readonly fence: FencePort;
}

export type CommitEffectOutcome =
  | {
      readonly ok: true;
      /** Read back from the ref, never taken from `commit-tree`'s output. */
      readonly commitSha: string;
      readonly treeSha: string;
      readonly baseSha: string;
      readonly ref: string;
    }
  | GitWriterRefused;
