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
  // V2-B1c. The instruction a caller asked us to deliver carries
  // credential-shaped material, so it is refused before the write and before
  // the process exists. A genuinely new kind: content the plane will not
  // transmit, which no other member describes. Reusing `PROTOCOL_UNSUPPORTED`
  // would have collapsed it into the delivery refusal, and reusing any other
  // member would have named a different failure.
  | "CREDENTIAL_MATERIAL"
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
  | "CAPABILITY_UNPROVEN"
  // an HTTP transport's own failures (P-15 escalón E, ADR 0108): each a closed word
  // for one class of failure, so a vendor's text or Node's never becomes a detail
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNREACHABLE"
  | "REDIRECT_REFUSED"
  | "REQUEST_TIMEOUT";

/** Every code, for the closed-set assertions the fence and tests make. */
export const ADAPTER_ERROR_CODES: readonly AdapterErrorCode[] = Object.freeze([
  "BINARY_NOT_ADMITTED",
  "CAPABILITY_UNPROVEN",
  "CONFIG_ROOT_REFUSED",
  "CREDENTIAL_MATERIAL",
  "EXIT_UNEXPECTED",
  "HANDSHAKE_TIMEOUT",
  "ILLEGAL_TRANSITION",
  "INTERRUPT_ESCALATED",
  "MALFORMED_EVENT",
  "OUTPUT_BUDGET_EXCEEDED",
  "PROTOCOL_UNSUPPORTED",
  "PROVIDER_HTTP_ERROR",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNREACHABLE",
  "READ_ONLY_VIOLATION",
  "REDIRECT_REFUSED",
  "REQUEST_TIMEOUT",
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
