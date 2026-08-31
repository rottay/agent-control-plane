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

export { API_CONTRACT_VERSION, LEDGER_CONTRACT_VERSION } from "./version/index.js";
export type { ApiContractVersionLiteral, LedgerContractVersionLiteral } from "./version/index.js";

export {
  API_ALLOWED_METHODS,
  API_BASE_PATH,
  API_ROUTES,
  API_ROUTE_PATTERNS,
  API_WRITE_METHODS,
  API_WRITE_ROUTES,
  initiativePath,
  initiativeAgentsPath,
  initiativeEventsPath,
  initiativeRoadmapContentPath,
  initiativeRoadmapPath,
  taskPath,
  isWriteRoute,
  workerPath,
} from "./routes/index.js";
export type {
  ApiAllowedMethod,
  ApiRouteName,
  ApiRoutePattern,
  ApiWriteMethod,
  ApiWriteRouteName,
} from "./routes/index.js";

/**
 * The ledger-to-client parity contract (P3D).
 *
 * Lives in the shared package so no single client can redefine the law it is
 * measured against.
 */
export type { FieldBinding, ParitySource } from "./parity/index.js";
export {
  NON_LEDGER_SOURCES,
  PARITY_BINDINGS,
  PARITY_ROUTES,
  VOLATILE_FIELDS,
  bindingCoversAllRoutes,
  canonicalRows,
  canonicalize,
  comparableFields,
  declaredExceptions,
  hasObservationPrivacyViolation,
} from "./parity/index.js";

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
  InitiativeDetail,
  InitiativeDetailResponse,
  InitiativePortfolioResponse,
  InitiativeQuotaConfidence,
  InitiativeRoadmapResponse,
  InitiativeStatusDto,
  InitiativeSummary,
  InitiativeTaskDto,
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
  ROADMAP_CONTENT_MAX_BYTES,
  ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES,
  ACCOUNTS_UNAVAILABLE_REASONS,
  AccountDto,
  AccountStatusDto,
  AccountsResponse,
  AccountsUnavailableReason,
  ConfidenceLevelDto,
  InitiativeAgentsResponse,
  MAX_ACCOUNTS,
  InitiativeEventTypeDto,
  InitiativeTimelineResponse,
  MAX_SCOPED_AGENTS,
  MAX_SCOPED_TIMELINE_ITEMS,
  RoadmapContentQuery,
  ScopedAgentSummary,
  ScopedTimelineEntry,
  RoadmapContentResponse,
  RoadmapVersionDto,
  RoadmapVersionKindDto,
  RoadmapVersionWriteRequest,
  RoadmapVersionWriteResponse,
  RollupSummary,
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
} from "./schemas/index.js";
