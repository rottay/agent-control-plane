import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AccountRecord,
  CHECKPOINT_MAX_BYTES,
  CONTRACT_VERSION,
  Checkpoint,
  CommitAuthorizationReceipt,
  ControlPlaneEvent,
  EVENT_PAYLOAD_MAX_BYTES,
  EXCEPTIONAL_STATES,
  LIFECYCLE_STATES,
  TaskEnvelope,
  WORKER_ROLES,
  WorkerIdentityString,
  WorkerSlot,
  buildIdempotencyKey,
  findCredentialViolations,
  findTranscriptViolations,
  formatWorkerIdentity,
  isExceptionalState,
  isLifecycleState,
  parseWorkerIdentity,
  serializedByteLength,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "11111111-1111-4111-8111-111111111111";
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
