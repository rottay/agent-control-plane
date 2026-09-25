import { describe, expect, it } from "vitest";

import {
  API_ALLOWED_METHODS,
  API_ROUTES,
  API_ROUTE_PATTERNS,
  API_PRIVATE_READ_ROUTES,
  API_WRITE_ROUTES,
  isPrivateReadRoute,
  isWriteRoute,
  taskEffectResultPath,
  taskEffectsPath,
  accountActionsPath,
  initiativeAgentsPath,
  initiativeEventsPath,
  initiativePath,
  initiativeRoadmapContentPath,
  initiativeRoadmapDiffPath,
  initiativeRoadmapPath,
  initiativeRoadmapStepsPath,
  initiativeStepGraphPath,
  initiativeTaskStepPath,
  taskPath,
  workerPath,
} from "../../src/routes/index.js";
import {
  accountId,
  forAll,
  makeRandom,
  outsideAccountId,
  outsideIdentity,
  outsideUuid,
  uuidV4,
  workerIdentity,
} from "./helpers/index.js";

/**
 * The route grammar, as properties (P8-T G9).
 *
 * The module's first test. Everything it asserts is generated: the point of a
 * property class is to reach the cases a table of examples does not contain,
 * and the route builders' whole job is to be total over a grammar rather than
 * correct on a list.
 *
 * **What this class claims, precisely.** It is the PROTOCOL-INTERNAL round
 * trip: `format(id)` → the captured path segment → `decodeURIComponent` →
 * exactly `id`. It is NOT an end-to-end grammar round-trip, and does not
 * pretend to be — `TaskIdParam` and its siblings are module-private, so the
 * honest oracle is exact recovery of the input, not a re-parse through the
 * schema that produced it. The gateway's own parsers are covered by the
 * gateway's trees; nothing here speaks for them.
 *
 * **The outside-grammar side is constructive.** Every refusal case is built to
 * violate one named rule — wrong length, illegal character, traversal shape,
 * empty, reserved characters — rather than drawn at random and filtered. A
 * filtered generator tests the filter; a constructed one tests the grammar, and
 * says which rule it was testing when it fails.
 */

const ITERATIONS = 200;

/** Recover the last path segment a builder appended, undoing the encoding. */
function lastSegment(path: string): string {
  const parts = path.split("/");
  const tail = parts[parts.length - 1];
  if (tail === undefined) throw new Error("empty path");
  return decodeURIComponent(tail);
}

/** Recover the segment before a fixed suffix (`/roadmap`, `/actions`, …). */
function segmentBefore(path: string, suffix: string): string {
  if (!path.endsWith(suffix)) throw new Error("path does not end with " + suffix);
  return lastSegment(path.slice(0, path.length - suffix.length));
}

describe("the route grammar round-trips every identifier it accepts (G9)", () => {
  it("recovers a task id from the path it builds", () => {
    forAll("taskPath round-trip", 0x5eed_0001, ITERATIONS, uuidV4, (id) => {
      expect(lastSegment(taskPath(id))).toBe(id);
    });
  });

  it("recovers a worker identity, separators and all", () => {
    // The interesting case: an identity contains slashes, so a builder that
    // failed to encode it would produce a path with extra separators and the
    // recovered segment would be a fragment. Recovery is the assertion that the
    // identity survives as ONE component.
    forAll("workerPath round-trip", 0x5eed_0002, ITERATIONS, workerIdentity, (identity) => {
      const path = workerPath(identity);
      expect(lastSegment(path)).toBe(identity);
      // Exactly one segment more than the collection route: the identity's own
      // slashes are encoded, not passed through as separators.
      expect(path.split("/").length).toBe(API_ROUTES.workers.split("/").length + 1);
    });
  });

  it("recovers an initiative id from every path built on it", () => {
    forAll("initiative paths round-trip", 0x5eed_0003, ITERATIONS, uuidV4, (id) => {
      expect(lastSegment(initiativePath(id))).toBe(id);
      expect(segmentBefore(initiativeRoadmapPath(id), "/roadmap")).toBe(id);
      expect(segmentBefore(initiativeEventsPath(id), "/events")).toBe(id);
      expect(segmentBefore(initiativeAgentsPath(id), "/agents")).toBe(id);
      expect(segmentBefore(initiativeRoadmapContentPath(id), "/roadmap/content")).toBe(id);
      expect(segmentBefore(initiativeRoadmapStepsPath(id), "/roadmap/steps")).toBe(id);
      expect(segmentBefore(initiativeRoadmapDiffPath(id), "/roadmap/diff")).toBe(id);
    });
  });

  it("recovers an account id from the actions path", () => {
    forAll("accountActionsPath round-trip", 0x5eed_0004, ITERATIONS, accountId, (id) => {
      expect(segmentBefore(accountActionsPath(id), "/actions")).toBe(id);
    });
  });

  it("keeps every built path inside the api namespace", () => {
    // A round-trip alone would be satisfied by a builder that emitted the
    // identifier and nothing else. This is the other half: whatever the input,
    // the output is a path under the versioned prefix.
    forAll("paths stay under /api/v1", 0x5eed_0005, ITERATIONS, uuidV4, (id) => {
      for (const path of [taskPath(id), initiativePath(id), initiativeRoadmapPath(id)]) {
        expect(path.startsWith("/api/v1/")).toBe(true);
      }
    });
  });
});

describe("the route grammar refuses every identifier outside it (G9)", () => {
  it("refuses non-uuid task and initiative identifiers, by violation class", () => {
    forAll("taskPath refuses outside-grammar", 0x5eed_0011, ITERATIONS, outsideUuid, (badCase) => {
      expect(() => taskPath(badCase.value), badCase.violation).toThrow();
      expect(() => initiativePath(badCase.value), badCase.violation).toThrow();
      expect(() => initiativeRoadmapStepsPath(badCase.value), badCase.violation).toThrow();
      expect(() => initiativeRoadmapDiffPath(badCase.value), badCase.violation).toThrow();
    });
  });

  it("refuses malformed worker identities, by violation class", () => {
    forAll("workerPath refuses outside-grammar", 0x5eed_0012, ITERATIONS, outsideIdentity, (badCase) => {
      expect(() => workerPath(badCase.value), badCase.violation).toThrow();
    });
  });

  it("refuses account ids that are path segments rather than labels", () => {
    forAll("accountActionsPath refuses outside-grammar", 0x5eed_0013, ITERATIONS, outsideAccountId, (badCase) => {
      expect(() => accountActionsPath(badCase.value), badCase.violation).toThrow();
    });
  });

  it("covers every named violation class over the fixed iteration budget", () => {
    // The class above would pass vacuously if the generator only ever produced
    // one easy violation. This asserts the budget actually reaches all of them.
    const seen = new Set<string>();
    for (let i = 0; i < ITERATIONS; i += 1) seen.add(outsideUuid(makeRandom(0x5eed_0011 + i)).violation);
    expect(seen.size).toBe(8);
  });
});

/**
 * The stream route's place in the frozen table (V2-B3a).
 *
 * This file is otherwise a property suite over the route *builders*, and the
 * stream has no builder — it takes no path parameter, so there is nothing to
 * validate before encoding. What it does have is a position in the table that
 * two other laws depend on, and those are asserted here rather than left to be
 * noticed: the route is a read, and its path is a sibling of the paged route
 * rather than a prefix of it.
 */
describe("the stream route is a read, and does not collide with the paged one (V2-B3a)", () => {
  it("sits under the versioned prefix like every other route", () => {
    expect(API_ROUTES.eventStream).toBe("/api/v1/events/stream");
    expect(API_ROUTES.eventStream.startsWith("/api/v1/")).toBe(true);
  });

  it("takes no path parameter, so there is no builder and nothing to encode", () => {
    // Stated rather than assumed: a parameter added here later would need a
    // validating builder like every other dynamic route has, and this is where
    // that obligation would come due.
    expect(API_ROUTES.eventStream).not.toContain(":");
  });

  it("adds nothing to the write surface", () => {
    // A long-lived connection is still a read. The write table is the short
    // list a reviewer glances at to answer "what can mutate?", and it did not
    // move.
    expect(isWriteRoute("eventStream")).toBe(false);
    // The table moved at V2-B4b stage 3C, at V2 L3, at P-14/B, at P-14/C, at P-27
    // cut A and at P-27 cut C: `taskToolCalls` is the third entry, `taskLifecycle`
    // the fourth, `initiatives` the fifth, `tasks` the sixth, `initiativeStepGraph`
    // the seventh and `initiativeTaskStep` the eighth. The stream still adds
    // nothing, which is what this test is about.
    expect([...API_WRITE_ROUTES]).toEqual([
      "initiativeRoadmap",
      "accountActions",
      "taskToolCalls",
      "taskLifecycle",
      "initiatives",
      "tasks",
      "initiativeStepGraph",
      "initiativeTaskStep",
    ]);
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
  });

  it("is a distinct pattern, and a suffix of the paged route rather than a rewrite of it", () => {
    // The two answer the same rows under different liveness contracts. They
    // must be different paths: a `?live=1` on one path would make the same URL
    // sometimes return a body that ends and sometimes one that does not.
    expect(API_ROUTES.eventStream).not.toBe(API_ROUTES.events);
    expect(API_ROUTES.eventStream.startsWith(API_ROUTES.events + "/")).toBe(true);
    const patterns = [...API_ROUTE_PATTERNS];
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});

describe("the portfolio route takes the fifth write (P-14/B)", () => {
  it("answers POST beside its GET, on the same path, with no parameter to encode", () => {
    expect(isWriteRoute("initiatives")).toBe(true);
    // Fifth when it landed; P-14/C's `tasks`, P-27 cut A's `initiativeStepGraph` and
    // P-27 cut C's `initiativeTaskStep` follow it.
    expect(API_WRITE_ROUTES.at(-4)).toBe("initiatives");
    expect(API_ROUTES.initiatives).toBe("/api/v1/initiatives");
    expect(API_ROUTES.initiatives).not.toContain(":");
    // The read plane's method list is the one that does not grow.
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
    // The single-initiative routes stay reads: the write is the collection's.
    expect(isWriteRoute("initiativeById")).toBe(false);
  });
});

describe("the task list route takes the sixth write (P-14/C)", () => {
  it("answers POST beside its GET, on the same path, with no parameter to encode", () => {
    expect(isWriteRoute("tasks")).toBe(true);
    // Sixth when it landed; P-27 cut A's `initiativeStepGraph` and P-27 cut C's
    // `initiativeTaskStep` follow it.
    expect(API_WRITE_ROUTES.at(-3)).toBe("tasks");
    expect(API_WRITE_ROUTES).toHaveLength(8);
    expect(API_ROUTES.tasks).toBe("/api/v1/tasks");
    expect(API_ROUTES.tasks).not.toContain(":");
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
    // The single-task route stays a read: the write is the collection's, and
    // entering a task is not acting on one.
    expect(isWriteRoute("taskById")).toBe(false);
  });
});

describe("the effect reads, and the one private read (P-15/F)", () => {
  const TASK = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
  const EFFECT = "a".repeat(64);

  it("adds two reads and no write: the method list and the write table do not move", () => {
    expect(API_ROUTES.taskEffects).toBe("/api/v1/tasks/:taskId/effects");
    expect(API_ROUTES.taskEffectResult).toBe("/api/v1/tasks/:taskId/effects/:effectId/result");
    // 22 when it landed; P-26 cut C's two reads moved it again, P-27 cut A's task
    // graph route, the seventh write, once more, and P-27 cut C's task step route,
    // the eighth.
    expect(Object.keys(API_ROUTES)).toHaveLength(26);
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
    expect(API_WRITE_ROUTES).toHaveLength(8);
    expect(isWriteRoute("taskEffects")).toBe(false);
    expect(isWriteRoute("taskEffectResult")).toBe(false);
  });

  it("names exactly one private read, frozen, and it is not a write", () => {
    expect([...API_PRIVATE_READ_ROUTES]).toEqual(["taskEffectResult"]);
    expect(Object.isFrozen(API_PRIVATE_READ_ROUTES)).toBe(true);
    expect(isPrivateReadRoute("taskEffectResult")).toBe(true);
    for (const route of Object.keys(API_ROUTES) as (keyof typeof API_ROUTES)[]) {
      if (route === "taskEffectResult") continue;
      expect(isPrivateReadRoute(route)).toBe(false);
    }
    for (const route of API_PRIVATE_READ_ROUTES) {
      expect(API_WRITE_ROUTES as readonly string[]).not.toContain(route);
    }
  });

  it("builds both paths through the task path's validator, and the effect id by the ledger's shape", () => {
    expect(taskEffectsPath(TASK)).toBe("/api/v1/tasks/" + TASK + "/effects");
    expect(taskEffectResultPath(TASK, EFFECT)).toBe("/api/v1/tasks/" + TASK + "/effects/" + EFFECT + "/result");
    expect(() => taskEffectsPath("not-a-uuid")).toThrow();
    for (const bad of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "a".repeat(32) + "/" + "a".repeat(31), "../" + "a".repeat(61)]) {
      expect(() => taskEffectResultPath(TASK, bad)).toThrow();
    }
    expect(() => taskEffectResultPath("not-a-uuid", EFFECT)).toThrow();
  });
});

describe("the steps and diff reads (P-26 cut C)", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";

  it("adds two reads beside content, at one depth, and no write or private read", () => {
    expect(API_ROUTES.initiativeRoadmapSteps).toBe("/api/v1/initiatives/:initiativeId/roadmap/steps");
    expect(API_ROUTES.initiativeRoadmapDiff).toBe("/api/v1/initiatives/:initiativeId/roadmap/diff");
    for (const route of ["initiativeRoadmapSteps", "initiativeRoadmapDiff"] as const) {
      expect(API_ROUTES[route].split("/").length).toBe(API_ROUTES.initiativeRoadmapContent.split("/").length);
      expect(isWriteRoute(route)).toBe(false);
      expect(isPrivateReadRoute(route)).toBe(false);
    }
    // 24 when they landed; P-27 cut A's task graph route, the seventh write, and P-27
    // cut C's task step route, the eighth.
    expect(Object.keys(API_ROUTES)).toHaveLength(26);
    expect(API_WRITE_ROUTES).toHaveLength(8);
    expect([...API_PRIVATE_READ_ROUTES]).toEqual(["taskEffectResult"]);
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
  });

  it("builds the path only, validated then encoded; the query is the caller's", () => {
    expect(initiativeRoadmapStepsPath(INITIATIVE)).toBe("/api/v1/initiatives/" + INITIATIVE + "/roadmap/steps");
    expect(initiativeRoadmapDiffPath(INITIATIVE)).toBe("/api/v1/initiatives/" + INITIATIVE + "/roadmap/diff");
    expect(initiativeRoadmapStepsPath(INITIATIVE)).not.toContain("?");
    expect(initiativeRoadmapDiffPath(INITIATIVE)).not.toContain("?");
    for (const bad of ["../../etc/passwd", INITIATIVE + "?version=1", ""]) {
      expect(() => initiativeRoadmapStepsPath(bad)).toThrow();
      expect(() => initiativeRoadmapDiffPath(bad)).toThrow();
    }
  });
});

describe("the task graph route takes the seventh write (P-27 cut A)", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";

  it("answers GET and POST on one path beneath the steps read, and is no private read", () => {
    expect(API_ROUTES.initiativeStepGraph).toBe("/api/v1/initiatives/:initiativeId/roadmap/steps/graph");
    expect(API_ROUTES.initiativeStepGraph.startsWith(API_ROUTES.initiativeRoadmapSteps + "/")).toBe(true);
    expect(API_ROUTES.initiativeStepGraph).not.toBe(API_ROUTES.initiativeRoadmapSteps);
    expect(isWriteRoute("initiativeStepGraph")).toBe(true);
    // Seventh when it landed; P-27 cut C's `initiativeTaskStep` follows it.
    expect(API_WRITE_ROUTES.at(-2)).toBe("initiativeStepGraph");
    expect(isPrivateReadRoute("initiativeStepGraph")).toBe(false);
    // The steps read beside it stays a read.
    expect(isWriteRoute("initiativeRoadmapSteps")).toBe(false);
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
    const patterns = [...API_ROUTE_PATTERNS];
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("builds the path only, validated then encoded; the query is the caller's", () => {
    expect(initiativeStepGraphPath(INITIATIVE)).toBe("/api/v1/initiatives/" + INITIATIVE + "/roadmap/steps/graph");
    expect(initiativeStepGraphPath(INITIATIVE)).not.toContain("?");
    for (const bad of ["../../etc/passwd", INITIATIVE + "?version=1", ""]) {
      expect(() => initiativeStepGraphPath(bad)).toThrow();
    }
  });
});

describe("the task step route takes the eighth write (P-27 cut C)", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";
  const TASK = "55555555-5555-4555-8555-555555555555";

  it("answers GET and POST on one path beneath the initiative, and is no private read", () => {
    expect(API_ROUTES.initiativeTaskStep).toBe("/api/v1/initiatives/:initiativeId/tasks/:taskId/step");
    expect(API_ROUTES.initiativeTaskStep.startsWith(API_ROUTES.initiativeById + "/")).toBe(true);
    expect(isWriteRoute("initiativeTaskStep")).toBe(true);
    expect(API_WRITE_ROUTES.at(-1)).toBe("initiativeTaskStep");
    expect(isPrivateReadRoute("initiativeTaskStep")).toBe(false);
    // The task read it names a task of stays a read.
    expect(isWriteRoute("taskById")).toBe(false);
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
    const patterns = [...API_ROUTE_PATTERNS];
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("builds the path through both validators, and throws on either id out of shape", () => {
    expect(initiativeTaskStepPath(INITIATIVE, TASK)).toBe("/api/v1/initiatives/" + INITIATIVE + "/tasks/" + TASK + "/step");
    expect(initiativeTaskStepPath(INITIATIVE, TASK)).not.toContain("?");
    for (const bad of ["../../etc/passwd", INITIATIVE + "?version=1", "", "not-a-uuid"]) {
      expect(() => initiativeTaskStepPath(bad, TASK)).toThrow();
      expect(() => initiativeTaskStepPath(INITIATIVE, bad)).toThrow();
    }
  });
});
