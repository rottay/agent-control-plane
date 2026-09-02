import { describe, expect, it } from "vitest";

import { MIGRATIONS, checkMigrationConformance } from "../../src/migrations/index.js";
import type { AppliedMigration } from "../../src/types/index.js";
import { forAll, intBetween, pick } from "../canonical-json/helpers/index.js";

/**
 * Migration conformance, asserted by name (P8-T G9, the structural residual).
 *
 * `checkMigrationConformance` is a decision function one level below
 * `decideRoadmapVersion`: it compares what a database has applied against what
 * this build defines and returns a verdict every open of the ledger acts on.
 * Until now it was exercised only incidentally, through the open path — so a
 * change to its refusal reasoning would have surfaced, if at all, as some other
 * test's confusing failure. This class asserts its own contract.
 *
 * The two-field verdict is the whole contract, and both halves matter:
 * `problems` is fatal in every mode, `missing` is the recoverable tail — and
 * the rule binding them is that a divergent prefix must suppress the tail
 * entirely, because applying new migrations on top of a divergent history
 * compounds the divergence instead of surfacing it.
 */

const ITERATIONS = 120;

/** The applied rows a conforming database of `count` migrations would hold. */
function conformingPrefix(count: number): AppliedMigration[] {
  return MIGRATIONS.slice(0, count).map((migration) => ({
    version: migration.version,
    name: migration.name,
    sha256: migration.sha256,
    appliedAt: "2026-08-27T12:00:00.000Z",
  }));
}

describe("migration conformance grants exactly the conforming prefixes (G9)", () => {
  it("accepts every prefix of this build's own migrations", () => {
    // The generated dimension is how far the database got. Every prefix is
    // legal; what differs is the size of the recoverable tail.
    forAll("conforming prefix", 0x9a17_0001, ITERATIONS, (random) =>
      intBetween(random, 0, MIGRATIONS.length), (count) => {
      const verdict = checkMigrationConformance(conformingPrefix(count));
      expect(verdict.problems).toEqual([]);
      expect(verdict.missing.map((m) => m.version)).toEqual(
        MIGRATIONS.slice(count).map((m) => m.version),
      );
    });
  });

  it("reports nothing missing when the database is fully migrated", () => {
    const verdict = checkMigrationConformance(conformingPrefix(MIGRATIONS.length));
    expect(verdict.problems).toEqual([]);
    expect(verdict.missing).toEqual([]);
  });
});

describe("migration conformance refuses every divergence, and suppresses the tail (G9)", () => {
  it("refuses a mutated row and never offers a recoverable tail", () => {
    // The property that matters operationally: whatever the divergence, the
    // caller must not be handed migrations to apply on top of it.
    forAll("divergence suppresses the tail", 0x9a17_0011, ITERATIONS, (random) => {
      const count = intBetween(random, 1, MIGRATIONS.length);
      const rows = conformingPrefix(count);
      const index = intBetween(random, 0, rows.length - 1);
      const row = rows[index];
      if (row === undefined) throw new Error("empty prefix");
      const mutation = pick(random, ["version", "name", "sha256"] as const);
      rows[index] =
        mutation === "version"
          ? { ...row, version: row.version + 1000 }
          : mutation === "name"
            ? { ...row, name: row.name + "-drifted" }
            : { ...row, sha256: "f".repeat(64) };
      return { rows, mutation, index };
    }, ({ rows, mutation }) => {
      const verdict = checkMigrationConformance(rows);
      expect(verdict.problems.length, mutation).toBeGreaterThan(0);
      // The load-bearing half: a divergent prefix yields NO missing tail.
      expect(verdict.missing, mutation).toEqual([]);
    });
  });

  it("refuses rows this build does not define at all", () => {
    forAll("unknown trailing migrations", 0x9a17_0021, ITERATIONS, (random) => {
      const extra = intBetween(random, 1, 3);
      const rows = conformingPrefix(MIGRATIONS.length);
      for (let i = 0; i < extra; i += 1) {
        rows.push({
          version: MIGRATIONS.length + 1 + i,
          name: "from-a-newer-build-" + String(i),
          sha256: "a".repeat(64),
          appliedAt: "2026-08-27T12:00:00.000Z",
        });
      }
      return { rows, extra };
    }, ({ rows, extra }) => {
      const verdict = checkMigrationConformance(rows);
      // One problem per unknown row: a database from a newer build is named
      // row by row rather than summarised, so the operator sees which.
      expect(verdict.problems.length).toBe(extra);
      expect(verdict.missing).toEqual([]);
    });
  });

  it("never throws, whatever it is handed", () => {
    // A conformance check that threw would turn a recoverable divergence into
    // a crash on open. It returns a verdict for every input or it is not a
    // verdict function.
    forAll("totality", 0x9a17_0031, ITERATIONS, (random) => {
      const rows = conformingPrefix(intBetween(random, 0, MIGRATIONS.length));
      const damage = intBetween(random, 0, 3);
      for (let i = 0; i < damage; i += 1) {
        const at = intBetween(random, 0, Math.max(0, rows.length - 1));
        const row = rows[at];
        if (row === undefined) continue;
        rows[at] = { ...row, version: intBetween(random, -50, 5000), sha256: "b".repeat(64) };
      }
      return rows;
    }, (rows) => {
      const verdict = checkMigrationConformance(rows);
      expect(Array.isArray(verdict.problems)).toBe(true);
      expect(Array.isArray(verdict.missing)).toBe(true);
    });
  });
});
