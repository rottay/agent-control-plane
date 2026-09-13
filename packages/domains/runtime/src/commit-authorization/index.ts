/**
 * P6C: commit authorization and quarantine.
 *
 * Two decisions and a record, all pure. This module decides whether a commit
 * may be authorized, constructs the `CommitAuthorizationReceipt` **value** when
 * it may, decides whether a recorded commit matches the receipt that authorized
 * it, and builds the quarantine record for a worktree that violated its
 * write-set.
 *
 * **It never commits.** The commit is the integrator's act, performed under a
 * receipt this module produced; nothing here runs git, and the module never
 * names it. A test asserts the absence.
 *
 * **It mints nothing.** Every identifier and every instant in the receipt is
 * supplied by the caller -- there is no clock and no random source here, the
 * same allocation P5D and P6A use. `contractVersion` comes from
 * `@acp/contracts`, and `pushAuthorized` is `false` at the type: a receipt that
 * authorized a push is not a value this module can construct.
 *
 * **Quarantine is never cleanup.** The record names what happened and what to
 * revoke; there is no field in which a restore, reset, stash or clean could be
 * written, which is the P6A law carried forward rather than restated.
 *
 * One asymmetry is worth stating where it matters. The receipt's write-set
 * check -- and P6A's -- is exact `Set` membership, because git reports
 * canonical paths and the receipt contract's own refinement is exact. P6B's
 * normalization and ancestor containment apply to *envelope* intersection,
 * where the paths are human-written declarations rather than observations. The
 * two are different questions and are deliberately answered differently.
 */

import { CONTRACT_VERSION, CommitAuthorizationReceipt } from "@acp/contracts";
import { ControlPlaneEvent, Lease, PathDigest, WorkerIdentityString, buildIdempotencyKey } from "@acp/contracts";
import { computeOutboxCommandId } from "@acp/ledger";

import { checkWriteSetConformance } from "../enforcement/index.js";
import type {
  ConformanceVerdict,
  EnforcementRefused,
  WorktreeObservation,
} from "../enforcement/index.js";

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type AuthorizationRefusal =
  | "REQUEST_INVALID"
  | "VERIFIER_NOT_INDEPENDENT"
  | "CHECKS_MISSING"
  | "CHECK_FAILED"
  | "WRITE_SET_VIOLATION"
  | "BASE_HEAD_MISSING"
  | "BASE_HEAD_MISMATCH"
  | "LEASE_HOLDER_MISMATCH"
  | "LEASE_WORKTREE_MISMATCH"
  | "LEASE_EXPIRED"
  | "RECEIPT_INVALID"
  | "COMMIT_PARENT_MISMATCH"
  | "COMMIT_MESSAGE_MISMATCH"
  | "COMMIT_SHA_INVALID";

export const AUTHORIZATION_REFUSALS: readonly AuthorizationRefusal[] = Object.freeze([
  "BASE_HEAD_MISMATCH",
  "BASE_HEAD_MISSING",
  "CHECKS_MISSING",
  "CHECK_FAILED",
  "COMMIT_MESSAGE_MISMATCH",
  "COMMIT_PARENT_MISMATCH",
  "COMMIT_SHA_INVALID",
  "LEASE_EXPIRED",
  "LEASE_HOLDER_MISMATCH",
  "LEASE_WORKTREE_MISMATCH",
  "RECEIPT_INVALID",
  "REQUEST_INVALID",
  "VERIFIER_NOT_INDEPENDENT",
  "WRITE_SET_VIOLATION",
]);

export interface AuthorizationRefused {
  readonly ok: false;
  /**
   * This module's own vocabulary, or -- when a composed P6A check refused --
   * that refusal's reason, carried verbatim.
   *
   * Flattening an inner refusal into `REQUEST_INVALID` would answer "your
   * request was wrong" where the inner check already answered *which* input
   * and *why*, which is the whole point of a fail-closed taxonomy.
   */
  readonly reason: AuthorizationRefusal | EnforcementRefused["reason"];
  /** The input that decided it. A path, never a value. */
  readonly at: string;
}

function refuse(reason: AuthorizationRefusal, at: string): AuthorizationRefused {
  return Object.freeze({ ok: false as const, reason, at });
}

/** Carry a composed refusal outward unchanged, reason and path both. */
function carry(inner: EnforcementRefused): AuthorizationRefused {
  return Object.freeze({ ok: false as const, reason: inner.reason, at: inner.at });
}

// ---------------------------------------------------------------------------
// Candidate events
// ---------------------------------------------------------------------------

export type AuthorizationEventType =
  | "VERIFICATION_COMPLETED"
  | "AUDIT_COMPLETED"
  | "COMMIT_AUTHORIZED"
  | "COMMIT_RECORDED"
  | "TASK_STATE_CHANGED";

export interface AuthorizationEvent {
  readonly type: AuthorizationEventType;
  readonly payload: Readonly<Record<string, string>>;
}

function event(type: AuthorizationEventType, payload: Record<string, string>): AuthorizationEvent {
  return Object.freeze({ type, payload: Object.freeze({ ...payload }) });
}

const OBJECT_ID = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// 1. The authorization decision
// ---------------------------------------------------------------------------

export interface RecordedCheck {
  readonly command: string;
  readonly exitCode: number;
  readonly ranAt: string;
}

/**
 * Everything the receipt needs, all of it injected.
 *
 * The ids and instants are the caller's, not this module's: a pure core that
 * minted a uuid or read a clock would make the same request produce a
 * different receipt each time, and the receipt is evidence.
 */
export interface AuthorizationRequest {
  readonly receiptId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly writer: string;
  readonly verifier: string;
  readonly authorizedBy: string;
  readonly authorizedAt: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly declaredWriteSet: readonly string[];
  readonly observation: WorktreeObservation;
  readonly checks: readonly RecordedCheck[];
  readonly commitMessage: string;
  /**
   * The caller asserting the repository initial commit, where no HEAD exists.
   *
   * A pure core cannot look; the bootstrap exception is therefore a claim the
   * caller makes and is accountable for, not an inference this module draws
   * from a missing value. The observation is what settles it: the claim must
   * agree with `observation.head` being `null`, or it is refused
   * (`BASE_HEAD_MISMATCH`).
   *
   * There is no separate `baseHead` input. The receipt's base head is
   * *projected* from `observation.head` -- one authority for one fact, so a
   * receipt can never certify conformance observed against one commit while
   * naming another as its base.
   */
  readonly initialCommit?: boolean;
  /** Present iff an audit was performed; drives `AUDIT_COMPLETED`. */
  readonly audit?: { readonly auditor: string; readonly verdict: string };
  /** The lease the writer holds, so a violation names what to revoke. */
  readonly lease: Lease;
}

export interface AuthorizationGranted {
  readonly ok: true;
  readonly receipt: CommitAuthorizationReceipt;
  readonly events: readonly AuthorizationEvent[];
}

export type AuthorizationOutcome = AuthorizationGranted | AuthorizationRefused;

/**
 * Decide whether this commit may be authorized, and build the receipt if so.
 *
 * The order of the checks is the order of the laws: independence first,
 * because a receipt signed by its own writer is not evidence of anything; then
 * the recorded checks; then conformance, composed from P6A rather than
 * re-implemented; then the bootstrap exception; and only then the contract's
 * own parser, whose refusal is carried rather than re-worded.
 */
export function authorizeCommit(request: AuthorizationRequest): AuthorizationOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  const writer: unknown = fields["writer"];
  const verifier: unknown = fields["verifier"];
  if (typeof writer !== "string" || typeof verifier !== "string") {
    return refuse("REQUEST_INVALID", "request.writer");
  }
  // Independence is identity inequality and nothing more. A role restriction
  // would be shared vocabulary this module has no standing to invent.
  if (writer === verifier) return refuse("VERIFIER_NOT_INDEPENDENT", "request.verifier");

  const checks: unknown = fields["checks"];
  if (!Array.isArray(checks)) return refuse("REQUEST_INVALID", "request.checks");
  // The contract requires at least one check. Refusing here rather than at the
  // parser makes "you ran nothing" a named answer instead of a schema issue.
  if (checks.length === 0) return refuse("CHECKS_MISSING", "request.checks");
  for (let index = 0; index < checks.length; index += 1) {
    const check: unknown = checks[index];
    if (typeof check !== "object" || check === null) {
      return refuse("REQUEST_INVALID", "request.checks[" + String(index) + "]");
    }
    const exitCode: unknown = (check as Record<string, unknown>)["exitCode"];
    if (typeof exitCode !== "number") {
      return refuse("REQUEST_INVALID", "request.checks[" + String(index) + "].exitCode");
    }
    if (exitCode !== 0) {
      return refuse("CHECK_FAILED", "request.checks[" + String(index) + "]");
    }
  }

  // F3: the lease is not decoration on the request -- it is the claim that
  // this writer holds this worktree. A receipt built while the lease belongs
  // to someone else, or to another tree, would certify a commit nobody was
  // entitled to make, and P6A's one-writer law would hold everywhere except
  // at the moment it matters.
  const leaseParse = Lease.safeParse(fields["lease"]);
  if (!leaseParse.success) return refuse("REQUEST_INVALID", "request.lease");
  const lease = leaseParse.data;
  if (lease.holder !== writer) return refuse("LEASE_HOLDER_MISMATCH", "request.lease.holder");
  const worktreePath: unknown = fields["worktreePath"];
  if (lease.worktreePath !== worktreePath) {
    return refuse("LEASE_WORKTREE_MISMATCH", "request.lease.worktreePath");
  }
  // C5: and it must still be live. An expired lease of the right holder on the
  // right tree is a lease that ended before the commit it would authorize --
  // the same instant-of-expiry rule P6A uses, `authorizedAt >= expiresAt` is
  // expired. Instants are admitted by the contract's own parser and compared
  // by epoch, never as strings.
  const authorizedAt = Lease.shape.expiresAt.safeParse(fields["authorizedAt"]);
  if (!authorizedAt.success) return refuse("REQUEST_INVALID", "request.authorizedAt");
  if (Date.parse(authorizedAt.data) >= Date.parse(lease.expiresAt)) {
    return refuse("LEASE_EXPIRED", "request.lease.expiresAt");
  }

  // The optional audit is shape-checked here, with the other request guards,
  // rather than at the point the event is built: an `AUDIT_COMPLETED` whose
  // payload fields are `undefined` would record that an audit happened while
  // naming no auditor, which is worse than no event at all.
  let auditor: string | null = null;
  let auditVerdict = "";
  const audit: unknown = fields["audit"];
  if (audit !== undefined) {
    if (typeof audit !== "object" || audit === null) {
      return refuse("REQUEST_INVALID", "request.audit");
    }
    const auditFields = audit as Record<string, unknown>;
    // The receipt's own identity parser, so an auditor is an identity by the
    // same law the writer and verifier are.
    const parsedAuditor = WorkerIdentityString.safeParse(auditFields["auditor"]);
    if (!parsedAuditor.success) return refuse("REQUEST_INVALID", "request.audit.auditor");
    const verdictValue: unknown = auditFields["verdict"];
    if (typeof verdictValue !== "string" || verdictValue === "") {
      return refuse("REQUEST_INVALID", "request.audit.verdict");
    }
    auditor = parsedAuditor.data;
    auditVerdict = verdictValue;
  }

  // Conformance is P6A's judgement, composed rather than repeated: one
  // implementation of "outside the declared set", called from both places that
  // need it.
  const conformance = checkWriteSetConformance({
    declaredWriteSet: request.declaredWriteSet,
    observation: request.observation,
    lease: request.lease,
  });
  if (!conformance.ok) return carry(conformance);
  if (!conformance.conformant) return refuse("WRITE_SET_VIOLATION", "request.observation");

  // The base head is projected, never re-asked. P6A validated `observation.head`
  // as `null` or a git object id on the way through, so this is the observed
  // fact itself rather than a second claim about it.
  const baseHead = request.observation.head;
  const initialCommit = fields["initialCommit"] === true;
  if (baseHead === null && !initialCommit) {
    return refuse("BASE_HEAD_MISSING", "request.observation.head");
  }
  // A caller asserting the bootstrap over a worktree that has a HEAD is
  // asserting something the observation contradicts.
  if (baseHead !== null && initialCommit) {
    return refuse("BASE_HEAD_MISMATCH", "request.initialCommit");
  }

  const receipt = CommitAuthorizationReceipt.safeParse({
    contractVersion: CONTRACT_VERSION,
    receiptId: request.receiptId,
    taskId: request.taskId,
    attempt: request.attempt,
    writer: request.writer,
    verifier: request.verifier,
    authorizedBy: request.authorizedBy,
    authorizedAt: request.authorizedAt,
    worktreePath: request.worktreePath,
    branch: request.branch,
    baseHead,
    declaredWriteSet: [...request.declaredWriteSet],
    observedTrackedChanges: request.observation.trackedChanges.map((entry) => ({ ...entry })),
    observedUntrackedPaths: [...request.observation.untrackedPaths],
    checks: request.checks.map((check) => ({ ...check })),
    commitMessage: request.commitMessage,
    // Never anything else. A receipt cannot authorize a push, and this is the
    // only place the field is written.
    pushAuthorized: false,
  });
  if (!receipt.success) {
    const issue = receipt.error.issues[0];
    return refuse("RECEIPT_INVALID", "receipt." + (issue?.path ?? []).join("."));
  }

  const events: AuthorizationEvent[] = [
    event("VERIFICATION_COMPLETED", {
      taskId: request.taskId,
      verifier: request.verifier,
      checks: String(request.checks.length),
    }),
  ];
  if (auditor !== null) {
    events.push(
      event("AUDIT_COMPLETED", {
        taskId: request.taskId,
        auditor,
        verdict: auditVerdict,
      }),
    );
  }
  events.push(
    event("COMMIT_AUTHORIZED", {
      taskId: request.taskId,
      receiptId: request.receiptId,
      authorizedBy: request.authorizedBy,
    }),
  );

  return Object.freeze({
    ok: true as const,
    receipt: receipt.data,
    events: Object.freeze(events),
  });
}

// ---------------------------------------------------------------------------
// 2. The post-commit record
// ---------------------------------------------------------------------------

export interface RecordedCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly message: string;
}

export interface CommitRecordRequest {
  readonly receipt: CommitAuthorizationReceipt;
  readonly commit: RecordedCommit;
}

export interface CommitRecorded {
  readonly ok: true;
  readonly events: readonly AuthorizationEvent[];
}

export type CommitRecordOutcome = CommitRecorded | AuthorizationRefused;

/**
 * Does this recorded commit match the receipt that authorized it?
 *
 * The receipt says what was allowed; the commit says what happened. Checking
 * that they agree is what makes the receipt evidence rather than paperwork --
 * an authorization nobody reconciles against the result authorizes nothing in
 * practice.
 */
export function recordCommit(request: CommitRecordRequest): CommitRecordOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  const parsed = CommitAuthorizationReceipt.safeParse(fields["receipt"]);
  if (!parsed.success) return refuse("RECEIPT_INVALID", "request.receipt");
  const receipt = parsed.data;

  const commit: unknown = fields["commit"];
  if (typeof commit !== "object" || commit === null) {
    return refuse("REQUEST_INVALID", "request.commit");
  }
  const recorded = commit as Record<string, unknown>;

  const sha: unknown = recorded["sha"];
  if (typeof sha !== "string" || !OBJECT_ID.test(sha)) {
    return refuse("COMMIT_SHA_INVALID", "request.commit.sha");
  }

  const parents: unknown = recorded["parents"];
  if (!Array.isArray(parents)) return refuse("REQUEST_INVALID", "request.commit.parents");
  for (const parent of parents) {
    if (typeof parent !== "string" || !OBJECT_ID.test(parent)) {
      return refuse("COMMIT_SHA_INVALID", "request.commit.parents");
    }
  }
  if (receipt.baseHead === null) {
    // The bootstrap case: an initial commit has no parent, and one that has a
    // parent is not the commit this receipt authorized.
    if (parents.length !== 0) return refuse("COMMIT_PARENT_MISMATCH", "request.commit.parents");
  } else if (parents[0] !== receipt.baseHead) {
    // First parent only: a merge's second parent is not what the receipt was
    // taken against, and requiring equality there would refuse lawful merges.
    return refuse("COMMIT_PARENT_MISMATCH", "request.commit.parents");
  }

  const message: unknown = recorded["message"];
  if (typeof message !== "string") return refuse("REQUEST_INVALID", "request.commit.message");
  if (message !== receipt.commitMessage) {
    return refuse("COMMIT_MESSAGE_MISMATCH", "request.commit.message");
  }

  return Object.freeze({
    ok: true as const,
    events: Object.freeze([
      event("COMMIT_RECORDED", {
        taskId: receipt.taskId,
        receiptId: receipt.receiptId,
        sha,
      }),
    ]),
  });
}

// ---------------------------------------------------------------------------
// 3. Quarantine
// ---------------------------------------------------------------------------

/**
 * The record of a quarantined worktree.
 *
 * Deliberately a closed set of facts: what was violated, where, by whom, and
 * what to revoke. **There is no field in which a cleanup could be written** --
 * no restore, no reset, no stash, no clean -- and a test asserts the exact key
 * set, so adding one would be a visible change rather than a quiet one. The
 * worktree is left exactly as it was found, because the evidence of what
 * happened is worth more than a tidy directory.
 */
export interface QuarantineRecord {
  readonly worktreePath: string;
  readonly leaseId: string;
  readonly holder: string;
  /** Every observed path outside the declared set, sorted. */
  readonly violatingPaths: readonly string[];
  /** The digests of the tracked changes that were observed, as evidence. */
  readonly evidence: readonly PathDigest[];
  /** The task transition this recommends. Always `SUSPECT_WORKTREE`. */
  readonly recommendedTaskState: "SUSPECT_WORKTREE";
  readonly events: readonly AuthorizationEvent[];
}

export interface QuarantineRequest {
  readonly verdict: ConformanceVerdict;
  readonly lease: Lease;
  readonly observation: WorktreeObservation;
  readonly taskId: string;
}

export type QuarantineOutcome =
  | { readonly ok: true; readonly record: QuarantineRecord }
  | AuthorizationRefused;

/**
 * Build the quarantine record for a violated worktree.
 *
 * Takes the conformance verdict as an input rather than re-deriving it, so the
 * record and the verdict can never describe different violations.
 */
export function quarantineWorktree(request: QuarantineRequest): QuarantineOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  const verdict: unknown = fields["verdict"];
  if (typeof verdict !== "object" || verdict === null) {
    return refuse("REQUEST_INVALID", "request.verdict");
  }
  const verdictFields = verdict as Record<string, unknown>;
  const conformant: unknown = verdictFields["conformant"];
  if (typeof conformant !== "boolean") return refuse("REQUEST_INVALID", "request.verdict");
  // A conformant worktree is not quarantined. Building a record for one would
  // mean the caller and this module disagree about what happened.
  if (conformant) return refuse("REQUEST_INVALID", "request.verdict.conformant");

  // Everything the record is built from is validated at the boundary. A
  // quarantine record is evidence about a worktree; one assembled out of
  // `undefined`s, or naming a lease the verdict did not revoke, is evidence
  // about nothing, and a thrown TypeError is not a classified refusal.
  const violationsValue: unknown = verdictFields["violations"];
  if (!Array.isArray(violationsValue)) {
    return refuse("REQUEST_INVALID", "request.verdict.violations");
  }
  const violationsList: readonly unknown[] = violationsValue;
  // A non-conformant verdict names at least one path, or it is not a verdict
  // this record could describe.
  if (violationsList.length === 0) {
    return refuse("REQUEST_INVALID", "request.verdict.violations");
  }
  const violatingPaths: string[] = [];
  for (let index = 0; index < violationsList.length; index += 1) {
    const path: unknown = violationsList[index];
    if (typeof path !== "string" || path === "") {
      return refuse("REQUEST_INVALID", "request.verdict.violations[" + String(index) + "]");
    }
    violatingPaths.push(path);
  }

  const revokeLeaseId: unknown = verdictFields["revokeLeaseId"];
  if (typeof revokeLeaseId !== "string" || revokeLeaseId === "") {
    return refuse("REQUEST_INVALID", "request.verdict.revokeLeaseId");
  }

  const leaseParse = Lease.safeParse(fields["lease"]);
  if (!leaseParse.success) return refuse("REQUEST_INVALID", "request.lease");
  const lease = leaseParse.data;
  // The record must name the lease the verdict revoked. A different one would
  // quarantine one worktree on evidence gathered about another.
  if (lease.leaseId !== revokeLeaseId) return refuse("REQUEST_INVALID", "request.lease");

  const observation: unknown = fields["observation"];
  if (typeof observation !== "object" || observation === null) {
    return refuse("REQUEST_INVALID", "request.observation");
  }
  const trackedValue: unknown = (observation as Record<string, unknown>)["trackedChanges"];
  if (!Array.isArray(trackedValue)) {
    return refuse("REQUEST_INVALID", "request.observation.trackedChanges");
  }
  const trackedList: readonly unknown[] = trackedValue;
  const evidence: PathDigest[] = [];
  for (let index = 0; index < trackedList.length; index += 1) {
    const parsed = PathDigest.safeParse(trackedList[index]);
    if (!parsed.success) {
      return refuse(
        "REQUEST_INVALID",
        "request.observation.trackedChanges[" + String(index) + "]",
      );
    }
    evidence.push(parsed.data);
  }

  const taskId: unknown = fields["taskId"];
  if (typeof taskId !== "string" || taskId === "") {
    return refuse("REQUEST_INVALID", "request.taskId");
  }

  return Object.freeze({
    ok: true as const,
    record: Object.freeze({
      worktreePath: lease.worktreePath,
      leaseId: lease.leaseId,
      holder: lease.holder,
      violatingPaths: Object.freeze(violatingPaths),
      evidence: Object.freeze(evidence.map((entry) => Object.freeze({ ...entry }))),
      recommendedTaskState: "SUSPECT_WORKTREE" as const,
      events: Object.freeze([
        event("TASK_STATE_CHANGED", { taskId, toState: "SUSPECT_WORKTREE" }),
      ]),
    }),
  });
}

// ---------------------------------------------------------------------------
// 4. The quarantine batch (P-18/protocolo F)
// ---------------------------------------------------------------------------

/**
 * The phase a quarantine's revocation is intended under, and the kind of target
 * it names. Two words, fixed here because this builder is the one producer of
 * that command: a second spelling would be a second `command_id` for one
 * revocation.
 */
export const QUARANTINE_PHASE = "QUARANTINE";
export const QUARANTINE_TARGET_KIND = "WORKTREE_LEASE";

/** The id and transition of one candidate, both the caller's. */
export interface QuarantineEventIdentity {
  readonly eventId: string;
  readonly transitionId: string;
}

/**
 * Where the batch is recorded, all of it injected.
 *
 * Three identities for three events, one instant pair for all of them, and the
 * task's state as the caller read it. This module reads no clock and mints no
 * identifier, for the receipt's reason: the batch is evidence, and the same
 * request has to build the same bytes on every retry.
 */
export interface QuarantineBatchCoordinate {
  readonly taskId: string;
  readonly attempt: number;
  readonly currentState: string;
  readonly emittedBy: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly correlationId: string | null;
  readonly violation: QuarantineEventIdentity;
  readonly quarantine: QuarantineEventIdentity;
  readonly intention: QuarantineEventIdentity;
}

export interface QuarantineBatchRequest {
  readonly record: QuarantineRecord;
  /** The saga the revocation belongs to. Supplied, never generated here. */
  readonly sagaId: string;
  readonly deadlineAt: string;
  /** The lease token the revocation is issued under, or `null` when none is held. */
  readonly leaseToken: { readonly incarnationId: string; readonly fence: number } | null;
  readonly coordinate: QuarantineBatchCoordinate;
}

export interface QuarantineBatchBuilt {
  readonly ok: true;
  /** The candidates for one `appendBatch`, in the order they must commit. */
  readonly candidates: readonly ControlPlaneEvent[];
  /** The id of the revocation command, as the ledger will recompute it. */
  readonly commandId: string;
}

export type QuarantineBatchOutcome = QuarantineBatchBuilt | AuthorizationRefused;

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Build the batch that quarantines a worktree and intends to revoke its lease.
 *
 * Contracts §13 `:559-561` and datos §11 `:546-550`: inside the ledger the
 * quarantine and the intention to revoke are **atomic**, and the intention is a
 * complete command event rather than a row of a separate file. So what this
 * returns is one batch of three candidates, in the order they must commit:
 *
 * 1. `WRITE_SET_VIOLATION_DETECTED`, the finding, same-state;
 * 2. `TASK_STATE_CHANGED` to `SUSPECT_WORKTREE`, the quarantine;
 * 3. `OUTBOX_COMMAND_INTENDED` of kind `REVOKE_LEASE`, immediately after it.
 *
 * `LEASE_REVOKED` is **not** in it. The daemon's gate writes it today, as the
 * second of three separate appends; but inside the ledger's transaction nothing
 * has happened at the arbiter yet, and recording a revocation there would be the
 * cross-file atomicity datos §11 `:558` forbids anyone to claim. The revocation
 * is the command's delivery, and its acknowledgement is an observation.
 *
 * **It is pure and it mints nothing.** The saga is the caller's, and a request
 * without one is refused rather than given a UUID from here (N-F-11). The command
 * id is not minted either: it is computed by `computeOutboxCommandId`, the one
 * function the ledger's door recomputes it with. Every candidate is parsed by the
 * contract before it is returned, so what comes back is admissible as an event;
 * whether it is admissible *here* — the task's state, the batch's shape — is the
 * ledger's to decide.
 */
export function buildQuarantineBatch(request: QuarantineBatchRequest): QuarantineBatchOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  const sagaId: unknown = fields["sagaId"];
  if (typeof sagaId !== "string" || !LOWER_UUID.test(sagaId)) {
    return refuse("REQUEST_INVALID", "request.sagaId");
  }

  const recordValue: unknown = fields["record"];
  if (typeof recordValue !== "object" || recordValue === null) {
    return refuse("REQUEST_INVALID", "request.record");
  }
  const record = recordValue as Record<string, unknown>;
  const worktreePath: unknown = record["worktreePath"];
  const leaseId: unknown = record["leaseId"];
  const violatingPaths: unknown = record["violatingPaths"];
  if (typeof worktreePath !== "string" || worktreePath === "") {
    return refuse("REQUEST_INVALID", "request.record.worktreePath");
  }
  if (typeof leaseId !== "string" || leaseId === "") {
    return refuse("REQUEST_INVALID", "request.record.leaseId");
  }
  if (!Array.isArray(violatingPaths) || violatingPaths.length === 0) {
    return refuse("REQUEST_INVALID", "request.record.violatingPaths");
  }
  const firstPath: unknown = violatingPaths[0];
  if (typeof firstPath !== "string" || firstPath === "") {
    return refuse("REQUEST_INVALID", "request.record.violatingPaths[0]");
  }
  if (record["recommendedTaskState"] !== "SUSPECT_WORKTREE") {
    return refuse("REQUEST_INVALID", "request.record.recommendedTaskState");
  }

  const deadline = Lease.shape.expiresAt.safeParse(fields["deadlineAt"]);
  if (!deadline.success) return refuse("REQUEST_INVALID", "request.deadlineAt");

  const tokenValue: unknown = fields["leaseToken"];
  let token: { readonly incarnationId: string; readonly fence: number } | null = null;
  if (tokenValue !== null) {
    if (typeof tokenValue !== "object") {
      return refuse("REQUEST_INVALID", "request.leaseToken");
    }
    const incarnationId: unknown = (tokenValue as Record<string, unknown>)["incarnationId"];
    const fence: unknown = (tokenValue as Record<string, unknown>)["fence"];
    if (typeof incarnationId !== "string" || !LOWER_UUID.test(incarnationId)) {
      return refuse("REQUEST_INVALID", "request.leaseToken.incarnationId");
    }
    if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 1) {
      return refuse("REQUEST_INVALID", "request.leaseToken.fence");
    }
    token = { incarnationId, fence };
  }

  const coordinateValue: unknown = fields["coordinate"];
  if (typeof coordinateValue !== "object" || coordinateValue === null) {
    return refuse("REQUEST_INVALID", "request.coordinate");
  }
  const coordinate = coordinateValue as QuarantineBatchCoordinate;
  // A task already quarantined has nothing to quarantine; the move below would
  // be a same-state `TASK_STATE_CHANGED`, which the contract refuses anyway.
  if (coordinate.currentState === "SUSPECT_WORKTREE") {
    return refuse("REQUEST_INVALID", "request.coordinate.currentState");
  }
  for (const name of ["violation", "quarantine", "intention"] as const) {
    const identity: unknown = (coordinateValue as Record<string, unknown>)[name];
    if (typeof identity !== "object" || identity === null) {
      return refuse("REQUEST_INVALID", "request.coordinate." + name);
    }
  }

  const commandId = computeOutboxCommandId({
    sagaId,
    phase: QUARANTINE_PHASE,
    targetKind: QUARANTINE_TARGET_KIND,
    targetId: worktreePath,
  });

  const candidate = (
    identity: QuarantineEventIdentity,
    type: ControlPlaneEvent["type"],
    fromState: string,
    toState: string,
    payload: Record<string, unknown>,
  ): unknown => ({
    contractVersion: CONTRACT_VERSION,
    eventId: identity.eventId,
    taskId: coordinate.taskId,
    attempt: coordinate.attempt,
    transitionId: identity.transitionId,
    idempotencyKey: buildIdempotencyKey({
      taskId: coordinate.taskId,
      attempt: coordinate.attempt,
      transitionId: identity.transitionId,
    }),
    type,
    fromState,
    toState,
    emittedBy: coordinate.emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: coordinate.correlationId,
    causationId: null,
    payload,
  });

  const drafts: readonly unknown[] = [
    candidate(
      coordinate.violation,
      "WRITE_SET_VIOLATION_DETECTED",
      coordinate.currentState,
      coordinate.currentState,
      {
        leaseId,
        firstPathOutsideSet: firstPath,
        pathsOutsideSet: String(violatingPaths.length),
      },
    ),
    candidate(coordinate.quarantine, "TASK_STATE_CHANGED", coordinate.currentState, "SUSPECT_WORKTREE", {
      taskId: coordinate.taskId,
      toState: "SUSPECT_WORKTREE",
    }),
    candidate(coordinate.intention, "OUTBOX_COMMAND_INTENDED", "SUSPECT_WORKTREE", "SUSPECT_WORKTREE", {
      outboxContractVersion: 1,
      sagaId,
      commandId,
      phase: QUARANTINE_PHASE,
      commandKind: "REVOKE_LEASE",
      intentStream: "control_plane_events",
      targetKind: QUARANTINE_TARGET_KIND,
      targetId: worktreePath,
      deadlineAt: deadline.data,
      fence: token === null ? null : token.fence,
      targetStoreIncarnationId: token === null ? null : token.incarnationId,
    }),
  ];

  const candidates: ControlPlaneEvent[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const parsed = ControlPlaneEvent.safeParse(drafts[index]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refuse(
        "REQUEST_INVALID",
        "candidates[" + String(index) + "]." + (issue?.path ?? []).join("."),
      );
    }
    candidates.push(parsed.data);
  }

  return Object.freeze({
    ok: true as const,
    candidates: Object.freeze(candidates),
    commandId,
  });
}
