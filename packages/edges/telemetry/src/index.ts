/**
 * `@acp/telemetry` — the telemetry export edge (V2-B5/R11).
 *
 * A closed barrel. No `export *`: a surface that widens by itself is a surface
 * nobody decided on, and the fence pins this one by equality in both directions
 * against `TELEMETRY_PUBLIC_EXPORTS`.
 *
 * The transport is deliberately **not** here. It is how the port keeps its
 * promises, not a promise of its own, and a transport on the barrel is
 * eventually called by somebody who skipped the port — where the ceiling, the
 * receipt and the empty-batch refusal live.
 *
 * The scripted peer at `test/testing/index.ts` is not here either, and never
 * will be: a fake on a public surface is eventually mistaken for evidence.
 *
 * The serializer **is** here, and that is a decision rather than an oversight.
 * The causal drill that proves this mapping against events a real ledger
 * produced lives in the gateway's test-only telemetry domain — the only place
 * in this repository where the real emitters, a real ledger and this package
 * can meet — and it reaches the mapping through this barrel like any consumer
 * would.
 */

export {
  OTLP_BODY_MAX_BYTES,
  OTLP_EXPORT_RECORD,
  OTLP_HEADERS_MAX,
  OTLP_HEADER_VALUE_MAX_BYTES,
  OTLP_SCOPE_NAME,
  OTLP_SERVICE_NAME_DEFAULT,
  OTLP_SERVICE_NAME_MAX_LENGTH,
  OTLP_TIMEOUT_DEFAULT_MS,
  OTLP_TIMEOUT_MAX_MS,
  TELEMETRY_ADMISSION_REFUSALS,
  TELEMETRY_EXPORT_REFUSALS,
} from "./contract/index.js";
export type {
  TelemetryAdmissionRefusal,
  TelemetryExportOutcome,
  TelemetryExportReceipt,
  TelemetryExportRefusal,
} from "./contract/index.js";

export { admitOtlpEndpoint } from "./admission/index.js";
export type {
  AdmittedOtlpEndpoint,
  OtlpAdmissionOutcome,
  OtlpEndpointCandidate,
} from "./admission/index.js";

export { serializeTelemetryBatch } from "./otlp/index.js";
export type { OtlpSerialization } from "./otlp/index.js";

export { createOtlpExporterPort } from "./port/index.js";
export type { TelemetryExporterPort } from "./port/index.js";
