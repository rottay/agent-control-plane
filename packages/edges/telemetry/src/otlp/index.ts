import type { TelemetryBatch, TelemetryEvent, TelemetryStatus } from "@acp/observation";

import { OTLP_SCOPE_NAME } from "../contract/index.js";

/**
 * The OTLP/JSON mapping, hand-rolled and pure (V2-B5/R11).
 *
 * The only module in this package that knows OTel's vocabulary, and the only
 * one that would change if that vocabulary did. It opens nothing, parses no
 * URL, reads no clock and touches no filesystem: it takes a `TelemetryBatch`
 * and returns a string and three counts.
 *
 * **Hand-rolled rather than taken from an SDK**, on the same precedent this
 * repository already set twice for provider wire protocols and once for MCP.
 * OTLP/JSON is `resourceSpans[] -> scopeSpans[] -> spans[]`, and the whole
 * mapping is the six decisions below. An SDK would bring a dependency, a
 * transport, a batcher and a clock — every one of which this edge refuses on
 * purpose.
 *
 * ## The six mappings, each a decision
 *
 * 1. **Ids pass through.** OTLP/JSON carries trace and span ids as hex strings.
 *    The emitter already produces 32 and 16 lowercase hex characters, never
 *    all-zero, so there is nothing to re-encode and nothing to pad. Re-encoding
 *    would be a second opinion about an identity the ledger already fixed.
 * 2. **Times are decimal digit strings.** See {@link epochNanosOf}: this is the
 *    sharpest trap in the packet and it has its own argument.
 * 3. **Status maps one to one.** `UNSET|OK|ERROR` are OTel's own three codes,
 *    which is what the upstream type says of itself, so the mapping is
 *    `0|1|2` and carries no judgement.
 * 4. **Every span is `kind: 1`.** OTel's `SpanKind` and OpenInference's span
 *    kind are different vocabularies. Mapping `"AGENT"` or `"TOOL"` onto
 *    `SERVER`/`CLIENT`/`PRODUCER`/`CONSUMER` would invent a correspondence
 *    neither convention states, and `openinference.span.kind` stays the
 *    attribute it already is. A conventional field filled with a value that
 *    does not carry that meaning looks standard and is false.
 * 5. **Attributes keep the order they arrive in.** The emitter sorts its keys
 *    before freezing, so iteration order is already deterministic and the
 *    mapping inherits byte-determinism rather than re-establishing it. Value
 *    encoding follows the JSON mapping: `stringValue`, `boolValue`,
 *    `intValue` as a JSON **string** for integers, `doubleValue` for the rest.
 * 6. **The resource says who, and what was withheld.** `service.name` is a real
 *    OTel resource key and is honest here. The three counters beside it are
 *    `acp.`-namespaced, and they exist so a reader of the vendor surface can
 *    see that something was withheld without the vendor surface being told
 *    what — the Langfuse precedent, and the only honest place for a batch-level
 *    fact in a per-span format.
 */

/** What the serializer produces: the bytes, and what they account for. */
export interface OtlpSerialization {
  /** The request body, ready to be posted verbatim. */
  readonly body: string;
  /** How many spans the body carries. */
  readonly spanCount: number;
  /** Events with no span context, dropped and counted rather than invented. */
  readonly unexportableCount: number;
  /** The body's size in bytes, measured on the encoded form. */
  readonly bytes: number;
}

/** An attribute value in OTLP's `AnyValue` JSON encoding. */
type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number };

interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtlpKeyValue[];
  readonly status: { readonly code: number };
}

/** OTel's three span status codes, in the order the upstream type declares. */
const OTLP_STATUS_CODES: Readonly<Record<TelemetryStatus, number>> = Object.freeze({
  UNSET: 0,
  OK: 1,
  ERROR: 2,
});

/**
 * Every span is internal. See mapping 4 above.
 *
 * `SPAN_KIND_INTERNAL` is `1` in OTLP's enum. It is named as a constant so a
 * reader sees a decision rather than a number somebody typed into an object.
 */
const OTLP_SPAN_KIND_INTERNAL = 1;

/** ISO-8601 with an optional fractional part and a Z or numeric offset. */
const ISO_INSTANT =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** Nine digits, because a nanosecond count has nine places below the second. */
const NANOSECOND_DIGITS = 9;

/**
 * An ISO instant as epoch nanoseconds, or null when it does not parse.
 *
 * **`Date.parse(iso) * 1e6` is wrong twice, and both ways are silent.** Epoch
 * nanoseconds for any instant after about 1970 exceed `Number.MAX_SAFE_INTEGER`
 * by two orders of magnitude, so the product cannot be represented exactly and
 * `JSON.stringify` emits either a rounded integer or exponential notation. Both
 * are malformed OTLP, and both pass a "two runs agree" assertion and a parsed
 * object comparison. The value is therefore built as a decimal digit string,
 * through `BigInt`, and never travels as a `Number` at all.
 *
 * **Sub-millisecond digits are preserved rather than discovered.** `Date.parse`
 * truncates to milliseconds, so an `occurredAt` carrying microseconds would
 * lose them silently. The fractional digits are read out of the string and
 * padded to nine places instead, and the seconds-precision prefix is the only
 * thing `Date.parse` is asked about — a value it represents exactly.
 *
 * **An unparseable instant is null, never `NaN`.** The caller counts it as
 * unexportable. A `NaN` written into the wire would be a malformed body a
 * collector rejects wholesale, taking every well-formed span in the batch with
 * it.
 */
function epochNanosOf(iso: string): string | null {
  const match = ISO_INSTANT.exec(iso);
  if (match === null) return null;
  const [, seconds, fraction, zone] = match;
  if (seconds === undefined || zone === undefined) return null;
  // Seconds precision only: an integer number of milliseconds, which a Number
  // represents exactly. The fraction is added below, in base ten, as digits.
  const milliseconds = Date.parse(seconds + zone);
  if (!Number.isFinite(milliseconds)) return null;
  const padded = (fraction ?? "").slice(0, NANOSECOND_DIGITS).padEnd(NANOSECOND_DIGITS, "0");
  return (BigInt(milliseconds) * 1_000_000n + BigInt(padded)).toString();
}

/** One attribute, in the encoding its runtime type calls for. */
function anyValueOf(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  // int64 is a JSON string in proto3's JSON mapping, exactly as the timestamps
  // are. Emitting it as a number would be the same defect in a second place.
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}

function attributesOf(event: TelemetryEvent): readonly OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(event.attributes)) {
    out.push({ key, value: anyValueOf(value) });
  }
  return out;
}

/**
 * One telemetry event as one span, or null when it has no span to be.
 *
 * An event with no span context has no OTLP representation: a span without a
 * trace id is not a span, which is the same law the emitter already enforces on
 * itself. No synthetic id is minted — minting one would collect every degenerate
 * event into a fictional trace, which the emitter refuses by name for the
 * all-zero case.
 */
function spanOf(event: TelemetryEvent): OtlpSpan | null {
  const context = event.spanContext;
  if (context === null) return null;
  const startTimeUnixNano = epochNanosOf(event.startTime);
  const endTimeUnixNano = epochNanosOf(event.endTime);
  if (startTimeUnixNano === null || endTimeUnixNano === null) return null;

  const base = {
    traceId: context.traceId,
    spanId: context.spanId,
    name: event.name,
    kind: OTLP_SPAN_KIND_INTERNAL,
    startTimeUnixNano,
    endTimeUnixNano,
    attributes: attributesOf(event),
    status: { code: OTLP_STATUS_CODES[event.status] },
  };
  // Absent, not null and not empty: an omitted `parentSpanId` is how OTLP says
  // "this span is a root". A present-but-empty one is a parent nobody named.
  return context.parentSpanId === null
    ? base
    : { ...base, parentSpanId: context.parentSpanId };
}

function resourceAttributesOf(
  batch: TelemetryBatch,
  serviceName: string,
  unexportable: number,
): readonly OtlpKeyValue[] {
  return [
    { key: "service.name", value: { stringValue: serviceName } },
    { key: "acp.telemetry.refused_count", value: { intValue: String(batch.refusedCount) } },
    {
      key: "acp.telemetry.unresolved_causation_count",
      value: { intValue: String(batch.unresolvedCausationCount) },
    },
    { key: "acp.telemetry.unexportable_count", value: { intValue: String(unexportable) } },
  ];
}

/**
 * A batch as one OTLP/JSON trace request.
 *
 * One `resourceSpans` entry and one `scopeSpans` entry, always: this edge is
 * one service reporting through one instrumentation scope, and splitting a
 * single batch across several would claim a structure the batch does not have.
 *
 * The counts are returned beside the bytes rather than recomputed by the
 * caller, because they are facts this function established and nothing above it
 * can rediscover them without doing the work twice.
 */
export function serializeTelemetryBatch(
  batch: TelemetryBatch,
  serviceName: string,
): OtlpSerialization {
  const spans: OtlpSpan[] = [];
  let unexportableCount = 0;
  for (const event of batch.events) {
    const span = spanOf(event);
    if (span === null) {
      unexportableCount += 1;
      continue;
    }
    spans.push(span);
  }

  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: resourceAttributesOf(batch, serviceName, unexportableCount) },
        scopeSpans: [
          {
            // No `version`. See `OTLP_SCOPE_NAME`: every package here is
            // `0.0.0`, and a version that carries no information should not be
            // sent as though it did.
            scope: { name: OTLP_SCOPE_NAME },
            spans,
          },
        ],
      },
    ],
  });

  return {
    body,
    spanCount: spans.length,
    unexportableCount,
    bytes: new TextEncoder().encode(body).length,
  };
}
