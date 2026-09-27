import {
  ControlPlaneEvent as ControlPlaneEventSchema,
  TaskEnvelope,
  VerificationReceipt,
  commitMessageWithReceiptTrailer,
  isCanonicalInstant,
  isSha256Hex,
  type ControlPlaneEvent,
} from "@acp/contracts";

import { readByReference } from "../artifact-plane/index.js";
import { sha256Hex } from "../canonical-json/index.js";
import { LedgerCommitAuthorizationRefusedError, LedgerValidationError } from "../errors/index.js";
import type { Ledger } from "../ledger/index.js";
import { receiptVerificationColumns, verificationPolicySha256 } from "../receipt-identity/index.js";
import type { CommitAuthorizationReadModel, VerificationReadModel } from "../types/index.js";
import { lapsedReferenceColumn } from "../verification-record/index.js";
import type { VerificationArtifactRead } from "../verification-record/types/index.js";

import type {
  CommitAuthorizationArtifact,
  CommitAuthorizationArtifactLookups,
  CommitAuthorizationArtifacts,
  CommitAuthorizationDecision,
  CommitAuthorizationDecisionView,
  CommitAuthorizationInForce,
  CommitAuthorizationInForceInput,
  RecordedLease,
  RecordedLeaseEvent,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and are
 * re-exported here unchanged (owner law §7).
 */
export type {
  CommitAuthorizationArtifact,
  CommitAuthorizationArtifactLookups,
  CommitAuthorizationArtifacts,
  CommitAuthorizationDecision,
  CommitAuthorizationDecisionView,
  CommitAuthorizationInForce,
  CommitAuthorizationInForceInput,
  CommitAuthorizationRevalidation,
  RecordedLease,
  RecordedLeaseEvent,
} from "./types/index.js";

/**
 * A commit authorization is recorded and revalidated -- P-17/A, ADR 0126 (execution
 * §10.5; decisions 245-247).
 *
 * ## The record form
 *
 * `COMMIT_AUTHORIZED` already exists, and the P7C pilot appends it on a V1 subject as a
 * bare candidate `{taskId, receiptSha256, authorizedBy}`: that stays admitted
 * byte-unchanged and projects nothing (ND-2; owner P-21). On a V2 subject (a payload
 * carrying the coordinate) the event is in **record form** or refused: its payload is
 * exactly the coordinate and the key `commitAuthorization`, closed at every level --
 * `{receiptSha256, auditId, commitMessageSha256}`, lowercase hex and the verdict event's
 * own id. Without the key it is `AUTHORIZATION_RECORD_ABSENT`; the key on a V1 subject,
 * or a missing, extra or mistyped member, is `AUTHORIZATION_RECORD_INVALID`; the key
 * under another type is `AUTHORIZATION_FORM_MISPLACED`.
 *
 * The record is a fact recorded **same-state in `AUDITING`** (ND-3): a state change is
 * `AUTHORIZATION_FORM_MISPLACED` at `toState`, and any other origin state the same word
 * at `fromState`. The plan's step 8 (`AUDITING -> READY_TO_COMMIT`) is unchanged.
 *
 * ## One decision, two callers
 *
 * `decideCommitAuthorizationRecord` is pure over the event and what its caller answers
 * about the history: the door calls it inside its `BEGIN IMMEDIATE`, over the tables and
 * the stream that transaction keeps level, and the fold calls it over the snapshot a
 * rebuild or `verifyIntegrity()` is filling -- the same word in both (decision 56). In
 * order: the grammar; the instant; the policy the intake recorded (`NO_COMMIT` refused by
 * name, none recorded refused by name); the receipt row (recorded, of the coordinate,
 * `PASS`); the verdict row (recorded, on the same receipt, `ACCEPT` -- so
 * `ACCEPT_WITH_CORRECTIONS` does not authorize); the receipt is the task's **last**
 * receipt-form row by sequence (ND-5: a consumer beat names an existing receipt and never
 * makes an older one last again); the key already held (a replay with the same metadata
 * keeps its first `INTENDED` row, other metadata is `AUTHORIZATION_METADATA_CONFLICT`);
 * no other row of the task `INTENDED` or `OUTCOME_UNKNOWN` (`AUTHORIZATION_STATE_INVALID`,
 * execution §10.5 "a lo sumo una fila INTENDED"); and last the in-force predicate over
 * the candidate row.
 *
 * ## One in-force predicate
 *
 * `commitAuthorizationInForce` is execution §10.5's "Vigencia", once: the row is
 * `INTENDED`; the attempt's recorded lease exists (`LEASE_ABSENT`, before any
 * comparison), its `expiresAt` is a canonical instant (`LEASE_INSTANT_NOT_CANONICAL`,
 * never normalized), it is held by the writer the receipt names
 * (`LEASE_HOLDER_MISMATCH`), and `authorized_at < expiresAt` by epoch, equality expired
 * (`LEASE_EXPIRED`); and every revalidated equality it is given holds. The canon calls it
 * at `COMMIT_RECORDED` and at `OUTCOME_UNKNOWN -> INTENDED`; in this cut the decision
 * calls it over the candidate `INTENDED` row, so the gate's own precondition "lease vivo"
 * is this function. P-17/C adds the canonical call at `COMMIT_RECORDED`. P-17/B's commit
 * writer is its second caller, immediately before any object write, and extends
 * condition 3 with base and tree against Git, write-set and policy through
 * `revalidated` (ADR 0127).
 *
 * The lease is the **recorded** lease (ND-6): the task stream's own `LEASE_ACQUIRED` and
 * `LEASE_REVOKED` whose payload coordinate is the receipt's, folded by runtime
 * `enforcement`'s rule. The coordination store is a separate file no ledger transaction
 * holds and no rebuild could re-read, so the predicate compares two recorded instants and
 * is reproducible in replay.
 *
 * ## The door's bytes, and the fold's copy
 *
 * What only bytes answer is the door's alone (ND-7): `readCommitAuthorizationArtifacts`
 * reads the receipt (by the receipt row's reference) and the envelope (by the revision
 * row's reference) before the lock, as values, and `assertCommitAuthorizationArtifacts`
 * judges them inside the transaction: the references re-asserted under the lock, class,
 * scope and decision 231's N-3 (tombstoned, or expired at the event's instant); the
 * commit message digest recomputed over the receipt's body and its one trailer
 * (`commitMessageWithReceiptTrailer`, `COMMIT_MESSAGE_DIGEST_MISMATCH`); the envelope's
 * policy `LOCAL_COMMIT_WITH_RECEIPT`, its `verificationPolicySha256` equal to the receipt
 * row's (`POLICY_DIGEST_MISMATCH`), and its write-set, as a set, equal to the receipt's
 * declared one (`WRITE_SET_MISMATCH`). The fold and `verifyIntegrity()` copy what the door
 * admitted and never reopen a blob.
 *
 * ## Supersession
 *
 * A later receipt-form `VERIFICATION_COMPLETED` of the task, in any revision or attempt,
 * moves the task's `INTENDED` row to `SUPERSEDED`, naming the new receipt, with that
 * event's `recordedAt` and `sequence` (ND-4): `decideCommitAuthorizationSupersession`,
 * called by the door and the fold after the receipt row is set. Consumer beats and V1
 * beats carry no new receipt and never supersede.
 */

/**
 * The closed refusal vocabulary, sorted (ND-8). Every refusal names the field that
 * failed, never a value. Words shared with `VERIFICATION_REFUSALS` are the same fact
 * under another home and another class. P-17/B (ADR 0127; ND-7) adds the two words its
 * writer revalidates through `revalidated`: `REVALIDATED_BASE_MISMATCH` (HEAD's commit
 * against the receipt's base) and `REVALIDATED_TREE_MISMATCH` (the tree read now against
 * the receipt's), 26 -> 28; write-set and policy reuse `WRITE_SET_MISMATCH` and
 * `POLICY_DIGEST_MISMATCH`.
 */
export const COMMIT_AUTHORIZATION_REFUSALS = [
  "AUTHORIZATION_FORM_MISPLACED",
  "AUTHORIZATION_METADATA_CONFLICT",
  "AUTHORIZATION_NO_COMMIT",
  "AUTHORIZATION_POLICY_UNRECORDED",
  "AUTHORIZATION_RECORD_ABSENT",
  "AUTHORIZATION_RECORD_INVALID",
  "AUTHORIZATION_STATE_INVALID",
  "COMMIT_MESSAGE_DIGEST_MISMATCH",
  "ENVELOPE_REFERENCE_INVALID",
  "ENVELOPE_UNREADABLE",
  "LEASE_ABSENT",
  "LEASE_EXPIRED",
  "LEASE_HOLDER_MISMATCH",
  "LEASE_INSTANT_NOT_CANONICAL",
  "POLICY_DIGEST_MISMATCH",
  "RECEIPT_COORDINATE_MISMATCH",
  "RECEIPT_NOT_LAST",
  "RECEIPT_NOT_PASS",
  "RECEIPT_REFERENCE_INVALID",
  "RECEIPT_UNREADABLE",
  "RECEIPT_UNRECORDED",
  "RECORDED_AT_NOT_CANONICAL",
  "REVALIDATED_BASE_MISMATCH",
  "REVALIDATED_TREE_MISMATCH",
  "VERDICT_NOT_ACCEPT",
  "VERDICT_RECEIPT_MISMATCH",
  "VERDICT_UNRECORDED",
  "WRITE_SET_MISMATCH",
] as const;

export type CommitAuthorizationRefusal = (typeof COMMIT_AUTHORIZATION_REFUSALS)[number];

/** The payload key a record-form `COMMIT_AUTHORIZED` carries its record under (ND-2). */
export const COMMIT_AUTHORIZATION_KEY = "commitAuthorization";

/** Every key a record carries, and no other: all required. */
export const COMMIT_AUTHORIZATION_RECORD_KEYS = ["receiptSha256", "auditId", "commitMessageSha256"] as const;

/** The one policy under which a commit may be authorized. */
const LOCAL_COMMIT = "LOCAL_COMMIT_WITH_RECEIPT";

/** The one state an authorization may be recorded from (ND-3). */
const AUDITING = "AUDITING";

/** The coordinate's grammar, the receipt contract's own. */
const COORDINATE = VerificationReceipt.shape.revisionNumber;

function refuse(reason: CommitAuthorizationRefusal, at: string): never {
  throw new LedgerCommitAuthorizationRefusedError(reason, at);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hold one object to a closed key list: every key present, no other. */
function closed(value: unknown, keys: readonly string[], at: string): Record<string, unknown> {
  if (!isRecord(value)) refuse("AUTHORIZATION_RECORD_INVALID", at);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) refuse("AUTHORIZATION_RECORD_INVALID", at + "." + key);
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) refuse("AUTHORIZATION_RECORD_INVALID", at);
  return value;
}

function coordinate(value: unknown, at: string): number {
  if (!COORDINATE.safeParse(value).success) refuse("AUTHORIZATION_RECORD_INVALID", at);
  return value as number;
}

function digest(value: unknown, at: string): string {
  if (!isSha256Hex(value)) refuse("AUTHORIZATION_RECORD_INVALID", at);
  return value;
}

/** An audit id: the verdict event's own id, a UUID in canonical lowercase. */
function auditIdOf(value: unknown, at: string): string {
  if (typeof value !== "string" || value !== value.toLowerCase() || !ControlPlaneEventSchema.shape.eventId.safeParse(value).success) {
    refuse("AUTHORIZATION_RECORD_INVALID", at);
  }
  return value;
}

/** What "the same metadata" compares: the six columns an authorization is born with and keeps. */
function metadataOf(row: CommitAuthorizationReadModel): string {
  return [row.taskId, row.receiptSha256, row.revisionNumber, row.attemptNumber, row.auditId, row.commitMessageSha256].join(" ");
}

/**
 * The lease one attempt holds, folded from the task's recorded lease events (ND-6), or
 * null. Only events whose payload coordinate is the attempt's are read; per `leaseId`
 * the last `LEASE_ACQUIRED` in ledger order defines the lease and a `LEASE_REVOKED` is
 * terminal for that id; the attempt's lease is the last one acquired, absent if revoked.
 * A payload that is not a lease is not one: total, like every fold.
 */
export function recordedLeaseOf(
  events: readonly RecordedLeaseEvent[],
  revisionNumber: number,
  attemptNumber: number,
): RecordedLease | null {
  const acquired = new Map<string, RecordedLease>();
  const revoked = new Set<string>();
  let last: string | null = null;
  for (const event of events) {
    const payload = event.payload;
    if (payload["revisionNumber"] !== revisionNumber || payload["attemptNumber"] !== attemptNumber) continue;
    const leaseId = payload["leaseId"];
    if (typeof leaseId !== "string") continue;
    if (event.type === "LEASE_REVOKED") {
      revoked.add(leaseId);
      continue;
    }
    if (revoked.has(leaseId)) continue;
    const holder = payload["holder"];
    const expiresAt = payload["expiresAt"];
    if (typeof holder !== "string" || typeof expiresAt !== "string") continue;
    acquired.set(leaseId, { leaseId, holder, expiresAt });
    last = leaseId;
  }
  if (last === null || revoked.has(last)) return null;
  return acquired.get(last) ?? null;
}

/**
 * Whether an authorization is in force (execution §10.5 "Vigencia"): the one predicate.
 *
 * In order, each refused by its own word at its own field: the row stands `INTENDED`
 * (`AUTHORIZATION_STATE_INVALID`); the lease exists (`LEASE_ABSENT`, before anything is
 * compared); both instants are canonical (`LEASE_INSTANT_NOT_CANONICAL`,
 * `RECORDED_AT_NOT_CANONICAL`; never normalized); the lease is the receipt's writer's
 * (`LEASE_HOLDER_MISMATCH`); `authorizedAt < expiresAt` by epoch, equality expired
 * (`LEASE_EXPIRED`); and every revalidated equality holds (its own word). Pure: it reads
 * two recorded instants and no clock, so a replay reaches the same answer.
 */
export function commitAuthorizationInForce(input: CommitAuthorizationInForceInput): CommitAuthorizationInForce {
  const no = (reason: CommitAuthorizationRefusal, at: string): CommitAuthorizationInForce => ({ inForce: false, reason, at });
  if (input.state !== "INTENDED") return no("AUTHORIZATION_STATE_INVALID", "state");
  const lease = input.lease;
  if (lease === null) return no("LEASE_ABSENT", "lease");
  if (!isCanonicalInstant(lease.expiresAt)) return no("LEASE_INSTANT_NOT_CANONICAL", "lease.expiresAt");
  if (!isCanonicalInstant(input.authorizedAt)) return no("RECORDED_AT_NOT_CANONICAL", "authorizedAt");
  if (lease.holder !== input.writerIdentity) return no("LEASE_HOLDER_MISMATCH", "lease.holder");
  if (!(Date.parse(input.authorizedAt) < Date.parse(lease.expiresAt))) return no("LEASE_EXPIRED", "lease.expiresAt");
  for (const pair of input.revalidated ?? []) {
    if (pair.authorized !== pair.observed) return no(pair.reason, pair.at);
  }
  return { inForce: true };
}

/**
 * Decide one event: null for any event that is not a record-form `COMMIT_AUTHORIZED`
 * (a V1 bare `COMMIT_AUTHORIZED` included), a row to write or to keep, or a refusal
 * thrown as `LedgerCommitAuthorizationRefusedError`. The order is the module's docblock.
 */
export function decideCommitAuthorizationRecord(
  view: CommitAuthorizationDecisionView,
  event: ControlPlaneEvent,
  sequence: number,
): CommitAuthorizationDecision | null {
  const at = "payload." + COMMIT_AUTHORIZATION_KEY;
  const payload = event.payload;
  const carries = Object.hasOwn(payload, COMMIT_AUTHORIZATION_KEY);
  if (event.type !== "COMMIT_AUTHORIZED") {
    if (carries) refuse("AUTHORIZATION_FORM_MISPLACED", at);
    return null;
  }
  const v2 = Object.hasOwn(payload, "revisionNumber") || Object.hasOwn(payload, "attemptNumber");
  if (!v2) {
    // A V1 subject has no coordinate a row could be of: the bare candidate stands, a record does not.
    if (carries) refuse("AUTHORIZATION_RECORD_INVALID", at);
    return null;
  }
  if (!carries) refuse("AUTHORIZATION_RECORD_ABSENT", at);
  if (event.fromState !== event.toState) refuse("AUTHORIZATION_FORM_MISPLACED", "toState");
  if (event.fromState !== AUDITING) refuse("AUTHORIZATION_FORM_MISPLACED", "fromState");

  const closedPayload = closed(payload, ["revisionNumber", "attemptNumber", COMMIT_AUTHORIZATION_KEY], "payload");
  const revisionNumber = coordinate(closedPayload["revisionNumber"], "payload.revisionNumber");
  const attemptNumber = coordinate(closedPayload["attemptNumber"], "payload.attemptNumber");
  const record = closed(closedPayload[COMMIT_AUTHORIZATION_KEY], COMMIT_AUTHORIZATION_RECORD_KEYS, at);
  const receiptSha256 = digest(record["receiptSha256"], at + ".receiptSha256");
  const auditId = auditIdOf(record["auditId"], at + ".auditId");
  const commitMessageSha256 = digest(record["commitMessageSha256"], at + ".commitMessageSha256");

  if (!isCanonicalInstant(event.recordedAt)) refuse("RECORDED_AT_NOT_CANONICAL", "recordedAt");

  const policy = view.commitPolicy(event.taskId);
  if (policy === "NO_COMMIT") refuse("AUTHORIZATION_NO_COMMIT", "commitPolicy");
  if (policy !== LOCAL_COMMIT) refuse("AUTHORIZATION_POLICY_UNRECORDED", "commitPolicy");

  const receipt = view.verification(receiptSha256);
  if (receipt === null) refuse("RECEIPT_UNRECORDED", at + ".receiptSha256");
  if (receipt.taskId !== event.taskId || receipt.revisionNumber !== revisionNumber || receipt.attemptNumber !== attemptNumber) {
    refuse("RECEIPT_COORDINATE_MISMATCH", at + ".receiptSha256");
  }
  if (receipt.runStatus !== "PASS") refuse("RECEIPT_NOT_PASS", at + ".receiptSha256");

  const verdict = view.auditVerdict(auditId);
  if (verdict === null) refuse("VERDICT_UNRECORDED", at + ".auditId");
  if (verdict.receiptSha256 !== receiptSha256) refuse("VERDICT_RECEIPT_MISMATCH", at + ".auditId");
  if (verdict.verdict !== "ACCEPT") refuse("VERDICT_NOT_ACCEPT", at + ".auditId");

  // The receipt is the task's last (ND-5): otherwise an older receipt authorized after a
  // newer one is never superseded, and the partial unique index refuses the current one.
  if (view.lastReceipt(event.taskId)?.receiptSha256 !== receiptSha256) refuse("RECEIPT_NOT_LAST", at + ".receiptSha256");

  const row: CommitAuthorizationReadModel = {
    taskId: event.taskId,
    receiptSha256,
    revisionNumber,
    attemptNumber,
    auditId,
    commitMessageSha256,
    authorizedAt: event.recordedAt,
    authorizedSequence: sequence,
    state: "INTENDED",
    commitSha: null,
    supersededByReceiptSha256: null,
    recordedAt: event.recordedAt,
    sequence,
  };

  const rows = view.commitAuthorizations(event.taskId);
  const stored = rows.find((candidate) => candidate.receiptSha256 === receiptSha256);
  if (stored !== undefined) {
    if (metadataOf(stored) !== metadataOf(row)) refuse("AUTHORIZATION_METADATA_CONFLICT", at + ".receiptSha256");
    if (stored.state !== "INTENDED") refuse("AUTHORIZATION_STATE_INVALID", at + ".receiptSha256");
    return { row: stored, recorded: true };
  }
  // At most one INTENDED row per task, and none while an effect's outcome is unknown.
  if (rows.some((candidate) => candidate.state === "INTENDED" || candidate.state === "OUTCOME_UNKNOWN")) {
    refuse("AUTHORIZATION_STATE_INVALID", at);
  }

  const inForce = commitAuthorizationInForce({
    state: row.state,
    authorizedAt: row.authorizedAt,
    writerIdentity: receipt.writerIdentity,
    lease: recordedLeaseOf(view.leaseEvents(event.taskId), revisionNumber, attemptNumber),
  });
  if (!inForce.inForce) refuse(inForce.reason, inForce.at);
  return { row, recorded: false };
}

/**
 * The supersession a newly recorded receipt row causes, or null (ND-4): the task's
 * `INTENDED` row over another receipt moves to `SUPERSEDED`, naming the new receipt, with
 * the receipt event's instant and sequence; `authorized_*` never move.
 */
export function decideCommitAuthorizationSupersession(
  view: Pick<CommitAuthorizationDecisionView, "commitAuthorizations">,
  receipt: VerificationReadModel,
): CommitAuthorizationReadModel | null {
  const intended = view.commitAuthorizations(receipt.taskId).find((row) => row.state === "INTENDED");
  if (intended === undefined || intended.receiptSha256 === receipt.receiptSha256) return null;
  return {
    ...intended,
    state: "SUPERSEDED",
    supersededByReceiptSha256: receipt.receiptSha256,
    recordedAt: receipt.recordedAt,
    sequence: receipt.sequence,
  };
}

/** Read one reference's bytes under the event's task, as a value. */
function artifactOf(ledger: Ledger, taskId: string, referenceId: string): CommitAuthorizationArtifact {
  const read = readByReference(ledger, { artifactReferenceId: referenceId, scopeKind: "TASK", scopeId: taskId });
  const value: VerificationArtifactRead =
    read.verb === "READ"
      ? { ok: true, content: read.content, contentSha256: read.reference.contentSha256 }
      : { ok: false, refusal: read.refusal };
  return { referenceId, read: value };
}

/**
 * Read the receipt and the envelope a record-form `COMMIT_AUTHORIZED` stands on, by
 * reference under the event's task, before the door's lock (ND-7).
 *
 * A value, never a throw: null for an event that is not a record-form candidate;
 * otherwise each artifact's bytes (or the reader's refusal), or null where no reference
 * could be named from what the ledger holds now. The door re-asserts every reference
 * under its lock. A re-derivation and not a sink: the bytes reach the door's comparison
 * and nothing else -- no event, response, log or error message.
 */
export function readCommitAuthorizationArtifacts(ledger: Ledger, event: ControlPlaneEvent): CommitAuthorizationArtifacts | null {
  if (event.type !== "COMMIT_AUTHORIZED") return null;
  const record = event.payload[COMMIT_AUTHORIZATION_KEY];
  if (!isRecord(record)) return null;
  const receiptSha256 = record["receiptSha256"];
  const revisionNumber = event.payload["revisionNumber"];
  const receiptRow = typeof receiptSha256 === "string" ? ledger.getVerification(receiptSha256) : null;
  const revision = typeof revisionNumber === "number" ? ledger.getTaskRevision(event.taskId, revisionNumber) : null;
  const envelopeReferenceId = revision?.envelopeArtifactReferenceId ?? null;
  return {
    receipt: receiptRow === null ? null : artifactOf(ledger, event.taskId, receiptRow.artifactReferenceId),
    envelope: envelopeReferenceId === null ? null : artifactOf(ledger, event.taskId, envelopeReferenceId),
  };
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
 * Judge the bytes a granted decision stands on, inside the door's transaction (ND-7,
 * ND-10). A replay (`recorded`) keeps its first row and is not re-judged.
 *
 * The receipt: the reference the receipt row names is the one read before the lock, a
 * `RECEIPT` scoped to this task, not lapsed at the event's instant, and it pins the bytes
 * read (`RECEIPT_REFERENCE_INVALID`); the bytes are a receipt (`RECEIPT_UNREADABLE`)
 * whose recomputed name is the row's (`RECEIPT_REFERENCE_INVALID`); and the commit
 * message digest, over the receipt's body plus its one trailer, is the carried one
 * (`COMMIT_MESSAGE_DIGEST_MISMATCH`).
 *
 * The envelope: the reference the revision names is the one read, a `TASK_ENVELOPE`
 * scoped to this task, not lapsed, pinning the bytes read (`ENVELOPE_REFERENCE_INVALID`);
 * the bytes are this task's envelope (`ENVELOPE_UNREADABLE`) under
 * `LOCAL_COMMIT_WITH_RECEIPT` (`AUTHORIZATION_NO_COMMIT`); its policy digest, recomputed
 * exactly as the verification runner computes it, is the receipt row's
 * (`POLICY_DIGEST_MISMATCH`); and its write-set, as a set, is the receipt's declared one
 * (`WRITE_SET_MISMATCH`).
 */
export function assertCommitAuthorizationArtifacts(
  decision: CommitAuthorizationDecision,
  artifacts: CommitAuthorizationArtifacts | null,
  lookups: CommitAuthorizationArtifactLookups,
  recordedAt: string,
): void {
  if (decision.recorded) return;
  const at = "payload." + COMMIT_AUTHORIZATION_KEY;
  const { row } = decision;

  const receiptRow = lookups.verification(row.receiptSha256);
  const receiptArtifact = artifacts?.receipt ?? null;
  if (receiptRow === null || receiptArtifact === null || receiptArtifact.referenceId !== receiptRow.artifactReferenceId) {
    refuse("RECEIPT_REFERENCE_INVALID", at + ".receiptSha256");
  }
  const heldReceipt = lookups.reference(receiptRow.artifactReferenceId);
  if (heldReceipt?.artifactClass !== "RECEIPT" || heldReceipt.scopeKind !== "TASK" || heldReceipt.scopeId !== row.taskId) {
    refuse("RECEIPT_REFERENCE_INVALID", at + ".receiptSha256");
  }
  const lapsedReceipt = lapsedReferenceColumn(heldReceipt, recordedAt);
  if (lapsedReceipt !== null) refuse("RECEIPT_REFERENCE_INVALID", at + ".receiptSha256." + lapsedReceipt);
  const receiptRead = receiptArtifact.read;
  if (!receiptRead.ok) refuse("RECEIPT_UNREADABLE", at + ".receiptSha256");
  if (receiptRead.contentSha256 !== heldReceipt.contentSha256) refuse("RECEIPT_REFERENCE_INVALID", at + ".receiptSha256");
  const receiptJson = parsedJson(receiptRead.content);
  const receipt = VerificationReceipt.safeParse(receiptJson);
  if (!receipt.success) refuse("RECEIPT_UNREADABLE", at + ".receiptSha256");
  if (receiptVerificationColumns(receipt.data).receiptSha256 !== row.receiptSha256) {
    refuse("RECEIPT_REFERENCE_INVALID", at + ".receiptSha256");
  }
  let message: string;
  try {
    message = commitMessageWithReceiptTrailer(receipt.data.commitMessageBody, row.receiptSha256);
  } catch {
    refuse("RECEIPT_UNREADABLE", at + ".receiptSha256");
  }
  if (sha256Hex(message) !== row.commitMessageSha256) refuse("COMMIT_MESSAGE_DIGEST_MISMATCH", at + ".commitMessageSha256");

  const envelopeReferenceId = lookups.envelopeReferenceId(row.taskId, row.revisionNumber);
  const envelopeArtifact = artifacts?.envelope ?? null;
  if (envelopeReferenceId === null || envelopeArtifact?.referenceId !== envelopeReferenceId) {
    refuse("ENVELOPE_REFERENCE_INVALID", "envelope");
  }
  const heldEnvelope = lookups.reference(envelopeReferenceId);
  if (heldEnvelope?.artifactClass !== "TASK_ENVELOPE" || heldEnvelope.scopeKind !== "TASK" || heldEnvelope.scopeId !== row.taskId) {
    refuse("ENVELOPE_REFERENCE_INVALID", "envelope.artifactReferenceId");
  }
  const lapsedEnvelope = lapsedReferenceColumn(heldEnvelope, recordedAt);
  if (lapsedEnvelope !== null) refuse("ENVELOPE_REFERENCE_INVALID", "envelope.artifactReferenceId." + lapsedEnvelope);
  const envelopeRead = envelopeArtifact.read;
  if (!envelopeRead.ok) refuse("ENVELOPE_UNREADABLE", "envelope");
  if (envelopeRead.contentSha256 !== heldEnvelope.contentSha256) refuse("ENVELOPE_REFERENCE_INVALID", "envelope.artifactReferenceId");
  const envelope = TaskEnvelope.safeParse(parsedJson(envelopeRead.content));
  if (!envelope.success || envelope.data.taskId !== row.taskId) refuse("ENVELOPE_UNREADABLE", "envelope");
  if (envelope.data.commitPolicy !== LOCAL_COMMIT) refuse("AUTHORIZATION_NO_COMMIT", "envelope.commitPolicy");
  let policySha256: string;
  try {
    policySha256 = verificationPolicySha256({
      commands: envelope.data.validation.commands,
      independentVerifierRequired: envelope.data.validation.independentVerifierRequired,
      commitPolicy: envelope.data.commitPolicy,
    });
  } catch (error) {
    if (error instanceof LedgerValidationError) refuse("ENVELOPE_UNREADABLE", "envelope.validation");
    throw error;
  }
  if (policySha256 !== receiptRow.policySha256) refuse("POLICY_DIGEST_MISMATCH", "envelope.validation");
  const declared = new Set(receipt.data.declaredWriteSet);
  const envelopeWriteSet = new Set(envelope.data.writeSet);
  if (declared.size !== envelopeWriteSet.size || [...declared].some((path) => !envelopeWriteSet.has(path))) {
    refuse("WRITE_SET_MISMATCH", "envelope.writeSet");
  }
}
