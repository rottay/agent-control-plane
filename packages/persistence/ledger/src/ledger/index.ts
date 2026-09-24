import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  AccountActionEvent,
  ArtifactRegistryEvent,
  BLOB_LIFECYCLE_STATES,
  CONTRACT_VERSION,
  ControlPlaneEvent,
  IdempotencyCoordinates,
  InitiativeEvent,
  PIN_HOLDER_KINDS,
  SUPPORTED_CONTRACT_VERSIONS,
  V2_IDEMPOTENCY_NAMESPACE,
  WORKER_ROLES,
} from "@acp/contracts";

import {
  ACCOUNT_INTEGRITY_GENESIS_SHA256,
  accountIntegrityDigestV1,
  sameStoredInteger,
} from "../account-integrity/index.js";
import {
  GENESIS_SHA256,
  canonicalJsonStringify,
  chainDigest,
  sha256Hex,
} from "../canonical-json/index.js";
import {
  LedgerClosedError,
  LedgerEventIdConflictError,
  LedgerIdempotencyConflictError,
  LedgerIntegrityError,
  LedgerLifecycleConflictError,
  LedgerMigrationError,
  LedgerOpenError,
  LedgerQueryError,
  LedgerReadOnlyError,
  LedgerSequenceError,
  LedgerValidationError,
  type LedgerValidationIssue,
} from "../errors/index.js";
import {
  ACCOUNT_INTEGRITY_MIGRATION,
  DISPATCH_CATALOG_PIN_MIGRATION,
  EFFECT_RESULT_REFERENCE_MIGRATION,
  MODEL_VERSION_PROJECTION,
  PRICE_INTERVAL_PROJECTION,
  INITIATIVE_REGISTRATION_MIGRATION,
  MODEL_VERSION_REGISTRY_MIGRATION,
  PRICE_INTERVAL_CATALOG_MIGRATION,
  TASK_REVISION_MIGRATION,
  TASK_SUBMISSION_MIGRATION,
  USAGE_CAPTURE_MIGRATION,
  ACCOUNT_STREAM,
  DERIVED_TABLES,
  EXPECTED_SCHEMA_OBJECTS,
  INITIATIVE_PROJECTION_NAMES,
  INITIATIVE_STREAM,
  MIGRATIONS,
  PROJECTION_NAMES,
  PROJECTION_SOURCES,
  PROJECTOR_VERSION,
  REGISTRY_PROJECTION_NAMES,
  REGISTRY_STREAM,
  ROUTING_ASSIGNMENT_PROJECTION,
  SCHEMA_MIGRATIONS_DDL,
  TASK_STREAM,
  applyMigrations,
  checkMigrationConformance,
  readAppliedMigrations,
  schemaMigrationsTableExists,
  type ProjectionSource,
} from "../migrations/index.js";
import {
  applyArtifactEventToSnapshot,
  applyEventToSnapshot,
  applyInitiativeEventToSnapshot,
  artifactBlobKey,
  artifactEventKindRefusal,
  artifactEventRefusal,
  artifactSubjectOf,
  createArtifactProjectionSnapshot,
  nextArtifactProjection,
  applyRegistryEventToSnapshot,
  DISPATCH_INTENDED,
  DISPATCH_KEY,
  DISPATCH_OUTCOME_RECORDED,
  EFFECT_INTENDED,
  EFFECT_KEY,
  INVOCATION_ID_KEY,
  LEGACY_ATTEMPT_NUMBER_KEY,
  LOCAL_KEY_PATTERN,
  OUTCOME_KEY,
  RESULT_ARTIFACT_REFERENCE_KEY,
  RESULT_SHA256_KEY,
  REVISION_ID_KEY,
  SEGMENT_KEY,
  SEMANTIC_SCOPE_KEYS,
  TASK_ATTEMPT_OPENED,
  canonicalAttempt,
  canonicalDispatchBirth,
  canonicalEffect,
  sameRevisionRecord,
  canonicalSegment,
  dispatchOutcomeRecord,
  dispatchPinReading,
  dispatchTransitionAdmitted,
  effectOutcomeArrival,
  effectIdV1,
  effectIdempotencyKeyV1,
  logicalOperationSha256,
  nextDispatchAttemptProjection,
  nextDispatchAttemptState,
  nextEffectProjection,
  nextExecutionRouteSegmentProjection,
  PROMPT_OCCURRENCE_KEY,
  RESPONSE_OCCURRENCE_KEY,
  canonicalPromptOccurrence,
  canonicalResponseOccurrence,
  nextPromptOccurrenceProjection,
  nextResponseOccurrenceProjection,
  promptOccurrenceLinkRefusal,
  readPromptOccurrence,
  readResponseOccurrence,
  responseOccurrenceLinkRefusal,
  createInitiativeProjectionSnapshot,
  createProjectionSnapshot,
  createRegistryProjectionSnapshot,
  applyRegistryModelVersionToSnapshot,
  createModelVersionProjectionSnapshot,
  globalAssignmentIssues,
  modelVersionPayloadIssues,
  nextModelVersionProjection,
  applyRegistryPriceIntervalToSnapshot,
  createPriceIntervalProjectionSnapshot,
  nextPriceIntervalProjection,
  priceIntervalKey,
  priceTableIssues,
  executionRouteKey,
  nextExecutionRouteProjection,
  nextTaskAttemptProjection,
  nextTaskRevisionProjection,
  nextTaskSubmissionProjection,
  assertSameTaskSubmission,
  taskSubmissionKey,
  ENVELOPE_ARTIFACT_REFERENCE_KEY,
  taskAttemptKey,
  taskRevisionKey,
  nextInitiativeProjection,
  nextRoadmapVersionProjection,
  nextRoutingAssignmentProjection,
  nextTaskProjection,
  nextWorkerProjection,
  nextWorkerTaskProjection,
  routingFallbackKey,
  workerTaskKey,
  type DispatchOutcomeRecord,
  type InitiativeProjectionSnapshot,
  type ProjectionSnapshot,
  type WorkerTaskProjection,
  OUTBOX_COMMAND_INTENDED,
  OUTBOX_EVENT_TYPES,
  applyEventToOutboxFold,
  createOutboxFold,
  isQuarantineEvent,
  nextOutboxCommand,
  outboxLinkRefusal,
  readOutboxEvent,
  type OutboxAttemptRecord,
  type OutboxPredecessor,
  assertUsageCaptureAdmissible,
  nextUsageCapture,
  usageRowText,
  usageSettlementKey,
  usageSettlementObservationKey,
  usageSettlementSourceHeadKey,
  isInstant,
  segmentTransportRefusal,
} from "../projection/index.js";
import {
  DISPATCH_STATE_TRANSITIONS,
  DOCUMENT_KINDS,
  EXECUTION_EFFECT_KINDS,
  INLINE_CONTENT_DOCUMENT_KINDS,
  EXECUTION_REQUEST_CONTRACT_VERSIONS,
  type AppendBatchResult,
  type AppendResult,
  type AppliedMigration,
  type ArtifactAppendResult,
  type ArtifactBlobReadModel,
  type ArtifactEventRecord,
  type ArtifactFoldView,
  type ArtifactPinReadModel,
  type ArtifactProjectionSnapshot,
  type ArtifactProjectionWrites,
  type ArtifactReferenceReadModel,
  type ArtifactTombstoneReadModel,
  type CausationRef,
  type CausationStream,
  type DispatchAttemptReadModel,
  type DispatchState,
  type DocumentKind,
  type EffectLookup,
  type EffectLookupQuery,
  type EffectOutcomeStatus,
  type EffectReadModel,
  type TaskEffectPage,
  type EventPage,
  type EventQuery,
  type ExecutionEffectKind,
  type ExecutionRouteReadModel,
  type ExecutionRouteSegmentReadModel,
  type InitiativeAppendResult,
  type InitiativeEventPage,
  type InitiativeEventQuery,
  type InitiativeEventRecord,
  type InitiativeReadModel,
  type GlobalRoutingAssignmentReading,
  type ModelVersionEligibleRoleRow,
  type ModelVersionEntry,
  type ModelVersionProjection,
  type ModelVersionProjectionSnapshot,
  type ModelVersionReadModel,
  type ModelVersionReading,
  type ModelVersionTransportRow,
  type PriceIntervalProjection,
  type PriceIntervalProjectionSnapshot,
  type PriceIntervalQuery,
  type PriceIntervalReadModel,
  type PriceIntervalRow,
  type RegistryWatermarkReading,
  type IntegrityProblem,
  type IntegrityReport,
  type ModelResolutionStatus,
  type OutboxCommandReadModel,
  type PromptOccurrenceReadModel,
  type RedactionVerdict,
  type ResponseOccurrenceReadModel,
  type LedgerEventRecord,
  type LedgerIdentity,
  type LedgerStatus,
  type LedgerTestFaults,
  type OpenLedgerOptions,
  type ProjectionStatus,
  type ProjectionWatermarkStatus,
  type RebuildResult,
  type RegistryAppendResult,
  type RegistryDocument,
  type RegistryEventRecord,
  type StreamIntegrityCoverage,
  type RegistryProjectionSnapshot,
  type RoadmapVersionReadModel,
  type RoutingAssignmentFallbackRow,
  type RoutingAssignmentProjection,
  type RoutingAssignmentReadModel,
  type TaskPage,
  type TaskQuery,
  type TaskAttemptReadModel,
  type TaskReadModel,
  type TaskRevisionReadModel,
  type TaskSubmissionReadModel,
  TASK_CLIENT_KEY_PATTERN,
  type WorkerPage,
  type WorkerQuery,
  type WorkerReadModel,
  type AccountActionAppendResult,
  type AccountActionRecordRow,
  type AccountEventRow,
  type AccountIntegrityState,
  type UsageCaptureView,
  type UsageCaptureWrites,
  type UsageMeasurementStreamReadModel,
  type UsageObservationReadModel,
  type UsageSettlementObservationReadModel,
  type UsageSettlementReadModel,
  type UsageSettlementRecord,
  type UsageSettlementSourceHeadReadModel,
} from "../types/index.js";
import { pinCovers, selectVigentCatalogVersion } from "../price-catalog/index.js";
import type { CatalogVersionFact, PricePin } from "../price-catalog/index.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 300_000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1_000;
const REPLAY_BATCH_SIZE = 500;

/**
 * Sentinel timestamp for a projection that has consumed no events yet. It is a
 * constant rather than a clock reading so that a fresh ledger is byte-identical
 * everywhere, and so that nothing in the projection path depends on the time.
 */
const EPOCH_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const EVENT_COLUMNS =
  "sequence, event_id, idempotency_key, task_id, attempt, transition_id, type, " +
  "from_state, to_state, emitted_by, occurred_at, recorded_at, correlation_id, " +
  "causation_id, causation_stream, causation_sequence, causation_sha256, " +
  "contract_version, event_json, previous_sha256, event_sha256";

const HEAD_SEQUENCE = "head_sequence";
const HEAD_EVENT_SHA256 = "head_event_sha256";
const EVENT_COUNT = "event_count";

const INITIATIVE_EVENT_COLUMNS =
  "sequence, event_id, idempotency_key, initiative_id, transition_id, type, " +
  "from_status, to_status, emitted_by, occurred_at, recorded_at, " +
  "causation_stream, causation_sequence, causation_sha256, contract_version, " +
  "event_json, previous_sha256, event_sha256";

const INITIATIVE_HEAD_SEQUENCE = "initiative_head_sequence";
const INITIATIVE_HEAD_EVENT_SHA256 = "initiative_head_event_sha256";
const INITIATIVE_EVENT_COUNT = "initiative_event_count";

const REGISTRY_EVENT_COLUMNS =
  "sequence, event_id, idempotency_key, subject_kind, document_kind, artifact_event_kind, " +
  "document_id, document_version, " +
  "content_digest, parent_document_version, recorded_by, effective_from, occurred_at, " +
  "recorded_at, causation_stream, causation_sequence, causation_sha256, contract_version, " +
  "event_json, previous_sha256, event_sha256";

const REGISTRY_HEAD_SEQUENCE = "registry_head_sequence";
const REGISTRY_HEAD_EVENT_SHA256 = "registry_head_event_sha256";
const REGISTRY_EVENT_COUNT = "registry_event_count";

const ACCOUNT_INTEGRITY_BASELINE_SEQUENCE = "account_integrity_baseline_sequence";
const ACCOUNT_INTEGRITY_BASELINE_SHA256 = "account_integrity_baseline_sha256";
const ACCOUNT_INTEGRITY_ACTIVATED_AT = "account_integrity_activated_at";
const ACCOUNT_INTEGRITY_HEAD_SEQUENCE = "account_integrity_head_sequence";
const ACCOUNT_INTEGRITY_HEAD_EVENT_SHA256 = "account_integrity_head_event_sha256";

/** The five activation keys, as one list, so no reader can ask for a subset. */
const ACCOUNT_INTEGRITY_KEYS: readonly string[] = [
  ACCOUNT_INTEGRITY_BASELINE_SEQUENCE,
  ACCOUNT_INTEGRITY_BASELINE_SHA256,
  ACCOUNT_INTEGRITY_ACTIVATED_AT,
  ACCOUNT_INTEGRITY_HEAD_SEQUENCE,
  ACCOUNT_INTEGRITY_HEAD_EVENT_SHA256,
];

/**
 * The columns of one `account_events` row, in the order the preimage reads them.
 *
 * Every TEXT column is selected as `CAST(col AS BLOB)`, aliased back to its own
 * name so the row keeps the shape of the table. That is not a stylistic choice:
 * SQLite does not validate that a TEXT column holds well-formed UTF-8, and a
 * driver hands such a column over as a JavaScript string with every invalid
 * sequence already replaced by U+FFFD. Hashing the string would give the single
 * stored byte `80` and the three stored bytes `EF BF BD` one digest, so
 * substituting one for the other would verify clean — and detecting exactly
 * that substitution is what the sidecar is for.
 *
 * The two INTEGER columns need no cast; they need `safeIntegers`, which is a
 * property of the prepared statement rather than of the column list, and every
 * reader of this constant sets it. See `AccountEventRow`.
 */
const ACCOUNT_EVENT_COLUMNS =
  "sequence, CAST(event_id AS BLOB) AS event_id, " +
  "CAST(idempotency_key AS BLOB) AS idempotency_key, " +
  "CAST(account_id AS BLOB) AS account_id, version, CAST(action AS BLOB) AS action, " +
  "CAST(resulting_state AS BLOB) AS resulting_state, CAST(actor AS BLOB) AS actor, " +
  "CAST(note AS BLOB) AS note, CAST(occurred_at AS BLOB) AS occurred_at, " +
  "CAST(recorded_at AS BLOB) AS recorded_at, " +
  "CAST(contract_version AS BLOB) AS contract_version, " +
  "CAST(event_json AS BLOB) AS event_json";

const INSTANCE_ID = "instance_id";
const RESTORE_ID = "restore_id";
const RESTORE_EPOCH = "restore_epoch";

/** The three identity keys, as one list, so no reader can ask for a subset. */
const IDENTITY_KEYS: readonly string[] = [INSTANCE_ID, RESTORE_ID, RESTORE_EPOCH];

/**
 * A version 4 UUID, lowercase, in the one form `randomUUID` produces.
 *
 * Strict on the version and variant nibbles rather than merely on the shape:
 * the contract says "UUID v4", and a value that is 36 characters of hex and
 * dashes but was produced by a counter would satisfy a looser pattern while
 * being exactly the defect this identity exists to rule out.
 */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A non-negative integer in the one form `String(n)` produces.
 *
 * No sign, no exponent, no radix prefix, no surrounding space, no leading zero
 * except the number zero itself. `Number` accepts all of those and returns
 * something `Number.isInteger` is happy with, so a text check has to come
 * first: the question is not "what does this coerce to" but "is this a value
 * this code could have written".
 */
const CANONICAL_COUNT_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * Read a stored count, or refuse it. Null means "this is not one".
 *
 * Every number this module keeps in `ledger_meta` is written as `String(n)` of
 * a non-negative safe integer, and genesis is the literal `"0"` that the
 * migrations seed — so the pattern above is the exact set of texts this code
 * can have produced, zero included.
 *
 * The text is matched before it is converted because `Number` is a coercion
 * rather than a parse, and `Number.isInteger` is happy with what it returns:
 * `""` becomes 0, `"1e3"` becomes 1000, `"0x1f"` becomes 31, `" 7 "` becomes 7,
 * `"+2"` becomes 2 and `"-0"` becomes a negative zero that no `< 0` test
 * catches. A head row edited to any of those would be laundered into a
 * plausible position by the very check written to refuse it.
 *
 * Returning null rather than throwing keeps each caller's own diagnostic: a
 * head, a count and a restore ordering are different facts and say so
 * differently when they are wrong.
 */
function readCanonicalCount(text: string): number | null {
  if (!CANONICAL_COUNT_PATTERN.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The byte budget of one registry document's canonical body.
 *
 * The contract says `event_json` is bounded and does not say by how much; a
 * stream with no bound at all is a way to put a megabyte of configuration
 * inside a chain of small canonical facts, which is what the artifact store
 * exists to prevent. Content lives beside the database and the document
 * records its digest.
 */
const REGISTRY_EVENT_JSON_MAX_BYTES = 64 * 1024;

/** Bound on the identifiers a document carries, so a diagnostic stays small. */
const REGISTRY_IDENTIFIER_MAX = 512;

interface EventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly transition_id: string;
  readonly type: string;
  readonly from_state: string | null;
  readonly to_state: string;
  readonly emitted_by: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly causation_stream: string | null;
  readonly causation_sequence: number | null;
  readonly causation_sha256: string | null;
  readonly contract_version: string;
  readonly event_json: string;
  readonly previous_sha256: string;
  readonly event_sha256: string;
}

interface InitiativeEventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly initiative_id: string;
  readonly transition_id: string;
  readonly type: string;
  readonly from_status: string | null;
  readonly to_status: string;
  readonly emitted_by: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly causation_stream: string | null;
  readonly causation_sequence: number | null;
  readonly causation_sha256: string | null;
  readonly contract_version: string;
  readonly event_json: string;
  readonly previous_sha256: string;
  readonly event_sha256: string;
}

interface RegistryEventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly idempotency_key: string;
  /** `DOCUMENT` or `ARTIFACT` since migration 15, and the branch every reader takes. */
  readonly subject_kind: string;
  /** Null exactly on an `ARTIFACT` row. */
  readonly document_kind: string | null;
  /** Null exactly on a `DOCUMENT` row. */
  readonly artifact_event_kind: string | null;
  readonly document_id: string;
  readonly document_version: number;
  readonly content_digest: string;
  readonly parent_document_version: number | null;
  readonly recorded_by: string;
  readonly effective_from: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly causation_stream: string | null;
  readonly causation_sequence: number | null;
  readonly causation_sha256: string | null;
  readonly contract_version: string;
  readonly event_json: string;
  readonly previous_sha256: string;
  readonly event_sha256: string;
}

/** The columns a causal reference occupies, in any stream's table. */
interface CausationColumns {
  readonly causation_stream: string | null;
  readonly causation_sequence: number | null;
  readonly causation_sha256: string | null;
}

/**
 * The streams a reference may name in this build (P-09/log-B, widened by C).
 *
 * The contract's vocabulary is four names; these are the three whose events
 * carry an `event_sha256`. `registry_events` joined the list in the packet that
 * gave it a chain. A reference to `account_events` could only be believed,
 * never checked, and the contract is explicit that a digest which does not
 * match is an invalid reference rather than a weak link — so a reference that
 * *cannot* be matched at all is refused here rather than stored.
 */
const CAUSATION_STREAMS: readonly CausationStream[] = [
  "control_plane_events",
  "initiative_events",
  "registry_events",
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isCausationStream(value: unknown): value is CausationStream {
  return typeof value === "string" && CAUSATION_STREAMS.includes(value as CausationStream);
}

/**
 * The table a reference resolves against.
 *
 * A total function over the closed set, returning one of three literals written
 * in this module. Nothing a caller supplies is ever concatenated into SQL, for
 * the reason `safeIdentifier` exists a few lines below.
 */
function causationTable(stream: CausationStream): string {
  if (stream === "control_plane_events") return "control_plane_events";
  if (stream === "initiative_events") return "initiative_events";
  return "registry_events";
}

/** Read a reference out of a stored row, refusing a triple the base should not hold. */
function causationFromRow(row: CausationColumns, sequence: number): CausationRef | null {
  const { causation_stream: stream, causation_sequence: at, causation_sha256: digest } = row;
  if (stream === null && at === null && digest === null) return null;
  if (stream === null || at === null || digest === null || !isCausationStream(stream)) {
    // Only reachable if the BEFORE INSERT trigger was dropped after the row was
    // written. Reading it as "no cause" would launder the tampering.
    throw new LedgerIntegrityError([
      "sequence " + String(sequence) + " holds a causal reference this build cannot resolve",
    ]);
  }
  return { stream, sequence: at, sha256: digest };
}

/** Shape-check a caller's reference. Pure: this reads no database. */
function normalizeCausation(
  candidate: CausationRef | null | undefined,
  path: string,
): CausationRef | null {
  if (candidate === undefined || candidate === null) return null;

  const issues: LedgerValidationIssue[] = [];
  if (typeof candidate !== "object") {
    throw new LedgerValidationError([
      { path, message: "a causal reference is an object with a stream, a sequence and a digest" },
    ]);
  }
  if (!isCausationStream(candidate.stream)) {
    issues.push({
      path: path + ".stream",
      message:
        "a causal reference names a stream whose digest this build can verify: " +
        CAUSATION_STREAMS.join(" or "),
    });
  }
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) {
    // Zero is the genesis digest's position and belongs to no row of any
    // stream, so it is not a reference anything could resolve.
    issues.push({
      path: path + ".sequence",
      message: "a causal reference names a position of one or greater",
    });
  }
  if (typeof candidate.sha256 !== "string" || !SHA256_PATTERN.test(candidate.sha256)) {
    issues.push({
      path: path + ".sha256",
      message: "a causal digest is 64 lowercase hexadecimal characters",
    });
  }
  if (issues.length > 0) throw new LedgerValidationError(issues);

  // Copied rather than kept, so a caller mutating its own object after the call
  // cannot change what the record says was written.
  return {
    stream: candidate.stream,
    sequence: candidate.sequence,
    sha256: candidate.sha256,
  };
}

function causationEquals(left: CausationRef | null, right: CausationRef | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.stream === right.stream &&
    left.sequence === right.sequence &&
    left.sha256 === right.sha256
  );
}

/**
 * What an idempotent replay compares, when it asks whether two appends of one
 * key are the same append.
 *
 * The body alone is not enough any more. The triple is deliberately outside
 * `event_json` — the event contract lives in another package and is not this
 * packet's to widen — so a retry under the same key with a *different* recorded
 * cause has an identical body, and a comparison of bodies would answer
 * `inserted: false` and lose the discrepancy in silence.
 *
 * With no reference on either side this is exactly `sha256Hex(canonicalJson)`,
 * which is what the digests carried by `LedgerIdempotencyConflictError` have
 * always meant. A reference widens the preimage, and only then.
 */
function appendContentDigest(canonicalJson: string, causation: CausationRef | null): string {
  if (causation === null) return sha256Hex(canonicalJson);
  return sha256Hex(
    canonicalJson +
      "\n" +
      causation.stream +
      "\n" +
      String(causation.sequence) +
      "\n" +
      causation.sha256,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= REGISTRY_IDENTIFIER_MAX;
}

/**
 * The arguments of the artifact plane's read verbs, refused by name before a
 * statement runs. A digest is artifacts §3's domain; an identifier is the
 * registry door's bound; a generation is a positive integer.
 */
function requireArtifactDigest(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new LedgerQueryError(field + " must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function requireArtifactIdentifier(value: string, field: string): string {
  if (!isBoundedIdentifier(value)) {
    throw new LedgerQueryError(
      field + " must be a non-empty string of at most " + String(REGISTRY_IDENTIFIER_MAX) + " characters",
    );
  }
  return value;
}

function requireArtifactCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LedgerQueryError(field + " must be a positive integer");
  }
  return value;
}

/**
 * Shape-check a registry document by hand, and refuse anything the base would.
 *
 * By hand because this package may not import `zod` — the fence pins its three
 * runtime dependencies by equality — and because the contract package owns no
 * schema for these documents yet. `normalizeCausation` above is the precedent
 * and the pattern: pure, reading no database, and copying rather than keeping
 * the caller's object so a later mutation cannot change what was recorded.
 *
 * Every rule here has a twin in `ck_registry_events__*`. The door exists so a
 * refusal is a typed `LedgerValidationError` naming the field, rather than a
 * raw SQLite constraint failure nobody can catch by class; the base is what
 * holds the same line for a caller who reaches past the door.
 *
 * Exported for the registry publication (P-15/R, ADR 0104), which parses its
 * candidate here before it compares it with a recorded version, so a form problem
 * is refused as one and never reported as a conflict. The one parser, not a copy.
 */
export function normalizeRegistryDocument(candidate: unknown): RegistryDocument {
  if (!isPlainObject(candidate)) {
    throw new LedgerValidationError([
      { path: "<root>", message: "a registry document is an object" },
    ]);
  }

  const issues: LedgerValidationIssue[] = [];
  const fields = candidate;

  for (const field of ["contractVersion", "eventId", "idempotencyKey", "documentId", "recordedBy"]) {
    if (!isBoundedIdentifier(fields[field])) {
      issues.push({
        path: field,
        message:
          "a registry document's " +
          field +
          " is a string of 1 to " +
          String(REGISTRY_IDENTIFIER_MAX) +
          " characters",
      });
    }
  }

  const documentKind = fields["documentKind"];
  if (
    typeof documentKind !== "string" ||
    !(DOCUMENT_KINDS as readonly string[]).includes(documentKind)
  ) {
    issues.push({
      path: "documentKind",
      message: "a registry document names one of the contract's document kinds",
    });
  }

  const documentVersion = fields["documentVersion"];
  if (!Number.isSafeInteger(documentVersion) || (documentVersion as number) < 1) {
    issues.push({
      path: "documentVersion",
      message: "a document version is an integer of one or greater",
    });
  }

  const parentDocumentVersion = fields["parentDocumentVersion"];
  if (parentDocumentVersion !== null) {
    // Null is not a default here: it is the assertion that this is the first
    // version of the document, and the door checks that claim against the
    // stream before it inserts.
    if (
      !Number.isSafeInteger(parentDocumentVersion) ||
      (parentDocumentVersion as number) < 1 ||
      (Number.isSafeInteger(documentVersion) &&
        (parentDocumentVersion as number) >= (documentVersion as number))
    ) {
      issues.push({
        path: "parentDocumentVersion",
        message: "a parent version is null, or an earlier version of the same document",
      });
    }
  }

  const contentDigest = fields["contentDigest"];
  if (typeof contentDigest !== "string" || !SHA256_PATTERN.test(contentDigest)) {
    issues.push({
      path: "contentDigest",
      message: "a content digest is 64 lowercase hexadecimal characters",
    });
  }

  for (const field of ["effectiveFrom", "occurredAt", "recordedAt"]) {
    if (!isInstant(fields[field])) {
      issues.push({
        path: field,
        message: "a registry document's " + field + " is an ISO-8601 instant in UTC with milliseconds",
      });
    }
  }

  const occurredAt = fields["occurredAt"];
  const recordedAt = fields["recordedAt"];
  if (isInstant(occurredAt) && isInstant(recordedAt) && recordedAt < occurredAt) {
    // Lexicographic comparison is exact for this form: fixed width, UTC, and
    // zero-padded throughout.
    issues.push({
      path: "recordedAt",
      message: "a document is recorded no earlier than it occurred",
    });
  }

  const payload = fields["payload"];
  if (!isPlainObject(payload)) {
    issues.push({ path: "payload", message: "a registry document's payload is an object" });
  }

  if (issues.length > 0) throw new LedgerValidationError(issues);

  return {
    contractVersion: fields["contractVersion"] as string,
    eventId: fields["eventId"] as string,
    idempotencyKey: fields["idempotencyKey"] as string,
    documentKind: documentKind as DocumentKind,
    documentId: fields["documentId"] as string,
    documentVersion: documentVersion as number,
    parentDocumentVersion: parentDocumentVersion === null ? null : (parentDocumentVersion as number),
    contentDigest: contentDigest as string,
    recordedBy: fields["recordedBy"] as string,
    effectiveFrom: fields["effectiveFrom"] as string,
    occurredAt: occurredAt as string,
    recordedAt: recordedAt as string,
    payload: payload as Record<string, unknown>,
  };
}

/**
 * The same check as a verdict rather than a throw.
 *
 * The read paths ask "is this a document?" and act on the answer, exactly as
 * the other two streams ask their contract with `safeParse`. Written once, so
 * a caller that wants the verdict does not have to spell out a `catch` that
 * silently discards the reason.
 */
function tryNormalizeRegistryDocument(candidate: unknown): RegistryDocument | null {
  try {
    return normalizeRegistryDocument(candidate);
  } catch {
    return null;
  }
}

/**
 * The byte bound, checked at the door and nowhere else.
 *
 * Deliberately not part of `normalizeRegistryDocument`, which runs once per row
 * on every replay: a body already on disk is inside the bound by construction,
 * because it got there through this check, and re-measuring it would make a
 * rebuild pay for a rule it cannot act on anyway. A stored row that somehow
 * exceeded it is a tampering question, and the chain answers that one.
 */
function assertRegistryBodyBounded(canonicalJson: string): void {
  if (Buffer.byteLength(canonicalJson, "utf8") <= REGISTRY_EVENT_JSON_MAX_BYTES) return;
  throw new LedgerValidationError([
    {
      path: "payload",
      message:
        "a registry document's canonical body exceeds " +
        String(REGISTRY_EVENT_JSON_MAX_BYTES) +
        " bytes; content belongs in the artifact store, and the document records its digest",
    },
  ]);
}

/**
 * Parse an artifact event at the door, refusing by name what the stream refuses.
 *
 * Unlike a registry document, an artifact event HAS a schema in
 * `@acp/contracts`, so this is a `safeParse` and not a hand-written check: the
 * credential and transcript guards live in that schema, and a door that
 * validated by hand would let a sentinel through that the contract refuses
 * (M-6). Two refusals run around it. Before: the three words of the contract
 * this build does not record, named at `artifactEventKind` rather than lost in a
 * union the parser cannot match. After: the rules of the stream no row can
 * carry — a `SECRET_BEARING` reference, a policy outside the closed set, a
 * publication pin taken by hand.
 *
 * Every issue carries a path and a reason, never the rejected value.
 */
function normalizeArtifactEvent(candidate: unknown): ArtifactRegistryEvent {
  if (!isPlainObject(candidate)) {
    throw new LedgerValidationError([{ path: "<root>", message: "an artifact event is an object" }]);
  }
  const kindRefusal = artifactEventKindRefusal(candidate["artifactEventKind"]);
  if (kindRefusal !== null) throw new LedgerValidationError([kindRefusal]);

  const parsed = ArtifactRegistryEvent.safeParse(candidate);
  if (!parsed.success) {
    throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
  }
  const refusal = artifactEventRefusal(parsed.data);
  if (refusal !== null) throw new LedgerValidationError([refusal]);
  return parsed.data;
}

/** The artifact twin of `assertRegistryBodyBounded`: the same budget, its own words. */
function assertArtifactBodyBounded(canonicalJson: string): void {
  if (Buffer.byteLength(canonicalJson, "utf8") <= REGISTRY_EVENT_JSON_MAX_BYTES) return;
  throw new LedgerValidationError([
    {
      path: "payload",
      message:
        "an artifact event's canonical body exceeds " +
        String(REGISTRY_EVENT_JSON_MAX_BYTES) +
        " bytes; an event records the facts of some bytes, never the bytes",
    },
  ]);
}

/** The payload path that names an artifact event's subject, for a refusal. */
function artifactSubjectPath(event: ArtifactRegistryEvent): string {
  switch (event.artifactEventKind) {
    case "PUBLICATION_INTENDED":
    case "PUBLICATION_SUCCEEDED":
    case "PUBLICATION_ABANDONED":
      return "payload.contentSha256";
    case "REFERENCE_RECORDED":
      return "payload.reference.artifactReferenceId";
    case "PIN_ACQUIRED":
    case "PIN_RELEASED":
      return "payload.artifactPinId";
  }
}

interface ArtifactBlobRow {
  readonly content_sha256: string;
  readonly blob_generation: number;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly lifecycle_state: string;
  readonly encryption_status: string;
  readonly key_reference: string | null;
  readonly first_published_sequence: number | null;
  readonly first_published_at: string | null;
  readonly reclaim_id: string | null;
  readonly reclaimed_at: string | null;
  readonly grace_started_at: string;
  readonly encryption_profile: string;
  readonly applied_sequence: number;
}

interface ArtifactReferenceRow {
  readonly artifact_reference_id: string;
  readonly content_sha256: string;
  readonly blob_generation: number;
  readonly artifact_class: string;
  readonly classification: string;
  readonly scope_kind: string;
  readonly scope_id: string | null;
  readonly producer_identity: string;
  readonly access_policy_id: string;
  readonly retention_class: string;
  readonly expires_at: string | null;
  readonly tombstoned_at: string | null;
  readonly tombstone_reason: string | null;
  readonly created_sequence: number;
  readonly applied_sequence: number;
}

interface ArtifactPinRow {
  readonly artifact_pin_id: string;
  readonly content_sha256: string;
  readonly blob_generation: number;
  readonly pin_holder_kind: string;
  readonly pin_holder_id: string;
  readonly acquired_sequence: number;
  readonly released_sequence: number | null;
  readonly applied_sequence: number;
}

interface ArtifactTombstoneRow {
  readonly artifact_reference_id: string;
  readonly content_sha256: string;
  readonly blob_generation: number;
  readonly reason: string;
  readonly decided_by: string;
  readonly authority_sha256: string;
  readonly recorded_sequence: number;
  readonly applied_sequence: number;
}

function artifactBlobRowToModel(row: ArtifactBlobRow): ArtifactBlobReadModel {
  return {
    contentSha256: row.content_sha256,
    blobGeneration: row.blob_generation,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    lifecycleState: row.lifecycle_state as ArtifactBlobReadModel["lifecycleState"],
    encryptionStatus: row.encryption_status as ArtifactBlobReadModel["encryptionStatus"],
    keyReference: row.key_reference,
    firstPublishedSequence: row.first_published_sequence,
    firstPublishedAt: row.first_published_at,
    reclaimId: row.reclaim_id,
    reclaimedAt: row.reclaimed_at,
    graceStartedAt: row.grace_started_at,
    encryptionProfile: row.encryption_profile,
    appliedSequence: row.applied_sequence,
  };
}

function artifactReferenceRowToModel(row: ArtifactReferenceRow): ArtifactReferenceReadModel {
  return {
    artifactReferenceId: row.artifact_reference_id,
    contentSha256: row.content_sha256,
    blobGeneration: row.blob_generation,
    artifactClass: row.artifact_class as ArtifactReferenceReadModel["artifactClass"],
    classification: row.classification as ArtifactReferenceReadModel["classification"],
    scopeKind: row.scope_kind as ArtifactReferenceReadModel["scopeKind"],
    scopeId: row.scope_id,
    producerIdentity: row.producer_identity,
    accessPolicyId: row.access_policy_id,
    retentionClass: row.retention_class as ArtifactReferenceReadModel["retentionClass"],
    expiresAt: row.expires_at,
    tombstonedAt: row.tombstoned_at,
    tombstoneReason: row.tombstone_reason,
    createdSequence: row.created_sequence,
    appliedSequence: row.applied_sequence,
  };
}

function artifactPinRowToModel(row: ArtifactPinRow): ArtifactPinReadModel {
  return {
    artifactPinId: row.artifact_pin_id,
    contentSha256: row.content_sha256,
    blobGeneration: row.blob_generation,
    pinHolderKind: row.pin_holder_kind as ArtifactPinReadModel["pinHolderKind"],
    pinHolderId: row.pin_holder_id,
    acquiredSequence: row.acquired_sequence,
    releasedSequence: row.released_sequence,
    appliedSequence: row.applied_sequence,
  };
}

function artifactTombstoneRowToModel(row: ArtifactTombstoneRow): ArtifactTombstoneReadModel {
  return {
    artifactReferenceId: row.artifact_reference_id,
    contentSha256: row.content_sha256,
    blobGeneration: row.blob_generation,
    reason: row.reason,
    decidedBy: row.decided_by,
    authoritySha256: row.authority_sha256,
    recordedSequence: row.recorded_sequence,
    appliedSequence: row.applied_sequence,
  };
}

interface RoutingAssignmentRow {
  readonly assignment_id: string;
  readonly scope_kind: string;
  readonly scope_id: string | null;
  readonly version: number;
  readonly role: string;
  readonly slot: number;
  readonly provider: string;
  readonly model_version_id: string;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly superseded_by: string | null;
  readonly source_stream: string;
  readonly source_sequence: number;
  readonly sequence: number;
}

interface RoutingFallbackRow {
  readonly assignment_id: string;
  readonly ordinal: number;
  readonly model_version_id: string;
}

interface ModelVersionRow {
  readonly model_version_id: string;
  readonly provider: string;
  readonly model: string;
  readonly release: string;
  readonly status: string;
  readonly context_tokens: number;
  readonly latest_performance_window: string | null;
  readonly policy_version: string;
  readonly deprecated_at: string | null;
  readonly document_version: number;
  readonly sequence: number;
}

interface ModelVersionEligibleRoleDbRow {
  readonly model_version_id: string;
  readonly ordinal: number;
  readonly role: string;
}

interface ModelVersionTransportDbRow {
  readonly model_version_id: string;
  readonly ordinal: number;
  readonly transport_kind: string;
}

function modelVersionRowToModel(row: ModelVersionRow): ModelVersionReadModel {
  return {
    modelVersionId: row.model_version_id,
    provider: row.provider,
    model: row.model,
    release: row.release,
    status: row.status as ModelVersionReadModel["status"],
    contextTokens: row.context_tokens,
    latestPerformanceWindow: row.latest_performance_window,
    policyVersion: row.policy_version,
    deprecatedAt: row.deprecated_at,
    documentVersion: row.document_version,
    sequence: row.sequence,
  };
}

function modelVersionRoleRowToModel(row: ModelVersionEligibleRoleDbRow): ModelVersionEligibleRoleRow {
  return {
    modelVersionId: row.model_version_id,
    ordinal: row.ordinal,
    role: row.role as ModelVersionEligibleRoleRow["role"],
  };
}

function modelVersionTransportRowToModel(row: ModelVersionTransportDbRow): ModelVersionTransportRow {
  return {
    modelVersionId: row.model_version_id,
    ordinal: row.ordinal,
    transportKind: row.transport_kind,
  };
}

/**
 * Write one model version projection through whichever statement source the
 * caller holds (P-14 A).
 *
 * One writer for the three places that write these tables — the door, the
 * rebuild and migration 17's retroactive fold — so they cannot come to disagree
 * about what applying a version means. Children first out and last in, for the
 * immediate foreign keys: the old children go, the row is replaced or removed,
 * and the new children are inserted under it.
 */
function writeModelVersionProjection(
  prepare: (sql: string) => Database.Statement,
  projected: ModelVersionProjection,
): void {
  const { modelVersionId, row } = projected;
  prepare("DELETE FROM model_version_transport WHERE model_version_id = ?").run(modelVersionId);
  prepare("DELETE FROM model_version_eligible_role WHERE model_version_id = ?").run(modelVersionId);
  if (row === null) {
    prepare("DELETE FROM model_version_read_model WHERE model_version_id = ?").run(modelVersionId);
    return;
  }
  prepare(
    "INSERT INTO model_version_read_model (" +
      "model_version_id, provider, model, release, status, context_tokens, " +
      "latest_performance_window, policy_version, deprecated_at, document_version, sequence" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (model_version_id) DO UPDATE SET " +
      "provider = excluded.provider, model = excluded.model, release = excluded.release, " +
      "status = excluded.status, context_tokens = excluded.context_tokens, " +
      "latest_performance_window = excluded.latest_performance_window, " +
      "policy_version = excluded.policy_version, deprecated_at = excluded.deprecated_at, " +
      "document_version = excluded.document_version, sequence = excluded.sequence",
  ).run(
    row.modelVersionId,
    row.provider,
    row.model,
    row.release,
    row.status,
    row.contextTokens,
    row.latestPerformanceWindow,
    row.policyVersion,
    row.deprecatedAt,
    row.documentVersion,
    row.sequence,
  );
  const insertRole = prepare(
    "INSERT INTO model_version_eligible_role (model_version_id, ordinal, role) VALUES (?, ?, ?)",
  );
  for (const role of projected.eligibleRoles) {
    insertRole.run(role.modelVersionId, role.ordinal, role.role);
  }
  const insertTransport = prepare(
    "INSERT INTO model_version_transport (model_version_id, ordinal, transport_kind) VALUES (?, ?, ?)",
  );
  for (const transport of projected.transports) {
    insertTransport.run(transport.modelVersionId, transport.ordinal, transport.transportKind);
  }
}

function priceIntervalRowToModel(row: PriceIntervalRow): PriceIntervalReadModel {
  return {
    catalogDocumentId: row.catalog_document_id,
    catalogVersion: row.catalog_version,
    provider: row.provider,
    modelVersionId: row.model_version_id,
    transportKind: row.transport_kind,
    tokenClass: row.token_class as PriceIntervalReadModel["tokenClass"],
    currency: row.currency,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    pricePerMillionNanos: row.price_per_million_nanos,
    recordedBy: row.recorded_by,
    sequence: row.sequence,
  };
}

/**
 * Write one catalog version's price intervals through whichever statement
 * source the caller holds (P-33/catálogo A).
 *
 * One writer for the three places that fill this table — the door, the rebuild
 * and migration 21's retroactive fold — for `writeModelVersionProjection`'s
 * reason; the fourth site of the fold, the integrity replay, writes nothing and
 * compares against what these wrote. Insert-only
 * and never `ON CONFLICT`: a version's rows are keyed by the version, the
 * stream holds a `(document, version)` once, and the fold refuses a primary key
 * twice within a version, so a conflict here is a fault to surface, not a row to
 * overwrite.
 */
function writePriceIntervalProjection(
  prepare: (sql: string) => Database.Statement,
  projected: PriceIntervalProjection,
): void {
  if (projected.rows.length === 0) return;
  const insert = prepare(
    "INSERT INTO price_interval_read_model (" +
      "catalog_document_id, catalog_version, provider, model_version_id, transport_kind, " +
      "token_class, currency, effective_from, effective_to, price_per_million_nanos, " +
      "recorded_by, sequence" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of projected.rows) {
    insert.run(
      row.catalogDocumentId,
      row.catalogVersion,
      row.provider,
      row.modelVersionId,
      row.transportKind,
      row.tokenClass,
      row.currency,
      row.effectiveFrom,
      row.effectiveTo,
      row.pricePerMillionNanos,
      row.recordedBy,
      row.sequence,
    );
  }
}

interface InitiativeRow {
  readonly initiative_id: string;
  readonly current_status: string;
  readonly event_count: number;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly last_event_id: string;
  readonly last_event_type: string;
  readonly last_transition_id: string;
  readonly last_emitted_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly title: string | null;
  readonly objective_sha256: string | null;
  readonly repository_sha256: string | null;
}

interface RoadmapVersionRow {
  readonly roadmap_version_id: string;
  readonly initiative_id: string;
  readonly version: number;
  readonly content_digest: string;
  readonly parent_version_id: string | null;
  readonly kind: string;
  readonly restores_version_id: string | null;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly sequence: number;
}

interface ExecutionRouteRow {
  readonly task_id: string;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly account_id: string;
  readonly transport_kind: string;
  readonly capability_policy_version: string;
  readonly resolved_at: string;
  readonly recorded_at: string;
  readonly sequence: number;
}

interface TaskRow {
  readonly task_id: string;
  readonly initiative_id: string | null;
  readonly current_state: string;
  readonly latest_attempt: number;
  readonly event_count: number;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly last_event_id: string;
  readonly last_event_type: string;
  readonly last_transition_id: string;
  readonly last_emitted_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly is_terminal: number;
  /** Additive at migration 11; `NULL` on every row written before it. */
  readonly envelope_sha256: string | null;
  readonly latest_revision_number: number | null;
  readonly latest_attempt_number: number | null;
  /**
   * Additive at migration 11, and produced from P-14 C by the intake door alone
   * (execution §1): the closed intake payload names them, and the fold writes
   * them once. `NULL` on every task that entered any other way, which a reader
   * treats as "not recorded", never as "absent".
   */
  readonly role: string | null;
  readonly step_id: string | null;
  readonly commit_policy: string | null;
}

/** One stored client key row (P-14 C). Snake case, because it is a row. */
interface TaskSubmissionRow {
  readonly client_scope: string;
  readonly client_request_key: string;
  readonly task_id: string;
  readonly revision_number: number;
  readonly envelope_sha256: string;
  readonly sequence: number;
  readonly created_at: string;
}

/** One stored revision row. Snake case, because it is a row. */
interface TaskRevisionRow {
  readonly task_id: string;
  readonly revision_number: number;
  readonly revision_id: string;
  readonly envelope_sha256: string;
  readonly restored_from_revision_id: string | null;
  readonly created_at: string;
  readonly created_by: string;
  readonly contract_version: string;
  readonly sequence: number;
  /** Additive at migration 16; `NULL` on every revision of the cohort before it. */
  readonly envelope_artifact_reference_id: string | null;
}

/** One stored attempt row. Snake case, because it is a row. */
interface TaskAttemptRow {
  readonly task_id: string;
  readonly revision_number: number;
  readonly attempt_number: number;
  readonly legacy_attempt_number: number;
  readonly invocation_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: string | null;
  readonly sequence: number;
}

/** One stored segment row (P-18/C). Snake case, because it is a row. */
interface ExecutionRouteSegmentRow {
  readonly route_segment_id: string;
  readonly task_id: string;
  readonly revision_number: number;
  readonly attempt_number: number;
  readonly segment_number: number;
  readonly predecessor_segment_id: string | null;
  readonly handoff_reason: string | null;
  readonly provider: string;
  readonly model: string;
  readonly model_resolution_status: string;
  readonly model_version_id: string | null;
  readonly account_id: string | null;
  readonly transport_kind: string;
  readonly capability_policy_version: string;
  readonly routing_assignment_id: string | null;
  readonly reservation_id: string | null;
  readonly escalated_from_attempt: number | null;
  readonly escalation_reason: string | null;
  readonly resolved_at: string | null;
  readonly recorded_at: string;
  readonly sequence: number;
}

/** One stored effect row (P-18/C). Snake case, because it is a row. */
interface EffectRow {
  readonly effect_id: string;
  readonly task_id: string;
  readonly revision_number: number;
  readonly attempt_number: number;
  readonly route_segment_id: string;
  readonly operation_ordinal: number;
  readonly effect_kind: string;
  readonly semantic_scope_key: string;
  readonly local_operation_key: string;
  readonly logical_operation_sha256: string;
  readonly request_contract_version: string;
  readonly request_sha256: string;
  readonly idempotency_key: string;
  readonly intended_at: string;
  readonly outcome_status: string | null;
  readonly outcome_recorded_at: string | null;
  readonly outcome_contract_version: string | null;
  readonly result_artifact_reference_id: string | null;
  readonly result_sha256: string | null;
  readonly sequence: number;
}

/** One stored delivery row (P-18/C). Snake case, because it is a row. */
interface DispatchAttemptRow {
  readonly dispatch_attempt_id: string;
  readonly effect_id: string;
  readonly route_segment_id: string;
  readonly attempt_ordinal: number;
  readonly provider_idempotency_key: string | null;
  readonly external_handle: string | null;
  readonly dispatch_state: string;
  readonly requested_at: string;
  readonly accepted_at: string | null;
  readonly terminal_at: string | null;
  readonly recorded_at: string;
  readonly sequence: number;
  readonly dispatch_contract_version: string;
  readonly catalog_document_id: string | null;
  readonly catalog_version: number | null;
}

/** One stored prompt occurrence row (P-18/D). Snake case, because it is a row. */
interface PromptOccurrenceRow {
  readonly occurrence_id: string;
  readonly route_segment_id: string;
  readonly effect_id: string;
  readonly dispatch_attempt_id: string;
  readonly ordinal: number;
  readonly identity: string;
  readonly requested_model_id: string;
  readonly provider: string;
  readonly model_resolution_status: string;
  readonly model_version_id: string | null;
  readonly account_id: string;
  readonly prompt_sha256: string;
  readonly prompt_bytes: number;
  readonly context_sha256: string | null;
  readonly recorded_at: string;
  readonly sequence: number;
}

/** One stored response occurrence row (P-18/D). Snake case, because it is a row. */
interface ResponseOccurrenceRow {
  readonly occurrence_id: string;
  readonly prompt_occurrence_id: string;
  readonly response_sha256: string;
  readonly response_bytes: number;
  readonly redaction_verdict: string;
  readonly recorded_at: string;
  readonly sequence: number;
}

interface WorkerRow {
  readonly identity: string;
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  readonly instance: string;
  readonly event_count: number;
  readonly task_count: number;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly last_task_id: string;
  readonly last_event_type: string;
}

interface WorkerTaskRow {
  readonly identity: string;
  readonly task_id: string;
  readonly event_count: number;
  readonly last_sequence: number;
}

interface MetaRow {
  readonly key: string;
  readonly value: string;
}

interface WatermarkRow {
  readonly projection_name: string;
  readonly source_stream: string;
  readonly projector_version: number;
  readonly applied_sequence: number;
  readonly event_count: number;
  readonly source_head_sha256: string;
  readonly updated_at: string;
}

interface HeadState {
  readonly sequence: number;
  readonly sha256: string;
  readonly count: number;
}

/** One event's outcome inside an open transaction, with the head it produced. */
interface AppendedEvent {
  readonly result: AppendResult;
  /** The stream's head after this event. Null when it was an exact replay. */
  readonly head: HeadState | null;
}

/** How far one stream has been folded, as a watermark row records it. */
interface StreamLevel {
  readonly sequence: number;
  readonly count: number;
  readonly sha256: string;
  /**
   * The recording event's own instant, never a clock read. Bookkeeping only:
   * nothing derives how far a projection has been applied from this field —
   * `applied_sequence` is the single answer to that question.
   */
  readonly updatedAt: string;
}

interface ReplayOutcome {
  readonly problems: readonly IntegrityProblem[];
  readonly checked: number;
  readonly lastSequence: number;
  readonly lastSha256: string;
}

function toValidationIssues(issues: readonly { path: PropertyKey[]; message: string }[]): LedgerValidationIssue[] {
  return issues.map((issue) => ({
    path:
      issue.path.length === 0
        ? "<root>"
        : issue.path
            .map((segment) =>
              typeof segment === "symbol" ? (segment.description ?? "<symbol>") : String(segment),
            )
            .join("."),
    message: issue.message,
  }));
}

function taskRowToModel(row: TaskRow): TaskReadModel {
  return {
    taskId: row.task_id,
    initiativeId: row.initiative_id,
    currentState: row.current_state as TaskReadModel["currentState"],
    latestAttempt: row.latest_attempt,
    eventCount: row.event_count,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    lastEventId: row.last_event_id,
    lastEventType: row.last_event_type as TaskReadModel["lastEventType"],
    lastTransitionId: row.last_transition_id,
    lastEmittedBy: row.last_emitted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isTerminal: row.is_terminal === 1,
    envelopeSha256: row.envelope_sha256,
    latestRevisionNumber: row.latest_revision_number,
    latestAttemptNumber: row.latest_attempt_number,
    stepId: row.step_id,
    role: row.role,
    commitPolicy: row.commit_policy,
  };
}

function taskSubmissionRowToModel(row: TaskSubmissionRow): TaskSubmissionReadModel {
  return {
    clientScope: row.client_scope,
    clientRequestKey: row.client_request_key,
    taskId: row.task_id,
    revisionNumber: row.revision_number,
    envelopeSha256: row.envelope_sha256,
    sequence: row.sequence,
    createdAt: row.created_at,
  };
}

function taskRevisionRowToModel(row: TaskRevisionRow): TaskRevisionReadModel {
  return {
    taskId: row.task_id,
    revisionNumber: row.revision_number,
    revisionId: row.revision_id,
    envelopeSha256: row.envelope_sha256,
    envelopeArtifactReferenceId: row.envelope_artifact_reference_id,
    restoredFromRevisionId: row.restored_from_revision_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    contractVersion: row.contract_version,
    sequence: row.sequence,
  };
}

function taskAttemptRowToModel(row: TaskAttemptRow): TaskAttemptReadModel {
  return {
    taskId: row.task_id,
    revisionNumber: row.revision_number,
    attemptNumber: row.attempt_number,
    legacyAttemptNumber: row.legacy_attempt_number,
    invocationId: row.invocation_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    sequence: row.sequence,
  };
}

/**
 * The three row-to-model conversions of P-18/protocolo C.
 *
 * Each narrows a `TEXT` column back to the closed vocabulary its CHECK admits.
 * The cast is safe because the base refuses anything else — and it is written
 * as a cast rather than as a re-validation for the reason
 * `taskAttemptRowToModel` does not re-validate either: a row this build wrote
 * satisfied the constraint at write time, and a row it did not write is
 * `verifyIntegrity`'s business rather than a converter's.
 */
function executionRouteSegmentRowToModel(
  row: ExecutionRouteSegmentRow,
): ExecutionRouteSegmentReadModel {
  return {
    routeSegmentId: row.route_segment_id,
    taskId: row.task_id,
    revisionNumber: row.revision_number,
    attemptNumber: row.attempt_number,
    segmentNumber: row.segment_number,
    predecessorSegmentId: row.predecessor_segment_id,
    handoffReason: row.handoff_reason,
    provider: row.provider,
    model: row.model,
    modelResolutionStatus: row.model_resolution_status as ModelResolutionStatus,
    modelVersionId: row.model_version_id,
    accountId: row.account_id,
    transportKind: row.transport_kind,
    capabilityPolicyVersion: row.capability_policy_version,
    routingAssignmentId: row.routing_assignment_id,
    reservationId: row.reservation_id,
    escalatedFromAttempt: row.escalated_from_attempt,
    escalationReason: row.escalation_reason,
    resolvedAt: row.resolved_at,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
  };
}

function effectRowToModel(row: EffectRow): EffectReadModel {
  return {
    effectId: row.effect_id,
    taskId: row.task_id,
    revisionNumber: row.revision_number,
    attemptNumber: row.attempt_number,
    routeSegmentId: row.route_segment_id,
    operationOrdinal: row.operation_ordinal,
    effectKind: row.effect_kind,
    semanticScopeKey: row.semantic_scope_key,
    localOperationKey: row.local_operation_key,
    logicalOperationSha256: row.logical_operation_sha256,
    requestContractVersion: row.request_contract_version,
    requestSha256: row.request_sha256,
    idempotencyKey: row.idempotency_key,
    intendedAt: row.intended_at,
    outcomeStatus: row.outcome_status as EffectOutcomeStatus | null,
    outcomeRecordedAt: row.outcome_recorded_at,
    outcomeContractVersion: row.outcome_contract_version,
    resultArtifactReferenceId: row.result_artifact_reference_id,
    resultSha256: row.result_sha256,
    sequence: row.sequence,
  };
}

function dispatchAttemptRowToModel(row: DispatchAttemptRow): DispatchAttemptReadModel {
  return {
    dispatchAttemptId: row.dispatch_attempt_id,
    effectId: row.effect_id,
    routeSegmentId: row.route_segment_id,
    attemptOrdinal: row.attempt_ordinal,
    providerIdempotencyKey: row.provider_idempotency_key,
    externalHandle: row.external_handle,
    dispatchState: row.dispatch_state as DispatchState,
    requestedAt: row.requested_at,
    acceptedAt: row.accepted_at,
    terminalAt: row.terminal_at,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
    dispatchContractVersion: row.dispatch_contract_version,
    catalogDocumentId: row.catalog_document_id,
    catalogVersion: row.catalog_version,
  };
}

/**
 * The two row-to-model conversions of P-18/protocolo D, on
 * `executionRouteSegmentRowToModel`'s terms: the two vocabulary columns are
 * narrowed by cast, because the base's CHECKs refused anything else at write
 * time and a row this build did not write is `verifyIntegrity`'s business.
 */
function promptOccurrenceRowToModel(row: PromptOccurrenceRow): PromptOccurrenceReadModel {
  return {
    occurrenceId: row.occurrence_id,
    routeSegmentId: row.route_segment_id,
    effectId: row.effect_id,
    dispatchAttemptId: row.dispatch_attempt_id,
    ordinal: row.ordinal,
    identity: row.identity,
    requestedModelId: row.requested_model_id,
    provider: row.provider,
    modelResolutionStatus: row.model_resolution_status as ModelResolutionStatus,
    modelVersionId: row.model_version_id,
    accountId: row.account_id,
    promptSha256: row.prompt_sha256,
    promptBytes: row.prompt_bytes,
    contextSha256: row.context_sha256,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
  };
}

function responseOccurrenceRowToModel(row: ResponseOccurrenceRow): ResponseOccurrenceReadModel {
  return {
    occurrenceId: row.occurrence_id,
    promptOccurrenceId: row.prompt_occurrence_id,
    responseSha256: row.response_sha256,
    responseBytes: row.response_bytes,
    redactionVerdict: row.redaction_verdict as RedactionVerdict,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
  };
}

function workerRowToModel(row: WorkerRow): WorkerReadModel {
  return {
    identity: row.identity,
    provider: row.provider,
    model: row.model,
    role: row.role as WorkerReadModel["role"],
    instance: row.instance,
    eventCount: row.event_count,
    taskCount: row.task_count,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastTaskId: row.last_task_id,
    lastEventType: row.last_event_type as WorkerReadModel["lastEventType"],
  };
}

function initiativeRowToModel(row: InitiativeRow): InitiativeReadModel {
  return {
    initiativeId: row.initiative_id,
    currentStatus: row.current_status as InitiativeReadModel["currentStatus"],
    eventCount: row.event_count,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    lastEventId: row.last_event_id,
    lastEventType: row.last_event_type as InitiativeReadModel["lastEventType"],
    lastTransitionId: row.last_transition_id,
    lastEmittedBy: row.last_emitted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title,
    objectiveSha256: row.objective_sha256,
    repositorySha256: row.repository_sha256,
  };
}

function roadmapVersionRowToModel(row: RoadmapVersionRow): RoadmapVersionReadModel {
  return {
    roadmapVersionId: row.roadmap_version_id,
    initiativeId: row.initiative_id,
    version: row.version,
    contentDigest: row.content_digest,
    parentVersionId: row.parent_version_id,
    kind: row.kind as RoadmapVersionReadModel["kind"],
    restoresVersionId: row.restores_version_id,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
  };
}

function executionRouteRowToModel(row: ExecutionRouteRow): ExecutionRouteReadModel {
  return {
    taskId: row.task_id,
    attempt: row.attempt,
    provider: row.provider,
    model: row.model,
    accountId: row.account_id,
    transportKind: row.transport_kind as ExecutionRouteReadModel["transportKind"],
    capabilityPolicyVersion: row.capability_policy_version,
    resolvedAt: row.resolved_at,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
  };
}

function routingAssignmentRowToModel(row: RoutingAssignmentRow): RoutingAssignmentReadModel {
  return {
    assignmentId: row.assignment_id,
    scopeKind: row.scope_kind as RoutingAssignmentReadModel["scopeKind"],
    scopeId: row.scope_id,
    version: row.version,
    role: row.role as RoutingAssignmentReadModel["role"],
    slot: row.slot,
    provider: row.provider,
    modelVersionId: row.model_version_id,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
    supersededBy: row.superseded_by,
    sourceStream: row.source_stream as RoutingAssignmentReadModel["sourceStream"],
    sourceSequence: row.source_sequence,
    sequence: row.sequence,
  };
}

function routingFallbackRowToModel(row: RoutingFallbackRow): RoutingAssignmentFallbackRow {
  return {
    assignmentId: row.assignment_id,
    ordinal: row.ordinal,
    modelVersionId: row.model_version_id,
  };
}

function boundedLimit(requested: number | undefined, label: string): number {
  if (requested === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_PAGE_LIMIT) {
    throw new LedgerQueryError(
      label + " limit must be an integer between 1 and " + String(MAX_PAGE_LIMIT),
    );
  }
  return requested;
}

/**
 * The closed set of projection names this build defines, across both streams.
 *
 * The two streams keep separate name lists because each projection is level
 * with its own chain, but membership is one question — a projection_meta row
 * naming anything outside this set describes a build that is not this one.
 */
const PROJECTION_NAME_SET: ReadonlySet<string> = new Set([
  ...PROJECTION_NAMES,
  ...INITIATIVE_PROJECTION_NAMES,
  // Neither list, deliberately: this projection is level with two chains and
  // belongs to neither stream's roster. Membership is still one question.
  ROUTING_ASSIGNMENT_PROJECTION,
  // The registry stream's own roster (P-36/local A).
  ...REGISTRY_PROJECTION_NAMES,
]);

// Which stream a projection follows used to be a second name set here. It is
// now a column: `projection_watermark.source_stream` says it per row, so the
// answer comes from the same place the question is asked from.

const WATERMARK_COLUMNS =
  "projection_name, source_stream, projector_version, applied_sequence, event_count, " +
  "source_head_sha256, updated_at";

/**
 * One key for the composite primary key, so membership is one lookup.
 *
 * The separator is a NUL because it cannot occur in a table or projection name,
 * so no pair of legal names can collide with another pair.
 */
function watermarkKey(projectionName: string, sourceStream: string): string {
  return projectionName + "\u0000" + sourceStream;
}

/** The `(projection, stream)` pairs this build publishes, as a membership set. */
const WATERMARK_KEYS: ReadonlySet<string> = new Set(
  PROJECTION_SOURCES.map((source) => watermarkKey(source.projectionName, source.sourceStream)),
);

const TASK_WATERMARKS: readonly ProjectionSource[] = PROJECTION_SOURCES.filter(
  (source) => source.sourceStream === TASK_STREAM,
);

/**
 * Every projection the initiative stream feeds — now three, not two.
 *
 * The third is the two-source projection's initiative-side row, and it arrives
 * here by the filter rather than by a second edit. That is what makes the hard
 * direction of the cross-advance true by construction: `appendInitiativeEvent`
 * moves the routing projection's initiative row and cannot move its registry
 * row, because the `UPDATE` targets the composite key.
 */
const INITIATIVE_WATERMARKS: readonly ProjectionSource[] = PROJECTION_SOURCES.filter(
  (source) => source.sourceStream === INITIATIVE_STREAM,
);

const REGISTRY_WATERMARKS: readonly ProjectionSource[] = PROJECTION_SOURCES.filter(
  (source) => source.sourceStream === REGISTRY_STREAM,
);

// The set of pairs `status()` publishes used to be a third list here, so that
// the DTO could omit a projection it could not describe. P-09/log-D gave the
// DTO a vector, so there is nothing left to omit: `status()` publishes every
// row of `projection_watermark`, and a residual filter would be a second
// source of truth about which heads exist.

/**
 * Give this ledger file an identity, once, and never touch it again.
 *
 * A free function rather than a method because it runs during `open`, before
 * the handle exists, and because it must be able to say "already done" without
 * reading anything else about the ledger.
 *
 * **Why the code writes this and no migration does.** A migration's checksum is
 * `sha256Hex(source.sql)` over fixed text. An `instance_id` embedded in that
 * text would be the same UUID in every ledger ever created by this build, which
 * is the exact opposite of an instance identity. So the row is written here,
 * and `ledger_meta` needs no schema change to hold it: it has been `(key,
 * value)` since migration 3, and the contract's key vocabulary is explicitly
 * additive.
 *
 * **Written once, on the first writable open by a build that knows about it,
 * and never rewritten.** The contract says "generated once when the physical
 * file is created", which is literally true for a new file and cannot be for
 * one that already exists in the field. This is the same argument migrations 6,
 * 7 and 9 make about their seeds: a ledger that predates the field gets it on
 * the next writable open, and nothing asks an operator to do anything.
 *
 * The presence of `instance_id` is the whole test. A `restore_id` without it,
 * or the reverse, is tampering rather than a state this ever produces — the
 * three rows are written in one transaction — and it is the read path that
 * refuses it, not this one, because refusing here would make a corrupt file
 * unopenable rather than merely unreadable.
 */
/**
 * Count the duplicate account versions this schema is about to forbid, and
 * refuse the migration naming them (P-08/A2).
 *
 * §15.5.1 of the database contract: a migration that adds a `UNIQUE` counts the
 * violations first and **fails naming them**. It never deduplicates. Two rows
 * claiming one version of one account are two claims about what an operator
 * did, and choosing between them is an owner's decision recorded in the
 * decisions register — not something a migration gets to do at 3am while an
 * upgrade runs.
 *
 * The refusal has to happen before the `CREATE UNIQUE INDEX`, or the same
 * condition arrives as a constraint failure that names one row and no
 * coordinates.
 *
 * In practice this is expected to find nothing, and that is not luck: the
 * account contract derives `idempotencyKey` from `accountId` and `version`, and
 * `UNIQUE(idempotency_key)` has been in the schema since migration 5, so a
 * duplicate pair would have had to arrive with a key the contract would never
 * have produced. The check exists for exactly that case — a row written past
 * the door — and because a rule that holds by derivation is a rule the base
 * cannot enforce on a writer that skips the derivation.
 */
/**
 * Render an account id for a diagnostic, safely.
 *
 * `safeIdentifier` is deliberately not reused here: it exists for SCHEMA names
 * — tables, projections, streams — which really are `[A-Za-z0-9_]`, and an
 * account id is not one. Realistic ids carry hyphens and dots, and blanking
 * every one of them would leave the preflight naming `<unprintable name>` for
 * exactly the rows an operator has to make a decision about, which would make
 * the diagnostic useless at the only moment it matters.
 *
 * The guard is still a guard: anything outside a bounded, printable set is
 * replaced rather than echoed, so a tampered column cannot turn a refusal
 * message into an output channel.
 */
function safeAccountId(accountId: string): string {
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(accountId) ? accountId : "<unprintable account id>";
}

/**
 * Refuse the migration if a historical key already occupies the V2 namespace.
 *
 * Streams §1.1 requires the migration that enables the V2 key to "comprobar que
 * ninguna clave V2 colisione con una clave histórica" and to "rechazar
 * explícitamente" on a collision. Before any V2 row exists that is exactly one
 * checkable question: is the namespace free?
 *
 * It has to be asked **now**, not when the first V2 key is written. The column
 * is `UNIQUE`, so a collision discovered later surfaces as a constraint failure
 * naming one row and no coordinate — and by then the ledger is already in
 * production with a key it cannot use. Asked here, the answer names every
 * offending row while the upgrade can still be declined.
 *
 * Named and never repaired, on the shape `assertNoDuplicateAccountVersions`
 * set: two rows claiming one key are two claims about what happened, and
 * choosing between them is an owner's decision recorded in the decisions
 * register, not a migration's.
 */
/** The two payload keys a V2 coordinate is made of, in the order they are read. */
const V2_COORDINATE_KEYS = ["revisionNumber", "attemptNumber"] as const;

/**
 * What an event's payload says about its V2 coordinate: absent, malformed, or
 * present.
 *
 * Three answers rather than two (F-2). The previous reader had only two — a
 * pair of numbers or a pair of nulls — and collapsed "this payload carries no
 * coordinate" together with "this payload carries a coordinate it got wrong".
 * The collapse was deliberate and it worked, because the stream trigger's
 * reverse direction caught the difference and refused the row; but it caught it
 * as a `SqliteError` reading "event_json carries a V2 coordinate the columns do
 * not", which names the symptom, arrives from another layer, and cannot be
 * caught by class. `#assertCausationResolves` states the standard this file
 * already holds itself to: "this layer exists so the refusal is a typed
 * LedgerValidationError rather than a raw SQLite error nobody can catch by
 * class." The trigger stays exactly where it is, as the backstop it was
 * designed to be.
 *
 * "Absent" is decided by the keys being **missing**, not by their values. An
 * explicit `null` is therefore malformed rather than absent: `json_extract`
 * reads a JSON null as nothing, so a payload that said `revisionNumber: null`
 * would otherwise become a legacy row whose own body claimed a coordinate it
 * did not have — the exact silent downgrade this whole pair of guards exists to
 * prevent.
 */
type V2CoordinateReading =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed"; readonly path: string; readonly message: string }
  | {
      readonly kind: "present";
      readonly revisionNumber: number;
      readonly attemptNumber: number;
    };

function readV2Coordinate(event: ControlPlaneEvent): V2CoordinateReading {
  if (!V2_COORDINATE_KEYS.some((key) => key in event.payload)) {
    return { kind: "absent" };
  }

  for (const key of V2_COORDINATE_KEYS) {
    if (!(key in event.payload)) {
      return {
        kind: "malformed",
        path: "payload." + key,
        message:
          "a V2 coordinate is both keys or neither, and this payload carries the other one " +
          "without " +
          key,
      };
    }
    const value = event.payload[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      return {
        kind: "malformed",
        path: "payload." + key,
        // The type name is a closed vocabulary of seven words, so it can be
        // printed; the value itself is caller data and is not.
        message:
          key +
          " must be a safe integer of at least one to be a coordinate, and this payload holds a " +
          typeof value,
      };
    }
  }

  // Both keys passed the loop above, so both hold a safe integer of at least
  // one. Read again rather than collected in the loop, so the two names stay
  // attached to their values instead of to positions in an array.
  return {
    kind: "present",
    revisionNumber: event.payload["revisionNumber"] as number,
    attemptNumber: event.payload["attemptNumber"] as number,
  };
}

/**
 * The coordinate columns for one event, or a typed refusal.
 *
 * The columns are a projection of the body and never a second source: the
 * trigger compares them against `event_json` in both directions, so a row whose
 * columns and body disagree cannot be written at all. This is where the body is
 * read once, before the `INSERT`, so that the two call sites cannot drift and a
 * malformed payload is refused by name rather than by abort.
 */
function v2CoordinateColumns(event: ControlPlaneEvent): {
  readonly revisionNumber: number | null;
  readonly attemptNumber: number | null;
} {
  const reading = readV2Coordinate(event);
  if (reading.kind === "malformed") {
    throw new LedgerValidationError([{ path: reading.path, message: reading.message }]);
  }
  if (reading.kind === "absent") {
    return { revisionNumber: null, attemptNumber: null };
  }
  return { revisionNumber: reading.revisionNumber, attemptNumber: reading.attemptNumber };
}

/**
 * The largest flat `attempt` any event may carry, read from the contract.
 *
 * Not restated as `10_000` here. The bound is the contract's — `attempt` is
 * `z.number().int().positive().max(10_000)` on `IdempotencyCoordinates` and on
 * `ControlPlaneEvent` alike — and a second literal in this file would be a
 * second source of truth that could drift from the door that actually refuses.
 * There is no named constant to import and this escalón adds none (a new export
 * of `@acp/contracts` moves pins that belong to no part of this work), so the
 * value is read off the schema that carries it.
 *
 * The compare-and-set has to know it. Adjudication Q4 settles that exhausting
 * the cap is a **typed refusal naming the cap** rather than an opaque overflow:
 * a task that accumulates ten thousand attempts across all its revisions is
 * resolved with a new task, not with a broken counter. The check therefore runs
 * on the value the ledger COMPUTES, before that value is compared with what the
 * event proposes — otherwise the contract's own parse would refuse
 * `attempt = 10001` first and the ledger's knowledge of the cap would never be
 * exercised at all.
 */
const MAX_FLAT_ATTEMPT: number = IdempotencyCoordinates.shape.attempt.maxValue ?? 10_000;

function assertNoV2KeyCollisions(db: Database.Database): void {
  const claimed = db
    .prepare(
      "SELECT sequence, idempotency_key FROM control_plane_events " +
        "WHERE idempotency_key LIKE ? ESCAPE '\\' ORDER BY sequence ASC",
    )
    .all(V2_IDEMPOTENCY_NAMESPACE + "%") as {
    readonly sequence: number;
    readonly idempotency_key: string;
  }[];

  if (claimed.length === 0) return;

  // Bounded for the same reason the duplicate list is: a diagnostic that prints
  // a million rows is a diagnostic nobody reads. The count stays exact.
  const named = claimed
    .slice(0, 20)
    .map((row) => "sequence " + String(row.sequence) + " holds " + safeIdempotencyKey(row.idempotency_key));
  if (claimed.length > 20) {
    named.push("and " + String(claimed.length - 20) + " further row(s)");
  }

  throw new LedgerMigrationError([
    "control_plane_events holds " +
      String(claimed.length) +
      " historical idempotency key(s) inside the V2 namespace '" +
      V2_IDEMPOTENCY_NAMESPACE +
      "', which this migration will not rewrite: " +
      named.join("; "),
  ]);
}

/**
 * An idempotency key, safe to print in a refusal.
 *
 * The same guard `safeAccountId` applies and for the same reason: the value is
 * caller data reaching a message an operator reads, and a key is composed of
 * identifiers and separators. Anything outside that set is not printed.
 */
function safeIdempotencyKey(value: string): string {
  return /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : "<unprintable key>";
}

/**
 * Why a stored row failed the contract, when the reason is its version.
 *
 * streams §1.1 requires that a reader which does not understand a row's form
 * refuse it *explicitly* — "la versión de contrato no soportada produce un
 * rechazo o una degradación explícita". All three read paths already refused;
 * what they said was "does not satisfy the contract", which is true of a
 * tampered field, a missing key and an unreadable version alike. An operator
 * holding a ledger written by a newer build needs to be told that it is the
 * version, which version, and which versions this build reads — otherwise the
 * one recoverable failure in the set looks exactly like corruption.
 *
 * `null` when the version is not the problem, so the general message stands
 * for every other way a row can fail.
 */
function unsupportedContractVersion(decoded: unknown): string | null {
  if (typeof decoded !== "object" || decoded === null) return null;
  const version = (decoded as { readonly contractVersion?: unknown }).contractVersion;
  if (typeof version !== "string") return null;
  const supported: readonly string[] = SUPPORTED_CONTRACT_VERSIONS;
  if (supported.includes(version)) return null;
  // The same printable guard the account id and the key get: this is a value
  // read back out of the file, reaching a message an operator reads.
  return /^[A-Za-z0-9_.+-]{1,40}$/.test(version) ? version : "<unprintable version>";
}

/** The supported set, phrased for a refusal. */
function supportedVersionList(): string {
  return SUPPORTED_CONTRACT_VERSIONS.join(", ");
}

function assertNoDuplicateAccountVersions(db: Database.Database): void {
  const duplicates = db
    .prepare(
      "SELECT account_id, version, COUNT(*) AS n FROM account_events " +
        "GROUP BY account_id, version HAVING n > 1 ORDER BY account_id ASC, version ASC",
    )
    .all() as { readonly account_id: string; readonly version: number; readonly n: number }[];

  if (duplicates.length === 0) return;

  // Named, bounded, and never repaired here. The list is capped because a
  // diagnostic that prints a million rows is a diagnostic nobody reads; the
  // count is exact either way.
  const named = duplicates
    .slice(0, 20)
    .map(
      (row) =>
        safeAccountId(row.account_id) +
        " version " +
        String(row.version) +
        " appears " +
        String(row.n) +
        " times",
    );
  if (duplicates.length > 20) {
    named.push("and " + String(duplicates.length - 20) + " further pair(s)");
  }
  throw new LedgerMigrationError([
    "account_events holds " +
      String(duplicates.length) +
      " duplicate (account_id, version) pair(s), which this migration will not " +
      "deduplicate: " +
      named.join("; "),
  ]);
}

/**
 * Build the account sidecar over every historical row, once (P-08/A2).
 *
 * Runs inside the migration's own transaction, after the sidecar's DDL and
 * before the migration is recorded, so there is no observable state in which
 * the table exists and the chain does not.
 *
 * **The code does this and the SQL cannot.** Each row's digest is SHA-256 over
 * the versioned preimage of the contract's §8.1, and SQLite has no SHA-256
 * here. That is the same shape of constraint `instance_id` ran into and the
 * opposite reason: there the value must not be deterministic, here it cannot be
 * computed in SQL.
 *
 * `H` is the account stream's head at this instant. For `H = 0` there are no
 * sidecar rows and both the baseline and head digests are the genesis sixty-four
 * zeros; for `H > 0` both are the digest of row `H`. They are equal at
 * activation and diverge only as the stream grows past the baseline, which is
 * exactly the distinction the two pairs of keys exist to keep.
 */
/**
 * Fold the model versions a ledger already holds, once, as migration 17 lands
 * (P-14 A, N-P14A-15).
 *
 * The migration seeds its watermark at the registry head, and a watermark at the
 * head over an empty table is a claim the integrity replay would refuse the moment
 * the stream holds a `MODEL_VERSION`. SQL cannot run the fold, so this does,
 * inside the transaction that applies the migration, through the same projection
 * function and the same writer the door and the rebuild use. A stored row that no
 * longer reads as a document is skipped rather than refused here: the fold is
 * total, and the integrity replay is where that row is named.
 */
function foldModelVersionsAtMigration(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT sequence, event_json FROM registry_events " +
        "WHERE subject_kind = 'DOCUMENT' AND document_kind = 'MODEL_VERSION' ORDER BY sequence ASC",
    )
    .all() as { readonly sequence: number; readonly event_json: string }[];
  const prepare = (sql: string): Database.Statement => db.prepare(sql);
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.event_json);
    } catch {
      continue;
    }
    const document = tryNormalizeRegistryDocument(parsed);
    if (document === null) continue;
    const projected = nextModelVersionProjection(document, row.sequence);
    if (projected !== null) writeModelVersionProjection(prepare, projected);
  }
}

/**
 * Fold the price catalogs a ledger already holds, once, as migration 21 lands
 * (P-33/catálogo A, N-P33-12).
 *
 * `foldModelVersionsAtMigration`'s form and reasons: the migration seeds its
 * watermark at the registry head, SQL cannot run the fold, and this runs it inside
 * the transaction that applies the migration, through the projection function and
 * the writer the door and the rebuild use. A version whose payload the fold cannot
 * read — only history from before this migration can hold one — writes no row of
 * that version and refuses nothing. A registered model version is not asked for:
 * the fold reads the shape, and existence was the door's to decide.
 */
function foldPriceIntervalsAtMigration(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT sequence, event_json FROM registry_events " +
        "WHERE subject_kind = 'DOCUMENT' AND document_kind = 'PRICE_TABLE' ORDER BY sequence ASC",
    )
    .all() as { readonly sequence: number; readonly event_json: string }[];
  const prepare = (sql: string): Database.Statement => db.prepare(sql);
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.event_json);
    } catch {
      continue;
    }
    const document = tryNormalizeRegistryDocument(parsed);
    if (document === null) continue;
    const projected = nextPriceIntervalProjection(document, row.sequence);
    if (projected !== null) writePriceIntervalProjection(prepare, projected);
  }
}

/**
 * Fold the initiative stream a ledger already holds, once, as migration 18 lands
 * (P-14 B, ADR 0086).
 *
 * The migration adds `title`, `objective_sha256` and `repository_sha256` as NULL
 * on every row, and a registration already recorded in the closed payload would
 * then be a row the integrity replay refuses. So the stream is folded again,
 * inside the transaction that applies the migration, through the same projection
 * function the door and the rebuild use, and only the three new columns are
 * written: every other column is already level with the head, and rewriting it
 * would be a second opinion about a fold that did not change. A row that no
 * longer reads as an event is skipped rather than refused here, for
 * `foldModelVersionsAtMigration`'s reason.
 */
function foldInitiativesAtMigration(db: Database.Database): void {
  const rows = db
    .prepare("SELECT sequence, event_json FROM initiative_events ORDER BY sequence ASC")
    .all() as { readonly sequence: number; readonly event_json: string }[];
  const folded = new Map<string, InitiativeReadModel>();
  for (const row of rows) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      continue;
    }
    const parsed = InitiativeEvent.safeParse(decoded);
    if (!parsed.success) continue;
    const event = parsed.data;
    folded.set(event.initiativeId, nextInitiativeProjection(folded.get(event.initiativeId) ?? null, event, row.sequence));
  }
  const update = db.prepare(
    "UPDATE initiative_read_model SET title = ?, objective_sha256 = ?, repository_sha256 = ? " +
      "WHERE initiative_id = ?",
  );
  for (const initiative of folded.values()) {
    update.run(initiative.title, initiative.objectiveSha256, initiative.repositorySha256, initiative.initiativeId);
  }
}

/**
 * Fold the task stream a ledger already holds for its intakes, once, as
 * migration 19 lands (P-14 C, ADR 0087).
 *
 * `foldInitiativesAtMigration`'s shape. The migration creates the client key
 * table empty and seeds its watermark at the head, and `task_read_model` already
 * carries `step_id`, `role` and `commit_policy` as NULL; a stream that already
 * holds an intake in the closed payload would then be rows the integrity replay
 * refuses. So the stream is folded again inside the transaction that applies the
 * migration, through the same functions the door and the rebuild use: each
 * intake inserts its key row — a second row under one key that names another
 * task is refused by name, as the door refuses it — and writes the three columns
 * of the task it opened, and nothing else. A row that no longer reads as an
 * event is skipped rather than refused, for `foldModelVersionsAtMigration`'s
 * reason.
 */
function foldTaskSubmissionsAtMigration(db: Database.Database): void {
  const rows = db
    .prepare("SELECT sequence, event_json FROM control_plane_events WHERE type = 'TASK_DISCOVERED' ORDER BY sequence ASC")
    .all() as { readonly sequence: number; readonly event_json: string }[];
  const folded = new Map<string, TaskSubmissionReadModel>();
  const insert = db.prepare(
    "INSERT INTO task_submission_read_model (" +
      "client_scope, client_request_key, task_id, revision_number, envelope_sha256, sequence, created_at" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const update = db.prepare(
    "UPDATE task_read_model SET step_id = ?, role = ?, commit_policy = ? WHERE task_id = ? AND first_sequence = ?",
  );
  for (const row of rows) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      continue;
    }
    const parsed = ControlPlaneEvent.safeParse(decoded);
    if (!parsed.success) continue;
    const event = parsed.data;
    const submission = nextTaskSubmissionProjection(event, row.sequence);
    if (submission === null) continue;
    const key = taskSubmissionKey(submission.clientScope, submission.clientRequestKey);
    const existing = folded.get(key);
    if (existing !== undefined) {
      assertSameTaskSubmission(existing, submission);
      continue;
    }
    folded.set(key, submission);
    insert.run(
      submission.clientScope,
      submission.clientRequestKey,
      submission.taskId,
      submission.revisionNumber,
      submission.envelopeSha256,
      submission.sequence,
      submission.createdAt,
    );
    const task = nextTaskProjection(null, event, row.sequence);
    update.run(task.stepId, task.role, task.commitPolicy, task.taskId, row.sequence);
  }
}

interface UsageStreamRow {
  readonly measurement_stream_id: string;
  readonly source: string;
  readonly account_id: string;
  readonly route_segment_id: string;
  readonly source_epoch: number;
  readonly source_class: string;
  readonly normalization_policy_sha256: string;
  readonly sequence: number;
}

interface UsageObservationRow {
  readonly observation_id: string;
  readonly measurement_stream_id: string;
  readonly ordinal: number;
  readonly source_observation_id: string;
  readonly report_kind: string;
  readonly range_from_counter: number | null;
  readonly range_to_counter: number | null;
  readonly corrects_observation_id: string | null;
  readonly effect_id: string;
  readonly is_final: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_write_tokens: number;
  readonly cache_read_tokens: number;
  readonly total_tokens: number;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly sequence: number;
}

/** The attempt coordinate of a segment or an effect row, as the usage view reads it. */
interface UsageOwnerRow {
  readonly task_id: string;
  readonly revision_number: number;
  readonly attempt_number: number;
}

function usageStreamRowToModel(row: UsageStreamRow): UsageMeasurementStreamReadModel {
  return {
    measurementStreamId: row.measurement_stream_id,
    source: row.source,
    accountId: row.account_id,
    routeSegmentId: row.route_segment_id,
    sourceEpoch: row.source_epoch,
    sourceClass: row.source_class as UsageMeasurementStreamReadModel["sourceClass"],
    normalizationPolicySha256: row.normalization_policy_sha256,
    sequence: row.sequence,
  };
}

function usageObservationRowToModel(row: UsageObservationRow): UsageObservationReadModel {
  return {
    observationId: row.observation_id,
    measurementStreamId: row.measurement_stream_id,
    ordinal: row.ordinal,
    sourceObservationId: row.source_observation_id,
    reportKind: row.report_kind as UsageObservationReadModel["reportKind"],
    rangeFromCounter: row.range_from_counter,
    rangeToCounter: row.range_to_counter,
    correctsObservationId: row.corrects_observation_id,
    effectId: row.effect_id,
    isFinal: row.is_final === 1 ? 1 : 0,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
    totalTokens: row.total_tokens,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    sequence: row.sequence,
  };
}

/**
 * The usage fold's view over the base (P-32/captura B), for the append door and
 * for migration 20's retroactive fold.
 *
 * A module function over a statement factory rather than a method, for
 * `writeModelVersionProjection`'s reason: the migration runs before a `Ledger`
 * exists, and the door and it must ask the tables the same questions.
 */
function usageBaseView(prepare: (sql: string) => Database.Statement): UsageCaptureView {
  const owner = (
    row: UsageOwnerRow | undefined,
  ): { readonly taskId: string; readonly revisionNumber: number; readonly attemptNumber: number } | null =>
    row === undefined
      ? null
      : { taskId: row.task_id, revisionNumber: row.revision_number, attemptNumber: row.attempt_number };
  return {
    stream: (id) => {
      const row = prepare("SELECT * FROM usage_measurement_stream_read_model WHERE measurement_stream_id = ?").get(
        id,
      ) as UsageStreamRow | undefined;
      return row === undefined ? null : usageStreamRowToModel(row);
    },
    observation: (id) => {
      const row = prepare("SELECT * FROM usage_observation_read_model WHERE observation_id = ?").get(id) as
        | UsageObservationRow
        | undefined;
      return row === undefined ? null : usageObservationRowToModel(row);
    },
    observationAtOrdinal: (streamId, ordinal) =>
      (
        prepare(
          "SELECT observation_id FROM usage_observation_read_model WHERE measurement_stream_id = ? AND ordinal = ?",
        ).get(streamId, ordinal) as { readonly observation_id: string } | undefined
      )?.observation_id ?? null,
    observationForSourceReport: (streamId, sourceObservationId) =>
      (
        prepare(
          "SELECT observation_id FROM usage_observation_read_model " +
            "WHERE measurement_stream_id = ? AND source_observation_id = ?",
        ).get(streamId, sourceObservationId) as { readonly observation_id: string } | undefined
      )?.observation_id ?? null,
    effectObservations: (effectId) =>
      (
        prepare("SELECT * FROM usage_observation_read_model WHERE effect_id = ? ORDER BY sequence ASC").all(
          effectId,
        ) as UsageObservationRow[]
      ).map(usageObservationRowToModel),
    segmentOwner: (routeSegmentId) =>
      owner(
        prepare(
          "SELECT task_id, revision_number, attempt_number FROM execution_route_segment_read_model " +
            "WHERE route_segment_id = ?",
        ).get(routeSegmentId) as UsageOwnerRow | undefined,
      ),
    effectOwner: (effectId) =>
      owner(
        prepare("SELECT task_id, revision_number, attempt_number FROM effect_read_model WHERE effect_id = ?").get(
          effectId,
        ) as UsageOwnerRow | undefined,
      ),
    latestSettlement: (effectId) => {
      const row = prepare(
        "SELECT settlement_revision, settlement_status, sequence FROM usage_settlement_read_model " +
          "WHERE effect_id = ? ORDER BY settlement_revision DESC LIMIT 1",
      ).get(effectId) as
        | { readonly settlement_revision: number; readonly settlement_status: string; readonly sequence: number }
        | undefined;
      return row === undefined
        ? null
        : {
            settlementRevision: row.settlement_revision,
            status: row.settlement_status as UsageSettlementReadModel["settlementStatus"],
            sequence: row.sequence,
          };
    },
    lastFinalSequence: (effectId) =>
      (
        prepare(
          "SELECT sequence FROM usage_settlement_read_model WHERE effect_id = ? AND settlement_status = 'FINAL' " +
            "ORDER BY settlement_revision DESC LIMIT 1",
        ).get(effectId) as { readonly sequence: number } | undefined
      )?.sequence ?? null,
  };
}

/**
 * Write what `nextUsageCapture` decided, parents first: the stream, the
 * observation, then the revision's header, its cut and its list. Every foreign
 * key is deferred, so the order is the dictionary's rather than the engine's.
 * Insert-only: a revision is a row beside the earlier ones, and the fold already
 * refused anything these statements could conflict on.
 */
function writeUsageCapture(prepare: (sql: string) => Database.Statement, writes: UsageCaptureWrites): void {
  const stream = writes.stream;
  if (stream !== null) {
    prepare(
      "INSERT INTO usage_measurement_stream_read_model (" +
        "measurement_stream_id, source, account_id, route_segment_id, source_epoch, source_class, " +
        "normalization_policy_sha256, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      stream.measurementStreamId,
      stream.source,
      stream.accountId,
      stream.routeSegmentId,
      stream.sourceEpoch,
      stream.sourceClass,
      stream.normalizationPolicySha256,
      stream.sequence,
    );
  }
  const observation = writes.observation;
  if (observation !== null) {
    prepare(
      "INSERT INTO usage_observation_read_model (" +
        "observation_id, measurement_stream_id, ordinal, source_observation_id, report_kind, " +
        "range_from_counter, range_to_counter, corrects_observation_id, effect_id, is_final, " +
        "input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, total_tokens, " +
        "occurred_at, recorded_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      observation.observationId,
      observation.measurementStreamId,
      observation.ordinal,
      observation.sourceObservationId,
      observation.reportKind,
      observation.rangeFromCounter,
      observation.rangeToCounter,
      observation.correctsObservationId,
      observation.effectId,
      observation.isFinal,
      observation.inputTokens,
      observation.outputTokens,
      observation.cacheWriteTokens,
      observation.cacheReadTokens,
      observation.totalTokens,
      observation.occurredAt,
      observation.recordedAt,
      observation.sequence,
    );
  }
  const settlement = writes.settlement;
  if (settlement !== null) writeUsageSettlement(prepare, settlement);
}

/** One settlement revision whole: header, cut, list. */
function writeUsageSettlement(prepare: (sql: string) => Database.Statement, settlement: UsageSettlementRecord): void {
  const header = settlement.header;
  prepare(
    "INSERT INTO usage_settlement_read_model (" +
      "effect_id, settlement_revision, settlement_status, input_tokens, output_tokens, cache_write_tokens, " +
      "cache_read_tokens, total_tokens, source_policy_sha256, fold_version, last_observation_id, " +
      "had_late_arrival, computed_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    header.effectId,
    header.settlementRevision,
    header.settlementStatus,
    header.inputTokens,
    header.outputTokens,
    header.cacheWriteTokens,
    header.cacheReadTokens,
    header.totalTokens,
    header.sourcePolicySha256,
    header.foldVersion,
    header.lastObservationId,
    header.hadLateArrival,
    header.computedAt,
    header.sequence,
  );
  for (const head of settlement.sourceHeads) writeUsageSettlementSourceHead(prepare, head);
  for (const considered of settlement.observations) writeUsageSettlementObservation(prepare, considered);
}

function writeUsageSettlementSourceHead(
  prepare: (sql: string) => Database.Statement,
  head: UsageSettlementSourceHeadReadModel,
): void {
  prepare(
    "INSERT INTO usage_settlement_source_head_read_model (" +
      "effect_id, settlement_revision, source_stream, source_sequence, source_sha256) VALUES (?, ?, ?, ?, ?)",
  ).run(head.effectId, head.settlementRevision, head.sourceStream, head.sourceSequence, head.sourceSha256);
}

function writeUsageSettlementObservation(
  prepare: (sql: string) => Database.Statement,
  considered: UsageSettlementObservationReadModel,
): void {
  prepare(
    "INSERT INTO usage_settlement_observation_read_model (effect_id, settlement_revision, observation_id) " +
      "VALUES (?, ?, ?)",
  ).run(considered.effectId, considered.settlementRevision, considered.observationId);
}

/**
 * Fold the task stream a ledger already holds for its usage capture, once, as
 * migration 20 lands (P-32/captura B, H-1, ADR 0089).
 *
 * `foldTaskSubmissionsAtMigration`'s shape. The migration creates the five tables
 * empty and seeds their watermarks at the head, and a ledger that already
 * delivered an effect would then hold rows a rebuild writes and these tables do
 * not: the first delivery of every effect is its exposure, revision 1, `UNKNOWN`.
 * So the stream is folded again inside the transaction that applies the
 * migration, through `nextUsageCapture` over the base and the door's own writer,
 * in sequence order and at each event's own digest. A usage event is folded too,
 * so a ledger rewound past 20 over usage it already holds folds back into the
 * same rows. A row that no longer reads as an event is skipped rather than
 * refused, for `foldModelVersionsAtMigration`'s reason.
 */
function foldUsageCaptureAtMigration(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT sequence, event_json, event_sha256 FROM control_plane_events " +
        "WHERE type IN ('DISPATCH_INTENDED', 'USAGE_STREAM_DECLARED', 'USAGE_OBSERVATION_RECORDED') " +
        "ORDER BY sequence ASC",
    )
    .all() as { readonly sequence: number; readonly event_json: string; readonly event_sha256: string }[];
  const prepare = (sql: string): Database.Statement => db.prepare(sql);
  const view = usageBaseView(prepare);
  for (const row of rows) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      continue;
    }
    const parsed = ControlPlaneEvent.safeParse(decoded);
    if (!parsed.success) continue;
    const writes = nextUsageCapture(view, parsed.data, row.sequence, row.event_sha256);
    if (writes !== null) writeUsageCapture(prepare, writes);
  }
}

/**
 * Write the recording version of every outcome a ledger already holds, once, as
 * migration 22 lands (P-07 escalón B, ADR 0098).
 *
 * `foldInitiativesAtMigration`'s shape. The migration adds
 * `outcome_contract_version` as NULL on every row, and a row that already holds
 * an outcome would then be one the integrity replay refuses, because the fold
 * writes the version of the event that recorded it. So the resolutions are read
 * again, in sequence order, through `dispatchOutcomeRecord` — the reader the door
 * and the fold use, never a second one in SQL — and each outcome's row gets its
 * event's version, and the result pair that event names, first event wins. On a
 * ledger this migration first meets, every such version is in the cohort before
 * and the pair is NULL; the pair is written too so that a ledger rewound past 22
 * after it held later outcomes re-applies to the rows its events say, as every
 * other `afterSql` fold does. The UPDATE trigger holds both cases. A row that no
 * longer reads as an event, or as a resolution, is skipped rather than refused,
 * for `foldModelVersionsAtMigration`'s reason.
 */
function foldEffectOutcomeCohortAtMigration(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT sequence, event_json FROM control_plane_events WHERE type = 'DISPATCH_OUTCOME_RECORDED' " +
        "ORDER BY sequence ASC",
    )
    .all() as { readonly sequence: number; readonly event_json: string }[];
  const effectOf = db.prepare("SELECT effect_id FROM dispatch_attempt_read_model WHERE dispatch_attempt_id = ?");
  const update = db.prepare(
    "UPDATE effect_read_model SET outcome_contract_version = ?, result_artifact_reference_id = ?, result_sha256 = ? " +
      "WHERE effect_id = ? AND outcome_status IS NOT NULL AND outcome_contract_version IS NULL",
  );
  for (const row of rows) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      continue;
    }
    const parsed = ControlPlaneEvent.safeParse(decoded);
    if (!parsed.success) continue;
    const reading = dispatchOutcomeRecord(parsed.data, row.sequence);
    if (reading?.kind !== "record" || reading.record.effectOutcomeStatus === null) continue;
    const delivery = effectOf.get(reading.record.dispatchAttemptId) as { readonly effect_id: string } | undefined;
    if (delivery === undefined) continue;
    update.run(
      parsed.data.contractVersion,
      reading.record.resultArtifactReferenceId,
      reading.record.resultSha256,
      delivery.effect_id,
    );
  }
}

/**
 * Write the bearing version of every delivery a ledger already holds, once, as
 * migration 23 lands (P-15 escalón C, ADR 0103).
 *
 * `foldEffectOutcomeCohortAtMigration`'s shape. The migration adds
 * `dispatch_contract_version` as NULL on every row, and a row without one is one the
 * integrity replay refuses, because the fold writes the version of the intention
 * that bore it. So the intentions are read again, in sequence order, through
 * `dispatchPinReading` — the reader the door and the fold use, never a second one in
 * SQL — and each row gets its event's version and the pin that event names, first
 * event wins. On a ledger this migration first meets every such version is in the
 * cohort before and the pin is NULL; the pin is written too so that a ledger rewound
 * past 23 after it held later deliveries re-applies to the rows its events say. The
 * UPDATE trigger holds both cases. A row that no longer reads as an event is skipped
 * rather than refused, for `foldModelVersionsAtMigration`'s reason.
 */
function foldDispatchCohortAtMigration(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT sequence, event_json FROM control_plane_events WHERE type = 'DISPATCH_INTENDED' " +
        "ORDER BY sequence ASC",
    )
    .all() as { readonly sequence: number; readonly event_json: string }[];
  const update = db.prepare(
    "UPDATE dispatch_attempt_read_model SET dispatch_contract_version = ?, catalog_document_id = ?, " +
      "catalog_version = ? WHERE dispatch_attempt_id = ? AND dispatch_contract_version IS NULL",
  );
  for (const row of rows) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      continue;
    }
    const parsed = ControlPlaneEvent.safeParse(decoded);
    if (!parsed.success) continue;
    const reading = dispatchPinReading(parsed.data);
    if (reading?.kind !== "pin") continue;
    const dispatch = nextDispatchAttemptProjection(parsed.data, row.sequence);
    if (dispatch === null) continue;
    update.run(
      parsed.data.contractVersion,
      reading.pin === null ? null : reading.pin.catalogDocumentId,
      reading.pin === null ? null : reading.pin.catalogVersion,
      dispatch.dispatchAttemptId,
    );
  }
}

function activateAccountIntegrity(db: Database.Database, activatedAt: string): void {
  const rows = db
    .prepare("SELECT " + ACCOUNT_EVENT_COLUMNS + " FROM account_events ORDER BY sequence ASC")
    .safeIntegers(true)
    .all() as AccountEventRow[];

  const insert = db.prepare(
    "INSERT INTO account_event_integrity " +
      "(account_sequence, previous_sha256, event_sha256, computed_at) VALUES (?, ?, ?, ?)",
  );

  let previousSha256 = ACCOUNT_INTEGRITY_GENESIS_SHA256;
  let expectedSequence = 1;
  for (const row of rows) {
    // `sequence` arrives as a `bigint` under `safeIntegers`, so the contiguity
    // check compares by value. The position the sidecar then uses is
    // `expectedSequence`, the `number` this loop counts with: it has just been
    // proved equal to the row's own, and it is the one of the two that the
    // preimage's `accountSequence` is typed for.
    const accountSequence = expectedSequence;
    if (!sameStoredInteger(row.sequence, accountSequence)) {
      // The sidecar is one-to-one from sequence 1. A gap means the stream this
      // chain would describe is not the stream on disk, and a chain built over
      // a gap would be evidence of the wrong thing.
      throw new LedgerMigrationError([
        "account_events is not contiguous: expected sequence " +
          String(accountSequence) +
          " but found " +
          String(row.sequence),
      ]);
    }
    expectedSequence += 1;

    // Every historical row carries the same `computed_at`, and it is the
    // activation instant rather than the row's own `recorded_at`: these digests
    // were computed now, long after the rows were written, and saying otherwise
    // would be the one claim the sidecar must never make.
    const eventSha256 = accountIntegrityDigestV1({
      accountSequence,
      previousSha256,
      row,
    });
    insert.run(accountSequence, previousSha256, eventSha256, activatedAt);
    previousSha256 = eventSha256;
  }

  const head = rows.length === 0 ? 0 : expectedSequence - 1;
  // INSERT, never `#writeMeta`: that helper is an `UPDATE ... WHERE key = ?`,
  // which on an absent key neither fails nor writes.
  const meta = db.prepare("INSERT INTO ledger_meta (key, value) VALUES (?, ?)");
  meta.run(ACCOUNT_INTEGRITY_BASELINE_SEQUENCE, String(head));
  meta.run(ACCOUNT_INTEGRITY_BASELINE_SHA256, previousSha256);
  meta.run(ACCOUNT_INTEGRITY_ACTIVATED_AT, activatedAt);
  meta.run(ACCOUNT_INTEGRITY_HEAD_SEQUENCE, String(head));
  meta.run(ACCOUNT_INTEGRITY_HEAD_EVENT_SHA256, previousSha256);
}

function ensureLedgerIdentity(db: Database.Database): void {
  db.transaction(() => {
    const existing = db
      .prepare("SELECT value FROM ledger_meta WHERE key = ?")
      .get(INSTANCE_ID) as { readonly value: string } | undefined;
    if (existing !== undefined) return;

    // INSERT, not the UPDATE the head writers use. `#writeMeta` is an `UPDATE
    // ... WHERE key = ?`, which on an absent key neither fails nor writes: it
    // reports one changed row of zero and moves on. Every key it was written
    // for is created by a migration; these three are not.
    const insert = db.prepare("INSERT INTO ledger_meta (key, value) VALUES (?, ?)");
    insert.run(INSTANCE_ID, randomUUID());
    // A restore id from birth, so the tuple a client compares is never partly
    // absent, and a formal restore is a CHANGE rather than an appearance.
    insert.run(RESTORE_ID, randomUUID());
    insert.run(RESTORE_EPOCH, "0");
  }).immediate();
}

/**
 * Render a database-supplied name safely for a diagnostic.
 *
 * A name that reaches a diagnostic came out of the database, and a tampered
 * database can hold anything at all in a TEXT column. Echoing it verbatim would
 * make the ledger a channel for whatever an attacker chose to store, so only a
 * plain identifier is ever printed back.
 */
function safeIdentifier(name: string): string {
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "<unprintable name>";
}

/**
 * A row identifier or vocabulary word of P-18/protocolo C, safe to print.
 *
 * `safeIdentifier` is narrower on purpose — it guards a value that is about to
 * be interpolated into SQL as a table name, so it admits no punctuation at all.
 * A segment id, an effect id, a delivery id, an effect kind and a request
 * contract version are none of those things: they never reach a query, they do
 * reach a message an operator reads, and they legitimately contain `-`, `.`
 * and `:` the way an invocation id does. Reusing the SQL guard here printed
 * every one of them as `<unprintable name>`.
 */
function safeRowIdentifier(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "<unprintable identifier>";
}

/**
 * An invocation id, safe to print in a refusal.
 *
 * The same guard `safeAccountId` and `safeIdentifier` apply, for their reason:
 * the value is caller data reaching a message an operator reads. An invocation
 * id is a bounded identifier in the shape every other durable handle in this
 * file has; anything outside that set is not printed.
 */
function safeInvocationId(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : "<unprintable invocation id>";
}

/**
 * The routing projection's two partitions, as one table's worth of rows.
 *
 * The registry side folds `GLOBAL`, the initiative side folds `INITIATIVE` and
 * `STEP`, and `ck_routing_assignment_read_model__source_scope` refuses either
 * one writing into the other's partition. So this is a union of disjoint sets
 * and never a merge with a winner; the initiative side is empty in this build,
 * and stays a term in the expression rather than being dropped from it,
 * because the day it is not empty this must already be right.
 */
function mergeRoutingAssignments(
  registry: RegistryProjectionSnapshot,
  initiative: InitiativeProjectionSnapshot,
): Map<string, RoutingAssignmentReadModel> {
  return new Map([...registry.routingAssignments, ...initiative.routingAssignments]);
}

function mergeRoutingFallbacks(
  registry: RegistryProjectionSnapshot,
  initiative: InitiativeProjectionSnapshot,
): Map<string, RoutingAssignmentFallbackRow> {
  return new Map([...registry.routingFallbacks, ...initiative.routingFallbacks]);
}

/**
 * The append-only control plane ledger.
 *
 * One SQLite file is the whole authority. Events are appended, never updated
 * and never deleted; read models are derived and can be dropped and rebuilt
 * from the events alone. Raw database access is deliberately not exposed: a
 * caller holding the connection could bypass the append-only triggers and the
 * hash chain, and the ledger would have no way to notice.
 */
export class Ledger {
  readonly #db: Database.Database;
  readonly #path: string;
  readonly #readOnly: boolean;
  readonly #faults: LedgerTestFaults;
  readonly #statements: Map<string, Database.Statement>;
  #closed: boolean;

  private constructor(
    db: Database.Database,
    path: string,
    readOnly: boolean,
    faults: LedgerTestFaults,
  ) {
    this.#db = db;
    this.#path = path;
    this.#readOnly = readOnly;
    this.#faults = faults;
    this.#statements = new Map<string, Database.Statement>();
    this.#closed = false;
  }

  static open(path: string, options: OpenLedgerOptions = {}): Ledger {
    const readOnly = options.readOnly ?? false;
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

    if (
      !Number.isInteger(busyTimeoutMs) ||
      busyTimeoutMs < 0 ||
      busyTimeoutMs > MAX_BUSY_TIMEOUT_MS
    ) {
      throw new LedgerOpenError(
        path,
        "busyTimeoutMs must be an integer between 0 and " + String(MAX_BUSY_TIMEOUT_MS),
      );
    }

    let db: Database.Database;
    try {
      db = readOnly
        ? new Database(path, { readonly: true, fileMustExist: true })
        : new Database(path);
    } catch (error: unknown) {
      throw new LedgerOpenError(path, error instanceof Error ? error.message : "unknown error");
    }

    try {
      // Foreign keys and the lock budget are set before query_only, because a
      // query-only connection will not accept a schema affecting pragma.
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = " + String(busyTimeoutMs));
      if (readOnly) {
        db.pragma("query_only = ON");
      } else {
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
        db.exec(SCHEMA_MIGRATIONS_DDL);
      }

      if (!schemaMigrationsTableExists(db)) {
        throw new LedgerMigrationError([
          "schema_migrations is absent, so this file has never been migrated by this system",
        ]);
      }

      const applied = readAppliedMigrations(db);
      const conformance = checkMigrationConformance(applied);
      if (conformance.problems.length > 0) {
        throw new LedgerMigrationError(conformance.problems);
      }

      if (conformance.missing.length > 0) {
        if (readOnly) {
          // Fail closed. A read-only handle must never migrate, and reading a
          // database through a schema it does not have would invent answers.
          throw new LedgerMigrationError(
            conformance.missing.map(
              (migration) =>
                "migration " +
                String(migration.version) +
                " " +
                migration.name +
                " is not applied and a read-only handle may not apply it",
            ),
          );
        }
        const appliedAt = new Date().toISOString();
        const pending = conformance.missing;
        db.transaction(() => {
          // The account sidecar's activation is part of THIS transaction, and
          // its order is fixed: the duplicate preflight before the DDL that
          // would turn a count into a constraint failure, and the retroactive
          // hash load after the table exists but before the migration is
          // recorded. All of it or none of it — a ledger with the sidecar
          // table and no chain in it is not a state anything may observe.
          applyMigrations(db, pending, appliedAt, {
            beforeSql: (migration) => {
              if (migration.version === ACCOUNT_INTEGRITY_MIGRATION) {
                assertNoDuplicateAccountVersions(db);
              }
              // Migration 11's preflight, on the same terms and in the same
              // transaction: the V2 idempotency namespace has to be free before
              // the columns that will use it exist, because after that a
              // collision is a UNIQUE failure naming one row and no coordinate.
              if (migration.version === TASK_REVISION_MIGRATION) {
                assertNoV2KeyCollisions(db);
              }
            },
            afterSql: (migration) => {
              if (migration.version === ACCOUNT_INTEGRITY_MIGRATION) {
                activateAccountIntegrity(db, appliedAt);
              }
              // Migration 17 seeded its watermark at the registry head; this
              // makes the rows level with it, in the same transaction.
              if (migration.version === MODEL_VERSION_REGISTRY_MIGRATION) {
                foldModelVersionsAtMigration(db);
              }
              // Migration 18 added three columns to rows that already exist;
              // this folds the stream again so the rows carry what it says.
              if (migration.version === INITIATIVE_REGISTRATION_MIGRATION) {
                foldInitiativesAtMigration(db);
              }
              // Migration 19 seeded its watermark at the task head; this makes
              // its rows, and the three task columns an intake names, level with it.
              if (migration.version === TASK_SUBMISSION_MIGRATION) {
                foldTaskSubmissionsAtMigration(db);
              }
              // Migration 20 seeded five watermarks at the task head; this writes
              // the exposure of every effect already delivered, level with it.
              if (migration.version === USAGE_CAPTURE_MIGRATION) {
                foldUsageCaptureAtMigration(db);
              }
              // Migration 21 seeded its watermark at the registry head; this
              // writes every price catalog version already published, level with it.
              if (migration.version === PRICE_INTERVAL_CATALOG_MIGRATION) {
                foldPriceIntervalsAtMigration(db);
              }
              // Migration 22 added the recording version to rows that already
              // hold an outcome; this writes it from each outcome's own event.
              if (migration.version === EFFECT_RESULT_REFERENCE_MIGRATION) {
                foldEffectOutcomeCohortAtMigration(db);
              }
              // Migration 23 added the bearing version to rows that already
              // exist; this writes it from each delivery's own intention.
              if (migration.version === DISPATCH_CATALOG_PIN_MIGRATION) {
                foldDispatchCohortAtMigration(db);
              }
            },
          });
        }).immediate();
      }

      // After the migrations, because the table it writes into is created by
      // one of them; and only on a writable handle, because a read-only open
      // may not write and a ledger's identity is not something a reader gets
      // to invent. A read-only handle over a ledger that predates this build
      // reports the identity as absent rather than making one up.
      if (!readOnly) ensureLedgerIdentity(db);
    } catch (error: unknown) {
      db.close();
      throw error;
    }

    return new Ledger(db, path, readOnly, options.__testFaults ?? {});
  }

  // -------------------------------------------------------------------------
  // Handle state
  // -------------------------------------------------------------------------

  get path(): string {
    return this.#path;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }

  #assertOpen(operation: string): void {
    if (this.#closed) throw new LedgerClosedError(operation);
  }

  #assertWritable(operation: string): void {
    if (this.#readOnly) throw new LedgerReadOnlyError(operation);
  }

  #stmt(sql: string): Database.Statement {
    const existing = this.#statements.get(sql);
    if (existing !== undefined) return existing;
    const prepared = this.#db.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  #readMetaMap(): Map<string, string> {
    const rows = this.#stmt("SELECT key, value FROM ledger_meta").all() as MetaRow[];
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  #readHead(): HeadState {
    const meta = this.#readMetaMap();
    const sequenceText = meta.get(HEAD_SEQUENCE);
    const shaText = meta.get(HEAD_EVENT_SHA256);
    const countText = meta.get(EVENT_COUNT);

    if (sequenceText === undefined || shaText === undefined || countText === undefined) {
      throw new LedgerIntegrityError(["ledger_meta is missing a head or count row"]);
    }
    const sequence = readCanonicalCount(sequenceText);
    const count = readCanonicalCount(countText);
    if (sequence === null || count === null) {
      throw new LedgerIntegrityError(["ledger_meta holds a head or count that is not a count"]);
    }
    if (!/^[0-9a-f]{64}$/.test(shaText)) {
      throw new LedgerIntegrityError(["ledger_meta holds a head digest that is not a sha-256"]);
    }
    return { sequence, sha256: shaText, count };
  }

  #writeMeta(key: string, value: string): void {
    this.#stmt("UPDATE ledger_meta SET value = ? WHERE key = ?").run(value, key);
  }

  #writeHead(sequence: number, sha256: string, count: number): void {
    this.#writeMeta(HEAD_SEQUENCE, String(sequence));
    this.#writeMeta(HEAD_EVENT_SHA256, sha256);
    this.#writeMeta(EVENT_COUNT, String(count));
  }

  /**
   * The initiative stream's head, read with the same suspicion as the task
   * stream's: a meta row that is missing or is not a count is a corrupted
   * ledger, not a default to paper over.
   */
  #readInitiativeHead(): HeadState {
    const meta = this.#readMetaMap();
    const sequenceText = meta.get(INITIATIVE_HEAD_SEQUENCE);
    const shaText = meta.get(INITIATIVE_HEAD_EVENT_SHA256);
    const countText = meta.get(INITIATIVE_EVENT_COUNT);

    if (sequenceText === undefined || shaText === undefined || countText === undefined) {
      throw new LedgerIntegrityError(["ledger_meta is missing an initiative head or count row"]);
    }
    const sequence = readCanonicalCount(sequenceText);
    const count = readCanonicalCount(countText);
    if (sequence === null || count === null) {
      throw new LedgerIntegrityError([
        "ledger_meta holds an initiative head or count that is not a count",
      ]);
    }
    if (!/^[0-9a-f]{64}$/.test(shaText)) {
      throw new LedgerIntegrityError([
        "ledger_meta holds an initiative head digest that is not a sha-256",
      ]);
    }
    return { sequence, sha256: shaText, count };
  }

  #writeInitiativeHead(sequence: number, sha256: string, count: number): void {
    this.#writeMeta(INITIATIVE_HEAD_SEQUENCE, String(sequence));
    this.#writeMeta(INITIATIVE_HEAD_EVENT_SHA256, sha256);
    this.#writeMeta(INITIATIVE_EVENT_COUNT, String(count));
  }

  /** The registry stream's head, read with the same suspicion as the other two. */
  #readRegistryHead(): HeadState {
    const meta = this.#readMetaMap();
    const sequenceText = meta.get(REGISTRY_HEAD_SEQUENCE);
    const shaText = meta.get(REGISTRY_HEAD_EVENT_SHA256);
    const countText = meta.get(REGISTRY_EVENT_COUNT);

    if (sequenceText === undefined || shaText === undefined || countText === undefined) {
      throw new LedgerIntegrityError(["ledger_meta is missing a registry head or count row"]);
    }
    const sequence = readCanonicalCount(sequenceText);
    const count = readCanonicalCount(countText);
    if (sequence === null || count === null) {
      throw new LedgerIntegrityError([
        "ledger_meta holds a registry head or count that is not a count",
      ]);
    }
    if (!SHA256_PATTERN.test(shaText)) {
      throw new LedgerIntegrityError([
        "ledger_meta holds a registry head digest that is not a sha-256",
      ]);
    }
    return { sequence, sha256: shaText, count };
  }

  #writeRegistryHead(sequence: number, sha256: string, count: number): void {
    this.#writeMeta(REGISTRY_HEAD_SEQUENCE, String(sequence));
    this.#writeMeta(REGISTRY_HEAD_EVENT_SHA256, sha256);
    this.#writeMeta(REGISTRY_EVENT_COUNT, String(count));
  }

  /**
   * This file's identity, read with the same suspicion as a head (P-10/id-A).
   *
   * Three outcomes, and the middle one is the point:
   *
   * - **all three absent** → the null triple. A ledger written before this
   *   build exists and has not yet been opened writably. That is a lawful
   *   state and a reader is told so plainly.
   * - **some present, some absent** → `LedgerIntegrityError`. The three rows
   *   are written in one transaction and nothing ever removes one, so a
   *   partial set means somebody reached past the door.
   * - **present but malformed** → `LedgerIntegrityError`. A value that is not
   *   a v4 UUID is not an identity, and returning it as one would launder the
   *   tampering into a cursor a client would then trust.
   *
   * Returning an invented identity for any of these would be worse than
   * refusing: the whole point of the value is that a client compares it and
   * throws its cache away when it moves.
   */
  #readIdentity(): LedgerIdentity {
    const meta = this.#readMetaMap();
    const present = IDENTITY_KEYS.filter((key) => meta.get(key) !== undefined);

    if (present.length === 0) {
      return { instanceId: null, restoreId: null, restoreEpoch: null };
    }
    if (present.length !== IDENTITY_KEYS.length) {
      throw new LedgerIntegrityError([
        "ledger_meta holds part of this ledger's identity and not the rest: " +
          present.map(safeIdentifier).join(", "),
      ]);
    }

    const instanceId = meta.get(INSTANCE_ID) ?? "";
    const restoreId = meta.get(RESTORE_ID) ?? "";
    const epochText = meta.get(RESTORE_EPOCH) ?? "";

    if (!UUID_V4_PATTERN.test(instanceId)) {
      throw new LedgerIntegrityError(["ledger_meta holds an instance id that is not a uuid"]);
    }
    if (!UUID_V4_PATTERN.test(restoreId)) {
      throw new LedgerIntegrityError(["ledger_meta holds a restore id that is not a uuid"]);
    }
    // The text is matched before it is converted, because `Number` is a
    // coercion and not a parse: it reads `""` as 0, `"1e3"` as 1000, `"0x1f"`
    // as 31, `" 7 "` as 7 and `"+2"` as 2, and every one of those passes
    // `Number.isInteger`. A row edited to any of them would be laundered into a
    // plausible count by the check meant to refuse it. This is the one form
    // this code writes: `String(restoreEpoch)` of a non-negative integer.
    if (!CANONICAL_COUNT_PATTERN.test(epochText)) {
      throw new LedgerIntegrityError([
        "ledger_meta holds a restore epoch that is not a count",
      ]);
    }
    const restoreEpoch = Number(epochText);
    if (!Number.isSafeInteger(restoreEpoch)) {
      throw new LedgerIntegrityError([
        "ledger_meta holds a restore epoch too large to be a count",
      ]);
    }

    return { instanceId, restoreId, restoreEpoch };
  }

  /**
   * This ledger's identity: which file, and which restore of it.
   *
   * A read, so it works through a read-only handle — which is the ordinary
   * case, because the observers that need it open read-only.
   */
  identity(): LedgerIdentity {
    this.#assertOpen("identity");
    return this.#readIdentity();
  }

  /**
   * Record that this file is the product of a formal restore (P-10/id-A).
   *
   * The door a restorer calls **after** putting the bytes in place and
   * **before** admitting any work. It writes a fresh random `restore_id` and
   * advances `restore_epoch`, in a transaction of its own — the contract is
   * explicit that this lands before any later `appendBatch`, and the reason is
   * ordering rather than atomicity: a client that reconnects between the two
   * must see the new identity, never the old identity over new events.
   *
   * **The new id is random and is not derived from the epoch.** A counter
   * collides when the same backup is restored twice, and two restores a client
   * cannot tell apart is the entire defect this closes. The epoch moves beside
   * it as a human-readable ordering and carries no uniqueness.
   *
   * What this does NOT do: copy anything, verify anything about the bytes, or
   * coordinate the ledger with its WAL and the artifact store. A consistent
   * backup window is a different packet's; this is the identity such a packet
   * writes, and its ordering rule.
   */
  recordRestore(): LedgerIdentity {
    this.#assertOpen("recordRestore");
    this.#assertWritable("recordRestore");

    const run = this.#db.transaction((): LedgerIdentity => {
      const current = this.#readIdentity();
      if (current.instanceId === null || current.restoreEpoch === null) {
        // Unreachable through the door: a writable open seeds the identity
        // before it hands back a handle. Reachable by tampering, and a restore
        // recorded against a file with no identity would be a restore of
        // nothing.
        throw new LedgerIntegrityError([
          "this ledger has no identity to restore; it was never opened writably by this build",
        ]);
      }

      const restoreEpoch = current.restoreEpoch + 1;
      if (!Number.isSafeInteger(restoreEpoch)) {
        // Refused BEFORE anything is written, which is the whole point.
        //
        // `#readIdentity` requires a safe integer, so an epoch one past the
        // ceiling is a value this door can write and can never read back: the
        // next `identity()`, `status()` or `verifyIntegrity()` would refuse the
        // file's own identity, and the restore id written beside it would be
        // unreachable. A door that bricks the thing it was asked to record is
        // worse than a door that refuses.
        //
        // Unreachable by counting — it would take more restores than there are
        // safe integers — and that is exactly why it is worth refusing rather
        // than trusting: the only way to arrive here is for the stored epoch to
        // have been put there by something other than this counter.
        throw new LedgerValidationError([
          {
            path: "restoreEpoch",
            message:
              "this ledger's restore epoch is at " +
              String(current.restoreEpoch) +
              " and the next one is not representable; recording another restore " +
              "would write an identity this build cannot read back",
          },
        ]);
      }

      const restoreId = randomUUID();
      this.#writeMeta(RESTORE_ID, restoreId);
      this.#writeMeta(RESTORE_EPOCH, String(restoreEpoch));

      // The instance id is untouched, deliberately: a restore produces the
      // same file's contents at an earlier point, not a different file.
      return { instanceId: current.instanceId, restoreId, restoreEpoch };
    });
    return run.immediate();
  }

  /**
   * Advance the watermark of every projection fed by one stream.
   *
   * This `UPDATE` is the single source of truth for how far a projection has
   * been applied. Nothing derives that from a clock, from `updated_at`, or from
   * counting rows in the derived table, and nothing may: two answers to "how
   * far" is how a projector applies the same range twice.
   *
   * It targets the composite key rather than the projection name alone, so
   * advancing one stream cannot move a row that follows another.
   */
  #writeWatermarks(sources: readonly ProjectionSource[], level: StreamLevel): void {
    const update = this.#stmt(
      "UPDATE projection_watermark SET projector_version = ?, applied_sequence = ?, " +
        "event_count = ?, source_head_sha256 = ?, updated_at = ? " +
        "WHERE projection_name = ? AND source_stream = ?",
    );
    for (const source of sources) {
      update.run(
        PROJECTOR_VERSION,
        level.sequence,
        level.count,
        level.sha256,
        level.updatedAt,
        source.projectionName,
        source.sourceStream,
      );
    }
  }

  /**
   * Clear and rewrite the whole watermark table, for a rebuild.
   *
   * The contract is explicit that a rebuild deletes the row and writes it back
   * rather than updating it in place: a read model that was dropped and
   * regenerated has no partial state worth preserving, and a row left over from
   * a projection this build no longer defines would survive an UPDATE that
   * never named it.
   */
  #rewriteWatermarks(task: StreamLevel, initiative: StreamLevel, registry: StreamLevel): void {
    this.#stmt("DELETE FROM projection_watermark").run();
    const insert = this.#stmt(
      "INSERT INTO projection_watermark (" + WATERMARK_COLUMNS + ") VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const source of PROJECTION_SOURCES) {
      // One level per stream, chosen per ROW rather than per projection. The
      // two-source projection gets both, which is the whole reason a rebuild
      // may not carry a single number for it.
      const level =
        source.sourceStream === INITIATIVE_STREAM
          ? initiative
          : source.sourceStream === REGISTRY_STREAM
            ? registry
            : task;
      insert.run(
        source.projectionName,
        source.sourceStream,
        PROJECTOR_VERSION,
        level.sequence,
        level.count,
        level.sha256,
        level.updatedAt,
      );
    }
  }

  #readWatermarks(): WatermarkRow[] {
    return this.#stmt(
      "SELECT " +
        WATERMARK_COLUMNS +
        " FROM projection_watermark ORDER BY projection_name ASC, source_stream ASC",
    ).all() as WatermarkRow[];
  }

  /**
   * The chain digest of a stream **at** a given sequence.
   *
   * The verification the contract asks for is against the position the
   * projection actually consumed, not against whatever the head has since
   * become. While every projection is level with its stream the two coincide,
   * which is exactly why comparing against the current head would look correct
   * and would stop being correct the moment a watermark legitimately lagged.
   *
   * The table name is never interpolated from database content: the caller has
   * already matched the row's stream against the closed set, and the two
   * statements below are this module's own literals.
   */
  #digestAtSequence(sourceStream: string, sequence: number): string | null {
    if (sequence === 0) return GENESIS_SHA256;
    const sql =
      sourceStream === INITIATIVE_STREAM
        ? "SELECT event_sha256 FROM initiative_events WHERE sequence = ?"
        : sourceStream === REGISTRY_STREAM
          ? "SELECT event_sha256 FROM registry_events WHERE sequence = ?"
          : "SELECT event_sha256 FROM control_plane_events WHERE sequence = ?";
    const row = this.#stmt(sql).get(sequence) as { readonly event_sha256: string } | undefined;
    return row === undefined ? null : row.event_sha256;
  }

  /**
   * How many events a stream holds **through** a given sequence.
   *
   * The companion of `#digestAtSequence`, asked at the same position and for
   * the same reason. A watermark carries two claims about where a projection
   * stands — the digest it was built from and how many events it folded — and
   * until now only the first was ever checked. An `event_count` nobody compares
   * is a number `status()` publishes on the ledger's authority while nothing
   * holds it to the log.
   *
   * Counted **at** `applied_sequence` rather than over the whole stream,
   * because a watermark that lawfully lags is level with the count at ITS
   * position, not with the tail. And counted rather than derived from the
   * sequence itself: they coincide only while the stream is contiguous, and
   * contiguity is a separate finding this check must not quietly assume.
   *
   * The table name is never interpolated from database content: the caller has
   * already matched the row's stream against the closed set, and the three
   * statements below are this module's own literals.
   */
  #countAtSequence(sourceStream: string, sequence: number): number {
    const sql =
      sourceStream === INITIATIVE_STREAM
        ? "SELECT COUNT(*) AS n FROM initiative_events WHERE sequence <= ?"
        : sourceStream === REGISTRY_STREAM
          ? "SELECT COUNT(*) AS n FROM registry_events WHERE sequence <= ?"
          : "SELECT COUNT(*) AS n FROM control_plane_events WHERE sequence <= ?";
    const row = this.#stmt(sql).get(sequence) as { readonly n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // Event decoding
  // -------------------------------------------------------------------------

  /**
   * Decode a stored row into a record, refusing anything that does not match
   * the contract or its own canonical bytes.
   *
   * Read paths fail closed on tampering rather than returning a plausible
   * looking event, because a UI that renders a tampered event is worse than a
   * UI that refuses to render.
   */
  #rowToRecord(row: EventRow): LedgerEventRecord {
    const problems = this.#validateRowShape(row);
    if (problems.length > 0) {
      throw new LedgerIntegrityError(problems.map((problem) => problem.detail));
    }
    const decoded: unknown = JSON.parse(row.event_json);
    const parsed = ControlPlaneEvent.safeParse(decoded);
    if (!parsed.success) {
      const version = unsupportedContractVersion(decoded);
      throw new LedgerIntegrityError([
        version === null
          ? "stored event at sequence " + String(row.sequence) + " does not satisfy the contract"
          : "stored event at sequence " +
            String(row.sequence) +
            " is stamped contract version " +
            version +
            ", which this build does not read; the supported versions are " +
            supportedVersionList(),
      ]);
    }
    return {
      sequence: row.sequence,
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      event: parsed.data,
      canonicalJson: row.event_json,
      previousSha256: row.previous_sha256,
      eventSha256: row.event_sha256,
      causation: causationFromRow(row, row.sequence),
    };
  }

  /**
   * Structural checks that do not need the chain: parseable JSON, canonical
   * bytes, contract conformance, and columns that agree with the body.
   *
   * Column agreement matters because every query filters on the columns rather
   * than on the JSON. If the two disagreed, a filtered query could hide an
   * event that is really there, or surface one that is not.
   */
  #validateRowShape(row: EventRow): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "sequence " + String(row.sequence) + " holds event_json that is not valid JSON",
        sequence: row.sequence,
      });
      return problems;
    }

    let canonical: string;
    try {
      canonical = canonicalJsonStringify(decoded);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "sequence " + String(row.sequence) + " holds event_json that is not canonicalizable",
        sequence: row.sequence,
      });
      return problems;
    }

    if (canonical !== row.event_json) {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "sequence " +
          String(row.sequence) +
          " holds event_json that is not in canonical form, so it was rewritten after it was appended",
        sequence: row.sequence,
      });
    }

    const parsed = ControlPlaneEvent.safeParse(decoded);
    if (!parsed.success) {
      const version = unsupportedContractVersion(decoded);
      problems.push({
        kind: "EVENT_CONTRACT",
        detail:
          version === null
            ? "sequence " +
              String(row.sequence) +
              " holds an event that no longer satisfies the ControlPlaneEvent contract"
            : "sequence " +
              String(row.sequence) +
              " holds an event stamped contract version " +
              version +
              ", which this build does not read; the supported versions are " +
              supportedVersionList(),
        sequence: row.sequence,
      });
      return problems;
    }

    const event = parsed.data;
    const mismatches: string[] = [];
    if (event.eventId !== row.event_id) mismatches.push("event_id");
    if (event.idempotencyKey !== row.idempotency_key) mismatches.push("idempotency_key");
    if (event.taskId !== row.task_id) mismatches.push("task_id");
    if (event.attempt !== row.attempt) mismatches.push("attempt");
    if (event.transitionId !== row.transition_id) mismatches.push("transition_id");
    if (event.type !== row.type) mismatches.push("type");
    if (event.fromState !== row.from_state) mismatches.push("from_state");
    if (event.toState !== row.to_state) mismatches.push("to_state");
    if (event.emittedBy !== row.emitted_by) mismatches.push("emitted_by");
    if (event.occurredAt !== row.occurred_at) mismatches.push("occurred_at");
    if (event.recordedAt !== row.recorded_at) mismatches.push("recorded_at");
    if (event.correlationId !== row.correlation_id) mismatches.push("correlation_id");
    if (event.causationId !== row.causation_id) mismatches.push("causation_id");
    if (event.contractVersion !== row.contract_version) mismatches.push("contract_version");

    if (mismatches.length > 0) {
      problems.push({
        kind: "EVENT_COORDINATES",
        detail:
          "sequence " +
          String(row.sequence) +
          " has columns that disagree with the stored body: " +
          mismatches.join(", "),
        sequence: row.sequence,
      });
    }

    return problems;
  }

  // -------------------------------------------------------------------------
  // Append
  // -------------------------------------------------------------------------

  /**
   * Append one event, atomically, exactly once.
   *
   * An exact replay of an already recorded event is not an error: it returns
   * the original record with inserted false and writes nothing. That is what
   * makes a durable step safe to retry. Reusing the same coordinates for
   * different content is the opposite case and fails closed.
   *
   * The optional second argument records **why** this event happened, as a
   * reference the ledger resolves rather than a string it stores. Omitting it
   * is the ordinary case and is exactly what every caller did before.
   */
  append(candidate: unknown, causation?: CausationRef | null): AppendResult {
    this.#assertOpen("append");
    this.#assertWritable("append");

    const parsed = ControlPlaneEvent.safeParse(candidate);
    if (!parsed.success) {
      throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
    }
    const event = parsed.data;
    const canonicalJson = canonicalJsonStringify(event);
    // Shape before the lock, resolution inside it: a malformed reference does
    // not deserve the write lock, and a well-formed one cannot be resolved
    // without reading the stream it names.
    const reference = normalizeCausation(causation, "causation");

    const run = this.#db.transaction(
      (): AppendResult => this.#appendInTransaction(event, canonicalJson, reference),
    );
    // IMMEDIATE takes the write lock at BEGIN rather than at first write, so
    // two processes serialize here instead of discovering the conflict late and
    // failing with a busy snapshot they cannot upgrade.
    return run.immediate();
  }

  /**
   * Append a batch of task-stream events, atomically, all or none.
   *
   * The batch is the unit: one `BEGIN IMMEDIATE` covers the rows, the
   * projections, the head and the watermarks, so a caller that has three facts
   * to record no longer records them across three transactions with two windows
   * in between. A failure anywhere in the batch leaves the ledger exactly as it
   * was, including the watermarks.
   *
   * It is added **beside** `append`, never in place of it: no call site moves in
   * this packet, and a door that quietly changed the transaction boundary under
   * ten existing callers would be a migration wearing a feature's clothes.
   *
   * The task stream only. The initiative and account doors keep their own
   * single-event entries, because a batch that spanned two streams would be a
   * batch across two independent chains and two independent heads.
   *
   * An exact replay inside a batch is a no-op for that event alone and does not
   * spoil the rest, exactly as it is for `append`. A conflict — a reused key
   * with different content, a reused event id, a transition the lifecycle does
   * not allow — aborts the whole batch, because half a batch is not something
   * the caller asked for.
   *
   * Causal references travel in a parallel array rather than folded into the
   * candidates, because a candidate is whatever the caller has and is parsed
   * against a contract this package does not own. When the array is given it
   * must be the same length as the batch: one that lined up by luck would
   * quietly attribute one event's cause to another.
   */
  appendBatch(
    candidates: readonly unknown[],
    causations?: readonly (CausationRef | null)[],
  ): AppendBatchResult {
    this.#assertOpen("appendBatch");
    this.#assertWritable("appendBatch");

    if (candidates.length === 0) {
      throw new LedgerValidationError([
        {
          path: "<root>",
          message: "a batch is one or more events, and an empty batch appends nothing",
        },
      ]);
    }

    if (causations !== undefined && causations.length !== candidates.length) {
      throw new LedgerValidationError([
        {
          path: "causations",
          message:
            "a batch's causal references are one per event: " +
            String(candidates.length) +
            " events were given " +
            String(causations.length) +
            " references",
        },
      ]);
    }

    // Every candidate is parsed and canonicalized before the transaction opens.
    // A batch that validated lazily would take the write lock, insert the events
    // it had already accepted and only then meet the malformed one: the rollback
    // would be correct, and the contention would be gratuitous.
    const prepared = candidates.map((candidate, index) => {
      const parsed = ControlPlaneEvent.safeParse(candidate);
      if (!parsed.success) {
        throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
      }
      return {
        event: parsed.data,
        canonicalJson: canonicalJsonStringify(parsed.data),
        causation: normalizeCausation(causations?.[index], "causations[" + String(index) + "]"),
      };
    });

    const run = this.#db.transaction((): AppendBatchResult => {
      const results: AppendResult[] = [];
      let level: StreamLevel | null = null;
      let insertedCount = 0;
      // The event this batch inserted immediately before the one being
      // appended, or null. A replay breaks the run: an event already recorded
      // committed in some earlier transaction, and a revocation's intention is
      // atomic only with a quarantine that commits in this one (P-18/F).
      let predecessor: OutboxPredecessor | null = null;
      const inserted: { readonly index: number; readonly event: ControlPlaneEvent }[] = [];

      for (const [index, { event, canonicalJson, causation }] of prepared.entries()) {
        const appended = this.#appendOneInTransaction(event, canonicalJson, causation, predecessor);
        results.push(appended.result);
        if (appended.head === null) {
          predecessor = null;
          continue;
        }
        predecessor = { taskId: event.taskId, type: event.type, toState: event.toState };
        inserted.push({ index, event });
        insertedCount += 1;
        // Each event's own recordedAt, so the watermark carries the instant of
        // the last event actually written rather than a clock read here.
        level = {
          sequence: appended.head.sequence,
          count: appended.head.count,
          sha256: appended.head.sha256,
          updatedAt: event.recordedAt,
        };
      }

      if (level !== null) {
        // One watermark write for the batch. The rows, the projections, the head
        // and the watermarks commit together or not at all.
        this.#writeWatermarks(TASK_WATERMARKS, level);

        // The outbox intention belongs in this transaction, and P-18/F is the
        // escalón that fills the gap (datos §11 `:546-547`). The intention itself
        // is an ordinary event of this batch, checked by `#assertOutboxEvent` as
        // it went in; what is left for here is the one rule no single event can
        // see — the batch's own shape.
        //
        // A quarantine commits with its intention to revoke, or it does not
        // commit (contracts §13 `:559-561`). The intention's half was held as each
        // event went in: a `REVOKE_LEASE` intention follows its quarantine. This
        // is the other half: a move to `SUSPECT_WORKTREE` in a batch that carries
        // no `REVOKE_LEASE` intention of the same task rolls the whole batch back.
        //
        // **Inside `appendBatch` only.** A unitary `append` of that move is still
        // admitted, because the daemon's conformance gate writes one today; that
        // window is declared in ADR 0078 and decision 51 and is closed by the
        // adoption, not by this door. And nothing here is atomic with an arbiter:
        // the ledger and a coordination store are separate files and never share
        // a transaction.
        this.#assertQuarantineBatch(inserted);

        this.#faults.beforeAppendCommit?.();
      }

      const head = level ?? this.#readHead();
      return {
        results,
        insertedCount,
        headSequence: head.sequence,
        headEventSha256: head.sha256,
      };
    });

    return run.immediate();
  }

  #appendInTransaction(
    event: ControlPlaneEvent,
    canonicalJson: string,
    causation: CausationRef | null,
  ): AppendResult {
    // No predecessor: a unitary append is its own transaction, so nothing it
    // follows committed with it.
    const appended = this.#appendOneInTransaction(event, canonicalJson, causation, null);
    if (appended.head === null) return appended.result;

    this.#writeWatermarks(TASK_WATERMARKS, {
      sequence: appended.head.sequence,
      count: appended.head.count,
      sha256: appended.head.sha256,
      updatedAt: event.recordedAt,
    });

    this.#faults.beforeAppendCommit?.();

    return appended.result;
  }

  /**
   * One event's worth of append, inside a transaction the caller opened.
   *
   * Everything except the watermark: the dedupe checks, the lifecycle guard, the
   * chain, the insert, the contiguity check and the incremental projection. The
   * watermark is left to the caller because a batch advances it once, after its
   * last event, rather than once per event.
   *
   * `predecessor` is the event the same transaction inserted immediately before
   * this one, or null — the only fact about a batch an outbox intention needs.
   */
  #appendOneInTransaction(
    event: ControlPlaneEvent,
    canonicalJson: string,
    causation: CausationRef | null,
    predecessor: OutboxPredecessor | null,
  ): AppendedEvent {
    const existingByKey = this.#stmt(
      "SELECT " + EVENT_COLUMNS + " FROM control_plane_events WHERE idempotency_key = ?",
    ).get(event.idempotencyKey) as EventRow | undefined;

    if (existingByKey !== undefined) {
      const stored = causationFromRow(existingByKey, existingByKey.sequence);
      if (existingByKey.event_json === canonicalJson && causationEquals(stored, causation)) {
        return {
          result: { inserted: false, record: this.#rowToRecord(existingByKey) },
          head: null,
        };
      }
      throw new LedgerIdempotencyConflictError(
        event.idempotencyKey,
        appendContentDigest(existingByKey.event_json, stored),
        appendContentDigest(canonicalJson, causation),
      );
    }

    const existingById = this.#stmt(
      "SELECT idempotency_key FROM control_plane_events WHERE event_id = ?",
    ).get(event.eventId) as { readonly idempotency_key: string } | undefined;

    if (existingById !== undefined) {
      throw new LedgerEventIdConflictError(
        event.eventId,
        existingById.idempotency_key,
        event.idempotencyKey,
      );
    }

    // Only the version in force is admitted for a genuinely NEW insertion, and
    // the exemption above this line is the whole design (ADR 0072's debt, paid
    // by ADR 0076). An exact replay of a row already recorded has returned
    // already, so a producer that retries an append written before the bump
    // still succeeds; what is refused here is *new* work stamped with a version
    // that is supported for reading and is no longer the one in force.
    //
    // The refusal names both numbers, because "unsupported version" and "not
    // the current version" are different problems with different fixes and an
    // operator holding a stale build needs to be told which one it has.
    if (event.contractVersion !== CONTRACT_VERSION) {
      throw new LedgerValidationError([
        {
          path: "contractVersion",
          message:
            "a new event is recorded under the contract version in force, which is " +
            CONTRACT_VERSION +
            "; this event carries " +
            event.contractVersion +
            ", which this build reads (the supported set is " +
            supportedVersionList() +
            ") but no longer emits",
        },
      ]);
    }

    const task = this.#stmt(
      "SELECT current_state FROM task_read_model WHERE task_id = ?",
    ).get(event.taskId) as { readonly current_state: string } | undefined;

    if (task === undefined) {
      if (event.fromState !== null) {
        throw new LedgerLifecycleConflictError(event.taskId, event.fromState, null);
      }
    } else if (event.fromState !== task.current_state) {
      throw new LedgerLifecycleConflictError(event.taskId, event.fromState, task.current_state);
    }

    // Resolved here, with the transaction already open, so that a reference to
    // an event appended moments ago by this same batch resolves against a row
    // that is really there. The trigger holds the same line underneath; this
    // layer exists so the refusal is a typed LedgerValidationError rather than
    // a raw SQLite error nobody can catch by class.
    this.#assertCausationResolves(causation);

    // The envelope reference a revision record of the new cohort names, looked
    // up by name before anything is written (P-36/local D, M-5.3). Before the
    // attempt's identity, so an opening naming a reference nobody registered is
    // refused for the reference rather than for whatever the CAS meets next.
    this.#assertEnvelopeReference(event);

    const head = this.#readHead();
    const previousSha256 = head.sha256;
    const eventSha256 = chainDigest(previousSha256, canonicalJson);
    const expectedSequence = head.sequence + 1;

    // The V2 coordinate, taken from the payload the event already carries
    // (P-05/B), and refused here by name if the payload got it wrong (F-2).
    // `null` for an event in V1 form, which is still the shape of most rows
    // this build writes.
    const coordinate = v2CoordinateColumns(event);

    // The attempt's identity, compared and set under the write lock this
    // transaction already holds (P-18/B). Before the `INSERT`, because the
    // refusals it raises are about the event and must name the coordinate
    // rather than arrive from an index as an abort.
    this.#assertAttemptIdentity(event, coordinate);

    // The effect, its delivery and the segment both hang off (P-18/C). After
    // the attempt's identity, because everything it checks is anchored on the
    // attempt row that check either found or is about to cause.
    this.#assertExecutionEffectIdentity(event, coordinate);

    // The prompt and the answer (P-18/D). After the effect's identity, because
    // an occurrence hangs off a delivery that check either found or refused, and
    // inside the same transaction, so a delivery intended earlier in this batch
    // is a row that is really there (§8 `:419-420`).
    this.#assertExecutionOccurrence(event);

    // The outbox command, its deliveries and what was heard (P-18/F). After the
    // causal reference resolved, because an attempt and an observation are
    // anchored by exactly that reference.
    this.#assertOutboxEvent(event, causation, predecessor);

    // The measurement stream and the observation (P-32/captura B). After the
    // effect's identity, because an observation hangs off an effect that check
    // either found or refused, and through the function the fold calls, so a
    // rebuild refuses the same histories in the same words. What only the
    // settlement fold can see — a coverage overlap, a forked correction, the int64
    // ceiling — is refused as `#projectEvent` folds it, inside this transaction.
    assertUsageCaptureAdmissible(usageBaseView((sql) => this.#stmt(sql)), event);

    const info = this.#stmt(
      "INSERT INTO control_plane_events (" +
        "event_id, idempotency_key, task_id, attempt, revision_number, attempt_number, " +
        "transition_id, type, from_state, " +
        "to_state, emitted_by, occurred_at, recorded_at, correlation_id, causation_id, " +
        "causation_stream, causation_sequence, causation_sha256, " +
        "contract_version, event_json, previous_sha256, event_sha256" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      event.eventId,
      event.idempotencyKey,
      event.taskId,
      event.attempt,
      coordinate.revisionNumber,
      coordinate.attemptNumber,
      event.transitionId,
      event.type,
      event.fromState,
      event.toState,
      event.emittedBy,
      event.occurredAt,
      event.recordedAt,
      event.correlationId,
      event.causationId,
      causation === null ? null : causation.stream,
      causation === null ? null : causation.sequence,
      causation === null ? null : causation.sha256,
      event.contractVersion,
      canonicalJson,
      previousSha256,
      eventSha256,
    );

    const sequence = Number(info.lastInsertRowid);
    if (sequence !== expectedSequence) {
      // The head and the table disagree about where the log ends. Refuse rather
      // than chain a digest onto a position that is not actually the tail.
      throw new LedgerSequenceError(expectedSequence, sequence);
    }

    this.#faults.beforeProjection?.();

    this.#projectEvent(event, sequence, eventSha256);
    this.#writeHead(sequence, eventSha256, head.count + 1);

    return {
      result: {
        inserted: true,
        record: {
          sequence,
          eventId: event.eventId,
          idempotencyKey: event.idempotencyKey,
          event,
          canonicalJson,
          previousSha256,
          eventSha256,
          causation,
        },
      },
      head: { sequence, sha256: eventSha256, count: head.count + 1 },
    };
  }

  /**
   * Resolve a causal reference against the stream it names, or refuse it.
   *
   * The digest must be the referenced event's own `event_sha256` at that exact
   * position. A digest that does not match is an invalid reference, not a weak
   * link, and a position no row occupies is the same failure: in both cases the
   * claim "this was caused by that" names nothing this ledger holds.
   */
  #assertCausationResolves(causation: CausationRef | null): void {
    if (causation === null) return;

    const row = this.#stmt(
      "SELECT event_sha256 FROM " + causationTable(causation.stream) + " WHERE sequence = ?",
    ).get(causation.sequence) as { readonly event_sha256: string } | undefined;

    if (row === undefined) {
      throw new LedgerValidationError([
        {
          path: "causation.sequence",
          message:
            "a causal reference names sequence " +
            String(causation.sequence) +
            " of " +
            causation.stream +
            ", which holds no event",
        },
      ]);
    }
    if (row.event_sha256 !== causation.sha256) {
      // Digests only: the referenced body never appears in a diagnostic.
      throw new LedgerValidationError([
        {
          path: "causation.sha256",
          message:
            "a causal reference to sequence " +
            String(causation.sequence) +
            " of " +
            causation.stream +
            " carries digest " +
            causation.sha256 +
            " but that event's digest is " +
            row.event_sha256,
        },
      ]);
    }
  }

  /**
   * The attempt's identity, compared and set inside the write lock (P-18/B).
   *
   * Execution §3 `:122` states this as one paragraph, and it is the whole of
   * what this method does: "in `BEGIN IMMEDIATE`, the expected head of the task
   * is compared and the full coordinate is looked up. If it already exists, its
   * assignment and invocation_id are reused **and a different invocationId for
   * the same coordinate is refused**; if not, the event fixes invocationId and
   * `1 + MAX(attempt)` of that task's events is assigned, legacy ones included
   * (with no events: 1)."
   *
   * **Amended by P-15/D1 (ADR 0105):** when events of that same coordinate already
   * exist — an intake's discovery, written before any opening — their flat attempt is
   * reused rather than `1 + MAX(attempt)` assigned, and two distinct flat attempts on
   * one coordinate refuse the opening.
   *
   * **The producer proposes and this door verifies.** That is the one reading
   * the shape of an append admits, and it is adjudicated rather than invented.
   * An event arrives *signed*: `canonicalJson` and therefore `event_sha256`
   * cover `attempt`, and both are computed before the transaction opens. So
   * "assign" cannot mean "write a number into the event" — the ledger would
   * have to recanonicalize and rehash a body the caller had already hashed, or
   * grow a second append path that builds and signs events of its own. Instead
   * the producer reads the projection, proposes `attempt` and
   * `legacyAttemptNumber`, and this method computes what the answer must have
   * been and refuses, by name, if the proposal differs. No new door, no
   * recanonicalization, and nothing mutated after signing. ADR 0073 records it.
   *
   * **Tolerant without a row, strict with one.** For every V2 event that is not
   * an opening, the coordinate is checked against the assignment *only if the
   * attempt has been opened*. A V2 event over a coordinate with no attempt row
   * is lawful: migration 11 declared the "migrated but not populated" window,
   * every V2 fixture written before this escalón is exactly that shape, and
   * demanding that an opening precede everything would retroactively refuse
   * histories the log already holds.
   */
  #assertAttemptIdentity(
    event: ControlPlaneEvent,
    coordinate: {
      readonly revisionNumber: number | null;
      readonly attemptNumber: number | null;
    },
  ): void {
    if (coordinate.revisionNumber === null || coordinate.attemptNumber === null) {
      // A V1 event. The flat `attempt` is the whole coordinate it has, and no
      // attempt row can describe it.
      return;
    }

    const { revisionNumber, attemptNumber } = coordinate;
    const where = taskAttemptKey(event.taskId, revisionNumber, attemptNumber);

    const existing = this.#stmt(
      "SELECT * FROM task_attempt_read_model " +
        "WHERE task_id = ? AND revision_number = ? AND attempt_number = ?",
    ).get(event.taskId, revisionNumber, attemptNumber) as TaskAttemptRow | undefined;

    if (event.type !== TASK_ATTEMPT_OPENED) {
      if (existing === undefined) return;
      if (event.attempt !== existing.legacy_attempt_number) {
        // Execution §3 `:123`: "every event of the same coordinate must repeat
        // it". A V2 event whose flat `attempt` disagrees with the assignment
        // would be indexed under a coordinate the attempt table says belongs to
        // a different try, and every query written before migration 11 reads
        // that column.
        throw new LedgerValidationError([
          {
            path: "attempt",
            message:
              "attempt " +
              where +
              " was assigned the flat attempt " +
              String(existing.legacy_attempt_number) +
              ", and every event of that coordinate repeats it; this event carries " +
              String(event.attempt),
          },
        ]);
      }
      return;
    }

    // The two facts only an opening may state. Read here rather than through
    // the fold, because the fold answers "is there a row" and this has to say
    // which key is at fault.
    const proposed = event.payload[LEGACY_ATTEMPT_NUMBER_KEY];
    const invocationId = event.payload[INVOCATION_ID_KEY];

    if (
      typeof proposed !== "number" ||
      !Number.isSafeInteger(proposed) ||
      proposed < 1
    ) {
      throw new LedgerValidationError([
        {
          path: "payload." + LEGACY_ATTEMPT_NUMBER_KEY,
          message:
            "an attempt opening states the flat assignment its coordinate was given, as a " +
            "safe integer of at least one, and this payload holds a " +
            typeof proposed,
        },
      ]);
    }
    if (typeof invocationId !== "string" || invocationId.length === 0) {
      throw new LedgerValidationError([
        {
          path: "payload." + INVOCATION_ID_KEY,
          message:
            "an attempt opening records the invocation it names, as a non-empty string, " +
            "and this payload holds a " + typeof invocationId,
        },
      ]);
    }

    // The third pairing rule, and the sister of the two the stream trigger
    // holds for `revisionNumber`/`attemptNumber`. It lives here rather than in
    // a fourth trigger, which is adjudicated (ADR 0073): the flat assignment is
    // compared against a projection and against `MAX(attempt)` of the task, and
    // a `BEFORE INSERT` trigger that read the projection would be duplicating
    // the compare-and-set below in SQL, in a place where it could not name the
    // expected value. The cost is stated rather than hidden: a writer that
    // bypasses this door entirely can still record a row whose payload and
    // column disagree about the flat number.
    if (proposed !== event.attempt) {
      throw new LedgerValidationError([
        {
          path: "payload." + LEGACY_ATTEMPT_NUMBER_KEY,
          message:
            "an attempt opening's flat assignment is the value that goes in the legacy " +
            "attempt column: this payload states " +
            String(proposed) +
            " and the event carries " +
            String(event.attempt),
        },
      ]);
    }

    // The foreign key, guarded by name before SQLite guards it by abort. The
    // opening carries its own revision record, so the ordinary case satisfies
    // `fk_task_attempt_read_model__task_revision_read_model` by construction —
    // the revision row is folded from this same event inside this same
    // transaction. What is refused here is the opening that neither finds a
    // revision nor announces one, which would otherwise surface as a
    // `SqliteError` nobody can catch by class (F-2's standard, ADR 0072).
    if (nextTaskRevisionProjection(event, 0) === null) {
      const revision = this.#stmt(
        "SELECT task_id FROM task_revision_read_model WHERE task_id = ? AND revision_number = ?",
      ).get(event.taskId, revisionNumber) as { readonly task_id: string } | undefined;
      if (revision === undefined) {
        throw new LedgerValidationError([
          {
            path: "payload." + REVISION_ID_KEY,
            message:
              "an attempt opens on a revision, and revision " +
              String(revisionNumber) +
              " of task " +
              event.taskId +
              " neither exists nor is announced by this event's own payload",
          },
        ]);
      }
    }

    if (existing !== undefined) {
      // The coordinate is already open. Its assignment and its invocation are
      // reused, which means an opening that agrees with them is a replay and
      // one that disagrees is two answers to the same question.
      if (invocationId !== existing.invocation_id) {
        throw new LedgerValidationError([
          {
            path: "payload." + INVOCATION_ID_KEY,
            message:
              "attempt " +
              where +
              " is already open under invocation " +
              safeInvocationId(existing.invocation_id) +
              ", and one attempt names one invocation; this event names " +
              safeInvocationId(invocationId),
          },
        ]);
      }
      if (event.attempt !== existing.legacy_attempt_number) {
        throw new LedgerValidationError([
          {
            path: "attempt",
            message:
              "attempt " +
              where +
              " was assigned the flat attempt " +
              String(existing.legacy_attempt_number) +
              " once and keeps it; this event proposes " +
              String(event.attempt),
          },
        ]);
      }
      return;
    }

    // A coordinate nobody has opened. The assignment is computed, not accepted:
    // `1 + MAX(attempt)` over every event of this task, legacy rows included,
    // because the flat counter is monotone per task and a legacy event holds
    // one. A task with no events at all is assigned 1.
    //
    // **Unless the coordinate already has events** (P-15/D1, ADR 0105; streams
    // §1.1, execution §3 as amended). A task that entered through the intake holds its
    // `TASK_DISCOVERED` at (revision 1, attempt 1) before any opening, under a flat
    // attempt of its own; the opening of that coordinate reuses that number rather
    // than taking the next one, so the intake, the opening and the discovery are one
    // attempt. Events of one coordinate at two flat attempts are two answers to one
    // question, and the opening is refused rather than choosing between them.
    const prior = (
      this.#stmt(
        "SELECT DISTINCT attempt FROM control_plane_events " +
          "WHERE task_id = ? AND revision_number = ? AND attempt_number = ? ORDER BY attempt",
      ).all(event.taskId, revisionNumber, attemptNumber) as { readonly attempt: number }[]
    ).map((row) => row.attempt);
    if (prior.length > 1) {
      throw new LedgerValidationError([
        {
          path: "attempt",
          message:
            "attempt " +
            where +
            " already holds events at the flat attempts " +
            prior.map(String).join(", ") +
            ", and one coordinate has one flat attempt; the opening is not written",
        },
      ]);
    }
    const reused = prior[0];
    const head = this.#stmt(
      "SELECT MAX(attempt) AS highest FROM control_plane_events WHERE task_id = ?",
    ).get(event.taskId) as { readonly highest: number | null };
    const expected = reused ?? (head.highest ?? 0) + 1;

    // The cap, checked on the COMPUTED value and before the comparison below.
    // Reversing the two would make the contract's own parse refuse the event
    // first and leave the claim "the compare-and-set knows the cap" untested
    // (Q4, and the preaudit's correction).
    if (expected > MAX_FLAT_ATTEMPT) {
      throw new LedgerValidationError([
        {
          path: "attempt",
          message:
            "task " +
            event.taskId +
            " has exhausted the flat attempt space: the next assignment would be " +
            String(expected) +
            " and the contract's bound is " +
            String(MAX_FLAT_ATTEMPT) +
            "; a task this far gone is resolved with a new task, not with a wrapped counter",
        },
      ]);
    }

    if (event.attempt !== expected) {
      throw new LedgerValidationError([
        {
          path: "attempt",
          message:
            "attempt " +
            where +
            " is assigned the flat attempt " +
            String(expected) +
            (reused === undefined
              ? ", which is one past this task's highest, and this event proposes "
              : ", which its own earlier events already carry, and this event proposes ") +
            String(event.attempt),
        },
      ]);
    }

    // The other half of the bijection. The primary key stops one coordinate
    // holding two invocations; this stops one invocation holding two
    // coordinates. Guarded here so the refusal names both attempts rather than
    // arriving from `ux_task_attempt_read_model__invocation_id` as an abort.
    const claimed = this.#stmt(
      "SELECT task_id, revision_number, attempt_number FROM task_attempt_read_model " +
        "WHERE invocation_id = ?",
    ).get(invocationId) as
      | {
          readonly task_id: string;
          readonly revision_number: number;
          readonly attempt_number: number;
        }
      | undefined;
    if (claimed !== undefined) {
      throw new LedgerValidationError([
        {
          path: "payload." + INVOCATION_ID_KEY,
          message:
            "invocation " +
            safeInvocationId(invocationId) +
            " already names attempt " +
            taskAttemptKey(claimed.task_id, claimed.revision_number, claimed.attempt_number) +
            ", and one invocation names one attempt; this event would give it " +
            where,
        },
      ]);
    }
  }

  /**
   * The effect's identity, and its delivery's, compared and set under the write
   * lock this transaction already holds (P-18/protocolo C).
   *
   * The sister of `#assertAttemptIdentity`, one rung further down the ladder and
   * making the same division of duties: **the producer proposes and the ledger
   * verifies**. An event arrives signed, so "assign" could not mean writing into
   * the body without recanonicalizing it; what the ledger can do is compute the
   * answer itself and refuse by name when the two disagree. Every digest on
   * these rows whose preimage this ledger can see is recomputed here from the
   * *sources* — `invocation_id` off the attempt row, `envelope_sha256` off the
   * revision row — rather than believed.
   *
   * `request_sha256` is the one exception and it is declared rather than
   * quiet: its preimage carries `neutralRequest`, and execution §6.1 `:296`
   * forbids a business payload in a ledger event, so the digest is recorded and
   * conserved. A check that only appeared to be one would be worse.
   *
   * This is also where the **logical lookup** of §6.1 is enforced from the
   * write side. Reading it is `lookUpEffect`'s job; what happens here is the
   * refusal that makes reading it necessary: an intention whose logical key
   * already belongs to an effect is not a second intention, and a producer that
   * met one is supposed to reuse the effect rather than mint another.
   */
  #assertExecutionEffectIdentity(
    event: ControlPlaneEvent,
    coordinate: {
      readonly revisionNumber: number | null;
      readonly attemptNumber: number | null;
    },
  ): void {
    if (
      event.type !== EFFECT_INTENDED &&
      event.type !== DISPATCH_INTENDED &&
      event.type !== DISPATCH_OUTCOME_RECORDED
    ) {
      return;
    }

    // All three describe work inside one try at one revision, so all three need
    // the coordinate that names it. A V1 form here would be an effect nothing
    // could attach to an attempt.
    if (coordinate.revisionNumber === null || coordinate.attemptNumber === null) {
      throw new LedgerValidationError([
        {
          path: "payload.revisionNumber",
          message:
            event.type +
            " describes work inside one attempt and carries the full V2 coordinate; " +
            "this payload carries none",
        },
      ]);
    }
    const { revisionNumber, attemptNumber } = coordinate;

    if (event.type === DISPATCH_OUTCOME_RECORDED) {
      this.#assertDispatchOutcome(event, revisionNumber, attemptNumber);
      return;
    }

    // Both intention types announce a segment, and a malformed one has to be
    // refused by name here: the fold projects no row for it, and the row that
    // named it would then reach `fk_…__execution_route_segment_read_model` as
    // an abort nobody can attribute to an event (F-2's standard).
    // The transport by name first (P-15/D1, ADR 0105): absent, null, empty or a word
    // outside the contract's vocabulary is refused at its own path, never carried as
    // text. The fold reads it as the same word or projects no row.
    // `segmentTransportRefusal` is the fold's own reading, so the door and a rebuild
    // refuse with one issue.
    const transportRefusal = segmentTransportRefusal(event);
    if (transportRefusal !== null) {
      throw new LedgerValidationError([{ path: transportRefusal.path, message: transportRefusal.message }]);
    }
    const segment = nextExecutionRouteSegmentProjection(event, 0);
    if (segment === null) {
      throw new LedgerValidationError([
        {
          path: "payload." + SEGMENT_KEY,
          message:
            event.type +
            " announces the route segment it runs on, with its number, provider, alias, " +
            "resolution status, transport and policy version, and both pairing rules of " +
            "execution §4 satisfied; this payload does not constitute one",
        },
      ]);
    }

    // The segment belongs to the attempt the event's own coordinate names. A
    // segment is not a place a payload may move work to.
    if (segment.revisionNumber !== revisionNumber || segment.attemptNumber !== attemptNumber) {
      throw new LedgerValidationError([
        {
          path: "payload." + SEGMENT_KEY + ".routeSegmentId",
          message:
            "segment " +
            safeRowIdentifier(segment.routeSegmentId) +
            " names attempt " +
            taskAttemptKey(segment.taskId, segment.revisionNumber, segment.attemptNumber) +
            " and this event is recorded at " +
            taskAttemptKey(event.taskId, revisionNumber, attemptNumber),
        },
      ]);
    }

    // The attempt, which is the source of `invocation_id` and the parent of the
    // segment's foreign key. Unlike migration 12's opening, an effect does NOT
    // announce its own attempt: the attempt is a rung above and is opened by its
    // own event, so an effect that finds none is out of order rather than
    // incomplete.
    const attempt = this.#stmt(
      "SELECT * FROM task_attempt_read_model " +
        "WHERE task_id = ? AND revision_number = ? AND attempt_number = ?",
    ).get(event.taskId, revisionNumber, attemptNumber) as TaskAttemptRow | undefined;
    if (attempt === undefined) {
      throw new LedgerValidationError([
        {
          path: "payload.attemptNumber",
          message:
            "an effect runs inside an attempt, and attempt " +
            taskAttemptKey(event.taskId, revisionNumber, attemptNumber) +
            " has not been opened",
        },
      ]);
    }

    // The segment's own consistency, where the base cannot see it: a segment
    // whose predecessor is not a segment of this same attempt would be lineage
    // pointing out of the attempt it claims to continue.
    const existingSegment = this.#stmt(
      "SELECT * FROM execution_route_segment_read_model WHERE route_segment_id = ?",
    ).get(segment.routeSegmentId) as ExecutionRouteSegmentRow | undefined;
    if (existingSegment === undefined) {
      this.#assertSegmentLineage(segment, revisionNumber, attemptNumber);
    } else if (
      canonicalSegment(executionRouteSegmentRowToModel(existingSegment)) !==
      canonicalSegment(segment)
    ) {
      throw new LedgerValidationError([
        {
          path: "payload." + SEGMENT_KEY + ".routeSegmentId",
          message:
            "segment " +
            safeRowIdentifier(segment.routeSegmentId) +
            " is already recorded with different content, and a segment is opened once",
        },
      ]);
    }

    if (event.type === EFFECT_INTENDED) {
      this.#assertEffectIntention(event, segment, attempt);
      return;
    }
    this.#assertDispatchIntention(event, segment, revisionNumber, attemptNumber);
  }

  /**
   * A new segment's lineage and its position within the attempt.
   *
   * The first segment of an attempt has no predecessor; every later one names
   * the segment that handed off to it, and that segment must belong to this same
   * attempt. The pairing with `handoff_reason` is already held by the fold and
   * by the CHECK, so what is added here is the part neither can see: whether
   * the row being pointed at exists and is a sibling.
   */
  #assertSegmentLineage(
    segment: ExecutionRouteSegmentReadModel,
    revisionNumber: number,
    attemptNumber: number,
  ): void {
    const taken = this.#stmt(
      "SELECT route_segment_id FROM execution_route_segment_read_model " +
        "WHERE task_id = ? AND revision_number = ? AND attempt_number = ? AND segment_number = ?",
    ).get(segment.taskId, revisionNumber, attemptNumber, segment.segmentNumber) as
      | { readonly route_segment_id: string }
      | undefined;
    if (taken !== undefined) {
      throw new LedgerValidationError([
        {
          path: "payload." + SEGMENT_KEY + ".segmentNumber",
          message:
            "segment " +
            String(segment.segmentNumber) +
            " of attempt " +
            taskAttemptKey(segment.taskId, revisionNumber, attemptNumber) +
            " is already " +
            safeRowIdentifier(taken.route_segment_id),
        },
      ]);
    }

    if (segment.predecessorSegmentId === null) {
      if (segment.segmentNumber !== 1) {
        throw new LedgerValidationError([
          {
            path: "payload." + SEGMENT_KEY + ".predecessorSegmentId",
            message:
              "only the first segment of an attempt has no predecessor, and this one is " +
              String(segment.segmentNumber),
          },
        ]);
      }
      return;
    }

    const predecessor = this.#stmt(
      "SELECT * FROM execution_route_segment_read_model WHERE route_segment_id = ?",
    ).get(segment.predecessorSegmentId) as ExecutionRouteSegmentRow | undefined;
    if (
      predecessor === undefined ||
      predecessor.task_id !== segment.taskId ||
      predecessor.revision_number !== revisionNumber ||
      predecessor.attempt_number !== attemptNumber
    ) {
      throw new LedgerValidationError([
        {
          path: "payload." + SEGMENT_KEY + ".predecessorSegmentId",
          message:
            "a handoff continues a segment of the same attempt, and " +
            safeRowIdentifier(segment.predecessorSegmentId) +
            " is not one of attempt " +
            taskAttemptKey(segment.taskId, revisionNumber, attemptNumber),
        },
      ]);
    }
  }

  /**
   * An effect's intention: the vocabulary, the three recomputed digests, the
   * ordinal compare-and-set, and the logical lookup of §6.1.
   */
  #assertEffectIntention(
    event: ControlPlaneEvent,
    segment: ExecutionRouteSegmentReadModel,
    attempt: TaskAttemptRow,
  ): void {
    const effect = nextEffectProjection(event, 0);
    if (effect === null) {
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY,
          message:
            "an effect intention carries its id, ordinal, kind, scope, step key and the " +
            "three digests of execution §6; this payload does not constitute one",
        },
      ]);
    }

    // The two LocalKeys, by the grammar of §6.1 `:275`. Ordinal comparison and
    // no glob: `"A"` and `"a"` are two different steps, on purpose.
    for (const [path, value] of [
      ["semanticScopeKey", effect.semanticScopeKey],
      ["localOperationKey", effect.localOperationKey],
    ] as const) {
      if (!LOCAL_KEY_PATTERN.test(value)) {
        throw new LedgerValidationError([
          {
            path: "payload." + EFFECT_KEY + "." + path,
            message:
              "a LocalKey is an alphanumeric first character then up to 127 of " +
              "[A-Za-z0-9._-], compared ordinally; this one is not",
          },
        ]);
      }
    }
    if (!(SEMANTIC_SCOPE_KEYS as readonly string[]).includes(effect.semanticScopeKey)) {
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY + ".semanticScopeKey",
          message:
            "P-18 admits the semantic scopes " +
            SEMANTIC_SCOPE_KEYS.join(", ") +
            " and this effect names " +
            safeRowIdentifier(effect.semanticScopeKey),
        },
      ]);
    }

    // The kind and the exact request contract version for it. Execution §6
    // `:248`: never an implicit or unknown version.
    if (!(EXECUTION_EFFECT_KINDS as readonly string[]).includes(effect.effectKind)) {
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY + ".effectKind",
          message:
            "this build serves the effect kinds " +
            EXECUTION_EFFECT_KINDS.join(", ") +
            " and this effect names " +
            safeRowIdentifier(effect.effectKind),
        },
      ]);
    }
    const kind = effect.effectKind as ExecutionEffectKind;
    if (!EXECUTION_REQUEST_CONTRACT_VERSIONS[kind].includes(effect.requestContractVersion)) {
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY + ".requestContractVersion",
          message:
            "effect kind " +
            kind +
            " defines the request contract versions " +
            EXECUTION_REQUEST_CONTRACT_VERSIONS[kind].join(", ") +
            " and this effect names " +
            safeRowIdentifier(effect.requestContractVersion),
        },
      ]);
    }
    if (!SHA256_PATTERN.test(effect.requestSha256)) {
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY + ".requestSha256",
          message:
            "the request digest is a lowercase sha-256 hex string; it is recorded rather " +
            "than recomputed, because its preimage carries the business request and a " +
            "business request does not enter a ledger event",
        },
      ]);
    }

    // The revision, which is the source of `envelope_sha256`. The attempt's own
    // foreign key guarantees it exists, so a missing row here would be a
    // corrupted base rather than an out-of-order event.
    const revision = this.#stmt(
      "SELECT envelope_sha256 FROM task_revision_read_model " +
        "WHERE task_id = ? AND revision_number = ?",
    ).get(effect.taskId, effect.revisionNumber) as
      | { readonly envelope_sha256: string }
      | undefined;
    if (revision === undefined) {
      throw new LedgerIntegrityError([
        "task_attempt_read_model holds attempt " +
          taskAttemptKey(effect.taskId, effect.revisionNumber, effect.attemptNumber) +
          " whose revision row is missing",
      ]);
    }

    // The logical digest, recomputed from the run this ledger recorded.
    const expectedLogical = logicalOperationSha256({
      invocationId: attempt.invocation_id,
      semanticScopeKey: effect.semanticScopeKey,
      localOperationKey: effect.localOperationKey,
    });
    if (effect.logicalOperationSha256 !== expectedLogical) {
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY + ".logicalOperationSha256",
          message:
            "the logical operation digest is computed over this attempt's invocation, the " +
            "scope and the step key; this ledger computes " +
            expectedLogical +
            " and the event states " +
            safeRowIdentifier(effect.logicalOperationSha256),
        },
      ]);
    }

    // The ordinal, assigned rather than accepted: one past this attempt's
    // highest, and 0 where there is none, because `ck_…__operation_ordinal`
    // admits zero. `MAX` over the attempt and not over the segment — an effect
    // is a step of the run, and a handoff does not restart the count.
    const highest = this.#stmt(
      "SELECT MAX(operation_ordinal) AS highest FROM effect_read_model " +
        "WHERE task_id = ? AND revision_number = ? AND attempt_number = ?",
    ).get(effect.taskId, effect.revisionNumber, effect.attemptNumber) as {
      readonly highest: number | null;
    };
    const expectedOrdinal = highest.highest === null ? 0 : highest.highest + 1;
    if (effect.operationOrdinal !== expectedOrdinal) {
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY + ".operationOrdinal",
          message:
            "attempt " +
            taskAttemptKey(effect.taskId, effect.revisionNumber, effect.attemptNumber) +
            " assigns the operation ordinal " +
            String(expectedOrdinal) +
            ", which is one past its highest, and this event proposes " +
            String(effect.operationOrdinal),
        },
      ]);
    }

    // The two derived keys, recomputed from the coordinate and the sources.
    const identity = {
      taskId: effect.taskId,
      revisionNumber: effect.revisionNumber,
      attemptNumber: effect.attemptNumber,
      segmentNumber: segment.segmentNumber,
      operationOrdinal: effect.operationOrdinal,
    };
    const expectedId = effectIdV1(identity);
    if (effect.effectId !== expectedId) {
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY + ".effectId",
          message:
            "the effect id is the digest of its coordinate under the versioned prefix; " +
            "this ledger computes " +
            expectedId +
            " and the event states " +
            safeRowIdentifier(effect.effectId),
        },
      ]);
    }
    const expectedKey = effectIdempotencyKeyV1({
      ...identity,
      effectKind: effect.effectKind,
      envelopeSha256: revision.envelope_sha256,
    });
    if (effect.idempotencyKey !== expectedKey) {
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY + ".idempotencyKey",
          message:
            "the effect idempotency key is the digest of its kind, its coordinate and the " +
            "revision's envelope; this ledger computes " +
            expectedKey +
            " and the event states " +
            safeRowIdentifier(effect.idempotencyKey),
        },
      ]);
    }

    // §6.1 point 1, from the write side. A logical key that already belongs to
    // an effect is not a second intention: the producer is supposed to have
    // looked it up and reused what it found. Two refusals rather than one,
    // because "the same work again" and "different work under one key" are
    // different mistakes — the first is a missing lookup, the second is a
    // CONFLICT and the producer must never resolve it by changing the key.
    //
    // The idempotency key is NOT compared. It carries the segment number and
    // the operation ordinal, and the ordinal CAS above makes every second
    // intention propose a new ordinal, so the key differs on every retry and
    // comparing it would report the honest repetition as a CONFLICT. The
    // envelope is not compared on its own either: it is in the preimage of
    // `request_sha256`, and a logical key found here was computed over this
    // attempt's invocation, which `ux_task_attempt_read_model__invocation_id`
    // binds to one attempt and so to one revision — a comparison against
    // `task_revision_read_model.envelope_sha256` could never come out unequal.
    const held = this.#stmt(
      "SELECT * FROM effect_read_model WHERE logical_operation_sha256 = ?",
    ).get(effect.logicalOperationSha256) as EffectRow | undefined;
    if (held !== undefined) {
      const stored = effectRowToModel(held);
      const differs =
        stored.effectKind !== effect.effectKind ||
        stored.requestContractVersion !== effect.requestContractVersion ||
        stored.requestSha256 !== effect.requestSha256;
      throw new LedgerValidationError([
        {
          path: "payload." + EFFECT_KEY + ".logicalOperationSha256",
          message: differs
            ? "CONFLICT: logical operation " +
              effect.logicalOperationSha256 +
              " is already effect " +
              stored.effectId +
              " with a different kind, request contract version or request digest (whose " +
              "preimage carries the envelope); one logical key names one operation and a " +
              "producer never changes the key to make a conflict into new work"
            : "logical operation " +
              effect.logicalOperationSha256 +
              " is already effect " +
              stored.effectId +
              "; repeating the scope and step key returns that effect rather than " +
              "intending another, and an uncertain outcome demands reconciliation",
        },
      ]);
    }
  }

  /**
   * A delivery's intention: the effect it serves, the segment it runs on, and
   * the ordinal compare-and-set within the effect.
   */
  #assertDispatchIntention(
    event: ControlPlaneEvent,
    segment: ExecutionRouteSegmentReadModel,
    revisionNumber: number,
    attemptNumber: number,
  ): void {
    // The price pin's grammar first (ADR 0103): a present-invalid key, half a pair,
    // a pin on the cohort before or none on the cohort after is refused in the
    // reader's words, never read as a delivery that says nothing about its price.
    const pinReading = dispatchPinReading(event);
    if (pinReading?.kind === "refused") {
      throw new LedgerValidationError([{ path: pinReading.path, message: pinReading.message }]);
    }
    const dispatch = nextDispatchAttemptProjection(event, 0);
    if (dispatch === null) {
      throw new LedgerValidationError([
        {
          path: "payload." + DISPATCH_KEY,
          message:
            "a dispatch intention carries its id, the effect it delivers and its ordinal " +
            "within that effect; this payload does not constitute one",
        },
      ]);
    }

    const held = this.#stmt(
      "SELECT * FROM dispatch_attempt_read_model WHERE dispatch_attempt_id = ?",
    ).get(dispatch.dispatchAttemptId) as DispatchAttemptRow | undefined;
    if (held !== undefined) {
      if (
        canonicalDispatchBirth(dispatchAttemptRowToModel(held)) !==
        canonicalDispatchBirth(dispatch)
      ) {
        throw new LedgerValidationError([
          {
            path: "payload." + DISPATCH_KEY + ".dispatchAttemptId",
            message:
              "delivery " +
              safeRowIdentifier(dispatch.dispatchAttemptId) +
              " is already recorded with different content, and a delivery is intended once",
          },
        ]);
      }
      return;
    }

    const effectRow = this.#stmt("SELECT * FROM effect_read_model WHERE effect_id = ?").get(
      dispatch.effectId,
    ) as EffectRow | undefined;
    if (effectRow === undefined) {
      throw new LedgerValidationError([
        {
          path: "payload." + DISPATCH_KEY + ".effectId",
          message:
            "a delivery serves an effect, and effect " +
            safeRowIdentifier(dispatch.effectId) +
            " has not been intended",
        },
      ]);
    }

    // **The rule this whole packet exists for** (execution §6.1 `:315-317`).
    // An uncertain exposure blocks resending, and nothing a caller can pass in
    // lifts it — a green preflight at the destination is a statement about the
    // destination, not about whether the earlier delivery landed. Reconciliation
    // is the way out; another dispatch is not.
    if (effectRow.outcome_status === "OUTCOME_UNKNOWN") {
      throw new LedgerValidationError([
        {
          path: "payload." + DISPATCH_KEY + ".effectId",
          message:
            "effect " +
            effectRow.effect_id +
            " ended OUTCOME_UNKNOWN, and an uncertain exposure blocks resending even where " +
            "the destination reports itself clean; reconcile by handle or postcondition " +
            "rather than dispatching again",
        },
      ]);
    }

    // And the other half of the same sentence (execution §6.1 `:304-305`, CORR-2):
    // "un desenlace terminal se reutiliza". An effect that already ended
    // SUCCEEDED, FAILED or CANCELLED has an answer, and the answer is what a
    // repeated step gets back — `lookUpEffect` already says so, with
    // `reconciliationRequired: false`. Another delivery of it is not a genuinely
    // new one (`:310-311`); a genuinely new operation intends a new effect. No
    // exception for FAILED or CANCELLED: retrying one is an owner's written
    // decision, not a default. The guard reads the effect's outcome and not the
    // deliveries' states, so an ABANDONED delivery with no outcome recorded, or a
    // SETTLED one that reported none, still admits the next. Door-only, on O-1's
    // precedent below: every stored delivery passed this check when it was
    // written, and the fold does not change.
    if (effectRow.outcome_status !== null) {
      throw new LedgerValidationError([
        {
          path: "payload." + DISPATCH_KEY + ".effectId",
          message:
            "effect " +
            effectRow.effect_id +
            " already ended " +
            effectRow.outcome_status +
            " at " +
            String(effectRow.outcome_recorded_at) +
            "; a known outcome is reused, never redelivered (execution §6.1), and a genuinely " +
            "new operation intends a new effect",
        },
      ]);
    }

    // And the same rule in its live form (postaudit of C, O-1; adjudicated to
    // F). A delivery still outstanding — `INTENDED`, `CLAIMED` or `INFLIGHT` — is
    // exactly the uncertainty `OUTCOME_UNKNOWN` names once it is recorded: it may
    // have reached the destination and nobody knows yet. "Habilita
    // reconciliación, no reintento" is only a rule if a second delivery cannot be
    // intended beside it. Door-only, on `operation_ordinal`'s precedent: every
    // stored delivery passed this check when it was written.
    const outstanding = this.#stmt(
      "SELECT COUNT(*) AS n FROM dispatch_attempt_read_model " +
        "WHERE effect_id = ? AND dispatch_state NOT IN ('SETTLED', 'ABANDONED')",
    ).get(effectRow.effect_id) as { readonly n: number };
    if (outstanding.n > 0) {
      throw new LedgerValidationError([
        {
          path: "payload." + DISPATCH_KEY + ".effectId",
          message:
            "effect " +
            effectRow.effect_id +
            " still has " +
            String(outstanding.n) +
            " delivery outstanding, and a new delivery needs every earlier one SETTLED or " +
            "ABANDONED; an outstanding delivery is reconciled, never resent beside",
        },
      ]);
    }

    // The segment is this delivery's **effective** one and may differ from the
    // effect's initial segment — that is what a handoff is. What it may not do
    // is belong to another attempt, which §7 `:355` states and the check above
    // has already established for the event's own coordinate.
    if (
      effectRow.task_id !== event.taskId ||
      effectRow.revision_number !== revisionNumber ||
      effectRow.attempt_number !== attemptNumber
    ) {
      throw new LedgerValidationError([
        {
          path: "payload." + DISPATCH_KEY + ".effectId",
          message:
            "effect " +
            effectRow.effect_id +
            " belongs to attempt " +
            taskAttemptKey(
              effectRow.task_id,
              effectRow.revision_number,
              effectRow.attempt_number,
            ) +
            " and this delivery runs on segment " +
            safeRowIdentifier(segment.routeSegmentId) +
            " of attempt " +
            taskAttemptKey(event.taskId, revisionNumber, attemptNumber),
        },
      ]);
    }

    const highest = this.#stmt(
      "SELECT MAX(attempt_ordinal) AS highest FROM dispatch_attempt_read_model WHERE effect_id = ?",
    ).get(dispatch.effectId) as { readonly highest: number | null };
    const expectedOrdinal = (highest.highest ?? 0) + 1;
    if (dispatch.attemptOrdinal !== expectedOrdinal) {
      throw new LedgerValidationError([
        {
          path: "payload." + DISPATCH_KEY + ".attemptOrdinal",
          message:
            "effect " +
            effectRow.effect_id +
            " assigns the delivery ordinal " +
            String(expectedOrdinal) +
            ", which is one past its highest, and this event proposes " +
            String(dispatch.attemptOrdinal),
        },
      ]);
    }

    // The pin names what this delivery will be valued against, and it is checked
    // here, before the delivery exists and so before any provider is asked
    // (ADR 0103; adjudication v2 C3). Door only, on the result reference's
    // precedent: the registry is another stream, and a rebuild folds one at a time.
    if (dispatch.catalogDocumentId !== null && dispatch.catalogVersion !== null) {
      this.#assertCatalogPin(
        { catalogDocumentId: dispatch.catalogDocumentId, catalogVersion: dispatch.catalogVersion },
        segment,
        event.occurredAt,
      );
    }
  }

  /**
   * A dispatch's price pin, against the registry (P-15 escalón C, ADR 0103).
   *
   * Three questions, in order, each refused by name with the instant and never with
   * a price, a zero or an estimate:
   *
   * - **(a)** the pin names a published `PRICE_TABLE` version of that document;
   * - **(b)** it is the version **in force** at the dispatch instant — the one with the
   *   greatest `effectiveFrom` at or before it (`selectVigentCatalogVersion`); none in
   *   force, or two sharing that instant, is refused rather than resolved;
   * - **(c)** it **covers** the segment: an interval of that version names the
   *   segment's provider, model version and transport kind, and holds the instant
   *   (`pinCovers`). A segment whose model version is not resolved is never covered.
   */
  #assertCatalogPin(
    pin: PricePin,
    segment: ExecutionRouteSegmentReadModel,
    instant: string,
  ): void {
    // The instant first, before anything is selected (ADR 0103, ADR 0092's inherited
    // obligation). The selector compares instants as text, which is time order only
    // for the contract's one canonical form — ISO-8601 with milliseconds, in UTC, `Z`.
    // The event's `occurredAt` is a contract Timestamp that admits offsets, so an
    // instant in another spelling would be compared out of order and pick the wrong
    // version: it is refused here, never normalized and never selected over.
    if (!isInstant(instant)) {
      throw new LedgerValidationError([
        {
          path: "occurredAt",
          message:
            "a dispatch from 2.9.0 is priced at its instant, which must be the contract's canonical form " +
            "(ISO-8601 with milliseconds, in UTC, ending in Z); this event's is not, and no catalog version is " +
            "selected over an instant in any other spelling",
        },
      ]);
    }
    const at = (key: string): string => "payload." + DISPATCH_KEY + "." + key;
    const versions = this.#catalogVersions(pin.catalogDocumentId);
    if (versions.length === 0) {
      throw new LedgerValidationError([
        {
          path: at("catalogDocumentId"),
          message:
            "the price pin names catalog document " +
            safeRowIdentifier(pin.catalogDocumentId) +
            ", which the registry does not hold as a published PRICE_TABLE",
        },
      ]);
    }
    if (!versions.some((version) => version.catalogVersion === pin.catalogVersion)) {
      throw new LedgerValidationError([
        {
          path: at("catalogVersion"),
          message:
            "the price pin names version " +
            String(pin.catalogVersion) +
            " of catalog document " +
            safeRowIdentifier(pin.catalogDocumentId) +
            ", which was never published",
        },
      ]);
    }
    const selection = selectVigentCatalogVersion(versions, instant);
    if (selection.kind === "NONE") {
      throw new LedgerValidationError([
        {
          path: at("catalogVersion"),
          message:
            "no version of catalog document " +
            safeRowIdentifier(pin.catalogDocumentId) +
            " is in force at " +
            instant +
            ": every published version takes effect later, and a delivery is priced by the version in force",
        },
      ]);
    }
    if (selection.kind === "AMBIGUOUS") {
      throw new LedgerValidationError([
        {
          path: at("catalogVersion"),
          message:
            "catalog document " +
            safeRowIdentifier(pin.catalogDocumentId) +
            " has versions " +
            selection.catalogVersions.join(", ") +
            " taking effect at the same instant " +
            selection.effectiveFrom +
            ", so none is in force at " +
            instant +
            "; an ambiguous pin is refused, never resolved by picking one",
        },
      ]);
    }
    if (selection.catalogVersion !== pin.catalogVersion) {
      throw new LedgerValidationError([
        {
          path: at("catalogVersion"),
          message:
            "the price pin names version " +
            String(pin.catalogVersion) +
            " of catalog document " +
            safeRowIdentifier(pin.catalogDocumentId) +
            ", and the version in force at " +
            instant +
            " is " +
            String(selection.catalogVersion) +
            " (effective from " +
            selection.effectiveFrom +
            ")",
        },
      ]);
    }
    const intervals = (
      this.#stmt(
        "SELECT * FROM price_interval_read_model WHERE catalog_document_id = ? AND catalog_version = ?",
      ).all(pin.catalogDocumentId, pin.catalogVersion) as PriceIntervalRow[]
    ).map(priceIntervalRowToModel);
    const key = {
      provider: segment.provider,
      modelVersionId: segment.modelVersionId,
      transportKind: segment.transportKind,
    };
    if (!pinCovers(intervals, pin, key, instant)) {
      throw new LedgerValidationError([
        {
          path: at("catalogVersion"),
          message:
            segment.modelVersionId === null
              ? "the delivery's segment names no resolved model version, and a price is never aliased " +
                "from another model: no catalog version covers it, so it cannot be dispatched before spend"
              : "version " +
                String(pin.catalogVersion) +
                " of catalog document " +
                safeRowIdentifier(pin.catalogDocumentId) +
                " prices no interval of provider " +
                safeRowIdentifier(segment.provider) +
                ", model version " +
                safeRowIdentifier(segment.modelVersionId) +
                " and transport " +
                safeRowIdentifier(segment.transportKind) +
                " in force at " +
                instant,
        },
      ]);
    }
  }

  /** Every published version of one `PRICE_TABLE` document, as the vigente rule reads it. */
  #catalogVersions(catalogDocumentId: string): readonly CatalogVersionFact[] {
    return (
      this.#stmt(
        "SELECT document_version, effective_from FROM registry_events " +
          "WHERE document_id = ? AND document_kind = 'PRICE_TABLE' ORDER BY effective_from, document_version",
      ).all(catalogDocumentId) as { readonly document_version: number; readonly effective_from: string }[]
    ).map((row) => ({ catalogVersion: row.document_version, effectiveFrom: row.effective_from }));
  }

  /**
   * A delivery's resolution: the row it reports on, the move it makes, and the
   * effect outcome it may carry.
   *
   * The transitions are `DISPATCH_STATE_TRANSITIONS`' and the five states are
   * closed at five. An overdue `INFLIGHT` is not moved by anything here:
   * `listOverdueDispatchAttempts` finds it and a human or a later packet
   * reconciles it, which is what "habilita reconciliación, no reintento" means.
   *
   * A delivery is found by `dispatch_attempt_id`, which is a global key, so the
   * row alone does not tie the resolution to anything the event says. The
   * effect the delivery serves does: it carries the attempt that owns it, and
   * a resolution recorded at any other coordinate is refused before a single
   * column moves. `applyEventToSnapshot` holds the same anchor, so a rebuild
   * cannot reproduce what this door refuses.
   */
  #assertDispatchOutcome(
    event: ControlPlaneEvent,
    revisionNumber: number,
    attemptNumber: number,
  ): void {
    const reading = dispatchOutcomeRecord(event, 0);
    if (reading === null) {
      throw new LedgerValidationError([
        {
          path: "payload." + OUTCOME_KEY,
          message:
            "a dispatch resolution carries the delivery it reports on, one of the five " +
            "states of execution §7, and a terminal instant if and only if that state is " +
            "SETTLED or ABANDONED; this payload does not constitute one",
        },
      ]);
    }
    // A present-invalid optional field, named by the reader (CORR-2). The fold
    // throws the same issue, so a rebuild refuses this history in these words.
    if (reading.kind === "refused") {
      throw new LedgerValidationError([{ path: reading.path, message: reading.message }]);
    }
    const outcome = reading.record;

    const row = this.#stmt(
      "SELECT * FROM dispatch_attempt_read_model WHERE dispatch_attempt_id = ?",
    ).get(outcome.dispatchAttemptId) as DispatchAttemptRow | undefined;
    if (row === undefined) {
      throw new LedgerValidationError([
        {
          path: "payload." + OUTCOME_KEY + ".dispatchAttemptId",
          message:
            "a resolution reports on a delivery that exists, and " +
            safeRowIdentifier(outcome.dispatchAttemptId) +
            " has not been intended",
        },
      ]);
    }

    const effectRow = this.#stmt("SELECT * FROM effect_read_model WHERE effect_id = ?").get(
      row.effect_id,
    ) as EffectRow | undefined;
    if (effectRow === undefined) {
      throw new LedgerIntegrityError([
        "dispatch_attempt_read_model holds delivery " +
          row.dispatch_attempt_id +
          " whose effect row is missing",
      ]);
    }

    // The resolution belongs to the attempt that owns the delivery's effect. A
    // delivery is not a place another task, revision or attempt may report to.
    if (
      effectRow.task_id !== event.taskId ||
      effectRow.revision_number !== revisionNumber ||
      effectRow.attempt_number !== attemptNumber
    ) {
      throw new LedgerValidationError([
        {
          path: "payload." + OUTCOME_KEY + ".dispatchAttemptId",
          message:
            "delivery " +
            row.dispatch_attempt_id +
            " serves effect " +
            effectRow.effect_id +
            " of attempt " +
            taskAttemptKey(
              effectRow.task_id,
              effectRow.revision_number,
              effectRow.attempt_number,
            ) +
            " and this resolution is recorded at attempt " +
            taskAttemptKey(event.taskId, revisionNumber, attemptNumber),
        },
      ]);
    }

    const current = row.dispatch_state as DispatchState;
    if (current !== outcome.dispatchState && !dispatchTransitionAdmitted(current, outcome.dispatchState)) {
      throw new LedgerValidationError([
        {
          path: "payload." + OUTCOME_KEY + ".dispatchState",
          message:
            "delivery " +
            row.dispatch_attempt_id +
            " is " +
            current +
            " and may move only to " +
            (DISPATCH_STATE_TRANSITIONS[current].join(", ") || "nothing"),
        },
      ]);
    }

    if (outcome.effectOutcomeStatus === null) return;

    // A result pair names a published artifact, checked here on every arrival,
    // replay included (ADR 0098; 0084 Four's "one path is simpler than two").
    if (outcome.resultArtifactReferenceId !== null && outcome.resultSha256 !== null) {
      this.#assertResultReference(event.taskId, outcome.resultArtifactReferenceId, outcome.resultSha256);
    }

    // The fold's own comparison, result pair included, so a rebuild refuses the
    // histories this door refuses in these words (ADR 0084 Five, ADR 0098).
    const arrival = effectOutcomeArrival(effectRowToModel(effectRow), outcome);
    if (arrival.kind === "refused") {
      throw new LedgerValidationError([{ path: arrival.path, message: arrival.message }]);
    }
  }

  /**
   * Refuse a result pair whose reference the registry does not hold as this
   * task's published `RESPONSE`, or whose digest is not that artifact's (P-07
   * escalón B, ADR 0098; datos §11 step 7: published before referenced).
   *
   * `#assertEnvelopeReference`'s reasons, for the result: a reference row exists
   * only once a publication succeeded or a reference was recorded, so an intended
   * or abandoned publication is refused here; the question is about a projection
   * of the registry stream, so it is asked at the door and never by a trigger a
   * rebuild would have to satisfy in fold order. The digest is conserved, never
   * recomputed. No refusal echoes the producer's text.
   *
   * Not checked, declared: retention, tombstone and blob lifecycle — nothing in
   * this build tombstones a reference or reclaims a blob.
   */
  #assertResultReference(taskId: string, referenceId: string, resultSha256: string): void {
    const at = "payload." + OUTCOME_KEY + ".";
    const reference = this.#stmt(
      "SELECT artifact_class, content_sha256, scope_kind, scope_id FROM artifact_reference_read_model " +
        "WHERE artifact_reference_id = ?",
    ).get(referenceId) as
      | {
          readonly artifact_class: string;
          readonly content_sha256: string;
          readonly scope_kind: string;
          readonly scope_id: string | null;
        }
      | undefined;
    if (reference === undefined) {
      throw new LedgerValidationError([
        {
          path: at + RESULT_ARTIFACT_REFERENCE_KEY,
          message:
            "task " +
            taskId +
            " names its result by an artifact reference the registry does not hold; a result is published" +
            " before it is referenced (datos §11 step 7)",
        },
      ]);
    }
    if (reference.artifact_class !== "RESPONSE") {
      throw new LedgerValidationError([
        {
          path: at + RESULT_ARTIFACT_REFERENCE_KEY,
          message:
            "task " +
            taskId +
            " names a result by an artifact reference of class " +
            reference.artifact_class +
            "; an effect's result is a RESPONSE",
        },
      ]);
    }
    if (reference.scope_kind !== "TASK" || reference.scope_id !== taskId) {
      throw new LedgerValidationError([
        {
          path: at + RESULT_ARTIFACT_REFERENCE_KEY,
          message:
            "task " +
            taskId +
            " names a result by an artifact reference scoped to " +
            (reference.scope_kind === "TASK" ? "another task" : reference.scope_kind) +
            "; an effect's result belongs to the task that ran it",
        },
      ]);
    }
    if (reference.content_sha256 !== resultSha256) {
      throw new LedgerValidationError([
        {
          path: at + RESULT_SHA256_KEY,
          message:
            "task " +
            taskId +
            " names a result digest other than the bytes its reference holds; the digest is conserved," +
            " never recomputed",
        },
      ]);
    }
  }

  /**
   * A prompt or an answer, checked under the write lock this transaction
   * already holds (P-18/protocolo D, execution §8).
   *
   * **The refusals are the fold's, read against the base.** What one event can
   * be wrong about — a closed payload, a field's grammar, the §4 pair — is
   * `readPromptOccurrence`'s and `readResponseOccurrence`'s; what a link can be
   * wrong about is `promptOccurrenceLinkRefusal`'s and
   * `responseOccurrenceLinkRefusal`'s. This method supplies the rows those
   * functions ask about, so the door and a rebuild refuse the same histories
   * with the same words.
   *
   * **Nothing here is recomputed from bytes, because no bytes are here.** The
   * prompt, context and response digests are conserved: their preimages are
   * exactly what §8 `:433` keeps out. What the ledger does verify is everything
   * it has a source for — the delivery, the effect and segment it serves, the
   * attempt that owns it, and the ordinal.
   */
  #assertExecutionOccurrence(event: ControlPlaneEvent): void {
    const prompt = readPromptOccurrence(event, 0);
    if (prompt !== null) {
      if (prompt.kind === "refused") {
        throw new LedgerValidationError([{ path: prompt.path, message: prompt.message }]);
      }
      this.#assertPromptOccurrence(event, prompt.row);
      return;
    }

    const response = readResponseOccurrence(event, 0);
    if (response !== null) {
      if (response.kind === "refused") {
        throw new LedgerValidationError([{ path: response.path, message: response.message }]);
      }
      this.#assertResponseOccurrence(event, response.row);
    }
  }

  /**
   * A prompt: its delivery, the delivery's effect and segment, the owning
   * attempt, and the ordinal compare-and-set within the segment.
   */
  #assertPromptOccurrence(event: ControlPlaneEvent, prompt: PromptOccurrenceReadModel): void {
    const delivery = this.#stmt(
      "SELECT effect_id, route_segment_id FROM dispatch_attempt_read_model " +
        "WHERE dispatch_attempt_id = ?",
    ).get(prompt.dispatchAttemptId) as
      | { readonly effect_id: string; readonly route_segment_id: string }
      | undefined;
    const owner =
      delivery === undefined ? undefined : this.#effectOwner(delivery.effect_id);

    const refusal = promptOccurrenceLinkRefusal(
      event,
      prompt,
      delivery === undefined
        ? null
        : { effectId: delivery.effect_id, routeSegmentId: delivery.route_segment_id },
      owner ?? null,
    );
    if (refusal !== null) throw new LedgerValidationError([refusal]);

    const held = this.#stmt(
      "SELECT * FROM prompt_occurrence_read_model WHERE occurrence_id = ?",
    ).get(prompt.occurrenceId) as PromptOccurrenceRow | undefined;
    if (held !== undefined) {
      if (canonicalPromptOccurrence(promptOccurrenceRowToModel(held)) !== canonicalPromptOccurrence(prompt)) {
        throw new LedgerValidationError([
          {
            path: "payload." + PROMPT_OCCURRENCE_KEY + ".occurrenceId",
            message:
              "prompt occurrence " +
              safeRowIdentifier(prompt.occurrenceId) +
              " is already recorded with different content, and an occurrence is recorded once",
          },
        ]);
      }
      return;
    }

    // The ordinal, assigned rather than accepted: one past the segment's
    // highest, and 0 where there is none, because `ck_…__ordinal` admits zero.
    // Over the **segment**, as §8 `:389` says — "orden dentro del segmento" —
    // and so a handoff does restart it, unlike an effect's operation ordinal.
    // §8's index on `(route_segment_id, ordinal)` is not unique and that is not
    // evidence against this rule: an ordinal nobody verifies orders nothing.
    const highest = this.#stmt(
      "SELECT MAX(ordinal) AS highest FROM prompt_occurrence_read_model WHERE route_segment_id = ?",
    ).get(prompt.routeSegmentId) as { readonly highest: number | null };
    const expected = highest.highest === null ? 0 : highest.highest + 1;
    if (prompt.ordinal !== expected) {
      throw new LedgerValidationError([
        {
          path: "payload." + PROMPT_OCCURRENCE_KEY + ".ordinal",
          message:
            "segment " +
            safeRowIdentifier(prompt.routeSegmentId) +
            " assigns the prompt ordinal " +
            String(expected) +
            ", which is one past its highest, and this event proposes " +
            String(prompt.ordinal),
        },
      ]);
    }
  }

  /** An answer: the prompt it answers, that prompt's attempt, and one answer each. */
  #assertResponseOccurrence(
    event: ControlPlaneEvent,
    response: ResponseOccurrenceReadModel,
  ): void {
    const answered = this.#stmt(
      "SELECT effect_id FROM prompt_occurrence_read_model WHERE occurrence_id = ?",
    ).get(response.promptOccurrenceId) as { readonly effect_id: string } | undefined;
    const holder = this.#stmt(
      "SELECT occurrence_id FROM response_occurrence_read_model WHERE prompt_occurrence_id = ?",
    ).get(response.promptOccurrenceId) as { readonly occurrence_id: string } | undefined;

    const refusal = responseOccurrenceLinkRefusal(
      event,
      response,
      answered !== undefined,
      answered === undefined ? null : (this.#effectOwner(answered.effect_id) ?? null),
      holder === undefined || holder.occurrence_id === response.occurrenceId
        ? null
        : holder.occurrence_id,
    );
    if (refusal !== null) throw new LedgerValidationError([refusal]);

    const held = this.#stmt(
      "SELECT * FROM response_occurrence_read_model WHERE occurrence_id = ?",
    ).get(response.occurrenceId) as ResponseOccurrenceRow | undefined;
    if (
      held !== undefined &&
      canonicalResponseOccurrence(responseOccurrenceRowToModel(held)) !==
        canonicalResponseOccurrence(response)
    ) {
      throw new LedgerValidationError([
        {
          path: "payload." + RESPONSE_OCCURRENCE_KEY + ".occurrenceId",
          message:
            "response occurrence " +
            safeRowIdentifier(response.occurrenceId) +
            " is already recorded with different content, and an occurrence is recorded once",
        },
      ]);
    }
  }

  /** The attempt coordinate that owns one effect, or `undefined`. */
  #effectOwner(
    effectId: string,
  ): { readonly taskId: string; readonly revisionNumber: number; readonly attemptNumber: number } | undefined {
    const row = this.#stmt(
      "SELECT task_id, revision_number, attempt_number FROM effect_read_model WHERE effect_id = ?",
    ).get(effectId) as
      | { readonly task_id: string; readonly revision_number: number; readonly attempt_number: number }
      | undefined;
    return row === undefined
      ? undefined
      : { taskId: row.task_id, revisionNumber: row.revision_number, attemptNumber: row.attempt_number };
  }

  /**
   * An outbox command, one delivery attempt of it, or what was observed about
   * that attempt — checked under the write lock this transaction already holds
   * (P-18/protocolo F, coordination §6.2).
   *
   * **The refusals are the fold's, read against the base.** What one event can
   * be wrong about — the closed payload, the V1 matrix, the recomputed
   * `commandId`, the failure vocabulary — is `readOutboxEvent`'s; what a link can
   * be wrong about is `outboxLinkRefusal`'s. This method supplies the command and
   * the attempt those functions ask about, by folding the command's own history
   * off the stream, so the door and a rebuild refuse the same histories with the
   * same words.
   *
   * **No table.** The command's state is not stored anywhere in this ledger: it is
   * a fold of at most one intention, its attempts and their observations, read
   * through `control_plane_events_by_type`. Datos §11 `:548-550` is why — the
   * separate outbox is a cache of these events, and a second copy of their fold
   * inside the ledger would be one more thing a rebuild had to agree with.
   */
  #assertOutboxEvent(
    event: ControlPlaneEvent,
    causation: CausationRef | null,
    predecessor: OutboxPredecessor | null,
  ): void {
    const reading = readOutboxEvent(event);
    if (reading === null) return;
    if (reading.kind === "refused") {
      throw new LedgerValidationError([{ path: reading.path, message: reading.message }]);
    }

    const history = this.#outboxCommandHistory(reading.row.commandId);
    let attempt: OutboxAttemptRecord | null = null;
    if (reading.kind !== "intention") {
      attempt =
        history.attempts.get(reading.row.deliveryAttemptId) ??
        this.#outboxAttemptElsewhere(reading.row.deliveryAttemptId);
    }

    const refusal = outboxLinkRefusal(
      { event, causation },
      reading,
      history.command,
      attempt,
      predecessor,
    );
    if (refusal !== null) throw new LedgerValidationError([refusal]);
  }

  /**
   * One command's history, folded: its intention, its attempts and their
   * observations, in stream order.
   *
   * Every row read here passed this door when it was written, so it is folded
   * with the reduce alone. A stored row that no longer reads as an outbox event
   * is not a history this door wrote, and is refused as corruption rather than
   * skipped.
   */
  #outboxCommandHistory(commandId: string): {
    readonly command: OutboxCommandReadModel | null;
    readonly attempts: ReadonlyMap<string, OutboxAttemptRecord>;
  } {
    const rows = this.#stmt(
      "SELECT sequence, event_json, event_sha256 FROM control_plane_events " +
        "WHERE type IN (?, ?, ?) AND json_extract(event_json, '$.payload.commandId') = ? " +
        "ORDER BY sequence",
    ).all(...OUTBOX_EVENT_TYPES, commandId) as {
      readonly sequence: number;
      readonly event_json: string;
      readonly event_sha256: string;
    }[];

    let command: OutboxCommandReadModel | null = null;
    const attempts = new Map<string, OutboxAttemptRecord>();
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as ControlPlaneEvent;
      const reading = readOutboxEvent(event);
      if (reading === null || reading.kind === "refused") {
        throw new LedgerIntegrityError([
          "control_plane_events holds sequence " +
            String(row.sequence) +
            " naming command " +
            commandId +
            " that does not read as an outbox event",
        ]);
      }
      const attemptId = reading.kind === "intention" ? null : reading.row.deliveryAttemptId;
      const next = nextOutboxCommand(
        { event, sequence: row.sequence, sha256: row.event_sha256, causation: null },
        reading,
        command,
        attemptId === null ? null : (attempts.get(attemptId) ?? null),
      );
      command = next.command;
      if (next.attempt !== null) attempts.set(next.attempt.deliveryAttemptId, next.attempt);
    }
    return { command, attempts };
  }

  /** A delivery attempt recorded for some other command, or null. */
  #outboxAttemptElsewhere(deliveryAttemptId: string): OutboxAttemptRecord | null {
    const row = this.#stmt(
      "SELECT sequence, event_json, event_sha256 FROM control_plane_events " +
        "WHERE type = ? AND json_extract(event_json, '$.payload.deliveryAttemptId') = ? " +
        "ORDER BY sequence LIMIT 1",
    ).get("OUTBOX_DELIVERY_INTENDED", deliveryAttemptId) as
      | { readonly sequence: number; readonly event_json: string; readonly event_sha256: string }
      | undefined;
    if (row === undefined) return null;
    const event = JSON.parse(row.event_json) as ControlPlaneEvent;
    const commandId = event.payload["commandId"];
    return {
      deliveryAttemptId,
      commandId: typeof commandId === "string" ? commandId : "",
      sequence: row.sequence,
      sha256: row.event_sha256,
    };
  }

  /**
   * The batch's own shape: every quarantine move carries its intention to revoke.
   *
   * `inserted` is what this transaction actually wrote, with each event's
   * position among the candidates. A replay inside the batch is not in it, for
   * the reason a replay breaks the predecessor run: it committed elsewhere.
   */
  #assertQuarantineBatch(
    inserted: readonly { readonly index: number; readonly event: ControlPlaneEvent }[],
  ): void {
    for (const { index, event } of inserted) {
      if (event.type !== "TASK_STATE_CHANGED" || !isQuarantineEvent(event)) continue;
      const answered = inserted.some(
        (other) =>
          other.event.type === OUTBOX_COMMAND_INTENDED &&
          other.event.taskId === event.taskId &&
          other.event.payload["commandKind"] === "REVOKE_LEASE",
      );
      if (!answered) {
        throw new LedgerValidationError([
          {
            path: "candidates[" + String(index) + "]",
            message:
              "task " +
              event.taskId +
              " is quarantined in this batch with no REVOKE_LEASE intention of its own; inside " +
              "appendBatch the quarantine and the intention to revoke the lease commit together " +
              "or not at all",
          },
        ]);
      }
    }
  }

  /**
   * Every outbox command this stream folds to, in intention order — what a lost
   * cache would be rebuilt to (datos §11 `:566-570`).
   *
   * Read over the three outbox types only, through the type index, and folded
   * with the reduce alone: every stored row passed the door. The histories the
   * door refuses are refused again by `rebuildReadModel` and `verifyIntegrity`,
   * which fold the whole stream.
   */
  listOutboxCommands(): readonly OutboxCommandReadModel[] {
    this.#assertOpen("listOutboxCommands");
    const rows = this.#stmt(
      "SELECT sequence, event_json, event_sha256 FROM control_plane_events " +
        "WHERE type IN (?, ?, ?) ORDER BY sequence",
    ).all(...OUTBOX_EVENT_TYPES) as {
      readonly sequence: number;
      readonly event_json: string;
      readonly event_sha256: string;
    }[];
    const commands = new Map<string, OutboxCommandReadModel>();
    const attempts = new Map<string, OutboxAttemptRecord>();
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as ControlPlaneEvent;
      const reading = readOutboxEvent(event);
      if (reading === null || reading.kind === "refused") {
        throw new LedgerIntegrityError([
          "control_plane_events holds sequence " +
            String(row.sequence) +
            " that does not read as an outbox event",
        ]);
      }
      const attemptId = reading.kind === "intention" ? null : reading.row.deliveryAttemptId;
      const next = nextOutboxCommand(
        { event, sequence: row.sequence, sha256: row.event_sha256, causation: null },
        reading,
        commands.get(reading.row.commandId) ?? null,
        attemptId === null ? null : (attempts.get(attemptId) ?? null),
      );
      commands.set(reading.row.commandId, next.command);
      if (next.attempt !== null) attempts.set(next.attempt.deliveryAttemptId, next.attempt);
    }
    return [...commands.values()].sort((left, right) => left.intentSequence - right.intentSequence);
  }

  /** One outbox command, folded from its own events, or null. */
  getOutboxCommand(commandId: string): OutboxCommandReadModel | null {
    this.#assertOpen("getOutboxCommand");
    return this.#outboxCommandHistory(commandId).command;
  }

  /** Incremental projection. Same rules as replay, applied to one event. */
  #projectEvent(event: ControlPlaneEvent, sequence: number, sha256: string): void {
    const currentTask = this.#stmt(
      "SELECT * FROM task_read_model WHERE task_id = ?",
    ).get(event.taskId) as TaskRow | undefined;

    const nextTask = nextTaskProjection(
      currentTask === undefined ? null : taskRowToModel(currentTask),
      event,
      sequence,
    );
    this.#upsertTask(nextTask);

    const currentPair = this.#stmt(
      "SELECT identity, task_id, event_count, last_sequence FROM worker_task_read_model " +
        "WHERE identity = ? AND task_id = ?",
    ).get(event.emittedBy, event.taskId) as WorkerTaskRow | undefined;

    const currentWorker = this.#stmt(
      "SELECT * FROM worker_read_model WHERE identity = ?",
    ).get(event.emittedBy) as WorkerRow | undefined;

    const nextWorker = nextWorkerProjection(
      currentWorker === undefined ? null : workerRowToModel(currentWorker),
      event,
      sequence,
      currentPair === undefined,
    );
    // The worker row is the foreign key parent, so it is written first.
    this.#upsertWorker(nextWorker);

    const nextPair = nextWorkerTaskProjection(
      currentPair === undefined
        ? null
        : {
            identity: currentPair.identity,
            taskId: currentPair.task_id,
            eventCount: currentPair.event_count,
            lastSequence: currentPair.last_sequence,
          },
      event,
      sequence,
    );
    this.#upsertWorkerTask(nextPair);

    // The route row, when the event carries an admitted one. Same function as
    // the replay path uses, so the incremental projection and a rebuild cannot
    // come to disagree about which events produce a row.
    const route = nextExecutionRouteProjection(event, sequence);
    if (route !== null) this.#upsertExecutionRoute(route);

    // The revision record, when the payload constitutes one. Same function as
    // the replay path uses, for the same reason the route row is: the
    // incremental projection and a rebuild cannot come to disagree about which
    // events produce a row.
    const revision = nextTaskRevisionProjection(event, sequence);
    if (revision !== null) this.#insertTaskRevision(revision);

    // The client key, when the event is an intake (P-14 C). After the revision
    // row it reads the same record from; `applyEventToSnapshot` folds it in the
    // same place.
    const submission = nextTaskSubmissionProjection(event, sequence);
    if (submission !== null) this.#insertTaskSubmission(submission);

    // The attempt record, when this event opens one. After the revision, and
    // that order is the foreign key's: `foreign_keys` is ON, the opening
    // announces both, and the parent row has to be there before the child names
    // it. `applyEventToSnapshot` folds them in the same order for the same
    // reason.
    const attempt = nextTaskAttemptProjection(event, sequence);
    if (attempt !== null) this.#insertTaskAttempt(attempt);

    // The P-18/protocolo C cohort, parent-first for the attempt's reason: three
    // foreign keys point each of them at the one above, and
    // `applyEventToSnapshot` folds them in this order so a rebuild and this
    // path cannot come to disagree about which events produce which rows.
    const segment = nextExecutionRouteSegmentProjection(event, sequence);
    if (segment !== null) this.#insertRouteSegment(segment);

    const effect = nextEffectProjection(event, sequence);
    if (effect !== null) this.#insertEffect(effect);

    // `#assertDispatchIntention` has already refused a present-invalid pin in this
    // transaction; the refusal is thrown again here only so this write can never
    // read one as a delivery with no pin.
    const pinReading = dispatchPinReading(event);
    if (pinReading?.kind === "refused") {
      throw new LedgerValidationError([{ path: pinReading.path, message: pinReading.message }]);
    }
    const dispatch = nextDispatchAttemptProjection(event, sequence);
    if (dispatch !== null) this.#insertDispatchAttempt(dispatch);

    // The P-32/captura B cohort, after the delivery, for `applyEventToSnapshot`'s
    // order: a stream, an observation, and the settlement revision escalón A's
    // fold computes at this event's own head — written with the append and the
    // head in this one transaction (economy §1.2 `:81`), or not at all. A
    // delivery of an effect with no revision yet writes its exposure.
    const usage = nextUsageCapture(usageBaseView((sql) => this.#stmt(sql)), event, sequence, sha256);
    if (usage !== null) writeUsageCapture((sql) => this.#stmt(sql), usage);

    // `#assertDispatchOutcome` has already refused a present-invalid field in
    // this transaction; the refusal is thrown again here only so this write can
    // never read one as absence.
    const outcome = dispatchOutcomeRecord(event, sequence);
    if (outcome?.kind === "refused") {
      throw new LedgerValidationError([{ path: outcome.path, message: outcome.message }]);
    }
    if (outcome !== null) this.#applyDispatchOutcome(outcome.record, event.contractVersion);

    // The P-18/protocolo D pair, last, for `applyEventToSnapshot`'s order: an
    // answer names a prompt and a prompt names a delivery.
    const prompt = nextPromptOccurrenceProjection(event, sequence);
    if (prompt !== null) this.#insertPromptOccurrence(prompt);

    const response = nextResponseOccurrenceProjection(event, sequence);
    if (response !== null) this.#insertResponseOccurrence(response);
  }

  #upsertExecutionRoute(route: ExecutionRouteReadModel): void {
    this.#stmt(
      "INSERT INTO execution_route_read_model (" +
        "task_id, attempt, provider, model, account_id, transport_kind, " +
        "capability_policy_version, resolved_at, recorded_at, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (task_id, attempt) DO UPDATE SET " +
        "provider = excluded.provider, model = excluded.model, " +
        "account_id = excluded.account_id, transport_kind = excluded.transport_kind, " +
        "capability_policy_version = excluded.capability_policy_version, " +
        "resolved_at = excluded.resolved_at, recorded_at = excluded.recorded_at, " +
        "sequence = excluded.sequence",
    ).run(
      route.taskId,
      route.attempt,
      route.provider,
      route.model,
      route.accountId,
      route.transportKind,
      route.capabilityPolicyVersion,
      route.resolvedAt,
      route.recordedAt,
      route.sequence,
    );
  }

  #upsertTask(task: TaskReadModel): void {
    this.#stmt(
      "INSERT INTO task_read_model (" +
        "task_id, initiative_id, current_state, latest_attempt, event_count, first_sequence, " +
        "last_sequence, last_event_id, last_event_type, last_transition_id, last_emitted_by, " +
        "created_at, updated_at, is_terminal, " +
        "envelope_sha256, latest_revision_number, latest_attempt_number, " +
        "step_id, role, commit_policy" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (task_id) DO UPDATE SET " +
        "initiative_id = excluded.initiative_id, " +
        "current_state = excluded.current_state, latest_attempt = excluded.latest_attempt, " +
        "event_count = excluded.event_count, last_sequence = excluded.last_sequence, " +
        "last_event_id = excluded.last_event_id, last_event_type = excluded.last_event_type, " +
        "last_transition_id = excluded.last_transition_id, " +
        "last_emitted_by = excluded.last_emitted_by, updated_at = excluded.updated_at, " +
        "is_terminal = excluded.is_terminal, " +
        // The three revision columns are written from the fold's answer, which
        // already carried the previous value forward when this event announced
        // no newer revision. `excluded` is therefore always the correct value
        // and never a blank overwriting a known one.
        "envelope_sha256 = excluded.envelope_sha256, " +
        "latest_revision_number = excluded.latest_revision_number, " +
        "latest_attempt_number = excluded.latest_attempt_number, " +
        // Written once by the intake and carried by the fold (P-14 C), so
        // `excluded` is again the value the row already holds or the first one.
        "step_id = excluded.step_id, role = excluded.role, commit_policy = excluded.commit_policy",
    ).run(
      task.taskId,
      task.initiativeId,
      task.currentState,
      task.latestAttempt,
      task.eventCount,
      task.firstSequence,
      task.lastSequence,
      task.lastEventId,
      task.lastEventType,
      task.lastTransitionId,
      task.lastEmittedBy,
      task.createdAt,
      task.updatedAt,
      task.isTerminal ? 1 : 0,
      task.envelopeSha256,
      task.latestRevisionNumber,
      task.latestAttemptNumber,
      task.stepId,
      task.role,
      task.commitPolicy,
    );
  }

  /**
   * Refuse a revision record whose envelope reference the registry does not
   * hold as a `TASK_ENVELOPE` (P-36/local D, decision 41, M-5.3).
   *
   * **At the door, by name, and nowhere else.** The fold checks the reference's
   * form and cohort; whether it exists is a question about
   * `artifact_reference_read_model`, which is a projection of the registry
   * stream, while the revision row is a projection of the task stream. A
   * trigger or a foreign key across the two would make a rebuild depend on the
   * order it folds the streams in, and a rebuild that clears every derived table
   * and replays one chain at a time would abort on history this door accepted.
   * So the look-up is here — a `SELECT` before anything is written, the way the
   * opening's foreign key is guarded — and a rebuild trusts what the door
   * checked, as it trusts every other cross-stream fact.
   *
   * The fold runs first and raises its own refusals by name: a key out of its
   * cohort, a key missing from the cohort that requires it, a present value that
   * is not a reference. What is left is a well-formed reference, and it must name
   * a registered reference of class `TASK_ENVELOPE`. The refusal names the key
   * and never echoes the value, which is producer-supplied text. A replay of a
   * stored revision is checked too: references are never removed in this build,
   * so the answer cannot have changed, and one path is simpler than two.
   *
   * What is **not** checked, declared: the reference's scope, retention and
   * tombstone. Scope is the private reader's law (decision 66 (g)), nothing in
   * this build tombstones a reference, and a revision records which bytes were
   * asked about rather than who may read them.
   */
  #assertEnvelopeReference(event: ControlPlaneEvent): void {
    const revision = nextTaskRevisionProjection(event, 0);
    const named = revision?.envelopeArtifactReferenceId ?? null;
    if (revision === null || named === null) return;

    const reference = this.#stmt(
      "SELECT artifact_class FROM artifact_reference_read_model WHERE artifact_reference_id = ?",
    ).get(named) as { readonly artifact_class: string } | undefined;

    if (reference === undefined) {
      throw new LedgerValidationError([
        {
          path: "payload." + ENVELOPE_ARTIFACT_REFERENCE_KEY,
          message:
            "revision " +
            String(revision.revisionNumber) +
            " of task " +
            event.taskId +
            " names its envelope by an artifact reference the registry does not hold;" +
            " a revision's envelope is read by a registered reference, never by its digest",
        },
      ]);
    }
    if (reference.artifact_class !== "TASK_ENVELOPE") {
      throw new LedgerValidationError([
        {
          path: "payload." + ENVELOPE_ARTIFACT_REFERENCE_KEY,
          message:
            "revision " +
            String(revision.revisionNumber) +
            " of task " +
            event.taskId +
            " names an artifact reference of class " +
            reference.artifact_class +
            "; a revision's envelope is a TASK_ENVELOPE",
        },
      ]);
    }
  }

  /**
   * Write one revision row, or refuse (P-05/B).
   *
   * **Insert-only, and never `ON CONFLICT DO UPDATE`** (execution §2). A
   * revision is a record of what was asked; rewriting it would destroy exactly
   * the thing it exists to preserve, and a coordinate that could be overwritten
   * would make "revision 2" a name for whichever event arrived last.
   *
   * The same coordinate with the same content twice is an idempotent replay and
   * writes nothing — a retry of an append has to stay safe. The same coordinate
   * with different content is refused. The replay path takes the same two
   * branches in `applyEventToSnapshot`, so a rebuild refuses exactly the
   * histories the incremental path refused and N7 stays deterministic.
   */
  #insertTaskRevision(revision: TaskRevisionReadModel): void {
    const existing = this.#stmt(
      "SELECT * FROM task_revision_read_model WHERE task_id = ? AND revision_number = ?",
    ).get(revision.taskId, revision.revisionNumber) as TaskRevisionRow | undefined;

    if (existing !== undefined) {
      const stored = taskRevisionRowToModel(existing);
      // The snapshot's own comparison, imported rather than restated (F-1,
      // C-7). This door and `applyEventToSnapshot` decide "same revision"
      // with one function, so the incremental path and a rebuild refuse
      // exactly the same histories — which is the property `verifyIntegrity`
      // depends on. What it compares, why it excludes the birth attributes and
      // why the envelope reference counts only when this row holds one (Q-D2)
      // are argued where it is defined.
      if (!sameRevisionRecord(stored, revision)) {
        throw new LedgerValidationError([
          {
            path: "payload.revisionNumber",
            message:
              "revision " +
              String(revision.revisionNumber) +
              " of task " +
              revision.taskId +
              " is already recorded with different content, and a revision record is written once",
          },
        ]);
      }
      return;
    }

    this.#stmt(
      "INSERT INTO task_revision_read_model (" +
        "task_id, revision_number, revision_id, envelope_sha256, " +
        "restored_from_revision_id, created_at, created_by, contract_version, sequence, " +
        "envelope_artifact_reference_id" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      revision.taskId,
      revision.revisionNumber,
      revision.revisionId,
      revision.envelopeSha256,
      revision.restoredFromRevisionId,
      revision.createdAt,
      revision.createdBy,
      revision.contractVersion,
      revision.sequence,
      revision.envelopeArtifactReferenceId,
    );
  }

  /**
   * Write one client key row, or refuse (P-14 C, contracts §15).
   *
   * **Insert-only, and never `ON CONFLICT DO UPDATE`**, for the revision's
   * reason: a key whose task could be rewritten would make "this request" a name
   * for whichever arrival came last. The same key naming the same task, revision
   * and envelope is a replay and writes nothing. The same key naming anything
   * else is refused with `LedgerIdempotencyConflictError`, before the table's
   * constraint could abort without a name: a door that lost a race to this key
   * reads the class, reads the row and decides again. `applyEventToSnapshot`
   * compares through the same function.
   */
  #insertTaskSubmission(submission: TaskSubmissionReadModel): void {
    const existing = this.#stmt(
      "SELECT * FROM task_submission_read_model WHERE client_scope = ? AND client_request_key = ?",
    ).get(submission.clientScope, submission.clientRequestKey) as TaskSubmissionRow | undefined;

    if (existing !== undefined) {
      assertSameTaskSubmission(taskSubmissionRowToModel(existing), submission);
      return;
    }

    this.#stmt(
      "INSERT INTO task_submission_read_model (" +
        "client_scope, client_request_key, task_id, revision_number, envelope_sha256, sequence, created_at" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      submission.clientScope,
      submission.clientRequestKey,
      submission.taskId,
      submission.revisionNumber,
      submission.envelopeSha256,
      submission.sequence,
      submission.createdAt,
    );
  }

  /**
   * Write one attempt row, or refuse (P-18/B).
   *
   * **Insert-only, and never `ON CONFLICT DO UPDATE`** (execution §3). An
   * attempt is opened once; its assignment and its invocation are fixed at that
   * moment and a coordinate that could be overwritten would make "attempt 2 of
   * revision 1" a name for whichever event arrived last.
   *
   * The same coordinate with the same identity twice is an idempotent replay and
   * writes nothing — a retry of an append has to stay safe. The same coordinate
   * with a different identity is refused. `applyEventToSnapshot` takes the same
   * two branches through the same exported comparison, so a rebuild refuses
   * exactly the histories the incremental path refused, which is the property
   * `verifyIntegrity` depends on.
   *
   * The door above has already refused a conflicting identity with a message
   * that names the expected assignment; this comparison is what makes the write
   * safe on the **rebuild** path, where there is no door.
   */
  #insertTaskAttempt(attempt: TaskAttemptReadModel): void {
    const existing = this.#stmt(
      "SELECT * FROM task_attempt_read_model " +
        "WHERE task_id = ? AND revision_number = ? AND attempt_number = ?",
    ).get(attempt.taskId, attempt.revisionNumber, attempt.attemptNumber) as
      | TaskAttemptRow
      | undefined;

    if (existing !== undefined) {
      if (canonicalAttempt(taskAttemptRowToModel(existing)) !== canonicalAttempt(attempt)) {
        throw new LedgerValidationError([
          {
            path: "payload." + INVOCATION_ID_KEY,
            message:
              "attempt " +
              taskAttemptKey(attempt.taskId, attempt.revisionNumber, attempt.attemptNumber) +
              " is already recorded with a different identity, and an attempt is opened once",
          },
        ]);
      }
      return;
    }

    this.#stmt(
      "INSERT INTO task_attempt_read_model (" +
        "task_id, revision_number, attempt_number, legacy_attempt_number, invocation_id, " +
        "started_at, ended_at, outcome, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      attempt.taskId,
      attempt.revisionNumber,
      attempt.attemptNumber,
      attempt.legacyAttemptNumber,
      attempt.invocationId,
      attempt.startedAt,
      attempt.endedAt,
      attempt.outcome,
      attempt.sequence,
    );
  }

  /**
   * Write one segment row, or refuse (P-18/C).
   *
   * Insert-only, and never `ON CONFLICT DO UPDATE`, on `#insertTaskAttempt`'s
   * reasoning: a segment records the route one stretch of one attempt actually
   * ran on, and a coordinate that could be overwritten would make "segment 2"
   * the name of whichever event arrived last. An identical second arrival is an
   * idempotent replay and writes nothing; a different one is refused.
   *
   * The door above has already refused a conflicting segment with a message
   * that names the lineage at fault; this comparison is what makes the write
   * safe on the **rebuild** path, where there is no door.
   */
  #insertRouteSegment(segment: ExecutionRouteSegmentReadModel): void {
    const existing = this.#stmt(
      "SELECT * FROM execution_route_segment_read_model WHERE route_segment_id = ?",
    ).get(segment.routeSegmentId) as ExecutionRouteSegmentRow | undefined;

    if (existing !== undefined) {
      if (
        canonicalSegment(executionRouteSegmentRowToModel(existing)) !== canonicalSegment(segment)
      ) {
        throw new LedgerValidationError([
          {
            path: "payload." + SEGMENT_KEY + ".routeSegmentId",
            message:
              "route segment " +
              safeRowIdentifier(segment.routeSegmentId) +
              " is already recorded with different content, and a segment is opened once",
          },
        ]);
      }
      return;
    }

    this.#stmt(
      "INSERT INTO execution_route_segment_read_model (" +
        "route_segment_id, task_id, revision_number, attempt_number, segment_number, " +
        "predecessor_segment_id, handoff_reason, provider, model, model_resolution_status, " +
        "model_version_id, account_id, transport_kind, capability_policy_version, " +
        "routing_assignment_id, reservation_id, escalated_from_attempt, escalation_reason, " +
        "resolved_at, recorded_at, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      segment.routeSegmentId,
      segment.taskId,
      segment.revisionNumber,
      segment.attemptNumber,
      segment.segmentNumber,
      segment.predecessorSegmentId,
      segment.handoffReason,
      segment.provider,
      segment.model,
      segment.modelResolutionStatus,
      segment.modelVersionId,
      segment.accountId,
      segment.transportKind,
      segment.capabilityPolicyVersion,
      segment.routingAssignmentId,
      segment.reservationId,
      segment.escalatedFromAttempt,
      segment.escalationReason,
      segment.resolvedAt,
      segment.recordedAt,
      segment.sequence,
    );
  }

  /** Write one effect row, or refuse. Insert-only, on `#insertRouteSegment`'s terms. */
  #insertEffect(effect: EffectReadModel): void {
    const existing = this.#stmt("SELECT * FROM effect_read_model WHERE effect_id = ?").get(
      effect.effectId,
    ) as EffectRow | undefined;

    if (existing !== undefined) {
      if (canonicalEffect(effectRowToModel(existing)) !== canonicalEffect(effect)) {
        throw new LedgerValidationError([
          {
            path: "payload." + EFFECT_KEY + ".effectId",
            message:
              "effect " +
              safeRowIdentifier(effect.effectId) +
              " is already recorded with different content, and an effect is intended once",
          },
        ]);
      }
      return;
    }

    this.#stmt(
      "INSERT INTO effect_read_model (" +
        "effect_id, task_id, revision_number, attempt_number, route_segment_id, " +
        "operation_ordinal, effect_kind, semantic_scope_key, local_operation_key, " +
        "logical_operation_sha256, request_contract_version, request_sha256, " +
        "idempotency_key, intended_at, outcome_status, outcome_recorded_at, outcome_contract_version, " +
        "result_artifact_reference_id, result_sha256, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      effect.effectId,
      effect.taskId,
      effect.revisionNumber,
      effect.attemptNumber,
      effect.routeSegmentId,
      effect.operationOrdinal,
      effect.effectKind,
      effect.semanticScopeKey,
      effect.localOperationKey,
      effect.logicalOperationSha256,
      effect.requestContractVersion,
      effect.requestSha256,
      effect.idempotencyKey,
      effect.intendedAt,
      effect.outcomeStatus,
      effect.outcomeRecordedAt,
      effect.outcomeContractVersion,
      effect.resultArtifactReferenceId,
      effect.resultSha256,
      effect.sequence,
    );
  }

  /** Write one delivery row, or refuse. Insert-only; resolutions are separate. */
  #insertDispatchAttempt(dispatch: DispatchAttemptReadModel): void {
    const existing = this.#stmt(
      "SELECT * FROM dispatch_attempt_read_model WHERE dispatch_attempt_id = ?",
    ).get(dispatch.dispatchAttemptId) as DispatchAttemptRow | undefined;

    if (existing !== undefined) {
      // Only the birth fields are compared: a delivery that has since been
      // resolved is the SAME delivery, and comparing its state would make a
      // replay of the intention a conflict with the resolution that followed.
      if (
        canonicalDispatchBirth(dispatchAttemptRowToModel(existing)) !==
        canonicalDispatchBirth(dispatch)
      ) {
        throw new LedgerValidationError([
          {
            path: "payload." + DISPATCH_KEY + ".dispatchAttemptId",
            message:
              "delivery " +
              safeRowIdentifier(dispatch.dispatchAttemptId) +
              " is already recorded with different content, and a delivery is intended once",
          },
        ]);
      }
      return;
    }

    this.#stmt(
      "INSERT INTO dispatch_attempt_read_model (" +
        "dispatch_attempt_id, effect_id, route_segment_id, attempt_ordinal, " +
        "provider_idempotency_key, external_handle, dispatch_state, requested_at, " +
        "accepted_at, terminal_at, recorded_at, sequence, " +
        "dispatch_contract_version, catalog_document_id, catalog_version" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      dispatch.dispatchAttemptId,
      dispatch.effectId,
      dispatch.routeSegmentId,
      dispatch.attemptOrdinal,
      dispatch.providerIdempotencyKey,
      dispatch.externalHandle,
      dispatch.dispatchState,
      dispatch.requestedAt,
      dispatch.acceptedAt,
      dispatch.terminalAt,
      dispatch.recordedAt,
      dispatch.sequence,
      dispatch.dispatchContractVersion,
      dispatch.catalogDocumentId,
      dispatch.catalogVersion,
    );
  }

  /**
   * Apply one resolution to the delivery it reports on, and to its effect.
   *
   * The one fold in this class that updates a row it did not insert, because
   * execution §7 describes a delivery that is born and then resolved. The
   * refusals live in `#assertDispatchOutcome`; what is left here is the write,
   * plus the two comparisons that make it safe on the **rebuild** path where
   * there is no door.
   */
  #applyDispatchOutcome(outcome: DispatchOutcomeRecord, contractVersion: string): void {
    const row = this.#stmt(
      "SELECT * FROM dispatch_attempt_read_model WHERE dispatch_attempt_id = ?",
    ).get(outcome.dispatchAttemptId) as DispatchAttemptRow | undefined;
    if (row === undefined) {
      throw new LedgerValidationError([
        {
          path: "payload." + OUTCOME_KEY + ".dispatchAttemptId",
          message:
            "no delivery " +
            safeRowIdentifier(outcome.dispatchAttemptId) +
            " has been intended, and a resolution reports on a delivery that exists",
        },
      ]);
    }

    const current = dispatchAttemptRowToModel(row);
    if (current.dispatchState !== outcome.dispatchState) {
      if (!dispatchTransitionAdmitted(current.dispatchState, outcome.dispatchState)) {
        throw new LedgerValidationError([
          {
            path: "payload." + OUTCOME_KEY + ".dispatchState",
            message:
              "delivery " +
              row.dispatch_attempt_id +
              " is " +
              current.dispatchState +
              " and may move only to " +
              (DISPATCH_STATE_TRANSITIONS[current.dispatchState].join(", ") || "nothing"),
          },
        ]);
      }
      const next = nextDispatchAttemptState(current, outcome);
      this.#stmt(
        "UPDATE dispatch_attempt_read_model SET " +
          "dispatch_state = ?, terminal_at = ?, accepted_at = ?, external_handle = ?, " +
          "provider_idempotency_key = ? WHERE dispatch_attempt_id = ?",
      ).run(
        next.dispatchState,
        next.terminalAt,
        next.acceptedAt,
        next.externalHandle,
        next.providerIdempotencyKey,
        next.dispatchAttemptId,
      );
    }

    if (outcome.effectOutcomeStatus === null) return;

    // `WHERE outcome_status IS NULL` is the write's own guard, not decoration:
    // an outcome is recorded once, and a second arrival saying the same thing
    // is a replay that must leave the first instant alone. The result pair and
    // the recording version travel with the status, in the one event (ADR 0098).
    this.#stmt(
      "UPDATE effect_read_model SET outcome_status = ?, outcome_recorded_at = ?, outcome_contract_version = ?, " +
        "result_artifact_reference_id = ?, result_sha256 = ? WHERE effect_id = ? AND outcome_status IS NULL",
    ).run(
      outcome.effectOutcomeStatus,
      outcome.recordedAt,
      contractVersion,
      outcome.resultArtifactReferenceId,
      outcome.resultSha256,
      row.effect_id,
    );
  }

  /**
   * Write one prompt occurrence row, or refuse (P-18/D).
   *
   * Insert-only, on `#insertRouteSegment`'s terms: an identical second arrival
   * writes nothing and a different one is refused. The door has already
   * refused with a message naming the link at fault; this comparison is what
   * keeps the write safe on the rebuild path, where there is no door.
   */
  #insertPromptOccurrence(prompt: PromptOccurrenceReadModel): void {
    const existing = this.#stmt(
      "SELECT * FROM prompt_occurrence_read_model WHERE occurrence_id = ?",
    ).get(prompt.occurrenceId) as PromptOccurrenceRow | undefined;

    if (existing !== undefined) {
      if (
        canonicalPromptOccurrence(promptOccurrenceRowToModel(existing)) !==
        canonicalPromptOccurrence(prompt)
      ) {
        throw new LedgerValidationError([
          {
            path: "payload." + PROMPT_OCCURRENCE_KEY + ".occurrenceId",
            message:
              "prompt occurrence " +
              safeRowIdentifier(prompt.occurrenceId) +
              " is already recorded with different content, and an occurrence is recorded once",
          },
        ]);
      }
      return;
    }

    this.#stmt(
      "INSERT INTO prompt_occurrence_read_model (" +
        "occurrence_id, route_segment_id, effect_id, dispatch_attempt_id, ordinal, identity, " +
        "requested_model_id, provider, model_resolution_status, model_version_id, account_id, " +
        "prompt_sha256, prompt_bytes, context_sha256, recorded_at, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      prompt.occurrenceId,
      prompt.routeSegmentId,
      prompt.effectId,
      prompt.dispatchAttemptId,
      prompt.ordinal,
      prompt.identity,
      prompt.requestedModelId,
      prompt.provider,
      prompt.modelResolutionStatus,
      prompt.modelVersionId,
      prompt.accountId,
      prompt.promptSha256,
      prompt.promptBytes,
      prompt.contextSha256,
      prompt.recordedAt,
      prompt.sequence,
    );
  }

  /** Write one response occurrence row, or refuse. Insert-only, on the same terms. */
  #insertResponseOccurrence(response: ResponseOccurrenceReadModel): void {
    const existing = this.#stmt(
      "SELECT * FROM response_occurrence_read_model WHERE occurrence_id = ?",
    ).get(response.occurrenceId) as ResponseOccurrenceRow | undefined;

    if (existing !== undefined) {
      if (
        canonicalResponseOccurrence(responseOccurrenceRowToModel(existing)) !==
        canonicalResponseOccurrence(response)
      ) {
        throw new LedgerValidationError([
          {
            path: "payload." + RESPONSE_OCCURRENCE_KEY + ".occurrenceId",
            message:
              "response occurrence " +
              safeRowIdentifier(response.occurrenceId) +
              " is already recorded with different content, and an occurrence is recorded once",
          },
        ]);
      }
      return;
    }

    this.#stmt(
      "INSERT INTO response_occurrence_read_model (" +
        "occurrence_id, prompt_occurrence_id, response_sha256, response_bytes, " +
        "redaction_verdict, recorded_at, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      response.occurrenceId,
      response.promptOccurrenceId,
      response.responseSha256,
      response.responseBytes,
      response.redactionVerdict,
      response.recordedAt,
      response.sequence,
    );
  }

  #upsertWorker(worker: WorkerReadModel): void {
    this.#stmt(
      "INSERT INTO worker_read_model (" +
        "identity, provider, model, role, instance, event_count, task_count, first_sequence, " +
        "last_sequence, first_seen_at, last_seen_at, last_task_id, last_event_type" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (identity) DO UPDATE SET " +
        "event_count = excluded.event_count, task_count = excluded.task_count, " +
        "last_sequence = excluded.last_sequence, last_seen_at = excluded.last_seen_at, " +
        "last_task_id = excluded.last_task_id, last_event_type = excluded.last_event_type",
    ).run(
      worker.identity,
      worker.provider,
      worker.model,
      worker.role,
      worker.instance,
      worker.eventCount,
      worker.taskCount,
      worker.firstSequence,
      worker.lastSequence,
      worker.firstSeenAt,
      worker.lastSeenAt,
      worker.lastTaskId,
      worker.lastEventType,
    );
  }

  #upsertWorkerTask(pair: WorkerTaskProjection): void {
    this.#stmt(
      "INSERT INTO worker_task_read_model (identity, task_id, event_count, last_sequence) " +
        "VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (identity, task_id) DO UPDATE SET " +
        "event_count = excluded.event_count, last_sequence = excluded.last_sequence",
    ).run(pair.identity, pair.taskId, pair.eventCount, pair.lastSequence);
  }

  // -------------------------------------------------------------------------
  // The initiative stream
  // -------------------------------------------------------------------------

  /**
   * Append one initiative event.
   *
   * The same pipeline as the task stream, on its own chain: contract-parse,
   * idempotent replay, the contiguity guard, chain, insert at this stream's
   * own head + 1, project — all inside one immediate transaction. The two
   * streams share a database and a transaction discipline but never a
   * sequence, a digest chain or a head, because an initiative registration is
   * not an event about a task and must not be able to move the task stream's
   * head.
   *
   * Takes the same optional causal reference as `append`, and resolves it under
   * the same rule: the initiative stream is one of the two a reference may name,
   * so causality crosses in both directions or in neither.
   */
  appendInitiativeEvent(
    candidate: unknown,
    causation?: CausationRef | null,
  ): InitiativeAppendResult {
    this.#assertOpen("appendInitiativeEvent");
    this.#assertWritable("appendInitiativeEvent");

    const parsed = InitiativeEvent.safeParse(candidate);
    if (!parsed.success) {
      throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
    }
    const event = parsed.data;
    const canonicalJson = canonicalJsonStringify(event);
    const reference = normalizeCausation(causation, "causation");

    const run = this.#db.transaction(
      (): InitiativeAppendResult =>
        this.#appendInitiativeInTransaction(event, canonicalJson, reference),
    );
    return run.immediate();
  }

  #appendInitiativeInTransaction(
    event: InitiativeEvent,
    canonicalJson: string,
    causation: CausationRef | null,
  ): InitiativeAppendResult {
    const existingByKey = this.#stmt(
      "SELECT " + INITIATIVE_EVENT_COLUMNS + " FROM initiative_events WHERE idempotency_key = ?",
    ).get(event.idempotencyKey) as InitiativeEventRow | undefined;

    if (existingByKey !== undefined) {
      const stored = causationFromRow(existingByKey, existingByKey.sequence);
      if (existingByKey.event_json === canonicalJson && causationEquals(stored, causation)) {
        return { inserted: false, record: this.#initiativeRowToRecord(existingByKey) };
      }
      throw new LedgerIdempotencyConflictError(
        event.idempotencyKey,
        appendContentDigest(existingByKey.event_json, stored),
        appendContentDigest(canonicalJson, causation),
      );
    }

    const existingById = this.#stmt(
      "SELECT idempotency_key FROM initiative_events WHERE event_id = ?",
    ).get(event.eventId) as { readonly idempotency_key: string } | undefined;

    if (existingById !== undefined) {
      throw new LedgerEventIdConflictError(
        event.eventId,
        existingById.idempotency_key,
        event.idempotencyKey,
      );
    }

    // The contiguity guard, mirroring the task stream's: the claimed prior
    // status must be the one the projection actually holds. The DDL allows a
    // null from_status because the first event of an initiative has none; that
    // the null is lawful only there is enforced here, where the projection is
    // visible, and by the contract, which ties it to INITIATIVE_REGISTERED.
    const initiative = this.#stmt(
      "SELECT current_status FROM initiative_read_model WHERE initiative_id = ?",
    ).get(event.initiativeId) as { readonly current_status: string } | undefined;

    if (initiative === undefined) {
      if (event.fromStatus !== null) {
        throw new LedgerLifecycleConflictError(event.initiativeId, event.fromStatus, null);
      }
    } else if (event.fromStatus !== initiative.current_status) {
      throw new LedgerLifecycleConflictError(
        event.initiativeId,
        event.fromStatus,
        initiative.current_status,
      );
    }

    this.#assertCausationResolves(causation);

    const head = this.#readInitiativeHead();
    const previousSha256 = head.sha256;
    const eventSha256 = chainDigest(previousSha256, canonicalJson);
    const expectedSequence = head.sequence + 1;

    const info = this.#stmt(
      "INSERT INTO initiative_events (" +
        "event_id, idempotency_key, initiative_id, transition_id, type, from_status, " +
        "to_status, emitted_by, occurred_at, recorded_at, " +
        "causation_stream, causation_sequence, causation_sha256, " +
        "contract_version, event_json, previous_sha256, event_sha256" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      event.eventId,
      event.idempotencyKey,
      event.initiativeId,
      event.transitionId,
      event.type,
      event.fromStatus,
      event.toStatus,
      event.emittedBy,
      event.occurredAt,
      event.recordedAt,
      causation === null ? null : causation.stream,
      causation === null ? null : causation.sequence,
      causation === null ? null : causation.sha256,
      event.contractVersion,
      canonicalJson,
      previousSha256,
      eventSha256,
    );

    // AUTOINCREMENT is per table, but both streams share one rowid space only
    // in the sense that each has its own; the check is the same one the task
    // stream makes, and for the same reason.
    const sequence = Number(info.lastInsertRowid);
    if (sequence !== expectedSequence) {
      throw new LedgerSequenceError(expectedSequence, sequence);
    }

    this.#faults.beforeProjection?.();

    this.#projectInitiativeEvent(event, sequence);
    this.#writeInitiativeHead(sequence, eventSha256, head.count + 1);
    // The same discipline as the task door, on this stream's own watermarks:
    // an append that moves a head moves the watermark of every projection fed
    // by that head, in the same transaction, and of no other.
    this.#writeWatermarks(INITIATIVE_WATERMARKS, {
      sequence,
      count: head.count + 1,
      sha256: eventSha256,
      updatedAt: event.recordedAt,
    });

    this.#faults.beforeAppendCommit?.();

    return {
      inserted: true,
      record: {
        sequence,
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        event,
        canonicalJson,
        previousSha256,
        eventSha256,
        causation,
      },
    };
  }

  /** Incremental projection of the initiative stream. Same rules as replay. */
  #projectInitiativeEvent(event: InitiativeEvent, sequence: number): void {
    const current = this.#stmt(
      "SELECT * FROM initiative_read_model WHERE initiative_id = ?",
    ).get(event.initiativeId) as InitiativeRow | undefined;

    this.#upsertInitiative(
      nextInitiativeProjection(
        current === undefined ? null : initiativeRowToModel(current),
        event,
        sequence,
      ),
    );

    const version = nextRoadmapVersionProjection(event, sequence);
    if (version !== null) this.#upsertRoadmapVersion(version);
  }

  #upsertInitiative(initiative: InitiativeReadModel): void {
    this.#stmt(
      "INSERT INTO initiative_read_model (" +
        "initiative_id, current_status, event_count, first_sequence, last_sequence, " +
        "last_event_id, last_event_type, last_transition_id, last_emitted_by, created_at, " +
        "updated_at, title, objective_sha256, repository_sha256" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (initiative_id) DO UPDATE SET " +
        "current_status = excluded.current_status, event_count = excluded.event_count, " +
        "last_sequence = excluded.last_sequence, last_event_id = excluded.last_event_id, " +
        "last_event_type = excluded.last_event_type, " +
        "last_transition_id = excluded.last_transition_id, " +
        "last_emitted_by = excluded.last_emitted_by, updated_at = excluded.updated_at, " +
        "title = excluded.title, objective_sha256 = excluded.objective_sha256, " +
        "repository_sha256 = excluded.repository_sha256",
    ).run(
      initiative.initiativeId,
      initiative.currentStatus,
      initiative.eventCount,
      initiative.firstSequence,
      initiative.lastSequence,
      initiative.lastEventId,
      initiative.lastEventType,
      initiative.lastTransitionId,
      initiative.lastEmittedBy,
      initiative.createdAt,
      initiative.updatedAt,
      initiative.title,
      initiative.objectiveSha256,
      initiative.repositorySha256,
    );
  }

  #upsertRoadmapVersion(version: RoadmapVersionReadModel): void {
    this.#stmt(
      "INSERT INTO roadmap_version_read_model (" +
        "roadmap_version_id, initiative_id, version, content_digest, parent_version_id, " +
        "kind, restores_version_id, recorded_by, recorded_at, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (roadmap_version_id) DO UPDATE SET " +
        "initiative_id = excluded.initiative_id, version = excluded.version, " +
        "content_digest = excluded.content_digest, " +
        "parent_version_id = excluded.parent_version_id, kind = excluded.kind, " +
        "restores_version_id = excluded.restores_version_id, " +
        "recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at, " +
        "sequence = excluded.sequence",
    ).run(
      version.roadmapVersionId,
      version.initiativeId,
      version.version,
      version.contentDigest,
      version.parentVersionId,
      version.kind,
      version.restoresVersionId,
      version.recordedBy,
      version.recordedAt,
      version.sequence,
    );
  }

  #initiativeRowToRecord(row: InitiativeEventRow): InitiativeEventRecord {
    const parsed = InitiativeEvent.safeParse(JSON.parse(row.event_json));
    if (!parsed.success) {
      throw new LedgerIntegrityError([
        "initiative event at sequence " +
          String(row.sequence) +
          " no longer satisfies the contract",
      ]);
    }
    return {
      sequence: row.sequence,
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      event: parsed.data,
      canonicalJson: row.event_json,
      previousSha256: row.previous_sha256,
      eventSha256: row.event_sha256,
      causation: causationFromRow(row, row.sequence),
    };
  }

  // -------------------------------------------------------------------------
  // The registry stream
  // -------------------------------------------------------------------------

  /**
   * Record one version of one configuration document (P-09/log-C).
   *
   * The third stream, on its own chain and its own head, under the same
   * transaction discipline as the other two: one `BEGIN IMMEDIATE` covers the
   * row, the projection, the head and the watermark, and a failure anywhere
   * leaves the ledger exactly as it was.
   *
   * A unit door and not a batch. The task stream got `appendBatch` because a
   * caller there has three facts to record at once; a configuration version is
   * a single deliberate act, no negative in this packet asks for a registry
   * batch, and a door added on speculation is a boundary somebody later has to
   * defend. Adding one is additive when a caller needs it.
   *
   * This is STORAGE. The ledger does not decide whether the policy a document
   * points at is admissible, or whether the author was allowed to record it.
   * Those belong to the modules that own each `documentKind`. What it does
   * refuse is what it alone can see: a replayed key with different content, a
   * reused event id, a version the document already holds, and a causal
   * reference that does not resolve.
   *
   * And, since P-14 A (ADR 0085), two typed lookups over its own read models,
   * by name and never by score: a `MODEL_VERSION` payload outside its fixed
   * shape, and a `ROUTING_ASSIGNMENT_GLOBAL` naming a model version that is not
   * registered, not `ACTIVE`, or not eligible for the role. Both run after the
   * replay and lineage checks and before the insert, so an exact replay of a
   * document admitted earlier is still a replay, whatever has been retired since.
   *
   * And, since P-33/catálogo A (ADR 0091), a third: a `PRICE_TABLE` outside its
   * closed payload, with two intervals of one quintuple that meet, or naming a
   * model version that is not registered or is registered under another provider.
   */
  appendRegistryEvent(
    candidate: unknown,
    causation?: CausationRef | null,
  ): RegistryAppendResult {
    this.#assertOpen("appendRegistryEvent");
    this.#assertWritable("appendRegistryEvent");

    const document = normalizeRegistryDocument(candidate);
    const canonicalJson = canonicalJsonStringify(document);
    assertRegistryBodyBounded(canonicalJson);
    const reference = normalizeCausation(causation, "causation");

    const run = this.#db.transaction(
      (): RegistryAppendResult =>
        this.#appendRegistryInTransaction(document, canonicalJson, reference),
    );
    return run.immediate();
  }

  #appendRegistryInTransaction(
    document: RegistryDocument,
    canonicalJson: string,
    causation: CausationRef | null,
  ): RegistryAppendResult {
    const existingByKey = this.#stmt(
      "SELECT " + REGISTRY_EVENT_COLUMNS + " FROM registry_events WHERE idempotency_key = ?",
    ).get(document.idempotencyKey) as RegistryEventRow | undefined;

    if (existingByKey !== undefined) {
      const stored = causationFromRow(existingByKey, existingByKey.sequence);
      if (existingByKey.event_json === canonicalJson && causationEquals(stored, causation)) {
        return { inserted: false, record: this.#registryRowToRecord(existingByKey) };
      }
      throw new LedgerIdempotencyConflictError(
        document.idempotencyKey,
        appendContentDigest(existingByKey.event_json, stored),
        appendContentDigest(canonicalJson, causation),
      );
    }

    const existingById = this.#stmt(
      "SELECT idempotency_key FROM registry_events WHERE event_id = ?",
    ).get(document.eventId) as { readonly idempotency_key: string } | undefined;

    if (existingById !== undefined) {
      throw new LedgerEventIdConflictError(
        document.eventId,
        existingById.idempotency_key,
        document.idempotencyKey,
      );
    }

    this.#assertDocumentLineage(document);
    this.#assertRegistryDocumentAdmissible(document);
    this.#assertCausationResolves(causation);

    const head = this.#readRegistryHead();
    const previousSha256 = head.sha256;
    const eventSha256 = chainDigest(previousSha256, canonicalJson);
    const expectedSequence = head.sequence + 1;

    const info = this.#stmt(
      // `subject_kind` is stated, never defaulted: migration 15 gives the column
      // no default, so a writer that forgot which plane it writes is refused.
      "INSERT INTO registry_events (" +
        "event_id, idempotency_key, subject_kind, document_kind, document_id, document_version, " +
        "content_digest, parent_document_version, recorded_by, effective_from, " +
        "occurred_at, recorded_at, causation_stream, causation_sequence, causation_sha256, " +
        "contract_version, event_json, previous_sha256, event_sha256" +
        ") VALUES (?, ?, 'DOCUMENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      document.eventId,
      document.idempotencyKey,
      document.documentKind,
      document.documentId,
      document.documentVersion,
      document.contentDigest,
      document.parentDocumentVersion,
      document.recordedBy,
      document.effectiveFrom,
      document.occurredAt,
      document.recordedAt,
      causation === null ? null : causation.stream,
      causation === null ? null : causation.sequence,
      causation === null ? null : causation.sha256,
      document.contractVersion,
      canonicalJson,
      previousSha256,
      eventSha256,
    );

    const sequence = Number(info.lastInsertRowid);
    if (sequence !== expectedSequence) {
      throw new LedgerSequenceError(expectedSequence, sequence);
    }

    this.#faults.beforeProjection?.();

    this.#projectRegistryDocument(document, sequence);
    this.#writeRegistryHead(sequence, eventSha256, head.count + 1);
    // This stream's own watermark row, and no other's. The two-source
    // projection has a second row that follows the initiative stream, and this
    // `UPDATE` cannot reach it: it names the pair, not the projection.
    this.#writeWatermarks(REGISTRY_WATERMARKS, {
      sequence,
      count: head.count + 1,
      sha256: eventSha256,
      updatedAt: document.recordedAt,
    });

    this.#faults.beforeAppendCommit?.();

    return {
      inserted: true,
      record: {
        sequence,
        eventId: document.eventId,
        idempotencyKey: document.idempotencyKey,
        document,
        canonicalJson,
        previousSha256,
        eventSha256,
        causation,
      },
    };
  }

  /**
   * The version lineage of one document, checked against the stream.
   *
   * `ux_registry_events__document_id__document_version` is the backstop and is
   * what actually makes a duplicate impossible; this is what turns the refusal
   * into a typed error naming the coordinate, rather than a raw uniqueness
   * failure from SQLite that no caller can catch by class. The two other rules
   * come from the same contract clause: a document keeps its kind across its
   * versions, and a null parent is the *claim* that this is a first version
   * rather than the absence of a claim.
   */
  #assertDocumentLineage(document: RegistryDocument): void {
    const anyVersion = this.#stmt(
      "SELECT subject_kind, document_kind FROM registry_events WHERE document_id = ? LIMIT 1",
    ).get(document.documentId) as
      | { readonly subject_kind: string; readonly document_kind: string | null }
      | undefined;

    // A subject keeps its kind across its events, in both directions (P-36/local
    // A): an identifier the artifact plane already uses is not a document id,
    // and asking for its `document_kind` would read the NULL an artifact row
    // carries.
    if (anyVersion !== undefined && anyVersion.subject_kind !== "DOCUMENT") {
      throw new LedgerValidationError([
        {
          path: "documentId",
          message:
            "subject " +
            safeRowIdentifier(document.documentId) +
            " is recorded as an ARTIFACT subject, and a subject keeps its kind across its events",
        },
      ]);
    }

    if (anyVersion !== undefined && anyVersion.document_kind !== document.documentKind) {
      throw new LedgerValidationError([
        {
          path: "documentKind",
          message:
            "document " +
            document.documentId +
            " is recorded as " +
            safeIdentifier(anyVersion.document_kind ?? "") +
            " and a document keeps its kind across its versions",
        },
      ]);
    }

    const clash = this.#stmt(
      "SELECT sequence FROM registry_events WHERE document_id = ? AND document_version = ?",
    ).get(document.documentId, document.documentVersion) as
      | { readonly sequence: number }
      | undefined;

    if (clash !== undefined) {
      throw new LedgerValidationError([
        {
          path: "documentVersion",
          message:
            "document " +
            document.documentId +
            " already holds version " +
            String(document.documentVersion) +
            ", recorded at sequence " +
            String(clash.sequence),
        },
      ]);
    }

    // P-15/R (ADR 0104, Q-C3). A catalog version is chosen by the instant it takes
    // effect, so two versions of one `PRICE_TABLE` at the same instant leave no version
    // in force there. Refused as a write invariant, for this kind alone and per
    // document; not a UNIQUE index, because a ledger that already holds a tie must
    // still open, and the fold that rebuilds it stays tolerant (decision 56's
    // asymmetry). C's dispatch door refuses such a history's ambiguous pin.
    if (document.documentKind === "PRICE_TABLE") {
      const taken = this.#stmt(
        "SELECT document_version FROM registry_events " +
          "WHERE subject_kind = 'DOCUMENT' AND document_id = ? AND effective_from = ? LIMIT 1",
      ).get(document.documentId, document.effectiveFrom) as { readonly document_version: number } | undefined;
      if (taken !== undefined) {
        throw new LedgerValidationError([
          {
            path: "effectiveFrom",
            message:
              "REGISTRY_EFFECTIVE_FROM_TAKEN: version " +
              String(taken.document_version) +
              " of this price table already takes effect at this instant, and two versions at one instant " +
              "leave neither in force",
          },
        ]);
      }
    }

    if (document.parentDocumentVersion === null) {
      if (anyVersion !== undefined) {
        throw new LedgerValidationError([
          {
            path: "parentDocumentVersion",
            message:
              "document " +
              document.documentId +
              " already has a first version, so this one names the version it supersedes",
          },
        ]);
      }
      return;
    }

    const parent = this.#stmt(
      "SELECT sequence FROM registry_events WHERE document_id = ? AND document_version = ?",
    ).get(document.documentId, document.parentDocumentVersion) as
      | { readonly sequence: number }
      | undefined;

    if (parent === undefined) {
      throw new LedgerValidationError([
        {
          path: "parentDocumentVersion",
          message:
            "document " +
            document.documentId +
            " has no version " +
            String(document.parentDocumentVersion) +
            " for this one to supersede",
        },
      ]);
    }
  }

  /**
   * The two checks of P-14 A that read what the stream already registered
   * (ADR 0085, decision 68's precedent: form where it is written, existence at
   * the door).
   *
   * A `MODEL_VERSION` is held to its fixed payload, so a lifecycle word the fold
   * cannot read never enters: a RETIRE written wrong cannot leave an ACTIVE row
   * standing. A `ROUTING_ASSIGNMENT_GLOBAL` is held against
   * `model_version_read_model` — the version it names and each fallback
   * registered and `ACTIVE`, the role among the version's eligible roles. The
   * refusal is `LedgerValidationError` with the path as `at` and a closed word at
   * the head of each message; no value is echoed. Transport is not in the
   * assignment and is not checked here: that half is the resolver's.
   *
   * A third branch since P-33/catálogo A (ADR 0091): a `PRICE_TABLE` is held to
   * its closed payload and against the same registry — existence in any status,
   * and the provider it was registered under.
   */
  #assertRegistryDocumentAdmissible(document: RegistryDocument): void {
    // P-15/R (ADR 0104, C-R1). The three kinds whose content is the payload carry the
    // payload's own digest, and the door verifies it rather than trusting the writer:
    // this binds every producer, not only the publication door. First, because a
    // document that misstates its content is not read further. The fold does not
    // re-verify; stored history keeps the digests it was written with.
    if ((INLINE_CONTENT_DOCUMENT_KINDS as readonly string[]).includes(document.documentKind)) {
      if (document.contentDigest !== sha256Hex(canonicalJsonStringify(document.payload))) {
        throw new LedgerValidationError([
          {
            path: "contentDigest",
            message:
              "REGISTRY_CONTENT_DIGEST_MISMATCH: a " +
              document.documentKind +
              " carries its content inline, so its digest is the SHA-256 of the payload's canonical JSON",
          },
        ]);
      }
    }
    let issues: LedgerValidationIssue[];
    if (document.documentKind === "MODEL_VERSION") {
      issues = modelVersionPayloadIssues(document.payload);
    } else if (document.documentKind === "PRICE_TABLE") {
      // P-33/catálogo A (ADR 0091): its own branch, never the assignment gate's
      // `else`, which admits every kind it does not know. The shape, then each
      // model version registered in any status and under the interval's provider.
      issues = priceTableIssues(document, (modelVersionId) => {
        const row = this.#stmt(
          "SELECT provider FROM model_version_read_model WHERE model_version_id = ?",
        ).get(modelVersionId) as { readonly provider: string } | undefined;
        return row === undefined ? null : { provider: row.provider };
      });
    } else {
      issues = globalAssignmentIssues(document, (modelVersionId) => {
        const row = this.#stmt(
          "SELECT status FROM model_version_read_model WHERE model_version_id = ?",
        ).get(modelVersionId) as { readonly status: string } | undefined;
        if (row === undefined) return null;
        const roles = this.#stmt(
          "SELECT role FROM model_version_eligible_role WHERE model_version_id = ? ORDER BY ordinal",
        ).all(modelVersionId) as { readonly role: string }[];
        return {
          status: row.status as ModelVersionReadModel["status"],
          eligibleRoles: roles.map((entry) => entry.role),
        };
      });
    }
    if (issues.length > 0) throw new LedgerValidationError(issues);
  }

  /** Incremental projection of the registry stream. Same rules as replay. */
  #projectRegistryDocument(document: RegistryDocument, sequence: number): void {
    const projected = nextRoutingAssignmentProjection(document, sequence);
    if (projected !== null) this.#applyRoutingAssignment(projected);
    const modelVersion = nextModelVersionProjection(document, sequence);
    if (modelVersion !== null) writeModelVersionProjection((sql) => this.#stmt(sql), modelVersion);
    // The whole catalog version, in the transaction of its event and before the
    // head moves: a throw anywhere after the insert leaves no row of it.
    const prices = nextPriceIntervalProjection(document, sequence);
    if (prices !== null) writePriceIntervalProjection((sql) => this.#stmt(sql), prices);
  }

  /**
   * Write one routing projection, and mark the version it supersedes.
   *
   * The parent row keeps every fact it recorded and gains only its
   * `superseded_by`: "which model was implementer slot 0 assigned in March" is
   * a question this read model exists to be able to answer, and an overwrite
   * would destroy it.
   */
  #applyRoutingAssignment(projected: RoutingAssignmentProjection): void {
    const { assignment, fallbacks, supersedes } = projected;
    this.#upsertRoutingAssignment(assignment);

    // Replaced rather than merged, so a version with fewer fallbacks than the
    // row already on disk cannot leave the extra ones behind. Nothing in an
    // append-only stream re-folds one assignment id today; a rebuild that
    // reached a half-written table would.
    this.#stmt("DELETE FROM routing_assignment_fallback WHERE assignment_id = ?").run(
      assignment.assignmentId,
    );
    for (const fallback of fallbacks) this.#insertRoutingFallback(fallback);

    if (supersedes === null) return;
    this.#stmt(
      "UPDATE routing_assignment_read_model SET superseded_by = ? WHERE assignment_id = ?",
    ).run(assignment.assignmentId, supersedes);
  }

  #upsertRoutingAssignment(assignment: RoutingAssignmentReadModel): void {
    this.#stmt(
      "INSERT INTO routing_assignment_read_model (" +
        "assignment_id, scope_kind, scope_id, version, role, slot, provider, " +
        "model_version_id, recorded_by, recorded_at, superseded_by, source_stream, " +
        "source_sequence, sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (assignment_id) DO UPDATE SET " +
        "scope_kind = excluded.scope_kind, scope_id = excluded.scope_id, " +
        "version = excluded.version, role = excluded.role, slot = excluded.slot, " +
        "provider = excluded.provider, model_version_id = excluded.model_version_id, " +
        "recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at, " +
        "superseded_by = excluded.superseded_by, source_stream = excluded.source_stream, " +
        "source_sequence = excluded.source_sequence, sequence = excluded.sequence",
    ).run(
      assignment.assignmentId,
      assignment.scopeKind,
      assignment.scopeId,
      assignment.version,
      assignment.role,
      assignment.slot,
      assignment.provider,
      assignment.modelVersionId,
      assignment.recordedBy,
      assignment.recordedAt,
      assignment.supersededBy,
      assignment.sourceStream,
      assignment.sourceSequence,
      assignment.sequence,
    );
  }

  #insertRoutingFallback(fallback: RoutingAssignmentFallbackRow): void {
    this.#stmt(
      "INSERT INTO routing_assignment_fallback (assignment_id, ordinal, model_version_id) " +
        "VALUES (?, ?, ?) " +
        "ON CONFLICT (assignment_id, ordinal) DO UPDATE SET " +
        "model_version_id = excluded.model_version_id",
    ).run(fallback.assignmentId, fallback.ordinal, fallback.modelVersionId);
  }

  #registryRowToRecord(row: RegistryEventRow): RegistryEventRecord {
    const document = tryNormalizeRegistryDocument(JSON.parse(row.event_json));
    if (document === null) {
      // The read path fails closed on tampering rather than returning a
      // plausible-looking document, exactly as the other two streams do.
      throw new LedgerIntegrityError([
        "registry document at sequence " +
          String(row.sequence) +
          " no longer satisfies the document shape",
      ]);
    }
    return {
      sequence: row.sequence,
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      document,
      canonicalJson: row.event_json,
      previousSha256: row.previous_sha256,
      eventSha256: row.event_sha256,
      causation: causationFromRow(row, row.sequence),
    };
  }

  // -------------------------------------------------------------------------
  // The artifact plane of the registry stream (P-36/local escalón A)
  // -------------------------------------------------------------------------

  /**
   * Record one artifact event in `registry_events` (artifacts §1.1, §8.1).
   *
   * The registry stream's second door, on its chain, its head and its
   * watermarks, under the same transaction discipline: one `BEGIN IMMEDIATE`
   * covers the row, the four read models, the head and the watermarks, and a
   * failure anywhere leaves the ledger exactly as it was.
   *
   * **Facts of the bytes, never the bytes.** Nothing here opens, writes,
   * renames or synchronizes a file. The events say that a publication was
   * intended, succeeded or was abandoned, that a reference or a pin exists; the
   * filesystem half of each is escalón C, and this door neither performs it nor
   * checks it. A rebuild of what these events fold into reads no file and no
   * clock.
   *
   * What it refuses is what it alone can see: a replayed key with different
   * content, a reused event id, a version not in force, a subject already
   * recorded as a document, an ordinal that is not one past the subject's
   * highest, a causal reference that does not resolve — and, through the fold,
   * every transition artifacts §8.1 does not allow. The encryption of a reused
   * generation is refused with its own named error.
   */
  appendArtifactEvent(candidate: unknown, causation?: CausationRef | null): ArtifactAppendResult {
    this.#assertOpen("appendArtifactEvent");
    this.#assertWritable("appendArtifactEvent");

    const event = normalizeArtifactEvent(candidate);
    const canonicalJson = canonicalJsonStringify(event);
    assertArtifactBodyBounded(canonicalJson);
    const reference = normalizeCausation(causation, "causation");

    const run = this.#db.transaction(
      (): ArtifactAppendResult => this.#appendArtifactInTransaction(event, canonicalJson, reference),
    );
    return run.immediate();
  }

  #appendArtifactInTransaction(
    event: ArtifactRegistryEvent,
    canonicalJson: string,
    causation: CausationRef | null,
  ): ArtifactAppendResult {
    const existingByKey = this.#stmt(
      "SELECT " + REGISTRY_EVENT_COLUMNS + " FROM registry_events WHERE idempotency_key = ?",
    ).get(event.idempotencyKey) as RegistryEventRow | undefined;

    if (existingByKey !== undefined) {
      const stored = causationFromRow(existingByKey, existingByKey.sequence);
      if (existingByKey.event_json === canonicalJson && causationEquals(stored, causation)) {
        return { inserted: false, record: this.#artifactRowToRecord(existingByKey) };
      }
      throw new LedgerIdempotencyConflictError(
        event.idempotencyKey,
        appendContentDigest(existingByKey.event_json, stored),
        appendContentDigest(canonicalJson, causation),
      );
    }

    const existingById = this.#stmt(
      "SELECT idempotency_key FROM registry_events WHERE event_id = ?",
    ).get(event.eventId) as { readonly idempotency_key: string } | undefined;

    if (existingById !== undefined) {
      throw new LedgerEventIdConflictError(
        event.eventId,
        existingById.idempotency_key,
        event.idempotencyKey,
      );
    }

    // The version in force, for a new insertion only, after the exact replay
    // has returned: the append door's rule (ADR 0072's debt, paid by 0076).
    if (event.contractVersion !== CONTRACT_VERSION) {
      throw new LedgerValidationError([
        {
          path: "contractVersion",
          message:
            "a new event is recorded under the contract version in force, which is " +
            CONTRACT_VERSION +
            "; this event carries " +
            event.contractVersion +
            ", which this build reads (the supported set is " +
            supportedVersionList() +
            ") but no longer emits",
        },
      ]);
    }

    const subject = artifactSubjectOf(event);
    this.#assertArtifactLineage(event, subject.documentId);
    this.#assertCausationResolves(causation);

    const head = this.#readRegistryHead();
    const expectedSequence = head.sequence + 1;

    // Decided BEFORE the row is written, against the read models as they stand,
    // so a refusal leaves no row, no projection and no head behind. The
    // sequence it stamps is the one the insert below must then be assigned.
    const writes = nextArtifactProjection(this.#artifactBaseView(), event, expectedSequence);

    const previousSha256 = head.sha256;
    const eventSha256 = chainDigest(previousSha256, canonicalJson);

    const info = this.#stmt(
      "INSERT INTO registry_events (" +
        "event_id, idempotency_key, subject_kind, document_kind, artifact_event_kind, " +
        "document_id, document_version, content_digest, parent_document_version, recorded_by, " +
        "effective_from, occurred_at, recorded_at, causation_stream, causation_sequence, " +
        "causation_sha256, contract_version, event_json, previous_sha256, event_sha256" +
        ") VALUES (?, ?, 'ARTIFACT', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      event.eventId,
      event.idempotencyKey,
      event.artifactEventKind,
      subject.documentId,
      event.subjectOrdinal,
      subject.contentDigest,
      event.parentSubjectOrdinal,
      event.recordedBy,
      // An artifact event rules from the instant it occurred; it has no other
      // validity instant to carry.
      event.occurredAt,
      event.occurredAt,
      event.recordedAt,
      causation === null ? null : causation.stream,
      causation === null ? null : causation.sequence,
      causation === null ? null : causation.sha256,
      event.contractVersion,
      canonicalJson,
      previousSha256,
      eventSha256,
    );

    const sequence = Number(info.lastInsertRowid);
    if (sequence !== expectedSequence) {
      throw new LedgerSequenceError(expectedSequence, sequence);
    }

    this.#faults.beforeProjection?.();

    this.#writeArtifactProjection(writes);
    this.#writeRegistryHead(sequence, eventSha256, head.count + 1);
    // Every projection of this stream, the routing projection's registry row
    // among them: an artifact event is a registry event, and a watermark says
    // how far along the STREAM a projection is, not how many of its rows moved.
    this.#writeWatermarks(REGISTRY_WATERMARKS, {
      sequence,
      count: head.count + 1,
      sha256: eventSha256,
      updatedAt: event.recordedAt,
    });

    this.#faults.beforeAppendCommit?.();

    return {
      inserted: true,
      record: {
        sequence,
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        event,
        canonicalJson,
        previousSha256,
        eventSha256,
        causation,
      },
    };
  }

  /**
   * An artifact subject's kind and ordinal, checked against the stream.
   *
   * The ordinal is `1 + MAX(document_version)` over the subject, proposed by the
   * producer — the chain digests the body before the write lock is taken, so the
   * ledger cannot write the number in — and verified here, where a mismatch is a
   * refusal naming the expected value. The parent ordinal is tied to it by the
   * contract. `ux_registry_events__document_id__document_version` is the
   * backstop, as it is for a document's version.
   */
  #assertArtifactLineage(event: ArtifactRegistryEvent, documentId: string): void {
    const recorded = this.#stmt(
      "SELECT subject_kind FROM registry_events WHERE document_id = ? LIMIT 1",
    ).get(documentId) as { readonly subject_kind: string } | undefined;

    if (recorded !== undefined && recorded.subject_kind !== "ARTIFACT") {
      throw new LedgerValidationError([
        {
          path: artifactSubjectPath(event),
          message:
            "subject " +
            safeRowIdentifier(documentId) +
            " is recorded as a DOCUMENT subject, and a subject keeps its kind across its events",
        },
      ]);
    }

    const highest = (
      this.#stmt(
        "SELECT COALESCE(MAX(document_version), 0) AS highest FROM registry_events WHERE document_id = ?",
      ).get(documentId) as { readonly highest: number }
    ).highest;

    if (event.subjectOrdinal !== highest + 1) {
      throw new LedgerValidationError([
        {
          path: "subjectOrdinal",
          message:
            "artifact subject " +
            safeRowIdentifier(documentId) +
            " holds " +
            String(highest) +
            " event(s), so the next one is ordinal " +
            String(highest + 1) +
            "; this event proposes " +
            String(event.subjectOrdinal),
        },
      ]);
    }
  }

  /** The artifact fold's view over the base, inside the caller's transaction. */
  #artifactBaseView(): ArtifactFoldView {
    return {
      blob: (contentSha256, blobGeneration) => {
        const row = this.#stmt(
          "SELECT * FROM artifact_blob_read_model WHERE content_sha256 = ? AND blob_generation = ?",
        ).get(contentSha256, blobGeneration) as ArtifactBlobRow | undefined;
        return row === undefined ? null : artifactBlobRowToModel(row);
      },
      unreclaimedBlob: (contentSha256) => {
        // At most one row, by `ux_artifact_blob_read_model__content_sha256__unreclaimed`.
        const row = this.#stmt(
          "SELECT * FROM artifact_blob_read_model " +
            "WHERE content_sha256 = ? AND lifecycle_state <> 'RECLAIMED'",
        ).get(contentSha256) as ArtifactBlobRow | undefined;
        return row === undefined ? null : artifactBlobRowToModel(row);
      },
      highestBlobGeneration: (contentSha256) =>
        (
          this.#stmt(
            "SELECT COALESCE(MAX(blob_generation), 0) AS highest FROM artifact_blob_read_model " +
              "WHERE content_sha256 = ?",
          ).get(contentSha256) as { readonly highest: number }
        ).highest,
      reference: (artifactReferenceId) => {
        const row = this.#stmt(
          "SELECT * FROM artifact_reference_read_model WHERE artifact_reference_id = ?",
        ).get(artifactReferenceId) as ArtifactReferenceRow | undefined;
        return row === undefined ? null : artifactReferenceRowToModel(row);
      },
      pin: (artifactPinId) => {
        const row = this.#stmt(
          "SELECT * FROM artifact_pin_read_model WHERE artifact_pin_id = ?",
        ).get(artifactPinId) as ArtifactPinRow | undefined;
        return row === undefined ? null : artifactPinRowToModel(row);
      },
      livePin: (contentSha256, blobGeneration, pinHolderKind, pinHolderId) => {
        // At most one row, by `ux_artifact_pin_read_model__content_sha256_holder__live`.
        const row = this.#stmt(
          "SELECT * FROM artifact_pin_read_model WHERE content_sha256 = ? AND blob_generation = ? " +
            "AND pin_holder_kind = ? AND pin_holder_id = ? AND released_sequence IS NULL",
        ).get(contentSha256, blobGeneration, pinHolderKind, pinHolderId) as ArtifactPinRow | undefined;
        return row === undefined ? null : artifactPinRowToModel(row);
      },
    };
  }

  /**
   * Write what the fold decided. The blob first, because the reference and the
   * pin each carry a foreign key onto it and `foreign_keys` is ON.
   */
  #writeArtifactProjection(writes: ArtifactProjectionWrites): void {
    if (writes.blob !== null) this.#upsertArtifactBlob(writes.blob);
    if (writes.reference !== null) this.#insertArtifactReference(writes.reference);
    if (writes.pin !== null) this.#upsertArtifactPin(writes.pin);
  }

  #upsertArtifactBlob(blob: ArtifactBlobReadModel): void {
    this.#stmt(
      "INSERT INTO artifact_blob_read_model (" +
        "content_sha256, blob_generation, media_type, size_bytes, lifecycle_state, " +
        "encryption_status, key_reference, first_published_sequence, first_published_at, " +
        "reclaim_id, reclaimed_at, grace_started_at, encryption_profile, applied_sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (content_sha256, blob_generation) DO UPDATE SET " +
        "media_type = excluded.media_type, size_bytes = excluded.size_bytes, " +
        "lifecycle_state = excluded.lifecycle_state, " +
        "encryption_status = excluded.encryption_status, key_reference = excluded.key_reference, " +
        "first_published_sequence = excluded.first_published_sequence, " +
        "first_published_at = excluded.first_published_at, reclaim_id = excluded.reclaim_id, " +
        "reclaimed_at = excluded.reclaimed_at, grace_started_at = excluded.grace_started_at, " +
        "encryption_profile = excluded.encryption_profile, " +
        "applied_sequence = excluded.applied_sequence",
    ).run(
      blob.contentSha256,
      blob.blobGeneration,
      blob.mediaType,
      blob.sizeBytes,
      blob.lifecycleState,
      blob.encryptionStatus,
      blob.keyReference,
      blob.firstPublishedSequence,
      blob.firstPublishedAt,
      blob.reclaimId,
      blob.reclaimedAt,
      blob.graceStartedAt,
      blob.encryptionProfile,
      blob.appliedSequence,
    );
  }

  /** A reference is recorded once; the fold refused a second one by name. */
  #insertArtifactReference(reference: ArtifactReferenceReadModel): void {
    this.#stmt(
      "INSERT INTO artifact_reference_read_model (" +
        "artifact_reference_id, content_sha256, blob_generation, artifact_class, classification, " +
        "scope_kind, scope_id, producer_identity, access_policy_id, retention_class, expires_at, " +
        "tombstoned_at, tombstone_reason, created_sequence, applied_sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      reference.artifactReferenceId,
      reference.contentSha256,
      reference.blobGeneration,
      reference.artifactClass,
      reference.classification,
      reference.scopeKind,
      reference.scopeId,
      reference.producerIdentity,
      reference.accessPolicyId,
      reference.retentionClass,
      reference.expiresAt,
      reference.tombstonedAt,
      reference.tombstoneReason,
      reference.createdSequence,
      reference.appliedSequence,
    );
  }

  #upsertArtifactPin(pin: ArtifactPinReadModel): void {
    this.#stmt(
      "INSERT INTO artifact_pin_read_model (" +
        "artifact_pin_id, content_sha256, blob_generation, pin_holder_kind, pin_holder_id, " +
        "acquired_sequence, released_sequence, applied_sequence" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (artifact_pin_id) DO UPDATE SET " +
        "released_sequence = excluded.released_sequence, " +
        "applied_sequence = excluded.applied_sequence",
    ).run(
      pin.artifactPinId,
      pin.contentSha256,
      pin.blobGeneration,
      pin.pinHolderKind,
      pin.pinHolderId,
      pin.acquiredSequence,
      pin.releasedSequence,
      pin.appliedSequence,
    );
  }

  #artifactRowToRecord(row: RegistryEventRow): ArtifactEventRecord {
    const parsed = ArtifactRegistryEvent.safeParse(JSON.parse(row.event_json));
    if (row.subject_kind !== "ARTIFACT" || !parsed.success) {
      throw new LedgerIntegrityError([
        "artifact event at sequence " +
          String(row.sequence) +
          " no longer satisfies the artifact event contract",
      ]);
    }
    return {
      sequence: row.sequence,
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      event: parsed.data,
      canonicalJson: row.event_json,
      previousSha256: row.previous_sha256,
      eventSha256: row.event_sha256,
      causation: causationFromRow(row, row.sequence),
    };
  }

  // -------------------------------------------------------------------------
  // Reading the artifact plane (P-36/local escalón C)
  // -------------------------------------------------------------------------
  //
  // Escalón A left the four tables readable by the fold alone. The private
  // publisher of escalón C cannot work that way: it proposes a generation and an
  // ordinal ("the producer proposes, the ledger verifies"), it reads a reference
  // to authorize a read, and its reconciler finds the intention a crashed
  // command left behind. So the fold's own view is exposed here, read-only, on
  // `getOutboxCommand`'s pattern: no file, no clock, no write, and the door and
  // the fold do not change (ADR 0083). The answers are the tables as they stand
  // outside any transaction; a caller that acts on one does so under the blob
  // lease, which is what keeps it stable.

  /** One generation of some content, or null. */
  getArtifactBlob(contentSha256: string, blobGeneration: number): ArtifactBlobReadModel | null {
    this.#assertOpen("getArtifactBlob");
    return this.#artifactBaseView().blob(
      requireArtifactDigest(contentSha256, "contentSha256"),
      requireArtifactCount(blobGeneration, "blobGeneration"),
    );
  }

  /** The one generation of this content that is not `RECLAIMED`, or null. */
  getUnreclaimedArtifactBlob(contentSha256: string): ArtifactBlobReadModel | null {
    this.#assertOpen("getUnreclaimedArtifactBlob");
    return this.#artifactBaseView().unreclaimedBlob(requireArtifactDigest(contentSha256, "contentSha256"));
  }

  /** The highest generation this content ever had, or zero: a new publication proposes one past it. */
  getHighestArtifactBlobGeneration(contentSha256: string): number {
    this.#assertOpen("getHighestArtifactBlobGeneration");
    return this.#artifactBaseView().highestBlobGeneration(requireArtifactDigest(contentSha256, "contentSha256"));
  }

  /** Every generation in one lifecycle state, in key order. `STAGED` is a publication in flight. */
  listArtifactBlobsInState(lifecycleState: ArtifactBlobReadModel["lifecycleState"]): readonly ArtifactBlobReadModel[] {
    this.#assertOpen("listArtifactBlobsInState");
    if (!(BLOB_LIFECYCLE_STATES as readonly string[]).includes(lifecycleState)) {
      throw new LedgerQueryError("lifecycleState must be one of " + BLOB_LIFECYCLE_STATES.join(", "));
    }
    const rows = this.#stmt(
      "SELECT * FROM artifact_blob_read_model WHERE lifecycle_state = ? ORDER BY content_sha256, blob_generation",
    ).all(lifecycleState) as ArtifactBlobRow[];
    return rows.map(artifactBlobRowToModel);
  }

  /**
   * One reference, or null. Its scope and policy are what authorize a read;
   * knowing a digest authorizes nothing (artifacts §4).
   */
  getArtifactReference(artifactReferenceId: string): ArtifactReferenceReadModel | null {
    this.#assertOpen("getArtifactReference");
    return this.#artifactBaseView().reference(requireArtifactIdentifier(artifactReferenceId, "artifactReferenceId"));
  }

  /** One pin, live or released, or null. */
  getArtifactPin(artifactPinId: string): ArtifactPinReadModel | null {
    this.#assertOpen("getArtifactPin");
    return this.#artifactBaseView().pin(requireArtifactIdentifier(artifactPinId, "artifactPinId"));
  }

  /**
   * Every live pin of one holder kind, in the order they were taken. A live
   * `PUBLICATION` pin is a publication that has neither succeeded nor been
   * abandoned: the reconciler's worklist.
   */
  listLiveArtifactPins(pinHolderKind: ArtifactPinReadModel["pinHolderKind"]): readonly ArtifactPinReadModel[] {
    this.#assertOpen("listLiveArtifactPins");
    if (!(PIN_HOLDER_KINDS as readonly string[]).includes(pinHolderKind)) {
      throw new LedgerQueryError("pinHolderKind must be one of " + PIN_HOLDER_KINDS.join(", "));
    }
    const rows = this.#stmt(
      "SELECT * FROM artifact_pin_read_model WHERE pin_holder_kind = ? AND released_sequence IS NULL " +
        "ORDER BY acquired_sequence, artifact_pin_id",
    ).all(pinHolderKind) as ArtifactPinRow[];
    return rows.map(artifactPinRowToModel);
  }

  /**
   * The events of one artifact subject, in ordinal order — the content digest
   * for a publication, the reference or the pin otherwise. The next ordinal is
   * one past the last; an intention's exact recorded body is here for a retry
   * that must find it rather than append it again. Each row is re-parsed, and a
   * row that no longer satisfies the contract fails closed.
   */
  listArtifactEvents(subjectId: string): readonly ArtifactEventRecord[] {
    this.#assertOpen("listArtifactEvents");
    const rows = this.#stmt(
      "SELECT " +
        REGISTRY_EVENT_COLUMNS +
        " FROM registry_events WHERE document_id = ? AND subject_kind = 'ARTIFACT' ORDER BY document_version",
    ).all(requireArtifactIdentifier(subjectId, "subjectId")) as RegistryEventRow[];
    return rows.map((row) => this.#artifactRowToRecord(row));
  }

  // -------------------------------------------------------------------------
  // Reading the model version registry and the GLOBAL assignment (P-14 A)
  // -------------------------------------------------------------------------
  //
  // Contracts §5 resolves an assignment against a vector of watermarks, never
  // against "the latest". A reading made of separate statements is not a
  // vector: another process may commit between two of them, and the watermark
  // rows returned would describe tables other than the ones the answer came
  // from. So each verb reads everything inside ONE deferred transaction — a
  // read transaction, legal on a `query_only` handle, whose snapshot is fixed
  // by its first read — and returns the watermark rows with the answer
  // (N-P14-3). No clock, no file and no write. `rebuildReadModel` already
  // refuses a broken chain on any of the three streams before it clears a row,
  // so planning §6's rebuild rule needs nothing new here.

  /**
   * One model version with its eligible roles and transports, or null, and the
   * one watermark row it was read at.
   */
  getModelVersion(modelVersionId: string): ModelVersionReading {
    this.#assertOpen("getModelVersion");
    const id = requireArtifactIdentifier(modelVersionId, "modelVersionId");
    const run = this.#db.transaction(
      (): ModelVersionReading => ({
        modelVersion: this.#readModelVersionEntry(id),
        watermarks: this.#readRegistryWatermarks([[MODEL_VERSION_PROJECTION, REGISTRY_STREAM]]),
      }),
    );
    return run();
  }

  /**
   * Every price interval of one catalog version, exactly (P-33/catálogo A, ADR 0091).
   *
   * By document AND version, never by document alone: a lookup inside a pinned
   * version never reads another's rows, and a later version — retroactive or not
   * — is not a row of this one. In primary-key order, from one read transaction,
   * with no clock and no write. A version that holds no row — a document or a
   * version never published, or a version the fold could not read — is an empty
   * list and not an error: whether no price means `PRICE_MISSING` is the
   * resolver's to say, and it says it fail-closed, never as a zero.
   *
   * No watermark travels with the answer, unlike `getModelVersion`: a published
   * version's rows are written once in the transaction of its event and never
   * change, so the pin is the whole of what the answer was read at.
   */
  readPriceIntervals(query: PriceIntervalQuery): readonly PriceIntervalReadModel[] {
    this.#assertOpen("readPriceIntervals");
    const catalogDocumentId = requireArtifactIdentifier(query.catalogDocumentId, "catalogDocumentId");
    const catalogVersion = requireArtifactCount(query.catalogVersion, "catalogVersion");
    const run = this.#db.transaction((): readonly PriceIntervalReadModel[] =>
      (
        this.#stmt(
          "SELECT * FROM price_interval_read_model WHERE catalog_document_id = ? AND catalog_version = ? " +
            "ORDER BY provider, model_version_id, transport_kind, token_class, currency, effective_from",
        ).all(catalogDocumentId, catalogVersion) as PriceIntervalRow[]
      ).map(priceIntervalRowToModel),
    );
    return run();
  }

  /**
   * The catalog version of one `PRICE_TABLE` document in force at an instant (P-15
   * escalón C, ADR 0103), or `null` when none is — no version has taken effect, or
   * two share the greatest `effectiveFrom` and neither may be picked. The instant
   * must be the contract's canonical form, or the query is refused.
   *
   * The same selection the append door holds a dispatch's pin to, over the same rows,
   * so the pin a composition chooses here is the one the door admits. It answers
   * which version rules; whether that version covers a segment is `pinCovers`'
   * question, over `readPriceIntervals`.
   */
  getVigentCatalogPin(catalogDocumentId: string, instant: string): PricePin | null {
    this.#assertOpen("getVigentCatalogPin");
    const documentId = requireArtifactIdentifier(catalogDocumentId, "catalogDocumentId");
    // The door's rule, for the door's reason: an instant in any other spelling would
    // be compared out of order, so it is refused rather than answered.
    if (!isInstant(instant)) {
      throw new LedgerQueryError(
        "instant must be the contract's canonical form, ISO-8601 with milliseconds in UTC ending in Z",
      );
    }
    const selection = selectVigentCatalogVersion(this.#catalogVersions(documentId), instant);
    if (selection.kind !== "VIGENT") return null;
    return { catalogDocumentId: documentId, catalogVersion: selection.catalogVersion };
  }

  /**
   * One recorded version of one configuration document, or null (P-15/R, ADR 0104).
   *
   * The registry publication door reads it before it appends: the same version with
   * the same kind, digest, parent and instant is a replay, and a version that differs
   * in any of them is a conflict, never a second version. Read by coordinate, so the
   * answer does not depend on which idempotency key the version was written under.
   */
  getRegistryDocumentVersion(documentId: string, documentVersion: number): RegistryEventRecord | null {
    this.#assertOpen("getRegistryDocumentVersion");
    const id = requireArtifactIdentifier(documentId, "documentId");
    const version = requireArtifactCount(documentVersion, "documentVersion");
    const row = this.#stmt(
      "SELECT " +
        REGISTRY_EVENT_COLUMNS +
        " FROM registry_events WHERE subject_kind = 'DOCUMENT' AND document_id = ? AND document_version = ?",
    ).get(id, version) as RegistryEventRow | undefined;
    return row === undefined ? null : this.#registryRowToRecord(row);
  }

  /**
   * The GLOBAL assignment in force for one `(role, slot)`, its fallbacks, the
   * model version it names, and the three watermark rows the answer was read at:
   * the model version registry on the registry stream, and both heads of the
   * routing projection.
   *
   * No assignment in force is an answer, not an error: `assignment` is null and
   * the vector is returned all the same. Two assignments in force for the same
   * coordinate — two documents, or two branches of one — is a question with no
   * single answer, and is refused rather than settled by picking one.
   */
  getGlobalRoutingAssignment(query: { readonly role: string; readonly slot: number }): GlobalRoutingAssignmentReading {
    this.#assertOpen("getGlobalRoutingAssignment");
    const role = query.role;
    const slot = query.slot;
    if (typeof role !== "string" || !(WORKER_ROLES as readonly string[]).includes(role)) {
      throw new LedgerQueryError("role must be one of " + WORKER_ROLES.join(", "));
    }
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new LedgerQueryError("slot must be an integer of zero or greater");
    }

    const run = this.#db.transaction((): GlobalRoutingAssignmentReading => {
      const current = this.#stmt(
        "SELECT * FROM routing_assignment_read_model " +
          "WHERE scope_kind = 'GLOBAL' AND scope_id IS NULL AND role = ? AND slot = ? AND superseded_by IS NULL " +
          "ORDER BY assignment_id",
      ).all(role, slot) as RoutingAssignmentRow[];
      const watermarks = this.#readRegistryWatermarks([
        [MODEL_VERSION_PROJECTION, REGISTRY_STREAM],
        [ROUTING_ASSIGNMENT_PROJECTION, INITIATIVE_STREAM],
        [ROUTING_ASSIGNMENT_PROJECTION, REGISTRY_STREAM],
      ]);

      if (current.length > 1) {
        throw new LedgerQueryError(
          String(current.length) +
            " GLOBAL routing assignments are in force for role " +
            role +
            " slot " +
            String(slot) +
            "; nothing resolves until one supersedes the others",
        );
      }
      const row = current[0];
      if (row === undefined) {
        return { assignment: null, fallbacks: [], modelVersion: null, watermarks };
      }

      const assignment = routingAssignmentRowToModel(row);
      const fallbacks = (
        this.#stmt(
          "SELECT * FROM routing_assignment_fallback WHERE assignment_id = ? ORDER BY ordinal",
        ).all(assignment.assignmentId) as RoutingFallbackRow[]
      ).map((fallback) => fallback.model_version_id);
      return {
        assignment,
        fallbacks,
        modelVersion: this.#readModelVersionEntry(assignment.modelVersionId),
        watermarks,
      };
    });
    return run();
  }

  #readModelVersionEntry(modelVersionId: string): ModelVersionEntry | null {
    const row = this.#stmt("SELECT * FROM model_version_read_model WHERE model_version_id = ?").get(
      modelVersionId,
    ) as ModelVersionRow | undefined;
    if (row === undefined) return null;
    const roles = this.#stmt(
      "SELECT * FROM model_version_eligible_role WHERE model_version_id = ? ORDER BY ordinal",
    ).all(modelVersionId) as ModelVersionEligibleRoleDbRow[];
    const transports = this.#stmt(
      "SELECT * FROM model_version_transport WHERE model_version_id = ? ORDER BY ordinal",
    ).all(modelVersionId) as ModelVersionTransportDbRow[];
    return {
      row: modelVersionRowToModel(row),
      eligibleRoles: roles.map((entry) => modelVersionRoleRowToModel(entry).role),
      transports: transports.map((entry) => entry.transport_kind),
    };
  }

  /**
   * The named watermark rows, in the table's own order. A pair this build
   * publishes and the table does not hold is the ledger failing its own
   * integrity, and a reading taken against a missing head is refused.
   */
  #readRegistryWatermarks(
    pairs: readonly (readonly [string, string])[],
  ): readonly RegistryWatermarkReading[] {
    const select = this.#stmt(
      "SELECT " + WATERMARK_COLUMNS + " FROM projection_watermark WHERE projection_name = ? AND source_stream = ?",
    );
    const readings = pairs.map(([projectionName, sourceStream]): RegistryWatermarkReading => {
      const row = select.get(projectionName, sourceStream) as WatermarkRow | undefined;
      if (row === undefined) {
        throw new LedgerIntegrityError([
          "projection_watermark is missing the row for " + projectionName + " on " + sourceStream,
        ]);
      }
      return {
        projectionName: row.projection_name,
        sourceStream: row.source_stream,
        appliedThroughSequence: row.applied_sequence,
        eventCount: row.event_count,
        sourceHeadSha256: row.source_head_sha256,
      };
    });
    return readings.sort((a, b) =>
      a.projectionName === b.projectionName
        ? a.sourceStream < b.sourceStream
          ? -1
          : 1
        : a.projectionName < b.projectionName
          ? -1
          : 1,
    );
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  /**
   * Walk the entire event stream in bounded pages, validating every row and
   * the whole hash chain, and hand each valid event to the caller.
   *
   * Reading in pages rather than with one open cursor is deliberate: the
   * rebuild path writes while it walks, and a long-lived read cursor would
   * block those writes on the same connection.
   */
  #replay(onEvent: (event: ControlPlaneEvent, row: EventRow) => void): ReplayOutcome {
    const problems: IntegrityProblem[] = [];
    let checked = 0;
    let previous = GENESIS_SHA256;
    let expectedSequence = 1;
    let cursor = 0;

    const select = this.#stmt(
      "SELECT " +
        EVENT_COLUMNS +
        " FROM control_plane_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    );

    for (;;) {
      const rows = select.all(cursor, REPLAY_BATCH_SIZE) as EventRow[];
      if (rows.length === 0) break;

      for (const row of rows) {
        cursor = row.sequence;

        if (row.sequence !== expectedSequence) {
          problems.push({
            kind: "SEQUENCE",
            detail:
              "expected sequence " +
              String(expectedSequence) +
              " but found " +
              String(row.sequence) +
              ", so the log is not contiguous",
            sequence: row.sequence,
          });
          expectedSequence = row.sequence;
        }
        expectedSequence += 1;
        checked += 1;

        const shapeProblems = this.#validateRowShape(row);
        if (shapeProblems.length > 0) problems.push(...shapeProblems);

        // The chain checks do not depend on the body being well formed, and
        // they are the strongest evidence available, so they always run. An
        // earlier version skipped them once a row already had a shape problem,
        // which meant a rewritten body reported only that its columns
        // disagreed and never that its digest no longer matched its content.
        if (row.previous_sha256 !== previous) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "sequence " +
              String(row.sequence) +
              " records previous digest " +
              row.previous_sha256 +
              " but the chain has reached " +
              previous,
            sequence: row.sequence,
          });
        }

        const recomputed = chainDigest(row.previous_sha256, row.event_json);
        if (recomputed !== row.event_sha256) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "sequence " +
              String(row.sequence) +
              " records digest " +
              row.event_sha256 +
              " but its stored content hashes to " +
              recomputed,
            sequence: row.sequence,
          });
        }

        previous = row.event_sha256;

        // Only a row that passed every shape check can be projected. An
        // unparseable or contract-violating body has nothing to replay.
        if (shapeProblems.length === 0) {
          const parsed = ControlPlaneEvent.safeParse(JSON.parse(row.event_json));
          if (parsed.success) onEvent(parsed.data, row);
        }
      }
    }

    return { problems, checked, lastSequence: cursor, lastSha256: previous };
  }

  /**
   * Walk the initiative stream the way `#replay` walks the task stream.
   *
   * Separate rather than generic: the two streams have different columns,
   * different coordinate checks and different contracts, and a shared walker
   * would have to be told which at every step. What they do share — the
   * canonical-form check, the chain arithmetic, the contiguity rule — is
   * mirrored deliberately, and a divergence between them is a defect.
   */
  #replayInitiative(onEvent: (event: InitiativeEvent, row: InitiativeEventRow) => void): ReplayOutcome {
    const problems: IntegrityProblem[] = [];
    let checked = 0;
    let previous = GENESIS_SHA256;
    let expectedSequence = 1;
    let cursor = 0;

    const select = this.#stmt(
      "SELECT " +
        INITIATIVE_EVENT_COLUMNS +
        " FROM initiative_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    );

    for (;;) {
      const rows = select.all(cursor, REPLAY_BATCH_SIZE) as InitiativeEventRow[];
      if (rows.length === 0) break;

      for (const row of rows) {
        cursor = row.sequence;

        if (row.sequence !== expectedSequence) {
          problems.push({
            kind: "SEQUENCE",
            detail:
              "initiative_events expected sequence " +
              String(expectedSequence) +
              " but found " +
              String(row.sequence) +
              ", so the stream is not contiguous",
            sequence: row.sequence,
          });
          expectedSequence = row.sequence;
        }
        expectedSequence += 1;
        checked += 1;

        const shapeProblems = this.#validateInitiativeRowShape(row);
        if (shapeProblems.length > 0) problems.push(...shapeProblems);

        if (row.previous_sha256 !== previous) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "initiative sequence " +
              String(row.sequence) +
              " records previous digest " +
              row.previous_sha256 +
              " but the chain has reached " +
              previous,
            sequence: row.sequence,
          });
        }

        const recomputed = chainDigest(row.previous_sha256, row.event_json);
        if (recomputed !== row.event_sha256) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "initiative sequence " +
              String(row.sequence) +
              " records digest " +
              row.event_sha256 +
              " but its stored content hashes to " +
              recomputed,
            sequence: row.sequence,
          });
        }

        previous = row.event_sha256;

        if (shapeProblems.length === 0) {
          const parsed = InitiativeEvent.safeParse(JSON.parse(row.event_json));
          if (parsed.success) onEvent(parsed.data, row);
        }
      }
    }

    return { problems, checked, lastSequence: cursor, lastSha256: previous };
  }

  #validateInitiativeRowShape(row: InitiativeEventRow): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " holds event_json that is not valid JSON",
        sequence: row.sequence,
      });
      return problems;
    }

    let canonical: string;
    try {
      canonical = canonicalJsonStringify(decoded);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " holds event_json that is not canonicalizable",
        sequence: row.sequence,
      });
      return problems;
    }

    if (canonical !== row.event_json) {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " holds event_json that is not in canonical form, so it was rewritten after it was appended",
        sequence: row.sequence,
      });
    }

    const parsed = InitiativeEvent.safeParse(decoded);
    if (!parsed.success) {
      problems.push({
        kind: "EVENT_CONTRACT",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " holds an event that no longer satisfies the InitiativeEvent contract",
        sequence: row.sequence,
      });
      return problems;
    }

    const event = parsed.data;
    const mismatches: string[] = [];
    if (event.eventId !== row.event_id) mismatches.push("event_id");
    if (event.idempotencyKey !== row.idempotency_key) mismatches.push("idempotency_key");
    if (event.initiativeId !== row.initiative_id) mismatches.push("initiative_id");
    if (event.transitionId !== row.transition_id) mismatches.push("transition_id");
    if (event.type !== row.type) mismatches.push("type");
    if (event.fromStatus !== row.from_status) mismatches.push("from_status");
    if (event.toStatus !== row.to_status) mismatches.push("to_status");
    if (event.emittedBy !== row.emitted_by) mismatches.push("emitted_by");
    if (event.occurredAt !== row.occurred_at) mismatches.push("occurred_at");
    if (event.recordedAt !== row.recorded_at) mismatches.push("recorded_at");
    if (event.contractVersion !== row.contract_version) mismatches.push("contract_version");

    if (mismatches.length > 0) {
      problems.push({
        kind: "EVENT_COORDINATES",
        detail:
          "initiative sequence " +
          String(row.sequence) +
          " has indexed columns that disagree with its stored event: " +
          mismatches.join(", "),
        sequence: row.sequence,
      });
    }

    return problems;
  }

  /**
   * Walk the registry stream the way the other two walkers walk theirs.
   *
   * Separate for the reason `#replayInitiative` is separate from `#replay`:
   * three streams, three sets of columns, three coordinate checks. What they
   * share — the canonical-form check, the chain arithmetic, the contiguity
   * rule — is mirrored deliberately, and a divergence between them is a defect.
   */
  #replayRegistry(
    onDocument: (document: RegistryDocument, row: RegistryEventRow) => void,
    onArtifact: (event: ArtifactRegistryEvent, row: RegistryEventRow) => void,
  ): ReplayOutcome {
    const problems: IntegrityProblem[] = [];
    let checked = 0;
    let previous = GENESIS_SHA256;
    let expectedSequence = 1;
    let cursor = 0;

    const select = this.#stmt(
      "SELECT " +
        REGISTRY_EVENT_COLUMNS +
        " FROM registry_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    );

    for (;;) {
      const rows = select.all(cursor, REPLAY_BATCH_SIZE) as RegistryEventRow[];
      if (rows.length === 0) break;

      for (const row of rows) {
        cursor = row.sequence;

        if (row.sequence !== expectedSequence) {
          problems.push({
            kind: "SEQUENCE",
            detail:
              "registry_events expected sequence " +
              String(expectedSequence) +
              " but found " +
              String(row.sequence) +
              ", so the stream is not contiguous",
            sequence: row.sequence,
          });
          expectedSequence = row.sequence;
        }
        expectedSequence += 1;
        checked += 1;

        const shapeProblems = this.#validateRegistryRowShape(row);
        if (shapeProblems.length > 0) problems.push(...shapeProblems);

        if (row.previous_sha256 !== previous) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "registry sequence " +
              String(row.sequence) +
              " records previous digest " +
              row.previous_sha256 +
              " but the chain has reached " +
              previous,
            sequence: row.sequence,
          });
        }

        const recomputed = chainDigest(row.previous_sha256, row.event_json);
        if (recomputed !== row.event_sha256) {
          problems.push({
            kind: "HASH_CHAIN",
            detail:
              "registry sequence " +
              String(row.sequence) +
              " records digest " +
              row.event_sha256 +
              " but its stored content hashes to " +
              recomputed,
            sequence: row.sequence,
          });
        }

        previous = row.event_sha256;

        if (shapeProblems.length === 0) {
          // The column decides the plane, and the shape check above has already
          // held the body to the same plane (P-36/local A).
          if (row.subject_kind === "ARTIFACT") {
            const parsed = ArtifactRegistryEvent.safeParse(JSON.parse(row.event_json));
            if (parsed.success) onArtifact(parsed.data, row);
          } else {
            const document = tryNormalizeRegistryDocument(JSON.parse(row.event_json));
            if (document !== null) onDocument(document, row);
          }
        }
      }
    }

    return { problems, checked, lastSequence: cursor, lastSha256: previous };
  }

  #validateRegistryRowShape(row: RegistryEventRow): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    let decoded: unknown;
    try {
      decoded = JSON.parse(row.event_json);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "registry sequence " + String(row.sequence) + " holds event_json that is not valid JSON",
        sequence: row.sequence,
      });
      return problems;
    }

    let canonical: string;
    try {
      canonical = canonicalJsonStringify(decoded);
    } catch {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "registry sequence " +
          String(row.sequence) +
          " holds event_json that is not canonicalizable",
        sequence: row.sequence,
      });
      return problems;
    }

    if (canonical !== row.event_json) {
      problems.push({
        kind: "EVENT_JSON",
        detail:
          "registry sequence " +
          String(row.sequence) +
          " holds event_json that is not in canonical form, so it was rewritten after it was appended",
        sequence: row.sequence,
      });
    }

    if (row.subject_kind === "ARTIFACT") {
      problems.push(...this.#validateArtifactRowShape(row, decoded));
      return problems;
    }

    const document = tryNormalizeRegistryDocument(decoded);
    if (document === null) {
      problems.push({
        kind: "EVENT_CONTRACT",
        detail:
          "registry sequence " +
          String(row.sequence) +
          " holds a document that no longer satisfies the registry document shape",
        sequence: row.sequence,
      });
      return problems;
    }

    const mismatches: string[] = [];
    if (document.eventId !== row.event_id) mismatches.push("event_id");
    if (document.idempotencyKey !== row.idempotency_key) mismatches.push("idempotency_key");
    if (row.subject_kind !== "DOCUMENT") mismatches.push("subject_kind");
    if (document.documentKind !== row.document_kind) mismatches.push("document_kind");
    if (row.artifact_event_kind !== null) mismatches.push("artifact_event_kind");
    if (document.documentId !== row.document_id) mismatches.push("document_id");
    if (document.documentVersion !== row.document_version) mismatches.push("document_version");
    if (document.contentDigest !== row.content_digest) mismatches.push("content_digest");
    if (document.parentDocumentVersion !== row.parent_document_version) {
      mismatches.push("parent_document_version");
    }
    if (document.recordedBy !== row.recorded_by) mismatches.push("recorded_by");
    if (document.effectiveFrom !== row.effective_from) mismatches.push("effective_from");
    if (document.occurredAt !== row.occurred_at) mismatches.push("occurred_at");
    if (document.recordedAt !== row.recorded_at) mismatches.push("recorded_at");
    if (document.contractVersion !== row.contract_version) mismatches.push("contract_version");

    if (mismatches.length > 0) {
      problems.push({
        kind: "EVENT_COORDINATES",
        detail:
          "registry sequence " +
          String(row.sequence) +
          " has indexed columns that disagree with its stored document: " +
          mismatches.join(", "),
        sequence: row.sequence,
      });
    }

    return problems;
  }

  /**
   * The artifact half of a registry row's shape check (P-36/local A).
   *
   * The door's refusal of an undelivered kind first, in the door's words, so a
   * planted reclamation or tombstone fails a rebuild saying what the door would
   * have said. Then the contract, then every indexed column against the body it
   * was derived from — `subject_kind` and `artifact_event_kind` included,
   * because both columns sit outside the preimage the chain digests.
   */
  #validateArtifactRowShape(row: RegistryEventRow, decoded: unknown): IntegrityProblem[] {
    const kindRefusal = isPlainObject(decoded)
      ? artifactEventKindRefusal(decoded["artifactEventKind"])
      : null;
    if (kindRefusal !== null) {
      return [
        {
          kind: "EVENT_CONTRACT",
          detail:
            "registry sequence " +
            String(row.sequence) +
            " holds an artifact event this build refuses: " +
            kindRefusal.path +
            ": " +
            kindRefusal.message,
          sequence: row.sequence,
        },
      ];
    }

    const parsed = ArtifactRegistryEvent.safeParse(decoded);
    if (!parsed.success) {
      const version = unsupportedContractVersion(decoded);
      return [
        {
          kind: "EVENT_CONTRACT",
          detail:
            version === null
              ? "registry sequence " +
                String(row.sequence) +
                " holds an artifact event that no longer satisfies the artifact event contract"
              : "registry sequence " +
                String(row.sequence) +
                " is stamped contract version " +
                version +
                ", which this build does not read; the supported versions are " +
                supportedVersionList(),
          sequence: row.sequence,
        },
      ];
    }

    const event = parsed.data;
    const subject = artifactSubjectOf(event);
    const mismatches: string[] = [];
    if (event.eventId !== row.event_id) mismatches.push("event_id");
    if (event.idempotencyKey !== row.idempotency_key) mismatches.push("idempotency_key");
    if (event.subjectKind !== row.subject_kind) mismatches.push("subject_kind");
    if (row.document_kind !== null) mismatches.push("document_kind");
    if (event.artifactEventKind !== row.artifact_event_kind) mismatches.push("artifact_event_kind");
    if (subject.documentId !== row.document_id) mismatches.push("document_id");
    if (event.subjectOrdinal !== row.document_version) mismatches.push("document_version");
    if (subject.contentDigest !== row.content_digest) mismatches.push("content_digest");
    if (event.parentSubjectOrdinal !== row.parent_document_version) {
      mismatches.push("parent_document_version");
    }
    if (event.recordedBy !== row.recorded_by) mismatches.push("recorded_by");
    if (event.occurredAt !== row.effective_from) mismatches.push("effective_from");
    if (event.occurredAt !== row.occurred_at) mismatches.push("occurred_at");
    if (event.recordedAt !== row.recorded_at) mismatches.push("recorded_at");
    if (event.contractVersion !== row.contract_version) mismatches.push("contract_version");

    if (mismatches.length === 0) return [];
    return [
      {
        kind: "EVENT_COORDINATES",
        detail:
          "registry sequence " +
          String(row.sequence) +
          " has indexed columns that disagree with its stored artifact event: " +
          mismatches.join(", "),
        sequence: row.sequence,
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Rebuild
  // -------------------------------------------------------------------------

  /**
   * Drop every derived projection and replay the ledger into a fresh one.
   *
   * Transactional from end to end. If validation, replay or any write fails,
   * the previous projection is still there untouched, because a control plane
   * that loses its read model during a repair is worse off than one that never
   * attempted the repair.
   *
   * A ledger whose head metadata disagrees with its actual tail is refused
   * rather than quietly rebuilt. Rebuilding a truncated log would produce a
   * clean looking read model over a history that is missing events, which is
   * exactly the failure this package exists to make impossible.
   */
  rebuildReadModel(): RebuildResult {
    this.#assertOpen("rebuildReadModel");
    this.#assertWritable("rebuildReadModel");

    const run = this.#db.transaction((): RebuildResult => {
      const snapshot = createProjectionSnapshot();
      // The outbox commands have no table to rebuild, and are folded anyway: a
      // stored history the append door would have refused must fail the rebuild
      // too, at the event that caused it (P-18/F).
      const outbox = createOutboxFold();
      let lastRecordedAt = EPOCH_TIMESTAMP;

      const replay = this.#replay((event, row) => {
        applyEventToSnapshot(snapshot, event, row.sequence, row.event_sha256);
        applyEventToOutboxFold(outbox, {
          event,
          sequence: row.sequence,
          sha256: row.event_sha256,
          // Only an outbox event is anchored by its reference; every other type
          // is offered for its position alone.
          causation: OUTBOX_EVENT_TYPES.includes(event.type) ? causationFromRow(row, row.sequence) : null,
        });
        lastRecordedAt = event.recordedAt;
      });

      // Both chains are replayed before anything is cleared, and both are
      // required to be sound: a rebuild that repaired one stream while the
      // other was corrupt would hand back a clean-looking read model over a
      // ledger that is not clean.
      const initiativeSnapshot = createInitiativeProjectionSnapshot();
      let lastInitiativeRecordedAt = EPOCH_TIMESTAMP;

      const initiativeReplay = this.#replayInitiative((event, row) => {
        applyInitiativeEventToSnapshot(initiativeSnapshot, event, row.sequence);
        lastInitiativeRecordedAt = event.recordedAt;
      });

      // And the third, on the same terms. A rebuild is a function of the whole
      // VECTOR of heads: all three chains are replayed before anything is
      // cleared, and any one of them being unsound refuses the rebuild.
      const registrySnapshot = createRegistryProjectionSnapshot();
      // The registry stream's artifact plane, folded in the same walk: one chain,
      // two planes, and the order of the rows is the order of the fold.
      const artifactSnapshot = createArtifactProjectionSnapshot();
      // And the model version registry (P-14 A), from the same documents.
      const modelVersionSnapshot = createModelVersionProjectionSnapshot();
      // And the price catalog (P-33/catálogo A), from the same documents.
      const priceIntervalSnapshot = createPriceIntervalProjectionSnapshot();
      let lastRegistryRecordedAt = EPOCH_TIMESTAMP;

      const registryReplay = this.#replayRegistry(
        (document, row) => {
          applyRegistryEventToSnapshot(registrySnapshot, document, row.sequence);
          applyRegistryModelVersionToSnapshot(modelVersionSnapshot, document, row.sequence);
          applyRegistryPriceIntervalToSnapshot(priceIntervalSnapshot, document, row.sequence);
          lastRegistryRecordedAt = document.recordedAt;
        },
        (event, row) => {
          applyArtifactEventToSnapshot(artifactSnapshot, event, row.sequence);
          lastRegistryRecordedAt = event.recordedAt;
        },
      );

      const problems = [
        ...replay.problems,
        ...initiativeReplay.problems,
        ...registryReplay.problems,
      ].map((problem) => problem.detail);

      const registryHead = this.#readRegistryHead();
      if (registryHead.sequence !== registryReplay.lastSequence) {
        problems.push(
          "registry head is sequence " +
            String(registryHead.sequence) +
            " but the last stored registry event is sequence " +
            String(registryReplay.lastSequence),
        );
      }
      if (registryHead.sha256 !== registryReplay.lastSha256) {
        problems.push(
          "registry head digest " +
            registryHead.sha256 +
            " does not match the replayed registry chain head",
        );
      }
      if (registryHead.count !== registryReplay.checked) {
        problems.push(
          "registry head counts " +
            String(registryHead.count) +
            " events but " +
            String(registryReplay.checked) +
            " are stored",
        );
      }

      const initiativeHead = this.#readInitiativeHead();
      if (initiativeHead.sequence !== initiativeReplay.lastSequence) {
        problems.push(
          "initiative head is sequence " +
            String(initiativeHead.sequence) +
            " but the last stored initiative event is sequence " +
            String(initiativeReplay.lastSequence),
        );
      }
      if (initiativeHead.sha256 !== initiativeReplay.lastSha256) {
        problems.push(
          "initiative head digest " +
            initiativeHead.sha256 +
            " does not match the replayed initiative chain head",
        );
      }
      if (initiativeHead.count !== initiativeReplay.checked) {
        problems.push(
          "initiative head counts " +
            String(initiativeHead.count) +
            " events but " +
            String(initiativeReplay.checked) +
            " are stored",
        );
      }

      const head = this.#readHead();
      if (head.sequence !== replay.lastSequence) {
        problems.push(
          "ledger head is sequence " +
            String(head.sequence) +
            " but the last stored event is sequence " +
            String(replay.lastSequence),
        );
      }
      if (head.sha256 !== replay.lastSha256) {
        problems.push(
          "ledger head digest " + head.sha256 + " does not match the replayed chain head",
        );
      }
      if (head.count !== replay.checked) {
        problems.push(
          "ledger head counts " +
            String(head.count) +
            " events but " +
            String(replay.checked) +
            " are stored",
        );
      }

      if (problems.length > 0) {
        // Refuse before touching the projection. Rebuilding from an untrusted
        // log would launder corruption into a clean looking read model.
        throw new LedgerIntegrityError(problems);
      }

      // Only derived tables are cleared. The event table has no DELETE path at
      // all: the append-only trigger would abort this statement if it were
      // ever aimed at control_plane_events.
      for (const table of DERIVED_TABLES) {
        this.#stmt("DELETE FROM " + table).run();
      }

      for (const task of snapshot.tasks.values()) this.#upsertTask(task);
      for (const worker of snapshot.workers.values()) this.#upsertWorker(worker);
      for (const pair of snapshot.workerTasks.values()) this.#upsertWorkerTask(pair);
      for (const route of snapshot.executionRoutes.values()) this.#upsertExecutionRoute(route);
      // The revision rows the replay folded. `DERIVED_TABLES` cleared the table
      // above, so every insert here lands on an empty coordinate — the
      // conflict branch of `#insertTaskRevision` cannot fire, and a history the
      // snapshot already refused never reaches this loop at all.
      for (const revision of snapshot.taskRevisions.values()) this.#insertTaskRevision(revision);
      // The attempt rows, after the revisions they reference. `DERIVED_TABLES`
      // cleared both above — the attempt table first, because it is the child —
      // so every insert here lands on an empty coordinate and the conflict
      // branch of `#insertTaskAttempt` cannot fire. A history the snapshot
      // already refused never reaches this loop at all, which is the half of
      // N-P18-8 that makes two rebuilds identical rather than merely equal.
      for (const attempt of snapshot.taskAttempts.values()) this.#insertTaskAttempt(attempt);
      // The client keys (P-14 C). Cleared above; every insert lands on an empty
      // key, and a second row under one key the snapshot already refused never
      // reaches this loop.
      for (const submission of snapshot.taskSubmissions.values()) this.#insertTaskSubmission(submission);
      // The P-18/protocolo C cohort, parent-first. `DERIVED_TABLES` cleared all
      // three above — children first, because the foreign keys point upward —
      // so every insert here lands on an empty coordinate and no conflict
      // branch can fire. The deliveries are written with the state the fold
      // left them in rather than being reinserted `INTENDED` and replayed
      // forward: the snapshot already applied every resolution, and a second
      // pass through `#applyDispatchOutcome` would be a second authority on
      // what the fold decided.
      for (const segment of snapshot.routeSegments.values()) this.#insertRouteSegment(segment);
      for (const effect of snapshot.effects.values()) this.#insertEffect(effect);
      for (const dispatch of snapshot.dispatchAttempts.values()) {
        this.#insertDispatchAttempt(dispatch);
      }
      // The P-18/protocolo D pair, after the deliveries they hang off and the
      // prompts before their answers. Cleared above children-first; every insert
      // lands on an empty key, and a second answer the snapshot already refused
      // never reaches this loop.
      for (const prompt of snapshot.promptOccurrences.values()) {
        this.#insertPromptOccurrence(prompt);
      }
      for (const response of snapshot.responseOccurrences.values()) {
        this.#insertResponseOccurrence(response);
      }
      // The P-32/captura B cohort, after the effects and the deliveries it hangs
      // off, parents first: the streams, the observations in the order the replay
      // recorded them — a correction after its target — and each revision's
      // header before its cut and its list, through the door's own writer. Cleared
      // above children-first; every insert lands on an empty key.
      const writeUsage = (sql: string): Database.Statement => this.#stmt(sql);
      for (const stream of snapshot.usageStreams.values()) {
        writeUsageCapture(writeUsage, { stream, observation: null, settlement: null });
      }
      for (const observation of snapshot.usageObservations.values()) {
        writeUsageCapture(writeUsage, { stream: null, observation, settlement: null });
      }
      for (const header of snapshot.usageSettlements.values()) {
        writeUsageSettlement(writeUsage, { header, sourceHeads: [], observations: [] });
      }
      for (const head of snapshot.usageSettlementSourceHeads.values()) {
        writeUsageSettlementSourceHead(writeUsage, head);
      }
      for (const considered of snapshot.usageSettlementObservations.values()) {
        writeUsageSettlementObservation(writeUsage, considered);
      }

      for (const initiative of initiativeSnapshot.initiatives.values()) {
        this.#upsertInitiative(initiative);
      }
      for (const version of initiativeSnapshot.roadmapVersions.values()) {
        this.#upsertRoadmapVersion(version);
      }

      // One table, two partitions, written from the two snapshots that folded
      // them. The partitions are disjoint by
      // `ck_routing_assignment_read_model__source_scope`, so this is a union
      // and never a merge: neither source can write a row the other owns, and
      // the initiative side is empty by construction in this build.
      const routingAssignments = mergeRoutingAssignments(registrySnapshot, initiativeSnapshot);
      const routingFallbacks = mergeRoutingFallbacks(registrySnapshot, initiativeSnapshot);
      // The parent rows go in before the fallbacks, because the fallback table
      // is the child of a foreign key and `foreign_keys` is ON.
      for (const assignment of routingAssignments.values()) {
        this.#upsertRoutingAssignment(assignment);
      }
      for (const fallback of routingFallbacks.values()) this.#insertRoutingFallback(fallback);

      // The artifact plane, parents first: every blob before the references and
      // pins that name it. `DERIVED_TABLES` cleared the four tables children
      // first, so each insert lands on an empty key; the tombstone table stays
      // empty because nothing in this build folds a row into it.
      for (const blob of artifactSnapshot.blobs.values()) this.#upsertArtifactBlob(blob);
      for (const reference of artifactSnapshot.references.values()) {
        this.#insertArtifactReference(reference);
      }
      for (const pin of artifactSnapshot.pins.values()) this.#upsertArtifactPin(pin);

      // The model version registry, through the door's own writer. Cleared above
      // children first; each version lands with its children under it. No
      // eligibility is checked on the way: a rebuild folds what the door
      // admitted, and an assignment whose model was retired afterwards is still
      // history (N-P14A-7).
      for (const [modelVersionId, row] of modelVersionSnapshot.modelVersions) {
        writeModelVersionProjection((sql) => this.#stmt(sql), {
          modelVersionId,
          row,
          eligibleRoles: modelVersionSnapshot.eligibleRoles.get(modelVersionId) ?? [],
          transports: modelVersionSnapshot.transports.get(modelVersionId) ?? [],
        });
      }

      // The price catalog, through the door's own writer, one row at a time in
      // the snapshot's order. Cleared above; no model version is looked up on the
      // way, for the reason just given: a rebuild folds what the door admitted.
      for (const row of priceIntervalSnapshot.intervals.values()) {
        writePriceIntervalProjection((sql) => this.#stmt(sql), {
          catalogDocumentId: row.catalogDocumentId,
          catalogVersion: row.catalogVersion,
          rows: [row],
        });
      }

      // The watermark rows are deleted and written back, not updated in place.
      // A rebuild regenerates the derived tables from the log, so there is no
      // partial watermark worth keeping, and a row belonging to a projection
      // this build no longer defines would survive an UPDATE that never named
      // it.
      this.#rewriteWatermarks(
        {
          sequence: replay.lastSequence,
          count: replay.checked,
          sha256: replay.lastSha256,
          updatedAt: lastRecordedAt,
        },
        {
          sequence: initiativeReplay.lastSequence,
          count: initiativeReplay.checked,
          sha256: initiativeReplay.lastSha256,
          updatedAt: lastInitiativeRecordedAt,
        },
        {
          sequence: registryReplay.lastSequence,
          count: registryReplay.checked,
          sha256: registryReplay.lastSha256,
          updatedAt: lastRegistryRecordedAt,
        },
      );

      this.#faults.beforeRebuildCommit?.();

      return {
        replayedEvents: replay.checked,
        throughSequence: replay.lastSequence,
        taskRows: snapshot.tasks.size,
        workerRows: snapshot.workers.size,
        executionRouteRows: snapshot.executionRoutes.size,
        replayedInitiativeEvents: initiativeReplay.checked,
        initiativeThroughSequence: initiativeReplay.lastSequence,
        initiativeRows: initiativeSnapshot.initiatives.size,
        roadmapVersionRows: initiativeSnapshot.roadmapVersions.size,
        replayedRegistryEvents: registryReplay.checked,
        registryThroughSequence: registryReplay.lastSequence,
        routingAssignmentRows: routingAssignments.size,
        routingFallbackRows: routingFallbacks.size,
        artifactBlobRows: artifactSnapshot.blobs.size,
        artifactReferenceRows: artifactSnapshot.references.size,
        artifactPinRows: artifactSnapshot.pins.size,
        artifactTombstoneRows: artifactSnapshot.tombstones.size,
        modelVersionRows: modelVersionSnapshot.modelVersions.size,
        modelVersionEligibleRoleRows: [...modelVersionSnapshot.eligibleRoles.values()].reduce(
          (total, roles) => total + roles.length,
          0,
        ),
        modelVersionTransportRows: [...modelVersionSnapshot.transports.values()].reduce(
          (total, transports) => total + transports.length,
          0,
        ),
        priceIntervalRows: priceIntervalSnapshot.intervals.size,
      };
    });

    return run.immediate();
  }

  // -------------------------------------------------------------------------
  // Integrity
  // -------------------------------------------------------------------------

  /**
   * Verify everything that can be verified, and report rather than throw.
   *
   * Reporting is the right shape here: an operator investigating a suspect
   * ledger needs the full list of what is wrong, not the first thing that was
   * wrong. The checks cover the database itself, the migration set, every
   * stored body against its canonical form and the contract, the full hash
   * chain, sequence contiguity, the head and count metadata, and finally the
   * stored projections against a fresh replay.
   */
  verifyIntegrity(): IntegrityReport {
    this.#assertOpen("verifyIntegrity");

    const problems: IntegrityProblem[] = [];

    const integrityRows = this.#db.pragma("integrity_check") as {
      readonly integrity_check: string;
    }[];
    for (const row of integrityRows) {
      if (row.integrity_check !== "ok") {
        problems.push({
          kind: "SQLITE_INTEGRITY",
          detail: "sqlite integrity_check reported: " + row.integrity_check,
          sequence: null,
        });
      }
    }

    const foreignKeyRows = this.#db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyRows.length > 0) {
      problems.push({
        kind: "FOREIGN_KEY",
        detail:
          "foreign_key_check reported " +
          String(foreignKeyRows.length) +
          " violation(s) in the derived tables",
        sequence: null,
      });
    }

    const conformance = checkMigrationConformance(readAppliedMigrations(this.#db));
    for (const problem of conformance.problems) {
      problems.push({ kind: "MIGRATION", detail: problem, sequence: null });
    }
    for (const migration of conformance.missing) {
      problems.push({
        kind: "MIGRATION",
        detail:
          "migration " + String(migration.version) + " " + migration.name + " is not applied",
        sequence: null,
      });
    }

    problems.push(...this.#checkSchemaShape());

    const snapshot = createProjectionSnapshot();
    const outbox = createOutboxFold();
    const replay = this.#replay((event, row) => {
      applyEventToSnapshot(snapshot, event, row.sequence, row.event_sha256);
      applyEventToOutboxFold(outbox, {
        event,
        sequence: row.sequence,
        sha256: row.event_sha256,
        causation: OUTBOX_EVENT_TYPES.includes(event.type) ? causationFromRow(row, row.sequence) : null,
      });
    });
    problems.push(...replay.problems);

    const initiativeSnapshot = createInitiativeProjectionSnapshot();
    const initiativeReplay = this.#replayInitiative((event, row) => {
      applyInitiativeEventToSnapshot(initiativeSnapshot, event, row.sequence);
    });
    problems.push(...initiativeReplay.problems);

    const registrySnapshot = createRegistryProjectionSnapshot();
    const artifactSnapshot = createArtifactProjectionSnapshot();
    const modelVersionSnapshot = createModelVersionProjectionSnapshot();
    const priceIntervalSnapshot = createPriceIntervalProjectionSnapshot();
    const registryReplay = this.#replayRegistry(
      (document, row) => {
        applyRegistryEventToSnapshot(registrySnapshot, document, row.sequence);
        applyRegistryModelVersionToSnapshot(modelVersionSnapshot, document, row.sequence);
        applyRegistryPriceIntervalToSnapshot(priceIntervalSnapshot, document, row.sequence);
      },
      (event, row) => {
        applyArtifactEventToSnapshot(artifactSnapshot, event, row.sequence);
      },
    );
    problems.push(...registryReplay.problems);

    try {
      const registryHead = this.#readRegistryHead();
      if (registryHead.sequence !== registryReplay.lastSequence) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "registry head is sequence " +
            String(registryHead.sequence) +
            " but the last stored registry event is sequence " +
            String(registryReplay.lastSequence) +
            ", so the tail is truncated or the head is stale",
          sequence: null,
        });
      }
      if (registryHead.sha256 !== registryReplay.lastSha256) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "registry head digest " +
            registryHead.sha256 +
            " does not match the replayed registry chain head " +
            registryReplay.lastSha256,
          sequence: null,
        });
      }
      if (registryHead.count !== registryReplay.checked) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "registry head counts " +
            String(registryHead.count) +
            " events but " +
            String(registryReplay.checked) +
            " are stored",
          sequence: null,
        });
      }
    } catch (error: unknown) {
      problems.push({
        kind: "LEDGER_META",
        detail: error instanceof Error ? error.message : "the registry head is unreadable",
        sequence: null,
      });
    }

    try {
      const initiativeHead = this.#readInitiativeHead();
      if (initiativeHead.sequence !== initiativeReplay.lastSequence) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "initiative head is sequence " +
            String(initiativeHead.sequence) +
            " but the last stored initiative event is sequence " +
            String(initiativeReplay.lastSequence) +
            ", so the tail is truncated or the head is stale",
          sequence: null,
        });
      }
      if (initiativeHead.sha256 !== initiativeReplay.lastSha256) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "initiative head digest " +
            initiativeHead.sha256 +
            " does not match the replayed initiative chain head " +
            initiativeReplay.lastSha256,
          sequence: null,
        });
      }
      if (initiativeHead.count !== initiativeReplay.checked) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "initiative head counts " +
            String(initiativeHead.count) +
            " events but " +
            String(initiativeReplay.checked) +
            " are stored",
          sequence: null,
        });
      }
    } catch (error: unknown) {
      problems.push({
        kind: "LEDGER_META",
        detail: error instanceof Error ? error.message : "the initiative head is unreadable",
        sequence: null,
      });
    }

    let headSequence = 0;
    let headEventSha256 = GENESIS_SHA256;
    try {
      const head = this.#readHead();
      headSequence = head.sequence;
      headEventSha256 = head.sha256;

      if (head.sequence !== replay.lastSequence) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "ledger head is sequence " +
            String(head.sequence) +
            " but the last stored event is sequence " +
            String(replay.lastSequence) +
            ", so the tail is truncated or the head is stale",
          sequence: null,
        });
      }
      if (head.sha256 !== replay.lastSha256) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "ledger head digest " +
            head.sha256 +
            " does not match the replayed chain head " +
            replay.lastSha256,
          sequence: null,
        });
      }
      if (head.count !== replay.checked) {
        problems.push({
          kind: "LEDGER_META",
          detail:
            "ledger head counts " +
            String(head.count) +
            " events but " +
            String(replay.checked) +
            " are stored",
          sequence: null,
        });
      }
    } catch (error: unknown) {
      problems.push({
        kind: "LEDGER_META",
        detail: error instanceof Error ? error.message : "ledger_meta is unreadable",
        sequence: null,
      });
    }

    // The account stream's chain, which lives beside it (P-08/A2).
    //
    // Unlike the file identity, absence IS a finding: this activation is
    // written by the migration that creates the sidecar, so any ledger this
    // build can open has it. What is reported is a chain that does not verify,
    // a baseline that disagrees with the row it names, coverage that stops
    // short of the stream, or an activation that is partly or wholly gone —
    // which §8.2 forbids degrading to "not activated".
    problems.push(...this.#checkAccountIntegrity());

    // This file's identity, judged rather than merely read (P-10/id-A).
    //
    // `status()` reads the same rows and fails closed on a bad one, but a read
    // path that refuses is not a verifier: an operator asking "is this ledger
    // sound?" would have been told yes while `status()` threw. That asymmetry —
    // one door refusing what the judge never looks at — is the same shape of
    // gap this package has closed before, and it is closed here rather than
    // left for a later packet.
    //
    // A ledger with no identity at all is NOT a finding: that is the lawful
    // state of a file written before this build and not yet opened writably,
    // and `#readIdentity` returns the null triple for it. What is reported is a
    // value that is not a v4 UUID, an epoch that is not a count, or a partial
    // set — none of which this code can produce, so all of which mean somebody
    // reached past the door.
    try {
      this.#readIdentity();
    } catch (error: unknown) {
      problems.push({
        kind: "LEDGER_META",
        detail:
          error instanceof Error ? error.message : "this ledger's identity is unreadable",
        sequence: null,
      });
    }

    // projection_watermark membership is a closed set of (projection, stream)
    // pairs, and every row must be exactly level with the head of the stream it
    // names.
    //
    // An earlier version of this check read projection_meta, which had one row
    // per projection and so could only ask the question of a projection that
    // folded exactly one stream. The pair is what makes the question decidable
    // once a projection has two independent heads.
    //
    // The kind stays PROJECTION_META. The integrity vocabulary is owned by the
    // wire contract, which is not in this packet's write-set, and a watermark
    // problem is a projection-metadata problem — the table it lives in changed,
    // not what it means to an operator reading the report.
    const watermarkRows = this.#readWatermarks();
    const observedWatermarks = new Set<string>();

    for (const row of watermarkRows) {
      const label = safeIdentifier(row.projection_name);
      const streamLabel = safeIdentifier(row.source_stream);
      const key = watermarkKey(row.projection_name, row.source_stream);

      if (!WATERMARK_KEYS.has(key)) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            "projection_watermark holds " +
            label +
            " on " +
            streamLabel +
            ", which this build does not define",
          sequence: null,
        });
        continue;
      }
      observedWatermarks.add(key);

      // A fold written by another algorithm is not a fold this build would have
      // written. The derived table is invalid whatever the sequence says.
      if (row.projector_version !== PROJECTOR_VERSION) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " on " +
            streamLabel +
            " was written by projector version " +
            String(row.projector_version) +
            " but this build is version " +
            String(PROJECTOR_VERSION),
          sequence: null,
        });
      }

      // Each projection is level with the head of the stream it was built from.
      // Comparing an initiative projection against the task head would report
      // every healthy ledger as broken the moment the two streams had different
      // lengths, which is to say almost always.
      const expectedSequence =
        row.source_stream === INITIATIVE_STREAM
          ? initiativeReplay.lastSequence
          : row.source_stream === REGISTRY_STREAM
            ? registryReplay.lastSequence
            : replay.lastSequence;

      if (row.applied_sequence !== expectedSequence) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " is applied through sequence " +
            String(row.applied_sequence) +
            " but the head of " +
            streamLabel +
            " is sequence " +
            String(expectedSequence),
          sequence: null,
        });
      }

      // The digest is verified AT applied_sequence, not against the head the
      // stream has since reached. The two coincide while the watermark is level
      // — which is why comparing against the current head passes today and
      // stops being an answer the moment a watermark lawfully lags.
      const expectedSha256 = this.#digestAtSequence(row.source_stream, row.applied_sequence);
      if (expectedSha256 === null) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " is applied through sequence " +
            String(row.applied_sequence) +
            " which " +
            streamLabel +
            " does not hold",
          sequence: null,
        });
      } else if (row.source_head_sha256 !== expectedSha256) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " was built from chain head " +
            row.source_head_sha256 +
            " which is not the digest of " +
            streamLabel +
            " at sequence " +
            String(row.applied_sequence),
          sequence: null,
        });
      }

      // The watermark's other claim. `applied_sequence` says how far, the
      // digest says which history, and `event_count` says how much of it was
      // folded — and that third number was published by `status()` on this
      // ledger's authority while nothing compared it to the log.
      const expectedCount = this.#countAtSequence(row.source_stream, row.applied_sequence);
      if (row.event_count !== expectedCount) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            label +
            " on " +
            streamLabel +
            " counts " +
            String(row.event_count) +
            " events through sequence " +
            String(row.applied_sequence) +
            " but that stream holds " +
            String(expectedCount),
          sequence: null,
        });
      }
    }

    for (const source of PROJECTION_SOURCES) {
      if (!observedWatermarks.has(watermarkKey(source.projectionName, source.sourceStream))) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            "projection_watermark is missing the row for " +
            source.projectionName +
            " on " +
            source.sourceStream,
          sequence: null,
        });
      }
    }

    problems.push(...this.#compareProjections(snapshot));
    problems.push(...this.#compareInitiativeProjections(initiativeSnapshot));
    problems.push(...this.#compareRoutingProjection(registrySnapshot, initiativeSnapshot));
    problems.push(...this.#compareArtifactProjections(artifactSnapshot));
    problems.push(...this.#compareModelVersionProjection(modelVersionSnapshot));
    problems.push(...this.#comparePriceIntervalProjection(priceIntervalSnapshot));

    return {
      ok: problems.length === 0,
      checkedEvents: replay.checked,
      headSequence,
      headEventSha256,
      problems,
      coverage: this.#buildCoverage(
        replay.lastSequence,
        initiativeReplay.lastSequence,
        registryReplay.lastSequence,
      ),
    };
  }

  /**
   * Say, per stream, from when its chain is evidence — §8.2's coverage report.
   *
   * This answers a different question from every other line of
   * `verifyIntegrity()`. The problem list says whether the evidence holds; this
   * says how far back there is any. A caller that had only the first would read
   * `ok: true` on a ledger whose account stream was baselined this morning and
   * conclude that a row written last year had been verified, which is exactly
   * the conflation the contract forbids.
   *
   * Nothing here recomputes a digest or a head. Three of the four streams chain
   * as they append, so their coverage is a constant of their construction —
   * `CHAIN_FROM_APPEND` from sequence one, with no baseline because there was
   * never a moment when they were not covered. The fourth is read out of
   * `ledger_meta`: the sidecar's activation triple is the record of where
   * retroactive coverage was taken, and recomputing it would make the report
   * assert what the chain is supposed to prove.
   *
   * `checkedThroughSequence` is the cut this run examined, and each of the four
   * comes from the same replay the problem list was built from rather than a
   * second query — so the two halves of the report describe one pass over one
   * file, not two passes that might disagree.
   *
   * **The account entry never asserts authenticity before its baseline.** A
   * `BASELINED_AT_ACTIVATION` stream proves rows 1..H unchanged *since* the
   * instant in `integrityActivatedAt`; what happened to them before it is
   * outside what any chain here can speak to, and no field of this report
   * claims otherwise.
   */
  #buildCoverage(
    taskThrough: number,
    initiativeThrough: number,
    registryThrough: number,
  ): StreamIntegrityCoverage[] {
    const chained = (
      sourceStream: StreamIntegrityCoverage["sourceStream"],
      checkedThroughSequence: number,
    ): StreamIntegrityCoverage => ({
      sourceStream,
      coverageKind: "CHAIN_FROM_APPEND",
      // One even on an empty stream: covered from the first row it will ever
      // hold, holding none yet. Reporting `null` here would say "covers
      // nothing", which is the vocabulary for a stream with no chain at all.
      coveredSinceSequence: 1,
      checkedThroughSequence,
      integrityActivatedAt: null,
      baselineSequence: null,
      baselineSha256: null,
    });

    // Read straight from the stream rather than from the chain head in
    // `ledger_meta`. The cut this run examined is what the account table holds,
    // and taking it from the metadata would make the report agree with a stale
    // head instead of noticing one — `#checkAccountIntegrity()` is what
    // compares the two, and it cannot if this borrows the answer.
    const accountThrough = (
      this.#stmt("SELECT COALESCE(MAX(sequence), 0) AS head FROM account_events").get() as {
        readonly head: number;
      }
    ).head;

    let account: StreamIntegrityCoverage;
    try {
      const state = this.#readAccountIntegrity();
      account = {
        sourceStream: ACCOUNT_STREAM,
        coverageKind: "BASELINED_AT_ACTIVATION",
        coveredSinceSequence: 1,
        checkedThroughSequence: accountThrough,
        integrityActivatedAt: state.activatedAt,
        baselineSequence: state.baselineSequence,
        baselineSha256: state.baselineSha256,
      };
    } catch {
      // The activation is unreadable — partly or wholly gone, or holding a
      // value this code cannot have written. `#checkAccountIntegrity()` has
      // already pushed that as a finding with its detail; the error is
      // swallowed HERE and only here, because a report that threw would leave
      // the operator with no coverage report at all on precisely the ledger
      // that most needs one. What it says instead is the honest thing: this
      // stream carries no coverage this code can stand behind.
      account = {
        sourceStream: ACCOUNT_STREAM,
        coverageKind: "NOT_ACTIVATED",
        coveredSinceSequence: null,
        checkedThroughSequence: accountThrough,
        integrityActivatedAt: null,
        baselineSequence: null,
        baselineSha256: null,
      };
    }

    // Ordered by stream name, which is the order the wire contract requires and
    // is NOT the order `WATERMARK_SOURCE_STREAMS` declares. Sorting a fixed
    // four-element list would hide that; writing them out in the required order
    // makes a future stream a compile-visible edit rather than a silent one.
    return [
      account,
      chained(TASK_STREAM, taskThrough),
      chained(INITIATIVE_STREAM, initiativeThrough),
      chained(REGISTRY_STREAM, registryThrough),
    ];
  }

  /** Compare the stored projections against a fresh replay of the ledger. */
  #compareProjections(snapshot: ProjectionSnapshot): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    const storedTasks = new Map(
      (this.#stmt("SELECT * FROM task_read_model").all() as TaskRow[]).map((row) => [
        row.task_id,
        taskRowToModel(row),
      ]),
    );
    return this.#compareProjectionsWith(snapshot, problems, storedTasks);
  }

  /** Compare the stored initiative projections against a fresh replay. */
  #compareInitiativeProjections(snapshot: InitiativeProjectionSnapshot): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    const storedInitiatives = new Map(
      (this.#stmt("SELECT * FROM initiative_read_model").all() as InitiativeRow[]).map((row) => [
        row.initiative_id,
        initiativeRowToModel(row),
      ]),
    );

    for (const [initiativeId, expected] of snapshot.initiatives) {
      const stored = storedInitiatives.get(initiativeId);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "initiative_read_model is missing initiative " + initiativeId,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "initiative_read_model row for initiative " + initiativeId + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const initiativeId of storedInitiatives.keys()) {
      if (!snapshot.initiatives.has(initiativeId)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "initiative_read_model holds initiative " +
            initiativeId +
            " which no event accounts for",
          sequence: null,
        });
      }
    }

    const storedVersions = new Map(
      (
        this.#stmt("SELECT * FROM roadmap_version_read_model").all() as RoadmapVersionRow[]
      ).map((row) => [row.roadmap_version_id, roadmapVersionRowToModel(row)]),
    );

    for (const [versionId, expected] of snapshot.roadmapVersions) {
      const stored = storedVersions.get(versionId);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "roadmap_version_read_model is missing version " + versionId,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "roadmap_version_read_model row for version " + versionId + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const versionId of storedVersions.keys()) {
      if (!snapshot.roadmapVersions.has(versionId)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "roadmap_version_read_model holds version " +
            versionId +
            " which no event accounts for",
          sequence: null,
        });
      }
    }

    return problems;
  }

  /**
   * Verify the account sidecar end to end (P-08/A2).
   *
   * Four questions, and they are different questions:
   *
   * 1. **Does the chain verify?** Every sidecar row's digest is recomputed from
   *    the account row it names and the link before it. This is what detects a
   *    historical row rewritten after activation.
   * 2. **Does the baseline still name row `H`?** The activation triple is
   *    frozen evidence of where retroactive coverage was taken; a baseline that
   *    drifted would move the coverage claim without anything being verified.
   * 3. **Does coverage reach the stream's head?** A sidecar that stops short
   *    means account rows exist with no link, and the chain describes less than
   *    it appears to.
   * 4. **Does the head metadata match the last link?**
   *
   * On a finding the segment is **preserved**: nothing here repairs, re-anchors
   * or moves `covered_since`. The contract is explicit that repair is an
   * explicit, recorded decision outside the migration flow, and a verifier that
   * quietly fixed what it found would destroy the evidence of what happened.
   */
  #checkAccountIntegrity(): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    let state: AccountIntegrityState;
    try {
      state = this.#readAccountIntegrity();
    } catch (error: unknown) {
      problems.push({
        kind: "LEDGER_META",
        detail:
          error instanceof Error ? error.message : "the account integrity metadata is unreadable",
        sequence: null,
      });
      return problems;
    }

    const rows = this.#stmt(
      "SELECT " + ACCOUNT_EVENT_COLUMNS + " FROM account_events ORDER BY sequence ASC",
    )
      .safeIntegers(true)
      .all() as AccountEventRow[];
    const links = this.#stmt(
      "SELECT account_sequence, previous_sha256, event_sha256 FROM account_event_integrity " +
        "ORDER BY account_sequence ASC",
    ).all() as {
      readonly account_sequence: number;
      readonly previous_sha256: string;
      readonly event_sha256: string;
    }[];

    if (links.length !== rows.length) {
      problems.push({
        kind: "PROJECTION_META",
        detail:
          "the account integrity chain covers " +
          String(links.length) +
          " of " +
          String(rows.length) +
          " account events",
        sequence: null,
      });
    }

    let previous = ACCOUNT_INTEGRITY_GENESIS_SHA256;
    let last = ACCOUNT_INTEGRITY_GENESIS_SHA256;
    let baselineSeen: string | null = state.baselineSequence === 0 ? previous : null;

    for (const [index, link] of links.entries()) {
      const row = rows[index];
      const expectedSequence = index + 1;
      if (link.account_sequence !== expectedSequence) {
        problems.push({
          kind: "SEQUENCE",
          detail:
            "the account integrity chain expected sequence " +
            String(expectedSequence) +
            " but found " +
            String(link.account_sequence),
          sequence: link.account_sequence,
        });
        break;
      }
      if (row === undefined || !sameStoredInteger(row.sequence, link.account_sequence)) {
        problems.push({
          kind: "PROJECTION_META",
          detail:
            "the account integrity chain names sequence " +
            String(link.account_sequence) +
            " which account_events does not hold",
          sequence: link.account_sequence,
        });
        break;
      }
      if (link.previous_sha256 !== previous) {
        problems.push({
          kind: "HASH_CHAIN",
          detail:
            "account integrity sequence " +
            String(link.account_sequence) +
            " records previous digest " +
            link.previous_sha256 +
            " but the chain has reached " +
            previous,
          sequence: link.account_sequence,
        });
      }

      // A row this verifier cannot hash is a FINDING, not an exception.
      //
      // The preimage refuses a value it cannot encode exactly, and a foreign
      // writer can put such a value in the table — that is the entire scenario
      // the sidecar exists for. Letting the refusal escape would turn "row 1 is
      // unhashable" into "verifyIntegrity() threw", which reports nothing about
      // the other links and reads to an operator as a broken verifier rather
      // than as a broken ledger. So the digest is taken inside a guard, the
      // failure is recorded at its own sequence, and the walk continues with
      // this link's stored digest so every later link is still checked.
      //
      // `HASH_CHAIN` because the vocabulary of kinds is closed by the protocol
      // and this is the one that means "the stored row does not answer for the
      // digest filed against it".
      //
      // Only `LedgerValidationError` is caught, and only its message is
      // carried. That message is the preimage's own refusal, and every one of
      // them names coordinates and digests — a sequence, an integer that is not
      // exact, a malformed previous digest — never a stored TEXT value, which
      // is what keeps `detail` loggable. Anything else thrown here is a defect
      // in this package rather than a fact about the ledger, and it goes up.
      let recomputed: string | null = null;
      try {
        recomputed = accountIntegrityDigestV1({
          accountSequence: link.account_sequence,
          previousSha256: link.previous_sha256,
          row,
        });
      } catch (error: unknown) {
        if (!(error instanceof LedgerValidationError)) throw error;
        problems.push({
          kind: "HASH_CHAIN",
          detail:
            "account integrity sequence " +
            String(link.account_sequence) +
            " holds a row that cannot be hashed: " +
            error.message,
          sequence: link.account_sequence,
        });
      }
      if (recomputed !== null && recomputed !== link.event_sha256) {
        problems.push({
          kind: "HASH_CHAIN",
          detail:
            "account integrity sequence " +
            String(link.account_sequence) +
            " records digest " +
            link.event_sha256 +
            " but its stored row hashes to " +
            recomputed,
          sequence: link.account_sequence,
        });
      }

      previous = link.event_sha256;
      last = link.event_sha256;
      if (link.account_sequence === state.baselineSequence) baselineSeen = link.event_sha256;
    }

    if (baselineSeen === null) {
      problems.push({
        kind: "LEDGER_META",
        detail:
          "the account integrity baseline names sequence " +
          String(state.baselineSequence) +
          " which the chain does not reach",
        sequence: null,
      });
    } else if (baselineSeen !== state.baselineSha256) {
      problems.push({
        kind: "LEDGER_META",
        detail:
          "the account integrity baseline digest " +
          state.baselineSha256 +
          " is not the digest of the chain at sequence " +
          String(state.baselineSequence),
        sequence: null,
      });
    }

    if (state.headSequence !== links.length) {
      problems.push({
        kind: "LEDGER_META",
        detail:
          "the account integrity head is sequence " +
          String(state.headSequence) +
          " but the chain holds " +
          String(links.length) +
          " links",
        sequence: null,
      });
    }
    if (state.headEventSha256 !== last) {
      problems.push({
        kind: "LEDGER_META",
        detail:
          "the account integrity head digest " +
          state.headEventSha256 +
          " does not match the chain head " +
          last,
        sequence: null,
      });
    }

    return problems;
  }

  /**
   * Compare the stored routing projection against a fresh replay of BOTH
   * streams that feed it.
   *
   * As exact sets in both directions, for the reason the association rows are:
   * a substituted row leaves the count unchanged while the projection claims a
   * role was assigned a model version it was never assigned, which is precisely
   * the claim this projection exists to be able to make.
   */
  #compareRoutingProjection(
    registry: RegistryProjectionSnapshot,
    initiative: InitiativeProjectionSnapshot,
  ): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    const expectedAssignments = mergeRoutingAssignments(registry, initiative);
    const storedAssignments = new Map(
      (
        this.#stmt("SELECT * FROM routing_assignment_read_model").all() as RoutingAssignmentRow[]
      ).map((row) => [row.assignment_id, routingAssignmentRowToModel(row)]),
    );

    for (const [assignmentId, expected] of expectedAssignments) {
      const stored = storedAssignments.get(assignmentId);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "routing_assignment_read_model is missing the assignment " + assignmentId,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "routing_assignment_read_model row for " + assignmentId + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const assignmentId of storedAssignments.keys()) {
      if (!expectedAssignments.has(assignmentId)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "routing_assignment_read_model holds the assignment " +
            assignmentId +
            " which no event accounts for",
          sequence: null,
        });
      }
    }

    const expectedFallbacks = mergeRoutingFallbacks(registry, initiative);
    const storedFallbacks = new Map(
      (this.#stmt("SELECT * FROM routing_assignment_fallback").all() as RoutingFallbackRow[]).map(
        (row) => [
          routingFallbackKey(row.assignment_id, row.ordinal),
          routingFallbackRowToModel(row),
        ],
      ),
    );

    for (const [key, expected] of expectedFallbacks) {
      const stored = storedFallbacks.get(key);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "routing_assignment_fallback is missing " + key,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "routing_assignment_fallback row for " + key + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const key of storedFallbacks.keys()) {
      if (!expectedFallbacks.has(key)) {
        problems.push({
          kind: "PROJECTION",
          detail: "routing_assignment_fallback holds " + key + " which no event accounts for",
          sequence: null,
        });
      }
    }

    return problems;
  }

  /**
   * Compare the four artifact read models against a fresh replay (P-36/local A).
   *
   * Row for row, in canonical form, both directions: a missing row, a row that
   * disagrees and a row no event accounts for are three different findings.
   */
  #compareArtifactProjections(snapshot: ArtifactProjectionSnapshot): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];
    const compare = <T>(
      table: string,
      expected: ReadonlyMap<string, T>,
      stored: ReadonlyMap<string, T>,
    ): void => {
      for (const [key, row] of expected) {
        const found = stored.get(key);
        if (found === undefined) {
          problems.push({
            kind: "PROJECTION",
            detail: table + " is missing the row " + safeRowIdentifier(key),
            sequence: null,
          });
        } else if (canonicalJsonStringify(found) !== canonicalJsonStringify(row)) {
          problems.push({
            kind: "PROJECTION",
            detail: table + " row for " + safeRowIdentifier(key) + " disagrees with a replay",
            sequence: null,
          });
        }
      }
      for (const key of stored.keys()) {
        if (!expected.has(key)) {
          problems.push({
            kind: "PROJECTION",
            detail: table + " holds the row " + safeRowIdentifier(key) + " which no event accounts for",
            sequence: null,
          });
        }
      }
    };

    compare(
      "artifact_blob_read_model",
      snapshot.blobs,
      new Map(
        (this.#stmt("SELECT * FROM artifact_blob_read_model").all() as ArtifactBlobRow[]).map((row) => [
          artifactBlobKey(row.content_sha256, row.blob_generation),
          artifactBlobRowToModel(row),
        ]),
      ),
    );
    compare(
      "artifact_reference_read_model",
      snapshot.references,
      new Map(
        (this.#stmt("SELECT * FROM artifact_reference_read_model").all() as ArtifactReferenceRow[]).map(
          (row) => [row.artifact_reference_id, artifactReferenceRowToModel(row)],
        ),
      ),
    );
    compare(
      "artifact_pin_read_model",
      snapshot.pins,
      new Map(
        (this.#stmt("SELECT * FROM artifact_pin_read_model").all() as ArtifactPinRow[]).map((row) => [
          row.artifact_pin_id,
          artifactPinRowToModel(row),
        ]),
      ),
    );
    compare(
      "artifact_tombstone_read_model",
      snapshot.tombstones,
      new Map(
        (this.#stmt("SELECT * FROM artifact_tombstone_read_model").all() as ArtifactTombstoneRow[]).map(
          (row) => [row.artifact_reference_id, artifactTombstoneRowToModel(row)],
        ),
      ),
    );

    return problems;
  }

  /**
   * Compare the model version registry and its two child tables against a fresh
   * replay (P-14 A).
   *
   * Row for row, in canonical form, both directions, for the artifact plane's
   * reason. The children are keyed by `(model_version_id, ordinal)`: a role moved
   * to another ordinal, or a transport substituted, leaves every count unchanged
   * while the registry claims an eligibility nobody recorded.
   */
  #compareModelVersionProjection(snapshot: ModelVersionProjectionSnapshot): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];
    const compare = <T>(
      table: string,
      expected: ReadonlyMap<string, T>,
      stored: ReadonlyMap<string, T>,
    ): void => {
      for (const [key, row] of expected) {
        const found = stored.get(key);
        if (found === undefined) {
          problems.push({
            kind: "PROJECTION",
            detail: table + " is missing the row " + safeRowIdentifier(key),
            sequence: null,
          });
        } else if (canonicalJsonStringify(found) !== canonicalJsonStringify(row)) {
          problems.push({
            kind: "PROJECTION",
            detail: table + " row for " + safeRowIdentifier(key) + " disagrees with a replay",
            sequence: null,
          });
        }
      }
      for (const key of stored.keys()) {
        if (!expected.has(key)) {
          problems.push({
            kind: "PROJECTION",
            detail: table + " holds the row " + safeRowIdentifier(key) + " which no event accounts for",
            sequence: null,
          });
        }
      }
    };
    // The ordinal is always the text after the last colon, so two pairs cannot
    // collide, and the key stays inside what `safeRowIdentifier` prints.
    const childKey = (modelVersionId: string, ordinal: number): string =>
      modelVersionId + ":" + String(ordinal);

    compare(
      MODEL_VERSION_PROJECTION,
      snapshot.modelVersions,
      new Map(
        (this.#stmt("SELECT * FROM model_version_read_model").all() as ModelVersionRow[]).map((row) => [
          row.model_version_id,
          modelVersionRowToModel(row),
        ]),
      ),
    );
    compare(
      "model_version_eligible_role",
      new Map(
        [...snapshot.eligibleRoles.values()].flat().map((row) => [childKey(row.modelVersionId, row.ordinal), row]),
      ),
      new Map(
        (this.#stmt("SELECT * FROM model_version_eligible_role").all() as ModelVersionEligibleRoleDbRow[]).map(
          (row) => [childKey(row.model_version_id, row.ordinal), modelVersionRoleRowToModel(row)],
        ),
      ),
    );
    compare(
      "model_version_transport",
      new Map(
        [...snapshot.transports.values()].flat().map((row) => [childKey(row.modelVersionId, row.ordinal), row]),
      ),
      new Map(
        (this.#stmt("SELECT * FROM model_version_transport").all() as ModelVersionTransportDbRow[]).map(
          (row) => [childKey(row.model_version_id, row.ordinal), modelVersionTransportRowToModel(row)],
        ),
      ),
    );

    return problems;
  }

  /**
   * Compare the price interval catalog against a fresh replay (P-33/catálogo A).
   *
   * Row for row, in canonical form, both directions, for the model version
   * registry's reason: a price rewritten in place, an interval deleted, or one
   * planted leaves every count but one unchanged while the catalog quotes a price
   * nobody published. The key is the primary key; what is printed is the
   * document and its version, which `safeRowIdentifier` can hold, never a price.
   */
  #comparePriceIntervalProjection(snapshot: PriceIntervalProjectionSnapshot): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];
    const label = (row: PriceIntervalReadModel): string =>
      "an interval of " + safeRowIdentifier(row.catalogDocumentId) + " version " + String(row.catalogVersion);
    const stored = new Map(
      (this.#stmt("SELECT * FROM price_interval_read_model").all() as PriceIntervalRow[]).map((row) => {
        const model = priceIntervalRowToModel(row);
        return [priceIntervalKey(model), model] as const;
      }),
    );
    for (const [key, expected] of snapshot.intervals) {
      const found = stored.get(key);
      if (found === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: PRICE_INTERVAL_PROJECTION + " is missing the row for " + label(expected),
          sequence: null,
        });
      } else if (canonicalJsonStringify(found) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: PRICE_INTERVAL_PROJECTION + " row for " + label(expected) + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const [key, row] of stored) {
      if (!snapshot.intervals.has(key)) {
        problems.push({
          kind: "PROJECTION",
          detail: PRICE_INTERVAL_PROJECTION + " holds the row for " + label(row) + " which no event accounts for",
          sequence: null,
        });
      }
    }
    return problems;
  }

  /**
   * Confirm the live schema still holds every object the migrations created.
   *
   * This is what makes the append-only triggers a standing guarantee rather
   * than a one-time event at migration time.
   */
  #checkSchemaShape(): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];

    const rows = this.#stmt(
      "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE ?",
    ).all("sqlite_%") as { readonly type: string; readonly name: string }[];

    const present = new Set(rows.map((row) => row.type + " " + row.name));

    for (const expected of EXPECTED_SCHEMA_OBJECTS) {
      if (!present.has(expected.type + " " + expected.name)) {
        problems.push({
          kind: "SCHEMA_SHAPE",
          detail:
            "the " +
            expected.type +
            " " +
            expected.name +
            " was created by a migration but is no longer present",
          sequence: null,
        });
      }
    }

    const allowed = new Set(
      EXPECTED_SCHEMA_OBJECTS.map((object) => object.type + " " + object.name),
    );
    for (const key of present) {
      if (!allowed.has(key)) {
        problems.push({
          kind: "SCHEMA_SHAPE",
          detail: "the schema holds an object no migration created: " + key,
          sequence: null,
        });
      }
    }

    return problems;
  }

  #compareProjectionsWith(
    snapshot: ProjectionSnapshot,
    problems: IntegrityProblem[],
    storedTasks: Map<string, TaskReadModel>,
  ): IntegrityProblem[] {
    for (const [taskId, expected] of snapshot.tasks) {
      const stored = storedTasks.get(taskId);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_read_model is missing task " + taskId,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_read_model row for task " + taskId + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const taskId of storedTasks.keys()) {
      if (!snapshot.tasks.has(taskId)) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_read_model holds task " + taskId + " which no event accounts for",
          sequence: null,
        });
      }
    }

    const storedWorkers = new Map(
      (this.#stmt("SELECT * FROM worker_read_model").all() as WorkerRow[]).map((row) => [
        row.identity,
        workerRowToModel(row),
      ]),
    );
    for (const [identity, expected] of snapshot.workers) {
      const stored = storedWorkers.get(identity);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_read_model is missing worker " + identity,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_read_model row for worker " + identity + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const identity of storedWorkers.keys()) {
      if (!snapshot.workers.has(identity)) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_read_model holds worker " + identity + " which no event accounts for",
          sequence: null,
        });
      }
    }

    // The association rows are compared as exact sets, in both directions.
    //
    // Counting them was not enough, and the gap was the interesting one: a
    // substituted pair, where one association is replaced by a different one,
    // leaves the total unchanged and would have passed a count comparison while
    // the projection claimed a worker had worked on a task it never touched.
    const storedPairs = this.#stmt(
      "SELECT identity, task_id, event_count, last_sequence FROM worker_task_read_model",
    ).all() as WorkerTaskRow[];

    const storedPairsByKey = new Map<string, string>();
    for (const row of storedPairs) {
      storedPairsByKey.set(
        workerTaskKey(row.identity, row.task_id),
        canonicalJsonStringify({
          identity: row.identity,
          taskId: row.task_id,
          eventCount: row.event_count,
          lastSequence: row.last_sequence,
        }),
      );
    }

    for (const [key, expected] of snapshot.workerTasks) {
      const stored = storedPairsByKey.get(key);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_task_read_model is missing the association " + key,
          sequence: null,
        });
        continue;
      }
      if (stored !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "worker_task_read_model row for " + key + " disagrees with a replay",
          sequence: null,
        });
      }
    }

    for (const key of storedPairsByKey.keys()) {
      if (!snapshot.workerTasks.has(key)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "worker_task_read_model holds the association " +
            key +
            " which no event accounts for",
          sequence: null,
        });
      }
    }

    // The route rows, compared as exact sets in both directions for the same
    // reason the association rows are: a substituted route leaves the count
    // unchanged while the projection claims an attempt ran on an account or a
    // policy version it never ran on, which is precisely the claim this
    // projection exists to be able to make.
    const storedRoutes = new Map(
      (
        this.#stmt("SELECT * FROM execution_route_read_model").all() as ExecutionRouteRow[]
      ).map((row) => [executionRouteKey(row.task_id, row.attempt), executionRouteRowToModel(row)]),
    );

    for (const [key, expected] of snapshot.executionRoutes) {
      const stored = storedRoutes.get(key);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "execution_route_read_model is missing the route for " + key,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "execution_route_read_model row for " + key + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const key of storedRoutes.keys()) {
      if (!snapshot.executionRoutes.has(key)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "execution_route_read_model holds the route for " + key + " which no event accounts for",
          sequence: null,
        });
      }
    }

    // The revision rows, compared as exact sets in both directions like every
    // projection above. A revision row that no event accounts for is the more
    // interesting half here: the table is insert-only and the coordinate is the
    // identity of a unit of work, so a row nobody wrote is a claim that a
    // revision was asked for when it was not.
    const storedRevisions = new Map(
      (this.#stmt("SELECT * FROM task_revision_read_model").all() as TaskRevisionRow[]).map(
        (row) => [
          taskRevisionKey(row.task_id, row.revision_number),
          taskRevisionRowToModel(row),
        ],
      ),
    );

    for (const [key, expected] of snapshot.taskRevisions) {
      const stored = storedRevisions.get(key);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_revision_read_model is missing the revision for " + key,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_revision_read_model row for " + key + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const key of storedRevisions.keys()) {
      if (!snapshot.taskRevisions.has(key)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "task_revision_read_model holds the revision for " +
            key +
            " which no event accounts for",
          sequence: null,
        });
      }
    }

    // The attempt rows, on the same terms as the revisions above. Both
    // directions matter here for the reason they do there, and one more: the
    // fold writes `ended_at` and `outcome` as `NULL` on every row, so a row
    // that has acquired either is a row something outside this build wrote —
    // which the field comparison reports rather than ignores.
    const storedAttempts = new Map(
      (this.#stmt("SELECT * FROM task_attempt_read_model").all() as TaskAttemptRow[]).map(
        (row) => [
          taskAttemptKey(row.task_id, row.revision_number, row.attempt_number),
          taskAttemptRowToModel(row),
        ],
      ),
    );

    for (const [key, expected] of snapshot.taskAttempts) {
      const stored = storedAttempts.get(key);
      if (stored === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_attempt_read_model is missing the attempt for " + key,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(expected)) {
        problems.push({
          kind: "PROJECTION",
          detail: "task_attempt_read_model row for " + key + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const key of storedAttempts.keys()) {
      if (!snapshot.taskAttempts.has(key)) {
        problems.push({
          kind: "PROJECTION",
          detail:
            "task_attempt_read_model holds the attempt for " +
            key +
            " which no event accounts for",
          sequence: null,
        });
      }
    }

    // The client keys (P-14 C), on the same terms: a key row no event accounts
    // for is a claim that a request entered when it did not.
    this.#compareRowSet(
      problems,
      "task_submission_read_model",
      snapshot.taskSubmissions,
      new Map(
        (this.#stmt("SELECT * FROM task_submission_read_model").all() as TaskSubmissionRow[]).map((row) => [
          taskSubmissionKey(row.client_scope, row.client_request_key),
          taskSubmissionRowToModel(row),
        ]),
      ),
    );

    // The P-18/protocolo C cohort, compared as exact sets in both directions
    // like every projection above. The three are compared by the same helper
    // rather than by three copies of the same twenty lines, because the
    // argument is identical for all of them and a substituted row — an effect
    // whose outcome quietly became `SUCCEEDED`, a delivery that acquired a
    // handle no event recorded — leaves every count unchanged.
    this.#compareRowSet(
      problems,
      "execution_route_segment_read_model",
      snapshot.routeSegments,
      new Map(
        (
          this.#stmt(
            "SELECT * FROM execution_route_segment_read_model",
          ).all() as ExecutionRouteSegmentRow[]
        ).map((row) => [row.route_segment_id, executionRouteSegmentRowToModel(row)]),
      ),
    );
    this.#compareRowSet(
      problems,
      "effect_read_model",
      snapshot.effects,
      new Map(
        (this.#stmt("SELECT * FROM effect_read_model").all() as EffectRow[]).map((row) => [
          row.effect_id,
          effectRowToModel(row),
        ]),
      ),
    );
    this.#compareRowSet(
      problems,
      "dispatch_attempt_read_model",
      snapshot.dispatchAttempts,
      new Map(
        (
          this.#stmt("SELECT * FROM dispatch_attempt_read_model").all() as DispatchAttemptRow[]
        ).map((row) => [row.dispatch_attempt_id, dispatchAttemptRowToModel(row)]),
      ),
    );
    // And P-18/protocolo D's pair, by the same helper and for its reason: an
    // answer quietly re-pointed at another prompt, or a digest swapped under a
    // row, leaves every count unchanged.
    this.#compareRowSet(
      problems,
      "prompt_occurrence_read_model",
      snapshot.promptOccurrences,
      new Map(
        (
          this.#stmt("SELECT * FROM prompt_occurrence_read_model").all() as PromptOccurrenceRow[]
        ).map((row) => [row.occurrence_id, promptOccurrenceRowToModel(row)]),
      ),
    );
    this.#compareRowSet(
      problems,
      "response_occurrence_read_model",
      snapshot.responseOccurrences,
      new Map(
        (
          this.#stmt(
            "SELECT * FROM response_occurrence_read_model",
          ).all() as ResponseOccurrenceRow[]
        ).map((row) => [row.occurrence_id, responseOccurrenceRowToModel(row)]),
      ),
    );

    this.#compareUsageProjections(snapshot, problems);

    return problems;
  }

  /**
   * The P-32/captura B cohort against a replay, all five tables, as exact sets
   * both ways (H-3).
   *
   * Read with `safeIntegers`, so a settlement's sum past
   * `Number.MAX_SAFE_INTEGER` is compared exactly, and compared as text: every
   * integer on both sides becomes its decimal digits (`usageRowText`), because
   * `canonicalJsonStringify` refuses a `bigint` and a count compared through
   * `number` could agree with a row it does not equal.
   */
  #compareUsageProjections(snapshot: ProjectionSnapshot, problems: IntegrityProblem[]): void {
    const stored = (sql: string): Record<string, unknown>[] =>
      this.#db.prepare(sql).safeIntegers(true).all() as Record<string, unknown>[];
    const camel = (row: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]),
      );
    const texts = <T extends object>(rows: Iterable<[string, T]>): Map<string, string> =>
      new Map([...rows].map(([key, row]) => [key, usageRowText(row)]));
    const storedTexts = (sql: string, keyOf: (row: Record<string, unknown>) => string): Map<string, string> =>
      new Map(
        stored(sql).map((row) => {
          const model = camel(row);
          return [keyOf(model), usageRowText(model)];
        }),
      );
    const text = (value: unknown): string => (typeof value === "string" ? value : String(value));

    this.#compareRowSet(
      problems,
      "usage_measurement_stream_read_model",
      texts(snapshot.usageStreams),
      storedTexts("SELECT * FROM usage_measurement_stream_read_model", (row) => text(row["measurementStreamId"])),
    );
    this.#compareRowSet(
      problems,
      "usage_observation_read_model",
      texts(snapshot.usageObservations),
      storedTexts("SELECT * FROM usage_observation_read_model", (row) => text(row["observationId"])),
    );
    this.#compareRowSet(
      problems,
      "usage_settlement_read_model",
      texts(snapshot.usageSettlements),
      storedTexts("SELECT * FROM usage_settlement_read_model", (row) =>
        usageSettlementKey(text(row["effectId"]), Number(row["settlementRevision"])),
      ),
    );
    this.#compareRowSet(
      problems,
      "usage_settlement_source_head_read_model",
      texts(snapshot.usageSettlementSourceHeads),
      storedTexts("SELECT * FROM usage_settlement_source_head_read_model", (row) =>
        usageSettlementSourceHeadKey(
          text(row["effectId"]),
          Number(row["settlementRevision"]),
          text(row["sourceStream"]),
        ),
      ),
    );
    this.#compareRowSet(
      problems,
      "usage_settlement_observation_read_model",
      texts(snapshot.usageSettlementObservations),
      storedTexts("SELECT * FROM usage_settlement_observation_read_model", (row) =>
        usageSettlementObservationKey(
          text(row["effectId"]),
          Number(row["settlementRevision"]),
          text(row["observationId"]),
        ),
      ),
    );
  }

  /**
   * One projection's stored rows against a replay's, as exact sets both ways.
   *
   * The shape every comparison above writes out by hand, factored out at the
   * point three more of them would have been three more copies. Missing,
   * disagreeing and unaccounted-for are three distinct reports because they are
   * three distinct failures: a fold that stopped, a fold that drifted, and a
   * row something outside the fold wrote.
   */
  #compareRowSet<T>(
    problems: IntegrityProblem[],
    table: string,
    expected: ReadonlyMap<string, T>,
    stored: ReadonlyMap<string, T>,
  ): void {
    for (const [key, value] of expected) {
      const row = stored.get(key);
      if (row === undefined) {
        problems.push({
          kind: "PROJECTION",
          detail: table + " is missing the row for " + key,
          sequence: null,
        });
        continue;
      }
      if (canonicalJsonStringify(row) !== canonicalJsonStringify(value)) {
        problems.push({
          kind: "PROJECTION",
          detail: table + " row for " + key + " disagrees with a replay",
          sequence: null,
        });
      }
    }
    for (const key of stored.keys()) {
      if (!expected.has(key)) {
        problems.push({
          kind: "PROJECTION",
          detail: table + " holds the row for " + key + " which no event accounts for",
          sequence: null,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getEvent(eventId: string): LedgerEventRecord | null {
    this.#assertOpen("getEvent");
    const row = this.#stmt(
      "SELECT " + EVENT_COLUMNS + " FROM control_plane_events WHERE event_id = ?",
    ).get(eventId) as EventRow | undefined;
    return row === undefined ? null : this.#rowToRecord(row);
  }

  getEventBySequence(sequence: number): LedgerEventRecord | null {
    this.#assertOpen("getEventBySequence");
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new LedgerQueryError("sequence must be a positive integer");
    }
    const row = this.#stmt(
      "SELECT " + EVENT_COLUMNS + " FROM control_plane_events WHERE sequence = ?",
    ).get(sequence) as EventRow | undefined;
    return row === undefined ? null : this.#rowToRecord(row);
  }

  getEventByIdempotencyKey(idempotencyKey: string): LedgerEventRecord | null {
    this.#assertOpen("getEventByIdempotencyKey");
    const row = this.#stmt(
      "SELECT " + EVENT_COLUMNS + " FROM control_plane_events WHERE idempotency_key = ?",
    ).get(idempotencyKey) as EventRow | undefined;
    return row === undefined ? null : this.#rowToRecord(row);
  }

  /** Events in sequence order, filtered and bounded. The cursor is exclusive. */
  listEvents(query: EventQuery = {}): EventPage {
    this.#assertOpen("listEvents");
    const limit = boundedLimit(query.limit, "event");
    const afterSequence = query.afterSequence ?? 0;
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new LedgerQueryError("afterSequence must be a non negative integer");
    }

    const clauses = ["sequence > ?"];
    const params: (string | number)[] = [afterSequence];
    if (query.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(query.taskId);
    }
    if (query.type !== undefined) {
      clauses.push("type = ?");
      params.push(query.type);
    }
    if (query.emittedBy !== undefined) {
      clauses.push("emitted_by = ?");
      params.push(query.emittedBy);
    }
    if (query.toState !== undefined) {
      clauses.push("to_state = ?");
      params.push(query.toState);
    }
    params.push(limit + 1);

    const rows = this.#stmt(
      "SELECT " +
        EVENT_COLUMNS +
        " FROM control_plane_events WHERE " +
        clauses.join(" AND ") +
        " ORDER BY sequence ASC LIMIT ?",
    ).all(...params) as EventRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const events = page.map((row) => this.#rowToRecord(row));
    const last = events.at(-1);
    return {
      events,
      nextCursor: hasMore && last !== undefined ? last.sequence : null,
      hasMore,
    };
  }

  /**
   * The row one client key produced, or null (P-14 C, contracts §15).
   *
   * The read the intake door decides a second submission with: the task, the
   * revision and the envelope digest the key already names. Both halves are held
   * to `TASK_CLIENT_KEY_PATTERN` before anything is read, because a key the fold
   * would never have written is a question with no row to answer it.
   */
  getTaskSubmission(clientScope: string, clientRequestKey: string): TaskSubmissionReadModel | null {
    this.#assertOpen("getTaskSubmission");
    if (typeof clientScope !== "string" || !TASK_CLIENT_KEY_PATTERN.test(clientScope)) {
      throw new LedgerQueryError("clientScope must satisfy the client key grammar");
    }
    if (typeof clientRequestKey !== "string" || !TASK_CLIENT_KEY_PATTERN.test(clientRequestKey)) {
      throw new LedgerQueryError("clientRequestKey must satisfy the client key grammar");
    }
    const row = this.#stmt(
      "SELECT * FROM task_submission_read_model WHERE client_scope = ? AND client_request_key = ?",
    ).get(clientScope, clientRequestKey) as TaskSubmissionRow | undefined;
    return row === undefined ? null : taskSubmissionRowToModel(row);
  }

  getTask(taskId: string): TaskReadModel | null {
    this.#assertOpen("getTask");
    const row = this.#stmt("SELECT * FROM task_read_model WHERE task_id = ?").get(taskId) as
      | TaskRow
      | undefined;
    return row === undefined ? null : taskRowToModel(row);
  }

  /**
   * The route one attempt of a task was admitted on, or null (V2-B1c).
   *
   * `(taskId, attempt)` and not `taskId`: a retry may have resolved a
   * different account or model, and both answers are facts the ledger holds.
   * Null means the attempt recorded no admitted route — either it predates
   * V2-B1c, or its `RUN_STARTED` payload did not satisfy the contract and the
   * projection refused it while the event itself still stands.
   */
  /**
   * The logical lookup of execution §6.1, point 1 — the read side.
   *
   * **This is the verb the packet's minimal negative is about.** A run that
   * lost an acknowledgement and then handed off asks this before doing anything
   * else, with the same semantic scope and the same step key it used the first
   * time. If an effect already exists for that logical key it gets that effect's
   * own `effectId` and `idempotencyKey` back — never a new pair — together with
   * whether the situation demands reconciliation before anything else happens.
   *
   * The comparison is §6.1 `:303-304`'s and it covers all four fields, not just
   * the request digest: a different kind, a different request contract version,
   * a different envelope or a different request under one logical key is a
   * **CONFLICT**, and it is raised rather than returned because there is no
   * answer a caller could act on. A producer never resolves it by changing the
   * key. The query carries no idempotency key and no envelope of its own: the
   * envelope reaches the comparison through `requestSha256`, whose preimage
   * carries it.
   *
   * `reconciliationRequired` answers "may this be acted on as it stands":
   *
   *  - a terminal outcome — `SUCCEEDED`, `FAILED`, `CANCELLED` — is reused, so
   *    `false`;
   *  - `OUTCOME_UNKNOWN` is an uncertain exposure and demands reconciliation,
   *    whatever any destination reports about itself;
   *  - no outcome yet, with a delivery still outstanding, is the same
   *    uncertainty in its live form: something may be in flight;
   *  - no outcome and no delivery at all is an intention that never left, and
   *    nothing needs reconciling.
   *
   * Read-only, and it takes no lock: it answers a question about what is
   * recorded. The refusals that keep the answer true live at the append door.
   */
  lookUpEffect(query: EffectLookupQuery): EffectLookup | null {
    this.#assertOpen("lookUpEffect");

    const attempt = this.#stmt(
      "SELECT invocation_id FROM task_attempt_read_model " +
        "WHERE task_id = ? AND revision_number = ? AND attempt_number = ?",
    ).get(query.taskId, query.revisionNumber, query.attemptNumber) as
      | { readonly invocation_id: string }
      | undefined;
    if (attempt === undefined) return null;

    const digest = logicalOperationSha256({
      invocationId: attempt.invocation_id,
      semanticScopeKey: query.semanticScopeKey,
      localOperationKey: query.localOperationKey,
    });

    const row = this.#stmt(
      "SELECT * FROM effect_read_model WHERE logical_operation_sha256 = ?",
    ).get(digest) as EffectRow | undefined;
    if (row === undefined) return null;

    const effect = effectRowToModel(row);
    if (
      effect.effectKind !== query.effectKind ||
      effect.requestContractVersion !== query.requestContractVersion ||
      effect.requestSha256 !== query.requestSha256
    ) {
      throw new LedgerValidationError([
        {
          path: "requestSha256",
          message:
            "CONFLICT: logical operation " +
            digest +
            " is already effect " +
            effect.effectId +
            " with a different kind, request contract version or request digest; one " +
            "logical key names one operation",
        },
      ]);
    }

    const outstanding = this.#stmt(
      "SELECT COUNT(*) AS n FROM dispatch_attempt_read_model " +
        "WHERE effect_id = ? AND dispatch_state NOT IN ('SETTLED', 'ABANDONED')",
    ).get(effect.effectId) as { readonly n: number };

    return {
      effect,
      reconciliationRequired:
        effect.outcomeStatus === "OUTCOME_UNKNOWN" ||
        (effect.outcomeStatus === null && outstanding.n > 0),
    };
  }

  /** Every delivery of one effect, in the order they were intended. */
  listDispatchAttempts(effectId: string): readonly DispatchAttemptReadModel[] {
    this.#assertOpen("listDispatchAttempts");
    return (
      this.#stmt(
        "SELECT * FROM dispatch_attempt_read_model WHERE effect_id = ? ORDER BY attempt_ordinal",
      ).all(effectId) as DispatchAttemptRow[]
    ).map(dispatchAttemptRowToModel);
  }

  /** Every segment of one attempt, in order — the lineage a handoff leaves. */
  listRouteSegments(
    taskId: string,
    revisionNumber: number,
    attemptNumber: number,
  ): readonly ExecutionRouteSegmentReadModel[] {
    this.#assertOpen("listRouteSegments");
    return (
      this.#stmt(
        "SELECT * FROM execution_route_segment_read_model " +
          "WHERE task_id = ? AND revision_number = ? AND attempt_number = ? ORDER BY segment_number",
      ).all(taskId, revisionNumber, attemptNumber) as ExecutionRouteSegmentRow[]
    ).map(executionRouteSegmentRowToModel);
  }

  /**
   * Deliveries that have been `INFLIGHT` since before a deadline.
   *
   * **The deadline is an argument, and this package reads no clock.** That is
   * `listOverdue`'s precedent in the outbox store and it is the only honest
   * shape: a ledger that decided for itself what "overdue" means would be
   * deciding a policy, and the policy belongs to whoever is reconciling.
   *
   * And **finding a row here creates nothing**. Execution §7 `:360`: an overdue
   * `INFLIGHT` enables reconciliation, not a retry. No verb of this ledger
   * moves such a row, mints another delivery for its effect, or intends a
   * second effect from it — reconciliation is by `external_handle` or by
   * postcondition, never by dispatching again into an uncertain one.
   */
  listOverdueDispatchAttempts(deadline: string): readonly DispatchAttemptReadModel[] {
    this.#assertOpen("listOverdueDispatchAttempts");
    if (!isInstant(deadline)) {
      throw new LedgerQueryError(
        "listOverdueDispatchAttempts needs a deadline as an ISO-8601 instant in UTC with " +
          "milliseconds, and this package reads no clock of its own",
      );
    }
    return (
      this.#stmt(
        "SELECT * FROM dispatch_attempt_read_model " +
          "WHERE dispatch_state = 'INFLIGHT' AND requested_at < ? ORDER BY requested_at",
      ).all(deadline) as DispatchAttemptRow[]
    ).map(dispatchAttemptRowToModel);
  }

  /**
   * Every prompt occurrence of one segment, in the order the ledger assigned
   * (P-18/D). Read through `ix_prompt_occurrence_read_model__segment`.
   */
  listPromptOccurrences(routeSegmentId: string): readonly PromptOccurrenceReadModel[] {
    this.#assertOpen("listPromptOccurrences");
    return (
      this.#stmt(
        "SELECT * FROM prompt_occurrence_read_model WHERE route_segment_id = ? ORDER BY ordinal",
      ).all(routeSegmentId) as PromptOccurrenceRow[]
    ).map(promptOccurrenceRowToModel);
  }

  /**
   * Every occurrence that sent the bytes one digest names, in recording order.
   *
   * The question `ix_prompt_occurrence_read_model__sha256` exists to answer, and
   * the reason it is not unique: the same bytes sent twice are two occurrences
   * and one blob, so the answer is a list and never a row.
   */
  listPromptOccurrencesBySha256(promptSha256: string): readonly PromptOccurrenceReadModel[] {
    this.#assertOpen("listPromptOccurrencesBySha256");
    return (
      this.#stmt(
        "SELECT * FROM prompt_occurrence_read_model WHERE prompt_sha256 = ? ORDER BY sequence",
      ).all(promptSha256) as PromptOccurrenceRow[]
    ).map(promptOccurrenceRowToModel);
  }

  getPromptOccurrence(occurrenceId: string): PromptOccurrenceReadModel | null {
    this.#assertOpen("getPromptOccurrence");
    const row = this.#stmt(
      "SELECT * FROM prompt_occurrence_read_model WHERE occurrence_id = ?",
    ).get(occurrenceId) as PromptOccurrenceRow | undefined;
    return row === undefined ? null : promptOccurrenceRowToModel(row);
  }

  /**
   * The one answer to a prompt occurrence, or `null` while it has none.
   *
   * Keyed by the **prompt**, because that is the only thing an answer is
   * attributed through: its account and segment are the prompt's, however late
   * it arrived.
   */
  getResponseOccurrenceForPrompt(promptOccurrenceId: string): ResponseOccurrenceReadModel | null {
    this.#assertOpen("getResponseOccurrenceForPrompt");
    const row = this.#stmt(
      "SELECT * FROM response_occurrence_read_model WHERE prompt_occurrence_id = ?",
    ).get(promptOccurrenceId) as ResponseOccurrenceRow | undefined;
    return row === undefined ? null : responseOccurrenceRowToModel(row);
  }

  getEffect(effectId: string): EffectReadModel | null {
    this.#assertOpen("getEffect");
    const row = this.#stmt("SELECT * FROM effect_read_model WHERE effect_id = ?").get(effectId) as
      | EffectRow
      | undefined;
    return row === undefined ? null : effectRowToModel(row);
  }

  /**
   * A task's effects, in the order the ledger recorded their intentions, at most
   * `limit` of them (P-15/F, ADR 0107).
   *
   * How a caller learns an effect's id without reading an event payload: the
   * effects route and verb list them, and the result route is keyed by them. Empty
   * for a task that intended none; the caller tells that apart from an unknown task
   * by asking for the task. Bounded rather than unbounded: it reads one row past
   * `limit`, so `truncated` says whether the list is longer than the page, and a
   * caller never holds more rows than it asked for (v3, verifier V7).
   */
  listTaskEffects(taskId: string, options: { readonly limit: number }): TaskEffectPage {
    this.#assertOpen("listTaskEffects");
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new LedgerQueryError("taskId must be a non-empty string");
    }
    const limit = options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new LedgerQueryError("limit must be a positive integer");
    }
    const rows = (
      this.#stmt(
        "SELECT * FROM effect_read_model WHERE task_id = ? ORDER BY sequence ASC, effect_id ASC LIMIT ?",
      ).all(taskId, limit + 1) as EffectRow[]
    ).map(effectRowToModel);
    return { effects: rows.slice(0, limit), truncated: rows.length > limit };
  }

  /**
   * One revision of one task, as the revision read model holds it, or null (P-15/D1,
   * ADR 0105; B's verification note N1).
   *
   * What recovery holds a restated invocation's revision fields against: the id, the
   * envelope digest and the envelope's reference are read from the row the intake or
   * the opening folded, rather than trusted as whatever non-empty text an event
   * carried. By coordinate, from one read, with no clock and no write.
   */
  getTaskRevision(taskId: string, revisionNumber: number): TaskRevisionReadModel | null {
    this.#assertOpen("getTaskRevision");
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new LedgerQueryError("taskId must be a non-empty string");
    }
    if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
      throw new LedgerQueryError("revisionNumber must be a positive integer");
    }
    const row = this.#stmt(
      "SELECT * FROM task_revision_read_model WHERE task_id = ? AND revision_number = ?",
    ).get(taskId, revisionNumber) as TaskRevisionRow | undefined;
    return row === undefined ? null : taskRevisionRowToModel(row);
  }

  getExecutionRoute(taskId: string, attempt: number): ExecutionRouteReadModel | null {
    this.#assertOpen("getExecutionRoute");
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new LedgerQueryError("attempt must be a positive integer");
    }
    const row = this.#stmt(
      "SELECT * FROM execution_route_read_model WHERE task_id = ? AND attempt = ?",
    ).get(taskId, attempt) as ExecutionRouteRow | undefined;
    return row === undefined ? null : executionRouteRowToModel(row);
  }

  /** A task's recorded routes, in attempt order, so a retry's history reads in order. */
  listExecutionRoutes(taskId: string): readonly ExecutionRouteReadModel[] {
    this.#assertOpen("listExecutionRoutes");
    return (
      this.#stmt(
        "SELECT * FROM execution_route_read_model WHERE task_id = ? ORDER BY attempt ASC",
      ).all(taskId) as ExecutionRouteRow[]
    ).map(executionRouteRowToModel);
  }

  /** Tasks ordered by taskId, so two rebuilds produce identical pages. */
  listTasks(query: TaskQuery = {}): TaskPage {
    this.#assertOpen("listTasks");
    const limit = boundedLimit(query.limit, "task");

    const clauses = ["task_id > ?"];
    const params: (string | number)[] = [query.afterTaskId ?? ""];
    if (query.state !== undefined) {
      clauses.push("current_state = ?");
      params.push(query.state);
    }
    params.push(limit + 1);

    const rows = this.#stmt(
      "SELECT * FROM task_read_model WHERE " +
        clauses.join(" AND ") +
        " ORDER BY task_id ASC LIMIT ?",
    ).all(...params) as TaskRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const tasks = page.map(taskRowToModel);
    const last = tasks.at(-1);
    return {
      tasks,
      nextCursor: hasMore && last !== undefined ? last.taskId : null,
      hasMore,
    };
  }

  getWorker(identity: string): WorkerReadModel | null {
    this.#assertOpen("getWorker");
    const row = this.#stmt("SELECT * FROM worker_read_model WHERE identity = ?").get(identity) as
      | WorkerRow
      | undefined;
    return row === undefined ? null : workerRowToModel(row);
  }

  /** Observed workers ordered by identity, for the same determinism reason. */
  listWorkers(query: WorkerQuery = {}): WorkerPage {
    this.#assertOpen("listWorkers");
    const limit = boundedLimit(query.limit, "worker");

    const clauses = ["identity > ?"];
    const params: (string | number)[] = [query.afterIdentity ?? ""];
    if (query.role !== undefined) {
      clauses.push("role = ?");
      params.push(query.role);
    }
    if (query.provider !== undefined) {
      clauses.push("provider = ?");
      params.push(query.provider);
    }
    params.push(limit + 1);

    const rows = this.#stmt(
      "SELECT * FROM worker_read_model WHERE " +
        clauses.join(" AND ") +
        " ORDER BY identity ASC LIMIT ?",
    ).all(...params) as WorkerRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const workers = page.map(workerRowToModel);
    const last = workers.at(-1);
    return {
      workers,
      nextCursor: hasMore && last !== undefined ? last.identity : null,
      hasMore,
    };
  }

  /**
   * Effective configuration and position, read back from the connection.
   *
   * The pragmas are queried rather than echoed from the options, so this proves
   * what the connection actually negotiated instead of what was requested.
   */
  getInitiative(initiativeId: string): InitiativeReadModel | null {
    this.#assertOpen("getInitiative");
    const row = this.#stmt(
      "SELECT * FROM initiative_read_model WHERE initiative_id = ?",
    ).get(initiativeId) as InitiativeRow | undefined;
    return row === undefined ? null : initiativeRowToModel(row);
  }

  /**
   * Every initiative the stream has registered, in a stable order.
   *
   * The portfolio enumerator. It is deliberately **unpaged**, like
   * `listRoadmapVersions` beside it and unlike `listEvents` or `listTasks`: a
   * page belongs to a stream that grows without bound, and an initiative is
   * not one. A portfolio is a small, deliberately-declared set — offering a
   * cursor here would promise an advance that never comes and would make every
   * caller write a loop that runs once.
   *
   * Ordered by creation and then by id, so two reads of an unchanged ledger
   * return the same rows in the same order. Ordering by `updatedAt` would have
   * made a portfolio reshuffle itself as unrelated initiatives moved.
   */
  listInitiatives(): readonly InitiativeReadModel[] {
    this.#assertOpen("listInitiatives");
    const rows = this.#stmt(
      "SELECT * FROM initiative_read_model ORDER BY created_at ASC, initiative_id ASC",
    ).all() as InitiativeRow[];
    return rows.map(initiativeRowToModel);
  }

  /**
   * Every recorded roadmap version for one initiative, in version order.
   *
   * This is what a caller folds into the head the roadmap-version decision
   * consumes. It is a query rather than a decision input assembled inside the
   * module on purpose: the module never reads a ledger, so the fold has to
   * cross the boundary as a value.
   */
  listRoadmapVersions(initiativeId: string): readonly RoadmapVersionReadModel[] {
    this.#assertOpen("listRoadmapVersions");
    const rows = this.#stmt(
      "SELECT * FROM roadmap_version_read_model WHERE initiative_id = ? ORDER BY version ASC",
    ).all(initiativeId) as RoadmapVersionRow[];
    return rows.map(roadmapVersionRowToModel);
  }

  /**
   * Record one operator action against one account (P8-8G packet 2).
   *
   * The ledger decides no account policy. It records what the seam decided,
   * and refuses only what it alone can see: a replayed key, a reused event id.
   * There is no lifecycle guard here of the kind the task and initiative
   * streams carry, and that absence is deliberate — an account's lawful
   * transitions are the seam's to know, and duplicating them here would put
   * the same policy in two places with no mechanism keeping them equal.
   */
  appendAccountAction(candidate: unknown): AccountActionAppendResult {
    this.#assertOpen("appendAccountAction");
    this.#assertWritable("appendAccountAction");

    const parsed = AccountActionEvent.safeParse(candidate);
    if (!parsed.success) {
      throw new LedgerValidationError(toValidationIssues(parsed.error.issues));
    }
    const event = parsed.data;
    const canonicalJson = canonicalJsonStringify(event);

    const run = this.#db.transaction((): AccountActionAppendResult => {
      const existingByKey = this.#stmt(
        "SELECT sequence, event_id, event_json FROM account_events WHERE idempotency_key = ?",
      ).get(event.idempotencyKey) as
        | { readonly sequence: number; readonly event_id: string; readonly event_json: string }
        | undefined;

      if (existingByKey !== undefined) {
        if (existingByKey.event_json === canonicalJson) {
          return {
            inserted: false,
            record: {
              sequence: existingByKey.sequence,
              eventId: existingByKey.event_id,
              event: AccountActionEvent.parse(JSON.parse(existingByKey.event_json)),
            },
          };
        }
        throw new LedgerIdempotencyConflictError(
          event.idempotencyKey,
          sha256Hex(existingByKey.event_json),
          sha256Hex(canonicalJson),
        );
      }

      const existingById = this.#stmt(
        "SELECT idempotency_key FROM account_events WHERE event_id = ?",
      ).get(event.eventId) as { readonly idempotency_key: string } | undefined;
      if (existingById !== undefined) {
        throw new LedgerEventIdConflictError(
          event.eventId,
          existingById.idempotency_key,
          event.idempotencyKey,
        );
      }

      // Compare-and-set on the version this account is actually at (§9).
      //
      // The contract says `version` is assigned by the seam from the folded
      // history, and this is the ledger checking that claim rather than
      // believing it: an event claiming version N is admitted only when the
      // account is at N-1. Two seams racing on one account therefore cannot
      // both win, and a gap cannot open silently.
      //
      // It is NOT a lifecycle guard. Which transitions an account may make is
      // still the seam's to know, and nothing here duplicates that.
      const held = this.#stmt(
        "SELECT MAX(version) AS highest FROM account_events WHERE account_id = ?",
      ).get(event.accountId) as { readonly highest: number | null };
      const expected = (held.highest ?? 0) + 1;
      if (event.version !== expected) {
        throw new LedgerValidationError([
          {
            path: "version",
            message:
              "account " +
              safeAccountId(event.accountId) +
              " is at version " +
              String(held.highest ?? 0) +
              ", so the next action is version " +
              String(expected) +
              " and not " +
              String(event.version),
          },
        ]);
      }

      const info = this.#stmt(
        "INSERT INTO account_events (event_id, idempotency_key, account_id, version, action," +
          " resulting_state, actor, note, occurred_at, recorded_at, contract_version, event_json)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        event.eventId,
        event.idempotencyKey,
        event.accountId,
        event.version,
        event.action,
        event.resultingState,
        event.actor,
        event.note,
        event.occurredAt,
        event.recordedAt,
        event.contractVersion,
        canonicalJson,
      );

      const sequence = Number(info.lastInsertRowid);

      this.#faults.beforeProjection?.();

      // The row, its digest and the sidecar head, in this transaction. An
      // account event that landed without its link would leave a chain with a
      // hole that no later append could close, because the chain is
      // append-only and the missing link is in the middle.
      this.#appendAccountIntegrity(sequence);

      this.#faults.beforeAppendCommit?.();

      return {
        inserted: true,
        record: { sequence, eventId: event.eventId, event },
      };
    });
    return run.immediate();
  }

  /**
   * The sidecar's head, read with the same suspicion as a stream's.
   *
   * **Any absence is a finding here, unlike the file identity.** The two look
   * alike and are not. `instance_id` is written by code at open, so a ledger
   * migrated by an older build legitimately lacks it and a reader reports the
   * absence plainly. This activation is written by migration 10 itself, inside
   * the transaction that creates the sidecar — so a ledger this build can open
   * at all has it, because a read-only handle refuses a pending migration and a
   * writable one applies it. There is no lawful "migrated but not activated".
   *
   * A partial set is refused for the reason §8.2 states outright: hiding it
   * behind the word for "never activated" is exactly how a tampered baseline
   * would pass for an honest absence. A whole set missing is the same tampering
   * at a larger scale and gets the same answer.
   */
  #readAccountIntegrity(): AccountIntegrityState {
    const meta = this.#readMetaMap();
    const present = ACCOUNT_INTEGRITY_KEYS.filter((key) => meta.get(key) !== undefined);
    if (present.length !== ACCOUNT_INTEGRITY_KEYS.length) {
      throw new LedgerIntegrityError([
        "ledger_meta holds part of the account integrity activation and not the rest: " +
          (present.length === 0 ? "none of the five keys" : present.map(safeIdentifier).join(", ")),
      ]);
    }

    const baselineSequence = readCanonicalCount(meta.get(ACCOUNT_INTEGRITY_BASELINE_SEQUENCE) ?? "");
    const headSequence = readCanonicalCount(meta.get(ACCOUNT_INTEGRITY_HEAD_SEQUENCE) ?? "");
    if (baselineSequence === null || headSequence === null) {
      throw new LedgerIntegrityError([
        "ledger_meta holds an account integrity sequence that is not a count",
      ]);
    }
    const baselineSha256 = meta.get(ACCOUNT_INTEGRITY_BASELINE_SHA256) ?? "";
    const headEventSha256 = meta.get(ACCOUNT_INTEGRITY_HEAD_EVENT_SHA256) ?? "";
    if (!SHA256_PATTERN.test(baselineSha256) || !SHA256_PATTERN.test(headEventSha256)) {
      throw new LedgerIntegrityError([
        "ledger_meta holds an account integrity digest that is not a sha-256",
      ]);
    }
    const activatedAt = meta.get(ACCOUNT_INTEGRITY_ACTIVATED_AT) ?? "";
    if (!isInstant(activatedAt)) {
      throw new LedgerIntegrityError([
        "ledger_meta holds an account integrity activation instant that is not an instant",
      ]);
    }

    return { baselineSequence, baselineSha256, activatedAt, headSequence, headEventSha256 };
  }

  /**
   * Link one freshly appended account row into the sidecar, and move its head.
   *
   * Called inside the append transaction, never on its own. The activation
   * triple — baseline sequence, baseline digest, activation instant — is
   * deliberately untouched: it records where the retroactive coverage started
   * and must not drift as the stream grows past it.
   */
  #appendAccountIntegrity(sequence: number): void {
    const state = this.#readAccountIntegrity();
    if (state.headSequence !== sequence - 1) {
      throw new LedgerIntegrityError([
        "the account integrity chain reaches sequence " +
          String(state.headSequence) +
          " but the row being appended is sequence " +
          String(sequence),
      ]);
    }

    const row = this.#stmt(
      "SELECT " + ACCOUNT_EVENT_COLUMNS + " FROM account_events WHERE sequence = ?",
    )
      .safeIntegers(true)
      .get(sequence) as AccountEventRow | undefined;
    if (row === undefined) {
      throw new LedgerIntegrityError([
        "account_events holds no row at sequence " + String(sequence) + " to hash",
      ]);
    }

    const eventSha256 = accountIntegrityDigestV1({
      accountSequence: sequence,
      previousSha256: state.headEventSha256,
      row,
    });
    // `computed_at` is TEXT and the row now arrives as bytes, so the one
    // binding that goes back to the database is decoded for it. That is lawful
    // exactly here and nowhere else: this process wrote `recorded_at` from a
    // JavaScript string moments ago, in this same transaction, so the round
    // trip is lossless — and `computed_at` is metadata of the sidecar row,
    // deliberately outside the preimage, so no digest depends on it.
    this.#stmt(
      "INSERT INTO account_event_integrity " +
        "(account_sequence, previous_sha256, event_sha256, computed_at) VALUES (?, ?, ?, ?)",
    ).run(sequence, state.headEventSha256, eventSha256, row.recorded_at.toString("utf8"));

    this.#writeMeta(ACCOUNT_INTEGRITY_HEAD_SEQUENCE, String(sequence));
    this.#writeMeta(ACCOUNT_INTEGRITY_HEAD_EVENT_SHA256, eventSha256);
  }

  /**
   * One account's action history, oldest first.
   *
   * Oldest first because the fold that derives an account's effective state
   * walks it forward, and a reader wanting the current state takes the last
   * entry rather than re-sorting.
   */
  listAccountActions(accountId: string): readonly AccountActionRecordRow[] {
    this.#assertOpen("listAccountActions");
    const rows = this.#stmt(
      "SELECT sequence, event_id, event_json FROM account_events" +
        " WHERE account_id = ? ORDER BY version ASC",
    ).all(accountId) as {
      readonly sequence: number;
      readonly event_id: string;
      readonly event_json: string;
    }[];

    return Object.freeze(
      rows.map((row) => ({
        sequence: row.sequence,
        eventId: row.event_id,
        event: AccountActionEvent.parse(JSON.parse(row.event_json)),
      })),
    );
  }

  listInitiativeEvents(query: InitiativeEventQuery = {}): InitiativeEventPage {
    this.#assertOpen("listInitiativeEvents");
    const limit = boundedLimit(query.limit, "initiative event");

    const clauses: string[] = ["sequence > ?"];
    const parameters: unknown[] = [query.afterSequence ?? 0];

    if (query.initiativeId !== undefined) {
      clauses.push("initiative_id = ?");
      parameters.push(query.initiativeId);
    }
    if (query.type !== undefined) {
      clauses.push("type = ?");
      parameters.push(query.type);
    }

    const rows = this.#stmt(
      "SELECT " +
        INITIATIVE_EVENT_COLUMNS +
        " FROM initiative_events WHERE " +
        clauses.join(" AND ") +
        " ORDER BY sequence ASC LIMIT ?",
    ).all(...parameters, limit + 1) as InitiativeEventRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const events = page.map((row) => this.#initiativeRowToRecord(row));
    const last = events.at(-1);

    return {
      events,
      nextCursor: hasMore && last !== undefined ? last.sequence : null,
      hasMore,
    };
  }

  status(): LedgerStatus {
    this.#assertOpen("status");
    const head = this.#readHead();
    const initiativeHead = this.#readInitiativeHead();

    // One entry per projection, carrying the vector of heads it was built from
    // (P-09/log-D).
    //
    // The watermark table is keyed by (projection, stream), and since
    // P-09/log-C one projection contributes two rows to it. Until D there was
    // no DTO that could say so: `ProjectionStatus` had a single
    // `appliedThroughSequence`, and for a projection with two independent heads
    // there is no such number — stamping it with either one makes the other
    // unverifiable, which is the exact defect `projection_meta` had. So that
    // projection was omitted rather than described badly, and the omission was
    // named here as D's to undo. This is D: the head fields moved inside
    // `watermarks`, and every row of the table is published.
    //
    // Rows are grouped by name BEFORE anything is emitted. Emitting per row
    // would publish the two-source projection twice, with its `rowCount`
    // counted twice for one table.
    const grouped = new Map<string, WatermarkRow[]>();
    for (const row of this.#readWatermarks()) {
      // The name is database content, not a module constant. It is checked
      // against the closed set before it can ever be interpolated into SQL, so
      // a ledger whose metadata was edited fails loudly here instead of handing
      // an attacker-chosen identifier to the query planner.
      if (!PROJECTION_NAME_SET.has(row.projection_name)) {
        throw new LedgerIntegrityError([
          "projection_watermark holds the projection name " +
            safeIdentifier(row.projection_name) +
            " which this build does not define",
        ]);
      }
      const existing = grouped.get(row.projection_name);
      if (existing === undefined) grouped.set(row.projection_name, [row]);
      else existing.push(row);
    }

    // `#readWatermarks` orders by projection name and then by source stream, and
    // a Map keeps insertion order, so the projections come out by name and each
    // vector comes out by stream — which is the order the wire schema requires,
    // produced rather than sorted again here.
    const projections: ProjectionStatus[] = [];
    for (const [name, rows] of grouped) {
      // Once per projection, not once per row: it counts a table, and the
      // two-source projection has one table.
      const counted = this.#stmt("SELECT COUNT(*) AS n FROM " + name).get() as {
        readonly n: number;
      };
      // The latest of this projection's rows. Each stream's door updates only
      // its own row, so a projection fed by two streams has two independent
      // instants and "when did this projection last move" has exactly one
      // answer: the most recent. Lexicographic max is exact for this form —
      // fixed width, UTC, zero-padded throughout.
      let updatedAt = EPOCH_TIMESTAMP;
      const watermarks: ProjectionWatermarkStatus[] = [];
      for (const row of rows) {
        if (row.updated_at > updatedAt) updatedAt = row.updated_at;
        watermarks.push({
          sourceStream: row.source_stream,
          appliedThroughSequence: row.applied_sequence,
          eventCount: row.event_count,
          sourceHeadSha256: row.source_head_sha256,
        });
      }
      projections.push({ name, rowCount: counted.n, updatedAt, watermarks });
    }

    const migrations: AppliedMigration[] = readAppliedMigrations(this.#db);

    return {
      path: this.#path,
      readOnly: this.#readOnly,
      // Which file this is, beside the pragmas that say how it is open. Null
      // on a read-only handle over a ledger that predates this build; see
      // `#readIdentity`.
      instance: this.#readIdentity(),
      pragmas: {
        journalMode: this.#db.pragma("journal_mode", { simple: true }) as string,
        foreignKeys: (this.#db.pragma("foreign_keys", { simple: true }) as number) === 1,
        synchronous: this.#db.pragma("synchronous", { simple: true }) as number,
        busyTimeoutMs: this.#db.pragma("busy_timeout", { simple: true }) as number,
        queryOnly: (this.#db.pragma("query_only", { simple: true }) as number) === 1,
      },
      migrations,
      headSequence: head.sequence,
      headEventSha256: head.sha256,
      eventCount: head.count,
      initiativeHeadSequence: initiativeHead.sequence,
      initiativeHeadEventSha256: initiativeHead.sha256,
      initiativeEventCount: initiativeHead.count,
      projections,
    };
  }
}

/** The migration set this build defines, exposed for diagnostics. */
export const LEDGER_MIGRATIONS = MIGRATIONS;

/**
 * Open a ledger.
 *
 * A writable open creates the file if needed and applies any missing
 * migrations. A read-only open requires the file to exist, never migrates, and
 * refuses to proceed if the applied migration set is not exactly this build.
 */
export function openLedger(path: string, options: OpenLedgerOptions = {}): Ledger {
  return Ledger.open(path, options);
}
