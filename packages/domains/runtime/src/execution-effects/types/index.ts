/**
 * The recorded walk's hooks into the execution effect port (P-15 escalón D3,
 * ADR 0105; decision 140).
 *
 * `createExecutionEffects` asks a side effect whether it happened and, if not,
 * makes it happen. Under a revision the walk also records the chain the effect
 * belongs to — the effect and its delivery before the start, the delivery's move
 * after it, the prompt, the usage stream, the result and the response — and each
 * of those is a sink injected in the `recordUsage` mould: a function, so this
 * module still imports no ledger. The declarations the hooks add live here, in
 * the concept's own leaf (owner law `docs/audit/architecture/index.md` §7).
 *
 * A pure type leaf: it declares data and nothing else, and imports only types.
 */

import type { UsageSample } from "../index.js";

/**
 * Record the effect and its delivery before the start, or refuse.
 *
 * Called once per `apply`, before `port.start`. A throw stops the effect before
 * any process exists: nothing was sent, so nothing is spent.
 */
export type IntentionSink = (operationIndex: number) => void;

/**
 * What became of one delivery, as the effect port saw it.
 *
 * - `ACCEPTED`: the port started a session under `sessionId`; the delivery moves to
 *   `INFLIGHT` and the prompt occurrence is recorded, before a single event is read.
 * - `REFUSED`: the port refused the start; nothing was sent, no prompt is recorded.
 * - `FAILED`: the session ended in `error`, or without a terminal; the delivery
 *   settles with the effect `FAILED` and no result.
 */
export type DeliverySample =
  | { readonly operationIndex: number; readonly kind: "ACCEPTED"; readonly sessionId: string }
  | { readonly operationIndex: number; readonly kind: "REFUSED" }
  | { readonly operationIndex: number; readonly kind: "FAILED" };

/** Where a delivery's moves go. Synchronous, for the usage sink's reason. */
export type DeliverySink = (sample: DeliverySample) => void;

/**
 * Every usage report of one execution's trail, in trail order.
 *
 * The stream is declared once and each report recorded against it, so the sink
 * receives the reports together rather than one call per report: a declaration
 * made per report would be a declaration made before the first of them only by
 * luck of the loop.
 */
export interface StreamSample {
  readonly operationIndex: number;
  readonly reports: readonly UsageSample[];
}

/** Where a trail's usage stream goes. Synchronous, for the usage sink's reason. */
export type StreamSink = (sample: StreamSample) => void;

/**
 * Assert, before the marker, that the chain landed (P-15 escalón D3, "never
 * emits" refused at runtime).
 *
 * A marker makes the step un-re-runnable, so a marker written over an effect whose
 * outcome or response occurrence is missing would leave that gap permanent. The
 * confirmation throws instead, and no marker is written.
 */
export type ChainConfirmation = (operationIndex: number) => void;
