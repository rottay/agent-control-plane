import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Lease as LeaseSchema } from "@acp/contracts";
import type { Lease, PathDigest } from "@acp/contracts";

import {
  ENFORCEMENT_REFUSALS,
  GIT_READ_VERBS,
  acquireLease,
  checkWriteSetConformance,
  observationFailure,
  renewLease,
  revokeLease,
  verifyPrestate,
} from "../../src/enforcement/index.js";
import type {
  ConformanceOutcome,
  EnforcementRefused,
  GitReadOutcome,
  GitReadPort,
  GitReadRequest,
  LeaseOutcome,
  PrestateOutcome,
  WorktreeObservation,
} from "../../src/enforcement/index.js";

const NOON = "2026-08-29T12:00:00.000Z";
const ONE_PM = "2026-08-29T13:00:00.000Z";
const ELEVEN_AM = "2026-08-29T11:00:00.000Z";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const WORKTREE = "/tmp/acp-p6a-drill";
const HOLDER = "claude/opus/implementer/01";
const OTHER = "claude/sonnet/verifier/01";

function lease(overrides: Partial<Lease> = {}): Lease {
  return {
    leaseId: "11111111-1111-4111-8111-111111111111",
    worktreePath: WORKTREE,
    holder: HOLDER,
    acquiredAt: ELEVEN_AM,
    expiresAt: ONE_PM,
    ...overrides,
  };
}

function digest(path: string, sha256: string): PathDigest {
  return { path, sha256 };
}

const A = "a".repeat(64);
const B = "b".repeat(64);

function observation(overrides: Partial<WorktreeObservation> = {}): WorktreeObservation {
  return { head: HEAD, trackedChanges: [], untrackedPaths: [], ...overrides };
}

function refusal(outcome: LeaseOutcome | ConformanceOutcome | PrestateOutcome): EnforcementRefused {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

/** A scripted fake. No production implementation of the port exists. */
function scriptedPort(reply: GitReadOutcome): GitReadPort {
  return (request: GitReadRequest): GitReadOutcome => {
    expect(GIT_READ_VERBS).toContain(request.verb);
    return reply;
  };
}

describe("the port is an allow-list, not a convention", () => {
  it("names exactly the four read-only verbs", () => {
    expect([...GIT_READ_VERBS]).toEqual(["diff", "ls-files", "rev-parse", "status"]);
  });

  it("has no production implementation and no process import in the module", () => {
    const here = resolve(fileURLToPath(import.meta.url), "..");
    const source = readFileSync(join(here, "..", "..", "src", "enforcement", "index.ts"), "utf8");
    // Comments are stripped first: this module necessarily *names* the things it
    // refuses to do in order to explain why it does not do them, and a check
    // that cannot tell code from prose would fail on its own documentation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    for (const token of [
      "child_process", "spawn", "execFile", "execSync", "node:fs",
      // The accounts-package purity standard: a module that reads a clock or
      // rolls a die is not a pure decision core, whatever its signature says.
      "Date.now", "new Date(", "Math.random", "process.env",
    ]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
    // Every mutation verb, as a string literal — which is the only shape in
    // which one could actually be handed to git.
    for (const verb of [
      "checkout", "restore", "reset", "stash", "clean", "push", "commit", "add",
      "rm", "mv", "merge", "rebase", "apply", "worktree", "update-ref",
      "write-tree", "branch", "tag",
    ]) {
      for (const quoted of ['"' + verb + '"', "'" + verb + "'", "`" + verb + "`"]) {
        expect({ quoted, present: code.includes(quoted) }).toEqual({ quoted, present: false });
      }
    }
  });

  it("refuses fail-closed when the observation could not be taken", () => {
    const port = scriptedPort({ ok: false, reason: "not a repository" });
    const outcome = port({ verb: "status", args: [] });
    const failure = observationFailure(outcome, "observation");
    expect(failure?.reason).toBe("OBSERVATION_FAILED");
  });

  it("passes a successful read through unrefused", () => {
    const port = scriptedPort({ ok: true, stdout: "" });
    expect(observationFailure(port({ verb: "status", args: [] }), "observation")).toBeNull();
  });
});

describe("the lease engine: one writer per worktree", () => {
  it("grants a lease on a free worktree and says so as an event", () => {
    const outcome = acquireLease({ leases: [], now: NOON, candidate: lease() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.events.map((e) => e.type)).toEqual(["LEASE_ACQUIRED"]);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.events)).toBe(true);
  });

  // (d)
  it("refuses a second acquire while another holder is live", () => {
    const held = lease({ holder: OTHER, leaseId: "22222222-2222-4222-8222-222222222222" });
    const outcome = acquireLease({ leases: [held], now: NOON, candidate: lease() });
    expect(refusal(outcome).reason).toBe("LEASE_HELD_BY_ANOTHER");
  });

  // (b)
  it("refuses a lease that has already expired", () => {
    const outcome = acquireLease({ leases: [], now: ONE_PM, candidate: lease({ expiresAt: NOON }) });
    expect(refusal(outcome).reason).toBe("LEASE_EXPIRED");
  });

  // (g) the boundary, both sides
  it("treats the instant of expiry as expired, and the instant before as live", () => {
    const atExpiry = acquireLease({ leases: [], now: ONE_PM, candidate: lease({ expiresAt: ONE_PM }) });
    expect(refusal(atExpiry).reason).toBe("LEASE_EXPIRED");
    const justBefore = acquireLease({
      leases: [],
      now: "2026-08-29T12:59:59.999Z",
      candidate: lease({ expiresAt: ONE_PM }),
    });
    expect(justBefore.ok).toBe(true);
  });

  // (k)
  it("lets a different holder take the worktree once the old lease has expired", () => {
    const stale = lease({ holder: OTHER, leaseId: "22222222-2222-4222-8222-222222222222", expiresAt: NOON });
    const outcome = acquireLease({
      leases: [stale],
      now: ONE_PM,
      candidate: lease({ acquiredAt: ONE_PM, expiresAt: "2026-08-29T14:00:00.000Z" }),
    });
    expect(outcome.ok).toBe(true);
    // Nothing was cleaned up to make room: the stale lease simply stopped
    // authorizing anything.
    if (!outcome.ok) return;
    expect(outcome.lease.holder).toBe(HOLDER);
  });

  // (h)
  it("refuses a renewal by anyone but the holder", () => {
    const existing = lease();
    const byOther = renewLease({
      leases: [existing],
      now: NOON,
      leaseId: existing.leaseId,
      holder: OTHER,
      expiresAt: "2026-08-29T14:00:00.000Z",
    });
    expect(refusal(byOther).reason).toBe("LEASE_NOT_HELD");

    const byHolder = renewLease({
      leases: [existing],
      now: NOON,
      leaseId: existing.leaseId,
      holder: HOLDER,
      expiresAt: "2026-08-29T14:00:00.000Z",
    });
    expect(byHolder.ok).toBe(true);
  });

  it("refuses to renew an expired lease, and to revoke one", () => {
    const dead = lease({ expiresAt: NOON });
    const renewal = renewLease({
      leases: [dead], now: ONE_PM, leaseId: dead.leaseId, holder: HOLDER,
      expiresAt: "2026-08-29T14:00:00.000Z",
    });
    expect(refusal(renewal).reason).toBe("LEASE_EXPIRED");
    const revocation = revokeLease({ leases: [dead], now: ONE_PM, leaseId: dead.leaseId, cause: "x" });
    expect(refusal(revocation).reason).toBe("LEASE_EXPIRED");
  });

  it("revokes a live lease and returns the event", () => {
    const existing = lease();
    const outcome = revokeLease({
      leases: [existing], now: NOON, leaseId: existing.leaseId, cause: "WRITE_SET_VIOLATION_DETECTED",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.events.map((e) => e.type)).toEqual(["LEASE_REVOKED"]);
  });

  it("refuses a lease whose own shape does not make sense", () => {
    const held = lease({ leaseId: "33333333-3333-4333-8333-333333333333" });
    const cases: readonly (readonly [string, readonly Lease[], Lease, string])[] = [
      [
        "reused id pointing elsewhere",
        [{ ...held, worktreePath: "/tmp/other-tree" }],
        lease({ leaseId: held.leaseId }),
        "request.candidate.leaseId",
      ],
      [
        "acquired in the future",
        [],
        lease({ acquiredAt: "2026-08-29T12:30:00.000Z" }),
        "request.candidate.acquiredAt",
      ],
      // Both windows are acquired at-or-before `now`, so the future-acquiredAt
      // guard cannot fire first and mask the window check.
      [
        "an empty window",
        [],
        lease({ acquiredAt: ELEVEN_AM, expiresAt: ELEVEN_AM }),
        "request.candidate.expiresAt",
      ],
      [
        "an inverted window",
        [],
        lease({ acquiredAt: NOON, expiresAt: ELEVEN_AM }),
        "request.candidate.expiresAt",
      ],
    ];
    for (const [label, leases, candidate, at] of cases) {
      const outcome = acquireLease({ leases, now: NOON, candidate });
      expect({ label, reason: refusal(outcome).reason, at: refusal(outcome).at }).toEqual({
        label,
        reason: "LEASE_INVALID",
        at,
      });
    }
  });

  it("still tolerates the idempotent re-offer of the same lease", () => {
    const existing = lease();
    const outcome = acquireLease({ leases: [existing], now: NOON, candidate: existing });
    expect(outcome.ok).toBe(true);
  });

  it("refuses a malformed lease, a malformed set and a malformed instant", () => {
    expect(refusal(acquireLease({ leases: [], now: NOON, candidate: {} as Lease })).reason).toBe("LEASE_INVALID");
    expect(
      refusal(acquireLease({ leases: "no" as unknown as Lease[], now: NOON, candidate: lease() })).reason,
    ).toBe("REQUEST_INVALID");
    expect(refusal(acquireLease({ leases: [], now: "noon", candidate: lease() })).reason).toBe("INSTANT_INVALID");
    expect(refusal(acquireLease(null as unknown as never)).reason).toBe("REQUEST_INVALID");
  });
});

describe("write-set conformance: tracked and untracked in one pass", () => {
  // (a)
  it("names a write outside the set, revokes and quarantines — and nothing else", () => {
    const outcome = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation({ trackedChanges: [digest("src/elsewhere.ts", A)] }),
      lease: lease(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.conformant).toBe(false);
    expect([...outcome.violations]).toEqual(["src/elsewhere.ts"]);
    expect(outcome.revokeLeaseId).toBe(lease().leaseId);
    expect(outcome.recommendedTaskState).toBe("SUSPECT_WORKTREE");
    expect(outcome.events.map((e) => e.type)).toEqual([
      "WRITE_SET_VIOLATION_DETECTED",
      "LEASE_REVOKED",
    ]);
    // The verdict recommends no cleanup of any kind: there is no field in which
    // one could be expressed.
    expect(Object.keys(outcome).sort()).toEqual([
      "conformant", "events", "ok", "recommendedTaskState", "revokeLeaseId", "violations",
    ]);
  });

  // (f)
  it("emits the same LEASE_REVOKED payload from both sites", () => {
    // The deferred P6A-N1: one event, one shape, whichever path produced it.
    // A reader of the ledger can attribute a revocation to a worktree and a
    // holder without joining anything.
    const held = lease();
    const fromRevoke = revokeLease({
      leases: [held], now: NOON, leaseId: held.leaseId, cause: "WRITE_SET_VIOLATION_DETECTED",
    });
    const fromVerdict = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation({ trackedChanges: [digest("src/elsewhere.ts", A)] }),
      lease: held,
    });
    expect(fromRevoke.ok).toBe(true);
    expect(fromVerdict.ok).toBe(true);
    if (!fromRevoke.ok || !fromVerdict.ok) return;
    const left = fromRevoke.events.find((e) => e.type === "LEASE_REVOKED");
    const right = fromVerdict.events.find((e) => e.type === "LEASE_REVOKED");
    const expected = {
      leaseId: held.leaseId,
      worktreePath: held.worktreePath,
      holder: held.holder,
      cause: "WRITE_SET_VIOLATION_DETECTED",
    };
    expect(left?.payload).toEqual(expected);
    expect(right?.payload).toEqual(expected);
    expect(Object.keys(left?.payload ?? {}).sort()).toEqual(Object.keys(right?.payload ?? {}).sort());
  });

  it("passes when untracked paths are inside the set — the scan is not tracked-only", () => {
    const outcome = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts", "src/new.ts"],
      observation: observation({
        trackedChanges: [digest("src/allowed.ts", A)],
        untrackedPaths: ["src/new.ts"],
      }),
      lease: lease(),
    });
    expect(outcome.ok && outcome.conformant).toBe(true);
  });

  it("catches an untracked file outside the set", () => {
    const outcome = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation({ untrackedPaths: ["src/sneaked-in.ts"] }),
      lease: lease(),
    });
    expect(outcome.ok && outcome.conformant).toBe(false);
  });

  // (i)
  it("treats a tracked deletion and both sides of a rename as observed paths", () => {
    const deletion = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation({ trackedChanges: [digest("src/deleted.ts", A)] }),
      lease: lease(),
    });
    expect(deletion.ok && deletion.violations).toEqual(["src/deleted.ts"]);

    // A rename out of the set observes the old path and the new one; only the
    // new one is outside, and it is enough.
    const rename = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation({
        trackedChanges: [digest("src/allowed.ts", A), digest("src/moved-away.ts", B)],
      }),
      lease: lease(),
    });
    expect(rename.ok && rename.violations).toEqual(["src/moved-away.ts"]);
  });

  // (j)
  it("does not see an ignored file, because the observation excludes it", () => {
    // `--exclude-standard` is the fence's own model: an ignored file is not an
    // untracked path, so it never reaches this function at all.
    const outcome = checkWriteSetConformance({
      declaredWriteSet: ["src/allowed.ts"],
      observation: observation({ untrackedPaths: [] }),
      lease: lease(),
    });
    expect(outcome.ok && outcome.conformant).toBe(true);
  });

  it("sorts and deduplicates the violations", () => {
    const outcome = checkWriteSetConformance({
      declaredWriteSet: ["ok.ts"],
      observation: observation({
        trackedChanges: [digest("z.ts", A), digest("a.ts", B)],
        untrackedPaths: ["z.ts", "m.ts"],
      }),
      lease: lease(),
    });
    expect(outcome.ok && outcome.violations).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  // (e)
  it("refuses a malformed or absent observation rather than passing it", () => {
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["not an object", "nope", "request.observation"],
      ["bad head", { ...observation(), head: "xyz" }, "request.observation.head"],
      ["tracked not an array", { ...observation(), trackedChanges: 1 }, "request.observation.trackedChanges"],
      ["untracked not an array", { ...observation(), untrackedPaths: null }, "request.observation.untrackedPaths"],
    ];
    for (const [label, malformed, at] of cases) {
      const run = (): ConformanceOutcome =>
        checkWriteSetConformance({
          declaredWriteSet: ["ok.ts"],
          observation: malformed as WorktreeObservation,
          lease: lease(),
        });
      expect(run).not.toThrow();
      const outcome = run();
      expect({ label, reason: refusal(outcome).reason, at: refusal(outcome).at }).toEqual({
        label,
        reason: "OBSERVATION_INVALID",
        at,
      });
    }
  });

  it("refuses a declared path that is not repo-relative", () => {
    // An absolute path or one that climbs out of the tree describes a file this
    // write-set has no standing to authorize; matching an observation against
    // it would let a declared escape hatch look like conformance.
    for (const [label, entry] of [
      ["absolute", "/etc/passwd"],
      ["climbing out", "../elsewhere/x.ts"],
      ["climbing mid-path", "src/../../x.ts"],
    ] as const) {
      const outcome = checkWriteSetConformance({
        declaredWriteSet: [entry],
        observation: observation(),
        lease: lease(),
      });
      expect({ label, reason: refusal(outcome).reason, at: refusal(outcome).at }).toEqual({
        label,
        reason: "REQUEST_INVALID",
        at: "request.declaredWriteSet[0]",
      });
    }
  });

  it("refuses a malformed leaseId, since the verdict would name nothing", () => {
    const outcome = checkWriteSetConformance({
      declaredWriteSet: ["ok.ts"],
      observation: observation(),
      lease: { ...lease(), leaseId: "not-a-uuid" },
    });
    expect(refusal(outcome).reason).toBe("REQUEST_INVALID");
    expect(refusal(outcome).at).toBe("request.lease");
  });

  it("accepts a null head only, and refuses an empty declared set", () => {
    const initial = checkWriteSetConformance({
      declaredWriteSet: ["ok.ts"],
      observation: observation({ head: null }),
      lease: lease(),
    });
    expect(initial.ok).toBe(true);
    const empty = checkWriteSetConformance({
      declaredWriteSet: [],
      observation: observation(),
      lease: lease(),
    });
    expect(refusal(empty).reason).toBe("WRITE_SET_EMPTY");
  });
});

describe("prestate verification", () => {
  // (c)
  it("refuses on a digest mismatch and names the path", () => {
    // The law is "refuse the start on any mismatch, naming the path". A verdict
    // with a boolean on it is something a caller can forget to read; a refusal
    // is not.
    const outcome = verifyPrestate({
      authority: [digest("docs/AGENTS.md", A), digest("src/x.ts", B)],
      observed: [digest("docs/AGENTS.md", A), digest("src/x.ts", A)],
    });
    expect(refusal(outcome).reason).toBe("PRESTATE_MISMATCH");
    expect(refusal(outcome).at).toBe("request.authority.src/x.ts");
  });

  it("names the first sorted path when several mismatch", () => {
    const outcome = verifyPrestate({
      authority: [digest("z.ts", A), digest("a.ts", A)],
      observed: [digest("z.ts", B), digest("a.ts", B)],
    });
    expect(refusal(outcome).at).toBe("request.authority.a.ts");
  });

  it("counts an absent authority path as a mismatch", () => {
    const outcome = verifyPrestate({ authority: [digest("gone.ts", A)], observed: [] });
    expect(refusal(outcome).reason).toBe("PRESTATE_MISMATCH");
    expect(refusal(outcome).at).toBe("request.authority.gone.ts");
  });

  it("refuses an empty authority: a packet with none has none", () => {
    const outcome = verifyPrestate({ authority: [], observed: [digest("a.ts", A)] });
    expect(refusal(outcome).reason).toBe("PRESTATE_MISSING");
    expect(refusal(outcome).at).toBe("request.authority");
  });

  it("matches when every authority digest is reproduced", () => {
    const outcome = verifyPrestate({
      authority: [digest("a.ts", A)],
      observed: [digest("a.ts", A), digest("unrelated.ts", B)],
    });
    expect(outcome.ok && outcome.matches).toBe(true);
  });

  it("refuses a malformed request instead of throwing", () => {
    const run = (): PrestateOutcome => verifyPrestate(null as unknown as never);
    expect(run).not.toThrow();
    expect(refusal(run()).reason).toBe("REQUEST_INVALID");
  });
});

describe("the P6 checkpoint defects", () => {
  const PLUS_TWO_NOON = "2026-08-29T14:00:00.000+02:00"; // === NOON
  const TWO_PM = "2026-08-29T14:00:00.000Z";

  // --- F1: prestate parses every entry and refuses duplicates fail-closed ---

  it("refuses a malformed path digest at its exact index, on both sides", () => {
    for (const [label, request, at] of [
      [
        "bad sha256 in authority",
        { authority: [digest("a.ts", A), { path: "b.ts", sha256: "nope" }], observed: [] },
        "request.authority[1]",
      ],
      [
        "absolute path in authority",
        { authority: [digest("/etc/passwd", A)], observed: [] },
        "request.authority[0]",
      ],
      [
        "parent traversal in observed",
        { authority: [digest("a.ts", A)], observed: [digest("../elsewhere.ts", A)] },
        "request.observed[0]",
      ],
      [
        "bad sha256 in observed",
        { authority: [digest("a.ts", A)], observed: [{ path: "a.ts", sha256: "short" }] },
        "request.observed[0]",
      ],
    ] as const) {
      const run = (): PrestateOutcome => verifyPrestate(request as never);
      expect(run).not.toThrow();
      const out = run();
      expect({ label, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        label,
        reason: "REQUEST_INVALID",
        at,
      });
    }
  });

  it("refuses a duplicate path whether or not the digests agree", () => {
    // Conflicting: the observer contradicted itself.
    const conflicting = verifyPrestate({
      authority: [digest("a.ts", A)],
      observed: [digest("a.ts", A), digest("a.ts", B)],
    });
    expect(refusal(conflicting).reason).toBe("DUPLICATE_PATH");
    expect(refusal(conflicting).at).toBe("request.observed[1]");

    // Agreeing: still refused. "Never a match" must not become "a match when
    // they happen to agree" -- the caller that sent two does not know which it
    // observed, and the Map would silently have kept the last.
    const agreeing = verifyPrestate({
      authority: [digest("a.ts", A)],
      observed: [digest("a.ts", A), digest("a.ts", A)],
    });
    expect(refusal(agreeing).reason).toBe("DUPLICATE_PATH");

    const inAuthority = verifyPrestate({
      authority: [digest("a.ts", A), digest("a.ts", B)],
      observed: [digest("a.ts", A)],
    });
    expect(refusal(inAuthority).reason).toBe("DUPLICATE_PATH");
    expect(refusal(inAuthority).at).toBe("request.authority[1]");
  });

  it("still matches a well-formed prestate", () => {
    const out = verifyPrestate({
      authority: [digest("a.ts", A), digest("b.ts", B)],
      observed: [digest("b.ts", B), digest("a.ts", A)],
    });
    expect(out.ok).toBe(true);
  });

  // --- F2: conformance admits observations with the same strictness ---

  it("refuses an observation that is not a path digest, or not repo-relative", () => {
    for (const [label, observed, at, reason] of [
      [
        "tracked change without a digest",
        observation({ trackedChanges: [{ path: "ok.ts" } as never] }),
        "request.observation.trackedChanges[0]",
        "OBSERVATION_INVALID",
      ],
      [
        "tracked change with a bad digest",
        observation({ trackedChanges: [{ path: "ok.ts", sha256: "nope" } as never] }),
        "request.observation.trackedChanges[0]",
        "OBSERVATION_INVALID",
      ],
      [
        "duplicate tracked path",
        observation({ trackedChanges: [digest("ok.ts", A), digest("ok.ts", B)] }),
        "request.observation.trackedChanges[1]",
        "DUPLICATE_PATH",
      ],
      [
        "absolute untracked path",
        observation({ untrackedPaths: ["/etc/passwd"] }),
        "request.observation.untrackedPaths[0]",
        "OBSERVATION_INVALID",
      ],
      [
        "untracked parent traversal",
        observation({ untrackedPaths: ["../elsewhere.ts"] }),
        "request.observation.untrackedPaths[0]",
        "OBSERVATION_INVALID",
      ],
      [
        "untracked backslash path",
        observation({ untrackedPaths: ["src\\windows.ts"] }),
        "request.observation.untrackedPaths[0]",
        "OBSERVATION_INVALID",
      ],
    ] as const) {
      const run = (): ConformanceOutcome =>
        checkWriteSetConformance({
          declaredWriteSet: ["ok.ts"],
          observation: observed,
          lease: lease(),
        });
      expect(run).not.toThrow();
      const out = run();
      expect({ label, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        label,
        reason,
        at,
      });
    }
  });

  // --- C3: every comparison is by instant, not by string ---

  it("treats equal instants written in different offsets as equal", () => {
    // acquiredAt === now across offsets: the string comparison read this as
    // "acquired in the future" and refused a lawful lease.
    const acquired = acquireLease({
      leases: [],
      now: NOON,
      candidate: lease({ acquiredAt: PLUS_TWO_NOON, expiresAt: ONE_PM }),
    });
    expect(acquired.ok).toBe(true);

    // And the same for an expiry: an offset expiry equal to `now` is expired,
    // exactly as the Z-form is.
    const expired = acquireLease({
      leases: [],
      now: NOON,
      candidate: lease({ acquiredAt: ELEVEN_AM, expiresAt: PLUS_TWO_NOON }),
    });
    expect(refusal(expired).reason).toBe("LEASE_EXPIRED");
  });

  // --- F4 + C1: renewal semantics and the authoritative representation ---

  it("refuses a renewal that does not extend", () => {
    for (const [label, expiresAt] of [
      ["equal to now", NOON],
      ["before now", ELEVEN_AM],
      ["after now but before the existing expiry", "2026-08-29T12:30:00.000Z"],
      ["equal to the existing expiry", ONE_PM],
    ] as const) {
      const out = renewLease({
        leases: [lease()],
        now: NOON,
        leaseId: lease().leaseId,
        holder: HOLDER,
        expiresAt,
      });
      expect({ label, reason: refusal(out).reason, at: refusal(out).at }).toEqual({
        label,
        reason: "LEASE_RENEWAL_NOT_EXTENDING",
        at: "request.expiresAt",
      });
    }
  });

  it("refuses a holder that is not an identity", () => {
    const out = renewLease({
      leases: [lease()],
      now: NOON,
      leaseId: lease().leaseId,
      holder: "not-an-identity",
      expiresAt: TWO_PM,
    });
    expect(refusal(out).reason).toBe("REQUEST_INVALID");
    expect(refusal(out).at).toBe("request.holder");
  });

  it("emits the whole lease in LEASE_ACQUIRED, at both sites", () => {
    const acquired = acquireLease({ leases: [], now: NOON, candidate: lease() });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const renewal = renewLease({
      leases: [lease()],
      now: NOON,
      leaseId: lease().leaseId,
      holder: HOLDER,
      expiresAt: TWO_PM,
    });
    expect(renewal.ok).toBe(true);
    if (!renewal.ok) return;

    const acquireEvent = acquired.events[0];
    const renewEvent = renewal.events[0];
    expect(acquireEvent?.type).toBe("LEASE_ACQUIRED");
    expect(renewEvent?.type).toBe("LEASE_ACQUIRED");
    expect(acquireEvent?.payload).toEqual({
      leaseId: lease().leaseId,
      worktreePath: WORKTREE,
      holder: HOLDER,
      acquiredAt: ELEVEN_AM,
      expiresAt: ONE_PM,
    });
    // The same five keys at both sites, and a renewal changes only the expiry.
    expect(Object.keys(renewEvent?.payload ?? {}).sort()).toEqual(
      Object.keys(acquireEvent?.payload ?? {}).sort(),
    );
    expect(renewEvent?.payload).toEqual({
      leaseId: lease().leaseId,
      worktreePath: WORKTREE,
      holder: HOLDER,
      acquiredAt: ELEVEN_AM,
      expiresAt: TWO_PM,
    });
  });

  it("lets a caller fold the ledger back into the renewed lease", () => {
    // The fold rule, exercised: per leaseId the last LEASE_ACQUIRED in ledger
    // order defines the lease. Nothing but the payloads is used.
    const first = acquireLease({ leases: [], now: NOON, candidate: lease() });
    const second = renewLease({
      leases: [lease()],
      now: NOON,
      leaseId: lease().leaseId,
      holder: HOLDER,
      expiresAt: TWO_PM,
    });
    if (!first.ok || !second.ok) throw new Error("fixture refused");

    const ledger = [...first.events, ...second.events];
    const folded = new Map<string, Record<string, string>>();
    for (const candidate of ledger) {
      const payload = { ...candidate.payload };
      const leaseId = payload["leaseId"] ?? "";
      if (candidate.type === "LEASE_ACQUIRED") folded.set(leaseId, payload);
      if (candidate.type === "LEASE_REVOKED") folded.delete(leaseId);
    }

    const reconstructed = folded.get(lease().leaseId);
    const parsed = LeaseSchema.safeParse(reconstructed);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(lease({ expiresAt: TWO_PM }));
  });

  // N1: the fold rule's other clause -- a revocation is terminal for the id.
  it("ignores a LEASE_ACQUIRED that would resurrect a revoked lease", () => {
    const acquired = acquireLease({ leases: [], now: NOON, candidate: lease() });
    const revoked = revokeLease({
      leases: [lease()],
      now: NOON,
      leaseId: lease().leaseId,
      cause: "WRITE_SET_VIOLATION_DETECTED",
    });
    if (!acquired.ok || !revoked.ok) throw new Error("fixture refused");
    // The caller's live set is empty after the revocation, so the engine will
    // hand out the same id again: it holds no state and could not refuse.
    const resurrection = acquireLease({ leases: [], now: NOON, candidate: lease() });
    if (!resurrection.ok) throw new Error("fixture refused");

    const ledger = [...acquired.events, ...revoked.events, ...resurrection.events];
    const folded = new Map<string, Record<string, string>>();
    const dead = new Set<string>();
    for (const candidate of ledger) {
      const payload = { ...candidate.payload };
      const leaseId = payload["leaseId"] ?? "";
      if (candidate.type === "LEASE_REVOKED") {
        dead.add(leaseId);
        folded.delete(leaseId);
      }
      // Terminal: a later acquisition for a revoked id is not a resurrection,
      // and the fold ignores it rather than reviving the lease.
      if (candidate.type === "LEASE_ACQUIRED" && !dead.has(leaseId)) {
        folded.set(leaseId, payload);
      }
    }

    expect(folded.has(lease().leaseId)).toBe(false);
    expect([...folded.keys()]).toEqual([]);

    // The engine's own reading agrees: over the folded set the lease is gone.
    const renewal = renewLease({
      leases: [],
      now: NOON,
      leaseId: lease().leaseId,
      holder: HOLDER,
      expiresAt: TWO_PM,
    });
    expect(refusal(renewal).reason).toBe("LEASE_NOT_FOUND");
    expect(refusal(renewal).at).toBe("request.leaseId");
  });

  it("closes its refusal set after the new codes", () => {
    expect([...ENFORCEMENT_REFUSALS]).toEqual([...ENFORCEMENT_REFUSALS].sort());
    expect(new Set(ENFORCEMENT_REFUSALS).size).toBe(ENFORCEMENT_REFUSALS.length);
    for (const code of ["DUPLICATE_PATH", "LEASE_RENEWAL_NOT_EXTENDING"]) {
      expect(ENFORCEMENT_REFUSALS).toContain(code);
    }
  });
});

describe("the module's own laws", () => {
  it("is deterministic and frozen at every level", () => {
    const first = checkWriteSetConformance({
      declaredWriteSet: ["ok.ts"],
      observation: observation({ untrackedPaths: ["bad.ts"] }),
      lease: lease(),
    });
    const second = checkWriteSetConformance({
      declaredWriteSet: ["ok.ts"],
      observation: observation({ untrackedPaths: ["bad.ts"] }),
      lease: lease(),
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.violations)).toBe(true);
    for (const candidate of first.events) {
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.payload)).toBe(true);
    }
  });

  it("closes its refusal set", () => {
    expect([...ENFORCEMENT_REFUSALS]).toEqual([...ENFORCEMENT_REFUSALS].sort());
    expect(new Set(ENFORCEMENT_REFUSALS).size).toBe(ENFORCEMENT_REFUSALS.length);
  });
});
