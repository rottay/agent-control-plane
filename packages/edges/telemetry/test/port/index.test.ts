import { emitTelemetry } from "@acp/observation";
import { afterEach, describe, expect, it } from "vitest";

import { admitOtlpEndpoint } from "../../src/admission/index.js";
import { createOtlpExporterPort } from "../../src/port/index.js";
import type { TelemetryExporterPort } from "../../src/port/index.js";
import { CONTEXTLESS, CREDENTIAL_REFUSED, ROOT_AND_CHILD, scriptFetch } from "../testing/index.js";
import type { ScriptedFetch } from "../testing/index.js";

/**
 * The seam a composition root would hold, and what it promises.
 *
 * Two claims, and both are about what does NOT happen. The port never throws,
 * whatever the endpoint does — which is the first mechanism restriction 3 asks
 * for, and the one a caller gets even if it ignores the return value. And the
 * receipt is populated on both branches, because a failed export still knows
 * how many spans it would have sent.
 */

const ENDPOINT = "http://127.0.0.1:6006";

let peer: ScriptedFetch | null = null;

afterEach(() => {
  peer?.restore();
  peer = null;
});

/** The body the peer was handed, asserted to be the string the transport sent. */
function bodyOf(init: RequestInit): string {
  const { body } = init;
  if (typeof body !== "string") throw new Error("the transport posts a serialized string body");
  return body;
}

function exporter(): TelemetryExporterPort {
  const outcome = admitOtlpEndpoint({ endpoint: ENDPOINT, serviceName: "acp-drill" });
  if (!outcome.ok) throw new Error("the loopback fixture must be admissible");
  return createOtlpExporterPort(outcome.endpoint);
}

describe("the port returns an outcome and never raises", () => {
  it("reports ok with a receipt the serialization established", async () => {
    peer = scriptFetch([{ status: 200 }]);
    const outcome = await exporter().export(emitTelemetry(ROOT_AND_CHILD));
    expect(outcome.ok).toBe(true);
    expect(outcome.receipt.spanCount).toBe(2);
    expect(outcome.receipt.unexportableCount).toBe(0);
    expect(outcome.receipt.refusedCount).toBe(0);
    expect(outcome.receipt.bytes).toBeGreaterThan(0);
  });

  it("carries the receipt on the failure branch too, where it matters most", async () => {
    peer = scriptFetch([{ status: 503 }]);
    const batch = emitTelemetry([...ROOT_AND_CHILD, ...CONTEXTLESS]);
    const outcome = await exporter().export(batch);
    expect(outcome).toEqual({
      ok: false,
      reason: "ENDPOINT_REJECTED",
      at: "endpoint.response",
      receipt: {
        spanCount: 2,
        unexportableCount: 1,
        refusedCount: 0,
        bytes: expect.any(Number),
      },
    });
  });

  it("answers every transport failure as a value, with no rejection to catch", async () => {
    const cases = [
      { script: { rejectAs: "UNREACHABLE" } as const, reason: "ENDPOINT_UNREACHABLE" },
      { script: { rejectAs: "TIMEOUT" } as const, reason: "ENDPOINT_TIMEOUT" },
      { script: { status: 500 } as const, reason: "ENDPOINT_REJECTED" },
      { script: { status: 404 } as const, reason: "ENDPOINT_REJECTED" },
      {
        script: { status: 302, headers: { location: "http://10.0.0.5:6006/v1/traces" } } as const,
        reason: "REDIRECT_REFUSED",
      },
    ];
    for (const scenario of cases) {
      peer?.restore();
      peer = scriptFetch([scenario.script]);
      // `resolves`, not `rejects`: the whole claim is that nothing here throws.
      const outcome = await exporter().export(emitTelemetry(ROOT_AND_CHILD));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("this scenario must refuse");
      expect(outcome.reason).toBe(scenario.reason);
      expect(outcome.receipt.spanCount).toBe(2);
    }
  });

  it("carries the batch's refused count through without carrying what was refused", async () => {
    peer = scriptFetch([{ status: 200 }]);
    // The redaction gate's own count, produced by the real projection over a
    // payload it really refuses. The coordinates do not travel: a vendor
    // surface may see THAT something was withheld, never what.
    const batch = emitTelemetry(CREDENTIAL_REFUSED);
    expect(batch.refusedCount).toBe(1);

    const outcome = await exporter().export(batch);
    expect(outcome.receipt.refusedCount).toBe(1);
    const [call] = peer.calls();
    if (call === undefined) throw new Error("the peer must have been called once");
    const body = bodyOf(call.init);
    expect(body).not.toContain("apiKey");
    expect(body).not.toContain("sk-");
    // The count reaches the resource, so a reader of the vendor surface can see
    // that something was withheld without the vendor surface being told what.
    expect(body).toContain('{"key":"acp.telemetry.refused_count","value":{"intValue":"1"}}');
  });
});

describe("the exporter is bound to an endpoint it could not have invented", () => {
  it("takes an admitted endpoint, whose only mint site is the admission", async () => {
    peer = scriptFetch([{ status: 200 }]);
    const outcome = admitOtlpEndpoint({ endpoint: ENDPOINT });
    if (!outcome.ok) throw new Error("the loopback fixture must be admissible");
    await createOtlpExporterPort(outcome.endpoint).export(emitTelemetry(ROOT_AND_CHILD));
    const [call] = peer.calls();
    if (call === undefined) throw new Error("the peer must have been called once");
    expect(call.url).toBe(outcome.endpoint.target);
  });

  it("reports the service name the endpoint was admitted with", async () => {
    peer = scriptFetch([{ status: 200 }]);
    await exporter().export(emitTelemetry(ROOT_AND_CHILD));
    const [call] = peer.calls();
    if (call === undefined) throw new Error("the peer must have been called once");
    expect(bodyOf(call.init)).toContain('{"key":"service.name","value":{"stringValue":"acp-drill"}}');
  });
});
