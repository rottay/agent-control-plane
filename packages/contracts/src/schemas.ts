import { z } from "zod";

/**
 * Agent Control Plane runtime contracts.
 *
 * Laws encoded here, taken from docs/ROADMAP.md:
 *
 * 1. Provider neutral. No provider, model or vendor name is enumerated in any
 *    schema. Providers are opaque lowercase segments.
 * 2. Strict. Every object rejects unknown keys, so a drifting producer fails
 *    closed instead of smuggling extra state through the ledger.
 * 3. Versioned. Every top level contract carries contractVersion.
 * 4. No secrets. Checkpoints, events and account records reject credential
 *    bearing keys and secret shaped values anywhere in their tree.
 * 5. No transcript continuity. Continuity is carried by digests, receipts and
 *    the next safe action, never by replaying a provider conversation.
 */

export const CONTRACT_VERSION = "1.0.0" as const;

/** Serialized byte budget for a single Checkpoint. */
export const CHECKPOINT_MAX_BYTES = 16_384;

/** Serialized byte budget for a single ControlPlaneEvent payload. */
export const EVENT_PAYLOAD_MAX_BYTES = 8_192;

/** Maximum object depth the credential and transcript scanners will walk. */
const MAX_SCAN_DEPTH = 12;

const ContractVersion = z.literal(CONTRACT_VERSION);

// ---------------------------------------------------------------------------
// Primitive value shapes
// ---------------------------------------------------------------------------

const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase sha-256 hex digest");

const GitCommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "expected a full 40 character git object id");

const Timestamp = z.iso.datetime({ offset: true });

const Uuid = z.uuid();

/**
 * A repository relative path. Absolute paths and parent traversal are rejected
 * so a write-set can never escape the worktree it was scoped to.
 */
const RepoRelativePath = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => !value.startsWith("/"), "path must not be absolute")
  .refine(
    (value) => !/(^|\/)\.\.(\/|$)/.test(value),
    "path must not contain a parent traversal segment",
  )
  .refine((value) => !value.includes("\\"), "path must use forward slashes");

/** An absolute local path, used only for worktree and config roots. */
const AbsolutePath = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => value.startsWith("/"), "path must be absolute");

// ---------------------------------------------------------------------------
// Credential and transcript guards
// ---------------------------------------------------------------------------

/**
 * Keys that may never appear in a checkpoint, event or account record.
 * Comparison is done on a normalized key (lowercased, non alphanumerics
 * stripped) and is exact, so an opaque reference such as credentialRef or
 * secretRef is still permitted while a bare credential or secret is not.
 */
const DENIED_KEYS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "secretvalue",
  "clientsecret",
  "token",
  "tokenvalue",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "bearertoken",
  "apikey",
  "apitoken",
  "authtoken",
  "cookie",
  "cookies",
  "sessioncookie",
  "setcookie",
  "authorization",
  "authheader",
  "privatekey",
  "signingkey",
  "sessionkey",
  "credential",
  "credentials",
  "jwt",
  "otp",
  "otpcode",
  "totp",
  "mfacode",
]);

/**
 * Credential stems matched as a suffix of the normalized key.
 *
 * Exact-key matching alone lets a compound name through: dbPassword,
 * oauthToken and sessionSecret all normalize to something that is not in the
 * exact set but plainly names credential material. Suffix matching closes that
 * without catching opaque locators or policy metadata, because those end in
 * ref or policy rather than in a credential stem.
 *
 * Safe by construction: credentialRef, authProfileRef, secretRef,
 * passwordPolicy, tokenBudget.
 */
const DENIED_KEY_STEMS: readonly string[] = [
  "password",
  "passphrase",
  "secret",
  "token",
  "cookie",
  "apikey",
  "apitoken",
  "privatekey",
  "signingkey",
  "credential",
  "credentials",
];

function isDeniedCredentialKey(normalized: string): boolean {
  if (DENIED_KEYS.has(normalized)) return true;
  return DENIED_KEY_STEMS.some((stem) => normalized.endsWith(stem));
}

/**
 * Keys whose presence would mean the provider conversation itself is being
 * used as continuity. The roadmap forbids that: continuity is digest based.
 */
const DENIED_TRANSCRIPT_KEYS: ReadonlySet<string> = new Set([
  "transcript",
  "transcripts",
  "conversation",
  "conversationhistory",
  "messages",
  "messagehistory",
  "chatlog",
  "chathistory",
  "history",
  "rawoutput",
  "rawresponse",
  "completion",
  "completions",
  "promptlog",
  "turns",
]);

/** Value shapes that look like live credential material regardless of key. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/,
  /\bsk-[A-Za-z0-9-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

export interface GuardViolation {
  readonly path: string;
  readonly reason: string;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function formatPath(segments: readonly (string | number)[]): string {
  return segments.length === 0 ? "<root>" : segments.join(".");
}

function scan(
  value: unknown,
  segments: (string | number)[],
  depth: number,
  isDenied: (normalizedKey: string) => boolean,
  checkValues: boolean,
  out: GuardViolation[],
): void {
  if (depth > MAX_SCAN_DEPTH) {
    out.push({
      path: formatPath(segments),
      reason: "structure is nested deeper than the contract scan budget allows",
    });
    return;
  }

  if (typeof value === "string") {
    if (!checkValues) return;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        out.push({
          path: formatPath(segments),
          reason: "value matches a known credential material shape",
        });
        return;
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      scan(value[index], [...segments, index], depth + 1, isDenied, checkValues, out);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeKey(key);
      if (isDenied(normalized)) {
        out.push({
          path: formatPath([...segments, key]),
          reason: "key " + key + " is forbidden by the control plane contract",
        });
        continue;
      }
      scan(child, [...segments, key], depth + 1, isDenied, checkValues, out);
    }
  }
}

/** Report every credential bearing key or secret shaped value in a tree. */
export function findCredentialViolations(value: unknown): GuardViolation[] {
  const out: GuardViolation[] = [];
  scan(value, [], 0, isDeniedCredentialKey, true, out);
  return out;
}

/** Report every key that would smuggle a provider transcript as continuity. */
export function findTranscriptViolations(value: unknown): GuardViolation[] {
  const out: GuardViolation[] = [];
  scan(value, [], 0, (key) => DENIED_TRANSCRIPT_KEYS.has(key), false, out);
  return out;
}

/** Serialized size of a value in bytes, used for the checkpoint budget. */
export function serializedByteLength(value: unknown): number {
  // JSON.stringify yields undefined for undefined, functions and symbols, which
  // this overload does not surface in its type. Narrow at runtime instead.
  //
  // TextEncoder rather than Buffer: this module is reused by the browser-safe
  // observation contract, and Buffer is a Node global. TextEncoder is a Web
  // platform API available in both runtimes, and it measures the same UTF-8
  // bytes, so the checkpoint budget is unchanged.
  const json: unknown = JSON.stringify(value);
  return typeof json === "string" ? new TextEncoder().encode(json).byteLength : 0;
}

type RefinementContext = z.core.$RefinementCtx;

function attachGuards(
  value: unknown,
  ctx: RefinementContext,
  options: { readonly transcript: boolean },
): void {
  for (const violation of findCredentialViolations(value)) {
    ctx.addIssue({
      code: "custom",
      message: "credential material is forbidden: " + violation.reason,
      path: violation.path === "<root>" ? [] : violation.path.split("."),
    });
  }
  if (!options.transcript) return;
  for (const violation of findTranscriptViolations(value)) {
    ctx.addIssue({
      code: "custom",
      message: "provider transcript continuity is forbidden: " + violation.reason,
      path: violation.path === "<root>" ? [] : violation.path.split("."),
    });
  }
}

// ---------------------------------------------------------------------------
// Worker identity
// ---------------------------------------------------------------------------

/**
 * Control plane roles. Roles are a control plane concept and therefore closed.
 * Providers and models are open, because the roadmap forbids assuming that
 * current model preferences are permanent.
 */
export const WORKER_ROLES = [
  "coordinator",
  "implementer",
  "reviewer",
  "consultant",
  "verifier",
] as const;

export const WorkerRole = z.enum(WORKER_ROLES);
export type WorkerRole = z.infer<typeof WorkerRole>;

const IDENTITY_SEGMENT = "[a-z0-9][a-z0-9._-]*";

/** Canonical identity string: <provider>/<model>/<role>/<instance>. */
export const WORKER_IDENTITY_PATTERN = new RegExp(
  "^(" +
    IDENTITY_SEGMENT +
    ")/(" +
    IDENTITY_SEGMENT +
    ")/(" +
    WORKER_ROLES.join("|") +
    ")/([0-9]{2,4})$",
);

export const WorkerIdentityString = z
  .string()
  .regex(
    WORKER_IDENTITY_PATTERN,
    "identity must be <provider>/<model>/<role>/<instance>, lowercase, instance 2 to 4 digits",
  );
export type WorkerIdentityString = z.infer<typeof WorkerIdentityString>;

export const WorkerIdentity = z.strictObject({
  provider: z.string().regex(new RegExp("^" + IDENTITY_SEGMENT + "$")).max(40),
  model: z.string().regex(new RegExp("^" + IDENTITY_SEGMENT + "$")).max(60),
  role: WorkerRole,
  instance: z.string().regex(/^[0-9]{2,4}$/),
});
export type WorkerIdentity = z.infer<typeof WorkerIdentity>;

export function formatWorkerIdentity(identity: WorkerIdentity): WorkerIdentityString {
  return (
    identity.provider + "/" + identity.model + "/" + identity.role + "/" + identity.instance
  );
}

export function parseWorkerIdentity(value: string): WorkerIdentity {
  const match = WORKER_IDENTITY_PATTERN.exec(WorkerIdentityString.parse(value));
  if (match === null) {
    throw new Error("unreachable: identity passed the pattern but did not match");
  }
  return WorkerIdentity.parse({
    provider: match[1],
    model: match[2],
    role: match[3],
    instance: match[4],
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** The happy path lifecycle, in order, exactly as the roadmap freezes it. */
export const LIFECYCLE_STATES = [
  "DISCOVERED",
  "DT_CLASSIFIED",
  "READY",
  "RESERVED",
  "RUNNING",
  "VERIFYING",
  "AUDITING",
  "READY_TO_COMMIT",
  "COMMITTED",
  "CHECKPOINTED",
] as const;

/** Exceptional states. These are not orderable and may be entered laterally. */
export const EXCEPTIONAL_STATES = [
  "WAITING_OWNER",
  "DRAINING",
  "QUOTA_BLOCKED",
  "AUTH_REQUIRED",
  "REJECTED",
  "FAILED",
  "SUSPECT_WORKTREE",
  "CANCELLED",
] as const;

export const LifecycleState = z.enum(LIFECYCLE_STATES);
export type LifecycleState = z.infer<typeof LifecycleState>;

export const ExceptionalState = z.enum(EXCEPTIONAL_STATES);
export type ExceptionalState = z.infer<typeof ExceptionalState>;

export const TaskState = z.union([LifecycleState, ExceptionalState]);
export type TaskState = z.infer<typeof TaskState>;

export function isLifecycleState(value: string): value is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isExceptionalState(value: string): value is ExceptionalState {
  return (EXCEPTIONAL_STATES as readonly string[]).includes(value);
}

/** Terminal states. A task in one of these will not progress on its own. */
export const TERMINAL_STATES: readonly TaskState[] = [
  "CHECKPOINTED",
  "REJECTED",
  "FAILED",
  "SUSPECT_WORKTREE",
  "CANCELLED",
];

// ---------------------------------------------------------------------------
// Shared references
// ---------------------------------------------------------------------------

export const PathDigest = z.strictObject({
  path: RepoRelativePath,
  sha256: Sha256Hex,
});
export type PathDigest = z.infer<typeof PathDigest>;

export const ArtifactRef = z.strictObject({
  artifactId: Uuid,
  kind: z.enum(["DIFF", "LOG", "REPORT", "SCREENSHOT", "RECEIPT", "FIXTURE"]),
  sha256: Sha256Hex,
  byteSize: z.number().int().nonnegative().max(1_073_741_824),
  mediaType: z.string().max(100),
  label: z.string().max(200),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

// ---------------------------------------------------------------------------
// TaskEnvelope
// ---------------------------------------------------------------------------

export const TaskClassification = z.enum(["MECHANICAL", "SEMANTIC", "ARCHITECTURAL"]);
export type TaskClassification = z.infer<typeof TaskClassification>;

export const CommitPolicy = z.enum(["NO_COMMIT", "LOCAL_COMMIT_WITH_RECEIPT"]);
export type CommitPolicy = z.infer<typeof CommitPolicy>;

export const TaskEnvelope = z
  .strictObject({
    contractVersion: ContractVersion,
    taskId: Uuid,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(4_000),
    classification: TaskClassification,
    issuedBy: WorkerIdentityString,
    issuedAt: Timestamp,

    /** Authority is path plus content digest. Nothing else grants authority. */
    authority: z.array(PathDigest).max(1_000),
    readSet: z.array(RepoRelativePath).max(1_000),
    /** The exact write-set. An empty write-set means a read-only packet. */
    writeSet: z.array(RepoRelativePath).max(500),
    /** Opaque keys used to build the conflict graph between parallel packets. */
    conflictKeys: z.array(z.string().min(1).max(200)).max(200),

    allowedCommands: z.array(z.string().min(1).max(400)).max(100),
    forbiddenActions: z.array(z.string().min(1).max(400)).max(100),

    output: z.strictObject({
      kind: z.enum(["DIFF", "REPORT", "FIXTURE", "NONE"]),
      description: z.string().max(1_000),
    }),
    validation: z.strictObject({
      commands: z.array(z.string().min(1).max(400)).max(50),
      independentVerifierRequired: z.boolean(),
    }),

    eligibility: z.strictObject({
      roles: z.array(WorkerRole).min(1).max(WORKER_ROLES.length),
      /** null means provider neutral: any provider may serve this packet. */
      providers: z.array(z.string().min(1).max(40)).max(20).nullable(),
      requiredCapabilities: z.array(z.string().min(1).max(80)).max(50),
    }),

    budget: z.strictObject({
      maxTokens: z.number().int().positive().max(100_000_000),
      maxWallClockSeconds: z.number().int().positive().max(86_400),
      /** Never spend the reserve. It pays for checkpoint, verify and audit. */
      reserveTokensForCheckpoint: z.number().int().nonnegative().max(10_000_000),
    }),

    visualEvidenceRequired: z.boolean(),
    commitPolicy: CommitPolicy,
    checkpointPolicy: z.strictObject({
      onEveryAtomicStep: z.boolean(),
      maxStepsWithoutCheckpoint: z.number().int().positive().max(100),
    }),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });

    if (value.budget.reserveTokensForCheckpoint >= value.budget.maxTokens) {
      ctx.addIssue({
        code: "custom",
        message: "checkpoint reserve must be strictly smaller than the token budget",
        path: ["budget", "reserveTokensForCheckpoint"],
      });
    }

    if (value.commitPolicy === "LOCAL_COMMIT_WITH_RECEIPT" && value.writeSet.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a packet with an empty write-set may not carry a commit policy",
        path: ["commitPolicy"],
      });
    }

    const duplicates = value.writeSet.filter(
      (path, index) => value.writeSet.indexOf(path) !== index,
    );
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "write-set entries must be unique",
        path: ["writeSet"],
      });
    }
  });
export type TaskEnvelope = z.infer<typeof TaskEnvelope>;

// ---------------------------------------------------------------------------
// WorkerSlot
// ---------------------------------------------------------------------------

export const HealthProbe = z.strictObject({
  status: z.enum(["OK", "DEGRADED", "FAILED", "UNKNOWN"]),
  checkedAt: Timestamp,
  latencyMs: z.number().int().nonnegative().max(600_000).nullable(),
  classifiedError: z.string().max(200).nullable(),
});
export type HealthProbe = z.infer<typeof HealthProbe>;

export const Lease = z.strictObject({
  leaseId: Uuid,
  worktreePath: AbsolutePath,
  holder: WorkerIdentityString,
  acquiredAt: Timestamp,
  expiresAt: Timestamp,
});
export type Lease = z.infer<typeof Lease>;

export const WorkerSlot = z
  .strictObject({
    contractVersion: ContractVersion,
    slotId: Uuid,
    identity: WorkerIdentityString,
    provider: z.string().min(1).max(40),
    // The model segment inside `identity` is the ROUTING ALIAS the DT schedules
    // against (for example "opus"). `resolvedModel` below is the EXACT model the
    // provider actually resolved at session start (for example
    // "claude-opus-5-20260401"). They are intentionally allowed to differ:
    // pinning them together would force an identity change on every provider
    // model bump, and would contradict the roadmap law that current model
    // preferences are not permanent. Provider and role segments, by contrast,
    // MUST equal the flat fields, because those carry authority, not routing.
    resolvedModel: z.string().min(1).max(60),
    cliVersion: z.string().min(1).max(60),
    role: WorkerRole,
    capabilities: z.array(z.string().min(1).max(80)).max(50),
    accountId: z.string().min(1).max(80),

    permissions: z.strictObject({
      canWrite: z.boolean(),
      canCommit: z.boolean(),
      /** Structural law. No slot may ever push. */
      canPush: z.literal(false),
    }),

    quota: z.strictObject({
      remainingRatio: z.number().min(0).max(1).nullable(),
      estimatedTokensRemaining: z.number().int().nonnegative().nullable(),
      resetsAt: Timestamp.nullable(),
    }),

    reservation: z
      .strictObject({
        taskId: Uuid,
        reservedAt: Timestamp,
        reservedTokens: z.number().int().nonnegative(),
      })
      .nullable(),

    lease: Lease.nullable(),
    healthProbe: HealthProbe,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });

    const parsed = WORKER_IDENTITY_PATTERN.exec(value.identity);
    if (parsed !== null) {
      if (parsed[1] !== value.provider) {
        ctx.addIssue({
          code: "custom",
          message: "identity provider segment must equal the provider field",
          path: ["provider"],
        });
      }
      if (parsed[3] !== value.role) {
        ctx.addIssue({
          code: "custom",
          message: "identity role segment must equal the role field",
          path: ["role"],
        });
      }
    }

    // The auditor is structurally read-only, not read-only by convention.
    if (value.role === "reviewer" && (value.permissions.canWrite || value.permissions.canCommit)) {
      ctx.addIssue({
        code: "custom",
        message: "a reviewer slot must be structurally read-only",
        path: ["permissions"],
      });
    }

    if (value.permissions.canCommit && !value.permissions.canWrite) {
      ctx.addIssue({
        code: "custom",
        message: "a slot that cannot write may not commit",
        path: ["permissions", "canCommit"],
      });
    }

    if (value.lease !== null && value.lease.holder !== value.identity) {
      ctx.addIssue({
        code: "custom",
        message: "a lease held by another identity may not be attached to this slot",
        path: ["lease", "holder"],
      });
    }
  });
export type WorkerSlot = z.infer<typeof WorkerSlot>;

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export const Checkpoint = z
  .strictObject({
    contractVersion: ContractVersion,
    checkpointId: Uuid,
    taskId: Uuid,
    attempt: z.number().int().positive().max(10_000),
    worker: WorkerIdentityString,
    createdAt: Timestamp,

    /** The last atomic step that actually completed. Never a partial step. */
    lastAtomicStep: z.strictObject({
      index: z.number().int().nonnegative().max(10_000),
      label: z.string().min(1).max(200),
      completedAt: Timestamp,
    }),

    git: z.strictObject({
      head: GitCommitSha,
      branch: z.string().min(1).max(200),
      worktreePath: AbsolutePath,
      isDirty: z.boolean(),
    }),

    authorityDigest: z.array(PathDigest).max(1_000),
    readSetDigest: z.array(PathDigest).max(1_000),
    writeSetDigest: z.array(PathDigest).max(500),

    receipts: z.array(ArtifactRef).max(50),
    artifacts: z.array(ArtifactRef).max(100),

    pendingWork: z.array(z.string().min(1).max(400)).max(100),
    /** Exactly one next safe action. Recovery resumes from here. */
    nextSafeAction: z.string().min(1).max(1_000),
    notes: z.string().max(2_000).nullable(),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const size = serializedByteLength(value);
    if (size > CHECKPOINT_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message:
          "checkpoint is " +
          String(size) +
          " bytes which exceeds the " +
          String(CHECKPOINT_MAX_BYTES) +
          " byte budget; carry digests and artifact references, not content",
        path: [],
      });
    }
  });
export type Checkpoint = z.infer<typeof Checkpoint>;

// ---------------------------------------------------------------------------
// ControlPlaneEvent
// ---------------------------------------------------------------------------

export const CONTROL_PLANE_EVENT_TYPES = [
  "TASK_DISCOVERED",
  "TASK_CLASSIFIED",
  "TASK_READY",
  "SLOT_RESERVED",
  "RUN_STARTED",
  "ATOMIC_STEP_COMPLETED",
  "CHECKPOINT_WRITTEN",
  "VERIFICATION_COMPLETED",
  "AUDIT_COMPLETED",
  "COMMIT_AUTHORIZED",
  "COMMIT_RECORDED",
  "LEASE_ACQUIRED",
  "LEASE_REVOKED",
  "WRITE_SET_VIOLATION_DETECTED",
  "QUOTA_WARNING",
  "ACCOUNT_SWITCH_STARTED",
  "ACCOUNT_SWITCH_COMPLETED",
  "AUTH_REQUIRED_RAISED",
  "TASK_STATE_CHANGED",
  "TASK_FAILED",
  "TASK_CANCELLED",
] as const;

export const ControlPlaneEventType = z.enum(CONTROL_PLANE_EVENT_TYPES);
export type ControlPlaneEventType = z.infer<typeof ControlPlaneEventType>;

/**
 * The idempotency coordinates of a ledger append.
 *
 * (taskId, attempt, transitionId) is the natural key. The derived
 * idempotencyKey is what the ledger enforces uniqueness on, so a replayed
 * durable step appends nothing rather than duplicating state.
 */
export const IdempotencyCoordinates = z.strictObject({
  taskId: Uuid,
  attempt: z.number().int().positive().max(10_000),
  transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});
export type IdempotencyCoordinates = z.infer<typeof IdempotencyCoordinates>;

export function buildIdempotencyKey(coordinates: IdempotencyCoordinates): string {
  return (
    coordinates.taskId + "/" + String(coordinates.attempt) + "/" + coordinates.transitionId
  );
}

export const ControlPlaneEvent = z
  .strictObject({
    contractVersion: ContractVersion,
    eventId: Uuid,

    taskId: Uuid,
    attempt: z.number().int().positive().max(10_000),
    transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    /** Must equal taskId/attempt/transitionId. The ledger uniques on this. */
    idempotencyKey: z.string().min(1).max(300),

    type: ControlPlaneEventType,
    fromState: TaskState.nullable(),
    toState: TaskState,

    emittedBy: WorkerIdentityString,
    occurredAt: Timestamp,
    recordedAt: Timestamp,

    correlationId: Uuid.nullable(),
    causationId: Uuid.nullable(),

    /** Bounded structured payload. Never a provider transcript. */
    payload: z.record(z.string().max(80), z.unknown()),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const expected = buildIdempotencyKey({
      taskId: value.taskId,
      attempt: value.attempt,
      transitionId: value.transitionId,
    });
    if (value.idempotencyKey !== expected) {
      ctx.addIssue({
        code: "custom",
        message: "idempotencyKey must be exactly taskId/attempt/transitionId",
        path: ["idempotencyKey"],
      });
    }

    if (value.fromState === value.toState && value.type === "TASK_STATE_CHANGED") {
      ctx.addIssue({
        code: "custom",
        message: "a state change event must actually change state",
        path: ["toState"],
      });
    }

    const size = serializedByteLength(value.payload);
    if (size > EVENT_PAYLOAD_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message:
          "event payload is " +
          String(size) +
          " bytes which exceeds the " +
          String(EVENT_PAYLOAD_MAX_BYTES) +
          " byte budget",
        path: ["payload"],
      });
    }
  });
export type ControlPlaneEvent = z.infer<typeof ControlPlaneEvent>;

// ---------------------------------------------------------------------------
// CommitAuthorizationReceipt
// ---------------------------------------------------------------------------

export const CommitAuthorizationReceipt = z
  .strictObject({
    contractVersion: ContractVersion,
    receiptId: Uuid,
    taskId: Uuid,
    attempt: z.number().int().positive().max(10_000),

    /** The writer that produced the diff. */
    writer: WorkerIdentityString,
    /** The independent verifier that ran the checks. Never the writer. */
    verifier: WorkerIdentityString,
    /** The authority that adjudicated the packet. */
    authorizedBy: WorkerIdentityString,
    authorizedAt: Timestamp,

    worktreePath: AbsolutePath,
    branch: z.string().min(1).max(200),
    /**
     * The commit the authorized change is based on.
     *
     * null is allowed ONLY for the repository initial commit, where no Git HEAD
     * exists yet and there is therefore no base commit to name. Every later
     * receipt must carry a full 40 character object id: once HEAD exists, a
     * missing base would make write-set conformance unverifiable, so the
     * nullable case is a bootstrap exception and not a general escape hatch.
     */
    baseHead: GitCommitSha.nullable(),

    declaredWriteSet: z.array(RepoRelativePath).min(1).max(500),
    observedTrackedChanges: z.array(PathDigest).max(500),
    observedUntrackedPaths: z.array(RepoRelativePath).max(500),

    checks: z
      .array(
        z.strictObject({
          command: z.string().min(1).max(400),
          exitCode: z.number().int().min(0).max(255),
          ranAt: Timestamp,
        }),
      )
      .min(1)
      .max(50),

    commitMessage: z.string().min(1).max(2_000),
    /** Structural law. A receipt can never authorize a push. */
    pushAuthorized: z.literal(false),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });

    if (value.verifier === value.writer) {
      ctx.addIssue({
        code: "custom",
        message: "the verifier must be a different worker than the writer",
        path: ["verifier"],
      });
    }

    const declared = new Set(value.declaredWriteSet);

    for (const [index, change] of value.observedTrackedChanges.entries()) {
      if (!declared.has(change.path)) {
        ctx.addIssue({
          code: "custom",
          message: "tracked change " + change.path + " is outside the declared write-set",
          path: ["observedTrackedChanges", index, "path"],
        });
      }
    }

    for (const [index, path] of value.observedUntrackedPaths.entries()) {
      if (!declared.has(path)) {
        ctx.addIssue({
          code: "custom",
          message: "untracked path " + path + " is outside the declared write-set",
          path: ["observedUntrackedPaths", index],
        });
      }
    }

    if (value.checks.some((check) => check.exitCode !== 0)) {
      ctx.addIssue({
        code: "custom",
        message: "every recorded check must have exited zero before authorization",
        path: ["checks"],
      });
    }
  });
export type CommitAuthorizationReceipt = z.infer<typeof CommitAuthorizationReceipt>;

// ---------------------------------------------------------------------------
// AccountRecord
// ---------------------------------------------------------------------------

export const AccountStatus = z.enum([
  "AVAILABLE",
  "DRAINING",
  "EXHAUSTED",
  "COOLDOWN",
  "AUTH_REQUIRED",
]);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const AuthMode = z.enum([
  "PREAUTHENTICATED_PROFILE",
  "LOCAL_CREDENTIAL_FALLBACK",
  "DEVICE_AUTHORIZATION",
]);
export type AuthMode = z.infer<typeof AuthMode>;

export const ConfidenceLevel = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

/**
 * An opaque local reference. It names where the adapter should look, never
 * what it will find. Inline material is rejected by construction.
 */
export const LocalAuthReference = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(keychain|profile|file):\/\/[A-Za-z0-9._~@-][A-Za-z0-9._~@/-]*$/,
    "reference must be an opaque keychain://, profile:// or file:// locator",
  );
export type LocalAuthReference = z.infer<typeof LocalAuthReference>;

/**
 * Account metadata as it may exist inside the control plane.
 *
 * This is the projection that is allowed in SQLite, the read model and the UI.
 * The owner file at ~/.rottay-agent-control-plane/accounts.local.json stays
 * outside every repository and is never mirrored here in full.
 */
export const AccountRecord = z
  .strictObject({
    contractVersion: ContractVersion,
    accountId: z.string().min(1).max(80),
    provider: z.string().min(1).max(40),
    alias: z.string().min(1).max(80),

    authMode: AuthMode,
    /** Opaque locator for a preauthenticated provider profile. */
    authProfileRef: LocalAuthReference,
    /** Opaque locator used only when an adapter needs the fallback path. */
    credentialRef: LocalAuthReference.nullable(),

    plan: z.string().max(80).nullable(),
    enabledModels: z.array(z.string().min(1).max(60)).max(50),
    knownLimits: z.record(z.string().max(60), z.number().nonnegative()),

    resetSchedule: z.strictObject({
      kind: z.enum(["OBSERVED", "DECLARED", "UNKNOWN"]),
      nextResetAt: Timestamp.nullable(),
      timezone: z.string().min(1).max(60),
      confidence: ConfidenceLevel,
    }),

    quotaEstimate: z.strictObject({
      remainingRatio: z.number().min(0).max(1).nullable(),
      estimatedTokensRemaining: z.number().int().nonnegative().nullable(),
      estimatedAt: Timestamp,
      confidence: ConfidenceLevel,
    }),

    lastHealthProbe: HealthProbe.nullable(),
    lastClassifiedError: z.string().max(200).nullable(),

    status: AccountStatus,
    /** Isolated provider configuration root, so sessions never cross accounts. */
    isolatedConfigRoot: AbsolutePath,
    contextSwitchCost: z.strictObject({
      estimatedTokens: z.number().int().nonnegative().max(10_000_000),
      estimatedSeconds: z.number().int().nonnegative().max(86_400),
    }),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    if (value.authMode === "LOCAL_CREDENTIAL_FALLBACK" && value.credentialRef === null) {
      ctx.addIssue({
        code: "custom",
        message: "the local credential fallback mode requires an opaque credentialRef",
        path: ["credentialRef"],
      });
    }

    if (value.status === "AUTH_REQUIRED" && value.quotaEstimate.remainingRatio !== null) {
      // Fail closed: an account that needs reauthentication has no trustworthy
      // quota reading, so the router must not be handed a stale number.
      ctx.addIssue({
        code: "custom",
        message: "an AUTH_REQUIRED account must not publish a quota estimate",
        path: ["quotaEstimate", "remainingRatio"],
      });
    }
  });
export type AccountRecord = z.infer<typeof AccountRecord>;
