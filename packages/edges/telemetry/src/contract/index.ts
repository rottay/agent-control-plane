/**
 * What this edge promises a caller, in this plane's own vocabulary (V2-B5/R11).
 *
 * Nothing in this file names OTel, and that is the point of the split: the port
 * above it speaks `TelemetryBatch`, which is `@acp/observation`'s shape, and the
 * refusals below are ours. The OTel vocabulary exists in exactly one module of
 * this package — the serializer — and never crosses back out.
 *
 * The two ceilings are here rather than at their use sites for the reason every
 * bound in this repository is declared before it is enforced: a number written
 * where it is compared is a number a later edit moves without anybody deciding
 * to.
 */

/**
 * Why an export did not happen. A closed union, exhaustible by a caller.
 *
 * The vocabulary is the boundary's, in the `ObservationRefusal` idiom: a
 * boundary that fails with free text gives a caller nothing to branch on and a
 * test nothing to assert. Six members, and each corresponds to something the
 * code actually does rather than to something a collector might say.
 *
 * `NOTHING_TO_EXPORT` is a refusal and not a success, deliberately. An exporter
 * that reported `ok` for a batch it never sent would make "the endpoint is
 * dead" and "there was nothing to say" the same observation, and the second one
 * is the one that must not open a request at all.
 */
export const TELEMETRY_EXPORT_REFUSALS = [
  /** `fetch` rejected: nothing is listening, or the connection broke. */
  "ENDPOINT_UNREACHABLE",
  /** The request outlived the admitted timeout and was aborted. */
  "ENDPOINT_TIMEOUT",
  /** The endpoint answered, and the answer was not a success status. */
  "ENDPOINT_REJECTED",
  /** The endpoint answered with a redirect, which this edge never follows. */
  "REDIRECT_REFUSED",
  /** The batch projected no exportable span, so no request was made. */
  "NOTHING_TO_EXPORT",
  /** The serialized body is over the ceiling, refused before the send. */
  "PAYLOAD_TOO_LARGE",
] as const;

export type TelemetryExportRefusal = (typeof TELEMETRY_EXPORT_REFUSALS)[number];

/**
 * Why an endpoint was not admitted. A second closed union, and a separate one.
 *
 * Admission happens once, before any export, and its failures are not export
 * failures: an operator who spelled a host wrong has not had a telemetry
 * request refused, they have never had one built. Folding the two vocabularies
 * together would put a configuration mistake and a dead collector under the
 * same name.
 */
export const TELEMETRY_ADMISSION_REFUSALS = [
  /** The candidate did not parse as a URL at all. */
  "ENDPOINT_MALFORMED",
  /** A scheme this edge does not speak. R11 admits plaintext only. */
  "ENDPOINT_SCHEME_REFUSED",
  /** A host that is not a literal loopback address, `localhost` included. */
  "ENDPOINT_HOST_REFUSED",
  /** Userinfo in the endpoint. A credential may not ride the target. */
  "ENDPOINT_CREDENTIALED",
  /** A path, query or fragment the join would have to argue with. */
  "ENDPOINT_PATH_REFUSED",
  /** More headers than the bound, or a key or value outside its shape. */
  "ENDPOINT_HEADERS_REFUSED",
  /** A timeout outside the admitted range. */
  "ENDPOINT_TIMEOUT_REFUSED",
  /** A service name outside its shape or its bound. It rides the wire. */
  "ENDPOINT_SERVICE_NAME_REFUSED",
] as const;

export type TelemetryAdmissionRefusal = (typeof TELEMETRY_ADMISSION_REFUSALS)[number];

/**
 * What an export attempt knows afterwards, whether or not it succeeded.
 *
 * Present on BOTH branches of the outcome. A failed export still knows how many
 * spans it would have sent and how many events had no span to send, and
 * discarding that on the failure branch would make the counters unobservable at
 * exactly the moment they matter.
 *
 * `unexportableCount` exists for the reason `refusedCount` and
 * `unresolvedCausationCount` exist upstream: a read model that silently dropped
 * records would be indistinguishable from one that had none to drop.
 */
export interface TelemetryExportReceipt {
  /** Spans actually serialized into the body. */
  readonly spanCount: number;
  /** Events dropped because they carry no span context. Never id-minted. */
  readonly unexportableCount: number;
  /** Carried through from the batch: what the redaction gate withheld. */
  readonly refusedCount: number;
  /** The serialized body's size, in bytes, measured rather than estimated. */
  readonly bytes: number;
}

/**
 * The result of one export. Discriminated on `ok`, and never a thrown error.
 *
 * A caller that ignores this value has already got the behaviour restriction 3
 * asks for: a collector falling over cannot affect routing, execution or
 * recovery, because there is no exception to propagate and nothing is appended
 * anywhere.
 *
 * `at` is a coordinate, not a clock reading: it names where in this edge the
 * refusal was decided. Nothing in this package reads a clock.
 */
export type TelemetryExportOutcome =
  | { readonly ok: true; readonly receipt: TelemetryExportReceipt }
  | {
      readonly ok: false;
      readonly reason: TelemetryExportRefusal;
      readonly at: string;
      readonly receipt: TelemetryExportReceipt;
    };

/**
 * The most a serialized batch may weigh before it is refused unsent.
 *
 * Four mebibytes. The number is a bound rather than a measurement of any real
 * collector, and it is enforced against the serialized body rather than against
 * a span count: a thousand small spans and one enormous attribute set weigh
 * differently, and the wire only cares about the second answer.
 */
export const OTLP_BODY_MAX_BYTES = 4 * 1024 * 1024;

/** What an endpoint gets, in milliseconds, when its config names no timeout. */
export const OTLP_TIMEOUT_DEFAULT_MS = 10_000;

/**
 * The most any admitted endpoint may be given, in milliseconds.
 *
 * A ceiling and not a suggestion: the admission refuses a larger one. An
 * exporter that could be configured to wait indefinitely would be a way for a
 * dead collector to hold a caller open, which is the one thing this edge exists
 * not to do.
 */
export const OTLP_TIMEOUT_MAX_MS = 30_000;

/** The most headers an admitted endpoint may carry. */
export const OTLP_HEADERS_MAX = 8;

/** The most bytes one admitted header value may carry. */
export const OTLP_HEADER_VALUE_MAX_BYTES = 1_024;

/**
 * The scope this edge reports itself as, and the version it does not report.
 *
 * `scope.name` is the edge's own module name, pinned here as a constant so it
 * is a decision rather than a string a serializer happened to hold.
 *
 * There is no `scope.version`, and the absence is deliberate: every package in
 * this repository is `0.0.0`, and a version that carries no information should
 * not be sent as though it did. A collector reading `0.0.0` would conclude
 * something false about what produced these spans.
 */
export const OTLP_SCOPE_NAME = "@acp/telemetry";

/** What `service.name` reads when the config names none. */
export const OTLP_SERVICE_NAME_DEFAULT = "acp";

/** The most characters a configured `service.name` may carry onto the wire. */
export const OTLP_SERVICE_NAME_MAX_LENGTH = 128;

/**
 * What this exporter has and has not been proved against.
 *
 * The `MCP_PROTOCOL_RECORD` idiom, and for the same reason: a capability claim
 * a reader cannot check is decoration. Every field reading `NONE` or `UNKNOWN`
 * corresponds to an absence in the evidence, never to a guess, and the fence
 * asserts that this record and the package README cannot disagree.
 *
 * The three that matter under restriction 5 are `SOCKET_EXERCISED`,
 * `LIVE_CONFORMANCE` and `CAPABILITIES`. All three stay where they are until a
 * drill with a real subject moves them, and that drill is owner-gated and is
 * not part of R11.
 */
export const OTLP_EXPORT_RECORD = Object.freeze({
  ENCODING: "OTLP/JSON over HTTP, hand-rolled; no SDK and no dependency",
  SPEC_CITATION:
    "OTLP/HTTP 1.x JSON encoding; opentelemetry.io/docs/specs/otlp; retrieved 2026-09-07",
  /** No bytes were vendored, so there is nothing to digest. */
  SPEC_MANIFEST_DIGEST: "NONE",
  /** No collector has ever accepted these bytes. */
  LIVE_CONFORMANCE: "NONE",
  /** Every drill substitutes the platform fetch; no socket is opened. */
  SOCKET_EXERCISED: "NONE",
  /** Restriction 5: CONFIRMED only by a drill with a real subject. */
  CAPABILITIES: "UNKNOWN",
  EGRESS: "loopback http only; https and every named host refused",
  REDIRECTS: "manual; 3xx refused as REDIRECT_REFUSED",
  CREDENTIALS: "NONE; no header default, no cookie, no environment read",
  RETRY: "NONE; one attempt, one outcome",
  COMPRESSION: "NONE",
  METRICS: "NOT_EMITTED",
  LOGS: "NOT_EMITTED",
  PRODUCTION_CALLERS: "NONE; the walk wiring is owed to R11b",
} as const);
