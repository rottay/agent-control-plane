/**
 * The value types of an operation's result (P-07 escalón D, ADR 0100).
 *
 * What the decider reads from a trail, what it decides, what the sink hands the
 * recorder, what the assembler builds and what the publisher returns: the
 * declarations this concept owns, in the concept's own leaf (owner law
 * `docs/audit/architecture/index.md` §7; decision 90).
 *
 * A pure type leaf: it declares data and nothing else, and imports only types. The
 * reason vocabulary the `OperationDecisionReason` union is derived from stays in
 * `../index.ts` beside the decider, read here type-only.
 */

import type { ResultContract, ResultStatus } from "@acp/contracts";
import type { ArtifactPlane, Ledger, ReferenceReadRefusal } from "@acp/ledger";

import type { EFFECT_RESULT_LOCAL_REFUSALS, OPERATION_DECISION_REASONS, OUTPUT_CONDITIONS } from "../index.js";

/** Why an operation's result is what it is. Closed. */
export type OperationDecisionReason = (typeof OPERATION_DECISION_REASONS)[number];

/** Whether the output the sink collected can be assembled at all. Closed. */
export type OutputCondition = (typeof OUTPUT_CONDITIONS)[number];

/**
 * How the child process ended, as the trail reports it — or that it was not
 * observed. Never a default exit 0 (contratos §4.2; ADR 0099 Two).
 */
export type ProcessFact =
  | { readonly kind: "NOT_OBSERVABLE" }
  | { readonly kind: "EXITED"; readonly exitCode: number | null; readonly signal: string | null };

/** What the operation said about itself, or that it said nothing. */
export type OperationFact = "NOT_OBSERVABLE" | ResultStatus;

/**
 * The three facts of one execution, read from its trail by `kind` and nothing
 * else — never from a `state` token, which a failed operation reported as
 * `"SUCCESS"` (ADR 0099).
 */
export interface OperationFacts {
  readonly terminal: "completed" | "error" | "none";
  readonly process: ProcessFact;
  readonly operation: OperationFact;
}

/**
 * The decider's answer. Only a `completed` terminal is decided: an `error` or a
 * missing terminal keeps the legacy refusal path, and records no result.
 */
export type OperationDecision =
  | { readonly decided: false }
  | { readonly decided: true; readonly status: ResultStatus; readonly reason: OperationDecisionReason };

/**
 * What the output sink collected, as the recorder receives it.
 *
 * `output` is the deltas joined in order, held in memory only. `outputCondition`
 * says whether that text is whole: `OVER_PROFILE` when the collector stopped
 * retaining at the 8 MiB profile, `UNREADABLE` when the collector itself faulted.
 * In either case `output` is not the operation's whole answer, and no result is
 * assembled from it.
 */
export interface ResultSample {
  readonly operationIndex: number;
  readonly facts: OperationFacts;
  readonly output: string;
  readonly outputCondition: OutputCondition;
}

/**
 * The recorder the walk hands a completed execution's result to.
 *
 * Synchronous, for `UsageSink`'s reason: it runs between the execution and the
 * marker write and must be able to fail the apply closed.
 */
export type ResultSink = (sample: ResultSample) => void;

/**
 * What the assembler built from one sample.
 *
 * `NO_DOCUMENT` when nothing may be published — no output, or output refused, too
 * large or unreadable — and the effect's result is `FAILED` without a pair.
 * `DOCUMENT` when the document is ready; `OVERFLOW` when the answer needs its own
 * markdown artifact first, whose reference completes the document.
 */
export type ResultAssembly =
  | { readonly kind: "NO_DOCUMENT"; readonly status: "FAILED"; readonly reason: OperationDecisionReason }
  | {
      readonly kind: "DOCUMENT";
      readonly status: ResultStatus;
      readonly reason: OperationDecisionReason;
      readonly document: ResultContract;
      readonly bytes: Buffer;
      readonly sha256: string;
    }
  | {
      readonly kind: "OVERFLOW";
      readonly status: ResultStatus;
      readonly reason: OperationDecisionReason;
      readonly effectId: string;
      readonly overflowBytes: Buffer;
      readonly overflowSha256: string;
    };

/**
 * The ids one publication needs, all supplied by the caller: this concept reads no
 * clock and mints no id.
 */
export interface ArtifactIdentities {
  readonly artifactReferenceId: string;
  readonly commandId: string;
  readonly artifactPinId: string;
  readonly intentionEventId: string;
  readonly terminalEventId: string;
}

/** Everything the publisher needs, supplied by its caller. */
export interface ResultPublicationInput {
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  readonly effectId: string;
  readonly taskId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly holderPid: number;
  /** The result document's own publication. */
  readonly result: ArtifactIdentities;
  /** The overflow document's, used only when the answer overflows the block list. */
  readonly overflow: ArtifactIdentities;
  readonly assembly: ResultAssembly;
}

/**
 * What the publisher returns: the effect's result status and, when a document was
 * published, its pair and length — all three, or none of the three, never half.
 */
export type PublishedResult =
  | {
      readonly status: "FAILED";
      readonly reason: OperationDecisionReason;
      readonly resultArtifactReferenceId: null;
      readonly resultSha256: null;
      readonly responseBytes: null;
    }
  | {
      readonly status: ResultStatus;
      readonly reason: OperationDecisionReason;
      readonly resultArtifactReferenceId: string;
      readonly resultSha256: string;
      readonly responseBytes: number;
    };

/**
 * What a reader of one effect's result asks for (P-15 escalón F, ADR 0107): the
 * task the caller believes the effect belongs to, the effect, and optionally one
 * block of its document whose bytes live by reference.
 */
export interface EffectResultRequest {
  readonly taskId: string;
  readonly effectId: string;
  /** A block index into the document, or null for the document itself. */
  readonly block: number | null;
}

/** Why a result the ledger names cannot be given back: the plane's word, the root's, or the reader's own. */
export type EffectResultUnreadable = ReferenceReadRefusal | (typeof EFFECT_RESULT_LOCAL_REFUSALS)[number];

/** One block of a result document, read by its own reference and verified. */
export interface EffectResultBlock {
  readonly index: number;
  readonly artifactReferenceId: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly text: string;
}

/**
 * What the reader answers, in the order it decides (ADR 0107 Two). Closed.
 *
 * `NOT_FOUND` is also another task's effect: the two are indistinguishable on
 * purpose. `RESULT_UNREADABLE` is the ledger naming bytes the plane cannot give
 * back, or a document that disagrees with the row that names it; `BLOCK_REFUSED`
 * is a block selector that names nothing readable by reference.
 */
export type EffectResultReading =
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "NO_OUTCOME" }
  | { readonly kind: "OUTCOME_UNKNOWN" | "CANCELLED"; readonly outcomeRecordedAt: string }
  | {
      readonly kind: "NO_RESULT_RECORDED";
      readonly status: ResultStatus;
      readonly outcomeRecordedAt: string;
      readonly cohort: "PRE_RESULT" | "CURRENT";
    }
  | {
      readonly kind: "RESULT";
      readonly status: ResultStatus;
      readonly outcomeRecordedAt: string;
      readonly resultSha256: string;
      readonly artifactReferenceId: string;
      readonly document: ResultContract;
      readonly block: EffectResultBlock | null;
    }
  | { readonly kind: "RESULT_UNREADABLE"; readonly refusal: EffectResultUnreadable }
  | { readonly kind: "BLOCK_REFUSED" };
