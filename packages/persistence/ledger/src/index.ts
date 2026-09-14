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
  LedgerArtifactEncryptionConflictError,
} from "./errors/index.js";

// P8-8D-pre: the content-addressed artifact store. The Checkpoint law's twin —
// the ledger records a digest, and the bytes it names live here, in the package
// that owns the data root. Publication is atomic and an existing object is
// verified rather than trusted; there is no delete.
export type {
  ArtifactPublished,
  ArtifactRead,
  ArtifactRefusal,
  ArtifactRefused,
  PublishOutcome,
  ReadOutcome,
} from "./artifact-store/index.js";
export {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_REFUSALS,
  artifactDigest,
  // V2-B1f/F3: the one artifact-root rule, moved here from the gateway's
  // roadmap-write seam and deleted there. `ARTIFACT_DIRECTORY` stays
  // module-private, so exactly one new name leaves this package for it: three
  // packages that may not import an entrypoint now resolve a digest through the
  // same helper the roadmap write publishes through.
  artifactRootFor,
  hasArtifact,
  publishArtifact,
  readArtifact,
} from "./artifact-store/index.js";

/**
 * V2-B1f/F3: the checkpoint store.
 *
 * The Checkpoint law's other half. The artifact store above holds the bytes a
 * digest names; this factory is what turns an assembled `Checkpoint` into one
 * of those objects — parse, canonically serialize, publish — so the terminal
 * beat can append an event naming a digest the store already holds.
 *
 * One name leaves the package for it. The source, the step type and the
 * refusal vocabulary are all the caller's: `@acp/runtime` sits above this
 * package and may never be imported from it, so they travel as type parameters
 * rather than as a second set of declarations here.
 */
export { createCheckpointStore } from "./checkpoint-store/index.js";

export type { LedgerErrorCode, LedgerValidationIssue } from "./errors/index.js";

export type { Migration } from "./migrations/index.js";

/**
 * P-08: the account sidecar's preimage, version 1.
 *
 * A pure byte encoding, exported so the packet that builds the sidecar and the
 * suite that pins it by vector reach one implementation rather than two. It is
 * not canonical JSON and must never be confused with it: this hashes stored
 * bytes unchanged, that one rewrites a value into a canonical form.
 */
export {
  ACCOUNT_INTEGRITY_GENESIS_SHA256,
  ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1,
  accountIntegrityDigestV1,
  accountIntegrityPreimageV1,
} from "./account-integrity/index.js";
export type { AccountIntegrityInput } from "./account-integrity/index.js";

/**
 * P-05/A: the envelope revision preimage and its digest, version 1.
 *
 * The third of the four digests `docs/audit/architecture/contracts/index.md`
 * §14 keeps apart, and the one that says **which revision of the work** this
 * is. Exported for the reason the sidecar preimage above is: the packet that
 * wires it into the submission path and the suite that pins it by vector must
 * reach one implementation.
 *
 * It is canonical JSON, unlike the sidecar's encoding, and the two must never
 * be confused: that one hashes stored bytes exactly as they are, this one
 * hashes a value rewritten into its canonical form.
 */
export { envelopeIdentityPreimageV1, envelopeSha256 } from "./envelope-identity/index.js";

/**
 * V2 concurrency C1: the worktree arbitration store.
 *
 * A separate database from the ledger, answering the one question history
 * cannot: *may I write here, now?* Exported from this package because
 * `better-sqlite3` is fenced to it by equality, not because arbitration is a
 * ledger concern -- the store holds no history and is rebuildable.
 *
 * P-18/protocolo escalón E1 gave it the `coordination_store_meta` of §8.1 and a
 * `store_incarnation_id` on its rows, so the lease token is the pair
 * `(store_incarnation_id, fence)` rather than a number that repeats after a
 * restore. Both halves of the pair travel in `LeaseExpectedToken`.
 */
export { openLeaseStore } from "./lease-store/index.js";

/**
 * V2 X1a: the tool-coordinate claim store.
 *
 * A third database beside the ledger and the lease store, answering a third
 * question: *may I run this tool call, now?* Exported from this package for the
 * reason the lease store is — `better-sqlite3` is fenced here by equality — and
 * **inert**: nothing calls it yet, exactly as C1's store landed before C2 took
 * it. `toolClaimStorePath` is the single producer of its path, so two doors
 * cannot end up arbitrating over two different files.
 *
 * P-18/protocolo escalón E1 gave it the `coordination_store_meta` of §8.1 and a
 * `store_incarnation_id` on its rows. The claim token is the pair
 * `(store_incarnation_id, claim_id)` and carries **no fence**: a claim has no
 * counter, so a token shaped like the lease's would name a term this store
 * cannot answer for.
 */
export { TOOL_CLAIM_STATES, openToolClaimStore, toolClaimStorePath } from "./tool-claim-store/index.js";

export type {
  OpenToolClaimStoreOptions,
  ToolClaimDecision,
  ToolClaimExpectedToken,
  ToolClaimGrant,
  ToolClaimOutcome,
  ToolClaimRow,
  ToolClaimState,
  ToolClaimStore,
  ToolClaimStoreIncarnation,
} from "./tool-claim-store/index.js";

/**
 * P-18/protocolo escalón E2: the outbox message store.
 *
 * A fourth database beside the ledger, the lease store and the claim store,
 * answering a fourth question: *what should I send, now?* Exported from this
 * package for the reason the other two are — `better-sqlite3` is fenced here by
 * equality — and **inert**: nothing writes a row and nothing dispatches one,
 * exactly as C1's lease store landed before C2 took it and X1a's claim store
 * before X1b. `outboxStorePath` is the single producer of its path.
 *
 * It is the first store in this package to carry a compare-and-set over a
 * persisted `row_version`, because it is the first whose decision is carried
 * across an external dispatch instead of taken inside the write lock.
 */
export {
  MAX_OUTBOX_ROW_VERSION,
  OUTBOX_COMMAND_KINDS,
  OUTBOX_STATES,
  OUTBOX_STREAMS,
  OUTBOX_TERMINAL_STATES,
  OUTBOX_TRANSITIONS,
  openOutboxStore,
  outboxStorePath,
} from "./outbox-store/index.js";

export type {
  OpenOutboxStoreOptions,
  OutboxCasOutcome,
  OutboxCasToken,
  OutboxCommandKind,
  OutboxEventAnchor,
  OutboxIncarnation,
  OutboxMessageSeed,
  OutboxMutation,
  OutboxRow,
  OutboxState,
  OutboxStore,
  OutboxStream,
} from "./outbox-store/index.js";

/**
 * P-36/local escalón B: the artifact blob lease store.
 *
 * A fifth database beside the ledger and the three coordination stores,
 * answering the question artifacts §8 asks first: *may I operate on these bytes,
 * now?* One holding per digest, `PUBLISH` or `RECLAIM`, under the token
 * `(store_incarnation_id, generation)` plus the holder's identity. Exported for
 * the reason the others are — `better-sqlite3` is fenced here by equality. Its
 * one caller is the private artifact plane below (escalón C).
 * `artifactBlobLeaseStorePath` is the single producer of its path. It reads no
 * ledger, and no verb frees a blob by the clock.
 */
export {
  ARTIFACT_BLOB_LEASE_OPERATIONS,
  ARTIFACT_BLOB_LEASE_QUIESCENCE_BASES,
  ARTIFACT_BLOB_LEASE_REFUSALS,
  MAX_ARTIFACT_BLOB_LEASE_GENERATION,
  artifactBlobLeaseStorePath,
  openArtifactBlobLeaseStore,
} from "./artifact-lease-store/index.js";

export type {
  ArtifactBlobLeaseGrant,
  ArtifactBlobLeaseIncarnation,
  ArtifactBlobLeaseOperation,
  ArtifactBlobLeaseOutcome,
  ArtifactBlobLeaseQuiescence,
  ArtifactBlobLeaseQuiescenceBasis,
  ArtifactBlobLeaseRefusal,
  ArtifactBlobLeaseRow,
  ArtifactBlobLeaseStore,
  ArtifactBlobLeaseTestFaults,
  ArtifactBlobLeaseToken,
  OpenArtifactBlobLeaseStoreOptions,
} from "./artifact-lease-store/index.js";

/**
 * P-36/local escalón C: the private artifact plane.
 *
 * The publisher, the reader and the reconciler of artifacts §8 and §10, over
 * the ledger's artifact door and the blob lease store. A publication takes the
 * lease, records its intention with the reference it will record, writes and
 * verifies and synchronizes the bytes, and only then records the reference; a
 * read goes by reference and scope, never by digest; a crash between any two
 * steps is reconciled from the lease row and the live publication pin, after a
 * caller's quiescence attestation. The bytes live under `private-artifacts/`,
 * whose one producer is `artifactPlaneRootFor`, apart from the legacy digest
 * store above. No producer in the field calls it yet.
 */
export {
  ARTIFACT_PLANE_CONTENT_MAX_BYTES,
  ARTIFACT_PLANE_REFUSALS,
  artifactPlaneRootFor,
  openArtifactPlane,
} from "./artifact-plane/index.js";

export type {
  ArtifactEventIdentity,
  ArtifactPlane,
  ArtifactPlaneHolding,
  ArtifactPlaneOutcome,
  ArtifactPlaneRefusal,
  ArtifactPlaneTestFaults,
  ArtifactPublicationRequest,
  ArtifactReadOutcome,
  ArtifactReadRequest,
  ArtifactReconciliationRequest,
  ArtifactReferenceIntent,
  OpenArtifactPlaneOptions,
} from "./artifact-plane/index.js";

export type {
  LeaseDecision,
  LeaseExpectedToken,
  LeaseGrant,
  LeaseStoreIncarnation,
  LeaseStoreOutcome,
  LeaseRow,
  LeaseStore,
  OpenLeaseStoreOptions,
} from "./lease-store/index.js";

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

/**
 * P-32/captura escalón A: the usage settlement fold and the stream identity.
 *
 * Pure. Exported so a producer and a suite compute the one stream id the door
 * recomputes. Escalón B's append door and its rebuild are the fold's only
 * callers: the fence holds that no source outside the module, this barrel, the
 * ledger and the projection names them (L-P32B-1, ADR 0089).
 */
export {
  USAGE_FOLD_VERSION_V1,
  USAGE_MEASUREMENT_STREAM_PREIMAGE_PREFIX_V1,
  USAGE_REPORT_KINDS,
  USAGE_SETTLEMENT_REFUSALS,
  USAGE_SETTLEMENT_STATUSES,
  USAGE_SETTLEMENT_TOKENS_MAX,
  USAGE_SOURCE_CLASSES,
  USAGE_SOURCE_POLICY_SHA256_V1,
  USAGE_SOURCE_POLICY_V1,
  foldUsageSettlement,
  measurementStreamIdV1,
  measurementStreamPreimageV1,
} from "./usage-settlement/index.js";

export type {
  UsageMeasurementStreamCoordinate,
  UsageMeasurementStreamInput,
  UsageObservationInput,
  UsageReportKind,
  UsageSettlement,
  UsageSettlementCut,
  UsageSettlementGranted,
  UsageSettlementHeader,
  UsageSettlementOutcome,
  UsageSettlementPrevious,
  UsageSettlementRefusal,
  UsageSettlementRefused,
  UsageSettlementRequest,
  UsageSettlementSegment,
  UsageSettlementSourceHead,
  UsageSettlementStatus,
  UsageSettlementTrigger,
  UsageSourceClass,
} from "./usage-settlement/index.js";

/**
 * P-14 escalón B: the initiative registration, by command and by API.
 *
 * One orchestration both doors call: the decision over `Initiative`, the
 * objective published to the private plane under the initiative's scope, and
 * one `INITIATIVE_REGISTERED` whose closed payload carries the objective's digest
 * and reference and never the objective. The reader resolves the objective back
 * by reference for the cohort that published one.
 */
export {
  INITIATIVE_OBJECTIVE_ENCRYPTION_PROFILE,
  INITIATIVE_OBJECTIVE_HOLDING_WINDOW_MS,
  INITIATIVE_OBJECTIVE_MEDIA_TYPE,
  INITIATIVE_REGISTRATION_REFUSALS,
  INITIATIVE_REGISTRATION_TRANSITION_ID,
  INITIATIVE_REGISTRATION_WRITE_REFUSALS,
  decideInitiativeRegistration,
  initiativeObjectiveIdempotencyKeys,
  initiativeRegistrationEvent,
  initiativeRegistrationIdempotencyKey,
  readInitiativeObjective,
  recordedInitiativeRegistrationOf,
  registerInitiative,
} from "./initiative-registration/index.js";

export type {
  InitiativeRegistrationDecision,
  InitiativeRegistrationDecisionRequest,
  InitiativeRegistrationFields,
  InitiativeRegistrationIdentities,
  InitiativeRegistrationInput,
  InitiativeRegistrationOutcome,
  InitiativeRegistrationRefusal,
  InitiativeRegistrationTestFaults,
  InitiativeRegistrationWriteRefusal,
  RecordedInitiativeRegistration,
  RegisteredInitiative,
} from "./initiative-registration/index.js";

export type {
  AppendBatchResult,
  AppendResult,
  AppliedMigration,
  ArtifactAppendResult,
  ArtifactBlobReadModel,
  ArtifactEventRecord,
  ArtifactPinReadModel,
  ArtifactReferenceReadModel,
  ArtifactTombstoneReadModel,
  CausationRef,
  CausationStream,
  CoverageKind,
  DispatchAttemptReadModel,
  DispatchState,
  DocumentKind,
  EffectLookup,
  EffectLookupQuery,
  EffectOutcomeStatus,
  EffectReadModel,
  EventPage,
  EventQuery,
  ExecutionEffectKind,
  ExecutionRouteReadModel,
  ExecutionRouteSegmentReadModel,
  InitiativeAppendResult,
  InitiativeEventPage,
  InitiativeEventQuery,
  InitiativeEventRecord,
  InitiativeReadModel,
  IntegrityProblem,
  IntegrityProblemKind,
  IntegrityReport,
  GlobalRoutingAssignmentReading,
  ModelResolutionStatus,
  ModelVersionEntry,
  ModelVersionReadModel,
  ModelVersionReading,
  ModelVersionStatus,
  OutboxCommandReadModel,
  OutboxFailureCode,
  PriceIntervalQuery,
  PriceIntervalReadModel,
  PriceTokenClass,
  PromptOccurrenceReadModel,
  RedactionVerdict,
  ResponseOccurrenceReadModel,
  LedgerEventRecord,
  LedgerIdentity,
  LedgerPragmaStatus,
  LedgerStatus,
  LedgerTestFaults,
  OpenLedgerOptions,
  ProjectionStatus,
  ProjectionWatermarkStatus,
  RebuildResult,
  RegistryAppendResult,
  RegistryDocument,
  RegistryEventRecord,
  RegistryWatermarkReading,
  RoadmapVersionReadModel,
  RoutingAssignmentFallbackRow,
  RoutingAssignmentReadModel,
  StreamIntegrityCoverage,
  TaskAttemptReadModel,
  TaskPage,
  TaskQuery,
  TaskIntakePayload,
  TaskIntakeResolution,
  TaskIntakeWatermark,
  TaskReadModel,
  TaskRevisionReadModel,
  TaskSubmissionReadModel,
  UsageMeasurementStreamReadModel,
  UsageObservationReadModel,
  UsageSettlementObservationReadModel,
  UsageSettlementReadModel,
  UsageSettlementSourceHeadReadModel,
  WorkerPage,
  WorkerQuery,
  WorkerReadModel,
} from "./types/index.js";

/**
 * The registry stream's document vocabulary (P-09/log-C).
 *
 * **Provisional.** It belongs in `@acp/contracts` and lives here because that
 * package owns no schema for these documents and its schema barrel is a pinned
 * re-export that cannot receive a definition. When a contracts packet takes
 * ownership, this export moves and this note goes with it. Nothing outside this
 * package imports it today.
 */
export { DOCUMENT_KINDS } from "./types/index.js";

/**
 * The model version registry's two closed sets (P-14 A, ADR 0085).
 *
 * The lifecycle words and the nine payload keys a `MODEL_VERSION` document is
 * held to at the door. Exported beside `DOCUMENT_KINDS` for its reason: the
 * vocabulary lives where the door that imposes it lives, and a producer that
 * restated either list would be a second authority on the payload's shape.
 */
export { MODEL_VERSION_PAYLOAD_KEYS, MODEL_VERSION_STATUSES } from "./types/index.js";

/**
 * The price interval catalog's three closed sets (P-33/catálogo A, ADR 0091).
 *
 * The payload's one key, the eight keys of an interval and the four token
 * classes a `PRICE_TABLE` is held to at the door. Exported beside the model
 * version's, for their reason: a producer that restated them would be a second
 * authority on the catalog's shape.
 */
export { PRICE_INTERVAL_KEYS, PRICE_TABLE_PAYLOAD_KEYS, PRICE_TOKEN_CLASSES } from "./types/index.js";

/**
 * Price resolution inside a pinned catalog version (P-33/catálogo B, ADR 0092).
 *
 * The verb, its closed status vocabulary and the four shapes it speaks in. This
 * is the ONLY way to reach the selection: L-P33B-1 holds that no production
 * source outside the module and this barrel names it, so a consumer that wanted
 * a price asks here rather than writing the half-open comparison a second time
 * — which is how two answers to one spend get into a system.
 */
export { PRICE_RESOLUTION_STATUSES, resolvePrice } from "./price-catalog/index.js";
export type {
  PriceFound,
  PriceKey,
  PriceMissing,
  PricePin,
  PriceResolution,
  PriceResolutionStatus,
} from "./price-catalog/index.js";

/**
 * P-14 escalón C: the task intake's closed payload, its transition and the
 * client key's grammar (ADR 0087).
 *
 * The fold holds the stream to these, and `@acp/runtime`'s intake is the one
 * producer of the shape, so the producer reads them from here rather than
 * restating them: `taskIntakePayloadOf` is the fold's own reading of one event,
 * which the producer uses to read a recorded intake back for a replay.
 */
export {
  TASK_CLIENT_KEY_PATTERN,
  TASK_INTAKE_PAYLOAD_KEYS,
  TASK_INTAKE_RESOLUTION_KEYS,
  TASK_INTAKE_TRANSITION_ID,
  TASK_INTAKE_WATERMARK_KEYS,
} from "./types/index.js";
export { taskIntakePayloadOf } from "./projection/index.js";

/**
 * The artifact plane's two closed sets (P-36/local A, ADR 0081).
 *
 * Which six of the contract's nine artifact event words this build records, and
 * the one access policy a reference may name. Both are facts about this build
 * rather than about the contract — decision 45's class — so they are exported
 * from here, where the door that imposes them lives, and not from
 * `@acp/contracts`, which owns the vocabulary itself.
 */
export { ARTIFACT_ACCESS_POLICY_IDS, DELIVERED_ARTIFACT_EVENT_KINDS } from "./types/index.js";

/**
 * The execution vocabularies of P-18/protocolo C.
 *
 * Four closed sets and one transition map, exported for the reason
 * `DOCUMENT_KINDS` is: the producer is a later escalón and the suite is now,
 * and a consumer that restated any of them would be a second authority on a
 * question the dictionary answers once. Why the effect-kind catalogue lives
 * here rather than in `@acp/contracts` is argued where it is declared — it is
 * decision 45's class, not decision 42's.
 *
 * `REDACTION_VERDICTS` joins them in P-18/protocolo D, for the same reason and
 * in the same place: the answer's verdict is a word this package's door and
 * migration impose, and exporting it from the contract would move a pin for a
 * fact only this package reads (ADR 0077).
 */
export {
  DISPATCH_STATES,
  DISPATCH_STATE_TRANSITIONS,
  EFFECT_OUTCOME_STATUSES,
  EXECUTION_EFFECT_KINDS,
  EXECUTION_REQUEST_CONTRACT_VERSIONS,
  MODEL_RESOLUTION_STATUSES,
  REDACTION_VERDICTS,
} from "./types/index.js";

/**
 * The identity functions of execution §6 and §6.1 (P-18/protocolo C).
 *
 * The two derived keys and the two digests of the dictionary, exported so the
 * producer escalón and the suite compute them the one way — the split
 * `envelopeSha256` already established, with the grammar in `@acp/contracts`
 * and the one canonicalizer and the one sha-256 here.
 */
export {
  effectIdPreimageV1,
  effectIdV1,
  effectIdempotencyKeyV1,
  effectIdempotencyPreimageV1,
  logicalOperationSha256,
  requestSha256,
} from "./projection/index.js";

/**
 * The outbox command saga's identity and its reconstruction (P-18/protocolo F).
 *
 * `computeOutboxCommandId` is exported so a producer computes `command_id` the
 * one way the door recomputes it — `@acp/runtime`'s quarantine builder is the
 * first caller, and it calls this rather than restating the formula.
 * `foldOutboxCommands` is what a lost cache is rebuilt to, as a pure function of
 * stream events; the ledger's `listOutboxCommands` answers the same question
 * over its own stream. The V1 matrix and the payload version travel with them
 * for the reason the execution vocabularies above do.
 */
export {
  OUTBOX_CONTRACT_VERSION,
  OUTBOX_V1_COMMAND_STREAMS,
  computeOutboxCommandId,
  foldOutboxCommands,
  outboxCommandIdPreimageV1,
} from "./projection/index.js";

export type { OutboxEventEntry } from "./projection/index.js";

export type {
  AccountActionAppendResult,
  AccountActionRecordRow,
  AccountEventRow,
} from "./types/index.js";

/**
 * The account-action vocabulary, re-exported for the server (P8-8G packet 2).
 *
 * The server's dependency surface does not include `@acp/contracts` and the
 * fence enforces that, so the seam reaches these through the package it does
 * depend on. Re-exported rather than restated: one declaration, and a name
 * added upstream cannot fail to arrive here.
 */
export {
  ACCOUNT_ACTIONS,
  ACCOUNT_ACTION_NOTE_MAX,
  ACCOUNT_ACTION_STATE,
  CONTRACT_VERSION as LEDGER_ACCOUNT_CONTRACT_VERSION,
} from "@acp/contracts";
export type { AccountAction, AccountStatus } from "@acp/contracts";
