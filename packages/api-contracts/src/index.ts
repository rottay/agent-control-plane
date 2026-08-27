/**
 * Public surface of the Agent Control Plane observation API contract.
 *
 * This package is the only contract the local UI is allowed to import. It is
 * browser safe by construction: no `node:` builtin, no filesystem, no database
 * driver and no dependency on `@acp/ledger`. The server and the CLI may depend
 * on both this package and the ledger; the UI may depend on this one alone.
 *
 * Scope note. This is the P1B shared foundation of P1. It describes a read-only
 * observation surface and implements none of it. There is no server, no CLI
 * behaviour and no UI behaviour here, P1B is not P1 completion, and nothing in
 * this package is adopted into any real operation.
 */

export { API_CONTRACT_VERSION, LEDGER_CONTRACT_VERSION } from "./version.js";
export type { ApiContractVersionLiteral, LedgerContractVersionLiteral } from "./version.js";

export {
  API_ALLOWED_METHODS,
  API_BASE_PATH,
  API_ROUTES,
  API_ROUTE_PATTERNS,
  taskPath,
  workerPath,
} from "./routes.js";
export type { ApiAllowedMethod, ApiRouteName, ApiRoutePattern } from "./routes.js";

export {
  API_ERROR_CODES,
  ApiError,
  ApiErrorCode,
  ApiHealthState,
  AppliedMigrationDto,
  CursorPageMeta,
  DEFAULT_PAGE_LIMIT,
  EventPageResponse,
  EventsQuery,
  HEALTH_STATES,
  HealthResponse,
  INTEGRITY_PROBLEM_KINDS,
  IntegrityProblemDto,
  IntegrityProblemKind,
  IntegrityResult,
  LedgerDatabaseIdentity,
  LedgerPragmaStatusDto,
  LedgerStatusResponse,
  MAX_DETAIL_TIMELINE_ITEMS,
  MAX_PAGE_LIMIT,
  OVERVIEW_STATES,
  ObservationCapabilities,
  OverviewIntegrity,
  OverviewLedger,
  OverviewResponse,
  OverviewState,
  ProjectionStatusDto,
  TASK_STATE_COUNT,
  TaskDetail,
  TaskDetailResponse,
  TaskPageResponse,
  TaskStateCount,
  TaskSummary,
  TasksQuery,
  TimelineItem,
  WorkerDetail,
  WorkerDetailResponse,
  WorkerPageResponse,
  WorkerRoleCount,
  WorkerSummary,
  WorkersQuery,
  cursorPage,
} from "./schemas.js";
