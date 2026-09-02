import { describe, expect, it } from "vitest";

import { canonicalJsonStringify } from "../../src/canonical-json/index.js";
import { LedgerCanonicalizationError } from "../../src/errors/index.js";
import {
  cyclicValue,
  dagValue,
  forAll,
  jsonValue,
  makeRandom,
  refusedValue,
  reinsert,
} from "./helpers/index.js";

/**
 * Canonical JSON, as properties (P8-T G9).
 *
 * The module's first test, and the one place in the ledger where a generator
 * reaches something a table of examples cannot: the encoder's contract is
 * universally quantified — *every* representable value round-trips, *every*
 * key order produces identical bytes — and a fixed list of examples can only
 * ever sample that.
 *
 * The generator excludes by construction exactly what the module refuses by
 * design. `-0` matters most: `JSON.stringify(-0)` is `"0"`, so the sign cannot
 * survive, and the encoder rejects it deliberately. A generator that let a
 * negated zero fall out of arithmetic would hand the round-trip property a
 * value the module is contracted to refuse, and the failure would read as an
 * encoder bug. The refusal space is therefore its own class below, generated on
 * purpose rather than met by accident.
 */

const ITERATIONS = 200;

/**
 * Every object's key sequence, in the order the encoder emitted them.
 *
 * A minimal scanner over the encoded text: it tracks string literals (so a
 * brace or comma inside a key or value cannot confuse it) and records, per
 * object depth, the keys as they appear. It does not sort, compare or
 * canonicalize anything — re-implementing the encoder would make the oracle
 * agree with the implementation by construction rather than by test.
 */
function emittedKeySequences(encoded: string): string[][] {
  const sequences: string[][] = [];
  const stack: { keys: string[]; isObject: boolean }[] = [];
  let index = 0;
  let expectKey = false;

  const readString = (): string => {
    let out = "";
    index += 1; // opening quote
    while (index < encoded.length) {
      const ch = encoded[index];
      if (ch === "\\") {
        out += encoded.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (ch === undefined) break;
      if (ch === '"') {
        index += 1;
        return out;
      }
      out += ch;
      index += 1;
    }
    throw new Error("unterminated string in encoded output");
  };

  while (index < encoded.length) {
    const ch = encoded[index];
    if (ch === '"') {
      const text = readString();
      const frame = stack[stack.length - 1];
      if (expectKey && frame?.isObject === true) {
        frame.keys.push(text);
        expectKey = false;
      }
      continue;
    }
    if (ch === "{") {
      stack.push({ keys: [], isObject: true });
      expectKey = true;
    } else if (ch === "[") {
      stack.push({ keys: [], isObject: false });
      expectKey = false;
    } else if (ch === "}" || ch === "]") {
      const frame = stack.pop();
      if (frame?.isObject === true) sequences.push(frame.keys);
      expectKey = false;
    } else if (ch === ",") {
      expectKey = stack[stack.length - 1]?.isObject === true;
    }
    index += 1;
  }
  return sequences;
}

describe("canonical JSON is deterministic over key order (G9)", () => {
  it("produces identical bytes however the keys were inserted", () => {
    // The property the hash chain actually rests on: two processes that built
    // the same logical value by different routes must agree byte for byte.
    forAll("key-order determinism", 0x1ed9_0001, ITERATIONS, (random) => {
      const value = jsonValue(random);
      return { value, shuffled: reinsert(random, value) };
    }, ({ value, shuffled }) => {
      expect(canonicalJsonStringify(shuffled)).toBe(canonicalJsonStringify(value));
    });
  });

  it("is stable across repeated encodings of the same value", () => {
    forAll("encoding is idempotent", 0x1ed9_0002, ITERATIONS, jsonValue, (value) => {
      expect(canonicalJsonStringify(value)).toBe(canonicalJsonStringify(value));
    });
  });
});

describe("canonical JSON round-trips every value it accepts (G9)", () => {
  it("parses back to a deep-equal value", () => {
    forAll("round trip", 0x1ed9_0011, ITERATIONS, jsonValue, (value) => {
      expect(JSON.parse(canonicalJsonStringify(value))).toEqual(value);
    });
  });

  it("emits keys in ascending code-unit order at every level", () => {
    // Determinism is the claim; ascending order is the mechanism. Asserting the
    // mechanism separately means a future encoder that became deterministic by
    // some other rule would fail here and have to say so.
    //
    // The order is read from the EMITTED TEXT, not from a parsed object.
    // `JSON.parse` hands back a JS object, and JS objects list integer-like keys
    // first in numeric order whatever the document said — so a parsed readout
    // would be testing JavaScript's property-order rules rather than the
    // encoder's sorting. (Measured: `{"1od":…,"7":…}` parses to key order
    // `["7","1od"]`.) Scanning the text is the only faithful oracle here.
    forAll("keys ascend", 0x1ed9_0012, ITERATIONS, jsonValue, (value) => {
      for (const keys of emittedKeySequences(canonicalJsonStringify(value))) {
        expect(keys).toEqual([...keys].sort());
      }
    });
  });

  it("encodes a shared substructure twice rather than refusing it", () => {
    // A DAG is not a cycle. The encoder removes each object from the seen-set
    // on the way out precisely so siblings may share, and this is the property
    // that would catch a seen-set that never forgot.
    forAll("DAGs encode", 0x1ed9_0013, ITERATIONS, dagValue, (value) => {
      const encoded = canonicalJsonStringify(value);
      expect(JSON.parse(encoded)).toEqual(value);
    });
  });
});

describe("canonical JSON refuses what it cannot round-trip (G9)", () => {
  it("throws a typed error on every refusal class", () => {
    forAll("refusal space", 0x1ed9_0021, ITERATIONS, refusedValue, (refused) => {
      expect(() => canonicalJsonStringify(refused.build()), refused.reason)
        .toThrow(LedgerCanonicalizationError);
    });
  });

  it("refuses arbitrary cycles", () => {
    forAll("cycles throw", 0x1ed9_0022, ITERATIONS, cyclicValue, (value) => {
      expect(() => canonicalJsonStringify(value)).toThrow(LedgerCanonicalizationError);
    });
  });

  it("covers every named refusal class over the fixed iteration budget", () => {
    const seen = new Set<string>();
    for (let i = 0; i < ITERATIONS; i += 1) seen.add(refusedValue(makeRandom(0x1ed9_0021 + i)).reason);
    expect(seen.size).toBe(10);
  });

  it("never generates a value the encoder refuses", () => {
    // The generator's own contract, asserted rather than assumed: if this ever
    // fails, the round-trip properties above were testing the generator.
    forAll("generator stays inside the accepted space", 0x1ed9_0031, ITERATIONS, jsonValue, (value) => {
      expect(() => canonicalJsonStringify(value)).not.toThrow();
    });
  });
});
