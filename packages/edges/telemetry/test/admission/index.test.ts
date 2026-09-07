import { describe, expect, it } from "vitest";

import { admitOtlpEndpoint } from "../../src/admission/index.js";
import {
  OTLP_HEADERS_MAX,
  OTLP_HEADER_VALUE_MAX_BYTES,
  OTLP_SERVICE_NAME_MAX_LENGTH,
  OTLP_TIMEOUT_DEFAULT_MS,
  OTLP_TIMEOUT_MAX_MS,
} from "../../src/contract/index.js";

/**
 * What may be talked to, field by field.
 *
 * Every refusal below names its own coordinate, so a test can assert WHICH law
 * fired rather than only that something did. A suite that asserted `ok: false`
 * everywhere would pass against an admission that refused everything for one
 * reason.
 */

const BASE = "http://127.0.0.1:6006";

function admitted(endpoint: string): ReturnType<typeof admitOtlpEndpoint> {
  return admitOtlpEndpoint({ endpoint });
}

describe("loopback is an address, never a name", () => {
  it("admits the two literal loopback addresses, with and without a port", () => {
    for (const endpoint of ["http://127.0.0.1:6006", "http://127.0.0.1", "http://[::1]:6006", "http://[::1]"]) {
      const outcome = admitted(endpoint);
      expect(outcome.ok).toBe(true);
    }
  });

  it("refuses localhost by name; resolving a name means DNS", () => {
    const outcome = admitted("http://localhost:6006");
    expect(outcome).toEqual({ ok: false, refusal: "ENDPOINT_HOST_REFUSED", at: "endpoint.hostname" });
  });

  it("refuses every host that is not this machine, by address or by name", () => {
    for (const endpoint of [
      "http://10.0.0.5:6006",
      "http://collector.internal:6006",
      "http://127.0.0.2:6006",
      "http://[::2]:6006",
    ]) {
      expect(admitted(endpoint)).toEqual({
        ok: false,
        refusal: "ENDPOINT_HOST_REFUSED",
        at: "endpoint.hostname",
      });
    }
  });

  it("refuses https in R11: a loopback trust decision this edge cannot make", () => {
    expect(admitted("https://127.0.0.1:6006")).toEqual({
      ok: false,
      refusal: "ENDPOINT_SCHEME_REFUSED",
      at: "endpoint.protocol",
    });
  });

  it("refuses userinfo; a credential may not ride the target", () => {
    expect(admitted("http://user:secret@127.0.0.1:6006")).toEqual({
      ok: false,
      refusal: "ENDPOINT_CREDENTIALED",
      at: "endpoint.credentials",
    });
  });

  it("refuses a candidate that is not a URL at all", () => {
    expect(admitted("6006")).toEqual({ ok: false, refusal: "ENDPOINT_MALFORMED", at: "endpoint" });
  });

  it("refuses a base carrying a path, a query or a fragment", () => {
    for (const endpoint of [
      "http://127.0.0.1:6006/collector",
      "http://127.0.0.1:6006/?tenant=a",
      "http://127.0.0.1:6006/#frag",
    ]) {
      expect(admitted(endpoint)).toEqual({
        ok: false,
        refusal: "ENDPOINT_PATH_REFUSED",
        at: "endpoint.path",
      });
    }
  });

  it("refuses a port outside the range a port has", () => {
    expect(admitted("http://127.0.0.1:99999")).toEqual({
      ok: false,
      refusal: "ENDPOINT_MALFORMED",
      at: "endpoint",
    });
  });
});

describe("the target is joined once, here, and nowhere else", () => {
  it("appends the traces path to the origin and keeps it verbatim", () => {
    const outcome = admitted(BASE);
    if (!outcome.ok) throw new Error("the loopback fixture must be admissible");
    expect(outcome.endpoint.target).toBe(BASE + "/v1/traces");
  });

  it("normalises the two spellings of a bare origin to one target", () => {
    const bare = admitted("http://127.0.0.1:6006");
    const slash = admitted("http://127.0.0.1:6006/");
    if (!bare.ok || !slash.ok) throw new Error("both spellings must be admissible");
    expect(bare.endpoint.target).toBe(slash.endpoint.target);
  });
});

describe("headers are bounded, sorted and never credential-shaped", () => {
  it("admits a bounded set and freezes it in key order", () => {
    const outcome = admitOtlpEndpoint({ endpoint: BASE, headers: { "x-b": "2", "x-a": "1" } });
    if (!outcome.ok) throw new Error("the header fixture must be admissible");
    expect(Object.keys(outcome.endpoint.headers)).toEqual(["x-a", "x-b"]);
    expect(Object.isFrozen(outcome.endpoint.headers)).toBe(true);
  });

  it("defaults to no header at all; nothing is sent that was not configured", () => {
    const outcome = admitted(BASE);
    if (!outcome.ok) throw new Error("the loopback fixture must be admissible");
    expect(outcome.endpoint.headers).toEqual({});
  });

  it("refuses the credential-shaped names outright", () => {
    for (const name of ["authorization", "Authorization", "cookie", "proxy-authorization"]) {
      expect(admitOtlpEndpoint({ endpoint: BASE, headers: { [name]: "x" } })).toEqual({
        ok: false,
        refusal: "ENDPOINT_HEADERS_REFUSED",
        at: "headers",
      });
    }
  });

  it("refuses the content type, which the transport owns", () => {
    expect(admitOtlpEndpoint({ endpoint: BASE, headers: { "content-type": "text/plain" } })).toEqual({
      ok: false,
      refusal: "ENDPOINT_HEADERS_REFUSED",
      at: "headers",
    });
  });

  it("refuses more headers than the bound, and an oversized value", () => {
    const many: Record<string, string> = {};
    for (let index = 0; index <= OTLP_HEADERS_MAX; index += 1) many["x-h" + String(index)] = "1";
    expect(admitOtlpEndpoint({ endpoint: BASE, headers: many }).ok).toBe(false);
    expect(
      admitOtlpEndpoint({
        endpoint: BASE,
        headers: { "x-a": "v".repeat(OTLP_HEADER_VALUE_MAX_BYTES + 1) },
      }).ok,
    ).toBe(false);
  });

  it("refuses a header value carrying a line break to inject with", () => {
    expect(admitOtlpEndpoint({ endpoint: BASE, headers: { "x-a": "one\r\nx-b: two" } })).toEqual({
      ok: false,
      refusal: "ENDPOINT_HEADERS_REFUSED",
      at: "headers",
    });
  });
});

describe("the timeout and the service name are bounded", () => {
  it("defaults the timeout and admits one inside the ceiling", () => {
    const bare = admitted(BASE);
    if (!bare.ok) throw new Error("the loopback fixture must be admissible");
    expect(bare.endpoint.timeoutMs).toBe(OTLP_TIMEOUT_DEFAULT_MS);

    const chosen = admitOtlpEndpoint({ endpoint: BASE, timeoutMs: 1_500 });
    if (!chosen.ok) throw new Error("a timeout inside the ceiling must be admissible");
    expect(chosen.endpoint.timeoutMs).toBe(1_500);
  });

  it("refuses a timeout past the ceiling, at zero, or fractional", () => {
    for (const timeoutMs of [OTLP_TIMEOUT_MAX_MS + 1, 0, -1, 1.5]) {
      expect(admitOtlpEndpoint({ endpoint: BASE, timeoutMs })).toEqual({
        ok: false,
        refusal: "ENDPOINT_TIMEOUT_REFUSED",
        at: "timeoutMs",
      });
    }
  });

  it("defaults the service name and refuses one outside its bound", () => {
    const bare = admitted(BASE);
    if (!bare.ok) throw new Error("the loopback fixture must be admissible");
    expect(bare.endpoint.serviceName).toBe("acp");

    for (const serviceName of ["", "s".repeat(OTLP_SERVICE_NAME_MAX_LENGTH + 1), "acp\nx"]) {
      expect(admitOtlpEndpoint({ endpoint: BASE, serviceName })).toEqual({
        ok: false,
        refusal: "ENDPOINT_SERVICE_NAME_REFUSED",
        at: "serviceName",
      });
    }
  });
});
