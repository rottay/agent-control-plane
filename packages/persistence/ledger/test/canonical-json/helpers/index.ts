/**
 * The seeded property harness for canonical JSON (P8-T G9).
 *
 * A second copy of the same four-line PRNG and `forAll` that
 * `@acp/protocol`'s route class carries. **The duplication is deliberate and
 * disclosed**: a shared helper would be a cross-package test import, which both
 * packages' import-purity laws forbid by design, and the duplication gate scans
 * `src/**` only — so nothing in the fence would ever notice. It is named here
 * rather than left to be discovered.
 *
 * No property library: the dependency graph is frozen, so the machinery is
 * house-built. No shrinker either; per-case seeding pays for its absence —
 * iteration `i` draws from `makeRandom(seed + i)`, so a failure prints one
 * number that regenerates exactly that counterexample.
 */

/** mulberry32: a seeded 32-bit PRNG, uniform enough for structural generation. */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in `[low, high]`, inclusive. */
export function intBetween(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

/** One member of a non-empty list. */
export function pick<T>(random: () => number, values: readonly T[]): T {
  const chosen = values[intBetween(random, 0, values.length - 1)];
  if (chosen === undefined) throw new Error("pick from an empty list");
  return chosen;
}

/** Run one property over generated cases; a failure carries its own seed. */
export function forAll<T>(
  label: string,
  seed: number,
  iterations: number,
  generate: (random: () => number) => T,
  check: (value: T) => void,
): void {
  for (let i = 0; i < iterations; i += 1) {
    const caseSeed = seed + i;
    const value = generate(makeRandom(caseSeed));
    try {
      check(value);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      let rendered: string;
      try {
        rendered = JSON.stringify(value);
      } catch {
        rendered = "<unrenderable>";
      }
      throw new Error(
        label +
          " failed at iteration " +
          String(i) +
          " (case seed " +
          String(caseSeed) +
          "): " +
          detail +
          "\n  case: " +
          rendered,
        { cause },
      );
    }
  }
}

const KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-. äüß✓".split("");

/** A key drawn from a set wide enough to exercise the code-unit ordering rule. */
function key(random: () => number): string {
  let out = "";
  for (let i = 0, n = intBetween(random, 1, 6); i < n; i += 1) out += pick(random, KEY_CHARS);
  return out;
}

/**
 * A finite, JSON-representable number — **never `-0`** (C2b).
 *
 * The exclusion is by construction, not by filtering, and it is the single most
 * important line in this file: `canonicalJsonStringify` refuses negative zero
 * *by design*, because `JSON.stringify(-0)` is `"0"` and the sign does not
 * survive. A generator that let a negated zero fall out of PRNG arithmetic
 * would feed the round-trip property a value the module is contracted to
 * reject, and the resulting failure would look like an encoder bug. The refusal
 * is exercised deliberately instead, by `refusedValue` below.
 */
function jsonNumber(random: () => number): number {
  const kind = intBetween(random, 0, 4);
  if (kind === 0) return 0;
  if (kind === 1) return intBetween(random, -1_000_000, 1_000_000);
  if (kind === 2) return intBetween(random, -1000, 1000) + Math.round(random() * 1000) / 1000;
  if (kind === 3) return Number.MAX_SAFE_INTEGER - intBetween(random, 0, 1000);
  return Number.MIN_SAFE_INTEGER + intBetween(random, 0, 1000);
}

function jsonString(random: () => number): string {
  const alphabet = "abc XYZ 019 \"\\\n\t äöü 😀 ✓".split("");
  let out = "";
  for (let i = 0, n = intBetween(random, 0, 12); i < n; i += 1) out += pick(random, alphabet);
  return out;
}

/**
 * An arbitrary JSON-representable value tree, bounded in depth and breadth.
 *
 * Every leaf class the encoder accepts, and nothing it refuses: no `undefined`,
 * no non-finite number, no `-0`, no bigint, no function, no symbol, no array
 * hole, no non-plain object. What the encoder rejects is generated separately,
 * on purpose, by `refusedValue`.
 */
export function jsonValue(random: () => number, depth = 0): unknown {
  const leafOnly = depth >= 4;
  const kind = intBetween(random, 0, leafOnly ? 3 : 5);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return random() < 0.5;
    case 2:
      return jsonNumber(random);
    case 3:
      return jsonString(random);
    case 4: {
      const out: unknown[] = [];
      for (let i = 0, n = intBetween(random, 0, 4); i < n; i += 1) out.push(jsonValue(random, depth + 1));
      return out;
    }
    default: {
      const out: Record<string, unknown> = {};
      for (let i = 0, n = intBetween(random, 0, 5); i < n; i += 1) out[key(random)] = jsonValue(random, depth + 1);
      return out;
    }
  }
}

/** Rebuild a plain object with its keys inserted in a different random order. */
export function reinsert(random: () => number, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => reinsert(random, item));
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = intBetween(random, 0, i);
    const a = entries[i];
    const b = entries[j];
    if (a !== undefined && b !== undefined) {
      entries[i] = b;
      entries[j] = a;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [name, item] of entries) out[name] = reinsert(random, item);
  return out;
}

/** A shared-substructure DAG: the same object reachable by two sibling paths. */
export function dagValue(random: () => number): unknown {
  const shared = { shared: jsonValue(random, 3), tag: jsonString(random) };
  return { left: shared, right: shared, extra: jsonValue(random, 3) };
}

/** A genuine cycle, injected into an otherwise legal tree. */
export function cyclicValue(random: () => number): unknown {
  const root: Record<string, unknown> = { head: jsonValue(random, 3) };
  const child: Record<string, unknown> = { parent: null as unknown };
  child["parent"] = root;
  root["child"] = child;
  return root;
}

/** The refusal space, as its own deliberate class — one value per named reason. */
export interface RefusedCase {
  readonly reason: string;
  readonly build: () => unknown;
}

export function refusedValue(random: () => number): RefusedCase {
  const classes: readonly RefusedCase[] = [
    { reason: "negative zero", build: () => ({ n: -0 }) },
    { reason: "NaN", build: () => ({ n: Number.NaN }) },
    { reason: "Infinity", build: () => ({ n: Number.POSITIVE_INFINITY }) },
    { reason: "undefined member", build: () => ({ n: undefined }) },
    { reason: "bigint", build: () => ({ n: 1n }) },
    { reason: "function", build: () => ({ n: () => 1 }) },
    { reason: "symbol value", build: () => ({ n: Symbol("s") }) },
    {
      reason: "array hole",
      // Built rather than written as `[1, , 3]`: a sparse literal is a lint
      // error in this repository, and the hole is the point of the case.
      build: () => {
        // `Array(3)` then two assignments: index 1 is never written, so the
        // array genuinely has a hole. A sparse literal and `delete` are both
        // lint errors here, and neither is needed to produce one.
        const holed = new Array<number>(3);
        holed[0] = 1;
        holed[2] = 3;
        return holed;
      },
    },
    { reason: "non-plain object", build: () => ({ n: new Date(0) }) },
    { reason: "cycle", build: () => cyclicValue(makeRandom(1)) },
  ];
  return pick(random, classes);
}
