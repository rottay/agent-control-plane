import { describe, expect, it } from "vitest";

import {
  OTLP_BODY_MAX_BYTES,
  OTLP_EXPORT_RECORD,
  OTLP_HEADERS_MAX,
  OTLP_HEADER_VALUE_MAX_BYTES,
  OTLP_SCOPE_NAME,
  OTLP_SERVICE_NAME_DEFAULT,
  OTLP_SERVICE_NAME_MAX_LENGTH,
  OTLP_TIMEOUT_DEFAULT_MS,
  OTLP_TIMEOUT_MAX_MS,
  TELEMETRY_ADMISSION_REFUSALS,
  TELEMETRY_EXPORT_REFUSALS,
} from "../../src/contract/index.js";

/**
 * The vocabulary and the ceilings, asserted as whole surfaces rather than
 * sampled.
 *
 * A closed union is only closed if something checks the whole list: a test that
 * asserted three of six members would pass while a seventh was added, and the
 * exhaustiveness a caller relies on would be gone with nobody noticing.
 */
describe("the export vocabulary is closed and exhaustible", () => {
  it("names exactly six refusals, each one something this edge really does", () => {
    expect([...TELEMETRY_EXPORT_REFUSALS]).toEqual([
      "ENDPOINT_UNREACHABLE",
      "ENDPOINT_TIMEOUT",
      "ENDPOINT_REJECTED",
      "REDIRECT_REFUSED",
      "NOTHING_TO_EXPORT",
      "PAYLOAD_TOO_LARGE",
    ]);
    expect(new Set(TELEMETRY_EXPORT_REFUSALS).size).toBe(TELEMETRY_EXPORT_REFUSALS.length);
  });

  it("keeps admission refusals a separate vocabulary from export refusals", () => {
    expect([...TELEMETRY_ADMISSION_REFUSALS]).toEqual([
      "ENDPOINT_MALFORMED",
      "ENDPOINT_SCHEME_REFUSED",
      "ENDPOINT_HOST_REFUSED",
      "ENDPOINT_CREDENTIALED",
      "ENDPOINT_PATH_REFUSED",
      "ENDPOINT_HEADERS_REFUSED",
      "ENDPOINT_TIMEOUT_REFUSED",
      "ENDPOINT_SERVICE_NAME_REFUSED",
    ]);
    // Disjoint on purpose. A configuration mistake and a dead collector are
    // different facts, and one name for both would make them one fact.
    const exports_ = new Set<string>(TELEMETRY_EXPORT_REFUSALS);
    for (const name of TELEMETRY_ADMISSION_REFUSALS) expect(exports_.has(name)).toBe(false);
  });
});

describe("the ceilings are declared, ordered and bounded", () => {
  it("pins the body ceiling at four mebibytes, in bytes", () => {
    expect(OTLP_BODY_MAX_BYTES).toBe(4_194_304);
  });

  it("gives a default timeout inside the ceiling it is capped by", () => {
    expect(OTLP_TIMEOUT_DEFAULT_MS).toBe(10_000);
    expect(OTLP_TIMEOUT_MAX_MS).toBe(30_000);
    // A default above its own cap would make every unconfigured endpoint
    // unadmissible, which is the kind of dead constant a pair of numbers
    // written apart from each other eventually becomes.
    expect(OTLP_TIMEOUT_DEFAULT_MS).toBeLessThanOrEqual(OTLP_TIMEOUT_MAX_MS);
  });

  it("bounds headers by count and by value size", () => {
    expect(OTLP_HEADERS_MAX).toBe(8);
    expect(OTLP_HEADER_VALUE_MAX_BYTES).toBe(1_024);
  });

  it("names the scope after the module and gives it no version", () => {
    expect(OTLP_SCOPE_NAME).toBe("@acp/telemetry");
    // The absence is the assertion. Every package here is `0.0.0`, and a
    // version that carries no information must not be sent as though it did.
    expect(Object.keys(OTLP_EXPORT_RECORD)).not.toContain("SCOPE_VERSION");
  });

  it("bounds the configurable service name, which rides the wire", () => {
    expect(OTLP_SERVICE_NAME_DEFAULT).toBe("acp");
    expect(OTLP_SERVICE_NAME_MAX_LENGTH).toBe(128);
    expect(OTLP_SERVICE_NAME_DEFAULT.length).toBeLessThanOrEqual(OTLP_SERVICE_NAME_MAX_LENGTH);
  });
});

describe("the export record says what was not proved", () => {
  it("reads NONE and UNKNOWN where R11 established nothing", () => {
    // Restriction 5, and the owner ruling with it: CONFIRMED only by a drill
    // with a real subject, and that drill is owner-gated and outside R11.
    expect({
      socket: OTLP_EXPORT_RECORD.SOCKET_EXERCISED,
      live: OTLP_EXPORT_RECORD.LIVE_CONFORMANCE,
      capabilities: OTLP_EXPORT_RECORD.CAPABILITIES,
    }).toEqual({ socket: "NONE", live: "NONE", capabilities: "UNKNOWN" });
  });

  it("carries no empty value; a blank reads as 'not applicable' and means 'unfilled'", () => {
    for (const [key, value] of Object.entries(OTLP_EXPORT_RECORD)) {
      expect(key + "=" + value).not.toBe(key + "=");
    }
  });
});
