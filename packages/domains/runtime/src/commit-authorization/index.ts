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
 * **It mints nothing.** Every instant and every supplied identifier in the
 * receipt is the caller's -- there is no clock and no random source here, the
 * same allocation P5D and P6A use. The two identities it does not take from the
 * caller are derived, not minted: the writer's instance id is the ledger's
 * `writerWorkerIdFor` over the task and its flat attempt, and the receipt's name
 * is the ledger's `receiptSha256` over its content (P-16/A2, ADR 0121). Both are
 * pure functions, so the same request builds the same receipt on every retry.
 * `contractVersion` comes from `@acp/contracts`, and `pushAuthorized` is `false`
 * at the type: a receipt that authorized a push is not a value this module can
 * construct.
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

import {
  CONTRACT_VERSION,
  CanonicalInstant,
  CommitAuthorizationReceipt,
  TaskEnvelope,
  VerificationReceipt,
  WRITER_ID_UNISSUED,
  commitMessageWithReceiptTrailer,
} from "@acp/contracts";
import { ControlPlaneEvent, Lease, PathDigest, WorkerIdentityString, buildIdempotencyKey } from "@acp/contracts";
import {
  LedgerValidationError,
  computeOutboxCommandId,
  receiptSha256,
  verificationPolicySha256,
  writerWorkerIdFor,
} from "@acp/ledger";

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
  | typeof WRITER_ID_UNISSUED
  | "LEASE_HOLDER_MISMATCH"
  | "LEASE_WORKTREE_MISMATCH"
  | "LEASE_EXPIRED"
  | "RECEIPT_INVALID"
  | "COMMIT_PARENT_MISMATCH"
  | "COMMIT_MESSAGE_MISMATCH"
  | "COMMIT_SHA_INVALID"
  | "COMMIT_MESSAGE_BODY_EMPTY"
  | "COMMIT_MESSAGE_BODY_ENDS_IN_LF"
  | "COMMIT_MESSAGE_BODY_HOLDS_CR"
  | "COMMIT_MESSAGE_BODY_HOLDS_TRAILER"
  | "COMMIT_POLICY_NO_COMMIT";

export const AUTHORIZATION_REFUSALS: readonly AuthorizationRefusal[] = Object.freeze([
  "BASE_HEAD_MISSING",
  "CHECKS_MISSING",
  "CHECK_FAILED",
  "COMMIT_MESSAGE_BODY_EMPTY",
  "COMMIT_MESSAGE_BODY_ENDS_IN_LF",
  "COMMIT_MESSAGE_BODY_HOLDS_CR",
  "COMMIT_MESSAGE_BODY_HOLDS_TRAILER",
  "COMMIT_MESSAGE_MISMATCH",
  "COMMIT_PARENT_MISMATCH",
  "COMMIT_POLICY_NO_COMMIT",
  "COMMIT_SHA_INVALID",
  "LEASE_EXPIRED",
  "LEASE_HOLDER_MISMATCH",
  "LEASE_WORKTREE_MISMATCH",
  "RECEIPT_INVALID",
  "REQUEST_INVALID",
  "VERIFIER_NOT_INDEPENDENT",
  WRITER_ID_UNISSUED,
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
 * The writer transports that issue a writer id (decision 227; ND-10).
 *
 * One member today: a Claude CLI writer runs under a session named by the writer
 * id itself. Every other transport is refused as `WRITER_ID_UNISSUED` until
 * P-28 widens the set. Module-private: its producer is `writerIdIssuerFor` below
 * (P-16/C, ADR 0123), the promotion decision 229 anticipated; the list itself stays
 * here.
 */
const WRITER_ID_ISSUERS: readonly string[] = Object.freeze(["CLAUDE_CLI_SESSION"]);

/** The one route a writer id is issued on today: the Claude CLI under a subscription. */
const CLAUDE_CLI_ROUTE = Object.freeze({ provider: "claude", transportKind: "CLI_SUBSCRIPTION" });

/**
 * The writer id issuer of one attempt, from its recorded route segments, or `null`
 * (P-16/C, ADR 0123; decision 236, ND-11).
 *
 * Every segment of the attempt must be the Claude CLI under a subscription
 * (`provider = "claude"`, `transportKind = "CLI_SUBSCRIPTION"`): then the writer ran
 * under a session named by its writer id, and the issuer is `CLAUDE_CLI_SESSION`.
 * No segment at all, or any other segment -- an API key, a local or self-hosted
 * model, another provider's CLI, or a handoff to any of them -- has no issuer, and
 * the caller refuses `WRITER_ID_UNISSUED` by name. Pure, and total over its input:
 * a segment that is not an object with those two strings is an "other".
 *
 * Since P-17/A (ADR 0126; decision 246) `authorizeCommit` takes its issuer from this
 * function over the attempt's recorded segments, never from its caller.
 */
export function writerIdIssuerFor(
  segments: readonly { readonly provider: unknown; readonly transportKind: unknown }[],
): string | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  for (const segment of segments as readonly unknown[]) {
    if (typeof segment !== "object" || segment === null) return null;
    const fields = segment as { readonly provider?: unknown; readonly transportKind?: unknown };
    if (fields.provider !== CLAUDE_CLI_ROUTE.provider || fields.transportKind !== CLAUDE_CLI_ROUTE.transportKind) return null;
  }
  const issuer = WRITER_ID_ISSUERS[0];
  return issuer ?? null;
}

/**
 * The request's closed key set (ND-11).
 *
 * A key outside it is refused by its own path rather than ignored, so a caller
 * still speaking the V1 request (`initialCommit`, `receiptId`, `branch`,
 * `commitMessage`), or one that supplies a writer id of its own, fails loudly.
 * Since P-17/A (ADR 0126; ND-11 (a)) the issuer, the policy digest and the declared
 * write-set are not keys either: they are read from the attempt's recorded route
 * segments and the recorded envelope, and a caller that supplies one is refused at
 * its path.
 */
const REQUEST_KEYS: ReadonlySet<string> = new Set([
  "taskId",
  "revisionNumber",
  "attemptNumber",
  "attempt",
  "writer",
  "routeSegments",
  "envelope",
  "verifier",
  "authorizedBy",
  "authorizedAt",
  "worktreePath",
  "lease",
  "observation",
  "treeSha",
  "checks",
  "commitMessageBody",
  "audit",
]);

/** The one policy under which a commit may be authorized. */
const LOCAL_COMMIT = "LOCAL_COMMIT_WITH_RECEIPT";

/** The receipt's own body schema, reached through the contract: the body rules' one home. */
const RECEIPT_BODY = VerificationReceipt.shape.commitMessageBody;

/** The contract's bound on a body, which a longer body fails for that reason alone. */
const BODY_MAX = 2_000;

/**
 * The four body words of execution §10.5, before the receipt is parsed (ND-11, B-3): an
 * empty body, one ending in a line feed, one holding a carriage return, and -- when the
 * body is within the contract's bound and the receipt's own body schema still refuses
 * it -- one already carrying the trailer line, the only rule left. The trailer's key is
 * never spelled here (L-P16A2-1): its one home is contracts. An over-long body falls
 * through to the receipt parse, `RECEIPT_INVALID`. Null when the body passes.
 */
function commitMessageBodyRefusal(body: unknown): AuthorizationRefusal | null {
  if (typeof body !== "string") return null;
  if (body === "") return "COMMIT_MESSAGE_BODY_EMPTY";
  if (body.endsWith("\n")) return "COMMIT_MESSAGE_BODY_ENDS_IN_LF";
  if (body.includes("\r")) return "COMMIT_MESSAGE_BODY_HOLDS_CR";
  if (body.length <= BODY_MAX && !RECEIPT_BODY.safeParse(body).success) return "COMMIT_MESSAGE_BODY_HOLDS_TRAILER";
  return null;
}

/**
 * Everything the receipt needs, all of it injected but the two derived identities.
 *
 * The instants and the supplied ids are the caller's, not this module's: a pure
 * core that minted a uuid or read a clock would make the same request produce a
 * different receipt each time, and the receipt is evidence. The writer's instance
 * id is **not** a field: the plane derives it (execution §10.2, "ningún proceso de
 * worker escribe esos campos"), and a request that supplies one is refused.
 *
 * There is no base input and no bootstrap claim. The receipt's `baseSha` is
 * *projected* from `observation.head` -- one authority for one fact -- and a
 * `null` head is refused: there is no initial-commit receipt (D-9).
 */
export interface AuthorizationRequest {
  readonly taskId: string;
  /** The V2 coordinate the receipt is issued for. */
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  /**
   * The flat per-task attempt (execution `legacy_attempt_number`), the writer id's
   * input. Never the per-revision `attemptNumber`, which restarts in each revision.
   * That the two name the same attempt is P-16/B's door to check, not this module's.
   */
  readonly attempt: number;
  /** The writer's identity label. */
  readonly writer: string;
  /**
   * The attempt's recorded route segments (`listRouteSegments`), from which the writer
   * id's issuer is read by `writerIdIssuerFor` (P-17/A, ND-11). No caller names the
   * issuer.
   */
  readonly routeSegments: readonly { readonly provider: unknown; readonly transportKind: unknown }[];
  /**
   * The recorded envelope, as `readRecordedTask` returns it (P-17/A, ND-11): its
   * write-set is the declared one, its three policy members give `policySha256`
   * (`verificationPolicySha256`), and a `NO_COMMIT` envelope is refused by name.
   */
  readonly envelope: TaskEnvelope;
  /**
   * The verifier's label, instance id and run. Supplied; P-16/C's runner fills it
   * from its own spawn record.
   */
  readonly verifier: {
    readonly identity: string;
    readonly workerId: string;
    readonly runId: number;
  };
  readonly authorizedBy: string;
  /** A canonical instant: the future `authorized_at` (execution §10.5). */
  readonly authorizedAt: string;
  readonly worktreePath: string;
  /** The lease the writer holds, so a violation names what to revoke. */
  readonly lease: Lease;
  readonly observation: WorktreeObservation;
  /** The verified tree. Supplied; P-16/C's tree hasher produces it. */
  readonly treeSha: string;
  readonly checks: readonly RecordedCheck[];
  /** The message body. The trailer is added at the commit, never here. */
  readonly commitMessageBody: string;
  /** Present iff an audit was performed; drives `AUDIT_COMPLETED`. */
  readonly audit?: { readonly auditor: string; readonly verdict: string };
}

export interface AuthorizationGranted {
  readonly ok: true;
  readonly receipt: CommitAuthorizationReceipt;
  /** The receipt's name, `receipt_sha256`, computed by the ledger's one site. */
  readonly receiptSha256: string;
  readonly events: readonly AuthorizationEvent[];
}

export type AuthorizationOutcome = AuthorizationGranted | AuthorizationRefused;

/**
 * Decide whether this commit may be authorized, and build the receipt if so.
 *
 * The order of the checks is the order of the laws: the request's own key set;
 * then the recorded envelope, parsed, and its policy (`COMMIT_POLICY_NO_COMMIT` for a
 * `NO_COMMIT` envelope, P-17/A B-4); then independence, by label and then by instance against the writer id the
 * plane derives, because a receipt signed by its own writer is not evidence of
 * anything; then the recorded checks; then the lease; then the shape of the
 * authority and of the optional audit; then conformance, composed
 * from P6A rather than re-implemented, over the envelope's write-set; then the base;
 * then the writer id's issuer, read from the recorded segments; then the four body
 * words (P-17/A); and only then the contract's own parser, whose refusal is carried
 * rather than re-worded. Each input is parsed before it is compared, so a
 * malformed verifier id is `REQUEST_INVALID`, never `VERIFIER_NOT_INDEPENDENT`.
 */
export function authorizeCommit(request: AuthorizationRequest): AuthorizationOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  for (const key of Object.keys(fields)) {
    if (!REQUEST_KEYS.has(key)) return refuse("REQUEST_INVALID", "request." + key);
  }

  // The recorded envelope, parsed before anything reads it: the declared write-set and
  // the policy are its facts, not the caller's (P-17/A, ND-11).
  const envelopeParse = TaskEnvelope.safeParse(fields["envelope"]);
  if (!envelopeParse.success) {
    const path = envelopeParse.error.issues[0]?.path ?? [];
    return refuse("REQUEST_INVALID", ["request", "envelope", ...path.map(String)].join("."));
  }
  const envelope = envelopeParse.data;
  if (envelope.commitPolicy !== LOCAL_COMMIT) return refuse("COMMIT_POLICY_NO_COMMIT", "request.envelope.commitPolicy");

  const writer: unknown = fields["writer"];
  if (typeof writer !== "string") return refuse("REQUEST_INVALID", "request.writer");
  // The receipt's own verifier schema: a lowercase version 5 instance id and a
  // positive run, so the shape is the contract's and never a second copy.
  const verifierParse = VerificationReceipt.shape.verifier.safeParse(fields["verifier"]);
  if (!verifierParse.success) {
    const path = verifierParse.error.issues[0]?.path ?? [];
    return refuse("REQUEST_INVALID", ["request", "verifier", ...path.map(String)].join("."));
  }
  const verifier = verifierParse.data;
  // Independence is identity inequality and nothing more. A role restriction
  // would be shared vocabulary this module has no standing to invent.
  if (verifier.identity === writer) return refuse("VERIFIER_NOT_INDEPENDENT", "request.verifier.identity");

  let writerWorkerId: string;
  try {
    writerWorkerId = writerWorkerIdFor(fields["taskId"] as string, fields["attempt"] as number);
  } catch (error) {
    if (error instanceof LedgerValidationError) {
      return refuse("REQUEST_INVALID", "request." + (error.issues[0]?.path ?? "taskId"));
    }
    throw error;
  }
  // And inequality of instance: the label alone is the hole a renamed role
  // walks through.
  if (verifier.workerId === writerWorkerId) {
    return refuse("VERIFIER_NOT_INDEPENDENT", "request.verifier.workerId");
  }
  // One task: an envelope recorded for another task is not this receipt's authority.
  if (envelope.taskId !== fields["taskId"]) return refuse("REQUEST_INVALID", "request.envelope.taskId");

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
  // expired. `authorizedAt` is the canonical instant the authorization will
  // record, refused rather than normalized; the lease's own instant is the
  // `Lease` contract's, and the two are compared by epoch, never as strings.
  const authorizedAt = CanonicalInstant.safeParse(fields["authorizedAt"]);
  if (!authorizedAt.success) return refuse("REQUEST_INVALID", "request.authorizedAt");
  if (Date.parse(authorizedAt.data) >= Date.parse(lease.expiresAt)) {
    return refuse("LEASE_EXPIRED", "request.lease.expiresAt");
  }

  // The authority and the optional audit are shape-checked here, with the other
  // request guards, rather than at the point the events are built: an event whose
  // payload names no authority, or an `AUDIT_COMPLETED` whose fields are
  // `undefined`, would record that something happened while naming nobody.
  const authorizedBy = WorkerIdentityString.safeParse(fields["authorizedBy"]);
  if (!authorizedBy.success) return refuse("REQUEST_INVALID", "request.authorizedBy");
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
    declaredWriteSet: envelope.writeSet,
    observation: request.observation,
    lease: request.lease,
  });
  if (!conformance.ok) return carry(conformance);
  if (!conformance.conformant) return refuse("WRITE_SET_VIOLATION", "request.observation");

  // The base is projected, never re-asked. P6A validated `observation.head` as
  // `null` or an object id on the way through, so this is the observed fact
  // itself rather than a second claim about it. A `null` head is a repository
  // with no commit, and no receipt is issued over it (D-9).
  const baseSha = request.observation.head;
  if (baseSha === null) return refuse("BASE_HEAD_MISSING", "request.observation.head");

  // The writer id above is a derivation any caller could run. It names the
  // writer only where the transport ran the writer under it, and today that is
  // the Claude CLI session alone -- read from the attempt's recorded segments.
  const writerIdIssuer = writerIdIssuerFor(fields["routeSegments"] as AuthorizationRequest["routeSegments"]);
  if (writerIdIssuer === null || !WRITER_ID_ISSUERS.includes(writerIdIssuer)) {
    return refuse(WRITER_ID_UNISSUED, "request.routeSegments");
  }

  // The policy digest, recomputed from the envelope exactly as the verification runner
  // computes it: its three members and nothing else (P-17/A, ND-7).
  let policySha256: string;
  try {
    policySha256 = verificationPolicySha256({
      commands: envelope.validation.commands,
      independentVerifierRequired: envelope.validation.independentVerifierRequired,
      commitPolicy: envelope.commitPolicy,
    });
  } catch (error) {
    if (error instanceof LedgerValidationError) {
      return refuse("REQUEST_INVALID", "request.envelope." + (error.issues[0]?.path ?? "validation"));
    }
    throw error;
  }

  // The four body words, each by name before the receipt parse would fold them into
  // one `RECEIPT_INVALID` (execution §10.5; P-17/A B-3).
  const bodyRefusal = commitMessageBodyRefusal(fields["commitMessageBody"]);
  if (bodyRefusal !== null) return refuse(bodyRefusal, "request.commitMessageBody");

  const receipt = CommitAuthorizationReceipt.safeParse({
    contractVersion: CONTRACT_VERSION,
    taskId: request.taskId,
    revisionNumber: request.revisionNumber,
    attemptNumber: request.attemptNumber,
    baseSha,
    treeSha: request.treeSha,
    objectFormat: "sha1",
    policySha256,
    declaredWriteSet: [...envelope.writeSet],
    observedTrackedChanges: request.observation.trackedChanges.map((entry) => ({ ...entry })),
    observedUntrackedPaths: [...request.observation.untrackedPaths],
    writer: { identity: writer, workerId: writerWorkerId },
    verifier: { identity: verifier.identity, workerId: verifier.workerId, runId: verifier.runId },
    // Every recorded check exited zero above; this module builds only passing
    // receipts, and a failing run's receipt is P-16/C's runner's.
    runStatus: "PASS",
    checks: request.checks.map((check) => ({ ...check })),
    commitMessageBody: request.commitMessageBody,
    // Never anything else. A receipt cannot authorize a push, and this is the
    // only place the field is written.
    pushAuthorized: false,
  });
  if (!receipt.success) {
    const issue = receipt.error.issues[0];
    return refuse("RECEIPT_INVALID", "receipt." + (issue?.path ?? []).join("."));
  }
  const digest = receiptSha256(receipt.data);

  const events: AuthorizationEvent[] = [
    event("VERIFICATION_COMPLETED", {
      taskId: request.taskId,
      verifier: verifier.identity,
      checks: String(request.checks.length),
      receiptSha256: digest,
    }),
  ];
  if (auditor !== null) {
    events.push(
      event("AUDIT_COMPLETED", {
        taskId: request.taskId,
        auditor,
        verdict: auditVerdict,
        receiptSha256: digest,
      }),
    );
  }
  events.push(
    event("COMMIT_AUTHORIZED", {
      taskId: request.taskId,
      receiptSha256: digest,
      authorizedBy: authorizedBy.data,
    }),
  );

  return Object.freeze({
    ok: true as const,
    receipt: receipt.data,
    receiptSha256: digest,
    events: Object.freeze(events),
  });
}

// ---------------------------------------------------------------------------
// 2. The post-commit record
// ---------------------------------------------------------------------------

export interface RecordedCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  /** The message's exact bytes, as the object stores them: body plus trailer. */
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
 *
 * The first parent is the receipt's `baseSha`, with no exception: a root commit
 * has none and is refused. The message is compared, byte for byte, with the
 * receipt's body plus the one trailer that names the receipt (execution §10.5);
 * a message without the trailer is a difference, never a match.
 */
export function recordCommit(request: CommitRecordRequest): CommitRecordOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  const parsed = CommitAuthorizationReceipt.safeParse(fields["receipt"]);
  if (!parsed.success) return refuse("RECEIPT_INVALID", "request.receipt");
  const receipt = parsed.data;
  const digest = receiptSha256(receipt);

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
  // First parent only: a merge's second parent is not what the receipt was
  // taken against, and requiring equality there would refuse lawful merges.
  if (parents[0] !== receipt.baseSha) {
    return refuse("COMMIT_PARENT_MISMATCH", "request.commit.parents");
  }

  const message: unknown = recorded["message"];
  if (typeof message !== "string") return refuse("REQUEST_INVALID", "request.commit.message");
  if (message !== commitMessageWithReceiptTrailer(receipt.commitMessageBody, digest)) {
    return refuse("COMMIT_MESSAGE_MISMATCH", "request.commit.message");
  }

  return Object.freeze({
    ok: true as const,
    events: Object.freeze([
      event("COMMIT_RECORDED", {
        taskId: receipt.taskId,
        receiptSha256: digest,
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
