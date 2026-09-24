/**
 * The value types of the shared SSE transport (P-15 escalón E, ADR 0108).
 *
 * A pure type leaf (owner law §7): the one event shape the byte reader yields, and
 * the context an adapter error names. Nothing here carries a credential or a
 * provider's text beyond the event's own fields, which the leaves bound before
 * any of it becomes a chunk.
 */

/** One server-sent event, as the stream's framing delimited it. */
export interface SseEvent {
  /** The `event:` field, or null when the event named none. */
  readonly event: string | null;
  /** Every `data:` line of the event, joined by a line feed. */
  readonly data: string;
}

/** What an adapter error names: the provider and the task, never data. */
export interface SseContext {
  readonly provider: string;
  readonly taskId: string;
}
