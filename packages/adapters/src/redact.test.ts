import { describe, expect, it } from "vitest";

import {
  PAYLOAD_BYTES_MAX,
  PAYLOAD_STRING_MAX,
  boundString,
  hasPrivacyViolation,
  shapePayload,
} from "./redact.js";

describe("payloads are bounded before they are emitted", () => {
  it("caps a string at its ceiling", () => {
    expect(boundString("x".repeat(PAYLOAD_STRING_MAX + 50))).toHaveLength(PAYLOAD_STRING_MAX);
    expect(boundString("short")).toBe("short");
  });

  it("refuses a payload that is still too large once shaped", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      wide["key" + String(index)] = "v".repeat(PAYLOAD_STRING_MAX);
    }
    expect(shapePayload(wide)).toEqual({ truncated: true });
  });

  it("emits keys in a stable order, so the same payload serializes identically", () => {
    const first = JSON.stringify(shapePayload({ b: 2, a: 1, c: 3 }));
    const second = JSON.stringify(shapePayload({ c: 3, a: 1, b: 2 }));
    expect(second).toBe(first);
  });

  it("drops nested structures rather than walking them", () => {
    // A nested object is where a transcript would hide. Walking it would mean
    // deciding, at every depth, what is safe; dropping it decides once.
    expect(shapePayload({ ok: 1, nested: { transcript: ["turn"] }, list: [1, 2] })).toEqual({
      ok: 1,
    });
  });
});

describe("redaction is absence, in the one privacy vocabulary", () => {
  it("reports a credential-shaped key even when blanked", () => {
    expect(hasPrivacyViolation({ apiKey: "" })).toBe(true);
  });

  it("reports a transcript-shaped key", () => {
    expect(hasPrivacyViolation({ transcript: [] })).toBe(true);
  });

  it("stays quiet on a clean payload", () => {
    expect(hasPrivacyViolation({ provider: "claude", stepIndex: 1 })).toBe(false);
  });

  it("drops a credential-shaped key rather than blanking it", () => {
    // Absence, not emptiness: a blanked field still names the secret.
    const shaped = shapePayload({ provider: "claude", apiKey: "secret-shaped" });
    expect(shaped).toEqual({ provider: "claude" });
    expect(Object.hasOwn(shaped, "apiKey")).toBe(false);
  });

  it("never lets a transcript through", () => {
    const shaped = shapePayload({ stepIndex: 2, transcript: "turn one" });
    expect(shaped).toEqual({ stepIndex: 2 });
    expect(hasPrivacyViolation(shaped)).toBe(false);
  });

  it("bounds are declared, not magic", () => {
    expect(PAYLOAD_STRING_MAX).toBe(200);
    expect(PAYLOAD_BYTES_MAX).toBe(2_048);
  });
});
