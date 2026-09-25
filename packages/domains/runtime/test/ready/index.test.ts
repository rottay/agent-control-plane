import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { READY_UNKNOWN_REASONS, READY_UNSATISFIED_REASONS, evaluateReady } from "../../src/ready/index.js";
import type { ReadyEdge, ReadyInput, ReadyTaskStateV2, ReadyVerdict } from "../../src/ready/index.js";

/**
 * The READY predicate, over values (P-27 cut A, ADR 0115; requirement A5).
 *
 * The oracle is the definition of the three failure policies (ND-P27-1 adjudication,
 * items 3 and 4): one test per cell, fifteen over the V2 terminals and pending, and
 * two rows under every policy for an effect whose outcome is unknown and for a legacy
 * dependency. Then one test per reason, each driven by the one input that produces it
 * from a node that is otherwise READY, so each is red without its producer.
 */

const READY_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/ready/index.ts");
const NOW = "2026-09-25T12:00:00.000Z";
const LATER = "2026-09-25T13:00:00.000Z";
const EARLIER = "2026-09-25T11:00:00.000Z";
const DIGEST = "a".repeat(64);

/** A node every condition of which is satisfied. */
function readyNode(overrides: Partial<ReadyInput> = {}): ReadyInput {
  return {
    graphRevisionCurrent: true,
    taskRevisionCurrent: true,
    taskLinkCurrent: true,
    taskState: { vocabulary: "TASK_V2", value: "CLASSIFIED" },
    dependencies: [],
    stepState: "READY",
    stepHasDependsOn: false,
    initiativeStatus: "ACTIVE",
    assignmentResolved: true,
    approval: { produced: true, required: false },
    now: NOW,
    ...overrides,
  };
}

function edge(failPolicy: ReadyEdge["failPolicy"], value: ReadyTaskStateV2, effectOutcomeUnknown = false): ReadyEdge {
  return { failPolicy, dependency: { produced: true, state: { vocabulary: "TASK_V2", value }, effectOutcomeUnknown } };
}

function r2(edges: readonly ReadyEdge[]): ReadyVerdict {
  return evaluateReady(readyNode({ dependencies: edges })).conditions.R2;
}

const SAT: ReadyVerdict = { verdict: "SATISFIED" };
const unsat = (reason: string) => ({ verdict: "UNSATISFIED", reason });
const unknown = (reason: string) => ({ verdict: "UNKNOWN", reason });

describe("the READY reasons are two closed, sorted vocabularies (P-27 cut A)", () => {
  it("names the twelve known blocks, sorted", () => {
    // Eleven until P-27 cut C's TASK_LINK_MOVED, between STEP_NOT_ADMITTING and
    // TASK_NOT_CLASSIFIED.
    expect([...READY_UNSATISFIED_REASONS]).toEqual([...READY_UNSATISFIED_REASONS].sort());
    expect([...READY_UNSATISFIED_REASONS]).toEqual([
      "APPROVAL_REQUIRED",
      "APPROVAL_STALE",
      "ASSIGNMENT_UNRESOLVED",
      "DEPENDENCY_BLOCKED",
      "DEPENDENCY_PENDING",
      "DEPENDENCY_QUARANTINED",
      "GRAPH_REVISION_SUPERSEDED",
      "INITIATIVE_NOT_ACTIVE",
      "STEP_NOT_ADMITTING",
      "TASK_LINK_MOVED",
      "TASK_NOT_CLASSIFIED",
      "TASK_REVISION_SUPERSEDED",
    ]);
  });

  it("names the seven absences, sorted, and no word in both", () => {
    expect([...READY_UNKNOWN_REASONS]).toEqual([...READY_UNKNOWN_REASONS].sort());
    expect([...READY_UNKNOWN_REASONS]).toEqual([
      "APPROVAL_UNPRODUCED",
      "DEPENDENCY_COHORT_LEGACY",
      "DEPENDENCY_OUTCOME_UNKNOWN",
      "DEPENDENCY_OUTCOME_UNPRODUCED",
      "INSTANT_UNAVAILABLE",
      "STEP_DEPENDENCIES_UNPRODUCED",
      "TASK_COHORT_LEGACY",
    ]);
    const both = READY_UNSATISFIED_REASONS.filter((word) => (READY_UNKNOWN_REASONS as readonly string[]).includes(word));
    expect(both).toEqual([]);
  });
});

describe("the oracle: the definition of the three policies, one test per cell", () => {
  const CELLS: readonly (readonly [ReadyEdge["failPolicy"], ReadyTaskStateV2, ReadyVerdict])[] = [
    ["WAIT_SUCCESS", "COMPLETED", SAT],
    ["WAIT_SUCCESS", "FAILED", unsat("DEPENDENCY_BLOCKED") as ReadyVerdict],
    ["WAIT_SUCCESS", "CANCELLED", unsat("DEPENDENCY_BLOCKED") as ReadyVerdict],
    ["WAIT_SUCCESS", "SUSPECT_WORKTREE", unsat("DEPENDENCY_QUARANTINED") as ReadyVerdict],
    ["WAIT_SUCCESS", "RUNNING", unsat("DEPENDENCY_PENDING") as ReadyVerdict],
    ["ALLOW_FAILURE", "COMPLETED", SAT],
    ["ALLOW_FAILURE", "FAILED", SAT],
    ["ALLOW_FAILURE", "CANCELLED", unsat("DEPENDENCY_BLOCKED") as ReadyVerdict],
    ["ALLOW_FAILURE", "SUSPECT_WORKTREE", unsat("DEPENDENCY_QUARANTINED") as ReadyVerdict],
    ["ALLOW_FAILURE", "RUNNING", unsat("DEPENDENCY_PENDING") as ReadyVerdict],
    ["REQUIRE_TERMINAL", "COMPLETED", SAT],
    ["REQUIRE_TERMINAL", "FAILED", SAT],
    ["REQUIRE_TERMINAL", "CANCELLED", SAT],
    ["REQUIRE_TERMINAL", "SUSPECT_WORKTREE", unsat("DEPENDENCY_QUARANTINED") as ReadyVerdict],
    ["REQUIRE_TERMINAL", "RUNNING", unsat("DEPENDENCY_PENDING") as ReadyVerdict],
  ];

  for (const [policy, state, expected] of CELLS) {
    it(policy + " over " + (state === "RUNNING" ? "a dependency not ended" : state) + " is " + expected.verdict, () => {
      expect(r2([edge(policy, state)])).toEqual(expected);
      expect(evaluateReady(readyNode({ dependencies: [edge(policy, state)] })).ready).toBe(expected.verdict === "SATISFIED");
    });
  }

  for (const policy of ["WAIT_SUCCESS", "ALLOW_FAILURE", "REQUIRE_TERMINAL"] as const) {
    it(policy + " over an effect in OUTCOME_UNKNOWN is UNKNOWN, even on COMPLETED: unknown is not a failure", () => {
      expect(r2([edge(policy, "COMPLETED", true)])).toEqual(unknown("DEPENDENCY_OUTCOME_UNKNOWN"));
      expect(evaluateReady(readyNode({ dependencies: [edge(policy, "COMPLETED", true)] })).ready).toBe(false);
    });

    it(policy + " over a legacy terminal is UNKNOWN: a legacy terminal satisfies no policy", () => {
      for (const value of ["CHECKPOINTED", "REJECTED", "FAILED", "CANCELLED", "SUSPECT_WORKTREE"]) {
        const legacy: ReadyEdge = { failPolicy: policy, dependency: { produced: true, state: { vocabulary: "LEGACY", value }, effectOutcomeUnknown: false } };
        expect({ value, verdict: r2([legacy]) }).toEqual({ value, verdict: unknown("DEPENDENCY_COHORT_LEGACY") });
      }
    });
  }

  it("covers every pending V2 state as pending, never as satisfied", () => {
    for (const value of ["DISCOVERED", "CLASSIFIED", "READY", "RESERVED", "RUNNING", "WAITING_APPROVAL", "VERIFYING", "AUDITING", "READY_TO_COMMIT", "COMMITTED", "CHECKPOINTED"] as const) {
      expect({ value, verdict: r2([edge("REQUIRE_TERMINAL", value)]) }).toEqual({ value, verdict: unsat("DEPENDENCY_PENDING") });
    }
  });
});

describe("each reason has one producer, and is red without it", () => {
  it("a node with no block and no absence is READY: the baseline every producer below varies once", () => {
    const evaluation = evaluateReady(readyNode());
    expect(evaluation).toEqual({ ready: true, conditions: { R1: SAT, R2: SAT, R3: SAT, R4: SAT } });
  });

  const PRODUCERS: readonly (readonly [string, "R1" | "R2" | "R3" | "R4", ReadyVerdict, Partial<ReadyInput>])[] = [
    ["GRAPH_REVISION_SUPERSEDED", "R1", unsat("GRAPH_REVISION_SUPERSEDED") as ReadyVerdict, { graphRevisionCurrent: false }],
    ["TASK_REVISION_SUPERSEDED", "R1", unsat("TASK_REVISION_SUPERSEDED") as ReadyVerdict, { taskRevisionCurrent: false }],
    // P-27 cut C: the task's current link is another step (a re-link moved it), or it
    // has none at all -- a block by definition, not an absence.
    ["TASK_LINK_MOVED", "R1", unsat("TASK_LINK_MOVED") as ReadyVerdict, { taskLinkCurrent: false }],
    ["TASK_NOT_CLASSIFIED", "R1", unsat("TASK_NOT_CLASSIFIED") as ReadyVerdict, { taskState: { vocabulary: "TASK_V2", value: "DISCOVERED" } }],
    ["TASK_COHORT_LEGACY", "R1", unknown("TASK_COHORT_LEGACY") as ReadyVerdict, { taskState: { vocabulary: "LEGACY", value: "DT_CLASSIFIED" } }],
    ["DEPENDENCY_PENDING", "R2", unsat("DEPENDENCY_PENDING") as ReadyVerdict, { dependencies: [edge("WAIT_SUCCESS", "RUNNING")] }],
    ["DEPENDENCY_BLOCKED", "R2", unsat("DEPENDENCY_BLOCKED") as ReadyVerdict, { dependencies: [edge("WAIT_SUCCESS", "FAILED")] }],
    ["DEPENDENCY_QUARANTINED", "R2", unsat("DEPENDENCY_QUARANTINED") as ReadyVerdict, { dependencies: [edge("REQUIRE_TERMINAL", "SUSPECT_WORKTREE")] }],
    ["DEPENDENCY_OUTCOME_UNKNOWN", "R2", unknown("DEPENDENCY_OUTCOME_UNKNOWN") as ReadyVerdict, { dependencies: [edge("WAIT_SUCCESS", "COMPLETED", true)] }],
    [
      "DEPENDENCY_COHORT_LEGACY",
      "R2",
      unknown("DEPENDENCY_COHORT_LEGACY") as ReadyVerdict,
      { dependencies: [{ failPolicy: "WAIT_SUCCESS", dependency: { produced: true, state: { vocabulary: "LEGACY", value: "CHECKPOINTED" }, effectOutcomeUnknown: false } }] },
    ],
    [
      "DEPENDENCY_OUTCOME_UNPRODUCED",
      "R2",
      unknown("DEPENDENCY_OUTCOME_UNPRODUCED") as ReadyVerdict,
      { dependencies: [{ failPolicy: "WAIT_SUCCESS", dependency: { produced: false } }] },
    ],
    ["STEP_NOT_ADMITTING", "R3", unsat("STEP_NOT_ADMITTING") as ReadyVerdict, { stepState: "PAUSED" }],
    ["STEP_DEPENDENCIES_UNPRODUCED", "R3", unknown("STEP_DEPENDENCIES_UNPRODUCED") as ReadyVerdict, { stepState: "DECLARED", stepHasDependsOn: true }],
    ["INITIATIVE_NOT_ACTIVE", "R3", unsat("INITIATIVE_NOT_ACTIVE") as ReadyVerdict, { initiativeStatus: "PAUSED" }],
    ["ASSIGNMENT_UNRESOLVED", "R4", unsat("ASSIGNMENT_UNRESOLVED") as ReadyVerdict, { assignmentResolved: false }],
    ["APPROVAL_UNPRODUCED", "R4", unknown("APPROVAL_UNPRODUCED") as ReadyVerdict, { approval: { produced: false } }],
    [
      "APPROVAL_REQUIRED",
      "R4",
      unsat("APPROVAL_REQUIRED") as ReadyVerdict,
      { approval: { produced: true, required: true, subjectRevisionSha256: DIGEST, approval: null } },
    ],
    [
      "APPROVAL_STALE",
      "R4",
      unsat("APPROVAL_STALE") as ReadyVerdict,
      {
        approval: {
          produced: true,
          required: true,
          subjectRevisionSha256: DIGEST,
          approval: { subjectKind: "TASK", state: "REVOKED", subjectRevisionSha256: DIGEST, expiresAt: null },
        },
      },
    ],
    [
      "INSTANT_UNAVAILABLE",
      "R4",
      unknown("INSTANT_UNAVAILABLE") as ReadyVerdict,
      {
        now: null,
        approval: {
          produced: true,
          required: true,
          subjectRevisionSha256: DIGEST,
          approval: { subjectKind: "STEP", state: "GRANTED", subjectRevisionSha256: DIGEST, expiresAt: LATER },
        },
      },
    ],
  ];

  it("has exactly one producer row per word of the two vocabularies", () => {
    expect(PRODUCERS.map(([word]) => word).sort()).toEqual([...READY_UNSATISFIED_REASONS, ...READY_UNKNOWN_REASONS].sort());
  });

  for (const [word, condition, expected, input] of PRODUCERS) {
    it(word + " is produced on " + condition + " by its one input, and never READY", () => {
      const evaluation = evaluateReady(readyNode(input));
      expect(evaluation.conditions[condition]).toEqual(expected);
      expect(evaluation.ready).toBe(false);
      // Every other condition stays satisfied: the word is this input's and no other.
      for (const other of ["R1", "R2", "R3", "R4"] as const) {
        if (other !== condition) expect({ other, verdict: evaluation.conditions[other] }).toEqual({ other, verdict: SAT });
      }
    });
  }
});

describe("the conditions' rules, beside the producers", () => {
  it("R3 admits READY and RUNNING, and DECLARED only with no dependsOn; PAUSED, DONE and CANCELLED do not admit", () => {
    const r3 = (input: Partial<ReadyInput>) => evaluateReady(readyNode(input)).conditions.R3;
    expect(r3({ stepState: "RUNNING" })).toEqual(SAT);
    expect(r3({ stepState: "DECLARED", stepHasDependsOn: false })).toEqual(SAT);
    for (const stepState of ["PAUSED", "DONE", "CANCELLED"] as const) {
      expect({ stepState, verdict: r3({ stepState }) }).toEqual({ stepState, verdict: unsat("STEP_NOT_ADMITTING") });
    }
    for (const initiativeStatus of ["PAUSED", "COMPLETED", "ARCHIVED"] as const) {
      expect(r3({ initiativeStatus })).toEqual(unsat("INITIATIVE_NOT_ACTIVE"));
    }
  });

  it("R4's approval: in force until its expiry against the injected instant, bound to the digest, stale by event", () => {
    const approval = (row: Record<string, unknown>, now: string | null = NOW) =>
      evaluateReady(
        readyNode({
          now,
          approval: {
            produced: true,
            required: true,
            subjectRevisionSha256: DIGEST,
            approval: { subjectKind: "PLAN", state: "GRANTED", subjectRevisionSha256: DIGEST, expiresAt: null, ...row } as never,
          },
        }),
      ).conditions.R4;
    expect(approval({})).toEqual(SAT);
    expect(approval({}, null)).toEqual(SAT);
    expect(approval({ expiresAt: LATER })).toEqual(SAT);
    expect(approval({ expiresAt: EARLIER })).toEqual(unsat("APPROVAL_STALE"));
    expect(approval({ expiresAt: NOW })).toEqual(unsat("APPROVAL_STALE"));
    expect(approval({ expiresAt: LATER }, null)).toEqual(unknown("INSTANT_UNAVAILABLE"));
    expect(approval({ expiresAt: LATER }, "2026-09-25T12:00:00Z")).toEqual(unknown("INSTANT_UNAVAILABLE"));
    expect(approval({ expiresAt: "tomorrow" })).toEqual(unsat("APPROVAL_STALE"));
    expect(approval({ subjectRevisionSha256: "b".repeat(64) })).toEqual(unsat("APPROVAL_STALE"));
    expect(approval({ state: "EXPIRED" })).toEqual(unsat("APPROVAL_STALE"));
    for (const state of ["PENDING", "DENIED", "CANCELLED"]) {
      expect({ state, verdict: approval({ state }) }).toEqual({ state, verdict: unsat("APPROVAL_REQUIRED") });
    }
  });

  it("a known block outranks an absence within a condition, and the first of each wins", () => {
    const mixed = evaluateReady(
      readyNode({
        dependencies: [
          { failPolicy: "WAIT_SUCCESS", dependency: { produced: false } },
          edge("WAIT_SUCCESS", "FAILED"),
          edge("WAIT_SUCCESS", "RUNNING"),
        ],
      }),
    );
    expect(mixed.conditions.R2).toEqual(unsat("DEPENDENCY_BLOCKED"));
    const r1 = evaluateReady(readyNode({ graphRevisionCurrent: false, taskState: { vocabulary: "LEGACY", value: "DT_CLASSIFIED" } }));
    expect(r1.conditions.R1).toEqual(unsat("GRAPH_REVISION_SUPERSEDED"));
    const r4 = evaluateReady(readyNode({ assignmentResolved: false, approval: { produced: false } }));
    expect(r4.conditions.R4).toEqual(unsat("ASSIGNMENT_UNRESOLVED"));
  });

  it("R1's clauses in order: graph superseded, task superseded, link moved, then the cohort (P-27 cut C)", () => {
    const r1 = (input: Partial<ReadyInput>) => evaluateReady(readyNode(input)).conditions.R1;
    const legacy = { vocabulary: "LEGACY", value: "DISCOVERED" } as const;
    expect(r1({ graphRevisionCurrent: false, taskRevisionCurrent: false, taskLinkCurrent: false })).toEqual(
      unsat("GRAPH_REVISION_SUPERSEDED"),
    );
    expect(r1({ taskRevisionCurrent: false, taskLinkCurrent: false })).toEqual(unsat("TASK_REVISION_SUPERSEDED"));
    expect(r1({ taskLinkCurrent: false, taskState: { vocabulary: "TASK_V2", value: "DISCOVERED" } })).toEqual(
      unsat("TASK_LINK_MOVED"),
    );
    // A known block outranks the cohort's absence: a moved legacy task reads the block.
    expect(r1({ taskLinkCurrent: false, taskState: legacy })).toEqual(unsat("TASK_LINK_MOVED"));
    expect(r1({ taskState: legacy })).toEqual(unknown("TASK_COHORT_LEGACY"));
  });

  it("production's shape reads no node READY: legacy task, unproduced approval", () => {
    const production = evaluateReady(
      readyNode({ taskState: { vocabulary: "LEGACY", value: "DISCOVERED" }, approval: { produced: false } }),
    );
    expect(production).toEqual({
      ready: false,
      conditions: { R1: unknown("TASK_COHORT_LEGACY"), R2: SAT, R3: SAT, R4: unknown("APPROVAL_UNPRODUCED") },
    });
  });

  it("production's shape of a moved node reads the block on R1, never READY (P-27 cut C)", () => {
    const moved = evaluateReady(
      readyNode({ taskLinkCurrent: false, taskState: { vocabulary: "LEGACY", value: "DISCOVERED" }, approval: { produced: false } }),
    );
    expect(moved).toEqual({
      ready: false,
      conditions: { R1: unsat("TASK_LINK_MOVED"), R2: SAT, R3: SAT, R4: unknown("APPROVAL_UNPRODUCED") },
    });
  });

  it("is pure: the same input answers the same, frozen, and the module reads no clock", () => {
    const input = readyNode({ dependencies: [edge("ALLOW_FAILURE", "FAILED")] });
    expect(evaluateReady(input)).toEqual(evaluateReady(input));
    expect(Object.isFrozen(evaluateReady(input))).toBe(true);
    const source = readFileSync(READY_SOURCE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/\bDate\b|performance|hrtime/);
  });
});
