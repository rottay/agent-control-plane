import { describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "@acp/contracts";

import {
  ROADMAP_VERSION_REFUSALS,
  decideRoadmapVersion,
  type RoadmapVersionReadModel,
} from "../../src/index.js";

/**
 * Evidence for the roadmap-version decision.
 *
 * The module is pure: every test here hands it values and reads the outcome.
 * No ledger is opened anywhere in this file, and that is the point — the fold
 * crosses the boundary as data, so the laws are testable without a database
 * and the decision cannot quietly acquire one.
 *
 * The contract's own laws are not re-tested here. `RoadmapVersion` already
 * refuses a value that lies about itself (a parent at version 1, a rollback
 * with no restore target); what these tests cover is exactly what needs the
 * head.
 */

const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const OTHER_INITIATIVE = "55555555-5555-4555-8555-555555555555";
const V1 = "66666666-6666-4666-8666-666666666601";
const V2 = "66666666-6666-4666-8666-666666666602";
const V3 = "66666666-6666-4666-8666-666666666603";
const DIGEST_ONE = "a".repeat(64);
const DIGEST_TWO = "b".repeat(64);
const DIGEST_THREE = "c".repeat(64);
const AT = "2026-08-30T12:00:00.000Z";
const RECORDER = "kimi/k3/coordinator/01";

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    roadmapVersionId: V1,
    initiativeId: INITIATIVE,
    version: 1,
    contentDigest: DIGEST_ONE,
    parentVersionId: null,
    expectedHeadDigest: null,
    kind: "EDIT",
    restoresVersionId: null,
    recordedBy: RECORDER,
    recordedAt: AT,
    ...overrides,
  };
}

/** A version as the fold reports it, which is what the decision consumes. */
function folded(overrides: Partial<RoadmapVersionReadModel> = {}): RoadmapVersionReadModel {
  return {
    roadmapVersionId: V1,
    initiativeId: INITIATIVE,
    version: 1,
    contentDigest: DIGEST_ONE,
    parentVersionId: null,
    kind: "EDIT",
    restoresVersionId: null,
    recordedBy: RECORDER,
    recordedAt: AT,
    sequence: 1,
    ...overrides,
  };
}

/** The successor of `folded()`, spelled out once. */
function successor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return candidate({
    roadmapVersionId: V2,
    version: 2,
    contentDigest: DIGEST_TWO,
    parentVersionId: V1,
    expectedHeadDigest: DIGEST_ONE,
    ...overrides,
  });
}

describe("the refusal vocabulary", () => {
  it("is closed, sorted and deduplicated", () => {
    expect([...ROADMAP_VERSION_REFUSALS]).toEqual([...ROADMAP_VERSION_REFUSALS].sort());
    expect(new Set(ROADMAP_VERSION_REFUSALS).size).toBe(ROADMAP_VERSION_REFUSALS.length);
    expect([...ROADMAP_VERSION_REFUSALS]).toEqual([
      "HEAD_MISMATCH",
      "PARENT_MISMATCH",
      "REQUEST_INVALID",
      "RESTORES_UNKNOWN_VERSION",
      "ROLLBACK_DIGEST_MISMATCH",
      "VERSION_NOT_MONOTONIC",
    ]);
  });
});

describe("the decision grants a lawful version", () => {
  it("grants the bootstrap, and carries the candidate event as a value", () => {
    const outcome = decideRoadmapVersion({
      candidate: candidate(),
      head: null,
      knownVersions: [],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a grant");
    expect(outcome.version.version).toBe(1);
    expect(outcome.events.map((event) => event.type)).toEqual(["ROADMAP_VERSION_RECORDED"]);
    // The event is the version. The caller appends it; this module never does.
    expect(outcome.events[0]?.payload).toEqual(outcome.version);
  });

  it("grants an exact successor that names the head and its digest", () => {
    const outcome = decideRoadmapVersion({
      candidate: successor(),
      head: folded(),
      knownVersions: [folded()],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a grant");
    expect(outcome.version.parentVersionId).toBe(V1);
  });

  it("grants a rollback that restores a known version's own bytes", () => {
    const outcome = decideRoadmapVersion({
      candidate: candidate({
        roadmapVersionId: V3,
        version: 3,
        // A rollback to version 1 carries version 1's digest, unchanged.
        contentDigest: DIGEST_ONE,
        parentVersionId: V2,
        expectedHeadDigest: DIGEST_TWO,
        kind: "ROLLBACK",
        restoresVersionId: V1,
      }),
      head: folded({ roadmapVersionId: V2, version: 2, contentDigest: DIGEST_TWO, sequence: 2 }),
      knownVersions: [folded(), folded({ roadmapVersionId: V2, version: 2, contentDigest: DIGEST_TWO, sequence: 2 })],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a grant");
    expect(outcome.version.kind).toBe("ROLLBACK");
    expect(outcome.version.restoresVersionId).toBe(V1);
  });
});

describe("the decision refuses, by name", () => {
  it("REQUEST_INVALID when the candidate is not a roadmap version", () => {
    const outcome = decideRoadmapVersion({
      candidate: { nonsense: true },
      head: null,
      knownVersions: [],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("REQUEST_INVALID");
    expect(outcome.at.startsWith("candidate.")).toBe(true);
  });

  it("REQUEST_INVALID when the head belongs to another initiative", () => {
    const outcome = decideRoadmapVersion({
      candidate: successor(),
      head: folded({ initiativeId: OTHER_INITIATIVE }),
      knownVersions: [],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("REQUEST_INVALID");
    expect(outcome.at).toBe("head.initiativeId");
  });

  it("REQUEST_INVALID when a known version belongs to another initiative", () => {
    const outcome = decideRoadmapVersion({
      candidate: successor(),
      head: folded(),
      knownVersions: [folded(), folded({ roadmapVersionId: V3, initiativeId: OTHER_INITIATIVE })],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("REQUEST_INVALID");
    expect(outcome.at).toBe("knownVersions.initiativeId");
  });

  it("VERSION_NOT_MONOTONIC when the version skips, repeats or restarts", () => {
    const skips = decideRoadmapVersion({
      candidate: successor({ roadmapVersionId: V3, version: 3 }),
      head: folded(),
      knownVersions: [folded()],
    });
    expect(skips.ok).toBe(false);
    if (skips.ok) throw new Error("expected a refusal");
    expect(skips.reason).toBe("VERSION_NOT_MONOTONIC");
    expect(skips.at).toBe("candidate.version");

    // A first version arriving on top of an existing head.
    const restarts = decideRoadmapVersion({
      candidate: candidate(),
      head: folded(),
      knownVersions: [folded()],
    });
    expect(restarts.ok).toBe(false);
    if (restarts.ok) throw new Error("expected a refusal");
    expect(restarts.reason).toBe("VERSION_NOT_MONOTONIC");

    // A second version arriving at the bootstrap, where there is no head.
    const bootstrapSkip = decideRoadmapVersion({
      candidate: successor(),
      head: null,
      knownVersions: [],
    });
    expect(bootstrapSkip.ok).toBe(false);
    if (bootstrapSkip.ok) throw new Error("expected a refusal");
    expect(bootstrapSkip.reason).toBe("VERSION_NOT_MONOTONIC");
  });

  it("PARENT_MISMATCH when the parent is not the folded head", () => {
    const outcome = decideRoadmapVersion({
      candidate: successor({ parentVersionId: V3 }),
      head: folded(),
      knownVersions: [folded()],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("PARENT_MISMATCH");
    expect(outcome.at).toBe("candidate.parentVersionId");
  });

  it("HEAD_MISMATCH when the expected head is not the head's digest", () => {
    const outcome = decideRoadmapVersion({
      candidate: successor({ expectedHeadDigest: DIGEST_THREE }),
      head: folded(),
      knownVersions: [folded()],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("HEAD_MISMATCH");
    expect(outcome.at).toBe("candidate.expectedHeadDigest");
  });

  it("RESTORES_UNKNOWN_VERSION when the fold does not know the restore target", () => {
    const outcome = decideRoadmapVersion({
      candidate: successor({ kind: "ROLLBACK", restoresVersionId: V3 }),
      head: folded(),
      knownVersions: [folded()],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("RESTORES_UNKNOWN_VERSION");
    expect(outcome.at).toBe("candidate.restoresVersionId");
  });

  it("ROLLBACK_DIGEST_MISMATCH when a rollback would restore different bytes", () => {
    // Names version 1 as the restore target but carries other bytes. That is
    // an edit wearing a rollback's label, and it is refused.
    const outcome = decideRoadmapVersion({
      candidate: successor({ kind: "ROLLBACK", restoresVersionId: V1, contentDigest: DIGEST_THREE }),
      head: folded(),
      knownVersions: [folded()],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("ROLLBACK_DIGEST_MISMATCH");
    expect(outcome.at).toBe("candidate.contentDigest");
  });

  it("checks monotonicity before the parent, and the parent before the head", () => {
    // Every claim is wrong at once. The coarsest one is reported, so a caller
    // fixing refusals in order is never chasing a symptom of the last error.
    const outcome = decideRoadmapVersion({
      candidate: successor({ version: 9, parentVersionId: V3, expectedHeadDigest: DIGEST_THREE }),
      head: folded(),
      knownVersions: [folded()],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("VERSION_NOT_MONOTONIC");

    const parentBeforeHead = decideRoadmapVersion({
      candidate: successor({ parentVersionId: V3, expectedHeadDigest: DIGEST_THREE }),
      head: folded(),
      knownVersions: [folded()],
    });
    expect(parentBeforeHead.ok).toBe(false);
    if (parentBeforeHead.ok) throw new Error("expected a refusal");
    expect(parentBeforeHead.reason).toBe("PARENT_MISMATCH");
  });
});

describe("the decision reads nothing and mints nothing", () => {
  it("is a pure function of its inputs", () => {
    const request = {
      candidate: successor(),
      head: folded(),
      knownVersions: [folded()],
    };

    const first = decideRoadmapVersion(request);
    const second = decideRoadmapVersion(request);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    // Nothing it returns is minted: the version is the candidate, parsed.
    if (!first.ok) throw new Error("expected a grant");
    expect(first.version).toEqual(successor());
  });
});
