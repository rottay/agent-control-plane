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

export const CONTRACT_VERSION = "2.2.0" as const;

/**
 * The largest roadmap document the plane accepts, in **UTF-8 bytes**.
 *
 * One declaration, one unit (P8-8G R2). It lived in two packages before this,
 * with the same number written twice and a comment in each promising they
 * would not drift — a promise nothing enforced. Worse, the two were measured
 * differently: the store counted bytes and the API schema counted `String`
 * length, which is UTF-16 code units. For ASCII those agree, which is why the
 * gap survived; for any multibyte document they do not, and the surface that
 * accepted a document the store would refuse was the API.
 *
 * **The unit is bytes, and it is the law.** Anything bounding a document
 * against this constant measures UTF-8 bytes, never characters and never code
 * units. `utf8ByteLength` below is the one measurement, so a caller, a schema
 * and a store cannot disagree about what "one megabyte" means.
 */
export const ROADMAP_CONTENT_MAX_BYTES = 1024 * 1024;

/**
 * The UTF-8 byte length of a string, browser-safe.
 *
 * `TextEncoder` rather than `Buffer`: this package is the one every other
 * imports, including the browser client, and a `node:` reference here would
 * make the whole contract surface unloadable in a page. The encoder is a
 * platform global in both runtimes, which is what makes one measurement
 * possible at all.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

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
    /**
     * The initiative this packet belongs to. Required, and the only place the
     * attribution lives: leases bind worktrees, worktrees serve tasks, events
     * carry taskId, so scoping through the task is the one shape that cannot
     * hold two disagreeing copies of the same fact. Isolation here means no
     * data bleed between initiatives — admission and quota stay global, so two
     * initiatives declaring the same conflict key still conflict.
     */
    initiativeId: Uuid,
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
  // Usage attribution. Both are task facts, so they belong to the task stream
  // and are same-state passthroughs: recording what a task spent, or what was
  // reserved for it, moves no lifecycle state. The payload is
  // `{accountId, tokens}` on the WorkerSlot bounds for both — the reservation
  // variant mirrors the usage shape rather than inventing a second one. In P7I
  // only tests append these; the runtime's own emission is a later packet.
  "TOKEN_USAGE_RECORDED",
  "TOKEN_RESERVATION_RECORDED",
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

    /**
     * The causal thread. Definitional, and deliberately not enforced here.
     *
     * `correlationId` groups every event of one run: the producers set it to
     * the invocation's own id, so "this attempt" is selectable without
     * reconstructing it from coordinates.
     *
     * `causationId` names the event this one followed from. Within a walk that
     * is the plan's previous step in the same attempt; across tasks it is the
     * event that genuinely prompted the work, and null everywhere nothing
     * caused anything -- nothing causes a task's discovery.
     *
     * **The ledger does not verify either.** Integrity here means the hash
     * chain: `previousSha256`, `eventSha256`, the idempotency key. A row whose
     * causation names a missing event, or an event in another task, is a valid
     * row. Causation is therefore advisory, and its trustworthiness comes from
     * two guards outside this contract: the producer refuses to append a link
     * whose predecessor is not durably present, and the consumer refuses to
     * draw an edge it cannot resolve. Reading these fields as verified facts
     * about the world would be reading more than the contract promises.
     */
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

// ---------------------------------------------------------------------------
// Durability and supervisor plane
// ---------------------------------------------------------------------------

/**
 * Which engine is advancing the state machine.
 *
 * Both are first-class. The SQLite supervisor is not a degraded fallback: it is
 * the predetermined default if the Restate drills fail, and it drives the same
 * shared core over the same ledger. Because authority never leaves the ledger,
 * the mode changes who advances the machine and nothing else.
 */
export const DRIVER_MODES = ["SQLITE_SUPERVISOR", "RESTATE"] as const;
export const DriverMode = z.enum(DRIVER_MODES);
export type DriverMode = z.infer<typeof DriverMode>;

/**
 * Whether the driver can currently advance work.
 *
 * Deliberately not the same enum as `HealthProbe.status`. That one describes a
 * probe of a worker; this one describes a driver's ability to make progress. A
 * driver that is simply not running is `UNAVAILABLE`, which is a fact about
 * deployment, not the `FAILED` of something that broke.
 */
export const DRIVER_HEALTH_STATES = ["OK", "DEGRADED", "UNAVAILABLE", "UNKNOWN"] as const;
export const DriverHealth = z.enum(DRIVER_HEALTH_STATES);
export type DriverHealth = z.infer<typeof DriverHealth>;

/**
 * A repository-relative, git-ignored data root.
 *
 * Reuses the repository-relative path rules and additionally rejects home
 * directory shorthand. A driver reports the segment it writes under, never the
 * absolute path it resolved: an absolute path names a home directory, a user
 * account and a machine layout, and the observation plane already keeps exactly
 * that out of anything a reader can see.
 */
const IgnoredDataRoot = RepoRelativePath.refine(
  (value) => !value.startsWith("~"),
  "data root must not name a home directory",
);

/**
 * What a driver reports about itself.
 *
 * Every field is either about the driver or about the ledger head the driver
 * last observed. Nothing here is an application fact: a reader learns which
 * engine is running and how far it has seen, never what a task is doing. That
 * separation is what keeps a derived orchestrator from becoming an authority by
 * being convenient to read.
 */
export const DriverStatus = z
  .strictObject({
    contractVersion: ContractVersion,
    mode: DriverMode,
    health: DriverHealth,
    observedAt: Timestamp,

    /** The ledger head this driver last observed. Zero on an empty ledger. */
    ledgerHeadSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ledgerHeadSha256: Sha256Hex,

    /** Repository-relative segment. Never an absolute path. */
    dataRoot: IgnoredDataRoot,

    /** When this mode became active, if the driver knows. */
    activeSince: Timestamp.nullable(),
    detail: z.string().max(500).nullable(),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    if (value.health !== "OK" && value.detail === null) {
      ctx.addIssue({
        code: "custom",
        message: "a driver that is not OK must say why",
        path: ["detail"],
      });
    }
    if (value.health === "UNAVAILABLE" && value.activeSince !== null) {
      ctx.addIssue({
        code: "custom",
        message: "an unavailable driver is not active and may not claim a start time",
        path: ["activeSince"],
      });
    }
  });
export type DriverStatus = z.infer<typeof DriverStatus>;

/**
 * The classification of a driver's view against the ledger.
 *
 * Fail-closed by construction: exactly two verdicts permit resuming, and both
 * of them are cases where the ledger fully explains the driver's state.
 *
 * - `CONSISTENT`: the driver agrees with the ledger head.
 * - `DRIVER_BEHIND`: the driver has seen less than the ledger. Replay closes
 *   it, because the ledger is a superset of what the driver knows.
 * - `DRIVER_AHEAD`: the driver claims a fact the ledger has no record of. This
 *   is the authority violation the whole design exists to prevent, and it halts.
 * - `DIVERGED`: driver and ledger disagree about the same coordinate. Halts.
 * - `INDETERMINATE`: the comparison could not be completed. Halts, because an
 *   unanswered question is not a negative answer.
 */
export const RECONCILIATION_VERDICTS = [
  "CONSISTENT",
  "DRIVER_BEHIND",
  "DRIVER_AHEAD",
  "DIVERGED",
  "INDETERMINATE",
] as const;
export const ReconciliationVerdict = z.enum(RECONCILIATION_VERDICTS);
export type ReconciliationVerdict = z.infer<typeof ReconciliationVerdict>;

/** The verdicts from which work may continue. Every other verdict halts. */
export const RESUMABLE_VERDICTS: readonly ReconciliationVerdict[] = [
  "CONSISTENT",
  "DRIVER_BEHIND",
];

const ReconciliationDiscrepancy = z.strictObject({
  /** Coordinates only. Never event content and never a payload value. */
  taskId: Uuid,
  attempt: z.number().int().positive().max(10_000),
  transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  /** Bounded, redacted description. Digests and coordinates, not content. */
  detail: z.string().min(1).max(300),
});
export type ReconciliationDiscrepancy = z.infer<typeof ReconciliationDiscrepancy>;

/**
 * The result of comparing a driver against the ledger.
 *
 * Two structural laws are encoded rather than documented. The report must name
 * the ledger head it was computed against, so a stale comparison cannot pass as
 * a fresh one; and `resolvedByLedger` is a literal `true`, so no report can
 * ever describe a reconciliation that went the other way.
 */
export const ReconciliationReport = z
  .strictObject({
    contractVersion: ContractVersion,
    reportId: Uuid,
    mode: DriverMode,
    verdict: ReconciliationVerdict,
    observedAt: Timestamp,

    /** The head the comparison was computed against. Ledger-headed by shape. */
    ledgerHeadSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ledgerHeadSha256: Sha256Hex,

    /** Structural law. The ledger wins; there is no other resolution. */
    resolvedByLedger: z.literal(true),

    /** False for every verdict the ledger cannot fully explain. */
    safeToResume: z.boolean(),

    discrepancies: z.array(ReconciliationDiscrepancy).max(200),
    detail: z.string().max(500).nullable(),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const resumable = (RESUMABLE_VERDICTS as readonly string[]).includes(value.verdict);
    if (value.safeToResume !== resumable) {
      ctx.addIssue({
        code: "custom",
        message:
          "safeToResume must be true for exactly " +
          RESUMABLE_VERDICTS.join(" and ") +
          "; every other verdict halts",
        path: ["safeToResume"],
      });
    }

    if (value.verdict === "CONSISTENT" && value.discrepancies.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "a consistent reconciliation cannot carry discrepancies",
        path: ["discrepancies"],
      });
    }

    if (value.verdict !== "CONSISTENT" && value.detail === null) {
      ctx.addIssue({
        code: "custom",
        message: "any verdict other than CONSISTENT must say why",
        path: ["detail"],
      });
    }

    if (
      (value.verdict === "DRIVER_AHEAD" || value.verdict === "DIVERGED") &&
      value.discrepancies.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a halting verdict must name at least one discrepancy",
        path: ["discrepancies"],
      });
    }
  });
export type ReconciliationReport = z.infer<typeof ReconciliationReport>;

// ---------------------------------------------------------------------------
// Initiatives and the versioned roadmap
// ---------------------------------------------------------------------------

/**
 * The lifecycle of an initiative, closed like every other vocabulary here.
 *
 * An initiative is the unit of work a task is scoped to. The ACP's own roadmap
 * is one of these, registered like any other — a reserved, well-known
 * initiative rather than a special case in the schema.
 */
export const INITIATIVE_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"] as const;

export const InitiativeStatus = z.enum(INITIATIVE_STATUSES);
export type InitiativeStatus = z.infer<typeof InitiativeStatus>;

/**
 * A stable, human-readable handle. Lowercase so two initiatives cannot differ
 * only by case, and bounded like every other identifier in this file.
 */
const InitiativeSlug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "expected a lowercase kebab-case slug");

export const Initiative = z
  .strictObject({
    contractVersion: ContractVersion,
    initiativeId: Uuid,
    slug: InitiativeSlug,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(4_000),
    status: InitiativeStatus,
    createdAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });
  });
export type Initiative = z.infer<typeof Initiative>;

export const ROADMAP_VERSION_KINDS = ["EDIT", "ROLLBACK"] as const;

export const RoadmapVersionKind = z.enum(ROADMAP_VERSION_KINDS);
export type RoadmapVersionKind = z.infer<typeof RoadmapVersionKind>;

/**
 * One immutable version of an initiative's roadmap.
 *
 * `contentDigest` is a digest and nothing else. The bytes it names live
 * outside the ledger, reached by artifact reference: the Checkpoint law is
 * that a record carries digests and references rather than content, and the
 * event payload budget makes roadmap bytes unstorable in an event anyway.
 *
 * A rollback is a new version, never a rewrite of history — `kind:
 * "ROLLBACK"` with `restoresVersionId` naming the version whose bytes are
 * being restored. Append-only holds all the way down.
 *
 * What this schema enforces is what a single value can prove about itself:
 * the bootstrap exceptions and the kind/restore coherence. The laws that need
 * the folded head — that `version` is the head's successor, that
 * `parentVersionId` is the head's id, that a rollback's digest equals the
 * digest of the version it restores, and the refusal vocabulary that names
 * each failure — belong to the decision module beside the fold, not here.
 */
export const RoadmapVersion = z
  .strictObject({
    contractVersion: ContractVersion,
    roadmapVersionId: Uuid,
    initiativeId: Uuid,
    version: z.number().int().positive().max(1_000_000),
    /** sha256 of the canonical roadmap bytes. Digest only, never content. */
    contentDigest: Sha256Hex,
    /** The version this one succeeds. Null exactly at the bootstrap. */
    parentVersionId: Uuid.nullable(),
    /** The head the writer believed it was appending to. Null at the bootstrap. */
    expectedHeadDigest: Sha256Hex.nullable(),
    kind: RoadmapVersionKind,
    /** The version a rollback restores. Null exactly when the kind is EDIT. */
    restoresVersionId: Uuid.nullable(),
    recordedBy: WorkerIdentityString,
    recordedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    // The bootstrap exception is a biconditional in both directions. Version 1
    // has no predecessor, so a parent or a head claim there is a lie; every
    // later version has one, and a null claim there is unconditional-overwrite
    // semantics wearing a bootstrap's clothes.
    if ((value.parentVersionId === null) !== (value.version === 1)) {
      ctx.addIssue({
        code: "custom",
        message: "parentVersionId must be null for version 1 and set for every later version",
        path: ["parentVersionId"],
      });
    }

    if ((value.expectedHeadDigest === null) !== (value.version === 1)) {
      ctx.addIssue({
        code: "custom",
        message: "expectedHeadDigest must be null for version 1 and set for every later version",
        path: ["expectedHeadDigest"],
      });
    }

    if ((value.restoresVersionId === null) !== (value.kind === "EDIT")) {
      ctx.addIssue({
        code: "custom",
        message: "restoresVersionId must be null for an EDIT and set for a ROLLBACK",
        path: ["restoresVersionId"],
      });
    }
  });
export type RoadmapVersion = z.infer<typeof RoadmapVersion>;

/**
 * The initiative stream's vocabulary, closed at three names.
 *
 * `ROADMAP_VERSION_RECORDED` **is** the receipt for a recorded version, the
 * way `COMMIT_RECORDED` is the receipt for a commit. A separate receipt type
 * would record the same fact twice.
 */
export const INITIATIVE_EVENT_TYPES = [
  "INITIATIVE_REGISTERED",
  "INITIATIVE_STATE_CHANGED",
  "ROADMAP_VERSION_RECORDED",
] as const;

export const InitiativeEventType = z.enum(INITIATIVE_EVENT_TYPES);
export type InitiativeEventType = z.infer<typeof InitiativeEventType>;

/**
 * The idempotency coordinates of an initiative-stream append.
 *
 * There is no attempt number: a registration is not retried the way a task
 * step is, so the key fixes the attempt segment at 1 rather than carrying a
 * counter nothing would increment. The coordinates are their own type rather
 * than reusing the task's, because putting an initiative id in a field named
 * `taskId` would make the name lie.
 */
export const InitiativeIdempotencyCoordinates = z.strictObject({
  initiativeId: Uuid,
  transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});
export type InitiativeIdempotencyCoordinates = z.infer<typeof InitiativeIdempotencyCoordinates>;

export function buildInitiativeIdempotencyKey(
  coordinates: InitiativeIdempotencyCoordinates,
): string {
  return coordinates.initiativeId + "/1/" + coordinates.transitionId;
}

/**
 * An event in the initiative stream — a sibling of `ControlPlaneEvent`, under
 * the same laws, in the same ledger, on its own chain.
 *
 * It is a separate contract rather than three more names in the task
 * vocabulary because an initiative registration has no task and no
 * `TaskState`, and the task stream's storage requires both. Forcing it in
 * would mean either a column that cannot be null being null, or an
 * initiative id living in a field named `taskId`.
 */
/**
 * What an operator may do to an account (P8-8G packet 2).
 *
 * Four verbs, closed. Three name an intent whose resulting state is a fact
 * about the verb rather than a parameter — draining an account puts it in
 * `DRAINING` and nothing else — and the fourth exists because an operator
 * sometimes knows something the vocabulary does not, and needs to say the
 * state outright rather than pick the nearest verb and hope.
 */
export const ACCOUNT_ACTIONS = ["DRAIN", "ACCOUNT_READY", "REAUTH_REQUIRED", "OWNER_OVERRIDE"] as const;
export const AccountAction = z.enum(ACCOUNT_ACTIONS);
export type AccountAction = z.infer<typeof AccountAction>;

/**
 * The state each verb produces, as a frozen fact rather than a branch.
 *
 * A table, so the mapping is one thing a reader can check against the
 * vocabulary above rather than a switch spread across a decision function.
 * `OWNER_OVERRIDE` is `null` here precisely because it is the one verb whose
 * resulting state is not implied by the verb — it comes from the request's
 * own `setState`, and the schema below refuses the two mismatched shapes:
 * an override without a state, and a non-override that supplies one.
 */
export const ACCOUNT_ACTION_STATE: Readonly<Record<AccountAction, AccountStatus | null>> =
  Object.freeze({
    DRAIN: "DRAINING",
    ACCOUNT_READY: "AVAILABLE",
    REAUTH_REQUIRED: "AUTH_REQUIRED",
    OWNER_OVERRIDE: null,
  });

/** The largest note an operator may attach. A reason, not a document. */
export const ACCOUNT_ACTION_NOTE_MAX = 500;

/**
 * One recorded operator action against one account.
 *
 * A sibling of `InitiativeEvent` and deliberately shaped like it: the same
 * envelope, the same idempotency law, the same guards. What differs is the
 * subject — an account rather than an initiative — and that the resulting
 * state is derived from the action rather than claimed independently, which is
 * what stops a caller recording "I drained it" beside "it is now AVAILABLE".
 *
 * `note` is the only free text this event carries, and it rides the standing
 * content guards: an operator explaining why they drained an account must not
 * be the way a credential reaches the ledger.
 */
export const AccountActionEvent = z
  .strictObject({
    contractVersion: ContractVersion,
    eventId: Uuid,

    accountId: z.string().min(1).max(80),
    /** Monotone per account, assigned by the seam from the folded history. */
    version: z.number().int().positive(),
    /** Must equal accountId/1/action.<version>. The ledger uniques on this. */
    idempotencyKey: z.string().min(1).max(300),

    action: AccountAction,
    /** The state this action put the account into. Derived, never claimed. */
    resultingState: AccountStatus,

    actor: WorkerIdentityString,
    note: z.string().max(ACCOUNT_ACTION_NOTE_MAX).nullable(),
    occurredAt: Timestamp,
    recordedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const expected =
      value.accountId + "/1/action." + String(value.version);
    if (value.idempotencyKey !== expected) {
      ctx.addIssue({
        code: "custom",
        message: "idempotencyKey must be exactly accountId/1/action.<version>",
        path: ["idempotencyKey"],
      });
    }

    // The verb governs the state, except for the one verb that does not.
    const implied = ACCOUNT_ACTION_STATE[value.action];
    if (implied !== null && value.resultingState !== implied) {
      ctx.addIssue({
        code: "custom",
        message:
          "action " + value.action + " always results in " + implied + ", never " + value.resultingState,
        path: ["resultingState"],
      });
    }
  });
export type AccountActionEvent = z.infer<typeof AccountActionEvent>;

/** One account's action history entry, as the ledger projects it. */
export const AccountActionRecord = z
  .strictObject({
    sequence: z.number().int().positive(),
    eventId: Uuid,
    accountId: z.string().min(1).max(80),
    version: z.number().int().positive(),
    action: AccountAction,
    resultingState: AccountStatus,
    actor: WorkerIdentityString,
    note: z.string().max(ACCOUNT_ACTION_NOTE_MAX).nullable(),
    occurredAt: Timestamp,
    recordedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });
  });
export type AccountActionRecord = z.infer<typeof AccountActionRecord>;

export const InitiativeEvent = z
  .strictObject({
    contractVersion: ContractVersion,
    eventId: Uuid,

    initiativeId: Uuid,
    transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    /** Must equal initiativeId/1/transitionId. The ledger uniques on this. */
    idempotencyKey: z.string().min(1).max(300),

    type: InitiativeEventType,
    fromStatus: InitiativeStatus.nullable(),
    toStatus: InitiativeStatus,

    emittedBy: WorkerIdentityString,
    occurredAt: Timestamp,
    recordedAt: Timestamp,

    /** Bounded structured payload. Never a provider transcript. */
    payload: z.record(z.string().max(80), z.unknown()),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const expected = buildInitiativeIdempotencyKey({
      initiativeId: value.initiativeId,
      transitionId: value.transitionId,
    });
    if (value.idempotencyKey !== expected) {
      ctx.addIssue({
        code: "custom",
        message: "idempotencyKey must be exactly initiativeId/1/transitionId",
        path: ["idempotencyKey"],
      });
    }

    // Registration is the one event with no prior status, and the only one:
    // every later event is a transition from something.
    if ((value.fromStatus === null) !== (value.type === "INITIATIVE_REGISTERED")) {
      ctx.addIssue({
        code: "custom",
        message: "fromStatus must be null for INITIATIVE_REGISTERED and set for every other type",
        path: ["fromStatus"],
      });
    }

    // The task law, mirrored: a change event must change something, and a
    // passthrough must not pretend to.
    if (value.type === "INITIATIVE_STATE_CHANGED" && value.fromStatus === value.toStatus) {
      ctx.addIssue({
        code: "custom",
        message: "a status change event must actually change status",
        path: ["toStatus"],
      });
    }

    if (value.type === "ROADMAP_VERSION_RECORDED" && value.fromStatus !== value.toStatus) {
      ctx.addIssue({
        code: "custom",
        message: "recording a roadmap version does not move the initiative's status",
        path: ["toStatus"],
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
export type InitiativeEvent = z.infer<typeof InitiativeEvent>;

// ---------------------------------------------------------------------------
// The owned execution boundary
// ---------------------------------------------------------------------------

/**
 * How a route reaches a model.
 *
 * Closed at three, in the owner ruling's own order: the subscription-backed
 * CLI transports the control plane runs on today, provider API calls, and the
 * local or OpenAI-compatible transports that come later. A fourth kind is a
 * contract change, not a configuration value.
 */
export const TRANSPORT_KINDS = ["CLI_SUBSCRIPTION", "API_KEY", "LOCAL_OR_SELF_HOSTED"] as const;

export const TransportKind = z.enum(TRANSPORT_KINDS);
export type TransportKind = z.infer<typeof TransportKind>;

/**
 * The providers a `CLI_SUBSCRIPTION` route may name.
 *
 * Declared here because this package imports nothing from `@acp/*` and every
 * other package imports it: one list, one home, no drift between the router's
 * idea of a provider and an adapter's. The adapters' own `ProviderName` is
 * re-pointed at this vocabulary in the packet that binds them, which is the
 * only lawful direction — adapters already depend on contracts.
 *
 * Sorted, and pinned as a list by a test rather than by membership, so a name
 * cannot be added or dropped without the pin moving.
 */
export const CLI_SUBSCRIPTION_PROVIDERS = ["claude", "codex", "kimi"] as const;

/**
 * Why an execution boundary refused a route.
 *
 * Closed and sorted, like every other refusal vocabulary here. A refusal is
 * the only lawful answer to a route the transport cannot serve: the port never
 * reroutes, never substitutes a model and never invents a fallback, so every
 * way of saying "not this one" has to be a name the caller can exhaust.
 */
export const EXECUTION_REFUSALS = [
  "CAPABILITY_UNSUPPORTED",
  "REATTACH_UNAVAILABLE",
  "ROUTE_INVALID",
  "TRANSPORT_UNAVAILABLE",
] as const;

export const ExecutionRefusal = z.enum(EXECUTION_REFUSALS);
export type ExecutionRefusal = z.infer<typeof ExecutionRefusal>;

/**
 * A resolved route: provider, model, account, transport and the policy version
 * that chose them.
 *
 * The route is **final**. An adapter executes exactly this and nothing else —
 * it does not default a missing field, pick a neighbouring model when the named
 * one is busy, or quietly downgrade a transport. `capabilityPolicyVersion`
 * records which generation of the capability registry produced the choice, so
 * a route can be explained after the fact without re-running the router.
 */
export const ResolvedRoute = z
  .strictObject({
    provider: z.string().min(1).max(40),
    /** The routing alias the DT scheduled against, not the provider's exact resolution. */
    model: z.string().min(1).max(60),
    accountId: z.string().min(1).max(80),
    transportKind: TransportKind,
    capabilityPolicyVersion: z.string().min(1).max(80),
    resolvedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    // A CLI route names one of the CLI providers. Other transport kinds carry
    // an opaque provider segment, because a local or API-backed transport may
    // legitimately name something this list has never heard of.
    if (
      value.transportKind === "CLI_SUBSCRIPTION" &&
      !(CLI_SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value.provider)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a CLI_SUBSCRIPTION route must name one of the CLI subscription providers",
        path: ["provider"],
      });
    }
  });
export type ResolvedRoute = z.infer<typeof ResolvedRoute>;

/**
 * What a running execution said, normalized.
 *
 * This is the transport-neutral superset of the landed provider signal and no
 * richer: every variant is either a signal an adapter already emits or the
 * minimum a non-CLI transport needs to say the same things. A provider utterance
 * this union cannot express is a STOP escalated to the DT, never a reason to
 * widen it quietly.
 *
 * `started` carries the echoed route **and** the provider's own resolution.
 * They are deliberately both present: `route.model` is the alias the router
 * chose, `resolvedModel` is what the provider actually bound, and comparing
 * them is the evidence that no adapter silently substituted a model.
 */
export const ExecutionEvent = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("started"),
    route: ResolvedRoute,
    /** The provider's exact resolution of `route.model`. */
    resolvedModel: z.string().min(1).max(120),
    protocolVersion: z.string().min(1).max(40),
  }),
  z.strictObject({
    kind: z.literal("text"),
    /** One delta, as it arrived. Never an accumulated transcript. */
    delta: z.string().max(16_384),
  }),
  z.strictObject({
    kind: z.literal("toolUse"),
    tool: z.string().min(1).max(80),
    /** Bounded, structured, and never the tool's whole output. */
    detail: z.string().max(2_000),
  }),
  /**
   * A write-class action, normalized. Safety-critical: the enforcement plane
   * depends on seeing writes at this boundary, and the landed signal documents
   * it fatal for a reviewer identity.
   */
  z.strictObject({
    kind: z.literal("write"),
    target: RepoRelativePath,
  }),
  /** The session machine's transition, as the transport reports it. */
  z.strictObject({
    kind: z.literal("state"),
    toState: z.string().min(1).max(40),
  }),
  z.strictObject({
    kind: z.literal("usage"),
    /** Step ordering is carried, so usage can be folded in the order it happened. */
    stepIndex: z.number().int().nonnegative().max(100_000),
    tokensUsed: z.number().int().nonnegative().max(100_000_000),
  }),
  z.strictObject({
    kind: z.literal("checkpoint"),
    digest: Sha256Hex,
  }),
  z.strictObject({
    kind: z.literal("authRequired"),
    reason: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("error"),
    /** Classified, never a raw provider message. */
    refusal: ExecutionRefusal,
    detail: z.string().max(400),
  }),
  z.strictObject({
    kind: z.literal("completed"),
    /** The last step the transport reported, for reconciliation against usage. */
    stepIndex: z.number().int().nonnegative().max(100_000),
  }),
]);
export type ExecutionEvent = z.infer<typeof ExecutionEvent>;

/**
 * What the caller hands the port besides the route.
 *
 * Task coordinates, the identity the work is attributed to, and — optionally —
 * a reference to an execution already in flight. Transport-specific budgets,
 * binaries and working directories are not here: those belong to the adapter
 * that owns the transport, and putting them in the owned boundary would make
 * this contract change every time a transport did.
 */
export const ExecutionRequest = z.strictObject({
  taskId: Uuid,
  attempt: z.number().int().positive().max(10_000),
  identity: WorkerIdentityString,
  /**
   * An execution to rejoin rather than start. Null is the ordinary case.
   *
   * A transport that cannot honor the reference **refuses**, classified as
   * `REATTACH_UNAVAILABLE`; it never silently starts a fresh execution in its
   * place. Reconnection is exactly where a silent restart would be most
   * expensive and least visible, so the no-silent-fallback law is stated here
   * rather than assumed.
   */
  reattach: z.string().min(1).max(200).nullable(),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequest>;

/** A refusal from the boundary, carrying a closed reason and where it failed. */
export interface ExecutionRefused {
  readonly ok: false;
  readonly refusal: ExecutionRefusal;
  /** The field or capability that failed. Never provider output. */
  readonly at: string;
}

/**
 * A live execution, as the boundary exposes it.
 *
 * The event stream is the only channel: a caller learns what happened by
 * reading normalized events, never by inspecting a transport handle.
 */
export interface ExecutionSession {
  readonly ok: true;
  /** Stable for the life of the execution; the value a later `reattach` names. */
  readonly sessionId: string;
  readonly route: ResolvedRoute;
  events(): AsyncIterable<ExecutionEvent>;
}

/**
 * The owned execution boundary.
 *
 * Every transport — subscription CLI, provider API, local model — implements
 * this and nothing wider. The laws it exists to hold:
 *
 * 1. **The route is executed, not interpreted.** `start` runs exactly the
 *    provider, model, account and transport the route names. It never selects
 *    a model, never retries onto another route, and never invents a fallback.
 *    A route it cannot serve is an `ExecutionRefused` with a closed reason.
 * 2. **Events are normalized at the boundary.** What crosses is
 *    `ExecutionEvent`, identical in shape whichever transport produced it, so
 *    the control plane's routing, evidence and recovery never learn a
 *    transport's dialect.
 * 3. **Reattachment is explicit or refused.** `request.reattach` either
 *    rejoins that execution or produces `REATTACH_UNAVAILABLE`. Starting fresh
 *    while a caller believes it reattached is the one failure this boundary
 *    must never produce silently.
 * 4. **The port holds no authority.** Routing, role selection, account and
 *    quota policy, leases, conflict detection, checkpoints and evidence stay
 *    with the control plane. A transport adapter is a mouth, not a mind.
 */
export interface ModelExecutionPort {
  /** Begin, or rejoin, an execution on exactly this route. */
  start(route: ResolvedRoute, request: ExecutionRequest): Promise<ExecutionSession | ExecutionRefused>;
  /** Ask a running execution to stop. Idempotent; never kills a foreign process. */
  interrupt(sessionId: string): Promise<void>;
  /** Read-only reachability, for the transport this port serves. */
  healthProbe(route: ResolvedRoute): Promise<HealthProbe>;
}
