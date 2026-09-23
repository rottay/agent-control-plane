/**
 * The value types of a prompt occurrence (P-06/C; moved here by P-06/CORR,
 * ADR 0096).
 *
 * The record one delivery of an instruction leaves behind and the input its
 * builder takes: the declarations this concept owns, in the concept's own leaf
 * rather than interleaved with the builder (owner law
 * `docs/audit/architecture/index.md` §7; decision 90 registers the seam, and the
 * P-06/C v4 deferral of these two to P-37 is superseded).
 *
 * A pure type leaf, on `intake/types/index.ts`'s pattern: it declares data and
 * nothing else, and imports only types. Nothing was renamed and no field
 * changed: these are the same declarations, moved, and `../index.ts` re-exports
 * both, so no importer sees a difference.
 */

import type { ControlPlaneEvent as ControlPlaneEventType, TransportKind } from "@acp/contracts";
// The resolution status is the ledger's vocabulary, imported rather than
// restated: the read model owns the closed set, and a second spelling of it here
// would be a second answer to the question "what statuses exist".
import type {
  EffectOutcomeStatus,
  ExecutionEffectKind,
  ModelResolutionStatus,
  PricePin,
  RedactionVerdict,
} from "@acp/ledger";

import type { DurableInvocation } from "../../../contracts/index.js";

/**
 * What a prompt occurrence records about one delivery of an instruction
 * (execution §8.1).
 *
 * The **use**, never the bytes: a digest, a length, and the coordinate the
 * delivery happened on. The thirteen fields are exactly the ledger's
 * `PROMPT_OCCURRENCE_RECORD_KEYS` and there is no fourteenth — the door refuses
 * a key its grammar does not declare, and a producer whose shape were wider
 * would be the thing that discovered that a step late.
 *
 * There is no `identity` here on purpose: that column is the recording event's
 * `emittedBy`, so a record cannot name another worker as the sender.
 */
export interface PromptOccurrenceRecord {
  readonly occurrenceId: string;
  readonly dispatchAttemptId: string;
  readonly effectId: string;
  readonly routeSegmentId: string;
  /**
   * The occurrence's order within its segment.
   *
   * Supplied, not counted here: the door assigns one past the segment's highest
   * and refuses anything else, so a number invented in this process would be
   * refused at the append rather than silently accepted.
   */
  readonly ordinal: number;
  /** Preserved always, even when resolution failed (execution §4, §8). */
  readonly requestedModelId: string;
  readonly provider: string;
  readonly modelResolutionStatus: ModelResolutionStatus;
  /** Present if and only if the status is RESOLVED; the door refuses the pair otherwise. */
  readonly modelVersionId: string | null;
  readonly accountId: string;
  /**
   * The digest of the instruction's bytes. The bytes themselves never travel.
   *
   * Conserved rather than recomputed here, because its preimage is the prompt
   * and a prompt does not enter this package: recomputing it would mean holding
   * the bytes at the one place that must never hold them (N-P06-14).
   */
  readonly promptSha256: string;
  readonly promptBytes: number;
  /**
   * Null when the delivery carried no separately addressed context.
   *
   * Null rather than a digest of nothing, which is economy's rule about absent
   * data applied to a prompt: an invented digest is worse than a stated
   * absence, because no reader can tell it from a real one (N-P06-17).
   */
  readonly contextSha256: string | null;
}

export interface BuildPromptOccurrenceInput {
  readonly invocation: DurableInvocation;
  /**
   * The task's current state, read from the ledger by the caller.
   *
   * It travels as both `fromState` and `toState`: recording that an instruction
   * was sent is something a run *did*, not a move through a lifecycle, and the
   * contract lists this type among the same-state passthroughs of the
   * `execution` channel.
   */
  readonly state: ControlPlaneEventType["fromState"];
  readonly emittedBy: string;
  /** The event this delivery was caused by, or null where the caller has none. */
  readonly causedBy: string | null;
  readonly occurrence: PromptOccurrenceRecord;
}

/**
 * What a response occurrence records about the one answer to one prompt
 * (execution §8.2; P-07 escalón D, ADR 0100).
 *
 * The **use**, never the bytes, as the prompt's record is: the five fields are
 * exactly the ledger's `RESPONSE_OCCURRENCE_RECORD_KEYS`, and there is no sixth.
 * No `identity`, no delivery, no segment and no account: an answer is attributed
 * through its prompt and nothing else, which is the grammar's own reason.
 */
export interface ResponseOccurrenceRecord {
  readonly occurrenceId: string;
  /** The prompt this answers, recorded first; the door refuses an unrecorded one. */
  readonly promptOccurrenceId: string;
  /** The published RESPONSE artifact's `content_sha256`, conserved (D10). */
  readonly responseSha256: string;
  /** The canonical result document's length, in bytes. */
  readonly responseBytes: number;
  /** `CLEAN` from every producer in P-07; `REDACTED` has none. */
  readonly redactionVerdict: RedactionVerdict;
}

export interface BuildResponseOccurrenceInput {
  readonly invocation: DurableInvocation;
  /** The task's current state, carried as both `fromState` and `toState`, as the prompt's is. */
  readonly state: ControlPlaneEventType["fromState"];
  readonly emittedBy: string;
  /** The event this answer was caused by, or null where the caller has none. */
  readonly causedBy: string | null;
  readonly occurrence: ResponseOccurrenceRecord;
}

/**
 * The route segment an effect or a delivery runs on, as its intention states it
 * (execution §4; P-15 escalón C, ADR 0103).
 *
 * Exactly the sixteen names the ledger's segment fold reads, and no other. The
 * nullable ones are stated, never omitted by a caller's choice: the builder writes
 * every one, `null` where the segment has none, and the door judges the pairs
 * (a predecessor with its handoff reason, an escalation with its reason, a
 * resolved model with its version).
 */
export interface ExecutionSegmentRecord {
  readonly routeSegmentId: string;
  readonly segmentNumber: number;
  readonly provider: string;
  readonly model: string;
  readonly modelResolutionStatus: ModelResolutionStatus;
  readonly modelVersionId: string | null;
  readonly accountId: string | null;
  readonly transportKind: TransportKind;
  readonly capabilityPolicyVersion: string;
  readonly routingAssignmentId: string | null;
  readonly reservationId: string | null;
  readonly predecessorSegmentId: string | null;
  readonly handoffReason: string | null;
  readonly escalatedFromAttempt: number | null;
  readonly escalationReason: string | null;
  readonly resolvedAt: string | null;
}

/** What a caller states about one effect it intends; its identities are derived, never passed in. */
export interface EffectIntentionFacts {
  readonly operationOrdinal: number;
  readonly effectKind: ExecutionEffectKind;
  readonly semanticScopeKey: string;
  readonly localOperationKey: string;
  readonly requestContractVersion: string;
  /** The request's digest, computed by the caller with the ledger's `requestSha256`. */
  readonly requestSha256: string;
}

export interface BuildEffectIntentionInput {
  readonly invocation: DurableInvocation;
  /** The task's current state, carried as both `fromState` and `toState`. */
  readonly state: ControlPlaneEventType["fromState"];
  readonly emittedBy: string;
  readonly causedBy: string | null;
  readonly segment: ExecutionSegmentRecord;
  readonly effect: EffectIntentionFacts;
}

/** What a caller states about one delivery of an effect it already intended. */
export interface DispatchIntentionFacts {
  readonly dispatchAttemptId: string;
  readonly effectId: string;
  readonly attemptOrdinal: number;
  /** The price catalog version the delivery will be valued against, fixed before the spend. Required. */
  readonly pin: PricePin;
}

export interface BuildDispatchIntentionInput {
  readonly invocation: DurableInvocation;
  readonly state: ControlPlaneEventType["fromState"];
  readonly emittedBy: string;
  readonly causedBy: string | null;
  /** The delivery's **effective** segment, which after a handoff is not the effect's first. */
  readonly segment: ExecutionSegmentRecord;
  readonly dispatch: DispatchIntentionFacts;
}

/**
 * One move of a delivery after its intention, one arm per move a producer may
 * record (P-15 escalón C, C-D2 and Q-C2), each closed by construction:
 *
 * - `INFLIGHT`: the destination accepted it, with its handle; no terminal instant,
 *   no outcome and no result.
 * - `ABANDONED`: it ended without being accepted; a terminal instant, never an
 *   accepted instant or a handle, and an outcome only as the ledger admits one.
 * - `SETTLED`: it ended; a terminal instant, the effect's outcome, and the result
 *   pair when there is one — both or neither.
 */
export type DispatchTransition =
  | {
      readonly kind: "INFLIGHT";
      readonly dispatchAttemptId: string;
      readonly acceptedAt: string;
      readonly externalHandle: string;
    }
  | {
      readonly kind: "ABANDONED";
      readonly dispatchAttemptId: string;
      readonly terminalAt: string;
      readonly effectOutcomeStatus: EffectOutcomeStatus | null;
    }
  | {
      readonly kind: "SETTLED";
      readonly dispatchAttemptId: string;
      readonly terminalAt: string;
      readonly effectOutcomeStatus: EffectOutcomeStatus | null;
      readonly result: { readonly artifactReferenceId: string; readonly sha256: string } | null;
    };

export interface BuildDispatchTransitionInput {
  readonly invocation: DurableInvocation;
  readonly state: ControlPlaneEventType["fromState"];
  readonly emittedBy: string;
  readonly causedBy: string | null;
  readonly transition: DispatchTransition;
}
