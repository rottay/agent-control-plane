/**
 * Typed failures of the durability plane.
 *
 * Every one of these is a refusal, not a retry hint. The plane's job in an
 * ambiguous situation is to stop with a classified reason, because the
 * alternative is guessing about an effect that may already have happened.
 */

export type RuntimeErrorCode =
  | "TOY_BOUNDARY"
  | "POSTCONDITION_UNKNOWN"
  | "LIFECYCLE_PLAN"
  | "SUPERVISOR"
  | "RECONCILIATION"
  | "DISPATCH_REFUSED"
  | "OPERATION_FAILED";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

/**
 * A path escaped the drill boundary.
 *
 * Raised before any effect and before any ledger open. The runtime owns its
 * scenario root and never accepts a target directory from a caller, so this
 * error means a scenario identifier was malformed or a symlink pointed out of
 * the sandbox, both of which are refusals rather than conditions to recover
 * from.
 */
export class ToyBoundaryError extends RuntimeError {
  constructor(message: string) {
    super("TOY_BOUNDARY", message);
    this.name = "ToyBoundaryError";
  }
}

/**
 * A postcondition probe could not establish whether the effect happened.
 *
 * This is the fail-closed case the whole three-beat order exists to serve. No
 * outcome is appended, the intent stays open, and an operator decides. A system
 * that guessed here would eventually guess wrong about something that mattered.
 */
export class PostconditionUnknownError extends RuntimeError {
  readonly operationId: string;

  constructor(operationId: string, message: string) {
    super("POSTCONDITION_UNKNOWN", message);
    this.name = "PostconditionUnknownError";
    this.operationId = operationId;
  }
}

/** The observed ledger state does not correspond to any step in the plan. */
export class LifecyclePlanError extends RuntimeError {
  constructor(message: string) {
    super("LIFECYCLE_PLAN", message);
    this.name = "LifecyclePlanError";
  }
}

/** The supervisor could not proceed. Carries no path and no event content. */
export class SupervisorError extends RuntimeError {
  constructor(message: string) {
    super("SUPERVISOR", message);
    this.name = "SupervisorError";
  }
}

/** Reconciliation could not be completed, so resuming is not permitted. */
export class ReconciliationError extends RuntimeError {
  constructor(message: string) {
    super("RECONCILIATION", message);
    this.name = "ReconciliationError";
  }
}

/**
 * A delivery was refused before any spend (P-15 escalón D3, ADR 0105; decision 141).
 *
 * The recorded walk resolves the price pin before it intends the effect: no
 * catalog version in force at the walk's instant, or one that does not cover the
 * segment's provider, model version and transport, and nothing is intended, no
 * process is started and no call is made. The walk settles `FAILED` on it, because
 * "no catalog prices this model" is a definitive answer rather than an uncertainty.
 * `at` names the fact that refused, never a value.
 */
export class DispatchRefusedError extends RuntimeError {
  readonly at: string;

  constructor(at: string, message: string) {
    super("DISPATCH_REFUSED", message);
    this.name = "DispatchRefusedError";
    this.at = at;
  }
}

/**
 * The model answered, and its answer was a failure (P-15 escalón D3, ADR 0105;
 * decision 141).
 *
 * Raised after the effect's outcome and the response occurrence are durable, and
 * before the evidence marker: a task never reaches `CHECKPOINTED` on an effect that
 * did not succeed with a result (P-07 C10). Distinct from `DispatchRefusedError`,
 * so a drill can tell "no catalog covers the model" from "the model said it
 * failed". `reason` is the decider's closed word, never provider output.
 */
export class OperationFailedError extends RuntimeError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super("OPERATION_FAILED", message);
    this.name = "OperationFailedError";
    this.reason = reason;
  }
}
