import { randomUUID } from "node:crypto";

import {
  CONTRACT_VERSION,
  VerificationReceipt,
  buildV2IdempotencyKey,
  commitMessageWithReceiptTrailer,
  isCanonicalInstant,
} from "@acp/contracts";
import type { Lease } from "@acp/contracts";
import {
  LedgerCommitAuthorizationRefusedError,
  canonicalJsonStringify,
  commitAuthorizationInForce,
  receiptVerificationColumns,
  recordedLeaseOf,
  sha256Hex,
  verificationPolicySha256,
} from "@acp/ledger";
import type { ArtifactPlane, Ledger, RecordedLeaseEvent, VerificationReadModel } from "@acp/ledger";
import { authorizeCommit, readRecordedTask } from "@acp/runtime";
import type { RecordedTask } from "@acp/runtime";

import { createGitObserver, observeWorktree } from "../git-observer/index.js";
import { admitIdentity, admitRepository, commitAndCompareAndSet } from "../git-writer/index.js";
import type { AdmittedRepository, GitWriterRefusal, GitWriterRefused } from "../git-writer/index.js";
import { indexPaths, readWorktreeTree } from "../tree-hasher/index.js";

import type {
  CommitAuthorizationInput,
  CommitAuthorizationOutcome,
  CommitEffectRequest,
  CommitWriteOutcome,
  CommitWriterInput,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and are
 * re-exported here unchanged (owner law §7).
 */
export type {
  CommitAuthorizationInput,
  CommitAuthorizationOutcome,
  CommitEffectRequest,
  CommitWriteOutcome,
  CommitWriterInput,
} from "./types/index.js";

/**
 * The commit writer -- P-17/B, ADR 0127 (decisions 248-250).
 *
 * The production caller of `authorizeCommit`, and the one place a recorded authorization
 * becomes a Git effect. It spawns nothing: every spawn is `git-writer`'s, every read the
 * observer's, and every record the ledger's door (ND-1). Daemon-internal, off the barrel,
 * reached by no route, verb or beat, and not wired into the walk: P-17/C wires steps 8 and
 * 9 to it (ND-2).
 *
 * ## The authorization, in `AUDITING` only (ND-15)
 *
 * Over recorded facts alone: the task read back whole (`readRecordedTask`), the
 * coordinate's last receipt and its bytes (by reference, through the plane), the latest
 * verdict on it, the attempt's recorded lease (the ledger's one fold, `recordedLeaseOf`,
 * over the task stream's `LEASE_ACQUIRED` and `LEASE_REVOKED`, read with `listEvents(`,
 * built into a `Lease` from the last `LEASE_ACQUIRED` of that id, whose worktree must be
 * this repository), and the **current** observation. `authorizeCommit` rebuilds the
 * receipt, and its `receiptSha256` must be the recorded one (ND-4): by content
 * addressing, that re-proves that the observation, the write-set, the policy and the body
 * (the envelope's title on both sides, ND-3) are what was verified. Then the record-form
 * `COMMIT_AUTHORIZED` goes through `Ledger.append`, same-state in `AUDITING`, emitted by
 * `COMMITTER_IDENTITY_LABEL`, at the injected clock's instant (ND-16): the row is born
 * `INTENDED` with that instant as `authorized_at`. An `INTENDED` row already standing over
 * the receipt is kept, never re-recorded.
 *
 * ## The effect, in `READY_TO_COMMIT` only (ND-15)
 *
 * The row is read back (`getCommitAuthorization`) and its `authorized_at` is the date,
 * never a value the caller passed. Before any object is written the one in-force
 * predicate runs, extended through `revalidated` with the base (HEAD's commit against the
 * receipt's), the tree (read now, once, against the receipt's), the write-set digest and
 * the policy digest (ND-7): any difference is `GIT_WRITER_NOT_IN_FORCE`, carrying the
 * word, with zero write spawns. Then `git-writer` writes the objects, checks NB-2, writes
 * the commit, asks the fence port (ND-9) and compare-and-sets the branch. No
 * `COMMIT_RECORDED` is appended and the row never moves: that is P-17/C's.
 */

/**
 * The committer label: the author of the record-form event and its `authorizedBy`. A
 * worker identity no writer or verifier holds (the `VERIFIER_IDENTITY` mould, ND-16).
 * The role segment is `coordinator`: roles are a closed set (`WORKER_ROLES`), which has
 * no `committer`, and a commit is the coordinator's act (AGENTS "Reparto vigente").
 */
export const COMMITTER_IDENTITY_LABEL = "acp/commit-writer/coordinator/01";

/** The one state each half runs in (ND-15). */
const AUTHORIZING_STATE = "AUDITING";
const EFFECT_STATE = "READY_TO_COMMIT";

/** A page of the task stream, bounded. */
const EVENT_PAGE = 500;

function refuse(refusal: GitWriterRefusal, at: string, word: string | null = null): GitWriterRefused {
  return Object.freeze({ ok: false as const, refusal, at, word });
}

/** Every event of one type of one task, paged to exhaustion. */
function eventsOfType(ledger: Ledger, taskId: string, type: "LEASE_ACQUIRED" | "LEASE_REVOKED") {
  const records = [];
  let afterSequence = 0;
  for (;;) {
    const page = ledger.listEvents({ taskId, type, afterSequence, limit: EVENT_PAGE });
    records.push(...page.events);
    if (!page.hasMore || page.nextCursor === null) break;
    afterSequence = page.nextCursor;
  }
  return records;
}

/**
 * The attempt's recorded lease as a contract `Lease`, or null (B-6): the lease id from
 * the ledger's own fold, and the five fields from that id's last `LEASE_ACQUIRED`, which
 * the arbiter records whole.
 */
function recordedLease(ledger: Ledger, task: RecordedTask): { readonly lease: Lease | null; readonly events: readonly RecordedLeaseEvent[] } {
  const merged = [...eventsOfType(ledger, task.taskId, "LEASE_ACQUIRED"), ...eventsOfType(ledger, task.taskId, "LEASE_REVOKED")].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const events: RecordedLeaseEvent[] = merged.map((record) => ({
    type: record.event.type as RecordedLeaseEvent["type"],
    payload: record.event.payload,
  }));
  const folded = recordedLeaseOf(events, task.revision.revisionNumber, task.revision.attemptNumber);
  if (folded === null) return { lease: null, events };
  let lease: Lease | null = null;
  for (const event of events) {
    const payload = event.payload;
    if (event.type !== "LEASE_ACQUIRED" || payload["leaseId"] !== folded.leaseId) continue;
    const { worktreePath, holder, acquiredAt, expiresAt } = payload;
    if (typeof worktreePath !== "string" || typeof holder !== "string" || typeof acquiredAt !== "string" || typeof expiresAt !== "string") continue;
    lease = { leaseId: folded.leaseId, worktreePath, holder, acquiredAt, expiresAt };
  }
  return { lease, events };
}

/** The coordinate's receipt row with the greatest run, or null. */
function lastReceipt(ledger: Ledger, task: RecordedTask): VerificationReadModel | null {
  let last: VerificationReadModel | null = null;
  for (const row of ledger.listVerifications(task.taskId, task.revision.revisionNumber, task.revision.attemptNumber)) {
    if (last === null || row.verifierRunId > last.verifierRunId) last = row;
  }
  return last;
}

/** The receipt's bytes, by reference under the task, held to the row's name. */
function receiptOf(plane: ArtifactPlane, row: VerificationReadModel): VerificationReceipt | null {
  const read = plane.read({ artifactReferenceId: row.artifactReferenceId, scopeKind: "TASK", scopeId: row.taskId });
  if (read.verb !== "READ") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content.toString("utf8"));
  } catch {
    return null;
  }
  const receipt = VerificationReceipt.safeParse(parsed);
  if (!receipt.success) return null;
  try {
    if (receiptVerificationColumns(receipt.data).receiptSha256 !== row.receiptSha256) return null;
  } catch {
    return null;
  }
  return receipt.data;
}

interface Opened {
  readonly admitted: AdmittedRepository;
  readonly task: RecordedTask;
  readonly receiptRow: VerificationReadModel;
  readonly receipt: VerificationReceipt;
}

/** What both halves open with: the identity, the repository, the task in its one state, and the last receipt. */
function open(input: CommitWriterInput, state: string): Opened | GitWriterRefused {
  const invalid = admitIdentity(input.identity);
  if (invalid !== null) return invalid;
  const admission = admitRepository(input.repository);
  if (!admission.ok) return admission;
  const read = readRecordedTask({ ledger: input.ledger, plane: input.plane, taskId: input.taskId, route: input.route });
  if (!read.ok) return refuse("GIT_WRITER_TASK_UNREADABLE", read.at, read.refusal);
  const current = input.ledger.getTask(input.taskId)?.currentState ?? null;
  if (current !== state) return refuse("GIT_WRITER_TASK_STATE", "task.currentState", current);
  const receiptRow = lastReceipt(input.ledger, read.task);
  if (receiptRow === null) return refuse("GIT_WRITER_RECEIPT_ABSENT", "receipt");
  const receipt = receiptOf(input.plane, receiptRow);
  if (receipt === null) return refuse("GIT_WRITER_RECEIPT_UNREADABLE", "receipt");
  return { admitted: admission.admitted, task: read.task, receiptRow, receipt };
}

/**
 * Authorize the commit of the task's last receipt, and record it (ND-3, ND-4, ND-15,
 * ND-16). Spawns nothing that writes: its Git is the observer's.
 */
export function authorizeRecordedCommit(input: CommitAuthorizationInput): CommitAuthorizationOutcome {
  const opened = open(input, AUTHORIZING_STATE);
  if ("ok" in opened) return opened;
  const { admitted, task, receiptRow, receipt } = opened;
  const receiptSha256 = receiptRow.receiptSha256;

  const standing = input.ledger.getCommitAuthorization(task.taskId, receiptSha256);
  if (standing?.state === "INTENDED") {
    return Object.freeze({ ok: true as const, receiptSha256, authorizedAt: standing.authorizedAt, replayed: true });
  }

  const observed = observeWorktree(createGitObserver(admitted.repository), admitted.repository);
  if (!observed.ok) return refuse("GIT_WRITER_OBSERVATION_FAILED", "observation");

  const { lease } = recordedLease(input.ledger, task);
  if (lease === null) return refuse("GIT_WRITER_AUTHORIZATION_REFUSED", "lease", "LEASE_ABSENT");
  if (lease.worktreePath !== admitted.repository) return refuse("GIT_WRITER_AUTHORIZATION_REFUSED", "lease.worktreePath", "LEASE_WORKTREE_MISMATCH");

  const authorizedAt = input.now();
  if (!isCanonicalInstant(authorizedAt)) return refuse("GIT_WRITER_INPUT_INVALID", "now");
  const granted = authorizeCommit({
    taskId: task.taskId,
    revisionNumber: task.revision.revisionNumber,
    attemptNumber: task.revision.attemptNumber,
    attempt: task.attempt,
    writer: receipt.writer.identity,
    routeSegments: input.ledger.listRouteSegments(task.taskId, task.revision.revisionNumber, task.revision.attemptNumber),
    envelope: task.envelope,
    verifier: { ...receipt.verifier },
    authorizedBy: COMMITTER_IDENTITY_LABEL,
    authorizedAt,
    worktreePath: admitted.repository,
    lease,
    observation: observed.observation,
    treeSha: receipt.treeSha,
    checks: receipt.checks.map((check) => ({ ...check })),
  });
  if (!granted.ok) return refuse("GIT_WRITER_AUTHORIZATION_REFUSED", granted.at, granted.reason);
  if (granted.receiptSha256 !== receiptSha256) return refuse("GIT_WRITER_RECEIPT_MISMATCH", "receiptSha256");
  // The receipt's name covers the writer, the verifier, the base, the tree, the policy,
  // the write-set and the checks, not the observed paths: those are held here, member by
  // member, so a path observed now and not at verification is a mismatch (ND-4, N15).
  const observedNow = canonicalJsonStringify({
    tracked: granted.receipt.observedTrackedChanges,
    untracked: granted.receipt.observedUntrackedPaths,
  });
  const observedThen = canonicalJsonStringify({ tracked: receipt.observedTrackedChanges, untracked: receipt.observedUntrackedPaths });
  if (observedNow !== observedThen) return refuse("GIT_WRITER_RECEIPT_MISMATCH", "observation");

  // The latest verdict on the receipt: the door judges it (ACCEPT only, on this receipt).
  let verdict: { readonly auditId: string; readonly runId: number } | null = null;
  for (const row of input.ledger.listAuditVerdicts(receiptSha256)) {
    if (verdict === null || row.auditorRunId > verdict.runId) verdict = { auditId: row.auditId, runId: row.auditorRunId };
  }
  if (verdict === null) return refuse("GIT_WRITER_VERDICT_ABSENT", "verdict");

  const message = commitMessageWithReceiptTrailer(task.envelope.title, receiptSha256);
  const { revisionNumber, attemptNumber } = task.revision;
  const transitionId = "commit.authorized." + String(receiptRow.verifierRunId);
  const mintId = input.mintId ?? ((): string => randomUUID());
  try {
    input.ledger.append({
      contractVersion: CONTRACT_VERSION,
      eventId: mintId(),
      taskId: task.taskId,
      attempt: task.attempt,
      transitionId,
      idempotencyKey: buildV2IdempotencyKey({ stream: "control_plane_events", taskId: task.taskId, revisionNumber, attemptNumber, transitionId }),
      type: "COMMIT_AUTHORIZED",
      // Same state: the record is a fact in AUDITING; step 8 is the walk's (P-17/A ND-3).
      fromState: AUTHORIZING_STATE,
      toState: AUTHORIZING_STATE,
      emittedBy: COMMITTER_IDENTITY_LABEL,
      occurredAt: authorizedAt,
      recordedAt: authorizedAt,
      correlationId: null,
      causationId: null,
      payload: {
        revisionNumber,
        attemptNumber,
        commitAuthorization: { receiptSha256, auditId: verdict.auditId, commitMessageSha256: sha256Hex(message) },
      },
    });
  } catch (error: unknown) {
    if (error instanceof LedgerCommitAuthorizationRefusedError) return refuse("GIT_WRITER_RECORD_REFUSED", error.at, error.reason);
    const code = (error as { code?: unknown }).code;
    return refuse("GIT_WRITER_RECORD_REFUSED", "event", typeof code === "string" ? code : null);
  }
  const row = input.ledger.getCommitAuthorization(task.taskId, receiptSha256);
  if (row === null) return refuse("GIT_WRITER_RECORD_REFUSED", "row");
  return Object.freeze({ ok: true as const, receiptSha256, authorizedAt: row.authorizedAt, replayed: false });
}

/**
 * Write the authorized commit and compare-and-set the branch (ND-7, ND-9, ND-15; B-2's
 * order). The date is the row's; nothing here reads a clock.
 */
export function writeAuthorizedCommit(input: CommitEffectRequest): CommitWriteOutcome {
  const opened = open(input, EFFECT_STATE);
  if ("ok" in opened) return opened;
  const { admitted, task, receiptRow, receipt } = opened;
  const receiptSha256 = receiptRow.receiptSha256;
  const row = input.ledger.getCommitAuthorization(task.taskId, receiptSha256);

  // The tree now: every index path and every untracked path, read once (ND-5).
  const git = createGitObserver(admitted.repository);
  const listed = git({ verb: "ls-files", args: ["-s", "-z"] });
  if (!listed.ok) return refuse("GIT_WRITER_OBSERVATION_FAILED", "index");
  const index = indexPaths(listed.stdout);
  if (!index.ok) return refuse("GIT_WRITER_TREE_UNREADABLE", index.at, index.refusal);
  const observed = observeWorktree(git, admitted.repository);
  if (!observed.ok) return refuse("GIT_WRITER_OBSERVATION_FAILED", "observation");
  const wanted = [...new Set([...index.paths, ...observed.observation.untrackedPaths])].sort();
  const tree = readWorktreeTree(admitted.repository, wanted);
  if (!tree.ok) return refuse("GIT_WRITER_TREE_UNREADABLE", tree.at, tree.refusal);

  // The write-set and the policy, recomputed from the recorded envelope.
  const envelope = task.envelope;
  let writeSetNow = "";
  try {
    writeSetNow = receiptVerificationColumns({ ...receipt, declaredWriteSet: [...envelope.writeSet] }).writeSetSha256;
  } catch {
    writeSetNow = "";
  }
  let policyNow = "";
  try {
    policyNow = verificationPolicySha256({
      commands: envelope.validation.commands,
      independentVerifierRequired: envelope.validation.independentVerifierRequired,
      commitPolicy: envelope.commitPolicy,
    });
  } catch {
    policyNow = "";
  }

  // In force, immediately before any object write; zero write spawns on a refusal (B-2).
  const inForce = commitAuthorizationInForce({
    state: row?.state ?? null,
    authorizedAt: row?.authorizedAt ?? "",
    writerIdentity: receipt.writer.identity,
    lease: recordedLease(input.ledger, task).lease,
    revalidated: [
      { reason: "REVALIDATED_BASE_MISMATCH", at: "baseSha", authorized: receipt.baseSha, observed: admitted.head },
      { reason: "REVALIDATED_TREE_MISMATCH", at: "treeSha", authorized: receipt.treeSha, observed: tree.treeSha },
      { reason: "WRITE_SET_MISMATCH", at: "envelope.writeSet", authorized: receiptRow.writeSetSha256, observed: writeSetNow },
      { reason: "POLICY_DIGEST_MISMATCH", at: "envelope.validation", authorized: receiptRow.policySha256, observed: policyNow },
    ],
  });
  if (!inForce.inForce) return refuse("GIT_WRITER_NOT_IN_FORCE", inForce.at, inForce.reason);
  if (row === null) return refuse("GIT_WRITER_NOT_IN_FORCE", "state", "AUTHORIZATION_STATE_INVALID");

  const message = commitMessageWithReceiptTrailer(receipt.commitMessageBody, receiptSha256);
  if (sha256Hex(message) !== row.commitMessageSha256) return refuse("GIT_WRITER_RECEIPT_MISMATCH", "commitMessageSha256");

  const effect = commitAndCompareAndSet({
    admitted,
    identity: input.identity,
    authorizedAt: row.authorizedAt,
    baseSha: receipt.baseSha,
    treeSha: receipt.treeSha,
    blobs: tree.blobs,
    trees: tree.trees,
    writeSet: envelope.writeSet,
    message,
    fence: input.fence,
  });
  if (!effect.ok) return effect;
  return Object.freeze({ ...effect, receiptSha256 });
}
