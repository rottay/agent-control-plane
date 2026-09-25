/**
 * JSON value equality for a tool's pinned schema — `@acp/tools` (P-24, ADR 0109).
 *
 * The one comparison of an advertised `inputSchema` with the operator's pin, and
 * the one depth bound over a JSON value. Since P-24/B(b) (ADR 0117) it is also the
 * one comparison of an advertised `outputSchema` with its pin (`null` equals only
 * `null`, by the scalar branch), and of a result's structured content with the
 * text block that mirrors it: the same value equality, so a mirror whose keys are
 * reordered or whose `1` is spelled `1.0` still carries it, and a structured value
 * past the depth bound is never carried. A value pin, not schema equivalence:
 *
 * - objects are equal when their own keys are the same set and each value is
 *   equal, whatever the key order;
 * - arrays are equal element by element, **in order**, so `required: ["a", "b"]`
 *   and `["b", "a"]` differ although a validator would read them alike;
 * - numbers are equal by `===` after parse, so `1`, `1.0` and `1e0` are one value,
 *   and so are `0` and `-0`; integers beyond 2^53 and `1e400` collapse the same way
 *   on both sides;
 * - strings, booleans and `null` are equal exactly;
 * - `$ref` is a string like any other: compared, never resolved;
 * - a value holding more than {@link TOOL_SCHEMA_DEPTH_MAX} nested containers on
 *   either side is **not equal**, and nothing here throws — the same bound the
 *   admission holds a pin to with {@link jsonDepthWithin}.
 *
 * No digest: the edge imports no `node:crypto`, and a hash would need a second
 * canonicalizer beside the contracts' one. Nothing here validates a tool call's
 * `arguments` against either schema.
 */

import { TOOL_SCHEMA_DEPTH_MAX } from "../contract/index.js";

/** Are two JSON values equal as values? Never throws; too deep is not equal. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return equalAt(a, b, 0);
}

function equalAt(a: unknown, b: unknown, depth: number): boolean {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  // A container at this depth is the (depth + 1)th: past the bound, whichever
  // side it is on and whatever it holds, it compares unequal.
  if (depth >= TOOL_SCHEMA_DEPTH_MAX) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!equalAt(a[index], b[index], depth + 1)) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    // Own keys only: a `__proto__` key a JSON parse created is an own data
    // property on both sides, and an inherited member is never a schema field.
    if (!Object.hasOwn(right, key)) return false;
    if (!equalAt(left[key], right[key], depth + 1)) return false;
  }
  return true;
}

/** Is this JSON value at most `max` containers deep? Stops at `max + 1`, so a cycle ends too. */
export function jsonDepthWithin(value: unknown, max: number): boolean {
  const within = (node: unknown, depth: number): boolean => {
    if (typeof node !== "object" || node === null) return true;
    if (depth >= max) return false;
    const children = Array.isArray(node) ? (node as readonly unknown[]) : Object.values(node as Record<string, unknown>);
    return children.every((child) => within(child, depth + 1));
  };
  return within(value, 0);
}
