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
  utf8ByteLength,
} from "./primitives/index.js";
export {
  EXIT_OK,
  EXIT_USAGE,
} from "./exit-codes/index.js";
export {
  TOKENS_USED_MAX,
} from "./usage-limits/index.js";
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
  TRANSPORT_KINDS,
  TransportKind,
  CLI_SUBSCRIPTION_PROVIDERS,
  EXECUTION_REFUSALS,
  ExecutionRefusal,
  ResolvedRoute,
  ExecutionEvent,
  ExecutionRequest,
} from "./execution-boundary/index.js";
export type {
  ExecutionRefused,
  ExecutionSession,
  ModelExecutionPort,
} from "./execution-boundary/index.js";
