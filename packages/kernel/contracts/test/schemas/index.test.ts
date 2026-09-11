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
  AccountRecord,
  CHECKPOINT_MAX_BYTES,
  CLI_SUBSCRIPTION_PROVIDERS,
  CONTRACT_VERSION,
  CONTROL_PLANE_EVENT_TYPES,
  Checkpoint,
  CommitAuthorizationReceipt,
  ControlPlaneEvent,
  DRIVER_CAPABILITIES,
  DRIVER_CAPABILITY_PROPERTIES,
  DRIVER_CAPABILITY_STATES,
  DRIVER_HEALTH_STATES,
  DRIVER_MODES,
  DRIVER_REFUSALS,
  DriverCapabilities,
  DriverHealth,
  DriverMode,
  DriverStatus,
  EVENT_PAYLOAD_MAX_BYTES,
  EXCEPTIONAL_STATES,
  EXECUTION_REFUSALS,
  ExecutionEvent,
  ExecutionRequest,
  INITIATIVE_EVENT_TYPES,
  INITIATIVE_STATUSES,
  Initiative,
  InitiativeEvent,
  LIFECYCLE_STATES,
  PROVIDER_PRESSURES,
  SWITCH_STEP_NAMES,
  SwitchAuthorization,
  SwitchPlanShape,
  RECONCILIATION_VERDICTS,
  RESUMABLE_VERDICTS,
  ROADMAP_CONTENT_MAX_BYTES,
  ROADMAP_VERSION_KINDS,
  ReconciliationReport,
  ReconciliationVerdict,
  ResolvedRoute,
  RoadmapVersion,
  TRANSPORT_KINDS,
  ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1,
  TaskEnvelope,
  WORKER_ROLES,
  WorkerIdentityString,
  WorkerSlot,
  buildIdempotencyKey,
  buildInitiativeIdempotencyKey,
  findCredentialViolations,
  findTranscriptViolations,
  formatWorkerIdentity,
  isDriverRefused,
  isExceptionalState,
  isLifecycleState,
  parseWorkerIdentity,
  serializedByteLength,
  utf8ByteLength,
} from "../../src/index.js";
import type { DriverAccepted, DriverOutcome } from "../../src/index.js";

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

describe("the task stream's tool-call receipts", () => {
  /** The nine safe scalars, and nothing else. */
  const RECEIPT_PAYLOAD = {
    accountId: "acct-a",
    serverId: "fs-local",
    toolName: "read_file",
    transport: "STDIO",
    outcome: "COMPLETED",
    refusal: null,
    argumentBytes: 128,
    resultBytes: 4_096,
    contentBlocks: 2,
  } as const;

  it("declares the receipt type", () => {
    const types: readonly string[] = CONTROL_PLANE_EVENT_TYPES;
    expect(types).toContain("TOOL_CALL_RECORDED");
  });

  it("accepts the nine-key payload as a same-state passthrough", () => {
    const parsed = ControlPlaneEvent.safeParse(
      event({
        type: "TOOL_CALL_RECORDED",
        fromState: "RUNNING",
        toState: "RUNNING",
        payload: RECEIPT_PAYLOAD,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("does not itself close the payload: the nine keys are the producer's law", () => {
    // Stated as a test rather than as a comment, because the opposite claim is
    // tempting and would be false. `payload` is `z.record(…, z.unknown())` for
    // every type in this vocabulary, so a tenth ordinary key parses here. What
    // keeps it out of the ledger is `@acp/runtime`'s recorder, which builds the
    // payload field by field and refuses anything outside its grammar.
    const parsed = ControlPlaneEvent.safeParse(
      event({
        type: "TOOL_CALL_RECORDED",
        fromState: "RUNNING",
        toState: "RUNNING",
        payload: { ...RECEIPT_PAYLOAD, durationMs: 12 },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("keeps the credential and transcript guards live for this type", () => {
    // Both directions, so the acceptance above is not a check that always
    // passes: what the contract does enforce for a receipt is what it enforces
    // for every event.
    for (const leak of [{ apiKey: "sk-live-abcdef" }, { transcript: ["turn one"] }]) {
      const parsed = ControlPlaneEvent.safeParse(
        event({
          type: "TOOL_CALL_RECORDED",
          fromState: "RUNNING",
          toState: "RUNNING",
          payload: { ...RECEIPT_PAYLOAD, ...leak },
        }),
      );
      expect({ leak: Object.keys(leak)[0], ok: parsed.success }).toEqual({
        leak: Object.keys(leak)[0],
        ok: false,
      });
    }
  });
});

describe("the envelope revision preimage prefix (P-05/A)", () => {
  // The constant is this package's half of the preimage: §6.2 makes
  // `kernel/contracts` the master contract for it, while the function that
  // computes the digest lives in `@acp/ledger` because this package may import
  // `zod` and no `node:` builtin at all — every other package imports it,
  // including the browser client.
  //
  // So the owning package pins the declaration, and the ledger's suite pins the
  // bytes it produces. A change here that only the ledger's suite caught would
  // be a contract moving under a test in another package.

  it("carries its own LF, and names a frozen version", () => {
    expect(ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1).toBe("acp/task-envelope/v1\n");

    // One LF, and it is the last byte: the preimage is prefix + canonical JSON
    // with no separator of its own, so a formula that added `"\n"` would
    // produce two and every pinned digest would move. Asserted as a byte
    // through `TextEncoder`, which is what this package uses instead of
    // `Buffer` for exactly the browser-safety reason above.
    const bytes = new TextEncoder().encode(ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1);
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    expect([...bytes].filter((byte) => byte === 0x0a)).toHaveLength(1);

    // Namespaced and versioned. `v1` is never edited in place: a change to the
    // encoding is a new constant with a new name, because a digest whose
    // preimage can be redefined identifies nothing.
    expect(ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1).toMatch(/^acp\/[a-z-]+\/v1\n$/);
  });

  it("keeps the schema's key set derivable, which is what makes the preimage total", () => {
    // The preimage is the whole parsed envelope rather than a list of fields,
    // so "covers every field" is a property of `TaskEnvelope` being a
    // `z.strictObject` — and of `.shape` staying reachable through the
    // `superRefine` wrapper. If that stopped being true, the ledger's
    // "every field of the envelope changes the digest" drill would silently
    // narrow to whatever it could still see.
    const keys = Object.keys(TaskEnvelope.shape);
    expect(keys.length).toBeGreaterThan(0);
    expect(Object.keys(TaskEnvelope.parse(envelope()) as object).sort()).toEqual([...keys].sort());

    // And the four things §6.2 excludes by name are excluded by construction:
    // none of them is a field, and strictness is what refuses them.
    for (const excluded of ["accountId", "attemptNumber", "modelVersionId", "pid"]) {
      expect(keys, excluded).not.toContain(excluded);
      expect(TaskEnvelope.safeParse(envelope({ [excluded]: "x" })).success, excluded).toBe(false);
    }
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

  it("declares the observation vocabulary here, sorted, closed at five", () => {
    expect([...PROVIDER_PRESSURES]).toEqual([
      "AUTH_REQUIRED",
      "QUOTA_EXHAUSTED",
      "QUOTA_WARNING",
      "TRANSIENT",
      "UNCLASSIFIED",
    ]);
    expect([...PROVIDER_PRESSURES]).toEqual([...PROVIDER_PRESSURES].sort());
    expect(new Set(PROVIDER_PRESSURES).size).toBe(PROVIDER_PRESSURES.length);
  });

  it("gives the observation vocabulary no field a quantity could occupy", () => {
    // The members are bare strings. There is no remaining count, ratio, reset
    // instant, limit or retry-after anywhere in the shape, which is what makes
    // "never fabricate remaining quota" structural rather than remembered.
    for (const pressure of PROVIDER_PRESSURES) {
      expect(typeof pressure).toBe("string");
      expect(pressure).toMatch(/^[A-Z_]+$/);
    }
  });

  it("closes the refusal vocabulary, sorted and deduplicated", () => {
    expect([...EXECUTION_REFUSALS]).toEqual([...EXECUTION_REFUSALS].sort());
    expect(new Set(EXECUTION_REFUSALS).size).toBe(EXECUTION_REFUSALS.length);
    // Rewritten sorted by V2-B4a rather than appended to: the sortedness
    // assertion above is only worth anything if the pin it guards is itself
    // written in the order it claims. `EXECUTION_IN_FLIGHT` lands second.
    expect([...EXECUTION_REFUSALS]).toEqual([
      "CAPABILITY_UNSUPPORTED",
      "EXECUTION_IN_FLIGHT",
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
      { kind: "pressure", provider: "codex", pressure: "QUOTA_EXHAUSTED" },
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

  it("carries a classified pressure, its provider, and no quantity at all", () => {
    const parsed = ExecutionEvent.parse({
      kind: "pressure",
      provider: "codex",
      pressure: "QUOTA_EXHAUSTED",
    });
    expect(parsed).toEqual({
      kind: "pressure",
      provider: "codex",
      pressure: "QUOTA_EXHAUSTED",
    });
    // The member is a strict object over three closed scalars, so a remaining
    // count, a reset instant or a retry-after is unrepresentable at the
    // boundary rather than merely discouraged.
    for (const extra of [
      { remaining: 0 },
      { resetAt: "2026-09-05T00:00:00.000Z" },
      { retryAfter: 60 },
      { limit: 1_000 },
    ]) {
      expect(
        ExecutionEvent.safeParse({
          kind: "pressure",
          provider: "codex",
          pressure: "QUOTA_EXHAUSTED",
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("refuses a pressure outside the observation vocabulary or the CLI providers", () => {
    expect(
      ExecutionEvent.safeParse({ kind: "pressure", provider: "codex", pressure: "DRAINING" })
        .success,
    ).toBe(false);
    expect(
      ExecutionEvent.safeParse({
        kind: "pressure",
        provider: "openai",
        pressure: "QUOTA_EXHAUSTED",
      }).success,
    ).toBe(false);
    expect(ExecutionEvent.safeParse({ kind: "pressure", provider: "codex" }).success).toBe(false);
  });

  it("is exactly the eleven normalized variants", () => {
    const kinds = ExecutionEvent.options.map((option) => option.shape.kind.value);
    expect([...kinds].sort()).toEqual([
      "authRequired",
      "checkpoint",
      "completed",
      "error",
      "pressure",
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
      instructions: "summarise the packet and propose a plan",
      reattach: null,
    });
    expect(parsed.reattach).toBeNull();
    expect(parsed.instructions).toBe("summarise the packet and propose a plan");
  });

  it("carries the instruction, bounded exactly as the envelope's objective is (V2-B1c)", () => {
    // The same bound at both doors on purpose: the value comes from
    // `TaskEnvelope.objective`, and a looser bound here would be a second
    // policy able to disagree with the first about what the model was asked.
    const base = {
      taskId: TASK_ID,
      attempt: 1,
      identity: WRITER,
      instructions: "do the work",
      reattach: null,
    };
    expect(ExecutionRequest.safeParse({ ...base, instructions: "x".repeat(4_000) }).success).toBe(true);
    // N2: over the bound is a refusal, never a truncation. An adapter that
    // shortened an instruction would be inventing a policy about what the model
    // was asked, which is the one thing no transport may decide.
    expect(ExecutionRequest.safeParse({ ...base, instructions: "x".repeat(4_001) }).success).toBe(false);
    expect(ExecutionRequest.safeParse({ ...base, instructions: "" }).success).toBe(false);
    // Required, not optional: an execution with no instruction is not a start
    // with a default, it is a request that does not say what to do.
    const withoutInstruction: Record<string, unknown> = { ...base };
    delete withoutInstruction["instructions"];
    expect(ExecutionRequest.safeParse(withoutInstruction).success).toBe(false);
    // The key set stays closed.
    expect(Object.keys(ExecutionRequest.shape).sort()).toEqual([
      "attempt",
      "identity",
      "instructions",
      "reattach",
      "taskId",
    ]);
  });

  it("accepts a reattach reference, and requires the field to be stated", () => {
    expect(
      ExecutionRequest.safeParse({
        taskId: TASK_ID,
        attempt: 2,
        identity: WRITER,
        instructions: "rejoin the run and finish it",
        reattach: "session-abc",
      }).success,
    ).toBe(true);
    // Null is the ordinary case, but it is never implicit: a caller says which
    // it means, so a transport can never read absence as "start fresh". The
    // instruction is supplied here so `reattach`'s absence is the only reason
    // this refuses.
    expect(
      ExecutionRequest.safeParse({
        taskId: TASK_ID,
        attempt: 1,
        identity: WRITER,
        instructions: "do the work",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid task, a zero attempt and an unknown key", () => {
    const base = {
      taskId: TASK_ID,
      attempt: 1,
      identity: WRITER,
      instructions: "do the work",
      reattach: null,
    };
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


describe("the driver capability declaration (V2-B2-1)", () => {
  const declaration = {
    contractVersion: CONTRACT_VERSION,
    mode: "RESTATE",
    verbs: { CANCEL: "UNSUPPORTED", REATTACH: "UNSUPPORTED", SIGNAL: "UNSUPPORTED", TIMER: "UNSUPPORTED" },
    properties: { SERIALIZED_PER_TASK: "UNSUPPORTED" },
  };

  it("closes its vocabularies, and keeps verbs and properties apart", () => {
    // Sorted and closed, like every other vocabulary here. A fifth verb or a
    // second property is a contract change, which is what a pin is for.
    expect([...DRIVER_CAPABILITIES]).toEqual(["CANCEL", "REATTACH", "SIGNAL", "TIMER"]);
    expect([...DRIVER_CAPABILITY_PROPERTIES]).toEqual(["SERIALIZED_PER_TASK"]);
    // The refusal vocabulary grew at V2-B2-4b, under the rule B2-1 set for it:
    // a reason arrives with the drill that earns it. `CANCEL` became real
    // there, and a real verb refuses for reasons that are about the TASK
    // rather than about the engine's capabilities.
    //
    // V2 L4 added the fourth under the same rule. `INVOCATION_NOT_FOUND` is
    // what a reached engine answers when it holds no invocation at an address,
    // and it arrived with the drills that measure it — a never-issued key and
    // an unregistered deployment both answer `404`, which is why the member is
    // definite about the answer and silent about the cause. N7: exactly four,
    // in declared order.
    expect([...DRIVER_REFUSALS]).toEqual([
      "CAPABILITY_UNSUPPORTED",
      "INVOCATION_NOT_FOUND",
      "POSTCONDITION_UNKNOWN",
      "TASK_TERMINAL",
    ]);
    expect(DRIVER_REFUSALS).toHaveLength(4);
  });

  it("admits two states and no third", () => {
    // The absent `UNKNOWN` is the point: a driver's capabilities are knowable
    // by construction, so a third state would only be somewhere to hide.
    expect([...DRIVER_CAPABILITY_STATES]).toEqual(["SUPPORTED", "UNSUPPORTED"]);
    expect(
      DriverCapabilities.safeParse({
        ...declaration,
        verbs: { ...declaration.verbs, CANCEL: "UNKNOWN" },
      }).success,
    ).toBe(false);
  });

  it("accepts a complete declaration and refuses a partial one", () => {
    expect(DriverCapabilities.safeParse(declaration).success).toBe(true);
    // Every verb is answered or none of them is trustworthy.
    const withoutCancel: Record<string, string> = { ...declaration.verbs };
    delete withoutCancel["CANCEL"];
    expect(
      DriverCapabilities.safeParse({ ...declaration, verbs: withoutCancel }).success,
    ).toBe(false);
  });

  it("refuses a verb or property the vocabulary does not name", () => {
    expect(
      DriverCapabilities.safeParse({
        ...declaration,
        verbs: { ...declaration.verbs, TELEPORT: "SUPPORTED" },
      }).success,
    ).toBe(false);
    expect(
      DriverCapabilities.safeParse({
        ...declaration,
        properties: { ...declaration.properties, CHEAP: "SUPPORTED" },
      }).success,
    ).toBe(false);
  });

  it("carries the credential guards every self-report carries", () => {
    // Not a new redaction mechanism: the same `attachGuards` DriverStatus and
    // ReconciliationReport already run, reached through the same superRefine.
    expect(
      DriverCapabilities.safeParse({ ...declaration, apiKey: "sk-not-allowed-here" }).success,
    ).toBe(false);
  });

  it("discriminates a refusal from an acceptance", () => {
    expect(isDriverRefused({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "cancel" })).toBe(true);
    expect(isDriverRefused({ ok: true })).toBe(false);
  });

  /**
   * The two reasons V2-B2-4b added, and why they could not be the first one.
   *
   * `CANCEL` is `SUPPORTED` on the Restate driver as of that packet, so a
   * refusal from it can no longer mean "the engine does not offer this". Both
   * new members describe the task the caller named: it had already ended, or
   * its effect could not be established. Answering either with
   * `CAPABILITY_UNSUPPORTED` would tell a caller the engine cannot cancel,
   * which is a false statement about the driver rather than a true one about
   * the task -- and a caller that believed it would stop asking.
   */
  it("discriminates the task-level refusals exactly as it does the capability one", () => {
    for (const refusal of ["POSTCONDITION_UNKNOWN", "TASK_TERMINAL"] as const) {
      const refused: DriverOutcome = { ok: false, refusal, at: "cancel" };
      expect(isDriverRefused(refused)).toBe(true);
      // Reached through the guard, which is the only way a caller should: the
      // reason is not addressable until the union has been discriminated.
      expect(isDriverRefused(refused) ? refused.refusal : null).toBe(refusal);
      // `at` names the verb and nothing else. Never engine output, never a
      // path, never anything about the work being advanced.
      expect(isDriverRefused(refused) ? refused.at : null).toBe("cancel");
    }
  });

  it("keeps every refusal reason inside the closed vocabulary", () => {
    // A driver that invented a reason would be describing a refusal nobody
    // downstream can classify, which is the failure a closed enum prevents.
    expect((DRIVER_REFUSALS as readonly string[]).includes("TASK_BUSY")).toBe(false);
    for (const refusal of DRIVER_REFUSALS) {
      expect(isDriverRefused({ ok: false, refusal, at: "cancel" })).toBe(true);
    }
  });

  /**
   * The accepted arm, opened by V2-B2-4a for `REATTACH`.
   *
   * Two properties, and only the second is new. The discrimination must not
   * change when the arm carries a value — a widening that made an acceptance
   * look like a refusal to `isDriverRefused` would silently invert every
   * caller. And what the arm may carry is bounded to LEDGER coordinates: a
   * driver that handed back an engine-minted address would let a caller
   * persist it, and a ledger whose coordinates came from the engine would have
   * given the engine authority over where its own facts live.
   */
  it("still discriminates when the accepted arm carries what a verb produced", () => {
    const reattached: DriverOutcome = { ok: true, finalSequence: 11 };
    expect(isDriverRefused(reattached)).toBe(false);
    // Reached through the guard, which is the only way a caller should: the
    // accepted arm is not addressable until the union has been discriminated.
    expect(isDriverRefused(reattached) ? null : reattached.finalSequence).toBe(11);
  });

  it("carries ledger coordinates in the accepted arm and no engine identity", () => {
    const reattached: DriverAccepted = { ok: true, finalSequence: 11 };
    // Named members only, so a field added later has to be argued for here
    // rather than arriving with whatever a driver happened to have on hand.
    expect(Object.keys(reattached).sort()).toEqual(["finalSequence", "ok"]);
    // Restate names its own invocations `inv_...`. Nothing in this shape can
    // be one: every value is a number or the literal true.
    for (const value of Object.values(reattached)) {
      expect(typeof value === "number" || typeof value === "boolean").toBe(true);
      expect(String(value).startsWith("inv_")).toBe(false);
    }
  });

  it("lets a verb that produces nothing answer without inventing a sequence", () => {
    // The reason the member is optional. SIGNAL and TIMER are still
    // unimplemented; when one becomes real it widens this arm with what IT
    // produces, and a required `finalSequence` would have forced it to report
    // a ledger position it never observed.
    const bare: DriverAccepted = { ok: true };
    expect(bare.finalSequence).toBeUndefined();
    expect(isDriverRefused(bare)).toBe(false);
  });

  it("gives the second real verb the same member, because it means the same thing", () => {
    // V2-B2-4b made `CANCEL` real and added no member. What a cancellation
    // produces is also a ledger head -- the position its settlement left the
    // log at -- so it answers in the field that already means exactly that. A
    // second number under a different name would be two spellings of one fact,
    // and the first caller to read the wrong one would report the wrong head.
    const cancelled: DriverAccepted = { ok: true, finalSequence: 12 };
    expect(Object.keys(cancelled).sort()).toEqual(["finalSequence", "ok"]);
    expect(isDriverRefused(cancelled)).toBe(false);
    // Still a ledger coordinate and still nothing the engine minted: Restate
    // names its own invocations `inv_...`, and this shape holds no string.
    for (const value of Object.values(cancelled)) {
      expect(typeof value === "number" || typeof value === "boolean").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// V2-B1f/F4d — a decided switch, admitted at a door
// ---------------------------------------------------------------------------

const F4D_PLAN = {
  kind: "SWITCH" as const,
  accountStatus: "EXHAUSTED" as const,
  taskState: "QUOTA_BLOCKED" as const,
  steps: ["MARK_ACCOUNT_DRAINING", "MARK_TASK_QUOTA_BLOCKED"],
  selectedAccountId: "acct-second",
  events: [
    { type: "QUOTA_WARNING", payload: { accountId: "acct-primary" } },
    { type: "TASK_STATE_CHANGED", payload: { toState: "QUOTA_BLOCKED" } },
  ],
};

const F4D_AUTHORIZATION = {
  trigger: "QUOTA_EXHAUSTED" as const,
  decidedForAccountId: "acct-primary",
  decidedBy: "claude/opus/implementer/01",
  decidedAt: "2026-09-05T12:00:00.000Z",
  decidedFromEventId: "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b01",
  observedSince: "2026-09-05T10:00:00.000Z",
  plan: F4D_PLAN,
};

describe("the switch step vocabulary", () => {
  it("declares the eleven steps here, in the order a plan selects from", () => {
    // The order is the claim: a plan is a prefix-free selection from this list
    // in this order, never a reordering. The decision module owns the same
    // eleven and the fence pins the two equal in both directions.
    expect([...SWITCH_STEP_NAMES]).toEqual([
      "MARK_ACCOUNT_DRAINING",
      "MARK_TASK_QUOTA_BLOCKED",
      "FINISH_CURRENT_ATOMIC_STEP",
      "WRITE_CHECKPOINT",
      "RELEASE_LEASE",
      "SELECT_ACCOUNT",
      "READ_ONLY_HEALTH_PROBE",
      "OPEN_FRESH_SESSION",
      "REVALIDATE_AUTHORITY_AND_PRESTATE",
      "REHYDRATE_CHECKPOINT",
      "CONTINUE",
    ]);
    expect(new Set(SWITCH_STEP_NAMES).size).toBe(SWITCH_STEP_NAMES.length);
  });
});

describe("SwitchAuthorization", () => {
  it("P1: admits a complete decision and survives a JSON round trip", () => {
    const parsed = SwitchAuthorization.parse(F4D_AUTHORIZATION);
    expect(parsed.trigger).toBe("QUOTA_EXHAUSTED");
    expect(parsed.plan.selectedAccountId).toBe("acct-second");
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(F4D_AUTHORIZATION);
  });

  it("P1: requires every audit field — who, when, from what, and since when", () => {
    // The audit block is what makes a decision answerable after the fact. A
    // shape that let any of it be omitted would admit an authorization nobody
    // could trace to a decision or to the evidence it was taken from.
    for (const omitted of [
      "trigger",
      "decidedForAccountId",
      "decidedBy",
      "decidedAt",
      "decidedFromEventId",
      "observedSince",
      "plan",
    ]) {
      const candidate = Object.fromEntries(
        Object.entries(F4D_AUTHORIZATION).filter(([key]) => key !== omitted),
      );
      expect({ omitted, ok: SwitchAuthorization.safeParse(candidate).success }).toEqual({
        omitted,
        ok: false,
      });
    }
  });

  it("P1: is strict — an operator-authored document cannot smuggle a field", () => {
    expect(
      SwitchAuthorization.safeParse({ ...F4D_AUTHORIZATION, expiresAt: "2026-09-06T00:00:00.000Z" })
        .success,
    ).toBe(false);
    expect(
      SwitchPlanShape.safeParse({ ...F4D_PLAN, credentialRef: "secret://x" }).success,
    ).toBe(false);
  });

  it("P1: closes the trigger at the two quota members", () => {
    // An authorization is fired by a quota trigger or by nothing. An auth
    // requirement is a lawful observation and never a trigger, which is the
    // fold's rule, restated where the door can enforce it.
    for (const trigger of ["AUTH_REQUIRED", "TRANSIENT", "UNCLASSIFIED", "SWITCH"]) {
      expect({
        trigger,
        ok: SwitchAuthorization.safeParse({ ...F4D_AUTHORIZATION, trigger }).success,
      }).toEqual({ trigger, ok: false });
    }
    for (const trigger of ["QUOTA_EXHAUSTED", "QUOTA_WARNING"]) {
      expect({
        trigger,
        ok: SwitchAuthorization.safeParse({ ...F4D_AUTHORIZATION, trigger }).success,
      }).toEqual({ trigger, ok: true });
    }
  });

  it("P1: refuses an instant without an offset, and an event id that is not a uuid", () => {
    expect(
      SwitchAuthorization.safeParse({ ...F4D_AUTHORIZATION, decidedAt: "2026-09-05T12:00:00" })
        .success,
    ).toBe(false);
    expect(
      SwitchAuthorization.safeParse({ ...F4D_AUTHORIZATION, decidedFromEventId: "not-a-uuid" })
        .success,
    ).toBe(false);
  });

  it("P1: bounds every collection the plan carries", () => {
    // The shape crosses a door an operator authors, so a plan cannot arrive
    // with more steps than the vocabulary has or more events than steps.
    const tooManySteps = { ...F4D_PLAN, steps: [...SWITCH_STEP_NAMES, "CONTINUE"] };
    expect(SwitchPlanShape.safeParse(tooManySteps).success).toBe(false);
    const tooManyEvents = {
      ...F4D_PLAN,
      events: Array.from({ length: SWITCH_STEP_NAMES.length + 1 }, () => ({
        type: "QUOTA_WARNING",
        payload: {},
      })),
    };
    expect(SwitchPlanShape.safeParse(tooManyEvents).success).toBe(false);
  });

  it("P1: refuses a step the vocabulary does not name and an event type the contract does not", () => {
    expect(SwitchPlanShape.safeParse({ ...F4D_PLAN, steps: ["INVENTED_STEP"] }).success).toBe(false);
    expect(
      SwitchPlanShape.safeParse({
        ...F4D_PLAN,
        events: [{ type: "SWITCH_INVENTED", payload: {} }],
      }).success,
    ).toBe(false);
  });

  it("P1: lets a plan select no account, and lets the payloads stay string-valued", () => {
    const drain = {
      ...F4D_PLAN,
      kind: "DRAIN" as const,
      accountStatus: "DRAINING" as const,
      taskState: null,
      selectedAccountId: null,
    };
    expect(SwitchPlanShape.safeParse(drain).success).toBe(true);
    // A payload is bounded string-to-string: never a transcript, never a
    // nested object an operator could hide something in.
    expect(
      SwitchPlanShape.safeParse({
        ...F4D_PLAN,
        events: [{ type: "QUOTA_WARNING", payload: { accountId: { nested: true } } }],
      }).success,
    ).toBe(false);
  });
});
