import type { RoadmapVersionRefusal } from "../roadmap-version/index.js";
import type { TaskGraphRefusal } from "../task-graph/index.js";
import type { TaskStepLinkRefusal } from "../task-step-link/index.js";

/**
 * Typed ledger errors.
 *
 * Every error in this module is safe to log, attach to a checkpoint or hand to
 * an auditor. None of them embeds an event payload, a canonical event body, a
 * provider transcript or credential material. A conflict is described by its
 * coordinates and by digests, never by the content that conflicted.
 *
 * That is a security property, not a style preference: the roadmap forbids a
 * secret from reaching logs, and a diagnostic that echoes a rejected payload
 * would be the easiest way to leak one.
 */

export type LedgerErrorCode =
  | "LEDGER_OPEN"
  | "LEDGER_CLOSED"
  | "LEDGER_READ_ONLY"
  | "LEDGER_MIGRATION"
  | "LEDGER_VALIDATION"
  | "LEDGER_CANONICALIZATION"
  | "LEDGER_IDEMPOTENCY_CONFLICT"
  | "LEDGER_EVENT_ID_CONFLICT"
  | "LEDGER_LIFECYCLE_CONFLICT"
  | "LEDGER_SEQUENCE"
  | "LEDGER_INTEGRITY"
  | "LEDGER_QUERY"
  | "LEDGER_ARTIFACT_ENCRYPTION_CONFLICT"
  | "LEDGER_ROADMAP_VERSION_REFUSED"
  | "LEDGER_INITIATIVE_BATCH_CONFLICT"
  | "LEDGER_TASK_GRAPH_REFUSED"
  | "LEDGER_TASK_STEP_LINK_REFUSED";

/** Base class for everything this package throws deliberately. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

/** The database file could not be opened under the requested mode. */
export class LedgerOpenError extends LedgerError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super("LEDGER_OPEN", "cannot open ledger at " + path + ": " + reason);
    this.name = "LedgerOpenError";
    this.path = path;
  }
}

/** A handle was used after close(). */
export class LedgerClosedError extends LedgerError {
  constructor(operation: string) {
    super("LEDGER_CLOSED", "ledger handle is closed; " + operation + " is not available");
    this.name = "LedgerClosedError";
  }
}

/** A mutating operation was attempted on a read-only handle. */
export class LedgerReadOnlyError extends LedgerError {
  constructor(operation: string) {
    super("LEDGER_READ_ONLY", "ledger is open read-only; " + operation + " is denied");
    this.name = "LedgerReadOnlyError";
  }
}

/**
 * The applied migration set does not match the migration set in code.
 *
 * This is always fatal. A ledger whose schema history is missing, extra,
 * reordered or checksum-mismatched is not a ledger this build understands, and
 * guessing would be how a corrupted authority quietly becomes the truth.
 */
export class LedgerMigrationError extends LedgerError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      "LEDGER_MIGRATION",
      "migration set does not match this build: " + problems.join("; "),
    );
    this.name = "LedgerMigrationError";
    this.problems = problems;
  }
}

/** One contract validation issue, reduced to a path and a reason. */
export interface LedgerValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The candidate event is not a valid ControlPlaneEvent.
 *
 * Only the issue path and the contract message are carried. The rejected value
 * is never attached, because rejection is exactly the case where the value is
 * most likely to hold something that must not be logged.
 */
export class LedgerValidationError extends LedgerError {
  readonly issues: readonly LedgerValidationIssue[];

  constructor(issues: readonly LedgerValidationIssue[]) {
    super(
      "LEDGER_VALIDATION",
      "event does not satisfy the ControlPlaneEvent contract: " +
        issues.map((issue) => issue.path + ": " + issue.message).join("; "),
    );
    this.name = "LedgerValidationError";
    this.issues = issues;
  }
}

/** A value in the event tree has no lossless, deterministic JSON form. */
export class LedgerCanonicalizationError extends LedgerError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super("LEDGER_CANONICALIZATION", "value at " + path + " is not canonical JSON: " + reason);
    this.name = "LedgerCanonicalizationError";
    this.path = path;
  }
}

/**
 * The idempotency key is already present with different canonical content.
 *
 * An exact replay is not an error and never reaches this class: it returns the
 * original record with inserted false. This is the other case, where the same
 * coordinates were reused for a different event, and it fails closed.
 */
export class LedgerIdempotencyConflictError extends LedgerError {
  readonly idempotencyKey: string;
  /** SHA-256 of the stored canonical body, not the chain digest. */
  readonly storedContentSha256: string;
  /** SHA-256 of the rejected canonical body. The body itself is never carried. */
  readonly incomingContentSha256: string;

  constructor(
    idempotencyKey: string,
    storedContentSha256: string,
    incomingContentSha256: string,
  ) {
    super(
      "LEDGER_IDEMPOTENCY_CONFLICT",
      "idempotency key " +
        idempotencyKey +
        " is already recorded with different content: stored body digest " +
        storedContentSha256 +
        ", incoming body digest " +
        incomingContentSha256,
    );
    this.name = "LedgerIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
    this.storedContentSha256 = storedContentSha256;
    this.incomingContentSha256 = incomingContentSha256;
  }
}

/** The eventId is already recorded under a different idempotency key. */
export class LedgerEventIdConflictError extends LedgerError {
  readonly eventId: string;
  readonly storedIdempotencyKey: string;
  readonly incomingIdempotencyKey: string;

  constructor(
    eventId: string,
    storedIdempotencyKey: string,
    incomingIdempotencyKey: string,
  ) {
    super(
      "LEDGER_EVENT_ID_CONFLICT",
      "event id " +
        eventId +
        " is already recorded under idempotency key " +
        storedIdempotencyKey +
        " and cannot be reused under " +
        incomingIdempotencyKey,
    );
    this.name = "LedgerEventIdConflictError";
    this.eventId = eventId;
    this.storedIdempotencyKey = storedIdempotencyKey;
    this.incomingIdempotencyKey = incomingIdempotencyKey;
  }
}

/**
 * The event does not transition from the state the task is actually in.
 *
 * A first event for a task must declare fromState null. Every later event must
 * declare the projected current state. A stale writer therefore cannot append
 * a transition computed against a state the task has already left.
 */
export class LedgerLifecycleConflictError extends LedgerError {
  readonly taskId: string;
  readonly declaredFromState: string | null;
  readonly actualCurrentState: string | null;

  constructor(
    taskId: string,
    declaredFromState: string | null,
    actualCurrentState: string | null,
  ) {
    super(
      "LEDGER_LIFECYCLE_CONFLICT",
      "task " +
        taskId +
        " is in state " +
        (actualCurrentState ?? "<no recorded state>") +
        " but the event declares fromState " +
        (declaredFromState ?? "null"),
    );
    this.name = "LedgerLifecycleConflictError";
    this.taskId = taskId;
    this.declaredFromState = declaredFromState;
    this.actualCurrentState = actualCurrentState;
  }
}

/** The database assigned a sequence the ledger head does not agree with. */
export class LedgerSequenceError extends LedgerError {
  readonly expectedSequence: number;
  readonly actualSequence: number;

  constructor(expectedSequence: number, actualSequence: number) {
    super(
      "LEDGER_SEQUENCE",
      "expected the next sequence to be " +
        String(expectedSequence) +
        " but the database assigned " +
        String(actualSequence),
    );
    this.name = "LedgerSequenceError";
    this.expectedSequence = expectedSequence;
    this.actualSequence = actualSequence;
  }
}

/** A rebuild or replay refused to trust the stored event stream. */
export class LedgerIntegrityError extends LedgerError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super("LEDGER_INTEGRITY", "stored event stream is not trustworthy: " + problems.join("; "));
    this.name = "LedgerIntegrityError";
    this.problems = problems;
  }
}

/**
 * A publication would reuse a blob generation under another encryption policy
 * (P-36/local A, artifacts §3 and §10.1).
 *
 * A deduplication never changes how a blob is encrypted: the generation keeps
 * the `encryption_status`, `key_reference` and `encryption_profile` it was born
 * with, and an intention that disagrees is refused with this named error rather
 * than folded silently. Changing the policy is an explicit encryption migration,
 * which no build has yet. The message names the content, the generation and
 * which fields differ; it never carries a key reference or a profile, because a
 * refusal is exactly where a value that must not be logged would travel.
 */
export class LedgerArtifactEncryptionConflictError extends LedgerError {
  readonly contentSha256: string;
  readonly blobGeneration: number;
  readonly fields: readonly string[];

  constructor(contentSha256: string, blobGeneration: number, fields: readonly string[]) {
    super(
      "LEDGER_ARTIFACT_ENCRYPTION_CONFLICT",
      "artifact content " +
        contentSha256 +
        " generation " +
        String(blobGeneration) +
        " is recorded under a different encryption policy (" +
        fields.join(", ") +
        "); a deduplication never changes a blob's encryption, and changing it is an explicit migration",
    );
    this.name = "LedgerArtifactEncryptionConflictError";
    this.contentSha256 = contentSha256;
    this.blobGeneration = blobGeneration;
    this.fields = fields;
  }
}

/**
 * The initiative door refused a roadmap version (P-26/A, ADR 0110).
 *
 * The door runs `decideRoadmapVersion` inside the append's own transaction, over
 * the fold that transaction keeps level with the stream, and throws this when the
 * decision refuses; the projection throws it too, for a version the fold has
 * already seen under either key. It carries the decision's word and the field that
 * failed, never the roadmap: the same rule every class here keeps.
 */
export class LedgerRoadmapVersionRefusedError extends LedgerError {
  readonly reason: RoadmapVersionRefusal;
  /** The field that failed. Never roadmap content. */
  readonly at: string;

  constructor(reason: RoadmapVersionRefusal, at: string) {
    super(
      "LEDGER_ROADMAP_VERSION_REFUSED",
      "the roadmap version was refused: " + reason + " at " + at,
    );
    this.name = "LedgerRoadmapVersionRefusedError";
    this.reason = reason;
    this.at = at;
  }
}

/**
 * An initiative batch meets a stream that holds part of it, or all of it otherwise
 * (P-26 cut B, ADR 0111).
 *
 * The batch door answers a whole-batch replay — every key present, every stored
 * body equal, contiguous in the batch's own order — with the stored records, and
 * everything else that finds a key already recorded with this. It is not the
 * single door's per-event conflict: a partial batch cannot be retried into being,
 * because no door writes part of one (L-P26B-1), so "some keys exist" means another
 * writer or a torn history. The coordinates are carried, never a body.
 */
export class LedgerInitiativeBatchConflictError extends LedgerError {
  readonly initiativeId: string;
  /** How many of the batch's keys the stream already holds. */
  readonly recordedKeys: number;
  readonly batchSize: number;

  constructor(initiativeId: string, recordedKeys: number, batchSize: number, reason: string) {
    super(
      "LEDGER_INITIATIVE_BATCH_CONFLICT",
      "initiative " +
        initiativeId +
        " already records " +
        String(recordedKeys) +
        " of this batch's " +
        String(batchSize) +
        " keys, and " +
        reason +
        "; a batch is recorded whole or replayed whole",
    );
    this.name = "LedgerInitiativeBatchConflictError";
    this.initiativeId = initiativeId;
    this.recordedKeys = recordedKeys;
    this.batchSize = batchSize;
  }
}

/**
 * The initiative door refused a task graph revision by the decision's word, or the
 * fold met a revision the door would have refused (P-27 cut A, ADR 0115).
 *
 * `LedgerRoadmapVersionRefusedError`'s mould: the word and the field, never a value.
 * A cycle's `at` names the nodes on it by task id and revision number, which are
 * identifiers, never content.
 */
export class LedgerTaskGraphRefusedError extends LedgerError {
  readonly reason: TaskGraphRefusal;
  /** The field, or the nodes, that failed. Never content. */
  readonly at: string;

  constructor(reason: TaskGraphRefusal, at: string) {
    super("LEDGER_TASK_GRAPH_REFUSED", "the task graph was refused: " + reason + " at " + at);
    this.name = "LedgerTaskGraphRefusedError";
    this.reason = reason;
    this.at = at;
  }
}

/**
 * The initiative door refused a task's step link by the decision's word, or the fold
 * met a link the door would have refused (P-27 cut C, ADR 0116).
 *
 * `LedgerTaskGraphRefusedError`'s mould: the word and the field, never a value.
 */
export class LedgerTaskStepLinkRefusedError extends LedgerError {
  readonly reason: TaskStepLinkRefusal;
  /** The field that failed. Never content. */
  readonly at: string;

  constructor(reason: TaskStepLinkRefusal, at: string) {
    super("LEDGER_TASK_STEP_LINK_REFUSED", "the task step link was refused: " + reason + " at " + at);
    this.name = "LedgerTaskStepLinkRefusedError";
    this.reason = reason;
    this.at = at;
  }
}

/** A query argument is outside the bounds the ledger accepts. */
export class LedgerQueryError extends LedgerError {
  constructor(message: string) {
    super("LEDGER_QUERY", message);
    this.name = "LedgerQueryError";
  }
}
