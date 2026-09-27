/**
 * The value types of the commit writer (P-17/B, ADR 0127; decision 249).
 *
 * What the production caller of `authorizeCommit` is given, and what it answers for the
 * authorization and for the effect: the declarations this concept owns, in the concept's
 * own leaf (owner law §7). A pure type leaf: it declares data, imports only types, and
 * `../index.ts` re-exports every one.
 */

import type { ResolvedRoute } from "@acp/contracts";
import type { ArtifactPlane, Ledger } from "@acp/ledger";

import type { CommitterIdentity, FencePort, GitWriterRefused } from "../../git-writer/index.js";

/** What both halves read: the recorded task, its disposable repository and the committer. */
export interface CommitWriterInput {
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  readonly taskId: string;
  /** The route the composition elected, held to the intake's resolution. */
  readonly route: ResolvedRoute;
  /** The task's worktree: an admitted disposable repository while operational writing is off. */
  readonly repository: string;
  /** Injected, never defaulted (ND-ID). */
  readonly identity: CommitterIdentity;
}

/** The authorization half, in `AUDITING`: it records the record-form `COMMIT_AUTHORIZED`. */
export interface CommitAuthorizationInput extends CommitWriterInput {
  /** The injected clock: the instant the event will carry, which the row keeps as `authorized_at`. */
  readonly now: () => string;
  /** The event's id; a random UUID when absent. */
  readonly mintId?: () => string;
}

/** The effect half, in `READY_TO_COMMIT`: it writes the commit and moves the branch. */
export interface CommitEffectRequest extends CommitWriterInput {
  /** Called once, immediately before `update-ref` (ND-9). Production: the walk's `LeaseHold.renew`. */
  readonly fence: FencePort;
}

export type CommitAuthorizationOutcome =
  | {
      readonly ok: true;
      readonly receiptSha256: string;
      /** The row's recorded instant, read back. */
      readonly authorizedAt: string;
      /** True when an `INTENDED` row over the receipt already stood: the first row is kept. */
      readonly replayed: boolean;
    }
  | GitWriterRefused;

export type CommitWriteOutcome =
  | {
      readonly ok: true;
      /** Read back from the ref. */
      readonly commitSha: string;
      readonly treeSha: string;
      readonly baseSha: string;
      readonly ref: string;
      readonly receiptSha256: string;
    }
  | GitWriterRefused;
