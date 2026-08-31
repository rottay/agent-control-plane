import {
  ControlPlaneEventType,
  EXCEPTIONAL_STATES,
  INITIATIVE_STATUSES,
  LIFECYCLE_STATES,
  ROADMAP_VERSION_KINDS,
  TaskState,
  WORKER_IDENTITY_PATTERN,
  WORKER_ROLES,
  WorkerIdentityString,
  WorkerRole,
  findCredentialViolations,
  findTranscriptViolations,
} from "@acp/contracts";
import { z } from "zod";

import { API_CONTRACT_VERSION, LEDGER_CONTRACT_VERSION } from "../version/index.js";

/**
 * Data transfer objects of the read-only observation plane.
 *
 * Laws encoded here:
 *
 * 1. Browser safe. This module imports nothing from `node:`, touches no
 *    filesystem, opens no database and knows nothing about SQLite. It is the
 *    only contract package the local UI is allowed to depend on.
 * 2. Strict. Every object rejects unknown keys. A projection that grew a field
 *    server side fails at the boundary instead of leaking it to a browser.
 * 3. Versioned twice. Every top level response carries the API contract
 *    version and the ledger contract version, so a reader can tell which of
 *    the two moved.
 * 4. No absolute paths. The database is identified by an opaque digest and a
 *    bare file label. The absolute path of the ledger never crosses this
 *    boundary in any field.
 * 5. No credentials and no transcripts. Event payload values do not cross at
 *    all; only the key names and the serialized size do, and even those are
 *    scanned with the same guards the ledger contract uses.
 * 6. Read only. There is no write shaped DTO in this file, because P1 has no
 *    write surface to describe.
 */

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** Hard ceiling on a single page. A reader paginates; it does not slurp. */
export const MAX_PAGE_LIMIT = 200;

/** Page size used when a caller does not ask for one. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Total number of task states the lifecycle admits, happy path plus lateral. */
export const TASK_STATE_COUNT = LIFECYCLE_STATES.length + EXCEPTIONAL_STATES.length;

/** Ceiling on how many recent timeline items a detail response may inline. */
export const MAX_DETAIL_TIMELINE_ITEMS = 100;

// ---------------------------------------------------------------------------
// Primitive value shapes
// ---------------------------------------------------------------------------

const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase sha-256 hex digest");

const Uuid = z.uuid();

const Timestamp = z.iso.datetime({ offset: true });

/** A ledger sequence. Positions start at one. */
const Sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A ledger sequence or zero, which is the head of an empty ledger. */
const SequenceOrZero = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const Attempt = z.number().int().positive().max(10_000);

const TransitionId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const IdentitySegment = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const ApiContractVersion = z.literal(API_CONTRACT_VERSION);
const LedgerContractVersion = z.literal(LEDGER_CONTRACT_VERSION);

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type RefinementContext = z.core.$RefinementCtx;

function issuePath(path: string): (string | number)[] {
  return path === "<root>" ? [] : path.split(".");
}

/**
 * Reuse the ledger contract guards on the way out, not only on the way in.
 *
 * The ledger already refuses to store credential bearing keys and transcript
 * continuity. Running the same scanners on the response shape is not
 * redundancy for its own sake: the projection layer between the two is new
 * code, and a boundary that only trusts the layer below it is not a boundary.
 */
function attachGuards(value: unknown, ctx: RefinementContext): void {
  for (const violation of findCredentialViolations(value)) {
    ctx.addIssue({
      code: "custom",
      message: "credential material is forbidden: " + violation.reason,
      path: issuePath(violation.path),
    });
  }
  for (const violation of findTranscriptViolations(value)) {
    ctx.addIssue({
      code: "custom",
      message: "provider transcript continuity is forbidden: " + violation.reason,
      path: issuePath(violation.path),
    });
  }
}

// ---------------------------------------------------------------------------
// Database identity
// ---------------------------------------------------------------------------

/**
 * A file label. Not a path.
 *
 * Separators, traversal segments and home directory shorthand are all rejected,
 * so the field cannot be quietly widened into a path by a later change.
 */
const DatabaseLabel = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => !value.includes("/"), "label must not contain a path separator")
  .refine((value) => !value.includes("\\"), "label must not contain a path separator")
  .refine(
    (value) => !value.includes(".."),
    "label must not contain a parent traversal segment",
  )
  .refine((value) => !value.startsWith("~"), "label must not name a home directory")
  .refine((value) => !value.startsWith("."), "label must not be a dotfile path fragment");

/**
 * How the browser is allowed to know which ledger it is looking at.
 *
 * The absolute path of the ledger file is an operator secret in the practical
 * sense: it names a home directory, a user account and a machine layout. It is
 * replaced at the server boundary by a stable digest of the path plus the bare
 * file name, which is enough to distinguish two ledgers and useless for reaching
 * either of them.
 */
export const LedgerDatabaseIdentity = z.strictObject({
  /** Digest of the absolute path, computed server side. Never the path. */
  id: Sha256Hex,
  /** Bare file name. Never a directory and never an absolute path. */
  label: DatabaseLabel,
  /** Structural marker. Its presence is what makes the redaction auditable. */
  pathRedacted: z.literal(true),
});
export type LedgerDatabaseIdentity = z.infer<typeof LedgerDatabaseIdentity>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  "BAD_REQUEST",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "CONTRACT_VERSION_MISMATCH",
  "LEDGER_UNAVAILABLE",
  "LEDGER_INTEGRITY",
  "INTERNAL",
] as const;

export const ApiErrorCode = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/**
 * The single error envelope.
 *
 * One shape for every failure, carrying a closed code rather than an HTTP
 * status alone, so a reader can branch on the cause without parsing prose. The
 * detail field is bounded and guarded: an error message is the classic way for
 * a path or a credential to escape a boundary that is otherwise careful.
 */
export const ApiError = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    error: z.strictObject({
      code: ApiErrorCode,
      message: z.string().min(1).max(500),
      detail: z.string().max(2_000).nullable(),
    }),
  })
  .superRefine(attachGuards);
export type ApiError = z.infer<typeof ApiError>;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const HEALTH_STATES = ["OK", "DEGRADED", "UNAVAILABLE"] as const;
export const ApiHealthState = z.enum(HEALTH_STATES);
export type ApiHealthState = z.infer<typeof ApiHealthState>;

export const HealthResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    status: ApiHealthState,
    /** Structural law. Nothing in P1 answers anything but a read. */
    readOnly: z.literal(true),
    observedAt: Timestamp,
    database: LedgerDatabaseIdentity.nullable(),
    detail: z.string().max(500).nullable(),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);

    if (value.status === "UNAVAILABLE" && value.database !== null) {
      ctx.addIssue({
        code: "custom",
        message: "an unavailable plane must not claim an open database",
        path: ["database"],
      });
    }
    if (value.status !== "UNAVAILABLE" && value.database === null) {
      ctx.addIssue({
        code: "custom",
        message: "a reachable plane must name the database it is reading",
        path: ["database"],
      });
    }
    if (value.status !== "OK" && value.detail === null) {
      ctx.addIssue({
        code: "custom",
        message: "a plane that is not OK must say why",
        path: ["detail"],
      });
    }
  });
export type HealthResponse = z.infer<typeof HealthResponse>;

// ---------------------------------------------------------------------------
// Timeline items
// ---------------------------------------------------------------------------

const PayloadKey = z.string().min(1).max(80);

/**
 * One event, as an observer is allowed to see it.
 *
 * The event payload does not cross this boundary. Only the key names and the
 * serialized byte size do. That is a deliberate loss of fidelity: payloads are
 * the one part of an event whose contents are not fixed by the contract, so
 * they are the one part that could carry something a browser must never hold.
 * A later phase that genuinely needs payload values will have to argue for a
 * per-type projection, which is a different and much narrower decision.
 */
export const TimelineItem = z
  .strictObject({
    sequence: Sequence,
    eventId: Uuid,
    taskId: Uuid,
    attempt: Attempt,
    transitionId: TransitionId,
    type: ControlPlaneEventType,
    fromState: TaskState.nullable(),
    toState: TaskState,
    emittedBy: WorkerIdentityString,
    occurredAt: Timestamp,
    recordedAt: Timestamp,
    /** Chain position, so the UI can show tamper evidence rather than assert it. */
    previousSha256: Sha256Hex,
    eventSha256: Sha256Hex,
    payloadByteSize: Count,
    payloadKeys: z.array(PayloadKey).max(64),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);

    // Payload key names are array values here, so the tree scanners above do
    // not see them as keys. Reconstruct an object so they are scanned as what
    // they actually are.
    const asKeys: Record<string, null> = {};
    for (const key of value.payloadKeys) {
      asKeys[key] = null;
    }
    for (const violation of findCredentialViolations(asKeys)) {
      ctx.addIssue({
        code: "custom",
        message: "credential material is forbidden: " + violation.reason,
        path: ["payloadKeys"],
      });
    }
    for (const violation of findTranscriptViolations(asKeys)) {
      ctx.addIssue({
        code: "custom",
        message: "provider transcript continuity is forbidden: " + violation.reason,
        path: ["payloadKeys"],
      });
    }

    const duplicates = value.payloadKeys.filter(
      (key, index) => value.payloadKeys.indexOf(key) !== index,
    );
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "payload key names must be unique",
        path: ["payloadKeys"],
      });
    }
  });
export type TimelineItem = z.infer<typeof TimelineItem>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Shared shape of the task projections.
 *
 * Written as a plain object literal rather than derived with `.extend()` so
 * that both schemas below are visibly strict at their own definition site.
 */
const taskSummaryShape = {
  taskId: Uuid,
  currentState: TaskState,
  isTerminal: z.boolean(),
  latestAttempt: Attempt,
  eventCount: Count,
  firstSequence: Sequence,
  lastSequence: Sequence,
  lastEventType: ControlPlaneEventType,
  lastEmittedBy: WorkerIdentityString,
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

function refineTaskShape(
  value: { readonly firstSequence: number; readonly lastSequence: number },
  ctx: RefinementContext,
): void {
  if (value.lastSequence < value.firstSequence) {
    ctx.addIssue({
      code: "custom",
      message: "the last sequence of a task cannot precede its first",
      path: ["lastSequence"],
    });
  }
}

export const TaskSummary = z
  .strictObject(taskSummaryShape)
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);
    refineTaskShape(value, ctx);
  });
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskDetail = z
  .strictObject({
    ...taskSummaryShape,
    lastEventId: Uuid,
    lastTransitionId: TransitionId,
    /** Most recent first. Bounded, and never the whole history. */
    recentEvents: z.array(TimelineItem).max(MAX_DETAIL_TIMELINE_ITEMS),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);
    refineTaskShape(value, ctx);

    for (const [index, item] of value.recentEvents.entries()) {
      if (item.taskId !== value.taskId) {
        ctx.addIssue({
          code: "custom",
          message: "a task detail may only carry events belonging to that task",
          path: ["recentEvents", index, "taskId"],
        });
      }
    }
  });
export type TaskDetail = z.infer<typeof TaskDetail>;

export const TaskDetailResponse = z.strictObject({
  apiContractVersion: ApiContractVersion,
  ledgerContractVersion: LedgerContractVersion,
  task: TaskDetail,
});
export type TaskDetailResponse = z.infer<typeof TaskDetailResponse>;

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

/**
 * Shared shape of the worker projections.
 *
 * A worker exists in this API because it emitted an event. It is an
 * observation, not a registry: nothing here implies a slot, an account, a
 * lease or a routing decision, none of which exist in P1.
 */
const workerSummaryShape = {
  identity: WorkerIdentityString,
  provider: IdentitySegment,
  model: IdentitySegment,
  role: WorkerRole,
  instance: z.string().regex(/^[0-9]{2,4}$/),
  eventCount: Count,
  taskCount: Count,
  firstSequence: Sequence,
  lastSequence: Sequence,
  firstSeenAt: Timestamp,
  lastSeenAt: Timestamp,
  lastEventType: ControlPlaneEventType,
};

function refineWorkerShape(
  value: {
    readonly identity: string;
    readonly provider: string;
    readonly model: string;
    readonly role: string;
    readonly instance: string;
    readonly firstSequence: number;
    readonly lastSequence: number;
  },
  ctx: RefinementContext,
): void {
  const parsed = WORKER_IDENTITY_PATTERN.exec(value.identity);
  if (parsed === null) {
    return;
  }
  const fields = [
    ["provider", parsed[1], value.provider],
    ["model", parsed[2], value.model],
    ["role", parsed[3], value.role],
    ["instance", parsed[4], value.instance],
  ] as const;
  for (const [name, segment, field] of fields) {
    if (segment !== field) {
      ctx.addIssue({
        code: "custom",
        message: "identity " + name + " segment must equal the " + name + " field",
        path: [name],
      });
    }
  }
  if (value.lastSequence < value.firstSequence) {
    ctx.addIssue({
      code: "custom",
      message: "the last sequence of a worker cannot precede its first",
      path: ["lastSequence"],
    });
  }
}

export const WorkerSummary = z
  .strictObject(workerSummaryShape)
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);
    refineWorkerShape(value, ctx);
  });
export type WorkerSummary = z.infer<typeof WorkerSummary>;

export const WorkerDetail = z
  .strictObject({
    ...workerSummaryShape,
    lastTaskId: Uuid,
    recentEvents: z.array(TimelineItem).max(MAX_DETAIL_TIMELINE_ITEMS),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);
    refineWorkerShape(value, ctx);

    for (const [index, item] of value.recentEvents.entries()) {
      if (item.emittedBy !== value.identity) {
        ctx.addIssue({
          code: "custom",
          message: "a worker detail may only carry events that worker emitted",
          path: ["recentEvents", index, "emittedBy"],
        });
      }
    }
  });
export type WorkerDetail = z.infer<typeof WorkerDetail>;

export const WorkerDetailResponse = z.strictObject({
  apiContractVersion: ApiContractVersion,
  ledgerContractVersion: LedgerContractVersion,
  worker: WorkerDetail,
});
export type WorkerDetailResponse = z.infer<typeof WorkerDetailResponse>;

// ---------------------------------------------------------------------------
// Cursor pages
// ---------------------------------------------------------------------------

/**
 * Page metadata, shared by every collection.
 *
 * The cursor is a string even where the underlying ledger cursor is an integer.
 * A reader must treat it as opaque and hand it back unmodified: the moment a UI
 * starts doing arithmetic on a cursor, changing the pagination strategy becomes
 * a breaking change to every reader.
 */
export const CursorPageMeta = z
  .strictObject({
    nextCursor: z.string().min(1).max(300).nullable(),
    hasMore: z.boolean(),
    limit: z.number().int().min(1).max(MAX_PAGE_LIMIT),
    returned: z.number().int().nonnegative().max(MAX_PAGE_LIMIT),
  })
  .superRefine((value, ctx) => {
    if (value.returned > value.limit) {
      ctx.addIssue({
        code: "custom",
        message: "a page cannot return more items than the limit it was given",
        path: ["returned"],
      });
    }
    if (value.hasMore && value.nextCursor === null) {
      ctx.addIssue({
        code: "custom",
        message: "a page that has more must carry the cursor to reach it",
        path: ["nextCursor"],
      });
    }
    if (!value.hasMore && value.nextCursor !== null) {
      ctx.addIssue({
        code: "custom",
        message: "a page that has no more must not offer a cursor",
        path: ["nextCursor"],
      });
    }
  });
export type CursorPageMeta = z.infer<typeof CursorPageMeta>;

/** Build the response schema for a cursor paginated collection of `item`. */
export function cursorPage<TItem extends z.ZodType>(item: TItem) {
  return z
    .strictObject({
      apiContractVersion: ApiContractVersion,
      ledgerContractVersion: LedgerContractVersion,
      items: z.array(item).max(MAX_PAGE_LIMIT),
      page: CursorPageMeta,
    })
    .superRefine((value, ctx) => {
      // The count and the collection are two statements of the same fact, and a
      // reader that trusts the count over the array silently drops rows.
      if (value.page.returned !== value.items.length) {
        ctx.addIssue({
          code: "custom",
          message: "page.returned must equal the number of items in the page",
          path: ["page", "returned"],
        });
      }
    });
}

export const TaskPageResponse = cursorPage(TaskSummary);
export type TaskPageResponse = z.infer<typeof TaskPageResponse>;

export const WorkerPageResponse = cursorPage(WorkerSummary);
export type WorkerPageResponse = z.infer<typeof WorkerPageResponse>;

export const EventPageResponse = cursorPage(TimelineItem);
export type EventPageResponse = z.infer<typeof EventPageResponse>;

// ---------------------------------------------------------------------------
// Ledger status
// ---------------------------------------------------------------------------

export const LedgerPragmaStatusDto = z.strictObject({
  journalMode: z.string().min(1).max(40),
  foreignKeys: z.boolean(),
  synchronous: z.number().int().min(0).max(3),
  busyTimeoutMs: z.number().int().nonnegative().max(600_000),
  queryOnly: z.boolean(),
});
export type LedgerPragmaStatusDto = z.infer<typeof LedgerPragmaStatusDto>;

export const AppliedMigrationDto = z.strictObject({
  version: z.number().int().positive().max(10_000),
  name: z.string().min(1).max(120),
  sha256: Sha256Hex,
  appliedAt: Timestamp,
});
export type AppliedMigrationDto = z.infer<typeof AppliedMigrationDto>;

export const ProjectionStatusDto = z.strictObject({
  name: z.string().min(1).max(80),
  appliedThroughSequence: SequenceOrZero,
  eventCount: Count,
  sourceHeadSha256: Sha256Hex,
  updatedAt: Timestamp,
  rowCount: Count,
});
export type ProjectionStatusDto = z.infer<typeof ProjectionStatusDto>;

/**
 * The ledger status, redacted.
 *
 * This is the projection of the ledger's own status object, minus its absolute
 * `path` field. Because the schema is strict, forwarding the raw status by
 * accident is a parse failure rather than a leak, which is exactly the property
 * that makes the redaction worth encoding here instead of in a mapper.
 */
export const LedgerStatusResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    database: LedgerDatabaseIdentity,
    readOnly: z.boolean(),
    headSequence: SequenceOrZero,
    headEventSha256: Sha256Hex,
    eventCount: Count,
    pragmas: LedgerPragmaStatusDto,
    migrations: z.array(AppliedMigrationDto).max(200),
    projections: z.array(ProjectionStatusDto).max(50),
    observedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);

    if (value.eventCount === 0 && value.headSequence !== 0) {
      ctx.addIssue({
        code: "custom",
        message: "an empty ledger cannot have a nonzero head sequence",
        path: ["headSequence"],
      });
    }

    const versions = value.migrations.map((migration) => migration.version);
    const duplicated = versions.filter(
      (version, index) => versions.indexOf(version) !== index,
    );
    if (duplicated.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "migration versions must be unique",
        path: ["migrations"],
      });
    }
  });
export type LedgerStatusResponse = z.infer<typeof LedgerStatusResponse>;

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

/**
 * Problem kinds, mirrored from the ledger.
 *
 * This package may not depend on the ledger, so the list is restated rather
 * than imported. The server lane is the one place where both are in scope, and
 * it is where a divergence must be asserted: a kind the ledger emits and this
 * enum does not know fails to parse at the boundary, loudly, instead of
 * arriving in a browser as an unlabelled problem.
 */
export const INTEGRITY_PROBLEM_KINDS = [
  "SQLITE_INTEGRITY",
  "FOREIGN_KEY",
  "MIGRATION",
  "SCHEMA_SHAPE",
  "EVENT_JSON",
  "EVENT_CONTRACT",
  "EVENT_COORDINATES",
  "HASH_CHAIN",
  "SEQUENCE",
  "LEDGER_META",
  "PROJECTION_META",
  "PROJECTION",
] as const;

export const IntegrityProblemKind = z.enum(INTEGRITY_PROBLEM_KINDS);
export type IntegrityProblemKind = z.infer<typeof IntegrityProblemKind>;

export const IntegrityProblemDto = z.strictObject({
  kind: IntegrityProblemKind,
  /** Coordinates and digests only. Never event content. */
  detail: z.string().min(1).max(500),
  sequence: SequenceOrZero.nullable(),
});
export type IntegrityProblemDto = z.infer<typeof IntegrityProblemDto>;

export const IntegrityResult = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    ok: z.boolean(),
    checkedEvents: Count,
    headSequence: SequenceOrZero,
    headEventSha256: Sha256Hex,
    problems: z.array(IntegrityProblemDto).max(500),
    /** True when the problem list was cut to the ceiling above. */
    truncated: z.boolean(),
    checkedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);

    if (value.ok && value.problems.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "an ok integrity result must carry no problems",
        path: ["ok"],
      });
    }
    if (!value.ok && value.problems.length === 0 && !value.truncated) {
      ctx.addIssue({
        code: "custom",
        message: "a failing integrity result must name at least one problem",
        path: ["problems"],
      });
    }
    if (value.truncated && value.problems.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a truncated problem list must still carry the problems it kept",
        path: ["truncated"],
      });
    }
  });
export type IntegrityResult = z.infer<typeof IntegrityResult>;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/**
 * The four honest answers the overview can give.
 *
 * `EMPTY` and `UNAVAILABLE` are separate on purpose. A control plane with no
 * events and a control plane that cannot read its ledger look identical on a
 * dashboard that only counts rows, and they mean opposite things.
 */
export const OVERVIEW_STATES = ["UNAVAILABLE", "EMPTY", "ACTIVE", "DEGRADED"] as const;
export const OverviewState = z.enum(OVERVIEW_STATES);
export type OverviewState = z.infer<typeof OverviewState>;

export const OverviewLedger = z.strictObject({
  eventCount: Count,
  headSequence: SequenceOrZero,
  headEventSha256: Sha256Hex,
  lastEventAt: Timestamp.nullable(),
});
export type OverviewLedger = z.infer<typeof OverviewLedger>;

export const OverviewIntegrity = z
  .strictObject({
    checked: z.boolean(),
    ok: z.boolean().nullable(),
    problemCount: Count.nullable(),
    checkedAt: Timestamp.nullable(),
  })
  .superRefine((value, ctx) => {
    const published =
      value.ok !== null || value.problemCount !== null || value.checkedAt !== null;
    if (!value.checked && published) {
      ctx.addIssue({
        code: "custom",
        message: "an unchecked integrity block must not publish a verdict",
        path: ["ok"],
      });
    }
    if (
      value.checked &&
      (value.ok === null || value.problemCount === null || value.checkedAt === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a checked integrity block must publish a verdict, a count and a time",
        path: ["ok"],
      });
    }
    if (value.ok === true && value.problemCount !== null && value.problemCount > 0) {
      ctx.addIssue({
        code: "custom",
        message: "an ok verdict cannot come with problems",
        path: ["problemCount"],
      });
    }
  });
export type OverviewIntegrity = z.infer<typeof OverviewIntegrity>;

/**
 * What this plane can and cannot do, stated as data.
 *
 * P1 observes. It does not route work, hold leases, know accounts or write
 * anything. A UI that reads these flags cannot accidentally grow a control
 * affordance for a subsystem that does not exist, and a later phase that adds
 * one has to change this contract to say so.
 */
export const ObservationCapabilities = z.strictObject({
  readOnly: z.literal(true),
  writes: z.literal(false),
  routing: z.literal(false),
  accounts: z.literal(false),
  leases: z.literal(false),
});
export type ObservationCapabilities = z.infer<typeof ObservationCapabilities>;

export const TaskStateCount = z.strictObject({ state: TaskState, count: Count });
export type TaskStateCount = z.infer<typeof TaskStateCount>;

export const WorkerRoleCount = z.strictObject({ role: WorkerRole, count: Count });
export type WorkerRoleCount = z.infer<typeof WorkerRoleCount>;

export const OverviewResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    state: OverviewState,
    observedAt: Timestamp,
    database: LedgerDatabaseIdentity.nullable(),
    ledger: OverviewLedger.nullable(),
    integrity: OverviewIntegrity,
    tasks: z.strictObject({
      total: Count,
      terminal: Count,
      active: Count,
      byState: z.array(TaskStateCount).max(TASK_STATE_COUNT),
    }),
    workers: z.strictObject({
      total: Count,
      byRole: z.array(WorkerRoleCount).max(WORKER_ROLES.length),
    }),
    capabilities: ObservationCapabilities,
    notice: z.string().max(500).nullable(),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);

    const states = value.tasks.byState.map((entry) => entry.state);
    if (states.some((state, index) => states.indexOf(state) !== index)) {
      ctx.addIssue({
        code: "custom",
        message: "each task state may appear at most once in the breakdown",
        path: ["tasks", "byState"],
      });
    }
    const roles = value.workers.byRole.map((entry) => entry.role);
    if (roles.some((role, index) => roles.indexOf(role) !== index)) {
      ctx.addIssue({
        code: "custom",
        message: "each worker role may appear at most once in the breakdown",
        path: ["workers", "byRole"],
      });
    }

    if (value.tasks.terminal + value.tasks.active !== value.tasks.total) {
      ctx.addIssue({
        code: "custom",
        message: "terminal plus active tasks must equal the total",
        path: ["tasks", "total"],
      });
    }
    const stateTotal = value.tasks.byState.reduce((sum, entry) => sum + entry.count, 0);
    if (stateTotal !== value.tasks.total) {
      ctx.addIssue({
        code: "custom",
        message: "the task state breakdown must sum to the total",
        path: ["tasks", "byState"],
      });
    }
    const roleTotal = value.workers.byRole.reduce((sum, entry) => sum + entry.count, 0);
    if (roleTotal !== value.workers.total) {
      ctx.addIssue({
        code: "custom",
        message: "the worker role breakdown must sum to the total",
        path: ["workers", "byRole"],
      });
    }

    if (value.ledger !== null && value.database === null) {
      ctx.addIssue({
        code: "custom",
        message: "a readable ledger must be identified",
        path: ["database"],
      });
    }

    if (value.state === "UNAVAILABLE") {
      if (value.ledger !== null || value.database !== null) {
        ctx.addIssue({
          code: "custom",
          message: "an unavailable overview must not claim ledger facts",
          path: ["ledger"],
        });
      }
      if (value.tasks.total !== 0 || value.workers.total !== 0) {
        ctx.addIssue({
          code: "custom",
          message: "an unavailable overview must not report counts it could not read",
          path: ["tasks", "total"],
        });
      }
      if (value.integrity.checked) {
        ctx.addIssue({
          code: "custom",
          message: "an unavailable overview cannot have checked integrity",
          path: ["integrity", "checked"],
        });
      }
      if (value.notice === null) {
        ctx.addIssue({
          code: "custom",
          message: "an unavailable overview must say why it is unavailable",
          path: ["notice"],
        });
      }
    }

    if (value.state === "EMPTY") {
      if (value.ledger === null) {
        ctx.addIssue({
          code: "custom",
          message: "an empty overview still had to read a ledger to know it is empty",
          path: ["ledger"],
        });
      } else if (value.ledger.eventCount !== 0) {
        ctx.addIssue({
          code: "custom",
          message: "an empty overview cannot report events",
          path: ["ledger", "eventCount"],
        });
      }
      if (value.tasks.total !== 0 || value.workers.total !== 0) {
        ctx.addIssue({
          code: "custom",
          message: "an empty overview cannot report tasks or workers",
          path: ["tasks", "total"],
        });
      }
    }

    if (value.state === "ACTIVE") {
      if (value.ledger === null || value.ledger.eventCount === 0) {
        ctx.addIssue({
          code: "custom",
          message: "an active overview must be backed by at least one event",
          path: ["ledger"],
        });
      }
      if (value.integrity.ok === false) {
        ctx.addIssue({
          code: "custom",
          message: "a failing integrity verdict makes the overview degraded, not active",
          path: ["state"],
        });
      }
    }

    if (value.state === "DEGRADED") {
      if (!value.integrity.checked || value.integrity.ok !== false) {
        ctx.addIssue({
          code: "custom",
          message: "a degraded overview must carry a checked and failing integrity verdict",
          path: ["integrity"],
        });
      }
      if (value.notice === null) {
        ctx.addIssue({
          code: "custom",
          message: "a degraded overview must say what is wrong",
          path: ["notice"],
        });
      }
    }
  });
export type OverviewResponse = z.infer<typeof OverviewResponse>;

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

/**
 * Query values arrive as strings, so numeric parameters need a conversion.
 *
 * The conversion is a decimal grammar rather than `Number()`, because
 * `Number()` is far more generous than a query parameter should be: it accepts
 * `0x10`, `1e3`, leading and trailing whitespace and `Infinity`, all of which
 * would silently become a cursor or a page size the caller never wrote. A value
 * outside the grammar is a client error.
 *
 * Out of range values are rejected rather than clamped, for the same reason:
 * silent clamping is how a reader ends up believing it asked for a thousand
 * rows and got fifty.
 */
const DecimalNonNegativeInteger = z
  .union([
    z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/, "expected a decimal integer with no sign or exponent"),
    z.number().int().nonnegative(),
  ])
  .transform((value) => (typeof value === "string" ? Number.parseInt(value, 10) : value));

const PageLimit = DecimalNonNegativeInteger.pipe(
  z.number().int().min(1).max(MAX_PAGE_LIMIT),
).default(DEFAULT_PAGE_LIMIT);

export const TasksQuery = z.strictObject({
  state: TaskState.optional(),
  /** Exclusive task id cursor. Tasks are ordered by task id ascending. */
  cursor: Uuid.optional(),
  limit: PageLimit,
});
export type TasksQuery = z.infer<typeof TasksQuery>;

export const WorkersQuery = z.strictObject({
  role: WorkerRole.optional(),
  provider: IdentitySegment.optional(),
  /** Exclusive identity cursor. Workers are ordered by identity ascending. */
  cursor: WorkerIdentityString.optional(),
  limit: PageLimit,
});
export type WorkersQuery = z.infer<typeof WorkersQuery>;

export const EventsQuery = z.strictObject({
  taskId: Uuid.optional(),
  type: ControlPlaneEventType.optional(),
  emittedBy: WorkerIdentityString.optional(),
  toState: TaskState.optional(),
  /** Exclusive sequence cursor. */
  cursor: DecimalNonNegativeInteger.pipe(
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  )
    .optional(),
  limit: PageLimit,
});
export type EventsQuery = z.infer<typeof EventsQuery>;

// ---------------------------------------------------------------------------
// Initiatives (P8-8A)
// ---------------------------------------------------------------------------

/**
 * The initiative data plane's shared vocabularies.
 *
 * Re-derived from the contract's own frozen lists rather than restated: an
 * initiative status the ledger can hold and this API cannot express would be a
 * projection that quietly drops rows.
 */
export const InitiativeStatusDto = z.enum(INITIATIVE_STATUSES);
export type InitiativeStatusDto = z.infer<typeof InitiativeStatusDto>;

export const RoadmapVersionKindDto = z.enum(ROADMAP_VERSION_KINDS);
export type RoadmapVersionKindDto = z.infer<typeof RoadmapVersionKindDto>;

/**
 * What a rollup says about one initiative or one task.
 *
 * Both numbers come from the observation plane's fold, and both are bounded by
 * the same ceiling the fold itself uses. `tokensReserved` is a **current hold**
 * rather than a history — the fold's own law — and the name is kept identical
 * to the fold's so the two cannot drift apart under different words.
 */
export const RollupSummary = z.strictObject({
  tokensUsed: z.number().int().nonnegative().max(10_000_000),
  tokensReserved: z.number().int().nonnegative().max(10_000_000),
  /** Records the fold skipped because their payload did not carry the shape. */
  skippedMalformed: z.number().int().nonnegative(),
});
export type RollupSummary = z.infer<typeof RollupSummary>;

/**
 * One initiative in the portfolio.
 *
 * `slug`, `title` and `objective` are **nullable**, and that is a statement
 * about the ledger rather than about the API: they live in the registration
 * event's payload, which is a bounded free-form record, so an initiative
 * registered without them has none. Reporting an empty string would invent a
 * value; reporting null says the stream never carried one.
 *
 * `headRoadmapDigest` is the newest recorded version's content digest, or null
 * when the initiative has no roadmap version yet. A digest is all that travels:
 * the bytes it names live outside the ledger by the Checkpoint law.
 */
export const InitiativeSummary = z
  .strictObject({
    initiativeId: z.uuid(),
    slug: z.string().min(1).max(120).nullable(),
    title: z.string().min(1).max(200).nullable(),
    objective: z.string().min(1).max(4_000).nullable(),
    status: InitiativeStatusDto,
    eventCount: z.number().int().nonnegative(),
    headRoadmapDigest: Sha256Hex.nullable(),
    roadmapVersionCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
    rollup: RollupSummary,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .superRefine(attachGuards);
export type InitiativeSummary = z.infer<typeof InitiativeSummary>;

/** One recorded roadmap version, newest-first in the history responses. */
export const RoadmapVersionDto = z
  .strictObject({
    roadmapVersionId: z.uuid(),
    initiativeId: z.uuid(),
    version: z.number().int().positive(),
    contentDigest: Sha256Hex,
    parentVersionId: z.uuid().nullable(),
    kind: RoadmapVersionKindDto,
    restoresVersionId: z.uuid().nullable(),
    recordedBy: WorkerIdentityString,
    recordedAt: Timestamp,
    sequence: z.number().int().positive(),
    /** True for exactly one version per initiative: the newest recorded. */
    head: z.boolean(),
  })
  .superRefine(attachGuards);
export type RoadmapVersionDto = z.infer<typeof RoadmapVersionDto>;

/** One task of an initiative, with the spend folded for it alone. */
export const InitiativeTaskDto = z
  .strictObject({
    taskId: z.uuid(),
    currentState: TaskState,
    eventCount: z.number().int().nonnegative(),
    rollup: RollupSummary,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .superRefine(attachGuards);
export type InitiativeTaskDto = z.infer<typeof InitiativeTaskDto>;

/**
 * The quota-confidence surface for one initiative.
 *
 * Derived from what the fold could and could not place, and deliberately not
 * from an account registry this plane cannot reach. `unscopedTokensUsed` is
 * the spend the fold could attribute to no initiative at all — reported rather
 * than hidden, because a rollup that quietly loses spend is worse than one
 * that admits it cannot place it.
 */
export const InitiativeQuotaConfidence = z.strictObject({
  /** LOW when anything was skipped or unplaceable; HIGH when nothing was. */
  confidence: z.enum(["HIGH", "LOW"]),
  skippedMalformed: z.number().int().nonnegative(),
  unscopedTokensUsed: z.number().int().nonnegative().max(10_000_000),
});
export type InitiativeQuotaConfidence = z.infer<typeof InitiativeQuotaConfidence>;

export const InitiativeDetail = z
  .strictObject({
    initiative: InitiativeSummary,
    roadmap: z.array(RoadmapVersionDto).max(MAX_PAGE_LIMIT),
    tasks: z.array(InitiativeTaskDto).max(MAX_PAGE_LIMIT),
    quota: InitiativeQuotaConfidence,
  })
  .superRefine(attachGuards);
export type InitiativeDetail = z.infer<typeof InitiativeDetail>;

/**
 * The portfolio.
 *
 * `items` and a `count`, and deliberately **no cursor**: the ledger's
 * enumerator is unpaged because a portfolio is a small declared set rather
 * than a stream, and a cursor that never advances would be a promise this API
 * cannot keep.
 */
export const InitiativePortfolioResponse = z.strictObject({
  apiContractVersion: ApiContractVersion,
  ledgerContractVersion: LedgerContractVersion,
  items: z.array(InitiativeSummary).max(MAX_PAGE_LIMIT),
  count: z.number().int().nonnegative(),
});
export type InitiativePortfolioResponse = z.infer<typeof InitiativePortfolioResponse>;

export const InitiativeDetailResponse = z.strictObject({
  apiContractVersion: ApiContractVersion,
  ledgerContractVersion: LedgerContractVersion,
  initiative: InitiativeDetail,
});
export type InitiativeDetailResponse = z.infer<typeof InitiativeDetailResponse>;

/** The roadmap history alone, newest first, with the head marked. */
export const InitiativeRoadmapResponse = z.strictObject({
  apiContractVersion: ApiContractVersion,
  ledgerContractVersion: LedgerContractVersion,
  initiativeId: z.uuid(),
  items: z.array(RoadmapVersionDto).max(MAX_PAGE_LIMIT),
  count: z.number().int().nonnegative(),
});
export type InitiativeRoadmapResponse = z.infer<typeof InitiativeRoadmapResponse>;
