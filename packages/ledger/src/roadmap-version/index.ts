import { RoadmapVersion } from "@acp/contracts";

import type { RoadmapVersionReadModel } from "../types/index.js";

/**
 * The roadmap-version decision.
 *
 * A pure function over values. It never opens a ledger, never reads a clock
 * and mints nothing: the caller folds the initiative stream, hands in the head
 * and the versions the fold knows, and appends the candidate event this module
 * returns. That allocation is the P6C/P5D one, and it is what makes the laws
 * below testable without a database.
 *
 * The module lives beside the fold it consumes rather than in the package that
 * happens to call it, for the same reason `AUTHORIZATION_REFUSALS` lives beside
 * commit authorization: a decision and the projection it reasons over drift
 * apart the moment they are maintained separately, and no other package may
 * re-derive this fold.
 *
 * What the contract already proved is not re-proved here. `RoadmapVersion`
 * enforces what one value can say about itself — the bootstrap biconditionals
 * and kind/restore coherence — so a candidate that reaches the laws below is
 * already internally consistent. What is left is exactly what needs the head:
 * that the claim about the head is true, that the version is the head's
 * successor, and that a rollback restores the bytes it says it restores.
 */

/**
 * The closed refusal vocabulary, sorted.
 *
 * Sorted so the list itself is checkable, and closed so a caller can exhaust
 * it. Every refusal names the field that failed, never the content of the
 * roadmap.
 */
export const ROADMAP_VERSION_REFUSALS = [
  "HEAD_MISMATCH",
  "PARENT_MISMATCH",
  "REQUEST_INVALID",
  "RESTORES_UNKNOWN_VERSION",
  "ROLLBACK_DIGEST_MISMATCH",
  "VERSION_NOT_MONOTONIC",
] as const;

export type RoadmapVersionRefusal = (typeof ROADMAP_VERSION_REFUSALS)[number];

/** The candidate event a granted decision produces, as a value. */
export interface RoadmapVersionEvent {
  readonly type: "ROADMAP_VERSION_RECORDED";
  /** The version itself. The projection parses this back out of the payload. */
  readonly payload: RoadmapVersion;
}

export interface RoadmapVersionRequest {
  /** The candidate version. Parsed here through the contract, never trusted. */
  readonly candidate: unknown;
  /**
   * The folded head of this initiative's roadmap history, or null when the
   * initiative has none yet. Supplied by the caller; this module never reads
   * a ledger to find it.
   */
  readonly head: RoadmapVersionReadModel | null;
  /**
   * Every version the fold knows for this initiative. Only a rollback reads
   * this, and only to find the version it claims to restore.
   */
  readonly knownVersions: readonly RoadmapVersionReadModel[];
}

export interface RoadmapVersionGranted {
  readonly ok: true;
  readonly version: RoadmapVersion;
  /** Appended by the caller, never by this module. */
  readonly events: readonly RoadmapVersionEvent[];
}

export interface RoadmapVersionRefused {
  readonly ok: false;
  readonly reason: RoadmapVersionRefusal;
  /** The field that failed, for a diagnostic. Never roadmap content. */
  readonly at: string;
}

export type RoadmapVersionOutcome = RoadmapVersionGranted | RoadmapVersionRefused;

function refuse(reason: RoadmapVersionRefusal, at: string): RoadmapVersionRefused {
  return { ok: false, reason, at };
}

/**
 * Decide whether one candidate roadmap version may be recorded.
 *
 * The order of the checks is deliberate and is the same shape `recordCommit`
 * uses: the coarsest claim first, so a caller reading a refusal learns the
 * most useful thing rather than the first thing. Monotonicity is checked
 * before the parent, and the parent before the head digest, because a version
 * number that is not the successor makes the other two meaningless.
 */
export function decideRoadmapVersion(request: RoadmapVersionRequest): RoadmapVersionOutcome {
  const parsed = RoadmapVersion.safeParse(request.candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refuse("REQUEST_INVALID", "candidate." + (issue?.path ?? []).join("."));
  }
  const candidate = parsed.data;
  const head = request.head;

  // A head from another initiative cannot answer a question about this one.
  if (head !== null && head.initiativeId !== candidate.initiativeId) {
    return refuse("REQUEST_INVALID", "head.initiativeId");
  }
  for (const known of request.knownVersions) {
    if (known.initiativeId !== candidate.initiativeId) {
      return refuse("REQUEST_INVALID", "knownVersions.initiativeId");
    }
  }

  // Monotonic means exact successor, in both the bootstrap and the ordinary
  // case. The contract has already tied a null parent and a null head claim to
  // version 1, so a first version cannot arrive claiming either.
  const expectedVersion = head === null ? 1 : head.version + 1;
  if (candidate.version !== expectedVersion) {
    return refuse("VERSION_NOT_MONOTONIC", "candidate.version");
  }

  if (head !== null) {
    if (candidate.parentVersionId !== head.roadmapVersionId) {
      return refuse("PARENT_MISMATCH", "candidate.parentVersionId");
    }
    if (candidate.expectedHeadDigest !== head.contentDigest) {
      return refuse("HEAD_MISMATCH", "candidate.expectedHeadDigest");
    }
  }

  if (candidate.kind === "ROLLBACK") {
    // The contract guarantees a ROLLBACK names a version; whether the fold
    // knows that version, and whether it holds the bytes being claimed, are
    // both questions only the head-holder can answer.
    const restored = request.knownVersions.find(
      (known) => known.roadmapVersionId === candidate.restoresVersionId,
    );
    if (restored === undefined) {
      return refuse("RESTORES_UNKNOWN_VERSION", "candidate.restoresVersionId");
    }
    // A rollback that restores different bytes is not a rollback.
    if (restored.contentDigest !== candidate.contentDigest) {
      return refuse("ROLLBACK_DIGEST_MISMATCH", "candidate.contentDigest");
    }
  }

  return {
    ok: true,
    version: candidate,
    events: [{ type: "ROADMAP_VERSION_RECORDED", payload: candidate }],
  };
}
