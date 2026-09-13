import { describe, expect, it } from "vitest";

import {
  API_ALLOWED_METHODS,
  API_ROUTES,
  API_ROUTE_PATTERNS,
  API_WRITE_ROUTES,
  isWriteRoute,
  accountActionsPath,
  initiativeAgentsPath,
  initiativeEventsPath,
  initiativePath,
  initiativeRoadmapContentPath,
  initiativeRoadmapPath,
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
    // The table moved at V2-B4b stage 3C, at V2 L3 and at P-14/B:
    // `taskToolCalls` is the third entry, `taskLifecycle` the fourth and
    // `initiatives` the fifth. The stream still adds nothing, which is what
    // this test is about.
    expect([...API_WRITE_ROUTES]).toEqual([
      "initiativeRoadmap",
      "accountActions",
      "taskToolCalls",
      "taskLifecycle",
      "initiatives",
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
    expect(API_WRITE_ROUTES.at(-1)).toBe("initiatives");
    expect(API_ROUTES.initiatives).toBe("/api/v1/initiatives");
    expect(API_ROUTES.initiatives).not.toContain(":");
    // The read plane's method list is the one that does not grow.
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
    // The single-initiative routes stay reads: the write is the collection's.
    expect(isWriteRoute("initiativeById")).toBe(false);
  });
});
