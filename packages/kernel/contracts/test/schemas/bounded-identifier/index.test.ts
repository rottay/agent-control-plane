import { describe, expect, it } from "vitest";

import { BOUNDED_IDENTIFIER, BoundedIdentifier } from "../../../src/index.js";

/**
 * Evidence for the canonical bounded identifier grammar (V2-B4b stage 3A).
 *
 * Three claims. The grammar is exactly the one the durable recorder already
 * enforced, so canonicalizing it moved no behaviour; the RegExp and the schema
 * are the same decision expressed twice, so a caller that tests and a caller
 * that parses cannot disagree; and the constant is stateless, so two callers
 * sharing it cannot make each other's answers depend on call order.
 */

/** The pattern, restated here and nowhere else, so a silent widening fails. */
const PINNED_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$";

const ACCEPTED: readonly string[] = [
  "a",
  "docs",
  "docs.search",
  "acct-primary",
  // Underscore and colon are both in the class, so a namespaced name with an
  // underscore in it is a name, not content. Asserted because it is the case a
  // reader is most likely to guess wrongly at.
  "a:b_c",
  "x".repeat(120),
];

const REFUSED: readonly string[] = [
  "",
  "read file",
  "x".repeat(121),
  ".leading",
  "has/slash",
  "has\nnewline",
  'has"quote',
  "{brace}",
];

describe("the grammar admits a configured name and nothing that could hold content", () => {
  it.each(ACCEPTED)("accepts %j", (value) => {
    expect(BOUNDED_IDENTIFIER.test(value)).toBe(true);
  });

  it.each(REFUSED)("refuses %j", (value) => {
    expect(BOUNDED_IDENTIFIER.test(value)).toBe(false);
  });

  it("bounds the length at 120 characters exactly", () => {
    expect(BOUNDED_IDENTIFIER.test("x".repeat(120))).toBe(true);
    expect(BOUNDED_IDENTIFIER.test("x".repeat(121))).toBe(false);
  });
});

describe("the schema and the RegExp are one decision, not two", () => {
  it.each([...ACCEPTED, ...REFUSED])("agrees with the RegExp on %j", (value) => {
    expect(BoundedIdentifier.safeParse(value).success).toBe(BOUNDED_IDENTIFIER.test(value));
  });

  it("refuses a non-string outright rather than coercing it", () => {
    // `.test()` would stringify; the schema is the caller that must not.
    expect(BoundedIdentifier.safeParse(7).success).toBe(false);
    expect(BoundedIdentifier.safeParse(null).success).toBe(false);
  });
});

describe("the constant is shared, so it carries no state", () => {
  it("is not global: a shared g-flagged instance would answer by call order", () => {
    expect(BOUNDED_IDENTIFIER.global).toBe(false);
    // The property that the flag would break, driven rather than described.
    expect(BOUNDED_IDENTIFIER.test("docs.search")).toBe(true);
    expect(BOUNDED_IDENTIFIER.test("docs.search")).toBe(true);
    expect(BOUNDED_IDENTIFIER.lastIndex).toBe(0);
  });

  it("carries exactly the pinned source", () => {
    expect(BOUNDED_IDENTIFIER.source).toBe(PINNED_SOURCE);
    expect(BOUNDED_IDENTIFIER.flags).toBe("");
  });
});
