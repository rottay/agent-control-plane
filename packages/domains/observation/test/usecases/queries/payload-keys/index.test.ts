import { describe, expect, it } from "vitest";

import { MAX_PAYLOAD_KEYS, payloadKeys } from "../../../../src/usecases/queries/payload-keys/index.js";

/**
 * Evidence for the payload-keys query.
 *
 * The query is a delegate over the read model, so these cases exist to pin the
 * boundary itself: the surface a door may call keeps the same contract — code
 * unit order, ceiling after sorting — as the model it wraps. Expected arrays
 * are written by hand, never derived from the implementation under test, per
 * structure §4.1 :203-204.
 */

describe("the payload-keys query", () => {
  it("answers in canonical code-unit order", () => {
    const payload = { delta: 1, alpha: 2, Charlie: 3, "9": 4, bravo: 5 };
    expect(payloadKeys(payload)).toEqual(["9", "Charlie", "alpha", "bravo", "delta"]);
  });

  it("orders locale-sensitive characters by code unit", () => {
    const payload = { übung: 1, "1": 2, Alpha: 3, zulu: 4, "20": 5, beta: 6 };
    expect(payloadKeys(payload)).toEqual(["1", "20", "Alpha", "beta", "zulu", "übung"]);
  });

  it("caps the answer at the ceiling, dropping the tail after sorting", () => {
    const keys = Array.from({ length: MAX_PAYLOAD_KEYS + 6 }, (_, index) => "key-" + String(index).padStart(3, "0"));
    const payload = Object.fromEntries(keys.map((key) => [key, null]));
    const answer = payloadKeys(payload);
    expect(answer).toHaveLength(MAX_PAYLOAD_KEYS);
    expect(answer[0]).toBe("key-000");
    expect(answer[MAX_PAYLOAD_KEYS - 1]).toBe("key-063");
    expect(answer).not.toContain("key-064");
  });
});
