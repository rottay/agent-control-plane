import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  EVENT_PAYLOAD_MAX_BYTES,
  buildIdempotencyKey,
  buildV2IdempotencyKey,
  commitMessageWithReceiptTrailer,
  type ControlPlaneEvent,
} from "@acp/contracts";

import * as ledgerBarrel from "../../src/index.js";
import {
  COMMIT_AUTHORIZATION_REFUSALS,
  GENESIS_SHA256,
  LedgerCommitAuthorizationRefusedError,
  LedgerVerificationRefusedError,
  TASK_INTAKE_TRANSITION_ID,
  artifactBlobLeaseStorePath,
  canonicalJsonStringify,
  chainDigest,
  commitAuthorizationInForce,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  supervisedWorkerIdFor,
  verificationPolicySha256,
  writerWorkerIdFor,
  type ArtifactBlobLeaseStore,
  type ArtifactPlane,
  type CommitAuthorizationReadModel,
  type Ledger,
} from "../../src/index.js";
import {
  COMMIT_AUTHORIZATION_KEY,
  decideCommitAuthorizationRecord,
  decideCommitAuthorizationSupersession,
  readCommitAuthorizationArtifacts,
  recordedLeaseOf,
  type CommitAuthorizationDecisionView,
  type RecordedLeaseEvent,
} from "../../src/commit-authorization-record/index.js";
import { COMMIT_AUTHORIZATION_MIGRATION, VERIFICATION_AUDIT_MIGRATION } from "../../src/migrations/index.js";
import { receiptVerificationColumns } from "../../src/receipt-identity/index.js";
import type { AuditVerdictReadModel, VerificationReadModel } from "../../src/types/index.js";

/**
 * A commit authorization is recorded and revalidated (P-17/A, ADR 0126; execution
 * §10.5; decisions 245-247).
 *
 * The door is the ledger's own `append` and `appendBatch`, so every door test runs on a
 * real on-disk ledger with a real private-artifacts root: the envelope is published as a
 * `TASK_ENVELOPE` the intake names, the receipt as a `RECEIPT` and the evidence as an
 * `EVIDENCE`, all scoped to the task, and the door reads the receipt and the envelope
 * back by reference. The lease is the task stream's own recorded `LEASE_ACQUIRED`. The
 * fold is exercised through `rebuildReadModel()` and `verifyIntegrity()` over histories
 * planted past the door, and the decision and the predicate as pure units over a
 * hand-built view. The positives are P1-P7, the negatives N1-N13 and the boundaries
 * B1-B4 of the brief (`.acp-local/evidence/p17-a/brief-v1.md` §4, with the DT
 * pre-review's corrections B-1..B-4 and its rulings).
 */

const AT = "2026-09-27T12:00:00.000Z";
const LATER = "2026-09-27T12:05:00.000Z";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2026-12-31T00:00:00.000Z";
const LEASE_EXPIRES_AT = "2026-09-27T13:00:00.000Z";
const COORDINATOR = "claude/opus/coordinator/01";
const PUBLISHER = "claude/opus/implementer/01";
const WRITER = "claude/opus/implementer/01";
const OTHER_WRITER = "claude/opus/implementer/02";
const VERIFIER = "claude/sonnet/verifier/01";
const AUDITOR = "claude/sonnet/reviewer/01";
const INITIATIVE_ID = "7a2c3d4e-5f60-4b7c-9d8e-1f2a3b4c5d6e";
const WRITE_SET = ["src/a.ts", "src/_x.ts", "src/B.ts"];
const COMMANDS = ["pnpm check", "pnpm lint"];
const BODY = "feat(runtime): a verified change";

const directories: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      /* already closed */
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Substrates
// ---------------------------------------------------------------------------

interface Harness {
  readonly path: string;
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  readonly leaseStore: ArtifactBlobLeaseStore;
  readonly close: () => void;
}

let command = 0;

function harnessAt(path: string): Harness {
  const ledger = openLedger(path);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(path), {
    incarnationId: randomUUID(),
    createdAt: CREATED_AT,
  });
  const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: path });
  const close = (): void => {
    if (!ledger.closed) ledger.close();
    leaseStore.close();
  };
  closers.push(close);
  return { path, ledger, plane, leaseStore, close };
}

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "acp-p17a-"));
  directories.push(directory);
  return harnessAt(join(directory, "control-plane.sqlite"));
}

function publish(h: Harness, content: Buffer, artifactReferenceId: string, artifactClass: string, scopeId: string): string {
  command += 1;
  const id = String(command);
  const outcome = h.plane.publish({
    content,
    mediaType: "application/json",
    encryptionStatus: "PLAINTEXT",
    encryptionProfile: "local-plaintext-v1",
    commandId: "cmd-" + id,
    artifactPinId: "pin-" + id,
    reference: {
      artifactReferenceId,
      artifactClass,
      classification: "INTERNAL",
      scopeKind: "TASK",
      scopeId,
      producerIdentity: PUBLISHER,
      accessPolicyId: "SCOPE_EQUALITY_V1",
      retentionClass: "STANDARD",
      expiresAt: EXPIRES_AT,
    } as Parameters<ArtifactPlane["publish"]>[0]["reference"],
    recordedBy: PUBLISHER,
    intention: { eventId: randomUUID(), idempotencyKey: "artifact/cmd-" + id + "/intended", occurredAt: AT, recordedAt: AT },
    terminal: { eventId: randomUUID(), idempotencyKey: "artifact/cmd-" + id + "/terminal", occurredAt: AT, recordedAt: AT },
    holding: { holder: PUBLISHER, holderPid: 4242, acquiredAt: AT, expiresAt: EXPIRES_AT },
  });
  if (outcome.verb !== "PUBLISHED") throw new Error("expected a publication, got " + outcome.verb);
  return outcome.contentSha256;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface EventInput {
  readonly taskId: string;
  readonly type: ControlPlaneEvent["type"];
  readonly transitionId: string;
  readonly payload: Record<string, unknown>;
  readonly fromState?: string | null;
  readonly toState?: string;
  readonly eventId?: string;
  readonly recordedAt?: string;
}

function taskEvent(input: EventInput): Record<string, unknown> {
  const revisionNumber = input.payload["revisionNumber"];
  const attemptNumber = input.payload["attemptNumber"];
  const v2 = typeof revisionNumber === "number" && typeof attemptNumber === "number";
  const fromState = input.fromState === undefined ? "AUDITING" : input.fromState;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: input.eventId ?? randomUUID(),
    taskId: input.taskId,
    attempt: 1,
    transitionId: input.transitionId,
    idempotencyKey: v2
      ? buildV2IdempotencyKey({
          stream: "control_plane_events",
          taskId: input.taskId,
          revisionNumber,
          attemptNumber,
          transitionId: input.transitionId,
        })
      : buildIdempotencyKey({ taskId: input.taskId, attempt: 1, transitionId: input.transitionId }),
    type: input.type,
    fromState,
    toState: input.toState ?? fromState ?? "DISCOVERED",
    emittedBy: COORDINATOR,
    occurredAt: input.recordedAt ?? AT,
    recordedAt: input.recordedAt ?? AT,
    correlationId: null,
    causationId: null,
    payload: input.payload,
  };
}

function envelopeValue(taskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = "Record and revalidate a commit authorization.";
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    initiativeId: INITIATIVE_ID,
    title: BODY,
    content: {
      contentContractVersion: 1,
      blocks: [
        {
          kind: "text",
          blockId: "b1",
          mediaType: "text/plain; charset=utf-8",
          byteLength: new TextEncoder().encode(text).byteLength,
          contentSha256: "0".repeat(64),
          artifactRefId: null,
          text,
          toolCallId: null,
          effectId: null,
        },
      ],
    },
    classification: "SEMANTIC",
    issuedBy: COORDINATOR,
    issuedAt: AT,
    authority: [],
    readSet: [],
    writeSet: WRITE_SET,
    conflictKeys: [],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "a verified change" },
    validation: { commands: COMMANDS, independentVerifierRequired: true },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 10_000, maxWallClockSeconds: 600, reserveTokensForCheckpoint: 1_000 },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: false, maxStepsWithoutCheckpoint: 8 },
    ...overrides,
  };
}

/** The receipt's policy digest, as the runner computes it from the envelope. */
const POLICY = verificationPolicySha256({
  commands: COMMANDS,
  independentVerifierRequired: true,
  commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
});

interface TaskInput {
  readonly commitPolicy?: "LOCAL_COMMIT_WITH_RECEIPT" | "NO_COMMIT";
  readonly envelope?: Record<string, unknown>;
  readonly intake?: boolean;
}

interface Task {
  readonly h: Harness;
  readonly taskId: string;
  readonly envelopeReferenceId: string;
}

/**
 * One V2 task through the real door: an intake naming its envelope (unless `intake` is
 * false: then the task has no recorded policy), the attempt opened, and the task moved to
 * `AUDITING`.
 */
function task(input: TaskInput = {}, h: Harness = harness()): Task {
  const taskId = randomUUID();
  const envelopeReferenceId = "ref-envelope-" + taskId;
  const envelope = input.envelope ?? envelopeValue(taskId);
  publish(h, Buffer.from(canonicalJsonStringify(envelope), "utf8"), envelopeReferenceId, "TASK_ENVELOPE", taskId);
  const revision = {
    revisionId: "rev-" + taskId,
    revisionNumber: 1,
    attemptNumber: 1,
    envelopeSha256: "e".repeat(64),
    envelopeArtifactReferenceId: envelopeReferenceId,
  };
  if (input.intake !== false) {
    h.ledger.append(
      taskEvent({
        taskId,
        type: "TASK_DISCOVERED",
        transitionId: TASK_INTAKE_TRANSITION_ID,
        fromState: null,
        toState: "DISCOVERED",
        payload: {
          ...revision,
          restoredFromRevisionId: null,
          initiativeId: INITIATIVE_ID,
          clientScope: "claude/opus/coordinator/01",
          clientRequestKey: "intake-" + taskId.slice(0, 8),
          roadmapVersionId: null,
          stepId: null,
          role: "implementer",
          commitPolicy: input.commitPolicy ?? "LOCAL_COMMIT_WITH_RECEIPT",
          resolution: {
            assignmentId: "assignment-1",
            assignmentVersion: 1,
            slot: 0,
            modelVersionId: "claude-opus-5@2026-06-01",
            provider: "claude",
            model: "claude-opus-5",
            release: "2026-06-01",
            transportKind: "CLI_SUBSCRIPTION",
            watermarks: [
              {
                projectionName: "model_version_read_model",
                sourceStream: "registry_events",
                appliedThroughSequence: 2,
                eventCount: 2,
                sourceHeadSha256: "c".repeat(64),
              },
            ],
          },
        },
      }),
    );
  }
  h.ledger.append(
    taskEvent({
      taskId,
      type: "TASK_ATTEMPT_OPENED",
      transitionId: "attempt.open.1",
      fromState: input.intake === false ? null : "DISCOVERED",
      toState: "DISCOVERED",
      payload: { ...revision, invocationId: "inv-1", legacyAttemptNumber: 1 },
    }),
  );
  h.ledger.append(
    taskEvent({ taskId, type: "TASK_STATE_CHANGED", transitionId: "to.auditing", fromState: "DISCOVERED", toState: "AUDITING", payload: {} }),
  );
  return { h, taskId, envelopeReferenceId };
}

interface LeaseInput {
  readonly leaseId?: string;
  readonly holder?: string;
  readonly expiresAt?: string;
  readonly transitionId?: string;
  readonly revisionNumber?: number;
  readonly attemptNumber?: number;
}

function leaseEvent(taskId: string, type: "LEASE_ACQUIRED" | "LEASE_REVOKED", input: LeaseInput = {}): Record<string, unknown> {
  const leaseId = input.leaseId ?? "11111111-1111-4111-8111-111111111111";
  const base = {
    revisionNumber: input.revisionNumber ?? 1,
    attemptNumber: input.attemptNumber ?? 1,
    leaseId,
    worktreePath: "/tmp/acp-p17a-worktree",
    holder: input.holder ?? WRITER,
  };
  return taskEvent({
    taskId,
    type,
    transitionId: input.transitionId ?? (type === "LEASE_ACQUIRED" ? "lease.1.acquired" : "lease.1.revoked"),
    payload:
      type === "LEASE_ACQUIRED"
        ? { ...base, acquiredAt: AT, expiresAt: input.expiresAt ?? LEASE_EXPIRES_AT }
        : { ...base, cause: "released" },
  });
}

function receiptValue(taskId: string, overrides: Record<string, unknown> = {}, runId = 1): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId,
    revisionNumber: 1,
    attemptNumber: 1,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    treeSha: "89abcdef0123456789abcdef0123456789abcdef",
    objectFormat: "sha1",
    policySha256: POLICY,
    declaredWriteSet: WRITE_SET,
    observedTrackedChanges: [{ path: "src/a.ts", sha256: "a".repeat(64) }],
    observedUntrackedPaths: [],
    writer: { identity: WRITER, workerId: writerWorkerIdFor(taskId, 1) },
    verifier: { identity: VERIFIER, workerId: supervisedWorkerIdFor(taskId, 1, "verifier", runId), runId },
    runStatus: "PASS",
    checks: COMMANDS.map((command, index) => ({ command, exitCode: 0, ranAt: "2026-09-27T11:0" + String(index) + ":00.000Z" })),
    commitMessageBody: BODY,
    pushAuthorized: false,
    ...overrides,
  };
}

function recordOf(receipt: Record<string, unknown>, artifactReferenceId: string): Record<string, unknown> {
  const columns = receiptVerificationColumns(receipt);
  return {
    receiptSha256: columns.receiptSha256,
    artifactReferenceId,
    baseSha: columns.baseSha,
    treeSha: columns.treeSha,
    policySha256: columns.policySha256,
    writeSetSha256: columns.writeSetSha256,
    checksSha256: columns.checksSha256,
    runStatus: columns.runStatus,
    allChecksZero: columns.allChecksZero,
    writer: { ...columns.writer },
    verifier: { ...columns.verifier },
  };
}

interface Receipt {
  readonly receipt: Record<string, unknown>;
  readonly receiptSha256: string;
  readonly artifactReferenceId: string;
}

/** Publish a receipt and record it in receipt form through the door. */
function recordReceipt(t: Task, overrides: Record<string, unknown> = {}, runId = 1, recordedAt = AT): Receipt {
  const receipt = receiptValue(t.taskId, overrides, runId);
  const artifactReferenceId = "ref-receipt-" + randomUUID();
  publish(t.h, Buffer.from(JSON.stringify(receipt), "utf8"), artifactReferenceId, "RECEIPT", t.taskId);
  const record = recordOf(receipt, artifactReferenceId);
  t.h.ledger.append(
    taskEvent({
      taskId: t.taskId,
      type: "VERIFICATION_COMPLETED",
      transitionId: "verification.run." + String(runId),
      recordedAt,
      payload: { revisionNumber: 1, attemptNumber: 1, verification: record },
    }),
  );
  return { receipt, receiptSha256: record["receiptSha256"] as string, artifactReferenceId };
}

function evidenceBytes(taskId: string, receiptSha256: string, verdict: string, runId: number): Buffer {
  const rules = ["CHANGES_WITHIN_WRITE_SET", "DIFF_PRESENT_FOR_COMMIT", "INDEPENDENT_IDS", "POLICY_MATCHES_ENVELOPE", "RECEIPT_BYTES_MATCH", "RECEIPT_PASS"].map(
    (rule, index) => ({ rule, outcome: verdict !== "ACCEPT" && index === 0 ? "FAIL" : "PASS" }),
  );
  return Buffer.from(
    canonicalJsonStringify({
      evidenceVersion: "acp/audit-evidence/v1",
      receiptSha256,
      treeSha: "89abcdef0123456789abcdef0123456789abcdef",
      auditor: { identity: AUDITOR, workerId: supervisedWorkerIdFor(taskId, 1, "reviewer", runId), runId },
      verdict,
      rules,
    }),
    "utf8",
  );
}

/** Publish evidence and record a verdict in verdict form through the door; its audit id. */
function recordVerdict(t: Task, receipt: Receipt, verdict = "ACCEPT", runId = 1): string {
  const artifactReferenceId = "ref-evidence-" + randomUUID();
  const evidenceSha256 = publish(t.h, evidenceBytes(t.taskId, receipt.receiptSha256, verdict, runId), artifactReferenceId, "EVIDENCE", t.taskId);
  const auditId = randomUUID();
  t.h.ledger.append(
    taskEvent({
      taskId: t.taskId,
      type: "AUDIT_COMPLETED",
      transitionId: "audit.run." + String(runId),
      eventId: auditId,
      payload: {
        revisionNumber: 1,
        attemptNumber: 1,
        auditVerdict: {
          receiptSha256: receipt.receiptSha256,
          treeSha: "89abcdef0123456789abcdef0123456789abcdef",
          writerWorkerId: writerWorkerIdFor(t.taskId, 1),
          auditor: { identity: AUDITOR, workerId: supervisedWorkerIdFor(t.taskId, 1, "reviewer", runId), runId },
          verdict,
          evidenceSha256,
          artifactReferenceId,
        },
      },
    }),
  );
  return auditId;
}

function messageDigest(receiptSha256: string, body = BODY): string {
  return sha256(commitMessageWithReceiptTrailer(body, receiptSha256));
}

interface AuthorizationInput {
  readonly receiptSha256: string;
  readonly auditId: string;
  readonly commitMessageSha256?: string;
  readonly transitionId?: string;
  readonly recordedAt?: string;
  readonly fromState?: string;
  readonly toState?: string;
  readonly record?: unknown;
  readonly payload?: Record<string, unknown>;
}

function authorizationEvent(taskId: string, input: AuthorizationInput): Record<string, unknown> {
  return taskEvent({
    taskId,
    type: "COMMIT_AUTHORIZED",
    transitionId: input.transitionId ?? "commit.authorized.1",
    ...(input.recordedAt === undefined ? {} : { recordedAt: input.recordedAt }),
    ...(input.fromState === undefined ? {} : { fromState: input.fromState }),
    ...(input.toState === undefined ? {} : { toState: input.toState }),
    payload: input.payload ?? {
      revisionNumber: 1,
      attemptNumber: 1,
      [COMMIT_AUTHORIZATION_KEY]: input.record ?? {
        receiptSha256: input.receiptSha256,
        auditId: input.auditId,
        commitMessageSha256: input.commitMessageSha256 ?? messageDigest(input.receiptSha256),
      },
    },
  });
}

interface Ready extends Task {
  readonly receipt: Receipt;
  readonly auditId: string;
}

/** A task in AUDITING with its lease, a PASS receipt and an ACCEPT verdict recorded. */
function ready(input: TaskInput & { readonly lease?: LeaseInput | null } = {}, h?: Harness): Ready {
  const t = task(input, h);
  if (input.lease !== null) t.h.ledger.append(leaseEvent(t.taskId, "LEASE_ACQUIRED", input.lease ?? {}));
  const receipt = recordReceipt(t);
  const auditId = recordVerdict(t, receipt);
  return { ...t, receipt, auditId };
}

function refusalOf(action: () => unknown): { readonly reason: string; readonly at: string } {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof LedgerCommitAuthorizationRefusedError || error instanceof LedgerVerificationRefusedError) {
      return { reason: error.reason, at: error.at };
    }
    throw error;
  }
  throw new Error("expected a refusal, and the action was admitted");
}

function rows(path: string): readonly Record<string, unknown>[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare("SELECT * FROM commit_authorization_read_model ORDER BY task_id, receipt_sha256").all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

/** A refusal by name wrote nothing: no authorization row, and the head unmoved. */
function refusedCleanly(h: Harness, action: () => unknown): { readonly reason: string; readonly at: string } {
  const before = h.ledger.status();
  const count = rows(h.path).length;
  const refusal = refusalOf(action);
  const after = h.ledger.status();
  expect(after.headSequence).toBe(before.headSequence);
  expect(after.headEventSha256).toBe(before.headEventSha256);
  expect(rows(h.path)).toHaveLength(count);
  return refusal;
}

/** Plant one contract-valid event on the task stream with a correct hash chain, past the door. */
function plantChainedEvent(path: string, event: Record<string, unknown>): void {
  const raw = new Database(path);
  try {
    const meta = new Map(
      (raw.prepare("SELECT key, value FROM ledger_meta").all() as { key: string; value: string }[]).map((row) => [row.key, row.value]),
    );
    const previousSha256 = meta.get("head_event_sha256") ?? GENESIS_SHA256;
    const eventCount = Number(meta.get("event_count") ?? "0");
    const canonicalJson = canonicalJsonStringify(event);
    const eventSha256 = chainDigest(previousSha256, canonicalJson);
    const payload = event["payload"] as Record<string, unknown>;
    const info = raw
      .prepare(
        "INSERT INTO control_plane_events (" +
          "event_id, idempotency_key, task_id, attempt, revision_number, attempt_number, " +
          "transition_id, type, from_state, to_state, emitted_by, occurred_at, recorded_at, " +
          "correlation_id, causation_id, contract_version, event_json, previous_sha256, " +
          "event_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event["eventId"],
        event["idempotencyKey"],
        event["taskId"],
        event["attempt"],
        payload["revisionNumber"] ?? null,
        payload["attemptNumber"] ?? null,
        event["transitionId"],
        event["type"],
        event["fromState"],
        event["toState"],
        event["emittedBy"],
        event["occurredAt"],
        event["recordedAt"],
        null,
        null,
        event["contractVersion"],
        canonicalJson,
        previousSha256,
        eventSha256,
      );
    const update = raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?");
    update.run(String(Number(info.lastInsertRowid)), "head_sequence");
    update.run(String(eventCount + 1), "event_count");
    update.run(eventSha256, "head_event_sha256");
  } finally {
    raw.close();
  }
}

function raw(path: string, sql: string, ...parameters: unknown[]): void {
  const db = new Database(path);
  try {
    db.prepare(sql).run(...parameters);
  } finally {
    db.close();
  }
}

// ===========================================================================
// The vocabulary and the barrel
// ===========================================================================

describe("the vocabulary and the barrel (ND-8, ND-13)", () => {
  it("is one closed, sorted list of upper-case words, exported with its class and the predicate", () => {
    expect([...COMMIT_AUTHORIZATION_REFUSALS]).toEqual([...COMMIT_AUTHORIZATION_REFUSALS].sort());
    expect(new Set(COMMIT_AUTHORIZATION_REFUSALS).size).toBe(COMMIT_AUTHORIZATION_REFUSALS.length);
    for (const word of COMMIT_AUTHORIZATION_REFUSALS) expect(word).toMatch(/^[A-Z][A-Z_]*$/);
    // P-17/B (ADR 0127; ND-7): the two revalidation words join, 26 -> 28.
    expect(COMMIT_AUTHORIZATION_REFUSALS).toHaveLength(28);
    expect(COMMIT_AUTHORIZATION_REFUSALS).toContain("REVALIDATED_BASE_MISMATCH");
    expect(COMMIT_AUTHORIZATION_REFUSALS).toContain("REVALIDATED_TREE_MISMATCH");
    expect(ledgerBarrel.COMMIT_AUTHORIZATION_REFUSALS).toBe(COMMIT_AUTHORIZATION_REFUSALS);
    // P-17/B (ND-17): the writer reads the one lease fold through the barrel.
    expect(ledgerBarrel.recordedLeaseOf).toBe(recordedLeaseOf);
    expect(ledgerBarrel.LedgerCommitAuthorizationRefusedError).toBe(LedgerCommitAuthorizationRefusedError);
    expect(ledgerBarrel.commitAuthorizationInForce).toBe(commitAuthorizationInForce);
    for (const name of ["decideCommitAuthorizationRecord", "readCommitAuthorizationArtifacts", "assertCommitAuthorizationArtifacts"]) {
      expect(Object.keys(ledgerBarrel), name).not.toContain(name);
    }
    const error = new LedgerCommitAuthorizationRefusedError("LEASE_ABSENT", "lease");
    expect(error.code).toBe("LEDGER_COMMIT_AUTHORIZATION_REFUSED");
    expect(error.message).toBe("the commit authorization was refused: LEASE_ABSENT at lease");
  });
});

// ===========================================================================
// The in-force predicate and the recorded lease, pure (P5, B3, B4, N5, N6)
// ===========================================================================

describe("the in-force predicate (execution §10.5 Vigencia)", () => {
  const lease = { leaseId: "l1", holder: WRITER, expiresAt: LEASE_EXPIRES_AT };
  const base = { state: "INTENDED" as const, authorizedAt: AT, writerIdentity: WRITER, lease };

  it("P5: holds when every condition holds, and fails each by its own word", () => {
    expect(commitAuthorizationInForce(base)).toEqual({ inForce: true });
    for (const [label, input, reason, at] of [
      ["no row", { ...base, state: null }, "AUTHORIZATION_STATE_INVALID", "state"],
      ["superseded", { ...base, state: "SUPERSEDED" as const }, "AUTHORIZATION_STATE_INVALID", "state"],
      ["outcome unknown", { ...base, state: "OUTCOME_UNKNOWN" as const }, "AUTHORIZATION_STATE_INVALID", "state"],
      ["no lease", { ...base, lease: null }, "LEASE_ABSENT", "lease"],
      ["offset lease instant", { ...base, lease: { ...lease, expiresAt: "2026-09-27T15:00:00.000+02:00" } }, "LEASE_INSTANT_NOT_CANONICAL", "lease.expiresAt"],
      ["no millis", { ...base, lease: { ...lease, expiresAt: "2026-09-27T13:00:00Z" } }, "LEASE_INSTANT_NOT_CANONICAL", "lease.expiresAt"],
      ["offset authorization", { ...base, authorizedAt: "2026-09-27T14:00:00.000+02:00" }, "RECORDED_AT_NOT_CANONICAL", "authorizedAt"],
      ["another holder", { ...base, lease: { ...lease, holder: OTHER_WRITER } }, "LEASE_HOLDER_MISMATCH", "lease.holder"],
      ["equal instants", { ...base, authorizedAt: LEASE_EXPIRES_AT }, "LEASE_EXPIRED", "lease.expiresAt"],
      ["after expiry", { ...base, authorizedAt: "2026-09-27T13:00:00.001Z" }, "LEASE_EXPIRED", "lease.expiresAt"],
    ] as const) {
      expect({ label, answer: commitAuthorizationInForce(input) }).toEqual({ label, answer: { inForce: false, reason, at } });
    }
  });

  it("B3: one millisecond before expiry is live; the absent lease is refused before any comparison", () => {
    expect(commitAuthorizationInForce({ ...base, authorizedAt: "2026-09-27T12:59:59.999Z" })).toEqual({ inForce: true });
    // An absent lease never reaches the instant: a malformed authorization instant is not what is named.
    expect(commitAuthorizationInForce({ ...base, lease: null, authorizedAt: "not an instant" })).toEqual({
      inForce: false,
      reason: "LEASE_ABSENT",
      at: "lease",
    });
  });

  it("condition 3: every revalidated equality it is given holds, and an absent member is not judged", () => {
    const pair = { reason: "POLICY_DIGEST_MISMATCH" as const, at: "policy", authorized: "a", observed: "a" };
    expect(commitAuthorizationInForce({ ...base, revalidated: [pair] })).toEqual({ inForce: true });
    expect(commitAuthorizationInForce({ ...base, revalidated: [pair, { ...pair, reason: "WRITE_SET_MISMATCH", at: "writeSet", observed: "b" }] })).toEqual({
      inForce: false,
      reason: "WRITE_SET_MISMATCH",
      at: "writeSet",
    });
  });

  it("P-17/B (ND-7): base and tree against Git are refused through revalidated by their own words, first difference first", () => {
    const same = { authorized: "1".repeat(40), observed: "1".repeat(40) };
    const baseMoved = { reason: "REVALIDATED_BASE_MISMATCH" as const, at: "baseSha", authorized: "1".repeat(40), observed: "2".repeat(40) };
    const treeMoved = { reason: "REVALIDATED_TREE_MISMATCH" as const, at: "treeSha", authorized: "3".repeat(40), observed: "4".repeat(40) };
    expect(commitAuthorizationInForce({ ...base, revalidated: [{ ...baseMoved, ...same }, { ...treeMoved, ...same }] })).toEqual({ inForce: true });
    expect(commitAuthorizationInForce({ ...base, revalidated: [baseMoved, treeMoved] })).toEqual({ inForce: false, reason: "REVALIDATED_BASE_MISMATCH", at: "baseSha" });
    expect(commitAuthorizationInForce({ ...base, revalidated: [{ ...baseMoved, ...same }, treeMoved] })).toEqual({ inForce: false, reason: "REVALIDATED_TREE_MISMATCH", at: "treeSha" });
    // The row and the lease are judged before any revalidated pair.
    expect(commitAuthorizationInForce({ ...base, state: "SUPERSEDED", revalidated: [baseMoved] })).toEqual({ inForce: false, reason: "AUTHORIZATION_STATE_INVALID", at: "state" });
  });

  it("B4, N5: the recorded lease is the last acquired of the attempt, a renewal extends it, a revocation removes it", () => {
    const acquired = (leaseId: string, expiresAt: string, coordinate: readonly [number, number] = [1, 1]): RecordedLeaseEvent => ({
      type: "LEASE_ACQUIRED",
      payload: { revisionNumber: coordinate[0], attemptNumber: coordinate[1], leaseId, holder: WRITER, expiresAt },
    });
    const revoked = (leaseId: string): RecordedLeaseEvent => ({
      type: "LEASE_REVOKED",
      payload: { revisionNumber: 1, attemptNumber: 1, leaseId, holder: WRITER },
    });
    expect(recordedLeaseOf([], 1, 1)).toBeNull();
    expect(recordedLeaseOf([acquired("l1", AT)], 1, 1)).toEqual({ leaseId: "l1", holder: WRITER, expiresAt: AT });
    // A renewal with a later expiry is the lease.
    expect(recordedLeaseOf([acquired("l1", AT), acquired("l1", LATER)], 1, 1)?.expiresAt).toBe(LATER);
    // Reclaim: a later id is the attempt's lease.
    expect(recordedLeaseOf([acquired("l1", LATER), acquired("l2", AT)], 1, 1)?.leaseId).toBe("l2");
    // The last acquired id revoked: absent. A revoked id is never resurrected.
    expect(recordedLeaseOf([acquired("l1", AT), revoked("l1")], 1, 1)).toBeNull();
    expect(recordedLeaseOf([acquired("l1", AT), revoked("l1"), acquired("l1", LATER)], 1, 1)).toBeNull();
    expect(recordedLeaseOf([acquired("l1", AT), acquired("l2", AT), revoked("l2")], 1, 1)).toBeNull();
    // Only the attempt's own coordinate is read (ND-6's refinement).
    expect(recordedLeaseOf([acquired("l1", AT, [1, 2])], 1, 1)).toBeNull();
    expect(recordedLeaseOf([acquired("l1", AT, [2, 1])], 1, 1)).toBeNull();
    // A payload that is not a lease is not one.
    expect(recordedLeaseOf([{ type: "LEASE_ACQUIRED", payload: { revisionNumber: 1, attemptNumber: 1, leaseId: 7 } }], 1, 1)).toBeNull();
  });
});

// ===========================================================================
// The decision over a hand-built view (N2, N3, N4, N7, N9; the fold's word)
// ===========================================================================

describe("the decision, pure over its view", () => {
  const TASK = "33333333-3333-4333-8333-333333333333";
  const R1 = "1".repeat(64);
  const R2 = "2".repeat(64);
  const AUDIT = "4a4a4a4a-4444-4444-8444-44444444444a";

  function receiptRow(overrides: Partial<VerificationReadModel> = {}): VerificationReadModel {
    return {
      receiptSha256: R1,
      taskId: TASK,
      revisionNumber: 1,
      attemptNumber: 1,
      verifierIdentity: VERIFIER,
      verifierWorkerId: "v",
      verifierRunId: 1,
      writerIdentity: WRITER,
      writerWorkerId: "w",
      baseSha: "0".repeat(40),
      treeSha: "1".repeat(40),
      policySha256: POLICY,
      writeSetSha256: "3".repeat(64),
      artifactReferenceId: "ref",
      checksSha256: "4".repeat(64),
      runStatus: "PASS",
      allChecksZero: true,
      recordedAt: AT,
      sequence: 4,
      ...overrides,
    };
  }

  function verdictRow(overrides: Partial<AuditVerdictReadModel> = {}): AuditVerdictReadModel {
    return {
      auditId: AUDIT,
      taskId: TASK,
      revisionNumber: 1,
      attemptNumber: 1,
      receiptSha256: R1,
      treeSha: "1".repeat(40),
      writerWorkerId: "w",
      auditorIdentity: AUDITOR,
      auditorWorkerId: "a",
      auditorRunId: 1,
      verdict: "ACCEPT",
      evidenceSha256: "5".repeat(64),
      artifactReferenceId: "ref-e",
      recordedAt: AT,
      sequence: 5,
      ...overrides,
    };
  }

  interface ViewInput {
    readonly policy?: string | null;
    readonly receipts?: readonly VerificationReadModel[];
    readonly verdicts?: readonly AuditVerdictReadModel[];
    readonly authorizations?: readonly CommitAuthorizationReadModel[];
    readonly leases?: readonly RecordedLeaseEvent[];
  }

  function view(input: ViewInput = {}): CommitAuthorizationDecisionView {
    const receipts = input.receipts ?? [receiptRow()];
    const verdicts = input.verdicts ?? [verdictRow()];
    return {
      commitPolicy: () => (input.policy === undefined ? "LOCAL_COMMIT_WITH_RECEIPT" : input.policy),
      verification: (digest) => receipts.find((row) => row.receiptSha256 === digest) ?? null,
      auditVerdict: (auditId) => verdicts.find((row) => row.auditId === auditId) ?? null,
      lastReceipt: (taskId) =>
        [...receipts].filter((row) => row.taskId === taskId).sort((a, b) => b.sequence - a.sequence)[0] ?? null,
      commitAuthorizations: (taskId) => (input.authorizations ?? []).filter((row) => row.taskId === taskId),
      leaseEvents: () =>
        input.leases ?? [
          {
            type: "LEASE_ACQUIRED",
            payload: { revisionNumber: 1, attemptNumber: 1, leaseId: "l1", holder: WRITER, expiresAt: LEASE_EXPIRES_AT },
          },
        ],
    };
  }

  function event(overrides: Record<string, unknown> = {}, record: Record<string, unknown> = {}): ControlPlaneEvent {
    return {
      ...taskEvent({
        taskId: TASK,
        type: "COMMIT_AUTHORIZED",
        transitionId: "commit.authorized.1",
        payload: {
          revisionNumber: 1,
          attemptNumber: 1,
          [COMMIT_AUTHORIZATION_KEY]: { receiptSha256: R1, auditId: AUDIT, commitMessageSha256: "6".repeat(64), ...record },
        },
      }),
      ...overrides,
    } as unknown as ControlPlaneEvent;
  }

  function decide(v: CommitAuthorizationDecisionView, e: ControlPlaneEvent): { readonly reason: string; readonly at: string } {
    return refusalOf(() => decideCommitAuthorizationRecord(v, e, 9));
  }

  it("grants the candidate row INTENDED, with the event's instant and sequence twice", () => {
    expect(decideCommitAuthorizationRecord(view(), event(), 9)).toEqual({
      row: {
        taskId: TASK,
        receiptSha256: R1,
        revisionNumber: 1,
        attemptNumber: 1,
        auditId: AUDIT,
        commitMessageSha256: "6".repeat(64),
        authorizedAt: AT,
        authorizedSequence: 9,
        state: "INTENDED",
        commitSha: null,
        supersededByReceiptSha256: null,
        recordedAt: AT,
        sequence: 9,
      },
      recorded: false,
    });
  });

  it("N7: the grammar -- the V1 bare form stands, the record is closed at every level, and placed same-state in AUDITING", () => {
    // ND-2: the P7C pilot's bare candidate on a V1 subject projects nothing.
    const bare = { ...event(), payload: { taskId: TASK, receiptSha256: R1, authorizedBy: COORDINATOR } } as unknown as ControlPlaneEvent;
    expect(decideCommitAuthorizationRecord(view(), bare, 9)).toBeNull();
    // Any other type without the key is none of this decision's business.
    expect(decideCommitAuthorizationRecord(view(), { ...event(), type: "TASK_STATE_CHANGED", payload: {} } as unknown as ControlPlaneEvent, 9)).toBeNull();
    const cases: readonly (readonly [string, ControlPlaneEvent, string, string])[] = [
      ["key on V1", { ...bare, payload: { [COMMIT_AUTHORIZATION_KEY]: {} } } as unknown as ControlPlaneEvent, "AUTHORIZATION_RECORD_INVALID", "payload.commitAuthorization"],
      ["V2 without key", { ...event(), payload: { revisionNumber: 1, attemptNumber: 1 } } as unknown as ControlPlaneEvent, "AUTHORIZATION_RECORD_ABSENT", "payload.commitAuthorization"],
      ["key under another type", { ...event(), type: "VERIFICATION_COMPLETED" } as unknown as ControlPlaneEvent, "AUTHORIZATION_FORM_MISPLACED", "payload.commitAuthorization"],
      ["a state change", event({ toState: "READY_TO_COMMIT" }), "AUTHORIZATION_FORM_MISPLACED", "toState"],
      ["from VERIFYING", event({ fromState: "VERIFYING", toState: "VERIFYING" }), "AUTHORIZATION_FORM_MISPLACED", "fromState"],
      ["missing member", event({}, { auditId: undefined }), "AUTHORIZATION_RECORD_INVALID", "payload.commitAuthorization.auditId"],
      ["extra member", event({}, { authorizedBy: COORDINATOR }), "AUTHORIZATION_RECORD_INVALID", "payload.commitAuthorization"],
      ["uppercase receipt", event({}, { receiptSha256: "A".repeat(64) }), "AUTHORIZATION_RECORD_INVALID", "payload.commitAuthorization.receiptSha256"],
      ["uppercase audit id", event({}, { auditId: AUDIT.toUpperCase() }), "AUTHORIZATION_RECORD_INVALID", "payload.commitAuthorization.auditId"],
      ["short digest", event({}, { commitMessageSha256: "6".repeat(63) }), "AUTHORIZATION_RECORD_INVALID", "payload.commitAuthorization.commitMessageSha256"],
      ["extra payload key", { ...event(), payload: { ...event().payload, lease: 1 } } as unknown as ControlPlaneEvent, "AUTHORIZATION_RECORD_INVALID", "payload"],
      ["revision 0", { ...event(), payload: { ...event().payload, revisionNumber: 0 } } as unknown as ControlPlaneEvent, "AUTHORIZATION_RECORD_INVALID", "payload.revisionNumber"],
      ["offset instant", event({ recordedAt: "2026-09-27T14:00:00.000+02:00" }), "RECORDED_AT_NOT_CANONICAL", "recordedAt"],
    ];
    for (const [label, e, reason, at] of cases) {
      const record = e.payload[COMMIT_AUTHORIZATION_KEY];
      if (label === "missing member" && typeof record === "object" && record !== null) delete (record as Record<string, unknown>)["auditId"];
      expect({ label, ...decide(view(), e) }).toEqual({ label, reason, at });
    }
  });

  it("N1, N2, N3, N4: policy, receipt, verdict and last receipt, each by name", () => {
    const at = "payload.commitAuthorization";
    const cases: readonly (readonly [string, ViewInput, string, string])[] = [
      ["NO_COMMIT", { policy: "NO_COMMIT" }, "AUTHORIZATION_NO_COMMIT", "commitPolicy"],
      ["no policy recorded", { policy: null }, "AUTHORIZATION_POLICY_UNRECORDED", "commitPolicy"],
      ["receipt unrecorded", { receipts: [] }, "RECEIPT_UNRECORDED", at + ".receiptSha256"],
      ["receipt FAIL", { receipts: [receiptRow({ runStatus: "FAIL", allChecksZero: true })] }, "RECEIPT_NOT_PASS", at + ".receiptSha256"],
      ["receipt of another task", { receipts: [receiptRow({ taskId: "other" })] }, "RECEIPT_COORDINATE_MISMATCH", at + ".receiptSha256"],
      ["receipt of another revision", { receipts: [receiptRow({ revisionNumber: 2 })] }, "RECEIPT_COORDINATE_MISMATCH", at + ".receiptSha256"],
      ["receipt of another attempt", { receipts: [receiptRow({ attemptNumber: 2 })] }, "RECEIPT_COORDINATE_MISMATCH", at + ".receiptSha256"],
      ["verdict unrecorded", { verdicts: [] }, "VERDICT_UNRECORDED", at + ".auditId"],
      ["verdict on another receipt", { verdicts: [verdictRow({ receiptSha256: R2 })] }, "VERDICT_RECEIPT_MISMATCH", at + ".auditId"],
      ["REJECT", { verdicts: [verdictRow({ verdict: "REJECT" })] }, "VERDICT_NOT_ACCEPT", at + ".auditId"],
      ["ACCEPT_WITH_CORRECTIONS does not authorize", { verdicts: [verdictRow({ verdict: "ACCEPT_WITH_CORRECTIONS" })] }, "VERDICT_NOT_ACCEPT", at + ".auditId"],
      ["a later receipt", { receipts: [receiptRow(), receiptRow({ receiptSha256: R2, sequence: 7 })] }, "RECEIPT_NOT_LAST", at + ".receiptSha256"],
    ];
    for (const [label, input, reason, where] of cases) {
      expect({ label, ...decide(view(input), event()) }).toEqual({ label, reason, at: where });
    }
  });

  it("N5, N6: the lease, through the predicate, after every row-level check", () => {
    const acquired = (payload: Record<string, unknown>): RecordedLeaseEvent => ({
      type: "LEASE_ACQUIRED",
      payload: { revisionNumber: 1, attemptNumber: 1, leaseId: "l1", holder: WRITER, expiresAt: LEASE_EXPIRES_AT, ...payload },
    });
    const cases: readonly (readonly [string, readonly RecordedLeaseEvent[], string, string])[] = [
      ["none", [], "LEASE_ABSENT", "lease"],
      ["revoked", [acquired({}), { type: "LEASE_REVOKED", payload: { revisionNumber: 1, attemptNumber: 1, leaseId: "l1" } }], "LEASE_ABSENT", "lease"],
      ["another attempt's", [acquired({ attemptNumber: 2 })], "LEASE_ABSENT", "lease"],
      ["offset", [acquired({ expiresAt: "2026-09-27T15:00:00.000+02:00" })], "LEASE_INSTANT_NOT_CANONICAL", "lease.expiresAt"],
      ["another holder", [acquired({ holder: OTHER_WRITER })], "LEASE_HOLDER_MISMATCH", "lease.holder"],
      ["expired at the instant", [acquired({ expiresAt: AT })], "LEASE_EXPIRED", "lease.expiresAt"],
      ["expired before", [acquired({ expiresAt: "2026-09-27T11:59:59.999Z" })], "LEASE_EXPIRED", "lease.expiresAt"],
    ];
    for (const [label, leases, reason, at] of cases) {
      expect({ label, ...decide(view({ leases }), event()) }).toEqual({ label, reason, at });
    }
    // One millisecond before the event's instant is still an expired lease; one after is live.
    expect(decideCommitAuthorizationRecord(view({ leases: [acquired({ expiresAt: "2026-09-27T12:00:00.001Z" })] }), event(), 9)?.row.state).toBe("INTENDED");
  });

  it("N9, ND-8: the key held with the same metadata is kept; other metadata is corruption; another live row blocks", () => {
    const granted = decideCommitAuthorizationRecord(view(), event(), 9);
    if (granted === null) throw new Error("expected a grant");
    const held = granted.row;
    expect(decideCommitAuthorizationRecord(view({ authorizations: [held] }), event(), 12)).toEqual({ row: held, recorded: true });
    const at = "payload.commitAuthorization";
    expect(decide(view({ authorizations: [held] }), event({}, { commitMessageSha256: "7".repeat(64) }))).toEqual({
      reason: "AUTHORIZATION_METADATA_CONFLICT",
      at: at + ".receiptSha256",
    });
    // The same key in another state is not a replay.
    expect(decide(view({ authorizations: [{ ...held, state: "OUTCOME_UNKNOWN" }] }), event())).toEqual({
      reason: "AUTHORIZATION_STATE_INVALID",
      at: at + ".receiptSha256",
    });
    // Another row of the task INTENDED or OUTCOME_UNKNOWN blocks a new one (execution :851-853).
    for (const state of ["INTENDED", "OUTCOME_UNKNOWN"] as const) {
      expect(decide(view({ authorizations: [{ ...held, receiptSha256: R2, state }] }), event())).toEqual({
        reason: "AUTHORIZATION_STATE_INVALID",
        at,
      });
    }
    // A SUPERSEDED row of the task does not.
    expect(
      decideCommitAuthorizationRecord(
        view({ authorizations: [{ ...held, receiptSha256: R2, state: "SUPERSEDED", supersededByReceiptSha256: R1 }] }),
        event(),
        9,
      )?.recorded,
    ).toBe(false);
  });

  it("ND-4: a new receipt supersedes the task's INTENDED row over another receipt, and nothing else", () => {
    const granted = decideCommitAuthorizationRecord(view(), event(), 9);
    if (granted === null) throw new Error("expected a grant");
    const next = receiptRow({ receiptSha256: R2, recordedAt: LATER, sequence: 14 });
    expect(decideCommitAuthorizationSupersession(view({ authorizations: [granted.row] }), next)).toEqual({
      ...granted.row,
      state: "SUPERSEDED",
      supersededByReceiptSha256: R2,
      recordedAt: LATER,
      sequence: 14,
    });
    expect(decideCommitAuthorizationSupersession(view({ authorizations: [granted.row] }), receiptRow())).toBeNull();
    expect(decideCommitAuthorizationSupersession(view({ authorizations: [] }), next)).toBeNull();
    expect(decideCommitAuthorizationSupersession(view({ authorizations: [{ ...granted.row, state: "OUTCOME_UNKNOWN" }] }), next)).toBeNull();
  });

  it("B1: the largest record-form payload fits the event budget", () => {
    const payload = {
      revisionNumber: 10_000,
      attemptNumber: 10_000,
      [COMMIT_AUTHORIZATION_KEY]: { receiptSha256: "f".repeat(64), auditId: AUDIT, commitMessageSha256: "f".repeat(64) },
    };
    expect(Buffer.byteLength(canonicalJsonStringify(payload), "utf8")).toBeLessThan(EVENT_PAYLOAD_MAX_BYTES);
  });
});

// ===========================================================================
// The door, on a real ledger (P1-P4, P7, N1, N4, N5, N8, N11, N13)
// ===========================================================================

describe("P1-P4: a commit authorization is recorded through the real door", () => {
  it("P1: append records one INTENDED row, every column the derivation; the reader returns it", () => {
    const r = ready();
    const candidate = authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId });
    const appended = r.h.ledger.append(candidate);
    expect(appended.inserted).toBe(true);
    const sequence = appended.record.sequence;
    const expected: CommitAuthorizationReadModel = {
      taskId: r.taskId,
      receiptSha256: r.receipt.receiptSha256,
      revisionNumber: 1,
      attemptNumber: 1,
      auditId: r.auditId,
      commitMessageSha256: sha256(BODY + "\n\nACP-Receipt: " + r.receipt.receiptSha256 + "\n"),
      authorizedAt: AT,
      authorizedSequence: sequence,
      state: "INTENDED",
      commitSha: null,
      supersededByReceiptSha256: null,
      recordedAt: AT,
      sequence,
    };
    expect(r.h.ledger.getCommitAuthorization(r.taskId, r.receipt.receiptSha256)).toEqual(expected);
    expect(r.h.ledger.listCommitAuthorizations(r.taskId)).toEqual([expected]);
    expect(r.h.ledger.getCommitAuthorization(r.taskId, "0".repeat(64))).toBeNull();
    // An exact replay returns the first record and writes nothing.
    const replay = r.h.ledger.append(candidate);
    expect(replay.inserted).toBe(false);
    expect(rows(r.h.path)).toHaveLength(1);
    expect(r.h.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("P1: the same through appendBatch, with the lease in the same batch; P2: step 8 is admitted after", () => {
    const t = task();
    const receipt = recordReceipt(t);
    const auditId = recordVerdict(t, receipt);
    const batch = t.h.ledger.appendBatch([
      leaseEvent(t.taskId, "LEASE_ACQUIRED"),
      authorizationEvent(t.taskId, { receiptSha256: receipt.receiptSha256, auditId }),
    ]);
    expect(batch.insertedCount).toBe(2);
    expect(t.h.ledger.getCommitAuthorization(t.taskId, receipt.receiptSha256)?.state).toBe("INTENDED");
    t.h.ledger.append(
      taskEvent({ taskId: t.taskId, type: "TASK_STATE_CHANGED", transitionId: "step.8", fromState: "AUDITING", toState: "READY_TO_COMMIT", payload: {} }),
    );
    expect(t.h.ledger.getTask(t.taskId)?.currentState).toBe("READY_TO_COMMIT");
    expect(t.h.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("P3, P4: a later receipt supersedes the row, a new authorization lands, and the rebuild reproduces both byte for byte", () => {
    const r = ready();
    const first = r.h.ledger.append(authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId }));
    const second = recordReceipt(r, { treeSha: "fedcba9876543210fedcba9876543210fedcba98" }, 2, LATER);
    const superseded = r.h.ledger.getCommitAuthorization(r.taskId, r.receipt.receiptSha256);
    const receiptSequence = r.h.ledger.getVerification(second.receiptSha256)?.sequence;
    expect(superseded).toMatchObject({
      state: "SUPERSEDED",
      supersededByReceiptSha256: second.receiptSha256,
      recordedAt: LATER,
      sequence: receiptSequence,
      authorizedAt: AT,
      authorizedSequence: first.record.sequence,
    });
    // The second receipt's verdict and authorization: the partial unique index holds one INTENDED row.
    const secondAudit = (() => {
      const artifactReferenceId = "ref-evidence-" + randomUUID();
      const evidence = JSON.parse(evidenceBytes(r.taskId, second.receiptSha256, "ACCEPT", 2).toString("utf8")) as Record<string, unknown>;
      const bytes = Buffer.from(canonicalJsonStringify({ ...evidence, treeSha: "fedcba9876543210fedcba9876543210fedcba98" }), "utf8");
      const evidenceSha256 = publish(r.h, bytes, artifactReferenceId, "EVIDENCE", r.taskId);
      const auditId = randomUUID();
      r.h.ledger.append(
        taskEvent({
          taskId: r.taskId,
          type: "AUDIT_COMPLETED",
          transitionId: "audit.run.2",
          eventId: auditId,
          payload: {
            revisionNumber: 1,
            attemptNumber: 1,
            auditVerdict: {
              receiptSha256: second.receiptSha256,
              treeSha: "fedcba9876543210fedcba9876543210fedcba98",
              writerWorkerId: writerWorkerIdFor(r.taskId, 1),
              auditor: { identity: AUDITOR, workerId: supervisedWorkerIdFor(r.taskId, 1, "reviewer", 2), runId: 2 },
              verdict: "ACCEPT",
              evidenceSha256,
              artifactReferenceId,
            },
          },
        }),
      );
      return auditId;
    })();
    r.h.ledger.append(
      authorizationEvent(r.taskId, { receiptSha256: second.receiptSha256, auditId: secondAudit, transitionId: "commit.authorized.2", recordedAt: LATER }),
    );
    expect(r.h.ledger.listCommitAuthorizations(r.taskId).map((row) => row.state)).toEqual(["SUPERSEDED", "INTENDED"]);
    // N4: the superseded receipt cannot be authorized again: it is not the last.
    expect(
      refusedCleanly(r.h, () =>
        r.h.ledger.append(authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId, transitionId: "commit.authorized.3" })),
      ),
    ).toEqual({ reason: "RECEIPT_NOT_LAST", at: "payload.commitAuthorization.receiptSha256" });

    const before = rows(r.h.path);
    expect(r.h.ledger.verifyIntegrity().problems).toEqual([]);
    r.h.ledger.rebuildReadModel();
    expect(rows(r.h.path)).toEqual(before);
    expect(r.h.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("A6: verifyIntegrity reports a planted divergence of a stored row", () => {
    const r = ready();
    r.h.ledger.append(authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId }));
    r.h.close();
    // A listed transition with no event behind it: the trigger admits the pair, and only
    // the replay can tell the row no longer says what the history does.
    raw(r.h.path, "UPDATE commit_authorization_read_model SET state = 'OUTCOME_UNKNOWN' WHERE task_id = ?", r.taskId);
    const again = harnessAt(r.h.path);
    const problems = again.ledger.verifyIntegrity().problems.map((problem) => problem.detail);
    expect(problems.some((detail) => detail.includes("commit_authorization_read_model row for " + r.taskId + " " + r.receipt.receiptSha256))).toBe(true);
  });
});

describe("the door refuses by name, and writes nothing (N1, N4, N5, N6, N8, ND-8)", () => {
  const at = "payload.commitAuthorization";

  function attempt(r: Ready, input: Partial<AuthorizationInput> = {}): () => unknown {
    return () => r.h.ledger.append(authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId, ...input }));
  }

  it("N1: a NO_COMMIT task, and a task with no recorded policy", () => {
    // The envelope itself must be committing for the receipt; the intake records NO_COMMIT.
    const r = ready({ commitPolicy: "NO_COMMIT" });
    expect(refusedCleanly(r.h, attempt(r))).toEqual({ reason: "AUTHORIZATION_NO_COMMIT", at: "commitPolicy" });
    const none = ready({ intake: false });
    expect(refusedCleanly(none.h, attempt(none))).toEqual({ reason: "AUTHORIZATION_POLICY_UNRECORDED", at: "commitPolicy" });
  });

  it("N5: no recorded lease, and a revoked one, refused before any comparison", () => {
    const r = ready({ lease: null });
    expect(refusedCleanly(r.h, attempt(r))).toEqual({ reason: "LEASE_ABSENT", at: "lease" });
    r.h.ledger.append(leaseEvent(r.taskId, "LEASE_ACQUIRED"));
    r.h.ledger.append(leaseEvent(r.taskId, "LEASE_REVOKED"));
    expect(refusedCleanly(r.h, attempt(r))).toEqual({ reason: "LEASE_ABSENT", at: "lease" });
  });

  it("N6: an offset lease instant, an expiry at the instant, and another holder", () => {
    const offset = ready({ lease: { expiresAt: "2026-09-27T15:00:00.000+02:00" } });
    expect(refusedCleanly(offset.h, attempt(offset))).toEqual({ reason: "LEASE_INSTANT_NOT_CANONICAL", at: "lease.expiresAt" });
    const equal = ready({ lease: { expiresAt: AT } });
    expect(refusedCleanly(equal.h, attempt(equal))).toEqual({ reason: "LEASE_EXPIRED", at: "lease.expiresAt" });
    const holder = ready({ lease: { holder: OTHER_WRITER } });
    expect(refusedCleanly(holder.h, attempt(holder))).toEqual({ reason: "LEASE_HOLDER_MISMATCH", at: "lease.holder" });
    // B3: one millisecond before the expiry is live.
    const live = ready({ lease: { expiresAt: "2026-09-27T12:00:00.001Z" } });
    expect(live.h.ledger.append(authorizationEvent(live.taskId, { receiptSha256: live.receipt.receiptSha256, auditId: live.auditId })).inserted).toBe(true);
  });

  it("N3: a REJECT verdict does not authorize", () => {
    const t = task();
    t.h.ledger.append(leaseEvent(t.taskId, "LEASE_ACQUIRED"));
    const receipt = recordReceipt(t);
    const auditId = recordVerdict(t, receipt, "REJECT");
    expect(
      refusedCleanly(t.h, () => t.h.ledger.append(authorizationEvent(t.taskId, { receiptSha256: receipt.receiptSha256, auditId }))),
    ).toEqual({ reason: "VERDICT_NOT_ACCEPT", at: at + ".auditId" });
  });

  it("N8: from bytes, the door's alone -- the message digest, the policy and the write-set", () => {
    const r = ready();
    expect(refusedCleanly(r.h, attempt(r, { commitMessageSha256: messageDigest(r.receipt.receiptSha256, BODY + " ") }))).toEqual({
      reason: "COMMIT_MESSAGE_DIGEST_MISMATCH",
      at: at + ".commitMessageSha256",
    });
    // The receipt's body alone, without its trailer, is another digest.
    expect(refusedCleanly(r.h, attempt(r, { commitMessageSha256: sha256(BODY) }))).toEqual({
      reason: "COMMIT_MESSAGE_DIGEST_MISMATCH",
      at: at + ".commitMessageSha256",
    });

    const policy = ready();
    // Re-point the revision at an envelope whose checks differ: the recomputed policy is not the receipt's.
    const other = "ref-envelope-other-" + randomUUID();
    publish(policy.h, Buffer.from(canonicalJsonStringify(envelopeValue(policy.taskId, { validation: { commands: ["pnpm test"], independentVerifierRequired: true } })), "utf8"), other, "TASK_ENVELOPE", policy.taskId);
    raw(policy.h.path, "UPDATE task_revision_read_model SET envelope_artifact_reference_id = ? WHERE task_id = ?", other, policy.taskId);
    expect(refusedCleanly(policy.h, attempt(policy))).toEqual({ reason: "POLICY_DIGEST_MISMATCH", at: "envelope.validation" });

    const writeSet = ready();
    const narrower = "ref-envelope-narrow-" + randomUUID();
    publish(writeSet.h, Buffer.from(canonicalJsonStringify(envelopeValue(writeSet.taskId, { writeSet: ["src/a.ts"] })), "utf8"), narrower, "TASK_ENVELOPE", writeSet.taskId);
    raw(writeSet.h.path, "UPDATE task_revision_read_model SET envelope_artifact_reference_id = ? WHERE task_id = ?", narrower, writeSet.taskId);
    expect(refusedCleanly(writeSet.h, attempt(writeSet))).toEqual({ reason: "WRITE_SET_MISMATCH", at: "envelope.writeSet" });

    const noCommit = ready();
    const flipped = "ref-envelope-nocommit-" + randomUUID();
    publish(noCommit.h, Buffer.from(canonicalJsonStringify(envelopeValue(noCommit.taskId, { commitPolicy: "NO_COMMIT" })), "utf8"), flipped, "TASK_ENVELOPE", noCommit.taskId);
    raw(noCommit.h.path, "UPDATE task_revision_read_model SET envelope_artifact_reference_id = ? WHERE task_id = ?", flipped, noCommit.taskId);
    expect(refusedCleanly(noCommit.h, attempt(noCommit))).toEqual({ reason: "AUTHORIZATION_NO_COMMIT", at: "envelope.commitPolicy" });

    const unreadable = ready();
    const text = "ref-envelope-text-" + randomUUID();
    publish(unreadable.h, Buffer.from("not an envelope\n", "utf8"), text, "TASK_ENVELOPE", unreadable.taskId);
    raw(unreadable.h.path, "UPDATE task_revision_read_model SET envelope_artifact_reference_id = ? WHERE task_id = ?", text, unreadable.taskId);
    expect(refusedCleanly(unreadable.h, attempt(unreadable))).toEqual({ reason: "ENVELOPE_UNREADABLE", at: "envelope" });

    const wrongClass = ready();
    const evidence = "ref-envelope-class-" + randomUUID();
    publish(wrongClass.h, Buffer.from(canonicalJsonStringify(envelopeValue(wrongClass.taskId)), "utf8"), evidence, "EVIDENCE", wrongClass.taskId);
    raw(wrongClass.h.path, "UPDATE task_revision_read_model SET envelope_artifact_reference_id = ? WHERE task_id = ?", evidence, wrongClass.taskId);
    expect(refusedCleanly(wrongClass.h, attempt(wrongClass))).toEqual({ reason: "ENVELOPE_REFERENCE_INVALID", at: "envelope.artifactReferenceId" });
  });

  it("ND-8: a task holding an OUTCOME_UNKNOWN row takes no new authorization (planted by raw SQL)", () => {
    const r = ready();
    const db = new Database(r.h.path);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO commit_authorization_read_model (task_id, receipt_sha256, revision_number, attempt_number, audit_id, " +
        "commit_message_sha256, authorized_at, authorized_sequence, state, commit_sha, superseded_by_receipt_sha256, recorded_at, sequence) " +
        "VALUES (?, ?, 1, 1, ?, ?, ?, 1, 'OUTCOME_UNKNOWN', NULL, NULL, ?, 1)",
    ).run(r.taskId, "9".repeat(64), r.auditId, "9".repeat(64), AT, AT);
    db.close();
    expect(refusedCleanly(r.h, attempt(r))).toEqual({ reason: "AUTHORIZATION_STATE_INVALID", at });
  });
});

describe("N11: decision 231's N-3 re-check runs under the lock (ND-10)", () => {
  it("a tombstoned or expired receipt or envelope reference is refused inside the transaction", () => {
    const cases: readonly (readonly [string, (r: Ready) => string, string, string])[] = [
      ["receipt tombstoned", (r) => r.receipt.artifactReferenceId, "tombstoned_at", "payload.commitAuthorization.receiptSha256.tombstonedAt"],
      ["receipt expired", (r) => r.receipt.artifactReferenceId, "expires_at", "payload.commitAuthorization.receiptSha256.expiresAt"],
      ["envelope tombstoned", (r) => r.envelopeReferenceId, "tombstoned_at", "envelope.artifactReferenceId.tombstonedAt"],
      ["envelope expired", (r) => r.envelopeReferenceId, "expires_at", "envelope.artifactReferenceId.expiresAt"],
    ];
    for (const [label, referenceOf, column, at] of cases) {
      const r = ready();
      // Planted after the door's read before the lock would have seen it, on the door's own
      // terms: the in-transaction re-assert reads the row again.
      const reason = column === "tombstoned_at" ? ", tombstone_reason = 'OWNER_REQUEST'" : "";
      raw(r.h.path, "UPDATE artifact_reference_read_model SET " + column + " = ?" + reason + " WHERE artifact_reference_id = ?", AT, referenceOf(r));
      const refusal = refusedCleanly(r.h, () =>
        r.h.ledger.append(authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId })),
      );
      expect({ label, ...refusal }).toEqual({
        label,
        reason: label.startsWith("receipt") ? "RECEIPT_REFERENCE_INVALID" : "ENVELOPE_REFERENCE_INVALID",
        at,
      });
    }
  });

  it("the door reads the receipt and the envelope by reference before its lock, as values", () => {
    const r = ready();
    const event = authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId }) as unknown as ControlPlaneEvent;
    const read = readCommitAuthorizationArtifacts(r.h.ledger, event);
    expect(read?.receipt?.referenceId).toBe(r.receipt.artifactReferenceId);
    expect(read?.envelope?.referenceId).toBe(r.envelopeReferenceId);
    expect(read?.receipt?.read.ok).toBe(true);
    expect(readCommitAuthorizationArtifacts(r.h.ledger, { ...event, type: "TASK_STATE_CHANGED" } as ControlPlaneEvent)).toBeNull();
  });
});

describe("the fold refuses what the door refuses, and a history before 29 (N13, P7)", () => {
  it("N13: a planted authorization on no lease is refused by name on rebuild and reported on verify", () => {
    const r = ready({ lease: null });
    r.h.close();
    plantChainedEvent(r.h.path, authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId }));
    const again = harnessAt(r.h.path);
    const problems = again.ledger.verifyIntegrity().problems.map((problem) => problem.detail);
    expect(problems.some((detail) => detail.includes("records a commit authorization the fold refuses: LEASE_ABSENT at lease"))).toBe(true);
    expect(refusalOf(() => again.ledger.rebuildReadModel())).toEqual({ reason: "LEASE_ABSENT", at: "lease" });
  });

  it("N13: a planted grammar violation is the door's word in the fold", () => {
    const r = ready();
    r.h.close();
    plantChainedEvent(r.h.path, authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId, toState: "READY_TO_COMMIT" }));
    const again = harnessAt(r.h.path);
    expect(refusalOf(() => again.ledger.rebuildReadModel())).toEqual({ reason: "AUTHORIZATION_FORM_MISPLACED", at: "toState" });
  });

  it("P7: a history rewound to 28 opens, migrates to 29 level with its head, verifies, rebuilds, then takes an authorization", () => {
    const r = ready();
    const head = r.h.ledger.status();
    r.h.close();
    const db = new Database(r.h.path);
    db.exec(
      "DROP TRIGGER tr_commit_authorization_read_model__transition; " +
        "DROP INDEX ux_commit_authorization_read_model__intended_task; " +
        "DROP INDEX ix_commit_authorization_read_model__attempt; " +
        "DROP TABLE commit_authorization_read_model; " +
        "DELETE FROM projection_watermark WHERE projection_name = 'commit_authorization_read_model';",
    );
    db.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(COMMIT_AUTHORIZATION_MIGRATION);
    const applied = (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
    db.close();
    expect(applied).toBe(VERIFICATION_AUDIT_MIGRATION);

    const again = harnessAt(r.h.path);
    expect(again.ledger.status().migrations.at(-1)?.version).toBe(COMMIT_AUTHORIZATION_MIGRATION);
    const mark = again.ledger.status().projections.find((projection) => projection.name === "commit_authorization_read_model");
    expect(mark?.watermarks.map((watermark) => [watermark.appliedThroughSequence, watermark.sourceHeadSha256])).toEqual([
      [head.headSequence, head.headEventSha256],
    ]);
    expect(again.ledger.verifyIntegrity().problems).toEqual([]);
    again.ledger.rebuildReadModel();
    expect(again.ledger.verifyIntegrity().problems).toEqual([]);
    expect(
      again.ledger.append(authorizationEvent(r.taskId, { receiptSha256: r.receipt.receiptSha256, auditId: r.auditId })).inserted,
    ).toBe(true);
    expect(again.ledger.getCommitAuthorization(r.taskId, r.receipt.receiptSha256)?.state).toBe("INTENDED");
  });
});
