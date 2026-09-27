import { VerificationReceipt, isCanonicalInstant, isSha256Hex, type ControlPlaneEvent } from "@acp/contracts";

import { readByReference } from "../artifact-plane/index.js";
import { canonicalJsonStringify } from "../canonical-json/index.js";
import { LedgerVerificationRefusedError } from "../errors/index.js";
import type { Ledger } from "../ledger/index.js";
import { receiptVerificationColumns, supervisedWorkerIdFor, writerWorkerIdFor } from "../receipt-identity/index.js";
import type { AuditVerdictReadModel, VerificationReadModel } from "../types/index.js";

import type {
  VerificationArtifactRead,
  VerificationDecision,
  VerificationDecisionView,
  VerificationReferenceRow,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and are
 * re-exported here unchanged (owner law §7).
 */
export type {
  VerificationArtifactRead,
  VerificationDecision,
  VerificationDecisionView,
  VerificationReferenceRow,
} from "./types/index.js";

/**
 * A verification is recorded by its receipt, and a verdict by its tree — P-16/B, ADR
 * 0122 (execution §10.2-§10.3; decisions 231-233).
 *
 * ## Two forms of one type
 *
 * `VERIFICATION_COMPLETED` and `AUDIT_COMPLETED` already exist, and the walk emits
 * both as beats. A beat is admitted byte-unchanged and projects nothing (ND-2). An
 * event is in **receipt form** when its type is `VERIFICATION_COMPLETED` and its
 * payload holds the key `verification`, and in **verdict form** when its type is
 * `AUDIT_COMPLETED` and its payload holds `auditVerdict`; never `verdict`, which beat
 * payloads already use. Both forms are closed at every level: the payload is exactly
 * the V2 coordinate and the record, and a missing, extra or mistyped member is
 * `RECEIPT_RECORD_INVALID` or `AUDIT_RECORD_INVALID` at its path.
 *
 * ## One decision, two callers
 *
 * `decideVerificationRecord` is pure over the event and what its caller answers about
 * the history. The task door calls it inside its `BEGIN IMMEDIATE`, over the tables
 * that transaction keeps level, and the fold calls it over the snapshot a rebuild or
 * `verifyIntegrity()` is filling: the same word in both (decision 56). It reads no
 * byte. What only bytes can answer is the door's alone: `readVerificationArtifact`
 * reads the receipt or the evidence by reference before the lock, as a value, and
 * `assertVerificationArtifact` judges that value inside the transaction, after the
 * replay check. The door recomputes the receipt's name from its bytes and never
 * believes a carried one; the fold and `verifyIntegrity()` copy what the door
 * admitted and never reopen a blob (ND-4, execution §10.1).
 *
 * ## The writer's id, and the bijection
 *
 * The coordinate `(task, revision, attempt)` must name an opened attempt, and the
 * carried writer id must be `writerWorkerIdFor(taskId, legacy)`, where `legacy` is
 * that attempt row's flat number: never the per-revision `attemptNumber`, which
 * restarts in each revision (decision 229). Both callers recompute it (ND-17).
 *
 * ## The spawn registry (P-16/C, ADR 0123; decision 236)
 *
 * The verifier's and the auditor's ids are the registry's: for a key not yet held, the
 * run id must be the next ordinal of the coordinate and the role, `1 + lastRunId`, or
 * the record is `VERIFIER_NOT_REGISTERED` / `AUDITOR_NOT_REGISTERED` at `…runId`; then
 * the instance id must be `supervisedWorkerIdFor(taskId, legacy, role, runId)`, role
 * `verifier` or `reviewer`, or the same word at `…workerId`. A key already held (the
 * same receipt again with the same metadata) is a replay and is not re-judged. Both
 * callers answer `lastRunId` from what they hold, so a rebuild refuses the same ids in
 * the same words. Stated limits: a spawn that crashed before its receipt was recorded
 * leaves no row, and its ordinal is reused by the retry; of two concurrent runs of
 * one attempt the second append is refused `VERIFIER_NOT_REGISTERED` (P-18 owns both).
 */

/**
 * The closed refusal vocabulary, sorted (ND-8, frozen in ADR 0122 at nineteen; ADR
 * 0123 adds the registry's two, `AUDITOR_NOT_REGISTERED` and
 * `VERIFIER_NOT_REGISTERED`). Every refusal names the field that failed, never a value.
 */
export const VERIFICATION_REFUSALS = [
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
] as const;

export type VerificationRefusal = (typeof VERIFICATION_REFUSALS)[number];

/** The payload key a receipt-form `VERIFICATION_COMPLETED` carries its record under. */
export const VERIFICATION_KEY = "verification";

/** The payload key a verdict-form `AUDIT_COMPLETED` carries its record under. */
export const AUDIT_VERDICT_KEY = "auditVerdict";

/** Every key a receipt-form record carries, and no other: all required. */
export const VERIFICATION_RECORD_KEYS = [
  "receiptSha256",
  "artifactReferenceId",
  "baseSha",
  "treeSha",
  "policySha256",
  "writeSetSha256",
  "checksSha256",
  "runStatus",
  "allChecksZero",
  "writer",
  "verifier",
] as const;

/** Every key a verdict-form record carries, and no other: all required. */
export const AUDIT_VERDICT_RECORD_KEYS = [
  "receiptSha256",
  "treeSha",
  "writerWorkerId",
  "auditor",
  "verdict",
  "evidenceSha256",
  "artifactReferenceId",
] as const;

const WRITER_KEYS = ["identity", "workerId"] as const;
const RUN_KEYS = ["identity", "workerId", "runId"] as const;

/**
 * The three verdicts, module-private (ND-3): observation owns the vocabulary its
 * baseline reads, and the ledger may not import it. Execution §10.3's CHECK spells the
 * same three.
 */
const AUDIT_VERDICTS: readonly string[] = ["ACCEPT", "ACCEPT_WITH_CORRECTIONS", "REJECT"];

/** The registry's bound on a reference id (`artifact-record`'s identifier). */
const ARTIFACT_REFERENCE_ID_MAX = 512;

/**
 * The receipt's own field schemas, reached through the contract rather than restated:
 * a carried member is held to exactly the grammar its receipt member was parsed by.
 */
const RECEIPT_FIELDS = VerificationReceipt.shape;
const WORKER_FIELDS = RECEIPT_FIELDS.verifier.shape;

function refuse(reason: VerificationRefusal, at: string): never {
  throw new LedgerVerificationRefusedError(reason, at);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hold one object to a closed key list: every key present, no other. A stray key is
 * refused at the object's own path, never at a name the producer chose.
 */
function closed(
  value: unknown,
  keys: readonly string[],
  reason: VerificationRefusal,
  at: string,
): Record<string, unknown> {
  if (!isRecord(value)) refuse(reason, at);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) refuse(reason, at + "." + key);
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) refuse(reason, at);
  return value;
}

function coordinate(value: unknown, reason: VerificationRefusal, at: string): number {
  if (!RECEIPT_FIELDS.revisionNumber.safeParse(value).success) refuse(reason, at);
  return value as number;
}

function digest(value: unknown, reason: VerificationRefusal, at: string): string {
  if (!isSha256Hex(value)) refuse(reason, at);
  return value;
}

function objectId(value: unknown, reason: VerificationRefusal, at: string): string {
  if (!RECEIPT_FIELDS.treeSha.safeParse(value).success) refuse(reason, at);
  return value as string;
}

function referenceId(value: unknown, reason: VerificationRefusal, at: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ARTIFACT_REFERENCE_ID_MAX) refuse(reason, at);
  return value;
}

interface Worker {
  readonly identity: string;
  readonly workerId: string;
  readonly runId: number | null;
}

function worker(value: unknown, withRun: boolean, reason: VerificationRefusal, at: string): Worker {
  const record = closed(value, withRun ? RUN_KEYS : WRITER_KEYS, reason, at);
  if (!WORKER_FIELDS.identity.safeParse(record["identity"]).success) refuse(reason, at + ".identity");
  if (!WORKER_FIELDS.workerId.safeParse(record["workerId"]).success) refuse(reason, at + ".workerId");
  if (withRun && !WORKER_FIELDS.runId.safeParse(record["runId"]).success) refuse(reason, at + ".runId");
  return {
    identity: record["identity"] as string,
    workerId: record["workerId"] as string,
    runId: withRun ? (record["runId"] as number) : null,
  };
}

/** Which form an event is in, or null for a beat or any other type. */
function formOf(event: ControlPlaneEvent): typeof VERIFICATION_KEY | typeof AUDIT_VERDICT_KEY | null {
  if (event.type === "VERIFICATION_COMPLETED" && Object.hasOwn(event.payload, VERIFICATION_KEY)) return VERIFICATION_KEY;
  if (event.type === "AUDIT_COMPLETED" && Object.hasOwn(event.payload, AUDIT_VERDICT_KEY)) return AUDIT_VERDICT_KEY;
  return null;
}

/** Every column but `sequence` and `recordedAt`: what "the same metadata" compares. */
function metadataOf(row: VerificationReadModel | AuditVerdictReadModel): string {
  const metadata: Record<string, unknown> = { ...row };
  delete metadata["sequence"];
  delete metadata["recordedAt"];
  return canonicalJsonStringify(metadata);
}

/**
 * The attempt a record names, and the flat number it was opened under. Both forms
 * hang off an opened attempt: the table's foreign key would otherwise abort, and the
 * writer's id has no flat number to be derived from.
 */
function openedAttempt(
  view: VerificationDecisionView,
  event: ControlPlaneEvent,
  revisionNumber: number,
  attemptNumber: number,
): number {
  const legacy = view.legacyAttempt(event.taskId, revisionNumber, attemptNumber);
  if (legacy === null) refuse("RECEIPT_ATTEMPT_UNOPENED", "payload.attemptNumber");
  // The door's `#assertAttemptIdentity` has refused this already; the fold meets it
  // only in a history the door never wrote.
  if (event.attempt !== legacy) refuse("RECEIPT_COORDINATE_MISMATCH", "attempt");
  return legacy;
}

function decideVerification(
  view: VerificationDecisionView,
  event: ControlPlaneEvent,
  sequence: number,
): VerificationDecision {
  const at = "payload." + VERIFICATION_KEY;
  const payload = closed(event.payload, ["revisionNumber", "attemptNumber", VERIFICATION_KEY], "RECEIPT_RECORD_INVALID", "payload");
  const revisionNumber = coordinate(payload["revisionNumber"], "RECEIPT_RECORD_INVALID", "payload.revisionNumber");
  const attemptNumber = coordinate(payload["attemptNumber"], "RECEIPT_RECORD_INVALID", "payload.attemptNumber");
  const record = closed(payload[VERIFICATION_KEY], VERIFICATION_RECORD_KEYS, "RECEIPT_RECORD_INVALID", at);
  const receiptSha256 = digest(record["receiptSha256"], "RECEIPT_RECORD_INVALID", at + ".receiptSha256");
  const artifactReferenceId = referenceId(record["artifactReferenceId"], "RECEIPT_RECORD_INVALID", at + ".artifactReferenceId");
  const baseSha = objectId(record["baseSha"], "RECEIPT_RECORD_INVALID", at + ".baseSha");
  const treeSha = objectId(record["treeSha"], "RECEIPT_RECORD_INVALID", at + ".treeSha");
  const policySha256 = digest(record["policySha256"], "RECEIPT_RECORD_INVALID", at + ".policySha256");
  const writeSetSha256 = digest(record["writeSetSha256"], "RECEIPT_RECORD_INVALID", at + ".writeSetSha256");
  const checksSha256 = digest(record["checksSha256"], "RECEIPT_RECORD_INVALID", at + ".checksSha256");
  const runStatus = record["runStatus"];
  if (!RECEIPT_FIELDS.runStatus.safeParse(runStatus).success) refuse("RECEIPT_RECORD_INVALID", at + ".runStatus");
  const allChecksZero = record["allChecksZero"];
  if (typeof allChecksZero !== "boolean") refuse("RECEIPT_RECORD_INVALID", at + ".allChecksZero");
  // `PASS` with a nonzero check is the one forbidden cell (§10.2); `FAIL` either way is lawful.
  if (runStatus === "PASS" && !allChecksZero) refuse("RECEIPT_RECORD_INVALID", at + ".allChecksZero");
  const writer = worker(record["writer"], false, "RECEIPT_RECORD_INVALID", at + ".writer");
  const verifier = worker(record["verifier"], true, "RECEIPT_RECORD_INVALID", at + ".verifier");

  // The instant the row copies is canonical, or it is not recorded (B-3): the
  // contract admits an offset `Timestamp`, and §10.2 never does.
  if (!isCanonicalInstant(event.recordedAt)) refuse("RECORDED_AT_NOT_CANONICAL", "recordedAt");

  const legacy = openedAttempt(view, event, revisionNumber, attemptNumber);
  if (writer.workerId !== writerWorkerIdFor(event.taskId, legacy)) refuse("WRITER_ID_MISMATCH", at + ".writer.workerId");
  // Independence by label and by instance: the label alone is the hole the canon names.
  if (verifier.identity === writer.identity) refuse("VERIFIER_NOT_INDEPENDENT", at + ".verifier.identity");
  if (verifier.workerId === writer.workerId) refuse("VERIFIER_NOT_INDEPENDENT", at + ".verifier.workerId");

  // The spawn registry (P-16/C): judged only for a key not yet held, so a replay of the
  // same receipt with the same metadata keeps its first row.
  const stored = view.verification(receiptSha256);
  if (stored === null) {
    const runId = verifier.runId ?? 0;
    const next = view.lastRunId("verifier", event.taskId, revisionNumber, attemptNumber) + 1;
    if (runId !== next) refuse("VERIFIER_NOT_REGISTERED", at + ".verifier.runId");
    if (verifier.workerId !== supervisedWorkerIdFor(event.taskId, legacy, "verifier", next)) {
      refuse("VERIFIER_NOT_REGISTERED", at + ".verifier.workerId");
    }
  }

  const row: VerificationReadModel = {
    receiptSha256,
    taskId: event.taskId,
    revisionNumber,
    attemptNumber,
    verifierIdentity: verifier.identity,
    verifierWorkerId: verifier.workerId,
    verifierRunId: verifier.runId ?? 0,
    writerIdentity: writer.identity,
    writerWorkerId: writer.workerId,
    baseSha,
    treeSha,
    policySha256,
    writeSetSha256,
    artifactReferenceId,
    checksSha256,
    runStatus: runStatus as VerificationReadModel["runStatus"],
    allChecksZero,
    recordedAt: event.recordedAt,
    sequence,
  };
  if (stored === null) return { kind: "VERIFICATION", row, recorded: false };
  if (metadataOf(stored) !== metadataOf(row)) refuse("RECEIPT_METADATA_CONFLICT", at + ".receiptSha256");
  return { kind: "VERIFICATION", row: stored, recorded: true };
}

function decideAuditVerdict(
  view: VerificationDecisionView,
  event: ControlPlaneEvent,
  sequence: number,
): VerificationDecision {
  const at = "payload." + AUDIT_VERDICT_KEY;
  const payload = closed(event.payload, ["revisionNumber", "attemptNumber", AUDIT_VERDICT_KEY], "AUDIT_RECORD_INVALID", "payload");
  const revisionNumber = coordinate(payload["revisionNumber"], "AUDIT_RECORD_INVALID", "payload.revisionNumber");
  const attemptNumber = coordinate(payload["attemptNumber"], "AUDIT_RECORD_INVALID", "payload.attemptNumber");
  const record = closed(payload[AUDIT_VERDICT_KEY], AUDIT_VERDICT_RECORD_KEYS, "AUDIT_RECORD_INVALID", at);
  const receiptSha256 = digest(record["receiptSha256"], "AUDIT_RECORD_INVALID", at + ".receiptSha256");
  const treeSha = objectId(record["treeSha"], "AUDIT_RECORD_INVALID", at + ".treeSha");
  const writerWorkerId = record["writerWorkerId"];
  if (!WORKER_FIELDS.workerId.safeParse(writerWorkerId).success) refuse("AUDIT_RECORD_INVALID", at + ".writerWorkerId");
  const auditor = worker(record["auditor"], true, "AUDIT_RECORD_INVALID", at + ".auditor");
  const verdict = record["verdict"];
  if (typeof verdict !== "string" || !AUDIT_VERDICTS.includes(verdict)) refuse("AUDIT_RECORD_INVALID", at + ".verdict");
  const evidenceSha256 = digest(record["evidenceSha256"], "AUDIT_RECORD_INVALID", at + ".evidenceSha256");
  const artifactReferenceId = referenceId(record["artifactReferenceId"], "AUDIT_RECORD_INVALID", at + ".artifactReferenceId");

  if (!isCanonicalInstant(event.recordedAt)) refuse("RECORDED_AT_NOT_CANONICAL", "recordedAt");

  const legacy = openedAttempt(view, event, revisionNumber, attemptNumber);

  // The receipt row, checked field by field against the verdict (§10.3 "Validación de
  // referencia"): known, of this coordinate, `PASS`, this tree, this writer.
  const receipt = view.verification(receiptSha256);
  if (receipt === null) refuse("AUDIT_RECEIPT_UNKNOWN", at + ".receiptSha256");
  if (
    receipt.taskId !== event.taskId ||
    receipt.revisionNumber !== revisionNumber ||
    receipt.attemptNumber !== attemptNumber
  ) {
    refuse("RECEIPT_COORDINATE_MISMATCH", at + ".receiptSha256");
  }
  if (receipt.runStatus !== "PASS") refuse("AUDIT_RECEIPT_NOT_PASS", at + ".receiptSha256");
  if (treeSha !== receipt.treeSha) refuse("AUDIT_TREE_MISMATCH", at + ".treeSha");
  if (writerWorkerId !== receipt.writerWorkerId) refuse("AUDIT_WRITER_MISMATCH", at + ".writerWorkerId");
  if (auditor.identity === receipt.writerIdentity) refuse("AUDITOR_NOT_INDEPENDENT", at + ".auditor.identity");
  if (auditor.workerId === receipt.writerWorkerId) refuse("AUDITOR_NOT_INDEPENDENT", at + ".auditor.workerId");

  // The spawn registry (P-16/C), role `reviewer`. The stream's own `event_id` is
  // unique, so the door never meets a second verdict under one id and always judges;
  // the fold meets a held id only in a history the door never wrote, and judges the rest.
  const stored = view.auditVerdict(event.eventId);
  if (stored === null) {
    const runId = auditor.runId ?? 0;
    const next = view.lastRunId("reviewer", event.taskId, revisionNumber, attemptNumber) + 1;
    if (runId !== next) refuse("AUDITOR_NOT_REGISTERED", at + ".auditor.runId");
    if (auditor.workerId !== supervisedWorkerIdFor(event.taskId, legacy, "reviewer", next)) {
      refuse("AUDITOR_NOT_REGISTERED", at + ".auditor.workerId");
    }
  }

  const row: AuditVerdictReadModel = {
    auditId: event.eventId,
    taskId: event.taskId,
    revisionNumber,
    attemptNumber,
    receiptSha256,
    treeSha,
    writerWorkerId: receipt.writerWorkerId,
    auditorIdentity: auditor.identity,
    auditorWorkerId: auditor.workerId,
    auditorRunId: auditor.runId ?? 0,
    verdict: verdict as AuditVerdictReadModel["verdict"],
    evidenceSha256,
    artifactReferenceId,
    recordedAt: event.recordedAt,
    sequence,
  };
  if (stored === null) return { kind: "AUDIT_VERDICT", row, recorded: false };
  if (metadataOf(stored) !== metadataOf(row)) refuse("RECEIPT_METADATA_CONFLICT", "eventId");
  return { kind: "AUDIT_VERDICT", row: stored, recorded: true };
}

/**
 * Decide one event: null for any event in neither form, a row to write or to keep,
 * or a refusal thrown as `LedgerVerificationRefusedError`.
 *
 * The order is the design, coarsest first: the payload's grammar at every level, the
 * instant, the attempt the coordinate names and its flat number, then the form's own
 * facts — for a receipt the writer's derived id and the verifier's independence; for
 * a verdict its receipt row, that row's coordinate, `PASS`, tree and writer, and the
 * auditor's independence — then, for a key not yet held, the spawn registry's run id
 * and instance id (P-16/C), and last the key already held, a replay with the same
 * metadata or `RECEIPT_METADATA_CONFLICT`.
 */
export function decideVerificationRecord(
  view: VerificationDecisionView,
  event: ControlPlaneEvent,
  sequence: number,
): VerificationDecision | null {
  const form = formOf(event);
  if (form === null) return null;
  return form === VERIFICATION_KEY ? decideVerification(view, event, sequence) : decideAuditVerdict(view, event, sequence);
}

/**
 * Read the receipt or the evidence a record names, by reference under the event's
 * task, before the door's lock (ND-4, B-5).
 *
 * A value, never a throw: null for an event in neither form or a record naming no
 * reference id at all (the decision refuses that by its grammar), otherwise the bytes
 * and the digest the reference pins, or the reader's own refusal. `readByReference`
 * verifies the bytes against that digest on the way out. A re-derivation and not a
 * sink: the bytes reach the door's comparison and nothing else — no event, response,
 * log or error message.
 */
export function readVerificationArtifact(ledger: Ledger, event: ControlPlaneEvent): VerificationArtifactRead | null {
  const form = formOf(event);
  if (form === null) return null;
  const record = event.payload[form];
  const id = isRecord(record) ? record["artifactReferenceId"] : undefined;
  if (typeof id !== "string" || id.length === 0) return null;
  const read = readByReference(ledger, { artifactReferenceId: id, scopeKind: "TASK", scopeId: event.taskId });
  if (read.verb !== "READ") return { ok: false, refusal: read.refusal };
  return { ok: true, content: read.content, contentSha256: read.reference.contentSha256 };
}

/** One JSON value from bytes, or undefined: a parse failure is the caller's word. */
function parsedJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Judge the bytes a granted decision's record names, inside the door's transaction.
 *
 * For a receipt: the registry's row is a `RECEIPT` scoped to this task and pins the
 * bytes that were read (`RECEIPT_REFERENCE_INVALID`); the bytes were read and are a
 * `VerificationReceipt` (`RECEIPT_UNREADABLE`); the receipt's name, recomputed from
 * them, is the carried one (`RECEIPT_DIGEST_MISMATCH`); its coordinate is the event's
 * (`RECEIPT_COORDINATE_MISMATCH`); and every carried column is the one derived from it
 * (`RECEIPT_FIELD_MISMATCH`, at the column's path). The artifact's `content_sha256` and
 * `receipt_sha256` are different digests and are never compared to each other.
 *
 * For a verdict: the registry's row is an `EVIDENCE` scoped to this task whose digest
 * is the carried `evidenceSha256`, and it produced the bytes read
 * (`EVIDENCE_REFERENCE_INVALID`); the bytes are a JSON object whose string member
 * `receiptSha256` is the verdict's (`EVIDENCE_RECEIPT_MISMATCH`, ND-5).
 */
export function assertVerificationArtifact(
  decision: VerificationDecision,
  read: VerificationArtifactRead | null,
  reference: (artifactReferenceId: string) => VerificationReferenceRow | null,
): void {
  if (decision.kind === "AUDIT_VERDICT") {
    const at = "payload." + AUDIT_VERDICT_KEY;
    const { row } = decision;
    const held = reference(row.artifactReferenceId);
    if (held?.artifactClass !== "EVIDENCE" || held.scopeKind !== "TASK" || held.scopeId !== row.taskId) {
      refuse("EVIDENCE_REFERENCE_INVALID", at + ".artifactReferenceId");
    }
    if (held.contentSha256 !== row.evidenceSha256) refuse("EVIDENCE_REFERENCE_INVALID", at + ".evidenceSha256");
    if (read === null || !read.ok || read.contentSha256 !== held.contentSha256) {
      refuse("EVIDENCE_REFERENCE_INVALID", at + ".artifactReferenceId");
    }
    const evidence = parsedJson(read.content);
    if (!isRecord(evidence) || typeof evidence["receiptSha256"] !== "string" || evidence["receiptSha256"] !== row.receiptSha256) {
      refuse("EVIDENCE_RECEIPT_MISMATCH", at + ".evidenceSha256");
    }
    return;
  }

  const at = "payload." + VERIFICATION_KEY;
  const { row } = decision;
  const held = reference(row.artifactReferenceId);
  if (held?.artifactClass !== "RECEIPT" || held.scopeKind !== "TASK" || held.scopeId !== row.taskId) {
    refuse("RECEIPT_REFERENCE_INVALID", at + ".artifactReferenceId");
  }
  if (!read?.ok) refuse("RECEIPT_UNREADABLE", at + ".artifactReferenceId");
  if (read.contentSha256 !== held.contentSha256) refuse("RECEIPT_REFERENCE_INVALID", at + ".artifactReferenceId");
  let columns;
  try {
    columns = receiptVerificationColumns(parsedJson(read.content));
  } catch {
    refuse("RECEIPT_UNREADABLE", at + ".artifactReferenceId");
  }
  if (columns.receiptSha256 !== row.receiptSha256) refuse("RECEIPT_DIGEST_MISMATCH", at + ".receiptSha256");
  if (columns.taskId !== row.taskId) refuse("RECEIPT_COORDINATE_MISMATCH", "taskId");
  if (columns.revisionNumber !== row.revisionNumber) refuse("RECEIPT_COORDINATE_MISMATCH", "payload.revisionNumber");
  if (columns.attemptNumber !== row.attemptNumber) refuse("RECEIPT_COORDINATE_MISMATCH", "payload.attemptNumber");
  const pairs: readonly (readonly [string, unknown, unknown])[] = [
    ["baseSha", row.baseSha, columns.baseSha],
    ["treeSha", row.treeSha, columns.treeSha],
    ["policySha256", row.policySha256, columns.policySha256],
    ["writeSetSha256", row.writeSetSha256, columns.writeSetSha256],
    ["checksSha256", row.checksSha256, columns.checksSha256],
    ["runStatus", row.runStatus, columns.runStatus],
    ["allChecksZero", row.allChecksZero, columns.allChecksZero],
    ["writer.identity", row.writerIdentity, columns.writer.identity],
    ["writer.workerId", row.writerWorkerId, columns.writer.workerId],
    ["verifier.identity", row.verifierIdentity, columns.verifier.identity],
    ["verifier.workerId", row.verifierWorkerId, columns.verifier.workerId],
    ["verifier.runId", row.verifierRunId, columns.verifier.runId],
  ];
  for (const [path, carried, derived] of pairs) {
    if (carried !== derived) refuse("RECEIPT_FIELD_MISMATCH", at + "." + path);
  }
}
