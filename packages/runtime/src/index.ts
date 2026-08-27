/**
 * Public surface of the Agent Control Plane runtime package.
 *
 * Scope note. This is P2B: one shared lifecycle engine and its first driver,
 * `SQLITE_SUPERVISOR`, over the append-only ledger. The Restate driver, the
 * daemon, the launchd template and any observation route are not here.
 *
 * Importing this module has no side effects. It binds no socket, starts no
 * listener, spawns no process and creates no directory. Filesystem work happens
 * only inside an explicitly invoked drill, under a root this package resolves
 * itself; the architecture fence asserts both.
 *
 * P2B is not P2 completion, and it is no product adoption.
 */

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
  RESTATE_INGRESS_PORT,
  RESTATE_INGRESS_URL,
  RESTATE_SDK_VERSION,
  RESTATE_SERVER_VERSION,
  RUNTIME_SERVICE_PORT,
  RUNTIME_SERVICE_URL,
  UI_PORT,
} from "./constants.js";

export type {
  CoordinateOrigin,
  DeriveEventCoordinate,
  DurableInvocation,
  DurableStepContext,
  EventCoordinate,
  OperationCoordinate,
  OrchestrationDriver,
  PostconditionProbe,
  PostconditionVerdict,
  Provenanced,
  ReplayForbiddenSource,
  StepBeat,
} from "./contracts.js";

export {
  PostconditionUnknownError,
  ReconciliationError,
  RuntimeError,
  SupervisorError,
  LifecyclePlanError,
  ToyBoundaryError,
} from "./errors.js";
export type { RuntimeErrorCode } from "./errors.js";

export {
  ACP_UUID_NAMESPACE,
  deriveEventCoordinate,
  deriveOperationCoordinate,
  deterministicUuid,
  eventName,
  operationDigest,
  operationName,
} from "./core/coordinates.js";

export { buildEvent, operationForStep } from "./core/events.js";
export type { BuildEventInput } from "./core/events.js";

export {
  INTENT_STEP,
  LIFECYCLE_PLAN,
  OUTCOME_STEP,
  PLAN_TERMINAL_STATE,
  planStep,
  validatePlan,
} from "./core/lifecycle.js";
export type { PlanStep } from "./core/lifecycle.js";

export {
  DRILL_ROOT_SEGMENTS,
  applyEffect,
  drillRoot,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "./toy/repository.js";
export type { ScenarioRoot } from "./toy/repository.js";

export { SqliteSupervisor } from "./drivers/sqlite-supervisor.js";
export type {
  FaultPoint,
  RunResult,
  SqliteSupervisorOptions,
} from "./drivers/sqlite-supervisor.js";
