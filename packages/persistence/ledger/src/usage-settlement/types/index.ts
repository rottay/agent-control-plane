/**
 * The value types of the usage settlement fold (P-32/captura escalón A, ADR 0088).
 *
 * The two vocabularies' derived unions, the stream coordinate and its inputs, the
 * request and its three parts, the settlement and its header, source head and
 * segments, the granted and refused outcomes, and the six shapes the fold keeps to
 * itself while it counts: the declarations this concept owns, in the concept's own
 * leaf rather than interleaved with the fold that reads them (owner law
 * `docs/audit/architecture/index.md` §7; the ADR 0088 errata of 2026-09-14
 * withdraws that record's "Types live inline in the module" for every new
 * declaration, and decision 90 registers this seam).
 *
 * A pure type leaf, on `../../types/index.ts`' and `../../outbox-store/types/index.ts`'
 * pattern: it declares data and nothing else, and imports only types. The closed
 * sets the unions are derived from stay in `../index.ts` beside the fold, and are
 * read here type-only, which is §7.1's one-way derivation and is erased at emit.
 *
 * Nothing was renamed and no field changed: these are the same declarations, moved.
 * `../index.ts` re-exports every exported one, so no importer sees a difference; the
 * six private ones are exported from this leaf only so the fold can import them, and
 * are deliberately absent from that re-export, so they stay unexported from the
 * package exactly as before (§7.2).
 */

import type {
  USAGE_REPORT_KINDS,
  USAGE_SETTLEMENT_REFUSALS,
  USAGE_SETTLEMENT_STATUSES,
  USAGE_SOURCE_CLASSES,
} from "../index.js";

export type UsageSourceClass = (typeof USAGE_SOURCE_CLASSES)[number];

export type UsageReportKind = (typeof USAGE_REPORT_KINDS)[number];

export type UsageSettlementStatus = (typeof USAGE_SETTLEMENT_STATUSES)[number];

export type UsageSettlementRefusal = (typeof USAGE_SETTLEMENT_REFUSALS)[number];

/** The four fields a stream identity is taken over, in economy §1.1's order. */
export interface UsageMeasurementStreamCoordinate {
  readonly source: string;
  readonly accountId: string;
  readonly routeSegmentId: string;
  readonly sourceEpoch: number;
}

/** A declared stream, as the fold receives it. */
export interface UsageMeasurementStreamInput extends UsageMeasurementStreamCoordinate {
  readonly measurementStreamId: string;
  readonly sourceClass: UsageSourceClass;
}

/** One observation, in economy §1.2's shape. It carries no source class. */
export interface UsageObservationInput {
  readonly observationId: string;
  readonly measurementStreamId: string;
  readonly ordinal: number;
  readonly sourceObservationId: string;
  readonly reportKind: UsageReportKind;
  readonly rangeFromCounter: number | null;
  readonly rangeToCounter: number | null;
  readonly correctsObservationId: string | null;
  readonly effectId: string;
  readonly isFinal: 0 | 1;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly sequence: number;
}

/** The cut: one effect, at one control head. */
export interface UsageSettlementCut {
  readonly effectId: string;
  readonly controlHead: { readonly sequence: number; readonly sha256: string };
}

/** The event that produces the revision: an observation, a finalization or the effect's exposure. */
export interface UsageSettlementTrigger {
  readonly sequence: number;
  readonly recordedAt: string;
}

/** The revision in force before this one. */
export interface UsageSettlementPrevious {
  readonly settlementRevision: number;
  readonly status: UsageSettlementStatus;
  readonly sequence: number;
}

export interface UsageSettlementRequest {
  readonly cut: UsageSettlementCut;
  readonly trigger: UsageSettlementTrigger;
  /** The effect's streams. A stream no observation names is ignored. */
  readonly streams: readonly UsageMeasurementStreamInput[];
  /** Every observation of the effect registered up to the cut's head. */
  readonly observations: readonly UsageObservationInput[];
  readonly previous: UsageSettlementPrevious | null;
  /** The trigger sequence of the latest FINAL revision before this one, or null. */
  readonly lastFinalSequence: number | null;
  /** Must be `USAGE_SOURCE_POLICY_V1`, compared by digest. */
  readonly policy: unknown;
  /** Must be `USAGE_FOLD_VERSION_V1`. */
  readonly foldVersion: number;
}

/** Economy §2.1, field for field. Counts are `bigint`, NULL iff UNKNOWN or DISPUTED. */
export interface UsageSettlementHeader {
  readonly effectId: string;
  readonly settlementRevision: number;
  readonly settlementStatus: UsageSettlementStatus;
  readonly inputTokens: bigint | null;
  readonly outputTokens: bigint | null;
  readonly cacheWriteTokens: bigint | null;
  readonly cacheReadTokens: bigint | null;
  readonly totalTokens: bigint | null;
  readonly sourcePolicySha256: string;
  readonly foldVersion: number;
  readonly lastObservationId: string | null;
  readonly hadLateArrival: 0 | 1;
  readonly computedAt: string;
  readonly sequence: number;
}

/** Economy §2.2. Only the control row: the policy is a constant here, not a registry document (Q4). */
export interface UsageSettlementSourceHead {
  readonly sourceStream: "control_plane_events";
  readonly sourceSequence: number;
  readonly sourceSha256: string;
}

/** One segment's election. Not persisted by B; the segment-level settlement P-33 reads. */
export interface UsageSettlementSegment {
  readonly routeSegmentId: string;
  readonly settlementStatus: "FINAL" | "PARTIAL" | "DISPUTED";
  /** The winning class. */
  readonly sourceClass: UsageSourceClass;
  /** The elected lineage's streams, sorted; null when the segment is disputed. */
  readonly measurementStreamIds: readonly string[] | null;
  readonly inputTokens: bigint | null;
  readonly outputTokens: bigint | null;
  readonly cacheWriteTokens: bigint | null;
  readonly cacheReadTokens: bigint | null;
  readonly totalTokens: bigint | null;
}

export interface UsageSettlement {
  readonly header: UsageSettlementHeader;
  readonly sourceHeads: readonly UsageSettlementSourceHead[];
  /** Every considered observation, winners, losers and corrected alike, by sequence. */
  readonly observationIds: readonly string[];
  /** By `routeSegmentId`, code-point order. Empty when nothing was observed. */
  readonly segments: readonly UsageSettlementSegment[];
}

export interface UsageSettlementGranted {
  readonly ok: true;
  readonly settlement: UsageSettlement;
}

export interface UsageSettlementRefused {
  readonly ok: false;
  readonly reason: UsageSettlementRefusal;
  /** The field that failed, for a diagnostic. Never a count. */
  readonly at: string;
}

export type UsageSettlementOutcome = UsageSettlementGranted | UsageSettlementRefused;

export interface ObservationFault {
  readonly reason: UsageSettlementRefusal;
  readonly field: string;
}

export interface Counts {
  input: bigint;
  output: bigint;
  cacheWrite: bigint;
  cacheRead: bigint;
}

/** One effective report of a stream: its root's coverage, its chain's last values. */
export interface Coverage {
  readonly from: number;
  readonly to: number;
  readonly counts: Counts;
  readonly isFinal: 0 | 1;
}

export interface Indexed {
  readonly observation: UsageObservationInput;
  readonly index: number;
}

export interface ObservedStream {
  readonly stream: UsageMeasurementStreamInput;
  readonly index: number;
  readonly entries: Indexed[];
}

export interface Lineage {
  readonly sourceClass: UsageSourceClass;
  /** Code-point order: the first is the lineage's least stream id. */
  readonly streamIds: string[];
  readonly counts: Counts;
  /** Every stream gapless and final so far. */
  settled: boolean;
}
