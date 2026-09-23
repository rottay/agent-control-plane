import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT_PATH_MARKERS } from "@acp/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { EVIDENCE_ROOT_REFUSALS, evidenceRootFor } from "../../src/evidence-root/index.js";

/**
 * Evidence for the non-toy evidence root (P-15 escalón D3, ADR 0105; decision 139).
 *
 * `evidenceRootFor` restates the providers' six directory checks as a declared
 * second copy, and the shared vector table in `@acp/contracts` holds the two copies
 * to one answer: every row is built here beside a ledger path and must be admitted
 * or refused with the word the table names. `NOT_OWNED` needs a second user and is
 * the one refusal no fixture here can build.
 */

const VECTOR_TABLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../kernel/contracts/test/testing/product-path-vectors/index.json",
);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A fresh canonical directory the ledger would live in. */
function ledgerHome(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "acp-evidence-root-")));
  directories.push(directory);
  return directory;
}

interface PathVector {
  readonly condition: string;
  readonly marker: string | null;
  readonly verdict: "ADMITTED" | "REFUSED";
  readonly refusal: string | null;
}

/** Read the table, or fail loudly: an absent or malformed table is a broken fixture, never an empty one. */
function readVectors(path: string): readonly PathVector[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const vectors = (parsed as { readonly vectors?: unknown }).vectors;
  if (!Array.isArray(vectors) || vectors.length === 0) throw new Error("the vector table carries no vectors");
  return vectors.map((entry: unknown, index) => {
    const { condition, marker, verdict, refusal } = entry as Record<string, unknown>;
    if (
      typeof condition !== "string" ||
      (marker !== null && typeof marker !== "string") ||
      (verdict !== "ADMITTED" && verdict !== "REFUSED") ||
      (refusal !== null && typeof refusal !== "string")
    ) {
      throw new Error("the vector table's row " + String(index) + " is malformed");
    }
    return { condition, marker, verdict, refusal };
  });
}

/** The ledger path whose evidence directory is in the state one condition names. */
function ledgerPathFor(vector: PathVector): string {
  const home = ledgerHome();
  const evidence = join(home, "executions");
  switch (vector.condition) {
    case "ADMITTED":
      mkdirSync(evidence, { mode: 0o700 });
      return join(home, "control-plane.sqlite");
    case "RELATIVE":
      return join("relative", "control-plane.sqlite");
    case "ABSENT":
      return join(home, "control-plane.sqlite");
    case "SYMLINK": {
      const real = join(home, "elsewhere");
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, evidence);
      return join(home, "control-plane.sqlite");
    }
    case "FILE":
      writeFileSync(evidence, "x");
      return join(home, "control-plane.sqlite");
    case "GROUP_WRITABLE":
    case "WORLD_WRITABLE":
      mkdirSync(evidence, { mode: 0o700 });
      chmodSync(evidence, vector.condition === "GROUP_WRITABLE" ? 0o770 : 0o707);
      return join(home, "control-plane.sqlite");
    case "PRODUCT_PATH":
    case "NEAR_MISS": {
      const product = home + (vector.marker ?? "") + (vector.condition === "PRODUCT_PATH" ? "x" : "");
      mkdirSync(join(product, "executions"), { recursive: true, mode: 0o700 });
      return join(product, "control-plane.sqlite");
    }
    default:
      throw new Error("the vector table names a condition this suite cannot build: " + vector.condition);
  }
}

describe("the evidence root is admitted beside the ledger, or refused by name (P-15/D3)", () => {
  it("answers every row of the shared vector table with the table's own word", () => {
    const vectors = readVectors(VECTOR_TABLE);
    for (const vector of vectors) {
      const ledgerPath = ledgerPathFor(vector);
      const outcome = evidenceRootFor(ledgerPath);
      const label = vector.condition + (vector.marker ?? "");
      if (vector.verdict === "ADMITTED") {
        expect(outcome, label).toEqual({ ok: true, root: join(dirname(ledgerPath), "executions") });
      } else {
        expect(outcome.ok, label).toBe(false);
        if (!outcome.ok) expect(outcome.refusal, label).toBe(vector.refusal);
        expect(EVIDENCE_ROOT_REFUSALS as readonly (string | null)[], label).toContain(vector.refusal);
      }
    }
    // Every declared marker is exercised in its own spelling; the case variants and the
    // near miss ride beside them (P-15/D3 v2).
    const exercised = vectors.flatMap((vector) => (vector.marker === null ? [] : [vector.marker]));
    expect(exercised.filter((marker) => PRODUCT_PATH_MARKERS.includes(marker))).toEqual([...PRODUCT_PATH_MARKERS]);
    expect(exercised.length).toBeGreaterThan(PRODUCT_PATH_MARKERS.length);
  });

  it("fails loudly on a malformed copy of the table, and on an absent one", () => {
    const home = ledgerHome();
    const copy = join(home, "index.json");
    writeFileSync(copy, JSON.stringify({ vectors: [{ condition: "ADMITTED", marker: null, verdict: "ADMITTED", refusal: 7 }] }));
    expect(() => readVectors(copy)).toThrow("the vector table's row 0 is malformed");
    expect(() => readVectors(join(home, "absent.json"))).toThrow(/ENOENT/);
  });

  it("closes its vocabulary, sorted, and never names the path it refused", () => {
    expect([...EVIDENCE_ROOT_REFUSALS]).toEqual([...EVIDENCE_ROOT_REFUSALS].sort());
    const home = ledgerHome();
    const outcome = evidenceRootFor(join(home, "control-plane.sqlite"));
    expect(outcome).toEqual({ ok: false, refusal: "ABSENT", at: "evidenceRoot" });
    expect(JSON.stringify(outcome)).not.toContain(home);
  });
});
