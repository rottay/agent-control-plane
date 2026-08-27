/**
 * Public surface of the Agent Control Plane runtime package.
 *
 * Scope note. This is P2A: the durability and supervisor contract freeze. The
 * package exports frozen types and constants and nothing else. There is no
 * state machine, no driver, no daemon, no listener, no Restate service and no
 * filesystem access here.
 *
 * Importing this module has no side effects. It binds nothing, spawns nothing
 * and reads nothing. That is deliberate and is asserted by the architecture
 * fence: a scaffold that quietly opened a socket or created a directory would
 * be a working capability nobody authorised.
 *
 * P2A is not P2 completion, and it is no product adoption.
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
