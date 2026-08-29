import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CommitAuthorizationReceipt } from "@acp/contracts";
import type { Lease, PathDigest } from "@acp/contracts";

import { checkWriteSetConformance } from "../../src/enforcement/index.js";
import type { WorktreeObservation } from "../../src/enforcement/index.js";
import {
  AUTHORIZATION_REFUSALS,
  authorizeCommit,
  quarantineWorktree,
  recordCommit,
} from "../../src/commit-authorization/index.js";
import type {
  AuthorizationOutcome,
  AuthorizationRefused,
  AuthorizationRequest,
  CommitRecordOutcome,
  QuarantineOutcome,
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
  return {
    receiptId: "22222222-2222-4222-8222-222222222222",
    taskId: "33333333-3333-4333-8333-333333333333",
    attempt: 1,
    writer: WRITER,
    verifier: VERIFIER,
    authorizedBy: AUTHORIZER,
    authorizedAt: NOW,
    worktreePath: WORKTREE,
    branch: "main",
    declaredWriteSet: ["src/allowed.ts"],
    observation: observation(),
    checks: [{ command: "pnpm check", exitCode: 0, ranAt: NOW }],
    commitMessage: MESSAGE,
    lease: lease(),
    ...overrides,
  };
}

function refusal(
  outcome: AuthorizationOutcome | CommitRecordOutcome | QuarantineOutcome,
): AuthorizationRefused {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

describe("the authorization decision", () => {
  // (d)
  it("builds a receipt the contract itself accepts", () => {
    const out = authorizeCommit(request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(CommitAuthorizationReceipt.safeParse(out.receipt).success).toBe(true);
    expect(out.receipt.pushAuthorized).toBe(false);
    expect(out.events.map((e) => e.type)).toEqual([
      "VERIFICATION_COMPLETED",
      "COMMIT_AUTHORIZED",
    ]);
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
    const out = authorizeCommit(request({ verifier: WRITER }));
    expect(refusal(out).reason).toBe("VERIFIER_NOT_INDEPENDENT");
    expect(refusal(out).at).toBe("request.verifier");
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

  // (g)
  it("refuses a null observed head outside the bootstrap, and allows it inside", () => {
    const outside = authorizeCommit(request({ observation: observation({ head: null }) }));
    expect(refusal(outside).reason).toBe("BASE_HEAD_MISSING");
    expect(refusal(outside).at).toBe("request.observation.head");

    const bootstrap = authorizeCommit(
      request({ observation: observation({ head: null }), initialCommit: true }),
    );
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(bootstrap.receipt.baseHead).toBeNull();
  });

  // (n) C1: one base-head authority -- the receipt projects the observed head.
  it("takes the receipt's base head from the observation, not a second input", () => {
    // There is no `baseHead` field to disagree with `observation.head`: the
    // receipt names whatever the observation was taken against.
    const out = authorizeCommit(request({ observation: observation({ head: CHILD }) }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.receipt.baseHead).toBe(CHILD);
    expect(Object.keys(request())).not.toContain("baseHead");
  });

  // (o) C1: the bootstrap claim must agree with the observation.
  it("refuses a bootstrap asserted over a worktree that has a head", () => {
    const out = authorizeCommit(request({ initialCommit: true }));
    expect(refusal(out).reason).toBe("BASE_HEAD_MISMATCH");
    expect(refusal(out).at).toBe("request.initialCommit");
  });

  // (p) N1: a composed refusal is carried, not flattened.
  it("carries an inner conformance refusal's own reason and path", () => {
    const empty = authorizeCommit(request({ declaredWriteSet: [] }));
    expect(refusal(empty).reason).toBe("WRITE_SET_EMPTY");
    expect(refusal(empty).at).toBe("request.declaredWriteSet");

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
  it("carries the contract parser's refusal for a malformed identity", () => {
    // `authorizedBy` is an identity no earlier guard reads, so the contract's
    // own parser is what refuses it, and its path is carried out unchanged.
    const out = authorizeCommit(request({ authorizedBy: "not-an-identity" }));
    expect(refusal(out).reason).toBe("RECEIPT_INVALID");
    expect(refusal(out).at).toContain("receipt.");

    // A malformed `writer` is caught earlier and more specifically: no lease
    // can be held by a non-identity, so the holder binding refuses first.
    const badWriter = authorizeCommit(request({ writer: "not-an-identity" }));
    expect(refusal(badWriter).reason).toBe("LEASE_HOLDER_MISMATCH");
  });

  // (h)
  it("refuses malformed input rather than throwing", () => {
    for (const [label, req, reason] of [
      ["null request", null, "REQUEST_INVALID"],
      ["checks not an array", { ...request(), checks: "no" }, "REQUEST_INVALID"],
      ["writer not a string", { ...request(), writer: 7 }, "REQUEST_INVALID"],
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
  });
});

describe("the post-commit record", () => {
  function receiptFor(overrides: Partial<AuthorizationRequest> = {}) {
    const out = authorizeCommit(request(overrides));
    if (!out.ok) throw new Error("fixture authorization refused: " + out.reason);
    return out.receipt;
  }

  it("records a commit that matches its receipt", () => {
    const out = recordCommit({
      receipt: receiptFor(),
      commit: { sha: CHILD, parents: [BASE], message: MESSAGE },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.events.map((e) => e.type)).toEqual(["COMMIT_RECORDED"]);
    expect(out.events[0]?.payload["sha"]).toBe(CHILD);
  });

  // (l)
  it("refuses a parent that is not the receipt's baseHead", () => {
    const out = recordCommit({
      receipt: receiptFor(),
      commit: { sha: CHILD, parents: [CHILD], message: MESSAGE },
    });
    expect(refusal(out).reason).toBe("COMMIT_PARENT_MISMATCH");
  });

  it("refuses a parent at the bootstrap, and accepts none", () => {
    const receipt = receiptFor({
      observation: observation({ head: null }),
      initialCommit: true,
    });
    const withParent = recordCommit({
      receipt,
      commit: { sha: CHILD, parents: [BASE], message: MESSAGE },
    });
    expect(refusal(withParent).reason).toBe("COMMIT_PARENT_MISMATCH");
    const without = recordCommit({
      receipt,
      commit: { sha: CHILD, parents: [], message: MESSAGE },
    });
    expect(without.ok).toBe(true);
  });

  it("accepts a merge whose first parent is the baseHead", () => {
    // A merge's second parent is not what the receipt was taken against;
    // requiring equality there would refuse a lawful merge.
    const out = recordCommit({
      receipt: receiptFor(),
      commit: { sha: CHILD, parents: [BASE, CHILD], message: MESSAGE },
    });
    expect(out.ok).toBe(true);
  });

  it("refuses a changed message and a malformed sha", () => {
    const receipt = receiptFor();
    expect(
      refusal(recordCommit({
        receipt,
        commit: { sha: CHILD, parents: [BASE], message: "something else" },
      })).reason,
    ).toBe("COMMIT_MESSAGE_MISMATCH");
    expect(
      refusal(recordCommit({
        receipt,
        commit: { sha: "nope", parents: [BASE], message: MESSAGE },
      })).reason,
    ).toBe("COMMIT_SHA_INVALID");
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
      declaredWriteSet: req.declaredWriteSet,
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

  it("keeps its refusal set closed after the new codes", () => {
    expect([...AUTHORIZATION_REFUSALS]).toEqual([...AUTHORIZATION_REFUSALS].sort());
    for (const code of ["LEASE_EXPIRED", "LEASE_HOLDER_MISMATCH", "LEASE_WORKTREE_MISMATCH"]) {
      expect(AUTHORIZATION_REFUSALS).toContain(code);
    }
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
