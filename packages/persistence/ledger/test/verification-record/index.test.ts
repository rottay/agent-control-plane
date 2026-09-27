import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  EVENT_PAYLOAD_MAX_BYTES,
  WORKER_ROLES,
  buildIdempotencyKey,
  buildV2IdempotencyKey,
  type ControlPlaneEvent,
} from "@acp/contracts";

import * as ledgerBarrel from "../../src/index.js";
import {
  GENESIS_SHA256,
  LedgerEventIdConflictError,
  LedgerVerificationRefusedError,
  VERIFICATION_REFUSALS,
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  canonicalJsonStringify,
  chainDigest,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  supervisedWorkerIdFor,
  writerWorkerIdFor,
  type ArtifactBlobLeaseStore,
  type ArtifactPlane,
  type Ledger,
} from "../../src/index.js";
import { DERIVED_TABLES, VERIFICATION_AUDIT_MIGRATION } from "../../src/migrations/index.js";
import { receiptVerificationColumns } from "../../src/receipt-identity/index.js";
import {
  AUDIT_VERDICT_RECORD_KEYS,
  VERIFICATION_RECORD_KEYS,
  decideVerificationRecord,
  readVerificationArtifact,
  type VerificationDecisionView,
} from "../../src/verification-record/index.js";

/**
 * A verification is recorded by its receipt, and a verdict by its tree (P-16/B, ADR
 * 0122; execution §10.2-§10.3; decisions 231-233).
 *
 * The door is the ledger's own `append` and `appendBatch`, so every door test runs on
 * a real on-disk ledger with a real private-artifacts root: the receipt's bytes are
 * published through the plane as a `RECEIPT` reference scoped to the task, and the
 * door reads them back by that reference. The fold is exercised through
 * `rebuildReadModel()` and `verifyIntegrity()` over histories planted past the door;
 * `test/projection` holds the fold's corruption guards on hand-built streams, and
 * `test/migrations` the DDL. The positives are P1-P8, the negatives N1-N11 and the
 * boundaries B1-B5 of the brief (`.acp-local/evidence/p16-b/brief-v1.md` §4, with the
 * DT pre-review corrections B-1..B-5 and the stop ruling on `artifactReferenceId`).
 */

const AT = "2026-09-26T12:00:00.000Z";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2026-12-31T00:00:00.000Z";
const COORDINATOR = "claude/opus/coordinator/01";
const PUBLISHER = "claude/opus/implementer/01";
const WRITER = "claude/opus/implementer/01";
const VERIFIER = "claude/sonnet/verifier/01";
const AUDITOR = "claude/sonnet/reviewer/01";
/**
 * The spawn registry's ids (P-16/C, ADR 0123): the verifier and the auditor are named by
 * their spawn, `supervisedWorkerIdFor(task, flat, role, runId)`, and the door refuses
 * any other. Restamped by derivation from B's fixed ids, never by lifting a value.
 */
function verifierIdOf(taskId: string, flat = 1, runId = 1): string {
  return supervisedWorkerIdFor(taskId, flat, "verifier", runId);
}
function auditorIdOf(taskId: string, flat = 1, runId = 1): string {
  return supervisedWorkerIdFor(taskId, flat, "reviewer", runId);
}
const ENVELOPE_REFERENCE = "ref-envelope";
const STATE = "DISCOVERED";

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
// Substrates: a ledger, its blob lease file and its private plane
// ---------------------------------------------------------------------------

interface Harness {
  readonly path: string;
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  readonly leaseStore: ArtifactBlobLeaseStore;
  /** Close both handles, as a process that ends would. */
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
  const directory = mkdtempSync(join(tmpdir(), "acp-p16b-"));
  directories.push(directory);
  return harnessAt(join(directory, "control-plane.sqlite"));
}

/** Publish bytes under one reference through the real plane; the plane's content digest. */
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

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

// ---------------------------------------------------------------------------
// Task events
// ---------------------------------------------------------------------------

interface EventInput {
  readonly taskId: string;
  readonly type: ControlPlaneEvent["type"];
  readonly transitionId: string;
  readonly flat: number;
  readonly payload: Record<string, unknown>;
  readonly fromState?: string | null;
  readonly eventId?: string;
  readonly recordedAt?: string;
}

function taskEvent(input: EventInput): Record<string, unknown> {
  const revisionNumber = input.payload["revisionNumber"];
  const attemptNumber = input.payload["attemptNumber"];
  const v2 = typeof revisionNumber === "number" && typeof attemptNumber === "number";
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: input.eventId ?? randomUUID(),
    taskId: input.taskId,
    attempt: input.flat,
    transitionId: input.transitionId,
    idempotencyKey: v2
      ? buildV2IdempotencyKey({
          stream: "control_plane_events",
          taskId: input.taskId,
          revisionNumber,
          attemptNumber,
          transitionId: input.transitionId,
        })
      : buildIdempotencyKey({ taskId: input.taskId, attempt: input.flat, transitionId: input.transitionId }),
    type: input.type,
    fromState: input.fromState === undefined ? STATE : input.fromState,
    toState: STATE,
    emittedBy: COORDINATOR,
    occurredAt: AT,
    recordedAt: input.recordedAt ?? AT,
    correlationId: null,
    causationId: null,
    payload: input.payload,
  };
}

/** The envelope reference an attempt opening names, published once per ledger. */
function ensureEnvelope(h: Harness): void {
  if (h.ledger.getArtifactReference(ENVELOPE_REFERENCE) !== null) return;
  publish(h, Buffer.from("the envelope\n", "utf8"), ENVELOPE_REFERENCE, "TASK_ENVELOPE", "envelope");
}

interface Opening {
  readonly flat: number;
  readonly revisionNumber?: number;
  readonly attemptNumber?: number;
  readonly revisionId?: string;
  readonly first?: boolean;
}

const revisionIds = new Map<string, string>();

/** One revision id per (task, revision): a second attempt of a revision names the same. */
function revisionIdOf(taskId: string, revisionNumber: number): string {
  const key = taskId + "/" + String(revisionNumber);
  const known = revisionIds.get(key);
  if (known !== undefined) return known;
  const fresh = randomUUID();
  revisionIds.set(key, fresh);
  return fresh;
}

/** Open one V2 attempt through the door. */
function openAttempt(h: Harness, taskId: string, opening: Opening): void {
  ensureEnvelope(h);
  const revisionNumber = opening.revisionNumber ?? 1;
  const attemptNumber = opening.attemptNumber ?? 1;
  h.ledger.append(
    taskEvent({
      taskId,
      type: "TASK_ATTEMPT_OPENED",
      transitionId: "attempt.open." + String(opening.flat),
      flat: opening.flat,
      fromState: opening.first === false ? STATE : opening.flat === 1 ? null : STATE,
      payload: {
        revisionId: opening.revisionId ?? revisionIdOf(taskId, revisionNumber),
        revisionNumber,
        attemptNumber,
        envelopeSha256: "e".repeat(64),
        envelopeArtifactReferenceId: ENVELOPE_REFERENCE,
        invocationId: "inv-" + String(opening.flat),
        legacyAttemptNumber: opening.flat,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Receipts, records and verdicts
// ---------------------------------------------------------------------------

interface ReceiptInput {
  readonly taskId: string;
  readonly flat?: number;
  readonly revisionNumber?: number;
  readonly attemptNumber?: number;
  readonly overrides?: Record<string, unknown>;
}

function receiptValue(input: ReceiptInput): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: input.taskId,
    revisionNumber: input.revisionNumber ?? 1,
    attemptNumber: input.attemptNumber ?? 1,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    treeSha: "89abcdef0123456789abcdef0123456789abcdef",
    objectFormat: "sha1",
    policySha256: "c".repeat(64),
    declaredWriteSet: ["src/a.ts", "src/_x.ts", "src/B.ts"],
    observedTrackedChanges: [{ path: "src/a.ts", sha256: "a".repeat(64) }],
    observedUntrackedPaths: [],
    writer: { identity: WRITER, workerId: writerWorkerIdFor(input.taskId, input.flat ?? 1) },
    verifier: { identity: VERIFIER, workerId: verifierIdOf(input.taskId, input.flat ?? 1), runId: 1 },
    runStatus: "PASS",
    checks: [
      { command: "pnpm check", exitCode: 0, ranAt: "2026-09-26T11:00:00.000Z" },
      { command: "pnpm lint", exitCode: 0, ranAt: "2026-09-26T11:01:00.000Z" },
    ],
    commitMessageBody: "feat(runtime): a verified change",
    pushAuthorized: false,
    ...input.overrides,
  };
}

/** The receipt-form record a producer would carry for one receipt under one reference. */
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

interface FormInput {
  readonly taskId: string;
  readonly flat?: number;
  readonly revisionNumber?: number;
  readonly attemptNumber?: number;
  readonly transitionId?: string;
  readonly eventId?: string;
  readonly recordedAt?: string;
}

function verificationEvent(input: FormInput & { readonly record: unknown }): Record<string, unknown> {
  return taskEvent({
    taskId: input.taskId,
    type: "VERIFICATION_COMPLETED",
    transitionId: input.transitionId ?? "verify.1",
    flat: input.flat ?? 1,
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    ...(input.recordedAt === undefined ? {} : { recordedAt: input.recordedAt }),
    payload: {
      revisionNumber: input.revisionNumber ?? 1,
      attemptNumber: input.attemptNumber ?? 1,
      verification: input.record,
    },
  });
}

function auditEvent(input: FormInput & { readonly record: unknown }): Record<string, unknown> {
  return taskEvent({
    taskId: input.taskId,
    type: "AUDIT_COMPLETED",
    transitionId: input.transitionId ?? "audit.1",
    flat: input.flat ?? 1,
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    ...(input.recordedAt === undefined ? {} : { recordedAt: input.recordedAt }),
    payload: {
      revisionNumber: input.revisionNumber ?? 1,
      attemptNumber: input.attemptNumber ?? 1,
      auditVerdict: input.record,
    },
  });
}

/** Publish evidence naming one receipt; its reference id and content digest. */
function publishEvidence(
  h: Harness,
  taskId: string,
  receiptSha256: unknown,
  artifactReferenceId = "ref-evidence-" + randomUUID(),
  artifactClass = "EVIDENCE",
  scopeId = taskId,
): { readonly artifactReferenceId: string; readonly evidenceSha256: string } {
  const evidenceSha256 = publish(
    h,
    json({ receiptSha256, finding: "the tree matches the declared write-set" }),
    artifactReferenceId,
    artifactClass,
    scopeId,
  );
  return { artifactReferenceId, evidenceSha256 };
}

function verdictRecord(
  receipt: Record<string, unknown>,
  evidence: { readonly artifactReferenceId: string; readonly evidenceSha256: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const record = recordOf(receipt, "unused");
  return {
    receiptSha256: record["receiptSha256"],
    treeSha: record["treeSha"],
    writerWorkerId: (record["writer"] as { workerId: string }).workerId,
    auditor: { identity: AUDITOR, workerId: auditorIdOf(receipt["taskId"] as string), runId: 1 },
    verdict: "ACCEPT",
    evidenceSha256: evidence.evidenceSha256,
    artifactReferenceId: evidence.artifactReferenceId,
    ...overrides,
  };
}

interface Recorded {
  readonly h: Harness;
  readonly taskId: string;
  readonly receipt: Record<string, unknown>;
  readonly record: Record<string, unknown>;
  readonly receiptSha256: string;
  readonly event: Record<string, unknown>;
}

/** A ledger with one opened attempt and its receipt published, not yet recorded. */
function prepared(overrides: Record<string, unknown> = {}, h: Harness = harness()): Recorded {
  const taskId = randomUUID();
  openAttempt(h, taskId, { flat: 1 });
  const receipt = receiptValue({ taskId, overrides });
  const artifactReferenceId = "ref-receipt-" + randomUUID();
  publish(h, json(receipt), artifactReferenceId, "RECEIPT", taskId);
  const record = recordOf(receipt, artifactReferenceId);
  return {
    h,
    taskId,
    receipt,
    record,
    receiptSha256: record["receiptSha256"] as string,
    event: verificationEvent({ taskId, record }),
  };
}

/** The same, with the receipt recorded through `append`. */
function recorded(overrides: Record<string, unknown> = {}): Recorded {
  const on = prepared(overrides);
  on.h.ledger.append(on.event);
  return on;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

function refusalOf(action: () => unknown): { readonly reason: string; readonly at: string } {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof LedgerVerificationRefusedError) return { reason: error.reason, at: error.at };
    throw error;
  }
  throw new Error("expected a refusal, and the action was admitted");
}

function count(path: string, table: string): number {
  const raw = new Database(path, { readonly: true });
  try {
    return (raw.prepare("SELECT COUNT(*) AS n FROM " + table).get() as { n: number }).n;
  } finally {
    raw.close();
  }
}

interface Dump {
  readonly verifications: readonly Record<string, unknown>[];
  readonly verdicts: readonly Record<string, unknown>[];
}

function dump(path: string): Dump {
  const raw = new Database(path, { readonly: true });
  try {
    return {
      verifications: raw.prepare("SELECT * FROM verification_read_model ORDER BY receipt_sha256").all() as Record<string, unknown>[],
      verdicts: raw.prepare("SELECT * FROM audit_verdict_read_model ORDER BY audit_id").all() as Record<string, unknown>[],
    };
  } finally {
    raw.close();
  }
}

/** Assert a refusal by name wrote nothing: no row in either table, and the head unmoved. */
function refusedCleanly(h: Harness, action: () => unknown): { readonly reason: string; readonly at: string } {
  const before = h.ledger.status();
  const verifications = count(h.path, "verification_read_model");
  const verdicts = count(h.path, "audit_verdict_read_model");
  const refusal = refusalOf(action);
  const after = h.ledger.status();
  expect(after.headSequence).toBe(before.headSequence);
  expect(after.headEventSha256).toBe(before.headEventSha256);
  expect(count(h.path, "verification_read_model")).toBe(verifications);
  expect(count(h.path, "audit_verdict_read_model")).toBe(verdicts);
  return refusal;
}

/**
 * Plant one contract-valid event on the task stream with a correct hash chain, past
 * the door: a history the door would have refused, which the fold must refuse too.
 */
function plantChainedEvent(path: string, event: Record<string, unknown>): void {
  const raw = new Database(path);
  try {
    const meta = new Map(
      (raw.prepare("SELECT key, value FROM ledger_meta").all() as { key: string; value: string }[]).map((row) => [
        row.key,
        row.value,
      ]),
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

/** Migration 28 undone on a closed ledger: the tables, their objects, the watermarks and the row. */
function rewindTo27(path: string): void {
  const raw = new Database(path);
  try {
    raw.exec(
      "DROP TRIGGER tr_audit_verdict_read_model__insert_only; " +
        "DROP TRIGGER tr_verification_read_model__insert_only; " +
        "DROP INDEX ix_audit_verdict_read_model__attempt; " +
        "DROP INDEX ix_verification_read_model__attempt; " +
        "DROP TABLE audit_verdict_read_model; " +
        "DROP TABLE verification_read_model; " +
        "DELETE FROM projection_watermark WHERE projection_name IN ('verification_read_model', 'audit_verdict_read_model');",
    );
    raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(VERIFICATION_AUDIT_MIGRATION);
  } finally {
    raw.close();
  }
}

// ===========================================================================
// The decision, the vocabulary and the barrel
// ===========================================================================

describe("the vocabulary, the keys and the barrel", () => {
  it("is one sorted, repeat-free list, frozen with RECORDED_AT_NOT_CANONICAL and P-16/C's two registry words in it", () => {
    expect([...VERIFICATION_REFUSALS]).toEqual([...VERIFICATION_REFUSALS].sort());
    expect(new Set(VERIFICATION_REFUSALS).size).toBe(VERIFICATION_REFUSALS.length);
    expect(VERIFICATION_REFUSALS).toEqual([
      "AUDITOR_NOT_INDEPENDENT",
      "AUDITOR_NOT_REGISTERED",
      "AUDIT_RECEIPT_NOT_PASS",
      "AUDIT_RECEIPT_UNKNOWN",
      "AUDIT_RECORD_INVALID",
      "AUDIT_TREE_MISMATCH",
      "AUDIT_WRITER_MISMATCH",
      "EVIDENCE_RECEIPT_MISMATCH",
      "EVIDENCE_REFERENCE_INVALID",
      "RECEIPT_ATTEMPT_UNOPENED",
      "RECEIPT_COORDINATE_MISMATCH",
      "RECEIPT_DIGEST_MISMATCH",
      "RECEIPT_FIELD_MISMATCH",
      "RECEIPT_METADATA_CONFLICT",
      "RECEIPT_RECORD_INVALID",
      "RECEIPT_REFERENCE_INVALID",
      "RECEIPT_UNREADABLE",
      "RECORDED_AT_NOT_CANONICAL",
      "VERIFIER_NOT_INDEPENDENT",
      "VERIFIER_NOT_REGISTERED",
      "WRITER_ID_MISMATCH",
    ]);
  });

  it("names the registry reference artifactReferenceId in both records, never the content-block word", () => {
    expect(VERIFICATION_RECORD_KEYS).toContain("artifactReferenceId");
    expect(AUDIT_VERDICT_RECORD_KEYS).toContain("artifactReferenceId");
    expect([...VERIFICATION_RECORD_KEYS, ...AUDIT_VERDICT_RECORD_KEYS]).not.toContain("artifactRefId");
    expect(VERIFICATION_RECORD_KEYS).toHaveLength(11);
    expect(AUDIT_VERDICT_RECORD_KEYS).toHaveLength(7);
  });

  it("exports the words and the error, and keeps the decision and the door's read in the module", () => {
    expect(ledgerBarrel.VERIFICATION_REFUSALS).toBe(VERIFICATION_REFUSALS);
    expect(ledgerBarrel.LedgerVerificationRefusedError).toBe(LedgerVerificationRefusedError);
    for (const name of ["decideVerificationRecord", "readVerificationArtifact", "assertVerificationArtifact"]) {
      expect(Object.keys(ledgerBarrel), name).not.toContain(name);
    }
    // P-16/C: the column reading leaves the module for its second caller, the runner.
    expect(ledgerBarrel.receiptVerificationColumns).toBe(receiptVerificationColumns);
    const error = new LedgerVerificationRefusedError("RECEIPT_DIGEST_MISMATCH", "payload.verification.receiptSha256");
    expect(error.code).toBe("LEDGER_VERIFICATION_REFUSED");
    expect(error.message).toBe(
      "the verification record was refused: RECEIPT_DIGEST_MISMATCH at payload.verification.receiptSha256",
    );
  });
});

/** A view over nothing but one opened attempt: flat `legacy` at (1, 1) of `taskId`. */
function view(taskId: string, legacy: number | null = 1, receipt: ReturnType<VerificationDecisionView["verification"]> = null): VerificationDecisionView {
  return {
    legacyAttempt: (task, revisionNumber, attemptNumber) =>
      task === taskId && revisionNumber === 1 && attemptNumber === 1 ? legacy : null,
    verification: () => receipt,
    auditVerdict: () => null,
    lastRunId: () => 0,
  };
}

function decide(v: VerificationDecisionView, event: Record<string, unknown>, sequence = 7) {
  return decideVerificationRecord(v, event as unknown as ControlPlaneEvent, sequence);
}

describe("the decision, pure over the event and what its caller answers", () => {
  const taskId = "00000000-0000-4000-8000-00000000000a";
  const receipt = receiptValue({ taskId });
  const record = recordOf(receipt, "ref-receipt");

  it("answers null for every beat and every other type, and reads no byte for one", () => {
    const beats = [
      taskEvent({ taskId, type: "VERIFICATION_COMPLETED", transitionId: "b1", flat: 1, payload: { submissionDigest: "a".repeat(64), revisionNumber: 1, attemptNumber: 1, beat: "verify", planIndex: 0 } }),
      taskEvent({ taskId, type: "AUDIT_COMPLETED", transitionId: "b2", flat: 1, payload: { submissionDigest: "a".repeat(64), beat: "audit", planIndex: 1, verdict: "ACCEPT" } }),
      // The receipt key on the wrong type is not a form: it is a beat of that type.
      taskEvent({ taskId, type: "AUDIT_COMPLETED", transitionId: "b3", flat: 1, payload: { verification: record } }),
      taskEvent({ taskId, type: "TASK_DISCOVERED", transitionId: "b4", flat: 1, payload: {} }),
    ];
    for (const beat of beats) {
      expect(decide(view(taskId), beat)).toBeNull();
      expect(readVerificationArtifact(harness().ledger, beat as unknown as ControlPlaneEvent)).toBeNull();
    }
  });

  it("grants a receipt row with every column from the record and the envelope", () => {
    const decision = decide(view(taskId), verificationEvent({ taskId, record }), 7);
    expect(decision).toEqual({
      kind: "VERIFICATION",
      recorded: false,
      row: {
        receiptSha256: record["receiptSha256"],
        taskId,
        revisionNumber: 1,
        attemptNumber: 1,
        verifierIdentity: VERIFIER,
        verifierWorkerId: verifierIdOf(taskId),
        verifierRunId: 1,
        writerIdentity: WRITER,
        writerWorkerId: writerWorkerIdFor(taskId, 1),
        baseSha: receipt["baseSha"],
        treeSha: receipt["treeSha"],
        policySha256: receipt["policySha256"],
        writeSetSha256: record["writeSetSha256"],
        artifactReferenceId: "ref-receipt",
        checksSha256: record["checksSha256"],
        runStatus: "PASS",
        allChecksZero: true,
        recordedAt: AT,
        sequence: 7,
      },
    });
  });

  it("refuses the verifier by label and by instance (VERIFIER_NOT_INDEPENDENT)", () => {
    const byLabel = { ...record, verifier: { identity: WRITER, workerId: verifierIdOf(taskId), runId: 1 } };
    expect(refusalOf(() => decide(view(taskId), verificationEvent({ taskId, record: byLabel })))).toEqual({
      reason: "VERIFIER_NOT_INDEPENDENT",
      at: "payload.verification.verifier.identity",
    });
    const byInstance = {
      ...record,
      verifier: { identity: VERIFIER, workerId: writerWorkerIdFor(taskId, 1), runId: 1 },
    };
    expect(refusalOf(() => decide(view(taskId), verificationEvent({ taskId, record: byInstance })))).toEqual({
      reason: "VERIFIER_NOT_INDEPENDENT",
      at: "payload.verification.verifier.workerId",
    });
  });

  it("refuses a coordinate no attempt opened, and a flat attempt its row does not hold", () => {
    expect(refusalOf(() => decide(view(taskId, null), verificationEvent({ taskId, record })))).toEqual({
      reason: "RECEIPT_ATTEMPT_UNOPENED",
      at: "payload.attemptNumber",
    });
    // The door's attempt identity refuses this first; the fold meets it only in a
    // history the door never wrote.
    expect(refusalOf(() => decide(view(taskId, 2), verificationEvent({ taskId, record })))).toEqual({
      reason: "RECEIPT_COORDINATE_MISMATCH",
      at: "attempt",
    });
  });

  it("B3: holds the coordinate to 1..10000 and the instant to its canonical form", () => {
    const at = (revisionNumber: number) =>
      decide(
        {
          legacyAttempt: () => 1,
          verification: () => null,
          auditVerdict: () => null,
          lastRunId: () => 0,
        },
        verificationEvent({ taskId, record, revisionNumber, attemptNumber: revisionNumber }),
      );
    expect(at(1)?.row.revisionNumber).toBe(1);
    expect(at(10_000)?.row.attemptNumber).toBe(10_000);
    expect(refusalOf(() => at(10_001))).toEqual({ reason: "RECEIPT_RECORD_INVALID", at: "payload.revisionNumber" });
    expect(refusalOf(() => at(0))).toEqual({ reason: "RECEIPT_RECORD_INVALID", at: "payload.revisionNumber" });
    for (const recordedAt of ["2026-09-26T14:00:00.000+02:00", "2026-09-26T12:00:00Z", "2026-09-26T12:00:00.000000Z"]) {
      const event = { ...verificationEvent({ taskId, record }), recordedAt };
      expect(refusalOf(() => decide(view(taskId), event)), recordedAt).toEqual({
        reason: "RECORDED_AT_NOT_CANONICAL",
        at: "recordedAt",
      });
    }
  });
});

describe("N8: a half form is refused at its path, at either level", () => {
  const taskId = "00000000-0000-4000-8000-00000000000a";
  const receipt = receiptValue({ taskId });
  const record = recordOf(receipt, "ref-receipt");
  const verdict = {
    receiptSha256: record["receiptSha256"],
    treeSha: record["treeSha"],
    writerWorkerId: writerWorkerIdFor(taskId, 1),
    auditor: { identity: AUDITOR, workerId: auditorIdOf(taskId), runId: 1 },
    verdict: "ACCEPT",
    evidenceSha256: "d".repeat(64),
    artifactReferenceId: "ref-evidence",
  };
  const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
    return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
  };

  it("the receipt form: missing, extra and mistyped members, nested and top level", () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [without(record, "baseSha"), "payload.verification.baseSha"],
      [{ ...record, extra: 1 }, "payload.verification"],
      [{ ...record, baseSha: 7 }, "payload.verification.baseSha"],
      [{ ...record, receiptSha256: "A".repeat(64) }, "payload.verification.receiptSha256"],
      [{ ...record, artifactReferenceId: "" }, "payload.verification.artifactReferenceId"],
      [{ ...record, artifactReferenceId: "r".repeat(513) }, "payload.verification.artifactReferenceId"],
      [{ ...record, runStatus: "pass" }, "payload.verification.runStatus"],
      [{ ...record, allChecksZero: 1 }, "payload.verification.allChecksZero"],
      // PASS with a nonzero check is the one forbidden cell (N6's door half).
      [{ ...record, allChecksZero: false }, "payload.verification.allChecksZero"],
      [{ ...record, writer: { identity: WRITER } }, "payload.verification.writer.workerId"],
      [{ ...record, writer: { ...(record["writer"] as object), runId: 1 } }, "payload.verification.writer"],
      [{ ...record, verifier: { identity: VERIFIER, workerId: verifierIdOf(taskId), runId: 0 } }, "payload.verification.verifier.runId"],
      [{ ...record, verifier: { identity: VERIFIER, workerId: verifierIdOf(taskId).toUpperCase(), runId: 1 } }, "payload.verification.verifier.workerId"],
      [{ ...record, verifier: { identity: "Claude/Sonnet/verifier/01", workerId: verifierIdOf(taskId), runId: 1 } }, "payload.verification.verifier.identity"],
      [[record], "payload.verification"],
      // The content-block word is not this record's: renamed, the reference is
      // missing; added, it is an unknown key (the stop ruling on L-P06C-1).
      [{ ...without(record, "artifactReferenceId"), artifactRefId: "ref-receipt" }, "payload.verification.artifactReferenceId"],
      [{ ...record, artifactRefId: "ref-receipt" }, "payload.verification"],
    ];
    for (const [value, at] of cases) {
      expect(refusalOf(() => decide(view(taskId), verificationEvent({ taskId, record: value }))), at).toEqual({
        reason: "RECEIPT_RECORD_INVALID",
        at,
      });
    }
    const topLevel = verificationEvent({ taskId, record });
    (topLevel["payload"] as Record<string, unknown>)["beat"] = "verify";
    expect(refusalOf(() => decide(view(taskId), topLevel))).toEqual({ reason: "RECEIPT_RECORD_INVALID", at: "payload" });
    const noCoordinate = taskEvent({ taskId, type: "VERIFICATION_COMPLETED", transitionId: "v1", flat: 1, payload: { verification: record } });
    expect(refusalOf(() => decide(view(taskId), noCoordinate))).toEqual({
      reason: "RECEIPT_RECORD_INVALID",
      at: "payload.revisionNumber",
    });
  });

  it("the verdict form: missing, extra and mistyped members, nested and top level", () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [without(verdict, "verdict"), "payload.auditVerdict.verdict"],
      [{ ...verdict, extra: true }, "payload.auditVerdict"],
      [{ ...verdict, verdict: "ACCEPTED" }, "payload.auditVerdict.verdict"],
      [{ ...verdict, treeSha: "b".repeat(64) }, "payload.auditVerdict.treeSha"],
      [{ ...verdict, writerWorkerId: "not-a-uuid" }, "payload.auditVerdict.writerWorkerId"],
      [{ ...verdict, evidenceSha256: null }, "payload.auditVerdict.evidenceSha256"],
      [{ ...verdict, auditor: { identity: AUDITOR, workerId: auditorIdOf(taskId) } }, "payload.auditVerdict.auditor.runId"],
      [{ ...verdict, auditor: { identity: AUDITOR, workerId: auditorIdOf(taskId), runId: 1.5 } }, "payload.auditVerdict.auditor.runId"],
      [{ ...without(verdict, "artifactReferenceId"), artifactRefId: "ref-evidence" }, "payload.auditVerdict.artifactReferenceId"],
      [{ ...verdict, artifactRefId: "ref-evidence" }, "payload.auditVerdict"],
      ["ACCEPT", "payload.auditVerdict"],
    ];
    for (const [value, at] of cases) {
      expect(refusalOf(() => decide(view(taskId), auditEvent({ taskId, record: value }))), at).toEqual({
        reason: "AUDIT_RECORD_INVALID",
        at,
      });
    }
    const topLevel = auditEvent({ taskId, record: verdict });
    (topLevel["payload"] as Record<string, unknown>)["verdict"] = "ACCEPT";
    expect(refusalOf(() => decide(view(taskId), topLevel))).toEqual({ reason: "AUDIT_RECORD_INVALID", at: "payload" });
  });

  it("at the door: the grammar refuses before any byte is judged, and writes nothing", () => {
    const on = prepared();
    expect(
      refusedCleanly(on.h, () =>
        on.h.ledger.append(verificationEvent({ taskId: on.taskId, record: { ...on.record, artifactRefId: "x" } })),
      ),
    ).toEqual({ reason: "RECEIPT_RECORD_INVALID", at: "payload.verification" });
  });
});

// ===========================================================================
// Positives
// ===========================================================================

describe("P1-P5: the door records a receipt and a verdict, and the fold reproduces both", () => {
  it("P1: append records one §10.2 row, every column the receipt's, the event's instant and sequence", () => {
    const on = prepared();
    const appended = on.h.ledger.append(on.event);
    expect(appended.inserted).toBe(true);
    const row = on.h.ledger.getVerification(on.receiptSha256);
    const columns = receiptVerificationColumns(on.receipt);
    expect(row).toEqual({
      receiptSha256: columns.receiptSha256,
      taskId: on.taskId,
      revisionNumber: 1,
      attemptNumber: 1,
      verifierIdentity: VERIFIER,
      verifierWorkerId: verifierIdOf(on.taskId),
      verifierRunId: 1,
      writerIdentity: WRITER,
      writerWorkerId: writerWorkerIdFor(on.taskId, 1),
      baseSha: columns.baseSha,
      treeSha: columns.treeSha,
      policySha256: columns.policySha256,
      writeSetSha256: columns.writeSetSha256,
      artifactReferenceId: on.record["artifactReferenceId"],
      checksSha256: columns.checksSha256,
      runStatus: "PASS",
      allChecksZero: true,
      recordedAt: AT,
      sequence: appended.record.sequence,
    });
    // The column keeps the canon's name, and the value is stored as 0/1.
    const raw = dump(on.h.path).verifications[0];
    expect(raw?.["artifact_ref_id"]).toBe(on.record["artifactReferenceId"]);
    expect(raw?.["all_checks_zero"]).toBe(1);
    expect(on.h.ledger.listAuditVerdicts(on.receiptSha256)).toEqual([]);
    expect(on.h.ledger.getVerification("f".repeat(64))).toBeNull();
    expect(on.h.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("P2: appendBatch records a receipt and its verdict in one transaction, the verdict seeing the receipt", () => {
    const on = prepared();
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    const audit = auditEvent({ taskId: on.taskId, record: verdictRecord(on.receipt, evidence) });
    const batch = on.h.ledger.appendBatch([on.event, audit]);
    expect(batch.insertedCount).toBe(2);
    const verdicts = on.h.ledger.listAuditVerdicts(on.receiptSha256);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toEqual({
      auditId: audit["eventId"],
      taskId: on.taskId,
      revisionNumber: 1,
      attemptNumber: 1,
      receiptSha256: on.receiptSha256,
      treeSha: on.receipt["treeSha"],
      writerWorkerId: writerWorkerIdFor(on.taskId, 1),
      auditorIdentity: AUDITOR,
      auditorWorkerId: auditorIdOf(on.taskId),
      auditorRunId: 1,
      verdict: "ACCEPT",
      evidenceSha256: evidence.evidenceSha256,
      artifactReferenceId: evidence.artifactReferenceId,
      recordedAt: AT,
      sequence: batch.results[1]?.record.sequence,
    });
    expect(on.h.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("P3: a FAIL receipt is recorded with every check at zero, and with one that is not", () => {
    const zero = recorded({ runStatus: "FAIL" });
    expect(zero.h.ledger.getVerification(zero.receiptSha256)).toMatchObject({ runStatus: "FAIL", allChecksZero: true });
    const nonzero = recorded({
      runStatus: "FAIL",
      checks: [{ command: "pnpm check", exitCode: 1, ranAt: "2026-09-26T11:00:00.000Z" }],
    });
    expect(nonzero.h.ledger.getVerification(nonzero.receiptSha256)).toMatchObject({ runStatus: "FAIL", allChecksZero: false });
  });

  it("P4: each of the three verdicts on a PASS row copies its tree and its writer", () => {
    const on = recorded();
    const words = ["ACCEPT", "ACCEPT_WITH_CORRECTIONS", "REJECT"];
    for (const [index, verdict] of words.entries()) {
      const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
      on.h.ledger.append(
        auditEvent({
          taskId: on.taskId,
          transitionId: "audit." + String(index),
          // Each audit is its own spawn: run ids 1, 2, 3 of the attempt (P-16/C).
          record: verdictRecord(on.receipt, evidence, {
            verdict,
            auditor: { identity: AUDITOR, workerId: auditorIdOf(on.taskId, 1, index + 1), runId: index + 1 },
          }),
        }),
      );
    }
    const verdicts = on.h.ledger.listAuditVerdicts(on.receiptSha256);
    expect(verdicts.map((row) => row.verdict)).toEqual(words);
    const receipt = on.h.ledger.getVerification(on.receiptSha256);
    for (const row of verdicts) {
      expect(row.treeSha).toBe(receipt?.treeSha);
      expect(row.writerWorkerId).toBe(receipt?.writerWorkerId);
    }
  });

  it("P5 / A6: the rebuild reproduces both tables byte-identical, and verifyIntegrity reports a planted divergence", () => {
    const on = prepared();
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    on.h.ledger.appendBatch([on.event, auditEvent({ taskId: on.taskId, record: verdictRecord(on.receipt, evidence) })]);
    const before = dump(on.h.path);
    expect(before.verifications).toHaveLength(1);
    expect(before.verdicts).toHaveLength(1);
    on.h.ledger.rebuildReadModel();
    expect(dump(on.h.path)).toEqual(before);
    expect(on.h.ledger.verifyIntegrity().problems).toEqual([]);

    // A verdict quietly re-pointed, and a run status flipped: counts unchanged, both
    // reported by table. The triggers are dropped to plant them, as an attacker would.
    const raw = new Database(on.h.path);
    raw.exec(
      "DROP TRIGGER tr_audit_verdict_read_model__insert_only; DROP TRIGGER tr_verification_read_model__insert_only;",
    );
    raw.prepare("UPDATE audit_verdict_read_model SET verdict = 'REJECT'").run();
    raw.prepare("UPDATE verification_read_model SET policy_sha256 = ?").run("0".repeat(64));
    raw.close();
    const report = on.h.ledger.verifyIntegrity();
    expect(report.ok).toBe(false);
    const details = report.problems.map((problem) => problem.detail).join("\n");
    expect(details).toContain("verification_read_model");
    expect(details).toContain("audit_verdict_read_model");
  });
});

describe("P6 / A7: the walk's beats are admitted byte-unchanged and project nothing", () => {
  it("V2 and V1 beats of both types, and an observation-style verdict beat", () => {
    const h = harness();
    const taskId = randomUUID();
    openAttempt(h, taskId, { flat: 1 });
    const beats = [
      taskEvent({
        taskId,
        type: "VERIFICATION_COMPLETED",
        transitionId: "beat.verify",
        flat: 1,
        payload: { submissionDigest: "a".repeat(64), revisionNumber: 1, attemptNumber: 1, beat: "verify", planIndex: 2 },
      }),
      taskEvent({
        taskId,
        type: "AUDIT_COMPLETED",
        transitionId: "beat.audit",
        flat: 1,
        payload: { submissionDigest: "a".repeat(64), revisionNumber: 1, attemptNumber: 1, beat: "audit", planIndex: 3 },
      }),
      taskEvent({
        taskId,
        type: "AUDIT_COMPLETED",
        transitionId: "beat.audit.v1",
        flat: 1,
        payload: { submissionDigest: "a".repeat(64), beat: "audit", planIndex: 4, verdict: "ACCEPT" },
      }),
    ];
    for (const beat of beats) {
      const appended = h.ledger.append(beat);
      expect(appended.inserted).toBe(true);
      expect(appended.record.event.payload).toEqual(beat["payload"]);
    }
    expect(count(h.path, "verification_read_model")).toBe(0);
    expect(count(h.path, "audit_verdict_read_model")).toBe(0);
    expect(h.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("NB-1 (ADR 0122 Two): a form key under the other type is a beat of that type, and projects no row", () => {
    // A form is its type AND its key. The receipt key on AUDIT_COMPLETED and the
    // verdict key on VERIFICATION_COMPLETED are beats: admitted byte-unchanged, no
    // byte read, no row, even when the record they carry would be granted under its
    // own type. Authorization reads the two tables, never a payload key (P-17/A).
    const on = recorded();
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    const crossed = [
      taskEvent({
        taskId: on.taskId,
        type: "AUDIT_COMPLETED",
        transitionId: "crossed.audit",
        flat: 1,
        payload: { revisionNumber: 1, attemptNumber: 1, verification: on.record },
      }),
      taskEvent({
        taskId: on.taskId,
        type: "VERIFICATION_COMPLETED",
        transitionId: "crossed.verify",
        flat: 1,
        payload: { revisionNumber: 1, attemptNumber: 1, auditVerdict: verdictRecord(on.receipt, evidence) },
      }),
    ];
    for (const beat of crossed) {
      expect(decide(view(on.taskId), beat)).toBeNull();
      expect(readVerificationArtifact(on.h.ledger, beat as unknown as ControlPlaneEvent)).toBeNull();
      const appended = on.h.ledger.append(beat);
      expect(appended.inserted).toBe(true);
      expect(appended.record.event.payload).toEqual(beat["payload"]);
    }
    // Only the receipt recorded by its own form stands; no verdict row exists.
    expect(count(on.h.path, "verification_read_model")).toBe(1);
    expect(count(on.h.path, "audit_verdict_read_model")).toBe(0);
    expect(on.h.ledger.listAuditVerdicts(on.receiptSha256)).toEqual([]);
    const before = dump(on.h.path);
    expect(on.h.ledger.verifyIntegrity().problems).toEqual([]);
    on.h.ledger.rebuildReadModel();
    expect(dump(on.h.path)).toEqual(before);
  });
});

describe("P7: a 2.11.0 history crosses migration 28", () => {
  it("opens at 27, migrates, reads, verifies and rebuilds identical, then takes a receipt and a verdict", () => {
    const h = harness();
    const taskId = randomUUID();
    openAttempt(h, taskId, { flat: 1 });
    h.ledger.append(
      taskEvent({
        taskId,
        type: "VERIFICATION_COMPLETED",
        transitionId: "beat.verify",
        flat: 1,
        payload: { submissionDigest: "a".repeat(64), revisionNumber: 1, attemptNumber: 1, beat: "verify", planIndex: 2 },
      }),
    );
    const head = h.ledger.status();
    h.close();
    rewindTo27(h.path);

    const again = harnessAt(h.path);
    expect(again.ledger.status().migrations.at(-1)?.version).toBe(VERIFICATION_AUDIT_MIGRATION);
    const marks = again.ledger
      .status()
      .projections.filter((projection) => ["verification_read_model", "audit_verdict_read_model"].includes(projection.name));
    expect(marks).toHaveLength(2);
    for (const projection of marks) {
      expect(projection.watermarks.map((watermark) => watermark.appliedThroughSequence)).toEqual([head.headSequence]);
    }
    expect(again.ledger.verifyIntegrity().problems).toEqual([]);
    const before = dump(again.path);
    again.ledger.rebuildReadModel();
    expect(dump(again.path)).toEqual(before);

    const receipt = receiptValue({ taskId });
    publish(again, json(receipt), "ref-receipt-p7", "RECEIPT", taskId);
    again.ledger.append(verificationEvent({ taskId, record: recordOf(receipt, "ref-receipt-p7") }));
    const receiptSha256 = receiptVerificationColumns(receipt).receiptSha256;
    const evidence = publishEvidence(again, taskId, receiptSha256);
    again.ledger.append(auditEvent({ taskId, record: verdictRecord(receipt, evidence) }));
    expect(again.ledger.listAuditVerdicts(receiptSha256)).toHaveLength(1);
    expect(again.ledger.verifyIntegrity().problems).toEqual([]);
  });
});

// ===========================================================================
// Negatives
// ===========================================================================

describe("N1-N4: the door reads the receipt by reference and believes nothing it carries", () => {
  it("N1: a carried name the bytes do not recompute is RECEIPT_DIGEST_MISMATCH", () => {
    const on = prepared();
    const event = verificationEvent({ taskId: on.taskId, record: { ...on.record, receiptSha256: "f".repeat(64) } });
    expect(refusedCleanly(on.h, () => on.h.ledger.append(event))).toEqual({
      reason: "RECEIPT_DIGEST_MISMATCH",
      at: "payload.verification.receiptSha256",
    });
  });

  it("N2: every carried column that differs from the receipt is refused at its path", () => {
    const other40 = "fedcba9876543210fedcba9876543210fedcba98";
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ baseSha: other40 }, "baseSha"],
      [{ treeSha: other40 }, "treeSha"],
      [{ policySha256: "1".repeat(64) }, "policySha256"],
      [{ writeSetSha256: "2".repeat(64) }, "writeSetSha256"],
      [{ checksSha256: "3".repeat(64) }, "checksSha256"],
      [{ runStatus: "FAIL" }, "runStatus"],
      [{ verifier: { identity: "claude/haiku/verifier/02", workerId: "__registry__", runId: 1 } }, "verifier.identity"],
      [{ writer: { identity: "claude/opus/implementer/02", workerId: "__derived__" } }, "writer.identity"],
    ];
    for (const [overrides, path] of cases) {
      const on = prepared();
      const record = { ...on.record, ...overrides };
      if ((record["writer"] as { workerId: string }).workerId === "__derived__") {
        record["writer"] = { identity: "claude/opus/implementer/02", workerId: writerWorkerIdFor(on.taskId, 1) };
      }
      if ((record["verifier"] as { workerId: string }).workerId === "__registry__") {
        record["verifier"] = { identity: "claude/haiku/verifier/02", workerId: verifierIdOf(on.taskId), runId: 1 };
      }
      expect(refusedCleanly(on.h, () => on.h.ledger.append(verificationEvent({ taskId: on.taskId, record }))), path).toEqual({
        reason: "RECEIPT_FIELD_MISMATCH",
        at: "payload.verification." + path,
      });
    }

    // allChecksZero: a FAIL receipt whose checks all passed, carried as not all zero.
    const fail = prepared({ runStatus: "FAIL" });
    expect(
      refusedCleanly(fail.h, () =>
        fail.h.ledger.append(verificationEvent({ taskId: fail.taskId, record: { ...fail.record, allChecksZero: false } })),
      ),
    ).toEqual({ reason: "RECEIPT_FIELD_MISMATCH", at: "payload.verification.allChecksZero" });

    // writer.workerId: the receipt names a writer id the plane never derived, and the
    // record carries the derived one: the record passes the derivation, the bytes do not.
    const h = harness();
    const taskId = randomUUID();
    openAttempt(h, taskId, { flat: 1 });
    const foreign = receiptValue({ taskId, overrides: { writer: { identity: WRITER, workerId: auditorIdOf(taskId) } } });
    publish(h, json(foreign), "ref-foreign-writer", "RECEIPT", taskId);
    const record = { ...recordOf(foreign, "ref-foreign-writer"), writer: { identity: WRITER, workerId: writerWorkerIdFor(taskId, 1) } };
    expect(refusedCleanly(h, () => h.ledger.append(verificationEvent({ taskId, record })))).toEqual({
      reason: "RECEIPT_FIELD_MISMATCH",
      at: "payload.verification.writer.workerId",
    });

    // verifier.workerId and verifier.runId (P-16/C): the receipt names a verifier the
    // registry never spawned, and the record carries the registry's: the record passes
    // the registry, the bytes do not.
    for (const [verifier, path] of [
      [{ identity: VERIFIER, workerId: auditorIdOf(taskId), runId: 1 }, "verifier.workerId"],
      [{ identity: VERIFIER, workerId: verifierIdOf(taskId), runId: 2 }, "verifier.runId"],
    ] as const) {
      const bytes = receiptValue({ taskId, overrides: { verifier } });
      const reference = "ref-foreign-" + path;
      publish(h, json(bytes), reference, "RECEIPT", taskId);
      const carried = { ...recordOf(bytes, reference), verifier: { identity: VERIFIER, workerId: verifierIdOf(taskId), runId: 1 } };
      expect(refusedCleanly(h, () => h.ledger.append(verificationEvent({ taskId, record: carried }))), path).toEqual({
        reason: "RECEIPT_FIELD_MISMATCH",
        at: "payload.verification." + path,
      });
    }
  });

  it("N3: an absent, misclassed, foreign or unreadable reference is refused inside the transaction", () => {
    // Absent: no reference by that id.
    const absent = prepared();
    expect(
      refusedCleanly(absent.h, () =>
        absent.h.ledger.append(
          verificationEvent({ taskId: absent.taskId, record: { ...absent.record, artifactReferenceId: "ref-nobody" } }),
        ),
      ),
    ).toEqual({ reason: "RECEIPT_REFERENCE_INVALID", at: "payload.verification.artifactReferenceId" });

    // Class: the bytes are the receipt's, recorded as evidence.
    const misclassed = prepared();
    publish(misclassed.h, json(misclassed.receipt), "ref-as-evidence", "EVIDENCE", misclassed.taskId);
    expect(
      refusedCleanly(misclassed.h, () =>
        misclassed.h.ledger.append(
          verificationEvent({ taskId: misclassed.taskId, record: { ...misclassed.record, artifactReferenceId: "ref-as-evidence" } }),
        ),
      ),
    ).toEqual({ reason: "RECEIPT_REFERENCE_INVALID", at: "payload.verification.artifactReferenceId" });

    // Scope: a receipt reference scoped to another task.
    const foreign = prepared();
    publish(foreign.h, json(foreign.receipt), "ref-other-task", "RECEIPT", randomUUID());
    expect(
      refusedCleanly(foreign.h, () =>
        foreign.h.ledger.append(
          verificationEvent({ taskId: foreign.taskId, record: { ...foreign.record, artifactReferenceId: "ref-other-task" } }),
        ),
      ),
    ).toEqual({ reason: "RECEIPT_REFERENCE_INVALID", at: "payload.verification.artifactReferenceId" });

    // Bytes that are not JSON, and JSON that is not a receipt.
    for (const content of [Buffer.from("not json at all", "utf8"), json({ runStatus: "PASS" })]) {
      const unreadable = prepared();
      const id = "ref-unreadable-" + randomUUID();
      publish(unreadable.h, content, id, "RECEIPT", unreadable.taskId);
      expect(
        refusedCleanly(unreadable.h, () =>
          unreadable.h.ledger.append(
            verificationEvent({ taskId: unreadable.taskId, record: { ...unreadable.record, artifactReferenceId: id } }),
          ),
        ),
      ).toEqual({ reason: "RECEIPT_UNREADABLE", at: "payload.verification.artifactReferenceId" });
    }

    // The private root moved away: the read before the lock is a refusal, raised here.
    const rootless = prepared();
    const root = artifactPlaneRootFor(rootless.h.path);
    renameSync(root, root + ".aside");
    expect(refusedCleanly(rootless.h, () => rootless.h.ledger.append(rootless.event))).toEqual({
      reason: "RECEIPT_UNREADABLE",
      at: "payload.verification.artifactReferenceId",
    });
    renameSync(root + ".aside", root);
    expect(rootless.h.ledger.append(rootless.event).inserted).toBe(true);
  });

  it("N4: a receipt of another coordinate, a V1-form receipt event, and an unopened coordinate", () => {
    // The receipt names attempt 2 while the event names attempt 1.
    const h = harness();
    const taskId = randomUUID();
    openAttempt(h, taskId, { flat: 1 });
    const elsewhere = receiptValue({ taskId, attemptNumber: 2 });
    publish(h, json(elsewhere), "ref-elsewhere", "RECEIPT", taskId);
    expect(refusedCleanly(h, () => h.ledger.append(verificationEvent({ taskId, record: recordOf(elsewhere, "ref-elsewhere") })))).toEqual({
      reason: "RECEIPT_COORDINATE_MISMATCH",
      at: "payload.attemptNumber",
    });
    // The receipt names another task, published under this one.
    const otherTask = receiptValue({
      taskId: randomUUID(),
      overrides: {
        writer: { identity: WRITER, workerId: writerWorkerIdFor(taskId, 1) },
        verifier: { identity: VERIFIER, workerId: verifierIdOf(taskId), runId: 1 },
      },
    });
    publish(h, json(otherTask), "ref-other-task-receipt", "RECEIPT", taskId);
    expect(
      refusedCleanly(h, () => h.ledger.append(verificationEvent({ taskId, record: recordOf(otherTask, "ref-other-task-receipt") }))),
    ).toEqual({ reason: "RECEIPT_COORDINATE_MISMATCH", at: "taskId" });

    // No V2 coordinate: the receipt form is closed over it.
    const on = prepared();
    const v1 = taskEvent({ taskId: on.taskId, type: "VERIFICATION_COMPLETED", transitionId: "v1", flat: 1, payload: { verification: on.record } });
    expect(refusedCleanly(on.h, () => on.h.ledger.append(v1))).toEqual({
      reason: "RECEIPT_RECORD_INVALID",
      at: "payload.revisionNumber",
    });

    // A coordinate no attempt opened: refused before anything is written.
    const unopened = prepared();
    const before = unopened.h.ledger.status().headSequence;
    expect(() =>
      unopened.h.ledger.append(verificationEvent({ taskId: unopened.taskId, attemptNumber: 2, flat: 2, record: unopened.record })),
    ).toThrow();
    expect(unopened.h.ledger.status().headSequence).toBe(before);
    expect(count(unopened.h.path, "verification_read_model")).toBe(0);
  });
});

describe("N5: the coordinate names its flat attempt, and the writer's id is derived from that", () => {
  /** Revision 1 attempt 1 is flat 1; revision 2 attempt 1 is flat 2. */
  function twoRevisions(): { readonly h: Harness; readonly taskId: string } {
    const h = harness();
    const taskId = randomUUID();
    openAttempt(h, taskId, { flat: 1 });
    openAttempt(h, taskId, { flat: 2, revisionNumber: 2, attemptNumber: 1 });
    return { h, taskId };
  }

  it("a revision-2 receipt whose writer id was derived from the per-revision attempt is WRITER_ID_MISMATCH at the door", () => {
    const { h, taskId } = twoRevisions();
    const wrong = receiptValue({ taskId, flat: 1, revisionNumber: 2, attemptNumber: 1 });
    publish(h, json(wrong), "ref-wrong", "RECEIPT", taskId);
    expect(
      refusedCleanly(h, () =>
        h.ledger.append(verificationEvent({ taskId, flat: 2, revisionNumber: 2, record: recordOf(wrong, "ref-wrong") })),
      ),
    ).toEqual({ reason: "WRITER_ID_MISMATCH", at: "payload.verification.writer.workerId" });

    // The flat derivation is admitted.
    const right = receiptValue({ taskId, flat: 2, revisionNumber: 2, attemptNumber: 1 });
    publish(h, json(right), "ref-right", "RECEIPT", taskId);
    expect(h.ledger.append(verificationEvent({ taskId, flat: 2, revisionNumber: 2, record: recordOf(right, "ref-right") })).inserted).toBe(true);
  });

  it("an event whose flat attempt is not its coordinate's stays refused by the attempt's identity", () => {
    const { h, taskId } = twoRevisions();
    const right = receiptValue({ taskId, flat: 2, revisionNumber: 2, attemptNumber: 1 });
    publish(h, json(right), "ref-right", "RECEIPT", taskId);
    const before = h.ledger.status().headSequence;
    let thrown: unknown;
    try {
      h.ledger.append(verificationEvent({ taskId, flat: 1, revisionNumber: 2, record: recordOf(right, "ref-right") }));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(LedgerVerificationRefusedError);
    expect(h.ledger.status().headSequence).toBe(before);
  });

  it("the same history planted past the door is refused by the fold in the door's word", () => {
    const { h, taskId } = twoRevisions();
    const wrong = receiptValue({ taskId, flat: 1, revisionNumber: 2, attemptNumber: 1 });
    publish(h, json(wrong), "ref-wrong", "RECEIPT", taskId);
    h.close();
    plantChainedEvent(h.path, verificationEvent({ taskId, flat: 2, revisionNumber: 2, record: recordOf(wrong, "ref-wrong") }));
    const again = harnessAt(h.path);
    const report = again.ledger.verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems.map((problem) => problem.detail).join("\n")).toContain(
      "records a verification the fold refuses: WRITER_ID_MISMATCH at payload.verification.writer.workerId",
    );
    expect(refusalOf(() => again.ledger.rebuildReadModel())).toEqual({
      reason: "WRITER_ID_MISMATCH",
      at: "payload.verification.writer.workerId",
    });
  });
});

describe("N12-N14: the verifier and the auditor are named by their spawn (P-16/C, ADR 0123)", () => {
  it("P6: the registry's four ids are Python's uuid5 vectors under the supervised namespace", () => {
    // Python: uuid.uuid5(uuid.UUID("370c3107-1424-5cc1-b7ca-74d37eb0fb68"), name).
    const task = "00000000-0000-4000-8000-0000000000aa";
    expect(verifierIdOf(task, 1, 1)).toBe("423f2d9b-71cd-575b-bc4c-8c3b68be0479");
    expect(auditorIdOf(task, 1, 1)).toBe("fe8388d4-c82a-5d4a-a9f7-dc3cc41e3ec3");
  });

  it("N12 (door): a verifier id or run id the registry did not spawn is VERIFIER_NOT_REGISTERED, and writes nothing", () => {
    const cases: readonly (readonly [(taskId: string) => Record<string, unknown>, string])[] = [
      // Under the writer's namespace, not the supervised one.
      [(taskId) => ({ identity: VERIFIER, workerId: writerWorkerIdFor(taskId, 5), runId: 1 }), "verifier.workerId"],
      // The id of another run, carried under run 1.
      [(taskId) => ({ identity: VERIFIER, workerId: verifierIdOf(taskId, 1, 2), runId: 1 }), "verifier.workerId"],
      // The reviewer's id, carried by a verifier.
      [(taskId) => ({ identity: VERIFIER, workerId: auditorIdOf(taskId, 1, 1), runId: 1 }), "verifier.workerId"],
      // Run 2 when the next is 1, even with run 2's own id.
      [(taskId) => ({ identity: VERIFIER, workerId: verifierIdOf(taskId, 1, 2), runId: 2 }), "verifier.runId"],
    ];
    for (const [verifier, path] of cases) {
      const h = harness();
      const taskId = randomUUID();
      openAttempt(h, taskId, { flat: 1 });
      const receipt = receiptValue({ taskId, overrides: { verifier: verifier(taskId) } });
      publish(h, json(receipt), "ref-unregistered", "RECEIPT", taskId);
      const event = verificationEvent({ taskId, record: recordOf(receipt, "ref-unregistered") });
      expect(refusedCleanly(h, () => h.ledger.append(event)), path).toEqual({
        reason: "VERIFIER_NOT_REGISTERED",
        at: "payload.verification." + path,
      });
    }

    // Repeating: run 1 is held, and another receipt claims run 1 again.
    const on = recorded();
    const again = receiptValue({
      taskId: on.taskId,
      overrides: { checks: [{ command: "pnpm check", exitCode: 0, ranAt: "2026-09-26T11:30:00.000Z" }] },
    });
    publish(on.h, json(again), "ref-again", "RECEIPT", on.taskId);
    expect(
      refusedCleanly(on.h, () =>
        on.h.ledger.append(verificationEvent({ taskId: on.taskId, transitionId: "verify.2", record: recordOf(again, "ref-again") })),
      ),
    ).toEqual({ reason: "VERIFIER_NOT_REGISTERED", at: "payload.verification.verifier.runId" });
  });

  it("B4: run id 1 and a history holding run 3 make the next 4, per attempt and per role", () => {
    const decideAt = (last: number, runId: number) => {
      const taskId = "00000000-0000-4000-8000-00000000000a";
      const receipt = receiptValue({ taskId, overrides: { verifier: { identity: VERIFIER, workerId: verifierIdOf(taskId, 1, runId), runId } } });
      return decide(
        { ...view(taskId), lastRunId: (role) => (role === "verifier" ? last : 0) },
        verificationEvent({ taskId, record: recordOf(receipt, "ref") }),
      );
    };
    expect(decideAt(0, 1)?.row).toMatchObject({ verifierRunId: 1 });
    expect(decideAt(3, 4)?.row).toMatchObject({ verifierRunId: 4 });
    expect(refusalOf(() => decideAt(3, 3))).toEqual({ reason: "VERIFIER_NOT_REGISTERED", at: "payload.verification.verifier.runId" });
    expect(refusalOf(() => decideAt(3, 5))).toEqual({ reason: "VERIFIER_NOT_REGISTERED", at: "payload.verification.verifier.runId" });
  });

  it("N13 (door): an auditor id or run id the registry did not spawn is AUDITOR_NOT_REGISTERED", () => {
    const on = recorded();
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    const refuse = (auditor: Record<string, unknown>) =>
      refusedCleanly(on.h, () =>
        on.h.ledger.append(auditEvent({ taskId: on.taskId, record: verdictRecord(on.receipt, evidence, { auditor }) })),
      );
    expect(refuse({ identity: AUDITOR, workerId: verifierIdOf(on.taskId, 1, 1), runId: 1 })).toEqual({
      reason: "AUDITOR_NOT_REGISTERED",
      at: "payload.auditVerdict.auditor.workerId",
    });
    expect(refuse({ identity: AUDITOR, workerId: auditorIdOf(on.taskId, 1, 2), runId: 2 })).toEqual({
      reason: "AUDITOR_NOT_REGISTERED",
      at: "payload.auditVerdict.auditor.runId",
    });
    // P7: the registry's own verdict on the same receipt is admitted, run 1, then run 2.
    on.h.ledger.append(auditEvent({ taskId: on.taskId, transitionId: "audit.r1", record: verdictRecord(on.receipt, evidence) }));
    expect(refuse({ identity: AUDITOR, workerId: auditorIdOf(on.taskId, 1, 1), runId: 1 })).toEqual({
      reason: "AUDITOR_NOT_REGISTERED",
      at: "payload.auditVerdict.auditor.runId",
    });
    const second = { identity: AUDITOR, workerId: auditorIdOf(on.taskId, 1, 2), runId: 2 };
    on.h.ledger.append(auditEvent({ taskId: on.taskId, transitionId: "audit.r2", record: verdictRecord(on.receipt, evidence, { auditor: second }) }));
    expect(on.h.ledger.listAuditVerdicts(on.receiptSha256).map((row) => row.auditorRunId)).toEqual([1, 2]);
    expect(on.h.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("N14: the same receipt again with the same metadata is a replay, and its ordinal is not judged again", () => {
    const on = recorded();
    const first = on.h.ledger.getVerification(on.receiptSha256);
    // A second event, a new event id and transition, carrying the same receipt.
    const replay = verificationEvent({ taskId: on.taskId, transitionId: "verify.replay", record: on.record });
    expect(on.h.ledger.append(replay).inserted).toBe(true);
    expect(on.h.ledger.getVerification(on.receiptSha256)).toEqual(first);
    expect(count(on.h.path, "verification_read_model")).toBe(1);
    on.h.ledger.rebuildReadModel();
    expect(on.h.ledger.getVerification(on.receiptSha256)).toEqual(first);
    expect(on.h.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("N12/N13 (fold): the same histories planted past the door are refused by the fold in the door's words", () => {
    // A receipt whose verifier the registry did not spawn.
    const h = harness();
    const taskId = randomUUID();
    openAttempt(h, taskId, { flat: 1 });
    const wrong = receiptValue({ taskId, overrides: { verifier: { identity: VERIFIER, workerId: verifierIdOf(taskId, 1, 2), runId: 2 } } });
    publish(h, json(wrong), "ref-wrong-run", "RECEIPT", taskId);
    h.close();
    plantChainedEvent(h.path, verificationEvent({ taskId, record: recordOf(wrong, "ref-wrong-run") }));
    const again = harnessAt(h.path);
    expect(again.ledger.verifyIntegrity().problems.map((problem) => problem.detail).join("\n")).toContain(
      "records a verification the fold refuses: VERIFIER_NOT_REGISTERED at payload.verification.verifier.runId",
    );
    expect(refusalOf(() => again.ledger.rebuildReadModel())).toEqual({
      reason: "VERIFIER_NOT_REGISTERED",
      at: "payload.verification.verifier.runId",
    });

    // A verdict whose auditor the registry did not spawn, on a lawful receipt.
    const on = recorded();
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    on.h.close();
    const auditor = { identity: AUDITOR, workerId: writerWorkerIdFor(on.taskId, 9), runId: 1 };
    plantChainedEvent(on.h.path, auditEvent({ taskId: on.taskId, record: verdictRecord(on.receipt, evidence, { auditor }) }));
    const planted = harnessAt(on.h.path);
    expect(planted.ledger.verifyIntegrity().ok).toBe(false);
    expect(refusalOf(() => planted.ledger.rebuildReadModel())).toEqual({
      reason: "AUDITOR_NOT_REGISTERED",
      at: "payload.auditVerdict.auditor.workerId",
    });
  });
});

describe("N6: a verdict is bound to a PASS receipt of its attempt, its tree and its writer", () => {
  it("refuses an unknown receipt, a foreign attempt, a FAIL receipt, another tree, another writer and a dependent auditor", () => {
    const on = recorded();
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    const refuse = (record: Record<string, unknown>, extra: Partial<FormInput> = {}) =>
      refusedCleanly(on.h, () => on.h.ledger.append(auditEvent({ taskId: on.taskId, record, ...extra })));

    expect(refuse(verdictRecord(on.receipt, evidence, { receiptSha256: "f".repeat(64) }))).toEqual({
      reason: "AUDIT_RECEIPT_UNKNOWN",
      at: "payload.auditVerdict.receiptSha256",
    });
    expect(refuse(verdictRecord(on.receipt, evidence, { treeSha: "fedcba9876543210fedcba9876543210fedcba98" }))).toEqual({
      reason: "AUDIT_TREE_MISMATCH",
      at: "payload.auditVerdict.treeSha",
    });
    expect(refuse(verdictRecord(on.receipt, evidence, { writerWorkerId: auditorIdOf(on.taskId) }))).toEqual({
      reason: "AUDIT_WRITER_MISMATCH",
      at: "payload.auditVerdict.writerWorkerId",
    });
    // Distinct labels, the writer's instance: independence is by instance too.
    expect(
      refuse(
        verdictRecord(on.receipt, evidence, {
          auditor: { identity: AUDITOR, workerId: writerWorkerIdFor(on.taskId, 1), runId: 1 },
        }),
      ),
    ).toEqual({ reason: "AUDITOR_NOT_INDEPENDENT", at: "payload.auditVerdict.auditor.workerId" });
    expect(refuse(verdictRecord(on.receipt, evidence, { auditor: { identity: WRITER, workerId: auditorIdOf(on.taskId), runId: 1 } }))).toEqual({
      reason: "AUDITOR_NOT_INDEPENDENT",
      at: "payload.auditVerdict.auditor.identity",
    });

    // A verdict under another attempt of the same revision, naming this receipt.
    openAttempt(on.h, on.taskId, { flat: 2, revisionNumber: 1, attemptNumber: 2 });
    expect(refuse(verdictRecord(on.receipt, evidence), { flat: 2, attemptNumber: 2 })).toEqual({
      reason: "RECEIPT_COORDINATE_MISMATCH",
      at: "payload.auditVerdict.receiptSha256",
    });
  });

  it("refuses a verdict on a FAIL receipt at the door, and the fold refuses the same history planted", () => {
    const on = recorded({ runStatus: "FAIL" });
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    const audit = auditEvent({ taskId: on.taskId, record: verdictRecord(on.receipt, evidence) });
    expect(refusedCleanly(on.h, () => on.h.ledger.append(audit))).toEqual({
      reason: "AUDIT_RECEIPT_NOT_PASS",
      at: "payload.auditVerdict.receiptSha256",
    });
    on.h.close();
    plantChainedEvent(on.h.path, audit);
    const again = harnessAt(on.h.path);
    expect(again.ledger.verifyIntegrity().problems.map((problem) => problem.detail).join("\n")).toContain(
      "AUDIT_RECEIPT_NOT_PASS at payload.auditVerdict.receiptSha256",
    );
    expect(refusalOf(() => again.ledger.rebuildReadModel()).reason).toBe("AUDIT_RECEIPT_NOT_PASS");
  });
});

describe("N7 / A5: one key, one row", () => {
  it("the same receipt with the same metadata keeps the first row, its sequence and its instant", () => {
    const on = recorded();
    const first = on.h.ledger.getVerification(on.receiptSha256);
    const again = verificationEvent({ taskId: on.taskId, transitionId: "verify.again", record: on.record, recordedAt: "2026-09-26T13:00:00.000Z" });
    expect(on.h.ledger.append(again).inserted).toBe(true);
    expect(on.h.ledger.getVerification(on.receiptSha256)).toEqual(first);
    expect(count(on.h.path, "verification_read_model")).toBe(1);
    const before = dump(on.h.path);
    on.h.ledger.rebuildReadModel();
    expect(dump(on.h.path)).toEqual(before);
  });

  it("the same receipt under another reference over the same bytes is RECEIPT_METADATA_CONFLICT", () => {
    const on = recorded();
    publish(on.h, json(on.receipt), "ref-same-bytes", "RECEIPT", on.taskId);
    const conflicting = verificationEvent({
      taskId: on.taskId,
      transitionId: "verify.other-reference",
      record: { ...on.record, artifactReferenceId: "ref-same-bytes" },
    });
    expect(refusedCleanly(on.h, () => on.h.ledger.append(conflicting))).toEqual({
      reason: "RECEIPT_METADATA_CONFLICT",
      at: "payload.verification.receiptSha256",
    });
  });

  it("a verdict's audit id is its event id: a reused one with other content is the stream's own conflict", () => {
    const on = recorded();
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    const audit = auditEvent({ taskId: on.taskId, record: verdictRecord(on.receipt, evidence) });
    on.h.ledger.append(audit);
    const reused = auditEvent({
      taskId: on.taskId,
      transitionId: "audit.reused",
      eventId: audit["eventId"] as string,
      record: verdictRecord(on.receipt, evidence, { verdict: "REJECT" }),
    });
    expect(() => on.h.ledger.append(reused)).toThrow(LedgerEventIdConflictError);
    expect(on.h.ledger.listAuditVerdicts(on.receiptSha256).map((row) => row.verdict)).toEqual(["ACCEPT"]);
  });
});

describe("N9: the evidence is the task's EVIDENCE, and it names the receipt", () => {
  it("refuses a misclassed, foreign, misdigested or unbound evidence", () => {
    const on = recorded();
    const refuse = (evidence: { artifactReferenceId: string; evidenceSha256: string }) =>
      refusedCleanly(on.h, () =>
        on.h.ledger.append(auditEvent({ taskId: on.taskId, transitionId: "audit." + randomUUID(), record: verdictRecord(on.receipt, evidence) })),
      );
    expect(refuse(publishEvidence(on.h, on.taskId, on.receiptSha256, "ref-ev-class", "RECEIPT"))).toEqual({
      reason: "EVIDENCE_REFERENCE_INVALID",
      at: "payload.auditVerdict.artifactReferenceId",
    });
    expect(refuse(publishEvidence(on.h, on.taskId, on.receiptSha256, "ref-ev-foreign", "EVIDENCE", randomUUID()))).toEqual({
      reason: "EVIDENCE_REFERENCE_INVALID",
      at: "payload.auditVerdict.artifactReferenceId",
    });
    const good = publishEvidence(on.h, on.taskId, on.receiptSha256);
    expect(refuse({ ...good, evidenceSha256: "9".repeat(64) })).toEqual({
      reason: "EVIDENCE_REFERENCE_INVALID",
      at: "payload.auditVerdict.evidenceSha256",
    });
    expect(refuse(publishEvidence(on.h, on.taskId, "8".repeat(64)))).toEqual({
      reason: "EVIDENCE_RECEIPT_MISMATCH",
      at: "payload.auditVerdict.evidenceSha256",
    });
    const opaqueId = "ref-ev-opaque";
    const opaqueSha = publish(on.h, Buffer.from("no json here", "utf8"), opaqueId, "EVIDENCE", on.taskId);
    expect(refuse({ artifactReferenceId: opaqueId, evidenceSha256: opaqueSha })).toEqual({
      reason: "EVIDENCE_RECEIPT_MISMATCH",
      at: "payload.auditVerdict.evidenceSha256",
    });
    expect(on.h.ledger.append(auditEvent({ taskId: on.taskId, transitionId: "audit.good", record: verdictRecord(on.receipt, good) })).inserted).toBe(true);
  });
});

describe("N10: a history before 28 holding either form (ND-10: born empty, no backfill)", () => {
  it("a receipt-form event recorded before 28 is reported by table, and folded by the rebuild", () => {
    const on = prepared();
    on.h.close();
    rewindTo27(on.h.path);
    // At 27 the old door admitted any record; planting stands for that history.
    plantChainedEvent(on.h.path, on.event);
    const again = harnessAt(on.h.path);
    expect(count(again.path, "verification_read_model")).toBe(0);
    const report = again.ledger.verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems.map((problem) => problem.detail).join("\n")).toContain("verification_read_model");
    again.ledger.rebuildReadModel();
    expect(again.ledger.getVerification(on.receiptSha256)?.taskId).toBe(on.taskId);
    expect(again.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("the stated limit: a pre-28 receipt-form event the door would refuse by its bytes is folded, and verify is then clean", () => {
    // ND-10 as the code does it (verification v1, N-1): the fold judges the record,
    // never the blob, so a row is byte-verified only for an event admitted at 28 or later.
    const on = prepared();
    const unnamed = verificationEvent({ taskId: on.taskId, record: { ...on.record, receiptSha256: "f".repeat(64) } });
    expect(refusedCleanly(on.h, () => on.h.ledger.append(unnamed))).toEqual({
      reason: "RECEIPT_DIGEST_MISMATCH",
      at: "payload.verification.receiptSha256",
    });
    on.h.close();
    rewindTo27(on.h.path);
    plantChainedEvent(on.h.path, unnamed);
    const again = harnessAt(on.h.path);
    const report = again.ledger.verifyIntegrity();
    expect(report.ok).toBe(false);
    const details = report.problems.map((problem) => problem.detail).join("\n");
    expect(details).toContain("verification_read_model");
    for (const word of VERIFICATION_REFUSALS) expect(details).not.toContain(word);
    again.ledger.rebuildReadModel();
    expect(again.ledger.getVerification("f".repeat(64))?.taskId).toBe(on.taskId);
    expect(again.ledger.getVerification(on.receiptSha256)).toBeNull();
    expect(again.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("a verdict-form event on no receipt, before 28, is refused by name on rebuild and reported on verify", () => {
    const on = recorded();
    const evidence = publishEvidence(on.h, on.taskId, "7".repeat(64));
    on.h.close();
    rewindTo27(on.h.path);
    plantChainedEvent(on.h.path, auditEvent({ taskId: on.taskId, record: verdictRecord(on.receipt, evidence, { receiptSha256: "7".repeat(64) }) }));
    const again = harnessAt(on.h.path);
    expect(again.ledger.verifyIntegrity().problems.map((problem) => problem.detail).join("\n")).toContain(
      "AUDIT_RECEIPT_UNKNOWN at payload.auditVerdict.receiptSha256",
    );
    expect(refusalOf(() => again.ledger.rebuildReadModel())).toEqual({
      reason: "AUDIT_RECEIPT_UNKNOWN",
      at: "payload.auditVerdict.receiptSha256",
    });
  });
});

describe("N11: insert-only, and cleared children first", () => {
  it("an update of either stored row aborts, and a delete out of DERIVED_TABLES order fails at once", () => {
    const on = recorded();
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    on.h.ledger.append(auditEvent({ taskId: on.taskId, record: verdictRecord(on.receipt, evidence) }));
    on.h.close();
    const raw = new Database(on.h.path);
    raw.pragma("foreign_keys = ON");
    expect(() => raw.prepare("UPDATE verification_read_model SET sequence = sequence").run()).toThrow(/insert-only/);
    expect(() => raw.prepare("UPDATE audit_verdict_read_model SET verdict = verdict").run()).toThrow(/insert-only/);
    // RESTRICT fires at once even on a deferred key: the receipt a verdict names.
    expect(() => raw.prepare("DELETE FROM verification_read_model").run()).toThrow(/FOREIGN KEY constraint failed/);
    // DERIVED_TABLES' order clears them, verdicts first.
    const order = DERIVED_TABLES.filter((table) => table === "audit_verdict_read_model" || table === "verification_read_model");
    expect(order).toEqual(["audit_verdict_read_model", "verification_read_model"]);
    raw.exec("BEGIN");
    for (const table of order) raw.prepare("DELETE FROM " + table).run();
    raw.exec("ROLLBACK");
    raw.close();
  });

  it("what L-P16B-1's text cannot see is held at runtime: a quoted name meets the trigger, and a delete is reported and restored", () => {
    const on = recorded();
    const evidence = publishEvidence(on.h, on.taskId, on.receiptSha256);
    on.h.ledger.append(auditEvent({ taskId: on.taskId, record: verdictRecord(on.receipt, evidence) }));
    const before = dump(on.h.path);
    const raw = new Database(on.h.path);
    raw.pragma("foreign_keys = ON");
    // The escaped-quote spelling the fence does not read (verification v1, N-2).
    expect(() => raw.prepare('UPDATE "verification_read_model" SET sequence = sequence').run()).toThrow(/insert-only/);
    expect(() => raw.prepare('UPDATE main."audit_verdict_read_model" SET verdict = verdict').run()).toThrow(/insert-only/);
    raw.exec('DELETE FROM "audit_verdict_read_model"; DELETE FROM "verification_read_model";');
    raw.close();
    const report = on.h.ledger.verifyIntegrity();
    expect(report.ok).toBe(false);
    const details = report.problems.map((problem) => problem.detail).join("\n");
    expect(details).toContain("verification_read_model");
    expect(details).toContain("audit_verdict_read_model");
    on.h.ledger.rebuildReadModel();
    expect(dump(on.h.path)).toEqual(before);
    expect(on.h.ledger.verifyIntegrity().problems).toEqual([]);
  });
});

// ===========================================================================
// Boundaries
// ===========================================================================

describe("B1-B5", () => {
  it("B1: the largest receipt-form and verdict-form payloads fit EVENT_PAYLOAD_MAX_BYTES", () => {
    // The widest identity the formatter composes: a 40-byte provider, a 60-byte model,
    // the longest role and a four-digit instance.
    const role = [...WORKER_ROLES].sort((a, b) => b.length - a.length)[0] ?? "";
    const identity = "p".repeat(40) + "/" + "m".repeat(60) + "/" + role + "/" + "9999";
    const uuid = "ffffffff-ffff-5fff-bfff-ffffffffffff";
    const reference = "r".repeat(512);
    const receiptForm = {
      revisionNumber: 10_000,
      attemptNumber: 10_000,
      verification: {
        receiptSha256: "f".repeat(64),
        artifactReferenceId: reference,
        baseSha: "f".repeat(40),
        treeSha: "f".repeat(40),
        policySha256: "f".repeat(64),
        writeSetSha256: "f".repeat(64),
        checksSha256: "f".repeat(64),
        runStatus: "FAIL",
        allChecksZero: false,
        writer: { identity, workerId: uuid },
        verifier: { identity, workerId: uuid, runId: Number.MAX_SAFE_INTEGER },
      },
    };
    const verdictForm = {
      revisionNumber: 10_000,
      attemptNumber: 10_000,
      auditVerdict: {
        receiptSha256: "f".repeat(64),
        treeSha: "f".repeat(40),
        writerWorkerId: uuid,
        auditor: { identity, workerId: uuid, runId: Number.MAX_SAFE_INTEGER },
        verdict: "ACCEPT_WITH_CORRECTIONS",
        evidenceSha256: "f".repeat(64),
        artifactReferenceId: reference,
      },
    };
    for (const payload of [receiptForm, verdictForm]) {
      const bytes = Buffer.byteLength(canonicalJsonStringify(payload), "utf8");
      expect(bytes).toBeLessThan(EVENT_PAYLOAD_MAX_BYTES);
    }
  });

  it("B2: a receipt at the schema maxima is read by reference and recorded; its bytes never enter the event", () => {
    const path = (n: number) => ("src/" + String(n).padStart(4, "0") + "/").padEnd(399, "x") + "t";
    const on = recorded({
      declaredWriteSet: Array.from({ length: 500 }, (_, n) => path(n)),
      observedTrackedChanges: Array.from({ length: 250 }, (_, n) => ({ path: path(n), sha256: "a".repeat(64) })),
      observedUntrackedPaths: Array.from({ length: 250 }, (_, n) => path(n + 250)),
      checks: Array.from({ length: 50 }, (_, n) => ({
        command: ("check " + String(n) + " ").padEnd(400, "c"),
        exitCode: 0,
        ranAt: "2026-09-26T11:00:00.000Z",
      })),
      commitMessageBody: "feat(runtime): a verified change\n\n" + "b".repeat(1_900),
    });
    expect(json(on.receipt).length).toBeGreaterThan(EVENT_PAYLOAD_MAX_BYTES * 10);
    expect(on.h.ledger.getVerification(on.receiptSha256)?.runStatus).toBe("PASS");
    const stored = on.h.ledger.listEvents({ taskId: on.taskId }).events.at(-1);
    expect(Buffer.byteLength(canonicalJsonStringify(stored?.event.payload), "utf8")).toBeLessThan(EVENT_PAYLOAD_MAX_BYTES);
  });

  it("B3: an offset instant is RECORDED_AT_NOT_CANONICAL at the door: zero rows, head unmoved", () => {
    const on = prepared();
    const offset = verificationEvent({ taskId: on.taskId, record: on.record, recordedAt: "2026-09-26T14:00:00.000+02:00" });
    expect(refusedCleanly(on.h, () => on.h.ledger.append(offset))).toEqual({
      reason: "RECORDED_AT_NOT_CANONICAL",
      at: "recordedAt",
    });
  });

  it("B4: an exact replay returns the first record before the grammar runs, even with its bytes gone", () => {
    const on = prepared();
    const first = on.h.ledger.append(on.event);
    const replay = on.h.ledger.append(on.event);
    expect(replay.inserted).toBe(false);
    expect(replay.record).toEqual(first.record);
    const root = artifactPlaneRootFor(on.h.path);
    renameSync(root, root + ".aside");
    const unreadable = on.h.ledger.append(on.event);
    expect(unreadable.inserted).toBe(false);
    expect(unreadable.record).toEqual(first.record);
    const batch = on.h.ledger.appendBatch([on.event]);
    expect(batch.insertedCount).toBe(0);
    expect(count(on.h.path, "verification_read_model")).toBe(1);
  });

  it("B5: two receipts of one attempt are both recorded, and each verdict binds to its own", () => {
    const on = recorded();
    // The second is its own spawn: run id 2 and its own registry id (P-16/C).
    const second = receiptValue({
      taskId: on.taskId,
      overrides: {
        checks: [{ command: "pnpm check", exitCode: 0, ranAt: "2026-09-26T11:30:00.000Z" }],
        verifier: { identity: VERIFIER, workerId: verifierIdOf(on.taskId, 1, 2), runId: 2 },
      },
    });
    publish(on.h, json(second), "ref-second", "RECEIPT", on.taskId);
    const secondRecord = recordOf(second, "ref-second");
    on.h.ledger.append(verificationEvent({ taskId: on.taskId, transitionId: "verify.2", record: secondRecord }));
    const secondSha = secondRecord["receiptSha256"] as string;
    expect(secondSha).not.toBe(on.receiptSha256);
    for (const [receipt, sha, transitionId, runId] of [
      [on.receipt, on.receiptSha256, "audit.first", 1],
      [second, secondSha, "audit.second", 2],
    ] as const) {
      const evidence = publishEvidence(on.h, on.taskId, sha);
      const auditor = { identity: AUDITOR, workerId: auditorIdOf(on.taskId, 1, runId), runId };
      on.h.ledger.append(auditEvent({ taskId: on.taskId, transitionId, record: verdictRecord(receipt, evidence, { auditor }) }));
    }
    expect(on.h.ledger.listAuditVerdicts(on.receiptSha256)).toHaveLength(1);
    expect(on.h.ledger.listAuditVerdicts(secondSha)).toHaveLength(1);
    expect(count(on.h.path, "verification_read_model")).toBe(2);
    expect(on.h.ledger.verifyIntegrity().problems).toEqual([]);
  });
});
