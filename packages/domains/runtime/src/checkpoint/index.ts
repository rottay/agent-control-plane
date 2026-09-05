import type { Checkpoint } from "@acp/contracts";
import { ARTIFACT_REFUSALS } from "@acp/ledger";
import type { ArtifactRefusal } from "@acp/ledger";

import type { PlanStep } from "../core/lifecycle/index.js";

/**
 * The checkpoint the walk claims is one it wrote (V2-B1f/F3).
 *
 * `CHECKPOINT_WRITTEN` was a `PLAIN` beat like any other: both plans terminated
 * in it, both appended it, and nothing was ever written. This module declares
 * the two surfaces that make the claim true — a source that ASSEMBLES a
 * `Checkpoint` from facts the plane actually holds, and a port that PERSISTS
 * one before the event naming it is appended.
 *
 * **The domain declares and never implements.** `RUNTIME_ALLOWED_BUILTINS` is
 * crypto, fs, path and url, so nothing here can spawn `git`; and the store the
 * digest resolves in belongs to `@acp/ledger`. So both members below are
 * injected: the daemon builds the production source over the observer it
 * already has, the two drill children assemble from facts their spawning suite
 * observed, and a construction that says nothing gets no member at all — which
 * is the shape the terminal refuses on rather than works around.
 *
 * Nothing here reads a clock, a random source or the environment. A replayed
 * walk assembles identical bytes and publishes to one digest.
 */

/**
 * Why a checkpoint was refused. Closed, so a caller can exhaust it.
 *
 * Four of its own, and the store's own reasons carried through unchanged. The
 * store's refusals are not re-spelled here: a second vocabulary for the same
 * refusal is two answers to one question, and the day they disagreed the caller
 * would have to pick a winner silently.
 *
 * - `CHECKPOINT_INVALID` — the assembled value is not a `Checkpoint`; the
 *   contract's own message says which field, or that the 16 KiB budget is gone.
 * - `GIT_HEAD_UNBORN` — the worktree is at its initial commit, so the
 *   observation's `head` is honestly null and `git.head` is a 40 character
 *   object id. A repository with no commit cannot be checkpointed against one.
 * - `GIT_UNOBSERVABLE` — the observation could not be taken at all. An
 *   observation that could not be taken says nothing, so it is never a null.
 * - `PATH_MISSING` — a declared path the worktree does not hold, with the one
 *   exception the observer itself establishes (a tracked deletion digests the
 *   empty string). No other absence produces a digest.
 */
export type CheckpointRefusal =
  | "CHECKPOINT_INVALID"
  | "GIT_HEAD_UNBORN"
  | "GIT_UNOBSERVABLE"
  | "PATH_MISSING"
  | ArtifactRefusal;

/** The closed, sorted vocabulary, with the store's own carried through. */
export const CHECKPOINT_REFUSALS: readonly CheckpointRefusal[] = Object.freeze([
  "CHECKPOINT_INVALID",
  "GIT_HEAD_UNBORN",
  "GIT_UNOBSERVABLE",
  "PATH_MISSING",
  ...ARTIFACT_REFUSALS,
]);

/**
 * A refusal, in the store's own shape.
 *
 * `at` names a field, a path or a digest — a shape observation. **Never
 * checkpoint content**: a refusal that echoed what it refused would put the
 * bytes the budget exists to bound into a log line instead of an artifact.
 */
export interface CheckpointRefused {
  readonly ok: false;
  readonly reason: CheckpointRefusal;
  readonly at: string;
}

/**
 * Assemble the checkpoint for one terminal step.
 *
 * Every field comes from a fact the plane holds: the coordinates it derived,
 * the envelope it was admitted with, the worktree it leased, and the events it
 * already appended. Nothing here is a literal in the source, and nothing is
 * read from a clock — a replayed walk assembles the same bytes.
 *
 * Implemented in the daemon over its own git observer, and in the two drill
 * children over facts their spawning suite observed and passed as data. There
 * is no implementation in this package, and there is not meant to be one.
 */
export interface CheckpointSource {
  assemble(step: PlanStep): Checkpoint | CheckpointRefused;
}

/**
 * Persist the checkpoint for one terminal step, and read one back.
 *
 * `persist` is called by the terminal guard **before** the append, in the shape
 * `assertCausalPredecessor` already establishes: an append is a claim, and a
 * log that only grows cannot retract one. The digest it returns is the store's
 * own and is never re-derived — the event names what the store actually holds.
 *
 * `read` is declared for F5's rehydrate and is **not called** by F3. It is
 * declared rather than added later because a port whose reader arrives in a
 * different packet is a port two packets disagree about.
 */
export interface CheckpointPort {
  persist(
    step: PlanStep,
  ):
    | { readonly ok: true; readonly digest: string; readonly bytes: number }
    | CheckpointRefused;
  read(
    digest: string,
  ):
    | { readonly ok: true; readonly digest: string; readonly content: string }
    | CheckpointRefused;
}
