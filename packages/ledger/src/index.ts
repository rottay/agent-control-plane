/**
 * Public surface of the Agent Control Plane ledger.
 *
 * This is the whole contract the CLI, the UI, the orchestrator and the adapters
 * are allowed to depend on. Raw SQLite access is deliberately absent: the
 * append-only guarantee, the hash chain and the projection rules are only
 * enforceable if every mutation goes through append() and rebuildReadModel().
 *
 * Scope note. This package is the P1A slice of P1. It is a ledger and a read
 * model, nothing else. There is no daemon, no Restate integration, no provider
 * adapter, no account switching, no lease engine, no CLI and no UI here, and
 * P1A is not P1 completion nor any form of product adoption.
 */

export { Ledger, openLedger, LEDGER_MIGRATIONS } from "./ledger/index.js";

export {
  CANONICAL_MAX_DEPTH,
  GENESIS_SHA256,
  canonicalJsonStringify,
  chainDigest,
  sha256Hex,
} from "./canonical-json/index.js";

export {
  LedgerError,
  LedgerOpenError,
  LedgerClosedError,
  LedgerReadOnlyError,
  LedgerMigrationError,
  LedgerValidationError,
  LedgerCanonicalizationError,
  LedgerIdempotencyConflictError,
  LedgerEventIdConflictError,
  LedgerLifecycleConflictError,
  LedgerSequenceError,
  LedgerIntegrityError,
  LedgerQueryError,
} from "./errors/index.js";

export type { LedgerErrorCode, LedgerValidationIssue } from "./errors/index.js";

export type { Migration } from "./migrations/index.js";

export {
  ROADMAP_VERSION_REFUSALS,
  decideRoadmapVersion,
} from "./roadmap-version/index.js";

export type {
  RoadmapVersionEvent,
  RoadmapVersionGranted,
  RoadmapVersionOutcome,
  RoadmapVersionRefusal,
  RoadmapVersionRefused,
  RoadmapVersionRequest,
} from "./roadmap-version/index.js";

export type {
  AppendResult,
  AppliedMigration,
  EventPage,
  EventQuery,
  InitiativeAppendResult,
  InitiativeEventPage,
  InitiativeEventQuery,
  InitiativeEventRecord,
  InitiativeReadModel,
  IntegrityProblem,
  IntegrityProblemKind,
  IntegrityReport,
  LedgerEventRecord,
  LedgerPragmaStatus,
  LedgerStatus,
  LedgerTestFaults,
  OpenLedgerOptions,
  ProjectionStatus,
  RebuildResult,
  RoadmapVersionReadModel,
  TaskPage,
  TaskQuery,
  TaskReadModel,
  WorkerPage,
  WorkerQuery,
  WorkerReadModel,
} from "./types/index.js";
