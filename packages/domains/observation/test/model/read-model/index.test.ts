import { describe, expect, it } from "vitest";

import { MAX_PAYLOAD_KEYS, payloadKeys } from "../../../src/model/read-model/index.js";

/**
 * Evidence for the payload-key projection.
 *
 * Every expected array below is written by hand, in code-unit order, never
 * derived from the function under test: `expect(actual.sort())` would pass
 * against any ordering bug and is exactly the habit structure §4.1 :203-204
 * forbids. The locale-sensitive case is the one that pins "code-unit, not
 * locale": in a dictionary locale the order below is wrong on purpose.
 */

describe("payloadKeys", () => {
  it("lists an unsorted payload in canonical code-unit order", () => {
    const payload = { zebra: 1, mango: 2, Apple: 3, "10": 4, banana: 5 };
    expect(payloadKeys(payload)).toEqual(["10", "Apple", "banana", "mango", "zebra"]);
  });

  it("orders characters that sort differently between locales by code unit", () => {
    // Written by hand in UTF-16 code-unit order: digits, then uppercase, then
    // lowercase, then Latin-1 supplements. A locale-aware collator orders
    // these differently (case-folding alone moves "Apple"), which is why the
    // projection must not use one.
    const payload = { cherry: 1, "2": 2, äpfel: 3, "10": 4, Zebra: 5, banana: 6, Apple: 7, _under: 8 };
    expect(payloadKeys(payload)).toEqual([
      "10",
      "2",
      "Apple",
      "Zebra",
      "_under",
      "banana",
      "cherry",
      "äpfel",
    ]);
  });

  it("returns an empty list for an empty payload", () => {
    expect(payloadKeys({})).toEqual([]);
  });

  it("keeps every key at exactly the ceiling", () => {
    const keys = Array.from({ length: MAX_PAYLOAD_KEYS }, (_, index) => "k" + String(index).padStart(2, "0"));
    const payload = Object.fromEntries(keys.map((key) => [key, true]));
    expect(payloadKeys(payload)).toEqual(keys);
  });

  it("drops the keys past the ceiling after sorting, not before", () => {
    const keys = Array.from({ length: 70 }, (_, index) => "k" + String(index).padStart(2, "0"));
    const payload = Object.fromEntries(keys.map((key) => [key, true]));
    // Hand-written: the first sixty four names in code-unit order are k00
    // through k63; k64-k69 are the ones past the ceiling. Sorted-first
    // truncation is the observable behaviour both doors must share.
    expect(payloadKeys(payload)).toEqual([
      "k00", "k01", "k02", "k03", "k04", "k05", "k06", "k07", "k08", "k09",
      "k10", "k11", "k12", "k13", "k14", "k15", "k16", "k17", "k18", "k19",
      "k20", "k21", "k22", "k23", "k24", "k25", "k26", "k27", "k28", "k29",
      "k30", "k31", "k32", "k33", "k34", "k35", "k36", "k37", "k38", "k39",
      "k40", "k41", "k42", "k43", "k44", "k45", "k46", "k47", "k48", "k49",
      "k50", "k51", "k52", "k53", "k54", "k55", "k56", "k57", "k58", "k59",
      "k60", "k61", "k62", "k63",
    ]);
  });
});
