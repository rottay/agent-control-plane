import {
  ACCOUNT_ACTIONS,
  ACCOUNT_ACTION_NOTE_MAX,
  AccountStatus,
  ConfidenceLevel,
  ControlPlaneEventType,
  ROADMAP_CONTENT_MAX_BYTES,
  utf8ByteLength,
  EXCEPTIONAL_STATES,
  INITIATIVE_EVENT_TYPES,
  INITIATIVE_STATUSES,
  LIFECYCLE_STATES,
  ROADMAP_VERSION_KINDS,
  TaskState,
  WORKER_IDENTITY_PATTERN,
  WORKER_ROLES,
  BoundedIdentifier,
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

/**
 * Ceilings for the scoped initiative reads (P8-8E-pre).
 *
 * Bounded like every other page here, and bounded *visibly*: the timeline
 * response carries a `truncated` flag rather than silently returning a prefix,
 * because a graph drawn from a truncated timeline and a graph drawn from a
 * complete one are different graphs, and only one of them is true.
 */
export const MAX_SCOPED_TIMELINE_ITEMS = 500;
export const MAX_SCOPED_AGENTS = 200;

/**
 * The owner's accounts are a hand-maintained file, not a collection that grows
 * with use; the bound exists so the response is bounded like every other, not
 * because anyone is expected to approach it.
 */
export const MAX_ACCOUNTS = 100;

/** An account's action history is a log of operator decisions, not telemetry. */
export const MAX_ACCOUNT_ACTIONS = 500;

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
  // P8-8D-pre: the plane's first write route needs a code that means "the
  // decision refused". It is distinct from BAD_REQUEST on purpose: a caller
  // that sent something malformed and a caller whose coherent request lost a
  // race against the recorded head need to tell each other apart, and only the
  // second is worth retrying against a fresh head.
  "WRITE_REFUSED",
  // P8-8G: the write door's two authentication states, kept apart on purpose.
  // `AUTH_REQUIRED` is a caller problem — no credential, or the wrong one, and
  // presenting the right one fixes it. `WRITE_BEARER_UNCONFIGURED` is an
  // operator problem: this process was started without a token file, so no
  // credential exists that would work and a caller retrying with better
  // headers is wasting its time. Collapsing them into one 401 would tell an
  // operator's mistake in a caller's language.
  "AUTH_REQUIRED",
  "WRITE_BEARER_UNCONFIGURED",
  // V2-B4b stage 3C: the tool-call door was started without a tool document,
  // so it has no admitted server to reach. An operator problem like
  // `WRITE_BEARER_UNCONFIGURED`, and told apart from it for the same reason
  // that one is told apart from `AUTH_REQUIRED` — but deliberately NOT its
  // 403. Tool servers are not on the authentication ladder: by the time this
  // answer is reachable the bearer has already passed, so the caller is
  // authorized and the capability is simply absent. That is the shape
  // `LEDGER_UNAVAILABLE` and `STREAM_CAPACITY` already carry, and it is 503.
  "TOOL_SERVERS_UNCONFIGURED",
  // V2-B3a: the stream's connection ceiling. A visible one-line widening of a
  // closed list, which is this repository's convention for a genuinely new
  // refusal — and it is genuinely new: every code above it describes something
  // wrong with the request or with the database, and this one describes neither.
  // The caller sent a valid request; this process is simply already holding as
  // many long-lived connections as it will hold. `BAD_REQUEST` would blame the
  // caller for the server's arithmetic and `INTERNAL` would claim a defect.
  "STREAM_CAPACITY",
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
    /**
     * The edge facts (P8-8E-pre, C1).
     *
     * The control-plane event has carried these since P0; the DTO surfaces
     * them verbatim rather than deriving anything from them. That direction is
     * the whole point: a task graph drawn from `causationId` is drawn from what
     * the ledger recorded, and a graph that inferred its edges from adjacency
     * or timing would be asserting a causality nobody wrote down.
     *
     * Null is the common case and is not an absence to paper over — most
     * events cause nothing and answer nothing.
     */
    correlationId: Uuid.nullable(),
    causationId: Uuid.nullable(),
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
// The event stream (V2-B3a)
// ---------------------------------------------------------------------------

/**
 * The reduced vocabulary a stream reader subscribes in.
 *
 * Five channels over twenty-four event types. The reduction is the point: a
 * reader that wants "did anything happen to the lifecycle" should not have to
 * enumerate seven type names and be wrong the day a twenty-fifth is added.
 * The map below is what makes the reduction checkable rather than editorial.
 */
export const STREAM_CHANNELS = [
  "lifecycle",
  "execution",
  "steps",
  "state",
  "progress",
] as const;
export const StreamChannel = z.enum(STREAM_CHANNELS);
export type StreamChannel = z.infer<typeof StreamChannel>;

/**
 * Every ledger event type, in exactly one channel.
 *
 * **Total and injective on purpose, and asserted rather than asserted-about.**
 * The suite reads `CONTROL_PLANE_EVENT_TYPES` out of the contract and requires
 * this table to name each member exactly once, so a type added upstream fails
 * here instead of silently streaming as some default channel — which is how a
 * reader ends up believing a channel is quiet when it is merely unmapped.
 *
 * **What is behaviourally empty, re-measured (V2-B7T).** The sentence that used
 * to sit here said three of the five channels were structurally live and
 * behaviourally empty. That was already wrong when it was written: cross-
 * referencing the eleven event types the `LIFECYCLE_PLAN` produces against this
 * table shows `lifecycle`, `execution`, `steps` and `state` each already
 * carried at least one produced type, so exactly **one** channel — `progress` —
 * was empty, not three. B7T gave `progress` its first producer, so **no channel
 * is behaviourally empty now**.
 *
 * The accurate claim is about individual event types rather than channels.
 * These nine still have no producer outside a library or a test:
 * `LEASE_ACQUIRED`, `LEASE_REVOKED`, `WRITE_SET_VIOLATION_DETECTED`,
 * `COMMIT_AUTHORIZED`, `ACCOUNT_SWITCH_STARTED`, `ACCOUNT_SWITCH_COMPLETED`,
 * `AUTH_REQUIRED_RAISED`, `QUOTA_WARNING` and `TOKEN_RESERVATION_RECORDED`.
 * Each is owed to a named packet, and none is emitted to make a channel look
 * busy. The map is over the vocabulary, not over what happens to be emitted,
 * so it carries every type either way.
 *
 * `TOOL_CALL_RECORDED` **left this list in V2-B4b stage 3C**, which is the
 * packet stage 2 named as owing it a producer. Stage 2 gave it a contract, a
 * channel, a recorder in `@acp/runtime` and a suite, deliberately without a
 * production caller; stage 3B built the operation, and stage 3C put a door in
 * front of it. `taskToolCalls` POST is that producer: a real request appends a
 * real row. The debt is discharged, and the count above moved with it rather
 * than being left at ten, which would have been a false claim in a comment this
 * repository reads as load-bearing.
 *
 * ADR 0017 makes the older claim and is deliberately left alone: it is a dated
 * record and its claim was true of what it recorded. This comment describes
 * current state, which is why it is the one that had to move.
 */
export const STREAM_CHANNEL_BY_EVENT_TYPE: Readonly<
  Record<ControlPlaneEventType, StreamChannel>
> = Object.freeze({
  // lifecycle — a task's own progress through the states.
  TASK_DISCOVERED: "lifecycle",
  TASK_CLASSIFIED: "lifecycle",
  TASK_READY: "lifecycle",
  RUN_STARTED: "lifecycle",
  TASK_STATE_CHANGED: "lifecycle",
  TASK_FAILED: "lifecycle",
  TASK_CANCELLED: "lifecycle",
  // execution — what it took to run it: a slot, an account, a raised hand.
  SLOT_RESERVED: "execution",
  ACCOUNT_SWITCH_STARTED: "execution",
  ACCOUNT_SWITCH_COMPLETED: "execution",
  AUTH_REQUIRED_RAISED: "execution",
  QUOTA_WARNING: "execution",
  // A tool call is what it took to run it, so it sits with the slot and the
  // account rather than with the walk's own beats (`steps`) or with usage
  // attribution (`progress`).
  TOOL_CALL_RECORDED: "execution",
  // steps — the durable walk's own beats.
  ATOMIC_STEP_COMPLETED: "steps",
  CHECKPOINT_WRITTEN: "steps",
  // state — the authority facts: who held what, what was authorized, what was
  // verified. These are the events a reviewer reads, not the ones a runner does.
  LEASE_ACQUIRED: "state",
  LEASE_REVOKED: "state",
  WRITE_SET_VIOLATION_DETECTED: "state",
  COMMIT_AUTHORIZED: "state",
  COMMIT_RECORDED: "state",
  VERIFICATION_COMPLETED: "state",
  AUDIT_COMPLETED: "state",
  // progress — usage attribution, which moves no state and is not a lifecycle
  // fact even though it rides the task stream.
  TOKEN_USAGE_RECORDED: "progress",
  TOKEN_RESERVATION_RECORDED: "progress",
});

/**
 * Why a connection cannot serve the anchor it was given.
 *
 * One reason today, and a closed list rather than a string so a client can
 * branch on it. No retention window exists — the ledger's event log is never
 * pruned, and the only `DELETE FROM` in it targets projection tables — so
 * "your anchor is too old" cannot arise. The single unusable anchor is one
 * this ledger has never reached, which means the client is holding a position
 * from a different file or from before a rebuild.
 */
export const STREAM_RESYNC_REASONS = ["ANCHOR_AHEAD_OF_HEAD"] as const;
export const StreamResyncReason = z.enum(STREAM_RESYNC_REASONS);
export type StreamResyncReason = z.infer<typeof StreamResyncReason>;

/**
 * The stream's query, which is `EventsQuery` minus its two page controls.
 *
 * `cursor` is absent because the cursor authority is the `Last-Event-ID`
 * header — two places to say where a reader is would be two places for them to
 * disagree. `limit` is absent because the page size is the server's business:
 * a stream has no page for a caller to size.
 *
 * Strict, like every other query here, so an unknown parameter is a
 * `BAD_REQUEST` answered **before** the connection is hijacked — a caller with
 * a typo gets an error envelope it can read, not a silent stream of the wrong
 * rows.
 */
export const StreamQuery = z.strictObject({
  taskId: Uuid.optional(),
  type: ControlPlaneEventType.optional(),
  emittedBy: WorkerIdentityString.optional(),
  toState: TaskState.optional(),
});
export type StreamQuery = z.infer<typeof StreamQuery>;

/**
 * One frame on the wire, in the three kinds a connection can carry.
 *
 * **The identity law, made structural.** Only the `event` arm corresponds to a
 * ledger row, and only an `event` frame is written with an SSE `id:` line whose
 * value is that row's `sequence` verbatim. `hello` and `resync` carry no `id:`
 * at all, and a heartbeat is an SSE comment rather than a frame. A browser's
 * `Last-Event-ID` can therefore only ever hold a value that was a row's
 * sequence — which is what "one sequence authority" means once it stops being
 * a sentence and becomes a shape.
 *
 * **The privacy boundary is `TimelineItem` and nothing else.** No transcript,
 * no prompt, no tool argument, no credential, no absolute path and no provider
 * payload crosses, because none of them has a field here — the item carries
 * payload key names and a byte size, never a payload value, and the `hello`
 * frame's `database` is the same redacted identity every other route sends.
 */
const streamFrameVersions = {
  apiContractVersion: ApiContractVersion,
  ledgerContractVersion: LedgerContractVersion,
};

export const StreamFrame = z
  .discriminatedUnion("kind", [
    /** Sent once, on a connection that carries no anchor: here is the ledger, here is its head. */
    z.strictObject({
      ...streamFrameVersions,
      kind: z.literal("hello"),
      database: LedgerDatabaseIdentity,
      headSequence: SequenceOrZero,
    }),
    /** One ledger row. The only arm that is written with an `id:` line. */
    z.strictObject({
      ...streamFrameVersions,
      kind: z.literal("event"),
      channel: StreamChannel,
      item: TimelineItem,
    }),
    /** This connection cannot serve the anchor it was given, and says which way. */
    z.strictObject({
      ...streamFrameVersions,
      kind: z.literal("resync"),
      reason: StreamResyncReason,
    }),
  ])
  .superRefine(attachGuards);
export type StreamFrame = z.infer<typeof StreamFrame>;

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

export const InitiativeEventTypeDto = z.enum(INITIATIVE_EVENT_TYPES);
export type InitiativeEventTypeDto = z.infer<typeof InitiativeEventTypeDto>;

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

// ---------------------------------------------------------------------------
// The roadmap-version write (P8-8D-pre)
// ---------------------------------------------------------------------------

/**
 * The largest roadmap document this API accepts, re-exported (P8-8G R2).
 *
 * The number is no longer written here. It has one declaration, in
 * `@acp/contracts`, together with the unit law that says it counts **UTF-8
 * bytes** — and the re-export keeps this package's public surface
 * byte-stable, so nothing that imported the name has to move.
 */
export { ROADMAP_CONTENT_MAX_BYTES } from "@acp/contracts";

/**
 * What the JSON envelope around a roadmap document is allowed to weigh
 * (P8-8G A2).
 *
 * A write request is not the document alone: it is the document inside a JSON
 * object, with keys, quoting, escaping and four other fields beside it. A
 * transport limit set to the document ceiling therefore refuses a document
 * *at* the ceiling — which is what happened here, because Fastify's default
 * body limit is exactly 1 MiB and the envelope adds a hundred-odd bytes. The
 * plane advertised a ceiling it could not accept.
 *
 * **The law: the transport limit derives from the one authority, never a
 * second number.** `buildServer` computes
 * `ROADMAP_CONTENT_MAX_BYTES + ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES`, so a
 * change to the ceiling moves the transport with it and the two cannot drift.
 *
 * The allowance covers the envelope and nothing else. A document one byte over
 * the ceiling is still refused — by the schema, which weighs the content
 * itself. Sizing it at 64 KiB is deliberate slack over the ~120 bytes a
 * minimal envelope actually costs: the other fields are bounded but not tiny
 * (`recordedBy` is a worker identity, the digests are 64 hex characters each),
 * and a transport limit that needed recomputing every time one of them grew
 * would be a second authority wearing a disguise.
 */
export const ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES = 64 * 1024;

/**
 * What a caller sends to record a roadmap version.
 *
 * The bytes travel; the digest does not. A caller that supplied its own
 * content digest would be asking this plane to trust an arithmetic claim it
 * can make itself for nothing, and the one thing the ledger records about the
 * content is exactly that digest. `expectedHeadDigest` is the *other* kind of
 * digest — a claim about what the caller believes the head to be — and it is
 * required, nullable only for the first version, exactly as the landed
 * `RoadmapVersion` contract already demands of the value it produces.
 *
 * **The guards run on the content, deliberately (N2).** A roadmap document is
 * free text and this is the one route on which free text enters the plane, so
 * it is scanned for credential and transcript material on ingest. That is a
 * conscious cost: a document that legitimately discusses an `apiKey` field
 * will be refused. The alternative — admitting unscanned free text into an
 * append-only store the UI and CLI both read — is the failure this repository
 * has spent four surfaces preventing, and a roadmap is not worth the
 * exception.
 */
export const RoadmapVersionWriteRequest = z
  .strictObject({
    /**
     * The document, bounded in **bytes** (P8-8G R2).
     *
     * This is the ingress bound, and the one that mattered: `.max()` counts
     * UTF-16 code units, so a multibyte document could pass the schema and
     * then be refused by the store, which weighs bytes. The API would have
     * accepted a request the plane could not honour. One measurement now, on
     * both surfaces.
     */
    content: z
      .string()
      .min(1)
      .refine((value) => utf8ByteLength(value) <= ROADMAP_CONTENT_MAX_BYTES, {
        message: "content exceeds " + String(ROADMAP_CONTENT_MAX_BYTES) + " UTF-8 bytes",
      }),
    /** Null only when recording version 1. */
    expectedHeadDigest: Sha256Hex.nullable(),
    kind: RoadmapVersionKindDto,
    /** Set exactly when the kind is ROLLBACK; the contract re-checks it. */
    restoresVersionId: z.uuid().nullable(),
    recordedBy: WorkerIdentityString,
  })
  .superRefine(attachGuards);
export type RoadmapVersionWriteRequest = z.infer<typeof RoadmapVersionWriteRequest>;

/**
 * What the plane answers when a version is recorded.
 *
 * The recorded version and the sequence it landed at, so a caller can follow
 * its own write into the history it will read back. No content echoes: the
 * caller already has the bytes, and echoing them would put the one unscannable
 * thing on the response path as well as the request path.
 */
export const RoadmapVersionWriteResponse = z.strictObject({
  apiContractVersion: ApiContractVersion,
  ledgerContractVersion: LedgerContractVersion,
  version: RoadmapVersionDto,
  /** The initiative-stream position the append landed at. */
  sequence: z.number().int().positive(),
});
export type RoadmapVersionWriteResponse = z.infer<typeof RoadmapVersionWriteResponse>;

// ---------------------------------------------------------------------------
// The roadmap content read (P8-8D-c2)
// ---------------------------------------------------------------------------

/**
 * Which version's content to serve.
 *
 * **By version, not by digest**, and the choice is a boundary decision rather
 * than a convenience. The artifact store is content-addressed, so a digest
 * selector would have been the shorter path — and it would have let any caller
 * fetch any object in the store by naming its digest, including one recorded
 * against a different initiative. A version is meaningless outside the
 * initiative it belongs to, so resolving version → digest through that
 * initiative's own fold scopes the read to the initiative in the path. The
 * shape of the request is what enforces it, rather than a check that could be
 * forgotten.
 */
/**
 * One entry in an initiative's merged timeline (P8-8E-pre, C2).
 *
 * Two chains feed this: the initiative stream and the task stream of every
 * task the initiative owns. They are **tagged**, not blended — a reader must
 * be able to tell which chain a row came from, because the two carry different
 * facts (a task row has a task state transition; an initiative row has a status
 * transition) and because their sequences are drawn from different counters.
 *
 * Sequence is therefore *not* comparable across streams, and this DTO does not
 * pretend otherwise: it carries the row's own sequence for use within its
 * chain, and the merge orders by `recordedAt`.
 */
export const ScopedTimelineEntry = z
  .discriminatedUnion("stream", [
    z.strictObject({
      stream: z.literal("TASK"),
      sequence: Sequence,
      eventId: Uuid,
      taskId: Uuid,
      type: ControlPlaneEventType,
      fromState: TaskState.nullable(),
      toState: TaskState,
      emittedBy: WorkerIdentityString,
      occurredAt: Timestamp,
      recordedAt: Timestamp,
      correlationId: Uuid.nullable(),
      causationId: Uuid.nullable(),
    }),
    z.strictObject({
      stream: z.literal("INITIATIVE"),
      sequence: Sequence,
      eventId: Uuid,
      initiativeId: Uuid,
      type: InitiativeEventTypeDto,
      fromStatus: InitiativeStatusDto.nullable(),
      toStatus: InitiativeStatusDto,
      emittedBy: WorkerIdentityString,
      occurredAt: Timestamp,
      recordedAt: Timestamp,
    }),
  ])
  .superRefine(attachGuards);
export type ScopedTimelineEntry = z.infer<typeof ScopedTimelineEntry>;

/**
 * An initiative's merged timeline.
 *
 * **The tie-break is stated, not implied.** The two chains have two clocks, so
 * `recordedAt` collisions are expected rather than exotic. The total order is:
 * `recordedAt` ascending, then stream with `INITIATIVE` before `TASK`, then
 * `sequence` ascending within the stream. The middle term is the one that
 * matters and the one an implicit sort would have left to chance: when a task
 * event and an initiative event share a millisecond, the initiative row is the
 * context for the task row, so it reads first. Declaring the rule here means
 * two clients that sort the same page agree, which is what the parity law
 * requires of every field below.
 */
export const InitiativeTimelineResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    initiativeId: z.uuid(),
    items: z.array(ScopedTimelineEntry).max(MAX_SCOPED_TIMELINE_ITEMS),
    count: Count,
    /** True when the fold stopped at the ceiling rather than at the end. */
    truncated: z.boolean(),
  })
  .superRefine(attachGuards);
export type InitiativeTimelineResponse = z.infer<typeof InitiativeTimelineResponse>;

/**
 * One worker as this initiative saw it (P8-8E-pre, C3).
 *
 * Every count and every instant here is **scoped**: folded from the events this
 * initiative's own tasks carry, never read off the global worker projection.
 * The distinction is the requirement — a worker's global `lastTaskId` routinely
 * names a task in a different initiative, and publishing that under a scoped
 * title would be a lie told by a correct query.
 */
export const ScopedAgentSummary = z
  .strictObject({
    identity: WorkerIdentityString,
    provider: z.string().min(1).max(40),
    model: z.string().min(1).max(60),
    role: WorkerRole,
    instance: z.string().min(1).max(40),
    /** Events this identity emitted on this initiative's tasks. */
    eventCount: Count,
    /** Distinct tasks of this initiative the identity touched. */
    taskCount: Count,
    firstSeenAt: Timestamp,
    lastSeenAt: Timestamp,
    /** The task it acted on most recently *within this initiative*. */
    currentTaskId: Uuid,
    /** That action's own type — the last thing it did here. */
    lastEventType: ControlPlaneEventType,
  })
  .superRefine(attachGuards);
export type ScopedAgentSummary = z.infer<typeof ScopedAgentSummary>;

/** The workers that have acted on one initiative. */
export const InitiativeAgentsResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    initiativeId: z.uuid(),
    items: z.array(ScopedAgentSummary).max(MAX_SCOPED_AGENTS),
    count: Count,
  })
  .superRefine(attachGuards);
export type InitiativeAgentsResponse = z.infer<typeof InitiativeAgentsResponse>;

/**
 * The words this plane uses when it cannot show accounts (P8-8F).
 *
 * Five, closed, and **mapped** from the accounts registry's own fourteen
 * refusals rather than invented beside them. The mapping is total: every
 * landed refusal reaches exactly one of these, so a refusal the loader learns
 * to make cannot fall through into a generic answer.
 *
 * They are deliberately coarser than the loader's vocabulary. A reader of this
 * API is being told whether to wire a path, create a file, fix its permissions,
 * fix its contents, or shrink it — five different actions. The loader's finer
 * distinctions (`OWNER_FILE_NOT_OWNED` vs `OWNER_FILE_UNSAFE_PERMISSIONS`)
 * separate two facts that call for the same action and, said over HTTP, would
 * describe the operator's filesystem to anyone who can reach the port.
 */
/**
 * The account vocabularies, derived from the contract rather than restated.
 *
 * `.options` reads the members off the landed Zod enums, so a status added in
 * `@acp/contracts` cannot silently fail to reach the API, and a DTO member that
 * the domain does not have cannot be invented here.
 */
export const AccountStatusDto = z.enum(AccountStatus.options);
export type AccountStatusDto = z.infer<typeof AccountStatusDto>;

export const ConfidenceLevelDto = z.enum(ConfidenceLevel.options);
export type ConfidenceLevelDto = z.infer<typeof ConfidenceLevelDto>;

export const ACCOUNTS_UNAVAILABLE_REASONS = Object.freeze([
  "ACCOUNTS_FILE_UNCONFIGURED",
  "ACCOUNTS_FILE_ABSENT",
  "ACCOUNTS_FILE_UNREADABLE",
  "ACCOUNTS_FILE_SCHEMA_REFUSED",
  "ACCOUNTS_FILE_OVERSIZE",
] as const);
export const AccountsUnavailableReason = z.enum(ACCOUNTS_UNAVAILABLE_REASONS);
export type AccountsUnavailableReason = z.infer<typeof AccountsUnavailableReason>;

/**
 * One account, as the observation plane may describe it.
 *
 * **What is missing is the point.** `credentialRef` and `authProfileRef` exist
 * on the landed `AccountRecord` and are *absent from this schema entirely* —
 * not nulled, not redacted, not replaced by a placeholder. A field that is
 * present-but-opaque still tells a reader that a secret reference exists, what
 * it is called, and where to look for it; omission tells them nothing, which is
 * the correct amount. Strictness makes the omission enforceable rather than
 * conventional: a server that grew the field would fail here.
 *
 * Quota and reset each carry their own confidence because they are separately
 * knowable. An account can have a well-observed spend rate and no idea when its
 * window rolls over, and collapsing the two into one number would report the
 * better-known fact as if the worse-known one were equally sound.
 */
/** The action vocabulary, derived from the contract rather than restated. */
export const AccountActionDto = z.enum(ACCOUNT_ACTIONS);
export type AccountActionDto = z.infer<typeof AccountActionDto>;

/** Why an action was refused. Closed, and mapped from the seam's own words. */
export const ACCOUNT_ACTION_REFUSAL_WORDS = Object.freeze([
  "ACCOUNTS_UNAVAILABLE",
  "UNKNOWN_ACCOUNT",
  "ALREADY_IN_STATE",
  "WRITE_CONFLICT",
] as const);
export const AccountActionRefusalDto = z.enum(ACCOUNT_ACTION_REFUSAL_WORDS);
export type AccountActionRefusalDto = z.infer<typeof AccountActionRefusalDto>;

export const AccountDto = z
  .strictObject({
    accountId: z.string().min(1).max(80),
    provider: z.string().min(1).max(40),
    models: z.array(z.string().min(1).max(60)).max(50),
    plan: z.string().max(80).nullable(),
    state: AccountStatusDto,
    quota: z.strictObject({
      /** Null when the fold could not estimate — never a zero standing in for it. */
      remainingRatio: z.number().min(0).max(1).nullable(),
      confidence: ConfidenceLevelDto,
    }),
    reset: z.strictObject({
      nextResetAt: Timestamp.nullable(),
      /** Where the instant came from: the provider declared it, or we observed it. */
      source: z.enum(["OBSERVED", "DECLARED", "UNKNOWN"]),
      confidence: ConfidenceLevelDto,
    }),
    lastProbeAt: Timestamp.nullable(),
    lastError: z.string().max(200).nullable(),
    /**
     * The authority overlay (P8-8G packet 2).
     *
     * `state` above is what the owner file says; `effectiveState` is what
     * actually governs, and `stateSource` says which of the two answered.
     * Both are published because a reader comparing them is how an operator
     * notices that the file and the ledger disagree — a real thing to see,
     * not a discrepancy to collapse into one number.
     */
    effectiveState: AccountStatusDto,
    stateSource: z.enum(["OWNER_FILE", "OPERATOR_ACTION"]),
    lastAction: z
      .strictObject({
        action: AccountActionDto,
        at: Timestamp,
        by: WorkerIdentityString,
      })
      .nullable(),
  })
  .superRefine(attachGuards);
export type AccountDto = z.infer<typeof AccountDto>;

/**
 * What an operator sends to act on an account.
 *
 * `setState` is required for `OWNER_OVERRIDE` and refused for every other
 * action — the two mismatched shapes are refused here rather than discovered
 * in the seam, so a caller learns the rule from the contract.
 */
export const AccountActionRequest = z
  .strictObject({
    action: AccountActionDto,
    setState: AccountStatusDto.nullable(),
    note: z.string().max(ACCOUNT_ACTION_NOTE_MAX).nullable(),
    actor: WorkerIdentityString,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);
    if (value.action === "OWNER_OVERRIDE" && value.setState === null) {
      ctx.addIssue({
        code: "custom",
        message: "OWNER_OVERRIDE must say which state it sets",
        path: ["setState"],
      });
    }
    if (value.action !== "OWNER_OVERRIDE" && value.setState !== null) {
      ctx.addIssue({
        code: "custom",
        message: "only OWNER_OVERRIDE may name a state; " + value.action + " implies its own",
        path: ["setState"],
      });
    }
  });
export type AccountActionRequest = z.infer<typeof AccountActionRequest>;

/** One recorded action, as the history and the write receipt render it. */
export const AccountActionDtoRecord = z
  .strictObject({
    sequence: Sequence,
    eventId: Uuid,
    accountId: z.string().min(1).max(80),
    version: z.number().int().positive(),
    action: AccountActionDto,
    resultingState: AccountStatusDto,
    actor: WorkerIdentityString,
    note: z.string().max(ACCOUNT_ACTION_NOTE_MAX).nullable(),
    recordedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx);
  });
export type AccountActionDtoRecord = z.infer<typeof AccountActionDtoRecord>;

/** The write receipt: the recorded action, with the coordinates that name it. */
export const AccountActionWriteResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    action: AccountActionDtoRecord,
  })
  .superRefine(attachGuards);
export type AccountActionWriteResponse = z.infer<typeof AccountActionWriteResponse>;

/** One account's action history, oldest first. */
export const AccountActionsResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    accountId: z.string().min(1).max(80),
    items: z.array(AccountActionDtoRecord).max(MAX_ACCOUNT_ACTIONS),
    count: Count,
  })
  .superRefine(attachGuards);
export type AccountActionsResponse = z.infer<typeof AccountActionsResponse>;

/**
 * The accounts read, as a closed union rather than a list plus an error field.
 *
 * A missing or refused owner file is not an error of this endpoint — it is the
 * plane's honest state, and the commonest one on a fresh machine. Modelling it
 * as a 200 with `UNAVAILABLE` says so; a 500 would say the server broke, and an
 * empty `items` array would say the owner has no accounts, which is a different
 * and false claim.
 *
 * `detail` carries **field paths only, never file values or lines**. The
 * registry's landed law is that nothing from the owner file is ever forwarded;
 * this is that law surviving the trip through HTTP, and the guards below are
 * what make it checkable rather than promised.
 */
export const AccountsResponse = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("READY"),
      apiContractVersion: ApiContractVersion,
      ledgerContractVersion: LedgerContractVersion,
      items: z.array(AccountDto).max(MAX_ACCOUNTS),
      count: Count,
      /** The injected instant every estimate here was computed against. */
      estimatedAt: Timestamp,
    }),
    z.strictObject({
      status: z.literal("UNAVAILABLE"),
      apiContractVersion: ApiContractVersion,
      ledgerContractVersion: LedgerContractVersion,
      reason: AccountsUnavailableReason,
      /** A JSON path or a shape observation. Never a value from the file. */
      detail: z.string().max(200).optional(),
    }),
  ])
  .superRefine(attachGuards);
export type AccountsResponse = z.infer<typeof AccountsResponse>;

export const RoadmapContentQuery = z.strictObject({
  version: DecimalNonNegativeInteger.pipe(z.number().int().positive().max(1_000_000)),
});
export type RoadmapContentQuery = z.infer<typeof RoadmapContentQuery>;

/**
 * One roadmap document, with the record that names it.
 *
 * The content travels beside its own digest and version so a reader can verify
 * what it was given rather than trusting the transport: the digest here is the
 * one the ledger recorded, and re-hashing the content is a check the caller can
 * make for itself.
 *
 * **The guards run on the way out.** They ran on ingest, and they run again
 * here — not because the store is distrusted, but because this is the response
 * that carries free text to a browser and a terminal, and a boundary that only
 * trusts the layer below it is not a boundary. A document that somehow reached
 * the store carrying a credential shape does not leave through this route.
 */
export const RoadmapContentResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    initiativeId: z.uuid(),
    version: z.number().int().positive(),
    contentDigest: Sha256Hex,
    kind: RoadmapVersionKindDto,
    /**
     * The stored bytes, verbatim, bounded in **bytes** (P8-8G R2).
     *
     * `.max()` on a string counts UTF-16 code units, which for any multibyte
     * document is a different number from the bytes the store weighs. This
     * refinement measures what the store measures, so the two surfaces refuse
     * the same document rather than nearly the same one.
     */
    content: z
      .string()
      .min(1)
      .refine((value) => utf8ByteLength(value) <= ROADMAP_CONTENT_MAX_BYTES, {
        message: "content exceeds " + String(ROADMAP_CONTENT_MAX_BYTES) + " UTF-8 bytes",
      }),
  })
  .superRefine(attachGuards);
export type RoadmapContentResponse = z.infer<typeof RoadmapContentResponse>;

// ---------------------------------------------------------------------------
// The explicit tool call (V2-B4b stage 3C)
// ---------------------------------------------------------------------------

/**
 * The ceiling on one page of recorded tool calls.
 *
 * The same shape every other collection here carries: a bound the server can
 * assert rather than a convention a caller is trusted to respect.
 */
export const MAX_TOOL_CALLS = 500;

/**
 * What a caller sends to execute one explicit tool call.
 *
 * **This schema is the equivalence claim.** It is the POST body of
 * `taskToolCalls` and, byte for byte, the CLI's `--request` document in the
 * packet after this one. Two doors that parse the same schema cannot drift into
 * accepting different requests, which is the property the parity proof rests
 * on — so the schema lives here, in the contract both doors depend on, rather
 * than in either of them.
 *
 * **Every bound here is one of the operation's own prechecks, moved forward.**
 * `runToolCall` refuses a request outside these bounds by throwing, and a throw
 * from inside the operation reaches a caller as a 500 that blames the wrong
 * party. Parsing first turns each of those into a 400 that names the field —
 * so prechecks 1 to 4 (the bounded names, the identity, both indices, and the
 * invocation's own attempt and instant) are closed by construction before the
 * operation is entered at all.
 *
 * `causedBy` is optional and, when present, must name an event that already
 * exists **in this same task**. The event contract permits cross-task causation
 * in general; this route narrows it deliberately, because a tool call caused by
 * another task's event is a claim no reader of this task's trail could resolve.
 * The existence check needs a ledger and therefore lives at the door, not here.
 */
export const ToolCallExecuteRequest = z
  .strictObject({
    taskId: Uuid,
    attempt: z.number().int().positive().max(10_000),
    submittedAt: Timestamp,
    submissionDigest: Sha256Hex,
    operationIndex: z.number().int().nonnegative().max(1_000_000),
    callIndex: z.number().int().nonnegative().max(1_000_000),
    accountId: BoundedIdentifier,
    identity: WorkerIdentityString,
    serverId: BoundedIdentifier,
    toolName: BoundedIdentifier,
    arguments: z.record(z.string().max(120), z.unknown()),
    causedBy: Uuid.nullable().optional(),
  })
  .superRefine(attachGuards);
export type ToolCallExecuteRequest = z.infer<typeof ToolCallExecuteRequest>;

/**
 * What the door answers when a request became an operation.
 *
 * A refusal is **not** an error here. `outcome: "REFUSED"` is a 200, because
 * the call became an operation and a durable row exists for it; 4xx is reserved
 * for requests that never became one. That is the response half of the
 * operation's own invariant.
 *
 * `content` is the one field that reaches the caller and nowhere else — never a
 * ledger row, never a stream frame, never a log line. It is empty on a refusal
 * and empty on a replay, and the replay case is not a policy: the content was
 * never durable, so there is nothing to return.
 *
 * `sequence` is the door's to project, not the operation's. The runtime's
 * `LedgerPort` exposes no sequence and the event contract has no such field, so
 * the operation cannot answer one; the door holds the real ledger and looks it
 * up by the `eventId` the operation returns.
 */
export const ToolCallExecuteResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    replayed: z.boolean(),
    outcome: z.enum(["COMPLETED", "REFUSED"]),
    /** A refusal vocabulary word, or null when the call completed. */
    refusal: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).nullable(),
    /** The refused field's path. Null on a completion and on every replay. */
    at: z.string().min(1).max(120).nullable(),
    serverId: BoundedIdentifier,
    toolName: BoundedIdentifier,
    transport: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    accountId: BoundedIdentifier,
    argumentBytes: Count,
    resultBytes: Count,
    contentBlocks: Count,
    content: z.array(z.string()),
    sequence: Sequence,
    eventId: Uuid,
    transitionId: z.string().min(1).max(120),
  })
  .superRefine(attachGuards);
export type ToolCallExecuteResponse = z.infer<typeof ToolCallExecuteResponse>;

/**
 * One recorded tool call, as the GET renders it.
 *
 * The nine durable payload scalars, plus the coordinates that name the row.
 * There is **no content member and no argument member**, and their absence is
 * structural rather than a filter the reader has to trust: the recorder never
 * wrote them, so this shape has nothing to omit.
 */
export const ToolCallRow = z
  .strictObject({
    sequence: Sequence,
    eventId: Uuid,
    transitionId: z.string().min(1).max(120),
    occurredAt: Timestamp,
    emittedBy: WorkerIdentityString,
    causedBy: Uuid.nullable(),
    accountId: BoundedIdentifier,
    serverId: BoundedIdentifier,
    toolName: BoundedIdentifier,
    transport: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    outcome: z.enum(["COMPLETED", "REFUSED"]),
    refusal: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).nullable(),
    argumentBytes: Count,
    resultBytes: Count,
    contentBlocks: Count,
  })
  .superRefine(attachGuards);
export type ToolCallRow = z.infer<typeof ToolCallRow>;

/** One task's recorded tool calls, oldest first, paged by ledger sequence. */
export const ToolCallPageResponse = z
  .strictObject({
    apiContractVersion: ApiContractVersion,
    ledgerContractVersion: LedgerContractVersion,
    taskId: Uuid,
    items: z.array(ToolCallRow).max(MAX_TOOL_CALLS),
    count: Count,
    nextCursor: z.string().min(1).max(120).nullable(),
  })
  .superRefine(attachGuards);
export type ToolCallPageResponse = z.infer<typeof ToolCallPageResponse>;

/** The GET's query: a sequence cursor and a bound, both optional. */
export const ToolCallsQuery = z
  .strictObject({
    cursor: z.string().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(MAX_TOOL_CALLS).optional(),
  })
  .superRefine(attachGuards);
export type ToolCallsQuery = z.infer<typeof ToolCallsQuery>;
