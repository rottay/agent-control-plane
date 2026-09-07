import type { TelemetryBatch } from "@acp/observation";

import type { AdmittedOtlpEndpoint } from "../admission/index.js";
import { OTLP_BODY_MAX_BYTES } from "../contract/index.js";
import type { TelemetryExportOutcome, TelemetryExportReceipt } from "../contract/index.js";
import { postOtlpBody } from "../http/index.js";
import { serializeTelemetryBatch } from "../otlp/index.js";

/**
 * The exporter seam (V2-B5/R11).
 *
 * **The port lives in this edge rather than in `@acp/contracts`**, and the
 * reason is the one the tool edge already wrote down: a kernel port earns its
 * place when an independent party must agree with it, and this port's only
 * agreeing party today is whatever composition root constructs it. No domain
 * takes it by injection — none may even name this package — so moving the type
 * into the kernel now would be a widening nobody needs. The moment a domain
 * does take an exporter by injection, that is the trigger to move the type, and
 * the move is a decision somebody makes on purpose. That moment is R11b.
 *
 * **The contract speaks this plane's model, never OTel's.** The input is
 * `TelemetryBatch`: route, outcome, tokens and durations are already our
 * vocabulary inside its attributes, and redaction is already applied upstream
 * and structurally. No OTel type, enum or name appears in this file or in the
 * contract beside it; they exist only inside the serializer.
 *
 * **The input is branded, and the brand is the guarantee.** `TelemetryEvent`'s
 * only mint site is `emitTelemetry`, so an exporter typed on `TelemetryBatch`
 * is structurally incapable of sending a record that did not pass the redaction
 * gate. A structurally-typed `ExportableSpan` would compile and would quietly
 * discard exactly that.
 *
 * **Nothing here appends.** A failed export is a returned value and a set of
 * counters. This package names no ledger, in its manifest or in its imports,
 * and the fence asserts both: recording an export failure in the ledger would
 * make a vendor's availability part of the evidence chain, which is the precise
 * thing restriction 3 exists to prevent.
 */

/** Where the port itself decides a refusal, before or instead of a request. */
const AT_BATCH = "exporter.batch";

export interface TelemetryExporterPort {
  readonly export: (batch: TelemetryBatch) => Promise<TelemetryExportOutcome>;
}

/**
 * An exporter bound to one admitted endpoint.
 *
 * The endpoint is admitted before this is called, and cannot be anything else:
 * `AdmittedOtlpEndpoint` has one mint site and it is the admission. A factory
 * taking a string would put the loopback decision in the hands of every caller.
 */
export function createOtlpExporterPort(endpoint: AdmittedOtlpEndpoint): TelemetryExporterPort {
  return {
    export: async (batch: TelemetryBatch): Promise<TelemetryExportOutcome> => {
      const serialized = serializeTelemetryBatch(batch, endpoint.serviceName);
      const receipt: TelemetryExportReceipt = {
        spanCount: serialized.spanCount,
        unexportableCount: serialized.unexportableCount,
        refusedCount: batch.refusedCount,
        bytes: serialized.bytes,
      };

      // Nothing to say, so nothing is said. An exporter that posted an empty
      // envelope on every tick would turn a dead collector into a steady stream
      // of failed requests, which is a different way of letting a vendor's
      // availability become visible in the plane.
      if (serialized.spanCount === 0) {
        return { ok: false, reason: "NOTHING_TO_EXPORT", at: AT_BATCH, receipt };
      }
      // Refused before the send, deliberately: a body over the ceiling is a
      // decision this edge makes, not a verdict it asks a collector for.
      if (serialized.bytes > OTLP_BODY_MAX_BYTES) {
        return { ok: false, reason: "PAYLOAD_TOO_LARGE", at: AT_BATCH, receipt };
      }

      const posted = await postOtlpBody(endpoint, serialized.body);
      if (!posted.ok) {
        return { ok: false, reason: posted.reason, at: posted.at, receipt };
      }
      return { ok: true, receipt };
    },
  };
}
