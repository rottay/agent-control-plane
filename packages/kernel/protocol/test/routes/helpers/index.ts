/**
 * The seeded property harness for the route grammar (P8-T G9).
 *
 * No property library is used, and none may be: the dependency graph is frozen
 * by the P1B discipline, so a generator-based class either brings its own
 * machinery or does not exist. This is the machinery — a seeded PRNG, a fixed
 * iteration count, and a failure that prints the seed which reproduces it.
 *
 * There is no shrinker. Shrinking is what a library buys, and its absence is
 * paid for by **per-case seeding**: iteration `i` draws from `makeRandom(seed +
 * i)`, so a failure names one number that regenerates exactly that
 * counterexample and nothing else. A reader debugging a failure does not need
 * the harness to be clever; they need the case back.
 *
 * The same harness exists in `@acp/ledger`'s test tree. That duplication is
 * deliberate and disclosed: a shared helper would be a cross-package test
 * import, which the packages' own purity laws forbid, and the duplication gate
 * scans `src/**` only, so nothing in the fence objects. Naming it here is
 * cheaper than letting a later reader discover it and wonder.
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

/**
 * Run one property over generated cases.
 *
 * The check either returns nothing or throws. On a throw the case, its index
 * and — above all — its own seed are attached, so the failure carries its own
 * reproduction instruction rather than an invitation to re-run and hope.
 */
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
      throw new Error(
        label +
          " failed at iteration " +
          String(i) +
          " (case seed " +
          String(caseSeed) +
          "): " +
          detail +
          "\n  case: " +
          JSON.stringify(value),
        { cause },
      );
    }
  }
}

const HEX = "0123456789abcdef";

/**
 * A v4-shaped uuid: version nibble `4`, variant nibble in `8-b`.
 *
 * A strict subset of what `z.uuid()` admits, which is the point — the generator
 * must never emit a value the grammar would reject, or the property under test
 * becomes a test of the generator.
 */
export function uuidV4(random: () => number): string {
  const hex = (count: number): string => {
    let out = "";
    for (let i = 0; i < count; i += 1) out += pick(random, HEX.split(""));
    return out;
  };
  return (
    hex(8) + "-" + hex(4) + "-4" + hex(3) + "-" + pick(random, ["8", "9", "a", "b"]) + hex(3) + "-" + hex(12)
  );
}

const SEGMENT_HEAD = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const SEGMENT_TAIL = "abcdefghijklmnopqrstuvwxyz0123456789._-".split("");
const ROLES = ["coordinator", "implementer", "reviewer", "consultant", "verifier"] as const;

/** One `[a-z0-9][a-z0-9._-]*` segment. */
function identitySegment(random: () => number): string {
  let out = pick(random, SEGMENT_HEAD);
  for (let i = 0, n = intBetween(random, 0, 10); i < n; i += 1) out += pick(random, SEGMENT_TAIL);
  return out;
}

/** A canonical `<provider>/<model>/<role>/<instance>` identity. */
export function workerIdentity(random: () => number): string {
  const instanceDigits = intBetween(random, 2, 4);
  let instance = "";
  for (let i = 0; i < instanceDigits; i += 1) instance += pick(random, "0123456789".split(""));
  return (
    identitySegment(random) + "/" + identitySegment(random) + "/" + pick(random, ROLES) + "/" + instance
  );
}

const ACCOUNT_HEAD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split("");
const ACCOUNT_TAIL = [...ACCOUNT_HEAD, ".", "_", "-"];

/** A legal account id: `[A-Za-z0-9][A-Za-z0-9._-]*`, 1-80 characters. */
export function accountId(random: () => number): string {
  let out = pick(random, ACCOUNT_HEAD);
  for (let i = 0, n = intBetween(random, 0, 40); i < n; i += 1) out += pick(random, ACCOUNT_TAIL);
  return out;
}

/**
 * The outside-grammar classes, generated CONSTRUCTIVELY.
 *
 * Each generator produces a value that is outside the grammar *by
 * construction*, for a named reason — never filtered random junk, which would
 * make the class's meaning depend on the filter rather than on the violation.
 * The class name travels with the value so a failure says which violation the
 * grammar let through.
 */
export interface OutsideCase {
  readonly violation: string;
  readonly value: string;
}

/** Outside-grammar uuids, one per named violation class. */
export function outsideUuid(random: () => number): OutsideCase {
  const valid = uuidV4(makeRandom(intBetween(random, 0, 2 ** 30)));
  const classes: readonly OutsideCase[] = [
    { violation: "empty", value: "" },
    { violation: "too short", value: valid.slice(0, valid.length - 1) },
    { violation: "too long", value: valid + pick(random, HEX.split("")) },
    { violation: "illegal character", value: valid.slice(0, 8) + "g" + valid.slice(9) },
    { violation: "traversal shape", value: "../" + valid },
    { violation: "path separator", value: valid.slice(0, 8) + "/" + valid.slice(9) },
    { violation: "reserved characters", value: valid.slice(0, 8) + "?#" + valid.slice(10) },
    { violation: "separators removed", value: valid.replaceAll("-", "") },
  ];
  return pick(random, classes);
}

/** Outside-grammar worker identities, one per named violation class. */
export function outsideIdentity(random: () => number): OutsideCase {
  const valid = workerIdentity(makeRandom(intBetween(random, 0, 2 ** 30)));
  const parts = valid.split("/");
  const classes: readonly OutsideCase[] = [
    { violation: "empty", value: "" },
    { violation: "too few segments", value: parts.slice(0, 3).join("/") },
    { violation: "too many segments", value: valid + "/extra" },
    { violation: "unknown role", value: [parts[0], parts[1], "auditor", parts[3]].join("/") },
    { violation: "uppercase segment", value: valid.toUpperCase() },
    { violation: "segment starts with punctuation", value: "-" + valid },
    { violation: "instance not 2-4 digits", value: parts.slice(0, 3).join("/") + "/9" },
    { violation: "traversal shape", value: [parts[0], "..", parts[2], parts[3]].join("/") },
  ];
  return pick(random, classes);
}

/** Outside-grammar account ids, one per named violation class. */
export function outsideAccountId(random: () => number): OutsideCase {
  const valid = accountId(makeRandom(intBetween(random, 0, 2 ** 30)));
  const classes: readonly OutsideCase[] = [
    { violation: "empty", value: "" },
    { violation: "leading punctuation", value: "." + valid },
    { violation: "path separator", value: valid + "/actions" },
    { violation: "traversal segment", value: ".." },
    { violation: "reserved characters", value: valid + "?x=1" },
    { violation: "space", value: valid + " tail" },
    { violation: "over the 80-character bound", value: "a".repeat(81) },
    { violation: "percent escape", value: valid + "%2e%2e" },
  ];
  return pick(random, classes);
}
