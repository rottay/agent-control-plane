import { emitTelemetry } from "@acp/observation";
import { afterEach, describe, expect, it } from "vitest";

import { admitOtlpEndpoint } from "../../src/admission/index.js";
import type { AdmittedOtlpEndpoint } from "../../src/admission/index.js";
import { postOtlpBody } from "../../src/http/index.js";
import { serializeTelemetryBatch } from "../../src/otlp/index.js";
import { ROOT_AND_CHILD, scriptFetch } from "../testing/index.js";
import type { ScriptedFetch } from "../testing/index.js";

/**
 * The one leg that reaches the network, driven against a scripted peer.
 *
 * **No socket is bound anywhere here**, and the record says so: `SOCKET_EXERCISED`
 * and `LIVE_CONFORMANCE` both read `NONE`. What these drills prove is that every
 * way a request can fail is classified rather than thrown, and that the request
 * that does go out carries nothing it was not given.
 */

const ENDPOINT = "http://127.0.0.1:6006";

function admitted(): AdmittedOtlpEndpoint {
  const outcome = admitOtlpEndpoint({ endpoint: ENDPOINT });
  if (!outcome.ok) throw new Error("the loopback fixture must be admissible");
  return outcome.endpoint;
}

const BODY = serializeTelemetryBatch(emitTelemetry(ROOT_AND_CHILD), "acp").body;

let peer: ScriptedFetch | null = null;

afterEach(() => {
  peer?.restore();
  peer = null;
});

describe("every failure is a classified value, never a thrown error", () => {
  it("classifies a rejected connection as ENDPOINT_UNREACHABLE", async () => {
    peer = scriptFetch([{ rejectAs: "UNREACHABLE" }]);
    await expect(postOtlpBody(admitted(), BODY)).resolves.toEqual({
      ok: false,
      reason: "ENDPOINT_UNREACHABLE",
      at: "endpoint.request",
    });
  });

  it("classifies an abort as ENDPOINT_TIMEOUT, apart from unreachable", async () => {
    peer = scriptFetch([{ rejectAs: "TIMEOUT" }]);
    // The distinction is the point: a transport that folded both into one name
    // would tell an operator nothing about whether the collector is down or
    // merely slow, and this assertion is what keeps them apart.
    await expect(postOtlpBody(admitted(), BODY)).resolves.toEqual({
      ok: false,
      reason: "ENDPOINT_TIMEOUT",
      at: "endpoint.request",
    });
  });

  it("classifies a non-2xx answer as ENDPOINT_REJECTED, whatever the code", async () => {
    for (const status of [500, 404, 400, 503]) {
      peer?.restore();
      peer = scriptFetch([{ status }]);
      await expect(postOtlpBody(admitted(), BODY)).resolves.toEqual({
        ok: false,
        reason: "ENDPOINT_REJECTED",
        at: "endpoint.response",
      });
    }
  });

  it("refuses a redirect rather than following it, which is what manual buys", async () => {
    peer = scriptFetch([{ status: 302, headers: { location: "http://10.0.0.5:6006/v1/traces" } }]);
    // A followed redirect is an escape nobody sees: the admitted target would
    // stop being the target. `redirect: "error"` would reject with a TypeError
    // indistinguishable from a connection failure, so this refusal could not
    // be told from ENDPOINT_UNREACHABLE and could never be asserted.
    await expect(postOtlpBody(admitted(), BODY)).resolves.toEqual({
      ok: false,
      reason: "REDIRECT_REFUSED",
      at: "endpoint.response",
    });
  });

  it("accepts the success band and nothing either side of it", async () => {
    peer = scriptFetch([{ status: 200 }, { status: 202 }, { status: 299 }]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(postOtlpBody(admitted(), BODY)).resolves.toEqual({ ok: true });
    }
  });
});

describe("the request carries the admitted target and nothing else", () => {
  it("posts to the admitted string verbatim, never a target it built", async () => {
    peer = scriptFetch([{ status: 200 }]);
    const endpoint = admitted();
    await postOtlpBody(endpoint, BODY);
    const [call] = peer.calls();
    if (call === undefined) throw new Error("the peer must have been called once");
    expect(call.url).toBe(endpoint.target);
  });

  it("declares JSON and carries no credential of any kind", async () => {
    peer = scriptFetch([{ status: 200 }]);
    await postOtlpBody(admitted(), BODY);
    const [call] = peer.calls();
    if (call === undefined) throw new Error("the peer must have been called once");

    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(BODY);
    expect(call.init.redirect).toBe("manual");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    // Absence asserted by name, over the whole init: "we do not send one" is a
    // weaker claim than "there is nothing here that could".
    const serialized = JSON.stringify(call.init).toLowerCase();
    for (const forbidden of ["authorization", "cookie", "credentials", "bearer", "proxy-"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("sends the admitted headers beside the content type, and only those", async () => {
    peer = scriptFetch([{ status: 200 }]);
    const outcome = admitOtlpEndpoint({ endpoint: ENDPOINT, headers: { "x-tenant": "drill" } });
    if (!outcome.ok) throw new Error("the header fixture must be admissible");
    await postOtlpBody(outcome.endpoint, BODY);
    const [call] = peer.calls();
    if (call === undefined) throw new Error("the peer must have been called once");
    expect(call.init.headers).toEqual({ "x-tenant": "drill", "content-type": "application/json" });
  });

  it("bounds the request in time with the admitted timeout", async () => {
    peer = scriptFetch([{ status: 200 }]);
    const outcome = admitOtlpEndpoint({ endpoint: ENDPOINT, timeoutMs: 25 });
    if (!outcome.ok) throw new Error("the timeout fixture must be admissible");
    expect(outcome.endpoint.timeoutMs).toBe(25);
    await postOtlpBody(outcome.endpoint, BODY);
    const [call] = peer.calls();
    if (call === undefined) throw new Error("the peer must have been called once");
    expect(call.init.signal?.aborted).toBe(false);
  });
});
