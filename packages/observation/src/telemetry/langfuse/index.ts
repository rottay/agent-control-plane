import { TELEMETRY_ATTRIBUTE_KEYS } from "../index.js";
import type { TelemetryAttribute, TelemetryBatch, TelemetryEvent } from "../index.js";

/**
 * The optional Langfuse boundary.
 *
 * Law 9 permits Langfuse as **the first optional exporter** and forbids any
 * observability vendor from becoming required for routing, recovery or
 * evidence. This module is that permission taken at exactly its width: one
 * pure translator that turns neutral telemetry into the shape Langfuse
 * ingests, **as a value**. It exports nothing, sends nothing and opens
 * nothing.
 *
 * **No SDK is imported, and that is the removal proof.** There is no Langfuse
 * dependency in the graph, so "disable the exporter" is not a configuration
 * flag that could be wrong: it is the absence of a call. Removing Langfuse
 * means deleting this file, and what remains is the neutral surface that never
 * knew about it — the import direction only ever ran this way.
 *
 * **It cannot be handed an ungated event.** `TelemetryEvent` is branded and
 * `emitTelemetry` is its only producer, so a payload that failed the redaction
 * gate is not merely unlikely to reach a trace — it is unrepresentable at this
 * signature. That is C2's structural guarantee, and it is why this translator
 * needs no guard of its own: a second copy of the gate here would be a second
 * thing to keep in step, and the type already says it.
 */

/** One observation in a Langfuse trace. Values only; nothing here calls out. */
export interface LangfuseObservation {
  /** Langfuse's observation type. Every ACP lifecycle event is a span. */
  readonly type: "SPAN";
  readonly name: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly level: "DEFAULT" | "ERROR";
  readonly metadata: Readonly<Record<string, TelemetryAttribute>>;
}

/**
 * A Langfuse-shaped trace, as a value a caller may choose to send.
 *
 * `sessionId` carries the ACP task id, because a task is the unit a reader
 * follows across attempts, and Langfuse groups by session. `userId` is
 * deliberately absent: there is no user here, and inventing one would put an
 * identity into a vendor payload that the control plane never had.
 */
export interface LangfuseTrace {
  readonly name: string;
  readonly sessionId: string | null;
  readonly metadata: Readonly<Record<string, TelemetryAttribute>>;
  readonly observations: readonly LangfuseObservation[];
}

/** The trace name for a batch. Stable, and never derived from payload text. */
export const LANGFUSE_TRACE_NAME = "acp.task";

function observationOf(event: TelemetryEvent): LangfuseObservation {
  return Object.freeze({
    type: "SPAN" as const,
    name: event.name,
    startTime: event.startTime,
    endTime: event.endTime,
    // Langfuse's levels are not OTel's status codes; `ERROR` is the only one
    // that maps, and everything else stays `DEFAULT` rather than being
    // stretched onto a scale this translator cannot justify.
    level: event.status === "ERROR" ? ("ERROR" as const) : ("DEFAULT" as const),
    metadata: event.attributes,
  });
}

/**
 * Translate a gated batch into a Langfuse trace.
 *
 * Pure and total: it reads the batch and returns a value. The refusals are
 * carried into the trace's metadata as a **count**, never as diagnostics — a
 * reader of the vendor surface should be able to see that something was
 * withheld without the vendor surface being told what it was.
 */
export function toLangfuseTrace(batch: TelemetryBatch): LangfuseTrace {
  const first = batch.events[0];
  const sessionId = first === undefined ? null : first.attributes[TELEMETRY_ATTRIBUTE_KEYS.taskId];

  return Object.freeze({
    name: LANGFUSE_TRACE_NAME,
    sessionId: typeof sessionId === "string" ? sessionId : null,
    metadata: Object.freeze({
      "acp.telemetry.event_count": batch.events.length,
      "acp.telemetry.refused_count": batch.refusedCount,
    }),
    observations: Object.freeze(batch.events.map(observationOf)),
  });
}
