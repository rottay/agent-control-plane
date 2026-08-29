import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTRACT_VERSION, TaskEnvelope } from "@acp/contracts";

import {
  CONFLICT_KINDS,
  GRAPH_REFUSALS,
  buildConflictGraph,
  checkAdmission,
} from "../../src/conflict-graph/index.js";
import type { ConflictOutcome, GraphRefused } from "../../src/conflict-graph/index.js";

const ISSUED_AT = "2026-08-29T12:00:00.000Z";
const SHA = "a".repeat(64);

let counter = 0;
function taskId(seed?: string): string {
  if (seed !== undefined) return seed;
  counter += 1;
  return "0000000" + String(counter).padStart(1, "0") + "-0000-4000-8000-000000000000";
}

interface Parts {
  readonly taskId?: string;
  readonly authority?: readonly string[];
  readonly readSet?: readonly string[];
  readonly writeSet?: readonly string[];
  readonly conflictKeys?: readonly string[];
  readonly outputKind?: "DIFF" | "REPORT" | "FIXTURE" | "NONE";
}

function envelope(parts: Parts = {}): TaskEnvelope {
  const parsed = TaskEnvelope.safeParse({
    contractVersion: CONTRACT_VERSION,
    taskId: parts.taskId ?? taskId(),
    title: "drill",
    objective: "a conflict-graph drill packet",
    classification: "MECHANICAL",
    issuedBy: "kimi/k3/coordinator/01",
    issuedAt: ISSUED_AT,
    authority: (parts.authority ?? []).map((path) => ({ path, sha256: SHA })),
    readSet: [...(parts.readSet ?? [])],
    writeSet: [...(parts.writeSet ?? [])],
    conflictKeys: [...(parts.conflictKeys ?? [])],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: parts.outputKind ?? "DIFF", description: "a drill output" },
    validation: { commands: [], independentVerifierRequired: true },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 100_000, maxWallClockSeconds: 3_600, reserveTokensForCheckpoint: 1_000 },
    visualEvidenceRequired: false,
    // A packet with an empty write-set may not carry a commit policy, so the
    // fixture follows the contract rather than working around it.
    commitPolicy: (parts.writeSet ?? []).length === 0 ? "NO_COMMIT" : "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 1 },
  });
  if (!parsed.success) {
    throw new Error("fixture is not a valid TaskEnvelope: " + String(parsed.error.issues[0]?.message));
  }
  return parsed.data;
}

function refusal(outcome: ConflictOutcome): GraphRefused {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

function verdict(outcome: ConflictOutcome) {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("expected a verdict");
  return outcome;
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("the three conflict kinds, each named", () => {
  // (a)
  it("names a shared conflict key", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, conflictKeys: ["ledger-schema"] }),
        envelope({ taskId: B, conflictKeys: ["ledger-schema", "other"] }),
      ],
    }));
    expect(out.compatible).toBe(false);
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0]?.kinds).toEqual(["CONFLICT_KEY"]);
    expect(out.pairs[0]?.intersections).toEqual([
      { kind: "CONFLICT_KEY", left: "ledger-schema", right: "ledger-schema" },
    ]);
  });

  // (b)
  it("names a write-write intersection", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["src/a.ts"] }),
        envelope({ taskId: B, writeSet: ["src/a.ts"] }),
      ],
    }));
    expect(out.pairs[0]?.kinds).toEqual(["WRITE_WRITE"]);
  });

  // (c)
  it("names a write against the other's authority", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["docs/AGENTS.md"] }),
        envelope({ taskId: B, authority: ["docs/AGENTS.md"] }),
      ],
    }));
    expect(out.pairs[0]?.kinds).toEqual(["WRITE_AUTHORITY"]);
  });

  // (d)
  it("names a write against the other's read set", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["src/lib.ts"] }),
        envelope({ taskId: B, readSet: ["src/lib.ts"] }),
      ],
    }));
    expect(out.pairs[0]?.kinds).toEqual(["WRITE_READ"]);
  });

  // (j) both directions of kind (c)
  it("catches kind (c) in both directions", () => {
    const forward = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["x.ts"] }),
        envelope({ taskId: B, authority: ["x.ts"], readSet: ["y.ts"] }),
      ],
    }));
    const backward = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, authority: ["x.ts"], readSet: ["y.ts"] }),
        envelope({ taskId: B, writeSet: ["x.ts"] }),
      ],
    }));
    expect(forward.pairs[0]?.kinds).toEqual(["WRITE_AUTHORITY"]);
    expect(backward.pairs[0]?.kinds).toEqual(["WRITE_AUTHORITY"]);
  });

  it("does not call a read-read or authority-authority overlap a conflict", () => {
    // Every packet is authorized by AGENTS.md. If sharing that were a conflict,
    // no two packets could ever run in parallel.
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, authority: ["AGENTS.md"], readSet: ["src/shared.ts"] }),
        envelope({ taskId: B, authority: ["AGENTS.md"], readSet: ["src/shared.ts"] }),
      ],
    }));
    expect(out.compatible).toBe(true);
    expect(out.pairs).toEqual([]);
  });

  it("does not invent a self-conflict for a packet that reads what it writes", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [envelope({ taskId: A, writeSet: ["src/a.ts"], readSet: ["src/a.ts"], authority: ["src/a.ts"] })],
    }));
    expect(out.compatible).toBe(true);
  });

  // (k)
  it("lists every kind a pair conflicts on", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["src/a.ts"], conflictKeys: ["k"], readSet: ["src/b.ts"] }),
        envelope({ taskId: B, writeSet: ["src/a.ts", "src/b.ts"], conflictKeys: ["k"] }),
      ],
    }));
    expect(out.pairs[0]?.kinds).toEqual(["CONFLICT_KEY", "WRITE_READ", "WRITE_WRITE"]);
  });
});

describe("path intersection is not string equality", () => {
  // (p)
  it("normalizes before comparing, and reports the caller's own strings", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["./src//a.ts"] }),
        envelope({ taskId: B, writeSet: ["src/a.ts"] }),
      ],
    }));
    expect(out.pairs[0]?.kinds).toEqual(["WRITE_WRITE"]);
    // Normalization is comparison-internal: the verdict shows what the caller
    // wrote, because that is what the caller has to fix.
    expect(out.pairs[0]?.intersections[0]).toEqual({
      kind: "WRITE_WRITE",
      left: "./src//a.ts",
      right: "src/a.ts",
    });
  });

  it("treats a directory as intersecting the files beneath it, both ways", () => {
    for (const [label, first, second] of [
      ["ancestor first", "packages/x", "packages/x/a.ts"],
      ["ancestor second", "packages/x/a.ts", "packages/x"],
      ["trailing slash", "packages/x/", "packages/x/a.ts"],
      // C1: an interior `.` segment. Stripping only a leading `./` would call
      // this pair compatible -- the fail-open hole normalization exists to
      // close.
      ["interior dot segment", "src/./a.ts", "src/a.ts"],
      ["several interior dots", "src/./nested/./a.ts", "src/nested/a.ts"],
      ["a bare dot is the root", ".", "anything/at/all.ts"],
    ] as const) {
      const out = verdict(buildConflictGraph({
        envelopes: [
          envelope({ taskId: A, writeSet: [first] }),
          envelope({ taskId: B, writeSet: [second] }),
        ],
      }));
      expect({ label, kinds: out.pairs[0]?.kinds }).toEqual({ label, kinds: ["WRITE_WRITE"] });
    }
  });

  it("does not treat a sibling prefix as containment", () => {
    // "packages/xy" is not inside "packages/x".
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["packages/x"] }),
        envelope({ taskId: B, writeSet: ["packages/xy"] }),
      ],
    }));
    expect(out.compatible).toBe(true);
  });

  it("compares conflict keys by exact equality only", () => {
    // Opaque means opaque: a key is not a path and has no ancestors.
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, conflictKeys: ["ledger"] }),
        envelope({ taskId: B, conflictKeys: ["ledger/schema"] }),
      ],
    }));
    expect(out.compatible).toBe(true);
  });
});

describe("the set verdict", () => {
  // (e) and (n)
  it("names exactly the conflicting pairs in a chain", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["src/a.ts"] }),
        envelope({ taskId: B, writeSet: ["src/a.ts", "src/b.ts"] }),
        envelope({ taskId: C, writeSet: ["src/b.ts"] }),
      ],
    }));
    expect(out.pairs.map((p) => [p.taskIdA, p.taskIdB])).toEqual([
      [A, B],
      [B, C],
    ]);
  });

  // (f)
  it("calls the empty and singleton sets compatible, and says so", () => {
    expect(verdict(buildConflictGraph({ envelopes: [] })).compatible).toBe(true);
    expect(verdict(buildConflictGraph({ envelopes: [envelope()] })).compatible).toBe(true);
  });

  // (g)
  it("reports a duplicate task id once, with its multiplicity", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [envelope({ taskId: A }), envelope({ taskId: A }), envelope({ taskId: A })],
    }));
    expect(out.compatible).toBe(false);
    expect(out.duplicateTaskIds).toEqual([{ taskId: A, count: 3 }]);
    // The duplicates are a property of the set, not pairs of it.
    expect(out.pairs).toEqual([]);
  });

  it("names a pair once even when an id repeats in the set", () => {
    // Three envelopes, two of them carrying A. The pair (A, B) is reachable
    // from two positions; reporting it twice would say two collisions happened
    // where one did. The set is still incompatible, via duplicateTaskIds.
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["x.ts"] }),
        envelope({ taskId: A, writeSet: ["x.ts"] }),
        envelope({ taskId: B, writeSet: ["x.ts"] }),
      ],
    }));
    expect(out.pairs.map((p) => [p.taskIdA, p.taskIdB])).toEqual([[A, B]]);
    expect(out.duplicateTaskIds).toEqual([{ taskId: A, count: 2 }]);
    expect(out.compatible).toBe(false);
  });

  // (h)
  it("is order-independent and frozen", () => {
    const one = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: C, writeSet: ["c.ts"] }),
        envelope({ taskId: A, writeSet: ["a.ts", "c.ts"] }),
        envelope({ taskId: B, writeSet: ["b.ts"] }),
      ],
    }));
    const other = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: B, writeSet: ["b.ts"] }),
        envelope({ taskId: A, writeSet: ["a.ts", "c.ts"] }),
        envelope({ taskId: C, writeSet: ["c.ts"] }),
      ],
    }));
    expect(JSON.stringify(one)).toBe(JSON.stringify(other));
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(one.pairs)).toBe(true);
    expect(Object.isFrozen(one.pairs[0])).toBe(true);
    expect(Object.isFrozen(one.pairs[0]?.kinds)).toBe(true);
    expect(Object.isFrozen(one.pairs[0]?.intersections)).toBe(true);
  });

  // (i)
  it("sees a derived-output collision through the write-set", () => {
    // `output` carries no paths, so a derived output is visible to the graph
    // only where it lands: the write-set.
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["docs/report.md"], outputKind: "REPORT" }),
        envelope({ taskId: B, writeSet: ["docs/report.md"], outputKind: "REPORT" }),
      ],
    }));
    expect(out.pairs[0]?.kinds).toEqual(["WRITE_WRITE"]);
  });

  it("does not make output.kind a conflict dimension", () => {
    const out = verdict(buildConflictGraph({
      envelopes: [
        envelope({ taskId: A, writeSet: ["a.ts"], outputKind: "REPORT" }),
        envelope({ taskId: B, writeSet: ["b.ts"], outputKind: "REPORT" }),
      ],
    }));
    expect(out.compatible).toBe(true);
  });
});

describe("fail-closed inputs", () => {
  // (l)
  it("refuses an invalid envelope, naming its index", () => {
    const out = buildConflictGraph({
      envelopes: [envelope(), {} as TaskEnvelope],
    });
    expect(refusal(out).reason).toBe("ENVELOPE_INVALID");
    expect(refusal(out).at).toBe("request.envelopes[1]");
  });

  // (m)
  it("refuses null and non-array input rather than throwing", () => {
    for (const [label, request, at] of [
      ["null request", null, "request"],
      ["envelopes not an array", { envelopes: "nope" }, "request.envelopes"],
      ["envelopes absent", {}, "request.envelopes"],
    ] as const) {
      const run = (): ConflictOutcome => buildConflictGraph(request as never);
      expect(run).not.toThrow();
      expect({ label, reason: refusal(run()).reason, at: refusal(run()).at }).toEqual({
        label,
        reason: "REQUEST_INVALID",
        at,
      });
    }
  });

  it("closes its kind and refusal sets", () => {
    expect([...CONFLICT_KINDS]).toEqual([...CONFLICT_KINDS].sort());
    expect([...GRAPH_REFUSALS]).toEqual([...GRAPH_REFUSALS].sort());
  });
});

describe("checkAdmission is the graph, restricted", () => {
  // (o)
  it("agrees with the full graph on every pair involving the candidate", () => {
    const admitted = [
      envelope({ taskId: A, writeSet: ["a.ts"] }),
      envelope({ taskId: B, writeSet: ["b.ts"] }),
    ];
    const candidate = envelope({ taskId: C, writeSet: ["a.ts"] });

    const restricted = verdict(checkAdmission({ admitted, candidate }));
    const complete = verdict(buildConflictGraph({ envelopes: [...admitted, candidate] }));

    const involvingCandidate = complete.pairs.filter(
      (p) => p.taskIdA === C || p.taskIdB === C,
    );
    expect(restricted.pairs).toEqual(involvingCandidate);
    expect(restricted.compatible).toBe(false);
  });

  it("ignores conflicts between already-admitted packets", () => {
    // Those were somebody else's decision; this call asks only about the
    // candidate.
    const admitted = [
      envelope({ taskId: A, writeSet: ["shared.ts"] }),
      envelope({ taskId: B, writeSet: ["shared.ts"] }),
    ];
    const candidate = envelope({ taskId: C, writeSet: ["own.ts"] });
    const out = verdict(checkAdmission({ admitted, candidate }));
    expect(out.pairs).toEqual([]);
    expect(out.compatible).toBe(true);
  });

  it("admits nothing into a corrupt admitted set", () => {
    // A duplicate id in the admitted set is a contradiction this module cannot
    // reason from, so no candidate is admitted, whatever it looks like.
    const admitted = [
      envelope({ taskId: A, writeSet: ["a.ts"] }),
      envelope({ taskId: A, writeSet: ["b.ts"] }),
    ];
    const out = verdict(checkAdmission({ admitted, candidate: envelope({ taskId: C, writeSet: ["z.ts"] }) }));
    expect(out.compatible).toBe(false);
    expect(out.duplicateTaskIds).toEqual([{ taskId: A, count: 2 }]);
  });

  it("admits a candidate into an empty set", () => {
    expect(verdict(checkAdmission({ admitted: [], candidate: envelope() })).compatible).toBe(true);
  });

  it("refuses a malformed candidate or admitted entry by name", () => {
    expect(
      refusal(checkAdmission({ admitted: [], candidate: {} as TaskEnvelope })).at,
    ).toBe("request.candidate");
    expect(
      refusal(checkAdmission({ admitted: [{} as TaskEnvelope], candidate: envelope() })).at,
    ).toBe("request.admitted[0]");
    const run = (): ConflictOutcome => checkAdmission(null as never);
    expect(run).not.toThrow();
    expect(refusal(run()).reason).toBe("REQUEST_INVALID");
  });
});

describe("the module's own laws", () => {
  it("names no clock, no dice, no git and no process", () => {
    const here = resolve(fileURLToPath(import.meta.url), "..");
    const source = readFileSync(join(here, "..", "..", "src", "conflict-graph", "index.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const token of [
      "Date.now", "new Date(", "Math.random", "process.env",
      "child_process", "spawn", "execFile", "node:fs", "simple-git",
    ]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });
});
