import { describe, expect, it } from "vitest";

import {
  diffRoadmapVersions,
  type RoadmapDiffSide,
  type RoadmapStepDependencyReadModel,
  type RoadmapStepReadModel,
  type RoadmapVersionReadModel,
} from "../../src/index.js";

/**
 * Evidence for the semantic diff between two roadmap versions (P-26 cut C, ADR
 * 0113).
 *
 * The function is pure over read-model rows, so these cases build rows by hand and
 * assert the diff over values: the keyed comparison, the pair sets, the echo that
 * tells a pre-cohort side from an empty one, `restores`, and the three refusals —
 * the `roles` one included, which is what makes the named absence a measurement.
 * The gateway suite drives the same function through the real route over a real
 * ledger.
 */

const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const OTHER_INITIATIVE = "55555555-5555-4555-8555-555555555555";
const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const V3 = "33333333-3333-4333-8333-333333333333";
const AT = "2026-09-24T12:00:00.000Z";

function version(
  roadmapVersionId: string,
  number: number,
  overrides: Partial<RoadmapVersionReadModel> = {},
): RoadmapVersionReadModel {
  return {
    roadmapVersionId,
    initiativeId: INITIATIVE,
    version: number,
    contentDigest: String(number).repeat(64).slice(0, 64),
    parentVersionId: null,
    kind: "EDIT",
    restoresVersionId: null,
    recordedBy: "kimi/k3/coordinator/01",
    recordedAt: AT,
    sequence: number + 1,
    recordingContractVersion: "2.10.0",
    stepCount: 0,
    stepManifestArtifactReferenceId: null,
    stepManifestSha256: null,
    ...overrides,
  };
}

function step(
  roadmapVersionId: string,
  stepId: string,
  stepIndex: number,
  overrides: Partial<RoadmapStepReadModel> = {},
): RoadmapStepReadModel {
  return {
    roadmapVersionId,
    stepId,
    stepIndex,
    title: "Step " + stepId,
    objectiveSha256: "a".repeat(63) + stepId.toLowerCase().slice(0, 1),
    acceptanceSha256: "b".repeat(64),
    expectedWriteSetSha256: "c".repeat(64),
    dependencyRank: 0,
    state: "DECLARED",
    routingAssignmentVersion: null,
    sequence: stepIndex + 10,
    ...overrides,
  };
}

function edge(roadmapVersionId: string, stepId: string, dependsOnStepId: string): RoadmapStepDependencyReadModel {
  return { roadmapVersionId, stepId, dependsOnStepId, sequence: 1 };
}

/** D1's v1: A, B(A), C(A). */
function sideOne(): RoadmapDiffSide {
  return {
    version: version(V1, 1, { stepCount: 3 }),
    steps: [step(V1, "A", 0), step(V1, "B", 1, { dependencyRank: 1 }), step(V1, "C", 2, { dependencyRank: 1 })],
    dependencies: [edge(V1, "B", "A"), edge(V1, "C", "A")],
  };
}

/** D1's v2: A, B(A) with a changed objective, D(B) — no C. */
function sideTwo(): RoadmapDiffSide {
  return {
    version: version(V2, 2, { stepCount: 3, parentVersionId: V1 }),
    steps: [
      step(V2, "A", 0),
      step(V2, "B", 1, { dependencyRank: 1, objectiveSha256: "d".repeat(64) }),
      step(V2, "D", 2, { dependencyRank: 2 }),
    ],
    dependencies: [edge(V2, "B", "A"), edge(V2, "D", "B")],
  };
}

function ok(outcome: ReturnType<typeof diffRoadmapVersions>) {
  if (!outcome.ok) throw new Error("expected a diff, got " + outcome.reason + " at " + outcome.at);
  return outcome.diff;
}

describe("diffRoadmapVersions compares two versions by stepId", () => {
  it("D1: added, removed, changed by field name, dependency pairs, content, and roles as a named absence", () => {
    const diff = ok(diffRoadmapVersions({ from: sideOne(), to: sideTwo(), restored: null }));
    expect(diff).toEqual({
      from: { version: 1, roadmapVersionId: V1, kind: "EDIT", stepCount: 3 },
      to: { version: 2, roadmapVersionId: V2, kind: "EDIT", stepCount: 3 },
      added: ["D"],
      removed: ["C"],
      changed: [{ stepId: "B", fields: ["objectiveSha256"] }],
      dependencies: {
        added: [{ stepId: "D", dependsOnStepId: "B" }],
        removed: [{ stepId: "C", dependsOnStepId: "A" }],
      },
      contentChanged: true,
      restores: null,
      roles: "STEP_ASSIGNMENTS_UNPRODUCED",
    });
  });

  it("carries no digest value, only the names of the fields that moved", () => {
    const serialized = JSON.stringify(ok(diffRoadmapVersions({ from: sideOne(), to: sideTwo(), restored: null })));
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toContain("Step ");
  });

  it("is the inverse the other way round, and empty against itself (D3)", () => {
    const back = ok(diffRoadmapVersions({ from: sideTwo(), to: sideOne(), restored: null }));
    expect([back.added, back.removed, back.changed]).toEqual([["C"], ["D"], [{ stepId: "B", fields: ["objectiveSha256"] }]]);
    expect(back.dependencies).toEqual({
      added: [{ stepId: "C", dependsOnStepId: "A" }],
      removed: [{ stepId: "D", dependsOnStepId: "B" }],
    });

    const same = ok(diffRoadmapVersions({ from: sideOne(), to: sideOne(), restored: null }));
    expect(same).toMatchObject({
      added: [],
      removed: [],
      changed: [],
      dependencies: { added: [], removed: [] },
      contentChanged: false,
      restores: null,
      roles: "STEP_ASSIGNMENTS_UNPRODUCED",
    });
  });

  it("reports a pure reorder as a stepIndex change, and a rank change beside its pairs", () => {
    const from = sideOne();
    const to: RoadmapDiffSide = {
      version: version(V2, 2, { stepCount: 3 }),
      steps: [step(V2, "A", 0), step(V2, "C", 1, { dependencyRank: 2 }), step(V2, "B", 2, { dependencyRank: 1 })],
      dependencies: [edge(V2, "B", "A"), edge(V2, "C", "B")],
    };
    const diff = ok(diffRoadmapVersions({ from, to, restored: null }));
    expect(diff.changed).toEqual([
      { stepId: "B", fields: ["stepIndex"] },
      { stepId: "C", fields: ["stepIndex", "dependencyRank"] },
    ]);
    expect(diff.dependencies).toEqual({
      added: [{ stepId: "C", dependsOnStepId: "B" }],
      removed: [{ stepId: "C", dependsOnStepId: "A" }],
    });
  });

  it("names every compared field in declared order, and never state or the routing column", () => {
    const from = sideOne();
    const to: RoadmapDiffSide = {
      version: version(V2, 2, { stepCount: 3 }),
      steps: [
        step(V2, "A", 3, {
          title: "Renamed",
          objectiveSha256: "1".repeat(64),
          acceptanceSha256: "2".repeat(64),
          expectedWriteSetSha256: "3".repeat(64),
          dependencyRank: 4,
          state: "READY",
          sequence: 99,
        }),
        step(V2, "B", 1, { dependencyRank: 1 }),
        step(V2, "C", 2, { dependencyRank: 1 }),
      ],
      dependencies: [edge(V2, "B", "A"), edge(V2, "C", "A")],
    };
    const diff = ok(diffRoadmapVersions({ from, to, restored: null }));
    expect(diff.changed).toEqual([
      {
        stepId: "A",
        fields: ["stepIndex", "title", "objectiveSha256", "acceptanceSha256", "expectedWriteSetSha256", "dependencyRank"],
      },
    ]);
  });

  it("sorts by code units, never by locale, so two readers agree", () => {
    const from: RoadmapDiffSide = { version: version(V1, 1), steps: [], dependencies: [] };
    const to: RoadmapDiffSide = {
      version: version(V2, 2, { stepCount: 4 }),
      steps: [step(V2, "b", 0), step(V2, "a", 1), step(V2, "B", 2), step(V2, "A", 3)],
      dependencies: [edge(V2, "b", "a"), edge(V2, "b", "B"), edge(V2, "B", "A")],
    };
    const diff = ok(diffRoadmapVersions({ from, to, restored: null }));
    expect(diff.added).toEqual(["A", "B", "a", "b"]);
    expect(diff.dependencies.added).toEqual([
      { stepId: "B", dependsOnStepId: "A" },
      { stepId: "b", dependsOnStepId: "B" },
      { stepId: "b", dependsOnStepId: "a" },
    ]);
  });

  it("freezes what it answers", () => {
    const diff = ok(diffRoadmapVersions({ from: sideOne(), to: sideTwo(), restored: null }));
    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff.added)).toBe(true);
    expect(Object.isFrozen(diff.changed[0]?.fields)).toBe(true);
    expect(Object.isFrozen(diff.dependencies.added)).toBe(true);
  });
});

describe("the echo tells a pre-cohort side from an empty one (D6)", () => {
  it("echoes stepCount null for a version recorded before steps, and 0 for one that declared none; both diff as no steps", () => {
    const precohort: RoadmapDiffSide = {
      version: version(V1, 1, { stepCount: null, recordingContractVersion: "2.9.0" }),
      steps: [],
      dependencies: [],
    };
    const stepless: RoadmapDiffSide = { version: version(V2, 2, { stepCount: 0 }), steps: [], dependencies: [] };
    const diff = ok(diffRoadmapVersions({ from: precohort, to: stepless, restored: null }));
    expect([diff.from.stepCount, diff.to.stepCount]).toEqual([null, 0]);
    expect([diff.added, diff.removed, diff.changed]).toEqual([[], [], []]);

    const grown = ok(diffRoadmapVersions({ from: precohort, to: { ...sideTwo(), version: version(V2, 2, { stepCount: 3 }) }, restored: null }));
    expect(grown.added).toEqual(["A", "B", "D"]);
    expect(grown.dependencies.added).toHaveLength(2);
  });
});

describe("restores is the trace of a rollback (D2)", () => {
  function rollbackSide(): RoadmapDiffSide {
    const one = sideOne();
    return {
      version: version(V3, 3, { stepCount: 3, kind: "ROLLBACK", restoresVersionId: V1, contentDigest: one.version.contentDigest }),
      steps: one.steps.map((row) => ({ ...row, roadmapVersionId: V3 })),
      dependencies: one.dependencies.map((row) => ({ ...row, roadmapVersionId: V3 })),
    };
  }

  it("v2 -> v3 is D1's inverse and names the restored version by number and id", () => {
    const diff = ok(diffRoadmapVersions({ from: sideTwo(), to: rollbackSide(), restored: sideOne().version }));
    expect([diff.added, diff.removed, diff.contentChanged]).toEqual([["C"], ["D"], true]);
    expect(diff.restores).toEqual({ version: 1, roadmapVersionId: V1 });
  });

  it("v1 -> v3 is empty, the content unchanged, and still names what v3 restores", () => {
    const diff = ok(diffRoadmapVersions({ from: sideOne(), to: rollbackSide(), restored: sideOne().version }));
    expect([diff.added, diff.removed, diff.changed, diff.contentChanged]).toEqual([[], [], [], false]);
    expect(diff.restores).toEqual({ version: 1, roadmapVersionId: V1 });
  });

  it("v3 -> v3 is the empty diff with restores null", () => {
    const diff = ok(diffRoadmapVersions({ from: rollbackSide(), to: rollbackSide(), restored: sideOne().version }));
    expect(diff.restores).toBeNull();
  });
});

describe("it refuses only rows the caller's resolution cannot produce", () => {
  it("versions of two initiatives", () => {
    const foreign = { ...sideTwo(), version: version(V2, 2, { initiativeId: OTHER_INITIATIVE }) };
    expect(diffRoadmapVersions({ from: sideOne(), to: foreign, restored: null })).toEqual({
      ok: false,
      reason: "VERSIONS_OF_TWO_INITIATIVES",
      at: "to.initiativeId",
    });
  });

  it("a step or dependency row of another version", () => {
    const strayStep = { ...sideTwo(), steps: [...sideTwo().steps, step(V1, "Z", 3)] };
    expect(diffRoadmapVersions({ from: sideOne(), to: strayStep, restored: null })).toEqual({
      ok: false,
      reason: "ROWS_OF_ANOTHER_VERSION",
      at: "to.steps.3",
    });
    const strayEdge = { ...sideOne(), dependencies: [edge(V1, "B", "A"), edge(V2, "C", "A")] };
    expect(diffRoadmapVersions({ from: strayEdge, to: sideTwo(), restored: null })).toEqual({
      ok: false,
      reason: "ROWS_OF_ANOTHER_VERSION",
      at: "from.dependencies.1",
    });
  });

  it("a restored version that is not the one `to` names, missing, given for an edit, or of another initiative", () => {
    const rollback = { ...sideOne(), version: version(V3, 3, { kind: "ROLLBACK", restoresVersionId: V1 }), steps: [], dependencies: [] };
    for (const restored of [null, sideTwo().version]) {
      expect(diffRoadmapVersions({ from: sideOne(), to: rollback, restored })).toMatchObject({ ok: false, reason: "ROWS_OF_ANOTHER_VERSION", at: "restored" });
    }
    expect(diffRoadmapVersions({ from: sideOne(), to: sideTwo(), restored: sideOne().version })).toMatchObject({
      ok: false,
      reason: "ROWS_OF_ANOTHER_VERSION",
      at: "restored",
    });
    expect(
      diffRoadmapVersions({ from: sideOne(), to: rollback, restored: version(V1, 1, { initiativeId: OTHER_INITIATIVE }) }),
    ).toMatchObject({ ok: false, reason: "VERSIONS_OF_TWO_INITIATIVES", at: "restored.initiativeId" });
  });

  it("a step row that carries a routing assignment: the named absence is measured, not written", () => {
    // Boundary: one assignment on one row of one side is enough, on either side,
    // at the smallest value the column admits.
    for (const which of ["from", "to"] as const) {
      const planted = which === "from" ? sideOne() : sideTwo();
      const assigned = { ...planted, steps: planted.steps.map((row, index) => (index === 1 ? { ...row, routingAssignmentVersion: 1 } : row)) };
      const input = which === "from" ? { from: assigned, to: sideTwo(), restored: null } : { from: sideOne(), to: assigned, restored: null };
      expect(diffRoadmapVersions(input)).toEqual({ ok: false, reason: "STEP_ASSIGNMENT_PRESENT", at: "B" });
    }
  });
});
