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
  | "LEDGER_QUERY";

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

/** A query argument is outside the bounds the ledger accepts. */
export class LedgerQueryError extends LedgerError {
  constructor(message: string) {
    super("LEDGER_QUERY", message);
    this.name = "LedgerQueryError";
  }
}
