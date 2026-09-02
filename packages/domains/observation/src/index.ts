/**
 * Public surface of the Agent Control Plane observation package.
 *
 * P3A drew the shadow-mode boundary, P3B added the passive collectors, and
 * P3C adds the baseline and the disposable shadow ledger behind it. The
 * ledger-to-client parity contract is P3D and lives elsewhere.
 *
 * Importing this module has no side effects. It creates no directory, opens no
 * database, spawns no process, binds no socket and writes no file. Calling
 * `buildShadowLedger` does open and write one — a throwaway `@acp/ledger`
 * instance under the ignored `.acp-local/shadow` root, from a name it admits
 * rather than a path a caller chose, through the public ledger API only. That
 * is the single writer in this package, and it writes into a fixture, never
 * into any product authority. Everything else here still only reads. The
 * architecture fence asserts each of those claims rather than trusting this
 * paragraph.
 *
 * Shadow mode observes only passive artifacts already emitted, or synthetic
 * scenarios, under allowlisted ignored roots. It never attaches to, inspects,
 * signals or writes into any live session.
 *
 * P3A is not P3 completion, and it is no product adoption.
 */

export type { ObservationRefusal, ObservationRefused, ObservationVerdict } from "./errors/index.js";
export { ObservationError } from "./errors/index.js";
export type {
  ArtifactAdmission,
  ArtifactHandle,
  ObservationKind,
  ObservationRoot,
} from "./roots/index.js";
export {
  ARTIFACT_MAX_BYTES,
  OBSERVATION_KINDS,
  OBSERVATION_ROOT_SEGMENTS,
  admitArtifact,
  checkArtifactName,
  resolveObservationRoot,
} from "./roots/index.js";

export type {
  AcceptanceBaseline,
  Baseline,
  BaselineStopReason,
  OutcomeCount,
  ReasonCount,
  ReworkBaseline,
  RoutingBaseline,
  TaskDuration,
  TaskReworkCount,
  TimeBaseline,
  TokensBaseline,
  VerdictCount,
} from "./baseline/index.js";
export {
  AUDIT_VERDICTS,
  BaselineStopError,
  REASON_MAX_LENGTH,
  TERMINAL_OUTCOME_TYPES,
  TOKENS_USED_MAX,
  computeBaseline,
  serializeBaseline,
} from "./baseline/index.js";

export type {
  InitiativeTokenRollup,
  TaskTokenRollup,
  TokenRollupInput,
  TokenRollups,
} from "./rollups/index.js";
export {
  ROLLUP_ACCOUNT_ID_MAX_LENGTH,
  ROLLUP_RESERVATION_TYPE,
  ROLLUP_TOKENS_MAX,
  ROLLUP_USAGE_TYPE,
  UNSCOPED_INITIATIVE,
  computeTokenRollups,
} from "./rollups/index.js";

// P8-7: neutral telemetry (law 9) and the optional Langfuse boundary. The
// neutral surface is emitted first and always; the vendor translator is a pure
// value-producing function that nothing here calls, imports no SDK, and can be
// removed by deleting one file. No observability vendor is required for
// routing, recovery or evidence — a property of this import graph, not a
// promise. The redaction gate lives inside `emitTelemetry`, and
// `TelemetryEvent` is branded so nothing ungated can reach the translator.
export type {
  TelemetryAttribute,
  TelemetryBatch,
  TelemetryEvent,
  TelemetryRefusal,
  TelemetryRefusalReason,
  TelemetryStatus,
} from "./telemetry/index.js";
export {
  TELEMETRY_ATTRIBUTE_KEYS,
  TELEMETRY_REFUSAL_REASONS,
  TELEMETRY_SPAN_KIND,
  emitTelemetry,
  telemetrySpanName,
} from "./telemetry/index.js";

export type { LangfuseObservation, LangfuseTrace } from "./telemetry/langfuse/index.js";
export { LANGFUSE_TRACE_NAME, toLangfuseTrace } from "./telemetry/langfuse/index.js";

export type { ShadowReceipt, ShadowRefusal, ShadowSnapshot } from "./shadow-ledger/index.js";
export {
  SHADOW_LEDGER_DIRECTORY,
  ShadowLedgerError,
  buildShadowLedger,
} from "./shadow-ledger/index.js";
