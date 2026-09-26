import { USAGE_REPORT_KINDS, USAGE_SOURCE_CLASSES, isSha256Hex } from "@acp/contracts";

import { GENESIS_SHA256, canonicalJsonStringify, sha256Hex } from "../canonical-json/index.js";
import { LedgerValidationError } from "../errors/index.js";

import type {
  Counts,
  Coverage,
  Indexed,
  Lineage,
  ObservationFault,
  ObservedStream,
  UsageMeasurementStreamCoordinate,
  UsageObservationInput,
  UsageSettlementOutcome,
  UsageSettlementRefusal,
  UsageSettlementRefused,
  UsageSettlementRequest,
  UsageSettlementSegment,
  UsageSettlementStatus,
  UsageSourceClass,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf,
 * `./types/index.ts`, and are re-exported here unchanged so every importer
 * keeps reading them from this module (owner law §7, ADR 0088 errata,
 * decision 90; `outbox-store`'s and `projection`'s precedent).
 */
export type {
  UsageSourceClass,
  UsageReportKind,
  UsageSettlementStatus,
  UsageSettlementRefusal,
  UsageMeasurementStreamCoordinate,
  UsageMeasurementStreamInput,
  UsageObservationInput,
  UsageSettlementCut,
  UsageSettlementTrigger,
  UsageSettlementPrevious,
  UsageSettlementRequest,
  UsageSettlementHeader,
  UsageSettlementSourceHead,
  UsageSettlementSegment,
  UsageSettlement,
  UsageSettlementGranted,
  UsageSettlementRefused,
  UsageSettlementOutcome,
} from "./types/index.js";


/**
 * The usage settlement fold and the measurement stream identity (P-32/captura A).
 *
 * Economy §1–2 records spend as observations on measurement streams and folds
 * them, per effect, into a settlement revision: a header, the vector of heads it
 * was computed at, and the exact list of observations it considered. This
 * module is the half of that which can be a pure function — the identity of a
 * stream and the fold — and nothing else. **It is inert.** No table, no event
 * type, no door and no migration reaches it; the fence holds that nothing
 * outside this module and the package barrel names it, and escalón B retires
 * that law when the door calls the fold inside the trigger's transaction
 * (ADR 0088).
 *
 * The fold never opens a ledger, never reads a clock and mints nothing. The
 * caller hands in the cut, the trigger, the streams, the observations and the
 * previous revision, and gets back either a settlement or one named refusal.
 * That allocation is `decideRoadmapVersion`'s, and it is what lets every law
 * below be tested without a database.
 *
 * ## What sums, and what competes
 *
 * Economy §1.3 says reports of one spend from two sources are alternatives and
 * never addends, that the elected coverages are aggregated by segment, and that
 * FINAL needs an effective `is_final` from **each** elected stream. The rule
 * that makes that one algorithm, fixed by the Fable preaudit (H-3) and the DT:
 *
 * 1. `source_class` belongs to the stream and enters the fold through it. An
 *    observation does not carry one.
 * 2. The unit of competition is the **lineage** `(source, account_id,
 *    route_segment_id)`. Its epochs are consecutive stretches of one
 *    measurement with distinct counter spaces, so ranges are compared only
 *    inside one stream, and the effective coverages of a lineage's epochs sum.
 * 3. Inside one `route_segment_id` lineages are alternatives: the highest class
 *    wins. Winners of equal class are comparable iff their four class sums
 *    agree, and then the lineage with the least `measurement_stream_id` (code
 *    points) is chosen; if they differ the settlement is DISPUTED, the five
 *    counts are NULL, and every contender stays in the list.
 * 4. Across segments the elected coverages sum, and the fold exposes the
 *    per-segment breakdown.
 * 5. FINAL needs a gapless coverage and an effective `is_final = 1` in every
 *    stream of every elected lineage. One elected stream without either is
 *    PARTIAL.
 *
 * ## Frozen
 *
 * The prefix, the policy document and the fold version are `v1` and are never
 * changed in place. A different algorithm is a new policy document with a new
 * digest and a new fold version, next to this one; this one keeps producing the
 * bytes it produces today, or a settlement recorded under it attests nothing.
 */

/**
 * The version prefix of the stream identity preimage, as bytes.
 *
 * The `\n` is a single LF byte and the last byte of the prefix. The formula adds
 * no separator of its own — the shape `EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1`
 * set — so a vector pins exactly one LF.
 */
export const USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1 = "acp/usage-measurement-stream/v1\n";

/**
 * Source classes, highest precedence first (economy §1.1, §1.3.3), and report kinds
 * (economy §1.2).
 *
 * Declared in `@acp/contracts` since P-15/D2 (ADR 0105, decision 137): the execution
 * port names a report's kind, and a port shape cannot import this package. They are
 * re-exported here under the same names, so every reader of the ledger reads the one
 * declaration. `USAGE_SOURCE_POLICY_V1.precedence` below stays a literal: its digest
 * is attested, and deriving it from the constant would make a reordering of the set
 * silently move a pinned policy.
 */
export { USAGE_REPORT_KINDS, USAGE_SOURCE_CLASSES };



/** Settlement statuses (economy §2.1). */
export const USAGE_SETTLEMENT_STATUSES = ["FINAL", "PARTIAL", "UNKNOWN", "DISPUTED"] as const;



/**
 * The precedence and coverage policy this fold implements, as a literal
 * document.
 *
 * Its digest is what a settlement stamps as `source_policy_sha256`. A hex
 * literal with no document behind it would attest nothing; this way the digest
 * is derived, a test pins the resulting hex, and moving one word of the
 * document moves the pin — which is the property wanted, because the algorithm
 * is the policy.
 */
export const USAGE_SOURCE_POLICY_V1 = Object.freeze({
  policyVersion: 1,
  precedence: Object.freeze(["PROVIDER_AUTHORITATIVE", "WRAPPER_MEASURED", "ESTIMATE"]),
  alternatives: "NEVER_SUM",
  incomparable: "DISPUTED",
  coverage: Object.freeze({
    delta: "DISJOINT",
    cumulative: "CONTAINS_WHOLE_OR_DISJOINT",
    partialOverlap: "REFUSE",
    forkedCorrections: "REFUSE",
  }),
});

/** `sha256Hex(canonicalJsonStringify(USAGE_SOURCE_POLICY_V1))`. */
export const USAGE_SOURCE_POLICY_SHA256_V1 = sha256Hex(canonicalJsonStringify(USAGE_SOURCE_POLICY_V1));

/** The settlement algorithm's version. Never "the one installed at rebuild". */
export const USAGE_FOLD_VERSION_V1 = 1;

/** The int64 ceiling every published count is held to (economy §1.2). */
export const USAGE_SETTLEMENT_TOKENS_MAX = 2n ** 63n - 1n;

/**
 * The closed refusal vocabulary, sorted.
 *
 * Sorted so the list itself is checkable, and closed so escalón B's door can
 * exhaust it. DISPUTED is not here: an incomparable pair of sources is a
 * settlement, not a refusal (adjudication Q2). Every refusal names the field
 * that failed, never a count.
 */
export const USAGE_SETTLEMENT_REFUSALS = [
  "CORRECTIONS_FORKED",
  "CORRECTION_CROSS_EFFECT",
  "CORRECTION_CROSS_STREAM",
  "CORRECTION_CYCLE",
  "CORRECTION_TARGET_UNKNOWN",
  "COVERAGE_OVERLAP",
  "FOLD_VERSION_UNSUPPORTED",
  "OBSERVATION_BEYOND_CUT",
  "OBSERVATION_DUPLICATE",
  "OBSERVATION_FOREIGN_EFFECT",
  "OBSERVATION_SHAPE_INVALID",
  "ORDINAL_DUPLICATE",
  "POLICY_UNSUPPORTED",
  "REQUEST_INVALID",
  "SOURCE_REPORT_DUPLICATE",
  "STREAM_COORDINATE_INVALID",
  "STREAM_DUPLICATE",
  "STREAM_LINEAGE_CLASS_MIXED",
  "STREAM_SOURCE_CLASS_INVALID",
  "STREAM_UNKNOWN",
  "TOKENS_OVERFLOW",
  "TOTAL_MISMATCH",
] as const;































function refuse(reason: UsageSettlementRefusal, at: string): UsageSettlementRefused {
  return { ok: false, reason, at };
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A safe, non-negative integer that survives canonical JSON (so never `-0`). */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The first field of a coordinate that is not well formed, or null. */
function coordinateFault(coordinate: unknown): string | null {
  if (!isObject(coordinate)) return "coordinate";
  if (!isText(coordinate["source"])) return "source";
  if (!isText(coordinate["accountId"])) return "accountId";
  if (!isText(coordinate["routeSegmentId"])) return "routeSegmentId";
  if (!isCount(coordinate["sourceEpoch"])) return "sourceEpoch";
  return null;
}

/**
 * The canonical preimage of a measurement stream identity, version 1.
 *
 *     preimage = USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1
 *              + canonicalJsonStringify([source, accountId, routeSegmentId, sourceEpoch])
 *
 * A positional array in the dictionary's order, so no key name is part of the
 * identity, and no separator between prefix and body. It takes the coordinate,
 * never a preimage already assembled, and it validates each field by name
 * before anything is hashed: three non-empty texts (the segment has no shape
 * CHECK in migration 13, so no stricter grammar is invented) and a safe
 * non-negative epoch. A refusal is a `LedgerValidationError` whose issue names
 * the field and opens with `STREAM_COORDINATE_INVALID`.
 *
 * The provider's own connection id never enters: it is reusable, and an
 * identity that could be recycled identifies nothing (economy §1.1).
 */
export function measurementStreamPreimageV1(coordinate: UsageMeasurementStreamCoordinate): string {
  const fault = coordinateFault(coordinate);
  if (fault !== null) {
    throw new LedgerValidationError([
      {
        path: fault,
        message: "STREAM_COORDINATE_INVALID: a stream coordinate needs three non-empty texts and a safe epoch >= 0",
      },
    ]);
  }
  return (
    USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1 +
    canonicalJsonStringify([
      coordinate.source,
      coordinate.accountId,
      coordinate.routeSegmentId,
      coordinate.sourceEpoch,
    ])
  );
}

/** The digest of the preimage above. Two steps, so a vector can pin each. */
export function measurementStreamIdV1(coordinate: UsageMeasurementStreamCoordinate): string {
  return sha256Hex(measurementStreamPreimageV1(coordinate));
}

function policyIsV1(policy: unknown): boolean {
  try {
    return sha256Hex(canonicalJsonStringify(policy)) === USAGE_SOURCE_POLICY_SHA256_V1;
  } catch {
    return false;
  }
}

/** The first malformed field of the cut, trigger or previous revision, or null. */
function requestFault(request: UsageSettlementRequest): string | null {
  const cut: unknown = request.cut;
  if (!isObject(cut)) return "cut";
  if (!isText(cut["effectId"])) return "cut.effectId";
  const head = cut["controlHead"];
  if (!isObject(head)) return "cut.controlHead";
  const headSequence = head["sequence"];
  const headSha = head["sha256"];
  if (!isCount(headSequence)) return "cut.controlHead.sequence";
  if (typeof headSha !== "string" || !isSha256Hex(headSha)) return "cut.controlHead.sha256";
  // Genesis iff sequence zero (economy §2.2), in both directions.
  if ((headSequence === 0) !== (headSha === GENESIS_SHA256)) return "cut.controlHead.sha256";

  const trigger: unknown = request.trigger;
  if (!isObject(trigger)) return "trigger";
  const triggerSequence = trigger["sequence"];
  if (!isCount(triggerSequence) || triggerSequence < 1 || triggerSequence > headSequence) {
    return "trigger.sequence";
  }
  if (!isText(trigger["recordedAt"])) return "trigger.recordedAt";

  if (!Array.isArray(request.streams)) return "streams";
  if (!Array.isArray(request.observations)) return "observations";

  const previous: unknown = request.previous;
  const lastFinal: unknown = request.lastFinalSequence;
  if (previous === null) {
    if (lastFinal !== null) return "lastFinalSequence";
    return null;
  }
  if (!isObject(previous)) return "previous";
  const revision = previous["settlementRevision"];
  if (!isCount(revision) || revision < 1) return "previous.settlementRevision";
  const status = previous["status"];
  if (typeof status !== "string" || !(USAGE_SETTLEMENT_STATUSES as readonly string[]).includes(status)) {
    return "previous.status";
  }
  const previousSequence = previous["sequence"];
  // A successor comes from a later trigger.
  if (!isCount(previousSequence) || previousSequence < 1 || previousSequence >= triggerSequence) {
    return "previous.sequence";
  }
  if (status === "FINAL") {
    // The latest FINAL revision is the previous one itself.
    if (lastFinal !== previousSequence) return "lastFinalSequence";
  } else if (lastFinal !== null && (!isCount(lastFinal) || lastFinal < 1 || lastFinal >= previousSequence)) {
    return "lastFinalSequence";
  }
  return null;
}



/** Economy §1.2's shape for one observation, or the first thing wrong with it. */
function observationFault(observation: unknown): ObservationFault | null {
  const shape = (field: string): ObservationFault => ({ reason: "OBSERVATION_SHAPE_INVALID", field });
  if (!isObject(observation)) return shape("");
  for (const field of ["observationId", "measurementStreamId", "sourceObservationId", "effectId"]) {
    if (!isText(observation[field])) return shape(field);
  }
  if (!isCount(observation["ordinal"])) return shape("ordinal");
  const sequence = observation["sequence"];
  if (!isCount(sequence) || sequence < 1) return shape("sequence");
  const kind = observation["reportKind"];
  if (typeof kind !== "string" || !(USAGE_REPORT_KINDS as readonly string[]).includes(kind)) {
    return shape("reportKind");
  }
  const from = observation["rangeFromCounter"];
  const to = observation["rangeToCounter"];
  const corrects = observation["correctsObservationId"];
  if (kind === "CORRECTION") {
    // A correction inherits its target's coverage and declares none of its own.
    if (!isText(corrects)) return shape("correctsObservationId");
    if (from !== null) return shape("rangeFromCounter");
    if (to !== null) return shape("rangeToCounter");
  } else {
    if (corrects !== null) return shape("correctsObservationId");
    if (!isCount(from)) return shape("rangeFromCounter");
    if (!isCount(to) || from >= to) return shape("rangeToCounter");
  }
  const isFinal = observation["isFinal"];
  if (isFinal !== 0 && isFinal !== 1) return shape("isFinal");
  for (const field of ["occurredAt", "recordedAt"]) {
    if (!isText(observation[field])) return shape(field);
  }
  let sum = 0n;
  for (const field of ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"]) {
    const value = observation[field];
    if (!isCount(value)) return shape(field);
    sum += BigInt(value);
  }
  const total = observation["totalTokens"];
  if (!isCount(total)) return shape("totalTokens");
  // Four mutually exclusive classes: the total is their sum and nothing else,
  // so cached input can never be counted a second time inside input.
  if (BigInt(total) !== sum) return { reason: "TOTAL_MISMATCH", field: "totalTokens" };
  return null;
}



function zeroCounts(): Counts {
  return { input: 0n, output: 0n, cacheWrite: 0n, cacheRead: 0n };
}

function addCounts(into: Counts, from: Counts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheWrite += from.cacheWrite;
  into.cacheRead += from.cacheRead;
}

function countsOf(observation: UsageObservationInput): Counts {
  return {
    input: BigInt(observation.inputTokens),
    output: BigInt(observation.outputTokens),
    cacheWrite: BigInt(observation.cacheWriteTokens),
    cacheRead: BigInt(observation.cacheReadTokens),
  };
}

function sameCounts(left: Counts, right: Counts): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheWrite === right.cacheWrite &&
    left.cacheRead === right.cacheRead
  );
}









function totalOf(counts: Counts): bigint {
  return counts.input + counts.output + counts.cacheWrite + counts.cacheRead;
}

function at(index: number, field: string): string {
  return "observations[" + String(index) + "]" + (field === "" ? "" : "." + field);
}

/**
 * Fold one effect's observations, at one cut, into one settlement revision.
 *
 * The order of the refusals is deliberate: the algorithm and the policy first,
 * because a settlement under an algorithm this module does not run would stamp
 * a version that never executed; then the request, the streams, and each
 * observation's own shape; then what needs the whole set — the cut, identity
 * duplicates, the correction graph, the effect — and last the coverage, which
 * only means something once every report is known to be one report.
 *
 * Nothing here depends on the order of the input arrays: streams, reports and
 * segments are ordered by id, ordinal and sequence before they are read. A
 * refusal's `at` indexes the caller's own array.
 */
export function foldUsageSettlement(request: UsageSettlementRequest): UsageSettlementOutcome {
  if (request.foldVersion !== USAGE_FOLD_VERSION_V1) return refuse("FOLD_VERSION_UNSUPPORTED", "foldVersion");
  if (!policyIsV1(request.policy)) return refuse("POLICY_UNSUPPORTED", "policy");
  const fault = requestFault(request);
  if (fault !== null) return refuse("REQUEST_INVALID", fault);

  const { cut, trigger, previous, lastFinalSequence } = request;

  // --- streams ---------------------------------------------------------------
  const streams = new Map<string, ObservedStream>();
  for (const [index, stream] of request.streams.entries()) {
    const prefix = "streams[" + String(index) + "].";
    const coordinate = coordinateFault(stream);
    if (coordinate !== null) return refuse("STREAM_COORDINATE_INVALID", prefix + coordinate);
    // The id is recomputed, never trusted (economy §1.1).
    if (stream.measurementStreamId !== measurementStreamIdV1(stream)) {
      return refuse("STREAM_COORDINATE_INVALID", prefix + "measurementStreamId");
    }
    if (!(USAGE_SOURCE_CLASSES as readonly string[]).includes(stream.sourceClass)) {
      return refuse("STREAM_SOURCE_CLASS_INVALID", prefix + "sourceClass");
    }
    if (streams.has(stream.measurementStreamId)) return refuse("STREAM_DUPLICATE", prefix + "measurementStreamId");
    streams.set(stream.measurementStreamId, { stream, index, entries: [] });
  }

  // --- each observation alone ------------------------------------------------
  const entries: Indexed[] = request.observations.map((observation, index) => ({ observation, index }));
  for (const { observation, index } of entries) {
    const found = observationFault(observation);
    if (found !== null) return refuse(found.reason, at(index, found.field));
  }
  for (const { observation, index } of entries) {
    const owner = streams.get(observation.measurementStreamId);
    if (owner === undefined) return refuse("STREAM_UNKNOWN", at(index, "measurementStreamId"));
    // Selected up to the cut's head and not one event past it (economy §2.3).
    if (observation.sequence > cut.controlHead.sequence) return refuse("OBSERVATION_BEYOND_CUT", at(index, "sequence"));
    owner.entries.push({ observation, index });
  }

  // --- identities: one report is one report ----------------------------------
  const byId = new Map<string, UsageObservationInput>();
  const ordinals = new Set<string>();
  const sourceReports = new Set<string>();
  for (const { observation, index } of entries) {
    if (byId.has(observation.observationId)) return refuse("OBSERVATION_DUPLICATE", at(index, "observationId"));
    byId.set(observation.observationId, observation);
    const ordinalKey = canonicalJsonStringify([observation.measurementStreamId, observation.ordinal]);
    if (ordinals.has(ordinalKey)) return refuse("ORDINAL_DUPLICATE", at(index, "ordinal"));
    ordinals.add(ordinalKey);
    const reportKey = canonicalJsonStringify([observation.measurementStreamId, observation.sourceObservationId]);
    if (sourceReports.has(reportKey)) return refuse("SOURCE_REPORT_DUPLICATE", at(index, "sourceObservationId"));
    sourceReports.add(reportKey);
  }

  // --- the correction graph --------------------------------------------------
  const correctorOf = new Map<string, UsageObservationInput>();
  for (const { observation, index } of entries) {
    if (observation.reportKind !== "CORRECTION") continue;
    const field = at(index, "correctsObservationId");
    const target = byId.get(observation.correctsObservationId ?? "");
    if (target === undefined) return refuse("CORRECTION_TARGET_UNKNOWN", field);
    if (target.measurementStreamId !== observation.measurementStreamId) return refuse("CORRECTION_CROSS_STREAM", field);
    if (target.effectId !== observation.effectId) return refuse("CORRECTION_CROSS_EFFECT", field);
    // Two ids are two reports even with the same bytes: replay by identity is
    // the door's, and a fork has no single effective value.
    if (correctorOf.has(target.observationId)) return refuse("CORRECTIONS_FORKED", field);
    correctorOf.set(target.observationId, observation);
  }
  for (const { observation, index } of entries) {
    if (observation.reportKind !== "CORRECTION") continue;
    // Every target is known by now, so a walk ends at a DELTA or CUMULATIVE,
    // or comes back to a correction it has already passed.
    const visited = new Set<string>([observation.observationId]);
    let cursor = byId.get(observation.correctsObservationId ?? "");
    while (cursor?.reportKind === "CORRECTION") {
      if (visited.has(cursor.observationId)) return refuse("CORRECTION_CYCLE", at(index, "correctsObservationId"));
      visited.add(cursor.observationId);
      cursor = byId.get(cursor.correctsObservationId ?? "");
    }
  }

  for (const { observation, index } of entries) {
    if (observation.effectId !== cut.effectId) return refuse("OBSERVATION_FOREIGN_EFFECT", at(index, "effectId"));
  }

  const observed = [...streams.values()]
    .filter((owner) => owner.entries.length > 0)
    .sort((left, right) => compareText(left.stream.measurementStreamId, right.stream.measurementStreamId));

  // --- a lineage carries one class -------------------------------------------
  const lineageClass = new Map<string, UsageSourceClass>();
  for (const { stream, index } of observed) {
    const key = canonicalJsonStringify([stream.source, stream.accountId, stream.routeSegmentId]);
    const known = lineageClass.get(key);
    if (known === undefined) lineageClass.set(key, stream.sourceClass);
    else if (known !== stream.sourceClass) {
      return refuse("STREAM_LINEAGE_CLASS_MIXED", "streams[" + String(index) + "].sourceClass");
    }
  }

  // --- coverage per stream, in ordinal order; epochs sum; lineages compete ---
  const segmentsById = new Map<string, Map<string, Lineage>>();
  for (const { stream, entries: reports } of observed) {
    const roots = reports
      .filter((entry) => entry.observation.reportKind !== "CORRECTION")
      .sort((left, right) => left.observation.ordinal - right.observation.ordinal);
    let effective: Coverage[] = [];
    for (const { observation: root, index } of roots) {
      if (root.rangeFromCounter === null || root.rangeToCounter === null) {
        return refuse("OBSERVATION_SHAPE_INVALID", at(index, "rangeFromCounter"));
      }
      // A chain of corrections ends in one effective report that replaces the
      // values before it; its coverage stays the root's.
      let last = root;
      for (let next = correctorOf.get(last.observationId); next !== undefined; next = correctorOf.get(last.observationId)) {
        last = next;
      }
      const report: Coverage = {
        from: root.rangeFromCounter,
        to: root.rangeToCounter,
        counts: countsOf(last),
        isFinal: last.isFinal,
      };
      const kept: Coverage[] = [];
      for (const earlier of effective) {
        if (report.to <= earlier.from || earlier.to <= report.from) {
          kept.push(earlier);
          continue;
        }
        // Only a CUMULATIVE replaces, and only what it contains whole. A DELTA
        // touching an effective range, a partial overlap, or a CUMULATIVE
        // strictly inside an earlier one is ambiguous, and no distribution is
        // invented to subtract it.
        const containsWhole = report.from <= earlier.from && earlier.to <= report.to;
        if (root.reportKind === "CUMULATIVE" && containsWhole) continue;
        return refuse("COVERAGE_OVERLAP", at(index, "rangeFromCounter"));
      }
      kept.push(report);
      effective = kept;
    }
    effective.sort((left, right) => left.from - right.from);

    const counts = zeroCounts();
    // One contiguous half-open interval; economy fixes no origin, so none is required.
    let gapless = true;
    let previousTo: number | null = null;
    for (const report of effective) {
      addCounts(counts, report.counts);
      if (previousTo !== null && previousTo !== report.from) gapless = false;
      previousTo = report.to;
    }
    // "Un `is_final = 1` efectivo": some effective report of the stream carries it.
    const final = effective.some((report) => report.isFinal === 1);

    let segment = segmentsById.get(stream.routeSegmentId);
    if (segment === undefined) {
      segment = new Map<string, Lineage>();
      segmentsById.set(stream.routeSegmentId, segment);
    }
    const key = canonicalJsonStringify([stream.source, stream.accountId]);
    let lineage = segment.get(key);
    if (lineage === undefined) {
      lineage = { sourceClass: stream.sourceClass, streamIds: [], counts: zeroCounts(), settled: true };
      segment.set(key, lineage);
    }
    lineage.streamIds.push(stream.measurementStreamId);
    addCounts(lineage.counts, counts);
    lineage.settled = lineage.settled && gapless && final;
  }

  // --- segments --------------------------------------------------------------
  const segments: UsageSettlementSegment[] = [];
  const total = zeroCounts();
  for (const routeSegmentId of [...segmentsById.keys()].sort(compareText)) {
    const contenders = [...(segmentsById.get(routeSegmentId)?.values() ?? [])];
    const rank = Math.min(...contenders.map((lineage) => USAGE_SOURCE_CLASSES.indexOf(lineage.sourceClass)));
    const winners = contenders
      .filter((lineage) => USAGE_SOURCE_CLASSES.indexOf(lineage.sourceClass) === rank)
      .sort((left, right) => compareText(left.streamIds[0] ?? "", right.streamIds[0] ?? ""));
    const chosen = winners[0];
    if (chosen === undefined) continue;
    if (!winners.every((lineage) => sameCounts(lineage.counts, chosen.counts))) {
      segments.push({
        routeSegmentId,
        settlementStatus: "DISPUTED",
        sourceClass: chosen.sourceClass,
        measurementStreamIds: null,
        inputTokens: null,
        outputTokens: null,
        cacheWriteTokens: null,
        cacheReadTokens: null,
        totalTokens: null,
      });
      continue;
    }
    addCounts(total, chosen.counts);
    segments.push({
      routeSegmentId,
      settlementStatus: chosen.settled ? "FINAL" : "PARTIAL",
      sourceClass: chosen.sourceClass,
      measurementStreamIds: [...chosen.streamIds],
      inputTokens: chosen.counts.input,
      outputTokens: chosen.counts.output,
      cacheWriteTokens: chosen.counts.cacheWrite,
      cacheReadTokens: chosen.counts.cacheRead,
      totalTokens: totalOf(chosen.counts),
    });
  }

  // --- the header ------------------------------------------------------------
  const countFields = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens", "totalTokens"] as const;
  for (const [position, segment] of segments.entries()) {
    for (const field of countFields) {
      const value = segment[field];
      if (value !== null && value > USAGE_SETTLEMENT_TOKENS_MAX) {
        return refuse("TOKENS_OVERFLOW", "segments[" + String(position) + "]." + field);
      }
    }
  }

  let settlementStatus: UsageSettlementStatus;
  if (entries.length === 0) settlementStatus = "UNKNOWN";
  else if (segments.some((segment) => segment.settlementStatus === "DISPUTED")) settlementStatus = "DISPUTED";
  else if (segments.every((segment) => segment.settlementStatus === "FINAL")) settlementStatus = "FINAL";
  else settlementStatus = "PARTIAL";

  const known = settlementStatus === "FINAL" || settlementStatus === "PARTIAL";
  const counts = {
    inputTokens: total.input,
    outputTokens: total.output,
    cacheWriteTokens: total.cacheWrite,
    cacheReadTokens: total.cacheRead,
    totalTokens: totalOf(total),
  };
  if (known) {
    for (const field of countFields) {
      if (counts[field] > USAGE_SETTLEMENT_TOKENS_MAX) return refuse("TOKENS_OVERFLOW", "header." + field);
    }
  }

  const considered = entries
    .map((entry) => entry.observation)
    .sort((left, right) => left.sequence - right.sequence || compareText(left.observationId, right.observationId));
  // Arrival order in the ledger, never `occurredAt` and never an ordinal.
  const hadLateArrival: 0 | 1 =
    lastFinalSequence !== null && considered.some((observation) => observation.sequence > lastFinalSequence) ? 1 : 0;

  return {
    ok: true,
    settlement: {
      header: {
        effectId: cut.effectId,
        settlementRevision: previous === null ? 1 : previous.settlementRevision + 1,
        settlementStatus,
        inputTokens: known ? counts.inputTokens : null,
        outputTokens: known ? counts.outputTokens : null,
        cacheWriteTokens: known ? counts.cacheWriteTokens : null,
        cacheReadTokens: known ? counts.cacheReadTokens : null,
        totalTokens: known ? counts.totalTokens : null,
        sourcePolicySha256: USAGE_SOURCE_POLICY_SHA256_V1,
        foldVersion: USAGE_FOLD_VERSION_V1,
        // The last considered by sequence, also when it lost or was corrected.
        lastObservationId: considered.at(-1)?.observationId ?? null,
        hadLateArrival,
        computedAt: trigger.recordedAt,
        sequence: trigger.sequence,
      },
      sourceHeads: [
        {
          sourceStream: "control_plane_events",
          sourceSequence: cut.controlHead.sequence,
          sourceSha256: cut.controlHead.sha256,
        },
      ],
      observationIds: considered.map((observation) => observation.observationId),
      segments,
    },
  };
}
