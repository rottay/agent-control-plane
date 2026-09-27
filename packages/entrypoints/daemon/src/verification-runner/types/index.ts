/**
 * The value types of the verification runner (P-16/C, ADR 0123).
 *
 * Its input, its bounds, what one check ended as, and its outcome: the declarations
 * this concept owns, in the concept's own leaf. A pure type leaf: it declares data,
 * imports only types, and `../index.ts` re-exports every one.
 */

import type { ResolvedRoute } from "@acp/contracts";
import type { ArtifactPlane, Ledger } from "@acp/ledger";

import type { TreeHashRefusal } from "../../tree-hasher/index.js";
import type { RUNNER_REFUSALS } from "../index.js";

export type RunnerRefusal = (typeof RUNNER_REFUSALS)[number];

/**
 * The runner's bounds. Every one is a ceiling: a caller may tighten one (the tests
 * do, to reach a bound in milliseconds) and never loosen it.
 */
export interface RunnerBounds {
  /** The wall time one check may run, in milliseconds. */
  readonly checkTimeoutMs: number;
  /** The bytes one check may write to stdout and stderr together, counted raw. */
  readonly checkOutputBytes: number;
  /** The wall time the whole run's checks may take, in milliseconds. */
  readonly runTimeoutMs: number;
  /** The files the disposable copy may hold. */
  readonly copyFileCount: number;
  /** The bytes the disposable copy may hold. */
  readonly copyTotalBytes: number;
}

/**
 * One run's input. There is no command here, by construction: the checks are the
 * recorded envelope's `validation.commands`, read through `readRecordedTask`.
 */
export interface VerificationRunInput {
  /** The operator ledger: the task, its route segments and receipts are read here, and the event appended. */
  readonly ledger: Ledger;
  /** The private plane: the envelope is read and the receipt published through it. */
  readonly plane: ArtifactPlane;
  readonly taskId: string;
  /** The route the composition elected, held to the intake's resolution by the reader. */
  readonly route: ResolvedRoute;
  /** The writer's worktree: absolute, resolved, the repository's root. Read only. */
  readonly worktreePath: string;
  /** Where the per-run directory is made: absolute, real, a directory, never inside the worktree. */
  readonly scratchRoot: string;
  /** The writer's label, as the assignment names it. The decisive id is derived, not this. */
  readonly writerIdentity: string;
  /** Tighter bounds, each at most the runner's own; omitted members keep the runner's. */
  readonly bounds?: Partial<RunnerBounds>;
  /** The instant source, in the canonical form. Defaults to the wall clock. */
  readonly now?: () => string;
  /** The id source for the run directory, the artifact and the event. Defaults to a random v4. */
  readonly mintId?: () => string;
}

/** What one spawned check ended as, before it is a number (ND-3). */
export interface CheckTermination {
  /** The process could not be started at all. */
  readonly spawnFailed: boolean;
  /** The runner killed its group for a bound: time or output. */
  readonly killedByBound: boolean;
  readonly code: number | null;
  readonly signal: string | null;
}

/** One check as it ran: its declared command and its recorded exit code. Never its output. */
export interface RanCheck {
  readonly command: string;
  readonly exitCode: number;
}

export type VerificationRunOutcome =
  | {
      readonly ok: true;
      readonly runStatus: "PASS" | "FAIL";
      readonly receiptSha256: string;
      readonly artifactReferenceId: string;
      readonly runId: number;
      readonly verifierWorkerId: string;
      readonly treeSha: string;
      readonly checks: readonly RanCheck[];
    }
  | {
      readonly ok: false;
      readonly refusal: RunnerRefusal | TreeHashRefusal;
      /** The field the refusal is about. Never its value. */
      readonly at: string;
      /** The inner door's or reader's own word, carried by name when one refused. */
      readonly word: string | null;
      /** `CAPABILITY_UNSUPPORTED` for `OBJECT_FORMAT_UNSUPPORTED` (contracts §16.2), otherwise null. */
      readonly refusalClass: "CAPABILITY_UNSUPPORTED" | null;
    };
