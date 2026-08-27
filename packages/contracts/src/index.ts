/**
 * Public surface of the Agent Control Plane contracts package.
 *
 * Everything the ledger, orchestrator, adapters, CLI and UI are allowed to
 * agree on lives here. Consumers must not redeclare these shapes locally.
 */
export {
  CONTRACT_VERSION,
  CHECKPOINT_MAX_BYTES,
  EVENT_PAYLOAD_MAX_BYTES,
  WORKER_ROLES,
  WORKER_IDENTITY_PATTERN,
  LIFECYCLE_STATES,
  EXCEPTIONAL_STATES,
  TERMINAL_STATES,
  CONTROL_PLANE_EVENT_TYPES,
  WorkerRole,
  WorkerIdentity,
  WorkerIdentityString,
  LifecycleState,
  ExceptionalState,
  TaskState,
  PathDigest,
  ArtifactRef,
  TaskClassification,
  CommitPolicy,
  TaskEnvelope,
  HealthProbe,
  Lease,
  WorkerSlot,
  Checkpoint,
  ControlPlaneEventType,
  IdempotencyCoordinates,
  ControlPlaneEvent,
  CommitAuthorizationReceipt,
  AccountStatus,
  AuthMode,
  ConfidenceLevel,
  LocalAuthReference,
  AccountRecord,
  formatWorkerIdentity,
  parseWorkerIdentity,
  isLifecycleState,
  isExceptionalState,
  buildIdempotencyKey,
  findCredentialViolations,
  findTranscriptViolations,
  serializedByteLength,
} from "./schemas.js";

export type { GuardViolation } from "./schemas.js";
