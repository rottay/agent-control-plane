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

export type {
  AppendBatchResult,
  AppendResult,
  AppliedMigration,
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
  ModelResolutionStatus,
  OutboxCommandReadModel,
  OutboxFailureCode,
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
  RoadmapVersionReadModel,
  RoutingAssignmentFallbackRow,
  RoutingAssignmentReadModel,
  StreamIntegrityCoverage,
  TaskAttemptReadModel,
  TaskPage,
  TaskQuery,
  TaskReadModel,
  TaskRevisionReadModel,
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
