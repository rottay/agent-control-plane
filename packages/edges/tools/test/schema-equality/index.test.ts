import { describe, expect, it } from "vitest";

import { TOOL_SCHEMA_DEPTH_MAX } from "../../src/contract/index.js";
import { jsonDepthWithin, jsonEqual } from "../../src/schema-equality/index.js";

/**
 * Evidence for the one schema comparison (P-24, ADR 0109).
 *
 * A value pin, not schema equivalence: every row below says which side of that
 * line a difference falls on, including the ones a validator would read alike.
 */

/** A value `levels` containers deep: nested objects around a scalar. */
function nested(levels: number): unknown {
  let value: unknown = "leaf";
  for (let level = 0; level < levels; level += 1) value = { child: value };
  return value;
}

describe("jsonEqual compares JSON values, not schemas", () => {
  it("ignores key order in objects", () => {
    expect(jsonEqual(JSON.parse('{"a":1,"b":{"c":2,"d":3}}'), JSON.parse('{"b":{"d":3,"c":2},"a":1}'))).toBe(true);
  });

  it("reads 0 and -0 as one value, as parsed (C1)", () => {
    expect(Object.is(JSON.parse("-0"), -0)).toBe(true);
    expect(jsonEqual(0, -0)).toBe(true);
    expect(jsonEqual(JSON.parse('{"minimum":0}'), JSON.parse('{"minimum":-0}'))).toBe(true);
  });

  it("reads 1, 1.0 and 1e0 as one value", () => {
    expect(jsonEqual(JSON.parse("1"), JSON.parse("1.0"))).toBe(true);
    expect(jsonEqual(JSON.parse("1"), JSON.parse("1e0"))).toBe(true);
  });

  it("refuses every difference a pin must see", () => {
    const base = { type: "object", properties: { q: { type: "string" } }, required: ["a", "b"] };
    const rows: readonly (readonly [string, unknown])[] = [
      ["an extra key", { ...base, additionalProperties: false }],
      ["a missing key", { type: "object", properties: base.properties }],
      ["a nested difference", { ...base, properties: { q: { type: "number" } } }],
      ["the required list reordered (a validator would read it alike)", { ...base, required: ["b", "a"] }],
      ["a description added (the cost is a re-pin)", { ...base, description: "d" }],
    ];
    for (const [label, other] of rows) expect({ label, equal: jsonEqual(base, other) }).toEqual({ label, equal: false });
    expect(jsonEqual(1, "1")).toBe(false);
    expect(jsonEqual({ a: null }, {})).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });

  it("compares $ref as a literal, never resolving it", () => {
    expect(jsonEqual({ $ref: "#/defs/a" }, { $ref: "#/defs/a" })).toBe(true);
    expect(jsonEqual({ $ref: "#/defs/a" }, { $ref: "#/defs/b" })).toBe(false);
  });

  it("treats a __proto__ key a parse created as ordinary data on either side", () => {
    const left = JSON.parse('{"__proto__":{"x":1},"type":"object"}') as unknown;
    const same = JSON.parse('{"type":"object","__proto__":{"x":1}}') as unknown;
    const other = JSON.parse('{"__proto__":{"x":2},"type":"object"}') as unknown;
    expect(jsonEqual(left, same)).toBe(true);
    expect(jsonEqual(left, other)).toBe(false);
    expect(jsonEqual(left, { type: "object" })).toBe(false);
  });

  it("answers not equal past the depth bound, on either side, and never throws", () => {
    expect(jsonEqual(nested(TOOL_SCHEMA_DEPTH_MAX), nested(TOOL_SCHEMA_DEPTH_MAX))).toBe(true);
    const deep = nested(TOOL_SCHEMA_DEPTH_MAX + 1);
    expect(jsonEqual(deep, deep)).toBe(false);
    expect(jsonEqual(deep, nested(TOOL_SCHEMA_DEPTH_MAX))).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => jsonEqual(cycle, cycle)).not.toThrow();
    expect(jsonEqual(cycle, cycle)).toBe(false);
  });
});

describe("jsonDepthWithin bounds a value's nesting", () => {
  it("admits the bound and refuses one past it, and ends on a cycle", () => {
    expect(jsonDepthWithin(nested(TOOL_SCHEMA_DEPTH_MAX), TOOL_SCHEMA_DEPTH_MAX)).toBe(true);
    expect(jsonDepthWithin(nested(TOOL_SCHEMA_DEPTH_MAX + 1), TOOL_SCHEMA_DEPTH_MAX)).toBe(false);
    expect(jsonDepthWithin("scalar", 0)).toBe(true);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(jsonDepthWithin(cycle, TOOL_SCHEMA_DEPTH_MAX)).toBe(false);
  });
});

describe("the same equality serves the output pin and the structured mirror (P-24/B(b), ADR 0117)", () => {
  it("equals null only to null, which the none-versus-some pins rest on", () => {
    expect(jsonEqual(null, null)).toBe(true);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual({}, null)).toBe(false);
    expect(jsonEqual(null, { type: "object" })).toBe(false);
  });

  it("finds a structured value equal to its serialization parsed back with the keys permuted", () => {
    const value = { hits: 2, items: [{ id: "a", score: 1 }, { id: "b", score: 0.5 }], meta: { total: 2, done: true } };
    const permuted = JSON.parse('{"meta":{"done":true,"total":2},"items":[{"score":1,"id":"a"},{"score":0.5,"id":"b"}],"hits":2.0}') as unknown;
    expect(jsonEqual(JSON.parse(JSON.stringify(value)), value)).toBe(true);
    expect(jsonEqual(permuted, value)).toBe(true);
    // Arrays stay ordered: a mirror that reorders an array carries another value.
    const reordered = JSON.parse('{"hits":2,"items":[{"id":"b","score":0.5},{"id":"a","score":1}],"meta":{"total":2,"done":true}}') as unknown;
    expect(jsonEqual(reordered, value)).toBe(false);
  });
});
