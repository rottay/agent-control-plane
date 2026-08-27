import type {
  ControlPlaneEvent,
  DriverMode,
  DriverStatus,
  ReconciliationReport,
  TaskState,
} from "@acp/contracts";
import type { Context } from "@restatedev/restate-sdk";

/**
 * Package-internal contracts for the durability plane.
 *
 * These are deliberately NOT in `@acp/contracts`. The public package holds data
 * a reader may see; this file holds the shape a driver must satisfy, which is
 * an implementation concern and would be a liability frozen into the public
 * surface before a single driver exists.
 *
 * Nothing here executes. There is no driver in P2A.
 */

// ---------------------------------------------------------------------------
// Determinism law
// ---------------------------------------------------------------------------

/**
 * The only three provenances a coordinate may have.
 *
 * This is the load-bearing rule of the whole phase. The ledger treats "same
 * idempotency key, different canonical bytes" as a typed conflict and fails
 * closed. So any value that ends up inside a ledger event must be reproducible
 * if the code that produced it runs twice.
 *
 * The SDK's own documentation is explicit that this can happen: "There is a
 * small window where an action may be re-run, if a failure occurred between a
 * successful run and persisting the result." A coordinate built from
 * `Date.now()` or `crypto.randomUUID()` in that window comes back different,
 * and a benign replay becomes a hard idempotency conflict at exactly the moment
 * the system is trying to recover.
 *
 * - `DERIVED`: a pure function of durable invocation inputs. Same inputs, same
 *   output, forever, with no ambient state consulted.
 * - `SUBMISSION`: captured before ingress and carried in the invocation
 *   payload, so it is durable before the handler ever runs.
 * - `JOURNALED`: produced by a journaled durable step. `ctx.rand` and
 *   `ctx.date` qualify: both are deterministic per invocation. Note the SDK
 *   disallows calling `ctx.rand` from inside `ctx.run`, which is the same law
 *   from the other direction.
 */
export type CoordinateOrigin = "DERIVED" | "SUBMISSION" | "JOURNALED";

/**
 * Sources that may never produce a coordinate in replayable code.
 *
 * Named as a type so the prohibition is greppable and so a later reviewer can
 * ask "which of these does this line touch?" rather than reasoning from
 * scratch. The prohibition holds whether the code sits inside `ctx.run` or
 * outside it: outside is where the re-run window bites.
 */
export type ReplayForbiddenSource = "CLOCK" | "RANDOM" | "ENVIRONMENT" | "FILESYSTEM";

/** A value that carries where it came from, so provenance survives review. */
export interface Provenanced {
  readonly origin: CoordinateOrigin;
}

/**
 * Everything durable about one invocation, known before the handler runs.
 *
 * This is the complete permitted input to a `DERIVED` coordinate. If a value is
 * not reachable from here, it is not derivable, and it must be `SUBMISSION` or
 * `JOURNALED` instead.
 */
export interface DurableInvocation {
  readonly taskId: string;
  readonly attempt: number;
  /** Assigned at submission, before ingress. */
  readonly invocationId: string;
  /** Captured at submission. Never read from a clock inside the handler. */
  readonly submittedAt: string;
  /** Digest of the canonical submission payload. Pins what was asked for. */
  readonly submissionDigest: string;
}

/** One side effect within an attempt, addressable and therefore probeable. */
export interface OperationCoordinate extends Provenanced {
  readonly taskId: string;
  readonly attempt: number;
  readonly transitionId: string;
  /** Position within the attempt. Derived, never a counter in mutable state. */
  readonly operationIndex: number;
  /** Stable identity the effect's postcondition probe can be asked about. */
  readonly operationId: string;
}

/** The identity and timestamps of one ledger event, fixed before the append. */
export interface EventCoordinate extends Provenanced {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  /** Must equal taskId/attempt/transitionId, as the ledger contract requires. */
  readonly idempotencyKey: string;
}

/**
 * The derivation, as a type.
 *
 * Total and pure by signature: every input is durable, so two executions with
 * the same invocation cannot disagree. P2B supplies the implementation.
 */
export type DeriveEventCoordinate = (
  invocation: DurableInvocation,
  transitionId: string,
  operationIndex: number,
) => EventCoordinate;

/**
 * The Restate context narrowed to what the durability plane is allowed to use.
 *
 * A driver that only ever holds this type cannot reach the rest of the SDK
 * surface by accident. Widening it is a deliberate edit to this line.
 */
export type DurableStepContext = Pick<Context, "run" | "rand" | "date">;

// ---------------------------------------------------------------------------
// Recovery law
// ---------------------------------------------------------------------------

/**
 * The three-beat order every effect-bearing step follows.
 *
 * Ledger-first INTENT, then the idempotent and probeable EFFECT, then the
 * ledger-verified OUTCOME. The completion fact is never appended before the
 * effect has happened, because an append is a claim and a claim written early
 * is a lie the log cannot later retract.
 */
export type StepBeat = "INTENT" | "EFFECT" | "OUTCOME";

/**
 * What a postcondition probe is allowed to conclude.
 *
 * `UNKNOWN` is not a failure to be retried away. It is the fail-closed case:
 * an effect whose completion cannot be established is left as an unclosed
 * intent for an operator, never guessed in either direction.
 */
export type PostconditionVerdict = "DONE" | "NOT_DONE" | "UNKNOWN";

/**
 * A probe for one operation's postcondition.
 *
 * Every effect the plane performs must supply one. P2 exercises a deterministic
 * toy-repository action only; a later provider adapter must bring its own probe
 * rather than inheriting an assumption that its effects are observable.
 */
export type PostconditionProbe = (
  operation: OperationCoordinate,
) => Promise<PostconditionVerdict>;

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * What both drivers must satisfy.
 *
 * The SQLite supervisor and the Restate driver implement this same interface
 * over one shared state machine. Neither is a degraded path: switching modes
 * changes who advances the machine and nothing about where authority lives.
 *
 * Note what is absent. There is no method that reads state back from the
 * driver to make a decision, because that is precisely how a derived
 * orchestrator becomes an authority in practice while a document still claims
 * it is derived. A driver advances the ledger and reports on itself; it is
 * never asked what happened.
 */
export interface OrchestrationDriver {
  readonly mode: DriverMode;

  /** Report on the driver itself. Never a source of application facts. */
  status(): Promise<DriverStatus>;

  /**
   * Compare the driver's view against the ledger head.
   *
   * Ledger-headed and fail-closed by contract: the report names the head it was
   * computed against, and anything the ledger cannot corroborate blocks resume
   * rather than being merged.
   */
  reconcile(): Promise<ReconciliationReport>;

  /**
   * Advance one task by one transition.
   *
   * The returned event is what was appended, or null when the step was a
   * replay that appended nothing.
   */
  advance(
    invocation: DurableInvocation,
    from: TaskState,
  ): Promise<ControlPlaneEvent | null>;
}

// ---------------------------------------------------------------------------
// Restate driver
// ---------------------------------------------------------------------------

/**
 * The Virtual Object's entire durable state.
 *
 * A CACHE, never a fact. Both fields are copies of something the ledger already
 * knows, and deleting all of it loses nothing: the data-root-deletion drill
 * exists to prove exactly that. Nothing may be added here without an ADR,
 * because a field that is NOT derivable from the ledger would make Restate a
 * second authority, whatever the documents say.
 */
export interface RestateCacheState {
  readonly lastAppliedSequence: number;
  readonly lastAppliedEventSha256: string;
}

/** Everything the Restate driver needs to reach a ledger and a server. */
export interface RestateDriverOptions {
  readonly ledger: LedgerLike;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /** Loopback ingress base, e.g. `http://127.0.0.1:8080`. */
  readonly ingressUrl: string;
  /** Loopback admin base, e.g. `http://127.0.0.1:9070`. */
  readonly adminUrl: string;
  /** Reads the object's cache through a shared handler, never admin state. */
  readonly readCache?: (() => Promise<RestateCacheState | null>) | undefined;
}

/**
 * The ledger surface the driver reads.
 *
 * Structurally satisfied by `Ledger`; declared here so this file stays free of
 * a value import and the driver cannot reach a mutator it was never given.
 */
export interface LedgerLike {
  status(): {
    readonly headSequence: number;
    readonly headEventSha256: string;
    readonly eventCount: number;
  };
  verifyIntegrity(): { readonly ok: boolean; readonly problems: readonly unknown[] };
  getEventBySequence(sequence: number): { readonly eventSha256: string } | null;
}
