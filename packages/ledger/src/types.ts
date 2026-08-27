import type {
  ControlPlaneEvent,
  ControlPlaneEventType,
  TaskState,
  WorkerRole,
} from "@acp/contracts";

/**
 * Public value types of the ledger package.
 *
 * Everything here is plain data. No handle, no statement and no raw database
 * object crosses this boundary, because a caller holding a raw connection could
 * mutate the append-only table and the ledger would have no way to notice.
 */

/**
 * Deliberate fault seam, for tests only.
 *
 * Rollback is a claim that cannot be verified by reading the code: the only
 * honest proof is to make a step fail on purpose and then show that the event
 * did not survive. These hooks exist so a test can do exactly that, and they
 * are the reason the rollback tests are evidence rather than prose.
 *
 * The field is prefixed and documented as test-only. Production callers must
 * never set it, and nothing in this package sets it by default.
 */
export interface LedgerTestFaults {
  /** Runs inside the append transaction, after INSERT, before projection. */
  readonly beforeProjection?: (() => void) | undefined;
  /** Runs inside the append transaction, after projection, before commit. */
  readonly beforeAppendCommit?: (() => void) | undefined;
  /** Runs inside the rebuild transaction, after replay, before commit. */
  readonly beforeRebuildCommit?: (() => void) | undefined;
}

export interface OpenLedgerOptions {
  /**
   * Open query-only. A read-only handle never migrates and never mutates; it
   * fails closed if the applied migration set is not exactly this build.
   */
  readonly readOnly?: boolean | undefined;
  /** Lock acquisition budget. Bounded so a stuck writer cannot hang a reader. */
  readonly busyTimeoutMs?: number | undefined;
  /** Test-only fault seam. See LedgerTestFaults. */
  readonly __testFaults?: LedgerTestFaults | undefined;
}

/** One durable ledger row, with the event and its chain position. */
export interface LedgerEventRecord {
  /** Monotonic integer position. The only ordering the ledger guarantees. */
  readonly sequence: number;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly event: ControlPlaneEvent;
  /** The exact bytes the chain digest was computed over. */
  readonly canonicalJson: string;
  readonly previousSha256: string;
  readonly eventSha256: string;
}

export interface AppendResult {
  /** false means this was an exact replay and nothing new was written. */
  readonly inserted: boolean;
  readonly record: LedgerEventRecord;
}

export interface EventQuery {
  /** Exclusive sequence cursor. Pass the previous page nextCursor. */
  readonly afterSequence?: number | undefined;
  readonly taskId?: string | undefined;
  readonly type?: ControlPlaneEventType | undefined;
  readonly emittedBy?: string | undefined;
  readonly toState?: TaskState | undefined;
  readonly limit?: number | undefined;
}

export interface EventPage {
  readonly events: readonly LedgerEventRecord[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
}

/** Derived per-task projection. Holds no fact that is not in the ledger. */
export interface TaskReadModel {
  readonly taskId: string;
  readonly currentState: TaskState;
  readonly latestAttempt: number;
  readonly eventCount: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly lastEventId: string;
  readonly lastEventType: ControlPlaneEventType;
  readonly lastTransitionId: string;
  readonly lastEmittedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly isTerminal: boolean;
}

export interface TaskQuery {
  readonly state?: TaskState | undefined;
  /** Exclusive taskId cursor. Tasks are ordered by taskId ascending. */
  readonly afterTaskId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface TaskPage {
  readonly tasks: readonly TaskReadModel[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Derived per-worker projection, built from observed emittedBy identities.
 *
 * This is an observation, not a registry. A worker exists here because it
 * emitted an event, so the projection can never claim a worker the ledger has
 * no evidence for. WorkerSlot registration is a later phase.
 */
export interface WorkerReadModel {
  readonly identity: string;
  readonly provider: string;
  readonly model: string;
  readonly role: WorkerRole;
  readonly instance: string;
  readonly eventCount: number;
  /** Distinct tasks this identity has emitted at least one event for. */
  readonly taskCount: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastTaskId: string;
  readonly lastEventType: ControlPlaneEventType;
}

export interface WorkerQuery {
  readonly role?: WorkerRole | undefined;
  readonly provider?: string | undefined;
  /** Exclusive identity cursor. Workers are ordered by identity ascending. */
  readonly afterIdentity?: string | undefined;
  readonly limit?: number | undefined;
}

export interface WorkerPage {
  readonly workers: readonly WorkerReadModel[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
  readonly appliedAt: string;
}

/** Effective pragmas, read back from the connection rather than assumed. */
export interface LedgerPragmaStatus {
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly synchronous: number;
  readonly busyTimeoutMs: number;
  readonly queryOnly: boolean;
}

export interface ProjectionStatus {
  readonly name: string;
  readonly appliedThroughSequence: number;
  readonly eventCount: number;
  /** Chain head the projection was built from. Detects a foreign history. */
  readonly sourceHeadSha256: string;
  readonly updatedAt: string;
  readonly rowCount: number;
}

export interface LedgerStatus {
  readonly path: string;
  readonly readOnly: boolean;
  readonly pragmas: LedgerPragmaStatus;
  readonly migrations: readonly AppliedMigration[];
  readonly headSequence: number;
  readonly headEventSha256: string;
  readonly eventCount: number;
  readonly projections: readonly ProjectionStatus[];
}

export type IntegrityProblemKind =
  | "SQLITE_INTEGRITY"
  | "FOREIGN_KEY"
  | "MIGRATION"
  | "SCHEMA_SHAPE"
  | "EVENT_JSON"
  | "EVENT_CONTRACT"
  | "EVENT_COORDINATES"
  | "HASH_CHAIN"
  | "SEQUENCE"
  | "LEDGER_META"
  | "PROJECTION_META"
  | "PROJECTION";

export interface IntegrityProblem {
  readonly kind: IntegrityProblemKind;
  /** Safe to log. Never contains event content, only coordinates and digests. */
  readonly detail: string;
  readonly sequence: number | null;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly checkedEvents: number;
  readonly headSequence: number;
  readonly headEventSha256: string;
  readonly problems: readonly IntegrityProblem[];
}

export interface RebuildResult {
  readonly replayedEvents: number;
  readonly throughSequence: number;
  readonly taskRows: number;
  readonly workerRows: number;
}
