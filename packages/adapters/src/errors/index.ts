/**
 * The one error this package throws, and its closed code set.
 *
 * Every code names the *shape* of a refusal, never the data that caused it. An
 * adapter handles provider output, config roots and environment values, and a
 * message is the easiest place for any of those to leak. So the message is
 * built from the code, the provider and a task id, and from nothing else: the
 * constructor cannot be handed a free-form string to interpolate.
 */

export type AdapterErrorCode =
  // refused before anything was spawned
  | "CONFIG_ROOT_REFUSED"
  | "BINARY_NOT_ADMITTED"
  | "READ_ONLY_VIOLATION"
  // the process itself
  | "SPAWN_FAILED"
  | "EXIT_UNEXPECTED"
  | "INTERRUPT_ESCALATED"
  | "OUTPUT_BUDGET_EXCEEDED"
  // the protocol on top of it
  | "PROTOCOL_UNSUPPORTED"
  | "HANDSHAKE_TIMEOUT"
  | "UNKNOWN_EVENT"
  | "MALFORMED_EVENT"
  // our own state
  | "ILLEGAL_TRANSITION"
  | "CAPABILITY_UNPROVEN";

/** Every code, for the closed-set assertions the fence and tests make. */
export const ADAPTER_ERROR_CODES: readonly AdapterErrorCode[] = Object.freeze([
  "BINARY_NOT_ADMITTED",
  "CAPABILITY_UNPROVEN",
  "CONFIG_ROOT_REFUSED",
  "EXIT_UNEXPECTED",
  "HANDSHAKE_TIMEOUT",
  "ILLEGAL_TRANSITION",
  "INTERRUPT_ESCALATED",
  "MALFORMED_EVENT",
  "OUTPUT_BUDGET_EXCEEDED",
  "PROTOCOL_UNSUPPORTED",
  "READ_ONLY_VIOLATION",
  "SPAWN_FAILED",
  "UNKNOWN_EVENT",
]);

export interface AdapterErrorContext {
  readonly provider: string;
  readonly taskId: string;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly provider: string;
  readonly taskId: string;

  constructor(code: AdapterErrorCode, context: AdapterErrorContext) {
    super(code + " [" + context.provider + " " + context.taskId + "]");
    this.code = code;
    this.provider = context.provider;
    this.taskId = context.taskId;
    this.name = "AdapterError";
  }
}
