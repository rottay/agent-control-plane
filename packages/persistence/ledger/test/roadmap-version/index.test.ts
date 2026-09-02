import { describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "@acp/contracts";

import { forAll, intBetween, makeRandom } from "../canonical-json/helpers/index.js";

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


/**
 * The decision's invariants, as properties (P8-T G9).
 *
 * The classes above pin the behavior on chosen shapes. These quantify over
 * MULTIPLY-violating requests — the cases nobody writes by hand, and precisely
 * where a check-order bug hides: a request that violates three preconditions at
 * once has exactly one correct refusal, and only an oracle that models the
 * whole cascade can say which.
 *
 * **The oracle models the cascade AS CODED (C2a), every stage:** schema-invalid
 * → `head.initiativeId` mismatch → `knownVersions` initiative mismatch (all
 * three `REQUEST_INVALID`) → monotonicity → parent → head digest →
 * restores-unknown → rollback digest. An oracle that elided the early stages
 * would agree with a wrong implementation on every request that violates a late
 * rule and an early one together, which is most of them.
 */
describe("the roadmap-version decision is total and ordered (G9)", () => {
  const ITERATIONS = 250;

  interface Case {
    readonly request: { candidate: unknown; head: RoadmapVersionReadModel | null; knownVersions: readonly RoadmapVersionReadModel[] };
    readonly violations: readonly string[];
  }

  /**
   * The expected outcome, derived from the cascade rather than from the
   * implementation: the FIRST violated stage in the coded order wins.
   */
  function expected(violations: readonly string[]): { reason: string; at: string } | null {
    const order: readonly (readonly [string, string, string])[] = [
      ["schema", "REQUEST_INVALID", "candidate."],
      ["headInitiative", "REQUEST_INVALID", "head.initiativeId"],
      ["knownInitiative", "REQUEST_INVALID", "knownVersions.initiativeId"],
      ["monotonic", "VERSION_NOT_MONOTONIC", "candidate.version"],
      ["parent", "PARENT_MISMATCH", "candidate.parentVersionId"],
      ["headDigest", "HEAD_MISMATCH", "candidate.expectedHeadDigest"],
      ["restoresUnknown", "RESTORES_UNKNOWN_VERSION", "candidate.restoresVersionId"],
      ["rollbackDigest", "ROLLBACK_DIGEST_MISMATCH", "candidate.contentDigest"],
    ];
    for (const [name, reason, at] of order) {
      if (violations.includes(name)) return { reason, at };
    }
    return null;
  }

  /** A request carrying an arbitrary, possibly overlapping, set of violations. */
  function generate(random: () => number): Case {
    const violations: string[] = [];
    const add = (name: string, chance = 0.35): boolean => {
      if (random() < chance) {
        violations.push(name);
        return true;
      }
      return false;
    };

    const rollback = random() < 0.4;
    const head = folded({ roadmapVersionId: V1, contentDigest: DIGEST_ONE });
    let candidateValue = successor(
      rollback
        ? { kind: "ROLLBACK", restoresVersionId: V1, contentDigest: DIGEST_ONE }
        : {},
    );
    let headValue: RoadmapVersionReadModel | null = head;
    let known: RoadmapVersionReadModel[] = [head];

    // The schema violation must sit on a field NO later mutation touches, or a
    // combination silently repairs it and the case no longer means what the
    // violation list says. (`version` was the first choice and was wrong: the
    // monotonicity mutation overwrites it.)
    if (add("schema")) candidateValue = { ...candidateValue, recordedBy: 42 };
    if (add("headInitiative")) headValue = { ...head, initiativeId: OTHER_INITIATIVE };
    if (add("knownInitiative")) known = [...known, folded({ roadmapVersionId: V3, initiativeId: OTHER_INITIATIVE })];
    if (add("monotonic")) candidateValue = { ...candidateValue, version: intBetween(random, 3, 9) };
    if (add("parent")) candidateValue = { ...candidateValue, parentVersionId: V3 };
    if (add("headDigest")) candidateValue = { ...candidateValue, expectedHeadDigest: DIGEST_THREE };
    if (rollback && add("restoresUnknown")) {
      candidateValue = { ...candidateValue, restoresVersionId: V3 };
    }
    if (rollback && !violations.includes("restoresUnknown") && add("rollbackDigest")) {
      candidateValue = { ...candidateValue, contentDigest: DIGEST_TWO };
    }

    return {
      request: { candidate: candidateValue, head: headValue, knownVersions: known },
      violations,
    };
  }

  it("never throws and always returns one of the seven outcomes", () => {
    forAll("totality", 0x9d0c_0001, ITERATIONS, generate, ({ request }) => {
      const outcome = decideRoadmapVersion(request);
      if (outcome.ok) {
        expect(outcome.events).toHaveLength(1);
        return;
      }
      expect(ROADMAP_VERSION_REFUSALS).toContain(outcome.reason);
    });
  });

  it("refuses at the first violated stage of the coded cascade", () => {
    forAll("check order", 0x9d0c_0002, ITERATIONS, generate, ({ request, violations }) => {
      const outcome = decideRoadmapVersion(request);
      const want = expected(violations);
      if (want === null) {
        expect(outcome.ok, violations.join("+") || "(no violations)").toBe(true);
        return;
      }
      expect(outcome.ok, violations.join("+")).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason, violations.join("+")).toBe(want.reason);
      expect(outcome.at.startsWith(want.at), outcome.at + " vs " + want.at).toBe(true);
    });
  });

  it("grants only the exact successor, and says so in the event it produces", () => {
    forAll("grant implies successor", 0x9d0c_0003, ITERATIONS, generate, ({ request }) => {
      const outcome = decideRoadmapVersion(request);
      if (!outcome.ok) return;
      const headVersion = request.head?.version ?? 0;
      expect(outcome.version.version).toBe(headVersion + 1);
      expect(outcome.events[0]?.payload).toEqual(outcome.version);
    });
  });

  it("is pure: the same request decided twice gives the same outcome", () => {
    forAll("purity", 0x9d0c_0004, ITERATIONS, generate, ({ request }) => {
      const before = JSON.stringify(request);
      const first = decideRoadmapVersion(request);
      const second = decideRoadmapVersion(request);
      expect(first).toEqual(second);
      // And the request itself is untouched — a decision that mutated its input
      // would make a retry mean something different from the first attempt.
      expect(JSON.stringify(request)).toBe(before);
    });
  });

  it("reaches every stage of the cascade over the fixed budget", () => {
    // Without this the class could pass while only ever exercising one branch:
    // a generator that never produced a rollback, say, would leave two refusals
    // unvisited and the check-order property would still report green.
    const reached = new Set<string>();
    for (let i = 0; i < ITERATIONS; i += 1) {
      const outcome = decideRoadmapVersion(generate(makeRandom(0x9d0c_0002 + i)).request);
      reached.add(outcome.ok ? "GRANT" : outcome.reason);
    }
    // All six refusals plus the grant.
    expect([...reached].sort()).toEqual([...ROADMAP_VERSION_REFUSALS, "GRANT"].sort());
  });
});
