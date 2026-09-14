import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LedgerValidationError,
  USAGE_FOLD_VERSION_V1,
  USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1,
  USAGE_SETTLEMENT_REFUSALS,
  USAGE_SETTLEMENT_TOKENS_MAX,
  USAGE_SOURCE_POLICY_SHA256_V1,
  USAGE_SOURCE_POLICY_V1,
  foldUsageSettlement,
  measurementStreamIdV1,
  measurementStreamPreimageV1,
  type UsageMeasurementStreamInput,
  type UsageObservationInput,
  type UsageReportKind,
  type UsageSettlement,
  type UsageSettlementRefusal,
  type UsageSettlementRequest,
  type UsageSourceClass,
} from "../../src/index.js";

/**
 * Evidence for the usage settlement fold and the stream identity (P-32/captura A).
 *
 * The module is pure and inert: every test hands it values and reads the
 * outcome, and no ledger is opened anywhere in this file. The negatives carry
 * the Fable preaudit's numbers (N-P32A-*) and, where one exists, the map's
 * (N-P32-*), so a reader can walk from economy §1–2 to the assertion.
 *
 * Two closures run last. Every settlement this file produced is held to the
 * nullity law of economy §2.1 (N-P32A-15), and every refusal in the closed
 * vocabulary must have been produced by some test here, so the list cannot
 * carry a word nothing reaches.
 */

const EFFECT = "effect-0001";
const OTHER_EFFECT = "effect-0002";
const HEAD_SHA = "ab".repeat(32);
const GENESIS = "0".repeat(64);
const RECORDED_AT = "2026-09-13T12:00:00.000Z";
const OCCURRED_AT = "2026-09-13T11:59:00.000Z";

const produced: UsageSettlement[] = [];
const refusalsSeen = new Set<UsageSettlementRefusal>();

function stream(
  overrides: Partial<Omit<UsageMeasurementStreamInput, "measurementStreamId">> = {},
): UsageMeasurementStreamInput {
  const coordinate = {
    source: overrides.source ?? "claude-code/stream-json",
    accountId: overrides.accountId ?? "account-a",
    routeSegmentId: overrides.routeSegmentId ?? "segment-1",
    sourceEpoch: overrides.sourceEpoch ?? 0,
  };
  return {
    ...coordinate,
    measurementStreamId: measurementStreamIdV1(coordinate),
    sourceClass: overrides.sourceClass ?? "PROVIDER_AUTHORITATIVE",
  };
}

interface ReportSpec {
  readonly id: string;
  readonly ordinal: number;
  readonly sequence: number;
  readonly kind?: UsageReportKind;
  readonly from?: number | null;
  readonly to?: number | null;
  readonly corrects?: string | null;
  readonly isFinal?: 0 | 1;
  /** input, output, cache write, cache read. */
  readonly tokens?: readonly [number, number, number, number];
  readonly total?: number;
  readonly effectId?: string;
  readonly occurredAt?: string;
  readonly sourceObservationId?: string;
}

function report(owner: UsageMeasurementStreamInput, spec: ReportSpec): UsageObservationInput {
  const kind = spec.kind ?? "DELTA";
  const [input, output, cacheWrite, cacheRead] = spec.tokens ?? [1, 1, 0, 0];
  return {
    observationId: spec.id,
    measurementStreamId: owner.measurementStreamId,
    ordinal: spec.ordinal,
    sourceObservationId: spec.sourceObservationId ?? "source-" + spec.id,
    reportKind: kind,
    rangeFromCounter: spec.from !== undefined ? spec.from : kind === "CORRECTION" ? null : 0,
    rangeToCounter: spec.to !== undefined ? spec.to : kind === "CORRECTION" ? null : 10,
    correctsObservationId: spec.corrects ?? null,
    effectId: spec.effectId ?? EFFECT,
    isFinal: spec.isFinal ?? 0,
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    totalTokens: spec.total ?? input + output + cacheWrite + cacheRead,
    occurredAt: spec.occurredAt ?? OCCURRED_AT,
    recordedAt: RECORDED_AT,
    sequence: spec.sequence,
  };
}

function request(overrides: Partial<UsageSettlementRequest> = {}): UsageSettlementRequest {
  return {
    cut: { effectId: EFFECT, controlHead: { sequence: 100, sha256: HEAD_SHA } },
    trigger: { sequence: 100, recordedAt: RECORDED_AT },
    streams: [],
    observations: [],
    previous: null,
    lastFinalSequence: null,
    policy: USAGE_SOURCE_POLICY_V1,
    foldVersion: USAGE_FOLD_VERSION_V1,
    ...overrides,
  };
}

function granted(value: UsageSettlementRequest): UsageSettlement {
  const outcome = foldUsageSettlement(value);
  if (!outcome.ok) throw new Error("expected a settlement, got " + outcome.reason + " at " + outcome.at);
  produced.push(outcome.settlement);
  return outcome.settlement;
}

function refused(value: UsageSettlementRequest): { reason: UsageSettlementRefusal; at: string } {
  const outcome = foldUsageSettlement(value);
  if (outcome.ok) throw new Error("expected a refusal, got " + outcome.settlement.header.settlementStatus);
  refusalsSeen.add(outcome.reason);
  return { reason: outcome.reason, at: outcome.at };
}

function counts(settlement: UsageSettlement): (bigint | null)[] {
  const { header } = settlement;
  return [header.inputTokens, header.outputTokens, header.cacheWriteTokens, header.cacheReadTokens, header.totalTokens];
}

const S = stream();

describe("the stream identity is a versioned preimage of its coordinate (N-P32A-1)", () => {
  const coordinate = { source: "claude-code/stream-json", accountId: "account-a", routeSegmentId: "segment-1", sourceEpoch: 0 };

  it("pins the preimage and the digest by literal vector", () => {
    expect(measurementStreamPreimageV1(coordinate)).toBe(
      'acp/usage-measurement-stream/v1\n["claude-code/stream-json","account-a","segment-1",0]',
    );
    expect(measurementStreamIdV1(coordinate)).toBe("e1db2172c2dddb312d2ecf4f97b824af489b6dd4fe05f1486535ec81470dfa21");
    expect(measurementStreamIdV1({ ...coordinate, sourceEpoch: 1 })).toBe(
      "bda3abfae5f93b4e94ba5ef0dc892b9db964281d72993005feb71916e3c7c188",
    );
  });

  it("ends the prefix in exactly one LF and adds no separator", () => {
    expect(USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1).toBe("acp/usage-measurement-stream/v1\n");
    expect(USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1.split("\n")).toHaveLength(2);
    const preimage = measurementStreamPreimageV1(coordinate);
    expect(preimage.startsWith(USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1 + "[")).toBe(true);
  });

  it("moves the id when any of the four fields moves, the epoch included", () => {
    const base = measurementStreamIdV1(coordinate);
    const moved = [
      { ...coordinate, source: "codex/exec-json" },
      { ...coordinate, accountId: "account-b" },
      { ...coordinate, routeSegmentId: "segment-2" },
      { ...coordinate, sourceEpoch: 1 },
    ].map((value) => measurementStreamIdV1(value));
    expect(new Set([base, ...moved]).size).toBe(5);
    expect(measurementStreamIdV1({ ...coordinate })).toBe(base);
  });

  it("refuses an invalid coordinate by name before hashing", () => {
    const invalid: [Record<string, unknown>, string][] = [
      [{ ...coordinate, source: "" }, "source"],
      [{ ...coordinate, accountId: 7 }, "accountId"],
      [{ ...coordinate, routeSegmentId: "" }, "routeSegmentId"],
      [{ ...coordinate, sourceEpoch: -1 }, "sourceEpoch"],
      [{ ...coordinate, sourceEpoch: 1.5 }, "sourceEpoch"],
      [{ ...coordinate, sourceEpoch: -0 }, "sourceEpoch"],
      [{ ...coordinate, sourceEpoch: 2 ** 53 }, "sourceEpoch"],
    ];
    for (const [value, field] of invalid) {
      let caught: unknown;
      try {
        measurementStreamIdV1(value as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LedgerValidationError);
      const error = caught as LedgerValidationError;
      expect(error.issues[0]?.path).toBe(field);
      expect(error.issues[0]?.message.startsWith("STREAM_COORDINATE_INVALID")).toBe(true);
    }
  });

  it("recomputes a stream's id in the fold and refuses a coordinate or id that does not hold", () => {
    const tampered = { ...S, measurementStreamId: "f".repeat(64) };
    expect(refused(request({ streams: [tampered] }))).toEqual({
      reason: "STREAM_COORDINATE_INVALID",
      at: "streams[0].measurementStreamId",
    });
    expect(refused(request({ streams: [{ ...S, sourceEpoch: -1 }] }))).toEqual({
      reason: "STREAM_COORDINATE_INVALID",
      at: "streams[0].sourceEpoch",
    });
  });

  it("refuses a stream with a class outside the vocabulary, and a stream declared twice", () => {
    expect(refused(request({ streams: [{ ...S, sourceClass: "GUESS" as UsageSourceClass }] }))).toEqual({
      reason: "STREAM_SOURCE_CLASS_INVALID",
      at: "streams[0].sourceClass",
    });
    expect(refused(request({ streams: [S, S] }))).toEqual({
      reason: "STREAM_DUPLICATE",
      at: "streams[1].measurementStreamId",
    });
  });
});

describe("the policy is a literal document and the fold runs only its own version (N-P32A-16)", () => {
  it("pins the policy digest and stamps it with fold version 1", () => {
    expect(USAGE_SOURCE_POLICY_SHA256_V1).toBe("ba36f058fd5e4c876b641a4656a2a16de29c35cfebf9cb9f174dde1675292c95");
    expect(USAGE_FOLD_VERSION_V1).toBe(1);
    const settlement = granted(request());
    expect(settlement.header.sourcePolicySha256).toBe(
      "ba36f058fd5e4c876b641a4656a2a16de29c35cfebf9cb9f174dde1675292c95",
    );
    expect(settlement.header.foldVersion).toBe(1);
  });

  it("refuses another fold version", () => {
    expect(refused(request({ foldVersion: 2 }))).toEqual({ reason: "FOLD_VERSION_UNSUPPORTED", at: "foldVersion" });
  });

  it("refuses a policy with another digest, and accepts an equal document that is not the constant", () => {
    const moved = {
      ...USAGE_SOURCE_POLICY_V1,
      precedence: ["WRAPPER_MEASURED", "PROVIDER_AUTHORITATIVE", "ESTIMATE"],
    };
    expect(refused(request({ policy: moved }))).toEqual({ reason: "POLICY_UNSUPPORTED", at: "policy" });
    expect(refused(request({ policy: undefined }))).toEqual({ reason: "POLICY_UNSUPPORTED", at: "policy" });
    const copy = JSON.parse(JSON.stringify(USAGE_SOURCE_POLICY_V1)) as unknown;
    expect(granted(request({ policy: copy })).header.settlementStatus).toBe("UNKNOWN");
  });
});

describe("the request: cut, trigger and previous revision", () => {
  it("refuses a trigger past the head, a head whose digest lies about genesis, and a previous revision that is not earlier", () => {
    expect(refused(request({ trigger: { sequence: 101, recordedAt: RECORDED_AT } }))).toEqual({
      reason: "REQUEST_INVALID",
      at: "trigger.sequence",
    });
    expect(refused(request({ cut: { effectId: EFFECT, controlHead: { sequence: 100, sha256: GENESIS } } }))).toEqual({
      reason: "REQUEST_INVALID",
      at: "cut.controlHead.sha256",
    });
    expect(
      refused(request({ previous: { settlementRevision: 1, status: "PARTIAL", sequence: 100 } })),
    ).toEqual({ reason: "REQUEST_INVALID", at: "previous.sequence" });
    expect(refused(request({ lastFinalSequence: 5 }))).toEqual({ reason: "REQUEST_INVALID", at: "lastFinalSequence" });
    expect(
      refused(
        request({ previous: { settlementRevision: 2, status: "FINAL", sequence: 50 }, lastFinalSequence: 40 }),
      ),
    ).toEqual({ reason: "REQUEST_INVALID", at: "lastFinalSequence" });
  });

  it("numbers the revision as the previous one's successor", () => {
    expect(granted(request()).header.settlementRevision).toBe(1);
    const next = granted(
      request({ previous: { settlementRevision: 3, status: "PARTIAL", sequence: 60 }, lastFinalSequence: null }),
    );
    expect(next.header.settlementRevision).toBe(4);
  });
});

describe("an effect exposed without a report is UNKNOWN (N-P32A-11, N-P32-12)", () => {
  it("settles UNKNOWN with five NULL, an empty list, no last observation, revision 1 and the control row", () => {
    const settlement = granted(
      request({ trigger: { sequence: 42, recordedAt: "2026-09-13T10:00:00.000Z" }, cut: { effectId: EFFECT, controlHead: { sequence: 42, sha256: HEAD_SHA } } }),
    );
    expect(settlement).toEqual({
      header: {
        effectId: EFFECT,
        settlementRevision: 1,
        settlementStatus: "UNKNOWN",
        inputTokens: null,
        outputTokens: null,
        cacheWriteTokens: null,
        cacheReadTokens: null,
        totalTokens: null,
        sourcePolicySha256: USAGE_SOURCE_POLICY_SHA256_V1,
        foldVersion: 1,
        lastObservationId: null,
        hadLateArrival: 0,
        computedAt: "2026-09-13T10:00:00.000Z",
        sequence: 42,
      },
      sourceHeads: [{ sourceStream: "control_plane_events", sourceSequence: 42, sourceSha256: HEAD_SHA }],
      observationIds: [],
      segments: [],
    });
  });

  it("ignores a declared stream that no observation names", () => {
    const settlement = granted(request({ streams: [S] }));
    expect(settlement.header.settlementStatus).toBe("UNKNOWN");
    expect(settlement.segments).toEqual([]);
  });
});

describe("a new epoch is a new stream, and a lineage's epochs sum (N-P32A-2, N-P32-3)", () => {
  it("opens a new stream at ordinal 0 without touching the first epoch's inputs or settlement", () => {
    const epoch1 = stream({ sourceEpoch: 1 });
    expect(epoch1.measurementStreamId).not.toBe(S.measurementStreamId);
    const first = [
      report(S, { id: "e0-a", ordinal: 0, sequence: 10, from: 0, to: 10, tokens: [10, 5, 0, 0] }),
      report(S, { id: "e0-b", ordinal: 1, sequence: 11, from: 10, to: 20, tokens: [3, 2, 0, 0] }),
    ];
    const before = granted(request({ streams: [S], observations: first }));
    const inputsBefore = structuredClone({ streams: [S], observations: first });
    const beforeCopy = structuredClone(before);

    const restarted = report(epoch1, { id: "e1-a", ordinal: 0, sequence: 12, from: 0, to: 4, tokens: [7, 1, 0, 0] });
    const after = granted(
      request({
        streams: [S, epoch1],
        observations: [...first, restarted],
        previous: { settlementRevision: 1, status: "PARTIAL", sequence: 11 },
      }),
    );
    expect(after.header.inputTokens).toBe(20n);
    expect(after.header.outputTokens).toBe(8n);
    expect(after.segments[0]?.measurementStreamIds).toEqual(
      [S.measurementStreamId, epoch1.measurementStreamId].sort(),
    );
    expect({ streams: [S], observations: first }).toEqual(inputsBefore);
    expect(before).toEqual(beforeCopy);
  });
});

describe("one report is one report (N-P32A-3, N-P32-4)", () => {
  it("refuses a duplicate ordinal, a duplicate source report and a duplicate id, and never counts twice", () => {
    const a = report(S, { id: "a", ordinal: 0, sequence: 10, from: 0, to: 10 });
    expect(
      refused(request({ streams: [S], observations: [a, report(S, { id: "b", ordinal: 0, sequence: 11, from: 10, to: 20 })] })),
    ).toEqual({ reason: "ORDINAL_DUPLICATE", at: "observations[1].ordinal" });
    expect(
      refused(
        request({
          streams: [S],
          observations: [a, report(S, { id: "b", ordinal: 1, sequence: 11, from: 10, to: 20, sourceObservationId: "source-a" })],
        }),
      ),
    ).toEqual({ reason: "SOURCE_REPORT_DUPLICATE", at: "observations[1].sourceObservationId" });
    expect(refused(request({ streams: [S], observations: [a, a] }))).toEqual({
      reason: "OBSERVATION_DUPLICATE",
      at: "observations[1].observationId",
    });
  });

  it("refuses an observation of a stream nobody declared", () => {
    expect(refused(request({ streams: [], observations: [report(S, { id: "a", ordinal: 0, sequence: 10 })] }))).toEqual({
      reason: "STREAM_UNKNOWN",
      at: "observations[0].measurementStreamId",
    });
  });
});

describe("report shape (N-P32A-4, N-P32-5)", () => {
  it("refuses a DELTA without a range, an empty range, a CORRECTION with a range and a CORRECTION without a target", () => {
    const cases: [ReportSpec, string][] = [
      [{ id: "a", ordinal: 0, sequence: 10, from: null, to: null }, "observations[0].rangeFromCounter"],
      [{ id: "a", ordinal: 0, sequence: 10, from: 5, to: 5 }, "observations[0].rangeToCounter"],
      [{ id: "a", ordinal: 0, sequence: 10, from: 6, to: 5 }, "observations[0].rangeToCounter"],
      [{ id: "a", ordinal: 0, sequence: 10, kind: "CORRECTION", corrects: "x", from: 0, to: 10 }, "observations[0].rangeFromCounter"],
      [{ id: "a", ordinal: 0, sequence: 10, kind: "CORRECTION", corrects: null }, "observations[0].correctsObservationId"],
      [{ id: "a", ordinal: 0, sequence: 10, kind: "CUMULATIVE", corrects: "x" }, "observations[0].correctsObservationId"],
    ];
    for (const [spec, at] of cases) {
      expect(refused(request({ streams: [S], observations: [report(S, spec)] }))).toEqual({
        reason: "OBSERVATION_SHAPE_INVALID",
        at,
      });
    }
  });

  it("refuses an unknown kind, a non-binary final flag and an unsafe count", () => {
    const base = report(S, { id: "a", ordinal: 0, sequence: 10 });
    expect(refused(request({ streams: [S], observations: [{ ...base, reportKind: "SNAPSHOT" as UsageReportKind }] }))).toEqual({
      reason: "OBSERVATION_SHAPE_INVALID",
      at: "observations[0].reportKind",
    });
    expect(refused(request({ streams: [S], observations: [{ ...base, isFinal: 2 as 0 | 1 }] }))).toEqual({
      reason: "OBSERVATION_SHAPE_INVALID",
      at: "observations[0].isFinal",
    });
    expect(
      refused(request({ streams: [S], observations: [{ ...base, inputTokens: 2 ** 53, totalTokens: 2 ** 53 + 1 }] })),
    ).toEqual({ reason: "OBSERVATION_SHAPE_INVALID", at: "observations[0].inputTokens" });
  });
});

describe("four exclusive classes, summed in BigInt against int64 (N-P32A-5, N-P32-6)", () => {
  it("refuses a total that is not the sum, including one that leaves cached input out", () => {
    expect(
      refused(request({ streams: [S], observations: [report(S, { id: "a", ordinal: 0, sequence: 10, tokens: [100, 20, 0, 40], total: 120 })] })),
    ).toEqual({ reason: "TOTAL_MISMATCH", at: "observations[0].totalTokens" });
  });

  it("passes a sum of exactly 2^63 - 1 and refuses one token more", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const reports: UsageObservationInput[] = [];
    for (let ordinal = 0; ordinal < 1024; ordinal += 1) {
      reports.push(report(S, { id: "big-" + String(ordinal), ordinal, sequence: ordinal + 1, from: ordinal, to: ordinal + 1, tokens: [max, 0, 0, 0] }));
    }
    reports.push(report(S, { id: "tail", ordinal: 1024, sequence: 1025, from: 1024, to: 1025, tokens: [1023, 0, 0, 0] }));
    const head = { effectId: EFFECT, controlHead: { sequence: 2000, sha256: HEAD_SHA } };
    const trigger = { sequence: 2000, recordedAt: RECORDED_AT };
    const settlement = granted(request({ cut: head, trigger, streams: [S], observations: reports }));
    expect(settlement.header.inputTokens).toBe(USAGE_SETTLEMENT_TOKENS_MAX);
    expect(settlement.header.totalTokens).toBe(2n ** 63n - 1n);

    const over = [...reports, report(S, { id: "one-more", ordinal: 1025, sequence: 1026, from: 1025, to: 1026, tokens: [1, 0, 0, 0] })];
    expect(refused(request({ cut: head, trigger, streams: [S], observations: over }))).toEqual({
      reason: "TOKENS_OVERFLOW",
      at: "segments[0].inputTokens",
    });
  });

  it("refuses a header that overflows across segments even when each segment fits", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const segments = ["seg-a", "seg-b"].map((routeSegmentId) => stream({ routeSegmentId }));
    const reports: UsageObservationInput[] = [];
    let sequence = 1;
    for (const owner of segments) {
      for (let ordinal = 0; ordinal < 600; ordinal += 1) {
        reports.push(report(owner, { id: owner.routeSegmentId + "-" + String(ordinal), ordinal, sequence, from: ordinal, to: ordinal + 1, tokens: [max, 0, 0, 0] }));
        sequence += 1;
      }
    }
    const head = { effectId: EFFECT, controlHead: { sequence: 5000, sha256: HEAD_SHA } };
    expect(
      refused(request({ cut: head, trigger: { sequence: 5000, recordedAt: RECORDED_AT }, streams: segments, observations: reports })),
    ).toEqual({ reason: "TOKENS_OVERFLOW", at: "header.inputTokens" });
  });

  it("publishes the total as the sum of the four classes and derives none from another", () => {
    const settlement = granted(
      request({ streams: [S], observations: [report(S, { id: "a", ordinal: 0, sequence: 10, tokens: [100, 20, 7, 40] })] }),
    );
    expect(counts(settlement)).toEqual([100n, 20n, 7n, 40n, 167n]);
  });
});

describe("a correction stays in its stream and its effect, without cycles (N-P32A-6, N-P32-7)", () => {
  const other = stream({ source: "wrapper", sourceClass: "WRAPPER_MEASURED" });
  const target = report(S, { id: "t", ordinal: 0, sequence: 10 });

  it("refuses a correction of an unknown report", () => {
    const correction = report(S, { id: "c", ordinal: 1, sequence: 11, kind: "CORRECTION", corrects: "missing" });
    expect(refused(request({ streams: [S], observations: [target, correction] }))).toEqual({
      reason: "CORRECTION_TARGET_UNKNOWN",
      at: "observations[1].correctsObservationId",
    });
  });

  it("refuses a correction of another stream's report", () => {
    const correction = report(other, { id: "c", ordinal: 0, sequence: 11, kind: "CORRECTION", corrects: "t" });
    expect(refused(request({ streams: [S, other], observations: [target, correction] }))).toEqual({
      reason: "CORRECTION_CROSS_STREAM",
      at: "observations[1].correctsObservationId",
    });
  });

  it("refuses a correction of another effect's report by that name, not as a foreign observation", () => {
    const foreign = report(S, { id: "t", ordinal: 0, sequence: 10, effectId: OTHER_EFFECT });
    const correction = report(S, { id: "c", ordinal: 1, sequence: 11, kind: "CORRECTION", corrects: "t" });
    expect(refused(request({ streams: [S], observations: [foreign, correction] }))).toEqual({
      reason: "CORRECTION_CROSS_EFFECT",
      at: "observations[1].correctsObservationId",
    });
  });

  it("refuses a cycle and a report that corrects itself", () => {
    const one = report(S, { id: "c1", ordinal: 0, sequence: 10, kind: "CORRECTION", corrects: "c2" });
    const two = report(S, { id: "c2", ordinal: 1, sequence: 11, kind: "CORRECTION", corrects: "c1" });
    expect(refused(request({ streams: [S], observations: [one, two] }))).toEqual({
      reason: "CORRECTION_CYCLE",
      at: "observations[0].correctsObservationId",
    });
    const self = report(S, { id: "self", ordinal: 0, sequence: 10, kind: "CORRECTION", corrects: "self" });
    expect(refused(request({ streams: [S], observations: [self] }))).toEqual({
      reason: "CORRECTION_CYCLE",
      at: "observations[0].correctsObservationId",
    });
  });
});

describe("coverage inside a stream (N-P32A-7, N-P32-8)", () => {
  function overlap(first: ReportSpec, second: ReportSpec): { reason: UsageSettlementRefusal; at: string } {
    return refused(request({ streams: [S], observations: [report(S, first), report(S, second)] }));
  }

  it("refuses a partial DELTA/DELTA overlap", () => {
    expect(overlap({ id: "a", ordinal: 0, sequence: 10, from: 0, to: 10 }, { id: "b", ordinal: 1, sequence: 11, from: 5, to: 15 })).toEqual({
      reason: "COVERAGE_OVERLAP",
      at: "observations[1].rangeFromCounter",
    });
  });

  it("refuses a partial DELTA/CUMULATIVE overlap", () => {
    expect(
      overlap({ id: "a", ordinal: 0, sequence: 10, from: 0, to: 10 }, { id: "b", ordinal: 1, sequence: 11, kind: "CUMULATIVE", from: 5, to: 15 }).reason,
    ).toBe("COVERAGE_OVERLAP");
  });

  it("refuses a CUMULATIVE strictly inside an earlier one", () => {
    expect(
      overlap(
        { id: "a", ordinal: 0, sequence: 10, kind: "CUMULATIVE", from: 0, to: 20 },
        { id: "b", ordinal: 1, sequence: 11, kind: "CUMULATIVE", from: 5, to: 10 },
      ).reason,
    ).toBe("COVERAGE_OVERLAP");
  });

  it("refuses a later DELTA inside an earlier CUMULATIVE: only a CUMULATIVE replaces", () => {
    expect(
      overlap({ id: "a", ordinal: 0, sequence: 10, kind: "CUMULATIVE", from: 0, to: 20 }, { id: "b", ordinal: 1, sequence: 11, from: 0, to: 20 }).reason,
    ).toBe("COVERAGE_OVERLAP");
  });

  it("lets a CUMULATIVE that contains two DELTAs whole replace them: its total, not the sum", () => {
    const settlement = granted(
      request({
        streams: [S],
        observations: [
          report(S, { id: "d1", ordinal: 0, sequence: 10, from: 0, to: 10, tokens: [10, 0, 0, 0] }),
          report(S, { id: "d2", ordinal: 1, sequence: 11, from: 10, to: 20, tokens: [15, 0, 0, 0] }),
          report(S, { id: "c", ordinal: 2, sequence: 12, kind: "CUMULATIVE", from: 0, to: 20, tokens: [30, 0, 0, 0] }),
        ],
      }),
    );
    expect(counts(settlement)).toEqual([30n, 0n, 0n, 0n, 30n]);
    expect(settlement.observationIds).toEqual(["d1", "d2", "c"]);
  });

  it("orders by ordinal, not by arrival: an earlier DELTA arriving after its CUMULATIVE is still replaced", () => {
    const settlement = granted(
      request({
        streams: [S],
        observations: [
          report(S, { id: "cum", ordinal: 1, sequence: 10, kind: "CUMULATIVE", from: 0, to: 20, tokens: [30, 0, 0, 0] }),
          report(S, { id: "late-delta", ordinal: 0, sequence: 12, from: 0, to: 10, tokens: [10, 0, 0, 0] }),
        ],
      }),
    );
    expect(settlement.header.totalTokens).toBe(30n);
  });
});

describe("corrections resolve to one effective report (N-P32A-8, N-P32-9)", () => {
  it("refuses two corrections of one report, even with the same bytes", () => {
    const target = report(S, { id: "t", ordinal: 0, sequence: 10 });
    const one = report(S, { id: "c1", ordinal: 1, sequence: 11, kind: "CORRECTION", corrects: "t", tokens: [5, 0, 0, 0] });
    const two = report(S, { id: "c2", ordinal: 2, sequence: 12, kind: "CORRECTION", corrects: "t", tokens: [5, 0, 0, 0] });
    expect(refused(request({ streams: [S], observations: [target, one, two] }))).toEqual({
      reason: "CORRECTIONS_FORKED",
      at: "observations[2].correctsObservationId",
    });
  });

  it("takes C's values and A's coverage from the chain A <- B <- C, and lists all three", () => {
    const settlement = granted(
      request({
        streams: [S],
        observations: [
          report(S, { id: "A", ordinal: 0, sequence: 10, from: 0, to: 10, tokens: [10, 0, 0, 0] }),
          report(S, { id: "B", ordinal: 1, sequence: 11, kind: "CORRECTION", corrects: "A", tokens: [20, 0, 0, 0] }),
          report(S, { id: "C", ordinal: 2, sequence: 12, kind: "CORRECTION", corrects: "B", tokens: [30, 1, 0, 0], isFinal: 1 }),
          report(S, { id: "D", ordinal: 3, sequence: 13, from: 10, to: 20, tokens: [1, 0, 0, 0], isFinal: 1 }),
        ],
      }),
    );
    expect(counts(settlement)).toEqual([31n, 1n, 0n, 0n, 32n]);
    // D's range starts where A's ends, so A's coverage is what C carries.
    expect(settlement.header.settlementStatus).toBe("FINAL");
    expect(settlement.observationIds).toEqual(["A", "B", "C", "D"]);
  });
});

describe("sources are alternatives, never addends (N-P32A-9, N-P32-10)", () => {
  const provider = stream({ source: "provider", sourceClass: "PROVIDER_AUTHORITATIVE" });
  const wrapper = stream({ source: "wrapper", sourceClass: "WRAPPER_MEASURED" });
  const estimate = stream({ source: "estimate", sourceClass: "ESTIMATE" });

  it("takes the provider's counts over the wrapper's, keeps both in the list and never sums", () => {
    const settlement = granted(
      request({
        streams: [wrapper, provider, estimate],
        observations: [
          report(wrapper, { id: "w", ordinal: 0, sequence: 10, tokens: [90, 10, 0, 0] }),
          report(provider, { id: "p", ordinal: 0, sequence: 11, tokens: [100, 12, 0, 0] }),
          report(estimate, { id: "e", ordinal: 0, sequence: 12, tokens: [80, 8, 0, 0] }),
        ],
      }),
    );
    expect(counts(settlement)).toEqual([100n, 12n, 0n, 0n, 112n]);
    expect(settlement.observationIds).toEqual(["w", "p", "e"]);
    expect(settlement.segments).toEqual([
      {
        routeSegmentId: "segment-1",
        settlementStatus: "PARTIAL",
        sourceClass: "PROVIDER_AUTHORITATIVE",
        measurementStreamIds: [provider.measurementStreamId],
        inputTokens: 100n,
        outputTokens: 12n,
        cacheWriteTokens: 0n,
        cacheReadTokens: 0n,
        totalTokens: 112n,
      },
    ]);
  });

  it("settles DISPUTED with five NULL when two lineages of equal class disagree, both listed", () => {
    const second = stream({ source: "provider-mirror", sourceClass: "PROVIDER_AUTHORITATIVE" });
    const settlement = granted(
      request({
        streams: [provider, second],
        observations: [
          report(provider, { id: "p1", ordinal: 0, sequence: 10, tokens: [100, 0, 0, 0], isFinal: 1 }),
          report(second, { id: "p2", ordinal: 0, sequence: 11, tokens: [101, 0, 0, 0], isFinal: 1 }),
        ],
      }),
    );
    expect(settlement.header.settlementStatus).toBe("DISPUTED");
    expect(counts(settlement)).toEqual([null, null, null, null, null]);
    expect(settlement.observationIds).toEqual(["p1", "p2"]);
    expect(settlement.segments[0]).toMatchObject({ settlementStatus: "DISPUTED", measurementStreamIds: null, totalTokens: null });
  });

  it("chooses deterministically, by least stream id, between equal-class lineages that agree", () => {
    const second = stream({ source: "provider-mirror", sourceClass: "PROVIDER_AUTHORITATIVE" });
    const settlement = granted(
      request({
        streams: [provider, second],
        observations: [
          report(provider, { id: "p1", ordinal: 0, sequence: 10, tokens: [100, 3, 0, 0] }),
          report(second, { id: "p2", ordinal: 0, sequence: 11, tokens: [100, 3, 0, 0] }),
        ],
      }),
    );
    expect(settlement.header.settlementStatus).toBe("PARTIAL");
    expect(settlement.header.totalTokens).toBe(103n);
    const least = [provider.measurementStreamId, second.measurementStreamId].sort()[0];
    expect(settlement.segments[0]?.measurementStreamIds).toEqual([least]);
  });

  it("refuses a lineage whose epochs declare different classes", () => {
    const epoch1 = stream({ source: "provider", sourceEpoch: 1, sourceClass: "ESTIMATE" });
    const outcome = refused(
      request({
        streams: [provider, epoch1],
        observations: [
          report(provider, { id: "a", ordinal: 0, sequence: 10 }),
          report(epoch1, { id: "b", ordinal: 0, sequence: 11 }),
        ],
      }),
    );
    expect(outcome.reason).toBe("STREAM_LINEAGE_CLASS_MIXED");
    expect(outcome.at.endsWith("].sourceClass")).toBe(true);
  });
});

describe("FINAL needs a gapless coverage and an explicit final in every elected stream (N-P32A-10, N-P32-11)", () => {
  it("is PARTIAL when the coverage is contiguous but no report says final — the process ending is not a final", () => {
    const settlement = granted(
      request({
        streams: [S],
        observations: [
          report(S, { id: "a", ordinal: 0, sequence: 10, from: 0, to: 10 }),
          report(S, { id: "b", ordinal: 1, sequence: 11, from: 10, to: 20 }),
        ],
      }),
    );
    expect(settlement.header.settlementStatus).toBe("PARTIAL");
  });

  it("is PARTIAL when a report says final over a gap", () => {
    const settlement = granted(
      request({
        streams: [S],
        observations: [
          report(S, { id: "a", ordinal: 0, sequence: 10, from: 0, to: 10 }),
          report(S, { id: "b", ordinal: 1, sequence: 11, from: 15, to: 20, isFinal: 1 }),
        ],
      }),
    );
    expect(settlement.header.settlementStatus).toBe("PARTIAL");
  });

  it("is FINAL when the coverage is contiguous and a report says final", () => {
    const settlement = granted(
      request({
        streams: [S],
        observations: [
          report(S, { id: "a", ordinal: 0, sequence: 10, from: 0, to: 10 }),
          report(S, { id: "b", ordinal: 1, sequence: 11, from: 10, to: 20, isFinal: 1 }),
        ],
      }),
    );
    expect(settlement.header.settlementStatus).toBe("FINAL");
  });

  it("is PARTIAL when one of two elected streams has no final — across epochs and across segments", () => {
    const epoch1 = stream({ sourceEpoch: 1 });
    const acrossEpochs = granted(
      request({
        streams: [S, epoch1],
        observations: [
          report(S, { id: "a", ordinal: 0, sequence: 10, isFinal: 1 }),
          report(epoch1, { id: "b", ordinal: 0, sequence: 11, isFinal: 0 }),
        ],
      }),
    );
    expect(acrossEpochs.header.settlementStatus).toBe("PARTIAL");

    const second = stream({ routeSegmentId: "segment-2" });
    const acrossSegments = granted(
      request({
        streams: [S, second],
        observations: [
          report(S, { id: "a", ordinal: 0, sequence: 10, isFinal: 1 }),
          report(second, { id: "b", ordinal: 0, sequence: 11, isFinal: 0 }),
        ],
      }),
    );
    expect(acrossSegments.header.settlementStatus).toBe("PARTIAL");
    expect(acrossSegments.segments.map((segment) => segment.settlementStatus)).toEqual(["FINAL", "PARTIAL"]);
  });

  it("drops a final flag a correction withdraws", () => {
    const settlement = granted(
      request({
        streams: [S],
        observations: [
          report(S, { id: "a", ordinal: 0, sequence: 10, isFinal: 1 }),
          report(S, { id: "c", ordinal: 1, sequence: 11, kind: "CORRECTION", corrects: "a", isFinal: 0 }),
        ],
      }),
    );
    expect(settlement.header.settlementStatus).toBe("PARTIAL");
  });
});

describe("a late report revises and never rewrites (N-P32A-12, N-P32-13)", () => {
  const first = report(S, { id: "a", ordinal: 0, sequence: 20, from: 0, to: 10, tokens: [10, 0, 0, 0], isFinal: 1 });

  it("opens revision n+1 with had_late_arrival = 1 and leaves revision n deep-equal", () => {
    const final = granted(
      request({ cut: { effectId: EFFECT, controlHead: { sequence: 20, sha256: HEAD_SHA } }, trigger: { sequence: 20, recordedAt: RECORDED_AT }, streams: [S], observations: [first] }),
    );
    expect(final.header.settlementStatus).toBe("FINAL");
    const snapshot = structuredClone(final);

    const late = report(S, { id: "b", ordinal: 1, sequence: 25, from: 10, to: 12, tokens: [2, 0, 0, 0], isFinal: 1 });
    const revised = granted(
      request({
        cut: { effectId: EFFECT, controlHead: { sequence: 25, sha256: HEAD_SHA } },
        trigger: { sequence: 25, recordedAt: "2026-09-13T12:05:00.000Z" },
        streams: [S],
        observations: [first, late],
        previous: { settlementRevision: 1, status: "FINAL", sequence: 20 },
        lastFinalSequence: 20,
      }),
    );
    expect(revised.header.settlementRevision).toBe(2);
    expect(revised.header.hadLateArrival).toBe(1);
    expect(revised.header.totalTokens).toBe(12n);
    expect(final).toEqual(snapshot);
  });

  it("does not mark an old occurred_at that arrived before the FINAL", () => {
    const old = report(S, { id: "old", ordinal: 1, sequence: 18, from: 10, to: 12, occurredAt: "1999-01-01T00:00:00.000Z", isFinal: 1 });
    const settlement = granted(
      request({
        cut: { effectId: EFFECT, controlHead: { sequence: 31, sha256: HEAD_SHA } },
        trigger: { sequence: 31, recordedAt: RECORDED_AT },
        streams: [S],
        observations: [first, old],
        previous: { settlementRevision: 2, status: "FINAL", sequence: 30 },
        lastFinalSequence: 30,
      }),
    );
    expect(settlement.header.hadLateArrival).toBe(0);
  });

  it("does not mark the observation whose event produced the FINAL: it is not late to itself", () => {
    const settlement = granted(
      request({
        cut: { effectId: EFFECT, controlHead: { sequence: 21, sha256: HEAD_SHA } },
        trigger: { sequence: 21, recordedAt: RECORDED_AT },
        streams: [S],
        observations: [first],
        previous: { settlementRevision: 1, status: "FINAL", sequence: 20 },
        lastFinalSequence: 20,
      }),
    );
    expect(settlement.header.hadLateArrival).toBe(0);
    expect(settlement.header.settlementRevision).toBe(2);
  });

  it("never marks without an earlier FINAL revision, whatever the instants say", () => {
    const old = report(S, { id: "old", ordinal: 1, sequence: 40, from: 10, to: 12, occurredAt: "1999-01-01T00:00:00.000Z" });
    const settlement = granted(
      request({
        streams: [S],
        observations: [first, old],
        previous: { settlementRevision: 1, status: "PARTIAL", sequence: 20 },
        lastFinalSequence: null,
      }),
    );
    expect(settlement.header.hadLateArrival).toBe(0);
  });
});

describe("a historical cut folds only what its head held (N-P32A-13, N-P32-14)", () => {
  const a = report(S, { id: "a", ordinal: 0, sequence: 10, from: 0, to: 10, tokens: [10, 0, 0, 0] });
  const b = report(S, { id: "b", ordinal: 1, sequence: 25, from: 10, to: 20, tokens: [5, 0, 0, 0] });
  const atH1 = request({ cut: { effectId: EFFECT, controlHead: { sequence: 20, sha256: "11".repeat(32) } }, trigger: { sequence: 20, recordedAt: RECORDED_AT }, streams: [S], observations: [a] });

  it("re-folds the H1 cut to byte-identical header, vector and list after H2 was folded", () => {
    const first = granted(atH1);
    const later = granted(
      request({
        cut: { effectId: EFFECT, controlHead: { sequence: 30, sha256: "22".repeat(32) } },
        trigger: { sequence: 30, recordedAt: RECORDED_AT },
        streams: [S],
        observations: [a, b],
        previous: { settlementRevision: 1, status: "PARTIAL", sequence: 20 },
      }),
    );
    expect(later.observationIds).toEqual(["a", "b"]);
    const again = granted(atH1);
    expect(again).toEqual(first);
    expect(again.sourceHeads).toEqual([{ sourceStream: "control_plane_events", sourceSequence: 20, sourceSha256: "11".repeat(32) }]);
    expect(again.observationIds).toEqual(["a"]);
  });

  it("refuses an observation past the head", () => {
    expect(refused({ ...atH1, observations: [a, b] })).toEqual({ reason: "OBSERVATION_BEYOND_CUT", at: "observations[1].sequence" });
  });

  it("refuses an observation of another effect", () => {
    const foreign = report(S, { id: "f", ordinal: 1, sequence: 11, from: 10, to: 20, effectId: OTHER_EFFECT });
    expect(refused({ ...atH1, observations: [a, foreign] })).toEqual({
      reason: "OBSERVATION_FOREIGN_EFFECT",
      at: "observations[1].effectId",
    });
  });
});

describe("the fold is deterministic (N-P32A-14, N-P32-16 fold wing)", () => {
  it("returns deep-equal settlements for the same inputs twice and in any array order", () => {
    const wrapper = stream({ source: "wrapper", sourceClass: "WRAPPER_MEASURED" });
    const second = stream({ routeSegmentId: "segment-2" });
    const streams = [S, wrapper, second];
    const observations = [
      report(S, { id: "a", ordinal: 0, sequence: 10, from: 0, to: 10, tokens: [4, 1, 0, 2] }),
      report(S, { id: "b", ordinal: 1, sequence: 13, kind: "CUMULATIVE", from: 0, to: 20, tokens: [9, 2, 1, 2], isFinal: 1 }),
      report(wrapper, { id: "w", ordinal: 0, sequence: 11, tokens: [7, 7, 7, 7] }),
      report(second, { id: "s", ordinal: 0, sequence: 12, tokens: [1, 1, 1, 1], isFinal: 1 }),
      report(second, { id: "s-fix", ordinal: 1, sequence: 14, kind: "CORRECTION", corrects: "s", tokens: [2, 1, 1, 1], isFinal: 1 }),
    ];
    const forward = granted(request({ streams, observations }));
    const twice = granted(request({ streams, observations }));
    const reversed = granted(request({ streams: [...streams].reverse(), observations: [...observations].reverse() }));
    expect(twice).toEqual(forward);
    expect(reversed).toEqual(forward);
    expect(forward.header.settlementStatus).toBe("FINAL");
    expect(counts(forward)).toEqual([11n, 3n, 2n, 3n, 19n]);
  });
});

describe("what sums and what competes (N-P32A-18)", () => {
  it("sums two elected segments and exposes each", () => {
    const second = stream({ routeSegmentId: "segment-2" });
    const settlement = granted(
      request({
        streams: [S, second],
        observations: [
          report(S, { id: "a", ordinal: 0, sequence: 10, tokens: [10, 1, 0, 0] }),
          report(second, { id: "b", ordinal: 0, sequence: 11, tokens: [20, 2, 0, 0] }),
        ],
      }),
    );
    expect(counts(settlement)).toEqual([30n, 3n, 0n, 0n, 33n]);
    expect(settlement.segments.map((segment) => [segment.routeSegmentId, segment.totalTokens])).toEqual([
      ["segment-1", 11n],
      ["segment-2", 22n],
    ]);
  });

  it("sums two epochs of one lineage instead of letting them compete", () => {
    const epoch1 = stream({ sourceEpoch: 1 });
    const settlement = granted(
      request({
        streams: [S, epoch1],
        observations: [
          report(S, { id: "a", ordinal: 0, sequence: 10, from: 0, to: 10, tokens: [10, 0, 0, 0] }),
          report(epoch1, { id: "b", ordinal: 0, sequence: 11, from: 0, to: 10, tokens: [10, 0, 0, 0] }),
        ],
      }),
    );
    expect(settlement.header.inputTokens).toBe(20n);
    expect(settlement.header.settlementStatus).toBe("PARTIAL");
  });

  it("reads the class from the stream: an observation's stray class decides nothing", () => {
    const a = stream({ source: "a", sourceClass: "WRAPPER_MEASURED" });
    const b = stream({ source: "b", sourceClass: "ESTIMATE" });
    const observations = [
      { ...report(a, { id: "x", ordinal: 0, sequence: 10, tokens: [5, 0, 0, 0] }), sourceClass: "ESTIMATE" },
      { ...report(b, { id: "y", ordinal: 0, sequence: 11, tokens: [9, 0, 0, 0] }), sourceClass: "PROVIDER_AUTHORITATIVE" },
    ];
    expect(granted(request({ streams: [a, b], observations })).header.inputTokens).toBe(5n);
    const promoted = { ...b, sourceClass: "PROVIDER_AUTHORITATIVE" as const };
    expect(granted(request({ streams: [a, promoted], observations })).header.inputTokens).toBe(9n);
  });
});

describe("no clock (N-P32A-19)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps computed_at with the trigger's instant byte for byte, whatever the system clock reads", () => {
    const value = request({ trigger: { sequence: 100, recordedAt: "2026-09-13T08:07:06.123Z" } });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
    const one = granted(value);
    vi.setSystemTime(new Date("2040-06-06T06:06:06.000Z"));
    const two = granted(value);
    expect(one.header.computedAt).toBe("2026-09-13T08:07:06.123Z");
    expect(two).toEqual(one);
  });
});

describe("the last observation is the last considered, won or lost (N-P32A-20)", () => {
  it("names a report that lost by precedence", () => {
    const provider = stream({ source: "provider" });
    const wrapper = stream({ source: "wrapper", sourceClass: "WRAPPER_MEASURED" });
    const settlement = granted(
      request({
        streams: [provider, wrapper],
        observations: [
          report(provider, { id: "winner", ordinal: 0, sequence: 10 }),
          report(wrapper, { id: "loser", ordinal: 0, sequence: 12 }),
        ],
      }),
    );
    expect(settlement.header.lastObservationId).toBe("loser");
    expect(settlement.header.sequence).toBe(100);
  });

  it("names a report a CUMULATIVE replaced", () => {
    const settlement = granted(
      request({
        streams: [S],
        observations: [
          report(S, { id: "cum", ordinal: 1, sequence: 10, kind: "CUMULATIVE", from: 0, to: 20 }),
          report(S, { id: "replaced", ordinal: 0, sequence: 15, from: 0, to: 10 }),
        ],
      }),
    );
    expect(settlement.header.lastObservationId).toBe("replaced");
  });

  it("names a corrected report when it is the last by sequence", () => {
    const settlement = granted(
      request({
        streams: [S],
        observations: [
          report(S, { id: "fix", ordinal: 1, sequence: 10, kind: "CORRECTION", corrects: "corrected" }),
          report(S, { id: "corrected", ordinal: 0, sequence: 11 }),
        ],
      }),
    );
    expect(settlement.header.lastObservationId).toBe("corrected");
  });
});

describe("partial, cumulative, with a correction and a late arrival: one correct settlement, no double count, the lateness visible (N-P32A-17, E16)", () => {
  it("settles each revision exactly", () => {
    const head = (sequence: number) => ({ effectId: EFFECT, controlHead: { sequence, sha256: HEAD_SHA } });
    const trigger = (sequence: number) => ({ sequence, recordedAt: "2026-09-13T12:00:" + String(sequence).padStart(2, "0") + ".000Z" });

    const exposure = granted(request({ cut: head(10), trigger: trigger(10), streams: [S] }));
    expect(exposure.header).toMatchObject({ settlementRevision: 1, settlementStatus: "UNKNOWN", hadLateArrival: 0, totalTokens: null });
    expect(exposure.observationIds).toHaveLength(0);

    const partial = report(S, { id: "partial", ordinal: 0, sequence: 11, from: 0, to: 100, tokens: [50, 30, 10, 10] });
    const r2 = granted(
      request({ cut: head(11), trigger: trigger(11), streams: [S], observations: [partial], previous: { settlementRevision: 1, status: "UNKNOWN", sequence: 10 } }),
    );
    expect(r2.header).toMatchObject({ settlementRevision: 2, settlementStatus: "PARTIAL", hadLateArrival: 0 });
    expect(counts(r2)).toEqual([50n, 30n, 10n, 10n, 100n]);
    expect(r2.observationIds).toHaveLength(1);

    const cumulative = report(S, { id: "cumulative", ordinal: 1, sequence: 12, kind: "CUMULATIVE", from: 0, to: 200, tokens: [90, 60, 20, 30] });
    const r3 = granted(
      request({ cut: head(12), trigger: trigger(12), streams: [S], observations: [partial, cumulative], previous: { settlementRevision: 2, status: "PARTIAL", sequence: 11 } }),
    );
    // 200, not 300: the cumulative replaces the partial it contains.
    expect(r3.header).toMatchObject({ settlementRevision: 3, settlementStatus: "PARTIAL", hadLateArrival: 0 });
    expect(counts(r3)).toEqual([90n, 60n, 20n, 30n, 200n]);
    expect(r3.observationIds).toHaveLength(2);

    const correction = report(S, { id: "correction", ordinal: 2, sequence: 13, kind: "CORRECTION", corrects: "cumulative", tokens: [95, 60, 20, 30], isFinal: 1 });
    const r4 = granted(
      request({
        cut: head(13),
        trigger: trigger(13),
        streams: [S],
        observations: [partial, cumulative, correction],
        previous: { settlementRevision: 3, status: "PARTIAL", sequence: 12 },
      }),
    );
    expect(r4.header).toMatchObject({ settlementRevision: 4, settlementStatus: "FINAL", hadLateArrival: 0 });
    expect(counts(r4)).toEqual([95n, 60n, 20n, 30n, 205n]);
    expect(r4.observationIds).toHaveLength(3);
    const r4Snapshot = structuredClone(r4);

    const late = report(S, { id: "late", ordinal: 3, sequence: 14, from: 200, to: 250, tokens: [10, 5, 0, 0], isFinal: 1, occurredAt: "2026-09-13T11:00:00.000Z" });
    const r5 = granted(
      request({
        cut: head(14),
        trigger: trigger(14),
        streams: [S],
        observations: [partial, cumulative, correction, late],
        previous: { settlementRevision: 4, status: "FINAL", sequence: 13 },
        lastFinalSequence: 13,
      }),
    );
    expect(r5.header).toMatchObject({ settlementRevision: 5, settlementStatus: "FINAL", hadLateArrival: 1, lastObservationId: "late" });
    expect(counts(r5)).toEqual([105n, 65n, 20n, 30n, 220n]);
    expect(r5.observationIds).toEqual(["partial", "cumulative", "correction", "late"]);
    expect(r4).toEqual(r4Snapshot);
  });
});

describe("closures over the whole suite", () => {
  it("N-P32A-15 (N-P32-17 as a property): five NULL iff UNKNOWN or DISPUTED, and known counts add up", () => {
    expect(produced.length).toBeGreaterThan(30);
    const statuses = new Set<string>();
    for (const settlement of produced) {
      const { header } = settlement;
      statuses.add(header.settlementStatus);
      const five = counts(settlement);
      if (header.settlementStatus === "UNKNOWN" || header.settlementStatus === "DISPUTED") {
        expect(five).toEqual([null, null, null, null, null]);
      } else {
        for (const value of five) {
          expect(typeof value).toBe("bigint");
          expect(value! >= 0n).toBe(true);
        }
        const [input, output, cacheWrite, cacheRead, total] = five as bigint[];
        expect(total).toBe(input! + output! + cacheWrite! + cacheRead!);
      }
    }
    expect([...statuses].sort()).toEqual(["DISPUTED", "FINAL", "PARTIAL", "UNKNOWN"]);
  });

  it("the refusal vocabulary is sorted, closed, and every word in it was produced above", () => {
    expect([...USAGE_SETTLEMENT_REFUSALS].sort()).toEqual([...USAGE_SETTLEMENT_REFUSALS]);
    expect([...refusalsSeen].sort()).toEqual([...USAGE_SETTLEMENT_REFUSALS]);
  });
});
