/**
 * Public surface of the Agent Control Plane runtime package.
 *
 * Scope note. P2D built one shared lifecycle engine and both of its drivers,
 * `SQLITE_SUPERVISOR` and `RESTATE`, over the append-only ledger, plus the
 * narrowed server lifecycle the daemon drives. P6A adds the writer-enforcement
 * core: leases, write-set conformance and prestate verification, as pure
 * functions over injected values. Process lifecycle itself lives in
 * `@acp/daemon`; the launchd template and any observation route are not here.
 *
 * Importing this module has no side effects. It binds no socket, starts no
 * listener, spawns no process and creates no directory. Filesystem work happens
 * only inside an explicitly invoked drill, under a root this package resolves
 * itself; the architecture fence asserts both.
 *
 * The enforcement core observes nothing itself: the read-only git port is a
 * type, no implementation of it exists in this package, and no production
 * source here imports a process module. It recommends quarantine and never a
 * cleanup.
 *
 * None of this is product adoption. Nothing here is connected to, observed
 * from or used by any real operation.
 */

// P6A: the writer-enforcement core. One writer per worktree, an exact
// write-set scanned tracked-and-untracked, and a violation that quarantines
// rather than cleans. Pure functions over injected values; the git port is a
// type with a closed read-only verb set and no implementation here.
export {
  ENFORCEMENT_REFUSALS,
  GIT_READ_VERBS,
  acquireLease,
  checkWriteSetConformance,
  observationFailure,
  renewLease,
  revokeLease,
  verifyPrestate,
} from "./enforcement/index.js";
// P6B: the conflict graph. The complete pairwise verdict over a candidate set,
// and the admission form defined as that graph restricted to the candidate's
// pairs. It decides envelope compatibility only: worktree isolation stays with
// the lease check, and the graph is the gate applied before acquire.
export {
  CONFLICT_KINDS,
  DUPLICATE_TASK_ID,
  GRAPH_REFUSALS,
  buildConflictGraph,
  checkAdmission,
} from "./conflict-graph/index.js";
export type {
  AdmissionRequest,
  ConflictGraphRequest,
  ConflictIntersection,
  ConflictKind,
  ConflictOutcome,
  ConflictPair,
  ConflictVerdict,
  DuplicateTaskId,
  GraphRefusal,
  GraphRefused,
} from "./conflict-graph/index.js";
// P6C: commit authorization and quarantine. The receipt envelope is injected
// whole -- this module mints no identifier, reads no clock and never runs git;
// it decides, and the integrator commits under the receipt it returns. A
// receipt can never authorize a push, and quarantine is never cleanup.
export {
  AUTHORIZATION_REFUSALS,
  authorizeCommit,
  quarantineWorktree,
  recordCommit,
} from "./commit-authorization/index.js";
export type {
  AuthorizationEvent,
  AuthorizationEventType,
  AuthorizationGranted,
  AuthorizationOutcome,
  AuthorizationRefusal,
  AuthorizationRefused,
  AuthorizationRequest,
  CommitRecordOutcome,
  CommitRecordRequest,
  CommitRecorded,
  QuarantineOutcome,
  QuarantineRecord,
  QuarantineRequest,
  RecordedCheck,
  RecordedCommit,
} from "./commit-authorization/index.js";

export type {
  ConformanceOutcome,
  ConformanceRequest,
  ConformanceVerdict,
  EnforcementEvent,
  EnforcementEventType,
  EnforcementRefusal,
  EnforcementRefused,
  GitReadOutcome,
  GitReadPort,
  GitReadRequest,
  GitReadVerb,
  LeaseGranted,
  LeaseOutcome,
  LeaseRequest,
  PrestateOutcome,
  PrestateRequest,
  PrestateVerdict,
  WorktreeObservation,
} from "./enforcement/index.js";

export {
  DATA_ROOTS,
  DATA_ROOT_DRILLS,
  DATA_ROOT_LOCAL,
  DATA_ROOT_RESTATE,
  DATA_ROOT_TOOLS,
  LOOPBACK_HOST,
  OBSERVATION_API_PORT,
  RESERVED_LOOPBACK_PORTS,
  RESTATE_ADMIN_PORT,
  RESTATE_ADMIN_URL,
  RESTATE_HANDLER_ADVANCE,
  RESTATE_HANDLER_READ_CACHE,
  RESTATE_INGRESS_PORT,
  RESTATE_INGRESS_URL,
  RESTATE_OBJECT_NAME,
  RESTATE_SDK_VERSION,
  RESTATE_SERVER_SHA256_PIN_PATH,
  RESTATE_SERVER_VERSION,
  RESTATE_STATE_KEY_CACHE,
  RUNTIME_SERVICE_PORT,
  RUNTIME_SERVICE_URL,
  UI_PORT,
} from "./constants/index.js";

export type {
  CoordinateOrigin,
  DeriveEventCoordinate,
  DurableInvocation,
  EventCoordinate,
  OperationCoordinate,
  OrchestrationDriver,
  PostconditionProbe,
  PostconditionVerdict,
  Provenanced,
  ReplayForbiddenSource,
  StepBeat,
} from "./contracts/index.js";

export {
  PostconditionUnknownError,
  ReconciliationError,
  RuntimeError,
  SupervisorError,
  LifecyclePlanError,
  ToyBoundaryError,
} from "./errors/index.js";
export type { RuntimeErrorCode } from "./errors/index.js";

export {
  ACP_UUID_NAMESPACE,
  deriveEventCoordinate,
  deriveOperationCoordinate,
  deterministicUuid,
  eventName,
  operationDigest,
  operationName,
} from "./core/coordinates/index.js";

export { buildEvent, operationForStep } from "./core/events/index.js";
export type { BuildEventInput } from "./core/events/index.js";

// P7P: one step table, one plan per commit policy. `READ_ONLY_PLAN` is the
// derived plan a `NO_COMMIT` packet walks, and `planFor` is the only lawful way
// to choose between them -- it has no default, so a caller that never said
// which policy it runs under cannot be handed the commit-capable plan.
export {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  PLAN_TERMINAL_STATE,
  READ_ONLY_PLAN,
  planFor,
  planStep,
  validatePlan,
} from "./core/lifecycle/index.js";
export type { PlanStep } from "./core/lifecycle/index.js";

export {
  applyEffect,
  drillRoot,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "./toy/repository/index.js";
export type { ScenarioRoot } from "./toy/repository/index.js";

export { SqliteSupervisor } from "./drivers/sqlite-supervisor/index.js";
export type {
  FaultPoint,
  RunResult,
  SqliteSupervisorOptions,
} from "./drivers/sqlite-supervisor/index.js";

export {
  appendPlanStep,
  applyIntentEffect,
  assertClaimedState,
  assertInvocationContinuity,
  closeIntent,
  currentState,
  nextStep,
} from "./core/step-executor/index.js";
export type {
  BeatContext,
  BeatResult,
  EffectPort,
  LedgerPort,
} from "./core/step-executor/index.js";


export { recordTokenObservation } from "./usage/index.js";
export type {
  TokenObservation,
  TokenObservationKind,
  TokenRecordResult,
} from "./usage/index.js";

export { executeSwitchPlan } from "./switch-executor/index.js";
export type { SwitchExecutionInput, SwitchExecutionResult } from "./switch-executor/index.js";
