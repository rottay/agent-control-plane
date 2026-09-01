import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ACTIONS,
  ACCOUNT_ACTION_NOTE_MAX,
  ACCOUNT_ACTION_STATE,
  AccountActionEvent,
  ROADMAP_CONTENT_MAX_BYTES,
  utf8ByteLength,
  AccountRecord,
  CHECKPOINT_MAX_BYTES,
  CONTRACT_VERSION,
  CONTROL_PLANE_EVENT_TYPES,
  Checkpoint,
  CommitAuthorizationReceipt,
  ControlPlaneEvent,
  DRIVER_HEALTH_STATES,
  DRIVER_MODES,
  DriverHealth,
  DriverMode,
  DriverStatus,
  EVENT_PAYLOAD_MAX_BYTES,
  EXCEPTIONAL_STATES,
  INITIATIVE_EVENT_TYPES,
  INITIATIVE_STATUSES,
  Initiative,
  InitiativeEvent,
  LIFECYCLE_STATES,
  ROADMAP_VERSION_KINDS,
  RECONCILIATION_VERDICTS,
  RoadmapVersion,
  CLI_SUBSCRIPTION_PROVIDERS,
  EXECUTION_REFUSALS,
  ExecutionEvent,
  ExecutionRequest,
  ResolvedRoute,
  TRANSPORT_KINDS,
  RESUMABLE_VERDICTS,
  ReconciliationReport,
  ReconciliationVerdict,
  TaskEnvelope,
  WORKER_ROLES,
  WorkerIdentityString,
  WorkerSlot,
  buildIdempotencyKey,
  buildInitiativeIdempotencyKey,
  findCredentialViolations,
  findTranscriptViolations,
  formatWorkerIdentity,
  isExceptionalState,
  isLifecycleState,
  parseWorkerIdentity,
  serializedByteLength,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const INITIATIVE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_INITIATIVE_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";
const AT = "2026-08-27T12:00:00.000Z";
const SHA256 = "a".repeat(64);
const GIT_SHA = "b".repeat(40);

const WRITER = "claude/opus/implementer/01";
const VERIFIER = "claude/sonnet/verifier/01";
const AUTHORITY = "kimi/k3/coordinator/01";
const REVIEWER = "claude/fable/reviewer/01";

function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: TASK_ID,
    initiativeId: INITIATIVE_ID,
    title: "P0 bootstrap",
    objective: "Freeze the runtime contracts and the mechanical git fence.",
    classification: "ARCHITECTURAL",
    issuedBy: AUTHORITY,
    issuedAt: AT,
    authority: [{ path: "docs/ROADMAP.md", sha256: SHA256 }],
    readSet: ["docs/ROADMAP.md"],
    writeSet: ["packages/contracts/src/schemas.ts"],
    conflictKeys: ["packages/contracts"],
    allowedCommands: ["pnpm check"],
    forbiddenActions: ["git push", "git restore"],
    output: { kind: "DIFF", description: "contracts module" },
    validation: { commands: ["pnpm check"], independentVerifierRequired: true },
    eligibility: {
      roles: ["implementer"],
      providers: null,
      requiredCapabilities: ["typescript"],
    },
    budget: {
      maxTokens: 200_000,
      maxWallClockSeconds: 3_600,
      reserveTokensForCheckpoint: 20_000,
    },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 1 },
    ...overrides,
  };
}

function slot(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: CONTRACT_VERSION,
    slotId: OTHER_ID,
    identity: WRITER,
    provider: "claude",
    resolvedModel: "opus",
    cliVersion: "1.2.3",
    role: "implementer",
    capabilities: ["typescript"],
    accountId: "acct-primary",
    permissions: { canWrite: true, canCommit: true, canPush: false },
    quota: { remainingRatio: 0.5, estimatedTokensRemaining: 100, resetsAt: AT },
    reservation: null,
    lease: null,
    healthProbe: {
      status: "OK",
      checkedAt: AT,
      latencyMs: 42,
      classifiedError: null,
    },
    ...overrides,
  };
}

function checkpoint(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: CONTRACT_VERSION,
    checkpointId: OTHER_ID,
    taskId: TASK_ID,
    attempt: 1,
    worker: WRITER,
    createdAt: AT,
    lastAtomicStep: { index: 3, label: "contracts written", completedAt: AT },
    git: {
      head: GIT_SHA,
      branch: "main",
      worktreePath: "/Users/daniel/Developer/Rottay/agent-control-plane",
      isDirty: true,
    },
    authorityDigest: [{ path: "docs/ROADMAP.md", sha256: SHA256 }],
    readSetDigest: [],
    writeSetDigest: [{ path: "packages/contracts/src/schemas.ts", sha256: SHA256 }],
    receipts: [],
    artifacts: [],
    pendingWork: ["write the architecture fence"],
    nextSafeAction: "run pnpm check and record exit codes",
    notes: null,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}): unknown {
  const base = {
    contractVersion: CONTRACT_VERSION,
    eventId: OTHER_ID,
    taskId: TASK_ID,
    attempt: 1,
    transitionId: "p0.contracts.frozen",
    type: "TASK_STATE_CHANGED",
    fromState: "RUNNING",
    toState: "VERIFYING",
    emittedBy: WRITER,
    occurredAt: AT,
    recordedAt: AT,
    correlationId: null,
    causationId: null,
    payload: { note: "contracts frozen" },
    ...overrides,
  };
  const merged = base as Record<string, unknown>;
  if (!("idempotencyKey" in overrides)) {
    merged["idempotencyKey"] = buildIdempotencyKey({
      taskId: merged["taskId"] as string,
      attempt: merged["attempt"] as number,
      transitionId: merged["transitionId"] as string,
    });
  }
  return merged;
}

function receipt(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: CONTRACT_VERSION,
    receiptId: THIRD_ID,
    taskId: TASK_ID,
    attempt: 1,
    writer: WRITER,
    verifier: VERIFIER,
    authorizedBy: AUTHORITY,
    authorizedAt: AT,
    worktreePath: "/Users/daniel/Developer/Rottay/agent-control-plane",
    branch: "main",
    baseHead: GIT_SHA,
    declaredWriteSet: ["packages/contracts/src/schemas.ts"],
    observedTrackedChanges: [
      { path: "packages/contracts/src/schemas.ts", sha256: SHA256 },
    ],
    observedUntrackedPaths: [],
    checks: [{ command: "pnpm check", exitCode: 0, ranAt: AT }],
    commitMessage: "feat(contracts): freeze P0 runtime contracts",
    pushAuthorized: false,
    ...overrides,
  };
}

function account(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: CONTRACT_VERSION,
    accountId: "acct-primary",
    provider: "claude",
    alias: "primary",
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://claude/primary",
    credentialRef: null,
    plan: "max",
    enabledModels: ["opus", "sonnet"],
    knownLimits: { weeklyTokens: 1_000_000 },
    resetSchedule: {
      kind: "OBSERVED",
      nextResetAt: AT,
      timezone: "America/Argentina/Buenos_Aires",
      confidence: "MEDIUM",
    },
    quotaEstimate: {
      remainingRatio: 0.4,
      estimatedTokensRemaining: 400_000,
      estimatedAt: AT,
      confidence: "LOW",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/Users/daniel/.rottay-agent-control-plane/roots/primary",
    contextSwitchCost: { estimatedTokens: 5_000, estimatedSeconds: 30 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WorkerIdentity
// ---------------------------------------------------------------------------

describe("WorkerIdentity", () => {
  it("accepts the canonical four segment identities from the roadmap", () => {
    for (const value of [WRITER, VERIFIER, AUTHORITY, REVIEWER, "codex/gpt-5-1/consultant/01"]) {
      expect(WorkerIdentityString.safeParse(value).success).toBe(true);
    }
  });

  it("round trips between the string and structured form", () => {
    const parsed = parseWorkerIdentity(WRITER);
    expect(parsed).toEqual({
      provider: "claude",
      model: "opus",
      role: "implementer",
      instance: "01",
    });
    expect(formatWorkerIdentity(parsed)).toBe(WRITER);
  });

  it("rejects malformed identities", () => {
    const bad = [
      "claude/opus/implementer",
      "claude/opus/implementer/01/extra",
      "Claude/opus/implementer/01",
      "claude/opus/architect/01",
      "claude//implementer/01",
      "claude/opus/implementer/1",
      "claude/opus/implementer/00001",
      "/opus/implementer/01",
      "claude opus implementer 01",
      "",
    ];
    for (const value of bad) {
      expect(WorkerIdentityString.safeParse(value).success, value).toBe(false);
    }
  });

  it("stays provider neutral by not enumerating providers or models", () => {
    expect(WorkerIdentityString.safeParse("someunknownvendor/m9/implementer/07").success).toBe(
      true,
    );
  });

  it("freezes the role set: the four roadmap roles plus the verifier extension", () => {
    // The roadmap names exactly four canonical workers: coordinator (DT),
    // implementer (integrator and mechanical writers), reviewer (auditor) and
    // consultant (checkpoint auditor). `verifier` is an extension required by
    // the supervision law, which mandates an independent verifier distinct from
    // the writer. It is additive and does not alter the roadmap digest.
    expect([...WORKER_ROLES].sort()).toEqual([
      "consultant",
      "coordinator",
      "implementer",
      "reviewer",
      "verifier",
    ]);

    for (const role of ["coordinator", "implementer", "reviewer", "consultant"]) {
      expect(WORKER_ROLES).toContain(role);
      expect(WorkerIdentityString.safeParse("p/m/" + role + "/01").success).toBe(true);
    }

    // A role the authority never froze must not be schedulable.
    for (const role of ["scout", "architect", "owner", "auditor"]) {
      expect(WorkerIdentityString.safeParse("p/m/" + role + "/01").success, role).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("freezes the exact ordered lifecycle from the roadmap", () => {
    expect(LIFECYCLE_STATES).toEqual([
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
    ]);
  });

  it("freezes the exact exceptional states from the roadmap", () => {
    expect(EXCEPTIONAL_STATES).toEqual([
      "WAITING_OWNER",
      "DRAINING",
      "QUOTA_BLOCKED",
      "AUTH_REQUIRED",
      "REJECTED",
      "FAILED",
      "SUSPECT_WORKTREE",
      "CANCELLED",
    ]);
  });

  it("keeps the two state families disjoint", () => {
    for (const state of LIFECYCLE_STATES) {
      expect(isLifecycleState(state)).toBe(true);
      expect(isExceptionalState(state)).toBe(false);
    }
    for (const state of EXCEPTIONAL_STATES) {
      expect(isExceptionalState(state)).toBe(true);
      expect(isLifecycleState(state)).toBe(false);
    }
  });

  it("rejects an invented state on an event", () => {
    expect(ControlPlaneEvent.safeParse(event({ toState: "ALMOST_DONE" })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strictness and versioning
// ---------------------------------------------------------------------------

describe("strictness", () => {
  it("accepts every well formed contract fixture", () => {
    expect(TaskEnvelope.safeParse(envelope()).success).toBe(true);
    expect(WorkerSlot.safeParse(slot()).success).toBe(true);
    expect(Checkpoint.safeParse(checkpoint()).success).toBe(true);
    expect(ControlPlaneEvent.safeParse(event()).success).toBe(true);
    expect(CommitAuthorizationReceipt.safeParse(receipt()).success).toBe(true);
    expect(AccountRecord.safeParse(account()).success).toBe(true);
  });

  it("rejects unknown keys on every top level contract", () => {
    expect(TaskEnvelope.safeParse(envelope({ extra: 1 })).success).toBe(false);
    expect(WorkerSlot.safeParse(slot({ extra: 1 })).success).toBe(false);
    expect(Checkpoint.safeParse(checkpoint({ extra: 1 })).success).toBe(false);
    expect(ControlPlaneEvent.safeParse(event({ extra: 1 })).success).toBe(false);
    expect(CommitAuthorizationReceipt.safeParse(receipt({ extra: 1 })).success).toBe(false);
    expect(AccountRecord.safeParse(account({ extra: 1 })).success).toBe(false);
  });

  it("rejects a foreign or missing contract version", () => {
    expect(Checkpoint.safeParse(checkpoint({ contractVersion: "0.9.0" })).success).toBe(false);
    expect(ControlPlaneEvent.safeParse(event({ contractVersion: undefined })).success).toBe(
      false,
    );
  });

  it("rejects write-set paths that escape the worktree", () => {
    expect(TaskEnvelope.safeParse(envelope({ writeSet: ["/etc/passwd"] })).success).toBe(false);
    expect(TaskEnvelope.safeParse(envelope({ writeSet: ["../other-repo/x.ts"] })).success).toBe(
      false,
    );
    expect(TaskEnvelope.safeParse(envelope({ writeSet: ["a.ts", "a.ts"] })).success).toBe(false);
  });

  it("rejects a checkpoint reserve that cannot pay for the checkpoint", () => {
    const bad = envelope({
      budget: {
        maxTokens: 1_000,
        maxWallClockSeconds: 60,
        reserveTokensForCheckpoint: 1_000,
      },
    });
    expect(TaskEnvelope.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency coordinates
// ---------------------------------------------------------------------------

describe("idempotency coordinates", () => {
  it("derives the key from taskId, attempt and transitionId", () => {
    expect(
      buildIdempotencyKey({ taskId: TASK_ID, attempt: 2, transitionId: "run.started" }),
    ).toBe(TASK_ID + "/2/run.started");
  });

  it("accepts an event whose key matches its coordinates", () => {
    const parsed = ControlPlaneEvent.safeParse(event({ attempt: 3 }));
    expect(parsed.success).toBe(true);
  });

  it("rejects an event whose key disagrees with its coordinates", () => {
    const parsed = ControlPlaneEvent.safeParse(
      event({ idempotencyKey: TASK_ID + "/99/run.started" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("distinguishes retries of the same transition by attempt", () => {
    const first = buildIdempotencyKey({
      taskId: TASK_ID,
      attempt: 1,
      transitionId: "run.started",
    });
    const second = buildIdempotencyKey({
      taskId: TASK_ID,
      attempt: 2,
      transitionId: "run.started",
    });
    expect(first).not.toBe(second);
  });

  it("rejects a non positive attempt and a malformed transitionId", () => {
    expect(ControlPlaneEvent.safeParse(event({ attempt: 0 })).success).toBe(false);
    expect(ControlPlaneEvent.safeParse(event({ transitionId: "has space" })).success).toBe(false);
  });

  it("rejects a state change event that does not change state", () => {
    const parsed = ControlPlaneEvent.safeParse(
      event({ fromState: "RUNNING", toState: "RUNNING" }),
    );
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credential rejection
// ---------------------------------------------------------------------------

describe("credential rejection", () => {
  it("flags credential bearing keys anywhere in a tree", () => {
    expect(findCredentialViolations({ a: { b: { password: "x" } } })).toHaveLength(1);
    expect(findCredentialViolations({ headers: { Authorization: "x" } })).toHaveLength(1);
    expect(findCredentialViolations({ api_key: "x" })).toHaveLength(1);
    expect(findCredentialViolations({ list: [{ accessToken: "x" }] })).toHaveLength(1);
  });

  it("permits opaque reference keys that name a locator instead of a secret", () => {
    expect(findCredentialViolations({ credentialRef: "keychain://acp/primary" })).toHaveLength(0);
    expect(findCredentialViolations({ secretRef: "aws://x" })).toHaveLength(0);
    expect(findCredentialViolations({ authProfileRef: "profile://claude/primary" })).toHaveLength(
      0,
    );
  });

  it("flags secret shaped values regardless of the key name", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    expect(findCredentialViolations({ harmlessName: jwt })).toHaveLength(1);
    expect(findCredentialViolations({ note: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA" })).toHaveLength(
      1,
    );
    expect(findCredentialViolations({ note: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toHaveLength(
      1,
    );
    expect(findCredentialViolations({ note: "AKIAIOSFODNN7EXAMPLE" })).toHaveLength(1);
  });

  it("rejects an event payload carrying credential material", () => {
    expect(ControlPlaneEvent.safeParse(event({ payload: { password: "hunter2" } })).success).toBe(
      false,
    );
    expect(
      ControlPlaneEvent.safeParse(event({ payload: { cookie: "session=abc" } })).success,
    ).toBe(false);
  });

  it("rejects a checkpoint whose free text smuggles a token", () => {
    const bad = checkpoint({
      nextSafeAction: "resume with Bearer abcdefghijklmnopqrstuvwxyz012345",
    });
    expect(Checkpoint.safeParse(bad).success).toBe(false);
  });

  it("rejects an account record whose reference is inline material", () => {
    expect(AccountRecord.safeParse(account({ credentialRef: "hunter2" })).success).toBe(false);
    expect(
      AccountRecord.safeParse(account({ authProfileRef: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA" }))
        .success,
    ).toBe(false);
  });

  it("requires an opaque reference when the fallback auth mode is declared", () => {
    const bad = account({ authMode: "LOCAL_CREDENTIAL_FALLBACK", credentialRef: null });
    expect(AccountRecord.safeParse(bad).success).toBe(false);
    const good = account({
      authMode: "LOCAL_CREDENTIAL_FALLBACK",
      credentialRef: "keychain://acp/primary",
    });
    expect(AccountRecord.safeParse(good).success).toBe(true);
  });

  it("does not let an AUTH_REQUIRED account publish a stale quota reading", () => {
    const bad = account({
      status: "AUTH_REQUIRED",
      quotaEstimate: {
        remainingRatio: 0.9,
        estimatedTokensRemaining: 1,
        estimatedAt: AT,
        confidence: "LOW",
      },
    });
    expect(AccountRecord.safeParse(bad).success).toBe(false);
  });

  it("flags compound keys whose name ends in a credential stem", () => {
    for (const key of [
      "dbPassword",
      "oauthToken",
      "sessionSecret",
      "db_password",
      "userPassphrase",
      "sessionCookie",
      "providerApiKey",
      "signingPrivateKey",
      "providerCredential",
      "storedCredentials",
    ]) {
      expect(findCredentialViolations({ [key]: "x" }), key).toHaveLength(1);
    }
  });

  it("still permits opaque locator and policy keys that merely mention a stem", () => {
    for (const key of [
      "credentialRef",
      "authProfileRef",
      "secretRef",
      "passwordPolicy",
      "tokenBudget",
      "maxTokens",
      "estimatedTokensRemaining",
      "reservedTokens",
      "idempotencyKey",
    ]) {
      expect(findCredentialViolations({ [key]: "opaque-value" }), key).toHaveLength(0);
    }
  });

  it("rejects an event payload carrying a compound credential key", () => {
    expect(ControlPlaneEvent.safeParse(event({ payload: { dbPassword: "x" } })).success).toBe(
      false,
    );
    expect(
      ControlPlaneEvent.safeParse(event({ payload: { nested: { oauthToken: "x" } } })).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transcript continuity
// ---------------------------------------------------------------------------

describe("transcript continuity", () => {
  it("flags provider conversation keys", () => {
    expect(findTranscriptViolations({ transcript: [] })).toHaveLength(1);
    expect(findTranscriptViolations({ nested: { messages: [] } })).toHaveLength(1);
    expect(findTranscriptViolations({ chatLog: "x" })).toHaveLength(1);
  });

  it("rejects an event payload that carries a transcript as continuity", () => {
    expect(
      ControlPlaneEvent.safeParse(event({ payload: { messages: [{ role: "user" }] } })).success,
    ).toBe(false);
  });

  it("allows digest based continuity", () => {
    expect(findTranscriptViolations({ writeSetDigest: [{ path: "a", sha256: SHA256 }] })).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Checkpoint size budget
// ---------------------------------------------------------------------------

describe("checkpoint size budget", () => {
  it("measures UTF-8 bytes of the JSON encoding, quotes included", () => {
    // JSON.stringify("é") is the three character text "é" wrapped in quotes.
    // Two ASCII quotes plus the two UTF-8 bytes of é is four.
    expect(serializedByteLength("é")).toBe(4);
  });

  it("counts an astral plane character as its four UTF-8 bytes", () => {
    // Two quotes plus the four UTF-8 bytes of the emoji.
    expect(serializedByteLength("😀")).toBe(6);
    // {"a":"😀"} is six ASCII characters of structure plus the four byte emoji
    // and its two quotes.
    expect(serializedByteLength({ a: "😀" })).toBe(12);
  });

  it("returns zero for values JSON cannot represent", () => {
    expect(serializedByteLength(undefined)).toBe(0);
  });

  it("accepts a compact checkpoint", () => {
    const value = checkpoint();
    expect(serializedByteLength(value)).toBeLessThan(CHECKPOINT_MAX_BYTES);
    expect(Checkpoint.safeParse(value).success).toBe(true);
  });

  it("rejects a checkpoint that exceeds the byte budget", () => {
    const bloated = checkpoint({
      pendingWork: Array.from(
        { length: 100 },
        (_unused, index) => "step " + String(index) + " " + "x".repeat(380),
      ),
    });
    expect(serializedByteLength(bloated)).toBeGreaterThan(CHECKPOINT_MAX_BYTES);
    const parsed = Checkpoint.safeParse(bloated);
    expect(parsed.success).toBe(false);
  });

  it("bounds the event payload independently", () => {
    const bloated = event({ payload: { blob: "y".repeat(EVENT_PAYLOAD_MAX_BYTES + 500) } });
    expect(ControlPlaneEvent.safeParse(bloated).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkerSlot invariants
// ---------------------------------------------------------------------------

describe("WorkerSlot", () => {
  it("forbids any slot from claiming push permission", () => {
    const bad = slot({ permissions: { canWrite: true, canCommit: true, canPush: true } });
    expect(WorkerSlot.safeParse(bad).success).toBe(false);
  });

  it("keeps the reviewer structurally read-only", () => {
    const bad = slot({
      identity: REVIEWER,
      provider: "claude",
      resolvedModel: "fable",
      role: "reviewer",
      permissions: { canWrite: true, canCommit: false, canPush: false },
    });
    expect(WorkerSlot.safeParse(bad).success).toBe(false);

    const good = slot({
      identity: REVIEWER,
      provider: "claude",
      resolvedModel: "fable",
      role: "reviewer",
      permissions: { canWrite: false, canCommit: false, canPush: false },
    });
    expect(WorkerSlot.safeParse(good).success).toBe(true);
  });

  it("requires the identity segments to agree with the flat fields", () => {
    expect(WorkerSlot.safeParse(slot({ provider: "kimi" })).success).toBe(false);
    expect(WorkerSlot.safeParse(slot({ role: "reviewer" })).success).toBe(false);
  });

  it("lets the routing alias differ from the provider-resolved model", () => {
    // identity carries the routing alias "opus"; resolvedModel carries the exact
    // model the provider returned. Equality is intentionally not required.
    const good = slot({
      identity: "claude/opus/implementer/01",
      provider: "claude",
      resolvedModel: "claude-opus-5-20260401",
    });
    expect(WorkerSlot.safeParse(good).success).toBe(true);
  });

  it("still pins the authority-bearing provider and role segments", () => {
    const wrongProvider = slot({
      identity: "claude/opus/implementer/01",
      provider: "codex",
      resolvedModel: "claude-opus-5-20260401",
    });
    expect(WorkerSlot.safeParse(wrongProvider).success).toBe(false);

    const wrongRole = slot({
      identity: "claude/opus/implementer/01",
      provider: "claude",
      role: "consultant",
      resolvedModel: "claude-opus-5-20260401",
    });
    expect(WorkerSlot.safeParse(wrongRole).success).toBe(false);
  });

  it("refuses a lease held by a different identity", () => {
    const bad = slot({
      lease: {
        leaseId: THIRD_ID,
        worktreePath: "/tmp/worktree",
        holder: VERIFIER,
        acquiredAt: AT,
        expiresAt: AT,
      },
    });
    expect(WorkerSlot.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CommitAuthorizationReceipt invariants
// ---------------------------------------------------------------------------

describe("CommitAuthorizationReceipt", () => {
  it("can never authorize a push", () => {
    expect(CommitAuthorizationReceipt.safeParse(receipt({ pushAuthorized: true })).success).toBe(
      false,
    );
  });

  it("requires an independent verifier", () => {
    expect(CommitAuthorizationReceipt.safeParse(receipt({ verifier: WRITER })).success).toBe(
      false,
    );
  });

  it("rejects tracked or untracked changes outside the declared write-set", () => {
    const trackedDrift = receipt({
      observedTrackedChanges: [{ path: "packages/contracts/src/rogue.ts", sha256: SHA256 }],
    });
    expect(CommitAuthorizationReceipt.safeParse(trackedDrift).success).toBe(false);

    const untrackedDrift = receipt({ observedUntrackedPaths: ["scratch/notes.md"] });
    expect(CommitAuthorizationReceipt.safeParse(untrackedDrift).success).toBe(false);
  });

  it("rejects authorization when a recorded check failed", () => {
    const bad = receipt({ checks: [{ command: "pnpm check", exitCode: 1, ranAt: AT }] });
    expect(CommitAuthorizationReceipt.safeParse(bad).success).toBe(false);
  });

  it("allows a null baseHead for the repository initial commit", () => {
    // At the initial commit there is no Git HEAD yet, so there is no base
    // commit to name. This is the only case where null is legal.
    const initial = receipt({ baseHead: null });
    expect(CommitAuthorizationReceipt.safeParse(initial).success).toBe(true);
  });

  it("still accepts a full object id as the base commit", () => {
    const normal = receipt({ baseHead: GIT_SHA });
    expect(CommitAuthorizationReceipt.safeParse(normal).success).toBe(true);
  });

  it("still rejects a malformed non-null baseHead", () => {
    for (const bad of [
      "abc",
      "b".repeat(39),
      "b".repeat(41),
      "B".repeat(40),
      "g".repeat(40),
      "",
      0,
      false,
    ]) {
      expect(
        CommitAuthorizationReceipt.safeParse(receipt({ baseHead: bad })).success,
        String(bad),
      ).toBe(false);
    }
  });

  it("does not let undefined stand in for the initial-commit null", () => {
    expect(CommitAuthorizationReceipt.safeParse(receipt({ baseHead: undefined })).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Mechanical no-push fence
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

describe("no-push architecture fence", () => {
  const hookPath = resolve(REPO_ROOT, ".githooks", "pre-push");

  it("ships an executable pre-push hook", () => {
    expect(existsSync(hookPath)).toBe(true);
    const mode = statSync(hookPath).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("always refuses the push with a nonzero exit and a clear message", () => {
    const result = spawnSync(hookPath, ["origin", "https://example.invalid/repo.git"], {
      input: "refs/heads/main " + GIT_SHA + " refs/heads/main " + GIT_SHA + "\n",
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output.toLowerCase()).toContain("push");
    expect(output.toLowerCase()).toContain("denied");
  });

  it("refuses even when no ref lines are supplied on stdin", () => {
    const result = spawnSync(hookPath, [], { input: "", encoding: "utf8", cwd: REPO_ROOT });
    expect(result.status).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Durability and supervisor plane
// ---------------------------------------------------------------------------

const driverStatus = (overrides: Record<string, unknown> = {}): unknown => ({
  contractVersion: CONTRACT_VERSION,
  mode: "SQLITE_SUPERVISOR",
  health: "OK",
  observedAt: AT,
  ledgerHeadSequence: 12,
  ledgerHeadSha256: SHA256,
  dataRoot: ".acp-local/drills",
  activeSince: AT,
  detail: null,
  ...overrides,
});

const reconciliation = (overrides: Record<string, unknown> = {}): unknown => ({
  contractVersion: CONTRACT_VERSION,
  reportId: TASK_ID,
  mode: "RESTATE",
  verdict: "CONSISTENT",
  observedAt: AT,
  ledgerHeadSequence: 12,
  ledgerHeadSha256: SHA256,
  resolvedByLedger: true,
  safeToResume: true,
  discrepancies: [],
  detail: null,
  ...overrides,
});

const discrepancy = {
  taskId: TASK_ID,
  attempt: 1,
  transitionId: "run.started",
  detail: "driver claims sequence 13 which the ledger has no record of",
};

describe("driver mode and health", () => {
  it("freezes both driver modes as first-class", () => {
    expect([...DRIVER_MODES]).toEqual(["SQLITE_SUPERVISOR", "RESTATE"]);
    for (const mode of DRIVER_MODES) {
      expect(DriverMode.safeParse(mode).success).toBe(true);
    }
    expect(DriverMode.safeParse("FALLBACK").success).toBe(false);
    expect(DriverMode.safeParse("restate").success).toBe(false);
  });

  it("keeps driver health distinct from a worker probe result", () => {
    expect([...DRIVER_HEALTH_STATES]).toEqual(["OK", "DEGRADED", "UNAVAILABLE", "UNKNOWN"]);
    // FAILED belongs to HealthProbe; a driver that is not running is not failed.
    expect(DriverHealth.safeParse("FAILED").success).toBe(false);
  });
});

describe("DriverStatus", () => {
  it("accepts a healthy supervisor status", () => {
    expect(DriverStatus.safeParse(driverStatus()).success).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(DriverStatus.safeParse(driverStatus({ pid: 4242 })).success).toBe(false);
  });

  it("refuses anything but a repository-relative ignored data root", () => {
    const unsafe = [
      "/Users/someone/.acp-local",
      "~/.acp-local",
      "../../.acp-local",
      ".acp-local/../../etc",
      "C:\\acp-local",
      "",
    ];
    for (const dataRoot of unsafe) {
      const result = DriverStatus.safeParse(driverStatus({ dataRoot }));
      expect(dataRoot + ":" + String(result.success)).toBe(dataRoot + ":false");
    }
    expect(DriverStatus.safeParse(driverStatus({ dataRoot: "restate-data" })).success).toBe(
      true,
    );
  });

  it("requires a reason whenever the driver is not OK", () => {
    for (const health of ["DEGRADED", "UNAVAILABLE", "UNKNOWN"]) {
      const silent = driverStatus({ health, activeSince: null, detail: null });
      expect(health + ":" + String(DriverStatus.safeParse(silent).success)).toBe(
        health + ":false",
      );
      const explained = driverStatus({
        health,
        activeSince: null,
        detail: "the driver is not running",
      });
      expect(health + ":" + String(DriverStatus.safeParse(explained).success)).toBe(
        health + ":true",
      );
    }
  });

  it("refuses an unavailable driver that claims to be active", () => {
    const bad = driverStatus({ health: "UNAVAILABLE", detail: "not running", activeSince: AT });
    expect(DriverStatus.safeParse(bad).success).toBe(false);
  });

  it("refuses a malformed ledger head", () => {
    expect(DriverStatus.safeParse(driverStatus({ ledgerHeadSha256: "nope" })).success).toBe(
      false,
    );
    expect(DriverStatus.safeParse(driverStatus({ ledgerHeadSequence: -1 })).success).toBe(
      false,
    );
  });

  it("refuses credential and transcript shaped fields", () => {
    expect(DriverStatus.safeParse(driverStatus({ apiKey: "x" })).success).toBe(false);
    expect(DriverStatus.safeParse(driverStatus({ transcript: [] })).success).toBe(false);
  });

  it("survives a JSON round trip unchanged", () => {
    const parsed = DriverStatus.parse(driverStatus());
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });
});

describe("ReconciliationReport", () => {
  it("accepts a consistent, ledger-headed report", () => {
    expect(ReconciliationReport.safeParse(reconciliation()).success).toBe(true);
  });

  it("freezes the verdict set and the two resumable verdicts", () => {
    expect([...RECONCILIATION_VERDICTS]).toEqual([
      "CONSISTENT",
      "DRIVER_BEHIND",
      "DRIVER_AHEAD",
      "DIVERGED",
      "INDETERMINATE",
    ]);
    expect([...RESUMABLE_VERDICTS]).toEqual(["CONSISTENT", "DRIVER_BEHIND"]);
    expect(ReconciliationVerdict.safeParse("MERGED").success).toBe(false);
  });

  it("permits resuming for exactly the two verdicts the ledger explains", () => {
    for (const verdict of RECONCILIATION_VERDICTS) {
      const resumable = (RESUMABLE_VERDICTS as readonly string[]).includes(verdict);
      const report = reconciliation({
        verdict,
        safeToResume: resumable,
        detail: verdict === "CONSISTENT" ? null : "classified by reconciliation",
        discrepancies: verdict === "CONSISTENT" ? [] : [discrepancy],
      });
      expect(verdict + ":" + String(ReconciliationReport.safeParse(report).success)).toBe(
        verdict + ":true",
      );
    }
  });

  it("fails closed: no halting verdict may claim it is safe to resume", () => {
    for (const verdict of ["DRIVER_AHEAD", "DIVERGED", "INDETERMINATE"]) {
      const bad = reconciliation({
        verdict,
        safeToResume: true,
        detail: "classified",
        discrepancies: [discrepancy],
      });
      expect(verdict + ":" + String(ReconciliationReport.safeParse(bad).success)).toBe(
        verdict + ":false",
      );
    }
  });

  it("refuses a resumable verdict that withholds permission to resume", () => {
    const bad = reconciliation({ verdict: "CONSISTENT", safeToResume: false });
    expect(ReconciliationReport.safeParse(bad).success).toBe(false);
  });

  it("refuses a reconciliation resolved by anything but the ledger", () => {
    expect(
      ReconciliationReport.safeParse(reconciliation({ resolvedByLedger: false })).success,
    ).toBe(false);
  });

  it("refuses a consistent verdict that carries discrepancies", () => {
    const bad = reconciliation({ discrepancies: [discrepancy] });
    expect(ReconciliationReport.safeParse(bad).success).toBe(false);
  });

  it("refuses a halting verdict that names nothing", () => {
    for (const verdict of ["DRIVER_AHEAD", "DIVERGED"]) {
      const bad = reconciliation({
        verdict,
        safeToResume: false,
        detail: "classified",
        discrepancies: [],
      });
      expect(verdict + ":" + String(ReconciliationReport.safeParse(bad).success)).toBe(
        verdict + ":false",
      );
    }
  });

  it("requires an explanation for every verdict other than CONSISTENT", () => {
    const bad = reconciliation({
      verdict: "DRIVER_BEHIND",
      safeToResume: true,
      detail: null,
      discrepancies: [discrepancy],
    });
    expect(ReconciliationReport.safeParse(bad).success).toBe(false);
  });

  it("keeps discrepancies to coordinates, never event content", () => {
    const leaky = reconciliation({
      verdict: "DIVERGED",
      safeToResume: false,
      detail: "classified",
      discrepancies: [{ ...discrepancy, payload: { blob: "x" } }],
    });
    expect(ReconciliationReport.safeParse(leaky).success).toBe(false);
  });

  it("refuses credential shaped fields", () => {
    expect(ReconciliationReport.safeParse(reconciliation({ token: "x" })).success).toBe(false);
  });

  it("survives a JSON round trip unchanged", () => {
    const parsed = ReconciliationReport.parse(reconciliation());
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });
});

// ---------------------------------------------------------------------------
// Initiatives and the versioned roadmap
// ---------------------------------------------------------------------------

function initiative(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: CONTRACT_VERSION,
    initiativeId: INITIATIVE_ID,
    slug: "agent-control-plane",
    title: "Agent Control Plane",
    objective: "Coordinate coding agents across providers, accounts and quotas.",
    status: "ACTIVE",
    createdAt: AT,
    ...overrides,
  };
}

function roadmapVersion(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: CONTRACT_VERSION,
    roadmapVersionId: OTHER_ID,
    initiativeId: INITIATIVE_ID,
    version: 1,
    contentDigest: SHA256,
    parentVersionId: null,
    expectedHeadDigest: null,
    kind: "EDIT",
    restoresVersionId: null,
    recordedBy: AUTHORITY,
    recordedAt: AT,
    ...overrides,
  };
}

function initiativeEvent(overrides: Record<string, unknown> = {}): unknown {
  const transitionId = (overrides["transitionId"] as string | undefined) ?? "initiative.registered";
  const initiativeId = (overrides["initiativeId"] as string | undefined) ?? INITIATIVE_ID;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: THIRD_ID,
    initiativeId,
    transitionId,
    idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId, transitionId }),
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: AUTHORITY,
    occurredAt: AT,
    recordedAt: AT,
    payload: {},
    ...overrides,
  };
}

describe("Initiative", () => {
  it("accepts a well formed initiative and survives a JSON round trip", () => {
    const parsed = Initiative.parse(initiative());
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it("closes its status vocabulary at four names", () => {
    expect([...INITIATIVE_STATUSES]).toEqual(["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]);
    for (const status of INITIATIVE_STATUSES) {
      expect(Initiative.safeParse(initiative({ status })).success).toBe(true);
    }
    expect(Initiative.safeParse(initiative({ status: "DELETED" })).success).toBe(false);
  });

  it("requires a lowercase kebab-case slug", () => {
    expect(Initiative.safeParse(initiative({ slug: "Agent-Control-Plane" })).success).toBe(false);
    expect(Initiative.safeParse(initiative({ slug: "-leading-dash" })).success).toBe(false);
    expect(Initiative.safeParse(initiative({ slug: "has space" })).success).toBe(false);
  });

  it("rejects unknown keys and credential shaped fields", () => {
    expect(Initiative.safeParse(initiative({ owner: "someone" })).success).toBe(false);
    expect(Initiative.safeParse(initiative({ token: "x" })).success).toBe(false);
  });
});

describe("RoadmapVersion", () => {
  it("accepts the bootstrap version and survives a JSON round trip", () => {
    const parsed = RoadmapVersion.parse(roadmapVersion());
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it("accepts a successor that names its parent and the head it expected", () => {
    const parsed = RoadmapVersion.safeParse(
      roadmapVersion({ version: 2, parentVersionId: OTHER_ID, expectedHeadDigest: SHA256 }),
    );
    expect(parsed.success).toBe(true);
  });

  it("binds parentVersionId to the bootstrap in both directions", () => {
    // A later version may not claim it has no parent.
    expect(
      RoadmapVersion.safeParse(
        roadmapVersion({ version: 2, parentVersionId: null, expectedHeadDigest: SHA256 }),
      ).success,
    ).toBe(false);
    // Version 1 may not claim one either: there is nothing to be a parent.
    expect(
      RoadmapVersion.safeParse(roadmapVersion({ parentVersionId: OTHER_ID })).success,
    ).toBe(false);
  });

  it("binds expectedHeadDigest to the bootstrap in both directions", () => {
    // A null head claim on a later version is unconditional overwrite.
    expect(
      RoadmapVersion.safeParse(
        roadmapVersion({ version: 2, parentVersionId: OTHER_ID, expectedHeadDigest: null }),
      ).success,
    ).toBe(false);
    // Version 1 had no head to expect.
    expect(RoadmapVersion.safeParse(roadmapVersion({ expectedHeadDigest: SHA256 })).success).toBe(
      false,
    );
  });

  it("binds restoresVersionId to the kind in both directions", () => {
    expect([...ROADMAP_VERSION_KINDS]).toEqual(["EDIT", "ROLLBACK"]);
    expect(RoadmapVersion.safeParse(roadmapVersion({ restoresVersionId: THIRD_ID })).success).toBe(
      false,
    );
    expect(RoadmapVersion.safeParse(roadmapVersion({ kind: "ROLLBACK" })).success).toBe(false);
    expect(
      RoadmapVersion.safeParse(roadmapVersion({ kind: "ROLLBACK", restoresVersionId: THIRD_ID }))
        .success,
    ).toBe(true);
  });

  it("carries a digest, never the roadmap's bytes", () => {
    expect(RoadmapVersion.safeParse(roadmapVersion({ contentDigest: "not a digest" })).success).toBe(
      false,
    );
    expect(RoadmapVersion.safeParse(roadmapVersion({ content: "# roadmap" })).success).toBe(false);
  });

  it("rejects a non positive version", () => {
    expect(RoadmapVersion.safeParse(roadmapVersion({ version: 0 })).success).toBe(false);
  });
});

describe("InitiativeEvent", () => {
  it("accepts a registration and survives a JSON round trip", () => {
    const parsed = InitiativeEvent.parse(initiativeEvent());
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it("closes its vocabulary at the three initiative facts", () => {
    expect([...INITIATIVE_EVENT_TYPES]).toEqual([
      "INITIATIVE_REGISTERED",
      "INITIATIVE_STATE_CHANGED",
      "ROADMAP_VERSION_RECORDED",
    ]);
    expect(InitiativeEvent.safeParse(initiativeEvent({ type: "TASK_DISCOVERED" })).success).toBe(
      false,
    );
  });

  it("derives the key from initiativeId and transitionId, with no attempt", () => {
    expect(
      buildInitiativeIdempotencyKey({
        initiativeId: INITIATIVE_ID,
        transitionId: "initiative.registered",
      }),
    ).toBe(INITIATIVE_ID + "/1/initiative.registered");
  });

  it("rejects an event whose key disagrees with its coordinates", () => {
    expect(
      InitiativeEvent.safeParse(
        initiativeEvent({ idempotencyKey: INITIATIVE_ID + "/2/initiative.registered" }),
      ).success,
    ).toBe(false);
  });

  it("binds a null fromStatus to registration in both directions", () => {
    // Only a registration has no prior status.
    expect(
      InitiativeEvent.safeParse(
        initiativeEvent({
          type: "INITIATIVE_STATE_CHANGED",
          transitionId: "initiative.paused",
          idempotencyKey: INITIATIVE_ID + "/1/initiative.paused",
          fromStatus: null,
          toStatus: "PAUSED",
        }),
      ).success,
    ).toBe(false);
    // And a registration may not claim one.
    expect(
      InitiativeEvent.safeParse(initiativeEvent({ fromStatus: "ACTIVE" })).success,
    ).toBe(false);
  });

  it("requires a status change to change status, and a recording not to", () => {
    const changed = (overrides: Record<string, unknown>): unknown =>
      initiativeEvent({
        transitionId: "initiative.paused",
        idempotencyKey: INITIATIVE_ID + "/1/initiative.paused",
        ...overrides,
      });
    expect(
      InitiativeEvent.safeParse(
        changed({ type: "INITIATIVE_STATE_CHANGED", fromStatus: "ACTIVE", toStatus: "ACTIVE" }),
      ).success,
    ).toBe(false);
    expect(
      InitiativeEvent.safeParse(
        changed({ type: "INITIATIVE_STATE_CHANGED", fromStatus: "ACTIVE", toStatus: "PAUSED" }),
      ).success,
    ).toBe(true);
    expect(
      InitiativeEvent.safeParse(
        changed({ type: "ROADMAP_VERSION_RECORDED", fromStatus: "ACTIVE", toStatus: "PAUSED" }),
      ).success,
    ).toBe(false);
    expect(
      InitiativeEvent.safeParse(
        changed({ type: "ROADMAP_VERSION_RECORDED", fromStatus: "ACTIVE", toStatus: "ACTIVE" }),
      ).success,
    ).toBe(true);
  });

  it("refuses credential material and transcript continuity in its payload", () => {
    expect(
      InitiativeEvent.safeParse(initiativeEvent({ payload: { token: "x" } })).success,
    ).toBe(false);
    expect(
      InitiativeEvent.safeParse(initiativeEvent({ payload: { transcript: "x" } })).success,
    ).toBe(false);
  });

  it("bounds its payload by the same budget as the task stream", () => {
    const oversized = { blob: "x".repeat(EVENT_PAYLOAD_MAX_BYTES) };
    expect(InitiativeEvent.safeParse(initiativeEvent({ payload: oversized })).success).toBe(false);
  });

  it("keeps the two streams apart: no taskId, no toState", () => {
    expect(InitiativeEvent.safeParse(initiativeEvent({ taskId: TASK_ID })).success).toBe(false);
    expect(InitiativeEvent.safeParse(initiativeEvent({ toState: "RUNNING" })).success).toBe(false);
  });
});

describe("the task stream's usage attribution", () => {
  it("declares both usage types", () => {
    const types: readonly string[] = CONTROL_PLANE_EVENT_TYPES;
    expect(types).toContain("TOKEN_USAGE_RECORDED");
    expect(types).toContain("TOKEN_RESERVATION_RECORDED");
  });

  it("accepts an accountId/tokens payload as a same-state passthrough", () => {
    for (const type of ["TOKEN_USAGE_RECORDED", "TOKEN_RESERVATION_RECORDED"] as const) {
      const parsed = ControlPlaneEvent.safeParse(
        event({
          type,
          fromState: "RUNNING",
          toState: "RUNNING",
          payload: { accountId: "acct-a", tokens: 1_200 },
        }),
      );
      expect({ type, ok: parsed.success }).toEqual({ type, ok: true });
    }
  });

  it("would refuse the singular token key, which is why the payload says tokens", () => {
    const parsed = ControlPlaneEvent.safeParse(
      event({
        type: "TOKEN_USAGE_RECORDED",
        fromState: "RUNNING",
        toState: "RUNNING",
        payload: { accountId: "acct-a", token: 1_200 },
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("TaskEnvelope initiative scoping", () => {
  it("requires an initiativeId", () => {
    const withoutInitiative = Object.fromEntries(
      Object.entries(envelope() as Record<string, unknown>).filter(
        ([key]) => key !== "initiativeId",
      ),
    );
    expect(TaskEnvelope.safeParse(withoutInitiative).success).toBe(false);
  });

  it("requires it to be a uuid, and keeps it distinct from the task", () => {
    expect(TaskEnvelope.safeParse(envelope({ initiativeId: "not-a-uuid" })).success).toBe(false);
    const parsed = TaskEnvelope.parse(envelope({ initiativeId: OTHER_INITIATIVE_ID }));
    expect(parsed.initiativeId).toBe(OTHER_INITIATIVE_ID);
    expect(parsed.initiativeId).not.toBe(parsed.taskId);
  });
});

// ---------------------------------------------------------------------------
// The owned execution boundary
// ---------------------------------------------------------------------------

const ROUTE_AT = "2026-08-30T14:00:00.000Z";

function route(overrides: Record<string, unknown> = {}): unknown {
  return {
    provider: "claude",
    model: "opus",
    accountId: "acct-primary",
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "2026-08-30.1",
    resolvedAt: ROUTE_AT,
    ...overrides,
  };
}

describe("transport kinds and the CLI provider vocabulary", () => {
  it("closes the transport kinds at the ruling's three", () => {
    expect([...TRANSPORT_KINDS]).toEqual([
      "CLI_SUBSCRIPTION",
      "API_KEY",
      "LOCAL_OR_SELF_HOSTED",
    ]);
  });

  it("declares the CLI providers here, sorted, as the one home", () => {
    expect([...CLI_SUBSCRIPTION_PROVIDERS]).toEqual(["claude", "codex", "kimi"]);
    expect([...CLI_SUBSCRIPTION_PROVIDERS]).toEqual([...CLI_SUBSCRIPTION_PROVIDERS].sort());
    expect(new Set(CLI_SUBSCRIPTION_PROVIDERS).size).toBe(CLI_SUBSCRIPTION_PROVIDERS.length);
  });

  it("closes the refusal vocabulary, sorted and deduplicated", () => {
    expect([...EXECUTION_REFUSALS]).toEqual([...EXECUTION_REFUSALS].sort());
    expect(new Set(EXECUTION_REFUSALS).size).toBe(EXECUTION_REFUSALS.length);
    expect([...EXECUTION_REFUSALS]).toEqual([
      "CAPABILITY_UNSUPPORTED",
      "REATTACH_UNAVAILABLE",
      "ROUTE_INVALID",
      "TRANSPORT_UNAVAILABLE",
    ]);
  });
});

describe("ResolvedRoute", () => {
  it("accepts a complete route and survives a JSON round trip", () => {
    const parsed = ResolvedRoute.parse(route());
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it("binds a CLI route to the CLI provider vocabulary", () => {
    for (const provider of CLI_SUBSCRIPTION_PROVIDERS) {
      expect(ResolvedRoute.safeParse(route({ provider })).success).toBe(true);
    }
    expect(ResolvedRoute.safeParse(route({ provider: "openai" })).success).toBe(false);
  });

  it("leaves the provider opaque for the transports that are not CLI", () => {
    // A local or API-backed transport may name something the CLI list has
    // never heard of; only the CLI kind is bound to the closed vocabulary.
    expect(
      ResolvedRoute.safeParse(route({ transportKind: "API_KEY", provider: "openai" })).success,
    ).toBe(true);
    expect(
      ResolvedRoute.safeParse(
        route({ transportKind: "LOCAL_OR_SELF_HOSTED", provider: "llama-cpp" }),
      ).success,
    ).toBe(true);
  });

  it("requires every field: nothing is optional-defaulted by an adapter", () => {
    for (const field of [
      "provider",
      "model",
      "accountId",
      "transportKind",
      "capabilityPolicyVersion",
      "resolvedAt",
    ]) {
      const partial = Object.fromEntries(
        Object.entries(route() as Record<string, unknown>).filter(([key]) => key !== field),
      );
      expect({ field, ok: ResolvedRoute.safeParse(partial).success }).toEqual({
        field,
        ok: false,
      });
    }
  });

  it("rejects an unknown transport kind and an unknown key", () => {
    expect(ResolvedRoute.safeParse(route({ transportKind: "SSH" })).success).toBe(false);
    expect(ResolvedRoute.safeParse(route({ fallbackModel: "sonnet" })).success).toBe(false);
  });
});

describe("ExecutionEvent", () => {
  it("carries both the routed alias and the provider's own resolution on started", () => {
    const parsed = ExecutionEvent.parse({
      kind: "started",
      route: route(),
      resolvedModel: "claude-opus-5-20260401",
      protocolVersion: "1.2",
    });
    if (parsed.kind !== "started") throw new Error("expected started");
    // The pair is the evidence that no adapter substituted a model: the alias
    // the router chose, beside what the provider actually bound.
    expect(parsed.route.model).toBe("opus");
    expect(parsed.resolvedModel).toBe("claude-opus-5-20260401");
    expect(parsed.resolvedModel).not.toBe(parsed.route.model);
  });

  it("normalizes a write action, which enforcement depends on seeing", () => {
    const parsed = ExecutionEvent.safeParse({
      kind: "write",
      target: "packages/contracts/src/schemas/index.ts",
    });
    expect(parsed.success).toBe(true);
    // A write target is a repo-relative path: it cannot escape the worktree.
    expect(ExecutionEvent.safeParse({ kind: "write", target: "/etc/passwd" }).success).toBe(false);
    expect(ExecutionEvent.safeParse({ kind: "write", target: "../outside" }).success).toBe(false);
  });

  it("carries the session machine's transition", () => {
    expect(ExecutionEvent.safeParse({ kind: "state", toState: "STREAMING" }).success).toBe(true);
    expect(ExecutionEvent.safeParse({ kind: "state", toState: "" }).success).toBe(false);
  });

  it("keeps step ordering on usage, so it folds in the order it happened", () => {
    const parsed = ExecutionEvent.parse({ kind: "usage", stepIndex: 3, tokensUsed: 1_200 });
    if (parsed.kind !== "usage") throw new Error("expected usage");
    expect(parsed.stepIndex).toBe(3);
    expect(ExecutionEvent.safeParse({ kind: "usage", tokensUsed: 5 }).success).toBe(false);
    expect(
      ExecutionEvent.safeParse({ kind: "usage", stepIndex: -1, tokensUsed: 5 }).success,
    ).toBe(false);
  });

  it("accepts the rest of the normalized vocabulary", () => {
    const cases: readonly unknown[] = [
      { kind: "text", delta: "hello" },
      { kind: "toolUse", tool: "read_file", detail: "packages/contracts" },
      { kind: "checkpoint", digest: SHA256 },
      { kind: "authRequired", reason: "subscription session expired" },
      { kind: "error", refusal: "CAPABILITY_UNSUPPORTED", detail: "no tool support" },
      { kind: "completed", stepIndex: 7 },
    ];
    for (const candidate of cases) {
      const parsed = ExecutionEvent.safeParse(candidate);
      expect({ candidate, ok: parsed.success }).toEqual({ candidate, ok: true });
    }
  });

  it("classifies an error rather than carrying a provider message", () => {
    expect(
      ExecutionEvent.safeParse({ kind: "error", refusal: "BOOM", detail: "x" }).success,
    ).toBe(false);
    expect(
      ExecutionEvent.safeParse({ kind: "error", detail: "raw provider stderr" }).success,
    ).toBe(false);
  });

  it("closes the vocabulary: an unknown kind is refused", () => {
    expect(ExecutionEvent.safeParse({ kind: "thinking", delta: "..." }).success).toBe(false);
    expect(ExecutionEvent.safeParse({ kind: "checkpoint", digest: "nope" }).success).toBe(false);
  });

  it("is exactly the ten normalized variants", () => {
    const kinds = ExecutionEvent.options.map((option) => option.shape.kind.value);
    expect([...kinds].sort()).toEqual([
      "authRequired",
      "checkpoint",
      "completed",
      "error",
      "started",
      "state",
      "text",
      "toolUse",
      "usage",
      "write",
    ]);
  });
});

describe("ExecutionRequest", () => {
  it("accepts an ordinary start, with no reattachment", () => {
    const parsed = ExecutionRequest.parse({
      taskId: TASK_ID,
      attempt: 1,
      identity: WRITER,
      reattach: null,
    });
    expect(parsed.reattach).toBeNull();
  });

  it("accepts a reattach reference, and requires the field to be stated", () => {
    expect(
      ExecutionRequest.safeParse({
        taskId: TASK_ID,
        attempt: 2,
        identity: WRITER,
        reattach: "session-abc",
      }).success,
    ).toBe(true);
    // Null is the ordinary case, but it is never implicit: a caller says which
    // it means, so a transport can never read absence as "start fresh".
    expect(
      ExecutionRequest.safeParse({ taskId: TASK_ID, attempt: 1, identity: WRITER }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid task, a zero attempt and an unknown key", () => {
    const base = { taskId: TASK_ID, attempt: 1, identity: WRITER, reattach: null };
    expect(ExecutionRequest.safeParse({ ...base, taskId: "task-1" }).success).toBe(false);
    expect(ExecutionRequest.safeParse({ ...base, attempt: 0 }).success).toBe(false);
    expect(ExecutionRequest.safeParse({ ...base, binary: "/usr/bin/claude" }).success).toBe(false);
  });
});

describe("the roadmap content ceiling is one declaration with one unit (P8-8G R2)", () => {
  it("counts UTF-8 bytes, which is not the same as String.length", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
    // The case the old bound got wrong: two-byte characters.
    expect("é".length).toBe(1);
    expect(utf8ByteLength("é")).toBe(2);
    // And four-byte ones, where the gap is wider still: an emoji is two
    // UTF-16 code units and four bytes.
    expect("😀".length).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("states the ceiling once, at 1 MiB", () => {
    expect(ROADMAP_CONTENT_MAX_BYTES).toBe(1024 * 1024);
  });

  it("agrees with the platform's own encoder", () => {
    // Not a tautology: it pins that the helper measures UTF-8 specifically,
    // so a future rewrite to `.length` would fail here rather than silently
    // reintroduce the unit mismatch this constant exists to prevent.
    const sample = "héllo 😀 — roadmap";
    expect(utf8ByteLength(sample)).toBe(new TextEncoder().encode(sample).byteLength);
    expect(utf8ByteLength(sample)).not.toBe(sample.length);
  });
});

describe("the account-action vocabulary (P8-8G packet 2)", () => {
  const ACTOR = "kimi/k3/coordinator/01";
  const AT = "2026-08-31T12:00:00.000Z";

  function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const version = (overrides["version"] as number | undefined) ?? 1;
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: "11111111-1111-4111-8111-111111111111",
      accountId: "acct-primary",
      version,
      idempotencyKey: "acct-primary/1/action." + String(version),
      action: "DRAIN",
      resultingState: "DRAINING",
      actor: ACTOR,
      note: null,
      occurredAt: AT,
      recordedAt: AT,
      ...overrides,
    };
  }

  it("is closed at four verbs", () => {
    expect([...ACCOUNT_ACTIONS]).toEqual([
      "DRAIN",
      "ACCOUNT_READY",
      "REAUTH_REQUIRED",
      "OWNER_OVERRIDE",
    ]);
    expect(AccountActionEvent.safeParse(event({ action: "DELETE_ACCOUNT" })).success).toBe(false);
  });

  it("maps three verbs to a state and leaves the fourth to say its own", () => {
    // The table is the mapping, so a reader checks it against the vocabulary
    // rather than tracing a switch. `OWNER_OVERRIDE` is null precisely because
    // its state is not implied by the verb.
    expect(ACCOUNT_ACTION_STATE.DRAIN).toBe("DRAINING");
    expect(ACCOUNT_ACTION_STATE.ACCOUNT_READY).toBe("AVAILABLE");
    expect(ACCOUNT_ACTION_STATE.REAUTH_REQUIRED).toBe("AUTH_REQUIRED");
    expect(ACCOUNT_ACTION_STATE.OWNER_OVERRIDE).toBeNull();
    // Total over the vocabulary: a verb added without a mapping fails here.
    for (const action of ACCOUNT_ACTIONS) {
      expect({ action, mapped: action in ACCOUNT_ACTION_STATE }).toEqual({ action, mapped: true });
    }
  });

  it("refuses a resulting state its action does not imply", () => {
    expect(AccountActionEvent.safeParse(event()).success).toBe(true);
    // The claim and the verb must agree — this is what stops an event saying
    // "I drained it" beside "it is now AVAILABLE".
    expect(AccountActionEvent.safeParse(event({ resultingState: "AVAILABLE" })).success).toBe(false);
    // The override may name any state, because its verb implies none.
    expect(
      AccountActionEvent.safeParse(
        event({ action: "OWNER_OVERRIDE", resultingState: "COOLDOWN" }),
      ).success,
    ).toBe(true);
  });

  it("ties the idempotency key to the account and the version", () => {
    expect(AccountActionEvent.safeParse(event({ idempotencyKey: "wrong" })).success).toBe(false);
    expect(
      AccountActionEvent.safeParse(event({ version: 2, idempotencyKey: "acct-primary/1/action.2" }))
        .success,
    ).toBe(true);
    // The key must follow the version it claims, not any version.
    expect(
      AccountActionEvent.safeParse(event({ version: 2, idempotencyKey: "acct-primary/1/action.1" }))
        .success,
    ).toBe(false);
  });

  it("guards the note, which is the only free text it carries", () => {
    const planted = "sk-ant-api03-" + "A".repeat(80);
    expect(AccountActionEvent.safeParse(event({ note: planted })).success).toBe(false);
    // A real reason is fine, and null is fine.
    expect(AccountActionEvent.safeParse(event({ note: "weekly quota exhausted" })).success).toBe(true);
    expect(AccountActionEvent.safeParse(event({ note: null })).success).toBe(true);
    // Bounded: a note is a reason, not a document.
    expect(
      AccountActionEvent.safeParse(event({ note: "x".repeat(ACCOUNT_ACTION_NOTE_MAX + 1) })).success,
    ).toBe(false);
  });
});
