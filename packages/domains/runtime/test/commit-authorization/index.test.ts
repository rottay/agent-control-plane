import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  CommitAuthorizationReceipt,
  TaskEnvelope,
  VerificationReceipt,
  WRITER_ID_UNISSUED,
  buildIdempotencyKey,
  commitMessageWithReceiptTrailer,
} from "@acp/contracts";
import type { Lease, PathDigest } from "@acp/contracts";
import { computeOutboxCommandId, openLedger, receiptSha256, verificationPolicySha256, writerWorkerIdFor } from "@acp/ledger";

import { checkWriteSetConformance } from "../../src/enforcement/index.js";
import type { WorktreeObservation } from "../../src/enforcement/index.js";
import {
  AUTHORIZATION_REFUSALS,
  QUARANTINE_PHASE,
  QUARANTINE_TARGET_KIND,
  authorizeCommit,
  buildQuarantineBatch,
  quarantineWorktree,
  recordCommit,
  writerIdIssuerFor,
} from "../../src/commit-authorization/index.js";
import type {
  AuthorizationOutcome,
  AuthorizationRefused,
  AuthorizationRequest,
  CommitRecordOutcome,
  QuarantineBatchOutcome,
  QuarantineBatchRequest,
  QuarantineOutcome,
  QuarantineRecord,
} from "../../src/commit-authorization/index.js";

const NOW = "2026-08-29T12:00:00.000Z";
const WRITER = "claude/opus/implementer/01";
const VERIFIER = "claude/sonnet/verifier/01";
const AUTHORIZER = "kimi/k3/coordinator/01";
const WORKTREE = "/tmp/acp-p6c-drill";
const BASE = "0123456789abcdef0123456789abcdef01234567";
const CHILD = "fedcba9876543210fedcba9876543210fedcba98";
const A = "a".repeat(64);
const MESSAGE = "feat(runtime): a drill commit";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
/** A lowercase version 5 instance id for the verifier, other than any writer's. */
const VERIFIER_WORKER_ID = "24a8af45-549e-5137-8d27-03eb76de8b47";
const TREE = "89abcdef0123456789abcdef0123456789abcdef";
const INITIATIVE_ID = "44444444-4444-4444-8444-444444444444";
/** The attempt's recorded route: every segment the Claude CLI under a subscription (P-17/A). */
const CLI_SEGMENTS = [{ provider: "claude", transportKind: "CLI_SUBSCRIPTION" }] as const;

/**
 * The recorded envelope a request carries (P-17/A, ND-11): its write-set is the declared
 * one and its three policy members give the receipt's `policySha256`.
 */
function envelope(overrides: Record<string, unknown> = {}): TaskEnvelope {
  return TaskEnvelope.parse({
    contractVersion: CONTRACT_VERSION,
    taskId: TASK_ID,
    initiativeId: INITIATIVE_ID,
    title: MESSAGE,
    content: {
      contentContractVersion: 1,
      blocks: [
        {
          kind: "text",
          blockId: "b1",
          mediaType: "text/plain; charset=utf-8",
          byteLength: 11,
          contentSha256: "0".repeat(64),
          artifactRefId: null,
          text: "a drill run",
          toolCallId: null,
          effectId: null,
        },
      ],
    },
    classification: "MECHANICAL",
    issuedBy: AUTHORIZER,
    issuedAt: NOW,
    authority: [],
    readSet: [],
    writeSet: ["src/allowed.ts"],
    conflictKeys: [],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "a drill diff" },
    validation: { commands: ["pnpm check"], independentVerifierRequired: true },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 10_000, maxWallClockSeconds: 600, reserveTokensForCheckpoint: 1_000 },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 5 },
    ...overrides,
  });
}

/** The policy digest recomputed from the envelope's three members, as the runner does. */
const POLICY = verificationPolicySha256({
  commands: ["pnpm check"],
  independentVerifierRequired: true,
  commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
});

function lease(overrides: Partial<Lease> = {}): Lease {
  return {
    leaseId: "11111111-1111-4111-8111-111111111111",
    worktreePath: WORKTREE,
    holder: WRITER,
    acquiredAt: "2026-08-29T11:00:00.000Z",
    expiresAt: "2026-08-29T13:00:00.000Z",
    ...overrides,
  };
}

function digest(path: string, sha256: string): PathDigest {
  return { path, sha256 };
}

function observation(overrides: Partial<WorktreeObservation> = {}): WorktreeObservation {
  return {
    head: BASE,
    trackedChanges: [digest("src/allowed.ts", A)],
    untrackedPaths: [],
    ...overrides,
  };
}

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  const taskId = overrides.taskId ?? TASK_ID;
  return {
    taskId,
    revisionNumber: 1,
    attemptNumber: 1,
    attempt: 1,
    writer: WRITER,
    routeSegments: CLI_SEGMENTS,
    // The envelope is the task's own; a task id the envelope contract refuses keeps the fixture's.
    envelope: envelope(typeof taskId === "string" && taskId.length > 0 ? { taskId } : {}),
    verifier: { identity: VERIFIER, workerId: VERIFIER_WORKER_ID, runId: 1 },
    authorizedBy: AUTHORIZER,
    authorizedAt: NOW,
    worktreePath: WORKTREE,
    lease: lease(),
    observation: observation(),
    treeSha: TREE,
    checks: [{ command: "pnpm check", exitCode: 0, ranAt: NOW }],
    ...overrides,
  };
}

/** A request whose recorded envelope carries `title` as its message body (P-17/B, ND-3). */
function titled(title: string): AuthorizationRequest {
  return request({ envelope: TaskEnvelope.parse({ ...envelope(), title }) });
}

/** A request with keys the v2 type does not have, for the closed-key-set cases. */
function requestWith(extra: Record<string, unknown>): AuthorizationRequest {
  return { ...request(), ...extra } as AuthorizationRequest;
}

function refusal(
  outcome: AuthorizationOutcome | CommitRecordOutcome | QuarantineOutcome | QuarantineBatchOutcome,
): AuthorizationRefused {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

describe("the authorization decision", () => {
  // (d)
  it("builds a receipt the contract itself accepts, and names it by the ledger's digest", () => {
    const out = authorizeCommit(request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(CommitAuthorizationReceipt.safeParse(out.receipt).success).toBe(true);
    expect(VerificationReceipt.safeParse(out.receipt).success).toBe(true);
    expect(out.receipt.pushAuthorized).toBe(false);
    expect(out.receipt.runStatus).toBe("PASS");
    expect(out.receipt.objectFormat).toBe("sha1");
    expect(out.receipt.treeSha).toBe(TREE);
    expect(out.receipt.policySha256).toBe(POLICY);
    expect(out.receipt.commitMessageBody).toBe(MESSAGE);
    expect(out.receiptSha256).toBe(receiptSha256(out.receipt));
    expect(out.events.map((e) => e.type)).toEqual([
      "VERIFICATION_COMPLETED",
      "COMMIT_AUTHORIZED",
    ]);
    // The payloads name the receipt by its digest; there is no receipt id.
    for (const candidate of out.events) {
      expect(candidate.payload["receiptSha256"]).toBe(out.receiptSha256);
      expect(Object.keys(candidate.payload)).not.toContain("receiptId");
    }
    expect(out.events[1]?.payload).toEqual({
      taskId: TASK_ID,
      receiptSha256: out.receiptSha256,
      authorizedBy: AUTHORIZER,
    });
  });

  it("emits AUDIT_COMPLETED only when an audit was performed", () => {
    const audited = authorizeCommit(request({ audit: { auditor: VERIFIER, verdict: "ACCEPT" } }));
    expect(audited.ok && audited.events.map((e) => e.type)).toEqual([
      "VERIFICATION_COMPLETED",
      "AUDIT_COMPLETED",
      "COMMIT_AUTHORIZED",
    ]);
  });

  // (a)
  it("refuses a receipt whose verifier is its own writer", () => {
    const out = authorizeCommit(
      request({ verifier: { identity: WRITER, workerId: VERIFIER_WORKER_ID, runId: 1 } }),
    );
    expect(refusal(out).reason).toBe("VERIFIER_NOT_INDEPENDENT");
    expect(refusal(out).at).toBe("request.verifier.identity");
  });

  // D-2: the plane fills the writer's instance id.
  it("fills the writer's instance id from the task and its flat attempt", () => {
    const out = authorizeCommit(request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.receipt.writer).toEqual({ identity: WRITER, workerId: writerWorkerIdFor(TASK_ID, 1) });

    // The Claude session name's first external vector (providers' suite,
    // Python `uuid.uuid5`): the writer id is the id the CLI ran under.
    const vector = authorizeCommit(request({ taskId: "00000000-0000-4000-8000-00000000000a" }));
    expect(vector.ok && vector.receipt.writer.workerId).toBe("39de475b-2696-5df6-b64b-88336de7d72c");

    // The flat attempt is the input, never the per-revision number.
    const second = authorizeCommit(
      request({ taskId: "00000000-0000-4000-8000-00000000000a", attempt: 2, revisionNumber: 2, attemptNumber: 1 }),
    );
    expect(second.ok && second.receipt.writer.workerId).toBe("796cc136-89af-53a4-b947-3d0609c12f60");
    expect(second.ok && second.receipt.attemptNumber).toBe(1);
  });

  it("refuses a verifier whose instance is the writer's, under another label", () => {
    const out = authorizeCommit(
      request({ verifier: { identity: VERIFIER, workerId: writerWorkerIdFor(TASK_ID, 1), runId: 1 } }),
    );
    expect(refusal(out).reason).toBe("VERIFIER_NOT_INDEPENDENT");
    expect(refusal(out).at).toBe("request.verifier.workerId");
  });

  it("parses the verifier before it compares: a malformed or uppercase id is REQUEST_INVALID (B-3)", () => {
    for (const [label, verifier, at] of [
      ["uppercase", { identity: VERIFIER, workerId: VERIFIER_WORKER_ID.toUpperCase(), runId: 1 }, "request.verifier.workerId"],
      [
        "the writer's own id in uppercase",
        { identity: VERIFIER, workerId: writerWorkerIdFor(TASK_ID, 1).toUpperCase(), runId: 1 },
        "request.verifier.workerId",
      ],
      ["a v4 id", { identity: VERIFIER, workerId: "11111111-1111-4111-8111-111111111111", runId: 1 }, "request.verifier.workerId"],
      ["run zero", { identity: VERIFIER, workerId: VERIFIER_WORKER_ID, runId: 0 }, "request.verifier.runId"],
      ["a label", VERIFIER, "request.verifier"],
      ["an extra key", { identity: VERIFIER, workerId: VERIFIER_WORKER_ID, runId: 1, pid: 7 }, "request.verifier"],
    ] as const) {
      const out = authorizeCommit(request({ verifier: verifier as never }));
      expect({ label, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        label,
        reason: "REQUEST_INVALID",
        at,
      });
    }
  });

  it("refuses a task id or a flat attempt the writer id cannot be derived from", () => {
    for (const [override, at] of [
      [{ taskId: "" }, "request.taskId"],
      [{ attempt: 0 }, "request.attempt"],
      [{ attempt: 1.5 }, "request.attempt"],
      [{ attempt: "1" as never }, "request.attempt"],
    ] as const) {
      const run = (): AuthorizationOutcome => authorizeCommit(request(override));
      expect(run).not.toThrow();
      expect({ reason: refusal(run()).reason, at: refusal(run()).at }).toEqual({ reason: "REQUEST_INVALID", at });
    }
  });

  // ND-11: the request's key set is closed.
  it("refuses any key outside the v2 request by its own path, V1 keys and writer ids included", () => {
    for (const [key, value] of [
      ["initialCommit", true],
      ["initialCommit", false],
      ["receiptId", "22222222-2222-4222-8222-222222222222"],
      ["branch", "main"],
      ["commitMessage", MESSAGE],
      ["writerWorkerId", VERIFIER_WORKER_ID],
      ["baseHead", BASE],
      ["surprise", 1],
    ] as const) {
      const out = authorizeCommit(requestWith({ [key]: value }));
      expect({ key, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        key,
        reason: "REQUEST_INVALID",
        at: "request." + key,
      });
    }
    // A writer supplied as an object carrying its own id is not a label.
    const asObject = authorizeCommit(
      requestWith({ writer: { identity: WRITER, workerId: writerWorkerIdFor(TASK_ID, 1) } }),
    );
    expect(refusal(asObject).reason).toBe("REQUEST_INVALID");
    expect(refusal(asObject).at).toBe("request.writer");
  });

  // (b)
  it("refuses a nonzero check and names it", () => {
    const out = authorizeCommit(request({
      checks: [
        { command: "pnpm check", exitCode: 0, ranAt: NOW },
        { command: "pnpm test", exitCode: 1, ranAt: NOW },
      ],
    }));
    expect(refusal(out).reason).toBe("CHECK_FAILED");
    expect(refusal(out).at).toBe("request.checks[1]");
  });

  // P-16/A2 verification N-1: `-0` passes `!== 0`, so the contract refuses it
  // before anything is hashed; the function returns, and never throws.
  it("refuses a negative-zero exit code as the contract's, rather than throwing", () => {
    const req = request({ checks: [{ command: "pnpm check", exitCode: -0, ranAt: NOW }] });
    const run = (): AuthorizationOutcome => authorizeCommit(req);
    expect(run).not.toThrow();
    expect(refusal(run()).reason).toBe("RECEIPT_INVALID");
    expect(refusal(run()).at).toBe("receipt.checks.0.exitCode");
  });

  // (j)
  it("refuses an empty check list by name, not as a parser issue", () => {
    const out = authorizeCommit(request({ checks: [] }));
    expect(refusal(out).reason).toBe("CHECKS_MISSING");
    expect(refusal(out).at).toBe("request.checks");
  });

  // (c)
  it("refuses an observation outside the declared write-set", () => {
    const out = authorizeCommit(request({
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
    }));
    expect(refusal(out).reason).toBe("WRITE_SET_VIOLATION");
  });

  // (g) D-9: there is no initial-commit receipt.
  it("refuses a null observed head: no receipt is issued without a base", () => {
    const out = authorizeCommit(request({ observation: observation({ head: null }) }));
    expect(refusal(out).reason).toBe("BASE_HEAD_MISSING");
    expect(refusal(out).at).toBe("request.observation.head");
  });

  // (n) C1: one base authority -- the receipt projects the observed head.
  it("takes the receipt's base from the observation, not a second input", () => {
    const out = authorizeCommit(request({ observation: observation({ head: CHILD }) }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.receipt.baseSha).toBe(CHILD);
    expect(Object.keys(request())).not.toContain("baseSha");
  });

  // ND-10, since P-17/A read from the recorded segments: a writer transport with no id
  // issuer is refused by name, at the segments.
  it("refuses a writer transport that issues no writer id, read from the recorded segments", () => {
    for (const segments of [
      [],
      [{ provider: "claude", transportKind: "API_KEY" }],
      [{ provider: "claude", transportKind: "LOCAL_OR_SELF_HOSTED" }],
      [{ provider: "codex", transportKind: "CLI_SUBSCRIPTION" }],
      [...CLI_SEGMENTS, { provider: "claude", transportKind: "API_KEY" }],
      [{ provider: "claude" }],
      "CLAUDE_CLI_SESSION",
      7,
    ] as const) {
      const out = authorizeCommit(requestWith({ routeSegments: segments }));
      expect({ segments, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        segments,
        reason: WRITER_ID_UNISSUED,
        at: "request.routeSegments",
      });
    }
    const absent = { ...request() } as Record<string, unknown>;
    delete absent["routeSegments"];
    expect(refusal(authorizeCommit(absent as never)).reason).toBe("WRITER_ID_UNISSUED");
    expect(authorizeCommit(request({ routeSegments: [...CLI_SEGMENTS, ...CLI_SEGMENTS] })).ok).toBe(true);
  });

  // P-17/A (ND-11 (a), A7): the issuer, the policy and the declared write-set are read,
  // never supplied -- a caller that names one is refused at its path.
  it("refuses a request that supplies the issuer, the policy digest or the declared write-set", () => {
    for (const [key, value] of [
      ["writerIdIssuer", "CLAUDE_CLI_SESSION"],
      ["policySha256", POLICY],
      ["declaredWriteSet", ["src/allowed.ts"]],
    ] as const) {
      const out = authorizeCommit(requestWith({ [key]: value }));
      expect({ key, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        key,
        reason: "REQUEST_INVALID",
        at: "request." + key,
      });
    }
  });

  // P-17/A (P6, ND-7): the receipt's policy is the envelope's, recomputed as the runner does.
  it("computes the receipt's policy digest from the envelope's three members, and its write-set from the envelope", () => {
    const out = authorizeCommit(request());
    expect(out.ok && out.receipt.policySha256).toBe(POLICY);
    expect(out.ok && out.receipt.declaredWriteSet).toEqual(["src/allowed.ts"]);
    const other = authorizeCommit(
      request({
        envelope: envelope({ validation: { commands: ["pnpm check", "pnpm lint"], independentVerifierRequired: false } }),
      }),
    );
    expect(other.ok && other.receipt.policySha256).toBe(
      verificationPolicySha256({
        commands: ["pnpm check", "pnpm lint"],
        independentVerifierRequired: false,
        commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      }),
    );
    expect(other.ok && other.receipt.policySha256).not.toBe(POLICY);
  });

  // P-17/A (B-4, N12): a NO_COMMIT envelope is refused by name, before independence.
  it("refuses a NO_COMMIT envelope by name, before anything else is judged", () => {
    const out = authorizeCommit(
      request({
        envelope: envelope({ commitPolicy: "NO_COMMIT" }),
        verifier: { identity: WRITER, workerId: VERIFIER_WORKER_ID, runId: 1 },
      }),
    );
    expect({ reason: refusal(out).reason, at: refusal(out).at }).toEqual({
      reason: "COMMIT_POLICY_NO_COMMIT",
      at: "request.envelope.commitPolicy",
    });
    const malformed = authorizeCommit(requestWith({ envelope: { ...envelope(), commitPolicy: "PUSH" } }));
    expect({ reason: refusal(malformed).reason, at: refusal(malformed).at }).toEqual({
      reason: "REQUEST_INVALID",
      at: "request.envelope.commitPolicy",
    });
    const absent = { ...request() } as Record<string, unknown>;
    delete absent["envelope"];
    expect(refusal(authorizeCommit(absent as never)).reason).toBe("REQUEST_INVALID");
    const otherTask = authorizeCommit(request({ envelope: envelope({ taskId: "55555555-5555-4555-8555-555555555555" }) }));
    expect({ reason: refusal(otherTask).reason, at: refusal(otherTask).at }).toEqual({
      reason: "REQUEST_INVALID",
      at: "request.envelope.taskId",
    });
  });

  // P-17/A (ND-11, B-3, N12): the four body words, each by name before the receipt parse.
  // P-17/B (ND-3, E2): the body is the recorded envelope's title, so the words land at
  // `request.envelope.title`, and a request that names a body is refused at its key.
  it("names each of the body refusals at the envelope's title, before the receipt parse", () => {
    for (const [body, reason] of [
      [MESSAGE + "\n", "COMMIT_MESSAGE_BODY_ENDS_IN_LF"],
      ["feat: x\r\nmore", "COMMIT_MESSAGE_BODY_HOLDS_CR"],
      [MESSAGE + "\n\nACP-Receipt: " + A, "COMMIT_MESSAGE_BODY_HOLDS_TRAILER"],
      ["ACP-Receipt: " + A, "COMMIT_MESSAGE_BODY_HOLDS_TRAILER"],
    ] as const) {
      const out = authorizeCommit(titled(body));
      expect({ body, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        body,
        reason,
        at: "request.envelope.title",
      });
    }
    // An empty title is not an envelope: the contract refuses it before the body words,
    // so COMMIT_MESSAGE_BODY_EMPTY stays in the vocabulary and is unreachable here.
    const empty = authorizeCommit(requestWith({ envelope: { ...envelope(), title: "" } }));
    expect({ reason: refusal(empty).reason, at: refusal(empty).at }).toEqual({ reason: "REQUEST_INVALID", at: "request.envelope.title" });
    // The boundary is the envelope's now: 200 characters is a title and a body, 201 is not an envelope.
    expect(authorizeCommit(titled("x".repeat(200))).ok).toBe(true);
    const long = authorizeCommit(requestWith({ envelope: { ...envelope(), title: "x".repeat(201) } }));
    expect({ reason: refusal(long).reason, at: refusal(long).at }).toEqual({ reason: "REQUEST_INVALID", at: "request.envelope.title" });
    // A trailer key inside a line, not at its start, is a body.
    expect(authorizeCommit(titled("feat: mention ACP-Receipt: inline")).ok).toBe(true);
    // E2: the key is gone from the request; a caller that still supplies a body is refused at it.
    const supplied = authorizeCommit(requestWith({ commitMessageBody: MESSAGE }));
    expect({ reason: refusal(supplied).reason, at: refusal(supplied).at }).toEqual({ reason: "REQUEST_INVALID", at: "request.commitMessageBody" });
  });

  // (p) N1: a composed refusal is carried, not flattened.
  it("carries an inner conformance refusal's own reason and path", () => {
    // Since P-17/A the declared write-set is the envelope's, and the envelope contract
    // admits no committing packet with an empty one: that request never reaches
    // conformance, and is refused as the envelope it is.
    const empty = authorizeCommit(requestWith({ envelope: { ...envelope(), writeSet: [] } }));
    expect(refusal(empty).reason).toBe("REQUEST_INVALID");
    expect(refusal(empty).at).toBe("request.envelope.commitPolicy");

    const badLease = authorizeCommit(
      request({ lease: { ...lease(), leaseId: "not-a-uuid" } }),
    );
    expect(refusal(badLease).reason).toBe("REQUEST_INVALID");
    expect(refusal(badLease).at).toBe("request.lease");

    const badHead = authorizeCommit(request({ observation: observation({ head: "nope" }) }));
    expect(refusal(badHead).reason).toBe("OBSERVATION_INVALID");
    expect(refusal(badHead).at).toBe("request.observation.head");
  });

  // (q) C2: the optional audit is a shape, not a hope.
  it("refuses a malformed audit before emitting AUDIT_COMPLETED", () => {
    for (const [label, audit, at] of [
      ["not an object", "yes", "request.audit"],
      ["auditor not an identity", { auditor: "nope", verdict: "ACCEPT" }, "request.audit.auditor"],
      ["verdict empty", { auditor: VERIFIER, verdict: "" }, "request.audit.verdict"],
    ] as const) {
      const run = (): AuthorizationOutcome =>
        authorizeCommit(request({ audit: audit as never }));
      expect(run).not.toThrow();
      const out = run();
      expect({ label, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        label,
        reason: "REQUEST_INVALID",
        at,
      });
    }
  });

  // (k)
  it("carries the contract parser's refusal for a malformed receipt member", () => {
    // `treeSha` is a member no earlier guard reads, so the contract's own parser is
    // what refuses it, and its path is carried out unchanged. (`policySha256` was the
    // example before P-17/A; it is computed now, never supplied.)
    const tree = authorizeCommit(request({ treeSha: "B".repeat(40) }));
    expect(refusal(tree).reason).toBe("RECEIPT_INVALID");
    expect(refusal(tree).at).toBe("receipt.treeSha");

    // A body with a trailer is a receipt the authorization would refuse, so it
    // is never issued -- refused by its own word since P-17/A, before the parse,
    // at the envelope's title since P-17/B.
    const trailered = authorizeCommit(titled(MESSAGE + "\n\nACP-Receipt: " + A));
    expect(refusal(trailered).reason).toBe("COMMIT_MESSAGE_BODY_HOLDS_TRAILER");
    expect(refusal(trailered).at).toBe("request.envelope.title");

    // The authority is not a receipt member any more: refused as the request's.
    const authority = authorizeCommit(request({ authorizedBy: "not-an-identity" }));
    expect(refusal(authority).reason).toBe("REQUEST_INVALID");
    expect(refusal(authority).at).toBe("request.authorizedBy");

    // A malformed `writer` is caught earlier and more specifically: no lease
    // can be held by a non-identity, so the holder binding refuses first.
    const badWriter = authorizeCommit(request({ writer: "not-an-identity" }));
    expect(refusal(badWriter).reason).toBe("LEASE_HOLDER_MISMATCH");
  });

  it("grants a body git would rewrite or refuse, a limit the writer meets (ADR 0121 Six, ADR 0126, ADR 0127)", () => {
    // Pinned so the limit is visible, not endorsed. P-17/A named the four body words
    // of execution §10.5 and no others. P-17/B's writer meets both: `commit-tree`
    // reads its stdin with no cleanup, so trailing whitespace is written as given,
    // and a NUL, which Git refuses, is `GIT_WRITER_COMMIT_FAILED` (ND-13).
    for (const body of ["feat: x  ", "feat: x\u0000y"]) {
      const out = authorizeCommit(titled(body));
      expect(out.ok, JSON.stringify(body)).toBe(true);
      if (!out.ok) return;
      expect(out.receipt.commitMessageBody).toBe(body);
    }
  });

  // (h)
  it("refuses malformed input rather than throwing", () => {
    for (const [label, req, reason] of [
      ["null request", null, "REQUEST_INVALID"],
      ["checks not an array", { ...request(), checks: "no" }, "REQUEST_INVALID"],
      ["writer not a string", { ...request(), writer: 7 }, "REQUEST_INVALID"],
      ["verifier absent", { ...request(), verifier: undefined }, "REQUEST_INVALID"],
    ] as const) {
      const run = (): AuthorizationOutcome => authorizeCommit(req as never);
      expect(run).not.toThrow();
      expect({ label, reason: refusal(run()).reason }).toEqual({ label, reason });
    }
  });

  // (i)
  it("is deterministic and frozen", () => {
    const one = authorizeCommit(request());
    const two = authorizeCommit(request());
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(one.events)).toBe(true);
    for (const candidate of one.events) {
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.payload)).toBe(true);
    }
  });

  it("closes its refusal set", () => {
    expect([...AUTHORIZATION_REFUSALS]).toEqual([...AUTHORIZATION_REFUSALS].sort());
    expect(new Set(AUTHORIZATION_REFUSALS).size).toBe(AUTHORIZATION_REFUSALS.length);
    // P-16/A2: WRITER_ID_UNISSUED joins; BASE_HEAD_MISMATCH leaves with the
    // bootstrap claim it answered. P-17/A: the four body words and
    // COMMIT_POLICY_NO_COMMIT join (14 -> 19).
    expect([...AUTHORIZATION_REFUSALS]).toEqual([
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
      "WRITER_ID_UNISSUED",
      "WRITE_SET_VIOLATION",
    ]);
  });
});

describe("the post-commit record", () => {
  function granted(overrides: Partial<AuthorizationRequest> = {}) {
    const out = authorizeCommit(request(overrides));
    if (!out.ok) throw new Error("fixture authorization refused: " + out.reason);
    return out;
  }

  /** The message an authorized commit carries: the body and the one trailer. */
  function messageFor(out: { readonly receiptSha256: string }): string {
    return commitMessageWithReceiptTrailer(MESSAGE, out.receiptSha256);
  }

  it("records a commit whose message is exactly the body plus the trailer", () => {
    const out = granted();
    const message = messageFor(out);
    expect(message).toBe(MESSAGE + "\n\nACP-Receipt: " + out.receiptSha256 + "\n");
    const recorded = recordCommit({
      receipt: out.receipt,
      commit: { sha: CHILD, parents: [BASE], message },
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.events.map((e) => e.type)).toEqual(["COMMIT_RECORDED"]);
    expect(recorded.events[0]?.payload).toEqual({ taskId: TASK_ID, receiptSha256: out.receiptSha256, sha: CHILD });
  });

  it("refuses a message without its trailer, with another digest, or with other bytes", () => {
    const out = granted();
    const other = receiptSha256(granted({ envelope: TaskEnvelope.parse({ ...envelope(), title: "feat(runtime): another" }) }).receipt);
    expect(other).not.toBe(out.receiptSha256);
    for (const [label, message] of [
      ["body only", MESSAGE],
      ["body and LF", MESSAGE + "\n"],
      ["another receipt's trailer", commitMessageWithReceiptTrailer(MESSAGE, other)],
      ["CRLF", MESSAGE + "\r\n\r\nACP-Receipt: " + out.receiptSha256 + "\r\n"],
      ["no final LF", MESSAGE + "\n\nACP-Receipt: " + out.receiptSha256],
      ["uppercase digest", MESSAGE + "\n\nACP-Receipt: " + out.receiptSha256.toUpperCase() + "\n"],
      ["something else", "something else"],
    ] as const) {
      const recorded = recordCommit({ receipt: out.receipt, commit: { sha: CHILD, parents: [BASE], message } });
      expect({ label, reason: refusal(recorded).reason }).toEqual({ label, reason: "COMMIT_MESSAGE_MISMATCH" });
    }
  });

  // (l)
  it("refuses a first parent that is not the receipt's baseSha", () => {
    const out = granted();
    const recorded = recordCommit({
      receipt: out.receipt,
      commit: { sha: CHILD, parents: [CHILD], message: messageFor(out) },
    });
    expect(refusal(recorded).reason).toBe("COMMIT_PARENT_MISMATCH");
  });

  it("refuses a root commit: no parent is never the base (D-9)", () => {
    const out = granted();
    const recorded = recordCommit({
      receipt: out.receipt,
      commit: { sha: CHILD, parents: [], message: messageFor(out) },
    });
    expect(refusal(recorded).reason).toBe("COMMIT_PARENT_MISMATCH");
    expect(refusal(recorded).at).toBe("request.commit.parents");
  });

  it("accepts a merge whose first parent is the baseSha", () => {
    // A merge's second parent is not what the receipt was taken against;
    // requiring equality there would refuse a lawful merge.
    const out = granted();
    const recorded = recordCommit({
      receipt: out.receipt,
      commit: { sha: CHILD, parents: [BASE, CHILD], message: messageFor(out) },
    });
    expect(recorded.ok).toBe(true);
  });

  it("refuses a malformed sha, and a receipt that is not an authorizing one", () => {
    const out = granted();
    expect(
      refusal(recordCommit({
        receipt: out.receipt,
        commit: { sha: "nope", parents: [BASE], message: messageFor(out) },
      })).reason,
    ).toBe("COMMIT_SHA_INVALID");
    // A FAIL receipt parses as a verification and never authorizes a commit.
    const failed = { ...out.receipt, runStatus: "FAIL" as const };
    expect(VerificationReceipt.safeParse(failed).success).toBe(true);
    expect(
      refusal(recordCommit({
        receipt: failed as never,
        commit: { sha: CHILD, parents: [BASE], message: messageFor(out) },
      })).reason,
    ).toBe("RECEIPT_INVALID");
  });

  it("refuses malformed input rather than throwing", () => {
    const run = (): CommitRecordOutcome => recordCommit(null as never);
    expect(run).not.toThrow();
    expect(refusal(run()).reason).toBe("REQUEST_INVALID");
  });
});

describe("quarantine", () => {
  function violation() {
    const verdict = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
      lease: lease(),
    });
    if (!verdict.ok) throw new Error("fixture conformance refused");
    return verdict;
  }

  // (e)
  it("records the violation with no field in which a cleanup could be written", () => {
    const out = quarantineWorktree({
      verdict: violation(),
      lease: lease(),
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
      taskId: "33333333-3333-4333-8333-333333333333",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.recommendedTaskState).toBe("SUSPECT_WORKTREE");
    expect([...out.record.violatingPaths]).toEqual(["src/sneaked-in.ts"]);
    expect(out.record.events.map((e) => e.type)).toEqual(["TASK_STATE_CHANGED"]);
    // The exact key set: adding a cleanup field would be a visible change.
    expect(Object.keys(out.record).sort()).toEqual([
      "events",
      "evidence",
      "holder",
      "leaseId",
      "recommendedTaskState",
      "violatingPaths",
      "worktreePath",
    ]);
  });

  // (m)
  it("produces the same record from P6A's verdict as from this module's inputs", () => {
    // Left: the verdict a P6A caller computes for itself.
    const fromP6A = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
      lease: lease(),
    });
    // Right: the verdict this module composes, drawn from an authorization
    // request rather than hand-written -- the same three fields, and the same
    // function, because the module composes P6A instead of re-deciding.
    const req = request({
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
    });
    const fromThisModule = checkWriteSetConformance({
      declaredWriteSet: req.envelope.writeSet,
      observation: req.observation,
      lease: req.lease,
    });
    // The authorization refuses over exactly that composition.
    expect(refusal(authorizeCommit(req)).reason).toBe("WRITE_SET_VIOLATION");
    if (!fromP6A.ok || !fromThisModule.ok) throw new Error("fixture conformance refused");

    const shared = {
      lease: lease(),
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
      taskId: "33333333-3333-4333-8333-333333333333",
    };
    const left = quarantineWorktree({ verdict: fromP6A, ...shared });
    const right = quarantineWorktree({ verdict: fromThisModule, ...shared });
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(left.ok).toBe(true);
  });

  it("refuses to quarantine a conformant worktree", () => {
    const clean = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation(),
      lease: lease(),
    });
    if (!clean.ok) throw new Error("fixture conformance refused");
    const out = quarantineWorktree({
      verdict: clean,
      lease: lease(),
      observation: observation(),
      taskId: "33333333-3333-4333-8333-333333333333",
    });
    expect(refusal(out).at).toBe("request.verdict.conformant");
  });

  it("refuses malformed input rather than throwing", () => {
    const run = (): QuarantineOutcome => quarantineWorktree(null as never);
    expect(run).not.toThrow();
    expect(refusal(run()).reason).toBe("REQUEST_INVALID");
  });

  // (r) C2: the boundary guards, over the four probed shapes.
  it("guards every field the record is built from, and never throws", () => {
    const base = {
      verdict: violation(),
      lease: lease(),
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
      taskId: "33333333-3333-4333-8333-333333333333",
    };
    for (const [label, overrides, at] of [
      // A verdict without its violations: previously a TypeError.
      ["verdict without violations", { verdict: { conformant: false } }, "request.verdict.violations"],
      // An observation without its tracked changes: previously a TypeError.
      ["observation without changes", { observation: {} }, "request.observation.trackedChanges"],
      // A lease that is not a lease: previously a record of undefineds.
      ["lease not a lease", { lease: "nope" }, "request.lease"],
      // A lease that is not the one the verdict revoked: previously a record
      // naming the wrong worktree.
      [
        "lease is not the verdict's",
        { lease: lease({ leaseId: "44444444-4444-4444-8444-444444444444" }) },
        "request.lease",
      ],
    ] as const) {
      const run = (): QuarantineOutcome =>
        quarantineWorktree({ ...base, ...overrides } as never);
      expect(run).not.toThrow();
      const out = run();
      expect({ label, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        label,
        reason: "REQUEST_INVALID",
        at,
      });
    }
  });

  it("refuses a tracked change that is not a path digest", () => {
    const out = quarantineWorktree({
      verdict: violation(),
      lease: lease(),
      observation: observation({
        trackedChanges: [{ path: "src/allowed.ts", sha256: "short" }] as never,
        untrackedPaths: ["src/sneaked-in.ts"],
      }),
      taskId: "33333333-3333-4333-8333-333333333333",
    });
    expect(refusal(out).at).toBe("request.observation.trackedChanges[0]");
  });
});

describe("the lease binds the writer, the worktree and the moment", () => {
  // (s) F3: a lease held by someone else authorizes nothing.
  it("refuses a lease whose holder is not the writer", () => {
    const out = authorizeCommit(request({ lease: lease({ holder: "claude/sonnet/verifier/01" }) }));
    expect(refusal(out).reason).toBe("LEASE_HOLDER_MISMATCH");
    expect(refusal(out).at).toBe("request.lease.holder");
  });

  // (t) F3: nor one taken on a different tree.
  it("refuses a lease on a different worktree", () => {
    const out = authorizeCommit(request({ lease: lease({ worktreePath: "/tmp/acp-elsewhere" }) }));
    expect(refusal(out).reason).toBe("LEASE_WORKTREE_MISMATCH");
    expect(refusal(out).at).toBe("request.lease.worktreePath");
  });

  it("refuses a malformed lease rather than throwing", () => {
    const run = (): AuthorizationOutcome => authorizeCommit(request({ lease: "nope" as never }));
    expect(run).not.toThrow();
    expect(refusal(run()).reason).toBe("REQUEST_INVALID");
    expect(refusal(run()).at).toBe("request.lease");
  });

  // (u) C5: an expired lease of the right holder on the right tree.
  it("refuses a lease that has expired at the moment of authorization", () => {
    const expired = authorizeCommit(
      request({ lease: lease({ expiresAt: "2026-08-29T11:30:00.000Z" }) }),
    );
    expect(refusal(expired).reason).toBe("LEASE_EXPIRED");
    expect(refusal(expired).at).toBe("request.lease.expiresAt");

    // The instant of expiry is expired: `authorizedAt >= expiresAt`, the same
    // rule P6A's `isLive` uses.
    const exactly = authorizeCommit(request({ lease: lease({ expiresAt: NOW }) }));
    expect(refusal(exactly).reason).toBe("LEASE_EXPIRED");

    // And the comparison is by instant: the same moment in another offset is
    // still the same moment.
    const offset = authorizeCommit(
      request({ lease: lease({ expiresAt: "2026-08-29T14:00:00.000+02:00" }) }),
    );
    expect(refusal(offset).reason).toBe("LEASE_EXPIRED");
  });

  it("refuses an authorizedAt that is not an instant", () => {
    const run = (): AuthorizationOutcome => authorizeCommit(request({ authorizedAt: "noon" }));
    expect(run).not.toThrow();
    expect(refusal(run()).reason).toBe("REQUEST_INVALID");
    expect(refusal(run()).at).toBe("request.authorizedAt");
  });

  // N-6: `authorizedAt` is the future `authorized_at`, a canonical instant; an
  // offset spelling of a live moment is refused, never normalized.
  it("refuses an authorizedAt that is an instant but not the canonical one", () => {
    for (const spelling of ["2026-08-29T14:00:00.000+02:00", "2026-08-29T12:00:00Z", "2026-08-29T12:00:00.000z"]) {
      const out = authorizeCommit(request({ authorizedAt: spelling }));
      expect({ spelling, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        spelling,
        reason: "REQUEST_INVALID",
        at: "request.authorizedAt",
      });
    }
  });

  it("keeps its refusal set closed after the new codes", () => {
    expect([...AUTHORIZATION_REFUSALS]).toEqual([...AUTHORIZATION_REFUSALS].sort());
    for (const code of ["LEASE_EXPIRED", "LEASE_HOLDER_MISMATCH", "LEASE_WORKTREE_MISMATCH"]) {
      expect(AUTHORIZATION_REFUSALS).toContain(code);
    }
  });
});

describe("the writer id issuer, produced from an attempt's recorded route segments (P-16/C)", () => {
  const cli = { provider: "claude", transportKind: "CLI_SUBSCRIPTION" };

  it("P5: every segment the Claude CLI under a subscription issues CLAUDE_CLI_SESSION", () => {
    expect(writerIdIssuerFor([cli])).toBe("CLAUDE_CLI_SESSION");
    // A handoff that stays on the one issuing route still issues.
    expect(writerIdIssuerFor([cli, { ...cli }])).toBe("CLAUDE_CLI_SESSION");
    // Since P-17/A the authorization asks this producer itself, over the segments.
    expect(authorizeCommit(request({ routeSegments: [cli] })).ok).toBe(true);
  });

  it("N4: no segment, another transport, another provider, or a mixed handoff issues nothing", () => {
    const cases: readonly (readonly { provider: unknown; transportKind: unknown }[])[] = [
      [],
      [{ provider: "claude", transportKind: "API_KEY" }],
      [{ provider: "claude", transportKind: "LOCAL_OR_SELF_HOSTED" }],
      [{ provider: "codex", transportKind: "CLI_SUBSCRIPTION" }],
      [cli, { provider: "codex", transportKind: "CLI_SUBSCRIPTION" }],
      [{ provider: "claude", transportKind: "API_KEY" }, cli],
      [{ provider: "Claude", transportKind: "CLI_SUBSCRIPTION" }],
      [{ provider: "claude", transportKind: "cli_subscription" }],
      [{ provider: null, transportKind: undefined }],
    ];
    for (const segments of cases) {
      expect({ segments, issuer: writerIdIssuerFor(segments) }).toEqual({ segments, issuer: null });
    }
    expect(writerIdIssuerFor(null as never)).toBeNull();
    expect(writerIdIssuerFor([null] as never)).toBeNull();
  });
});

describe("the module's own laws", () => {
  it("never names git, a clock, a die or a process; and cannot authorize a push", () => {
    const here = resolve(fileURLToPath(import.meta.url), "..");
    const source = readFileSync(
      join(here, "..", "..", "src", "commit-authorization", "index.ts"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const token of [
      "Date.now", "new Date(", "Math.random", "process.env",
      "child_process", "spawn", "execFile", "node:fs",
      // The commit is the integrator's act under a receipt this module
      // produced. The module never runs git and never names it.
      "git",
      // A receipt can never authorize a push.
      "pushAuthorized: true",
    ]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
    // And the only place the field is written writes `false`.
    expect(code.includes("pushAuthorized: false")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P-18/protocolo F — the quarantine batch
// ---------------------------------------------------------------------------

describe("the quarantine batch commits the finding, the move and the intention to revoke together", () => {
  const TASK = "33333333-3333-4333-8333-333333333333";
  const SAGA = "5a6a7a8a-0000-4000-8000-000000000001";
  const INCARNATION = "4c4c4c4c-0000-4000-8000-000000000001";

  function record(): QuarantineRecord {
    const verdict = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
      lease: lease(),
    });
    if (!verdict.ok) throw new Error("fixture conformance refused");
    const out = quarantineWorktree({
      verdict,
      lease: lease(),
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
      taskId: TASK,
    });
    if (!out.ok) throw new Error("fixture quarantine refused");
    return out.record;
  }

  function batchRequest(overrides: Partial<QuarantineBatchRequest> = {}): QuarantineBatchRequest {
    return {
      record: record(),
      sagaId: SAGA,
      deadlineAt: "2026-08-29T12:30:00.000Z",
      leaseToken: { incarnationId: INCARNATION, fence: 1 },
      coordinate: {
        taskId: TASK,
        attempt: 1,
        currentState: "DISCOVERED",
        emittedBy: AUTHORIZER,
        occurredAt: NOW,
        recordedAt: NOW,
        correlationId: null,
        violation: { eventId: "44444444-4444-4444-8444-444444444401", transitionId: "conformance.0.0" },
        quarantine: { eventId: "44444444-4444-4444-8444-444444444402", transitionId: "conformance.0.1" },
        intention: { eventId: "44444444-4444-4444-8444-444444444403", transitionId: "conformance.0.2" },
      },
      ...overrides,
    };
  }

  function built(outcome: QuarantineBatchOutcome) {
    if (!outcome.ok) throw new Error("expected a batch, got " + outcome.reason + " at " + outcome.at);
    return outcome;
  }

  it("builds three candidates in commit order, with the command id the ledger recomputes", () => {
    const out = built(buildQuarantineBatch(batchRequest()));
    expect(out.candidates.map((event) => [event.type, event.fromState, event.toState])).toEqual([
      ["WRITE_SET_VIOLATION_DETECTED", "DISCOVERED", "DISCOVERED"],
      ["TASK_STATE_CHANGED", "DISCOVERED", "SUSPECT_WORKTREE"],
      ["OUTBOX_COMMAND_INTENDED", "SUSPECT_WORKTREE", "SUSPECT_WORKTREE"],
    ]);
    expect(out.commandId).toBe(
      computeOutboxCommandId({
        sagaId: SAGA,
        phase: QUARANTINE_PHASE,
        targetKind: QUARANTINE_TARGET_KIND,
        targetId: WORKTREE,
      }),
    );
    expect(out.candidates[2]?.payload).toEqual({
      outboxContractVersion: 1,
      sagaId: SAGA,
      commandId: out.commandId,
      phase: "QUARANTINE",
      commandKind: "REVOKE_LEASE",
      intentStream: "control_plane_events",
      targetKind: "WORKTREE_LEASE",
      targetId: WORKTREE,
      deadlineAt: "2026-08-29T12:30:00.000Z",
      fence: 1,
      targetStoreIncarnationId: INCARNATION,
    });
    for (const event of out.candidates) {
      expect(event.idempotencyKey).toBe(
        buildIdempotencyKey({ taskId: TASK, attempt: 1, transitionId: event.transitionId }),
      );
    }
    // No LEASE_REVOKED: inside the ledger's transaction nothing has happened at
    // the arbiter yet, and the batch records only what did.
    expect(out.candidates.map((event) => event.type)).not.toContain("LEASE_REVOKED");
  });

  it("N-F-11: mints nothing — no saga is invented, and the same request builds the same bytes", () => {
    const { sagaId: _dropped, ...withoutSaga } = batchRequest();
    void _dropped;
    const missing = buildQuarantineBatch(withoutSaga as unknown as QuarantineBatchRequest);
    expect(refusal(missing)).toEqual({ ok: false, reason: "REQUEST_INVALID", at: "request.sagaId" });
    expect(refusal(buildQuarantineBatch(batchRequest({ sagaId: "not-a-uuid" }))).at).toBe("request.sagaId");
    expect(JSON.stringify(buildQuarantineBatch(batchRequest()))).toBe(JSON.stringify(buildQuarantineBatch(batchRequest())));
  });

  it("carries no token when none is held, and refuses a half one or an already quarantined task", () => {
    const tokenless = built(buildQuarantineBatch(batchRequest({ leaseToken: null })));
    expect(tokenless.candidates[2]?.payload).toMatchObject({ fence: null, targetStoreIncarnationId: null });
    expect(
      refusal(buildQuarantineBatch(batchRequest({ leaseToken: { incarnationId: INCARNATION, fence: 0 } }))).at,
    ).toBe("request.leaseToken.fence");
    const quarantined = batchRequest();
    expect(
      refusal(
        buildQuarantineBatch({
          ...quarantined,
          coordinate: { ...quarantined.coordinate, currentState: "SUSPECT_WORKTREE" },
        }),
      ).at,
    ).toBe("request.coordinate.currentState");
    expect(refusal(buildQuarantineBatch(batchRequest({ deadlineAt: "soon" }))).at).toBe("request.deadlineAt");
  });

  it("is admitted by a real ledger as one batch, and the command it intends is PENDING", () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-p18f-quarantine-"));
    try {
      const ledger = openLedger(join(directory, "control-plane.sqlite"));
      try {
        ledger.append({
          contractVersion: built(buildQuarantineBatch(batchRequest())).candidates[0]?.contractVersion,
          eventId: "44444444-4444-4444-8444-444444444400",
          taskId: TASK,
          attempt: 1,
          transitionId: "discover",
          idempotencyKey: buildIdempotencyKey({ taskId: TASK, attempt: 1, transitionId: "discover" }),
          type: "TASK_DISCOVERED",
          fromState: null,
          toState: "DISCOVERED",
          emittedBy: AUTHORIZER,
          occurredAt: NOW,
          recordedAt: NOW,
          correlationId: null,
          causationId: null,
          payload: {},
        });
        const out = built(buildQuarantineBatch(batchRequest()));
        expect(ledger.appendBatch(out.candidates).insertedCount).toBe(3);
        expect(ledger.getTask(TASK)?.currentState).toBe("SUSPECT_WORKTREE");
        expect(ledger.getOutboxCommand(out.commandId)?.state).toBe("PENDING");
        // Replayed whole, the batch is a no-op rather than a second quarantine.
        expect(ledger.appendBatch(out.candidates).insertedCount).toBe(0);
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
