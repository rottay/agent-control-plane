import type { RoadmapStepReadModel, RoadmapVersionReadModel } from "../types/index.js";

import type {
  RoadmapDiffChange,
  RoadmapDiffDependency,
  RoadmapDiffField,
  RoadmapDiffInput,
  RoadmapDiffOutcome,
  RoadmapDiffRefusal,
  RoadmapDiffSide,
  RoadmapDiffVersion,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`,
 * and are re-exported here unchanged (owner law §7).
 */
export type {
  RoadmapDiff,
  RoadmapDiffChange,
  RoadmapDiffDependency,
  RoadmapDiffField,
  RoadmapDiffInput,
  RoadmapDiffOutcome,
  RoadmapDiffRefusal,
  RoadmapDiffRoles,
  RoadmapDiffSide,
  RoadmapDiffVersion,
} from "./types/index.js";

/**
 * The semantic diff between two roadmap versions — P-26 cut C, requirement A10,
 * ADR 0113.
 *
 * Pure. It receives read-model rows the caller already resolved — two versions of
 * one initiative, each with its steps and dependencies, and the version a rollback
 * restores — and reads no ledger, no clock and no plane. It adds no ledger read:
 * the caller composes `listRoadmapVersions`, `listRoadmapSteps` and
 * `listRoadmapStepDependencies`.
 *
 * ## What it compares
 *
 * Steps are keyed by `stepId`, which the contract keeps stable across versions for
 * this diff. `added` and `removed` are stepIds; `changed` names, for a step in
 * both, the fields that differ, by **name** — the digests are compared, never
 * carried. Two of them owe a sentence:
 *
 * - `stepIndex` is **manifest position**, not topological order. A pure reorder
 *   reports a change, because the position is declared.
 * - `dependencyRank` is **derived** from the dependency pairs, so it reports twice
 *   with `dependencies`. It is kept because P-27's READY predicate consumes the
 *   rank.
 *
 * `dependencies` is the pair sets' difference, order-free, so a forward reference
 * needs no special case. `contentChanged` is whether the two versions name
 * different document bytes; a text diff of the document is not here — it is the
 * client's, from two content reads.
 *
 * ## `roles`: a named absence, measured
 *
 * `STEP_ASSIGNMENTS_UNPRODUCED` says the STEP scope has no producer in this build.
 * Planning §6 resolves a step's roles `STEP` > `INITIATIVE` > `GLOBAL`; the
 * initiative stream folds no assignment and the registry publishes GLOBAL only, so
 * every step's effective roles are the GLOBAL assignment — a property of the plane,
 * not of a version, and nothing a version diff can attribute. The word does not say
 * the steps have no roles. It is derived from the rows: it is answered only when
 * every step row of both sides carries no `routingAssignmentVersion`, and a row
 * that carries one is refused, because no producer can have written it. P-28 owns
 * the replacement: the per-step diff of assignments.
 *
 * ## What it refuses
 *
 * Only rows the route's own resolution cannot produce: versions of two
 * initiatives, rows of another version, a `restored` that is not the version `to`
 * names, and a step assignment. An unknown version is the caller's to answer — the
 * number is resolved inside the initiative before this is called.
 */
export function diffRoadmapVersions(input: RoadmapDiffInput): RoadmapDiffOutcome {
  const { from, to, restored } = input;

  if (from.version.initiativeId !== to.version.initiativeId) {
    return refuse("VERSIONS_OF_TWO_INITIATIVES", "to.initiativeId");
  }
  if (to.version.kind === "ROLLBACK") {
    if (restored === null || restored.roadmapVersionId !== to.version.restoresVersionId) {
      return refuse("ROWS_OF_ANOTHER_VERSION", "restored");
    }
    if (restored.initiativeId !== to.version.initiativeId) {
      return refuse("VERSIONS_OF_TWO_INITIATIVES", "restored.initiativeId");
    }
  } else if (restored !== null) {
    return refuse("ROWS_OF_ANOTHER_VERSION", "restored");
  }

  for (const [label, side] of [
    ["from", from],
    ["to", to],
  ] as const) {
    const misplaced = rowsOfAnotherVersion(side);
    if (misplaced !== null) return refuse("ROWS_OF_ANOTHER_VERSION", label + "." + misplaced);
    const assigned = side.steps.find((step) => step.routingAssignmentVersion !== null);
    if (assigned !== undefined) return refuse("STEP_ASSIGNMENT_PRESENT", assigned.stepId);
  }

  const before = new Map(from.steps.map((step) => [step.stepId, step]));
  const after = new Map(to.steps.map((step) => [step.stepId, step]));

  const added = [...after.keys()].filter((stepId) => !before.has(stepId)).sort(byCodeUnits);
  const removed = [...before.keys()].filter((stepId) => !after.has(stepId)).sort(byCodeUnits);

  const changed: RoadmapDiffChange[] = [];
  for (const stepId of [...after.keys()].sort(byCodeUnits)) {
    const left = before.get(stepId);
    const right = after.get(stepId);
    if (left === undefined || right === undefined) continue;
    const fields = COMPARED_FIELDS.filter((field) => left[field] !== right[field]);
    if (fields.length > 0) changed.push(Object.freeze({ stepId, fields: Object.freeze(fields) }));
  }

  const fromPairs = pairsOf(from);
  const toPairs = pairsOf(to);

  const differs = from.version.roadmapVersionId !== to.version.roadmapVersionId;
  return Object.freeze({
    ok: true as const,
    diff: Object.freeze({
      from: echo(from.version),
      to: echo(to.version),
      added: Object.freeze(added),
      removed: Object.freeze(removed),
      changed: Object.freeze(changed),
      dependencies: Object.freeze({
        added: Object.freeze(difference(toPairs, fromPairs)),
        removed: Object.freeze(difference(fromPairs, toPairs)),
      }),
      contentChanged: from.version.contentDigest !== to.version.contentDigest,
      restores:
        differs && restored !== null
          ? Object.freeze({ version: restored.version, roadmapVersionId: restored.roadmapVersionId })
          : null,
      roles: "STEP_ASSIGNMENTS_UNPRODUCED" as const,
    }),
  });
}

/** The compared fields, in the order `changed[].fields` reports them. */
const COMPARED_FIELDS: readonly (RoadmapDiffField & keyof RoadmapStepReadModel)[] = Object.freeze([
  "stepIndex",
  "title",
  "objectiveSha256",
  "acceptanceSha256",
  "expectedWriteSetSha256",
  "dependencyRank",
]);

function refuse(reason: RoadmapDiffRefusal, at: string): RoadmapDiffOutcome {
  return Object.freeze({ ok: false as const, reason, at });
}

/** Code-unit order: total and locale-free, so two readers sort one way. */
function byCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function echo(version: RoadmapVersionReadModel): RoadmapDiffVersion {
  return Object.freeze({
    version: version.version,
    roadmapVersionId: version.roadmapVersionId,
    kind: version.kind,
    stepCount: version.stepCount,
  });
}

/** The field path of the first row naming another version than its side's, or null. */
function rowsOfAnotherVersion(side: RoadmapDiffSide): string | null {
  const id = side.version.roadmapVersionId;
  const step = side.steps.findIndex((row) => row.roadmapVersionId !== id);
  if (step !== -1) return "steps." + String(step);
  const dependency = side.dependencies.findIndex((row) => row.roadmapVersionId !== id);
  if (dependency !== -1) return "dependencies." + String(dependency);
  return null;
}

/** One key per pair; stepIds are bounded identifiers, so a newline cannot occur in one. */
function pairsOf(side: RoadmapDiffSide): ReadonlyMap<string, RoadmapDiffDependency> {
  const pairs = new Map<string, RoadmapDiffDependency>();
  for (const row of side.dependencies) {
    pairs.set(row.stepId + "\n" + row.dependsOnStepId, { stepId: row.stepId, dependsOnStepId: row.dependsOnStepId });
  }
  return pairs;
}

function difference(
  left: ReadonlyMap<string, RoadmapDiffDependency>,
  right: ReadonlyMap<string, RoadmapDiffDependency>,
): RoadmapDiffDependency[] {
  return [...left.entries()]
    .filter(([key]) => !right.has(key))
    .map(([, pair]) => Object.freeze({ ...pair }))
    .sort((a, b) => byCodeUnits(a.stepId, b.stepId) || byCodeUnits(a.dependsOnStepId, b.dependsOnStepId));
}
