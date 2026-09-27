import { randomUUID } from "node:crypto";

import { AuditEvidence, CONTRACT_VERSION, TERMINAL_STATES, VerificationReceipt, buildV2IdempotencyKey } from "@acp/contracts";
import {
  ARTIFACT_ACCESS_POLICY_IDS,
  LedgerVerificationRefusedError,
  canonicalJsonStringify,
  receiptVerificationColumns,
  supervisedWorkerIdFor,
  verificationPolicySha256,
} from "@acp/ledger";
import type { AuditVerdictReadModel } from "@acp/ledger";
import { readRecordedTask } from "@acp/runtime";
import type { AuditorPort } from "@acp/runtime";

import type { AuditRule, AuditorRefusal, LocalAuditOutcome, LocalAuditorInput } from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and are
 * re-exported here unchanged (owner law §7).
 */
export type { AuditRule, AuditorRefusal, LocalAuditOutcome, LocalAuditorInput } from "./types/index.js";

/**
 * The deterministic local auditor — P-16/D1, ADR 0124 (decision 239; ND-6, ND-7, ND-8).
 *
 * The plane's first auditor, and it is a rule engine, not a model: no spawn, no Git, no
 * provider, no network, no clock but the one it is given for the instants it records.
 * It implements runtime's `AuditorPort` and is daemon-internal (off the barrel): the
 * recorded walk asks it between steps 6 and 7, over the receipt step 6 consumed.
 *
 * ## What one audit does, in order
 *
 * 1. The receipt row, through the ledger (`getVerification`): known
 *    (`AUDITOR_RECEIPT_UNKNOWN`), of the coordinate asked about, and `PASS`
 *    (`AUDITOR_RECEIPT_NOT_PASS`) — the door would refuse a verdict on any other.
 * 2. The task, through runtime's `readRecordedTask`, and not terminal
 *    (`AUDITOR_TASK_UNREADABLE`, `AUDITOR_TASK_TERMINAL`); the receipt's bytes, by
 *    reference through the plane, parsed as a `VerificationReceipt`
 *    (`AUDITOR_RECEIPT_UNREADABLE`: a refusal, never a verdict).
 * 3. Its run, before anything is published: `runId = 1 +` the coordinate's largest
 *    `auditor_run_id` (the door's `lastRunId("reviewer", …)`), and its instance id
 *    `supervisedWorkerIdFor(task, flat, "reviewer", runId)`.
 * 4. The six closed rules, each `PASS` or `FAIL`, and the verdict: `ACCEPT` iff every
 *    rule passes, otherwise `REJECT` (a rule engine has no corrections to propose).
 * 5. The evidence (contracts' `AuditEvidence`, canonical JSON), published as a private
 *    `EVIDENCE` artifact scoped to the task, `PERMANENT`, with no expiry
 *    (`AUDITOR_PUBLICATION_REFUSED`).
 * 6. The verdict-form `AUDIT_COMPLETED`, same-state, under `audit.run.<runId>`, through
 *    `Ledger.append` (`AUDITOR_RECORD_REFUSED`, the door's word carried).
 *
 * ## The rules
 *
 * - `RECEIPT_BYTES_MATCH` — the bytes read by reference recompute the row's name.
 * - `RECEIPT_PASS` — the receipt says `PASS`, with at least one check, all zero.
 * - `CHANGES_WITHIN_WRITE_SET` — every observed tracked and untracked path is declared
 *   by the recorded envelope.
 * - `POLICY_MATCHES_ENVELOPE` — `verificationPolicySha256` of the recorded envelope is
 *   the receipt's.
 * - `INDEPENDENT_IDS` — writer, verifier and auditor pairwise distinct, by label and by
 *   instance id.
 * - `DIFF_PRESENT_FOR_COMMIT` — under `LOCAL_COMMIT_WITH_RECEIPT`, at least one
 *   observed difference; vacuous under `NO_COMMIT`.
 *
 * The "diff" is the receipt's recorded observation (paths and digests), never a file's
 * content. Nothing here writes a byte of its own except through the plane and the
 * ledger.
 */

/** The closed refusal vocabulary, sorted. Every refusal names the field, never a value. */
export const AUDITOR_REFUSALS = [
  "AUDITOR_PUBLICATION_REFUSED",
  "AUDITOR_RECEIPT_NOT_PASS",
  "AUDITOR_RECEIPT_UNKNOWN",
  "AUDITOR_RECEIPT_UNREADABLE",
  "AUDITOR_RECORD_REFUSED",
  "AUDITOR_TASK_TERMINAL",
  "AUDITOR_TASK_UNREADABLE",
] as const;

/** The auditor's label: a worker identity no writer and no verifier holds (role `reviewer`, ND-8). */
export const AUDITOR_IDENTITY = "acp/deterministic-auditor/reviewer/01";

/** The evidence's media type and profile: canonical JSON, plaintext at rest. */
const EVIDENCE_MEDIA_TYPE = "application/json";
const EVIDENCE_ENCRYPTION_PROFILE = "local-plaintext-v1";
/** How long the plane's holding of the evidence's blob lasts. */
const EVIDENCE_HOLDING_WINDOW_MS = 5 * 60 * 1000;

type Refused = Extract<LocalAuditOutcome, { ok: false }>;

function refuse(refusal: AuditorRefusal, at: string, word: string | null = null): Refused {
  return Object.freeze({ ok: false as const, refusal, at, word });
}

/** The coordinate one audit runs under, as the phase names it. */
type Coordinate = Parameters<AuditorPort["audit"]>[0];

/** Every verdict of the coordinate: through its receipts, since a verdict's coordinate is its receipt's. */
function verdictsOf(ledger: LocalAuditorInput["ledger"], coordinate: Coordinate): readonly AuditVerdictReadModel[] {
  const verdicts: AuditVerdictReadModel[] = [];
  for (const receipt of ledger.listVerifications(coordinate.taskId, coordinate.revisionNumber, coordinate.attemptNumber)) {
    for (const verdict of ledger.listAuditVerdicts(receipt.receiptSha256)) {
      if (
        verdict.taskId === coordinate.taskId &&
        verdict.revisionNumber === coordinate.revisionNumber &&
        verdict.attemptNumber === coordinate.attemptNumber
      ) {
        verdicts.push(verdict);
      }
    }
  }
  return verdicts;
}

/** The largest-run verdict on one receipt that `keep` admits, or null. */
function largestOn(
  ledger: LocalAuditorInput["ledger"],
  coordinate: Coordinate,
  receiptSha256: string,
  keep: (verdict: AuditVerdictReadModel) => boolean,
): AuditVerdictReadModel | null {
  let best: AuditVerdictReadModel | null = null;
  for (const verdict of verdictsOf(ledger, coordinate)) {
    if (verdict.receiptSha256 !== receiptSha256 || !keep(verdict)) continue;
    if (best === null || verdict.auditorRunId > best.auditorRunId) best = verdict;
  }
  return best;
}

/** Build the auditor over one ledger and its plane. */
export function createLocalAuditor(input: LocalAuditorInput): AuditorPort {
  const now = input.now ?? ((): string => new Date().toISOString());
  const mintId = input.mintId ?? ((): string => randomUUID());
  const { ledger } = input;

  return {
    recordedAccept: (coordinate, receiptSha256) =>
      largestOn(ledger, coordinate, receiptSha256, (verdict) => verdict.verdict === "ACCEPT")?.auditId ?? null,
    latest: (coordinate, receiptSha256) => {
      const verdict = largestOn(ledger, coordinate, receiptSha256, () => true);
      return verdict === null ? null : { auditId: verdict.auditId, verdict: verdict.verdict };
    },
    audit: (coordinate, receiptSha256) => Promise.resolve(audit(input, coordinate, receiptSha256, now, mintId)),
  };
}

function audit(
  input: LocalAuditorInput,
  coordinate: Coordinate,
  receiptSha256: string,
  now: () => string,
  mintId: () => string,
): LocalAuditOutcome {
  const { ledger, plane } = input;

  // 1. The receipt row: known, of this coordinate, PASS.
  const row = ledger.getVerification(receiptSha256);
  if (
    row === null ||
    row.taskId !== coordinate.taskId ||
    row.revisionNumber !== coordinate.revisionNumber ||
    row.attemptNumber !== coordinate.attemptNumber
  ) {
    return refuse("AUDITOR_RECEIPT_UNKNOWN", "receiptSha256");
  }
  if (row.runStatus !== "PASS") return refuse("AUDITOR_RECEIPT_NOT_PASS", "receiptSha256");

  // 2. The task, not terminal, and the receipt's bytes.
  const read = readRecordedTask({ ledger, plane, taskId: coordinate.taskId, route: input.route });
  if (!read.ok) return refuse("AUDITOR_TASK_UNREADABLE", read.at, read.refusal);
  const task = read.task;
  const state = ledger.getTask(task.taskId)?.currentState ?? null;
  if (state === null) return refuse("AUDITOR_TASK_UNREADABLE", "task");
  if (TERMINAL_STATES.includes(state)) return refuse("AUDITOR_TASK_TERMINAL", "task.currentState");
  const bytes = plane.read({ artifactReferenceId: row.artifactReferenceId, scopeKind: "TASK", scopeId: task.taskId });
  if (bytes.verb !== "READ") return refuse("AUDITOR_RECEIPT_UNREADABLE", "receipt", bytes.refusal);
  let receipt: VerificationReceipt;
  let recomputed: string;
  try {
    const parsed: unknown = JSON.parse(bytes.content.toString("utf8"));
    receipt = VerificationReceipt.parse(parsed);
    recomputed = receiptVerificationColumns(receipt).receiptSha256;
  } catch {
    return refuse("AUDITOR_RECEIPT_UNREADABLE", "receipt");
  }

  // 3. Its run: the coordinate's next reviewer ordinal, and the registry's id for it.
  const runId = verdictsOf(ledger, coordinate).reduce((last, verdict) => Math.max(last, verdict.auditorRunId), 0) + 1;
  const workerId = supervisedWorkerIdFor(task.taskId, task.attempt, "reviewer", runId);

  // 4. The six rules, sorted, and the verdict they answer.
  const envelope = task.envelope;
  const declared = new Set(envelope.writeSet);
  const observed = [...receipt.observedTrackedChanges.map((change) => change.path), ...receipt.observedUntrackedPaths];
  const labels = [receipt.writer.identity, receipt.verifier.identity, AUDITOR_IDENTITY];
  const ids = [receipt.writer.workerId, receipt.verifier.workerId, workerId];
  const outcomes: Readonly<Record<AuditRule, boolean>> = {
    CHANGES_WITHIN_WRITE_SET: observed.every((path) => declared.has(path)),
    DIFF_PRESENT_FOR_COMMIT: envelope.commitPolicy !== "LOCAL_COMMIT_WITH_RECEIPT" || observed.length > 0,
    INDEPENDENT_IDS: new Set(labels).size === labels.length && new Set(ids).size === ids.length,
    POLICY_MATCHES_ENVELOPE:
      verificationPolicySha256({
        commands: envelope.validation.commands,
        independentVerifierRequired: envelope.validation.independentVerifierRequired,
        commitPolicy: envelope.commitPolicy,
      }) === receipt.policySha256,
    RECEIPT_BYTES_MATCH: recomputed === receiptSha256,
    RECEIPT_PASS: receipt.runStatus === "PASS" && receipt.checks.length > 0 && receipt.checks.every((check) => check.exitCode === 0),
  };
  const rules = (Object.keys(outcomes) as AuditRule[])
    .sort()
    .map((rule) => ({ rule, outcome: outcomes[rule] ? ("PASS" as const) : ("FAIL" as const) }));
  const verdict = rules.every((rule) => rule.outcome === "PASS") ? ("ACCEPT" as const) : ("REJECT" as const);

  // 5. The evidence, published.
  const evidence = AuditEvidence.parse({
    evidenceVersion: "acp/audit-evidence/v1",
    receiptSha256,
    treeSha: row.treeSha,
    auditor: { identity: AUDITOR_IDENTITY, workerId, runId },
    verdict,
    rules,
  });
  const content = Buffer.from(canonicalJsonStringify(evidence), "utf8");
  const recordedAt = now();
  const commandId = mintId();
  const published = input.plane.publish({
    content,
    mediaType: EVIDENCE_MEDIA_TYPE,
    encryptionStatus: "PLAINTEXT",
    encryptionProfile: EVIDENCE_ENCRYPTION_PROFILE,
    commandId,
    artifactPinId: mintId(),
    reference: {
      artifactReferenceId: mintId(),
      artifactClass: "EVIDENCE",
      classification: "INTERNAL",
      scopeKind: "TASK",
      scopeId: task.taskId,
      producerIdentity: AUDITOR_IDENTITY,
      accessPolicyId: ARTIFACT_ACCESS_POLICY_IDS[0],
      retentionClass: "PERMANENT",
      expiresAt: null,
    },
    recordedBy: AUDITOR_IDENTITY,
    intention: {
      eventId: mintId(),
      idempotencyKey: "evidence/" + commandId + "/intended",
      occurredAt: recordedAt,
      recordedAt,
    },
    terminal: {
      eventId: mintId(),
      idempotencyKey: "evidence/" + commandId + "/succeeded",
      occurredAt: recordedAt,
      recordedAt,
    },
    holding: {
      holder: AUDITOR_IDENTITY,
      holderPid: process.pid,
      acquiredAt: recordedAt,
      expiresAt: new Date(Date.parse(recordedAt) + EVIDENCE_HOLDING_WINDOW_MS).toISOString(),
    },
  });
  if (published.verb !== "PUBLISHED") {
    return refuse("AUDITOR_PUBLICATION_REFUSED", "evidence", "refusal" in published ? published.refusal : published.verb);
  }

  // 6. The verdict-form event, same-state: a fact recorded in place (B-4).
  const auditId = mintId();
  const transitionId = "audit.run." + String(runId);
  const { revisionNumber, attemptNumber } = coordinate;
  try {
    ledger.append({
      contractVersion: CONTRACT_VERSION,
      eventId: auditId,
      taskId: task.taskId,
      attempt: task.attempt,
      transitionId,
      idempotencyKey: buildV2IdempotencyKey({
        stream: "control_plane_events",
        taskId: task.taskId,
        revisionNumber,
        attemptNumber,
        transitionId,
      }),
      type: "AUDIT_COMPLETED",
      fromState: state,
      toState: state,
      emittedBy: AUDITOR_IDENTITY,
      occurredAt: recordedAt,
      recordedAt,
      correlationId: null,
      causationId: null,
      payload: {
        revisionNumber,
        attemptNumber,
        auditVerdict: {
          receiptSha256,
          treeSha: row.treeSha,
          writerWorkerId: row.writerWorkerId,
          auditor: { identity: AUDITOR_IDENTITY, workerId, runId },
          verdict,
          evidenceSha256: published.contentSha256,
          artifactReferenceId: published.reference.artifactReferenceId,
        },
      },
    });
  } catch (error: unknown) {
    if (error instanceof LedgerVerificationRefusedError) return refuse("AUDITOR_RECORD_REFUSED", error.at, error.reason);
    const code = (error as { code?: unknown }).code;
    return refuse("AUDITOR_RECORD_REFUSED", "event", typeof code === "string" ? code : null);
  }

  return Object.freeze({ ok: true as const, verdict, auditId });
}
