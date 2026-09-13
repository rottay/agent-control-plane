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

/**
 * The shared process exit convention, passed through (P8-T G7, D1).
 *
 * The declaration lives in `@acp/contracts` — an exit code is a process
 * convention, not a wire shape, which is why D1 put it there rather than here.
 * It is re-exported for one reason: the gateway is forbidden by a standing law
 * from naming `@acp/contracts` at all, and that law's own refusal message names
 * this package as the sanctioned route to kernel material. Passing the two
 * constants through keeps one authority and leaves both laws literally true.
 */
export { EXIT_OK, EXIT_USAGE } from "@acp/contracts";

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
  accountActionsPath,
  initiativeAgentsPath,
  initiativeEventsPath,
  initiativeRoadmapContentPath,
  initiativeRoadmapPath,
  taskPath,
  toolCallsPath,
  lifecyclePath,
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

/**
 * The CLI/API surface map (old-roadmap R1).
 *
 * The sibling of the parity contract above, and deliberately a sibling rather
 * than part of it: that table binds a rendered field to its source, this one
 * binds a command to an arm of the route table. They share only the route name.
 *
 * A compile, test and documentation contract with no runtime role — ADR 0049.
 */
export type { SurfaceEntry, SurfaceEquivalence, SurfaceMapInput } from "./surface-map/index.js";
export { SURFACE_MAP, surfaceDefects } from "./surface-map/index.js";

export {
  API_ERROR_CODES,
  ApiError,
  ApiErrorCode,
  ApiHealthState,
  COVERAGE_KINDS,
  CoverageKind,
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
  LedgerInstanceIdentity,
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
  ProjectionWatermarkDto,
  ROADMAP_CONTENT_MAX_BYTES,
  ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES,
  ACCOUNTS_UNAVAILABLE_REASONS,
  ACCOUNT_ACTION_REFUSAL_WORDS,
  AccountActionDto,
  AccountActionDtoRecord,
  AccountActionRefusalDto,
  AccountActionRequest,
  AccountActionWriteResponse,
  AccountActionsResponse,
  MAX_ACCOUNT_ACTIONS,
  // V2-B4b stage 3C: the explicit tool call, as a wire contract. The request
  // schema is exported because two doors parse it -- the API's POST body and
  // the CLI's request document are the same bytes, which is the equivalence
  // claim rather than a convenience.
  MAX_TOOL_CALLS,
  ToolCallExecuteRequest,
  ToolCallExecuteResponse,
  ToolCallPageResponse,
  ToolCallRow,
  ToolCallsQuery,
  // V2 L3: the lifecycle door's contract surface. Re-exported here for the
  // same reason the tool-call schemas above are — this barrel is the package's
  // only entry point, so a schema the gateway must parse against is reachable
  // from nowhere else, and a door that redeclared it would be a second
  // vocabulary for one contract.
  API_LIFECYCLE_MODES,
  API_LIFECYCLE_VERBS,
  ApiLifecycleMode,
  ApiLifecycleVerb,
  TaskLifecycleExecuteResponse,
  TaskLifecycleRequest,
  TaskLifecycleResponse,
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
  STREAM_CHANNELS,
  STREAM_CHANNEL_BY_EVENT_TYPE,
  STREAM_RESYNC_REASONS,
  StreamChannel,
  StreamFrame,
  StreamQuery,
  StreamResyncReason,
  RoadmapContentResponse,
  RoadmapVersionDto,
  RoadmapVersionKindDto,
  RoadmapVersionWriteRequest,
  RoadmapVersionWriteResponse,
  // P-14/B: the initiative registration. Both doors parse the request and print
  // the response, so the pair is reachable from the one entry point.
  InitiativeRegistrationRequest,
  InitiativeRegistrationResponse,
  // P-14/C: the task intake, on the same terms as the registration above it.
  TaskIntakeRequest,
  TaskIntakeResponse,
  RollupSummary,
  StreamIntegrityCoverageDto,
  TASK_STATE_COUNT,
  TaskDetail,
  TaskDetailResponse,
  TaskPageResponse,
  TaskStateCount,
  TaskSummary,
  TasksQuery,
  TimelineItem,
  WATERMARK_SOURCE_STREAMS,
  WatermarkSourceStream,
  WorkerDetail,
  WorkerDetailResponse,
  WorkerPageResponse,
  WorkerRoleCount,
  WorkerSummary,
  WorkersQuery,
  cursorPage,
} from "./schemas/index.js";
