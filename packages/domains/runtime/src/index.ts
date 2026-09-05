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

// The correspondence law (V2-B2-1). Exported so both drivers' suites apply the
// same function to their real object rather than each re-deriving the rule.
export { driverCapabilityMismatches } from "./contracts/index.js";

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
// `SHARED_PLAN_PREFIX` is V2 L2's: the steps both plans share, as one name. The
// lifecycle verbs read the plan only inside this prefix, so a driver built to
// cancel or rejoin walks it and produces the same bytes either policy would.
export {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  PLAN_TERMINAL_STATE,
  READ_ONLY_PLAN,
  SHARED_PLAN_PREFIX,
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
// `SqliteSupervisorLifecycleOptions` is what `SqliteSupervisor.forLifecycle`
// takes. Published for the reason the durability pin publishes
// `GateDependencies`: a static whose parameter type the package root cannot
// name has a surface no consumer can write against without re-declaring it.
export type {
  FaultPoint,
  RunResult,
  SqliteSupervisorLifecycleOptions,
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

// V2-B1b, stage 2: the execution-backed effect port. The beats' side effect
// becomes a real execution on the owned `ModelExecutionPort`, injected -- the
// providers factory never enters this stratum -- with digest-keyed completion
// evidence under the scenario's own `executions/` directory and the toy's
// three-verdict probe law preserved exactly. The toy port stays exported above
// for the two drill children and the drills; the fence's toy-binding law names
// them as its only lawful importers.
export { ExecutionEffectError, createExecutionEffects } from "./execution-effects/index.js";
export type { ExecutionEffectsInput } from "./execution-effects/index.js";

// V2 L2: the reader half of the port above, for the verbs that must ask whether
// an effect happened and must never perform one. It needs no provider binding
// and no execution request, which is what lets a door outside the daemon hold
// it: a probe cannot perform an effect, so nothing bypasses the write-set gate.
export { createEvidenceProbe } from "./execution-effects/index.js";


export { recordTokenObservation } from "./usage/index.js";
export type {
  TokenObservation,
  TokenObservationKind,
  TokenRecordResult,
} from "./usage/index.js";

export { executeSwitchPlan } from "./switch-executor/index.js";
export type { SwitchExecutionInput, SwitchExecutionResult } from "./switch-executor/index.js";

// V2-B2-4b: cancellation as a ledger settlement. The domain decides what the
// log may be made to say -- terminal tasks refuse before anything happens, a
// probed `DONE` closes the open intent before the cancellation, and `UNKNOWN`
// appends nothing at all -- while stopping an engine stays with the edge that
// knows one. One policy, so a second driver that learns to cancel inherits it
// rather than writing it again.
export {
  CANCELLATION_EFFECTS,
  CANCELLATION_TRANSITION_ID,
  CANCELLATION_VERDICTS,
  cancellationPrecheck,
  settleCancellation,
} from "./cancellation/index.js";
export type {
  CancellationEffect,
  CancellationPrecheck,
  CancellationSettlement,
  CancellationVerdict,
} from "./cancellation/index.js";

// V2-B7S: the submission path. The composition root above the walk elects a
// route by policy and binds it to the attempt with the digest the daemon's
// door recomputes. The two digest functions are DECLARED here and re-exported
// by `daemon/src/daemon-child` — the producer moved so an elector outside the
// daemon can compute what the door will compare, and the door itself did not
// move at all. D5 is discharged, not reversed: the walk still receives a route
// it did not resolve.
export {
  canonicalSubmission,
  canonicalSubmissionDigest,
  composeSubmission,
  deriveInvocation,
} from "./submission/index.js";
export type {
  DaemonSubmission,
  SubmissionComposed,
  SubmissionCoordinates,
  SubmissionOutcome,
  SubmissionRefused,
} from "./submission/index.js";

// V2-B7T: failures settle and spend is recorded. Two holes in the production
// walk, closed with no new vocabulary: `FAILED` was already an exceptional
// terminal and `TASK_FAILED` already an event type, and the usage sink is an
// injected closure rather than a third verb on `EffectPort`.
export {
  FAILURE_REASONS,
  FAILURE_REFUSALS,
  FAILURE_TRANSITION_ID,
  FAILURE_VERDICTS,
  classifyFailure,
  failurePrecheck,
  settleFailure,
} from "./failure/index.js";
export type {
  FailureDecision,
  FailureEffect,
  FailureReason,
  FailureRefusal,
  FailureSettlement,
  FailurePrecheck,
  FailureVerdict,
} from "./failure/index.js";
export { USAGE_TOKENS_MAX, usageTransitionId } from "./usage/index.js";
export type { UsageSample, UsageSink } from "./execution-effects/index.js";

// V2-B4b stage 2: the durable tool-call receipt. The seam between the tool edge
// and the ledger is a grammar, not a registry -- `@acp/tools` keeps the
// transport, refusal and ceiling vocabularies, and this stratum never names it.
// No production caller lands here: the daemon composes a tool plane in stage 3.
export { recordToolCall, toolCallTransitionId } from "./tool-receipt/index.js";
export type {
  ToolCallFacts,
  ToolCallObservation,
  ToolCallRecordResult,
} from "./tool-receipt/index.js";

// V2-B4b stage 3B: the explicit tool operation. It joins the scope, the receipt
// and the ledger row, and it is the operation only -- no route, no CLI verb, no
// process start. `ToolCallPort` is structural exactly as `EffectPort` is, so
// this package still never names `@acp/tools`.
//
// V2 X1b adds the claim seam beside it, on the same terms: `ToolClaimPort` is
// structural too, so the operation contends on an authority it never names the
// implementation of.
//
// `TOOL_CALL_BOUND_MS` is deliberately **not** here. It is this module's
// restatement of the tool edge's own `TOOL_CALL_TIMEOUT_MS`, restated because
// `RUNTIME_ALLOWED_PACKAGES` forbids the import, and a barrel that published it
// would offer importers a second authority for a number `@acp/tools` owns. It
// stays exported from the module, where the derivation and its test live, and
// stops at the package boundary. What crosses is the derived answer,
// `TOOL_CLAIM_TTL_MS`, and the margin this module does own.
export {
  TOOL_CLAIM_HELD,
  TOOL_CLAIM_MARGIN_MS,
  TOOL_CLAIM_TTL_MS,
  TOOL_POSTCONDITION_UNKNOWN,
  ToolClaimHeldError,
  runToolCall,
  toolOperationScopeId,
} from "./tool-call/index.js";
export type {
  ToolCallExecution,
  ToolCallOperationResult,
  ToolCallPort,
  ToolClaimPort,
  ToolClaimRecord,
  ToolClaimVerdict,
} from "./tool-call/index.js";

// V2 L2: the lifecycle operation and its recovery producer. A door arrives with
// coordinates and nothing else; everything the drivers need was written by the
// walk that opened the attempt, so it is read back and verified against the
// submission digest rather than restated by an operator. One producer, both
// doors, pinned by `L-V2L-1`.
export {
  LIFECYCLE_RECOVERY_REFUSALS,
  LIFECYCLE_VERBS,
  admitDriverMode,
  lifecycleBeat,
  restateInvocation,
  runLifecycleOperation,
} from "./lifecycle-operation/index.js";
export type {
  AdmittedDriverMode,
  LifecycleOperationInput,
  LifecycleOperationResult,
  LifecycleRecovered,
  LifecycleRecoveryOutcome,
  LifecycleRecoveryPort,
  LifecycleRecoveryRefusal,
  LifecycleRecoveryRefused,
  LifecycleVerb,
  RecordedRoute,
  RecoveredLifecycleContext,
} from "./lifecycle-operation/index.js";
