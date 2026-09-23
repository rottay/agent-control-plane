/**
 * Agent Control Plane runtime contracts.
 *
 * Laws encoded here, taken from docs/ROADMAP.md:
 *
 * 1. Provider neutral. No provider, model or vendor name is enumerated in any
 *    schema. Providers are opaque lowercase segments.
 * 2. Strict. Every object rejects unknown keys, so a drifting producer fails
 *    closed instead of smuggling extra state through the ledger.
 * 3. Versioned. Every top level contract carries contractVersion.
 * 4. No secrets. Checkpoints, events and account records reject credential
 *    bearing keys and secret shaped values anywhere in their tree.
 * 5. No transcript continuity. Continuity is carried by digests, receipts and
 *    the next safe action, never by replaying a provider conversation.
 *
 * Subdivided by P8-T G6 into one capability module per the section bands this
 * file already carried, and widened since: G7 hoisted two more in. The count
 * is deliberately not written here — the fence derives it from the modules
 * this barrel actually re-exports from, and a number restated in prose is a
 * number that goes stale the next time one is added. Nothing is defined here
 * any more: this is a re-export barrel and the fence refuses a definition in
 * it. The exported name set is pinned, so the subdivision could not move the
 * package's surface.
 */

export {
  CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  AdmittedContractVersion,
  utf8ByteLength,
  isCanonicalInstant,
  CanonicalInstant,
  Timestamp,
} from "./primitives/index.js";
export {
  BOUNDED_IDENTIFIER,
  BoundedIdentifier,
} from "./bounded-identifier/index.js";
// P-06 escalón A. The instruction's content contract of contratos §4.1, version 1 —
// the version literal, the closed kind vocabulary, the table of media types each kind
// admits, the six bounds with their unit in the name (inline text in characters, block
// id in characters, the three profile ceilings and the request aggregate in bytes), the
// list ceiling, the refusal vocabulary, the two schemas and the five types. Grammar of
// a payload, which is this package's; which door validates it is B's and which
// transport carries it is C's (ADR 0093).
//
// The schemas are `…Schema` and every type of the concept is declared in its type leaf,
// which is where owner law §7.1 puts a resource's aliases; a value and a type may not
// share one name across two files, so the value is renamed rather than the law bent
// (adjudication v3). The rename is this concept's alone: the package's historical
// merged names are untouched.
export {
  CONTENT_CONTRACT_VERSION,
  CONTENT_BLOCK_KINDS,
  CONTENT_MEDIA_TYPES_BY_KIND,
  CONTENT_INLINE_TEXT_MAX_CHARS,
  CONTENT_BLOCK_ID_MAX_CHARS,
  CONTENT_ARTIFACT_MAX_BYTES,
  CONTENT_METADATA_MAX_BYTES,
  CONTENT_TOOL_RESULT_MAX_BYTES,
  CONTENT_REQUEST_AGGREGATE_MAX_BYTES,
  CONTENT_BLOCK_LIST_MAX,
  CONTENT_BLOCK_REFUSALS,
  ContentBlockSchema,
  InstructionContentSchema,
} from "./content-block/index.js";
export type {
  ContentBlockKind,
  ContentMediaType,
  ContentBlockRefusal,
  ContentBlock,
  InstructionContent,
} from "./content-block/index.js";
// P-07 escalón A: the result contract v1 (contratos §4.2, ADR 0097). An effect's status
// and its ordered output blocks, in the content contract's own block shape. Inert: no
// door records it and no assembler builds it until escalones B–D (L-P07A-1). The
// schema is `…Schema` and the three types live in the concept's leaf, on the
// content contract's precedent.
export {
  RESULT_CONTRACT_VERSION,
  RESULT_STATUSES,
  RESULT_BLOCK_LIST_MAX,
  RESULT_AGGREGATE_MAX_BYTES,
  RESULT_REFUSALS,
  ResultContractSchema,
} from "./result/index.js";
export type { ResultStatus, ResultRefusal, ResultContract } from "./result/index.js";
export {
  EXIT_OK,
  EXIT_USAGE,
} from "./exit-codes/index.js";
export {
  TOKENS_USED_MAX,
} from "./usage-limits/index.js";
export {
  USAGE_REPORT_KINDS,
  USAGE_SOURCE_CLASSES,
} from "./usage-measure/index.js";
export type { UsageReportKind, UsageSourceClass } from "./usage-measure/index.js";
export {
  PRODUCT_PATH_MARKERS,
} from "./operator-paths/index.js";
export {
  findCredentialViolations,
  findTranscriptViolations,
  serializedByteLength,
} from "./credential-guards/index.js";
export type {
  GuardViolation,
} from "./credential-guards/index.js";
export {
  WORKER_ROLES,
  WorkerRole,
  WORKER_IDENTITY_PATTERN,
  WorkerIdentityString,
  WorkerIdentity,
  formatWorkerIdentity,
  parseWorkerIdentity,
} from "./worker-identity/index.js";
export {
  LIFECYCLE_STATES,
  EXCEPTIONAL_STATES,
  LifecycleState,
  ExceptionalState,
  TaskState,
  isLifecycleState,
  isExceptionalState,
  TERMINAL_STATES,
} from "./lifecycle/index.js";
export {
  PathDigest,
  ArtifactRef,
} from "./shared-references/index.js";
export {
  ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1,
  TaskClassification,
  CommitPolicy,
  TaskEnvelope,
} from "./task-envelope/index.js";
export {
  HealthProbe,
  Lease,
  WorkerSlot,
} from "./worker-slot/index.js";
export {
  CHECKPOINT_MAX_BYTES,
  Checkpoint,
} from "./checkpoint/index.js";
export {
  EVENT_PAYLOAD_MAX_BYTES,
  CONTROL_PLANE_EVENT_TYPES,
  ControlPlaneEventType,
  IdempotencyCoordinates,
  buildIdempotencyKey,
  V2_IDEMPOTENCY_NAMESPACE,
  V2_IDEMPOTENCY_STREAMS,
  EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1,
  EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1,
  OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1,
  OUTBOX_FAILURE_CODES,
  V2IdempotencyCoordinates,
  buildV2IdempotencyKey,
  ControlPlaneEvent,
} from "./control-plane-event/index.js";
export {
  CommitAuthorizationReceipt,
} from "./commit-authorization/index.js";
export {
  AccountStatus,
  AuthMode,
  ConfidenceLevel,
  LocalAuthReference,
  AccountRecord,
} from "./account-record/index.js";
export {
  DRIVER_MODES,
  DriverMode,
  DRIVER_HEALTH_STATES,
  DriverHealth,
  DriverStatus,
  DRIVER_CAPABILITIES,
  DriverCapability,
  DRIVER_CAPABILITY_PROPERTIES,
  DriverCapabilityProperty,
  DRIVER_CAPABILITY_STATES,
  DriverCapabilityState,
  DriverCapabilities,
  DRIVER_REFUSALS,
  DriverRefusal,
  isDriverRefused,
  RECONCILIATION_VERDICTS,
  ReconciliationVerdict,
  RESUMABLE_VERDICTS,
  ReconciliationReport,
} from "./durability-plane/index.js";
export type {
  DriverAccepted,
  DriverOutcome,
  DriverRefused,
  ReconciliationDiscrepancy,
} from "./durability-plane/index.js";
export {
  ROADMAP_CONTENT_MAX_BYTES,
  INITIATIVE_STATUSES,
  InitiativeStatus,
  Initiative,
  ROADMAP_VERSION_KINDS,
  RoadmapVersionKind,
  RoadmapVersion,
  INITIATIVE_EVENT_TYPES,
  InitiativeEventType,
  InitiativeIdempotencyCoordinates,
  buildInitiativeIdempotencyKey,
  ACCOUNT_ACTIONS,
  AccountAction,
  ACCOUNT_ACTION_STATE,
  ACCOUNT_ACTION_NOTE_MAX,
  AccountActionEvent,
  AccountActionRecord,
  InitiativeEvent,
} from "./initiatives/index.js";
export {
  INSTRUCTIONS_MAX_CHARS,
  TRANSPORT_KINDS,
  TransportKind,
  CLI_SUBSCRIPTION_PROVIDERS,
  PROVIDER_PRESSURES,
  SWITCH_STEP_NAMES,
  SwitchPlanShape,
  SwitchAuthorization,
  EXECUTION_REFUSALS,
  ExecutionRefusal,
  ResolvedRoute,
  ExecutionEvent,
  ExecutionRequest,
} from "./execution-boundary/index.js";
export type {
  ExecutionOutputSink,
  ExecutionRefused,
  ExecutionSession,
  ModelExecutionPort,
} from "./execution-boundary/index.js";
export {
  ARTIFACT_CLASSES,
  ArtifactClass,
  ARTIFACT_CLASSIFICATIONS,
  ArtifactClassification,
  ENCRYPTION_STATUSES,
  EncryptionStatus,
  RETENTION_CLASSES,
  RetentionClass,
  REFERENCE_SCOPE_KINDS,
  ReferenceScopeKind,
  BLOB_LIFECYCLE_STATES,
  BlobLifecycleState,
  ARTIFACT_EVENT_KINDS,
  ArtifactEventKind,
  PIN_HOLDER_KINDS,
  PinHolderKind,
  ArtifactRegistryEvent,
} from "./artifact-record/index.js";
