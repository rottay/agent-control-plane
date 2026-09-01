/**
 * Lifecycle — `@acp/contracts` (P8-T G6).
 *
 * The lifecycle states and the predicates over them.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";

/** The happy path lifecycle, in order, exactly as the roadmap freezes it. */
export const LIFECYCLE_STATES = [
  "DISCOVERED",
  "DT_CLASSIFIED",
  "READY",
  "RESERVED",
  "RUNNING",
  "VERIFYING",
  "AUDITING",
  "READY_TO_COMMIT",
  "COMMITTED",
  "CHECKPOINTED",
] as const;

/** Exceptional states. These are not orderable and may be entered laterally. */
export const EXCEPTIONAL_STATES = [
  "WAITING_OWNER",
  "DRAINING",
  "QUOTA_BLOCKED",
  "AUTH_REQUIRED",
  "REJECTED",
  "FAILED",
  "SUSPECT_WORKTREE",
  "CANCELLED",
] as const;

export const LifecycleState = z.enum(LIFECYCLE_STATES);
export type LifecycleState = z.infer<typeof LifecycleState>;

export const ExceptionalState = z.enum(EXCEPTIONAL_STATES);
export type ExceptionalState = z.infer<typeof ExceptionalState>;

export const TaskState = z.union([LifecycleState, ExceptionalState]);
export type TaskState = z.infer<typeof TaskState>;

export function isLifecycleState(value: string): value is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isExceptionalState(value: string): value is ExceptionalState {
  return (EXCEPTIONAL_STATES as readonly string[]).includes(value);
}

/** Terminal states. A task in one of these will not progress on its own. */
export const TERMINAL_STATES: readonly TaskState[] = [
  "CHECKPOINTED",
  "REJECTED",
  "FAILED",
  "SUSPECT_WORKTREE",
  "CANCELLED",
];
